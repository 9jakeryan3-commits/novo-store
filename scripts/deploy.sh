#!/usr/bin/env bash
# Single deploy path for novo-store.
#
# Vercel's GitHub integration used to build every push while `vercel deploy --prod`
# built the same commit from this box. Two builders, one alias: whichever finished
# last won it, so the alias could walk BACKWARD onto older content and the site
# served two different builds at once (desktop stale, phone current).
# vercel.json now sets git.deploymentEnabled.master = false. The CLI is the only
# deployer, which means a commit that is never deployed here is never live --
# hence the guards below.
set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH=$(git branch --show-current)
[ "$BRANCH" = "master" ] || { echo "!! on '$BRANCH', not master"; exit 1; }

# Two repos hold one significance threshold (record-reader.js MIN_EFFECT_R mirrors the engine's
# claim_strength.py _BIG_GROUP_R) with nothing else crossing the boundary. If they drift, the
# store silently grades claims the engine refused — so drift fails the deploy out loud instead.
# The check was sabotage-tested in all three failure directions (drift / renamed constant /
# missing file) before it was wired here; env overrides PARITY_JS / PARITY_PY re-run those tests.
node scripts/threshold-parity-check.js

# Regenerate the derived artefacts BEFORE the clean-tree check, so a stale sitemap
# or a stale asset hash becomes a loud failure instead of silent drift.
#   - the sitemap was hand-maintained and reached 2,149 entries for 1,067 URLs
#   - ?v= was hand-typed and never bumped, against a one-year immutable cache, so
#     edits to chat-widget.js and friends never reached a returning visitor
# If either rewrites anything, the tree goes dirty and the guard below stops the
# deploy and tells you to commit -- which is the point.
node scripts/build-sitemap.js
#   - the journal search index drifted BOTH ways: 21 entries pointed at articles deleted in
#     the duplicate merges, and all 8 crypto articles were missing -- the $79 product's whole
#     education surface was unfindable in the Journal's own search box.
node scripts/build-search-index.js
#   - the journal hub promises "Everything in the Journal" and was listing 1,002 of 1,287:
#     static markup that nothing regenerated, so every article published drifted it further
node scripts/build-journal-archive.js
node scripts/stamp-assets.js
#   - every coin count on /crypto was hand-typed and drifted: the page claimed 89 coins and 82
#     with leverage positioning while the collector was publishing 90 and 83
node scripts/sync-crypto-counts.js
node scripts/sync-track-record.js
# Lift the site's real header/footer/CSS into api/_lib/site-chrome.js so the server-rendered
# pages (/analyst/archive) match the static ones. AFTER stamp-assets and the counts, so the
# extracted markup carries the current ?v= hashes and the current numbers.
node scripts/build-site-chrome.js

# lastmod is read from git, so the commit that ships a content change also moves the
# dates the sitemap records -- meaning the sitemap is always exactly one commit behind
# and would block every single deploy. When the ONLY thing regeneration touched is the
# sitemap, that is this lag and nothing else, so commit it and carry on. Anything else
# dirty is a real uncommitted change and still stops the deploy below.
# public/journal/search-index.json is regenerated on every deploy too and moves whenever any
# article title or dek moves, which is most deploys.
# api/_lib/site-chrome.js is generated the same way, from the static header/footer, and moves
# whenever the site's chrome or its ?v= hashes do. Same reasoning as the sitemap: if the ONLY
# dirty paths are generated ones, that is the pipeline's own lag, not an uncommitted change.
#
# THIS USED TO REQUIRE THE GENERATED FILES TO BE THE *ONLY* DIRTY PATHS, AND THAT DEADLOCKED
# (fixed 2026-09-04). Two auto-commit gates guard this deploy: this one for generated files, and
# the count-churn one below for content HTML whose figures moved. Each demanded that its own
# category be the entire diff — so the moment BOTH were dirty at once, neither could fire:
#
#   gate 1  refused, because the compare-*.html pages are not on its whitelist
#   gate 2  refused, because count-churn-only.js saw sitemap.xml, whose lastmod is a DATE and
#           not one of the anchored count slots  ->  "!! not count-only: public/sitemap.xml"
#
# That happens on any day the track-record count moves AND the sitemap's date rolls over, which is
# most days, and it stays stuck until someone commits by hand. Jake: "that is not anybody else, if
# it is, its been there for days."
#
# The whitelist's own reasoning already answers it: these three are REGENERATED ON EVERY DEPLOY,
# so a dirty one is always this pipeline's lag and never a human's half-finished edit — nobody
# hand-writes sitemap.xml or search-index.json, and a hand edit would be overwritten above
# regardless. So commit them whenever they are dirty, not only when they are alone. Every safety
# property is kept: this stages ONLY those three paths, and anything else still has to satisfy the
# count-churn gate below or halt the deploy.
GEN_DIRTY="$(git status --porcelain -- public/sitemap.xml api/_lib/site-chrome.js public/journal/search-index.json)"
if [ -n "$GEN_DIRTY" ]; then
  git add public/sitemap.xml api/_lib/site-chrome.js public/journal/search-index.json 2>/dev/null || true
  git commit -q -m "generated: sitemap lastmod, site chrome, search index"
  git push -q
  echo ".. generated files refreshed and pushed"
fi

# The crypto counts are the awkward case: sync-crypto-counts.js writes live figures into CONTENT
# html, where a generated edit and a hand edit are indistinguishable by path -- so these files can
# never join the whitelist above. The on-chain figure genuinely moves between runs (202, then 191,
# then 202 again inside one hour on 2026-08-30), and every move halted a deploy.
# count-churn-only.js answers the question the whitelist cannot: is every changed line identical
# apart from a figure in one of the anchored count slots? Only then is it auto-committed. A price
# or a headline moving in the same file fails it, and the halt below still fires.
if [ -n "$(git status --porcelain)" ] && node scripts/count-churn-only.js; then
  # journal/index.html carries a count too (the hub, not the 1,000+ articles). It joined the sync
  # script's file list on 2026-08-31; without it here a synced hub would sit dirty and halt the
  # NEXT deploy instead of riding along with the other generated count edits.
  git add public/crypto.html public/faq.html public/index.html public/plans.html           public/crypto-live.html public/compare-best-gamma-gex-tools.html           public/journal/index.html           public/analyst.html public/trader.html public/ai.html           public/compare-novo-vs-spotgamma.html public/compare-novo-vs-menthorq.html           public/compare-novo-vs-option-alpha.html public/compare-novo-vs-unusual-whales.html 2>/dev/null || true
  git commit -q -m "generated: crypto counts synced to the live sweep"
  git push -q
  echo ".. crypto counts refreshed and pushed"
fi

# Production is built from the local working tree, so it must equal the commit.
if [ -n "$(git status --porcelain)" ]; then
  echo "!! uncommitted changes -- commit before deploying:"; git status --short; exit 1
fi

git fetch -q origin master
LOCAL=$(git rev-parse HEAD); REMOTE=$(git rev-parse origin/master)
if [ "$LOCAL" != "$REMOTE" ]; then
  echo ".. pushing $LOCAL"; git push -q origin master; REMOTE=$(git rev-parse origin/master)
fi
[ "$LOCAL" = "$REMOTE" ] || { echo "!! HEAD != origin/master after push"; exit 1; }

echo ".. deploying $LOCAL"
npx vercel deploy --prod --yes >/tmp/novo-deploy.log 2>&1 || { tail -20 /tmp/novo-deploy.log; exit 1; }
grep -o '"message": "[^"]*"' /tmp/novo-deploy.log | head -1

# The deploy is not done until the alias actually serves it.
#
# ⚠ THIS CHECK USED TO PROVE LESS THAN IT CLAIMED (fixed 2026-09-02). It compared live `/` against
# public/index.html and printed "OK production serves $LOCAL" on a match. For any deploy that did
# not touch index.html -- every api-only change, and this repo ships a lot of them -- index.html
# matched BEFORE the deploy too, so the loop passed on its first iteration without demonstrating
# that anything had shipped. The success line named a SHA it had never tested. Every "OK production
# serves X" quoted for an api-only change today proved only that index.html had not changed.
#
# Three checks now, strongest first, and the message says WHICH one answered so the claim never
# outruns the evidence again.
STAMP=".vercel/last-deployed-sha"           # .vercel is already gitignored; local bookkeeping only
PREV=$(cat "$STAMP" 2>/dev/null || true)

# What did this deploy actually change, in files the browser can fetch? Empty for an api-only
# deploy, which is exactly the case the old check could not see.
CHANGED_PUBLIC=""
if [ -n "$PREV" ] && git cat-file -e "${PREV}^{commit}" 2>/dev/null; then
  CHANGED_PUBLIC=$(git diff --name-only "$PREV" "$LOCAL" -- public/ | grep -E '\.(html|js|css|json|xml|txt)$' || true)
fi

echo ".. verifying"
# 2 minutes, not 40 seconds. The old check compared index.html, a STATIC file that is live the
# moment the alias moves; the build stamp lives in /api/health, a serverless FUNCTION, and a new
# function takes noticeably longer to answer at the alias. First real use of the stricter check
# reported "did not verify" on a deploy that was in fact perfectly healthy and serving the right
# commit seconds later -- a false negative caused purely by inheriting the old window.
#
# A stricter signal has earned more patience: the failure it is protecting against (a deploy that
# never landed) does not resolve itself in the extra ninety seconds, and the one it was reporting
# does.
VERIFIED=""; LAST_SEEN=""
for i in $(seq 1 30); do
  # 1. STRONGEST: the build stamp the deployment itself carries. Proves the running code is this
  #    commit, regardless of which files moved. null/absent means unknown -- never treat it as a
  #    match (see api/health.js).
  LIVE_SHA=$(curl -s --max-time 10 "https://novo-options.trade/api/health?v=$RANDOM" \
             | grep -oE '"sha"[[:space:]]*:[[:space:]]*"[0-9a-f]{7,40}"' | grep -oE '[0-9a-f]{7,40}' | head -1 || true)
  if [ -n "$LIVE_SHA" ]; then
    LAST_SEEN="$LIVE_SHA"
    case "$LOCAL" in "$LIVE_SHA"*) VERIFIED="build stamp"; break;; esac
  fi

  # 2. A file this deploy genuinely changed. Only meaningful when there IS one.
  if [ -n "$CHANGED_PUBLIC" ]; then
    ALL_MATCH=1
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      [ -f "$f" ] || continue                       # deleted file: nothing to fetch
      URL="https://novo-options.trade/${f#public/}"
      # || true: with `set -euo pipefail` a transient curl timeout would abort the DEPLOY here
      # rather than retry, turning a network blip into a failed ship.
      L=$(curl -s --max-time 10 "$URL?v=$RANDOM" | md5sum | cut -d' ' -f1 || true)
      W=$(md5sum <"$f" | cut -d' ' -f1)
      [ "$L" = "$W" ] || { ALL_MATCH=0; break; }
    done <<< "$CHANGED_PUBLIC"
    if [ "$ALL_MATCH" = "1" ]; then VERIFIED="changed files"; break; fi
  fi

  # 3. WEAKEST, and only when the other two cannot speak: the original index.html comparison.
  #    Kept because it is a real signal when index.html DID change, and reported honestly when not.
  if [ -z "$LIVE_SHA" ] && [ -z "$CHANGED_PUBLIC" ]; then
    LIVE=$(curl -s --max-time 10 "https://novo-options.trade/?v=$RANDOM" | md5sum | cut -d' ' -f1 || true)
    WANT=$(md5sum <public/index.html | cut -d' ' -f1)
    [ "$LIVE" = "$WANT" ] && { VERIFIED="index.html only"; break; }
  fi
  sleep 4
done

if [ -z "$VERIFIED" ]; then
  # Say WHAT was serving. "did not verify" alone cannot distinguish "the alias never moved" from
  # "the alias is still on the previous build" from "something is broken", and those need
  # different reactions.
  if [ -n "$LAST_SEEN" ]; then
    echo "!! production did not verify after 120s -- alias still serving $LAST_SEEN, wanted $LOCAL"
  else
    echo "!! production did not verify after 120s -- no build stamp answered and no changed file matched"
  fi
  exit 1
fi
mkdir -p .vercel && printf '%s' "$LOCAL" > "$STAMP"
if [ "$VERIFIED" = "index.html only" ]; then
  # Say so out loud. This deploy shipped nothing fetchable that changed and carried no build stamp,
  # so "it is live" is an assumption, not a measurement.
  echo "OK  deployed $LOCAL -- WEAK VERIFY (index.html unchanged by this deploy; nothing proved it shipped)"
else
  echo "OK  production serves $LOCAL (verified by $VERIFIED)"
fi

# ── post-deploy smoke: the deploy landed; now prove the product still ANSWERS ────────────────
# ~20 deploys/12h shipped with no checkout-path smoke at all (register lead). Read-only GETs only
# -- no Stripe sessions are minted by a deploy. A failure here exits 1 with wording DISTINCT from
# a failed deploy, because it is the worse case: the alias is already serving this commit.
# 200-with-nothing is the vacuous trap, so every probe demands a minimum body size, and the two
# APIs must show a real field, not merely answer.
SMOKE_FAIL=""
smoke() { # url  min_bytes  [needle-regex]
  local u="$1" mb="$2" needle="${3:-}" body code have="absent" try
  for try in 1 2; do
    body=$(curl -s --max-time 15 -w '\n%{http_code}' "$u?v=$RANDOM" || true)
    code="${body##*$'\n'}"; body="${body%$'\n'*}"
    if [ -n "$needle" ] && printf '%s' "$body" | grep -qE "$needle"; then have="found"; fi
    if [ "$code" = "200" ] && [ "${#body}" -ge "$mb" ] && { [ -z "$needle" ] || [ "$have" = "found" ]; }; then
      return 0
    fi
    sleep 3
  done
  SMOKE_FAIL="${SMOKE_FAIL}
!!   $u -> http=${code:-none} bytes=${#body}${needle:+ needle=$have}"
}
echo ".. smoke"
smoke "https://novo-options.trade/api/health"       50   '"sha"'
smoke "https://novo-options.trade/"                 5000
smoke "https://novo-options.trade/plans"            5000
smoke "https://novo-options.trade/analyst"          5000
smoke "https://novo-options.trade/crypto"           5000
smoke "https://novo-options.trade/track-record"     5000
smoke "https://novo-options.trade/api/track-record" 200  '"ok"'
if [ -n "$SMOKE_FAIL" ]; then
  echo "!! DEPLOY LANDED ($LOCAL) BUT SMOKE FAILED:$SMOKE_FAIL"
  echo "!! the alias is already serving this commit -- fix forward or revert; re-running deploy changes nothing"
  exit 1
fi
echo "OK  smoke: 7/7 surfaces answering with real bodies"
exit 0
