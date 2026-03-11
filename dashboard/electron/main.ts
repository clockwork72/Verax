import { app, BrowserWindow, ipcMain } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
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
const LOCAL_SOURCE_REV = (() => {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
})()

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
  signal?: string | null
  killed?: boolean
}

type RunLocalScriptOptions = {
  timeoutMs?: number
  interactiveSshPrompt?: boolean
}

type AskpassSession = {
  env: Record<string, string>
  cleanup: () => Promise<void>
}

function createSecretPrompt(promptText: string): Promise<string | null> {
  return new Promise((resolve) => {
    const submitChannel = `ssh-askpass-submit-${randomUUID()}`
    const cancelChannel = `ssh-askpass-cancel-${randomUUID()}`
    let settled = false
    const promptWin = new BrowserWindow({
      width: 420,
      height: 250,
      parent: win && !win.isDestroyed() ? win : undefined,
      modal: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      title: 'SSH Verification',
      backgroundColor: '#0B0E14',
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
      },
    })
    promptWin.setMenuBarVisibility(false)
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      ipcMain.removeAllListeners(submitChannel)
      ipcMain.removeAllListeners(cancelChannel)
      if (!promptWin.isDestroyed()) {
        promptWin.close()
      }
      resolve(value)
    }
    ipcMain.once(submitChannel, (_event, value?: string) => finish(String(value || '')))
    ipcMain.once(cancelChannel, () => finish(null))
    promptWin.on('closed', () => finish(null))
    const safePrompt = escapeHtml(promptText || 'Enter SSH verification code')
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SSH Verification</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #0B0E14; color: #E6EDF3; }
      main { padding: 22px; }
      h1 { margin: 0 0 8px; font-size: 16px; letter-spacing: 0.08em; text-transform: uppercase; color: #b9c2cc; }
      p { margin: 0 0 14px; font-size: 13px; color: #c8d1db; line-height: 1.45; }
      input { width: 100%; box-sizing: border-box; padding: 12px 14px; border-radius: 12px; border: 1px solid #273142; background: #111827; color: #fff; font-size: 15px; outline: none; }
      .actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 14px; }
      button { border-radius: 999px; border: 1px solid #334155; background: transparent; color: #cbd5e1; padding: 8px 14px; font-size: 12px; cursor: pointer; }
      button.primary { background: #d97706; border-color: #f59e0b; color: white; }
    </style>
  </head>
  <body>
    <main>
      <h1>SSH Verification</h1>
      <p>${safePrompt}</p>
      <form id="prompt-form">
        <input id="secret" type="password" autocomplete="one-time-code" autofocus />
        <div class="actions">
          <button type="button" id="cancel">Cancel</button>
          <button type="submit" class="primary">Submit</button>
        </div>
      </form>
    </main>
    <script>
      const { ipcRenderer } = require('electron')
      const input = document.getElementById('secret')
      const form = document.getElementById('prompt-form')
      const cancel = document.getElementById('cancel')
      window.addEventListener('DOMContentLoaded', () => input.focus())
      form.addEventListener('submit', (event) => {
        event.preventDefault()
        ipcRenderer.send('${submitChannel}', input.value)
      })
      cancel.addEventListener('click', () => ipcRenderer.send('${cancelChannel}'))
      window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          ipcRenderer.send('${cancelChannel}')
        }
      })
    </script>
  </body>
</html>`
    promptWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  })
}

async function createAskpassSession(): Promise<AskpassSession> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'scraper-askpass-'))
  const token = randomUUID()
  const helperPath = path.join(tempDir, 'askpass.cjs')
  const helperSource = `#!/usr/bin/env node
const http = require('node:http')

const prompt = process.argv.slice(2).join(' ') || 'Enter SSH verification code'
const payload = JSON.stringify({ prompt })
const req = http.request({
  hostname: '127.0.0.1',
  port: Number(process.env.SCRAPER_ASKPASS_PORT),
  path: '/askpass/' + process.env.SCRAPER_ASKPASS_TOKEN,
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  },
}, (res) => {
  let body = ''
  res.setEncoding('utf8')
  res.on('data', (chunk) => { body += chunk })
  res.on('end', () => {
    if (res.statusCode === 200) {
      process.stdout.write(body)
      process.exit(0)
    }
    if (body) {
      process.stderr.write(body)
    }
    process.exit(1)
  })
})
req.on('error', () => process.exit(1))
req.write(payload)
req.end()
`
  writeFileSync(helperPath, helperSource, { encoding: 'utf8' })
  chmodSync(helperPath, 0o700)
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== `/askpass/${token}`) {
      response.statusCode = 404
      response.end('')
      return
    }
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', async () => {
      let promptText = 'Enter SSH verification code'
      try {
        const parsed = JSON.parse(raw || '{}')
        if (parsed?.prompt) {
          promptText = String(parsed.prompt)
        }
      } catch {
        // ignore parse errors and fall back to a generic prompt
      }
      const answer = await createSecretPrompt(promptText)
      if (answer === null) {
        response.statusCode = 403
        response.end('ssh_verification_cancelled')
        return
      }
      response.statusCode = 200
      response.setHeader('content-type', 'text/plain; charset=utf-8')
      response.end(answer)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    rmSync(tempDir, { recursive: true, force: true })
    throw new Error('Failed to start SSH askpass server')
  }
  return {
    env: {
      DISPLAY: process.env.DISPLAY || 'codex-askpass:0',
      SSH_ASKPASS: helperPath,
      SSH_ASKPASS_REQUIRE: 'force',
      SCRAPER_ASKPASS_PORT: String(address.port),
      SCRAPER_ASKPASS_TOKEN: token,
    },
    cleanup: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(tempDir, { recursive: true, force: true })
    },
  }
}

async function runLocalScript(scriptName: string, args: string[] = [], options: RunLocalScriptOptions = {}): Promise<LocalScriptResult> {
  const scriptPath = path.join(SCRAPER_SCRIPTS_ROOT, scriptName)
  const command = [scriptPath, ...args].join(' ')
  const timeoutMs = options.timeoutMs ?? 30000
  let askpass: AskpassSession | null = null
  if (options.interactiveSshPrompt) {
    askpass = await createAskpassSession()
  }
  return await new Promise((resolve) => {
    execFile(
      scriptPath,
      args,
      {
        cwd: REPO_ROOT,
        timeout: timeoutMs,
        env: {
          ...process.env,
          ...(askpass ? askpass.env : { SSH_ASKPASS_REQUIRE: 'never' }),
        },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const errorText = error ? String(error.message || error) : ''
        const combined = `${stdout}\n${stderr}\n${errorText}`.toLowerCase()
        const exitCode = typeof (error as any)?.code === 'number' ? (error as any).code : (error ? -1 : 0)
        let hint: string | undefined
        if (combined.includes('permission denied') || combined.includes('ssh_askpass')) {
          hint = 'SSH authentication was required. Complete the OTP prompt or establish SSH auth first.'
        } else if (combined.includes('ssh_verification_cancelled')) {
          hint = 'SSH verification was cancelled.'
        } else if (combined.includes('could not resolve a running scraper-orch node')) {
          hint = 'No running scraper orchestrator was found. Start or verify the Slurm job first.'
        } else if (combined.includes('still not answering')) {
          hint = 'The tunnel was reopened, but the remote orchestrator did not answer on /health.'
        } else if ((error as any)?.killed && (error as any)?.signal === 'SIGTERM') {
          hint = 'The SSH verification flow timed out before completion.'
        }
        const result = {
          ok: !error,
          code: exitCode,
          command,
          stdout,
          stderr,
          error: error ? errorText : undefined,
          hint,
          signal: typeof (error as any)?.signal === 'string' ? (error as any).signal : null,
          killed: Boolean((error as any)?.killed),
        }
        if (!askpass) {
          resolve(result)
          return
        }
        void askpass.cleanup().finally(() => resolve(result))
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
        local_source_rev: LOCAL_SOURCE_REV,
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
      local_source_rev: LOCAL_SOURCE_REV,
    },
  }
})

ipcMain.handle('scraper:diagnose-bridge', async () => {
  return await runLocalScript('check_bridge.sh', [], { timeoutMs: 120000, interactiveSshPrompt: true })
})

ipcMain.handle('scraper:repair-bridge', async () => {
  const repair = await runLocalScript('attach_tunnel.sh', [], { timeoutMs: 120000, interactiveSshPrompt: true })
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
