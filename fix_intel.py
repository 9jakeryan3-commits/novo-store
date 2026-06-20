path = r"C:\Trading Algo\NoVo v.fast\c2_dashboard.py"
c = open(path, encoding="utf-8").read()

# Replace the entire intel parsing block — from 'const lines=...' through the closing '}'
OLD = (
    "        const lines=stripEmoji(data.intel_text).split('\\n');\n"
    "        let html='';\n"
    "        let i=0;\n"
    "        // Title block — first blank line or section header ends it\n"
    "        while(i<lines.length){\n"
    "          const l=lines[i].trim();\n"
    "          if(!l){i++;break;}\n"
    "          if(/^[A-Z][A-Z\\s\\/\\-]{3,}:/.test(l.replace(/\\*\\*/g,''))) break;\n"
    "          if(i===0) html+=`<div class=\"intel-report-title\">${esc(lines[i])}</div>`;\n"
    "          else html+=`<div class=\"intel-report-sub\">${esc(lines[i])}</div>`;\n"
    "          i++;\n"
    "        }\n"
    "        // Sections\n"
    "        while(i<lines.length){\n"
    "          const l=lines[i];\n"
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
    "            }\n"
    "            html+='</div></div>';\n"
    "          } else {\n"
    "            if(l.trim()) html+=`<div class=\"intel-section-body\">${colorize(esc(l))}</div>`;\n"
    "            i++;\n"
    "          }\n"
    "        }"
)

NEW = (
    "        const lines=stripEmoji(data.intel_text).split('\\n');\n"
    "        let html='';\n"
    "        let i=0;\n"
    "        // Section header: line (stripped of **) has ALL-CAPS label before first colon\n"
    "        function isSHdr(line){\n"
    "          const s=line.replace(/\\*\\*/g,'').trim();\n"
    "          const ci=s.indexOf(':');\n"
    "          if(ci<3||ci>30) return false;\n"
    "          const lbl=s.slice(0,ci);\n"
    "          return /^[A-Z]/.test(lbl)&&lbl===lbl.toUpperCase();\n"
    "        }\n"
    "        function parseSHdr(line){\n"
    "          const s=line.replace(/\\*\\*/g,'').trim();\n"
    "          const ci=s.indexOf(':');\n"
    "          return {label:s.slice(0,ci).trim(), body:s.slice(ci+1).trim()};\n"
    "        }\n"
    "        // Title block\n"
    "        while(i<lines.length){\n"
    "          const l=lines[i];\n"
    "          if(!l.trim()){i++;break;}\n"
    "          if(isSHdr(l)) break;\n"
    "          if(i===0) html+=`<div class=\"intel-report-title\">${esc(l.trim())}</div>`;\n"
    "          else html+=`<div class=\"intel-report-sub\">${esc(l.trim())}</div>`;\n"
    "          i++;\n"
    "        }\n"
    "        // Section blocks\n"
    "        while(i<lines.length){\n"
    "          const l=lines[i];\n"
    "          if(!l.trim()){i++;continue;}\n"
    "          if(isSHdr(l)){\n"
    "            const {label,body}=parseSHdr(l);\n"
    "            let bHtml=body?colorize(esc(body)):'';\n"
    "            i++;\n"
    "            while(i<lines.length&&lines[i].trim()&&!isSHdr(lines[i])){\n"
    "              bHtml+='<br>'+colorize(esc(lines[i]));\n"
    "              i++;\n"
    "            }\n"
    "            html+=`<div class=\"intel-section\"><div class=\"intel-section-lbl\">${esc(label)}</div><div class=\"intel-section-body\">${bHtml}</div></div>`;\n"
    "          } else {\n"
    "            html+=`<div class=\"intel-section-body\">${colorize(esc(l))}</div>`;\n"
    "            i++;\n"
    "          }\n"
    "        }"
)

if OLD in c:
    c = c.replace(OLD, NEW, 1)
    open(path, "w", encoding="utf-8").write(c)
    print("done: intel parsing rewritten")
else:
    print("NOT FOUND — printing first 200 chars of section for comparison:")
    idx = c.find("const lines=stripEmoji(data.intel_text)")
    if idx >= 0:
        print(repr(c[idx:idx+400]))
    else:
        print("anchor not found at all")
