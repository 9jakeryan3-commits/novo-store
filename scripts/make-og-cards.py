# -*- coding: utf-8 -*-
"""Cut the OG share cards for Analyst and Crypto.

Both pages were sharing og-home.png, so a link to either previewed as the homepage. Trader, Plans
and /ai already had their own; these two were the gap.

Design is measured off og-trader.png and og-plans.png rather than invented, so the set stays one
system: 1200x630, the same vertical navy gradient sampled from those files, the lockup top-left, a
heavy title, a tagline in the product's accent, a small-caps feature strip, then the price.

The lockup is COMPOSITED from public/novo-logo.png, never re-typed -- the wordmark was lifted from
Jake's comp and re-setting it in a system font would quietly produce a second, wrong mark.

Accents come from each page's own CSS: Analyst cyan #22d3ee (64 uses on analyst.html), Crypto
purple --cx #a78bfa. Titles carry no "NoVo" prefix: the lockup already supplies the brand, and since
NoVo IS the analyst, a card reading "NoVo Analyst" is the exact ambiguity the 2026-08-22 rename
removed from the pages.

Run:  python scripts/make-og-cards.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(HERE, '..', 'public')
FONTS = r'C:\Windows\Fonts'

W, H = 1200, 630
TOP = (0x0e, 0x1d, 0x32)          # sampled from og-plans.png top edge
BOT = (0x09, 0x0f, 0x1a)          # ...and its bottom edge
TXT1 = (0xea, 0xf3, 0xff)
TXT2 = (0x8a, 0xac, 0xc8)
TXT3 = (0x7d, 0x97, 0xb8)


def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)


def background():
    """The card's ground: vertical navy gradient, then a soft darkening to the right like og-trader."""
    im = Image.new('RGB', (W, H), TOP)
    d = ImageDraw.Draw(im)
    for y in range(H):
        t = y / (H - 1)
        d.line([(0, y), (W, y)], fill=tuple(int(TOP[i] + (BOT[i] - TOP[i]) * t) for i in range(3)))
    # right-hand falloff, so a panel sitting there has something to sit against
    shade = Image.new('L', (W, H), 0)
    sd = ImageDraw.Draw(shade)
    for x in range(W):
        v = max(0, int(70 * (x - 620) / (W - 620))) if x > 620 else 0
        sd.line([(x, 0), (x, H)], fill=v)
    return Image.composite(Image.new('RGB', (W, H), (0, 0, 0)), im, shade)


def lockup(im, x, y, width=196):
    logo = Image.open(os.path.join(PUB, 'novo-logo.png')).convert('RGBA')
    h = round(logo.height * width / logo.width)
    im.paste(logo.resize((width, h), Image.LANCZOS), (x, y), logo.resize((width, h), Image.LANCZOS))
    return h


def tracked(d, xy, text, f, fill, extra=2.0):
    """Letter-spaced small caps -- the strip on og-trader is tracked out and PIL will not do it."""
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=f, fill=fill)
        x += d.textlength(ch, font=f) + extra
    return x


def ladder(size, accent, deep):
    """A dealer-map ladder for the crypto card.

       Drawn, not screenshotted. There is no crypto dashboard capture in the repo, and inventing a
       fake UI screenshot for a share card would be selling something that does not look like that.
       This is the shape the product actually renders -- gamma by strike either side of a flip -- as
       an honest graphic.
    """
    w, h = size
    panel = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(panel)
    d.rounded_rectangle([0, 0, w - 1, h - 1], 18, fill=(0x14, 0x16, 0x22, 255),
                        outline=(0x2e, 0x30, 0x36, 255), width=2)
    mid, rows = w // 2, 13
    top, gap = 46, (h - 92) / rows
    peak = [0.18, 0.30, 0.46, 0.62, 0.85, 1.00, 0.72, 0.55, 0.78, 0.94, 0.60, 0.38, 0.22]
    for i in range(rows):
        y = int(top + i * gap)
        callside = i < 6
        length = int((w * 0.36) * peak[i])
        col = accent if callside else deep
        if callside:
            d.rounded_rectangle([mid + 6, y, mid + 6 + length, y + int(gap * 0.52)], 4, fill=col)
        else:
            d.rounded_rectangle([mid - 6 - length, y, mid - 6, y + int(gap * 0.52)], 4, fill=col)
    # the flip: the line the whole map turns on
    fy = int(top + 5.6 * gap)
    d.line([(24, fy), (w - 24, fy)], fill=(0xf4, 0x3f, 0x5e, 220), width=2)
    d.line([(mid, 30), (mid, h - 30)], fill=(0x2e, 0x30, 0x36, 255), width=1)
    return panel


def fit(d, text, name, max_size, max_w, min_size=18, extra=0.0):
    """Largest size at which the line fits the column. Copy changes; the column does not.

       Hand-tuned sizes are how "OPEN & CLOSE READS" ran under the screenshot panel on the first
       cut of these cards -- the title fitted, so the strip was assumed to.
    """
    size = max_size
    while size > min_size:
        f = ImageFont.truetype(os.path.join(FONTS, name), size)
        w = d.textlength(text, font=f) + extra * max(0, len(text) - 1)
        if w <= max_w:
            return f
        size -= 1
    return ImageFont.truetype(os.path.join(FONTS, name), min_size)


def wrap(d, text, f, max_w):
    lines, cur = [], ''
    for word in text.split():
        trial = (cur + ' ' + word).strip()
        if d.textlength(trial, font=f) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur); cur = word
    if cur:
        lines.append(cur)
    return lines


COL = 580          # the left column: 62 to 642, with a 26px gutter before the panel at 668


def card(out, title, tagline, strip, price, price_tail, accent, right):
    im = background()
    d = ImageDraw.Draw(im)

    lockup(im, 62, 58)

    tf = fit(d, title, 'seguibl.ttf', 66, COL)
    d.text((62, 208), title, font=tf, fill=TXT1)

    # An explicit newline in the tagline breaks at the sentence. Auto-wrap put "analyst." alone on
    # line two -- a widow, fine in a paragraph and cheap-looking as the one line of copy on a card.
    gf = ImageFont.truetype(os.path.join(FONTS, 'segoeui.ttf'), 30)
    lines = [l for part in tagline.split(chr(10)) for l in wrap(d, part, gf, COL)]
    y = 300
    for ln in lines:
        d.text((64, y), ln, font=gf, fill=accent)
        y += 38

    sf = fit(d, strip, 'segoeuib.ttf', 20, COL, min_size=14, extra=1.6)
    tracked(d, (64, max(y + 18, 372)), strip, sf, TXT2, extra=1.6)

    pf = ImageFont.truetype(os.path.join(FONTS, 'seguibl.ttf'), 40)
    d.text((62, 452), price, font=pf, fill=accent)
    d.text((62 + d.textlength(price, font=pf) + 14, 462), price_tail,
           font=ImageFont.truetype(os.path.join(FONTS, 'segoeui.ttf'), 27), fill=TXT3)

    if right is not None:
        im.paste(right, (668, 108), right)
    im.save(os.path.join(PUB, out), optimize=True)
    print('  wrote %-20s %s KB' % (out, os.path.getsize(os.path.join(PUB, out)) // 1024))


# ---- Analyst: the real dashboard, because one exists -------------------------------------------
shot = Image.open(os.path.join(PUB, 'screenshots', 'analyst-dash-1.webp')).convert('RGBA')
tw = 470
shot = shot.resize((tw, round(shot.height * tw / shot.width)), Image.LANCZOS)
shot = shot.crop((0, 0, tw, min(shot.height, 414)))
framed = Image.new('RGBA', (shot.width + 4, shot.height + 4), (0x2e, 0x30, 0x36, 255))
framed.paste(shot, (2, 2))

card('og-analyst.png', 'Analyst', "Dealers have to hedge. That's your map.",
     'LIVE DEALER MAP  \u00b7  SPY QQQ IWM  \u00b7  OPEN & CLOSE READS',
     '$129/mo', '\u00b7 7-day free trial', (0x22, 0xd3, 0xee), framed)

# ---- Crypto: drawn, because no capture exists --------------------------------------------------
card('og-crypto.png', 'Crypto Market Map',
     'Crypto has a dealer map.' + chr(10) + 'Now it has an analyst.',
     'DEALER GAMMA  \u00b7  FUNDING BY VENUE  \u00b7  LIQUIDATIONS',
     '$79/mo', '\u00b7 7-day free trial', (0xa7, 0x8b, 0xfa),
     ladder((470, 414), (0xa7, 0x8b, 0xfa, 255), (0x7c, 0x3a, 0xed, 255)))

# ---- Trader: the cockpit (2026-08-31 — the old card sold one-click entry and auto exits, the
# retired execution product; Jake caught it in a Discord embed. The real terminal is the shot.) ----
# The DESKTOP shot (2026-08-31): "the cockpit" should show the cockpit, and the wide terminal
# fits the card whole — chart, labelled levels, flow rail — where a phone shot cropped to its
# empty top third. Padded to the analyst card's 418px band so it sits vertically centered.
tshot = Image.open(os.path.join(PUB, 'screenshots', 'trader-live-desk.webp')).convert('RGBA')
tw2 = 470
tshot = tshot.resize((tw2, round(tshot.height * tw2 / tshot.width)), Image.LANCZOS)
_tf = Image.new('RGBA', (tshot.width + 4, tshot.height + 4), (0x2e, 0x30, 0x36, 255))
_tf.paste(tshot, (2, 2))
tframed = Image.new('RGBA', (_tf.width, 418), (0, 0, 0, 0))
tframed.paste(_tf, (0, (418 - _tf.height) // 2))

card('og-trader.png', 'Trader', 'The cockpit. Every dealer level,' + chr(10) + 'living on the candles.',
     'CHARTING TERMINAL  ·  VOLUME PROFILE  ·  THE THREE BOOKS  ·  24/5',
     '$209/mo', '· includes Analyst', (0x34, 0xd3, 0x99), tframed)

# ---- Plans: four lanes, no execution claims (replaces the hand-made three-lane card whose Trader
# lane read "One click in, exits automated") --------------------------------------------------------
def plans_card():
    im = background()
    d = ImageDraw.Draw(im)
    logo = Image.open(os.path.join(PUB, 'novo-logo.png')).convert('RGBA')
    lw = 150
    logo = logo.resize((lw, round(logo.height * lw / logo.width)), Image.LANCZOS)
    im.paste(logo, ((1200 - lw) // 2, 34), logo)

    tf = font('seguibl.ttf', 54)
    t = 'Choose your lane.'
    d.text(((1200 - d.textlength(t, font=tf)) // 2, 128), t, font=tf, fill=TXT1)
    sf = font('segoeui.ttf', 26)
    s2 = 'Read it free  →  the desk  →  the cockpit.'
    d.text(((1200 - d.textlength(s2, font=sf)) // 2, 200), s2, font=sf, fill=TXT3)

    lanes = [
        ('FREE', '$0', 'Market notes + the Journal', 'No card, ever', (0xf5, 0x9e, 0x0b)),
        ('CRYPTO MAP', '$79/mo', 'The dealer map, on crypto', '7-day free trial', (0xa7, 0x8b, 0xfa)),
        ('ANALYST', '$129/mo', 'The desk — map, reads + NoVo', '7-day free trial', (0x22, 0xd3, 0xee)),
        ('TRADER', '$209/mo', 'The cockpit — the terminal', 'Includes Analyst', (0x34, 0xd3, 0x99)),
    ]
    W, H, GAP = 264, 270, 20
    x0 = (1200 - (W * 4 + GAP * 3)) // 2
    y0 = 268
    nf = font('segoeuib.ttf', 19)
    pf = font('seguibl.ttf', 40)
    df = font('segoeui.ttf', 19)
    mf = font('segoeui.ttf', 16)
    for i, (name, price, desc, note, ac) in enumerate(lanes):
        x = x0 + i * (W + GAP)
        d.rectangle([x, y0, x + W, y0 + 5], fill=ac)
        d.rounded_rectangle([x, y0 + 5, x + W, y0 + H], radius=10,
                            fill=(0x11, 0x16, 0x20, 255), outline=(0x2a, 0x33, 0x42, 255), width=1)
        d.text((x + 20, y0 + 28), name, font=nf, fill=ac)
        d.text((x + 20, y0 + 62), price, font=pf, fill=TXT1)
        yy = y0 + 128
        for ln in wrap(d, desc, df, W - 40):
            d.text((x + 20, yy), ln, font=df, fill=TXT2)
            yy += 26
        d.text((x + 20, y0 + H - 40), note, font=mf, fill=TXT3)
    d.text(((1200 - d.textlength('novo-options.trade', font=font('segoeuib.ttf', 22))) // 2, 578),
           'novo-options.trade', font=font('segoeuib.ttf', 22), fill=TXT3)
    im.save(os.path.join(PUB, 'og-plans.png'), optimize=True)
    print('  wrote %-20s %s KB' % ('og-plans.png', os.path.getsize(os.path.join(PUB, 'og-plans.png')) // 1024))

plans_card()
