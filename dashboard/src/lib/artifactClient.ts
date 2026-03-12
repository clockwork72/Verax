function getScraperBridge() {
  return window.scraper ?? null
}

export type ArtifactTextResponse = {
  ok: boolean
  data?: string
  error?: string
  path?: string
}

type ReadArtifactTextOptions = {
  outDir?: string
  relativePath: string
}

type ReadPolicyTextWithMethodOptions = {
  outDir?: string
  basePath: string
}

export async function readArtifactText({
  outDir,
  relativePath,
}: ReadArtifactTextOptions): Promise<ArtifactTextResponse> {
  const scraper = getScraperBridge()
  if (!scraper?.readArtifactText) {
    return { ok: false, error: 'readArtifactText unavailable' }
  }
  const result = await scraper.readArtifactText({ outDir, relativePath })
  if (!result?.ok || typeof result.data !== 'string') {
    return { ok: false, error: result?.error || 'artifact_not_found', path: result?.path }
  }
  return { ok: true, data: result.data, path: result.path }
}

export async function readArtifactTexts(
  outDir: string | undefined,
  relativePaths: string[],
): Promise<Record<string, ArtifactTextResponse>> {
  const entries = await Promise.all(
    relativePaths.map(async (relativePath) => [relativePath, await readArtifactText({ outDir, relativePath })] as const),
  )
  return Object.fromEntries(entries)
}

export async function readPreferredStatementText({
  outDir,
  basePath,
}: ReadPolicyTextWithMethodOptions): Promise<string | null> {
  const responses = await readArtifactTexts(outDir, [
    `${basePath}/policy_statements_annotated.jsonl`,
    `${basePath}/policy_statements.jsonl`,
  ])
  return responses[`${basePath}/policy_statements_annotated.jsonl`]?.data
    ?? responses[`${basePath}/policy_statements.jsonl`]?.data
    ?? null
}

export async function readPolicyTextWithMethod({
  outDir,
  basePath,
}: ReadPolicyTextWithMethodOptions): Promise<{ policyText: string; method: string | null; error?: string }> {
  const responses = await readArtifactTexts(outDir, [
    `${basePath}/policy.txt`,
    `${basePath}/policy.extraction.json`,
  ])
  const policyText = responses[`${basePath}/policy.txt`]?.data ?? ''
  const methodRaw = responses[`${basePath}/policy.extraction.json`]?.data
  let method: string | null = null
  if (methodRaw) {
    try {
      const parsed = JSON.parse(methodRaw)
      method = typeof parsed?.method === 'string' ? parsed.method : null
    } catch {
      method = null
    }
  }
  return {
    policyText,
    method,
    error: policyText ? undefined : responses[`${basePath}/policy.txt`]?.error || 'policy_text_not_found',
  }
}
