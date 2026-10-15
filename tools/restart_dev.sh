#!/usr/bin/env bash
# Restart the platform API (:8000) and worker as plain background processes for development.
set -u
cd "$(dirname "$0")/.."
.venv/bin/python - <<'PY'
import os, signal
me = os.getpid()
for pid in os.listdir("/proc"):
    if not pid.isdigit() or int(pid) == me:
        continue
    try:
        cmd = open(f"/proc/{pid}/cmdline", "rb").read().replace(b"\0", b" ").decode()
    except Exception:
        continue
    if ("uvicorn fdre_platform.api.app" in cmd or "fdre_platform.worker" in cmd) and "restart_dev" not in cmd and "bash" not in cmd:
        os.kill(int(pid), signal.SIGTERM)
        print("stopped", pid, cmd[:60])
PY
sleep 1
nohup .venv/bin/python -m uvicorn fdre_platform.api.app:app --host 127.0.0.1 --port 8000 > /tmp/api.log 2>&1 &
nohup .venv/bin/python -m fdre_platform.worker > /tmp/worker.log 2>&1 &
for i in $(seq 1 30); do curl -sf http://127.0.0.1:8000/api/v1/health >/dev/null && break; sleep 1; done
curl -s http://127.0.0.1:8000/api/v1/health; echo
