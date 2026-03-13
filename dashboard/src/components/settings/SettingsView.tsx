import { Theme } from '../../types'
import { BentoCard, BentoGrid } from '../ui/BentoCard'
import { StatusPill } from '../ui/StatusPill'

type SettingsViewProps = {
  theme: Theme
  onThemeChange: (theme: Theme) => void
  showExtractionMethod: boolean
  onToggleShowExtractionMethod: (value: boolean) => void
  outDir?: string
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
  bridgeActionBusy?: 'diagnose' | 'repair' | 'refresh' | null
  bridgeActionMessage?: string
  onDiagnoseBridge?: () => void
  onRepairBridge?: () => void
  onRefreshRemote?: () => void
  remoteCodeOutdated?: boolean
}

function tunnelVariant(status: SettingsViewProps['tunnelStatus']): 'ok' | 'warn' | 'error' | 'running' | 'idle' {
  if (status === 'online') return 'ok'
  if (status === 'degraded') return 'warn'
  if (status === 'offline') return 'error'
  if (status === 'checking') return 'running'
  return 'idle'
}

function tunnelLabel(status: SettingsViewProps['tunnelStatus']) {
  if (status === 'online') return 'Bridge live'
  if (status === 'degraded') return 'Bridge degraded'
  if (status === 'offline') return 'Bridge offline'
  if (status === 'checking') return 'Checking bridge'
  return 'Bridge idle'
}

function mappingLabel(mode: SettingsViewProps['mappingMode']) {
  if (mode === 'radar') return 'Tracker Radar'
  if (mode === 'trackerdb') return 'TrackerDB'
  return 'Mixed'
}

function themeLabel(theme: Theme) {
  if (theme === 'dark') return 'Dark'
  if (theme === 'vscode-red') return 'Red'
  return 'Academia'
}

function toneClass(active: boolean, tone: 'primary' | 'success' | 'warn' | 'danger' = 'primary') {
  if (active) {
    if (tone === 'success') return 'border-[rgba(57,255,20,0.3)] bg-[rgba(57,255,20,0.08)] text-[var(--color-success)]'
    if (tone === 'warn') return 'border-[rgba(255,209,102,0.3)] bg-[rgba(255,209,102,0.08)] text-[var(--color-warn)]'
    if (tone === 'danger') return 'border-[rgba(255,45,149,0.3)] bg-[rgba(255,45,149,0.08)] text-[var(--color-danger)]'
    return 'border-[var(--glass-border)] bg-[rgba(0,230,255,0.08)] text-[var(--color-primary)]'
  }
  return 'border-[var(--border-soft)] text-[var(--muted-text)] hover:border-[var(--glass-border)] hover:text-[var(--color-text)]'
}

function SectionHeader({
  eyebrow,
  title,
  detail,
}: {
  eyebrow: string
  title: string
  detail?: string
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">{eyebrow}</p>
      <h3 className="mt-1 text-sm font-semibold">{title}</h3>
      {detail && <p className="mt-1 text-[12px] text-[var(--muted-text)]">{detail}</p>}
    </div>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border-soft)] bg-black/10 px-3 py-2.5">
      <span className="text-[11px] text-[var(--muted-text)]">{label}</span>
      <span className="text-[12px] font-medium text-[var(--color-text)]">{value}</span>
    </div>
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
    <div className="flex items-start justify-between gap-3 rounded-2xl border border-[var(--border-soft)] bg-black/10 px-4 py-3">
      <div className="min-w-0">
        <p className="text-[12px] font-medium text-[var(--color-text)]">{label}</p>
        {description && <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted-text)]">{description}</p>}
      </div>
      <button
        type="button"
        className={`focusable shrink-0 rounded-full border px-3 py-1.5 text-[11px] font-medium transition-colors ${toneClass(value, value ? 'success' : 'primary')}`}
        onClick={() => onToggle(!value)}
        aria-pressed={value}
      >
        {value ? 'Enabled' : 'Disabled'}
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
  excludeSameEntity = false,
  onToggleExcludeSameEntity,
  mappingMode = 'mixed',
  onMappingModeChange,
  autoAnnotate = true,
  onToggleAutoAnnotate,
  tunnelStatus = 'checking',
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
  onRefreshRemote,
  remoteCodeOutdated = false,
}: SettingsViewProps) {
  const tunnelText = tunnelLabel(tunnelStatus)
  const tunnelTone = tunnelVariant(tunnelStatus)

  return (
    <div className="flex flex-col gap-5">
      <BentoGrid className="grid-cols-2 xl:grid-cols-4">
        <BentoCard>
          <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted-text)]">Bridge</p>
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-xl font-semibold text-[var(--color-text)]">{tunnelText}</p>
            <StatusPill variant={tunnelTone} label={bridgeReady ? 'ready' : 'restricted'} pulse={tunnelStatus === 'checking'} />
          </div>
          <p className="mt-2 text-[12px] text-[var(--muted-text)]">{bridgeHeadline}</p>
        </BentoCard>

        <BentoCard>
          <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted-text)]">Dataset source</p>
          <p className="mt-2 text-xl font-semibold text-[var(--color-text)]">Categorized CSV</p>
          <p className="mt-2 text-[12px] text-[var(--muted-text)]">
            Runs scrape directly from `scrapable_websites_categorized.csv`.
          </p>
        </BentoCard>

        <BentoCard>
          <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted-text)]">Pipeline mode</p>
          <p className="mt-2 text-xl font-semibold text-[var(--color-text)]">{mappingLabel(mappingMode)}</p>
          <p className="mt-2 text-[12px] text-[var(--muted-text)]">
            {excludeSameEntity ? 'Same-entity domains excluded.' : 'Same-entity domains included.'}
          </p>
        </BentoCard>

        <BentoCard>
          <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted-text)]">Workspace</p>
          <p className="mt-2 truncate text-sm font-semibold text-[var(--color-text)]">{outDir || 'No output folder loaded'}</p>
          <p className="mt-2 text-[12px] text-[var(--muted-text)]">
            {bridgeCurrentOutDir ? `Remote ${bridgeCurrentOutDir}` : 'Remote output folder pending.'}
          </p>
        </BentoCard>
      </BentoGrid>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <div className="flex flex-col gap-5">
          <BentoCard className="p-5" glow>
            <SectionHeader
              eyebrow="Workspace defaults"
              title="Core operator preferences"
              detail="These toggles change how the active run is presented and what happens when a scrape completes."
            />
            <div className="mt-4 grid gap-3">
              <ToggleRow
                label="Show extraction method labels"
                description="Expose Trafilatura or fallback extraction provenance in viewer surfaces."
                value={showExtractionMethod}
                onToggle={onToggleShowExtractionMethod}
              />
              <ToggleRow
                label="Auto-annotate after scraping"
                description="Start Stage 2 annotation immediately after a scrape run finishes."
                value={autoAnnotate}
                onToggle={(value) => onToggleAutoAnnotate?.(value)}
              />
              <ToggleRow
                label="Exclude same-entity third parties"
                description="Suppress domains owned by the same entity as the first-party site."
                value={excludeSameEntity}
                onToggle={(value) => onToggleExcludeSameEntity?.(value)}
              />
            </div>
          </BentoCard>

          <BentoCard className="p-5">
            <SectionHeader
              eyebrow="Pipeline controls"
              title="Run configuration"
              detail="Future runs always use the categorized dataset CSV and keep the same output/extend workflow."
            />

            <div className="mt-4 rounded-2xl border border-[var(--border-soft)] bg-black/10 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[12px] font-medium text-[var(--color-text)]">Third-party tracker mapping</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted-text)]">
                    Choose which dataset backs domain-to-entity mapping during extraction.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {(['radar', 'trackerdb', 'mixed'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`focusable rounded-full border px-3 py-1.5 text-[11px] transition-colors ${toneClass(mappingMode === mode)}`}
                      onClick={() => onMappingModeChange?.(mode)}
                    >
                      {mappingLabel(mode)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-3 rounded-2xl border border-[var(--border-soft)] bg-black/10 p-4">
              <p className="text-[12px] font-medium text-[var(--color-text)]">Dataset input</p>
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted-text)]">
                The scraper now reads directly from `scrapable_websites_categorized.csv`. No CrUX API key or CrUX cache is used.
              </p>
            </div>
          </BentoCard>
        </div>

        <div className="flex flex-col gap-5">
          <BentoCard className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <SectionHeader
                eyebrow="Bridge telemetry"
                title="Cluster bridge diagnostics"
                detail="Launcher-adjacent operations depend on tunnel health, orchestrator state, and synchronized output paths."
              />
              <StatusPill variant={tunnelTone} label={tunnelText} pulse={tunnelStatus === 'checking'} />
            </div>

            <div className="mt-4 rounded-2xl border border-[var(--border-soft)] bg-black/10 p-4">
              <p className="text-[12px] font-medium text-[var(--color-text)]">{bridgeHeadline}</p>
              <p className="mt-2 text-[12px] leading-relaxed text-[var(--muted-text)]">{bridgeDetail}</p>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <MetaRow label="Node" value={bridgeNode || 'pending'} />
                <MetaRow label="Remote out" value={bridgeCurrentOutDir || 'pending'} />
                <MetaRow label="Last check" value={bridgeCheckedAt} />
                <MetaRow label="Last healthy" value={bridgeHealthyAt} />
              </div>

              {bridgeFailures > 0 && tunnelStatus !== 'online' && (
                <div className="mt-4 rounded-xl border border-[rgba(255,209,102,0.28)] bg-[rgba(255,209,102,0.06)] px-3 py-2 text-[12px] text-[var(--color-warn)]">
                  {bridgeFailures} missed heartbeat{bridgeFailures > 1 ? 's' : ''} detected.
                </div>
              )}

              {bridgeActionMessage && (
                <div className="mt-4 rounded-xl border border-[var(--border-soft)] bg-black/15 px-3 py-2 text-[12px] text-[var(--muted-text)]">
                  {bridgeActionMessage}
                </div>
              )}

              {!bridgeReady && (
                <div className="mt-4 rounded-xl border border-[rgba(255,45,149,0.28)] bg-[rgba(255,45,149,0.06)] px-3 py-2 text-[12px] text-[var(--color-danger)]">
                  Non-launcher workspace views remain restricted until the tunnel, orchestrator API, and database are synchronized.
                </div>
              )}
            </div>

            <div className="mt-4 rounded-2xl border border-[var(--border-soft)] bg-black/10 p-4">
              <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Bridge actions</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={`focusable rounded-full border px-3 py-1.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${toneClass(bridgeActionBusy === 'diagnose')}`}
                  onClick={onDiagnoseBridge}
                  disabled={bridgeActionBusy !== null}
                >
                  {bridgeActionBusy === 'diagnose' ? 'Diagnosing...' : 'Diagnose'}
                </button>
                <button
                  type="button"
                  className={`focusable rounded-full border px-3 py-1.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${toneClass(tunnelStatus !== 'online', tunnelStatus !== 'online' ? 'warn' : 'primary')}`}
                  onClick={onRepairBridge}
                  disabled={bridgeActionBusy !== null || tunnelStatus === 'checking' || tunnelStatus === 'online'}
                >
                  {bridgeActionBusy === 'repair' ? 'Repairing...' : 'Repair bridge'}
                </button>
                <button
                  type="button"
                  className={`focusable rounded-full border px-3 py-1.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${toneClass(remoteCodeOutdated, 'primary')}`}
                  onClick={onRefreshRemote}
                  disabled={bridgeActionBusy !== null}
                >
                  {bridgeActionBusy === 'refresh' ? 'Refreshing...' : 'Refresh remote'}
                </button>
              </div>
              <div className="mt-4 rounded-xl border border-[var(--border-soft)] bg-black/15 px-3 py-3">
                <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Launch command</p>
                <code className="mt-2 block break-all text-[12px] text-[var(--color-text)]">hpc/scraper/launch_remote.sh</code>
              </div>
            </div>
          </BentoCard>

          <BentoCard className="p-5">
            <SectionHeader
              eyebrow="Appearance"
              title="Theme selection"
              detail="Theme switching remains available, but the active workspace is optimized around one dark operational shell."
            />
            <div className="mt-4 flex flex-wrap gap-2">
              {(['dark', 'vscode-red', 'academia'] as Theme[]).map((nextTheme) => (
                <button
                  key={nextTheme}
                  type="button"
                  className={`focusable rounded-full border px-3 py-1.5 text-[11px] transition-colors ${toneClass(theme === nextTheme)}`}
                  onClick={() => onThemeChange(nextTheme)}
                >
                  {themeLabel(nextTheme)}
                </button>
              ))}
            </div>
          </BentoCard>
        </div>
      </div>
    </div>
  )
}
