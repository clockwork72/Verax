import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ExplorerSite, ExplorerThirdParty } from '../../data/explorer'
import { readPreferredStatementText } from '../../lib/artifactClient'
import { openEmbeddedPolicyWindow } from '../../lib/scraperClient'
import { normalizeCategories } from '../../utils/trackerCategories'
import { BentoCard, BentoGrid } from '../ui/BentoCard'
import { StatusPill } from '../ui/StatusPill'

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

function siteStatusVariant(status: ExplorerSite['status']): 'ok' | 'error' | 'warn' | 'idle' {
  switch (status) {
    case 'ok': return 'ok'
    case 'policy_not_found': return 'warn'
    case 'non_browsable': return 'idle'
    case 'home_fetch_failed': return 'error'
    default: return 'idle'
  }
}

function siteStatusLabel(status: ExplorerSite['status']): string {
  switch (status) {
    case 'ok': return 'OK'
    case 'policy_not_found': return 'No policy'
    case 'non_browsable': return 'Non-browsable'
    case 'home_fetch_failed': return 'Fetch failed'
    default: return status
  }
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

  const goBack = () => { if (canGoBack) setHistoryIndex((prev) => Math.max(0, prev - 1)) }
  const goForward = () => { if (canGoForward) setHistoryIndex((prev) => Math.min(history.length - 1, prev + 1)) }
  const closeViewer = () => setView(lastNonViewer)

  useEffect(() => {
    if (!currentEntry?.url) return
    setViewerError(null)
  }, [currentEntry?.url])

  useEffect(() => {
    if (detailTab !== 'statements' || !selectedSite) return
    setStatementsLoading(true)
    setStatements([])
    readPreferredStatementText({
      outDir: outDir || 'outputs',
      basePath: `artifacts/${selectedSite.site}`,
    }).then((rawStatements) => {
      setStatements(rawStatements ? parseStatementLines(rawStatements) : [])
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
      const siteThirdParties = site.thirdParties.length
      if (Number.isFinite(minThirdPartyCount) && minThirdParties !== '' && siteThirdParties < minThirdPartyCount) return false
      if (!normalizedQuery) return true
      return site.site.toLowerCase().includes(normalizedQuery)
    })
  }, [progress, query, statusFilter, sites, minThirdParties])

  const selectedPolicyUrl = selectedSite?.policyUrl ?? null
  const selectedPolicyMethod = selectedSite?.extractionMethod ?? null
  const selectedThirdParties: ExplorerThirdParty[] = selectedSite?.thirdParties ?? []

  const openPolicyWindow = async () => {
    if (!currentEntry?.url) return
    const ok = await openEmbeddedPolicyWindow(currentEntry.url)
    if (!ok) setViewerError('Unable to open embedded page. Try again or check the URL.')
  }

  if (!hasRun) {
    return (
      <BentoCard className="p-8 text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">No results</p>
        <h2 className="mt-2 text-lg font-semibold">Explorer is empty</h2>
        <p className="mt-2 text-sm text-[var(--muted-text)]">
          Run the scraper first to populate the site explorer.
        </p>
      </BentoCard>
    )
  }

  return (
    <>
      {/* ── Filter bar ── */}
      <BentoCard className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted-text)]">Explorer</p>
            <h2 className="text-base font-semibold">Scraped sites</h2>
          </div>
          {view === 'viewer' && (
            <div className="flex items-center gap-2">
              <NavBtn onClick={goBack} disabled={!canGoBack}>◀</NavBtn>
              <NavBtn onClick={goForward} disabled={!canGoForward}>▶</NavBtn>
              <NavBtn onClick={closeViewer}>Back to sites</NavBtn>
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            className="focusable w-60 rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-2 text-sm placeholder-[var(--muted-text)] text-[var(--color-text)]"
            placeholder="Search by site…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <input
            type="number"
            min={0}
            className="focusable w-32 rounded-xl border border-[var(--border-soft)] bg-black/20 px-3 py-2 text-sm placeholder-[var(--muted-text)] text-[var(--color-text)]"
            placeholder="Min 3P"
            value={minThirdParties}
            onChange={(e) => setMinThirdParties(e.target.value)}
          />
          <select
            className="focusable rounded-xl border border-[var(--border-soft)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text)]"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          >
            <option value="all">All statuses</option>
            <option value="ok">OK</option>
            <option value="policy_not_found">No policy</option>
            <option value="non_browsable">Non-browsable</option>
            <option value="home_fetch_failed">Fetch failed</option>
          </select>
          <span className="ml-auto text-xs text-[var(--muted-text)]">{sitesToShow.length} sites</span>
        </div>
      </BentoCard>

      {/* ── Site grid ── */}
      <AnimatePresence mode="wait">
        {view === 'sites' && (
          <motion.div
            key="sites-view"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22 }}
          >
            <BentoCard className="p-5">
              {sitesToShow.length === 0 ? (
                <p className="text-sm text-[var(--muted-text)]">No sites processed yet.</p>
              ) : (
                <BentoGrid className="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                  {sitesToShow.map((site) => (
                    <SiteCard
                      key={site.site}
                      site={site}
                      showExtractionMethod={showExtractionMethod}
                      onSelect={() => {
                        setSelectedSite(site)
                        setDetailTab('third-parties')
                        setStatements([])
                        setView('thirdParties')
                      }}
                    />
                  ))}
                </BentoGrid>
              )}
            </BentoCard>
          </motion.div>
        )}

        {/* ── Third-party detail view ── */}
        {view === 'thirdParties' && selectedSite && (
          <motion.div
            key="detail-view"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22 }}
            className="flex flex-col gap-5"
          >
            {/* Action header */}
            <BentoCard className="p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted-text)]">Site detail</p>
                  <h3 className="text-base font-semibold">{selectedSite.site}</h3>
                  <p className="text-xs text-[var(--muted-text)]">Rank {selectedSite.rank ?? '—'}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    className="focusable rounded-xl border border-[var(--color-primary)] px-4 py-1.5 text-xs text-[var(--color-primary)] transition hover:bg-[var(--color-primary)]/10 disabled:opacity-40 disabled:cursor-not-allowed"
                    onClick={() => {
                      if (!selectedPolicyUrl) return
                      openViewer({
                        url: selectedPolicyUrl,
                        title: `${selectedSite.site} privacy policy`,
                        meta: { type: 'first-party', extractionMethod: selectedPolicyMethod },
                      })
                    }}
                    disabled={!selectedPolicyUrl}
                  >
                    Open first-party policy
                  </button>
                  {showExtractionMethod && (
                    <span className="theme-chip rounded-full px-3 py-1 text-xs">
                      {formatExtractionMethod(selectedPolicyMethod)}
                    </span>
                  )}
                  <NavBtn onClick={() => setView('sites')}>← Back</NavBtn>
                </div>
              </div>
            </BentoCard>

            {/* Tabs + content */}
            <BentoCard className="p-5">
              <div className="flex items-center gap-2 mb-4">
                {(['third-parties', 'statements'] as const).map((tab) => (
                  <button
                    key={tab}
                    className={`focusable rounded-xl border px-4 py-1.5 text-xs transition ${
                      detailTab === tab
                        ? 'border-[var(--color-primary)] text-[var(--color-primary)] bg-[var(--color-primary)]/8'
                        : 'border-[var(--border-soft)] text-[var(--muted-text)] hover:border-[var(--color-primary)]/40'
                    }`}
                    onClick={() => setDetailTab(tab)}
                  >
                    {tab === 'third-parties' ? `Third-parties (${selectedThirdParties.length})` : 'Statements'}
                  </button>
                ))}
              </div>

              <AnimatePresence mode="wait">
                {detailTab === 'third-parties' && (
                  <motion.div
                    key="tp-tab"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    {selectedThirdParties.length === 0 ? (
                      <p className="text-sm text-[var(--muted-text)]">No third-party services detected.</p>
                    ) : (
                      <BentoGrid className="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                        {selectedThirdParties.map((service) => (
                          <ThirdPartyCard
                            key={service.name}
                            service={service}
                            onOpen={openViewer}
                            showExtractionMethod={showExtractionMethod}
                          />
                        ))}
                      </BentoGrid>
                    )}
                  </motion.div>
                )}

                {detailTab === 'statements' && (
                  <motion.div
                    key="stmt-tab"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.2 }}
                  >
                    {statementsLoading && (
                      <p className="text-sm text-[var(--muted-text)]">Loading statements…</p>
                    )}
                    {!statementsLoading && statements.length === 0 && (
                      <p className="text-sm text-[var(--muted-text)]">
                        No annotation data found for this site. Run Stage 2 annotation first.
                      </p>
                    )}
                    {!statementsLoading && statements.length > 0 && (
                      <div className="space-y-2 max-h-[560px] overflow-y-auto pr-1">
                        <p className="text-xs text-[var(--muted-text)] mb-3">{statements.length} statements extracted</p>
                        {statements.map((stmt, i) => (
                          <StatementCard key={i} stmt={stmt} index={i} />
                        ))}
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </BentoCard>
          </motion.div>
        )}

        {/* ── Policy viewer ── */}
        {view === 'viewer' && currentEntry && (
          <motion.div
            key="viewer"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22 }}
          >
            <BentoCard className="p-5">
              {/* Viewer nav bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div className="flex items-center gap-2">
                  <NavBtn onClick={goBack} disabled={!canGoBack}>◀</NavBtn>
                  <NavBtn onClick={goForward} disabled={!canGoForward}>▶</NavBtn>
                  <span className="text-xs text-[var(--muted-text)] truncate max-w-[240px]">{currentEntry.title}</span>
                  {currentEntry.meta && showExtractionMethod && (
                    <span className="theme-chip rounded-full px-3 py-1 text-xs">
                      {formatExtractionMethod(currentEntry.meta.extractionMethod)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    className="focusable rounded-xl border border-[var(--border-soft)] px-3 py-1.5 text-xs hover:border-[var(--color-primary)]/40 transition"
                    onClick={openPolicyWindow}
                  >
                    Open in window
                  </button>
                  {currentEntry.meta?.type === 'third-party' && (
                    <span className="theme-chip rounded-full px-3 py-1 text-xs">
                      {currentEntry.meta.entity || 'Unknown entity'}
                    </span>
                  )}
                </div>
              </div>

              {viewerError && (
                <div className="mb-3 rounded-xl border border-[var(--color-warn)] bg-[var(--color-warn)]/8 px-3 py-2 text-xs text-[var(--color-warn)]">
                  {viewerError}
                </div>
              )}

              <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
                {/* iFrame */}
                <div className="overflow-hidden rounded-2xl border border-[var(--border-soft)]">
                  <iframe
                    title="Policy viewer"
                    src={currentEntry.url}
                    className="h-[520px] w-full bg-white"
                    onError={() => setViewerError('This site blocks embedded viewing. Use "Open in window".')}
                  />
                </div>

                {/* Glass metadata sidebar */}
                {currentEntry.meta?.type === 'third-party' && (
                  <motion.div
                    initial={{ opacity: 0, x: 24 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ type: 'spring', stiffness: 280, damping: 24, delay: 0.08 }}
                    className="glass-card p-4 text-xs"
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted-text)] mb-3">
                      Third-party details
                    </p>
                    <h4 className="text-sm font-semibold mb-4">{currentEntry.title}</h4>

                    <div className="space-y-3">
                      <MetaRow label="Entity" value={currentEntry.meta.entity || 'Unknown'} />
                      <MetaRow
                        label="Prevalence"
                        value={
                          currentEntry.meta.prevalence !== null && currentEntry.meta.prevalence !== undefined
                            ? `${(currentEntry.meta.prevalence * 100).toFixed(2)}%`
                            : '—'
                        }
                      />
                      {showExtractionMethod && (
                        <MetaRow label="Extraction" value={formatExtractionMethod(currentEntry.meta.extractionMethod)} />
                      )}
                      <div>
                        <p className="text-[var(--muted-text)] mb-2">Categories</p>
                        <div className="flex flex-wrap gap-1.5">
                          {normalizeCategories(currentEntry.meta.categories || []).length > 0
                            ? normalizeCategories(currentEntry.meta.categories || []).map((cat) => (
                                <span key={cat} className="theme-chip rounded-full px-2.5 py-0.5 text-[10px]">{cat}</span>
                              ))
                            : <span className="theme-chip rounded-full px-2.5 py-0.5 text-[10px]">Uncategorized</span>}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}
              </div>
            </BentoCard>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function NavBtn({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      className="focusable rounded-xl border border-[var(--border-soft)] px-3 py-1.5 text-xs text-[var(--muted-text)] hover:border-[var(--color-primary)]/40 hover:text-[var(--color-text)] transition disabled:opacity-40 disabled:cursor-not-allowed"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[var(--muted-text)]">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}

function SiteCard({
  site,
  showExtractionMethod,
  onSelect,
}: {
  site: ExplorerSite
  showExtractionMethod: boolean
  onSelect: () => void
}) {
  const reduced = useReducedMotion()
  return (
    <motion.button
      className="glass-card p-4 text-left w-full cursor-pointer"
      onClick={onSelect}
      whileHover={reduced ? {} : { scale: 1.02, boxShadow: 'var(--glow-sm)' }}
      whileTap={reduced ? {} : { scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 300, damping: 20 }}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <p className="text-sm font-semibold truncate">{site.site}</p>
        <StatusPill variant={siteStatusVariant(site.status)} label={siteStatusLabel(site.status)} />
      </div>
      <p className="text-xs text-[var(--muted-text)]">Rank {site.rank ?? '—'}</p>
      <p className="mt-2 text-xs text-[var(--muted-text)]">
        {site.thirdParties.length} third-party{site.thirdParties.length !== 1 ? ' services' : ' service'}
      </p>
      {showExtractionMethod && (
        <p className="mt-1 text-xs text-[var(--muted-text)]">
          Extraction: {formatExtractionMethod(site.extractionMethod)}
        </p>
      )}
    </motion.button>
  )
}

// Statement field colors
const STMT_FIELD_CONFIG: Record<string, { bg: string; text: string; border: string }> = {
  action:    { bg: 'bg-blue-900/40',   text: 'text-blue-300',   border: 'border-blue-700/60' },
  data:      { bg: 'bg-purple-900/40', text: 'text-purple-300', border: 'border-purple-700/60' },
  processor: { bg: 'bg-slate-100/8',   text: 'text-slate-100',  border: 'border-slate-200/20' },
  purpose:   { bg: 'bg-green-900/40',  text: 'text-green-300',  border: 'border-green-700/60' },
  recipient: { bg: 'bg-orange-900/40', text: 'text-orange-300', border: 'border-orange-700/60' },
  context:   { bg: 'bg-teal-900/40',   text: 'text-teal-300',   border: 'border-teal-700/60' },
}

function StatementCard({ stmt, index }: { stmt: any; index: number }) {
  const [expanded, setExpanded] = useState(false)
  const { statement, source_text } = stmt
  const isProhibition = statement?.prohibition === true
  const reduced = useReducedMotion()

  return (
    <motion.div
      initial={reduced ? { opacity: 0 } : { opacity: 0, x: 18 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: 'spring', stiffness: 260, damping: 26, delay: Math.min(index * 0.03, 0.3) }}
      className={`rounded-xl border p-3 text-xs ${
        isProhibition
          ? 'border-[rgba(255,45,149,0.35)] bg-[rgba(255,45,149,0.05)]'
          : 'border-[var(--border-soft)] bg-black/10'
      }`}
      style={isProhibition ? { borderLeft: '2px solid rgba(255,45,149,0.6)' } : undefined}
    >
      {isProhibition && (
        <span className="mb-2 inline-block rounded-full border border-[rgba(255,45,149,0.4)] bg-[rgba(255,45,149,0.12)] px-2 py-0.5 text-[10px] text-[var(--color-danger)]">
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
          return phrases.map(([, phrase], i) => {
            const cfg = STMT_FIELD_CONFIG[field]
            return (
              <span
                key={`${field}-${i}`}
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] ${cfg?.bg ?? ''} ${cfg?.text ?? ''} ${cfg?.border ?? ''}`}
              >
                <span className="mr-1 font-semibold opacity-60">{field}</span>
                {phrase}
              </span>
            )
          })
        })}
      </div>
    </motion.div>
  )
}

function ThirdPartyCard({
  service,
  onOpen,
  showExtractionMethod,
}: {
  service: ExplorerThirdParty
  onOpen: (entry: ViewerEntry) => void
  showExtractionMethod: boolean
}) {
  const policyUrl = service.policyUrl
  const reduced = useReducedMotion()

  return (
    <motion.button
      className="glass-card p-4 text-left w-full disabled:opacity-50 disabled:cursor-not-allowed"
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
            extractionMethod: service.extractionMethod ?? null,
          },
        })
      }}
      disabled={!policyUrl}
      whileHover={reduced ? {} : { scale: 1.02, boxShadow: 'var(--glow-sm)' }}
      whileTap={reduced ? {} : { scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 300, damping: 20 }}
    >
      <p className="text-sm font-semibold">{service.name}</p>
      <p className="text-xs text-[var(--muted-text)]">{service.entity || 'Unknown entity'}</p>
      <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
        {(() => {
          const cats = normalizeCategories(service.categories)
          return cats.length > 0
            ? cats.map((cat) => (
                <span key={cat} className="theme-chip rounded-full px-2.5 py-0.5 text-[10px]">{cat}</span>
              ))
            : <span className="theme-chip rounded-full px-2.5 py-0.5 text-[10px]">Uncategorized</span>
        })()}
      </div>
      <p className="mt-2 text-xs text-[var(--muted-text)]">{policyUrl ? 'Open policy ↗' : 'No policy URL'}</p>
      {showExtractionMethod && (
        <p className="mt-1 text-xs text-[var(--muted-text)]">Extraction: {formatExtractionMethod(service.extractionMethod)}</p>
      )}
    </motion.button>
  )
}
