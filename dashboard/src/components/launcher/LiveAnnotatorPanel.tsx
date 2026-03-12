import { useEffect, useReducer, useRef } from 'react'
import type { AnnotatorStreamEvent } from '../../vite-env'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase = 'reasoning' | 'extraction' | 'exhaustion' | 'idle'

type ChunkRecord = {
  chunkIdx: number
  round: number
  reasoning: string
  extraction: string
  phase: Phase
  statementCount: number
  finishedAt?: number
}

type LiveState = {
  site: string
  chunkTotal: number
  chunkIdx: number
  round: number
  phase: Phase
  reasoning: string   // accumulator for current <think> block
  extraction: string  // accumulator for current extraction JSON
  entities: EntitySet
  history: ChunkRecord[]
  lastEventAt: number
}

type EntitySet = {
  action: Set<string>
  data: Set<string>
  processor: Set<string>
  purpose: Set<string>
  prohibitions: number
}

type Action =
  | { type: 'STREAM'; event: AnnotatorStreamEvent }
  | { type: 'CLEAR' }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyEntities(): EntitySet {
  return { action: new Set(), data: new Set(), processor: new Set(), purpose: new Set(), prohibitions: 0 }
}

function mergeEntities(base: EntitySet, patch: EntitySet): EntitySet {
  return {
    action: new Set([...base.action, ...patch.action]),
    data: new Set([...base.data, ...patch.data]),
    processor: new Set([...base.processor, ...patch.processor]),
    purpose: new Set([...base.purpose, ...patch.purpose]),
    prohibitions: base.prohibitions + patch.prohibitions,
  }
}

function parseEntitiesFromJson(text: string): EntitySet {
  const e = emptyEntities()
  try {
    // Find the outermost JSON array
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start === -1 || end === -1 || end <= start) return e
    const slice = text.slice(start, end + 1)
    const parsed = JSON.parse(slice)
    if (!Array.isArray(parsed)) return e
    for (const st of parsed) {
      if (!st || typeof st !== 'object') continue
      for (const v of (st.action ?? [])) e.action.add(String(v).toLowerCase())
      for (const v of (st.data ?? [])) e.data.add(String(v).toLowerCase())
      for (const v of (st.processor ?? [])) e.processor.add(String(v).toLowerCase())
      for (const v of (st.purpose ?? [])) e.purpose.add(String(v).toLowerCase())
      if (st.prohibition === true) e.prohibitions++
    }
  } catch { /* partial JSON — ignore */ }
  return e
}

function countStatements(text: string): number {
  try {
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start === -1 || end === -1) return 0
    const parsed = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed.length : 0
  } catch { return 0 }
}

function initialState(): LiveState {
  return {
    site: '',
    chunkTotal: 0,
    chunkIdx: 0,
    round: 0,
    phase: 'idle',
    reasoning: '',
    extraction: '',
    entities: emptyEntities(),
    history: [],
    lastEventAt: 0,
  }
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function reducer(state: LiveState, action: Action): LiveState {
  if (action.type === 'CLEAR') return initialState()

  const { event } = action
  const isSameSite = state.site === event.site
  const isSameChunk = isSameSite && state.chunkIdx === event.chunk_idx
  const isSameRound = isSameChunk && state.round === event.round

  // When a new chunk/round starts, archive the previous one
  let history = state.history
  if (isSameSite && !isSameChunk && state.extraction) {
    const prev: ChunkRecord = {
      chunkIdx: state.chunkIdx,
      round: state.round,
      reasoning: state.reasoning,
      extraction: state.extraction,
      phase: state.phase,
      statementCount: countStatements(state.extraction),
      finishedAt: Date.now(),
    }
    history = [prev, ...state.history].slice(0, 12)
  } else if (isSameChunk && !isSameRound && state.extraction) {
    const prev: ChunkRecord = {
      chunkIdx: state.chunkIdx,
      round: state.round,
      reasoning: state.reasoning,
      extraction: state.extraction,
      phase: state.phase,
      statementCount: countStatements(state.extraction),
      finishedAt: Date.now(),
    }
    history = [prev, ...state.history].slice(0, 12)
  }

  const baseReasoning = (isSameSite && isSameChunk && isSameRound) ? state.reasoning : ''
  const baseExtraction = (isSameSite && isSameChunk && isSameRound) ? state.extraction : ''

  const newReasoning = event.phase === 'reasoning'
    ? baseReasoning + event.delta
    : (isSameSite && isSameChunk && isSameRound ? state.reasoning : '')

  const newExtraction = (event.phase === 'extraction' || event.phase === 'exhaustion')
    ? baseExtraction + event.delta
    : (isSameSite && isSameChunk && isSameRound ? state.extraction : '')

  const patchEntities = event.phase === 'extraction'
    ? parseEntitiesFromJson(newExtraction)
    : emptyEntities()
  const entities = isSameSite ? mergeEntities(
    isSameChunk && isSameRound ? state.entities : emptyEntities(),
    patchEntities,
  ) : patchEntities

  return {
    site: event.site,
    chunkTotal: event.chunk_total,
    chunkIdx: event.chunk_idx,
    round: event.round,
    phase: event.phase,
    reasoning: newReasoning,
    extraction: newExtraction,
    entities,
    history,
    lastEventAt: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const PHASE_LABELS: Record<Phase, string> = {
  reasoning: 'Thinking',
  extraction: 'Extracting',
  exhaustion: 'Checking',
  idle: 'Idle',
}

const PHASE_COLORS: Record<Phase, string> = {
  reasoning: 'text-[var(--color-primary)] border-[rgba(59,217,255,0.35)] bg-[rgba(59,217,255,0.08)]',
  extraction: 'text-[var(--color-success)] border-[rgba(56,217,138,0.35)] bg-[rgba(56,217,138,0.08)]',
  exhaustion: 'text-[var(--color-text)] border-white/15 bg-white/5',
  idle: 'text-[var(--muted-text)] border-[var(--border-soft)] bg-transparent',
}

type EntityChipsProps = { label: string; color: string; items: string[] }

function EntityChips({ label, color, items }: EntityChipsProps) {
  if (!items.length) return null
  return (
    <div className="flex flex-wrap items-start gap-1">
      <span className={`mt-0.5 shrink-0 text-[9px] uppercase tracking-widest ${color} opacity-60`}>{label}</span>
      {items.slice(0, 8).map((item) => (
        <span
          key={item}
          className={`rounded-md border px-1.5 py-0.5 text-[10px] leading-tight ${color}`}
          title={item}
        >
          {item.length > 28 ? item.slice(0, 26) + '…' : item}
        </span>
      ))}
      {items.length > 8 && (
        <span className={`rounded-md px-1 py-0.5 text-[10px] opacity-50 ${color}`}>+{items.length - 8}</span>
      )}
    </div>
  )
}

function StreamingCursor() {
  return (
    <span
      className="ml-0.5 inline-block h-3 w-1.5 rounded-sm bg-current align-text-bottom opacity-80"
      style={{ animation: 'blink 1s step-end infinite' }}
    />
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export type LiveAnnotatorPanelProps = {
  streamEvent: AnnotatorStreamEvent | null
  annotateRunning: boolean
}

export function LiveAnnotatorPanel({ streamEvent, annotateRunning }: LiveAnnotatorPanelProps) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState)
  const reasoningRef = useRef<HTMLPreElement>(null)
  const extractionRef = useRef<HTMLPreElement>(null)
  const [showReasoning, setShowReasoning] = useReducerToggle(true)

  // Feed stream events into the reducer
  useEffect(() => {
    if (!streamEvent) return
    dispatch({ type: 'STREAM', event: streamEvent })
  }, [streamEvent])

  // Clear state when a new run starts
  useEffect(() => {
    if (annotateRunning) dispatch({ type: 'CLEAR' })
  }, [annotateRunning])

  // Auto-scroll streaming panes
  useEffect(() => {
    if (reasoningRef.current && state.phase === 'reasoning') {
      reasoningRef.current.scrollTop = reasoningRef.current.scrollHeight
    }
  }, [state.reasoning, state.phase])
  useEffect(() => {
    if (extractionRef.current && (state.phase === 'extraction' || state.phase === 'exhaustion')) {
      extractionRef.current.scrollTop = extractionRef.current.scrollHeight
    }
  }, [state.extraction, state.phase])

  const isLive = state.site !== '' && Date.now() - state.lastEventAt < 8000
  const entities = state.entities
  const chunkProgress = state.chunkTotal > 0
    ? Math.round((state.chunkIdx / state.chunkTotal) * 100)
    : 0

  if (!annotateRunning && state.site === '') return null

  return (
    <div className="mt-5 overflow-hidden rounded-2xl border border-[var(--border-soft)] bg-gradient-to-b from-black/40 to-black/20">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border-soft)] px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          {isLive ? (
            <span className="flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-cyan-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-400" />
            </span>
          ) : (
            <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--muted-text)] opacity-40" />
          )}
          <span className="truncate font-mono text-xs text-[var(--color-text)]">
            {state.site || '—'}
          </span>
          {state.site && (
            <span className="shrink-0 text-[10px] text-[var(--muted-text)]">
              chunk {state.chunkIdx + 1}{state.chunkTotal > 0 ? `/${state.chunkTotal}` : ''} · round {state.round + 1}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full border px-2.5 py-0.5 text-[10px] ${PHASE_COLORS[state.phase]}`}>
            {PHASE_LABELS[state.phase]}
            {isLive && state.phase !== 'idle' && <StreamingCursor />}
          </span>
        </div>
      </div>

      {/* Chunk progress bar */}
      {state.chunkTotal > 1 && (
        <div className="h-0.5 w-full bg-black/30">
          <div
            className="h-full bg-cyan-500/50 transition-all duration-300"
            style={{ width: `${chunkProgress}%` }}
          />
        </div>
      )}

      {/* Chunk dots */}
      {state.chunkTotal > 1 && state.chunkTotal <= 24 && (
        <div className="flex flex-wrap gap-1 px-4 pt-3">
          {Array.from({ length: state.chunkTotal }, (_, i) => (
            <span
              key={i}
              className={`h-1.5 w-1.5 rounded-full transition-colors ${
                i < state.chunkIdx
                  ? 'bg-cyan-500'
                  : i === state.chunkIdx
                    ? 'bg-cyan-300 shadow-[0_0_4px_#67e8f9]'
                    : 'bg-white/10'
              }`}
            />
          ))}
        </div>
      )}

      <div className="p-4 space-y-3">
        {/* Reasoning panel */}
        {(state.reasoning || state.phase === 'reasoning') && (
          <div className="rounded-xl border border-[rgba(59,217,255,0.22)] bg-[rgba(59,217,255,0.08)]">
            <button
              className="flex w-full items-center justify-between px-3 py-2 text-left"
              onClick={() => setShowReasoning((v) => !v)}
            >
              <span className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-[color:rgba(59,217,255,0.88)]">
                <span>Chain-of-thought</span>
                {state.phase === 'reasoning' && isLive && (
                  <span className="text-[var(--color-primary)]"><StreamingCursor /></span>
                )}
              </span>
              <span className="text-[10px] text-[color:rgba(59,217,255,0.52)]">{showReasoning ? '▲' : '▼'}</span>
            </button>
            {showReasoning && (
              <pre
                ref={reasoningRef}
                className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words px-3 pb-3 font-mono text-[11px] leading-relaxed text-[var(--color-text)]"
              >
                {stripThinkTags(state.reasoning)}
                {state.phase === 'reasoning' && isLive && <StreamingCursor />}
              </pre>
            )}
          </div>
        )}

        {/* Extraction panel */}
        {(state.extraction || state.phase === 'extraction' || state.phase === 'exhaustion') && (
          <div className={`rounded-xl border ${state.phase === 'exhaustion' ? 'border-white/15 bg-white/5' : 'border-[rgba(56,217,138,0.22)] bg-[rgba(56,217,138,0.08)]'}`}>
            <div className="flex items-center gap-2 px-3 py-2">
              <span className={`text-[10px] uppercase tracking-widest ${state.phase === 'exhaustion' ? 'text-[color:rgba(245,251,255,0.74)]' : 'text-[color:rgba(56,217,138,0.88)]'}`}>
                {state.phase === 'exhaustion' ? 'Completeness check' : 'Extraction output'}
              </span>
              {(state.phase === 'extraction' || state.phase === 'exhaustion') && isLive && (
                <span className={state.phase === 'exhaustion' ? 'text-[var(--color-text)]' : 'text-[var(--color-success)]'}>
                  <StreamingCursor />
                </span>
              )}
            </div>
            <pre
              ref={extractionRef}
              className={`max-h-48 overflow-y-auto whitespace-pre-wrap break-words px-3 pb-3 font-mono text-[11px] leading-relaxed ${
                state.phase === 'exhaustion' ? 'text-[var(--color-text)]' : 'text-[var(--color-text)]'
              }`}
            >
              <ColorizedJson text={state.extraction} />
            </pre>
          </div>
        )}

        {/* Entity chips */}
        {(entities.action.size > 0 || entities.data.size > 0 || entities.processor.size > 0 || entities.purpose.size > 0) && (
          <div className="rounded-xl border border-[var(--border-soft)] bg-black/20 px-3 py-3 space-y-2">
            <p className="text-[9px] uppercase tracking-widest text-[var(--muted-text)]">
              Extracted entities{entities.prohibitions > 0 && <span className="ml-2 text-red-400">· {entities.prohibitions} prohibition{entities.prohibitions > 1 ? 's' : ''}</span>}
            </p>
            <EntityChips label="Action" color="text-blue-400 border-blue-400/30 bg-blue-400/5" items={[...entities.action]} />
            <EntityChips label="Data" color="text-orange-400 border-orange-400/30 bg-orange-400/5" items={[...entities.data]} />
            <EntityChips label="Processor" color="text-green-400 border-green-400/30 bg-green-400/5" items={[...entities.processor]} />
            <EntityChips label="Purpose" color="text-purple-400 border-purple-400/30 bg-purple-400/5" items={[...entities.purpose]} />
          </div>
        )}

        {/* History accordion */}
        {state.history.length > 0 && (
          <HistoryAccordion records={state.history} />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// History accordion
// ---------------------------------------------------------------------------

function HistoryAccordion({ records }: { records: ChunkRecord[] }) {
  const [open, setOpen] = useReducerToggle(false)
  return (
    <div className="rounded-xl border border-[var(--border-soft)]">
      <button
        className="flex w-full items-center justify-between px-3 py-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-[10px] uppercase tracking-widest text-[var(--muted-text)]">
          Previous chunks ({records.length})
        </span>
        <span className="text-[10px] text-[var(--muted-text)]">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="space-y-1 px-2 pb-2">
          {records.map((rec, i) => (
            <div key={i} className="rounded-lg border border-[var(--border-soft)] bg-black/20 px-3 py-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[10px] text-[var(--muted-text)]">
                  chunk {rec.chunkIdx + 1} · round {rec.round + 1}
                </span>
                <span className="text-[10px] font-semibold text-cyan-400">{rec.statementCount} stmt</span>
              </div>
              {rec.extraction && (
                <pre className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] text-white/40">
                  {rec.extraction.slice(0, 400)}{rec.extraction.length > 400 ? '…' : ''}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Colorized JSON renderer
// ---------------------------------------------------------------------------

function ColorizedJson({ text }: { text: string }) {
  if (!text) return null
  // Simple token coloring — no full parser, good enough for small payloads
  const html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"([^"]+)":/g, '<span class="text-cyan-300">"$1"</span>:')
    .replace(/:\s*"([^"]*)"/g, ': <span class="text-orange-200">"$1"</span>')
    .replace(/\b(true|false|null)\b/g, '<span class="text-purple-300">$1</span>')
    .replace(/\b(\d+)\b/g, '<span class="text-blue-300">$1</span>')
  return <span dangerouslySetInnerHTML={{ __html: html }} />
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function stripThinkTags(text: string): string {
  return text.replace(/<\/?think>/g, '').trim()
}

// Tiny toggle helper using useReducer to avoid stale closure issues
function useReducerToggle(initial: boolean): [boolean, (fn: (v: boolean) => boolean) => void] {
  return useReducer((state: boolean, fn: (v: boolean) => boolean) => fn(state), initial)
}
