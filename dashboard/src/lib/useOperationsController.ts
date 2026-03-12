import { useCallback } from 'react'

import type { BridgeScriptResult } from '../contracts/api'
import {
  clearWorkspaceResults,
  deleteAllWorkspaceOutputs,
  deleteWorkspaceOutput,
  openLogWindow as showLogWindow,
  requestStopRun,
  runBridgeDiagnostics,
  runBridgeRepair,
  runRemoteRefresh,
} from './scraperClient'

type BridgeActionKind = 'diagnose' | 'repair' | 'refresh'

type UseOperationsControllerArgs = {
  defaultOutDir: string
  outDir: string
  runsRoot: string
  logs: string[]
  scraperActive: boolean
  stopRunPending: boolean
  refreshRuns: () => Promise<void>
  refreshBridgeStatus: () => Promise<void>
  resetLoadedOutputState: (nextOutDir?: string) => void
  appendScraperLog: (message: string) => void
  setClearing: (value: boolean) => void
  setErrorMessage: (value: string | null) => void
  setStopRunPending: (value: boolean) => void
  setBridgeActionBusy: (value: BridgeActionKind | null) => void
  setBridgeActionMessage: (value: string | null) => void
}

export function validateDeleteOutDirTarget(targetDir: string, runsRoot: string): string | null {
  if (!targetDir) {
    return 'No output folder is selected.'
  }
  if (targetDir === runsRoot) {
    return 'Refusing to delete the outputs root. Load a specific run folder instead.'
  }
  return null
}

export function formatBridgeScriptOutput(title: string, result: BridgeScriptResult): string {
  const d = result.diagnostics
  const diagnosticsSection = d
    ? [
        '',
        'DIAGNOSTICS:',
        `  Health OK:     ${d.health_ok}`,
        `  Service port:  ${d.service_port}`,
        `  Local target:  ${d.local_target ?? '(none)'}`,
        `  Remote node:   ${d.remote_node ?? '(unavailable)'}`,
        `  SSH status:    ${d.ssh_status === 0 ? 'ok' : `error (${d.ssh_status})`}`,
        d.local_tunnels.length ? `  Tunnels:       ${d.local_tunnels.length} active` : `  Tunnels:       (none)`,
        d.rev_match != null
          ? `  Rev match:     ${d.rev_match ? 'yes' : `NO (local=${d.local_rev ?? '?'}, remote=${d.remote_rev ?? '?'})`}`
          : null,
      ].filter(Boolean)
    : []
  return [
    title,
    '',
    result.command ? `Command: ${result.command}` : null,
    typeof result.code === 'number' ? `Exit code: ${result.code}` : null,
    result.signal ? `Signal: ${result.signal}` : null,
    typeof result.killed === 'boolean' ? `Killed: ${result.killed}` : null,
    result.hint ? `Hint: ${result.hint}` : null,
    result.error ? `Error: ${result.error}` : null,
    ...diagnosticsSection,
    '',
    'STDOUT:',
    result.stdout?.trim() || '(empty)',
    '',
    'STDERR:',
    result.stderr?.trim() || '(empty)',
  ].filter(Boolean).join('\n')
}

export function useOperationsController({
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
}: UseOperationsControllerArgs) {
  const clearResults = useCallback(async (includeArtifacts?: boolean) => {
    setClearing(true)
    try {
      const res = await clearWorkspaceResults({ includeArtifacts, outDir })
      if (res.error === 'clearResults API unavailable') {
        resetLoadedOutputState()
        return
      }
      if (!res.ok) {
        setErrorMessage(res.error || 'Failed to clear results')
      } else {
        resetLoadedOutputState()
      }
    } finally {
      setClearing(false)
    }
  }, [outDir, resetLoadedOutputState, setClearing, setErrorMessage])

  const deleteOutDir = useCallback(async () => {
    const targetDir = String(outDir || '').trim()
    const validationError = validateDeleteOutDirTarget(targetDir, runsRoot)
    if (validationError) {
      setErrorMessage(validationError)
      return
    }
    if (!window.confirm(`Delete output folder "${targetDir}" and everything inside it?`)) {
      return
    }
    setClearing(true)
    try {
      const res = await deleteWorkspaceOutput(targetDir)
      if (!res.ok) {
        setErrorMessage(res.error || 'Failed to delete output folder')
      } else {
        setErrorMessage(null)
        resetLoadedOutputState(defaultOutDir)
        await refreshRuns()
      }
    } finally {
      setClearing(false)
    }
  }, [defaultOutDir, outDir, refreshRuns, resetLoadedOutputState, runsRoot, setClearing, setErrorMessage])

  const deleteAllOutputs = useCallback(async () => {
    if (!window.confirm(`Delete every folder inside "${runsRoot}"?`)) {
      return
    }
    setClearing(true)
    try {
      const res = await deleteAllWorkspaceOutputs()
      if (!res.ok) {
        setErrorMessage(res.error || 'Failed to delete all outputs')
      } else {
        setErrorMessage(null)
        resetLoadedOutputState(defaultOutDir)
        await refreshRuns()
      }
    } finally {
      setClearing(false)
    }
  }, [defaultOutDir, refreshRuns, resetLoadedOutputState, runsRoot, setClearing, setErrorMessage])

  const stopRun = useCallback(async () => {
    if (stopRunPending) return
    if (!scraperActive) {
      setErrorMessage('No active scraper run is currently attached to the dashboard.')
      return
    }
    if (!window.confirm('Stop the current scrape run and keep partial results?')) return
    setStopRunPending(true)
    appendScraperLog('Stop requested')
    const res = await requestStopRun()
    if (!res.ok) {
      setStopRunPending(false)
      if (res.error === 'not_running') {
        setErrorMessage(null)
        appendScraperLog('Scraper already stopped')
        await refreshBridgeStatus()
        return
      }
      setErrorMessage(res.error || 'Failed to stop scraper')
      return
    }
    appendScraperLog(res.status === 'stopping' ? 'Stop already in progress' : 'Stop signal sent')
  }, [
    appendScraperLog,
    refreshBridgeStatus,
    scraperActive,
    setErrorMessage,
    setStopRunPending,
    stopRunPending,
  ])

  const openLogWindow = useCallback(async () => {
    const content = logs.length ? logs.join('\n') : 'No logs yet.'
    await showLogWindow(content, 'Run logs')
  }, [logs])

  const runBridgeAction = useCallback(async ({
    kind,
    pendingMessage,
    title,
    successMessage,
    degradedMessage,
    failureMessage,
    invoke,
    showSuccessLogs = false,
  }: {
    kind: BridgeActionKind
    pendingMessage: string
    title: string
    successMessage: string
    degradedMessage: string
    failureMessage: string
    invoke: () => Promise<BridgeScriptResult>
    showSuccessLogs?: boolean
  }) => {
    setBridgeActionBusy(kind)
    setBridgeActionMessage(pendingMessage)
    try {
      const result = await invoke()
      const shouldShowLog = showSuccessLogs || !result.ok || !result.health_ok
      if (shouldShowLog) {
        await showLogWindow(formatBridgeScriptOutput(title, result), title)
      }
      setBridgeActionMessage(
        result.ok
          ? result.health_ok === false
            ? result.hint || degradedMessage
            : successMessage
          : result.hint || failureMessage
      )
    } finally {
      setBridgeActionBusy(null)
      await refreshBridgeStatus()
    }
  }, [refreshBridgeStatus, setBridgeActionBusy, setBridgeActionMessage])

  const diagnoseBridge = useCallback(async () => {
    await runBridgeAction({
      kind: 'diagnose',
      pendingMessage: 'Running bridge diagnostics...',
      title: 'Bridge diagnostics',
      successMessage: 'Bridge diagnostics completed.',
      degradedMessage: 'Bridge diagnostics completed.',
      failureMessage: 'Bridge diagnostics found a problem. Review the diagnostics window.',
      invoke: runBridgeDiagnostics,
      showSuccessLogs: true,
    })
  }, [runBridgeAction])

  const repairBridge = useCallback(async () => {
    await runBridgeAction({
      kind: 'repair',
      pendingMessage: 'Repairing bridge tunnel...',
      title: 'Bridge repair',
      successMessage: 'Bridge repaired and health probe is responding.',
      degradedMessage: 'Tunnel reopened, but the orchestrator is still not answering.',
      failureMessage: 'Bridge repair failed. Review the bridge repair log.',
      invoke: runBridgeRepair,
    })
  }, [runBridgeAction])

  const refreshRemote = useCallback(async () => {
    await runBridgeAction({
      kind: 'refresh',
      pendingMessage: 'Refreshing remote orchestrator...',
      title: 'Remote refresh',
      successMessage: 'Remote orchestrator refreshed. Re-checking bridge health...',
      degradedMessage: 'Remote orchestrator refreshed. Re-checking bridge health...',
      failureMessage: 'Remote refresh failed. Review the remote refresh log.',
      invoke: runRemoteRefresh,
    })
  }, [runBridgeAction])

  return {
    clearResults,
    deleteOutDir,
    deleteAllOutputs,
    stopRun,
    openLogWindow,
    diagnoseBridge,
    repairBridge,
    refreshRemote,
  }
}
