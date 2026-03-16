import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { AnnotationsView } from './components/annotations/AnnotationsView'
import { PolicyViewerView } from './components/annotations/PolicyViewerView'
import { AuditWorkspaceView } from './components/audit/AuditWorkspaceView'
import { CatalogView } from './components/catalog/CatalogView'
import { ConsistencyCheckerView } from './components/consistency/ConsistencyCheckerView'
import { DatabaseView } from './components/database/DatabaseView'
import { ExplorerView } from './components/explorer/ExplorerView'
import { useBridgeAutoRecovery } from './lib/useBridgeAutoRecovery'
import { PageShell } from './components/layout/PageShell'
import { Sidebar } from './components/layout/Sidebar'
import { LauncherView } from './components/launcher/LauncherView'
import { ResultsView } from './components/results/ResultsView'
import { SettingsView } from './components/settings/SettingsView'
import { useAppRuntime } from './lib/useAppRuntime'
import { useBridgeStatus } from './lib/useBridgeStatus'
import { useLauncherModel, buildLauncherState } from './lib/useLauncherModel'
import { useOperationsController } from './lib/useOperationsController'
import { listRunRecords } from './lib/scraperClient'
import { emptyScraperSiteActivityState } from './lib/scraperRuntime'
import { useRunController } from './lib/useRunController'
import { useWorkspaceController } from './lib/useWorkspaceController'
import { useWorkspaceData } from './lib/useWorkspaceData'
import { NavId, Theme } from './types'

function formatAgeLabel(timestamp: number | null) {
  if (!timestamp) return 'never'
  const deltaMs = Date.now() - timestamp
  if (deltaMs < 15_000) return 'just now'
  const totalSeconds = Math.floor(deltaMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes <= 0) return `${seconds}s ago`
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

export function buildDisabledNavs({
  bridgeReady,
  hasWorkspaceContent,
}: {
  bridgeReady: boolean
  hasWorkspaceContent: boolean
}): Record<NavId, boolean> {
  return {
    launcher: false,
    settings: false,
    catalog: !bridgeReady,
    database: !bridgeReady,
    results: !hasWorkspaceContent,
    audit: !hasWorkspaceContent,
    explorer: !hasWorkspaceContent,
    annotations: !hasWorkspaceContent,
    consistency: !hasWorkspaceContent,
  }
}

export function shouldAutoLoadWorkspace({
  bridgeReady,
  running,
  hasRun,
  hasDataset,
  hasSummaryOrState,
}: {
  bridgeReady: boolean
  running: boolean
  hasRun: boolean
  hasDataset: boolean
  hasSummaryOrState: boolean
}) {
  if (!bridgeReady || running) return false
  if (hasRun || hasDataset || hasSummaryOrState) return false
  return true
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
  const [running, setRunning] = useState(false)
  const [scraperActivity, setScraperActivity] = useState(emptyScraperSiteActivityState())
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null)
  const [etaText, setEtaText] = useState<string>('')
  const [excludeSameEntity, setExcludeSameEntity] = useState(true)
  const [mappingMode, setMappingMode] = useState<'radar' | 'trackerdb' | 'mixed'>('mixed')
  const [outDir, setOutDir] = useState('outputs/unified')
  const [runsRoot] = useState('outputs')
  const [resumeMode, setResumeMode] = useState(true)
  const [auditBusySite, setAuditBusySite] = useState<string | null>(null)
  const [auditAnnotatingSite, setAuditAnnotatingSite] = useState<string | null>(null)
  const [bridgeActionBusy, setBridgeActionBusy] = useState<'diagnose' | 'repair' | 'refresh' | null>(null)
  const [bridgeActionMessage, setBridgeActionMessage] = useState<string | null>(null)
  const [stopRunPending, setStopRunPending] = useState(false)
  const [llmModel] = useState('openai/local')
  const [annotateRunning, setAnnotateRunning] = useState(false)
  const [annotateLogs, setAnnotateLogs] = useState<string[]>([])
  const [autoAnnotate, setAutoAnnotate] = useState(true)
  const [autoAnnotatePending, setAutoAnnotatePending] = useState(false)
  const [annotationsTab, setAnnotationsTab] = useState<'overview' | 'viewer'>('overview')
  const annotateLogsRef = useRef<string[]>([])
  const defaultOutDir = `${runsRoot}/unified`

  const {
    workspaceData,
    resetWorkspaceData,
    applyWorkspaceSnapshot,
    updateWorkspaceData,
  } = useWorkspaceData()
  const {
    hasRun,
    progress,
    summaryData,
    explorerData,
    resultsData,
    stateData,
    runRecords,
    runManifest,
    folderBytes,
    annotationStats,
    annotationRunState,
    auditVerifiedSites,
    auditUrlOverrides,
  } = workspaceData
  const logs = scraperActivity.logs
  const activeSites = scraperActivity.activeSites
  const recentCompleted = scraperActivity.recentCompleted

  const resetLoadedOutputState = useCallback((nextOutDir?: string) => {
    resetWorkspaceData()
    setAuditBusySite(null)
    setAuditAnnotatingSite(null)
    setScraperActivity(emptyScraperSiteActivityState())
    setRunning(false)
    setStopRunPending(false)
    setRunStartedAt(null)
    setEtaText('')
    setAutoAnnotatePending(false)
    if (nextOutDir) {
      setOutDir(nextOutDir)
    }
  }, [resetWorkspaceData])

  const appendScraperLog = useCallback((message: string) => {
    setScraperActivity((prev) => ({
      ...prev,
      logs: [...prev.logs, message].slice(-50),
    }))
  }, [])

  const handleMissingOutputDir = useCallback(async (missingDir: string) => {
    const fallbackDir = defaultOutDir
    resetLoadedOutputState(missingDir === fallbackDir ? undefined : fallbackDir)
    if (outDir === missingDir) {
      setErrorMessage(`Output folder "${missingDir}" no longer exists. Hidden stale data and reset to ${fallbackDir}.`)
    }
    updateWorkspaceData({ runRecords: await listRunRecords(runsRoot) })
  }, [defaultOutDir, outDir, resetLoadedOutputState, runsRoot, updateWorkspaceData])

  const {
    refreshRuns,
    syncLoadedRunState,
    loadAuditWorkspace,
    loadOutDir,
    persistAuditState,
  } = useWorkspaceController({
    outDir,
    runsRoot,
    running,
    handleMissingOutputDir,
    applyWorkspaceSnapshot,
    updateWorkspaceData,
    setOutDir,
    setTopN,
  })

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

  const { resultsMetrics, datasetState } = useLauncherModel({
    hasRun,
    progress,
    summaryData,
    stateData,
    resultsData,
    runManifest,
    topN,
    resumeMode,
    dashboardLocked: false,
    outDir,
  })
  const localScraperActive = running || stopRunPending
  const workspaceReady = running || hasRun || datasetState.hasDataset

  const {
    tunnelStatus,
    backendStatus,
    bridgeFailures,
    bridgeCheckedAt,
    bridgeHealthyAt,
    dashboardLocked,
    bridgeReady,
    remoteCodeLegacy,
    remoteCodeOutdated,
    bridgeHeadline,
    bridgeDetail,
    refreshBridgeStatus,
  } = useBridgeStatus({
    workspaceReady,
    scraperActive: localScraperActive,
  })
  const scraperActive = localScraperActive || Boolean(backendStatus?.active_run || backendStatus?.running)
  const hasWorkspaceContent = workspaceReady

  const launcherState = useMemo(() => buildLauncherState({
    datasetState,
    topN,
    resumeMode,
    dashboardLocked,
    outDir,
  }), [dashboardLocked, datasetState, outDir, resumeMode, topN])
  const {
    currentTargetTotal,
    requestedTargetTotal,
    launchStartingProgress,
    launcherMode,
    launcherActionLabel,
    launcherActionHint,
  } = launcherState

  const disabledNavs = buildDisabledNavs({
    bridgeReady,
    hasWorkspaceContent,
  })

  useEffect(() => {
    if (!shouldAutoLoadWorkspace({
      bridgeReady,
      running,
      hasRun,
      hasDataset: datasetState.hasDataset,
      hasSummaryOrState: Boolean(summaryData || stateData),
    })) {
      return
    }

    void loadOutDir()
    void refreshRuns()
  }, [
    bridgeReady,
    datasetState.hasDataset,
    hasRun,
    loadOutDir,
    refreshRuns,
    running,
    stateData,
    summaryData,
  ])

  const handleSelectNav = useCallback((next: NavId) => {
    if (!disabledNavs[next]) {
      setActiveNav(next)
      return
    }
    setErrorMessage(
      next === 'database'
        ? 'Remote orchestrator is not ready yet. Bring the bridge online first.'
        : 'This view unlocks after the tunnel is healthy and a remote workspace is available.'
    )
    setActiveNav('launcher')
  }, [disabledNavs])

  useEffect(() => {
    if (hasWorkspaceContent) return
    if (!disabledNavs[activeNav]) return
    setActiveNav('launcher')
  }, [activeNav, disabledNavs, hasWorkspaceContent])

  const {
    markAuditVerified,
    saveAuditOverride,
    rerunAuditSite,
    annotateAuditSite,
    startAnnotate,
    stopAnnotate,
    startRun,
  } = useRunController({
    outDir,
    runsRoot,
    topN,
    resumeMode,
    excludeSameEntity,
    mappingMode,
    llmModel,
    scraperActive,
    dashboardLocked,
    launcherMode,
    currentTargetTotal,
    requestedTargetTotal,
    launchStartingProgress,
    datasetState,
    auditVerifiedSites,
    auditUrlOverrides,
    annotationStatsTotalSites: annotationStats?.total_sites ?? 0,
    remoteCodeOutdated,
    remoteCodeLegacy,
    backendStatus,
    persistAuditState,
    refreshBridgeStatus,
    updateWorkspaceData,
    setOutDir,
    setRunning,
    setRunStartedAt,
    setEtaText,
    setErrorMessage,
    setScraperActivity,
    setAuditBusySite,
    setAuditAnnotatingSite,
    setAnnotateLogs,
    setAnnotateRunning,
    annotateLogsRef,
  })

  const {
    clearResults,
    deleteOutDir,
    deleteAllOutputs,
    stopRun,
    openLogWindow,
    diagnoseBridge,
    repairBridge,
    refreshRemote,
  } = useOperationsController({
    defaultOutDir,
    outDir,
    runsRoot,
    logs,
    scraperActive,
    stopRunPending,
    refreshRuns,
    refreshBridgeStatus,
    resetLoadedOutputState,
    appendScraperLog,
    setClearing,
    setErrorMessage,
    setStopRunPending,
    setBridgeActionBusy,
    setBridgeActionMessage,
  })

  useBridgeAutoRecovery({
    tunnelStatus,
    bridgeFailures,
    bridgeActionBusy,
    refreshRemote,
  })

  const { latestStreamEvent } = useAppRuntime({
    activeNav,
    annotateRunning,
    autoAnnotate,
    autoAnnotatePending,
    hasRun,
    outDir,
    progress,
    running,
    runStartedAt,
    stateData,
    summaryData,
    stopRunPending,
    tunnelStatus,
    launchStartingProgress,
    handleMissingOutputDir,
    refreshRuns,
    syncLoadedRunState,
    loadAuditWorkspace,
    startAnnotate,
    applyWorkspaceSnapshot,
    updateWorkspaceData,
    appendScraperLog,
    annotateLogsRef,
    setAutoAnnotatePending,
    setAuditBusySite,
    setAuditAnnotatingSite,
    setAnnotateLogs,
    setAnnotateRunning,
    setErrorMessage,
    setEtaText,
    setRunStartedAt,
    setRunning,
    setScraperActivity,
    setStopRunPending,
  })

  const pageTitle = {
    launcher: 'Scraper Launcher',
    audit: 'Audit Workspace',
    results: 'Results',
    explorer: 'Explorer',
    catalog: 'Catalog',
    annotations: 'Annotations',
    consistency: 'Consistency checker',
    database: 'Database',
    settings: 'Settings',
  }[activeNav]

  const pageSubtitle = {
    launcher: 'Minimal control surface for the dataset pipeline.',
    audit: 'Audit scraped sites, apply manual fixes, and rerun targeted tasks.',
    results: 'Outcome overview of the latest scrape.',
    explorer: 'Browse scraped sites and their policy links.',
    catalog: 'Query the warehouse for sites, policies, and third-party services.',
    annotations: annotationsTab === 'viewer'
      ? 'Read annotated policy text with phrase-level highlights.'
      : 'LLM-extracted privacy statements from policy documents.',
    consistency: 'Compare first‑party and third‑party policy texts.',
    database: 'Artifact storage and dataset exports.',
    settings: 'Theme and default crawl preferences.',
  }[activeNav]

  return (
    <div className="min-h-screen">
      <Sidebar
        activeNav={activeNav}
        onSelect={handleSelectNav}
        disabledNavs={disabledNavs}
        bridgeStatus={tunnelStatus}
      />
      <PageShell title={pageTitle} subtitle={pageSubtitle}>
        {activeNav === 'launcher' && (
          <LauncherView
            topN={topN}
            onTopNChange={setTopN}
            onStart={startRun}
            onStop={stopRun}
            stopRunPending={stopRunPending}
            hasRun={hasRun}
            running={running}
            scraperActive={scraperActive}
            progress={progress}
            resultsReady={resultsMetrics.resultsReady}
            onViewResults={() => setActiveNav('results')}
            logs={logs}
            errorMessage={errorMessage || undefined}
            etaText={etaText}
            excludeSameEntity={excludeSameEntity}
            onToggleExcludeSameEntity={setExcludeSameEntity}
            mappingMode={mappingMode}
            onMappingModeChange={setMappingMode}
            onOpenLogWindow={openLogWindow}
            tunnelStatus={tunnelStatus}
            bridgeReady={bridgeReady}
            bridgeHeadline={bridgeHeadline}
            bridgeDetail={bridgeDetail}
            bridgeNode={backendStatus?.node}
            bridgeCurrentOutDir={backendStatus?.current_out_dir}
            bridgeCheckedAt={formatAgeLabel(bridgeCheckedAt)}
            bridgeHealthyAt={formatAgeLabel(bridgeHealthyAt)}
            bridgeFailures={bridgeFailures}
            bridgeActionBusy={bridgeActionBusy}
            bridgeActionMessage={bridgeActionMessage || undefined}
            onDiagnoseBridge={diagnoseBridge}
            onRepairBridge={repairBridge}
            onRefreshRemote={refreshRemote}
            remoteCodeOutdated={remoteCodeOutdated}
            workspaceReady={workspaceReady}
            llmModel={llmModel}
            latestStreamEvent={latestStreamEvent}
            annotateRunning={annotateRunning}
            annotateLogs={annotateLogs}
            annotationStats={annotationStats}
            annotationRunState={annotationRunState}
            onStartAnnotate={startAnnotate}
            onStopAnnotate={stopAnnotate}
            resumeMode={resumeMode}
            onToggleResumeMode={setResumeMode}
            activeSites={activeSites}
            recentCompleted={recentCompleted}
            primaryActionLabel={launcherActionLabel}
            primaryActionHint={launcherActionHint}
            topNLocked={datasetState.isIncomplete}
            lastDatasetRank={datasetState.lastSuccessfulRank}
          />
        )}
        {activeNav === 'audit' && (
          <AuditWorkspaceView
            outDir={outDir}
            records={resultsData || []}
            verifiedSites={auditVerifiedSites}
            urlOverrides={auditUrlOverrides}
            bridgeReady={bridgeReady}
            running={running}
            busySite={auditBusySite}
            annotatingSite={auditAnnotatingSite}
            activeSites={activeSites}
            onReload={() => loadAuditWorkspace()}
            onMarkVerified={markAuditVerified}
            onSaveOverride={saveAuditOverride}
            onRerun={rerunAuditSite}
            onAnnotate={annotateAuditSite}
          />
        )}
        {activeNav === 'results' && (
          <ResultsView
            hasRun={hasRun}
            progress={progress}
            topN={topN}
            lastDatasetRank={datasetState.lastSuccessfulRank}
            metrics={resultsMetrics}
            summary={summaryData}
            records={resultsData || undefined}
            sites={explorerData || undefined}
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
        {activeNav === 'catalog' && (
          <CatalogView bridgeReady={bridgeReady} />
        )}
        {activeNav === 'annotations' && (
          <>
            <section className="card rounded-2xl p-1">
              <div className="flex gap-1">
                {[
                  { id: 'overview', label: 'Overview' },
                  { id: 'viewer', label: 'Policy Viewer' },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    className={`flex-1 rounded-xl px-4 py-2 text-xs transition ${
                      annotationsTab === tab.id
                        ? 'bg-[var(--color-primary)] text-white'
                        : 'text-[var(--muted-text)] hover:bg-black/20'
                    }`}
                    onClick={() => setAnnotationsTab(tab.id as 'overview' | 'viewer')}
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
            onDeleteAllOutputs={deleteAllOutputs}
            folderBytes={folderBytes}
            annotationStats={annotationStats}
            deleteEnabled={Boolean(outDir && outDir !== runsRoot && outDir.startsWith(`${runsRoot}/`))}
          />
        )}
        {activeNav === 'settings' && (
          <SettingsView
            theme={theme}
            onThemeChange={setTheme}
            showExtractionMethod={showExtractionMethod}
            onToggleShowExtractionMethod={setShowExtractionMethod}
            outDir={outDir || undefined}
            excludeSameEntity={excludeSameEntity}
            onToggleExcludeSameEntity={setExcludeSameEntity}
            mappingMode={mappingMode}
            onMappingModeChange={setMappingMode}
            autoAnnotate={autoAnnotate}
            onToggleAutoAnnotate={setAutoAnnotate}
            tunnelStatus={tunnelStatus}
            bridgeReady={bridgeReady}
            bridgeHeadline={bridgeHeadline}
            bridgeDetail={bridgeDetail}
            bridgeNode={backendStatus?.node}
            bridgeCurrentOutDir={backendStatus?.current_out_dir}
            bridgeCheckedAt={formatAgeLabel(bridgeCheckedAt)}
            bridgeHealthyAt={formatAgeLabel(bridgeHealthyAt)}
            bridgeFailures={bridgeFailures}
            bridgeActionBusy={bridgeActionBusy}
            bridgeActionMessage={bridgeActionMessage || undefined}
            onDiagnoseBridge={diagnoseBridge}
            onRepairBridge={repairBridge}
            onRefreshRemote={refreshRemote}
            remoteCodeOutdated={remoteCodeOutdated}
          />
        )}
      </PageShell>
    </div>
  )
}

export default App
