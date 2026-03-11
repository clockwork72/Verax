# HPC Scraper Deployment

This folder contains the Slurm and deployment assets for the `hpc-v` cluster-backed scraper stack.

Files:

- `orchestrator.slurm`: long-lived control-plane job on `compute/intr`
- `install_remote.sh`: remote bootstrap for the Python runtime and the PostgreSQL Apptainer image
- `launch_remote.sh`: local helper that syncs only the scraper payload to Toubkal, prunes local-only files from the remote repo, installs the runtime, submits the orchestrator, and opens the `8910` SSH tunnel

Remote target:

`/srv/lustre01/project/vr_outsec-vh2sz1t4fks/users/soufiane.essahli/scraper`

Usage:

```bash
hpc/scraper/launch_remote.sh
```

Remote sync is intentionally limited to the scraper runtime:

- `privacy_research_dataset/`
- `scripts/`
- `hpc/`
- `pyproject.toml`
- `tracker_radar_index.json`
- `trackerdb_index.json`
- `README.md`

The dashboard is not deployed to Toubkal. It stays local and talks to `http://127.0.0.1:8910` through the SSH tunnel opened by `launch_remote.sh`.
