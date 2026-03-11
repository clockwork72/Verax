import { useEffect, useMemo, useState } from 'react'
import { ExplorerSite, ExplorerThirdParty } from '../../data/explorer'
import { normalizeCategories } from '../../utils/trackerCategories'

type ViewerEntry = {
  url: string
  title: string
  meta?: {
    entity?: string | null
    categories?: string[]
    prevalence?: number | null
    extractionMethod?: string | null
    type: 'first-party' | 'third-party'
  }
}

type ExplorerViewProps = {
  hasRun: boolean
  progress: number
  sites?: ExplorerSite[]
  showExtractionMethod?: boolean
  outDir?: string
}

function parseStatementLines(raw: string): any[] {
  return raw
    .split('\n')
    .filter((l: string) => l.trim())
    .map((line: string) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function formatExtractionMethod(value?: string | null) {
  if (!value) return 'Unknown'
  return value === 'trafilatura' ? 'Trafilatura' : 'Fallback'
}

export function ExplorerView({ hasRun, progress, sites, showExtractionMethod = true, outDir }: ExplorerViewProps) {
  const [selectedSite, setSelectedSite] = useState<ExplorerSite | null>(null)
  const [view, setView] = useState<'sites' | 'thirdParties' | 'viewer'>('sites')
  const [detailTab, setDetailTab] = useState<'third-parties' | 'statements'>('third-parties')
  const [statements, setStatements] = useState<any[]>([])
  const [statementsLoading, setStatementsLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | ExplorerSite['status']>('all')
  const [minThirdParties, setMinThirdParties] = useState('')
  const [history, setHistory] = useState<ViewerEntry[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [lastNonViewer, setLastNonViewer] = useState<'sites' | 'thirdParties'>('sites')
  const [viewerError, setViewerError] = useState<string | null>(null)

  const currentEntry = historyIndex >= 0 ? history[historyIndex] : null

  const canGoBack = historyIndex > 0
  const canGoForward = historyIndex >= 0 && historyIndex < history.length - 1

  const openViewer = (entry: ViewerEntry) => {
    setHistory((prev) => {
      const next = prev.slice(0, historyIndex + 1)
      next.push(entry)
      return next
    })
    setHistoryIndex((prev) => prev + 1)
    setLastNonViewer(view === 'viewer' ? lastNonViewer : view)
    setView('viewer')
    setViewerError(null)
  }

  const goBack = () => {
    if (!canGoBack) return
    setHistoryIndex((prev) => Math.max(0, prev - 1))
  }

  const goForward = () => {
    if (!canGoForward) return
    setHistoryIndex((prev) => Math.min(history.length - 1, prev + 1))
  }

  const closeViewer = () => {
    setView(lastNonViewer)
  }

  useEffect(() => {
    if (!currentEntry?.url) return
    setViewerError(null)
  }, [currentEntry?.url])

  useEffect(() => {
    if (detailTab !== 'statements' || !selectedSite || !window.scraper?.readArtifactText) return
    setStatementsLoading(true)
    setStatements([])
    Promise.all([
      window.scraper.readArtifactText({
        outDir: outDir || 'outputs',
        relativePath: `artifacts/${selectedSite.site}/policy_statements_annotated.jsonl`,
      }),
      window.scraper.readArtifactText({
        outDir: outDir || 'outputs',
        relativePath: `artifacts/${selectedSite.site}/policy_statements.jsonl`,
      }),
    ]).then(([annotatedRes, baseRes]: any[]) => {
      const annotated = annotatedRes?.ok && annotatedRes.data ? parseStatementLines(annotatedRes.data) : []
      const fallback = baseRes?.ok && baseRes.data ? parseStatementLines(baseRes.data) : []
      setStatements(annotated.length > 0 ? annotated : fallback)
      setStatementsLoading(false)
    })
  }, [detailTab, selectedSite, outDir])

  const sitesToShow = useMemo(() => {
    const fraction = Math.min(1, Math.max(0, 0.01 * Math.round(progress)))
    const sourceSites = sites ?? []
    const count = Math.round(sourceSites.length * fraction)
    const slice = sourceSites.slice(0, count)
    const normalizedQuery = query.trim().toLowerCase()
    const minThirdPartyCount = Number(minThirdParties)
    return slice.filter((site) => {
      if (statusFilter !== 'all' && site.status !== statusFilter) return false
      const siteThirdParties =
        (site as any).thirdParties?.length ?? (site as any).third_parties?.length ?? 0
      if (Number.isFinite(minThirdPartyCount) && minThirdParties !== '' && siteThirdParties < minThirdPartyCount) {
        return false
      }
      if (!normalizedQuery) return true
      return site.site.toLowerCase().includes(normalizedQuery)
    })
  }, [progress, query, statusFilter, sites, minThirdParties])

  const selectedPolicyUrl =
    (selectedSite as any)?.policyUrl ?? (selectedSite as any)?.policy_url ?? selectedSite?.policyUrl ?? null
  const selectedPolicyMethod =
    (selectedSite as any)?.extractionMethod ?? (selectedSite as any)?.extraction_method ?? selectedSite?.extractionMethod ?? null
  const selectedThirdParties: ExplorerThirdParty[] = ((selectedSite as any)?.thirdParties ??
    (selectedSite as any)?.third_parties ??
    selectedSite?.thirdParties ??
    []) as ExplorerThirdParty[]

  const openPolicyWindow = async () => {
    if (!currentEntry?.url) return
    const response = await window.scraper?.openPolicyWindow(currentEntry.url)
    if (!response?.ok) {
      setViewerError('Unable to open embedded page. Try again or check the URL.')
    }
  }

  if (!hasRun) {
    return (
      <section className="card rounded-2xl p-6">
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">No results</p>
        <h2 className="text-lg font-semibold">Explorer is empty</h2>
        <p className="mt-2 text-sm text-[var(--muted-text)]">
          Run the scraper first to populate the site explorer.
        </p>
      </section>
    )
  }

  return (
    <>
      <section className="card rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Explorer</p>
            <h2 className="text-lg font-semibold">Scraped sites</h2>
          </div>
          <div className="flex items-center gap-2 text-xs text-[var(--muted-text)]">
            <button
              className={`focusable rounded-full border px-3 py-1 ${
                view === 'viewer' && canGoBack
                  ? 'border-[var(--border-soft)]'
                  : 'border-[var(--border-soft)] text-[var(--muted-text)]'
              }`}
              onClick={goBack}
              disabled={view !== 'viewer' || !canGoBack}
            >
              ◀
            </button>
            <button
              className={`focusable rounded-full border px-3 py-1 ${
                view === 'viewer' && canGoForward
                  ? 'border-[var(--border-soft)]'
                  : 'border-[var(--border-soft)] text-[var(--muted-text)]'
              }`}
              onClick={goForward}
              disabled={view !== 'viewer' || !canGoForward}
            >
              ▶
            </button>
            {view !== 'sites' && (
              <button
                className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1"
                onClick={() => setView('sites')}
              >
                Back to sites
              </button>
            )}
            {view === 'thirdParties' && selectedSite && (
              <span className="theme-chip rounded-full px-3 py-1">
                {selectedSite.site} • Rank {selectedSite.rank ?? (selectedSite as any).rank ?? '—'}
              </span>
            )}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          <input
            className="focusable w-64 rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-2 text-sm text-white"
            placeholder="Search by site (e.g. apple.com)"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <input
            type="number"
            min={0}
            className="focusable w-40 rounded-xl border border-[var(--border-soft)] bg-black/20 px-3 py-2 text-sm text-white"
            placeholder="Min 3P"
            value={minThirdParties}
            onChange={(event) => setMinThirdParties(event.target.value)}
          />
          <select
            className="focusable rounded-xl border border-[var(--border-soft)] bg-black/20 px-3 py-2 text-sm text-white"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
          >
            <option value="all">All statuses</option>
            <option value="ok">OK</option>
            <option value="policy_not_found">Policy not found</option>
            <option value="non_browsable">Non-browsable</option>
            <option value="home_fetch_failed">Home fetch failed</option>
          </select>
          <span className="text-xs text-[var(--muted-text)]">{sitesToShow.length} sites</span>
        </div>
      </section>

      {view === 'sites' && (
        <section className="card rounded-2xl p-6">
          {sitesToShow.length === 0 ? (
            <div className="text-sm text-[var(--muted-text)]">No sites processed yet.</div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {sitesToShow.map((site) => (
                <button
                  key={site.site}
                  className="rounded-2xl border border-[var(--border-soft)] bg-black/20 p-4 text-left transition hover:border-[var(--color-danger)]"
                  onClick={() => {
                    setSelectedSite(site)
                    setDetailTab('third-parties')
                    setStatements([])
                    setView('thirdParties')
                  }}
                >
                  <p className="text-sm font-semibold">{site.site}</p>
                  <p className="text-xs text-[var(--muted-text)]">
                    Status: {site.status} • Rank {site.rank ?? (site as any).rank ?? '—'}
                  </p>
                  <p className="mt-2 text-xs text-[var(--muted-text)]">
                    {(site as any).thirdParties?.length ?? (site as any).third_parties?.length ?? 0} third-party
                    services
                  </p>
                  {showExtractionMethod && (
                    <p className="mt-1 text-xs text-[var(--muted-text)]">
                      Policy extraction: {formatExtractionMethod((site as any).extractionMethod ?? (site as any).extraction_method)}
                    </p>
                  )}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {view === 'thirdParties' && selectedSite && (
        <>
          <section className="card rounded-2xl p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Actions</p>
                <h3 className="text-lg font-semibold">{selectedSite.site}</h3>
                <p className="text-xs text-[var(--muted-text)]">Choose a policy to view in-app.</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="focusable rounded-full border border-[var(--color-danger)] px-4 py-2 text-xs text-white"
                  onClick={() => {
                    if (!selectedPolicyUrl) return
                    openViewer({
                      url: selectedPolicyUrl,
                      title: `${selectedSite.site} privacy policy`,
                      meta: {
                        type: 'first-party',
                        extractionMethod: selectedPolicyMethod,
                      },
                    })
                  }}
                  disabled={!selectedPolicyUrl}
                >
                  Open first-party policy
                </button>
                {showExtractionMethod && (
                  <span className="theme-chip rounded-full px-3 py-1 text-xs">
                    Extraction: {formatExtractionMethod(selectedPolicyMethod)}
                  </span>
                )}
                <button
                  className="focusable rounded-full border border-[var(--border-soft)] px-4 py-2 text-xs"
                  onClick={() => setView('sites')}
                >
                  Back
                </button>
              </div>
            </div>
          </section>

          <section className="card rounded-2xl p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Details</p>
                <h3 className="text-lg font-semibold">{selectedSite.site}</h3>
              </div>
              <div className="flex items-center gap-2">
                {['third-parties', 'statements'].map((tab) => (
                  <button
                    key={tab}
                    className={`focusable rounded-full border px-4 py-1.5 text-xs ${
                      detailTab === tab
                        ? 'border-[var(--color-danger)] text-white'
                        : 'border-[var(--border-soft)] text-[var(--muted-text)]'
                    }`}
                    onClick={() => setDetailTab(tab as 'third-parties' | 'statements')}
                  >
                    {tab === 'third-parties' ? `Third-parties (${selectedThirdParties.length})` : 'Statements'}
                  </button>
                ))}
              </div>
            </div>

            {detailTab === 'third-parties' && (
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {selectedThirdParties.length === 0 && (
                  <div className="text-sm text-[var(--muted-text)]">No third-party services detected.</div>
                )}
                {selectedThirdParties.map((service) => (
                  <ThirdPartyCard
                    key={service.name}
                    service={service}
                    onOpen={openViewer}
                    showExtractionMethod={showExtractionMethod}
                  />
                ))}
              </div>
            )}

            {detailTab === 'statements' && (
              <div className="mt-4">
                {statementsLoading && (
                  <p className="text-sm text-[var(--muted-text)]">Loading statements…</p>
                )}
                {!statementsLoading && statements.length === 0 && (
                  <p className="text-sm text-[var(--muted-text)]">
                    No annotation data found for this site. Run Stage 2 annotation first.
                  </p>
                )}
                {!statementsLoading && statements.length > 0 && (
                  <div className="space-y-3 max-h-[600px] overflow-y-auto pr-1">
                    <p className="text-xs text-[var(--muted-text)]">{statements.length} statements extracted</p>
                    {statements.map((stmt, i) => (
                      <StatementCard key={i} stmt={stmt} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        </>
      )}

      {view === 'viewer' && currentEntry && (
        <section className="card rounded-2xl p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1 text-xs"
                onClick={closeViewer}
              >
                Back
              </button>
              <button
                className={`focusable rounded-full border px-3 py-1 text-xs ${
                  canGoBack ? 'border-[var(--border-soft)]' : 'border-[var(--border-soft)] text-[var(--muted-text)]'
                }`}
                onClick={goBack}
                disabled={!canGoBack}
              >
                ◀
              </button>
              <button
                className={`focusable rounded-full border px-3 py-1 text-xs ${
                  canGoForward ? 'border-[var(--border-soft)]' : 'border-[var(--border-soft)] text-[var(--muted-text)]'
                }`}
                onClick={goForward}
                disabled={!canGoForward}
              >
                ▶
              </button>
              <span className="text-xs text-[var(--muted-text)]">{currentEntry.title}</span>
              {currentEntry.meta && showExtractionMethod && (
                <span className="theme-chip rounded-full px-3 py-1 text-xs">
                  Extraction: {formatExtractionMethod(currentEntry.meta.extractionMethod)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1 text-xs"
                onClick={openPolicyWindow}
              >
                Open in window
              </button>
              {currentEntry.meta && currentEntry.meta.type === 'third-party' && (
                <div className="theme-chip rounded-full px-3 py-1 text-xs">
                  {currentEntry.meta.entity || 'Unknown entity'}
                </div>
              )}
            </div>
          </div>
          {viewerError && (
            <div className="mt-3 rounded-xl border border-[var(--color-warn)] bg-black/20 px-3 py-2 text-xs text-[var(--color-warn)]">
              {viewerError}
            </div>
          )}
          <div className="mt-3 grid gap-4 lg:grid-cols-[1fr_260px]">
            <div className="overflow-hidden rounded-2xl border border-[var(--border-soft)] bg-black/20">
              <iframe
                title="Policy viewer"
                src={currentEntry.url}
                className="h-[520px] w-full"
                onError={() => setViewerError('This site blocks embedded viewing. Use "Open in window".')}
              />
            </div>
            {currentEntry.meta && currentEntry.meta.type === 'third-party' && (
              <div className="rounded-2xl border border-[var(--border-soft)] bg-black/20 p-4 text-xs">
                <p className="text-[var(--muted-text)]">Third-party details</p>
                <h4 className="mt-2 text-sm font-semibold">{currentEntry.title}</h4>
                <div className="mt-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--muted-text)]">Entity</span>
                    <span>{currentEntry.meta.entity || 'Unknown'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--muted-text)]">Prevalence</span>
                    <span>
                      {currentEntry.meta.prevalence !== null && currentEntry.meta.prevalence !== undefined
                        ? `${(currentEntry.meta.prevalence * 100).toFixed(2)}%`
                        : '—'}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--muted-text)]">Categories</span>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {normalizeCategories(currentEntry.meta.categories || []).map((cat) => (
                        <span key={cat} className="theme-chip rounded-full px-3 py-1">
                          {cat}
                        </span>
                      )) || <span className="theme-chip rounded-full px-3 py-1">Uncategorized</span>}
                    </div>
                  </div>
                  {showExtractionMethod && (
                    <div className="flex items-center justify-between">
                      <span className="text-[var(--muted-text)]">Extraction</span>
                      <span>{formatExtractionMethod(currentEntry.meta.extractionMethod)}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </>
  )
}

const STMT_FIELD_COLORS: Record<string, string> = {
  action: 'bg-blue-900/50 text-blue-300 border-blue-700',
  data: 'bg-purple-900/50 text-purple-300 border-purple-700',
  processor: 'bg-gray-700/50 text-gray-300 border-gray-600',
  purpose: 'bg-green-900/50 text-green-300 border-green-700',
  recipient: 'bg-orange-900/50 text-orange-300 border-orange-700',
  context: 'bg-teal-900/50 text-teal-300 border-teal-700',
}

function StatementCard({ stmt }: { stmt: any }) {
  const [expanded, setExpanded] = useState(false)
  const { statement, source_text } = stmt
  const isProhibition = statement?.prohibition === true
  return (
    <div
      className={`rounded-xl border p-3 text-xs ${
        isProhibition ? 'border-red-800/60 bg-red-950/20' : 'border-[var(--border-soft)] bg-black/10'
      }`}
    >
      {isProhibition && (
        <span className="mb-2 inline-block rounded-full border border-red-700 bg-red-900/50 px-2 py-0.5 text-[10px] text-red-300">
          prohibition
        </span>
      )}
      {source_text && (
        <p
          className="cursor-pointer italic text-[var(--muted-text)] leading-relaxed"
          style={{
            display: '-webkit-box',
            WebkitLineClamp: expanded ? 'unset' : 3,
            WebkitBoxOrient: 'vertical',
            overflow: expanded ? 'visible' : 'hidden',
          } as React.CSSProperties}
          onClick={() => setExpanded((v) => !v)}
        >
          {source_text}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {(['action', 'data', 'processor', 'purpose', 'recipient', 'context'] as const).map((field) => {
          const phrases: [number, string][] = statement?.[field] ?? []
          return phrases.map(([, phrase], i) => (
            <span
              key={`${field}-${i}`}
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] ${STMT_FIELD_COLORS[field] ?? ''}`}
            >
              <span className="mr-1 font-semibold opacity-60">{field}</span>
              {phrase}
            </span>
          ))
        })}
      </div>
    </div>
  )
}

type ThirdPartyCardProps = {
  service: ExplorerThirdParty
  onOpen: (entry: ViewerEntry) => void
  showExtractionMethod: boolean
}

function ThirdPartyCard({ service, onOpen, showExtractionMethod }: ThirdPartyCardProps) {
  const policyUrl = (service as any).policyUrl ?? (service as any).policy_url ?? service.policyUrl
  return (
    <button
      className="rounded-2xl border border-[var(--border-soft)] bg-black/20 p-4 text-left transition hover:border-[var(--color-danger)]"
      onClick={() => {
        if (!policyUrl) return
        onOpen({
          url: policyUrl,
          title: service.name,
          meta: {
            type: 'third-party',
            entity: service.entity,
            categories: normalizeCategories(service.categories),
            prevalence: service.prevalence,
            extractionMethod: (service as any).extractionMethod ?? (service as any).extraction_method ?? null,
          },
        })
      }}
      disabled={!policyUrl}
    >
      <p className="text-sm font-semibold">{service.name}</p>
      <p className="text-xs text-[var(--muted-text)]">{service.entity || 'Unknown entity'}</p>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        {(() => {
          const cats = normalizeCategories(service.categories)
          return cats.length > 0 ? cats.map((cat) => (
            <span key={cat} className="theme-chip rounded-full px-3 py-1">{cat}</span>
          )) : <span className="theme-chip rounded-full px-3 py-1">Uncategorized</span>
        })()}
      </div>
      <p className="mt-2 text-xs text-[var(--muted-text)]">{policyUrl ? 'Open policy' : 'No policy URL'}</p>
      {showExtractionMethod && (
        <p className="mt-1 text-xs text-[var(--muted-text)]">
          Extraction: {formatExtractionMethod((service as any).extractionMethod ?? (service as any).extraction_method)}
        </p>
      )}
    </button>
  )
}
