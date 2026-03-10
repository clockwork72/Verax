import { useMemo, useState } from 'react'
import { Theme } from '../../types'
import { estimateAnnotationCost, formatUsd, pricingForModel, TextSizeUnit } from '../../utils/annotationCost'

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
  tunnelStatus?: 'checking' | 'online' | 'offline'
  llmModel?: string
  annotateRunUsage?: { tokensIn: number; tokensOut: number }
  annotationStats?: any
  totalCost?: number
  onResetCost?: () => void
}

function normalizeModelKey(value?: string): string {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return ''
  return raw.includes('/') ? raw.split('/').pop() || raw : raw
}

function isDatedModelVariant(key: string, family: string): boolean {
  if (!key.startsWith(`${family}-`)) return false
  const suffix = key.slice(family.length + 1)
  return /^\d/.test(suffix)
}

function isLowTpmModelKey(model?: string): boolean {
  const key = normalizeModelKey(model)
  return (
    key === 'gpt-4o' ||
    isDatedModelVariant(key, 'gpt-4o') ||
    key === 'gpt-4.1' ||
    isDatedModelVariant(key, 'gpt-4.1')
  )
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
  tunnelStatus = 'checking' as 'checking' | 'online' | 'offline',
  llmModel = 'openai/local',
  annotateRunUsage,
  annotationStats,
  totalCost = 0,
  onResetCost,
}: SettingsViewProps) {
  const [plannerSizeValue, setPlannerSizeValue] = useState('12000')
  const [plannerSizeUnit, setPlannerSizeUnit] = useState<TextSizeUnit>('words')
  const [plannerSites, setPlannerSites] = useState('1')

  const runTokensIn = annotateRunUsage?.tokensIn || 0
  const runTokensOut = annotateRunUsage?.tokensOut || 0
  const modelRates = pricingForModel(llmModel)
  const observedRunCost = (runTokensIn / 1e6) * modelRates.input + (runTokensOut / 1e6) * modelRates.output
  const exhaustionDisabledForModel = isLowTpmModelKey(llmModel)
  const plannerEstimate = useMemo(() => estimateAnnotationCost({
    model: llmModel,
    textSizeValue: Number(plannerSizeValue) || 0,
    textSizeUnit: plannerSizeUnit,
    tokenLimit: 500,
    disableExhaustionCheck: exhaustionDisabledForModel,
  }), [llmModel, plannerSizeValue, plannerSizeUnit, exhaustionDisabledForModel])
  const plannerSiteCount = Math.max(
    1,
    Number(plannerSites) || Number(annotationStats?.total_sites) || 1
  )
  const plannerLow = plannerEstimate.low.usd * plannerSiteCount
  const plannerMid = plannerEstimate.typical.usd * plannerSiteCount
  const plannerHigh = plannerEstimate.high.usd * plannerSiteCount

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
            <p className="mb-2 text-xs text-[var(--color-text)]">HPC Tunnel — DeepSeek-R1-70B</p>
            <p className="mb-3 text-[10px] text-[var(--muted-text)]">
              Stage 2 LLM annotation runs via SSH tunnel on port 8901. Start with:<br />
              <code className="font-mono">ssh -N -f -L 8901:&lt;gpu-node&gt;:8901 soufiane.essahli@toubkal.hpc.um6p.ma</code>
            </p>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
              tunnelStatus === 'online'
                ? 'border-[var(--color-success)] text-[var(--color-success)]'
                : tunnelStatus === 'offline'
                  ? 'border-[var(--color-danger)] text-[var(--color-danger)]'
                  : 'border-[var(--border-soft)] text-[var(--muted-text)]'
            }`}>
              {tunnelStatus === 'online' ? '● Tunnel active' : tunnelStatus === 'offline' ? '○ Tunnel offline' : '◌ Checking tunnel…'}
            </span>
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
          <h3 className="text-lg font-semibold">OpenAI Cost & Planning</h3>
          <p className="mt-1 text-xs text-[var(--muted-text)]">
            Track observed annotation usage and estimate full Stage-2 extraction cost by model and policy size.
          </p>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-[1.4fr_1fr]">
          <div className="rounded-2xl border border-[var(--border-soft)] bg-gradient-to-br from-black/30 to-black/10 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--muted-text)]">LLM Cost Tracking</p>
                <h4 className="text-base font-semibold">Observed usage</h4>
              </div>
              <span
                className="inline-flex items-center rounded-full border border-[var(--border-soft)] px-3 py-1 text-xs text-[var(--muted-text)]"
                title="DeepSeek-R1-Distill-Llama-70B · HPC GPU node · port 8901"
              >
                DeepSeek-R1-70B (local)
              </span>
            </div>
            <p className="mt-1 text-[10px] text-[var(--muted-text)]">
              Pricing: input ${modelRates.input.toFixed(2)} / output ${modelRates.output.toFixed(2)} per 1M tokens.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-[var(--border-soft)] bg-black/20 p-3">
                <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Run input</p>
                <p className="mt-1 font-mono text-lg text-[var(--color-text)]">{runTokensIn.toLocaleString()}</p>
                <p className="text-[10px] text-[var(--muted-text)]">prompt tokens</p>
              </div>
              <div className="rounded-xl border border-[var(--border-soft)] bg-black/20 p-3">
                <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Run output</p>
                <p className="mt-1 font-mono text-lg text-[var(--color-text)]">{runTokensOut.toLocaleString()}</p>
                <p className="text-[10px] text-[var(--muted-text)]">completion tokens</p>
              </div>
              <div className="rounded-xl border border-[var(--border-soft)] bg-black/20 p-3">
                <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Run cost</p>
                <p className="mt-1 text-lg font-semibold text-[var(--color-primary)]">{formatUsd(observedRunCost, 4)}</p>
                <p className="text-[10px] text-[var(--muted-text)]">derived from observed tokens</p>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between rounded-xl border border-[var(--border-soft)] bg-black/20 px-3 py-2">
              <div>
                <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Lifetime total</p>
                <p className="text-sm font-semibold text-[var(--color-text)]">{formatUsd(totalCost, 4)}</p>
              </div>
              <button
                className="focusable rounded-full border border-[var(--border-soft)] px-4 py-2 text-xs text-[var(--muted-text)] hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
                onClick={() => onResetCost?.()}
              >
                Reset
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-[var(--chip-ring)] bg-gradient-to-br from-[var(--chip-bg)] to-transparent p-4">
            <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--muted-text)]">Cost Planner</p>
            <h4 className="text-base font-semibold">Expected extraction price</h4>
            <p className="mt-1 text-[11px] text-[var(--muted-text)]">
              Estimate Stage-2 statement extraction + annotation cost from policy text size.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <input
                type="number"
                min={1}
                className="focusable rounded-xl border border-[var(--border-soft)] bg-black/20 px-3 py-2 text-sm text-white"
                value={plannerSizeValue}
                onChange={(e) => setPlannerSizeValue(e.target.value)}
                placeholder="Text size"
              />
              <select
                className="focusable rounded-xl border border-[var(--border-soft)] bg-black/20 px-3 py-2 text-sm text-white"
                value={plannerSizeUnit}
                onChange={(e) => setPlannerSizeUnit(e.target.value as TextSizeUnit)}
              >
                <option value="words">words</option>
                <option value="chars">chars</option>
                <option value="tokens">tokens</option>
                <option value="kb">KB</option>
              </select>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs text-[var(--muted-text)]">Sites</span>
              <input
                type="number"
                min={1}
                className="focusable w-24 rounded-xl border border-[var(--border-soft)] bg-black/20 px-3 py-2 text-sm text-white"
                value={plannerSites}
                onChange={(e) => setPlannerSites(e.target.value)}
              />
              {annotationStats?.total_sites > 0 && (
                <span className="text-[10px] text-[var(--muted-text)]">
                  Detected: {annotationStats.total_sites}
                </span>
              )}
            </div>
            <div className="mt-3 grid gap-2 text-xs">
              <div className="flex items-center justify-between rounded-lg border border-[var(--border-soft)] bg-black/20 px-3 py-2">
                <span className="text-[var(--muted-text)]">Per policy (typical)</span>
                <span className="font-semibold text-[var(--color-text)]">{formatUsd(plannerEstimate.typical.usd, 4)}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-[var(--border-soft)] bg-black/20 px-3 py-2">
                <span className="text-[var(--muted-text)]">{plannerSiteCount} policies (range)</span>
                <span className="font-semibold text-[var(--color-text)]">
                  {formatUsd(plannerLow, 2)} - {formatUsd(plannerHigh, 2)}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-[var(--border-soft)] bg-black/20 px-3 py-2">
                <span className="text-[var(--muted-text)]">Best estimate ({plannerSiteCount} sites)</span>
                <span className="font-semibold text-[var(--color-primary)]">{formatUsd(plannerMid, 2)}</span>
              </div>
            </div>
            <p className="mt-3 text-[10px] text-[var(--muted-text)]">
              Inputs: ~{plannerEstimate.inputTokens.toLocaleString()} tokens, ~{plannerEstimate.chunkCount} chunks.
              {exhaustionDisabledForModel
                ? ' Exhaustion checks are disabled for this model profile.'
                : ' Exhaustion checks are included in this estimate.'}
            </p>
            <p className="mt-1 text-[10px] text-[var(--muted-text)]">
              Local HPC model — no API cost.
            </p>
          </div>
        </div>
      </section>
    </>
  )
}
