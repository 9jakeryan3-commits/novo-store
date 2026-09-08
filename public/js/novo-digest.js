/* novo-digest.js — the Daily Digest suite: the mornings themselves, and the standing order.
 *
 * Jake, 2026-09-07: "we need a digest tab/page where you can manage your daily digest, a full
 * custom Daily Digest suite where it displays and gets managed."
 *
 * WHAT DISPLAYS: the last week of briefs, from the log api/daily-digest.js now writes before every
 * send. Until today the push notification WAS the artifact — 320 characters, dismissed once, gone —
 * so there was nothing a page could have shown. The page is also where a member goes when the ping
 * did not arrive, which is why the cron stores the brief whether or not delivery succeeded.
 *
 * WHAT GETS MANAGED: the standing order — what it covers, its focus line, where it pings — and
 * stopping it. CHANGING it stays a sentence to Dr. NoVo, the same rule the Alerts card follows and
 * for the same reason: the server validates symbols against live data and guards the focus line,
 * and a form that re-implements that drifts until the page saves an order the cron will not honour.
 * The "change" button opens the chat with the sentence already composed.
 *
 * PER-DASHBOARD, like everything except the chat (Jake's standing rule): the endpoint only returns
 * the digest to the app it was asked for on, so this card on any other dashboard truthfully says
 * no digest lives here.
 *
 * ⚠ Styles are injected from here and have no .css file — the novo-alerts.js trade. Tagged
 * data-novo-digest so it is findable from either direction.
 */
(function () {
  var CSS = [
    /* BOXES AND BORDERS ARE BANNED (Jake, 2026-09-07): no full boxes, hairline line-breaks only. */
    '.novo-digest{padding:4px 2px}',
    '.novo-digest h2{margin:0 0 12px;font-family:var(--mono,ui-monospace),monospace;font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--txt2,#a8a8a8)}',
    '.novo-digest .dg-sub{font-size:11px;font-weight:500;color:var(--txt3,#6e6e6e);letter-spacing:.06em;margin-left:8px;text-transform:none}',
    /* the standing order — a header block, not a box */
    '.novo-digest .dg-order{padding:2px 0 12px;border-bottom:1px solid var(--bdr2,#242428)}',
    '.novo-digest .dg-syms{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 7px}',
    '.novo-digest .dg-sym{font-family:var(--mono,ui-monospace),monospace;font-size:12px;font-weight:700;letter-spacing:.08em;color:var(--txt1,#f0f0ee)}',
    '.novo-digest .dg-sym + .dg-sym::before{content:"\u00b7  ";color:var(--txt3,#6e6e6e);font-weight:400}',
    '.novo-digest .dg-focus{font-size:12.5px;color:var(--txt2,#a8a8a8);font-style:italic;margin:0 0 7px}',
    '.novo-digest .dg-meta{display:block;font-family:var(--mono,ui-monospace),monospace;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--txt3,#6e6e6e)}',
    '.novo-digest .dg-actions{display:flex;gap:8px;margin-top:11px}',
    '.novo-digest .dg-btn{background:none;color:var(--txt2,#a8a8a8);border-radius:8px;font:inherit;font-size:11.5px;font-weight:700;padding:8px 12px;cursor:pointer;min-height:36px}',
    '.novo-digest .dg-btn:hover{color:var(--txt1,#f0f0ee)}',
    '.novo-digest .dg-btn.stop:hover{color:#f43f5e}',
    '.novo-digest .dg-btn[disabled]{opacity:.5;cursor:default}',
    /* the mornings — hairlines, never boxes */
    '.novo-digest .dg-day{padding:13px 0;border-top:1px solid var(--bdr2,#242428)}',
    '.novo-digest .dg-day:first-of-type{border-top:0}',
    '.novo-digest .dg-date{font-family:var(--mono,ui-monospace),monospace;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--txt3,#6e6e6e);margin-bottom:5px}',
    '.novo-digest .dg-text{font-size:13px;color:var(--txt2,#a8a8a8);line-height:1.65;white-space:pre-wrap}',
    '.novo-digest .dg-empty{font-size:13px;color:var(--txt2,#a8a8a8);line-height:1.6;padding:4px 0 2px}',
    '.novo-digest .dg-route{font-size:12.5px;line-height:1.55;padding:12px 0 0;margin:12px 0 0;border-top:1px solid var(--bdr2,#242428);color:#fbbf24}',
    '.novo-digest .dg-how{font-size:11.5px;color:var(--txt3,#6e6e6e);line-height:1.6;margin-top:14px;padding-top:12px;border-top:1px solid var(--bdr2,#242428)}',
    '.novo-digest .dg-how em{color:var(--txt2,#a8a8a8);font-style:normal}',
    '.novo-digest .dg-ask{display:inline-block;margin-top:9px;background:none;border:1px solid var(--bdr,#2c2c30);color:var(--txt1,#f0f0ee);border-radius:8px;font:inherit;font-size:12.5px;font-weight:700;padding:9px 14px;cursor:pointer;min-height:38px}',
    '.novo-digest .dg-ask:hover{border-color:var(--txt3,#6e6e6e)}'
  ].join('');

  function styles() {
    if (document.querySelector('style[data-novo-digest]')) return;
    var st = document.createElement('style');
    st.setAttribute('data-novo-digest', '1');
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  function tok() { try { return localStorage.getItem('novo_live_t') || ''; } catch (_) { return ''; } }
  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function day(ts) {
    try {
      return new Date(ts).toLocaleDateString('en-US',
        { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
    } catch (_) { return ''; }
  }

  var root, APP = null, EXAMPLE = 'Send me a daily digest on SPY and BTC — just tell me if gamma flipped.';

  /* Everything conversational goes THROUGH the chat, with the sentence composed. novoAsk exists on
     every dashboard; opening the panel first is each page's own concern, so the tab/panel opener is
     taken from mount opts. */
  function ask(q) {
    try { if (root && root._open) root._open(); } catch (_e) {}
    setTimeout(function () { try { window.novoAsk(q); } catch (_e) {} }, 250);
  }

  function render(d) {
    var dg = d && d.digest;
    var log = (d && d.digest_log) || [];

    if (!dg) {
      /* No digest managed HERE. Honest about the split rather than mute: one digest per member,
         owned by the dashboard it was asked for on. */
      root.innerHTML = '<h2>Daily digest</h2>'
        + '<div class="dg-empty">No digest set up on this dashboard. It arrives as a push every '
        + 'market morning at the time you choose, written just for you from the symbols you name'
        + ' &mdash; and it is managed on the dashboard you ask for it on.</div>'
        + '<button class="dg-ask" type="button" data-dg-ask="1">Ask Dr. NoVo to set one up</button>'
        + '<div class="dg-how">Say what it should cover &mdash; <em>&ldquo;' + esc(EXAMPLE) + '&rdquo;</em></div>';
      var ab = root.querySelector('[data-dg-ask]');
      if (ab) ab.onclick = function () { ask(EXAMPLE); };
      return;
    }

    /* THE MEMBER'S TIME, 12-hour for reading. It is stored 24-hour ET; a suite that prints
       "08:00" over a digest asked for at 6:30 is the hardcoding Jake just removed, one layer up. */
    var tm = (function (t) {
      var m = /^(\d{2}):(\d{2})$/.exec(t || ''); if (!m) return '8:00 AM';
      var hh = +m[1]; var ap = hh >= 12 ? 'PM' : 'AM'; hh = hh % 12 || 12;
      return hh + ':' + m[2] + ' ' + ap;
    })(dg.time);
    var h = '<h2>Daily digest <span class="dg-sub">every market morning · ' + esc(tm) + ' ET</span></h2>'
      + '<div class="dg-order">'
      + '<div class="dg-syms">' + (dg.symbols || []).map(function (x) {
          return '<span class="dg-sym">' + esc(x) + '</span>'; }).join('') + '</div>'
      + (dg.focus ? '<div class="dg-focus">&ldquo;' + esc(dg.focus) + '&rdquo;</div>' : '')
      + '<span class="dg-meta">pings from this dashboard'
      + (dg.set_utc ? ' · standing since ' + esc(day(dg.set_utc)) : '') + '</span>'
      + '<div class="dg-actions">'
      + '<button class="dg-btn" type="button" data-dg-change="1">Change what it covers</button>'
      + '<button class="dg-btn stop" type="button" data-dg-stop="1">Stop</button>'
      + '</div></div>';

    if (!log.length) {
      h += '<div class="dg-empty">Your first brief lands tomorrow at ' + esc(tm) + ' ET. Each morning is '
        + 'kept here for a week, whether or not the ping got through.</div>';
    } else {
      h += log.map(function (b) {
        return '<div class="dg-day"><div class="dg-date">' + esc(day(b.ts)) + '</div>'
          + '<div class="dg-text">' + esc(b.text || '') + '</div></div>';
      }).join('');
    }

    /* One warning, one remedy — same rule as the Alerts card: VAPID is the only channel. */
    if (!d.delivery) {
      h += '<div class="dg-route"><b>Nothing can reach you yet.</b> The mornings will be here, but '
        + 'no device is registered for the ping. Turn on <b>Live push alerts</b> in Settings.</div>';
    }
    h += '<div class="dg-how">Written from your symbols’ own live numbers &mdash; nothing it '
      + 'cannot source is ever in it. To change it, tell Dr. NoVo; to see it again, it is here.</div>';

    root.innerHTML = h;
    var cb = root.querySelector('[data-dg-change]');
    if (cb) cb.onclick = function () {
      ask('Change my daily digest — it currently covers ' + (dg.symbols || []).join(', ') + '.');
    };
    var sb = root.querySelector('[data-dg-stop]');
    if (sb) sb.onclick = async function () {
      sb.disabled = true; sb.textContent = 'Stopping…';
      try {
        var r = await fetch('/api/alerts', { method: 'POST', cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ t: tok(), digest: false, app: APP }) });
        var d2 = await r.json();
        if (!r.ok) throw new Error('stop failed');
        render(d2);            // the store's answer, never the click
      } catch (_e) { sb.disabled = false; sb.textContent = 'Stop'; }
    };
  }

  function fail(msg) {
    root.innerHTML = '<h2>Daily digest</h2><div class="dg-empty">' + esc(msg) + '</div>';
  }

  async function load() {
    if (!root) return;
    var t = tok();
    if (!t) return fail('Sign in on the dashboard to see your digest.');
    root.innerHTML = '<h2>Daily digest</h2><div class="dg-empty">Loading…</div>';
    try {
      var r = await fetch('/api/alerts?t=' + encodeURIComponent(t)
        + (APP ? '&app=' + encodeURIComponent(APP) : ''), { cache: 'no-store' });
      var d = await r.json();
      /* ⚠ A DEAD STORE NEVER RENDERS AS "no digest" — same law as the Alerts card, same reason. */
      if (!r.ok) return fail(r.status === 401
        ? 'Your session expired — reload the dashboard.'
        : 'Could not reach your digest just now. It is still running.');
      render(d);
    } catch (_e) {
      fail('Could not reach your digest just now. It is still running.');
    }
  }

  function mount(target, opts) {
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return null;
    styles();
    opts = opts || {};
    APP = opts.app || null;
    if (opts.example) EXAMPLE = opts.example;
    el.classList.add('novo-digest');
    root = el;
    if (opts.openChat) el._open = opts.openChat;
    load();
    return { load: load };
  }

  window.novoDigest = { mount: mount, load: load };
})();
