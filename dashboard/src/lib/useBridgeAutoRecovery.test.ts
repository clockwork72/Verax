import { describe, expect, it } from 'vitest'

import { shouldAutoRefreshRemote } from './useBridgeAutoRecovery'

describe('shouldAutoRefreshRemote', () => {
  it('returns true when the bridge is offline and no remote orchestrator is running', () => {
    expect(shouldAutoRefreshRemote({
      tunnelStatus: 'offline',
      bridgeFailures: 2,
      bridgeActionBusy: null,
      diagnostics: {
        service_port: 8910,
        health_ok: false,
        health_raw: '',
        local_target: null,
        remote_node: null,
        ssh_status: 0,
        local_tunnels: [],
      },
    })).toBe(true)
  })

  it('returns false when a remote orchestrator already exists or the bridge is still probing', () => {
    expect(shouldAutoRefreshRemote({
      tunnelStatus: 'offline',
      bridgeFailures: 3,
      bridgeActionBusy: null,
      diagnostics: {
        service_port: 8910,
        health_ok: false,
        health_raw: '',
        local_target: null,
        remote_node: 'slurm-compute-a1',
        ssh_status: 0,
        local_tunnels: [],
      },
    })).toBe(false)

    expect(shouldAutoRefreshRemote({
      tunnelStatus: 'checking',
      bridgeFailures: 3,
      bridgeActionBusy: null,
      diagnostics: {
        service_port: 8910,
        health_ok: false,
        health_raw: '',
        local_target: null,
        remote_node: null,
        ssh_status: 0,
        local_tunnels: [],
      },
    })).toBe(false)
  })
})
