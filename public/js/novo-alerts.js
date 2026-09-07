/* novo-alerts.js — the reader's own alerts, listed and cancellable. One card, three dashboards.
 *
 * Jake, 2026-09-07: "we need an Alerts tab to self manage these alerts" ... "all 3 get this alerts
 * tab" ... "it is VAPID only ... pinged from the app only. redundant any other way."
 *
 * api/alerts.js is the whole contract. This renders it and nothing more.
 *
 * ⚠ THE DESCRIPTION IS THE SERVER'S SENTENCE, PRINTED VERBATIM. Every field needed to rebuild
 * "SPY above its call wall" is in the payload and it would be easy. _describe() in
 * api/_lib/alerts.js stays the only author of that sentence, or the chat and this card end up
 * describing the same alert two different ways the first time a new alert kind is added.
 *
 * ⚠ IT CANNOT CREATE ONE, DELIBERATELY. setAlert validates against the live crypto snapshot and
 * enforces the active cap; re-implementing that behind a form is how a page comes to save alerts
 * the evaluator will never fire. Creating stays a sentence to Dr. NoVo.
 *
 * ⚠ THE STYLES ARE INJECTED FROM HERE AND THEREFORE HAVE NO .css FILE. A file scan for these class
 * names finds nothing; a DOM scan finds them with no source. This is the same trade novo-chat.js
 * makes. The sheet is tagged data-novo-alerts so it can be found from either direction.
 */
(function () {
  var CSS = [
    /* BOXES AND BORDERS ARE BANNED (Jake, 2026-09-07): no full boxes, hairline line-breaks only. */
    '.novo-alerts{padding:4px 2px}',
    '.novo-alerts h2{margin:0 0 12px;font-family:var(--mono,ui-monospace),monospace;font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--txt2,#a8a8a8)}',
    '.novo-alerts .al-n{font-size:11px;font-weight:500;color:var(--txt3,#6e6e6e);letter-spacing:.06em;margin-left:8px;text-transform:none}',
    '.novo-alerts .al-route{font-size:12.5px;line-height:1.55;padding:10px 0;margin:0 0 4px;border-bottom:1px solid var(--bdr2,#242428);color:var(--txt2,#a8a8a8)}',
    '.novo-alerts .al-route.warn{color:#fbbf24}',
    '.novo-alerts .al-enable{display:inline-block;margin-top:9px;background:#f59e0b;color:#17150c;border:0;border-radius:8px;font:inherit;font-size:12.5px;font-weight:800;padding:9px 14px;cursor:pointer;min-height:38px}',
    '.novo-alerts .al-enable:hover{filter:brightness(1.06)}',
    '.novo-alerts .al-enable[disabled]{opacity:.6;cursor:default}',
    '.novo-alerts .al-row{display:flex;align-items:flex-start;gap:12px;padding:11px 0;border-top:1px solid var(--bdr2,#242428)}',
    '.novo-alerts .al-row:first-child{border-top:0}',
    '.novo-alerts .al-what{flex:1;min-width:0}',
    '.novo-alerts .al-what b{display:block;font-size:13.5px;color:var(--txt1,#f0f0ee);font-weight:700}',
    /* Both BLOCK. They are spans inside a span, so without this the note runs straight on from the
       meta line -- "20H LEFTwatching the sweep" -- which textContent is perfectly happy with. */
    '.novo-alerts .al-meta{display:block;font-family:var(--mono,ui-monospace),monospace;font-size:10.5px;color:var(--txt3,#6e6e6e);letter-spacing:.05em;text-transform:uppercase;margin-top:3px}',
    '.novo-alerts .al-note{display:block;font-size:12px;color:var(--txt2,#a8a8a8);margin-top:3px}',
    '.novo-alerts .al-x{flex:0 0 auto;background:none;border:1px solid var(--bdr,#2c2c30);color:var(--txt3,#6e6e6e);border-radius:8px;font:inherit;font-size:11.5px;font-weight:700;padding:7px 11px;cursor:pointer;min-height:34px}',
    '.novo-alerts .al-x:hover{border-color:#f43f5e;color:#f43f5e}',
    '.novo-alerts .al-x[disabled]{opacity:.5;cursor:default}',
    '.novo-alerts .al-empty{font-size:13px;color:var(--txt2,#a8a8a8);line-height:1.6;padding:4px 0 2px}',
    '.novo-alerts .al-how{font-size:11.5px;color:var(--txt3,#6e6e6e);line-height:1.6;margin-top:14px;padding-top:12px;border-top:1px solid var(--bdr2,#242428)}',
    '.novo-alerts .al-how em{color:var(--txt2,#a8a8a8);font-style:normal}'
  ].join('');

  function styles() {
    if (document.querySelector('style[data-novo-alerts]')) return;
    var st = document.createElement('style');
    st.setAttribute('data-novo-alerts', '1');
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function tok() { try { return localStorage.getItem('novo_live_t') || ''; } catch (_) { return ''; } }
  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  /* "168h left" is a machine's answer to "how long have I got". */
  function left(h) {
    if (h == null || !isFinite(h)) return '';
    if (h < 1) return 'under an hour left';
    if (h < 48) return h + 'h left';
    return Math.round(h / 24) + 'd left';
  }

  var box, route, count, hint, root, APP = null;

  function render(d) {
    var list = (d && d.active) || [];
    count.textContent = list.length ? list.length + ' of ' + (d.max_active || 10) : '';
    if (hint && d && d.max_active) hint.textContent = d.max_active;

    /* VAPID IS THE ONLY CHANNEL (Jake). No email fallback, no Discord alternative offered here --
       an alert is a ping from the app or it is nothing, and a second route would be a second thing
       to keep in step for no gain. So the warning has exactly one remedy and it is one tap. */
    if (list.length && !d.delivery) {
      route.hidden = false;
      route.className = 'al-route warn';
      route.innerHTML = '<b>Nothing can reach you yet.</b> These are saved and being watched, but no '
        + 'device is registered to receive them. Same push the dashboard’s own alerts use.'
        + (window.novoEnablePush
            ? '<div><button class="al-enable" type="button" data-al-push="1">Turn on push</button></div>'
            : '<div>Install this dashboard to your home screen, then turn on push.</div>');
      var eb = route.querySelector('[data-al-push]');
      if (eb) eb.onclick = async function () {
        eb.disabled = true; eb.textContent = 'Enabling…';
        var okp = false;
        try { okp = await window.novoEnablePush(); } catch (_e) { okp = false; }
        /* Re-read from the SERVER rather than assuming. The subscription only counts once
           ?push=subscribe has stored it at push:u:<hash>, and that is the same key the alerts
           endpoint reports from -- so the card can only claim a route once one provably exists. */
        if (okp) return load();
        eb.disabled = false; eb.textContent = 'Turn on push';
        route.insertAdjacentHTML('beforeend',
          '<div style="margin-top:8px">That did not go through — your browser may have blocked '
          + 'notifications for this site. Install it to your home screen first, then try again.</div>');
      };
    } else if (list.length) {
      route.hidden = false;
      route.className = 'al-route';
      route.textContent = 'Delivered by ' + d.delivery + '.';
    } else {
      route.hidden = true;
    }

    /* ⚠ THE DIGEST IS NOT SHOWN HERE. It briefly was, on 2026-09-07, and Jake moved it: a digest
       is a standing arrangement with NoVo, an alert is about the market, and they belong on
       different tabs. It is managed in /js/novo-desk.js, behind the Dr. NoVo tab's Help panel.
       The endpoint still returns it — this card just is not its home. */
    var dgHtml = '';

    if (!list.length) {
      box.innerHTML = '<div class="al-empty">Nothing being watched right now.</div>';
      return;
    }
    box.innerHTML = list.map(function (a) {
      var bits = [];
      if (a.recurring) bits.push(a.armed === false ? 'recurring · re-arming' : 'recurring');
      else if (a.kind !== 'crypto_block') bits.push('one-shot');
      var l = left(a.expires_in_h); if (l) bits.push(l);
      return '<div class="al-row" data-id="' + esc(a.id) + '">'
        + '<span class="al-what"><b>' + esc(a.alert) + '</b>'
        + (bits.length ? '<span class="al-meta">' + esc(bits.join(' · ')) + '</span>' : '')
        + (a.note ? '<span class="al-note">' + esc(a.note) + '</span>' : '')
        + '</span>'
        + '<button class="al-x" type="button" data-cancel="' + esc(a.id) + '" '
        + 'aria-label="Stop watching ' + esc(a.alert) + '">Stop</button></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-cancel]'), function (b) {
      b.onclick = function () { cancel(b.getAttribute('data-cancel'), b); };
    });
  }

  function fail(msg) {
    route.hidden = true;
    box.innerHTML = '<div class="al-empty">' + esc(msg) + '</div>';
  }

  async function load() {
    if (!box) return;
    var t = tok();
    if (!t) return fail('Sign in on the dashboard to see your alerts.');
    box.innerHTML = '<div class="al-empty">Loading…</div>';
    try {
      var r = await fetch('/api/alerts?t=' + encodeURIComponent(t)
        + (APP ? '&app=' + encodeURIComponent(APP) : ''), { cache: 'no-store' });
      var d = await r.json();
      /* ⚠ A FAILED READ MUST NOT RENDER AS "no alerts". The endpoint answers 503 when the store is
         unreachable, and an empty list is the most dangerous thing to show here: a member whose
         alerts are fine would be told they have none, and would go and make them all again. */
      if (!r.ok) return fail(r.status === 401
        ? 'Your session expired — reload the dashboard.'
        : 'Could not reach your alerts just now. They are still running.');
      render(d);
    } catch (_e) {
      fail('Could not reach your alerts just now. They are still running.');
    }
  }

  async function cancel(id, btn) {
    var t = tok(); if (!t) return;
    btn.disabled = true; btn.textContent = 'Stopping…';
    try {
      var r = await fetch('/api/alerts', { method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ t: t, cancel: id, app: APP }) });
      var d = await r.json();
      if (!r.ok) throw new Error('cancel failed');
      /* Re-rendered from the STORE's answer, never by removing the row locally: a row that vanishes
         because the click handler removed it looks identical whether the cancel landed or not. */
      render(d);
    } catch (_e) {
      btn.disabled = false; btn.textContent = 'Stop';
      route.hidden = false; route.className = 'al-route warn';
      route.textContent = 'That did not go through — the alert is still active. Try again.';
    }
  }

  function mount(target, opts) {
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return null;
    styles();
    opts = opts || {};
    /* WHICH DASHBOARD THIS CARD IS ON. Without it the endpoint returns every alert the member has
       across all three and the crypto map lists equity alerts it will never fire. */
    APP = opts.app || null;
    el.classList.add('novo-alerts');
    el.innerHTML =
      '<h2>Your alerts <span class="al-n"></span></h2>'
      + '<div class="al-route" hidden></div>'
      + '<div class="al-body"><div class="al-empty">Loading…</div></div>'
      + '<div class="al-how">Set one in a sentence — ask ' + esc(opts.who || 'Dr. NoVo')
      + ' <em>“' + esc(opts.example || 'ping me if SPY crosses its flip') + '”</em>. '
      + 'Alerts run until they fire or you stop them — up to <span class="al-max">10</span> at a time.</div>';
    root = el;
    box = el.querySelector('.al-body');
    route = el.querySelector('.al-route');
    count = el.querySelector('.al-n');
    hint = el.querySelector('.al-max');
    load();
    return { load: load };
  }

  window.novoAlerts = { mount: mount, load: load };
})();
