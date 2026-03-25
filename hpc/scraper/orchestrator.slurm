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
ensure_module_command() {
  if command -v module >/dev/null 2>&1; then
    return 0
  fi

  for candidate in \
    /etc/profile.d/modules.sh \
    /usr/share/Modules/init/bash \
    /etc/profile.d/lmod.sh \
    /usr/share/lmod/lmod/init/bash
  do
    if [ -f "${candidate}" ]; then
      # shellcheck disable=SC1090
      source "${candidate}" >/dev/null 2>&1 || true
      if command -v module >/dev/null 2>&1; then
        return 0
      fi
    fi
  done

  if command -v modulecmd >/dev/null 2>&1; then
    eval "$(modulecmd bash autoinit 2>/dev/null)" || true
    if command -v module >/dev/null 2>&1; then
      return 0
    fi
  fi

  return 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SUBMIT_REPO_ROOT="${SLURM_SUBMIT_DIR:-}"
if [ -n "${SUBMIT_REPO_ROOT}" ] && [ -f "${SUBMIT_REPO_ROOT}/privacy_research_dataset/hpc_service.py" ]; then
  DEFAULT_REPO_ROOT="${SUBMIT_REPO_ROOT}"
else
  DEFAULT_REPO_ROOT="${SCRIPT_REPO_ROOT}"
fi

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
SCRAPER_PYTHON_MODULE="${SCRAPER_PYTHON_MODULE:-}"
SCRAPER_APPTAINER_MODULE="${SCRAPER_APPTAINER_MODULE:-}"
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

if [ -n "${SCRAPER_PYTHON_MODULE}" ] || [ -n "${SCRAPER_APPTAINER_MODULE}" ]; then
  if ! ensure_module_command; then
    echo "Requested cluster modules, but the module command is unavailable in this batch shell." >&2
    exit 1
  fi
  if [ -n "${SCRAPER_PYTHON_MODULE}" ]; then
    module load "${SCRAPER_PYTHON_MODULE}"
  fi
  if [ -n "${SCRAPER_APPTAINER_MODULE}" ]; then
    module load "${SCRAPER_APPTAINER_MODULE}"
  fi
fi

if [ ! -x "${SCRAPER_PYTHON}" ]; then
  echo "Missing runtime python at ${SCRAPER_PYTHON}" >&2
  echo "Run ${SCRAPER_REPO_ROOT}/hpc/scraper/install_remote.sh first." >&2
  exit 1
fi

if ! command -v apptainer >/dev/null 2>&1; then
  echo "Missing apptainer in PATH for orchestrator startup." >&2
  echo "Export SCRAPER_APPTAINER_MODULE to your cluster's module name, or load it before sbatch." >&2
  exit 1
fi

node="$(hostname -s)"
cluster_fqdn="${SCRAPER_CLUSTER_FQDN}"
user="${USER:-}"
if [ -z "${user}" ]; then
  user="$(id -un 2>/dev/null || true)"
fi
if [ -z "${user}" ]; then
  user="$(id -u)"
fi
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
Apptainer: $(command -v apptainer)

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
