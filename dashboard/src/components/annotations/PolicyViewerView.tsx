import { useEffect, useMemo, useRef, useState } from 'react'
import type { AnnotationSiteRecord, AnnotationStats, AnnotationThirdPartyRecord } from '../../contracts/api'
import { ExplorerSite } from '../../data/explorer'

type PolicyViewerViewProps = {
  sites?: ExplorerSite[]
  annotationStats?: AnnotationStats | null
  outDir?: string
}

type PhraseId = [number, string] // [block_index, phrase_text]

type Statement = {
  action?: PhraseId[]
  data?: PhraseId[]
  processor?: PhraseId[]
  recipient?: PhraseId[]
  purpose?: PhraseId[]
  context?: PhraseId[]
  prohibition?: boolean
}

type AnnotatedStatement = {
  chunk_index: number
  source_text: string
  statement: Statement
}

type DocumentBlock = { element_indices: number[]; text: string }
type ChunkBlockMapItem = { index: number; text_range: [number, number] }
type DocumentChunk = { block_map: ChunkBlockMapItem[]; text: string }
type DocumentJson = { blocks: DocumentBlock[]; chunks: DocumentChunk[] }

type BlockInfo = {
  blockIdx: number
  text: string
  chunkIdx: number | null
  highlights: Array<{ field: string; phrase: string; stmtIdxs: number[] }>
  stmtIdxs: number[]
}

// ── Constants ─────────────────────────────────────────────────────────────────

const FIELDS = ['action', 'data', 'processor', 'purpose', 'recipient', 'context'] as const

const FIELD_CHIP: Record<string, string> = {
  action: 'bg-blue-900/50 text-blue-300 border-blue-700',
  data: 'bg-purple-900/50 text-purple-300 border-purple-700',
  processor: 'bg-gray-700/50 text-gray-300 border-gray-600',
  purpose: 'bg-green-900/50 text-green-300 border-green-700',
  recipient: 'bg-orange-900/50 text-orange-300 border-orange-700',
  context: 'bg-teal-900/50 text-teal-300 border-teal-700',
}

// Solid colors for phrase highlights (used as CSS background)
const FIELD_HL: Record<string, string> = {
  action: 'rgba(59,130,246,0.28)',
  data: 'rgba(168,85,247,0.28)',
  processor: 'rgba(107,114,128,0.28)',
  purpose: 'rgba(34,197,94,0.28)',
  recipient: 'rgba(249,115,22,0.28)',
  context: 'rgba(20,184,166,0.28)',
}

const FIELD_DOT: Record<string, string> = {
  action: '#3b82f6',
  data: '#a855f7',
  processor: '#6b7280',
  purpose: '#22c55e',
  recipient: '#f97316',
  context: '#14b8a6',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildBlockInfos(doc: DocumentJson, stmts: AnnotatedStatement[]): BlockInfo[] {
  // Build block → chunk index mapping
  const blockChunk = new Map<number, number>()
  doc.chunks.forEach((chunk, ci) => {
    if (chunk.block_map) {
      chunk.block_map.forEach((item) => blockChunk.set(item.index, ci))
    }
  })

  const infos: BlockInfo[] = doc.blocks.map((b, i) => ({
    blockIdx: i,
    text: b.text,
    chunkIdx: blockChunk.get(i) ?? null,
    highlights: [],
    stmtIdxs: [],
  }))

  for (let si = 0; si < stmts.length; si++) {
    const stmt = stmts[si].statement
    for (const field of FIELDS) {
      const vals = (stmt[field] as PhraseId[] | undefined) ?? []
      for (const [bi, phrase] of vals) {
        if (bi < 0 || bi >= infos.length || !phrase) continue
        infos[bi].highlights.push({ field, phrase, stmtIdxs: [si] })
        if (!infos[bi].stmtIdxs.includes(si)) infos[bi].stmtIdxs.push(si)
      }
    }
  }

  return infos
}

function highlightText(
  text: string,
  phrases: Array<{ field: string; phrase: string }>
): Array<{ text: string; field: string | null }> {
  type Span = { start: number; end: number; field: string }
  const spans: Span[] = []

  for (const { field, phrase } of phrases) {
    if (!phrase || phrase.length < 2) continue
    const lc = text.toLowerCase()
    const pl = phrase.toLowerCase()
    let pos = 0
    while (pos < text.length) {
      const idx = lc.indexOf(pl, pos)
      if (idx < 0) break
      spans.push({ start: idx, end: idx + phrase.length, field })
      pos = idx + phrase.length
    }
  }

  if (spans.length === 0) return [{ text, field: null }]

  spans.sort((a, b) => a.start - b.start || b.end - a.end)

  const merged: Span[] = []
  for (const sp of spans) {
    if (merged.length === 0 || sp.start >= merged[merged.length - 1].end) {
      merged.push({ ...sp })
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, sp.end)
    }
  }

  const result: Array<{ text: string; field: string | null }> = []
  let p = 0
  for (const sp of merged) {
    if (sp.start > p) result.push({ text: text.slice(p, sp.start), field: null })
    result.push({ text: text.slice(sp.start, sp.end), field: sp.field })
    p = sp.end
  }
  if (p < text.length) result.push({ text: text.slice(p), field: null })
  return result
}

function buildTopPhrases(
  stmts: AnnotatedStatement[],
  field: keyof Statement,
  n: number
): Array<{ label: string; count: number }> {
  const counts: Record<string, number> = {}
  for (const s of stmts) {
    const vals = (s.statement[field] as PhraseId[] | undefined) ?? []
    for (const [, phrase] of vals) {
      const key = phrase.toLowerCase().trim()
      counts[key] = (counts[key] || 0) + 1
    }
  }
  return Object.entries(counts)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n)
}

function deriveSourceText(statement: Statement | undefined, doc: DocumentJson | null): string {
  if (!statement || !doc?.blocks?.length) return ''
  const blockIdxs = new Set<number>()
  for (const field of FIELDS) {
    const vals = (statement[field] as PhraseId[] | undefined) ?? []
    for (const [idx] of vals) {
      if (idx >= 0 && idx < doc.blocks.length) blockIdxs.add(idx)
    }
  }
  return [...blockIdxs]
    .sort((a, b) => a - b)
    .map((idx) => doc.blocks[idx]?.text ?? '')
    .filter(Boolean)
    .join(' ')
}

function parseStatementLines(raw: string, doc: DocumentJson | null): AnnotatedStatement[] {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line: string) => {
      try {
        const parsed = JSON.parse(line)
        if (!parsed || typeof parsed !== 'object' || !parsed.statement) return null
        return {
          chunk_index: Number(parsed.chunk_index) || 0,
          source_text: String(parsed.source_text || deriveSourceText(parsed.statement, doc) || ''),
          statement: parsed.statement as Statement,
        } as AnnotatedStatement
      } catch {
        return null
      }
    })
    .filter((item): item is AnnotatedStatement => Boolean(item))
}

// ── Sub-components ────────────────────────────────────────────────────────────

function MiniBar({ count, max, color }: { count: number; max: number; color: string }) {
  return (
    <div className="w-14 h-1.5 rounded-full bg-black/30 overflow-hidden flex-shrink-0">
      <div
        className="h-full rounded-full"
        style={{ width: `${Math.min(100, (count / Math.max(1, max)) * 100)}%`, backgroundColor: color }}
      />
    </div>
  )
}

function ActiveStatementPanel({
  stmts,
  activeIdx,
  onPrev,
  onNext,
  onClose,
}: {
  stmts: AnnotatedStatement[]
  activeIdx: number
  onPrev: () => void
  onNext: () => void
  onClose: () => void
}) {
  const stmt = stmts[activeIdx]

  const sourceHighlights = useMemo(() => {
    if (!stmt) return []
    const { statement, source_text } = stmt
    const phrases: Array<{ field: string; phrase: string }> = []
    for (const field of FIELDS) {
      const vals = (statement[field] as PhraseId[] | undefined) ?? []
      for (const [, phrase] of vals) {
        if (phrase) phrases.push({ field, phrase })
      }
    }
    return highlightText(source_text || '', phrases)
  }, [stmt])

  if (!stmt) return null
  const { statement, chunk_index } = stmt
  const isProhibition = statement.prohibition === true

  return (
    <section className="card rounded-2xl p-4 sticky top-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--muted-text)]">
            Statement · chunk {chunk_index}
          </p>
          {isProhibition && (
            <span className="rounded-full bg-red-900/50 px-2 py-0.5 text-[9px] text-red-300 border border-red-700">
              prohibition
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {stmts.length > 1 && (
            <>
              <button
                className="focusable rounded-full px-2 py-0.5 text-[10px] border border-[var(--border-soft)] disabled:opacity-30"
                onClick={onPrev}
                disabled={activeIdx === 0}
              >
                ‹
              </button>
              <span className="text-[10px] text-[var(--muted-text)]">
                {activeIdx + 1}/{stmts.length}
              </span>
              <button
                className="focusable rounded-full px-2 py-0.5 text-[10px] border border-[var(--border-soft)] disabled:opacity-30"
                onClick={onNext}
                disabled={activeIdx === stmts.length - 1}
              >
                ›
              </button>
            </>
          )}
          <button
            className="focusable ml-1 rounded-full px-2 py-0.5 text-[10px] border border-[var(--border-soft)]"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Source text with phrase highlights */}
      <div
        className={`rounded-lg p-3 text-[11px] leading-relaxed mb-3 ${
          isProhibition
            ? 'bg-red-950/30 border border-red-800/40'
            : 'bg-black/20 border border-[var(--border-soft)]'
        }`}
      >
        <p className="text-[9px] uppercase tracking-widest text-[var(--muted-text)] mb-1.5">
          Source text
        </p>
        <p className="italic text-[var(--color-text)]">
          {sourceHighlights.map((seg, i) =>
            seg.field ? (
              <mark
                key={i}
                style={{
                  backgroundColor: FIELD_HL[seg.field],
                  color: 'inherit',
                  borderRadius: 3,
                  padding: '0 2px',
                }}
              >
                {seg.text}
              </mark>
            ) : (
              <span key={i}>{seg.text}</span>
            )
          )}
        </p>
      </div>

      {/* Field chips */}
      <div className="flex flex-wrap gap-1.5">
        {FIELDS.map((field) => {
          const vals = (statement[field] as PhraseId[] | undefined) ?? []
          return vals.map(([, phrase], i) => (
            <span
              key={`${field}-${i}`}
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] ${FIELD_CHIP[field] ?? ''}`}
            >
              <span className="mr-1 font-semibold opacity-60">{field}</span>
              {phrase}
            </span>
          ))
        })}
      </div>
    </section>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function PolicyViewerView({ sites, annotationStats, outDir }: PolicyViewerViewProps) {
  const [policyType, setPolicyType] = useState<'first' | 'third'>('first')
  const [selectedSite, setSelectedSite] = useState('')
  const [selectedTp, setSelectedTp] = useState('')
  const [loading, setLoading] = useState(false)
  const [policyText, setPolicyText] = useState<string | null>(null)
  const [statements, setStatements] = useState<AnnotatedStatement[]>([])
  const [docJson, setDocJson] = useState<DocumentJson | null>(null)
  const [activeStmtIdxs, setActiveStmtIdxs] = useState<number[]>([])
  const [activeInGroup, setActiveInGroup] = useState(0)
  const [hoveredBlock, setHoveredBlock] = useState<number | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Annotated site names for quick lookup
  const annotatedSites = useMemo<Set<string>>(() => {
    if (!annotationStats?.per_site) return new Set()
    return new Set(
      annotationStats.per_site
        .filter((s: AnnotationSiteRecord) => s.has_statements)
        .map((s: AnnotationSiteRecord) => s.site)
    )
  }, [annotationStats])

  // Annotated TP lookup: "site/tp" → true
  const annotatedTps = useMemo<Set<string>>(() => {
    if (!annotationStats?.per_tp) return new Set()
    return new Set(
      annotationStats.per_tp
        .filter((t: AnnotationThirdPartyRecord) => t.has_statements)
        .map((t) => `${t.site}/${t.tp}`)
    )
  }, [annotationStats])

  // Reset on outDir change
  const prevOutDir = useRef(outDir)
  useEffect(() => {
    if (prevOutDir.current !== outDir) {
      prevOutDir.current = outDir
      reset()
    }
  }, [outDir])

  function reset() {
    setPolicyText(null)
    setStatements([])
    setDocJson(null)
    setActiveStmtIdxs([])
    setLoadError(null)
  }

  // Reset TP on site change
  useEffect(() => {
    setSelectedTp('')
    reset()
  }, [selectedSite])

  // Reset on type change
  useEffect(() => {
    setSelectedSite('')
    setSelectedTp('')
    reset()
  }, [policyType])

  const availableSites = useMemo(() => {
    if (!sites?.length) return []
    // Deduplicate by site name (unified explorer.jsonl can have the same site across multiple runs)
    const seen = new Set<string>()
    return sites
      .filter((s) => { if (seen.has(s.site)) return false; seen.add(s.site); return true })
      .sort((a, b) => a.site.localeCompare(b.site))
  }, [sites])

  const siteData = useMemo(
    () => (selectedSite && sites ? sites.find((s) => s.site === selectedSite) ?? null : null),
    [selectedSite, sites]
  )

  const availableTps = useMemo(
    () => siteData?.thirdParties.filter((tp) => tp.name) ?? [],
    [siteData]
  )

  const canLoad =
    policyType === 'first' ? Boolean(selectedSite) : Boolean(selectedSite && selectedTp)

  // Auto-load
  useEffect(() => {
    if (!canLoad) return
    void doLoad()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSite, selectedTp, policyType, outDir])

  async function doLoad() {
    if (!window.scraper?.readArtifactText) return
    setLoading(true)
    setLoadError(null)
    setPolicyText(null)
    setStatements([])
    setDocJson(null)
    setActiveStmtIdxs([])

    const base =
      policyType === 'first'
        ? `artifacts/${selectedSite}`
        : `artifacts/${selectedSite}/third_party/${selectedTp}`
    const root = outDir || 'outputs'

    try {
      const [pRes, sRes, bRes, dRes] = await Promise.all([
        window.scraper.readArtifactText({ outDir: root, relativePath: `${base}/policy.txt` }),
        window.scraper.readArtifactText({
          outDir: root,
          relativePath: `${base}/policy_statements_annotated.jsonl`,
        }),
        window.scraper.readArtifactText({
          outDir: root,
          relativePath: `${base}/policy_statements.jsonl`,
        }),
        window.scraper.readArtifactText({ outDir: root, relativePath: `${base}/document.json` }),
      ])

      if (pRes?.ok && pRes.data) {
        setPolicyText(pRes.data as string)
      } else {
        setLoadError(`Policy text not found at ${root}/${base}/policy.txt`)
      }

      let parsedDoc: DocumentJson | null = null
      if (dRes?.ok && dRes.data) {
        try {
          parsedDoc = JSON.parse(dRes.data as string)
          setDocJson(parsedDoc)
        } catch {
          /* ignore */
        }
      }

      const annotatedStatements = sRes?.ok && sRes.data
        ? parseStatementLines(sRes.data as string, parsedDoc)
        : []
      const baseStatements = bRes?.ok && bRes.data
        ? parseStatementLines(bRes.data as string, parsedDoc)
        : []
      setStatements(annotatedStatements.length > 0 ? annotatedStatements : baseStatements)
    } catch (e) {
      setLoadError(String(e))
    }

    setLoading(false)
  }

  // Block annotations
  const blockInfos = useMemo<BlockInfo[] | null>(
    () => (docJson ? buildBlockInfos(docJson, statements) : null),
    [docJson, statements]
  )

  // Stats
  const prohibitionCount = statements.filter((s) => s.statement.prohibition === true).length
  const prohibitionRate =
    statements.length > 0 ? ((prohibitionCount / statements.length) * 100).toFixed(1) : '0'
  const topActions = buildTopPhrases(statements, 'action', 6)
  const topData = buildTopPhrases(statements, 'data', 6)
  const annotatedBlockCount = blockInfos?.filter((b) => b.stmtIdxs.length > 0).length ?? 0

  const policyUrl =
    policyType === 'first'
      ? siteData?.policyUrl
      : availableTps.find((tp) => tp.name === selectedTp)?.policyUrl

  const activeStmts = activeStmtIdxs.map((i) => statements[i]).filter(Boolean)
  const activeStmt = activeStmts[activeInGroup] ?? null

  // Chunk start blocks: first block of each chunk
  const chunkStartBlocks = useMemo<Set<number>>(() => {
    if (!docJson) return new Set()
    const starts = new Set<number>()
    docJson.chunks.forEach((chunk) => {
      if (chunk.block_map?.length) starts.add(chunk.block_map[0].index)
    })
    return starts
  }, [docJson])

  const displayName =
    policyType === 'third' && selectedTp
      ? `${selectedTp} (via ${selectedSite})`
      : selectedSite || '—'

  // ── Render ──────────────────────────────────────────────────────────────────

  const hasContent = Boolean(policyText || loading)

  return (
    <div className="space-y-4">
      {/* ── Selector bar ── */}
      <section className="card rounded-2xl p-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* Policy type toggle */}
          <div className="flex overflow-hidden rounded-xl border border-[var(--border-soft)] text-xs">
            {(
              [
                { id: 'first', label: 'First-party site' },
                { id: 'third', label: 'Third-party service' },
              ] as const
            ).map(({ id, label }) => (
              <button
                key={id}
                className={`px-4 py-2 transition ${
                  policyType === id
                    ? 'bg-[var(--color-primary)] text-white'
                    : 'text-[var(--muted-text)] hover:bg-black/20'
                }`}
                onClick={() => setPolicyType(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Site selector */}
          <select
            value={selectedSite}
            onChange={(e) => setSelectedSite(e.target.value)}
            className="focusable min-w-[180px] rounded-xl border border-[var(--border-soft)] bg-black/20 px-3 py-2 text-xs text-white"
          >
            <option value="">Select a site…</option>
            {availableSites.map((s) => (
              <option key={s.site} value={s.site}>
                {s.site}
                {annotatedSites.has(s.site) ? ' ✦' : ''}
              </option>
            ))}
          </select>

          {/* TP selector */}
          {policyType === 'third' && selectedSite && (
            <>
              <span className="text-xs text-[var(--muted-text)]">→</span>
              <select
                value={selectedTp}
                onChange={(e) => setSelectedTp(e.target.value)}
                className="focusable min-w-[200px] rounded-xl border border-[var(--border-soft)] bg-black/20 px-3 py-2 text-xs text-white"
              >
                <option value="">Select third-party…</option>
                {availableTps.map((tp) => (
                  <option key={tp.name} value={tp.name}>
                    {tp.name}
                    {annotatedTps.has(`${selectedSite}/${tp.name}`) ? ' ✦' : ''}
                    {tp.entity ? ` · ${tp.entity}` : ''}
                    {tp.categories?.length ? ` [${tp.categories[0]}]` : ''}
                  </option>
                ))}
              </select>
            </>
          )}

          {loading && (
            <span className="animate-pulse text-xs text-[var(--muted-text)]">Loading…</span>
          )}
        </div>

        {!sites?.length && (
          <p className="mt-3 text-xs text-[var(--muted-text)]">
            No site data loaded. Run a scrape or load an output directory from Database.
          </p>
        )}
        {sites?.length && !availableSites.length && (
          <p className="mt-3 text-xs text-[var(--muted-text)]">No sites with policy URLs found.</p>
        )}
      </section>

      {/* ── Empty state ── */}
      {!hasContent && !loadError && (
        <section className="card rounded-2xl p-12 text-center">
          <svg
            viewBox="0 0 24 24"
            className="mx-auto mb-3 h-10 w-10 text-[var(--muted-text)] opacity-30"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
          <p className="text-sm text-[var(--muted-text)]">
            Select a{policyType === 'first' ? ' site' : ' site and third-party service'} above to
            view its annotated privacy policy.
          </p>
          {policyType === 'first' && (
            <p className="mt-1 text-xs text-[var(--muted-text)]">
              Sites marked with ✦ have LLM annotations available.
            </p>
          )}
        </section>
      )}

      {/* ── Error ── */}
      {loadError && (
        <section className="card rounded-2xl p-4">
          <p className="text-xs text-red-400">{loadError}</p>
        </section>
      )}

      {/* ── Main content ── */}
      {hasContent && !loadError && (
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          {/* ── Left panel ── */}
          <div className="flex flex-col gap-3">
            {/* Policy info */}
            <section className="card rounded-2xl p-4">
              <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--muted-text)]">
                {policyType === 'third' ? 'Third-party policy' : 'First-party policy'}
              </p>
              <h3 className="mt-1 truncate text-sm font-semibold" title={displayName}>
                {displayName}
              </h3>
              {policyUrl && (
                <p
                  className="mt-1 break-all text-[10px] leading-relaxed text-[var(--muted-text)]"
                  title={policyUrl}
                >
                  {policyUrl}
                </p>
              )}

              <div className="mt-3 grid grid-cols-2 gap-2">
                {[
                  { label: 'Statements', value: statements.length },
                  { label: 'Prohibitions', value: `${prohibitionCount} (${prohibitionRate}%)` },
                  ...(docJson
                    ? [
                        { label: 'Blocks', value: docJson.blocks.length },
                        { label: 'Chunks', value: docJson.chunks.length },
                        { label: 'Annotated blocks', value: annotatedBlockCount },
                        { label: 'Coverage', value: docJson.blocks.length > 0 ? `${Math.round((annotatedBlockCount / docJson.blocks.length) * 100)}%` : '—' },
                      ]
                    : []),
                ].map((item) => (
                  <div
                    key={item.label}
                    className="rounded-lg border border-[var(--border-soft)] bg-black/20 px-3 py-2"
                  >
                    <p className="text-[10px] text-[var(--muted-text)]">{item.label}</p>
                    <p className="text-sm font-semibold">
                      {typeof item.value === 'number' ? item.value.toLocaleString() : item.value}
                    </p>
                  </div>
                ))}
              </div>
            </section>

            {/* Top phrases */}
            {statements.length > 0 && (
              <section className="card rounded-2xl p-4">
                <p className="text-[10px] uppercase tracking-[0.2em]" style={{ color: FIELD_DOT.action }}>
                  Top actions
                </p>
                <div className="mt-2 space-y-1.5">
                  {topActions.length === 0 ? (
                    <p className="text-xs text-[var(--muted-text)]">No data</p>
                  ) : (
                    topActions.map(({ label, count }) => (
                      <div key={label} className="flex items-center gap-2 text-xs">
                        <span className="flex-1 truncate text-[var(--muted-text)]">{label}</span>
                        <MiniBar count={count} max={topActions[0].count} color={FIELD_DOT.action} />
                        <span className="w-5 text-right text-[var(--muted-text)]">{count}</span>
                      </div>
                    ))
                  )}
                </div>

                <p className="mt-3 text-[10px] uppercase tracking-[0.2em]" style={{ color: FIELD_DOT.data }}>
                  Top data types
                </p>
                <div className="mt-2 space-y-1.5">
                  {topData.length === 0 ? (
                    <p className="text-xs text-[var(--muted-text)]">No data</p>
                  ) : (
                    topData.map(({ label, count }) => (
                      <div key={label} className="flex items-center gap-2 text-xs">
                        <span className="flex-1 truncate text-[var(--muted-text)]">{label}</span>
                        <MiniBar count={count} max={topData[0].count} color={FIELD_DOT.data} />
                        <span className="w-5 text-right text-[var(--muted-text)]">{count}</span>
                      </div>
                    ))
                  )}
                </div>
              </section>
            )}

            {/* Active statement */}
            {activeStmt ? (
              <ActiveStatementPanel
                stmts={activeStmts}
                activeIdx={activeInGroup}
                onPrev={() => setActiveInGroup((i) => Math.max(0, i - 1))}
                onNext={() => setActiveInGroup((i) => Math.min(activeStmts.length - 1, i + 1))}
                onClose={() => {
                  setActiveStmtIdxs([])
                  setActiveInGroup(0)
                }}
              />
            ) : (
              statements.length > 0 && (
                <section className="card rounded-2xl p-4 text-center">
                  <p className="text-xs text-[var(--muted-text)]">
                    Hover over highlighted text to see phrase details.
                    <br />
                    Click to pin a statement here.
                  </p>
                </section>
              )
            )}
          </div>

          {/* ── Right panel: policy text ── */}
          <section className="card rounded-2xl p-5">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--muted-text)]">
                  Policy text
                </p>
                {blockInfos ? (
                  <p className="text-xs text-[var(--muted-text)]">
                    {docJson?.blocks.length} blocks ·{' '}
                    {annotatedBlockCount > 0
                      ? `${annotatedBlockCount} annotated — hover for details, click to pin`
                      : 'no annotations found'}
                  </p>
                ) : statements.length > 0 ? (
                  <p className="text-xs text-[var(--muted-text)]">
                    {statements.length} statements — hover source text to reveal, click to pin
                  </p>
                ) : (
                  <p className="text-xs text-[var(--muted-text)]">
                    {policyText ? 'No annotation data available for this policy.' : ''}
                  </p>
                )}
              </div>
              {/* Legend */}
              <div className="flex flex-wrap gap-2">
                {FIELDS.slice(0, 4).map((f) => (
                  <span key={f} className="flex items-center gap-1 text-[10px] text-[var(--muted-text)]">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ backgroundColor: FIELD_DOT[f] }}
                    />
                    {f}
                  </span>
                ))}
              </div>
            </div>

            {/* ── Block-based rendering ── */}
            {blockInfos ? (
              <div className="max-h-[70vh] overflow-y-auto space-y-0.5 rounded-xl border border-[var(--border-soft)] bg-black/10 p-4">
                {blockInfos.map((block) => {
                  const isAnnotated = block.stmtIdxs.length > 0
                  const isHovered = hoveredBlock === block.blockIdx
                  const isActive =
                    activeStmtIdxs.length > 0 &&
                    block.stmtIdxs.some((i) => activeStmtIdxs.includes(i))
                  const isChunkStart = chunkStartBlocks.has(block.blockIdx)

                  // Deduplicate phrases for rendering
                  const dedupedPhrases = block.highlights.filter(
                    (h, i, arr) =>
                      i === arr.findIndex((x) => x.phrase === h.phrase && x.field === h.field)
                  )
                  const segments = isAnnotated
                    ? highlightText(block.text, dedupedPhrases)
                    : [{ text: block.text, field: null }]

                  return (
                    <div key={block.blockIdx}>
                      {/* Chunk divider */}
                      {isChunkStart && block.blockIdx > 0 && (
                        <div className="my-2 flex items-center gap-2">
                          <div className="h-px flex-1 bg-[var(--border-soft)] opacity-40" />
                          <span className="text-[9px] text-[var(--muted-text)] opacity-50">
                            chunk {block.chunkIdx}
                          </span>
                          <div className="h-px flex-1 bg-[var(--border-soft)] opacity-40" />
                        </div>
                      )}

                      {/* Block paragraph */}
                      <p
                        className={`rounded-lg px-2 py-1.5 text-xs leading-relaxed transition-colors ${
                          isAnnotated
                            ? `cursor-pointer select-text ${
                                isActive
                                  ? 'bg-white/8 ring-1 ring-[var(--color-primary)]/40'
                                  : isHovered
                                  ? 'bg-white/5'
                                  : 'bg-transparent hover:bg-white/[0.03]'
                              }`
                            : 'text-[var(--muted-text)]'
                        }`}
                        onMouseEnter={() => isAnnotated && setHoveredBlock(block.blockIdx)}
                        onMouseLeave={() => setHoveredBlock(null)}
                        onClick={() => {
                          if (!isAnnotated) return
                          setActiveStmtIdxs(block.stmtIdxs)
                          setActiveInGroup(0)
                        }}
                        title={
                          isAnnotated
                            ? `Block ${block.blockIdx} · chunk ${block.chunkIdx} · ${block.stmtIdxs.length} statement${block.stmtIdxs.length > 1 ? 's' : ''}`
                            : undefined
                        }
                      >
                        {/* Hover tooltip badge */}
                        {isAnnotated && isHovered && !isActive && (
                          <span className="mr-2 inline-flex items-center rounded-full border border-[var(--border-soft)] bg-black/60 px-1.5 py-0.5 text-[9px] text-[var(--muted-text)] align-middle">
                            block {block.blockIdx} · {block.stmtIdxs.length}×
                          </span>
                        )}

                        {segments.map((seg, i) =>
                          seg.field ? (
                            <mark
                              key={i}
                              style={{
                                backgroundColor: isActive || isHovered ? FIELD_HL[seg.field] : 'rgba(255,255,255,0.06)',
                                color: 'inherit',
                                borderBottom: `1.5px solid ${FIELD_DOT[seg.field]}`,
                                borderRadius: 3,
                                padding: '0 1px',
                              }}
                            >
                              {seg.text}
                            </mark>
                          ) : (
                            <span key={i}>{seg.text}</span>
                          )
                        )}
                      </p>
                    </div>
                  )
                })}
              </div>
            ) : policyText ? (
              /* ── Raw policy text fallback ── */
              <div className="max-h-[70vh] overflow-y-auto rounded-xl border border-[var(--border-soft)] bg-black/10 p-4">
                {statements.length > 0 && (
                  <p className="mb-3 rounded-lg border border-yellow-700/40 bg-yellow-900/10 px-3 py-2 text-[10px] text-yellow-400">
                    Annotation document structure unavailable. Showing raw policy text — annotations
                    are listed in the stats panel but cannot be overlaid here.
                  </p>
                )}
                <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-[var(--muted-text)]">
                  {policyText}
                </pre>
              </div>
            ) : loading ? (
              <div className="flex h-40 items-center justify-center">
                <span className="animate-pulse text-xs text-[var(--muted-text)]">Loading policy…</span>
              </div>
            ) : null}
          </section>
        </div>
      )}
    </div>
  )
}
