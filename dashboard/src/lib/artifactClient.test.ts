import { afterEach, describe, expect, it } from 'vitest'

import {
  readArtifactText,
  readArtifactTexts,
  readPolicyTextWithMethod,
  readPreferredStatementText,
} from './artifactClient'

function installScraperMock(overrides: Partial<NonNullable<Window['scraper']>>) {
  window.scraper = {
    readArtifactText: async (options) => ({ ok: false, error: `missing:${options?.relativePath || ''}` }),
    ...overrides,
  } as Window['scraper']
}

afterEach(() => {
  delete window.scraper
})

describe('artifactClient', () => {
  it('reads a single artifact and normalizes failures', async () => {
    installScraperMock({
      readArtifactText: async (options) => (
        options?.relativePath === 'artifacts/docker.com/policy.txt'
          ? { ok: true, data: 'policy text', path: options.relativePath }
          : { ok: false, error: 'not_found', path: options?.relativePath }
      ),
    })

    await expect(readArtifactText({
      outDir: 'outputs/unified',
      relativePath: 'artifacts/docker.com/policy.txt',
    })).resolves.toEqual({
      ok: true,
      data: 'policy text',
      path: 'artifacts/docker.com/policy.txt',
    })

    await expect(readArtifactText({
      outDir: 'outputs/unified',
      relativePath: 'artifacts/docker.com/missing.txt',
    })).resolves.toEqual({
      ok: false,
      error: 'not_found',
      path: 'artifacts/docker.com/missing.txt',
    })
  })

  it('prefers annotated statement artifacts over base statements', async () => {
    installScraperMock({
      readArtifactText: async (options) => {
        const relativePath = options?.relativePath || ''
        if (relativePath.endsWith('policy_statements_annotated.jsonl')) {
          return { ok: true, data: '{"statement":true}' }
        }
        if (relativePath.endsWith('policy_statements.jsonl')) {
          return { ok: true, data: '{"fallback":true}' }
        }
        return { ok: false, error: 'not_found' }
      },
    })

    await expect(readPreferredStatementText({
      outDir: 'outputs/unified',
      basePath: 'artifacts/docker.com',
    })).resolves.toBe('{"statement":true}')
  })

  it('reads policy text and extraction method together', async () => {
    installScraperMock({
      readArtifactText: async (options) => {
        const relativePath = options?.relativePath || ''
        if (relativePath.endsWith('/policy.txt')) return { ok: true, data: 'policy text' }
        if (relativePath.endsWith('/policy.extraction.json')) return { ok: true, data: '{"method":"trafilatura"}' }
        return { ok: false, error: 'not_found' }
      },
    })

    await expect(readPolicyTextWithMethod({
      outDir: 'outputs/unified',
      basePath: 'artifacts/docker.com',
    })).resolves.toEqual({
      policyText: 'policy text',
      method: 'trafilatura',
      error: undefined,
    })
  })

  it('reads batches through the same client path', async () => {
    installScraperMock({
      readArtifactText: async (options) => ({ ok: true, data: options?.relativePath || '' }),
    })

    const batch = await readArtifactTexts('outputs/unified', [
      'artifacts/docker.com/policy.txt',
      'artifacts/docker.com/document.json',
    ])

    expect(batch['artifacts/docker.com/policy.txt']?.data).toBe('artifacts/docker.com/policy.txt')
    expect(batch['artifacts/docker.com/document.json']?.data).toBe('artifacts/docker.com/document.json')
  })
})
