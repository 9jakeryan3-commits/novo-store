// api/crypto-map.js — the gated read for the NoVo Crypto Market Map.
//
// PRODUCT MODEL, and the reason this file does more than verify a token:
// The Crypto Market Map is its OWN product. It is NOT bundled with Analyst and an Analyst
// subscription does not open it. The only thing the two share is NoVo itself — the AI
// analyst runs inside NoVo Options Trading, which sells both, so NoVo sees both datasets.
// A customer sees exactly what that customer bought.
//
// So authentication and entitlement are deliberately separate here:
//   * the 7-day HMAC token proves WHO you are (it carries an email, nothing else)
//   * a live Stripe subscription on a CRYPTO price id proves WHAT you bought
// Verifying only the token would hand this product to every Analyst subscriber for free.
//
// Entitlement is keyed on PRICE IDS, not subscription metadata — metadata.tier is
// mutable/strippable, which is the same reasoning analyst-publish.js uses for its own
// tier check.
//
// What this returns IS the paid dealer map — gamma by strike, flip, walls, per-venue
// funding, liquidations. Same hard rule as the equity side: no sampled tier, no teaser
// payload, nothing for an unentitled caller.

const crypto = require("crypto");
const Stripe = require("stripe");
const { kv } = require("./_kv");

// BOUNDED (2026-09-03). The default stripe-node client is 80s timeout with retries, and this
// function makes up to 1 search + 1 list + N subscription lists per call. On a SLOW Stripe — not
// even a down one — that outlives the serverless function's own deadline, so the request dies with
// no response at all and the paid map shows nothing. 8s x 1 retry keeps the worst case inside the
// platform default with room for the KV read that follows.
const _stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY, { timeout: 8000, maxNetworkRetries: 1 })
  : null;

// Crypto Market Map price ids. Env wins; add the literal ids here once they exist in
// Stripe so the check keeps working if an env var is ever dropped.
const CRYPTO_PRICE_IDS = new Set([
  process.env.STRIPE_PRICE_CRYPTO,
  process.env.STRIPE_PRICE_CRYPTO_YEARLY,
  'price_1U9EU0B1Bq29OALajbT8DWJS',   // $79/mo   — prod_V9XZrb8qBEdzoI
  'price_1U9EUsB1Bq29OALaYh2QODHA',   // $790/yr  — prod_V9XZrb8qBEdzoI
  // Bundle COMPANION prices (2026-09-01) — the discounted crypto half of each bundle, on the
  // same product. A bundle subscriber's crypto entitlement arrives on one of these ids.
  process.env.STRIPE_PRICE_CRYPTO_BUNDLE_AC, process.env.STRIPE_PRICE_CRYPTO_BUNDLE_AC_YEARLY,
  process.env.STRIPE_PRICE_CRYPTO_BUNDLE_ALL, process.env.STRIPE_PRICE_CRYPTO_BUNDLE_ALL_YEARLY,
  'price_1UB0ZhB1Bq29OALa8iLZSSL5', 'price_1UB0ZhB1Bq29OALamNjyA6Y9',   // $40/$400 — beside Analyst
  'price_1UB0ZhB1Bq29OALaOw2hUHWS', 'price_1UB0ZhB1Bq29OALaWQPTPOs7',   // $30/$300 — beside Trader
].filter(Boolean));

const LIVE = ["active", "trialing", "past_due"];

function verifyToken(token) {
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

function _subIsCrypto(sub) {
  try {
    return (sub?.items?.data || []).some(it => CRYPTO_PRICE_IDS.has(it?.price?.id));
  } catch (_) { return false; }
}

// The dashboard polls every 90s. A Stripe round trip per poll would be slow and would
// burn rate limit, so a positive verdict is cached briefly. Cache is short precisely so a
// cancellation takes effect in minutes rather than at token expiry.
// Comped seats: owner testing and free/comped accounts, which have no Stripe subscription at
// all. The control plane already treats COMP_EMAILS as every product; without the same list
// here the portal would mint a valid token and this endpoint would still answer 402, so the
// one account that exists to test the product is the one account that cannot open it.
// Same variable name and same semantics as the control plane, so there is one list to keep.
const COMP = new Set(
  String(process.env.COMP_EMAILS || "")
    .split(",").map(e => e.trim().toLowerCase()).filter(Boolean)
);

// Returns "yes" | "no" | "unknown".
//
// The tri-state is the point. This used to return a bare boolean, and an EXCEPTION from Stripe came
// back as false — indistinguishable from Stripe answering "this person has not bought it". The
// caller then showed a 402 upsell, so a Stripe blip greeted PAYING subscribers with
// "Start the 7-day free trial — $79/mo". Failing closed is right; selling to an existing customer
// because an upstream was slow is not. "unknown" now means exactly that, and the caller says so.
async function hasCryptoSub(email) {
  const norm = String(email || "").trim().toLowerCase();
  if (!norm) return "no";
  if (COMP.has(norm)) return "yes";
  if (!_stripe || CRYPTO_PRICE_IDS.size === 0) return "no";   // not configured yet -> closed, not open

  const r = kv();
  const ck = "ent:crypto:" + crypto.createHash("sha256").update(norm).digest("hex").slice(0, 24);
  // Last-known-good, kept far longer than the 10-minute positive cache. It is ONLY consulted when
  // Stripe fails to answer, and it can only ever have been written by a real verified "yes", so it
  // grants nothing to anyone who was never entitled — it just stops an upstream outage from
  // retroactively un-subscribing a customer who paid.
  const gk = ck + ":grace";
  if (r) {
    try {
      const cached = await r.get(ck);
      if (cached === "1") return "yes";
      if (cached === "0") return "no";
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

    for (const id of custIds) {
      const subs = await _stripe.subscriptions.list({ customer: id, status: "all", limit: 20 });
      if (subs.data.some(s => LIVE.includes(s.status) && _subIsCrypto(s))) { ok = true; break; }
    }
  } catch (e) {
    console.error("[crypto-map] entitlement check:", e.message);
    // STILL FAILS CLOSED for anyone we have never verified: no grace record, no access. But a
    // customer we positively verified within the grace window keeps what they paid for while the
    // upstream is unavailable, rather than being told they do not own the product.
    if (r) {
      try { if (await r.get(gk) === "1") { console.warn("[crypto-map] stripe unavailable — honouring grace for a previously verified subscriber"); return "yes"; } }
      catch (_) { /* KV down too — fall through to unknown */ }
    }
    return "unknown";
  }

  if (r) {
    try { await r.set(ck, ok ? "1" : "0", { ex: ok ? 600 : 120 }); } catch (_) {}
    // 72h: long enough to ride out any realistic Stripe or KV incident, short enough that a genuine
    // cancellation stops working within days rather than indefinitely. Only ever written on a real
    // verified "yes", and refreshed on every successful check.
    if (ok) { try { await r.set(gk, "1", { ex: 259200 }); } catch (_) {} }
  }
  return ok ? "yes" : "no";
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const email = verifyToken((req.query && req.query.t) || (req.body && req.body.t));
  if (!email) {
    return res.status(401).json({ error: "sign in to open the Crypto Market Map" });
  }

  const ent = await hasCryptoSub(email);
  if (ent === "unknown") {
    // We could not REACH Stripe and have no verified history for this address. That is our problem,
    // not theirs, and it must not be dressed up as "you have not bought this" — a 402 upsell shown
    // to a paying subscriber during an upstream outage is the worst thing this endpoint can do.
    // 503 + Retry-After is the honest answer, and the client can say "checking your subscription"
    // rather than "subscribe".
    res.setHeader("Retry-After", "30");
    return res.status(503).json({
      error: "cannot verify your subscription right now - this is on us, please retry shortly",
      retry: true,
    });
  }
  if (ent === "no") {
    // 402, not 401: the caller is who they say they are, they just have not bought this.
    // The dashboard uses the distinction to show "subscribe" rather than "sign in again".
    return res.status(402).json({
      error: "The Crypto Market Map is a separate subscription.",
      subscribe: "/crypto",
    });
  }

  const r = kv();
  if (!r) return res.status(503).json({ error: "store unavailable" });

  // ONE RETRY (2026-09-03). A single transient Upstash read failure used to take the paid map
  // fully dark — there is no server-side cache and no CDN buffer behind this, so one dropped
  // connection was a blank product. A brief retry converts the common case (a momentary blip) into
  // a slightly slower response instead of an outage; a genuine outage still 503s on the second try.
  let raw = null, _readErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { raw = await r.get("crypto:map:live"); _readErr = null; break; }
    catch (e) {
      _readErr = e;
      if (attempt === 0) await new Promise(s => setTimeout(s, 250));
    }
  }
  if (_readErr) {
    console.error("[crypto-map] kv read failed twice:", _readErr.message);
    res.setHeader("Retry-After", "15");
    return res.status(503).json({ error: "store read failed", retry: true });
  }
  if (!raw) return res.status(503).json({ error: "no live snapshot - the crypto collector is not reporting" });

  let snap = raw;
  if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch { snap = null; } }
  if (!snap || !snap.coins) return res.status(503).json({ error: "snapshot unreadable" });

  const ageMin = snap.received ? Math.round((Date.now() - snap.received) / 60000) : null;

  // PERCENTILES — measured, and computed every pass since the history rollup shipped, but never
  // served. history.py already writes funding[venue].pct and oi.pct for each coin against that
  // coin's OWN sample history (n is carried alongside, and it is a real n — 1,027 samples on BTC
  // today). Nothing rendered them because they never left the collector's own key.
  //
  // Sliced to {pct, n} rather than forwarding the whole history object: that payload is ~109KB,
  // almost all of it daily series this dashboard does not draw, against ~17KB for the slice.
  // Never fails the response — a missing or unreadable history key just means no percentile
  // columns, which is the honest degradation.
  let hist = null;
  try {
    let hraw = await r.get("crypto:map:history");
    if (typeof hraw === "string") hraw = JSON.parse(hraw);
    const hc = hraw && (hraw.coins || hraw);
    if (hc && typeof hc === "object") {
      hist = {};
      for (const k of Object.keys(hc)) {
        const v = hc[k];
        if (!v || typeof v !== "object") continue;
        const e = {};
        // .lt is the LONG lens where one exists — the venue's own archive (years of daily
        // closes / hourly prints), a separate population from the live samples with its own
        // n and span. Forwarded whole; it is already a compact summary.
        if (v.oi && v.oi.pct != null) e.oi = { pct: v.oi.pct, n: v.oi.n,
                                               ...(v.oi.lt ? { lt: v.oi.lt } : {}) };
        const f = {};
        for (const ven of Object.keys(v.funding || {})) {
          const d = v.funding[ven];
          if (d && d.pct != null) f[ven] = { pct: d.pct, n: d.n,
                                             ...(d.lt ? { lt: d.lt } : {}) };
        }
        if (Object.keys(f).length) e.funding = f;
        // IV vs RV — both already computed by history.py, never rendered until 2026-09-01.
        // rv = the newest day's realized daily % (sd of 1-min log returns scaled), with its
        // minute count as the n; iv_daily = DVOL/20, the implied daily move it reads against.
        const rvd = v.realized_vol_daily && v.realized_vol_daily.series;
        if (rvd && rvd.length) {
          const last = rvd[rvd.length - 1];
          e.rv = { d: last[0], pct: last[1], n_min: last[2] };
        }
        if (v.dvol && v.dvol.now != null) {
          e.dvol = { now: v.dvol.now, pct: v.dvol.pct, n: v.dvol.n,
                     ...(v.dvol.lt ? { lt: v.dvol.lt } : {}),
                     implied_daily: Math.round(v.dvol.now / 20 * 1000) / 1000 };
        }
        if (Object.keys(e).length) hist[k] = e;
      }
      if (!Object.keys(hist).length) hist = null;
    }
  } catch (_) { hist = null; }

  const coin = (req.query && req.query.coin || "").toUpperCase();
  if (coin) {
    const one = snap.coins[coin];
    if (!one) return res.status(404).json({ error: `no coverage for ${coin}` });
    return res.status(200).json({ as_of: snap.as_of, age_min: ageMin, coin, data: one,
                                  hist: (hist && hist[coin]) || null });
  }

  // The chain half goes to every crypto subscriber: it is part of the map, just a different
  // KIND of map -- liquidity structure for tokens that have no options book to draw gamma from.
  //
  // The ALERTS do not. They are the private half: rules whose thresholds rest on a few dozen
  // resolved observations from one window, which is enough to trade on personally and nowhere near
  // enough to sell. Gated to the comped account until the record is real, and gated HERE rather
  // than by omitting them from the snapshot, so the day they are ready is a one-line change and
  // not a collector redeploy.
  const priv = COMP.has(String(email).trim().toLowerCase());

  return res.status(200).json({
    as_of: snap.as_of, age_min: ageMin,
    coins: snap.coins, chain: snap.chain || [],
    // What just fired, across the whole book. Public: the collector filters this to the crypto
    // asset class before it is published, so the private chain tickets cannot reach it.
    feed: snap.feed || [],
    // The real counts behind that 60-row page. This response is a field-by-field rebuild -- the
    // same whitelist crypto-ingest.js removed after it silently dropped chain, then alerts, then
    // feed -- so a new section has to be named HERE or it never reaches the browser.
    reads: snap.reads || null,
    breadth: snap.breadth, health: snap.health,
    // The dry powder: USD stablecoin supply and its 1d/7d direction. Market-wide, so it is a
    // top-level field and has to be named HERE -- same whitelist that silently dropped chain,
    // then alerts, then feed, then reads.
    stablecoins: snap.stablecoins || null,
    // Named HERE deliberately — see the whitelist note above. A field this rebuild does not list
    // never reaches the browser, which is exactly how chain, alerts and feed were each lost once.
    ...(hist ? { hist } : {}),
    ...(priv && snap.alerts ? { alerts: snap.alerts } : {}),
  });
};
