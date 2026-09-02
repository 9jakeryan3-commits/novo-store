// api/_lib/record-chain.js — the track record, kept instead of overwritten.
//
// WHAT WAS WRONG. `novo:track_record` was ONE key, `set` on every engine publish, with a 14-day
// TTL. Each publish destroyed the one before it. I verified the consequence directly: read the
// record, read it again hours later, and figures had moved — the earlier ones were gone, with no
// way to recover them and no way for anyone to tell they had ever been different.
//
// That is a problem for this product specifically, because the prompt tells NoVo his record is
// something he does not get to edit, and the site sells the record as the answer to "why should I
// believe you". Neither was true. A number quoted in copy on Monday could not be checked on
// Friday, and a claim that quietly stopped being cited left no trace of having been cited.
//
// WHAT THIS DOES. Every publish appends a link: the scored claim values, flattened, plus a SHA-256
// over the canonical payload, chained into the hash of the link before it. Reading the chain gives
// the record as it stood at any past publish. Recomputing the chain proves no earlier link has
// been altered since — because changing one link changes every hash after it.
//
// ⚠ WHAT THIS IS NOT. This is not tamper-proof and must never be described as such. The chain
// lives in the same KV this code writes, so whoever holds the credentials can rewrite the whole
// thing, consistently, and it will verify. What it actually buys is narrower and worth stating
// honestly: history that used to be destroyed is now kept, and a SILENT revision becomes a
// DETECTABLE one for anyone who wrote down a hash earlier — which now includes marketing copy,
// because a figure can cite the link it came from. Real immutability needs an anchor outside this
// system; the head hash is published so that is possible later without changing this format.
//
// Append happens only when the CONTENT changes. The engine republishes on a schedule and most
// publishes are identical; a link per publish would be noise with a storage bill.

const crypto = require("crypto");
const { sampleOf } = require("./record-reader.js");

const CHAIN_KEY = "novo:track_record:chain";
const MAX_LINKS = 730;          // ~2 years of daily publishes; trimmed from the tail
const GENESIS = "0".repeat(64); // prev-hash of the first link

/** Deterministic JSON: object keys sorted at every depth, so the same record always hashes alike. */
function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).sort()
    .filter((k) => v[k] !== undefined)
    .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
    .join(",") + "}";
}

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/**
 * The content hash, derived from data the link actually carries.
 *
 * This is the correction to my first version of this file, and the bug is worth keeping written
 * down because it verified GREEN. I stored `contentHash` and then checked only that
 * sha256(prev + contentHash) matched `hash` -- so the chain bound the DIGEST but never bound the
 * CLAIMS to it. Editing a stored z from -3.8 to +3.8 and re-running the verifier reported the
 * chain fully intact, because nothing ever recomputed the digest from the row it described. A
 * tamper-evidence check that cannot see a tampered value is worse than none: it is a green light
 * over an unread field. `payloadHash` is stored for the same reason -- so every input to this
 * function is present in the link and the whole thing can be recomputed from scratch.
 */
function contentHashOf(claims, payloadHash) {
  return sha256(canonical({ claims, payload: payloadHash }));
}

/**
 * The scored claims, flattened to one map of `SPY.flip_regime` -> the numbers behind it.
 * This is the part that has to survive: it is what the page prints, what copy quotes, and what
 * the lessons block puts in front of NoVo. The full payload is attested by its hash rather than
 * stored whole, because most of its bytes are prose that never changes.
 */
function flattenClaims(b) {
  const out = {};
  const put = (label, c) => {
    if (!c || typeof c !== "object") return;
    const row = {};
    for (const k of ["rate", "baseline", "z", "holds", "strength"]) {
      if (c[k] !== undefined && c[k] !== null) row[k] = c[k];
    }
    const n = sampleOf(c);          // one reader for the sample, so the chain and the page agree
    if (n) row.n = n;
    if (Object.keys(row).length) out[label] = row;
  };
  for (const [tk, claims] of Object.entries(b.tickers || {})) {
    if (!claims || typeof claims !== "object") continue;
    for (const [name, c] of Object.entries(claims)) put(`${tk}.${name}`, c);
  }
  for (const k of ["lean_record", "audit_record", "pulse_signal"]) if (b[k]) put(k, b[k]);
  return out;
}

/** The head link, or null. Best-effort: a chain read must never cost a publish. */
async function head(r) {
  try {
    const raw = await r.lrange(CHAIN_KEY, 0, 0);
    if (!raw || !raw.length) return null;
    return typeof raw[0] === "string" ? JSON.parse(raw[0]) : raw[0];
  } catch (_) { return null; }
}

/**
 * Append one link if the content moved. Returns {appended, hash, reason}.
 * NEVER throws: a chain failure must not reject the engine's publish — losing the append is
 * recoverable, losing the publish is not.
 */
async function appendLink(r, b, receivedAt) {
  try {
    if (!r) return { appended: false, reason: "kv unavailable" };
    const claims = flattenClaims(b);
    if (!Object.keys(claims).length) return { appended: false, reason: "no scored claims" };

    // `received` is stamped per write and would differ on every publish, so it is excluded from
    // the content hash -- otherwise "did anything change" is always yes and the chain is a log.
    const { received, ...rest } = b || {};
    const payloadHash = sha256(canonical(rest));
    const contentHash = contentHashOf(claims, payloadHash);

    const prevLink = await head(r);
    if (prevLink && prevLink.contentHash === contentHash) {
      return { appended: false, hash: prevLink.hash, reason: "unchanged" };
    }
    const prev = prevLink ? prevLink.hash : GENESIS;
    const link = {
      v: 1,
      ts: receivedAt,
      prev,
      payloadHash,          // stored so contentHash is RECOMPUTABLE, not merely asserted
      contentHash,
      hash: sha256(prev + contentHash),
      claims,
      generated: b.generated ?? null,
    };
    await r.lpush(CHAIN_KEY, JSON.stringify(link));
    try { await r.ltrim(CHAIN_KEY, 0, MAX_LINKS - 1); } catch (_) {}
    return { appended: true, hash: link.hash };
  } catch (e) {
    return { appended: false, reason: e.message };
  }
}

/** Newest-first links. */
async function readChain(r, limit = 60) {
  if (!r) return [];
  let raw = [];
  try { raw = await r.lrange(CHAIN_KEY, 0, Math.max(0, Math.min(limit, MAX_LINKS)) - 1); }
  catch (_) { return []; }
  return (raw || []).map((x) => { try { return typeof x === "string" ? JSON.parse(x) : x; } catch (_) { return null; } })
    .filter(Boolean);
}

/**
 * Recompute every link over the slice given. Reports each link's own integrity and whether it
 * links to the one after it. A slice cannot verify its OLDEST link's `prev` (the link it points
 * at may be beyond the slice), so that is reported as `unchecked` rather than passed silently.
 */
function verifyChain(links) {
  const problems = [];
  for (let i = 0; i < links.length; i++) {
    const L = links[i];
    // RECOMPUTE from the stored claims rather than trusting the stored digest -- see contentHashOf.
    const recomputed = contentHashOf(L.claims || {}, L.payloadHash);
    if (L.payloadHash !== undefined && recomputed !== L.contentHash) {
      problems.push({ ts: L.ts, hash: L.hash, problem: "the scored values do not match this record's own hash" });
    }
    if (sha256(String(L.prev) + String(L.contentHash)) !== L.hash) {
      problems.push({ ts: L.ts, hash: L.hash, problem: "hash does not match its own contents" });
    }
    const older = links[i + 1];                       // newest-first, so the next entry is older
    if (older && L.prev !== older.hash) {
      problems.push({ ts: L.ts, hash: L.hash, problem: "does not link to the record before it" });
    }
  }
  const oldest = links[links.length - 1];
  return {
    links: links.length,
    intact: problems.length === 0,
    head: links[0] ? links[0].hash : null,
    oldestPrevUnchecked: oldest ? oldest.prev !== GENESIS : false,
    problems,
  };
}

/** What moved between two links, by claim. The reason to keep history at all. */
function diffLinks(newer, older) {
  const changed = [], added = [], removed = [];
  const A = (newer && newer.claims) || {}, B = (older && older.claims) || {};
  for (const k of Object.keys(A)) {
    if (!(k in B)) { added.push(k); continue; }
    if (canonical(A[k]) !== canonical(B[k])) changed.push({ claim: k, from: B[k], to: A[k] });
  }
  for (const k of Object.keys(B)) if (!(k in A)) removed.push(k);
  return { changed, added, removed };
}

module.exports = {
  appendLink, readChain, verifyChain, diffLinks, flattenClaims, canonical, sha256, contentHashOf,
  CHAIN_KEY, MAX_LINKS, GENESIS,
};
