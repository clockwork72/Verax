import { useEffect, useMemo, useRef, useState } from 'react'
import { ExplorerSite, ExplorerThirdParty } from '../../data/explorer'
import { readPolicyTextWithMethod } from '../../lib/artifactClient'
import type { ReasoningSelection } from '../reasoning/ReasoningView'

type ConsistencyCheckerViewProps = {
  hasRun: boolean
  sites?: ExplorerSite[]
  outDir: string
  showExtractionMethod?: boolean
  onSendToReasoning?: (selection: ReasoningSelection) => void
}

function safeDirname(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200)
}

function formatExtractionMethod(value?: string | null) {
  if (!value) return 'Unknown'
  return value === 'trafilatura' ? 'Trafilatura' : 'Fallback'
}

export function ConsistencyCheckerView({
  hasRun,
  sites,
  outDir,
  showExtractionMethod = true,
  onSendToReasoning,
}: ConsistencyCheckerViewProps) {
  const [selectedSiteId, setSelectedSiteId] = useState('')
  const [selectedThirdParty, setSelectedThirdParty] = useState('')
  const [sitePolicyText, setSitePolicyText] = useState('')
  const [thirdPartyPolicyText, setThirdPartyPolicyText] = useState('')
  const [sitePolicyMethod, setSitePolicyMethod] = useState<string | null>(null)
  const [thirdPartyPolicyMethod, setThirdPartyPolicyMethod] = useState<string | null>(null)
  const [thirdPartyOptions, setThirdPartyOptions] = useState<ExplorerThirdParty[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [wrapText, setWrapText] = useState(true)
  const [fontSize, setFontSize] = useState<'sm' | 'md' | 'lg'>('sm')
  const lastLoadRef = useRef('')
  const storageKey = `consistency_state:${outDir}`

  const eligibleSites = useMemo(() => {
    const source = sites ?? []
    return source.filter((site) => site.status === 'ok' && Boolean(site.policyUrl))
  }, [sites])

  const selectedSite = useMemo(
    () => eligibleSites.find((site) => site.site === selectedSiteId) || null,
    [eligibleSites, selectedSiteId],
  )

  useEffect(() => {
    const raw = sessionStorage.getItem(storageKey)
    if (!raw) return
    try {
      const parsed = JSON.parse(raw)
      if (parsed.selectedSiteId) setSelectedSiteId(parsed.selectedSiteId)
      if (parsed.selectedThirdParty) setSelectedThirdParty(parsed.selectedThirdParty)
      if (parsed.searchTerm) setSearchTerm(parsed.searchTerm)
      if (typeof parsed.wrapText === 'boolean') setWrapText(parsed.wrapText)
      if (parsed.fontSize) setFontSize(parsed.fontSize)
    } catch {
      sessionStorage.removeItem(storageKey)
    }
  }, [storageKey])

  useEffect(() => {
    const payload = {
      selectedSiteId,
      selectedThirdParty,
      searchTerm,
      wrapText,
      fontSize,
    }
    sessionStorage.setItem(storageKey, JSON.stringify(payload))
  }, [
    storageKey,
    selectedSiteId,
    selectedThirdParty,
    searchTerm,
    wrapText,
    fontSize,
  ])

  useEffect(() => {
    if (!selectedSiteId) {
      setSitePolicyText('')
      setThirdPartyPolicyText('')
      setSitePolicyMethod(null)
      setThirdPartyPolicyMethod(null)
      setThirdPartyOptions([])
      setSelectedThirdParty('')
      lastLoadRef.current = ''
      return
    }
    const loadKey = `${outDir}:${selectedSiteId}`
    if (lastLoadRef.current === loadKey) return
    lastLoadRef.current = loadKey
    const site = eligibleSites.find((entry) => entry.site === selectedSiteId)
    if (!site) return

    const loadPolicies = async () => {
      setLoading(true)
      setError(null)
      setThirdPartyOptions([])
      setThirdPartyPolicyText('')
      setThirdPartyPolicyMethod(null)

      const siteFolder = safeDirname(site.site)
      const sitePolicy = await readPolicyTextWithMethod({
        outDir,
        basePath: `artifacts/${siteFolder}`,
      })
      if (!sitePolicy.policyText) {
        setSitePolicyText('')
        setError('First‑party policy text not found for this site.')
        setSitePolicyMethod(null)
      } else {
        setSitePolicyText(sitePolicy.policyText)
        setSitePolicyMethod(sitePolicy.method)
      }

      const thirdParties: ExplorerThirdParty[] = site.thirdParties ?? []
      const available = thirdParties.filter((tp) => Boolean(tp.policyUrl))
      setThirdPartyOptions(available)
      if (!available.some((tp) => tp.name === selectedThirdParty)) {
        setSelectedThirdParty(available[0]?.name || '')
      }
      setLoading(false)
    }

    void loadPolicies()
  }, [selectedSiteId, outDir, eligibleSites, selectedThirdParty])

  useEffect(() => {
    if (!selectedThirdParty) {
      setThirdPartyPolicyText('')
      setThirdPartyPolicyMethod(null)
      return
    }
    if (!selectedSite) return

    const loadThirdPartyPolicy = async () => {
      setLoading(true)
      const siteFolder = safeDirname(selectedSite.site)
      const tpFolder = safeDirname(selectedThirdParty)
      const policy = await readPolicyTextWithMethod({
        outDir,
        basePath: `artifacts/${siteFolder}/third_party/${tpFolder}`,
      })
      setThirdPartyPolicyText(policy.policyText)
      setThirdPartyPolicyMethod(policy.method)
      setLoading(false)
    }

    void loadThirdPartyPolicy()
  }, [selectedThirdParty, selectedSite, outDir])

  const fontSizeClass = fontSize === 'lg' ? 'text-[13px]' : fontSize === 'md' ? 'text-[12px]' : 'text-[11px]'
  const wrapClass = wrapText ? 'whitespace-pre-wrap' : 'whitespace-pre'

  const highlight = (text: string) => {
    const query = searchTerm.trim()
    if (!query) return text
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`(${escaped})`, 'gi')
    const lower = query.toLowerCase()
    return text.split(regex).map((part, index) =>
      part.toLowerCase() === lower ? (
        <mark key={`${part}-${index}`} className="rounded bg-[var(--color-warn)]/30 px-1 text-[var(--color-text)]">
          {part}
        </mark>
      ) : (
        <span key={`${part}-${index}`}>{part}</span>
      ),
    )
  }

  const countMatches = (text: string) => {
    const query = searchTerm.trim()
    if (!query) return 0
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(escaped, 'gi')
    return (text.match(regex) || []).length
  }

  const siteWordCount = sitePolicyText ? sitePolicyText.trim().split(/\s+/).length : 0
  const thirdPartyWordCount = thirdPartyPolicyText ? thirdPartyPolicyText.trim().split(/\s+/).length : 0
  const selectedSiteMethod = sitePolicyMethod ?? selectedSite?.extractionMethod ?? null
  const selectedThirdPartyOption = thirdPartyOptions.find((tp) => tp.name === selectedThirdParty) || null
  const selectedThirdPartyMethod =
    thirdPartyPolicyMethod ??
    selectedThirdPartyOption?.extractionMethod ??
    null

  const canSendToReasoning = Boolean(
    selectedSite?.site &&
      selectedThirdParty &&
      sitePolicyText.trim() &&
      thirdPartyPolicyText.trim() &&
      onSendToReasoning,
  )

  const handleSendToReasoning = () => {
    if (!onSendToReasoning || !canSendToReasoning || !selectedSite) return
    onSendToReasoning({
      firstPartySite: selectedSite.site,
      thirdPartyName: selectedThirdParty,
      firstPartyText: sitePolicyText,
      thirdPartyText: thirdPartyPolicyText,
      firstPartyExtractionMethod: selectedSiteMethod,
      thirdPartyExtractionMethod: selectedThirdPartyMethod,
    })
  }

  if (!hasRun) {
    return (
      <section className="card rounded-2xl p-6">
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">No results</p>
        <h2 className="text-lg font-semibold">Consistency checker is empty</h2>
        <p className="mt-2 text-sm text-[var(--muted-text)]">
          Run the scraper first to generate privacy policy texts.
        </p>
      </section>
    )
  }

  return (
    <>
      <section className="card rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Consistency checker</p>
            <h2 className="text-lg font-semibold">Policy text comparison</h2>
            <p className="text-xs text-[var(--muted-text)]">
              Select a site and a third‑party with a scraped policy to compare side‑by‑side.
            </p>
          </div>
          {loading && <span className="text-xs text-[var(--muted-text)]">Loading policies…</span>}
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[1.1fr_1.2fr]">
          <div className="flex flex-col gap-2">
            <label className="text-xs text-[var(--muted-text)]">First‑party site</label>
            <select
              className="focusable rounded-xl border border-[var(--border-soft)] bg-black/20 px-3 py-2 text-sm text-white"
              value={selectedSiteId}
              onChange={(event) => setSelectedSiteId(event.target.value)}
            >
              <option value="">Select a site</option>
              {eligibleSites.map((site) => (
                <option key={site.site} value={site.site}>
                  {site.site} {site.rank ? `• Rank ${site.rank}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-xs text-[var(--muted-text)]">Third‑party service</label>
            <select
              className="focusable rounded-xl border border-[var(--border-soft)] bg-black/20 px-3 py-2 text-sm text-white"
              value={selectedThirdParty}
              onChange={(event) => setSelectedThirdParty(event.target.value)}
              disabled={!selectedSiteId || thirdPartyOptions.length === 0}
            >
              <option value="">{selectedSiteId ? 'Select a third‑party' : 'Select a site first'}</option>
              {thirdPartyOptions.map((tp) => (
                <option key={tp.name} value={tp.name}>
                  {tp.name} {tp.entity ? `• ${tp.entity}` : ''}
                </option>
              ))}
            </select>
            {selectedSiteId && thirdPartyOptions.length === 0 && !loading && (
              <span className="text-xs text-[var(--muted-text)]">No third‑party policy texts found for this site.</span>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-[var(--muted-text)]">
          <button
            className={`focusable rounded-full border px-3 py-1 ${
              canSendToReasoning
                ? 'border-[var(--color-danger)] text-white'
                : 'border-[var(--border-soft)] text-[var(--muted-text)]'
            }`}
            disabled={!canSendToReasoning}
            onClick={handleSendToReasoning}
          >
            Send pair to Reasoning
          </button>
          <div className="flex items-center gap-2">
            <span>Find</span>
            <input
              className="focusable w-56 rounded-full border border-[var(--border-soft)] bg-black/20 px-3 py-1 text-xs text-white"
              placeholder="Search in both policies"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <span>Wrap</span>
            <button
              className={`focusable rounded-full border px-3 py-1 ${
                wrapText ? 'border-[var(--color-danger)] text-white' : 'border-[var(--border-soft)] text-[var(--muted-text)]'
              }`}
              onClick={() => setWrapText((prev) => !prev)}
            >
              {wrapText ? 'On' : 'Off'}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span>Size</span>
            {(['sm', 'md', 'lg'] as const).map((size) => (
              <button
                key={size}
                className={`focusable rounded-full border px-3 py-1 ${
                  fontSize === size
                    ? 'border-[var(--color-danger)] text-white'
                    : 'border-[var(--border-soft)] text-[var(--muted-text)]'
                }`}
                onClick={() => setFontSize(size)}
              >
                {size.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-[var(--color-warn)] bg-black/20 px-3 py-2 text-xs text-[var(--color-warn)]">
            {error}
          </div>
        )}
      </section>

      <section className="card rounded-2xl p-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-[var(--border-soft)] bg-black/20 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">First‑party policy</p>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--muted-text)]">
              <span>{selectedSite?.site || '—'}</span>
              <span>{siteWordCount.toLocaleString()} words • {countMatches(sitePolicyText)} matches</span>
            </div>
            {showExtractionMethod && (
              <div className="mt-1 text-xs text-[var(--muted-text)]">
                Extraction: {formatExtractionMethod(selectedSiteMethod)}
              </div>
            )}
            <div className={`consistency-text mt-3 max-h-[480px] overflow-y-auto rounded-xl border border-[var(--border-soft)] bg-black/30 p-3 ${fontSizeClass} leading-relaxed text-[var(--muted-text)]`}>
              <div className="flex justify-end">
                <button
                  className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1 text-[10px]"
                  onClick={() => navigator.clipboard.writeText(sitePolicyText)}
                  disabled={!sitePolicyText}
                >
                  Copy text
                </button>
              </div>
              <pre className={`mono ${wrapClass}`}>{sitePolicyText ? highlight(sitePolicyText) : 'Select a site to load the policy text.'}</pre>
            </div>
          </div>
          <div className="rounded-2xl border border-[var(--border-soft)] bg-black/20 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted-text)]">Third‑party policy</p>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--muted-text)]">
              <span>{selectedThirdParty || '—'}</span>
              <span>{thirdPartyWordCount.toLocaleString()} words • {countMatches(thirdPartyPolicyText)} matches</span>
            </div>
            {showExtractionMethod && (
              <div className="mt-1 text-xs text-[var(--muted-text)]">
                Extraction: {formatExtractionMethod(selectedThirdPartyMethod)}
              </div>
            )}
            <div className={`consistency-text mt-3 max-h-[480px] overflow-y-auto rounded-xl border border-[var(--border-soft)] bg-black/30 p-3 ${fontSizeClass} leading-relaxed text-[var(--muted-text)]`}>
              <div className="flex justify-end">
                <button
                  className="focusable rounded-full border border-[var(--border-soft)] px-3 py-1 text-[10px]"
                  onClick={() => navigator.clipboard.writeText(thirdPartyPolicyText)}
                  disabled={!thirdPartyPolicyText}
                >
                  Copy text
                </button>
              </div>
              <pre className={`mono ${wrapClass}`}>
                {thirdPartyPolicyText ? highlight(thirdPartyPolicyText) : 'Select a third‑party policy to load the text.'}
              </pre>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}
