#!/bin/bash
set -euo pipefail

SERVICE_PORT="${SCRAPER_SERVICE_PORT:-8910}"
HEALTH_URL="http://127.0.0.1:${SERVICE_PORT}/health"
STATUS_URL="http://127.0.0.1:${SERVICE_PORT}/api/status"
STATS_URL="http://127.0.0.1:${SERVICE_PORT}/api/annotation-stats?outDir=outputs/unified"
SSH_HOST="${SCRAPER_SSH_HOST:-toubkal}"
SSH_SOCKET="${SCRAPER_SSH_SOCKET:-/tmp/scraper-ssh-${USER}.sock}"
SSH_OPTS=(
  -o ControlMaster=auto
  -o ControlPersist=10m
  -o "ControlPath=${SSH_SOCKET}"
)

echo "[1/5] Bridge health"
curl -fsS "${HEALTH_URL}" | python3 -m json.tool

echo "[2/5] Service status"
curl -fsS "${STATUS_URL}" | python3 -m json.tool

echo "[3/5] Annotation stats snapshot"
curl -fsS "${STATS_URL}" | python3 -c 'import json,sys; payload=json.load(sys.stdin); print(json.dumps({"ok": payload.get("ok"), "total_sites": payload.get("total_sites"), "annotated_sites": payload.get("annotated_sites"), "total_statements": payload.get("total_statements")}, indent=2))'

echo "[4/5] Bridge script diagnostics"
bash "$(dirname "$0")/check_bridge.sh"

echo "[5/5] Slurm job snapshot"
ssh "${SSH_OPTS[@]}" "${SSH_HOST}" 'squeue -u "$USER" -o "%.10i %.10T %.20j %.25N"'
