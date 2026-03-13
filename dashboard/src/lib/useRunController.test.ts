import { describe, expect, it, vi } from 'vitest'

import { buildAnnotationBlock, buildStartRunPlan } from './useRunController'

describe('useRunController helpers', () => {
  it('builds continue-run options for pending append_sites manifests', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-1111-1111-111111111111')

    const plan = buildStartRunPlan({
      scraperActive: false,
      dashboardLocked: false,
      launcherMode: 'continue',
      topN: '1000',
      currentTargetTotal: 1000,
      requestedTargetTotal: 1000,
      mappingMode: 'mixed',
      runsRoot: 'outputs',
      resumeMode: true,
      outDir: 'outputs/unified',
      datasetState: {
        isIncomplete: true,
        manifestMode: 'append_sites',
        pendingManifestSites: ['example.com', 'openai.com'],
        totalSites: 25,
        processedSites: 23,
        uniqueSiteCount: 23,
        lastSuccessfulRank: null,
        manifestTopN: null,
      },
      excludeSameEntity: true,
    })

    expect(plan.blocked).toBe(false)
    expect(plan.runOutDir).toBe('outputs/unified')
    expect(plan.startOptions).toMatchObject({
      sites: ['example.com', 'openai.com'],
      outDir: 'outputs/unified',
      artifactsDir: 'outputs/unified/artifacts',
      runId: '11111111-1111-1111-1111-111111111111',
      expectedTotalSites: 25,
      upsertBySite: true,
      trackerRadarIndex: 'tracker_radar_index.json',
      trackerDbIndex: 'trackerdb_index.json',
      excludeSameEntity: true,
    })
  })

  it('builds extend-run options with resume metadata', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('22222222-2222-2222-2222-222222222222')

    const plan = buildStartRunPlan({
      scraperActive: false,
      dashboardLocked: false,
      launcherMode: 'extend',
      topN: '1200',
      currentTargetTotal: 1000,
      requestedTargetTotal: 1200,
      mappingMode: 'radar',
      runsRoot: 'outputs',
      resumeMode: true,
      outDir: 'outputs/unified',
      datasetState: {
        isIncomplete: false,
        manifestMode: 'dataset',
        pendingManifestSites: [],
        totalSites: 1000,
        processedSites: 1000,
        uniqueSiteCount: 990,
        lastSuccessfulRank: 1500,
        manifestTopN: 1000,
      },
      excludeSameEntity: false,
    })

    expect(plan.blocked).toBe(false)
    expect(plan.startOptions).toMatchObject({
      topN: 200,
      outDir: 'outputs/unified',
      artifactsDir: 'outputs/unified/artifacts',
      runId: '22222222-2222-2222-2222-222222222222',
      resumeAfterRank: 1500,
      expectedTotalSites: 1200,
      upsertBySite: true,
      trackerRadarIndex: 'tracker_radar_index.json',
      trackerDbIndex: undefined,
      excludeSameEntity: false,
    })
  })

  it('builds fresh start options for non-resume runs and requests workspace reset', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('33333333-3333-3333-3333-333333333333')

    const plan = buildStartRunPlan({
      scraperActive: false,
      dashboardLocked: false,
      launcherMode: 'start',
      topN: '250',
      currentTargetTotal: 0,
      requestedTargetTotal: 250,
      mappingMode: 'trackerdb',
      runsRoot: 'outputs',
      resumeMode: false,
      outDir: 'outputs/unified',
      datasetState: {
        isIncomplete: false,
        pendingManifestSites: [],
        totalSites: 0,
        processedSites: 0,
        uniqueSiteCount: 0,
        lastSuccessfulRank: null,
        manifestTopN: null,
      },
      excludeSameEntity: true,
    })

    expect(plan.resetWorkspace).toBe(true)
    expect(plan.runOutDir).toBe('outputs/output_33333333-3333-3333-3333-333333333333')
    expect(plan.startOptions).toMatchObject({
      topN: 250,
      outDir: 'outputs/output_33333333-3333-3333-3333-333333333333',
      artifactsDir: 'outputs/output_33333333-3333-3333-3333-333333333333/artifacts',
      runId: '33333333-3333-3333-3333-333333333333',
      expectedTotalSites: 250,
      trackerRadarIndex: undefined,
      trackerDbIndex: 'trackerdb_index.json',
      excludeSameEntity: true,
    })
  })

  it('returns a clear mismatch message when remote code is outdated', () => {
    const block = buildAnnotationBlock({
      remoteCodeOutdated: true,
      remoteCodeLegacy: false,
      backendStatus: {
        source_rev: 'abc123',
        local_source_rev: 'def456',
      },
    })

    expect(block?.message).toContain('abc123')
    expect(block?.message).toContain('def456')
    expect(block?.error).toContain('Relaunch it before annotating')
  })
})
