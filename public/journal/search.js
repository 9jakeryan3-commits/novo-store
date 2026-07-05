/* NoVo Journal — client-side knowledge-base search. Reads search-index.json. */
(function () {
  var input = document.getElementById('kb-input');
  var out = document.getElementById('kb-results');
  var meta = document.getElementById('kb-meta');
  var clear = document.getElementById('kb-clear');
  if (!input || !out) return;

  var data = [], ready = false;

  fetch('/journal/search-index.json?v=3')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      data = j; ready = true;
      if (meta) meta.textContent = 'Search 100s of guides — options, dealer flow, market structure, risk & discipline.';
      var q = (new URLSearchParams(location.search)).get('q');
      if (q) { input.value = q; run(q); input.focus(); }
    })
    .catch(function () { if (meta) meta.textContent = 'Search is unavailable right now — browse the full archive below.'; });

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function hl(text, toks) {
    var e = esc(text);
    toks.forEach(function (t) {
      if (t.length < 2) return;
      e = e.replace(new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>');
    });
    return e;
  }
  function run(q) {
    q = (q || '').trim().toLowerCase();
    if (clear) clear.hidden = !q;
    if (!ready || q.length < 2) { out.innerHTML = ''; out.classList.remove('show'); return; }
    var toks = q.split(/\s+/).filter(Boolean);
    var res = [];
    data.forEach(function (a) {
      var hay = (a.t + ' ' + a.k + ' ' + a.d).toLowerCase();
      if (!toks.every(function (t) { return hay.indexOf(t) > -1; })) return;
      var score = 0, tl = a.t.toLowerCase();
      toks.forEach(function (t) {
        if (tl.indexOf(t) > -1) score += 3;
        if (a.k.toLowerCase().indexOf(t) > -1) score += 1;
      });
      if (tl.indexOf(q) > -1) score += 5;
      res.push({ a: a, score: score });
    });
    res.sort(function (x, y) { return y.score - x.score || x.a.t.length - y.a.t.length; });
    if (!res.length) {
      out.innerHTML = '<div class="kb-none">No matches for &ldquo;' + esc(q) + '&rdquo;. Try <em>gamma</em>, <em>stop loss</em>, <em>IV crush</em>, <em>VWAP</em>, or <em>position sizing</em>.</div>';
      out.classList.add('show'); return;
    }
    out.innerHTML = res.slice(0, 16).map(function (r) {
      var a = r.a;
      return '<a class="kb-item" href="/journal/' + a.s + '.html">' +
        '<div class="kb-t">' + hl(a.t, toks) + (a.k ? ' <span class="kb-k">' + esc(a.k) + '</span>' : '') + '</div>' +
        '<div class="kb-d">' + hl(a.d, toks) + '</div></a>';
    }).join('');
    out.classList.add('show');
  }

  input.addEventListener('input', function () { run(input.value); });
  input.addEventListener('focus', function () { if (input.value.trim().length >= 2) run(input.value); });
  if (clear) clear.addEventListener('click', function () { input.value = ''; run(''); input.focus(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && document.activeElement === input) { input.value = ''; run(''); } });
})();
