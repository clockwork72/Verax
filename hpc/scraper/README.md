# HPC Scraper Operator Runbook

This runbook assumes you already have access to a Slurm-based HPC cluster.
Before using these scripts, set at least:

- `SCRAPER_SSH_HOST` to your cluster login host
- `SCRAPER_REMOTE_ROOT` to your writable remote project directory
- any cluster-specific Slurm options your site requires

Recommended: copy `hpc/scraper/local.env.example` to `hpc/scraper/local.env`. That file is gitignored and sourced automatically by the helper scripts.

If your cluster exposes Python or Apptainer through environment modules, also set
`SCRAPER_PYTHON_MODULE` and `SCRAPER_APPTAINER_MODULE`. Slurm batch shells often
do not inherit the same module setup as an interactive login shell.

---

## Table of contents

1. [Architecture overview](#1-architecture-overview)
2. [First deploy (fresh cluster)](#2-first-deploy-fresh-cluster)
3. [Normal deploy / redeploy](#3-normal-deploy--redeploy)
4. [Reattach after tunnel loss](#4-reattach-after-tunnel-loss)
5. [Crash and restart recovery](#5-crash-and-restart-recovery)
6. [Resume an interrupted annotation run](#6-resume-an-interrupted-annotation-run)
7. [Troubleshooting playbook](#7-troubleshooting-playbook)
8. [Artifact retrieval](#8-artifact-retrieval)
9. [Environment variable reference](#9-environment-variable-reference)
10. [Script reference](#10-script-reference)

---

## 1. Architecture overview

```
Local machine                         HPC login node            Compute node (GPU)
─────────────────────────             ──────────────            ──────────────────
Electron dashboard (port 8910)
  │ HTTP over SSH tunnel
  └─── SSH -L 8910:NODE:8910 ───────> sshd ──────────────────> orchestrator.slurm
                                                                  aiohttp :8910
                                                                  annotate_cli.py
                                                                  LLM model :8901
```

- The **orchestrator** (aiohttp control plane) runs as a Slurm job named `scraper-orch`.
- The **SSH tunnel** forwards `localhost:8910` → `compute-node:8910` via the login node.
- The **dashboard** talks only to `http://127.0.0.1:8910`; it never speaks directly to Slurm.
- The **annotation model** (LLM) can be on the same compute node (:8901) or a separate one.
- Per-site state is persisted in `annotation_status.json` files under the output directory so that interrupted runs can be resumed without re-doing completed sites.
- All shell scripts share SSH config from `_ssh_common.sh` and deploy functions from `_deploy_common.sh`.

---

## 2. First deploy (fresh cluster)

This is only needed once, or after a full environment wipe.

```bash
# 1. Ensure the remote project directory exists (adjust path if needed)
ssh "${SCRAPER_SSH_HOST}" "mkdir -p \"${SCRAPER_REMOTE_ROOT}\""

# 2. Push code + install the remote Python venv
hpc/scraper/push_code.sh
ssh "${SCRAPER_SSH_HOST}" "bash -lc '
  SCRAPER_REMOTE_ROOT=\${SCRAPER_REMOTE_ROOT}
  SCRAPER_REPO_ROOT=\${SCRAPER_REPO_ROOT:-\${SCRAPER_REMOTE_ROOT}/repo}
  \${SCRAPER_REPO_ROOT}/hpc/scraper/install_remote.sh
'"

# 3. Submit the orchestrator and open the local tunnel (blocks)
hpc/scraper/launch_remote.sh
```

`launch_remote.sh` will:
- push current code
- install the remote runtime
- auto-detect the annotation model endpoint (if a GPU job is already running)
- submit `orchestrator.slurm`
- wait up to 5 minutes for the job to reach RUNNING state
- open a foreground tunnel — keep this terminal open while working

---

## 3. Normal deploy / redeploy

Use `refresh_remote.sh` (non-blocking, returns when bridge is healthy):

```bash
hpc/scraper/refresh_remote.sh
```

Or `launch_remote.sh` if you prefer a foreground blocking tunnel.

Both scripts:
- push code
- re-install the venv if needed
- submit a new `scraper-orch` job
- cancel any older duplicate `scraper-orch` jobs
- wait for the new node to become RUNNING
- attach / reopen the local tunnel

After a successful deploy, verify with:

```bash
hpc/scraper/validate_cpu_bridge.sh
```

Expected: `Summary: 6 ok, 0 failed, 0-1 skipped` (annotation model step may be skipped if on a different node).

### Performance tuning

The live scraper now reuses one shared Crawl4AI browser client per run and scales
its default crawl parallelism from the Slurm CPU allocation instead of staying
fixed at `4/4`.

Current default scaling:
- `SLURM_CPUS_PER_TASK=24` → scraper concurrency `8`, browser fetch concurrency `12`
- `SLURM_CPUS_PER_TASK=32` → scraper concurrency `10`, browser fetch concurrency `16`
- smaller allocations scale down automatically
- explicit API/UI overrides still win when provided

If you want more throughput from the HPC job itself, request more resources via
`SCRAPER_SBATCH_EXTRA_ARGS` in `hpc/scraper/local.env`:

```bash
export SCRAPER_SBATCH_EXTRA_ARGS="--account=<acct> --cpus-per-task=32 --mem=112G \
  --output=/path/to/logs/orchestrator_%j.out --error=/path/to/logs/orchestrator_%j.err"
```

`sbatch` command-line arguments override the defaults baked into
`orchestrator.slurm`, so this is the supported way to ask for more CPU or RAM
without editing the batch script.

---

## 4. Reattach after tunnel loss

Use when the orchestrator is still running but the SSH tunnel died (e.g. laptop slept, terminal closed).

```bash
# Quick check first
hpc/scraper/check_bridge.sh

# Reattach (resolves the running node automatically)
hpc/scraper/attach_tunnel.sh
```

`attach_tunnel.sh` will:
1. reuse or open a new SSH master connection
2. query Slurm for the running `scraper-orch` node
3. kill stale local forwards on port 8910
4. open a fresh forward to the live node
5. confirm `/health` responds before exiting

If the orchestrator moved to a new node (Slurm preemption), pass the node name explicitly:

```bash
hpc/scraper/attach_tunnel.sh <new-compute-node>
```

---

## 5. Crash and restart recovery

When the orchestrator job has died (e.g. Slurm wall-time, OOM, node failure):

```bash
# Confirm job is gone
ssh "${SCRAPER_SSH_HOST}" 'squeue -u "$USER" -o "%.10i %.10T %.20j %.25N"'

# Redeploy (no code changes needed — just resubmit)
hpc/scraper/refresh_remote.sh

# Verify
hpc/scraper/validate_cpu_bridge.sh
```

The new orchestrator picks up where the previous one left off because:
- completed sites have `annotation_status.json` → `{"status": "completed"}` on disk
- the annotator skips any site already in a terminal state (`completed`, `failed`, `stopped`)
- no manual state cleanup is needed

If you want to retry previously-failed sites:

```bash
# On the cluster, remove failed status files for the target run
ssh "${SCRAPER_SSH_HOST}" "find \${SCRAPER_REPO_ROOT}/outputs/<run_dir> -name annotation_status.json \
  -exec grep -l '\"status\": \"failed\"' {} \\; \
  | xargs rm -f"
```

---

## 6. Resume an interrupted annotation run

### Via the dashboard

Use the **Resume** control in the dashboard (Operations panel → resume after rank N). The dashboard passes `resume_after_rank` to the orchestrator, which resumes the categorized dataset CSV from rank `N + 1`.

### Via CLI

If the run was started from the default categorized dataset:

```bash
# Check the last completed rank in the output summary
cat outputs/<run_dir>/summary.json | python3 -c 'import json,sys; s=json.load(sys.stdin); print(s.get("last_rank","?"))'

# Resubmit with resume_after_rank
ssh "${SCRAPER_SSH_HOST}" "bash -lc '
  cd \${SCRAPER_REPO_ROOT}
  .venv/bin/python -m privacy_research_dataset.cli \
    --top-n 10000 \
    --resume-after-rank <N> \
    --out-dir outputs/<run_dir> \
    <other flags>
'"
```

### Per-site annotation status

Each site's annotation state is stored at:
```
outputs/<run_dir>/<site>/annotation_status.json
```

Fields: `status`, `phase`, `model`, `updated_at`, `finished_at`, `reason`, `error`.

Valid terminal statuses (will not be re-processed): `completed`, `failed`, `stopped`.

To force a specific site to be re-annotated:
```bash
ssh "${SCRAPER_SSH_HOST}" "rm outputs/<run_dir>/<site>/annotation_status.json"
```

---

## 7. Troubleshooting playbook

### Step 1 — Quick health check

```bash
hpc/scraper/check_bridge.sh
```

Tells you: local port binding, tunnel processes, bridge `/health` result, local tunnel target vs Slurm node.

Check for **Rev match** — if local and remote revisions differ, redeploy:
```bash
hpc/scraper/refresh_remote.sh
```

### Step 2 — Full validation sweep

```bash
hpc/scraper/validate_cpu_bridge.sh
```

7 checks with pass/fail/skip summary. Captures: bridge health, service status, annotation stats, remote Python runtime, annotation model endpoint, bridge script, Slurm snapshot.

Get machine-readable output:
```bash
hpc/scraper/validate_cpu_bridge.sh --json
```

### Step 3 — Common failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Bridge health probe failed` | Tunnel not open or orchestrator not running | `attach_tunnel.sh` or `refresh_remote.sh` |
| `stale tunnel target` | Orchestrator moved to a new node | `attach_tunnel.sh` |
| `Rev match: NO` | Remote running an old code version | `refresh_remote.sh` |
| `/api/status` returns `idle` when a run should be active | Run finished or orchestrator restarted | Check `outputs/<run>/summary.json`; resubmit if needed |
| Annotation model `/health` unreachable locally (step 5 skipped) | Model is on a different node — this is normal | Export `SCRAPER_LLM_BASE_URL` if you need to override |
| `remote python runtime fail` | venv missing or broken | `ssh "${SCRAPER_SSH_HOST}" 'hpc/scraper/install_remote.sh'` |
| `Missing apptainer in PATH` in the Slurm log | Batch shell did not load the cluster Apptainer module | Export `SCRAPER_APPTAINER_MODULE=<your module name>` and resubmit |
| Slurm job in `PENDING` forever | No GPU partition slots | Check `squeue` on cluster; wait or contact cluster admin |
| Dashboard stuck after tunnel reconnect | Bridge reconnect re-seeding not triggered | Refresh the dashboard page |
| Log shows `Future exception was never retrieved` with a Playwright navigation timeout | Crawl4AI leaked an internal navigation future | Current runtime suppresses this known noise; if it still appears after redeploy, capture the exact site and log snippet |

### Step 4 — Manual bridge probe

```bash
# Health
curl http://127.0.0.1:8910/health | python3 -m json.tool

# Service status
curl http://127.0.0.1:8910/api/status | python3 -m json.tool

# Annotation stats for current run
curl 'http://127.0.0.1:8910/api/annotation-stats?outDir=outputs/unified' | python3 -m json.tool

# Event stream (last 50 events)
curl 'http://127.0.0.1:8910/api/poll?after=0' | python3 -m json.tool
```

### Step 5 — Read orchestrator logs

```bash
# Find the most recent Slurm output file
# Direct manual sbatch runs usually write here unless you pass explicit Slurm
# --output/--error flags.
ssh "${SCRAPER_SSH_HOST}" 'ls -lt ~/slurm-*.out | head -5'

# Tail it
ssh "${SCRAPER_SSH_HOST}" 'tail -100 ~/slurm-<job_id>.out'

# Or follow live
ssh "${SCRAPER_SSH_HOST}" 'tail -f ~/slurm-<job_id>.out'
```

If you run `sbatch hpc/scraper/orchestrator.slurm` directly from the remote repo checkout, the script now infers `SCRAPER_REPO_ROOT`, `SCRAPER_REMOTE_ROOT`, runtime, and outputs paths from its own location. The helper scripts remain the preferred path because they still handle deploy, install, export injection, and tunnel setup for you.

---

## 8. Artifact retrieval

### List remote runs

```bash
hpc/scraper/pull_run.sh --list
```

### Pull a run

```bash
hpc/scraper/pull_run.sh <run_dir>
# e.g.
hpc/scraper/pull_run.sh unified
hpc/scraper/pull_run.sh smoke10_fix_114421
```

Files land in `outputs/hpc/<run_dir>/` locally.

### Verify artifact integrity

After pulling:

```bash
# Count annotated JSONL records
find outputs/hpc/<run_dir> -name 'annotated.jsonl' -exec wc -l {} + | sort -rn | head

# Check for any corrupt JSONL files (no valid JSON lines)
find outputs/hpc/<run_dir> -name 'annotated.jsonl' | while read f; do
  python3 -c "
import json, sys
valid = 0
for line in open('$f'):
    try: json.loads(line); valid += 1
    except: pass
if valid == 0:
    print('EMPTY/CORRUPT:', '$f')
"
done
```

### Remote annotation stats snapshot

```bash
curl -s 'http://127.0.0.1:8910/api/annotation-stats?outDir=outputs/<run_dir>' \
  | python3 -c '
import json, sys
p = json.load(sys.stdin)
print(f"Total: {p[\"total_sites\"]}  Annotated: {p[\"annotated_sites\"]}  Statements: {p[\"total_statements\"]}")
'
```

---

## 9. Environment variable reference

Host- and cluster-specific variables intentionally use placeholders in the tracked repo. Set them explicitly for your environment before deploying, preferably through `hpc/scraper/local.env`.

| Variable | Default | Description |
|----------|---------|-------------|
| `SCRAPER_SSH_HOST` | `your-user@login.your-hpc.example` | SSH hostname / alias |
| `SCRAPER_SERVICE_PORT` | `8910` | Local + remote orchestrator port |
| `SCRAPER_ORCH_JOB_NAME` | `scraper-orch` | Slurm job name for the orchestrator |
| `SCRAPER_SSH_SOCKET` | `/tmp/scraper-ssh-$USER.sock` | SSH ControlPath multiplexer socket |
| `SCRAPER_SSH_FORWARD_STATE` | `/tmp/scraper-ssh-forward-$USER-8910.target` | Last-known tunnel target node (persisted) |
| `SCRAPER_REMOTE_ROOT` | `/path/to/your/hpc/scraper` | Base directory on the cluster |
| `SCRAPER_REPO_ROOT` | `${SCRAPER_REMOTE_ROOT}/repo` | Cloned repo root on the remote |
| `SCRAPER_OUTPUTS_ROOT` | `${SCRAPER_REPO_ROOT}/outputs` | Remote outputs root |
| `SCRAPER_PYTHON_MODULE` | `Python/3.12.3-GCCcore-13.3.0` | Optional environment module loaded by install / Slurm |
| `SCRAPER_APPTAINER_MODULE` | unset | Optional Apptainer/Singularity module loaded by install / Slurm |
| `SCRAPER_SBATCH_EXTRA_ARGS` | unset | Extra `sbatch` flags. Use this for cluster-specific account/partition settings and to request more CPU/RAM (for example `--cpus-per-task=32 --mem=112G`). |
| `SCRAPER_LOCAL_OUTPUTS_ROOT` | `${ROOT_DIR}/outputs/hpc` | Local destination for `pull_run.sh` |
| `SCRAPER_PYTHON` | `${SCRAPER_REMOTE_ROOT}/.venv/bin/python` | Python interpreter on the remote |
| `SCRAPER_LLM_BASE_URL` | auto-detected | Annotation model OpenAI-compatible base URL |
| `SCRAPER_LLM_HEALTH_URL` | auto-detected | Annotation model health probe URL |
| `SCRAPER_LLM_MODEL_PORT` | `8901` | Port used by `validate_cpu_bridge.sh` to probe the model |

---

## 10. Script reference

| Script | Purpose |
|--------|---------|
| `_ssh_common.sh` | Shared SSH config (source, do not execute) |
| `_deploy_common.sh` | Shared deploy functions (source, do not execute) |
| `push_code.sh` | Rsync local repo to remote |
| `install_remote.sh` | Build / refresh the remote Python venv |
| `orchestrator.slurm` | Slurm batch script for the aiohttp control plane |
| `launch_remote.sh` | Full deploy + foreground blocking tunnel |
| `refresh_remote.sh` | Full deploy + non-blocking tunnel (for Electron / automation) |
| `attach_tunnel.sh` | Reattach local port 8910 to the running orchestrator node |
| `check_bridge.sh` | Quick bridge/tunnel status; `--json` for structured output |
| `validate_cpu_bridge.sh` | 7-step CPU-safe validation sweep; `--json` for summary |
| `pull_run.sh` | List or rsync a run from the remote to local storage |

Branch automation:
- `main` is the default branch to deploy
