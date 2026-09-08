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
    '.novo-tape .tp-sub{display:block;font-size:11px;font-weight:500;color:var(--txt3,#6e6e6e);'
      + 'line-height:1.5;margin:0 0 14px;text-transform:none;letter-spacing:.02em}',
    '.novo-tape .tp-grp{font-family:var(--mono,ui-monospace),monospace;font-size:10px;'
      + 'letter-spacing:.16em;text-transform:uppercase;color:var(--txt3,#6e6e6e);margin:18px 0 2px;'
      + 'padding-top:14px;border-top:1px solid var(--bdr2,#242428)}',
    /* value rows — label left, number right, hairline between */
    '.novo-tape .tp-r{display:flex;align-items:baseline;justify-content:space-between;gap:12px;'
      + 'padding:11px 0;border-top:1px solid var(--bdr2,#242428)}',
    '.novo-tape .tp-grp + .tp-r{border-top:0}',
    '.novo-tape .tp-k{font-family:var(--mono,ui-monospace),monospace;font-size:10.5px;'
      + 'letter-spacing:.1em;text-transform:uppercase;color:var(--txt3,#6e6e6e)}',
    '.novo-tape .tp-v{font-family:var(--mono,ui-monospace),monospace;font-size:15px;font-weight:700;'
      + 'color:var(--txt1,#f0f0ee);font-variant-numeric:tabular-nums}',
    '.novo-tape .tp-s{display:block;font-size:11px;color:var(--txt3,#6e6e6e);margin-top:3px;line-height:1.45}',
    '.novo-tape .grn{color:#34d399}.novo-tape .red{color:#f43f5e}',
    /* the historical strip reads as prose, because it is a sentence about a sample */
    '.novo-tape .tp-claim{font-size:13.5px;color:var(--txt1,#f0f0ee);line-height:1.6;padding:12px 0;'
      + 'border-top:1px solid var(--bdr2,#242428)}',
    '.novo-tape .tp-grp + .tp-claim{border-top:0}',
    '.novo-tape .tp-claim b{font-family:var(--mono,ui-monospace),monospace;font-weight:800}',
    '.novo-tape .tp-meta{display:block;font-family:var(--mono,ui-monospace),monospace;font-size:10.5px;'
      + 'letter-spacing:.05em;text-transform:uppercase;color:var(--txt3,#6e6e6e);margin-top:5px}',
    /* the analogues table */
    '.novo-tape table{width:100%;border-collapse:collapse;font-size:12px}',
    '.novo-tape th{font-family:var(--mono,ui-monospace),monospace;font-size:9.5px;letter-spacing:.1em;'
      + 'text-transform:uppercase;color:var(--txt3,#6e6e6e);font-weight:700;text-align:right;padding:8px 0 8px 10px}',
    '.novo-tape th:first-child,.novo-tape td:first-child{text-align:left;padding-left:0}',
    '.novo-tape td{padding:9px 0 9px 10px;text-align:right;color:var(--txt2,#a8a8a8);'
      + 'border-top:1px solid var(--bdr2,#242428);font-variant-numeric:tabular-nums}',
    '.novo-tape .tp-wrap{overflow-x:auto}',
    '.novo-tape .tp-empty{font-size:13px;color:var(--txt2,#a8a8a8);line-height:1.6;padding:10px 0 2px}',
    '.novo-tape .tp-warn{font-size:12.5px;color:#fbbf24;line-height:1.6;padding:10px 0 2px}'
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
    PENDING = fetch('/api/analyst-publish?live=1&t=' + encodeURIComponent(tok()), { cache: 'no-store' })
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

    var a = (state && state.analogues_by && state.analogues_by[tk])
         || (tk === 'SPY' ? (state && state.analogues) : null);
    var rows = (a && a.rows) || (Array.isArray(a) ? a : []);
    h += '<div class="tp-grp">Today looks like…</div>';
    if (rows.length) {
      h += '<div class="tp-wrap"><table><thead><tr><th>Date</th><th>Match</th><th>Regime</th>'
         + '<th>15m</th><th>60m</th><th>Close</th></tr></thead><tbody>'
         + rows.slice(0, 12).map(function (r) {
             var cell = function (v) {
               if (v == null || v === '') return '<td>—</td>';
               var n = Number(v);
               if (!isFinite(n)) return '<td>' + esc(v) + '</td>';
               return '<td class="' + (n > 0 ? 'grn' : n < 0 ? 'red' : '') + '">'
                    + (n > 0 ? '+' : '') + n.toFixed(2) + '%</td>';
             };
             return '<tr><td>' + esc(r.date || r.d || '') + '</td>'
                  + '<td>' + (r.match != null ? esc(r.match) + '%' : '—') + '</td>'
                  + '<td>' + esc(r.regime || '') + '</td>'
                  + cell(r.m15 != null ? r.m15 : r.fwd15)
                  + cell(r.m60 != null ? r.m60 : r.fwd60)
                  + cell(r.close != null ? r.close : r.into_close) + '</tr>';
           }).join('') + '</tbody></table></div>';
    } else {
      h += '<div class="tp-empty">No close analogues for today’s shape yet.</div>';
    }
    el.innerHTML = h;
  }

  /* ── OPTIONS FLOW ─────────────────────────────────────────────────────────────────────────── */
  function drawFlow(el, state) {
    var d = forTicker(state), tk = ticker(state);
    var fl = d && d.flow;
    var h = '<h2>' + esc(tk) + ' · Options flow</h2>'
          + '<span class="tp-sub">Volume-based — call vs put DEMAND, not buy/sell prints. '
          + 'Chain volume does not say which side initiated, so this is crowding, never direction.</span>';
    if (!fl || fl.status !== 'ok') {
      h += '<div class="tp-empty">No flow read yet for ' + esc(tk) + '. This builds through the '
         + 'session and is absent before the first delta, not broken.</div>';
      el.innerHTML = h; return;
    }
    var lp = fl.lean_pct, lean = fl.lean;
    var leanTxt = lean === 'calls' ? ('Calls' + (lp != null ? ' ' + lp + '%' : ''))
                : lean === 'puts' ? ('Puts' + (lp != null ? ' ' + (100 - lp) + '%' : ''))
                : lean === 'balanced' ? 'Balanced' : 'Building…';
    var leanCls = lean === 'calls' ? 'grn' : lean === 'puts' ? 'red' : '';
    h += '<div class="tp-grp">Now</div>'
       + '<div class="tp-r"><span class="tp-k">Live lean<span class="tp-s">'
       + (lp != null ? 'flow, last ~60s' : 'first read — no delta yet') + '</span></span>'
       + '<span class="tp-v ' + leanCls + '">' + esc(leanTxt) + '</span></div>';
    var pc = fl.pc_ratio;
    h += '<div class="tp-r"><span class="tp-k">Put / call volume<span class="tp-s">day cumulative ratio</span></span>'
       + '<span class="tp-v ' + (pc != null ? (pc >= 1.2 ? 'red' : pc <= 0.7 ? 'grn' : '') : '') + '">'
       + (pc != null ? Number(pc).toFixed(2) : '—') + '</span></div>'
       + '<div class="tp-r"><span class="tp-k">Call volume<span class="tp-s">contracts today</span></span>'
       + '<span class="tp-v grn">' + num(fl.call_vol) + '</span></div>'
       + '<div class="tp-r"><span class="tp-k">Put volume<span class="tp-s">contracts today</span></span>'
       + '<span class="tp-v red">' + num(fl.put_vol) + '</span></div>';
    var w = fl.whales || [];
    if (w.length) {
      h += '<div class="tp-grp">Unusual volume</div>'
         + w.map(function (x) {
             return '<div class="tp-r"><span class="tp-k">' + esc(x.side || '') + ' '
                  + esc(x.strike != null ? x.strike : '') + '</span><span class="tp-v '
                  + (x.side === 'CALL' ? 'grn' : 'red') + '">' + num(x.vol || x.volume) + '</span></div>';
           }).join('');
    }
    el.innerHTML = h;
  }

  /* ── SWEEPS & BLOCKS ──────────────────────────────────────────────────────────────────────── */
  function drawSweeps(el, state) {
    var d = forTicker(state), tk = ticker(state);
    var t = d && d.tape_flow;
    var h = '<h2>' + esc(tk) + ' · Sweeps &amp; blocks</h2>'
          + '<span class="tp-sub">Live prints — aggressive multi-exchange sweeps and large block '
          + 'trades. Unlike the flow tab, these carry an aggressor side.</span>';
    if (!t) {
      /* THE ANALYST HIDES THIS PANEL WHEN THE TAPE IS ABSENT. A tab cannot hide itself, so it has
         to say WHICH absence this is - no feed at all, versus a feed that stopped. */
      h += '<div class="tp-warn">No print tape for ' + esc(tk) + '. This feed comes from a single '
         + 'venue and is not always present — an empty tab here means no feed, not a quiet tape.</div>';
      el.innerHTML = h; return;
    }
    if (t.stale) {
      h += '<div class="tp-warn">The print tape has stopped updating. What follows is the last thing '
         + 'it said, and it is old — a stale tape and a quiet tape are different facts.</div>';
    }
    var bias = t.sweep_bias || 'balanced', sc = Number(t.sweep_count) || 0;
    h += '<div class="tp-grp">Sweeps · last ~45m</div>'
       + '<div class="tp-r"><span class="tp-k">Sweep bias<span class="tp-s">'
       + (sc ? sc + ' sweep' + (sc === 1 ? '' : 's') : 'no sweeps yet') + '</span></span>'
       + '<span class="tp-v ' + (bias === 'bullish' ? 'grn' : bias === 'bearish' ? 'red' : '') + '">'
       + esc(bias.charAt(0).toUpperCase() + bias.slice(1)) + '</span></div>'
       + '<div class="tp-r"><span class="tp-k">Bullish<span class="tp-s">call-buys + put-sells</span></span>'
       + '<span class="tp-v grn">' + usd(t.call_sweep_prem) + '</span></div>'
       + '<div class="tp-r"><span class="tp-k">Bearish<span class="tp-s">put-buys + call-sells</span></span>'
       + '<span class="tp-v red">' + usd(t.put_sweep_prem) + '</span></div>';
    /* OPTION blocks and SHARE blocks are kept apart, exactly as the analyst keeps them: a $50K
       option block summed with a $2M share block is a number about nothing. */
    var bc = Number(t.block_count) || 0, ubc = Number(t.und_block_count) || 0;
    h += '<div class="tp-grp">Blocks</div>'
       + '<div class="tp-r"><span class="tp-k">Option blocks<span class="tp-s">'
       + (bc ? usd(t.block_notional) + ' premium' : 'large option prints') + '</span></span>'
       + '<span class="tp-v">' + (bc ? bc : '—') + '</span></div>'
       + '<div class="tp-r"><span class="tp-k">Share blocks<span class="tp-s">'
       + (ubc ? usd(t.und_block_notional) + ' notional' : 'large share prints') + '</span></span>'
       + '<span class="tp-v">' + (ubc ? ubc : '—') + '</span></div>';

    var prints = t.prints || t.rows || [];
    if (prints.length) {
      h += '<div class="tp-grp">The tape</div><div class="tp-wrap"><table><thead><tr>'
         + '<th>Time</th><th>Kind</th><th>Side</th><th>Size</th></tr></thead><tbody>'
         + prints.slice(0, 30).map(function (p) {
             var side = String(p.side || p.aggressor || '').toLowerCase();
             return '<tr><td>' + esc(p.time || p.t || '') + '</td>'
                  + '<td>' + esc(p.kind || p.type || '') + '</td>'
                  + '<td class="' + (side.indexOf('bull') >= 0 || side === 'buy' ? 'grn'
                                   : side.indexOf('bear') >= 0 || side === 'sell' ? 'red' : '') + '">'
                  + esc(p.side || p.aggressor || '—') + '</td>'
                  + '<td>' + esc(p.size != null ? num(p.size) : (p.prem != null ? usd(p.prem) : '—')) + '</td></tr>';
           }).join('') + '</tbody></table></div>';
    }
    el.innerHTML = h;
  }

  var DRAW = { history: drawHistory, flow: drawFlow, sweeps: drawSweeps };

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
  window.novoTape = { mount: mount, refresh: refresh };
})();
