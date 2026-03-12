import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { LauncherView } from './LauncherView'

describe('LauncherView', () => {
  it('renders bridge and annotation state from typed props', () => {
    render(
      <LauncherView
        topN="100"
        onTopNChange={() => {}}
        onStart={() => {}}
        hasRun
        running={false}
        progress={42}
        resultsReady
        onViewResults={() => {}}
        tunnelStatus="online"
        bridgeReady
        bridgeHeadline="Bridge stable"
        bridgeDetail="Remote orchestrator healthy."
        bridgeNode="slurm-compute-a1"
        bridgeCurrentOutDir="outputs/unified"
        bridgeCheckedAt="just now"
        bridgeHealthyAt="just now"
        annotateRunning={false}
        annotationStats={{
          ok: true,
          total_sites: 10,
          annotated_sites: 4,
          total_statements: 17,
          per_site: [],
          tp_total: 0,
          tp_annotated: 0,
          tp_total_statements: 0,
          per_tp: [],
        }}
        latestStreamEvent={null}
        onStartAnnotate={vi.fn()}
      />
    )

    // Bridge headline and detail are rendered directly
    expect(screen.getByText('Bridge stable')).toBeInTheDocument()
    expect(screen.getByText('Remote orchestrator healthy.')).toBeInTheDocument()
    // Crawler section title
    expect(screen.getByText('Dataset crawler')).toBeInTheDocument()
    // Annotation stats section header is present
    expect(screen.getByText('Policy annotation')).toBeInTheDocument()
  })
})
