// api/_lib/upsell.js — the one place the crypto→Analyst pitch is decided and worded.
//
// THE RULE THIS IMPLEMENTS (Jake, 2026-09-01, after reversing an earlier gating design):
// a crypto-only member who asks about equities still gets a real answer. Nothing is blocked,
// nothing is degraded, no tool is withheld. What they do not get is the equity MAP — that is
// the paid artifact — so when the conversation wanders onto equities we say, once, that the
// map lives in Analyst + Crypto, and give them a button.
//
// "Better than free, but still just text, no map, only when they ask, and pushes the upgrade
// on them." That sentence is the whole specification.
//
// THREE DESIGN CHOICES WORTH THE WORDS, because each one is a trap avoided:
//
//   1. THE PRICE IS NOT IN THE MODEL'S MOUTH. The model gets a one-line nudge with no number
//      in it; the number rides in a structured field the client renders. A price a language
//      model recites is a price that drifts the day it changes, and a wrong price quoted by
//      our own analyst to a paying member is worse than no pitch at all. Same reason the CTA
//      is a rendered button rather than a URL in prose: the panel emits text nodes, so a typed
//      URL arrives as dead, unclickable text.
//
//   2. IT FAILS OPEN. Entitlement is tri-state; only a definite 'deny' arms the pitch. If
//      Stripe is unreachable we say nothing. Advertising the bundle to somebody who already
//      bought the bundle, because our own dependency blinked, is the one outcome here that
//      actually costs trust.
//
//   3. IT FIRES ONCE A SITTING, NOT ONCE A MESSAGE. An upsell on every reply is not a pitch,
//      it is a nag, and the member is already paying us.

const { entitlements } = require("./entitlements.js");
const { eh } = require("./member-memory.js");

// Six hours, not the 45-minute SEEN_STALE_MIN the "what changed since you were last here" line
// uses. That constant answers "is this the same sitting?"; this one answers "how often is it
// acceptable to pitch a paying member?" — and the honest answer is a good deal less often than
// they sit down. Six hours means an evening's questions produce one pitch, and somebody who
// comes back tomorrow sees it once more.
//
// Julie put the reason better than the number does (2026-09-02): "if it ever becomes every
// answer, it stops being an offer and starts being a nag." That is the line to defend if anyone
// ever proposes shortening this.
const COOLDOWN_S = 6 * 3600;

// Equity terms that are unambiguous — no crypto book has an SPX or an IWM.
const STRONG_RE = /\b(spy|qqq|iwm|spx|ndx|rut|dia|s&p|s ?and ?p|sp500|nasdaq|russell|dow|equit(?:y|ies)|stock market|stocks|0dte|opex|dealer map for)\b/i;

// Terms that LEAN equity but have a crypto reading — DVOL is spoken of as "the crypto VIX",
// and TLT/ES come up in macro questions a crypto trader legitimately asks. These arm the pitch
// only when nothing crypto-native is in the same question, so "how does DVOL compare to VIX"
// stays a crypto question and gets no advert.
const WEAK_RE = /\b(vix|vvix|vxn|tlt|skew index)\b/i;
const CRYPTO_RE = /\b(btc|eth|sol|bitcoin|ethereum|solana|crypto|deribit|dvol|funding|perp|perpetual|on-?chain|stablecoin|usdt|usdc|liquidation)\b/i;

// Tools that only exist because there is an equity desk behind them. If NoVo reached for one of
// these, the question touched equities whatever words it used — this is the backstop for the
// phrasings the regexes above miss ("what's the flip level today?").
//
// get_chain_history is NOT here on purpose: it is the ON-CHAIN corpus keyed network:address,
// not an option chain. Reading it as equity would have fired this advert on pure crypto
// questions, which is precisely the failure the whole feature exists to avoid.
const EQUITY_TOOLS = new Set([
  "get_dealer_levels", "get_gamma_profile", "get_session_history", "get_market_internals",
  "get_live_chain", "get_market_breadth", "get_vol_history", "get_futures_positioning",
  "get_base_rates", "get_track_record",
]);

function touchesEquities(question, ledger) {
  const q = String(question || "");
  if (STRONG_RE.test(q)) return true;
  if (WEAK_RE.test(q) && !CRYPTO_RE.test(q)) return true;
  try { return (ledger || []).some((l) => EQUITY_TOOLS.has(l && l.tool)); } catch (_) { return false; }
}

// THE COPY. It lives here, in one place, so changing what NoVo pitches is a one-file edit and
// not a hunt through an endpoint. Prices are the plans.html card verbatim ($169/mo, $1,690/yr,
// $39 against Analyst + Crypto separately, 7-day trial) — if that card moves, move this.
//
// Wording is Julie's, approved by Jake 2026-09-02, and her four edits are worth keeping as
// reasoning rather than just as a result:
//   - "less than the two separately", not "under the two bought apart" — this is the line a buyer
//     does arithmetic against, and "bought apart" is a construction nobody says out loud.
//   - the CTA names what they GET, not the SKU. The title already carries the SKU; the button is
//     the one place the value can go.
//   - "the half you're not seeing", not "the other half of what I watch" — the card sells their
//     gap, not NoVo's coverage. Same voice, different subject.
//   - no "You're on the crypto map" opener. They are looking at the crypto map while they read
//     this; it is orientation, not offer.
const CARD = {
  kind: "bundle_ac",
  eyebrow: "The equity map",
  title: "Analyst + Crypto",
  body: "The live SPY, QQQ and IWM dealer map — every strike, the flip level, the Open and Close "
      + "reads — is the half you're not seeing. This adds it to what you already have.",
  price: "$169/mo · $39 less than the two separately",
  trial: "7-day free trial · cancel any time",
  cta: { label: "Add the equity map", href: "/plans?plan=bundle-ac" },
};

// What the model is told when the pitch is armed. Deliberately narrow: it may acknowledge the
// boundary in ONE sentence and must still answer the question in full. No number, no link, no
// pitch paragraph — the card underneath carries all of that.
const PROMPT_LINE =
  "ONE MORE THING, AND ONLY IF THIS ANSWER TOUCHED EQUITIES: this reader's plan is the crypto map, " +
  "not the equity one. Answer their question completely and normally — withhold nothing. Then close " +
  "with a single short sentence, in your own voice, noting that the live equity dealer map itself " +
  "sits on the Analyst side rather than their plan. State no price and no link; a card below your " +
  "answer carries both. Do not apologise and do not repeat this if the conversation already covered it.\n\n";

/**
 * Should this answer carry the bundle pitch?
 * Returns the card, or null. Never throws — a marketing surface must not be able to break a
 * paid answer, so every failure path here resolves to "say nothing".
 *
 * `commit` is false for the pre-model check (which only decides whether to arm the prompt line)
 * and true for the post-answer check that actually attaches the card and burns the cooldown.
 */
async function bundlePitch({ email, question, ledger, kv, commit }) {
  try {
    if (!email) return null;
    if (!touchesEquities(question, ledger)) return null;

    const ck = "upsell:ac:" + eh(email);
    if (kv) {
      try { if (await kv.get(ck)) return null; } catch (_) { /* cache down — carry on */ }
    }

    // THE AUDIENCE TEST, and it is a POSITIVE one. This used to fire on
    // `analystEntitlement(email) === 'deny'` alone — "no live Analyst-granting subscription" —
    // which is a statement about what someone LACKS, while the card's copy asserts what they
    // HAVE ("this adds it to what you already have").
    //
    // Everyone with no subscription satisfies "lacks Analyst". So does everyone who just
    // cancelled: tokens outlive cancellation by design (7 days), so a churned member kept a
    // working token and, asking one more equity question, was told they still held the crypto
    // map. Worst case was a churned TRADER — also 'deny' — pitched the bundle days after
    // cancelling the tier that INCLUDED Analyst. Both reproduced in the harness.
    //
    // So: they must positively hold crypto AND positively lack Analyst. 'unknown' on either side
    // is silence, which keeps the fail-open posture intact — an outage produces no advert rather
    // than a wrong one.
    const ent = await entitlements(email);
    if (ent.crypto !== "allow" || ent.analyst !== "deny") return null;

    if (commit && kv) { try { await kv.set(ck, "1", { ex: COOLDOWN_S }); } catch (_) {} }
    return CARD;
  } catch (e) {
    console.error("[upsell]", e && e.message);
    return null;
  }
}

// Tools that are NOT an equity signal. Kept explicitly rather than as "everything else", because
// "everything else" is what let EQUITY_TOOLS rot silently in the first place.
const CRYPTO_TOOLS = new Set([
  "get_chain_token", "get_chain_alerts", "get_crypto_map", "get_crypto_history",
  "get_crypto_breadth", "get_chain_history",
]);
const NEUTRAL_TOOLS = new Set([
  "search_journal", "search_news", "get_economic_calendar", "get_quote", "get_earnings_dates",
  "set_alert", "list_alerts", "cancel_alert", "update_reader_memory",
  "describe_archive", "query_archive", "get_recent_reads",
]);

/**
 * DRIFT CHECK — the next tool somebody adds must not be silently invisible here.
 *
 * EQUITY_TOOLS is ten hand-typed names. Nothing connected it to the actual tool registry, so a new
 * equity tool added to _lib/tools.js would simply never trigger the upsell's ledger backstop, and
 * NO test would fail — the suite would stay green because green is also what "correctly stayed
 * silent" looks like. Einstein's formulation, from the same class of bug in the privacy walls: a
 * filter only catches the names it thought of.
 *
 * So instead of asserting the ten, this asserts the PARTITION: every tool the model can actually
 * call must be classified as equity, crypto or neutral. Add a tool and classify it — or this
 * reports it as unclassified, by name, on the health endpoint. Names here that no longer exist in
 * the registry are reported too, since a renamed tool leaves a dead entry behind.
 *
 * Reporting, never throwing. A misclassification must not be able to take the analyst down; the
 * whole point of this feature is that it is a marketing surface bolted to a paid one.
 */
function auditToolSets() {
  let declared = [];
  try { declared = (require("./tools.js").declarations || []).map((d) => d && d.name).filter(Boolean); }
  catch (e) { return { ok: false, error: "tool registry unreadable: " + e.message }; }
  const known = new Set([...EQUITY_TOOLS, ...CRYPTO_TOOLS, ...NEUTRAL_TOOLS]);
  const unclassified = declared.filter((n) => !known.has(n));
  const stale = [...known].filter((n) => !declared.includes(n));
  const ok = unclassified.length === 0 && stale.length === 0;
  if (!ok) {
    console.error("[upsell] TOOL SET DRIFT — unclassified:", unclassified.join(", ") || "none",
                  "| stale:", stale.join(", ") || "none");
  }
  return { ok, declared: declared.length, unclassified, stale };
}

module.exports = { bundlePitch, touchesEquities, auditToolSets, CARD, PROMPT_LINE,
                   EQUITY_TOOLS, CRYPTO_TOOLS, NEUTRAL_TOOLS, COOLDOWN_S };
