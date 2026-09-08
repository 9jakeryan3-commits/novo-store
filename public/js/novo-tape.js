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
    /* 2-up stat block: hairline above each cell, one hairline between the columns, no boxes */
    '.novo-tape .tp-grid{display:grid;grid-template-columns:1fr 1fr}',
    '.novo-tape .tp-c{padding:13px 0 14px;border-top:1px solid var(--bdr2,#242428);min-width:0}',
    '.novo-tape .tp-c:nth-child(odd){padding-right:16px}',
    '.novo-tape .tp-c:nth-child(even){padding-left:16px;border-left:1px solid var(--bdr2,#242428)}',
    '.novo-tape .tp-ck{font-family:var(--mono,ui-monospace),monospace;font-size:10px;'
      + 'letter-spacing:.14em;text-transform:uppercase;color:var(--txt3,#6e6e6e)}',
    '.novo-tape .tp-cv{font-family:var(--mono,ui-monospace),monospace;font-size:19px;'
      + 'font-weight:800;color:var(--txt1,#f0f0ee);font-variant-numeric:tabular-nums;'
      + 'margin-top:5px;line-height:1.15;overflow-wrap:anywhere}',
    '.novo-tape .tp-cs{font-size:10.5px;color:var(--txt3,#6e6e6e);margin-top:5px;line-height:1.45}',
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
      + 'color:var(--txt3,#6e6e6e);font-variant-numeric:tabular-nums}',
    '.novo-tape .tf-s{font-family:var(--mono,ui-monospace),monospace;font-size:12.5px;'
      + 'font-weight:700;color:var(--txt2,#a8a8a8);min-width:0;overflow-wrap:anywhere}',
    '.novo-tape .tf-v{display:block;font-family:var(--font,inherit);font-size:10px;'
      + 'font-weight:500;color:var(--txt3,#6e6e6e);letter-spacing:.02em;margin-top:2px}',
    '.novo-tape .tf-n{font-family:var(--mono,ui-monospace),monospace;font-size:13px;'
      + 'font-weight:800;color:var(--txt1,#f0f0ee);font-variant-numeric:tabular-nums;text-align:right}',
    '.novo-tape .tf-raw .tf-s{font-weight:500}',
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
    '.novo-tape .tp-warn{font-size:12.5px;color:#fbbf24;line-height:1.6;padding:10px 0 2px}',
    '.novo-tape .tp-read{font-size:13.5px;color:var(--txt2,#a8a8a8);line-height:1.7;'
      + 'white-space:pre-wrap;overflow-wrap:anywhere;padding:10px 0 2px}',
    '.novo-tape .tp-fear{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding:10px 0 6px}',
    '.novo-tape .tp-fv{font-family:var(--mono,ui-monospace),monospace;font-size:21px;font-weight:800;'
      + 'color:var(--txt1,#f0f0ee);font-variant-numeric:tabular-nums}',
    '.novo-tape .tp-fp{font-family:var(--mono,ui-monospace),monospace;font-size:11px;color:var(--txt3,#6e6e6e);'
      + 'letter-spacing:.06em;text-transform:uppercase}',
    '.novo-tape .tp-ft{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;margin-left:auto}',
    '.novo-tape .tp-meter{position:relative;height:6px;border-radius:3px;'
      + 'background:linear-gradient(90deg,#10b981,#84cc16,#f59e0b,#f43f5e)}',
    '.novo-tape .tp-meter i{position:absolute;top:-3px;width:3px;height:12px;background:var(--txt1,#f0f0ee);'
      + 'border-radius:2px;transform:translateX(-1px)}',
    '.novo-tape .tp-scale{display:flex;justify-content:space-between;font-family:var(--mono,ui-monospace),monospace;'
      + 'font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--txt3,#6e6e6e);margin-top:5px}'
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
  }

  function drawRead(el, state) {
    var tk = ticker(state);
    var r = state && state.read;
    var h = '<h2>' + esc(tk) + ' · The read</h2>';
    if (r && r.text) {
      /* STALE IS LABELLED, NOT HIDDEN. When the payload falls back to the most recent archived
         read rather than today's, the analyst says so in the heading - and a read presented as
         today's when it is Friday's is the kind of quiet lie this product does not ship. */
      h += '<span class="tp-sub">' + (r.stale
            ? 'Latest read' + (r.dateLabel ? ' \u00b7 ' + esc(r.dateLabel) : '')
              + ' \u2014 today\u2019s has not published yet.'
            : 'Published today.') + '</span>'
        + '<div class="tp-grp">' + esc(r.title || 'Latest read') + '</div>'
        + '<div class="tp-read">' + esc(r.text) + '</div>';
    } else {
      h += '<span class="tp-sub">The Open, The Close and the Sunday Week Ahead land here as they '
        + 'publish.</span><div class="tp-empty">Next read publishes before the bell.</div>';
    }

    /* The gauge: value, percentile, and a marker on a calm-to-fear scale. Colour follows the
       SERVER's own bands so the pill text and its colour can never imply different severities. */
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
      h += '<div class="tp-grp">Fear gauge \u00b7 ' + esc(sym) + '</div>'
        + '<div class="tp-fear"><span class="tp-fv">' + esc(sym) + ' ' + val.toFixed(1) + '</span>'
        + '<span class="tp-fp">' + pct + 'th pct \u00b7 1yr</span>'
        + '<span class="tp-ft" style="color:' + col + '">' + esc(tag) + '</span></div>'
        + '<div class="tp-meter"><i style="left:' + pct + '%"></i></div>'
        + '<div class="tp-scale"><span>calm</span><span>fear</span></div>';
    }
    el.innerHTML = h;
  }

  var DRAW = { history: drawHistory, flow: drawFlow, sweeps: drawSweeps, read: drawRead };

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
