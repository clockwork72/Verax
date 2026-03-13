import type { ResultRecord } from '../contracts/api'
import type { ExplorerSite } from '../data/explorer'
import { CATEGORY_ORDER, normalizeCategory } from './trackerCategories'

export const WEBSITE_CATEGORY_ORDER = [
  'Business & Finance',
  'Technology',
  'News & Media',
  'E-commerce',
  'Entertainment',
  'Education',
  'Adult',
] as const

export type WebsiteCategory = typeof WEBSITE_CATEGORY_ORDER[number]

export type CategoryServiceHeatmapCell = {
  serviceCategory: string
  matchedSites: number
  totalSites: number
  percentage: number
  zeroOverlap: boolean
}

export type CategoryServiceHeatmapRow = {
  websiteCategory: WebsiteCategory
  totalSites: number
  cells: CategoryServiceHeatmapCell[]
}

export type CategoryServiceHeatmap = {
  websiteCategories: readonly WebsiteCategory[]
  serviceCategories: readonly string[]
  rows: CategoryServiceHeatmapRow[]
  maxPercentage: number
}

function normalizeWebsiteCategory(value: unknown): WebsiteCategory | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const normalized = trimmed.toLowerCase()
  const aliases: Record<string, WebsiteCategory> = {
    'business & finance': 'Business & Finance',
    'business and finance': 'Business & Finance',
    'technology': 'Technology',
    'news & media': 'News & Media',
    'news and media': 'News & Media',
    'news': 'News & Media',
    'e-commerce': 'E-commerce',
    'ecommerce': 'E-commerce',
    'shopping': 'E-commerce',
    'entertainment': 'Entertainment',
    'education': 'Education',
    'adult': 'Adult',
    'adult content': 'Adult',
  }
  if (normalized in aliases) {
    return aliases[normalized]
  }
  if ((WEBSITE_CATEGORY_ORDER as readonly string[]).includes(trimmed)) {
    return trimmed as WebsiteCategory
  }
  return null
}

function normalizeSiteKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function resultThirdPartyCategories(record: ResultRecord): Set<string> {
  const categories = new Set<string>()
  for (const thirdParty of Array.isArray(record.third_parties) ? record.third_parties : []) {
    for (const rawCategory of Array.isArray(thirdParty?.categories) ? thirdParty.categories : []) {
      if (typeof rawCategory !== 'string' || !rawCategory.trim()) continue
      const normalized = normalizeCategory(rawCategory)
      if (CATEGORY_ORDER.includes(normalized)) {
        categories.add(normalized)
      }
    }
  }
  return categories
}

function explorerThirdPartyCategories(site: ExplorerSite): Set<string> {
  const categories = new Set<string>()
  for (const thirdParty of Array.isArray(site.thirdParties) ? site.thirdParties : []) {
    for (const rawCategory of Array.isArray(thirdParty?.categories) ? thirdParty.categories : []) {
      if (typeof rawCategory !== 'string' || !rawCategory.trim()) continue
      const normalized = normalizeCategory(rawCategory)
      if (CATEGORY_ORDER.includes(normalized)) {
        categories.add(normalized)
      }
    }
  }
  return categories
}

export function deriveCategoryServiceHeatmap(
  records: ResultRecord[] | null | undefined,
  sites: ExplorerSite[] | null | undefined,
): CategoryServiceHeatmap | null {
  const resultRecords = Array.isArray(records) && records.length > 0 ? records : []
  const explorerSites = Array.isArray(sites) && sites.length > 0 ? sites : []
  if (resultRecords.length === 0 && explorerSites.length === 0) return null

  const siteTotals = new Map<WebsiteCategory, number>()
  const serviceCounts = new Map<WebsiteCategory, Map<string, number>>()

  for (const websiteCategory of WEBSITE_CATEGORY_ORDER) {
    siteTotals.set(websiteCategory, 0)
    serviceCounts.set(websiteCategory, new Map())
  }

  const explorerBySite = new Map<string, ExplorerSite>()
  for (const site of explorerSites) {
    const siteKey = normalizeSiteKey(site.site)
    if (!siteKey) continue
    explorerBySite.set(siteKey, site)
  }

  const seenSites = new Set<string>()
  const sourceEntries = resultRecords.length > 0 ? resultRecords : explorerSites

  for (const entry of sourceEntries) {
    const siteKey = resultRecords.length > 0
      ? normalizeSiteKey((entry as ResultRecord).site_etld1 || (entry as ResultRecord).input || (entry as ResultRecord).site)
      : normalizeSiteKey((entry as ExplorerSite).site)
    const explorerSite = siteKey ? explorerBySite.get(siteKey) : undefined
    const rawWebsiteCategory = resultRecords.length > 0
      ? (entry as ResultRecord).main_category ?? explorerSite?.mainCategory
      : (entry as ExplorerSite).mainCategory
    const websiteCategory = normalizeWebsiteCategory(rawWebsiteCategory)
    if (!websiteCategory) continue

    const dedupeSiteKey = siteKey || `${websiteCategory}:${seenSites.size}`
    if (seenSites.has(dedupeSiteKey)) continue
    seenSites.add(dedupeSiteKey)

    siteTotals.set(websiteCategory, (siteTotals.get(websiteCategory) ?? 0) + 1)

    const categories = resultRecords.length > 0
      ? new Set([
          ...resultThirdPartyCategories(entry as ResultRecord),
          ...(explorerSite ? explorerThirdPartyCategories(explorerSite) : []),
        ])
      : explorerThirdPartyCategories(entry as ExplorerSite)

    const rowCounts = serviceCounts.get(websiteCategory) ?? new Map<string, number>()
    for (const serviceCategory of categories) {
      rowCounts.set(serviceCategory, (rowCounts.get(serviceCategory) ?? 0) + 1)
    }
    serviceCounts.set(websiteCategory, rowCounts)
  }

  const rows = WEBSITE_CATEGORY_ORDER.map((websiteCategory) => {
    const totalSites = siteTotals.get(websiteCategory) ?? 0
    const rowCounts = serviceCounts.get(websiteCategory) ?? new Map<string, number>()
    const cells = CATEGORY_ORDER.map((serviceCategory) => {
      const matchedSites = rowCounts.get(serviceCategory) ?? 0
      const percentage = totalSites > 0 ? (matchedSites / totalSites) * 100 : 0
      return {
        serviceCategory,
        matchedSites,
        totalSites,
        percentage,
        zeroOverlap: totalSites > 0 && matchedSites === 0,
      }
    })

    return {
      websiteCategory,
      totalSites,
      cells,
    }
  })

  const maxPercentage = rows.reduce((max, row) => (
    Math.max(max, ...row.cells.map((cell) => cell.percentage))
  ), 0)

  if (!rows.some((row) => row.totalSites > 0)) {
    return null
  }

  return {
    websiteCategories: WEBSITE_CATEGORY_ORDER,
    serviceCategories: CATEGORY_ORDER,
    rows,
    maxPercentage,
  }
}
