import { ipcMain, app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
const __dirname$1 = path.dirname(fileURLToPath(import.meta.url));
process.env.APP_ROOT = path.join(__dirname$1, "..");
const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, "public") : RENDERER_DIST;
const REPO_ROOT = path.resolve(process.env.APP_ROOT, "..");
let win;
let scraperProcess = null;
let annotatorProcess = null;
const policyWindows = /* @__PURE__ */ new Set();
const logWindows = /* @__PURE__ */ new Set();
const DASHBOARD_SAFE_CONCURRENCY = 2;
const DASHBOARD_SAFE_CRUX_CONCURRENCY = 8;
const DASHBOARD_SAFE_POLICY_CACHE_MAX = 1200;
const DASHBOARD_SAFE_TP_CACHE_FLUSH = 20;
let activeRunManifestPath = null;
let activeRunManifest = null;
let activeRunCompleted = false;
function getPythonCmd() {
  if (process.env.PRIVACY_DATASET_PYTHON) return process.env.PRIVACY_DATASET_PYTHON;
  const condaPrefix = process.env.CONDA_PREFIX;
  if (condaPrefix) {
    const explicit = path.join(condaPrefix, "bin", "python");
    if (fs.existsSync(explicit)) return explicit;
  }
  return "python";
}
function buildSubprocessEnv(extra = {}) {
  const env = { ...process.env, PYTHONUNBUFFERED: "1", ...extra };
  const baseBins = [];
  const condaPrefix = process.env.CONDA_PREFIX;
  if (condaPrefix) {
    const envsIdx = condaPrefix.lastIndexOf("/envs/");
    if (envsIdx !== -1) {
      baseBins.push(path.join(condaPrefix.slice(0, envsIdx), "bin"));
    }
  }
  const mambaRoot = process.env.MAMBA_ROOT_PREFIX || process.env.CONDA_ROOT;
  if (mambaRoot) baseBins.push(path.join(mambaRoot, "bin"));
  if (baseBins.length > 0) {
    const currentPath = env.PATH || "";
    const existing = new Set(currentPath.split(":"));
    const toAdd = baseBins.filter((d) => !existing.has(d));
    if (toAdd.length > 0) {
      env.PATH = currentPath + ":" + toAdd.join(":");
    }
  }
  return env;
}
function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}
function defaultPaths(outDir) {
  const root = outDir ? path.resolve(REPO_ROOT, outDir) : path.join(REPO_ROOT, "outputs");
  return {
    outDir: root,
    resultsJsonl: path.join(root, "results.jsonl"),
    summaryJson: path.join(root, "results.summary.json"),
    stateJson: path.join(root, "run_state.json"),
    explorerJsonl: path.join(root, "explorer.jsonl"),
    artifactsDir: path.join(root, "artifacts"),
    artifactsOkDir: path.join(root, "artifacts_ok"),
    // Shared across all runs so CrUX lookups are reused between separate outputs.
    cruxCacheJson: path.join(REPO_ROOT, "results.crux_cache.json")
  };
}
function parseJsonl(content, limit) {
  const lines = content.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
      if (limit && out.length >= limit) break;
    } catch (err) {
      out.push({ _error: "invalid_json", raw: trimmed });
    }
  }
  return out;
}
function normalizeSiteKey(value) {
  return value.trim().toLowerCase();
}
function normalizeModelKey(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  return raw.includes("/") ? raw.split("/").pop() || raw : raw;
}
function isDatedModelVariant(key, family) {
  if (!key.startsWith(`${family}-`)) return false;
  const suffix = key.slice(family.length + 1);
  return /^\d/.test(suffix);
}
function isLowTpmModelKey(key) {
  return key === "gpt-4o" || isDatedModelVariant(key, "gpt-4o") || key === "gpt-4.1" || isDatedModelVariant(key, "gpt-4.1");
}
function annotatorRateLimitArgs(modelName) {
  const key = normalizeModelKey(modelName);
  if (key === "local") {
    return ["--llm-max-output-tokens", "2048", "--disable-exhaustion-check"];
  }
  if (key === "gpt-4o" || isDatedModelVariant(key, "gpt-4o")) {
    return [
      "--model-tpm",
      "30000",
      "--tpm-headroom-ratio",
      "0.65",
      "--tpm-safety-factor",
      "1.30",
      "--llm-max-output-tokens",
      "650",
      "--rate-limit-retries",
      "12",
      "--disable-exhaustion-check"
    ];
  }
  if (key === "gpt-4.1" || isDatedModelVariant(key, "gpt-4.1")) {
    return [
      "--model-tpm",
      "30000",
      "--tpm-headroom-ratio",
      "0.70",
      "--tpm-safety-factor",
      "1.25",
      "--llm-max-output-tokens",
      "700",
      "--rate-limit-retries",
      "10",
      "--disable-exhaustion-check"
    ];
  }
  if (key === "gpt-4o-mini" || isDatedModelVariant(key, "gpt-4o-mini")) {
    return [
      "--model-tpm",
      "200000",
      "--tpm-headroom-ratio",
      "0.80",
      "--tpm-safety-factor",
      "1.15",
      "--llm-max-output-tokens",
      "900",
      "--rate-limit-retries",
      "8"
    ];
  }
  if (key === "gpt-4.1-mini" || isDatedModelVariant(key, "gpt-4.1-mini")) {
    return [
      "--model-tpm",
      "200000",
      "--tpm-headroom-ratio",
      "0.80",
      "--tpm-safety-factor",
      "1.15",
      "--llm-max-output-tokens",
      "900",
      "--rate-limit-retries",
      "8"
    ];
  }
  if (key === "gpt-4.1-nano" || isDatedModelVariant(key, "gpt-4.1-nano")) {
    return [
      "--model-tpm",
      "1000000",
      "--tpm-headroom-ratio",
      "0.85",
      "--tpm-safety-factor",
      "1.10",
      "--llm-max-output-tokens",
      "850",
      "--rate-limit-retries",
      "8"
    ];
  }
  return [];
}
function getAuditStatePath(outDir) {
  return path.join(defaultPaths(outDir).outDir, "audit_state.json");
}
function getRunManifestPath(outDir) {
  return path.join(defaultPaths(outDir).outDir, "dashboard_run_manifest.json");
}
async function writeRunManifest(pathname, manifest) {
  await fs.promises.mkdir(path.dirname(pathname), { recursive: true });
  await fs.promises.writeFile(pathname, JSON.stringify(manifest, null, 2), "utf-8");
}
async function readAuditStateFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { verifiedSites: [], urlOverrides: {} };
  }
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const verifiedRaw = Array.isArray(parsed == null ? void 0 : parsed.verifiedSites) ? parsed.verifiedSites : [];
    const verifiedSites = verifiedRaw.filter((value) => typeof value === "string" && value.trim().length > 0).map((value) => normalizeSiteKey(value));
    const urlOverridesRaw = (parsed == null ? void 0 : parsed.urlOverrides) && typeof parsed.urlOverrides === "object" ? parsed.urlOverrides : {};
    const urlOverrides = {};
    for (const [key, value] of Object.entries(urlOverridesRaw)) {
      if (typeof value === "string" && value.trim().length > 0) {
        urlOverrides[normalizeSiteKey(key)] = value.trim();
      }
    }
    return { verifiedSites, urlOverrides, updatedAt: parsed == null ? void 0 : parsed.updatedAt };
  } catch {
    return { verifiedSites: [], urlOverrides: {} };
  }
}
async function launchScraperProcess(args, extraEnv = {}, runManifest) {
  const pythonCmd = getPythonCmd();
  try {
    scraperProcess = spawn(pythonCmd, args, {
      cwd: REPO_ROOT,
      env: buildSubprocessEnv(extraEnv)
    });
  } catch (error) {
    scraperProcess = null;
    return { ok: false, error: String(error) };
  }
  activeRunCompleted = false;
  activeRunManifestPath = (runManifest == null ? void 0 : runManifest.path) || null;
  activeRunManifest = (runManifest == null ? void 0 : runManifest.data) || null;
  if (activeRunManifestPath && activeRunManifest) {
    try {
      await writeRunManifest(activeRunManifestPath, activeRunManifest);
    } catch (error) {
      sendToRenderer("scraper:error", { message: "run_manifest_write_failed", error: String(error) });
    }
  }
  let stdoutBuffer = "";
  scraperProcess.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const evt = JSON.parse(trimmed);
        if ((evt == null ? void 0 : evt.type) === "run_completed") {
          activeRunCompleted = true;
        }
        sendToRenderer("scraper:event", evt);
      } catch {
        sendToRenderer("scraper:log", { message: trimmed });
      }
    }
  });
  scraperProcess.stderr.on("data", (chunk) => {
    sendToRenderer("scraper:error", { message: chunk.toString() });
  });
  scraperProcess.on("error", (error) => {
    sendToRenderer("scraper:error", { message: String(error) });
  });
  scraperProcess.on("close", (code, signal) => {
    sendToRenderer("scraper:exit", { code, signal });
    if (activeRunManifestPath && activeRunManifest) {
      const nextManifest = {
        ...activeRunManifest,
        status: activeRunCompleted ? "completed" : "interrupted",
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      if (activeRunCompleted) {
        nextManifest.completedAt = nextManifest.updatedAt;
      }
      void writeRunManifest(activeRunManifestPath, nextManifest).catch((error) => {
        sendToRenderer("scraper:error", { message: "run_manifest_update_failed", error: String(error) });
      });
    }
    activeRunManifestPath = null;
    activeRunManifest = null;
    activeRunCompleted = false;
    scraperProcess = null;
  });
  return { ok: true };
}
async function launchAnnotatorProcess(args, extraEnv = {}) {
  const pythonCmd = getPythonCmd();
  try {
    annotatorProcess = spawn(pythonCmd, args, {
      cwd: REPO_ROOT,
      env: buildSubprocessEnv(extraEnv)
    });
  } catch (error) {
    annotatorProcess = null;
    return { ok: false, error: String(error) };
  }
  let annotatorStdoutBuf = "";
  annotatorProcess.stdout.on("data", (chunk) => {
    annotatorStdoutBuf += chunk.toString();
    const lines = annotatorStdoutBuf.split(/\r?\n/);
    annotatorStdoutBuf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      if (line.startsWith("[STREAM] ")) {
        try {
          const payload = JSON.parse(line.slice(9));
          sendToRenderer("annotator:stream", payload);
        } catch {
          sendToRenderer("annotator:log", { message: line });
        }
      } else {
        sendToRenderer("annotator:log", { message: line });
      }
    }
  });
  annotatorProcess.stderr.on("data", (chunk) => {
    sendToRenderer("annotator:log", { message: chunk.toString().trimEnd() });
  });
  annotatorProcess.on("error", (error) => {
    sendToRenderer("annotator:log", { message: `Error: ${String(error)}` });
  });
  annotatorProcess.on("close", (code, signal) => {
    sendToRenderer("annotator:exit", { code, signal });
    annotatorProcess = null;
  });
  return { ok: true };
}
async function getDirectorySize(dirPath) {
  let total = 0;
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await getDirectorySize(fullPath);
    } else if (entry.isFile()) {
      try {
        const stat = await fs.promises.stat(fullPath);
        total += stat.size;
      } catch {
        continue;
      }
    }
  }
  return total;
}
function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, "electron-vite.svg"),
    webPreferences: {
      preload: path.join(__dirname$1, "preload.mjs")
    }
  });
  win.webContents.on("did-finish-load", () => {
    win == null ? void 0 : win.webContents.send("main-process-message", (/* @__PURE__ */ new Date()).toLocaleString());
  });
  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }
}
function createPolicyWindow(url) {
  const policyWin = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Policy Viewer",
    backgroundColor: "#0B0E14",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  policyWin.setMenuBarVisibility(false);
  policyWin.loadURL(url);
  policyWindows.add(policyWin);
  policyWin.on("closed", () => {
    policyWindows.delete(policyWin);
  });
  return policyWin;
}
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function createLogWindow(content, title) {
  const logWin = new BrowserWindow({
    width: 1100,
    height: 800,
    title: title || "Run logs",
    backgroundColor: "#0B0E14",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  logWin.setMenuBarVisibility(false);
  const safe = escapeHtml(content || "");
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title || "Run logs")}</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; background: #0B0E14; color: #E6EDF3; }
      header { padding: 16px 20px; border-bottom: 1px solid #1f2630; background: #0F141C; }
      h1 { font-size: 14px; letter-spacing: 0.16em; text-transform: uppercase; margin: 0 0 6px; color: #b9c2cc; }
      .sub { font-size: 12px; color: #b9c2cc; }
      pre { margin: 0; padding: 16px 20px; white-space: pre-wrap; word-break: break-word; line-height: 1.5; font-size: 12px; }
    </style>
  </head>
  <body>
    <header>
      <h1>Run logs</h1>
      <div class="sub">Full log output</div>
    </header>
    <pre>${safe}</pre>
  </body>
</html>`;
  logWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  logWindows.add(logWin);
  logWin.on("closed", () => {
    logWindows.delete(logWin);
  });
  return logWin;
}
ipcMain.handle("scraper:get-paths", (_event, outDir) => {
  return defaultPaths(outDir);
});
ipcMain.handle("scraper:read-summary", async (_event, filePath) => {
  try {
    const target = filePath ? path.resolve(REPO_ROOT, filePath) : defaultPaths().summaryJson;
    if (!fs.existsSync(target)) {
      return { ok: false, error: "not_found", path: target };
    }
    const raw = await fs.promises.readFile(target, "utf-8");
    return { ok: true, data: JSON.parse(raw), path: target };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
ipcMain.handle("scraper:read-state", async (_event, filePath) => {
  try {
    const target = filePath ? path.resolve(REPO_ROOT, filePath) : defaultPaths().stateJson;
    if (!fs.existsSync(target)) {
      return { ok: false, error: "not_found", path: target };
    }
    const raw = await fs.promises.readFile(target, "utf-8");
    return { ok: true, data: JSON.parse(raw), path: target };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
ipcMain.handle("scraper:read-explorer", async (_event, filePath, limit) => {
  try {
    const target = filePath ? path.resolve(REPO_ROOT, filePath) : defaultPaths().explorerJsonl;
    if (!fs.existsSync(target)) {
      return { ok: false, error: "not_found", path: target };
    }
    const raw = await fs.promises.readFile(target, "utf-8");
    const data = target.endsWith(".jsonl") ? parseJsonl(raw, limit) : JSON.parse(raw);
    return { ok: true, data, path: target };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
ipcMain.handle("scraper:read-results", async (_event, filePath, limit) => {
  try {
    const target = filePath ? path.resolve(REPO_ROOT, filePath) : defaultPaths().resultsJsonl;
    if (!fs.existsSync(target)) {
      return { ok: false, error: "not_found", path: target };
    }
    const raw = await fs.promises.readFile(target, "utf-8");
    return { ok: true, data: parseJsonl(raw, limit), path: target };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
ipcMain.handle("scraper:read-audit-state", async (_event, outDir) => {
  try {
    const statePath = getAuditStatePath(outDir);
    const data = await readAuditStateFile(statePath);
    return { ok: true, data, path: statePath };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
ipcMain.handle("scraper:read-run-manifest", async (_event, outDir) => {
  try {
    const manifestPath = getRunManifestPath(outDir);
    if (!fs.existsSync(manifestPath)) {
      return { ok: false, error: "not_found", path: manifestPath };
    }
    const raw = await fs.promises.readFile(manifestPath, "utf-8");
    return { ok: true, data: JSON.parse(raw), path: manifestPath };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
ipcMain.handle(
  "scraper:write-audit-state",
  async (_event, payload) => {
    try {
      const statePath = getAuditStatePath(payload == null ? void 0 : payload.outDir);
      const dirPath = path.dirname(statePath);
      await fs.promises.mkdir(dirPath, { recursive: true });
      const verifiedSites = Array.isArray(payload == null ? void 0 : payload.verifiedSites) ? payload.verifiedSites.filter((value) => typeof value === "string" && value.trim().length > 0).map((value) => normalizeSiteKey(value)) : [];
      const urlOverridesRaw = (payload == null ? void 0 : payload.urlOverrides) || {};
      const urlOverrides = {};
      for (const [site, url] of Object.entries(urlOverridesRaw)) {
        if (typeof url === "string" && url.trim().length > 0) {
          urlOverrides[normalizeSiteKey(site)] = url.trim();
        }
      }
      const nextState = {
        verifiedSites: Array.from(new Set(verifiedSites)),
        urlOverrides,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      await fs.promises.writeFile(statePath, JSON.stringify(nextState, null, 2), "utf-8");
      return { ok: true, data: nextState, path: statePath };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }
);
ipcMain.handle("scraper:read-artifact-text", async (_event, options) => {
  try {
    const relativePath = options == null ? void 0 : options.relativePath;
    if (!relativePath) {
      return { ok: false, error: "missing_relative_path" };
    }
    const root = (options == null ? void 0 : options.outDir) ? path.resolve(REPO_ROOT, options.outDir) : defaultPaths().outDir;
    const fullPath = path.resolve(root, relativePath);
    const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (fullPath !== root && !fullPath.startsWith(normalizedRoot)) {
      return { ok: false, error: "path_outside_root" };
    }
    if (!fs.existsSync(fullPath)) {
      return { ok: false, error: "not_found", path: fullPath };
    }
    const raw = await fs.promises.readFile(fullPath, "utf-8");
    return { ok: true, data: raw, path: fullPath };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
ipcMain.handle("scraper:folder-size", async (_event, outDir) => {
  try {
    const target = outDir ? path.resolve(REPO_ROOT, outDir) : defaultPaths().outDir;
    if (!fs.existsSync(target)) {
      return { ok: false, error: "not_found", path: target };
    }
    const size = await getDirectorySize(target);
    return { ok: true, bytes: size, path: target };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
ipcMain.handle("scraper:list-runs", async (_event, baseOutDir) => {
  try {
    const root = baseOutDir ? path.resolve(REPO_ROOT, baseOutDir) : defaultPaths().outDir;
    if (!fs.existsSync(root)) {
      return { ok: false, error: "not_found", path: root };
    }
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    const runs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const summaryPath = path.join(dir, "results.summary.json");
      const statePath = path.join(dir, "run_state.json");
      let summary = null;
      let state = null;
      if (fs.existsSync(summaryPath)) {
        try {
          summary = JSON.parse(await fs.promises.readFile(summaryPath, "utf-8"));
        } catch {
          summary = null;
        }
      }
      if (fs.existsSync(statePath)) {
        try {
          state = JSON.parse(await fs.promises.readFile(statePath, "utf-8"));
        } catch {
          state = null;
        }
      }
      if (!summary && !state && !entry.name.startsWith("output_")) {
        continue;
      }
      let mtime = "";
      try {
        const stat = await fs.promises.stat(dir);
        mtime = stat.mtime.toISOString();
      } catch {
        mtime = "";
      }
      const runId = (summary == null ? void 0 : summary.run_id) || (state == null ? void 0 : state.run_id) || entry.name.replace(/^output_/, "");
      runs.push({
        runId,
        folder: entry.name,
        outDir: path.relative(REPO_ROOT, dir),
        summary,
        state,
        updated_at: (summary == null ? void 0 : summary.updated_at) || (state == null ? void 0 : state.updated_at) || mtime,
        started_at: (summary == null ? void 0 : summary.started_at) || (state == null ? void 0 : state.started_at) || null
      });
    }
    runs.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    return { ok: true, root, runs };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
ipcMain.handle("scraper:start", async (_event, options = {}) => {
  if (scraperProcess) {
    return { ok: false, error: "scraper_already_running" };
  }
  const paths = defaultPaths(options.outDir);
  const args = [
    "-m",
    "privacy_research_dataset.cli",
    "--out",
    paths.resultsJsonl,
    "--artifacts-dir",
    options.artifactsDir ? path.resolve(REPO_ROOT, options.artifactsDir) : paths.artifactsDir,
    "--artifacts-ok-dir",
    paths.artifactsOkDir,
    "--emit-events",
    "--state-file",
    paths.stateJson,
    "--summary-out",
    paths.summaryJson,
    "--explorer-out",
    paths.explorerJsonl,
    "--concurrency",
    String(DASHBOARD_SAFE_CONCURRENCY),
    "--crux-concurrency",
    String(DASHBOARD_SAFE_CRUX_CONCURRENCY),
    "--policy-cache-max-entries",
    String(DASHBOARD_SAFE_POLICY_CACHE_MAX),
    "--tp-cache-flush-entries",
    String(DASHBOARD_SAFE_TP_CACHE_FLUSH)
  ];
  if (Array.isArray(options.sites) && options.sites.length > 0) {
    for (const site of options.sites) {
      const trimmed = String(site || "").trim();
      if (trimmed) {
        args.push("--site", trimmed);
      }
    }
  } else if (options.topN) {
    args.push("--tranco-top", String(options.topN));
  }
  if (options.trancoDate) {
    args.push("--tranco-date", options.trancoDate);
  }
  if (options.resumeAfterRank && Number.isFinite(options.resumeAfterRank)) {
    args.push("--resume-after-rank", String(options.resumeAfterRank));
  }
  if (options.expectedTotalSites && Number.isFinite(options.expectedTotalSites)) {
    args.push("--expected-total-sites", String(options.expectedTotalSites));
  }
  if (options.trackerRadarIndex) {
    const trackerPath = path.resolve(REPO_ROOT, options.trackerRadarIndex);
    if (fs.existsSync(trackerPath)) {
      args.push("--tracker-radar-index", trackerPath);
    } else {
      sendToRenderer("scraper:error", { message: "tracker_radar_index_not_found", path: trackerPath });
    }
  }
  if (options.trackerDbIndex) {
    const trackerDbPath = path.resolve(REPO_ROOT, options.trackerDbIndex);
    if (fs.existsSync(trackerDbPath)) {
      args.push("--trackerdb-index", trackerDbPath);
    } else {
      sendToRenderer("scraper:error", { message: "trackerdb_index_not_found", path: trackerDbPath });
    }
  }
  if (options.runId) {
    args.push("--run-id", options.runId);
  }
  if (options.upsertBySite) {
    args.push("--upsert-by-site");
  }
  args.push("--crux-cache-file", paths.cruxCacheJson);
  if (options.cruxFilter) {
    args.push("--crux-filter");
    if (options.cruxApiKey) {
      args.push("--crux-api-key", options.cruxApiKey);
    }
  }
  if (options.skipHomeFailed) {
    args.push("--skip-home-fetch-failed");
  }
  if (options.excludeSameEntity) {
    args.push("--exclude-same-entity");
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const manifest = {
    version: 1,
    status: "running",
    mode: Array.isArray(options.sites) && options.sites.length > 0 ? "append_sites" : "tranco",
    runId: options.runId,
    topN: options.topN,
    trancoDate: options.trancoDate,
    resumeAfterRank: options.resumeAfterRank,
    expectedTotalSites: options.expectedTotalSites,
    requestedSites: Array.isArray(options.sites) ? options.sites.map((site) => String(site).trim()).filter(Boolean) : [],
    cruxFilter: !!options.cruxFilter,
    startedAt: now,
    updatedAt: now
  };
  const launched = await launchScraperProcess(args, {}, {
    path: getRunManifestPath(options.outDir),
    data: manifest
  });
  if (!launched.ok) {
    return { ok: false, error: launched.error || "failed_to_start" };
  }
  return { ok: true, paths };
});
ipcMain.handle("scraper:rerun-site", async (_event, options = {}) => {
  if (scraperProcess) {
    return { ok: false, error: "scraper_already_running" };
  }
  if (annotatorProcess) {
    return { ok: false, error: "annotator_running" };
  }
  const site = String(options.site || "").trim();
  if (!site) {
    return { ok: false, error: "missing_site" };
  }
  const paths = defaultPaths(options.outDir);
  const args = [
    "-m",
    "privacy_research_dataset.cli",
    "--site",
    site,
    "--out",
    paths.resultsJsonl,
    "--artifacts-dir",
    options.artifactsDir ? path.resolve(REPO_ROOT, options.artifactsDir) : paths.artifactsDir,
    "--artifacts-ok-dir",
    paths.artifactsOkDir,
    "--emit-events",
    "--state-file",
    paths.stateJson,
    "--summary-out",
    paths.summaryJson,
    "--explorer-out",
    paths.explorerJsonl,
    "--force",
    "--upsert-by-site",
    "--concurrency",
    "1"
  ];
  if (options.trackerRadarIndex) {
    const trackerPath = path.resolve(REPO_ROOT, options.trackerRadarIndex);
    if (fs.existsSync(trackerPath)) {
      args.push("--tracker-radar-index", trackerPath);
    } else {
      sendToRenderer("scraper:error", { message: "tracker_radar_index_not_found", path: trackerPath });
    }
  }
  if (options.trackerDbIndex) {
    const trackerDbPath = path.resolve(REPO_ROOT, options.trackerDbIndex);
    if (fs.existsSync(trackerDbPath)) {
      args.push("--trackerdb-index", trackerDbPath);
    } else {
      sendToRenderer("scraper:error", { message: "trackerdb_index_not_found", path: trackerDbPath });
    }
  }
  if (options.runId) {
    args.push("--run-id", options.runId);
  }
  if (options.excludeSameEntity) {
    args.push("--exclude-same-entity");
  }
  if (options.policyUrlOverride && options.policyUrlOverride.trim()) {
    args.push("--policy-url-override", options.policyUrlOverride.trim());
  }
  if (options.llmModel && options.llmModel.trim()) {
    args.push("--llm-model", options.llmModel.trim());
  }
  const launched = await launchScraperProcess(args);
  if (!launched.ok) {
    return { ok: false, error: launched.error || "failed_to_start" };
  }
  return { ok: true, paths, site };
});
ipcMain.handle("scraper:stop", async () => {
  if (!scraperProcess) return { ok: false, error: "not_running" };
  scraperProcess.kill();
  return { ok: true };
});
ipcMain.handle("scraper:open-log-window", async (_event, payload) => {
  try {
    const content = (payload == null ? void 0 : payload.content) ?? "";
    const title = payload == null ? void 0 : payload.title;
    createLogWindow(content, title);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
ipcMain.handle("scraper:open-policy-window", async (_event, url) => {
  if (!url || typeof url !== "string") {
    return { ok: false, error: "invalid_url" };
  }
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { ok: false, error: "unsupported_protocol" };
    }
    createPolicyWindow(url);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
ipcMain.handle("scraper:clear-results", async (_event, options) => {
  if (scraperProcess) {
    return { ok: false, error: "scraper_running" };
  }
  const paths = defaultPaths(options == null ? void 0 : options.outDir);
  const targets = [
    paths.resultsJsonl,
    paths.summaryJson,
    paths.stateJson,
    paths.explorerJsonl,
    path.join(paths.outDir, "audit_state.json")
  ];
  const removed = [];
  const missing = [];
  const errors = [];
  for (const target of targets) {
    try {
      if (fs.existsSync(target)) {
        await fs.promises.rm(target, { force: true });
        removed.push(target);
      } else {
        missing.push(target);
      }
    } catch (error) {
      errors.push(`${target}: ${String(error)}`);
    }
  }
  if (options == null ? void 0 : options.includeArtifacts) {
    try {
      if (fs.existsSync(paths.artifactsDir)) {
        await fs.promises.rm(paths.artifactsDir, { recursive: true, force: true });
        removed.push(paths.artifactsDir);
      }
    } catch (error) {
      errors.push(`${paths.artifactsDir}: ${String(error)}`);
    }
  }
  return { ok: errors.length === 0, removed, missing, errors, paths };
});
ipcMain.handle("scraper:delete-output", async (_event, outDir) => {
  try {
    const target = outDir ? path.resolve(REPO_ROOT, outDir) : defaultPaths().outDir;
    if (!fs.existsSync(target)) {
      return { ok: false, error: "not_found", path: target };
    }
    await fs.promises.rm(target, { recursive: true, force: true });
    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
ipcMain.handle("scraper:start-annotate", async (_event, options = {}) => {
  if (annotatorProcess) {
    return { ok: false, error: "annotator_already_running" };
  }
  const artifactsDir = options.artifactsDir ? path.resolve(REPO_ROOT, options.artifactsDir) : path.join(defaultPaths().outDir, "artifacts");
  const args = [
    "-m",
    "privacy_research_dataset.annotate_cli",
    "--artifacts-dir",
    artifactsDir
  ];
  if (options.llmModel) args.push("--llm-model", options.llmModel);
  if (options.tokenLimit) args.push("--token-limit", String(options.tokenLimit));
  const modelKey = normalizeModelKey(options.llmModel);
  const preferredConcurrency = isLowTpmModelKey(modelKey) ? 1 : void 0;
  let requestedConcurrency = options.concurrency || preferredConcurrency;
  if (preferredConcurrency && requestedConcurrency && requestedConcurrency > preferredConcurrency) {
    requestedConcurrency = preferredConcurrency;
    sendToRenderer("annotator:log", {
      message: `[info] ${options.llmModel || modelKey}: forcing concurrency ${preferredConcurrency} for TPM stability.`
    });
  }
  if (requestedConcurrency) args.push("--concurrency", String(requestedConcurrency));
  args.push(...annotatorRateLimitArgs(options.llmModel));
  if (options.force) args.push("--force");
  const launched = await launchAnnotatorProcess(args);
  if (!launched.ok) {
    return { ok: false, error: launched.error || "failed_to_start" };
  }
  return { ok: true, artifactsDir };
});
ipcMain.handle("scraper:annotate-site", async (_event, options = {}) => {
  if (annotatorProcess) {
    return { ok: false, error: "annotator_already_running" };
  }
  if (scraperProcess) {
    return { ok: false, error: "scraper_running" };
  }
  const site = String(options.site || "").trim();
  if (!site) {
    return { ok: false, error: "missing_site" };
  }
  const paths = defaultPaths(options.outDir);
  const args = [
    "-m",
    "privacy_research_dataset.annotate_cli",
    "--artifacts-dir",
    paths.artifactsDir,
    "--target-dir",
    site,
    "--concurrency",
    "1"
  ];
  if (options.llmModel && options.llmModel.trim()) {
    args.push("--llm-model", options.llmModel.trim());
  }
  args.push(...annotatorRateLimitArgs(options.llmModel));
  if (typeof options.tokenLimit === "number" && Number.isFinite(options.tokenLimit)) {
    args.push("--token-limit", String(options.tokenLimit));
  }
  if (options.force !== false) {
    args.push("--force");
  }
  const launched = await launchAnnotatorProcess(args);
  if (!launched.ok) {
    return { ok: false, error: launched.error || "failed_to_start" };
  }
  return { ok: true, artifactsDir: paths.artifactsDir, site };
});
ipcMain.handle("scraper:stop-annotate", async () => {
  if (!annotatorProcess) return { ok: false, error: "not_running" };
  annotatorProcess.kill();
  return { ok: true };
});
ipcMain.handle("scraper:check-tunnel", async () => {
  const http = await import("node:http");
  return new Promise((resolve) => {
    const req = http.default.get(
      { hostname: "::1", port: 8901, path: "/health", timeout: 3e3 },
      (res) => {
        res.resume();
        const ok = typeof res.statusCode === "number" && res.statusCode < 400;
        resolve({ ok, status: res.statusCode });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
  });
});
ipcMain.handle("scraper:annotation-stats", async (_event, artifactsDir) => {
  try {
    const targetDir = artifactsDir ? path.resolve(REPO_ROOT, artifactsDir) : path.join(defaultPaths().outDir, "artifacts");
    if (!fs.existsSync(targetDir)) {
      return { ok: true, total_sites: 0, annotated_sites: 0, total_statements: 0, per_site: [] };
    }
    const countLines = async (filePath) => {
      try {
        const content = await fs.promises.readFile(filePath, "utf-8");
        return content.split("\n").filter((line) => line.trim()).length;
      } catch {
        return 0;
      }
    };
    const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
    const perSite = [];
    const perTp = [];
    let totalStatements = 0;
    let tpTotalStatements = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const statementsPath = path.join(targetDir, entry.name, "policy_statements.jsonl");
      const hasStatements = fs.existsSync(statementsPath);
      let count = 0;
      if (hasStatements) {
        count = await countLines(statementsPath);
        totalStatements += count;
      }
      perSite.push({ site: entry.name, count, has_statements: hasStatements });
      const tpRoot = path.join(targetDir, entry.name, "third_party");
      if (fs.existsSync(tpRoot)) {
        const tpEntries = await fs.promises.readdir(tpRoot, { withFileTypes: true });
        for (const tpEntry of tpEntries) {
          if (!tpEntry.isDirectory()) continue;
          const tpStmtsPath = path.join(tpRoot, tpEntry.name, "policy_statements.jsonl");
          const tpHas = fs.existsSync(tpStmtsPath);
          let tpCount = 0;
          if (tpHas) {
            tpCount = await countLines(tpStmtsPath);
            tpTotalStatements += tpCount;
          }
          perTp.push({ site: entry.name, tp: tpEntry.name, count: tpCount, has_statements: tpHas });
        }
      }
    }
    const annotatedSites = perSite.filter((s) => s.has_statements).length;
    const tpAnnotatedCount = perTp.filter((t) => t.has_statements).length;
    return {
      ok: true,
      total_sites: perSite.length,
      annotated_sites: annotatedSites,
      total_statements: totalStatements,
      per_site: perSite,
      tp_total: perTp.length,
      tp_annotated: tpAnnotatedCount,
      tp_total_statements: tpTotalStatements,
      per_tp: perTp
    };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
ipcMain.handle("scraper:count-ok-artifacts", async (_event, outDir) => {
  try {
    const paths = defaultPaths(outDir);
    const okDir = paths.artifactsOkDir;
    if (!fs.existsSync(okDir)) {
      return { ok: true, count: 0, sites: [], path: okDir };
    }
    const entries = await fs.promises.readdir(okDir, { withFileTypes: true });
    const sites = entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
    return { ok: true, count: sites.length, sites, path: okDir };
  } catch (error) {
    return { ok: false, error: String(error), count: 0, sites: [] };
  }
});
ipcMain.handle("scraper:read-tp-cache", async (_event, outDir) => {
  try {
    const root = outDir ? path.resolve(REPO_ROOT, outDir) : defaultPaths().outDir;
    const cachePath = path.join(root, "results.tp_cache.json");
    if (!fs.existsSync(cachePath)) {
      return { ok: false, error: "not_found", path: cachePath };
    }
    const raw = await fs.promises.readFile(cachePath, "utf-8");
    const data = JSON.parse(raw);
    let total = 0;
    let fetched = 0;
    let failed = 0;
    const byStatus = {};
    for (const entry of Object.values(data)) {
      total++;
      if (entry.text !== null && entry.text !== void 0) {
        fetched++;
      } else if (entry.error_message) {
        failed++;
      }
      const code = String(entry.status_code ?? "unknown");
      byStatus[code] = (byStatus[code] || 0) + 1;
    }
    return { ok: true, total, fetched, failed, by_status: byStatus };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
ipcMain.handle("scraper:crux-cache-stats", async (_event, outDir) => {
  try {
    const paths = defaultPaths(outDir);
    const cachePath = paths.cruxCacheJson;
    if (!fs.existsSync(cachePath)) {
      return { ok: true, count: 0, present: 0, absent: 0, path: cachePath };
    }
    const raw = await fs.promises.readFile(cachePath, "utf-8");
    const data = JSON.parse(raw);
    const entries = Object.values(data);
    const present = entries.filter(Boolean).length;
    const absent = entries.length - present;
    return { ok: true, count: entries.length, present, absent, path: cachePath };
  } catch (error) {
    return { ok: false, error: String(error), count: 0, present: 0, absent: 0 };
  }
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
    win = null;
  }
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
app.whenReady().then(createWindow);
export {
  MAIN_DIST,
  RENDERER_DIST,
  VITE_DEV_SERVER_URL
};
