#!/bin/bash
set -euo pipefail

SSH_HOST="${SCRAPER_SSH_HOST:-toubkal}"
SERVICE_PORT="${SCRAPER_SERVICE_PORT:-8910}"
JOB_NAME="${SCRAPER_ORCH_JOB_NAME:-scraper-orch}"
HEALTH_URL="http://127.0.0.1:${SERVICE_PORT}/health"

usage() {
  cat <<'EOF'
Usage:
  hpc/scraper/attach_tunnel.sh
  hpc/scraper/attach_tunnel.sh <compute-node>

Behavior:
  - resolves the currently running scraper orchestrator node when no node is given
  - kills stale local SSH forwards on port 8910
  - opens a fresh local tunnel to the active node
EOF
}

resolve_node() {
  ssh "${SSH_HOST}" "bash -lc 'squeue -u \"\$USER\" -h -o \"%T|%j|%N\" | awk -F\"|\" '\''\$1 == \"RUNNING\" && \$2 == \"${JOB_NAME}\" && \$3 != \"(null)\" { print \$3; exit }'\'''"
}

list_local_tunnels() {
  ps -eo pid=,args= | awk -v port="${SERVICE_PORT}" '
    index($0, "ssh") && index($0, "-L " port ":") { print }
  '
}

extract_target() {
  sed -n "s/.*-L ${SERVICE_PORT}:\\([^: ]*\\):${SERVICE_PORT}.*/\\1/p"
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

NODE="${1:-}"
if [ -z "${NODE}" ]; then
  NODE="$(resolve_node)"
fi

if [ -z "${NODE}" ] || [ "${NODE}" = "(null)" ]; then
  echo "Could not resolve a running ${JOB_NAME} node on ${SSH_HOST}." >&2
  echo "Check: ssh ${SSH_HOST} 'squeue -u \$USER -o \"%.10i %.10T %.20j %.25N\"'" >&2
  exit 1
fi

CURRENT_TARGET=""
if curl -fsS --max-time 3 "${HEALTH_URL}" >/dev/null 2>&1; then
  CURRENT_TARGET="$(list_local_tunnels | extract_target | head -n 1 || true)"
  if [ -n "${CURRENT_TARGET}" ] && [ "${CURRENT_TARGET}" = "${NODE}" ]; then
    echo "Bridge already healthy on ${HEALTH_URL} via ${CURRENT_TARGET}"
    exit 0
  fi
fi

mapfile -t EXISTING_PIDS < <(list_local_tunnels | awk '{ print $1 }')
if [ "${#EXISTING_PIDS[@]}" -gt 0 ]; then
  echo "Stopping stale local tunnel(s) on port ${SERVICE_PORT}: ${EXISTING_PIDS[*]}"
  kill "${EXISTING_PIDS[@]}" >/dev/null 2>&1 || true
  sleep 1
fi

echo "Opening local tunnel on 127.0.0.1:${SERVICE_PORT} -> ${NODE}:${SERVICE_PORT} via ${SSH_HOST}"
ssh -fNT -o ExitOnForwardFailure=yes -L "${SERVICE_PORT}:${NODE}:${SERVICE_PORT}" "${SSH_HOST}"

for _ in $(seq 1 10); do
  if curl -fsS --max-time 3 "${HEALTH_URL}" >/dev/null 2>&1; then
    echo "Bridge healthy on ${HEALTH_URL}"
    exit 0
  fi
  sleep 1
done

echo "Tunnel opened to ${NODE}, but ${HEALTH_URL} is still not answering." >&2
echo "The orchestrator may still be booting, or the node is not the active service node." >&2
exit 1
