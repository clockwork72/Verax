import { describe, expect, it } from 'vitest'

import { formatBridgeScriptOutput, validateDeleteOutDirTarget } from './useOperationsController'

describe('useOperationsController helpers', () => {
  it('formats bridge script output with metadata and fallback sections', () => {
    const output = formatBridgeScriptOutput('Bridge diagnostics', {
      ok: false,
      command: 'bash script.sh',
      code: 1,
      signal: 'SIGTERM',
      killed: true,
      hint: 'Retry the tunnel attach.',
      error: 'bridge offline',
      stdout: 'hello\n',
      stderr: '',
    })

    expect(output).toContain('Bridge diagnostics')
    expect(output).toContain('Command: bash script.sh')
    expect(output).toContain('Exit code: 1')
    expect(output).toContain('Signal: SIGTERM')
    expect(output).toContain('Killed: true')
    expect(output).toContain('Hint: Retry the tunnel attach.')
    expect(output).toContain('Error: bridge offline')
    expect(output).toContain('STDOUT:\nhello')
    expect(output).toContain('STDERR:\n(empty)')
  })

  it('rejects invalid delete targets and allows specific output folders', () => {
    expect(validateDeleteOutDirTarget('', 'outputs')).toBe('No output folder is selected.')
    expect(validateDeleteOutDirTarget('outputs', 'outputs')).toBe(
      'Refusing to delete the outputs root. Load a specific run folder instead.',
    )
    expect(validateDeleteOutDirTarget('outputs/unified', 'outputs')).toBeNull()
  })
})
