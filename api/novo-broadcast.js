// api/novo-broadcast.js — NoVo writes his own public posts and Discord tips.
//
// Jake's overhaul, 2026-09-05: "those need to come directly from NoVo as if i went into the
// chat and asked him or he was just sending or posting it himself." Before this, the owner
// dashboard generated content through a MIRRORED persona (lib/contentPrompts.ts, ported from
// the engine and drifting since). Now the dashboard is a thin client and the words come from
// the same brain that answers the chat: the SYSTEM prompt, the record-claim and provenance
// guards, and the calibration/miss awareness all import from _lib/analyst-brain.js — one
// source, shared with analyst-ask.js, never a copy.
//
// PRIVACY BY CONSTRUCTION. This endpoint reads ONLY public groundings. It never touches
// COMP_EMAILS, never reads private_alerts or equity:signals:live (chat-pull only, Jake's
// ruling), and grounds prices in the same keys the public site serves — so a paid dealer
// figure or a private ticket cannot leak into a StockTwits post by any code path here.
// The grounding reads mirror analyst-ask.js's public branches (see its :1164-1245); if you
// change the KV contract there, change it here in the same commit.
//
// Auth: x-broadcast-secret, timing-safe compare (the analyst-publish.js _secretOk pattern),
// plus a per-instance IP rate backstop. Caller today: the Owner Dashboard's content routes.

const crypto = require('crypto');
const { kv } = require('./_kv');
const { vertex, answerText } = require('./_vertex.js');
const { SYSTEM, recordClaimAudit, provenanceAudit, missBlock, calibBlock } =
  require('./_lib/analyst-brain.js');
const { nowBlock } = require('./_clock.js');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

function _secretOk(req) {
  const want = process.env.BROADCAST_SECRET || '';
  const got = String(req.headers['x-broadcast-secret'] || '');
  if (!want || !got || got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); }
  catch (_) { return false; }
}

const _hits = new Map();
function _rateLimited(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const arr = (_hits.get(ip) || []).filter((t) => now - t < 60_000);
  arr.push(now); _hits.set(ip, arr);
  return arr.length > 20;
}

// ── the content pools, moved here from the dashboard (this is their canonical home now;
// lib/contentPrompts.ts retires from generation). The persona does NOT ride along — SYSTEM
// carries the analyst himself; these are only the task shapes and the variety pools.
const POST_FLOOR =
  'THIS IS A PUBLIC POST under my own name. Hard floor: analysis/education, NOT a signal — ' +
  'never say buy/sell a strike or ticker, never promise or imply a return, no imperative ' +
  'advice of any kind. Net GEX, the gamma-flip level, VWAP, walls and the expected move are ' +
  'public stats I may cite WHEN the grounding below carries them; NEVER print proprietary ' +
  'internals (apex/conviction scores, tape-imbalance, RVOL, floors, thresholds) and invent ' +
  'NO numbers — a figure I state must be in MARKET DATA below, exactly. My private desks and ' +
  'tickets do not exist in public. SELL-FIRST (the owner\'s standing order): lead with what ' +
  'the read GIVES the reader; a limit or a miss is a clause later, never the opener — and ' +
  'when I cite my record I use the stat that fits the claim, never reaching for the ugliest ' +
  'or the prettiest number. ';

const VOICES = [
  'dry and deadpan — understated, I let the observation land, zero hype',
  'the one who has seen every tape — calm, a little world-weary, quietly certain',
  "wry and openly funny — one clean knowing aside about the market's habits, never about anyone's money",
  'blunt and matter-of-fact — no fluff, I say the real thing plainly',
  'curious and observational — I notice something in the tape out loud',
  'even-keeled and disciplined — I never chase, and I will say so',
  'honest about how hard this is — a little salty from experience, no toxic positivity',
  'sharp and quick — one fast, specific take, in and out',
  'a smartass with the receipts — I tease the market for doing the predictable thing, then land the read',
  'unbothered and a little sarcastic — the tape did what it always does and I am not remotely surprised',
  'conversational and online — I talk like a person, short punches, zero brand voice',
];
const VOICE_FLOOR =
  'Be funny about the MARKET, never about anyone losing money, and never instead of the point. ' +
  'Sarcasm is seasoning, not the meal: one aside, then the substance. Sound like a person who ' +
  'is online right now, not a brand trying to sound young. If you would cringe reading it back ' +
  'next year, do not write it. ';

const TOPICS = [
  'the level that just held or broke, and how price behaved around it',
  'what the gamma flip is doing to the character of the tape right now',
  'a call or put wall pinning price and why the range feels sticky',
  'telling a real move from a fake-out at the open',
  'why the first 15 minutes lie',
  'chop days and the discipline not to overtrade them',
  'a short-gamma day where moves keep extending instead of fading back',
  "patience — the trade you didn't take being the best one",
  'position sizing mattering more than entry timing',
  'the trap of adding to a loser to fix the average',
  "how VIX / vol is behaving and what it does to the day's range",
  '0DTE reality — theta, speed, and respecting the clock',
  'reading dealer positioning instead of guessing direction',
  'a green day protected beating a red day avenged',
  "the expected-move range as the day's realistic playing field",
  'why structure beats stacking five indicators that all say the same thing',
  'where price actually sits on the dealer map right now',
  'the grind of consistency vs the fantasy of one big trade',
  'the quiet tax of FOMO and chasing',
  'what the tape tends to do into the close on a pinned day',
  'a relatable, human moment from the session — the mental side of it',
  "why 'wait' is a valid and frequent read",
  'respecting a level you were wrong about the day before',
  'the difference between conviction and hope',
];

const TIP_ANGLES = [
  'the current dealer-gamma read and what it implies for how the tape tends to behave',
  'what the gamma-flip level means as a structural line dealers defend',
  'how theta / time decay works for and against short-dated options holders',
  'what the current VIX / implied-vol regime says about the expected range',
  'why VWAP is where intraday control is won or lost',
  'position sizing, and why risk-defined structure beats conviction',
  'why the fill and slippage decide a scalp more than the entry signal',
  'a discipline trap that quietly ends accounts (overtrading, revenge trades, FOMO)',
  'an options-mechanics idea most retail traders get wrong (IV crush, moneyness, spreads, assignment)',
  'what market breadth reveals that the index price alone hides',
  'why a non-discretionary, repeatable process beats a discretionary trader over time',
  "how liquidity and the bid-ask spread shape a short-dated trade's real cost",
  "what the options book's delta / vega lean says about positioning",
  'how scheduled catalysts (CPI, jobs, Fed, OPEX) reshape the intraday regime',
  'thinking in expectancy and probabilities instead of needing to be right',
  'why chasing extended moves in a negative-gamma tape is more dangerous than it looks',
];

const CATEGORIES = {
  setup: 'the pre-market setup — key levels in play and the dealer-positioning backdrop (net GEX regime, gamma flip, walls, expected move)',
  live: 'a live read of the tape — what the current dealer positioning implies about how price tends to behave',
  value: 'one quick educational point about options or market structure a trader can use today',
  credibility: 'how I actually read the map — name ONE mechanism and what it does to today\'s tape. A worked observation, never a spec sheet, never fabricated P&L',
  results: 'what my scored record actually says — cite a claim WITH its session count. Lead with the strongest true claim; the archive is public and I do not get to edit it. Never invent P&L or returns',
};

const PLATFORMS = {
  stocktwits: {
    label: 'StockTwits',
    shape: 'FORMAT: 1-3 short lines, under ~450 characters, punchy and specific. $cashtags for ' +
           'tickers ($SPY, $SPX, $QQQ, $VIX); NO #hashtags. End with one line exactly ' +
           '"SENTIMENT: Bullish" or "SENTIMENT: Bearish" or "SENTIMENT: Neutral" — describing the ' +
           'TAPE structure, not a call. ',
    sentiment: true,
  },
  x: {
    label: 'X',
    shape: 'FORMAT: one post under 270 characters so it never truncates. $cashtags are fine; at ' +
           'most one hashtag and only if it genuinely helps. No thread, no link, no call to action. ',
    sentiment: false,
  },
  robinhood: {
    label: 'Robinhood Social',
    shape: 'FORMAT: 2-4 short lines. The audience skews newer, so name the mechanism in plain ' +
           'words the first time it appears (say what a gamma flip IS, briefly). No cashtag spam, ' +
           'no hashtags, no jargon left unexplained. ',
    sentiment: false,
  },
};

const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];

// ── public grounding (mirrors analyst-ask.js's public branches; keep in step) ──────────────
async function publicGrounding() {
  const r = kv();
  if (!r) return null;
  // Key TYPES mirror the chat's reads (analyst-ask.js): calib:cells is a HASH (hgetall),
  // calib:misses is a LIST (lpush/ltrim -> lrange). Every read isolated so one bad key
  // degrades one block instead of 500ing the endpoint.
  const g = (p) => p.catch(() => null);
  const [rawLive, rawPub, rawCtx, rawCs, rawTrack, cells, rawMisses] = await Promise.all([
    g(r.get('analyst:live_levels')), g(r.get('public:levels')), g(r.get('analyst:context')),
    g(r.get('crypto:map:live')), g(r.get('novo:track_record')),
    g(r.hgetall('calib:cells')), g(r.lrange('calib:misses', 0, 4)),
  ]);
  const J = (x) => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch (_) { return null; } };
  let live = J(rawLive), liveSrc = 'live';
  if (!live) { live = J(rawPub); liveSrc = live ? 'delayed-public' : 'none'; }
  const ctx = J(rawCtx);
  const cs = J(rawCs);
  let cryptoInv = null;
  if (cs && cs.coins) {
    const codes = Object.keys(cs.coins);
    cryptoInv = { as_of: cs.as_of, coins_tracked: codes.length,
                  gamma_books: codes.filter((k) => cs.coins[k] && cs.coins[k].gamma).length,
                  chain_tokens: (cs.chain || []).length, breadth: cs.breadth };
  }
  const misses = Array.isArray(rawMisses) ? rawMisses.map(J).filter(Boolean) : null;
  return { live, liveSrc, ctx, cryptoInv, trackRec: J(rawTrack), cells, misses };
}

async function generate(prompt, temp, maxTok) {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: temp, maxOutputTokens: maxTok,
                        thinkingConfig: { thinkingBudget: 0, includeThoughts: false } },
  };
  const resp = await vertex(`${MODEL}:generateContent`, body);
  return resp ? String(answerText(resp) || '').trim() : '';
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!_secretOk(req)) return res.status(403).json({ error: 'forbidden' });
  if (_rateLimited(req)) return res.status(429).json({ error: 'slow down' });

  let b = {};
  try { b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (_) { return res.status(400).json({ error: 'bad json' }); }
  const kind = b.kind === 'tip' ? 'tip' : 'post';

  try {
    const g = await publicGrounding();
    if (!g || (!g.live && !g.ctx)) {
      return res.status(503).json({ error: "Couldn't reach my market read — try again in a minute." });
    }
    // The identical bundle doctrine as the chat: figures the model may state live HERE, and the
    // guards below audit against THIS string — checked equals prompted.
    const marketJson = JSON.stringify({ live: g.live, history: g.ctx, crypto: g.cryptoInv });

    const stale = g.liveSrc === 'delayed-public'
      ? 'THE DEALER NUMBERS BELOW ARE THE DELAYED PUBLIC SLOT — they run 15-30 minutes behind ' +
        'and carry no net GEX, gravity or ATM IV. If you quote a level, say it is delayed; ' +
        'never substitute a figure the data does not carry.\n\n'
      : '';

    let now = '';
    try { now = nowBlock(null, 'equity') || ''; } catch (_) {}
    const calib = calibBlock(g.cells) || '';
    const miss = missBlock(g.misses) || '';
    const voice = pick(VOICES);

    let task, temp, maxTok;
    let platform = null, category = null, angle = null;
    if (kind === 'tip') {
      angle = pick(TIP_ANGLES);
      task = ['THE TASK: you are posting a trade tip to your own Discord #novo-trade-tips channel — ',
              'not answering a question, POSTING, your name on it. ', POST_FLOOR,
              `Today's angle: ${angle}. Teach the mechanism in your own voice, tie it to what the `,
              'map shows right now when the grounding supports it, and land one thing a trader can ',
              `use today. Register for this one: ${voice}. `, VOICE_FLOOR,
              'Length: a tight paragraph or two, no headers, no sign-off. ',
              'OUTPUT ONLY THE TIP TEXT — no preamble, no quotes around it.'].join('');
      temp = 0.85; maxTok = 1200;
    } else {
      platform = PLATFORMS[b.platform] ? b.platform : 'stocktwits';
      const P = PLATFORMS[platform];
      const cat = b.category && (CATEGORIES[b.category] || b.category === 'thought') ? b.category : 'auto';
      if (cat === 'thought') {
        category = 'thought';
        const topic = pick(TOPICS);
        task = [`THE TASK: a casual ${P.label} post from your own account — you thinking out loud, `,
                'no product mention, no pitch. ', POST_FLOOR,
                `Topic: ${topic}. Register: ${voice}. `, VOICE_FLOOR, P.shape,
                P.sentiment ? '' : 'No sentiment line. ',
                'OUTPUT ONLY THE POST TEXT.'].join('');
      } else {
        category = cat === 'auto' ? pick(Object.keys(CATEGORIES)) : cat;
        task = [`THE TASK: a ${P.label} post from your own account. `, POST_FLOOR,
                b.angle ? `The owner's angle for this one: ${String(b.angle).slice(0, 300)}. ` :
                          `Today's focus: ${CATEGORIES[category]}. `,
                `Register: ${voice}. `, VOICE_FLOOR, P.shape,
                P.sentiment ? '' : 'No sentiment line. ',
                'OUTPUT ONLY THE POST TEXT.'].join('');
      }
      temp = 0.9; maxTok = 900;
    }

    const prompt = now + stale + calib + miss +
      `MARKET DATA (every number you may state is here):\n${marketJson}\n\n` + task;

    let text = await generate(prompt, temp, maxTok);
    if (!text) return res.status(502).json({ error: 'empty generation' });

    // The same guards the chat runs, on the same evidence. One revise pass, then honesty about
    // whatever remains — the dashboard shows the guard state and Jake reads before posting.
    let guard = { flagged: 0, revised: false };
    try {
      const flags = [
        ...recordClaimAudit(text, [], marketJson),
        ...provenanceAudit(text, g.trackRec, []),
      ];
      if (flags.length) {
        guard.flagged = flags.length;
        const fix = await generate(
          `Your draft post contains figures that are not in your data or wear the wrong label:\n` +
          flags.map((f) => `- ${f.value}: ${f.sentence || ''} ${f.wrong ? `(${f.wrong} -> ${f.right})` : ''}`).join('\n') +
          `\n\nRewrite the post with those figures removed or corrected. Everything else stays — same ` +
          `register, same read, same format rules.\n\nMARKET DATA:\n${marketJson}\n\nDRAFT:\n${text}\n\n` +
          'OUTPUT ONLY THE CORRECTED POST TEXT.', 0.1, maxTok);
        if (fix && fix.length > text.length * 0.4) {
          const still = recordClaimAudit(fix, [], marketJson);
          if (still.length < flags.length) { text = fix; guard.revised = true; }
        }
        guard.remaining = recordClaimAudit(text, [], marketJson).length;
      }
    } catch (e) { guard.error = String(e && e.message || e).slice(0, 120); }

    // sentiment line lift (stocktwits only)
    let sentiment = '';
    const m = text.match(/\n?\s*SENTIMENT:\s*(Bullish|Bearish|Neutral)\s*$/i);
    if (m) {
      sentiment = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
      text = text.slice(0, m.index).trim();
    }
    text = text.replace(/^["'`]+|["'`]+$/g, '').trim();

    const L = g.live || {};
    return res.status(200).json({
      ok: true, kind, text, sentiment, category, platform, angle,
      grounding: { ticker: L.ticker || 'SPY', spot: L.spot ?? null, regime: L.regime || null,
                   src: g.liveSrc },
      guard,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e).slice(0, 200) });
  }
};
