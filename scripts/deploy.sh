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
node scripts/stamp-assets.js
#   - every coin count on /crypto was hand-typed and drifted: the page claimed 89 coins and 82
#     with leverage positioning while the collector was publishing 90 and 83
node scripts/sync-crypto-counts.js
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
  git add public/crypto.html public/faq.html public/index.html public/plans.html           public/crypto-live.html public/compare-best-gamma-gex-tools.html           public/journal/index.html 2>/dev/null || true
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
echo ".. verifying"
for i in 1 2 3 4 5 6 7 8 9 10; do
  # Compare raw bytes on both sides -- normalising one and not the other always fails.
  LIVE=$(curl -s "https://novo-options.trade/?v=$RANDOM" | md5sum | cut -d' ' -f1)
  WANT=$(md5sum <public/index.html | cut -d' ' -f1)
  [ "$LIVE" = "$WANT" ] && { echo "OK  production serves $LOCAL"; exit 0; }
  sleep 4
done
echo "!! production did not match public/index.html after 40s"; exit 1
