#!/bin/bash
set -euo pipefail

SSH_HOST="${SCRAPER_SSH_HOST:-toubkal}"
SERVICE_PORT="${SCRAPER_SERVICE_PORT:-8910}"
JOB_NAME="${SCRAPER_ORCH_JOB_NAME:-scraper-orch}"
HEALTH_URL="http://127.0.0.1:${SERVICE_PORT}/health"

list_local_tunnels() {
  ps -eo pid=,args= | awk -v port="${SERVICE_PORT}" '
    index($0, "ssh") && index($0, "-L " port ":") { print }
  '
}

extract_target() {
  sed -n "s/.*-L ${SERVICE_PORT}:\\([^: ]*\\):${SERVICE_PORT}.*/\\1/p"
}

echo "Local port ${SERVICE_PORT}:"
ss -ltnp "( sport = :${SERVICE_PORT} )" || true
echo

echo "Local SSH tunnel processes:"
LOCAL_TUNNELS="$(list_local_tunnels || true)"
if [ -n "${LOCAL_TUNNELS}" ]; then
  printf '%s\n' "${LOCAL_TUNNELS}"
else
  echo "(none)"
fi
echo

echo "Local bridge health:"
if curl -fsS --max-time 5 "${HEALTH_URL}"; then
  echo
  echo "Bridge health is good."
else
  echo
  echo "Bridge health probe failed."
fi
echo

LOCAL_TARGET="$(printf '%s\n' "${LOCAL_TUNNELS}" | extract_target | head -n 1 || true)"
if [ -n "${LOCAL_TARGET}" ]; then
  echo "Local tunnel target node: ${LOCAL_TARGET}"
else
  echo "Local tunnel target node: unknown"
fi

set +e
REMOTE_NODE="$(ssh "${SSH_HOST}" "bash -lc 'squeue -u \"\$USER\" -h -o \"%i|%T|%j|%N\" | sort -t\"|\" -k1,1nr | awk -F\"|\" '\''\$2 == \"RUNNING\" && \$3 == \"${JOB_NAME}\" && \$4 != \"(null)\" { print \$4; exit }'\'''" 2>/dev/null)"
SSH_STATUS=$?
set -e

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

if curl -fsS --max-time 5 "${HEALTH_URL}" >/dev/null 2>&1; then
  exit 0
fi

exit 1
