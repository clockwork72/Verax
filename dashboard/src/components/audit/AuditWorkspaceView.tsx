import { useEffect, useMemo, useState, useCallback } from 'react'
import type { ActiveSiteInfo, ResultRecord } from '../../contracts/api'
import { readArtifactText } from '../../lib/artifactClient'
import { countOkArtifactSites } from '../../lib/scraperClient'

type ActionResult = { ok: boolean; error?: string }

type AuditWorkspaceViewProps = {
  outDir: string
  records: ResultRecord[]
  verifiedSites: string[]
  urlOverrides: Record<string, string>
  running: boolean
  busySite: string | null
  annotatingSite: string | null
  activeSites?: Record<string, ActiveSiteInfo>
  onReload: () => Promise<void> | void
  onMarkVerified: (site: string) => Promise<void> | void
  onSaveOverride: (site: string, url: string) => Promise<void> | void
  onRerun: (site: string, overrideUrl?: string) => Promise<ActionResult>
  onAnnotate: (site: string) => Promise<ActionResult>
}

function normalizeSiteKey(value: string): string {
  return value.trim().toLowerCase()
}

function siteKey(record: ResultRecord): string {
  const candidate = record.site_etld1 || record.site || record.input || ''
  return String(candidate).trim()
}

function rankForSort(record: ResultRecord): number {
  const rank = Number(record.rank)
  return Number.isFinite(rank) && rank > 0 ? rank : Number.MAX_SAFE_INTEGER
}

function statusTone(status: string): { dot: string; row: string } {
  if (status === 'ok') {
    return {
      dot: 'bg-emerald-400',
      row: 'border-emerald-500/40 bg-emerald-900/10',
    }
  }
  return {
    dot: 'bg-red-400',
    row: 'border-red-500/40 bg-red-900/10',
  }
}

const STAGE_STEPS = ['Home fetch', 'Policy discovery', '3P extraction', '3P policies']

function findActiveInfo(site: string, activeSites: Record<string, ActiveSiteInfo>): ActiveSiteInfo | null {
  if (!site) return null
  if (activeSites[site]) return activeSites[site]
  const normalized = normalizeSiteKey(site)
  for (const [key, value] of Object.entries(activeSites)) {
    if (normalizeSiteKey(key) === normalized) return value
  }
  return null
}

export function AuditWorkspaceView({
  outDir,
  records,
  verifiedSites,
  urlOverrides,
  running,
  busySite,
  annotatingSite,
  activeSites = {},
  onReload,
  onMarkVerified,
  onSaveOverride,
  onRerun,
  onAnnotate,
}: AuditWorkspaceViewProps) {
  const [selectedSite, setSelectedSite] = useState('')
  const [policyText, setPolicyText] = useState('')
  const [policyLoading, setPolicyLoading] = useState(false)
  const [policyError, setPolicyError] = useState<string | null>(null)
  const [overrideInput, setOverrideInput] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNote, setActionNote] = useState<string | null>(null)
  const [okSites, setOkSites] = useState<Set<string>>(new Set())
  const [showSuccessfulOnly, setShowSuccessfulOnly] = useState(false)

  const refreshOkCount = useCallback(async () => {
    setOkSites(new Set(await countOkArtifactSites(outDir)))
  }, [outDir])

  useEffect(() => {
    void refreshOkCount()
  }, [refreshOkCount, records])

  const verifiedSet = useMemo(
    () => new Set(verifiedSites.map((value) => normalizeSiteKey(value))),
    [verifiedSites]
  )

  const orderedRecords = useMemo(() => {
    const next = records.filter((record) => !!siteKey(record)).slice()
    next.sort((a, b) => {
      const rankDelta = rankForSort(a) - rankForSort(b)
      if (rankDelta !== 0) return rankDelta
      return siteKey(a).localeCompare(siteKey(b))
    })
    return next
  }, [records])

  const activeRecords = useMemo(() => {
    let filtered = orderedRecords.filter(
      (record) => !verifiedSet.has(normalizeSiteKey(siteKey(record)))
    )
    if (showSuccessfulOnly && okSites.size > 0) {
      filtered = filtered.filter((record) => okSites.has(siteKey(record)))
    }
    return filtered
  }, [orderedRecords, verifiedSet, showSuccessfulOnly, okSites])

  const selectedRecord = useMemo(
    () => activeRecords.find((record) => siteKey(record) === selectedSite) || null,
    [activeRecords, selectedSite]
  )

  const selectedSiteKey = selectedRecord ? siteKey(selectedRecord) : ''

  useEffect(() => {
    if (!activeRecords.length) {
      setSelectedSite('')
      return
    }
    if (!selectedSite || !activeRecords.some((record) => siteKey(record) === selectedSite)) {
      setSelectedSite(siteKey(activeRecords[0]))
    }
  }, [activeRecords, selectedSite])

  useEffect(() => {
    if (!selectedRecord) {
      setOverrideInput('')
      return
    }
    const override = urlOverrides[normalizeSiteKey(selectedSiteKey)]
    const fallback = selectedRecord.first_party_policy?.url || ''
    setOverrideInput(override || fallback)
  }, [selectedRecord, selectedSiteKey, urlOverrides])

  useEffect(() => {
    let cancelled = false
    if (!selectedRecord || !selectedSiteKey) {
      setPolicyText('')
      setPolicyError(null)
      return
    }

    const loadPolicyText = async () => {
      setPolicyLoading(true)
      setPolicyError(null)
      const res = await readArtifactText({
        outDir,
        relativePath: `artifacts/${selectedSiteKey}/policy.txt`,
      })
      if (cancelled) return
      if (res?.ok && typeof res.data === 'string') {
        setPolicyText(res.data)
      } else {
        setPolicyText('')
        setPolicyError(res?.error || 'policy_text_not_found')
      }
      setPolicyLoading(false)
    }

    loadPolicyText().catch((error) => {
      if (cancelled) return
      setPolicyLoading(false)
      setPolicyText('')
      setPolicyError(String(error))
    })

    return () => {
      cancelled = true
    }
  }, [outDir, selectedRecord, selectedSiteKey])

  const selectedThirdParties = selectedRecord?.third_parties || []
  const selectedStatus = selectedRecord?.status || 'unknown'
  const selectedPolicyUrl = selectedRecord?.first_party_policy?.url || ''
  const selectedPolicyMethod = selectedRecord?.first_party_policy?.extraction_method || 'unknown'

  const selectedActiveInfo = selectedSiteKey ? findActiveInfo(selectedSiteKey, activeSites) : null
  const selectedRerunBusy = !!selectedSiteKey && (busySite === selectedSiteKey || !!selectedActiveInfo)
  const selectedAnnotateBusy = !!selectedSiteKey && annotatingSite === selectedSiteKey

  const handleMarkVerified = async () => {
    if (!selectedSiteKey) return
    setActionError(null)
    setActionNote(null)
    await onMarkVerified(selectedSiteKey)
    setActionNote(`Marked ${selectedSiteKey} as verified.`)
  }

  const handleSaveOverride = async () => {
    if (!selectedSiteKey) return
    setActionError(null)
    setActionNote(null)
    await onSaveOverride(selectedSiteKey, overrideInput.trim())
    setActionNote('Override saved.')
  }

  const handleRerun = async () => {
    if (!selectedSiteKey) return
    setActionError(null)
    setActionNote(null)
    const result = await onRerun(selectedSiteKey, overrideInput.trim() || undefined)
    if (!result.ok) {
      setActionError(result.error || 'Failed to start rerun.')
      return
    }
    setActionNote(`Started targeted rerun for ${selectedSiteKey}.`)
  }

  const handleAnnotate = async () => {
    if (!selectedSiteKey) return
    setActionError(null)
    setActionNote(null)
    const result = await onAnnotate(selectedSiteKey)
    if (!result.ok) {
      setActionError(result.error || 'Failed to start annotation.')
      return
    }
    setActionNote(`Started annotation for ${selectedSiteKey}.`)
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <section className="card rounded-2xl p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Audit queue</p>
            <h2 className="text-base font-semibold">Ordered Site Registry</h2>
          </div>
          <button
            className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1 text-xs"
            onClick={() => { void onReload(); void refreshOkCount() }}
          >
            Refresh
          </button>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-[var(--muted-text)]">
          <span>Showing: {activeRecords.length} / Total: {orderedRecords.length}</span>
          {okSites.size > 0 && (
            <button
              onClick={() => setShowSuccessfulOnly((v) => !v)}
              title={showSuccessfulOnly
                ? 'Showing: English + third-party policy extracted. Click to show all.'
                : 'Click to show only: English policy + third-party policy extracted.'}
              className={[
                'focusable rounded-full border px-2 py-0.5 transition-colors',
                showSuccessfulOnly
                  ? 'border-emerald-500/60 bg-emerald-900/50 text-emerald-300'
                  : 'border-[var(--border-soft)] bg-black/20 text-[var(--muted-text)]',
              ].join(' ')}
            >
              {okSites.size} successful{showSuccessfulOnly ? ' ✓' : ''}
            </button>
          )}
        </div>
        <div className="max-h-[72vh] space-y-2 overflow-y-auto pr-1">
          {activeRecords.length === 0 && (
            <div className="rounded-xl border border-[var(--border-soft)] bg-black/20 p-3 text-sm text-[var(--muted-text)]">
              No active records. Verified sites are filtered out.
            </div>
          )}
          {activeRecords.map((record) => {
            const key = siteKey(record)
            const status = String(record.status || 'unknown')
            const tone = statusTone(status)
            const selected = key === selectedSite
            const rowActiveInfo = findActiveInfo(key, activeSites)
            const rowStepIndex = rowActiveInfo?.stepIndex ?? -1
            return (
              <button
                key={key}
                className={`w-full rounded-xl border px-3 py-2 text-left transition ${tone.row} ${
                  selected ? 'ring-1 ring-[var(--color-primary)]' : 'hover:border-[var(--color-primary)]'
                }`}
                onClick={() => setSelectedSite(key)}
              >
                <div className="flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${tone.dot}`} />
                  <p className="truncate text-sm font-semibold">{key}</p>
                </div>
                <p className="mt-1 text-xs text-[var(--muted-text)]">
                  Rank: {record.rank ?? '—'} · Status: {status}
                </p>
                {rowActiveInfo && (
                  <div className="mt-2 flex items-center gap-1">
                    {STAGE_STEPS.map((label, idx) => (
                      <span
                        key={label}
                        className={`inline-block h-1.5 w-1.5 rounded-full ${
                          idx < rowStepIndex
                            ? 'bg-[var(--color-primary)]'
                            : idx === rowStepIndex
                              ? 'animate-pulse bg-[var(--color-primary)]'
                              : 'bg-black/40'
                        }`}
                        title={label}
                      />
                    ))}
                    <span className="ml-1 text-[10px] text-[var(--color-primary)]">{rowActiveInfo.label}</span>
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </section>

      <section className="card rounded-2xl p-5">
        {!selectedRecord && (
          <div className="rounded-xl border border-[var(--border-soft)] bg-black/20 p-4 text-sm text-[var(--muted-text)]">
            Select a site to inspect metadata, policy text, and third-party entities.
          </div>
        )}

        {selectedRecord && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Detail pane</p>
                <h2 className="text-lg font-semibold">{selectedSiteKey}</h2>
                <p className="text-xs text-[var(--muted-text)]">
                  Rank {selectedRecord.rank ?? '—'} · Status {selectedStatus}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="focusable rounded-full border border-emerald-500/50 px-3 py-1.5 text-xs"
                  onClick={() => void handleMarkVerified()}
                >
                  Mark as Verified
                </button>
                <button
                  className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1.5 text-xs"
                  onClick={() => void onReload()}
                  disabled={running || selectedRerunBusy}
                >
                  Reload
                </button>
              </div>
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="space-y-3 rounded-xl border border-[var(--border-soft)] bg-black/20 p-3">
                <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Manual correction</p>
                <label className="block text-xs text-[var(--muted-text)]">Privacy policy URL override</label>
                <input
                  className="focusable w-full rounded-lg border border-[var(--border-soft)] bg-black/30 px-3 py-2 text-sm"
                  value={overrideInput}
                  onChange={(event) => setOverrideInput(event.target.value)}
                  placeholder="https://example.com/privacy"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1.5 text-xs"
                    onClick={() => void handleSaveOverride()}
                  >
                    Save override
                  </button>
                  <button
                    className="focusable rounded-full border border-[var(--color-danger)] px-3 py-1.5 text-xs text-white"
                    onClick={() => void handleRerun()}
                    disabled={running || selectedRerunBusy}
                  >
                    {selectedRerunBusy || running ? 'Rerun in progress...' : 'Rerun'}
                  </button>
                  <button
                    className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1.5 text-xs"
                    onClick={() => void handleAnnotate()}
                    disabled={selectedAnnotateBusy || running}
                  >
                    {selectedAnnotateBusy ? 'Annotating...' : 'Annotate'}
                  </button>
                </div>
                {actionError && <p className="text-xs text-red-300">{actionError}</p>}
                {actionNote && <p className="text-xs text-emerald-300">{actionNote}</p>}
                {selectedRerunBusy && (
                  <div className="rounded-lg border border-[var(--border-soft)] bg-black/30 p-2">
                    <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Rerun progress</p>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      {STAGE_STEPS.map((label, idx) => {
                        const stepIndex = selectedActiveInfo?.stepIndex ?? -1
                        return (
                          <span
                            key={label}
                            className={`inline-block h-2 w-2 rounded-full ${
                              idx < stepIndex
                                ? 'bg-[var(--color-primary)]'
                                : idx === stepIndex
                                  ? 'animate-pulse bg-[var(--color-primary)]'
                                  : 'bg-black/40'
                            }`}
                            title={label}
                          />
                        )
                      })}
                      <span className="ml-1 text-xs text-[var(--color-primary)]">
                        {selectedActiveInfo?.label || 'Queued'}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-2 rounded-xl border border-[var(--border-soft)] bg-black/20 p-3 text-sm">
                <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Extracted metadata</p>
                <p><span className="text-[var(--muted-text)]">Input:</span> {selectedRecord.input || '—'}</p>
                <p><span className="text-[var(--muted-text)]">Final URL:</span> {selectedRecord.final_url || '—'}</p>
                <p><span className="text-[var(--muted-text)]">Policy URL:</span> {selectedPolicyUrl || '—'}</p>
                <p><span className="text-[var(--muted-text)]">Extraction:</span> {selectedPolicyMethod}</p>
                <p><span className="text-[var(--muted-text)]">Policy text bytes:</span> {selectedRecord.first_party_policy?.text_len ?? '—'}</p>
                {selectedRecord.non_browsable_reason && (
                  <p><span className="text-[var(--muted-text)]">Non-browsable reason:</span> {selectedRecord.non_browsable_reason}</p>
                )}
                {selectedRecord.error_message && (
                  <p><span className="text-[var(--muted-text)]">Error:</span> {selectedRecord.error_message}</p>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-[var(--border-soft)] bg-black/20 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Policy text</p>
                {policyLoading && <span className="text-xs text-[var(--muted-text)]">Loading...</span>}
              </div>
              {policyError && !policyLoading && (
                <p className="mb-2 text-xs text-red-300">Unable to load policy text: {policyError}</p>
              )}
              <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--border-soft)] bg-black/30 p-3 text-xs leading-relaxed">
                {policyText || 'No policy text available for this record.'}
              </pre>
            </div>

            <div className="rounded-xl border border-[var(--border-soft)] bg-black/20 p-3">
              <p className="mb-2 text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">
                Third-party entities ({selectedThirdParties.length})
              </p>
              <div className="max-h-[26vh] space-y-2 overflow-y-auto pr-1">
                {selectedThirdParties.length === 0 && (
                  <p className="text-sm text-[var(--muted-text)]">No third-party trackers/entities found.</p>
                )}
                {selectedThirdParties.map((tp) => (
                  <div
                    key={tp.third_party_etld1 || `${tp.entity || 'unknown'}-${tp.policy_url || ''}`}
                    className="rounded-lg border border-[var(--border-soft)] bg-black/30 p-2 text-xs"
                  >
                    <p className="font-semibold">{tp.third_party_etld1 || 'unknown-domain'}</p>
                    <p className="text-[var(--muted-text)]">Entity: {tp.entity || '—'}</p>
                    <p className="text-[var(--muted-text)]">Policy: {tp.policy_url || '—'}</p>
                    <p className="text-[var(--muted-text)]">Categories: {(tp.categories || []).join(', ') || '—'}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
