// api/trader-chart.js — the LIVE Trader chart, published by the engine and pulled from here.
//
// WHY THIS EXISTS (2026-09-04). The Analyst dashboard and the Crypto map have always been
// publish/ingest: the engine pushes state to this store and the browser pulls it from the same
// origin it loaded the page from. The Trader chart was the only surface built the other way round
// — the browser reached back to the chart service on Railway every 4 seconds for a 335–400KB
// payload. Jake, after a night of chart stalls: "NoVo Options Trading should be collecting all the
// data pooling and the dashboards pulling it", and then plainly, "we need a reliable fast chart!"
//
// Pulling instead of reaching back buys three things:
//   * speed       — same-origin, off Vercel's edge, no cross-origin TLS handshake to Railway
//                   before the first candle, and a real 304 path for the 4s poll
//   * resilience  — an engine redeploy or stall no longer blanks the chart; this keeps serving the
//                   last published frame and the page decides for itself whether it is too old
//   * bounded work— the engine builds each payload once per change, not once per viewer per poll
//
// NOT the same thing as trader-snapshot.js. That is the FREE, deliberately 15-minute-delayed chart
// and it refuses anything fresher. This is the live paid one and is gated accordingly.
//
// AUTH IS THE TICKET, ON PURPOSE. The browser already holds a short-lived ticket minted by
// /api/trader-live — which is issued only after the member token AND the Stripe entitlement check
// pass — and signed with TRADER_SOCKET_SECRET. Verifying that same ticket here means:
//   * one entitlement rule for the live chart, not a second copy to drift out of sync
//   * no Stripe round-trip on a 4-second poll (which would be both slow and rate-limited)
//   * the credential on the wire dies in five minutes, exactly as it does for the socket
// A member token is NOT accepted here, for the same reason the socket does not accept one: it is
// long-lived, and this URL ends up in devtools and in screenshots.

const crypto = require("crypto");
const zlib = require("zlib");
const { kv } = require("./_kv");

const TICKERS = new Set(["SPY", "QQQ", "IWM"]);

// The deep frames (1H / D / W) publish here too, as of 2026-09-04. They were the LAST chart
// reach-back and the most expensive one: measured 264-578ms of cross-origin round trip per
// timeframe click for 58-85KB, which is the "clicking through their charts" complaint almost
// exactly. They live under their own keys so the live frame's key shape does not change.
const DEEP_TFS = new Set(["1h", "1d", "1w"]);
const KEY = (t, tf) => (tf ? `trader:chart:${t}:${tf}` : `trader:chart:${t}`);

// Normalise the tf param once, for both verbs: "" / absent / "live" all mean the live 1-minute
// frame. Anything else must be a known deep frame or the request is rejected rather than silently
// answered with the live frame, which would paint 1-minute bars under a "W" caption.
function normTf(v) {
  const s = String(v == null ? "" : v).toLowerCase().trim();
  if (!s || s === "live") return { ok: true, tf: "" };
  return DEEP_TFS.has(s) ? { ok: true, tf: s } : { ok: false };
}

// Long enough that a redeploy, a restart, or an overnight gap never blanks the chart — the page
// judges freshness from as_of and shows its own STALE treatment. Short enough that a store nobody
// is feeding does not serve a week-old frame forever.
const TTL_SECONDS = 6 * 60 * 60;

// A published payload is ~70–85KB of base64'd gzip (335–400KB raw). This is a sanity bound against
// a malformed or hostile POST, not a tuning knob.
const MAX_GZ_B64 = 2 * 1024 * 1024;

// Verify the ticket /api/trader-live minted. Same construction, same secret, checked the same way
// the chart service checks it (_valid_ticket in chart_service.py): HMAC, then p, then expiry.
function verifyTicket(t) {
  try {
    const secret = process.env.TRADER_SOCKET_SECRET || "";
    if (!secret || !t) return null;
    const i = String(t).indexOf(".");
    if (i < 0) return null;
    const payload = String(t).slice(0, i);
    const sig = String(t).slice(i + 1);
    const want = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    const a = Buffer.from(sig), b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const j = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!j || j.p !== "trader") return null;
    return Number(j.x) > Date.now() ? j.e : null;
  } catch (_) { return null; }
}

module.exports = async (req, res) => {
  const r = kv();
  if (!r) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: "store unavailable" });
  }

  // ---- publish (engine) ---------------------------------------------------------------------
  if (req.method === "POST") {
    res.setHeader("Cache-Control", "no-store");
    const secret = process.env.ANALYST_PUBLISH_SECRET || "";
    const sent = req.headers["x-analyst-secret"] || "";
    if (!secret || sent !== secret) return res.status(401).json({ error: "unauthorized" });

    const b = req.body || {};
    const ticker = String(b.ticker || "").toUpperCase().trim();
    if (!TICKERS.has(ticker)) return res.status(400).json({ error: "unknown ticker" });
    const pf = normTf(b.tf);
    if (!pf.ok) return res.status(400).json({ error: "unknown tf" });
    if (typeof b.gz !== "string" || !b.gz) return res.status(400).json({ error: "gz required" });
    if (b.gz.length > MAX_GZ_B64) return res.status(413).json({ error: "payload too large" });
    const asOf = Number(b.as_of);
    if (!Number.isFinite(asOf) || asOf <= 0) return res.status(400).json({ error: "as_of required" });

    // Prove it decompresses to JSON BEFORE it is stored. A truncated or mis-encoded body that is
    // only discovered on read would take the chart down for every viewer until the next publish,
    // and the failure would look like a browser bug rather than a bad write.
    let rawLen = 0;
    try {
      const raw = zlib.gunzipSync(Buffer.from(b.gz, "base64")).toString("utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.candles)) {
        return res.status(400).json({ error: "payload has no candles array" });
      }
      rawLen = raw.length;
    } catch (e) {
      return res.status(400).json({ error: "gz is not gzipped JSON" });
    }

    await r.set(KEY(ticker, pf.tf), JSON.stringify({
      as_of: asOf,
      etag: String(b.etag || ""),
      gz: b.gz,
    }), { ex: TTL_SECONDS });

    return res.status(200).json({ ok: true, ticker, tf: pf.tf || "live",
                                 raw_bytes: rawLen, gz_b64: b.gz.length });
  }

  // ---- read (the dashboard) -----------------------------------------------------------------
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Cache-Control", "no-store");
    return res.status(405).json({ error: "method not allowed" });
  }

  // private: this is paid live market data, and it is per-member. Never let a shared cache hold it.
  res.setHeader("Cache-Control", "private, no-cache");
  // The response now depends on a request HEADER, so any cache keyed on URL alone would be wrong.
  // "private" already keeps this out of shared caches; Vary makes the dependency explicit rather
  // than relying on that one word to carry it.
  res.setHeader("Vary", "x-novo-ticket");

  // Header first, query second. The dashboard sends it as a header so the URL -- and therefore
  // the browser cache key -- stays stable while the ticket rotates every 5 minutes; without that,
  // each rotation threw away the cached copy and turned the next poll into a full download
  // instead of a 304. The query form stays supported for probes and for any client that cannot
  // set headers. Same-origin only, so a custom header costs no CORS preflight.
  const email = verifyTicket(req.headers["x-novo-ticket"] || (req.query && req.query.t) || "");
  if (!email) {
    // 401 and not a redirect: the caller is a fetch(), not a navigation, and the page has a
    // re-handshake path (_reauth401) that knows what to do with this.
    return res.status(401).json({ error: "a valid ticket is required" });
  }

  const ticker = String((req.query && req.query.ticker) || "SPY").toUpperCase().trim();
  if (!TICKERS.has(ticker)) return res.status(400).json({ error: "unknown ticker" });
  const gf = normTf(req.query && req.query.tf);
  if (!gf.ok) return res.status(400).json({ error: "unknown tf" });

  let row = null;
  try {
    const v = await r.get(KEY(ticker, gf.tf));
    row = typeof v === "string" ? JSON.parse(v) : v;
  } catch (_) { row = null; }

  if (!row || !row.gz) {
    // 404 is meaningful to the page: "the store has nothing for this ticker", which is its cue to
    // fall back to the engine rather than to show an error.
    return res.status(404).json({ error: "no published frame", ticker, tf: gf.tf || "live" });
  }

  // The engine's own weak ETag rides through, so an unchanged payload costs a 304 and no body.
  // Off-session that turns every 4s poll into an empty round trip instead of ~55KB.
  const etag = String(row.etag || "");
  if (etag) res.setHeader("ETag", etag);
  res.setHeader("X-Novo-As-Of", String(row.as_of || 0));
  if (etag && req.headers["if-none-match"] === etag) return res.status(304).end();

  let raw;
  try {
    raw = zlib.gunzipSync(Buffer.from(row.gz, "base64"));
  } catch (_) {
    // Stored bytes are unreadable. Say so as a 503 rather than a 200 with a broken body, so the
    // page falls back to the engine instead of trying to render nothing.
    return res.status(503).json({ error: "stored frame unreadable", ticker });
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "HEAD") return res.status(200).end();
  return res.status(200).send(raw);
};
