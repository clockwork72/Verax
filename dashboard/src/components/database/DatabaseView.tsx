import type { AnnotationSiteRecord, AnnotationStats } from '../../contracts/api'

type DatabaseViewProps = {
  runsRoot?: string
  runs?: any[]
  onRefreshRuns?: () => void
  onSelectRun?: (outDir: string) => void
  summary?: any
  state?: any
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

function resolveRunStats(run: any) {
  const summary = run?.summary || {}
  const state = run?.state || {}
  const processed = summary.processed_sites ?? state.processed_sites ?? 0
  const total = summary.total_sites ?? state.total_sites ?? 0
  const statusCounts = summary.status_counts ?? state.status_counts ?? {}
  const ok = statusCounts.ok ?? 0
  const successRate =
    summary.success_rate ?? (processed ? Math.round((Number(ok) / Math.max(1, processed)) * 100) : 0)
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
  const thirdParty = summary?.third_party || {}

  return (
    <>
      <section className="card rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Runs</p>
            <h2 className="text-lg font-semibold">Run history</h2>
            <p className="text-xs text-[var(--muted-text)]">
              Output root: <span className="mono">{runsRoot || 'outputs'}</span>
            </p>
          </div>
          <button
            className="focusable rounded-full border border-[var(--border-soft)] px-4 py-2 text-xs"
            onClick={onRefreshRuns}
          >
            Refresh
          </button>
        </div>

        <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--border-soft)]">
          <div className="grid grid-cols-[1.4fr_0.9fr_0.6fr_0.9fr_0.8fr_0.4fr] gap-2 bg-black/30 px-4 py-2 text-[10px] uppercase tracking-[0.2em] text-[var(--muted-text)]">
            <span>Run ID</span>
            <span>Sites</span>
            <span>Success</span>
            <span>Updated</span>
            <span>Duration</span>
            <span></span>
          </div>
          <div className="max-h-[320px] overflow-y-auto bg-black/10">
            {runs.length === 0 && (
              <div className="px-4 py-6 text-sm text-[var(--muted-text)]">No run folders found.</div>
            )}
            {runs.map((run) => {
              const stats = resolveRunStats(run)
              const selected = run.outDir === outDir
              return (
                <div
                  key={`${run.runId}-${run.outDir}`}
                  className={`grid grid-cols-[1.4fr_0.9fr_0.6fr_0.9fr_0.8fr_0.4fr] items-center gap-2 border-t border-[var(--border-soft)] px-4 py-3 text-xs ${
                    selected ? 'bg-black/30' : ''
                  }`}
                >
                  <div className="mono text-[var(--color-text)]">{run.runId || run.folder}</div>
                  <div className="text-[var(--muted-text)]">
                    {stats.processed.toLocaleString()} / {stats.total || '—'}
                  </div>
                  <div className="text-[var(--muted-text)]">{stats.successRate ? `${stats.successRate}%` : '—'}</div>
                  <div className="text-[var(--muted-text)]">{formatDate(run.updated_at)}</div>
                  <div className="text-[var(--muted-text)]">
                    {formatDurationMs(run.started_at, run.updated_at)}
                  </div>
                  <div className="text-right">
                    <button
                      className={`focusable rounded-full border px-3 py-1 ${
                        selected ? 'border-[var(--color-danger)] text-white' : 'border-[var(--border-soft)]'
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
      </section>

      <section className="card rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Storage</p>
            <h2 className="text-lg font-semibold">Artifacts & outputs</h2>
            <p className="text-xs text-[var(--muted-text)]">Local dataset footprint and export tools.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="focusable rounded-full border border-[var(--border-soft)] px-4 py-2 text-xs">
              Export JSONL
            </button>
            <button
              className="focusable rounded-full border border-[var(--color-danger)] px-4 py-2 text-xs text-white"
              onClick={() => onClear(false)}
              disabled={clearing}
            >
              Clear results
            </button>
            <button
              className="focusable rounded-full border border-[var(--border-soft)] px-4 py-2 text-xs"
              onClick={() => onClear(true)}
              disabled={clearing}
            >
              Clear + artifacts
            </button>
            <button
              className="focusable rounded-full border border-[var(--border-soft)] px-4 py-2 text-xs"
              onClick={onDeleteOutDir}
              disabled={clearing || !deleteEnabled}
              title={deleteEnabled ? `Delete ${outDir}` : 'Load a concrete run folder inside outputs/ first'}
            >
              Delete loaded folder
            </button>
            <button
              className="focusable rounded-full border border-[var(--color-danger)] px-4 py-2 text-xs text-white"
              onClick={onDeleteAllOutputs}
              disabled={clearing}
              title="Delete every folder inside outputs/"
            >
              Delete all outputs
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          <input
            className="focusable w-72 rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-2 text-sm text-white"
            value={outDir}
            onChange={(event) => onOutDirChange(event.target.value)}
            placeholder="outputs"
          />
          <button
            className="focusable rounded-full border border-[var(--border-soft)] px-4 py-2 text-xs"
            onClick={onLoadOutDir}
          >
            Load folder
          </button>
          <button
            className={`focusable rounded-full border px-4 py-2 text-xs ${
              outDir === `${runsRoot || 'outputs'}/unified`
                ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                : 'border-[var(--border-soft)] text-[var(--muted-text)]'
            }`}
            onClick={() => onSelectRun?.(`${runsRoot || 'outputs'}/unified`)}
            title="Load the unified output directory that accumulates all runs"
          >
            Load unified
          </button>
          <span className="text-xs text-[var(--muted-text)]">Folder size: {formatBytes(folderBytes)}</span>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <div className="rounded-2xl border border-[var(--border-soft)] bg-black/20 p-4">
            <div className="flex items-center justify-between text-xs text-[var(--muted-text)]">
              <span>Records processed</span>
              <span>{processed.toLocaleString()} / {total || '—'}</span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-black/30">
              <div
                className="h-full rounded-full bg-[var(--color-primary)]"
                style={{ width: total ? `${Math.min(100, (processed / total) * 100)}%` : '0%' }}
              />
            </div>
            <div className="mt-4 grid gap-3 text-xs">
              {[
                { label: 'Third-party total', value: thirdParty.total ?? '—' },
                { label: 'Mapped', value: thirdParty.mapped ?? '—' },
                { label: 'Unmapped', value: thirdParty.unmapped ?? '—' },
                { label: 'No policy URL', value: thirdParty.no_policy_url ?? '—' },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between">
                  <span className="text-[var(--muted-text)]">{row.label}</span>
                  <span>{row.value}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-[var(--border-soft)] bg-black/20 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Exports</p>
            <h3 className="text-lg font-semibold">Quick actions</h3>
            <div className="mt-4 grid gap-3 text-xs">
              {[
                { label: 'results.jsonl', detail: 'Raw crawl output', action: 'Open' },
                { label: 'results.summary.json', detail: 'Aggregated metrics', action: 'Open' },
                { label: 'run_state.json', detail: 'Live counters', action: 'Open' },
                { label: 'explorer.jsonl', detail: 'Explorer data', action: 'Open' },
                { label: 'policy_statements.jsonl', detail: 'Base statements (per site)', action: 'Open' },
                { label: 'policy_statements_annotated.jsonl', detail: 'Annotated with source text', action: 'Open' },
              ].map((row) => (
                <div
                  key={row.label}
                  className="flex items-center justify-between rounded-xl border border-[var(--border-soft)] bg-black/10 px-3 py-2"
                >
                  <div>
                    <p className="mono text-[var(--muted-text)]">{row.label}</p>
                    <p className="text-[10px] text-[var(--muted-text)]">{row.detail}</p>
                  </div>
                  <button className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1">
                    {row.action}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="card rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Health</p>
            <h3 className="text-lg font-semibold">Dataset integrity</h3>
          </div>
          <span className="text-xs text-[var(--muted-text)]">Updated {summary?.updated_at ?? state?.updated_at ?? '—'}</span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: 'JSONL valid', value: summary ? 'OK' : '—' },
            { label: 'Policies extracted', value: summary?.success_rate ? `${summary.success_rate}%` : '—' },
            { label: 'Third-party mapped', value: thirdParty.mapped ? `${thirdParty.mapped}` : '—' },
            {
              label: 'Artifacts present',
              value: annotationStats?.total_sites ? String(annotationStats.total_sites) : '—',
            },
          ].map((row) => (
            <div key={row.label} className="rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-3">
              <p className="text-xs text-[var(--muted-text)]">{row.label}</p>
              <p className="text-lg font-semibold">{row.value}</p>
            </div>
          ))}
        </div>
        {annotationStats && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
              <div key={row.label} className="rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-3">
                <p className="mono text-[10px] text-[var(--muted-text)]">{row.label}</p>
                <p className="text-lg font-semibold">{typeof row.value === 'number' ? row.value.toLocaleString() : row.value}</p>
                <p className="text-[10px] text-[var(--muted-text)]">{row.detail}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  )
}
