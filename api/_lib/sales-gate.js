// api/_lib/sales-gate.js — the "stop selling" switch, server-side, in one place.
//
// SALES_PAUSED already existed and was NOT a kill switch. It was a JavaScript const compiled into
// each marketing page (`const SALES_PAUSED = false;` in ai.html, analyst.html, plans.html, ...),
// checked in the click handler before the fetch. Two problems with that, and the second is the one
// that matters:
//
//   1. Flipping it meant editing every page and redeploying — so the emergency switch needed the
//      slowest possible action to throw.
//   2. It stopped BUTTONS, not CHECKOUTS. Anything that POSTs to /api/checkout-* directly — a
//      cached page still open in a tab, a bookmarked flow, a bot, curl — never saw it. So the
//      switch was live-looking and did not actually pause sales.
//
// This is the server side of it: one env var, no deploy needed to throw it, and it sits in the
// handler after the rate limit and before Stripe is ever called. The client-side consts stay where
// they are — they give a person a civil message instead of a failed request, which is worth
// keeping — but they are now the courtesy, not the control.
//
// Deliberately OPT-IN and fail-OPEN on a malformed value: an unset or unparseable SALES_PAUSED
// means selling continues. A typo in an env var must never be able to take the storefront down,
// and the failure mode of "we kept selling" is recoverable in a way that "we silently stopped
// taking money and nobody noticed" is not.

const TRUTHY = new Set(["1", "true", "yes", "on", "paused"]);

function salesPaused() {
  return TRUTHY.has(String(process.env.SALES_PAUSED || "").trim().toLowerCase());
}

// The message a paused storefront returns. Mirrors the wording the pages already show, so a
// reader who hits the API path and a reader who clicks the button are told the same thing.
const PAUSED_MESSAGE =
  "Checkout is briefly paused right now — please check back soon. Thanks for your patience!";

/**
 * Call at the top of a checkout handler, after the rate limit, before touching Stripe.
 * Returns true if it has already answered the request (503) and the caller must return.
 *
 * 503 + Retry-After rather than 4xx: this is a temporary, deliberate, server-side condition, and
 * it is the one status that says so to a human, a browser and a crawler alike.
 */
function blockIfPaused(req, res, label) {
  if (!salesPaused()) return false;
  console.warn(`[sales-gate] ${label}: refused, SALES_PAUSED is on`);
  res.setHeader("Retry-After", "3600");
  res.status(503).json({ error: PAUSED_MESSAGE, paused: true });
  return true;
}

module.exports = { salesPaused, blockIfPaused, PAUSED_MESSAGE };
