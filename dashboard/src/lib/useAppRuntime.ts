import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import type { RunState, RunSummary, TunnelStatus } from '../contracts/api'
import type { NavId } from '../types'
import type { AnnotatorStreamEvent } from '../vite-env'
import { applyAnnotationProgressEvent, annotationRunStateFromStats } from './annotationRunState'
import {
  estimateRemainingMs,
  formatEtaDuration,
  parseEtaTimestamp,
  recordEtaProgress,
  type EtaProgressSample,
} from './runEta'
import {
  hasScraperBridge,
  readAnnotationStats,
  readFolderSize,
  readWorkspaceSnapshot,
  subscribeScraperActivitySnapshots,
  subscribeAnnotatorEvents,
  subscribePipelineEvents,
  subscribeScraperEvents,
  type WorkspaceSnapshot,
} from './scraperClient'
import {
  applyScraperActivitySnapshot,
  applyScraperRuntimeEvent,
  emptyScraperSiteActivityState,
  normalizeScraperExitEvent,
  normalizeScraperMessageEvent,
  normalizeScraperRuntimeEvent,
  type ScraperSiteActivityState,
} from './scraperRuntime'
import type { ApplyWorkspaceSnapshotOptions, WorkspaceDataUpdate } from './useWorkspaceData'

const SITE_STAGE_LABELS: Record<string, { label: string; index: number }> = {
  home_fetch:               { label: 'Home fetch',       index: 0 },
  policy_discovery:         { label: 'Policy discovery', index: 1 },
  third_party_extract:      { label: '3P extraction',    index: 2 },
  third_party_policy_fetch: { label: '3P policies',      index: 3 },
}

type UseAppRuntimeArgs = {
  activeNav: NavId
  annotateRunning: boolean
  autoAnnotate: boolean
  autoAnnotatePending: boolean
  hasRun: boolean
  outDir: string
  progress: number
  running: boolean
  runStartedAt: number | null
  stateData: RunState | null
  summaryData: RunSummary | null
  stopRunPending: boolean
  tunnelStatus: TunnelStatus
  launchStartingProgress: number
  handleMissingOutputDir: (missingDir: string) => Promise<void>
  refreshRuns: () => Promise<void>
  syncLoadedRunState: (targetDir?: string) => Promise<void>
  loadAuditWorkspace: (dirOverride?: string) => Promise<void>
  startAnnotate: (opts: { llmModel?: string; concurrency?: number; force?: boolean }) => Promise<void>
  applyWorkspaceSnapshot: (snapshot: WorkspaceSnapshot, options?: ApplyWorkspaceSnapshotOptions) => void
  updateWorkspaceData: (updater: WorkspaceDataUpdate) => void
  appendScraperLog: (message: string) => void
  annotateLogsRef: MutableRefObject<string[]>
  setAutoAnnotatePending: (value: boolean) => void
  setAuditBusySite: (value: string | null | ((current: string | null) => string | null)) => void
  setAuditAnnotatingSite: (value: string | null) => void
  setAnnotateLogs: Dispatch<SetStateAction<string[]>>
  setAnnotateRunning: (value: boolean) => void
  setErrorMessage: (value: string | null) => void
  setEtaText: (value: string) => void
  setRunStartedAt: (value: number | null) => void
  setRunning: (value: boolean) => void
  setScraperActivity: Dispatch<SetStateAction<ScraperSiteActivityState>>
  setStopRunPending: (value: boolean) => void
}

export function useAppRuntime({
  activeNav,
  annotateRunning,
  autoAnnotate,
  autoAnnotatePending,
  hasRun,
  outDir,
  progress,
  running,
  runStartedAt,
  stateData,
  summaryData,
  stopRunPending,
  tunnelStatus,
  launchStartingProgress,
  handleMissingOutputDir,
  refreshRuns,
  syncLoadedRunState,
  loadAuditWorkspace,
  startAnnotate,
  applyWorkspaceSnapshot,
  updateWorkspaceData,
  appendScraperLog,
  annotateLogsRef,
  setAutoAnnotatePending,
  setAuditBusySite,
  setAuditAnnotatingSite,
  setAnnotateLogs,
  setAnnotateRunning,
  setErrorMessage,
  setEtaText,
  setRunStartedAt,
  setRunning,
  setScraperActivity,
  setStopRunPending,
}: UseAppRuntimeArgs) {
  const [latestStreamEvent, setLatestStreamEvent] = useState<AnnotatorStreamEvent | null>(null)
  const stopRunPendingRef = useRef(false)
  const prevTunnelStatusRef = useRef<TunnelStatus | null>(null)
  const etaSamplesRef = useRef<EtaProgressSample[]>([])

  const pushEtaSample = (processedSites: number, totalSites: number, timestampMs: number | null) => {
    if (!timestampMs || totalSites <= 0) return
    etaSamplesRef.current = recordEtaProgress(etaSamplesRef.current, {
      processedSites,
      totalSites,
      timestampMs,
    })
  }

  useEffect(() => {
    const unsubscribeScraper = subscribeScraperEvents({
      onEvent: (rawEvent) => {
        const event = normalizeScraperRuntimeEvent(rawEvent)
        if (!event) return
        if (event.type === 'run_started') {
          const startedAtMs = parseEtaTimestamp(event.timestamp) ?? Date.now()
          updateWorkspaceData({ hasRun: true })
          setRunning(true)
          setAutoAnnotatePending(false)
          updateWorkspaceData({ progress: launchStartingProgress })
          setErrorMessage(null)
          setRunStartedAt(startedAtMs)
          setEtaText('')
          etaSamplesRef.current = []
          pushEtaSample(0, Number(event.total_sites || 0), startedAtMs)
          setScraperActivity(emptyScraperSiteActivityState())
        }
        if (event.type === 'run_progress') {
          const processed = Number(event.processed || 0)
          const total = Number(event.total || 0)
          if (total > 0) {
            updateWorkspaceData({ progress: Math.min(100, (processed / total) * 100) })
            pushEtaSample(processed, total, parseEtaTimestamp(event.timestamp) ?? Date.now())
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
          etaSamplesRef.current = []
          setAuditBusySite(null)
          setScraperActivity((prev) => ({ ...prev, activeSites: {} }))
          void syncLoadedRunState(outDir)
          void refreshRuns()
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
        etaSamplesRef.current = []
        setAuditBusySite(null)
        setScraperActivity((prev) => ({ ...prev, activeSites: {} }))
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
        etaSamplesRef.current = []
        setAuditBusySite(null)
        setScraperActivity((prev) => ({ ...prev, activeSites: {} }))
        void syncLoadedRunState(outDir)
      },
    })

    const unsubscribeScraperActivity = subscribeScraperActivitySnapshots((snapshot) => {
      setScraperActivity((prev) => applyScraperActivitySnapshot(prev, snapshot))
      setRunning(snapshot.running)
      if (snapshot.running) {
        updateWorkspaceData({ hasRun: true })
        if (!runStartedAt) {
          setRunStartedAt(
            parseEtaTimestamp(summaryData?.started_at)
            ?? parseEtaTimestamp(stateData?.started_at)
            ?? Date.now(),
          )
        }
      }
    })

    const unsubscribeAnnotator = subscribeAnnotatorEvents({
      onLog: (evt) => {
        const raw = evt?.message ? String(evt.message).trimEnd() : String(evt)
        const lines = raw.split('\n').map((line: string) => line.trimEnd()).filter(Boolean)
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
      unsubscribeScraperActivity?.()
      unsubscribeAnnotator?.()
      unsubscribePipeline?.()
    }
  }, [
    annotateLogsRef,
    appendScraperLog,
    autoAnnotate,
    launchStartingProgress,
    outDir,
    refreshRuns,
    runStartedAt,
    stateData?.started_at,
    summaryData?.started_at,
    setAnnotateLogs,
    setAnnotateRunning,
    setAuditAnnotatingSite,
    setAutoAnnotatePending,
    setAuditBusySite,
    setErrorMessage,
    setEtaText,
    setRunStartedAt,
    setRunning,
    setScraperActivity,
    setStopRunPending,
    syncLoadedRunState,
    updateWorkspaceData,
  ])

  useEffect(() => {
    stopRunPendingRef.current = stopRunPending
  }, [stopRunPending])

  useEffect(() => {
    if (!running || hasScraperBridge()) return
    const timer = setInterval(() => {
      updateWorkspaceData((prev) => ({ ...prev, progress: Math.min(100, prev.progress + 4 + Math.random() * 6) }))
    }, 520)
    return () => clearInterval(timer)
  }, [running, updateWorkspaceData])

  useEffect(() => {
    if (!running || hasScraperBridge()) return
    if (progress >= 100) {
      setRunning(false)
    }
  }, [progress, running, setRunning])

  useEffect(() => {
    if (!running || !runStartedAt || progress <= 0) {
      if (!running) setEtaText('')
      return
    }
    const totalSites = Number(summaryData?.total_sites ?? stateData?.total_sites ?? 0)
    const processedSites = Number(summaryData?.processed_sites ?? stateData?.processed_sites ?? 0)
    if (totalSites <= 0) {
      setEtaText('')
      return
    }
    const startedAtMs = (
      parseEtaTimestamp(summaryData?.started_at)
      ?? parseEtaTimestamp(stateData?.started_at)
      ?? runStartedAt
    )
    const remainingMs = estimateRemainingMs({
      processedSites,
      totalSites,
      samples: etaSamplesRef.current,
      startedAtMs,
      nowMs: Date.now(),
    })
    setEtaText(remainingMs === null ? '' : formatEtaDuration(remainingMs))
  }, [progress, runStartedAt, running, setEtaText, stateData, summaryData])

  useEffect(() => {
    if (!running) return
    const totalSites = Number(summaryData?.total_sites ?? stateData?.total_sites ?? 0)
    if (totalSites <= 0) return
    const processedSites = Number(summaryData?.processed_sites ?? stateData?.processed_sites ?? 0)
    const timestampMs = (
      parseEtaTimestamp(summaryData?.updated_at)
      ?? parseEtaTimestamp(stateData?.updated_at)
      ?? Date.now()
    )
    pushEtaSample(processedSites, totalSites, timestampMs)
  }, [
    running,
    stateData?.processed_sites,
    stateData?.total_sites,
    stateData?.updated_at,
    summaryData?.processed_sites,
    summaryData?.total_sites,
    summaryData?.updated_at,
  ])

  useEffect(() => {
    if (!running || runStartedAt) return
    const startedAtMs = (
      parseEtaTimestamp(summaryData?.started_at)
      ?? parseEtaTimestamp(stateData?.started_at)
      ?? null
    )
    if (startedAtMs) {
      setRunStartedAt(startedAtMs)
    }
  }, [runStartedAt, running, setRunStartedAt, stateData?.started_at, summaryData?.started_at])

  useEffect(() => {
    if (!hasScraperBridge() || !hasRun) return
    let inFlight = false
    const refreshSnapshot = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const needsExplorerData = (
          activeNav === 'results'
          || activeNav === 'explorer'
          || activeNav === 'annotations'
          || activeNav === 'consistency'
        )
        const needsResultsData = (
          activeNav === 'results'
          || activeNav === 'audit'
        )
        const snapshot = await readWorkspaceSnapshot({
          outDir,
          includeFolderSize: false,
          includeExplorer: needsExplorerData,
          includeResults: needsResultsData,
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
          setRunStartedAt(
            parseEtaTimestamp(snapshot.summary?.started_at)
            ?? parseEtaTimestamp(snapshot.state?.started_at)
            ?? Date.now(),
          )
        }
      } catch (error) {
        setErrorMessage(String(error))
      } finally {
        inFlight = false
      }
    }
    void refreshSnapshot()
    const interval = setInterval(() => { void refreshSnapshot() }, 2000)
    return () => {
      inFlight = false
      clearInterval(interval)
    }
  }, [
    activeNav,
    annotateRunning,
    applyWorkspaceSnapshot,
    handleMissingOutputDir,
    hasRun,
    outDir,
    runStartedAt,
    running,
    setErrorMessage,
    setRunStartedAt,
  ])

  useEffect(() => {
    if (!hasScraperBridge() || activeNav !== 'database') return

    let cancelled = false
    let inFlight = false
    const refreshSize = async () => {
      if (inFlight) return
      inFlight = true
      const size = await readFolderSize(outDir)
      try {
        if (!cancelled && size.ok && typeof size.bytes === 'number') {
          updateWorkspaceData({ folderBytes: size.bytes })
        } else if (!cancelled && size.error === 'not_found') {
          updateWorkspaceData({ folderBytes: null })
          await handleMissingOutputDir(outDir)
        }
      } finally {
        inFlight = false
      }
    }

    void refreshSize()
    const interval = setInterval(refreshSize, 15_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [activeNav, handleMissingOutputDir, outDir, updateWorkspaceData])

  useEffect(() => {
    if (!autoAnnotatePending || running || !hasRun || annotateRunning) return
    setAutoAnnotatePending(false)
    void startAnnotate({})
  }, [annotateRunning, autoAnnotatePending, hasRun, running, setAutoAnnotatePending, startAnnotate])

  useEffect(() => {
    if (activeNav !== 'database') return
    void refreshRuns()
  }, [activeNav, refreshRuns])

  useEffect(() => {
    if (activeNav !== 'database') return
    let inFlight = false
    const refresh = async () => {
      if (inFlight) return
      inFlight = true
      try {
        await refreshRuns()
      } finally {
        inFlight = false
      }
    }
    const interval = setInterval(() => {
      void refresh()
    }, 15_000)
    return () => {
      inFlight = false
      clearInterval(interval)
    }
  }, [activeNav, refreshRuns])

  useEffect(() => {
    if (activeNav !== 'audit') return
    void loadAuditWorkspace()
  }, [activeNav, loadAuditWorkspace])

  useEffect(() => {
    const previousTunnelStatus = prevTunnelStatusRef.current
    prevTunnelStatusRef.current = tunnelStatus
    if (previousTunnelStatus !== null && previousTunnelStatus !== 'online' && tunnelStatus === 'online' && hasRun && outDir) {
      void syncLoadedRunState(outDir)
      void readAnnotationStats(`${outDir}/artifacts`).then((res) => {
        if (res) {
          updateWorkspaceData({
            annotationStats: res,
            annotationRunState: annotationRunStateFromStats(res),
          })
        }
      })
    }
  }, [hasRun, outDir, syncLoadedRunState, tunnelStatus, updateWorkspaceData])

  return {
    latestStreamEvent,
  }
}
