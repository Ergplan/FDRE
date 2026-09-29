#!/usr/bin/env bash
# Install or update the FDRE dashboard on a Debian/Ubuntu VM (e.g. GCE "tariff-order").
# Serves the React build and FastAPI backend on port 80 through nginx. No login.
#
# Usage, from the root of a checkout of this repository on the VM:
#   sudo bash deploy/gce/install.sh
# Re-run after `git pull` to update.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_USER="${SUDO_USER:-$(whoami)}"
PORT="${FDRE_PORT:-8000}"

if [[ $EUID -ne 0 ]]; then echo "Run with sudo." >&2; exit 1; fi
echo "==> Installing into $APP_DIR (service user: $APP_USER)"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y python3 python3-venv python3-pip nginx git curl ca-certificates

# Node 20 LTS for the Vite build (distro packages are often too old)
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Python environment"
sudo -u "$APP_USER" python3 -m venv "$APP_DIR/.venv"
sudo -u "$APP_USER" "$APP_DIR/.venv/bin/pip" install --upgrade pip
sudo -u "$APP_USER" "$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"

echo "==> Building the React app"
cd "$APP_DIR/react_demo"
sudo -u "$APP_USER" npm ci --no-audit --no-fund
sudo -u "$APP_USER" npm run build

echo "==> systemd service"
cat > /etc/systemd/system/fdre.service <<UNIT
[Unit]
Description=FDRE dashboard (FastAPI + React build)
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR/react_demo
ExecStart=$APP_DIR/.venv/bin/python -m uvicorn backend.api:app --host 127.0.0.1 --port $PORT --workers 2
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

echo "==> nginx (port 80, no authentication)"
cat > /etc/nginx/sites-available/fdre <<NGINX
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    client_max_body_size 200m;
    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 600s;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/fdre /etc/nginx/sites-enabled/fdre
rm -f /etc/nginx/sites-enabled/default
nginx -t

systemctl daemon-reload
systemctl enable --now fdre
systemctl restart fdre nginx

for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1/" >/dev/null; then break; fi
  sleep 2
done
curl -fsS -o /dev/null -w "==> http://127.0.0.1/ -> HTTP %{http_code}\n" http://127.0.0.1/
echo "==> Done. Open http://<VM external IP>/ (port 80 must be allowed by the firewall)."
