// api/_lib/comp.js — THE comp gate, in exactly one place.
//
// COMP_EMAILS holds the comped seats (owner testing / comped accounts with no Stripe sub).
// The control plane treats the list as every product; crypto-map.js and trader-live.js gate
// their dashboards on it with this exact pattern. The analyst's private surfaces must be gated
// THE SAME WAY — same variable, same parsing, same semantics — because four hand-copied
// versions of one check is how a gate drifts, and drift here locks the one account that exists
// to test the product (2026-08-30). One list, one implementation, every surface.
//
// The set is built per call rather than at module load so a redeploy is the only thing an env
// change waits on — never a warm lambda's memory.

function isComp(email) {
  const norm = String(email || "").trim().toLowerCase();
  if (!norm) return false;
  const set = new Set(
    String(process.env.COMP_EMAILS || "")
      .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)
  );
  return set.has(norm);
}

module.exports = { isComp };
