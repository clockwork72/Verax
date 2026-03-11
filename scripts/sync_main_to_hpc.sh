#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_NAME="${SYNC_REMOTE_NAME:-origin}"
SOURCE_BRANCH="${SYNC_SOURCE_BRANCH:-main}"
TARGET_BRANCH="${SYNC_TARGET_BRANCH:-hpc-v}"
RESET_TO_REMOTE="${SYNC_RESET_TO_REMOTE:-0}"
PUSH_CHANGES=0
PROTECTED_FILES=(
  "dashboard/electron/main.ts"
  "dashboard/src/App.tsx"
  "dashboard/src/components/launcher/LauncherView.tsx"
)

usage() {
  cat <<'EOF'
Usage:
  scripts/sync_main_to_hpc.sh [--push]

Behavior:
  - fetches origin/main and origin/hpc-v
  - checks out hpc-v
  - merges main into hpc-v
  - optionally pushes the updated hpc-v branch

Environment overrides:
  SYNC_REMOTE_NAME
  SYNC_SOURCE_BRANCH
  SYNC_TARGET_BRANCH
  SYNC_RESET_TO_REMOTE
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --push)
      PUSH_CHANGES=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

cd "${ROOT_DIR}"

if [ -n "$(git status --short)" ]; then
  echo "Working tree is not clean. Commit or stash changes before syncing." >&2
  exit 1
fi

git fetch "${REMOTE_NAME}" "${SOURCE_BRANCH}" "${TARGET_BRANCH}"

protected_changed=()
while IFS= read -r path; do
  [ -n "${path}" ] && protected_changed+=("${path}")
done < <(git diff --name-only "${REMOTE_NAME}/${TARGET_BRANCH}...${REMOTE_NAME}/${SOURCE_BRANCH}" -- "${PROTECTED_FILES[@]}")

if [ "${RESET_TO_REMOTE}" = "1" ]; then
  git checkout -B "${TARGET_BRANCH}" "${REMOTE_NAME}/${TARGET_BRANCH}"
else
  git checkout "${TARGET_BRANCH}"
fi

if git merge --no-edit "${REMOTE_NAME}/${SOURCE_BRANCH}"; then
  echo "Merged ${REMOTE_NAME}/${SOURCE_BRANCH} into ${TARGET_BRANCH}."
else
  echo "Merge conflict while syncing ${SOURCE_BRANCH} into ${TARGET_BRANCH}." >&2
  echo "Conflicted files:" >&2
  git diff --name-only --diff-filter=U >&2
  exit 1
fi

if [ "${#protected_changed[@]}" -gt 0 ]; then
  echo
  echo "Manual review recommended for protected HPC bridge files touched by ${SOURCE_BRANCH}:"
  for path in "${protected_changed[@]}"; do
    echo "  - ${path}"
  done
fi

if [ "${PUSH_CHANGES}" -eq 1 ]; then
  git push "${REMOTE_NAME}" "HEAD:${TARGET_BRANCH}"
  echo "Pushed ${TARGET_BRANCH} to ${REMOTE_NAME}."
fi
