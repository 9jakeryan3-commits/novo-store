path = r"C:\Trading Algo\NoVo v.fast\c2_dashboard.py"
c = open(path, encoding="utf-8").read()
fixes = []

# 1. Title block: strip ** before section-header break check
old1 = "          if(/^[A-Z][A-Z\\s\\/\\-]{3,}:/.test(l)) break;"
new1 = "          if(/^[A-Z][A-Z\\s\\/\\-]{3,}:/.test(l.replace(/\\*\\*/g,''))) break;"
if old1 in c:
    c = c.replace(old1, new1, 1); fixes.append("title-break")
else:
    fixes.append("MISS:title-break")

# 2. Sections loop: strip ** from line before section match + continuation check
old2 = (
    "          const sm=l.match(/^([A-Z][A-Z\\s\\/\\-]{3,}):\\s*(.*)/);\n"
    "          if(sm){\n"
    "            const label=esc(sm[1].trim());\n"
    "            const rest=sm[2]?colorize(esc(sm[2])):'';\n"
    "            html+=`<div class=\"intel-section\"><div class=\"intel-section-lbl\">${label}</div><div class=\"intel-section-body\">${rest}`;\n"
    "            i++;\n"
    "            // continuation lines until next section or end\n"
    "            while(i<lines.length&&!/^[A-Z][A-Z\\s\\/\\-]{3,}:/.test(lines[i])&&lines[i].trim()){\n"
    "              html+=`<br>${colorize(esc(lines[i]))}`;\n"
    "              i++;\n"
    "            }"
)
new2 = (
    "          const plain=l.replace(/\\*\\*/g,'');\n"
    "          const sm=plain.match(/^([A-Z][A-Z\\s\\/\\-]{3,}):\\s*(.*)/);\n"
    "          if(sm){\n"
    "            const label=esc(sm[1].trim());\n"
    "            const rest=sm[2]?colorize(esc(sm[2])):'';\n"
    "            html+=`<div class=\"intel-section\"><div class=\"intel-section-lbl\">${label}</div><div class=\"intel-section-body\">${rest}`;\n"
    "            i++;\n"
    "            // continuation lines until next section or end\n"
    "            while(i<lines.length&&!/^[A-Z][A-Z\\s\\/\\-]{3,}:/.test(lines[i].replace(/\\*\\*/g,''))&&lines[i].trim()){\n"
    "              html+=`<br>${colorize(esc(lines[i]))}`;\n"
    "              i++;\n"
    "            }"
)
if old2 in c:
    c = c.replace(old2, new2, 1); fixes.append("sections-bold")
else:
    fixes.append("MISS:sections-bold")

# 3. Initialize LIVE row on ws.onopen so it's always visible
old3 = (
    "  ws.onopen=()=>{\n"
    "    logTerminal('\\u{1F7E2} Connected to Apex Core Telemetry Engine.','sys');"
)
new3 = (
    "  ws.onopen=()=>{\n"
    "    logTerminal('\\u{1F7E2} Connected to Apex Core Telemetry Engine.','sys');\n"
    "    (function(){\n"
    "      let row=document.getElementById('term-live-row');\n"
    "      if(!row){row=document.createElement('div');row.id='term-live-row';row.className='term-live-row';if(terminal)terminal.insertBefore(row,terminal.firstChild);}\n"
    "      row.innerHTML='<span class=\"term-live-dot\" style=\"background:var(--amb);\"></span><span class=\"term-live-lbl\">ARMED</span><span class=\"term-live-ticker\">SPY</span><span class=\"term-live-price\" style=\"color:var(--txt3);\">\\u2014</span><span class=\"term-live-status\">awaiting market session</span>';\n"
    "    })();"
)
if old3 in c:
    c = c.replace(old3, new3, 1); fixes.append("live-row-init")
else:
    fixes.append("MISS:live-row-init")

open(path, "w", encoding="utf-8").write(c)
print("fixes:", fixes)
