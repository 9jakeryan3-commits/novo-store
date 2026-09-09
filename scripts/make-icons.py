#!/usr/bin/env python3
"""make-icons.py - the NoVo app icon family, generated from one geometry.

WHY A GENERATOR AND NOT TWELVE EXPORTED PNGs. The three products share one silhouette and differ
only by ground colour, so the icons are the same drawing twelve times. Hand-exporting that is how
one of them ends up a version behind - which is exactly the state this replaces, where Trader had
no icons of its own at all and pointed at Analyst's files.

THE MARK is 01 "The Flip": a solid N with the gamma-flip channel cut through it and the axis
running past on both sides. Drawn on a 120-unit grid, ink on a coloured tile - the tile IS the
brand colour, which is the rule every neighbouring app icon on a phone follows.

    python3 scripts/make-icons.py            # writes into public/
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, "public")
SS = 4                      # supersample, then downsample -> clean antialiased edges

INK = (11, 13, 16, 255)     # #0B0D10
GROUNDS = {                 # read from each dashboard's own --askacc / --green
    "": (0x22, 0xD3, 0xEE, 255),          # analyst  #22D3EE  (default filenames)
    "trader": (0x10, 0xB9, 0x81, 255),    # trader   #10B981
    "crypto": (0xA7, 0x8B, 0xFA, 255),    # crypto   #A78BFA
}

# The N, on a 120 grid. Same path as the SVG - one geometry, two renderers.
N_PATH = [(16,104),(16,16),(34,16),(86,78),(86,16),(104,16),(104,104),(86,104),(34,42),(34,104)]
CHANNEL = (0, 56, 120, 64)          # cut through the letter
STUB_L  = (2, 56, 16, 64)           # axis, running past on both sides
STUB_R  = (104, 56, 118, 64)


def draw_icon(px, ground, scale, radius_pct=0.225, square=False):
    """One icon. `scale` is the mark's share of the tile; `square` skips the rounded corners
    (iOS and .ico apply their own mask, and a pre-rounded source shows a double corner)."""
    S = px * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if square:
        d.rectangle([0, 0, S, S], fill=ground)
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * radius_pct), fill=ground)

    # place the 120-unit mark, centred, at `scale` of the tile
    span = S * scale
    off = (S - span) / 2.0
    f = lambda v: off + (v / 120.0) * span
    pt = lambda p: (f(p[0]), f(p[1]))
    box = lambda b: [f(b[0]), f(b[1]), f(b[2]), f(b[3])]

    d.polygon([pt(p) for p in N_PATH], fill=INK)
    d.rectangle(box(CHANNEL), fill=ground)      # the flip, cut back out
    d.rectangle(box(STUB_L), fill=INK)
    d.rectangle(box(STUB_R), fill=INK)
    return img.resize((px, px), Image.LANCZOS)


def name(base, key, ext="png"):
    return f"{base}.{ext}" if not key else f"{base.replace('icon', 'icon-' + key, 1)}.{ext}"


written = []
for key, ground in GROUNDS.items():
    tag = f"-{key}" if key else ""
    # 'any' icons: the launcher shows these as drawn, so the mark can sit larger
    for px in (192, 512):
        p = os.path.join(OUT, f"icon{tag}-{px}.png")
        draw_icon(px, ground, 0.66).save(p); written.append(p)
    # 'maskable': every launcher crops its own shape, so the mark stays inside the safe zone
    # and the ground runs full-bleed square - a rounded source would be cropped twice.
    p = os.path.join(OUT, f"icon{tag}-maskable-512.png")
    draw_icon(512, ground, 0.56, square=True).save(p); written.append(p)

# apple-touch, one per product: iOS applies its own mask, so these ship SQUARE. Handing iOS an
# already-rounded PNG gives a double corner - the rounded tile visible inside iOS's own rounding.
for key, ground in GROUNDS.items():
    tag = f"-{key}" if key else ""
    p = os.path.join(OUT, f"apple-touch-icon{tag}.png")
    draw_icon(180, ground, 0.66, square=True).save(p); written.append(p)

# favicon: three sizes in one .ico. Rounded, because nothing masks a favicon.
ico = os.path.join(OUT, "favicon.ico")
draw_icon(48, GROUNDS[""], 0.70).save(ico, sizes=[(16, 16), (32, 32), (48, 48)])
written.append(ico)

for w in written:
    print("  wrote", os.path.relpath(w, HERE), os.path.getsize(w), "bytes")
print(f"{len(written)} files")
