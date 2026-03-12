import { describe, expect, it } from 'vitest'

import { buildDatasetState, buildLauncherState } from './useLauncherModel'

describe('useLauncherModel helpers', () => {
  it('derives dataset state from results and manifest metadata', () => {
    const datasetState = buildDatasetState({
      summaryData: {
        total_sites: 10,
        processed_sites: 4,
        success_rate: 50,
        status_counts: { ok: 2, exception: 2 },
        third_party: {
          total: 0,
          unique: 0,
          mapped: 0,
          unique_mapped: 0,
          unique_with_policy: 0,
          unmapped: 0,
          no_policy_url: 0,
        },
        mapping: {
          mode: 'mixed',
          radar_mapped: 0,
          trackerdb_mapped: 0,
          unmapped: 0,
        },
        categories: [],
        entities: [],
      },
      stateData: null,
      resultsData: [
        { site_etld1: 'docker.com', rank: 1, status: 'ok' },
        { input: 'openai.com', rank: 4, status: 'ok' },
      ],
      runManifest: {
        version: 1,
        status: 'running',
        mode: 'append_sites',
        requestedSites: ['docker.com', 'example.com', 'example.com', 'openai.com'],
        expectedTotalSites: 10,
        updatedAt: '2026-03-12T05:00:00+00:00',
      },
    })

    expect(datasetState.totalSites).toBe(10)
    expect(datasetState.processedSites).toBe(4)
    expect(datasetState.uniqueSiteCount).toBe(2)
    expect(datasetState.isIncomplete).toBe(true)
    expect(datasetState.lastSuccessfulRank).toBe(4)
    expect(datasetState.lastSuccessfulSite).toBe('openai.com')
    expect(datasetState.pendingManifestSites).toEqual(['example.com'])
  })

  it('builds launcher state for extend mode and prioritizes the CrUX key gate', () => {
    const launcherState = buildLauncherState({
      datasetState: {
        hasDataset: true,
        totalSites: 1000,
        processedSites: 1000,
        uniqueSiteCount: 998,
        isComplete: true,
        isIncomplete: false,
        progressPct: 100,
        lastSuccessfulRank: 1000,
        lastSuccessfulSite: 'site1000.com',
        pendingManifestSites: [],
        manifestMode: 'tranco',
        manifestTopN: 1000,
        manifestTrancoDate: '2026-03-11',
        manifestCruxFilter: true,
      },
      topN: '1200',
      resumeMode: true,
      useCrux: true,
      cruxApiKey: '',
      dashboardLocked: false,
      outDir: 'outputs/unified',
    })

    expect(launcherState.launcherMode).toBe('extend')
    expect(launcherState.currentTargetTotal).toBe(1000)
    expect(launcherState.requestedTargetTotal).toBe(1200)
    expect(launcherState.extensionDelta).toBe(200)
    expect(launcherState.cruxKeyMissing).toBe(true)
    expect(launcherState.launcherActionHint).toContain('Enter a CrUX API key')
  })

  it('shows the extend-run hint once the CrUX requirement is satisfied', () => {
    const launcherState = buildLauncherState({
      datasetState: {
        hasDataset: true,
        totalSites: 1000,
        processedSites: 1000,
        uniqueSiteCount: 998,
        isComplete: true,
        isIncomplete: false,
        progressPct: 100,
        lastSuccessfulRank: 1000,
        lastSuccessfulSite: 'site1000.com',
        pendingManifestSites: [],
        manifestMode: 'tranco',
        manifestTopN: 1000,
        manifestTrancoDate: '2026-03-11',
        manifestCruxFilter: true,
      },
      topN: '1200',
      resumeMode: true,
      useCrux: true,
      cruxApiKey: 'secret',
      dashboardLocked: false,
      outDir: 'outputs/unified',
    })

    expect(launcherState.cruxKeyMissing).toBe(false)
    expect(launcherState.launcherActionHint).toContain('Extend outputs/unified from 1000 to 1200')
  })
})
