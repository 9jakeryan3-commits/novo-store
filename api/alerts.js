// api/alerts.js — the reader's own alerts, over HTTP, so a page can manage them.
//
// Jake, 2026-09-07: "you know how you can tell Dr. NoVo to alert you about anything or set an
// alert in chat.. well we need an Alerts tab to self manage these alerts."
//
// Until now these objects existed ONLY behind the chat's tool layer (api/_lib/tools.js), which is
// fine for creating one in a sentence and hopeless for answering "what am I actually watching?"
// three days later. This is the read/cancel surface. It adds no storage and no rules of its own:
// listAlerts and cancelAlert are the same functions the chat calls, so a cancel from the tab and a
// cancel in conversation cannot disagree.
//
// ⚠ IT DELIBERATELY CANNOT CREATE ONE. setAlert validates against the live crypto snapshot — a
// coin has to be on the map, and a named level like call_wall only exists where that coin has an
// options book publishing one — and it enforces the active cap. Re-implementing any of that behind
// a form is how the two paths drift until the page can save an alert the evaluator will never
// fire. Creating stays a sentence to Dr. NoVo; this surface manages what exists.
//
// AUTH IS THE CHAT'S VERIFIER, COPIED EXACTLY, not a second scheme: the signed ticket carries the
// member's email and an expiry, and nothing here consults the plan claim, for the same reason
// api/chat-log.js does not — a Trader subscription has always included this.
const crypto = require("crypto");
const { listAlerts, cancelAlert } = require("./_lib/alerts.js");
// The morning digest is a standing request like an alert is, it is delivered down the same
// VAPID lane, and after 2026-09-07 its notification points here — so this is where it has to
// be visible and stoppable. It is stored with the reader's memory rather than with alerts,
// which is why it is a second read.
const { getMemory, updateMemory } = require("./_lib/member-memory.js");
const { kv } = require("./_kv.js");
const { eh } = require("./_lib/alerts.js");

function verifyToken(token) {
  try {
    const secret = process.env.ANALYST_LIVE_SECRET || process.env.ANALYST_PUBLISH_SECRET || "";
    if (!secret || !token) return null;
    const [payload, sig] = String(token).split(".");
    if (!payload || !sig) return null;
    const want = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    const a = Buffer.from(sig), b = Buffer.from(want);
    // Length check first: timingSafeEqual THROWS on a length mismatch rather than returning false,
    // and a thrown comparison inside a try/catch that returns null reads as "bad token" by luck.
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const j = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return (j && j.x > Date.now()) ? j.e : null;
  } catch (_) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");

  const body = (req.method === "POST" && req.body)
    ? (typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body) : {};
  const email = verifyToken(body.t || (req.query && req.query.t));
  if (!email) return res.status(401).json({ error: "sign in on the dashboard" });

  // Which dashboard is asking. Allowlisted; absent means "everything", which is what a caller
  // that has not been taught about apps yet should still get.
  const APPS = new Set(["analyst", "crypto", "trader"]);
  const _q = (req.query && req.query.app) || body.app || "";
  const app = APPS.has(_q) ? _q : null;

  try {
    if (req.method === "GET") {
      const out = await listAlerts(email, app);
      // listAlerts answers {error} when KV is unreachable. That is a 503, not an empty list —
      // rendering "no alerts" over a dead store tells a member their alerts are gone.
      if (out && out.error) return res.status(503).json(out);
      // Best-effort and separate: a digest read that fails must not take the alerts list with it.
      let digest = null, digest_log = [];
      try {
        const m = await getMemory(email);
        const dg = (m && m.digest) || null;
        // Same rule as the alerts: a digest asked for on one dashboard is managed there.
        digest = (dg && (!app || !dg.app || dg.app === app)) ? dg : null;
        /* The mornings themselves, for the Digest tab. Served only where the digest is managed —
           the same per-app gate — and only when one is standing: a stopped digest's history dies
           with it rather than lingering as a page about nothing. Newest first, capped at 7 on the
           wire; the store keeps 14. */
        if (digest) {
          const r2 = kv();
          if (r2) {
            let log = null;
            try { log = await r2.get("digest:log:" + eh(email)); } catch (_) { log = null; }
            if (typeof log === "string") { try { log = JSON.parse(log); } catch (_) { log = null; } }
            if (Array.isArray(log)) digest_log = log.slice(-7).reverse();
          }
        }
      } catch (_) {}
      return res.status(200).json({ ok: true, ...out, digest, digest_log });
    }

    if (req.method === "POST") {
      // Stopping the digest. Only ever OFF from here: starting one requires the member to say what
      // it should cover, which is a conversation with Dr. NoVo, not a button (see api/_lib/tools.js).
      if (body.digest === false) {
        const r = await updateMemory(email, { digest: { on: false } });
        if (r && r.error) return res.status(503).json(r);
        const now = await listAlerts(email, app);
        return res.status(200).json({ ok: true, digest: null, ...(now.error ? {} : now) });
      }
      const id = String(body.cancel || "").trim();
      if (!id) return res.status(400).json({ error: "nothing to cancel" });
      const out = await cancelAlert(email, { id });
      if (out && out.error) return res.status(503).json(out);
      // Hand back the fresh list in the same round trip, so the page never renders a cancel it
      // has not had confirmed by the store.
      const now = await listAlerts(email, app);
      let digest2 = null;
      try {
        const m = await getMemory(email);
        const dg2 = (m && m.digest) || null;
        digest2 = (dg2 && (!app || !dg2.app || dg2.app === app)) ? dg2 : null;
      } catch (_) {}
      return res.status(200).json({ ok: true, cancelled: out.cancelled,
                                    ...(now.error ? {} : now), digest: digest2 });
    }

    res.setHeader("allow", "GET, POST");
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    console.error("[alerts]", e && e.message);
    return res.status(500).json({ error: "alerts unavailable" });
  }
};
