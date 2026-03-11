#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SSH_HOST="${SCRAPER_SSH_HOST:-toubkal}"
REMOTE_ROOT="${SCRAPER_REMOTE_ROOT:-/srv/lustre01/project/vr_outsec-vh2sz1t4fks/users/soufiane.essahli/scraper}"
REMOTE_REPO="${SCRAPER_REPO_ROOT:-${REMOTE_ROOT}/repo}"
REMOTE_OUTPUTS_ROOT="${SCRAPER_OUTPUTS_ROOT:-${REMOTE_REPO}/outputs}"
LOCAL_OUTPUTS_ROOT="${SCRAPER_LOCAL_OUTPUTS_ROOT:-${ROOT_DIR}/outputs/hpc}"
SSH_SOCKET="${SCRAPER_SSH_SOCKET:-/tmp/scraper-ssh-${USER}.sock}"
SSH_OPTS=(
  -o ControlMaster=auto
  -o ControlPersist=10m
  -o "ControlPath=${SSH_SOCKET}"
)
CREATED_SSH_MASTER=0

cleanup() {
  if [ "${CREATED_SSH_MASTER}" -eq 1 ]; then
    ssh "${SSH_OPTS[@]}" -O exit "${SSH_HOST}" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

if ssh "${SSH_OPTS[@]}" -O check "${SSH_HOST}" >/dev/null 2>&1; then
  CREATED_SSH_MASTER=0
else
  ssh "${SSH_OPTS[@]}" -MNf "${SSH_HOST}"
  CREATED_SSH_MASTER=1
fi

usage() {
  cat <<'EOF'
Usage:
  hpc/scraper/pull_run.sh --list
  hpc/scraper/pull_run.sh <run_dir>

Examples:
  hpc/scraper/pull_run.sh --list
  hpc/scraper/pull_run.sh unified
  hpc/scraper/pull_run.sh smoke10_fix_114421
EOF
}

if [ "${1:-}" = "--list" ]; then
  ssh "${SSH_OPTS[@]}" "${SSH_HOST}" "bash -lc 'find \"${REMOTE_OUTPUTS_ROOT}\" -mindepth 1 -maxdepth 1 -type d -printf \"%f\n\" | sort'"
  exit 0
fi

RUN_DIR="${1:-}"
if [ -z "${RUN_DIR}" ]; then
  usage
  exit 1
fi

mkdir -p "${LOCAL_OUTPUTS_ROOT}"
rsync -az \
  -e "ssh ${SSH_OPTS[*]}" \
  "${SSH_HOST}:${REMOTE_OUTPUTS_ROOT}/${RUN_DIR}/" \
  "${LOCAL_OUTPUTS_ROOT}/${RUN_DIR}/"

echo "Pulled ${RUN_DIR} to ${LOCAL_OUTPUTS_ROOT}/${RUN_DIR}"
