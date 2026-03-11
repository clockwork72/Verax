import { baseResults } from '../../data/results'
import { ResultsMetrics } from '../../utils/results'
import { CATEGORY_ORDER } from '../../utils/trackerCategories'

type ResultsViewProps = {
  hasRun: boolean
  progress: number
  topN: string
  metrics: ResultsMetrics
  summary?: any
  sites?: any[]
  useCrux?: boolean
  mappingMode?: 'radar' | 'trackerdb' | 'mixed'
  annotationStats?: any
}

export function ResultsView({
  hasRun,
  progress,
  topN,
  metrics,
  summary,
  useCrux,
  mappingMode,
  annotationStats,
}: ResultsViewProps) {
  if (!hasRun) {
    return (
      <section className="card rounded-2xl p-6">
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">No results</p>
        <h2 className="text-lg font-semibold">There are no results yet</h2>
        <p className="mt-2 text-sm text-[var(--muted-text)]">
          Start a crawl from the Launcher tab to generate results.
        </p>
      </section>
    )
  }

  const hasSummary = Boolean(summary)
  const statusCounts = summary?.status_counts || {}
  const statusOk = statusCounts.ok ?? (hasSummary ? 0 : metrics.statusOk)
  const statusPolicyNotFound = statusCounts.policy_not_found ?? (hasSummary ? 0 : metrics.statusPolicyNotFound)
  const statusNonBrowsable = statusCounts.non_browsable ?? (hasSummary ? 0 : metrics.statusNonBrowsable)
  const statusHomeFailed = statusCounts.home_fetch_failed ?? (hasSummary ? 0 : metrics.statusHomeFailed)
  const statusTotal = Math.max(1, statusOk + statusPolicyNotFound + statusNonBrowsable + statusHomeFailed)

  const thirdParty = summary?.third_party || {}
  const thirdPartyDetected =
    thirdParty.unique ?? thirdParty.total ?? (hasSummary ? 0 : Math.max(0, metrics.radarMapped + metrics.radarUnmapped))
  const uniqueMapped = thirdParty.unique_mapped ?? (hasSummary ? 0 : metrics.radarMapped)
  const uniqueWithPolicy = thirdParty.unique_with_policy ?? null
  const radarUnmapped = thirdParty.unmapped ?? (hasSummary ? 0 : metrics.radarUnmapped)
  const radarNoPolicy = thirdParty.no_policy_url ?? (hasSummary ? 0 : metrics.radarNoPolicy)
  const englishPolicyCount = summary?.english_policy_count ?? null

  const rawCategories: { name: string; count: number }[] =
    summary?.categories || (hasSummary ? [] : baseResults.categories)
  // Merge counts for categories that share a consolidated label, then sort
  // by canonical order followed by any unknown categories by count desc.
  const summaryCategories = (() => {
    const merged = new Map<string, number>()
    for (const { name, count } of rawCategories) {
      merged.set(name, (merged.get(name) ?? 0) + (count || 0))
    }
    return [...merged.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => {
        const ai = CATEGORY_ORDER.indexOf(a.name)
        const bi = CATEGORY_ORDER.indexOf(b.name)
        if (ai !== -1 && bi !== -1) return ai - bi
        if (ai !== -1) return -1
        if (bi !== -1) return 1
        return b.count - a.count
      })
  })()
  const summaryEntities = summary?.entities || (hasSummary ? [] : baseResults.entities)
  const categoryMax = summaryCategories.reduce((max: number, cat: any) => Math.max(max, cat.count || 0), 1)
  const entityMax = summaryEntities.reduce((max: number, entity: any) => {
    const prev = entity.prevalence_max ?? entity.prevalence_avg ?? entity.prevalence ?? 0
    return Math.max(max, prev)
  }, 0.0001)
  const mapping = summary?.mapping || {}
  const mappingLabel =
    mapping.mode === 'trackerdb'
      ? 'TrackerDB'
      : mapping.mode === 'mixed'
        ? 'Mixed'
        : mapping.mode === 'radar'
          ? 'Tracker Radar'
          : mappingMode === 'trackerdb'
            ? 'TrackerDB'
            : mappingMode === 'mixed'
              ? 'Mixed'
              : 'Tracker Radar'
  const radarMappedCount = mapping?.radar_mapped ?? null
  const trackerdbMappedCount = mapping?.trackerdb_mapped ?? null
  let mappingRadar = radarMappedCount
  let mappingDb = trackerdbMappedCount
  if (mappingRadar === null && mappingDb === null) {
    if (mappingLabel === 'Tracker Radar') mappingRadar = uniqueMapped
    if (mappingLabel === 'TrackerDB') mappingDb = uniqueMapped
  }
  const mappingTotal = (mappingRadar ?? 0) + (mappingDb ?? 0)
  const mappingUnmapped = mapping?.unmapped ?? Math.max(0, thirdPartyDetected - mappingTotal)
  const radarPct = thirdPartyDetected ? Math.round(((mappingRadar ?? 0) / thirdPartyDetected) * 100) : 0
  const trackerdbPct = thirdPartyDetected ? Math.round(((mappingDb ?? 0) / thirdPartyDetected) * 100) : 0
  const successOk = statusOk
  const unmappedPct = Math.max(0, 100 - radarPct - trackerdbPct)
  const targetSites =
    typeof summary?.total_sites === 'number' ? summary.total_sites : Number(topN) || metrics.totalSitesProcessed

  const InfoTip = ({ text }: { text: string }) => (
    <span className="relative ml-2 inline-flex items-center group">
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-[var(--border-soft)] text-[10px] text-[var(--muted-text)]">
        i
      </span>
      <span className="pointer-events-none absolute left-1/2 top-[1.4rem] z-20 w-56 -translate-x-1/2 rounded-lg border border-[var(--border-soft)] bg-[var(--color-surface)] px-2 py-1 text-[10px] text-[var(--color-text)] opacity-0 shadow transition group-hover:opacity-100">
        {text}
      </span>
    </span>
  )

  const siteStats = [
    {
      label: 'Sites processed',
      value: summary?.processed_sites ?? metrics.totalSitesProcessed,
      info: 'Count of sites that finished processing (any final status).',
    },
    {
      label: 'Target sites',
      value: targetSites,
      info: 'Total sites scheduled for this run after filters (Tranco/CrUX).',
    },
    {
      label: 'Policy found',
      value: successOk,
      info: 'Sites where a first-party privacy policy was found and extracted.',
    },
    {
      label: 'Success rate',
      value: `${summary?.success_rate ?? metrics.successRate}%`,
      info: 'Percent of processed sites where a first-party privacy policy was found.',
    },
    {
      label: 'English policies',
      value: englishPolicyCount,
      info: 'Sites with a first-party policy detected as English-language.',
    },
    {
      label: 'Policy not found',
      value: statusPolicyNotFound,
      info: 'Sites crawled successfully but no privacy policy link was detected.',
    },
    {
      label: 'Non-browsable',
      value: statusNonBrowsable,
      info: 'Sites classified as non-browsable based on error or placeholder signals.',
    },
  ]

  const thirdPartyStats = [
    {
      label: '3P services detected',
      value: thirdPartyDetected,
      info: 'Unique third-party eTLD+1 domains observed across all crawled sites.',
    },
    {
      label: '3P services mapped',
      value: uniqueMapped,
      info: 'Unique third-party domains matched in at least one mapping index (Tracker Radar or TrackerDB).',
    },
    {
      label: '3P with policy URL',
      value: uniqueWithPolicy,
      info: 'Unique mapped third-party domains that provide a privacy policy URL in the index.',
    },
    {
      label: 'Unmapped services',
      value: radarUnmapped,
      info: 'Third-party service occurrences with no record in any mapping index.',
    },
    {
      label: 'No policy URL',
      value: radarNoPolicy,
      info: 'Mapped service occurrences that do not include a policy URL in the index.',
    },
  ]

  return (
    <>
      <section className="card rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Overview</p>
            <h2 className="text-lg font-semibold">Scrape summary</h2>
            <p className="text-xs text-[var(--muted-text)]">
              {progress < 100 ? `Partial results • ${progress.toFixed(0)}% complete` : 'Final results • 100% complete'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="theme-chip rounded-full px-3 py-1 text-xs">Tranco Top {topN}</span>
            {useCrux && <span className="theme-chip rounded-full px-3 py-1 text-xs">CrUX filter on</span>}
            <span className="theme-chip rounded-full px-3 py-1 text-xs">Mapping: {mappingLabel}</span>
            {mapping.mode === 'mixed' && (
              <span className="theme-chip rounded-full px-3 py-1 text-xs">
                Radar {radarMappedCount ?? '—'} • TrackerDB {trackerdbMappedCount ?? '—'}
              </span>
            )}
          </div>
        </div>
        <div className="mt-5 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-[var(--border-soft)] bg-black/20 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Sites</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {siteStats.map((stat) => (
                <div key={stat.label} className="rounded-xl border border-[var(--border-soft)] bg-black/10 px-4 py-3">
                  <p className="flex items-center text-xs text-[var(--muted-text)]">
                    {stat.label}
                    <InfoTip text={stat.info} />
                  </p>
                  <p className="text-lg font-semibold">
                    {stat.value === null || stat.value === undefined
                      ? '—'
                      : typeof stat.value === 'number'
                        ? stat.value.toLocaleString()
                        : stat.value}
                  </p>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-[var(--border-soft)] bg-black/20 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Third‑party services</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {thirdPartyStats.map((stat) => (
                <div key={stat.label} className="rounded-xl border border-[var(--border-soft)] bg-black/10 px-4 py-3">
                  <p className="flex items-center text-xs text-[var(--muted-text)]">
                    {stat.label}
                    <InfoTip text={stat.info} />
                  </p>
                  <p className="text-lg font-semibold">
                    {stat.value === null || stat.value === undefined
                      ? '—'
                      : typeof stat.value === 'number'
                        ? stat.value.toLocaleString()
                        : stat.value}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-4 text-xs text-[var(--muted-text)]">
          <span className="theme-chip rounded-full px-3 py-1">ok {statusOk.toLocaleString()}</span>
          <span className="theme-chip rounded-full px-3 py-1">
            policy not found {statusPolicyNotFound.toLocaleString()}
          </span>
          <span className="theme-chip rounded-full px-3 py-1">
            non-browsable {statusNonBrowsable.toLocaleString()}
          </span>
          <span className="theme-chip rounded-full px-3 py-1">
            home failed {statusHomeFailed.toLocaleString()}
          </span>
        </div>
        <div className="mt-5">
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-black/30">
            <div
              className="h-full bg-[var(--color-success)]"
              style={{ width: `${(statusOk / statusTotal) * 100}%` }}
            />
            <div
              className="h-full bg-[var(--color-warn)]"
              style={{ width: `${(statusPolicyNotFound / statusTotal) * 100}%` }}
            />
            <div
              className="h-full bg-[var(--color-danger)]"
              style={{ width: `${(statusNonBrowsable / statusTotal) * 100}%` }}
            />
            <div
              className="h-full bg-[var(--border-soft)]"
              style={{ width: `${(statusHomeFailed / statusTotal) * 100}%` }}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[var(--muted-text)]">
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[var(--color-success)]" />
              ok
            </span>
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[var(--color-warn)]" />
              policy not found
            </span>
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[var(--color-danger)]" />
              non-browsable
            </span>
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[var(--border-soft)]" />
              home failed
            </span>
            <InfoTip text="The bar shows the share of sites in each final status; colors match the legend." />
          </div>
        </div>
      </section>

      <section className="card rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Coverage</p>
            <h3 className="text-lg font-semibold">Mapping coverage</h3>
            <p className="text-xs text-[var(--muted-text)]">How third‑party services were resolved by mapping source.</p>
          </div>
          <span className="text-xs text-[var(--muted-text)]">
            mapped {Math.max(0, 100 - unmappedPct)}% • unmapped {unmappedPct}%
          </span>
        </div>
        <div className="mt-4 grid gap-6 lg:grid-cols-[220px_1fr]">
          <div className="flex flex-col items-center justify-center gap-3">
            <div className="w-full rounded-2xl border border-[var(--border-soft)] bg-black/20 p-4">
              <div className="flex items-center justify-between text-xs text-[var(--muted-text)]">
                <span>Mapping mode</span>
                <span>{mappingLabel}</span>
              </div>
              <div className="mt-4 flex items-end justify-between">
                <div>
                  <div className="text-3xl font-semibold text-[var(--color-text)]">{Math.max(0, 100 - unmappedPct)}%</div>
                  <div className="text-xs text-[var(--muted-text)]">mapped coverage</div>
                </div>
                <div className="text-xs text-[var(--muted-text)]">{thirdPartyDetected.toLocaleString()} unique services</div>
              </div>
              <div className="mt-3 h-3 overflow-hidden rounded-full bg-black/30">
                <div className="flex h-full w-full">
                  <div className="h-full bg-[var(--color-primary)]" style={{ width: `${radarPct}%` }} />
                  <div className="h-full bg-[var(--color-success)]" style={{ width: `${trackerdbPct}%` }} />
                  <div className="h-full bg-[var(--border-soft)]" style={{ width: `${unmappedPct}%` }} />
                </div>
              </div>
              <div className="mt-3 space-y-2 text-xs text-[var(--muted-text)]">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-[var(--color-primary)]" />
                    Tracker Radar
                  </span>
                  <span>{(mappingRadar ?? 0).toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-[var(--color-success)]" />
                    TrackerDB
                  </span>
                  <span>{(mappingDb ?? 0).toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-[var(--border-soft)]" />
                    Unmapped
                  </span>
                  <span>{mappingUnmapped.toLocaleString()}</span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <InfoTip text="The bar shows what portion of detected third‑party services were matched to Tracker Radar, TrackerDB, or left unmapped." />
                </div>
              </div>
            </div>
            <div className="text-xs text-[var(--muted-text)]">
              {uniqueMapped.toLocaleString()} unique mapped • {radarUnmapped.toLocaleString()} unmapped •{' '}
              {radarNoPolicy.toLocaleString()} no policy URL
            </div>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Categories</p>
            <p className="mt-1 text-[10px] text-[var(--muted-text)]">
              Counts represent unique third-party services (deduplicated), not total occurrences.
            </p>
            <div className="mt-3 space-y-3 text-xs">
              {summaryCategories.map((cat: any) => {
                const count = cat.count ?? 0
                return (
                  <div key={cat.name} className="flex items-center gap-4">
                    <span className="w-36 text-[var(--muted-text)]">{cat.name}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-black/30">
                      <div
                        className="h-full rounded-full bg-[var(--color-primary)]"
                        style={{
                          width: `${Math.min(100, (count / Math.max(1, categoryMax)) * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="text-[var(--muted-text)]">{count.toLocaleString()}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </section>

      {annotationStats && (
        <section className="card rounded-2xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Annotations</p>
              <h3 className="text-lg font-semibold">Policy annotation coverage</h3>
              <p className="text-xs text-[var(--muted-text)]">
                LLM-extracted privacy statements from Stage 2 annotation.
              </p>
            </div>
            <span className="theme-chip rounded-full px-3 py-1 text-xs">
              Stage 2
            </span>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                label: 'Annotated sites',
                value: `${annotationStats.annotated_sites ?? 0} / ${annotationStats.total_sites ?? 0}`,
                info: 'Sites with completed Stage 2 annotation.',
              },
              {
                label: 'Total statements',
                value: (annotationStats.total_statements ?? 0).toLocaleString(),
                info: 'Sum of all privacy statements extracted across all annotated sites.',
              },
              {
                label: 'Avg per site',
                value: annotationStats.annotated_sites
                  ? ((annotationStats.total_statements ?? 0) / annotationStats.annotated_sites).toFixed(1)
                  : '—',
                info: 'Average number of statements extracted per annotated site.',
              },
              {
                label: 'Coverage',
                value: (summary?.processed_sites ?? 0) > 0
                  ? `${Math.round(((annotationStats.annotated_sites ?? 0) / summary.processed_sites) * 100)}%`
                  : '—',
                info: 'Percentage of crawled sites that have been annotated.',
              },
            ].map((stat) => (
              <div key={stat.label} className="rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-3">
                <p className="flex items-center text-xs text-[var(--muted-text)]">
                  {stat.label}
                  <InfoTip text={stat.info} />
                </p>
                <p className="text-lg font-semibold">{stat.value}</p>
              </div>
            ))}
          </div>
          {annotationStats.per_site && annotationStats.per_site.length > 0 && (
            <div className="mt-4">
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Top sites by statement count</p>
              <div className="mt-3 space-y-2 text-xs">
                {[...annotationStats.per_site]
                  .filter((s: any) => s.has_statements)
                  .sort((a: any, b: any) => b.count - a.count)
                  .slice(0, 8)
                  .map((s: any) => {
                    const max = annotationStats.per_site
                      .filter((x: any) => x.has_statements)
                      .reduce((m: number, x: any) => Math.max(m, x.count), 1)
                    return (
                      <div key={s.site} className="flex items-center gap-4">
                        <span className="w-36 truncate text-[var(--muted-text)]">{s.site}</span>
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-black/30">
                          <div
                            className="h-full rounded-full bg-[var(--color-primary)]"
                            style={{ width: `${Math.min(100, (s.count / Math.max(1, max)) * 100)}%` }}
                          />
                        </div>
                        <span className="text-[var(--muted-text)]">{s.count}</span>
                      </div>
                    )
                  })}
              </div>
            </div>
          )}
        </section>
      )}

      <section className="card rounded-2xl p-6">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Entities</p>
          <h3 className="text-lg font-semibold">Entity prevalence distribution</h3>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {summaryEntities.map((entity: any) => {
            const prevalence =
              entity.prevalence_max ?? entity.prevalence_avg ?? entity.prevalence ?? entity.prevalence_avg ?? 0
            const countLabel = entity.count ? `${entity.count} occurrences` : '—'
            return (
              <div key={entity.name} className="rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-semibold">{entity.name}</span>
                  <span className="text-xs text-[var(--muted-text)]">{(prevalence * 100).toFixed(2)}%</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/30">
                  <div
                    className="h-full rounded-full bg-[var(--color-primary)]"
                    style={{
                      width: `${Math.min(100, (prevalence / Math.max(0.0001, entityMax)) * 100)}%`,
                    }}
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--muted-text)]">
                  <span>{entity.categories ? entity.categories.join(' • ') : '—'}</span>
                  <span>{entity.domains ? `${entity.domains} domains` : countLabel}</span>
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </>
  )
}
