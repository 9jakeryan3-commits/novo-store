/**
 * Reserved / test email domains that must never reach a Resend audience.
 *
 * Why this exists: Resend rejects a broadcast SEND with a 422 if ANY contact in the audience
 * uses a reserved test domain --
 *
 *   "The audience you are sending contains a contact with an email address ending in
 *    `@example.com`. Please use our test addresses instead."
 *
 * It refuses the whole broadcast rather than skipping that one contact. So a single test
 * signup silently stopped every Mid-Day Tape Review for five days (2026-08-18 to 08-23):
 * the broadcast was created, the send 422'd, and the draft sat there. Nothing in the product
 * pointed at the cause -- the answer was only in Resend's own request log.
 *
 * Cheaper to never let one in. RFC 2606 reserves example.{com,org,net}, .test, .example,
 * .invalid and .localhost precisely so they cannot be real; test.com is not reserved but is
 * the other address people reach for when filling in a form they do not mean.
 */
'use strict';

const RESERVED_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'example.edu',
  'test.com', 'localhost',
]);
const RESERVED_TLDS = ['.test', '.example', '.invalid', '.localhost'];

/** True when this address can never receive mail and would poison an audience send. */
function isReservedEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 0) return false;
  const domain = e.slice(at + 1);
  if (!domain) return false;
  if (RESERVED_DOMAINS.has(domain)) return true;
  return RESERVED_TLDS.some((t) => domain === t.slice(1) || domain.endsWith(t));
}

module.exports = { isReservedEmail, RESERVED_DOMAINS, RESERVED_TLDS };
