#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SSH_HOST="${SCRAPER_SSH_HOST:-toubkal}"
REMOTE_ROOT="${SCRAPER_REMOTE_ROOT:-/srv/lustre01/project/vr_outsec-vh2sz1t4fks/users/soufiane.essahli/scraper}"
REMOTE_REPO="${SCRAPER_REPO_ROOT:-${REMOTE_ROOT}/repo}"
SERVICE_PORT="${SCRAPER_SERVICE_PORT:-8910}"
SBATCH_EXPORTS="SCRAPER_REMOTE_ROOT=${REMOTE_ROOT},SCRAPER_REPO_ROOT=${REMOTE_REPO},SCRAPER_RUNTIME_ROOT=${REMOTE_ROOT}/runtime,SCRAPER_OUTPUTS_ROOT=${REMOTE_REPO}/outputs,SCRAPER_PYTHON=${REMOTE_ROOT}/.venv/bin/python,SCRAPER_SERVICE_PORT=${SERVICE_PORT}"
SSH_SOCKET="${SCRAPER_SSH_SOCKET:-/tmp/scraper-ssh-${USER}.sock}"
SSH_OPTS=(
  -o ControlMaster=auto
  -o ControlPersist=10m
  -o "ControlPath=${SSH_SOCKET}"
)

cleanup() {
  ssh "${SSH_OPTS[@]}" -O exit "${SSH_HOST}" >/dev/null 2>&1 || true
}

trap cleanup EXIT

ssh "${SSH_OPTS[@]}" -MNf "${SSH_HOST}"
"${ROOT_DIR}/hpc/scraper/push_code.sh"

ssh "${SSH_OPTS[@]}" "${SSH_HOST}" "bash -lc 'SCRAPER_REMOTE_ROOT=${REMOTE_ROOT} SCRAPER_REPO_ROOT=${REMOTE_REPO} ${REMOTE_REPO}/hpc/scraper/install_remote.sh'"

JOB_ID="$(ssh "${SSH_OPTS[@]}" "${SSH_HOST}" "bash -lc 'sbatch --parsable --export=${SBATCH_EXPORTS} ${REMOTE_REPO}/hpc/scraper/orchestrator.slurm'")"
echo "Submitted orchestrator job ${JOB_ID}"

NODE=""
for _ in $(seq 1 60); do
  STATE_NODE="$(ssh "${SSH_OPTS[@]}" "${SSH_HOST}" "bash -lc 'squeue -j ${JOB_ID} -h -o \"%T|%N\"'")"
  STATE="${STATE_NODE%%|*}"
  NODE="${STATE_NODE#*|}"
  if [ "${STATE}" = "RUNNING" ] && [ -n "${NODE}" ] && [ "${NODE}" != "(null)" ]; then
    break
  fi
  sleep 5
done

if [ -z "${NODE}" ] || [ "${NODE}" = "(null)" ]; then
  echo "Unable to resolve compute node for job ${JOB_ID}"
  exit 1
fi

echo "Service node: ${NODE}"
echo "Opening local tunnel on port ${SERVICE_PORT}"
exec ssh "${SSH_OPTS[@]}" -t -L "${SERVICE_PORT}:localhost:${SERVICE_PORT}" "${SSH_HOST}" \
  ssh -N -L "${SERVICE_PORT}:localhost:${SERVICE_PORT}" "${NODE}"
