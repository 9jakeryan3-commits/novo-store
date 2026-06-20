path_dash = r"C:\Trading Algo\NoVo v.fast\c2_dashboard.py"
path_xb   = r"C:\Trading Algo\NoVo v.fast\skills\x_broadcaster.py"
fixes = []

# ── c2_dashboard.py ───────────────────────────────────────────────────────────
c = open(path_dash, encoding="utf-8").read()

# 1. Add --blue to :root (goes after --sans definition)
old1 = "  --sans:  system-ui,-apple-system,'Segoe UI',sans-serif;"
new1 = "  --sans:  system-ui,-apple-system,'Segoe UI',sans-serif;\n  --blue:  #3b82f6;"
if old1 in c and "--blue" not in c:
    c = c.replace(old1, new1, 1); fixes.append("--blue added")
else:
    fixes.append("--blue: skip (already present or anchor not found)")

# 2. Strengthen intel section label CSS (was barely visible at 0.2 opacity border, --blue undefined)
old2 = ".intel-section-lbl{font-size:8.5px;font-weight:900;letter-spacing:2px;text-transform:uppercase;color:var(--blue);padding-bottom:5px;border-bottom:1px solid rgba(59,130,246,0.2);margin-bottom:7px;font-family:var(--sans);}"
new2 = ".intel-section-lbl{font-size:8px;font-weight:900;letter-spacing:2.5px;text-transform:uppercase;color:var(--blue);display:block;padding:8px 0 6px;border-bottom:2px solid rgba(59,130,246,0.35);margin-top:14px;margin-bottom:8px;font-family:var(--sans);}"
if old2 in c:
    c = c.replace(old2, new2, 1); fixes.append("intel-section-lbl strengthened")
else:
    fixes.append("MISS: intel-section-lbl")

# 3. Fix intel JS title block — date line was silently dropped (titleDone=true blocked else-if)
old3 = """        // Title block (first non-empty lines before any section header)
        let inTitle = true;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const escaped = esc(line);
          if (!line.trim()) {
            if (inTitle) html += '<div style="height:8px;"></div>';
            continue;
          }
          // Section header: line starts with all-caps word(s) followed by colon
          const sectionM = line.match(/^([A-Z][A-Z\\s\\/\\-]+):\\s*(.*)/);
          if (sectionM && sectionM[1].length > 3) {
            inTitle = false;
            const label = esc(sectionM[1].trim());
            const rest = sectionM[2] ? colorize(esc(sectionM[2])) : '';
            html += `<div class="intel-hdr">${label}</div>`;
            if (rest) html += `<div class="intel-body">${rest}</div>`;
          } else if (inTitle) {
            if (i === 0) html += `<div class="intel-hdr-title">${escaped}</div>`;
            else html += `<div class="intel-hdr-sub">${escaped}</div>`;
          } else {
            html += `<div class="intel-body">${colorize(escaped)}</div>`;
          }
        }"""
new3 = """        // Title block — first blank line or section header ends it;
        // i===0 → report title, subsequent lines → subtitle
        while(i<lines.length){
          const l=lines[i].trim();
          if(!l){i++;break;}
          if(/^[A-Z][A-Z\\s\\/\\-]{3,}:/.test(l)) break;
          if(i===0) html+=`<div class="intel-report-title">${esc(lines[i])}</div>`;
          else html+=`<div class="intel-report-sub">${esc(lines[i])}</div>`;
          i++;
        }"""

# Try the new replacement target (from redesign_panels.py output)
old3b = """        const lines=stripEmoji(data.intel_text).split('\\n');
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
        }"""
new3b = """        const lines=stripEmoji(data.intel_text).split('\\n');
        let html='';
        let i=0;
        // Title block — first blank line or section header ends it
        while(i<lines.length){
          const l=lines[i].trim();
          if(!l){i++;break;}
          if(/^[A-Z][A-Z\\s\\/\\-]{3,}:/.test(l)) break;
          if(i===0) html+=`<div class="intel-report-title">${esc(lines[i])}</div>`;
          else html+=`<div class="intel-report-sub">${esc(lines[i])}</div>`;
          i++;
        }"""

if old3 in c:
    c = c.replace(old3, new3, 1); fixes.append("intel title-block fixed (variant A)")
elif old3b in c:
    c = c.replace(old3b, new3b, 1); fixes.append("intel title-block fixed (variant B)")
else:
    fixes.append("MISS: intel title-block")

open(path_dash, "w", encoding="utf-8").write(c)

# ── x_broadcaster.py ─────────────────────────────────────────────────────────
x = open(path_xb, encoding="utf-8").read()

# Remove rpush to c2_log_stream — x_broadcaster is Jake's personal tool,
# its output must never appear in the buyer-facing dashboard terminal.
old_xb = """    async def _log(self, message: str):
        est = pytz.timezone('US/Eastern')
        ts  = datetime.now(est).strftime("[%H:%M:%S]")
        msg = f"{ts} {message}"
        print(msg)
        try:
            await self.redis.rpush("c2_log_stream", msg)
            await self.redis.ltrim("c2_log_stream", -200, -1)
        except Exception:
            pass"""
new_xb = """    async def _log(self, message: str):
        est = pytz.timezone('US/Eastern')
        ts  = datetime.now(est).strftime("[%H:%M:%S]")
        print(f"{ts} {message}")"""

if old_xb in x:
    x = x.replace(old_xb, new_xb, 1); fixes.append("x_broadcaster _log → console only")
else:
    fixes.append("MISS: x_broadcaster _log")

open(path_xb, "w", encoding="utf-8").write(x)

print("fixes:", fixes)
