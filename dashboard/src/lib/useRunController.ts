import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import type { HpcBridgeStatus } from '../contracts/api'
import { emptyAnnotationRunState } from './annotationRunState'
import { emptyScraperSiteActivityState, type ScraperSiteActivityState } from './scraperRuntime'
import {
  readRunManifest,
  requestAnnotateSite,
  requestRerunSite,
  requestStartAnnotate,
  requestStartRun,
  requestStopAnnotate,
} from './scraperClient'
import type { WorkspaceDataUpdate } from './useWorkspaceData'

export type LauncherMode = 'start' | 'continue' | 'extend'

export type RunDatasetState = {
  isIncomplete: boolean
  manifestMode?: string
  pendingManifestSites: string[]
  totalSites: number
  processedSites: number
  uniqueSiteCount: number
  lastSuccessfulRank: number | null
  manifestTopN: number | null
}

type StartRunOptions = Parameters<NonNullable<Window['scraper']>['startRun']>[0]

type UseRunControllerArgs = {
  outDir: string
  runsRoot: string
  topN: string
  resumeMode: boolean
  excludeSameEntity: boolean
  mappingMode: 'radar' | 'trackerdb' | 'mixed'
  llmModel: string
  scraperActive: boolean
  dashboardLocked: boolean
  launcherMode: LauncherMode
  currentTargetTotal: number
  requestedTargetTotal: number
  launchStartingProgress: number
  datasetState: RunDatasetState
  auditVerifiedSites: string[]
  auditUrlOverrides: Record<string, string>
  annotationStatsTotalSites: number
  remoteCodeOutdated: boolean
  remoteCodeLegacy: boolean
  backendStatus: HpcBridgeStatus | null
  persistAuditState: (nextVerifiedSites: string[], nextUrlOverrides: Record<string, string>, dirOverride?: string) => Promise<void>
  refreshBridgeStatus: () => Promise<void>
  updateWorkspaceData: (updater: WorkspaceDataUpdate) => void
  setOutDir: (value: string) => void
  setRunning: (value: boolean) => void
  setRunStartedAt: (value: number | null) => void
  setEtaText: (value: string) => void
  setErrorMessage: (value: string | null) => void
  setScraperActivity: Dispatch<SetStateAction<ScraperSiteActivityState>>
  setAuditBusySite: (value: string | null) => void
  setAuditAnnotatingSite: (value: string | null) => void
  setAnnotateLogs: Dispatch<SetStateAction<string[]>>
  setAnnotateRunning: (value: boolean) => void
  annotateLogsRef: MutableRefObject<string[]>
}

type BuildStartRunPlanArgs = {
  scraperActive: boolean
  dashboardLocked: boolean
  launcherMode: LauncherMode
  topN: string
  currentTargetTotal: number
  requestedTargetTotal: number
  mappingMode: 'radar' | 'trackerdb' | 'mixed'
  runsRoot: string
  resumeMode: boolean
  outDir: string
  datasetState: RunDatasetState
  excludeSameEntity: boolean
}

export type StartRunPlan = {
  blocked: boolean
  errorMessage: string | null
  resetWorkspace: boolean
  runOutDir: string | null
  startOptions: StartRunOptions | null
}

export type AnnotationBlock = {
  message: string
  error: string
}

function normalizeSiteKey(value: string): string {
  return value.trim().toLowerCase()
}

function createRunId() {
  try {
    return crypto.randomUUID()
  } catch {
    return `run_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
  }
}

export function buildAnnotationBlock({
  remoteCodeOutdated,
  remoteCodeLegacy,
  backendStatus,
}: {
  remoteCodeOutdated: boolean
  remoteCodeLegacy: boolean
  backendStatus: Pick<HpcBridgeStatus, 'source_rev' | 'local_source_rev'> | null
}): AnnotationBlock | null {
  if (!remoteCodeOutdated) return null
  if (remoteCodeLegacy) {
    return {
      message: 'Annotation blocked: the connected remote orchestrator is older than the current local code. Run hpc/scraper/launch_remote.sh and reconnect.',
      error: 'Remote orchestrator is outdated. Relaunch it with hpc/scraper/launch_remote.sh before annotating.',
    }
  }
  return {
    message: `Annotation blocked: remote orchestrator revision ${backendStatus?.source_rev} does not match local revision ${backendStatus?.local_source_rev}. Run hpc/scraper/launch_remote.sh and reconnect.`,
    error: `Remote orchestrator revision ${backendStatus?.source_rev} does not match local revision ${backendStatus?.local_source_rev}. Relaunch it before annotating.`,
  }
}

export function buildStartRunPlan({
  scraperActive,
  dashboardLocked,
  launcherMode,
  topN,
  currentTargetTotal,
  requestedTargetTotal,
  mappingMode,
  runsRoot,
  resumeMode,
  outDir,
  datasetState,
  excludeSameEntity,
}: BuildStartRunPlanArgs): StartRunPlan {
  if (scraperActive) {
    return {
      blocked: true,
      errorMessage: null,
      resetWorkspace: false,
      runOutDir: null,
      startOptions: null,
    }
  }
  if (dashboardLocked) {
    return {
      blocked: true,
      errorMessage: 'Cluster bridge is offline. Start the remote orchestrator and port 8910 tunnel first.',
      resetWorkspace: false,
      runOutDir: null,
      startOptions: null,
    }
  }
  if (launcherMode === 'start' && (!topN || Number(topN) <= 0)) {
    return {
      blocked: true,
      errorMessage: null,
      resetWorkspace: false,
      runOutDir: null,
      startOptions: null,
    }
  }
  if (launcherMode === 'extend' && requestedTargetTotal <= currentTargetTotal) {
    return {
      blocked: true,
      errorMessage: `Enter a target total higher than the current ${currentTargetTotal} sites to continue this dataset.`,
      resetWorkspace: false,
      runOutDir: null,
      startOptions: null,
    }
  }

  const trackerRadarIndex = mappingMode === 'trackerdb' ? undefined : 'tracker_radar_index.json'
  const trackerDbIndex = mappingMode === 'radar' ? undefined : 'trackerdb_index.json'
  const runId = createRunId()
  const freshOutDir = resumeMode ? `${runsRoot}/unified` : `${runsRoot}/output_${runId}`
  const remainingSiteCount = Math.max(0, datasetState.totalSites - datasetState.processedSites)
  let runOutDir = freshOutDir
  let startOptions: StartRunOptions = {
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
        topN: remainingSiteCount || datasetState.manifestTopN || datasetState.totalSites,
        outDir: runOutDir,
        artifactsDir: `${runOutDir}/artifacts`,
        runId,
        resumeAfterRank: datasetState.lastSuccessfulRank ?? undefined,
        expectedTotalSites: datasetState.totalSites,
        upsertBySite: true,
      }
    }
  } else if (launcherMode === 'extend') {
    runOutDir = outDir
    startOptions = {
      ...startOptions,
      topN: Math.max(0, requestedTargetTotal - currentTargetTotal),
      outDir: runOutDir,
      artifactsDir: `${runOutDir}/artifacts`,
      runId,
      resumeAfterRank: datasetState.lastSuccessfulRank ?? undefined,
      expectedTotalSites: requestedTargetTotal,
      upsertBySite: true,
    }
  } else {
    startOptions = {
      ...startOptions,
      topN: Number(topN),
      outDir: freshOutDir,
      artifactsDir: `${freshOutDir}/artifacts`,
      runId: resumeMode ? undefined : runId,
      expectedTotalSites: Number(topN),
    }
  }

  return {
    blocked: false,
    errorMessage: null,
    resetWorkspace: launcherMode === 'start' && !resumeMode,
    runOutDir,
    startOptions,
  }
}

export function useRunController({
  outDir,
  runsRoot,
  topN,
  resumeMode,
  excludeSameEntity,
  mappingMode,
  llmModel,
  scraperActive,
  dashboardLocked,
  launcherMode,
  currentTargetTotal,
  requestedTargetTotal,
  launchStartingProgress,
  datasetState,
  auditVerifiedSites,
  auditUrlOverrides,
  annotationStatsTotalSites,
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
}: UseRunControllerArgs) {
  const markAuditVerified = useCallback(async (site: string) => {
    const siteKey = normalizeSiteKey(site)
    const next = Array.from(new Set([...auditVerifiedSites, siteKey]))
    await persistAuditState(next, auditUrlOverrides)
  }, [auditUrlOverrides, auditVerifiedSites, persistAuditState])

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
  }, [auditUrlOverrides, auditVerifiedSites, persistAuditState])

  const rerunAuditSite = useCallback(async (site: string, overrideUrl?: string) => {
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
    setAuditBusySite(site)
    const res = await requestRerunSite({
      site,
      outDir,
      artifactsDir: `${outDir}/artifacts`,
      runId: createRunId(),
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
    updateWorkspaceData({ hasRun: true })
    setRunning(true)
    updateWorkspaceData({ progress: 0 })
    return { ok: true }
  }, [
    auditUrlOverrides,
    auditVerifiedSites,
    excludeSameEntity,
    llmModel,
    mappingMode,
    outDir,
    persistAuditState,
    setAuditBusySite,
    setRunning,
    updateWorkspaceData,
  ])

  const annotateAuditSite = useCallback(async (site: string) => {
    const blocked = buildAnnotationBlock({ remoteCodeOutdated, remoteCodeLegacy, backendStatus })
    if (blocked) {
      annotateLogsRef.current = [blocked.message]
      setAnnotateLogs([blocked.message])
      return { ok: false, error: blocked.error }
    }
    annotateLogsRef.current = []
    updateWorkspaceData({ annotationRunState: emptyAnnotationRunState(annotationStatsTotalSites || 1) })
    setAnnotateLogs([`Starting annotation for ${site}...`])
    setAnnotateRunning(true)
    setAuditAnnotatingSite(site)
    const res = await requestAnnotateSite({
      site,
      outDir,
      llmModel,
      force: true,
    })
    if (res.error === 'annotateSite API unavailable') {
      setAnnotateRunning(false)
      setAuditAnnotatingSite(null)
      annotateLogsRef.current = ['Annotation API unavailable in the current Electron session.']
      setAnnotateLogs(['Annotation API unavailable in the current Electron session.'])
      return { ok: false, error: res.error }
    }
    if (!res?.ok) {
      setAnnotateRunning(false)
      setAuditAnnotatingSite(null)
      const message = `Failed to start annotation: ${res?.error || 'unknown error'}`
      annotateLogsRef.current = [message]
      setAnnotateLogs([message])
      return { ok: false, error: res?.error || 'Failed to start annotation.' }
    }
    return { ok: true }
  }, [
    annotationStatsTotalSites,
    annotateLogsRef,
    backendStatus,
    llmModel,
    outDir,
    remoteCodeLegacy,
    remoteCodeOutdated,
    setAnnotateLogs,
    setAnnotateRunning,
    setAuditAnnotatingSite,
    updateWorkspaceData,
  ])

  const startAnnotate = useCallback(async (opts: { llmModel?: string; concurrency?: number; force?: boolean }) => {
    const blocked = buildAnnotationBlock({ remoteCodeOutdated, remoteCodeLegacy, backendStatus })
    if (blocked) {
      setAnnotateRunning(false)
      annotateLogsRef.current = [blocked.message]
      setAnnotateLogs([blocked.message])
      return
    }
    annotateLogsRef.current = []
    updateWorkspaceData({ annotationRunState: emptyAnnotationRunState(annotationStatsTotalSites) })
    setAnnotateLogs(['Starting annotator...'])
    setAnnotateRunning(true)
    const res = await requestStartAnnotate({
      artifactsDir: `${outDir}/artifacts`,
      llmModel: opts.llmModel ?? llmModel,
      concurrency: opts.concurrency ?? 1,
      force: opts.force ?? false,
    })
    if (res.error === 'startAnnotate API unavailable') {
      setAnnotateRunning(false)
      annotateLogsRef.current = ['Annotator start API unavailable in the current Electron session.']
      setAnnotateLogs(['Annotator start API unavailable in the current Electron session.'])
      return
    }
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
  }, [
    annotationStatsTotalSites,
    annotateLogsRef,
    backendStatus,
    llmModel,
    outDir,
    refreshBridgeStatus,
    remoteCodeLegacy,
    remoteCodeOutdated,
    setAnnotateLogs,
    setAnnotateRunning,
    updateWorkspaceData,
  ])

  const stopAnnotate = useCallback(async () => {
    await requestStopAnnotate()
    setAnnotateRunning(false)
    setAuditAnnotatingSite(null)
  }, [setAnnotateRunning, setAuditAnnotatingSite])

  const startRun = useCallback(async () => {
    const plan = buildStartRunPlan({
      scraperActive,
      dashboardLocked,
      launcherMode,
      topN,
      currentTargetTotal,
      requestedTargetTotal,
      mappingMode,
      runsRoot,
      resumeMode,
      outDir,
      datasetState,
      excludeSameEntity,
    })

    if (plan.errorMessage) {
      setErrorMessage(plan.errorMessage)
      return
    }
    if (plan.blocked || !plan.startOptions || !plan.runOutDir) {
      return
    }

    setErrorMessage(null)
    setScraperActivity(emptyScraperSiteActivityState())
    if (plan.resetWorkspace) {
      updateWorkspaceData((prev) => ({
        ...prev,
        summaryData: null,
        explorerData: null,
        resultsData: null,
        auditVerifiedSites: [],
        auditUrlOverrides: {},
        runManifest: null,
      }))
    }

    setOutDir(plan.runOutDir)
    const res = await requestStartRun(plan.startOptions)
    if (res.error === 'startRun API unavailable') {
      updateWorkspaceData({ hasRun: true })
      setRunning(true)
      updateWorkspaceData({ progress: launchStartingProgress })
      setRunStartedAt(Date.now())
      setEtaText('')
      return
    }
    if (!res.ok) {
      setErrorMessage(res.error || 'Failed to start scraper')
    } else {
      updateWorkspaceData({ hasRun: true })
      setRunning(true)
      updateWorkspaceData({ progress: launchStartingProgress })
      setRunStartedAt(Date.now())
      setEtaText('')
      const manifestRes = await readRunManifest(plan.runOutDir)
      updateWorkspaceData({ runManifest: manifestRes?.ok ? (manifestRes.data ?? null) : null })
    }
  }, [
    currentTargetTotal,
    dashboardLocked,
    datasetState,
    excludeSameEntity,
    launchStartingProgress,
    launcherMode,
    mappingMode,
    outDir,
    requestedTargetTotal,
    resumeMode,
    runsRoot,
    scraperActive,
    setErrorMessage,
    setEtaText,
    setOutDir,
    setRunStartedAt,
    setRunning,
    setScraperActivity,
    topN,
    updateWorkspaceData,
  ])

  return {
    markAuditVerified,
    saveAuditOverride,
    rerunAuditSite,
    annotateAuditSite,
    startAnnotate,
    stopAnnotate,
    startRun,
  }
}
