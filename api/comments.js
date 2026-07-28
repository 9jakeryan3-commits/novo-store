// Public community comments ("Market Discussion"). Unauthenticated → defended: HTML-escape, 2–500 chars,
// NO links (kills most spam), honeypot field, light profanity filter, and IP rate limits (3/10min, 15/day)
// via the shared Upstash limiter. Stored newest-first in a capped KV list. Owner moderation: GET ?hide=<id>&key=
// with OWNER_COMMENT_KEY set. Degrades to empty when KV is absent.

const { kv, rateOk } = require("./_kv");

const LIST = "mkt:comments";
const MAX = 200;
const BANNED = /\b(viagra|cialis|casino|porn|onlyfans|nigg|f[u\*]+ck|sh[i\*]t|c[u\*]nt|b[i\*]tch|whore)\b/i;
const LINKY = /https?:\/\/|www\.|t\.me\/|\b[a-z0-9-]+\.(com|net|org|io|xyz|ru|info|link|shop|co)\b/i;

const ip = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "0";
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mkId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

module.exports = async (req, res) => {
  const r = kv();

  if (req.method === "POST") {
    res.setHeader("Cache-Control", "no-store");
    let b = {};
    try { b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); } catch { b = {}; }
    if (b.website) return res.status(200).json({ ok: true }); // honeypot: bots fill it → silently accept + drop
    const name = esc(String(b.name || "").trim().slice(0, 24)) || "anon";
    const text = String(b.text || "").trim();
    const tag = b.tag === "bull" || b.tag === "bear" ? b.tag : "";
    if (text.length < 2 || text.length > 500) return res.status(400).json({ error: "Comment must be 2–500 characters." });
    if (LINKY.test(text)) return res.status(400).json({ error: "Links aren't allowed." });
    if (BANNED.test(text) || BANNED.test(name)) return res.status(400).json({ error: "Please keep it civil." });
    const ok1 = await rateOk(`mkt:cmt:rl:${ip(req)}`, 3, 600);
    const ok2 = await rateOk(`mkt:cmt:rl:d:${ip(req)}`, 15, 86400);
    if (!ok1 || !ok2) return res.status(429).json({ error: "Slow down — try again in a bit." });
    const c = { id: mkId(), name, text: esc(text), tag, ts: Date.now() };
    if (r) {
      try {
        await r.lpush(LIST, JSON.stringify(c));
        await r.ltrim(LIST, 0, MAX - 1);
      } catch {}
    }
    return res.status(200).json({ ok: true, comment: c });
  }

  // Owner moderation — hide a comment by id: /api/comments?hide=<id>&key=<OWNER_COMMENT_KEY>
  const q = req.query || {};
  if (req.method === "GET" && q.hide && process.env.OWNER_COMMENT_KEY && q.key === process.env.OWNER_COMMENT_KEY) {
    res.setHeader("Cache-Control", "no-store");
    if (r) {
      try {
        const all = await r.lrange(LIST, 0, MAX - 1);
        for (const s of all) {
          try { if (JSON.parse(s).id === q.hide) { await r.lrem(LIST, 1, s); break; } } catch {}
        }
      } catch {}
    }
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Cache-Control", "no-store");
  let out = [];
  if (r) {
    try {
      const all = await r.lrange(LIST, 0, 49);
      out = all.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
    } catch {}
  }
  return res.status(200).json({ comments: out });
};
