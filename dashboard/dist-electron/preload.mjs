"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("ipcRenderer", {
  on(...args) {
    const [channel, listener] = args;
    return electron.ipcRenderer.on(channel, (event, ...args2) => listener(event, ...args2));
  },
  off(...args) {
    const [channel, ...omit] = args;
    return electron.ipcRenderer.off(channel, ...omit);
  },
  send(...args) {
    const [channel, ...omit] = args;
    return electron.ipcRenderer.send(channel, ...omit);
  },
  invoke(...args) {
    const [channel, ...omit] = args;
    return electron.ipcRenderer.invoke(channel, ...omit);
  }
});
electron.contextBridge.exposeInMainWorld("scraper", {
  startRun: (options) => electron.ipcRenderer.invoke("scraper:start", options),
  stopRun: () => electron.ipcRenderer.invoke("scraper:stop"),
  getPaths: (outDir) => electron.ipcRenderer.invoke("scraper:get-paths", outDir),
  readSummary: (path) => electron.ipcRenderer.invoke("scraper:read-summary", path),
  readState: (path) => electron.ipcRenderer.invoke("scraper:read-state", path),
  readExplorer: (path, limit) => electron.ipcRenderer.invoke("scraper:read-explorer", path, limit),
  readResults: (path, limit) => electron.ipcRenderer.invoke("scraper:read-results", path, limit),
  readAuditState: (outDir) => electron.ipcRenderer.invoke("scraper:read-audit-state", outDir),
  readRunManifest: (outDir) => electron.ipcRenderer.invoke("scraper:read-run-manifest", outDir),
  writeAuditState: (payload) => electron.ipcRenderer.invoke("scraper:write-audit-state", payload),
  readArtifactText: (options) => electron.ipcRenderer.invoke("scraper:read-artifact-text", options),
  clearResults: (options) => electron.ipcRenderer.invoke("scraper:clear-results", options),
  deleteOutput: (outDir) => electron.ipcRenderer.invoke("scraper:delete-output", outDir),
  getFolderSize: (outDir) => electron.ipcRenderer.invoke("scraper:folder-size", outDir),
  listRuns: (baseOutDir) => electron.ipcRenderer.invoke("scraper:list-runs", baseOutDir),
  openLogWindow: (content, title) => electron.ipcRenderer.invoke("scraper:open-log-window", { content, title }),
  openPolicyWindow: (url) => electron.ipcRenderer.invoke("scraper:open-policy-window", url),
  onEvent: (callback) => {
    electron.ipcRenderer.removeAllListeners("scraper:event");
    electron.ipcRenderer.on("scraper:event", (_evt, data) => callback(data));
  },
  onLog: (callback) => {
    electron.ipcRenderer.removeAllListeners("scraper:log");
    electron.ipcRenderer.on("scraper:log", (_evt, data) => callback(data));
  },
  onError: (callback) => {
    electron.ipcRenderer.removeAllListeners("scraper:error");
    electron.ipcRenderer.on("scraper:error", (_evt, data) => callback(data));
  },
  onExit: (callback) => {
    electron.ipcRenderer.removeAllListeners("scraper:exit");
    electron.ipcRenderer.on("scraper:exit", (_evt, data) => callback(data));
  },
  rerunSite: (options) => electron.ipcRenderer.invoke("scraper:rerun-site", options),
  startAnnotate: (options) => electron.ipcRenderer.invoke("scraper:start-annotate", options),
  stopAnnotate: () => electron.ipcRenderer.invoke("scraper:stop-annotate"),
  annotateSite: (options) => electron.ipcRenderer.invoke("scraper:annotate-site", options),
  annotationStats: (artifactsDir) => electron.ipcRenderer.invoke("scraper:annotation-stats", artifactsDir),
  countOkArtifacts: (outDir) => electron.ipcRenderer.invoke("scraper:count-ok-artifacts", outDir),
  readTpCache: (outDir) => electron.ipcRenderer.invoke("scraper:read-tp-cache", outDir),
  cruxCacheStats: (outDir) => electron.ipcRenderer.invoke("scraper:crux-cache-stats", outDir),
  onAnnotatorLog: (callback) => {
    electron.ipcRenderer.removeAllListeners("annotator:log");
    electron.ipcRenderer.on("annotator:log", (_evt, data) => callback(data));
  },
  onAnnotatorExit: (callback) => {
    electron.ipcRenderer.removeAllListeners("annotator:exit");
    electron.ipcRenderer.on("annotator:exit", (_evt, data) => callback(data));
  },
  onAnnotatorStream: (callback) => {
    electron.ipcRenderer.removeAllListeners("annotator:stream");
    electron.ipcRenderer.on("annotator:stream", (_evt, data) => callback(data));
  },
  checkTunnel: () => electron.ipcRenderer.invoke("scraper:check-tunnel")
});
