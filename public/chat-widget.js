/* NoVo "Message us" support widget. Self-contained, no deps. Include once per page:
   <script defer src="/chat-widget.js"></script>
   Talks to /api/chat (Gemini-backed, guardrailed). Product/how-to support only; account/money -> email. */
(function () {
  if (window.__novoChat) return; window.__novoChat = true;

  var SUPPORT = 'support@novo-options.trade';
  var messages = [];      // {role:'user'|'assistant', content}
  var busy = false, opened = false;

  var css = ''
    + '.nvc-btn{position:fixed;right:18px;bottom:calc(18px + env(safe-area-inset-bottom,0px));'
    + 'z-index:2147483000;height:44px;padding:0 15px;border-radius:999px;gap:9px;'
    + 'border:1px solid rgba(34,211,238,.34);background:rgba(20,21,25,.92);backdrop-filter:blur(8px);'
    + 'color:#9fb6d1;cursor:pointer;font-family:inherit;font-size:13.5px;font-weight:700;letter-spacing:.01em;'
    + 'box-shadow:0 8px 24px rgba(0,0,0,.45),0 0 26px -6px rgba(34,211,238,.55);'
    + 'display:inline-flex;align-items:center;justify-content:center;'
    + 'transition:border-color .18s,color .18s,box-shadow .18s}'
    + '.nvc-btn svg{width:17px;height:17px;flex:0 0 auto;stroke:#22d3ee}'
    + '.nvc-btn:hover,.nvc-btn:focus-visible{border-color:rgba(34,211,238,.75);color:#eaf3ff;'
    + 'box-shadow:0 8px 26px rgba(0,0,0,.5),0 0 34px -4px rgba(34,211,238,.8);outline:none}'
    /* On a phone it collapses to a disc: the label is the first thing to cost more room than it
       earns when the viewport is 390px wide and the button sits over the copy. */
    + '@media(max-width:560px){.nvc-btn{padding:0;width:44px;gap:0}.nvc-btn .nvc-lbl{display:none}}'
    /* Open state: the icon rotates into a cross rather than the label being swapped out, so the
       button never loses its content and never reflows. */
    + '.nvc-btn .nvc-ico-x{display:none}'
    + '.nvc-btn.nvc-open .nvc-ico-chat{display:none}'
    + '.nvc-btn.nvc-open .nvc-ico-x{display:block}'
    + '.nvc-btn.nvc-open .nvc-lbl{display:none}'
    + '.nvc-btn.nvc-open{padding:0;width:44px;gap:0;border-color:rgba(34,211,238,.5)}'
    + '.nvc-panel{position:fixed;right:20px;bottom:88px;z-index:2147483000;width:370px;max-width:calc(100vw - 32px);'
    + 'height:540px;max-height:calc(100vh - 120px);background:#121316;border:1px solid #2e3036;border-radius:14px;'
    + 'display:none;flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.55);'
    + "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}"
    + '.nvc-panel.open{display:flex}'
    + '.nvc-hd{padding:14px 16px;background:#1c1d21;border-bottom:1px solid #2e3036;display:flex;align-items:center;gap:10px}'
    + '.nvc-hd b{color:#eaf3ff;font-size:14px}.nvc-hd .nvc-sub{color:#6f8bab;font-size:11px}'
    + '.nvc-x{margin-left:auto;background:none;border:none;color:#8aacc8;font-size:20px;cursor:pointer;line-height:1}'
    + '.nvc-body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}'
    + '.nvc-msg{max-width:85%;padding:9px 12px;border-radius:12px;font-size:13.5px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}'
    + '.nvc-a{align-self:flex-start;background:#1c1d21;border:1px solid #2e3036;color:#c2d2e6;border-bottom-left-radius:4px}'
    + '.nvc-u{align-self:flex-end;background:#152a4a;border:1px solid #2c4a78;color:#eaf3ff;border-bottom-right-radius:4px}'
    + '.nvc-a b{color:#eaf3ff}.nvc-a a{color:#34d399}'
    + '.nvc-foot{border-top:1px solid #2e3036;padding:10px;background:#1c1d21}'
    + '.nvc-row{display:flex;gap:8px;align-items:flex-end}'
    + '.nvc-in{flex:1;resize:none;background:#0e0f11;border:1px solid #2e3036;color:#eaf3ff;border-radius:9px;'
    + 'padding:9px 11px;font-family:inherit;font-size:13.5px;line-height:1.4;max-height:100px;outline:none}'
    + '.nvc-in:focus{border-color:#3b82f6}'
    + '.nvc-send{background:linear-gradient(180deg,#22d3ee,#3b82f6);border:none;color:#04121a;font-weight:800;'
    + 'border-radius:9px;padding:9px 14px;cursor:pointer;font-size:13px}.nvc-send:disabled{opacity:.5;cursor:default}'
    + '.nvc-note{color:#506e8f;font-size:10.5px;text-align:center;margin-top:7px}.nvc-note a{color:#6f8bab}'
    + '.nvc-typing{color:#6f8bab;font-size:12px;font-style:italic}';

  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  // minimal formatting: **bold**, autolink bare emails, keep newlines (white-space:pre-wrap handles them)
  function fmt(s){
    var h = esc(s).replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>');
    h = h.replace(/(^|\n)[ \t]*[*-][ \t]+/g, '$1• ');   // markdown bullets -> a real bullet
    h = h.replace(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,'<a href="mailto:$1">$1</a>');
    return h;
  }

  var btn, panel, bodyEl, inputEl, sendEl;

  function scrollDown(){ bodyEl.scrollTop = bodyEl.scrollHeight; }
  function addMsg(role, text){
    var d = document.createElement('div');
    d.className = 'nvc-msg ' + (role === 'user' ? 'nvc-u' : 'nvc-a');
    d.innerHTML = role === 'user' ? esc(text) : fmt(text);
    bodyEl.appendChild(d); scrollDown(); return d;
  }

  var introShown = false;

  function open(){
    opened = true; panel.classList.add('open'); btn.classList.add('nvc-open');
    // Guard on the intro itself, not on messages.length. addMsg() only paints the
    // DOM -- it never pushes to `messages`, which send() owns -- so the old check
    // stayed true on every reopen and stacked another greeting each time.
    if (!introShown) { introShown = true; addMsg('assistant',
      "Support here. Ask anything about how NoVo works: the plans, what the dealer map shows, pricing, billing, or what a term means. For anything account-specific or money-related, I'll point you to " + SUPPORT + "."); }
    setTimeout(function(){ inputEl.focus(); }, 50);
  }
  function close(){ opened = false; panel.classList.remove('open'); btn.classList.remove('nvc-open'); }

  async function send(){
    var text = inputEl.value.trim();
    if (!text || busy) return;
    inputEl.value=''; inputEl.style.height='auto';
    messages.push({role:'user', content:text}); addMsg('user', text);
    busy = true; sendEl.disabled = true;
    var typing = document.createElement('div'); typing.className='nvc-typing'; typing.textContent='The desk is typing…';
    bodyEl.appendChild(typing); scrollDown();
    try {
      var r = await fetch('/api/chat', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({messages: messages})});
      var data = await r.json().catch(function(){return {};});
      typing.remove();
      if (r.ok && data.reply){ messages.push({role:'assistant', content:data.reply}); addMsg('assistant', data.reply); }
      else { addMsg('assistant', (data && data.error) ? data.error : ('Something went wrong — please email ' + SUPPORT + '.')); }
    } catch(e){
      typing.remove();
      addMsg('assistant', 'Connection error — please email ' + SUPPORT + '.');
    } finally { busy = false; sendEl.disabled = false; inputEl.focus(); }
  }

  function mount(){
    var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

    btn = document.createElement('button'); btn.className='nvc-btn'; btn.setAttribute('aria-label','Message support');
    // An inline SVG, not an emoji: 💬 is a different picture on every platform and none of them
    // match the site. Stroked in the same cyan the rest of the UI accents with.
    var SVG = 'viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
    btn.innerHTML = '<svg class="nvc-ico-chat" ' + SVG + '><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-2.8-.4L3 21l1.6-4.6A8.1 8.1 0 0 1 3.6 11.5 8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z"/></svg>'
      + '<svg class="nvc-ico-x" ' + SVG + '><path d="M18 6 6 18M6 6l12 12"/></svg>'
      + '<span class="nvc-lbl">Support</span>';
    btn.onclick = function(){ opened ? close() : open(); };

    panel = document.createElement('div'); panel.className='nvc-panel'; panel.setAttribute('role','dialog'); panel.setAttribute('aria-label','NoVo Options Trading support');
    panel.innerHTML =
      '<div class="nvc-hd"><b>Message the desk</b><span class="nvc-sub">plans, brokers &amp; billing</span>'
      + '<button class="nvc-x" aria-label="Close">×</button></div>'
      + '<div class="nvc-body"></div>'
      + '<div class="nvc-foot"><div class="nvc-row">'
      + '<textarea class="nvc-in" rows="1" placeholder="Ask about plans, brokers or billing…"></textarea>'
      + '<button class="nvc-send">Send</button></div>'
      + '<div class="nvc-note">Support &amp; education only — not financial advice. Account/billing: '
      + '<a href="mailto:' + SUPPORT + '">' + SUPPORT + '</a></div></div>';

    document.body.appendChild(btn); document.body.appendChild(panel);
    bodyEl = panel.querySelector('.nvc-body');
    inputEl = panel.querySelector('.nvc-in');
    sendEl = panel.querySelector('.nvc-send');
    panel.querySelector('.nvc-x').onclick = close;
    sendEl.onclick = send;
    inputEl.addEventListener('keydown', function(e){ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); send(); } });
    inputEl.addEventListener('input', function(){ inputEl.style.height='auto'; inputEl.style.height=Math.min(inputEl.scrollHeight,100)+'px'; });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
