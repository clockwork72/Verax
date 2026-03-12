# HPC Scraper Architecture Audit

## Scope
This dossier captures the current CPU-safe architecture baseline for the local-dashboard to HPC-orchestrator workflow. It is the freeze point for the backend-first hardening wave.

## Runtime Topology
- Local workstation runs the Electron dashboard and keeps the SSH control socket plus local tunnel on `127.0.0.1:8910`.
- Slurm runs exactly one orchestrator job (`scraper-orch`) on a compute node.
- The orchestrator hosts the aiohttp control API and a local PostgreSQL instance inside Apptainer.
- The annotation model endpoint is separate from the scraper bridge and is expected on `PRIVACY_LLM_BASE_URL` / `PRIVACY_LLM_HEALTH_URL`.

## Flow Map
### Scraper run flow
1. Dashboard calls Electron preload IPC.
2. Electron main proxies the request to the HPC service on port `8910`.
3. `privacy_research_dataset.hpc_service` starts the scraper CLI and streams stdout/stderr into the in-memory event buffer.
4. Dashboard reconstructs run state from `/api/status`, `/api/poll`, summary/state/results files, and ad hoc event listeners.

### Annotation flow
1. Dashboard starts annotation through `/api/start-annotate` or `/api/annotate-site`.
2. `annotate_cli.py` enumerates policy dirs and writes per-site JSONL artifacts.
3. Completion is authoritative through `annotation_complete.json`; non-empty annotated JSONL remains the legacy fallback.
4. The current hardening branch also writes `annotation_status.json` to expose resumable per-site state.

### Bridge / tunnel flow
1. `launch_remote.sh` or `refresh_remote.sh` submits the Slurm job and relies on the shared SSH control socket.
2. `attach_tunnel.sh` rebinds local port `8910` to the active compute node.
3. `check_bridge.sh` validates the port listener, health probe, and Slurm node alignment.

## Current Contracts
### Control-plane endpoints
- `/health`: service, database, node, revision, and current output directory snapshot.
- `/api/status`: run and annotator liveness snapshot.
- `/api/poll`: in-memory event stream with cursor semantics.
- `/api/annotation-stats`: aggregate annotation counts plus per-site and per-third-party state.
- `/api/list-runs`, `/api/summary`, `/api/state`, `/api/results`, `/api/explorer`, `/api/artifact-text`: artifact browsing surface.

### Event channels
- `scraper:event`
- `scraper:log`
- `scraper:error`
- `scraper:exit`
- `annotator:log`
- `annotator:stream`
- `annotator:exit`
- `pipeline:event` is the normalized envelope channel introduced by this hardening wave.

### Output contracts
- Stage 1 artifacts: `policy.txt`, `policy.extraction.json`, scrape markers, third-party subdirs.
- Stage 2 artifacts: `document.json`, `policy_statements.jsonl`, `policy_statements_annotated.jsonl`, `annotation_complete.json`, `annotation_status.json`.

## Concentrated Risks
- `dashboard/src/App.tsx` remains the primary state hub and still contains mixed transport, state, and presentation logic.
- `privacy_research_dataset/hpc_service.py` owns transport, process lifecycle, artifact reads, and operational endpoints in one service module.
- The dashboard still has no full state-store abstraction and historically relied on log parsing as a truth source.
- The bridge helpers are shell-based and must remain idempotent across shared-control-socket reuse.

## Baseline Verification Commands
```bash
pytest -q tests
cd dashboard && npm run build
bash hpc/scraper/check_bridge.sh
curl -fsS http://127.0.0.1:8910/health
curl -fsS http://127.0.0.1:8910/api/status
ssh -o ControlMaster=auto -o ControlPersist=10m -o ControlPath=/tmp/scraper-ssh-${USER}.sock toubkal 'squeue -u "$USER" -o "%.10i %.10T %.20j %.25N"'
bash hpc/scraper/validate_cpu_bridge.sh
```
