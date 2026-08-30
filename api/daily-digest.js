// api/daily-digest.js — NoVo speaks first, personally.
//
// Once a day, every member who told NoVo what they follow (reader memory) AND has a push
// device registered gets a short personal brief on exactly those interests — their coins off
// the live crypto map, their tickers off the live dealer read. Nobody else gets anything:
// no interests means no digest, no device means no send. Market read only, never advice —
// the same boundary as every other word NoVo publishes.
//
// Runs on the Vercel cron (12:00 UTC daily). Auth: the cron's own bearer, or the analyst
// publish secret for a manual kick.

module.exports = async (req, res) => {
  const auth = String(req.headers["authorization"] || "");
  const cronOk = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secretOk = process.env.ANALYST_PUBLISH_SECRET &&
                   req.headers["x-analyst-secret"] === process.env.ANALYST_PUBLISH_SECRET;
  if (!cronOk && !secretOk) return res.status(401).json({ error: "unauthorized" });

  const { kv: kvf } = require("./_kv.js");
  const r = kvf();
  if (!r) return res.status(200).json({ ok: false, note: "kv unavailable" });
  const { getMemory } = require("./_lib/member-memory.js");
  const { vertex } = require("./_vertex.js");
  const MODEL = (process.env.GEMINI_MODEL || "gemini-3.6-flash").trim();

  let idx = [];
  try { idx = await r.smembers("mem:index"); } catch (_) { idx = []; }
  idx = (idx || []).slice(0, 100);

  let snap = null, live = null;
  try { snap = await r.get("crypto:map:live"); } catch (_) {}
  try { live = await r.get("analyst:live_levels"); } catch (_) {}
  if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch (_) { snap = null; } }
  if (typeof live === "string") { try { live = JSON.parse(live); } catch (_) { live = null; } }

  const webpush = require("web-push");
  const canPush = process.env.ANALYST_VAPID_PUBLIC && process.env.ANALYST_VAPID_PRIVATE;
  if (canPush) {
    webpush.setVapidDetails(process.env.ANALYST_VAPID_SUBJECT || "mailto:support@novo-options.trade",
      process.env.ANALYST_VAPID_PUBLIC, process.env.ANALYST_VAPID_PRIVATE);
  }

  let sent = 0, skipped = 0, errors = 0;
  for (const h of idx) {
    try {
      let email = null;
      try { email = await r.get("mem:e:" + h); } catch (_) {}
      if (!email) { skipped++; continue; }
      let subs = null;
      try { subs = await r.get("push:u:" + h); } catch (_) {}
      if (typeof subs === "string") { try { subs = JSON.parse(subs); } catch (_) { subs = null; } }
      if (!Array.isArray(subs) || !subs.length || !canPush) { skipped++; continue; }
      const mem = await getMemory(email);
      const interests = (mem && mem.interests) || [];
      if (!interests.length) { skipped++; continue; }

      // Assemble ONLY their interests' facts — the model narrates, it never invents.
      const facts = [];
      for (const it of interests) {
        const key = it.toUpperCase().replace(/[^A-Z0-9]/g, "");
        const t = live && (live.tickers || []).find((x) => x.ticker === key);
        if (t) facts.push({ ticker: key, spot: t.spot, flip: t.flip, callWall: t.callWall,
                            putWall: t.putWall, regime: t.regime });
        const c = snap && snap.coins && snap.coins[key];
        if (c) facts.push({ coin: key, price: c.price, band: c.band,
                            gamma: c.gamma ? { spot: c.gamma.spot, flip: c.gamma.flip_zone,
                                               netGex: c.gamma.net_gex } : null,
                            dvol: c.dvol || null });
      }
      if (!facts.length) { skipped++; continue; }

      const j = await vertex(`${MODEL}:generateContent`, {
        contents: [{ role: "user", parts: [{ text:
          "You are NoVo, the AI market analyst — first person, dry, precise, no advice, no " +
          "predictions, no emoji. Write a push-notification-sized personal brief (max 55 words) " +
          "for a reader who follows these, using ONLY the numbers given. Lead with the most " +
          "interesting fact.\nDATA: " + JSON.stringify(facts) }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 200,
                            thinkingConfig: { thinkingBudget: 0, includeThoughts: false } },
      }, "digest");
      const text = (j && j.candidates && j.candidates[0] && j.candidates[0].content &&
                    (j.candidates[0].content.parts || []).filter((p) => p.text && !p.thought)
                      .map((p) => p.text).join("").trim()) || null;
      if (!text) { errors++; continue; }
      for (const s of subs.slice(0, 5)) {
        try { await webpush.sendNotification(s, JSON.stringify({ title: "NoVo — your morning read", body: text.slice(0, 320), tag: "novo-digest" })); sent++; }
        catch (_) {}
      }
    } catch (_) { errors++; }
  }
  return res.status(200).json({ ok: true, members: idx.length, sent, skipped, errors });
};
