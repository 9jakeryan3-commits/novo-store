// Public Bull/Bear sentiment poll. One vote per IP per UTC day (KV NX key). GET → today's tally; POST → vote.
// Degrades gracefully to a zero tally when KV isn't configured (never errors the page).

const { kv } = require("./_kv");

const today = () => new Date().toISOString().slice(0, 10);
const ip = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "0";
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const r = kv();
  const day = today();
  const kB = `mkt:sent:${day}:bull`, kR = `mkt:sent:${day}:bear`;
  const tally = async () => {
    if (!r) return { bull: 0, bear: 0 };
    const [b, be] = await Promise.all([r.get(kB), r.get(kR)]);
    return { bull: Number(b || 0), bear: Number(be || 0) };
  };

  if (req.method === "POST") {
    let b = {};
    try { b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); } catch { b = {}; }
    const side = b.side;
    if (side !== "bull" && side !== "bear") return res.status(400).json({ error: "bad side" });
    if (r) {
      const first = await r.set(`mkt:sent:voted:${day}:${hash(ip(req))}`, "1", { nx: true, ex: 172800 });
      if (first === "OK" || first === true) await r.incr(side === "bull" ? kB : kR);
    }
    return res.status(200).json({ ...(await tally()), voted: true });
  }
  return res.status(200).json(await tally());
};
