import { describe, expect, it } from 'vitest'

import {
  applyScraperActivitySnapshot,
  applyScraperRuntimeEvent,
  emptyScraperSiteActivityState,
  normalizeScraperExitEvent,
  normalizeScraperMessageEvent,
  normalizeScraperRuntimeEvent,
} from './scraperRuntime'

const STAGE_LABELS = {
  home_fetch: { label: 'Home fetch', index: 0 },
  policy_discovery: { label: 'Policy discovery', index: 1 },
}

describe('scraperRuntime', () => {
  it('normalizes scraper lifecycle events', () => {
    expect(normalizeScraperRuntimeEvent({
      type: 'site_started',
      site: 'docker.com',
      rank: 12,
      timestamp: '2026-03-12T05:00:00+00:00',
    })).toEqual({
      type: 'site_started',
      site: 'docker.com',
      rank: 12,
      timestamp: '2026-03-12T05:00:00+00:00',
      run_id: undefined,
    })

    expect(normalizeScraperRuntimeEvent({ type: 'site_started' })).toBeNull()
  })

  it('reduces site activity state from runtime events', () => {
    const started = applyScraperRuntimeEvent(
      emptyScraperSiteActivityState(),
      { type: 'site_started', site: 'docker.com', rank: 4 },
      STAGE_LABELS,
    )
    const staged = applyScraperRuntimeEvent(
      started,
      { type: 'site_stage', site: 'docker.com', stage: 'policy_discovery', rank: 4 },
      STAGE_LABELS,
    )
    const finished = applyScraperRuntimeEvent(
      staged,
      { type: 'site_finished', site: 'docker.com', status: 'ok', cached: true, annotated: true },
      STAGE_LABELS,
    )

    expect(started.logs).toContain('Processing docker.com')
    expect(staged.activeSites['docker.com']).toEqual({ label: 'Policy discovery', stepIndex: 1, rank: 4 })
    expect(finished.activeSites['docker.com']).toBeUndefined()
    expect(finished.recentCompleted[0]).toEqual({
      site: 'docker.com',
      status: 'ok',
      cached: true,
      annotated: true,
    })
  })

  it('hydrates activity state from a snapshot without clobbering logs', () => {
    const next = applyScraperActivitySnapshot(
      {
        activeSites: {},
        recentCompleted: [],
        logs: ['hello'],
      },
      {
        activeSites: {
          'docker.com': { label: '3P extraction', stepIndex: 2, rank: 4 },
        },
        recentCompleted: [{ site: 'openai.com', status: 'ok', cached: false }],
        running: true,
        currentOutDir: 'outputs/unified',
      },
    )

    expect(next.logs).toEqual(['hello'])
    expect(next.activeSites['docker.com']).toEqual({ label: '3P extraction', stepIndex: 2, rank: 4 })
    expect(next.recentCompleted[0]).toEqual({ site: 'openai.com', status: 'ok', cached: false })
  })

  it('normalizes log and exit payloads', () => {
    expect(normalizeScraperMessageEvent({ message: 'hello' })).toEqual({ message: 'hello' })
    expect(normalizeScraperMessageEvent({})).toBeNull()
    expect(normalizeScraperExitEvent({ code: 2, signal: 'SIGTERM', stop_requested: true })).toEqual({
      code: 2,
      signal: 'SIGTERM',
      stop_requested: true,
    })
  })
})
