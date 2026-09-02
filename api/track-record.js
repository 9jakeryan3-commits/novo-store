// api/track-record.js — NoVo's audited track record.
//
// The engine scores NoVo's own published claims against its own logged dealer history and POSTs
// the result here; this serves it publicly. It is an AGGREGATE of past sessions — hit rates,
// medians and sample sizes — never a live level, so it carries none of the dealer map's value
// and is safe on a free page. No third-party data is involved at all: NoVo's claims, NoVo's log.
//
// The reason this exists: nothing in the category publishes a track record, which is a large part
// of why the category gets called a grift. Publishing a thin or unflattering one honestly is worth
// more than publishing nothing.

const { kv } = require("./_kv.js");
const { appendLink, readChain, verifyChain, diffLinks } = require("./_lib/record-chain.js");

const KEY = "novo:track_record";
const TTL = 14 * 24 * 60 * 60;   // survives a long engine outage; staleness is shown, not hidden

// THE OVERWRITE THAT MADE THE RECORD UNCHECKABLE. `set` on one key, per publish, meant every
// publish destroyed the one before it -- values drifted between two reads hours apart and the
// earlier ones were unrecoverable. So a figure printed in copy on Monday could not be verified on
// Friday, and the prompt's "you do not get to edit it" was simply false. The snapshot above is
// still the fast read path; the chain beside it is the history. See _lib/record-chain.js, which
// is also explicit about what a server-held chain does NOT prove.

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();

  const r = kv();

  if (req.method === "POST") {
    const secret = process.env.ANALYST_PUBLISH_SECRET || "";
    if (!secret || req.headers["x-analyst-secret"] !== secret) {
      return res.status(403).json({ error: "forbidden" });
    }
    let b = {};
    try { b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); } catch { b = {}; }
    if (!b || b.ok !== true || !b.tickers) return res.status(400).json({ error: "bad payload" });
    if (!r) return res.status(200).json({ ok: false, note: "kv unavailable" });
    try {
      const received = Date.now();
      await r.set(KEY, JSON.stringify({ ...b, received }), { ex: TTL });
      // Appended after the snapshot lands and never allowed to fail the publish: losing one link
      // is recoverable, losing the publish is not. Silent on the unchanged path, which is most.
      const link = await appendLink(r, b, received);
      return res.status(200).json({ ok: true, chain: link });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== "GET") return res.status(405).json({ error: "GET or POST" });

  // ── THE RECORD AS IT STOOD BEFORE ─────────────────────────────────────────────────────────
  // ?history=N  the last N publishes that CHANGED anything, newest first, each with its hash
  // ?verify=1   recompute the chain and report any link that does not match
  // Both are the same data the page serves, so a number quoted anywhere can be traced to the
  // publish it came from -- which is the only thing that makes "audited" mean more than "stated".
  if (req.query && (req.query.history || req.query.verify)) {
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60, stale-while-revalidate=600");
    if (!r) return res.status(200).json({ ok: false, note: "unavailable" });
    const want = Math.max(1, Math.min(parseInt(req.query.history, 10) || 30, 200));
    const links = await readChain(r, req.query.verify ? 200 : want);
    const check = verifyChain(links);
    if (req.query.verify) {
      // AN EMPTY CHAIN IS NOT AN INTACT CHAIN. verifyChain() has nothing to disagree with when it
      // is handed zero links, so it returns intact:true -- and shipping that as "every published
      // record still hashes to the one before it" is a green light over an empty room. It is the
      // same false-green shape as a wall test that passes because the query errored. Nothing has
      // published since this shipped, so this is the state it will be in first, and it must not
      // read as reassurance.
      if (!links.length) {
        return res.status(200).json({
          ok: true, links: 0, intact: null, head: null, problems: [],
          note: "No publishes have been recorded yet, so there is nothing to verify. This is not " +
                "a passing check -- it is an empty one. The first engine publish starts the chain.",
        });
      }
      return res.status(200).json({
        ok: true, ...check,
        note: check.intact
          ? `All ${check.links} recorded publishes still hash to the record before them, so none ` +
            "has been altered since it was written. This is a server-held chain: it makes a " +
            "silent revision detectable, it does not make one impossible." +
            (check.oldestPrevUnchecked
              ? " The oldest record shown links to one older than the window kept, so its own " +
                "predecessor is outside what this check can see."
              : "")
          : "One or more records do not reconcile. Treat the affected ones as unverified.",
      });
    }
    return res.status(200).json({
      ok: true, head: check.head, intact: check.intact, links: links.length,
      history: links.slice(0, want).map((L, i) => ({
        ts: L.ts, generated: L.generated, hash: L.hash, prev: L.prev,
        claims: L.claims,
        // What actually moved since the publish before it -- the reason to keep history at all.
        changed: i + 1 < links.length ? diffLinks(L, links[i + 1]).changed : undefined,
      })),
      note: "One entry per publish that CHANGED a scored claim; identical republishes are not " +
            "recorded. `hash` covers the entry and the one before it.",
    });
  }

  // 30 minutes of edge cache with no browser max-age meant a fresh push could sit invisible for
  // half an hour, and browsers fell back to heuristic caching on top of that. The record changes
  // on every engine publish, so it revalidates in a minute and serves stale only while refreshing.
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60, stale-while-revalidate=600");
  if (!r) return res.status(200).json({ ok: false, note: "unavailable" });
  let snap = null, ch = null;
  try { snap = await r.get(KEY); } catch (_) { snap = null; }
  // Crypto is additive: if this read fails the equity record still serves whole.
  try { ch = await r.get("crypto:map:history"); } catch (_) { ch = null; }
  if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch (_) { snap = null; } }
  if (typeof ch === "string") { try { ch = JSON.parse(ch); } catch (_) { ch = null; } }
  if (!snap) return res.status(200).json({ ok: false, note: "not published yet" });

  // The CRYPTO half of the same record. The collector scores its own claims (gamma pin, funding
  // extreme, OI quadrant, cost anomaly) exactly the way the equity engine scores its own — and a
  // track record that shows one asset class while the analyst runs two reads as curated. Only the
  // crypto-class aggregates ride here; each row carries `trustworthy` and its own caveat, and a
  // row that has not survived more than one market says so instead of wearing a hit rate.
  if (ch && ch.base_rates && Object.keys(ch.base_rates).length) {
    snap.crypto = {
      baseRates: ch.base_rates,
      retired: ch.base_rates_retired || null,
      openClaims: ch.open_claims ?? null,
      asOf: ch.received || null,
      note: "Self-scored crypto claims, graded at their own horizons against the series each " +
            "claim was made on. n_cells (independent coin-days) is the denominator that matters; " +
            "a row with trustworthy:false is an early reading, not a base rate. Directional kinds " +
            "report per predicted side with the market's own drift beside them.",
    };
  }
  return res.status(200).json(snap);
};
