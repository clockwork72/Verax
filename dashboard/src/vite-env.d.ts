/// <reference types="vite/client" />

type ScraperStartOptions = {
  topN?: number
  sites?: string[]
  trancoDate?: string
  trackerRadarIndex?: string
  trackerDbIndex?: string
  outDir?: string
  artifactsDir?: string
  runId?: string
  resumeAfterRank?: number
  expectedTotalSites?: number
  upsertBySite?: boolean
  cruxFilter?: boolean
  cruxApiKey?: string
  excludeSameEntity?: boolean
}

type RunManifest = {
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

type ScraperRerunSiteOptions = {
  site: string
  outDir?: string
  artifactsDir?: string
  runId?: string
  trackerRadarIndex?: string
  trackerDbIndex?: string
  policyUrlOverride?: string
  excludeSameEntity?: boolean
  llmModel?: string
}

type AnnotateSiteOptions = {
  site: string
  outDir?: string
  llmModel?: string
  tokenLimit?: number
  force?: boolean
}

type HpcBridgeStatus = {
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
}

declare global {
  interface Window {
    scraper?: {
      startRun: (options: ScraperStartOptions) => Promise<{ ok: boolean; error?: string; paths?: Record<string, string> }>
      stopRun: () => Promise<{ ok: boolean; error?: string }>
      getPaths: (outDir?: string) => Promise<Record<string, string>>
      readSummary: (path?: string) => Promise<{ ok: boolean; data?: any; error?: string; path?: string }>
      readState: (path?: string) => Promise<{ ok: boolean; data?: any; error?: string; path?: string }>
      readExplorer: (path?: string, limit?: number) => Promise<{ ok: boolean; data?: any; error?: string; path?: string }>
      readResults: (path?: string, limit?: number) => Promise<{ ok: boolean; data?: any; error?: string; path?: string }>
      readAuditState: (outDir?: string) => Promise<{ ok: boolean; data?: { verifiedSites: string[]; urlOverrides: Record<string, string> }; error?: string; path?: string }>
      readRunManifest: (outDir?: string) => Promise<{ ok: boolean; data?: RunManifest; error?: string; path?: string }>
      writeAuditState: (payload?: { outDir?: string; verifiedSites?: string[]; urlOverrides?: Record<string, string> }) => Promise<{ ok: boolean; data?: { verifiedSites: string[]; urlOverrides: Record<string, string> }; error?: string; path?: string }>
      readArtifactText: (options?: { outDir?: string; relativePath?: string }) => Promise<{ ok: boolean; data?: string; error?: string; path?: string }>
      clearResults: (options?: { includeArtifacts?: boolean; outDir?: string }) => Promise<{ ok: boolean; error?: string; removed?: string[]; errors?: string[] }>
      deleteOutput: (outDir?: string) => Promise<{ ok: boolean; error?: string; path?: string }>
      getFolderSize: (outDir?: string) => Promise<{ ok: boolean; error?: string; bytes?: number; path?: string }>
      listRuns: (baseOutDir?: string) => Promise<{ ok: boolean; error?: string; root?: string; runs?: any[] }>
      openLogWindow: (content: string, title?: string) => Promise<{ ok: boolean; error?: string }>
      openPolicyWindow: (url: string) => Promise<{ ok: boolean; error?: string }>
      onEvent: (callback: (event: any) => void) => void
      onLog: (callback: (event: any) => void) => void
      onError: (callback: (event: any) => void) => void
      onExit: (callback: (event: any) => void) => void
      rerunSite: (options: ScraperRerunSiteOptions) => Promise<{ ok: boolean; error?: string; paths?: Record<string, string>; site?: string }>
      startAnnotate: (options: { artifactsDir?: string; llmModel?: string; tokenLimit?: number; concurrency?: number; force?: boolean }) => Promise<{ ok: boolean; error?: string; artifactsDir?: string }>
      checkTunnel: () => Promise<{ ok: boolean; status?: number; error?: string; data?: HpcBridgeStatus }>
      stopAnnotate: () => Promise<{ ok: boolean; error?: string }>
      annotateSite: (options: AnnotateSiteOptions) => Promise<{ ok: boolean; error?: string; artifactsDir?: string; site?: string }>
      annotationStats: (artifactsDir?: string) => Promise<{ ok: boolean; error?: string; total_sites?: number; annotated_sites?: number; total_statements?: number; per_site?: { site: string; count: number; has_statements: boolean }[] }>
      countOkArtifacts: (outDir?: string) => Promise<{ ok: boolean; error?: string; count?: number; sites?: string[]; path?: string }>
      readTpCache: (outDir?: string) => Promise<{ ok: boolean; error?: string; total?: number; fetched?: number; failed?: number; by_status?: Record<string, number> }>
      cruxCacheStats: (outDir?: string) => Promise<{ ok: boolean; error?: string; count?: number; present?: number; absent?: number; path?: string }>
      onAnnotatorLog: (callback: (event: any) => void) => void
      onAnnotatorExit: (callback: (event: any) => void) => void
      onAnnotatorStream: (callback: (event: AnnotatorStreamEvent) => void) => void
    }
  }
}

export type AnnotatorStreamEvent = {
  site: string
  chunk_idx: number
  chunk_total: number
  round: number
  phase: 'reasoning' | 'extraction' | 'exhaustion'
  tag: string
  delta: string
}

export {}
