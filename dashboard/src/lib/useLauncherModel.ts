import { useMemo } from 'react'

import type { ResultRecord, RunManifest, RunState, RunSummary } from '../contracts/api'
import type { ResultsMetrics } from '../utils/results'
import { computeResults } from '../utils/results'
import type { LauncherMode } from './useRunController'

export type DatasetState = {
  hasDataset: boolean
  totalSites: number
  processedSites: number
  uniqueSiteCount: number
  isComplete: boolean
  isIncomplete: boolean
  progressPct: number
  lastSuccessfulRank: number | null
  lastSuccessfulSite: string | null
  pendingManifestSites: string[]
  manifestMode?: RunManifest['mode']
  manifestTopN: number | null
}

export type LauncherState = {
  currentTargetTotal: number
  requestedTargetTotal: number
  canExtendByTarget: boolean
  extensionDelta: number
  launchStartingProgress: number
  launcherMode: LauncherMode
  launcherActionLabel: string
  launcherActionHint: string
}

function normalizeSiteKey(value: string): string {
  return value.trim().toLowerCase()
}

function resultSiteKey(record: ResultRecord): string {
  const candidate = record?.site_etld1 || record?.input || record?.site || ''
  return typeof candidate === 'string' ? normalizeSiteKey(candidate) : ''
}

function isDatasetMode(mode?: RunManifest['mode']): boolean {
  return mode === 'dataset' || mode === 'tranco'
}

export function buildDatasetState({
  summaryData,
  stateData,
  resultsData,
  runManifest,
}: {
  summaryData: RunSummary | null
  stateData: RunState | null
  resultsData: ResultRecord[] | null
  runManifest: RunManifest | null
}): DatasetState {
  const totalSites = Number(summaryData?.total_sites ?? stateData?.total_sites ?? runManifest?.expectedTotalSites ?? 0)
  const persistedProcessedSites = Number(summaryData?.processed_sites ?? stateData?.processed_sites ?? 0)
  const siteKeys = new Set<string>()
  let lastSuccessfulRank = typeof summaryData?.last_successful_rank === 'number'
    ? summaryData.last_successful_rank
    : null
  let lastSuccessfulSite = typeof summaryData?.last_successful_site === 'string'
    ? summaryData.last_successful_site
    : null

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

  const processedSites = Math.max(persistedProcessedSites, siteKeys.size)

  const pendingManifestSites = Array.isArray(runManifest?.requestedSites)
    ? runManifest.requestedSites
        .map((site: unknown) => String(site || '').trim())
        .filter(Boolean)
        .filter((site: string, index: number, list: string[]) => (
          list.findIndex((value) => normalizeSiteKey(value) === normalizeSiteKey(site)) === index
        ))
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
    uniqueSiteCount: siteKeys.size,
    isComplete,
    isIncomplete,
    progressPct,
    lastSuccessfulRank,
    lastSuccessfulSite,
    pendingManifestSites,
    manifestMode: runManifest?.mode,
    manifestTopN: Number(runManifest?.topN || 0) || null,
  }
}

export function buildLauncherState({
  datasetState,
  topN,
  resumeMode,
  dashboardLocked,
  outDir,
}: {
  datasetState: DatasetState
  topN: string
  resumeMode: boolean
  dashboardLocked: boolean
  outDir: string
}): LauncherState {
  const currentTargetTotal = datasetState.totalSites || datasetState.uniqueSiteCount || datasetState.manifestTopN || 0
  const requestedTargetTotal = Number(topN || 0)
  const canExtendByTarget = (
    resumeMode
    && datasetState.isComplete
    && (isDatasetMode(datasetState.manifestMode) || datasetState.lastSuccessfulRank !== null)
  )
  const extensionDelta = canExtendByTarget && Number.isFinite(requestedTargetTotal) && requestedTargetTotal > 0
    ? Math.max(0, requestedTargetTotal - currentTargetTotal)
    : 0
  const launchStartingProgress = datasetState.isIncomplete
    ? datasetState.progressPct
    : extensionDelta > 0 && requestedTargetTotal > 0
      ? Math.min(100, (datasetState.processedSites / requestedTargetTotal) * 100)
      : 0
  const launcherMode: LauncherMode = datasetState.isIncomplete
    ? datasetState.manifestMode === 'append_sites' && datasetState.pendingManifestSites.length > 0
      ? 'continue'
      : isDatasetMode(datasetState.manifestMode) || datasetState.lastSuccessfulRank !== null
        ? 'continue'
        : 'start'
    : canExtendByTarget
      ? 'extend'
      : 'start'
  const launcherActionLabel = launcherMode === 'continue'
    ? 'Continue'
    : launcherMode === 'extend'
      ? 'Extend run'
      : 'Start run'
  const launcherActionHint = launcherMode === 'continue'
    ? datasetState.manifestMode === 'append_sites' && datasetState.pendingManifestSites.length > 0
      ? `Resume ${datasetState.pendingManifestSites.length} pending append target(s) in ${outDir}.`
      : `Resume ${outDir} after ${datasetState.lastSuccessfulSite || `rank #${datasetState.lastSuccessfulRank ?? 0}`} to reach ${datasetState.totalSites} sites.`
    : launcherMode === 'extend'
      ? extensionDelta > 0
        ? `Extend ${outDir} from ${currentTargetTotal} to ${requestedTargetTotal} total sites by scraping the remaining ${extensionDelta}.`
        : `This dataset already has ${currentTargetTotal} sites. Enter a higher total to continue scraping from the next rank.`
      : dashboardLocked
        ? 'Cluster bridge offline. Start the orchestrator and SSH tunnel with hpc/scraper/launch_remote.sh.'
        : 'Scrape directly from scrapable_websites_categorized.csv. Enter a target and start the run.'

  return {
    currentTargetTotal,
    requestedTargetTotal,
    canExtendByTarget,
    extensionDelta,
    launchStartingProgress,
    launcherMode,
    launcherActionLabel,
    launcherActionHint,
  }
}

export function useLauncherModel({
  hasRun,
  progress,
  summaryData,
  stateData,
  resultsData,
  runManifest,
  topN,
  resumeMode,
  dashboardLocked,
  outDir,
}: {
  hasRun: boolean
  progress: number
  summaryData: RunSummary | null
  stateData: RunState | null
  resultsData: ResultRecord[] | null
  runManifest: RunManifest | null
  topN: string
  resumeMode: boolean
  dashboardLocked: boolean
  outDir: string
}): {
  resultsMetrics: ResultsMetrics
  datasetState: DatasetState
} & LauncherState {
  const resultsMetrics = useMemo(() => computeResults(hasRun, progress), [hasRun, progress])
  const datasetState = useMemo(() => buildDatasetState({
    summaryData,
    stateData,
    resultsData,
    runManifest,
  }), [resultsData, runManifest, stateData, summaryData])
  const launcherState = useMemo(() => buildLauncherState({
    datasetState,
    topN,
    resumeMode,
    dashboardLocked,
    outDir,
  }), [dashboardLocked, datasetState, outDir, resumeMode, topN])

  return {
    resultsMetrics,
    datasetState,
    ...launcherState,
  }
}
