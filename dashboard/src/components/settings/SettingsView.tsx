import { useCallback, useEffect, useState } from 'react'
import { Theme } from '../../types'

type CruxCacheStats = { count: number; present: number; absent: number }

type SettingsViewProps = {
  theme: Theme
  onThemeChange: (theme: Theme) => void
  showExtractionMethod: boolean
  onToggleShowExtractionMethod: (value: boolean) => void
  outDir?: string
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
  outDir,
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
}: SettingsViewProps) {
  const [cruxCache, setCruxCache] = useState<CruxCacheStats | null>(null)

  const refreshCruxCache = useCallback(async () => {
    if (!window.scraper?.cruxCacheStats) return
    const res = await window.scraper.cruxCacheStats(outDir)
    if (res?.ok && (res.count ?? 0) > 0) {
      setCruxCache({ count: res.count!, present: res.present!, absent: res.absent! })
    } else {
      setCruxCache(null)
    }
  }, [outDir])

  useEffect(() => { void refreshCruxCache() }, [refreshCruxCache])

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

          <div className="rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-[var(--color-text)]">CrUX origin cache</p>
                <p className="mt-0.5 text-[10px] text-[var(--muted-text)]">
                  Persisted lookup results — cached origins skip the API on future runs.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {cruxCache ? (
                  <>
                    <span className="rounded-full border border-[var(--border-soft)] px-2.5 py-1 text-[10px] text-[var(--muted-text)]">
                      {cruxCache.count.toLocaleString()} cached
                    </span>
                    <span className="rounded-full border border-emerald-600/40 bg-emerald-900/30 px-2.5 py-1 text-[10px] text-emerald-300">
                      {cruxCache.present.toLocaleString()} present
                    </span>
                    <span className="rounded-full border border-[var(--border-soft)] px-2.5 py-1 text-[10px] text-[var(--muted-text)]">
                      {cruxCache.absent.toLocaleString()} absent
                    </span>
                  </>
                ) : (
                  <span className="rounded-full border border-[var(--border-soft)] px-2.5 py-1 text-[10px] text-[var(--muted-text)]">
                    no cache yet
                  </span>
                )}
                <button
                  className="focusable rounded-full border border-[var(--border-soft)] px-2.5 py-1 text-[10px] text-[var(--muted-text)]"
                  onClick={() => void refreshCruxCache()}
                >
                  Refresh
                </button>
              </div>
            </div>
          </div>

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
            <p className="mb-2 text-xs text-[var(--color-text)]">Cluster Bridge</p>
            <p className="mb-3 text-[10px] text-[var(--muted-text)]">
              The Slurm orchestrator API is exposed locally through SSH tunnel port 8910. Start it with:<br />
              <code className="font-mono">hpc/scraper/launch_remote.sh</code>
            </p>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
              tunnelStatus === 'online'
                ? 'border-[var(--color-success)] text-[var(--color-success)]'
                : tunnelStatus === 'offline'
                  ? 'border-[var(--color-danger)] text-[var(--color-danger)]'
                  : 'border-[var(--border-soft)] text-[var(--muted-text)]'
            }`}>
              {tunnelStatus === 'online' ? '● Cluster bridge active' : tunnelStatus === 'offline' ? '○ Cluster bridge offline' : '◌ Checking bridge…'}
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
    </>
  )
}
