#!/usr/bin/env bash
# Update the running backend. Safe to run again and again.
#
#   cd ~/abhicabs_backend && bash deploy/deploy.sh            # deploys the current branch
#   bash deploy/deploy.sh main                                 # or name the branch
#
# Order matters: the database is updated BEFORE the app restarts, and if the update fails
# the script stops and the old version keeps running.
set -euo pipefail

cd "$(dirname "$0")/.."

BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"

echo "==> Pulling ${BRANCH}"
git fetch --all --prune
git checkout "${BRANCH}"
git pull --ff-only origin "${BRANCH}"

echo "==> Installing packages (the Prisma tool is needed on the server, so dev packages stay)"
npm ci

echo "==> Generating the database client"
npx prisma generate

echo "==> Updating the database (migrations)"
npx prisma migrate deploy

echo "==> Restarting the app (web + worker)"
pm2 startOrReload ecosystem.config.js --update-env
pm2 save

echo "==> Health check"
PORT_VALUE="$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"' | tr -d "'" || true)"
PORT_VALUE="${PORT_VALUE:-5000}"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:${PORT_VALUE}/health" >/dev/null 2>&1; then
    echo "OK: the backend is answering on port ${PORT_VALUE}"
    pm2 status
    exit 0
  fi
  sleep 3
done
echo "The backend did not answer. Look at:  pm2 logs abhicabs-web --lines 100"
exit 1
