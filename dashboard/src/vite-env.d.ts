/// <reference types="vite/client" />

import type {
  ActiveSiteInfo,
  AnnotationStats,
  ArtifactCountResponse,
  BridgeScriptResult,
  ClearResultsResponse,
  CompletedSiteInfo,
  CruxCacheStatsResponse,
  DeleteOutputResponse,
  FolderSizeResponse,
  HpcBridgeStatus,
  JsonPathResponse,
  PathsPayload,
  PathsResponse,
  PipelineEvent,
  ResultRecord,
  RunManifest,
  RunListResponse,
  RunRecord,
  RunState,
  RunSummary,
  ScraperActivitySnapshot,
  ScraperExitEvent,
  ScraperMessageEvent,
  ScraperRuntimeEvent,
  SiteActionResponse,
  StartRunResponse,
  ThirdPartyCacheStats,
  WriteAuditStateResponse,
} from './contracts/api'

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

declare global {
  interface Window {
    scraper?: {
      startRun: (options: ScraperStartOptions) => Promise<StartRunResponse>
      stopRun: () => Promise<SiteActionResponse>
      getPaths: (outDir?: string) => Promise<PathsPayload | PathsResponse>
      readSummary: (path?: string) => Promise<JsonPathResponse<RunSummary>>
      readState: (path?: string) => Promise<JsonPathResponse<RunState>>
      readExplorer: (path?: string, limit?: number) => Promise<JsonPathResponse<unknown[]>>
      readResults: (path?: string, limit?: number) => Promise<JsonPathResponse<ResultRecord[]>>
      readAuditState: (outDir?: string) => Promise<JsonPathResponse<{ verifiedSites: string[]; urlOverrides: Record<string, string> }>>
      readRunManifest: (outDir?: string) => Promise<JsonPathResponse<RunManifest>>
      writeAuditState: (payload?: { outDir?: string; verifiedSites?: string[]; urlOverrides?: Record<string, string> }) => Promise<WriteAuditStateResponse>
      readArtifactText: (options?: { outDir?: string; relativePath?: string }) => Promise<JsonPathResponse<string>>
      clearResults: (options?: { includeArtifacts?: boolean; outDir?: string }) => Promise<ClearResultsResponse>
      deleteOutput: (outDir?: string) => Promise<DeleteOutputResponse>
      deleteAllOutputs: () => Promise<DeleteOutputResponse>
      getFolderSize: (outDir?: string) => Promise<FolderSizeResponse>
      listRuns: (baseOutDir?: string) => Promise<RunListResponse>
      openLogWindow: (content: string, title?: string) => Promise<{ ok: boolean; error?: string }>
      openPolicyWindow: (url: string) => Promise<{ ok: boolean; error?: string }>
      onEvent: (callback: (event: ScraperRuntimeEvent) => void) => void
      onActivitySnapshot: (callback: (snapshot: ScraperActivitySnapshot) => void) => void
      onLog: (callback: (event: ScraperMessageEvent) => void) => void
      onError: (callback: (event: ScraperMessageEvent) => void) => void
      onExit: (callback: (event: ScraperExitEvent) => void) => void
      rerunSite: (options: ScraperRerunSiteOptions) => Promise<SiteActionResponse>
      startAnnotate: (options: { artifactsDir?: string; llmModel?: string; tokenLimit?: number; concurrency?: number; force?: boolean }) => Promise<SiteActionResponse>
      checkTunnel: () => Promise<{ ok: boolean; status?: number; error?: string; data?: HpcBridgeStatus }>
      stopAnnotate: () => Promise<SiteActionResponse>
      annotateSite: (options: AnnotateSiteOptions) => Promise<SiteActionResponse>
      annotationStats: (artifactsDir?: string) => Promise<AnnotationStats>
      countOkArtifacts: (outDir?: string) => Promise<ArtifactCountResponse>
      readTpCache: (outDir?: string) => Promise<ThirdPartyCacheStats>
      cruxCacheStats: (outDir?: string) => Promise<CruxCacheStatsResponse>
      onAnnotatorLog: (callback: (event: { message?: string | null }) => void) => void
      onAnnotatorExit: (callback: (event: { code?: number | null; signal?: string | null; stop_requested?: boolean }) => void) => void
      onAnnotatorStream: (callback: (event: AnnotatorStreamEvent) => void) => void
      onPipelineEvent: (callback: (event: PipelineEvent) => void) => void
      diagnoseBridge: () => Promise<BridgeScriptResult>
      repairBridge: () => Promise<BridgeScriptResult>
      refreshRemote: () => Promise<BridgeScriptResult>
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

export type { ActiveSiteInfo, CompletedSiteInfo }

export {}
