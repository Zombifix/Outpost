import type { Destination, Intent, ReturnIntent, RoadTripStop, Tier } from '../types'
import { normalizeStoredTripTypes } from './experienceTags'

/**
 * Mapping centralisé Destination (TS) ↔ ligne SQL (Supabase).
 *
 * Toutes les colonnes du schéma `destinations` (cf. migrations 001 + 008) sont
 * mappées ici, afin d'éviter la dérive entre `useFriendDestinations` (lecture
 * amis) et `useMyDestinations` (lecture/écriture du carnet courant).
 *
 * Les champs optionnels marqués "absent côté amis" ne sont pas renvoyés par le
 * RPC get_public_destinations (migration 022, principe du moindre privilège) :
 * ils n'existent que sur les lignes du carnet courant.
 */

export interface DbDestinationRow {
  id?: string
  user_id?: string
  destination_key: string | null
  name: string
  country: string
  lat: number
  lng: number
  tier: string | null
  kind: string | null
  intent: string | null
  food: number | null
  night: number | null
  culture: number | null
  nature: number | null
  value: number | null
  ease: number | null
  memorability?: number | null // absent côté amis (legacy)
  score: number | null
  notes?: number | null // absent côté amis
  stops: unknown
  extent: number[] | null
  geojson: unknown
  state?: string | null // absent côté amis
  osm_value?: string | null // absent côté amis
  osm_id: number | null
  osm_type: string | null
  country_code: string | null
  image: string | null
  image_provider: string | null
  image_author?: string | null // absent côté amis
  image_source_url?: string | null // absent côté amis
  image_query?: string | null // absent côté amis
  image_search_version?: number | null // absent côté amis
  summary: string | null
  trip_name: string | null
  visit_count: number | null
  trip_year: number | null
  trip_days: number | null
  companions: string | null
  personal_budget: number | null
  trip_types: string[] | null
  standout: string | null
  standout_tags: string[] | null
  coup_de_coeur: boolean | null
  lived_there: boolean | null
  vibe_boost: number | null
  retour_bonus: number | null
  return_intent?: string | null // ajouté en migration 023
  memory_note?: string | null // ajouté en migration 023
  tier_adjust?: number | null // ajouté en migration 023
}

/**
 * Colonnes à SELECT pour reconstituer une Destination complète.
 * `as const` est nécessaire pour que Supabase préserve le type littéral et
 * retourne un PromiseLike doté de `.finally` (utile pour le cleanup des requêtes
 * in-flight dans useFriendDestinations).
 */
export const DESTINATION_SELECT_COLUMNS =
  'id, user_id, destination_key, name, country, lat, lng, tier, kind, intent, food, night, culture, nature, value, ease, memorability, score, notes, stops, extent, geojson, state, osm_value, osm_id, osm_type, country_code, image, image_provider, image_author, image_source_url, image_query, image_search_version, summary, trip_name, visit_count, trip_year, trip_days, companions, personal_budget, trip_types, standout, standout_tags, coup_de_coeur, lived_there, vibe_boost, retour_bonus, return_intent, memory_note, tier_adjust' as const

const VALID_IMAGE_PROVIDERS = ['unsplash', 'pexels', 'wikivoyage', 'wikipedia', 'wikimedia', 'fallback'] as const
const VALID_COMPANIONS = ['solo', 'couple', 'amis', 'famille', 'travail'] as const
const VALID_TIERS = ['S', 'A', 'B', 'C', 'D'] as const
const VALID_KINDS = ['place', 'zone', 'stop', 'stage'] as const
const VALID_INTENTS = ['city-trip', 'tourisme', 'sorties', 'gastro', 'nature', 'travail'] as const
const VALID_RETURN_INTENTS = ['tomorrow', 'someday', 'once'] as const
const VALID_OSM_TYPES = ['N', 'W', 'R', 'node', 'way', 'relation'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeStops(value: unknown): RoadTripStop[] | undefined {
  if (!Array.isArray(value)) return undefined
  const stops = value
    .filter(isRecord)
    .map(stop => ({
      name: typeof stop.name === 'string' ? stop.name.trim() : '',
      lat: typeof stop.lat === 'number' && Number.isFinite(stop.lat) ? stop.lat : NaN,
      lng: typeof stop.lng === 'number' && Number.isFinite(stop.lng) ? stop.lng : NaN,
      type: stop.type === 'passage' ? 'passage' as const : stop.type === 'stage' ? 'stage' as const : undefined,
    }))
    .filter(stop => stop.name && Number.isFinite(stop.lat) && Number.isFinite(stop.lng))
  return stops.length ? stops : undefined
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
  return items.length ? items : undefined
}

function normalizeVisitCount(value: unknown) {
  const count = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(count) && count >= 1 ? count : 1
}

// Anciens libellés (V1 court initial + V2 long intermédiaire) remappés vers
// les libellés courts actuels (V3) pour que les destinations déjà saisies
// affichent les chips actuelles.
const LEGACY_TRIP_TYPE_MAP: Record<string, string> = {
  // V1 court
  '🏛️ Culture':   '🏛️ Musées & monuments',
  '🍽️ Food':      '🍽️ Food tour',
  '🌿 Nature':    '🌿 Grand air & rando',
  '🏙️ Ville':     '🏙️ City break',
  '🌙 Fête':      '🌙 Vie nocturne',
  '🧘 Repos':     '🧘 Mode lézard',
  '🚗 Road trip': '🚗 Road trip',
  '💻 Boulot':    '💻 Bleisure',
  // V2 long
  '🏛️ Enchaîner les musées & monuments':   '🏛️ Musées & monuments',
  '🍽️ Food tour & adresses pépites':       '🍽️ Food tour',
  '🌿 Grand air, rando & paysages':         '🌿 Grand air & rando',
  '🏙️ City break / Explorer à pied':       '🏙️ City break',
  '🌙 Vie nocturne & tournée des bars':     '🌙 Vie nocturne',
  '🧘 Mode lézard / Déconnexion totale':    '🧘 Mode lézard',
  '🚗 Avaler les kilomètres / Road trip':   '🚗 Road trip',
  '💻 Bleisure (Télétravail + exploration)':'💻 Bleisure',
}

const LEGACY_STANDOUT_MAP: Record<string, string> = {
  // V1 court
  '✨ Ambiance':         '✨ L\'énergie',
  '🍽️ Bouffe':           '🤤 Claques culinaires',
  '🤝 Rencontres':       '💬 Les locaux',
  '🏞️ Paysages':         '📸 Spots de folie',
  '🎯 Activités':        '📸 Spots de folie',
  '🌍 Dépaysement':      '⛩️ Dépaysement',
  '🏛️ Architecture':     '🧱 Architecture & ruelles',
  '😌 Calme':            '⛩️ Dépaysement',
  '💸 Trop cher':        '💸 Budget qui pique',
  '🧩 Galères':          '🚏 Transports galère',
  '📸 Trop touristique': '🎪 Pièges à touristes',
  '😮‍💨 Fatigant':       '😴 Rythme épuisant',
  // V2 long
  '✨ L\'énergie de la ville':         '✨ L\'énergie',
  '🤤 Les claques culinaires':         '🤤 Claques culinaires',
  '💬 Les rencontres avec les locaux': '💬 Les locaux',
  '📸 Les spots de folie':             '📸 Spots de folie',
  '⛩️ Le dépaysement total':           '⛩️ Dépaysement',
  '🧱 L\'architecture et les ruelles': '🧱 Architecture & ruelles',
  '💸 Le budget qui pique':            '💸 Budget qui pique',
  '🚏 Les transports en galère':       '🚏 Transports galère',
  '👤 La foule étouffante':            '👤 La foule',
  '🎪 Les pièges à touristes':         '🎪 Pièges à touristes',
  '😴 Le rythme épuisant':             '😴 Rythme épuisant',
  '🌦️ La météo capricieuse':          '🌦️ Météo capricieuse',
}

function remapList(items: string[] | undefined, map: Record<string, string>): string[] | undefined {
  if (!items?.length) return items
  const remapped: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const next = map[item] ?? item
    if (seen.has(next)) continue
    seen.add(next)
    remapped.push(next)
  }
  return remapped.length ? remapped : undefined
}

export function rowToDestination(row: DbDestinationRow): Destination {
  const tier = VALID_TIERS.includes(row.tier as Tier) ? (row.tier as Tier) : undefined
  const kind = VALID_KINDS.includes(row.kind as NonNullable<Destination['kind']>)
    ? (row.kind as Destination['kind'])
    : 'place'
  const intent = VALID_INTENTS.includes(row.intent as Intent) ? (row.intent as Intent) : 'tourisme'
  const imageProvider = VALID_IMAGE_PROVIDERS.includes(row.image_provider as typeof VALID_IMAGE_PROVIDERS[number])
    ? (row.image_provider as Destination['imageProvider'])
    : undefined
  const companions = VALID_COMPANIONS.includes(row.companions as typeof VALID_COMPANIONS[number])
    ? (row.companions as Destination['companions'])
    : undefined
  const osmType = VALID_OSM_TYPES.includes(row.osm_type as typeof VALID_OSM_TYPES[number])
    ? (row.osm_type as Destination['osmType'])
    : undefined
  const extent = Array.isArray(row.extent) && row.extent.length === 4 && row.extent.every(n => typeof n === 'number' && Number.isFinite(n))
    ? (row.extent as [number, number, number, number])
    : undefined

  return {
    destinationKey: row.destination_key ?? undefined,
    name: row.name,
    country: row.country,
    lat: row.lat,
    lng: row.lng,
    tier,
    kind,
    intent,
    food: row.food ?? undefined,
    night: row.night ?? undefined,
    culture: row.culture ?? undefined,
    nature: row.nature ?? undefined,
    value: row.value ?? undefined,
    ease: row.ease ?? undefined,
    memorability: row.memorability ?? undefined,
    score: row.score ?? undefined,
    notes: row.notes ?? undefined,
    stops: normalizeStops(row.stops),
    extent,
    geojson: isRecord(row.geojson) && typeof (row.geojson as { type?: unknown }).type === 'string'
      ? (row.geojson as unknown as GeoJSON.Geometry)
      : undefined,
    state: row.state ?? undefined,
    osmValue: row.osm_value ?? undefined,
    osmId: row.osm_id ?? undefined,
    osmType,
    countryCode: row.country_code ?? undefined,
    image: row.image ?? undefined,
    imageProvider,
    imageAuthor: row.image_author ?? undefined,
    imageSourceUrl: row.image_source_url ?? undefined,
    imageQuery: row.image_query ?? undefined,
    imageSearchVersion: row.image_search_version ?? undefined,
    summary: row.summary ?? undefined,
    tripName: row.trip_name ?? undefined,
    visitCount: normalizeVisitCount(row.visit_count),
    tripYear: row.trip_year ?? undefined,
    tripDays: row.trip_days ?? undefined,
    companions,
    personalBudget: row.personal_budget ?? undefined,
    tripTypes: normalizeStoredTripTypes(remapList(normalizeStringList(row.trip_types), LEGACY_TRIP_TYPE_MAP)),
    standout: row.standout ?? undefined,
    standoutTags: remapList(normalizeStringList(row.standout_tags), LEGACY_STANDOUT_MAP),
    coupDeCoeur: row.coup_de_coeur ?? undefined,
    livedThere: row.lived_there ?? undefined,
    vibeBoost: typeof row.vibe_boost === 'number' ? row.vibe_boost : undefined,
    retourBonus: typeof row.retour_bonus === 'number' ? row.retour_bonus : undefined,
    returnIntent: VALID_RETURN_INTENTS.includes(row.return_intent as ReturnIntent)
      ? (row.return_intent as ReturnIntent)
      : undefined,
    memoryNote: typeof row.memory_note === 'string' && row.memory_note.trim() ? row.memory_note.trim() : undefined,
    tierAdjust: typeof row.tier_adjust === 'number' ? row.tier_adjust : undefined,
  }
}

/**
 * Construit la ligne SQL à upsert depuis une Destination TS.
 * `user_id` est requis (RLS), les autres champs deviennent null quand undefined.
 */
export function destinationToRow(destination: Destination, userId: string): Omit<DbDestinationRow, 'id'> {
  return {
    user_id: userId,
    destination_key: destination.destinationKey ?? null,
    name: destination.name,
    country: destination.country,
    lat: destination.lat,
    lng: destination.lng,
    tier: destination.tier ?? null,
    kind: destination.kind ?? null,
    intent: destination.intent,
    food: destination.food ?? null,
    night: destination.night ?? null,
    culture: destination.culture ?? null,
    nature: destination.nature ?? null,
    value: destination.value ?? null,
    ease: destination.ease ?? null,
    memorability: destination.memorability ?? null,
    score: destination.score ?? null,
    notes: destination.notes ?? null,
    stops: destination.stops ?? null,
    extent: destination.extent ? Array.from(destination.extent) : null,
    geojson: destination.geojson ?? null,
    state: destination.state ?? null,
    osm_value: destination.osmValue ?? null,
    osm_id: destination.osmId ?? null,
    osm_type: destination.osmType ?? null,
    country_code: destination.countryCode ?? null,
    image: destination.image ?? null,
    image_provider: destination.imageProvider ?? null,
    image_author: destination.imageAuthor ?? null,
    image_source_url: destination.imageSourceUrl ?? null,
    image_query: destination.imageQuery ?? null,
    image_search_version: destination.imageSearchVersion ?? null,
    summary: destination.summary ?? null,
    trip_name: destination.tripName ?? null,
    visit_count: normalizeVisitCount(destination.visitCount),
    trip_year: destination.tripYear ?? null,
    trip_days: destination.tripDays ?? null,
    companions: destination.companions ?? null,
    personal_budget: destination.personalBudget ?? null,
    trip_types: destination.tripTypes?.length ? destination.tripTypes : null,
    standout: destination.standout ?? null,
    standout_tags: destination.standoutTags?.length ? destination.standoutTags : null,
    coup_de_coeur: destination.coupDeCoeur ?? null,
    lived_there: destination.livedThere ?? null,
    vibe_boost: destination.vibeBoost ?? null,
    retour_bonus: destination.retourBonus ?? null,
    return_intent: destination.returnIntent ?? null,
    memory_note: destination.memoryNote?.trim() || null,
    tier_adjust: destination.tierAdjust ? destination.tierAdjust : null,
  }
}
