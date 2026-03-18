import { describe, expect, it } from 'vitest'

import type { ExplorerSite } from '../data/explorer'
import { deriveLiveRunSummary, resolveRunSummary } from './liveRunSummary'

describe('deriveLiveRunSummary', () => {
  it('derives unique third-party and mapping metrics from result records', () => {
    const summary = deriveLiveRunSummary([
      {
        site_etld1: 'example.com',
        status: 'ok',
        policy_is_english: true,
        third_parties: [
          {
            third_party_etld1: 'google-analytics.com',
            entity: 'Google',
            categories: ['analytics'],
            policy_url: 'https://policies.google.com/privacy',
            prevalence: 0.4,
            tracker_radar_source_domain_file: 'domains/google-analytics.com.json',
          },
          {
            third_party_etld1: 'segment.com',
            entity: 'Segment',
            categories: ['site analytics'],
            trackerdb_source_org_file: 'organizations/segment.json',
          },
        ],
      },
      {
        site_etld1: 'example.org',
        status: 'policy_not_found',
        third_parties: [
          {
            third_party_etld1: 'google-analytics.com',
            entity: 'Google',
            categories: ['audience measurement'],
            policy_url: 'https://policies.google.com/privacy',
            prevalence: 0.2,
            tracker_radar_source_domain_file: 'domains/google-analytics.com.json',
          },
          {
            third_party_etld1: 'unknown-cdn.example',
            categories: [],
          },
        ],
      },
    ], null)

    expect(summary).not.toBeNull()
    expect(summary?.processed_sites).toBe(2)
    expect(summary?.success_rate).toBe(50)
    expect(summary?.english_policy_count).toBe(1)
    expect(summary?.third_party).toEqual({
      total: 4,
      unique: 3,
      mapped: 3,
      unique_mapped: 2,
      unique_with_policy: 1,
      unmapped: 1,
      no_policy_url: 1,
    })
    expect(summary?.mapping).toEqual({
      mode: null,
      radar_mapped: 2,
      trackerdb_mapped: 1,
      unmapped: 1,
      unique_radar_mapped: 1,
      unique_trackerdb_mapped: 1,
      unique_unmapped: 1,
    })
    expect(summary?.categories).toEqual([
      { name: 'Analytics', count: 2 },
    ])
    expect(summary?.entities).toEqual([
      {
        name: 'Google',
        count: 2,
        prevalence_avg: 0.30000000000000004,
        prevalence_max: 0.4,
        categories: ['Analytics'],
      },
      {
        name: 'Segment',
        count: 1,
        prevalence_avg: null,
        prevalence_max: null,
        categories: ['Analytics'],
      },
    ])
  })

  it('dedupes unique service counts by shared policy URL across domains', () => {
    const summary = deriveLiveRunSummary([
      {
        site_etld1: 'example.com',
        status: 'ok',
        policy_is_english: true,
        third_parties: [
          {
            third_party_etld1: 'google-analytics.com',
            entity: 'Google',
            categories: ['analytics'],
            policy_url: 'https://policies.google.com/privacy?hl=en&gl=us',
            tracker_radar_source_domain_file: 'domains/google-analytics.com.json',
          },
          {
            third_party_etld1: 'doubleclick.net',
            entity: 'Google',
            categories: ['advertising'],
            policy_url: 'https://policies.google.com/privacy?hl=en&gl=us',
            tracker_radar_source_domain_file: 'domains/doubleclick.net.json',
          },
        ],
      },
    ], null)

    expect(summary).not.toBeNull()
    expect(summary?.third_party).toEqual({
      total: 2,
      unique: 1,
      mapped: 2,
      unique_mapped: 1,
      unique_with_policy: 1,
      unmapped: 0,
      no_policy_url: 0,
    })
    expect(summary?.mapping).toEqual({
      mode: null,
      radar_mapped: 2,
      trackerdb_mapped: 0,
      unmapped: 0,
      unique_radar_mapped: 1,
      unique_trackerdb_mapped: 0,
      unique_unmapped: 0,
    })
  })

  it('falls back to explorer data when result records are unavailable', () => {
    const sites: ExplorerSite[] = [
      {
        site: 'example.com',
        status: 'ok',
        policyUrl: 'https://example.com/privacy',
        thirdParties: [
          {
            name: 'doubleclick.net',
            entity: 'Google',
            categories: ['advertising'],
            policyUrl: 'https://policies.google.com/privacy',
            prevalence: 0.5,
          },
        ],
      },
    ]

    const summary = deriveLiveRunSummary(null, sites)

    expect(summary?.processed_sites).toBe(1)
    expect(summary?.third_party.unique).toBe(1)
    expect(summary?.third_party.unique_mapped).toBe(1)
    expect(summary?.categories).toEqual([{ name: 'Advertising', count: 1 }])
    expect(summary?.entities[0]).toEqual({
      name: 'Google',
      count: 1,
      prevalence_avg: 0.5,
      prevalence_max: 0.5,
      categories: ['Advertising'],
    })
  })

  it('prefers live result-derived counts when the persisted summary is stale after resume', () => {
    const liveSummary = deriveLiveRunSummary([
      { site_etld1: 'example.com', status: 'ok', third_parties: [] },
      { site_etld1: 'example.org', status: 'policy_not_found', third_parties: [] },
      { site_etld1: 'example.net', status: 'non_browsable', third_parties: [] },
    ], null)

    const resolved = resolveRunSummary({
      run_id: 'run-1',
      total_sites: 1000,
      processed_sites: 2,
      success_rate: 50,
      status_counts: { ok: 1, policy_not_found: 1 },
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
      site_categories: [],
      categories: [],
      entities: [],
      started_at: '2026-03-13T10:00:00+00:00',
      updated_at: '2026-03-13T10:05:00+00:00',
    }, liveSummary, 'mixed')

    expect(resolved).not.toBeNull()
    expect(resolved?.processed_sites).toBe(3)
    expect(resolved?.status_counts).toEqual({
      ok: 1,
      policy_not_found: 1,
      non_browsable: 1,
    })
    expect(resolved?.total_sites).toBe(1000)
    expect(resolved?.mapping.mode).toBe('mixed')
  })
})
