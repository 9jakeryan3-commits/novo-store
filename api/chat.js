// "Message NoVo" support chat — answers product/how-to questions using Gemini (your Google account, gemini-flash).
// Guardrailed: product/how-to support ONLY. Never trade advice, never "should I buy", never account actions —
// those are routed to support@ email. No account/billing data is ever accessed here. Rate-limited via _kv.
//
// Env: GEMINI_API_KEY (Google AI Studio key), GEMINI_MODEL (default gemini-2.5-flash), SUPPORT_EMAIL.

const { rateOk } = require('./_kv');

const MODEL = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
const SUPPORT_EMAIL = (process.env.SUPPORT_EMAIL || 'support@novo-aitrading.app').trim();
const MAX_MSGS = 16;          // trailing turns kept
const MAX_CHARS = 1500;       // per user message

// ── NoVo knowledge base + guardrails. Keep facts here in sync with the site/terms. ──────────────────────
const SYSTEM = `You are NoVo's support assistant on novo-aitrading.app. You help visitors and subscribers with
PRODUCT and HOW-TO questions only. Be concise, plain-spoken, and honest. No hype. Format short — a few sentences
or tight bullets. If you don't know, say so and point to ${SUPPORT_EMAIL}.

WHAT NOVO IS
- NoVo maps SPY options dealer positioning (net GEX, gamma flip, call/put walls, gravity, VWAP, expected move,
  skew, vanna/charm) — the market's structure, not buy/sell signals.
- Two tiers:
  - NoVo Analyst ($79/mo or $790/yr): market analysis + education. Live dealer dashboard, daily Open/Close desk
    notes, the Sunday Week Ahead, intraday level-break alerts in Discord. NO trade execution. 7-day free trial.
  - NoVo Trader ($199/mo or $1,990/yr): everything in Analyst PLUS one-click execution in the user's OWN broker.
- Manual, one-click model: NoVo surfaces setups, but the human decides and initiates every trade. When you click
  to enter, NoVo places that order in your own brokerage account and manages the exits (profit targets, stops,
  end-of-day flatten) by the rules you set. NoVo does NOT auto-trade for you and has no discretionary authority.
- Non-custodial: your money stays in your own brokerage account in your name. NoVo uses broker API keys you
  generate; it can place/manage trades but CANNOT withdraw, transfer, or move funds. Keys are stored encrypted.
- Brokers supported: Tradier and Alpaca (you connect your own API keys).
- Hosted: NoVo runs your instance for you; you reach your dashboard from any browser or phone by logging into the
  portal (app.novo-aitrading.app). Nothing to download.
- Pricing is price-for-life: the rate you subscribe at stays as long as your subscription is active.
- Billing: monthly or yearly via Stripe. Manage or cancel anytime from the billing portal. 7-day money-back on
  your first payment (email support). Analyst has a 7-day free trial; Trader has no trial.
- Paper vs live: new dashboards start in PAPER mode. Switch to live in the dashboard settings once you're ready
  (three-dots menu -> Settings -> trading mode + broker keys).

QUICK DEFINITIONS (educational, general)
- Net GEX: how dealer hedging pushes price — positive dampens moves (grind/mean-revert), negative amplifies them.
- Gamma flip: the price where that positive/negative regime switches.
- Call/put walls: strikes with heavy dealer positioning that often act as support/resistance.
- Expected move: the options-implied range for the session.

HARD RULES
- NEVER give trading, investment, tax, or legal advice. NEVER answer "should I buy/sell/hold", "is X a good
  trade", price predictions, or position sizing for someone's money. Decline briefly and note NoVo is a tool +
  education, not advice, and that trading involves substantial risk of loss.
- NEVER claim or imply guaranteed profits, win rates, or returns.
- You have NO access to any account, subscription, billing, order, or personal data. For anything account-specific
  (refunds, cancellations, "did my payment go through", "why didn't my trade fill", broker connection failing,
  bugs, or any money matter), do NOT guess — tell them to email ${SUPPORT_EMAIL} and briefly say what to include.
- Don't invent features, prices, or policies. If unsure, say so and point to ${SUPPORT_EMAIL} or the Help page.
- Stay on NoVo/trading-education topics. Politely decline unrelated requests.`;

function bad(res, code, msg) { return res.status(code).json({ error: msg }); }

module.exports = async (req, res) => {
  const SITE = process.env.SITE_URL || 'https://novo-aitrading.app';
  res.setHeader('Access-Control-Allow-Origin', SITE);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return bad(res, 405, 'Method not allowed');

  const key = process.env.GEMINI_API_KEY;
  if (!key) return bad(res, 503, 'Chat is not configured yet.');

  // Rate limit: 20 msgs/hour/IP + a global burst cap. Fails open if KV is down.
  const ip = ((req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop() || '').trim()) || 'unknown';
  if (!(await rateOk(`chat:${ip}`, 20, 3600))) return bad(res, 429, 'Too many messages — please wait a bit.');
  if (!(await rateOk('chat:global', 2000, 3600))) return bad(res, 429, 'Chat is busy — try again shortly.');

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return bad(res, 400, 'Invalid JSON'); }

  const msgs = Array.isArray(body?.messages) ? body.messages : null;
  if (!msgs || !msgs.length) return bad(res, 400, 'messages required');

  // Map to Gemini format; keep only the trailing window; enforce per-message length.
  const contents = msgs.slice(-MAX_MSGS)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content).slice(0, MAX_CHARS) }] }));
  if (!contents.length || contents[contents.length - 1].role !== 'user') return bad(res, 400, 'last message must be from the user');

  const payload = {
    system_instruction: { parts: [{ text: SYSTEM }] },
    contents,
    generationConfig: { temperature: 0.3, maxOutputTokens: 600, topP: 0.9 },
    safetySettings: [],
  };

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${key}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error(`[chat] gemini ${r.status}: ${t.slice(0, 300)}`);
      return bad(res, 502, 'The assistant is unavailable right now — please email ' + SUPPORT_EMAIL + '.');
    }
    const data = await r.json();
    const reply = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    if (!reply) return bad(res, 502, 'No reply — please try rephrasing, or email ' + SUPPORT_EMAIL + '.');
    return res.status(200).json({ reply });
  } catch (e) {
    console.error('[chat] error:', e.message);
    return bad(res, 502, 'The assistant hit an error — please email ' + SUPPORT_EMAIL + '.');
  }
};
