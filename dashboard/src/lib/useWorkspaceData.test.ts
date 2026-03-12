import { describe, expect, it } from 'vitest'

import { applyWorkspaceSnapshotState, createEmptyWorkspaceDataState } from './useWorkspaceData'

describe('useWorkspaceData helpers', () => {
  it('creates an empty workspace state', () => {
    const state = createEmptyWorkspaceDataState()
    expect(state.hasRun).toBe(false)
    expect(state.progress).toBe(0)
    expect(state.runRecords).toEqual([])
    expect(state.auditVerifiedSites).toEqual([])
  })

  it('applies snapshots with merge semantics for progress and hasRun', () => {
    const next = applyWorkspaceSnapshotState(
      {
        ...createEmptyWorkspaceDataState(),
        hasRun: true,
        progress: 65,
        explorerData: [{ site: 'docker.com', rank: 1, status: 'ok', policyUrl: null, extractionMethod: null, thirdParties: [] }],
      },
      {
        summary: null,
        state: null,
        hasAnyResults: false,
        progress: 40,
        totalSites: 10,
        processedSites: 4,
        missingOutputDir: false,
        annotationStats: null,
        annotationRunState: undefined,
      },
      {
        mergeHasRun: true,
        mergeProgress: true,
      },
    )

    expect(next.hasRun).toBe(true)
    expect(next.progress).toBe(65)
    expect(next.explorerData?.[0]?.site).toBe('docker.com')
  })
})
