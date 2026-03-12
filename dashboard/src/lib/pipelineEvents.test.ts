import { describe, expect, it } from 'vitest'

import { normalizePipelineEvent } from './pipelineEvents'

describe('normalizePipelineEvent', () => {
  it('normalizes a complete pipeline envelope', () => {
    const event = normalizePipelineEvent({
      id: 14,
      channel: 'annotator:stream',
      timestamp: '2026-03-12T04:00:00+00:00',
      runId: 'run-1',
      site: 'docker.com',
      phase: 'extracting',
      message: 'docker.com: extracting statements',
      metrics: { statements: 3 },
      payload: { type: 'annotation.progress' },
    })

    expect(event).toEqual({
      id: 14,
      channel: 'annotator:stream',
      timestamp: '2026-03-12T04:00:00+00:00',
      runId: 'run-1',
      site: 'docker.com',
      phase: 'extracting',
      message: 'docker.com: extracting statements',
      metrics: { statements: 3 },
      payload: { type: 'annotation.progress' },
    })
  })

  it('rejects invalid envelopes', () => {
    expect(normalizePipelineEvent(null)).toBeNull()
    expect(normalizePipelineEvent({ channel: 'annotator:log' })).toBeNull()
  })
})
