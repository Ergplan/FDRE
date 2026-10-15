#!/usr/bin/env sh
# Consistent backup: a custom-format pg_dump of the platform database and a tar of the object
# store (documents, run artifacts, workbooks, DPR exports), both with sha256 sums, in a
# timestamped folder. Usage: deploy/backup.sh <target-dir>   (env: DATABASE_URL, DATA_DIR)
set -eu
TARGET=${1:?target directory}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$TARGET/fdre-$STAMP"
mkdir -p "$OUT"
pg_dump --format=custom --no-owner --file "$OUT/db.dump" "${DATABASE_URL:?DATABASE_URL}"
tar -C "${DATA_DIR:?DATA_DIR}" -czf "$OUT/objectstore.tar.gz" .
(cd "$OUT" && sha256sum db.dump objectstore.tar.gz > SHA256SUMS)
printf '%s\n' "database: $(pg_dump --version | head -1)" "created: $STAMP" "data_dir: $DATA_DIR" > "$OUT/MANIFEST"
echo "$OUT"
