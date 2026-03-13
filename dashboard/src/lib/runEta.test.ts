import { describe, expect, it } from 'vitest'

import {
  estimateRemainingMs,
  formatEtaDuration,
  parseEtaTimestamp,
  recordEtaProgress,
} from './runEta'

describe('runEta', () => {
  it('falls back to the real run start time after reconnect', () => {
    const nowMs = Date.parse('2026-03-13T06:40:00Z')
    const startedAtMs = Date.parse('2026-03-13T03:40:00Z')

    const remainingMs = estimateRemainingMs({
      processedSites: 200,
      totalSites: 600,
      samples: [],
      startedAtMs,
      nowMs,
    })

    expect(remainingMs).not.toBeNull()
    expect(formatEtaDuration(remainingMs ?? 0)).toBe('6h 00m')
  })

  it('blends recent throughput with lifetime throughput', () => {
    const nowMs = Date.parse('2026-03-13T06:40:00Z')
    const startedAtMs = Date.parse('2026-03-13T04:40:00Z')
    let samples = [] as ReturnType<typeof recordEtaProgress>

    samples = recordEtaProgress(samples, {
      processedSites: 240,
      totalSites: 600,
      timestampMs: Date.parse('2026-03-13T06:30:00Z'),
    })
    samples = recordEtaProgress(samples, {
      processedSites: 300,
      totalSites: 600,
      timestampMs: nowMs,
    })

    const remainingMs = estimateRemainingMs({
      processedSites: 300,
      totalSites: 600,
      samples,
      startedAtMs,
      nowMs,
    })

    expect(remainingMs).not.toBeNull()
    expect(formatEtaDuration(remainingMs ?? 0)).toBe('1h 00m')
  })

  it('resets progress history when processed sites go backwards', () => {
    const samples = recordEtaProgress([
      {
        processedSites: 120,
        totalSites: 600,
        timestampMs: Date.parse('2026-03-13T06:00:00Z'),
      },
    ], {
      processedSites: 4,
      totalSites: 600,
      timestampMs: Date.parse('2026-03-13T06:05:00Z'),
    })

    expect(samples).toEqual([{
      processedSites: 4,
      totalSites: 600,
      timestampMs: Date.parse('2026-03-13T06:05:00Z'),
    }])
  })

  it('parses valid timestamps and rejects invalid ones', () => {
    expect(parseEtaTimestamp('2026-03-13T06:05:00Z')).toBe(Date.parse('2026-03-13T06:05:00Z'))
    expect(parseEtaTimestamp('not-a-timestamp')).toBeNull()
  })
})
