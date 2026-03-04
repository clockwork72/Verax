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

let win: BrowserWindow | null
let scraperProcess: ChildProcessWithoutNullStreams | null = null
let annotatorProcess: ChildProcessWithoutNullStreams | null = null
const policyWindows = new Set<BrowserWindow>()
const logWindows = new Set<BrowserWindow>()

type ScraperStartOptions = {
  topN?: number
  trancoDate?: string
  trackerRadarIndex?: string
  trackerDbIndex?: string
  outDir?: string
  artifactsDir?: string
  runId?: string
  cruxFilter?: boolean
  cruxApiKey?: string
  skipHomeFailed?: boolean
  excludeSameEntity?: boolean
}

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

function defaultPaths(outDir?: string) {
  const root = outDir ? path.resolve(REPO_ROOT, outDir) : path.join(REPO_ROOT, 'outputs')
  return {
    outDir: root,
    resultsJsonl: path.join(root, 'results.jsonl'),
    summaryJson: path.join(root, 'results.summary.json'),
    stateJson: path.join(root, 'run_state.json'),
    explorerJsonl: path.join(root, 'explorer.jsonl'),
    artifactsDir: path.join(root, 'artifacts'),
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

ipcMain.handle('scraper:get-paths', (_event, outDir?: string) => {
  return defaultPaths(outDir)
})

ipcMain.handle('scraper:read-summary', async (_event, filePath?: string) => {
  try {
    const target = filePath ? path.resolve(REPO_ROOT, filePath) : defaultPaths().summaryJson
    if (!fs.existsSync(target)) {
      return { ok: false, error: 'not_found', path: target }
    }
    const raw = await fs.promises.readFile(target, 'utf-8')
    return { ok: true, data: JSON.parse(raw), path: target }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
})

ipcMain.handle('scraper:read-state', async (_event, filePath?: string) => {
  try {
    const target = filePath ? path.resolve(REPO_ROOT, filePath) : defaultPaths().stateJson
    if (!fs.existsSync(target)) {
      return { ok: false, error: 'not_found', path: target }
    }
    const raw = await fs.promises.readFile(target, 'utf-8')
    return { ok: true, data: JSON.parse(raw), path: target }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
})

ipcMain.handle('scraper:read-explorer', async (_event, filePath?: string, limit?: number) => {
  try {
    const target = filePath ? path.resolve(REPO_ROOT, filePath) : defaultPaths().explorerJsonl
    if (!fs.existsSync(target)) {
      return { ok: false, error: 'not_found', path: target }
    }
    const raw = await fs.promises.readFile(target, 'utf-8')
    const data = target.endsWith('.jsonl') ? parseJsonl(raw, limit) : JSON.parse(raw)
    return { ok: true, data, path: target }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
})

ipcMain.handle('scraper:read-artifact-text', async (_event, options?: { outDir?: string; relativePath?: string }) => {
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
  try {
    const target = outDir ? path.resolve(REPO_ROOT, outDir) : defaultPaths().outDir
    if (!fs.existsSync(target)) {
      return { ok: false, error: 'not_found', path: target }
    }
    const size = await getDirectorySize(target)
    return { ok: true, bytes: size, path: target }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
})

ipcMain.handle('scraper:list-runs', async (_event, baseOutDir?: string) => {
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
  if (scraperProcess) {
    return { ok: false, error: 'scraper_already_running' }
  }

  const paths = defaultPaths(options.outDir)
  const pythonCmd = getPythonCmd()
  const args: string[] = [
    '-m',
    'privacy_research_dataset.cli',
    '--out',
    paths.resultsJsonl,
    '--artifacts-dir',
    options.artifactsDir ? path.resolve(REPO_ROOT, options.artifactsDir) : paths.artifactsDir,
    '--emit-events',
    '--state-file',
    paths.stateJson,
    '--summary-out',
    paths.summaryJson,
    '--explorer-out',
    paths.explorerJsonl,
  ]

  if (options.topN) {
    args.push('--tranco-top', String(options.topN))
  }
  if (options.trancoDate) {
    args.push('--tranco-date', options.trancoDate)
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

  try {
    scraperProcess = spawn(pythonCmd, args, {
      cwd: REPO_ROOT,
      env: buildSubprocessEnv(),
    })
  } catch (error) {
    scraperProcess = null
    return { ok: false, error: String(error) }
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
        sendToRenderer('scraper:event', evt)
      } catch (error) {
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
    scraperProcess = null
  })

  return { ok: true, paths }
})

ipcMain.handle('scraper:stop', async () => {
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
  if (scraperProcess) {
    return { ok: false, error: 'scraper_running' }
  }

  const paths = defaultPaths(options?.outDir)
  const targets = [paths.resultsJsonl, paths.summaryJson, paths.stateJson, paths.explorerJsonl]
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

type AnnotateStartOptions = {
  artifactsDir?: string
  openaiApiKey?: string
  llmModel?: string
  tokenLimit?: number
  concurrency?: number
  force?: boolean
}

ipcMain.handle('scraper:start-annotate', async (_event, options: AnnotateStartOptions = {}) => {
  if (annotatorProcess) {
    return { ok: false, error: 'annotator_already_running' }
  }

  const pythonCmd = getPythonCmd()
  const artifactsDir = options.artifactsDir
    ? path.resolve(REPO_ROOT, options.artifactsDir)
    : path.join(defaultPaths().outDir, 'artifacts')

  const args: string[] = [
    '-m', 'privacy_research_dataset.annotate_cli',
    '--artifacts-dir', artifactsDir,
  ]

  if (options.llmModel) args.push('--llm-model', options.llmModel)
  if (options.tokenLimit) args.push('--token-limit', String(options.tokenLimit))
  if (options.concurrency) args.push('--concurrency', String(options.concurrency))
  if (options.force) args.push('--force')

  const annotatorExtra: Record<string, string> = {}
  if (options.openaiApiKey) annotatorExtra.OPENAI_API_KEY = options.openaiApiKey
  const env = buildSubprocessEnv(annotatorExtra)

  try {
    annotatorProcess = spawn(pythonCmd, args, { cwd: REPO_ROOT, env })
  } catch (error) {
    annotatorProcess = null
    return { ok: false, error: String(error) }
  }

  annotatorProcess.stdout.on('data', (chunk) => {
    sendToRenderer('annotator:log', { message: chunk.toString().trimEnd() })
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

  return { ok: true, artifactsDir }
})

ipcMain.handle('scraper:stop-annotate', async () => {
  if (!annotatorProcess) return { ok: false, error: 'not_running' }
  annotatorProcess.kill()
  return { ok: true }
})

ipcMain.handle('scraper:annotation-stats', async (_event, artifactsDir?: string) => {
  try {
    const targetDir = artifactsDir
      ? path.resolve(REPO_ROOT, artifactsDir)
      : path.join(defaultPaths().outDir, 'artifacts')

    if (!fs.existsSync(targetDir)) {
      return { ok: true, total_sites: 0, annotated_sites: 0, total_statements: 0, per_site: [] }
    }

    const entries = await fs.promises.readdir(targetDir, { withFileTypes: true })
    const perSite: { site: string; count: number; has_statements: boolean }[] = []
    let totalStatements = 0

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const statementsPath = path.join(targetDir, entry.name, 'policy_statements.jsonl')
      const hasStatements = fs.existsSync(statementsPath)
      let count = 0
      if (hasStatements) {
        try {
          const content = await fs.promises.readFile(statementsPath, 'utf-8')
          count = content.split('\n').filter((line) => line.trim()).length
          totalStatements += count
        } catch {
          count = 0
        }
      }
      perSite.push({ site: entry.name, count, has_statements: hasStatements })
    }

    const annotatedSites = perSite.filter((s) => s.has_statements).length
    return {
      ok: true,
      total_sites: perSite.length,
      annotated_sites: annotatedSites,
      total_statements: totalStatements,
      per_site: perSite,
    }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
})

ipcMain.handle('scraper:read-tp-cache', async (_event, outDir?: string) => {
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

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
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
