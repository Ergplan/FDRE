#!/usr/bin/env bash
# Dump the deployment's Postgres database to backups/ (gzip), keeping 14 days.
# Restore: gunzip -c backups/<file>.sql.gz | docker compose exec -T db psql -U fdre -d fdre
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p backups
file="backups/fdre-$(date +%Y%m%d-%H%M%S).sql.gz"
docker compose exec -T db pg_dump -U fdre -d fdre --no-owner | gzip > "$file"
find backups -name 'fdre-*.sql.gz' -mtime +14 -delete
echo "backup written: $file"
