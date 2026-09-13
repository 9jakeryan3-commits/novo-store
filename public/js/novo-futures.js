/* novo-futures.js — the Futures page: what the 24/5 tape is doing, and the night's ES reads.
 *
 * Jake, 2026-09-07: "make a Futures page and tab where these lands each day showing all three in a
 * rolling panel oldest out kind of thing along with any other futures data you can add."
 *
 * TWO HALVES, TWO SOURCES, BOTH ALREADY PAID FOR:
 *   LIVE      /api/quotes — public, 60s CDN-cached, the same feed the analyst's ribbon uses.
 *             ES, NQ, RTY, YM plus the macro complex (gold, crude, dollar, 10Y, VIX).
 *   THE READS window._abFeed — the `feed[]` of GET /api/analysis-board, which the trader page
 *             ALREADY polls every 60 seconds and never read a field of. The three overnight ES
 *             sessions (Asian Globex 21:00, London 03:00, US Pre-Market 09:00 ET) come from the
 *             durable store, not the redis slot that overwrites them.
 *
 * WHY THIS PAGE EXISTS AT ALL. Those three reads write to ONE redis slot with SET, so the hourly
 * audit erased the overnight ES reads from the Analysis Feed a few hours after they landed, and a
 * container restart blanked the panel entirely. The reads were never lost - they are banked in
 * syndicate_memory.db - so this is a page for a backlog that already exists and was unreachable.
 *
 * ROLLING, OLDEST OUT: the engine's analysis_feed() already caps at 12 rows and 48 hours, so the
 * roll is upstream and this file does not re-implement it. Sessions are shown newest first and the
 * night is labelled, because three reads with no session name is just three paragraphs.
 *
 * ⚠ Hairlines only, no boxes. Styles injected, tagged data-novo-futures.
 */
(function () {
  var CSS = [
    '.novo-futures{padding:4px 2px}',
    '.novo-futures h2{margin:0 0 12px;font-family:var(--mono,ui-monospace),monospace;font-size:11px;'
      + 'font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--txt2,#a8a8a8)}',
    '.novo-futures .fx-sub{font-size:11px;font-weight:500;color:var(--txt3,#8f8f8f);'
      + 'letter-spacing:.06em;margin-left:8px;text-transform:none}',
    '.novo-futures .fx-grp{font-family:var(--mono,ui-monospace),monospace;font-size:10px;'
      + 'letter-spacing:.16em;text-transform:uppercase;color:var(--txt3,#8f8f8f);margin:18px 0 2px;'
      + 'padding-top:14px;border-top:1px solid var(--bdr2,#242428)}',
    /* the live tape: a two-column list, not a grid of tiles */
    '.novo-futures .fx-q{display:flex;align-items:baseline;justify-content:space-between;gap:12px;'
      + 'padding:10px 0;border-top:1px solid var(--bdr2,#242428)}',
    '.novo-futures .fx-grp + .fx-q{border-top:0}',
    '.novo-futures .fx-n{font-family:var(--mono,ui-monospace),monospace;font-size:10.5px;'
      + 'letter-spacing:.1em;text-transform:uppercase;color:var(--txt3,#8f8f8f)}',
    '.novo-futures .fx-v{font-family:var(--mono,ui-monospace),monospace;font-size:15px;'
      + 'font-weight:700;color:var(--txt1,#f0f0ee);font-variant-numeric:tabular-nums}',
    '.novo-futures .fx-c{font-family:var(--mono,ui-monospace),monospace;font-size:11.5px;'
      + 'font-weight:700;margin-left:8px;font-variant-numeric:tabular-nums}',
    '.novo-futures .up{color:#34d399}.novo-futures .dn{color:#f43f5e}.novo-futures .flat{color:var(--txt3,#8f8f8f)}',
    /* the reads */
    '.novo-futures .fx-read{padding:14px 0;border-top:1px solid var(--bdr2,#242428)}',
    '.novo-futures .fx-grp + .fx-read{border-top:0}',
    '.novo-futures .fx-sess{font-family:var(--mono,ui-monospace),monospace;font-size:11px;'
      + 'font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--txt1,#f0f0ee)}',
    '.novo-futures .fx-when{font-family:var(--mono,ui-monospace),monospace;font-size:10px;'
      + 'letter-spacing:.06em;text-transform:uppercase;color:var(--txt3,#8f8f8f);margin-left:8px}',
    '.novo-futures .fx-bias{font-family:var(--mono,ui-monospace),monospace;font-size:11px;'
      + 'font-weight:800;letter-spacing:.12em;margin-left:8px}',
    '.novo-futures .fx-body{font-size:12.5px;color:var(--txt2,#a8a8a8);line-height:1.6;margin-top:7px;'
      + 'white-space:pre-wrap;overflow-wrap:anywhere}',
    '.novo-futures .fx-body.clamp{display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}',
    '.novo-futures .fx-more{font-family:var(--mono,ui-monospace),monospace;font-size:10px;'
      + 'letter-spacing:.1em;text-transform:uppercase;color:var(--acc,#34d399);background:none;'
      + 'border:0;padding:6px 0 0;cursor:pointer}',
    '.novo-futures .fx-empty{font-size:13px;color:var(--txt2,#a8a8a8);line-height:1.6;padding:4px 0 2px}',
    '.novo-futures .fx-how{font-size:11.5px;color:var(--txt3,#8f8f8f);line-height:1.6;margin-top:16px;'
      + 'padding-top:12px;border-top:1px solid var(--bdr2,#242428)}'
  ].join('');

  /* The futures complex first, in the order a trader reads it, then the macro that moves it.
     Names are the keys /api/quotes actually returns - the endpoint labels ES as "S&P 500". */
  var TAPE = [
    ['S&P 500', 'ES'], ['Nasdaq', 'NQ'], ['Russell', 'RTY'], ['Dow', 'YM'],
    ['VIX', 'VIX'], ['Gold', 'GC'], ['Crude', 'CL'], ['Dollar', 'DXY'], ['10Y', '10Y']
  ];

  function styles() {
    if (document.querySelector('style[data-novo-futures]')) return;
    var st = document.createElement('style');
    st.setAttribute('data-novo-futures', '1');
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function ago(ts) {
    var t = typeof ts === 'number' ? (ts > 1e12 ? ts : ts * 1000) : Date.parse(ts || '');
    if (!t) return '';
    var m = Math.max(0, Math.round((Date.now() - t) / 60000));
    return m < 1 ? 'just now' : m < 60 ? m + 'm ago'
      : m < 2880 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago';
  }
  /* The session name out of the read's own title line. The engine writes
     "[NIGHT WATCH — ES FUTURES · US PRE-MARKET]", so the label is already authored upstream and
     this only lifts it - it never invents one. */
  function sessionOf(text) {
    var m = String(text || '').match(/NIGHT WATCH[^\n]*?[·\-]\s*([A-Z0-9 \-]+)\]/i);
    return m ? m[1].trim() : '';
  }
  function biasOf(text) {
    var m = String(text || '').match(/MACRO BIAS\s*:\s*([A-Z]+)/i);
    return m ? m[1].toUpperCase() : '';
  }
  var BIAS_C = { BULLISH: '#34d399', BEARISH: '#f43f5e', NEUTRAL: 'var(--txt3,#8f8f8f)' };

  var root = null, QUOTES = null;

  function feed() {
    var f = window._abFeed;
    return Array.isArray(f) ? f : [];
  }

  function render() {
    if (!root) return;
    var h = '<h2>Futures <span class="fx-sub">24/5 tape and the night’s ES reads</span></h2>';

    h += '<div class="fx-grp">Live · 24/5</div>';
    if (QUOTES) {
      h += TAPE.map(function (pair) {
        var q = QUOTES[pair[0]];
        if (!q) return '';
        var c = Number(q.chg);
        var cls = !isFinite(c) || c === 0 ? 'flat' : c > 0 ? 'up' : 'dn';
        var sign = isFinite(c) && c > 0 ? '+' : '';
        return '<div class="fx-q"><span class="fx-n">' + esc(pair[0]) + '</span>'
          + '<span><span class="fx-v">' + esc(q.price) + '</span>'
          + '<span class="fx-c ' + cls + '">' + (isFinite(c) ? sign + c.toFixed(2) + '%' : '—') + '</span></span></div>';
      }).join('');
    } else {
      h += '<div class="fx-empty">The tape is not answering right now.</div>';
    }

    /* ONE READ PER SESSION, NEWEST FIRST. The engine caps the backlog at 12 rows over 48 hours, so
       the roll is upstream; showing them in order is all this has to do. */
    var reads = feed().filter(function (r) { return r && r.kind === 'futures'; });
    h += '<div class="fx-grp">Overnight ES reads · ' + reads.length + '</div>';
    if (reads.length) {
      h += reads.map(function (r, i) {
        var sess = sessionOf(r.text), bias = biasOf(r.text);
        return '<div class="fx-read"><div>'
          + '<span class="fx-sess">' + esc(sess || 'ES session') + '</span>'
          + '<span class="fx-when">' + esc(ago(r.ts)) + '</span>'
          + (bias ? '<span class="fx-bias" style="color:' + (BIAS_C[bias] || 'var(--txt3)') + '">'
                    + esc(bias) + '</span>' : '')
          + '</div><div class="fx-body clamp" data-b="' + i + '">' + esc(r.text || '') + '</div>'
          + '<button type="button" class="fx-more" data-x="' + i + '">Read in full</button></div>';
      }).join('');
    } else {
      /* A quiet night and a dead feed must not read the same. This says which, because the
         reads land on a schedule and their absence at 10am is a fault, not a market state. */
      h += '<div class="fx-empty">No overnight reads in the last 48 hours. These land on a '
        + 'schedule — Asian Globex, London and US pre-market — so an empty list outside '
        + 'a holiday means the feed is not arriving, not that the night was quiet.</div>';
    }

    h += '<div class="fx-how">The tape is the public 24/5 quote feed. The reads are NoVo’s own '
      + 'overnight ES sessions, kept in the durable store rather than the live slot that overwrites '
      + 'them — which is why all three of the night’s reads are here instead of only the '
      + 'last one. Each carries the macro bias it was published with, and those are scored.</div>';
    root.innerHTML = h;

    Array.prototype.forEach.call(root.querySelectorAll('.fx-more'), function (b) {
      b.addEventListener('click', function () {
        var body = root.querySelector('.fx-body[data-b="' + b.dataset.x + '"]');
        if (!body) return;
        var open = body.classList.toggle('clamp');
        b.textContent = open ? 'Read in full' : 'Collapse';
      });
    });
  }

  function loadQuotes() {
    return fetch('/api/quotes', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (d) { if (d) QUOTES = d; render(); });
  }

  function mount(sel) {
    styles();
    root = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!root) return;
    root.classList.add('novo-futures');
    render();
    loadQuotes();
    return true;
  }
  function refresh() { loadQuotes(); }

  window.novoFutures = { mount: mount, refresh: refresh, render: render };
})();
