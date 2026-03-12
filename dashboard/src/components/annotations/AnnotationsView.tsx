import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import type { AnnotationStats } from '../../contracts/api'
import { readPreferredStatementText } from '../../lib/artifactClient'
import { BentoCard, BentoGrid } from '../ui/BentoCard'
import { AnimatedCounter } from '../ui/AnimatedCounter'

type AnnotationsViewProps = {
  annotationStats?: AnnotationStats | null
  outDir?: string
}
type StatementField = [number, string]
type Statement = {
  action?: StatementField[]; data?: StatementField[]; processor?: StatementField[]
  recipient?: StatementField[]; purpose?: StatementField[]; context?: StatementField[]
  prohibition?: boolean
}
type AnnotatedStatement = { chunk_index: number; source_text: string; statement: Statement }
type FreqEntry = { label: string; count: number }

function parseStatementLines(raw: string): AnnotatedStatement[] {
  return raw.split('\n').filter((l) => l.trim()).flatMap((line) => {
    try {
      const p = JSON.parse(line)
      if (!p || !p.statement) return []
      return [{ chunk_index: Number(p.chunk_index) || 0, source_text: String(p.source_text || ''), statement: p.statement as Statement }]
    } catch { return [] }
  })
}

const FIELD_CONFIG: Record<string, { bg: string; text: string; border: string }> = {
  action:    { bg: 'bg-blue-900/40',   text: 'text-blue-300',   border: 'border-blue-700/60' },
  data:      { bg: 'bg-purple-900/40', text: 'text-purple-300', border: 'border-purple-700/60' },
  processor: { bg: 'bg-slate-100/8',   text: 'text-slate-100',  border: 'border-slate-200/20' },
  purpose:   { bg: 'bg-emerald-900/40',text: 'text-emerald-300',border: 'border-emerald-700/60' },
  recipient: { bg: 'bg-orange-900/40', text: 'text-orange-300', border: 'border-orange-700/60' },
  context:   { bg: 'bg-teal-900/40',   text: 'text-teal-300',   border: 'border-teal-700/60' },
}

function PhraseChip({ label, field }: { label: string; field: string }) {
  const cfg = FIELD_CONFIG[field] ?? { bg: 'bg-slate-100/8', text: 'text-slate-100', border: 'border-slate-200/20' }
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] ${cfg.bg} ${cfg.text} ${cfg.border}`}>
      <span className="mr-1 font-semibold opacity-50">{field[0]}</span>{label}
    </span>
  )
}

function StatementCard({ stmt, index }: { stmt: AnnotatedStatement; index: number }) {
  const [expanded, setExpanded] = useState(false)
  const reduce = useReducedMotion()
  const { statement, source_text } = stmt
  const isProhibition = statement.prohibition === true
  return (
    <motion.div
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
      transition={{ delay: index * 0.03, duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className={`rounded-xl border p-3 text-xs ${
        isProhibition
          ? 'border-[rgba(255,45,149,0.3)] bg-[rgba(255,45,149,0.05)]'
          : 'border-[var(--border-soft)] bg-black/10'
      }`}
      style={isProhibition ? { borderLeft: '2px solid rgba(255,45,149,0.6)' } : undefined}
    >
      {isProhibition && (
        <span className="mb-2 inline-block rounded-full border border-[rgba(255,45,149,0.4)] bg-[rgba(255,45,149,0.1)] px-2 py-0.5 text-[10px] text-[var(--color-danger)]">
          prohibition
        </span>
      )}
      <p
        className="cursor-pointer italic text-[var(--muted-text)] leading-relaxed"
        style={{ display: '-webkit-box', WebkitLineClamp: expanded ? 'unset' : 3, WebkitBoxOrient: 'vertical', overflow: expanded ? 'visible' : 'hidden' } as React.CSSProperties}
        onClick={() => setExpanded((v) => !v)}
      >
        {source_text}
      </p>
      {!expanded && source_text && source_text.length > 200 && (
        <button className="mt-1 text-[10px] text-[var(--color-primary)]" onClick={() => setExpanded(true)}>show more</button>
      )}
      <div className="mt-2 flex flex-wrap gap-1">
        {(['action', 'data', 'processor', 'purpose', 'recipient', 'context'] as const).map((field) =>
          ((statement[field] as StatementField[] | undefined) || []).map(([, phrase], i) => (
            <PhraseChip key={`${field}-${i}`} label={phrase} field={field} />
          ))
        )}
      </div>
    </motion.div>
  )
}

function FreqBar({ label, count, max, color, index }: { label: string; count: number; max: number; color: string; index: number }) {
  const reduce = useReducedMotion()
  const pct = Math.min(100, (count / Math.max(1, max)) * 100)
  return (
    <motion.div
      className="flex items-center gap-3 text-[12px]"
      initial={reduce ? { opacity: 0 } : { opacity: 0, x: -10 }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, x: 0 }}
      transition={{ delay: index * 0.04, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
    >
      <span className="w-36 truncate text-[var(--muted-text)]" title={label}>{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/30">
        <motion.div
          className="h-full rounded-full"
          style={{ background: color }}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={reduce ? { duration: 0 } : { duration: 0.7, delay: index * 0.04, ease: [0.22, 1, 0.36, 1] }}
        />
      </div>
      <span className="w-7 text-right text-[var(--muted-text)]">{count}</span>
    </motion.div>
  )
}

function buildFreq(stmts: AnnotatedStatement[], field: keyof Statement): FreqEntry[] {
  const counts: Record<string, number> = {}
  for (const s of stmts) {
    for (const [, phrase] of (s.statement[field] as StatementField[] | undefined) || []) {
      const k = phrase.toLowerCase().trim()
      counts[k] = (counts[k] || 0) + 1
    }
  }
  return Object.entries(counts).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count).slice(0, 12)
}

export function AnnotationsView({ annotationStats, outDir }: AnnotationsViewProps) {
  const [siteStatementsBySite, setSiteStatementsBySite] = useState<Record<string, AnnotatedStatement[]>>({})
  const [loadingSite, setLoadingSite] = useState<string | null>(null)
  const [expandedSite, setExpandedSite] = useState<string | null>(null)

  const prevOutDir = useRef(outDir)
  useEffect(() => {
    if (prevOutDir.current !== outDir) {
      prevOutDir.current = outDir
      setSiteStatementsBySite({})
      setLoadingSite(null)
      setExpandedSite(null)
    }
  }, [outDir])

  const perSite = annotationStats?.per_site ?? []
  const totalStatements = annotationStats?.total_statements ?? 0
  const annotatedSites = annotationStats?.annotated_sites ?? 0
  const totalSites = annotationStats?.total_sites ?? 0

  const loadSiteStatements = async (site: string) => {
    if (siteStatementsBySite[site] || loadingSite === site) return
    setLoadingSite(site)
    const raw = await readPreferredStatementText({ outDir: outDir || 'outputs', basePath: `artifacts/${site}` })
    setSiteStatementsBySite((prev) => ({ ...prev, [site]: raw ? parseStatementLines(raw) : [] }))
    setLoadingSite((cur) => (cur === site ? null : cur))
  }

  const allStatements = Object.values(siteStatementsBySite).flat()
  const loadedSiteCount = Object.keys(siteStatementsBySite).length
  const actionFreq = buildFreq(allStatements, 'action')
  const dataFreq = buildFreq(allStatements, 'data')
  const purposeFreq = buildFreq(allStatements, 'purpose')
  const recipientFreq = buildFreq(allStatements, 'recipient')
  const prohibitionCount = allStatements.filter((s) => s.statement.prohibition === true).length
  const prohibitionRate = allStatements.length > 0 ? ((prohibitionCount / allStatements.length) * 100).toFixed(1) : '0'
  const avgPerSite = annotatedSites > 0 ? (totalStatements / annotatedSites).toFixed(1) : '0'

  if (!annotationStats) {
    return (
      <BentoCard>
        <p className="text-[11px] uppercase tracking-[0.15em] text-[var(--muted-text)]">No data</p>
        <h2 className="mt-0.5 text-sm font-semibold">No annotations yet</h2>
        <p className="mt-1 text-[12px] text-[var(--muted-text)]">Run Stage 2 annotation from the Launcher to populate this view.</p>
      </BentoCard>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {/* ── Overview metric cards ───────────────────────────────── */}
      <BentoGrid className="grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Sites annotated', value: annotatedSites, suffix: `/${totalSites}` },
          { label: 'Total statements', value: totalStatements, suffix: '' },
          { label: 'Avg per site', valueStr: avgPerSite },
          { label: 'Prohibition rate', valueStr: `${prohibitionRate}%` },
        ].map((item) => (
          <BentoCard key={item.label}>
            <p className="text-[11px] text-[var(--muted-text)]">{item.label}</p>
            <p className="mt-2 text-2xl font-bold tracking-tight">
              {'valueStr' in item ? item.valueStr : <><AnimatedCounter value={item.value as number} />{item.suffix}</>}
            </p>
          </BentoCard>
        ))}
      </BentoGrid>

      {/* ── Frequency analysis ─────────────────────────────────── */}
      <BentoCard>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.15em] text-[var(--muted-text)]">Frequency analysis</p>
            <h3 className="text-sm font-semibold">Top phrases by field</h3>
            <p className="text-[12px] text-[var(--muted-text)]">Computed from statements loaded in this session.</p>
          </div>
          {loadingSite && <span className="text-[12px] text-[var(--muted-text)]">Loading {loadingSite}…</span>}
        </div>

        {loadedSiteCount === 0 && !loadingSite && (
          <p className="text-[12px] text-[var(--muted-text)]">Expand a site below to load its statements.</p>
        )}
        {loadedSiteCount > 0 && allStatements.length === 0 && (
          <p className="text-[12px] text-[var(--muted-text)]">No statement data found.</p>
        )}

        {allStatements.length > 0 && (
          <div className="grid gap-5 lg:grid-cols-2">
            {[
              { title: 'Actions',    freq: actionFreq,    color: '#93C5FD' },
              { title: 'Data types', freq: dataFreq,      color: '#C4B5FD' },
              { title: 'Purposes',   freq: purposeFreq,   color: '#6EE7B7' },
              { title: 'Recipients', freq: recipientFreq, color: '#FCA5A1' },
            ].map(({ title, freq, color }) => (
              <div key={title} className="rounded-xl border border-[var(--border-soft)] bg-black/10 p-4">
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.15em]" style={{ color }}>{title}</p>
                <div className="space-y-2">
                  {freq.length === 0
                    ? <p className="text-[11px] text-[var(--muted-text)]">No data</p>
                    : freq.map((entry, i) => (
                        <FreqBar key={entry.label} label={entry.label} count={entry.count} max={freq[0].count} color={color} index={i} />
                      ))
                  }
                </div>
              </div>
            ))}
          </div>
        )}
      </BentoCard>

      {/* ── Per-site browser ────────────────────────────────────── */}
      <BentoCard>
        <div className="mb-4">
          <p className="text-[11px] uppercase tracking-[0.15em] text-[var(--muted-text)]">Statement browser</p>
          <h3 className="text-sm font-semibold">Per-site statements</h3>
          <p className="text-[12px] text-[var(--muted-text)]">Click a site to browse its extracted privacy statements.</p>
        </div>

        <div className="overflow-hidden rounded-xl border border-[var(--border-soft)]">
          <div className="grid grid-cols-[1.5fr_0.7fr_0.7fr_1fr] gap-2 bg-black/25 px-4 py-2.5 text-[10px] uppercase tracking-[0.18em] text-[var(--muted-text)]">
            <span>Site</span><span>Stmts</span><span>Prohib.</span><span>Top action</span>
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {perSite.filter((s) => s.has_statements).sort((a, b) => b.count - a.count).map((row) => {
              const siteStmts = siteStatementsBySite[row.site] ?? null
              const loaded = siteStmts ?? []
              const prohibs = loaded.filter((s) => s.statement.prohibition === true).length
              const actions: Record<string, number> = {}
              for (const s of loaded) for (const [, phrase] of s.statement.action ?? []) actions[phrase] = (actions[phrase] || 0) + 1
              const topAction = Object.entries(actions).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—'
              const isExpanded = expandedSite === row.site

              return (
                <div key={row.site}>
                  <button
                    className={`grid w-full grid-cols-[1.5fr_0.7fr_0.7fr_1fr] items-center gap-2 border-t border-[var(--border-soft)] px-4 py-3 text-left text-[12px] transition hover:bg-black/15 ${isExpanded ? 'bg-black/20' : ''}`}
                    onClick={() => {
                      if (isExpanded) { setExpandedSite(null); return }
                      setExpandedSite(row.site)
                      void loadSiteStatements(row.site)
                    }}
                  >
                    <span className="font-medium">{row.site}</span>
                    <span className="text-[var(--color-primary)]">{row.count}</span>
                    <span className="text-[var(--muted-text)]">{siteStmts ? prohibs : '—'}</span>
                    <span className="truncate text-[var(--muted-text)]">{siteStmts ? topAction : '—'}</span>
                  </button>

                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                        className="overflow-hidden"
                      >
                        <div className="border-t border-[var(--border-soft)] bg-black/10 px-4 py-4">
                          {!siteStmts && <p className="text-[11px] text-[var(--muted-text)]">Loading statements…</p>}
                          {siteStmts && siteStmts.length === 0 && <p className="text-[11px] text-[var(--muted-text)]">No statements found.</p>}
                          {siteStmts && siteStmts.length > 0 && (
                            <div className="max-h-[480px] space-y-2.5 overflow-y-auto pr-1">
                              {siteStmts.map((stmt, i) => <StatementCard key={i} stmt={stmt} index={i} />)}
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )
            })}
            {perSite.filter((s) => s.has_statements).length === 0 && (
              <div className="px-4 py-6 text-[12px] text-[var(--muted-text)]">No annotated sites found.</div>
            )}
          </div>
        </div>
      </BentoCard>
    </div>
  )
}
