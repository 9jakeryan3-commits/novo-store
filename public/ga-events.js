// GA4 conversion events for NoVo — non-invasive delegation (no changes to the checkout handlers).
// Fires begin_checkout when a paid CTA is clicked, and generate_lead on the free email signups.
// Mark begin_checkout + generate_lead as "Key events" in GA4 (Admin -> Events) to count them as conversions.
(function () {
  document.addEventListener('click', function (e) {
    if (typeof window.gtag !== 'function') return;
    var b = e.target.closest && e.target.closest('[onclick]');
    if (!b) return;
    var oc = b.getAttribute('onclick') || '';
    if (/subscribeNow|subscribeYearly|traderCheckout/.test(oc)) {
      // Trader is $249/mo or $2,490/yr. These values feed Ads bidding — they have now gone stale twice
      // (once at $199, once at the $169 rise), so re-check them whenever price changes.
      var _tv = /subscribeYearly/.test(oc) ? 2490 : 249;
      gtag('event', 'begin_checkout', { currency: 'USD', value: _tv, items: [{ item_id: 'trader', item_name: 'NoVo Trader' }] });
    } else if (/startAnalystTrial|analystCheckout/.test(oc)) {
      gtag('event', 'begin_checkout', { currency: 'USD', value: 129, items: [{ item_id: 'analyst', item_name: 'NoVo Analyst' }] });
    }
  }, true);

  document.addEventListener('submit', function (e) {
    if (typeof window.gtag !== 'function') return;
    var f = e.target;
    if (!f) return;
    var id = f.id || '';
    var cls = f.className || '';
    if (id === 'np-subscribe' || id === 'fb-sub' || cls.indexOf('np-form') >= 0) {
      gtag('event', 'generate_lead', { currency: 'USD', value: 0 });
    }
  }, true);
})();
