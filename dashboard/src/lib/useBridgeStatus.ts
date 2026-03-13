import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { HpcBridgeStatus, TunnelStatus } from '../contracts/api'
import { readBridgeStatus } from './scraperClient'

export type BridgeStatusModel = {
  tunnelStatus: TunnelStatus
  backendStatus: HpcBridgeStatus | null
  bridgeFailures: number
  bridgeCheckedAt: number | null
  bridgeHealthyAt: number | null
  dashboardLocked: boolean
  bridgeReady: boolean
  remoteCodeLegacy: boolean
  remoteCodeMismatch: boolean
  remoteCodeOutdated: boolean
  bridgeHeadline: string
  bridgeDetail: string
  refreshBridgeStatus: () => Promise<void>
}

export function buildBridgeNarrative({
  tunnelStatus,
  backendStatus,
  remoteCodeLegacy,
  remoteCodeMismatch,
  remoteCodeOutdated,
  workspaceReady,
  scraperActive,
}: {
  tunnelStatus: TunnelStatus
  backendStatus: HpcBridgeStatus | null
  remoteCodeLegacy: boolean
  remoteCodeMismatch: boolean
  remoteCodeOutdated: boolean
  workspaceReady: boolean
  scraperActive: boolean
}) {
  const headline = tunnelStatus === 'checking'
    ? 'Probing local tunnel'
    : tunnelStatus === 'offline'
      ? 'Tunnel offline'
      : tunnelStatus === 'degraded' && backendStatus?.local_port_listening && !backendStatus?.service_ready
        ? 'Tunnel attached to stale target'
      : remoteCodeOutdated
        ? 'Remote control plane is outdated'
      : !backendStatus?.service_ready
        ? 'Remote control plane booting'
        : !backendStatus?.database_ready
          ? 'PostgreSQL warming up'
          : scraperActive
            ? 'Cluster pipeline active'
            : workspaceReady
              ? 'Cluster workspace synchronized'
              : 'Bridge ready for launch'

  const detail = tunnelStatus === 'checking'
    ? 'Waiting for port 8910 to answer from the workstation side.'
    : tunnelStatus === 'offline'
      ? 'Start or restore the SSH tunnel before using the remote pipeline.'
      : tunnelStatus === 'degraded' && backendStatus?.local_port_listening && !backendStatus?.service_ready
        ? 'Local port 8910 is still forwarded, but the remote orchestrator behind that tunnel is not answering. Reattach the tunnel to the current compute node.'
      : remoteCodeLegacy
        ? 'The running orchestrator predates revision tracking and may still contain old annotation logic. Relaunch it with hpc/scraper/launch_remote.sh.'
      : remoteCodeMismatch
        ? `Local repo is at ${backendStatus?.local_source_rev}, but the connected orchestrator is ${backendStatus?.source_rev}. Relaunch the remote orchestrator to deploy the current annotation code.`
      : !backendStatus?.service_ready
        ? 'Tunnel is up, but the orchestrator API is still coming online.'
        : !backendStatus?.database_ready
          ? 'Control plane is reachable, but PostgreSQL has not finished initializing.'
          : scraperActive
            ? 'The workstation is attached to a live remote run and status is streaming from the cluster.'
            : workspaceReady
              ? 'Remote state is synced and downstream views are unlocked.'
              : 'Bridge is healthy. Launch a remote job to unlock the full workspace.'

  return { headline, detail }
}

export function useBridgeStatus({
  workspaceReady,
  scraperActive,
}: {
  workspaceReady: boolean
  scraperActive: boolean
}): BridgeStatusModel {
  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatus>('checking')
  const [backendStatus, setBackendStatus] = useState<HpcBridgeStatus | null>(null)
  const [bridgeFailures, setBridgeFailures] = useState(0)
  const [bridgeCheckedAt, setBridgeCheckedAt] = useState<number | null>(null)
  const [bridgeHealthyAt, setBridgeHealthyAt] = useState<number | null>(null)
  const refreshInFlightRef = useRef(false)

  const refreshBridgeStatus = useCallback(async () => {
    if (refreshInFlightRef.current) return
    refreshInFlightRef.current = true
    const checkedAt = Date.now()
    try {
      const res = await readBridgeStatus()
      setBridgeCheckedAt(checkedAt)
      if (res.ok) {
        setBackendStatus(res.data || null)
        setTunnelStatus('online')
        setBridgeFailures(0)
        setBridgeHealthyAt(checkedAt)
        return
      }
      setBackendStatus(res?.data || null)
      setBridgeFailures((prev) => {
        const next = prev + 1
        if (res?.data?.local_port_listening) {
          setTunnelStatus('degraded')
          return next
        }
        setTunnelStatus(bridgeHealthyAt && next < 2 ? 'degraded' : 'offline')
        return next
      })
    } finally {
      refreshInFlightRef.current = false
    }
  }, [bridgeHealthyAt])

  useEffect(() => {
    void refreshBridgeStatus()
    const id = setInterval(() => { void refreshBridgeStatus() }, 5_000)
    return () => clearInterval(id)
  }, [refreshBridgeStatus])

  const dashboardLocked = (
    tunnelStatus === 'checking'
    || tunnelStatus === 'offline'
    || !backendStatus?.service_ready
    || !backendStatus?.database_ready
    || Boolean(backendStatus?.dashboard_locked)
  )
  const bridgeReady = !dashboardLocked
  const remoteCodeLegacy = Boolean(backendStatus && tunnelStatus !== 'offline' && !backendStatus.source_rev)
  const remoteCodeMismatch = Boolean(
    backendStatus?.source_rev
    && backendStatus?.local_source_rev
    && backendStatus.source_rev !== backendStatus.local_source_rev
  )
  const remoteCodeOutdated = remoteCodeLegacy || remoteCodeMismatch

  const narrative = useMemo(() => buildBridgeNarrative({
    tunnelStatus,
    backendStatus,
    remoteCodeLegacy,
    remoteCodeMismatch,
    remoteCodeOutdated,
    workspaceReady,
    scraperActive,
  }), [backendStatus, remoteCodeLegacy, remoteCodeMismatch, remoteCodeOutdated, scraperActive, tunnelStatus, workspaceReady])

  return {
    tunnelStatus,
    backendStatus,
    bridgeFailures,
    bridgeCheckedAt,
    bridgeHealthyAt,
    dashboardLocked,
    bridgeReady,
    remoteCodeLegacy,
    remoteCodeMismatch,
    remoteCodeOutdated,
    bridgeHeadline: narrative.headline,
    bridgeDetail: narrative.detail,
    refreshBridgeStatus,
  }
}
