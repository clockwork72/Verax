import { afterEach, describe, expect, it } from 'vitest'

import {
  clearWorkspaceResults,
  countOkArtifactSites,
  deleteAllWorkspaceOutputs,
  deleteWorkspaceOutput,
  hasScraperBridge,
  listRunRecords,
  openEmbeddedPolicyWindow,
  openLogWindow,
  readFolderSize,
  readRunManifest,
  readWorkspaceSnapshot,
  requestAnnotateSite,
  requestRerunSite,
  requestStartAnnotate,
  requestStartRun,
  requestStopAnnotate,
  requestStopRun,
  runBridgeDiagnostics,
  runBridgeRepair,
  runRemoteRefresh,
  subscribeAnnotatorEvents,
  subscribePipelineEvents,
  subscribeScraperActivitySnapshots,
  subscribeScraperEvents,
  writeAuditState,
} from './scraperClient'

const baseSummary = {
  run_id: 'run-1',
  processed_sites: 0,
  total_sites: 0,
  success_rate: 0,
  status_counts: {},
  third_party: {
    total: 0,
    unique: 0,
    mapped: 0,
    unique_mapped: 0,
    unique_with_policy: 0,
    unmapped: 0,
    no_policy_url: 0,
  },
  mapping: {
    mode: 'mixed' as const,
    radar_mapped: 0,
    trackerdb_mapped: 0,
    unmapped: 0,
    unique_radar_mapped: 0,
    unique_trackerdb_mapped: 0,
    unique_unmapped: 0,
    },
    site_categories: [],
    categories: [],
    entities: [],
}

const baseState = {
  run_id: 'run-1',
  processed_sites: 0,
  total_sites: 0,
  status_counts: {},
  third_party: {
    total: 0,
    mapped: 0,
    unmapped: 0,
    no_policy_url: 0,
  },
  mapping: {
    mode: 'mixed' as const,
    radar_mapped: 0,
    trackerdb_mapped: 0,
    unmapped: 0,
  },
}

function installScraperMock(overrides: Partial<NonNullable<Window['scraper']>>) {
  window.scraper = {
    startRun: async () => ({ ok: true }),
    stopRun: async () => ({ ok: true, status: 'stopping' }),
    readSummary: async () => ({ ok: true, data: null }),
    readState: async () => ({ ok: true, data: null }),
    readExplorer: async () => ({ ok: true, data: [] }),
    readResults: async () => ({ ok: true, data: [] }),
    readAuditState: async () => ({ ok: true, data: { verifiedSites: [], urlOverrides: {} } }),
    readRunManifest: async () => ({ ok: true, data: null }),
    writeAuditState: async (payload) => ({
      ok: true,
      data: {
        verifiedSites: payload?.verifiedSites || [],
        urlOverrides: payload?.urlOverrides || {},
      },
    }),
    readArtifactText: async () => ({ ok: true, data: '' }),
    clearResults: async () => ({ ok: true, removed: [], errors: [] }),
    deleteOutput: async () => ({ ok: true, path: 'outputs/unified', removed: [] }),
    deleteAllOutputs: async () => ({ ok: true, path: 'outputs', removed: [] }),
    annotationStats: async () => ({
      ok: true,
      total_sites: 0,
      annotated_sites: 0,
      total_statements: 0,
      per_site: [],
      tp_total: 0,
      tp_annotated: 0,
      tp_total_statements: 0,
      per_tp: [],
    }),
    getFolderSize: async () => ({ ok: true, bytes: 0 }),
    listRuns: async () => ({ ok: true, runs: [] }),
    openLogWindow: async () => ({ ok: true }),
    countOkArtifacts: async () => ({ ok: true, count: 0, sites: [], path: 'outputs/unified/artifacts_ok' }),
    readTpCache: async () => ({ ok: true, total: 0, fetched: 0, failed: 0, by_status: {} }),
    openPolicyWindow: async () => ({ ok: true }),
    onEvent: () => {},
    onActivitySnapshot: () => {},
    onLog: () => {},
    onError: () => {},
    onExit: () => {},
    rerunSite: async (options) => ({ ok: true, site: options.site }),
    startAnnotate: async () => ({ ok: true }),
    checkTunnel: async () => ({ ok: true, data: { service_ready: true } }),
    stopAnnotate: async () => ({ ok: true, status: 'stopped' }),
    annotateSite: async (options) => ({ ok: true, site: options.site }),
    onAnnotatorLog: () => {},
    onAnnotatorExit: () => {},
    onAnnotatorStream: () => {},
    onPipelineEvent: () => {},
    diagnoseBridge: async () => ({ ok: true, stdout: 'diagnose' }),
    repairBridge: async () => ({ ok: true, stdout: 'repair' }),
    refreshRemote: async () => ({ ok: true, stdout: 'refresh' }),
    ...overrides,
  } as Window['scraper']
}

afterEach(() => {
  delete window.scraper
})

describe('scraperClient', () => {
  it('detects bridge availability', () => {
    expect(hasScraperBridge()).toBe(false)
    installScraperMock({})
    expect(hasScraperBridge()).toBe(true)
  })

  it('builds a cleaned workspace snapshot from the scraper bridge', async () => {
    installScraperMock({
      readSummary: async () => ({
        ok: true,
        data: {
          ...baseSummary,
          processed_sites: 4,
          total_sites: 10,
          mapping: {
            ...baseSummary.mapping,
            unique_radar_mapped: 2,
            unique_trackerdb_mapped: 1,
            unique_unmapped: 3,
          },
        },
      }),
      readState: async () => ({ ok: true, data: { ...baseState, processed_sites: 4, total_sites: 10 } }),
      readExplorer: async () => ({
        ok: true,
        data: [{ site: 'docker.com' }, null, { site: '' }, { site: 'openai.com' }],
      }),
      readResults: async () => ({
        ok: true,
        data: [{ site_etld1: 'docker.com' }, { input: 'openai.com' }, { bad: true }],
      }),
      readAuditState: async () => ({
        ok: true,
        data: { verifiedSites: ['docker.com'], urlOverrides: { 'docker.com': 'https://docker.com/privacy' } },
      }),
      readRunManifest: async () => ({
        ok: true,
        data: { mode: 'dataset', expectedTotalSites: 10, updatedAt: '2026-03-12T05:00:00+00:00', version: 1, status: 'running' },
      }),
      annotationStats: async () => ({
        ok: true,
        total_sites: 2,
        annotated_sites: 1,
        total_statements: 7,
        per_site: [
          { site: 'docker.com', count: 7, has_statements: true, completed: true, status: 'completed', tokens_in: 100, tokens_out: 25 },
          { site: 'openai.com', count: 0, has_statements: false, completed: false, status: 'pending' },
        ],
        tp_total: 0,
        tp_annotated: 0,
        tp_total_statements: 0,
        per_tp: [],
      }),
      getFolderSize: async () => ({ ok: true, bytes: 2048 }),
    })

    const snapshot = await readWorkspaceSnapshot({
      outDir: 'outputs/unified',
      includeFolderSize: true,
      includeExplorer: true,
      includeResults: true,
      includeAudit: true,
      includeManifest: true,
      includeAnnotation: true,
    })

    expect(snapshot.missingOutputDir).toBe(false)
    expect(snapshot.progress).toBe(40)
    expect(snapshot.folderBytes).toBe(2048)
    expect(snapshot.summary?.mapping).toEqual(expect.objectContaining({
      unique_radar_mapped: 2,
      unique_trackerdb_mapped: 1,
      unique_unmapped: 3,
    }))
    expect(snapshot.explorer).toEqual([
      {
        site: 'docker.com',
        rank: null,
        mainCategory: null,
        status: 'exception',
        policyUrl: null,
        extractionMethod: null,
        thirdParties: [],
      },
      {
        site: 'openai.com',
        rank: null,
        mainCategory: null,
        status: 'exception',
        policyUrl: null,
        extractionMethod: null,
        thirdParties: [],
      },
    ])
    expect(snapshot.results).toEqual([{ site_etld1: 'docker.com' }, { input: 'openai.com' }])
    expect(snapshot.auditState).toEqual({
      verifiedSites: ['docker.com'],
      urlOverrides: { 'docker.com': 'https://docker.com/privacy' },
    })
    expect(snapshot.annotationRunState?.completedSites).toBe(1)
    expect(snapshot.annotationRunState?.tokensIn).toBe(100)
  })

  it('marks missing output directories without reading deeper files', async () => {
    installScraperMock({
      getFolderSize: async () => ({ ok: false, error: 'not_found' }),
    })

    const snapshot = await readWorkspaceSnapshot({
      outDir: 'outputs/missing',
      includeFolderSize: true,
      includeExplorer: true,
      includeResults: true,
    })

    expect(snapshot.missingOutputDir).toBe(true)
    expect(snapshot.hasAnyResults).toBe(false)
    expect(snapshot.progress).toBe(0)
  })

  it('skips explorer and results artifact reads unless explicitly requested', async () => {
    let explorerReads = 0
    let resultsReads = 0
    installScraperMock({
      readSummary: async () => ({ ok: true, data: { ...baseSummary, processed_sites: 5, total_sites: 10 } }),
      readState: async () => ({ ok: true, data: { ...baseState, processed_sites: 5, total_sites: 10 } }),
      readExplorer: async () => {
        explorerReads += 1
        return { ok: true, data: [{ site: 'docker.com' }] }
      },
      readResults: async () => {
        resultsReads += 1
        return { ok: true, data: [{ site_etld1: 'docker.com' }] }
      },
    })

    const snapshot = await readWorkspaceSnapshot({
      outDir: 'outputs/unified',
      includeManifest: true,
    })

    expect(snapshot.progress).toBe(50)
    expect(snapshot.explorer).toBeUndefined()
    expect(snapshot.results).toBeUndefined()
    expect(explorerReads).toBe(0)
    expect(resultsReads).toBe(0)
  })

  it('uses retained results rows as a progress floor when summary counters lag after resume', async () => {
    installScraperMock({
      readSummary: async () => ({
        ok: true,
        data: {
          ...baseSummary,
          processed_sites: 2,
          total_sites: 10,
        },
      }),
      readState: async () => ({ ok: true, data: { ...baseState, processed_sites: 2, total_sites: 10 } }),
      readResults: async () => ({
        ok: true,
        data: [
          { site_etld1: 'one.example' },
          { site_etld1: 'two.example' },
          { site_etld1: 'three.example' },
          { site_etld1: 'four.example' },
        ],
      }),
    })

    const snapshot = await readWorkspaceSnapshot({
      outDir: 'outputs/unified',
      includeResults: true,
    })

    expect(snapshot.processedSites).toBe(4)
    expect(snapshot.totalSites).toBe(10)
    expect(snapshot.progress).toBe(40)
  })

  it('reads run listings and folder sizes through the client layer', async () => {
    installScraperMock({
      listRuns: async () => ({
        ok: true,
        runs: [{
          runId: 'run-1',
          folder: 'output_run-1',
          outDir: 'outputs/run-1',
          summary: { ...baseSummary, processed_sites: 2, total_sites: 5, status_counts: { ok: 1 }, success_rate: 50 },
          state: {
            ...baseState,
            processed_sites: 2,
            total_sites: 5,
            status_counts: { ok: 1 },
            started_at: '2026-03-12T04:00:00+00:00',
          },
          updated_at: '2026-03-12T05:00:00+00:00',
        }],
      }),
      getFolderSize: async () => ({ ok: true, bytes: 4096 }),
    })

    await expect(listRunRecords('outputs')).resolves.toEqual([{
      runId: 'run-1',
      folder: 'output_run-1',
      outDir: 'outputs/run-1',
      summary: expect.objectContaining({ processed_sites: 2, total_sites: 5 }),
      state: expect.objectContaining({
        processed_sites: 2,
        total_sites: 5,
        started_at: '2026-03-12T04:00:00+00:00',
      }),
      updated_at: '2026-03-12T05:00:00+00:00',
      started_at: undefined,
    }])
    await expect(readFolderSize('outputs/run-1')).resolves.toEqual({ ok: true, bytes: 4096 })
  })

  it('routes helper calls for artifact counts and policy windows through the client layer', async () => {
    installScraperMock({
      countOkArtifacts: async () => ({
        ok: true,
        count: 2,
        sites: ['docker.com', 'openai.com'],
        path: 'outputs/unified/artifacts_ok',
      }),
      openPolicyWindow: async () => ({ ok: true }),
    })

    await expect(countOkArtifactSites('outputs/unified')).resolves.toEqual(['docker.com', 'openai.com'])
    await expect(openEmbeddedPolicyWindow('https://example.com/privacy')).resolves.toBe(true)
  })

  it('routes control-plane actions through the client layer', async () => {
    installScraperMock({
      clearResults: async () => ({ ok: true, removed: ['results.jsonl'], errors: [] }),
      deleteOutput: async () => ({ ok: true, path: 'outputs/run-1', removed: ['outputs/run-1'] }),
      deleteAllOutputs: async () => ({ ok: true, path: 'outputs', removed: ['outputs/run-1', 'outputs/run-2'] }),
      stopRun: async () => ({ ok: true, status: 'stopping' }),
      writeAuditState: async (payload) => ({
        ok: true,
        data: {
          verifiedSites: payload?.verifiedSites || [],
          urlOverrides: payload?.urlOverrides || {},
        },
      }),
      startRun: async () => ({ ok: true, paths: { outDir: 'outputs/run-2', resultsJsonl: 'r.jsonl', summaryJson: 's.json', stateJson: 'state.json', explorerJsonl: 'e.jsonl', artifactsDir: 'artifacts', artifactsOkDir: 'artifacts_ok' } }),
      readRunManifest: async () => ({ ok: true, data: { version: 1, status: 'running', mode: 'dataset', updatedAt: '2026-03-12T05:00:00+00:00' } }),
      rerunSite: async (options) => ({ ok: true, site: options.site }),
      annotateSite: async (options) => ({ ok: true, site: options.site }),
      startAnnotate: async () => ({ ok: true }),
      stopAnnotate: async () => ({ ok: true, status: 'stopped' }),
      openLogWindow: async () => ({ ok: true }),
      diagnoseBridge: async () => ({ ok: true, stdout: 'diagnose' }),
      repairBridge: async () => ({ ok: true, stdout: 'repair' }),
      refreshRemote: async () => ({ ok: true, stdout: 'refresh' }),
    })

    await expect(clearWorkspaceResults({ outDir: 'outputs/run-1' })).resolves.toEqual({
      ok: true,
      removed: ['results.jsonl'],
      errors: [],
    })
    await expect(deleteWorkspaceOutput('outputs/run-1')).resolves.toEqual({
      ok: true,
      path: 'outputs/run-1',
      removed: ['outputs/run-1'],
    })
    await expect(deleteAllWorkspaceOutputs()).resolves.toEqual({
      ok: true,
      path: 'outputs',
      removed: ['outputs/run-1', 'outputs/run-2'],
    })
    await expect(requestStopRun()).resolves.toEqual({ ok: true, status: 'stopping' })
    await expect(writeAuditState({
      outDir: 'outputs/run-1',
      verifiedSites: ['docker.com'],
      urlOverrides: { 'docker.com': 'https://docker.com/privacy' },
    })).resolves.toEqual({
      ok: true,
      data: {
        verifiedSites: ['docker.com'],
        urlOverrides: { 'docker.com': 'https://docker.com/privacy' },
      },
    })
    await expect(requestStartRun({ outDir: 'outputs/run-2', artifactsDir: 'outputs/run-2/artifacts', topN: 5 })).resolves.toEqual(expect.objectContaining({
      ok: true,
      paths: expect.objectContaining({ outDir: 'outputs/run-2' }),
    }))
    await expect(readRunManifest('outputs/run-2')).resolves.toEqual({
      ok: true,
      data: { version: 1, status: 'running', mode: 'dataset', updatedAt: '2026-03-12T05:00:00+00:00' },
    })
    await expect(requestRerunSite({ site: 'docker.com', outDir: 'outputs/run-1' })).resolves.toEqual({
      ok: true,
      site: 'docker.com',
    })
    await expect(requestAnnotateSite({ site: 'docker.com', outDir: 'outputs/run-1' })).resolves.toEqual({
      ok: true,
      site: 'docker.com',
    })
    await expect(requestStartAnnotate({ artifactsDir: 'outputs/run-1/artifacts', concurrency: 1 })).resolves.toEqual({ ok: true })
    await expect(requestStopAnnotate()).resolves.toEqual({ ok: true, status: 'stopped' })
    await expect(openLogWindow('logs', 'Run logs')).resolves.toEqual({ ok: true })
    await expect(runBridgeDiagnostics()).resolves.toEqual({ ok: true, stdout: 'diagnose' })
    await expect(runBridgeRepair()).resolves.toEqual({ ok: true, stdout: 'repair' })
    await expect(runRemoteRefresh()).resolves.toEqual({ ok: true, stdout: 'refresh' })
  })

  it('subscribes to scraper, annotator, and pipeline events through the client layer', () => {
    let runtimeEventHandler: Parameters<NonNullable<Window['scraper']>['onEvent']>[0] = () => {}
    let runtimeLogHandler: Parameters<NonNullable<Window['scraper']>['onLog']>[0] = () => {}
    let runtimeErrorHandler: Parameters<NonNullable<Window['scraper']>['onError']>[0] = () => {}
    let runtimeExitHandler: Parameters<NonNullable<Window['scraper']>['onExit']>[0] = () => {}
    let activitySnapshotHandler: Parameters<NonNullable<Window['scraper']>['onActivitySnapshot']>[0] = () => {}
    let annotatorLogHandler: Parameters<NonNullable<Window['scraper']>['onAnnotatorLog']>[0] = () => {}
    let annotatorStreamHandler: Parameters<NonNullable<Window['scraper']>['onAnnotatorStream']>[0] = () => {}
    let annotatorExitHandler: Parameters<NonNullable<Window['scraper']>['onAnnotatorExit']>[0] = () => {}
    let pipelineHandler: Parameters<NonNullable<Window['scraper']>['onPipelineEvent']>[0] = () => {}

    installScraperMock({
      onEvent: (handler) => { runtimeEventHandler = handler },
      onActivitySnapshot: (handler) => { activitySnapshotHandler = handler },
      onLog: (handler) => { runtimeLogHandler = handler },
      onError: (handler) => { runtimeErrorHandler = handler },
      onExit: (handler) => { runtimeExitHandler = handler },
      onAnnotatorLog: (handler) => { annotatorLogHandler = handler },
      onAnnotatorStream: (handler) => { annotatorStreamHandler = handler },
      onAnnotatorExit: (handler) => { annotatorExitHandler = handler },
      onPipelineEvent: (handler) => { pipelineHandler = handler },
    })

    const seen: string[] = []
    subscribeScraperEvents({
      onEvent: (event) => { seen.push(`runtime:${event.type}`) },
      onLog: (event) => { seen.push(`log:${event.message}`) },
      onError: (event) => { seen.push(`error:${event.message}`) },
      onExit: (event) => { seen.push(`exit:${event.code}`) },
    })
    subscribeAnnotatorEvents({
      onLog: (event) => { seen.push(`annotator-log:${event.message}`) },
      onStream: (event) => { seen.push(`annotator-stream:${event.site}`) },
      onExit: (event) => { seen.push(`annotator-exit:${event.code}`) },
    })
    subscribeScraperActivitySnapshots((snapshot) => {
      seen.push(`activity:${Object.keys(snapshot.activeSites).length}:${snapshot.running ? 'running' : 'idle'}`)
    })
    subscribePipelineEvents((event) => {
      seen.push(`pipeline:${event.channel}`)
    })

    runtimeEventHandler({ type: 'run_started' })
    activitySnapshotHandler({ activeSites: { 'docker.com': { label: 'Home fetch', stepIndex: 0, rank: 1 } }, recentCompleted: [], running: true })
    runtimeLogHandler({ message: 'hello' })
    runtimeErrorHandler({ message: 'boom' })
    runtimeExitHandler({ code: 0 })
    annotatorLogHandler({ message: 'annotator ready' })
    annotatorStreamHandler({ site: 'docker.com', chunk_idx: 1, chunk_total: 2, round: 1, phase: 'extraction', tag: 'delta', delta: '...' })
    annotatorExitHandler({ code: 0 })
    pipelineHandler({ channel: 'annotation', timestamp: '2026-03-12T05:00:00+00:00', payload: {}, message: 'updated' })

    expect(seen).toEqual([
      'runtime:run_started',
      'activity:1:running',
      'log:hello',
      'error:boom',
      'exit:0',
      'annotator-log:annotator ready',
      'annotator-stream:docker.com',
      'annotator-exit:0',
      'pipeline:annotation',
    ])
  })
})
