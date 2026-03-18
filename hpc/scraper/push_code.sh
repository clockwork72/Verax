#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=_config_common.sh
source "${ROOT_DIR}/hpc/scraper/_config_common.sh"
REMOTE_ROOT="${SCRAPER_REMOTE_ROOT:-/path/to/your/hpc/scraper}"
REMOTE_REPO="${SCRAPER_REPO_ROOT:-${REMOTE_ROOT}/repo}"
# shellcheck source=_ssh_common.sh
source "${ROOT_DIR}/hpc/scraper/_ssh_common.sh"
require_scraper_ssh_host
CREATED_SSH_MASTER=0

SYNC_DIRS=(
  "dashboard"
  "tests"
  "privacy_research_dataset"
  "scripts"
  "hpc"
)

SYNC_FILES=(
  "README.md"
  "pyproject.toml"
  "requirements.txt"
  "scrapable_websites_categorized.csv"
  "tracker_radar_index.json"
  "trackerdb_index.json"
)

REMOTE_PRUNE_DIRS=(
  "dashboard/node_modules"
  "dashboard/dist"
  "dashboard/build"
  "dashboard/.vite"
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
ssh "${SSH_OPTS[@]}" "${SSH_HOST}" "bash -lc 'mkdir -p ${remote_repo_q} ${remote_root_q}/logs ${remote_root_q}/runtime ${remote_repo_q}/outputs'"

for dir in "${SYNC_DIRS[@]}"; do
  rsync -az --delete \
    -e "ssh ${SSH_OPTS[*]}" \
    --exclude '__pycache__' \
    --exclude '*.pyc' \
    --exclude 'node_modules' \
    --exclude 'dist' \
    --exclude 'build' \
    --exclude '.vite' \
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
