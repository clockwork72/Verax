import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Sidebar } from './components/layout/Sidebar'
import { PageShell } from './components/layout/PageShell'
import { LauncherView } from './components/launcher/LauncherView'
import { ResultsView } from './components/results/ResultsView'
import { ExplorerView } from './components/explorer/ExplorerView'
import { AnnotationsView } from './components/annotations/AnnotationsView'
import { PolicyViewerView } from './components/annotations/PolicyViewerView'
import { ConsistencyCheckerView } from './components/consistency/ConsistencyCheckerView'
import { DatabaseView } from './components/database/DatabaseView'
import { SettingsView } from './components/settings/SettingsView'
import { NavId, Theme } from './types'
import { computeResults } from './utils/results'

const MODEL_COST_RATES: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini':    { input: 0.15,  output: 0.60  },
  'gpt-4o':         { input: 2.50,  output: 10.00 },
  'gpt-4-turbo':    { input: 10.00, output: 30.00  },
  'gpt-3.5-turbo':  { input: 0.50,  output: 1.50  },
}

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

function App() {
  const [theme, setTheme] = useState<Theme>('academia')
  const [showExtractionMethod, setShowExtractionMethod] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem('settings.showExtractionMethod')
      if (raw === null) return true
      return raw !== 'false'
    } catch {
      return true
    }
  })
  const [activeNav, setActiveNav] = useState<NavId>('launcher')
  const [topN, setTopN] = useState('1000')
  const [hasRun, setHasRun] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [logs, setLogs] = useState<string[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [summaryData, setSummaryData] = useState<any | null>(null)
  const [explorerData, setExplorerData] = useState<any[] | null>(null)
  const [stateData, setStateData] = useState<any | null>(null)
  const [clearing, setClearing] = useState(false)
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null)
  const [etaText, setEtaText] = useState<string>('')
  const [useCrux, setUseCrux] = useState(true)
  const [cruxApiKey, setCruxApiKey] = useState('')
  const [excludeSameEntity, setExcludeSameEntity] = useState(true)
  const [mappingMode, setMappingMode] = useState<'radar' | 'trackerdb' | 'mixed'>('mixed')
  const [outDir, setOutDir] = useState('outputs')
  const [runsRoot] = useState('outputs')
  const [resumeMode, setResumeMode] = useState(false)
  const [runRecords, setRunRecords] = useState<any[]>([])
  const [folderBytes, setFolderBytes] = useState<number | null>(null)
  // Stage 2 — Annotation state
  const [openaiApiKey, setOpenaiApiKey] = useState('')
  const [llmModel, setLlmModel] = useState('gpt-4o-mini')
  const [annotateRunning, setAnnotateRunning] = useState(false)
  const [annotateLogs, setAnnotateLogs] = useState<string[]>([])
  const [annotationStats, setAnnotationStats] = useState<any>(null)
  const [autoAnnotate, setAutoAnnotate] = useState(true)
  const [annotationsTab, setAnnotationsTab] = useState<'overview' | 'viewer'>('overview')
  const [totalCost, setTotalCost] = useState<number>(() => {
    try {
      const raw = localStorage.getItem('privacy-dashboard.totalCost')
      return raw ? parseFloat(raw) : 0
    } catch { return 0 }
  })
  const annotateLogsRef = useRef<string[]>([])
  const llmModelRef = useRef(llmModel)

  const addToCost = useCallback((amount: number) => {
    setTotalCost((prev) => {
      const next = prev + amount
      try { localStorage.setItem('privacy-dashboard.totalCost', String(next)) } catch {}
      return next
    })
  }, [])

  const resetCost = useCallback(() => {
    setTotalCost(0)
    try { localStorage.removeItem('privacy-dashboard.totalCost') } catch {}
  }, [])

  type ActiveSiteInfo = { label: string; stepIndex: number; rank: number }
  type CompletedSiteInfo = { site: string; status: string; cached: boolean; annotated?: boolean }
  const [activeSites, setActiveSites] = useState<Record<string, ActiveSiteInfo>>({})
  const [recentCompleted, setRecentCompleted] = useState<CompletedSiteInfo[]>([])

  const SITE_STAGE_LABELS: Record<string, { label: string; index: number }> = {
    home_fetch:               { label: 'Home fetch',       index: 0 },
    policy_discovery:         { label: 'Policy discovery', index: 1 },
    third_party_extract:      { label: '3P extraction',    index: 2 },
    third_party_policy_fetch: { label: '3P policies',      index: 3 },
  }

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    try {
      localStorage.setItem('settings.showExtractionMethod', String(showExtractionMethod))
    } catch {
      // ignore storage failures
    }
  }, [showExtractionMethod])

  const resultsMetrics = useMemo(() => computeResults(hasRun, progress), [hasRun, progress])
  useEffect(() => {
    if (!window.scraper) return
    const scraper = window.scraper
    scraper.onEvent((event) => {
      if (event?.type === 'run_started') {
        setHasRun(true)
        setRunning(true)
        setProgress(0)
        setErrorMessage(null)
        setRunStartedAt(Date.now())
        setEtaText('')
        setActiveSites({})
        setRecentCompleted([])
      }
      if (event?.type === 'run_progress') {
        const processed = Number(event.processed || 0)
        const total = Number(event.total || 0)
        if (total > 0) {
          setProgress(Math.min(100, (processed / total) * 100))
        }
      }
      if (event?.type === 'site_started' && event.site) {
        setActiveSites((prev) => ({
          ...prev,
          [event.site]: { label: 'Home fetch', stepIndex: 0, rank: event.rank ?? 0 },
        }))
        setLogs((prev) => [...prev, `Processing ${event.site}`].slice(-50))
      }
      if (event?.type === 'site_stage' && event.site) {
        const stageInfo = SITE_STAGE_LABELS[event.stage]
        if (stageInfo) {
          setActiveSites((prev) => ({
            ...prev,
            [event.site]: { ...(prev[event.site] ?? { rank: event.rank ?? 0 }), label: stageInfo.label, stepIndex: stageInfo.index },
          }))
        }
      }
      if (event?.type === 'site_finished' && event.site) {
        setActiveSites((prev) => {
          const next = { ...prev }
          delete next[event.site]
          return next
        })
        setRecentCompleted((prev) => [
          { site: event.site, status: event.status || 'ok', cached: !!event.cached, annotated: !!event.annotated },
          ...prev.slice(0, 14),
        ])
        setLogs((prev) => [...prev, `Finished ${event.site} (${event.status})`].slice(-50))
      }
      if (event?.type === 'run_completed') {
        setRunning(false)
        setProgress(100)
        setEtaText('0s')
        setActiveSites({})
        refreshRuns()
      }
    })
    scraper.onLog((evt) => {
      if (evt?.message) {
        setLogs((prev) => [...prev, evt.message].slice(-50))
      }
    })
    scraper.onError((evt) => {
      if (evt?.message) {
        setErrorMessage(String(evt.message))
        setLogs((prev) => [...prev, `ERROR: ${evt.message}`].slice(-50))
      }
      setRunning(false)
    })
    scraper.onExit((evt) => {
      if (evt?.code && Number(evt.code) !== 0) {
        setErrorMessage(`Scraper exited with code ${evt.code}`)
      }
      setRunning(false)
    })

    if (scraper.onAnnotatorLog) {
      scraper.onAnnotatorLog((evt) => {
        const raw = evt?.message ? String(evt.message).trimEnd() : String(evt)
        const lines = raw.split('\n').map((l: string) => l.trimEnd()).filter(Boolean)
        if (lines.length) {
          setAnnotateLogs((prev) => [...prev.slice(-(200 - lines.length)), ...lines])
        }
      })
    }

    if (scraper.onAnnotatorExit) {
      scraper.onAnnotatorExit(() => {
        setAnnotateRunning(false)
        // Parse token usage from logs and accumulate cost
        let tokIn = 0, tokOut = 0
        for (const line of annotateLogsRef.current) {
          const m = line.match(/\[done\]\s+.+?\|\s*([\d,]+)↑\/([\d,]+)↓/)
          if (m) {
            tokIn += Number(m[1].replace(/,/g, ''))
            tokOut += Number(m[2].replace(/,/g, ''))
          }
        }
        const rates = MODEL_COST_RATES[llmModelRef.current] ?? MODEL_COST_RATES['gpt-4o-mini']
        const runCost = (tokIn / 1e6) * rates.input + (tokOut / 1e6) * rates.output
        if (runCost > 0) addToCost(runCost)
        // refresh stats after annotator finishes
        if (scraper.annotationStats) {
          scraper.annotationStats().then((res: any) => {
            if (res?.ok) setAnnotationStats(res)
          })
        }
      })
    }
  }, [])

  // Keep refs in sync so the IPC exit handler always sees current values
  useEffect(() => { annotateLogsRef.current = annotateLogs }, [annotateLogs])
  useEffect(() => { llmModelRef.current = llmModel }, [llmModel])

  const createRunId = () => {
    try {
      return crypto.randomUUID()
    } catch {
      return `run_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
    }
  }

  const refreshAnnotationStats = useCallback(async () => {
    if (!window.scraper?.annotationStats) return
    const artifactsDir = `${outDir}/artifacts`
    const res = await window.scraper.annotationStats(artifactsDir)
    if (res?.ok) setAnnotationStats(res)
  }, [outDir])

  const startAnnotate = useCallback(async (opts: { llmModel?: string; concurrency?: number; force?: boolean }) => {
    if (!window.scraper?.startAnnotate) return
    annotateLogsRef.current = []
    setAnnotateLogs([])
    setAnnotateRunning(true)
    const res = await window.scraper.startAnnotate({
      artifactsDir: `${outDir}/artifacts`,
      openaiApiKey,
      llmModel: opts.llmModel ?? llmModel,
      concurrency: opts.concurrency ?? 3,
      force: opts.force ?? false,
    })
    if (!res?.ok) {
      setAnnotateRunning(false)
      setAnnotateLogs([`Failed to start annotator: ${res?.error ?? 'unknown error'}`])
    }
  }, [outDir, openaiApiKey, llmModel])

  const stopAnnotate = async () => {
    if (!window.scraper?.stopAnnotate) return
    await window.scraper.stopAnnotate()
    setAnnotateRunning(false)
  }

  const startRun = async () => {
    if (!topN || Number(topN) <= 0) return
    const runId = createRunId()
    // In resume mode, use a fixed unified dir so _load_done_records() can skip cached sites
    const runOutDir = resumeMode ? `${runsRoot}/unified` : `${runsRoot}/output_${runId}`
    const trackerRadarIndex = mappingMode === 'trackerdb' ? undefined : 'tracker_radar_index.json'
    const trackerDbIndex = mappingMode === 'radar' ? undefined : 'trackerdb_index.json'
    setErrorMessage(null)
    setLogs([])
    if (!resumeMode) {
      setSummaryData(null)
      setExplorerData(null)
    }
    setOutDir(runOutDir)
    if (window.scraper) {
      const res = await window.scraper.startRun({
        topN: Number(topN),
        trackerRadarIndex,
        trackerDbIndex,
        outDir: runOutDir,
        artifactsDir: `${runOutDir}/artifacts`,
        runId: resumeMode ? undefined : runId,
        cruxFilter: useCrux,
        cruxApiKey: useCrux ? cruxApiKey : undefined,
        excludeSameEntity: excludeSameEntity,
      })
      if (!res.ok) {
        setErrorMessage(res.error || 'Failed to start scraper')
      } else {
        setHasRun(true)
        setRunning(true)
        setProgress(0)
        setRunStartedAt(Date.now())
        setEtaText('')
      }
      return
    }
    setHasRun(true)
    setRunning(true)
    setProgress(0)
    setRunStartedAt(Date.now())
    setEtaText('')
  }

  useEffect(() => {
    if (!running) return
    if (!window.scraper) {
      const timer = setInterval(() => {
        setProgress((prev) => Math.min(100, prev + 4 + Math.random() * 6))
      }, 520)
      return () => clearInterval(timer)
    }
  }, [running])

  useEffect(() => {
    if (!running) return
    if (window.scraper) return
    if (progress >= 100) {
      setRunning(false)
    }
  }, [progress, running])

  useEffect(() => {
    if (!running || !runStartedAt || progress <= 0) {
      if (!running) setEtaText('')
      return
    }
    const effectiveProgress =
      stateData?.total_sites && stateData?.processed_sites
        ? (stateData.processed_sites / Math.max(1, stateData.total_sites)) * 100
        : progress
    if (effectiveProgress <= 0) return
    const elapsedMs = Date.now() - runStartedAt
    const totalMs = elapsedMs / (effectiveProgress / 100)
    const remainingMs = Math.max(0, totalMs - elapsedMs)
    setEtaText(formatDuration(remainingMs))
  }, [progress, running, runStartedAt, stateData])

  useEffect(() => {
    if (!window.scraper || !hasRun) return
    const interval = setInterval(async () => {
      try {
        const summary = await window.scraper?.readSummary(`${outDir}/results.summary.json`)
        if (summary?.ok) setSummaryData(summary.data)
        const state = await window.scraper?.readState(`${outDir}/run_state.json`)
        if (state?.ok) {
          setStateData(state.data)
          if (state.data?.total_sites && state.data?.processed_sites && running) {
            const computed = (state.data.processed_sites / Math.max(1, state.data.total_sites)) * 100
            setProgress(Math.min(100, computed))
          }
          if (!runStartedAt && state.data?.processed_sites) {
            setRunStartedAt(Date.now())
          }
        }
        const explorer = await window.scraper?.readExplorer(`${outDir}/explorer.jsonl`, 500)
        if (explorer?.ok && Array.isArray(explorer.data)) {
          const cleaned = explorer.data.filter((rec: any) => rec && rec.site)
          setExplorerData(cleaned)
        }
        const size = await window.scraper?.getFolderSize(outDir)
        if (size?.ok && typeof size.bytes === 'number') {
          setFolderBytes(size.bytes)
        }
        // Refresh annotation stats during annotate run or when viewing annotations
        if (annotateRunning || activeNav === 'annotations') {
          await refreshAnnotationStats()
        }
      } catch (error) {
        setErrorMessage(String(error))
      }
    }, 2000)
    return () => clearInterval(interval)
  }, [hasRun, outDir, annotateRunning, activeNav, refreshAnnotationStats])

  // Auto-annotate: when a scrape run completes and autoAnnotate is enabled, start annotation.
  const prevRunningRef = useRef(false)
  useEffect(() => {
    const justCompleted = prevRunningRef.current === true && running === false
    prevRunningRef.current = running
    if (justCompleted && hasRun && autoAnnotate && !annotateRunning) {
      startAnnotate({})
    }
  }, [running, hasRun, autoAnnotate, annotateRunning, startAnnotate])

  const refreshRuns = async (baseDir: string = runsRoot) => {
    if (!window.scraper) return
    const res = await window.scraper.listRuns(baseDir)
    if (res?.ok && Array.isArray(res.runs)) {
      setRunRecords(res.runs)
    } else {
      setRunRecords([])
    }
  }

  useEffect(() => {
    if (activeNav !== 'database') return
    refreshRuns()
  }, [activeNav, runsRoot])

  const clearResults = async (includeArtifacts?: boolean) => {
    if (!window.scraper) {
      setSummaryData(null)
      setExplorerData(null)
      setStateData(null)
      setHasRun(false)
      setProgress(0)
      setLogs([])
      return
    }
    setClearing(true)
    const res = await window.scraper.clearResults({ includeArtifacts, outDir: outDir })
    if (!res.ok) {
      setErrorMessage(res.error || 'Failed to clear results')
    } else {
      setSummaryData(null)
      setExplorerData(null)
      setStateData(null)
      setHasRun(false)
      setProgress(0)
      setLogs([])
    }
    setClearing(false)
  }

  const loadOutDir = async (dirOverride?: string) => {
    if (!window.scraper) return
    const targetDir = dirOverride || outDir
    if (dirOverride) {
      setOutDir(dirOverride)
    }
    const summary = await window.scraper.readSummary(`${targetDir}/results.summary.json`)
    if (summary?.ok) setSummaryData(summary.data)
    const state = await window.scraper.readState(`${targetDir}/run_state.json`)
    if (state?.ok) setStateData(state.data)
    const explorer = await window.scraper.readExplorer(`${targetDir}/explorer.jsonl`, 500)
    if (explorer?.ok && Array.isArray(explorer.data)) {
      const cleaned = explorer.data.filter((rec: any) => rec && rec.site)
      setExplorerData(cleaned)
    } else {
      setExplorerData([])
    }
    const size = await window.scraper.getFolderSize(targetDir)
    if (size?.ok && typeof size.bytes === 'number') {
      setFolderBytes(size.bytes)
    }
    const hasAnyResults = Boolean(summary?.ok || (explorer?.ok && Array.isArray(explorer.data) && explorer.data.length))
    if (hasAnyResults) {
      setHasRun(true)
      setRunning(false)
      setProgress(100)
    }
    // Load annotation stats for the new outDir
    if (window.scraper?.annotationStats) {
      const annRes = await window.scraper.annotationStats(`${targetDir}/artifacts`)
      if (annRes?.ok) setAnnotationStats(annRes)
    }
  }

  const deleteOutDir = async () => {
    if (!window.scraper) return
    setClearing(true)
    const res = await window.scraper.deleteOutput(outDir)
    if (!res.ok) {
      setErrorMessage(res.error || 'Failed to delete output folder')
    } else {
      setSummaryData(null)
      setExplorerData(null)
      setStateData(null)
      setHasRun(false)
      setProgress(0)
      setLogs([])
      setFolderBytes(null)
    }
    setClearing(false)
  }

  const stopRun = async () => {
    if (!window.scraper) return
    setLogs((prev) => [...prev, 'Stop requested'].slice(-50))
    const res = await window.scraper.stopRun()
    if (!res.ok) {
      setErrorMessage(res.error || 'Failed to stop scraper')
      return
    }
    setRunning(false)
    setLogs((prev) => [...prev, 'Stop signal sent'].slice(-50))
  }

  const openLogWindow = async () => {
    if (!window.scraper) return
    const content = logs.length ? logs.join('\n') : 'No logs yet.'
    await window.scraper.openLogWindow(content, 'Run logs')
  }

  const pageTitle = {
    launcher: 'Scraper Launcher',
    results: 'Results',
    explorer: 'Explorer',
    annotations: 'Annotations',
    consistency: 'Consistency checker',
    database: 'Database',
    settings: 'Settings',
  }[activeNav]

  const pageSubtitle = {
    launcher: 'Minimal control surface for the dataset pipeline.',
    results: 'Outcome overview of the latest scrape.',
    explorer: 'Browse scraped sites and their policy links.',
    annotations: annotationsTab === 'viewer'
      ? 'Read annotated policy text with phrase-level highlights.'
      : 'LLM-extracted privacy statements from policy documents.',
    consistency: 'Compare first‑party and third‑party policy texts.',
    database: 'Artifact storage and dataset exports.',
    settings: 'Theme and default crawl preferences.',
  }[activeNav]

  return (
    <div className="min-h-screen">
      <Sidebar activeNav={activeNav} onSelect={setActiveNav} />
      <PageShell title={pageTitle} subtitle={pageSubtitle}>
        {activeNav === 'launcher' && (
          <LauncherView
            topN={topN}
            onTopNChange={setTopN}
            onStart={startRun}
            onStop={stopRun}
            hasRun={hasRun}
            running={running}
            progress={progress}
            resultsReady={resultsMetrics.resultsReady}
            onViewResults={() => setActiveNav('results')}
            logs={logs}
            errorMessage={errorMessage || undefined}
            etaText={etaText}
            useCrux={useCrux}
            onToggleCrux={setUseCrux}
            cruxApiKey={cruxApiKey}
            onCruxKeyChange={setCruxApiKey}
            excludeSameEntity={excludeSameEntity}
            onToggleExcludeSameEntity={setExcludeSameEntity}
            mappingMode={mappingMode}
            onMappingModeChange={setMappingMode}
            onOpenLogWindow={openLogWindow}
            openaiApiKey={openaiApiKey}
            onOpenAiKeyChange={setOpenaiApiKey}
            llmModel={llmModel}
            onLlmModelChange={setLlmModel}
            annotateRunning={annotateRunning}
            annotateLogs={annotateLogs}
            annotationStats={annotationStats}
            onStartAnnotate={startAnnotate}
            onStopAnnotate={stopAnnotate}
            resumeMode={resumeMode}
            onToggleResumeMode={setResumeMode}
            activeSites={activeSites}
            recentCompleted={recentCompleted}
          />
        )}
        {activeNav === 'results' && (
          <ResultsView
            hasRun={hasRun}
            progress={progress}
            topN={topN}
            metrics={resultsMetrics}
            summary={summaryData}
            sites={explorerData || undefined}
            useCrux={useCrux}
            mappingMode={mappingMode}
            annotationStats={annotationStats}
          />
        )}
        {activeNav === 'explorer' && (
          <ExplorerView
            hasRun={hasRun}
            progress={progress}
            sites={explorerData || undefined}
            showExtractionMethod={showExtractionMethod}
            outDir={outDir}
          />
        )}
        {activeNav === 'annotations' && (
          <>
            {/* Tab switcher */}
            <section className="card rounded-2xl p-1">
              <div className="flex gap-1">
                {(
                  [
                    { id: 'overview', label: 'Overview' },
                    { id: 'viewer', label: 'Policy Viewer' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    className={`flex-1 rounded-xl px-4 py-2 text-xs transition ${
                      annotationsTab === tab.id
                        ? 'bg-[var(--color-primary)] text-white'
                        : 'text-[var(--muted-text)] hover:bg-black/20'
                    }`}
                    onClick={() => setAnnotationsTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </section>
            {annotationsTab === 'overview' && (
              <AnnotationsView annotationStats={annotationStats} outDir={outDir} />
            )}
            {annotationsTab === 'viewer' && (
              <PolicyViewerView
                sites={explorerData || undefined}
                annotationStats={annotationStats}
                outDir={outDir}
              />
            )}
          </>
        )}
        {activeNav === 'consistency' && (
          <ConsistencyCheckerView
            hasRun={hasRun}
            sites={explorerData || undefined}
            outDir={outDir}
            showExtractionMethod={showExtractionMethod}
            onSendToReasoning={() => {}}
          />
        )}
        {activeNav === 'database' && (
          <DatabaseView
            runsRoot={runsRoot}
            runs={runRecords}
            onRefreshRuns={() => refreshRuns()}
            onSelectRun={(dir) => loadOutDir(dir)}
            summary={summaryData}
            state={stateData}
            onClear={clearResults}
            clearing={clearing}
            outDir={outDir}
            onOutDirChange={setOutDir}
            onLoadOutDir={() => loadOutDir()}
            onDeleteOutDir={deleteOutDir}
            folderBytes={folderBytes}
            annotationStats={annotationStats}
          />
        )}
        {activeNav === 'settings' && (
          <SettingsView
            theme={theme}
            onThemeChange={setTheme}
            showExtractionMethod={showExtractionMethod}
            onToggleShowExtractionMethod={setShowExtractionMethod}
            useCrux={useCrux}
            onToggleCrux={setUseCrux}
            cruxApiKey={cruxApiKey}
            onCruxKeyChange={setCruxApiKey}
            excludeSameEntity={excludeSameEntity}
            onToggleExcludeSameEntity={setExcludeSameEntity}
            mappingMode={mappingMode}
            onMappingModeChange={setMappingMode}
            autoAnnotate={autoAnnotate}
            onToggleAutoAnnotate={setAutoAnnotate}
            openaiApiKey={openaiApiKey}
            onOpenaiApiKeyChange={setOpenaiApiKey}
            totalCost={totalCost}
            onResetCost={resetCost}
          />
        )}
      </PageShell>
    </div>
  )
}

export default App
