export type EtaProgressSample = {
  processedSites: number
  totalSites: number
  timestampMs: number
}

type EstimateRemainingMsArgs = {
  processedSites: number
  totalSites: number
  samples: EtaProgressSample[]
  startedAtMs?: number | null
  nowMs?: number
}

const ETA_HISTORY_WINDOW_MS = 6 * 60 * 60 * 1000
const ETA_RECENT_WINDOW_MS = 15 * 60 * 1000
const ETA_MAX_SAMPLES = 180
const MIN_RATE_SAMPLE_SEC = 30
const MIN_RECENT_DELTA_SITES = 2

export function parseEtaTimestamp(value?: string | null): number | null {
  if (!value) return null
  const timestampMs = Date.parse(value)
  return Number.isFinite(timestampMs) ? timestampMs : null
}

function trimHistory(samples: EtaProgressSample[]): EtaProgressSample[] {
  const latestTimestampMs = samples[samples.length - 1]?.timestampMs
  if (!latestTimestampMs) return samples.slice(-ETA_MAX_SAMPLES)
  return samples
    .filter((sample) => latestTimestampMs - sample.timestampMs <= ETA_HISTORY_WINDOW_MS)
    .slice(-ETA_MAX_SAMPLES)
}

export function recordEtaProgress(samples: EtaProgressSample[], sample: EtaProgressSample): EtaProgressSample[] {
  if (!Number.isFinite(sample.totalSites) || sample.totalSites <= 0) return samples
  if (!Number.isFinite(sample.processedSites) || sample.processedSites < 0) return samples
  if (!Number.isFinite(sample.timestampMs) || sample.timestampMs <= 0) return samples

  const nextSample: EtaProgressSample = {
    processedSites: Math.max(0, Math.floor(sample.processedSites)),
    totalSites: Math.max(1, Math.floor(sample.totalSites)),
    timestampMs: Math.floor(sample.timestampMs),
  }

  const last = samples[samples.length - 1]
  if (!last) return [nextSample]

  if (nextSample.processedSites < last.processedSites) {
    return [nextSample]
  }

  if (
    nextSample.processedSites === last.processedSites
    && nextSample.totalSites === last.totalSites
  ) {
    if (nextSample.timestampMs <= last.timestampMs) return samples
    return trimHistory([...samples.slice(0, -1), nextSample])
  }

  if (nextSample.timestampMs <= last.timestampMs) {
    nextSample.timestampMs = last.timestampMs + 1
  }

  return trimHistory([...samples, nextSample])
}

function computeRatePerSecond(current: EtaProgressSample, baseline: EtaProgressSample): number | null {
  const deltaSites = current.processedSites - baseline.processedSites
  const deltaSec = (current.timestampMs - baseline.timestampMs) / 1000
  if (deltaSites <= 0 || deltaSec < MIN_RATE_SAMPLE_SEC) return null
  return deltaSites / deltaSec
}

export function estimateRemainingMs({
  processedSites,
  totalSites,
  samples,
  startedAtMs,
  nowMs = Date.now(),
}: EstimateRemainingMsArgs): number | null {
  if (!Number.isFinite(totalSites) || totalSites <= 0) return null
  if (!Number.isFinite(processedSites) || processedSites < 0) return null

  const remainingSites = Math.max(0, totalSites - processedSites)
  if (remainingSites <= 0) return 0

  const currentSample = samples[samples.length - 1]
  const currentTimestampMs = Math.max(currentSample?.timestampMs ?? 0, Number.isFinite(nowMs) ? nowMs : 0)
  const effectiveSamples = currentSample
    ? recordEtaProgress(samples, { processedSites, totalSites, timestampMs: currentTimestampMs })
    : [{ processedSites, totalSites, timestampMs: currentTimestampMs }]

  const latest = effectiveSamples[effectiveSamples.length - 1]
  if (!latest || latest.processedSites <= 0) return null

  const recentCutoffMs = latest.timestampMs - ETA_RECENT_WINDOW_MS
  const recentCandidates = effectiveSamples.filter((sample) => (
    sample.timestampMs >= recentCutoffMs
    && sample.processedSites < latest.processedSites
  ))

  let recentRatePerSec: number | null = null
  for (const candidate of recentCandidates) {
    const deltaSites = latest.processedSites - candidate.processedSites
    if (deltaSites < MIN_RECENT_DELTA_SITES) continue
    recentRatePerSec = computeRatePerSecond(latest, candidate)
    if (recentRatePerSec) break
  }

  if (!recentRatePerSec && recentCandidates.length > 0) {
    recentRatePerSec = computeRatePerSecond(latest, recentCandidates[0])
  }

  let lifetimeRatePerSec: number | null = null
  if (startedAtMs && startedAtMs > 0 && latest.timestampMs > startedAtMs) {
    lifetimeRatePerSec = computeRatePerSecond(latest, {
      processedSites: 0,
      totalSites: latest.totalSites,
      timestampMs: startedAtMs,
    })
  }

  const ratePerSec = recentRatePerSec && lifetimeRatePerSec
    ? (recentRatePerSec * 0.7) + (lifetimeRatePerSec * 0.3)
    : recentRatePerSec ?? lifetimeRatePerSec

  if (!ratePerSec || ratePerSec <= 0) return null
  return Math.ceil((remainingSites / ratePerSec) * 1000)
}

export function formatEtaDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}
