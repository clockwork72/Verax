import { useCallback, useRef } from 'react'

import { annotationRunStateFromStats, emptyAnnotationRunState } from './annotationRunState'
import {
  listRunRecords,
  readAnnotationStats,
  readFolderSize,
  readWorkspaceSnapshot,
  writeAuditState,
  type WorkspaceSnapshot,
} from './scraperClient'
import type { ApplyWorkspaceSnapshotOptions, WorkspaceDataUpdate } from './useWorkspaceData'

const DATABASE_LOAD_RESULTS_PREVIEW_LIMIT = 250

type UseWorkspaceControllerArgs = {
  outDir: string
  runsRoot: string
  running: boolean
  handleMissingOutputDir: (missingDir: string) => Promise<void>
  applyWorkspaceSnapshot: (snapshot: WorkspaceSnapshot, options?: ApplyWorkspaceSnapshotOptions) => void
  updateWorkspaceData: (updater: WorkspaceDataUpdate) => void
  setOutDir: (value: string) => void
  setTopN: (value: string) => void
}

export function resolveSnapshotTargetTotal(snapshot: WorkspaceSnapshot): number | null {
  const candidate = (
    snapshot.summary?.total_sites
    ?? snapshot.state?.total_sites
    ?? snapshot.runManifest?.expectedTotalSites
    ?? snapshot.runManifest?.topN
  )
  return typeof candidate === 'number' && candidate > 0 ? candidate : null
}

export function useWorkspaceController({
  outDir,
  runsRoot,
  running,
  handleMissingOutputDir,
  applyWorkspaceSnapshot,
  updateWorkspaceData,
  setOutDir,
  setTopN,
}: UseWorkspaceControllerArgs) {
  const loadRequestIdRef = useRef(0)

  const refreshRuns = useCallback(async (baseDir: string = runsRoot) => {
    updateWorkspaceData({ runRecords: await listRunRecords(baseDir) })
    const size = await readFolderSize(outDir)
    if (!size.ok && size.error === 'not_found') {
      await handleMissingOutputDir(outDir)
      return
    }
    if (size.ok) {
      updateWorkspaceData({ folderBytes: typeof size.bytes === 'number' ? size.bytes : null })
    }
  }, [handleMissingOutputDir, outDir, runsRoot, updateWorkspaceData])

  const syncLoadedRunState = useCallback(async (targetDir = outDir) => {
    const snapshot = await readWorkspaceSnapshot({
      outDir: targetDir,
      includeFolderSize: true,
      includeManifest: true,
    })
    if (snapshot.missingOutputDir) {
      await handleMissingOutputDir(targetDir)
      return
    }
    const loadedTargetTotal = resolveSnapshotTargetTotal(snapshot)
    if (loadedTargetTotal !== null) {
      setTopN(String(loadedTargetTotal))
    }
    applyWorkspaceSnapshot(snapshot)
  }, [applyWorkspaceSnapshot, handleMissingOutputDir, outDir, setTopN])

  const loadAuditWorkspace = useCallback(async (dirOverride?: string) => {
    const targetDir = dirOverride || outDir
    const snapshot = await readWorkspaceSnapshot({
      outDir: targetDir,
      includeFolderSize: true,
      includeResults: true,
      includeAudit: true,
    })
    if (snapshot.missingOutputDir) {
      await handleMissingOutputDir(targetDir)
      return
    }
    applyWorkspaceSnapshot(snapshot, { preserveRunning: true, mergeHasRun: true, mergeProgress: running })
  }, [applyWorkspaceSnapshot, handleMissingOutputDir, outDir, running])

  const loadOutDir = useCallback(async (dirOverride?: string) => {
    const targetDir = (dirOverride || outDir).trim()
    const requestId = loadRequestIdRef.current + 1
    loadRequestIdRef.current = requestId

    if (dirOverride) {
      setOutDir(targetDir)
    }
    updateWorkspaceData({
      explorerData: null,
      folderBytes: null,
      annotationStats: null,
      annotationRunState: emptyAnnotationRunState(),
    })

    const snapshot = await readWorkspaceSnapshot({
      outDir: targetDir,
      includeResults: true,
      includeAudit: true,
      includeManifest: true,
      resultsLimit: DATABASE_LOAD_RESULTS_PREVIEW_LIMIT,
    })
    if (requestId !== loadRequestIdRef.current) {
      return
    }
    if (snapshot.missingOutputDir) {
      await handleMissingOutputDir(targetDir)
      return
    }
    const loadedTargetTotal = resolveSnapshotTargetTotal(snapshot)
    if (loadedTargetTotal !== null) {
      setTopN(String(loadedTargetTotal))
    }
    applyWorkspaceSnapshot(snapshot)

    void (async () => {
      const [size, annotationStats] = await Promise.all([
        readFolderSize(targetDir),
        readAnnotationStats(`${targetDir}/artifacts`),
      ])
      if (requestId !== loadRequestIdRef.current) {
        return
      }
      if (!size.ok && size.error === 'not_found') {
        await handleMissingOutputDir(targetDir)
        return
      }
      updateWorkspaceData({
        folderBytes: size.ok && typeof size.bytes === 'number' ? size.bytes : null,
        annotationStats: annotationStats ?? null,
        annotationRunState: annotationStats
          ? annotationRunStateFromStats(annotationStats)
          : emptyAnnotationRunState(),
      })
    })()
  }, [applyWorkspaceSnapshot, handleMissingOutputDir, outDir, setOutDir, setTopN, updateWorkspaceData])

  const persistAuditState = useCallback(async (
    nextVerifiedSites: string[],
    nextUrlOverrides: Record<string, string>,
    dirOverride?: string,
  ) => {
    const targetDir = dirOverride || outDir
    const res = await writeAuditState({
      outDir: targetDir,
      verifiedSites: nextVerifiedSites,
      urlOverrides: nextUrlOverrides,
    })
    if (res?.ok && res.data) {
      updateWorkspaceData({
        auditVerifiedSites: res.data.verifiedSites || [],
        auditUrlOverrides: res.data.urlOverrides || {},
      })
    }
  }, [outDir, updateWorkspaceData])

  return {
    refreshRuns,
    syncLoadedRunState,
    loadAuditWorkspace,
    loadOutDir,
    persistAuditState,
  }
}
