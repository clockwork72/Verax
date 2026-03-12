#!/bin/bash
# Shared SSH connection config. Source this file to get SSH_HOST, SSH_SOCKET,
# and SSH_OPTS without repeating them across scripts.
# Not intended to be executed directly.

SSH_HOST="${SCRAPER_SSH_HOST:-toubkal}"
SERVICE_PORT="${SCRAPER_SERVICE_PORT:-8910}"
JOB_NAME="${SCRAPER_ORCH_JOB_NAME:-scraper-orch}"
SSH_SOCKET="${SCRAPER_SSH_SOCKET:-/tmp/scraper-ssh-${USER}.sock}"
FORWARD_STATE="${SCRAPER_SSH_FORWARD_STATE:-/tmp/scraper-ssh-forward-${USER}-${SERVICE_PORT}.target}"
SSH_OPTS=(
  -o ControlMaster=auto
  -o ControlPersist=10m
  -o "ControlPath=${SSH_SOCKET}"
)
