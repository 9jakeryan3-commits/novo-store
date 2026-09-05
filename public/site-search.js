/* Site-wide search, in the header, on every page.

   Before this, nine search boxes existed and every one searched the journal only, so 214 of
   1,500 published pages could not be found from anywhere on the site: all 92 coin pages, all
   73 desk notes, the tools, the learn guides, the compare pages and every product page. The
   archive was the sharpest case - it grows daily, so the gap widened on its own.

   ONE index, the same file the journal box reads. Two indexes is how they drift apart, and the
   archive proves it: it would fall out of whichever one nobody remembered to point at.

   THIS FILE MOUNTS ITS OWN UI. The header is copy-pasted furniture across 1,425 pages in two
   different markup families, so injecting a box, its styles and its behaviour into all of them
   would be three sweeps that can drift apart. One <script> tag per page is the whole footprint;
   everything else lives here.

   The index is fetched LAZILY - on first focus or first keystroke, never on page load. It is
   ~390KB, and charging every visitor to every page for a box most will not open is a real cost
   for an occasional feature. */
/* THE KEYBOARD LAYER LOADS FIRST, and the order is deliberate.

   One script tag per page is the whole budget, and this file already spends it, so the layer rides
   along here rather than in a second tag swept across 1,427 files. But it must not be HOSTAGE to
   the search widget: an uncaught error anywhere in the widget below aborts the rest of this script,
   and if the loader sat at the bottom a cosmetic failure in a header box would silently remove
   every keyboard shortcut on the page. Loading first makes those two failures independent. */
(function () {
  if (window.NovoKeys || document.getElementById('nvk-src')) return;
  var s = document.createElement('script');
  s.id = 'nvk-src';
  // ?v= is rewritten to a content hash by scripts/stamp-assets.js on every deploy. Without it this
  // file is served `immutable` for a year and no future fix would ever reach a returning visitor.
  s.src = '/js/novo-keys.js?v=dad9ecaf';
  s.defer = true;
  document.head.appendChild(s);
})();

(function () {
  // ITS OWN ROW, UNDER THE LINKS. Inline in .nav-actions it competed with nine nav links for
  // one row and pushed them onto two lines. As a sibling AFTER .nav-inner it is a second header
  // row: full width, centred on the same 1200px measure as the bar above it, and it never has
  // to fight the nav's flex layout at any width. Bails on pages with no standard header (the
  // three live dashboards) rather than mounting into nothing.
  var inner = document.querySelector('.nav-inner');
  var nav = inner ? inner.parentNode : null;
  if (!nav || !inner || document.getElementById('site-search-input')) return;

  var css = document.createElement('style');
  css.textContent = [
    // A second header row: full width, centred on the same 1200px measure as the bar above,
    // separated by a hairline so it reads as part of the header rather than page content.
    '.nvs-ss-wrap{position:relative;width:100%;max-width:1200px;margin:0 auto;padding:0 22px 11px;}',
    'nav .nvs-ss-wrap{border-top:1px solid var(--bdr,#2e3036);padding-top:11px;}',
    '.nvs-ss-wrap input{display:block;width:100%;box-sizing:border-box;background:var(--navy2,#1c1d21);',
    'border:1px solid var(--bdr,#2e3036);border-radius:10px;padding:10px 14px;',
    'color:var(--txt1,#eaf3ff);font-size:14px;font-family:inherit;outline:none;',
    'transition:border-color .18s ease;}',
    '.nvs-ss-wrap input:focus{border-color:#22d3ee;}',
    '.nvs-ss-wrap input::placeholder{color:var(--txt3,#7d97b8);}',
    // The panel hangs from the input and matches its width, so results line up with the box.
    '.nvs-ss-panel{display:none;position:absolute;top:calc(100% + 4px);left:22px;right:22px;',
    'background:var(--navy2,#16171a);border:1px solid var(--bdr,#2e3036);border-radius:12px;',
    'box-shadow:0 24px 60px rgba(0,0,0,.55);padding:6px;z-index:400;max-height:min(70vh,460px);',
    'overflow-y:auto;text-align:left;}',
    '.nvs-ss-panel.show{display:block;}',
    '.nvs-ss-item{display:flex;flex-direction:column;gap:2px;padding:9px 11px;border-radius:8px;',
    'text-decoration:none;}',
    '.nvs-ss-item:hover,.nvs-ss-item:focus-visible{background:rgba(255,255,255,.05);}',
    '.nvs-ss-t{color:var(--txt1,#eaf3ff);font-size:13.5px;font-weight:600;line-height:1.35;}',
    '.nvs-ss-k{color:var(--txt3,#7d97b8);font-size:11px;font-weight:700;letter-spacing:.09em;',
    'text-transform:uppercase;}',
    '.nvs-ss-none{padding:12px;color:var(--txt3,#7d97b8);font-size:13px;}',
    /* THE KEY BADGES. The whole feature was invisible without them: a palette you have to already
       know about is a palette nobody opens. Pinned inside the field on the right, vertically
       centred with translateY rather than a fixed top — the two header markup families ship input
       heights that differ by 2px, and a fixed top sits a pixel off on one of them.
       Hidden on coarse pointers because the palette itself is (js/novo-keys.js), and a badge that
       advertises a key you have no keyboard for is worse than no badge. */
    '.nvs-ss-keys{position:absolute;right:10px;top:50%;transform:translateY(-50%);',
    'display:flex;align-items:center;gap:7px;pointer-events:none;user-select:none;}',
    '.nvs-ss-keys i{display:flex;align-items:center;gap:4px;font-style:normal;}',
    '.nvs-ss-keys kbd{background:rgba(255,255,255,.06);border:1px solid var(--bdr,#2e3036);',
    'border-radius:4px;padding:1px 5px;color:var(--txt2,#b3c2d6);',
    'font:600 10.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;}',
    '.nvs-ss-keys em{font-style:normal;color:var(--txt3,#7d97b8);font-size:10.5px;}',
    '.nvs-ss-keys.caps em{display:none;}',
    '@media(pointer:coarse){.nvs-ss-keys{display:none;}}',
    // Narrower gutters on phones, where 22px each side is a real bite out of the field.
    // DESKTOP: the box rides in ROW 1 beside the brand, the Unusual Whales shape - logo,
    // search, then the account buttons, with the nav links spread across row 2. It is a flex
    // child of .nav-inner there (polish.css/blog.css order it), so it takes the middle and
    // stops growing at a readable width instead of spanning the whole bar.
    '@media(min-width:1025px){.nvs-ss-wrap{width:auto;flex:1 1 300px;max-width:600px;',
    'margin:0 24px;padding:0;}',
    'nav .nvs-ss-wrap{border-top:0;padding-top:0;}',
    '.nvs-ss-wrap input{padding:8px 13px;font-size:13.5px;}',
    '.nvs-ss-panel{left:0;right:0;top:calc(100% + 6px);}}',
    '@media(max-width:560px){.nvs-ss-wrap{padding:0 14px 10px;}',
    'nav .nvs-ss-wrap{padding-top:10px;}',
    '.nvs-ss-panel{left:14px;right:14px;}}'
  ].join('');
  document.head.appendChild(css);

  var wrap = document.createElement('div');
  wrap.className = 'nvs-ss-wrap';
  wrap.innerHTML =
    '<input id="site-search-input" type="search" autocomplete="off" spellcheck="false" ' +
    'role="combobox" aria-expanded="false" aria-controls="site-search-results" ' +
    'aria-autocomplete="list" aria-label="Search the site">' +
    '<div class="nvs-ss-keys" aria-hidden="true">' +
    '<i><kbd>' + (/Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '')
                  ? '⌘K' : 'Ctrl K') + '</kbd><em>search</em></i>' +
    '<i><kbd>/</kbd><em>cmds</em></i></div>' +
    '<div class="nvs-ss-panel" id="site-search-results" role="listbox" ' +
    'aria-label="Search results"></div>';
  // INSIDE .nav-inner, not after it. As a sibling it could never join row 1 - a flex
  // parent can only order its own children - so the desktop layout Jake asked for (logo,
  // search, account on row 1; nav links spread across row 2) needs it in the flex context.
  // At <=1024 the stylesheet gives it order 5 and a 100% basis, so it still takes its own
  // full-width row on phones exactly as before.
  inner.appendChild(wrap);

  var input = wrap.querySelector('#site-search-input');
  var keys = wrap.querySelector('.nvs-ss-keys');

  // The placeholder has to FIT, or it truncates mid-word - the long one cut off at
  // "the read archiv" on a phone. MEASURED, not guessed from breakpoints: breakpoints were
  // picking the shortest string on a 412px phone while 354px of room sat unused, and any
  // fixed number is wrong the moment the font or the copy changes. Try longest first, take
  // the first that actually fits the box it is sitting in.
  var PLACEHOLDERS = [
    'Search NoVo — guides, coins, tools, the read archive…',
    'Search NoVo — guides, coins, tools…',
    'Search NoVo — guides, coins…',
    'Search NoVo…'
  ];
  /* THE BADGES STEAL THE PLACEHOLDER'S ROOM, so the two are chosen TOGETHER — longest label with
     the longest placeholder that still fits, then the short badge form, rather than picking a
     placeholder against a width the badges have already taken.

     MEASURED, never constant. The same badge string renders 13% wider on the marketing pages than
     on the journal pages (different body font stacks) and ~18px wider again on a Mac, so a constant
     tuned on one page over-reserves on every other. And it must run AFTER the badges are in the
     DOM or their width reads 0.

     Full-label badges do not fit everywhere: between 1025 and ~1078px the box's clamp has bottomed
     out at 260px, and on phones under ~374px, so those widths get the caps-only form instead of a
     placeholder that runs underneath the keys. */
  function setPlaceholder() {
    var cs = getComputedStyle(input);
    var pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
            + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    var full = input.getBoundingClientRect().width - pad;
    if (!full || full <= 0) return;
    var ctx = setPlaceholder._c || (setPlaceholder._c = document.createElement('canvas').getContext('2d'));
    ctx.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;

    function roomWith(caps) {
      // Null-safe on purpose: a missing badge node must degrade to "no badges, full width", never
      // throw. An uncaught error here aborts the whole script, and the keyboard layer's loader
      // lives further down this same file — so a cosmetic failure could take the palette with it.
      if (!keys) return full;
      keys.classList.toggle('caps', caps);
      var kw = keys.getBoundingClientRect().width;
      if (!kw) return full;                     // badges hidden (touch): the whole field is free
      // right inset (10px) + a 12px gap so text never crowds the keys
      return full - kw - 22 + parseFloat(cs.paddingRight);
    }

    var forms = [false, true];                  // labelled first, caps-only as the fallback
    for (var f = 0; f < forms.length; f++) {
      var room = roomWith(forms[f]);
      for (var i = 0; i < PLACEHOLDERS.length; i++) {
        // 6px of slack so a rounding difference cannot clip the last glyph
        if (ctx.measureText(PLACEHOLDERS[i]).width <= room - 6) {
          input.placeholder = PLACEHOLDERS[i];
          return;
        }
      }
    }
    // Nothing fits even caps-only: keep the short badges and the shortest string.
    input.placeholder = PLACEHOLDERS[PLACEHOLDERS.length - 1];
  }
  setPlaceholder();
  window.addEventListener('resize', setPlaceholder);
  var panel = wrap.querySelector('#site-search-results');
  var data = null, loading = false, lastQ = '';

  function load() {
    if (data || loading) return;
    loading = true;
    fetch('/journal/search-index.json?v=11')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        data = j || [];
        loading = false;
        if (lastQ) run(lastQ);
        /* THE PALETTE NEEDS TELLING. It calls query() directly, which never sets lastQ, so the
           repaint above cannot reach it — without this event a palette opened before the index
           landed would show zero page hits and never recover, because the only other load trigger
           was this box's own focus event and the box no longer takes focus. */
        try { document.dispatchEvent(new CustomEvent('novo-search-ready')); } catch (_e) {}
      })
      .catch(function () {
        loading = false;
        panel.innerHTML = '<div class="nvs-ss-none">Search is unavailable right now.</div>';
        panel.classList.add('show');
      });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* THE RANKING, SPLIT OUT AND EXPORTED. The command palette (js/novo-keys.js) shows page hits
     beside its commands, and it calls this rather than fetching and scoring the index a second
     time. One index was the whole point of this file; one RANKING is the same argument one layer
     down — two scorers drift into disagreeing about what the best match is, and the reader gets a
     different answer depending on which box they typed into. Returns index entries, most relevant
     first, or [] when there is nothing loaded yet (and starts the load). */
  function query(q) {
    q = (q || '').trim().toLowerCase();
    if (q.length < 2) return [];
    if (!data) { load(); return []; }

    q = q.replace(/[^a-z0-9]+/g, ' ').trim();
    var toks = q.split(/\s+/).filter(Boolean), res = [];
    for (var i = 0; i < data.length; i++) {
      // The URL joins the haystack, and punctuation is flattened before matching.
      // Without the URL, "plans" cannot find /plans - that page's title and description
      // both say "Pricing" and never once say "plans". Without the flattening, "max pain"
      // scores below four journal articles because the calculator is titled "Max-Pain" and
      // a hyphen defeats the phrase bonus.
      var a = data[i], ok = true;
      if (a._h === undefined) {
        a._h = (a.t + ' ' + (a.k || '') + ' ' + a.d + ' ' + a.u)
                 .toLowerCase().replace(/[^a-z0-9]+/g, ' ');
        a._t = a.t.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
      }
      var hay = a._h;
      for (var j = 0; j < toks.length; j++) { if (hay.indexOf(toks[j]) < 0) { ok = false; break; } }
      if (!ok) continue;
      var score = 0, tl = a._t;
      for (var k = 0; k < toks.length; k++) {
        if (tl.indexOf(toks[k]) > -1) score += 3;
        if ((a.k || '').toLowerCase().indexOf(toks[k]) > -1) score += 1;
      }
      if (tl.indexOf(q) > -1) score += 5;
      res.push({ a: a, s: score });
    }
    res.sort(function (x, y) { return y.s - x.s || x.a.t.length - y.a.t.length; });
    return res.map(function (r) { return r.a; });
  }

  // Which result the keyboard is on. -1 means "none yet", so a bare Enter still takes the top hit
  // the way it always has.
  var sel = -1;

  function run(qRaw) {
    lastQ = qRaw;
    var q = (qRaw || '').trim().toLowerCase();
    if (q.length < 2) { panel.classList.remove('show'); panel.innerHTML = ''; mark(); return; }
    if (!data) { load(); return; }

    var res = query(qRaw);
    sel = -1;
    if (!res.length) {
      panel.innerHTML = '<div class="nvs-ss-none">No matches for &ldquo;' + esc(q) + '&rdquo;.</div>';
      panel.classList.add('show');
      mark();
      return;
    }
    panel.innerHTML = res.slice(0, 10).map(function (a, i) {
      // role="option" is not decoration. The panel has declared role="listbox" since it shipped
      // while its children were plain links with no option role, no aria-activedescendant and no
      // arrow keys — a listbox in name only, which tells a screen-reader user to expect a
      // navigable list and then hands them nothing to navigate.
      return '<a class="nvs-ss-item" id="nvs-ss-o' + i + '" role="option" aria-selected="false" ' +
             'href="' + esc(a.u) + '">' +
             '<span class="nvs-ss-t">' + esc(a.t) + '</span>' +
             (a.k ? '<span class="nvs-ss-k">' + esc(a.k) + '</span>' : '') + '</a>';
    }).join('');
    panel.classList.add('show');
    mark();
  }

  function items() { return panel.querySelectorAll('.nvs-ss-item'); }

  function mark() {
    var its = items();
    for (var i = 0; i < its.length; i++) {
      its[i].setAttribute('aria-selected', i === sel ? 'true' : 'false');
      its[i].style.background = i === sel ? 'rgba(255,255,255,.07)' : '';
    }
    if (sel > -1 && its[sel]) {
      input.setAttribute('aria-activedescendant', its[sel].id);
      if (its[sel].scrollIntoView) its[sel].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
    input.setAttribute('aria-expanded', panel.classList.contains('show') ? 'true' : 'false');
  }

  function move(d) {
    var n = items().length;
    if (!n) return;
    sel += d;
    if (sel < 0) sel = n - 1;
    if (sel > n - 1) sel = 0;
    mark();
  }

  input.addEventListener('focus', load);
  input.addEventListener('input', function () { run(input.value); });

  /* THE BOX IS THE DOOR TO THE PALETTE — this is the Unusual Whales shape Jake asked for, where the
     visible field is what teaches the shortcut and clicking it opens the real surface.

     ON CLICK, NOT ON FOCUS, and that is not a style choice. The palette restores focus to whatever
     opened it when it closes; bound to focus, Escape would hand focus back to this box, which would
     re-open the palette, forever. Click has no such loop.

     TOUCH KEEPS THE INLINE PANEL. The palette is display:none on coarse pointers, so routing this
     box through it there would delete site search from every phone. The guard is explicit rather
     than implied by the CSS, because a silently-swallowed tap is indistinguishable from a dead box. */
  function coarse() {
    try { return !!(window.matchMedia && window.matchMedia('(pointer:coarse)').matches); }
    catch (_e) { return false; }
  }
  input.addEventListener('mousedown', function (e) {
    if (coarse() || !window.NovoKeys) return;
    e.preventDefault();               // don't take focus; the palette wants it
    load();                           // start the index fetch this click would have triggered
    window.NovoKeys.open('search', true);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { input.value = ''; run(''); input.blur(); return; }
    if (e.key === 'ArrowDown') { move(1); e.preventDefault(); return; }
    if (e.key === 'ArrowUp') { move(-1); e.preventDefault(); return; }
    if (e.key === 'Enter') {
      var its = items();
      var pick = its[sel > -1 ? sel : 0];
      if (pick) { e.preventDefault(); location.href = pick.getAttribute('href'); }
    }
  });
  document.addEventListener('click', function (e) {
    if (!wrap.contains(e.target)) { panel.classList.remove('show'); mark(); }
  });

  // The command palette ranks page hits through this, and "/" focuses this box from anywhere.
  window.NovoSiteSearch = {
    load: load,
    query: query,
    focus: function () { input.focus(); input.select(); }
  };
})();

/* The keyboard-layer loader used to sit HERE, at the bottom. It moved to the top of this file after
   a sabotage run proved the hazard: a thrown error anywhere in the search widget above aborts the
   rest of the script, so a cosmetic failure in the header box silently removed every keyboard
   shortcut on the page. Same one-tag budget, independent failure modes. */

/* Prose-cap centering. The shared sheets cap running text (~78ch) inside the 1560 shell;
   a capped box whose TEXT is centered must center its BOX too. The alignment arrives by
   inline style, by class, or by inheritance - only computed style sees all three, so this
   cannot live in the stylesheets. Left-aligned text is untouched. */
(function () {
  function nvsCenterCapped() {
    var els = document.querySelectorAll(
      '.container p, .wrap p, .container li, .wrap li, .container .section-sub, .wrap .section-sub');
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (e.closest('.nvs-ss-wrap')) continue;
      var cs = getComputedStyle(e);
      if (cs.textAlign !== 'center') continue;
      var mw = parseFloat(cs.maxWidth);
      if (!mw || !e.parentElement) continue;
      if (mw < e.parentElement.getBoundingClientRect().width - 12) {
        e.style.marginLeft = 'auto'; e.style.marginRight = 'auto';
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', nvsCenterCapped);
  else nvsCenterCapped();
})();
