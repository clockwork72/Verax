#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SSH_HOST="${SCRAPER_SSH_HOST:-toubkal}"
REMOTE_ROOT="${SCRAPER_REMOTE_ROOT:-/srv/lustre01/project/vr_outsec-vh2sz1t4fks/users/soufiane.essahli/scraper}"
REMOTE_REPO="${SCRAPER_REPO_ROOT:-${REMOTE_ROOT}/repo}"
SERVICE_PORT="${SCRAPER_SERVICE_PORT:-8910}"
JOB_NAME="${SCRAPER_ORCH_JOB_NAME:-scraper-orch}"
SOURCE_REV="$(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
SBATCH_EXPORTS="SCRAPER_REMOTE_ROOT=${REMOTE_ROOT},SCRAPER_REPO_ROOT=${REMOTE_REPO},SCRAPER_RUNTIME_ROOT=${REMOTE_ROOT}/runtime,SCRAPER_OUTPUTS_ROOT=${REMOTE_REPO}/outputs,SCRAPER_PYTHON=${REMOTE_ROOT}/.venv/bin/python,SCRAPER_SERVICE_PORT=${SERVICE_PORT},SCRAPER_SOURCE_REV=${SOURCE_REV}"
SSH_SOCKET="${SCRAPER_SSH_SOCKET:-/tmp/scraper-ssh-${USER}.sock}"
SSH_OPTS=(
  -o ControlMaster=auto
  -o ControlPersist=10m
  -o "ControlPath=${SSH_SOCKET}"
)

discover_remote_model_node() {
  ssh "${SSH_OPTS[@]}" "${SSH_HOST}" "bash -lc '
    squeue -u \"\$USER\" -h -o \"%i|%T|%j|%N\" \
      | sort -t\"|\" -k1,1nr \
      | awk -F\"|\" '\''\$2 == \"RUNNING\" && \$4 != \"(null)\" && \$3 != \"scraper-orch\" { print \$4 }'\'' \
      | while read -r node; do
          [ -n \"\$node\" ] || continue
          if curl -fsS --max-time 2 \"http://\${node}:8901/health\" >/dev/null 2>&1; then
            echo \"\$node\"
            break
          fi
        done
  '"
}

retire_other_orchestrators() {
  local current_job_id="$1"
  local other_jobs=""
  other_jobs="$(ssh "${SSH_OPTS[@]}" "${SSH_HOST}" "bash -lc '
    squeue -u \"\$USER\" -h -o \"%i|%j\" \
      | awk -F\"|\" '\''\$2 == \"${JOB_NAME}\" && \$1 != \"${current_job_id}\" { print \$1 }'\''
  '" || true)"
  if [ -z "${other_jobs}" ]; then
    return 0
  fi
  echo "Stopping older ${JOB_NAME} job(s): ${other_jobs//$'\n'/ }"
  ssh "${SSH_OPTS[@]}" "${SSH_HOST}" "bash -lc 'scancel ${other_jobs//$'\n'/ }'"
}

if ssh "${SSH_OPTS[@]}" -O check "${SSH_HOST}" >/dev/null 2>&1; then
  :
else
  ssh "${SSH_OPTS[@]}" -MNf "${SSH_HOST}"
fi

"${ROOT_DIR}/hpc/scraper/push_code.sh"
ssh "${SSH_OPTS[@]}" "${SSH_HOST}" "bash -lc 'SCRAPER_REMOTE_ROOT=${REMOTE_ROOT} SCRAPER_REPO_ROOT=${REMOTE_REPO} ${REMOTE_REPO}/hpc/scraper/install_remote.sh'"

if [ -z "${SCRAPER_LLM_BASE_URL:-}" ] || [ -z "${SCRAPER_LLM_HEALTH_URL:-}" ]; then
  MODEL_NODE="$(discover_remote_model_node || true)"
  if [ -n "${MODEL_NODE}" ]; then
    SCRAPER_LLM_BASE_URL="${SCRAPER_LLM_BASE_URL:-http://${MODEL_NODE}:8901/v1}"
    SCRAPER_LLM_HEALTH_URL="${SCRAPER_LLM_HEALTH_URL:-http://${MODEL_NODE}:8901/health}"
    echo "Detected annotation model endpoint on ${MODEL_NODE}:8901"
  fi
fi
if [ -n "${SCRAPER_LLM_BASE_URL:-}" ]; then
  SBATCH_EXPORTS="${SBATCH_EXPORTS},PRIVACY_LLM_BASE_URL=${SCRAPER_LLM_BASE_URL}"
fi
if [ -n "${SCRAPER_LLM_HEALTH_URL:-}" ]; then
  SBATCH_EXPORTS="${SBATCH_EXPORTS},PRIVACY_LLM_HEALTH_URL=${SCRAPER_LLM_HEALTH_URL}"
fi

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
  echo "Unable to resolve compute node for job ${JOB_ID}" >&2
  exit 1
fi

retire_other_orchestrators "${JOB_ID}"

echo "Service node: ${NODE}"
"${ROOT_DIR}/hpc/scraper/attach_tunnel.sh" "${NODE}"
echo "Remote refresh complete."
