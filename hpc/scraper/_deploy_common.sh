#!/bin/bash
# Shared setup for launch_remote.sh and refresh_remote.sh.
# Source this file after ROOT_DIR is set; it exports all deployment variables
# and defines discover_remote_model_node and retire_other_orchestrators.
# Not intended to be executed directly.

# shellcheck source=_config_common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config_common.sh"

REMOTE_ROOT="${SCRAPER_REMOTE_ROOT:-/path/to/your/hpc/scraper}"
REMOTE_REPO="${SCRAPER_REPO_ROOT:-${REMOTE_ROOT}/repo}"
# shellcheck source=_ssh_common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_ssh_common.sh"
require_scraper_ssh_host
SOURCE_REV="$(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
SBATCH_EXPORTS="SCRAPER_REMOTE_ROOT=${REMOTE_ROOT},SCRAPER_REPO_ROOT=${REMOTE_REPO},SCRAPER_RUNTIME_ROOT=${REMOTE_ROOT}/runtime,SCRAPER_OUTPUTS_ROOT=${REMOTE_REPO}/outputs,SCRAPER_PYTHON=${REMOTE_ROOT}/.venv/bin/python,SCRAPER_SERVICE_PORT=${SERVICE_PORT},SCRAPER_SOURCE_REV=${SOURCE_REV}"
SBATCH_EXTRA_ARGS="${SCRAPER_SBATCH_EXTRA_ARGS:-}"

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
  echo "Stopping older ${JOB_NAME} job(s): ${other_jobs//$'\n'/ }" >&2
  ssh "${SSH_OPTS[@]}" "${SSH_HOST}" "bash -lc 'scancel ${other_jobs//$'\n'/ }'"
}

# Detect and export model node endpoint if not already set.
# Sets SCRAPER_LLM_BASE_URL and SCRAPER_LLM_HEALTH_URL in the calling shell
# and appends them to SBATCH_EXPORTS when found.
detect_and_export_model_node() {
  if [ -z "${SCRAPER_LLM_BASE_URL:-}" ] || [ -z "${SCRAPER_LLM_HEALTH_URL:-}" ]; then
    MODEL_NODE="$(discover_remote_model_node || true)"
    if [ -n "${MODEL_NODE}" ]; then
      SCRAPER_LLM_BASE_URL="${SCRAPER_LLM_BASE_URL:-http://${MODEL_NODE}:8901/v1}"
      SCRAPER_LLM_HEALTH_URL="${SCRAPER_LLM_HEALTH_URL:-http://${MODEL_NODE}:8901/health}"
      echo "Detected annotation model endpoint on ${MODEL_NODE}:8901" >&2
    fi
  fi
  if [ -n "${SCRAPER_LLM_BASE_URL:-}" ]; then
    SBATCH_EXPORTS="${SBATCH_EXPORTS},PRIVACY_LLM_BASE_URL=${SCRAPER_LLM_BASE_URL}"
  fi
  if [ -n "${SCRAPER_LLM_HEALTH_URL:-}" ]; then
    SBATCH_EXPORTS="${SBATCH_EXPORTS},PRIVACY_LLM_HEALTH_URL=${SCRAPER_LLM_HEALTH_URL}"
  fi
}

# Push code to the remote and run install. Requires SSH master to already be open.
deploy_remote() {
  "${ROOT_DIR}/hpc/scraper/push_code.sh"
  ssh "${SSH_OPTS[@]}" "${SSH_HOST}" "bash -lc 'SCRAPER_REMOTE_ROOT=${REMOTE_ROOT} SCRAPER_REPO_ROOT=${REMOTE_REPO} ${REMOTE_REPO}/hpc/scraper/install_remote.sh'"
}

# Submit the orchestrator job and wait for the compute node to become RUNNING.
# Prints the resolved node to stdout and cancels stale duplicate jobs.
submit_and_wait() {
  JOB_ID="$(ssh "${SSH_OPTS[@]}" "${SSH_HOST}" "bash -lc 'sbatch --parsable ${SBATCH_EXTRA_ARGS} --export=${SBATCH_EXPORTS} ${REMOTE_REPO}/hpc/scraper/orchestrator.slurm'")"
  echo "Submitted orchestrator job ${JOB_ID}" >&2

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
  echo "${NODE}"
}
