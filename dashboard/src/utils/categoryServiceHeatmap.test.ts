import { describe, expect, it } from 'vitest'

import { deriveCategoryServiceHeatmap } from './categoryServiceHeatmap'

describe('deriveCategoryServiceHeatmap', () => {
  it('builds website-by-service percentages from result records', () => {
    const heatmap = deriveCategoryServiceHeatmap([
      {
        site_etld1: 'alpha.example',
        main_category: 'Technology',
        third_parties: [
          { third_party_etld1: 'ga.example', categories: ['analytics'] },
          { third_party_etld1: 'cdn.example', categories: ['cdn'] },
        ],
      },
      {
        site_etld1: 'beta.example',
        main_category: 'Technology',
        third_parties: [
          { third_party_etld1: 'ads.example', categories: ['advertising'] },
          { third_party_etld1: 'ga-2.example', categories: ['audience measurement'] },
        ],
      },
      {
        site_etld1: 'gamma.example',
        main_category: 'Business & Finance',
        third_parties: [
          { third_party_etld1: 'auth.example', categories: ['sso'] },
        ],
      },
    ], null)

    expect(heatmap).not.toBeNull()
    expect(heatmap?.websiteCategories).toEqual([
      'Business & Finance',
      'Technology',
      'News & Media',
      'E-commerce',
      'Entertainment',
      'Education',
      'Adult',
    ])

    const technologyRow = heatmap?.rows.find((row) => row.websiteCategory === 'Technology')
    const financeRow = heatmap?.rows.find((row) => row.websiteCategory === 'Business & Finance')

    expect(technologyRow?.totalSites).toBe(2)
    expect(technologyRow?.cells.find((cell) => cell.serviceCategory === 'Analytics')).toMatchObject({
      matchedSites: 2,
      percentage: 100,
      zeroOverlap: false,
    })
    expect(technologyRow?.cells.find((cell) => cell.serviceCategory === 'Advertising')).toMatchObject({
      matchedSites: 1,
      percentage: 50,
      zeroOverlap: false,
    })
    expect(technologyRow?.cells.find((cell) => cell.serviceCategory === 'Social Media')).toMatchObject({
      matchedSites: 0,
      percentage: 0,
      zeroOverlap: true,
    })

    expect(financeRow?.cells.find((cell) => cell.serviceCategory === 'Identity & Payment')).toMatchObject({
      matchedSites: 1,
      percentage: 100,
      zeroOverlap: false,
    })
  })

  it('falls back to explorer sites when result records are unavailable', () => {
    const heatmap = deriveCategoryServiceHeatmap(null, [
      {
        site: 'delta.example',
        mainCategory: 'Education',
        status: 'ok',
        policyUrl: null,
        thirdParties: [
          {
            name: 'consent.example',
            policyUrl: null,
            entity: 'Consent Example',
            categories: ['consent management'],
            prevalence: null,
          },
        ],
      },
    ])

    const educationRow = heatmap?.rows.find((row) => row.websiteCategory === 'Education')
    expect(educationRow?.totalSites).toBe(1)
    expect(educationRow?.cells.find((cell) => cell.serviceCategory === 'Consent Management')).toMatchObject({
      matchedSites: 1,
      percentage: 100,
    })
  })

  it('uses explorer category metadata when result rows exist but do not carry main_category', () => {
    const heatmap = deriveCategoryServiceHeatmap([
      {
        site_etld1: 'delta.example',
        third_parties: [
          { third_party_etld1: 'consent.example', categories: ['consent management'] },
        ],
      },
    ], [
      {
        site: 'delta.example',
        mainCategory: 'Education',
        status: 'ok',
        policyUrl: null,
        thirdParties: [
          {
            name: 'consent.example',
            policyUrl: null,
            entity: 'Consent Example',
            categories: ['consent management'],
            prevalence: null,
          },
        ],
      },
    ])

    const educationRow = heatmap?.rows.find((row) => row.websiteCategory === 'Education')
    expect(educationRow?.totalSites).toBe(1)
    expect(educationRow?.cells.find((cell) => cell.serviceCategory === 'Consent Management')).toMatchObject({
      matchedSites: 1,
      percentage: 100,
    })
  })
})
