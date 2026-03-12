import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Sidebar } from './components/layout/Sidebar'
import { PageShell } from './components/layout/PageShell'
import { LauncherView } from './components/launcher/LauncherView'
import { ResultsView } from './components/results/ResultsView'
import { ExplorerView } from './components/explorer/ExplorerView'
import { AnnotationsView } from './components/annotations/AnnotationsView'
import { PolicyViewerView } from './components/annotations/PolicyViewerView'
import { ConsistencyCheckerView } from './components/consistency/ConsistencyCheckerView'
import { DatabaseView } from './components/database/DatabaseView'
import { SettingsView } from './components/settings/SettingsView'
import { AuditWorkspaceView } from './components/audit/AuditWorkspaceView'
import { NavId, Theme } from './types'
import { computeResults } from './utils/results'
import { parseAnnotationDoneUsage } from './utils/annotationCost'

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

function formatAgeLabel(timestamp: number | null) {
  if (!timestamp) return 'never'
  const deltaMs = Date.now() - timestamp
  if (deltaMs < 15_000) return 'just now'
  const totalSeconds = Math.floor(deltaMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes <= 0) return `${seconds}s ago`
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

function normalizeSiteKey(value: string): string {
  return value.trim().toLowerCase()
}

function resultSiteKey(record: any): string {
  const candidate = record?.site_etld1 || record?.input || record?.site || ''
  return typeof candidate === 'string' ? normalizeSiteKey(candidate) : ''
}

type TunnelStatus = 'checking' | 'online' | 'degraded' | 'offline'

type BridgeSnapshot = {
  service_ready?: boolean
  database_ready?: boolean
  scraper_connected?: boolean
  dashboard_locked?: boolean
  active_run?: boolean
  annotator_running?: boolean
  running?: boolean
  annotateRunning?: boolean
  node?: string
  port?: number
  db_port?: number
  current_out_dir?: string
  checked_at?: string
  probe_error?: string
  probe_detail?: string
  local_port_listening?: boolean
  tunnel_state?: 'stale' | 'offline'
  source_rev?: string
  local_source_rev?: string
}

type BridgeScriptResult = {
  ok: boolean
  code?: number
  command?: string
  stdout?: string
  stderr?: string
  error?: string
  hint?: string
  health_ok?: boolean
  signal?: string | null
  killed?: boolean
}

function App() {
  const [theme, setTheme] = useState<Theme>('academia')
  const [showExtractionMethod, setShowExtractionMethod] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem('settings.showExtractionMethod')
      if (raw === null) return true
      return raw !== 'false'
    } catch {
      return true
    }
  })
  const [activeNav, setActiveNav] = useState<NavId>('launcher')
  const [topN, setTopN] = useState('1000')
  const [hasRun, setHasRun] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [logs, setLogs] = useState<string[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [summaryData, setSummaryData] = useState<any | null>(null)
  const [explorerData, setExplorerData] = useState<any[] | null>(null)
  const [resultsData, setResultsData] = useState<any[] | null>(null)
  const [stateData, setStateData] = useState<any | null>(null)
  const [clearing, setClearing] = useState(false)
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null)
  const [etaText, setEtaText] = useState<string>('')
  const [useCrux, setUseCrux] = useState(true)
  const [cruxApiKey, setCruxApiKey] = useState('')
  const [excludeSameEntity, setExcludeSameEntity] = useState(true)
  const [mappingMode, setMappingMode] = useState<'radar' | 'trackerdb' | 'mixed'>('mixed')
  const [outDir, setOutDir] = useState('outputs/unified')
  const [runsRoot] = useState('outputs')
  const [resumeMode, setResumeMode] = useState(true)
  const [runRecords, setRunRecords] = useState<any[]>([])
  const [runManifest, setRunManifest] = useState<any | null>(null)
  const [folderBytes, setFolderBytes] = useState<number | null>(null)
  const [auditVerifiedSites, setAuditVerifiedSites] = useState<string[]>([])
  const [auditUrlOverrides, setAuditUrlOverrides] = useState<Record<string, string>>({})
  const [auditBusySite, setAuditBusySite] = useState<string | null>(null)
  const [auditAnnotatingSite, setAuditAnnotatingSite] = useState<string | null>(null)
  // Stage 2 — Annotation state
  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatus>('checking')
  const [backendStatus, setBackendStatus] = useState<BridgeSnapshot | null>(null)
  const [bridgeFailures, setBridgeFailures] = useState(0)
  const [bridgeCheckedAt, setBridgeCheckedAt] = useState<number | null>(null)
  const [bridgeHealthyAt, setBridgeHealthyAt] = useState<number | null>(null)
  const [bridgeActionBusy, setBridgeActionBusy] = useState<'diagnose' | 'repair' | 'refresh' | null>(null)
  const [bridgeActionMessage, setBridgeActionMessage] = useState<string | null>(null)
  const [stopRunPending, setStopRunPending] = useState(false)
  const [llmModel] = useState('openai/local')
  const [annotateRunning, setAnnotateRunning] = useState(false)
  const [annotateLogs, setAnnotateLogs] = useState<string[]>([])
  const [, setAnnotateRunUsage] = useState({ tokensIn: 0, tokensOut: 0 })
  const [annotationStats, setAnnotationStats] = useState<any>(null)
  const [autoAnnotate, setAutoAnnotate] = useState(true)
  const [autoAnnotatePending, setAutoAnnotatePending] = useState(false)
  const [annotationsTab, setAnnotationsTab] = useState<'overview' | 'viewer'>('overview')
  const [latestStreamEvent, setLatestStreamEvent] = useState<import('./vite-env').AnnotatorStreamEvent | null>(null)
  const annotateLogsRef = useRef<string[]>([])
  const llmModelRef = useRef(llmModel)
  const stopRunPendingRef = useRef(false)
  const defaultOutDir = `${runsRoot}/unified`

  const resetLoadedOutputState = useCallback((nextOutDir?: string) => {
    setSummaryData(null)
    setExplorerData(null)
    setResultsData(null)
    setStateData(null)
    setRunManifest(null)
    setFolderBytes(null)
    setAnnotationStats(null)
    setAuditVerifiedSites([])
    setAuditUrlOverrides({})
    setAuditBusySite(null)
    setAuditAnnotatingSite(null)
    setActiveSites({})
    setRecentCompleted([])
    setHasRun(false)
    setRunning(false)
    setStopRunPending(false)
    setProgress(0)
    setLogs([])
    setRunStartedAt(null)
    setEtaText('')
    setAutoAnnotatePending(false)
    if (nextOutDir) {
      setOutDir(nextOutDir)
    }
  }, [])

  const handleMissingOutputDir = useCallback(async (missingDir: string) => {
    const fallbackDir = defaultOutDir
    resetLoadedOutputState(missingDir === fallbackDir ? undefined : fallbackDir)
    if (outDir === missingDir) {
      setErrorMessage(`Output folder "${missingDir}" no longer exists. Hidden stale data and reset to ${fallbackDir}.`)
    }
    if (window.scraper) {
      const res = await window.scraper.listRuns(runsRoot)
      if (res?.ok && Array.isArray(res.runs)) {
        setRunRecords(res.runs)
      } else {
        setRunRecords([])
      }
    }
  }, [defaultOutDir, outDir, resetLoadedOutputState, runsRoot])

  const refreshBridgeStatus = useCallback(async () => {
    if (!window.scraper?.checkTunnel) return
    const checkedAt = Date.now()
    const res = await window.scraper.checkTunnel()
    setBridgeCheckedAt(checkedAt)
    if (res?.ok) {
      setBackendStatus(res.data || null)
      setTunnelStatus('online')
      setBridgeFailures(0)
      setBridgeHealthyAt(checkedAt)
      return
    }
    setBackendStatus(res?.data || null)
    setBridgeFailures((prev) => {
      const next = prev + 1
      if (res?.data?.local_port_listening) {
        setTunnelStatus('degraded')
        return next
      }
      setTunnelStatus(bridgeHealthyAt && next < 2 ? 'degraded' : 'offline')
      return next
    })
  }, [bridgeHealthyAt])

  // Poll the SSH-backed bridge and avoid tearing the UI down on a single missed heartbeat.
  useEffect(() => {
    void refreshBridgeStatus()
    const id = setInterval(() => { void refreshBridgeStatus() }, 5_000)
    return () => clearInterval(id)
  }, [refreshBridgeStatus])

  const dashboardLocked = (
    tunnelStatus === 'checking'
    || tunnelStatus === 'offline'
    || !backendStatus?.service_ready
    || !backendStatus?.database_ready
    || Boolean(backendStatus?.dashboard_locked)
  )
  const remoteCodeLegacy = Boolean(backendStatus && tunnelStatus !== 'offline' && !backendStatus.source_rev)
  const remoteCodeMismatch = Boolean(
    backendStatus?.source_rev
    && backendStatus?.local_source_rev
    && backendStatus.source_rev !== backendStatus.local_source_rev
  )
  const remoteCodeOutdated = remoteCodeLegacy || remoteCodeMismatch

  useEffect(() => {
    if (dashboardLocked && activeNav !== 'launcher') {
      setActiveNav('launcher')
    }
  }, [dashboardLocked, activeNav])

  type ActiveSiteInfo = { label: string; stepIndex: number; rank: number }
  type CompletedSiteInfo = { site: string; status: string; cached: boolean; annotated?: boolean }
  const [activeSites, setActiveSites] = useState<Record<string, ActiveSiteInfo>>({})
  const [recentCompleted, setRecentCompleted] = useState<CompletedSiteInfo[]>([])

  const SITE_STAGE_LABELS: Record<string, { label: string; index: number }> = {
    home_fetch:               { label: 'Home fetch',       index: 0 },
    policy_discovery:         { label: 'Policy discovery', index: 1 },
    third_party_extract:      { label: '3P extraction',    index: 2 },
    third_party_policy_fetch: { label: '3P policies',      index: 3 },
  }

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    try {
      localStorage.setItem('settings.showExtractionMethod', String(showExtractionMethod))
    } catch {
      // ignore storage failures
    }
  }, [showExtractionMethod])

  const resultsMetrics = useMemo(() => computeResults(hasRun, progress), [hasRun, progress])
  const datasetState = useMemo(() => {
    const totalSites = Number(summaryData?.total_sites ?? stateData?.total_sites ?? runManifest?.expectedTotalSites ?? 0)
    const processedSites = Number(summaryData?.processed_sites ?? stateData?.processed_sites ?? 0)
    const siteKeys = new Set<string>()
    let lastSuccessfulRank: number | null = null
    let lastSuccessfulSite: string | null = null

    for (const record of resultsData || []) {
      const siteKey = resultSiteKey(record)
      if (siteKey) siteKeys.add(siteKey)
      const rank = Number(record?.rank)
      if (record?.status === 'ok' && Number.isFinite(rank)) {
        if (lastSuccessfulRank === null || rank > lastSuccessfulRank) {
          lastSuccessfulRank = rank
          const siteName = record?.site_etld1 || record?.input || record?.site
          lastSuccessfulSite = typeof siteName === 'string' ? siteName : null
        }
      }
    }

    const pendingManifestSites = Array.isArray(runManifest?.requestedSites)
      ? runManifest.requestedSites
          .map((site: unknown) => String(site || '').trim())
          .filter(Boolean)
          .filter((site: string, index: number, list: string[]) => list.findIndex((value) => normalizeSiteKey(value) === normalizeSiteKey(site)) === index)
          .filter((site: string) => !siteKeys.has(normalizeSiteKey(site)))
      : []
    const hasDataset = Boolean(summaryData || stateData || siteKeys.size > 0)
    const isComplete = totalSites > 0 && processedSites >= totalSites
    const isIncomplete = totalSites > 0 && processedSites < totalSites
    const progressPct = totalSites > 0
      ? Math.min(100, (processedSites / Math.max(1, totalSites)) * 100)
      : hasDataset ? 100 : 0

    return {
      hasDataset,
      totalSites,
      processedSites,
      siteKeys,
      uniqueSiteCount: siteKeys.size,
      isComplete,
      isIncomplete,
      progressPct,
      lastSuccessfulRank,
      lastSuccessfulSite,
      pendingManifestSites,
      manifestMode: runManifest?.mode as 'tranco' | 'append_sites' | undefined,
      manifestTopN: Number(runManifest?.topN || 0) || null,
      manifestTrancoDate: typeof runManifest?.trancoDate === 'string' ? runManifest.trancoDate : undefined,
      manifestCruxFilter: typeof runManifest?.cruxFilter === 'boolean' ? runManifest.cruxFilter : undefined,
    }
  }, [summaryData, stateData, resultsData, runManifest])
  const bridgeReady = !dashboardLocked
  const scraperActive = running || stopRunPending || Boolean(backendStatus?.active_run || backendStatus?.running)
  const workspaceReady = bridgeReady && (running || hasRun || datasetState.hasDataset)
  const bridgeHeadline = tunnelStatus === 'checking'
    ? 'Probing local tunnel'
    : tunnelStatus === 'offline'
      ? 'Tunnel offline'
      : tunnelStatus === 'degraded' && backendStatus?.local_port_listening && !backendStatus?.service_ready
        ? 'Tunnel attached to stale target'
      : remoteCodeOutdated
        ? 'Remote control plane is outdated'
      : !backendStatus?.service_ready
        ? 'Remote control plane booting'
        : !backendStatus?.database_ready
          ? 'PostgreSQL warming up'
          : running || backendStatus?.active_run || backendStatus?.running
            ? 'Cluster pipeline active'
            : workspaceReady
              ? 'Cluster workspace synchronized'
              : 'Bridge ready for launch'
  const bridgeDetail = tunnelStatus === 'checking'
    ? 'Waiting for port 8910 to answer from the workstation side.'
    : tunnelStatus === 'offline'
      ? 'Start or restore the SSH tunnel before using the remote pipeline.'
      : tunnelStatus === 'degraded' && backendStatus?.local_port_listening && !backendStatus?.service_ready
        ? 'Local port 8910 is still forwarded, but the remote orchestrator behind that tunnel is not answering. Reattach the tunnel to the current compute node.'
      : remoteCodeLegacy
        ? 'The running orchestrator predates revision tracking and may still contain old annotation logic. Relaunch it with hpc/scraper/launch_remote.sh.'
      : remoteCodeMismatch
        ? `Local repo is at ${backendStatus?.local_source_rev}, but the connected orchestrator is ${backendStatus?.source_rev}. Relaunch the remote orchestrator to deploy the current annotation code.`
      : !backendStatus?.service_ready
        ? 'Tunnel is up, but the orchestrator API is still coming online.'
        : !backendStatus?.database_ready
          ? 'Control plane is reachable, but PostgreSQL has not finished initializing.'
          : running || backendStatus?.active_run || backendStatus?.running
            ? 'The workstation is attached to a live remote run and status is streaming from the cluster.'
            : workspaceReady
              ? 'Remote state is synced and downstream views are unlocked.'
              : 'Bridge is healthy. Launch a remote job to unlock the full workspace.'
  const disabledNavs = {
    launcher: false,
    settings: false,
    database: !bridgeReady,
    results: !workspaceReady,
    audit: !workspaceReady,
    explorer: !workspaceReady,
    annotations: !workspaceReady,
    consistency: !workspaceReady,
  } satisfies Record<NavId, boolean>
  const handleSelectNav = useCallback((next: NavId) => {
    if (!disabledNavs[next]) {
      setActiveNav(next)
      return
    }
    setErrorMessage(
      next === 'database'
        ? 'Remote orchestrator is not ready yet. Bring the bridge online first.'
        : 'This view unlocks after the tunnel is healthy and a remote workspace is available.'
    )
    setActiveNav('launcher')
  }, [disabledNavs])
  useEffect(() => {
    if (!disabledNavs[activeNav]) return
    setActiveNav('launcher')
  }, [activeNav, disabledNavs])
  const currentTargetTotal = useMemo(
    () => datasetState.manifestTopN || datasetState.totalSites || datasetState.uniqueSiteCount,
    [datasetState]
  )
  const requestedTargetTotal = Number(topN || 0)
  const canExtendByTarget = useMemo(
    () => resumeMode && datasetState.isComplete && (datasetState.manifestMode === 'tranco' || datasetState.lastSuccessfulRank !== null),
    [datasetState, resumeMode]
  )
  const extensionDelta = useMemo(() => {
    if (!canExtendByTarget) return 0
    if (!Number.isFinite(requestedTargetTotal) || requestedTargetTotal <= 0) return 0
    return Math.max(0, requestedTargetTotal - currentTargetTotal)
  }, [canExtendByTarget, currentTargetTotal, requestedTargetTotal])
  const launchStartingProgress = useMemo(() => {
    if (datasetState.isIncomplete) {
      return datasetState.progressPct
    }
    if (extensionDelta > 0 && requestedTargetTotal > 0) {
      return Math.min(100, (datasetState.processedSites / requestedTargetTotal) * 100)
    }
    return 0
  }, [datasetState, extensionDelta, requestedTargetTotal])
  const launcherMode = useMemo<'start' | 'continue' | 'extend'>(() => {
    if (datasetState.isIncomplete) {
      if (datasetState.manifestMode === 'append_sites' && datasetState.pendingManifestSites.length > 0) {
        return 'continue'
      }
      if (datasetState.manifestMode === 'tranco' || datasetState.lastSuccessfulRank !== null) {
        return 'continue'
      }
    }
    if (canExtendByTarget) {
      return 'extend'
    }
    return 'start'
  }, [canExtendByTarget, datasetState])
  const launcherActionLabel = launcherMode === 'continue'
    ? 'Continue'
    : launcherMode === 'extend'
      ? 'Extend run'
      : 'Start run'
  const runRequiresCruxKey = useMemo(() => {
    if (launcherMode === 'continue' && datasetState.isIncomplete) {
      if (datasetState.manifestMode === 'append_sites' && datasetState.pendingManifestSites.length > 0) {
        return false
      }
      return Boolean(datasetState.manifestCruxFilter ?? useCrux)
    }
    if (launcherMode === 'extend') {
      return Boolean(datasetState.manifestCruxFilter ?? useCrux)
    }
    return Boolean(useCrux)
  }, [datasetState, launcherMode, useCrux])
  const cruxKeyMissing = runRequiresCruxKey && !cruxApiKey.trim()
  const launcherActionHint = launcherMode === 'continue'
    ? datasetState.manifestMode === 'append_sites' && datasetState.pendingManifestSites.length > 0
      ? `Resume ${datasetState.pendingManifestSites.length} pending append target(s) in ${outDir}.`
      : `Resume ${outDir} after ${datasetState.lastSuccessfulSite || `rank #${datasetState.lastSuccessfulRank ?? 0}`} to reach ${datasetState.totalSites} sites.`
    : cruxKeyMissing
      ? 'Enter a CrUX API key in Settings before starting a scrape.'
    : launcherMode === 'extend'
      ? extensionDelta > 0
        ? `Extend ${outDir} from ${currentTargetTotal} to ${requestedTargetTotal} total sites by scraping the remaining ${extensionDelta}.`
        : `This dataset already has ${currentTargetTotal} sites. Enter a higher total to continue scraping from the next rank.`
    : dashboardLocked
        ? 'Cluster bridge offline. Start the orchestrator and SSH tunnel with hpc/scraper/launch_remote.sh.'
        : 'Choose how many sites to crawl. Press Enter to start.'
  const syncLoadedRunState = useCallback(async (targetDir = outDir) => {
    if (!window.scraper) return
    const summary = await window.scraper.readSummary(`${targetDir}/results.summary.json`)
    setSummaryData(summary?.ok ? summary.data : null)
    const state = await window.scraper.readState(`${targetDir}/run_state.json`)
    setStateData(state?.ok ? state.data : null)
    let resultsRes: any = null
    if (window.scraper.readResults) {
      resultsRes = await window.scraper.readResults(`${targetDir}/results.jsonl`)
      if (resultsRes?.ok && Array.isArray(resultsRes.data)) {
        const cleanedResults = resultsRes.data.filter((rec: any) => rec && (rec.site_etld1 || rec.input || rec.site))
        setResultsData(cleanedResults)
      } else {
        setResultsData([])
      }
    }
    if (window.scraper.readRunManifest) {
      const manifest = await window.scraper.readRunManifest(targetDir)
      setRunManifest(manifest?.ok ? manifest.data : null)
    }
    const loadedProcessed = Number(summary?.data?.processed_sites ?? state?.data?.processed_sites ?? 0)
    const loadedTotal = Number(summary?.data?.total_sites ?? state?.data?.total_sites ?? 0)
    const hasAnyResults = Boolean(
      summary?.ok
      || state?.ok
      || (resultsRes?.ok && Array.isArray(resultsRes.data) && resultsRes.data.length)
    )
    setHasRun(hasAnyResults)
    setProgress(
      loadedTotal > 0
        ? Math.min(100, (loadedProcessed / Math.max(1, loadedTotal)) * 100)
        : hasAnyResults ? 100 : 0
    )
  }, [outDir])
  useEffect(() => {
    if (!window.scraper) return
    const scraper = window.scraper
    scraper.onEvent((event) => {
      if (event?.type === 'run_started') {
        setHasRun(true)
        setRunning(true)
        setAutoAnnotatePending(false)
        setProgress(launchStartingProgress)
        setErrorMessage(null)
        setRunStartedAt(Date.now())
        setEtaText('')
        setActiveSites({})
        setRecentCompleted([])
      }
      if (event?.type === 'run_progress') {
        const processed = Number(event.processed || 0)
        const total = Number(event.total || 0)
        if (total > 0) {
          setProgress(Math.min(100, (processed / total) * 100))
        }
      }
      if (event?.type === 'site_started' && event.site) {
        setActiveSites((prev) => ({
          ...prev,
          [event.site]: { label: 'Home fetch', stepIndex: 0, rank: event.rank ?? 0 },
        }))
        setLogs((prev) => [...prev, `Processing ${event.site}`].slice(-50))
      }
      if (event?.type === 'site_stage' && event.site) {
        const stageInfo = SITE_STAGE_LABELS[event.stage]
        if (stageInfo) {
          setActiveSites((prev) => ({
            ...prev,
            [event.site]: { ...(prev[event.site] ?? { rank: event.rank ?? 0 }), label: stageInfo.label, stepIndex: stageInfo.index },
          }))
        }
      }
      if (event?.type === 'site_finished' && event.site) {
        setActiveSites((prev) => {
          const next = { ...prev }
          delete next[event.site]
          return next
        })
        setAuditBusySite((current) => (current === event.site ? null : current))
        setRecentCompleted((prev) => [
          { site: event.site, status: event.status || 'ok', cached: !!event.cached, annotated: !!event.annotated },
          ...prev.slice(0, 14),
        ])
        setLogs((prev) => [...prev, `Finished ${event.site} (${event.status})`].slice(-50))
      }
      if (event?.type === 'run_completed') {
        setStopRunPending(false)
        setRunning(false)
        setAutoAnnotatePending(autoAnnotate)
        setProgress(100)
        setEtaText('0s')
        setActiveSites({})
        setAuditBusySite(null)
        void syncLoadedRunState(outDir)
        refreshRuns()
      }
    })
    scraper.onLog((evt) => {
      if (evt?.message) {
        setLogs((prev) => [...prev, evt.message].slice(-50))
      }
    })
    scraper.onError((evt) => {
      if (evt?.message) {
        setErrorMessage(String(evt.message))
        setLogs((prev) => [...prev, `ERROR: ${evt.message}`].slice(-50))
      }
      setRunning(false)
      setAutoAnnotatePending(false)
      setStopRunPending(false)
      setAuditBusySite(null)
      void syncLoadedRunState(outDir)
    })
    scraper.onExit((evt) => {
      const code = Number(evt?.code ?? 0)
      const signal = evt?.signal ? String(evt.signal) : null
      const requested = Boolean(evt?.stop_requested) || stopRunPendingRef.current
      if (code !== 0 && !requested) {
        setErrorMessage(`Scraper exited with code ${code}${signal ? ` (${signal})` : ''}`)
      } else if (requested) {
        setLogs((prev) => [...prev, `Scraper stopped${signal ? ` (${signal})` : ''}`].slice(-50))
        setErrorMessage(null)
      }
      setRunning(false)
      setAutoAnnotatePending(false)
      setStopRunPending(false)
      setAuditBusySite(null)
      void syncLoadedRunState(outDir)
    })

    if (scraper.onAnnotatorLog) {
      scraper.onAnnotatorLog((evt) => {
        const raw = evt?.message ? String(evt.message).trimEnd() : String(evt)
        const lines = raw.split('\n').map((l: string) => l.trimEnd()).filter(Boolean)
        if (lines.length) {
          annotateLogsRef.current = [...annotateLogsRef.current, ...lines]
          const delta = parseAnnotationDoneUsage(lines)
          if (delta.tokensIn || delta.tokensOut) {
            setAnnotateRunUsage((prev) => ({
              tokensIn: prev.tokensIn + delta.tokensIn,
              tokensOut: prev.tokensOut + delta.tokensOut,
            }))
          }
          setAnnotateLogs((prev) => [...prev.slice(-(200 - lines.length)), ...lines])
        }
      })
    }

    if (scraper.onAnnotatorStream) {
      scraper.onAnnotatorStream((evt) => {
        setLatestStreamEvent(evt)
      })
    }

    if (scraper.onAnnotatorExit) {
      scraper.onAnnotatorExit((evt) => {
        setLatestStreamEvent(null)
        setAnnotateRunning(false)
        setAuditAnnotatingSite(null)
        const code = Number(evt?.code ?? 0)
        const signal = evt?.signal ? String(evt.signal) : null
        setAnnotateLogs((prev) => {
          const next = [...prev]
          if (code === 0) {
            if (next.length === 0) {
              next.push('Annotator finished without emitting logs.')
            } else if (next[next.length - 1] !== 'Annotator finished.') {
              next.push('Annotator finished.')
            }
          } else {
            next.push(`Annotator exited with code ${code}${signal ? ` (${signal})` : ''}.`)
          }
          annotateLogsRef.current = next.slice(-200)
          return annotateLogsRef.current
        })
        // refresh stats after annotator finishes
        if (scraper.annotationStats) {
          scraper.annotationStats(`${outDir}/artifacts`).then((res: any) => {
            if (res?.ok) setAnnotationStats(res)
          })
        }
      })
    }
  }, [autoAnnotate, launchStartingProgress, outDir, syncLoadedRunState])

  // Keep refs in sync so the IPC exit handler always sees current values
  useEffect(() => { llmModelRef.current = llmModel }, [llmModel])
  useEffect(() => { stopRunPendingRef.current = stopRunPending }, [stopRunPending])

  const createRunId = () => {
    try {
      return crypto.randomUUID()
    } catch {
      return `run_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
    }
  }

  const refreshAnnotationStats = useCallback(async () => {
    if (!window.scraper?.annotationStats) return
    const artifactsDir = `${outDir}/artifacts`
    const res = await window.scraper.annotationStats(artifactsDir)
    if (res?.ok) setAnnotationStats(res)
  }, [outDir])

  const loadAuditWorkspace = useCallback(async (dirOverride?: string) => {
    if (!window.scraper) return
    const targetDir = dirOverride || outDir
    if (window.scraper.readResults) {
      const results = await window.scraper.readResults(`${targetDir}/results.jsonl`)
      if (results?.ok && Array.isArray(results.data)) {
        const cleaned = results.data.filter((rec: any) => rec && (rec.site_etld1 || rec.input || rec.site))
        setResultsData(cleaned)
      } else if (!results?.ok && results?.error === 'not_found') {
        setResultsData([])
      }
    }
    if (window.scraper.readAuditState) {
      const state = await window.scraper.readAuditState(targetDir)
      if (state?.ok && state.data) {
        setAuditVerifiedSites(Array.isArray(state.data.verifiedSites) ? state.data.verifiedSites : [])
        setAuditUrlOverrides(state.data.urlOverrides || {})
      } else {
        setAuditVerifiedSites([])
        setAuditUrlOverrides({})
      }
    }
  }, [outDir])

  const persistAuditState = useCallback(async (
    nextVerifiedSites: string[],
    nextUrlOverrides: Record<string, string>,
    dirOverride?: string
  ) => {
    if (!window.scraper?.writeAuditState) return
    const targetDir = dirOverride || outDir
    const res = await window.scraper.writeAuditState({
      outDir: targetDir,
      verifiedSites: nextVerifiedSites,
      urlOverrides: nextUrlOverrides,
    })
    if (res?.ok && res.data) {
      setAuditVerifiedSites(res.data.verifiedSites || [])
      setAuditUrlOverrides(res.data.urlOverrides || {})
    }
  }, [outDir])

  const markAuditVerified = useCallback(async (site: string) => {
    const siteKey = normalizeSiteKey(site)
    const next = Array.from(new Set([...auditVerifiedSites, siteKey]))
    await persistAuditState(next, auditUrlOverrides)
  }, [auditVerifiedSites, auditUrlOverrides, persistAuditState])

  const saveAuditOverride = useCallback(async (site: string, url: string) => {
    const siteKey = normalizeSiteKey(site)
    const nextOverrides = { ...auditUrlOverrides }
    const normalizedUrl = url.trim()
    if (normalizedUrl) {
      nextOverrides[siteKey] = normalizedUrl
    } else {
      delete nextOverrides[siteKey]
    }
    await persistAuditState(auditVerifiedSites, nextOverrides)
  }, [auditVerifiedSites, auditUrlOverrides, persistAuditState])

  const rerunAuditSite = useCallback(async (site: string, overrideUrl?: string) => {
    if (!window.scraper?.rerunSite) {
      return { ok: false, error: 'rerunSite API unavailable' }
    }
    const siteKey = normalizeSiteKey(site)
    const normalizedOverride = (overrideUrl || '').trim()
    const nextOverrides = { ...auditUrlOverrides }
    if (normalizedOverride) {
      nextOverrides[siteKey] = normalizedOverride
    } else {
      delete nextOverrides[siteKey]
    }
    await persistAuditState(auditVerifiedSites, nextOverrides)

    const trackerRadarIndex = mappingMode === 'trackerdb' ? undefined : 'tracker_radar_index.json'
    const trackerDbIndex = mappingMode === 'radar' ? undefined : 'trackerdb_index.json'
    const runId = createRunId()
    setAuditBusySite(site)
    const res = await window.scraper.rerunSite({
      site,
      outDir,
      artifactsDir: `${outDir}/artifacts`,
      runId,
      trackerRadarIndex,
      trackerDbIndex,
      policyUrlOverride: normalizedOverride || undefined,
      excludeSameEntity,
      llmModel,
    })
    if (!res?.ok) {
      setAuditBusySite(null)
      return { ok: false, error: res?.error || 'Failed to start rerun.' }
    }
    setHasRun(true)
    setRunning(true)
    setProgress(0)
    return { ok: true }
  }, [
    auditUrlOverrides,
    auditVerifiedSites,
    persistAuditState,
    mappingMode,
    outDir,
    excludeSameEntity,
    llmModel,
  ])

  const annotateAuditSite = useCallback(async (site: string) => {
    if (remoteCodeOutdated) {
      const message = remoteCodeLegacy
        ? 'Annotation blocked: the connected remote orchestrator is older than the current hpc-v code. Run hpc/scraper/launch_remote.sh and reconnect.'
        : `Annotation blocked: remote orchestrator revision ${backendStatus?.source_rev} does not match local revision ${backendStatus?.local_source_rev}. Run hpc/scraper/launch_remote.sh and reconnect.`
      annotateLogsRef.current = [message]
      setAnnotateLogs([message])
      return {
        ok: false,
        error: remoteCodeLegacy
          ? 'Remote orchestrator is outdated. Relaunch it with hpc/scraper/launch_remote.sh before annotating.'
          : `Remote orchestrator revision ${backendStatus?.source_rev} does not match local revision ${backendStatus?.local_source_rev}. Relaunch it before annotating.`,
      }
    }
    if (!window.scraper?.annotateSite) {
      annotateLogsRef.current = ['Annotation API unavailable in the current Electron session.']
      setAnnotateLogs(['Annotation API unavailable in the current Electron session.'])
      return { ok: false, error: 'annotateSite API unavailable' }
    }
    annotateLogsRef.current = []
    setAnnotateRunUsage({ tokensIn: 0, tokensOut: 0 })
    setAnnotateLogs([`Starting annotation for ${site}...`])
    setAnnotateRunning(true)
    setAuditAnnotatingSite(site)
    const res = await window.scraper.annotateSite({
      site,
      outDir,
      llmModel,
      force: true,
    })
    if (!res?.ok) {
      setAnnotateRunning(false)
      setAuditAnnotatingSite(null)
      const message = `Failed to start annotation: ${res?.error || 'unknown error'}`
      annotateLogsRef.current = [message]
      setAnnotateLogs([message])
      return { ok: false, error: res?.error || 'Failed to start annotation.' }
    }
    return { ok: true }
  }, [outDir, llmModel, remoteCodeOutdated, remoteCodeLegacy, backendStatus])

  const startAnnotate = useCallback(async (opts: { llmModel?: string; concurrency?: number; force?: boolean }) => {
    if (remoteCodeOutdated) {
      const message = remoteCodeLegacy
        ? 'Annotation blocked: the connected remote orchestrator is older than the current hpc-v code. Run hpc/scraper/launch_remote.sh and reconnect.'
        : `Annotation blocked: remote orchestrator revision ${backendStatus?.source_rev} does not match local revision ${backendStatus?.local_source_rev}. Run hpc/scraper/launch_remote.sh and reconnect.`
      setAnnotateRunning(false)
      annotateLogsRef.current = [message]
      setAnnotateLogs([message])
      return
    }
    if (!window.scraper?.startAnnotate) {
      annotateLogsRef.current = ['Annotator start API unavailable in the current Electron session.']
      setAnnotateLogs(['Annotator start API unavailable in the current Electron session.'])
      return
    }
    annotateLogsRef.current = []
    setAnnotateRunUsage({ tokensIn: 0, tokensOut: 0 })
    setAnnotateLogs(['Starting annotator...'])
    setAnnotateRunning(true)
    const res = await window.scraper.startAnnotate({
      artifactsDir: `${outDir}/artifacts`,
      llmModel: opts.llmModel ?? llmModel,
      concurrency: opts.concurrency ?? 1,
      force: opts.force ?? false,
    })
    if (!res?.ok) {
      if (res?.error === 'annotator_already_running') {
        const message = 'Annotator is already running on the remote orchestrator. Reattaching to the live job.'
        annotateLogsRef.current = [message]
        setAnnotateLogs([message])
        setAnnotateRunning(true)
        await refreshBridgeStatus()
        return
      }
      setAnnotateRunning(false)
      const message = `Failed to start annotator: ${res?.error ?? 'unknown error'}`
      annotateLogsRef.current = [message]
      setAnnotateLogs([message])
    }
  }, [outDir, llmModel, remoteCodeOutdated, remoteCodeLegacy, backendStatus, refreshBridgeStatus])

  const stopAnnotate = async () => {
    if (!window.scraper?.stopAnnotate) return
    await window.scraper.stopAnnotate()
    setAnnotateRunning(false)
    setAuditAnnotatingSite(null)
  }

  const startRun = async () => {
    if (scraperActive) return
    if (dashboardLocked) {
      setErrorMessage('Cluster bridge is offline. Start the remote orchestrator and port 8910 tunnel first.')
      return
    }
    if (cruxKeyMissing) {
      setErrorMessage('CrUX is enabled for this run. Enter a CrUX API key in Settings before starting the scraper.')
      return
    }
    if (launcherMode === 'start' && (!topN || Number(topN) <= 0)) return
    if (launcherMode === 'extend' && extensionDelta <= 0) {
      setErrorMessage(`Enter a target total higher than the current ${currentTargetTotal} sites to continue this dataset.`)
      return
    }
    const runId = createRunId()
    const trackerRadarIndex = mappingMode === 'trackerdb' ? undefined : 'tracker_radar_index.json'
    const trackerDbIndex = mappingMode === 'radar' ? undefined : 'trackerdb_index.json'
    const freshOutDir = resumeMode ? `${runsRoot}/unified` : `${runsRoot}/output_${runId}`
    let runOutDir = freshOutDir
    let startOptions: any = {
      trackerRadarIndex,
      trackerDbIndex,
      excludeSameEntity,
    }

    if (launcherMode === 'continue' && datasetState.isIncomplete) {
      runOutDir = outDir
      if (datasetState.manifestMode === 'append_sites' && datasetState.pendingManifestSites.length > 0) {
        startOptions = {
          ...startOptions,
          sites: datasetState.pendingManifestSites,
          outDir: runOutDir,
          artifactsDir: `${runOutDir}/artifacts`,
          runId,
          expectedTotalSites: datasetState.totalSites || datasetState.uniqueSiteCount + datasetState.pendingManifestSites.length,
          upsertBySite: true,
        }
      } else {
        startOptions = {
          ...startOptions,
          topN: datasetState.manifestTopN || datasetState.totalSites,
          trancoDate: datasetState.manifestTrancoDate,
          outDir: runOutDir,
          artifactsDir: `${runOutDir}/artifacts`,
          runId,
          resumeAfterRank: datasetState.lastSuccessfulRank ?? undefined,
          expectedTotalSites: datasetState.totalSites,
          upsertBySite: true,
          cruxFilter: datasetState.manifestCruxFilter ?? useCrux,
          cruxApiKey: (datasetState.manifestCruxFilter ?? useCrux) ? cruxApiKey : undefined,
        }
      }
    } else if (launcherMode === 'extend') {
      runOutDir = outDir
      startOptions = {
        ...startOptions,
        topN: requestedTargetTotal,
        trancoDate: datasetState.manifestTrancoDate,
        outDir: runOutDir,
        artifactsDir: `${runOutDir}/artifacts`,
        runId,
        resumeAfterRank: datasetState.lastSuccessfulRank ?? undefined,
        expectedTotalSites: requestedTargetTotal,
        upsertBySite: true,
        cruxFilter: datasetState.manifestCruxFilter ?? useCrux,
        cruxApiKey: (datasetState.manifestCruxFilter ?? useCrux) ? cruxApiKey : undefined,
      }
    } else {
      runOutDir = freshOutDir
      startOptions = {
        ...startOptions,
        topN: Number(topN),
        outDir: runOutDir,
        artifactsDir: `${runOutDir}/artifacts`,
        runId: resumeMode ? undefined : runId,
        cruxFilter: useCrux,
        cruxApiKey: useCrux ? cruxApiKey : undefined,
      }
    }

    setErrorMessage(null)
    setLogs([])
    if (launcherMode === 'start' && !resumeMode) {
      setSummaryData(null)
      setExplorerData(null)
      setResultsData(null)
      setAuditVerifiedSites([])
      setAuditUrlOverrides({})
      setRunManifest(null)
    }
    setOutDir(runOutDir)
    if (window.scraper) {
      const res = await window.scraper.startRun(startOptions)
      if (!res.ok) {
        setErrorMessage(res.error || 'Failed to start scraper')
      } else {
        setHasRun(true)
        setRunning(true)
        setProgress(launchStartingProgress)
        setRunStartedAt(Date.now())
        setEtaText('')
        if (window.scraper.readRunManifest) {
          const manifestRes = await window.scraper.readRunManifest(runOutDir)
          setRunManifest(manifestRes?.ok ? manifestRes.data : null)
        }
      }
      return
    }
    setHasRun(true)
    setRunning(true)
    setProgress(launchStartingProgress)
    setRunStartedAt(Date.now())
    setEtaText('')
  }

  useEffect(() => {
    if (!running) return
    if (!window.scraper) {
      const timer = setInterval(() => {
        setProgress((prev) => Math.min(100, prev + 4 + Math.random() * 6))
      }, 520)
      return () => clearInterval(timer)
    }
  }, [running])

  useEffect(() => {
    if (!running) return
    if (window.scraper) return
    if (progress >= 100) {
      setRunning(false)
    }
  }, [progress, running])

  useEffect(() => {
    if (!running || !runStartedAt || progress <= 0) {
      if (!running) setEtaText('')
      return
    }
    const effectiveProgress =
      stateData?.total_sites && stateData?.processed_sites
        ? (stateData.processed_sites / Math.max(1, stateData.total_sites)) * 100
        : progress
    if (effectiveProgress <= 0) return
    const elapsedMs = Date.now() - runStartedAt
    const totalMs = elapsedMs / (effectiveProgress / 100)
    const remainingMs = Math.max(0, totalMs - elapsedMs)
    setEtaText(formatDuration(remainingMs))
  }, [progress, running, runStartedAt, stateData])

  useEffect(() => {
    if (!window.scraper || !hasRun) return
    const scraper = window.scraper
    const interval = setInterval(async () => {
      try {
        const size = await scraper.getFolderSize(outDir)
        if (!size?.ok && size?.error === 'not_found') {
          await handleMissingOutputDir(outDir)
          return
        }
        const summary = await scraper.readSummary(`${outDir}/results.summary.json`)
        if (summary?.ok) setSummaryData(summary.data)
        else setSummaryData(null)
        const state = await scraper.readState(`${outDir}/run_state.json`)
        if (state?.ok) {
          setStateData(state.data)
          if (state.data?.total_sites && state.data?.processed_sites && running) {
            const computed = (state.data.processed_sites / Math.max(1, state.data.total_sites)) * 100
            setProgress(Math.min(100, computed))
          }
          if (!runStartedAt && state.data?.processed_sites) {
            setRunStartedAt(Date.now())
          }
        }
        const needsExplorerData =
          activeNav === 'results'
          || activeNav === 'explorer'
          || activeNav === 'annotations'
          || activeNav === 'consistency'
        if (needsExplorerData) {
          const explorer = await scraper.readExplorer(`${outDir}/explorer.jsonl`, 500)
          if (explorer?.ok && Array.isArray(explorer.data)) {
            const cleaned = explorer.data.filter((rec: any) => rec && rec.site)
            setExplorerData(cleaned)
          } else {
            setExplorerData([])
          }
        }
        if (activeNav === 'audit') {
          const results = await scraper.readResults(`${outDir}/results.jsonl`)
          if (results?.ok && Array.isArray(results.data)) {
            const cleanedResults = results.data.filter((rec: any) => rec && (rec.site_etld1 || rec.input || rec.site))
            setResultsData(cleanedResults)
          } else {
            setResultsData([])
          }
          const auditState = await scraper.readAuditState(outDir)
          if (auditState?.ok && auditState.data) {
            setAuditVerifiedSites(Array.isArray(auditState.data.verifiedSites) ? auditState.data.verifiedSites : [])
            setAuditUrlOverrides(auditState.data.urlOverrides || {})
          } else {
            setAuditVerifiedSites([])
            setAuditUrlOverrides({})
          }
        }
        // Refresh annotation stats during annotate run or when viewing annotations
        if (annotateRunning || activeNav === 'annotations') {
          await refreshAnnotationStats()
        }
      } catch (error) {
        setErrorMessage(String(error))
      }
    }, 2000)
    return () => clearInterval(interval)
  }, [hasRun, outDir, annotateRunning, activeNav, refreshAnnotationStats, handleMissingOutputDir])

  useEffect(() => {
    if (!window.scraper || activeNav !== 'database') return

    let cancelled = false
    const refreshSize = async () => {
      const size = await window.scraper?.getFolderSize(outDir)
      if (!cancelled && size?.ok && typeof size.bytes === 'number') {
        setFolderBytes(size.bytes)
      } else if (!cancelled && size?.error === 'not_found') {
        setFolderBytes(null)
        await handleMissingOutputDir(outDir)
      }
    }

    void refreshSize()
    const interval = setInterval(refreshSize, 15_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [activeNav, outDir, handleMissingOutputDir])

  useEffect(() => {
    if (!autoAnnotatePending || running || !hasRun || annotateRunning) return
    setAutoAnnotatePending(false)
    void startAnnotate({})
  }, [autoAnnotatePending, running, hasRun, annotateRunning, startAnnotate])

  const refreshRuns = async (baseDir: string = runsRoot) => {
    if (!window.scraper) return
    const res = await window.scraper.listRuns(baseDir)
    if (res?.ok && Array.isArray(res.runs)) {
      setRunRecords(res.runs)
    } else {
      setRunRecords([])
    }
    const size = await window.scraper.getFolderSize(outDir)
    if (!size?.ok && size?.error === 'not_found') {
      await handleMissingOutputDir(outDir)
    }
  }

  useEffect(() => {
    if (activeNav !== 'database') return
    void refreshRuns()
  }, [activeNav, runsRoot, outDir, handleMissingOutputDir])

  useEffect(() => {
    if (activeNav !== 'database') return
    const interval = setInterval(() => {
      void refreshRuns()
    }, 15_000)
    return () => clearInterval(interval)
  }, [activeNav, outDir, handleMissingOutputDir, runsRoot])

  useEffect(() => {
    if (activeNav !== 'audit') return
    void loadAuditWorkspace()
  }, [activeNav, outDir, loadAuditWorkspace])

  const clearResults = async (includeArtifacts?: boolean) => {
    if (!window.scraper) {
      resetLoadedOutputState()
      return
    }
    setClearing(true)
    const res = await window.scraper.clearResults({ includeArtifacts, outDir: outDir })
    if (!res.ok) {
      setErrorMessage(res.error || 'Failed to clear results')
    } else {
      resetLoadedOutputState()
    }
    setClearing(false)
  }

  const loadOutDir = async (dirOverride?: string) => {
    if (!window.scraper) return
    const targetDir = dirOverride || outDir
    let results: any = null
    const size = await window.scraper.getFolderSize(targetDir)
    if (!size?.ok && size?.error === 'not_found') {
      await handleMissingOutputDir(targetDir)
      return
    }
    if (dirOverride) {
      setOutDir(dirOverride)
    }
    const summary = await window.scraper.readSummary(`${targetDir}/results.summary.json`)
    if (summary?.ok) setSummaryData(summary.data)
    else setSummaryData(null)
    const state = await window.scraper.readState(`${targetDir}/run_state.json`)
    if (state?.ok) setStateData(state.data)
    else setStateData(null)
    // Sync topN from the loaded dataset so ResultsView and LauncherView show the correct target.
    const loadedTargetTotal =
      summary?.data?.total_sites ?? state?.data?.total_sites
    if (typeof loadedTargetTotal === 'number' && loadedTargetTotal > 0) {
      setTopN(String(loadedTargetTotal))
    }
    const explorer = await window.scraper.readExplorer(`${targetDir}/explorer.jsonl`, 500)
    if (explorer?.ok && Array.isArray(explorer.data)) {
      const cleaned = explorer.data.filter((rec: any) => rec && rec.site)
      setExplorerData(cleaned)
    } else {
      setExplorerData([])
    }
    if (window.scraper.readResults) {
      results = await window.scraper.readResults(`${targetDir}/results.jsonl`)
      if (results?.ok && Array.isArray(results.data)) {
        const cleanedResults = results.data.filter((rec: any) => rec && (rec.site_etld1 || rec.input || rec.site))
        setResultsData(cleanedResults)
      } else {
        setResultsData([])
      }
    }
    if (window.scraper.readAuditState) {
      const auditState = await window.scraper.readAuditState(targetDir)
      if (auditState?.ok && auditState.data) {
        setAuditVerifiedSites(Array.isArray(auditState.data.verifiedSites) ? auditState.data.verifiedSites : [])
        setAuditUrlOverrides(auditState.data.urlOverrides || {})
      } else {
        setAuditVerifiedSites([])
        setAuditUrlOverrides({})
      }
    }
    if (window.scraper.readRunManifest) {
      const manifest = await window.scraper.readRunManifest(targetDir)
      setRunManifest(manifest?.ok ? manifest.data : null)
    }
    if (size?.ok && typeof size.bytes === 'number') {
      setFolderBytes(size.bytes)
    } else {
      setFolderBytes(null)
    }
    const hasAnyResults = Boolean(
      summary?.ok
      || state?.ok
      || (explorer?.ok && Array.isArray(explorer.data) && explorer.data.length)
      || (results?.ok && Array.isArray(results.data) && results.data.length)
    )
    const loadedProcessed = Number(summary?.data?.processed_sites ?? state?.data?.processed_sites ?? 0)
    const loadedTotal = Number(summary?.data?.total_sites ?? state?.data?.total_sites ?? 0)
    const loadedProgress = loadedTotal > 0
      ? Math.min(100, (loadedProcessed / Math.max(1, loadedTotal)) * 100)
      : hasAnyResults ? 100 : 0
    if (hasAnyResults) {
      setHasRun(true)
      setRunning(false)
      setProgress(loadedProgress)
    } else {
      setHasRun(false)
      setRunning(false)
      setProgress(0)
    }
    // Load annotation stats for the new outDir
    if (window.scraper?.annotationStats) {
      const annRes = await window.scraper.annotationStats(`${targetDir}/artifacts`)
      if (annRes?.ok) setAnnotationStats(annRes)
      else setAnnotationStats(null)
    }
  }

  const deleteOutDir = async () => {
    if (!window.scraper) return
    const targetDir = String(outDir || '').trim()
    if (!targetDir) {
      setErrorMessage('No output folder is selected.')
      return
    }
    if (targetDir === runsRoot) {
      setErrorMessage('Refusing to delete the outputs root. Load a specific run folder instead.')
      return
    }
    if (!window.confirm(`Delete output folder "${targetDir}" and everything inside it?`)) {
      return
    }
    setClearing(true)
    const res = await window.scraper.deleteOutput(targetDir)
    if (!res.ok) {
      setErrorMessage(res.error || 'Failed to delete output folder')
    } else {
      setErrorMessage(null)
      resetLoadedOutputState(defaultOutDir)
      await refreshRuns()
    }
    setClearing(false)
  }

  const deleteAllOutputs = async () => {
    if (!window.scraper?.deleteAllOutputs) return
    if (!window.confirm(`Delete every folder inside "${runsRoot}"?`)) {
      return
    }
    setClearing(true)
    const res = await window.scraper.deleteAllOutputs()
    if (!res.ok) {
      setErrorMessage(res.error || 'Failed to delete all outputs')
    } else {
      setErrorMessage(null)
      resetLoadedOutputState(defaultOutDir)
      await refreshRuns()
    }
    setClearing(false)
  }

  const stopRun = async () => {
    if (!window.scraper) return
    if (stopRunPending) return
    if (!scraperActive) {
      setErrorMessage('No active scraper run is currently attached to the dashboard.')
      return
    }
    if (!window.confirm('Stop the current scrape run and keep partial results?')) return
    setStopRunPending(true)
    setLogs((prev) => [...prev, 'Stop requested'].slice(-50))
    const res = await window.scraper.stopRun()
    if (!res.ok) {
      setStopRunPending(false)
      if (res.error === 'not_running') {
        setErrorMessage(null)
        setLogs((prev) => [...prev, 'Scraper already stopped'].slice(-50))
        await refreshBridgeStatus()
        return
      }
      setErrorMessage(res.error || 'Failed to stop scraper')
      return
    }
    setLogs((prev) => [...prev, res.status === 'stopping' ? 'Stop already in progress' : 'Stop signal sent'].slice(-50))
  }

  const openLogWindow = async () => {
    if (!window.scraper) return
    const content = logs.length ? logs.join('\n') : 'No logs yet.'
    await window.scraper.openLogWindow(content, 'Run logs')
  }

  const formatBridgeScriptOutput = useCallback((title: string, result: BridgeScriptResult) => {
    return [
      title,
      '',
      result.command ? `Command: ${result.command}` : null,
      typeof result.code === 'number' ? `Exit code: ${result.code}` : null,
      result.signal ? `Signal: ${result.signal}` : null,
      typeof result.killed === 'boolean' ? `Killed: ${result.killed}` : null,
      result.hint ? `Hint: ${result.hint}` : null,
      result.error ? `Error: ${result.error}` : null,
      '',
      'STDOUT:',
      result.stdout?.trim() || '(empty)',
      '',
      'STDERR:',
      result.stderr?.trim() || '(empty)',
    ].filter(Boolean).join('\n')
  }, [])

  const diagnoseBridge = useCallback(async () => {
    if (!window.scraper?.diagnoseBridge || !window.scraper?.openLogWindow) return
    setBridgeActionBusy('diagnose')
    setBridgeActionMessage('Running bridge diagnostics...')
    const result = await window.scraper.diagnoseBridge()
    await window.scraper.openLogWindow(formatBridgeScriptOutput('Bridge diagnostics', result), 'Bridge diagnostics')
    setBridgeActionBusy(null)
    setBridgeActionMessage(
      result.ok
        ? 'Bridge diagnostics completed.'
        : result.hint || 'Bridge diagnostics found a problem. Review the diagnostics window.'
    )
    await refreshBridgeStatus()
  }, [formatBridgeScriptOutput, refreshBridgeStatus])

  const repairBridge = useCallback(async () => {
    if (!window.scraper?.repairBridge || !window.scraper?.openLogWindow) return
    setBridgeActionBusy('repair')
    setBridgeActionMessage('Repairing bridge tunnel...')
    const result = await window.scraper.repairBridge()
    if (!result.ok || !result.health_ok) {
      await window.scraper.openLogWindow(formatBridgeScriptOutput('Bridge repair', result), 'Bridge repair')
    }
    setBridgeActionBusy(null)
    setBridgeActionMessage(
      result.ok
        ? result.health_ok
          ? 'Bridge repaired and health probe is responding.'
          : result.hint || 'Tunnel reopened, but the orchestrator is still not answering.'
        : result.hint || 'Bridge repair failed. Review the bridge repair log.'
    )
    await refreshBridgeStatus()
  }, [formatBridgeScriptOutput, refreshBridgeStatus])

  const refreshRemote = useCallback(async () => {
    if (!window.scraper?.refreshRemote || !window.scraper?.openLogWindow) return
    setBridgeActionBusy('refresh')
    setBridgeActionMessage('Refreshing remote orchestrator...')
    const result = await window.scraper.refreshRemote()
    if (!result.ok) {
      await window.scraper.openLogWindow(formatBridgeScriptOutput('Remote refresh', result), 'Remote refresh')
    }
    setBridgeActionBusy(null)
    setBridgeActionMessage(
      result.ok
        ? 'Remote orchestrator refreshed. Re-checking bridge health...'
        : result.hint || 'Remote refresh failed. Review the remote refresh log.'
    )
    await refreshBridgeStatus()
  }, [formatBridgeScriptOutput, refreshBridgeStatus])

  const pageTitle = {
    launcher: 'Scraper Launcher',
    audit: 'Audit Workspace',
    results: 'Results',
    explorer: 'Explorer',
    annotations: 'Annotations',
    consistency: 'Consistency checker',
    database: 'Database',
    settings: 'Settings',
  }[activeNav]

  const pageSubtitle = {
    launcher: 'Minimal control surface for the dataset pipeline.',
    audit: 'Audit scraped sites, apply manual fixes, and rerun targeted tasks.',
    results: 'Outcome overview of the latest scrape.',
    explorer: 'Browse scraped sites and their policy links.',
    annotations: annotationsTab === 'viewer'
      ? 'Read annotated policy text with phrase-level highlights.'
      : 'LLM-extracted privacy statements from policy documents.',
    consistency: 'Compare first‑party and third‑party policy texts.',
    database: 'Artifact storage and dataset exports.',
    settings: 'Theme and default crawl preferences.',
  }[activeNav]

  return (
    <div className="min-h-screen">
      <Sidebar
        activeNav={activeNav}
        onSelect={handleSelectNav}
        disabledNavs={disabledNavs}
        bridgeStatus={tunnelStatus}
      />
      <PageShell title={pageTitle} subtitle={pageSubtitle}>
        {activeNav === 'launcher' && (
          <LauncherView
            topN={topN}
            onTopNChange={setTopN}
            onStart={startRun}
            onStop={stopRun}
            stopRunPending={stopRunPending}
            hasRun={hasRun}
            running={running}
            scraperActive={scraperActive}
            progress={progress}
            resultsReady={resultsMetrics.resultsReady}
            onViewResults={() => setActiveNav('results')}
            logs={logs}
            errorMessage={errorMessage || undefined}
            etaText={etaText}
            useCrux={useCrux}
            onToggleCrux={setUseCrux}
            cruxApiKey={cruxApiKey}
            onCruxKeyChange={setCruxApiKey}
            excludeSameEntity={excludeSameEntity}
            onToggleExcludeSameEntity={setExcludeSameEntity}
            mappingMode={mappingMode}
            onMappingModeChange={setMappingMode}
            onOpenLogWindow={openLogWindow}
            tunnelStatus={tunnelStatus}
            bridgeReady={bridgeReady}
            bridgeHeadline={bridgeHeadline}
            bridgeDetail={bridgeDetail}
            bridgeNode={backendStatus?.node}
            bridgeCurrentOutDir={backendStatus?.current_out_dir}
            bridgeCheckedAt={formatAgeLabel(bridgeCheckedAt)}
            bridgeHealthyAt={formatAgeLabel(bridgeHealthyAt)}
            bridgeFailures={bridgeFailures}
            bridgeActionBusy={bridgeActionBusy}
            bridgeActionMessage={bridgeActionMessage || undefined}
            onDiagnoseBridge={diagnoseBridge}
            onRepairBridge={repairBridge}
            onRefreshRemote={refreshRemote}
            remoteCodeOutdated={remoteCodeOutdated}
            workspaceReady={workspaceReady}
            llmModel={llmModel}
            latestStreamEvent={latestStreamEvent}
            annotateRunning={annotateRunning}
            annotateLogs={annotateLogs}
            annotationStats={annotationStats}
            onStartAnnotate={startAnnotate}
            onStopAnnotate={stopAnnotate}
            resumeMode={resumeMode}
            onToggleResumeMode={setResumeMode}
            activeSites={activeSites}
            recentCompleted={recentCompleted}
            primaryActionLabel={launcherActionLabel}
            primaryActionHint={launcherActionHint}
            primaryActionDisabled={cruxKeyMissing}
            topNLocked={datasetState.isIncomplete}
          />
        )}
        {activeNav === 'audit' && (
          <AuditWorkspaceView
            outDir={outDir}
            records={resultsData || []}
            verifiedSites={auditVerifiedSites}
            urlOverrides={auditUrlOverrides}
            running={running}
            busySite={auditBusySite}
            annotatingSite={auditAnnotatingSite}
            activeSites={activeSites}
            onReload={() => loadAuditWorkspace()}
            onMarkVerified={markAuditVerified}
            onSaveOverride={saveAuditOverride}
            onRerun={rerunAuditSite}
            onAnnotate={annotateAuditSite}
          />
        )}
        {activeNav === 'results' && (
          <ResultsView
            hasRun={hasRun}
            progress={progress}
            topN={topN}
            metrics={resultsMetrics}
            summary={summaryData}
            sites={explorerData || undefined}
            useCrux={useCrux}
            mappingMode={mappingMode}
            annotationStats={annotationStats}
          />
        )}
        {activeNav === 'explorer' && (
          <ExplorerView
            hasRun={hasRun}
            progress={progress}
            sites={explorerData || undefined}
            showExtractionMethod={showExtractionMethod}
            outDir={outDir}
          />
        )}
        {activeNav === 'annotations' && (
          <>
            {/* Tab switcher */}
            <section className="card rounded-2xl p-1">
              <div className="flex gap-1">
                {(
                  [
                    { id: 'overview', label: 'Overview' },
                    { id: 'viewer', label: 'Policy Viewer' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    className={`flex-1 rounded-xl px-4 py-2 text-xs transition ${
                      annotationsTab === tab.id
                        ? 'bg-[var(--color-primary)] text-white'
                        : 'text-[var(--muted-text)] hover:bg-black/20'
                    }`}
                    onClick={() => setAnnotationsTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </section>
            {annotationsTab === 'overview' && (
              <AnnotationsView annotationStats={annotationStats} outDir={outDir} />
            )}
            {annotationsTab === 'viewer' && (
              <PolicyViewerView
                sites={explorerData || undefined}
                annotationStats={annotationStats}
                outDir={outDir}
              />
            )}
          </>
        )}
        {activeNav === 'consistency' && (
          <ConsistencyCheckerView
            hasRun={hasRun}
            sites={explorerData || undefined}
            outDir={outDir}
            showExtractionMethod={showExtractionMethod}
            onSendToReasoning={() => {}}
          />
        )}
        {activeNav === 'database' && (
          <DatabaseView
            runsRoot={runsRoot}
            runs={runRecords}
            onRefreshRuns={() => refreshRuns()}
            onSelectRun={(dir) => loadOutDir(dir)}
            summary={summaryData}
            state={stateData}
            onClear={clearResults}
            clearing={clearing}
            outDir={outDir}
            onOutDirChange={setOutDir}
            onLoadOutDir={() => loadOutDir()}
            onDeleteOutDir={deleteOutDir}
            onDeleteAllOutputs={deleteAllOutputs}
            folderBytes={folderBytes}
            annotationStats={annotationStats}
            deleteEnabled={Boolean(outDir && outDir !== runsRoot && outDir.startsWith(`${runsRoot}/`))}
          />
        )}
        {activeNav === 'settings' && (
          <SettingsView
            theme={theme}
            onThemeChange={setTheme}
            showExtractionMethod={showExtractionMethod}
            onToggleShowExtractionMethod={setShowExtractionMethod}
            outDir={outDir || undefined}
            useCrux={useCrux}
            onToggleCrux={setUseCrux}
            cruxApiKey={cruxApiKey}
            onCruxKeyChange={setCruxApiKey}
            excludeSameEntity={excludeSameEntity}
            onToggleExcludeSameEntity={setExcludeSameEntity}
            mappingMode={mappingMode}
            onMappingModeChange={setMappingMode}
            autoAnnotate={autoAnnotate}
            onToggleAutoAnnotate={setAutoAnnotate}
            tunnelStatus={tunnelStatus}
            bridgeReady={bridgeReady}
            bridgeHeadline={bridgeHeadline}
            bridgeDetail={bridgeDetail}
            bridgeNode={backendStatus?.node}
            bridgeCurrentOutDir={backendStatus?.current_out_dir}
            bridgeCheckedAt={formatAgeLabel(bridgeCheckedAt)}
            bridgeHealthyAt={formatAgeLabel(bridgeHealthyAt)}
            bridgeFailures={bridgeFailures}
            bridgeActionBusy={bridgeActionBusy}
            bridgeActionMessage={bridgeActionMessage || undefined}
            onDiagnoseBridge={diagnoseBridge}
            onRepairBridge={repairBridge}
            onRefreshRemote={refreshRemote}
            remoteCodeOutdated={remoteCodeOutdated}
          />
        )}
      </PageShell>
    </div>
  )
}

export default App
