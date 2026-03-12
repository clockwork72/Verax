import { describe, expect, it } from 'vitest'

import { applyAnnotationProgressEvent, annotationRunStateFromStats, emptyAnnotationRunState } from './annotationRunState'

describe('annotationRunState', () => {
  it('builds run state from annotation stats', () => {
    const state = annotationRunStateFromStats({
      ok: true,
      total_sites: 3,
      annotated_sites: 1,
      total_statements: 7,
      per_site: [
        { site: 'docker.com', count: 7, has_statements: true, completed: true, status: 'completed' },
        { site: 'openai.com', count: 0, has_statements: false, completed: false, status: 'pending' },
      ],
      tp_total: 0,
      tp_annotated: 0,
      tp_total_statements: 0,
      per_tp: [],
    })

    expect(state.totalSites).toBe(3)
    expect(state.completedSites).toBe(1)
    expect(state.sites['docker.com']?.statements).toBe(7)
  })

  it('applies structured progress events', () => {
    const next = applyAnnotationProgressEvent(emptyAnnotationRunState(2), {
      channel: 'annotator:progress',
      timestamp: '2026-03-12T05:00:00+00:00',
      payload: {
        type: 'annotation.progress',
        site: 'docker.com',
        status: 'extracting',
        phase: 'extracting',
        message: 'docker.com: extracting',
        metrics: { statements: 2, tokens_in: 100, tokens_out: 20 },
      },
    })

    expect(next.activeSites).toEqual(['docker.com'])
    expect(next.tokensIn).toBe(100)
    expect(next.sites['docker.com']?.statements).toBe(2)
  })
})
