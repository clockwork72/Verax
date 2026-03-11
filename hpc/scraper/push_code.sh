#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SSH_HOST="${SCRAPER_SSH_HOST:-toubkal}"
REMOTE_ROOT="${SCRAPER_REMOTE_ROOT:-/srv/lustre01/project/vr_outsec-vh2sz1t4fks/users/soufiane.essahli/scraper}"
REMOTE_REPO="${SCRAPER_REPO_ROOT:-${REMOTE_ROOT}/repo}"
SSH_SOCKET="${SCRAPER_SSH_SOCKET:-/tmp/scraper-ssh-${USER}.sock}"
SSH_OPTS=(
  -o ControlMaster=auto
  -o ControlPersist=10m
  -o "ControlPath=${SSH_SOCKET}"
)

SYNC_DIRS=(
  "privacy_research_dataset"
  "scripts"
  "hpc"
)

SYNC_FILES=(
  "README.md"
  "pyproject.toml"
  "requirements.txt"
  "tracker_radar_index.json"
  "trackerdb_index.json"
)

REMOTE_PRUNE_DIRS=(
  "dashboard"
  "tests"
  "tracker-radar"
  "trackerdb"
  "privacy_research_dataset.egg-info"
  ".pytest_cache"
)

REMOTE_PRUNE_FILES=(
  "package-lock.json"
  "outputsresults.jsonl"
)

remote_root_q="$(printf '%q' "${REMOTE_ROOT}")"
remote_repo_q="$(printf '%q' "${REMOTE_REPO}")"

cleanup() {
  ssh "${SSH_OPTS[@]}" -O exit "${SSH_HOST}" >/dev/null 2>&1 || true
}

trap cleanup EXIT

ssh "${SSH_OPTS[@]}" -MNf "${SSH_HOST}"
ssh "${SSH_OPTS[@]}" "${SSH_HOST}" "bash -lc 'mkdir -p ${remote_repo_q} ${remote_root_q}/logs ${remote_root_q}/runtime ${remote_repo_q}/outputs'"

for dir in "${SYNC_DIRS[@]}"; do
  rsync -az --delete \
    -e "ssh ${SSH_OPTS[*]}" \
    --exclude '__pycache__' \
    --exclude '*.pyc' \
    "${ROOT_DIR}/${dir}/" "${SSH_HOST}:${REMOTE_REPO}/${dir}/"
done

for file in "${SYNC_FILES[@]}"; do
  rsync -az -e "ssh ${SSH_OPTS[*]}" "${ROOT_DIR}/${file}" "${SSH_HOST}:${REMOTE_REPO}/${file}"
done

prune_cmd="set -euo pipefail"
for dir in "${REMOTE_PRUNE_DIRS[@]}"; do
  prune_cmd="${prune_cmd}; rm -rf ${remote_repo_q}/${dir}"
done
for file in "${REMOTE_PRUNE_FILES[@]}"; do
  prune_cmd="${prune_cmd}; rm -f ${remote_repo_q}/${file}"
done

ssh "${SSH_OPTS[@]}" "${SSH_HOST}" "bash -lc '${prune_cmd}'"

echo "Synced scraper payload to ${SSH_HOST}:${REMOTE_REPO}"
