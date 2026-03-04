import { Theme } from '../../types'

type SettingsViewProps = {
  theme: Theme
  onThemeChange: (theme: Theme) => void
  showExtractionMethod: boolean
  onToggleShowExtractionMethod: (value: boolean) => void
  // Pipeline settings
  useCrux?: boolean
  onToggleCrux?: (v: boolean) => void
  cruxApiKey?: string
  onCruxKeyChange?: (v: string) => void
  excludeSameEntity?: boolean
  onToggleExcludeSameEntity?: (v: boolean) => void
  mappingMode?: 'radar' | 'trackerdb' | 'mixed'
  onMappingModeChange?: (mode: 'radar' | 'trackerdb' | 'mixed') => void
  autoAnnotate?: boolean
  onToggleAutoAnnotate?: (v: boolean) => void
  openaiApiKey?: string
  onOpenaiApiKeyChange?: (v: string) => void
  totalCost?: number
  onResetCost?: () => void
}

function ToggleRow({
  label,
  description,
  value,
  onToggle,
}: {
  label: string
  description?: string
  value: boolean
  onToggle: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-3">
      <div>
        <span className="text-xs text-[var(--color-text)]">{label}</span>
        {description && <p className="mt-0.5 text-[10px] text-[var(--muted-text)]">{description}</p>}
      </div>
      <button
        className={`focusable rounded-full border px-3 py-1 text-xs ${
          value
            ? 'border-[var(--color-danger)] text-white'
            : 'border-[var(--border-soft)] text-[var(--muted-text)]'
        }`}
        onClick={() => onToggle(!value)}
      >
        {value ? 'On' : 'Off'}
      </button>
    </div>
  )
}

export function SettingsView({
  theme,
  onThemeChange,
  showExtractionMethod,
  onToggleShowExtractionMethod,
  useCrux = false,
  onToggleCrux,
  cruxApiKey = '',
  onCruxKeyChange,
  excludeSameEntity = false,
  onToggleExcludeSameEntity,
  mappingMode = 'mixed',
  onMappingModeChange,
  autoAnnotate = true,
  onToggleAutoAnnotate,
  openaiApiKey = '',
  onOpenaiApiKeyChange,
  totalCost = 0,
  onResetCost,
}: SettingsViewProps) {
  return (
    <>
      <section className="card rounded-2xl p-6">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Theme</p>
          <h2 className="text-lg font-semibold">Appearance</h2>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          {(['dark', 'vscode-red', 'academia'] as Theme[]).map((t) => (
            <button
              key={t}
              className={`focusable rounded-full border px-4 py-2 text-xs ${
                theme === t
                  ? 'border-[var(--color-danger)] text-white'
                  : 'border-[var(--border-soft)] text-[var(--muted-text)]'
              }`}
              onClick={() => onThemeChange(t)}
            >
              {t === 'dark' ? 'Dark' : t === 'vscode-red' ? 'Red' : 'Academia'}
            </button>
          ))}
        </div>
      </section>

      <section className="card rounded-2xl p-6">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Preferences</p>
          <h3 className="text-lg font-semibold">Defaults</h3>
        </div>
        <div className="mt-4 space-y-2 text-sm">
          <ToggleRow
            label="Show extraction method labels"
            value={showExtractionMethod}
            onToggle={onToggleShowExtractionMethod}
          />
        </div>
      </section>

      <section className="card rounded-2xl p-6">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Pipeline</p>
          <h3 className="text-lg font-semibold">Crawl settings</h3>
          <p className="mt-1 text-xs text-[var(--muted-text)]">
            These settings apply to every scrape run. They can also be adjusted from the Flow chart modal in the Launcher.
          </p>
        </div>
        <div className="mt-4 space-y-3">

          {/* Mapping mode */}
          <div className="rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs text-[var(--color-text)]">3P tracker mapping</span>
                <p className="mt-0.5 text-[10px] text-[var(--muted-text)]">
                  Which dataset(s) to use for mapping third-party domains to entities.
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                {([
                  { id: 'radar', label: 'Tracker Radar' },
                  { id: 'trackerdb', label: 'TrackerDB' },
                  { id: 'mixed', label: 'Mixed' },
                ] as const).map((opt) => (
                  <button
                    key={opt.id}
                    className={`focusable rounded-full border px-3 py-1 text-xs ${
                      mappingMode === opt.id
                        ? 'border-[var(--color-danger)] text-white'
                        : 'border-[var(--border-soft)] text-[var(--muted-text)]'
                    }`}
                    onClick={() => onMappingModeChange?.(opt.id)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <ToggleRow
            label="Exclude same-entity third parties"
            description="Skip third-party domains owned by the same legal entity as the first-party site."
            value={excludeSameEntity}
            onToggle={(v) => onToggleExcludeSameEntity?.(v)}
          />

          <ToggleRow
            label="CrUX filter"
            description="Only scrape sites present in the Chrome UX Report dataset (requires API key below)."
            value={useCrux}
            onToggle={(v) => onToggleCrux?.(v)}
          />

          {useCrux && (
            <div className="rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-3">
              <p className="mb-2 text-xs text-[var(--muted-text)]">CrUX API key</p>
              <input
                type="password"
                className="focusable w-full rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-2 text-sm text-white"
                placeholder="Chrome UX Report API key"
                value={cruxApiKey}
                onChange={(e) => onCruxKeyChange?.(e.target.value)}
              />
            </div>
          )}
        </div>
      </section>

      <section className="card rounded-2xl p-6">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Automation</p>
          <h3 className="text-lg font-semibold">Post-scrape actions</h3>
        </div>
        <div className="mt-4 space-y-3">
          <div className="rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-3">
            <p className="mb-2 text-xs text-[var(--color-text)]">OpenAI API key</p>
            <p className="mb-2 text-[10px] text-[var(--muted-text)]">
              Used for Stage 2 LLM annotation. Stored in memory only — not persisted to disk.
            </p>
            <input
              type="password"
              className="focusable w-full rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-2 text-sm text-white"
              placeholder="sk-proj-…"
              value={openaiApiKey}
              onChange={(e) => onOpenaiApiKeyChange?.(e.target.value)}
            />
          </div>
          <ToggleRow
            label="Auto-annotate after scraping"
            description="Automatically start Stage 2 LLM annotation as soon as a scrape run completes."
            value={autoAnnotate}
            onToggle={(v) => onToggleAutoAnnotate?.(v)}
          />
        </div>
      </section>

      <section className="card rounded-2xl p-6">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Billing</p>
          <h3 className="text-lg font-semibold">API Cost</h3>
          <p className="mt-1 text-xs text-[var(--muted-text)]">
            Accumulated OpenAI API cost across all annotation runs. Stored locally, not reset between sessions.
          </p>
        </div>
        <div className="mt-4 flex items-center justify-between rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-3">
          <div>
            <span className="text-2xl font-semibold tabular-nums text-[var(--color-text)]">
              ${totalCost.toFixed(4)}
            </span>
            <p className="mt-0.5 text-[10px] text-[var(--muted-text)]">total spent since last reset</p>
          </div>
          <button
            className="focusable rounded-full border border-[var(--border-soft)] px-4 py-2 text-xs text-[var(--muted-text)] hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
            onClick={() => onResetCost?.()}
          >
            Reset
          </button>
        </div>
      </section>
    </>
  )
}
