import { describe, expect, it } from 'vitest'

import { resolveSnapshotTargetTotal } from './useWorkspaceController'

describe('useWorkspaceController helpers', () => {
  it('prefers summary and state totals when available', () => {
    expect(resolveSnapshotTargetTotal({
      summary: {
        run_id: 'run-1',
        total_sites: 1200,
        processed_sites: 1000,
        success_rate: 0,
        status_counts: {},
        third_party: { total: 0, unique: 0, mapped: 0, unique_mapped: 0, unique_with_policy: 0, unmapped: 0, no_policy_url: 0 },
        mapping: { mode: 'mixed', radar_mapped: 0, trackerdb_mapped: 0, unmapped: 0 },
        categories: [],
        entities: [],
      },
      state: null,
      hasAnyResults: true,
      progress: 0,
      totalSites: 1200,
      processedSites: 1000,
      missingOutputDir: false,
      runManifest: { version: 1, status: 'running', mode: 'dataset', topN: 999, expectedTotalSites: 999, updatedAt: '2026-03-12T05:00:00+00:00' },
    })).toBe(1200)
  })

  it('falls back to manifest expected totals when summary files are absent', () => {
    expect(resolveSnapshotTargetTotal({
      summary: null,
      state: null,
      hasAnyResults: false,
      progress: 0,
      totalSites: 0,
      processedSites: 0,
      missingOutputDir: false,
      runManifest: { version: 1, status: 'running', mode: 'dataset', expectedTotalSites: 850, updatedAt: '2026-03-12T05:00:00+00:00' },
    })).toBe(850)
  })
})
