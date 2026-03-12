import type {
  ActiveSiteInfo,
  CompletedSiteInfo,
  ScraperExitEvent,
  ScraperMessageEvent,
  ScraperRuntimeEvent,
} from '../contracts/api'

export type SiteStageLabels = Record<string, { label: string; index: number }>

export type ScraperSiteActivityState = {
  activeSites: Record<string, ActiveSiteInfo>
  recentCompleted: CompletedSiteInfo[]
  logs: string[]
}

export function emptyScraperSiteActivityState(): ScraperSiteActivityState {
  return {
    activeSites: {},
    recentCompleted: [],
    logs: [],
  }
}

function asObject(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function normalizeScraperRuntimeEvent(raw: unknown): ScraperRuntimeEvent | null {
  const event = asObject(raw)
  const type = asString(event?.type)
  if (!event || !type) return null
  switch (type) {
    case 'run_started':
      return {
        type,
        run_id: asString(event.run_id),
        total_sites: asNumber(event.total_sites),
        timestamp: asString(event.timestamp),
      }
    case 'run_stage':
      return {
        type,
        run_id: asString(event.run_id),
        stage: asString(event.stage),
        timestamp: asString(event.timestamp),
      }
    case 'run_progress':
      return {
        type,
        run_id: asString(event.run_id),
        processed: asNumber(event.processed),
        total: asNumber(event.total),
        status_counts: asObject(event.status_counts) as Record<string, number> | undefined,
        timestamp: asString(event.timestamp),
      }
    case 'site_started': {
      const site = asString(event.site)
      if (!site) return null
      return {
        type,
        run_id: asString(event.run_id),
        site,
        rank: asNumber(event.rank),
        timestamp: asString(event.timestamp),
      }
    }
    case 'site_stage': {
      const site = asString(event.site)
      if (!site) return null
      return {
        type,
        run_id: asString(event.run_id),
        site,
        rank: asNumber(event.rank),
        stage: asString(event.stage),
        timestamp: asString(event.timestamp),
      }
    }
    case 'site_finished': {
      const site = asString(event.site)
      if (!site) return null
      return {
        type,
        run_id: asString(event.run_id),
        site,
        rank: asNumber(event.rank),
        status: asString(event.status),
        cached: asBoolean(event.cached),
        annotated: asBoolean(event.annotated),
        timestamp: asString(event.timestamp),
      }
    }
    case 'run_completed':
      return {
        type,
        run_id: asString(event.run_id),
        processed: asNumber(event.processed),
        total: asNumber(event.total),
        timestamp: asString(event.timestamp),
      }
    default:
      return null
  }
}

export function normalizeScraperMessageEvent(raw: unknown): ScraperMessageEvent | null {
  const event = asObject(raw)
  if (!event) return null
  const message = typeof event.message === 'string' ? event.message : null
  return message ? { message } : null
}

export function normalizeScraperExitEvent(raw: unknown): ScraperExitEvent {
  const event = asObject(raw)
  return {
    code: typeof event?.code === 'number' ? event.code : null,
    signal: typeof event?.signal === 'string' ? event.signal : null,
    stop_requested: Boolean(event?.stop_requested),
  }
}

function trimLogs(logs: string[]): string[] {
  return logs.slice(-50)
}

export function applyScraperRuntimeEvent(
  state: ScraperSiteActivityState,
  event: ScraperRuntimeEvent,
  stageLabels: SiteStageLabels,
): ScraperSiteActivityState {
  switch (event.type) {
    case 'site_started':
      return {
        activeSites: {
          ...state.activeSites,
          [event.site]: { label: 'Home fetch', stepIndex: 0, rank: event.rank ?? 0 },
        },
        recentCompleted: state.recentCompleted,
        logs: trimLogs([...state.logs, `Processing ${event.site}`]),
      }
    case 'site_stage': {
      const stageInfo = event.stage ? stageLabels[event.stage] : undefined
      if (!stageInfo) return state
      return {
        activeSites: {
          ...state.activeSites,
          [event.site]: {
            ...(state.activeSites[event.site] ?? { rank: event.rank ?? 0, label: stageInfo.label, stepIndex: stageInfo.index }),
            label: stageInfo.label,
            stepIndex: stageInfo.index,
          },
        },
        recentCompleted: state.recentCompleted,
        logs: state.logs,
      }
    }
    case 'site_finished': {
      const nextActiveSites = { ...state.activeSites }
      delete nextActiveSites[event.site]
      return {
        activeSites: nextActiveSites,
        recentCompleted: [
          { site: event.site, status: event.status || 'ok', cached: Boolean(event.cached), annotated: Boolean(event.annotated) },
          ...state.recentCompleted.slice(0, 14),
        ],
        logs: trimLogs([...state.logs, `Finished ${event.site} (${event.status || 'ok'})`]),
      }
    }
    default:
      return state
  }
}
