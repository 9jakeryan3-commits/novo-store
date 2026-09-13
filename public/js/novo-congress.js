/* novo-congress.js — congressional trade disclosures, for the Analyst and Trader dashboards.
 *
 * ONE MODULE, MOUNTED TWICE. Analyst and Trader both call novoCongress.mount('#congress-card').
 * Same file, same markup, same numbers. The chat cost a day this month precisely because it lived
 * as three hand-kept copies that drifted, and "if it's displaying in one place putting it in
 * another is basically the same" is already the rule for the futures and history panels.
 *
 * ⚠ THIS IS A DISCLOSURE FEED. IT IS NOT FLOW, AND THE UI HAS TO SAY SO.
 * The STOCK Act gives a member up to 45 days to file. Measured against the live 2026 index: the
 * median gap between a trade and its disclosure is 13 days, p90 is 32, and the longest in sample
 * was 391. So every row prints its own lag, the header prints the distribution, and the word
 * "filed" is used rather than "bought" wherever there is room. A reader who sees "Rep. X bought
 * NVDA" with no date beside it will read a five-week-old trade as news — that is the one way this
 * panel could put someone in a position on a misunderstanding, and it is designed against.
 *
 * ⚠ AMOUNTS ARE BANDS AND ARE NEVER SUMMED.
 * Members usually disclose "$1,001 - $15,000" rather than a figure. Adding bands up would produce a total
 * nobody filed and hand it the authority of a measurement. The band is printed as filed and the
 * tally counts FILINGS, not dollars.
 *
 * ⚠ WHAT IS MISSING IS STATED. About 12% of filings are scans of handwritten forms with no text
 * layer, and the Senate's own system is not read here at all — this is House data. Both facts are
 * printed under the table. An empty result must never read as "nobody traded".
 *
 * Hairlines only, no boxes, colour carries the buy/sell distinction. Styles injected, tagged
 * data-novo-congress.
 */
(function () {
  var CSS = [
    '.novo-congress{padding:4px 2px}',
    '.novo-congress h2{margin:0 0 4px;font-family:var(--mono,ui-monospace),monospace;font-size:11px;'
      + 'font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--txt2,#a8a8a8)}',
    '.novo-congress .cg-sub{font-size:11px;font-weight:500;color:var(--txt3,#8f8f8f);'
      + 'letter-spacing:.06em;margin-left:8px;text-transform:none}',
    /* the lag banner: the most important sentence on the panel, so it sits above the data */
    '.novo-congress .cg-lag{font-size:12px;line-height:1.55;color:var(--txt3,#8f8f8f);'
      + 'padding:10px 0 12px;border-bottom:1px solid var(--bdr2,#242428);margin-bottom:2px}',
    '.novo-congress .cg-lag b{color:var(--txt2,#a8a8a8);font-weight:600}',
    /* filters: words you click, per the CTA rule - no fill, no border, no box */
    '.novo-congress .cg-filters{display:flex;flex-wrap:wrap;gap:14px;padding:10px 0;'
      + 'border-bottom:1px solid var(--bdr2,#242428)}',
    '.novo-congress .cg-filters button{background:none;border:0;border-radius:0;padding:0;'
      + 'cursor:pointer;font-family:var(--mono,ui-monospace),monospace;font-size:10.5px;'
      + 'letter-spacing:.12em;text-transform:uppercase;color:var(--txt3,#8f8f8f)}',
    '.novo-congress .cg-filters button[aria-pressed="true"]{color:var(--txt1,#eaf3ff)}',
    '.novo-congress .cg-filters button:hover{color:var(--txt1,#eaf3ff)}',
    /* the tally strip */
    '.novo-congress .cg-top{display:flex;flex-wrap:wrap;gap:5px 16px;padding:11px 0;'
      + 'border-bottom:1px solid var(--bdr2,#242428);font-family:var(--mono,ui-monospace),monospace;'
      + 'font-size:10.5px;letter-spacing:.06em;color:var(--txt3,#8f8f8f)}',
    '.novo-congress .cg-top .t-k{color:var(--txt2,#a8a8a8);font-weight:600}',
    /* rows */
    '.novo-congress .cg-row{display:grid;grid-template-columns:64px 1fr auto;gap:4px 12px;'
      + 'align-items:baseline;padding:11px 0;border-bottom:1px solid var(--bdr2,#242428)}',
    '.novo-congress .cg-tk{font-family:var(--mono,ui-monospace),monospace;font-size:12.5px;'
      + 'font-weight:700;letter-spacing:.04em;color:var(--txt1,#eaf3ff)}',
    '.novo-congress .cg-tk.none{color:var(--txt3,#8f8f8f);font-weight:500;font-size:11px}',
    '.novo-congress .cg-who{font-size:13px;color:var(--txt2,#a8a8a8);min-width:0}',
    '.novo-congress .cg-who .cg-asset{display:block;font-size:11.5px;color:var(--txt3,#8f8f8f);'
      + 'margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.novo-congress .cg-side{font-family:var(--mono,ui-monospace),monospace;font-size:10px;'
      + 'letter-spacing:.14em;text-transform:uppercase}',
    '.novo-congress .cg-side.buy{color:var(--green,#10b981)}',
    '.novo-congress .cg-side.sell{color:var(--red,#f43f5e)}',
    '.novo-congress .cg-side.exchange{color:var(--txt3,#8f8f8f)}',
    '.novo-congress .cg-meta{grid-column:2 / -1;font-family:var(--mono,ui-monospace),monospace;'
      + 'font-size:10.5px;letter-spacing:.05em;color:var(--txt3,#8f8f8f)}',
    '.novo-congress .cg-meta .cg-lagpill{color:var(--txt2,#a8a8a8)}',
    '.novo-congress .cg-meta .cg-stale{color:var(--amber,#f0a63c)}',
    '.novo-congress .cg-foot{padding:14px 0 2px;font-size:11.5px;line-height:1.6;'
      + 'color:var(--txt3,#8f8f8f)}',
    '.novo-congress .cg-foot a{color:var(--txt2,#a8a8a8)}',
    '.novo-congress .cg-empty{padding:22px 0;font-size:13px;color:var(--txt3,#8f8f8f)}',
    '@media (max-width:560px){.novo-congress .cg-row{grid-template-columns:56px 1fr}'
      + '.novo-congress .cg-side{grid-column:2;justify-self:start}}',
    // search boxes — hairline only, no box fill (house rule)
    '.novo-congress .cg-search{display:flex;gap:10px;flex-wrap:wrap;margin:2px 0 8px}',
    '.novo-congress .cg-q{flex:1;min-width:130px;background:none;border:0;border-bottom:1px solid '
      + 'var(--bdr,#2c2c30);color:var(--txt1,#f0f0ee);font-family:inherit;font-size:12px;'
      + 'padding:5px 2px;outline:none}',
    '.novo-congress .cg-q:focus{border-bottom-color:var(--cyn,#22d3ee)}',
    '.novo-congress .cg-q::placeholder{color:var(--txt3,#8f8f8f)}',
    // by-member list
    '.novo-congress .cg-mlist{display:flex;flex-direction:column}',
    '.novo-congress .cg-mrow{display:flex;justify-content:space-between;align-items:baseline;gap:12px;'
      + 'padding:8px 0;border-bottom:1px solid var(--bdr2,#1c1c20)}',
    '.novo-congress .cg-mwho{font-size:13px;color:var(--txt1,#f0f0ee);font-weight:600}',
    '.novo-congress .cg-mstat{font-size:11.5px;color:var(--txt3,#8f8f8f);white-space:nowrap;font-family:var(--font,ui-monospace),monospace}',
    '.novo-congress .cg-mstat .cg-buy{color:var(--grn,#10b981)}',
    '.novo-congress .cg-mstat .cg-sell{color:var(--red,#f43f5e)}',
  ].join('');

  var root = null;
  var DATA = null;
  var state = { side: '', stocks: true, member: '', ticker: '', sort: '', view: 'filings' };
  var loading = false;

  function styles() {
    if (document.querySelector('style[data-novo-congress]')) return;
    var s = document.createElement('style');
    s.setAttribute('data-novo-congress', '1');
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* "Aug 26" - the trade date is what a reader anchors on, so it is the one spelled out. */
  function shortDate(iso) {
    if (!iso) return '—';
    var p = String(iso).split('-');
    if (p.length !== 3) return esc(iso);
    var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return M[parseInt(p[1], 10) - 1] + ' ' + parseInt(p[2], 10);
  }

  function render() {
    if (!root) return;
    if (loading && !DATA) {
      root.innerHTML = '<h2>Congress<span class="cg-sub">loading disclosures…</span></h2>';
      return;
    }
    if (!DATA) {
      root.innerHTML = '<h2>Congress</h2><div class="cg-empty">Disclosure feed unavailable right now.'
        + ' This panel reads the House Clerk filings directly; nothing is inferred when it is down.</div>';
      return;
    }

    var lag = DATA.lag;
    var h = [];
    h.push('<h2>Congress<span class="cg-sub">House periodic transaction reports</span></h2>');

    /* THE LAG SENTENCE COMES FIRST, BEFORE ANY ROW. It is the difference between a feed a reader
       understands and one that reads like flow. */
    h.push('<div class="cg-lag">Members have up to '
      + '<b>45 days</b> to disclose under the STOCK Act'
      + (lag ? ', and in this window the median gap between the trade and its disclosure is <b>'
          + lag.median + ' days</b> (p90 ' + lag.p90 + ', longest ' + lag.max + ')' : '')
      + '. Amounts are the ranges members file &mdash; a few file an exact figure instead.</div>');

    // SEARCH — the two boxes the competitors lead with, over data we already hold. Client-side
    // over the loaded window (member also narrows server-side on submit for the full window).
    h.push('<div class="cg-search">'
      + '<input type="text" class="cg-q" data-q="member" placeholder="Find a member" value="' + esc(state.member) + '">'
      + '<input type="text" class="cg-q" data-q="ticker" placeholder="Find a ticker" value="' + esc(state.ticker) + '">'
      + '</div>');

    // filters + sort + view toggle
    h.push('<div class="cg-filters">'
      + '<button type="button" data-side="" aria-pressed="' + (state.side === '') + '">All</button>'
      + '<button type="button" data-side="buy" aria-pressed="' + (state.side === 'buy') + '">Buys</button>'
      + '<button type="button" data-side="sell" aria-pressed="' + (state.side === 'sell') + '">Sells</button>'
      + '<button type="button" data-stocks="' + (state.stocks ? '0' : '1') + '" aria-pressed="'
        + (!state.stocks) + '">Include funds &amp; bonds</button>'
      + '<button type="button" data-sort="' + (state.sort === 'lag' ? '' : 'lag') + '" aria-pressed="'
        + (state.sort === 'lag') + '">' + (state.sort === 'lag' ? 'Newest first' : 'Slowest to file') + '</button>'
      + '<button type="button" data-view="' + (state.view === 'members' ? 'filings' : 'members') + '" aria-pressed="'
        + (state.view === 'members') + '">' + (state.view === 'members' ? 'By filing' : 'By member') + '</button>'
      + '</div>');

    // BY-MEMBER VIEW — aggregation the flat list could not show. Counts filings, never dollars
    // (the amount is a band; summing bands invents a figure nobody filed), so a card says how
    // OFTEN a member filed and across how many names, not how much.
    if (state.view === 'members') {
      var mem = (DATA.members || []).filter(function (m) {
        return !state.member || m.member.toLowerCase().indexOf(state.member.toLowerCase()) >= 0;
      });
      if (!mem.length) {
        h.push('<div class="cg-empty">No members match this filter.</div>');
      } else {
        h.push('<div class="cg-mlist">' + mem.map(function (m) {
          return '<div class="cg-mrow">'
            + '<div class="cg-mwho">' + esc(m.member)
              + (m.state_district ? ' <span class="cg-sub">' + esc(m.state_district) + '</span>' : '') + '</div>'
            + '<div class="cg-mstat">'
              + '<span class="cg-buy">' + m.buys + ' buy' + (m.buys === 1 ? '' : 's') + '</span> · '
              + '<span class="cg-sell">' + m.sells + ' sell' + (m.sells === 1 ? '' : 's') + '</span> · '
              + esc(String(m.names)) + ' name' + (m.names === 1 ? '' : 's') + '</div>'
            + '</div>';
        }).join('') + '</div>');
        h.push('<div class="cg-foot">Ranked by number of filings in the window, not by dollars — '
          + 'disclosed amounts are ranges, so a sum would be a figure nobody filed. Tap a member '
          + 'name in the search to see their filings.</div>');
        root.innerHTML = h.join('');
        wire();
        return;
      }
    }

    /* The tally counts FILINGS. Never dollars - see the band note at the top of this file. */
    if (DATA.top && DATA.top.length) {
      h.push('<div class="cg-top">' + DATA.top.slice(0, 10).map(function (t) {
        return '<span><span class="t-k">' + esc(t.ticker) + '</span> '
          + t.filings + (t.filings === 1 ? ' filing' : ' filings') + '</span>';
      }).join('') + '</div>');
    }

    var rows = DATA.rows || [];
    /* Ticker search narrows client-side over the loaded window — instant, no round trip. Member
       search rides the fetch (server narrows the whole window), so it is not re-applied here. */
    if (state.ticker) {
      var tq = state.ticker.toUpperCase();
      rows = rows.filter(function (r) { return String(r.ticker || '').indexOf(tq) >= 0; });
    }
    if (!rows.length) {
      h.push('<div class="cg-empty">No disclosures match this filter.</div>');
    } else {
      h.push(rows.map(function (r) {
        /* A NEGATIVE LAG IS REAL AND MUST NOT READ AS "filed -18d later". Some members file a
           notification date earlier than the trade date; that is their filing, not our arithmetic,
           so the row says the dates disagree rather than printing nonsense or hiding it. */
        var lagTxt = r.lag_days == null ? ''
          : r.lag_days < 0
            ? '<span class="cg-stale">filing dates disagree</span> · '
            : '<span class="' + (r.lag_days > 45 ? 'cg-stale' : 'cg-lagpill') + '">filed '
              + r.lag_days + 'd later</span> · ';
        return '<div class="cg-row">'
          + '<div class="cg-tk' + (r.ticker ? '' : ' none') + '">' + esc(r.ticker || 'no ticker') + '</div>'
          + '<div class="cg-who">' + esc(r.member || 'Unknown')
            + (r.state_district ? ' <span class="cg-sub">' + esc(r.state_district) + '</span>' : '')
            + '<span class="cg-asset">' + esc(r.asset || '') + '</span></div>'
          + '<div class="cg-side ' + esc(r.type) + '">' + esc(r.type) + '</div>'
          + '<div class="cg-meta">' + shortDate(r.transaction_date) + ' · ' + lagTxt
            + esc(r.amount || '') + '</div>'
          + '</div>';
      }).join(''));
    }

    // What this panel cannot see, said plainly rather than left as an absence.
    var foot = ['Source: <a href="https://disclosures-clerk.house.gov/" target="_blank" '
      + 'rel="noopener">Clerk of the U.S. House of Representatives</a>, read directly.'];
    if (DATA.unreadable_filings) {
      foot.push(DATA.unreadable_filings + ' filing'
        + (DATA.unreadable_filings === 1 ? ' was' : 's were')
        + ' submitted on paper and scanned; they carry no machine-readable text and are not in this '
        + 'list. An absence here is not evidence a member did not trade.');
    }
    foot.push('House only — Senate filings are published through a separate system and are not '
      + 'included yet.');
    h.push('<div class="cg-foot">' + foot.join(' ') + '</div>');

    root.innerHTML = h.join('');
    wire();
  }

  /* One definition of what every control does, called from both the list view and the by-member
     view's early return. A filter/sort/view change that alters the server query calls load();
     a ticker search narrows the loaded window client-side and only needs a re-render. */
  function wire() {
    root.querySelectorAll('.cg-filters button').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.hasAttribute('data-stocks')) { state.stocks = b.getAttribute('data-stocks') === '1'; load(); }
        else if (b.hasAttribute('data-sort')) { state.sort = b.getAttribute('data-sort') || ''; load(); }
        else if (b.hasAttribute('data-view')) { state.view = b.getAttribute('data-view') || 'filings'; render(); }
        else { state.side = b.getAttribute('data-side') || ''; load(); }
      });
    });
    root.querySelectorAll('.cg-q').forEach(function (inp) {
      // ticker filters live (client-side); member submits on Enter/blur (server-side, full window)
      inp.addEventListener('input', function () {
        if (inp.getAttribute('data-q') === 'ticker') { state.ticker = inp.value.trim(); reRenderKeepFocus(inp); }
      });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && inp.getAttribute('data-q') === 'member') { state.member = inp.value.trim(); load(); }
      });
      inp.addEventListener('blur', function () {
        if (inp.getAttribute('data-q') === 'member' && inp.value.trim() !== state.member) {
          state.member = inp.value.trim(); load();
        }
      });
    });
  }

  /* A client-side ticker keystroke re-renders, which would drop focus from the box the user is
     typing in. Re-render, then restore the caret so typing is uninterrupted. */
  function reRenderKeepFocus(inp) {
    var q = inp.getAttribute('data-q'), pos = inp.selectionStart;
    render();
    var again = root.querySelector('.cg-q[data-q="' + q + '"]');
    if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (_e) {} }
  }

  function load() {
    loading = true;
    render();
    var q = '/api/congress?limit=120&stocks=' + (state.stocks ? '1' : '0')
      + (state.side ? '&side=' + state.side : '')
      + (state.member ? '&member=' + encodeURIComponent(state.member) : '')
      + (state.sort ? '&sort=' + state.sort : '');
    return fetch(q, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (d) {
        loading = false;
        /* ⚠ A FAILED FETCH MUST NOT OVERWRITE GOOD DATA WITH AN EMPTY PANEL. Keeping the last
           good payload means a blip re-renders what the reader was already looking at, and a
           genuine outage on first load still shows the explicit "unavailable" state above. */
        if (d) DATA = d;
        render();
      });
  }

  function mount(sel) {
    styles();
    root = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!root) return false;
    root.classList.add('novo-congress');
    render();
    load();
    return true;
  }
  function refresh() { return load(); }

  window.novoCongress = { mount: mount, refresh: refresh, render: render };
})();
