import { app, BrowserWindow, ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import net from 'node:net'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
const REPO_ROOT = path.resolve(process.env.APP_ROOT, '..')
const SCRAPER_SCRIPTS_ROOT = path.join(REPO_ROOT, 'hpc', 'scraper')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

const HPC_SERVICE_ORIGIN = process.env.PRIVACY_DATASET_HPC_ORIGIN || 'http://127.0.0.1:8910'

let win: BrowserWindow | null
const policyWindows = new Set<BrowserWindow>()
const logWindows = new Set<BrowserWindow>()
let hpcPollCursor = 0
let hpcPollTimer: NodeJS.Timeout | null = null

function sendToRenderer(channel: string, payload: unknown) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

async function hpcRequest(pathname: string, init?: RequestInit): Promise<any> {
  try {
    const response = await fetch(`${HPC_SERVICE_ORIGIN}${pathname}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init?.headers || {}),
      },
    })
    if (!response.ok) {
      return { ok: false, error: `http_${response.status}` }
    }
    return await response.json()
  } catch (error) {
    return { ok: false, error: 'offline', detail: String(error) }
  }
}

async function probeLocalBridgePort(port: number, host = '127.0.0.1', timeoutMs = 1000): Promise<{ ok: boolean; error?: string }> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    const finish = (payload: { ok: boolean; error?: string }) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(payload)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish({ ok: true }))
    socket.once('timeout', () => finish({ ok: false, error: 'timeout' }))
    socket.once('error', (error) => finish({ ok: false, error: String(error) }))
  })
}

function encode(value: string | undefined): string {
  return encodeURIComponent(String(value || ''))
}

function params(entries: Array<[string, string | number | undefined]>): string {
  const search = new URLSearchParams()
  for (const [key, value] of entries) {
    if (value !== undefined && value !== '') {
      search.set(key, String(value))
    }
  }
  return search.toString()
}

function ensureHpcPoller() {
  if (hpcPollTimer) return
  hpcPollTimer = setInterval(async () => {
    if (!win || win.isDestroyed()) return
    const res = await hpcRequest(`/api/poll?cursor=${hpcPollCursor}`)
    if (!res?.ok) return
    hpcPollCursor = Number(res.cursor || hpcPollCursor)
    for (const item of res.items || []) {
      if (item?.channel) {
        sendToRenderer(item.channel, item.payload)
      }
    }
  }, 1500)
}

type LocalScriptResult = {
  ok: boolean
  code: number
  command: string
  stdout: string
  stderr: string
  error?: string
  hint?: string
}

async function runLocalScript(scriptName: string, args: string[] = [], timeoutMs = 30000): Promise<LocalScriptResult> {
  const scriptPath = path.join(SCRAPER_SCRIPTS_ROOT, scriptName)
  const command = [scriptPath, ...args].join(' ')
  return await new Promise((resolve) => {
    execFile(
      scriptPath,
      args,
      {
        cwd: REPO_ROOT,
        timeout: timeoutMs,
        env: {
          ...process.env,
          SSH_ASKPASS_REQUIRE: 'never',
        },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const combined = `${stdout}\n${stderr}`.toLowerCase()
        let hint: string | undefined
        if (combined.includes('permission denied') || combined.includes('ssh_askpass')) {
          hint = 'SSH authentication was required. Run the repair from a terminal or establish SSH auth first.'
        } else if (combined.includes('could not resolve a running scraper-orch node')) {
          hint = 'No running scraper orchestrator was found. Start or verify the Slurm job first.'
        } else if (combined.includes('still not answering')) {
          hint = 'The tunnel was reopened, but the remote orchestrator did not answer on /health.'
        }
        resolve({
          ok: !error,
          code: typeof (error as any)?.code === 'number' ? (error as any).code : 0,
          command,
          stdout,
          stderr,
          error: error ? String(error.message || error) : undefined,
          hint,
        })
      }
    )
  })
}

function stopHpcPoller() {
  if (!hpcPollTimer) return
  clearInterval(hpcPollTimer)
  hpcPollTimer = null
}

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
    },
  })

  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', (new Date()).toLocaleString())
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
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
  const res = await hpcRequest(`/api/paths?outDir=${encode(outDir)}`)
  return res?.ok ? res.data : res
})

ipcMain.handle('scraper:read-summary', async (_event, filePath?: string) => {
  return hpcRequest(`/api/summary?filePath=${encode(filePath)}`)
})

ipcMain.handle('scraper:read-state', async (_event, filePath?: string) => {
  return hpcRequest(`/api/state?filePath=${encode(filePath)}`)
})

ipcMain.handle('scraper:read-explorer', async (_event, filePath?: string, limit?: number) => {
  return hpcRequest(`/api/explorer?${params([['filePath', filePath], ['limit', limit]])}`)
})

ipcMain.handle('scraper:read-results', async (_event, filePath?: string, limit?: number) => {
  return hpcRequest(`/api/results?${params([['filePath', filePath], ['limit', limit]])}`)
})

ipcMain.handle('scraper:read-audit-state', async (_event, outDir?: string) => {
  return hpcRequest(`/api/audit-state?outDir=${encode(outDir)}`)
})

ipcMain.handle('scraper:read-run-manifest', async (_event, outDir?: string) => {
  return hpcRequest(`/api/run-manifest?outDir=${encode(outDir)}`)
})

ipcMain.handle('scraper:write-audit-state', async (_event, payload?: unknown) => {
  return hpcRequest('/api/write-audit-state', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
})

ipcMain.handle('scraper:read-artifact-text', async (_event, payload?: unknown) => {
  return hpcRequest('/api/artifact-text', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
})

ipcMain.handle('scraper:folder-size', async (_event, outDir?: string) => {
  return hpcRequest(`/api/folder-size?outDir=${encode(outDir)}`)
})

ipcMain.handle('scraper:list-runs', async (_event, baseOutDir?: string) => {
  return hpcRequest(`/api/list-runs?baseOutDir=${encode(baseOutDir)}`)
})

ipcMain.handle('scraper:start', async (_event, payload?: unknown) => {
  return hpcRequest('/api/start-run', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
})

ipcMain.handle('scraper:rerun-site', async (_event, payload?: unknown) => {
  return hpcRequest('/api/rerun-site', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
})

ipcMain.handle('scraper:stop', async () => {
  return hpcRequest('/api/stop-run', {
    method: 'POST',
    body: JSON.stringify({}),
  })
})

ipcMain.handle('scraper:open-log-window', async (_event, payload?: { content?: string; title?: string }) => {
  try {
    createLogWindow(payload?.content ?? '', payload?.title)
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

ipcMain.handle('scraper:clear-results', async (_event, payload?: unknown) => {
  return hpcRequest('/api/clear-results', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
})

ipcMain.handle('scraper:delete-output', async (_event, outDir?: string) => {
  return hpcRequest('/api/delete-output', {
    method: 'POST',
    body: JSON.stringify({ outDir }),
  })
})

ipcMain.handle('scraper:start-annotate', async (_event, payload?: unknown) => {
  return hpcRequest('/api/start-annotate', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
})

ipcMain.handle('scraper:annotate-site', async (_event, payload?: unknown) => {
  return hpcRequest('/api/annotate-site', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
})

ipcMain.handle('scraper:stop-annotate', async () => {
  return hpcRequest('/api/stop-annotate', {
    method: 'POST',
    body: JSON.stringify({}),
  })
})

ipcMain.handle('scraper:check-tunnel', async () => {
  const healthResponse = await hpcRequest('/health')
  if (!healthResponse?.ok) {
    const localPort = await probeLocalBridgePort(8910)
    return {
      ok: false,
      error: localPort.ok ? 'stale_tunnel' : 'offline',
      data: {
        probe_error: healthResponse?.error || 'offline',
        probe_detail: healthResponse?.detail,
        local_port_listening: localPort.ok,
        tunnel_state: localPort.ok ? 'stale' : 'offline',
        checked_at: new Date().toISOString(),
      },
    }
  }
  const status = await hpcRequest('/api/status')
  return {
    ok: true,
    status: 200,
    data: {
      ...healthResponse,
      ...(status?.ok ? status : {}),
      checked_at: new Date().toISOString(),
    },
  }
})

ipcMain.handle('scraper:diagnose-bridge', async () => {
  return await runLocalScript('check_bridge.sh')
})

ipcMain.handle('scraper:repair-bridge', async () => {
  const repair = await runLocalScript('attach_tunnel.sh', [], 45000)
  if (!repair.ok) {
    return repair
  }
  const health = await hpcRequest('/health')
  return {
    ...repair,
    health_ok: Boolean(health?.ok),
  }
})

ipcMain.handle('scraper:annotation-stats', async (_event, artifactsDir?: string) => {
  return hpcRequest(`/api/annotation-stats?artifactsDir=${encode(artifactsDir)}`)
})

ipcMain.handle('scraper:count-ok-artifacts', async (_event, outDir?: string) => {
  return hpcRequest(`/api/count-ok-artifacts?outDir=${encode(outDir)}`)
})

ipcMain.handle('scraper:read-tp-cache', async (_event, outDir?: string) => {
  return hpcRequest(`/api/read-tp-cache?outDir=${encode(outDir)}`)
})

ipcMain.handle('scraper:crux-cache-stats', async (_event, outDir?: string) => {
  return hpcRequest(`/api/crux-cache-stats?outDir=${encode(outDir)}`)
})

app.on('window-all-closed', () => {
  stopHpcPoller()
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(createWindow)
