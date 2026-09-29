#!/usr/bin/env bash
# Install or update one client deployment of the FDRE app on a Debian/Ubuntu VM:
# Postgres + Python engine + Next.js web app via Docker Compose, published on port 80.
#
#   sudo bash deploy/gce/install.sh          # from the repository root on the VM
# Re-run after `git pull` to update. Data lives in the Docker volume fdre_pgdata.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$APP_DIR"
if [[ $EUID -ne 0 ]]; then echo "Run with sudo." >&2; exit 1; fi

echo "==> Docker"
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

echo "==> Retiring the previous nginx/systemd install, if present"
if systemctl list-unit-files fdre.service >/dev/null 2>&1 && [[ -f /etc/systemd/system/fdre.service ]]; then
  systemctl disable --now fdre || true
  rm -f /etc/systemd/system/fdre.service && systemctl daemon-reload
fi
if [[ -L /etc/nginx/sites-enabled/fdre ]]; then
  rm -f /etc/nginx/sites-enabled/fdre
  if [[ -z "$(ls -A /etc/nginx/sites-enabled 2>/dev/null)" ]]; then systemctl disable --now nginx || true; else systemctl reload nginx || true; fi
fi

echo "==> Configuration (.env)"
if [[ ! -f .env ]]; then
  umask 077
  cat > .env <<ENV
POSTGRES_PASSWORD=$(openssl rand -hex 24)
SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')
WEB_PORT=${WEB_PORT:-80}
COOKIE_SECURE=false
ENV
  echo "    created .env with random secrets (keep it; the database password is inside)"
fi

echo "==> Building and starting containers"
docker compose up -d --build --remove-orphans

echo "==> Daily database backup (02:15, keeps 14 days in $APP_DIR/backups)"
cat > /etc/cron.d/fdre-backup <<CRON
15 2 * * * root cd $APP_DIR && bash deploy/backup.sh >> /var/log/fdre-backup.log 2>&1
CRON

PORT="$(grep -E '^WEB_PORT=' .env | cut -d= -f2)"; PORT="${PORT:-80}"
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then break; fi
  sleep 3
done
curl -sS "http://127.0.0.1:${PORT}/api/health" || true
echo
IP="$(curl -s -m 3 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || true)"
echo "==> Done. Open http://${IP:-<external-ip>}$( [[ "$PORT" == 80 ]] || echo ":$PORT" )/ and create the administrator account."
