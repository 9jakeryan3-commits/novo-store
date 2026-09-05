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
   "gated field as zero or missing; it is withheld, not absent. Unknown coins return an empty " +
   "read, not an error.",
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

async function callTool(name, args, res, id) {
  const hit = TOOLS.find((t) => t[0] === name);
  if (!hit) return err(res, id, -32602, `unknown tool: ${name}`);
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
