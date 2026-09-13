/* novo-readings.js — LIVE READINGS for the equity dashboards: the strip and the page.
 *
 * Jake, 2026-09-07: "equities side needs the same live readings feature or similar as crypto, in
 * its own way the page and bar across the top like crypto has, reading from the Eye, and add the
 * Live Readings tab to mobile nav ... analyst would get the bar that crypto has and trader would
 * get a nav bar tab."
 *
 * TWO SURFACES, ONE FETCH. bar() paints the one-line strip (the analyst's entry point, the crypto
 * map's read strip in equity clothes); mount() paints the full list plus the Eye's forward
 * register (the tab). Both read the same in-memory snapshot, so the strip can never advertise a
 * reading the page does not have.
 *
 * WHAT A READING IS: descriptive, measured, ungraded. The claims, the sigmas and the samples are
 * all written by the engine — this file formats and NEVER derives. A number computed here would be
 * a second definition of what a reading means, and two definitions disagree eventually.
 *
 * ⚠ BOXES AND BORDERS ARE BANNED (Jake, 2026-09-07). Hairline rules and type hierarchy only —
 * including the strip, which on the crypto map is still a bordered card and is the surface that
 * got the rule written down.
 *
 * ⚠ Styles injected, no .css file — the standing trade. Tagged data-novo-readings.
 */
(function () {
  var CSS = [
    /* ── the strip: one line, and it must never be what makes the page scroll sideways.
       min-width:0 on the flexing child plus ellipsis, because the claim is written upstream and
       its length is not something this layout gets to assume. */
    '.novo-readbar[hidden]{display:none}',
    '.novo-readbar{display:flex;align-items:center;gap:11px;margin:0 0 14px;padding:0 0 11px;'
      + 'border-bottom:1px solid var(--bdr2,#242428);cursor:pointer;overflow:hidden;'
      + '-webkit-tap-highlight-color:transparent}',
    '.novo-readbar .rb-ico{flex:0 0 auto;font-size:13px;line-height:1;color:var(--acc,#34d399)}',
    '.novo-readbar .rb-body{flex:1 1 auto;min-width:0;max-width:100%}',
    '.novo-readbar .rb-line{display:block;width:100%;white-space:nowrap;overflow:hidden;'
      + 'text-overflow:ellipsis;font-size:12.5px;color:var(--txt2,#a8a8a8);line-height:1.55}',
    '.novo-readbar .rb-line + .rb-line{color:var(--txt3,#8f8f8f);font-size:11.5px}',
    '.novo-readbar .rb-t{font-family:var(--mono,ui-monospace),monospace;font-weight:700;color:var(--txt1,#f0f0ee)}',
    '.novo-readbar .rb-k{font-family:var(--mono,ui-monospace),monospace;font-size:9.5px;'
      + 'letter-spacing:.06em;text-transform:uppercase;color:var(--txt4,#7f7f89)}',
    '.novo-readbar .rb-more{flex:0 0 auto;font-family:var(--mono,ui-monospace),monospace;'
      + 'font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--acc,#34d399);white-space:nowrap}',
    '@media(max-width:768px){.novo-readbar .rb-line + .rb-line{display:none}}',
    /* ── the page */
    '.novo-readings{padding:4px 2px}',
    '.novo-readings h2{margin:0 0 12px;font-family:var(--mono,ui-monospace),monospace;font-size:11px;'
      + 'font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--txt2,#a8a8a8)}',
    '.novo-readings .rd-sub{font-size:11px;font-weight:500;color:var(--txt3,#8f8f8f);'
      + 'letter-spacing:.06em;margin-left:8px;text-transform:none}',
    '.novo-readings .rd-grp{font-family:var(--mono,ui-monospace),monospace;font-size:10px;'
      + 'letter-spacing:.16em;text-transform:uppercase;color:var(--txt3,#8f8f8f);margin:18px 0 2px;'
      + 'padding-top:14px;border-top:1px solid var(--bdr2,#242428)}',
    '.novo-readings .rd-row{padding:12px 0;border-top:1px solid var(--bdr2,#242428)}',
    '.novo-readings .rd-grp + .rd-row{border-top:0}',
    '.novo-readings .rd-claim{font-size:13.5px;color:var(--txt1,#f0f0ee);line-height:1.55}',
    '.novo-readings .rd-t{font-family:var(--mono,ui-monospace),monospace;font-weight:800}',
    '.novo-readings .rd-meta{display:block;font-family:var(--mono,ui-monospace),monospace;'
      + 'font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--txt3,#8f8f8f);margin-top:4px}',
    '.novo-readings .rd-fire{color:#34d399;font-weight:800}',
    '.novo-readings .rd-armed{color:var(--txt3,#8f8f8f);font-weight:800}',
    '.novo-readings .rd-unknown{color:#fbbf24;font-weight:800}',
    '.novo-readings .rd-empty{font-size:13px;color:var(--txt2,#a8a8a8);line-height:1.6;padding:4px 0 2px}',
    /* A fault notice, not decoration - amber and above the read, because the thing it is warning
       about is that what follows is NOT today's. Hairline on one side only, like every other
       separator on these surfaces. */
    '.novo-readings .rd-stale{font-size:12.5px;line-height:1.6;color:var(--amber,#f59e0b);'
      + 'padding:9px 0 10px;border-bottom:1px solid var(--bdr2,#242424);margin-bottom:12px}',
    '.novo-readings .rd-how{font-size:11.5px;color:var(--txt3,#8f8f8f);line-height:1.6;margin-top:16px;'
      + 'padding-top:12px;border-top:1px solid var(--bdr2,#242428)}'
  ].join('');

  var KINDLABEL = {
    gamma_regime: 'Gamma regime', wall_proximity: 'Wall', vol_state: 'Vol state',
    skew_state: 'Skew', squeeze_state: 'Squeeze', flow_tilt: 'Flow tilt'
  };

  function styles() {
    if (document.querySelector('style[data-novo-readings]')) return;
    var st = document.createElement('style');
    st.setAttribute('data-novo-readings', '1');
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  function tok() { try { return localStorage.getItem('novo_live_t') || ''; } catch (_) { return ''; } }
  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  /* Age, never implied currency. A reading generated from a Friday row and shown on a Monday is
     history and must read as history — the strip says how old, the same way the crypto feed does. */
  function ago(ts) {
    var t = Date.parse(ts || '');
    if (!t) return '';
    var m = Math.max(0, Math.round((Date.now() - t) / 60000));
    return m < 1 ? 'just now' : m < 60 ? m + 'm ago'
      : m < 2880 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago';
  }

  var DATA = null, PENDING = null, BARS = [], PAGES = [];

  function load(force) {
    if (DATA && !force) return Promise.resolve(DATA);
    if (PENDING) return PENDING;
    PENDING = fetch('/api/eye-readings?t=' + encodeURIComponent(tok()), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { ok: false, live: false }; })
      .catch(function () { return { ok: false, live: false }; })
      .then(function (d) { DATA = d; PENDING = null; return d; });
    return PENDING;
  }

  function drawBar(el, d) {
    var rs = (d && d.readings) || [];
    // Nothing to say = say nothing. An empty strip is better than a strip announcing its own
    // emptiness at the top of every page load.
    if (!d || !d.live || !rs.length) { el.hidden = true; return; }
    el.hidden = false;
    var lines = rs.slice(0, 2).map(function (r) {
      return '<span class="rb-line"><span class="rb-t">' + esc(r.ticker) + '</span> '
        + '<span class="rb-k">' + esc(KINDLABEL[r.kind] || r.kind) + '</span> &middot; '
        + esc(r.claim || '')
        + ' <span style="color:var(--txt4,#7f7f89)">&middot; ' + esc(ago(r.ts_utc)) + '</span></span>';
    }).join('');
    el.innerHTML = '<span class="rb-ico">◈</span><span class="rb-body">' + lines + '</span>'
      + '<span class="rb-more">' + rs.length + ' reading' + (rs.length === 1 ? '' : 's')
      + ' &rsaquo;</span>';
  }

  function drawPage(el, d) {
    var rs = (d && d.readings) || [], rules = (d && d.rules) || [];
    var h = '<h2>Live Reads <span class="rd-sub">what the Eye is seeing · descriptive, not calls</span></h2>';
    if (!d || !d.live) {
      // The distinction the endpoint fought to keep: a dead publisher and a quiet market look
      // identical on screen unless the page says which one it is.
      h += '<div class="rd-empty">The Eye has not published readings recently. This is a gap in the '
        + 'feed, not a quiet market — the difference matters, so the page says which.</div>';
      el.innerHTML = h;
      try { window.novoSubtabs && window.novoSubtabs.apply(el, { marker: '.rd-grp', key: 'readings' }); } catch (_e) {}
      return;
    }
    if (rs.length) {
      var byT = {};
      rs.forEach(function (r) { (byT[r.ticker] = byT[r.ticker] || []).push(r); });
      Object.keys(byT).forEach(function (t) {
        h += '<div class="rd-grp">' + esc(t) + '</div>';
        h += byT[t].map(function (r) {
          var f = r.features || {};
          var bits = Object.keys(f).filter(function (k) { return f[k] != null; })
            .map(function (k) { return k.replace(/_/g, ' ') + ' ' + f[k]; }).join(' · ');
          return '<div class="rd-row"><span class="rd-claim">' + esc(r.claim || '') + '</span>'
            + '<span class="rd-meta">' + esc(KINDLABEL[r.kind] || r.kind) + ' · '
            + esc(ago(r.ts_utc)) + (bits ? ' · ' + esc(bits) : '') + '</span></div>';
        }).join('');
      });
    } else {
      h += '<div class="rd-empty">Nothing cleared the bar this pass. The readings are a fixed set '
        + 'of measured conditions, so a quiet book genuinely produces none — that is the '
        + 'difference between a readout and a feed that always has something to say.</div>';
    }
    if (rules.length) {
      h += '<div class="rd-grp">The forward register · what the Eye is watching</div>';
      h += rules.map(function (r) {
        // Three states, three renderings. "Not firing" and "cannot tell" are different facts:
        // a rule whose feature is missing from the grid is not a rule that is quiet.
        var state = r.firing === true
          ? '<span class="rd-fire">FIRING</span>'
          : r.firing === false ? '<span class="rd-armed">armed</span>'
          : '<span class="rd-unknown">no reading</span>';
        return '<div class="rd-row"><span class="rd-claim"><span class="rd-t">' + esc(r.rule)
          + '</span> — ' + state + '</span><span class="rd-meta">' + esc(r.ticker) + ' · '
          + esc(r.feature) + ' ' + esc(r.op === 'gt' ? '>' : '<') + ' ' + esc(r.threshold)
          + (r.value != null ? ' · now ' + esc(r.value) : ' · no live value')
          + (r.direction ? ' · ' + esc(r.direction) : '')
          + (r.since ? ' · registered ' + esc(String(r.since).slice(0, 16)) : '')
          + '</span></div>';
      }).join('');
    }
    h += '<div class="rd-how">Live Reads describe what the dealer book is doing right now, with the '
      + 'measurement and the sample each one rests on. They are not predictions and they are not '
      + 'calls — nothing here is graded. The Eye’s registered rules are pre-declared: a '
      + 'rule is written down before it fires, so its record starts the day it was registered '
      + 'rather than the day it looked good.'
      + (d.as_of ? ' Published ' + esc(ago(d.as_of)) + '.' : '') + '</div>';
    el.innerHTML = h;
    try { window.novoSubtabs && window.novoSubtabs.apply(el, { marker: '.rd-grp', key: 'readings' }); } catch (_e) {}
  }

  function bar(sel) {
    styles();
    var el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!el) return;
    el.classList.add('novo-readbar');
    el.hidden = true;
    BARS.push(el);
    el.addEventListener('click', function () {
      // The strip is the entry point to the tab, exactly as the crypto strip opens its feed.
      if (window.novoReadings && typeof window.novoReadings.open === 'function') window.novoReadings.open();
    });
    load().then(function (d) { drawBar(el, d); });
  }

  function mount(sel) {
    styles();
    var el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!el) return;
    el.classList.add('novo-readings');
    PAGES.push(el);
    el.innerHTML = '<h2>Live Reads</h2><div class="rd-empty">Reading the Eye…</div>';
    load().then(function (d) { drawPage(el, d); });
  }

  function refresh() {
    return load(true).then(function (d) {
      BARS.forEach(function (e) { drawBar(e, d); });
      PAGES.forEach(function (e) { drawPage(e, d); });
      return d;
    });
  }

  /* ── THE DAILY CRYPTO RUNDOWN ─────────────────────────────────────────────────────────────
     Jake, 2026-09-07: "crypto gets one a day every day a Daily Crypto Rundown with a
     bitcoin/crypto market bias for the day. thats another thing we can grade and score."
     Authored by Dr. NoVo through the same brain as every other analysis output, and its bias is
     recorded as an ordinary prediction — so the record shown here is the SAME record the Predict
     tab shows, not a second tally that could disagree with it. */
  var CRYPTO_CSS = [
    '.novo-rundown .rd-bias{font-family:var(--mono,ui-monospace),monospace;font-size:12px;'
      + 'font-weight:800;letter-spacing:.14em;text-transform:uppercase;margin-left:10px}',
    '.novo-rundown .rd-body{font-size:14px;color:var(--txt1,#f0f0ee);line-height:1.75;'
      + 'white-space:pre-wrap;overflow-wrap:anywhere;padding:12px 0 2px}',
    '.novo-rundown .rd-rec{font-size:12px;color:var(--txt3,#8f8f8f);line-height:1.6;margin-top:16px;'
      + 'padding-top:12px;border-top:1px solid var(--bdr2,#242428)}'
  ].join('');
  var BIAS_C = { BULLISH: '#34d399', BEARISH: '#f43f5e', NEUTRAL: 'var(--txt3,#8f8f8f)' };

  function mountCrypto(sel) {
    styles();
    if (!document.querySelector('style[data-novo-rundown]')) {
      var st = document.createElement('style');
      st.setAttribute('data-novo-rundown', '1');
      st.textContent = CRYPTO_CSS;
      document.head.appendChild(st);
    }
    var el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!el) return;
    el.classList.add('novo-readings', 'novo-rundown');
    el.innerHTML = '<h2>Daily rundown</h2><div class="rd-empty">Reading…</div>';
    fetch('/api/eye-readings?crypto=1&t=' + encodeURIComponent(tok()), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (d) {
        if (!d || !d.live) {
          /* A day with no rundown is a FAULT, not a quiet market - it runs on a schedule. Saying
             which one it is costs a sentence and saves an hour of wondering. */
          el.innerHTML = '<h2>Daily rundown</h2><div class="rd-empty">No rundown published yet '
            + 'today. This is written once a day on a schedule, so an empty page late in the day '
            + 'means it did not run — not that there was nothing to say.</div>';
          return;
        }
        var rd = d.read || {};
        var b = rd.bias || '';
        /* The read is still shown - it is real, it was written, and yesterday's structure is worth
           reading. What changes is that the page stops implying it is today's. */
        var h = '<h2>Daily rundown <span class="rd-sub">Dr. NoVo · ' + esc(rd.day || '') + '</span></h2>'
          + (d.stale ? '<div class="rd-stale"><b>This is not today\u2019s rundown.</b> It was '
              + 'written on ' + esc(rd.day || 'an earlier day') + ' and today\u2019s has not run. '
              + 'The read below still stands as of that date &mdash; it is the schedule that '
              + 'failed, not the analysis.</div>' : '')
          + '<div class="rd-grp">BTC bias'
          + (b ? '<span class="rd-bias" style="color:' + (BIAS_C[b] || 'var(--txt3)') + '">'
                 + esc(b) + '</span>' : '') + '</div>'
          + '<div class="rd-body">' + esc(rd.text || '') + '</div>';
        var dirScore = d.score && d.score.direction;
        h += '<div class="rd-rec">';
        if (b === 'NEUTRAL') {
          /* The band is MEASURED and stated, because a neutral graded against an unstated
             threshold is a call the reader cannot check. */
          h += 'A neutral is graded too: it is right if BTC stays inside \u00b10.73% over 24 '
            + 'hours \u2014 the 33.3rd percentile of its own daily moves over five years, set '
            + 'there so being right about flat is exactly as hard as being right about up. ';
        } else if (b) {
          h += 'This bias was recorded as a prediction the moment it was written, and grades '
            + 'against BTC 24 hours later. ';
        }
        if (dirScore) {
          h += 'His directional crypto calls: <b>' + esc(dirScore.hit_rate) + '%</b> over '
            + esc(dirScore.n) + ' graded.';
        } else {
          h += 'No graded directional crypto calls yet — the record starts with the first one to '
            + 'reach its horizon.';
        }
        h += '</div>';
        el.innerHTML = h;
      });
    return true;
  }

  window.novoReadings = { bar: bar, mount: mount, refresh: refresh, load: load,
                          mountCrypto: mountCrypto };
})();
