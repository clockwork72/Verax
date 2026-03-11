/**
 * Consolidated tracker category taxonomy.
 *
 * Raw category strings from Tracker Radar (DuckDuckGo) and TrackerDB (Ghostery)
 * are mapped to 9 shared labels. The lookup is case-insensitive.
 * Unrecognised categories pass through unchanged.
 */
const CATEGORY_MAP: Record<string, string> = {
  // ── Advertising ────────────────────────────────────────────────────────
  'advertising':                       'Advertising',
  'ad motivated tracking':             'Advertising',
  'action pixels':                     'Advertising',
  'third-party analytics marketing':   'Advertising',
  'ad fraud':                          'Advertising',
  'adult advertising':                 'Advertising',        // TDB
  // ── Analytics ──────────────────────────────────────────────────────────
  'analytics':                         'Analytics',
  'audience measurement':              'Analytics',
  'session replay':                    'Analytics',
  'site analytics':                    'Analytics',          // TDB
  // ── Social Media ───────────────────────────────────────────────────────
  'social network':                    'Social Media',
  'social - share':                    'Social Media',
  'social - comment':                  'Social Media',
  'social media':                      'Social Media',       // TDB
  // ── CDN & Hosting ──────────────────────────────────────────────────────
  'cdn':                               'CDN & Hosting',
  'hosting':                           'CDN & Hosting',      // TDB
  'misc':                              'CDN & Hosting',      // TDB
  // ── Tag Management ─────────────────────────────────────────────────────
  'tag manager':                       'Tag Management',
  'non-tracking':                      'Tag Management',
  'utilities':                         'Tag Management',     // TDB
  'extensions':                        'Tag Management',     // TDB
  // ── Consent Management ─────────────────────────────────────────────────
  'consent management platform':       'Consent Management',
  'consent management':                'Consent Management', // TDB
  // ── Identity & Payment ─────────────────────────────────────────────────
  'federated login':                   'Identity & Payment',
  'sso':                               'Identity & Payment',
  'fraud prevention':                  'Identity & Payment',
  'online payment':                    'Identity & Payment',
  // ── Embedded Content ───────────────────────────────────────────────────
  'embedded content':                  'Embedded Content',
  'badge':                             'Embedded Content',
  'support chat widget':               'Embedded Content',
  'audio/video player':                'Embedded Content',   // TDB
  'customer interaction':              'Embedded Content',   // TDB
  // ── High Risk ──────────────────────────────────────────────────────────
  'malware':                           'High Risk',
  'unknown high risk behavior':        'High Risk',
  'obscure ownership':                 'High Risk',
}

export function normalizeCategory(raw: string): string {
  return CATEGORY_MAP[raw.trim().toLowerCase()] ?? raw
}

/** Normalise an array of raw category strings and deduplicate. */
export function normalizeCategories(raws: string[]): string[] {
  return [...new Set(raws.map(normalizeCategory))]
}

/** Order for displaying consolidated categories (most common first). */
export const CATEGORY_ORDER: string[] = [
  'Advertising',
  'Analytics',
  'CDN & Hosting',
  'Social Media',
  'Embedded Content',
  'Tag Management',
  'Consent Management',
  'Identity & Payment',
  'High Risk',
]
