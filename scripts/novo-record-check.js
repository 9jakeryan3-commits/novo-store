/* Exercise novoRecord() against a fake Upstash client, with the REAL module loaded — not a
   reimplementation of it. Every case is one the live data can produce. */
process.env.KV_REST_API_URL = "http://fake";
process.env.KV_REST_API_TOKEN = "fake";

const store = { hash: {}, str: {}, lists: {} };
const fake = {
  async get(k) { return store.str[k] ?? null; },
  async set(k, v) { store.str[k] = v; return "OK"; },
  async setnx(k, v) { if (k in store.str) return 0; store.str[k] = v; return 1; },
  async hgetall(k) { return store.hash[k] ? { ...store.hash[k] } : null; },
  async hincrby(k, f, n) { store.hash[k] = store.hash[k] || {}; store.hash[k][f] = (store.hash[k][f] || 0) + n; return store.hash[k][f]; },
  async rpush(k, v) { (store.lists[k] = store.lists[k] || []).push(v); return store.lists[k].length; },
};
require.cache[require.resolve("C:/Trading Algo/novo-store/api/_kv.js")] = {
  id: "fakekv", filename: "fakekv", loaded: true,
  exports: { kv: () => fake, kvReady: () => true, claimOnce: async () => true, rateOk: async () => true, releaseClaim: async () => {} },
};
const P = require("C:/Trading Algo/novo-store/api/_lib/predictions.js");

const row = (source, hit, status = "graded") => ({
  id: Math.random().toString(16).slice(2, 8), source, asset_class: "equity", symbol: "SPY",
  kind: "direction", side: "up", spot_at: 100, horizon_utc: Date.now() - 1000, status,
  outcome: status === "void" ? { reason: "holiday" } : { hit, actual: 101, graded_utc: Date.now() },
});

(async () => {
  // 12 graded rows: novo 5 (3 hit), read 4 (2 hit), conversation 2 (0 hit), user 1 (must be ignored)
  const list = [
    row("novo", true), row("novo", true), row("novo", true), row("novo", false), row("novo", false),
    row("read", true), row("read", true), row("read", false), row("read", false),
    row("conversation", false), row("conversation", false),
    row("user", true),
    row("novo", null, "void"),
    { ...row("novo", true), status: "open" },
  ];
  store.str["pred:log"] = JSON.stringify(list);

  const a = await P.novoRecord();
  const ok = [];
  const t = (name, cond) => ok.push([name, !!cond]);

  t("all-time counted 11 graded non-user rows", a.counted === 11);
  t("novo 5 rows, 3 hits, 60.0%", a.by_source.novo && a.by_source.novo.n === 5 && a.by_source.novo.rate === 60);
  t("read 4 rows, 2 hits, 50.0%", a.by_source.read && a.by_source.read.n === 4 && a.by_source.read.rate === 50);
  t("conversation 2 rows, 0 hits, 0.0%", a.by_source.conversation && a.by_source.conversation.rate === 0);
  t("the MEMBER's row is excluded", !a.by_source.user);
  t("the void row is not scored", a.by_source.novo.n === 5);
  t("the void row is still counted as void", a.voided === 1);
  t("the open row is reported open, not graded", a.open === 1);
  t("overall = 5/11", a.overall && a.overall.n === 11 && a.overall.hit === 5);
  t("rolling window agrees with all-time on first run", a.window.n === 11);

  // THE CONTROL THAT CATCHES THE BUG THIS FUNCTION SHIPPED WITH: the grade lives on
  // p.outcome.hit. Move it to p.hit -- the shape the first version read -- and the result must
  // COLLAPSE. If this still passes, the function is reading the wrong field and getting lucky.
  store.hash = {}; store.str = {}; store.lists = {};
  // DEEP copy. {...p} shares the `outcome` object, so deleting outcome.hit here mutated the
  // shared rows and poisoned the idempotence case below -- every row read as void. The test was
  // contaminating itself, which is exactly the failure a control is supposed to expose.
  store.str["pred:log"] = JSON.stringify(JSON.parse(JSON.stringify(list)).map((p) => {
    if (p.outcome && "hit" in p.outcome) { p.hit = p.outcome.hit; delete p.outcome.hit; } return p;
  }));
  const b = await P.novoRecord();
  t("CONTROL: with the grade on p.hit instead, the record collapses to 0", b.counted === 0);

  // idempotence: a second call must not double the tally
  store.hash = {}; store.str = {}; store.lists = {};
  store.str["pred:log"] = JSON.stringify(list);
  await P.novoRecord();
  const c = await P.novoRecord();
  t("seed is idempotent — second call does not double", c.counted === 11);

  let bad = 0;
  for (const [name, pass] of ok) { if (!pass) bad++; console.log("  %s  %s", pass ? "PASS" : "FAIL", name); }
  console.log("\n  " + (bad ? bad + " FAILED" : "all " + ok.length + " pass"));
  process.exitCode = bad ? 1 : 0;
})();
