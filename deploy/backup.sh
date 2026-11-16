#!/bin/sh
# Daily consistent backup of the market database (run from cron). Keeps 14 days.
set -eu
DB=${TROQO_DB:-/var/lib/troqo/troqo-server.db}
DEST=${BACKUP_DIR:-/var/backups/troqo}
mkdir -p "$DEST"
node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(process.argv[1]).exec(\"VACUUM INTO '\"+process.argv[2]+\"'\")" "$DB" "$DEST/troqo-$(date +%F).db"
find "$DEST" -name 'troqo-*.db' -mtime +14 -delete
