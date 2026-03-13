import { useCallback, useEffect, useMemo, useState } from 'react'

import type { ActiveSiteInfo, ResultRecord } from '../../contracts/api'
import { readArtifactText } from '../../lib/artifactClient'
import { countOkArtifactSites } from '../../lib/scraperClient'
import { BentoCard } from '../ui/BentoCard'
import { PulseRing } from '../ui/PulseRing'
import { StatusPill } from '../ui/StatusPill'

type ActionResult = { ok: boolean; error?: string }

type AuditWorkspaceViewProps = {
  outDir: string
  records: ResultRecord[]
  verifiedSites: string[]
  urlOverrides: Record<string, string>
  bridgeReady?: boolean
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

function findActiveInfo(site: string, activeSites: Record<string, ActiveSiteInfo>): ActiveSiteInfo | null {
  if (!site) return null
  if (activeSites[site]) return activeSites[site]
  const normalized = normalizeSiteKey(site)
  for (const [key, value] of Object.entries(activeSites)) {
    if (normalizeSiteKey(key) === normalized) return value
  }
  return null
}

function statusVariant(status: string): 'ok' | 'warn' | 'error' | 'idle' {
  if (status === 'ok') return 'ok'
  if (status === 'policy_not_found') return 'warn'
  if (status === 'home_fetch_failed') return 'error'
  return 'idle'
}

function statusLabel(status: string): string {
  if (status === 'policy_not_found') return 'No policy'
  if (status === 'home_fetch_failed') return 'Fetch failed'
  if (status === 'non_browsable') return 'Non-browsable'
  if (status === 'ok') return 'OK'
  return status || 'unknown'
}

function accentClass(status: string): string {
  if (status === 'ok') return 'border-[rgba(57,255,20,0.22)] bg-[rgba(57,255,20,0.05)]'
  if (status === 'policy_not_found') return 'border-[rgba(255,209,102,0.26)] bg-[rgba(255,209,102,0.06)]'
  if (status === 'home_fetch_failed') return 'border-[rgba(255,45,149,0.24)] bg-[rgba(255,45,149,0.05)]'
  return 'border-[var(--border-soft)] bg-[rgba(255,255,255,0.02)]'
}

const STAGE_STEPS = ['Home fetch', 'Policy discovery', '3P extraction', '3P policies']

export function AuditWorkspaceView({
  outDir,
  records,
  verifiedSites,
  urlOverrides,
  bridgeReady = true,
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
    [verifiedSites],
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
      (record) => !verifiedSet.has(normalizeSiteKey(siteKey(record))),
    )
    if (showSuccessfulOnly && okSites.size > 0) {
      filtered = filtered.filter((record) => okSites.has(siteKey(record)))
    }
    return filtered
  }, [okSites, orderedRecords, showSuccessfulOnly, verifiedSet])

  const selectedRecord = useMemo(
    () => activeRecords.find((record) => siteKey(record) === selectedSite) || null,
    [activeRecords, selectedSite],
  )

  const selectedSiteKey = selectedRecord ? siteKey(selectedRecord) : ''
  const verifiedCount = orderedRecords.length - activeRecords.length
  const selectedStatus = selectedRecord?.status || 'unknown'
  const selectedStatusVariant = statusVariant(String(selectedStatus))
  const selectedPolicyUrl = selectedRecord?.first_party_policy?.url || ''
  const selectedPolicyMethod = selectedRecord?.first_party_policy?.extraction_method || 'unknown'
  const selectedThirdParties = selectedRecord?.third_parties || []

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

    void loadPolicyText().catch((error) => {
      if (cancelled) return
      setPolicyLoading(false)
      setPolicyText('')
      setPolicyError(String(error))
    })

    return () => {
      cancelled = true
    }
  }, [outDir, selectedRecord, selectedSiteKey])

  const selectedActiveInfo = selectedSiteKey ? findActiveInfo(selectedSiteKey, activeSites) : null
  const selectedRerunBusy = !!selectedSiteKey && (busySite === selectedSiteKey || !!selectedActiveInfo)
  const selectedAnnotateBusy = !!selectedSiteKey && annotatingSite === selectedSiteKey
  const actionsDisabled = !bridgeReady || running

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
    <div className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
      <BentoCard className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Audit queue</p>
            <h2 className="text-sm font-semibold">Review backlog</h2>
            <p className="mt-1 text-[12px] text-[var(--muted-text)]">
              Prioritized sites waiting for verification or correction.
            </p>
          </div>
          <button
            className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1.5 text-[11px] text-[var(--muted-text)] transition-colors hover:border-[var(--glass-border)] hover:text-[var(--color-text)]"
            onClick={() => {
              void onReload()
              void refreshOkCount()
            }}
          >
            Refresh
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-[var(--border-soft)] bg-black/15 px-3 py-2">
            <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Remaining</p>
            <p className="mt-1 text-lg font-semibold">{activeRecords.length}</p>
          </div>
          <div className="rounded-xl border border-[var(--border-soft)] bg-black/15 px-3 py-2">
            <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Verified</p>
            <p className="mt-1 text-lg font-semibold">{verifiedCount}</p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="rounded-full border border-[var(--border-soft)] px-2.5 py-1 text-[var(--muted-text)]">
            {orderedRecords.length} total
          </span>
          <button
            onClick={() => setShowSuccessfulOnly((value) => !value)}
            className={`focusable rounded-full border px-2.5 py-1 transition-colors ${
              showSuccessfulOnly
                ? 'border-[rgba(57,255,20,0.3)] bg-[rgba(57,255,20,0.08)] text-[var(--color-success)]'
                : 'border-[var(--border-soft)] text-[var(--muted-text)] hover:border-[var(--glass-border)]'
            }`}
          >
            {okSites.size} successful{showSuccessfulOnly ? ' shown' : ''}
          </button>
        </div>

        <div className="mt-4 max-h-[72vh] space-y-2 overflow-y-auto pr-1">
          {activeRecords.length === 0 && (
            <div className="rounded-xl border border-[var(--border-soft)] bg-black/10 px-3 py-4 text-sm text-[var(--muted-text)]">
              No active records. Verified sites are currently filtered out.
            </div>
          )}
          {activeRecords.map((record) => {
            const key = siteKey(record)
            const status = String(record.status || 'unknown')
            const selected = key === selectedSite
            const rowActiveInfo = findActiveInfo(key, activeSites)
            const rowStepIndex = rowActiveInfo?.stepIndex ?? -1
            return (
              <button
                key={key}
                className={`w-full rounded-2xl border p-3 text-left transition-all ${accentClass(status)} ${
                  selected
                    ? 'shadow-[var(--glow-xs)] ring-1 ring-[var(--glass-border)]'
                    : 'hover:border-[var(--glass-border)] hover:bg-[rgba(255,255,255,0.03)]'
                }`}
                onClick={() => setSelectedSite(key)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      {rowActiveInfo ? <PulseRing status="online" size={8} /> : <span className="h-2 w-2 rounded-full bg-[var(--border-soft)]" />}
                      <p className="truncate text-sm font-semibold">{key}</p>
                    </div>
                    <p className="mt-1 text-[11px] text-[var(--muted-text)]">
                      Rank {record.rank ?? '—'} · {statusLabel(status)}
                    </p>
                  </div>
                  <StatusPill variant={statusVariant(status)} label={statusLabel(status)} pulse={Boolean(rowActiveInfo)} />
                </div>
                {rowActiveInfo && (
                  <div className="mt-3 rounded-xl border border-[rgba(0,230,255,0.18)] bg-[rgba(0,230,255,0.05)] px-2.5 py-2">
                    <div className="flex items-center gap-1.5">
                      {STAGE_STEPS.map((label, idx) => (
                        <span
                          key={label}
                          title={label}
                          className={`inline-block h-2 w-2 rounded-full ${
                            idx < rowStepIndex
                              ? 'bg-[var(--color-primary)]'
                              : idx === rowStepIndex
                                ? 'animate-pulse bg-[var(--color-primary)]'
                                : 'bg-black/35'
                          }`}
                        />
                      ))}
                      <span className="ml-1 text-[11px] text-[var(--color-primary)]">{rowActiveInfo.label}</span>
                    </div>
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </BentoCard>

      {!selectedRecord && (
        <BentoCard className="flex min-h-[420px] items-center justify-center p-6 text-center">
          <div className="max-w-sm">
            <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Detail board</p>
            <h2 className="mt-2 text-lg font-semibold">Select a site to review</h2>
            <p className="mt-2 text-sm text-[var(--muted-text)]">
              The audit board will show extracted metadata, policy text, third-party entities, and recovery actions.
            </p>
          </div>
        </BentoCard>
      )}

      {selectedRecord && (
        <div className="flex flex-col gap-5">
          <BentoCard className="p-5" glow>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Evidence board</p>
                <h2 className="text-lg font-semibold">{selectedSiteKey}</h2>
                <p className="mt-1 text-[12px] text-[var(--muted-text)]">
                  Rank {selectedRecord.rank ?? '—'} · Review the extracted evidence before rerunning or verifying.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill variant={selectedStatusVariant} label={statusLabel(String(selectedStatus))} pulse={selectedRerunBusy} />
                {selectedPolicyUrl && (
                  <span className="rounded-full border border-[var(--border-soft)] px-2.5 py-1 text-[11px] text-[var(--muted-text)]">
                    policy captured
                  </span>
                )}
                {selectedRerunBusy && <StatusPill variant="running" label={selectedActiveInfo?.label || 'rerun active'} pulse />}
              </div>
            </div>
          </BentoCard>

          <div className="grid gap-5 xl:grid-cols-[1.05fr_0.95fr]">
            <BentoCard className="p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Action strip</p>
                  <h3 className="text-sm font-semibold">Correction workflow</h3>
                </div>
                <button
                  className="focusable rounded-full border border-[rgba(57,255,20,0.3)] px-3 py-1.5 text-[11px] text-[var(--color-success)] transition-colors hover:bg-[rgba(57,255,20,0.08)]"
                  onClick={() => void handleMarkVerified()}
                  disabled={actionsDisabled}
                >
                  Mark verified
                </button>
              </div>

              <label className="mt-4 block text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">
                Policy URL override
              </label>
              <input
                className="focusable mt-2 w-full rounded-xl border border-[var(--border-soft)] bg-black/20 px-3 py-2 text-sm text-[var(--color-text)]"
                value={overrideInput}
                onChange={(event) => setOverrideInput(event.target.value)}
                placeholder="https://example.com/privacy"
                disabled={!bridgeReady}
              />

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1.5 text-[11px] text-[var(--muted-text)] transition-colors hover:border-[var(--glass-border)] hover:text-[var(--color-text)]"
                  onClick={() => void handleSaveOverride()}
                  disabled={!bridgeReady}
                >
                  Save override
                </button>
                <button
                  className="focusable rounded-full border border-[rgba(255,209,102,0.3)] px-3 py-1.5 text-[11px] text-[var(--color-warn)] transition-colors hover:bg-[rgba(255,209,102,0.08)] disabled:opacity-50"
                  onClick={() => void handleRerun()}
                  disabled={actionsDisabled || selectedRerunBusy}
                >
                  {selectedRerunBusy || running ? 'Rerun active…' : !bridgeReady ? 'Bridge offline' : 'Rerun site'}
                </button>
                <button
                  className="focusable rounded-full border border-[var(--glass-border)] px-3 py-1.5 text-[11px] text-[var(--color-primary)] transition-colors hover:bg-[rgba(0,230,255,0.08)] disabled:opacity-50"
                  onClick={() => void handleAnnotate()}
                  disabled={actionsDisabled || selectedAnnotateBusy}
                >
                  {selectedAnnotateBusy ? 'Annotating…' : !bridgeReady ? 'Bridge offline' : 'Annotate'}
                </button>
                <button
                  className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1.5 text-[11px] text-[var(--muted-text)] transition-colors hover:border-[var(--glass-border)] hover:text-[var(--color-text)]"
                  onClick={() => void onReload()}
                  disabled={actionsDisabled || selectedRerunBusy}
                >
                  Reload
                </button>
              </div>

              {!bridgeReady && (
                <p className="mt-3 text-[11px] text-[var(--color-warn)]">
                  Bridge unavailable. Loaded audit data remains visible, but remote actions are paused until the orchestrator answers on /health.
                </p>
              )}

              {selectedRerunBusy && (
                <div className="mt-4 rounded-xl border border-[rgba(0,230,255,0.18)] bg-[rgba(0,230,255,0.05)] px-3 py-3">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--muted-text)]">Rerun progress</p>
                  <div className="mt-2 flex items-center gap-1.5">
                    {STAGE_STEPS.map((label, idx) => {
                      const stepIndex = selectedActiveInfo?.stepIndex ?? -1
                      return (
                        <span
                          key={label}
                          title={label}
                          className={`inline-block h-2 w-2 rounded-full ${
                            idx < stepIndex
                              ? 'bg-[var(--color-primary)]'
                              : idx === stepIndex
                                ? 'animate-pulse bg-[var(--color-primary)]'
                                : 'bg-black/35'
                          }`}
                        />
                      )
                    })}
                    <span className="ml-1 text-[11px] text-[var(--color-primary)]">
                      {selectedActiveInfo?.label || 'Queued'}
                    </span>
                  </div>
                </div>
              )}

              {actionError && (
                <div className="mt-4 rounded-xl border border-[rgba(255,45,149,0.28)] bg-[rgba(255,45,149,0.06)] px-3 py-2 text-[12px] text-[var(--color-danger)]">
                  {actionError}
                </div>
              )}
              {actionNote && (
                <div className="mt-4 rounded-xl border border-[rgba(57,255,20,0.24)] bg-[rgba(57,255,20,0.05)] px-3 py-2 text-[12px] text-[var(--color-success)]">
                  {actionNote}
                </div>
              )}
            </BentoCard>

            <BentoCard className="p-5">
              <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Extracted metadata</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {[
                  ['Input URL', selectedRecord.input || '—'],
                  ['Final URL', selectedRecord.final_url || '—'],
                  ['Policy URL', selectedPolicyUrl || '—'],
                  ['Extraction', selectedPolicyMethod],
                  ['Policy bytes', String(selectedRecord.first_party_policy?.text_len ?? '—')],
                  ['Third parties', String(selectedThirdParties.length)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl border border-[var(--border-soft)] bg-black/10 px-3 py-2.5">
                    <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-text)]">{label}</p>
                    <p className="mt-1 text-[12px] text-[var(--color-text)] break-all">{value}</p>
                  </div>
                ))}
              </div>
              {(selectedRecord.non_browsable_reason || selectedRecord.error_message) && (
                <div className="mt-4 space-y-2">
                  {selectedRecord.non_browsable_reason && (
                    <div className="rounded-xl border border-[rgba(255,209,102,0.28)] bg-[rgba(255,209,102,0.06)] px-3 py-2 text-[12px] text-[var(--color-warn)]">
                      Non-browsable reason: {selectedRecord.non_browsable_reason}
                    </div>
                  )}
                  {selectedRecord.error_message && (
                    <div className="rounded-xl border border-[rgba(255,45,149,0.28)] bg-[rgba(255,45,149,0.06)] px-3 py-2 text-[12px] text-[var(--color-danger)]">
                      Error: {selectedRecord.error_message}
                    </div>
                  )}
                </div>
              )}
            </BentoCard>
          </div>

          <BentoCard className="p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Evidence text</p>
                <h3 className="text-sm font-semibold">Policy capture</h3>
              </div>
              {policyLoading && <span className="text-[11px] text-[var(--muted-text)]">Loading…</span>}
            </div>
            {policyError && !policyLoading && (
              <div className="mb-3 rounded-xl border border-[rgba(255,45,149,0.28)] bg-[rgba(255,45,149,0.06)] px-3 py-2 text-[12px] text-[var(--color-danger)]">
                Unable to load policy text: {policyError}
              </div>
            )}
            <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap rounded-2xl border border-[var(--border-soft)] bg-black/20 p-4 text-[12px] leading-relaxed text-[var(--color-text)]">
              {policyText || 'No policy text available for this record.'}
            </pre>
          </BentoCard>

          <BentoCard className="p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Third-party board</p>
                <h3 className="text-sm font-semibold">Entities and policy links</h3>
              </div>
              <span className="rounded-full border border-[var(--border-soft)] px-2.5 py-1 text-[11px] text-[var(--muted-text)]">
                {selectedThirdParties.length} entities
              </span>
            </div>
            <div className="max-h-[30vh] space-y-2 overflow-y-auto pr-1">
              {selectedThirdParties.length === 0 && (
                <div className="rounded-xl border border-[var(--border-soft)] bg-black/10 px-3 py-4 text-sm text-[var(--muted-text)]">
                  No third-party trackers or entities were extracted for this site.
                </div>
              )}
              {selectedThirdParties.map((tp) => (
                <div
                  key={tp.third_party_etld1 || `${tp.entity || 'unknown'}-${tp.policy_url || ''}`}
                  className="rounded-2xl border border-[var(--border-soft)] bg-black/10 p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[var(--color-text)]">{tp.third_party_etld1 || 'unknown-domain'}</p>
                      <p className="mt-1 text-[12px] text-[var(--muted-text)]">{tp.entity || 'Unknown entity'}</p>
                    </div>
                    <StatusPill
                      variant={tp.policy_url ? 'ok' : 'warn'}
                      label={tp.policy_url ? 'policy linked' : 'no policy'}
                    />
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <div className="rounded-xl border border-[var(--border-soft)] bg-black/10 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Policy URL</p>
                      <p className="mt-1 break-all text-[12px] text-[var(--color-text)]">{tp.policy_url || '—'}</p>
                    </div>
                    <div className="rounded-xl border border-[var(--border-soft)] bg-black/10 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-text)]">Categories</p>
                      <p className="mt-1 text-[12px] text-[var(--color-text)]">{(tp.categories || []).join(', ') || '—'}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </BentoCard>
        </div>
      )}
    </div>
  )
}
