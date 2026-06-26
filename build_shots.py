"""Build the website screenshots from the 2026-06-26 UI Shots (v4.3 redesign),
Gaussian-blurring the regions that leak NoVo internals (Apex tuner, entry floors,
risk/allocation matrix, conviction bands, strategy names, exit ladder, apex scores).
Source originals live in NoVo-Pulse/Logos/UI Shots; outputs overwrite public/screenshots/.

Blur boxes re-derived 2026-06-26 against the v4.3 layout — the prior 2026-06-22
coordinates are stale. All shots are 1920x1080 (desktop) / 502x1080 (mobile)."""
from PIL import Image, ImageFilter
import os

SRC = r"C:\Trading Algo\NoVo-Pulse\Logos\UI Shots"
OUT = r"C:\Trading Algo\novo-store\public\screenshots"

def blur_region(img, box, radius):
    region = img.crop(box).filter(ImageFilter.GaussianBlur(radius))
    img.paste(region, box)

# 1. dashboard.png (Screenshot 2026-06-26 104128.png) — desktop 3-col command deck.
#    Keeps SPY hero / Market Intel / NoVo Status / live tape / analysis / equity visible.
d = Image.open(os.path.join(SRC, "Screenshot 2026-06-26 104128.png")).convert("RGB")
# Right column: Apex Signal Tuner (buckets/signals/WR/edge/suggests) + Entry Trigger Floors
# (MIN SCORE thresholds + defaults) — the proprietary scoring/tuning. Keeps title bar above.
blur_region(d, (1510, 680, 1920, 1080), 16)
# Lower-left: the entire RISK & ALLOCATION matrix body — Max Alloc, DTE, Call/Put strike OTM,
# Conviction Sizing multipliers (with apex bands <57/57-77/77+ and RVOL>4.7x), and the
# Hard Stop / TP1 / TP2 % thresholds. Keeps the "RISK & ALLOCATION" title visible.
blur_region(d, (6, 718, 408, 1080), 14)
d.save(os.path.join(OUT, "dashboard.png"))
print("dashboard.png done")

# 2. journal.png (Screenshot 2026-06-26 104448.png) — desktop Performance Journal.
#    Keeps Win Rate / Profit Factor / Net P&L / Max DD / Record (marketing) + By Exit Tier visible.
j = Image.open(os.path.join(SRC, "Screenshot 2026-06-26 104448.png")).convert("RGB")
blur_region(j, (642, 128, 1278, 262), 13)   # By Strategy body (names + W% + P&L + APEX + SLIP)
blur_region(j, (642, 350, 1278, 512), 13)   # By Apex Score body (the proprietary tier bands)
blur_region(j, (938, 790, 1450, 1080), 13)  # trade-log STRAT + EXIT REASON + APEX columns (left edge 938: strategy names start ~943)
j.save(os.path.join(OUT, "journal.png"))
print("journal.png done")

# 3. mobile-analysis.png (Screenshot 2026-06-26 101128.png) — clean (activity + analysis prose).
Image.open(os.path.join(SRC, "Screenshot 2026-06-26 101128.png")).convert("RGB").save(
    os.path.join(OUT, "mobile-analysis.png"))
print("mobile-analysis.png done")

# 4. mobile-trade.png (Screenshot 2026-06-26 104018.png) — clean (wins/equity/active capital/controls).
Image.open(os.path.join(SRC, "Screenshot 2026-06-26 104018.png")).convert("RGB").save(
    os.path.join(OUT, "mobile-trade.png"))
print("mobile-trade.png done")

print("All shots built.")
