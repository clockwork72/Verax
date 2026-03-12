import { useEffect, useMemo, useRef, useState } from 'react'
import { parseAnnotationUsage, pricingForModel } from '../../utils/annotationCost'
import { LiveAnnotatorPanel } from './LiveAnnotatorPanel'
import type { AnnotatorStreamEvent } from '../../vite-env'

type AnnotateSiteStatus = 'active' | 'done' | 'skip' | 'error'
type AnnotateSiteEntry = { site: string; status: AnnotateSiteStatus; statements?: number }

function parseAnnotateLogs(logs: string[]): {
  activeSites: string[]
  completed: AnnotateSiteEntry[]
  totalSites: number
  tokensIn: number
  tokensOut: number
} {
  const active = new Map<string, true>()
  const completed: AnnotateSiteEntry[] = []
  let totalSites = 0
  let tokensIn = 0
  let tokensOut = 0

  for (const line of logs) {
    // "Found N site(s) ready for annotation in ..."
    const totalM = line.match(/Found (\d+) site/)
    if (totalM) totalSites = Number(totalM[1])

    // "[start] site.com"
    const startM = line.match(/\[start\]\s+(.+)$/)
    if (startM) { active.set(startM[1].trim(), true); continue }

    // "[done]  site.com — N statements from M chunks (P blocks) | X↑/Y↓ tokens"
    const doneM = line.match(/\[done\]\s+(.+?) — (\d+) statements.*\|\s*([\d,]+)↑\/([\d,]+)↓/)
    if (doneM) {
      const site = doneM[1].trim()
      active.delete(site)
      completed.push({ site, status: 'done', statements: Number(doneM[2]) })
      tokensIn += Number(doneM[3].replace(/,/g, ''))
      tokensOut += Number(doneM[4].replace(/,/g, ''))
      continue
    }

    // "[skip] site.com — ..."
    const skipM = line.match(/\[skip\]\s+([^\s]+)/)
    if (skipM) { active.delete(skipM[1]); completed.push({ site: skipM[1], status: 'skip' }); continue }

    // "[error] site.com: ..."
    const errM = line.match(/\[error\]\s+([^\s:]+)/)
    if (errM) { active.delete(errM[1]); completed.push({ site: errM[1], status: 'error' }); continue }
  }

  return { activeSites: [...active.keys()], completed, totalSites, tokensIn, tokensOut }
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

// DeepSeek-R1-Distill-Llama-70B served locally via HPC SSH tunnel
const DEEPSEEK_MODEL = { value: 'openai/local', label: 'DeepSeek-R1-70B (HPC)', price: 'local — no cost' }
import { FlowChartModal } from './FlowChartModal'

const logLines = [
 ''
]

type ActiveSiteInfo = { label: string; stepIndex: number; rank: number }
type CompletedSiteInfo = { site: string; status: string; cached: boolean; annotated?: boolean }

const STAGE_STEPS = ['Home fetch', 'Policy discovery', '3P extraction', '3P policies']

type LauncherViewProps = {
  topN: string
  onTopNChange: (value: string) => void
  onStart: () => void
  primaryActionLabel?: string
  primaryActionHint?: string
  primaryActionDisabled?: boolean
  onStop?: () => void
  stopRunPending?: boolean
  hasRun: boolean
  running: boolean
  scraperActive?: boolean
  progress: number
  resultsReady: boolean
  onViewResults: () => void
  logs?: string[]
  errorMessage?: string
  etaText?: string
  useCrux?: boolean
  onToggleCrux?: (next: boolean) => void
  cruxApiKey?: string
  onCruxKeyChange?: (value: string) => void
  excludeSameEntity?: boolean
  onToggleExcludeSameEntity?: (next: boolean) => void
  mappingMode?: 'radar' | 'trackerdb' | 'mixed'
  onMappingModeChange?: (mode: 'radar' | 'trackerdb' | 'mixed') => void
  onOpenLogWindow?: () => void
  activeSites?: Record<string, ActiveSiteInfo>
  recentCompleted?: CompletedSiteInfo[]
  // Stage 2 — Annotation
  tunnelStatus?: 'checking' | 'online' | 'degraded' | 'offline'
  bridgeReady?: boolean
  bridgeHeadline?: string
  bridgeDetail?: string
  bridgeNode?: string
  bridgeCurrentOutDir?: string
  bridgeCheckedAt?: string
  bridgeHealthyAt?: string
  bridgeFailures?: number
  bridgeActionBusy?: 'diagnose' | 'repair' | 'refresh' | null
  bridgeActionMessage?: string
  onDiagnoseBridge?: () => void
  onRepairBridge?: () => void
  onRefreshRemote?: () => void
  remoteCodeOutdated?: boolean
  workspaceReady?: boolean
  llmModel?: string
  latestStreamEvent?: AnnotatorStreamEvent | null
  annotateRunning?: boolean
  annotateLogs?: string[]
  annotationStats?: any
  onStartAnnotate?: (opts: { llmModel?: string; concurrency?: number; force?: boolean }) => void
  onStopAnnotate?: () => void
  // Resume mode — use unified output dir to skip already-scraped sites
  resumeMode?: boolean
  onToggleResumeMode?: (next: boolean) => void
  topNLocked?: boolean
}

export function LauncherView({
  topN,
  onTopNChange,
  onStart,
  primaryActionLabel = 'Start run',
  primaryActionHint = 'Choose how many sites to crawl. Press Enter to start.',
  primaryActionDisabled = false,
  onStop,
  stopRunPending = false,
  hasRun,
  running,
  scraperActive = running,
  progress,
  resultsReady,
  onViewResults,
  logs,
  errorMessage,
  etaText,
  useCrux,
  onToggleCrux,
  cruxApiKey,
  onCruxKeyChange,
  excludeSameEntity,
  onToggleExcludeSameEntity,
  mappingMode = 'radar',
  onMappingModeChange,
  onOpenLogWindow,
  activeSites = {},
  recentCompleted = [],
  tunnelStatus = 'checking',
  bridgeReady = false,
  bridgeHeadline = 'Probing local tunnel',
  bridgeDetail = 'Waiting for the workstation to connect to the cluster bridge.',
  bridgeNode,
  bridgeCurrentOutDir,
  bridgeCheckedAt = 'never',
  bridgeHealthyAt = 'never',
  bridgeFailures = 0,
  bridgeActionBusy = null,
  bridgeActionMessage,
  onDiagnoseBridge,
  onRepairBridge,
  onRefreshRemote,
  remoteCodeOutdated = false,
  workspaceReady = false,
  llmModel = 'openai/local',
  latestStreamEvent = null,
  annotateRunning = false,
  annotateLogs = [],
  annotationStats,
  onStartAnnotate,
  onStopAnnotate,
  resumeMode = false,
  onToggleResumeMode,
  topNLocked = false,
}: LauncherViewProps) {
  const logRef = useRef<HTMLDivElement | null>(null)
  const annotateLogRef = useRef<HTMLDivElement | null>(null)
  const [showFlow, setShowFlow] = useState(false)
  const [annotateConcurrency, setAnnotateConcurrency] = useState('1')
  const visibleLogs = useMemo(() => {
    if (logs && logs.length > 0) return logs.slice(-120)
    if (!hasRun) return []
    return logLines
  }, [hasRun, progress, logs])

  useEffect(() => {
    if (!logRef.current) return
    logRef.current.scrollTop = logRef.current.scrollHeight
  }, [visibleLogs])

  useEffect(() => {
    if (!annotateLogRef.current) return
    annotateLogRef.current.scrollTop = annotateLogRef.current.scrollHeight
  }, [annotateLogs])

  const bridgeBadgeClass = tunnelStatus === 'online'
    ? 'border-[var(--color-success)] text-[var(--color-success)]'
    : tunnelStatus === 'degraded'
      ? 'border-[var(--color-warn)] text-[var(--color-warn)]'
      : tunnelStatus === 'offline'
        ? 'border-[var(--color-danger)] text-[var(--color-danger)]'
        : 'border-[var(--border-soft)] text-[var(--muted-text)]'
  const bridgeBadgeLabel = tunnelStatus === 'online'
    ? '● Bridge live'
    : tunnelStatus === 'degraded'
      ? '◐ Bridge degraded'
      : tunnelStatus === 'offline'
        ? '○ Bridge offline'
        : '◌ Checking bridge…'
  const bridgeSteps = [
    {
      label: 'SSH tunnel',
      state: tunnelStatus === 'online' ? 'ready' : tunnelStatus === 'degraded' ? 'warn' : tunnelStatus === 'offline' ? 'blocked' : 'pending',
      detail: tunnelStatus === 'online' ? 'Port 8910 forwarding clean' : tunnelStatus === 'degraded' ? 'Local port still listens, but the target is unhealthy' : tunnelStatus === 'offline' ? 'No local bridge' : 'Handshake pending',
    },
    {
      label: 'Control API',
      state: bridgeReady || tunnelStatus === 'degraded' ? 'ready' : tunnelStatus === 'offline' ? 'blocked' : 'pending',
      detail: bridgeReady || tunnelStatus === 'degraded' ? 'Remote orchestrator reachable' : 'Waiting for health probe',
    },
    {
      label: 'PostgreSQL',
      state: bridgeReady || tunnelStatus === 'degraded' ? 'ready' : tunnelStatus === 'offline' ? 'blocked' : 'pending',
      detail: bridgeReady || tunnelStatus === 'degraded' ? 'Database session confirmed' : 'Service still warming up',
    },
    {
      label: 'Workspace',
      state: workspaceReady ? 'ready' : bridgeReady ? 'pending' : 'blocked',
      detail: workspaceReady ? 'Remote state synced locally' : bridgeReady ? 'Waiting for a remote run' : 'Locked behind bridge gate',
    },
  ] as const

  return (
    <>
      <section className="card rounded-2xl p-6">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Launch</p>
              <h2 className="text-lg font-semibold">Dataset launcher</h2>
              <p className="text-xs text-[var(--muted-text)]">
                {primaryActionHint}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="focusable rounded-full border border-[var(--border-soft)] px-4 py-2 text-xs"
                onClick={() => setShowFlow(true)}
              >
                Flow chart
              </button>
              <button
                className="focusable rounded-full bg-[var(--color-primary)] px-4 py-2 text-xs font-semibold text-white"
                onClick={onStart}
                disabled={primaryActionDisabled || scraperActive || !bridgeReady}
              >
                {primaryActionLabel}
              </button>
              <button
                className={`focusable rounded-full border px-4 py-2 text-xs font-semibold ${
                  scraperActive || stopRunPending
                    ? 'border-[var(--color-danger)] text-white'
                    : 'border-[var(--border-soft)] text-[var(--muted-text)]'
                }`}
                onClick={onStop}
                disabled={!scraperActive && !stopRunPending}
              >
                {stopRunPending ? 'Stopping...' : 'Stop run'}
              </button>
            </div>
          </div>
          <div className="rounded-2xl border border-[var(--border-soft)] bg-black/15 p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-2xl">
                <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--muted-text)]">Cluster bridge</p>
                <h3 className="text-sm font-semibold">{bridgeHeadline}</h3>
                <p className="mt-1 text-xs text-[var(--muted-text)]">{bridgeDetail}</p>
              </div>
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${bridgeBadgeClass}`}>
                {bridgeBadgeLabel}
              </span>
            </div>
            <div className="mt-4 grid gap-2 md:grid-cols-4">
              {bridgeSteps.map((step) => (
                <div
                  key={step.label}
                  className={`rounded-xl border px-3 py-3 ${
                    step.state === 'ready'
                      ? 'border-[var(--color-success)] bg-emerald-950/20'
                      : step.state === 'warn'
                        ? 'border-[var(--color-warn)] bg-amber-950/20'
                        : step.state === 'blocked'
                          ? 'border-[var(--color-danger)] bg-rose-950/20'
                          : 'border-[var(--border-soft)] bg-black/20'
                  }`}
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span className={`inline-block h-2 w-2 rounded-full ${
                      step.state === 'ready'
                        ? 'bg-[var(--color-success)]'
                        : step.state === 'warn'
                          ? 'bg-[var(--color-warn)]'
                          : step.state === 'blocked'
                            ? 'bg-[var(--color-danger)]'
                            : 'bg-[var(--muted-text)]'
                    }`} />
                    <span className="font-semibold text-[var(--color-text)]">{step.label}</span>
                  </div>
                  <p className="mt-2 text-[11px] text-[var(--muted-text)]">{step.detail}</p>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted-text)]">
              <code className="rounded-lg border border-[var(--border-soft)] bg-black/30 px-2.5 py-1 font-mono">
                hpc/scraper/launch_remote.sh
              </code>
              <button
                className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1 text-[11px]"
                onClick={onDiagnoseBridge}
                disabled={bridgeActionBusy !== null}
              >
                {bridgeActionBusy === 'diagnose' ? 'Diagnosing...' : 'Diagnose'}
              </button>
              <button
                className={`focusable rounded-full px-3 py-1 text-[11px] ${
                  tunnelStatus === 'online'
                    ? 'border border-[var(--border-soft)] text-[var(--muted-text)]'
                    : 'border border-amber-500/50 text-amber-300'
                }`}
                onClick={onRepairBridge}
                disabled={bridgeActionBusy !== null || tunnelStatus === 'checking' || tunnelStatus === 'online'}
              >
                {bridgeActionBusy === 'repair' ? 'Repairing...' : 'Repair bridge'}
              </button>
              <button
                className={`focusable rounded-full px-3 py-1 text-[11px] ${
                  remoteCodeOutdated
                    ? 'border border-amber-500/50 text-amber-300'
                    : 'border border-[var(--border-soft)] text-[var(--muted-text)]'
                }`}
                onClick={onRefreshRemote}
                disabled={bridgeActionBusy !== null}
              >
                {bridgeActionBusy === 'refresh' ? 'Refreshing...' : 'Refresh remote'}
              </button>
              {bridgeNode && <span>Node {bridgeNode}</span>}
              {bridgeCurrentOutDir && <span>Remote out {bridgeCurrentOutDir}</span>}
              <span>Checked {bridgeCheckedAt}</span>
              <span>Last healthy {bridgeHealthyAt}</span>
              {bridgeFailures > 0 && tunnelStatus !== 'online' && <span>{bridgeFailures} missed heartbeat{bridgeFailures > 1 ? 's' : ''}</span>}
            </div>
            {bridgeActionMessage && (
              <p className="mt-3 text-[11px] text-[var(--muted-text)]">{bridgeActionMessage}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted-text)]">
            <button
              className={`focusable rounded-full border px-4 py-2 text-xs ${
                scraperActive || stopRunPending ? 'border-[var(--color-danger)] text-white' : 'border-[var(--border-soft)] text-[var(--muted-text)]'
              }`}
              onClick={onStop}
              disabled={!scraperActive && !stopRunPending}
            >
              {stopRunPending ? 'Stopping...' : 'Stop run'}
            </button>
            {(scraperActive || stopRunPending) && <span>Stopping will keep partial results.</span>}
            {!bridgeReady && <span>Launcher stays locked until the SSH tunnel, orchestrator API, and database are all healthy.</span>}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <input
              type="number"
              min={1}
              value={topN}
              onChange={(event) => onTopNChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onStart()
              }}
              className="focusable w-40 rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-2 text-sm text-white"
              placeholder="1000"
              disabled={topNLocked || !bridgeReady}
            />
            <span className="text-xs text-[var(--muted-text)]">
              {topNLocked ? 'Target locked to loaded dataset' : resumeMode ? 'target total sites' : 'sites from Tranco list'}
            </span>

            {/* Read-only pipeline settings chips — configure in Settings */}
            <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs ${
              useCrux ? 'border-[var(--color-primary)] text-[var(--color-primary)]' : 'border-[var(--border-soft)] text-[var(--muted-text)]'
            }`} title="Configure in Settings">
              CrUX {useCrux ? 'on' : 'off'}
            </span>
            {useCrux && !cruxApiKey?.trim() && (
              <span className="inline-flex items-center rounded-full border border-amber-500/50 px-3 py-1 text-xs text-amber-300">
                CrUX key required
              </span>
            )}
            <span className="inline-flex items-center rounded-full border border-[var(--border-soft)] px-3 py-1 text-xs text-[var(--muted-text)]" title="Configure in Settings">
              {mappingMode === 'mixed' ? 'Mixed mapping' : mappingMode === 'trackerdb' ? 'TrackerDB' : 'Tracker Radar'}
            </span>
            <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs ${
              excludeSameEntity ? 'border-[var(--color-primary)] text-[var(--color-primary)]' : 'border-[var(--border-soft)] text-[var(--muted-text)]'
            }`} title="Configure in Settings">
              {excludeSameEntity ? 'Excl. same entity' : 'All 3P'}
            </span>

            <button
              className={`focusable rounded-full border px-3 py-1 text-xs ${
                resumeMode
                  ? 'border-[var(--color-primary)] text-white'
                  : 'border-[var(--border-soft)] text-[var(--muted-text)]'
              }`}
              onClick={() => onToggleResumeMode?.(!resumeMode)}
              title="Uses a shared output dir so already-scraped AND already-annotated sites are both skipped automatically."
            >
              Resume mode {resumeMode ? 'on' : 'off'}
            </button>
          </div>
        </div>
      </section>

      <FlowChartModal
        open={showFlow}
        onClose={() => setShowFlow(false)}
        topN={topN}
        onTopNChange={onTopNChange}
        useCrux={useCrux}
        onToggleCrux={onToggleCrux}
        cruxApiKey={cruxApiKey}
        onCruxKeyChange={onCruxKeyChange}
        mappingMode={mappingMode}
        onMappingModeChange={onMappingModeChange}
        excludeSameEntity={excludeSameEntity}
        onToggleExcludeSameEntity={onToggleExcludeSameEntity}
        onStart={onStart}
        running={running}
      />

      <section
        className={`overflow-hidden transition-all duration-700 ${
          hasRun ? 'max-h-[1200px] opacity-100' : 'max-h-0 opacity-0'
        }`}
      >
        <div className="card rounded-2xl p-6">
          {/* Header row */}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Progress</p>
              <h3 className="text-lg font-semibold">Active crawl</h3>
            </div>
            <div className="flex items-center gap-3">
              {running && (
                <span className="flex items-center gap-1.5 text-xs text-[var(--color-primary)]">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--color-primary)]" />
                  Running · {Object.keys(activeSites).length} concurrent
                </span>
              )}
              {!running && progress >= 100 && (
                <span className="text-xs text-[var(--color-success)]">Completed</span>
              )}
              <button
                className={`focusable rounded-full border px-4 py-2 text-xs ${
                  resultsReady
                    ? 'border-[var(--color-primary)] text-white'
                    : 'border-[var(--border-soft)] text-[var(--muted-text)]'
                }`}
                onClick={onViewResults}
                disabled={!resultsReady}
              >
                View results
              </button>
            </div>
          </div>

          {/* Progress bar */}
          <div className="mt-4">
            <div className="h-2 w-full overflow-hidden rounded-full bg-black/30">
              <div
                className="h-full rounded-full bg-[var(--color-primary)] transition-all duration-700"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-[var(--muted-text)]">
              <span>{progress.toFixed(0)}% complete</span>
              <span>{etaText ? `ETA ${etaText}` : 'ETA --'}</span>
              <span>{topN} sites total</span>
              {resumeMode && annotationStats?.annotated_sites > 0 && (
                <span className="text-[var(--color-primary)]">
                  {annotationStats.annotated_sites} annotated — will skip
                </span>
              )}
            </div>
          </div>

          {/* Active sites table */}
          {Object.keys(activeSites).length > 0 && (
            <div className="mt-5">
              <p className="mb-2 text-[10px] uppercase tracking-[0.2em] text-[var(--muted-text)]">
                Actively processing
              </p>
              <div className="overflow-hidden rounded-xl border border-[var(--border-soft)]">
                {/* Column headers */}
                <div className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-x-4 bg-black/30 px-4 py-2 text-[10px] uppercase tracking-[0.2em] text-[var(--muted-text)]">
                  <span>Site</span>
                  <span>Rank</span>
                  <span>Current step</span>
                  <span>Pipeline</span>
                </div>
                {Object.entries(activeSites).map(([site, info]) => (
                  <div
                    key={site}
                    className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-x-4 border-t border-[var(--border-soft)] px-4 py-2.5"
                  >
                    {/* Site name */}
                    <span className="mono text-sm text-[var(--color-text)]">{site}</span>
                    {/* Rank */}
                    <span className="text-xs text-[var(--muted-text)]">#{info.rank}</span>
                    {/* Step label */}
                    <span className="text-xs text-[var(--color-primary)]">{info.label}</span>
                    {/* 4-dot pipeline indicator */}
                    <div className="flex items-center gap-1">
                      {STAGE_STEPS.map((s, i) => (
                        <span
                          key={s}
                          className={`inline-block h-2 w-2 rounded-full ${
                            i < info.stepIndex
                              ? 'bg-[var(--color-primary)]'
                              : i === info.stepIndex
                                ? 'animate-pulse bg-[var(--color-primary)]'
                                : 'bg-black/30'
                          }`}
                          title={s}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recently completed */}
          {recentCompleted.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-[10px] uppercase tracking-[0.2em] text-[var(--muted-text)]">
                Recently completed
              </p>
              <div className="flex flex-wrap gap-2">
                {recentCompleted.map((item, i) => (
                  <span
                    key={`${item.site}-${i}`}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                      item.status === 'ok'
                        ? 'border-[var(--color-success)] text-[var(--color-success)]'
                        : item.cached || item.annotated
                          ? 'border-[var(--border-soft)] text-[var(--muted-text)]'
                          : 'border-[var(--color-danger)] text-[var(--color-danger)]'
                    }`}
                  >
                    {item.status === 'ok' && !item.cached ? '✓' : item.annotated ? '★' : item.cached ? '↩' : '✕'}
                    {item.site}
                    {item.annotated && <span className="opacity-60">annotated</span>}
                    {item.cached && !item.annotated && <span className="opacity-60">cached</span>}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Idle state */}
          {scraperActive && Object.keys(activeSites).length === 0 && (
            <div className="mt-5 text-xs text-[var(--muted-text)]">Initializing — waiting for first site…</div>
          )}
        </div>
      </section>

      <section
        className={`overflow-hidden transition-all duration-700 ${
          hasRun ? 'max-h-[420px] opacity-100' : 'max-h-0 opacity-0'
        }`}
      >
        <div className="card rounded-2xl p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Logs</p>
              <h3 className="text-lg font-semibold">Run details</h3>
            </div>
            <div className="flex items-center gap-2 text-xs text-[var(--muted-text)]">
              <button
                className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1 text-xs"
                onClick={onOpenLogWindow}
              >
                Open full log
              </button>
              <span>tail -f</span>
            </div>
          </div>
          <div className="mt-4 space-y-2 text-xs">
            {errorMessage && (
              <div className="rounded-lg border border-[var(--color-danger)] bg-black/20 px-3 py-2 text-[var(--color-danger)]">
                {errorMessage}
              </div>
            )}
            <div
              ref={logRef}
              className="mono max-h-[420px] overflow-y-auto rounded-xl border border-[var(--border-soft)] bg-black/30 p-3 pb-6 text-[11px] leading-relaxed text-[var(--muted-text)]"
              style={{ scrollPaddingBottom: '1.5rem' }}
            >
              {visibleLogs.length === 0 && <div>Launch a run to see logs.</div>}
              {visibleLogs.map((line, index) => (
                <div key={`${line}-${index}`} className="flex gap-2">
                  <span className="text-[var(--muted-text)]">{String(index + 1).padStart(2, '0')}</span>
                  <span className="text-[var(--color-text)]">{line}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Stage 2 — Annotation */}
      <section className="card rounded-2xl p-6">
        {(() => {
          const { activeSites: annotateSites, completed: annotateCompleted, totalSites } =
            parseAnnotateLogs(annotateLogs)
          const parsedUsage = parseAnnotationUsage(annotateLogs)
          const tokensIn = parsedUsage.tokensIn
          const tokensOut = parsedUsage.tokensOut
          const knownTotal = totalSites || annotationStats?.total_sites || 0
          const doneCount = annotateCompleted.filter((s) => s.status !== 'skip' || annotateSites.length === 0).length
          const progressPct = knownTotal > 0 ? Math.round((annotateCompleted.length / knownTotal) * 100) : 0

          return (
            <>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Stage 2</p>
                  <h3 className="text-lg font-semibold">Policy annotation</h3>
                  <p className="text-xs text-[var(--muted-text)]">
                    LLM extraction of structured privacy statements. Only sites with a completed Stage 1 scrape are
                    eligible.
                    {annotationStats && (
                      <span className="ml-1 text-[var(--color-text)]">
                        {annotationStats.annotated_sites}/{annotationStats.total_sites} done ·{' '}
                        {(annotationStats.total_statements ?? 0).toLocaleString()} statements
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {remoteCodeOutdated && (
                    <button
                      className="focusable rounded-full border border-amber-500/50 px-4 py-2 text-xs font-semibold text-amber-300"
                      onClick={onRefreshRemote}
                      disabled={bridgeActionBusy !== null}
                    >
                      {bridgeActionBusy === 'refresh' ? 'Refreshing...' : 'Refresh remote'}
                    </button>
                  )}
                  <button
                    className={`focusable rounded-full border px-4 py-2 text-xs font-semibold ${
                      annotateRunning
                        ? 'border-[var(--color-danger)] text-white'
                        : 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white'
                    }`}
                    onClick={() => {
                      if (annotateRunning) {
                        onStopAnnotate?.()
                      } else {
                        onStartAnnotate?.({ llmModel, concurrency: Number(annotateConcurrency) || 1, force: false })
                      }
                    }}
                    disabled={!annotateRunning && !hasRun && !(annotationStats?.total_sites > 0)}
                  >
                    {annotateRunning ? 'Stop annotation' : 'Annotate policies'}
                  </button>
                  {!annotateRunning && (hasRun || annotationStats?.total_sites > 0) && (
                    <button
                      className="focusable rounded-full border border-[var(--border-soft)] px-4 py-2 text-xs text-[var(--muted-text)]"
                      onClick={() =>
                        onStartAnnotate?.({ llmModel, concurrency: Number(annotateConcurrency) || 1, force: true })
                      }
                    >
                      Re-annotate (force)
                    </button>
                  )}
                </div>
              </div>

              {/* Controls row */}
              <div className="mt-4 flex flex-wrap items-center gap-3">
                {/* Cluster bridge status */}
                <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
                  tunnelStatus === 'online'
                    ? 'border-[var(--color-success)] text-[var(--color-success)]'
                    : tunnelStatus === 'degraded'
                      ? 'border-[var(--color-warn)] text-[var(--color-warn)]'
                    : tunnelStatus === 'offline'
                      ? 'border-[var(--color-danger)] text-[var(--color-danger)]'
                      : 'border-[var(--border-soft)] text-[var(--muted-text)]'
                }`}>
                  {tunnelStatus === 'online' ? '● Cluster bridge active' : tunnelStatus === 'degraded' ? '◐ Cluster bridge degraded' : tunnelStatus === 'offline' ? '○ Cluster bridge offline' : '◌ Checking bridge…'}
                </span>
                {/* DeepSeek model — read-only chip */}
                <span
                  className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-soft)] px-3 py-1 text-xs text-[var(--muted-text)]"
                  title="Remote Slurm orchestrator via SSH tunnel on port 8910"
                >
                  {DEEPSEEK_MODEL.label} — {DEEPSEEK_MODEL.price}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--muted-text)]">Concurrency</span>
                  <input
                    type="number"
                    min={1}
                    max={16}
                    className="focusable w-20 rounded-xl border border-[var(--border-soft)] bg-black/20 px-3 py-2 text-sm text-white"
                    value={annotateConcurrency}
                    onChange={(e) => setAnnotateConcurrency(e.target.value)}
                  />
                </div>
              </div>

              {/* Progress bar + stats — shown when running or after a run */}
              {(annotateRunning || annotateCompleted.length > 0) && (
                <div className="mt-5">
                  <div className="flex items-center justify-between text-xs text-[var(--muted-text)]">
                    <span>
                      {annotateCompleted.length}
                      {knownTotal > 0 ? ` / ${knownTotal}` : ''} sites processed
                      {annotateSites.length > 0 && (
                        <span className="ml-2 text-[var(--color-primary)]">· {annotateSites.length} active</span>
                      )}
                    </span>
                    {(tokensIn > 0 || tokensOut > 0) && (
                      <span className="font-mono text-[10px]">
                        {fmtK(tokensIn)}↑&nbsp;{fmtK(tokensOut)}↓&nbsp;tokens
                        <span className="ml-1 text-[var(--muted-text)] opacity-60">
                          {(() => {
                            const rates = pricingForModel(llmModel)
                            const cost = (tokensIn / 1e6) * rates.input + (tokensOut / 1e6) * rates.output
                            return `(≈$${cost.toFixed(3)})`
                          })()}
                        </span>
                      </span>
                    )}
                  </div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-black/30">
                    {knownTotal > 0 ? (
                      <div
                        className="h-full rounded-full bg-[var(--color-primary)] transition-all duration-700"
                        style={{ width: `${progressPct}%` }}
                      />
                    ) : (
                      <div className="h-full animate-pulse rounded-full bg-[var(--color-primary)]" style={{ width: '40%' }} />
                    )}
                  </div>
                  {doneCount > 0 && knownTotal > 0 && (
                    <p className="mt-1 text-[10px] text-[var(--muted-text)]">{progressPct}% complete</p>
                  )}
                </div>
              )}

              {/* Active sites */}
              {annotateSites.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-[10px] uppercase tracking-[0.2em] text-[var(--muted-text)]">
                    Actively annotating
                  </p>
                  <div className="overflow-hidden rounded-xl border border-[var(--border-soft)]">
                    {annotateSites.map((site) => (
                      <div
                        key={site}
                        className="flex items-center gap-3 border-t border-[var(--border-soft)] px-4 py-2.5 first:border-t-0"
                      >
                        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--color-primary)]" />
                        <span className="mono text-sm text-[var(--color-text)]">{site}</span>
                        <span className="text-xs text-[var(--muted-text)]">annotating…</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Completed sites chips */}
              {annotateCompleted.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-[10px] uppercase tracking-[0.2em] text-[var(--muted-text)]">
                    Completed
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {annotateCompleted.map((item, i) => (
                      <span
                        key={`${item.site}-${i}`}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                          item.status === 'done'
                            ? 'border-[var(--color-success)] text-[var(--color-success)]'
                            : item.status === 'skip'
                              ? 'border-[var(--border-soft)] text-[var(--muted-text)]'
                              : 'border-[var(--color-danger)] text-[var(--color-danger)]'
                        }`}
                      >
                        {item.status === 'done' ? '✓' : item.status === 'skip' ? '↩' : '✕'}
                        {item.site}
                        {item.statements !== undefined && (
                          <span className="opacity-60">{item.statements} stmts</span>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Live streaming panel */}
              <LiveAnnotatorPanel
                streamEvent={latestStreamEvent}
                annotateRunning={annotateRunning}
              />

              {/* Annotator logs */}
              {annotateLogs.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Annotator logs</p>
                  <div
                    ref={annotateLogRef}
                    className="mono mt-2 max-h-[200px] overflow-y-auto rounded-xl border border-[var(--border-soft)] bg-black/30 p-3 text-[11px] leading-relaxed text-[var(--muted-text)]"
                  >
                    {annotateLogs.map((line, i) => (
                      <div key={i} className="flex gap-2">
                        <span className="shrink-0 text-[var(--muted-text)]">{String(i + 1).padStart(2, '0')}</span>
                        <span
                          className={
                            line.includes('[done]')
                              ? 'text-[var(--color-success)]'
                              : line.includes('[error]') || line.includes('[ERROR]')
                                ? 'text-[var(--color-danger)]'
                                : line.includes('[WARNING]')
                                  ? 'text-[var(--color-warn)]'
                                  : line.includes('[start]')
                                    ? 'text-[var(--color-primary)]'
                                    : 'text-[var(--color-text)]'
                          }
                        >
                          {line}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )
        })()}
      </section>
    </>
  )
}
