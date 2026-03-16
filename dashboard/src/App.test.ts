import { describe, expect, it } from 'vitest'

import { buildDisabledNavs, shouldAutoLoadWorkspace } from './App'

describe('App navigation gating', () => {
  it('keeps read-only workspace views available when a dataset is already loaded', () => {
    const disabled = buildDisabledNavs({
      bridgeReady: false,
      hasWorkspaceContent: true,
    })

    expect(disabled.database).toBe(true)
    expect(disabled.results).toBe(false)
    expect(disabled.audit).toBe(false)
    expect(disabled.explorer).toBe(false)
    expect(disabled.annotations).toBe(false)
    expect(disabled.consistency).toBe(false)
  })

  it('locks workspace views when there is no loaded dataset', () => {
    const disabled = buildDisabledNavs({
      bridgeReady: false,
      hasWorkspaceContent: false,
    })

    expect(disabled.results).toBe(true)
    expect(disabled.audit).toBe(true)
    expect(disabled.explorer).toBe(true)
    expect(disabled.annotations).toBe(true)
    expect(disabled.consistency).toBe(true)
  })

  it('auto-loads the current workspace when the bridge is ready and nothing is loaded yet', () => {
    expect(shouldAutoLoadWorkspace({
      bridgeReady: true,
      running: false,
      hasRun: false,
      hasDataset: false,
      hasSummaryOrState: false,
    })).toBe(true)

    expect(shouldAutoLoadWorkspace({
      bridgeReady: true,
      running: false,
      hasRun: false,
      hasDataset: true,
      hasSummaryOrState: false,
    })).toBe(false)

    expect(shouldAutoLoadWorkspace({
      bridgeReady: false,
      running: false,
      hasRun: false,
      hasDataset: false,
      hasSummaryOrState: false,
    })).toBe(false)
  })
})
