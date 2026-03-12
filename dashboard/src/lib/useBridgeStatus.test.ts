import { describe, expect, it } from 'vitest'

import { buildBridgeNarrative } from './useBridgeStatus'

describe('buildBridgeNarrative', () => {
  it('reports stale target tunnels clearly', () => {
    const narrative = buildBridgeNarrative({
      tunnelStatus: 'degraded',
      backendStatus: { local_port_listening: true, service_ready: false },
      remoteCodeLegacy: false,
      remoteCodeMismatch: false,
      remoteCodeOutdated: false,
      workspaceReady: false,
      scraperActive: false,
    })

    expect(narrative.headline).toBe('Tunnel attached to stale target')
    expect(narrative.detail).toContain('Reattach the tunnel')
  })

  it('reports remote revision mismatch ahead of generic ready state', () => {
    const narrative = buildBridgeNarrative({
      tunnelStatus: 'online',
      backendStatus: {
        service_ready: true,
        database_ready: true,
        source_rev: 'old123',
        local_source_rev: 'new456',
      },
      remoteCodeLegacy: false,
      remoteCodeMismatch: true,
      remoteCodeOutdated: true,
      workspaceReady: true,
      scraperActive: false,
    })

    expect(narrative.headline).toBe('Remote control plane is outdated')
    expect(narrative.detail).toContain('Local repo is at new456')
  })
})
