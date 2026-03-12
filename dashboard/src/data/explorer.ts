import type { ScraperSiteStatus } from '../contracts/api'

export type ExplorerThirdParty = {
  name: string
  policyUrl: string | null
  extractionMethod?: string | null
  entity: string | null
  categories: string[]
  prevalence: number | null
}

export type ExplorerSite = {
  site: string
  rank?: number | null
  status: ScraperSiteStatus
  policyUrl: string | null
  extractionMethod?: string | null
  thirdParties: ExplorerThirdParty[]
}

export const explorerSites: ExplorerSite[] = [
  {
    site: 'apple.com',
    rank: 9,
    status: 'ok',
    policyUrl: 'https://apple.com/privacy/',
    thirdParties: [],
  },
  {
    site: 'microsoft.com',
    rank: 3,
    status: 'ok',
    policyUrl: 'https://go.microsoft.com/fwlink/?linkid=2259814',
    thirdParties: [
      {
        name: 'clarity.ms',
        policyUrl: 'https://privacy.microsoft.com/en-us/privacystatement',
        entity: 'Microsoft Corporation',
        categories: ['Analytics'],
        prevalence: 0.0278,
      },
      {
        name: 'azure.com',
        policyUrl: 'https://privacy.microsoft.com/en-us/privacystatement',
        entity: 'Microsoft Corporation',
        categories: ['CDN'],
        prevalence: 0.00344,
      },
      {
        name: 'live.com',
        policyUrl: 'https://privacy.microsoft.com/en-us/privacystatement',
        entity: 'Microsoft Corporation',
        categories: ['Identity'],
        prevalence: 0.0000549,
      },
    ],
  },
  {
    site: 'linkedin.com',
    rank: 24,
    status: 'policy_not_found',
    policyUrl: null,
    thirdParties: [
      {
        name: 'gstatic.com',
        policyUrl: 'https://policies.google.com/privacy',
        entity: 'Google',
        categories: ['CDN'],
        prevalence: 0.032,
      },
      {
        name: 'demdex.net',
        policyUrl: 'https://www.adobe.com/privacy/policy.html',
        entity: 'Adobe',
        categories: ['Advertising'],
        prevalence: 0.014,
      },
    ],
  },
  {
    site: 'amazonaws.com',
    rank: 10,
    status: 'home_fetch_failed',
    policyUrl: null,
    thirdParties: [],
  },
]
