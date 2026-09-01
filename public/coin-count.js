/* The crypto universe is whatever the venue lists today - it was 89, it is 90, and it will
   change again. Hard-coding it means the marketing is wrong every time a coin is listed or
   delisted, and nobody notices until a screenshot catches it.

   Any element marked data-coincount gets the live number. One cached request, and if it
   fails the number already in the HTML simply stands - so the page is never blank or zero,
   it is just occasionally a little behind. */
(function () {
  var els   = document.querySelectorAll('[data-coincount]');
  var chain = document.querySelectorAll('[data-chaincount]');
  var asset = document.querySelectorAll('[data-assetcount]');
  // MAPPED IS NOT THE SAME NUMBER AS COINS. `coins` counts what is tradable at retail, because
  // the cost-to-trade copy is read back from a broker's disclosed markup and only exists for
  // coins that broker lists. `mapped` is the size of the map. They differ by TRX, which has one
  // of the seven real options books but no retail listing - so a stat labelled "coins mapped"
  // showing the tradable count was understating the map by one.
  var mapped = document.querySelectorAll('[data-mappedcount]');
  if (!els.length && !chain.length && !asset.length && !mapped.length) return;
  fetch('/api/crypto-free')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (!j || !j.coins) return;
      var n = j.coins;
      // The on-chain half, EXACT and from the same snapshot the dashboard renders. The number
      // baked in at build time is floored to a fifty so a crawler and a JS-off reader get a claim
      // that stays true as pools churn; a live reader gets the real figure instead. Both are true,
      // and the live one now reconciles with the dashboard, which was the whole complaint: the
      // rail's "filter 293 tokens" is coins + chain, and the site was quoting the floored half.
      if (typeof j.chain === 'number' && j.chain > 0) {
        chain.forEach(function (el) { el.textContent = String(j.chain); });
        asset.forEach(function (el) { el.textContent = String((j.mapped || n) + j.chain); });
      }
      if (typeof j.mapped === 'number' && j.mapped > 0) {
        mapped.forEach(function (el) { el.textContent = String(j.mapped); });
      }
      els.forEach(function (el) {
        // data-coincount="words" wants "ninety" rather than "90" - the /plans copy reads
        // "for eighty-nine" mid-sentence and a digit there looks like a typo.
        el.textContent = el.getAttribute('data-coincount') === 'words' ? words(n) : String(n);
      });
    })
    .catch(function () {});
  function words(n) {
    var ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
    var tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
    if (n < 10) return ones[n];
    if (n < 20) return String(n);
    var t = tens[Math.floor(n / 10)], o = ones[n % 10];
    return o ? t + '-' + o : t;
  }
})();
