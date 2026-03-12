import type {
  AnnotationProgressPayload,
  AnnotationRunState,
  AnnotationSiteRuntime,
  AnnotationStats,
  PipelineEvent,
} from '../contracts/api'

const ACTIVE_STATUSES = new Set(['pending', 'preprocessing', 'extracting', 'committing'])
const PROCESSED_STATUSES = new Set(['completed', 'failed', 'stopped', 'reused'])

export function emptyAnnotationRunState(totalSites = 0): AnnotationRunState {
  return {
    totalSites,
    sites: {},
    processedSites: 0,
    completedSites: 0,
    activeSites: [],
    tokensIn: 0,
    tokensOut: 0,
  }
}

function numberMetric(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function recalc(state: AnnotationRunState): AnnotationRunState {
  const rows = Object.values(state.sites)
  const processedSites = rows.filter((row) => PROCESSED_STATUSES.has(row.status)).length
  const completedSites = rows.filter((row) => row.status === 'completed' || row.status === 'reused').length
  const activeSites = rows.filter((row) => ACTIVE_STATUSES.has(row.status)).map((row) => row.site).sort()
  const tokensIn = rows.reduce((sum, row) => sum + row.tokensIn, 0)
  const tokensOut = rows.reduce((sum, row) => sum + row.tokensOut, 0)
  return {
    ...state,
    processedSites,
    completedSites,
    activeSites,
    tokensIn,
    tokensOut,
  }
}

export function annotationRunStateFromStats(stats: AnnotationStats | null | undefined): AnnotationRunState {
  if (!stats) return emptyAnnotationRunState(0)
  const sites: Record<string, AnnotationSiteRuntime> = {}
  for (const row of stats.per_site ?? []) {
    sites[row.site] = {
      site: row.site,
      status: row.status,
      phase: row.status,
      message: row.reason || row.error || undefined,
      statements: row.count ?? 0,
      tokensIn: row.tokens_in ?? 0,
      tokensOut: row.tokens_out ?? 0,
      updatedAt: row.updated_at,
      error: row.error,
    }
  }
  return recalc({
    totalSites: stats.total_sites ?? Object.keys(sites).length,
    sites,
    processedSites: 0,
    completedSites: 0,
    activeSites: [],
    tokensIn: 0,
    tokensOut: 0,
  })
}

export function applyAnnotationProgressEvent(
  state: AnnotationRunState,
  event: PipelineEvent,
): AnnotationRunState {
  if (event.channel !== 'annotator:progress') return state
  const payload = event.payload as Partial<AnnotationProgressPayload>
  if (payload.type !== 'annotation.progress' || !payload.site || !payload.status) return state
  const metrics = payload.metrics ?? {}
  const previous = state.sites[payload.site] ?? {
    site: payload.site,
    status: payload.status,
    statements: 0,
    tokensIn: 0,
    tokensOut: 0,
  }
  const nextSite: AnnotationSiteRuntime = {
    ...previous,
    status: payload.status,
    phase: typeof payload.phase === 'string' ? payload.phase : previous.phase,
    message: typeof payload.message === 'string' ? payload.message : previous.message,
    statements: numberMetric(metrics, 'statements') ?? previous.statements,
    chunks: numberMetric(metrics, 'chunks') ?? previous.chunks,
    blocks: numberMetric(metrics, 'blocks') ?? previous.blocks,
    tokensIn: numberMetric(metrics, 'tokens_in') ?? previous.tokensIn,
    tokensOut: numberMetric(metrics, 'tokens_out') ?? previous.tokensOut,
    updatedAt: event.timestamp,
    error: typeof payload.error === 'string' ? payload.error : previous.error,
  }
  return recalc({
    ...state,
    sites: {
      ...state.sites,
      [payload.site]: nextSite,
    },
    totalSites: Math.max(state.totalSites, Object.keys(state.sites).length, 1),
  })
}
