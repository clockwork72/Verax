import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import type { RunState, TunnelStatus } from '../contracts/api'
import type { NavId } from '../types'
import type { AnnotatorStreamEvent } from '../vite-env'
import { applyAnnotationProgressEvent, annotationRunStateFromStats } from './annotationRunState'
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
          setRunStartedAt(Date.now())
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
    const effectiveProgress = (
      stateData?.total_sites && stateData?.processed_sites
        ? (stateData.processed_sites / Math.max(1, stateData.total_sites)) * 100
        : progress
    )
    if (effectiveProgress <= 0) return
    const elapsedMs = Date.now() - runStartedAt
    const totalMs = elapsedMs / (effectiveProgress / 100)
    const remainingMs = Math.max(0, totalMs - elapsedMs)
    setEtaText(formatDuration(remainingMs))
  }, [progress, runStartedAt, running, setEtaText, stateData])

  useEffect(() => {
    if (!hasScraperBridge() || !hasRun) return
    const interval = setInterval(async () => {
      try {
        const needsExplorerData = (
          activeNav === 'results'
          || activeNav === 'explorer'
          || activeNav === 'annotations'
          || activeNav === 'consistency'
        )
        const needsResultsData = (
          running
          || activeNav === 'results'
          || activeNav === 'explorer'
          || activeNav === 'annotations'
          || activeNav === 'consistency'
          || activeNav === 'audit'
        )
        const snapshot = await readWorkspaceSnapshot({
          outDir,
          includeFolderSize: true,
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
          setRunStartedAt(Date.now())
        }
      } catch (error) {
        setErrorMessage(String(error))
      }
    }, 2000)
    return () => clearInterval(interval)
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
    const interval = setInterval(() => {
      void refreshRuns()
    }, 15_000)
    return () => clearInterval(interval)
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
