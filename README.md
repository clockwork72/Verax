# Privacy Research Dataset: HPC Workflow Guide

This branch is meant to run the scraper on a Slurm-based HPC cluster.

Prerequisite: you need your own HPC account, SSH access to the cluster login host, and a writable remote project directory. The tracked scripts use placeholder defaults for host- and cluster-specific values, so copy [local.env.example](/mnt/storage/projects/hpc/scraper/local.env.example) to `hpc/scraper/local.env` and set `SCRAPER_SSH_HOST`, `SCRAPER_REMOTE_ROOT`, and any site-specific Slurm options for your environment before deploying.

The key idea is simple:

- you develop and use the dashboard locally
- the scraper service runs remotely inside a Slurm job
- the local dashboard talks to the remote service through an SSH tunnel on port `8910`
- remote outputs stay on the cluster unless you explicitly pull them back

## Mental Model

There are two environments in this workflow.

### 1. Your local workstation

This is where you:

- edit code
- commit code
- run the Electron dashboard
- open the SSH tunnel to the cluster
- optionally run or tunnel an LLM endpoint for annotation on port `8901`

Important local paths:

- [`dashboard/`](/mnt/storage/projects/dashboard)
- [`hpc/scraper/`](/mnt/storage/projects/hpc/scraper)
- local repo root: `/mnt/storage/projects`

### 2. Your HPC cluster

This is where the scraping runtime lives.

The deployed remote root is:

`${SCRAPER_REMOTE_ROOT}`

Important remote paths:

- `repo/`: deployed code mirror
- `runtime/`: PostgreSQL data, Apptainer image, Playwright browsers
- `logs/`: Slurm logs
- `repo/outputs/`: run outputs
- [`docs/hpc_architecture_audit.md`](/mnt/storage/projects/docs/hpc_architecture_audit.md): checked-in architecture and baseline audit for the hardening wave

The remote repo is a deployment mirror, not the source of truth.
You should treat local code as authoritative and remote code as disposable.

## Branch Strategy

Use `main` as the primary deployable branch.

Use `main` as the single deployable branch for this workflow.

## Architecture

The branch works like this:

1. You push the scraper payload from local to the remote mirror.
2. A Slurm job starts the orchestrator on a compute node.
3. The orchestrator starts PostgreSQL in Apptainer.
4. The orchestrator runs the control API from [`hpc_service.py`](/mnt/storage/projects/privacy_research_dataset/hpc_service.py).
5. Your workstation opens an SSH tunnel from local `127.0.0.1:8910` to the compute node service.
6. The Electron app probes `http://127.0.0.1:8910`.
7. When the API and database are healthy, the dashboard unlocks.
8. Scrape and annotation actions from the dashboard are executed remotely.

Important separation:

- port `8910` is the scraper control-plane bridge
- port `8901` is only the default annotation model endpoint

They are not the same service.
Having a healthy scraper bridge on `8910` does not automatically mean an annotation model is reachable on `8901`.

## Files That Matter

### Deployment and runtime

- [`hpc/scraper/push_code.sh`](/mnt/storage/projects/hpc/scraper/push_code.sh)
  - Pushes the scraper payload from local to your HPC deployment mirror.
  - Prunes remote folders that should not live on the cluster.
  - Reuses a single SSH control connection so deployment usually needs only one MFA/TOTP challenge.
- [`hpc/scraper/launch_remote.sh`](/mnt/storage/projects/hpc/scraper/launch_remote.sh)
  - Pushes code, refreshes the remote runtime, submits the Slurm job, and opens the local SSH tunnel.
  - Reuses the same SSH control socket across deploy and scheduler calls to avoid repeated authentication prompts.
- [`hpc/scraper/install_remote.sh`](/mnt/storage/projects/hpc/scraper/install_remote.sh)
  - Builds the remote Python environment, installs Playwright Chromium, and pulls the PostgreSQL container image.
- [`hpc/scraper/orchestrator.slurm`](/mnt/storage/projects/hpc/scraper/orchestrator.slurm)
  - Slurm entrypoint for the remote control plane.
- [`privacy_research_dataset/hpc_service.py`](/mnt/storage/projects/privacy_research_dataset/hpc_service.py)
  - Remote control API, event bus, PostgreSQL lifecycle, scraper launch, annotator launch.

### Data movement

- [`hpc/scraper/pull_run.sh`](/mnt/storage/projects/hpc/scraper/pull_run.sh)
  - Lists remote runs or copies one remote output folder back to local `outputs/hpc/`.
  - Also reuses the SSH control socket so listing or copying runs does not repeatedly re-authenticate during one operation.

### Local UI

- [`dashboard/electron/main.ts`](/mnt/storage/projects/dashboard/electron/main.ts)
  - Local bridge client that talks to `127.0.0.1:8910`.

## What Gets Synced To The HPC Mirror

Only the scraper payload is deployed remotely.

Included:

- `privacy_research_dataset/`
- `scripts/`
- `hpc/`
- `README.md`
- `pyproject.toml`
- `requirements.txt`
- `tracker_radar_index.json`
- `trackerdb_index.json`

Not deployed:

- `dashboard/`
- `tests/`
- local caches
- tracker source checkouts
- build artifacts

That split is intentional. The dashboard stays local.

## Normal Workflow

This is the default workflow most people should follow.

### Step 1. Edit code locally

Make all code changes in your local repo:

`/mnt/storage/projects`

Do not use the remote repo on the cluster as a second development checkout.

### Step 2. Push code to the HPC cluster

From the local repo root:

```bash
hpc/scraper/push_code.sh
```

This updates the remote mirror without launching a job.

`push_code.sh` now opens one shared SSH master connection for the whole sync, so the normal expectation is one MFA prompt per deployment instead of one prompt per `ssh` or `rsync` subcommand.

### Step 3. Start or restart the remote stack

If you want the full flow from local, use:

```bash
hpc/scraper/launch_remote.sh
```

This does four things:

1. pushes code
2. refreshes the remote runtime
3. submits the orchestrator Slurm job
4. opens the SSH tunnel on local port `8910`

This is the easiest entrypoint.
It is also the preferred path when MFA is enabled, because the script now reuses one SSH control socket across the whole deployment.

### Step 4. Start the local dashboard

In another local terminal:

```bash
cd dashboard
export PRIVACY_DATASET_PYTHON="$PWD/../.venv/bin/python"
npm run dev
```

The dashboard should stay on the launcher until the bridge is healthy.

### Step 5. Launch runs from the dashboard

Use the dashboard launcher to start scrapes.
Those actions do not start local scraper processes.
They are sent through the bridge to the remote service on the cluster.

### Step 6. Configure annotation model reachability if you want Stage 2

Annotation uses a separate OpenAI-compatible model endpoint.

Default expectation:

- API base URL: `http://localhost:8901/v1`
- health URL: `http://localhost:8901/health`

If the model is not running on the same node as the annotator, set these before running `launch_remote.sh`:

```bash
export SCRAPER_LLM_BASE_URL="http://<model-host>:<model-port>/v1"
export SCRAPER_LLM_HEALTH_URL="http://<model-host>:<model-port>/health"
```

`launch_remote.sh` will pass them through to the Slurm job as:

- `PRIVACY_LLM_BASE_URL`
- `PRIVACY_LLM_HEALTH_URL`

This keeps the annotation logs honest and prevents the annotator from pretending that the scraper bridge on `8910` is the model endpoint.

### Step 7. Pull back results only if needed

To see what runs exist remotely:

```bash
hpc/scraper/pull_run.sh --list
```

To copy one run back to your local machine:

```bash
hpc/scraper/pull_run.sh <run_dir>
```

That pulls the run into:

`outputs/hpc/<run_dir>/`

## If You Launch The Slurm Job Directly On The Cluster

Sometimes you may submit the orchestrator manually from the HPC side.
That is fine, but the dashboard will still stay offline until your local machine opens the SSH tunnel.

### Remote-side commands

On the cluster:

```bash
cd "${SCRAPER_REPO_ROOT}"
bash hpc/scraper/install_remote.sh
sbatch hpc/scraper/orchestrator.slurm
```

The job log prints the compute node name and a suggested tunnel command.

### Local-side tunnel

After the job is running, open the tunnel from your workstation:

```bash
hpc/scraper/attach_tunnel.sh
```

That script resolves the currently running `scraper-orch` node, kills stale local `8910` forwards, and reopens the tunnel.

If you need to target a specific node manually, you can still do it directly:

```bash
ssh -fNT -L 8910:<compute-node>:8910 "${SCRAPER_SSH_HOST}"
```

Then verify locally:

```bash
curl http://127.0.0.1:8910/health
```

If this does not return JSON, the dashboard will stay red.

## Reattaching To An Existing Running Orchestrator

If the Slurm job is already running and you only need to reconnect locally, you do not need to resubmit it.

You only need:

1. the compute node name
2. a local SSH tunnel to port `8910`

Once the tunnel is back, the dashboard should recover automatically.

## Slurm Profile

The orchestrator job is intentionally lightweight so it can start quickly:

- partition: `compute`
- nodes: `1`
- tasks: `1`
- cpus per task: `24`
- walltime: `02:00:00`

If your cluster requires an account, QoS, memory limit, or different partition, set those according to local policy before submitting the job.

The orchestrator is not the heavy crawler itself.
It is a control-plane job that starts the database and launches remote subprocesses on demand.

## Outputs

Remote outputs live under:

`${SCRAPER_REPO_ROOT}/outputs`

Typical run contents:

- `results.jsonl`
- `results.summary.json`
- `run_state.json`
- `explorer.jsonl`
- `dashboard_run_manifest.json`
- `audit_state.json`
- `artifacts/`
- `artifacts_ok/`

## Recommended File Management Rules

Follow these rules to avoid drift and confusion:

### Code

- write code locally
- commit code locally
- merge feature work into `main`
- push code to the cluster with `push_code.sh`
- avoid editing remote code directly

### Branches

- treat `main` as the primary application and deployment branch
- keep any optional HPC-only branch isolated and intentionally maintained
- use the sync workflow only if your team actually keeps that split branch model

### Remote repo

- treat the remote repo as a deployment mirror
- it may be deleted and recreated
- do not rely on it as a persistent development checkout

### Runtime state

- keep PostgreSQL data in `runtime/`
- keep Playwright browsers in `runtime/`
- keep Slurm logs in `logs/`
- keep scraper outputs in `repo/outputs/`

### Results

- leave large result sets on the cluster
- pull back only the runs you actually need

## How To Know The System Is Healthy

The bridge is healthy when all of the following are true:

- the Slurm orchestrator job is running
- your local machine has a tunnel on `127.0.0.1:8910`
- `curl http://127.0.0.1:8910/health` returns JSON
- the dashboard launcher shows the bridge as active
- PostgreSQL is reported ready
- the remote orchestrator was launched from the current local code revision

## Troubleshooting

### The orchestrator job is running, but the dashboard is red

Most likely cause:

- the SSH tunnel is missing on your local machine

Check locally:

```bash
hpc/scraper/check_bridge.sh
```

If nothing is listening locally, open the tunnel.

### The dashboard says the bridge is offline

Check:

- the Slurm job is still running
- the correct compute node is being tunneled
- local port `8910` is actually forwarded

Fast repair:

```bash
hpc/scraper/attach_tunnel.sh
```

Inside the Electron dashboard, the Launcher and Settings bridge cards expose `Diagnose` and `Repair bridge` buttons that run these same local helpers. If TOTP or another SSH verification step is required, the app opens a prompt for the code; if the flow still fails, the dashboard shows the failure output and hint instead of silently hanging.

### Deployment keeps asking for TOTP multiple times

The scripts now try to avoid that by reusing a single SSH control socket.

If you still see repeated prompts, check:

- you are using the current versions of `push_code.sh`, `pull_run.sh`, and `launch_remote.sh`
- no stale SSH socket path is conflicting with the current one
- the login host did not drop the master connection mid-run

### Scrape fails immediately after starting

Check the remote runtime:

- `.../scraper/.venv` exists
- `.../scraper/runtime/playwright-browsers` exists
- `PLAYWRIGHT_BROWSERS_PATH` is being set by the orchestrator

### Annotation does not work

Check:

- the annotation model endpoint is reachable from where the annotator is running
- if the annotator is remote, set `SCRAPER_LLM_BASE_URL` and `SCRAPER_LLM_HEALTH_URL` before launching the orchestrator
- if you intentionally use the default endpoint, confirm `http://localhost:8901/health` is valid in the annotator environment

### I changed code locally, but the cluster still behaves like the old version

You probably forgot to redeploy.

Run:

```bash
hpc/scraper/push_code.sh
```

Then restart the orchestrator if needed.

### A change exists on GitHub but is missing locally

Fetch the latest `main` changes and redeploy from `main`.

## Quick Reference

Push code only:

```bash
hpc/scraper/push_code.sh
```

Push, submit, and tunnel:

```bash
hpc/scraper/launch_remote.sh
```

List remote runs:

```bash
hpc/scraper/pull_run.sh --list
```

Pull one run:

```bash
hpc/scraper/pull_run.sh <run_dir>
```

Start dashboard locally:

```bash
cd dashboard
export PRIVACY_DATASET_PYTHON="$PWD/../.venv/bin/python"
npm run dev
```
