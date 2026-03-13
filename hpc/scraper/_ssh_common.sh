#!/bin/bash
# Shared SSH connection config. Source this file to get SSH_HOST, SSH_SOCKET,
# and SSH_OPTS without repeating them across scripts.
# Not intended to be executed directly.

SCRAPER_SSH_HOST_PLACEHOLDER="your-user@login.your-hpc.example"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config_common.sh"

SSH_HOST="${SCRAPER_SSH_HOST:-${SCRAPER_SSH_HOST_PLACEHOLDER}}"
SERVICE_PORT="${SCRAPER_SERVICE_PORT:-8910}"
JOB_NAME="${SCRAPER_ORCH_JOB_NAME:-scraper-orch}"
DEFAULT_SSH_SOCKET="${SCRAPER_SSH_SOCKET:-/tmp/scraper-ssh-${USER}.sock}"
FORWARD_STATE="${SCRAPER_SSH_FORWARD_STATE:-/tmp/scraper-ssh-forward-${USER}-${SERVICE_PORT}.target}"

require_scraper_ssh_host() {
  if [ "${SSH_HOST}" = "${SCRAPER_SSH_HOST_PLACEHOLDER}" ]; then
    echo "Set SCRAPER_SSH_HOST to your HPC login host before using the bridge scripts." >&2
    exit 1
  fi
}

resolve_ssh_socket() {
  local configured_socket="${SCRAPER_SSH_SOCKET:-}"
  local candidate=""
  if [ -n "${configured_socket}" ]; then
    printf '%s\n' "${configured_socket}"
    return 0
  fi

  if ssh -o "ControlPath=${DEFAULT_SSH_SOCKET}" -O check "${SSH_HOST}" >/dev/null 2>&1; then
    printf '%s\n' "${DEFAULT_SSH_SOCKET}"
    return 0
  fi

  shopt -s nullglob
  for candidate in /tmp/scraper-ssh-*.sock; do
    if [ "${candidate}" = "${DEFAULT_SSH_SOCKET}" ]; then
      continue
    fi
    if ssh -o "ControlPath=${candidate}" -O check "${SSH_HOST}" >/dev/null 2>&1; then
      shopt -u nullglob
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  shopt -u nullglob

  printf '%s\n' "${DEFAULT_SSH_SOCKET}"
}

SSH_SOCKET="$(resolve_ssh_socket)"
SSH_OPTS=(
  -o ControlMaster=auto
  -o ControlPersist=10m
  -o "ControlPath=${SSH_SOCKET}"
)
