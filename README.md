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
scripts/                    # bootstrap, verification, index builders, Tranco helpers
tracker_radar_index.json    # prebuilt DuckDuckGo Tracker Radar index
trackerdb_index.json        # prebuilt Ghostery TrackerDB index
tracker-radar/              # optional source checkout for rebuilding indexes
trackerdb/                  # optional source checkout for rebuilding indexes
dashboard/                  # Electron + Vite UI
outputs/                    # per-run output folders
hpc/                        # HPC job scripts (optional)
```

---

## Installation (Ubuntu)

### Fast path

```bash
git clone <repo-url>
cd <repo-dir>
./scripts/bootstrap_ubuntu.sh
source .venv/bin/activate
export PRIVACY_DATASET_PYTHON="$PWD/.venv/bin/python"
./scripts/verify_setup.sh
```

`bootstrap_ubuntu.sh` does the full first-run setup on Ubuntu:
- installs required system packages (`python3-venv`, `pandoc`, `git`, Node.js 20 if needed)
- creates `.venv/`
- installs the Python package with dev tools
- installs the Playwright Chromium browser and its Linux dependencies
- runs `npm ci` in [`dashboard/`](/mnt/storage/projects/dashboard)

`verify_setup.sh` then checks the Python CLIs, runs the test suite, and builds the dashboard.

### Manual setup

If you prefer to do the steps yourself instead of using the bootstrap script:

```bash
sudo apt-get update
sudo apt-get install -y python3 python3-venv python3-pip git curl pandoc

# Install Node.js 20 if node is missing or too old
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip setuptools wheel
pip install -e ".[dev]"
python -m playwright install chromium
sudo .venv/bin/python -m playwright install-deps chromium

cd dashboard
npm ci
cd ..
```

### Tracker indexes

This repository already ships with working index files:
- [`tracker_radar_index.json`](/mnt/storage/projects/tracker_radar_index.json)
- [`trackerdb_index.json`](/mnt/storage/projects/trackerdb_index.json)

You do not need to clone external tracker repositories for normal use.

If you want to rebuild the indexes from upstream sources, clone those repositories into a separate directory to avoid path conflicts with the repository checkout:

```bash
mkdir -p external
git clone https://github.com/duckduckgo/tracker-radar.git external/tracker-radar
python scripts/build_tracker_radar_index.py \
  --tracker-radar-dir external/tracker-radar \
  --out tracker_radar_index.json

git clone https://github.com/ghostery/trackerdb external/trackerdb
python scripts/build_trackerdb_index.py \
  --trackerdb-dir external/trackerdb \
  --out trackerdb_index.json
```

---

## Running the dashboard

```bash
source .venv/bin/activate
export PRIVACY_DATASET_PYTHON="$PWD/.venv/bin/python"
cd dashboard
npm run dev
```

The dashboard launches the scraper and annotator as subprocesses. The most reliable setup is to point it at the repository virtualenv explicitly:

```bash
export PRIVACY_DATASET_PYTHON="$PWD/../.venv/bin/python"
npm run dev
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

For large runs (high concurrency / many sites), enable resource telemetry and bounded cache behavior:

```bash
privacy-dataset \
  ... \
  --resource-monitor \
  --resource-sample-sec 3 \
  --resource-tracemalloc \
  --resource-monitor-out outputs/resource_metrics.jsonl \
  --policy-cache-max-entries 2000 \
  --tp-cache-flush-entries 25
```

**Stage 2 — annotate**

```bash
privacy-dataset-annotate \
  --artifacts-dir outputs/artifacts \
  --concurrency 3
```

To verify the local environment before a real run:

```bash
./scripts/verify_setup.sh
```

To package the Electron app after the regular dashboard build succeeds:

```bash
cd dashboard
npm run package
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
Set `PRIVACY_DATASET_PYTHON` to the repository virtualenv interpreter:

```bash
export PRIVACY_DATASET_PYTHON="$PWD/.venv/bin/python"
```

**`ModuleNotFoundError` for any package**
Run:

```bash
./scripts/bootstrap_ubuntu.sh
./scripts/verify_setup.sh
```

**Annotation shows "Tunnel offline"**
Start a local or remote LLM server on port 8901. The health check hits `http://localhost:8901/health`.

**No results in the Explorer tab**
Make sure the run was started from the dashboard or used `--explorer-out` and `--emit-events` flags.

**CrUX filter returns 403**
Enable the Chrome UX Report API for your key in Google Cloud Console.

**`playwright install` fails**
Run:

```bash
sudo .venv/bin/python -m playwright install-deps chromium
```
