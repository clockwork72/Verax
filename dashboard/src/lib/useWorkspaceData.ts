import { useCallback, useState } from 'react'

import type {
  AnnotationRunState,
  AnnotationStats,
  ResultRecord,
  RunManifest,
  RunRecord,
  RunState,
  RunSummary,
} from '../contracts/api'
import type { ExplorerSite } from '../data/explorer'
import { emptyAnnotationRunState } from './annotationRunState'
import type { WorkspaceSnapshot } from './scraperClient'

export type WorkspaceDataState = {
  hasRun: boolean
  progress: number
  summaryData: RunSummary | null
  explorerData: ExplorerSite[] | null
  resultsData: ResultRecord[] | null
  stateData: RunState | null
  runRecords: RunRecord[]
  runManifest: RunManifest | null
  folderBytes: number | null
  annotationStats: AnnotationStats | null
  annotationRunState: AnnotationRunState
  auditVerifiedSites: string[]
  auditUrlOverrides: Record<string, string>
}

export type ApplyWorkspaceSnapshotOptions = {
  preserveRunning?: boolean
  mergeHasRun?: boolean
  mergeProgress?: boolean
}

export type WorkspaceDataUpdate =
  | Partial<WorkspaceDataState>
  | ((state: WorkspaceDataState) => WorkspaceDataState)

export function createEmptyWorkspaceDataState(): WorkspaceDataState {
  return {
    hasRun: false,
    progress: 0,
    summaryData: null,
    explorerData: null,
    resultsData: null,
    stateData: null,
    runRecords: [],
    runManifest: null,
    folderBytes: null,
    annotationStats: null,
    annotationRunState: emptyAnnotationRunState(),
    auditVerifiedSites: [],
    auditUrlOverrides: {},
  }
}

export function applyWorkspaceSnapshotState(
  state: WorkspaceDataState,
  snapshot: WorkspaceSnapshot,
  options?: ApplyWorkspaceSnapshotOptions,
): WorkspaceDataState {
  const mergeHasRun = Boolean(options?.mergeHasRun)
  const mergeProgress = Boolean(options?.mergeProgress)
  return {
    ...state,
    summaryData: snapshot.summary,
    stateData: snapshot.state,
    explorerData: snapshot.explorer !== undefined ? snapshot.explorer : state.explorerData,
    resultsData: snapshot.results !== undefined ? snapshot.results : state.resultsData,
    auditVerifiedSites: snapshot.auditState !== undefined ? snapshot.auditState.verifiedSites : state.auditVerifiedSites,
    auditUrlOverrides: snapshot.auditState !== undefined ? snapshot.auditState.urlOverrides : state.auditUrlOverrides,
    runManifest: snapshot.runManifest !== undefined ? snapshot.runManifest : state.runManifest,
    folderBytes: snapshot.folderBytes !== undefined ? snapshot.folderBytes : state.folderBytes,
    annotationStats: snapshot.annotationStats !== undefined ? (snapshot.annotationStats ?? null) : state.annotationStats,
    annotationRunState: snapshot.annotationStats !== undefined
      ? (snapshot.annotationRunState ?? emptyAnnotationRunState())
      : state.annotationRunState,
    hasRun: mergeHasRun ? state.hasRun || snapshot.hasAnyResults : snapshot.hasAnyResults,
    progress: mergeProgress ? Math.max(state.progress, snapshot.progress) : snapshot.progress,
  }
}

export function useWorkspaceData() {
  const [workspaceData, setWorkspaceData] = useState<WorkspaceDataState>(createEmptyWorkspaceDataState())

  const resetWorkspaceData = useCallback(() => {
    setWorkspaceData((prev) => ({
      ...createEmptyWorkspaceDataState(),
      runRecords: prev.runRecords,
    }))
  }, [])

  const applyWorkspaceSnapshot = useCallback((
    snapshot: WorkspaceSnapshot,
    options?: ApplyWorkspaceSnapshotOptions,
  ) => {
    setWorkspaceData((prev) => applyWorkspaceSnapshotState(prev, snapshot, options))
  }, [])

  const updateWorkspaceData = useCallback((
    updater: WorkspaceDataUpdate,
  ) => {
    setWorkspaceData((prev) => (
      typeof updater === 'function'
        ? updater(prev)
        : { ...prev, ...updater }
    ))
  }, [])

  return {
    workspaceData,
    resetWorkspaceData,
    applyWorkspaceSnapshot,
    updateWorkspaceData,
  }
}
