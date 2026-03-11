#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${VENV_DIR:-$ROOT_DIR/.venv}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
SKIP_APT="${SKIP_APT:-0}"

log() {
  printf '[bootstrap] %s\n' "$1"
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

need_sudo() {
  [[ "${EUID}" -ne 0 ]]
}

apt_install() {
  if [[ "$SKIP_APT" == "1" ]]; then
    return
  fi
  if ! have_cmd apt-get; then
    return
  fi

  local sudo_cmd=()
  if need_sudo; then
    sudo_cmd=(sudo)
  fi

  log "Installing Ubuntu system packages"
  "${sudo_cmd[@]}" apt-get update
  "${sudo_cmd[@]}" apt-get install -y \
    ca-certificates \
    curl \
    git \
    pandoc \
    python3 \
    python3-pip \
    python3-venv

  if ! have_cmd node; then
    log "Installing Node.js 20.x"
    curl -fsSL https://deb.nodesource.com/setup_20.x | "${sudo_cmd[@]}" -E bash -
    "${sudo_cmd[@]}" apt-get install -y nodejs
  fi
}

install_python_env() {
  if [[ ! -d "$VENV_DIR" ]]; then
    log "Creating virtual environment at $VENV_DIR"
    "$PYTHON_BIN" -m venv "$VENV_DIR"
  fi

  log "Installing Python package and dev tooling"
  "$VENV_DIR/bin/python" -m pip install --upgrade pip setuptools wheel
  "$VENV_DIR/bin/pip" install -e "${ROOT_DIR}[dev]"
}

install_playwright() {
  log "Installing Playwright Chromium browser"
  "$VENV_DIR/bin/python" -m playwright install chromium

  if [[ "$SKIP_APT" == "1" ]] || ! have_cmd apt-get; then
    return
  fi

  local sudo_cmd=()
  if need_sudo; then
    sudo_cmd=(sudo)
  fi

  log "Installing Playwright system dependencies"
  "${sudo_cmd[@]}" "$VENV_DIR/bin/python" -m playwright install-deps chromium
}

install_dashboard() {
  if ! have_cmd npm; then
    log "npm is not available; skipping dashboard dependency install"
    return
  fi
  log "Installing dashboard dependencies"
  (
    cd "$ROOT_DIR/dashboard"
    npm ci
  )
}

verify_indexes() {
  local required=(
    "$ROOT_DIR/tracker_radar_index.json"
    "$ROOT_DIR/trackerdb_index.json"
  )
  local missing=0
  for path in "${required[@]}"; do
    if [[ ! -f "$path" ]]; then
      printf '[bootstrap] missing required index: %s\n' "$path" >&2
      missing=1
    fi
  done
  if [[ "$missing" -ne 0 ]]; then
    printf '[bootstrap] prebuilt tracker indexes are missing; rebuild them with the scripts in %s/scripts\n' "$ROOT_DIR" >&2
    exit 1
  fi
}

main() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    printf '[bootstrap] this helper targets Ubuntu/Linux. Continue manually on this platform.\n' >&2
    exit 1
  fi

  apt_install
  verify_indexes
  install_python_env
  install_playwright
  install_dashboard

  log "Bootstrap complete"
  log "Activate the environment with: source \"$VENV_DIR/bin/activate\""
  log "For the dashboard, export: PRIVACY_DATASET_PYTHON=\"$VENV_DIR/bin/python\""
}

main "$@"
