export type ReasoningSelection = {
  firstPartySite: string
  thirdPartyName: string
  firstPartyText: string
  thirdPartyText: string
  firstPartyExtractionMethod?: string | null
  thirdPartyExtractionMethod?: string | null
}

type ReasoningViewProps = {
  selection: ReasoningSelection | null
  onGoToConsistency: () => void
}

function formatExtractionMethod(value?: string | null) {
  if (!value) return 'Unknown'
  return value === 'trafilatura' ? 'Trafilatura' : 'Fallback'
}

export function ReasoningView({ selection, onGoToConsistency }: ReasoningViewProps) {
  if (!selection) {
    return (
      <section className="card rounded-2xl p-6">
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Reasoning</p>
        <h2 className="text-lg font-semibold">No selected policy pair</h2>
        <p className="mt-2 text-sm text-[var(--muted-text)]">
          Open the Consistency checker, select a first-party and third-party policy, then send them to Reasoning.
        </p>
        <button className="focusable mt-4 rounded-xl border border-[var(--border-soft)] px-4 py-2 text-sm" onClick={onGoToConsistency}>
          Go to Consistency checker
        </button>
      </section>
    )
  }

  return (
    <>
      <section className="card rounded-2xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Reasoning</p>
            <h2 className="text-lg font-semibold">Consistency reasoning </h2>
            <p className="text-xs text-[var(--muted-text)]">
              Current pair: <span className="text-[var(--color-text)]">{selection.firstPartySite}</span> vs{' '}
              <span className="text-[var(--color-text)]">{selection.thirdPartyName}</span>
            </p>
            <p className="mt-1 text-xs text-[var(--muted-text)]">
              Extraction methods: 1P {formatExtractionMethod(selection.firstPartyExtractionMethod)} • 3P{' '}
              {formatExtractionMethod(selection.thirdPartyExtractionMethod)}
            </p>
          </div>
          <button className="focusable rounded-xl border border-[var(--border-soft)] px-4 py-2 text-sm" onClick={onGoToConsistency}>
            Change selected policies
          </button>
        </div>
      </section>

      
    </>
  )
}
