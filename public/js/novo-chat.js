/* novo-chat.js — NoVo's analyst chat, as a mountable panel.
 *
 * WHY THIS FILE EXISTS. The chat was written inline in analyst-live.html and then COPIED into
 * crypto-live.html, and the cost of that has already been paid: the image-render bug had to be
 * fixed in both, in the same session, by hand. Adding a third inline copy for the Trader dashboard
 * would make the next fix a three-way sweep with no mechanism to catch the one that gets missed.
 *
 * So this is the extraction — MECHANICAL, from the analyst implementation, not a rewrite. That is
 * deliberate: ~700 lines of stream parsing, transcript persistence, image attachment and render
 * logic have been in front of paying members for weeks. Retyping it would be a rewrite wearing a
 * port's name, and a subtly-wrong SSE reader produces a chat that looks fine until an answer
 * truncates mid-sentence.
 *
 * ⚠ WHAT IS STILL TRUE AND SHOULD NOT BE FORGOTTEN: analyst-live.html and crypto-live.html STILL
 * CARRY THEIR OWN COPIES. This file is used by the Trader dashboard only. That is three
 * implementations for now, which is worse than two on paper — but the third is the one the other
 * two can collapse INTO, and moving two live paid dashboards onto it is a separate change that
 * needs its own testing and Jake's word. Until then, a chat fix goes in three places and this
 * comment is the reminder.
 *
 * MOUNTING. Two shells, one engine:
 *   docked  (Trader)  — window.novoChatMount('#col-novo-body'); the panel fills its container and
 *                       is opened by the tab, never by a bubble.
 *   floating          — window.novoChatMount() with no argument reproduces the analyst shell.
 * Either way the markup, ids and behaviour are identical, which is the point: one set of ids means
 * js/novo-keys.js's "n" shortcut and the /ask palette command work on every surface unchanged.
 */
(function () {
  if (window.__novoChatPanel) return;
  window.__novoChatPanel = true;

  var CSS = `  #novo-ask-bubble{position:fixed;right:18px;bottom:18px;z-index:60;display:flex;align-items:center;gap:9px;
 padding:11px 12px 11px 14px;border-radius:10px;cursor:pointer;
 /* Neutral fill, cyan edge. A cyan glow over a blue-tinted fill has no edge to read
 against and the button goes soft; the same glow over the page's own dark reads as
 an outline. Same treatment as the crypto map's bubble. */
 background:linear-gradient(180deg,var(--navy2),#0b0b0d);color:var(--txt1);font-weight:600;font-size:13.5px;
 min-width:264px;text-align:left;
 box-shadow:0 14px 34px rgba(0,0,0,.55),0 0 26px -6px rgba(var(--askacc-rgb),.45),inset 0 1px 0 rgba(255,255,255,.05)}
  #novo-ask-bubble:hover{color:var(--txt1);
 box-shadow:0 14px 34px rgba(0,0,0,.55),0 0 34px -4px rgba(var(--askacc-rgb),.62),inset 0 1px 0 rgba(255,255,255,.07)}
  #novo-ask-bubble .caret{color:var(--askacc);font-weight:800}
  #novo-ask-bubble kbd{margin-left:auto;font-family:inherit;font-size:11px;font-weight:700;
    color:var(--txt3);border:1px solid var(--bdr);border-radius:6px;padding:2px 6px;
    background:rgba(255,255,255,.03)}
  /* The field has to fit a phone. */
  @media (max-width:640px){ #novo-ask-bubble{min-width:0} }
  /* Advertise the shortcut only where there is a keyboard to press it on. Width is the wrong test --
     a tablet is wide and still has no Ctrl key, which is exactly how "Ctrl K" ended up on one. */
  @media (pointer:coarse){ #novo-ask-bubble kbd{display:none} }
  /* NoVo left something. The bubble is the only place it can show, since the drop lands in a panel
     that is closed by default -- so the dot has to survive until the panel is actually opened. */
  #novo-ask-bubble.has-drop{color:var(--txt1);
 }
  #novo-ask-bubble .dot{display:none;width:7px;height:7px;border-radius:50%;flex:0 0 auto;
    background:var(--askacc)}
  #novo-ask-bubble.has-drop .dot{display:block;animation:novoDrop 2.4s ease-in-out infinite}
  @keyframes novoDrop{0%,100%{opacity:1}50%{opacity:.3}}
  @media (prefers-reduced-motion:reduce){ #novo-ask-bubble.has-drop .dot{animation:none} }
  /* Reduced motion is not a nice-to-have here: a flashing value is exactly the kind of movement that
     hurts people who asked the OS to stop it. The flash still fires as a static tint so the INFORMATION
     (this number just moved, this way) survives — only the animation is removed. */
  @media (prefers-reduced-motion: reduce){
    .lvpulse { animation: none !important; }
    .lvf-up, .lvf-dn { animation: none !important; }
    .lvf-up { background-color: rgba(16,185,129,.16); }
    .lvf-dn { background-color: rgba(244,63,94,.16); }
    button, .lv-mini, .rib, .lv-card, .lv-tile, .dm-row { transition: none !important; }
    button:active, .lv-mini:active { transform: none; }
  }
  /* Anchored to the BOTTOM and wide, not floated in the corner: a centred overlay would cover the
     map you are asking about, and the answer is worth more read against the chart than over it. */
  /* ⚠ THE CHAT SETS ITS OWN FACE, AND ITS CONTROLS SET IT AGAIN. A <button> or <input> does not
   inherit font-family -- it takes the browser's default, which is Arial. The chat carried exactly
   ONE font declaration in its whole stylesheet, so its send button, its input and its chip buttons
   had been rendering in Arial on every dashboard while the text beside them rendered in the house
   face. Measured: the chat BUTTON came out 132.98px on analyst and crypto against 134.06px on the
   trader, which is what exposed it.
   var(--sans) rather than inherit: the trader's body is Geist Mono, and the chat is prose you read
   rather than a tape you scan, so it should be Inter on all three -- the same face the answer would
   have on the site. */
#novo-ask, #novo-ask button, #novo-ask input, #novo-ask textarea, #novo-ask-bubble{font-family:var(--sans)}
#novo-ask{position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:61;
    width:min(calc(100vw - 36px),980px);
    height:min(calc(100dvh - 36px),560px);display:none;flex-direction:column;border-radius:14px;overflow:hidden;
    background:var(--navy,#0b1220);border:1px solid var(--bdr,#22303f);box-shadow:0 18px 50px rgba(0,0,0,.6)}
  #novo-ask.on{display:flex}
  #novo-ask header{display:flex;align-items:center;gap:10px;padding:13px 15px;border-bottom:1px solid var(--bdr,#22303f)}
  #novo-ask header b{color:#eaf3ff;font-size:15px}
  #novo-ask header span{color:var(--txt2,#9fb6d1);font-size:11.5px;display:block;margin-top:1px}
  #novo-ask .clr{margin-left:auto;background:none;border-radius:999px;
 color:var(--txt2,#9fb6d1);font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;
 padding:5px 11px;cursor:pointer;border:0}
  #novo-ask .clr:hover{color:#eaf3ff;}
  #novo-ask .x{background:none;border:0;color:var(--txt2,#9fb6d1);font-size:20px;cursor:pointer;line-height:1}
  #novo-ask .log{flex:1;overflow-y:auto;padding:14px 15px;display:flex;flex-direction:column;gap:12px;
    position:relative;scroll-behavior:smooth;overscroll-behavior:contain}
  @media (prefers-reduced-motion:reduce){ #novo-ask .log{scroll-behavior:auto} }
  #novo-ask #novo-ask-pad{flex:0 0 auto}
  #novo-ask .m{font-size:13.5px;line-height:1.65;color:var(--txt1,#eaf3ff);white-space:pre-wrap;align-self:stretch}
  /* Your side of the conversation, drawn the way a chat client draws it: a bubble on the right,
     NoVo's answers running full width on the left. The asymmetry does what no label could -- you
     can see who said what while scrolling past, before reading a word of it. */
  #novo-ask .m.you{align-self:flex-end;max-width:min(78%,560px); color:#d3f2fb;font-weight:600;color:var(--askacc,currentColor);padding:2px 0}
  /* The time sits INSIDE the message as a trailing inline element, the way a chat client does --
     part of the message, never mistakable for content. Muted hard: findable, never competing. */
  #novo-ask .m .when{margin-left:9px;font-size:10.5px;font-weight:600;color:var(--txt3,#6f8bab);
    white-space:nowrap;font-variant-numeric:tabular-nums;letter-spacing:.02em;vertical-align:baseline}
  #novo-ask .m.you .when{color:rgba(186,232,246,.62)}
  /* Working state. A static line reads as a frozen page; naming the step NoVo is actually on
     reads as somebody doing the work. */
  #novo-ask .m.think{color:var(--txt3,#6f8bab)}
  #novo-ask .m.think .dots::after{content:'';animation:novoDots 1.4s steps(4,end) infinite}
  @keyframes novoDots{0%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'...'}}
  @media (prefers-reduced-motion:reduce){ #novo-ask .m.think .dots::after{animation:none;content:'...'} }
  #novo-ask .src{font-size:11px;color:var(--txt3,#6f8bab);line-height:1.6;border-top:1px solid var(--bdr,#22303f);padding-top:7px}
  #novo-ask .intro{font-size:13px;color:var(--txt2,#9fb6d1);line-height:1.65}
  #novo-ask .chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:11px}
  #novo-ask .chips button{color:var(--txt2,#9fb6d1); font-size:11.5px;padding:7px 10px;cursor:pointer;text-align:left;background:none;border:0}
  /* Quick asks. The intro's suggestions go with the intro, leaving a bare input for the rest of the
     conversation. These persist. ONE scrolling line, not a wrapping block: the rail is wide but the
     log is the thing that should own the height. */
  #novo-ask .quick{display:none;gap:6px;padding:9px 11px 2px;overflow-x:auto;scrollbar-width:none}
  #novo-ask .quick::-webkit-scrollbar{display:none}
  #novo-ask .quick.on{display:flex}
  /* The one chip that is not canned. Accented so it is legible as a reading of the tape rather than
     a seventh stock question, and it always leads the row. */
  #novo-ask .quick button.live{color:#cfefff}
  #novo-ask .quick button.live:hover{color:#eaf3ff}
  #novo-ask .quick button{flex:0 0 auto; color:#9fd8e6;font-size:11.5px;padding:6px 11px;cursor:pointer;white-space:nowrap;background:none;border:0}
  #novo-ask .quick button:hover{color:#eaf3ff}
  #novo-ask form{display:flex;gap:8px;padding:11px;border-top:1px solid var(--bdr,#22303f)}
  #novo-ask input{flex:1; padding:10px 12px;color:#eaf3ff;font-size:13.5px;outline:none;background:transparent;border:0;border-bottom:1px solid var(--bdr,#22303f);outline:0;border-radius:0}
  #novo-ask input:focus{border-bottom-color:var(--askacc,currentColor)}
  #novo-ask button.go{color:#04121a;font-weight:800;padding:0 15px;cursor:pointer;background:none;border:0;color:var(--askacc,currentColor);padding:0 10px;display:inline-flex;align-items:center;justify-content:center}
  #novo-ask button.go:disabled{opacity:.45;cursor:default}


  /* ── chat, upgraded: full-screen on mobile, a thread that reads like a product ── */
  #novo-ask{--askacc:#22d3ee;--askacc-rgb:34,211,238}
  #novo-ask .log{padding:16px 16px 10px;gap:14px}
  #novo-ask .log::-webkit-scrollbar{width:8px}
  #novo-ask .log::-webkit-scrollbar-thumb{background:rgba(128,148,168,.28);border-radius:99px}
  #novo-ask .log::-webkit-scrollbar-track{background:transparent}
  /* NoVo's turns get a quiet card of their own — who said what reads at a glance, and long
     answers stop looking like raw page text. */
  #novo-ask .m:not(.you):not(.think){max-width:min(94%,760px);padding:2px 0}
  #novo-ask .m{font-size:13.75px;line-height:1.7}
  #novo-ask .src{border-top:0;padding:0 2px;margin-top:-7px;font-size:10.5px;opacity:.85;
    max-width:min(94%,760px)}
  #novo-ask header{padding:13px 16px;gap:11px}
  #novo-ask header b::before{content:'';display:inline-block;width:8px;height:8px;border-radius:50%;
    background:var(--askacc);margin-right:8px;vertical-align:1px}
  #novo-ask .x{padding:5px;display:inline-flex;align-items:center;justify-content:center;background:none;border:0}
  #novo-ask .x:hover{color:#eaf3ff}
  #novo-ask form{padding:11px 12px calc(11px + env(safe-area-inset-bottom,0px));gap:9px;align-items:center}
  #novo-ask input{padding:11px 13px;font-size:14px;background:transparent;border:0;border-bottom:1px solid var(--bdr,#22303f);outline:0;border-radius:0}
  #novo-ask button.go{padding:0 18px;height:41px;font-size:14px;background:none;border:0;color:var(--askacc,currentColor);padding:0 10px;display:inline-flex;align-items:center;justify-content:center}
  /* The empty-thread welcome: an intro with a headline, and suggestion chips that look like an
     invitation rather than a settings list. They leave with the first message; the one-line quick
     row above the composer carries suggestions from then on. */
  #novo-ask .intro{padding:6px 2px 0}
  #novo-ask .intro::before{content:'Ask the desk.';display:block;font-size:15px;font-weight:800;
    color:#eaf3ff;letter-spacing:-.01em;margin-bottom:7px}
  #novo-ask .chips{gap:8px;margin-top:14px}
  #novo-ask .chips button{padding:8px 13px;font-size:12px; color:var(--txt2,#9fb6d1); transition:border-color .15s,color .15s;background:none;border:0}
  #novo-ask .chips button:hover{color:#eaf3ff}
  /* Mobile: the chat IS the screen. No sheet floating over a half-visible page — inset zero,
     square corners, the composer padded clear of the home bar, and one chevron to minimize. */
  @media (max-width:720px){
    #novo-ask{left:0;right:0;top:0;bottom:0;transform:none;width:100vw;height:100dvh;
      border-radius:0;border:0}
    #novo-ask header{padding-top:calc(13px + env(safe-area-inset-top,0px))}
    #novo-ask .m.you{max-width:86%;color:var(--askacc,currentColor);padding:2px 0}
    #novo-ask .m:not(.you):not(.think){max-width:96%;padding:2px 0}
    html.novo-ask-lock, html.novo-ask-lock body{overflow:hidden;overscroll-behavior:none}
  }

  /* Desktop expand: the same full-screen chat, one keystroke of intent away. The floating
     panel stays the default; .max takes the whole viewport and remembers the choice. */
  #novo-ask .mx{background:none;border-radius:9px;
 color:var(--txt2,#9fb6d1);font-size:13px;line-height:1;cursor:pointer;padding:6px 9px;border:0}
  #novo-ask .mx:hover{color:#eaf3ff;}
  /* Plain English: a setting a new trader can find without asking for it. Lit when on, because
     a toggle whose state you cannot see is a toggle people press twice. */
  #novo-ask .lvl{background:none;border-radius:9px;
 color:var(--txt2,#9fb6d1);font-size:11.5px;line-height:1;cursor:pointer;padding:6px 9px;
 margin-right:6px;white-space:nowrap;border:0}
  #novo-ask .lvl:hover{color:#eaf3ff;}
  #novo-ask .lvl[aria-pressed="true"]{color:#0b1118;color:var(--askacc,currentColor)}
  /* Go deeper: the answer is short by default now, so the way back to the desk report has to be
     one tap rather than knowing the phrase "deep read". */
  #novo-ask .deeper{background:none; color:var(--txt2,#9fb6d1);font-size:11.5px;cursor:pointer;padding:4px 9px;margin:2px 0 0;border:0}
  #novo-ask .deeper:hover{color:#eaf3ff}
  /* A term you can tap. Underlined faintly rather than coloured like a link -- it is a
     definition, not a navigation, and a paragraph of blue words is unreadable. */
  #novo-ask .term{border-bottom:1px dotted var(--askacc);cursor:help;text-underline-offset:2px}
  #novo-ask .term:hover,#novo-ask .term:focus{color:#eaf3ff;border-bottom-style:solid;outline:none}
  .termpop{position:fixed;z-index:2147483647;background:#0d1620;color:#dce9f7;
    border:1px solid var(--askacc,currentColor);border-radius:6px;padding:9px 11px;font-size:13px;
    line-height:1.5}
  @media (max-width:720px){ #novo-ask .lvl{font-size:11px;padding:5px 7px;background:none;border:0} }
  #novo-ask.max{z-index:101;left:0;right:0;top:0;bottom:0;transform:none;width:100vw;height:100dvh;
    border-radius:0;border:0}
  #novo-ask.max .m:not(.you):not(.think){max-width:min(94%,860px)}
  html.novo-ask-lock-x, html.novo-ask-lock-x body{overflow:hidden;overscroll-behavior:none}
  /* ⚠ 720 -> 768, AND THE MINIMISE CHEVRON GOES WITH IT. Jake, 2026-09-07, on a foldable:
     "that minimize button shouldnt show on mobile and crypto and analyst both show the full page
     button in chat also".
     The mobile TAB BAR starts at 768px and these were gated at 720, so on any device between the
     two -- a foldable, a small tablet, a phone in landscape -- the chat rendered a tab bar AND an
     expand button AND a minimise chevron at the same time. 48px of width nobody tests on.
     Both controls are meaningless once Dr. NoVo is a tab: the panel is already the whole screen so
     there is nothing to expand into, and the bar is how you leave it so there is nothing to
     minimise to. One number for "this is the phone layout", the same one the bar uses. */
  @media (max-width:768px){ #novo-ask .mx, #novo-ask .x{display:none} }

`;

  /* Docked overrides. The base rules position the panel `fixed` because it was built as a floating
     dock; inside a tab column it has to be an ordinary block that fills its parent. Kept as an
     ADDITIVE class rather than edits to the base rules, so the floating shell is untouched and both
     hosts read from one stylesheet. */
  var CSS_DOCKED = `
  /* ⚠ PAINTED EXPLICITLY, NOT LEFT TRANSPARENT. Docked, the panel sits over #workspace, which
     paints rgb(44,44,48) — so the chat read as a grey card on a black dashboard while every other
     surface reads black. Transparent does not mean "no colour", it means "whatever is behind me",
     and what was behind it was the one grey box on the page. Same trap as an artifact body with no
     background borrowing its host's. */
  /* ONE OVERRIDE, WHOLE PANEL. Jake: the Trader chat was blue on a green dashboard. Every accent
     in the base stylesheet now reads through --askacc, so this is the only place the Trader's
     colour is stated — the input border, the Ask button, the quick chips, the level pill, the
     status dot and the term underlines all follow it. */
  #novo-ask.docked{--askacc:#34d399;--askacc-rgb:52,211,153}
  #novo-ask.docked{position:static;transform:none;left:auto;right:auto;bottom:auto;width:100%;
    height:100%;max-height:none;max-width:none;display:flex;border-radius:0;border:0;box-shadow:none;
    background:var(--bg,#09090b);z-index:auto}
  /* The column behind it too, or a seam of workspace grey shows at the edges. */
  #col-novo{background:var(--bg,#09090b)}
  #novo-ask.docked header{border-radius:0}
  /* The floating shell hides itself until opened. Docked, the tab owns visibility, so the panel is
     always laid out — otherwise it would measure zero and the log could never scroll to bottom. */
  #novo-ask.docked:not(.on){display:flex}
  /* ⚠ THIS USED TO MAKE THE EXPAND BUTTON A NO-OP. The rule read
     "#novo-ask.docked.max{position:static}" on the reasoning that "full screen expand is
     meaningless in a tab that is already full width" — but the button is still
     rendered, still says "Expand to full screen", and toggling it changed nothing you could see.
     A control that visibly does nothing is worse than one that is not there. Jake: "the restore
     panel button does not work like the other two it should."
     Docked now escapes its column and takes the viewport, exactly like the floating panel does, so
     expand and restore mean the same thing on all three surfaces. */
  #novo-ask.docked.max{position:fixed;left:0;right:0;top:0;bottom:0;width:100vw;height:100dvh;
    z-index:101;border-radius:0;margin:0}
  `;

  var MARKUP = `<div id="novo-ask" role="dialog" aria-label="Dr. NoVo, the AI market analyst">
  <header>
    <div>
      <b>Dr. NoVo</b>
      <span>AI market analyst</span>
    </div>
    <button class="mx" id="novo-ask-mx" type="button" onclick="novoAskMax()" title="Expand to full screen" aria-label="Expand to full screen">&#x2922;</button>
    <button class="lvl" id="novo-ask-help" type="button" aria-expanded="false" title="What Dr. NoVo can do">Help</button>
    <button class="lvl" id="novo-ask-lvl" type="button" onclick="novoAskLevel()" aria-pressed="false" title="Plain English: define the jargon as I go">Plain English</button>
    <button class="clr" onclick="novoAskClear()" aria-label="Clear this conversation" title="Clear this conversation">Clear</button>
    <button class="x" onclick="novoAskOpen(0)" aria-label="Minimize" title="Minimize"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 9l7 7 7-7"/></svg></button>
  </header>
  <div class="log" id="novo-ask-log">
    <div class="intro">
      Ask about the map, the session, or what is moving it. I read today&rsquo;s dealer positioning,
      every session I have logged and an archive of more than 1,200 articles, so I can tell you what a setup
      like this one has actually resolved to before, and over how many sessions. I go and get the
      catalyst, an earnings date or the macro calendar when the answer needs one.
      <div class="chips">
        <button onclick="novoAsk(this.textContent)">Where is price against the flip right now?</button>
        <button onclick="novoAsk(this.textContent)">How has gamma built or drained today?</button>
        <button onclick="novoAsk(this.textContent)">What has a setup like this usually done?</button>
        <button onclick="novoAsk(this.textContent)">What are the wires saying today?</button>
        <button onclick="novoAsk(this.textContent)">How often does the close land inside the expected move?</button>
        <button onclick="novoAsk(this.textContent)">What is on the calendar this week?</button>
        <button onclick="novoAsk(this.textContent)">Why does IV crush after CPI?</button>
      </div>
    </div>
  </div>
  <!-- Short LABELS, full questions in data-q: the row stays one line and scannable, while the model
       still gets a properly-formed question rather than two words. -->
  <div class="quick" id="novo-ask-quick" aria-label="Quick questions">
    <button type="button" data-q="Read the dealer map right now." onclick="novoAsk(this.dataset.q)">The map</button>
    <button type="button" data-q="What are the key levels right now?" onclick="novoAsk(this.dataset.q)">Key levels</button>
    <button type="button" data-q="What has a setup like this usually done?" onclick="novoAsk(this.dataset.q)">This setup</button>
    <button type="button" data-q="Give me a deep read on this market." onclick="novoAsk(this.dataset.q)">Deep read</button>
    <button type="button" data-q="Alert me if SPY crosses its gamma flip." onclick="novoAsk(this.dataset.q)">Watch a level</button>
    <button type="button" data-q="From your raw archives: how have sessions shaped like this one resolved, since 2008?" onclick="novoAsk(this.dataset.q)">The archives</button>
    <button type="button" data-q="Where does VIX sit against its own history since 1990?" onclick="novoAsk(this.dataset.q)">Vol in context</button>
    <button type="button" data-q="What is on the calendar this week, and what did the last prints do against consensus?" onclick="novoAsk(this.dataset.q)">Catalysts</button>
    <button type="button" data-q="What are the wires saying today?" onclick="novoAsk(this.dataset.q)">Headlines</button>
    <button type="button" data-q="How accurate have your published calls been?" onclick="novoAsk(this.dataset.q)">Your record</button>
  </div>
  <form onsubmit="event.preventDefault();novoAsk(document.getElementById('novo-ask-q').value)">
    <input id="novo-ask-q" placeholder="Ask about the market, or ask for a deep read&hellip;" autocomplete="off" maxlength="600">
    <button class="go" id="novo-ask-go" type="submit" aria-label="Ask"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg></button>
  </form>
</div>`;

  function injectCss() {
    if (document.getElementById('novo-chat-css')) return;
    var s = document.createElement('style');
    s.id = 'novo-chat-css';
    s.textContent = CSS + CSS_DOCKED;
    document.head.appendChild(s);
  }

  /* Mount the panel. `sel` = a container to dock inside; omitted = the floating shell on <body>.
     Returns the panel element, or null if the requested container is not on the page — a missing
     mount point must not throw and take the host page down with it. */
  window.novoChatMount = function (sel) {
    injectCss();
    if (document.getElementById('novo-ask')) return document.getElementById('novo-ask');
    var host = sel ? document.querySelector(sel) : document.body;
    if (!host) return null;
    var wrap = document.createElement('div');
    wrap.innerHTML = MARKUP;
    var panel = wrap.querySelector('#novo-ask');
    if (!panel) return null;
    if (sel) { panel.classList.add('docked'); panel.classList.add('on'); }
    host.appendChild(panel);
    // AFTER insertion: novoChatInit reads innerHTML off the MOUNTED log and restores the saved
    // transcript into it.
    try { window.novoChatInit(); } catch (_e) {}
    // The panel exists NOW. Anything that needs to find #novo-ask-q has to run here, not at load.
    try { wireAttach(); } catch (_e) {}
    try { applyRememberedMax(); } catch (_e) {}
    return panel;
  };
  var busy = false;
  /* ⚠ DO NOT FOCUS THE COMPOSER ON A PHONE. Jake, 2026-09-07: "both analyst and crypto open
     keyboard automatically when chat is open while trader doesnt ... no keyboard until text box
     tapped." Focusing an input IS the gesture that raises the on-screen keyboard, so an autofocus
     on open buries the answer under half a screen of keys before it has been read.
     The trader already had this guard on its own reveal path, which is why only these two showed
     the behaviour - all three files carry the identical q.focus() line, but the trader reaches the
     panel through _novoChatReveal and never through here.
     THE TEST IS FOR A KEYBOARD, NOT FOR A WIDE SCREEN. The trader's guard asked min-width:769px,
     and a tablet is wide and still has no keys - it would have kept doing exactly what Jake is
     reporting. A mouse-and-hover device is the honest proxy for "there is something to type on".
     Returns true when matchMedia is missing so an old browser keeps the desktop behaviour. */
  function _novoHasKeyboard(){
    try { return !!(window.matchMedia &&
      window.matchMedia('(hover: hover) and (pointer: fine)').matches); }
    catch (_e) { return true; }
  }
  window.novoAskOpen = function(on){
    document.getElementById('novo-ask').classList.toggle('on', !!on);
    /* ⚠ AND TELL THE BUTTON. Whatever decided the max state above, the expand control has to agree
       with it. Without this the panel could open already maximised while the button still read
       "Expand to full screen", so the first click did the opposite of what it promised.
       novoAskMax() gets this right on every later toggle, which is why it only ever looked wrong
       at open. */
    try {
      var _mx = document.getElementById('novo-ask-mx');
      if (_mx) {
        var _isMax = _p.classList.contains('max');
        _mx.innerHTML = _isMax ? '&#x2921;' : '&#x2922;';
        _mx.title = _isMax ? 'Restore the panel' : 'Expand to full screen';
        _mx.setAttribute('aria-label', _mx.title);
      }
    } catch (_e) {}
    // Full-screen on mobile means the page behind must not scroll underneath.
    try { document.documentElement.classList.toggle('novo-ask-lock', !!on); } catch(_){}
    try { document.documentElement.classList.toggle('novo-ask-lock-x', !!on && document.getElementById('novo-ask').classList.contains('max')); } catch(_){}
    /* ⚠ NULL-GUARDED FOR THE DOCKED HOST. In the floating layout the bubble is always present, so
       this dereferenced it directly. On the Trader dashboard the panel IS the tab and there is no
       bubble at all — unguarded, novoAskOpen() throws on the FIRST call and the whole chat is dead
       on arrival. The only line in 703 that assumed the floating shell. */
    var _b = document.getElementById('novo-ask-bubble');
    if (_b) {
      _b.style.display = on ? 'none' : 'flex';
      // Opening the panel IS the acknowledgement -- there is nothing else to dismiss.
      if (on) { _b.classList.remove('has-drop'); _b.setAttribute('aria-label', 'Ask Dr. NoVo, the AI market analyst'); }
    }
    // Position on OPEN, not when the message arrived: everything measures zero while the panel is
    // display:none, so a drop or a restored transcript can only be placed once it is on screen.
    if (on) {
      var _lg = document.getElementById('novo-ask-log');
      if (PINNED) pinTop(PINNED, 1);
      else if (_lg) { _lg.style.scrollBehavior = 'auto'; _lg.scrollTop = _lg.scrollHeight; _lg.style.scrollBehavior = ''; }
    }
    if (on && _novoHasKeyboard())
      setTimeout(function(){ var q=document.getElementById('novo-ask-q'); if(q) q.focus(); }, 60);
  };

  // Summoned with "n" when you are not already typing, or "/ask" from the palette. Esc dismisses.
  // Both live in js/novo-keys.js, which owns every key that means the same thing on all surfaces.
  // Cmd/Ctrl-K and "/" USED to open this panel; they now open the command palette in search and
  // command mode respectively. Only the Escape branch below is still ours — the "/" fallback that
  // sat here was DELETED rather than left dormant: novo-keys consumes "/" in capture so it could
  // never fire, and a handler that only wakes up when the layer fails to load would resurrect the
  // old meaning at exactly the moment nothing else was there to contradict it.
  function novoAskTyping(el){
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }
  // Desktop expand/restore — same full screen the phone gets, by choice, and remembered.
  window.novoAskMax = function(){
    var p = document.getElementById('novo-ask');
    var on = !p.classList.contains('max');
    p.classList.toggle('max', on);
    try { document.documentElement.classList.toggle('novo-ask-lock-x', on && p.classList.contains('on')); } catch(_){}
    try { localStorage.setItem('novo_ask_max', on ? '1' : ''); } catch(_){}
    var b = document.getElementById('novo-ask-mx');
    if (b){ b.innerHTML = on ? '&#x2921;' : '&#x2922;'; b.title = on ? 'Restore the panel' : 'Expand to full screen'; }
    // the geometry just changed; put the pinned message back at the top of the view
    if (PINNED) setTimeout(function(){ pinTop(PINNED, 1); }, 30);
  };
  /* Restoring the remembered expand state has the SAME init-order problem as the attach button,
     with the failure hidden even better: `p.classList.add` on a null p throws, the try/catch eats
     it, and the panel silently opens un-maximised having promised to remember. Also run at mount. */
  function applyRememberedMax(){
    try {
      var p = document.getElementById('novo-ask');
      if (!p) return;
      if (localStorage.getItem('novo_ask_max') === '1'){
        p.classList.add('max');
        var b = document.getElementById('novo-ask-mx');
        if (b){ b.innerHTML = '&#x2921;'; b.title = 'Restore the panel'; }
      }
    } catch(_){}
  }
  applyRememberedMax();
  document.addEventListener('keydown', function(e){
    var panel = document.getElementById('novo-ask');
    if (!panel) return;
    var open = panel.classList.contains('on');

    if (e.key === 'Escape' && open) { window.novoAskOpen(0); return; }
  });
  // Every message carries WHEN it was said. This is not decoration: NoVo's lunch drop sits in the
  // log for the rest of the session quoting levels from 12:30, and without a time on it a member
  // reading at 4pm has no way to know the numbers moved. A stale-but-correct read that LOOKS live
  // is the worst thing this product can show.
  function fmtClock(ms){
    try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
    catch(_) { return ''; }
  }
  function fmtWhen(ms){
    if (!ms) return '';
    var age = Date.now() - ms;
    if (age < 45000) return 'just now';
    if (age < 3600000) return Math.round(age / 60000) + 'm ago';
    var d = new Date(ms), n = new Date();
    var sameDay = d.toDateString() === n.toDateString();
    return sameDay ? fmtClock(ms) : (d.toLocaleDateString([], { weekday: 'short' }) + ' ' + fmtClock(ms));
  }
  // Everything appended has to land ABOVE the spacer, or the spacer stops being the last thing
  // in the log and the whole pin-to-top measurement is off by its height.
  function logAdd(node){
    var log = document.getElementById('novo-ask-log');
    var p = document.getElementById('novo-ask-pad');
    if (p && p.parentNode === log) log.insertBefore(node, p); else log.appendChild(node);
    return node;
  }
  function add(cls, text, ts, img){
    var log = document.getElementById('novo-ask-log');
    var d = document.createElement('div'); d.className = 'm ' + (cls||'');
    if (cls === 'you') d.textContent = text; else renderRich(d, text);
    // The picture belongs IN the turn, the way every chat thread does it. Without it the answer
    // reads as a reply to nothing: you cannot tell which chart you sent, or whether it sent at all.
    if (img){
      var im = document.createElement('img'); im.src = img; im.alt = 'image you sent';
      im.style.cssText = 'display:block;margin:6px 0 0;max-width:min(240px,60%);width:auto;border-radius:8px;cursor:zoom-in;';
      im.onclick = function(){ try { window.open(img, '_blank'); } catch(_){} };
      d.appendChild(im);
    }
    if (ts) {
      var w = document.createElement('span'); w.className = 'when'; w.setAttribute('data-t', ts);
      w.textContent = fmtWhen(ts);
      try { w.title = new Date(ts).toLocaleString(); } catch(_){}
      d.appendChild(w);
    }
    logAdd(d); log.scrollTop = log.scrollHeight; return d;
  }
  // Relative stamps go stale sitting on screen, which is the exact failure they exist to prevent.
  // One interval re-renders them all; it costs nothing and it is what makes the panel feel live
  // rather than like a page that was printed once.
  setInterval(function(){
    var ns = document.querySelectorAll('#novo-ask-log .when[data-t]');
    for (var i = 0; i < ns.length; i++) ns[i].textContent = fmtWhen(Number(ns[i].getAttribute('data-t')));
  }, 30000);
  // An answer lands with YOUR question at the top of the view, the way every chat app does it,
  // instead of dropping you at the tail of a 600-word read with the question scrolled off above.
  // When the answer is shorter than the panel there is nothing to scroll into, so a spacer grows
  // underneath -- just enough for the question to reach the top -- and collapses again the moment
  // the content is taller than the view. Same trick Gemini and ChatGPT use; without it a short
  // answer simply refuses to move.
  var PINNED = null, _pinT = null;
  function padEl(){
    var log = document.getElementById('novo-ask-log');
    var p = document.getElementById('novo-ask-pad');
    if (!p) { p = document.createElement('div'); p.id = 'novo-ask-pad'; p.setAttribute('aria-hidden', 'true'); }
    if (p.parentNode !== log) log.appendChild(p);
    return p;
  }
  function pinTop(el, instant){
    var log = document.getElementById('novo-ask-log');
    if (!log || !el || el.parentNode !== log) return;
    PINNED = el;
    // A hidden panel measures as zero, so nothing can be positioned yet -- remember what to pin and
    // let novoAskOpen do it for real. This is the normal case for a drop, which lands while closed.
    if (!log.clientHeight) return;
    var p = padEl();
    // Measure with the spacer out of the flow, otherwise last pass's height inflates this one's.
    p.style.display = 'none';
    var below = log.scrollHeight - el.offsetTop;
    var need = log.clientHeight - below - 12;   // 12 = the flex gap the spacer itself introduces
    if (need > 6) { p.style.height = need + 'px'; p.style.display = 'block'; }
    if (instant) log.style.scrollBehavior = 'auto';
    log.scrollTop = Math.max(0, el.offsetTop - 8);
    if (instant) setTimeout(function(){ log.style.scrollBehavior = ''; }, 0);
  }
  window.addEventListener('resize', function(){
    if (!PINNED) return;
    clearTimeout(_pinT); _pinT = setTimeout(function(){ pinTop(PINNED); }, 120);
  });
  function srcLine(text){
    var log = document.getElementById('novo-ask-log');
    var k = document.createElement('div'); k.className = 'src'; k.textContent = text;
    logAdd(k); return k;
  }

  // ── Wave 3: rich answers, charts, image attach, streaming ──────────────────
  var NCOLOR = '#22d3ee';
  var NAMES = { get_dealer_levels:'live dealer map', get_gamma_profile:'gamma by strike',
    get_session_history:'logged sessions', search_journal:'archive', get_quote:'quote',
    get_economic_calendar:'economic calendar', get_earnings_dates:'earnings date', get_track_record:'track record',
    search_news:'headlines', get_base_rates:'base rates', get_market_internals:'market internals',
    get_vol_history:'vol history', get_futures_positioning:'futures positioning',
    get_recent_reads:'my recent reads', get_crypto_map:'crypto map', get_crypto_breadth:'crypto breadth',
    get_crypto_history:'crypto history', get_chain_token:'chain token', get_chain_alerts:'chain alerts',
    get_chain_history:'chain history', get_market_breadth:'market breadth',
    describe_archive:'archive schema', query_archive:'the raw archives',
    update_reader_memory:'remembered that', set_alert:'alert set', list_alerts:'your alerts',
    cancel_alert:'alert cancelled', get_live_chain:'live option chain' };
  function checkedLine(lookups){
    var seen = {}, parts = [];
    (lookups || []).forEach(function(l){
      var n = (NAMES[l.tool] || l.tool) + (l.args && (l.args.ticker || l.args.symbol) ? ' ' + (l.args.ticker || l.args.symbol) : '');
      if (seen[n]) return; seen[n] = 1;
      parts.push(l.ok ? n : n + ' (no data)');
    });
    return parts.join(' · ');
  }
  function drawNovoChart(spec){
    try{
      var xs = spec.x || [], ys = (spec.y || []).map(Number);
      if (!ys.length || ys.length !== xs.length || ys.length > 60) return null;
      for (var i = 0; i < ys.length; i++) if (!isFinite(ys[i])) return null;
      var wrap = document.createElement('div');
      wrap.style.cssText = 'margin:10px 0;padding:10px 12px;border-top:1px solid rgba(128,128,128,.25);';
      if (spec.title){
        var t = document.createElement('div'); t.textContent = String(spec.title).slice(0, 80);
        t.style.cssText = 'font-size:11px;font-weight:700;letter-spacing:.4px;opacity:.75;margin-bottom:6px;';
        wrap.appendChild(t);
      }
      var W = 460, H = 140, P = 6, dpr = window.devicePixelRatio || 1;
      var c = document.createElement('canvas');
      c.width = W * dpr; c.height = H * dpr;
      c.style.cssText = 'width:100%;max-width:' + W + 'px;height:' + H + 'px;display:block;';
      var g = c.getContext('2d'); g.scale(dpr, dpr);
      var mn = Math.min.apply(null, ys.concat([0])), mx = Math.max.apply(null, ys);
      if (mx === mn) mx = mn + 1;
      var toY = function(v){ return H - P - 12 - (v - mn) / (mx - mn) * (H - 2 * P - 24); };
      g.strokeStyle = 'rgba(128,128,128,.35)';
      g.beginPath(); g.moveTo(0, toY(Math.max(0, mn)) + .5); g.lineTo(W, toY(Math.max(0, mn)) + .5); g.stroke();
      g.fillStyle = NCOLOR; g.strokeStyle = NCOLOR;
      if (spec.type === 'line'){
        g.lineWidth = 2; g.beginPath();
        ys.forEach(function(v, i){
          var x = P + i * (W - 2 * P) / Math.max(1, ys.length - 1);
          i ? g.lineTo(x, toY(v)) : g.moveTo(x, toY(v));
        });
        g.stroke();
      } else {
        var bw = Math.max(2, (W - 2 * P) / ys.length - 2);
        ys.forEach(function(v, i){
          var x = P + i * (W - 2 * P) / ys.length, y0 = toY(Math.max(0, mn)), y1 = toY(v);
          g.globalAlpha = .9;
          g.fillRect(x, Math.min(y0, y1), bw, Math.max(1, Math.abs(y0 - y1)));
        });
        g.globalAlpha = 1;
      }
      g.fillStyle = 'rgba(140,150,160,.95)'; g.font = '9px system-ui';
      g.textAlign = 'left';  g.fillText(String(xs[0]), P, H - 2);
      g.textAlign = 'right'; g.fillText(String(xs[xs.length - 1]), W - P, H - 2);
      g.fillText(String(Math.round(mx * 100) / 100), W - P, 9);
      wrap.appendChild(c);
      return wrap;
    } catch(_e){ return null; }
  }
  // ── the glossary ───────────────────────────────────────────────────────────────
  // Every definition here is one sentence, in NoVo's own register, and says what the thing DOES
  // rather than what it is made of -- "where dealers stop cushioning moves" beats "the strike at
  // which aggregate gamma exposure changes sign". Only the FIRST use of a term in an answer is
  // marked, which is the same discipline the prompt follows: explain once, then get on with it.
  var GLOSS = {
    'gamma flip': 'The price where dealers stop cushioning moves and start amplifying them. Same dealers, opposite instructions.',
    'flip zone': 'The price where dealers stop cushioning moves and start amplifying them.',
    'net gex': 'How hard dealer hedging is leaning against moves. Positive calms the tape; negative accelerates it.',
    'call wall': 'The strike carrying the most call open interest. It tends to act as a ceiling.',
    'put wall': 'The strike carrying the most put open interest. It tends to act as a floor.',
    'gravity': 'The level dealer positioning pulls price toward, all else equal.',
    'long gamma': 'Dealers hedging by buying dips and selling rallies. It dampens the tape.',
    'short gamma': 'Dealers hedging by selling weakness and buying strength. It amplifies the tape.',
    'expected move': "The range options are pricing for the session -- roughly one standard deviation, not a forecast.",
    'open interest': 'How many contracts are still open at a strike. Not volume, which is how many traded.',
    'implied volatility': "The volatility an option's price implies -- what the market is charging for risk.",
    'realized volatility': 'How much the thing actually moved, after the fact.',
    'delta': "How much an option's price moves for a $1 move in the underlying.",
    'gamma': 'How fast delta changes as price moves. Delta is speed; gamma is acceleration.',
    'theta': 'What an option loses to the passage of time each day.',
    'vega': "How much an option's price moves per point of implied volatility.",
    'skew': 'The gap in implied volatility between puts and calls -- what downside protection costs versus upside.',
    'term structure': 'Implied volatility across expiries. Front above back means the near term is the bid one.',
    'vix': "The market's expected 30-day volatility on the S&P 500.",
    'vxn': 'The same idea as VIX, for the Nasdaq 100 -- so it is the gauge for QQQ.',
    'rvx': 'The same idea as VIX, for the Russell 2000 -- so it is the gauge for IWM.',
    'percentile': 'Where a reading sits against its own history. The 90th means higher than 90% of past readings.',
    'dealer': 'The market maker on the other side of the trade. They hedge their book rather than bet on direction.',
    'pin': 'Price getting held near a strike into expiry by dealer hedging.',
    'gamma squeeze': 'Dealer hedging that has to chase price in the direction it is already going.',
    '0dte': 'An option that expires today.',
    'funding rate': 'The recurring payment between long and short holders of a perpetual, which keeps it near spot.',
    'perpetual': 'A futures contract with no expiry date, held near spot by funding payments.',
    'basis': 'The gap between the futures price and spot.',
    'liquidation': 'A leveraged position force-closed by the exchange when margin runs out.',
    'dvol': "Deribit's implied volatility index -- the crypto equivalent of VIX.",
    'short volume': 'The share of volume executed short. A flow reading, not a measure of how many are short.',
    'base rate': 'How often something has actually resolved a given way, before today. The outside view.',
    'liquidity': 'How much money sits in the pool to trade against. Thin liquidity means a small order moves price.'
  };
  var GLOSS_RE = (function(){
    var keys = Object.keys(GLOSS).sort(function(a,b){ return b.length - a.length; })
      .map(function(k){ return k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
    return new RegExp('\\b(' + keys.join('|') + ')\\b', 'gi');
  })();
  function closeTermPop(){ var p = document.getElementById('novo-termpop'); if (p) p.remove(); }
  document.addEventListener('click', function(e){
    if (!e.target.closest || !e.target.closest('.term')) closeTermPop();
  });
  function showTermPop(span, def){
    closeTermPop();
    var p = document.createElement('div');
    p.id = 'novo-termpop'; p.className = 'termpop'; p.textContent = def;
    document.body.appendChild(p);
    var r = span.getBoundingClientRect();
    // Clamp inside the viewport: these fire near the right edge on a phone constantly.
    var w = Math.min(300, window.innerWidth - 20);
    p.style.width = w + 'px';
    var left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    p.style.left = left + 'px';
    var top = r.bottom + 6;
    if (top + p.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - p.offsetHeight - 6);
    p.style.top = top + 'px';
  }
  // Text -> fragment with the first use of each known term made tappable. Runs on TEXT ONLY, so
  // it can never touch a chart block or the markup around it.
  function glossFrag(text){
    var frag = document.createDocumentFragment(), seen = {}, last = 0, m;
    GLOSS_RE.lastIndex = 0;
    while ((m = GLOSS_RE.exec(text))){
      var key = m[1].toLowerCase();
      if (seen[key]) continue;
      seen[key] = 1;
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      var s = document.createElement('span');
      s.className = 'term'; s.textContent = m[1]; s.title = GLOSS[key];
      s.setAttribute('role', 'button'); s.setAttribute('tabindex', '0');
      (function(def){
        s.onclick = function(ev){ ev.stopPropagation(); showTermPop(s, def); };
        s.onkeydown = function(ev){ if (ev.key === 'Enter' || ev.key === ' '){ ev.preventDefault(); showTermPop(s, def); } };
      })(GLOSS[key]);
      frag.appendChild(s);
      last = m.index + m[1].length;
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }
  function renderRich(el, text){
    text = String(text == null ? '' : text);
    var re = /\[\[novochart\s+(\{[\s\S]*?\})\]\]/g, last = 0, m;
    while ((m = re.exec(text))){
      if (m.index > last) el.appendChild(glossFrag(text.slice(last, m.index)));
      var spec = null; try { spec = JSON.parse(m[1]); } catch(_e){}
      var cv = spec && drawNovoChart(spec);
      el.appendChild(cv || document.createTextNode(''));
      last = m.index + m[0].length;
    }
    el.appendChild(glossFrag(text.slice(last)));
  }
  function finishAnswer(d, _qel, el){
    if (!d || !d.ok){
      var em = (d && d.error) || "I came back with nothing usable there — ask me again.", _et = Date.now();
      if (el) el.remove();
      add('', em, _et); TURNS.push({ r: 'novo', x: em, t: _et }); saveTurns(); pinTop(_qel);
      return;
    }
    var _at = Date.now();
    var ansEl = el || add('', '');
    ansEl.textContent = '';
    renderRich(ansEl, d.answer);
    var w = document.createElement('span'); w.className = 'when'; w.setAttribute('data-t', _at);
    w.textContent = fmtWhen(_at);
    try { w.title = new Date(_at).toLocaleString(); } catch(_e){}
    ansEl.appendChild(w);
    var _turn = { r: 'novo', x: d.answer, t: _at, q: d.__q || null };
    if (d.lookups && d.lookups.length){
      var cl = checkedLine(d.lookups);
      if (cl){ _turn.c = 'Checked: ' + cl; srcLine(_turn.c); }
    }
    if (d.sources && d.sources.length){
      _turn.s = 'Sources: ' + d.sources.map(function(x){
        return x.kind === 'memory' ? (x.title + " (Dr. NoVo's own read)") : x.title; }).join(' · ');
      srcLine(_turn.s);
    }
    // Only on a fast answer: a deep read IS the deeper version.
    if (d.mode !== 'deep' && _turn.q){
      var db = deeperBtn(_turn.q);
      if (db) ansEl.parentNode.insertBefore(db, ansEl.nextSibling);
    }
    TURNS.push(_turn); saveTurns(); pinTop(_qel);
  }
  // ── plain English ──────────────────────────────────────────────────────────────
  // The capability was always there: told someone is new, NoVo writes "delta is your speed,
  // gamma is your acceleration". It just needed to STICK, instead of being a confession the
  // reader has to repeat every session. The server owns the setting (it lives in reader memory
  // and the model can set it from "keep it simple" too); this mirrors it locally so the button
  // is lit on arrival rather than after the first answer comes back.
  var LEVEL = (function(){ try { return localStorage.getItem('novo_ask_level') || ''; } catch(_){ return ''; } })();
  function paintLevel(){
    var b = document.getElementById('novo-ask-lvl'); if (!b) return;
    var on = LEVEL === 'plain';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.textContent = on ? 'Plain English: on' : 'Plain English';
    b.title = on ? 'Plain English is on - I define the jargon as I go. Tap to turn it off.'
                 : 'Plain English: I define every term as I use it';
  }
  window.novoAskLevel = function(){
    LEVEL = (LEVEL === 'plain') ? 'standard' : 'plain';
    try { localStorage.setItem('novo_ask_level', LEVEL); } catch(_){}
    paintLevel();
  };
  paintLevel();

  // ── go deeper ──────────────────────────────────────────────────────────────────
  // Answers are short by default now. This is the way back to the full desk report without
  // having to know the phrase, and it re-asks the ORIGINAL question rather than "go deeper",
  // which on its own carries no subject.
  function deeperBtn(q){
    if (!q) return null;
    var b = document.createElement('button');
    b.className = 'deeper'; b.type = 'button'; b.textContent = 'Go deeper';
    b.title = 'Full desk report on this question';
    b.onclick = function(){ b.remove(); window.novoAsk(q, { deep: true }); };
    return b;
  }

  // paste or attach a chart image; it rides the next question
  var PENDIMG = null, PENDTHUMB = null;
  function clearAttach(){ PENDIMG = null; PENDTHUMB = null; var ch = document.getElementById('novo-ask-imgchip'); if (ch) ch.remove(); }
  // A one-line text chip under the composer is what made this feel broken -- you cannot confirm an
  // upload you cannot see. The chip now shows the actual picture, which is the same evidence the
  // thread carries once you hit Ask.
  function setAttach(mime, data, thumb){
    PENDIMG = { mime: mime, data: data }; PENDTHUMB = thumb || null;
    var qi = document.getElementById('novo-ask-q'); if (!qi || !qi.form) return;
    var ch = document.getElementById('novo-ask-imgchip');
    if (!ch){
      ch = document.createElement('div'); ch.id = 'novo-ask-imgchip';
      ch.style.cssText = 'font-size:11px;padding:4px 9px;margin:5px 0 0;border:0;display:inline-flex;gap:8px;align-items:center;cursor:pointer;opacity:.9;';
      ch.title = 'remove the attached image';
      ch.onclick = clearAttach;
      qi.form.parentNode.insertBefore(ch, qi.form.nextSibling);
    }
    ch.textContent = '';
    if (PENDTHUMB){
      var pv = document.createElement('img'); pv.src = PENDTHUMB; pv.alt = 'attached image';
      pv.style.cssText = 'height:34px;width:auto;max-width:84px;border-radius:4px;display:block;';
      ch.appendChild(pv);
    }
    var lb = document.createElement('span');
    lb.textContent = PENDTHUMB ? 'attached ✕' : 'image attached ✕';
    ch.appendChild(lb);
  }
  function ingestImage(file){
    if (!file || String(file.type).indexOf('image/') !== 0) return;
    var img = new Image(), url = URL.createObjectURL(file);
    img.onload = function(){
      try {
        // TWO renditions from one decode. The MODEL gets 1280px because it has to read axis labels
        // and price text off a chart; the THREAD gets a 320px thumb, because the full base64 runs
        // 200-400KB and the transcript lives in localStorage. Send the big one, store the small
        // one -- storing what we send would trade a working transcript for a prettier thumbnail.
        var render = function(max, q){
          var sc = Math.min(1, max / Math.max(img.width, img.height));
          var cv = document.createElement('canvas');
          cv.width = Math.max(1, Math.round(img.width * sc));
          cv.height = Math.max(1, Math.round(img.height * sc));
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          return cv.toDataURL('image/jpeg', q);
        };
        var du = render(1280, 0.85);
        setAttach('image/jpeg', du.slice(du.indexOf(',') + 1), render(320, 0.6));
      } catch(_e){}
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }
  /* ⚠ THIS RUNS AT MOUNT, NOT AT MODULE LOAD, AND THAT IS THE WHOLE POINT.
     It used to be an IIFE opening with `if (!qi || !qi.form) return;`. On the Analyst and Crypto
     the composer markup is INLINE in the page, so the element exists when the script runs and the
     attach button appears. The Trader has no chat markup at all — this module INJECTS the panel in
     novoChatMount() — so at module-load time #novo-ask-q does not exist, the guard returned, and
     the Trader silently never got an attach button or a file input. Jake, twice: "trader does not
     have a attatchment button i told you this last night."
     The guard was doing its job; the call site was wrong. Idempotent, so mounting twice cannot
     produce two buttons. */
  function wireAttach(){
    var qi = document.getElementById('novo-ask-q'); if (!qi || !qi.form) return;
    if (qi.form.querySelector('input[type=file]')) return;   // already wired
    qi.addEventListener('paste', function(ev){
      var its = (ev.clipboardData || {}).items || [];
      for (var i = 0; i < its.length; i++){
        if (its[i].type && its[i].type.indexOf('image/') === 0){ ingestImage(its[i].getAsFile()); ev.preventDefault(); break; }
      }
    });
    var fi = document.createElement('input'); fi.type = 'file'; fi.accept = 'image/*'; fi.style.display = 'none';
    fi.onchange = function(){ if (fi.files && fi.files[0]) ingestImage(fi.files[0]); fi.value = ''; };
    var bt = document.createElement('button'); bt.type = 'button'; bt.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>'; bt.setAttribute('aria-label','Attach an image');
    bt.title = 'Attach a chart image, or just paste one';
    bt.style.cssText = 'background:none;border:0;cursor:pointer;padding:0 8px;color:var(--askacc,currentColor);display:inline-flex;align-items:center;';
    bt.onclick = function(){ fi.click(); };
    qi.form.insertBefore(bt, qi);
    qi.form.appendChild(fi);
  }
  // Surfaces whose markup is inline get it now; injected surfaces get it from novoChatMount.
  wireAttach();

  // The transcript lived only in the DOM, so a reload erased what you asked and what it answered.
  // localStorage keeps it on the device -- nothing transits, no server state, no cost. It expires
  // after a day ON PURPOSE: this is a live map, and yesterday's answers quote levels that have since
  // moved, so holding them longer invites reading a stale number as a current one.
  var TURNS = [], CHAT_KEY = 'novo_ask_log', CHAT_TTL = 24 * 60 * 60 * 1000, CHAT_MAX = 40;
  // Thumbnails made this write big enough to hit the storage quota, and the old body was a bare
  // `try { setItem } catch(_){}` -- so a full store would have silently stopped persisting the
  // TRANSCRIPT in order to make room for a picture. A new feature must never be able to cost the
  // user an existing one, so the ladder degrades in one direction only and its last rung leaves us
  // no worse off than before images existed:
  //   1. write everything   2. drop the OLDEST thumbs, a bounded number of times
  //   3. text only          4. say so once, visibly -- never swallow it
  // The bound is load-bearing: Safari in private mode throws on ANY setItem, so "drop one more and
  // retry" without a cap would discard the entire history chasing a write that can never land.
  function saveTurns(){
      try { if (window.novoChatSync) window.novoChatSync.push(CHAT_SCOPE, TURNS); } catch(_e){}
    var put = function(rows){
      localStorage.setItem(CHAT_KEY, JSON.stringify({ t: Date.now(), turns: rows }));
    };
    var turns = TURNS.slice(-CHAT_MAX);
    try { put(turns); return; } catch(_){}
    var copy = function(m, drop){ var c = {}; for (var k in m) if (!(drop && k === 'img')) c[k] = m[k]; return c; };
    var rows = turns.map(function(m){ return copy(m, false); });
    for (var i = 0, drops = 0; i < rows.length && drops < 12; i++){
      if (!rows[i].img) continue;
      delete rows[i].img; drops++;
      try { put(rows); return; } catch(_){}
    }
    try { put(turns.map(function(m){ return copy(m, true); })); return; } catch(_){}
    if (!saveTurns._warned){
      saveTurns._warned = true;
      try {
        var w = add('', 'History is not being saved in this browser, so this conversation will disappear on reload.');
        if (w) w.style.opacity = '.6';
      } catch(_){}
    }
  }
  function renderTurn(m){
    var el = add(m.r === 'you' ? 'you' : '', m.x, m.t, m.img);
    if (m.c) srcLine(m.c);
    if (m.s) srcLine(m.s);
    return el;
  }

  /* ── CROSS-DEVICE SYNC (2026-09-06) ───────────────────────────────────────────────────────────
     Jake: the transcript was per-BROWSER, so the same member on a phone found an empty chat. The
     server copy is merged into localStorage by js/novo-chat-sync.js and this re-reads it. Kept to
     a re-read rather than a render path of its own, because the page already knows how to draw a
     transcript and a second drawing path is a second thing to keep in step. */
  window.novoChatReload = function(){
    TURNS = [];
    PINNED = null;
    var log = document.getElementById('novo-ask-log');
    if (log) log.innerHTML = INTRO_HTML;
    loadTurns();
  };
  var CHAT_SCOPE = (CHAT_KEY.indexOf('crypto') >= 0) ? 'crypto' : 'equity';
  /* Analyst and Trader share `equity` on purpose: a subscriber does not experience them as two
     products, and a Trader subscription always included this chat — it just used to live behind the
     Analyst dashboard. Crypto keeps its own scope, which is what its author chose when they gave it
     a separate storage key: a different desk, a different asset class. */
  function novoChatPull(){
    try {
      if (!window.novoChatSync) return;
      window.novoChatSync.pull(CHAT_SCOPE, CHAT_KEY).then(function(changed){
        // Only repaint if the server actually had something this device did not.
        if (changed) try { window.novoChatReload(); } catch(_e){}
      });
    } catch(_e){}
  }

  function loadTurns(){
    try {
      var raw = localStorage.getItem(CHAT_KEY); if (!raw) return;
      var o = JSON.parse(raw);
      if (!o || !Array.isArray(o.turns) || !o.t || (Date.now() - o.t) > CHAT_TTL) { localStorage.removeItem(CHAT_KEY); return; }
      TURNS = o.turns.slice(-CHAT_MAX);
      if (!TURNS.length) return;
      var intro = document.querySelector('#novo-ask .intro'); if (intro) intro.remove();
      window.novoAskQuick();
      var last = null;
      TURNS.forEach(function(m){ var el = renderTurn(m); if (m.r === 'you') last = el; });
      var log = document.getElementById('novo-ask-log'); if (log) log.scrollTop = log.scrollHeight;
      if (last) pinTop(last);
    } catch(_){}
  }
  // Clearing has to wipe all three: the in-memory turns (which travel to the model as context), the
  // stored copy, and the rendered log. Dropping any one leaves the conversation half-alive -- a cleared
  // screen that still sends what you thought you deleted would be the worst of the three to get wrong.
  // The intro and the quick row are two states of the same thing, so one function owns which is
  // visible rather than three call sites each remembering to.
  window.novoAskQuick = function(){
    var q = document.getElementById('novo-ask-quick');
    if (q) q.classList.toggle('on', !document.querySelector('#novo-ask .intro'));
  };

  // NoVo speaking FIRST. The note rides the live payload the dashboard already polls, so all this has
  // to decide is whether it is new: the id is dated, and the seen-id is kept on the device beside the
  // transcript it belongs to. It enters the log as an ordinary NoVo turn, which means it persists,
  // scrolls and clears exactly like an answer he gave -- and travels back as context on the next ask,
  // so "what did you mean by that?" works without any special case.
  window.novoChatDrop = function(cd){
    if (!cd || !cd.id || !cd.text) return;
    var seen = null; try { seen = localStorage.getItem('novo_drop_seen'); } catch(_){}
    if (seen === cd.id) return;
    try { localStorage.setItem('novo_drop_seen', cd.id); } catch(_){}
    var intro = document.querySelector('#novo-ask .intro'); if (intro) intro.remove();
    // cd.ts is when NoVo WROTE it (unix seconds from the engine), not when this browser rendered
    // it. Using Date.now() here would stamp a 12:30 read with the time you happened to open the
    // panel -- which is precisely the confusion this whole change exists to remove.
    var m = { r: '', x: cd.text, t: (cd.ts ? cd.ts * 1000 : Date.now()) };
    TURNS.push(m); saveTurns();
    var el = renderTurn(m); window.novoAskQuick();
    // NoVo speaking first has no question above it, so the note itself is what pins -- a long drop
    // should open at its first line rather than its last.
    pinTop(el);
    var panel = document.getElementById('novo-ask');
    if (!panel || !panel.classList.contains('on')) {
      var b = document.getElementById('novo-ask-bubble');
      if (b) { b.classList.add('has-drop'); b.setAttribute('aria-label', 'Dr. NoVo left you a note'); }
    }
  };
  window.novoAskClear = function(){
    TURNS = [];
    try { localStorage.removeItem(CHAT_KEY); } catch(_){}
    var log = document.getElementById('novo-ask-log');
    if (log) log.innerHTML = INTRO_HTML;   // takes the spacer with it; padEl() rebuilds it on demand
    PINNED = null;
    /* Same rule on Clear: tapping it should empty the box, not summon the keyboard. */
    var qi = document.getElementById('novo-ask-q');
    if (qi) { qi.value = ''; if (_novoHasKeyboard()) qi.focus(); }
    window.novoAskQuick();
  };
  /* ⚠ RUNS AT FIRST MOUNT, NOT AT LOAD — see the build script for why. Neither of these throws
     when the panel is absent; they just quietly do nothing, which is why it is written down. */
  var INTRO_HTML = '';
  var _inited = false;
  window.novoChatInit = function(){
    if (_inited) return;
    var l = document.getElementById('novo-ask-log');
    if (!l) return;                 // not mounted yet — the next mount calls this again
    _inited = true;
    INTRO_HTML = l.innerHTML;       // captured BEFORE any turn is appended
    loadTurns();
  };
    novoChatPull();
  // The dashboard keeps TOKEN inside its own IIFE, so it is not reachable from here — read the
  // storage key it persists to instead, which is what the push-notification code already does.
  function tok(){
    try { var u = new URLSearchParams(location.search).get('t'); if (u) return u; } catch(_){}
    try { return localStorage.getItem('novo_live_t') || ''; } catch(_){ return ''; }
  }
  window.novoAsk = async function(q, opts){
    q = (q||'').trim(); if (!q || busy) return;
    opts = opts || {};
    var intro = document.querySelector('#novo-ask .intro'); if (intro) intro.remove();
    window.novoAskQuick();
    document.getElementById('novo-ask-q').value = '';
    // Snapshot the prior turns BEFORE this question joins them -- it travels in `question`, and sending
    // it twice would have NoVo answering an echo of itself.
    var hist = TURNS.slice(-6).map(function(m){ return { role: m.r === 'you' ? 'user' : 'novo', text: m.x }; });
    var _now = Date.now();
    // Grab the thumb BEFORE the send clears the attachment, and put it in the turn -- on screen
    // and in the stored transcript, so a reload still shows what the question was about.
    var _thumb = PENDTHUMB;
    var _qel = add('you', q, _now, _thumb);
    TURNS.push(_thumb ? { r: 'you', x: q, t: _now, img: _thumb } : { r: 'you', x: q, t: _now });
    saveTurns();
    // Name the step, and move through them. NoVo really does hit the map, then the tape, then its
    // own logged sessions -- this is the shape of the work, not a fake progress bar.
    var thinking = add('', '');
    thinking.className = 'm think';
    var _stages = ['Reading the map', 'Checking the tape', 'Pulling levels', 'Working through it'],
        _si = 0, _sp = document.createElement('span'), _dt = document.createElement('span');
    _dt.className = 'dots'; _sp.textContent = _stages[0];
    thinking.appendChild(_sp); thinking.appendChild(_dt);
    var _stageTimer = setInterval(function(){
      _si = Math.min(_si + 1, _stages.length - 1); _sp.textContent = _stages[_si];
    }, 2600);
    var _stopThinking = function(){ clearInterval(_stageTimer); thinking.remove(); };
    // Pin as soon as the question is in: the working state then plays directly under it rather
    // than at the bottom of wherever you happened to be scrolled.
    pinTop(_qel);
    busy = true; document.getElementById('novo-ask-go').disabled = true;
    try{
      var _body = { question: q, app: 'trader', t: tok() || null, history: hist, surface: (window.NOVO_CHAT_SURFACE || 'equity'), stream: true,
                    level: LEVEL || undefined, deep: opts.deep || undefined };
      if (PENDIMG) { _body.image = PENDIMG; clearAttach(); }
      var r = await fetch('/api/analyst-ask', {
        method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify(_body)
      });
      var ctype = (r.headers.get('content-type') || '');
      if (ctype.indexOf('text/event-stream') < 0) {
        var d = await r.json();
        _stopThinking();
        finishAnswer(d, _qel, null);
      } else {
        var ansEl = null, chkEl = null, doneObj = null, errObj = null, acc = '';
        var reader = r.body.getReader(), dec = new TextDecoder(), buf = '';
        for(;;){
          var st = await reader.read(); if (st.done) break;
          buf += dec.decode(st.value, { stream: true });
          var ix;
          while ((ix = buf.indexOf('\n\n')) >= 0){
            var frame = buf.slice(0, ix); buf = buf.slice(ix + 2);
            if (frame.slice(0, 5) !== 'data:') continue;
            var ev = null; try { ev = JSON.parse(frame.slice(5)); } catch(_e){ continue; }
            if (ev.type === 'delta' && ev.text){
              if (!ansEl){ _stopThinking(); ansEl = add('', ''); pinTop(_qel); }
              acc += ev.text; ansEl.textContent = acc;
            } else if (ev.type === 'lookups'){
              if (!chkEl) chkEl = srcLine('');
              chkEl.textContent = 'Checking: ' + checkedLine(ev.lookups);
            } else if (ev.type === 'done'){ doneObj = ev; }
            else if (ev.type === 'error'){ errObj = ev; }
          }
        }
        _stopThinking();
        if (chkEl) chkEl.remove();
        if (errObj || !doneObj){
          if (ansEl) ansEl.remove();
          var em = (errObj && errObj.error) || "The connection dropped before I finished that answer. Nothing was saved — ask again and I'll start over.", _et = Date.now();
          add('', em, _et); TURNS.push({ r: 'novo', x: em, t: _et }); saveTurns(); pinTop(_qel);
        } else {
          doneObj.__q = q; finishAnswer(doneObj, _qel, ansEl);
        }
      }
    } catch(e){ _stopThinking(); add('', "I couldn't reach the desk just then. Check your connection and ask again — your question wasn't sent.", Date.now()); pinTop(_qel); }
    busy = false; document.getElementById('novo-ask-go').disabled = false;
  };
})();
