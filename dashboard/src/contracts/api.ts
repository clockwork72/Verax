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
