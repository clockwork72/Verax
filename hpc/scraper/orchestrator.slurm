#!/bin/bash
#SBATCH --job-name=scraper-orch
#SBATCH --partition=compute
#SBATCH --nodes=1
#SBATCH --ntasks=1
# 6 concurrent site workers plus the aiohttp control plane, browser helpers,
# and JSON / artifact processing headroom.
#SBATCH --cpus-per-task=24
#SBATCH --time=20:00:00

set -euo pipefail

PLACEHOLDER_REMOTE_ROOT="/path/to/your/hpc/scraper"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

is_placeholder_path() {
  case "${1:-}" in
    ""|"${PLACEHOLDER_REMOTE_ROOT}"|${PLACEHOLDER_REMOTE_ROOT}/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

SCRAPER_REPO_ROOT="${SCRAPER_REPO_ROOT:-}"
if is_placeholder_path "${SCRAPER_REPO_ROOT}"; then
  SCRAPER_REPO_ROOT="${DEFAULT_REPO_ROOT}"
fi

SCRAPER_REMOTE_ROOT="${SCRAPER_REMOTE_ROOT:-}"
if is_placeholder_path "${SCRAPER_REMOTE_ROOT}"; then
  SCRAPER_REMOTE_ROOT="$(dirname "${SCRAPER_REPO_ROOT}")"
fi

SCRAPER_RUNTIME_ROOT="${SCRAPER_RUNTIME_ROOT:-${SCRAPER_REMOTE_ROOT}/runtime}"
SCRAPER_OUTPUTS_ROOT="${SCRAPER_OUTPUTS_ROOT:-${SCRAPER_REPO_ROOT}/outputs}"
SCRAPER_SERVICE_PORT="${SCRAPER_SERVICE_PORT:-8910}"
SCRAPER_DB_PORT="${SCRAPER_DB_PORT:-55432}"
SCRAPER_PYTHON="${SCRAPER_PYTHON:-}"
if is_placeholder_path "${SCRAPER_PYTHON}"; then
  SCRAPER_PYTHON="${SCRAPER_REMOTE_ROOT}/.venv/bin/python"
fi
SCRAPER_PLAYWRIGHT_BROWSERS="${SCRAPER_PLAYWRIGHT_BROWSERS:-${SCRAPER_RUNTIME_ROOT}/playwright-browsers}"
SCRAPER_CLUSTER_FQDN="${SCRAPER_CLUSTER_FQDN:-login.your-hpc.example}"

if [ ! -f "${SCRAPER_REPO_ROOT}/privacy_research_dataset/hpc_service.py" ]; then
  echo "Could not locate privacy_research_dataset/hpc_service.py under ${SCRAPER_REPO_ROOT}" >&2
  echo "Run this batch script from the remote repo checkout, or export SCRAPER_REPO_ROOT explicitly." >&2
  exit 1
fi

mkdir -p "${SCRAPER_REMOTE_ROOT}/logs" "${SCRAPER_RUNTIME_ROOT}" "${SCRAPER_OUTPUTS_ROOT}" "${SCRAPER_PLAYWRIGHT_BROWSERS}"

# Leave more headroom for bursts of dashboard and scraper IO without relying on
# the cluster's default per-process soft limit.
ulimit -n 4096 >/dev/null 2>&1 || true

if [ ! -x "${SCRAPER_PYTHON}" ]; then
  echo "Missing runtime python at ${SCRAPER_PYTHON}" >&2
  echo "Run ${SCRAPER_REPO_ROOT}/hpc/scraper/install_remote.sh first." >&2
  exit 1
fi

node="$(hostname -s)"
cluster_fqdn="${SCRAPER_CLUSTER_FQDN}"
user="$(whoami)"
job_id="${SLURM_JOB_ID:-manual}"

cat <<EOF
============================================================
Scraper orchestrator job
Job ID: ${job_id}
Node: ${node}
Remote root: ${SCRAPER_REMOTE_ROOT}
Repo root: ${SCRAPER_REPO_ROOT}
Outputs root: ${SCRAPER_OUTPUTS_ROOT}
Service port: ${SCRAPER_SERVICE_PORT}
Database port: ${SCRAPER_DB_PORT}
Open files limit: $(ulimit -n)

Local tunnel command:
ssh -t -L ${SCRAPER_SERVICE_PORT}:localhost:${SCRAPER_SERVICE_PORT} ${user}@${cluster_fqdn} \\
  ssh -N -L ${SCRAPER_SERVICE_PORT}:localhost:${SCRAPER_SERVICE_PORT} ${node}
============================================================
EOF

cd "${SCRAPER_REPO_ROOT}"

export PLAYWRIGHT_BROWSERS_PATH="${SCRAPER_PLAYWRIGHT_BROWSERS}"

exec "${SCRAPER_PYTHON}" -m privacy_research_dataset.hpc_service \
  --repo-root "${SCRAPER_REPO_ROOT}" \
  --remote-root "${SCRAPER_REMOTE_ROOT}" \
  --runtime-root "${SCRAPER_RUNTIME_ROOT}" \
  --outputs-root "${SCRAPER_OUTPUTS_ROOT}" \
  --python-cmd "${SCRAPER_PYTHON}" \
  --port "${SCRAPER_SERVICE_PORT}" \
  --db-port "${SCRAPER_DB_PORT}"
