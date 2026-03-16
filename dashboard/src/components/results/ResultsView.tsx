import { motion, useReducedMotion } from 'framer-motion'
import { useMemo } from 'react'
import type {
  AnnotationSiteRecord,
  ResultRecord,
  AnnotationStats,
  RunMappingSummary,
  RunSummary,
  RunSummaryCategory,
  RunSummaryEntity,
} from '../../contracts/api'
import type { ExplorerSite } from '../../data/explorer'
import { ResultsMetrics } from '../../utils/results'
import { deriveLiveRunSummary, resolveRunSummary } from '../../utils/liveRunSummary'
import { CATEGORY_ORDER } from '../../utils/trackerCategories'
import { BentoCard, BentoGrid } from '../ui/BentoCard'
import { AnimatedCounter } from '../ui/AnimatedCounter'
import { StatusPill } from '../ui/StatusPill'

type ResultsViewProps = {
  hasRun: boolean
  progress: number
  topN: string
  lastDatasetRank?: number | null
  metrics: ResultsMetrics
  summary?: RunSummary | null
  records?: ResultRecord[]
  sites?: ExplorerSite[]
  mappingMode?: 'radar' | 'trackerdb' | 'mixed'
  annotationStats?: AnnotationStats | null
}

// Animated bar: width transitions from 0 to target on mount
function AnimBar({ pct, color = 'var(--color-primary)' }: { pct: number; color?: string }) {
  const reduce = useReducedMotion()
  return (
    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/30">
      <motion.div
        className="h-full rounded-full"
        style={{ background: color }}
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={reduce ? { duration: 0 } : { duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
      />
    </div>
  )
}

// Mapping arc SVG
function MappingArc({ pct }: { pct: number }) {
  const size = 88
  const r = (size - 10) / 2
  const circ = 2 * Math.PI * r
  const dash = circ * (pct / 100)
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={6} />
      <circle
        cx={size / 2} cy={size / 2} r={r}
        fill="none" stroke="var(--color-primary)" strokeWidth={6} strokeLinecap="round"
        strokeDasharray={`${dash} ${circ}`}
        style={{ transition: 'stroke-dasharray 0.9s cubic-bezier(0.22,1,0.36,1)', filter: 'drop-shadow(0 0 4px rgba(0,230,255,0.5))' }}
      />
    </svg>
  )
}

const InfoTip = ({ text }: { text: string }) => (
  <span className="relative ml-1.5 inline-flex items-center group cursor-default">
    <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-[var(--border-soft)] text-[9px] text-[var(--muted-text)] leading-none">i</span>
    <span className="pointer-events-none absolute left-1/2 top-[1.3rem] z-20 w-52 -translate-x-1/2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[10px] text-[var(--color-text)] opacity-0 shadow-xl transition-opacity group-hover:opacity-100">
      {text}
    </span>
  </span>
)

export function ResultsView({
  hasRun,
  progress,
  topN,
  lastDatasetRank = null,
  metrics,
  summary,
  records,
  sites,
  mappingMode,
  annotationStats,
}: ResultsViewProps) {
  const fallbackThirdParty = { total: 0, mapped: 0, unmapped: 0, no_policy_url: 0, unique: 0, unique_mapped: 0, unique_with_policy: 0 }
  const fallbackMapping: RunMappingSummary = { mode: null, radar_mapped: 0, trackerdb_mapped: 0, unmapped: 0 }

  if (!hasRun) {
    return (
      <BentoCard>
        <p className="text-[11px] uppercase tracking-[0.15em] text-[var(--muted-text)]">No results</p>
        <h2 className="mt-0.5 text-sm font-semibold">No results yet</h2>
        <p className="mt-1 text-[12px] text-[var(--muted-text)]">Start a crawl from the Launcher tab.</p>
      </BentoCard>
    )
  }

  const liveSummary = useMemo(() => deriveLiveRunSummary(records, sites), [records, sites])
  const effectiveSummary = useMemo(
    () => resolveRunSummary(summary, liveSummary, mappingMode),
    [liveSummary, mappingMode, summary],
  )
  const statusCounts = effectiveSummary?.status_counts || {}
  const statusOk = statusCounts.ok ?? (effectiveSummary ? 0 : metrics.statusOk)
  const statusPolicyNotFound = statusCounts.policy_not_found ?? (effectiveSummary ? 0 : metrics.statusPolicyNotFound)
  const statusNonBrowsable = statusCounts.non_browsable ?? (effectiveSummary ? 0 : metrics.statusNonBrowsable)
  const statusHomeFailed = statusCounts.home_fetch_failed ?? (effectiveSummary ? 0 : metrics.statusHomeFailed)
  const statusTotal = Math.max(1, statusOk + statusPolicyNotFound + statusNonBrowsable + statusHomeFailed)

  const thirdParty = effectiveSummary?.third_party ?? fallbackThirdParty
  const thirdPartyDetected = thirdParty.unique ?? thirdParty.total ?? 0
  const uniqueMapped = thirdParty.unique_mapped ?? 0
  const uniqueWithPolicy = thirdParty.unique_with_policy ?? null
  const radarNoPolicy = thirdParty.no_policy_url ?? 0
  const englishPolicyCount = effectiveSummary?.english_policy_count ?? null
  const siteCategories: RunSummaryCategory[] = effectiveSummary?.site_categories ?? []

  const rawCategories: RunSummaryCategory[] = effectiveSummary?.categories ?? []
  const summaryCategories = (() => {
    const merged = new Map<string, number>()
    for (const { name, count } of rawCategories) merged.set(name, (merged.get(name) ?? 0) + (count || 0))
    return [...merged.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => {
        const ai = CATEGORY_ORDER.indexOf(a.name), bi = CATEGORY_ORDER.indexOf(b.name)
        if (ai !== -1 && bi !== -1) return ai - bi
        if (ai !== -1) return -1
        if (bi !== -1) return 1
        return b.count - a.count
      })
  })()
  const summaryEntities: RunSummaryEntity[] = effectiveSummary?.entities ?? []
  const siteCategoryMax = siteCategories.reduce((max: number, cat: RunSummaryCategory) => Math.max(max, cat.count || 0), 1)
  const categoryMax = summaryCategories.reduce((max: number, cat: RunSummaryCategory) => Math.max(max, cat.count || 0), 1)
  const entityMax = summaryEntities.reduce((max: number, e: RunSummaryEntity) => {
    return Math.max(max, e.prevalence_max ?? e.prevalence_avg ?? e.prevalence ?? 0)
  }, 0.0001)

  const mapping = effectiveSummary?.mapping ?? fallbackMapping
  const mappingLabel = mapping.mode === 'trackerdb' ? 'TrackerDB' : mapping.mode === 'mixed' ? 'Mixed' : mapping.mode === 'radar' ? 'Tracker Radar'
    : mappingMode === 'trackerdb' ? 'TrackerDB' : mappingMode === 'mixed' ? 'Mixed' : 'Tracker Radar'

  // Prefer unique per-source counts (new backend fields); fall back to
  // proportional estimate from raw occurrence counts so old summaries
  // still render sensible numbers.
  let mappingRadar: number
  let mappingDb: number
  let mappingUnmapped: number

  if (typeof mapping.unique_radar_mapped === 'number' || typeof mapping.unique_trackerdb_mapped === 'number') {
    // New-style summary with unique per-source counts
    mappingRadar = mapping.unique_radar_mapped ?? 0
    mappingDb = mapping.unique_trackerdb_mapped ?? 0
    mappingUnmapped = mapping.unique_unmapped ?? Math.max(0, thirdPartyDetected - mappingRadar - mappingDb)
  } else {
    // Legacy summary: proportionally distribute unique count using the
    // raw occurrence ratio so bars never exceed the unique total.
    const rawTotal = (mapping.radar_mapped ?? 0) + (mapping.trackerdb_mapped ?? 0) + (mapping.unmapped ?? 0)
    if (rawTotal > 0 && thirdPartyDetected > 0) {
      mappingRadar = Math.round(thirdPartyDetected * (mapping.radar_mapped ?? 0) / rawTotal)
      mappingDb = Math.round(thirdPartyDetected * (mapping.trackerdb_mapped ?? 0) / rawTotal)
      mappingUnmapped = Math.max(0, thirdPartyDetected - mappingRadar - mappingDb)
    } else {
      mappingRadar = uniqueMapped
      mappingDb = 0
      mappingUnmapped = Math.max(0, thirdPartyDetected - mappingRadar)
    }
  }

  const radarPct = thirdPartyDetected ? Math.round((mappingRadar / thirdPartyDetected) * 100) : 0
  const trackerdbPct = thirdPartyDetected ? Math.round((mappingDb / thirdPartyDetected) * 100) : 0
  const unmappedPct = Math.max(0, 100 - radarPct - trackerdbPct)
  const mappedPct = Math.max(0, 100 - unmappedPct)
  const targetSites = typeof summary?.total_sites === 'number' ? summary.total_sites : Number(topN) || effectiveSummary?.processed_sites || metrics.totalSitesProcessed
  const processedForCoverage = effectiveSummary?.processed_sites ?? 0
  const successRate = effectiveSummary?.success_rate ?? metrics.successRate

  // ── Key metric cards (top row) ──────────────────────────────────
  const keyMetrics = [
    { label: 'Sites processed', value: effectiveSummary?.processed_sites ?? metrics.totalSitesProcessed, suffix: '', info: 'Sites that finished processing (any final status).' },
    { label: '3P services', value: thirdPartyDetected, suffix: '', info: 'Unique third-party eTLD+1 domains observed.' },
    { label: 'Success rate', value: successRate, suffix: '%', info: 'Sites where a first-party policy was found.' },
    { label: 'Mapped 3P', value: uniqueMapped, suffix: '', info: 'Unique third-party domains matched in a mapping index.' },
  ]

  return (
    <div className="flex flex-col gap-5">
      {/* ── Row 1: Key metric cards ─────────────────────────────── */}
      <BentoGrid className="grid-cols-2 lg:grid-cols-4">
        {keyMetrics.map((m) => (
          <BentoCard key={m.label}>
            <p className="text-[11px] text-[var(--muted-text)] flex items-center">
              {m.label}<InfoTip text={m.info} />
            </p>
            <p className="mt-2 text-2xl font-bold tracking-tight text-[var(--color-text)]">
              <AnimatedCounter value={typeof m.value === 'number' ? m.value : 0} suffix={m.suffix} />
            </p>
          </BentoCard>
        ))}
      </BentoGrid>

      {/* ── Run header chips ────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 px-0.5">
        <span className="text-[11px] text-[var(--muted-text)]">
          {progress < 100 ? `${progress.toFixed(0)}% complete` : 'Completed'}
        </span>
        <span className="theme-chip rounded-full px-2.5 py-0.5 text-[11px]">Target {topN} sites</span>
        {lastDatasetRank
          ? <span className="theme-chip rounded-full px-2.5 py-0.5 text-[11px]">Last dataset rank #{lastDatasetRank}</span>
          : null}
        <span className="theme-chip rounded-full px-2.5 py-0.5 text-[11px]">Mapping: {mappingLabel}</span>
        <StatusPill variant={progress >= 100 ? 'ok' : 'running'} label={progress >= 100 ? 'done' : 'in progress'} />
      </div>

      {/* ── Row 2: Status breakdown + Mapping coverage ──────────── */}
      <BentoGrid className="grid-cols-1 lg:grid-cols-[1fr_1fr]">
        {/* Status breakdown */}
        <BentoCard>
          <p className="mb-3 text-[11px] uppercase tracking-[0.15em] text-[var(--muted-text)]">Status breakdown</p>
          <div className="flex h-2 w-full overflow-hidden rounded-full">
            <div className="h-full bg-[var(--color-success)] transition-all duration-700" style={{ width: `${(statusOk / statusTotal) * 100}%` }} />
            <div className="h-full bg-[var(--color-warn)] transition-all duration-700" style={{ width: `${(statusPolicyNotFound / statusTotal) * 100}%` }} />
            <div className="h-full bg-[var(--color-danger)] transition-all duration-700" style={{ width: `${(statusNonBrowsable / statusTotal) * 100}%` }} />
            <div className="h-full bg-[var(--border-soft)] transition-all duration-700" style={{ width: `${(statusHomeFailed / statusTotal) * 100}%` }} />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 text-[12px]">
            {[
              { label: 'Policy found', value: statusOk, color: 'var(--color-success)' },
              { label: 'Not found', value: statusPolicyNotFound, color: 'var(--color-warn)' },
              { label: 'Non-browsable', value: statusNonBrowsable, color: 'var(--color-danger)' },
              { label: 'Home failed', value: statusHomeFailed, color: 'var(--border-soft)' },
            ].map((s) => (
              <div key={s.label} className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
                <span className="text-[var(--muted-text)]">{s.label}</span>
                <span className="ml-auto font-medium"><AnimatedCounter value={s.value} /></span>
              </div>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 text-[11px]">
            {[
              { label: 'Sites processed', value: effectiveSummary?.processed_sites ?? metrics.totalSitesProcessed, info: 'Count of sites that finished (any final status).' },
              { label: 'Target sites', value: targetSites, info: 'Sites scheduled for this run.' },
              { label: 'English policies', value: englishPolicyCount, info: 'Sites with English-language policy detected.' },
              { label: 'Success rate', value: null, display: `${successRate}%`, info: 'Policy found / processed.' },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-[var(--border-soft)] bg-black/15 px-3 py-2">
                <p className="flex items-center text-[var(--muted-text)]">{s.label}<InfoTip text={s.info} /></p>
                <p className="text-sm font-semibold">
                  {s.display ?? (s.value === null || s.value === undefined ? '—' : <AnimatedCounter value={s.value as number} />)}
                </p>
              </div>
            ))}
          </div>
        </BentoCard>

        {/* Mapping coverage */}
        <BentoCard>
          <p className="mb-3 text-[11px] uppercase tracking-[0.15em] text-[var(--muted-text)]">Mapping coverage</p>
          <div className="flex items-center gap-5">
            <div className="relative flex items-center justify-center">
              <MappingArc pct={mappedPct} />
              <div className="absolute flex flex-col items-center">
                <span className="text-base font-bold leading-none">{mappedPct}%</span>
                <span className="text-[9px] text-[var(--muted-text)]">mapped</span>
              </div>
            </div>
            <div className="flex-1 space-y-2 text-[12px]">
              {[
                { label: 'Tracker Radar', value: mappingRadar ?? 0, pct: radarPct, color: 'var(--color-primary)' },
                { label: 'TrackerDB', value: mappingDb ?? 0, pct: trackerdbPct, color: 'var(--color-success)' },
                { label: 'Unmapped', value: mappingUnmapped, pct: unmappedPct, color: 'var(--border-soft)' },
              ].map((row) => (
                <div key={row.label} className="flex items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: row.color }} />
                  <span className="w-24 text-[var(--muted-text)]">{row.label}</span>
                  <AnimBar pct={row.pct} color={row.color} />
                  <span className="w-10 text-right text-[var(--muted-text)]"><AnimatedCounter value={row.value} /></span>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2 text-[11px]">
            {[
              { label: 'Unique detected', value: thirdPartyDetected, info: 'Unique third-party eTLD+1 domains observed.' },
              { label: 'With policy URL', value: uniqueWithPolicy, info: 'Mapped services providing a policy URL.' },
              { label: 'No policy URL', value: radarNoPolicy, info: 'Mapped occurrences without a policy URL.' },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-[var(--border-soft)] bg-black/15 px-2.5 py-2">
                <p className="flex items-center text-[var(--muted-text)]">{s.label}<InfoTip text={s.info} /></p>
                <p className="text-sm font-semibold">
                  {s.value === null || s.value === undefined ? '—' : <AnimatedCounter value={s.value} />}
                </p>
              </div>
            ))}
          </div>
        </BentoCard>
      </BentoGrid>

      {/* ── Row 3: Dataset categories + 3P categories ───────────── */}
      <BentoGrid className="grid-cols-1 lg:grid-cols-[1fr_1fr]">
        <BentoCard>
          <p className="mb-1 text-[11px] uppercase tracking-[0.15em] text-[var(--muted-text)]">Scraped site categories</p>
          <p className="mb-3 text-[10px] text-[var(--muted-text)]">Distribution by dataset `main_category`</p>
          <div className="space-y-2.5 text-[12px]">
            {siteCategories.map((cat: RunSummaryCategory, i) => {
              const count = cat.count ?? 0
              const pct = Math.min(100, (count / Math.max(1, siteCategoryMax)) * 100)
              return (
                <motion.div
                  key={cat.name}
                  className="flex items-center gap-3"
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.04, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                >
                  <span className="w-40 truncate text-[var(--muted-text)]">{cat.name}</span>
                  <AnimBar pct={pct} color="var(--color-success)" />
                  <span className="w-8 text-right text-[var(--muted-text)]">{count.toLocaleString()}</span>
                </motion.div>
              )
            })}
            {siteCategories.length === 0 && (
              <p className="text-[12px] text-[var(--muted-text)]">No category metadata available for this run yet.</p>
            )}
          </div>
        </BentoCard>

        {/* Categories */}
        <BentoCard>
          <p className="mb-1 text-[11px] uppercase tracking-[0.15em] text-[var(--muted-text)]">3P categories</p>
          <p className="mb-3 text-[10px] text-[var(--muted-text)]">Unique services per category (deduplicated)</p>
          <div className="space-y-2.5 text-[12px]">
            {summaryCategories.map((cat: RunSummaryCategory, i) => {
              const count = cat.count ?? 0
              const pct = Math.min(100, (count / Math.max(1, categoryMax)) * 100)
              return (
                <motion.div
                  key={cat.name}
                  className="flex items-center gap-3"
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.04, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                >
                  <span className="w-32 truncate text-[var(--muted-text)]">{cat.name}</span>
                  <AnimBar pct={pct} />
                  <span className="w-8 text-right text-[var(--muted-text)]">{count.toLocaleString()}</span>
                </motion.div>
              )
            })}
          </div>
        </BentoCard>
      </BentoGrid>

      {/* ── Row 4: Entities ────────────────────────────────────── */}
      <BentoGrid className="grid-cols-1">
        <BentoCard>
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.15em] text-[var(--muted-text)]">Entity prevalence</p>
              <p className="mt-1 text-[12px] text-[var(--muted-text)]">
                All mapped entities ranked by max observed prevalence.
              </p>
            </div>
            <div className="grid shrink-0 grid-cols-2 gap-2 text-right text-[10px]">
              <div className="rounded-lg border border-[var(--border-soft)] bg-black/15 px-2.5 py-2">
                <p className="text-[var(--muted-text)]">Entities</p>
                <p className="mt-0.5 text-sm font-semibold">{summaryEntities.length}</p>
              </div>
              <div className="rounded-lg border border-[var(--border-soft)] bg-black/15 px-2.5 py-2">
                <p className="text-[var(--muted-text)]">Peak</p>
                <p className="mt-0.5 text-sm font-semibold">
                  {summaryEntities[0]
                    ? `${((summaryEntities[0].prevalence_max ?? summaryEntities[0].prevalence_avg ?? summaryEntities[0].prevalence ?? 0) * 100).toFixed(2)}%`
                    : '—'}
                </p>
              </div>
            </div>
          </div>

          {summaryEntities.length === 0 && (
            <p className="text-[12px] text-[var(--muted-text)]">No mapped entity prevalence data is available yet.</p>
          )}

          {summaryEntities.length > 0 && (
            <div className="space-y-2 overflow-y-auto pr-1 xl:max-h-[27rem]">
              {summaryEntities.map((entity: RunSummaryEntity, i) => {
                const prevalence = entity.prevalence_max ?? entity.prevalence_avg ?? entity.prevalence ?? 0
                const pct = Math.min(100, (prevalence / Math.max(0.0001, entityMax)) * 100)
                return (
                  <motion.div
                    key={entity.name}
                    className="rounded-xl border border-[var(--border-soft)] bg-black/10 px-3 py-2"
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: Math.min(i * 0.02, 0.2), duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <div className="mb-1.5 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[12px] font-medium">{entity.name}</p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-[var(--muted-text)]">
                          <span>{entity.domains ? `${entity.domains} domains` : entity.count ? `${entity.count} records` : 'Mapped entity'}</span>
                          {entity.categories.slice(0, 2).map((category) => (
                            <span
                              key={`${entity.name}-${category}`}
                              className="rounded-full border border-[var(--border-soft)] bg-[rgba(255,255,255,0.04)] px-1.5 py-0.5"
                            >
                              {category}
                            </span>
                          ))}
                        </div>
                      </div>
                      <span className="shrink-0 text-[11px] font-semibold text-[var(--muted-text)]">{(prevalence * 100).toFixed(2)}%</span>
                    </div>
                    <AnimBar pct={pct} />
                  </motion.div>
                )
              })}
            </div>
          )}
        </BentoCard>
      </BentoGrid>

      {/* ── Row 5: Annotation coverage (optional) ────────────────── */}
      {annotationStats && (
        <BentoCard>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.15em] text-[var(--muted-text)]">Stage 2</p>
              <h3 className="text-sm font-semibold">Annotation coverage</h3>
            </div>
            <StatusPill variant="ok" label="Stage 2" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: 'Annotated sites', value: annotationStats.annotated_sites ?? 0, suffix: `/${annotationStats.total_sites ?? 0}`, info: 'Sites with completed Stage 2 annotation.' },
              { label: 'Total statements', value: annotationStats.total_statements ?? 0, suffix: '', info: 'Privacy statements extracted across all annotated sites.' },
              { label: 'Avg per site', valueStr: annotationStats.annotated_sites ? ((annotationStats.total_statements ?? 0) / annotationStats.annotated_sites).toFixed(1) : '—', info: 'Average statements per annotated site.' },
              { label: 'Coverage', valueStr: processedForCoverage > 0 ? `${Math.round(((annotationStats.annotated_sites ?? 0) / processedForCoverage) * 100)}%` : '—', info: 'Percentage of crawled sites that have been annotated.' },
            ].map((s) => (
              <div key={s.label} className="rounded-xl border border-[var(--border-soft)] bg-black/15 px-4 py-3">
                <p className="flex items-center text-[11px] text-[var(--muted-text)]">{s.label}<InfoTip text={s.info} /></p>
                <p className="mt-1.5 text-xl font-bold">
                  {'valueStr' in s
                    ? s.valueStr
                    : <><AnimatedCounter value={s.value as number} />{s.suffix}</>
                  }
                </p>
              </div>
            ))}
          </div>
          {annotationStats.per_site && annotationStats.per_site.length > 0 && (
            <div className="mt-5">
              <p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-[var(--muted-text)]">Top sites by statement count</p>
              <div className="space-y-2 text-[12px]">
                {[...annotationStats.per_site]
                  .filter((s: AnnotationSiteRecord) => s.has_statements)
                  .sort((a: AnnotationSiteRecord, b: AnnotationSiteRecord) => b.count - a.count)
                  .slice(0, 8)
                  .map((s: AnnotationSiteRecord) => {
                    const max = annotationStats.per_site.filter((x: AnnotationSiteRecord) => x.has_statements).reduce((m: number, x: AnnotationSiteRecord) => Math.max(m, x.count), 1)
                    return (
                      <div key={s.site} className="flex items-center gap-3">
                        <span className="w-36 truncate text-[var(--muted-text)]">{s.site}</span>
                        <AnimBar pct={Math.min(100, (s.count / Math.max(1, max)) * 100)} />
                        <span className="w-8 text-right text-[var(--muted-text)]">{s.count}</span>
                      </div>
                    )
                  })}
              </div>
            </div>
          )}
        </BentoCard>
      )}
    </div>
  )
}
