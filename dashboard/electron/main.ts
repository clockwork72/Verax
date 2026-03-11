import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, '..')

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST
const REPO_ROOT = path.resolve(process.env.APP_ROOT, '..')
const HPC_SERVICE_ORIGIN = process.env.PRIVACY_DATASET_HPC_ORIGIN || 'http://127.0.0.1:8910'

let win: BrowserWindow | null
let scraperProcess: ChildProcessWithoutNullStreams | null = null
let annotatorProcess: ChildProcessWithoutNullStreams | null = null
const policyWindows = new Set<BrowserWindow>()
const logWindows = new Set<BrowserWindow>()
let hpcPollCursor = 0
let hpcPollTimer: NodeJS.Timeout | null = null

// Keep dashboard-triggered scraping conservative to avoid host freezes.
const DASHBOARD_SAFE_CONCURRENCY = 2
const DASHBOARD_SAFE_CRUX_CONCURRENCY = 8
const DASHBOARD_SAFE_POLICY_CACHE_MAX = 1200
const DASHBOARD_SAFE_TP_CACHE_FLUSH = 20

type ScraperStartOptions = {
  topN?: number
  sites?: string[]
  trancoDate?: string
  trackerRadarIndex?: string
  trackerDbIndex?: string
  outDir?: string
  artifactsDir?: string
  runId?: string
  resumeAfterRank?: number
  expectedTotalSites?: number
  upsertBySite?: boolean
  cruxFilter?: boolean
  cruxApiKey?: string
  skipHomeFailed?: boolean
  excludeSameEntity?: boolean
}

type RerunSiteOptions = {
  site?: string
  outDir?: string
  artifactsDir?: string
  runId?: string
  trackerRadarIndex?: string
  trackerDbIndex?: string
  policyUrlOverride?: string
  excludeSameEntity?: boolean
  llmModel?: string
}

type AnnotateStartOptions = {
  artifactsDir?: string
  llmModel?: string
  tokenLimit?: number
  concurrency?: number
  force?: boolean
}

type AnnotateSiteOptions = {
  site?: string
  outDir?: string
  llmModel?: string
  tokenLimit?: number
  force?: boolean
}

type AuditStateFile = {
  verifiedSites: string[]
  urlOverrides: Record<string, string>
  updatedAt?: string
}

type RunManifest = {
  version: 1
  status: 'running' | 'completed' | 'interrupted'
  mode: 'tranco' | 'append_sites'
  runId?: string
  topN?: number
  trancoDate?: string
  resumeAfterRank?: number
  expectedTotalSites?: number
  requestedSites?: string[]
  cruxFilter?: boolean
  updatedAt: string
  startedAt?: string
  completedAt?: string
}

let activeRunManifestPath: string | null = null
let activeRunManifest: RunManifest | null = null
let activeRunCompleted = false

/**
 * Return the Python interpreter to use for subprocesses.
 *
 * Priority:
 *   1. PRIVACY_DATASET_PYTHON env var (explicit override)
 *   2. $CONDA_PREFIX/bin/python  (active conda env — avoids PATH lookup ambiguity
 *      that can resolve to the wrong Python when the base conda bin is also on PATH)
 *   3. Fallback: 'python' (relies on PATH, may not work in all setups)
 */
function getPythonCmd(): string {
  if (process.env.PRIVACY_DATASET_PYTHON) return process.env.PRIVACY_DATASET_PYTHON
  const condaPrefix = process.env.CONDA_PREFIX
  if (condaPrefix) {
    const explicit = path.join(condaPrefix, 'bin', 'python')
    if (fs.existsSync(explicit)) return explicit
  }
  return 'python'
}

/**
 * Build a subprocess environment that inherits process.env but ensures tools
 * like `pandoc` are findable.
 *
 * Pandoc is typically installed in the *base* conda environment, not in a named
 * sub-env, so we append the base bin directory to PATH.  Note: the Python
 * interpreter is resolved by getPythonCmd() using the explicit path from
 * CONDA_PREFIX rather than PATH lookup, so prepending the active env bin here
 * is not needed and would risk shadowing other tools.
 */
function buildSubprocessEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: '1', ...extra }

  // Collect base conda bin dirs (for pandoc and other base-env tools).
  // We deliberately do NOT prepend the active env bin to avoid overriding
  // PATH lookups with a different Python than the one returned by getPythonCmd().
  const baseBins: string[] = []

  const condaPrefix = process.env.CONDA_PREFIX
  if (condaPrefix) {
    // Derive base env path when running inside a named sub-env (/envs/<name>)
    const envsIdx = condaPrefix.lastIndexOf('/envs/')
    if (envsIdx !== -1) {
      baseBins.push(path.join(condaPrefix.slice(0, envsIdx), 'bin'))
    }
  }

  const mambaRoot = process.env.MAMBA_ROOT_PREFIX || process.env.CONDA_ROOT
  if (mambaRoot) baseBins.push(path.join(mambaRoot, 'bin'))

  if (baseBins.length > 0) {
    const currentPath = env.PATH || ''
    const existing = new Set(currentPath.split(':'))
    const toAdd = baseBins.filter((d) => !existing.has(d))
    if (toAdd.length > 0) {
      // Append (not prepend) so the active conda env Python stays at higher priority
      env.PATH = currentPath + ':' + toAdd.join(':')
    }
  }

  return env
}

function sendToRenderer(channel: string, payload: unknown) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

async function hpcRequest(pathname: string, init?: RequestInit) {
  const response = await fetch(`${HPC_SERVICE_ORIGIN}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  return response.json()
}

async function hpcHealth(): Promise<any | null> {
  try {
    return await hpcRequest('/health')
  } catch {
    return null
  }
}

async function hpcAvailable(): Promise<boolean> {
  const health = await hpcHealth()
  return !!health?.ok
}

function ensureHpcPoller() {
  if (hpcPollTimer) return
  hpcPollTimer = setInterval(async () => {
    if (!win || win.isDestroyed()) return
    try {
      const res: any = await hpcRequest(`/api/poll?cursor=${hpcPollCursor}`)
      if (!res?.ok) return
      hpcPollCursor = Number(res.cursor || hpcPollCursor)
      for (const item of res.items || []) {
        if (item?.channel) {
          sendToRenderer(item.channel, item.payload)
        }
      }
    } catch {
      // Tunnel/service unavailable; keep quiet and retry on next tick.
    }
  }, 1500)
}

function stopHpcPoller() {
  if (!hpcPollTimer) return
  clearInterval(hpcPollTimer)
  hpcPollTimer = null
}

function defaultPaths(outDir?: string) {
  const root = outDir ? path.resolve(REPO_ROOT, outDir) : path.join(REPO_ROOT, 'outputs')
  return {
    outDir: root,
    resultsJsonl: path.join(root, 'results.jsonl'),
    summaryJson: path.join(root, 'results.summary.json'),
    stateJson: path.join(root, 'run_state.json'),
    explorerJsonl: path.join(root, 'explorer.jsonl'),
    artifactsDir: path.join(root, 'artifacts'),
    artifactsOkDir: path.join(root, 'artifacts_ok'),
    // Shared across all runs so CrUX lookups are reused between separate outputs.
    cruxCacheJson: path.join(REPO_ROOT, 'results.crux_cache.json'),
  }
}

function parseJsonl(content: string, limit?: number) {
  const lines = content.split(/\r?\n/)
  const out: any[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed))
      if (limit && out.length >= limit) break
    } catch (err) {
      out.push({ _error: 'invalid_json', raw: trimmed })
    }
  }
  return out
}

type ParsedFileCacheEntry<T> = {
  mtimeMs: number
  data: T
}

const jsonFileCache = new Map<string, ParsedFileCacheEntry<unknown>>()
const jsonlFileCache = new Map<string, ParsedFileCacheEntry<unknown[]>>()
const metricCache = new Map<string, { expiresAt: number; value: unknown }>()

async function readJsonFileCached(target: string) {
  const stat = await fs.promises.stat(target)
  const cached = jsonFileCache.get(target)
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.data
  }
  const raw = await fs.promises.readFile(target, 'utf-8')
  const parsed = JSON.parse(raw)
  jsonFileCache.set(target, { mtimeMs: stat.mtimeMs, data: parsed })
  return parsed
}

async function readJsonlFileCached(target: string) {
  const stat = await fs.promises.stat(target)
  const cached = jsonlFileCache.get(target)
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.data
  }
  const raw = await fs.promises.readFile(target, 'utf-8')
  const parsed = parseJsonl(raw)
  jsonlFileCache.set(target, { mtimeMs: stat.mtimeMs, data: parsed })
  return parsed
}

async function readMetricCached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const cached = metricCache.get(key)
  if (cached && cached.expiresAt > now) {
    return cached.value as T
  }
  const value = await loader()
  metricCache.set(key, { expiresAt: now + ttlMs, value })
  return value
}

function normalizeSiteKey(value: string): string {
  return value.trim().toLowerCase()
}

function normalizeModelKey(value?: string): string {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return ''
  return raw.includes('/') ? raw.split('/').pop() || raw : raw
}

function isDatedModelVariant(key: string, family: string): boolean {
  if (!key.startsWith(`${family}-`)) return false
  const suffix = key.slice(family.length + 1)
  return /^\d/.test(suffix)
}

function isLowTpmModelKey(key: string): boolean {
  return (
    key === 'gpt-4o' ||
    isDatedModelVariant(key, 'gpt-4o') ||
    key === 'gpt-4.1' ||
    isDatedModelVariant(key, 'gpt-4.1')
  )
}

function annotatorRateLimitArgs(modelName?: string): string[] {
  const key = normalizeModelKey(modelName)
  // Local DeepSeek on HPC: no remote TPM quota — skip all rate-limit args.
  if (key === 'local') {
    return ['--llm-max-output-tokens', '2048', '--disable-exhaustion-check']
  }
  // Dashboard defaults tuned to avoid TPM spikes on low-TPM models.
  if (key === 'gpt-4o' || isDatedModelVariant(key, 'gpt-4o')) {
    return [
      '--model-tpm', '30000',
      '--tpm-headroom-ratio', '0.65',
      '--tpm-safety-factor', '1.30',
      '--llm-max-output-tokens', '650',
      '--rate-limit-retries', '12',
      '--disable-exhaustion-check',
    ]
  }
  if (key === 'gpt-4.1' || isDatedModelVariant(key, 'gpt-4.1')) {
    return [
      '--model-tpm', '30000',
      '--tpm-headroom-ratio', '0.70',
      '--tpm-safety-factor', '1.25',
      '--llm-max-output-tokens', '700',
      '--rate-limit-retries', '10',
      '--disable-exhaustion-check',
    ]
  }
  if (key === 'gpt-4o-mini' || isDatedModelVariant(key, 'gpt-4o-mini')) {
    return [
      '--model-tpm', '200000',
      '--tpm-headroom-ratio', '0.80',
      '--tpm-safety-factor', '1.15',
      '--llm-max-output-tokens', '900',
      '--rate-limit-retries', '8',
    ]
  }
  if (key === 'gpt-4.1-mini' || isDatedModelVariant(key, 'gpt-4.1-mini')) {
    return [
      '--model-tpm', '200000',
      '--tpm-headroom-ratio', '0.80',
      '--tpm-safety-factor', '1.15',
      '--llm-max-output-tokens', '900',
      '--rate-limit-retries', '8',
    ]
  }
  if (key === 'gpt-4.1-nano' || isDatedModelVariant(key, 'gpt-4.1-nano')) {
    return [
      '--model-tpm', '1000000',
      '--tpm-headroom-ratio', '0.85',
      '--tpm-safety-factor', '1.10',
      '--llm-max-output-tokens', '850',
      '--rate-limit-retries', '8',
    ]
  }
  return []
}

function getAuditStatePath(outDir?: string): string {
  return path.join(defaultPaths(outDir).outDir, 'audit_state.json')
}

function getRunManifestPath(outDir?: string): string {
  return path.join(defaultPaths(outDir).outDir, 'dashboard_run_manifest.json')
}

async function writeRunManifest(pathname: string, manifest: RunManifest): Promise<void> {
  await fs.promises.mkdir(path.dirname(pathname), { recursive: true })
  await fs.promises.writeFile(pathname, JSON.stringify(manifest, null, 2), 'utf-8')
}

async function readAuditStateFile(filePath: string): Promise<AuditStateFile> {
  if (!fs.existsSync(filePath)) {
    return { verifiedSites: [], urlOverrides: {} }
  }
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    const verifiedRaw = Array.isArray(parsed?.verifiedSites) ? parsed.verifiedSites : []
    const verifiedSites = verifiedRaw
      .filter((value: unknown) => typeof value === 'string' && value.trim().length > 0)
      .map((value: string) => normalizeSiteKey(value))
    const urlOverridesRaw = (parsed?.urlOverrides && typeof parsed.urlOverrides === 'object')
      ? parsed.urlOverrides
      : {}
    const urlOverrides: Record<string, string> = {}
    for (const [key, value] of Object.entries(urlOverridesRaw as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim().length > 0) {
        urlOverrides[normalizeSiteKey(key)] = value.trim()
      }
    }
    return { verifiedSites, urlOverrides, updatedAt: parsed?.updatedAt }
  } catch {
    return { verifiedSites: [], urlOverrides: {} }
  }
}

async function launchScraperProcess(
  args: string[],
  extraEnv: Record<string, string> = {},
  runManifest?: { path: string; data: RunManifest }
): Promise<{ ok: boolean; error?: string }> {
  const pythonCmd = getPythonCmd()
  try {
    scraperProcess = spawn(pythonCmd, args, {
      cwd: REPO_ROOT,
      env: buildSubprocessEnv(extraEnv),
    })
  } catch (error) {
    scraperProcess = null
    return { ok: false, error: String(error) }
  }

  activeRunCompleted = false
  activeRunManifestPath = runManifest?.path || null
  activeRunManifest = runManifest?.data || null
  if (activeRunManifestPath && activeRunManifest) {
    try {
      await writeRunManifest(activeRunManifestPath, activeRunManifest)
    } catch (error) {
      sendToRenderer('scraper:error', { message: 'run_manifest_write_failed', error: String(error) })
    }
  }

  let stdoutBuffer = ''
  scraperProcess.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString()
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const evt = JSON.parse(trimmed)
        if (evt?.type === 'run_completed') {
          activeRunCompleted = true
        }
        sendToRenderer('scraper:event', evt)
      } catch {
        sendToRenderer('scraper:log', { message: trimmed })
      }
    }
  })

  scraperProcess.stderr.on('data', (chunk) => {
    sendToRenderer('scraper:error', { message: chunk.toString() })
  })

  scraperProcess.on('error', (error) => {
    sendToRenderer('scraper:error', { message: String(error) })
  })

  scraperProcess.on('close', (code, signal) => {
    sendToRenderer('scraper:exit', { code, signal })
    if (activeRunManifestPath && activeRunManifest) {
      const nextManifest: RunManifest = {
        ...activeRunManifest,
        status: activeRunCompleted ? 'completed' : 'interrupted',
        updatedAt: new Date().toISOString(),
      }
      if (activeRunCompleted) {
        nextManifest.completedAt = nextManifest.updatedAt
      }
      void writeRunManifest(activeRunManifestPath, nextManifest).catch((error) => {
        sendToRenderer('scraper:error', { message: 'run_manifest_update_failed', error: String(error) })
      })
    }
    activeRunManifestPath = null
    activeRunManifest = null
    activeRunCompleted = false
    scraperProcess = null
  })

  return { ok: true }
}

async function launchAnnotatorProcess(
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<{ ok: boolean; error?: string }> {
  const pythonCmd = getPythonCmd()
  try {
    annotatorProcess = spawn(pythonCmd, args, {
      cwd: REPO_ROOT,
      env: buildSubprocessEnv(extraEnv),
    })
  } catch (error) {
    annotatorProcess = null
    return { ok: false, error: String(error) }
  }

  let annotatorStdoutBuf = ''
  annotatorProcess.stdout.on('data', (chunk) => {
    annotatorStdoutBuf += chunk.toString()
    const lines = annotatorStdoutBuf.split(/\r?\n/)
    annotatorStdoutBuf = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      if (line.startsWith('[STREAM] ')) {
        try {
          const payload = JSON.parse(line.slice(9))
          sendToRenderer('annotator:stream', payload)
        } catch {
          sendToRenderer('annotator:log', { message: line })
        }
      } else {
        sendToRenderer('annotator:log', { message: line })
      }
    }
  })
  annotatorProcess.stderr.on('data', (chunk) => {
    sendToRenderer('annotator:log', { message: chunk.toString().trimEnd() })
  })
  annotatorProcess.on('error', (error) => {
    sendToRenderer('annotator:log', { message: `Error: ${String(error)}` })
  })
  annotatorProcess.on('close', (code, signal) => {
    sendToRenderer('annotator:exit', { code, signal })
    annotatorProcess = null
  })

  return { ok: true }
}

async function getDirectorySize(dirPath: string): Promise<number> {
  let total = 0
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      total += await getDirectorySize(fullPath)
    } else if (entry.isFile()) {
      try {
        const stat = await fs.promises.stat(fullPath)
        total += stat.size
      } catch {
        continue
      }
    }
  }
  return total
}

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
    },
  })

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', (new Date).toLocaleString())
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
  ensureHpcPoller()
}

function createPolicyWindow(url: string) {
  const policyWin = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Policy Viewer',
    backgroundColor: '#0B0E14',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  policyWin.setMenuBarVisibility(false)
  policyWin.loadURL(url)
  policyWindows.add(policyWin)
  policyWin.on('closed', () => {
    policyWindows.delete(policyWin)
  })
  return policyWin
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function createLogWindow(content: string, title?: string) {
  const logWin = new BrowserWindow({
    width: 1100,
    height: 800,
    title: title || 'Run logs',
    backgroundColor: '#0B0E14',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  logWin.setMenuBarVisibility(false)
  const safe = escapeHtml(content || '')
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title || 'Run logs')}</title>
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
</html>`
  logWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  logWindows.add(logWin)
  logWin.on('closed', () => {
    logWindows.delete(logWin)
  })
  return logWin
}

ipcMain.handle('scraper:get-paths', async (_event, outDir?: string) => {
  if (await hpcAvailable()) {
    const res = await hpcRequest(`/api/paths?outDir=${encodeURIComponent(String(outDir || ''))}`)
    return res?.data || defaultPaths(outDir)
  }
  return defaultPaths(outDir)
})

ipcMain.handle('scraper:read-summary', async (_event, filePath?: string) => {
  if (await hpcAvailable()) {
    return hpcRequest(`/api/summary?filePath=${encodeURIComponent(String(filePath || ''))}`)
  }
  try {
    const target = filePath ? path.resolve(REPO_ROOT, filePath) : defaultPaths().summaryJson
    if (!fs.existsSync(target)) {
      return { ok: false, error: 'not_found', path: target }
    }
    const data = await readJsonFileCached(target)
    return { ok: true, data, path: target }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
})

ipcMain.handle('scraper:read-state', async (_event, filePath?: string) => {
  if (await hpcAvailable()) {
    return hpcRequest(`/api/state?filePath=${encodeURIComponent(String(filePath || ''))}`)
  }
  try {
    const target = filePath ? path.resolve(REPO_ROOT, filePath) : defaultPaths().stateJson
    if (!fs.existsSync(target)) {
      return { ok: false, error: 'not_found', path: target }
    }
    const data = await readJsonFileCached(target)
    return { ok: true, data, path: target }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
})

ipcMain.handle('scraper:read-explorer', async (_event, filePath?: string, limit?: number) => {
  if (await hpcAvailable()) {
    const params = new URLSearchParams()
    if (filePath) params.set('filePath', String(filePath))
    if (limit) params.set('limit', String(limit))
    return hpcRequest(`/api/explorer?${params.toString()}`)
  }
  try {
    const target = filePath ? path.resolve(REPO_ROOT, filePath) : defaultPaths().explorerJsonl
    if (!fs.existsSync(target)) {
      return { ok: false, error: 'not_found', path: target }
    }
    const data = target.endsWith('.jsonl')
      ? (await readJsonlFileCached(target)).slice(0, limit || undefined)
      : await readJsonFileCached(target)
    return { ok: true, data, path: target }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
})

ipcMain.handle('scraper:read-results', async (_event, filePath?: string, limit?: number) => {
  if (await hpcAvailable()) {
    const params = new URLSearchParams()
    if (filePath) params.set('filePath', String(filePath))
    if (limit) params.set('limit', String(limit))
    return hpcRequest(`/api/results?${params.toString()}`)
  }
  try {
    const target = filePath ? path.resolve(REPO_ROOT, filePath) : defaultPaths().resultsJsonl
    if (!fs.existsSync(target)) {
      return { ok: false, error: 'not_found', path: target }
    }
    const data = (await readJsonlFileCached(target)).slice(0, limit || undefined)
    return { ok: true, data, path: target }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
})

ipcMain.handle('scraper:read-audit-state', async (_event, outDir?: string) => {
  if (await hpcAvailable()) {
    return hpcRequest(`/api/audit-state?outDir=${encodeURIComponent(String(outDir || ''))}`)
  }
  try {
    const statePath = getAuditStatePath(outDir)
    const data = await readAuditStateFile(statePath)
    return { ok: true, data, path: statePath }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
})

ipcMain.handle('scraper:read-run-manifest', async (_event, outDir?: string) => {
  if (await hpcAvailable()) {
    return hpcRequest(`/api/run-manifest?outDir=${encodeURIComponent(String(outDir || ''))}`)
  }
  try {
    const manifestPath = getRunManifestPath(outDir)
    if (!fs.existsSync(manifestPath)) {
      return { ok: false, error: 'not_found', path: manifestPath }
    }
    const raw = await fs.promises.readFile(manifestPath, 'utf-8')
    return { ok: true, data: JSON.parse(raw), path: manifestPath }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
})

ipcMain.handle(
  'scraper:write-audit-state',
  async (_event, payload?: { outDir?: string; verifiedSites?: string[]; urlOverrides?: Record<string, string> }) => {
    if (await hpcAvailable()) {
      return hpcRequest('/api/write-audit-state', {
        method: 'POST',
        body: JSON.stringify(payload || {}),
      })
    }
    try {
      const statePath = getAuditStatePath(payload?.outDir)
      const dirPath = path.dirname(statePath)
      await fs.promises.mkdir(dirPath, { recursive: true })
      const verifiedSites = Array.isArray(payload?.verifiedSites)
        ? payload.verifiedSites
            .filter((value) => typeof value === 'string' && value.trim().length > 0)
            .map((value) => normalizeSiteKey(value))
        : []
      const urlOverridesRaw = payload?.urlOverrides || {}
      const urlOverrides: Record<string, string> = {}
      for (const [site, url] of Object.entries(urlOverridesRaw)) {
        if (typeof url === 'string' && url.trim().length > 0) {
          urlOverrides[normalizeSiteKey(site)] = url.trim()
        }
      }
      const nextState: AuditStateFile = {
        verifiedSites: Array.from(new Set(verifiedSites)),
        urlOverrides,
        updatedAt: new Date().toISOString(),
      }
      await fs.promises.writeFile(statePath, JSON.stringify(nextState, null, 2), 'utf-8')
      return { ok: true, data: nextState, path: statePath }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  }
)

ipcMain.handle('scraper:read-artifact-text', async (_event, options?: { outDir?: string; relativePath?: string }) => {
  if (await hpcAvailable()) {
    return hpcRequest('/api/artifact-text', {
      method: 'POST',
      body: JSON.stringify(options || {}),
    })
  }
  try {
    const relativePath = options?.relativePath
    if (!relativePath) {
      return { ok: false, error: 'missing_relative_path' }
    }
    const root = options?.outDir ? path.resolve(REPO_ROOT, options.outDir) : defaultPaths().outDir
    const fullPath = path.resolve(root, relativePath)
    const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`
    if (fullPath !== root && !fullPath.startsWith(normalizedRoot)) {
      return { ok: false, error: 'path_outside_root' }
    }
    if (!fs.existsSync(fullPath)) {
      return { ok: false, error: 'not_found', path: fullPath }
    }
    const raw = await fs.promises.readFile(fullPath, 'utf-8')
    return { ok: true, data: raw, path: fullPath }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
})

ipcMain.handle('scraper:folder-size', async (_event, outDir?: string) => {
  if (await hpcAvailable()) {
    return hpcRequest(`/api/folder-size?outDir=${encodeURIComponent(String(outDir || ''))}`)
  }
  try {
    const target = outDir ? path.resolve(REPO_ROOT, outDir) : defaultPaths().outDir
    if (!fs.existsSync(target)) {
      return { ok: false, error: 'not_found', path: target }
    }
    const size = await readMetricCached(`folder-size:${target}`, 10_000, () => getDirectorySize(target))
    return { ok: true, bytes: size, path: target }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
})

ipcMain.handle('scraper:list-runs', async (_event, baseOutDir?: string) => {
  if (await hpcAvailable()) {
    return hpcRequest(`/api/list-runs?baseOutDir=${encodeURIComponent(String(baseOutDir || ''))}`)
  }
  try {
    const root = baseOutDir ? path.resolve(REPO_ROOT, baseOutDir) : defaultPaths().outDir
    if (!fs.existsSync(root)) {
      return { ok: false, error: 'not_found', path: root }
    }
    const entries = await fs.promises.readdir(root, { withFileTypes: true })
    const runs: any[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root, entry.name)
      const summaryPath = path.join(dir, 'results.summary.json')
      const statePath = path.join(dir, 'run_state.json')
      let summary: any = null
      let state: any = null
      if (fs.existsSync(summaryPath)) {
        try {
          summary = JSON.parse(await fs.promises.readFile(summaryPath, 'utf-8'))
        } catch {
          summary = null
        }
      }
      if (fs.existsSync(statePath)) {
        try {
          state = JSON.parse(await fs.promises.readFile(statePath, 'utf-8'))
        } catch {
          state = null
        }
      }
      if (!summary && !state && !entry.name.startsWith('output_')) {
        continue
      }
      let mtime = ''
      try {
        const stat = await fs.promises.stat(dir)
        mtime = stat.mtime.toISOString()
      } catch {
        mtime = ''
      }
      const runId = summary?.run_id || state?.run_id || entry.name.replace(/^output_/, '')
      runs.push({
        runId,
        folder: entry.name,
        outDir: path.relative(REPO_ROOT, dir),
        summary,
        state,
        updated_at: summary?.updated_at || state?.updated_at || mtime,
        started_at: summary?.started_at || state?.started_at || null,
      })
    }
    runs.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    return { ok: true, root, runs }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
})

ipcMain.handle('scraper:start', async (_event, options: ScraperStartOptions = {}) => {
  if (await hpcAvailable()) {
    return hpcRequest('/api/start-run', {
      method: 'POST',
      body: JSON.stringify(options || {}),
    })
  }
  if (scraperProcess) {
    return { ok: false, error: 'scraper_already_running' }
  }

  const paths = defaultPaths(options.outDir)
  const args: string[] = [
    '-m',
    'privacy_research_dataset.cli',
    '--out',
    paths.resultsJsonl,
    '--artifacts-dir',
    options.artifactsDir ? path.resolve(REPO_ROOT, options.artifactsDir) : paths.artifactsDir,
    '--artifacts-ok-dir',
    paths.artifactsOkDir,
    '--emit-events',
    '--state-file',
    paths.stateJson,
    '--summary-out',
    paths.summaryJson,
    '--explorer-out',
    paths.explorerJsonl,
    '--concurrency',
    String(DASHBOARD_SAFE_CONCURRENCY),
    '--crux-concurrency',
    String(DASHBOARD_SAFE_CRUX_CONCURRENCY),
    '--policy-cache-max-entries',
    String(DASHBOARD_SAFE_POLICY_CACHE_MAX),
    '--tp-cache-flush-entries',
    String(DASHBOARD_SAFE_TP_CACHE_FLUSH),
  ]

  if (Array.isArray(options.sites) && options.sites.length > 0) {
    for (const site of options.sites) {
      const trimmed = String(site || '').trim()
      if (trimmed) {
        args.push('--site', trimmed)
      }
    }
  } else if (options.topN) {
    args.push('--tranco-top', String(options.topN))
  }
  if (options.trancoDate) {
    args.push('--tranco-date', options.trancoDate)
  }
  if (options.resumeAfterRank && Number.isFinite(options.resumeAfterRank)) {
    args.push('--resume-after-rank', String(options.resumeAfterRank))
  }
  if (options.expectedTotalSites && Number.isFinite(options.expectedTotalSites)) {
    args.push('--expected-total-sites', String(options.expectedTotalSites))
  }
  if (options.trackerRadarIndex) {
    const trackerPath = path.resolve(REPO_ROOT, options.trackerRadarIndex)
    if (fs.existsSync(trackerPath)) {
      args.push('--tracker-radar-index', trackerPath)
    } else {
      sendToRenderer('scraper:error', { message: 'tracker_radar_index_not_found', path: trackerPath })
    }
  }
  if (options.trackerDbIndex) {
    const trackerDbPath = path.resolve(REPO_ROOT, options.trackerDbIndex)
    if (fs.existsSync(trackerDbPath)) {
      args.push('--trackerdb-index', trackerDbPath)
    } else {
      sendToRenderer('scraper:error', { message: 'trackerdb_index_not_found', path: trackerDbPath })
    }
  }
  if (options.runId) {
    args.push('--run-id', options.runId)
  }
  if (options.upsertBySite) {
    args.push('--upsert-by-site')
  }
  // Always pass the cache file so it persists across runs regardless of whether
  // --crux-filter is active this session.
  args.push('--crux-cache-file', paths.cruxCacheJson)
  if (options.cruxFilter) {
    args.push('--crux-filter')
    if (options.cruxApiKey) {
      args.push('--crux-api-key', options.cruxApiKey)
    }
  }
  if (options.skipHomeFailed) {
    args.push('--skip-home-fetch-failed')
  }
  if (options.excludeSameEntity) {
    args.push('--exclude-same-entity')
  }

  const now = new Date().toISOString()
  const manifest: RunManifest = {
    version: 1,
    status: 'running',
    mode: Array.isArray(options.sites) && options.sites.length > 0 ? 'append_sites' : 'tranco',
    runId: options.runId,
    topN: options.topN,
    trancoDate: options.trancoDate,
    resumeAfterRank: options.resumeAfterRank,
    expectedTotalSites: options.expectedTotalSites,
    requestedSites: Array.isArray(options.sites) ? options.sites.map((site) => String(site).trim()).filter(Boolean) : [],
    cruxFilter: !!options.cruxFilter,
    startedAt: now,
    updatedAt: now,
  }

  const launched = await launchScraperProcess(args, {}, {
    path: getRunManifestPath(options.outDir),
    data: manifest,
  })
  if (!launched.ok) {
    return { ok: false, error: launched.error || 'failed_to_start' }
  }
  return { ok: true, paths }
})

ipcMain.handle('scraper:rerun-site', async (_event, options: RerunSiteOptions = {}) => {
  if (await hpcAvailable()) {
    return hpcRequest('/api/rerun-site', {
      method: 'POST',
      body: JSON.stringify(options || {}),
    })
  }
  if (scraperProcess) {
    return { ok: false, error: 'scraper_already_running' }
  }
  if (annotatorProcess) {
    return { ok: false, error: 'annotator_running' }
  }

  const site = String(options.site || '').trim()
  if (!site) {
    return { ok: false, error: 'missing_site' }
  }

  const paths = defaultPaths(options.outDir)
  const args: string[] = [
    '-m',
    'privacy_research_dataset.cli',
    '--site',
    site,
    '--out',
    paths.resultsJsonl,
    '--artifacts-dir',
    options.artifactsDir ? path.resolve(REPO_ROOT, options.artifactsDir) : paths.artifactsDir,
    '--artifacts-ok-dir',
    paths.artifactsOkDir,
    '--emit-events',
    '--state-file',
    paths.stateJson,
    '--summary-out',
    paths.summaryJson,
    '--explorer-out',
    paths.explorerJsonl,
    '--force',
    '--upsert-by-site',
    '--concurrency',
    '1',
  ]

  if (options.trackerRadarIndex) {
    const trackerPath = path.resolve(REPO_ROOT, options.trackerRadarIndex)
    if (fs.existsSync(trackerPath)) {
      args.push('--tracker-radar-index', trackerPath)
    } else {
      sendToRenderer('scraper:error', { message: 'tracker_radar_index_not_found', path: trackerPath })
    }
  }
  if (options.trackerDbIndex) {
    const trackerDbPath = path.resolve(REPO_ROOT, options.trackerDbIndex)
    if (fs.existsSync(trackerDbPath)) {
      args.push('--trackerdb-index', trackerDbPath)
    } else {
      sendToRenderer('scraper:error', { message: 'trackerdb_index_not_found', path: trackerDbPath })
    }
  }
  if (options.runId) {
    args.push('--run-id', options.runId)
  }
  if (options.excludeSameEntity) {
    args.push('--exclude-same-entity')
  }
  if (options.policyUrlOverride && options.policyUrlOverride.trim()) {
    args.push('--policy-url-override', options.policyUrlOverride.trim())
  }
  if (options.llmModel && options.llmModel.trim()) {
    args.push('--llm-model', options.llmModel.trim())
  }

  const launched = await launchScraperProcess(args)
  if (!launched.ok) {
    return { ok: false, error: launched.error || 'failed_to_start' }
  }
  return { ok: true, paths, site }
})

ipcMain.handle('scraper:stop', async () => {
  if (await hpcAvailable()) {
    return hpcRequest('/api/stop-run', {
      method: 'POST',
      body: JSON.stringify({}),
    })
  }
  if (!scraperProcess) return { ok: false, error: 'not_running' }
  scraperProcess.kill()
  return { ok: true }
})

ipcMain.handle('scraper:open-log-window', async (_event, payload?: { content?: string; title?: string }) => {
  try {
    const content = payload?.content ?? ''
    const title = payload?.title
    createLogWindow(content, title)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
})

ipcMain.handle('scraper:open-policy-window', async (_event, url?: string) => {
  if (!url || typeof url !== 'string') {
    return { ok: false, error: 'invalid_url' }
  }
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { ok: false, error: 'unsupported_protocol' }
    }
    createPolicyWindow(url)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
})

ipcMain.handle('scraper:clear-results', async (_event, options?: { includeArtifacts?: boolean; outDir?: string }) => {
  if (await hpcAvailable()) {
    return hpcRequest('/api/clear-results', {
      method: 'POST',
      body: JSON.stringify(options || {}),
    })
  }
  if (scraperProcess) {
    return { ok: false, error: 'scraper_running' }
  }

  const paths = defaultPaths(options?.outDir)
  const targets = [
    paths.resultsJsonl,
    paths.summaryJson,
    paths.stateJson,
    paths.explorerJsonl,
    path.join(paths.outDir, 'audit_state.json'),
    getRunManifestPath(options?.outDir),
  ]
  const removed: string[] = []
  const missing: string[] = []
  const errors: string[] = []

  for (const target of targets) {
    try {
      if (fs.existsSync(target)) {
        await fs.promises.rm(target, { force: true })
        removed.push(target)
      } else {
        missing.push(target)
      }
    } catch (error) {
      errors.push(`${target}: ${String(error)}`)
    }
  }

  if (options?.includeArtifacts) {
    try {
      if (fs.existsSync(paths.artifactsDir)) {
        await fs.promises.rm(paths.artifactsDir, { recursive: true, force: true })
        removed.push(paths.artifactsDir)
      }
    } catch (error) {
      errors.push(`${paths.artifactsDir}: ${String(error)}`)
    }
  }

  return { ok: errors.length === 0, removed, missing, errors, paths }
})

ipcMain.handle('scraper:delete-output', async (_event, outDir?: string) => {
  if (await hpcAvailable()) {
    return hpcRequest('/api/delete-output', {
      method: 'POST',
      body: JSON.stringify({ outDir }),
    })
  }
  try {
    const target = outDir ? path.resolve(REPO_ROOT, outDir) : defaultPaths().outDir
    if (!fs.existsSync(target)) {
      return { ok: false, error: 'not_found', path: target }
    }
    await fs.promises.rm(target, { recursive: true, force: true })
    return { ok: true, path: target }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
})

ipcMain.handle('scraper:start-annotate', async (_event, options: AnnotateStartOptions = {}) => {
  if (await hpcAvailable()) {
    return hpcRequest('/api/start-annotate', {
      method: 'POST',
      body: JSON.stringify(options || {}),
    })
  }
  if (annotatorProcess) {
    return { ok: false, error: 'annotator_already_running' }
  }

  const artifactsDir = options.artifactsDir
    ? path.resolve(REPO_ROOT, options.artifactsDir)
    : path.join(defaultPaths().outDir, 'artifacts')

  const args: string[] = [
    '-m', 'privacy_research_dataset.annotate_cli',
    '--artifacts-dir', artifactsDir,
  ]

  if (options.llmModel) args.push('--llm-model', options.llmModel)
  if (options.tokenLimit) args.push('--token-limit', String(options.tokenLimit))
  const modelKey = normalizeModelKey(options.llmModel)
  const preferredConcurrency = isLowTpmModelKey(modelKey) ? 1 : undefined
  let requestedConcurrency = options.concurrency || preferredConcurrency
  if (preferredConcurrency && requestedConcurrency && requestedConcurrency > preferredConcurrency) {
    requestedConcurrency = preferredConcurrency
    sendToRenderer('annotator:log', {
      message: `[info] ${options.llmModel || modelKey}: forcing concurrency ${preferredConcurrency} for TPM stability.`,
    })
  }
  if (requestedConcurrency) args.push('--concurrency', String(requestedConcurrency))
  args.push(...annotatorRateLimitArgs(options.llmModel))
  if (options.force) args.push('--force')

  const launched = await launchAnnotatorProcess(args)
  if (!launched.ok) {
    return { ok: false, error: launched.error || 'failed_to_start' }
  }
  return { ok: true, artifactsDir }
})

ipcMain.handle('scraper:annotate-site', async (_event, options: AnnotateSiteOptions = {}) => {
  if (await hpcAvailable()) {
    return hpcRequest('/api/annotate-site', {
      method: 'POST',
      body: JSON.stringify(options || {}),
    })
  }
  if (annotatorProcess) {
    return { ok: false, error: 'annotator_already_running' }
  }
  if (scraperProcess) {
    return { ok: false, error: 'scraper_running' }
  }

  const site = String(options.site || '').trim()
  if (!site) {
    return { ok: false, error: 'missing_site' }
  }

  const paths = defaultPaths(options.outDir)
  const args: string[] = [
    '-m',
    'privacy_research_dataset.annotate_cli',
    '--artifacts-dir',
    paths.artifactsDir,
    '--target-dir',
    site,
    '--concurrency',
    '1',
  ]
  if (options.llmModel && options.llmModel.trim()) {
    args.push('--llm-model', options.llmModel.trim())
  }
  args.push(...annotatorRateLimitArgs(options.llmModel))
  if (typeof options.tokenLimit === 'number' && Number.isFinite(options.tokenLimit)) {
    args.push('--token-limit', String(options.tokenLimit))
  }
  if (options.force !== false) {
    args.push('--force')
  }

  const launched = await launchAnnotatorProcess(args)
  if (!launched.ok) {
    return { ok: false, error: launched.error || 'failed_to_start' }
  }
  return { ok: true, artifactsDir: paths.artifactsDir, site }
})

ipcMain.handle('scraper:stop-annotate', async () => {
  if (await hpcAvailable()) {
    return hpcRequest('/api/stop-annotate', {
      method: 'POST',
      body: JSON.stringify({}),
    })
  }
  if (!annotatorProcess) return { ok: false, error: 'not_running' }
  annotatorProcess.kill()
  return { ok: true }
})

/**
 * Probe whether the HPC SSH tunnel to the DeepSeek GPU node is reachable.
 * The Python backend connects to the same port (8901); this check lets the
 * dashboard surface "Tunnel active / offline" status before launching jobs.
 */
ipcMain.handle('scraper:check-tunnel', async () => {
  const health = await hpcHealth()
  if (!health) {
    return { ok: false, error: 'offline' }
  }
  return { ok: true, status: 200, data: health }
})

ipcMain.handle('scraper:annotation-stats', async (_event, artifactsDir?: string) => {
  if (await hpcAvailable()) {
    return hpcRequest(`/api/annotation-stats?artifactsDir=${encodeURIComponent(String(artifactsDir || ''))}`)
  }
  try {
    const targetDir = artifactsDir
      ? path.resolve(REPO_ROOT, artifactsDir)
      : path.join(defaultPaths().outDir, 'artifacts')

    if (!fs.existsSync(targetDir)) {
      return { ok: true, total_sites: 0, annotated_sites: 0, total_statements: 0, per_site: [] }
    }

    return await readMetricCached(`annotation-stats:${targetDir}`, 5_000, async () => {
      const countLines = async (filePath: string): Promise<number> => {
        try {
          const content = await fs.promises.readFile(filePath, 'utf-8')
          return content.split('\n').filter((line) => line.trim()).length
        } catch {
          return 0
        }
      }

      const entries = await fs.promises.readdir(targetDir, { withFileTypes: true })
      const perSite: { site: string; count: number; has_statements: boolean }[] = []
      const perTp: { site: string; tp: string; count: number; has_statements: boolean }[] = []
      let totalStatements = 0
      let tpTotalStatements = 0

      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        const statementsPath = path.join(targetDir, entry.name, 'policy_statements.jsonl')
        const hasStatements = fs.existsSync(statementsPath)
        let count = 0
        if (hasStatements) {
          count = await countLines(statementsPath)
          totalStatements += count
        }
        perSite.push({ site: entry.name, count, has_statements: hasStatements })

        const tpRoot = path.join(targetDir, entry.name, 'third_party')
        if (fs.existsSync(tpRoot)) {
          const tpEntries = await fs.promises.readdir(tpRoot, { withFileTypes: true })
          for (const tpEntry of tpEntries) {
            if (!tpEntry.isDirectory()) continue
            const tpStmtsPath = path.join(tpRoot, tpEntry.name, 'policy_statements.jsonl')
            const tpHas = fs.existsSync(tpStmtsPath)
            let tpCount = 0
            if (tpHas) {
              tpCount = await countLines(tpStmtsPath)
              tpTotalStatements += tpCount
            }
            perTp.push({ site: entry.name, tp: tpEntry.name, count: tpCount, has_statements: tpHas })
          }
        }
      }

      const annotatedSites = perSite.filter((s) => s.has_statements).length
      const tpAnnotatedCount = perTp.filter((t) => t.has_statements).length
      return {
        ok: true,
        total_sites: perSite.length,
        annotated_sites: annotatedSites,
        total_statements: totalStatements,
        per_site: perSite,
        tp_total: perTp.length,
        tp_annotated: tpAnnotatedCount,
        tp_total_statements: tpTotalStatements,
        per_tp: perTp,
      }
    })
  } catch (error) {
    return { ok: false, error: String(error) }
  }
})

ipcMain.handle('scraper:count-ok-artifacts', async (_event, outDir?: string) => {
  if (await hpcAvailable()) {
    return hpcRequest(`/api/count-ok-artifacts?outDir=${encodeURIComponent(String(outDir || ''))}`)
  }
  try {
    const paths = defaultPaths(outDir)
    const okDir = paths.artifactsOkDir
    if (!fs.existsSync(okDir)) {
      return { ok: true, count: 0, sites: [], path: okDir }
    }
    const entries = await fs.promises.readdir(okDir, { withFileTypes: true })
    const sites = entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name)
    return { ok: true, count: sites.length, sites, path: okDir }
  } catch (error) {
    return { ok: false, error: String(error), count: 0, sites: [] }
  }
})

ipcMain.handle('scraper:read-tp-cache', async (_event, outDir?: string) => {
  if (await hpcAvailable()) {
    return hpcRequest(`/api/read-tp-cache?outDir=${encodeURIComponent(String(outDir || ''))}`)
  }
  try {
    const root = outDir ? path.resolve(REPO_ROOT, outDir) : defaultPaths().outDir
    const cachePath = path.join(root, 'results.tp_cache.json')
    if (!fs.existsSync(cachePath)) {
      return { ok: false, error: 'not_found', path: cachePath }
    }
    const raw = await fs.promises.readFile(cachePath, 'utf-8')
    const data = JSON.parse(raw)
    let total = 0
    let fetched = 0
    let failed = 0
    const byStatus: Record<string, number> = {}
    for (const entry of Object.values(data) as any[]) {
      total++
      if (entry.text !== null && entry.text !== undefined) {
        fetched++
      } else if (entry.error_message) {
        failed++
      }
      const code = String(entry.status_code ?? 'unknown')
      byStatus[code] = (byStatus[code] || 0) + 1
    }
    return { ok: true, total, fetched, failed, by_status: byStatus }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
})

ipcMain.handle('scraper:crux-cache-stats', async (_event, outDir?: string) => {
  if (await hpcAvailable()) {
    return hpcRequest(`/api/crux-cache-stats?outDir=${encodeURIComponent(String(outDir || ''))}`)
  }
  try {
    const paths = defaultPaths(outDir)
    const cachePath = paths.cruxCacheJson
    if (!fs.existsSync(cachePath)) {
      return { ok: true, count: 0, present: 0, absent: 0, path: cachePath }
    }
    const raw = await fs.promises.readFile(cachePath, 'utf-8')
    const data = JSON.parse(raw) as Record<string, boolean>
    const entries = Object.values(data)
    const present = entries.filter(Boolean).length
    const absent = entries.length - present
    return { ok: true, count: entries.length, present, absent, path: cachePath }
  } catch (error) {
    return { ok: false, error: String(error), count: 0, present: 0, absent: 0 }
  }
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  stopHpcPoller()
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(createWindow)
