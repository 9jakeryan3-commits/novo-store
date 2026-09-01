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
  if (!m || (!Array.isArray(m.interests) && !Array.isArray(m.notes) && !m.level)) return null;
  return { interests: m.interests || [], notes: m.notes || [],
           level: LEVELS.includes(m.level) ? m.level : null, updated: m.updated || null };
}

async function updateMemory(email, { add_interests, remove_interests, note, level, clear } = {}) {
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
    if (ACCOUNT_SHAPED.test(nt)) refused.push(nt);
    else if (nt && !cur.notes.includes(nt)) cur.notes = [...cur.notes, nt].slice(-MAX_NOTES);
  }

  if (level !== undefined) {
    const lv = String(level || "").trim().toLowerCase();
    if (LEVELS.includes(lv)) cur.level = lv;
    else if (lv === "" || lv === "reset") delete cur.level;
  }

  cur.updated = Date.now();
  try {
    await r.set(_key(email), JSON.stringify(cur), { ex: TTL_S });
  } catch (e) {
    return { error: "could not save" };
  }
  const out = { ok: true, interests: cur.interests, notes: cur.notes, level: cur.level || null };
  if (refused.length) {
    out.refused = refused;
    out.note = "position/account-shaped items are never stored - I read markets, not accounts";
  }
  return out;
}

// The digest cron walks this to find who gets one. Kept as a KV set of email hashes with a
// parallel hash->email map ONLY for members who opted into a digest by having interests —
// the email is needed to mint their push lookup, nothing else.
async function indexMember(email) {
  const r = kv();
  if (!r || !email) return;
  try { await r.sadd("mem:index", eh(email)); } catch (_) {}
  try { await r.set("mem:e:" + eh(email), String(email).trim().toLowerCase(), { ex: TTL_S }); } catch (_) {}
}

module.exports = { getMemory, updateMemory, indexMember, eh, LEVELS };
