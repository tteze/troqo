#!/usr/bin/env bash
# Exécuté sur le VPS (utilisateur deploy) par le workflow de déploiement.
# Entrée : RELEASE (sha) et TARGET (/var/www/troqo). La release est déjà copiée dans $TARGET/releases/$RELEASE.
# La base (TARGET/data/troqo.db) se migre seule au démarrage du serveur.
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

cd "$TARGET"
NEW="$TARGET/releases/$RELEASE"
PREVIOUS="$(readlink -f current 2>/dev/null || true)"
mkdir -p "$TARGET/data" && chmod 700 "$TARGET/data"

# 1. Sauvegarde avant bascule (la nouvelle version peut migrer la base).
if [ -f "$TARGET/data/troqo.db" ]; then
  TROQO_DB="$TARGET/data/troqo.db" BACKUP_DIR="$TARGET/backups" sh "$NEW/deploy/backup.sh" || echo "Sauvegarde avant déploiement en échec" >&2
fi

# 2. Bascule atomique du lien current, puis rechargement PM2 (application troqo-server uniquement).
ln -sfn "$NEW" "$TARGET/current.tmp" && mv -Tf "$TARGET/current.tmp" "$TARGET/current"
cp "$NEW/ecosystem.config.cjs" "$TARGET/ecosystem.config.cjs"
pm2 startOrReload "$TARGET/ecosystem.config.cjs" --update-env
pm2 save

# 3. Vérification ; en cas d'échec, retour à la release précédente.
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3200/health >/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done

if [ "$healthy" -ne 1 ]; then
  echo "Release $RELEASE en échec de santé." >&2
  if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$NEW" ]; then
    echo "Retour à $PREVIOUS" >&2
    ln -sfn "$PREVIOUS" "$TARGET/current.tmp" && mv -Tf "$TARGET/current.tmp" "$TARGET/current"
    cp "$PREVIOUS/ecosystem.config.cjs" "$TARGET/ecosystem.config.cjs"
    pm2 startOrReload "$TARGET/ecosystem.config.cjs" --update-env
  fi
  exit 1
fi

# 4. On garde les 3 dernières releases.
ls -1dt "$TARGET"/releases/*/ | tail -n +4 | xargs -r rm -rf

echo "Release $RELEASE en ligne."
