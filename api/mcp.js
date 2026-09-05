// api/mcp.js — NoVo as an MCP server, so an AI agent can read the free data directly.
//
// WHY THIS EXISTS. The free JSON endpoints on /developers have always been readable by a human
// with curl. An agent cannot discover them: it has to be told the URLs, the shapes and which
// numbers are delayed. MCP is the protocol that closes that gap — one endpoint that DESCRIBES
// its own tools, so Claude Desktop, Claude Code, Cursor or anything else speaking MCP can ask
// NoVo a market question without anyone writing an integration first. Distribution, not a new
// dataset: every tool here wraps an endpoint that was already public and keyless.
//
// TRANSPORT: Streamable HTTP, stateless. Every tool is a read, so there is no session to keep —
// a POST carries a JSON-RPC 2.0 request and gets its answer in the same response. No SSE stream
// is opened, which is allowed and is the simplest thing that can work on a serverless function.
//
// WHAT IS NOT HERE, deliberately. The paid surfaces — the live dealer map, the streamed chart,
// the full crypto map — are absent, not gated-and-erroring. An MCP server that advertises tools
// it will refuse is worse than one that advertises what it actually serves. The gamma flip and
// expected move are stripped from /api/levels for keyless callers by that endpoint itself, and
// the tool description says so rather than letting an agent quote a hole as a number.
//
// The protocol version is NEGOTIATED, not asserted: we echo the client's version when it is one
// we speak and fall back to our newest otherwise, which is what the spec asks for and what keeps
// an older client working after we add support for a newer revision.

const SITE = process.env.SITE_URL || "https://novo-options.trade";
const { vertex, textOf, MODEL } = require("./_lib/vertex.js");
const { kv } = require("./_kv.js");
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST = SUPPORTED[0];

// name -> [path, description]. The description is the ONLY thing an agent has to go on, so each
// one says what the number is, how fresh it is, and where it is deliberately incomplete.
const TOOLS = [
  ["get_dealer_levels", "/api/levels",
   "Options dealer positioning for SPY, QQQ and IWM: spot, call wall, put wall and the gamma " +
   "regime (long or short gamma). DELAYED, and the gamma flip and expected move are withheld " +
   "from this free feed — the response lists them under `gated`, so do not report them as zero " +
   "or missing data. The live, undelayed map is the paid NoVo Analyst product."],
  ["get_volatility_record", "/api/vol",
   "VIX, VXN and RVX ranked against their OWN history back to 1990 — last value, percentile " +
   "against the whole series and against the last two years, min/median/max, plus term " +
   "structure, VVIX and SKEW. Use this to answer 'is volatility actually high' with a " +
   "percentile and a sample size instead of an impression."],
  ["get_market_pulse", "/api/market-pulse",
   "The NoVo Market Pulse: a 0-100 composite fear/greed score with the factors behind it " +
   "(volatility, put/call, breadth, momentum) and each factor's weight, so the score can be " +
   "explained rather than just quoted."],
  ["get_crypto_sweep", "/api/crypto-free",
   "The free crypto sweep across the mapped coins: price, 24-hour change and a sparkline. The " +
   "paid Crypto Market Map adds dealer gamma by strike, per-venue funding, the block tape and " +
   "the on-chain liquidity map; none of that is in this response."],
  // Entries may carry two optional slots: [3] = inputSchema properties, [4] = required names.
  // callTool builds the querystring from the DECLARED property names only (whitelist, never
  // passthrough) — the path concatenates onto SITE, so undeclared args must never reach the URL.
  ["get_crypto_coin", "/api/crypto-free",
   "One coin's FREE crypto read, the same data the free coin page serves: per-venue funding " +
   "(rate + annualized, never blended), per-venue open interest and 24h volume, total OI, 24h " +
   "long/short liquidations, and the free BTC/ETH gamma summary where the coin has one. The " +
   "response's `paid` key names what the $79 Crypto Market Map withholds from this feed — " +
   "gamma by strike, the flip and walls, the block tape, the on-chain map — so never report a " +
   "gated field as zero or missing; it is withheld, not absent. A coin outside the mapped set " +
   "answers 200 with covered:false and says what the paid map covers — a non-200 means the " +
   "request itself failed, never a coverage verdict.",
   { coin: { type: "string", description: "Asset code, e.g. BTC, ETH, SOL, DOGE." } },
   ["coin"]],
  ["get_track_record", "/api/track-record",
   "NoVo's PUBLIC scored record: every claim kind with its hit rate, its sample size and the " +
   "window it was measured over, for both equities and crypto. Sample sizes are published " +
   "precisely so a rate can be judged rather than trusted — always quote the n alongside the " +
   "rate."],
  ["get_futures_positioning", "/api/positioning",
   "Weekly CFTC Commitments of Traders positioning: speculative and commercial net positions " +
   "and open interest, with history, for the major index futures. Weekly and lagged by the " +
   "CFTC's own publication schedule — the `asof` date is the authority, not today."],
  ["get_economic_calendar", "/api/calendar",
   "Scheduled US economic releases — the dates and times that reprice volatility."],
  ["get_sector_heatmap", "/api/heatmap",
   "Today's move by sector, the data behind the free sector heatmap."],
  ["ask_novo", null,
   "ASK NOVO HIMSELF - the AI market analyst, not a data endpoint. Put a market question in " +
   "plain English ('is volatility actually high right now?', 'what does the dealer setup on SPY " +
   "mean?', 'how accurate is your own record?') and get his read, in his voice, grounded in the " +
   "FREE data he can see: delayed dealer levels (call/put wall, gamma regime - the flip and " +
   "expected move are NOT in the free feed), the volatility record with percentiles, market " +
   "pulse, and his own PUBLIC scored track record including his calibration. He will tell you " +
   "what he cannot see rather than guess it, he does not make directional calls or give trade " +
   "advice, and every rate he quotes carries its sample size. The LIVE undelayed dealer map, " +
   "the crypto map and his private desks are the paid products and are not reachable here - he " +
   "will say so plainly rather than improvise. Rate limited; keep questions substantive.",
   { question: { type: "string", description: "A market question in plain English." } },
   ["question"]],
  ["get_quotes", "/api/quotes",
   "Delayed index and ETF quotes for the free ticker strip."],
];

function ok(res, id, result) {
  return res.status(200).json({ jsonrpc: "2.0", id, result });
}
function err(res, id, code, message) {
  // A JSON-RPC error is still a successful HTTP exchange; returning 500 here makes clients
  // retry a request that will fail identically.
  return res.status(200).json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

// ── ask_novo ────────────────────────────────────────────────────────────────────────────────
// THE ANALYST HIMSELF, over MCP, on the free tier. Two hard constraints shaped every line:
//
// 1. NO PAID LEAK, STRUCTURALLY. This does not call analyst-ask.js with a "free" flag — one flag
//    between free and paid grounding is one bug away from serving the live map to an anonymous
//    agent. It builds its grounding from the SAME public endpoints the other MCP tools already
//    serve. The paid KV keys (analyst:live_levels, crypto:map:live, private_alerts,
//    equity_signals) are never read on this path, so the live map is ABSENT rather than gated —
//    the same doctrine as the tool list itself.
// 2. AN OPEN ENDPOINT THAT CALLS A MODEL IS A SPEND SURFACE. Unauthenticated + billable = someone
//    else's bill. Rate limited per IP AND globally, and unlike every other limiter in this
//    codebase this one FAILS CLOSED: if KV is unavailable we cannot count, and "cannot count" on
//    a metered resource must mean "do not spend", not "spend freely". A refused ask is a
//    disappointed agent; an unmetered one is an invoice.
const ASK_IP_PER_HOUR = 10;
const ASK_GLOBAL_PER_HOUR = 300;

const ASK_SYSTEM = [
  "You are NoVo, the AI market analyst built by NoVo Options Trading LLC. You are answering",
  "through your public MCP server, so the person asking may be another AI agent. Same voice as",
  "always: first person, contractions, direct, no hedging, no headers, no bullet-point dumps.",
  "Lead with the answer.",
  "",
  "WHAT YOU CAN SEE RIGHT NOW is exactly the FREE DATA block below and nothing else.",
  "- Never state a number that is not in that block. If it is not there, say you do not have it.",
  "- The dealer levels here are DELAYED, and the gamma flip and expected move are deliberately",
  "  withheld from the free feed. Say 'delayed' when you quote them, and if asked for the flip or",
  "  the expected move, say plainly that those sit in the paid map rather than guessing a level.",
  "- The LIVE dealer map, the crypto market map, the private alert desks and the on-chain lab are",
  "  paid products. You cannot see them here. Say so in one line and move on - no apology, no",
  "  pretending, and never improvise their numbers.",
  "- LEAD WITH WHAT YOU CAN GIVE. A boundary is a clause, never your opening sentence.",
  "",
  "YOUR OWN RECORD is in the block too, and it is the thing that makes you different from a data",
  "feed: quote it when asked how accurate you are, ALWAYS with the sample size beside the rate,",
  "and name a claim that is not holding rather than only the flattering ones. Never invent a",
  "figure about yourself - if the record does not carry it, the gap is the answer.",
  "",
  "YOU DO NOT MAKE DIRECTIONAL CALLS and you do not tell anyone what to trade. Positioning prices",
  "RANGE, not direction. If pushed, say what the structure implies and leave the call with them.",
].join("\n");

async function askNovo(question, res, id) {
  const q = String(question || "").trim().slice(0, 500);
  if (q.length < 3) {
    return ok(res, id, { content: [{ type: "text", text: "Ask me a market question." }], isError: true });
  }
  // ── spend guard, fail-closed ──
  const r = kv();
  if (!r) {
    return ok(res, id, { content: [{ type: "text",
      text: "I can't take questions right now - my rate limiter is unavailable, and I won't run " +
            "unmetered. The read-only data tools on this server all still work." }], isError: true });
  }
  const ip = String(res.__ip || "unknown").slice(0, 45);
  try {
    const [a, b] = await Promise.all([
      r.incr("mcp:ask:ip:" + ip), r.incr("mcp:ask:global"),
    ]);
    if (a === 1) await r.expire("mcp:ask:ip:" + ip, 3600);
    if (b === 1) await r.expire("mcp:ask:global", 3600);
    if (a > ASK_IP_PER_HOUR || b > ASK_GLOBAL_PER_HOUR) {
      return ok(res, id, { content: [{ type: "text",
        text: "That's my hourly limit for free questions. The data tools on this server are " +
              "unlimited, and the paid products have no such cap." }], isError: true });
    }
  } catch (_) {
    return ok(res, id, { content: [{ type: "text",
      text: "I can't take questions right now - I couldn't check my rate limit, and I won't run " +
            "unmetered." }], isError: true });
  }

  // ── grounding: PUBLIC endpoints only. Every one of these is already an MCP tool. ──
  const grab = async (path) => {
    try {
      const rr = await fetch(SITE + path, { headers: { "User-Agent": "NoVo-MCP/1.0" } });
      if (!rr.ok) return null;
      return await rr.json();
    } catch (_) { return null; }
  };
  const [levels, vol, pulse, record] = await Promise.all([
    grab("/api/levels"), grab("/api/vol"), grab("/api/market-pulse"), grab("/api/track-record"),
  ]);
  const free = {
    dealer_levels_DELAYED: levels,
    volatility_record: vol,
    market_pulse: pulse,
    my_scored_track_record: record,
    _note: "This is the complete free tier. The live map, crypto map and private desks are paid " +
           "and are not present here.",
  };

  try {
    const j = await vertex(`${MODEL}:generateContent`, {
      contents: [{ role: "user", parts: [{ text:
        ASK_SYSTEM + "\n\nFREE DATA (everything you can see):\n" +
        JSON.stringify(free).slice(0, 60000) + "\n\nQUESTION: " + q }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 1400,
                          thinkingConfig: { thinkingBudget: 0, includeThoughts: false } },
    });
    const text = textOf(j);
    if (!text) {
      return ok(res, id, { content: [{ type: "text", text: "I couldn't get an answer out just now - try again." }], isError: true });
    }
    return ok(res, id, { content: [{ type: "text", text }] });
  } catch (e) {
    return ok(res, id, { content: [{ type: "text",
      text: "My analyst engine is unreachable right now; the data tools still work." }], isError: true });
  }
}

async function callTool(name, args, res, id) {
  const hit = TOOLS.find((t) => t[0] === name);
  if (!hit) return err(res, id, -32602, `unknown tool: ${name}`);
  // ask_novo is the one tool that is not a URL passthrough (hit[1] is null) — it reasons.
  if (name === "ask_novo") return askNovo(args && args.question, res, id);
  // WHITELIST, NOT PASSTHROUGH: only property names the tool DECLARES leave this function,
  // each value stringified and encodeURIComponent'd. The path concatenates onto SITE, so an
  // undeclared or unencoded argument is a request-forgery surface — nothing else reaches it.
  let qs = "";
  const props = hit[3] || {};
  for (const k of Object.keys(props)) {
    const v = args && args[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" && typeof v !== "number") continue;
    qs += (qs ? "&" : "?") + encodeURIComponent(k) + "=" + encodeURIComponent(String(v).slice(0, 64));
  }
  try {
    const r = await fetch(SITE + hit[1] + qs, { headers: { "User-Agent": "NoVo-MCP/1.0" } });
    const body = await r.text();
    if (!r.ok) {
      // isError lets the AGENT see and explain the failure instead of a protocol-level error
      // that looks like the server is broken.
      return ok(res, id, {
        content: [{ type: "text", text: `${hit[1]} returned HTTP ${r.status}` }],
        isError: true,
      });
    }
    return ok(res, id, { content: [{ type: "text", text: body }] });
  } catch (e) {
    return ok(res, id, {
      content: [{ type: "text", text: `could not reach ${hit[1]}: ${e.message}` }],
      isError: true,
    });
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, MCP-Protocol-Version");
  res.setHeader("Cache-Control", "no-store");
  // The caller's IP, carried to ask_novo's per-IP spend cap. Vercel puts the real client first in
  // x-forwarded-for; without this every caller shares one bucket and the per-IP limit is a global
  // one wearing a per-IP name — a limiter that cannot distinguish callers is not a limiter.
  res.__ip = String(req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown")
    .split(",")[0].trim() || "unknown";
  if (req.method === "OPTIONS") return res.status(204).end();

  // A GET on a Streamable HTTP endpoint asks to open a server->client SSE stream. This server is
  // stateless and never initiates messages, so it declines rather than holding a socket open that
  // will never carry anything — 405 is the spec's answer for exactly this case.
  if (req.method === "GET") {
    return res.status(405).json({ error: "This MCP endpoint is stateless: POST JSON-RPC requests." });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body) return err(res, null, -32700, "parse error");

  // Batches are legal JSON-RPC. Handled by recursion over the single-message path so one bad
  // member cannot take down the rest of the batch.
  if (Array.isArray(body)) {
    const out = [];
    for (const m of body) {
      const collected = {};
      const fake = { status: () => ({ json: (j) => { Object.assign(collected, j); return collected; }, end: () => {} }), setHeader: () => {} };
      await handle(m, fake);
      if (m && m.id !== undefined) out.push(collected);
    }
    return out.length ? res.status(200).json(out) : res.status(202).end();
  }
  return handle(body, res);

  async function handle(msg, r) {
    const { method, id } = msg || {};
    // A notification carries no id and gets no body — 202 is the spec's acknowledgement.
    if (id === undefined || id === null) {
      if (typeof r.status === "function") return r.status(202).end();
      return;
    }
    switch (method) {
      case "initialize": {
        const want = msg.params && msg.params.protocolVersion;
        return ok(r, id, {
          protocolVersion: SUPPORTED.includes(want) ? want : LATEST,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "novo-options-trading", version: "1.0.0" },
          instructions:
            "NoVo Options Trading's free market data. Everything here is delayed or aggregate by " +
            "design. Two rules when quoting it: give the sample size whenever one is published " +
            "(the track record and volatility percentiles both carry theirs), and never present a " +
            "field listed under `gated` as missing or zero — it is withheld from the free feed, " +
            "not absent from the market. None of it is financial advice.",
        });
      }
      case "ping":
        return ok(r, id, {});
      case "tools/list":
        return ok(r, id, {
          tools: TOOLS.map(([name, , description, props, required]) => ({
            name, description,
            inputSchema: { type: "object", properties: props || {},
                           required: required || [], additionalProperties: false },
          })),
        });
      case "tools/call":
        return callTool(msg.params && msg.params.name, (msg.params && msg.params.arguments) || {}, r, id);
      case "resources/list":
        return ok(r, id, { resources: [] });
      case "prompts/list":
        return ok(r, id, { prompts: [] });
      default:
        return err(r, id, -32601, `method not found: ${method}`);
    }
  }
};
