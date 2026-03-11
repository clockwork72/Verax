#!/bin/bash
set -euo pipefail

REMOTE_ROOT="${SCRAPER_REMOTE_ROOT:-/srv/lustre01/project/vr_outsec-vh2sz1t4fks/users/soufiane.essahli/scraper}"
REPO_ROOT="${SCRAPER_REPO_ROOT:-${REMOTE_ROOT}/repo}"
VENV_DIR="${SCRAPER_VENV_DIR:-${REMOTE_ROOT}/.venv}"
BROWSERS_DIR="${SCRAPER_PLAYWRIGHT_BROWSERS:-${REMOTE_ROOT}/runtime/playwright-browsers}"
PYTHON_MODULE="${SCRAPER_PYTHON_MODULE:-Python/3.12.3-GCCcore-13.3.0}"

mkdir -p "${REMOTE_ROOT}" "${REMOTE_ROOT}/logs" "${REMOTE_ROOT}/runtime"
mkdir -p "${BROWSERS_DIR}"

if [ ! -d "${REPO_ROOT}" ]; then
  echo "Repository checkout not found at ${REPO_ROOT}"
  exit 1
fi

module purge >/dev/null 2>&1 || true
module load "${PYTHON_MODULE}"

python3 -m venv "${VENV_DIR}"
"${VENV_DIR}/bin/python" -m pip install --upgrade pip setuptools wheel
"${VENV_DIR}/bin/pip" install -e "${REPO_ROOT}"
PLAYWRIGHT_BROWSERS_PATH="${BROWSERS_DIR}" "${VENV_DIR}/bin/python" -m playwright install chromium

if [ ! -f "${REMOTE_ROOT}/runtime/postgres/postgres-16.sif" ]; then
  mkdir -p "${REMOTE_ROOT}/runtime/postgres"
  apptainer pull "${REMOTE_ROOT}/runtime/postgres/postgres-16.sif" docker://postgres:16-alpine
fi

echo "Remote runtime ready at ${REMOTE_ROOT}"
