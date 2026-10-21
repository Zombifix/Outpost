// Supabase Edge Function: resolves one official shared image per destination.
//
// Secrets:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   UNSPLASH_ACCESS_KEY      optional
//   PEXELS_API_KEY           optional

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

type ImageSource = 'unsplash' | 'pexels' | 'wikivoyage' | 'wikipedia' | 'wikimedia' | 'fallback'
type ImageStatus = 'active' | 'resolving' | 'failed' | 'disabled'

interface DestinationInput {
  destinationKey?: string
  name?: string
  country?: string
  state?: string
  kind?: 'place' | 'zone' | 'stop' | 'stage'
  lat?: number
  lng?: number
  osmValue?: string
  osmId?: number
  osmType?: string
  countryCode?: string
  fallbackImage?: string
  stops?: Array<{ name?: string; lat?: number; lng?: number }>
}

interface DestinationImageRow {
  destination_key: string
  image_url: string
  image_source: ImageSource
  provider_image_id: string | null
  photographer_name: string | null
  photographer_url: string | null
  source_url: string | null
  alt: string | null
  width: number | null
  height: number | null
  score: number | null
  status: ImageStatus
  is_manual_override: boolean
  last_validated_at: string | null
}

interface Candidate {
  imageUrl: string
  imageSource: ImageSource
  providerImageId?: string
  photographerName?: string
  photographerUrl?: string
  sourceUrl?: string
  alt?: string
  width?: number
  height?: number
  score: number
  imageQuery: string
}

// Allowed browser origins: the live site and local dev servers. Kept in code
// rather than in the ALLOWED_ORIGINS secret, which still held the dead
// Railway domain (a released domain can be claimed by someone else).
const ALLOWED_ORIGINS = [
  'https://mvggcf5azrvtt7bzmhazitzg.57.129.154.4.sslip.io',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://localhost:4747',
]
const FALLBACK_IMAGE = 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=85'
const FAILED_RETRY_COOLDOWN_MS = 10 * 60_000
const MIN_LANDSCAPE_RATIO = 1.15
const TRAVEL_KEYWORDS = ['landscape', 'cityscape', 'coast', 'mountain', 'old town', 'road', 'skyline', 'architecture', 'nature', 'beach', 'desert', 'forest', 'cliff', 'landmark', 'panorama', 'panoramic', 'aerial', 'view']
const GENERIC_KEYWORDS = ['airport', 'airplane', 'plane', 'passport', 'luggage', 'suitcase', 'ticket', 'map', 'person', 'people', 'woman', 'man', 'portrait', 'flag', 'seal']
const SEARCH_ALIASES: Record<string, string> = {
  algerie: 'Algeria',
  allemagne: 'Germany',
  angleterre: 'England',
  bresil: 'Brazil',
  chine: 'China',
  coree: 'Korea',
  'coree du sud': 'South Korea',
  espagne: 'Spain',
  'etats-unis': 'United States',
  grece: 'Greece',
  irlande: 'Ireland',
  italie: 'Italy',
  japon: 'Japan',
  maroc: 'Morocco',
  mexique: 'Mexico',
  portugal: 'Portugal',
  thailande: 'Thailand',
  'cote-d-azur': 'French Riviera',
  'cote d azur': 'French Riviera',
  'ile maurice': 'Mauritius',
}
// Wikivoyage banners (Wikidata P948) are curated ~7:1 panoramas of the place itself.
const BANNER_SCORE_BONUS = 100
// Max distance between the destination and the Wikidata item, to reject homonyms.
const BANNER_MAX_DISTANCE_KM = 150
const BANNER_MAX_DISTANCE_WIDE_KM = 900
const WIDE_OSM_VALUES = ['country', 'state', 'region', 'province', 'county', 'island', 'archipelago', 'peninsula', 'mountain_range']
const BANNER_MAX_WIDTH = 3840
const WIKI_USER_AGENT = 'Outpost/1.0 (https://mvggcf5azrvtt7bzmhazitzg.57.129.154.4.sslip.io)'

function getAllowedOrigins(): string[] {
  return ALLOWED_ORIGINS
}

function buildCorsHeaders(origin: string | null): Record<string, string> {
  const allowed = getAllowedOrigins()
  const allowOrigin = origin && allowed.includes(origin) ? origin : allowed[0]
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

function jsonWith(corsHeaders: Record<string, string>, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function slugPart(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function normalizeOsmType(value?: string): string | null {
  if (!value) return null
  const normalized = value.toLowerCase()
  if (normalized === 'n' || normalized === 'node') return 'node'
  if (normalized === 'w' || normalized === 'way') return 'way'
  if (normalized === 'r' || normalized === 'relation') return 'relation'
  return null
}

function buildDestinationKey(input: DestinationInput): string {
  if (input.destinationKey) return input.destinationKey
  const osmType = normalizeOsmType(input.osmType)
  const osmId = Number(input.osmId)
  if (osmType && Number.isFinite(osmId)) {
    return `osm_${osmType}_${Math.trunc(osmId)}`
  }
  const stopPart = input.stops?.slice(0, 3).map(stop => slugPart(stop.name ?? '')).filter(Boolean).join('_') ?? ''
  const lat = Number.isFinite(input.lat) ? Number(input.lat).toFixed(3) : 'na'
  const lng = Number.isFinite(input.lng) ? Number(input.lng).toFixed(3) : 'na'
  return `slug_${[input.kind ?? 'place', slugPart(input.name ?? ''), slugPart(input.country ?? ''), lat, lng, stopPart].filter(Boolean).join('_')}`
}

function searchName(value: string): string {
  const normalized = value.trim()
  const key = normalized.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  return SEARCH_ALIASES[key] ?? SEARCH_ALIASES[normalized.toLowerCase()] ?? normalized
}

function buildQueries(input: DestinationInput): string[] {
  const name = searchName(input.name ?? '')
  const country = searchName(input.country ?? '')
  const nameCountry = slugPart(name) === slugPart(country) ? name : [name, country].filter(Boolean).join(' ')
  const isZone = input.kind === 'zone'
  const queries = isZone
    ? [
        `${nameCountry} panorama landscape`,
        `${nameCountry} aerial view`,
        `${name} scenic landscape`,
        `${nameCountry} road trip`,
      ]
    : [
        `${nameCountry} panorama`,
        `${nameCountry} skyline aerial view`,
        `${nameCountry} landmark`,
      ]
  const stops = input.stops?.filter(stop => stop.name?.trim()).slice(0, 2) ?? []
  if (isZone && stops.length >= 2) queries.splice(1, 0, `${stops.map(stop => stop.name).join(' ')} road trip`)
  if (isZone && stops.length === 1) queries.splice(1, 0, `${stops[0].name} ${country} road trip`)
  return Array.from(new Set(queries.map(query => query.replace(/\s+/g, ' ').trim()).filter(Boolean)))
}

// Whole-word matching, so "man" does not hit "Germany" and "map" does not hit "maple".
function wordPadded(text: string): string {
  return ` ${slugPart(text).replace(/_/g, ' ')} `
}

function textScore(text: string): number {
  const padded = wordPadded(text)
  const positive = TRAVEL_KEYWORDS.reduce((score, word) => score + (padded.includes(` ${word} `) ? 2 : 0), 0)
  const negative = GENERIC_KEYWORDS.reduce((score, word) => score + (padded.includes(` ${word} `) ? 3 : 0), 0)
  return positive - negative
}

function significantWords(value: string): string[] {
  return slugPart(value).split('_').filter(word => word.length >= 3)
}

// Stock banks match on loose tags: keep a photo only when its own description
// (never our query) names the destination, or one of the road trip stops.
function mentionsPlace(text: string, input: DestinationInput): boolean {
  const padded = wordPadded(text)
  const names = [input.name ?? '', searchName(input.name ?? ''), ...(input.stops ?? []).map(stop => stop.name ?? '')]
  return names.some(name => {
    const words = significantWords(name)
    return words.length > 0 && words.every(word => padded.includes(` ${word} `))
  })
}

function candidateBaseScore(width = 0, height = 1, text = ''): number {
  const ratio = width / Math.max(height, 1)
  const landscapeScore = ratio >= MIN_LANDSCAPE_RATIO ? 8 : -12
  const resolutionScore = Math.min(width / 400, 6)
  return landscapeScore + resolutionScore + textScore(text)
}

async function fetchWithRetry(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(input, init)
      if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) return response
      lastError = new Error(`http_${response.status}`)
    } catch (err) {
      lastError = err
    }
    await new Promise(resolve => setTimeout(resolve, 250 * Math.pow(2, attempt)))
  }
  throw lastError instanceof Error ? lastError : new Error('fetch_failed')
}

async function searchUnsplash(query: string, input: DestinationInput): Promise<Candidate[]> {
  const key = Deno.env.get('UNSPLASH_ACCESS_KEY')?.trim()
  if (!key) return []
  const url = new URL('https://api.unsplash.com/search/photos')
  url.searchParams.set('query', query)
  url.searchParams.set('orientation', 'landscape')
  url.searchParams.set('per_page', '12')
  url.searchParams.set('content_filter', 'high')
  const response = await fetchWithRetry(url, { headers: { Authorization: `Client-ID ${key}` } })
  if (!response.ok) return []
  const data = await response.json() as { results?: Array<Record<string, unknown>> }
  return (data.results ?? []).flatMap(photo => {
    const urls = photo.urls as Record<string, string | undefined> | undefined
    const user = photo.user as Record<string, unknown> | undefined
    const links = photo.links as Record<string, string | undefined> | undefined
    const imageUrl = urls?.regular ?? urls?.full
    if (!imageUrl) return []
    const width = typeof photo.width === 'number' ? photo.width : undefined
    const height = typeof photo.height === 'number' ? photo.height : undefined
    const alt = typeof photo.alt_description === 'string' ? photo.alt_description : undefined
    const description = typeof photo.description === 'string' ? photo.description : ''
    const tags = Array.isArray(photo.tags)
      ? photo.tags.map(tag => (tag as Record<string, unknown>)?.title).filter(title => typeof title === 'string').join(' ')
      : ''
    const location = photo.location as Record<string, unknown> | undefined
    const locationText = [location?.name, location?.city, location?.country].filter(part => typeof part === 'string').join(' ')
    if (!mentionsPlace(`${alt ?? ''} ${description} ${tags} ${locationText}`, input)) return []
    return [{
      imageUrl,
      imageSource: 'unsplash',
      providerImageId: typeof photo.id === 'string' ? photo.id : undefined,
      photographerName: typeof user?.name === 'string' ? user.name : undefined,
      photographerUrl: typeof user?.links === 'object' && user.links !== null ? (user.links as Record<string, string | undefined>).html : undefined,
      sourceUrl: links?.html,
      alt,
      width,
      height,
      score: 2 + candidateBaseScore(width, height, `${alt ?? ''} ${query}`),
      imageQuery: query,
    } satisfies Candidate]
  })
}

async function searchPexels(query: string, input: DestinationInput): Promise<Candidate[]> {
  const key = Deno.env.get('PEXELS_API_KEY')?.trim()
  if (!key) return []
  const url = new URL('https://api.pexels.com/v1/search')
  url.searchParams.set('query', query)
  url.searchParams.set('orientation', 'landscape')
  url.searchParams.set('per_page', '12')
  url.searchParams.set('locale', 'en-US')
  const response = await fetchWithRetry(url, { headers: { Authorization: key } })
  if (!response.ok) return []
  const data = await response.json() as { photos?: Array<Record<string, unknown>> }
  return (data.photos ?? []).flatMap(photo => {
    const src = photo.src as Record<string, string | undefined> | undefined
    const imageUrl = src?.large2x ?? src?.large ?? src?.landscape
    if (!imageUrl) return []
    const width = typeof photo.width === 'number' ? photo.width : undefined
    const height = typeof photo.height === 'number' ? photo.height : undefined
    const alt = typeof photo.alt === 'string' ? photo.alt : undefined
    // The page URL slug repeats the photographer's title, e.g. /photo/aerial-view-of-lisbon-123/.
    if (!mentionsPlace(`${alt ?? ''} ${photo.url ?? ''}`, input)) return []
    return [{
      imageUrl,
      imageSource: 'pexels',
      providerImageId: typeof photo.id === 'number' ? String(photo.id) : undefined,
      photographerName: typeof photo.photographer === 'string' ? photo.photographer : undefined,
      photographerUrl: typeof photo.photographer_url === 'string' ? photo.photographer_url : undefined,
      sourceUrl: typeof photo.url === 'string' ? photo.url : undefined,
      alt,
      width,
      height,
      score: candidateBaseScore(width, height, `${alt ?? ''} ${photo.url ?? ''}`),
      imageQuery: query,
    } satisfies Candidate]
  })
}

function stripHtml(value?: string): string | undefined {
  return value?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || undefined
}

function pageImageIsUsable(page: Record<string, unknown>): boolean {
  const thumbnail = page.thumbnail as Record<string, unknown> | undefined
  const width = typeof thumbnail?.width === 'number' ? thumbnail.width : 0
  const height = typeof thumbnail?.height === 'number' ? thumbnail.height : 1
  const imageName = `${page.pageimage ?? ''} ${thumbnail?.source ?? ''}`.toLowerCase()
  const blocked = ['flag', 'coat_of_arms', 'seal', 'map', 'location'].some(word => imageName.includes(word))
  return Boolean(thumbnail?.source) && width >= height * 0.62 && !blocked
}

async function searchWikiExact(host: string, source: ImageSource, name: string): Promise<Candidate[]> {
  const url = new URL(`https://${host}/w/api.php`)
  url.searchParams.set('action', 'query')
  url.searchParams.set('format', 'json')
  url.searchParams.set('origin', '*')
  url.searchParams.set('titles', name)
  url.searchParams.set('redirects', '1')
  url.searchParams.set('prop', 'pageimages|info')
  url.searchParams.set('inprop', 'url')
  url.searchParams.set('pithumbsize', '1200')
  const response = await fetchWithRetry(url)
  if (!response.ok) return []
  const data = await response.json() as { query?: { pages?: Record<string, Record<string, unknown>> } }
  return Object.values(data.query?.pages ?? {}).filter(pageImageIsUsable).flatMap(page => {
    const thumbnail = page.thumbnail as Record<string, unknown>
    const imageUrl = typeof thumbnail.source === 'string' ? thumbnail.source : ''
    if (!imageUrl) return []
    const width = typeof thumbnail.width === 'number' ? thumbnail.width : undefined
    const height = typeof thumbnail.height === 'number' ? thumbnail.height : undefined
    return [{
      imageUrl,
      imageSource: source,
      sourceUrl: typeof page.fullurl === 'string' ? page.fullurl : undefined,
      alt: typeof page.title === 'string' ? page.title : name,
      width,
      height,
      score: candidateBaseScore(width, height, `${page.title ?? ''} ${page.pageimage ?? ''}`),
      imageQuery: name,
    } satisfies Candidate]
  })
}

async function searchWikipediaSummary(name: string): Promise<Candidate[]> {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}?redirect=true`
  const response = await fetchWithRetry(url)
  if (!response.ok) return []
  const summary = await response.json() as Record<string, unknown>
  const original = summary.originalimage as Record<string, unknown> | undefined
  const thumbnail = summary.thumbnail as Record<string, unknown> | undefined
  const image = original ?? thumbnail
  const imageUrl = typeof image?.source === 'string' ? image.source : ''
  // Country and region summaries often lead with a flag, a coat of arms or a map.
  if (!imageUrl || /flag|coat_of_arms|blason|map|locator|\.svg/i.test(imageUrl)) return []
  const width = typeof image?.width === 'number' ? image.width : undefined
  const height = typeof image?.height === 'number' ? image.height : undefined
  const page = summary.content_urls as { desktop?: { page?: string } } | undefined
  return [{
    imageUrl,
    imageSource: 'wikipedia',
    sourceUrl: page?.desktop?.page,
    alt: typeof summary.title === 'string' ? summary.title : name,
    width,
    height,
    score: candidateBaseScore(width, height, `${summary.title ?? ''} ${name}`),
    imageQuery: name,
  }]
}

async function searchWikimedia(query: string, input: DestinationInput): Promise<Candidate[]> {
  const url = new URL('https://commons.wikimedia.org/w/api.php')
  url.searchParams.set('action', 'query')
  url.searchParams.set('format', 'json')
  url.searchParams.set('origin', '*')
  url.searchParams.set('generator', 'search')
  url.searchParams.set('gsrnamespace', '6')
  url.searchParams.set('gsrlimit', '12')
  url.searchParams.set('gsrsearch', query)
  url.searchParams.set('prop', 'imageinfo')
  url.searchParams.set('iiprop', 'url|size|mime|extmetadata')
  url.searchParams.set('iiurlwidth', '1200')
  const response = await fetchWithRetry(url)
  if (!response.ok) return []
  const data = await response.json() as { query?: { pages?: Record<string, Record<string, unknown>> } }
  const targetWords = new Set(slugPart(searchName(input.name ?? '')).split('_').filter(word => word.length >= 3))
  return Object.values(data.query?.pages ?? {}).flatMap(page => {
    const info = Array.isArray(page.imageinfo) ? page.imageinfo[0] as Record<string, unknown> | undefined : undefined
    const mime = typeof info?.mime === 'string' ? info.mime : ''
    const width = typeof info?.width === 'number' ? info.width : undefined
    const height = typeof info?.height === 'number' ? info.height : undefined
    const title = typeof page.title === 'string' ? page.title : ''
    const titleWords = new Set(slugPart(title).split('_'))
    const matchesTitle = [...targetWords].some(word => titleWords.has(word))
    const imageUrl = typeof info?.thumburl === 'string' ? info.thumburl : typeof info?.url === 'string' ? info.url : ''
    if (!imageUrl || !['image/jpeg', 'image/png', 'image/webp'].includes(mime) || !width || !height || width <= height || !matchesTitle) return []
    const metadata = info?.extmetadata as Record<string, { value?: string }> | undefined
    return [{
      imageUrl,
      imageSource: 'wikimedia',
      photographerName: stripHtml(metadata?.Artist?.value) ?? stripHtml(metadata?.Credit?.value),
      sourceUrl: typeof info.descriptionurl === 'string' ? info.descriptionurl : typeof info.descriptionshorturl === 'string' ? info.descriptionshorturl : undefined,
      alt: title,
      width,
      height,
      score: candidateBaseScore(width, height, title),
      imageQuery: query,
    } satisfies Candidate]
  })
}

function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180
  const dLat = (bLat - aLat) * rad
  const dLng = (bLng - aLng) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}

function claimValue(entity: Record<string, unknown>, property: string): unknown {
  const claims = entity.claims as Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>> | undefined
  return claims?.[property]?.[0]?.mainsnak?.datavalue?.value
}

async function fetchCommonsBanner(fileName: string, query: string): Promise<Candidate | null> {
  const url = new URL('https://commons.wikimedia.org/w/api.php')
  url.searchParams.set('action', 'query')
  url.searchParams.set('format', 'json')
  url.searchParams.set('titles', `File:${fileName}`)
  url.searchParams.set('prop', 'imageinfo')
  url.searchParams.set('iiprop', 'url|size|mime|extmetadata')
  url.searchParams.set('iiurlwidth', String(BANNER_MAX_WIDTH))
  const response = await fetchWithRetry(url, { headers: { 'User-Agent': WIKI_USER_AGENT } })
  if (!response.ok) return null
  const data = await response.json() as { query?: { pages?: Record<string, Record<string, unknown>> } }
  const page = Object.values(data.query?.pages ?? {})[0]
  const info = Array.isArray(page?.imageinfo) ? page.imageinfo[0] as Record<string, unknown> | undefined : undefined
  const width = typeof info?.width === 'number' ? info.width : 0
  const height = typeof info?.height === 'number' ? info.height : 0
  const mime = typeof info?.mime === 'string' ? info.mime : ''
  if (!info || !width || !height || !['image/jpeg', 'image/png', 'image/webp'].includes(mime)) return null
  const original = typeof info.url === 'string' ? info.url : ''
  const thumb = typeof info.thumburl === 'string' ? info.thumburl : ''
  const imageUrl = (width <= BANNER_MAX_WIDTH ? original : thumb || original).split('?')[0]
  if (!imageUrl) return null
  const metadata = info.extmetadata as Record<string, { value?: string }> | undefined
  return {
    imageUrl,
    imageSource: 'wikivoyage',
    photographerName: stripHtml(metadata?.Artist?.value) ?? stripHtml(metadata?.Credit?.value),
    sourceUrl: typeof info.descriptionurl === 'string' ? info.descriptionurl : undefined,
    alt: typeof page.title === 'string' ? page.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, '') : fileName,
    width: width <= BANNER_MAX_WIDTH ? width : BANNER_MAX_WIDTH,
    height: width <= BANNER_MAX_WIDTH ? height : Math.round(height * BANNER_MAX_WIDTH / width),
    score: BANNER_SCORE_BONUS + candidateBaseScore(width, height),
    imageQuery: query,
  }
}

// Wikivoyage banner of the destination, found through the Wikidata item
// linked to its Wikivoyage or Wikipedia article (property P948).
async function searchWikivoyageBanner(input: DestinationInput): Promise<Candidate | null> {
  const name = input.name?.trim() ?? ''
  // "Shanghaï" has no article, "Shanghai" does: also try the name without accents.
  const plain = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const titles = Array.from(new Set([name, plain, searchName(name)].filter(Boolean)))
  if (!titles.length) return null
  const hasCoords = Number.isFinite(input.lat) && Number.isFinite(input.lng)
  const wide = input.kind === 'zone' || WIDE_OSM_VALUES.includes(input.osmValue ?? '')
  const maxDistance = wide ? BANNER_MAX_DISTANCE_WIDE_KM : BANNER_MAX_DISTANCE_KM

  for (const site of ['enwikivoyage', 'frwikivoyage', 'enwiki', 'frwiki']) {
    const url = new URL('https://www.wikidata.org/w/api.php')
    url.searchParams.set('action', 'wbgetentities')
    url.searchParams.set('format', 'json')
    url.searchParams.set('sites', site)
    url.searchParams.set('titles', titles.join('|'))
    url.searchParams.set('props', 'claims')
    url.searchParams.set('redirects', 'yes')
    const response = await fetchWithRetry(url, { headers: { 'User-Agent': WIKI_USER_AGENT } })
    if (!response.ok) continue
    const data = await response.json() as { entities?: Record<string, Record<string, unknown>> }

    const matches = Object.values(data.entities ?? {}).flatMap(entity => {
      const banner = claimValue(entity, 'P948')
      if (typeof banner !== 'string' || !banner) return []
      const coords = claimValue(entity, 'P625') as { latitude?: number; longitude?: number } | undefined
      const distance = hasCoords && typeof coords?.latitude === 'number' && typeof coords.longitude === 'number'
        ? distanceKm(Number(input.lat), Number(input.lng), coords.latitude, coords.longitude)
        : null
      if (distance !== null && distance > maxDistance) return []
      // An item without coordinates cannot be told apart from a homonym: skip it.
      if (hasCoords && distance === null) return []
      return [{ banner, distance: distance ?? 0 }]
    }).sort((a, b) => a.distance - b.distance)

    for (const match of matches) {
      const candidate = await fetchCommonsBanner(match.banner, titles[0])
      if (candidate) return candidate
    }
  }
  return null
}

async function findBestCandidate(input: DestinationInput): Promise<Candidate | null> {
  const queries = buildQueries(input)
  const candidates: Candidate[] = []

  try {
    const banner = await searchWikivoyageBanner(input)
    if (banner) return banner
  } catch { /* fall back to photo banks */ }

  for (const query of queries) {
    try { candidates.push(...await searchUnsplash(query, input)) } catch { /* try next provider */ }
  }
  if (candidates.length) return candidates.sort((a, b) => b.score - a.score)[0]

  for (const query of queries) {
    try { candidates.push(...await searchPexels(query, input)) } catch { /* try next provider */ }
  }
  if (candidates.length) return candidates.sort((a, b) => b.score - a.score)[0]

  const names = Array.from(new Set([
    searchName(input.name ?? ''),
    [searchName(input.name ?? ''), searchName(input.country ?? '')].filter(Boolean).join(' '),
  ].filter(Boolean)))
  for (const name of names) {
    try { candidates.push(...await searchWikiExact('en.wikivoyage.org', 'wikivoyage', name)) } catch { /* try Wikipedia */ }
    try { candidates.push(...await searchWikipediaSummary(name)) } catch { /* try action API */ }
    try { candidates.push(...await searchWikiExact('en.wikipedia.org', 'wikipedia', name)) } catch { /* try Commons */ }
  }
  if (candidates.length) return candidates.sort((a, b) => b.score - a.score)[0]

  for (const query of queries) {
    try { candidates.push(...await searchWikimedia(query, input)) } catch { /* try next query */ }
  }
  return candidates.sort((a, b) => b.score - a.score)[0] ?? null
}

function rowToResponse(row: DestinationImageRow, imageQuery?: string) {
  return {
    destinationKey: row.destination_key,
    imageUrl: row.image_url,
    imageSource: row.image_source,
    providerImageId: row.provider_image_id ?? undefined,
    photographerName: row.photographer_name ?? undefined,
    photographerUrl: row.photographer_url ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    alt: row.alt ?? undefined,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    score: row.score ?? undefined,
    status: row.status,
    isManualOverride: row.is_manual_override,
    lastValidatedAt: row.last_validated_at ?? undefined,
    imageQuery,
  }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('Origin')
  const corsHeaders = buildCorsHeaders(origin)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonWith(corsHeaders, { error: 'method_not_allowed' }, 405)

  let input: DestinationInput
  try {
    input = await req.json()
  } catch {
    return jsonWith(corsHeaders, { error: 'invalid_json' }, 400)
  }

  if (!input.name || !input.country) return jsonWith(corsHeaders, { error: 'missing_destination' }, 400)

  const destinationKey = buildDestinationKey(input)
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin = createClient(supabaseUrl, serviceKey)

  const { data: existing } = await admin
    .from('destination_images')
    .select('*')
    .eq('destination_key', destinationKey)
    .maybeSingle()

  const existingRow = existing as DestinationImageRow | null
  if (existingRow?.status === 'active') return jsonWith(corsHeaders, rowToResponse(existingRow))
  if (existingRow?.status === 'failed' && existingRow.last_validated_at) {
    const failedAt = new Date(existingRow.last_validated_at).getTime()
    if (Number.isFinite(failedAt) && Date.now() - failedAt < FAILED_RETRY_COOLDOWN_MS) {
      return jsonWith(corsHeaders, rowToResponse(existingRow))
    }
  }

  await admin.from('destination_images').upsert({
    destination_key: destinationKey,
    image_url: existingRow?.image_url ?? input.fallbackImage ?? FALLBACK_IMAGE,
    image_source: existingRow?.image_source ?? 'fallback',
    status: 'resolving',
    is_manual_override: existingRow?.is_manual_override ?? false,
  }, { onConflict: 'destination_key' })

  const candidate = await findBestCandidate(input)
  const { data: latest } = await admin
    .from('destination_images')
    .select('*')
    .eq('destination_key', destinationKey)
    .maybeSingle()
  const latestRow = latest as DestinationImageRow | null
  if (latestRow?.status === 'active' && latestRow.is_manual_override) {
    return jsonWith(corsHeaders, rowToResponse(latestRow))
  }

  const selected = candidate ?? {
    imageUrl: input.fallbackImage ?? FALLBACK_IMAGE,
    imageSource: 'fallback',
    score: -50,
    imageQuery: buildQueries(input)[0] ?? input.name,
  } satisfies Candidate
  const status: ImageStatus = candidate ? 'active' : 'failed'

  const { data: saved, error } = await admin
    .from('destination_images')
    .upsert({
      destination_key: destinationKey,
      image_url: selected.imageUrl,
      image_source: selected.imageSource,
      provider_image_id: selected.providerImageId ?? null,
      photographer_name: selected.photographerName ?? null,
      photographer_url: selected.photographerUrl ?? null,
      source_url: selected.sourceUrl ?? null,
      alt: selected.alt ?? null,
      width: selected.width ?? null,
      height: selected.height ?? null,
      score: selected.score,
      status,
      is_manual_override: false,
      last_validated_at: new Date().toISOString(),
    }, { onConflict: 'destination_key' })
    .select('*')
    .single()

  const savedRow = saved as DestinationImageRow | null
  if (error || !savedRow) return jsonWith(corsHeaders, { error: error?.message ?? 'save_failed' }, 500)
  return jsonWith(corsHeaders, rowToResponse(savedRow, selected.imageQuery))
})
