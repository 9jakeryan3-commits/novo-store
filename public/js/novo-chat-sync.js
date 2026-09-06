/* novo-chat-sync.js — the conversation follows the MEMBER, not the browser.
 *
 * THE FLAW (Jake, 2026-09-06): the transcript lived in localStorage, which is one browser on one
 * device. Ask something on the desktop, open the same chat on your phone, and it is empty. The
 * product reads as one analyst at one desk right up until you pick up your phone.
 *
 * ⚠ WHY THIS IS ITS OWN FILE RATHER THAN THREE PATCHES. The chat exists in three places right now
 * — js/novo-chat.js (Trader), and inline copies in analyst-live.html and crypto-live.html. Writing
 * the sync into each would be the third time this session that one behaviour got three homes, and
 * the first two cost real money: the image bug was fixed twice by hand, and a rename double-applied
 * because two passes touched the same files. So the sync is written ONCE and the three chats call
 * it. Two lines each.
 *
 * THE SEAM IS localStorage, DELIBERATELY. Every chat already loads its transcript from there and
 * renders it. So this merges the server's copy INTO localStorage and then asks the page to re-read
 * — no rendering code is touched, no chat internals are reached into, and a chat that never calls
 * novoChatReload simply keeps working exactly as it did.
 *
 * ⚠ AND IT MUST NEVER COST THE CONVERSATION IN FRONT OF THE MEMBER. Every path here fails soft: no
 * token, no network, a 500, a malformed reply — all of them leave the local transcript untouched
 * and the chat behaving exactly as it did before this file existed. Continuity across devices is
 * worth having; it is not worth a blank panel when KV is down.
 */
(function () {
  if (window.novoChatSync) return;

  var ENDPOINT = '/api/chat-log';
  var PUSH_DEBOUNCE_MS = 1200;   // a turn lands, then its answer streams in — do not send twice
  var MAX_TURNS = 40;

  function tok() {
    try { var u = new URLSearchParams(location.search).get('t'); if (u) return u; } catch (_) {}
    try { return localStorage.getItem('novo_live_t') || ''; } catch (_) { return ''; }
  }

  /* Strip to what the server stores. The image thumbnail is dropped ON PURPOSE — a data URI runs to
     tens of kilobytes and forty of them would be megabytes written on every turn. It stays on the
     device that produced it, so a question asked with a screenshot reads as the question alone
     elsewhere. A real limit, named rather than discovered. */
  function wire(turns) {
    return (turns || []).map(function (m) {
      return { r: m.r === 'you' ? 'you' : 'novo', x: String(m.x == null ? '' : m.x), t: Number(m.t) || 0 };
    }).filter(function (m) { return m.x && m.t; });
  }

  /* Union by (timestamp, role, text). A merge cannot LOSE a turn — it can only show one you already
     had — which is the whole reason this is not last-write-wins. Two devices open at once is normal,
     and last-write-wins silently deletes whichever side was slower with nothing to tell the member. */
  function merge(a, b) {
    var seen = {}, out = [];
    [a || [], b || []].forEach(function (list) {
      list.forEach(function (m) {
        if (!m || !m.x || !m.t) return;
        var k = m.t + '|' + m.r + '|' + String(m.x).slice(0, 120);
        if (seen[k]) return;
        seen[k] = 1; out.push(m);
      });
    });
    out.sort(function (x, y) { return x.t - y.t; });
    return out.slice(-MAX_TURNS);
  }

  function readLocal(key) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return [];
      var o = JSON.parse(raw);
      return (o && Array.isArray(o.turns)) ? o.turns : [];
    } catch (_) { return []; }
  }

  function writeLocal(key, turns) {
    try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), turns: turns })); return true; }
    catch (_) { return false; }
  }

  var timers = {};

  window.novoChatSync = {
    /* Pull the server's copy, merge it under the page's own storage key, and tell the page to
       re-read. Returns true only if something actually changed — a caller must not repaint a log
       the member is reading for no reason. */
    pull: function (scope, key) {
      var t = tok();
      if (!t) return Promise.resolve(false);
      return fetch(ENDPOINT + '?scope=' + encodeURIComponent(scope) + '&t=' + encodeURIComponent(t))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || !d.ok || !Array.isArray(d.turns) || !d.turns.length) return false;
          var local = readLocal(key);
          var merged = merge(local, wire(d.turns));
          // Nothing new: leave the page alone rather than re-rendering an identical log.
          if (merged.length === local.length) return false;
          if (!writeLocal(key, merged)) return false;
          return true;
        })
        .catch(function () { return false; });   // offline is not an error the member should see
    },

    /* Debounced, because a question and its streamed answer are two saves a second apart and the
       server only needs the settled state. Fire-and-forget: a failed push costs continuity on the
       next device, never the conversation on this one. */
    push: function (scope, turns) {
      var t = tok();
      if (!t) return;
      clearTimeout(timers[scope]);
      var payload = wire(turns).slice(-MAX_TURNS);
      if (!payload.length) return;
      timers[scope] = setTimeout(function () {
        try {
          fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ t: t, scope: scope, turns: payload }),
            keepalive: true,      // survives the tab closing right after a question
          }).catch(function () {});
        } catch (_) {}
      }, PUSH_DEBOUNCE_MS);
    },
  };
})();
