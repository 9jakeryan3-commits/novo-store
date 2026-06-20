from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

ss  = r"C:\Trading Algo\novo-store\public\screenshots"
src = r"C:\Trading Algo\NoVo v.fast\UI Shots"
fonts_dir = r"C:\Windows\Fonts"

def load_font(size):
    for name in ["consola.ttf", "cour.ttf", "lucon.ttf"]:
        p = os.path.join(fonts_dir, name)
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()

# ── 1. mobile-intel.png: MOMENTUM_BUILDING -> Momentum Building ───────────────
img  = Image.open(os.path.join(ss, "mobile-intel.png")).convert("RGB")
draw = ImageDraw.Draw(img)
w, h = img.size
bg   = (23, 23, 26)
teal = (34, 175, 156)
fnt  = load_font(14)
draw.rectangle([110, 170, w - 5, 196], fill=bg)
txt  = "Momentum Building"
bbox = draw.textbbox((0, 0), txt, font=fnt)
tw   = bbox[2] - bbox[0]
draw.text((w - 6 - tw, 175), txt, fill=teal, font=fnt)
img.save(os.path.join(ss, "mobile-intel.png"))
print("mobile-intel done")

# ── 2. mobile-trade.png: remove amber entry log, keep green exit entry ─────────
# Reload from the original UI Shots source to undo the bad blur
img2  = Image.open(os.path.join(src, "Screenshot 2026-06-18 164927.png")).convert("RGB")
draw2 = ImageDraw.Draw(img2)
w2, h2 = img2.size
# Cover the entire amber entry log box with dark background (y=63 to y=107)
draw2.rectangle([0, 63, w2, 132], fill=(18, 18, 21))
img2.save(os.path.join(ss, "mobile-trade.png"))
print("mobile-trade done")

# ── 3. mobile-journal.png: 185018, stats only, no strategy table ──────────────
img3    = Image.open(os.path.join(src, "Screenshot 2026-06-19 185018.png")).convert("RGB")
w3, h3  = img3.size
cropped = img3.crop((0, 0, w3, 710))
canvas  = Image.new("RGB", (w3, 1080), (18, 18, 21))
canvas.paste(cropped, (0, 0))
canvas.save(os.path.join(ss, "mobile-journal.png"))
print("mobile-journal done")

# ── 4. mobile-analysis.png: 185054, strip terminal, keep Intel Matrix ─────────
img4    = Image.open(os.path.join(src, "Screenshot 2026-06-19 185054.png")).convert("RGB")
w4, h4  = img4.size
canvas4 = Image.new("RGB", (w4, h4), (18, 18, 21))
nav     = img4.crop((0, 0, w4, 90))
canvas4.paste(nav, (0, 0))
intel   = img4.crop((0, 420, w4, h4))
canvas4.paste(intel, (0, 90))
canvas4.save(os.path.join(ss, "mobile-analysis.png"))
print("mobile-analysis done")

print("All done.")
