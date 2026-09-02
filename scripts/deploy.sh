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
GEN_DIRT="$(git status --porcelain | grep -vE '^([ M?][ M?]) (public/sitemap\.xml|api/_lib/site-chrome\.js|public/journal/search-index\.json)$' || true)"
if [ -n "$(git status --porcelain)" ] && [ -z "$GEN_DIRT" ]; then
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
VERIFIED=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  # 1. STRONGEST: the build stamp the deployment itself carries. Proves the running code is this
  #    commit, regardless of which files moved. null/absent means unknown -- never treat it as a
  #    match (see api/health.js).
  LIVE_SHA=$(curl -s --max-time 10 "https://novo-options.trade/api/health?v=$RANDOM" \
             | grep -oE '"sha"[[:space:]]*:[[:space:]]*"[0-9a-f]{7,40}"' | grep -oE '[0-9a-f]{7,40}' | head -1 || true)
  if [ -n "$LIVE_SHA" ]; then
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
  echo "!! production did not verify after 40s"; exit 1
fi
mkdir -p .vercel && printf '%s' "$LOCAL" > "$STAMP"
if [ "$VERIFIED" = "index.html only" ]; then
  # Say so out loud. This deploy shipped nothing fetchable that changed and carried no build stamp,
  # so "it is live" is an assumption, not a measurement.
  echo "OK  deployed $LOCAL -- WEAK VERIFY (index.html unchanged by this deploy; nothing proved it shipped)"
else
  echo "OK  production serves $LOCAL (verified by $VERIFIED)"
fi
exit 0
