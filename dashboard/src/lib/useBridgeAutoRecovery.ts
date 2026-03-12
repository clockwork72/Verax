import { useEffect, useRef } from 'react'

import type { BridgeDiagnostics, BridgeScriptResult, TunnelStatus } from '../contracts/api'
import { runBridgeDiagnostics } from './scraperClient'

type BridgeActionKind = 'diagnose' | 'repair' | 'refresh' | null

export function shouldAutoRefreshRemote({
  tunnelStatus,
  bridgeFailures,
  bridgeActionBusy,
  diagnostics,
}: {
  tunnelStatus: TunnelStatus
  bridgeFailures: number
  bridgeActionBusy: BridgeActionKind
  diagnostics: BridgeDiagnostics | undefined
}) {
  return (
    tunnelStatus === 'offline'
    && bridgeFailures >= 2
    && bridgeActionBusy === null
    && diagnostics?.ssh_status === 0
    && diagnostics.remote_node === null
  )
}

export function useBridgeAutoRecovery({
  tunnelStatus,
  bridgeFailures,
  bridgeActionBusy,
  refreshRemote,
}: {
  tunnelStatus: TunnelStatus
  bridgeFailures: number
  bridgeActionBusy: BridgeActionKind
  refreshRemote: () => Promise<void>
}) {
  const inspectedCurrentOutageRef = useRef(false)

  useEffect(() => {
    if (tunnelStatus === 'online') {
      inspectedCurrentOutageRef.current = false
    }
  }, [tunnelStatus])

  useEffect(() => {
    if (tunnelStatus !== 'offline' || bridgeFailures < 2 || bridgeActionBusy !== null || inspectedCurrentOutageRef.current) {
      return
    }

    inspectedCurrentOutageRef.current = true
    let cancelled = false

    void runBridgeDiagnostics()
      .then((result: BridgeScriptResult) => {
        if (cancelled) return
        if (shouldAutoRefreshRemote({
          tunnelStatus,
          bridgeFailures,
          bridgeActionBusy,
          diagnostics: result.diagnostics,
        })) {
          void refreshRemote()
        }
      })
      .catch(() => {
        // Leave manual recovery available; avoid noisy automatic error paths.
      })

    return () => {
      cancelled = true
    }
  }, [bridgeActionBusy, bridgeFailures, refreshRemote, tunnelStatus])
}
