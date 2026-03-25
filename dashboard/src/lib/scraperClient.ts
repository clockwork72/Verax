import type {
  AnnotationRunState,
  AnnotationStats,
  BridgeScriptResult,
  ClearResultsResponse,
  DeleteOutputResponse,
  HpcBridgeStatus,
  JsonPathResponse,
  PipelineEvent,
  ResultRecord,
  RunManifest,
  RunRecord,
  RunState,
  RunSummary,
  ScraperActivitySnapshot,
  SiteActionResponse,
  StartRunResponse,
  ScraperExitEvent,
  ScraperMessageEvent,
  ScraperRuntimeEvent,
  WriteAuditStateResponse,
} from '../contracts/api'
import type { ExplorerSite, ExplorerThirdParty } from '../data/explorer'
import type { AnnotatorStreamEvent } from '../vite-env'
import { annotationRunStateFromStats, emptyAnnotationRunState } from './annotationRunState'
import { normalizePipelineEvent } from './pipelineEvents'

type AuditWorkspaceState = {
  verifiedSites: string[]
  urlOverrides: Record<string, string>
}

const DEFAULT_EXPLORER_LIMIT = 500
const DEFAULT_RESULTS_LIMIT = 250
const MAX_SMART_RESULTS_LIMIT = 1500

export type ReadWorkspaceSnapshotOptions = {
  outDir: string
  explorerLimit?: number
  resultsLimit?: number
  includeExplorer?: boolean
  includeResults?: boolean
  includeAudit?: boolean
  includeManifest?: boolean
  includeAnnotation?: boolean
  includeFolderSize?: boolean
}

export type WorkspaceSnapshot = {
  summary: RunSummary | null
  state: RunState | null
  hasAnyResults: boolean
  progress: number
  totalSites: number
  processedSites: number
  missingOutputDir: boolean
  explorer?: ExplorerSite[]
  results?: ResultRecord[]
  auditState?: AuditWorkspaceState
  runManifest?: RunManifest | null
  folderBytes?: number | null
  annotationStats?: AnnotationStats | null
  annotationRunState?: AnnotationRunState
}

const EMPTY_AUDIT_STATE: AuditWorkspaceState = {
  verifiedSites: [],
  urlOverrides: {},
}

export type ClearResultsOptions = Parameters<NonNullable<Window['scraper']>['clearResults']>[0]
export type WriteAuditStateOptions = Parameters<NonNullable<Window['scraper']>['writeAuditState']>[0]
export type StartRunOptions = Parameters<NonNullable<Window['scraper']>['startRun']>[0]
export type RerunSiteOptions = Parameters<NonNullable<Window['scraper']>['rerunSite']>[0]
export type AnnotateSiteOptions = Parameters<NonNullable<Window['scraper']>['annotateSite']>[0]
export type StartAnnotateOptions = Parameters<NonNullable<Window['scraper']>['startAnnotate']>[0]

function getScraperBridge() {
  return window.scraper ?? null
}

export function hasScraperBridge() {
  return getScraperBridge() !== null
}

function sanitizeResults(records: unknown): ResultRecord[] {
  if (!Array.isArray(records)) return []
  return records.filter((record): record is ResultRecord => {
    if (!record || typeof record !== 'object') return false
    const result = record as ResultRecord
    return Boolean(result.site_etld1 || result.input || result.site)
  })
}

function normalizeExplorerThirdParty(raw: unknown): ExplorerThirdParty | null {
  const record = asObject(raw)
  const name = asString(record?.name)
  if (!record || !name) return null
  return {
    name,
    policyUrl: typeof record.policyUrl === 'string'
      ? record.policyUrl
      : typeof record.policy_url === 'string'
        ? record.policy_url
        : null,
    extractionMethod: typeof record.extractionMethod === 'string'
      ? record.extractionMethod
      : typeof record.extraction_method === 'string'
        ? record.extraction_method
        : null,
    entity: typeof record.entity === 'string' ? record.entity : null,
    categories: asStringArray(record.categories),
    prevalence: typeof record.prevalence === 'number' ? record.prevalence : null,
  }
}

function sanitizeExplorer(records: unknown): ExplorerSite[] {
  if (!Array.isArray(records)) return []
  const normalized: ExplorerSite[] = []
  for (const record of records) {
    const row = asObject(record)
    const site = asString(row?.site)
    if (!row || !site) continue
    const thirdPartySource = Array.isArray(row.thirdParties)
      ? row.thirdParties
      : Array.isArray(row.third_parties)
        ? row.third_parties
        : []
    normalized.push({
      site,
      rank: typeof row.rank === 'number' ? row.rank : null,
      mainCategory: typeof row.mainCategory === 'string'
        ? row.mainCategory
        : typeof row.main_category === 'string'
          ? row.main_category
          : null,
      status: typeof row.status === 'string' ? row.status : 'exception',
      policyUrl: typeof row.policyUrl === 'string'
        ? row.policyUrl
        : typeof row.policy_url === 'string'
          ? row.policy_url
          : null,
      extractionMethod: typeof row.extractionMethod === 'string'
        ? row.extractionMethod
        : typeof row.extraction_method === 'string'
          ? row.extraction_method
          : null,
      thirdParties: thirdPartySource
        .map(normalizeExplorerThirdParty)
        .filter((tp): tp is ExplorerThirdParty => Boolean(tp)),
    })
  }
  return normalized
}

function countDerivedProcessedSites(results?: ResultRecord[], explorer?: ExplorerSite[]) {
  const siteKeys = new Set<string>()
  const resultRows = Array.isArray(results) ? results : []
  const explorerRows = Array.isArray(explorer) ? explorer : []

  if (resultRows.length > 0) {
    for (const [index, record] of resultRows.entries()) {
      const siteKey = asString(record.site_etld1) || asString(record.input) || asString(record.site) || `result:${index}`
      siteKeys.add(siteKey.trim().toLowerCase())
    }
    return siteKeys.size
  }

  for (const [index, site] of explorerRows.entries()) {
    const siteKey = asString(site.site) || `explorer:${index}`
    siteKeys.add(siteKey.trim().toLowerCase())
  }
  return siteKeys.size
}

function asObject(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : []
}

function asCountMap(value: unknown): Record<string, number> {
  const source = asObject(value)
  if (!source) return {}
  return Object.fromEntries(
    Object.entries(source)
      .filter(([, count]) => typeof count === 'number' && Number.isFinite(count))
      .map(([key, count]) => [key, count as number]),
  )
}

function maxFinite(...values: Array<number | null | undefined>): number {
  return values.reduce<number>((max, value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return max
    return Math.max(max, value)
  }, 0)
}

function normalizeRunSummary(raw: unknown): RunSummary | null {
  const summary = asObject(raw)
  if (!summary) return null
  return {
    run_id: asString(summary.run_id),
    total_sites: asNumber(summary.total_sites),
    processed_sites: asNumber(summary.processed_sites),
    last_processed_rank: typeof summary.last_processed_rank === 'number' ? summary.last_processed_rank : undefined,
    last_processed_site: asString(summary.last_processed_site),
    last_successful_rank: typeof summary.last_successful_rank === 'number' ? summary.last_successful_rank : undefined,
    last_successful_site: asString(summary.last_successful_site),
    success_rate: asNumber(summary.success_rate),
    status_counts: asCountMap(summary.status_counts),
    third_party: {
      total: asNumber(asObject(summary.third_party)?.total),
      unique: asNumber(asObject(summary.third_party)?.unique, 0),
      mapped: asNumber(asObject(summary.third_party)?.mapped),
      unique_mapped: asNumber(asObject(summary.third_party)?.unique_mapped, 0),
      unique_with_policy: asNumber(asObject(summary.third_party)?.unique_with_policy, 0),
      unmapped: asNumber(asObject(summary.third_party)?.unmapped),
      no_policy_url: asNumber(asObject(summary.third_party)?.no_policy_url),
    },
    english_policy_count: asNumber(summary.english_policy_count, 0),
    site_categories: Array.isArray(summary.site_categories)
      ? summary.site_categories
          .map((item) => asObject(item))
          .filter((item): item is Record<string, unknown> => Boolean(item))
          .map((item) => ({ name: String(item.name || ''), count: asNumber(item.count) }))
          .filter((item) => item.name)
      : [],
    mapping: {
      mode: (asObject(summary.mapping)?.mode as RunSummary['mapping']['mode']) ?? null,
      radar_mapped: asNumber(asObject(summary.mapping)?.radar_mapped),
      trackerdb_mapped: asNumber(asObject(summary.mapping)?.trackerdb_mapped),
      unmapped: asNumber(asObject(summary.mapping)?.unmapped),
      unique_radar_mapped: typeof asObject(summary.mapping)?.unique_radar_mapped === 'number'
        ? asObject(summary.mapping)?.unique_radar_mapped as number
        : undefined,
      unique_trackerdb_mapped: typeof asObject(summary.mapping)?.unique_trackerdb_mapped === 'number'
        ? asObject(summary.mapping)?.unique_trackerdb_mapped as number
        : undefined,
      unique_unmapped: typeof asObject(summary.mapping)?.unique_unmapped === 'number'
        ? asObject(summary.mapping)?.unique_unmapped as number
        : undefined,
    },
    categories: Array.isArray(summary.categories)
      ? summary.categories
          .map((item) => asObject(item))
          .filter((item): item is Record<string, unknown> => Boolean(item))
          .map((item) => ({ name: String(item.name || ''), count: asNumber(item.count) }))
          .filter((item) => item.name)
      : [],
    entities: Array.isArray(summary.entities)
      ? summary.entities
          .map((item) => asObject(item))
          .filter((item): item is Record<string, unknown> => Boolean(item))
          .map((item) => ({
            name: String(item.name || ''),
            count: typeof item.count === 'number' ? item.count : undefined,
            prevalence_avg: typeof item.prevalence_avg === 'number' ? item.prevalence_avg : null,
            prevalence_max: typeof item.prevalence_max === 'number' ? item.prevalence_max : null,
            prevalence: typeof item.prevalence === 'number' ? item.prevalence : null,
            domains: typeof item.domains === 'number' ? item.domains : null,
            categories: asStringArray(item.categories),
          }))
          .filter((item) => item.name)
      : [],
    started_at: asString(summary.started_at),
    updated_at: asString(summary.updated_at),
  }
}

function normalizeRunState(raw: unknown): RunState | null {
  const state = asObject(raw)
  if (!state) return null
  return {
    run_id: asString(state.run_id),
    mapping: {
      mode: (asObject(state.mapping)?.mode as RunState['mapping']['mode']) ?? null,
      radar_mapped: asNumber(asObject(state.mapping)?.radar_mapped),
      trackerdb_mapped: asNumber(asObject(state.mapping)?.trackerdb_mapped),
      unmapped: asNumber(asObject(state.mapping)?.unmapped),
    },
    total_sites: asNumber(state.total_sites),
    processed_sites: asNumber(state.processed_sites),
    status_counts: asCountMap(state.status_counts),
    third_party: {
      total: asNumber(asObject(state.third_party)?.total),
      mapped: asNumber(asObject(state.third_party)?.mapped),
      unmapped: asNumber(asObject(state.third_party)?.unmapped),
      no_policy_url: asNumber(asObject(state.third_party)?.no_policy_url),
    },
    started_at: asString(state.started_at),
    updated_at: asString(state.updated_at),
  }
}

function normalizeRunManifest(raw: unknown): RunManifest | null {
  const manifest = asObject(raw)
  if (!manifest || typeof manifest.updatedAt !== 'string') return null
  return {
    version: manifest.version === 1 ? 1 : 1,
    status: manifest.status === 'completed' || manifest.status === 'interrupted' ? manifest.status : 'running',
    mode: manifest.mode === 'append_sites' ? 'append_sites' : 'dataset',
    runId: asString(manifest.runId),
    topN: typeof manifest.topN === 'number' ? manifest.topN : undefined,
    resumeAfterRank: typeof manifest.resumeAfterRank === 'number' ? manifest.resumeAfterRank : undefined,
    expectedTotalSites: typeof manifest.expectedTotalSites === 'number' ? manifest.expectedTotalSites : undefined,
    requestedSites: asStringArray(manifest.requestedSites),
    updatedAt: manifest.updatedAt,
    startedAt: asString(manifest.startedAt),
    completedAt: asString(manifest.completedAt),
  }
}

function normalizeRunRecord(raw: unknown): RunRecord | null {
  const run = asObject(raw)
  if (!run) return null
  const outDir = asString(run.outDir)
  const folder = asString(run.folder)
  if (!outDir || !folder) return null
  return {
    runId: asString(run.runId) || folder,
    folder,
    outDir,
    summary: normalizeRunSummary(run.summary),
    state: normalizeRunState(run.state),
    updated_at: asString(run.updated_at),
    started_at: asString(run.started_at),
  }
}

function computeSnapshotProgress(
  summary: RunSummary | null,
  state: RunState | null,
  hasAnyResults: boolean,
  derivedProcessedSites = 0,
) {
  const processedSites = Math.max(
    maxFinite(summary?.processed_sites, state?.processed_sites),
    derivedProcessedSites,
  )
  const totalSites = maxFinite(summary?.total_sites, state?.total_sites)
  const progress = totalSites > 0
    ? Math.min(100, (processedSites / Math.max(1, totalSites)) * 100)
    : hasAnyResults ? 100 : 0
  return { processedSites, totalSites, progress }
}

function resolveResultsLimit(
  summary: RunSummary | null,
  state: RunState | null,
  explicitLimit?: number,
): number {
  if (typeof explicitLimit === 'number' && Number.isFinite(explicitLimit) && explicitLimit > 0) {
    return Math.floor(explicitLimit)
  }
  const processedSites = maxFinite(summary?.processed_sites, state?.processed_sites)
  if (processedSites <= 0) {
    return DEFAULT_RESULTS_LIMIT
  }
  return Math.min(MAX_SMART_RESULTS_LIMIT, Math.max(DEFAULT_RESULTS_LIMIT, Math.floor(processedSites)))
}

export async function readBridgeStatus(): Promise<{ ok: boolean; data?: HpcBridgeStatus; error?: string }> {
  const scraper = getScraperBridge()
  if (!scraper?.checkTunnel) {
    return { ok: false, error: 'checkTunnel unavailable' }
  }
  const result = await scraper.checkTunnel()
  return result?.ok
    ? { ok: true, data: result.data }
    : { ok: false, error: result?.error || 'bridge_check_failed', data: result?.data }
}

export async function readAnnotationStats(artifactsDir?: string): Promise<AnnotationStats | null> {
  const scraper = getScraperBridge()
  if (!scraper?.annotationStats) return null
  const result = await scraper.annotationStats(artifactsDir)
  return result?.ok ? result as AnnotationStats : null
}

export async function listRunRecords(baseOutDir?: string): Promise<RunRecord[]> {
  const scraper = getScraperBridge()
  if (!scraper?.listRuns) return []
  const result = await scraper.listRuns(baseOutDir)
  return result?.ok && Array.isArray(result.runs)
    ? result.runs.map(normalizeRunRecord).filter((run): run is RunRecord => Boolean(run))
    : []
}

export async function readFolderSize(outDir?: string): Promise<{ ok: boolean; bytes?: number; error?: string }> {
  const scraper = getScraperBridge()
  if (!scraper?.getFolderSize) {
    return { ok: false, error: 'getFolderSize unavailable' }
  }
  const result = await scraper.getFolderSize(outDir)
  return result?.ok
    ? { ok: true, bytes: result.bytes }
    : { ok: false, error: result?.error || 'folder_size_failed' }
}

export async function countOkArtifactSites(outDir?: string): Promise<string[]> {
  const scraper = getScraperBridge()
  if (!scraper?.countOkArtifacts) return []
  const result = await scraper.countOkArtifacts(outDir)
  return result?.ok && Array.isArray(result.sites) ? result.sites : []
}

export async function openEmbeddedPolicyWindow(url: string): Promise<boolean> {
  const scraper = getScraperBridge()
  if (!scraper?.openPolicyWindow) return false
  const result = await scraper.openPolicyWindow(url)
  return Boolean(result?.ok)
}

export async function writeAuditState(payload?: WriteAuditStateOptions): Promise<WriteAuditStateResponse> {
  const scraper = getScraperBridge()
  if (!scraper?.writeAuditState) {
    return { ok: false, error: 'writeAuditState API unavailable' }
  }
  return scraper.writeAuditState(payload)
}

export async function clearWorkspaceResults(options?: ClearResultsOptions): Promise<ClearResultsResponse> {
  const scraper = getScraperBridge()
  if (!scraper?.clearResults) {
    return { ok: false, removed: [], errors: [], error: 'clearResults API unavailable' }
  }
  return scraper.clearResults(options)
}

export async function deleteWorkspaceOutput(outDir?: string): Promise<DeleteOutputResponse> {
  const scraper = getScraperBridge()
  if (!scraper?.deleteOutput) {
    return { ok: false, error: 'deleteOutput API unavailable' }
  }
  return scraper.deleteOutput(outDir)
}

export async function deleteAllWorkspaceOutputs(): Promise<DeleteOutputResponse> {
  const scraper = getScraperBridge()
  if (!scraper?.deleteAllOutputs) {
    return { ok: false, error: 'deleteAllOutputs API unavailable' }
  }
  return scraper.deleteAllOutputs()
}

export async function requestStopRun(): Promise<SiteActionResponse> {
  const scraper = getScraperBridge()
  if (!scraper?.stopRun) {
    return { ok: false, error: 'stopRun API unavailable' }
  }
  return scraper.stopRun()
}

export async function openLogWindow(content: string, title?: string): Promise<{ ok: boolean; error?: string }> {
  const scraper = getScraperBridge()
  if (!scraper?.openLogWindow) {
    return { ok: false, error: 'openLogWindow API unavailable' }
  }
  return scraper.openLogWindow(content, title)
}

export async function runBridgeDiagnostics(): Promise<BridgeScriptResult> {
  const scraper = getScraperBridge()
  if (!scraper?.diagnoseBridge) {
    return { ok: false, error: 'diagnoseBridge API unavailable' }
  }
  return scraper.diagnoseBridge()
}

export async function runBridgeRepair(): Promise<BridgeScriptResult> {
  const scraper = getScraperBridge()
  if (!scraper?.repairBridge) {
    return { ok: false, error: 'repairBridge API unavailable' }
  }
  return scraper.repairBridge()
}

export async function runRemoteRefresh(): Promise<BridgeScriptResult> {
  const scraper = getScraperBridge()
  if (!scraper?.refreshRemote) {
    return { ok: false, error: 'refreshRemote API unavailable' }
  }
  return scraper.refreshRemote()
}

export async function requestRerunSite(options: RerunSiteOptions): Promise<SiteActionResponse> {
  const scraper = getScraperBridge()
  if (!scraper?.rerunSite) {
    return { ok: false, error: 'rerunSite API unavailable' }
  }
  return scraper.rerunSite(options)
}

export async function requestAnnotateSite(options: AnnotateSiteOptions): Promise<SiteActionResponse> {
  const scraper = getScraperBridge()
  if (!scraper?.annotateSite) {
    return { ok: false, error: 'annotateSite API unavailable' }
  }
  return scraper.annotateSite(options)
}

export async function requestStartAnnotate(options: StartAnnotateOptions): Promise<SiteActionResponse> {
  const scraper = getScraperBridge()
  if (!scraper?.startAnnotate) {
    return { ok: false, error: 'startAnnotate API unavailable' }
  }
  return scraper.startAnnotate(options)
}

export async function requestStopAnnotate(): Promise<SiteActionResponse> {
  const scraper = getScraperBridge()
  if (!scraper?.stopAnnotate) {
    return { ok: false, error: 'stopAnnotate API unavailable' }
  }
  return scraper.stopAnnotate()
}

export async function requestStartRun(options: StartRunOptions): Promise<StartRunResponse> {
  const scraper = getScraperBridge()
  if (!scraper?.startRun) {
    return { ok: false, error: 'startRun API unavailable' }
  }
  return scraper.startRun(options)
}

export async function readRunManifest(outDir?: string): Promise<JsonPathResponse<RunManifest>> {
  const scraper = getScraperBridge()
  if (!scraper?.readRunManifest) {
    return { ok: false, error: 'readRunManifest API unavailable' }
  }
  return scraper.readRunManifest(outDir)
}

export async function readWorkspaceSnapshot({
  outDir,
  explorerLimit = DEFAULT_EXPLORER_LIMIT,
  resultsLimit,
  includeExplorer = false,
  includeResults = false,
  includeAudit = false,
  includeManifest = false,
  includeAnnotation = false,
  includeFolderSize = false,
}: ReadWorkspaceSnapshotOptions): Promise<WorkspaceSnapshot> {
  const scraper = getScraperBridge()
  if (!scraper) {
    return {
      summary: null,
      state: null,
      hasAnyResults: false,
      progress: 0,
      totalSites: 0,
      processedSites: 0,
      missingOutputDir: false,
    }
  }

  const folderSizePromise = includeFolderSize
    ? scraper.getFolderSize(outDir)
    : Promise.resolve(null)
  const summaryPromise = scraper.readSummary(`${outDir}/results.summary.json`)
  const statePromise = scraper.readState(`${outDir}/run_state.json`)
  const auditPromise = includeAudit && scraper.readAuditState
    ? scraper.readAuditState(outDir)
    : Promise.resolve(null)
  const manifestPromise = includeManifest && scraper.readRunManifest
    ? scraper.readRunManifest(outDir)
    : Promise.resolve(null)
  const annotationPromise = includeAnnotation
    ? readAnnotationStats(`${outDir}/artifacts`)
    : Promise.resolve(null)

  let folderBytes: number | null | undefined
  const [
    size,
    summaryResult,
    stateResult,
    auditResult,
    manifestResult,
    annotationStats,
  ] = await Promise.all([
    folderSizePromise,
    summaryPromise,
    statePromise,
    auditPromise,
    manifestPromise,
    annotationPromise,
  ])

  if (includeFolderSize) {
    if (!size?.ok && size?.error === 'not_found') {
      return {
        summary: null,
        state: null,
        hasAnyResults: false,
        progress: 0,
        totalSites: 0,
        processedSites: 0,
        missingOutputDir: true,
        folderBytes: null,
      }
    }
    folderBytes = size?.ok && typeof size.bytes === 'number' ? size.bytes : null
  }

  const summary = summaryResult?.ok ? normalizeRunSummary(summaryResult.data) : null
  const state = stateResult?.ok ? normalizeRunState(stateResult.data) : null

  const snapshot: WorkspaceSnapshot = {
    summary,
    state,
    hasAnyResults: Boolean(summaryResult?.ok || stateResult?.ok),
    progress: 0,
    totalSites: 0,
    processedSites: 0,
    missingOutputDir: false,
  }

  if (includeExplorer) {
    const explorerResult = await scraper.readExplorer(`${outDir}/explorer.jsonl`, explorerLimit, 0)
    const explorer = explorerResult?.ok ? sanitizeExplorer(explorerResult.data) : []
    snapshot.explorer = explorer
    snapshot.hasAnyResults = snapshot.hasAnyResults || explorer.length > 0
  }

  if (includeResults && scraper.readResults) {
    const boundedResultsLimit = resolveResultsLimit(summary, state, resultsLimit)
    const resultsResult = await scraper.readResults(`${outDir}/results.jsonl`, boundedResultsLimit, 0)
    const results = resultsResult?.ok ? sanitizeResults(resultsResult.data) : []
    snapshot.results = results
    snapshot.hasAnyResults = snapshot.hasAnyResults || results.length > 0
  }

  if (includeAudit) {
    snapshot.auditState = auditResult?.ok && auditResult.data
      ? {
          verifiedSites: Array.isArray(auditResult.data.verifiedSites) ? auditResult.data.verifiedSites : [],
          urlOverrides: auditResult.data.urlOverrides || {},
        }
      : EMPTY_AUDIT_STATE
  }

  if (includeManifest) {
    snapshot.runManifest = manifestResult?.ok ? normalizeRunManifest(manifestResult.data) : null
  }

  if (includeAnnotation) {
    snapshot.annotationStats = annotationStats
    snapshot.annotationRunState = annotationStats
      ? annotationRunStateFromStats(annotationStats)
      : emptyAnnotationRunState()
  }

  if (includeFolderSize) {
    snapshot.folderBytes = folderBytes ?? null
  }

  const derivedProcessedSites = countDerivedProcessedSites(snapshot.results, snapshot.explorer)
  const progressState = computeSnapshotProgress(summary, state, snapshot.hasAnyResults, derivedProcessedSites)
  snapshot.processedSites = progressState.processedSites
  snapshot.totalSites = progressState.totalSites
  snapshot.progress = progressState.progress
  return snapshot
}

export function subscribePipelineEvents(callback: (event: PipelineEvent) => void): (() => void) | null {
  const scraper = getScraperBridge()
  if (!scraper?.onPipelineEvent) return null
  const handler = (raw: unknown) => {
    const event = normalizePipelineEvent(raw)
    if (event) callback(event)
  }
  scraper.onPipelineEvent(handler)
  return () => {}
}

export function subscribeScraperEvents(handlers: {
  onEvent?: (event: ScraperRuntimeEvent) => void
  onLog?: (event: ScraperMessageEvent) => void
  onError?: (event: ScraperMessageEvent) => void
  onExit?: (event: ScraperExitEvent) => void
}): (() => void) | null {
  const scraper = getScraperBridge()
  if (!scraper) return null
  if (handlers.onEvent && scraper.onEvent) scraper.onEvent(handlers.onEvent)
  if (handlers.onLog && scraper.onLog) scraper.onLog(handlers.onLog)
  if (handlers.onError && scraper.onError) scraper.onError(handlers.onError)
  if (handlers.onExit && scraper.onExit) scraper.onExit(handlers.onExit)
  return () => {}
}

export function subscribeScraperActivitySnapshots(
  callback: (snapshot: ScraperActivitySnapshot) => void,
): (() => void) | null {
  const scraper = getScraperBridge()
  if (!scraper?.onActivitySnapshot) return null
  scraper.onActivitySnapshot(callback)
  return () => {}
}

export function subscribeAnnotatorEvents(handlers: {
  onLog?: (event: { message?: string | null }) => void
  onStream?: (event: AnnotatorStreamEvent) => void
  onExit?: (event: { code?: number | null; signal?: string | null; stop_requested?: boolean }) => void
}): (() => void) | null {
  const scraper = getScraperBridge()
  if (!scraper) return null
  if (handlers.onLog && scraper.onAnnotatorLog) scraper.onAnnotatorLog(handlers.onLog)
  if (handlers.onStream && scraper.onAnnotatorStream) scraper.onAnnotatorStream(handlers.onStream)
  if (handlers.onExit && scraper.onAnnotatorExit) scraper.onAnnotatorExit(handlers.onExit)
  return () => {}
}
