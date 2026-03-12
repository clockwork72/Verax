export type TunnelStatus = 'checking' | 'online' | 'degraded' | 'offline'

export type AnnotationSiteStatus =
  | 'pending'
  | 'preprocessing'
  | 'extracting'
  | 'committing'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'reused'

export type HpcBridgeStatus = {
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
  dbReady?: boolean
  probe_error?: string
  probe_detail?: string
  local_port_listening?: boolean
  tunnel_state?: 'stale' | 'offline'
  source_rev?: string
  local_source_rev?: string
}

export type PipelineEvent = {
  id?: number
  channel: string
  timestamp: string
  runId?: string | null
  site?: string | null
  phase?: string | null
  message?: string | null
  metrics?: Record<string, unknown> | null
  payload: Record<string, unknown>
}

export type AnnotationSiteRecord = {
  site: string
  count: number
  has_statements: boolean
  completed: boolean
  status: AnnotationSiteStatus
  updated_at?: string
  finished_at?: string
  reason?: string
  error?: string
  model?: string
  tokens_in?: number
  tokens_out?: number
}

export type AnnotationThirdPartyRecord = {
  site: string
  tp: string
  count: number
  has_statements: boolean
  completed: boolean
  status: AnnotationSiteStatus
  updated_at?: string
  finished_at?: string
  reason?: string
  error?: string
  model?: string
  tokens_in?: number
  tokens_out?: number
}

export type AnnotationStats = {
  ok: boolean
  total_sites: number
  annotated_sites: number
  total_statements: number
  per_site: AnnotationSiteRecord[]
  tp_total: number
  tp_annotated: number
  tp_total_statements: number
  per_tp: AnnotationThirdPartyRecord[]
}

export type AnnotationProgressPayload = {
  type: 'annotation.progress'
  site: string
  status: AnnotationSiteStatus
  phase?: string
  message?: string
  metrics?: Record<string, unknown>
  error?: string
}

export type AnnotationSiteRuntime = {
  site: string
  status: AnnotationSiteStatus
  phase?: string
  message?: string
  statements: number
  chunks?: number
  blocks?: number
  tokensIn: number
  tokensOut: number
  updatedAt?: string
  error?: string
}

export type AnnotationRunState = {
  totalSites: number
  sites: Record<string, AnnotationSiteRuntime>
  processedSites: number
  completedSites: number
  activeSites: string[]
  tokensIn: number
  tokensOut: number
}

export type BridgeScriptResult = {
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

export type ActiveSiteInfo = {
  label: string
  stepIndex: number
  rank: number
}

export type CompletedSiteInfo = {
  site: string
  status: string
  cached: boolean
  annotated?: boolean
}

export type ScraperRunStartedEvent = {
  type: 'run_started'
  run_id?: string
  total_sites?: number
  timestamp?: string
}

export type ScraperRunStageEvent = {
  type: 'run_stage'
  run_id?: string
  stage?: string
  timestamp?: string
}

export type ScraperRunProgressEvent = {
  type: 'run_progress'
  run_id?: string
  processed?: number
  total?: number
  status_counts?: Record<string, number>
  timestamp?: string
}

export type ScraperSiteStartedEvent = {
  type: 'site_started'
  run_id?: string
  site: string
  rank?: number
  timestamp?: string
}

export type ScraperSiteStageEvent = {
  type: 'site_stage'
  run_id?: string
  site: string
  rank?: number
  stage?: string
  timestamp?: string
}

export type ScraperSiteFinishedEvent = {
  type: 'site_finished'
  run_id?: string
  site: string
  rank?: number
  status?: string
  cached?: boolean
  annotated?: boolean
  timestamp?: string
}

export type ScraperRunCompletedEvent = {
  type: 'run_completed'
  run_id?: string
  processed?: number
  total?: number
  timestamp?: string
}

export type ScraperRuntimeEvent =
  | ScraperRunStartedEvent
  | ScraperRunStageEvent
  | ScraperRunProgressEvent
  | ScraperSiteStartedEvent
  | ScraperSiteStageEvent
  | ScraperSiteFinishedEvent
  | ScraperRunCompletedEvent

export type ScraperMessageEvent = {
  message?: string | null
}

export type ScraperExitEvent = {
  code?: number | null
  signal?: string | null
  stop_requested?: boolean
}
