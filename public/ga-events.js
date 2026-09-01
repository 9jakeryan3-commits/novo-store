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
      // Trader is $209/mo or $2,000/yr. These values feed Ads bidding — they have now gone stale twice
      // (once at $199, once at the $169 rise), so re-check them whenever price changes.
      // plans.html's monthly/yearly toggle stores the plan in a GLOBAL and never changes the
      // onclick, so reading the attribute alone reported every annual sale at the monthly
      // value -- $2,000 as 209. Fall back to the global the toggle actually sets.
      var _yr = /yearly/i.test(oc) || window._traderPlan === 'yearly';
      var _tv = _yr ? 2000 : 209;
      gtag('event', 'begin_checkout', { currency: 'USD', value: _tv, items: [{ item_id: 'trader', item_name: 'NoVo Trader' }] });
    } else if (/startAnalystTrial|analystCheckout/.test(oc)) {
      // Yearly reported 129 like the monthly, so Ads valued an annual Analyst at a tenth of what it
      // is worth. The Trader branch above already reads its plan out of the handler name; this did not.
      var _av = (/yearly/i.test(oc) || window._analystPlan === 'yearly') ? 1290 : 129;
      gtag('event', 'begin_checkout', { currency: 'USD', value: _av, items: [{ item_id: 'analyst', item_name: 'NoVo Analyst' }] });
    } else if (/cryptoCheckout/.test(oc)) {
      // The Crypto Market Map had NO branch at all, so not one $79 click has ever reached GA4 or Ads.
      // A product whose checkouts are invisible cannot be bid on, cannot be optimised, and looks like
      // it converts at zero -- which is indistinguishable from a product nobody wants.
      // Plan global differs BY PAGE: crypto.html stores window._cryptoPlan, plans.html stores the
      // lexical _cxPlan (visible here as window._cxPlan since it's declared with var at top level) —
      // reading only one of them reported every annual sale from the other page at the monthly value.
      var _cv = (/yearly/i.test(oc) || window._cryptoPlan === 'yearly' || window._cxPlan === 'yearly') ? 790 : 79;
      gtag('event', 'begin_checkout', { currency: 'USD', value: _cv, items: [{ item_id: 'crypto', item_name: 'NoVo Crypto Market Map' }] });
    } else if (/bundleAcCheckout/.test(oc)) {
      var _bav = (window._bundleAcPlan === 'yearly') ? 1690 : 169;
      gtag('event', 'begin_checkout', { currency: 'USD', value: _bav, items: [{ item_id: 'bundle_ac', item_name: 'NoVo Analyst + Crypto bundle' }] });
    } else if (/bundleAllCheckout/.test(oc)) {
      var _bcv = (window._bundleAllPlan === 'yearly') ? 2300 : 239;
      gtag('event', 'begin_checkout', { currency: 'USD', value: _bcv, items: [{ item_id: 'bundle_all', item_name: 'NoVo Complete bundle' }] });
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
