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
import type { ResultRecord } from './contracts/api'
import { applyAnnotationProgressEvent, annotationRunStateFromStats } from './lib/annotationRunState'
import { useOperationsController } from './lib/useOperationsController'
import {
  applyScraperRuntimeEvent,
  emptyScraperSiteActivityState,
  normalizeScraperExitEvent,
  normalizeScraperMessageEvent,
  normalizeScraperRuntimeEvent,
} from './lib/scraperRuntime'
import {
  hasScraperBridge,
  listRunRecords,
  readAnnotationStats,
  readFolderSize,
  readWorkspaceSnapshot,
  subscribeAnnotatorEvents,
  subscribePipelineEvents,
  subscribeScraperEvents,
} from './lib/scraperClient'
import { useBridgeStatus } from './lib/useBridgeStatus'
import { useRunController } from './lib/useRunController'
import { useWorkspaceController } from './lib/useWorkspaceController'
import { useWorkspaceData } from './lib/useWorkspaceData'
import { NavId, Theme } from './types'
import { computeResults } from './utils/results'

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

function resultSiteKey(record: ResultRecord): string {
  const candidate = record?.site_etld1 || record?.input || record?.site || ''
  return typeof candidate === 'string' ? normalizeSiteKey(candidate) : ''
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
  const [running, setRunning] = useState(false)
  const [scraperActivity, setScraperActivity] = useState(emptyScraperSiteActivityState())
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
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
  const [auditBusySite, setAuditBusySite] = useState<string | null>(null)
  const [auditAnnotatingSite, setAuditAnnotatingSite] = useState<string | null>(null)
  // Stage 2 — Annotation state
  const [bridgeActionBusy, setBridgeActionBusy] = useState<'diagnose' | 'repair' | 'refresh' | null>(null)
  const [bridgeActionMessage, setBridgeActionMessage] = useState<string | null>(null)
  const [stopRunPending, setStopRunPending] = useState(false)
  const [llmModel] = useState('openai/local')
  const [annotateRunning, setAnnotateRunning] = useState(false)
  const [annotateLogs, setAnnotateLogs] = useState<string[]>([])
  const [autoAnnotate, setAutoAnnotate] = useState(true)
  const [autoAnnotatePending, setAutoAnnotatePending] = useState(false)
  const [annotationsTab, setAnnotationsTab] = useState<'overview' | 'viewer'>('overview')
  const [latestStreamEvent, setLatestStreamEvent] = useState<import('./vite-env').AnnotatorStreamEvent | null>(null)
  const annotateLogsRef = useRef<string[]>([])
  const stopRunPendingRef = useRef(false)
  const prevTunnelStatusRef = useRef<string | null>(null)
  const defaultOutDir = `${runsRoot}/unified`
  const {
    workspaceData,
    resetWorkspaceData,
    applyWorkspaceSnapshot,
    updateWorkspaceData,
  } = useWorkspaceData()
  const {
    hasRun,
    progress,
    summaryData,
    explorerData,
    resultsData,
    stateData,
    runRecords,
    runManifest,
    folderBytes,
    annotationStats,
    annotationRunState,
    auditVerifiedSites,
    auditUrlOverrides,
  } = workspaceData
  const logs = scraperActivity.logs
  const activeSites = scraperActivity.activeSites
  const recentCompleted = scraperActivity.recentCompleted

  const resetLoadedOutputState = useCallback((nextOutDir?: string) => {
    resetWorkspaceData()
    setAuditBusySite(null)
    setAuditAnnotatingSite(null)
    setScraperActivity(emptyScraperSiteActivityState())
    setRunning(false)
    setStopRunPending(false)
    setRunStartedAt(null)
    setEtaText('')
    setAutoAnnotatePending(false)
    if (nextOutDir) {
      setOutDir(nextOutDir)
    }
  }, [resetWorkspaceData])

  const appendScraperLog = useCallback((message: string) => {
    setScraperActivity((prev) => ({
      ...prev,
      logs: [...prev.logs, message].slice(-50),
    }))
  }, [])

  const handleMissingOutputDir = useCallback(async (missingDir: string) => {
    const fallbackDir = defaultOutDir
    resetLoadedOutputState(missingDir === fallbackDir ? undefined : fallbackDir)
    if (outDir === missingDir) {
      setErrorMessage(`Output folder "${missingDir}" no longer exists. Hidden stale data and reset to ${fallbackDir}.`)
    }
    updateWorkspaceData({ runRecords: await listRunRecords(runsRoot) })
  }, [defaultOutDir, outDir, resetLoadedOutputState, runsRoot, updateWorkspaceData])
  const {
    refreshRuns,
    syncLoadedRunState,
    loadAuditWorkspace,
    loadOutDir,
    persistAuditState,
  } = useWorkspaceController({
    outDir,
    runsRoot,
    running,
    handleMissingOutputDir,
    applyWorkspaceSnapshot,
    updateWorkspaceData,
    setOutDir,
    setTopN,
  })

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
      manifestMode: runManifest?.mode,
      manifestTopN: Number(runManifest?.topN || 0) || null,
      manifestTrancoDate: typeof runManifest?.trancoDate === 'string' ? runManifest.trancoDate : undefined,
      manifestCruxFilter: typeof runManifest?.cruxFilter === 'boolean' ? runManifest.cruxFilter : undefined,
    }
  }, [summaryData, stateData, resultsData, runManifest])
  const localScraperActive = running || stopRunPending
  const workspaceReady = running || hasRun || datasetState.hasDataset
  const {
    tunnelStatus,
    backendStatus,
    bridgeFailures,
    bridgeCheckedAt,
    bridgeHealthyAt,
    dashboardLocked,
    bridgeReady,
    remoteCodeLegacy,
    remoteCodeOutdated,
    bridgeHeadline,
    bridgeDetail,
    refreshBridgeStatus,
  } = useBridgeStatus({
    workspaceReady,
    scraperActive: localScraperActive,
  })
  const scraperActive = localScraperActive || Boolean(backendStatus?.active_run || backendStatus?.running)
  const workspaceUnlocked = bridgeReady && workspaceReady

  useEffect(() => {
    if (dashboardLocked && activeNav !== 'launcher') {
      setActiveNav('launcher')
    }
  }, [dashboardLocked, activeNav])
  const disabledNavs = {
    launcher: false,
    settings: false,
    database: !bridgeReady,
    results: !workspaceUnlocked,
    audit: !workspaceUnlocked,
    explorer: !workspaceUnlocked,
    annotations: !workspaceUnlocked,
    consistency: !workspaceUnlocked,
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
  const {
    markAuditVerified,
    saveAuditOverride,
    rerunAuditSite,
    annotateAuditSite,
    startAnnotate,
    stopAnnotate,
    startRun,
  } = useRunController({
    outDir,
    runsRoot,
    topN,
    resumeMode,
    useCrux,
    cruxApiKey,
    excludeSameEntity,
    mappingMode,
    llmModel,
    scraperActive,
    dashboardLocked,
    cruxKeyMissing,
    launcherMode,
    currentTargetTotal,
    requestedTargetTotal,
    launchStartingProgress,
    datasetState,
    auditVerifiedSites,
    auditUrlOverrides,
    annotationStatsTotalSites: annotationStats?.total_sites ?? 0,
    remoteCodeOutdated,
    remoteCodeLegacy,
    backendStatus,
    persistAuditState,
    refreshBridgeStatus,
    updateWorkspaceData,
    setOutDir,
    setRunning,
    setRunStartedAt,
    setEtaText,
    setErrorMessage,
    setScraperActivity,
    setAuditBusySite,
    setAuditAnnotatingSite,
    setAnnotateLogs,
    setAnnotateRunning,
    annotateLogsRef,
  })
  const {
    clearResults,
    deleteOutDir,
    deleteAllOutputs,
    stopRun,
    openLogWindow,
    diagnoseBridge,
    repairBridge,
    refreshRemote,
  } = useOperationsController({
    defaultOutDir,
    outDir,
    runsRoot,
    logs,
    scraperActive,
    stopRunPending,
    refreshRuns,
    refreshBridgeStatus,
    resetLoadedOutputState,
    appendScraperLog,
    setClearing,
    setErrorMessage,
    setStopRunPending,
    setBridgeActionBusy,
    setBridgeActionMessage,
  })
  useEffect(() => {
    const unsubscribeScraper = subscribeScraperEvents({
      onEvent: (rawEvent) => {
        const event = normalizeScraperRuntimeEvent(rawEvent)
        if (!event) return
        if (event.type === 'run_started') {
          updateWorkspaceData({ hasRun: true })
          setRunning(true)
          setAutoAnnotatePending(false)
          updateWorkspaceData({ progress: launchStartingProgress })
          setErrorMessage(null)
          setRunStartedAt(Date.now())
          setEtaText('')
          setScraperActivity(emptyScraperSiteActivityState())
        }
        if (event.type === 'run_progress') {
          const processed = Number(event.processed || 0)
          const total = Number(event.total || 0)
          if (total > 0) {
            updateWorkspaceData({ progress: Math.min(100, (processed / total) * 100) })
          }
        }
        if (event.type === 'site_started' || event.type === 'site_stage' || event.type === 'site_finished') {
          setScraperActivity((prev) => applyScraperRuntimeEvent(prev, event, SITE_STAGE_LABELS))
          if (event.type === 'site_finished') {
            setAuditBusySite((current) => (current === event.site ? null : current))
          }
        }
        if (event.type === 'run_completed') {
          setStopRunPending(false)
          setRunning(false)
          setAutoAnnotatePending(autoAnnotate)
          updateWorkspaceData({ progress: 100 })
          setEtaText('0s')
          setAuditBusySite(null)
          setScraperActivity((prev) => ({ ...prev, activeSites: {} }))
          void syncLoadedRunState(outDir)
          refreshRuns()
        }
      },
      onLog: (rawEvent) => {
        const event = normalizeScraperMessageEvent(rawEvent)
        if (event?.message) {
          appendScraperLog(event.message)
        }
      },
      onError: (rawEvent) => {
        const event = normalizeScraperMessageEvent(rawEvent)
        if (event?.message) {
          setErrorMessage(event.message)
          appendScraperLog(`ERROR: ${event.message}`)
        }
        setRunning(false)
        setAutoAnnotatePending(false)
        setStopRunPending(false)
        setAuditBusySite(null)
        void syncLoadedRunState(outDir)
      },
      onExit: (rawEvent) => {
        const evt = normalizeScraperExitEvent(rawEvent)
        const code = Number(evt.code ?? 0)
        const signal = evt.signal ? String(evt.signal) : null
        const requested = Boolean(evt.stop_requested) || stopRunPendingRef.current
        if (code !== 0 && !requested) {
          setErrorMessage(`Scraper exited with code ${code}${signal ? ` (${signal})` : ''}`)
        } else if (requested) {
          appendScraperLog(`Scraper stopped${signal ? ` (${signal})` : ''}`)
          setErrorMessage(null)
        }
        setRunning(false)
        setAutoAnnotatePending(false)
        setStopRunPending(false)
        setAuditBusySite(null)
        void syncLoadedRunState(outDir)
      },
    })

    const unsubscribeAnnotator = subscribeAnnotatorEvents({
      onLog: (evt) => {
        const raw = evt?.message ? String(evt.message).trimEnd() : String(evt)
        const lines = raw.split('\n').map((l: string) => l.trimEnd()).filter(Boolean)
        if (lines.length) {
          annotateLogsRef.current = [...annotateLogsRef.current, ...lines]
          setAnnotateLogs((prev) => [...prev.slice(-(200 - lines.length)), ...lines])
        }
      },
      onStream: (evt) => {
        setLatestStreamEvent(evt)
      },
      onExit: (evt) => {
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
        void readAnnotationStats(`${outDir}/artifacts`).then((res) => {
          if (res?.ok) {
            updateWorkspaceData({
              annotationStats: res,
              annotationRunState: annotationRunStateFromStats(res),
            })
          }
        })
      },
    })

    const unsubscribePipeline = subscribePipelineEvents((evt) => {
      updateWorkspaceData((prev) => ({
        ...prev,
        annotationRunState: applyAnnotationProgressEvent(prev.annotationRunState, evt),
      }))
    })

    return () => {
      unsubscribeScraper?.()
      unsubscribeAnnotator?.()
      unsubscribePipeline?.()
    }
  }, [appendScraperLog, autoAnnotate, launchStartingProgress, outDir, refreshRuns, syncLoadedRunState, updateWorkspaceData])

  useEffect(() => { stopRunPendingRef.current = stopRunPending }, [stopRunPending])

  useEffect(() => {
    if (!running) return
    if (!hasScraperBridge()) {
      const timer = setInterval(() => {
        updateWorkspaceData((prev) => ({ ...prev, progress: Math.min(100, prev.progress + 4 + Math.random() * 6) }))
      }, 520)
      return () => clearInterval(timer)
    }
  }, [running, updateWorkspaceData])

  useEffect(() => {
    if (!running) return
    if (hasScraperBridge()) return
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
    if (!hasScraperBridge() || !hasRun) return
    const interval = setInterval(async () => {
      try {
        const needsExplorerData =
          activeNav === 'results'
          || activeNav === 'explorer'
          || activeNav === 'annotations'
          || activeNav === 'consistency'
        const snapshot = await readWorkspaceSnapshot({
          outDir,
          includeFolderSize: true,
          includeExplorer: needsExplorerData,
          includeResults: activeNav === 'audit',
          includeAudit: activeNav === 'audit',
          includeAnnotation: annotateRunning || activeNav === 'annotations',
        })
        if (snapshot.missingOutputDir) {
          await handleMissingOutputDir(outDir)
          return
        }
        applyWorkspaceSnapshot(snapshot, {
          preserveRunning: true,
          mergeHasRun: true,
          mergeProgress: running,
        })
        if (!runStartedAt && snapshot.processedSites) {
          setRunStartedAt(Date.now())
        }
      } catch (error) {
        setErrorMessage(String(error))
      }
    }, 2000)
    return () => clearInterval(interval)
  }, [activeNav, annotateRunning, applyWorkspaceSnapshot, handleMissingOutputDir, hasRun, outDir, runStartedAt, running])

  useEffect(() => {
    if (!hasScraperBridge() || activeNav !== 'database') return

    let cancelled = false
    const refreshSize = async () => {
      const size = await readFolderSize(outDir)
      if (!cancelled && size.ok && typeof size.bytes === 'number') {
        updateWorkspaceData({ folderBytes: size.bytes })
      } else if (!cancelled && size.error === 'not_found') {
        updateWorkspaceData({ folderBytes: null })
        await handleMissingOutputDir(outDir)
      }
    }

    void refreshSize()
    const interval = setInterval(refreshSize, 15_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [activeNav, outDir, handleMissingOutputDir, updateWorkspaceData])

  useEffect(() => {
    if (!autoAnnotatePending || running || !hasRun || annotateRunning) return
    setAutoAnnotatePending(false)
    void startAnnotate({})
  }, [autoAnnotatePending, running, hasRun, annotateRunning, startAnnotate])

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

  // Re-seed workspace and annotation state when the bridge transitions from
  // offline/degraded to online. This ensures the UI reflects the remote state
  // immediately after reconnect without waiting for the next polling cycle.
  useEffect(() => {
    const prev = prevTunnelStatusRef.current
    prevTunnelStatusRef.current = tunnelStatus
    if (prev !== null && prev !== 'online' && tunnelStatus === 'online' && hasRun && outDir) {
      void syncLoadedRunState(outDir)
      void readAnnotationStats(`${outDir}/artifacts`).then((res) => {
        if (res) updateWorkspaceData({ annotationRunState: annotationRunStateFromStats(res) })
      })
    }
  }, [tunnelStatus, hasRun, outDir, syncLoadedRunState, updateWorkspaceData])

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
            annotationRunState={annotationRunState}
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
