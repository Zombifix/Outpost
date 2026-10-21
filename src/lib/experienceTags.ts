import { t } from '../i18n'

/**
 * Stable, persisted IDs for the wizard's experience tags. `Destination.tripTypes`
 * stores these IDs (plus ROAD_TRIP_TAG_ID) — never the translated label text — so
 * the same destination renders correctly regardless of the viewer's language.
 */
interface ExperienceTagDef {
  id: string
  en: string
  fr: string
}

export const ROAD_TRIP_TAG_ID = 'roadtrip'
const ROAD_TRIP_LABEL_EN = '🚗 Road trip'
const ROAD_TRIP_LABEL_FR = '🚗 Road trip'

type ExperienceTagFamily = 'feeling' | 'place' | 'info'

interface OfferedTagDef extends ExperienceTagDef {
  family: ExperienceTagFamily
}

// Tags proposés à la saisie (notation v2). Ils décrivent, ils ne notent pas :
// aucun n'a d'effet sur le tier. Cf. docs/notation-v2.md.
const OFFERED_TAG_DEFS: OfferedTagDef[] = [
  { id: 'surprise',    family: 'feeling', en: '😮 Pleasant surprise',          fr: '😮 Belle surprise' },
  { id: 'surcote',     family: 'feeling', en: '📉 Overrated',                  fr: '📉 Surcoté' },
  { id: 'depaysant',   family: 'feeling', en: '🌏 A change of scene',          fr: '🌏 Dépaysant' },
  { id: 'ressourcant', family: 'feeling', en: '🧘 Recharging',                 fr: '🧘 Ressourçant' },
  { id: 'epuisant',    family: 'feeling', en: '😮‍💨 Exhausting',                fr: '😮‍💨 Épuisant' },
  { id: 'flanerie',    family: 'place',   en: '🚶 Made for wandering',         fr: '🚶 Ville à flâner' },
  { id: 'patrimoine',  family: 'place',   en: '🏛️ Lots of history',           fr: '🏛️ Patrimoine' },
  { id: 'espaces',     family: 'place',   en: '⛰️ Wide open spaces',          fr: '⛰️ Grands espaces' },
  { id: 'plage',       family: 'place',   en: '🏖️ Beach',                     fr: '🏖️ Plage' },
  { id: 'foule',       family: 'info',    en: '👥 Too crowded',                fr: '👥 Trop de monde' },
  { id: 'meteo',       family: 'info',    en: '🌧️ Bad luck with the weather', fr: '🌧️ Pas de chance avec la météo' },
  { id: 'niche',       family: 'info',    en: '🎯 Not for everyone',           fr: '🎯 Pas pour tout le monde' },
]

// Anciens tags : plus proposés, mais toujours affichés sur les destinations
// enregistrées avant la v2.
const LEGACY_TAG_DEFS: ExperienceTagDef[] = [
  { id: 'food',        en: '🍜 Food trip',            fr: '🍜 Food trip' },
  { id: 'beau',        en: '✨ Beautiful everywhere', fr: '✨ Beau partout' },
  { id: 'paysages',    en: '⛰️ Big landscapes',      fr: '⛰️ Grands paysages' },
  { id: 'nightlife',   en: '🌙 Nightlife',            fr: '🌙 Nightlife' },
  { id: 'ambiance',    en: '🎭 Local vibe',           fr: '🎭 Ambiance locale' },
  { id: 'facile',      en: '🧘 Easygoing',            fr: '🧘 Facile à vivre' },
  { id: 'pas-cher',    en: '💸 Cheap',                fr: '💸 Pas cher' },
  { id: 'trop-cher',   en: '💰 Pricey',               fr: '💰 Trop cher' },
  { id: 'transports',  en: '🚇 Rough transit',        fr: '🚇 Transports galère' },
  { id: 'touristique', en: '📍 Too touristy',         fr: '📍 Trop touristique' },
  { id: 'pieges',      en: '🪤 Tourist traps',        fr: '🪤 Pièges à touristes' },
  { id: 'craignos',    en: '⚠️ Sketchy',              fr: '⚠️ Craignos' },
]

const EXPERIENCE_TAG_DEFS: ExperienceTagDef[] = [...OFFERED_TAG_DEFS, ...LEGACY_TAG_DEFS]

export const MAX_EXPERIENCE_TAGS = 3

/** Paires qui s'excluent : choisir l'un désactive l'autre. */
export const EXCLUSIVE_TAG_PAIRS: Array<[string, string]> = [['surprise', 'surcote']]

export const EXPERIENCE_TAG_FAMILIES: { id: ExperienceTagFamily; label: string }[] = [
  { id: 'feeling', label: t('How it felt', 'Ce que tu as ressenti') },
  { id: 'place', label: t('Kind of place', 'Le genre de lieu') },
  { id: 'info', label: t('Good to know', 'À savoir') },
]

/** Tags for the wizard's chip picker: stable `id` to store, translated `label` to show. */
export const EXPERIENCE_TAGS: { id: string; label: string; family: ExperienceTagFamily }[] =
  OFFERED_TAG_DEFS.map(def => ({ id: def.id, label: t(def.en, def.fr), family: def.family }))

export const ROAD_TRIP_LABEL = t(ROAD_TRIP_LABEL_EN, ROAD_TRIP_LABEL_FR)

const LABEL_TO_ID = new Map<string, string>()
for (const def of EXPERIENCE_TAG_DEFS) {
  LABEL_TO_ID.set(def.en, def.id)
  LABEL_TO_ID.set(def.fr, def.id)
}
LABEL_TO_ID.set(ROAD_TRIP_LABEL_EN, ROAD_TRIP_TAG_ID)
LABEL_TO_ID.set(ROAD_TRIP_LABEL_FR, ROAD_TRIP_TAG_ID)

const VALID_IDS = new Set<string>([...EXPERIENCE_TAG_DEFS.map(def => def.id), ROAD_TRIP_TAG_ID])

/** Resolves a stored `tripTypes` entry — a current ID or a pre-migration label string — to its ID. */
function normalizeExperienceTagValue(value: string): string {
  if (VALID_IDS.has(value)) return value
  return LABEL_TO_ID.get(value) ?? value
}

/**
 * Migrates a `tripTypes` array that may still hold old French label strings
 * (saved before tags became ID-based) into the current ID-based format.
 * Unrecognized entries pass through unchanged so unknown legacy data isn't dropped.
 */
export function normalizeStoredTripTypes(tripTypes: string[] | undefined): string[] | undefined {
  if (!tripTypes?.length) return tripTypes
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of tripTypes) {
    const id = normalizeExperienceTagValue(raw)
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

/** Resolves a stored tripTypes ID to its translated display label. Falls back to the raw value for unknown/legacy entries. */
export function getExperienceTagLabel(id: string): string {
  if (id === ROAD_TRIP_TAG_ID) return ROAD_TRIP_LABEL
  const def = EXPERIENCE_TAG_DEFS.find(d => d.id === id)
  return def ? t(def.en, def.fr) : id
}
