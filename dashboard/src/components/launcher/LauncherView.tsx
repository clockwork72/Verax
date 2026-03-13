import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ActiveSiteInfo,
  AnnotationRunState,
  AnnotationStats,
  CompletedSiteInfo,
  HpcBridgeStatus,
} from '../../contracts/api'
import { pricingForModel } from '../../utils/annotationCost'
import { BentoCard, BentoGrid } from '../ui/BentoCard'
import { PulseRing } from '../ui/PulseRing'
import { StatusPill } from '../ui/StatusPill'
import { AnimatedCounter } from '../ui/AnimatedCounter'
import { LiveAnnotatorPanel } from './LiveAnnotatorPanel'
import { FlowChartModal } from './FlowChartModal'
import type { AnnotatorStreamEvent } from '../../vite-env'

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

const DEEPSEEK_MODEL = { value: 'openai/local', label: 'DeepSeek-R1-70B (HPC)', price: 'local — no cost' }

const logLines = ['']

const STAGE_STEPS = ['Home fetch', 'Policy discovery', '3P extraction', '3P policies']

// Arc progress circle
function ArcProgress({ pct, size = 80 }: { pct: number; size?: number }) {
  const r = (size - 10) / 2
  const circ = 2 * Math.PI * r
  const dash = circ * (pct / 100)
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={5} />
      <circle
        cx={size / 2} cy={size / 2} r={r}
        fill="none"
        stroke="var(--color-primary)"
        strokeWidth={5}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${circ}`}
        style={{ transition: 'stroke-dasharray 0.7s cubic-bezier(0.22,1,0.36,1)', filter: 'drop-shadow(0 0 4px rgba(0,230,255,0.5))' }}
      />
    </svg>
  )
}

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
  excludeSameEntity?: boolean
  onToggleExcludeSameEntity?: (next: boolean) => void
  mappingMode?: 'radar' | 'trackerdb' | 'mixed'
  onMappingModeChange?: (mode: 'radar' | 'trackerdb' | 'mixed') => void
  onOpenLogWindow?: () => void
  activeSites?: Record<string, ActiveSiteInfo>
  recentCompleted?: CompletedSiteInfo[]
  tunnelStatus?: 'checking' | 'online' | 'degraded' | 'offline'
  bridgeReady?: boolean
  bridgeHeadline?: string
  bridgeDetail?: string
  bridgeNode?: HpcBridgeStatus['node']
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
  annotationStats?: AnnotationStats | null
  annotationRunState?: AnnotationRunState
  onStartAnnotate?: (opts: { llmModel?: string; concurrency?: number; force?: boolean }) => void
  onStopAnnotate?: () => void
  resumeMode?: boolean
  onToggleResumeMode?: (next: boolean) => void
  topNLocked?: boolean
  lastDatasetRank?: number | null
}

export function LauncherView({
  topN,
  onTopNChange,
  onStart,
  primaryActionLabel = 'Start run',
  primaryActionHint = 'Choose how many sites to crawl.',
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
  annotationRunState,
  onStartAnnotate,
  onStopAnnotate,
  resumeMode = false,
  onToggleResumeMode,
  topNLocked = false,
  lastDatasetRank = null,
}: LauncherViewProps) {
  const logRef = useRef<HTMLDivElement | null>(null)
  const annotateLogRef = useRef<HTMLDivElement | null>(null)
  const [showFlow, setShowFlow] = useState(false)
  const [annotateConcurrency, setAnnotateConcurrency] = useState('1')
  const reduce = useReducedMotion()

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

  const bridgeSteps = [
    {
      label: 'SSH tunnel',
      state: tunnelStatus === 'online' ? 'ok' : tunnelStatus === 'degraded' ? 'warn' : tunnelStatus === 'offline' ? 'error' : 'pending',
      detail: tunnelStatus === 'online' ? 'Port 8910 forwarding' : tunnelStatus === 'degraded' ? 'Tunnel degraded' : tunnelStatus === 'offline' ? 'No local bridge' : 'Pending',
    },
    {
      label: 'Control API',
      state: bridgeReady || tunnelStatus === 'degraded' ? 'ok' : tunnelStatus === 'offline' ? 'error' : 'pending',
      detail: bridgeReady ? 'Orchestrator reachable' : 'Waiting for health probe',
    },
    {
      label: 'PostgreSQL',
      state: bridgeReady || tunnelStatus === 'degraded' ? 'ok' : tunnelStatus === 'offline' ? 'error' : 'pending',
      detail: bridgeReady ? 'DB session confirmed' : 'Service warming up',
    },
    {
      label: 'Workspace',
      state: workspaceReady ? 'ok' : bridgeReady ? 'pending' : 'error',
      detail: workspaceReady ? 'Remote state synced' : bridgeReady ? 'Awaiting remote run' : 'Locked',
    },
  ] as const

  // Annotation runtime state
  const runtimeState = annotationRunState ?? {
    totalSites: annotationStats?.total_sites ?? 0,
    sites: {},
    processedSites: 0,
    completedSites: annotationStats?.annotated_sites ?? 0,
    activeSites: [],
    tokensIn: 0,
    tokensOut: 0,
  }
  const knownTotal  = runtimeState.totalSites || annotationStats?.total_sites || 0
  const doneCount   = runtimeState.processedSites
  const progressPct = knownTotal > 0 ? Math.round((doneCount / knownTotal) * 100) : 0
  const annotateSites = runtimeState.activeSites
  const annotateCompleted = Object.values(runtimeState.sites)
    .filter((s) => !['pending', 'preprocessing', 'extracting', 'committing'].includes(s.status))
    .sort((a, b) => a.site.localeCompare(b.site))
  const tokensIn  = runtimeState.tokensIn
  const tokensOut = runtimeState.tokensOut

  return (
    <>
      <FlowChartModal
        open={showFlow}
        onClose={() => setShowFlow(false)}
        topN={topN}
        onTopNChange={onTopNChange}
        mappingMode={mappingMode}
        onMappingModeChange={onMappingModeChange}
        excludeSameEntity={excludeSameEntity}
        onToggleExcludeSameEntity={onToggleExcludeSameEntity}
        onStart={onStart}
        running={scraperActive}
      />

      {/* ── Bridge Status Card ─────────────────────────────────────── */}
      <BentoCard className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          {/* Status indicator + headline */}
          <div className="flex items-center gap-3">
            <PulseRing status={tunnelStatus} size={12} />
            <div>
              <p className="text-[11px] uppercase tracking-[0.15em] text-[var(--muted-text)]">Cluster bridge</p>
              <h3 className="text-sm font-semibold">{bridgeHeadline}</h3>
              <p className="text-[12px] text-[var(--muted-text)]">{bridgeDetail}</p>
            </div>
          </div>

          {/* Step pills */}
          <div className="flex flex-wrap items-center gap-2">
            {bridgeSteps.map((step) => (
              <StatusPill
                key={step.label}
                variant={step.state as 'ok' | 'warn' | 'error' | 'pending'}
                label={step.label}
                pulse={step.state === 'pending'}
              />
            ))}
          </div>
        </div>

        {/* Actions row */}
        <div className="flex flex-wrap items-center gap-2">
          <code className="mono rounded-lg border border-[var(--border-soft)] bg-black/20 px-2.5 py-1 text-[10px] text-[var(--muted-text)]">
            hpc/scraper/launch_remote.sh
          </code>
          <button
            className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1 text-[11px] text-[var(--muted-text)] transition-colors hover:border-[var(--glass-border)] hover:text-[var(--color-text)]"
            onClick={onDiagnoseBridge}
            disabled={bridgeActionBusy !== null}
          >
            {bridgeActionBusy === 'diagnose' ? 'Diagnosing…' : 'Diagnose'}
          </button>
          <button
            className={`focusable rounded-full border px-3 py-1 text-[11px] transition-colors ${
              tunnelStatus === 'online'
                ? 'border-[var(--border-soft)] text-[var(--muted-text)]'
                : 'border-[rgba(255,184,77,0.35)] text-[var(--color-warn)] hover:border-[rgba(255,184,77,0.55)]'
            }`}
            onClick={onRepairBridge}
            disabled={bridgeActionBusy !== null || tunnelStatus === 'checking' || tunnelStatus === 'online'}
          >
            {bridgeActionBusy === 'repair' ? 'Repairing…' : 'Repair bridge'}
          </button>
          <button
            className={`focusable rounded-full border px-3 py-1 text-[11px] transition-colors ${
              remoteCodeOutdated
                ? 'border-[rgba(255,184,77,0.35)] text-[var(--color-warn)] hover:border-[rgba(255,184,77,0.55)]'
                : 'border-[var(--border-soft)] text-[var(--muted-text)]'
            }`}
            onClick={onRefreshRemote}
            disabled={bridgeActionBusy !== null}
          >
            {bridgeActionBusy === 'refresh' ? 'Refreshing…' : 'Refresh remote'}
          </button>
          <div className="ml-auto flex items-center gap-3 text-[11px] text-[var(--muted-text)]">
            {bridgeNode && <span>Node <span className="mono text-[var(--color-text)]">{bridgeNode}</span></span>}
            {bridgeCurrentOutDir && <span>Out <span className="mono text-[var(--color-text)]">{bridgeCurrentOutDir}</span></span>}
            <span>Checked {bridgeCheckedAt}</span>
            <span>Healthy {bridgeHealthyAt}</span>
            {bridgeFailures > 0 && tunnelStatus !== 'online' && (
              <span className="text-[var(--color-warn)]">{bridgeFailures} missed heartbeat{bridgeFailures > 1 ? 's' : ''}</span>
            )}
          </div>
        </div>

        {bridgeActionMessage && (
          <p className="rounded-lg border border-[var(--border-soft)] bg-black/20 px-3 py-2 text-[11px] text-[var(--muted-text)]">
            {bridgeActionMessage}
          </p>
        )}
      </BentoCard>

      {/* ── Run Config + Controls ─────────────────────────────────── */}
      <BentoGrid className="grid-cols-1 lg:grid-cols-[1fr_auto]">
        {/* Config card */}
        <BentoCard>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.15em] text-[var(--muted-text)]">Launch</p>
                <h3 className="text-sm font-semibold">Dataset crawler</h3>
                <p className="text-[12px] text-[var(--muted-text)]">{primaryActionHint}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="focusable rounded-full border border-[var(--border-soft)] px-4 py-2 text-xs text-[var(--muted-text)] transition-colors hover:border-[var(--glass-border)] hover:text-[var(--color-text)]"
                  onClick={() => setShowFlow(true)}
                >
                  Flow chart
                </button>
                <motion.button
                  className="focusable rounded-full bg-[var(--color-primary)] px-5 py-2 text-xs font-semibold text-[#08090E] disabled:opacity-40"
                  onClick={onStart}
                  disabled={primaryActionDisabled || scraperActive || !bridgeReady}
                  whileTap={reduce ? undefined : { scale: 0.95 }}
                >
                  {primaryActionLabel}
                </motion.button>
                <motion.button
                  className={`focusable rounded-full border px-4 py-2 text-xs font-semibold transition-colors ${
                    scraperActive || stopRunPending
                      ? 'border-[var(--color-danger)] text-[var(--color-danger)]'
                      : 'border-[var(--border-soft)] text-[var(--muted-text)] opacity-50'
                  }`}
                  onClick={onStop}
                  disabled={!scraperActive && !stopRunPending}
                  whileTap={reduce ? undefined : { scale: 0.95 }}
                >
                  {stopRunPending ? 'Stopping…' : 'Stop run'}
                </motion.button>
              </div>
            </div>

            {/* Settings row */}
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="number"
                min={1}
                value={topN}
                onChange={(e) => onTopNChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') onStart() }}
                className="focusable w-32 rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-2 text-sm"
                placeholder="1000"
                disabled={topNLocked || !bridgeReady}
              />
              <span className="text-[12px] text-[var(--muted-text)]">
                {topNLocked ? 'locked to dataset' : resumeMode ? 'target total' : 'sites to scrape'}
              </span>

              <div className="ml-2 flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center rounded-full border border-[var(--color-primary)] px-2.5 py-0.5 text-[11px] text-[var(--color-primary)]">
                  Categorized CSV
                </span>
                <span className="inline-flex items-center rounded-full border border-[var(--border-soft)] px-2.5 py-0.5 text-[11px] text-[var(--muted-text)]" title="Configure in Settings">
                  {mappingMode === 'mixed' ? 'Mixed mapping' : mappingMode === 'trackerdb' ? 'TrackerDB' : 'Tracker Radar'}
                </span>
                <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] ${excludeSameEntity ? 'border-[var(--color-primary)] text-[var(--color-primary)]' : 'border-[var(--border-soft)] text-[var(--muted-text)]'}`} title="Configure in Settings">
                  {excludeSameEntity ? 'Excl. same entity' : 'All 3P'}
                </span>
                <button
                  className={`focusable rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${resumeMode ? 'border-[var(--color-primary)] text-[var(--color-primary)]' : 'border-[var(--border-soft)] text-[var(--muted-text)]'}`}
                  onClick={() => onToggleResumeMode?.(!resumeMode)}
                  title="Uses a shared output dir — already-scraped and annotated sites are skipped."
                >
                  Resume {resumeMode ? 'on' : 'off'}
                </button>
              </div>
            </div>
          </div>
        </BentoCard>

        {/* Status summary — shows active info or a quick counter */}
        {(scraperActive || hasRun) && (
          <BentoCard className="flex flex-col items-center justify-center gap-2 min-w-[140px]">
            <div className="relative flex items-center justify-center">
              <ArcProgress pct={progress} size={72} />
              <div className="absolute flex flex-col items-center">
                <span className="text-lg font-bold leading-none text-[var(--color-text)]">
                  <AnimatedCounter value={Math.round(progress)} suffix="%" />
                </span>
              </div>
            </div>
            {scraperActive && (
              <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-primary)]">
                <PulseRing status="online" size={7} />
                {Object.keys(activeSites).length} concurrent
              </div>
            )}
            {!scraperActive && progress >= 100 && (
              <span className="text-[11px] text-[var(--color-success)]">Completed</span>
            )}
            {etaText && scraperActive && (
              <span className="text-[11px] text-[var(--muted-text)]">ETA {etaText}</span>
            )}
          </BentoCard>
        )}
      </BentoGrid>

      {/* ── Active Crawl Card (slides in when hasRun) ────────────── */}
      <AnimatePresence>
        {hasRun && (
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reduce   ? { opacity: 0 } : { opacity: 0, y: 8 }}
            transition={{ type: 'spring', stiffness: 280, damping: 24 }}
          >
            <div className="glass-card p-5 flex flex-col gap-5">
              {/* Header + controls */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.15em] text-[var(--muted-text)]">Progress</p>
                  <h3 className="text-sm font-semibold">Active crawl</h3>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-[var(--muted-text)]">
                    {progress.toFixed(0)}% · {topN} sites{lastDatasetRank ? ` · Dataset rank #${lastDatasetRank}` : ''} · {etaText ? `ETA ${etaText}` : 'ETA --'}
                  </span>
                  {resumeMode && (annotationStats?.annotated_sites ?? 0) > 0 && (
                    <span className="text-[12px] text-[var(--color-primary)]">
                      {annotationStats?.annotated_sites ?? 0} annotated (will skip)
                    </span>
                  )}
                  <button
                    className={`focusable rounded-full border px-4 py-1.5 text-xs transition-colors ${resultsReady ? 'border-[var(--color-primary)] text-[var(--color-primary)]' : 'border-[var(--border-soft)] text-[var(--muted-text)] opacity-50'}`}
                    onClick={onViewResults}
                    disabled={!resultsReady}
                  >
                    View results
                  </button>
                </div>
              </div>

              {/* Flat progress bar */}
              <div className="h-1 w-full overflow-hidden rounded-full bg-black/30">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{ width: `${progress}%`, background: 'var(--color-primary)', boxShadow: '0 0 8px rgba(0,230,255,0.5)' }}
                />
              </div>

              {/* Active sites table */}
              {Object.keys(activeSites).length > 0 && (
                <div>
                  <p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-[var(--muted-text)]">Actively processing</p>
                  <div className="overflow-hidden rounded-xl border border-[var(--border-soft)]">
                    <div className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-x-4 bg-black/20 px-4 py-2 text-[10px] uppercase tracking-[0.18em] text-[var(--muted-text)]">
                      <span>Site</span><span>Rank</span><span>Step</span><span>Pipeline</span>
                    </div>
                    <motion.div
                      variants={{ show: { transition: { staggerChildren: reduce ? 0 : 0.04 } } }}
                      initial="hidden" animate="show"
                    >
                      {Object.entries(activeSites).map(([site, info]) => (
                        <motion.div
                          key={site}
                          variants={{
                            hidden: reduce ? { opacity: 0 } : { opacity: 0, y: 8 },
                            show:   reduce ? { opacity: 1 } : { opacity: 1, y: 0 },
                          }}
                          transition={{ type: 'spring', stiffness: 320, damping: 26 }}
                          className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-x-4 border-t border-[var(--border-soft)] px-4 py-2.5"
                          style={{ borderLeft: '2px solid rgba(0,230,255,0.5)' }}
                        >
                          <span className="mono text-sm text-[var(--color-text)]">{site}</span>
                          <span className="text-xs text-[var(--muted-text)]">#{info.rank}</span>
                          <span className="text-xs text-[var(--color-primary)]">{info.label}</span>
                          <div className="flex items-center gap-1">
                            {STAGE_STEPS.map((s, i) => (
                              <span
                                key={s}
                                className={`inline-block h-2 w-2 rounded-full ${
                                  i < info.stepIndex ? 'bg-[var(--color-primary)]' : i === info.stepIndex ? 'animate-pulse bg-[var(--color-primary)]' : 'bg-black/30'
                                }`}
                                title={s}
                              />
                            ))}
                          </div>
                        </motion.div>
                      ))}
                    </motion.div>
                  </div>
                </div>
              )}

              {/* Recently completed chips */}
              {recentCompleted.length > 0 && (
                <div>
                  <p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-[var(--muted-text)]">Recently completed</p>
                  <div className="flex flex-wrap gap-1.5">
                    {recentCompleted.map((item, i) => (
                      <span
                        key={`${item.site}-${i}`}
                        className={`stagger-item inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
                          item.status === 'ok'
                            ? 'border-[rgba(57,255,20,0.3)] text-[var(--color-success)]'
                            : item.cached || item.annotated
                              ? 'border-[var(--border-soft)] text-[var(--muted-text)]'
                              : 'border-[rgba(255,45,149,0.3)] text-[var(--color-danger)]'
                        }`}
                      >
                        {item.status === 'ok' && !item.cached ? '✓' : item.annotated ? '★' : item.cached ? '↩' : '✕'}
                        {item.site}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {scraperActive && Object.keys(activeSites).length === 0 && (
                <div className="flex items-center gap-2 text-[12px] text-[var(--muted-text)]">
                  <PulseRing status="online" size={8} />
                  Initializing — waiting for first site…
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Logs Card ────────────────────────────────────────────── */}
      <AnimatePresence>
        {hasRun && (
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reduce   ? { opacity: 0 } : { opacity: 0, y: 8 }}
            transition={{ type: 'spring', stiffness: 260, damping: 24, delay: 0.05 }}
          >
            <div className="glass-card p-5">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.15em] text-[var(--muted-text)]">Logs</p>
                  <h3 className="text-sm font-semibold">Run output</h3>
                </div>
                <button
                  className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1 text-[11px] text-[var(--muted-text)] transition-colors hover:text-[var(--color-text)]"
                  onClick={onOpenLogWindow}
                >
                  Open full log
                </button>
              </div>
              {errorMessage && (
                <div className="mb-3 rounded-lg border border-[rgba(255,45,149,0.4)] bg-[rgba(255,45,149,0.06)] px-3 py-2 text-[12px] text-[var(--color-danger)]">
                  {errorMessage}
                </div>
              )}
              <div
                ref={logRef}
                className="mono max-h-[260px] overflow-y-auto rounded-xl border border-[var(--border-soft)] bg-black/30 p-3 pb-6 text-[11px] leading-relaxed"
                style={{ scrollPaddingBottom: '1.5rem' }}
              >
                {visibleLogs.length === 0 && <div className="text-[var(--muted-text)]">Launch a run to see logs.</div>}
                {visibleLogs.map((line, i) => (
                  <div key={`${line}-${i}`} className="flex gap-2">
                    <span className="shrink-0 text-[var(--muted-text)]">{String(i + 1).padStart(2, '0')}</span>
                    <span className="text-[var(--color-text)]">{line}</span>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Stage 2 — Policy Annotation ──────────────────────────── */}
      <BentoCard>
        <div className="flex flex-col gap-4">
          {/* Header */}
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.15em] text-[var(--muted-text)]">Stage 2</p>
              <h3 className="text-sm font-semibold">Policy annotation</h3>
              <p className="text-[12px] text-[var(--muted-text)]">
                LLM extraction of structured privacy statements.
                {annotationStats && (
                  <span className="ml-1 text-[var(--color-text)]">
                    <AnimatedCounter value={annotationStats.annotated_sites ?? 0} />/<AnimatedCounter value={annotationStats.total_sites ?? 0} /> done ·{' '}
                    <AnimatedCounter value={annotationStats.total_statements ?? 0} /> statements
                  </span>
                )}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {remoteCodeOutdated && (
                <button
                  className="focusable rounded-full border border-[rgba(59,217,255,0.28)] bg-[rgba(59,217,255,0.08)] px-4 py-2 text-xs font-semibold text-[var(--color-primary)]"
                  onClick={onRefreshRemote}
                  disabled={bridgeActionBusy !== null}
                >
                  {bridgeActionBusy === 'refresh' ? 'Refreshing…' : 'Refresh remote'}
                </button>
              )}
              <motion.button
                className="focusable rounded-full border border-[var(--color-primary)] bg-[rgba(0,230,255,0.08)] px-5 py-2 text-xs font-semibold text-[var(--color-primary)] transition-colors"
                onClick={() => onStartAnnotate?.({ llmModel, concurrency: Number(annotateConcurrency) || 1, force: false })}
                disabled={annotateRunning || !bridgeReady || (!hasRun && !((annotationStats?.total_sites ?? 0) > 0))}
                whileTap={reduce ? undefined : { scale: 0.95 }}
              >
                Annotate policies
              </motion.button>
              {annotateRunning && (
                <motion.button
                  className="focusable rounded-full border border-[var(--color-danger)] px-4 py-2 text-xs font-semibold text-[var(--color-danger)] transition-colors"
                  onClick={onStopAnnotate}
                  whileTap={reduce ? undefined : { scale: 0.95 }}
                >
                  Stop annotation
                </motion.button>
              )}
              {!annotateRunning && (hasRun || (annotationStats?.total_sites ?? 0) > 0) && (
                <button
                  className="focusable rounded-full border border-[var(--border-soft)] px-4 py-2 text-xs text-[var(--muted-text)] transition-colors hover:text-[var(--color-text)] disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={() => onStartAnnotate?.({ llmModel, concurrency: Number(annotateConcurrency) || 1, force: true })}
                  disabled={!bridgeReady}
                >
                  Re-annotate (force)
                </button>
              )}
            </div>
          </div>

          {/* Controls row */}
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill
              variant={tunnelStatus === 'online' ? 'running' : tunnelStatus === 'degraded' ? 'warn' : tunnelStatus === 'offline' ? 'error' : 'pending'}
              label={tunnelStatus === 'online' ? 'Cluster bridge active' : tunnelStatus === 'degraded' ? 'Bridge degraded' : tunnelStatus === 'offline' ? 'Bridge offline' : 'Checking bridge…'}
              pulse={annotateRunning && tunnelStatus === 'online'}
            />
            <span className="inline-flex items-center rounded-full border border-[var(--border-soft)] px-2.5 py-0.5 text-[11px] text-[var(--muted-text)]" title="Remote Slurm orchestrator via SSH tunnel">
              {DEEPSEEK_MODEL.label}
            </span>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-[var(--muted-text)]">Concurrency</span>
              <input
                type="number" min={1} max={16}
                className="focusable w-16 rounded-xl border border-[var(--border-soft)] bg-black/20 px-3 py-1.5 text-sm"
                value={annotateConcurrency}
                onChange={(e) => setAnnotateConcurrency(e.target.value)}
              />
            </div>
          </div>

          {/* Annotation progress */}
          {(annotateRunning || doneCount > 0) && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-[var(--muted-text)]">
                <span>
                  <AnimatedCounter value={doneCount} />{knownTotal > 0 ? ` / ${knownTotal}` : ''} sites processed
                  {annotateSites.length > 0 && (
                    <span className="ml-2 text-[var(--color-primary)]">· {annotateSites.length} active</span>
                  )}
                </span>
                {(tokensIn > 0 || tokensOut > 0) && (
                  <span className="mono text-[10px]">
                    {fmtK(tokensIn)}↑ {fmtK(tokensOut)}↓ tokens
                    <span className="ml-1 opacity-50">
                      {(() => {
                        const rates = pricingForModel(llmModel)
                        const cost = (tokensIn / 1e6) * rates.input + (tokensOut / 1e6) * rates.output
                        return `(≈$${cost.toFixed(3)})`
                      })()}
                    </span>
                  </span>
                )}
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-black/30">
                {knownTotal > 0
                  ? <div className="h-full rounded-full transition-all duration-700" style={{ width: `${progressPct}%`, background: 'var(--color-primary)', boxShadow: '0 0 8px rgba(0,230,255,0.5)' }} />
                  : <div className="h-full animate-pulse rounded-full bg-[var(--color-primary)]" style={{ width: '35%' }} />
                }
              </div>
            </div>
          )}

          {/* Active annotation sites */}
          {annotateRunning && annotateSites.length > 0 && (
            <div>
              <p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-[var(--muted-text)]">Actively annotating</p>
              <div className="overflow-hidden rounded-xl border border-[var(--border-soft)]">
                {annotateSites.map((site) => (
                  <div
                    key={site}
                    className="flex items-center gap-3 border-t border-[var(--border-soft)] px-4 py-2.5 first:border-t-0"
                    style={{ borderLeft: '2px solid rgba(0,230,255,0.4)' }}
                  >
                    <PulseRing status="online" size={7} />
                    <span className="mono text-sm text-[var(--color-text)]">{site}</span>
                    <span className="text-[11px] text-[var(--muted-text)]">
                      {runtimeState.sites[site]?.phase || runtimeState.sites[site]?.status || 'annotating'}
                      {typeof runtimeState.sites[site]?.statements === 'number' && runtimeState.sites[site].statements > 0
                        ? ` · ${runtimeState.sites[site].statements} stmts` : '…'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Completed annotation chips */}
          {annotateCompleted.length > 0 && (
            <div>
              <p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-[var(--muted-text)]">Completed</p>
              <div className="flex flex-wrap gap-1.5">
                {annotateCompleted.map((item, i) => (
                  <span
                    key={`${item.site}-${i}`}
                    className={`stagger-item inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
                      item.status === 'completed' || item.status === 'reused'
                        ? 'border-[rgba(57,255,20,0.3)] text-[var(--color-success)]'
                        : item.status === 'stopped'
                          ? 'border-[var(--border-soft)] text-[var(--muted-text)]'
                          : 'border-[rgba(255,45,149,0.3)] text-[var(--color-danger)]'
                    }`}
                  >
                    {item.status === 'completed' || item.status === 'reused' ? '✓' : item.status === 'stopped' ? '↩' : '✕'}
                    {item.site}
                    {item.statements > 0 && <span className="opacity-50">{item.statements}</span>}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Live streaming panel */}
          <LiveAnnotatorPanel streamEvent={latestStreamEvent} annotateRunning={annotateRunning} />

          {/* Annotator logs */}
          {annotateLogs.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] uppercase tracking-[0.18em] text-[var(--muted-text)]">Annotator logs</p>
              <div
                ref={annotateLogRef}
                className="mono max-h-[180px] overflow-y-auto rounded-xl border border-[var(--border-soft)] bg-black/30 p-3 text-[11px] leading-relaxed"
              >
                {annotateLogs.map((line, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="shrink-0 text-[var(--muted-text)]">{String(i + 1).padStart(2, '0')}</span>
                    <span className={
                      line.includes('[done]') ? 'text-[var(--color-success)]'
                      : line.includes('[error]') || line.includes('[ERROR]') ? 'text-[var(--color-danger)]'
                      : line.includes('[WARNING]') ? 'text-[var(--color-warn)]'
                      : line.includes('[start]') ? 'text-[var(--color-primary)]'
                      : 'text-[var(--color-text)]'
                    }>{line}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </BentoCard>
    </>
  )
}
