/* Site-wide ticker live-quote refresher. Fetches /api/quotes and updates every .tick in place
   (all marquee copies). Progressive enhancement: on any failure the static values remain. */
(function () {
  function paint(d) {
    document.querySelectorAll('.tick').forEach(function (t) {
      var nEl = t.querySelector('.t-name');
      if (!nEl) return;
      var q = d[nEl.textContent.trim()];
      if (!q) return;
      var v = t.querySelector('.t-val');
      if (v) v.textContent = q.price;
      var c = t.querySelector('.t-chg');
      if (c) {
        var up = q.chg >= 0;
        c.textContent = (up ? '+' : '') + Number(q.chg).toFixed(2) + '%';
        c.className = 't-chg ' + (up ? 'up' : 'dn');
        var pl = t.querySelector('svg polyline');
        if (pl) pl.setAttribute('stroke', up ? '#10b981' : '#f43f5e');
      }
    });
  }
  function load() {
    fetch('/api/quotes').then(function (r) { return r.json(); }).then(paint).catch(function () {});
  }
  load();
  // Poll only while the tab is actually being looked at — this runs on 1,040 static article
  // pages, and a background tab was billing an invocation a minute for a ticker nobody sees.
  setInterval(function () {
    if (document.visibilityState === 'visible') load();
  }, 60000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') load();
  });
})();
