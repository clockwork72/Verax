import { useCallback } from 'react'

import { listRunRecords, readFolderSize, readWorkspaceSnapshot, writeAuditState, type WorkspaceSnapshot } from './scraperClient'
import type { ApplyWorkspaceSnapshotOptions, WorkspaceDataUpdate } from './useWorkspaceData'

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
      includeResults: true,
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
    const targetDir = dirOverride || outDir
    const snapshot = await readWorkspaceSnapshot({
      outDir: targetDir,
      includeFolderSize: true,
      includeExplorer: true,
      includeResults: true,
      includeAudit: true,
      includeManifest: true,
      includeAnnotation: true,
    })
    if (snapshot.missingOutputDir) {
      await handleMissingOutputDir(targetDir)
      return
    }
    if (dirOverride) {
      setOutDir(dirOverride)
    }
    const loadedTargetTotal = resolveSnapshotTargetTotal(snapshot)
    if (loadedTargetTotal !== null) {
      setTopN(String(loadedTargetTotal))
    }
    applyWorkspaceSnapshot(snapshot)
  }, [applyWorkspaceSnapshot, handleMissingOutputDir, outDir, setOutDir, setTopN])

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
