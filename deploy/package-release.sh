#!/usr/bin/env bash
# Assemble la release de production dans $1 (après npm ci, npm run build et npm run pack:site).
# Utilisé par le workflow de déploiement ; peut se lancer en local pour vérifier le paquet.
set -euo pipefail

OUT="${1:-release}"
rm -rf "$OUT"
mkdir -p "$OUT/site"

cp -r dist docs deploy package.json package-lock.json "$OUT/"
cp site/*.html site/*.css site/*.js site/*.svg site/*.png site/robots.txt site/sitemap.xml "$OUT/site/"
# Diagrams and fonts of the site (their sources, such as site/diagrams/*.mmd, stay out).
for d in diagrams fonts; do
  if [ -d "site/$d" ]; then mkdir -p "$OUT/site/$d"; find "site/$d" -maxdepth 1 -type f \( -name '*.svg' -o -name '*.woff2' -o -name '*.txt' \) -exec cp {} "$OUT/site/$d/" \;; fi
done
if [ -d site/download ]; then cp -r site/download "$OUT/site/download"; fi
# Dépendances de production uniquement.
(cd "$OUT" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
test -f "$OUT/dist/cli.js" || { echo "dist/ absent du paquet" >&2; exit 1; }

cp deploy/pm2/ecosystem.config.cjs "$OUT/ecosystem.config.cjs"
echo "${RELEASE:-local}" > "$OUT/RELEASE"
du -sh "$OUT"
