#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${VENV_DIR:-$ROOT_DIR/.venv}"

log() {
  printf '[verify] %s\n' "$1"
}

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  printf '[verify] missing virtualenv interpreter at %s/bin/python\n' "$VENV_DIR" >&2
  exit 1
fi

log "Checking CLI entrypoints"
"$VENV_DIR/bin/python" -m privacy_research_dataset.cli --help >/dev/null
"$VENV_DIR/bin/python" -m privacy_research_dataset.annotate_cli --help >/dev/null

log "Running Python test suite"
(
  cd "$ROOT_DIR"
  "$VENV_DIR/bin/python" -m pytest -q
)

if command -v npm >/dev/null 2>&1; then
  log "Building dashboard"
  (
    cd "$ROOT_DIR/dashboard"
    npm run build
  )
fi

log "Setup verification passed"
