# -*- coding: utf-8 -*-
"""Bump ?v= on every IMAGE whose bytes actually changed in the working tree.

⚠ stamp-assets.js DOES NOT COVER IMAGES. It walks '.js' and '.css' only, so every og-*.png and
journal cover carries a hand-typed ?v= that nothing bumps automatically. Those files are served
immutable for a year AND cached by Twitter, Discord, Slack and Facebook against the exact URL --
so a share card that changes without its ?v= moving is a card nobody will ever see change. That
is the whole reason the old coin appeared to survive previous swaps: the bytes were replaced and
the URL was not.

Bumps only what git says changed, so a re-run is a no-op rather than a cache-buster in its own
right.
"""
import io, os, re, subprocess, sys

ROOT = os.path.join(os.path.dirname(__file__), '..')
write = '--write' in sys.argv

changed = subprocess.run(['git', 'diff', '--name-only', 'HEAD'], cwd=ROOT,
                         capture_output=True, text=True).stdout.split('\n')
imgs = sorted({p.strip() for p in changed
               if p.strip().lower().endswith(('.png', '.jpg', '.webp', '.ico'))
               and p.strip().startswith('public/')})
if not imgs:
    print('  no changed images - nothing to bump')
    sys.exit(0)

# map "public/og-home.png" -> the URL path it is referenced by
urls = {}
for p in imgs:
    urls[p] = '/' + p[len('public/'):].replace(chr(92), '/')

print('  changed images:')
for p in imgs:
    print('     %s' % urls[p])

html = []
for base, _dirs, files in os.walk(os.path.join(ROOT, 'public')):
    for f in files:
        if f.endswith(('.html', '.js', '.json', '.webmanifest', '.xml')):
            html.append(os.path.join(base, f))

total, touched = 0, set()
for f in html:
    raw = io.open(f, 'rb').read().decode('utf-8', 'replace')
    orig = raw
    for p, u in urls.items():
        # match the url followed by ?v=<n>, and bump n. Anchored on the exact path so
        # og-home.png never matches og-home-wide.png.
        pat = re.compile(re.escape(u) + r'\?v=(\d+)')
        def bump(m):
            return u + '?v=' + str(int(m.group(1)) + 1)
        raw = pat.sub(bump, raw)
    if raw != orig:
        n = sum(1 for _ in re.finditer(r'\?v=\d+', raw))
        total += 1
        touched.add(os.path.relpath(f, ROOT))
        if write:
            io.open(f, 'wb').write(raw.encode('utf-8'))

print('\n  %d file(s) rewritten' % total)
# A changed image with NO reference anywhere is a real finding, not a clean pass: it means the new
# card is not actually wired to any page.
unref = []
for p, u in urls.items():
    hits = subprocess.run(['git', 'grep', '-l', '--', u.lstrip('/')], cwd=ROOT,
                          capture_output=True, text=True).stdout
    if not hits.strip():
        unref.append(u)
if unref:
    print('  !! changed but referenced by nothing: %s' % ', '.join(unref))
print('  %s' % ('WRITTEN' if write else 'dry run'))
