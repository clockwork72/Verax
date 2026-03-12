import type { AnnotationStats, HpcBridgeStatus, PipelineEvent } from '../contracts/api'
import { normalizePipelineEvent } from './pipelineEvents'

export async function readBridgeStatus(): Promise<{ ok: boolean; data?: HpcBridgeStatus; error?: string }> {
  if (!window.scraper?.checkTunnel) {
    return { ok: false, error: 'checkTunnel unavailable' }
  }
  const result = await window.scraper.checkTunnel()
  return result?.ok
    ? { ok: true, data: result.data }
    : { ok: false, error: result?.error || 'bridge_check_failed', data: result?.data }
}

export async function readAnnotationStats(artifactsDir?: string): Promise<AnnotationStats | null> {
  if (!window.scraper?.annotationStats) return null
  const result = await window.scraper.annotationStats(artifactsDir)
  return result?.ok ? result as AnnotationStats : null
}

export function subscribePipelineEvents(callback: (event: PipelineEvent) => void): (() => void) | null {
  if (!window.scraper?.onPipelineEvent) return null
  const handler = (raw: unknown) => {
    const event = normalizePipelineEvent(raw)
    if (event) callback(event)
  }
  window.scraper.onPipelineEvent(handler)
  return () => {}
}
