# Privacy Research Dataset: HPC Branch Guide

This branch is configured for Toubkal-first operation.
The scraper runtime lives on the cluster. The dashboard stays on your workstation and talks to the cluster through an SSH tunnel on port `8910`.

## How It Works

The runtime is split into two parts:

- Local workstation:
  - Electron dashboard in `dashboard/`
  - SSH tunnel bound to `127.0.0.1:8910`
  - Optional LLM endpoint for annotation on `127.0.0.1:8901`
- Toubkal cluster:
  - Slurm orchestrator job in [`hpc/scraper/orchestrator.slurm`](/mnt/storage/projects/hpc/scraper/orchestrator.slurm)
  - Control API in [`privacy_research_dataset/hpc_service.py`](/mnt/storage/projects/privacy_research_dataset/hpc_service.py)
  - PostgreSQL container started through Apptainer
  - Scraper and annotator subprocesses launched by the control API

Control flow:

1. Run [`hpc/scraper/launch_remote.sh`](/mnt/storage/projects/hpc/scraper/launch_remote.sh) from your workstation.
2. It syncs the scraper payload to Toubkal under:
   `/srv/lustre01/project/vr_outsec-vh2sz1t4fks/users/soufiane.essahli/scraper`
3. It installs or refreshes the remote Python runtime.
4. It submits the Slurm orchestrator job.
5. Once the job is running, it opens the SSH tunnel on local port `8910`.
6. The dashboard connects to `http://127.0.0.1:8910` and stays locked until the remote API and database are healthy.

## Cluster Layout

Remote root:

`/srv/lustre01/project/vr_outsec-vh2sz1t4fks/users/soufiane.essahli/scraper`

Important paths:

- `repo/`: synced scraper code
- `runtime/`: PostgreSQL data, Apptainer image, Playwright browsers
- `logs/`: Slurm stdout/stderr logs
- `repo/outputs/`: scrape outputs and artifacts

Only the scraper payload is deployed remotely. The dashboard is not copied to the cluster.

## What You Should Do

### 1. Start the remote stack

From the repository root on your workstation:

```bash
hpc/scraper/launch_remote.sh
```

This is the main entrypoint for the branch.

### 2. Start the local dashboard

In a separate terminal:

```bash
cd dashboard
export PRIVACY_DATASET_PYTHON="$PWD/../.venv/bin/python"
npm run dev
```

The dashboard should remain on the launcher until:

- the SSH tunnel is up
- the remote control API answers
- PostgreSQL is ready inside the Slurm job

### 3. Launch remote scrapes from the dashboard

Use the launcher view to start runs.
The dashboard sends commands to the remote control plane, not to local scraper subprocesses.

Outputs are written remotely under:

`/srv/lustre01/project/vr_outsec-vh2sz1t4fks/users/soufiane.essahli/scraper/repo/outputs`

### 4. Use annotation only when the LLM endpoint is available

Annotation expects an OpenAI-compatible endpoint on local port `8901`.
That can be:

- local on your workstation
- forwarded from another remote node through SSH

If the LLM endpoint is down, scraping can still work, but annotation should stay unused.

## Slurm Design

The orchestrator job is intentionally small so it starts fast:

- partition: `compute`
- qos: `intr`
- account: `vr_outsec-vh2sz1t4fks-default-cpu`
- tasks: `1`
- cpus per task: `2`
- memory: `6G`
- walltime: `00:10:00`

The orchestrator itself does not perform the full scrape workload directly. It provides the remote control plane, starts PostgreSQL, and launches scraper or annotator subprocesses when requested by the dashboard.

## Files That Matter In This Branch

- [`hpc/scraper/launch_remote.sh`](/mnt/storage/projects/hpc/scraper/launch_remote.sh)
  - Syncs the remote payload, prunes redundant files, installs runtime, submits Slurm, opens the tunnel.
- [`hpc/scraper/install_remote.sh`](/mnt/storage/projects/hpc/scraper/install_remote.sh)
  - Creates the remote venv, installs the package, installs Playwright Chromium, and pulls the PostgreSQL Apptainer image.
- [`hpc/scraper/orchestrator.slurm`](/mnt/storage/projects/hpc/scraper/orchestrator.slurm)
  - Slurm entrypoint for the control plane job.
- [`privacy_research_dataset/hpc_service.py`](/mnt/storage/projects/privacy_research_dataset/hpc_service.py)
  - Remote API, PostgreSQL lifecycle, scraper launch, annotator launch, event polling.
- [`dashboard/electron/main.ts`](/mnt/storage/projects/dashboard/electron/main.ts)
  - Local bridge client that talks to `127.0.0.1:8910`.

## Outputs

Each remote run writes into its output directory under `repo/outputs/`.
Typical files are:

- `results.jsonl`
- `results.summary.json`
- `run_state.json`
- `explorer.jsonl`
- `dashboard_run_manifest.json`
- `audit_state.json`
- `artifacts/`
- `artifacts_ok/`

## Troubleshooting

### Tunnel is down

Run:

```bash
hpc/scraper/launch_remote.sh
```

The dashboard should not be used until port `8910` is back and the launcher reports the bridge as healthy.

### Dashboard stays locked

Check:

- the SSH tunnel is alive
- the Slurm orchestrator job is running
- the remote API answers on `/health`
- PostgreSQL came up inside the allocation

### Scrape starts and fails immediately

Check:

- the remote runtime exists under `.../scraper/.venv`
- Playwright browsers exist under `.../scraper/runtime/playwright-browsers`
- the orchestrator environment exports `PLAYWRIGHT_BROWSERS_PATH`

### Annotation is unavailable

Check:

- an OpenAI-compatible endpoint is reachable on `127.0.0.1:8901`
- any required SSH forwarding for the model endpoint is active

## Summary

For this branch, the operating model is simple:

1. Start the remote stack with `hpc/scraper/launch_remote.sh`.
2. Run the dashboard locally.
3. Wait for the bridge to go healthy.
4. Launch and monitor remote runs through the dashboard.
