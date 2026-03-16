import { useEffect, useState } from 'react'

import type {
  CatalogBucket,
  CatalogFacetResponse,
  CatalogMetricsResponse,
  CatalogQueryItem,
  CatalogQueryRequest,
} from '../../contracts/api'
import { CATEGORY_ORDER } from '../../utils/trackerCategories'
import { BentoCard, BentoGrid } from '../ui/BentoCard'
import { StatusPill } from '../ui/StatusPill'

type CatalogViewProps = {
  bridgeReady: boolean
}

const SITE_STATUSES = ['ok', 'policy_not_found', 'home_fetch_failed', 'non_browsable', 'exception']
const SORT_OPTIONS = [
  { value: 'site_asc', label: 'Site A-Z' },
  { value: 'rank_asc', label: 'Rank asc' },
  { value: 'rank_desc', label: 'Rank desc' },
  { value: 'word_count_desc', label: 'Word count' },
  { value: 'third_party_count_desc', label: '3P count' },
  { value: 'updated_desc', label: 'Updated' },
]

function toggleValue(list: string[], value: string) {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

function bucketMap(items?: CatalogBucket[]) {
  return new Map((items || []).map((item) => [item.name, item.count]))
}

function fmtRatio(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

export function CatalogView({ bridgeReady }: CatalogViewProps) {
  const [items, setItems] = useState<CatalogQueryItem[]>([])
  const [total, setTotal] = useState(0)
  const [facets, setFacets] = useState<CatalogFacetResponse | null>(null)
  const [metrics, setMetrics] = useState<CatalogMetricsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [reindexing, setReindexing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [siteStatuses, setSiteStatuses] = useState<string[]>(['ok'])
  const [siteCategoriesAny, setSiteCategoriesAny] = useState<string[]>([])
  const [firstPartyEnglish, setFirstPartyEnglish] = useState(true)
  const [firstPartyWordCountMin, setFirstPartyWordCountMin] = useState('100')
  const [requiresThirdPartyPolicy, setRequiresThirdPartyPolicy] = useState(false)
  const [requiresThirdPartyEnglishPolicy, setRequiresThirdPartyEnglishPolicy] = useState(true)
  const [thirdPartyCategoriesAny, setThirdPartyCategoriesAny] = useState<string[]>([])
  const [thirdPartyDomain, setThirdPartyDomain] = useState('')
  const [entity, setEntity] = useState('')
  const [sort, setSort] = useState('third_party_count_desc')

  const request: CatalogQueryRequest = {
    siteStatuses,
    siteCategoriesAny,
    firstPartyEnglish,
    firstPartyWordCountMin: Number(firstPartyWordCountMin) || undefined,
    requiresThirdPartyPolicy,
    requiresThirdPartyEnglishPolicy,
    thirdPartyCategoriesAny,
    thirdPartyDomain: thirdPartyDomain.trim() || undefined,
    entity: entity.trim() || undefined,
    limit: 100,
    offset: 0,
    sort,
  }

  const load = async () => {
    if (!bridgeReady || !window.scraper) return
    setLoading(true)
    setError(null)
    try {
      const [queryRes, facetsRes, metricsRes] = await Promise.all([
        window.scraper.catalogQuery(request),
        window.scraper.catalogFacets(request),
        window.scraper.catalogMetrics(),
      ])
      if (!queryRes?.ok) throw new Error(queryRes?.error || 'query_failed')
      setItems(queryRes.items || [])
      setTotal(Number(queryRes.total || 0))
      setFacets(facetsRes?.ok ? facetsRes : null)
      setMetrics(metricsRes?.ok ? metricsRes : null)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridgeReady])

  const statusCounts = bucketMap(facets?.statuses)
  const serviceCounts = bucketMap(facets?.serviceCategories)
  const siteCounts = bucketMap(facets?.siteCategories)

  return (
    <div className="flex flex-col gap-5">
      <BentoGrid className="grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Runs" value={metrics?.runs ?? 0} detail="Cataloged run folders" />
        <MetricCard label="Sites" value={metrics?.sites ?? 0} detail="Indexed site records" />
        <MetricCard label="Policies" value={metrics?.policyDocuments ?? 0} detail="Deduplicated policy documents" />
        <MetricCard
          label="Qualified"
          value={metrics?.qualifiedEnglishSites ?? 0}
          detail="English first-party + English 3P policy"
        />
      </BentoGrid>

      <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <BentoCard className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Catalog query</p>
              <h2 className="text-sm font-semibold">Structured filters</h2>
            </div>
            <div className="flex items-center gap-2">
              {loading && <StatusPill variant="running" label="loading" />}
              <button
                className="focusable rounded-full border border-[var(--glass-border)] px-3 py-1.5 text-[11px] text-[var(--color-primary)]"
                onClick={() => void load()}
              >
                Run query
              </button>
            </div>
          </div>

          <div className="mt-4 space-y-4">
            <ToggleGroup
              label="Site status"
              values={SITE_STATUSES}
              selected={siteStatuses}
              counts={statusCounts}
              onToggle={(value) => setSiteStatuses((current) => toggleValue(current, value))}
            />

            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">First-party filters</label>
              <div className="mt-2 flex flex-col gap-2">
                <ToggleRow label="English only" checked={firstPartyEnglish} onChange={setFirstPartyEnglish} />
                <label className="flex items-center justify-between gap-3 text-[12px] text-[var(--muted-text)]">
                  <span>Minimum word count</span>
                  <input
                    className="focusable w-24 rounded-lg border border-[var(--border-soft)] bg-black/20 px-3 py-1.5 text-right text-[var(--color-text)]"
                    value={firstPartyWordCountMin}
                    onChange={(event) => setFirstPartyWordCountMin(event.target.value)}
                  />
                </label>
              </div>
            </div>

            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Third-party filters</label>
              <div className="mt-2 flex flex-col gap-2">
                <ToggleRow label="Requires any 3P policy" checked={requiresThirdPartyPolicy} onChange={setRequiresThirdPartyPolicy} />
                <ToggleRow
                  label="Requires English 3P policy"
                  checked={requiresThirdPartyEnglishPolicy}
                  onChange={setRequiresThirdPartyEnglishPolicy}
                />
                <input
                  className="focusable rounded-lg border border-[var(--border-soft)] bg-black/20 px-3 py-2 text-[13px] text-[var(--color-text)]"
                  value={thirdPartyDomain}
                  onChange={(event) => setThirdPartyDomain(event.target.value)}
                  placeholder="Specific service domain, e.g. googleapis.com"
                />
                <input
                  className="focusable rounded-lg border border-[var(--border-soft)] bg-black/20 px-3 py-2 text-[13px] text-[var(--color-text)]"
                  value={entity}
                  onChange={(event) => setEntity(event.target.value)}
                  placeholder="Entity name, e.g. Google LLC"
                />
              </div>
            </div>

            <ToggleGroup
              label="3P categories"
              values={CATEGORY_ORDER}
              selected={thirdPartyCategoriesAny}
              counts={serviceCounts}
              onToggle={(value) => setThirdPartyCategoriesAny((current) => toggleValue(current, value))}
            />

            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Site categories</label>
              <div className="mt-2 flex flex-wrap gap-2">
                {Array.from(siteCounts.entries()).map(([name, count]) => (
                  <button
                    key={name}
                    className={`focusable rounded-full border px-3 py-1 text-[11px] ${
                      siteCategoriesAny.includes(name)
                        ? 'border-[var(--glass-border)] text-[var(--color-primary)]'
                        : 'border-[var(--border-soft)] text-[var(--muted-text)]'
                    }`}
                    onClick={() => setSiteCategoriesAny((current) => toggleValue(current, name))}
                  >
                    {name} · {count}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex items-center justify-between gap-3 text-[12px] text-[var(--muted-text)]">
              <span>Sort</span>
              <select
                className="focusable rounded-lg border border-[var(--border-soft)] bg-black/20 px-3 py-1.5 text-[var(--color-text)]"
                value={sort}
                onChange={(event) => setSort(event.target.value)}
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border-soft)] bg-black/10 px-3 py-3 text-[12px] text-[var(--muted-text)]">
              <span>Warehouse sync lag: {metrics?.warehouseSyncLag ?? 0}</span>
              <button
                className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1 text-[11px] text-[var(--color-warn)] disabled:opacity-50"
                disabled={reindexing}
                onClick={async () => {
                  if (!window.scraper) return
                  setReindexing(true)
                  await window.scraper.catalogReindex()
                  setReindexing(false)
                  await load()
                }}
              >
                {reindexing ? 'Reindexing…' : 'Reindex'}
              </button>
            </div>
          </div>
        </BentoCard>

        <BentoCard className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Catalog results</p>
              <h2 className="text-sm font-semibold">{total.toLocaleString()} matching sites</h2>
            </div>
            {metrics && (
              <p className="text-[12px] text-[var(--muted-text)]">
                dedup {fmtRatio(metrics.dedupRatio)} · p95 query {metrics.latencyMs?.queryP95 ?? 0} ms
              </p>
            )}
          </div>

          {error && (
            <div className="mt-4 rounded-xl border border-[rgba(255,45,149,0.28)] bg-[rgba(255,45,149,0.08)] px-4 py-3 text-sm text-[var(--color-danger)]">
              {error}
            </div>
          )}

          <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--border-soft)] bg-black/10">
            <div className="grid grid-cols-[1.2fr_0.9fr_0.6fr_0.7fr_0.8fr_1fr_0.9fr] gap-2 bg-black/25 px-4 py-2 text-[10px] uppercase tracking-[0.18em] text-[var(--muted-text)]">
              <span>Site</span>
              <span>Category</span>
              <span>Status</span>
              <span>Words</span>
              <span>3P</span>
              <span>Categories</span>
              <span>Artifacts</span>
            </div>
            <div className="max-h-[680px] overflow-y-auto">
              {items.length === 0 && (
                <div className="px-4 py-6 text-sm text-[var(--muted-text)]">No catalog rows match the current filters.</div>
              )}
              {items.map((item) => (
                <div
                  key={`${item.runId}-${item.site}`}
                  className="grid grid-cols-[1.2fr_0.9fr_0.6fr_0.7fr_0.8fr_1fr_0.9fr] gap-2 border-t border-[var(--border-soft)] px-4 py-3 text-[12px]"
                >
                  <div className="min-w-0">
                    <p className="mono truncate text-[var(--color-text)]">{item.site}</p>
                    <p className="mt-1 truncate text-[11px] text-[var(--muted-text)]">{item.outDir}</p>
                  </div>
                  <div className="text-[var(--muted-text)]">{item.mainCategory || '—'}</div>
                  <div className="text-[var(--muted-text)]">{item.status || '—'}</div>
                  <div className="text-[var(--muted-text)]">{item.firstPartyPolicyWordCount.toLocaleString()}</div>
                  <div className="text-[var(--muted-text)]">
                    {item.thirdPartyWithEnglishPolicyCount} en / {item.thirdPartyCount} total
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {item.thirdPartyCategories.slice(0, 4).map((category) => (
                      <span key={category} className="rounded-full border border-[var(--border-soft)] px-2 py-0.5 text-[10px] text-[var(--muted-text)]">
                        {category}
                      </span>
                    ))}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-[11px] text-[var(--muted-text)]">{item.artifactsPath}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </BentoCard>
      </div>
    </div>
  )
}

function MetricCard({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <BentoCard>
      <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted-text)]">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-[var(--color-text)]">{value.toLocaleString()}</p>
      <p className="mt-2 text-[12px] text-[var(--muted-text)]">{detail}</p>
    </BentoCard>
  )
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 text-[12px] text-[var(--muted-text)]">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  )
}

function ToggleGroup({
  label,
  values,
  selected,
  counts,
  onToggle,
}: {
  label: string
  values: string[]
  selected: string[]
  counts: Map<string, number>
  onToggle: (value: string) => void
}) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">{label}</label>
      <div className="mt-2 flex flex-wrap gap-2">
        {values.map((value) => (
          <button
            key={value}
            className={`focusable rounded-full border px-3 py-1 text-[11px] ${
              selected.includes(value)
                ? 'border-[var(--glass-border)] text-[var(--color-primary)]'
                : 'border-[var(--border-soft)] text-[var(--muted-text)]'
            }`}
            onClick={() => onToggle(value)}
          >
            {value} {counts.has(value) ? `· ${counts.get(value)}` : ''}
          </button>
        ))}
      </div>
    </div>
  )
}
