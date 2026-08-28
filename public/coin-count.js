/* The crypto universe is whatever the venue lists today - it was 89, it is 90, and it will
   change again. Hard-coding it means the marketing is wrong every time a coin is listed or
   delisted, and nobody notices until a screenshot catches it.

   Any element marked data-coincount gets the live number. One cached request, and if it
   fails the number already in the HTML simply stands - so the page is never blank or zero,
   it is just occasionally a little behind. */
(function () {
  var els = document.querySelectorAll('[data-coincount]');
  if (!els.length) return;
  fetch('/api/crypto-free')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (!j || !j.coins) return;
      var n = j.coins;
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
