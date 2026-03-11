import { ipcRenderer, contextBridge } from 'electron'

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    return ipcRenderer.on(channel, (event, ...args) => listener(event, ...args))
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args
    return ipcRenderer.off(channel, ...omit)
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args
    return ipcRenderer.send(channel, ...omit)
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args
    return ipcRenderer.invoke(channel, ...omit)
  },
})

contextBridge.exposeInMainWorld('scraper', {
  startRun: (options: any) => ipcRenderer.invoke('scraper:start', options),
  stopRun: () => ipcRenderer.invoke('scraper:stop'),
  getPaths: (outDir?: string) => ipcRenderer.invoke('scraper:get-paths', outDir),
  readSummary: (path?: string) => ipcRenderer.invoke('scraper:read-summary', path),
  readState: (path?: string) => ipcRenderer.invoke('scraper:read-state', path),
  readExplorer: (path?: string, limit?: number) => ipcRenderer.invoke('scraper:read-explorer', path, limit),
  readResults: (path?: string, limit?: number) => ipcRenderer.invoke('scraper:read-results', path, limit),
  readAuditState: (outDir?: string) => ipcRenderer.invoke('scraper:read-audit-state', outDir),
  readRunManifest: (outDir?: string) => ipcRenderer.invoke('scraper:read-run-manifest', outDir),
  writeAuditState: (payload?: { outDir?: string; verifiedSites?: string[]; urlOverrides?: Record<string, string> }) =>
    ipcRenderer.invoke('scraper:write-audit-state', payload),
  readArtifactText: (options?: { outDir?: string; relativePath?: string }) =>
    ipcRenderer.invoke('scraper:read-artifact-text', options),
  clearResults: (options?: { includeArtifacts?: boolean; outDir?: string }) =>
    ipcRenderer.invoke('scraper:clear-results', options),
  deleteOutput: (outDir?: string) => ipcRenderer.invoke('scraper:delete-output', outDir),
  getFolderSize: (outDir?: string) => ipcRenderer.invoke('scraper:folder-size', outDir),
  listRuns: (baseOutDir?: string) => ipcRenderer.invoke('scraper:list-runs', baseOutDir),
  openLogWindow: (content: string, title?: string) => ipcRenderer.invoke('scraper:open-log-window', { content, title }),
  openPolicyWindow: (url: string) => ipcRenderer.invoke('scraper:open-policy-window', url),
  onEvent: (callback: (event: any) => void) => {
    ipcRenderer.removeAllListeners('scraper:event')
    ipcRenderer.on('scraper:event', (_evt, data) => callback(data))
  },
  onLog: (callback: (event: any) => void) => {
    ipcRenderer.removeAllListeners('scraper:log')
    ipcRenderer.on('scraper:log', (_evt, data) => callback(data))
  },
  onError: (callback: (event: any) => void) => {
    ipcRenderer.removeAllListeners('scraper:error')
    ipcRenderer.on('scraper:error', (_evt, data) => callback(data))
  },
  onExit: (callback: (event: any) => void) => {
    ipcRenderer.removeAllListeners('scraper:exit')
    ipcRenderer.on('scraper:exit', (_evt, data) => callback(data))
  },
  rerunSite: (options: any) => ipcRenderer.invoke('scraper:rerun-site', options),
  startAnnotate: (options: any) => ipcRenderer.invoke('scraper:start-annotate', options),
  stopAnnotate: () => ipcRenderer.invoke('scraper:stop-annotate'),
  annotateSite: (options: any) => ipcRenderer.invoke('scraper:annotate-site', options),
  annotationStats: (artifactsDir?: string) => ipcRenderer.invoke('scraper:annotation-stats', artifactsDir),
  countOkArtifacts: (outDir?: string) => ipcRenderer.invoke('scraper:count-ok-artifacts', outDir),
  readTpCache: (outDir?: string) => ipcRenderer.invoke('scraper:read-tp-cache', outDir),
  cruxCacheStats: (outDir?: string) => ipcRenderer.invoke('scraper:crux-cache-stats', outDir),
  onAnnotatorLog: (callback: (event: any) => void) => {
    ipcRenderer.removeAllListeners('annotator:log')
    ipcRenderer.on('annotator:log', (_evt, data) => callback(data))
  },
  onAnnotatorExit: (callback: (event: any) => void) => {
    ipcRenderer.removeAllListeners('annotator:exit')
    ipcRenderer.on('annotator:exit', (_evt, data) => callback(data))
  },
  onAnnotatorStream: (callback: (event: any) => void) => {
    ipcRenderer.removeAllListeners('annotator:stream')
    ipcRenderer.on('annotator:stream', (_evt, data) => callback(data))
  },
  checkTunnel: () => ipcRenderer.invoke('scraper:check-tunnel'),
  diagnoseBridge: () => ipcRenderer.invoke('scraper:diagnose-bridge'),
  repairBridge: () => ipcRenderer.invoke('scraper:repair-bridge'),
})
