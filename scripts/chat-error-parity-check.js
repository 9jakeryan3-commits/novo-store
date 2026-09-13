/* chat-error-parity-check.js — the chat says the same thing when it fails, on all three surfaces.
 *
 * WHY. The chat exists in THREE hand-maintained copies — public/js/novo-chat.js (Trader),
 * public/analyst-live.html and public/crypto-live.html. novo-chat.js's own header says so and
 * calls it "a chat fix goes in three places and this comment is the reminder." A comment is a
 * mnemonic fix, and a mnemonic fix is the same failure with a note attached: it works until
 * somebody is moving fast, which is exactly when the third copy gets missed.
 *
 * chat-image-check.js guards only TWO of the three (its FILES list is analyst-live and
 * crypto-live), so a Trader-only divergence passes everything we own today.
 *
 * WHAT IT GUARDS. Every failure path a MEMBER can reach used to collapse to one string —
 * "Dr. NoVo is unavailable right now." — for three unrelated situations: the server replying with
 * nothing usable, the stream dropping mid-answer, and never reaching the server at all. Those need
 * three different actions from the reader, so they are three different messages now. This asserts
 * they stay three, stay distinct, and stay identical across the copies.
 *
 * SHOWN TO FAIL: change any one message in any one copy and the parity case goes red.
 *
 * Run: node scripts/chat-error-parity-check.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = ['public/js/novo-chat.js', 'public/analyst-live.html', 'public/crypto-live.html'];

// One per reachable failure path. Distinct text is the POINT, not a style preference.
const MESSAGES = {
  unusable: 'I came back with nothing usable there — ask me again.',
  dropped: "The connection dropped before I finished that answer. Nothing was saved — ask again and I'll start over.",
  unreachable: "I couldn't reach the desk just then. Check your connection and ask again — your question wasn't sent.",
};
const RETIRED = 'Dr. NoVo is unavailable right now';

const src = {};
for (const f of FILES) src[f] = fs.readFileSync(path.join(ROOT, f), 'utf8');

const T = [];
for (const f of FILES) {
  for (const [name, msg] of Object.entries(MESSAGES)) {
    T.push([`${path.basename(f)} carries the "${name}" message`, () => src[f].includes(msg)]);
  }
  T.push([`${path.basename(f)} no longer carries the retired catch-all`, () => !src[f].includes(RETIRED)]);
}
// The parity assertion proper: one copy drifting is the whole failure mode.
T.push(['all three copies agree on all three messages', () =>
  FILES.every((f) => Object.values(MESSAGES).every((m) => src[f].includes(m)))]);
// Three situations must not share one string again.
T.push(['the three messages are distinct from each other', () =>
  new Set(Object.values(MESSAGES)).size === 3]);
// Each says what to DO — the reason the generic one was a defect.
T.push(['every message tells the reader what to do next', () =>
  Object.values(MESSAGES).every((m) => /ask again|ask me again|check your connection/i.test(m))]);

/* ── RUNTIME STYLE PARITY ──────────────────────────────────────────────────────────────────────
   Widened 2026-09-12 beyond error copy, because the same three-copy drift was found in the chat's
   RUNTIME STYLES and nothing could see it: debox-check.js asserts against CSS files and markup,
   and these are strings assembled in JS. Measured that day — the debox pass had landed on
   analyst-live.html ONLY, while the Trader and Crypto copies still carried the full boxes it
   removed on three separate elements (the image thumbnail, the Checking line, the pill).

   novo-chat.js is chat-ONLY, so every style string in it must exist in both HTML copies. The HTML
   files legitimately carry others (page chrome), which is why the check is one-directional. */
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const styles = (f) => {
  const re = /cssText\s*=\s*(['"`])([\s\S]*?)\1/g;
  const out = []; let m;
  while ((m = re.exec(src[f]))) out.push(norm(m[2]));
  return out;
};
const TRADER = styles('public/js/novo-chat.js');
const IN_ANALYST = new Set(styles('public/analyst-live.html'));
const IN_CRYPTO = new Set(styles('public/crypto-live.html'));

T.push(['the chat module actually has runtime styles to compare', () => TRADER.length > 0]);
T.push(['every chat runtime style exists in analyst-live.html', () =>
  TRADER.every((s) => IN_ANALYST.has(s))]);
T.push(['every chat runtime style exists in crypto-live.html', () =>
  TRADER.every((s) => IN_CRYPTO.has(s))]);
/* The standing rule is hairlines only — a single-side separator stays, a four-sided box does not.
   `border:` with a width sets all four; `border-top:` and `border:0` are fine. */
T.push(['no chat runtime style builds a four-sided box', () =>
  TRADER.every((s) => !/(^|;)\s*border\s*:\s*[^;0]/.test(s))]);

let pass = 0;
for (const [name, fn] of T) {
  let ok = false, err = '';
  try { ok = !!fn(); } catch (e) { err = ' THREW ' + e.message; }
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + err);
  if (ok) pass++;
}
console.log('\n' + pass + '/' + T.length);
process.exit(pass === T.length ? 0 : 1);
