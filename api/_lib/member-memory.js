// api/_lib/member-memory.js — what NoVo remembers about a reader, across conversations.
//
// THE LINE THIS NEVER CROSSES: market interests and preferences only. The analyst reads
// markets, not accounts — so nothing position-shaped, money-shaped or P&L-shaped is stored,
// and the guard below refuses the obvious forms structurally rather than politely. The
// reader owns the memory: it exists because they told NoVo something, they can hear it back
// ("what do you know about me"), and they can clear it in one sentence.
//
// Storage: one small KV value per member, keyed by an email hash (the email itself never
// becomes a key), refreshed on every write, expiring after ~9 months untouched.

const crypto = require("crypto");
const { kv } = require("./../_kv.js");

const MAX_INTERESTS = 12;
const MAX_INTEREST_LEN = 40;
const MAX_NOTES = 8;
const MAX_NOTE_LEN = 160;
const TTL_S = 270 * 24 * 3600;

// ── THE DAILY DIGEST IS ITS OWN, EXPLICIT RECORD ──────────────────────────────────────────────
// Jake, 2026-09-07: "it will not go out unless the user tell NoVo they want it and tell him what
// they would like to know daily in thier digest. its a personal digest not a another cookie cutter
// market message."
//
// It used to key off `interests`, which is what NoVo LEARNED about a reader in conversation — so
// saying "I mostly trade SPY" once silently enrolled that reader in a daily push they never asked
// for, arriving on a device with no way to tell what it was. Interests are a memory; a digest is a
// standing request. They are now different fields because they are different consents.
//
// symbols drive the FACTS (same live-data path as before, so the grounding guard in
// api/daily-digest.js still refuses any number that is not in them). focus only steers EMPHASIS —
// it can never introduce a number, which is why free text is safe here at all.
const MAX_DIGEST_SYMBOLS = 6;
const MAX_FOCUS_LEN = 160;
// WHEN IT ARRIVES (Jake, 2026-09-07: "the digest is set to whatever time the user asks not
// hardcoded to 8am"). Stored as ET wall-clock "HH:MM" and honoured on the half hour — the cron
// runs every 30 minutes and rounds both clocks to the same bucket, so 7:15 lands at 7:00 and
// nobody is silently skipped for naming an odd minute. ET because every schedule in this product
// speaks ET; the model is told to convert.
const DIGEST_TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const DEFAULT_DIGEST_TIME = "08:00";

// HOW MUCH VOCABULARY THIS READER WANTS. Its own field rather than a free-text note, because the
// prompt has to branch on it deterministically and a note that happens to say "keep it simple" is
// a sentence, not a setting.
//   plain    - every term defined in place, analogies over jargon, no percentile-vs-history unless
//              asked. Same numbers and the same read; a smaller vocabulary.
//   standard - the default. Assumes the reader knows options basics.
//   desk     - assumes fluency; skips the definitions entirely.
// Never a different ANSWER, only a different vocabulary. A beginner gets the same call a pro does.
const LEVELS = ["plain", "standard", "desk"];

// Position/account-shaped content is refused at the write, whatever the model asked for.
const ACCOUNT_SHAPED = /\b(my (position|account|portfolio|p&?l|pnl|balance)|(bought|sold|holding|long|short)\s+\d|\d+\s*(shares|contracts)|stop\s*(loss)?\s*(at|@)|entry\s*(at|@)|\$\d{2,})\b/i;

// AND INSTRUCTION SHAPES. A note is rendered VERBATIM into the prompt, above MARKET DATA and above
// the question, and it persists for that reader indefinitely -- so a note is a durable instruction
// channel, not just a preference. The account regex above screens what the note is ABOUT; this
// screens what it TRIES TO DO. Bounded blast radius (a reader can only do this to their own
// answers) which is why it is a refusal rather than an alarm, but a stored "ignore your previous
// instructions" would ride every future prompt for that member until they cleared it.
const INSTRUCTION_SHAPED = /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|your\s+|the\s+|previous\s+|prior\s+)*(instruction|rule|prompt|guideline|boundary|system)|^\s*(you are|you must|you should always|from now on|act as|pretend|roleplay|new instructions?)\b|\bsystem\s*prompt\b|<\/?(system|instructions?)>/i;

const eh = (email) =>
  crypto.createHash("sha256").update(String(email || "").trim().toLowerCase())
    .digest("hex").slice(0, 16);

const _key = (email) => "mem:u:" + eh(email);

async function getMemory(email) {
  const r = kv();
  if (!r || !email) return null;
  let m = null;
  try { m = await r.get(_key(email)); } catch (_) { m = null; }
  if (typeof m === "string") { try { m = JSON.parse(m); } catch (_) { m = null; } }
  // A reader who has ONLY set a level has real memory — returning null there would drop the
  // setting on every read and silently undo it.
  // A reader who has ONLY a digest has real memory too — same reason the level check is here.
  if (!m || (!Array.isArray(m.interests) && !Array.isArray(m.notes) && !m.level && !m.digest)) return null;
  return { interests: m.interests || [], notes: m.notes || [],
           level: LEVELS.includes(m.level) ? m.level : null,
           digest: (m.digest && m.digest.on && Array.isArray(m.digest.symbols) && m.digest.symbols.length)
             ? { on: true, symbols: m.digest.symbols, focus: m.digest.focus || null,
                 set_utc: m.digest.set_utc || null, app: m.digest.app || null,
                 time: DIGEST_TIME_RE.test(m.digest.time || "") ? m.digest.time : DEFAULT_DIGEST_TIME }
             : null,
           updated: m.updated || null };
}

async function updateMemory(email, { add_interests, remove_interests, note, level, digest, clear } = {}) {
  const r = kv();
  if (!r || !email) return { error: "memory unavailable" };
  if (clear) {
    try { await r.del(_key(email)); } catch (_) {}
    return { ok: true, cleared: true };
  }
  const cur = (await getMemory(email)) || { interests: [], notes: [] };
  const clean = (s, n) => String(s || "").trim().replace(/\s+/g, " ").slice(0, n);
  const refused = [];

  for (const raw of Array.isArray(add_interests) ? add_interests : []) {
    const it = clean(raw, MAX_INTEREST_LEN);
    if (!it) continue;
    if (ACCOUNT_SHAPED.test(it)) { refused.push(it); continue; }
    if (!cur.interests.some((x) => x.toLowerCase() === it.toLowerCase())) {
      cur.interests.push(it);
    }
  }
  cur.interests = cur.interests.slice(-MAX_INTERESTS);

  for (const raw of Array.isArray(remove_interests) ? remove_interests : []) {
    const it = clean(raw, MAX_INTEREST_LEN).toLowerCase();
    cur.interests = cur.interests.filter((x) => x.toLowerCase() !== it);
  }

  if (note) {
    const nt = clean(note, MAX_NOTE_LEN);
    if (ACCOUNT_SHAPED.test(nt) || INSTRUCTION_SHAPED.test(nt)) refused.push(nt);
    else if (nt && !cur.notes.includes(nt)) cur.notes = [...cur.notes, nt].slice(-MAX_NOTES);
  }

  if (level !== undefined) {
    const lv = String(level || "").trim().toLowerCase();
    if (LEVELS.includes(lv)) cur.level = lv;
    else if (lv === "" || lv === "reset") delete cur.level;
  }

  // ── the digest ────────────────────────────────────────────────────────────────────────────
  // Off is one field; on requires SYMBOLS. "Send me a digest" with nothing named does not become a
  // digest about whatever NoVo happens to remember — that is the exact behaviour being removed.
  if (digest !== undefined) {
    if (!digest || digest.on === false) {
      delete cur.digest;
    } else {
      const syms = (Array.isArray(digest.symbols) ? digest.symbols : [])
        .map((x) => String(x || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, ""))
        .filter(Boolean)
        .filter((x, i, a) => a.indexOf(x) === i)
        .slice(0, MAX_DIGEST_SYMBOLS);
      if (!syms.length) {
        refused.push("a digest needs at least one symbol to be about");
      } else {
        let focus = clean(digest.focus, MAX_FOCUS_LEN) || null;
        // The focus line is rendered into the digest prompt, so it gets the SAME two guards a note
        // gets: one screens what it is about, the other what it tries to do. A stored "ignore your
        // instructions" here would ride every morning's generation for that member.
        if (focus && (ACCOUNT_SHAPED.test(focus) || INSTRUCTION_SHAPED.test(focus))) {
          refused.push(focus); focus = null;
        }
        // WHICH DASHBOARD ASKED FOR IT. Same rule as an alert: a digest set on the crypto map
        // pings from the crypto app, not from every app the member has a device on.
        const DAPPS = ["analyst", "crypto", "trader"];
        // The time THEY asked for. A malformed one is refused by name rather than silently
        // becoming 08:00 — "6.30" saved as the default would be a digest arriving at a time the
        // member never chose, from a request they watched succeed.
        let tm = String(digest.time || "").trim();
        if (tm && !DIGEST_TIME_RE.test(tm)) { refused.push("time must be HH:MM, 24-hour, ET"); tm = ""; }
        if (tm) tm = tm.length === 4 ? "0" + tm : tm;
        cur.digest = { on: true, symbols: syms, focus: focus, set_utc: Date.now(),
                       app: DAPPS.includes(digest.app) ? digest.app : null,
                       time: tm || DEFAULT_DIGEST_TIME };
      }
    }
  }

  cur.updated = Date.now();
  try {
    await r.set(_key(email), JSON.stringify(cur), { ex: TTL_S });
  } catch (e) {
    return { error: "could not save" };
  }
  const out = { ok: true, interests: cur.interests, notes: cur.notes, level: cur.level || null,
                digest: cur.digest || null };
  if (refused.length) {
    out.refused = refused;
    out.note = "position/account-shaped items are never stored - I read markets, not accounts";
  }
  return out;
}

// The digest cron walks this to find WHO TO CONSIDER — it is not a list of who gets one. Whether a
// member actually receives a digest is decided by their own `digest` record, in the cron.
// ⚠ THE COMMENT THAT USED TO BE HERE SAID "members who opted into a digest by having interests",
// which is exactly the false equivalence being removed: having interests was never a request for a
// daily push. Kept as a KV set of email hashes with a parallel hash->email map; the email is needed
// to mint their push lookup, nothing else.
async function indexMember(email) {
  const r = kv();
  if (!r || !email) return;
  try { await r.sadd("mem:index", eh(email)); } catch (_) {}
  try { await r.set("mem:e:" + eh(email), String(email).trim().toLowerCase(), { ex: TTL_S }); } catch (_) {}
}

module.exports = { getMemory, updateMemory, indexMember, eh, LEVELS };
