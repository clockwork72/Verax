#!/bin/bash
# Push current code to the remote, submit a fresh orchestrator job, wait for
# the compute node to start, then reattach the local SSH tunnel via
# attach_tunnel.sh. Returns once the bridge is healthy. Intended for use
# from Electron (scraper:refresh-remote IPC) and non-interactive terminal.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=_deploy_common.sh
source "${ROOT_DIR}/hpc/scraper/_deploy_common.sh"

if ssh "${SSH_OPTS[@]}" -O check "${SSH_HOST}" >/dev/null 2>&1; then
  :
else
  ssh "${SSH_OPTS[@]}" -MNf "${SSH_HOST}"
fi

deploy_remote
detect_and_export_model_node

NODE="$(submit_and_wait)"
echo "Service node: ${NODE}"
"${ROOT_DIR}/hpc/scraper/attach_tunnel.sh" "${NODE}"
echo "Remote refresh complete."
