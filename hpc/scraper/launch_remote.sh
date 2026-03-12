#!/bin/bash
# Submit a new orchestrator job, push current code, and open a foreground
# SSH tunnel to the allocated compute node. Blocks until the tunnel exits.
# Use refresh_remote.sh to redeploy without blocking, or attach_tunnel.sh
# to reattach to a running orchestrator without redeploying.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=_deploy_common.sh
source "${ROOT_DIR}/hpc/scraper/_deploy_common.sh"

cleanup() {
  ssh "${SSH_OPTS[@]}" -O exit "${SSH_HOST}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

ssh "${SSH_OPTS[@]}" -MNf "${SSH_HOST}"
deploy_remote
detect_and_export_model_node

NODE="$(submit_and_wait)"
echo "Service node: ${NODE}"
echo "Reattach later with: ${ROOT_DIR}/hpc/scraper/attach_tunnel.sh ${NODE}"
echo "Opening local tunnel on port ${SERVICE_PORT}"
exec ssh "${SSH_OPTS[@]}" -t -L "${SERVICE_PORT}:localhost:${SERVICE_PORT}" "${SSH_HOST}" \
  ssh -N -L "${SERVICE_PORT}:localhost:${SERVICE_PORT}" "${NODE}"
