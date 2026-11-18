#!/bin/sh
# Daily consistent backup of the market database (run from cron). Keeps 14 days.
#
# The database holds secrets: the micro-task answers, the fake disputes' verdicts and the keys of
# the one-off identities behind control missions. Backups are therefore readable by their owner only,
# and encrypted with age (https://age-encryption.org) when BACKUP_AGE_RECIPIENT is set. Set it, and
# keep the matching identity off this server.
set -eu
umask 077
DB=${TROQO_DB:-/var/www/troqo/data/troqo.db}
DEST=${BACKUP_DIR:-/var/www/troqo/backups}
OUT="$DEST/troqo-$(date +%F).db"
mkdir -p "$DEST"
chmod 700 "$DEST"
rm -f "$OUT"
node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(process.argv[1]).exec(\"VACUUM INTO '\"+process.argv[2]+\"'\")" "$DB" "$OUT"
chmod 600 "$OUT"
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  age -r "$BACKUP_AGE_RECIPIENT" -o "$OUT.age" "$OUT"
  rm -f "$OUT"
else
  echo "backup.sh: BACKUP_AGE_RECIPIENT not set, $OUT is NOT encrypted" >&2
fi
find "$DEST" -name 'troqo-*.db*' -mtime +14 -delete
