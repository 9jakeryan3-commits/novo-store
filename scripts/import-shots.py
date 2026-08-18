#!/usr/bin/env python3
"""Install product screenshots from the OneDrive drop folder into the site.

Jake shoots the dashboard and the phone app, drops the files in OneDrive under
the names in that folder's README, and runs this. It resizes, strips metadata,
optimises, writes them to public/screenshots/ under the names the pages already
reference, and prints the width/height each <img> should carry.

Nothing here edits markup: the filenames are fixed, so a re-shoot is a re-run.
"""
import sys, os
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required:  python -m pip install Pillow")

DROP = Path(os.path.expanduser("~")) / "OneDrive" / "NoVo-Screenshots"
OUT = Path(__file__).resolve().parent.parent / "public" / "screenshots"

# source stem -> (installed filename, max width, what it is)
# Max widths are ~2x the display size so the shots stay sharp on retina without
# shipping a 2MB phone capture.
JOBS = [
    ("analyst-1", "analyst-dash-1.webp", 1600, "Analyst - chart, levels, fear gauge, gamma profile"),
    ("analyst-2", "analyst-dash-2.webp", 1600, "Analyst - dealer positioning tiles"),
    ("analyst-3", "analyst-dash-3.webp", 1600, "Analyst - flow, analogues, cross-asset, The Line"),
    ("analyst-4", "analyst-dash-4.webp", 1600, "Analyst - today's read + notifications"),
    ("trader-1",  "trader-trade.webp",   940,  "Trader - TRADE tab"),
    ("trader-2",  "trader-risk.webp",    940,  "Trader - RISK tab"),
    ("trader-3",  "trader-journal.webp", 940,  "Trader - JOURNAL tab"),
    ("trader-4",  "trader-analysis.webp", 940, "Trader - ANALYSIS tab"),
]

def find(stem):
    for ext in (".png", ".PNG", ".jpg", ".jpeg", ".JPG", ".JPEG"):
        p = DROP / (stem + ext)
        if p.exists():
            return p
    return None

def main():
    if not DROP.exists():
        sys.exit(f"drop folder not found: {DROP}")
    OUT.mkdir(parents=True, exist_ok=True)

    done, missing = [], []
    for stem, target, maxw, label in JOBS:
        src = find(stem)
        if not src:
            missing.append((stem, label))
            continue
        im = Image.open(src)
        im = im.convert("RGB") if im.mode in ("P", "RGBA", "LA") else im
        if im.width > maxw:
            im = im.resize((maxw, round(im.height * maxw / im.width)), Image.LANCZOS)
        dst = OUT / target
        before = src.stat().st_size
        # No EXIF is carried over: a phone capture can hold a location tag, and
        # these go on public pages.
        # WebP, not PNG: a 1600px screenshot of a dark dashboard saves as ~90K here
        # against ~830K as PNG, which is larger than the phone's own JPEG original.
        im.save(dst, "WEBP", quality=80, method=6)
        done.append((target, im.width, im.height, before, dst.stat().st_size))

    if done:
        print(f"installed {len(done)} into public/screenshots/\n")
        print(f"{'file':<22}{'dimensions':<14}{'size':>10}   (use these in width=/height=)")
        for t, w, h, b, a in done:
            print(f"{t:<22}{f'{w} x {h}':<14}{a/1024:>9.0f}K   was {b/1024:.0f}K")
    if missing:
        print(f"\nnot found in {DROP}:")
        for stem, label in missing:
            print(f"  {stem}.png   {label}")
    if done:
        print("\nnext:  bash scripts/deploy.sh")
    return 0 if done else 1

if __name__ == "__main__":
    sys.exit(main())
