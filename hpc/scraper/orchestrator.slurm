#!/bin/bash
#SBATCH --job-name=scraper-orch
#SBATCH --output=/srv/lustre01/project/vr_outsec-vh2sz1t4fks/users/soufiane.essahli/scraper/logs/orchestrator_%j.out
#SBATCH --error=/srv/lustre01/project/vr_outsec-vh2sz1t4fks/users/soufiane.essahli/scraper/logs/orchestrator_%j.err
#SBATCH --partition=compute
#SBATCH --qos=default-cpu
#SBATCH --account=vr_outsec-vh2sz1t4fks-default-cpu
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=24G
#SBATCH --time=08:00:00

set -euo pipefail

SCRAPER_REMOTE_ROOT="${SCRAPER_REMOTE_ROOT:-/srv/lustre01/project/vr_outsec-vh2sz1t4fks/users/soufiane.essahli/scraper}"
SCRAPER_REPO_ROOT="${SCRAPER_REPO_ROOT:-${SCRAPER_REMOTE_ROOT}/repo}"
SCRAPER_RUNTIME_ROOT="${SCRAPER_RUNTIME_ROOT:-${SCRAPER_REMOTE_ROOT}/runtime}"
SCRAPER_OUTPUTS_ROOT="${SCRAPER_OUTPUTS_ROOT:-${SCRAPER_REPO_ROOT}/outputs}"
SCRAPER_SERVICE_PORT="${SCRAPER_SERVICE_PORT:-8910}"
SCRAPER_DB_PORT="${SCRAPER_DB_PORT:-55432}"
SCRAPER_PYTHON="${SCRAPER_PYTHON:-${SCRAPER_REMOTE_ROOT}/.venv/bin/python}"

mkdir -p "${SCRAPER_REMOTE_ROOT}/logs" "${SCRAPER_RUNTIME_ROOT}" "${SCRAPER_OUTPUTS_ROOT}"

if [ ! -x "${SCRAPER_PYTHON}" ]; then
  echo "Missing runtime python at ${SCRAPER_PYTHON}"
  echo "Run ${SCRAPER_REPO_ROOT}/hpc/scraper/install_remote.sh first."
  exit 1
fi

node="$(hostname -s)"
cluster_fqdn="toubkal.hpc.um6p.ma"
user="$(whoami)"

cat <<EOF
============================================================
Scraper orchestrator job
Job ID: ${SLURM_JOB_ID}
Node: ${node}
Remote root: ${SCRAPER_REMOTE_ROOT}
Repo root: ${SCRAPER_REPO_ROOT}
Outputs root: ${SCRAPER_OUTPUTS_ROOT}
Service port: ${SCRAPER_SERVICE_PORT}
Database port: ${SCRAPER_DB_PORT}

Local tunnel command:
ssh -t -L ${SCRAPER_SERVICE_PORT}:localhost:${SCRAPER_SERVICE_PORT} ${user}@${cluster_fqdn} \\
  ssh -N -L ${SCRAPER_SERVICE_PORT}:localhost:${SCRAPER_SERVICE_PORT} ${node}
============================================================
EOF

cd "${SCRAPER_REPO_ROOT}"

exec "${SCRAPER_PYTHON}" -m privacy_research_dataset.hpc_service \
  --repo-root "${SCRAPER_REPO_ROOT}" \
  --remote-root "${SCRAPER_REMOTE_ROOT}" \
  --runtime-root "${SCRAPER_RUNTIME_ROOT}" \
  --outputs-root "${SCRAPER_OUTPUTS_ROOT}" \
  --python-cmd "${SCRAPER_PYTHON}" \
  --port "${SCRAPER_SERVICE_PORT}" \
  --db-port "${SCRAPER_DB_PORT}"
