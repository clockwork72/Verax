# Dashboard

Electron + React UI for the Privacy Research Dataset pipeline.

See the [root README](../README.md) for full setup and usage instructions.

## Dev

```bash
export PRIVACY_DATASET_PYTHON="$(cd .. && pwd)/.venv/bin/python"
npm ci
npm run dev
```

## Build

```bash
npm run build
```

Produces `dist/` (renderer) and `dist-electron/` (main + preload).

## Package

```bash
npm run package
```

Builds the Electron installer/AppImage after the regular dashboard build succeeds.
