path = r"C:\Trading Algo\NoVo v.fast\c2_dashboard.py"
c = open(path, encoding="utf-8").read()
fixes = []

# ── 1. CSS: much more visible row with armed/live state classes ───────────────
old_css = (
    ".term-live-row{display:flex;align-items:center;gap:8px;padding:7px 12px;margin-bottom:6px;background:rgba(16,185,129,0.04);border:1px solid rgba(16,185,129,0.12);border-radius:4px;position:sticky;top:0;z-index:1;}\n"
    ".term-live-dot{width:6px;height:6px;border-radius:50%;background:#10b981;flex-shrink:0;animation:tld 2s ease-in-out infinite;}\n"
    "@keyframes tld{0%,100%{opacity:1;}50%{opacity:.2;}}\n"
    ".term-live-lbl{font-size:8px;font-weight:900;letter-spacing:2px;color:#10b981;font-family:var(--sans);}\n"
    ".term-live-ticker{font-size:11px;font-weight:700;color:var(--txt1);margin-left:2px;font-family:var(--font);}\n"
    ".term-live-price{font-size:14px;font-weight:900;color:var(--cyn);font-family:var(--font);}\n"
    ".term-live-status{font-size:9px;color:var(--txt3);margin-left:auto;font-family:var(--sans);}"
)
new_css = (
    ".term-live-row{display:flex;align-items:center;gap:10px;padding:10px 14px;margin-bottom:8px;border-radius:5px;position:sticky;top:0;z-index:2;font-family:var(--sans);}\n"
    ".term-live-row.armed{background:rgba(245,158,11,0.10);border:1px solid rgba(245,158,11,0.45);box-shadow:0 0 20px rgba(245,158,11,0.08);}\n"
    ".term-live-row.live{background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.45);box-shadow:0 0 20px rgba(16,185,129,0.08);}\n"
    ".term-live-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;animation:tld 1.6s ease-in-out infinite;}\n"
    "@keyframes tld{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.2;transform:scale(0.65);}}\n"
    ".term-live-lbl{font-size:9px;font-weight:900;letter-spacing:2.5px;font-family:var(--sans);}\n"
    ".term-live-ticker{font-size:12px;font-weight:700;color:var(--txt1);font-family:var(--font);letter-spacing:1px;}\n"
    ".term-live-price{font-size:16px;font-weight:900;font-family:var(--font);letter-spacing:-0.5px;}\n"
    ".term-live-status{font-size:9px;color:var(--txt3);margin-left:auto;letter-spacing:0.5px;}"
)
if old_css in c:
    c = c.replace(old_css, new_css, 1); fixes.append("css")
else:
    fixes.append("MISS:css")

# ── 2. Stalker handler: switch to live class with explicit green ──────────────
old_stalker = (
    "    row.className = 'term-live-row';\n"
    "    row.innerHTML = `<span class=\"term-live-dot\"></span>"
    "<span class=\"term-live-lbl\">LIVE</span>"
    "<span class=\"term-live-ticker\">SPY</span>"
    "<span class=\"term-live-price\">${price}</span>"
    "<span class=\"term-live-status\">scanning...</span>`;"
)
new_stalker = (
    "    row.className = 'term-live-row live';\n"
    "    row.innerHTML = `<span class=\"term-live-dot\" style=\"background:#10b981;\"></span>"
    "<span class=\"term-live-lbl\" style=\"color:#10b981;\">LIVE</span>"
    "<span class=\"term-live-ticker\">SPY</span>"
    "<span class=\"term-live-price\" style=\"color:var(--cyn);\">${price}</span>"
    "<span class=\"term-live-status\">scanning...</span>`;"
)
if old_stalker in c:
    c = c.replace(old_stalker, new_stalker, 1); fixes.append("stalker")
else:
    fixes.append("MISS:stalker")

# ── 3. onopen ARMED init: use armed class with amber ─────────────────────────
old_armed = (
    "      row.innerHTML='<span class=\"term-live-dot\" style=\"background:var(--amb);\"></span>"
    "<span class=\"term-live-lbl\">ARMED</span>"
    "<span class=\"term-live-ticker\">SPY</span>"
    "<span class=\"term-live-price\" style=\"color:var(--txt3);\">—</span>"
    "<span class=\"term-live-status\">awaiting market session</span>';"
)
new_armed = (
    "      row.className='term-live-row armed';\n"
    "      row.innerHTML='<span class=\"term-live-dot\" style=\"background:#f59e0b;\"></span>"
    "<span class=\"term-live-lbl\" style=\"color:#f59e0b;\">ARMED</span>"
    "<span class=\"term-live-ticker\">SPY</span>"
    "<span class=\"term-live-price\" style=\"color:var(--txt3);\">—</span>"
    "<span class=\"term-live-status\">awaiting market open</span>';"
)
if old_armed in c:
    c = c.replace(old_armed, new_armed, 1); fixes.append("armed")
else:
    fixes.append("MISS:armed")

open(path, "w", encoding="utf-8").write(c)
print("fixes:", fixes)
