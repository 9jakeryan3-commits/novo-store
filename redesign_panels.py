import re

path = r"C:\Trading Algo\NoVo v.fast\c2_dashboard.py"
content = open(path, encoding="utf-8").read()
original_len = len(content)

# ── 1. CSS — add after the log/intel panel block ──────────────────────────────
OLD_CSS = """.log-area {
  flex: 1 1 0; overflow-y: auto; min-height: 0;
  background: #040a14;
  padding: 12px 16px;
  font-size: 11.5px; line-height: 1.7;
}
#intel-output { color: var(--txt2); white-space: pre-wrap; font-family: var(--sans); font-size: 12px; line-height: 1.75; }
#card-intel .log-area { overflow-y: auto; }
#terminal-output {}"""

NEW_CSS = """.log-area {
  flex: 1 1 0; overflow-y: auto; min-height: 0;
  background: #040a14;
  padding: 12px 16px;
  font-size: 11.5px; line-height: 1.7;
}
#intel-output { color: var(--txt2); font-family: var(--sans); font-size: 12px; line-height: 1.75; }
#card-intel .log-area { overflow-y: auto; }
#terminal-output {}

/* ── Trade Log Cards ── */
.tl-card{display:flex;align-items:flex-start;justify-content:space-between;padding:8px 12px;margin-bottom:3px;border-radius:4px;border-left:3px solid transparent;gap:10px;}
.tl-entry{border-left-color:#f59e0b;background:rgba(245,158,11,0.05);}
.tl-exit-win{border-left-color:#10b981;background:rgba(16,185,129,0.04);}
.tl-exit-loss{border-left-color:#ef4444;background:rgba(239,68,68,0.04);}
.tl-alert{border-left-color:#6b7280;background:rgba(107,114,128,0.04);}
.tl-left{flex:1;min-width:0;}
.tl-right{display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0;}
.tl-badge{display:inline-block;font-size:8px;font-weight:900;letter-spacing:1.5px;padding:2px 7px;border-radius:3px;margin-bottom:4px;font-family:var(--sans);}
.tl-badge-entry{background:rgba(245,158,11,0.15);color:#f59e0b;}
.tl-badge-win{background:rgba(16,185,129,0.15);color:#10b981;}
.tl-badge-loss{background:rgba(239,68,68,0.15);color:#ef4444;}
.tl-badge-alert{background:rgba(107,114,128,0.15);color:#9ca3af;}
.tl-contract{font-size:12px;font-weight:700;color:var(--txt1);font-family:var(--font);letter-spacing:0.5px;}
.tl-sub{font-size:10px;color:var(--txt3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;}
.tl-pnl{font-size:16px;font-weight:900;font-family:var(--font);letter-spacing:-0.5px;}
.tl-pnl-win{color:#10b981;}
.tl-pnl-loss{color:#ef4444;}
.tl-time{font-size:9px;color:var(--txt3);font-family:var(--font);}

/* ── Execution Terminal ── */
.term-live-row{display:flex;align-items:center;gap:8px;padding:7px 12px;margin-bottom:6px;background:rgba(16,185,129,0.04);border:1px solid rgba(16,185,129,0.12);border-radius:4px;position:sticky;top:0;z-index:1;}
.term-live-dot{width:6px;height:6px;border-radius:50%;background:#10b981;flex-shrink:0;animation:tld 2s ease-in-out infinite;}
@keyframes tld{0%,100%{opacity:1;}50%{opacity:.2;}}
.term-live-lbl{font-size:8px;font-weight:900;letter-spacing:2px;color:#10b981;font-family:var(--sans);}
.term-live-ticker{font-size:11px;font-weight:700;color:var(--txt1);margin-left:2px;font-family:var(--font);}
.term-live-price{font-size:14px;font-weight:900;color:var(--cyn);font-family:var(--font);}
.term-live-status{font-size:9px;color:var(--txt3);margin-left:auto;font-family:var(--sans);}
.term-sys{padding:3px 0;font-size:10px;color:var(--txt3);border-bottom:1px solid rgba(255,255,255,0.02);line-height:1.5;}
.term-event{padding:4px 0;font-size:10.5px;color:var(--txt2);border-bottom:1px solid rgba(255,255,255,0.03);line-height:1.5;}
.term-warn{padding:4px 0;font-size:10.5px;color:var(--amb);border-bottom:1px solid rgba(255,255,255,0.03);line-height:1.5;}
.term-err{padding:4px 0;font-size:10.5px;color:var(--red);border-bottom:1px solid rgba(255,255,255,0.03);line-height:1.5;}
.term-validator{padding:4px 0;font-size:10.5px;color:var(--cyn);border-bottom:1px solid rgba(255,255,255,0.03);line-height:1.5;}

/* ── Intelligence Matrix Sections ── */
.intel-report-title{font-size:14px;font-weight:900;color:var(--txt1);letter-spacing:-0.5px;margin-bottom:2px;font-family:var(--font);}
.intel-report-sub{font-size:10px;color:var(--txt3);margin-bottom:14px;font-family:var(--sans);}
.intel-section{margin-bottom:12px;}
.intel-section-lbl{font-size:8.5px;font-weight:900;letter-spacing:2px;text-transform:uppercase;color:var(--blue);padding-bottom:5px;border-bottom:1px solid rgba(59,130,246,0.2);margin-bottom:7px;font-family:var(--sans);}
.intel-section-body{font-size:12px;color:var(--txt2);line-height:1.8;}"""

if OLD_CSS in content:
    content = content.replace(OLD_CSS, NEW_CSS)
    print("CSS: replaced")
else:
    print("CSS: NOT FOUND")

# ── 2. appendTradeLog ─────────────────────────────────────────────────────────
OLD_TL = """function appendTradeLog(rawMsg, dedupHistory) {
  const msg = stripEmoji(rawMsg);
  if (dedupHistory) {
    if (tradePrinted.has(msg)) return;
    tradePrinted.add(msg);
    if (tradePrinted.size > 200) { const fv=tradePrinted.values().next().value; tradePrinted.delete(fv); }
  }

  let color = 'var(--txt2)', icon = '▸';
  if (/ENTRY SECURED/i.test(msg)) {
    color = 'var(--amb)'; icon = '▶';
  } else if (/EXIT SWEPT/i.test(msg)) {
    const m = msg.match(/PnL:\\s*([-\\d.]+)%/);
    const pnl = m ? parseFloat(m[1]) : null;
    color = pnl === null ? 'var(--txt2)' : pnl >= 0 ? 'var(--grn)' : 'var(--red)';
    icon = pnl === null ? '■' : pnl >= 0 ? '✓' : '✗';
  } else if (/GHOST FILL/i.test(msg)) {
    color = 'var(--amb)'; icon = '◈';
  } else if (/LIQUIDAT|EMERGENCY HALT/i.test(msg)) {
    color = 'var(--red)'; icon = '!';
  }

  [tradeLogEl, tradeLogMobileEl].forEach(el => {
    if (!el) return;
    const d = document.createElement('div');
    d.style.cssText = `color:${color};padding:5px 0 5px 10px;border-bottom:1px solid var(--bg2);border-left:3px solid ${color};font-size:11px;line-height:1.6;word-break:break-word;margin-bottom:1px;`;
    d.textContent = `${icon} ${msg}`;
    el.appendChild(d);
    el.parentElement.scrollTop = el.parentElement.scrollHeight;
  });

  if (!/EMERGENCY HALT|LIQUIDAT/i.test(msg)) { _tradeCount++; }
  const label = `${_tradeCount} trade${_tradeCount===1?'':'s'}`;
  ['trade-count-badge','trade-count-badge-mobile'].forEach(id=>{
    const b=document.getElementById(id);
    if(b){b.textContent=label;b.style.color='var(--grn)';}
  });
}"""

NEW_TL = """function fmtOCC(occ) {
  const m = occ.match(/^([A-Z]+)\\d{6}([CP])(\\d+)/);
  if (!m) return occ;
  const strike = (parseInt(m[3]) / 1000).toFixed(0);
  return `${m[1]} $${strike}${m[2]}`;
}

function appendTradeLog(rawMsg, dedupHistory) {
  const msg = stripEmoji(rawMsg);
  if (dedupHistory) {
    if (tradePrinted.has(msg)) return;
    tradePrinted.add(msg);
    if (tradePrinted.size > 200) { const fv=tradePrinted.values().next().value; tradePrinted.delete(fv); }
  }

  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const tsM = msg.match(/^\\[(\\d{2}:\\d{2}:\\d{2})\\]/);
  const ts = tsM ? tsM[1] : '';
  const body = tsM ? msg.slice(tsM[0].length).trim() : msg;
  let el = document.createElement('div');

  if (/ENTRY SECURED/i.test(body)) {
    const m = body.match(/ENTRY SECURED:\\s*(\\d+)x\\s+(\\S+)\\s+@\\s+\\$([\\d.]+)/i);
    const qty = m ? m[1] : '?';
    const contract = m ? fmtOCC(m[2]) : body;
    const price = m ? '$'+m[3] : '';
    el.className = 'tl-card tl-entry';
    el.innerHTML = `<div class="tl-left"><div class="tl-badge tl-badge-entry">ENTRY</div><div class="tl-contract">${esc(contract)}</div><div class="tl-sub">${qty} contract${qty>1?'s':''} · ${price}</div></div><div class="tl-right"><div class="tl-time">${ts}</div></div>`;
  } else if (/EXIT SWEPT/i.test(body)) {
    const mC = body.match(/EXIT SWEPT:\\s*(\\S+)\\s+@\\s+\\$([\\d.]+)/i);
    const mPnl = body.match(/PnL:\\s*([-+\\d.]+)%/i);
    const mReason = body.match(/Reason:\\s*(.+)/i);
    const contract = mC ? fmtOCC(mC[1]) : '';
    const exitPrice = mC ? '$'+mC[2] : '';
    const pnl = mPnl ? parseFloat(mPnl[1]) : null;
    const pnlStr = pnl !== null ? `${pnl>=0?'+':''}${pnl.toFixed(1)}%` : '';
    const reason = mReason ? mReason[1].replace(/^[^\\w]*/, '').split(':').slice(-1)[0].trim().replace(/\\.$/, '') : '';
    const isWin = pnl !== null && pnl >= 0;
    el.className = `tl-card ${isWin ? 'tl-exit-win' : 'tl-exit-loss'}`;
    el.innerHTML = `<div class="tl-left"><div class="tl-badge ${isWin?'tl-badge-win':'tl-badge-loss'}">${isWin?'WIN':'LOSS'}</div><div class="tl-contract">${esc(contract)}</div><div class="tl-sub">${exitPrice}${reason?' · '+esc(reason):''}</div></div><div class="tl-right">${pnl!==null?`<div class="tl-pnl ${isWin?'tl-pnl-win':'tl-pnl-loss'}">${pnlStr}</div>`:''}<div class="tl-time">${ts}</div></div>`;
  } else {
    const isHalt = /EMERGENCY HALT|LIQUIDAT/i.test(body);
    el.className = 'tl-card tl-alert';
    el.innerHTML = `<div class="tl-left"><div class="tl-badge tl-badge-alert">${isHalt?'HALT':'EVENT'}</div><div class="tl-sub">${esc(body)}</div></div><div class="tl-right"><div class="tl-time">${ts}</div></div>`;
  }

  [tradeLogEl, tradeLogMobileEl].forEach(container => {
    if (!container) return;
    container.appendChild(el.cloneNode(true));
    container.parentElement.scrollTop = container.parentElement.scrollHeight;
  });

  if (!/EMERGENCY HALT|LIQUIDAT/i.test(msg)) { _tradeCount++; }
  const label = `${_tradeCount} trade${_tradeCount===1?'':'s'}`;
  ['trade-count-badge','trade-count-badge-mobile'].forEach(id=>{
    const b=document.getElementById(id);
    if(b){b.textContent=label;b.style.color='var(--grn)';}
  });
}"""

if OLD_TL in content:
    content = content.replace(OLD_TL, NEW_TL)
    print("appendTradeLog: replaced")
else:
    print("appendTradeLog: NOT FOUND")

# ── 3. logTerminal ────────────────────────────────────────────────────────────
OLD_TERM = """function logTerminal(rawMsg, type) {
  const d = document.createElement('div');
  let c = 'var(--txt1)';
  if (type === 'sys') c = 'var(--txt2)';
  else if (/ENTRY|LONG|SHORT|✅/.test(rawMsg)) c = 'var(--grn)';
  else if (/EXIT|STOP|HARD STOP|🛑|❌/.test(rawMsg)) c = 'var(--red)';
  else if (/CHOP|GATE/.test(rawMsg)) c = 'var(--pur)';
  else if (/⚠/.test(rawMsg)) c = 'var(--amb)';
  else if (/CORTEX|VISION|🧠/.test(rawMsg)) c = 'var(--cyn)';
  d.style.color = c;
  let msg = stripEmoji(rawMsg);
  if (!/\\[/.test(msg)) { const t=new Date().toLocaleTimeString('en-US',{hour12:false}); msg=`[${t}] ${msg}`; }
  d.textContent = msg;
  terminal.appendChild(d);
  terminal.parentElement.scrollTop = terminal.parentElement.scrollHeight;
}"""

NEW_TERM = """function logTerminal(rawMsg, type) {
  // STALKER → update pinned live price row, never append
  if (/\\[STALKER\\]/.test(rawMsg)) {
    let row = document.getElementById('term-live-row');
    if (!row) {
      row = document.createElement('div');
      row.id = 'term-live-row';
      row.className = 'term-live-row';
      terminal.insertBefore(row, terminal.firstChild);
    }
    const mP = rawMsg.match(/@\\s*\\$([\\d.]+)/);
    const price = mP ? '$'+mP[1] : '—';
    row.innerHTML = `<span class="term-live-dot"></span><span class="term-live-lbl">LIVE</span><span class="term-live-ticker">SPY</span><span class="term-live-price">${price}</span><span class="term-live-status">scanning...</span>`;
    return;
  }

  const msg = stripEmoji(rawMsg);
  let displayMsg = msg;
  if (!/\\[/.test(displayMsg)) {
    const t = new Date().toLocaleTimeString('en-US',{hour12:false});
    displayMsg = `[${t}] ${displayMsg}`;
  }

  const d = document.createElement('div');
  if (/\\[SYSTEM\\]|Command listener|Memory init|position.*restored|Signal engine|Night watch|Breadth monitor|Macro state|bias (updated|refreshed)|Volume baseline|Watchdog|Circuit Breaker|Autonomous Exit|NoVo Headless|ARMED|Core v[\\d]/i.test(msg)) {
    d.className = 'term-sys';
  } else if (/VALIDATOR/i.test(msg)) {
    d.className = 'term-validator';
  } else if (/HALT|CRASH|FATAL|BLOCKED|REFUSED/i.test(msg)) {
    d.className = 'term-err';
  } else if (/⚠|WARN|FAILED|TIMEOUT|UNKNOWN|FLIP|FALLBACK/i.test(msg)) {
    d.className = 'term-warn';
  } else {
    d.className = 'term-event';
  }
  d.textContent = displayMsg;
  terminal.appendChild(d);
  terminal.parentElement.scrollTop = terminal.parentElement.scrollHeight;
}"""

if OLD_TERM in content:
    content = content.replace(OLD_TERM, NEW_TERM)
    print("logTerminal: replaced")
else:
    print("logTerminal: NOT FOUND")

# ── 4. Intel display ──────────────────────────────────────────────────────────
OLD_INTEL = """    if(data.intel_text&&intelDisplay){
      if(intelDisplay.dataset.raw!==data.intel_text){
        intelDisplay.dataset.raw=data.intel_text;
        const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        let html=esc(stripEmoji(data.intel_text));
        // Section headers: **text:** → white bold
        html=html.replace(/\\*\\*(.+?)\\*\\*/g,'<strong style="color:var(--txt1);font-weight:700;">$1</strong>');
        // Dollar amounts and percentages → cyan
        html=html.replace(/(\\$[\\d,]+\\.?\\d*|[-+]?\\d+\\.?\\d*%)/g,'<span style="color:var(--cyn);font-weight:600;">$1</span>');
        // Bullish keywords → green
        html=html.replace(/\\b(BULL|BULLISH|LONG|CALLS?|UPSIDE|SUPPORT|BOUNCE|BREAKOUT)\\b/gi,'<span style="color:var(--grn);">$1</span>');
        // Bearish keywords → red
        html=html.replace(/\\b(BEAR|BEARISH|SHORT|PUTS?|DOWNSIDE|RESISTANCE|BREAKDOWN|REJECT)\\b/gi,'<span style="color:var(--red);">$1</span>');
        // Amber for caution words
        html=html.replace(/\\b(CAUTION|WARNING|WATCH|RISK|AVOID|CHOP|CHOPPY)\\b/gi,'<span style="color:var(--amb);">$1</span>');
        intelDisplay.innerHTML=html;
        const _la=intelDisplay.parentElement;
        _la.scrollTop=_la.scrollHeight;
      }
    }"""

NEW_INTEL = """    if(data.intel_text&&intelDisplay){
      if(intelDisplay.dataset.raw!==data.intel_text){
        intelDisplay.dataset.raw=data.intel_text;
        const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        function colorize(t){
          t=t.replace(/\\*\\*(.+?)\\*\\*/g,'<strong style="color:var(--txt1);font-weight:700;">$1</strong>');
          t=t.replace(/(\\$[\\d,]+\\.?\\d*|[-+]?\\d+\\.?\\d*%)/g,'<span style="color:var(--cyn);font-weight:600;">$1</span>');
          t=t.replace(/\\b(BULL|BULLISH|LONG|CALLS?|UPSIDE|SUPPORT|BOUNCE|BREAKOUT)\\b/gi,'<span style="color:var(--grn);">$1</span>');
          t=t.replace(/\\b(BEAR|BEARISH|SHORT|PUTS?|DOWNSIDE|RESISTANCE|BREAKDOWN|REJECT)\\b/gi,'<span style="color:var(--red);">$1</span>');
          t=t.replace(/\\b(CAUTION|WARNING|WATCH|RISK|AVOID|CHOP|CHOPPY)\\b/gi,'<span style="color:var(--amb);">$1</span>');
          return t;
        }
        const lines=stripEmoji(data.intel_text).split('\\n');
        let html='';
        let titleDone=false;
        let i=0;
        // Title block (first non-empty lines before any section header)
        while(i<lines.length){
          const l=lines[i].trim();
          if(!l){i++;if(titleDone)break;continue;}
          if(/^[A-Z][A-Z\\s\\/\\-]{3,}:/.test(l)) break;
          if(!titleDone&&i===0) html+=`<div class="intel-report-title">${esc(l)}</div>`;
          else if(!titleDone) html+=`<div class="intel-report-sub">${esc(l)}</div>`;
          titleDone=true; i++;
        }
        // Sections
        while(i<lines.length){
          const l=lines[i];
          const sm=l.match(/^([A-Z][A-Z\\s\\/\\-]{3,}):\\s*(.*)/);
          if(sm){
            const label=esc(sm[1].trim());
            const rest=sm[2]?colorize(esc(sm[2])):'';
            html+=`<div class="intel-section"><div class="intel-section-lbl">${label}</div><div class="intel-section-body">${rest}`;
            i++;
            // continuation lines until next section or end
            while(i<lines.length&&!/^[A-Z][A-Z\\s\\/\\-]{3,}:/.test(lines[i])&&lines[i].trim()){
              html+=`<br>${colorize(esc(lines[i]))}`;
              i++;
            }
            html+='</div></div>';
          } else {
            if(l.trim()) html+=`<div class="intel-section-body">${colorize(esc(l))}</div>`;
            i++;
          }
        }
        intelDisplay.innerHTML=html;
        const _la=intelDisplay.parentElement;
        _la.scrollTop=_la.scrollHeight;
      }
    }"""

if OLD_INTEL in content:
    content = content.replace(OLD_INTEL, NEW_INTEL)
    print("intel display: replaced")
else:
    print("intel display: NOT FOUND")

open(path, "w", encoding="utf-8").write(content)
print(f"done — {len(content)-original_len:+d} bytes")
