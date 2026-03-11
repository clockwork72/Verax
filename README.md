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
- Runs iterative extraction with a local LLM served via an OpenAI-compatible API (default: port 8901)
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
hpc/                        # HPC job scripts (optional)
```

---

## Installation (Ubuntu)

### System requirements

```bash
# Node.js 18+ (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# pandoc (for policy text preprocessing)
sudo apt-get install -y pandoc

# Git (to clone tracker datasets)
sudo apt-get install -y git
```

### Python environment

Python 3.10+ is required. [Miniforge](https://github.com/conda-forge/miniforge) (conda-forge) is recommended:

```bash
# Download and install Miniforge (skip if conda/mamba already available)
wget https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh
bash Miniforge3-Linux-x86_64.sh -b -p ~/miniforge3
~/miniforge3/bin/conda init bash
source ~/.bashrc

# Create and activate the project environment
conda create -n privacy python=3.12 -y
conda activate privacy

# Install the package and all dependencies
pip install -e .

# Install Playwright browser (used by Crawl4AI for JavaScript-heavy pages)
python -m playwright install chromium
python -m playwright install-deps chromium
```

> **Alternative (venv without conda)**
> ```bash
> python3 -m venv .venv
> source .venv/bin/activate
> pip install -e .
> python -m playwright install chromium
> python -m playwright install-deps chromium
> ```

### Build tracker indexes

```bash
# DuckDuckGo Tracker Radar (required for entity mapping)
git clone https://github.com/duckduckgo/tracker-radar.git tracker-radar
python scripts/build_tracker_radar_index.py \
  --tracker-radar-dir tracker-radar --out tracker_radar_index.json

# Ghostery TrackerDB (optional, used as fallback in mixed mode)
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

The dashboard launches the scraper and annotator as subprocesses. It auto-detects the active conda environment via `$CONDA_PREFIX`. If that is not set or points to the wrong environment, export the interpreter path explicitly:

```bash
export PRIVACY_DATASET_PYTHON=/path/to/conda/envs/privacy/bin/python
# example with miniforge default location:
export PRIVACY_DATASET_PYTHON=~/miniforge3/envs/privacy/bin/python
```

You can add this export to your `~/.bashrc` or pass it when starting the dashboard:

```bash
PRIVACY_DATASET_PYTHON=~/miniforge3/envs/privacy/bin/python npm run dev
```

---

## LLM annotation (Stage 2)

Stage 2 annotation requires an OpenAI-compatible LLM API server listening on `http://localhost:8901`. The dashboard polls `/health` every 15 s and shows **Tunnel active / offline** status.

**Option A — local llama.cpp or Ollama**

Start any OpenAI-compatible server on port 8901 before running annotation.

**Option B — remote GPU via SSH tunnel**

If the model runs on a remote GPU node, forward the port locally:

```bash
ssh -N -f -L 8901:<gpu-node>:8901 <user>@<hpc-hostname>
```

Replace `<gpu-node>`, `<user>`, and `<hpc-hostname>` with your server details.

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
| `artifacts_ok/<site>/` | Symlinks to artifacts meeting quality criteria (English policy + ≥1 third-party policy) |
| `artifacts/<site>/policy_statements.jsonl` | Annotated statements |

---

## Troubleshooting

**Dashboard cannot start the scraper**
Set `PRIVACY_DATASET_PYTHON` to the full path of the Python interpreter in the correct environment (see [Running the dashboard](#running-the-dashboard) above).

**`ModuleNotFoundError` for any package**
Make sure you ran `pip install -e .` inside the activated conda/venv environment, and that the dashboard is using the same interpreter via `PRIVACY_DATASET_PYTHON`.

**Annotation shows "Tunnel offline"**
Start a local or remote LLM server on port 8901. The health check hits `http://localhost:8901/health`.

**No results in the Explorer tab**
Make sure the run was started from the dashboard or used `--explorer-out` and `--emit-events` flags.

**CrUX filter returns 403**
Enable the Chrome UX Report API for your key in Google Cloud Console.

**`playwright install` fails**
Run `python -m playwright install-deps chromium` (requires sudo on some systems) to install OS-level browser dependencies.
