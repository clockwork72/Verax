#!/bin/bash
# CPU-safe validation sweep. Probes the local bridge, remote service, and
# Slurm state without starting any GPU-backed model work.
# Pass --json to emit a machine-readable summary at the end.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=_config_common.sh
source "${ROOT_DIR}/hpc/scraper/_config_common.sh"
# shellcheck source=_ssh_common.sh
source "${ROOT_DIR}/hpc/scraper/_ssh_common.sh"
HEALTH_URL="http://127.0.0.1:${SERVICE_PORT}/health"
STATUS_URL="http://127.0.0.1:${SERVICE_PORT}/api/status"
STATS_URL="http://127.0.0.1:${SERVICE_PORT}/api/annotation-stats?outDir=outputs/unified"
REMOTE_ROOT="${SCRAPER_REMOTE_ROOT:-/path/to/your/hpc/scraper}"
MODEL_PORT="${SCRAPER_LLM_MODEL_PORT:-8901}"
JSON_MODE=0

require_scraper_ssh_host

if [ "${1:-}" = "--json" ]; then
  JSON_MODE=1
fi

PASS=0
FAIL=0
SKIP=0

step() {
  local label="$1"
  local status="$2"
  local detail="${3:-}"
  case "${status}" in
    ok)   PASS=$((PASS + 1)); printf '[ok]   %s\n' "${label}" ;;
    fail) FAIL=$((FAIL + 1)); printf '[FAIL] %s%s\n' "${label}" "${detail:+: ${detail}}" ;;
    skip) SKIP=$((SKIP + 1)); printf '[skip] %s%s\n' "${label}" "${detail:+: ${detail}}" ;;
  esac
}

# ---------------------------------------------------------------------------
# [1] Bridge health
# ---------------------------------------------------------------------------
printf '\n=== [1/7] Bridge health ===\n'
if HEALTH_RAW="$(curl -fsS --max-time 5 "${HEALTH_URL}" 2>/dev/null)"; then
  echo "${HEALTH_RAW}" | python3 -m json.tool
  step "bridge /health" ok
else
  step "bridge /health" fail "curl failed -- is the tunnel up?"
fi

# ---------------------------------------------------------------------------
# [2] Service status
# ---------------------------------------------------------------------------
printf '\n=== [2/7] Service status ===\n'
if STATUS_RAW="$(curl -fsS --max-time 5 "${STATUS_URL}" 2>/dev/null)"; then
  echo "${STATUS_RAW}" | python3 -m json.tool
  step "bridge /api/status" ok
else
  step "bridge /api/status" fail "curl failed"
fi

# ---------------------------------------------------------------------------
# [3] Annotation stats snapshot
# ---------------------------------------------------------------------------
printf '\n=== [3/7] Annotation stats snapshot ===\n'
if STATS_RAW="$(curl -fsS --max-time 10 "${STATS_URL}" 2>/dev/null)"; then
  echo "${STATS_RAW}" | python3 -c 'import json,sys; p=json.load(sys.stdin); print(json.dumps({"ok": p.get("ok"), "total_sites": p.get("total_sites"), "annotated_sites": p.get("annotated_sites"), "total_statements": p.get("total_statements")}, indent=2))'
  step "annotation stats" ok
else
  step "annotation stats" fail "curl failed"
fi

# ---------------------------------------------------------------------------
# [4] Remote Python runtime
# ---------------------------------------------------------------------------
printf '\n=== [4/7] Remote Python runtime ===\n'
PYTHON_CMD="${SCRAPER_PYTHON:-${REMOTE_ROOT}/.venv/bin/python}"
set +e
PYTHON_VERSION="$(ssh "${SSH_OPTS[@]}" "${SSH_HOST}" "bash -lc '${PYTHON_CMD} --version 2>&1'" 2>/dev/null)"
PYTHON_STATUS=$?
set -e
if [ "${PYTHON_STATUS}" -eq 0 ] && [ -n "${PYTHON_VERSION}" ]; then
  echo "  ${PYTHON_VERSION}"
  step "remote python runtime" ok
else
  step "remote python runtime" fail "could not exec ${PYTHON_CMD} on ${SSH_HOST}"
fi

# ---------------------------------------------------------------------------
# [5] Annotation model endpoint (non-destructive health probe)
# ---------------------------------------------------------------------------
printf '\n=== [5/7] Annotation model endpoint ===\n'
set +e
LLM_HEALTH_RAW="$(curl -fsS --max-time 5 "http://127.0.0.1:${MODEL_PORT}/health" 2>/dev/null)"
LLM_STATUS=$?
set -e
if [ "${LLM_STATUS}" -eq 0 ]; then
  echo "${LLM_HEALTH_RAW}" | python3 -m json.tool 2>/dev/null || echo "  ${LLM_HEALTH_RAW}"
  step "annotation model /health (port ${MODEL_PORT})" ok
else
  step "annotation model /health (port ${MODEL_PORT})" skip "not reachable locally -- may be on a different node"
fi

# ---------------------------------------------------------------------------
# [6] Bridge script diagnostics
# ---------------------------------------------------------------------------
printf '\n=== [6/7] Bridge script diagnostics ===\n'
set +e
"${ROOT_DIR}/hpc/scraper/check_bridge.sh"
BRIDGE_STATUS=$?
set -e
if [ "${BRIDGE_STATUS}" -eq 0 ]; then
  step "check_bridge.sh" ok
else
  step "check_bridge.sh" fail "bridge reported unhealthy (exit ${BRIDGE_STATUS})"
fi

# ---------------------------------------------------------------------------
# [7] Slurm job snapshot
# ---------------------------------------------------------------------------
printf '\n=== [7/7] Slurm job snapshot ===\n'
set +e
SLURM_OUT="$(ssh "${SSH_OPTS[@]}" "${SSH_HOST}" 'squeue -u "$USER" -o "%.10i %.10T %.20j %.25N"' 2>/dev/null)"
SLURM_STATUS=$?
set -e
if [ "${SLURM_STATUS}" -eq 0 ]; then
  echo "${SLURM_OUT}"
  step "slurm squeue" ok
else
  step "slurm squeue" fail "ssh or squeue failed (exit ${SLURM_STATUS})"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf '\n=== Summary: %d ok, %d failed, %d skipped ===\n' "${PASS}" "${FAIL}" "${SKIP}"

if [ "${JSON_MODE}" -eq 1 ]; then
  python3 - <<PY
import json
print(json.dumps({"pass": ${PASS}, "fail": ${FAIL}, "skip": ${SKIP}, "ok": ${FAIL} == 0}))
PY
fi

[ "${FAIL}" -eq 0 ]
