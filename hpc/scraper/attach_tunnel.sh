#!/bin/bash
set -euo pipefail

# shellcheck source=_ssh_common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_ssh_common.sh"
HEALTH_URL="http://127.0.0.1:${SERVICE_PORT}/health"
require_scraper_ssh_host

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
  ssh "${SSH_OPTS[@]}" "${SSH_HOST}" "bash -lc 'squeue -u \"\$USER\" -h -o \"%i|%T|%j|%N\" | sort -t\"|\" -k1,1nr | awk -F\"|\" '\''\$2 == \"RUNNING\" && \$3 == \"${JOB_NAME}\" && \$4 != \"(null)\" { print \$4; exit }'\'''"
}

list_local_tunnels() {
  ps -eo pid=,args= | awk -v port="${SERVICE_PORT}" '
    index($0, "ssh") && index($0, "-L " port ":") { print }
  '
}

extract_target() {
  sed -n "s/.*-L ${SERVICE_PORT}:\\([^: ]*\\):${SERVICE_PORT}.*/\\1/p"
}

current_target() {
  if [ -f "${FORWARD_STATE}" ]; then
    awk 'NF { value=$0 } END { gsub(/[[:space:]]+/, "", value); print value }' "${FORWARD_STATE}"
    return 0
  fi
  list_local_tunnels | extract_target | head -n 1 || true
}

local_port_listening() {
  ss -ltn "( sport = :${SERVICE_PORT} )" 2>/dev/null | grep -q LISTEN
}

cancel_forward() {
  local target="$1"
  [ -n "${target}" ] || return 0
  ssh "${SSH_OPTS[@]}" -O cancel -L "${SERVICE_PORT}:${target}:${SERVICE_PORT}" "${SSH_HOST}" >/dev/null 2>&1 || true
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if ssh "${SSH_OPTS[@]}" -O check "${SSH_HOST}" >/dev/null 2>&1; then
  :
else
  ssh "${SSH_OPTS[@]}" -MNf "${SSH_HOST}"
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
  CURRENT_TARGET="$(current_target)"
  if [ -n "${CURRENT_TARGET}" ] && [ "${CURRENT_TARGET}" = "${NODE}" ]; then
    echo "Bridge already healthy on ${HEALTH_URL} via ${CURRENT_TARGET}"
    exit 0
  fi
else
  CURRENT_TARGET="$(current_target)"
fi

mapfile -t EXISTING_PIDS < <(list_local_tunnels | awk '{ print $1 }')
if [ "${#EXISTING_PIDS[@]}" -gt 0 ]; then
  echo "Stopping stale local tunnel(s) on port ${SERVICE_PORT}: ${EXISTING_PIDS[*]}"
  kill "${EXISTING_PIDS[@]}" >/dev/null 2>&1 || true
  sleep 1
fi

if [ -n "${CURRENT_TARGET}" ] && [ "${CURRENT_TARGET}" != "${NODE}" ]; then
  cancel_forward "${CURRENT_TARGET}"
fi

echo "Opening local tunnel on 127.0.0.1:${SERVICE_PORT} -> ${NODE}:${SERVICE_PORT} via ${SSH_HOST}"
if ! ssh "${SSH_OPTS[@]}" -O forward -L "${SERVICE_PORT}:${NODE}:${SERVICE_PORT}" "${SSH_HOST}"; then
  if local_port_listening; then
    echo "Resetting SSH master to clear stale port ${SERVICE_PORT} forward"
    ssh "${SSH_OPTS[@]}" -O exit "${SSH_HOST}" >/dev/null 2>&1 || true
    rm -f "${FORWARD_STATE}"
    ssh "${SSH_OPTS[@]}" -MNf "${SSH_HOST}"
    ssh "${SSH_OPTS[@]}" -O forward -L "${SERVICE_PORT}:${NODE}:${SERVICE_PORT}" "${SSH_HOST}"
  else
    exit 1
  fi
fi
printf '%s\n' "${NODE}" > "${FORWARD_STATE}"

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
