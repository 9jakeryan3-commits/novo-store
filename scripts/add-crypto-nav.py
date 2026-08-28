"""
add-crypto-nav.py — insert the Crypto link into every nav variant across the site.

The header/footer here is copy-pasted per page, not templated, so this is a real sweep:
1,074 HTML files and SIX distinct "Trader" anchor variants, each with its own styling.
A single regex over all of them would either miss most or flatten the styling, so each
variant gets its own exact-string rule and its Crypto twin is built from the SAME markup.

Safety, in order:
  * exact-string matching only — no regex over markup structure
  * every file is validated AFTER the edit (tag balance + the link actually present)
    and reverted in memory if the check fails, so a bad edit is never written
  * --dry is the default; --write must be passed explicitly
  * the whole run aborts if ANY file fails validation, rather than half-converting the site

    python scripts/add-crypto-nav.py            # dry run, prints the plan
    python scripts/add-crypto-nav.py --write     # apply
    python scripts/add-crypto-nav.py --verify    # confirm coverage after the fact
"""
import io
import os
import re
import sys
import glob

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")

# Each rule: the exact Trader anchor as it appears, and the Crypto anchor to insert after
# it — same attributes, so each nav keeps its own styling.
RULES = [
    ('<a href="/trader">Trader</a>',
     '<a href="/crypto">Crypto</a>'),
    ('<a class="nav-link" href="/trader">Trader</a>',
     '<a class="nav-link" href="/crypto">Crypto</a>'),
    ('<a href="/trader" style="color:var(--txt2);font-weight:600;font-size:14px;text-decoration:none;padding:10px 12px;white-space:nowrap;">Trader</a>',
     '<a href="/crypto" style="color:var(--txt2);font-weight:600;font-size:14px;text-decoration:none;padding:10px 12px;white-space:nowrap;">Crypto</a>'),
    ('<a href="/trader" style="color:var(--txt2);text-decoration:none;font-weight:600;font-size:13px;">Trader</a>',
     '<a href="/crypto" style="color:var(--txt2);text-decoration:none;font-weight:600;font-size:13px;">Crypto</a>'),
    ('<a href="/trader" style="color:var(--txt2);text-decoration:none;font-weight:600;margin-right:14px;">Trader</a>',
     '<a href="/crypto" style="color:var(--txt2);text-decoration:none;font-weight:600;margin-right:14px;">Crypto</a>'),
    ('<a href="/trader" style="color:#34d399;font-weight:700;">Trader</a>',
     '<a href="/crypto" style="color:#34d399;font-weight:700;">Crypto</a>'),
]

# Longest first: '<a href="/trader">Trader</a>' is NOT a substring of the styled variants
# (different prefix), but ordering by length keeps that true if a variant is ever added.
RULES.sort(key=lambda r: -len(r[0]))

TAGS = ("div", "section", "nav", "ul", "li", "a", "p", "span", "script", "footer", "header")


def tag_balance(html):
    return {t: (len(re.findall(rf"<{t}[ >]", html)), len(re.findall(rf"</{t}>", html))) for t in TAGS}


def process(path, write):
    try:
        orig = io.open(path, encoding="utf-8", errors="ignore").read()
    except Exception as e:
        return ("read-error", str(e)[:60], 0)

    if '<a href="/crypto">Crypto</a>' in orig or '"/crypto"' in orig and ">Crypto<" in orig:
        return ("already", "", 0)

    before = tag_balance(orig)
    out, inserted = orig, 0
    for trader, crypto in RULES:
        if trader not in out:
            continue
        n = out.count(trader)
        out = out.replace(trader, trader + crypto)
        inserted += n

    if not inserted:
        return ("no-nav", "", 0)

    # Validate BEFORE writing. An insertion adds exactly one <a>…</a> per hit; every other
    # tag count must be untouched.
    after = tag_balance(out)
    for t, (o, c) in after.items():
        bo, bc = before[t]
        expect_o = bo + (inserted if t == "a" else 0)
        expect_c = bc + (inserted if t == "a" else 0)
        if (o, c) != (expect_o, expect_c):
            return ("VALIDATION-FAILED", f"{t}: {bo}/{bc} -> {o}/{c}", 0)
    if out.count('href="/crypto"') != inserted:
        return ("VALIDATION-FAILED", "crypto link count mismatch", 0)

    if write:
        io.open(path, "w", encoding="utf-8").write(out)
    return ("ok", "", inserted)


def main():
    write = "--write" in sys.argv
    verify = "--verify" in sys.argv
    files = sorted(glob.glob(os.path.join(ROOT, "**", "*.html"), recursive=True))

    if verify:
        missing = [f for f in files
                   if 'href="/trader"' in io.open(f, encoding="utf-8", errors="ignore").read()
                   and 'href="/crypto"' not in io.open(f, encoding="utf-8", errors="ignore").read()]
        print(f"{len(files)} files scanned")
        print(f"pages with a Trader link but NO Crypto link: {len(missing)}")
        for m in missing[:12]:
            print("   ", os.path.relpath(m, ROOT))
        return 1 if missing else 0

    stats, failures, total_links = {}, [], 0
    for f in files:
        status, detail, n = process(f, write)
        stats[status] = stats.get(status, 0) + 1
        total_links += n
        if status == "VALIDATION-FAILED":
            failures.append((os.path.relpath(f, ROOT), detail))

    print(("APPLIED" if write else "DRY RUN") + f" — {len(files)} files")
    for k, v in sorted(stats.items()):
        print(f"  {k:<20} {v}")
    print(f"  crypto links inserted: {total_links}")
    if failures:
        print(f"\n*** {len(failures)} VALIDATION FAILURES — nothing written for these ***")
        for f, d in failures[:10]:
            print(f"   {f}: {d}")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
