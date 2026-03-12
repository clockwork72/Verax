#!/bin/bash
set -euo pipefail

SSH_HOST="${SCRAPER_SSH_HOST:-toubkal}"
SERVICE_PORT="${SCRAPER_SERVICE_PORT:-8910}"
JOB_NAME="${SCRAPER_ORCH_JOB_NAME:-scraper-orch}"
HEALTH_URL="http://127.0.0.1:${SERVICE_PORT}/health"
SSH_SOCKET="${SCRAPER_SSH_SOCKET:-/tmp/scraper-ssh-${USER}.sock}"
FORWARD_STATE="${SCRAPER_SSH_FORWARD_STATE:-/tmp/scraper-ssh-forward-${USER}-${SERVICE_PORT}.target}"
SSH_OPTS=(
  -o ControlMaster=auto
  -o ControlPersist=10m
  -o "ControlPath=${SSH_SOCKET}"
)
JSON_MODE=0

if [ "${1:-}" = "--json" ]; then
  JSON_MODE=1
fi

list_local_tunnels() {
  ps -eo pid=,args= | awk -v port="${SERVICE_PORT}" '
    index($0, "ssh") && index($0, "-L " port ":") { print }
  '
}

extract_target() {
  sed -n "s/.*-L ${SERVICE_PORT}:\\([^: ]*\\):${SERVICE_PORT}.*/\\1/p"
}

LOCAL_TUNNELS="$(list_local_tunnels || true)"
HEALTH_RAW=""
HEALTH_OK=0
if HEALTH_RAW="$(curl -fsS --max-time 5 "${HEALTH_URL}" 2>/dev/null)"; then
  HEALTH_OK=1
fi

LOCAL_TARGET="$(printf '%s\n' "${LOCAL_TUNNELS}" | extract_target | head -n 1 || true)"
if [ -z "${LOCAL_TARGET}" ] && [ -f "${FORWARD_STATE}" ]; then
  LOCAL_TARGET="$(head -n 1 "${FORWARD_STATE}" | tr -d '[:space:]')"
fi

set +e
REMOTE_NODE="$(ssh "${SSH_OPTS[@]}" "${SSH_HOST}" "bash -lc 'squeue -u \"\$USER\" -h -o \"%i|%T|%j|%N\" | sort -t\"|\" -k1,1nr | awk -F\"|\" '\''\$2 == \"RUNNING\" && \$3 == \"${JOB_NAME}\" && \$4 != \"(null)\" { print \$4; exit }'\'''" 2>/dev/null)"
SSH_STATUS=$?
set -e

if [ "${JSON_MODE}" -eq 1 ]; then
  python3 - <<PY
import json
print(json.dumps({
    "service_port": ${SERVICE_PORT},
    "health_ok": bool(${HEALTH_OK}),
    "health_raw": ${HEALTH_RAW@Q},
    "local_target": ${LOCAL_TARGET@Q} or None,
    "remote_node": ${REMOTE_NODE@Q} or None,
    "ssh_status": ${SSH_STATUS},
    "local_tunnels": ${LOCAL_TUNNELS@Q}.splitlines() if ${LOCAL_TUNNELS@Q} else [],
}))
PY
  if [ "${HEALTH_OK}" -eq 1 ]; then
    exit 0
  fi
  exit 1
fi

echo "Local port ${SERVICE_PORT}:"
ss -ltnp "( sport = :${SERVICE_PORT} )" || true
echo

echo "Local SSH tunnel processes:"
if [ -n "${LOCAL_TUNNELS}" ]; then
  printf '%s\n' "${LOCAL_TUNNELS}"
else
  echo "(none)"
fi
echo

echo "Local bridge health:"
if [ "${HEALTH_OK}" -eq 1 ]; then
  printf '%s\n' "${HEALTH_RAW}"
  echo "Bridge health is good."
else
  echo "Bridge health probe failed."
fi
echo

if [ -n "${LOCAL_TARGET}" ]; then
  echo "Local tunnel target node: ${LOCAL_TARGET}"
else
  echo "Local tunnel target node: unknown"
fi

if [ "${SSH_STATUS}" -eq 0 ] && [ -n "${REMOTE_NODE}" ]; then
  echo "Running orchestrator node: ${REMOTE_NODE}"
  if [ -n "${LOCAL_TARGET}" ] && [ "${LOCAL_TARGET}" != "${REMOTE_NODE}" ]; then
    echo "Status: stale tunnel target"
    echo "Fix: hpc/scraper/attach_tunnel.sh"
    exit 1
  fi
else
  echo "Running orchestrator node: unavailable"
  echo "Run manually if needed: ssh ${SSH_HOST} 'squeue -u \$USER -o \"%.10i %.10T %.20j %.25N\"'"
fi

if [ "${HEALTH_OK}" -eq 1 ]; then
  exit 0
fi

exit 1
