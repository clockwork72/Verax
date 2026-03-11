#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SSH_HOST="${SCRAPER_SSH_HOST:-toubkal}"
REMOTE_ROOT="${SCRAPER_REMOTE_ROOT:-/srv/lustre01/project/vr_outsec-vh2sz1t4fks/users/soufiane.essahli/scraper}"
REMOTE_REPO="${SCRAPER_REPO_ROOT:-${REMOTE_ROOT}/repo}"
SERVICE_PORT="${SCRAPER_SERVICE_PORT:-8910}"
SBATCH_EXPORTS="SCRAPER_REMOTE_ROOT=${REMOTE_ROOT},SCRAPER_REPO_ROOT=${REMOTE_REPO},SCRAPER_RUNTIME_ROOT=${REMOTE_ROOT}/runtime,SCRAPER_OUTPUTS_ROOT=${REMOTE_REPO}/outputs,SCRAPER_PYTHON=${REMOTE_ROOT}/.venv/bin/python,SCRAPER_SERVICE_PORT=${SERVICE_PORT}"
SYNC_DIRS=(
  "privacy_research_dataset"
  "scripts"
  "hpc"
)
SYNC_FILES=(
  "README.md"
  "pyproject.toml"
  "tracker_radar_index.json"
  "trackerdb_index.json"
)
REMOTE_PRUNE_DIRS=(
  "dashboard"
  "tests"
  "tracker-radar"
  "trackerdb"
  "privacy_research_dataset.egg-info"
)
REMOTE_PRUNE_FILES=(
  "package-lock.json"
  "outputsresults.jsonl"
)

remote_root_q="$(printf '%q' "${REMOTE_ROOT}")"
remote_repo_q="$(printf '%q' "${REMOTE_REPO}")"

ssh "${SSH_HOST}" "bash -lc 'mkdir -p ${remote_repo_q} ${remote_root_q}/logs ${remote_root_q}/runtime ${remote_repo_q}/outputs'"

for dir in "${SYNC_DIRS[@]}"; do
  rsync -az --delete \
    --exclude '__pycache__' \
    --exclude '*.pyc' \
    "${ROOT_DIR}/${dir}/" "${SSH_HOST}:${REMOTE_REPO}/${dir}/"
done

for file in "${SYNC_FILES[@]}"; do
  rsync -az "${ROOT_DIR}/${file}" "${SSH_HOST}:${REMOTE_REPO}/${file}"
done

prune_cmd="set -euo pipefail"
for dir in "${REMOTE_PRUNE_DIRS[@]}"; do
  prune_cmd="${prune_cmd}; rm -rf ${remote_repo_q}/${dir}"
done
for file in "${REMOTE_PRUNE_FILES[@]}"; do
  prune_cmd="${prune_cmd}; rm -f ${remote_repo_q}/${file}"
done

ssh "${SSH_HOST}" "bash -lc '${prune_cmd}'"

ssh "${SSH_HOST}" "bash -lc 'SCRAPER_REMOTE_ROOT=${REMOTE_ROOT} SCRAPER_REPO_ROOT=${REMOTE_REPO} ${REMOTE_REPO}/hpc/scraper/install_remote.sh'"

JOB_ID="$(ssh "${SSH_HOST}" "bash -lc 'sbatch --parsable --export=${SBATCH_EXPORTS} ${REMOTE_REPO}/hpc/scraper/orchestrator.slurm'")"
echo "Submitted orchestrator job ${JOB_ID}"

NODE=""
for _ in $(seq 1 60); do
  STATE_NODE="$(ssh "${SSH_HOST}" "bash -lc 'squeue -j ${JOB_ID} -h -o \"%T|%N\"'")"
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
exec ssh -t -L "${SERVICE_PORT}:localhost:${SERVICE_PORT}" "${SSH_HOST}" \
  ssh -N -L "${SERVICE_PORT}:localhost:${SERVICE_PORT}" "${NODE}"
