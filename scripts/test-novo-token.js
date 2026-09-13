/* Does NovoToken actually distinguish a dead session from a server fault?
 *
 * The whole fix rests on one decision -- clear, or keep -- so each branch is asserted against a
 * real token shape rather than a mock. Tokens are built the way api/analyst-publish.js builds
 * them: base64url(JSON).base64url(hmac). The signature is never checked client-side, so its
 * value is irrelevant here; what matters is that the payload parses and `x` is read correctly.
 */
'use strict';
const fs = require('fs');

// Minimal window: localStorage + atob, which is all the module touches.
const store = {};
const w = {
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
};
global.window = w;
new Function('window', fs.readFileSync('C:/Trading Algo/novo-store/public/js/novo-token.js', 'utf8'))(w);
const T = w.NovoToken;

const mint = (x) =>
  Buffer.from(JSON.stringify({ e: 'a@b.c', x })).toString('base64url') + '.sIgNaTuRe';

const DAY = 86400000;
let bad = 0;
const check = (name, ok, detail) => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name.padEnd(52) + (detail || ''));
  if (!ok) bad++;
};

// ── the two branches that matter ─────────────────────────────────────────────────────────────
const good = mint(Date.now() + 7 * DAY);
store[T.KEY] = good;
const clearedGood = T.onAuthFailure(good);
check('valid token: NOT cleared on a 401', clearedGood === 'transient' && store[T.KEY] === good,
      clearedGood === 'transient' ? 'server fault -- session kept' : '<-- this is the bug');

const dead = mint(Date.now() - DAY);
store[T.KEY] = dead;
const clearedDead = T.onAuthFailure(dead);
check('genuinely expired token: IS cleared', clearedDead === 'expired' && !(T.KEY in store),
      clearedDead === 'expired' ? 'real expiry -- sign in again' : '<-- would strand a dead session');

// ── the boundary, which decides behaviour at the exact moment of expiry ───────────────────────
check('expiry read back exactly', T.expiry(mint(1757000000000)) === 1757000000000);
check('expired() is false for a future x', T.onAuthFailure(mint(Date.now() + 1000)) === 'transient');
check('expired() is true for a past x', T.onAuthFailure(mint(Date.now() - 1000)) === 'expired');

/* ── FAIL CLOSED ON GARBAGE ────────────────────────────────────────────────────────────────────
   These four asserted the OPPOSITE until Yuri's argument changed the module, and the reason is
   worth keeping in the test rather than only in the source: the question is not "which error is
   worse" but "could retrying this ever succeed?"

     valid token, broken secret  -> retrying MAY start working  -> 'transient'
     token we cannot parse       -> retrying can NEVER work     -> 'expired'

   Calling garbage 'transient' loops forever behind a retry gate and never tells the member the
   one thing that would help, which is to sign in again. */
for (const [label, tok] of [
  ['garbage', 'not-a-token'],
  ['empty', ''],
  ['payload without x', Buffer.from(JSON.stringify({ e: 'a@b.c' })).toString('base64url') + '.s'],
  ['x not a number', Buffer.from(JSON.stringify({ x: 'soon' })).toString('base64url') + '.s'],
]) {
  store[T.KEY] = 'sentinel';
  const v = T.onAuthFailure(tok);
  check('unreadable (' + label + '): expired, not retried forever',
        v === 'expired' && !(T.KEY in store));
}

// ── the deliberate sign-out path still works ──────────────────────────────────────────────────
store[T.KEY] = 'x';
T.signOut();
check('signOut() still removes it', !(T.KEY in store));

// ── read/write round-trip ─────────────────────────────────────────────────────────────────────
T.set(good);
check('write/read round-trip', T.get() === good);

// ── NEGATIVE CONTROL: a naive implementation must FAIL the first assertion ───────────────────
const naive = { onAuthFailure: () => { delete store[T.KEY]; return true; } };
store[T.KEY] = good;
naive.onAuthFailure();
check('CONTROL: the old unconditional delete DOES destroy it', !(T.KEY in store),
      'so the first assertion is not vacuous');

console.log(bad ? '\n  ' + bad + ' FAILED' : '\n  all checks passed');
process.exit(bad ? 1 : 0);
