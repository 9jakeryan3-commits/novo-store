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
    '.ss-wrap{position:relative;width:100%;max-width:1200px;margin:0 auto;padding:0 22px 11px;}',
    'nav .ss-wrap{border-top:1px solid var(--bdr,#2e3036);padding-top:11px;}',
    '.ss-wrap input{display:block;width:100%;box-sizing:border-box;background:var(--navy2,#1c1d21);',
    'border:1px solid var(--bdr,#2e3036);border-radius:10px;padding:10px 14px;',
    'color:var(--txt1,#eaf3ff);font-size:14px;font-family:inherit;outline:none;',
    'transition:border-color .18s ease;}',
    '.ss-wrap input:focus{border-color:#22d3ee;}',
    '.ss-wrap input::placeholder{color:var(--txt3,#7d97b8);}',
    // The panel hangs from the input and matches its width, so results line up with the box.
    '.ss-panel{display:none;position:absolute;top:calc(100% + 4px);left:22px;right:22px;',
    'background:var(--navy2,#16171a);border:1px solid var(--bdr,#2e3036);border-radius:12px;',
    'box-shadow:0 24px 60px rgba(0,0,0,.55);padding:6px;z-index:400;max-height:min(70vh,460px);',
    'overflow-y:auto;text-align:left;}',
    '.ss-panel.show{display:block;}',
    '.ss-item{display:flex;flex-direction:column;gap:2px;padding:9px 11px;border-radius:8px;',
    'text-decoration:none;}',
    '.ss-item:hover,.ss-item:focus-visible{background:rgba(255,255,255,.05);}',
    '.ss-t{color:var(--txt1,#eaf3ff);font-size:13.5px;font-weight:600;line-height:1.35;}',
    '.ss-k{color:var(--txt3,#7d97b8);font-size:11px;font-weight:700;letter-spacing:.09em;',
    'text-transform:uppercase;}',
    '.ss-none{padding:12px;color:var(--txt3,#7d97b8);font-size:13px;}',
    // Narrower gutters on phones, where 22px each side is a real bite out of the field.
    // DESKTOP: the box rides in ROW 1 beside the brand, the Unusual Whales shape - logo,
    // search, then the account buttons, with the nav links spread across row 2. It is a flex
    // child of .nav-inner there (polish.css/blog.css order it), so it takes the middle and
    // stops growing at a readable width instead of spanning the whole bar.
    '@media(min-width:1025px){.ss-wrap{width:auto;flex:1 1 300px;max-width:600px;',
    'margin:0 24px;padding:0;}',
    'nav .ss-wrap{border-top:0;padding-top:0;}',
    '.ss-wrap input{padding:8px 13px;font-size:13.5px;}',
    '.ss-panel{left:0;right:0;top:calc(100% + 6px);}}',
    '@media(max-width:560px){.ss-wrap{padding:0 14px 10px;}',
    'nav .ss-wrap{padding-top:10px;}',
    '.ss-panel{left:14px;right:14px;}}'
  ].join('');
  document.head.appendChild(css);

  var wrap = document.createElement('div');
  wrap.className = 'ss-wrap';
  wrap.innerHTML =
    '<input id="site-search-input" type="search" autocomplete="off" spellcheck="false" ' +
    'aria-label="Search the site">' +
    '<div class="ss-panel" id="site-search-results" role="listbox"></div>';
  // INSIDE .nav-inner, not after it. As a sibling it could never join row 1 - a flex
  // parent can only order its own children - so the desktop layout Jake asked for (logo,
  // search, account on row 1; nav links spread across row 2) needs it in the flex context.
  // At <=1024 the stylesheet gives it order 5 and a 100% basis, so it still takes its own
  // full-width row on phones exactly as before.
  inner.appendChild(wrap);

  var input = wrap.querySelector('#site-search-input');

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
  function setPlaceholder() {
    var cs = getComputedStyle(input);
    var room = input.getBoundingClientRect().width
             - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
             - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
    if (!room || room <= 0) return;
    var ctx = setPlaceholder._c || (setPlaceholder._c = document.createElement('canvas').getContext('2d'));
    ctx.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    for (var i = 0; i < PLACEHOLDERS.length; i++) {
      // 6px of slack so a rounding difference cannot clip the last glyph
      if (ctx.measureText(PLACEHOLDERS[i]).width <= room - 6) { input.placeholder = PLACEHOLDERS[i]; return; }
    }
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
      .then(function (j) { data = j || []; loading = false; if (lastQ) run(lastQ); })
      .catch(function () {
        loading = false;
        panel.innerHTML = '<div class="ss-none">Search is unavailable right now.</div>';
        panel.classList.add('show');
      });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function run(q) {
    lastQ = q;
    q = (q || '').trim().toLowerCase();
    if (q.length < 2) { panel.classList.remove('show'); panel.innerHTML = ''; return; }
    if (!data) { load(); return; }

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

    if (!res.length) {
      panel.innerHTML = '<div class="ss-none">No matches for &ldquo;' + esc(q) + '&rdquo;.</div>';
      panel.classList.add('show');
      return;
    }
    panel.innerHTML = res.slice(0, 10).map(function (r) {
      return '<a class="ss-item" href="' + esc(r.a.u) + '">' +
             '<span class="ss-t">' + esc(r.a.t) + '</span>' +
             (r.a.k ? '<span class="ss-k">' + esc(r.a.k) + '</span>' : '') + '</a>';
    }).join('');
    panel.classList.add('show');
  }

  input.addEventListener('focus', load);
  input.addEventListener('input', function () { run(input.value); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { input.value = ''; run(''); input.blur(); }
    if (e.key === 'Enter') {
      var first = panel.querySelector('.ss-item');
      if (first) { location.href = first.getAttribute('href'); }
    }
  });
  document.addEventListener('click', function (e) {
    if (!wrap.contains(e.target)) panel.classList.remove('show');
  });
})();
