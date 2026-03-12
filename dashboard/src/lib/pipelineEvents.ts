import type { PipelineEvent } from '../contracts/api'

export function normalizePipelineEvent(raw: unknown): PipelineEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const channel = typeof value.channel === 'string' ? value.channel : null
  const timestamp = typeof value.timestamp === 'string' ? value.timestamp : null
  const payload = value.payload && typeof value.payload === 'object'
    ? value.payload as Record<string, unknown>
    : {}
  if (!channel || !timestamp) return null
  return {
    id: typeof value.id === 'number' ? value.id : undefined,
    channel,
    timestamp,
    runId: typeof value.runId === 'string' ? value.runId : null,
    site: typeof value.site === 'string' ? value.site : null,
    phase: typeof value.phase === 'string' ? value.phase : null,
    message: typeof value.message === 'string' ? value.message : null,
    metrics: value.metrics && typeof value.metrics === 'object'
      ? value.metrics as Record<string, unknown>
      : null,
    payload,
  }
}
