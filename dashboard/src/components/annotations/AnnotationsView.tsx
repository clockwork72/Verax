import { useEffect, useRef, useState } from 'react'

type AnnotationsViewProps = {
  annotationStats?: any
  outDir?: string
}

type StatementField = [number, string]

type Statement = {
  action?: StatementField[]
  data?: StatementField[]
  processor?: StatementField[]
  recipient?: StatementField[]
  purpose?: StatementField[]
  context?: StatementField[]
  prohibition?: boolean
}

type AnnotatedStatement = {
  chunk_index: number
  source_text: string
  statement: Statement
}

type SiteStatements = {
  site: string
  statements: AnnotatedStatement[]
}

type FreqEntry = { label: string; count: number }

const FIELD_COLORS: Record<string, string> = {
  action: 'bg-blue-900/50 text-blue-300 border-blue-700',
  data: 'bg-purple-900/50 text-purple-300 border-purple-700',
  processor: 'bg-gray-700/50 text-gray-300 border-gray-600',
  purpose: 'bg-green-900/50 text-green-300 border-green-700',
  recipient: 'bg-orange-900/50 text-orange-300 border-orange-700',
  context: 'bg-teal-900/50 text-teal-300 border-teal-700',
}

function PhraseChip({ label, field }: { label: string; field: string }) {
  const cls = FIELD_COLORS[field] || 'bg-gray-700/50 text-gray-300 border-gray-600'
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] ${cls}`}>
      <span className="mr-1 font-semibold opacity-60">{field}</span>
      {label}
    </span>
  )
}

function StatementCard({ stmt }: { stmt: AnnotatedStatement }) {
  const [expanded, setExpanded] = useState(false)
  const { statement, source_text } = stmt
  const isProhibition = statement.prohibition === true

  return (
    <div
      className={`rounded-xl border p-3 text-xs ${
        isProhibition ? 'border-red-800/60 bg-red-950/20' : 'border-[var(--border-soft)] bg-black/10'
      }`}
    >
      {isProhibition && (
        <span className="mb-2 inline-block rounded-full bg-red-900/50 px-2 py-0.5 text-[10px] text-red-300 border border-red-700">
          prohibition
        </span>
      )}
      <p
        className="cursor-pointer italic text-[var(--muted-text)] leading-relaxed"
        style={{
          display: '-webkit-box',
          WebkitLineClamp: expanded ? 'unset' : 3,
          WebkitBoxOrient: 'vertical',
          overflow: expanded ? 'visible' : 'hidden',
        } as React.CSSProperties}
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? 'Click to collapse' : 'Click to expand'}
      >
        {source_text}
      </p>
      {!expanded && source_text && source_text.length > 200 && (
        <button
          className="mt-1 text-[10px] text-[var(--color-primary)] underline"
          onClick={() => setExpanded(true)}
        >
          show more
        </button>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {(['action', 'data', 'processor', 'purpose', 'recipient', 'context'] as const).map((field) => {
          const phrases = (statement[field] as StatementField[] | undefined) || []
          return phrases.map(([, phrase], i) => (
            <PhraseChip key={`${field}-${i}`} label={phrase} field={field} />
          ))
        })}
      </div>
    </div>
  )
}

function FreqBar({ label, count, max }: { label: string; count: number; max: number }) {
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="w-40 truncate text-[var(--muted-text)]" title={label}>
        {label}
      </span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-black/30">
        <div
          className="h-full rounded-full bg-[var(--color-primary)]"
          style={{ width: `${Math.min(100, (count / Math.max(1, max)) * 100)}%` }}
        />
      </div>
      <span className="w-8 text-right text-[var(--muted-text)]">{count}</span>
    </div>
  )
}

function buildFreq(allStatements: AnnotatedStatement[], field: keyof Statement): FreqEntry[] {
  const counts: Record<string, number> = {}
  for (const s of allStatements) {
    const phrases = (s.statement[field] as StatementField[] | undefined) || []
    for (const [, phrase] of phrases) {
      const key = phrase.toLowerCase().trim()
      counts[key] = (counts[key] || 0) + 1
    }
  }
  return Object.entries(counts)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12)
}

export function AnnotationsView({ annotationStats, outDir }: AnnotationsViewProps) {
  const [siteStatements, setSiteStatements] = useState<SiteStatements[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [expandedSite, setExpandedSite] = useState<string | null>(null)

  // Reset loaded state when the output directory changes so statements are re-fetched
  const prevOutDir = useRef(outDir)
  useEffect(() => {
    if (prevOutDir.current !== outDir) {
      prevOutDir.current = outDir
      setSiteStatements([])
      setLoaded(false)
      setExpandedSite(null)
    }
  }, [outDir])

  const perSite: { site: string; count: number; has_statements: boolean }[] =
    annotationStats?.per_site ?? []
  const totalStatements: number = annotationStats?.total_statements ?? 0
  const annotatedSites: number = annotationStats?.annotated_sites ?? 0
  const totalSites: number = annotationStats?.total_sites ?? 0

  useEffect(() => {
    if (loaded || !annotationStats?.per_site?.length || !window.scraper) return
    const sitesWithStatements = annotationStats.per_site.filter((s: any) => s.has_statements)
    if (sitesWithStatements.length === 0) return
    setLoading(true)

    const root = outDir || 'outputs'

    Promise.all(
      sitesWithStatements.map(async (s: any) => {
        const res = await window.scraper!.readArtifactText({
          outDir: root,
          relativePath: `artifacts/${s.site}/policy_statements_annotated.jsonl`,
        })
        if (!res.ok || !res.data) return null
        const lines: string[] = res.data.split('\n').filter((l: string) => l.trim())
        const statements: AnnotatedStatement[] = []
        for (const line of lines) {
          try {
            statements.push(JSON.parse(line))
          } catch {
            // skip bad lines
          }
        }
        return { site: s.site, statements } as SiteStatements
      })
    ).then((results) => {
      setSiteStatements(results.filter(Boolean) as SiteStatements[])
      setLoaded(true)
      setLoading(false)
    })
  }, [annotationStats, outDir, loaded])

  const allStatements = siteStatements.flatMap((s) => s.statements)

  const actionFreq = buildFreq(allStatements, 'action')
  const dataFreq = buildFreq(allStatements, 'data')
  const purposeFreq = buildFreq(allStatements, 'purpose')
  const recipientFreq = buildFreq(allStatements, 'recipient')

  const prohibitionCount = allStatements.filter((s) => s.statement.prohibition === true).length
  const prohibitionRate =
    allStatements.length > 0 ? ((prohibitionCount / allStatements.length) * 100).toFixed(1) : '0'
  const avgPerSite = annotatedSites > 0 ? (totalStatements / annotatedSites).toFixed(1) : '0'

  if (!annotationStats) {
    return (
      <section className="card rounded-2xl p-6">
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">No data</p>
        <h2 className="text-lg font-semibold">No annotations yet</h2>
        <p className="mt-2 text-sm text-[var(--muted-text)]">
          Run Stage 2 annotation from the Launcher to populate this view. Annotation stats
          load automatically when artifacts are present.
        </p>
      </section>
    )
  }

  return (
    <>
      {/* Overview cards */}
      <section className="card rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Overview</p>
            <h2 className="text-lg font-semibold">Annotation summary</h2>
            <p className="text-xs text-[var(--muted-text)]">
              Structured privacy statements extracted by LLM from policy documents.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {outDir && (
              <span className="mono rounded-full border border-[var(--border-soft)] px-3 py-1 text-[10px] text-[var(--muted-text)]">
                {outDir}
              </span>
            )}
            <span className="theme-chip rounded-full px-3 py-1 text-xs">
              {annotatedSites} / {totalSites} sites annotated
            </span>
          </div>
        </div>
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: 'Sites annotated', value: String(annotatedSites) },
            { label: 'Total statements', value: totalStatements.toLocaleString() },
            { label: 'Avg per site', value: avgPerSite },
            { label: 'Prohibition rate', value: `${prohibitionRate}%` },
          ].map((item) => (
            <div
              key={item.label}
              className="rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-3"
            >
              <p className="text-xs text-[var(--muted-text)]">{item.label}</p>
              <p className="text-lg font-semibold">{item.value}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Frequency analysis */}
      <section className="card rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">
              Frequency analysis
            </p>
            <h3 className="text-lg font-semibold">Top phrases by field</h3>
            <p className="text-xs text-[var(--muted-text)]">
              Most common values extracted across all annotated policy documents.
            </p>
          </div>
          {loading && (
            <span className="text-xs text-[var(--muted-text)]">Loading statements…</span>
          )}
        </div>

        {!loaded && !loading && (
          <p className="mt-4 text-sm text-[var(--muted-text)]">
            Frequency data loads automatically when annotation artifacts are found.
          </p>
        )}

        {loaded && allStatements.length === 0 && (
          <p className="mt-4 text-sm text-[var(--muted-text)]">No statement data found.</p>
        )}

        {loaded && allStatements.length > 0 && (
          <div className="mt-5 grid gap-6 lg:grid-cols-2">
            {[
              { title: 'Actions', freq: actionFreq, color: 'text-blue-400' },
              { title: 'Data types', freq: dataFreq, color: 'text-purple-400' },
              { title: 'Purposes', freq: purposeFreq, color: 'text-green-400' },
              { title: 'Recipients', freq: recipientFreq, color: 'text-orange-400' },
            ].map(({ title, freq, color }) => (
              <div
                key={title}
                className="rounded-2xl border border-[var(--border-soft)] bg-black/20 p-4"
              >
                <p className={`text-xs uppercase tracking-[0.2em] ${color}`}>{title}</p>
                <div className="mt-3 space-y-2">
                  {freq.length === 0 ? (
                    <p className="text-xs text-[var(--muted-text)]">No data</p>
                  ) : (
                    freq.map((entry) => (
                      <FreqBar
                        key={entry.label}
                        label={entry.label}
                        count={entry.count}
                        max={freq[0].count}
                      />
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Per-site browser */}
      <section className="card rounded-2xl p-6">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">
            Statement browser
          </p>
          <h3 className="text-lg font-semibold">Per-site statements</h3>
          <p className="text-xs text-[var(--muted-text)]">
            Click a site to browse its extracted privacy statements.
          </p>
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border border-[var(--border-soft)]">
          <div className="grid grid-cols-[1.5fr_1fr_1fr_1fr] gap-2 bg-black/30 px-4 py-2 text-[10px] uppercase tracking-[0.2em] text-[var(--muted-text)]">
            <span>Site</span>
            <span>Statements</span>
            <span>Prohibitions</span>
            <span>Top action</span>
          </div>
          <div className="max-h-[400px] overflow-y-auto bg-black/10">
            {perSite
              .filter((s) => s.has_statements)
              .sort((a, b) => b.count - a.count)
              .map((row) => {
                const siteData = siteStatements.find((s) => s.site === row.site)
                const siteStmts = siteData?.statements ?? []
                const prohibs = siteStmts.filter((s) => s.statement.prohibition === true).length
                const actions: Record<string, number> = {}
                for (const s of siteStmts) {
                  for (const [, phrase] of s.statement.action ?? []) {
                    actions[phrase] = (actions[phrase] || 0) + 1
                  }
                }
                const topAction =
                  Object.entries(actions).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—'
                const isExpanded = expandedSite === row.site

                return (
                  <div key={row.site}>
                    <button
                      className={`grid w-full grid-cols-[1.5fr_1fr_1fr_1fr] items-center gap-2 border-t border-[var(--border-soft)] px-4 py-3 text-left text-xs transition hover:bg-black/20 ${
                        isExpanded ? 'bg-black/30' : ''
                      }`}
                      onClick={() => setExpandedSite(isExpanded ? null : row.site)}
                    >
                      <span className="font-semibold">{row.site}</span>
                      <span className="text-[var(--muted-text)]">{row.count}</span>
                      <span className="text-[var(--muted-text)]">
                        {siteData ? prohibs : '—'}
                      </span>
                      <span className="truncate text-[var(--muted-text)]" title={topAction}>
                        {siteData ? topAction : '—'}
                      </span>
                    </button>

                    {isExpanded && siteStmts.length > 0 && (
                      <div className="border-t border-[var(--border-soft)] bg-black/20 px-4 py-4">
                        <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1">
                          {siteStmts.map((stmt, i) => (
                            <StatementCard key={i} stmt={stmt} />
                          ))}
                        </div>
                      </div>
                    )}

                    {isExpanded && !siteData && (
                      <div className="border-t border-[var(--border-soft)] bg-black/20 px-4 py-3 text-xs text-[var(--muted-text)]">
                        Loading statements…
                      </div>
                    )}
                  </div>
                )
              })}
            {perSite.filter((s) => s.has_statements).length === 0 && (
              <div className="px-4 py-6 text-sm text-[var(--muted-text)]">
                No annotated sites found.
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  )
}
