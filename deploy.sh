#!/bin/bash
# Usage: ./deploy.sh "commit message"
set -e
cd "$(dirname "$0")"
MSG="${1:-Update}"
git add .
git commit -m "$MSG" || echo "Nothing to commit."
git push
echo "Pushed. Netlify will redeploy automatically."
