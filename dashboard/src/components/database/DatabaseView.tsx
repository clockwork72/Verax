import type { AnnotationSiteRecord, AnnotationStats, RunRecord, RunState, RunSummary } from '../../contracts/api'
import { AnimatedCounter } from '../ui/AnimatedCounter'
import { BentoCard, BentoGrid } from '../ui/BentoCard'
import { StatusPill } from '../ui/StatusPill'

type DatabaseViewProps = {
  runsRoot?: string
  runs?: RunRecord[]
  onRefreshRuns?: () => void
  onSelectRun?: (outDir: string) => void
  summary?: RunSummary | null
  state?: RunState | null
  onClear: (includeArtifacts?: boolean) => void
  clearing?: boolean
  outDir: string
  onOutDirChange: (value: string) => void
  onLoadOutDir: () => void
  onDeleteOutDir: () => void
  onDeleteAllOutputs: () => void
  folderBytes?: number | null
  annotationStats?: AnnotationStats | null
  deleteEnabled?: boolean
}

function formatBytes(bytes?: number | null) {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let idx = 0
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024
    idx += 1
  }
  return `${value.toFixed(1)} ${units[idx]}`
}

function formatDate(value?: string | null) {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString()
}

function formatDurationMs(start?: string | null, end?: string | null) {
  if (!start || !end) return '—'
  const startMs = new Date(start).getTime()
  const endMs = new Date(end).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return '—'
  const seconds = Math.round((endMs - startMs) / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, '0')}s`
  return `${secs}s`
}

function resolveRunStats(run: RunRecord) {
  const summary = run.summary
  const state = run.state
  const processed = summary?.processed_sites ?? state?.processed_sites ?? 0
  const total = summary?.total_sites ?? state?.total_sites ?? 0
  const statusCounts = summary?.status_counts ?? state?.status_counts ?? {}
  const ok = statusCounts.ok ?? 0
  const successRate =
    summary?.success_rate ?? (processed ? Math.round((Number(ok) / Math.max(1, processed)) * 100) : 0)
  return { processed, total, successRate }
}

export function DatabaseView({
  runsRoot,
  runs = [],
  onRefreshRuns,
  onSelectRun,
  summary,
  state,
  onClear,
  clearing,
  outDir,
  onOutDirChange,
  onLoadOutDir,
  onDeleteOutDir,
  onDeleteAllOutputs,
  folderBytes,
  annotationStats,
  deleteEnabled = true,
}: DatabaseViewProps) {
  const processed = summary?.processed_sites ?? state?.processed_sites ?? 0
  const total = summary?.total_sites ?? state?.total_sites ?? 0
  const thirdParty = summary?.third_party ?? { total: 0, unique: 0, mapped: 0, unmapped: 0, no_policy_url: 0 }
  const thirdPartyUnique = thirdParty.unique ?? thirdParty.total ?? 0
  const outputsRoot = runsRoot || 'outputs'
  const activeRunId = runs.find((run) => run.outDir === outDir)?.runId

  const metricCards = [
    { label: 'Run folders', value: runs.length, detail: 'Persisted output directories detected in the workspace.' },
    { label: 'Processed sites', value: processed, detail: total ? `of ${total}` : 'current loaded run' },
    { label: '3P observed', value: thirdPartyUnique, detail: 'Unique third-party services in the loaded dataset.' },
    { label: 'Footprint', value: formatBytes(folderBytes), detail: 'Local size of the selected output folder.' },
  ]

  return (
    <div className="flex flex-col gap-5">
      <BentoGrid className="grid-cols-2 xl:grid-cols-4">
        {metricCards.map((card) => (
          <BentoCard key={card.label}>
            <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted-text)]">{card.label}</p>
            <p className="mt-2 text-2xl font-semibold text-[var(--color-text)]">
              {typeof card.value === 'number' ? <AnimatedCounter value={card.value} /> : card.value}
            </p>
            <p className="mt-2 text-[12px] text-[var(--muted-text)]">{card.detail}</p>
          </BentoCard>
        ))}
      </BentoGrid>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_360px]">
        <BentoCard className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Run registry</p>
              <h2 className="text-sm font-semibold">History and selection</h2>
              <p className="mt-1 text-[12px] text-[var(--muted-text)]">
                Output root <span className="mono text-[var(--color-text)]">{outputsRoot}</span>
              </p>
            </div>
            <div className="flex items-center gap-2">
              {activeRunId && <StatusPill variant="running" label={`loaded ${activeRunId}`} />}
              <button
                className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1.5 text-[11px] text-[var(--muted-text)] transition-colors hover:border-[var(--glass-border)] hover:text-[var(--color-text)]"
                onClick={onRefreshRuns}
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--border-soft)] bg-black/10">
            <div className="grid grid-cols-[1.4fr_0.9fr_0.6fr_0.9fr_0.8fr_0.45fr] gap-2 bg-black/25 px-4 py-2 text-[10px] uppercase tracking-[0.18em] text-[var(--muted-text)]">
              <span>Run ID</span>
              <span>Sites</span>
              <span>Success</span>
              <span>Updated</span>
              <span>Duration</span>
              <span />
            </div>
            <div className="max-h-[360px] overflow-y-auto">
              {runs.length === 0 && (
                <div className="px-4 py-6 text-sm text-[var(--muted-text)]">No run folders found.</div>
              )}
              {runs.map((run) => {
                const stats = resolveRunStats(run)
                const selected = run.outDir === outDir
                return (
                  <div
                    key={`${run.runId}-${run.outDir}`}
                    className={`grid grid-cols-[1.4fr_0.9fr_0.6fr_0.9fr_0.8fr_0.45fr] items-center gap-2 border-t border-[var(--border-soft)] px-4 py-3 text-[12px] ${
                      selected ? 'bg-[rgba(0,230,255,0.06)]' : 'bg-transparent'
                    }`}
                    style={selected ? { boxShadow: 'inset 2px 0 0 var(--color-primary)' } : undefined}
                  >
                    <div className="min-w-0">
                      <p className="mono truncate text-[var(--color-text)]">{run.runId || run.folder}</p>
                      <p className="mt-1 truncate text-[11px] text-[var(--muted-text)]">{run.outDir}</p>
                    </div>
                    <div className="text-[var(--muted-text)]">
                      {stats.processed.toLocaleString()} / {stats.total || '—'}
                    </div>
                    <div className="text-[var(--muted-text)]">{stats.successRate ? `${stats.successRate}%` : '—'}</div>
                    <div className="text-[var(--muted-text)]">{formatDate(run.updated_at)}</div>
                    <div className="text-[var(--muted-text)]">{formatDurationMs(run.started_at, run.updated_at)}</div>
                    <div className="text-right">
                      <button
                        className={`focusable rounded-full border px-3 py-1 text-[11px] transition-colors ${
                          selected
                            ? 'border-[var(--glass-border)] text-[var(--color-primary)]'
                            : 'border-[var(--border-soft)] text-[var(--muted-text)] hover:border-[var(--glass-border)] hover:text-[var(--color-text)]'
                        }`}
                        onClick={() => onSelectRun?.(run.outDir)}
                      >
                        {selected ? 'Loaded' : 'Load'}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </BentoCard>

        <div className="flex flex-col gap-5">
          <BentoCard className="p-5">
            <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Path control</p>
            <h3 className="mt-1 text-sm font-semibold">Load and inspect a folder</h3>
            <div className="mt-4 space-y-3">
              <input
                className="focusable w-full rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-2 text-sm text-[var(--color-text)]"
                value={outDir}
                onChange={(event) => onOutDirChange(event.target.value)}
                placeholder="outputs"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="focusable rounded-full border border-[var(--glass-border)] px-3 py-1.5 text-[11px] text-[var(--color-primary)] transition-colors hover:bg-[rgba(0,230,255,0.08)]"
                  onClick={onLoadOutDir}
                >
                  Load folder
                </button>
                <button
                  className={`focusable rounded-full border px-3 py-1.5 text-[11px] transition-colors ${
                    outDir === `${outputsRoot}/unified`
                      ? 'border-[var(--glass-border)] text-[var(--color-primary)]'
                      : 'border-[var(--border-soft)] text-[var(--muted-text)] hover:border-[var(--glass-border)] hover:text-[var(--color-text)]'
                  }`}
                  onClick={() => onSelectRun?.(`${outputsRoot}/unified`)}
                >
                  Load unified
                </button>
              </div>
              <div className="rounded-xl border border-[var(--border-soft)] bg-black/10 px-3 py-3">
                <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Selected root</p>
                <p className="mt-1 break-all text-[12px] text-[var(--color-text)]">{outDir || '—'}</p>
              </div>
            </div>
          </BentoCard>

          <BentoCard className="p-5">
            <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Destructive actions</p>
            <h3 className="mt-1 text-sm font-semibold">Storage reset controls</h3>
            <p className="mt-2 text-[12px] text-[var(--muted-text)]">
              These actions modify local outputs only. Keep them isolated from normal inspection work.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                className="focusable rounded-xl border border-[rgba(255,209,102,0.28)] px-3 py-2 text-left text-[12px] text-[var(--color-warn)] transition-colors hover:bg-[rgba(255,209,102,0.08)] disabled:opacity-50"
                onClick={() => onClear(false)}
                disabled={clearing}
              >
                Clear results
              </button>
              <button
                className="focusable rounded-xl border border-[rgba(255,209,102,0.28)] px-3 py-2 text-left text-[12px] text-[var(--color-warn)] transition-colors hover:bg-[rgba(255,209,102,0.08)] disabled:opacity-50"
                onClick={() => onClear(true)}
                disabled={clearing}
              >
                Clear results + artifacts
              </button>
              <button
                className="focusable rounded-xl border border-[rgba(255,45,149,0.28)] px-3 py-2 text-left text-[12px] text-[var(--color-danger)] transition-colors hover:bg-[rgba(255,45,149,0.08)] disabled:opacity-50"
                onClick={onDeleteOutDir}
                disabled={clearing || !deleteEnabled}
                title={deleteEnabled ? `Delete ${outDir}` : 'Load a concrete run folder inside outputs/ first'}
              >
                Delete loaded folder
              </button>
              <button
                className="focusable rounded-xl border border-[rgba(255,45,149,0.28)] px-3 py-2 text-left text-[12px] text-[var(--color-danger)] transition-colors hover:bg-[rgba(255,45,149,0.08)] disabled:opacity-50"
                onClick={onDeleteAllOutputs}
                disabled={clearing}
                title="Delete every folder inside outputs/"
              >
                Delete all outputs
              </button>
            </div>
          </BentoCard>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
        <BentoCard className="p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Reference artifacts</p>
              <h3 className="text-sm font-semibold">Filesystem outputs</h3>
            </div>
            <StatusPill variant="idle" label="read-only view" />
          </div>
          <div className="mt-4 grid gap-3">
            {[
              ['results.jsonl', 'Raw crawl output'],
              ['results.summary.json', 'Aggregated metrics'],
              ['run_state.json', 'Live counters'],
              ['explorer.jsonl', 'Explorer dataset'],
              ['policy_statements.jsonl', 'Base annotation statements'],
              ['policy_statements_annotated.jsonl', 'Source-text annotation statements'],
            ].map(([label, detail]) => (
              <div
                key={label}
                className="flex items-center justify-between rounded-2xl border border-[var(--border-soft)] bg-black/10 px-4 py-3"
              >
                <div>
                  <p className="mono text-[11px] text-[var(--color-text)]">{label}</p>
                  <p className="mt-1 text-[11px] text-[var(--muted-text)]">{detail}</p>
                </div>
                <span className="rounded-full border border-[var(--border-soft)] px-2.5 py-1 text-[10px] text-[var(--muted-text)]">
                  filesystem
                </span>
              </div>
            ))}
          </div>
        </BentoCard>

        <BentoCard className="p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Integrity telemetry</p>
              <h3 className="text-sm font-semibold">Loaded dataset health</h3>
            </div>
            <StatusPill variant={summary ? 'ok' : 'idle'} label={summary ? 'summary loaded' : 'partial'} />
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {[
              ['Third-party mapped', thirdParty.mapped ? `${thirdParty.mapped}` : '—'],
              ['Third-party unmapped', thirdParty.unmapped ? `${thirdParty.unmapped}` : '—'],
              ['No policy URL', thirdParty.no_policy_url ? `${thirdParty.no_policy_url}` : '—'],
              ['Annotation sites', annotationStats?.total_sites ? `${annotationStats.total_sites}` : '—'],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-[var(--border-soft)] bg-black/10 px-3 py-3">
                <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-text)]">{label}</p>
                <p className="mt-1 text-lg font-semibold text-[var(--color-text)]">{value}</p>
              </div>
            ))}
          </div>

          {annotationStats && (
            <div className="mt-4 grid gap-3">
              {[
                {
                  label: 'document.json',
                  value: annotationStats.per_site
                    ? annotationStats.per_site.filter((s: AnnotationSiteRecord) => s.has_statements).length
                    : '—',
                  detail: 'Sites with document structure',
                },
                {
                  label: 'policy_statements.jsonl',
                  value: annotationStats.annotated_sites ?? '—',
                  detail: 'Sites with base statements',
                },
                {
                  label: 'policy_statements_annotated.jsonl',
                  value: annotationStats.annotated_sites ?? '—',
                  detail: 'Sites with source-text statements',
                },
              ].map((row) => (
                <div key={row.label} className="rounded-2xl border border-[var(--border-soft)] bg-black/10 px-4 py-3">
                  <p className="mono text-[10px] text-[var(--muted-text)]">{row.label}</p>
                  <p className="mt-1 text-lg font-semibold text-[var(--color-text)]">
                    {typeof row.value === 'number' ? row.value.toLocaleString() : row.value}
                  </p>
                  <p className="mt-1 text-[11px] text-[var(--muted-text)]">{row.detail}</p>
                </div>
              ))}
            </div>
          )}
        </BentoCard>
      </div>
    </div>
  )
}
