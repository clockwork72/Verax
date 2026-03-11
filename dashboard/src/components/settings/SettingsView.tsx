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
  tunnelStatus?: 'checking' | 'online' | 'degraded' | 'offline'
  bridgeReady?: boolean
  bridgeHeadline?: string
  bridgeDetail?: string
  bridgeNode?: string
  bridgeCurrentOutDir?: string
  bridgeCheckedAt?: string
  bridgeHealthyAt?: string
  bridgeFailures?: number
  bridgeActionBusy?: 'diagnose' | 'repair' | null
  bridgeActionMessage?: string
  onDiagnoseBridge?: () => void
  onRepairBridge?: () => void
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
  tunnelStatus = 'checking' as 'checking' | 'online' | 'degraded' | 'offline',
  bridgeReady = false,
  bridgeHeadline = 'Probing local tunnel',
  bridgeDetail = 'Waiting for the workstation to connect to the remote control plane.',
  bridgeNode,
  bridgeCurrentOutDir,
  bridgeCheckedAt = 'never',
  bridgeHealthyAt = 'never',
  bridgeFailures = 0,
  bridgeActionBusy = null,
  bridgeActionMessage,
  onDiagnoseBridge,
  onRepairBridge,
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

  const bridgeBadgeClass = tunnelStatus === 'online'
    ? 'border-[var(--color-success)] text-[var(--color-success)]'
    : tunnelStatus === 'degraded'
      ? 'border-[var(--color-warn)] text-[var(--color-warn)]'
      : tunnelStatus === 'offline'
        ? 'border-[var(--color-danger)] text-[var(--color-danger)]'
        : 'border-[var(--border-soft)] text-[var(--muted-text)]'

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
          <h3 className="text-lg font-semibold">Cluster bridge</h3>
        </div>
        <div className="mt-4 space-y-3">
          <div className="rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs text-[var(--color-text)]">Cluster bridge</p>
                <p className="mt-1 text-[10px] text-[var(--muted-text)]">{bridgeHeadline}</p>
                <p className="mt-1 text-[10px] text-[var(--muted-text)]">{bridgeDetail}</p>
              </div>
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${bridgeBadgeClass}`}>
                {tunnelStatus === 'online' ? '● Bridge live' : tunnelStatus === 'degraded' ? '◐ Bridge degraded' : tunnelStatus === 'offline' ? '○ Bridge offline' : '◌ Checking bridge…'}
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              <div className="rounded-xl border border-[var(--border-soft)] bg-black/20 px-3 py-2 text-[11px] text-[var(--muted-text)]">
                <div className="font-semibold text-[var(--color-text)]">Launch command</div>
                <code className="mt-2 block font-mono">hpc/scraper/launch_remote.sh</code>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1 text-[11px]"
                    onClick={onDiagnoseBridge}
                    disabled={bridgeActionBusy !== null}
                  >
                    {bridgeActionBusy === 'diagnose' ? 'Diagnosing...' : 'Diagnose'}
                  </button>
                  <button
                    className={`focusable rounded-full px-3 py-1 text-[11px] ${
                      tunnelStatus === 'online'
                        ? 'border border-[var(--border-soft)] text-[var(--muted-text)]'
                        : 'border border-amber-500/50 text-amber-300'
                    }`}
                    onClick={onRepairBridge}
                    disabled={bridgeActionBusy !== null || tunnelStatus === 'checking' || tunnelStatus === 'online'}
                  >
                    {bridgeActionBusy === 'repair' ? 'Repairing...' : 'Repair bridge'}
                  </button>
                </div>
              </div>
              <div className="rounded-xl border border-[var(--border-soft)] bg-black/20 px-3 py-2 text-[11px] text-[var(--muted-text)]">
                <div className="font-semibold text-[var(--color-text)]">Bridge telemetry</div>
                <div className="mt-2 flex flex-col gap-1">
                  <span>Node {bridgeNode || 'pending'}</span>
                  <span>Remote out {bridgeCurrentOutDir || 'pending'}</span>
                  <span>Checked {bridgeCheckedAt}</span>
                  <span>Last healthy {bridgeHealthyAt}</span>
                  {bridgeFailures > 0 && tunnelStatus !== 'online' && <span>{bridgeFailures} missed heartbeat{bridgeFailures > 1 ? 's' : ''}</span>}
                </div>
              </div>
            </div>
            {bridgeActionMessage && (
              <p className="mt-3 text-[10px] text-[var(--muted-text)]">{bridgeActionMessage}</p>
            )}
            {!bridgeReady && (
              <p className="mt-3 text-[10px] text-[var(--color-danger)]">
                Non-launcher workspace views stay locked until the tunnel, orchestrator API, and database are all synchronized.
              </p>
            )}
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
