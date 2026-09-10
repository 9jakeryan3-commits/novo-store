/* novo-predict.js — NoVo Unleashed: the prediction record, for comp seats.
 *
 * Jake, 2026-09-07: "Add a predictions tab/page (shows for comp seats only) that displays these
 * and there outcome with a score from each ones graded outcome and accuracy."
 *
 * WHAT THIS IS: NoVo's own record — open calls waiting on their horizon, graded calls with their
 * outcomes, and the score per kind. It is read-only on purpose: predictions are made in
 * conversation (or by NoVo himself) and grade themselves against the published numbers. Nothing
 * here edits a graded row; an editable record is not a record.
 *
 * COMP-GATED TWICE: the endpoint only includes `predictions` for comp seats (server-side, the same
 * gate the tools carry), and the TAB is hidden until the endpoint says comp:true. The page never
 * decides who is comp — it renders what the server admits to.
 *
 * ⚠ Styles injected, no .css file — the standing trade. Tagged data-novo-predict.
 */
(function () {
  var CSS = [
    /* BOXES AND BORDERS ARE BANNED (Jake, 2026-09-07): no full boxes, hairline line-breaks only. */
    '.novo-predict{padding:4px 2px}',
    '.novo-predict h2{margin:0 0 12px;font-family:var(--mono,ui-monospace),monospace;font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--txt2,#a8a8a8)}',
    '.novo-predict .pd-sub{font-size:11px;font-weight:500;color:var(--txt3,#6e6e6e);letter-spacing:.06em;margin-left:8px;text-transform:none}',
    /* the score row — the headline is the RECORD, not any single call */
    '.novo-predict .pd-score{display:flex;flex-wrap:wrap;gap:18px;padding:2px 0 12px;border-bottom:1px solid var(--bdr2,#242428)}',
    '.novo-predict .pd-cell .v{font-family:var(--mono,ui-monospace),monospace;font-size:20px;font-weight:700;color:var(--txt1,#f0f0ee)}',
    '.novo-predict .pd-cell .k{display:block;font-family:var(--mono,ui-monospace),monospace;font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--txt3,#6e6e6e);margin-top:2px}',
    '.novo-predict .pd-grp{font-family:var(--mono,ui-monospace),monospace;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--txt3,#6e6e6e);margin:16px 0 2px}',
    /* rows — hairlines, never boxes */
    '.novo-predict .pd-row{padding:12px 0;border-top:1px solid var(--bdr2,#242428)}',
    '.novo-predict .pd-grp + .pd-row{border-top:0}',
    '.novo-predict .pd-what{font-size:13.5px;color:var(--txt1,#f0f0ee);font-weight:700}',
    '.novo-predict .pd-meta{display:block;font-family:var(--mono,ui-monospace),monospace;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--txt3,#6e6e6e);margin-top:3px}',
    '.novo-predict .pd-thesis{display:block;font-size:12px;color:var(--txt2,#a8a8a8);margin-top:4px;line-height:1.5}',
    '.novo-predict .pd-hit{color:#34d399;font-weight:800}',
    '.novo-predict .pd-miss{color:#f43f5e;font-weight:800}',
    '.novo-predict .pd-empty{font-size:13px;color:var(--txt2,#a8a8a8);line-height:1.6;padding:4px 0 2px}',
    '.novo-predict .pd-how{font-size:11.5px;color:var(--txt3,#6e6e6e);line-height:1.6;margin-top:14px;padding-top:12px;border-top:1px solid var(--bdr2,#242428)}',
    /* the head-to-head: two columns and one hairline. No boxes. */
    '.novo-predict .pd-vs{display:flex;align-items:flex-end;gap:14px;padding:2px 0 14px;border-bottom:1px solid var(--bdr2,#242428)}',
    '.novo-predict .pd-vs-side{display:flex;flex-direction:column;gap:2px;flex:1 1 0}',
    '.novo-predict .pd-vs-k{font-family:var(--mono,ui-monospace),monospace;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--txt3,#6e6e6e)}',
    '.novo-predict .pd-vs-v{font-family:var(--mono,ui-monospace),monospace;font-size:26px;font-weight:800;color:var(--txt1,#f0f0ee);line-height:1;font-variant-numeric:tabular-nums}',
    '.novo-predict .pd-vs-n{font-family:var(--mono,ui-monospace),monospace;font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--txt3,#6e6e6e)}',
    '.novo-predict .pd-vs-mid{font-family:var(--mono,ui-monospace),monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--txt4,#555);padding-bottom:4px}',
    '.novo-predict .pd-vs-note{font-size:11.5px;color:var(--txt3,#6e6e6e);line-height:1.55;padding:10px 0 0}'
  ].join('');

  function styles() {
    if (document.querySelector('style[data-novo-predict]')) return;
    var st = document.createElement('style');
    st.setAttribute('data-novo-predict', '1');
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  function tok() { try { return localStorage.getItem('novo_live_t') || ''; } catch (_) { return ''; } }
  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function when(ts) {
    try {
      return new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York',
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';
    } catch (_) { return ''; }
  }
  function describe(p) {
    if (p.kind === 'close_at') return p.symbol + ' closes at ' + p.value;
    if (p.kind === 'open_at') return p.symbol + ' opens at ' + p.value;
    if (p.kind === 'level_touch') return p.symbol + ' touches ' + p.value;
    if (p.kind === 'trade_call') return (p.side === 'sell' ? 'Sell' : 'Buy') + ' ' + p.symbol + ' now';
    return p.symbol + ' ' + (p.side || '');
  }

  var root, APP = null;

  function render(d) {
    var pr = d && d.predictions;
    if (!pr) {
      root.innerHTML = '<h2>Predictions</h2><div class="pd-empty">This is a private desk surface.</div>';
      return;
    }
    var ov = pr.overall || {};
    /* ── TRADER vs DR. NOVO (Jake, 2026-09-07: "for a nice Trader vs Dr. NoVo setup"). The
       two records are only comparable because they are produced the same way: same validator,
       same grader, same tick, same published numbers. If a member's call were scored more
       leniently than his, this line would be a scoreboard of nothing. */
    var mineTop = d && d.my_predictions, mineOv = (mineTop && mineTop.overall) || {};
    var h = '<h2>Predictions <span class="pd-sub">you vs Dr. NoVo \u00b7 graded at the horizon</span></h2>'
      + '<div class="pd-vs">'
      + '<span class="pd-vs-side"><span class="pd-vs-k">You</span><span class="pd-vs-v">'
      + (mineOv.hit_rate != null ? esc(mineOv.hit_rate) + '%' : '\u2014')
      + '</span><span class="pd-vs-n">' + (mineOv.n || 0) + ' graded</span></span>'
      + '<span class="pd-vs-mid">vs</span>'
      + '<span class="pd-vs-side"><span class="pd-vs-k">Dr. NoVo</span><span class="pd-vs-v">'
      + (ov.hit_rate != null ? esc(ov.hit_rate) + '%' : '\u2014')
      + '</span><span class="pd-vs-n">' + (ov.n || 0) + ' graded</span></span></div>'
      /* Said once, plainly: a hit rate over four calls is not a hit rate. Without this the
         scoreboard flatters whichever side has made the fewest. */
      + (((mineOv.n || 0) < 10 || (ov.n || 0) < 10)
         ? '<div class="pd-vs-note">Early \u2014 neither side has enough graded calls for this '
           + 'to mean much yet. Ten each is where it starts being a comparison.</div>' : '')
      + '<div class="pd-grp">Dr. NoVo\u2019s calls</div>'
      + '<div class="pd-score">'
      + '<span class="pd-cell"><span class="v">' + (ov.hit_rate != null ? esc(ov.hit_rate) + '%' : '—')
      + '</span><span class="k">hit rate</span></span>'
      + '<span class="pd-cell"><span class="v">' + (ov.n || 0) + '</span><span class="k">graded</span></span>'
      + '<span class="pd-cell"><span class="v">' + (pr.open || []).length + '</span><span class="k">open</span></span>'
      + Object.keys(pr.score || {}).map(function (k) {
          var sc = pr.score[k];
          return '<span class="pd-cell"><span class="v">' + esc(sc.hit_rate) + '%'
            + (sc.avg_abs_error_pct != null ? ' · ±' + esc(sc.avg_abs_error_pct) + '%' : '')
            + '</span><span class="k">' + esc(k.replace(/_/g, ' ')) + ' · n=' + sc.n + '</span></span>';
        }).join('')
      + '</div>';

    var open = pr.open || [], graded = pr.graded || [];
    if (open.length) {
      h += '<div class="pd-grp">Open — waiting on the horizon</div>';
      h += open.map(function (p) {
        return '<div class="pd-row"><span class="pd-what">' + esc(describe(p)) + '</span>'
          + '<span class="pd-meta">made ' + esc(when(p.made_utc)) + ' at ' + esc(p.spot_at)
          + ' · grades ' + esc(when(p.horizon_utc))
          + (p.source === 'novo' ? ' · self-initiated' : '') + '</span>'
          + (p.thesis ? '<span class="pd-thesis">' + esc(p.thesis) + '</span>' : '')
          + '</div>';
      }).join('');
    }
    if (graded.length) {
      h += '<div class="pd-grp">Graded</div>';
      h += graded.map(function (p) {
        var o = p.outcome || {};
        return '<div class="pd-row"><span class="pd-what">' + esc(describe(p)) + ' → '
          + '<span class="' + (o.hit ? 'pd-hit' : 'pd-miss') + '">' + (o.hit ? 'HIT' : 'MISS') + '</span></span>'
          + '<span class="pd-meta">made ' + esc(when(p.made_utc)) + ' at ' + esc(p.spot_at)
          /* THE HORIZON IT WAS ACTUALLY GRADED AT (2026-09-08). Open rows have always shown
             "grades <when>"; graded rows dropped it, so the row displayed only the THESIS - and
             a thesis is prose. A call whose thesis said "a touch of $768 by lunch" while the
             recorded horizon was the opening bell rendered as a plain MISS with no way to see
             the two disagreed, which reads as a broken grader rather than a call graded early.
             The record has to state the window it was judged on, or the verdict is unauditable. */
          + ' · horizon ' + esc(when(p.horizon_utc))
          + ' · ' + (o.basis === 'session extreme' ? 'reached ' : 'actual ') + esc(o.actual)
          + (o.missed_by != null ? ' · missed by ' + esc(o.missed_by) : '')
          + (o.error_pct != null ? ' · off by ' + esc(Math.abs(o.error_pct)) + '%' : '') + '</span>'
          + (p.thesis ? '<span class="pd-thesis">' + esc(p.thesis) + '</span>' : '')
          + '</div>';
      }).join('');
    }
    /* ── THE MEMBER'S OWN BOOK (Jake, 2026-09-07: "almost paper trading"). Their calls sit
       beside NoVo's, scored the same way at the same moment - which is the comparison that makes
       the feature interesting. Their section renders even with nothing in it, because an empty
       record with an invitation is what tells them the feature exists at all. */
    var mine = d && d.my_predictions;
    var mineHtml = '';
    if (mine) {
      var mo = mine.open || [], mg = mine.graded || [], ov = mine.overall || {};
      mineHtml += '<div class="pd-grp">Your calls'
        + (ov.n ? ' · ' + esc(ov.hit_rate) + '% over ' + esc(ov.n) + ' graded' : '') + '</div>';
      if (mo.length || mg.length) {
        mineHtml += mo.map(function (p) {
          return '<div class="pd-row"><span class="pd-what">' + esc(describe(p)) + '</span>'
            + '<span class="pd-meta">made ' + esc(when(p.made_utc)) + ' at ' + esc(p.spot_at)
            + ' · grades ' + esc(when(p.horizon_utc)) + '</span>'
            + (p.thesis ? '<span class="pd-thesis">' + esc(p.thesis) + '</span>' : '') + '</div>';
        }).join('') + mg.map(function (p) {
          var o = p.outcome || {};
          return '<div class="pd-row"><span class="pd-what">' + esc(describe(p)) + ' → '
            + '<span class="' + (o.hit ? 'pd-hit' : 'pd-miss') + '">' + (o.hit ? 'HIT' : 'MISS')
            + '</span></span><span class="pd-meta">made ' + esc(when(p.made_utc)) + ' at '
            + esc(p.spot_at) + ' · actual ' + esc(o.actual) + '</span></div>';
        }).join('');
      } else {
        mineHtml += '<div class="pd-empty">Nothing on your record yet. Tell Dr. NoVo a call — '
          + '“I think SPY closes green” — and he logs it here, graded at its horizon '
          + 'on the same numbers his own calls are graded on.</div>';
      }
    }

    var voided = pr.void || [];
    if (voided.length) {
      h += '<div class="pd-grp">Void — could not be graded</div>';
      h += voided.map(function (p) {
        return '<div class="pd-row"><span class="pd-what">' + esc(describe(p))
          + ' → <span style="color:var(--txt3,#6e6e6e);font-weight:800">VOID</span></span>'
          + '<span class="pd-meta">' + esc((p.outcome && p.outcome.reason) || '') + '</span></div>';
      }).join('');
    }
    if (!open.length && !graded.length && !voided.length) {
      h += '<div class="pd-empty">Nothing on the record yet. Ask him what he thinks — any real '
        + 'prediction he makes goes on the record the moment he says it.</div>';
    }
    h += mineHtml;
    h += '<div class="pd-how">His own record, graded against the same published numbers everything '
      + 'else is graded on. Self-scored, and it says so. A stated prediction that is not recorded '
      + 'does not exist.</div>';
    root.innerHTML = h;
    try { window.novoSubtabs && window.novoSubtabs.apply(root, { marker: '.pd-grp', key: 'predict' }); } catch (_e) {}
  }

  function fail(msg) {
    root.innerHTML = '<h2>Predictions</h2><div class="pd-empty">' + esc(msg) + '</div>';
  }

  async function load() {
    if (!root) return;
    var t = tok();
    if (!t) return fail('Sign in on the dashboard.');
    root.innerHTML = '<h2>Predictions</h2><div class="pd-empty">Loading…</div>';
    try {
      var r = await fetch('/api/alerts?t=' + encodeURIComponent(t)
        + (APP ? '&app=' + encodeURIComponent(APP) : ''), { cache: 'no-store' });
      var d = await r.json();
      if (!r.ok) return fail('Could not reach the record just now.');
      render(d);
    } catch (_e) { fail('Could not reach the record just now.'); }
  }

  function mount(target, opts) {
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return null;
    styles();
    opts = opts || {};
    APP = opts.app || null;
    el.classList.add('novo-predict');
    root = el;
    load();
    return { load: load };
  }

  /* ── the tab reveal: hidden until the server says comp ────────────────────────────────────
     One cheap GET on load. The page never decides who is comp; it renders what the server admits
     to, and a non-comp member simply never sees the tab exist. */
  /* THE TAB IS OPEN TO EVERY SEAT NOW (Jake, 2026-09-07). What differs is the CONTENT: the
     endpoint hands a non-comp seat only the read-authored calls. Revealing on any answer rather
     than on comp:true is deliberate - the gate that matters is server-side, and a tab that hides
     itself was never the thing protecting his private calls. */
  async function reveal(selector) {
    try {
      const r = await fetch('/api/alerts?t=' + encodeURIComponent(tok()), { cache: 'no-store' });
      const d = r.ok ? await r.json() : null;
      if (!d || !d.ok) return false;
      document.querySelectorAll(selector).forEach((el) => el.removeAttribute('hidden'));
      return true;
    } catch (_) { return false; }
  }

  window.novoPredict = { mount: mount, load: load, reveal: reveal };
})();
