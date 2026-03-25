#!/bin/bash
set -euo pipefail

# shellcheck source=_config_common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config_common.sh"

REMOTE_ROOT="${SCRAPER_REMOTE_ROOT:-/path/to/your/hpc/scraper}"
REPO_ROOT="${SCRAPER_REPO_ROOT:-${REMOTE_ROOT}/repo}"
VENV_DIR="${SCRAPER_VENV_DIR:-${REMOTE_ROOT}/.venv}"
BROWSERS_DIR="${SCRAPER_PLAYWRIGHT_BROWSERS:-${REMOTE_ROOT}/runtime/playwright-browsers}"
PYTHON_MODULE="${SCRAPER_PYTHON_MODULE:-Python/3.12.3-GCCcore-13.3.0}"
APPTAINER_MODULE="${SCRAPER_APPTAINER_MODULE:-}"

mkdir -p "${REMOTE_ROOT}" "${REMOTE_ROOT}/logs" "${REMOTE_ROOT}/runtime"
mkdir -p "${BROWSERS_DIR}"

if [ ! -d "${REPO_ROOT}" ]; then
  echo "Repository checkout not found at ${REPO_ROOT}"
  exit 1
fi

if [ -n "${PYTHON_MODULE}" ] || [ -n "${APPTAINER_MODULE}" ]; then
  if ! ensure_module_command; then
    echo "Environment modules requested, but the module command is unavailable." >&2
    echo "Set SCRAPER_PYTHON_MODULE='' and/or SCRAPER_APPTAINER_MODULE='' if your cluster does not use modules." >&2
    exit 1
  fi
  module purge >/dev/null 2>&1 || true
  if [ -n "${PYTHON_MODULE}" ]; then
    module load "${PYTHON_MODULE}"
  fi
  if [ -n "${APPTAINER_MODULE}" ]; then
    module load "${APPTAINER_MODULE}"
  fi
fi

if ! command -v apptainer >/dev/null 2>&1; then
  echo "Missing apptainer in PATH during remote install." >&2
  echo "Export SCRAPER_APPTAINER_MODULE to the cluster's Apptainer/Singularity module name." >&2
  exit 1
fi

python3 -m venv "${VENV_DIR}"
"${VENV_DIR}/bin/python" -m pip install --upgrade pip setuptools wheel
"${VENV_DIR}/bin/pip" install -e "${REPO_ROOT}"
PLAYWRIGHT_BROWSERS_PATH="${BROWSERS_DIR}" "${VENV_DIR}/bin/python" -m playwright install chromium

if [ ! -f "${REMOTE_ROOT}/runtime/postgres/postgres-16.sif" ]; then
  mkdir -p "${REMOTE_ROOT}/runtime/postgres"
  apptainer pull "${REMOTE_ROOT}/runtime/postgres/postgres-16.sif" docker://postgres:16-alpine
fi

echo "Remote runtime ready at ${REMOTE_ROOT}"
