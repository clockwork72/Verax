import { useEffect, useMemo, useRef, useState } from 'react'

import type { AnnotationSiteRecord, AnnotationStats, AnnotationThirdPartyRecord } from '../../contracts/api'
import type { ExplorerSite, ExplorerThirdParty } from '../../data/explorer'
import { readArtifactTexts } from '../../lib/artifactClient'
import { BentoCard, BentoGrid } from '../ui/BentoCard'
import { StatusPill } from '../ui/StatusPill'

type PolicyViewerViewProps = {
  sites?: ExplorerSite[]
  annotationStats?: AnnotationStats | null
  outDir?: string
}

type PhraseId = [number, string]

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
  highlights: Array<{ field: FieldName; phrase: string; stmtIdxs: number[] }>
  stmtIdxs: number[]
}

const FIELDS = ['action', 'data', 'processor', 'purpose', 'recipient', 'context'] as const
type FieldName = (typeof FIELDS)[number]

const FIELD_META: Record<FieldName, { label: string; color: string; panel: string }> = {
  action: { label: 'Action', color: '#6EA8FF', panel: 'rgba(110,168,255,0.12)' },
  data: { label: 'Data', color: '#C68BFF', panel: 'rgba(198,139,255,0.12)' },
  processor: { label: 'Processor', color: '#F5FBFF', panel: 'rgba(245,251,255,0.10)' },
  purpose: { label: 'Purpose', color: '#38D98A', panel: 'rgba(56,217,138,0.12)' },
  recipient: { label: 'Recipient', color: '#FF9B5E', panel: 'rgba(255,155,94,0.12)' },
  context: { label: 'Context', color: '#32D4C5', panel: 'rgba(50,212,197,0.12)' },
}

function alpha(hex: string, opacity: number) {
  const normalized = hex.replace('#', '')
  const value = normalized.length === 3
    ? normalized.split('').map((c) => c + c).join('')
    : normalized
  const int = Number.parseInt(value, 16)
  const r = (int >> 16) & 255
  const g = (int >> 8) & 255
  const b = int & 255
  return `rgba(${r}, ${g}, ${b}, ${opacity})`
}

function buildBlockInfos(doc: DocumentJson, stmts: AnnotatedStatement[]): BlockInfo[] {
  const blockChunk = new Map<number, number>()
  doc.chunks.forEach((chunk, ci) => {
    chunk.block_map?.forEach((item) => blockChunk.set(item.index, ci))
  })

  const infos: BlockInfo[] = doc.blocks.map((block, idx) => ({
    blockIdx: idx,
    text: block.text,
    chunkIdx: blockChunk.get(idx) ?? null,
    highlights: [],
    stmtIdxs: [],
  }))

  for (let stmtIdx = 0; stmtIdx < stmts.length; stmtIdx += 1) {
    const stmt = stmts[stmtIdx].statement
    for (const field of FIELDS) {
      const vals = (stmt[field] as PhraseId[] | undefined) ?? []
      for (const [blockIdx, phrase] of vals) {
        if (blockIdx < 0 || blockIdx >= infos.length || !phrase) continue
        infos[blockIdx].highlights.push({ field, phrase, stmtIdxs: [stmtIdx] })
        if (!infos[blockIdx].stmtIdxs.includes(stmtIdx)) infos[blockIdx].stmtIdxs.push(stmtIdx)
      }
    }
  }

  return infos
}

function highlightText(
  text: string,
  phrases: Array<{ field: FieldName; phrase: string }>,
): Array<{ text: string; field: FieldName | null }> {
  type Span = { start: number; end: number; field: FieldName }
  const spans: Span[] = []
  const lower = text.toLowerCase()

  for (const { field, phrase } of phrases) {
    if (!phrase || phrase.length < 2) continue
    const query = phrase.toLowerCase()
    let pos = 0
    while (pos < text.length) {
      const idx = lower.indexOf(query, pos)
      if (idx < 0) break
      spans.push({ start: idx, end: idx + phrase.length, field })
      pos = idx + phrase.length
    }
  }

  if (spans.length === 0) return [{ text, field: null }]
  spans.sort((a, b) => a.start - b.start || b.end - a.end)

  const merged: Span[] = []
  for (const span of spans) {
    if (merged.length === 0 || span.start >= merged[merged.length - 1].end) {
      merged.push({ ...span })
      continue
    }
    merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, span.end)
  }

  const result: Array<{ text: string; field: FieldName | null }> = []
  let cursor = 0
  for (const span of merged) {
    if (span.start > cursor) result.push({ text: text.slice(cursor, span.start), field: null })
    result.push({ text: text.slice(span.start, span.end), field: span.field })
    cursor = span.end
  }
  if (cursor < text.length) result.push({ text: text.slice(cursor), field: null })
  return result
}

function buildTopPhrases(
  stmts: AnnotatedStatement[],
  field: keyof Statement,
  limit: number,
): Array<{ label: string; count: number }> {
  const counts: Record<string, number> = {}
  for (const stmt of stmts) {
    const vals = (stmt.statement[field] as PhraseId[] | undefined) ?? []
    for (const [, phrase] of vals) {
      const key = phrase.toLowerCase().trim()
      counts[key] = (counts[key] || 0) + 1
    }
  }
  return Object.entries(counts)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
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
    .map((line) => {
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

function metricLabel(value: number | string) {
  return typeof value === 'number' ? value.toLocaleString() : value
}

function wordCount(text: string | null) {
  if (!text?.trim()) return 0
  return text.trim().split(/\s+/).length
}

function FieldChip({ field, phrase }: { field: FieldName; phrase: string }) {
  const meta = FIELD_META[field]
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px]"
      style={{
        background: meta.panel,
        borderColor: alpha(meta.color, 0.35),
        color: 'var(--color-text)',
      }}
    >
      <span className="font-semibold" style={{ color: meta.color }}>
        {meta.label}
      </span>
      <span>{phrase}</span>
    </span>
  )
}

function MiniBar({ count, max, color }: { count: number; max: number; color: string }) {
  return (
    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/8">
      <div
        className="h-full rounded-full"
        style={{ width: `${Math.min(100, (count / Math.max(1, max)) * 100)}%`, backgroundColor: color }}
      />
    </div>
  )
}

function MetricTile({ label, value, detail }: { label: string; value: number | string; detail: string }) {
  return (
    <BentoCard>
      <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted-text)]">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-[var(--color-text)]">{metricLabel(value)}</p>
      <p className="mt-2 text-[12px] text-[var(--muted-text)]">{detail}</p>
    </BentoCard>
  )
}

function PhraseColumn({
  title,
  field,
  rows,
}: {
  title: string
  field: FieldName
  rows: Array<{ label: string; count: number }>
}) {
  return (
    <div className="rounded-2xl border border-[var(--border-soft)] bg-black/10 p-4">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: FIELD_META[field].color }} />
        <p className="text-[11px] uppercase tracking-[0.16em]" style={{ color: FIELD_META[field].color }}>
          {title}
        </p>
      </div>
      <div className="mt-3 space-y-2">
        {rows.length === 0 && <p className="text-[12px] text-[var(--muted-text)]">No extracted phrases.</p>}
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-2 text-[12px]">
            <span className="flex-1 truncate text-[var(--color-text)]" title={row.label}>
              {row.label}
            </span>
            <MiniBar count={row.count} max={rows[0].count} color={FIELD_META[field].color} />
            <span className="w-7 text-right text-[var(--muted-text)]">{row.count}</span>
          </div>
        ))}
      </div>
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
    const phrases: Array<{ field: FieldName; phrase: string }> = []
    for (const field of FIELDS) {
      const vals = (stmt.statement[field] as PhraseId[] | undefined) ?? []
      for (const [, phrase] of vals) {
        if (phrase) phrases.push({ field, phrase })
      }
    }
    return highlightText(stmt.source_text || '', phrases)
  }, [stmt])

  if (!stmt) return null
  const isProhibition = stmt.statement.prohibition === true

  return (
    <BentoCard className="p-5" glow>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Pinned statement</p>
          <h3 className="mt-1 text-sm font-semibold text-[var(--color-text)]">Chunk {stmt.chunk_index}</h3>
        </div>
        <div className="flex items-center gap-2">
          {isProhibition && <StatusPill variant="error" label="prohibition" />}
          {stmts.length > 1 && (
            <span className="rounded-full border border-[var(--border-soft)] px-2.5 py-1 text-[11px] text-[var(--muted-text)]">
              {activeIdx + 1}/{stmts.length}
            </span>
          )}
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-[var(--border-soft)] bg-black/15 p-4">
        <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Source text</p>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text)]">
          {sourceHighlights.map((segment, index) =>
            segment.field ? (
              <mark
                key={`${segment.field}-${index}`}
                style={{
                  background: alpha(FIELD_META[segment.field].color, 0.18),
                  boxShadow: `inset 0 -1px 0 ${FIELD_META[segment.field].color}`,
                  color: 'inherit',
                  borderRadius: 4,
                  padding: '0 2px',
                }}
              >
                {segment.text}
              </mark>
            ) : (
              <span key={`plain-${index}`}>{segment.text}</span>
            ),
          )}
        </p>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {FIELDS.flatMap((field) => {
          const vals = (stmt.statement[field] as PhraseId[] | undefined) ?? []
          return vals.map(([, phrase], index) => <FieldChip key={`${field}-${index}`} field={field} phrase={phrase} />)
        })}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1.5 text-[11px] text-[var(--muted-text)] transition-colors hover:border-[var(--glass-border)] hover:text-[var(--color-text)] disabled:opacity-40"
          onClick={onPrev}
          disabled={activeIdx === 0}
        >
          Previous
        </button>
        <button
          type="button"
          className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1.5 text-[11px] text-[var(--muted-text)] transition-colors hover:border-[var(--glass-border)] hover:text-[var(--color-text)] disabled:opacity-40"
          onClick={onNext}
          disabled={activeIdx === stmts.length - 1}
        >
          Next
        </button>
        <button
          type="button"
          className="focusable rounded-full border border-[rgba(59,217,255,0.28)] px-3 py-1.5 text-[11px] text-[var(--color-primary)] transition-colors hover:bg-[rgba(59,217,255,0.08)]"
          onClick={onClose}
        >
          Clear pin
        </button>
      </div>
    </BentoCard>
  )
}

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

  const annotatedSites = useMemo<Set<string>>(() => {
    if (!annotationStats?.per_site) return new Set()
    return new Set(
      annotationStats.per_site
        .filter((site: AnnotationSiteRecord) => site.has_statements)
        .map((site: AnnotationSiteRecord) => site.site),
    )
  }, [annotationStats])

  const annotatedTps = useMemo<Set<string>>(() => {
    if (!annotationStats?.per_tp) return new Set()
    return new Set(
      annotationStats.per_tp
        .filter((tp: AnnotationThirdPartyRecord) => tp.has_statements)
        .map((tp) => `${tp.site}/${tp.tp}`),
    )
  }, [annotationStats])

  const prevOutDir = useRef(outDir)
  useEffect(() => {
    if (prevOutDir.current === outDir) return
    prevOutDir.current = outDir
    resetState()
  }, [outDir])

  function resetState() {
    setPolicyText(null)
    setStatements([])
    setDocJson(null)
    setActiveStmtIdxs([])
    setActiveInGroup(0)
    setHoveredBlock(null)
    setLoadError(null)
  }

  useEffect(() => {
    setSelectedTp('')
    resetState()
  }, [selectedSite])

  useEffect(() => {
    setSelectedSite('')
    setSelectedTp('')
    resetState()
  }, [policyType])

  const availableSites = useMemo(() => {
    if (!sites?.length) return []
    const seen = new Set<string>()
    return sites
      .filter((site) => {
        if (seen.has(site.site)) return false
        seen.add(site.site)
        return true
      })
      .sort((a, b) => a.site.localeCompare(b.site))
  }, [sites])

  const selectedSiteData = useMemo(
    () => (selectedSite ? availableSites.find((site) => site.site === selectedSite) ?? null : null),
    [availableSites, selectedSite],
  )

  const availableTps = useMemo(
    () => (selectedSiteData?.thirdParties ?? []).filter((tp) => tp.name),
    [selectedSiteData],
  )

  const selectedTpData = useMemo<ExplorerThirdParty | null>(
    () => availableTps.find((tp) => tp.name === selectedTp) ?? null,
    [availableTps, selectedTp],
  )

  const canLoad = policyType === 'first' ? Boolean(selectedSite) : Boolean(selectedSite && selectedTp)

  useEffect(() => {
    if (!canLoad) return
    void loadArtifacts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSite, selectedTp, policyType, outDir])

  async function loadArtifacts() {
    const base =
      policyType === 'first'
        ? `artifacts/${selectedSite}`
        : `artifacts/${selectedSite}/third_party/${selectedTp}`
    const root = outDir || 'outputs'

    setLoading(true)
    setLoadError(null)
    setPolicyText(null)
    setStatements([])
    setDocJson(null)
    setActiveStmtIdxs([])
    setActiveInGroup(0)

    try {
      const responses = await readArtifactTexts(root, [
        `${base}/policy.txt`,
        `${base}/policy_statements_annotated.jsonl`,
        `${base}/policy_statements.jsonl`,
        `${base}/document.json`,
      ])

      const policyRes = responses[`${base}/policy.txt`]
      const annotatedRes = responses[`${base}/policy_statements_annotated.jsonl`]
      const baseRes = responses[`${base}/policy_statements.jsonl`]
      const docRes = responses[`${base}/document.json`]

      if (policyRes?.ok && policyRes.data) {
        setPolicyText(policyRes.data)
      } else {
        setLoadError(`Policy text not found at ${root}/${base}/policy.txt`)
      }

      let parsedDoc: DocumentJson | null = null
      if (docRes?.ok && docRes.data) {
        try {
          parsedDoc = JSON.parse(docRes.data)
          setDocJson(parsedDoc)
        } catch {
          parsedDoc = null
        }
      }

      const annotatedStatements = annotatedRes?.ok && annotatedRes.data
        ? parseStatementLines(annotatedRes.data, parsedDoc)
        : []
      const baseStatements = baseRes?.ok && baseRes.data
        ? parseStatementLines(baseRes.data, parsedDoc)
        : []
      setStatements(annotatedStatements.length > 0 ? annotatedStatements : baseStatements)
    } catch (error) {
      setLoadError(String(error))
    } finally {
      setLoading(false)
    }
  }

  const blockInfos = useMemo(
    () => (docJson ? buildBlockInfos(docJson, statements) : null),
    [docJson, statements],
  )

  const prohibitionCount = statements.filter((stmt) => stmt.statement.prohibition === true).length
  const prohibitionRate = statements.length > 0 ? `${((prohibitionCount / statements.length) * 100).toFixed(1)}%` : '0%'
  const topActions = useMemo(() => buildTopPhrases(statements, 'action', 6), [statements])
  const topData = useMemo(() => buildTopPhrases(statements, 'data', 6), [statements])
  const topPurposes = useMemo(() => buildTopPhrases(statements, 'purpose', 6), [statements])
  const annotatedBlockCount = blockInfos?.filter((block) => block.stmtIdxs.length > 0).length ?? 0
  const totalWords = wordCount(policyText)
  const coverage = docJson?.blocks.length ? `${Math.round((annotatedBlockCount / docJson.blocks.length) * 100)}%` : '—'

  const policyUrl = policyType === 'first' ? selectedSiteData?.policyUrl ?? '' : selectedTpData?.policyUrl ?? ''
  const selectionAnnotated = policyType === 'first'
    ? annotatedSites.has(selectedSite)
    : annotatedTps.has(`${selectedSite}/${selectedTp}`)
  const displayName = policyType === 'third' && selectedTp
    ? `${selectedTp} via ${selectedSite}`
    : selectedSite || '—'

  const activeStatements = activeStmtIdxs.map((idx) => statements[idx]).filter(Boolean)
  const activeStatement = activeStatements[activeInGroup] ?? null

  const chunkStartBlocks = useMemo(() => {
    if (!docJson) return new Set<number>()
    const starts = new Set<number>()
    docJson.chunks.forEach((chunk) => {
      if (chunk.block_map?.length) starts.add(chunk.block_map[0].index)
    })
    return starts
  }, [docJson])

  const hasContent = Boolean(policyText || loading)
  const overviewMetrics = [
    { label: 'Words', value: totalWords, detail: 'Readable policy body currently loaded.' },
    { label: 'Statements', value: statements.length, detail: 'Structured privacy statements extracted.' },
    { label: 'Prohibitions', value: prohibitionCount, detail: `${prohibitionRate} of extracted statements.` },
    { label: 'Coverage', value: coverage, detail: docJson ? 'Annotated document block coverage.' : 'Document map unavailable.' },
  ]

  return (
    <div className="flex flex-col gap-5">
      <BentoCard className="p-5" glow>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Policy viewer</p>
            <h2 className="text-lg font-semibold">Annotation evidence studio</h2>
            <p className="mt-1 text-[12px] text-[var(--muted-text)]">
              Inspect first-party and third-party policies with higher-contrast annotations, document coverage, and pinned evidence.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {loading && <StatusPill variant="running" label="loading policy" pulse />}
            {selectionAnnotated && !loading && <StatusPill variant="ok" label="annotations available" />}
            {!selectionAnnotated && canLoad && !loading && <StatusPill variant="idle" label="raw text only" />}
          </div>
        </div>

        <div className="mt-4 grid gap-3 xl:grid-cols-[auto_minmax(220px,1fr)_minmax(220px,1fr)]">
          <div className="flex overflow-hidden rounded-2xl border border-[var(--border-soft)] bg-black/15">
            {([
              { id: 'first', label: 'First-party site' },
              { id: 'third', label: 'Third-party service' },
            ] as const).map((option) => (
              <button
                key={option.id}
                type="button"
                className={`focusable px-4 py-2.5 text-[12px] font-medium transition-colors ${
                  policyType === option.id
                    ? 'bg-[rgba(59,217,255,0.14)] text-[var(--color-primary)]'
                    : 'text-[var(--muted-text)] hover:bg-white/5 hover:text-[var(--color-text)]'
                }`}
                onClick={() => setPolicyType(option.id)}
                aria-pressed={policyType === option.id}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Site</label>
            <select
              value={selectedSite}
              onChange={(event) => setSelectedSite(event.target.value)}
              className="focusable rounded-xl border border-[var(--border-soft)] bg-black/20 px-3 py-2.5 text-sm text-[var(--color-text)]"
            >
              <option value="">Select a site</option>
              {availableSites.map((site) => (
                <option key={site.site} value={site.site}>
                  {site.site}{annotatedSites.has(site.site) ? ' • annotated' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">
              {policyType === 'third' ? 'Third-party service' : 'Annotation state'}
            </label>
            {policyType === 'third' ? (
              <select
                value={selectedTp}
                onChange={(event) => setSelectedTp(event.target.value)}
                className="focusable rounded-xl border border-[var(--border-soft)] bg-black/20 px-3 py-2.5 text-sm text-[var(--color-text)]"
                disabled={!selectedSite}
              >
                <option value="">{selectedSite ? 'Select a third-party' : 'Select a site first'}</option>
                {availableTps.map((tp) => (
                  <option key={tp.name} value={tp.name}>
                    {tp.name}
                    {annotatedTps.has(`${selectedSite}/${tp.name}`) ? ' • annotated' : ''}
                    {tp.entity ? ` • ${tp.entity}` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <div className="rounded-xl border border-[var(--border-soft)] bg-black/10 px-3 py-2.5 text-sm text-[var(--color-text)]">
                {selectedSite ? (selectionAnnotated ? 'Annotated statements available' : 'Policy text available without annotations') : 'Select a site'}
              </div>
            )}
          </div>
        </div>

        {!sites?.length && (
          <div className="mt-4 rounded-xl border border-[rgba(255,92,138,0.28)] bg-[rgba(255,92,138,0.06)] px-3 py-2 text-[12px] text-[var(--color-danger)]">
            No site data loaded. Run a scrape or load an output directory from Database.
          </div>
        )}
      </BentoCard>

      {!hasContent && !loadError && (
        <BentoCard className="p-10 text-center">
          <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Awaiting selection</p>
          <h3 className="mt-2 text-lg font-semibold">Open a policy to inspect its evidence trail</h3>
          <p className="mt-2 text-sm text-[var(--muted-text)]">
            Choose a {policyType === 'first' ? 'site' : 'site and third-party service'} above to load the policy text, statement overlays, and block-level annotation coverage.
          </p>
        </BentoCard>
      )}

      {loadError && (
        <BentoCard className="p-4">
          <div className="rounded-xl border border-[rgba(255,92,138,0.28)] bg-[rgba(255,92,138,0.06)] px-3 py-3 text-[12px] text-[var(--color-danger)]">
            {loadError}
          </div>
        </BentoCard>
      )}

      {hasContent && !loadError && (
        <>
          <BentoGrid className="grid-cols-2 xl:grid-cols-4">
            {overviewMetrics.map((metric) => (
              <MetricTile key={metric.label} label={metric.label} value={metric.value} detail={metric.detail} />
            ))}
          </BentoGrid>

          <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
            <div className="flex flex-col gap-5">
              <BentoCard className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">
                      {policyType === 'third' ? 'Third-party record' : 'Site record'}
                    </p>
                    <h3 className="mt-1 text-sm font-semibold text-[var(--color-text)]">{displayName}</h3>
                  </div>
                  <StatusPill variant={policyUrl ? 'ok' : 'idle'} label={policyUrl ? 'policy linked' : 'policy url missing'} />
                </div>

                <div className="mt-4 space-y-3">
                  <div className="rounded-2xl border border-[var(--border-soft)] bg-black/10 p-4">
                    <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Policy URL</p>
                    {policyUrl ? (
                      <a
                        href={policyUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 block break-all text-[12px] leading-relaxed text-[var(--color-primary)] underline-offset-4 hover:underline"
                      >
                        {policyUrl}
                      </a>
                    ) : (
                      <p className="mt-2 text-[12px] text-[var(--muted-text)]">No linked policy URL for this selection.</p>
                    )}
                  </div>

                  {policyType === 'third' && selectedTpData && (
                    <div className="grid gap-3">
                      <div className="rounded-2xl border border-[var(--border-soft)] bg-black/10 p-4">
                        <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Entity</p>
                        <p className="mt-2 text-[12px] text-[var(--color-text)]">{selectedTpData.entity || 'Unknown entity'}</p>
                      </div>
                      <div className="rounded-2xl border border-[var(--border-soft)] bg-black/10 p-4">
                        <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Categories</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {(selectedTpData.categories ?? []).length > 0 ? (
                            (selectedTpData.categories ?? []).map((category) => (
                              <span
                                key={category}
                                className="rounded-full border border-[var(--glass-border)] bg-[rgba(59,217,255,0.08)] px-2.5 py-1 text-[10px] text-[var(--color-text)]"
                              >
                                {category}
                              </span>
                            ))
                          ) : (
                            <span className="text-[12px] text-[var(--muted-text)]">No categories mapped.</span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </BentoCard>

              <BentoCard className="p-5">
                <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Phrase signal</p>
                <h3 className="mt-1 text-sm font-semibold">Most frequent extracted language</h3>
                <div className="mt-4 grid gap-3">
                  <PhraseColumn title="Top actions" field="action" rows={topActions} />
                  <PhraseColumn title="Top data" field="data" rows={topData} />
                  <PhraseColumn title="Top purposes" field="purpose" rows={topPurposes} />
                </div>
              </BentoCard>

              {activeStatement ? (
                <ActiveStatementPanel
                  stmts={activeStatements}
                  activeIdx={activeInGroup}
                  onPrev={() => setActiveInGroup((idx) => Math.max(0, idx - 1))}
                  onNext={() => setActiveInGroup((idx) => Math.min(activeStatements.length - 1, idx + 1))}
                  onClose={() => {
                    setActiveStmtIdxs([])
                    setActiveInGroup(0)
                  }}
                />
              ) : (
                statements.length > 0 && (
                  <BentoCard className="p-5 text-center">
                    <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Interaction</p>
                    <p className="mt-2 text-sm text-[var(--muted-text)]">
                      Hover any annotated block to inspect it, then click to pin the related statement evidence here.
                    </p>
                  </BentoCard>
                )
              )}
            </div>

            <BentoCard className="p-5" glow>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Policy document</p>
                  <h3 className="mt-1 text-sm font-semibold">{displayName}</h3>
                  <p className="mt-1 text-[12px] text-[var(--muted-text)]">
                    {blockInfos
                      ? `${docJson?.blocks.length ?? 0} blocks mapped across ${docJson?.chunks.length ?? 0} chunks.`
                      : statements.length > 0
                        ? `${statements.length} statements loaded without document structure overlay.`
                        : 'No statement overlay data is available for this policy.'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {FIELDS.map((field) => (
                    <span
                      key={field}
                      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] text-[var(--color-text)]"
                      style={{
                        background: FIELD_META[field].panel,
                        borderColor: alpha(FIELD_META[field].color, 0.28),
                      }}
                    >
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: FIELD_META[field].color }} />
                      {FIELD_META[field].label}
                    </span>
                  ))}
                </div>
              </div>

              {blockInfos ? (
                <div className="mt-4 max-h-[74vh] space-y-1 overflow-y-auto rounded-2xl border border-[var(--border-soft)] bg-black/15 p-4">
                  {blockInfos.map((block) => {
                    const isAnnotated = block.stmtIdxs.length > 0
                    const isHovered = hoveredBlock === block.blockIdx
                    const isActive = activeStmtIdxs.length > 0 && block.stmtIdxs.some((idx) => activeStmtIdxs.includes(idx))
                    const isChunkStart = chunkStartBlocks.has(block.blockIdx)
                    const deduped = block.highlights.filter(
                      (entry, idx, arr) => idx === arr.findIndex((candidate) => candidate.phrase === entry.phrase && candidate.field === entry.field),
                    )
                    const segments = isAnnotated
                      ? highlightText(block.text, deduped.map(({ field, phrase }) => ({ field, phrase })))
                      : [{ text: block.text, field: null as FieldName | null }]

                    return (
                      <div key={block.blockIdx}>
                        {isChunkStart && block.blockIdx > 0 && (
                          <div className="my-3 flex items-center gap-3">
                            <div className="h-px flex-1 bg-[var(--border-soft)]" />
                            <span className="rounded-full border border-[var(--border-soft)] px-2 py-0.5 text-[10px] text-[var(--muted-text)]">
                              chunk {block.chunkIdx}
                            </span>
                            <div className="h-px flex-1 bg-[var(--border-soft)]" />
                          </div>
                        )}

                        <div
                          role={isAnnotated ? 'button' : undefined}
                          tabIndex={isAnnotated ? 0 : undefined}
                          className={`rounded-2xl border px-3 py-3 text-[13px] leading-relaxed transition-all ${
                            isAnnotated ? 'cursor-pointer select-text' : ''
                          }`}
                          style={{
                            background: isActive
                              ? 'rgba(59,217,255,0.10)'
                              : isHovered
                                ? 'rgba(255,255,255,0.04)'
                                : isAnnotated
                                  ? 'rgba(255,255,255,0.02)'
                                  : 'transparent',
                            borderColor: isActive
                              ? 'rgba(59,217,255,0.32)'
                              : isAnnotated
                                ? 'rgba(255,255,255,0.06)'
                                : 'transparent',
                            boxShadow: isActive ? 'var(--glow-xs)' : undefined,
                          }}
                          onMouseEnter={() => {
                            if (isAnnotated) setHoveredBlock(block.blockIdx)
                          }}
                          onMouseLeave={() => setHoveredBlock(null)}
                          onClick={() => {
                            if (!isAnnotated) return
                            setActiveStmtIdxs(block.stmtIdxs)
                            setActiveInGroup(0)
                          }}
                          onKeyDown={(event) => {
                            if (!isAnnotated) return
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              setActiveStmtIdxs(block.stmtIdxs)
                              setActiveInGroup(0)
                            }
                          }}
                        >
                          {isAnnotated && (
                            <div className="mb-2 flex flex-wrap items-center gap-2">
                              <span className="rounded-full border border-[var(--border-soft)] px-2 py-0.5 text-[10px] text-[var(--muted-text)]">
                                block {block.blockIdx}
                              </span>
                              <span className="rounded-full border border-[var(--border-soft)] px-2 py-0.5 text-[10px] text-[var(--muted-text)]">
                                {block.stmtIdxs.length} statement{block.stmtIdxs.length === 1 ? '' : 's'}
                              </span>
                            </div>
                          )}
                          <p className="text-[var(--color-text)]">
                            {segments.map((segment, index) =>
                              segment.field ? (
                                <mark
                                  key={`${segment.field}-${index}`}
                                  style={{
                                    background: alpha(FIELD_META[segment.field].color, isActive || isHovered ? 0.24 : 0.14),
                                    boxShadow: `inset 0 -1px 0 ${FIELD_META[segment.field].color}`,
                                    color: 'inherit',
                                    borderRadius: 4,
                                    padding: '0 2px',
                                  }}
                                >
                                  {segment.text}
                                </mark>
                              ) : (
                                <span key={`plain-${index}`}>{segment.text}</span>
                              ),
                            )}
                          </p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : policyText ? (
                <div className="mt-4 max-h-[74vh] overflow-y-auto rounded-2xl border border-[var(--border-soft)] bg-black/15 p-4">
                  {statements.length > 0 && (
                    <div className="mb-4 rounded-xl border border-[rgba(59,217,255,0.28)] bg-[rgba(59,217,255,0.07)] px-3 py-3 text-[12px] text-[var(--color-text)]">
                      Document structure is unavailable for this selection. Raw policy text is shown below, and extracted statement metrics remain available in the side panels.
                    </div>
                  )}
                  <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-[var(--color-text)]">
                    {policyText}
                  </pre>
                </div>
              ) : (
                <div className="mt-4 flex h-48 items-center justify-center rounded-2xl border border-[var(--border-soft)] bg-black/10">
                  <span className="text-[12px] text-[var(--muted-text)]">Loading policy text…</span>
                </div>
              )}
            </BentoCard>
          </div>
        </>
      )}
    </div>
  )
}
