import type {
  AnnotationRunState,
  AnnotationStats,
  HpcBridgeStatus,
  PipelineEvent,
} from '../contracts/api'
import { annotationRunStateFromStats, emptyAnnotationRunState } from './annotationRunState'
import { normalizePipelineEvent } from './pipelineEvents'

type AuditWorkspaceState = {
  verifiedSites: string[]
  urlOverrides: Record<string, string>
}

export type ReadWorkspaceSnapshotOptions = {
  outDir: string
  explorerLimit?: number
  includeExplorer?: boolean
  includeResults?: boolean
  includeAudit?: boolean
  includeManifest?: boolean
  includeAnnotation?: boolean
  includeFolderSize?: boolean
}

export type WorkspaceSnapshot = {
  summary: any | null
  state: any | null
  hasAnyResults: boolean
  progress: number
  totalSites: number
  processedSites: number
  missingOutputDir: boolean
  explorer?: any[]
  results?: any[]
  auditState?: AuditWorkspaceState
  runManifest?: any | null
  folderBytes?: number | null
  annotationStats?: AnnotationStats | null
  annotationRunState?: AnnotationRunState
}

const EMPTY_AUDIT_STATE: AuditWorkspaceState = {
  verifiedSites: [],
  urlOverrides: {},
}

function sanitizeResults(records: unknown): any[] {
  if (!Array.isArray(records)) return []
  return records.filter((record) => record && (record.site_etld1 || record.input || record.site))
}

function sanitizeExplorer(records: unknown): any[] {
  if (!Array.isArray(records)) return []
  return records.filter((record) => record && record.site)
}

function computeSnapshotProgress(summary: any | null, state: any | null, hasAnyResults: boolean) {
  const processedSites = Number(summary?.processed_sites ?? state?.processed_sites ?? 0)
  const totalSites = Number(summary?.total_sites ?? state?.total_sites ?? 0)
  const progress = totalSites > 0
    ? Math.min(100, (processedSites / Math.max(1, totalSites)) * 100)
    : hasAnyResults ? 100 : 0
  return { processedSites, totalSites, progress }
}

export async function readBridgeStatus(): Promise<{ ok: boolean; data?: HpcBridgeStatus; error?: string }> {
  if (!window.scraper?.checkTunnel) {
    return { ok: false, error: 'checkTunnel unavailable' }
  }
  const result = await window.scraper.checkTunnel()
  return result?.ok
    ? { ok: true, data: result.data }
    : { ok: false, error: result?.error || 'bridge_check_failed', data: result?.data }
}

export async function readAnnotationStats(artifactsDir?: string): Promise<AnnotationStats | null> {
  if (!window.scraper?.annotationStats) return null
  const result = await window.scraper.annotationStats(artifactsDir)
  return result?.ok ? result as AnnotationStats : null
}

export async function listRunRecords(baseOutDir?: string): Promise<any[]> {
  if (!window.scraper?.listRuns) return []
  const result = await window.scraper.listRuns(baseOutDir)
  return result?.ok && Array.isArray(result.runs) ? result.runs : []
}

export async function readFolderSize(outDir?: string): Promise<{ ok: boolean; bytes?: number; error?: string }> {
  if (!window.scraper?.getFolderSize) {
    return { ok: false, error: 'getFolderSize unavailable' }
  }
  const result = await window.scraper.getFolderSize(outDir)
  return result?.ok
    ? { ok: true, bytes: result.bytes }
    : { ok: false, error: result?.error || 'folder_size_failed' }
}

export async function readWorkspaceSnapshot({
  outDir,
  explorerLimit = 500,
  includeExplorer = false,
  includeResults = false,
  includeAudit = false,
  includeManifest = false,
  includeAnnotation = false,
  includeFolderSize = false,
}: ReadWorkspaceSnapshotOptions): Promise<WorkspaceSnapshot> {
  if (!window.scraper) {
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

  let folderBytes: number | null | undefined
  if (includeFolderSize) {
    const size = await window.scraper.getFolderSize(outDir)
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

  const summaryResult = await window.scraper.readSummary(`${outDir}/results.summary.json`)
  const stateResult = await window.scraper.readState(`${outDir}/run_state.json`)
  const summary = summaryResult?.ok ? summaryResult.data : null
  const state = stateResult?.ok ? stateResult.data : null

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
    const explorerResult = await window.scraper.readExplorer(`${outDir}/explorer.jsonl`, explorerLimit)
    const explorer = explorerResult?.ok ? sanitizeExplorer(explorerResult.data) : []
    snapshot.explorer = explorer
    snapshot.hasAnyResults = snapshot.hasAnyResults || explorer.length > 0
  }

  if (includeResults && window.scraper.readResults) {
    const resultsResult = await window.scraper.readResults(`${outDir}/results.jsonl`)
    const results = resultsResult?.ok ? sanitizeResults(resultsResult.data) : []
    snapshot.results = results
    snapshot.hasAnyResults = snapshot.hasAnyResults || results.length > 0
  }

  if (includeAudit && window.scraper.readAuditState) {
    const auditResult = await window.scraper.readAuditState(outDir)
    snapshot.auditState = auditResult?.ok && auditResult.data
      ? {
          verifiedSites: Array.isArray(auditResult.data.verifiedSites) ? auditResult.data.verifiedSites : [],
          urlOverrides: auditResult.data.urlOverrides || {},
        }
      : EMPTY_AUDIT_STATE
  }

  if (includeManifest && window.scraper.readRunManifest) {
    const manifestResult = await window.scraper.readRunManifest(outDir)
    snapshot.runManifest = manifestResult?.ok ? manifestResult.data : null
  }

  if (includeAnnotation) {
    const annotationStats = await readAnnotationStats(`${outDir}/artifacts`)
    snapshot.annotationStats = annotationStats
    snapshot.annotationRunState = annotationStats
      ? annotationRunStateFromStats(annotationStats)
      : emptyAnnotationRunState()
  }

  if (includeFolderSize) {
    snapshot.folderBytes = folderBytes ?? null
  }

  const progressState = computeSnapshotProgress(summary, state, snapshot.hasAnyResults)
  snapshot.processedSites = progressState.processedSites
  snapshot.totalSites = progressState.totalSites
  snapshot.progress = progressState.progress
  return snapshot
}

export function subscribePipelineEvents(callback: (event: PipelineEvent) => void): (() => void) | null {
  if (!window.scraper?.onPipelineEvent) return null
  const handler = (raw: unknown) => {
    const event = normalizePipelineEvent(raw)
    if (event) callback(event)
  }
  window.scraper.onPipelineEvent(handler)
  return () => {}
}
