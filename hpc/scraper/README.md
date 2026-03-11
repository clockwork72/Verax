# HPC Scraper Scripts

This folder contains the scripts used to deploy, run, and retrieve scraper jobs on Toubkal.

For the full branch workflow, read the top-level guide:

- [`README.md`](/mnt/storage/projects/README.md)
- [`scripts/sync_main_to_hpc.sh`](/mnt/storage/projects/scripts/sync_main_to_hpc.sh)

Quick meaning of each script:

- [`push_code.sh`](/mnt/storage/projects/hpc/scraper/push_code.sh)
  - sync local scraper code to Toubkal
  - uses one shared SSH control socket so sync normally authenticates once
- [`install_remote.sh`](/mnt/storage/projects/hpc/scraper/install_remote.sh)
  - build or refresh the remote runtime
- [`orchestrator.slurm`](/mnt/storage/projects/hpc/scraper/orchestrator.slurm)
  - start the remote control-plane job
- [`launch_remote.sh`](/mnt/storage/projects/hpc/scraper/launch_remote.sh)
  - push code, install runtime, submit the job, and open the tunnel
  - reuses the same SSH session across deploy steps to reduce repeated MFA prompts
- [`pull_run.sh`](/mnt/storage/projects/hpc/scraper/pull_run.sh)
  - list remote runs or copy one run back to local storage
  - also reuses the shared SSH control socket during one pull

Branch automation:

- pushes to `main` trigger [sync-main-into-hpc.yml](/mnt/storage/projects/.github/workflows/sync-main-into-hpc.yml)
- that workflow runs [`scripts/sync_main_to_hpc.sh`](/mnt/storage/projects/scripts/sync_main_to_hpc.sh)
- clean merges are pushed automatically into `hpc-v`
- `hpc-v` is the branch that should be deployed to Toubkal

Common commands:

```bash
hpc/scraper/push_code.sh
hpc/scraper/launch_remote.sh
hpc/scraper/pull_run.sh --list
hpc/scraper/pull_run.sh <run_dir>
```
