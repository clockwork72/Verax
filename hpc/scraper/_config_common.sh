#!/bin/bash
# Shared local override loading for HPC helper scripts.

SCRAPER_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRAPER_LOCAL_ENV_FILE="${SCRAPER_LOCAL_ENV_FILE:-${SCRAPER_SCRIPT_DIR}/local.env}"

if [ -f "${SCRAPER_LOCAL_ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  source "${SCRAPER_LOCAL_ENV_FILE}"
fi

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
