/* novo-feed.js — ONE renderer for the Analysis Feed, on both dashboards.
 *
 * Jake, 2026-09-12, with Trader and Analyst open side by side: "quality of display must match look
 * at analysis feed in trade vs analyst, analyst sucks... fix it."
 *
 * He was right, and the two surfaces were not close. Both read the SAME string — the engine's
 * `intel_text`, published to Analyst as `intel` — and:
 *
 *   TRADER   parsed it into a title, a date line, section headers, a sentiment pill for the bias,
 *            a two-column grid of level cards, and prose for the thesis.
 *   ANALYST  printed the whole thing into a single <pre>. Raw log output on a paid dashboard:
 *            "MACRO BIAS      : NEUTRAL", colons hanging in mid-air, levels as one run-on line.
 *
 * The renderer was ~90 lines living INSIDE trader-live.html's websocket onmessage handler, which
 * is why Analyst never got it — it was not reachable from anywhere else, so the second surface
 * did the cheapest thing that could work. That is the same three-copies shape this codebase
 * already pays for in the chat CSS, so the fix is not to paste it a second time: it moves here,
 * verbatim, and BOTH dashboards call it. A future improvement lands on both or neither.
 *
 * ⚠ THE PARSE IS LIFTED UNCHANGED. Trader's feed is the surface Jake likes; this module was
 * verified to emit byte-identical HTML to the old inline code on the real payload before either
 * dashboard was rewired. If you change the parse, re-run that comparison — "it still looks right"
 * is not the same claim.
 */
(function () {
  'use strict';

  /* Trader defines --font/--red/--grn/--cyn; Analyst defines none of the four. A verbatim copy of
     Trader's CSS therefore rendered on Analyst with no heading font and no bull/bear colour at all
     — the port would have "worked" and looked broken. Every var() below carries the literal Trader
     value as its fallback, so the two surfaces match on a dashboard that never declared them. */
  var CSS = [
    '.nf-title{font-size:14px;font-weight:900;color:var(--txt1);letter-spacing:-0.5px;margin-bottom:2px;font-family:var(--font,var(--mono,ui-monospace,monospace));}',
    '.nf-sub{font-size:10px;color:var(--txt3);margin-bottom:14px;font-family:var(--sans);}',
    '.nf-section{margin-bottom:12px;}',
    '.nf-lbl{font-size:8px;font-weight:900;letter-spacing:2.5px;text-transform:uppercase;color:var(--txt3);display:block;padding:8px 0 6px;border-bottom:1px solid var(--bdr);margin-top:14px;margin-bottom:8px;font-family:var(--sans);}',
    '.nf-body{font-size:12px;color:var(--txt2);line-height:1.8;font-family:var(--sans);}',
    '.nf-bias{display:inline-block;padding:3px 14px;border-radius:4px;font-family:var(--font,var(--mono,ui-monospace,monospace));font-size:12px;font-weight:800;letter-spacing:1.5px;border:1px solid;}',
    '.nf-bias-bear{color:var(--red,#f43f5e);border-color:rgba(244,63,94,.5);background:rgba(244,63,94,.08);}',
    '.nf-bias-bull{color:var(--grn,#10b981);border-color:rgba(16,185,129,.5);background:rgba(16,185,129,.08);}',
    '.nf-bias-neut{color:var(--txt2);border-color:var(--bdr);background:rgba(255,255,255,.03);}',
    '.nf-levels{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;margin-top:4px;}',
    '.nf-lvl{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:4px 9px;background:rgba(255,255,255,.02);border-left:2px solid var(--bdr);}',
    '.nf-lvl-k{font-family:var(--sans);font-size:10px;color:var(--txt3);text-transform:uppercase;letter-spacing:.3px;}',
    '.nf-lvl-v{font-family:var(--font,var(--mono,ui-monospace,monospace));font-size:12.5px;font-weight:700;color:var(--txt1);white-space:nowrap;}',
    /* Analyst renders this full-width rather than in a 310px rail, and a two-column level grid
       stretched across 1500px puts the label and its number a hand's width apart. */
    '@media (min-width:1100px){.novo-feed-wide .nf-levels{grid-template-columns:repeat(4,1fr);}}',
    '.novo-feed-wide .nf-body{font-size:13px;max-width:88ch;}',
    '.novo-feed-wide .nf-title{font-size:16px;}',
  ].join('');

  function styles() {
    if (document.querySelector('style[data-novo-feed]')) return;
    var st = document.createElement('style');
    st.setAttribute('data-novo-feed', '1');
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function stripEmoji(s) {
    return (s || '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/^[ \t]+|[ \t]+$/gm, '');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function colorize(t) {
    t = t.replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--txt1);font-weight:700;">$1</strong>');
    t = t.replace(/(\$[\d,]+\.?\d*|[-+]?\d+\.?\d*%)/g, '<span style="color:var(--cyn,#22d3ee);font-weight:600;">$1</span>');
    /* (inline green/red/amber sentiment-word colouring removed 2026-07-13 — single coloured words
        mid-sentence read tacky; the prose stays clean neutral text, bold + cyan numbers only.) */
    return t;
  }

  /* A section header is an ALL-CAPS label before the first colon — or one of the desk-note labels,
     which stand alone with no colon at all. */
  var DESK_LABELS = ['THE READ', 'STRUCTURAL POSTURE', 'WHAT TO WATCH', 'WHAT CHANGED',
    'WHAT IT MEANS', 'KEY LEVELS', 'THE OPEN', 'THE CLOSE', 'THE WEEK AHEAD', 'THE SETUP',
    'THE TAKEAWAY'];
  function isSHdr(line) {
    var s = line.replace(/\*\*/g, '').trim();
    if (DESK_LABELS.indexOf(s.toUpperCase()) >= 0) return true;
    var ci = s.indexOf(':');
    if (ci < 3 || ci > 30) return false;
    var lbl = s.slice(0, ci);
    return /^[A-Z]/.test(lbl) && lbl === lbl.toUpperCase();
  }
  function parseSHdr(line) {
    var s = line.replace(/\*\*/g, '').trim();
    var ci = s.indexOf(':');
    if (ci < 0) return { label: s.trim(), body: '' };
    return { label: s.slice(0, ci).trim(), body: s.slice(ci + 1).trim() };
  }

  function render(text) {
    if (!text) return '';
    var lines = stripEmoji(String(text)).split('\n');
    var html = '';
    var i = 0;
    /* Title block: the first lines before any section header. The engine wraps the title in
       square brackets; they are punctuation for a log file, not for a reader. */
    while (i < lines.length) {
      var l = lines[i];
      if (!l.trim()) { i++; break; }
      if (isSHdr(l)) break;
      if (i === 0) html += '<div class="nf-title">' + esc(l.trim().replace(/^\[+\s*/, '').replace(/\s*\]+$/, '')) + '</div>';
      else html += '<div class="nf-sub">' + esc(l.trim()) + '</div>';
      i++;
    }
    while (i < lines.length) {
      var ln = lines[i];
      if (!ln.trim()) { i++; continue; }
      if (isSHdr(ln)) {
        var p = parseSHdr(ln);
        var label = p.label, body = p.body;
        var U = label.toUpperCase();
        var bodyLines = [];
        if (body) bodyLines.push(body);
        i++;
        while (i < lines.length && lines[i].trim() && !isSHdr(lines[i])) {
          bodyLines.push(lines[i].trim());
          i++;
        }
        var rawBody = bodyLines.join(' ');
        var bodyHtml;
        if (U.indexOf('PATTERN') >= 0) {
          /* Observed Patterns always gets the pill, in BOTH directions — not only when the text
             happens to open with a bias word. Checked before the bias branch below. */
          var bt = rawBody.trim();
          var cls = /BEAR/i.test(bt) ? 'nf-bias-bear' : /BULL/i.test(bt) ? 'nf-bias-bull' : 'nf-bias-neut';
          bodyHtml = '<span class="nf-bias ' + cls + '">' + esc(bt) + '</span>';
        } else if (U.indexOf('BIAS') >= 0 || /^(BULLISH|BEARISH|NEUTRAL)\b/i.test(rawBody.trim())) {
          var bt2 = rawBody.trim();
          var cls2 = /BEAR/i.test(bt2) ? 'nf-bias-bear' : /BULL/i.test(bt2) ? 'nf-bias-bull' : 'nf-bias-neut';
          bodyHtml = '<span class="nf-bias ' + cls2 + '">' + esc(bt2) + '</span>';
        } else if (U.indexOf('LEVEL') >= 0) {
          var items = rawBody.split(/[,;]+/).map(function (x) { return x.trim(); }).filter(Boolean);
          var cells = '';
          items.forEach(function (it) {
            var m = it.match(/^(.*?)[\s:]+([\d][\d.,]*)$/);
            if (m) {
              cells += '<div class="nf-lvl"><span class="nf-lvl-k">' + esc(m[1].trim())
                + '</span><span class="nf-lvl-v">' + esc(m[2].trim()) + '</span></div>';
            } else {
              cells += '<div class="nf-lvl"><span class="nf-lvl-k">' + esc(it) + '</span><span class="nf-lvl-v"></span></div>';
            }
          });
          bodyHtml = '<div class="nf-levels">' + cells + '</div>';
        } else {
          bodyHtml = colorize(esc(rawBody));
        }
        html += '<div class="nf-section"><div class="nf-lbl">' + esc(label)
          + '</div><div class="nf-body">' + bodyHtml + '</div></div>';
      } else {
        html += '<div class="nf-body">' + colorize(esc(ln)) + '</div>';
        i++;
      }
    }
    return html;
  }

  /* `wide` is for the full-width Analyst card; the Trader rail leaves it off. */
  function mount(el, text, opts) {
    if (!el) return false;
    styles();
    el.classList.add('novo-feed');
    if (opts && opts.wide) el.classList.add('novo-feed-wide');
    el.innerHTML = render(text);
    return true;
  }

  window.novoFeed = { render: render, mount: mount, styles: styles };
})();
