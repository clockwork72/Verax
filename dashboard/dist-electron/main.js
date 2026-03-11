"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// electron/main.ts
var main_exports = {};
__export(main_exports, {
  MAIN_DIST: () => MAIN_DIST,
  RENDERER_DIST: () => RENDERER_DIST,
  VITE_DEV_SERVER_URL: () => VITE_DEV_SERVER_URL
});
module.exports = __toCommonJS(main_exports);
var import_electron = require("electron");
var import_node_url = require("node:url");
var import_node_path = __toESM(require("node:path"), 1);
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_child_process = require("node:child_process");
var import_meta = {};
var __dirname = import_node_path.default.dirname((0, import_node_url.fileURLToPath)(import_meta.url));
process.env.APP_ROOT = import_node_path.default.join(__dirname, "..");
var VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
var MAIN_DIST = import_node_path.default.join(process.env.APP_ROOT, "dist-electron");
var RENDERER_DIST = import_node_path.default.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? import_node_path.default.join(process.env.APP_ROOT, "public") : RENDERER_DIST;
var REPO_ROOT = import_node_path.default.resolve(process.env.APP_ROOT, "..");
var win;
var scraperProcess = null;
var annotatorProcess = null;
var policyWindows = /* @__PURE__ */ new Set();
var logWindows = /* @__PURE__ */ new Set();
function getPythonCmd() {
  if (process.env.PRIVACY_DATASET_PYTHON) return process.env.PRIVACY_DATASET_PYTHON;
  const condaPrefix = process.env.CONDA_PREFIX;
  if (condaPrefix) {
    const explicit = import_node_path.default.join(condaPrefix, "bin", "python");
    if (import_node_fs.default.existsSync(explicit)) return explicit;
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
      baseBins.push(import_node_path.default.join(condaPrefix.slice(0, envsIdx), "bin"));
    }
  }
  const mambaRoot = process.env.MAMBA_ROOT_PREFIX || process.env.CONDA_ROOT;
  if (mambaRoot) baseBins.push(import_node_path.default.join(mambaRoot, "bin"));
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
  const root = outDir ? import_node_path.default.resolve(REPO_ROOT, outDir) : import_node_path.default.join(REPO_ROOT, "outputs");
  return {
    outDir: root,
    resultsJsonl: import_node_path.default.join(root, "results.jsonl"),
    summaryJson: import_node_path.default.join(root, "results.summary.json"),
    stateJson: import_node_path.default.join(root, "run_state.json"),
    explorerJsonl: import_node_path.default.join(root, "explorer.jsonl"),
    artifactsDir: import_node_path.default.join(root, "artifacts"),
    artifactsOkDir: import_node_path.default.join(root, "artifacts_ok"),
    cruxCacheJson: import_node_path.default.join(root, "results.crux_cache.json")
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
  return import_node_path.default.join(defaultPaths(outDir).outDir, "audit_state.json");
}
async function readAuditStateFile(filePath) {
  if (!import_node_fs.default.existsSync(filePath)) {
    return { verifiedSites: [], urlOverrides: {} };
  }
  try {
    const raw = await import_node_fs.default.promises.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const verifiedRaw = Array.isArray(parsed?.verifiedSites) ? parsed.verifiedSites : [];
    const verifiedSites = verifiedRaw.filter((value) => typeof value === "string" && value.trim().length > 0).map((value) => normalizeSiteKey(value));
    const urlOverridesRaw = parsed?.urlOverrides && typeof parsed.urlOverrides === "object" ? parsed.urlOverrides : {};
    const urlOverrides = {};
    for (const [key, value] of Object.entries(urlOverridesRaw)) {
      if (typeof value === "string" && value.trim().length > 0) {
        urlOverrides[normalizeSiteKey(key)] = value.trim();
      }
    }
    return { verifiedSites, urlOverrides, updatedAt: parsed?.updatedAt };
  } catch {
    return { verifiedSites: [], urlOverrides: {} };
  }
}
async function launchScraperProcess(args, extraEnv = {}) {
  const pythonCmd = getPythonCmd();
  try {
    scraperProcess = (0, import_node_child_process.spawn)(pythonCmd, args, {
      cwd: REPO_ROOT,
      env: buildSubprocessEnv(extraEnv)
    });
  } catch (error) {
    scraperProcess = null;
    return { ok: false, error: String(error) };
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
    scraperProcess = null;
  });
  return { ok: true };
}
async function launchAnnotatorProcess(args, extraEnv = {}) {
  const pythonCmd = getPythonCmd();
  try {
    annotatorProcess = (0, import_node_child_process.spawn)(pythonCmd, args, {
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
  const entries = await import_node_fs.default.promises.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = import_node_path.default.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await getDirectorySize(fullPath);
    } else if (entry.isFile()) {
      try {
        const stat = await import_node_fs.default.promises.stat(fullPath);
        total += stat.size;
      } catch {
        continue;
      }
    }
  }
  return total;
}
function createWindow() {
  win = new import_electron.BrowserWindow({
    icon: import_node_path.default.join(process.env.VITE_PUBLIC, "electron-vite.svg"),
    webPreferences: {
      preload: import_node_path.default.join(__dirname, "preload.mjs")
    }
  });
  win.webContents.on("did-finish-load", () => {
    win?.webContents.send("main-process-message", (/* @__PURE__ */ new Date()).toLocaleString());
  });
  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(import_node_path.default.join(RENDERER_DIST, "index.html"));
  }
}
function createPolicyWindow(url) {
  const policyWin = new import_electron.BrowserWindow({
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
  const logWin = new import_electron.BrowserWindow({
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
import_electron.ipcMain.handle("scraper:get-paths", (_event, outDir) => {
  return defaultPaths(outDir);
});
import_electron.ipcMain.handle("scraper:read-summary", async (_event, filePath) => {
  try {
    const target = filePath ? import_node_path.default.resolve(REPO_ROOT, filePath) : defaultPaths().summaryJson;
    if (!import_node_fs.default.existsSync(target)) {
      return { ok: false, error: "not_found", path: target };
    }
    const raw = await import_node_fs.default.promises.readFile(target, "utf-8");
    return { ok: true, data: JSON.parse(raw), path: target };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
import_electron.ipcMain.handle("scraper:read-state", async (_event, filePath) => {
  try {
    const target = filePath ? import_node_path.default.resolve(REPO_ROOT, filePath) : defaultPaths().stateJson;
    if (!import_node_fs.default.existsSync(target)) {
      return { ok: false, error: "not_found", path: target };
    }
    const raw = await import_node_fs.default.promises.readFile(target, "utf-8");
    return { ok: true, data: JSON.parse(raw), path: target };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
import_electron.ipcMain.handle("scraper:read-explorer", async (_event, filePath, limit) => {
  try {
    const target = filePath ? import_node_path.default.resolve(REPO_ROOT, filePath) : defaultPaths().explorerJsonl;
    if (!import_node_fs.default.existsSync(target)) {
      return { ok: false, error: "not_found", path: target };
    }
    const raw = await import_node_fs.default.promises.readFile(target, "utf-8");
    const data = target.endsWith(".jsonl") ? parseJsonl(raw, limit) : JSON.parse(raw);
    return { ok: true, data, path: target };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
import_electron.ipcMain.handle("scraper:read-results", async (_event, filePath, limit) => {
  try {
    const target = filePath ? import_node_path.default.resolve(REPO_ROOT, filePath) : defaultPaths().resultsJsonl;
    if (!import_node_fs.default.existsSync(target)) {
      return { ok: false, error: "not_found", path: target };
    }
    const raw = await import_node_fs.default.promises.readFile(target, "utf-8");
    return { ok: true, data: parseJsonl(raw, limit), path: target };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
import_electron.ipcMain.handle("scraper:read-audit-state", async (_event, outDir) => {
  try {
    const statePath = getAuditStatePath(outDir);
    const data = await readAuditStateFile(statePath);
    return { ok: true, data, path: statePath };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
import_electron.ipcMain.handle(
  "scraper:write-audit-state",
  async (_event, payload) => {
    try {
      const statePath = getAuditStatePath(payload?.outDir);
      const dirPath = import_node_path.default.dirname(statePath);
      await import_node_fs.default.promises.mkdir(dirPath, { recursive: true });
      const verifiedSites = Array.isArray(payload?.verifiedSites) ? payload.verifiedSites.filter((value) => typeof value === "string" && value.trim().length > 0).map((value) => normalizeSiteKey(value)) : [];
      const urlOverridesRaw = payload?.urlOverrides || {};
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
      await import_node_fs.default.promises.writeFile(statePath, JSON.stringify(nextState, null, 2), "utf-8");
      return { ok: true, data: nextState, path: statePath };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }
);
import_electron.ipcMain.handle("scraper:read-artifact-text", async (_event, options) => {
  try {
    const relativePath = options?.relativePath;
    if (!relativePath) {
      return { ok: false, error: "missing_relative_path" };
    }
    const root = options?.outDir ? import_node_path.default.resolve(REPO_ROOT, options.outDir) : defaultPaths().outDir;
    const fullPath = import_node_path.default.resolve(root, relativePath);
    const normalizedRoot = root.endsWith(import_node_path.default.sep) ? root : `${root}${import_node_path.default.sep}`;
    if (fullPath !== root && !fullPath.startsWith(normalizedRoot)) {
      return { ok: false, error: "path_outside_root" };
    }
    if (!import_node_fs.default.existsSync(fullPath)) {
      return { ok: false, error: "not_found", path: fullPath };
    }
    const raw = await import_node_fs.default.promises.readFile(fullPath, "utf-8");
    return { ok: true, data: raw, path: fullPath };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
import_electron.ipcMain.handle("scraper:folder-size", async (_event, outDir) => {
  try {
    const target = outDir ? import_node_path.default.resolve(REPO_ROOT, outDir) : defaultPaths().outDir;
    if (!import_node_fs.default.existsSync(target)) {
      return { ok: false, error: "not_found", path: target };
    }
    const size = await getDirectorySize(target);
    return { ok: true, bytes: size, path: target };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
import_electron.ipcMain.handle("scraper:list-runs", async (_event, baseOutDir) => {
  try {
    const root = baseOutDir ? import_node_path.default.resolve(REPO_ROOT, baseOutDir) : defaultPaths().outDir;
    if (!import_node_fs.default.existsSync(root)) {
      return { ok: false, error: "not_found", path: root };
    }
    const entries = await import_node_fs.default.promises.readdir(root, { withFileTypes: true });
    const runs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = import_node_path.default.join(root, entry.name);
      const summaryPath = import_node_path.default.join(dir, "results.summary.json");
      const statePath = import_node_path.default.join(dir, "run_state.json");
      let summary = null;
      let state = null;
      if (import_node_fs.default.existsSync(summaryPath)) {
        try {
          summary = JSON.parse(await import_node_fs.default.promises.readFile(summaryPath, "utf-8"));
        } catch {
          summary = null;
        }
      }
      if (import_node_fs.default.existsSync(statePath)) {
        try {
          state = JSON.parse(await import_node_fs.default.promises.readFile(statePath, "utf-8"));
        } catch {
          state = null;
        }
      }
      if (!summary && !state && !entry.name.startsWith("output_")) {
        continue;
      }
      let mtime = "";
      try {
        const stat = await import_node_fs.default.promises.stat(dir);
        mtime = stat.mtime.toISOString();
      } catch {
        mtime = "";
      }
      const runId = summary?.run_id || state?.run_id || entry.name.replace(/^output_/, "");
      runs.push({
        runId,
        folder: entry.name,
        outDir: import_node_path.default.relative(REPO_ROOT, dir),
        summary,
        state,
        updated_at: summary?.updated_at || state?.updated_at || mtime,
        started_at: summary?.started_at || state?.started_at || null
      });
    }
    runs.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    return { ok: true, root, runs };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
import_electron.ipcMain.handle("scraper:start", async (_event, options = {}) => {
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
    options.artifactsDir ? import_node_path.default.resolve(REPO_ROOT, options.artifactsDir) : paths.artifactsDir,
    "--artifacts-ok-dir",
    paths.artifactsOkDir,
    "--emit-events",
    "--state-file",
    paths.stateJson,
    "--summary-out",
    paths.summaryJson,
    "--explorer-out",
    paths.explorerJsonl
  ];
  if (options.topN) {
    args.push("--tranco-top", String(options.topN));
  }
  if (options.trancoDate) {
    args.push("--tranco-date", options.trancoDate);
  }
  if (options.trackerRadarIndex) {
    const trackerPath = import_node_path.default.resolve(REPO_ROOT, options.trackerRadarIndex);
    if (import_node_fs.default.existsSync(trackerPath)) {
      args.push("--tracker-radar-index", trackerPath);
    } else {
      sendToRenderer("scraper:error", { message: "tracker_radar_index_not_found", path: trackerPath });
    }
  }
  if (options.trackerDbIndex) {
    const trackerDbPath = import_node_path.default.resolve(REPO_ROOT, options.trackerDbIndex);
    if (import_node_fs.default.existsSync(trackerDbPath)) {
      args.push("--trackerdb-index", trackerDbPath);
    } else {
      sendToRenderer("scraper:error", { message: "trackerdb_index_not_found", path: trackerDbPath });
    }
  }
  if (options.runId) {
    args.push("--run-id", options.runId);
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
  const launched = await launchScraperProcess(args);
  if (!launched.ok) {
    return { ok: false, error: launched.error || "failed_to_start" };
  }
  return { ok: true, paths };
});
import_electron.ipcMain.handle("scraper:rerun-site", async (_event, options = {}) => {
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
    options.artifactsDir ? import_node_path.default.resolve(REPO_ROOT, options.artifactsDir) : paths.artifactsDir,
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
    const trackerPath = import_node_path.default.resolve(REPO_ROOT, options.trackerRadarIndex);
    if (import_node_fs.default.existsSync(trackerPath)) {
      args.push("--tracker-radar-index", trackerPath);
    } else {
      sendToRenderer("scraper:error", { message: "tracker_radar_index_not_found", path: trackerPath });
    }
  }
  if (options.trackerDbIndex) {
    const trackerDbPath = import_node_path.default.resolve(REPO_ROOT, options.trackerDbIndex);
    if (import_node_fs.default.existsSync(trackerDbPath)) {
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
import_electron.ipcMain.handle("scraper:stop", async () => {
  if (!scraperProcess) return { ok: false, error: "not_running" };
  scraperProcess.kill();
  return { ok: true };
});
import_electron.ipcMain.handle("scraper:open-log-window", async (_event, payload) => {
  try {
    const content = payload?.content ?? "";
    const title = payload?.title;
    createLogWindow(content, title);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
import_electron.ipcMain.handle("scraper:open-policy-window", async (_event, url) => {
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
import_electron.ipcMain.handle("scraper:clear-results", async (_event, options) => {
  if (scraperProcess) {
    return { ok: false, error: "scraper_running" };
  }
  const paths = defaultPaths(options?.outDir);
  const targets = [
    paths.resultsJsonl,
    paths.summaryJson,
    paths.stateJson,
    paths.explorerJsonl,
    import_node_path.default.join(paths.outDir, "audit_state.json")
  ];
  const removed = [];
  const missing = [];
  const errors = [];
  for (const target of targets) {
    try {
      if (import_node_fs.default.existsSync(target)) {
        await import_node_fs.default.promises.rm(target, { force: true });
        removed.push(target);
      } else {
        missing.push(target);
      }
    } catch (error) {
      errors.push(`${target}: ${String(error)}`);
    }
  }
  if (options?.includeArtifacts) {
    try {
      if (import_node_fs.default.existsSync(paths.artifactsDir)) {
        await import_node_fs.default.promises.rm(paths.artifactsDir, { recursive: true, force: true });
        removed.push(paths.artifactsDir);
      }
    } catch (error) {
      errors.push(`${paths.artifactsDir}: ${String(error)}`);
    }
  }
  return { ok: errors.length === 0, removed, missing, errors, paths };
});
import_electron.ipcMain.handle("scraper:delete-output", async (_event, outDir) => {
  try {
    const target = outDir ? import_node_path.default.resolve(REPO_ROOT, outDir) : defaultPaths().outDir;
    if (!import_node_fs.default.existsSync(target)) {
      return { ok: false, error: "not_found", path: target };
    }
    await import_node_fs.default.promises.rm(target, { recursive: true, force: true });
    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
import_electron.ipcMain.handle("scraper:start-annotate", async (_event, options = {}) => {
  if (annotatorProcess) {
    return { ok: false, error: "annotator_already_running" };
  }
  const artifactsDir = options.artifactsDir ? import_node_path.default.resolve(REPO_ROOT, options.artifactsDir) : import_node_path.default.join(defaultPaths().outDir, "artifacts");
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
import_electron.ipcMain.handle("scraper:annotate-site", async (_event, options = {}) => {
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
import_electron.ipcMain.handle("scraper:stop-annotate", async () => {
  if (!annotatorProcess) return { ok: false, error: "not_running" };
  annotatorProcess.kill();
  return { ok: true };
});
import_electron.ipcMain.handle("scraper:check-tunnel", async () => {
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
import_electron.ipcMain.handle("scraper:annotation-stats", async (_event, artifactsDir) => {
  try {
    const targetDir = artifactsDir ? import_node_path.default.resolve(REPO_ROOT, artifactsDir) : import_node_path.default.join(defaultPaths().outDir, "artifacts");
    if (!import_node_fs.default.existsSync(targetDir)) {
      return { ok: true, total_sites: 0, annotated_sites: 0, total_statements: 0, per_site: [] };
    }
    const countLines = async (filePath) => {
      try {
        const content = await import_node_fs.default.promises.readFile(filePath, "utf-8");
        return content.split("\n").filter((line) => line.trim()).length;
      } catch {
        return 0;
      }
    };
    const entries = await import_node_fs.default.promises.readdir(targetDir, { withFileTypes: true });
    const perSite = [];
    const perTp = [];
    let totalStatements = 0;
    let tpTotalStatements = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const statementsPath = import_node_path.default.join(targetDir, entry.name, "policy_statements.jsonl");
      const hasStatements = import_node_fs.default.existsSync(statementsPath);
      let count = 0;
      if (hasStatements) {
        count = await countLines(statementsPath);
        totalStatements += count;
      }
      perSite.push({ site: entry.name, count, has_statements: hasStatements });
      const tpRoot = import_node_path.default.join(targetDir, entry.name, "third_party");
      if (import_node_fs.default.existsSync(tpRoot)) {
        const tpEntries = await import_node_fs.default.promises.readdir(tpRoot, { withFileTypes: true });
        for (const tpEntry of tpEntries) {
          if (!tpEntry.isDirectory()) continue;
          const tpStmtsPath = import_node_path.default.join(tpRoot, tpEntry.name, "policy_statements.jsonl");
          const tpHas = import_node_fs.default.existsSync(tpStmtsPath);
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
import_electron.ipcMain.handle("scraper:count-ok-artifacts", async (_event, outDir) => {
  try {
    const paths = defaultPaths(outDir);
    const okDir = paths.artifactsOkDir;
    if (!import_node_fs.default.existsSync(okDir)) {
      return { ok: true, count: 0, sites: [], path: okDir };
    }
    const entries = await import_node_fs.default.promises.readdir(okDir, { withFileTypes: true });
    const sites = entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
    return { ok: true, count: sites.length, sites, path: okDir };
  } catch (error) {
    return { ok: false, error: String(error), count: 0, sites: [] };
  }
});
import_electron.ipcMain.handle("scraper:read-tp-cache", async (_event, outDir) => {
  try {
    const root = outDir ? import_node_path.default.resolve(REPO_ROOT, outDir) : defaultPaths().outDir;
    const cachePath = import_node_path.default.join(root, "results.tp_cache.json");
    if (!import_node_fs.default.existsSync(cachePath)) {
      return { ok: false, error: "not_found", path: cachePath };
    }
    const raw = await import_node_fs.default.promises.readFile(cachePath, "utf-8");
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
import_electron.ipcMain.handle("scraper:crux-cache-stats", async (_event, outDir) => {
  try {
    const paths = defaultPaths(outDir);
    const cachePath = paths.cruxCacheJson;
    if (!import_node_fs.default.existsSync(cachePath)) {
      return { ok: true, count: 0, present: 0, absent: 0, path: cachePath };
    }
    const raw = await import_node_fs.default.promises.readFile(cachePath, "utf-8");
    const data = JSON.parse(raw);
    const entries = Object.values(data);
    const present = entries.filter(Boolean).length;
    const absent = entries.length - present;
    return { ok: true, count: entries.length, present, absent, path: cachePath };
  } catch (error) {
    return { ok: false, error: String(error), count: 0, present: 0, absent: 0 };
  }
});
import_electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    import_electron.app.quit();
    win = null;
  }
});
import_electron.app.on("activate", () => {
  if (import_electron.BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
import_electron.app.whenReady().then(createWindow);
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MAIN_DIST,
  RENDERER_DIST,
  VITE_DEV_SERVER_URL
});
