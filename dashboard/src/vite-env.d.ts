/// <reference types="vite/client" />

type ScraperStartOptions = {
  topN?: number
  trancoDate?: string
  trackerRadarIndex?: string
  trackerDbIndex?: string
  outDir?: string
  artifactsDir?: string
  runId?: string
  cruxFilter?: boolean
  cruxApiKey?: string
  excludeSameEntity?: boolean
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
      startAnnotate: (options: { artifactsDir?: string; openaiApiKey?: string; llmModel?: string; tokenLimit?: number; concurrency?: number; force?: boolean }) => Promise<{ ok: boolean; error?: string; artifactsDir?: string }>
      stopAnnotate: () => Promise<{ ok: boolean; error?: string }>
      annotationStats: (artifactsDir?: string) => Promise<{ ok: boolean; error?: string; total_sites?: number; annotated_sites?: number; total_statements?: number; per_site?: { site: string; count: number; has_statements: boolean }[] }>
      readTpCache: (outDir?: string) => Promise<{ ok: boolean; error?: string; total?: number; fetched?: number; failed?: number; by_status?: Record<string, number> }>
      onAnnotatorLog: (callback: (event: any) => void) => void
      onAnnotatorExit: (callback: (event: any) => void) => void
    }
  }
}

export {}
