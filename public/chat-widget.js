/* NoVo "Message us" support widget. Self-contained, no deps. Include once per page:
   <script defer src="/chat-widget.js"></script>
   Talks to /api/chat (Gemini-backed, guardrailed). Product/how-to support only; account/money -> email. */
(function () {
  if (window.__novoChat) return; window.__novoChat = true;

  var SUPPORT = 'support@novo-aitrading.app';
  var messages = [];      // {role:'user'|'assistant', content}
  var busy = false, opened = false;

  var css = ''
    + '.nvc-btn{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:56px;height:56px;border-radius:50%;'
    + 'border:1px solid #2e3036;background:linear-gradient(180deg,#22d3ee,#3b82f6);color:#04121a;cursor:pointer;'
    + 'box-shadow:0 6px 20px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;font-size:24px}'
    + '.nvc-btn:hover{filter:brightness(1.06)}'
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

  function open(){
    opened = true; panel.classList.add('open'); btn.textContent = '×';
    if (!messages.length) addMsg('assistant',
      "Hi — I'm NoVo's assistant. Ask me anything about how NoVo works: brokers, paper vs live, pricing, billing, or what a term means. For anything account-specific or money-related, I'll point you to " + SUPPORT + ".");
    setTimeout(function(){ inputEl.focus(); }, 50);
  }
  function close(){ opened = false; panel.classList.remove('open'); btn.textContent = '💬'; }

  async function send(){
    var text = inputEl.value.trim();
    if (!text || busy) return;
    inputEl.value=''; inputEl.style.height='auto';
    messages.push({role:'user', content:text}); addMsg('user', text);
    busy = true; sendEl.disabled = true;
    var typing = document.createElement('div'); typing.className='nvc-typing'; typing.textContent='NoVo is typing…';
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

    btn = document.createElement('button'); btn.className='nvc-btn'; btn.setAttribute('aria-label','Message NoVo support'); btn.textContent='💬';
    btn.onclick = function(){ opened ? close() : open(); };

    panel = document.createElement('div'); panel.className='nvc-panel'; panel.setAttribute('role','dialog'); panel.setAttribute('aria-label','NoVo support chat');
    panel.innerHTML =
      '<div class="nvc-hd"><b>Message NoVo</b><span class="nvc-sub">product &amp; how-to help</span>'
      + '<button class="nvc-x" aria-label="Close">×</button></div>'
      + '<div class="nvc-body"></div>'
      + '<div class="nvc-foot"><div class="nvc-row">'
      + '<textarea class="nvc-in" rows="1" placeholder="Ask about NoVo…"></textarea>'
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
