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
    '.novo-predict .pd-how{font-size:11.5px;color:var(--txt3,#6e6e6e);line-height:1.6;margin-top:14px;padding-top:12px;border-top:1px solid var(--bdr2,#242428)}'
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
    var h = '<h2>NoVo’s predictions <span class="pd-sub">self-scored · graded at the horizon</span></h2>'
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
          + ' · actual ' + esc(o.actual)
          + (o.error_pct != null ? ' · off by ' + esc(Math.abs(o.error_pct)) + '%' : '') + '</span>'
          + (p.thesis ? '<span class="pd-thesis">' + esc(p.thesis) + '</span>' : '')
          + '</div>';
      }).join('');
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
    h += '<div class="pd-how">His own record, graded against the same published numbers everything '
      + 'else is graded on. Self-scored, and it says so. A stated prediction that is not recorded '
      + 'does not exist.</div>';
    root.innerHTML = h;
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
  async function reveal(selector) {
    var t = tok(); if (!t) return;
    try {
      var r = await fetch('/api/alerts?t=' + encodeURIComponent(t)
        + (APP ? '&app=' + encodeURIComponent(APP) : ''), { cache: 'no-store' });
      if (!r.ok) return;
      var d = await r.json();
      if (d && d.comp === true) {
        var b = document.querySelector(selector);
        if (b) b.hidden = false;
      }
    } catch (_e) {}
  }

  window.novoPredict = { mount: mount, load: load, reveal: reveal };
})();
