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
