/* novo-subtabs.js — tabs inside a tab.
 *
 * Jake, 2026-09-10: "we need tabs inside the tabs because the first set of info is just running
 * down and the rest of the stuff is getting pushed way down. alerts predictions anything tab that
 * has multiple data sets needs tabs inside the tab."
 *
 * Several panels stack two to six independent data sets in one scrolling column — Predictions runs
 * Dr. NoVo's calls then Your calls; Alerts the same; Live Reads runs a forward register, a BTC
 * bias, the reads and the daily rundown; the tape panels run six. The second set is below the fold
 * before the first one has finished, so it may as well not exist.
 *
 * ONE IMPLEMENTATION, USED BY EVERY PANEL. Four panels each growing their own tab strip is the
 * exact shape that cost a day on the chat and is still costing it — a one-line behaviour written
 * out three times. Panels declare their groups; this file owns the behaviour.
 *
 * ⚠ THE GROUPS ARE FLAT, NOT NESTED, AND THAT IS WHY THIS IS NOT A THREE-LINE FUNCTION.
 * A panel emits `<div class="al-grp">Heading</div>` followed by sibling rows, then the next
 * heading. There is no per-group container to show and hide. So a run is "this marker up to the
 * next marker", and the wrapping is done here at runtime rather than by rewriting four modules'
 * markup.
 *
 * ⚠ ANYTHING BEFORE THE FIRST MARKER STAYS VISIBLE ON EVERY TAB. On Predictions that is the score
 * row — the record headline — and on the tape panels it is the summary. Those are the context the
 * groups are read against; filing them under one tab would hide the number the panel exists to
 * show.
 *
 * ⚠ ONE GROUP MEANS NO TABS. A tab strip with a single tab is furniture that does nothing.
 *
 * Hairlines and colour only — no boxes, no fills, no glow. The active tab is a word in the
 * foreground colour with a hairline under it.
 */
(function () {
  var CSS = [
    '.nst-bar{display:flex;flex-wrap:wrap;gap:16px;margin:2px 0 6px;padding:0 0 8px;'
      + 'border-bottom:1px solid var(--bdr2,#242428)}',
    '.nst-bar button{background:none;border:0;border-radius:0;padding:0 0 7px;margin-bottom:-9px;'
      + 'cursor:pointer;font-family:var(--mono,ui-monospace),monospace;font-size:10px;'
      + 'letter-spacing:.14em;text-transform:uppercase;color:var(--txt3,#6e6e6e);'
      + 'border-bottom:1px solid transparent;white-space:nowrap}',
    '.nst-bar button:hover{color:var(--txt1,#eaf3ff)}',
    '.nst-bar button[aria-selected="true"]{color:var(--txt1,#eaf3ff);'
      + 'border-bottom-color:var(--askacc,#22d3ee)}',
    /* the count rides along quietly - it is the reason to click the tab */
    '.nst-bar button .nst-n{color:var(--txt3,#6e6e6e);margin-left:6px;font-size:9.5px}',
    '.nst-bar button[aria-selected="true"] .nst-n{color:var(--txt2,#a8a8a8)}',
    '.nst-pane[hidden]{display:none!important}',
    /* the group's own heading is redundant once its name is the tab */
    '.nst-pane > .nst-was-head{display:none}',
  ].join('');

  function styles() {
    if (document.querySelector('style[data-novo-subtabs]')) return;
    var s = document.createElement('style');
    s.setAttribute('data-novo-subtabs', '1');
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* Strip the decoration a group heading carries so it reads as a tab: leading glyph entities,
     the " · edge-cleared only" style qualifier, and any trailing count already in the text. */
  function label(el) {
    var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    t = t.replace(/^[^\w(]+\s*/, '');
    var cut = t.split(/\s+[·—-]\s+/)[0];
    return (cut || t).slice(0, 26);
  }

  function countIn(nodes) {
    var n = 0;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.nodeType !== 1) continue;
      // a "row" is whatever the panel repeats; every one of these modules names it *-row
      n += el.matches && el.matches('[class*="-row"]') ? 1
         : (el.querySelectorAll ? el.querySelectorAll('[class*="-row"]').length : 0);
    }
    return n;
  }

  /**
   * Turn the marker-delimited groups inside `root` into sub-tabs.
   * @param {Element|string} root   the panel
   * @param {Object} opts  {marker: css selector for group headings, key: storage key}
   * @returns {number} how many tabs were built (0 = left alone)
   */
  function apply(root, opts) {
    styles();
    root = typeof root === 'string' ? document.querySelector(root) : root;
    if (!root || !opts || !opts.marker) return 0;
    if (root.querySelector('.nst-bar')) return 0;      // already applied to this render

    var marks = [].slice.call(root.querySelectorAll(opts.marker));
    // ONE GROUP IS NOT A SET OF TABS.
    if (marks.length < 2) return 0;

    // The marker's parent is the flow the runs live in. All markers must share it, or "up to the
    // next marker" is not a well-defined run and this must not guess.
    var flow = marks[0].parentNode;
    for (var i = 1; i < marks.length; i++) if (marks[i].parentNode !== flow) return 0;

    var panes = [];
    for (var m = 0; m < marks.length; m++) {
      var pane = document.createElement('div');
      pane.className = 'nst-pane';
      flow.insertBefore(pane, marks[m]);
      var node = marks[m];
      var stop = marks[m + 1] || null;
      while (node && node !== stop) {
        var next = node.nextSibling;
        pane.appendChild(node);
        node = next;
      }
      pane.firstChild && pane.firstChild.classList
        && pane.firstChild.classList.add('nst-was-head');
      panes.push({ el: pane, name: label(marks[m]), n: countIn(pane.childNodes) });
    }

    var bar = document.createElement('div');
    bar.className = 'nst-bar';
    bar.setAttribute('role', 'tablist');

    var storeKey = 'novo_subtab_' + (opts.key || root.id || 'panel');
    var want = null;
    try { want = localStorage.getItem(storeKey); } catch (_e) {}
    var active = 0;
    for (var k = 0; k < panes.length; k++) if (panes[k].name === want) active = k;

    function select(idx) {
      for (var i2 = 0; i2 < panes.length; i2++) {
        panes[i2].el.hidden = i2 !== idx;
        var b = bar.children[i2];
        if (b) b.setAttribute('aria-selected', i2 === idx ? 'true' : 'false');
      }
      try { localStorage.setItem(storeKey, panes[idx].name); } catch (_e) {}
    }

    panes.forEach(function (p2, idx) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.innerHTML = '';
      b.appendChild(document.createTextNode(p2.name));
      if (p2.n > 0) {
        var s = document.createElement('span');
        s.className = 'nst-n';
        s.textContent = p2.n;
        b.appendChild(s);
      }
      b.addEventListener('click', function () { select(idx); });
      bar.appendChild(b);
    });

    // The bar goes immediately before the FIRST group, so whatever the panel put above it — the
    // score row, the summary, the lag banner — stays on screen under every tab.
    flow.insertBefore(bar, panes[0].el);
    select(active);
    return panes.length;
  }

  window.novoSubtabs = { apply: apply };
})();
