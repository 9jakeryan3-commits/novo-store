# -*- coding: utf-8 -*-
"""The founder story gets its own cover, signed.

Jake, 2026-09-09: "the fix the founder and all the other OG cards we have a signature and new logo
we can use". He named the founder card separately from the rest, and the signature is what makes
it his: "Why I Built NoVo" is the one article on the site written in the first person, and it was
sharing the same generic cover as all 1,287 others.

⚠ IT IS BUILT FROM novo-cover.png, NOT REDRAWN. Same ground, same eyebrow, same lockup, same
tagline - so the two read as one family and the founder card cannot drift away from the house
style when the house style changes. The ONLY addition is the signature, placed in the empty band
between the tagline and the domain line.

The gap was measured, not guessed: content on the cover occupies y116-130 (eyebrow), 189-297
(lockup), 408-434 (tagline) and 565-581 (domain). 434..565 is empty, so the signature is centred
in it at a height that clears the brand kit's floor - "never below 48px tall, and never as an
icon", because below that it stops being letters and becomes texture.
"""
import os
from PIL import Image

PUB = os.path.join(os.path.dirname(__file__), '..', 'public')
COVER = os.path.join(PUB, 'journal', 'covers', 'novo-cover.png')
SIG = os.path.join(PUB, 'brand', 'raster', 'signature-medium-white.png')
OUT = os.path.join(PUB, 'journal', 'covers', 'founder-cover.png')

GAP_TOP, GAP_BOT = 434, 565
SIG_H = 104                      # comfortably over the 48px floor

def main():
    base = Image.open(COVER).convert('RGBA')
    sig = Image.open(SIG).convert('RGBA')
    sig = sig.crop(sig.getbbox())
    assert SIG_H >= 48, 'below the brand kit floor - the signature stops being letters'
    w = round(sig.width * SIG_H / sig.height)
    sig = sig.resize((w, SIG_H), Image.LANCZOS)

    # the signature is Jake's hand, so it sits at the weight of a signature, not a logo
    sig.putalpha(sig.split()[3].point(lambda v: int(v * 0.92)))

    y = GAP_TOP + (GAP_BOT - GAP_TOP - SIG_H) // 2
    assert y > GAP_TOP and y + SIG_H < GAP_BOT, 'signature does not fit the measured gap'
    base.alpha_composite(sig, ((base.width - w) // 2, y))
    base.convert('RGB').save(OUT, optimize=True)
    print('  founder-cover.png  %dx%d  %d KB  (signature %dx%d at y=%d)'
          % (base.width, base.height, os.path.getsize(OUT) // 1024, w, SIG_H, y))

if __name__ == '__main__':
    main()
