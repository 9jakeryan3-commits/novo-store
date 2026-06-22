"""Build the website screenshots from the 2026-06-22 UI Shots, Gaussian-blurring the
regions that leak NoVo internals (Apex tuner, entry floors, strategy names, exit ladder).
Source originals live in NoVo v.fast/UI Shots; outputs overwrite public/screenshots/."""
from PIL import Image, ImageFilter
import os

SRC = r"C:\Trading Algo\NoVo v.fast\UI Shots"
OUT = r"C:\Trading Algo\novo-store\public\screenshots"

def blur_region(img, box, radius):
    region = img.crop(box).filter(ImageFilter.GaussianBlur(radius))
    img.paste(region, box)

# 1. dashboard.png — blur Apex Signal Tuner + Entry Trigger Floors (right column, lower).
#    Keeps Market Intel / Live Signal / NoVo Status visible above.
d = Image.open(os.path.join(SRC, "Screenshot 2026-06-22 180648.png")).convert("RGB")
blur_region(d, (1522, 672, 1920, 1080), 16)
# Also blur Conviction Sizing (left panel) — its field labels re-expose the apex bands
# (55/75) and the size-multiplier ladder. Keeps the "CONVICTION SIZING" title visible.
blur_region(d, (6, 933, 390, 1051), 13)
d.save(os.path.join(OUT, "dashboard.png"))
print("dashboard.png done")

# 2. journal.png — blur the By-Strategy panel (strategy names + per-strategy edge) and the
#    STRAT + EXIT REASON columns of the trade log (exit ladder / thresholds).
j = Image.open(os.path.join(SRC, "Screenshot 2026-06-22 120030.png")).convert("RGB")
blur_region(j, (645, 90, 1278, 242), 14)     # By Strategy panel (full width: names..P&L/APEX/SLIP)
blur_region(j, (918, 758, 1362, 1080), 13)   # STRAT + EXIT REASON columns
j.save(os.path.join(OUT, "journal.png"))
print("journal.png done")

# 3. mobile-analysis.png — clean (shows the new 'studying...' idle badge); use as-is.
Image.open(os.path.join(SRC, "Screenshot 2026-06-22 175746.png")).convert("RGB").save(
    os.path.join(OUT, "mobile-analysis.png"))
print("mobile-analysis.png done")

# 4. mobile-trade.png — clean (wins + new TP/TS dot toggles); use as-is.
Image.open(os.path.join(SRC, "Screenshot 2026-06-22 115658.png")).convert("RGB").save(
    os.path.join(OUT, "mobile-trade.png"))
print("mobile-trade.png done")

print("All shots built.")
