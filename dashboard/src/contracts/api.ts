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

export type ScraperSiteStatus =
  | 'ok'
  | 'policy_not_found'
  | 'home_fetch_failed'
  | 'non_browsable'
  | 'exception'
  | string

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

export type HealthResponse = {
  ok: boolean
  service_ready: boolean
  database_ready: boolean
  scraper_connected: boolean
  dashboard_locked: boolean
  active_run: boolean
  annotator_running: boolean
  node: string
  port: number
  db_port: number
  started_at: string
  remote_root: string
  repo_root: string
  current_out_dir: string
  source_rev?: string | null
}

export type PollResponse = {
  ok: boolean
  cursor: number
  items: PipelineEvent[]
  running: boolean
  annotateRunning: boolean
  currentOutDir: string
}

export type StatusResponse = {
  ok: boolean
  running: boolean
  annotateRunning: boolean
  currentOutDir: string
  dbDsn: string
  dbReady: boolean
}

export type PathsPayload = {
  outDir: string
  resultsJsonl: string
  summaryJson: string
  stateJson: string
  explorerJsonl: string
  artifactsDir: string
  artifactsOkDir: string
  cruxCacheJson: string
}

export type PathsResponse = {
  ok: boolean
  data: PathsPayload
}

export type JsonPathResponse<T> = {
  ok: boolean
  data?: T
  path?: string
  error?: string
}

export type FolderSizeResponse = {
  ok: boolean
  bytes?: number
  path?: string
  error?: string
}

export type RunSummaryStatusCounts = Record<string, number>

export type RunSummaryCategory = {
  name: string
  count: number
}

export type RunSummaryEntity = {
  name: string
  count?: number
  prevalence_avg?: number | null
  prevalence_max?: number | null
  prevalence?: number | null
  domains?: number | null
  categories: string[]
}

export type RunMappingSummary = {
  mode?: 'radar' | 'trackerdb' | 'mixed' | null
  radar_mapped: number
  trackerdb_mapped: number
  unmapped: number
  /** Unique eTLD+1 domains matched via Tracker Radar */
  unique_radar_mapped?: number
  /** Unique eTLD+1 domains matched via TrackerDB */
  unique_trackerdb_mapped?: number
  /** Unique eTLD+1 domains with no mapping source */
  unique_unmapped?: number
}

export type RunThirdPartySummary = {
  total: number
  unique?: number
  mapped: number
  unique_mapped?: number
  unique_with_policy?: number
  unmapped: number
  no_policy_url: number
}

export type RunSummary = {
  run_id?: string
  total_sites: number
  processed_sites: number
  success_rate: number
  status_counts: RunSummaryStatusCounts
  third_party: RunThirdPartySummary
  english_policy_count?: number
  mapping: RunMappingSummary
  categories: RunSummaryCategory[]
  entities: RunSummaryEntity[]
  started_at?: string
  updated_at?: string
}

export type RunState = {
  run_id?: string
  mapping: RunMappingSummary
  total_sites: number
  processed_sites: number
  status_counts: RunSummaryStatusCounts
  third_party: Pick<RunThirdPartySummary, 'total' | 'mapped' | 'unmapped' | 'no_policy_url'>
  started_at?: string
  updated_at?: string
}

export type RunManifest = {
  version: 1
  status: 'running' | 'completed' | 'interrupted'
  mode: 'tranco' | 'append_sites'
  runId?: string
  topN?: number
  trancoDate?: string
  resumeAfterRank?: number
  expectedTotalSites?: number
  requestedSites?: string[]
  cruxFilter?: boolean
  updatedAt: string
  startedAt?: string
  completedAt?: string
}

export type RunRecord = {
  runId: string
  folder: string
  outDir: string
  summary: RunSummary | null
  state: RunState | null
  updated_at?: string
  started_at?: string
}

export type RunListResponse = {
  ok: boolean
  root?: string
  runs?: RunRecord[]
  path?: string
  error?: string
}

export type AuditStatePayload = {
  verifiedSites: string[]
  urlOverrides: Record<string, string>
  updatedAt?: string
}

export type FirstPartyPolicyRecord = {
  url?: string | null
  extraction_method?: string | null
  text_len?: number | null
}

export type ThirdPartyResultRecord = {
  third_party_etld1?: string
  entity?: string | null
  categories?: string[]
  policy_url?: string | null
  [key: string]: unknown
}

export type ResultRecord = {
  rank?: number | null
  input?: string
  site?: string
  site_etld1?: string
  status?: string
  final_url?: string
  first_party_policy?: FirstPartyPolicyRecord | null
  third_parties?: ThirdPartyResultRecord[]
  error_message?: string | null
  non_browsable_reason?: string | null
  [key: string]: unknown
}

export type ThirdPartyCacheStats = {
  ok: boolean
  error?: string
  total?: number
  fetched?: number
  failed?: number
  by_status?: Record<string, number>
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
  phase?: string
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
  phase?: string
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

export type ArtifactCountResponse = {
  ok: boolean
  count: number
  sites: string[]
  path: string
}

export type CruxCacheStatsResponse = {
  ok: boolean
  count: number
  present: number
  absent: number
  path: string
  error?: string
}

export type WriteAuditStateResponse = {
  ok: boolean
  data?: AuditStatePayload
  path?: string
  error?: string
}

export type ClearResultsResponse = {
  ok: boolean
  removed: string[]
  missing?: string[]
  errors: string[]
  error?: string
}

export type DeleteOutputResponse = {
  ok: boolean
  path?: string
  removed?: string[]
  error?: string
}

export type StartRunResponse = {
  ok: boolean
  paths?: Pick<PathsPayload, 'outDir' | 'resultsJsonl' | 'summaryJson' | 'stateJson' | 'explorerJsonl' | 'artifactsDir' | 'artifactsOkDir'>
  error?: string
}

export type SiteActionResponse = {
  ok: boolean
  site?: string
  paths?: { outDir: string }
  artifactsDir?: string
  status?: 'stopping' | 'stopped'
  error?: string
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

export type BridgeDiagnostics = {
  service_port: number
  health_ok: boolean
  health_raw: string
  local_target: string | null
  remote_node: string | null
  ssh_status: number
  local_tunnels: string[]
  local_rev?: string | null
  remote_rev?: string | null
  rev_match?: boolean | null
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
  diagnostics?: BridgeDiagnostics
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

export type ScraperActivitySnapshot = {
  activeSites: Record<string, ActiveSiteInfo>
  recentCompleted: CompletedSiteInfo[]
  running: boolean
  currentOutDir?: string
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
