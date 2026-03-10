# Privacy Research Dataset

A research pipeline that crawls websites, discovers and extracts their privacy policies, maps observed third-party trackers to known entities, and annotates policy text with structured statements using a local LLM. An Electron dashboard provides a full UI for launching, monitoring, and inspecting runs.

---

## What it does

**Stage 1 — Scraping**
- Fetches the home page of each site and discovers its first-party privacy policy URL
- Extracts clean policy text via Trafilatura / Readability
- Observes third-party network requests and maps domains to tracker entities (via DuckDuckGo Tracker Radar or Ghostery TrackerDB)
- Fetches and extracts third-party policy text where available
- Deduplicates artifacts: if two sites share the same policy URL, the text is scraped and cleaned once

**Stage 2 — LLM Annotation**
- Preprocesses policy text into chunks (pandoc AST → overlapping token windows)
- Runs iterative extraction with DeepSeek-R1-70B on a local HPC GPU node via SSH tunnel (port 8901)
- Produces structured statements: `action`, `data`, `processor`, `purpose`, `context`, `prohibition`
- Streams chain-of-thought reasoning live to the dashboard UI

**Dashboard (Electron + React)**
- Launch and monitor Stage 1 scrapes with live progress, ETA, and log window
- Run Stage 2 annotation with live streaming: reasoning panel, extraction output, and color-coded entity chips
- Explore results by site, policy, and third-party entity
- Audit workspace for per-site re-scraping and re-annotation
- Run history with per-folder load/delete
- Settings: themes, CrUX filter toggle, entity filter, mapping mode

---

## Repository layout

```
privacy_research_dataset/   # core Python package (scraper + annotator)
scripts/                    # index builders, Tranco helpers
tracker-radar/              # DuckDuckGo Tracker Radar (clone here)
trackerdb/                  # Ghostery TrackerDB (clone here, optional)
dashboard/                  # Electron + Vite UI
outputs/                    # per-run output folders
hpc/                        # HPC job scripts (DeepSeek tunnel)
```

---

## Installation

### Requirements

- Python 3.10+
- conda (recommended) or venv
- Node.js 18+
- pandoc (for policy text preprocessing)
- An active conda environment with the package installed

### Python setup

```bash
# create and activate environment
conda create -n privacy python=3.11
conda activate privacy

# install the package + dependencies
pip install -e .

# Crawl4AI uses Playwright for browser automation
python -m playwright install chromium
```

### Build tracker indexes

```bash
# DuckDuckGo Tracker Radar (required for entity mapping)
git clone https://github.com/duckduckgo/tracker-radar.git tracker-radar
python scripts/build_tracker_radar_index.py \
  --tracker-radar-dir tracker-radar --out tracker_radar_index.json

# Ghostery TrackerDB (optional, used as fallback)
git clone https://github.com/ghostery/trackerdb trackerdb
python scripts/build_trackerdb_index.py \
  --trackerdb-dir trackerdb --out trackerdb_index.json
```

---

## Running the dashboard

```bash
cd dashboard
npm install
npm run dev
```

The dashboard launches the scraper and annotator as subprocesses. If `python` on PATH is not the right environment, point to it explicitly:

```bash
export PRIVACY_DATASET_PYTHON=/path/to/conda/envs/privacy/bin/python
```

---

## HPC tunnel (Stage 2 annotation)

Stage 2 uses DeepSeek-R1-Distill-Llama-70B served by llama.cpp on a GPU node. Open the SSH tunnel before running annotation:

```bash
ssh -N -f -L 8901:<gpu-node>:8901 <user>@toubkal.hpc.um6p.ma
```

The dashboard polls `http://localhost:8901/health` every 15 s and shows **Tunnel active / offline** in the annotation controls. Annotation is blocked until the tunnel is reachable.

---

## CLI usage (without dashboard)

**Stage 1 — scrape**

```bash
privacy-dataset \
  --tranco-top 100 \
  --tranco-date 2026-01-01 \
  --tracker-radar-index tracker_radar_index.json \
  --trackerdb-index trackerdb_index.json \
  --out outputs/results.jsonl \
  --artifacts-dir outputs/artifacts
```

**Stage 2 — annotate**

```bash
privacy-dataset-annotate \
  --artifacts-dir outputs/artifacts \
  --concurrency 3
```

---

## Output structure

Each run stores its files under `outputs/output_<runid>/`:

| File | Contents |
|---|---|
| `results.jsonl` | Per-site scrape results |
| `results.summary.json` | Aggregated counts and mapping stats |
| `run_state.json` | Live run counters |
| `explorer.jsonl` | Site + policy + third-party data for the Explorer tab |
| `artifacts/<site>/policy.txt` | Extracted policy text |
| `artifacts/<site>/policy_statements.jsonl` | Annotated statements |

---

## Troubleshooting

**Dashboard cannot start the scraper**
Set `PRIVACY_DATASET_PYTHON` to the full path of the Python interpreter in the correct conda environment.

**Annotation shows "Tunnel offline"**
Start the SSH tunnel as shown above. The health check hits `http://localhost:8901/health`.

**No results in the Explorer tab**
Make sure the run was started from the dashboard or used `--explorer-out` and `--emit-events` flags.

**CrUX filter returns 403**
Enable the Chrome UX Report API for your key in Google Cloud Console.
