import { afterEach, describe, expect, it } from 'vitest'

import { listRunRecords, readFolderSize, readWorkspaceSnapshot } from './scraperClient'

const baseSummary = {
  run_id: 'run-1',
  processed_sites: 0,
  total_sites: 0,
  success_rate: 0,
  status_counts: {},
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
    mode: 'mixed' as const,
    radar_mapped: 0,
    trackerdb_mapped: 0,
    unmapped: 0,
  },
  categories: [],
  entities: [],
}

const baseState = {
  run_id: 'run-1',
  processed_sites: 0,
  total_sites: 0,
  status_counts: {},
  third_party: {
    total: 0,
    mapped: 0,
    unmapped: 0,
    no_policy_url: 0,
  },
  mapping: {
    mode: 'mixed' as const,
    radar_mapped: 0,
    trackerdb_mapped: 0,
    unmapped: 0,
  },
}

function installScraperMock(overrides: Partial<NonNullable<Window['scraper']>>) {
  window.scraper = {
    readSummary: async () => ({ ok: true, data: null }),
    readState: async () => ({ ok: true, data: null }),
    readExplorer: async () => ({ ok: true, data: [] }),
    readResults: async () => ({ ok: true, data: [] }),
    readAuditState: async () => ({ ok: true, data: { verifiedSites: [], urlOverrides: {} } }),
    readRunManifest: async () => ({ ok: true, data: null }),
    annotationStats: async () => ({
      ok: true,
      total_sites: 0,
      annotated_sites: 0,
      total_statements: 0,
      per_site: [],
      tp_total: 0,
      tp_annotated: 0,
      tp_total_statements: 0,
      per_tp: [],
    }),
    getFolderSize: async () => ({ ok: true, bytes: 0 }),
    listRuns: async () => ({ ok: true, runs: [] }),
    ...overrides,
  } as Window['scraper']
}

afterEach(() => {
  delete window.scraper
})

describe('scraperClient', () => {
  it('builds a cleaned workspace snapshot from the scraper bridge', async () => {
    installScraperMock({
      readSummary: async () => ({ ok: true, data: { ...baseSummary, processed_sites: 4, total_sites: 10 } }),
      readState: async () => ({ ok: true, data: { ...baseState, processed_sites: 4, total_sites: 10 } }),
      readExplorer: async () => ({
        ok: true,
        data: [{ site: 'docker.com' }, null, { site: '' }, { site: 'openai.com' }],
      }),
      readResults: async () => ({
        ok: true,
        data: [{ site_etld1: 'docker.com' }, { input: 'openai.com' }, { bad: true }],
      }),
      readAuditState: async () => ({
        ok: true,
        data: { verifiedSites: ['docker.com'], urlOverrides: { 'docker.com': 'https://docker.com/privacy' } },
      }),
      readRunManifest: async () => ({
        ok: true,
        data: { mode: 'tranco', expectedTotalSites: 10, updatedAt: '2026-03-12T05:00:00+00:00', version: 1, status: 'running' },
      }),
      annotationStats: async () => ({
        ok: true,
        total_sites: 2,
        annotated_sites: 1,
        total_statements: 7,
        per_site: [
          { site: 'docker.com', count: 7, has_statements: true, completed: true, status: 'completed', tokens_in: 100, tokens_out: 25 },
          { site: 'openai.com', count: 0, has_statements: false, completed: false, status: 'pending' },
        ],
        tp_total: 0,
        tp_annotated: 0,
        tp_total_statements: 0,
        per_tp: [],
      }),
      getFolderSize: async () => ({ ok: true, bytes: 2048 }),
    })

    const snapshot = await readWorkspaceSnapshot({
      outDir: 'outputs/unified',
      includeFolderSize: true,
      includeExplorer: true,
      includeResults: true,
      includeAudit: true,
      includeManifest: true,
      includeAnnotation: true,
    })

    expect(snapshot.missingOutputDir).toBe(false)
    expect(snapshot.progress).toBe(40)
    expect(snapshot.folderBytes).toBe(2048)
    expect(snapshot.explorer).toEqual([
      {
        site: 'docker.com',
        rank: null,
        status: 'exception',
        policyUrl: null,
        extractionMethod: null,
        thirdParties: [],
      },
      {
        site: 'openai.com',
        rank: null,
        status: 'exception',
        policyUrl: null,
        extractionMethod: null,
        thirdParties: [],
      },
    ])
    expect(snapshot.results).toEqual([{ site_etld1: 'docker.com' }, { input: 'openai.com' }])
    expect(snapshot.auditState).toEqual({
      verifiedSites: ['docker.com'],
      urlOverrides: { 'docker.com': 'https://docker.com/privacy' },
    })
    expect(snapshot.annotationRunState?.completedSites).toBe(1)
    expect(snapshot.annotationRunState?.tokensIn).toBe(100)
  })

  it('marks missing output directories without reading deeper files', async () => {
    installScraperMock({
      getFolderSize: async () => ({ ok: false, error: 'not_found' }),
    })

    const snapshot = await readWorkspaceSnapshot({
      outDir: 'outputs/missing',
      includeFolderSize: true,
      includeExplorer: true,
      includeResults: true,
    })

    expect(snapshot.missingOutputDir).toBe(true)
    expect(snapshot.hasAnyResults).toBe(false)
    expect(snapshot.progress).toBe(0)
  })

  it('reads run listings and folder sizes through the client layer', async () => {
    installScraperMock({
      listRuns: async () => ({
        ok: true,
        runs: [{
          runId: 'run-1',
          folder: 'output_run-1',
          outDir: 'outputs/run-1',
          summary: { ...baseSummary, processed_sites: 2, total_sites: 5, status_counts: { ok: 1 }, success_rate: 50 },
          state: { ...baseState, processed_sites: 2, total_sites: 5, status_counts: { ok: 1 } },
          updated_at: '2026-03-12T05:00:00+00:00',
        }],
      }),
      getFolderSize: async () => ({ ok: true, bytes: 4096 }),
    })

    await expect(listRunRecords('outputs')).resolves.toEqual([{
      runId: 'run-1',
      folder: 'output_run-1',
      outDir: 'outputs/run-1',
      summary: expect.objectContaining({ processed_sites: 2, total_sites: 5 }),
      state: expect.objectContaining({ processed_sites: 2, total_sites: 5 }),
      updated_at: '2026-03-12T05:00:00+00:00',
      started_at: undefined,
    }])
    await expect(readFolderSize('outputs/run-1')).resolves.toEqual({ ok: true, bytes: 4096 })
  })
})
