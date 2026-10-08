#!/usr/bin/env bash
# Update a running fdre-dashboard deployment WITHOUT sudo (needs docker-group membership).
# Safe on a shared VM: touches only the fdre-dashboard containers, keeps the current
# published port, database password and session secret (read from the running containers,
# so a root-only .env is fine), and backs up the database first.
#
#   cd ~/fdre && bash deploy/update.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

docker inspect fdre-dashboard-web-1 >/dev/null 2>&1 || { echo "fdre-dashboard-web-1 is not running; use deploy/gce/install.sh for a first install." >&2; exit 1; }

envof() { docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n "s/^$2=//p"; }
export POSTGRES_PASSWORD="$(envof fdre-dashboard-db-1 POSTGRES_PASSWORD)"
export SESSION_SECRET="$(envof fdre-dashboard-web-1 SESSION_SECRET)"
export COOKIE_SECURE="$(envof fdre-dashboard-web-1 COOKIE_SECURE)"
export WEB_PORT="$(docker port fdre-dashboard-web-1 3000/tcp | head -1 | sed 's/.*://')"
# Tender reading model key: one given for this run wins (set it once, e.g.
#   read -rs ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY && bash deploy/update.sh
# ), otherwise the running engine's key is kept. Never put the key in the repository.
# ANTHROPIC_API_KEY=none removes the key (back to rules reading).
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-$(envof fdre-dashboard-engine-1 ANTHROPIC_API_KEY 2>/dev/null || true)}"
[[ "$ANTHROPIC_API_KEY" == "none" ]] && export ANTHROPIC_API_KEY=""
export TENDER_INTEL_MODEL="${TENDER_INTEL_MODEL:-$(envof fdre-dashboard-engine-1 TENDER_INTEL_MODEL 2>/dev/null || true)}"
export TENDER_INTEL_REQUIRE_LLM="${TENDER_INTEL_REQUIRE_LLM:-$(envof fdre-dashboard-engine-1 TENDER_INTEL_REQUIRE_LLM 2>/dev/null || true)}"
[[ -n "$POSTGRES_PASSWORD" && -n "$SESSION_SECRET" && -n "$WEB_PORT" ]] || { echo "Could not read settings from the running containers." >&2; exit 1; }
echo "==> Current port ${WEB_PORT}; settings read from running containers; tender reading: $([[ -n "$ANTHROPIC_API_KEY" ]] && echo "model (key set)" || echo "rules (no key)")$([[ "$TENDER_INTEL_REQUIRE_LLM" == "1" ]] && echo ", rules switched off")"

mkdir -p "$HOME/fdre-backups"
backup="$HOME/fdre-backups/fdre-$(date +%Y%m%d-%H%M%S).sql.gz"
docker exec fdre-dashboard-db-1 pg_dump -U fdre -d fdre --no-owner | gzip > "$backup"
echo "==> Backup: $backup"

before="$(git rev-parse --short HEAD)"
git pull --ff-only
echo "==> Code: ${before} -> $(git rev-parse --short HEAD)"

docker compose --env-file /dev/null up -d --build --remove-orphans

for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${WEB_PORT}/api/health" >/dev/null 2>&1; then break; fi
  sleep 3
done
echo "==> Health: $(curl -s "http://127.0.0.1:${WEB_PORT}/api/health")"
docker ps --format '{{.Names}}\t{{.Ports}}\t{{.Status}}' | grep fdre-dashboard
docker logs fdre-dashboard-web-1 2>&1 | grep -i "\[db\]" | tail -3 || true
