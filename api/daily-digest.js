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

// ── the grounding guard ────────────────────────────────────────────────────────────
// THIS SURFACE'S FAILURE MODE IS NOT A BAD FORECAST, IT IS A FABRICATED NUMBER. The digest does
// not predict anything — it narrates facts it was handed. So the forecasting research's ensemble
// (sample N, take the median) buys nothing here: averaging three narrations of the same numbers
// does not make the numbers righter, it just costs three times as much. What DOES apply is the
// claim-to-evidence binding half: this brief lands on a phone at 12:00 UTC with nobody watching,
// the reader cannot check it against anything, and one invented level is worth more damage than a
// hundred correct briefs are worth trust.
//
// So every number in the generated text must trace to a number in the facts it was given. The
// check is deterministic and free — no second model call — and it fails CLOSED into a template
// built from the same facts, so the member still gets their digest and it is true by construction.

function _nums(s) {
  // Numbers as a reader would write them: 767.54, 108,432, $80k, 0.08. Commas stripped, k/m
  // suffixes expanded, sign dropped (direction is words, not digits).
  const out = [];
  // The suffix must END the word, or "2 markets" reads as two million and every brief that
  // counts something trips the guard. Measured: that exact false positive.
  const re = /(\d[\d,]*(?:\.\d+)?)\s*([kmb])?(?![a-z0-9])/gi;
  let m;
  while ((m = re.exec(s))) {
    let v = parseFloat(m[1].replace(/,/g, ""));
    if (!isFinite(v)) continue;
    const suf = (m[2] || "").toLowerCase();
    if (suf === "k") v *= 1e3; else if (suf === "m") v *= 1e6; else if (suf === "b") v *= 1e9;
    out.push(v);
  }
  return out;
}

function _allowed(facts) {
  // Every fact value, at the roundings a writer would naturally use, PLUS the percentage
  // distances between values of the same fact — "0.08% above the flip" is derived, not invented,
  // and a guard that rejected it would reject the most useful sentence in the brief.
  // Every form a writer might legitimately render a fact value in — full precision, rounded to a
  // few decimals, cut to significant figures, or divided into k/M/B. The ROUNDING LIVES HERE, on
  // the trusted side. Doing it on the text side instead is what let an invented "3.9%" through:
  // rounded to zero decimals it became 4, and 4 was permitted as a small integer count.
  const set = new Set();
  const add = (v) => {
    if (typeof v !== "number" || !isFinite(v)) return;
    const a = Math.abs(v);
    set.add(a);
    for (const p of [0, 1, 2, 3]) set.add(Number(a.toFixed(p)));
    for (const p of [1, 2, 3]) set.add(Number(a.toPrecision(p)));
    // TRUNCATION, not just rounding. Measured against real output: 0.867% came back written as
    // "0.86%" — a writer cutting the decimal rather than rounding it, which is honest and common.
    for (const p of [0, 1, 2, 3]) {
      const f = Math.pow(10, p);
      set.add(Math.floor(a * f) / f);
    }
    for (const [d, n] of [[1e3, 1000], [1e6, 1e6], [1e9, 1e9]]) {
      if (a >= n) { set.add(Number((a / d).toFixed(1))); set.add(Number((a / d).toFixed(0))); }
    }
  };
  for (const f of facts) {
    const vals = Object.values(f).flatMap((v) =>
      (v && typeof v === "object") ? Object.values(v) : [v]).filter((v) => typeof v === "number");
    vals.forEach(add);
    // DERIVED PERCENTAGES ONLY BETWEEN A PRICE AND ONE OF ITS OWN LEVELS. Allowing every pairwise
    // ratio instead made the permitted set so dense that an invented "3.9% above the flip" landed
    // inside it — measured, and it is the exact false negative this guard exists to stop. A brief
    // says how far spot is from a level; it never says what net GEX is as a percentage of DVOL.
    const price = [f.spot, f.price, f.gamma && f.gamma.spot].find((v) => typeof v === "number");
    const levels = [f.flip, f.callWall, f.putWall,
                    f.gamma && f.gamma.flip, f.gamma && f.gamma.spot]
                   .filter((v) => typeof v === "number");
    // BOTH DENOMINATORS. "1.44% above the put wall" (vs the level) and "1.46% below the call
    // wall" (vs spot) are the same true distance expressed two defensible ways, and real output
    // used both — a guard that only knew one flagged the other as invented.
    if (typeof price === "number") {
      for (const lv of levels) if (lv) {
        add(Math.abs((price - lv) / lv) * 100);
        add(Math.abs((price - lv) / price) * 100);
        // And the same distance in POINTS — "0.61 above its flip" is the most natural way to say
        // it on an index, and it is arithmetic on two given numbers, not a new claim.
        add(Math.abs(price - lv));
      }
    }
  }
  return set;
}

function ungroundedNums(text, facts) {
  const ok = [..._allowed(facts)];
  const bad = [];
  for (const n of _nums(text)) {
    const a = Math.abs(n);
    // Small WHOLE numbers are counts, hours and dates — "both of your 2 markets". Exact integers
    // only: 3.9 is a market claim wearing a small number, and it must match a real value.
    if (Number.isInteger(a) && a <= 24) continue;
    // Otherwise it has to land on a permitted form, within a hair for float noise — NOT within a
    // rounding step, which is how a nearby invented level would sneak in.
    const hit = ok.some((v) => Math.abs(a - v) <= Math.max(0.005, Math.abs(v) * 1e-6));
    if (!hit) bad.push(n);
  }
  return bad;
}

function fallbackBrief(facts) {
  // Deterministic, and true by construction. Not an apology for the model — a brief built
  // straight from the numbers, which is what the reader was owed in the first place.
  const bits = [];
  for (const f of facts.slice(0, 3)) {
    if (f.ticker) {
      const p = [`${f.ticker} ${f.spot}`];
      if (f.flip) p.push(`flip ${f.flip}`);
      if (f.callWall) p.push(`call wall ${f.callWall}`);
      bits.push(p.join(", "));
    } else if (f.coin) {
      const p = [`${f.coin} ${f.price}`];
      if (f.gamma && f.gamma.flip) p.push(`flip ${f.gamma.flip}`);
      bits.push(p.join(", "));
    }
  }
  return bits.length ? `Where your map sits: ${bits.join(" · ")}.` : null;
}

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

      const write = async (temp) => {
        const j = await vertex(`${MODEL}:generateContent`, {
          contents: [{ role: "user", parts: [{ text:
            "You are NoVo, the AI market analyst — first person, dry, precise, no advice, no " +
            "predictions, no emoji. Write a push-notification-sized personal brief (max 55 words) " +
            "for a reader who follows these, using ONLY the numbers given. Every figure you write " +
            "must appear in DATA or be a percentage distance between two of its values — do not " +
            "round to a friendlier number and do not add a figure that is not there. Lead with " +
            "the most interesting fact.\nDATA: " + JSON.stringify(facts) }] }],
          generationConfig: { temperature: temp, maxOutputTokens: 200,
                              thinkingConfig: { thinkingBudget: 0, includeThoughts: false } },
        }, "digest");
        return (j && j.candidates && j.candidates[0] && j.candidates[0].content &&
                (j.candidates[0].content.parts || []).filter((p) => p.text && !p.thought)
                  .map((p) => p.text).join("").trim()) || null;
      };

      let text = await write(0.4);
      // One number that is not in the facts and the brief does not go out as written: retry once
      // colder, then fall back to the template. Nobody is watching this send, so the guard is the
      // only reader it has.
      let guard = null;
      if (text) {
        let bad = ungroundedNums(text, facts);
        if (bad.length) {
          guard = "retried";
          const second = await write(0.1);
          const bad2 = second ? ungroundedNums(second, facts) : ["no text"];
          if (second && !bad2.length) { text = second; }
          else { text = fallbackBrief(facts); guard = "fallback"; }
        }
      } else {
        text = fallbackBrief(facts);
        guard = "fallback";
      }
      if (guard) console.log(`[DIGEST] grounding guard: ${guard}`);
      if (!text) { errors++; continue; }
      for (const s of subs.slice(0, 5)) {
        try { await webpush.sendNotification(s, JSON.stringify({ title: "NoVo — your morning read", body: text.slice(0, 320), tag: "novo-digest" })); sent++; }
        catch (_) {}
      }
    } catch (_) { errors++; }
  }
  return res.status(200).json({ ok: true, members: idx.length, sent, skipped, errors });
};
