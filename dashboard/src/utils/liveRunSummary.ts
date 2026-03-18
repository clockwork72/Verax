import type {
  ResultRecord,
  RunSummary,
  RunMappingSummary,
  RunSummaryCategory,
  RunSummaryEntity,
  RunSummaryStatusCounts,
  RunThirdPartySummary,
  ThirdPartyResultRecord,
} from '../contracts/api'
import type { ExplorerSite, ExplorerThirdParty } from '../data/explorer'
import { CATEGORY_ORDER, normalizeCategory } from './trackerCategories'

export type LiveRunSummary = {
  processed_sites: number
  success_rate: number
  status_counts: RunSummaryStatusCounts
  third_party: RunThirdPartySummary
  mapping: RunMappingSummary
  site_categories: RunSummaryCategory[]
  categories: RunSummaryCategory[]
  entities: RunSummaryEntity[]
  english_policy_count: number
}

export function resolveRunSummary(
  summary: RunSummary | null | undefined,
  liveSummary: LiveRunSummary | null | undefined,
  fallbackMode?: RunMappingSummary['mode'],
): RunSummary | null {
  if (!summary && !liveSummary) return null
  if (!liveSummary) return summary ?? null

  const persistedProcessedSites = Number(summary?.processed_sites ?? 0)
  if (summary && persistedProcessedSites > liveSummary.processed_sites) {
    return summary
  }

  return {
    run_id: summary?.run_id,
    total_sites: Number(summary?.total_sites ?? 0),
    processed_sites: liveSummary.processed_sites,
    success_rate: liveSummary.success_rate,
    status_counts: liveSummary.status_counts,
    third_party: liveSummary.third_party,
    english_policy_count: liveSummary.english_policy_count,
    site_categories: liveSummary.site_categories,
    mapping: {
      ...liveSummary.mapping,
      mode: summary?.mapping?.mode ?? fallbackMode ?? liveSummary.mapping.mode ?? null,
    },
    categories: liveSummary.categories,
    entities: liveSummary.entities,
    started_at: summary?.started_at,
    updated_at: summary?.updated_at,
  }
}

type NormalizedThirdParty = {
  domain: string | null
  entity: string | null
  policyUrl: string | null
  categories: string[]
  prevalence: number | null
  radarMapped: boolean
  trackerdbMapped: boolean
}

function normalizeSiteKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function normalizePolicyUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  const raw = value.trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    const path = url.pathname || '/'
    const port = url.port
    const defaultPort = (url.protocol === 'http:' && port === '80') || (url.protocol === 'https:' && port === '443')
    const host = url.hostname.toLowerCase()
    const netloc = defaultPort || !port ? host : `${host}:${port}`
    return `${url.protocol}//${netloc}${path}${url.search}`
  } catch {
    return raw
  }
}

function serviceKeyFromThirdParty(tp: NormalizedThirdParty): string {
  if (tp.domain) return tp.domain
  if (tp.entity) return `entity:${tp.entity.trim().toLowerCase()}`
  const normalizedPolicyUrl = normalizePolicyUrl(tp.policyUrl)
  return normalizedPolicyUrl || ''
}

function uniqueCountKeyFromThirdParty(tp: NormalizedThirdParty): string {
  const normalizedPolicyUrl = normalizePolicyUrl(tp.policyUrl)
  if (normalizedPolicyUrl) return normalizedPolicyUrl
  if (tp.domain) return tp.domain
  if (tp.entity) return `entity:${tp.entity.trim().toLowerCase()}`
  return ''
}

function resultThirdParties(record: ResultRecord): NormalizedThirdParty[] {
  const thirdParties = Array.isArray(record.third_parties) ? record.third_parties : []
  return thirdParties
    .filter((tp): tp is ThirdPartyResultRecord => Boolean(tp && typeof tp === 'object'))
    .map((tp) => ({
      domain: typeof tp.third_party_etld1 === 'string' && tp.third_party_etld1.trim()
        ? tp.third_party_etld1.trim().toLowerCase()
        : null,
      entity: typeof tp.entity === 'string' && tp.entity.trim() ? tp.entity.trim() : null,
      policyUrl: typeof tp.policy_url === 'string' && tp.policy_url.trim() ? tp.policy_url.trim() : null,
      categories: Array.isArray(tp.categories)
        ? [...new Set(tp.categories.filter((category): category is string => typeof category === 'string' && Boolean(category.trim())).map(normalizeCategory))]
        : [],
      prevalence: typeof tp.prevalence === 'number' && Number.isFinite(tp.prevalence) ? tp.prevalence : null,
      radarMapped: Boolean(tp.tracker_radar_source_domain_file),
      trackerdbMapped: Boolean(tp.trackerdb_source_pattern_file || tp.trackerdb_source_org_file),
    }))
}

function explorerThirdParties(site: ExplorerSite): NormalizedThirdParty[] {
  return (site.thirdParties || [])
    .filter((tp): tp is ExplorerThirdParty => Boolean(tp && typeof tp === 'object' && tp.name))
    .map((tp) => ({
      domain: typeof tp.name === 'string' && tp.name.trim() ? tp.name.trim().toLowerCase() : null,
      entity: typeof tp.entity === 'string' && tp.entity.trim() ? tp.entity.trim() : null,
      policyUrl: typeof tp.policyUrl === 'string' && tp.policyUrl.trim() ? tp.policyUrl.trim() : null,
      categories: Array.isArray(tp.categories)
        ? [...new Set(tp.categories.filter((category): category is string => typeof category === 'string' && Boolean(category.trim())).map(normalizeCategory))]
        : [],
      prevalence: typeof tp.prevalence === 'number' && Number.isFinite(tp.prevalence) ? tp.prevalence : null,
      radarMapped: false,
      trackerdbMapped: false,
    }))
}

function finalizeCategories(categoryCounts: Map<string, number>): RunSummaryCategory[] {
  return [...categoryCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => {
      const aIndex = CATEGORY_ORDER.indexOf(a.name)
      const bIndex = CATEGORY_ORDER.indexOf(b.name)
      if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex
      if (aIndex !== -1) return -1
      if (bIndex !== -1) return 1
      return b.count - a.count
    })
    .slice(0, 20)
}

function finalizeEntities(
  entityCounts: Map<string, number>,
  prevalenceSums: Map<string, number>,
  prevalenceMax: Map<string, number>,
  entityCategories: Map<string, Map<string, number>>,
): RunSummaryEntity[] {
  return [...entityCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => {
      const categories = [...(entityCategories.get(name)?.entries() ?? [])]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([category]) => category)
      const maxPrevalence = prevalenceMax.get(name)
      const prevalenceSum = prevalenceSums.get(name)
      return {
        name,
        count,
        prevalence_avg: typeof prevalenceSum === 'number' ? prevalenceSum / Math.max(1, count) : null,
        prevalence_max: typeof maxPrevalence === 'number' ? maxPrevalence : null,
        categories,
      }
    })
}

export function deriveLiveRunSummary(
  records: ResultRecord[] | null | undefined,
  sites: ExplorerSite[] | null | undefined,
): LiveRunSummary | null {
  const finalResultRecords = new Map<string, ResultRecord>()
  for (const [index, record] of (records || []).entries()) {
    if (!record || typeof record !== 'object') continue
    const siteKey = normalizeSiteKey(record.site_etld1 || record.input || record.site) || `record:${index}`
    finalResultRecords.set(siteKey, record)
  }

  const finalExplorerSites = new Map<string, ExplorerSite>()
  for (const [index, site] of (sites || []).entries()) {
    if (!site || typeof site !== 'object') continue
    const siteKey = normalizeSiteKey(site.site) || `site:${index}`
    finalExplorerSites.set(siteKey, site)
  }

  const statusCounts = new Map<string, number>()
  const uniqueDomains = new Set<string>()
  const uniqueMappedDomains = new Set<string>()
  const uniquePolicyDomains = new Set<string>()
  const uniqueRadarDomains = new Set<string>()
  const uniqueTrackerdbDomains = new Set<string>()
  const uniqueUnmappedDomains = new Set<string>()
  const siteCategoryCounts = new Map<string, number>()
  const categoryCounts = new Map<string, number>()
  const categoryServicePairs = new Set<string>()
  const entityCounts = new Map<string, number>()
  const entityPrevalenceSums = new Map<string, number>()
  const entityPrevalenceMax = new Map<string, number>()
  const entityCategories = new Map<string, Map<string, number>>()

  let processedSites = 0
  let okSites = 0
  let englishPolicyCount = 0
  let totalThirdPartyOccurrences = 0
  let mappedOccurrences = 0
  let unmappedOccurrences = 0
  let noPolicyUrlOccurrences = 0
  let radarMappedOccurrences = 0
  let trackerdbMappedOccurrences = 0

  const sourceSites = finalResultRecords.size > 0 ? [...finalResultRecords.values()] : [...finalExplorerSites.values()]
  if (sourceSites.length === 0) {
    return null
  }

  for (const site of sourceSites) {
    processedSites += 1
    const rawStatus = typeof (site as ResultRecord).status === 'string'
      ? (site as ResultRecord).status
      : typeof (site as ExplorerSite).status === 'string'
        ? (site as ExplorerSite).status
        : 'unknown'
    const status = rawStatus || 'unknown'
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1)
    if (status === 'ok') okSites += 1
    if ('policy_is_english' in site && (site as ResultRecord).policy_is_english) {
      englishPolicyCount += 1
    }
    const mainCategory = finalResultRecords.size > 0
      ? (typeof (site as ResultRecord).main_category === 'string' ? (site as ResultRecord).main_category : null)
      : (typeof (site as ExplorerSite).mainCategory === 'string' ? (site as ExplorerSite).mainCategory : null)
    if (mainCategory && mainCategory.trim()) {
      siteCategoryCounts.set(mainCategory, (siteCategoryCounts.get(mainCategory) ?? 0) + 1)
    }

    const thirdParties = finalResultRecords.size > 0
      ? resultThirdParties(site as ResultRecord)
      : explorerThirdParties(site as ExplorerSite)

    for (const tp of thirdParties) {
      totalThirdPartyOccurrences += 1
      const uniqueKey = uniqueCountKeyFromThirdParty(tp)
      if (uniqueKey) uniqueDomains.add(uniqueKey)

      const mapped = tp.radarMapped || tp.trackerdbMapped || Boolean(tp.entity || tp.policyUrl || tp.prevalence || tp.categories.length > 0)
      if (mapped) {
        mappedOccurrences += 1
        if (uniqueKey) uniqueMappedDomains.add(uniqueKey)
      } else {
        unmappedOccurrences += 1
        if (uniqueKey) uniqueUnmappedDomains.add(uniqueKey)
      }

      if (mapped && !tp.policyUrl) {
        noPolicyUrlOccurrences += 1
      } else if (mapped && tp.policyUrl && uniqueKey) {
        uniquePolicyDomains.add(uniqueKey)
      }

      if (tp.radarMapped) {
        radarMappedOccurrences += 1
        if (uniqueKey) uniqueRadarDomains.add(uniqueKey)
      } else if (tp.trackerdbMapped) {
        trackerdbMappedOccurrences += 1
        if (uniqueKey) uniqueTrackerdbDomains.add(uniqueKey)
      }

      const serviceKey = serviceKeyFromThirdParty(tp)
      for (const category of tp.categories) {
        if (!serviceKey) {
          categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1)
          continue
        }
        const pairKey = `${serviceKey}::${category}`
        if (categoryServicePairs.has(pairKey)) continue
        categoryServicePairs.add(pairKey)
        categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1)
      }

      if (tp.entity) {
        entityCounts.set(tp.entity, (entityCounts.get(tp.entity) ?? 0) + 1)
        if (typeof tp.prevalence === 'number') {
          entityPrevalenceSums.set(tp.entity, (entityPrevalenceSums.get(tp.entity) ?? 0) + tp.prevalence)
          entityPrevalenceMax.set(tp.entity, Math.max(entityPrevalenceMax.get(tp.entity) ?? 0, tp.prevalence))
        }
        if (tp.categories.length > 0) {
          const currentCategories = entityCategories.get(tp.entity) ?? new Map<string, number>()
          for (const category of tp.categories) {
            currentCategories.set(category, (currentCategories.get(category) ?? 0) + 1)
          }
          entityCategories.set(tp.entity, currentCategories)
        }
      }
    }
  }

  return {
    processed_sites: processedSites,
    success_rate: processedSites > 0 ? Math.round((okSites / processedSites) * 10000) / 100 : 0,
    status_counts: Object.fromEntries(statusCounts.entries()),
    third_party: {
      total: totalThirdPartyOccurrences,
      unique: uniqueDomains.size,
      mapped: mappedOccurrences,
      unique_mapped: uniqueMappedDomains.size,
      unique_with_policy: uniquePolicyDomains.size,
      unmapped: unmappedOccurrences,
      no_policy_url: noPolicyUrlOccurrences,
    },
    mapping: {
      mode: null,
      radar_mapped: radarMappedOccurrences,
      trackerdb_mapped: trackerdbMappedOccurrences,
      unmapped: Math.max(0, totalThirdPartyOccurrences - radarMappedOccurrences - trackerdbMappedOccurrences),
      unique_radar_mapped: uniqueRadarDomains.size,
      unique_trackerdb_mapped: uniqueTrackerdbDomains.size,
      unique_unmapped: uniqueUnmappedDomains.size,
    },
    site_categories: [...siteCategoryCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
    categories: finalizeCategories(categoryCounts),
    entities: finalizeEntities(entityCounts, entityPrevalenceSums, entityPrevalenceMax, entityCategories),
    english_policy_count: englishPolicyCount,
  }
}
