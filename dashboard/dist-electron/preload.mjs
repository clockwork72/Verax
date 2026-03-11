// electron/preload.ts
import { ipcRenderer, contextBridge } from "electron";
contextBridge.exposeInMainWorld("ipcRenderer", {
  on(...args) {
    const [channel, listener] = args;
    return ipcRenderer.on(channel, (event, ...args2) => listener(event, ...args2));
  },
  off(...args) {
    const [channel, ...omit] = args;
    return ipcRenderer.off(channel, ...omit);
  },
  send(...args) {
    const [channel, ...omit] = args;
    return ipcRenderer.send(channel, ...omit);
  },
  invoke(...args) {
    const [channel, ...omit] = args;
    return ipcRenderer.invoke(channel, ...omit);
  }
});
contextBridge.exposeInMainWorld("scraper", {
  startRun: (options) => ipcRenderer.invoke("scraper:start", options),
  stopRun: () => ipcRenderer.invoke("scraper:stop"),
  getPaths: (outDir) => ipcRenderer.invoke("scraper:get-paths", outDir),
  readSummary: (path) => ipcRenderer.invoke("scraper:read-summary", path),
  readState: (path) => ipcRenderer.invoke("scraper:read-state", path),
  readExplorer: (path, limit) => ipcRenderer.invoke("scraper:read-explorer", path, limit),
  readResults: (path, limit) => ipcRenderer.invoke("scraper:read-results", path, limit),
  readAuditState: (outDir) => ipcRenderer.invoke("scraper:read-audit-state", outDir),
  writeAuditState: (payload) => ipcRenderer.invoke("scraper:write-audit-state", payload),
  readArtifactText: (options) => ipcRenderer.invoke("scraper:read-artifact-text", options),
  clearResults: (options) => ipcRenderer.invoke("scraper:clear-results", options),
  deleteOutput: (outDir) => ipcRenderer.invoke("scraper:delete-output", outDir),
  getFolderSize: (outDir) => ipcRenderer.invoke("scraper:folder-size", outDir),
  listRuns: (baseOutDir) => ipcRenderer.invoke("scraper:list-runs", baseOutDir),
  openLogWindow: (content, title) => ipcRenderer.invoke("scraper:open-log-window", { content, title }),
  openPolicyWindow: (url) => ipcRenderer.invoke("scraper:open-policy-window", url),
  onEvent: (callback) => {
    ipcRenderer.removeAllListeners("scraper:event");
    ipcRenderer.on("scraper:event", (_evt, data) => callback(data));
  },
  onLog: (callback) => {
    ipcRenderer.removeAllListeners("scraper:log");
    ipcRenderer.on("scraper:log", (_evt, data) => callback(data));
  },
  onError: (callback) => {
    ipcRenderer.removeAllListeners("scraper:error");
    ipcRenderer.on("scraper:error", (_evt, data) => callback(data));
  },
  onExit: (callback) => {
    ipcRenderer.removeAllListeners("scraper:exit");
    ipcRenderer.on("scraper:exit", (_evt, data) => callback(data));
  },
  rerunSite: (options) => ipcRenderer.invoke("scraper:rerun-site", options),
  startAnnotate: (options) => ipcRenderer.invoke("scraper:start-annotate", options),
  stopAnnotate: () => ipcRenderer.invoke("scraper:stop-annotate"),
  annotateSite: (options) => ipcRenderer.invoke("scraper:annotate-site", options),
  annotationStats: (artifactsDir) => ipcRenderer.invoke("scraper:annotation-stats", artifactsDir),
  countOkArtifacts: (outDir) => ipcRenderer.invoke("scraper:count-ok-artifacts", outDir),
  readTpCache: (outDir) => ipcRenderer.invoke("scraper:read-tp-cache", outDir),
  cruxCacheStats: (outDir) => ipcRenderer.invoke("scraper:crux-cache-stats", outDir),
  onAnnotatorLog: (callback) => {
    ipcRenderer.removeAllListeners("annotator:log");
    ipcRenderer.on("annotator:log", (_evt, data) => callback(data));
  },
  onAnnotatorExit: (callback) => {
    ipcRenderer.removeAllListeners("annotator:exit");
    ipcRenderer.on("annotator:exit", (_evt, data) => callback(data));
  },
  onAnnotatorStream: (callback) => {
    ipcRenderer.removeAllListeners("annotator:stream");
    ipcRenderer.on("annotator:stream", (_evt, data) => callback(data));
  },
  checkTunnel: () => ipcRenderer.invoke("scraper:check-tunnel")
});
