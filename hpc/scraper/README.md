# HPC Scraper Deployment

This folder contains the Slurm and deployment assets for the `hpc-v` cluster-backed scraper stack.

Files:

- `orchestrator.slurm`: long-lived control-plane job on `compute/default-cpu`
- `install_remote.sh`: remote bootstrap for the Python runtime and the PostgreSQL Apptainer image
- `launch_remote.sh`: local helper that rsyncs this branch to Toubkal, installs the runtime, submits the orchestrator, and opens the `8910` SSH tunnel

Remote target:

`/srv/lustre01/project/vr_outsec-vh2sz1t4fks/users/soufiane.essahli/scraper`

Usage:

```bash
hpc/scraper/launch_remote.sh
```

The dashboard backend then talks to `http://127.0.0.1:8910`.
