# -*- coding: utf-8 -*-
"""Rebuild public/novo-logo.png: Jake's new brush mark + the EXISTING wordmark.

Jake, 2026-09-09: "we have a signature and new logo we can use with the newer coin on atleast
crypto og cards". The OG cards and the journal cover all composite novo-logo.png, which still
carried the old gold LLC coin -- so every share preview on the estate was a generation behind.

⚠ THE WORDMARK IS LIFTED, NOT SET. make-og-cards.py's own header says re-typing it "would quietly
produce a second, wrong mark", and it is right: the site sets the wordmark in Space Grotesk Medium,
which is NOT on this box -- PIL would silently fall back to Segoe UI and produce a lockup that is
subtly wrong everywhere it appears. So the wordmark pixels are cropped from the existing file and
reused untouched. Only the coin is replaced. That way this script cannot invent typography.

The split was measured, not guessed: the alpha profile of novo-logo.png has exactly one interior
gap, columns 296-337, with the coin left of it and "NoVo / OPTIONS TRADING" right of it.

Colourways: cyan is the company default, violet is Crypto. Per the brand README, on a dark ground
the MARK is the only coloured thing in a lockup -- the wordmark stays paper white, which is what
the lifted pixels already are.
"""
import os
from PIL import Image

PUB = os.path.join(os.path.dirname(__file__), '..', 'public')
RAS = os.path.join(PUB, 'brand', 'raster')
# ⚠ READ THE LEGACY FILE, NEVER novo-logo.png. The first version used novo-logo.png as both the
# source of the wordmark and the destination: the cyan build overwrote it, then the crypto and
# trader builds cropped column 337 of the file that had just been rewritten, whose layout is
# different. It produced three lockups at two different sizes and no error. The source of the
# wordmark has to be a file this script never writes.
SRC = os.path.join(PUB, 'novo-logo-legacy-coin.png')

GAP_L, GAP_R = 296, 337          # measured alpha gap in the source lockup

def build(mark_png, out_name):
    src = Image.open(SRC).convert('RGBA')
    wordmark = src.crop((GAP_R, 0, src.width, src.height))
    wb = wordmark.getbbox()
    assert wb, 'wordmark crop is empty - the gap measurement is stale'
    wordmark = wordmark.crop(wb)

    mark = Image.open(os.path.join(RAS, mark_png)).convert('RGBA')
    mark = mark.crop(mark.getbbox())

    # Match the mark's height to the wordmark's full height, then a little larger: the brush N is
    # an open letterform and reads lighter than a solid coin at the same measure.
    target_h = int(wordmark.height * 1.32)
    mark = mark.resize((round(mark.width * target_h / mark.height), target_h), Image.LANCZOS)

    # Clear space per the brand README is the crossbar height; the crossbar is ~1/7 of the mark.
    gap = round(mark.height * 0.20)
    pad = round(mark.height * 0.10)
    w = pad + mark.width + gap + wordmark.width + pad
    h = pad + max(mark.height, wordmark.height) + pad
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    im.paste(mark, (pad, (h - mark.height) // 2), mark)
    im.paste(wordmark, (pad + mark.width + gap, (h - wordmark.height) // 2), wordmark)

    out = os.path.join(PUB, out_name)
    im.save(out, optimize=True)
    print('  %-26s %dx%d  %d KB' % (out_name, im.width, im.height, os.path.getsize(out) // 1024))
    return im


if __name__ == '__main__':
    assert os.path.exists(SRC), (
        'novo-logo-legacy-coin.png is missing - it holds the only clean copy of the wordmark, '
        'and this script cannot re-set the type')
    outs = [build('mark-cyan.png',   'novo-logo.png'),
            build('mark-violet.png', 'novo-logo-crypto.png'),
            build('mark-green.png',  'novo-logo-trader.png')]
    # All three share one wordmark and one mark geometry, so they MUST come out identical in size.
    # Unequal sizes is the signature of the read-your-own-output bug guarded against above.
    sizes = set(im.size for im in outs)
    assert len(sizes) == 1, "lockups differ in size %s - a build read another build's output" % sizes
    print("")
    print('  all three lockups %dx%d, from the same untouched wordmark' % outs[0].size)
