/* novo-desk.js — the Dr. NoVo tab's own panel: what he can do, and your standing arrangements.
 *
 * Jake, 2026-09-07: "the Dr. NoVo tab its own app in a sense that when you click that tab you can
 * manage your connection with NoVo schedule your daily digest (lands in Dr. NoVo tab, not alerts),
 * schedule alerts that do land on thr alerts tab, all that. the Dr. NoVo tab does need a help
 * button that opens and tells them all the features and things they can do with Dr. NoVo a button
 * next to the plain English button."
 *
 * TWO THINGS LIVE HERE, AND THE SPLIT IS JAKE'S:
 *   - the DIGEST is a standing arrangement with NoVo himself, so it is managed here.
 *   - ALERTS are about the market, so they stay on the Alerts tab. This panel only points at them.
 *
 * WHY THE FEATURE LIST IS TAPPABLE. Every capability below is reached by SAYING something, and a
 * list of things you could say is a worse version of a list of buttons that say them. Each row
 * sends its own example, so discovering a feature and using it are the same gesture.
 *
 * ⚠ Styles are injected from here and therefore have no .css file — same trade novo-chat.js and
 * novo-alerts.js make. The sheet is tagged data-novo-desk so it is findable from either direction.
 */
(function () {
  var CSS = [
    '#novo-desk{position:absolute;inset:0;z-index:8;display:none;flex-direction:column;background:var(--panel,#111113);overflow-y:auto;-webkit-overflow-scrolling:touch}',
    '#novo-desk.on{display:flex}',
    '#novo-desk .nd-hd{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--bdr2,#242428);position:sticky;top:0;background:var(--panel,#111113);z-index:1}',
    '#novo-desk .nd-hd b{font-size:15px;color:var(--txt1,#f0f0ee)}',
    '#novo-desk .nd-x{margin-left:auto;background:none;border:1px solid var(--bdr,#2c2c30);color:var(--txt2,#a8a8a8);border-radius:9px;font:inherit;font-size:12px;font-weight:700;padding:7px 12px;cursor:pointer;min-height:36px}',
    '#novo-desk .nd-x:hover{color:var(--txt1,#f0f0ee)}',
    '#novo-desk .nd-b{padding:14px 16px 26px}',
    '#novo-desk .nd-grp{font-family:var(--mono,ui-monospace),monospace;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--txt3,#8f8f8f);margin:26px 0 4px;padding-top:14px;border-top:1px solid var(--bdr2,#242428)}',
    '#novo-desk .nd-grp:first-child{margin-top:0;padding-top:0;border-top:0}',
    /* :first-child does not match the first HEADING, because an empty digest slot sits in front of
       it -- so the panel opened with a hairline hanging above "Reading the market", attached to
       nothing. Both cases are named: the slot empty, and the slot holding the digest group. */
    '#novo-desk .nd-b > [data-nd-digest]:empty + .nd-grp{margin-top:0;padding-top:0;border-top:0}',
    '#novo-desk [data-nd-digest] .nd-grp{margin-top:0;padding-top:0;border-top:0}',
    /* ⚠ NO BOX. Jake's standing rule for this product — "everything literally almost everything
       on the site and all 3 dashboard is boxed in box box box every where" — and I put a 1px
       border and an 11px radius on every row of a brand new panel. A list is separated by a
       HAIRLINE between its items, which is what .al-row in novo-alerts.js already does; the
       framing comes from the separator and the type, not from drawing a rectangle around each
       row. Press state carries the affordance instead of a permanent outline. */
    '#novo-desk .nd-row{display:block;width:100%;text-align:left;background:none;border:0;border-top:1px solid var(--bdr2,#242428);padding:13px 2px;cursor:pointer;font:inherit;min-height:44px}',
    '#novo-desk .nd-grp + .nd-row{border-top:0}',
    '#novo-desk .nd-row:active{background:rgba(255,255,255,.03)}',
    '@media (hover:hover){#novo-desk .nd-row:hover b{color:#fff}}',
    '#novo-desk .nd-row b{display:block;font-size:13.5px;color:var(--txt1,#f0f0ee);font-weight:700;margin-bottom:2px}',
    '#novo-desk .nd-row span{display:block;font-size:12px;color:var(--txt3,#8f8f8f);line-height:1.5}',
    '#novo-desk .nd-say{color:var(--txt2,#a8a8a8);font-style:italic}',
    '#novo-desk .nd-card{padding:13px 2px 4px}',
    '#novo-desk .nd-card b{display:block;font-size:13.5px;color:var(--txt1,#f0f0ee);margin-bottom:3px}',
    '#novo-desk .nd-meta{display:block;font-family:var(--mono,ui-monospace),monospace;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--txt3,#8f8f8f);margin-top:3px}',
    '#novo-desk .nd-note{display:block;font-size:12px;color:var(--txt2,#a8a8a8);margin-top:4px;line-height:1.5}',
    '#novo-desk .nd-stop{margin-top:10px;background:none;border:1px solid var(--bdr,#2c2c30);color:var(--txt3,#8f8f8f);border-radius:8px;font:inherit;font-size:11.5px;font-weight:700;padding:8px 12px;cursor:pointer;min-height:36px}',
    '#novo-desk .nd-stop:hover{border-color:#f43f5e;color:#f43f5e}',
    /* ⚠ NO SIZING HERE. The button carries the page's own .lvl class, the same one Plain English
       uses, so each dashboard styles it exactly like the control it sits beside -- which is what
       "a button next to the plain English button" means. A bespoke rule here made it 4px shorter
       than its neighbour on two of the three, which no state check would ever have noticed. */
    '#novo-ask-help:hover{color:#eaf3ff}'
  ].join('');

  /* Every row is something you can SAY. `say` is sent as-is, so what the row promises and what NoVo
     is actually asked are the same string — a description that drifts from its prompt is how a
     feature list becomes a lie. */
  var ROWS = [
    ['Reading the market', [
      ['Read the map right now', 'Where price sits against the levels, and what that implies.',
       'Read this map right now.'],
      ['Go deeper', 'The full desk report instead of the short answer.', 'Give me a deep read.'],
      ['What has this setup done before', 'The closest historical setups and how they resolved.',
       'What has a setup like this resolved to before?'],
    ]],
    ['Standing arrangements', [
      ['Watch a level for me', 'A one-off ping when a level breaks. Lands on the Alerts tab.',
       'Ping me if SPY crosses its flip.'],
      ['Brief me every morning', 'A short personal digest, at the time you pick, on what you name.',
       'Send me a daily digest on SPY and BTC at 7:30am — just tell me if gamma flipped.'],
    ]],
    ['How he talks to you', [
      ['Plain English', 'Every term defined as he goes. Same read, smaller vocabulary.',
       'Use plain English with me from now on.'],
      ['Remember something about me', 'Market interests and style only — never positions or P&L.',
       'Remember that I mostly trade IWM.'],
      ['What do you know about me', 'Hear it back, and correct it.', 'What do you know about me?'],
    ]],
    ['Keeping him honest', [
      ['His record', 'How his published calls actually scored.',
       'How accurate have your published calls been?'],
      ['Where this number came from', 'The source behind any figure he just used.',
       'Where did that number come from?'],
    ]],
  ];

  function styles() {
    if (document.querySelector('style[data-novo-desk]')) return;
    var st = document.createElement('style');
    st.setAttribute('data-novo-desk', '1');
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  function tok() { try { return localStorage.getItem('novo_live_t') || ''; } catch (_) { return ''; } }
  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  var panel = null;

  function build() {
    var host = document.getElementById('novo-ask');
    if (!host || document.getElementById('novo-desk')) return document.getElementById('novo-desk');
    styles();
    /* The chat panel is the positioning context. On every dashboard it is already fixed or
       absolutely placed, so inset:0 here covers exactly the chat and nothing else -- the composer
       and the tab bar stay where they are. */
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    var el = document.createElement('div');
    el.id = 'novo-desk';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'What Dr. NoVo can do');
    el.innerHTML =
      '<div class="nd-hd"><b>What Dr. NoVo can do</b>'
      + '<button class="nd-x" type="button" data-nd-close="1">Close</button></div>'
      + '<div class="nd-b"><div data-nd-digest></div>'
      + ROWS.map(function (g) {
          return '<div class="nd-grp">' + esc(g[0]) + '</div>'
            + g[1].map(function (r) {
                return '<button class="nd-row" type="button" data-say="' + esc(r[2]) + '">'
                  + '<b>' + esc(r[0]) + '</b><span>' + esc(r[1]) + '</span>'
                  + '<span class="nd-say">“' + esc(r[2]) + '”</span></button>';
              }).join('')
        }).join('')
      + '</div>';
    host.appendChild(el);
    el.querySelector('[data-nd-close]').onclick = function () { toggle(false); };
    Array.prototype.forEach.call(el.querySelectorAll('[data-say]'), function (b) {
      b.onclick = function () {
        var q = b.getAttribute('data-say');
        toggle(false);
        try { window.novoAsk(q); } catch (_e) {}
      };
    });
    panel = el;
    return el;
  }

  /* The digest, read from the same endpoint the Alerts tab uses. Shown HERE and not there, on
     Jake's split: a digest is an arrangement with NoVo, an alert is about the market. */
  async function loadDigest() {
    var slot = panel && panel.querySelector('[data-nd-digest]');
    if (!slot) return;
    var t = tok(); if (!t) { slot.innerHTML = ''; return; }
    var d = null;
    try {
      var r = await fetch('/api/alerts?t=' + encodeURIComponent(t), { cache: 'no-store' });
      if (!r.ok) { slot.innerHTML = ''; return; }   // a failed read says nothing, never "you have none"
      d = await r.json();
    } catch (_e) { slot.innerHTML = ''; return; }
    var dg = d && d.digest;
    if (!dg) { slot.innerHTML = ''; return; }
    slot.innerHTML = '<div class="nd-grp">Your daily digest</div>'
      + '<div class="nd-card"><b>Every morning at ' + esc((function (t) {
          var m = /^(\d{2}):(\d{2})$/.exec(t || ''); if (!m) return '8:00 AM';
          var hh = +m[1]; var ap = hh >= 12 ? 'PM' : 'AM'; hh = hh % 12 || 12;
          return hh + ':' + m[2] + ' ' + ap; })(dg.time)) + ' ET</b>'
      + '<span class="nd-meta">' + esc((dg.symbols || []).join(' · ')) + '</span>'
      + (dg.focus ? '<span class="nd-note">“' + esc(dg.focus) + '”</span>' : '')
      + '<button class="nd-stop" type="button" data-nd-stop="1">Stop the digest</button></div>';
    var sb = slot.querySelector('[data-nd-stop]');
    sb.onclick = async function () {
      sb.disabled = true; sb.textContent = 'Stopping…';
      try {
        var rr = await fetch('/api/alerts', { method: 'POST', cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ t: tok(), digest: false }) });
        if (!rr.ok) throw new Error('stop failed');
        loadDigest();          // re-read, never assume
      } catch (_e) { sb.disabled = false; sb.textContent = 'Stop the digest'; }
    };
  }

  function toggle(on) {
    var el = build(); if (!el) return;
    var want = (on === undefined) ? !el.classList.contains('on') : !!on;
    el.classList.toggle('on', want);
    var b = document.getElementById('novo-ask-help');
    if (b) b.setAttribute('aria-expanded', want ? 'true' : 'false');
    if (want) loadDigest();
  }

  window.novoDesk = { open: function () { toggle(true); }, close: function () { toggle(false); },
                      toggle: toggle, refresh: loadDigest };
  /* ⚠ DELEGATED, NOT BOUND. The trader dashboard MOUNTS its chat on demand — novoChatMount runs
     when the Dr. NoVo tab is first opened — so the button does not exist at DOMContentLoaded or at
     load. Binding to the element found no button there, the page rendered one anyway, and clicking
     it did nothing at all: present, correct-looking and inert. A document-level listener does not
     care when the markup arrives. */
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('#novo-ask-help');
    if (!b) return;
    e.preventDefault();
    toggle();
  });
})();
