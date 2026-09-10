# -*- coding: utf-8 -*-
"""Build public/congress.html from the positioning page's chrome.

Jake, 2026-09-10: "build the page." A dedicated page rather than a section on /market-data,
because /market-data is a LIVE surface — fear gauge, futures strip, the locked dealer-map teaser —
and this is an archive you search. Mixing a weeks-old disclosure feed into a page selling live
positioning muddies both, and a dedicated URL earns its own search intent, which a section never
will.

⚠ GENERATED FROM positioning.html, NOT HAND-BUILT. Every marketing page on this site shares one
nav, one ticker strip, one footer and one stylesheet, and the way that stops being true is somebody
hand-writing a new page and getting 90% of it right. The chrome is lifted verbatim; only the head's
SEO block and the content between #main and <!-- FOOTER --> are replaced. Re-run it after a
sitewide nav change and the page follows along.

⚠ THE PANEL IS js/novo-congress.js — THE SAME MODULE THE TWO DASHBOARDS MOUNT. Third mount, one
implementation. A public copy of a dashboard panel is the exact shape that cost a day on the chat.
"""
import io, os, re, sys

PUB = os.path.join(os.path.dirname(__file__), "..", "public")
SRC = os.path.join(PUB, "positioning.html")
OUT = os.path.join(PUB, "congress.html")

TITLE = "Congressional Stock Trades &mdash; Every House Disclosure, From the Source | NoVo"
DESC = ("Free congressional stock trade tracker: every House periodic transaction report, read "
        "straight from the Clerk of the House. Filed dates, disclosure lag and the amount ranges "
        "as members actually file them.")
OG_TITLE = "Congressional stock trades &mdash; read straight from the House Clerk | NoVo"
OG_DESC = ("Every House periodic transaction report, with the disclosure lag on every row. These "
           "are filings, not live trades - members have up to 45 days to disclose.")
CANON = "https://novo-options.trade/congress"

# ⚠ FAQ ANSWERS ARE MEASURED, NOT WRITTEN. Every number here came off the live corpus (2,422 stock
# disclosures, 381 filings, 45 unreadable, median lag 18d, p90 34, max 476). A schema.org FAQ that
# Google surfaces is a claim under the company's name, so it does not get round numbers.
FAQ = [
    ("Is congressional stock trade data real time?",
     "No. The STOCK Act gives members up to 45 days to disclose a trade, so a filing published "
     "today usually describes a trade from weeks earlier. Across the disclosures on this page the "
     "median gap between the trade and its disclosure is 18 days, with a 90th percentile of 34 "
     "days and a longest case of 476. The filings themselves arrive most weekdays; the trades "
     "inside them do not."),
    ("Where does this data come from?",
     "The Clerk of the U.S. House of Representatives, which publishes an annual index of financial "
     "disclosures and one PDF per filing at disclosures-clerk.house.gov. NoVo reads that index and "
     "those filings directly. There is no aggregator, no vendor and no paid feed in the path, and "
     "the underlying records are public."),
    ("Why do the amounts show a range instead of a number?",
     "Because that is what members file. A disclosure reports a bracket such as $1,001 - $15,000 "
     "rather than the amount traded, so the size of any single trade is unknown. A few members do "
     "file an exact figure. Totals are not shown anywhere on this page: adding brackets together "
     "would produce a number nobody filed."),
    ("Does this include the Senate?",
     "Not yet. The Senate publishes through its own separate system with a different access "
     "process. This page is House periodic transaction reports only, and says so rather than "
     "presenting a partial picture under a whole-sounding name."),
    ("Are all filings included?",
     "All that can be read. Roughly 12% of periodic transaction reports are submitted on paper and "
     "published as scanned images with no machine-readable text - 45 of the 381 filed so far this "
     "year. Those are counted and reported under the table rather than dropped silently, because "
     "a member who filed on paper must not appear as a member who did not trade."),
    ("Can congressional disclosures be traded on?",
     "This page takes no position on that and publishes no signal. A disclosure is weeks old by the "
     "time it is public, the amount is a range, and NoVo grades nothing here. It is a public record "
     "presented as a public record."),
]


def build():
    s = io.open(SRC, encoding="utf-8").read()

    def one(pattern, repl, what):
        out, n = re.subn(pattern, lambda _m: repl, s, count=1)
        if n != 1:
            raise SystemExit("  !! %s: expected 1 substitution, made %d" % (what, n))
        return out

    s = one(r"<title>.*?</title>", "<title>%s</title>" % TITLE, "title")
    s = one(r'<meta name="description" content="[^"]*">',
            '<meta name="description" content="%s">' % DESC, "description")
    s = one(r'<meta property="og:url" content="[^"]*">',
            '<meta property="og:url" content="%s">' % CANON, "og:url")
    s = one(r'<meta property="og:title" content="[^"]*">',
            '<meta property="og:title" content="%s">' % OG_TITLE, "og:title")
    s = one(r'<meta property="og:description" content="[^"]*">',
            '<meta property="og:description" content="%s">' % OG_DESC, "og:description")
    s = one(r'<meta name="twitter:title" content="[^"]*">',
            '<meta name="twitter:title" content="%s">' % OG_TITLE, "twitter:title")
    s = one(r'<meta name="twitter:description" content="[^"]*">',
            '<meta name="twitter:description" content="%s">' % OG_DESC, "twitter:description")
    s = one(r'<link rel="canonical" href="[^"]*">',
            '<link rel="canonical" href="%s">' % CANON, "canonical")

    # structured data: what the page is, where it sits, and the questions it answers
    import json
    ld = [
        {"@context": "https://schema.org", "@type": "Dataset",
         "name": "Congressional stock trade disclosures (U.S. House)",
         "description": ("House periodic transaction reports parsed from the Clerk of the House's "
                         "own filings, with the disclosure lag on every row."),
         "url": CANON, "isAccessibleForFree": True,
         "license": "https://www.usa.gov/government-works",
         "creator": {"@type": "Organization", "name": "NoVo Options Trading"},
         "isBasedOn": "https://disclosures-clerk.house.gov/",
         "spatialCoverage": "United States"},
        {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://novo-options.trade/"},
            {"@type": "ListItem", "position": 2, "name": "Congressional trades", "item": CANON}]},
        {"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
            {"@type": "Question", "name": q,
             "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in FAQ]},
    ]
    s = one(r'<script type="application/ld\+json">.*?</script>',
            '<script type="application/ld+json">%s</script>' % json.dumps(ld, ensure_ascii=False),
            "ld+json")

    # ---- the page body ------------------------------------------------------------------------
    faq_html = "".join(
        '<div style="padding:16px 0;border-top:1px solid var(--bdr);">'
        '<h3 style="font-size:15.5px;font-weight:700;color:var(--txt1);margin:0 0 7px;">%s</h3>'
        '<p style="font-size:14.5px;line-height:1.7;color:var(--txt2);margin:0;">%s</p></div>'
        % (q, a.replace("&", "&amp;")) for q, a in FAQ)

    body = """<div id="main" tabindex="-1"></div>
<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span class="sep">&rsaquo;</span><span class="cur">Congressional trades</span></nav></div></div>

<div class="container hero" style="padding-bottom:8px;">
  <div class="lbl">Free &middot; public record</div>
  <h1 style="font-size:clamp(26px,4vw,40px);font-weight:900;color:var(--txt1);letter-spacing:-1px;line-height:1.12;margin:0 0 12px;">Congressional stock trades</h1>
  <p style="font-size:15.5px;line-height:1.7;color:var(--txt2);max-width:820px;margin:0;">Every House periodic transaction report, read straight from the Clerk of the House &mdash; no aggregator in between. <b style="color:var(--txt1);">These are filings, not live trades.</b> Members have up to 45 days to disclose, so every row here carries the gap between the trade and the day it became public.</p>
</div>

<div class="container sec">
  <!-- The panel is js/novo-congress.js, the SAME module the Analyst and Trader dashboards mount.
       Third mount, one implementation - a public copy of a dashboard panel is how two panels that
       disagree get born. -->
  <div id="congress-card"><div class="muted">Loading disclosures&hellip;</div></div>

  <div class="card" style="margin-top:22px;">
    <h2 class="h2" style="font-size:19px;margin:0 0 8px;">How to read it</h2>
    <p style="font-size:14.5px;line-height:1.7;color:var(--txt2);margin:0 0 10px;">Two dates matter and they are not the same date. The one shown first is when the member says the trade happened; <b style="color:var(--txt1);">filed N days later</b> is how long it took to reach the public record. Across the filings on this page that gap runs a median of 18 days, and the law allows 45.</p>
    <p style="font-size:14.5px;line-height:1.7;color:var(--txt2);margin:0 0 10px;">Amounts are the brackets members file &mdash; <b style="color:var(--txt1);">$1,001 - $15,000</b> rather than a figure &mdash; so the size of any single trade is unknown and nothing here is summed. The counts above the table count <em>filings</em>, never dollars.</p>
    <p style="font-size:13px;color:var(--txt3);margin:0;">Public-domain U.S. government records. NoVo publishes no signal on this page and grades nothing here &mdash; a disclosure is weeks old by the time anyone can read it.</p>
  </div>

  <div class="card" style="margin-top:18px;">
    <h2 class="h2" style="font-size:19px;margin:0 0 4px;">Questions</h2>
    %s
  </div>

  <p style="font-size:13.5px;line-height:1.7;color:var(--txt3);margin:20px 0 0;">Looking for positioning you can actually act on? The <a href="/market-data">dealer map</a> reads options positioning intraday, and <a href="/positioning">futures positioning</a> reads the CFTC weekly. Both are free.</p>
</div>

""" % faq_html

    i = s.find('<div id="main" tabindex="-1"></div>')
    j = s.find("<!-- FOOTER -->")
    if i < 0 or j < 0 or j <= i:
        raise SystemExit("  !! could not locate the content region in the template")
    s = s[:i] + body + s[j:]

    # the shared module, alongside the site's other scripts.
    # ⚠ THE GUARD CHECKS FOR THE SCRIPT TAG, NOT THE FILENAME. Testing `"novo-congress.js" not in s`
    # was satisfied by the COMMENT a few lines above in the body html, so the tag was never inserted
    # and the page rendered "Loading disclosures..." forever with no error anywhere. A presence
    # check that its own prose can satisfy is not a presence check.
    if 'src="/js/novo-congress.js' not in s:
        s = s.replace("</body>",
                      '<script src="/js/novo-congress.js?v=1"></script>\n'
                      '<script>(function(){ function go(){ try { window.novoCongress && '
                      'window.novoCongress.mount("#congress-card"); } catch (e) {} }\n'
                      '  if (document.readyState === "loading") '
                      'document.addEventListener("DOMContentLoaded", go); else go(); })();</script>\n'
                      "</body>", 1)

    io.open(OUT, "w", encoding="utf-8").write(s)
    print("  congress.html  %d chars" % len(s))
    # the chrome must have survived the transplant
    for must in ("nav-more-panel", "sitewide-ticker", "novo-congress.js", "congress-card",
                 'rel="canonical" href="%s"' % CANON, "FAQPage"):
        if must not in s:
            raise SystemExit("  !! generated page is missing %r" % must)
    print("  chrome, canonical, FAQ schema and the module all present")


if __name__ == "__main__":
    build()
