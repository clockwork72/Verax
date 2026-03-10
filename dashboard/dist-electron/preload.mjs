"use strict";

// electron/preload.ts
var import_electron = require("electron");
import_electron.contextBridge.exposeInMainWorld("ipcRenderer", {
  on(...args) {
    const [channel, listener] = args;
    return import_electron.ipcRenderer.on(channel, (event, ...args2) => listener(event, ...args2));
  },
  off(...args) {
    const [channel, ...omit] = args;
    return import_electron.ipcRenderer.off(channel, ...omit);
  },
  send(...args) {
    const [channel, ...omit] = args;
    return import_electron.ipcRenderer.send(channel, ...omit);
  },
  invoke(...args) {
    const [channel, ...omit] = args;
    return import_electron.ipcRenderer.invoke(channel, ...omit);
  }
});
import_electron.contextBridge.exposeInMainWorld("scraper", {
  startRun: (options) => import_electron.ipcRenderer.invoke("scraper:start", options),
  stopRun: () => import_electron.ipcRenderer.invoke("scraper:stop"),
  getPaths: (outDir) => import_electron.ipcRenderer.invoke("scraper:get-paths", outDir),
  readSummary: (path) => import_electron.ipcRenderer.invoke("scraper:read-summary", path),
  readState: (path) => import_electron.ipcRenderer.invoke("scraper:read-state", path),
  readExplorer: (path, limit) => import_electron.ipcRenderer.invoke("scraper:read-explorer", path, limit),
  readResults: (path, limit) => import_electron.ipcRenderer.invoke("scraper:read-results", path, limit),
  readAuditState: (outDir) => import_electron.ipcRenderer.invoke("scraper:read-audit-state", outDir),
  writeAuditState: (payload) => import_electron.ipcRenderer.invoke("scraper:write-audit-state", payload),
  readArtifactText: (options) => import_electron.ipcRenderer.invoke("scraper:read-artifact-text", options),
  clearResults: (options) => import_electron.ipcRenderer.invoke("scraper:clear-results", options),
  deleteOutput: (outDir) => import_electron.ipcRenderer.invoke("scraper:delete-output", outDir),
  getFolderSize: (outDir) => import_electron.ipcRenderer.invoke("scraper:folder-size", outDir),
  listRuns: (baseOutDir) => import_electron.ipcRenderer.invoke("scraper:list-runs", baseOutDir),
  openLogWindow: (content, title) => import_electron.ipcRenderer.invoke("scraper:open-log-window", { content, title }),
  openPolicyWindow: (url) => import_electron.ipcRenderer.invoke("scraper:open-policy-window", url),
  onEvent: (callback) => {
    import_electron.ipcRenderer.removeAllListeners("scraper:event");
    import_electron.ipcRenderer.on("scraper:event", (_evt, data) => callback(data));
  },
  onLog: (callback) => {
    import_electron.ipcRenderer.removeAllListeners("scraper:log");
    import_electron.ipcRenderer.on("scraper:log", (_evt, data) => callback(data));
  },
  onError: (callback) => {
    import_electron.ipcRenderer.removeAllListeners("scraper:error");
    import_electron.ipcRenderer.on("scraper:error", (_evt, data) => callback(data));
  },
  onExit: (callback) => {
    import_electron.ipcRenderer.removeAllListeners("scraper:exit");
    import_electron.ipcRenderer.on("scraper:exit", (_evt, data) => callback(data));
  },
  rerunSite: (options) => import_electron.ipcRenderer.invoke("scraper:rerun-site", options),
  startAnnotate: (options) => import_electron.ipcRenderer.invoke("scraper:start-annotate", options),
  stopAnnotate: () => import_electron.ipcRenderer.invoke("scraper:stop-annotate"),
  annotateSite: (options) => import_electron.ipcRenderer.invoke("scraper:annotate-site", options),
  annotationStats: (artifactsDir) => import_electron.ipcRenderer.invoke("scraper:annotation-stats", artifactsDir),
  readTpCache: (outDir) => import_electron.ipcRenderer.invoke("scraper:read-tp-cache", outDir),
  onAnnotatorLog: (callback) => {
    import_electron.ipcRenderer.removeAllListeners("annotator:log");
    import_electron.ipcRenderer.on("annotator:log", (_evt, data) => callback(data));
  },
  onAnnotatorExit: (callback) => {
    import_electron.ipcRenderer.removeAllListeners("annotator:exit");
    import_electron.ipcRenderer.on("annotator:exit", (_evt, data) => callback(data));
  },
  onAnnotatorStream: (callback) => {
    import_electron.ipcRenderer.removeAllListeners("annotator:stream");
    import_electron.ipcRenderer.on("annotator:stream", (_evt, data) => callback(data));
  },
  checkTunnel: () => import_electron.ipcRenderer.invoke("scraper:check-tunnel")
});
