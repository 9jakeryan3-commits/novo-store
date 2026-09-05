/* NoVo keyboard layer — the command palette, the go-to chords, and the shortcut sheet.

   WHY ONE FILE. Before this, keyboard handling lived in three unconnected islands: two byte-identical
   ten-line blocks on analyst-live and crypto-live (Cmd-K opens the chat), a full twenty-binding chart
   layer on trader-live, and nothing at all on the other 1,427 pages. Islands drift. This file owns the
   keys that mean the same thing everywhere, and each page registers only the commands that are its own.

   WHAT IT DELIBERATELY DOES NOT OWN. trader-live's chart keys (1-6, arrows, +/-, L, Alt+H, Del,
   Ctrl+Z) and its own `?` sheet stay where they are and keep working — they are correct, they are
   already in muscle memory, and they can reach chart internals this file cannot. See TRADER_SHEET.

   CAPTURE PHASE, ON PURPOSE. Every listener below is capture-phase and stops propagation ONLY on a key
   it actually consumed. That is what makes Cmd-K reassignable and Escape safe: trader-live's Escape is
   an unconditional "cancel everything" that would destroy a half-drawn trendline behind an open
   palette, and crypto-live fires three separate unguarded Escape handlers on one press. Consuming the
   key before the bubble phase is the only way to dismiss a palette without setting all of that off.

   NOTHING MONEY-TOUCHING GETS A KEYSTROKE. Checkout, plan switching and the terms gate are reachable
   from the palette by name, never from a chord. A mistyped letter must not be able to start a purchase. */
(function () {
  'use strict';
  if (window.NovoKeys) return;

  var MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
  var MOD = MAC ? '⌘' : 'Ctrl';

  /* trader-live keeps its own `?` sheet — it is built inside #novo-chart so it survives the chart's
     fullscreen, and it lists chart keys this file has no business duplicating. Detect it and stand
     down rather than putting two help panels on one keypress. */
  function traderSheet() { return typeof window._kbHelpToggle === 'function'; }

  /* The typing guard, copied from trader-live.html:5272 rather than reinvented — it is the strongest
     of the two in the codebase because .closest() catches an ancestor and it covers <select>. Note it
     matches [contenteditable="true"] literally, so a bare `contenteditable` attribute (which
     serializes to "") slips through; every field this layer touches is a real <input>. */
  function typing(el) {
    return !!(el && el.closest && el.closest('input,textarea,select,[contenteditable="true"]'));
  }

  var CMDS = [];      // registered commands, in registration order
  var HELP = [];      // extra shortcut rows contributed by the page
  var seq = 0;

  /* A page may register a plain list, or a FUNCTION returning one. The function form is for command
     sets that only exist once data has arrived — the crypto map's ninety coins are rail rows that do
     not exist at boot and change as the rail is filtered, so a list captured once would go stale and
     offer coins that are no longer there. Functions are re-run on every keystroke. */
  function register(list) {
    if (!list) return;
    if (typeof list === 'function') { list._i = seq; seq += 100; CMDS.push(list); return; }
    if (!list.length) list = [list];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || !c.label) continue;
      if (!c.run && !c.href) continue;
      c._i = seq++;
      CMDS.push(c);
    }
  }

  function addHelp(rows) { if (rows && rows.length) HELP = HELP.concat(rows); }

  /* ── Navigation, harvested from the page's own nav ─────────────────────────────────────────────
     The store's header carries ten primary links and a "More" mega-menu of about forty. Hard-coding
     them here would mean this file drifts the first time a link is added — the same failure the
     single search index was built to stop. Read them off the DOM instead: a new nav link becomes a
     palette command with no edit here and no sweep across 1,427 pages. */
  function navCommands() {
    var out = [], seen = {}, links = document.querySelectorAll('nav a[href]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i], href = a.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#' || /^(mailto|tel|javascript):/i.test(href)) continue;
      if (/^https?:/i.test(href) && a.host !== location.host) continue;
      var label = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!label || label.length > 48) continue;
      var key = href.replace(/\/$/, '').toLowerCase();
      if (seen[key]) continue;
      seen[key] = 1;
      out.push({ label: label, group: 'Go to', href: href, _i: 10000 + i });
    }
    return out;
  }

  /* ── The go-to chords: `g` then the destination's first letter ─────────────────────────────────
     Seven, and every one is the initial of the word on screen, so the map is a rule rather than a
     list to memorize. Anything further down the site is reachable from the palette by name — a chord
     for every page would be a second navigation system to keep in sync. */
  var GOTO = [
    ['h', '/', 'Home'],
    ['a', '/analyst', 'Analyst'],
    ['t', '/trader', 'Trader'],
    ['c', '/crypto', 'Crypto'],
    ['m', '/market-data', 'Market data'],
    ['j', '/journal/', 'Journal'],
    ['p', '/plans', 'Plans']
  ];

  // ── Palette ───────────────────────────────────────────────────────────────────────────────────
  var el = null, input = null, list = null, chip = null, sheet = null;
  var rows = [], sel = 0, lastFocus = null, chord = null, chordT = 0;

  function css() {
    var s = document.createElement('style');
    s.id = 'nvk-css';
    var A = window.NOVO_KEYS_ACCENT || '#22d3ee';
    s.textContent = [
      '#nvk,#nvk-sheet{position:fixed;inset:0;z-index:2147483100;display:none;',
      'font-family:inherit;-webkit-font-smoothing:antialiased}',
      '#nvk.on,#nvk-sheet.on{display:block}',
      '#nvk .scrim,#nvk-sheet .scrim{position:absolute;inset:0;background:rgba(4,7,12,.62)}',
      '@supports (backdrop-filter:blur(2px)){#nvk .scrim,#nvk-sheet .scrim{backdrop-filter:blur(3px)}}',
      '#nvk .box{position:relative;margin:12vh auto 0;width:min(640px,calc(100vw - 28px));',
      'background:#16171a;border:1px solid #2e3036;border-radius:14px;',
      'box-shadow:0 30px 90px rgba(0,0,0,.66);overflow:hidden}',
      '#nvk-q{display:block;width:100%;box-sizing:border-box;background:transparent;border:0;',
      'border-bottom:1px solid #2e3036;padding:16px 18px;color:#eaf3ff;font-size:16px;',
      'font-family:inherit;outline:none}',
      '#nvk-q::placeholder{color:#7d97b8}',
      '#nvk-list{list-style:none;margin:0;padding:6px;max-height:min(56vh,420px);overflow-y:auto}',
      '#nvk-list li{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:9px;',
      'cursor:pointer;color:#eaf3ff;font-size:14px;line-height:1.3}',
      '#nvk-list li .g{color:#7d97b8;font-size:10.5px;font-weight:700;letter-spacing:.09em;',
      'text-transform:uppercase;flex:0 0 auto;min-width:64px}',
      '#nvk-list li .l{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#nvk-list li .k{flex:0 0 auto;color:#7d97b8;font-size:11px}',
      '#nvk-list li[aria-selected="true"]{background:rgba(255,255,255,.07)}',
      '#nvk-list li[aria-selected="true"] .l{color:' + A + '}',
      '#nvk .none{padding:18px;color:#7d97b8;font-size:13.5px}',
      '#nvk .foot{border-top:1px solid #2e3036;padding:8px 14px;color:#7d97b8;font-size:11.5px;',
      'display:flex;gap:14px;flex-wrap:wrap}',
      // The chord hint. Pressing `g` alone does nothing visible otherwise, which reads as a dead key.
      '#nvk-chip{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483100;',
      'display:none;background:#16171a;border:1px solid #2e3036;border-radius:9px;padding:7px 13px;',
      'color:#eaf3ff;font-size:12.5px;box-shadow:0 12px 34px rgba(0,0,0,.5)}',
      '#nvk-chip.on{display:block}',
      '#nvk-sheet .box{position:relative;margin:10vh auto 0;width:min(560px,calc(100vw - 28px));',
      'background:#16171a;border:1px solid #2e3036;border-radius:14px;padding:18px 20px 14px;',
      'box-shadow:0 30px 90px rgba(0,0,0,.66);max-height:74vh;overflow-y:auto}',
      '#nvk-sheet h4{margin:0 0 4px;color:#eaf3ff;font-size:15px}',
      '#nvk-sheet .sub{color:#7d97b8;font-size:12px;margin:0 0 14px}',
      '#nvk-sheet .grp{color:#7d97b8;font-size:10.5px;font-weight:700;letter-spacing:.09em;',
      'text-transform:uppercase;margin:14px 0 6px}',
      '#nvk-sheet .r{display:flex;justify-content:space-between;gap:16px;padding:4px 0;',
      'color:#eaf3ff;font-size:13.5px}',
      '#nvk-sheet .r span:last-child{flex:0 0 auto;color:#7d97b8}',
      '#nvk kbd,#nvk-sheet kbd,#nvk-chip kbd{display:inline-block;background:#22242a;border:1px solid #33363d;',
      'border-radius:5px;padding:1px 6px;font:600 11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;',
      'color:#eaf3ff;min-width:9px;text-align:center}',
      '#nvk .close-hint{margin-left:auto}',
      '@media (prefers-reduced-motion:no-preference){#nvk.on .box,#nvk-sheet.on .box{',
      'animation:nvk-in .13s ease-out}}',
      '@keyframes nvk-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}',
      // Touch has no keyboard; the whole layer is dead weight on a phone.
      '@media (pointer:coarse){#nvk,#nvk-sheet,#nvk-chip{display:none !important}}'
    ].join('');
    document.head.appendChild(s);
  }

  function build() {
    css();
    el = document.createElement('div');
    el.id = 'nvk';
    el.innerHTML =
      '<div class="scrim" data-nvk-close="1"></div>' +
      '<div class="box" role="dialog" aria-modal="true" aria-label="Command palette">' +
      '<input id="nvk-q" type="text" autocomplete="off" autocorrect="off" spellcheck="false" ' +
      'role="combobox" aria-expanded="true" aria-controls="nvk-list" aria-autocomplete="list">' +
      '<ul id="nvk-list" role="listbox" aria-label="Commands"></ul>' +
      '<div class="foot"><span><kbd>&uarr;</kbd><kbd>&darr;</kbd> move</span>' +
      '<span><kbd>&crarr;</kbd> run</span>' +
      '<span class="close-hint"><kbd>Esc</kbd> close</span></div></div>';
    document.body.appendChild(el);
    input = el.querySelector('#nvk-q');
    list = el.querySelector('#nvk-list');

    chip = document.createElement('div');
    chip.id = 'nvk-chip';
    document.body.appendChild(chip);

    el.addEventListener('click', function (e) {
      if (e.target && e.target.getAttribute('data-nvk-close')) close();
    });
    input.addEventListener('input', function () { render(input.value); });
    list.addEventListener('click', function (e) {
      var li = e.target && e.target.closest ? e.target.closest('li[data-i]') : null;
      if (li) { sel = +li.getAttribute('data-i'); runSel(); }
    });
    list.addEventListener('mousemove', function (e) {
      var li = e.target && e.target.closest ? e.target.closest('li[data-i]') : null;
      if (li) { sel = +li.getAttribute('data-i'); paint(); }
    });
  }

  function score(hay, q) {
    hay = hay.toLowerCase();
    var i = hay.indexOf(q);
    if (i === 0) return 100;
    if (i > 0) return hay.charAt(i - 1) === ' ' ? 70 : 40;
    // subsequence, so "mkdt" still finds "Market data"
    var h = 0;
    for (var j = 0; j < q.length; j++) {
      h = hay.indexOf(q.charAt(j), h);
      if (h < 0) return 0;
      h++;
    }
    return 12;
  }

  // Built-ins are computed per open, not registered once, because whether NoVo is reachable depends
  // on which widget this page mounted.
  function builtins() {
    var b = [];
    if (canAsk()) {
      b.push({ label: 'Ask NoVo', group: 'NoVo', keys: '<kbd>n</kbd>', run: ask, _i: 8000 });
    }
    if (!traderSheet()) {
      b.push({ label: 'Keyboard shortcuts', group: 'Help', keys: '<kbd>?</kbd>',
               run: function () { helpToggle(true); }, _i: 8001 });
    }
    return b;
  }

  function candidates() {
    var out = [], i, j;
    for (i = 0; i < CMDS.length; i++) {
      var c = CMDS[i];
      if (typeof c === 'function') {
        var got = [];
        try { got = c() || []; } catch (_e) { got = []; }
        for (j = 0; j < got.length; j++) {
          if (got[j] && got[j].label) { got[j]._i = c._i + j / 1000; out.push(got[j]); }
        }
      } else out.push(c);
    }
    return out.concat(builtins()).concat(navCommands());
  }

  function render(q) {
    q = (q || '').trim().toLowerCase();
    var all = candidates(), out = [], i;

    if (!q) {
      for (i = 0; i < all.length; i++) out.push(all[i]);
      out.sort(function (a, b) { return a._i - b._i; });
      out = out.slice(0, 40);
    } else {
      for (i = 0; i < all.length; i++) {
        var s = score(all[i].label + ' ' + (all[i].group || ''), q);
        if (s) out.push({ c: all[i], s: s });
      }
      out.sort(function (a, b) { return b.s - a.s || a.c._i - b.c._i; });
      out = out.map(function (r) { return r.c; }).slice(0, 30);

      /* Site content, from the ONE index the header box already reads. This calls into
         site-search.js rather than fetching or scoring a second time — two indexes is exactly how
         214 pages became unfindable before, and that lesson is written on top of that file. On the
         live dashboards the export is absent (they carry no site chrome), so the palette is
         commands-only there and says so in its placeholder. */
      var ss = window.NovoSiteSearch;
      if (ss && q.length >= 2) {
        var hits = ss.query(q) || [];
        for (i = 0; i < hits.length && i < 8; i++) {
          out.push({ label: hits[i].t, group: hits[i].k || 'Page', href: hits[i].u, _i: 90000 + i });
        }
      }
    }

    rows = out;
    sel = 0;
    paint();
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function paint() {
    if (!rows.length) {
      list.innerHTML = '';
      var n = el.querySelector('.none');
      if (!n) { n = document.createElement('div'); n.className = 'none'; list.parentNode.insertBefore(n, list); }
      n.textContent = input.value.trim() ? 'Nothing matches “' + input.value.trim() + '”.' : 'No commands on this page.';
      input.removeAttribute('aria-activedescendant');
      return;
    }
    var old = el.querySelector('.none');
    if (old) old.parentNode.removeChild(old);
    if (sel < 0) sel = 0;
    if (sel > rows.length - 1) sel = rows.length - 1;
    var h = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      h += '<li id="nvk-o' + i + '" role="option" data-i="' + i + '"' +
        (i === sel ? ' aria-selected="true"' : ' aria-selected="false"') + '>' +
        '<span class="g">' + esc(r.group || '') + '</span>' +
        '<span class="l">' + esc(r.label) + '</span>' +
        (r.keys ? '<span class="k">' + r.keys + '</span>' : '') + '</li>';
    }
    list.innerHTML = h;
    input.setAttribute('aria-activedescendant', 'nvk-o' + sel);
    var li = list.children[sel];
    if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
  }

  function runSel() {
    var r = rows[sel];
    if (!r) return;
    close();
    if (r.href) { location.href = r.href; return; }
    try { r.run(); } catch (_e) {}
  }

  function open() {
    if (!el) build();
    if (el.classList.contains('on')) { input.select(); return; }
    lastFocus = document.activeElement;
    el.classList.add('on');
    /* The chart's FULL button fullscreens #card-spy, and only the fullscreen element's subtree
       paints — a position:fixed node on <body> would be invisible there. Re-home the palette into
       whatever is currently fullscreen. */
    var host = document.fullscreenElement || document.body;
    if (el.parentNode !== host) host.appendChild(el);
    input.value = '';
    input.placeholder = window.NovoSiteSearch ? 'Search or jump to…' : 'Type a command…';
    render('');
    input.focus();
  }

  function close() {
    if (!el || !el.classList.contains('on')) return false;
    el.classList.remove('on');
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (_e) {} }
    lastFocus = null;
    return true;
  }

  function isOpen() { return !!(el && el.classList.contains('on')); }

  // ── Shortcut sheet ────────────────────────────────────────────────────────────────────────────
  function sheetHtml() {
    var h = '<div class="scrim" data-nvk-close="1"></div><div class="box" role="dialog" ' +
            'aria-modal="true" aria-label="Keyboard shortcuts">' +
            '<h4>Keyboard</h4><p class="sub">Shortcuts on this page.</p>';
    var any = [['Command palette', '<kbd>' + MOD + '</kbd><kbd>K</kbd>']];
    if (window.NovoSiteSearch) any.push(['Search the site', '<kbd>/</kbd>']);
    else if (canAsk()) any.push(['Ask NoVo', '<kbd>n</kbd> or <kbd>/</kbd>']);
    if (window.NovoSiteSearch && canAsk()) any.push(['Ask NoVo', '<kbd>n</kbd>']);
    any.push(['This sheet', '<kbd>?</kbd>']);
    any.push(['Close / dismiss', '<kbd>Esc</kbd>']);
    var groups = [{ n: 'Anywhere', r: any }];
    var go = [];
    for (var i = 0; i < GOTO.length; i++) {
      go.push([GOTO[i][2], '<kbd>g</kbd> <kbd>' + GOTO[i][0] + '</kbd>']);
    }
    groups.push({ n: 'Go to', r: go });
    if (HELP.length) groups.push({ n: 'This page', r: HELP });

    for (var g = 0; g < groups.length; g++) {
      h += '<div class="grp">' + groups[g].n + '</div>';
      for (var j = 0; j < groups[g].r.length; j++) {
        h += '<div class="r"><span>' + groups[g].r[j][0] + '</span><span>' + groups[g].r[j][1] + '</span></div>';
      }
    }
    return h + '</div>';
  }

  function helpToggle(force) {
    if (!el) build();
    if (!sheet) {
      sheet = document.createElement('div');
      sheet.id = 'nvk-sheet';
      document.body.appendChild(sheet);
      sheet.addEventListener('click', function (e) {
        if (e.target && e.target.getAttribute('data-nvk-close')) helpToggle(false);
      });
    }
    var on = force === true ? true : (force === false ? false : !sheet.classList.contains('on'));
    if (on) {
      sheet.innerHTML = sheetHtml();
      var host = document.fullscreenElement || document.body;
      if (sheet.parentNode !== host) host.appendChild(sheet);
    }
    sheet.classList.toggle('on', on);
    return on;
  }

  function helpOpen() { return !!(sheet && sheet.classList.contains('on')); }

  // ── Chords ────────────────────────────────────────────────────────────────────────────────────
  function chordShow(msg) {
    if (!chip) return;
    chip.innerHTML = msg;
    chip.classList.add('on');
  }
  function chordClear() {
    chord = null;
    if (chip) chip.classList.remove('on');
  }

  function chordHint() {
    var h = 'Go to — ';
    for (var i = 0; i < GOTO.length; i++) {
      h += '<kbd>' + GOTO[i][0] + '</kbd> ' + GOTO[i][2] + (i < GOTO.length - 1 ? '  ' : '');
    }
    return h;
  }

  // ── The one listener ──────────────────────────────────────────────────────────────────────────
  function onKey(e) {
    var k = e.key;
    if (!k) return;

    // Palette-internal navigation. Runs first so nothing downstream sees these keys.
    if (isOpen()) {
      if (k === 'Escape') { close(); e.preventDefault(); e.stopPropagation(); return; }
      if (k === 'ArrowDown') { sel++; paint(); e.preventDefault(); e.stopPropagation(); return; }
      if (k === 'ArrowUp') { sel--; paint(); e.preventDefault(); e.stopPropagation(); return; }
      if (k === 'Enter') { runSel(); e.preventDefault(); e.stopPropagation(); return; }
      if (k === 'Tab') { e.preventDefault(); e.stopPropagation(); return; }   // nothing behind it to reach
      if ((e.metaKey || e.ctrlKey) && (k === 'k' || k === 'K')) {
        close(); e.preventDefault(); e.stopPropagation(); return;
      }
      return;   // every other key is the user typing a query
    }

    if (helpOpen()) {
      if (k === 'Escape' || k === '?') { helpToggle(false); e.preventDefault(); e.stopPropagation(); return; }
    }

    // Cmd/Ctrl-K works even mid-sentence — that is the point of a palette.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (k === 'k' || k === 'K')) {
      open(); e.preventDefault(); e.stopPropagation(); return;
    }

    if (e.metaKey || e.ctrlKey || e.altKey) { chordClear(); return; }
    if (typing(e.target)) { chordClear(); return; }

    // Second half of a `g` chord. Consumed in capture so it cannot also reach the chart's own
    // number/letter bindings underneath.
    if (chord === 'g') {
      var age = Date.now() - chordT;
      chordClear();
      if (age < 1400) {
        for (var i = 0; i < GOTO.length; i++) {
          if (k.toLowerCase() === GOTO[i][0]) {
            location.href = GOTO[i][1];
            e.preventDefault(); e.stopPropagation();
            return;
          }
        }
        if (k !== 'Escape') { e.preventDefault(); e.stopPropagation(); return; }  // a miss is not a chart key
      }
    }

    if (k === 'g') {
      chord = 'g'; chordT = Date.now(); chordShow(chordHint());
      e.preventDefault(); e.stopPropagation();
      return;
    }

    /* `?` — the sheet. trader-live already ships its own, built inside the chart element so it
       survives fullscreen and listing keys this file cannot reach; there, stand down. */
    if (k === '?' && !traderSheet()) {
      helpToggle(); e.preventDefault(); e.stopPropagation(); return;
    }

    /* `/` — put the caret in this page's primary text box. One rule, two answers: the header
       search box on the store, NoVo on a dashboard, where the search box does not exist. The two
       dashboards keep their own `/` handler underneath this one as a fallback, and it does the
       same thing, so the binding stays true if this file ever fails to load. */
    if (k === '/') {
      if (window.NovoSiteSearch) {
        window.NovoSiteSearch.focus(); e.preventDefault(); e.stopPropagation(); return;
      }
      if (ask()) { e.preventDefault(); e.stopPropagation(); return; }
      return;
    }

    // `n` — NoVo. This is the binding Cmd-K used to carry on the two dashboards.
    if (k === 'n' || k === 'N') {
      if (ask()) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
  }

  /* Opening NoVo means two different things depending on the page: the dashboards mount a full
     analyst panel and export novoAskOpen, while the store's 1,431 marketing and journal pages carry
     the smaller chat widget, which exports nothing at all — its button is the only handle it has. */
  function canAsk() {
    return typeof window.novoAskOpen === 'function' || !!document.querySelector('.nvc-btn');
  }

  function ask() {
    if (typeof window.novoAskOpen === 'function') {
      try { window.novoAskOpen(1); return true; } catch (_e) { return false; }
    }
    var b = document.querySelector('.nvc-btn');
    if (b && !b.classList.contains('nvc-open')) { b.click(); return true; }
    return false;
  }

  document.addEventListener('keydown', onKey, true);
  // A stray chord must not survive a click or a tab-away.
  document.addEventListener('mousedown', chordClear, true);
  window.addEventListener('blur', chordClear);

  window.NovoKeys = {
    register: register,
    addHelp: addHelp,
    open: open,
    close: close,
    help: helpToggle,
    mod: MOD,
    isMac: MAC
  };

  /* LOAD ORDER MUST NOT MATTER. This file is deferred, and the pages that register commands run
     their own inline scripts at unpredictable points around it. A page always pushes a callback
     onto NovoKeysQueue; whichever arrives second runs it. Replacing the array with a push-through
     object afterwards means a late registration still works without every caller re-checking. */
  var q = window.NovoKeysQueue;
  if (q && q.length) {
    for (var qi = 0; qi < q.length; qi++) { try { q[qi](window.NovoKeys); } catch (_e) {} }
  }
  window.NovoKeysQueue = {
    push: function (fn) { try { fn(window.NovoKeys); } catch (_e) {} }
  };
})();
