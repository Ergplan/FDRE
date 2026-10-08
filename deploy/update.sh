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
# Tender reading settings: a value given for this run wins (set it once, e.g.
#   read -rs OPENAI_API_KEY && export OPENAI_API_KEY && bash deploy/update.sh
# ), otherwise the running engine's value is kept. Never put a key in the repository.
# NAME=none removes a setting, e.g. ANTHROPIC_API_KEY=none (back to rules reading without a key).
for v in OPENAI_API_KEY ANTHROPIC_API_KEY TENDER_INTEL_PROVIDER TENDER_INTEL_MODEL TENDER_INTEL_REQUIRE_LLM \
         TENDER_INTEL_REASONING_EFFORT TENDER_INTEL_MAX_OUTPUT_TOKENS; do
  val="${!v:-$(envof fdre-dashboard-engine-1 "$v" 2>/dev/null || true)}"
  [[ "$val" == "none" ]] && val=""
  export "$v=$val"
done
# The provider the engine will use: TENDER_INTEL_PROVIDER, else the first key set (Anthropic, then OpenAI).
provider="$TENDER_INTEL_PROVIDER"
if [[ -z "$provider" ]]; then
  if [[ -n "$ANTHROPIC_API_KEY" ]]; then provider=anthropic; elif [[ -n "$OPENAI_API_KEY" ]]; then provider=openai; fi
fi
case "$provider" in
  openai) [[ -n "$OPENAI_API_KEY" ]] || provider="" ;;
  anthropic) [[ -n "$ANTHROPIC_API_KEY" ]] || provider="" ;;
esac
[[ -n "$POSTGRES_PASSWORD" && -n "$SESSION_SECRET" && -n "$WEB_PORT" ]] || { echo "Could not read settings from the running containers." >&2; exit 1; }
echo "==> Current port ${WEB_PORT}; settings read from running containers; tender reading: $([[ -n "$provider" ]] && echo "model, ${provider}${TENDER_INTEL_MODEL:+ ${TENDER_INTEL_MODEL}}" || echo "rules (no model key)")$([[ "$TENDER_INTEL_REQUIRE_LLM" == "1" ]] && echo ", rules switched off")"

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
