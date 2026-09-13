/* novo-tape.js — three Trader tabs off ONE live-state fetch: History, Options flow, Sweeps & blocks.
 *
 * Jake, 2026-09-07: "This setup, historically and Historical analogues gets a tab together, Options
 * flow panel gets its own tab and Sweeps & blocks print tape gets its own tab."
 *
 * All three read the SAME payload the analyst dashboard renders from — GET /api/analyst-publish
 * ?live=1 with the member ticket — so this file formats and never derives. Where the analyst shows
 * a number, this shows the same number from the same field; if they ever disagree, one of them is
 * computing, and it will not be this one.
 *
 * ONE FETCH, THREE TABS. The payload is per-ticker and arrives whole. Fetching it once and letting
 * each tab render its slice means three tabs cannot show three different vintages of the same
 * session — which is exactly what three independent polls would eventually do.
 *
 * ⚠ TWO HONEST LABELS THAT MUST SHIP WITH THE NUMBERS:
 *   OPTIONS FLOW is VOLUME, and volume is UNDIRECTED. The producer's own docstring says so. It is
 *   call-vs-put DEMAND, not buy-vs-sell prints, and the heading says that in full because "live
 *   lean: calls 63%" reads as a directional call otherwise. Jake asked for the panel knowing this;
 *   the caveat is how it ships honestly rather than a reason not to ship it.
 *   THE PRINT TAPE is Tradier-only and can go stale. The analyst HIDES the whole panel when
 *   tape_flow is absent or stale. A tab cannot hide itself, so it says which of the two it is —
 *   a stale tape and a quiet tape are different facts and must not render alike.
 *
 * ⚠ Hairlines only, no boxes. Styles injected, tagged data-novo-tape.
 */
(function () {
  var CSS = [
    '.novo-tape{padding:4px 2px}',
    '.novo-tape h2{margin:0 0 4px;font-family:var(--mono,ui-monospace),monospace;font-size:11px;'
      + 'font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--txt2,#a8a8a8)}',
    '.novo-tape .tp-sub{display:block;font-size:11px;font-weight:500;color:var(--txt3,#8f8f8f);'
      + 'line-height:1.5;margin:0 0 14px;text-transform:none;letter-spacing:.02em}',
    '.novo-tape .tp-grp{font-family:var(--mono,ui-monospace),monospace;font-size:10px;'
      + 'letter-spacing:.16em;text-transform:uppercase;color:var(--txt3,#8f8f8f);margin:18px 0 2px;'
      + 'padding-top:14px;border-top:1px solid var(--bdr2,#242428)}',
    /* value rows — label left, number right, hairline between */
    '.novo-tape .tp-r{display:flex;align-items:baseline;justify-content:space-between;gap:12px;'
      + 'padding:11px 0;border-top:1px solid var(--bdr2,#242428)}',
    '.novo-tape .tp-grp + .tp-r{border-top:0}',
    '.novo-tape .tp-k{font-family:var(--mono,ui-monospace),monospace;font-size:10.5px;'
      + 'letter-spacing:.1em;text-transform:uppercase;color:var(--txt3,#8f8f8f)}',
    '.novo-tape .tp-v{font-family:var(--mono,ui-monospace),monospace;font-size:15px;font-weight:700;'
      + 'color:var(--txt1,#f0f0ee);font-variant-numeric:tabular-nums}',
    '.novo-tape .tp-s{display:block;font-size:11px;color:var(--txt3,#8f8f8f);margin-top:3px;line-height:1.45}',
    '.novo-tape .grn{color:#34d399}.novo-tape .red{color:#f43f5e}',
    /* 2-up stat block: hairline above each cell, one hairline between the columns, no boxes */
    '.novo-tape .tp-grid{display:grid;grid-template-columns:1fr 1fr}',
    '.novo-tape .tp-c{padding:13px 0 14px;border-top:1px solid var(--bdr2,#242428);min-width:0}',
    '.novo-tape .tp-c:nth-child(odd){padding-right:16px}',
    '.novo-tape .tp-c:nth-child(even){padding-left:16px;border-left:1px solid var(--bdr2,#242428)}',
    '.novo-tape .tp-ck{font-family:var(--mono,ui-monospace),monospace;font-size:10px;'
      + 'letter-spacing:.14em;text-transform:uppercase;color:var(--txt3,#8f8f8f)}',
    '.novo-tape .tp-cv{font-family:var(--mono,ui-monospace),monospace;font-size:19px;'
      + 'font-weight:800;color:var(--txt1,#f0f0ee);font-variant-numeric:tabular-nums;'
      + 'margin-top:5px;line-height:1.15;overflow-wrap:anywhere}',
    '.novo-tape .tp-cs{font-size:10.5px;color:var(--txt3,#8f8f8f);margin-top:5px;line-height:1.45}',
    /* unusual volume: a scaled bar, so the row is a comparison and not four loose numbers */
    '.novo-tape .tp-uv{display:grid;grid-template-columns:88px 1fr auto;gap:10px;'
      + 'align-items:center;padding:8px 0;border-top:1px solid var(--bdr2,#242428)}',
    '.novo-tape .tp-grp + .tp-uv{border-top:0}',
    '.novo-tape .tp-uk{font-family:var(--mono,ui-monospace),monospace;font-size:11px;'
      + 'letter-spacing:.06em;text-transform:uppercase}',
    '.novo-tape .tp-ubar{display:block;height:3px;background:var(--bdr2,#242428);border-radius:2px}',
    '.novo-tape .tp-ubar i{display:block;height:3px;border-radius:2px}',
    '.novo-tape .tp-ubar i.gb{background:#34d399}.novo-tape .tp-ubar i.rb{background:#f43f5e}',
    '.novo-tape .tp-un{font-family:var(--mono,ui-monospace),monospace;font-size:12.5px;'
      + 'font-weight:700;color:var(--txt1,#f0f0ee);font-variant-numeric:tabular-nums}',
    /* the print tape: time | side (+ venues) | size, size right-aligned on tabular numerals */
    '.novo-tape .tf-row{display:grid;grid-template-columns:46px 1fr auto;gap:10px;'
      + 'align-items:baseline;padding:8px 0;border-top:1px solid var(--bdr2,#242428)}',
    '.novo-tape .tp-grp + .tf-row{border-top:0}',
    '.novo-tape .tf-ts{font-family:var(--mono,ui-monospace),monospace;font-size:11px;'
      + 'color:var(--txt3,#8f8f8f);font-variant-numeric:tabular-nums}',
    '.novo-tape .tf-s{font-family:var(--mono,ui-monospace),monospace;font-size:12.5px;'
      + 'font-weight:700;color:var(--txt2,#a8a8a8);min-width:0;overflow-wrap:anywhere}',
    '.novo-tape .tf-v{display:block;font-family:var(--font,inherit);font-size:10px;'
      + 'font-weight:500;color:var(--txt3,#8f8f8f);letter-spacing:.02em;margin-top:2px}',
    '.novo-tape .tf-n{font-family:var(--mono,ui-monospace),monospace;font-size:13px;'
      + 'font-weight:800;color:var(--txt1,#f0f0ee);font-variant-numeric:tabular-nums;text-align:right}',
    '.novo-tape .tf-raw .tf-s{font-weight:500}',
    /* COLOUR HAS TO WIN, AND IT WAS LOSING ON ORDER (2026-09-08). Jake: "this isnt page colored
       like it should be" - every side label and every stat value rendered grey. `.novo-tape .grn`
       and `.novo-tape .tf-s` are BOTH (0,0,2,0), so specificity cannot break the tie and the LAST
       one declared wins. These component rules were appended after .grn/.red, which quietly made
       them the winner and turned the whole tape monochrome. Same trap as two equal !important
       rules: when specificity ties, source order decides, and appending is not neutral.
       Two-class selectors (0,0,3,0) settle it outright rather than depending on where a future
       rule gets added. */
    '.novo-tape .tp-cv.grn,.novo-tape .tf-s.grn,.novo-tape .tp-uk.grn,'
      + '.novo-tape .tp-val.grn,.novo-tape .b3-v.grn{color:#34d399}',
    '.novo-tape .tp-cv.red,.novo-tape .tf-s.red,.novo-tape .tp-uk.red,'
      + '.novo-tape .tp-val.red,.novo-tape .b3-v.red{color:#f43f5e}',
    /* the gauge now leads the tab, so its group label carries no rule above it */
    '.novo-tape .tp-grp-first{margin-top:2px;padding-top:0;border-top:0}',
    '.novo-tape .tp-sub-tight{margin:4px 0 10px}',
    /* the historical strip reads as prose, because it is a sentence about a sample */
    '.novo-tape .tp-claim{font-size:13.5px;color:var(--txt1,#f0f0ee);line-height:1.6;padding:12px 0;'
      + 'border-top:1px solid var(--bdr2,#242428)}',
    '.novo-tape .tp-grp + .tp-claim{border-top:0}',
    '.novo-tape .tp-claim b{font-family:var(--mono,ui-monospace),monospace;font-weight:800}',
    '.novo-tape .tp-meta{display:block;font-family:var(--mono,ui-monospace),monospace;font-size:10.5px;'
      + 'letter-spacing:.05em;text-transform:uppercase;color:var(--txt3,#8f8f8f);margin-top:5px}',
    /* the analogues table */
    '.novo-tape table{width:100%;border-collapse:collapse;font-size:12px}',
    '.novo-tape th{font-family:var(--mono,ui-monospace),monospace;font-size:9.5px;letter-spacing:.1em;'
      + 'text-transform:uppercase;color:var(--txt3,#8f8f8f);font-weight:700;text-align:right;padding:8px 0 8px 10px}',
    '.novo-tape th:first-child,.novo-tape td:first-child{text-align:left;padding-left:0}',
    '.novo-tape td{padding:9px 0 9px 10px;text-align:right;color:var(--txt2,#a8a8a8);'
      + 'border-top:1px solid var(--bdr2,#242428);font-variant-numeric:tabular-nums}',
    '.novo-tape .tp-wrap{overflow-x:auto}',
    '.novo-tape .tp-empty{font-size:13px;color:var(--txt2,#a8a8a8);line-height:1.6;padding:10px 0 2px}',
    '.novo-tape .tp-warn{font-size:12.5px;color:#fbbf24;line-height:1.6;padding:10px 0 2px}',
    '.novo-tape .tp-read{font-size:13.5px;color:var(--txt2,#a8a8a8);line-height:1.7;'
      + 'white-space:pre-wrap;overflow-wrap:anywhere;padding:10px 0 2px}',
    '.novo-tape .tp-fear{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding:10px 0 6px}',
    '.novo-tape .tp-fv{font-family:var(--mono,ui-monospace),monospace;font-size:21px;font-weight:800;'
      + 'color:var(--txt1,#f0f0ee);font-variant-numeric:tabular-nums}',
    '.novo-tape .tp-fp{font-family:var(--mono,ui-monospace),monospace;font-size:11px;color:var(--txt3,#8f8f8f);'
      + 'letter-spacing:.06em;text-transform:uppercase}',
    '.novo-tape .tp-ft{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;margin-left:auto}',
    '.novo-tape .tp-meter{position:relative;height:6px;border-radius:3px;'
      + 'background:linear-gradient(90deg,#10b981,#84cc16,#f59e0b,#f43f5e)}',
    '.novo-tape .tp-meter i{position:absolute;top:-3px;width:3px;height:12px;background:var(--txt1,#f0f0ee);'
      + 'border-radius:2px;transform:translateX(-1px)}',
    '.novo-tape .tp-scale{display:flex;justify-content:space-between;font-family:var(--mono,ui-monospace),monospace;'
      + 'font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--txt3,#8f8f8f);margin-top:5px}'
  ].join('');

  function styles() {
    if (document.querySelector('style[data-novo-tape]')) return;
    var st = document.createElement('style');
    st.setAttribute('data-novo-tape', '1');
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  function tok() { try { return localStorage.getItem('novo_live_t') || ''; } catch (_) { return ''; } }
  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function usd(n) {
    n = Number(n) || 0;
    var a = Math.abs(n), s = n < 0 ? '-' : '';
    if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(1) + 'B';
    if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return s + '$' + Math.round(a / 1e3) + 'K';
    return s + '$' + Math.round(a);
  }
  function num(n) { return n == null ? '—' : Number(n).toLocaleString(); }

  /* Which ticker the trader is actually looking at. The chart's own selection is the truth on this
     page; falling back to the published exec ticker keeps it right before the chart has loaded. */
  function ticker(state) {
    try { if (typeof _selTkr === 'function') return _selTkr(); } catch (_) {}
    try { var t = localStorage.getItem('novo_tkr'); if (t) return t; } catch (_) {}
    return (state && state.exec_ticker) || 'SPY';
  }
  function forTicker(state) {
    if (!state) return null;
    var tk = ticker(state);
    var arr = state.indices || [];
    for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].ticker === tk) return arr[i];
    return arr[0] || null;
  }

  var STATE = null, PENDING = null, MOUNTS = [];

  function load(force) {
    if (STATE && !force) return Promise.resolve(STATE);
    if (PENDING) return PENDING;
    /* ⚠ PENDING WAS A PERMANENT LATCH ON A STALL. A rejection clears it through the catch below;
       a STALL never rejects, so the final .then never ran, PENDING stayed set, and every later
       load() handed back the same dead promise. mount() and refresh() both await it, so one
       stalled response killed every tape view for the life of the page — History and Wire on
       analyst, all six on trader. Measured by Junie against real sockets, replaying this exact
       logic: body stall + bare fetch -> requests=1 settled=0, PENDING stuck; with a deadline ->
       requests=4 settled=4, recovers.

       The fix has to be a DEADLINE, not a tidier catch: if the fetch never settles then no
       .then, .catch or .finally on it ever runs, so there is no handler that could clear the
       latch. NovoFetch.json carries an AbortController and drains the body inside it.

       ⚠ DEADLINE IS THE THIRD ARGUMENT — NovoFetch.json(url, opts, ms). _tfetch and _cmFetch
       both take it SECOND, so porting by shape hands `ms` in as `opts` and silently falls back
       to the 12s default. Check the slot, not the count.

       Guarded, because this module is mounted by hosts that may not carry NovoFetch: the
       fallback is the old behaviour rather than a ReferenceError that would kill the module
       outright. trader-live.html now loads novo-fetch.js so the fallback should never fire
       there or on analyst — it exists so that a host which forgets the dependency degrades to
       today's bug instead of to a dead panel. */
    var _u = '/api/analyst-publish?live=1&t=' + encodeURIComponent(tok());
    var _req = (window.NovoFetch && window.NovoFetch.json)
      ? window.NovoFetch.json(_u, { cache: 'no-store' }, 12000)
      : fetch(_u, { cache: 'no-store' });
    PENDING = _req
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (d) { STATE = d; PENDING = null; return d; });
    return PENDING;
  }

  /* ── HISTORY: the base-rate strip and the analogues, together ─────────────────────────────── */
  function drawHistory(el, state) {
    var d = forTicker(state), tk = ticker(state);
    var h = '<h2>' + esc(tk) + ' · History</h2><span class="tp-sub">What this setup did before. '
          + 'A record, not a forecast — and worth nothing without its sample, which is why every '
          + 'number here carries one.</span>';

    var b = d && d.base_rate;
    h += '<div class="tp-grp">This setup, historically</div>';
    if (b && b.fwd60) {
      var up = Number(b.fwd60.up_rate), md = Number(b.fwd60.median);
      var dir = up >= 50 ? 'up' : 'down', pct = up >= 50 ? up : (100 - up);
      h += '<div class="tp-claim">Over the next hour it resolved <b>' + esc(dir) + ' '
         + pct.toFixed(0) + '%</b> of the time · median <b>'
         + (md >= 0 ? '+' : '') + md.toFixed(3) + '%</b>'
         + '<span class="tp-meta">' + esc(String(b.regime || '')) + ' · '
         + esc(String(b.flip || '').replace(/_/g, ' '))
         + (b.fwd60.n != null ? ' — n=' + num(b.fwd60.n) : '')
         + (b.sessions != null ? ' across ' + num(b.sessions) + ' sessions' : '') + '</span></div>';
    } else {
      /* The engine only sends a cell that clears its sample floor, so absence is the ordinary
         state of a thin setup - not a fault, and it must not read like one. */
      h += '<div class="tp-empty">No base rate for this setup yet. The engine only publishes a cell '
         + 'once it clears its sample floor, so this is thin history rather than a missing feed.</div>';
    }

    /* THE DAILY HALF (Jake's go 09-12, roadmap #6 / item 30) — and its placement lesson. The
       first ship rendered this into analyst-live's #d-br, which the :2123 retirement rule kills
       with display:none !important ("History owns it") — so "computed and drawn nowhere" was
       fixed by drawing it somewhere nothing can show (Junie 3e951315, same night). It lives HERE
       because here is where the base-rate story lives, beside its intraday sibling above, and
       the analogue-table retirement stays exactly as decided. Same sample-floor contract: the
       engine omits a thin cell, so absence renders nothing extra rather than an apology. */
    var bd = d && d.base_rate_daily;
    if (bd && bd.next_session && bd.next_session.up_rate != null) {
      var dup = Number(bd.next_session.up_rate), ddir = dup >= 50 ? 'up' : 'down',
          dpct = dup >= 50 ? dup : (100 - dup),
          dmd = bd.next_session.median, drng = bd.next_range_median;
      h += '<div class="tp-claim">Next <b>session</b> it resolved <b>' + esc(ddir) + ' '
         + dpct.toFixed(0) + '%</b> of the time'
         + (dmd != null ? ' · median <b>' + (Number(dmd) >= 0 ? '+' : '') + Number(dmd).toFixed(2) + '%</b>' : '')
         + (drng != null ? ' · typical range <b>±' + Number(drng).toFixed(2) + '%</b>' : '')
         + '<span class="tp-meta">open to close, same setup'
         + (bd.next_session.n != null ? ' — n=' + num(bd.next_session.n) : (bd.n != null ? ' — n=' + num(bd.n) : ''))
         + (bd.sessions != null ? ' across ' + num(bd.sessions) + ' sessions' : '') + '</span></div>';
    }

    /* THE RECORD BEHIND THE READS (Jake's go 09-12, under the Trader-supersets rule — one
       shared drawer puts it on BOTH dashboards' History at once). The bias records ship WITH
       ⚠ THE GRADING BANDS ARE NOT RENDERED, AND THAT IS DELIBERATE (Jake, 09-12, pulling the
       sentence the same day it shipped): the rate and its sample are the CLAIM — honest and
       checkable — while the exact thresholds a call is graded against are METHOD, and the
       method is not owed to the reader. `rec.scored` stays on the payload for the engine and
       the chat; it does not go on a surface. Do not re-add it. */
    var bz = state && state.bias;
    if (bz && (bz.lean_record || bz.audit_record)) {
      h += '<div class="tp-grp">The record behind the reads</div>';
      [['Premarket', bz.lean_record, 'sessions, open to close'],
       ['Hourly', bz.audit_record, 'hours']].forEach(function (pr) {
        var rec = pr[1];
        if (!rec) return;
        if (rec.enough && rec.correct_rate != null) {
          h += '<div class="tp-claim">' + pr[0] + ': right <b>' + esc(String(rec.correct_rate))
            + '%</b> over <b>' + esc(String(rec.n)) + '</b> ' + pr[2] + '.'
            + (rec.strength === 'inconclusive' ? ' Not yet a significant edge.' : '')
            + '</div>';
        } else {
          h += '<div class="tp-empty">' + pr[0] + ': record accruing — not enough scored calls to publish a rate yet.</div>';
        }
      });
    }

    var a = (state && state.analogues_by && state.analogues_by[tk])
         || (tk === 'SPY' ? (state && state.analogues) : null);
    /* `.analogues` IS THE LIST. `.rows` is the corpus row COUNT, and reading it here was the bug:
       find_analogues returns {status, rows: <integer>, analogues: [...]}, so `a.rows` handed back
       a number like 1547. A number is truthy, its .length is undefined, and the empty branch ran
       every single time - the trader said "No close analogues for today's shape yet" while the
       analyst, reading a.analogues off the same payload, listed three. Worse than a rename: the
       wrong name is a REAL field that means something else, so nothing ever threw. */
    var rows = (a && Array.isArray(a.analogues)) ? a.analogues : (Array.isArray(a) ? a : []);
    h += '<div class="tp-grp">Today looks like…</div>';
    if (rows.length) {
      /* The SAME field names the analyst renders, because it is the same payload: date, tod,
         similarity, regime, and the three forward moves nested under outcome. Every one of these
         was read from a different name before, so even a populated list would have drawn a table
         of dashes. */
      h += '<div class="tp-wrap"><table><thead><tr><th>Date</th><th>Time</th><th>Match</th>'
         + '<th>Regime</th><th>15m</th><th>60m</th><th>Close</th></tr></thead><tbody>'
         + rows.slice(0, 12).map(function (r) {
             var cell = function (v) {
               if (v == null || v === '') return '<td>—</td>';
               var n = Number(v);
               if (!isFinite(n)) return '<td>' + esc(v) + '</td>';
               return '<td class="' + (n > 0 ? 'grn' : n < 0 ? 'red' : '') + '">'
                    + (n > 0 ? '+' : '') + n.toFixed(2) + '%</td>';
             };
             var oc = r.outcome || {};
             var dl = r.date;
             try {
               var dd = new Date(r.date + 'T00:00:00');
               if (!isNaN(dd.getTime())) dl = dd.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
             } catch (_e) {}
             return '<tr><td>' + esc(dl || '') + '</td>'
                  + '<td>' + esc(r.tod || '') + '</td>'
                  + '<td>' + (r.similarity != null ? Math.round(Number(r.similarity)) + '%' : '—') + '</td>'
                  + '<td>' + esc(r.regime || '') + '</td>'
                  + cell(oc.fwd15) + cell(oc.fwd60) + cell(oc.into_close) + '</tr>';
           }).join('') + '</tbody></table></div>';
    } else if (a && a.status === 'accruing') {
      /* ACCRUING IS NOT "NOTHING MATCHED". The corpus has not banked enough shape for this ticker
         yet; saying "no close analogues" there reads as a verdict on today rather than on the
         sample, which is the distinction this whole panel exists to keep. */
      h += '<div class="tp-empty">The analogue corpus is still accruing for ' + esc(tk)
         + '. Not enough banked shape to match against yet — this is sample depth, not a verdict '
         + 'on today.</div>';
    } else {
      h += '<div class="tp-empty">No close analogues for today’s shape yet.</div>';
    }
    el.innerHTML = h;
    try { window.novoSubtabs && window.novoSubtabs.apply(el, { marker: '.tp-grp', key: 'tape' }); } catch (_e) {}
  }

  /* ── OPTIONS FLOW ─────────────────────────────────────────────────────────────────────────── */
  /* A 2-UP STAT BLOCK. Four numbers that answer one question belong side by side on tabular
     numerals, not stacked as four full-width rows - stacked, the eye reads them as a list of
     unrelated facts and has to scroll to compare two of them. Hairlines only: a rule above each
     cell and one between the columns. No boxes. */
  function cells(items) {
    return '<div class="tp-grid">' + items.map(function (c) {
      return '<div class="tp-c"><div class="tp-ck">' + esc(c.k) + '</div>'
           + '<div class="tp-cv ' + (c.cls || '') + '">' + c.v + '</div>'
           + (c.s ? '<div class="tp-cs">' + c.s + '</div>' : '') + '</div>';
    }).join('') + '</div>';
  }

  function drawFlow(el, state) {
    var d = forTicker(state), tk = ticker(state);
    var fl = d && d.flow;
    var h = '<h2>' + esc(tk) + ' &middot; Options flow</h2>'
          + '<span class="tp-sub">Volume-based &mdash; call vs put DEMAND, not buy/sell prints. '
          + 'Chain volume does not say which side initiated, so this is crowding, never direction.</span>';
    if (!fl || fl.status !== 'ok') {
      h += '<div class="tp-empty">No flow read yet for ' + esc(tk) + '. This builds through the '
         + 'session and is absent before the first delta, not broken.</div>';
      el.innerHTML = h; return;
    }
    var lp = fl.lean_pct, lean = fl.lean;
    var leanTxt = lean === 'calls' ? ('Calls' + (lp != null ? ' ' + lp + '%' : ''))
                : lean === 'puts' ? ('Puts' + (lp != null ? ' ' + (100 - lp) + '%' : ''))
                : lean === 'balanced' ? 'Balanced' : 'Building...';
    var pc = fl.pc_ratio;
    h += cells([
      { k: 'Live lean', v: esc(leanTxt),
        cls: lean === 'calls' ? 'grn' : lean === 'puts' ? 'red' : '',
        s: lp != null ? 'flow, last ~60s' : 'first read &mdash; no delta yet' },
      { k: 'Put / call vol', v: (pc != null ? Number(pc).toFixed(2) : '&mdash;'),
        cls: pc != null ? (pc >= 1.2 ? 'red' : pc <= 0.7 ? 'grn' : '') : '',
        s: 'day cumulative ratio' },
      { k: 'Call volume', v: num(fl.call_vol), cls: 'grn', s: 'contracts today' },
      { k: 'Put volume', v: num(fl.put_vol), cls: 'red', s: 'contracts today' }
    ]);
    /* UNUSUAL VOLUME AS A COMPARISON, not four numbers in a column. The question here is "which
       strike is crowded, and by how much against the others", so each bar is scaled to the
       largest of the set and the strike carries its side's colour. */
    var w = (fl.whales || []).slice(0, 6);
    if (w.length) {
      var top = 0;
      w.forEach(function (x) { var v = Number(x.vol || x.volume) || 0; if (v > top) top = v; });
      h += '<div class="tp-grp">Unusual volume</div>'
         + w.map(function (x) {
             var v = Number(x.vol || x.volume) || 0;
             var isCall = String(x.side || '').toUpperCase() === 'CALL';
             var pct = top ? Math.max(3, Math.round((v / top) * 100)) : 0;
             return '<div class="tp-uv"><span class="tp-uk ' + (isCall ? 'grn' : 'red') + '">'
                  + esc(String(x.side || '').toLowerCase()) + ' '
                  + esc(x.strike != null ? x.strike : '') + '</span>'
                  + '<span class="tp-ubar"><i class="' + (isCall ? 'gb' : 'rb')
                  + '" style="width:' + pct + '%"></i></span>'
                  + '<span class="tp-un">' + num(v) + '</span></div>';
           }).join('');
    }
    el.innerHTML = h;
    try { window.novoSubtabs && window.novoSubtabs.apply(el, { marker: '.tp-grp', key: 'tape' }); } catch (_e) {}
  }

  function drawSweeps(el, state) {
    var d = forTicker(state), tk = ticker(state);
    var t = d && d.tape_flow;
    var sess = String((state && state.session) || '').toLowerCase();
    var h = '<h2>' + esc(tk) + ' &middot; Sweeps &amp; blocks</h2>'
          + '<span class="tp-sub">Live prints &mdash; aggressive multi-exchange sweeps and large '
          + 'block trades. Unlike the flow tab, these carry an aggressor side.</span>';
    if (!t) {
      /* WHICH ABSENCE THIS IS. The old copy asserted "an empty tab here means no feed, not a
         quiet tape" - which the panel cannot know, and which was wrong every morning: pre-market
         the feed is connected and streaming and the options market simply has not opened. Saying
         "no feed" while 1,051 symbols are subscribed tells the member something false about their
         own data. The session is in the payload, so use it. */
      h += (sess === 'open')
         ? '<div class="tp-warn">No print tape for ' + esc(tk) + ' right now. This feed comes from '
           + 'a single venue and is not always present &mdash; an empty tab during the session '
           + 'means no feed, not a quiet tape.</div>'
         : '<div class="tp-empty">Options prints start at the 9:30 open. The tape is subscribed '
           + 'and waiting &mdash; nothing has traded yet, which is not the same as a feed being '
           + 'down.</div>';
      el.innerHTML = h; return;
    }
    if (t.stale) {
      h += '<div class="tp-warn">The print tape has stopped updating. What follows is the last '
         + 'thing it said, and it is old &mdash; a stale tape and a quiet tape are different '
         + 'facts.</div>';
    }
    var bias = t.sweep_bias || 'balanced', sc = Number(t.sweep_count) || 0;
    var bc = Number(t.block_count) || 0, ubc = Number(t.und_block_count) || 0;
    /* OPTION blocks and SHARE blocks stay apart, exactly as the analyst keeps them: a $50K option
       block summed with a $2M share block is a number about nothing. */
    var blockSub = (bc ? usd(t.block_notional) + ' opt premium' : 'large option prints');
    if (ubc) blockSub += ' &middot; ' + ubc + ' share block' + (ubc === 1 ? '' : 's')
                       + ' ' + usd(t.und_block_notional);
    h += cells([
      { k: 'Sweep bias', v: esc(bias.charAt(0).toUpperCase() + bias.slice(1)),
        cls: bias === 'bullish' ? 'grn' : bias === 'bearish' ? 'red' : '',
        s: sc ? (sc + ' sweep' + (sc === 1 ? '' : 's') + ' &middot; last ~45m') : 'no sweeps yet' },
      { k: 'Bullish sweeps', v: usd(t.call_sweep_prem), cls: 'grn', s: 'call-buys + put-sells' },
      { k: 'Bearish sweeps', v: usd(t.put_sweep_prem), cls: 'red', s: 'put-buys + call-sells' },
      { k: 'Blocks', v: ((bc || ubc) ? String(bc) : '&mdash;'), s: blockSub }
    ]);
    /* THE PRINTS. This read t.prints || t.rows, and the engine has always published them as
       t.feed - so the one thing this tab exists for, the tape itself, never rendered once. Each
       row arrives as a sentence ("Sweep - put-sell $14K across 3 venues") and is split into
       columns, because the reason to watch a tape is spotting the big one, and a size buried
       mid-sentence at a different offset on every line is exactly what stops you seeing it. */
    var feed = t.feed || t.prints || t.rows || [];
    if (feed.length) {
      h += '<div class="tp-grp">The tape</div>'
         + feed.slice(0, 40).map(function (x) {
             var txt = String(x.text || '');
             var cls = /call-buy|put-sell|bull/i.test(txt) ? 'grn'
                     : /put-buy|call-sell|bear/i.test(txt) ? 'red' : '';
             var ts = '<span class="tf-ts">' + esc(String(x.ts || x.time || '')) + '</span>';
             var m = txt.match(/^\s*([A-Za-z-]+)\s*[·:-]\s*([A-Za-z-]+)\s+(\$[\d.,]+\s*[KMBT]?)\s+across\s+(\d+)\s+venues?\s*$/i);
             if (!m) return '<div class="tf-row tf-raw">' + ts
                          + '<span class="tf-s ' + cls + '">' + esc(txt) + '</span></div>';
             return '<div class="tf-row">' + ts
                  + '<span class="tf-s ' + cls + '">' + esc(m[2])
                  + '<span class="tf-v">' + esc(m[1].toLowerCase()) + ' &middot; '
                  + esc(m[4]) + ' venues</span></span>'
                  + '<span class="tf-n">' + esc(m[3].replace(/\s+/g, '')) + '</span></div>';
           }).join('');
    } else {
      h += '<div class="tp-grp">The tape</div><div class="tp-empty">Watching the tape &mdash; '
         + 'sweeps and block prints appear here as they hit.</div>';
    }
    el.innerHTML = h;
    try { window.novoSubtabs && window.novoSubtabs.apply(el, { marker: '.tp-grp', key: 'tape' }); } catch (_e) {}
  }

  function drawRead(el, state) {
    var tk = ticker(state);
    var r = state && state.read;
    var h = '<h2>' + esc(tk) + ' &middot; Desk note</h2>';

    /* THE GAUGE GOES FIRST (Jake, 2026-09-08: "move the fear guage to the top of the read tab
       where it belongs"). It was last, under a read that can run to several hundred words - so
       the one number that frames everything below it sat off the bottom of the screen and you
       had to scroll past the whole argument to reach the conditions the argument was made in.
       Colour follows the SERVER's own bands, so the pill text and its colour can never imply
       two different severities. */
    var fd = (state && state.vol_env_by && state.vol_env_by[tk]) || null;
    var sym, val, pct, tag;
    if (fd && fd.value != null && fd.pct != null) {
      sym = fd.sym || 'VIX'; val = Number(fd.value); pct = parseInt(fd.pct, 10); tag = fd.tag || '';
    } else {
      var t = (state && state.vol_env) || '';
      var vm = t.match(/(VIX|VXN|RVX)\s+([\d.]+)/i);
      var pm = t.match(/(\d+)\s*(?:st|nd|rd|th)?\s*percentile/i);
      var gm = t.match(/\(([^)]+)\)/);
      if (vm && pm) { sym = vm[1].toUpperCase(); val = Number(vm[2]); pct = parseInt(pm[1], 10); tag = gm ? gm[1] : ''; }
    }
    if (isFinite(val) && isFinite(pct)) {
      pct = Math.max(0, Math.min(100, pct));
      var col = pct <= 35 ? '#10b981' : pct <= 65 ? '#f59e0b' : '#f43f5e';
      h += '<div class="tp-grp tp-grp-first">Fear gauge &middot; ' + esc(sym) + '</div>'
        + '<div class="tp-fear"><span class="tp-fv">' + esc(sym) + ' ' + val.toFixed(1) + '</span>'
        + '<span class="tp-fp">' + pct + 'th pct &middot; 1yr</span>'
        + '<span class="tp-ft" style="color:' + col + '">' + esc(tag) + '</span></div>'
        + '<div class="tp-meter"><i style="left:' + pct + '%"></i></div>'
        + '<div class="tp-scale"><span>calm</span><span>fear</span></div>';
    }

    if (r && r.text) {
      /* STALE IS LABELLED, NOT HIDDEN. When the payload falls back to the most recent archived
         read rather than today's, the analyst says so in the heading - and a read presented as
         today's when it is Friday's is the kind of quiet lie this product does not ship. */
      h += '<div class="tp-grp">' + esc(r.title || 'Latest read') + '</div>'
        + '<span class="tp-sub tp-sub-tight">' + (r.stale
            ? 'Latest read' + (r.dateLabel ? ' &middot; ' + esc(r.dateLabel) : '')
              + ' &mdash; today&rsquo;s has not published yet.'
            : 'Published today.') + '</span>'
        + '<div class="tp-read">' + esc(r.text) + '</div>';
    } else {
      h += '<div class="tp-grp">Latest read</div>'
        + '<span class="tp-sub tp-sub-tight">The Open, The Close and the Sunday Week Ahead land '
        + 'here as they publish.</span>'
        + '<div class="tp-empty">Next read publishes before the bell.</div>';
    }
    /* NOTHING ELSE BELONGS HERE (Jake, 09-12, on opening the tab to a strip of seven subtabs:
       "the desk note tab is for the desk notes, that is it… only thing is the fear gauge,
       same tab, it fits; everything else does not make sense"). Max pain, the expiry ladder,
       ranked strikes and blind spots moved to the Structure surface; the macro catalysts
       moved beside the earnings calendar on the Wire. The gauge stays because it frames the
       read — it is the conditions the argument was made in, not a separate subject.
       No novoSubtabs call: one subject is not a tab strip, and a strip over a single panel
       is the furniture that made this tab unreadable. */
    el.innerHTML = h;
  }

  var _rhCache = null, _rhAt = 0;
  function _fillRh(root, tk) {
    var wbox = root.querySelector('.tp-wire'), ebox = root.querySelector('.tp-earn'),
        mbox = root.querySelector('.tp-mwire');
    if (!wbox && !ebox && !mbox) return;
    /* One row renderer for both wires — the market pool and the ticker list differ only in which
       key they read and whether the row names the symbols it filed under. */
    var wireRows = function (arts, showSyms, cap) {
      return arts.slice(0, cap).map(function (a) {
        var age = '';
        try {
          var hrs = Math.max(0, (Date.now() - Date.parse(a.published_at)) / 3600000);
          age = hrs < 1 ? Math.round(hrs * 60) + 'm' : hrs < 48 ? Math.round(hrs) + 'h' : Math.round(hrs / 24) + 'd';
        } catch (_e) { age = ''; }
        var syms = (showSyms && a.symbols && a.symbols.length)
          ? ' · ' + a.symbols.slice(0, 3).join(' · ') : '';
        return '<div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06);">'
          + '<div style="font-size:12px;line-height:1.45">' + esc(a.title || '') + '</div>'
          + '<div class="tp-meta" style="margin-top:2px">' + esc(a.publisher || '')
          + (age ? ' · ' + age + ' ago' : '') + esc(syms) + '</div>'
          + '</div>';
      }).join('');
    };
    var render = function (j) {
      if (mbox) {
        var m = j && j.wire && j.wire.MARKET;
        var marts = (m && m.articles) || [];
        mbox.innerHTML = marts.length
          ? wireRows(marts, true, 20)
            + (m.dropped ? '<div class="tp-meta" style="padding-top:6px">newest 20 shown · '
                + Number(m.dropped) + ' more in the window</div>' : '')
          : '<div class="tp-empty">The market wire has not refreshed yet — this is an empty read, '
            + 'not a quiet tape.</div>';
      }
      if (wbox) {
        var w = j && j.wire && j.wire[tk];
        var arts = (w && w.articles) || [];
        if (!arts.length) {
          wbox.innerHTML = '<div class="tp-empty">No wire items for ' + esc(tk) + ' yet — the feed '
            + 'refreshes with the cloud feeder’s next pass.</div>';
        } else {
          wbox.innerHTML = wireRows(arts, false, 12)
          + (w.dropped ? '<div class="tp-meta" style="padding-top:6px">newest 12 shown · ' + Number(w.dropped) + ' more in the window</div>' : '');
        }
      }
      if (ebox) {
        var ev = (j && j.earnings && j.earnings.events) || [];
        var today = new Date().toISOString().slice(0, 10);
        var up = ev.filter(function (e) { return e && e.date && e.date >= today; })
                   .sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
        if (!up.length) {
          ebox.innerHTML = '<div class="tp-empty">No upcoming reporters in the loaded window.</div>';
        } else {
          var shown = up.slice(0, 6);
          ebox.innerHTML = shown.map(function (e) {
            return '<div style="display:flex;gap:10px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:11.5px;white-space:nowrap;">'
              + '<span style="min-width:86px;opacity:.65;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">'
              + esc(String(e.date).slice(5)) + ' ' + esc(e.timing || '') + '</span>'
              + '<span style="flex:1"><b>' + esc(e.symbol || '') + '</b>'
              + (e.quarter ? ' <span style="opacity:.55">Q' + esc(String(e.quarter)) + (e.year ? ' FY' + esc(String(e.year)) : '') + '</span>' : '') + '</span>'
              + (e.eps_actual != null ? '<span style="opacity:.8">EPS ' + esc(String(e.eps_actual)) + (e.eps_estimate != null ? ' <span style="opacity:.5">est ' + esc(String(e.eps_estimate)) + '</span>' : '') + '</span>'
                 : (e.eps_estimate != null ? '<span style="opacity:.6">est ' + esc(String(e.eps_estimate)) + '</span>' : ''))
              + '</div>';
          }).join('')
          + (up.length > shown.length ? '<div class="tp-meta" style="padding-top:6px">next 6 of ' + up.length + '</div>' : '');
        }
      }
    };
    if (_rhCache && Date.now() - _rhAt < 300000) { render(_rhCache); return; }
    fetch('/api/analyst-publish?rh=1&t=' + encodeURIComponent(tok()), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.ok) { _rhCache = j; _rhAt = Date.now(); } render(j && j.ok ? j : _rhCache); })
      .catch(function () { render(_rhCache); });
  }

  var _calCache = null, _calAt = 0;
  function _fillCal(box) {
    if (!box) return;
    var render = function (j) {
      var evs = (j && j.events) || [];
      var today = new Date().toISOString().slice(0, 10);
      var up = evs.filter(function (e) { return e && e.date >= today; }).slice(0, 6);
      if (!up.length) {
        box.innerHTML = '<div class="tp-empty">No major US releases in the loaded window.</div>';
        return;
      }
      box.innerHTML = up.map(function (e) {
        return '<div style="display:flex;gap:10px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:11.5px;">'
          + '<span style="min-width:96px;opacity:.65;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">'
          + esc(String(e.date).slice(5)) + ' ' + esc(e.time || '') + ' ET</span>'
          + '<span style="flex:1">' + esc(e.event || '') + '</span>'
          + (e.consensus ? '<span style="opacity:.6">est ' + esc(String(e.consensus)) + '</span>'
             : (e.previous ? '<span style="opacity:.5">prev ' + esc(String(e.previous)) + '</span>' : ''))
          + '</div>';
      }).join('');
    };
    if (_calCache && Date.now() - _calAt < 600000) { render(_calCache); return; }
    fetch('/api/calendar', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j) { _calCache = j; _calAt = Date.now(); } render(j || _calCache); })
      .catch(function () { render(_calCache); });
  }

  /* THE WIRE DRAWER (Jake's 09-12 display approval) — Wire + Earnings as their own TOP-LEVEL
     surface on BOTH dashboards — a feature Analyst shows as a tab, Trader shows as a tab,
     never buried inside another one. Carries the macro catalysts too, since a catalyst and
     an earnings date are the same question. One renderer, one data door, two dashboards. */
  function drawWire(el, state) {
    var tk = ticker(state);
    /* THE MARKET WIRE LEADS (Jake, 09-12: "its market news not what the couple tickers have
       going on today"). The pooled, de-duplicated feed across the breadth set is the first
       group; the ticker-scoped list stays as the second, for a reader working one name. */
    var h = '<h2>Wire &amp; earnings</h2>'
      + '<span class="tp-sub">Headlines with their source and age &mdash; the attribution is the '
      + 'fact &mdash; and the upcoming reporters. No genre tag exists on this feed, so nothing '
      + 'here claims wire-vs-opinion; read the byline.</span>'
      + '<div class="tp-grp">Market wire</div>'
      + '<div class="tp-mwire"><div class="tp-empty">Loading the wire…</div></div>'
      + '<div class="tp-grp">Wire · ' + esc(tk) + '</div>'
      + '<div class="tp-wire"><div class="tp-empty">Loading the wire…</div></div>'
      + '<div class="tp-grp">Earnings · upcoming</div>'
      + '<div class="tp-earn"><div class="tp-empty">Loading the calendar…</div></div>'
      /* CATALYSTS moved here off the Desk note (Jake, 09-12). It sits beside the earnings
         calendar because the two are one subject — what is scheduled — and neither is a
         read. OUR feed (/api/calendar, the same one /economic-calendar reads), never the
         broker lane: printing a licensed feed on a paid surface is the resell shape. */
      + '<div class="tp-grp">Catalysts · major US macro</div>'
      + '<div class="tp-cal"><div class="tp-empty">Loading the calendar…</div></div>';
    el.innerHTML = h;
    _fillRh(el, tk);
    _fillCal(el.querySelector('.tp-cal'));
    try { window.novoSubtabs && window.novoSubtabs.apply(el, { marker: '.tp-grp', key: 'tape' }); } catch (_e) {}
  }


  /* ── STRUCTURE · the book by strike and by expiry ──────────────────────────────────────
     Max pain, the expiry ladder, the ranked strikes and the blind spots between them. All
     four rode into the Desk note during the 09-12 parity port and Jake pulled them on sight.
     They belong together on their OWN surface because they are one subject — where the book
     sits across strikes and dates — and none of them is a read. Renderers moved verbatim,
     path gate dropped: this surface only mounts where it is wanted, so the mount is the gate.
     Absent-tolerant like every other drawer: an older payload renders the empty line. */
  function drawStructure(el, state) {
    var tk = ticker(state);
    var h = '<h2>' + esc(tk) + ' &middot; Structure</h2>'
      + '<span class="tp-sub">Where the weight sits across strikes, where it settles by expiry, and the runs in between with nothing to lean on.</span>';
    var d0 = forTicker(state);
    var _busd = function (v) { v = Math.abs(Number(v) || 0);
      return v >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M'
           : '$' + Math.round(v).toLocaleString(); };
    if (d0 && d0.max_pain != null && isFinite(+d0.max_pain)) {
      var _mp0 = Array.isArray(d0.term) && d0.term.some(function (x) { return x && x.is_0dte; });
      h += '<div class="tp-grp">Max pain</div>'
        + '<div class="tp-claim"><b>' + (+d0.max_pain).toFixed(2) + '</b>'
        + '<span class="tp-meta">' + (_mp0 ? '0DTE' : 'nearest expiry')
        + ' · least payout at expiry · drawn on the chart as MAX PAIN</span></div>';
    }
    if (d0 && Array.isArray(d0.term) && d0.term.filter(function (x) { return x && x.exp; }).length >= 2) {
      h += '<div class="tp-grp">Term structure · the expiry ladder</div><div style="overflow-x:auto">';
      d0.term.forEach(function (x) {
        if (!x || !x.exp) return;
        var g = Number(x.net_gex);
        h += '<div style="display:flex;justify-content:space-between;gap:10px;padding:4px 0;white-space:nowrap;'
          + 'border-bottom:1px solid rgba(255,255,255,0.06);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;">'
          + '<span style="min-width:74px;opacity:.8">' + esc(String(x.exp).slice(5))
          + (x.is_0dte ? ' <b style="color:#22d3ee">0DTE</b>' : '') + '</span>'
          + '<span style="color:' + (isFinite(g) && g < 0 ? '#f43f5e' : '#34d399') + '">'
          + (isFinite(g) ? (g < 0 ? '−' : '+') + _busd(g) : '—') + '</span>'
          + '<span style="opacity:.6">' + (x.share_pct != null ? Number(x.share_pct).toFixed(1) + '%' : '') + '</span>'
          + '<span style="opacity:.6">P/C ' + (x.pc_oi != null ? Number(x.pc_oi).toFixed(2) : '—') + '</span>'
          + '<span style="opacity:.8">MP ' + (x.max_pain != null ? (+x.max_pain).toFixed(0) : '—') + '</span></div>';
      });
      h += '</div>';
    }
    /* RANKED STRIKES & BLIND SPOTS on trader (the LAST Analyst-only remainder after Tema's
       09-12 parity correction; Jake's supersets rule). Same algorithm as analyst-live's
       gex-rank card, same payload field (d0.profile {k,g}), rendered in this drawer's idiom.
       The chart's heat overlay + pin/void lines stay the trader-native VISUAL; this is the
       ranked LIST beside it. Trader-gated: analyst has its own card. */
    if (d0 && Array.isArray(d0.profile)) {
      var _pr = d0.profile.filter(function (r) { return r && isFinite(r.k) && isFinite(r.g); });
      if (_pr.length >= 5) {
        var _spot = Number(d0.spot) || 0;
        var _ranked = _pr.slice().sort(function (a, b) { return Math.abs(b.g) - Math.abs(a.g); }).slice(0, 10);
        var _top = Math.abs(_ranked[0].g) || 1;
        h += '<div class="tp-grp">Ranked strikes</div>';
        _ranked.forEach(function (r, i) {
          var pct = _spot ? ((r.k / _spot - 1) * 100) : null;
          h += '<div style="display:flex;align-items:center;gap:8px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:11.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">'
            + '<span style="opacity:.45;min-width:16px">' + (i + 1) + '</span>'
            + '<span style="min-width:44px">' + r.k + '</span>'
            + '<span style="flex:1;height:6px;background:rgba(255,255,255,0.04)"><i style="display:block;height:6px;width:'
            + Math.max(2, Math.abs(r.g) / _top * 100).toFixed(1) + '%;background:' + (r.g < 0 ? '#f43f5e' : '#10b981') + '"></i></span>'
            + '<span style="opacity:.8">' + (r.g < 0 ? '−' : '+') + Math.round(Math.abs(r.g)).toLocaleString() + '</span>'
            + '<span style="opacity:.5;min-width:52px;text-align:right">' + (pct == null ? '' : (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%') + '</span>'
            + '</div>';
        });
        h += '<div class="tp-meta" style="padding-top:4px">ranked by absolute gamma — sign shown; a short-gamma strike matters as much and means the opposite</div>';
        var _mags = _pr.map(function (r) { return Math.abs(r.g); }).sort(function (a, b) { return a - b; });
        var _med = _mags[Math.floor(_mags.length / 2)] || 0;
        var _heavy = _pr.filter(function (r) { return Math.abs(r.g) >= _med * 0.10; })
                        .sort(function (a, b) { return a.k - b.k; });
        var _steps = [];
        for (var _s1 = 1; _s1 < _heavy.length; _s1++) _steps.push(_heavy[_s1].k - _heavy[_s1 - 1].k);
        _steps.sort(function (a, b) { return a - b; });
        var _medStep = _steps.length ? _steps[Math.floor(_steps.length / 2)] : 0;
        var _gaps = [];
        if (_medStep > 0) {
          for (var _gi = 1; _gi < _heavy.length; _gi++) {
            var _lo = _heavy[_gi - 1].k, _hi = _heavy[_gi].k, _w = _hi - _lo;
            if (_w >= _medStep * 2) _gaps.push({ lo: _lo, hi: _hi, mid: (_lo + _hi) / 2, x: _w / _medStep });
          }
        }
        _gaps.sort(function (a, b) { return Math.abs(a.mid - _spot) - Math.abs(b.mid - _spot); });
        h += '<div class="tp-grp">Blind spots</div>';
        if (_gaps.length) {
          h += _gaps.slice(0, 3).map(function (g2) {
            return '<div style="padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:11.5px;">'
              + '<b>' + g2.lo + '–' + g2.hi + '</b> <span class="tp-meta" style="display:inline">'
              + g2.x.toFixed(1) + '× the usual strike gap</span></div>';
          }).join('')
          + '<div class="tp-meta" style="padding-top:4px">runs between strikes carrying real weight — a move through one has little to lean on</div>';
        } else {
          h += '<div class="tp-empty">No gap wider than twice this book’s usual strike spacing.</div>';
        }
      }
    }
    if (h.indexOf('tp-grp') < 0) {
      h += '<div class="tp-empty">No strike ladder in this payload yet.</div>';
    }
    el.innerHTML = h;
    try { window.novoSubtabs && window.novoSubtabs.apply(el, { marker: '.tp-grp', key: 'tape' }); } catch (_e) {}
  }

  /* ── THE GREEKS LADDER ────────────────────────────────────────────────────────────────────
     One number per strike, drawn as bars off a midline. `g` has always shipped; d/v/c arrive
     with the engine change that stopped summing them away (NoVo-Pulse 525be0b).

     A VIEW OF ITS OWN RATHER THAN A BLOCK INSIDE drawStructure. Analyst does not mount
     'structure' and should not have to: mounting it to reach this would drag max pain and the
     expiry ladder onto a surface that never asked for them — a product change smuggled in by an
     implementation choice. Both hosts mount 'greeks' directly; the rail button on trader reveals
     itself off novoTape.has('greeks').

     ⚠ ONE SERIES AT A TIME, AND THE UNIT IS ALWAYS ON SCREEN. These are not the same kind of
     number. Delta exposure is SHARES; gamma, vanna and charm are DOLLARS; charm is a per-DAY
     rate. Two units on one axis is a comparison that means nothing, and on the trader rail this
     is load-bearing beyond labelling — the panel sits beside a chart whose whole vocabulary is
     dollars-of-gamma, so a shares axis appearing unannounced would be read against it. */
  var GK_SERIES = [
    { k: 'g', label: 'GAMMA', unit: 'dealer gamma, $ per 1% move' },
    /* NOT "dealer delta". Gamma, vanna and charm are dealer-signed (+calls / -puts, the net-GEX
       convention). Delta is not: the chain's delta already carries its own sign, so the engine
       sums it raw and calculate_greek_exposure calls the result the BOOK'S aggregate directional
       exposure — all open interest, not the dealer's half. Labelling it dealer delta would tell a
       member they are looking at dealer positioning when they are looking at the whole book. */
    { k: 'd', label: 'DELTA', unit: 'net delta of open interest, shares — not dealer-signed' },
    { k: 'v', label: 'VANNA', unit: 'dealer vanna, $ per vol point' },
    { k: 'c', label: 'CHARM', unit: 'dealer charm, $ of delta per day' }
  ];
  var GK_PICK = 'g';

  /* ⚠ THE HOSTS DO NOT AGREE ON WHERE THE SELECTED TICKER LIVES, and for this view that is not
     cosmetic — a per-strike ladder drawn for the wrong symbol is wrong in a way nothing on screen
     would reveal. trader sets _selTkr(); ANALYST stores 'novo_analyst_ticker'; ticker() above
     reads 'novo_tkr' and otherwise falls back to state.exec_ticker, which is the engine's own
     execution symbol rather than the one the member picked. On analyst that fallback is what you
     get, so switching ticker would leave this panel showing SPY while the page showed QQQ.

     This EXTENDS ticker() rather than changing it: existing views keep their current behaviour
     exactly. Whether drawHistory should also follow the analyst ticker is a real question about
     those panels, and it is not mine to answer by editing a shared resolver underneath them —
     raised separately. */
  function gkTicker(state) {
    try { if (typeof _selTkr === 'function') return _selTkr(); } catch (_) {}
    try { var a = localStorage.getItem('novo_analyst_ticker'); if (a) return String(a).toUpperCase(); } catch (_) {}
    return ticker(state);
  }

  function gkFor(state) {
    if (!state) return null;
    var tk = gkTicker(state), arr = state.indices || [];
    for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].ticker === tk) return arr[i];
    return arr[0] || null;
  }

  function gkHas(d0, key) {
    return !!(d0 && Array.isArray(d0.profile) &&
              d0.profile.some(function (r) { return r && isFinite(r[key]); }));
  }

  function gkPaint(cv, d0, ser, serLabel) {
    if (!cv || !d0 || !Array.isArray(d0.profile)) return 0;
    /* ⚠ ROWS LACKING THE CHOSEN SERIES ARE DROPPED, NOT DRAWN AT ZERO. A strike whose greeks
       could not be computed is UNKNOWN; a zero-length bar reads as "no exposure at this strike",
       which is a claim the payload never made. Same decision that refused coarser rounding on the
       wire, where it would have manufactured false zeros at exactly the thin strikes that matter. */
    var rows = d0.profile.filter(function (r) { return r && isFinite(r.k) && isFinite(r[ser]); })
                         .sort(function (a, b) { return a.k - b.k; });
    var wrap = cv.parentNode;
    var dpr = window.devicePixelRatio || 1;
    var W = cv.offsetWidth || (wrap && wrap.clientWidth) || 320;
    var H = Math.max(200, (wrap && wrap.clientHeight) || 240);
    cv.width = W * dpr; cv.height = H * dpr;
    var c = cv.getContext('2d'); c.scale(dpr, dpr); c.clearRect(0, 0, W, H);
    var n = rows.length;
    if (!n) return 0;

    var maxAbs = Math.max.apply(null, rows.map(function (r) { return Math.abs(r[ser]) || 0; })) || 1;
    var padT = 10, padB = 16, axisW = 46;
    var plotL = axisW, plotW = W - axisW - 6, mid = plotL + plotW * 0.5;
    var rowH = (H - padT - padB) / n, bh = Math.max(2, rowH - 1.5);

    function yOfIndex(i) { return padT + (n - 1 - i) * rowH + rowH / 2; }
    function yOfStrike(k) {
      if (k <= rows[0].k) return yOfIndex(0);
      if (k >= rows[n - 1].k) return yOfIndex(n - 1);
      for (var i = 0; i < n - 1; i++) {
        if (k >= rows[i].k && k <= rows[i + 1].k) {
          var t = (k - rows[i].k) / ((rows[i + 1].k - rows[i].k) || 1);
          return yOfIndex(i) + t * (yOfIndex(i + 1) - yOfIndex(i));
        }
      }
      return yOfIndex(n - 1);
    }

    rows.forEach(function (r, i) {
      var yy = yOfIndex(i) - bh / 2, val = r[ser];
      var w = (Math.abs(val) / maxAbs) * (plotW * 0.46);
      c.fillStyle = val >= 0 ? 'rgba(52,211,153,0.78)' : 'rgba(248,113,113,0.78)';
      if (val >= 0) c.fillRect(mid, yy, w, bh); else c.fillRect(mid - w, yy, w, bh);
    });

    c.strokeStyle = 'rgba(255,255,255,0.28)'; c.setLineDash([3, 3]);
    c.beginPath(); c.moveTo(mid, padT); c.lineTo(mid, H - padB); c.stroke(); c.setLineDash([]);

    c.font = '9.5px ui-monospace,SFMono-Regular,Menlo,monospace';
    c.textAlign = 'right'; c.textBaseline = 'middle'; c.fillStyle = '#5b708c';
    var minK = rows[0].k, maxK = rows[n - 1].k, rng = (maxK - minK) || 1;
    var raw = rng / 6, pw = Math.pow(10, Math.floor(Math.log10(raw))), mm = raw / pw;
    var stepK = (mm < 1.5 ? 1 : mm < 3.5 ? 2 : mm < 7.5 ? 5 : 10) * pw;
    for (var kk = Math.ceil(minK / stepK) * stepK; kk <= maxK + 0.001; kk += stepK) {
      c.fillText(kk.toFixed(0), axisW - 6, yOfStrike(kk));
    }

    var guides = [];
    [[d0.put_wall, '#fbbf24', 'PUT WALL'], [d0.call_wall, '#fbbf24', 'CALL WALL'],
     [d0.flip, '#22d3ee', '0-GAMMA'], [d0.spot, 'rgba(234,243,255,0.92)', 'SPOT']]
      .forEach(function (g) {
        if (g[0] != null && isFinite(+g[0])) guides.push({ k: +g[0], color: g[1], label: g[2], y: yOfStrike(+g[0]) });
      });
    if (d0.spot != null && d0.em_daily != null && isFinite(+d0.spot) && isFinite(+d0.em_daily) && +d0.em_daily > 0) {
      guides.push({ k: +d0.spot + +d0.em_daily, color: '#a78bfa', label: 'EM HIGH', y: yOfStrike(+d0.spot + +d0.em_daily) });
      guides.push({ k: +d0.spot - +d0.em_daily, color: '#a78bfa', label: 'EM LOW', y: yOfStrike(+d0.spot - +d0.em_daily) });
    }
    guides.forEach(function (g) {
      c.strokeStyle = g.color; c.setLineDash([2, 2]);
      c.beginPath(); c.moveTo(plotL, g.y); c.lineTo(W - 4, g.y); c.stroke();
    });
    c.setLineDash([]); c.textAlign = 'left'; c.textBaseline = 'middle';
    c.font = '9px ui-monospace,Menlo,monospace';
    guides.slice().sort(function (a, b) { return a.y - b.y; }).forEach(function (g, idx, arr) {
      var ly = g.y; if (idx > 0 && ly < arr[idx - 1]._ly + 11) ly = arr[idx - 1]._ly + 11; g._ly = ly;
      var txt = g.label + ' ' + g.k.toFixed(2), tw = c.measureText(txt).width;
      c.fillStyle = 'rgba(7,11,18,0.74)'; c.fillRect(plotL + 3, ly - 6, tw + 5, 12);
      c.fillStyle = g.color; c.fillText(txt, plotL + 5, ly);
    });

    /* THE ORIENTATION CAPTIONS, AND THEY FOLLOW THE SERIES. The inline version this replaces
       said "net short gamma" / "net long gamma" unconditionally, which was fine while gamma was
       the only thing it could draw and would have been wrong on every other series the moment a
       selector appeared. Naming the series keeps the cue and removes the lie.
       CANVAS TEXT IS INVISIBLE TO EVERY DOM CONTRAST TOOL — it is painted, not an element, so a
       walker over getComputedStyle cannot see it and will report the page clean. Tracked to the
       same value as --txt3 by hand for that reason. */
    var _sl = String(serLabel || '').toLowerCase() || 'exposure';
    c.fillStyle = '#8f8f8f'; c.font = '9px sans-serif'; c.textBaseline = 'alphabetic';
    c.textAlign = 'left'; c.fillText('← net short ' + _sl, plotL + 2, H - 4);
    c.textAlign = 'right'; c.fillText('net long ' + _sl + ' →', W - 4, H - 4);
    return n;
  }

  function drawGreeks(el, state) {
    var d0 = gkFor(state), tk = gkTicker(state);
    /* An engine publishing the older [{k,g}] payload has no d/v/c at all, and DEX in particular
       may be absent on its own. Offer only what is on the wire and fall back to gamma, rather
       than draw an empty panel for a series that cannot exist. */
    var avail = GK_SERIES.filter(function (s) { return s.k === 'g' || gkHas(d0, s.k); });
    var active = gkHas(d0, GK_PICK) ? GK_PICK : 'g';
    var cur = GK_SERIES.filter(function (s) { return s.k === active; })[0] || GK_SERIES[0];
    var title = cur.label.charAt(0) + cur.label.slice(1).toLowerCase();

    var h = '<h2>' + esc(tk) + ' &middot; ' + esc(title) + ' by strike</h2>'
          + '<span class="tp-sub">' + esc(cur.unit) + '</span>';
    // A lone series is not a choice — show no control rather than one dead label.
    if (avail.length > 1) {
      h += '<div class="tp-grp" style="display:flex;gap:10px;letter-spacing:1.4px">'
         + avail.map(function (s) {
             return '<span data-gk="' + s.k + '" style="cursor:pointer;color:'
                  + (s.k === active ? '#22d3ee' : 'var(--txt3,#8f8f8f)') + '">' + s.label + '</span>';
           }).join('')
         + '</div>';
    }
    h += '<div class="gk-wrap" style="position:relative;height:240px;margin-top:6px">'
       + '<canvas class="gk-cv" style="position:absolute;inset:0;width:100%;height:100%"></canvas></div>';
    el.innerHTML = h;

    /* Delegated and wired ONCE. refresh() re-runs every view on each poll and this rebuilds
       innerHTML, so a handler attached per draw would stack one listener per poll on a dashboard
       that is left open all day. */
    if (!el._gkWired) {
      el._gkWired = 1;
      el.addEventListener('click', function (e) {
        var t = e.target && e.target.getAttribute && e.target.getAttribute('data-gk');
        if (!t || t === GK_PICK) return;
        GK_PICK = t;
        drawGreeks(el, STATE);
      });
    }

    var drawn = gkPaint(el.querySelector('.gk-cv'), d0, active, cur.label);
    if (!drawn) {
      el.querySelector('.gk-wrap').innerHTML =
        '<div class="tp-empty">No strikes published for this reading yet.</div>';
    }
  }

  var DRAW = { history: drawHistory, flow: drawFlow, sweeps: drawSweeps, read: drawRead,
               wire: drawWire, structure: drawStructure, greeks: drawGreeks };

  function mount(sel, kind) {
    styles();
    var el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!el || !DRAW[kind]) return;
    el.classList.add('novo-tape');
    el.innerHTML = '<h2>' + esc(kind) + '</h2><div class="tp-empty">Reading the desk…</div>';
    MOUNTS.push([el, kind]);
    load().then(function (d) { DRAW[kind](el, d); });
    return true;
  }
  function refresh() {
    return load(true).then(function (d) {
      MOUNTS.forEach(function (m) { try { DRAW[m[1]](m[0], d); } catch (_e) {} });
      return d;
    });
  }
  /* A HOST MUST BE ABLE TO ASK. Trader's rail button is hidden until the greeks view exists,
     and without this the only way to find out was to mount into a detached div and inspect the
     result — which runs a real fetch and renders a real panel just to answer a yes/no. */
  function has(kind) { return !!(kind && DRAW[kind]); }

  /* ADOPT THE STATE THE HOST ALREADY HAS, instead of fetching a second copy of it.
     load() exists because a tab can open with nothing in hand. But analyst-live already polls
     /api/analyst-publish?live=1 every 15s and holds the identical payload, so a view mounted on
     its main surface would otherwise either issue a duplicate request per poll or sit stale
     between tab switches. Neither is acceptable for a panel that is always on screen.
     Pass the WHOLE payload, not a per-ticker slice — every view resolves its own ticker. */
  function adopt(state) {
    if (!state) return;
    STATE = state;
    MOUNTS.forEach(function (m) { try { DRAW[m[1]](m[0], STATE); } catch (_e) {} });
  }

  window.novoTape = { mount: mount, refresh: refresh, has: has, adopt: adopt };
})();
