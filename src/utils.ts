import type { Destination, Tier, Intent } from './types'
import { COUNTRY_TO_CONTINENT, type Continent } from './data'

/**
 * Limite dynamique de coups de cœur : +1 tous les 6 destinations à partir de 14.
 * Exemples : ≤13 → 2 / 14 → 3 / 20 → 4 / 26 → 5 / 32 → 6
 */
export function getMaxCoupDeCoeur(totalDestinations: number): number {
  return Math.max(2, Math.floor((totalDestinations + 4) / 6))
}

// ─── Notation v2 : modèle des tiroirs (cf. docs/notation-v2.md) ─────────────
//
// 1. Le verdict (retourBonus) fixe le tiroir de départ : Fonce A, Ça vaut le
//    coup B, Bof C, Évite D.
// 2. Les autres réponses donnent des points : meilleure réponse +1 sur les axes
//    qui peuvent émerveiller, pire réponse −1 sur tous les axes, coup de cœur +1.
// 3. Bilan ≥ +2 : on monte d'un cran. Bilan ≤ −2 : on descend d'un cran.
// 4. S demande une clé : coup de cœur ou « Demain, sans hésiter ».
// 5. « Je ne me sentais pas en sécurité » plafonne à B.
// 6. La correction manuelle (tierAdjust, ±1) passe en dernier.
//
// Encodage des réponses dans les colonnes existantes :
//   culture (journées), nature (cadre), food (repas), night (soirées),
//   value (budget) : 5 / 4 / 3 / 1
//   vibeBoost (accueil) : 5 adorables / 3 rien à signaler / 2 froids / 1 insécurité
//   ease (déplacements) : 5 simple / 3 s'adapter / 1 galère
//   retourBonus (verdict) : 0.3 / 0.1 / 0 / -0.3

export const VERDICT_VALUES = { go: 0.3, worth: 0.1, meh: 0, skip: -0.3 } as const
export const SAFETY_ISSUE_VALUE = 1
export const BEST_ANSWER_VALUE = 5
export const WORST_ANSWER_VALUE = 1

const TIER_LADDER: Tier[] = ['D', 'C', 'B', 'A', 'S']
// Centre de chaque tiroir sur l'échelle 1–5. L'écart dans le tiroir (bilan ×
// 0,03, au plus ±0,15) ne fait jamais changer de tiroir, même arrondi à 0,1.
const TIER_CENTER: Record<Tier, number> = { S: 4.75, A: 4.25, B: 3.6, C: 2.8, D: 1.7 }

type WowAxis = 'culture' | 'nature' | 'food' | 'night' | 'vibeBoost'
type FlopOnlyAxis = 'ease' | 'value'
const WOW_AXES: WowAxis[] = ['culture', 'nature', 'food', 'night', 'vibeBoost']
const FLOP_ONLY_AXES: FlopOnlyAxis[] = ['ease', 'value']

export type RatingAxis = WowAxis | FlopOnlyAxis

export interface TierBreakdown {
  startTier: Tier
  points: number
  wows: RatingAxis[]
  flops: RatingAxis[]
  hasKey: boolean
  favorite: boolean
  safetyCap: boolean
  computedTier: Tier
  adjust: number
  tier: Tier
}

function startTierFromVerdict(verdict: number): Tier {
  if (verdict >= 0.3) return 'A'
  if (verdict >= 0.1) return 'B'
  if (verdict >= 0) return 'C'
  return 'D'
}

function shiftTier(tier: Tier, delta: number): Tier {
  const index = TIER_LADDER.indexOf(tier)
  return TIER_LADDER[Math.max(0, Math.min(TIER_LADDER.length - 1, index + delta))]
}

function clampAdjust(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(-1, Math.min(1, Math.round(value)))
}

/** Une destination est notée en v2 dès que le verdict a été donné. */
export function hasVerdict(destination: Pick<Destination, 'retourBonus'>): boolean {
  return typeof destination.retourBonus === 'number' && Number.isFinite(destination.retourBonus)
}

export function computeTierBreakdown(destination: Destination): TierBreakdown | null {
  if (!hasVerdict(destination)) return null
  const startTier = startTierFromVerdict(destination.retourBonus as number)
  const wows: RatingAxis[] = []
  const flops: RatingAxis[] = []

  for (const axis of WOW_AXES) {
    const value = destination[axis]
    if (typeof value !== 'number') continue
    if (value >= BEST_ANSWER_VALUE) wows.push(axis)
    else if (value <= WORST_ANSWER_VALUE) flops.push(axis)
  }
  for (const axis of FLOP_ONLY_AXES) {
    const value = destination[axis]
    if (typeof value === 'number' && value <= WORST_ANSWER_VALUE) flops.push(axis)
  }

  const points = wows.length - flops.length + (destination.coupDeCoeur ? 1 : 0)
  const hasKey = Boolean(destination.coupDeCoeur) || destination.returnIntent === 'tomorrow'
  const safetyCap = destination.vibeBoost === SAFETY_ISSUE_VALUE

  let tier = startTier
  if (points >= 2) tier = shiftTier(tier, 1)
  else if (points <= -2) tier = shiftTier(tier, -1)
  if (tier === 'S' && !hasKey) tier = 'A'
  if (safetyCap && (tier === 'S' || tier === 'A')) tier = 'B'
  const computedTier = tier

  const adjust = clampAdjust(destination.tierAdjust)
  const finalTier = adjust === 0 ? computedTier : shiftTier(computedTier, adjust)

  const favorite = Boolean(destination.coupDeCoeur)
  return { startTier, points, wows, flops, hasKey, favorite, safetyCap, computedTier, adjust, tier: finalTier }
}

/**
 * Tier affiché. `null` = destination pas (encore) notée. Les lignes antérieures
 * à la v2 sans verdict gardent leur tier stocké jusqu'à ce qu'on les renote.
 */
export function getDestinationTier(destination: Destination): Tier | null {
  const breakdown = computeTierBreakdown(destination)
  if (breakdown) return breakdown.tier
  return destination.tier ?? null
}

export function isRated(destination: Destination): boolean {
  return getDestinationTier(destination) !== null
}

/**
 * Score numérique, utilisé pour trier dans un tiroir et pour la note du peuple.
 * 0 = pas notée (trié en dernier).
 */
export function getDestinationScore(destination: Destination): number {
  const breakdown = computeTierBreakdown(destination)
  if (breakdown) {
    const spread = Math.max(-5, Math.min(5, breakdown.points)) * 0.03
    return TIER_CENTER[breakdown.tier] + spread + (breakdown.hasKey ? 0.005 : 0)
  }
  if (destination.tier) {
    const stored = destination.score
    return typeof stored === 'number' && scoreToTier(stored) === destination.tier ? stored : TIER_CENTER[destination.tier]
  }
  return 0
}

export function scoreToTier(score: number): Tier {
  if (score >= 4.5) return 'S'
  if (score >= 4.0) return 'A'
  if (score >= 3.2) return 'B'
  if (score >= 2.4) return 'C'
  return 'D'
}

export function getVisitCount(destination: Pick<Destination, 'visitCount'>): number {
  return Number.isInteger(destination.visitCount) && (destination.visitCount ?? 0) >= 1
    ? destination.visitCount as number
    : 1
}

export function formatVisitCountLabel(count: number, locale: 'fr' | 'en' = 'fr'): string {
  if (locale === 'en') return `${count} visit${count > 1 ? 's' : ''}`
  return `${count} visite${count > 1 ? 's' : ''}`
}

export function withRecalculatedScore(destination: Destination): Destination {
  const tier = getDestinationTier(destination)
  if (!tier) return { ...destination, score: undefined, tier: undefined }
  const score = getDestinationScore(destination)
  return {
    ...destination,
    score: Math.round(score * 10) / 10,
    tier,
  }
}

// ─── Profil voyageur (Fiche signalétique) ─────────────────────────────────────
// Stats descriptives, sans IA, avec seuils explicites pour ne rien forcer.

export type ProfileConfidence = 'empty' | 'low' | 'medium-low' | 'medium' | 'high' | 'light' | 'mid' | 'full'
export type ContinentBucket = Continent | 'Autre'
type ArchetypeKey = 'faithful' | 'selective' | 'thoughtful' | 'comfort' | 'nomad' | 'nature' | 'epicurean' | 'open'
type UsedSignal =
  | 'countryRepeat'
  | 'continentDominance'
  | 'lowScores'
  | 'highScores'
  | 'lowFavorites'
  | 'highFavorites'
  | 'budgetHigh'
  | 'budgetLow'
  | 'shortTrips'
  | 'foodPattern'
  | 'culturePattern'
  | 'naturePattern'
  | 'negativeTags'
  | 'diversity'
  | 'workPattern'

type NormalizedTripType = 'culture' | 'food' | 'nature' | 'rest' | 'nightlife' | 'roadtrip' | 'work' | 'city'
type NormalizedStandout =
  | 'culinary'
  | 'scenery'
  | 'architecture'
  | 'locals'
  | 'budgetPain'
  | 'transportPain'
  | 'touristTrap'
  | 'exhausting'
  | 'weather'

export type DestinationRegionTag =
  | 'Îles britanniques'
  | 'Europe du Nord'
  | 'Méditerranée'
  | 'Balkans'
  | "Europe de l'Est"
  | "Europe de l'Ouest"
  | 'Amérique du Nord'
  | 'Amérique latine'
  | 'Asie urbaine'
  | 'Asie nature'
  | 'Maghreb'
  | 'Moyen-Orient'
  | 'Ailleurs'

export type DestinationVibeTag =
  | 'grande ville'
  | 'ville moyenne'
  | 'capitale'
  | 'bord de mer'
  | 'montagne'
  | 'campagne'
  | 'île'
  | 'nature'
  | 'patrimoine'
  | 'fête'
  | 'repos'
  | 'cher'
  | 'accessible'
  | 'touristique'
  | 'alternatif'

export type TripPace = 'slow' | 'balanced' | 'dense' | 'exhausting'
export type ProfileTripIntent = 'culture' | 'food' | 'nature' | 'nightlife' | 'rest' | 'work' | 'mixed'

export interface TravelerSignature {
  key: 'geo' | 'year' | 'coeur' | 'format' | 'budget' | 'notes' | 'companion' | 'intent'
  icon: string
  label: string
  detail?: string
}

export interface ContinentShare {
  continent: ContinentBucket
  count: number
  pct: number
}

export interface TravelerBehaviorTag {
  key: string
  label: string
}

export interface TravelerAchievement {
  key: string
  icon: string
  title: string
  detail: string
  tone?: 'red' | 'gold' | 'heart' | 'teal' | 'blue'
}

export interface TravelerTerritory {
  key: ContinentBucket
  label: string
  count: number
  pct: number
}

export interface TravelerProfileStats {
  destinationCount: number
  travelCount: number
  totalVisitOccurrences: number
  repeatVisitOccurrences: number
  uniqueCountryCount: number
  mainCountry: string | null
  mainCountryRepeat: number
  mainCountryRatio: number
  topRevisitedDestination: string | null
  topRevisitedDestinationCount: number
  topRevisitedCountry: string | null
  topRevisitedCountryCount: number
  continentCount: number
  mainContinent: ContinentBucket | null
  mainContinentRatio: number
  tripDaysMedian: number | null
  shortTripRatio: number
  longTripRatio: number
  personalBudgetMedian: number | null
  scoreAverage: number | null
  scoreCount: number
  scoreVariance: number | null
  favoriteCount: number
  favoriteRatio: number
  workTripRatio: number
  museumTripTypeRatio: number
  foodTourRatio: number
  natureTripTypeRatio: number
  lazyModeRatio: number
  nightlifeRatio: number
  architectureStandoutRatio: number
  culinaryStandoutRatio: number
  outdoorStandoutRatio: number
  negativeStandoutTagsRatio: number
  positiveStandoutTagsRatio: number
  logisticsPainRatio: number
  budgetPainRatio: number
  diverseTripTypesScore: number
  tripIntent: ProfileTripIntent
  tripPace: TripPace
  regionTags: DestinationRegionTag[]
  vibeTags: DestinationVibeTag[]
  // ── Dimensions chiffrées (faits surprenants, axes indépendants) ──
  // Géo : amplitude du carnet (paire la plus éloignée, sans besoin du domicile).
  geoSpanKm: number
  farthestPair: { a: string; b: string; km: number } | null
  // Temps : à partir de tripYear.
  datedTripCount: number
  firstTripYear: number | null
  lastTripYear: number | null
  peakYear: number | null
  peakYearCount: number
  longestGapYears: number
  // Social : à partir de companions.
  companionDataCount: number
  dominantCompanion: NonNullable<Destination['companions']> | null
  dominantCompanionRatio: number
  soloRatio: number
  // Exigence : distribution réelle de la tier-list (pas la moyenne abstraite).
  ratedTierCount: number
  sTierCount: number
  topTier: Tier | null
}

export interface TravelerProfile {
  total: number
  travelCount: number
  countries: number
  coupDeCoeurCount: number
  confidence: ProfileConfidence
  title: string
  subtitle: string | null
  behaviorTags: TravelerBehaviorTag[]
  achievements: TravelerAchievement[]
  territories: TravelerTerritory[]
  /** Verdict auto-généré, conservé pour les composants legacy. */
  archetype: string | null
  signatures: TravelerSignature[]
  continents: ContinentShare[]
  debug: {
    stats: TravelerProfileStats
    archetypeScores: Record<ArchetypeKey, number>
    usedSignals: Record<UsedSignal, boolean>
    derivedTags: {
      regionTags: DestinationRegionTag[]
      vibeTags: DestinationVibeTag[]
      tripPace: TripPace
      tripIntent: ProfileTripIntent
    }
  }
}

function continentOf(country: string): ContinentBucket {
  return COUNTRY_TO_CONTINENT[country] ?? 'Autre'
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function topEntry<K extends string>(counts: Record<K, number>): { key: K, count: number, total: number, second: number } {
  let topKey: K | null = null
  let topCount = 0
  let secondCount = 0
  let total = 0
  for (const k of Object.keys(counts) as K[]) {
    const c = counts[k]
    total += c
    if (c > topCount) { secondCount = topCount; topCount = c; topKey = k }
    else if (c > secondCount) { secondCount = c }
  }
  return { key: (topKey ?? ('' as K)), count: topCount, total, second: secondCount }
}

function legacyComputeTravelerProfile(destinations: Destination[]): Omit<TravelerProfile, 'title' | 'subtitle' | 'behaviorTags' | 'achievements' | 'territories' | 'debug'> {
  const total = destinations.length
  const travels = destinations.filter(d => !d.livedThere)
  const travelCount = travels.length
  const countries = new Set(destinations.map(d => d.country).filter(Boolean)).size
  const coupDeCoeurCount = travels.filter(d => d.coupDeCoeur).length

  // Continent share = pays uniques par continent / total pays uniques
  const continentCountrySets: Record<ContinentBucket, Set<string>> = {
    Europe: new Set(), Asie: new Set(), Ameriques: new Set(), Afrique: new Set(), Oceanie: new Set(), Autre: new Set(),
  }
  for (const d of destinations) {
    if (d.country) continentCountrySets[continentOf(d.country)].add(d.country)
  }
  const totalCountries = countries || 1
  const continents: ContinentShare[] = (Object.keys(continentCountrySets) as ContinentBucket[])
    .map(c => ({ continent: c, count: continentCountrySets[c].size, pct: (continentCountrySets[c].size / totalCountries) * 100 }))
    .filter(c => c.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)

  let confidence: ProfileConfidence = 'empty'
  if (total > 0 && total < 3) confidence = 'light'
  else if (total >= 3 && total < 8) confidence = 'mid'
  else if (total >= 8) confidence = 'full'

  // ── Données brutes ───────────────────────────────────────────────────────────

  // Pays (voyages uniquement, hors livedThere)
  const countryCounts: Record<string, number> = {}
  for (const d of travels) if (d.country) countryCounts[d.country] = (countryCounts[d.country] ?? 0) + 1
  const sortedCountries = Object.entries(countryCounts).sort((a, b) => b[1] - a[1])
  const topCountryName = sortedCountries[0]?.[0] ?? null
  const topCountryN = sortedCountries[0]?.[1] ?? 0
  const topCountryPct = travelCount > 0 ? (topCountryN / travelCount) * 100 : 0

  // Intent (brut, non pondéré)
  const intentCounts: Record<Intent, number> = { 'city-trip': 0, tourisme: 0, sorties: 0, gastro: 0, nature: 0, travail: 0 }
  for (const d of travels) intentCounts[d.intent]++
  const intentSorted = (Object.keys(intentCounts) as Intent[]).map(k => ({ k, n: intentCounts[k] })).sort((a, b) => b.n - a.n)
  const topIntent = intentSorted[0]
  const topIntentPct = travelCount > 0 && topIntent ? (topIntent.n / travelCount) * 100 : 0
  const hasStrongIntent = topIntentPct >= 38 && travelCount >= 3

  // Durée (médiane)
  const dayValues = travels.map(d => d.tripDays).filter((v): v is number => typeof v === 'number' && v > 0)
  const medDays = dayValues.length >= 3 ? median(dayValues) : null

  // Budget (médiane par jour)
  const perDayValues = travels
    .map(d => (d.personalBudget && d.tripDays && d.tripDays > 0 ? d.personalBudget / d.tripDays : null))
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0)
  const medBudget = perDayValues.length >= 3 ? median(perDayValues) : null

  // Notes (moyenne)
  const scoreValues = travels.map(d => d.score ?? getDestinationScore(d)).filter(v => Number.isFinite(v) && v > 0)
  const avgScore = scoreValues.length >= 3 ? scoreValues.reduce((s, v) => s + v, 0) / scoreValues.length : null

  // Coups de cœur par pays (archétype)
  const coeurByCountry: Record<string, number> = {}
  for (const d of travels) if (d.coupDeCoeur && d.country) coeurByCountry[d.country] = (coeurByCountry[d.country] ?? 0) + 1
  const topCoeurEntry = Object.entries(coeurByCountry).sort((a, b) => b[1] - a[1])[0] ?? null
  const topCoeurMatchesTop = topCoeurEntry?.[0] === topCountryName
  const topCoeurPct = topCoeurEntry && coupDeCoeurCount > 0 ? (topCoeurEntry[1] / coupDeCoeurCount) * 100 : 0

  // Notes moyennes dans le pays dominant (archétype 4)
  const scoresInTopCountry: number[] = []
  if (topCountryName) {
    for (const d of travels) {
      if (d.country === topCountryName) {
        const s = d.score ?? getDestinationScore(d)
        if (Number.isFinite(s) && s > 0) scoresInTopCountry.push(s)
      }
    }
  }
  const avgScoreTopCountry = scoresInTopCountry.length >= 2
    ? scoresInTopCountry.reduce((s, v) => s + v, 0) / scoresInTopCountry.length
    : null

  // Continent dominant
  const dominantContinent = continents[0] ?? null
  const dominantContinentPct = dominantContinent?.pct ?? 0

  // Companions
  const compCounts: Record<string, number> = {}
  for (const d of travels) if (d.companions) compCounts[d.companions] = (compCounts[d.companions] ?? 0) + 1
  const compSorted = Object.entries(compCounts).sort((a, b) => b[1] - a[1])
  const topComp = compSorted[0] ?? null
  const topCompPct = topComp && travelCount > 0 ? (topComp[1] / travelCount) * 100 : 0
  const COMP_SUFFIX: Record<string, string> = {
    solo: ' · en solo', couple: ' · à deux', amis: ' · entre amis', famille: ' · en famille',
  }
  const formatCompSuffix = topComp && topCompPct >= 50 ? (COMP_SUFFIX[topComp[0]] ?? '') : ''

  // ── Archétype (37 conditions, première qui matche gagne) ─────────────────────
  let archetype: string | null = null

  if (confidence !== 'empty' && confidence !== 'light') {

    // 1. Pays ultra dominant
    if (topCountryName && (topCountryN >= 5 || topCountryPct >= 50)) {
      archetype = `${topCountryName} commence à le reconnaître`
    }
    // 3. Pays + coups de cœur (plus spécifique que 2 → testé avant)
    else if (topCountryName && topCountryN >= 3 && coupDeCoeurCount >= 2 && topCoeurMatchesTop && topCoeurPct >= 50) {
      archetype = `A clairement un faible pour ${topCountryName}`
    }
    // 4. Pays + notes très hautes (plus spécifique que 2 → testé avant)
    else if (topCountryName && topCountryN >= 3 && avgScoreTopCountry !== null && avgScoreTopCountry >= 4.2) {
      archetype = `A arrêté de faire semblant d'être objectif`
    }
    // 2. Pays récurrent
    else if (topCountryName && topCountryN >= 3) {
      archetype = `Retourne souvent en ${topCountryName}, "par hasard"`
    }
    // 5. City-trip + courts séjours
    else if (hasStrongIntent && topIntent.k === 'city-trip' && medDays !== null && medDays <= 4) {
      archetype = `Part 48 h et appelle ça une immersion`
    }
    // 6. City-trip + Europe dominante
    else if (hasStrongIntent && topIntent.k === 'city-trip' && dominantContinent?.continent === 'Europe' && dominantContinentPct >= 50) {
      archetype = `Transforme l'Europe en planning de week-end`
    }
    // 7. City-trip seul
    else if (hasStrongIntent && topIntent.k === 'city-trip') {
      archetype = `Aime les villes qui fatiguent un peu`
    }
    // 8. Patrimoine + notes hautes
    else if (hasStrongIntent && topIntent.k === 'tourisme' && avgScore !== null && avgScore >= 3.8) {
      archetype = `Prend les vieilles pierres très au sérieux`
    }
    // 9. Patrimoine seul
    else if (hasStrongIntent && topIntent.k === 'tourisme') {
      archetype = `Lit vraiment les panneaux explicatifs`
    }
    // 11. Sorties + budget élevé (plus spécifique que 10 → testé avant)
    else if (hasStrongIntent && topIntent.k === 'sorties' && medBudget !== null && medBudget > 140) {
      archetype = `Le lendemain coûte parfois plus cher que prévu`
    }
    // 10. Sorties seul
    else if (hasStrongIntent && topIntent.k === 'sorties') {
      archetype = `Découvre la culture locale après minuit`
    }
    // 12. Gastro + budget élevé
    else if (hasStrongIntent && topIntent.k === 'gastro' && medBudget !== null && medBudget > 120) {
      archetype = `Confond itinéraire et réservation`
    }
    // 13. Gastro + budget malin
    else if (hasStrongIntent && topIntent.k === 'gastro' && medBudget !== null && medBudget < 90) {
      archetype = `Mange bien, mais surveille l'addition`
    }
    // 14. Gastro seul
    else if (hasStrongIntent && topIntent.k === 'gastro') {
      archetype = `Le repas décide souvent du planning`
    }
    // 15. Nature + longs séjours
    else if (hasStrongIntent && topIntent.k === 'nature' && medDays !== null && medDays > 5) {
      archetype = `Va là où le Wi-Fi perd confiance`
    }
    // 16. Nature seul
    else if (hasStrongIntent && topIntent.k === 'nature') {
      archetype = `Fuit le béton dès que possible`
    }
    // 17. Travail + courts séjours
    else if (hasStrongIntent && topIntent.k === 'travail' && medDays !== null && medDays <= 4) {
      archetype = `Travaille, mais ne gâche pas le décor`
    }
    // 18. Travail seul
    else if (hasStrongIntent && topIntent.k === 'travail') {
      archetype = `Appelle ça pro, regarde quand même les restos`
    }
    // 19. Courts séjours dominants
    else if (travelCount >= 5 && medDays !== null && medDays <= 4) {
      archetype = `A fait du pont une discipline olympique`
    }
    // 20. Séjours d'une semaine
    else if (travelCount >= 5 && medDays !== null && medDays >= 5 && medDays <= 10) {
      archetype = `Reste assez pour juger, pas pour s'attacher`
    }
    // 21. Longs voyages
    else if (travelCount >= 5 && medDays !== null && medDays > 10) {
      archetype = `Ne part pas juste pour voir vite fait`
    }
    // 22. Budget malin
    else if (travelCount >= 5 && medBudget !== null && medBudget < 80) {
      archetype = `Fait souffrir le budget avec élégance`
    }
    // 23. Budget confort
    else if (travelCount >= 5 && medBudget !== null && medBudget >= 80 && medBudget <= 180) {
      archetype = `Se prive rarement, mais avec retenue`
    }
    // 24. Budget large
    else if (travelCount >= 5 && medBudget !== null && medBudget > 180) {
      archetype = `A une définition souple du raisonnable`
    }
    // 25. Notes généreuses
    else if (travelCount >= 5 && scoreValues.length >= 5 && avgScore !== null && avgScore > 4.2) {
      archetype = `Aime presque tout, c'est suspect`
    }
    // 26. Notes critiques
    else if (travelCount >= 5 && scoreValues.length >= 5 && avgScore !== null && avgScore < 2.8) {
      archetype = `N'accorde pas son enthousiasme gratuitement`
    }
    // 27. Beaucoup de coups de cœur
    else if (travelCount >= 5 && coupDeCoeurCount / travelCount >= 0.4) {
      archetype = `Tombe amoureux plus souvent qu'il ne l'avoue`
    }
    // 28. Très peu de coups de cœur
    else if (travelCount >= 8 && coupDeCoeurCount / travelCount <= 0.1) {
      archetype = `Garde ses émotions en bagage cabine`
    }
    // 29–33. Continent dominant (uniquement si aucun intent fort)
    else if (!hasStrongIntent && dominantContinent && dominantContinentPct >= 50) {
      const CONTINENT_ARCHETYPE: Partial<Record<ContinentBucket, string>> = {
        Europe:    `Reste près, mais fait comme si c'était loin`,
        Asie:      `Regarde souvent vers l'Est, l'air de rien`,
        Ameriques: `Traverse l'Atlantique sans trop se justifier`,
        Afrique:   `Cherche autre chose qu'un simple city-break`,
        Oceanie:   `Trouve que « loin » reste négociable`,
      }
      archetype = CONTINENT_ARCHETYPE[dominantContinent.continent] ?? null
    }
    // 34. Plusieurs continents équilibrés
    else if (continents.filter(c => c.pct >= 12).length >= 4) {
      archetype = `Refuse de laisser les stats choisir un camp`
    }
    // 35. Profil très dispersé
    else if (travelCount >= 12) {
      archetype = `Même les données ont lâché l'affaire`
    }
    // 36. Profil en construction (mid confidence, rien de net)
    else if (confidence === 'mid') {
      archetype = `Le carnet n'a pas encore assez de dossiers`
    }
    // 37. Fallback → null (déjà null)
  }

  // ── Signaux (3 slots max : géo / comportemental / humain) ────────────────────

  // Slot 1 — Géographique fort
  const slot1: TravelerSignature | null = (() => {
    if (topCountryName && topCountryN >= 4) {
      return { key: 'geo' as const, icon: '📍', label: `Le contrôle frontière doit le connaître`, detail: `${topCountryName} · ${topCountryN} voyages` }
    }
    if (topCountryName && topCountryN >= 2) {
      return { key: 'geo' as const, icon: '📍', label: `Revient souvent sur ses pas`, detail: `${topCountryName} · ${topCountryN} voyages` }
    }
    const yearCounts: Record<string, number> = {}
    for (const d of travels) if (d.tripYear) yearCounts[String(d.tripYear)] = (yearCounts[String(d.tripYear)] ?? 0) + 1
    const topYear = Object.entries(yearCounts).sort((a, b) => b[1] - a[1])[0] ?? null
    if (topYear && topYear[1] >= 5) {
      return { key: 'year' as const, icon: '📅', label: `A sérieusement malmené son calendrier`, detail: `${topYear[0]} · ${topYear[1]} voyages` }
    }
    if (topYear && topYear[1] >= 3) {
      return { key: 'year' as const, icon: '📅', label: `Année peu compatible avec le repos`, detail: `${topYear[0]} · ${topYear[1]} voyages` }
    }
    return null
  })()

  // Slot 2 — Comportemental (notes > budget > format)
  const slot2: TravelerSignature | null = (() => {
    if (scoreValues.length >= 5 && avgScore !== null) {
      if (avgScore < 2.3) return { key: 'notes' as const, icon: '🧐', label: `Même les belles vues doivent argumenter`,   detail: `moy. ${avgScore.toFixed(1)}/5` }
      if (avgScore < 2.8) return { key: 'notes' as const, icon: '🧐', label: `Ne valide pas pour faire plaisir`,          detail: `moy. ${avgScore.toFixed(1)}/5` }
      if (avgScore > 4.3) return { key: 'notes' as const, icon: '⭐', label: `Voit le charme même quand il se cache`,     detail: `moy. ${avgScore.toFixed(1)}/5` }
      if (avgScore > 3.8) return { key: 'notes' as const, icon: '⭐', label: `A la note facile`,                          detail: `moy. ${avgScore.toFixed(1)}/5` }
    }
    if (perDayValues.length >= 3 && medBudget !== null) {
      if (medBudget > 180) return { key: 'budget' as const, icon: '💳', label: `La carte bleue participe aussi au voyage`, detail: `~${Math.round(medBudget)} €/j` }
      if (medBudget < 80)  return { key: 'budget' as const, icon: '💳', label: `Serre le budget sans le dire trop fort`,   detail: `~${Math.round(medBudget)} €/j` }
      return              { key: 'budget' as const, icon: '💳', label: `Le confort reste dans la conversation`,           detail: `~${Math.round(medBudget)} €/j` }
    }
    if (dayValues.length >= 3 && medDays !== null) {
      if (medDays > 10) return { key: 'format' as const, icon: '🧳', label: `Part avec une vraie intention`,       detail: `~${Math.round(medDays)} j${formatCompSuffix}` }
      if (medDays <= 4) return { key: 'format' as const, icon: '🧳', label: `Passe vite, juge quand même`,        detail: `~${Math.round(medDays)} j${formatCompSuffix}` }
      return            { key: 'format' as const, icon: '🧳', label: `S'installe juste avant de repartir`,       detail: `~${Math.round(medDays)} j${formatCompSuffix}` }
    }
    return null
  })()

  // Slot 3 — Humain (coups de cœur > companion > intent)
  const slot3: TravelerSignature | null = (() => {
    if (travelCount >= 5 && coupDeCoeurCount >= 2) {
      const cdcByCont: Record<ContinentBucket, number> = { Europe: 0, Asie: 0, Ameriques: 0, Afrique: 0, Oceanie: 0, Autre: 0 }
      for (const d of travels) if (d.coupDeCoeur && d.country) cdcByCont[continentOf(d.country)]++
      const topCdc = (Object.entries(cdcByCont) as [ContinentBucket, number][]).sort((a, b) => b[1] - a[1])[0]
      if (topCdc && topCdc[1] / coupDeCoeurCount >= 0.5) {
        const CONT_LABEL: Record<ContinentBucket, string> = { Europe: 'Europe', Asie: 'Asie', Ameriques: 'Amériques', Afrique: 'Afrique', Oceanie: 'Océanie', Autre: 'Autre' }
        return { key: 'coeur' as const, icon: '💛', label: `Le cœur manque un peu de neutralité`, detail: `${CONT_LABEL[topCdc[0]]} · ${topCdc[1]}/${coupDeCoeurCount} coups de cœur` }
      }
    }
    if (travelCount >= 5 && coupDeCoeurCount / travelCount >= 0.4) {
      return { key: 'coeur' as const, icon: '💛', label: `S'attache plus vite que prévu`, detail: `${coupDeCoeurCount}/${travelCount} coups de cœur` }
    }
    if (travelCount >= 8 && coupDeCoeurCount > 0 && coupDeCoeurCount / travelCount <= 0.1) {
      return { key: 'coeur' as const, icon: '🖤', label: `Distribue peu les grands frissons`, detail: `${coupDeCoeurCount}/${travelCount} coups de cœur` }
    }
    if (topComp && topCompPct >= 50 && travelCount >= 5) {
      type CompKey = 'solo' | 'couple' | 'amis' | 'famille'
      const COMP_SIG: Record<CompKey, { icon: string; label: string; detail: string }> = {
        solo:    { icon: '🚶', label: `N'attend pas que le groupe soit prêt`,   detail: `${topComp[1]}/${travelCount} en solo` },
        couple:  { icon: '👥', label: `Part souvent avec son témoin principal`, detail: `${topComp[1]}/${travelCount} à deux` },
        amis:    { icon: '🍻', label: `Voyage rarement sans comité`,            detail: `${topComp[1]}/${travelCount} entre amis` },
        famille: { icon: '🏡', label: `Embarque la tribu dans l'histoire`,      detail: `${topComp[1]}/${travelCount} en famille` },
      }
      const sig = COMP_SIG[topComp[0] as CompKey]
      if (sig) return { key: 'companion' as const, icon: sig.icon, label: sig.label, detail: sig.detail }
    }
    if (hasStrongIntent && topIntent) {
      const INTENT_SIG: Record<Intent, { icon: string; label: string }> = {
        'city-trip': { icon: '🏛️', label: `Cherche vite le centre et un bon café` },
        tourisme:    { icon: '🏺', label: `Fait semblant de ne pas aimer les musées` },
        sorties:     { icon: '🌙', label: `Garde de l'énergie pour les mauvaises idées` },
        gastro:      { icon: '🍽️', label: `Le repas décide souvent du planning` },
        nature:      { icon: '🌿', label: `Fuit le béton dès que possible` },
        travail:     { icon: '💼', label: `Optimise le déplacement, évidemment` },
      }
      const INTENT_DETAIL: Record<Intent, string> = {
        'city-trip': 'city-trip', tourisme: 'patrimoine', sorties: 'sorties', gastro: 'gastro', nature: 'nature', travail: 'pro',
      }
      const sig = INTENT_SIG[topIntent.k]
      return { key: 'intent' as const, icon: sig.icon, label: sig.label, detail: `${Math.round(topIntentPct)}% ${INTENT_DETAIL[topIntent.k]}` }
    }
    return null
  })()

  return {
    total,
    travelCount,
    countries,
    coupDeCoeurCount,
    confidence,
    archetype,
    signatures: [slot1, slot2, slot3].filter((s): s is TravelerSignature => s !== null),
    continents,
  }
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function variance(values: number[]): number | null {
  const avg = average(values)
  if (avg === null || values.length < 2) return null
  return values.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / values.length
}

function clamp100(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function ratioScore(value: number, min: number, max: number): number {
  if (value <= min) return 0
  if (value >= max) return 100
  return ((value - min) / (max - min)) * 100
}

function countScore(count: number, min: number, max: number): number {
  if (count <= min) return 0
  if (count >= max) return 100
  return ((count - min) / (max - min)) * 100
}

/** Distance grand-cercle en km (haversine). n petit → O(n²) acceptable. */
function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

function addUnique<T extends string>(items: T[], item: T) {
  if (!items.includes(item)) items.push(item)
}

function stripEmojiLabel(label: string): string {
  return label
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
}

function isWorkTrip(destination: Destination): boolean {
  return destination.intent === 'travail' || destination.companions === 'travail'
}

function normalizeTripTypes(destination: Destination): NormalizedTripType[] {
  const types: NormalizedTripType[] = []
  for (const raw of destination.tripTypes ?? []) {
    const label = stripEmojiLabel(raw)
    if (label.includes('musee') || label.includes('monument') || label.includes('culture')) addUnique(types, 'culture')
    if (label.includes('food') || label.includes('gastro')) addUnique(types, 'food')
    if (label.includes('grand air') || label.includes('rando') || label.includes('nature')) addUnique(types, 'nature')
    if (label.includes('lezard') || label.includes('repos')) addUnique(types, 'rest')
    if (label.includes('nuit') || label.includes('fete') || label.includes('bar')) addUnique(types, 'nightlife')
    if (label.includes('road trip') || label.includes('roadtrip')) addUnique(types, 'roadtrip')
    if (label.includes('bleisure') || label.includes('boulot') || label.includes('travail')) addUnique(types, 'work')
    if (label.includes('city')) addUnique(types, 'city')
  }
  const hasExplicitTypes = types.length > 0
  if (destination.intent === 'tourisme' && !hasExplicitTypes) addUnique(types, 'culture')
  if (destination.intent === 'gastro') addUnique(types, 'food')
  if (destination.intent === 'nature') addUnique(types, 'nature')
  if (destination.intent === 'sorties') addUnique(types, 'nightlife')
  if (destination.intent === 'travail') addUnique(types, 'work')
  if (destination.intent === 'city-trip') addUnique(types, 'city')
  return types
}

function normalizeStandoutTags(destination: Destination): NormalizedStandout[] {
  const tags: NormalizedStandout[] = []
  const values = destination.standoutTags?.length ? destination.standoutTags : destination.standout ? [destination.standout] : []
  for (const raw of values) {
    const label = stripEmojiLabel(raw)
    if (label.includes('culinaire') || label.includes('bouffe') || label.includes('food')) addUnique(tags, 'culinary')
    if (label.includes('spot') || label.includes('paysage') || label.includes('folie')) addUnique(tags, 'scenery')
    if (label.includes('architecture') || label.includes('ruelle')) addUnique(tags, 'architecture')
    if (label.includes('rencontre') || label.includes('locaux')) addUnique(tags, 'locals')
    if (label.includes('budget') || label.includes('cher')) addUnique(tags, 'budgetPain')
    if (label.includes('transport')) addUnique(tags, 'transportPain')
    if (label.includes('touriste') || label.includes('piege')) addUnique(tags, 'touristTrap')
    if (label.includes('rythme') || label.includes('fatig')) addUnique(tags, 'exhausting')
    if (label.includes('meteo')) addUnique(tags, 'weather')
  }
  return tags
}

function regionTagsFor(destination: Destination): DestinationRegionTag[] {
  const country = destination.country
  const tags: DestinationRegionTag[] = []
  if (['Royaume-Uni', 'Angleterre', 'Écosse', 'Ecosse', 'Irlande'].includes(country)) addUnique(tags, 'Îles britanniques')
  if (['Danemark', 'Suède', 'Suede', 'Norvège', 'Norvege', 'Finlande', 'Islande', 'Estonie', 'Lettonie', 'Lituanie'].includes(country)) addUnique(tags, 'Europe du Nord')
  if (['Espagne', 'Portugal', 'Italie', 'Grèce', 'Grece', 'Malte', 'Chypre', 'Monaco'].includes(country)) addUnique(tags, 'Méditerranée')
  if (['Croatie', 'Slovénie', 'Slovenie', 'Bosnie-Herzégovine', 'Monténégro', 'Montenegro', 'Serbie', 'Albanie', 'Bulgarie', 'Roumanie', 'Kosovo', 'Macédoine du Nord', 'Macedoine du Nord'].includes(country)) addUnique(tags, 'Balkans')
  if (['Pologne', 'Ukraine', 'Moldavie', 'Hongrie', 'Slovaquie', 'Russie', 'Biélorussie', 'Bielorussie'].includes(country)) addUnique(tags, "Europe de l'Est")
  if (['France', 'Allemagne', 'Pays-Bas', 'Belgique', 'Luxembourg', 'Suisse', 'Autriche', 'République tchèque', 'Republique tcheque', 'Tchéquie', 'Tcheque'].includes(country)) addUnique(tags, "Europe de l'Ouest")
  if (['États-Unis', 'Etats-Unis', 'Canada'].includes(country)) addUnique(tags, 'Amérique du Nord')
  if (['Mexique', 'Brésil', 'Bresil', 'Argentine', 'Chili', 'Colombie', 'Pérou', 'Perou'].includes(country)) addUnique(tags, 'Amérique latine')
  if (['Japon', 'Chine', 'Corée du Sud', 'Coree du Sud', 'Taïwan', 'Taiwan', 'Hong Kong', 'Singapour'].includes(country)) addUnique(tags, 'Asie urbaine')
  if (['Indonésie', 'Indonesie', 'Thaïlande', 'Thailande', 'Vietnam', 'Népal', 'Nepal', 'Sri Lanka'].includes(country)) addUnique(tags, 'Asie nature')
  if (['Maroc', 'Algérie', 'Algerie', 'Tunisie'].includes(country)) addUnique(tags, 'Maghreb')
  if (['Émirats arabes unis', 'Emirats arabes unis', 'Qatar', 'Israël', 'Israel', 'Jordanie', 'Turquie'].includes(country)) addUnique(tags, 'Moyen-Orient')
  if (tags.length === 0) addUnique(tags, 'Ailleurs')
  return tags
}

function vibeTagsFor(destination: Destination, tripTypes: NormalizedTripType[], standouts: NormalizedStandout[]): DestinationVibeTag[] {
  const tags: DestinationVibeTag[] = []
  const name = destination.name.toLowerCase()
  const country = destination.country
  if (destination.kind === 'zone') addUnique(tags, 'campagne')
  if (['paris', 'tokyo', 'new york', 'mexico', 'bangkok', 'dubai', 'dubaï', 'londres', 'shanghai', 'rio de janeiro'].some(city => name.includes(city))) addUnique(tags, 'grande ville')
  if (['lisbonne', 'kyoto', 'vancouver', 'barcelone', 'auckland', 'le cap'].some(city => name.includes(city))) addUnique(tags, 'ville moyenne')
  if (['paris', 'tokyo', 'lisbonne', 'bangkok', 'mexico', 'londres', 'berlin', 'madrid', 'rome'].some(city => name.includes(city))) addUnique(tags, 'capitale')
  if (['Portugal', 'Espagne', 'Italie', 'Grèce', 'Grece', 'Indonésie', 'Indonesie', 'Thaïlande', 'Thailande', 'Brésil', 'Bresil', 'Afrique du Sud'].includes(country)) addUnique(tags, 'bord de mer')
  if (['Suisse', 'Autriche', 'Népal', 'Nepal', 'Nouvelle-Zelande', 'Nouvelle-Zélande', 'Canada'].includes(country) || name.includes('alpes')) addUnique(tags, 'montagne')
  if (['Islande', 'Malte', 'Chypre'].includes(country) || ['bali', 'santorin', 'auckland'].some(place => name.includes(place))) addUnique(tags, 'île')
  if (tripTypes.includes('nature') || standouts.includes('scenery')) addUnique(tags, 'nature')
  if (tripTypes.includes('culture') || standouts.includes('architecture')) addUnique(tags, 'patrimoine')
  if (tripTypes.includes('nightlife')) addUnique(tags, 'fête')
  if (tripTypes.includes('rest')) addUnique(tags, 'repos')
  if (standouts.includes('budgetPain') || (destination.value !== undefined && destination.value <= 2)) addUnique(tags, 'cher')
  if (destination.value !== undefined && destination.value >= 4) addUnique(tags, 'accessible')
  if (standouts.includes('touristTrap')) addUnique(tags, 'touristique')
  if (standouts.includes('locals')) addUnique(tags, 'alternatif')
  return tags
}

function computeConfidence(destinationCount: number): ProfileConfidence {
  if (destinationCount <= 0) return 'empty'
  if (destinationCount <= 2) return 'low'
  if (destinationCount <= 5) return 'medium-low'
  if (destinationCount <= 10) return 'medium'
  return 'high'
}

function confidenceLimits(confidence: ProfileConfidence): { maxTags: number; maxAchievements: number } {
  if (confidence === 'empty') return { maxTags: 0, maxAchievements: 0 }
  if (confidence === 'low' || confidence === 'light') return { maxTags: 1, maxAchievements: 1 }
  if (confidence === 'medium-low' || confidence === 'mid') return { maxTags: 2, maxAchievements: 2 }
  if (confidence === 'medium') return { maxTags: 3, maxAchievements: 3 }
  return { maxTags: 3, maxAchievements: 4 }
}

function computeContinents(destinations: Destination[]): ContinentShare[] {
  const continentCountrySets: Record<ContinentBucket, Set<string>> = {
    Europe: new Set(),
    Asie: new Set(),
    Ameriques: new Set(),
    Afrique: new Set(),
    Oceanie: new Set(),
    Autre: new Set(),
  }
  for (const destination of destinations) {
    if (destination.country) continentCountrySets[continentOf(destination.country)].add(destination.country)
  }
  const totalCountries = Math.max(1, new Set(destinations.map(destination => destination.country).filter(Boolean)).size)
  return (Object.keys(continentCountrySets) as ContinentBucket[])
    .map(continent => ({ continent, count: continentCountrySets[continent].size, pct: (continentCountrySets[continent].size / totalCountries) * 100 }))
    .filter(continent => continent.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
}

export function computeProfileStats(destinations: Destination[], continents = computeContinents(destinations)): TravelerProfileStats {
  const travels = destinations.filter(destination => !destination.livedThere)
  const effectiveTravels = travels.filter(destination => !isWorkTrip(destination))
  const totalVisitOccurrences = travels.reduce((sum, destination) => sum + getVisitCount(destination), 0)
  const repeatVisitOccurrences = travels.reduce((sum, destination) => sum + Math.max(0, getVisitCount(destination) - 1), 0)
  const denominator = Math.max(1, travels.length)
  const effectiveVisitDenominator = Math.max(1, effectiveTravels.reduce((sum, destination) => sum + getVisitCount(destination), 0))
  const countryCounts = new Map<string, number>()
  const destinationVisitCounts = new Map<string, number>()
  for (const destination of effectiveTravels) {
    const visitCount = getVisitCount(destination)
    destinationVisitCounts.set(destination.name, (destinationVisitCounts.get(destination.name) ?? 0) + visitCount)
    if (destination.country) countryCounts.set(destination.country, (countryCounts.get(destination.country) ?? 0) + visitCount)
  }
  const topCountry = [...countryCounts.entries()].sort((a, b) => b[1] - a[1])[0]
  const mainCountry = topCountry?.[0] ?? null
  const mainCountryRepeat = topCountry?.[1] ?? 0
  const topRevisitedDestinationEntry = [...destinationVisitCounts.entries()].sort((a, b) => b[1] - a[1])[0]
  const topRevisitedDestinationCount = topRevisitedDestinationEntry && topRevisitedDestinationEntry[1] > 1 ? topRevisitedDestinationEntry[1] : 0
  const topRevisitedCountryCount = topCountry && topCountry[1] > 1 ? topCountry[1] : 0

  const dayValues = travels.map(destination => destination.tripDays).filter((value): value is number => typeof value === 'number' && value > 0)
  const shortTripCount = dayValues.filter(value => value <= 3).length
  const longTripCount = dayValues.filter(value => value > 10).length
  const nonWorkBudgetValues = travels
    .filter(destination => !isWorkTrip(destination))
    .map(destination => destination.personalBudget && destination.tripDays && destination.tripDays > 0 ? destination.personalBudget / destination.tripDays : null)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
  const scoreValues = travels.map(destination => destination.score ?? getDestinationScore(destination)).filter(value => Number.isFinite(value) && value > 0)
  const favoriteCount = travels.filter(destination => destination.coupDeCoeur).length

  const tripTypeCounts: Record<NormalizedTripType, number> = { culture: 0, food: 0, nature: 0, rest: 0, nightlife: 0, roadtrip: 0, work: 0, city: 0 }
  const standoutCounts: Record<NormalizedStandout, number> = {
    culinary: 0,
    scenery: 0,
    architecture: 0,
    locals: 0,
    budgetPain: 0,
    transportPain: 0,
    touristTrap: 0,
    exhausting: 0,
    weather: 0,
  }
  const regionTags: DestinationRegionTag[] = []
  const vibeTags: DestinationVibeTag[] = []
  let exhaustingSignals = 0

  for (const destination of travels) {
    const tripTypes = normalizeTripTypes(destination)
    const standouts = normalizeStandoutTags(destination)
    for (const type of tripTypes) tripTypeCounts[type] += 1
    for (const standout of standouts) standoutCounts[standout] += 1
    for (const tag of regionTagsFor(destination)) addUnique(regionTags, tag)
    for (const tag of vibeTagsFor(destination, tripTypes, standouts)) addUnique(vibeTags, tag)
    if (standouts.includes('exhausting') || (destination.stops?.length ?? 0) >= 5) exhaustingSignals += 1
  }

  const distinctTripTypes = Object.values(tripTypeCounts).filter(count => count > 0).length
  const mainTripType = (Object.entries(tripTypeCounts) as [NormalizedTripType, number][]).sort((a, b) => b[1] - a[1])[0]
  const tripIntent: ProfileTripIntent = (() => {
    if (!mainTripType || mainTripType[1] === 0 || distinctTripTypes >= 4) return 'mixed'
    if (mainTripType[0] === 'culture' || mainTripType[0] === 'city') return 'culture'
    if (mainTripType[0] === 'food') return 'food'
    if (mainTripType[0] === 'nature') return 'nature'
    if (mainTripType[0] === 'nightlife') return 'nightlife'
    if (mainTripType[0] === 'rest') return 'rest'
    if (mainTripType[0] === 'work') return 'work'
    return 'mixed'
  })()
  const tripPace: TripPace = (() => {
    const medDays = dayValues.length >= 3 ? median(dayValues) : null
    if (exhaustingSignals / denominator >= 0.25) return 'exhausting'
    if (medDays !== null && medDays <= 3) return 'dense'
    if (medDays !== null && medDays > 10) return 'slow'
    return 'balanced'
  })()
  const scoreAverage = scoreValues.length >= 3 ? average(scoreValues) : null

  // ── Géo : paire la plus éloignée du carnet (amplitude, sans domicile) ──
  const geoPoints = travels.filter(d => Number.isFinite(d.lat) && Number.isFinite(d.lng))
  let geoSpanKm = 0
  let farthestPair: { a: string; b: string; km: number } | null = null
  for (let i = 0; i < geoPoints.length; i++) {
    for (let j = i + 1; j < geoPoints.length; j++) {
      const km = distanceKm(geoPoints[i], geoPoints[j])
      if (km > geoSpanKm) {
        geoSpanKm = km
        farthestPair = { a: geoPoints[i].name, b: geoPoints[j].name, km }
      }
    }
  }

  // ── Temps : à partir de tripYear ──
  const years = travels
    .map(d => d.tripYear)
    .filter((y): y is number => typeof y === 'number' && y > 1900)
  const yearBuckets = new Map<number, number>()
  for (const y of years) yearBuckets.set(y, (yearBuckets.get(y) ?? 0) + 1)
  const peakYearEntry = [...yearBuckets.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] ?? null
  const distinctYears = [...new Set(years)].sort((a, b) => a - b)
  let longestGapYears = 0
  for (let i = 1; i < distinctYears.length; i++) {
    longestGapYears = Math.max(longestGapYears, distinctYears[i] - distinctYears[i - 1])
  }

  // ── Social : à partir de companions ──
  const companionValues = travels
    .map(d => d.companions)
    .filter((c): c is NonNullable<Destination['companions']> => Boolean(c))
  const companionBuckets = new Map<NonNullable<Destination['companions']>, number>()
  for (const c of companionValues) companionBuckets.set(c, (companionBuckets.get(c) ?? 0) + 1)
  const dominantCompanionEntry = [...companionBuckets.entries()].sort((a, b) => b[1] - a[1])[0] ?? null

  // ── Exigence : distribution réelle de la tier-list ──
  const tierOrder: Tier[] = ['S', 'A', 'B', 'C', 'D']
  const tierValues = travels.map(d => d.tier).filter((tr): tr is Tier => Boolean(tr))
  const tierBuckets: Record<Tier, number> = { S: 0, A: 0, B: 0, C: 0, D: 0 }
  for (const tr of tierValues) tierBuckets[tr] += 1

  return {
    destinationCount: destinations.length,
    travelCount: travels.length,
    totalVisitOccurrences,
    repeatVisitOccurrences,
    uniqueCountryCount: new Set(destinations.map(destination => destination.country).filter(Boolean)).size,
    mainCountry,
    mainCountryRepeat,
    mainCountryRatio: mainCountryRepeat / effectiveVisitDenominator,
    topRevisitedDestination: topRevisitedDestinationCount > 1 ? topRevisitedDestinationEntry?.[0] ?? null : null,
    topRevisitedDestinationCount,
    topRevisitedCountry: topRevisitedCountryCount > 1 ? topCountry?.[0] ?? null : null,
    topRevisitedCountryCount,
    continentCount: continents.length,
    mainContinent: continents[0]?.continent ?? null,
    mainContinentRatio: (continents[0]?.pct ?? 0) / 100,
    tripDaysMedian: dayValues.length >= 3 ? median(dayValues) : null,
    shortTripRatio: dayValues.length ? shortTripCount / dayValues.length : 0,
    longTripRatio: dayValues.length ? longTripCount / dayValues.length : 0,
    personalBudgetMedian: nonWorkBudgetValues.length >= 3 ? median(nonWorkBudgetValues) : null,
    scoreAverage,
    scoreCount: scoreValues.length,
    scoreVariance: variance(scoreValues),
    favoriteCount,
    favoriteRatio: travels.length ? favoriteCount / travels.length : 0,
    workTripRatio: travels.filter(isWorkTrip).length / denominator,
    museumTripTypeRatio: tripTypeCounts.culture / denominator,
    foodTourRatio: tripTypeCounts.food / denominator,
    natureTripTypeRatio: tripTypeCounts.nature / denominator,
    lazyModeRatio: tripTypeCounts.rest / denominator,
    nightlifeRatio: tripTypeCounts.nightlife / denominator,
    architectureStandoutRatio: standoutCounts.architecture / denominator,
    culinaryStandoutRatio: standoutCounts.culinary / denominator,
    outdoorStandoutRatio: standoutCounts.scenery / denominator,
    negativeStandoutTagsRatio: (standoutCounts.budgetPain + standoutCounts.transportPain + standoutCounts.touristTrap + standoutCounts.exhausting + standoutCounts.weather) / denominator,
    positiveStandoutTagsRatio: (standoutCounts.culinary + standoutCounts.scenery + standoutCounts.architecture + standoutCounts.locals) / denominator,
    logisticsPainRatio: (standoutCounts.transportPain + standoutCounts.exhausting + standoutCounts.weather) / denominator,
    budgetPainRatio: standoutCounts.budgetPain / denominator,
    diverseTripTypesScore: clamp100(ratioScore(distinctTripTypes / 6, 0.2, 0.7)),
    tripIntent,
    tripPace,
    regionTags,
    vibeTags,
    geoSpanKm,
    farthestPair,
    datedTripCount: years.length,
    firstTripYear: distinctYears[0] ?? null,
    lastTripYear: distinctYears[distinctYears.length - 1] ?? null,
    peakYear: peakYearEntry ? peakYearEntry[0] : null,
    peakYearCount: peakYearEntry ? peakYearEntry[1] : 0,
    longestGapYears,
    companionDataCount: companionValues.length,
    dominantCompanion: dominantCompanionEntry ? dominantCompanionEntry[0] : null,
    dominantCompanionRatio: companionValues.length ? (dominantCompanionEntry?.[1] ?? 0) / companionValues.length : 0,
    soloRatio: companionValues.length ? (companionBuckets.get('solo') ?? 0) / companionValues.length : 0,
    ratedTierCount: tierValues.length,
    sTierCount: tierBuckets.S,
    topTier: tierOrder.find(tr => tierBuckets[tr] > 0) ?? null,
  }
}

export function computeArchetypeScores(stats: TravelerProfileStats): Record<ArchetypeKey, number> {
  const highScoreAverage = stats.scoreAverage !== null && stats.scoreAverage >= 4.1 ? 55 : 0
  const lowOrMediumScore = stats.scoreAverage !== null && stats.scoreAverage < 3.7 ? ratioScore(3.7 - stats.scoreAverage, 0, 1.2) : 0
  const scoreReliability = ratioScore(stats.scoreCount, 2, 7)
  const noDominantPattern = stats.mainCountryRatio < 0.25 && stats.mainContinentRatio < 0.55 ? 45 : 0
  return {
    faithful: clamp100(countScore(stats.mainCountryRepeat, 1, 5) * 0.35 + ratioScore(stats.mainCountryRatio, 0.2, 0.45) * 0.45 + (stats.mainContinentRatio >= 0.65 ? 12 : 0) - stats.workTripRatio * 25 - (stats.continentCount >= 3 ? 15 : 0)),
    selective: clamp100(lowOrMediumScore * 0.42 + (stats.favoriteRatio <= 0.2 && stats.travelCount >= 6 ? 24 : 0) + ratioScore(stats.negativeStandoutTagsRatio, 0.15, 0.45) * 0.24 + scoreReliability * 0.12),
    thoughtful: clamp100(ratioScore(stats.museumTripTypeRatio, 0.12, 0.45) * 0.45 + ratioScore(stats.architectureStandoutRatio, 0.08, 0.30) * 0.30 + (stats.tripIntent === 'culture' ? 18 : 0) + (stats.tripDaysMedian !== null && stats.tripDaysMedian >= 5 ? 8 : 0)),
    comfort: clamp100((stats.personalBudgetMedian !== null ? ratioScore(stats.personalBudgetMedian, 90, 190) * 0.35 : 0) + ratioScore(stats.foodTourRatio + stats.lazyModeRatio, 0.18, 0.55) * 0.28 + (1 - Math.min(1, stats.logisticsPainRatio / 0.35)) * 18 + highScoreAverage * 0.18 - stats.workTripRatio * 22 - ratioScore(stats.budgetPainRatio, 0.05, 0.35) * 0.25),
    nomad: clamp100(ratioScore(stats.shortTripRatio, 0.25, 0.65) * 0.42 + countScore(stats.destinationCount, 5, 14) * 0.22 + (stats.tripDaysMedian !== null && stats.tripDaysMedian <= 3 ? 24 : 0) + (stats.mainContinent === 'Europe' && stats.mainContinentRatio >= 0.55 ? 12 : 0) - ratioScore(stats.longTripRatio, 0.15, 0.45) * 0.35),
    nature: clamp100(ratioScore(stats.natureTripTypeRatio, 0.12, 0.45) * 0.48 + ratioScore(stats.outdoorStandoutRatio, 0.08, 0.30) * 0.30 + (stats.vibeTags.includes('nature') || stats.vibeTags.includes('montagne') || stats.vibeTags.includes('île') ? 15 : 0) + (stats.continentCount >= 2 ? 8 : 0)),
    epicurean: clamp100(ratioScore(stats.foodTourRatio, 0.12, 0.45) * 0.52 + ratioScore(stats.culinaryStandoutRatio, 0.08, 0.30) * 0.34 + (stats.personalBudgetMedian !== null && stats.personalBudgetMedian >= 110 ? 8 : 0) + (stats.tripIntent === 'food' ? 12 : 0)),
    open: clamp100(countScore(stats.continentCount, 1, 4) * 0.32 + noDominantPattern + stats.diverseTripTypesScore * 0.28 + (stats.regionTags.length >= 4 ? 12 : 0)),
  }
}

function blankUsedSignals(): Record<UsedSignal, boolean> {
  return {
    countryRepeat: false,
    continentDominance: false,
    lowScores: false,
    highScores: false,
    lowFavorites: false,
    highFavorites: false,
    budgetHigh: false,
    budgetLow: false,
    shortTrips: false,
    foodPattern: false,
    culturePattern: false,
    naturePattern: false,
    negativeTags: false,
    diversity: false,
    workPattern: false,
  }
}

function titleForKey(key: ArchetypeKey, confidence: ProfileConfidence): string {
  const soft = confidence === 'medium-low'
  // Registre « sobre & affirmé » : article défini + nom, court et intemporel.
  const titles: Record<ArchetypeKey, [string, string]> = {
    faithful: ['Le Familier', 'Le Fidèle'],
    selective: ['Le Sélectif', 'Le Sélectif'],
    thoughtful: ['Le Curieux', 'Le Curieux'],
    comfort: ['Le Tranquille', 'Le Tranquille'],
    nomad: ['Le Nomade', 'Le Nomade'],
    nature: ['Le Sauvage', 'Le Sauvage'],
    epicurean: ["L'Épicurien", "L'Épicurien"],
    open: ["L'Explorateur", "L'Explorateur"],
  }
  return soft ? titles[key][0] : titles[key][1]
}

function selectProfileTitle(scores: Record<ArchetypeKey, number>, confidence: ProfileConfidence, stats: TravelerProfileStats): { title: string; key: ArchetypeKey | null } {
  if (confidence === 'empty' || confidence === 'low') return { title: 'Profil en rodage', key: null }
  const sorted = (Object.entries(scores) as [ArchetypeKey, number][]).sort((a, b) => b[1] - a[1])
  const [topKey, topScore] = sorted[0]
  const secondScore = sorted[1]?.[1] ?? 0
  if (
    scores.selective >= 45
    && stats.scoreCount >= 4
    && stats.scoreAverage !== null
    && stats.scoreAverage < 3.7
    && stats.negativeStandoutTagsRatio >= 0.35
  ) {
    return { title: titleForKey('selective', confidence), key: 'selective' }
  }
  if (topScore < 35 || topScore - secondScore < 12) return { title: titleForKey('open', confidence), key: 'open' }
  if (topKey === 'selective' && (stats.scoreCount < 4 || stats.destinationCount < 6) && stats.negativeStandoutTagsRatio < 0.35) return { title: titleForKey('open', confidence), key: 'open' }
  return { title: titleForKey(topKey, confidence), key: topKey }
}

function markSignalsUsedByTitle(key: ArchetypeKey | null, usedSignals: Record<UsedSignal, boolean>) {
  if (key === 'faithful') usedSignals.countryRepeat = true
  if (key === 'selective') {
    usedSignals.lowScores = true
    usedSignals.lowFavorites = true
    usedSignals.negativeTags = true
  }
  if (key === 'thoughtful') usedSignals.culturePattern = true
  if (key === 'comfort') usedSignals.budgetHigh = true
  if (key === 'nomad') usedSignals.shortTrips = true
  if (key === 'nature') usedSignals.naturePattern = true
  if (key === 'epicurean') usedSignals.foodPattern = true
  if (key === 'open') usedSignals.diversity = true
}

function selectSubtitle(titleKey: ArchetypeKey | null, stats: TravelerProfileStats, usedSignals: Record<UsedSignal, boolean>, confidence: ProfileConfidence): string | null {
  if (confidence === 'empty') return null
  if (confidence === 'low') return 'Le carnet commence à parler — pas encore à trancher.'
  switch (titleKey) {
    case 'faithful':
      usedSignals.countryRepeat = true
      if (stats.topRevisitedDestination && stats.topRevisitedDestinationCount >= 3) {
        return `Tu reviens — ${stats.topRevisitedDestination} plus que partout ailleurs.`
      }
      return stats.mainCountry && stats.mainCountryRepeat >= 3 ? `Tu reviens, et toujours vers ${stats.mainCountry}.` : 'Tu as tes repères, et tu les assumes.'
    case 'selective':
      if (stats.negativeStandoutTagsRatio >= 0.35) {
        usedSignals.negativeTags = true
        return "Tu aimes voyager, mais rien ne t'échappe."
      }
      if (stats.favoriteRatio <= 0.2) {
        usedSignals.lowFavorites = true
        return 'Tu aimes, mais tu ne distribues pas les étoiles.'
      }
      usedSignals.lowScores = true
      return 'Un endroit peut te plaire sans décrocher la note.'
    case 'thoughtful':
      usedSignals.culturePattern = true
      return stats.architectureStandoutRatio >= 0.25 ? 'Tu lis les façades avant les guides.' : 'Tu cherches le contexte, pas la carte postale.'
    case 'comfort':
      usedSignals.budgetHigh = true
      return stats.personalBudgetMedian !== null && stats.personalBudgetMedian >= 150 ? 'Pas le luxe — juste les bons choix, sans te priver.' : "Tu sais voyager simple, mais tu préfères quand c'est confortable."
    case 'nomad':
      usedSignals.shortTrips = true
      if (stats.mainContinent === 'Europe' && stats.mainContinentRatio >= 0.55) {
        usedSignals.continentDominance = true
        return "Tu fais de l'Europe un terrain de week-ends."
      }
      return 'Tu ne pars pas longtemps, mais tu pars souvent.'
    case 'nature':
      usedSignals.naturePattern = true
      return stats.vibeTags.includes('montagne') || stats.vibeTags.includes('nature') ? 'Tu vises là où la carte devient verte.' : "Tu cherches l'air libre, même quand ce n'était pas prévu."
    case 'epicurean':
      usedSignals.foodPattern = true
      return stats.culinaryStandoutRatio >= 0.25 ? "Pour toi, la culture passe d'abord par l'assiette." : '« Spontané », dis-tu — avec trois adresses déjà repérées.'
    case 'open':
      usedSignals.diversity = true
      return stats.continentCount >= 3 ? 'Aucun continent ne te retient longtemps.' : 'Tu refuses de choisir un camp.'
    default:
      return 'Le carnet a encore besoin de sortir un peu.'
  }
}

// Pastilles = faits chiffrés (pas une 2ᵉ couche d'étiquettes redondante avec l'archétype).
function buildBehaviorTags(_scores: Record<ArchetypeKey, number>, stats: TravelerProfileStats, _titleKey: ArchetypeKey | null, _usedSignals: Record<UsedSignal, boolean>, max: number): TravelerBehaviorTag[] {
  if (stats.destinationCount <= 2) {
    return stats.destinationCount > 0 && max > 0 ? [{ key: 'living', label: 'Carnet vivant' }] : []
  }
  const tags: TravelerBehaviorTag[] = []
  const add = (key: string, label: string, condition: boolean) => {
    if (condition && tags.length < max && !tags.some(tag => tag.key === key)) tags.push({ key, label })
  }
  const yearSpan = stats.firstTripYear !== null && stats.lastTripYear !== null ? stats.lastTripYear - stats.firstTripYear : 0
  add('countries', `${stats.uniqueCountryCount} pays`, stats.uniqueCountryCount >= 2)
  if (stats.companionDataCount >= 4 && stats.soloRatio >= 0.5) {
    add('solo', `${Math.round(stats.soloRatio * 100)}% solo`, true)
  } else if (stats.companionDataCount >= 4 && stats.dominantCompanion && stats.dominantCompanion !== 'travail' && stats.dominantCompanionRatio >= 0.5) {
    add('companion', `${Math.round(stats.dominantCompanionRatio * 100)}% ${COMPANION_LABEL[stats.dominantCompanion]}`, true)
  }
  add('since', `depuis ${stats.firstTripYear}`, stats.firstTripYear !== null && stats.datedTripCount >= 3 && yearSpan >= 1)
  add('count', `${stats.destinationCount} destinations`, true)
  if (tags.length === 0 && max > 0) tags.push({ key: 'living', label: 'Carnet vivant' })
  return tags.slice(0, max)
}

function continentLabel(continent: ContinentBucket | null): string {
  const labels: Record<ContinentBucket, string> = {
    Europe: 'européenne',
    Asie: 'asiatique',
    Ameriques: 'américaine',
    Afrique: 'africaine',
    Oceanie: 'océanienne',
    Autre: 'ailleurs',
  }
  return continent ? labels[continent] : 'du carnet'
}

const COMPANION_LABEL: Record<NonNullable<Destination['companions']>, string> = {
  solo: 'en solo',
  couple: 'en couple',
  amis: 'entre amis',
  famille: 'en famille',
  travail: 'pour le travail',
}

function formatKm(km: number): string {
  return `${Math.round(km).toLocaleString('fr-FR')} km`
}

interface AchievementCandidate {
  achievement: TravelerAchievement
  condition: boolean
  blocked: boolean
  /** 0-100 : à quel point ce succès est *extrême pour cet utilisateur*. Tri décroissant. */
  intensity: number
}

function buildAchievements(stats: TravelerProfileStats, titleKey: ArchetypeKey | null, usedSignals: Record<UsedSignal, boolean>, max: number): TravelerAchievement[] {
  if (stats.destinationCount <= 2) return []
  const candidates: AchievementCandidate[] = []
  const add = (achievement: TravelerAchievement, condition: boolean, intensity: number, blocked = false) => {
    candidates.push({ achievement, condition, blocked, intensity })
  }

  // ── Faits chiffrés à fort « ah tiens » (axes indépendants) ──
  add(
    { key: 'geo-span', icon: '🌍', title: 'Grand écart', detail: stats.farthestPair ? `${stats.farthestPair.a} ↔ ${stats.farthestPair.b} · ${formatKm(stats.farthestPair.km)}` : formatKm(stats.geoSpanKm), tone: 'teal' },
    stats.geoSpanKm >= 4000,
    ratioScore(stats.geoSpanKm, 3000, 16000),
  )
  add(
    { key: 'peak-year', icon: '🗓️', title: 'Année reine', detail: stats.peakYear ? `${stats.peakYear} · ${stats.peakYearCount} destinations` : '', tone: 'blue' },
    stats.peakYear !== null && stats.peakYearCount >= 3 && stats.datedTripCount >= 4,
    countScore(stats.peakYearCount, 2, 8),
  )
  add(
    { key: 'comeback', icon: '⏳', title: 'Le grand retour', detail: `${stats.longestGapYears} ans sans repartir`, tone: 'gold' },
    stats.longestGapYears >= 2 && stats.datedTripCount >= 4,
    countScore(stats.longestGapYears, 1, 6),
  )
  add(
    { key: 'solo-rider', icon: '🎒', title: 'Cavalier seul', detail: `${Math.round(stats.soloRatio * 100)}% en solo`, tone: 'blue' },
    stats.soloRatio >= 0.5 && stats.companionDataCount >= 4,
    ratioScore(stats.soloRatio, 0.4, 1),
  )
  add(
    { key: 'companion-signature', icon: '👥', title: 'Toujours bien accompagné', detail: stats.dominantCompanion ? `${Math.round(stats.dominantCompanionRatio * 100)}% ${COMPANION_LABEL[stats.dominantCompanion]}` : '', tone: 'heart' },
    stats.dominantCompanion !== null && stats.dominantCompanion !== 'solo' && stats.dominantCompanion !== 'travail' && stats.dominantCompanionRatio >= 0.5 && stats.companionDataCount >= 4,
    ratioScore(stats.dominantCompanionRatio, 0.4, 1),
  )
  add(
    { key: 'summit-rare', icon: '👑', title: 'Le sommet se mérite', detail: `${stats.sTierCount} S sur ${stats.ratedTierCount}`, tone: 'gold' },
    stats.ratedTierCount >= 6 && stats.sTierCount >= 1 && stats.sTierCount / stats.ratedTierCount <= 0.2,
    ratioScore(1 - stats.sTierCount / Math.max(1, stats.ratedTierCount), 0.75, 0.97),
  )

  // ── Faits chiffrés existants ──
  add({ key: 'return-ticket', icon: '🔥', title: 'Retour assumé', detail: stats.topRevisitedDestination ? `${stats.topRevisitedDestination} · ${formatVisitCountLabel(stats.topRevisitedDestinationCount)}` : `${formatVisitCountLabel(stats.repeatVisitOccurrences + 1)}`, tone: 'red' }, Boolean(stats.topRevisitedDestination && stats.topRevisitedDestinationCount >= 3), countScore(stats.topRevisitedDestinationCount, 2, 8))
  add({ key: 'note-merit', icon: '☆', title: 'La note se mérite', detail: `${stats.scoreAverage?.toFixed(1) ?? '-'} / 5 en moyenne`, tone: 'gold' }, stats.scoreCount >= 4 && stats.scoreAverage !== null && stats.scoreAverage < 3.5, ratioScore(3.5 - (stats.scoreAverage ?? 3.5), 0, 1.3), titleKey === 'selective' || usedSignals.lowScores)
  add({ key: 'good-public', icon: '★', title: 'Bon public, mais pas naïf', detail: `${stats.scoreAverage?.toFixed(1) ?? '-'} / 5 en moyenne`, tone: 'gold' }, stats.scoreCount >= 4 && stats.scoreAverage !== null && stats.scoreAverage >= 4.1, ratioScore((stats.scoreAverage ?? 4.1) - 4.1, 0, 0.9), usedSignals.highScores)
  add({ key: 'heart-rare', icon: '♡', title: 'Cœur rare', detail: `${stats.favoriteCount}/${stats.travelCount} coups de cœur`, tone: 'heart' }, stats.favoriteCount > 0 && ((stats.favoriteCount === 1 && stats.destinationCount >= 6) || (stats.favoriteRatio <= 0.15 && stats.destinationCount >= 8)), ratioScore(1 - stats.favoriteRatio, 0.8, 0.97), titleKey === 'selective' || usedSignals.lowFavorites)
  add({ key: 'heart-easy', icon: '♥', title: 'Cœur facile', detail: `${Math.round(stats.favoriteRatio * 100)}% du carnet`, tone: 'heart' }, stats.favoriteRatio >= 0.45 && stats.destinationCount >= 6, ratioScore(stats.favoriteRatio, 0.4, 0.8), usedSignals.highFavorites)
  add({ key: 'terrain', icon: '📍', title: 'Terrain connu', detail: stats.mainCountry ? `${stats.mainCountry} · ${formatVisitCountLabel(stats.mainCountryRepeat)}` : 'Même boussole', tone: 'red' }, stats.mainCountryRepeat >= 3, countScore(stats.mainCountryRepeat, 3, 10), titleKey === 'faithful' || usedSignals.countryRepeat)
  add({ key: 'continent-compass', icon: '🧭', title: `Boussole ${continentLabel(stats.mainContinent)}`, detail: `${Math.round(stats.mainContinentRatio * 100)}% des pays`, tone: 'teal' }, stats.mainContinentRatio >= 0.65 && stats.uniqueCountryCount >= 4, ratioScore(stats.mainContinentRatio, 0.6, 0.95), usedSignals.continentDominance)
  add({ key: 'soft-addition', icon: '€', title: 'Addition souple', detail: `~${Math.round(stats.personalBudgetMedian ?? 0)} € / jour`, tone: 'gold' }, stats.personalBudgetMedian !== null && stats.personalBudgetMedian >= 150 && stats.workTripRatio < 0.4, ratioScore(stats.personalBudgetMedian ?? 0, 120, 300), titleKey === 'comfort' || usedSignals.budgetHigh)
  add({ key: 'budget-control', icon: '€', title: 'Budget sous contrôle', detail: `~${Math.round(stats.personalBudgetMedian ?? 0)} € / jour`, tone: 'gold' }, stats.personalBudgetMedian !== null && stats.personalBudgetMedian < 100 && stats.destinationCount >= 4, ratioScore(100 - (stats.personalBudgetMedian ?? 100), 0, 60), usedSignals.budgetLow)
  add({ key: 'weekend-profit', icon: '↗', title: 'Week-end rentable', detail: `${Math.round(stats.shortTripRatio * 100)}% de formats courts`, tone: 'blue' }, stats.shortTripRatio >= 0.55 && stats.destinationCount >= 5, ratioScore(stats.shortTripRatio, 0.5, 0.95), titleKey === 'nomad' || usedSignals.shortTrips)
  add({ key: 'wide-gap', icon: '🌍', title: 'Tour du monde en cours', detail: `${stats.continentCount} continents au carnet`, tone: 'teal' }, stats.continentCount >= 3, countScore(stats.continentCount, 2, 5), titleKey === 'open' || usedSignals.diversity)
  add({ key: 'seasoned-book', icon: '📘', title: 'Carnet aguerri', detail: `${stats.destinationCount} destinations`, tone: 'blue' }, stats.destinationCount >= 12, countScore(stats.destinationCount, 12, 40))

  // ── Faits orientés goût : chiffrés mais moins « surprenants » → plafonnés ──
  add({ key: 'culture-sling', icon: '🏛️', title: 'Culture en bandoulière', detail: `${Math.round(stats.museumTripTypeRatio * 100)}% orientés culture`, tone: 'blue' }, stats.museumTripTypeRatio >= 0.35 || stats.architectureStandoutRatio >= 0.25, Math.min(45, ratioScore(stats.museumTripTypeRatio, 0.3, 0.8)), titleKey === 'thoughtful' || usedSignals.culturePattern)
  add({ key: 'plate-priority', icon: '🍽️', title: 'Assiette prioritaire', detail: `${Math.round(stats.foodTourRatio * 100)}% orientés food`, tone: 'gold' }, stats.foodTourRatio >= 0.35 || stats.culinaryStandoutRatio >= 0.25, Math.min(45, ratioScore(stats.foodTourRatio, 0.3, 0.8)), titleKey === 'epicurean' || usedSignals.foodPattern)
  add({ key: 'documented-trouble', icon: '!', title: 'Galères documentées', detail: `${Math.round(stats.negativeStandoutTagsRatio * 100)}% avec un bémol`, tone: 'red' }, stats.negativeStandoutTagsRatio >= 0.35 && stats.destinationCount >= 5, Math.min(45, ratioScore(stats.negativeStandoutTagsRatio, 0.3, 0.7)), usedSignals.negativeTags)
  add({ key: 'outside-comfort', icon: '🌿', title: 'Hors des sentiers confortables', detail: `${Math.round(stats.natureTripTypeRatio * 100)}% au grand air`, tone: 'teal' }, stats.natureTripTypeRatio >= 0.35 && stats.personalBudgetMedian !== null && stats.personalBudgetMedian < 120, Math.min(45, ratioScore(stats.natureTripTypeRatio, 0.3, 0.7)), titleKey === 'nature' || usedSignals.naturePattern)

  // Tri par intensité (le plus extrême pour CET utilisateur d'abord) → variété entre profils.
  const seen = new Set<string>()
  return candidates
    .filter(c => c.condition && !c.blocked)
    .sort((a, b) => b.intensity - a.intensity)
    .filter(c => (seen.has(c.achievement.key) ? false : (seen.add(c.achievement.key), true)))
    .slice(0, max)
    .map(c => c.achievement)
}

function buildTerritories(continents: ContinentShare[]): TravelerTerritory[] {
  return continents.slice(0, 3).map(continent => ({
    key: continent.continent,
    label: continent.continent === 'Autre' ? 'Ailleurs' : continent.continent === 'Ameriques' ? 'Amériques' : continent.continent === 'Oceanie' ? 'Océanie' : continent.continent,
    count: continent.count,
    pct: continent.pct,
  }))
}

function buildLegacySignatures(stats: TravelerProfileStats, tags: TravelerBehaviorTag[]): TravelerSignature[] {
  return tags.slice(0, 3).map(tag => {
    if (tag.key === 'faithful') return {
      key: 'geo',
      icon: '⌖',
      label: 'Revient souvent sur ses pas',
      detail: stats.topRevisitedDestination
        ? `${stats.topRevisitedDestination} · ${formatVisitCountLabel(stats.topRevisitedDestinationCount)}`
        : stats.mainCountry
          ? `${stats.mainCountry} · ${formatVisitCountLabel(stats.mainCountryRepeat)}`
          : undefined,
    }
    if (tag.key === 'comfort') return { key: 'budget', icon: '€', label: 'Le confort reste dans la conversation', detail: stats.personalBudgetMedian ? `~${Math.round(stats.personalBudgetMedian)} €/j` : undefined }
    if (tag.key === 'nomad' || tag.key === 'weekend') return { key: 'format', icon: '↗', label: 'Passe vite, juge quand même', detail: stats.tripDaysMedian ? `~${Math.round(stats.tripDaysMedian)} j` : undefined }
    if (tag.key === 'selective' || tag.key === 'demanding') return { key: 'notes', icon: '☆', label: 'Ne valide pas pour faire plaisir', detail: stats.scoreAverage ? `moy. ${stats.scoreAverage.toFixed(1)}/5` : undefined }
    if (tag.key === 'food' || tag.key === 'culture' || tag.key === 'nature') return { key: 'intent', icon: '◇', label: tag.label, detail: stats.tripIntent }
    return { key: 'coeur', icon: '♡', label: tag.label }
  })
}

export function computeTravelerProfile(destinations: Destination[]): TravelerProfile {
  const continents = computeContinents(destinations)
  const stats = computeProfileStats(destinations, continents)
  const confidence = computeConfidence(stats.destinationCount)
  const archetypeScores = computeArchetypeScores(stats)
  const selected = selectProfileTitle(archetypeScores, confidence, stats)
  const usedSignals = blankUsedSignals()
  markSignalsUsedByTitle(selected.key, usedSignals)
  const subtitle = selectSubtitle(selected.key, stats, usedSignals, confidence)
  const limits = confidenceLimits(confidence)
  const behaviorTags = buildBehaviorTags(archetypeScores, stats, selected.key, usedSignals, limits.maxTags)
  const achievements = buildAchievements(stats, selected.key, usedSignals, limits.maxAchievements)
  const territories = buildTerritories(continents)

  return {
    total: stats.destinationCount,
    travelCount: stats.travelCount,
    countries: stats.uniqueCountryCount,
    coupDeCoeurCount: stats.favoriteCount,
    confidence,
    title: selected.title,
    subtitle,
    behaviorTags,
    achievements,
    territories,
    archetype: subtitle,
    signatures: buildLegacySignatures(stats, behaviorTags),
    continents,
    debug: {
      stats,
      archetypeScores,
      usedSignals,
      derivedTags: {
        regionTags: stats.regionTags,
        vibeTags: stats.vibeTags,
        tripPace: stats.tripPace,
        tripIntent: stats.tripIntent,
      },
    },
  }
}
