// api/_lib/record-reader.js — one way to read NoVo's own scored record.
//
// WHY THIS FILE EXISTS. The record is produced by the engine and consumed in two places: the public
// track-record page, and the lessons block that puts NoVo's own hit rates in front of him before he
// answers. The page read it correctly. The prompt did not, and the two drifted without a single
// error anywhere:
//
//   * the prompt read `c.sessions || c.n`; the producer stores the sample under `sample`. So
//     gravity_pull — SPY sample 381, QQQ 1,847, IWM 2,087, z up to 22.3, the strongest thing this
//     product has ever measured — scored n=0 and was dropped on all three tickers.
//   * the prompt flagged a FAILING claim only when `strength` was 'strong' or 'moderate'. The live
//     record emits exactly three values — 'inconclusive', 'strong', 'small edge' — so 'moderate' is
//     unreachable, and `grade()` only returns 'strong' for a claim that HOLDS. The failure branch
//     was therefore structurally impossible to enter, and NoVo went on citing flip_regime while his
//     own record scored it significantly INVERTED at z = −3.21.
//
// The net effect was an analyst that sounded self-aware while quoting one expected-move backtest
// twice and never once naming a claim that had turned against him — on a product whose entire
// public thesis is that it publishes what it got wrong.
//
// So field access lives here, once. `strength` is a LABEL and cannot express failure; the signed z
// is the measurement and can, so failure is graded on z. Anything reading this record — including
// public/track-record.html, which still carries its own correct copy of this logic — should come
// through this module, and a change here is the signal to reconcile that page.

const MIN_N = 20;        // below this a rate is an anecdote, not a claim
const Z_FAIL = 2.0;      // |z| at which a claim that does not hold is worth naming

// EFFECT SIZE, MIRRORED FROM THE ENGINE (skills/claim_strength.py:110). A |z| large enough to
// clear Z_FAIL says only "this is unlikely to be exactly zero", and on a big enough n that is
// nearly always true of nearly anything. effect_r says whether the difference is big enough to
// mean something. SPY's flip cell is the case that forced this: z = -2.43 with effect_r = -0.03,
// which the engine itself grades 'inconclusive' -- and this module was calling it FAILING and
// putting it in front of NoVo as a claim of his that had stopped working.
//
// (The deeper problem is upstream and is being fixed separately: that cell's `sample` of 4,011 is
// not 4,011 sessions, it is ~60-second snapshots from 28 trading days, so the z is inflated by
// pseudo-replication. Respecting the engine's own grade defends this layer against that class of
// inflation whatever its cause, which is why it is worth doing here even after the engine is fixed.)
const MIN_EFFECT_R = 0.15;

/** The sample behind a claim, whatever the producer called it. */
function sampleOf(c) {
  if (!c || typeof c !== "object") return 0;
  for (const k of ["sample", "sessions", "n"]) {
    if (typeof c[k] === "number" && isFinite(c[k])) return c[k];
  }
  return 0;
}

/**
 * How a claim is doing, in one word, from the MEASUREMENT rather than the label.
 *   "holding" | "failing" | null (not scoreable — say nothing rather than guess)
 */
function verdictOf(c) {
  if (!c || typeof c !== "object") return null;
  const n = sampleOf(c);
  const z = typeof c.z === "number" ? c.z : null;

  // A rate against a baseline it must beat is the most legible form, when the sample carries it.
  if (typeof c.rate === "number" && typeof c.baseline === "number" && n >= MIN_N) {
    const d = c.rate - c.baseline;
    if (d >= 5) return "holding";
    if (d <= -5) return "failing";
    return null;                       // inside the noise band: not evidence either way
  }
  // THE ENGINE'S OWN GRADE OUTRANKS THE z IT COMPUTED. It has both numbers and it already decided
  // this cell resolves nothing; overriding that from here produced a published failure the scorer
  // had explicitly declined to call one.
  if (c.strength === "inconclusive") return null;
  if (typeof c.effect_r === "number" && Math.abs(c.effect_r) < MIN_EFFECT_R) return null;

  // `holds` IS ABSENT ON ARCHIVE-STYLE CELLS -- pair() builds them without it (track_record.py:503)
  // -- and every branch below used to require it, so the archive's evidence could never be scored
  // at all. It was not neutral: SPY's archive flip cell reads z = +23.9, effect_r = 0.411, strength
  // 'strong' over 4,540 sessions and says the claim HOLDS, while the intraday cell said it failed.
  // The strongest evidence for the claim was structurally unreachable while the weakest was the one
  // line NoVo printed. The engine's sign convention carries the direction (groups_z returns
  // -(u1-mu)/sqrt(var), so positive z = the claim's side moved more), so derive it rather than
  // requiring a field that cell was never given.
  const holds = typeof c.holds === "boolean" ? c.holds : (z !== null ? z > 0 : null);

  if (holds === false && z !== null && Math.abs(z) >= Z_FAIL) return "failing";
  if (holds === true && z !== null && z >= Z_FAIL && n >= MIN_N) return "holding";
  if (holds === true && c.strength === "strong" && n >= MIN_N) return "holding";
  return null;
}

/** A one-line description a prompt or a page can print verbatim, with its sample attached. */
function describe(label, c) {
  const n = sampleOf(c);
  if (typeof c.rate === "number" && typeof c.baseline === "number") {
    return `${label}: ${c.rate.toFixed(0)}% vs ${c.baseline}% baseline (n=${n})`;
  }
  if (typeof c.z === "number") {
    const dir = c.z < 0 ? "inverted" : "";
    return `${label}: ${dir ? dir + ", " : ""}z=${c.z.toFixed(1)}${n ? ` (n=${n})` : ""}`;
  }
  return `${label}${n ? ` (n=${n})` : ""}`;
}

/**
 * Walk a published record into { holding, failing, asOf }, each a list of printable lines.
 * Descends one level into per-ticker claim sets and into `archive`-style sub-cells.
 */
function readRecord(tr) {
  const holding = [], failing = [];
  if (!tr || typeof tr !== "object") return { holding, failing, asOf: null };

  const visit = (label, c) => {
    if (!c || typeof c !== "object") return;
    const v = verdictOf(c);
    if (v === "holding") holding.push(describe(label, c));
    else if (v === "failing") failing.push(describe(label, c));
  };

  // A cell that carries no measurement of its own but CONTAINS measured cells is a container, not
  // a claim -- `archive` is one. The docstring promised this walk descended into them and it never
  // did, so 4,540 sessions of the strongest evidence in the record were invisible to every caller.
  const scoreable = (v) => v && typeof v === "object" &&
    (typeof v.z === "number" || typeof v.rate === "number" || typeof v.holds === "boolean");

  for (const [tk, claims] of Object.entries(tr.tickers || {})) {
    if (!claims || typeof claims !== "object") continue;
    for (const [name, c] of Object.entries(claims)) {
      if (!c || typeof c !== "object") continue;
      if (!scoreable(c)) {
        // Descend one level. The label says WHICH TEST it is, because the archive cells are a
        // NEXT-SESSION RANGE test on reconstructed maps and the sibling cells are intraday. The
        // engine keeps them deliberately apart (track_record.py:427) and a reader -- human or
        // NoVo -- must not merge "the flip predicts tomorrow's range" with "the flip predicts the
        // next hour" just because both print as "flip regime".
        const horizon = typeof c.horizon === "string" ? c.horizon : null;
        for (const [sub, cc] of Object.entries(c)) {
          if (!scoreable(cc)) continue;
          visit(`${tk} ${sub.replace(/_/g, " ")} (${name}${horizon ? ", " + horizon : ""})`, cc);
        }
        continue;
      }
      visit(`${tk} ${name.replace(/_/g, " ")}`, c);
    }
  }
  // Top-level records the per-ticker walk never reaches.
  for (const k of ["lean_record", "audit_record", "pulse_signal"]) {
    if (tr[k]) visit(k.replace(/_/g, " "), tr[k]);
  }

  return { holding, failing, asOf: tr.received || tr.generated || null };
}

/** One entry per claim NAME — the same claim on three tickers is one fact, not three. */
function byClaim(lines, limit = 5) {
  const best = new Map();
  for (const s of lines) {
    const name = s.replace(/^\S+\s/, "").split(":")[0];
    const n = parseInt((s.match(/n=(\d+)/) || [])[1] || "0", 10);
    const cur = best.get(name);
    if (!cur || n > cur.n) best.set(name, { s, n });
  }
  return [...best.values()].sort((a, b) => b.n - a.n).slice(0, limit).map((x) => x.s);
}

module.exports = { readRecord, byClaim, sampleOf, verdictOf, describe, MIN_N, Z_FAIL };
