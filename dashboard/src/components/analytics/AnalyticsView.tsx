type AnalyticsViewProps = {
  summary?: any
  state?: any
  annotationStats?: any
  tpCacheStats?: any
}

export function AnalyticsView({ summary, state, annotationStats, tpCacheStats }: AnalyticsViewProps) {
  const processed = state?.processed_sites ?? summary?.processed_sites ?? 0
  const total = state?.total_sites ?? summary?.total_sites ?? 0
  const successRate = summary?.success_rate ?? 0
  const statusCounts = summary?.status_counts || state?.status_counts || {}
  const ok = statusCounts.ok ?? 0
  const failures =
    (statusCounts.policy_not_found ?? 0) +
    (statusCounts.non_browsable ?? 0) +
    (statusCounts.home_fetch_failed ?? 0)

  return (
    <>
      <section className="card rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Run health</p>
            <h2 className="text-lg font-semibold">Scraper performance</h2>
            <p className="text-xs text-[var(--muted-text)]">Live run stats from the scraper state file.</p>
          </div>
          <span className="theme-chip rounded-full px-3 py-1 text-xs">Processed {processed.toLocaleString()}</span>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: 'Total sites', value: total ? total.toLocaleString() : '—' },
            { label: 'Processed', value: processed.toLocaleString() },
            { label: 'Success rate', value: `${successRate}%` },
            { label: 'Failures', value: failures.toLocaleString() },
          ].map((row) => (
            <div key={row.label} className="rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-3">
              <p className="text-xs text-[var(--muted-text)]">{row.label}</p>
              <p className="text-lg font-semibold">{row.value}</p>
            </div>
          ))}
        </div>

        <div className="mt-5 grid gap-3 text-xs">
          {[
            { label: 'OK', value: ok },
            { label: 'Policy not found', value: statusCounts.policy_not_found ?? 0 },
            { label: 'Non-browsable', value: statusCounts.non_browsable ?? 0 },
            { label: 'Home fetch failed', value: statusCounts.home_fetch_failed ?? 0 },
          ].map((row) => (
            <div key={row.label} className="flex items-center gap-4">
              <span className="w-40 text-[var(--muted-text)]">{row.label}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-black/30">
                <div
                  className="h-full rounded-full bg-[var(--color-primary)]"
                  style={{
                    width: total ? `${Math.min(100, (row.value / Math.max(1, total)) * 100)}%` : '0%',
                  }}
                />
              </div>
              <span className="text-[var(--muted-text)]">{row.value.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="card rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Timing</p>
            <h3 className="text-lg font-semibold">Scrape duration</h3>
          </div>
          <span className="text-xs text-[var(--muted-text)]">Updated {state?.updated_at ?? summary?.updated_at ?? '—'}</span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: 'Started', value: summary?.started_at ?? '—' },
            { label: 'Updated', value: summary?.updated_at ?? '—' },
            { label: 'Run ID', value: summary?.run_id ?? '—' },
            { label: 'Processed', value: processed.toLocaleString() },
          ].map((row) => (
            <div key={row.label} className="rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-3">
              <p className="text-xs text-[var(--muted-text)]">{row.label}</p>
              <p className="text-sm font-semibold">{row.value}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="card rounded-2xl p-6">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Resource usage</p>
          <h3 className="text-lg font-semibold">System snapshot</h3>
          <p className="text-xs text-[var(--muted-text)]">Hook real CPU/RAM metrics via preload if needed.</p>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: 'CPU', value: '—' },
            { label: 'RAM', value: '—' },
            { label: 'Network', value: '—' },
            { label: 'Disk', value: '—' },
          ].map((row) => (
            <div key={row.label} className="rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-3">
              <p className="text-xs text-[var(--muted-text)]">{row.label}</p>
              <p className="text-lg font-semibold">{row.value}</p>
            </div>
          ))}
        </div>
      </section>

      {tpCacheStats && (
        <section className="card rounded-2xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Cache</p>
              <h3 className="text-lg font-semibold">Third-party policy cache</h3>
              <p className="text-xs text-[var(--muted-text)]">
                Persistent URL cache for third-party policy fetches, avoiding redundant network requests.
              </p>
            </div>
            <span className="theme-chip rounded-full px-3 py-1 text-xs">
              {tpCacheStats.total ?? 0} cached URLs
            </span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                label: 'Cached URLs',
                value: (tpCacheStats.total ?? 0).toLocaleString(),
              },
              {
                label: 'Fetched (text)',
                value: (tpCacheStats.fetched ?? 0).toLocaleString(),
              },
              {
                label: 'Failed',
                value: (tpCacheStats.failed ?? 0).toLocaleString(),
              },
              {
                label: 'Requests saved',
                value: (tpCacheStats.fetched ?? 0).toLocaleString(),
              },
            ].map((row) => (
              <div key={row.label} className="rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-3">
                <p className="text-xs text-[var(--muted-text)]">{row.label}</p>
                <p className="text-lg font-semibold">{row.value}</p>
              </div>
            ))}
          </div>
          {tpCacheStats.total > 0 && (
            <div className="mt-4">
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-black/30">
                <div
                  className="h-full bg-[var(--color-success)]"
                  style={{ width: `${Math.min(100, ((tpCacheStats.fetched ?? 0) / Math.max(1, tpCacheStats.total)) * 100)}%` }}
                />
                <div
                  className="h-full bg-[var(--color-danger)]"
                  style={{ width: `${Math.min(100, ((tpCacheStats.failed ?? 0) / Math.max(1, tpCacheStats.total)) * 100)}%` }}
                />
              </div>
              <div className="mt-2 flex gap-4 text-xs text-[var(--muted-text)]">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-[var(--color-success)]" /> fetched
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-[var(--color-danger)]" /> failed
                </span>
              </div>
            </div>
          )}
        </section>
      )}

      {annotationStats && (
        <section className="card rounded-2xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Stage 2</p>
              <h3 className="text-lg font-semibold">Annotation status</h3>
              <p className="text-xs text-[var(--muted-text)]">
                LLM annotation progress across artifact directories.
              </p>
            </div>
            <span className="theme-chip rounded-full px-3 py-1 text-xs">
              {annotationStats.annotated_sites ?? 0} / {annotationStats.total_sites ?? 0} annotated
            </span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { label: 'Sites annotated', value: (annotationStats.annotated_sites ?? 0).toLocaleString() },
              {
                label: 'Pending annotation',
                value: Math.max(
                  0,
                  (annotationStats.total_sites ?? 0) - (annotationStats.annotated_sites ?? 0)
                ).toLocaleString(),
              },
              { label: 'Total statements', value: (annotationStats.total_statements ?? 0).toLocaleString() },
            ].map((row) => (
              <div key={row.label} className="rounded-xl border border-[var(--border-soft)] bg-black/20 px-4 py-3">
                <p className="text-xs text-[var(--muted-text)]">{row.label}</p>
                <p className="text-lg font-semibold">{row.value}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  )
}
