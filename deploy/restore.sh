#!/usr/bin/env sh
# Restore a backup folder made by backup.sh into an EMPTY database and an empty object store.
# Usage: deploy/restore.sh <backup-dir> <target DATABASE_URL (plain postgresql://)> <target DATA_DIR>
# Verifies the checksums first; refuses a non-empty target database.
set -eu
SRC=${1:?backup directory}; DB=${2:?target database url}; DIR=${3:?target data dir}
(cd "$SRC" && sha256sum -c SHA256SUMS >/dev/null)
TABLES=$(psql "$DB" -Atc "select count(*) from pg_tables where schemaname='public'")
[ "$TABLES" = "0" ] || { echo "target database is not empty ($TABLES tables); refusing" >&2; exit 2; }
pg_restore --no-owner --exit-on-error --dbname "$DB" "$SRC/db.dump"
mkdir -p "$DIR" && tar -C "$DIR" -xzf "$SRC/objectstore.tar.gz"
echo "restored $(psql "$DB" -Atc "select count(*) from pg_tables where schemaname='public'") tables and $(find "$DIR" -type f | wc -l) objects"
