#!/bin/bash
# Shared local override loading for HPC helper scripts.

SCRAPER_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRAPER_LOCAL_ENV_FILE="${SCRAPER_LOCAL_ENV_FILE:-${SCRAPER_SCRIPT_DIR}/local.env}"

if [ -f "${SCRAPER_LOCAL_ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  source "${SCRAPER_LOCAL_ENV_FILE}"
fi
