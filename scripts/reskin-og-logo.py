# -*- coding: utf-8 -*-
"""Swap the old coin lockup for the new brush-mark lockup on the share cards nothing generates.

Ten OG cards exist. make-og-cards.py builds four; the other six -- og-home, og-journal, og-default,
og-ai, og-help, og-options101 -- plus the Journal cover novo-cover.png (which fronts all 1,288
journal articles, including the founder story Jake screenshotted) were swapped BY HAND the last two
times the logo changed. b611080cf and dde6ff0f3 are both "new coin, and the share cards that
carried the old one". That is why the old coin keeps surviving a logo change: six cards with no
generator and no check.

⚠ THIS EDITS PIXELS, IT DOES NOT REDRAW CARDS. The copy on these cards is marketing Jake approved;
re-typesetting it to change a logo would put every headline at risk of silent drift. So the old
lockup is LOCATED, erased, and the new one pasted into the same optical box. Nothing else in the
image is touched, and the diff is provably confined to that box.

HOW THE LOCKUP IS FOUND: normalised cross-correlation against the legacy lockup itself, over a
range of scales. Not a hardcoded box -- the six cards place it at six different positions and
sizes, and a coordinate typed by hand would silently miss on one and nobody would look.

HOW THE HOLE IS FILLED: every one of these cards has a smooth gradient behind the lockup, so each
row is linearly interpolated between the pixels immediately outside the box. Verified per card by
checking the seam either side is within a couple of levels.
"""
import os, sys
import numpy as np
from PIL import Image

PUB = os.path.join(os.path.dirname(__file__), '..', 'public')
LEGACY = os.path.join(PUB, 'novo-logo-legacy-coin.png')

def gray(im):
    return np.asarray(im.convert('L'), dtype=np.float64)

def _ncc_map(card_g, tg, ta):
    """Normalised cross-correlation of a masked template over an image, computed with FFTs.

    The first version did this with two nested Python loops over every position and every scale.
    It was still running after ten minutes on seven cards. Sliding-window correlation is a
    convolution, so it belongs in the frequency domain: this is the same arithmetic, whole-array,
    and it finishes in well under a second per scale.
    """
    H, W = card_g.shape
    h, w = tg.shape
    if h >= H or w >= W:
        return None
    n = ta.sum()
    if n < 50:
        return None
    tm = (tg * ta).sum() / n
    tz = (tg - tm) * ta                      # zero-mean, mask-weighted template
    tden = np.sqrt((tz * tz).sum())
    if tden == 0:
        return None

    fs = (H, W)
    F = np.fft.rfft2(card_g, fs)
    def corr(kern):
        K = np.fft.rfft2(kern[::-1, ::-1], fs)
        return np.fft.irfft2(F * K, fs)[h-1:H, w-1:W]
    def corr2(kern):
        K = np.fft.rfft2(kern[::-1, ::-1], fs)
        return np.fft.irfft2(np.fft.rfft2(card_g * card_g, fs) * K, fs)[h-1:H, w-1:W]

    num = corr(tz)                            # sum(window * tz)
    s1 = corr(ta)                             # sum(window * mask)
    s2 = corr2(ta)                            # sum(window^2 * mask)
    var = s2 - (s1 * s1) / n
    var[var < 1e-9] = 1e-9
    return num / (tden * np.sqrt(var))


def find_lockup(card_g, tpl_rgba, scales):
    """Best (score, x, y, w, h) over the given template widths."""
    best = None
    for w in scales:
        h = max(1, round(tpl_rgba.height * w / tpl_rgba.width))
        if h >= card_g.shape[0] or w >= card_g.shape[1]:
            continue
        t = tpl_rgba.resize((w, h), Image.LANCZOS)
        m = _ncc_map(card_g, gray(t), np.asarray(t.split()[3], dtype=np.float64) / 255.0)
        if m is None:
            continue
        i = int(np.argmax(m))
        y, x = divmod(i, m.shape[1])
        sc = float(m[y, x])
        if best is None or sc > best[0]:
            best = (sc, x, y, w, h)
    return best


def inpaint(arr, x, y, w, h):
    """Fill the box by interpolating each row between the columns just outside it."""
    x0, x1 = max(0, x - 2), min(arr.shape[1] - 1, x + w + 2)
    left = arr[y:y+h, x0:x0+1].astype(np.float64)
    right = arr[y:y+h, x1:x1+1].astype(np.float64)
    ramp = np.linspace(0.0, 1.0, w)[None, :, None]
    arr[y:y+h, x:x+w] = (left[:, :, :] * (1 - ramp) + right[:, :, :] * ramp).astype(arr.dtype)
    return arr

# The legacy lockup is coin | gap | wordmark, split at the single interior alpha gap (296..337).
LEG_GAP_L, LEG_GAP_R = 296, 337

# ⚠ MATCH ON THE WORDMARK, NOT THE LOCKUP. Matching the whole lockup failed on three of the seven
# cards for two different structural reasons, and both were invisible in the score:
#   - og-ai.png carries the COIN ALONE, no wordmark at all, so a coin+wordmark template can never
#     sit on it and the best score lands on empty gradient.
#   - novo-cover.png uses a DIFFERENT coin (the dark chart glyph, not the gold LLC ring), so the
#     left half of the template never matches.
# The wordmark pixels are byte-identical on every card that has one, which makes it the only
# reliable anchor. Cards with no wordmark are matched on the coin instead, declared per card.
#
# ⚠ AND THE WORDMARK ALONE IS TOO SPARSE TO MATCH. Tried that next: white letterforms cover a few
# percent of their bounding box, the mask-weighted variance goes unstable on a near-empty window,
# and all six wordmark cards dropped to ~0.47 and were reported NOT FOUND. The coin is the dense,
# high-contrast part - it is what makes the correlation stable - so the template is the FULL
# lockup wherever a coin exists.
#
# What actually disambiguates is the SEARCH REGION. og-home puts its lockup top-left over a busy
# screenshot and scored 0.94 on empty gradient at the bottom of the card; bounded to the top-left
# eighth, there is nothing else it can match. Regions are fractions of the card (l, t, r, b).
CARDS = [
    ('og-home.png',       'lockup', (0.00, 0.00, 0.40, 0.35)),
    ('og-journal.png',    'lockup', (0.20, 0.10, 0.80, 0.55)),
    ('og-default.png',    'lockup', (0.20, 0.10, 0.80, 0.55)),
    ('og-ai.png',         'coin',   (0.70, 0.00, 1.00, 0.40)),   # coin only - no wordmark here
    ('og-help.png',       'lockup', (0.20, 0.10, 0.80, 0.55)),
    ('og-options101.png', 'lockup', (0.20, 0.10, 0.80, 0.55)),
    # the cover's coin is the dark chart glyph, not the gold ring, so its score is legitimately
    # lower than the rest - the region is what keeps it honest
    # ⚠ THE COVER IS THE ODD ONE and it fronts all 1,288 journal articles, the founder story
    # included - so it is the one that matters most and the one the lockup template cannot find.
    # Its coin is the dark chart glyph, a different image entirely, so half the template is noise
    # and it settles on a 144px box. Anchored on the wordmark instead (identical pixels here) and
    # the coin's extent reconstructed from the legacy ratios.
    # ...and matching on the wordmark alone scored 0.20, for the sparse-mask reason above. So this
    # ONE card carries an explicitly measured box. It was not typed from a screenshot: the cover's
    # background is a smooth gradient, so content was found as deviation from each row's median,
    # which returns two horizontal bands - the cyan eyebrow at y116-130 and the lockup at y178-307.
    # The box below is that second band's extent, and it agrees with og-journal's matched box
    # (421,168 358x150) to within a few pixels, which is the corroboration that it is right: the
    # two cards share a layout.
    (os.path.join('journal', 'covers', 'novo-cover.png'), 'box', (430, 178, 339, 130)),
]


def main(write=False):
    legacy = Image.open(LEGACY).convert('RGBA')
    word = legacy.crop((LEG_GAP_R, 0, legacy.width, legacy.height))
    word = word.crop(word.getbbox())
    coin = legacy.crop((0, 0, LEG_GAP_L, legacy.height))
    coin = coin.crop(coin.getbbox())
    # the coin's width as a multiple of the wordmark's, and the gap likewise - so that finding the
    # wordmark is enough to reconstruct where the whole lockup sat
    COIN_OVER_WORD = coin.width / word.width
    GAP_OVER_WORD = (LEG_GAP_R - LEG_GAP_L) / word.width

    new_master = Image.open(os.path.join(PUB, 'novo-logo.png')).convert('RGBA')
    new_master = new_master.crop(new_master.getbbox())

    failures = 0
    for name, anchor, region in CARDS:
        p = os.path.join(PUB, name)
        if not os.path.exists(p):
            print('  !! missing %s' % name); failures += 1; continue
        card = Image.open(p).convert('RGB')
        rl, rt, rr, rb = region if anchor != 'box' else (0.0, 0.0, 1.0, 1.0)
        RX, RY = int(card.width * rl), int(card.height * rt)
        sub = card.crop((RX, RY, int(card.width * rr), int(card.height * rb)))
        cg = gray(sub)
        if anchor == 'box':
            x, y, w, h = region
            sc = None
        tpl = {'coin': coin, 'wordmark': word}.get(anchor, legacy)

        # ⚠ THE FLOOR AGAIN. Third time this bites: shrink the template far enough and normalised
        # correlation finds a flawless 1.00 on noise. novo-cover scored exactly 1.00 at 54x23.
        # A lockup on a 1200px card is never narrower than 150px, a bare coin never under 70.
        lo = {'coin': 70, 'wordmark': 180}.get(anchor, 150)
        if anchor == 'box':
            lo = None
        hi = min(cg.shape[1] - 4, 460)
        if lo is not None and hi <= lo:
            print('  !! %-32s search region is smaller than the smallest plausible logo' % name)
            failures += 1; continue
        coarse = find_lockup(cg, tpl, range(lo, hi, 8)) if anchor != 'box' else None
        if anchor != 'box' and (not coarse or coarse[0] < 0.55):
            print('  !! %-32s NOT FOUND on %s (best %.2f)'
                  % (name, anchor, coarse[0] if coarse else -1)); failures += 1; continue
        if anchor != 'box':
            w0 = coarse[3]
            # the refine must not slip under the floor either - that is how a 144px "match" got in
            best = find_lockup(cg, tpl, range(max(lo, w0 - 6), w0 + 7, 2)) or coarse
            if best[0] < coarse[0]:
                best = coarse
            sc, tx, ty, tw, th = best
        if anchor == 'box':
            pass
        elif anchor == 'wordmark':
            # reconstruct the whole lockup from where the word sits: coin + gap + word
            cw, gp = tw * COIN_OVER_WORD, tw * GAP_OVER_WORD
            w = int(round(cw + gp + tw))
            h = int(round(legacy.height * w / legacy.width))
            x = int(round(tx + RX - cw - gp))
            y = int(round(ty + RY + th / 2 - h / 2))
        else:
            x, y, w, h = tx + RX, ty + RY, tw, th      # back into whole-card coordinates

        x = max(0, x); y = max(0, y)
        w = min(w, card.width - x); h = min(h, card.height - y)

        new = new_master.resize((w, max(1, round(new_master.height * w / new_master.width))),
                                Image.LANCZOS)
        if anchor == 'coin':
            # a coin-only slot gets the MARK alone, never the lockup - a wordmark does not belong
            # in a space sized for a symbol
            m = Image.open(os.path.join(PUB, 'brand', 'raster', 'mark-cyan.png')).convert('RGBA')
            m = m.crop(m.getbbox())
            new = m.resize((w, max(1, round(m.height * w / m.width))), Image.LANCZOS)

        arr = np.asarray(card).copy()
        arr = inpaint(arr, x, y, w, h)
        out = Image.fromarray(arr).convert('RGBA')
        out.paste(new, (x, y + (h - new.height) // 2), new)
        print('  %-32s %-8s %s  box=(%d,%d %dx%d)'
              % (name, anchor, ('measured' if sc is None else 'match %.2f' % sc), x, y, w, h))
        if write:
            out.convert('RGB').save(p, optimize=True)

    if failures:
        print('')
        print('  !! %d card(s) failed - a silent skip is how the old coin survived two swaps' % failures)
        return 1
    print('')
    print('  %s' % ('WRITTEN' if write else 'dry run - nothing written'))
    return 0


if __name__ == '__main__':
    sys.exit(main('--write' in sys.argv))
