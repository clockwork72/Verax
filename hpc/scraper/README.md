# HPC Scraper Scripts

This folder contains the scripts used to deploy, run, and retrieve scraper jobs on Toubkal.

For the full branch workflow, read the top-level guide:

- [`README.md`](/mnt/storage/projects/README.md)
- [`scripts/sync_main_to_hpc.sh`](/mnt/storage/projects/scripts/sync_main_to_hpc.sh)

Quick meaning of each script:

- [`push_code.sh`](/mnt/storage/projects/hpc/scraper/push_code.sh)
  - sync local scraper code to Toubkal
- [`install_remote.sh`](/mnt/storage/projects/hpc/scraper/install_remote.sh)
  - build or refresh the remote runtime
- [`orchestrator.slurm`](/mnt/storage/projects/hpc/scraper/orchestrator.slurm)
  - start the remote control-plane job
- [`launch_remote.sh`](/mnt/storage/projects/hpc/scraper/launch_remote.sh)
  - push code, install runtime, submit the job, and open the tunnel
- [`pull_run.sh`](/mnt/storage/projects/hpc/scraper/pull_run.sh)
  - list remote runs or copy one run back to local storage

Common commands:

```bash
hpc/scraper/push_code.sh
hpc/scraper/launch_remote.sh
hpc/scraper/pull_run.sh --list
hpc/scraper/pull_run.sh <run_dir>
```
