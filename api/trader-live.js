// api/trader-live.js — the gated handshake for /trader/live.
//
// This endpoint does NOT return market data. It returns a short-lived ticket that the browser
// exchanges for a WebSocket on the chart service. That split is the whole point:
//
//   * the 7-day HMAC member token proves WHO you are (it carries an email and nothing else)
//   * a live Trader subscription in Stripe proves WHAT you bought
//   * the ticket it mints is the only credential that ever reaches the socket, and it dies in
//     minutes
//
// The member token must never be used as the socket credential. It is long-lived, and a socket URL
// ends up in devtools, in a copied link, in a screenshot of a browser's network tab. A ticket that
// expires in five minutes is worth nothing once it has been used to connect.
//
// Entitlement mirrors _memberTier() in analyst-publish.js rather than inventing a second rule:
// Trader is "a live paid subscription that is not Analyst and not Crypto". Matching on the two
// current Trader price ids alone would lock out any legacy Trader sub still billing on an older
// price. Crypto and Analyst are excluded explicitly — they are separate products that do not open
// this one.

const crypto = require("crypto");
const Stripe = require("stripe");
const { kv } = require("./_kv");

const _stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

const LIVE = ["active", "trialing", "past_due"];

// Known Trader prices. Presence is sufficient, absence is not disqualifying — see the note above.
const TRADER_PRICE_IDS = new Set([
  process.env.STRIPE_PRICE_SUB_ID,
  process.env.STRIPE_PRICE_SUB_YEARLY_ID,
  'price_1U8R0zB1Bq29OALaAdZzFw8S',   // $209/mo
  'price_1U8R1cB1Bq29OALaUL53wxgD',   // $2,000/yr
].filter(Boolean));

const CRYPTO_PRICE_IDS = new Set([
  process.env.STRIPE_PRICE_CRYPTO, process.env.STRIPE_PRICE_CRYPTO_YEARLY,
  'price_1U9EU0B1Bq29OALajbT8DWJS', 'price_1U9EUsB1Bq29OALaYh2QODHA',
].filter(Boolean));

const ANALYST_PRICE_IDS = new Set([
  process.env.STRIPE_PRICE_ANALYST, process.env.STRIPE_PRICE_ANALYST_YEARLY,
  'price_1TugYAApyfMAkbeEarl2ULSv', 'price_1TugYAApyfMAkbeE9c3Rdypj',
  'price_1U59pFApyfMAkbeEhEDpToGK', 'price_1U59pFApyfMAkbeEDzNHEJbD',
].filter(Boolean));

const _has = (sub, ids) => {
  try { return (sub?.items?.data || []).some(it => ids.has(it?.price?.id)); }
  catch (_) { return false; }
};

// Comped seats have no Stripe subscription at all. Same variable and same semantics as the control
// plane and crypto-map.js, so there is one list to keep rather than three.
const COMP = new Set(
  String(process.env.COMP_EMAILS || "")
    .split(",").map(e => e.trim().toLowerCase()).filter(Boolean)
);

function verifyMemberToken(token) {
  try {
    const secret = process.env.ANALYST_LIVE_SECRET || process.env.ANALYST_PUBLISH_SECRET || "";
    if (!secret || !token) return null;
    const [payload, sig] = String(token).split(".");
    if (!payload || !sig) return null;
    const want = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    const a = Buffer.from(sig), b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const j = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return (j && j.x > Date.now()) ? j.e : null;
  } catch (_) { return null; }
}

async function hasTraderSub(email) {
  const norm = String(email || "").trim().toLowerCase();
  if (!norm) return false;
  if (COMP.has(norm)) return true;
  if (!_stripe) return false;               // not configured -> closed, never open

  const r = kv();
  const ck = "ent:trader:" + crypto.createHash("sha256").update(norm).digest("hex").slice(0, 24);
  if (r) {
    try {
      const cached = await r.get(ck);
      if (cached === "1") return true;
      if (cached === "0") return false;
    } catch (_) { /* fall through to a live check */ }
  }

  let ok = false;
  try {
    const custIds = new Set();
    try {
      const sr = await _stripe.customers.search({ query: `email:"${norm.replace(/"/g, "")}"`, limit: 20 });
      for (const c of sr.data) custIds.add(c.id);
    } catch (_) { /* search index warming up — list() below still covers it */ }
    const custs = await _stripe.customers.list({ email: norm, limit: 100 });
    for (const c of custs.data) custIds.add(c.id);

    outer:
    for (const id of custIds) {
      const subs = await _stripe.subscriptions.list({ customer: id, status: "all", limit: 20 });
      for (const s of subs.data) {
        if (!LIVE.includes(s.status)) continue;
        if (_has(s, TRADER_PRICE_IDS)) { ok = true; break outer; }
        if (_has(s, ANALYST_PRICE_IDS) || _has(s, CRYPTO_PRICE_IDS)) continue;
        if (s?.metadata?.tier === 'analyst' || s?.metadata?.tier === 'crypto') continue;
        ok = true; break outer;             // a live paid sub that is neither = legacy Trader
      }
    }
  } catch (e) {
    console.error("[trader-live] entitlement check:", e.message);
    return false;    // FAIL CLOSED. This gates a paid product; a Stripe outage must not open it.
  }

  if (r) { try { await r.set(ck, ok ? "1" : "0", { ex: ok ? 600 : 120 }); } catch (_) {} }
  return ok;
}

// The socket credential. Signed with a secret shared ONLY with the chart service — deliberately not
// ANALYST_LIVE_SECRET, so that a ticket cannot be replayed against any other endpoint on the site
// and a member token cannot be replayed against the socket.
const TICKET_TTL_MS = 5 * 60 * 1000;

function mintTicket(email, secret) {
  const payload = Buffer.from(JSON.stringify({
    e: String(email).trim().toLowerCase(),
    x: Date.now() + TICKET_TTL_MS,
    p: "trader",
  }), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return payload + "." + sig;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const email = verifyMemberToken((req.query && req.query.t) || (req.body && req.body.t));
  if (!email) {
    return res.status(401).json({ error: "sign in to open the Trader dashboard" });
  }

  if (!(await hasTraderSub(email))) {
    // 402, not 401: the caller is who they say they are, they just have not bought this. The page
    // uses the distinction to show "subscribe" rather than "sign in again".
    return res.status(402).json({
      error: "The live Trader dashboard requires a Trader subscription.",
      subscribe: "/trader",
    });
  }

  // Host and secret are configuration, not code: the tunnel moves to a novo-options.trade subdomain
  // before this ships, and that must not be a deploy. Missing config answers 503 rather than
  // guessing a hostname and handing the browser a socket that will never open.
  const host = String(process.env.TRADER_SOCKET_HOST || "").trim().replace(/^wss?:\/\//, "").replace(/\/+$/, "");
  const secret = process.env.TRADER_SOCKET_SECRET || "";
  if (!host || !secret) {
    console.error("[trader-live] TRADER_SOCKET_HOST / TRADER_SOCKET_SECRET not set");
    return res.status(503).json({ error: "the live chart is not available right now" });
  }

  const ticket = mintTicket(email, secret);
  return res.status(200).json({
    ws: `wss://${host}/ws/telemetry?t=${encodeURIComponent(ticket)}`,
    api: `https://${host}`,
    expires_in: Math.floor(TICKET_TTL_MS / 1000),
  });
};
