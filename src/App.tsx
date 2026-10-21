import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Destination, Intent, MapVisibility, RoadTripStop, Tier } from './types'
import { useMyDestinations } from './hooks/useMyDestinations'
import { useFocusTrap } from './hooks/useFocusTrap'
import WorldMap from './components/WorldMap'
import DestinationSheet from './components/DestinationSheet'
import BottomNav from './components/BottomNav'
import { BrandLogo } from './components/BrandLogo'
import { Icon } from './components/Icon'
import { HeroImage } from './components/HeroImage'
import Nav from './components/Nav'
import TierListPanel from './components/TierListPanel'
import type { SaveOptions } from './components/AddDestinationWizard'
import DuplicateFoundModal from './components/DuplicateFoundModal'
import { findDuplicate } from './utils/duplicates'
import { destinationNameKey, destinationNameSet } from './utils/destinationIdentity'
import { formatVisitCountLabel, getDestinationScore, getDestinationTier, getMaxCoupDeCoeur, getVisitCount, withRecalculatedScore } from './utils'
import { TravelerProfileCard, TravelerProfileStrip } from './components/TravelerProfileCard'
import ProfileSetupModal from './components/friends/ProfileSetupModal'
import FriendToast from './components/friends/FriendToast'
import { Avatar } from './components/Avatar'
import { SegmentedControl } from './components/SegmentedControl'
import { getExperienceTagLabel, normalizeStoredTripTypes } from './lib/experienceTags'

// Routes / panels lourds chargés à la demande pour réduire le bundle initial.
// Le fallback est `null` parce que ces écrans apparaissent en réponse à un clic
// utilisateur — un spinner brièvement visible ferait plus de bruit qu'autre chose.
const TierListPage = lazy(() => import('./components/TierListPage'))
const AddDestinationWizard = lazy(() => import('./components/AddDestinationWizard'))
const AddFriendModal = lazy(() => import('./components/friends/AddFriendModal'))
const FriendsManagePanel = lazy(() => import('./components/friends/FriendsManagePanel'))
import { AuthProvider, useAuth } from './lib/auth'
import { supabase } from './lib/supabase'
import { FriendsProvider, useFriends } from './hooks/useFriends'
import { useFriendDestinations } from './hooks/useFriendDestinations'
import { useMyProfile } from './hooks/useMyProfile'
import {
  FAKE_FRIENDS_MODE,
  FAKE_FRIENDSHIPS,
  findFakeFriendByHandle,
  getFakeFriendDestinations,
  getFakeMyDestinations,
} from './hooks/_fakeFriends'
import { useMediaQuery } from './hooks/useMediaQuery'
import { t, lang, setLang } from './i18n'

const PUBLIC_ID_KEY = 'outpost-public-id'
type View = 'map' | 'tier-list' | 'explore' | 'friends'
export type DestinationFilters = {
  coupDeCoeur: boolean
  thisYear: boolean
  livedThere: boolean
  visitedMultiple: boolean
  companions: 'all' | 'solo' | 'amis' | 'famille'
  budget: 'all' | '$' | '$$' | '$$$'
}

const VALID_TIERS: Tier[] = ['S', 'A', 'B', 'C', 'D']
const VALID_INTENTS: Intent[] = ['city-trip', 'tourisme', 'sorties', 'gastro', 'nature', 'travail']
const VALID_KINDS: NonNullable<Destination['kind']>[] = ['place', 'zone', 'stop', 'stage']
const VALID_COMPANIONS: NonNullable<Destination['companions']>[] = ['solo', 'couple', 'amis', 'famille', 'travail']
const VALID_OSM_TYPES: NonNullable<Destination['osmType']>[] = ['N', 'W', 'R', 'node', 'way', 'relation']
const DEFAULT_FILTERS: DestinationFilters = {
  coupDeCoeur: false,
  thisYear: false,
  livedThere: false,
  visitedMultiple: false,
  companions: 'all',
  budget: 'all',
}

const ACHIEVEMENT_TEST_DESTINATIONS: Destination[] = [
  {
    name: 'Florence', country: 'Italie', countryCode: 'it', lat: 43.7696, lng: 11.2558, tier: 'S',
    image: 'https://images.unsplash.com/photo-1541370976299-4d24ebbc9077?auto=format&fit=crop&w=900&q=85',
    score: 4.8, notes: 18, visitCount: 4, tripYear: 2025, tripDays: 4, companions: 'couple', personalBudget: 720,
    tripTypes: ['patrimoine', 'food', 'flanerie', 'ambiance', 'facile'],
    standoutTags: ['✨ Beau partout', '🎭 Ambiance locale', '🧘 Facile à vivre', '🏘️ Ville à flâner', '😮 Belle surprise'],
    food: 5, night: 3, culture: 5, nature: 3, value: 4, ease: 4, intent: 'tourisme', coupDeCoeur: true,
  },
  {
    name: 'Rome', country: 'Italie', countryCode: 'it', lat: 41.9028, lng: 12.4964, tier: 'S',
    image: 'https://images.unsplash.com/photo-1529260830199-42c24126f198?auto=format&fit=crop&w=900&q=85',
    score: 4.7, notes: 24, visitCount: 2, tripYear: 2024, tripDays: 5, companions: 'amis', personalBudget: 650,
    tripTypes: ['culture', 'food'], standoutTags: ['architecture'],
    food: 5, night: 4, culture: 5, nature: 2, value: 3, ease: 3, intent: 'tourisme',
  },
  {
    name: 'Milan', country: 'Italie', countryCode: 'it', lat: 45.4642, lng: 9.19, tier: 'B',
    image: 'https://images.unsplash.com/photo-1518548419970-58e3b4079ab2?auto=format&fit=crop&w=900&q=85',
    score: 3.6, notes: 9, tripYear: 2023, tripDays: 3, companions: 'travail', personalBudget: 420,
    tripTypes: ['work', 'city'], food: 3, night: 3, culture: 3, nature: 1, value: 3, ease: 4, intent: 'travail',
  },
  {
    name: 'Lisbonne', country: 'Portugal', countryCode: 'pt', lat: 38.7223, lng: -9.1393, tier: 'A',
    image: 'https://images.unsplash.com/photo-1548707309-dcebeab9ea9b?auto=format&fit=crop&w=900&q=85',
    score: 4.5, notes: 17, tripYear: 2024, tripDays: 3, companions: 'amis', personalBudget: 390,
    tripTypes: ['city', 'food'], standoutTags: ['locals'],
    food: 5, night: 4, culture: 4, nature: 3, value: 5, ease: 5, intent: 'city-trip',
  },
  {
    name: 'Reykjavik', country: 'Islande', countryCode: 'is', lat: 64.1466, lng: -21.9426, tier: 'A',
    image: 'https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=900&q=85',
    score: 4.4, notes: 12, tripYear: 2024, tripDays: 6, companions: 'solo', personalBudget: 1140,
    tripTypes: ['nature', 'roadtrip'], standoutTags: ['scenery'],
    food: 3, night: 2, culture: 3, nature: 5, value: 2, ease: 3, intent: 'nature',
  },
  {
    name: 'Kyoto', country: 'Japon', countryCode: 'jp', lat: 35.0116, lng: 135.7681, tier: 'S',
    image: 'https://images.unsplash.com/photo-1528360983277-13d401cdc186?auto=format&fit=crop&w=900&q=85',
    score: 4.9, notes: 31, tripYear: 2025, tripDays: 7, companions: 'couple', personalBudget: 980,
    tripTypes: ['culture', 'food'], standoutTags: ['architecture', 'culinary'],
    food: 5, night: 3, culture: 5, nature: 5, value: 4, ease: 4, intent: 'tourisme',
  },
  {
    name: 'Bangkok', country: 'Thailande', countryCode: 'th', lat: 13.7563, lng: 100.5018, tier: 'A',
    image: 'https://images.unsplash.com/photo-1508009603885-50cf7c579365?auto=format&fit=crop&w=900&q=85',
    score: 4.2, notes: 20, tripYear: 2023, tripDays: 5, companions: 'amis', personalBudget: 300,
    tripTypes: ['food', 'nightlife'], standoutTags: ['culinary'],
    food: 5, night: 5, culture: 4, nature: 2, value: 5, ease: 4, intent: 'gastro',
  },
  {
    name: 'Seoul', country: 'Coree du Sud', countryCode: 'kr', lat: 37.5665, lng: 126.978, tier: 'A',
    image: 'https://images.unsplash.com/photo-1538485399081-7a06146d59f2?auto=format&fit=crop&w=900&q=85',
    score: 4.6, notes: 16, tripYear: 2022, tripDays: 6, companions: 'amis', personalBudget: 760,
    tripTypes: ['city', 'food'], food: 5, night: 5, culture: 4, nature: 3, value: 4, ease: 5, intent: 'sorties',
  },
  {
    name: 'New York', country: 'Etats-Unis', countryCode: 'us', lat: 40.7128, lng: -74.006, tier: 'A',
    image: 'https://images.unsplash.com/photo-1499092346589-b9b6be3e94b2?auto=format&fit=crop&w=900&q=85',
    score: 4.3, notes: 26, tripYear: 2024, tripDays: 4, companions: 'amis', personalBudget: 960,
    tripTypes: ['city', 'culture'], standoutTags: ['architecture'],
    food: 5, night: 5, culture: 5, nature: 2, value: 2, ease: 4, intent: 'sorties',
  },
  {
    name: 'Mexico', country: 'Mexique', countryCode: 'mx', lat: 19.4326, lng: -99.1332, tier: 'B',
    image: 'https://images.unsplash.com/photo-1518105779142-d975f22f1b0a?auto=format&fit=crop&w=900&q=85',
    score: 4.0, notes: 13, tripYear: 2023, tripDays: 5, companions: 'solo', personalBudget: 420,
    tripTypes: ['culture', 'food'], standoutTags: ['culinary'],
    food: 5, night: 4, culture: 5, nature: 2, value: 5, ease: 3, intent: 'tourisme',
  },
  {
    name: 'Marrakech', country: 'Maroc', countryCode: 'ma', lat: 31.6295, lng: -7.9811, tier: 'A',
    image: 'https://images.unsplash.com/photo-1597212618440-3f0a8da57c00?auto=format&fit=crop&w=900&q=85',
    score: 4.1, notes: 15, tripYear: 2022, tripDays: 4, companions: 'famille', personalBudget: 360,
    tripTypes: ['culture', 'food'],
    food: 5, night: 3, culture: 4, nature: 2, value: 5, ease: 3, intent: 'gastro',
  },
  {
    name: 'Cape Town', country: 'Afrique du Sud', countryCode: 'za', lat: -33.9249, lng: 18.4241, tier: 'A',
    image: 'https://images.unsplash.com/photo-1580060839134-75a5edca2e99?auto=format&fit=crop&w=900&q=85',
    score: 4.4, notes: 14, tripYear: 2021, tripDays: 8, companions: 'couple', personalBudget: 680,
    tripTypes: ['nature', 'city'], standoutTags: ['scenery'],
    food: 4, night: 4, culture: 4, nature: 5, value: 4, ease: 3, intent: 'nature',
  },
]

function isLocalTestHost() {
  return ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)
}

function getAvatarFallbackLabel(...labels: Array<string | null | undefined>) {
  for (const label of labels) {
    const normalized = label?.trim()
    if (normalized) return normalized
  }
  return '·'
}

type DesktopLegendMode = 'stacked-left' | 'bottom-left' | 'overlay-bottom'
type DesktopTierMode = 'stacked-left' | 'bottom-left' | 'overlay-bottom'
type DesktopControlsMode = 'bottom-left' | 'overlay-bottom'
type ActiveSheetCompare = {
  mode: 'targeted' | 'global'
  friend: import('./types').Friendship
  mine?: Destination | null
  theirs: Destination
}

type DesktopDockState = {
  controlsBottom: number
  controlsLeft: number
  controlsMode: DesktopControlsMode
  leftDockWidth: number
  leftDockX: number
  legendBottom: number
  legendHeight: number
  legendMode: DesktopLegendMode
  legendStackTop: number
  sharedProfileHeight: number
  sharedProfileTop: number
  sidebarBottom: number
  stackBottom: number
  stackGap: number
  stackTop: number
  tierHeight: number
  tierMode: DesktopTierMode
  tierPanelWidth: number
  tierStackTop: number
}

const DESKTOP_DOCK_DEFAULT: DesktopDockState = {
  controlsBottom: 0,
  controlsLeft: 0,
  controlsMode: 'overlay-bottom',
  leftDockWidth: 0,
  leftDockX: 16,
  legendBottom: 0,
  legendHeight: 0,
  legendMode: 'overlay-bottom',
  legendStackTop: 0,
  sharedProfileHeight: 0,
  sharedProfileTop: 0,
  sidebarBottom: 0,
  stackBottom: 0,
  stackGap: 24,
  stackTop: 0,
  tierHeight: 72,
  tierMode: 'overlay-bottom',
  tierPanelWidth: 0,
  tierStackTop: 0,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function finiteNumber(value: unknown, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function normalizePositiveInteger(value: unknown, fallback = 1) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 1 ? number : fallback
}

function normalizeStops(value: unknown): RoadTripStop[] | undefined {
  if (!Array.isArray(value)) return undefined
  const stops = value
    .filter(isRecord)
    .map(stop => ({
      name: typeof stop.name === 'string' ? stop.name.trim() : '',
      lat: finiteNumber(stop.lat, NaN),
      lng: finiteNumber(stop.lng, NaN),
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

function normalizeDestination(value: unknown): Destination | null {
  if (!isRecord(value)) return null
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const lat = finiteNumber(value.lat, NaN)
  const lng = finiteNumber(value.lng, NaN)
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null

  const country = typeof value.country === 'string' && value.country.trim()
    ? value.country.trim()
    : 'Inconnu'
  const tier = VALID_TIERS.includes(value.tier as Tier) ? value.tier as Tier : undefined
  const kind = VALID_KINDS.includes(value.kind as NonNullable<Destination['kind']>)
    ? value.kind as Destination['kind']
    : 'place'
  const intent = VALID_INTENTS.includes(value.intent as Intent) ? value.intent as Intent : 'tourisme'
  const extent = Array.isArray(value.extent) && value.extent.length === 4
    ? value.extent.map(coord => finiteNumber(coord, NaN)) as [number, number, number, number]
    : undefined

  // Construction explicite : on ne fait PAS de spread du record d'entrée pour
  // éviter de propager des champs inconnus (sécurité de typage + invariants types).
  return {
    destinationKey: typeof value.destinationKey === 'string' ? value.destinationKey : undefined,
    name,
    country,
    lat,
    lng,
    tier,
    kind,
    intent,
    food: value.food === undefined || value.food === null ? undefined : finiteNumber(value.food, undefined),
    night: value.night === undefined || value.night === null ? undefined : finiteNumber(value.night, undefined),
    culture: value.culture === undefined || value.culture === null ? undefined : finiteNumber(value.culture, undefined),
    nature: value.nature === undefined || value.nature === null ? undefined : finiteNumber(value.nature, undefined),
    value: value.value === undefined || value.value === null ? undefined : finiteNumber(value.value, undefined),
    ease: value.ease === undefined || value.ease === null ? undefined : finiteNumber(value.ease, undefined),
    memorability: value.memorability === undefined || value.memorability === null ? undefined : finiteNumber(value.memorability, undefined),
    vibeBoost: value.vibeBoost === undefined || value.vibeBoost === null ? undefined : finiteNumber(value.vibeBoost, undefined),
    retourBonus: value.retourBonus === undefined || value.retourBonus === null ? undefined : finiteNumber(value.retourBonus, undefined),
    returnIntent: value.returnIntent === 'tomorrow' || value.returnIntent === 'someday' || value.returnIntent === 'once' ? value.returnIntent : undefined,
    memoryNote: typeof value.memoryNote === 'string' && value.memoryNote.trim() ? value.memoryNote.trim().slice(0, 80) : undefined,
    tierAdjust: value.tierAdjust === undefined || value.tierAdjust === null ? undefined : finiteNumber(value.tierAdjust, undefined),
    score: value.score === undefined ? undefined : finiteNumber(value.score, 3),
    notes: value.notes === undefined ? undefined : finiteNumber(value.notes, 1),
    stops: normalizeStops(value.stops),
    extent: extent?.every(Number.isFinite) ? extent : undefined,
    geojson: isRecord(value.geojson) && typeof (value.geojson as { type?: unknown }).type === 'string'
      ? (value.geojson as unknown as GeoJSON.Geometry)
      : undefined,
    state: typeof value.state === 'string' ? value.state : undefined,
    osmValue: typeof value.osmValue === 'string' ? value.osmValue : undefined,
    osmId: value.osmId === undefined ? undefined : finiteNumber(value.osmId, undefined),
    osmType: VALID_OSM_TYPES.includes(value.osmType as NonNullable<Destination['osmType']>)
      ? value.osmType as Destination['osmType']
      : undefined,
    countryCode: typeof value.countryCode === 'string' ? value.countryCode : undefined,
    image: typeof value.image === 'string' ? value.image : undefined,
    imageProvider: ['unsplash', 'pexels', 'wikivoyage', 'wikipedia', 'wikimedia', 'fallback'].includes(value.imageProvider as string)
      ? value.imageProvider as Destination['imageProvider']
      : undefined,
    imageAuthor: typeof value.imageAuthor === 'string' ? value.imageAuthor : undefined,
    imageSourceUrl: typeof value.imageSourceUrl === 'string' ? value.imageSourceUrl : undefined,
    imageQuery: typeof value.imageQuery === 'string' ? value.imageQuery : undefined,
    imageSearchVersion: value.imageSearchVersion === undefined ? undefined : finiteNumber(value.imageSearchVersion, 0),
    summary: typeof value.summary === 'string' ? value.summary : undefined,
    tripName: typeof value.tripName === 'string' ? value.tripName : undefined,
    visitCount: normalizePositiveInteger(value.visitCount, 1),
    tripYear: value.tripYear === undefined ? undefined : finiteNumber(value.tripYear, undefined),
    tripDays: value.tripDays === undefined ? undefined : finiteNumber(value.tripDays, undefined),
    companions: VALID_COMPANIONS.includes(value.companions as NonNullable<Destination['companions']>)
      ? value.companions as Destination['companions']
      : undefined,
    personalBudget: value.personalBudget === undefined ? undefined : finiteNumber(value.personalBudget, undefined),
    tripTypes: normalizeStoredTripTypes(normalizeStringList(value.tripTypes)),
    standout: typeof value.standout === 'string' ? value.standout : undefined,
    standoutTags: normalizeStringList(value.standoutTags),
    coupDeCoeur: typeof value.coupDeCoeur === 'boolean' ? value.coupDeCoeur : undefined,
  }
}

function normalizeDestinations(value: unknown): Destination[] | null {
  if (!Array.isArray(value)) return null
  const normalized = value.map(normalizeDestination).filter((item): item is Destination => item !== null)
  return normalized.length ? normalized : null
}

function loadPublicId(): string {
  try {
    return localStorage.getItem(PUBLIC_ID_KEY) ?? ''
  } catch {
    return ''
  }
}

function getMapPrivacyMessage(reason: 'private' | 'friends_only' | null, handle?: string | null) {
  const owner = handle ? `@${handle}` : 'This map'
  if (reason === 'friends_only') {
    return {
      title: `${owner} is only visible to friends.`,
      body: 'Add this person as a friend to see their map, or go back to your journal.',
    }
  }
  return {
    title: 'This map is private.',
    body: 'Only the owner can view it for now.',
  }
}

export default function App() {
  return (
    <AuthProvider>
      <FriendsProvider>
        <AppInner />
      </FriendsProvider>
    </AuthProvider>
  )
}

function AppInner() {
  const { user } = useAuth()
  const { incoming, refresh: refreshFriends } = useFriends()
  const { profile, needsSetup, upsert: upsertProfile, updateMapVisibility, checkHandleAvailable } = useMyProfile()
  const pendingFriendCount = incoming.length
  const [friendToast, setFriendToast] = useState<string | null>(null)

  // Consommer un éventuel ?invite=<token> dès qu'on est connecté.
  // Le RPC retourne le user_id de l'inviteur ; on récupère son profil pour
  // afficher un toast "Tu es maintenant ami avec X".
  useEffect(() => {
    if (!user || !supabase) return
    const url = new URL(window.location.href)
    const token = url.searchParams.get('invite')
    if (!token) return
    const client = supabase
    void (async () => {
      const { data: inviterId, error } = await client.rpc('consume_invite', { invite_token: token })
      url.searchParams.delete('invite')
      window.history.replaceState({}, '', url.toString())
      if (error) {
        setFriendToast(`Invitation impossible : ${error.message}`)
        return
      }
      if (inviterId) {
        const { data: inviterProfile } = await client
          .from('public_profiles')
          .select('display_name, handle')
          .eq('user_id', inviterId as string)
          .maybeSingle()
        const name = inviterProfile?.display_name ?? inviterProfile?.handle ?? 'ton ami'
        setFriendToast(`Tu es maintenant ami avec ${name}`)
        void refreshFriends()
      }
    })()
  }, [user, refreshFriends])

  return (
    <>
      <AppCore
        pendingFriendCount={pendingFriendCount}
        profileDisplayName={profile?.displayName ?? null}
        profileHandle={profile?.handle ?? null}
        profileMapVisibility={profile?.mapVisibility ?? 'friends'}
        profileAvatarUrl={profile?.avatarUrl ?? null}
        profileAvatarBg={profile?.avatarBg ?? '#e5e5e5'}
        profileAvatarFg={profile?.avatarFg ?? '#1a1a1a'}
        onMapVisibilityChange={updateMapVisibility}
      />
      {needsSetup && (
        <ProfileSetupModal upsert={upsertProfile} checkHandleAvailable={checkHandleAvailable} />
      )}
      {friendToast && (
        <FriendToast message={friendToast} onDismiss={() => setFriendToast(null)} />
      )}
    </>
  )
}

function AppCore({
  pendingFriendCount,
  profileDisplayName,
  profileHandle,
  profileMapVisibility,
  profileAvatarUrl,
  profileAvatarBg,
  profileAvatarFg,
  onMapVisibilityChange,
}: {
  pendingFriendCount: number
  profileDisplayName: string | null
  profileHandle: string | null
  profileMapVisibility: MapVisibility
  profileAvatarUrl: string | null
  profileAvatarBg: string
  profileAvatarFg: string
  onMapVisibilityChange: (value: MapVisibility) => Promise<{ ok: boolean; error?: string }>
}) {
  const { user, loading: authLoading } = useAuth()
  const { friendships, sendRequestByUserId, acceptRequest } = useFriends()
  const [addFriendOpen, setAddFriendOpen] = useState(false)
  const [friendsManageOpen, setFriendsManageOpen] = useState(false)
  const [viewingFriend, setViewingFriend] = useState<{ userId: string; handle: string; displayName: string } | null>(null)
  const [compareFriend, setCompareFriend] = useState<import('./types').Friendship | null>(null)
  const [targetedCompare, setTargetedCompare] = useState<{ friendUserId: string; destinationKey: string } | null>(null)
  const [myDestinations, setDestinations, { resetAll: resetMyDestinations, error: myDestinationsError }] = useMyDestinations(normalizeDestinations)
  const [localSeedCompare, setLocalSeedCompare] = useState<ActiveSheetCompare | null>(null)
  // Quand on visite le carnet d'un ami : en mode fake on lit depuis _fakeFriends, sinon
  // on fetch via Supabase (RLS autorise les amis acceptés). Le hook renvoie [] quand
  // friendUserId est null, donc on peut l'appeler systématiquement.
  const friendUserIdProd = !FAKE_FRIENDS_MODE && viewingFriend ? viewingFriend.userId : null
  const { destinations: friendDestsProd, access: viewedFriendAccess } = useFriendDestinations(friendUserIdProd)
  const destinations = useMemo(() => {
    if (!viewingFriend) return myDestinations
    if (FAKE_FRIENDS_MODE) return getFakeFriendDestinations(viewingFriend.userId).map(withRecalculatedScore)
    return friendDestsProd
  }, [viewingFriend, myDestinations, friendDestsProd])

  // Mode "comparer" : on superpose les destinations de l'ami sur ma map.
  // Hook conditionnel safe : useFriendDestinations(null) renvoie [].
  const compareFriendUserIdProd = compareFriend && !FAKE_FRIENDS_MODE ? compareFriend.otherUser : null
  const { destinations: compareFriendDestsProd, access: compareFriendAccess } = useFriendDestinations(compareFriendUserIdProd)
  const compareFriendDests = useMemo(() => {
    if (!compareFriend) return [] as Destination[]
    if (FAKE_FRIENDS_MODE) return getFakeFriendDestinations(compareFriend.otherUser).map(withRecalculatedScore)
    return compareFriendDestsProd
  }, [compareFriend, compareFriendDestsProd])
  const targetedCompareFriend = useMemo(
    () => targetedCompare ? (friendships.find(item => item.otherUser === targetedCompare.friendUserId && item.status === 'accepted') ?? null) : null,
    [friendships, targetedCompare]
  )
  const targetedCompareFriendUserIdProd = targetedCompareFriend && !FAKE_FRIENDS_MODE ? targetedCompareFriend.otherUser : null
  const { destinations: targetedCompareFriendDestsProd, access: targetedCompareFriendAccess } = useFriendDestinations(targetedCompareFriendUserIdProd)
  const targetedCompareFriendDests = useMemo(() => {
    if (!targetedCompareFriend) return [] as Destination[]
    if (compareFriend?.otherUser === targetedCompareFriend.otherUser) return compareFriendDests
    if (FAKE_FRIENDS_MODE) return getFakeFriendDestinations(targetedCompareFriend.otherUser).map(withRecalculatedScore)
    return targetedCompareFriendDestsProd
  }, [targetedCompareFriend, compareFriend, compareFriendDests, targetedCompareFriendDestsProd])
  // Noms partagés (insensible casse + accents) — sert au visuel.
  // On y ajoute les deux orthographes (la mienne et celle de l'ami) parce que
  // WorldMap les compare au .name brut de chaque destination.
  const compareSharedNames = useMemo(() => {
    if (!compareFriend) return undefined
    const myNorm = destinationNameSet(myDestinations)
    const set = new Set<string>()
    for (const d of compareFriendDests) {
      const key = destinationNameKey(d)
      if (!myNorm.has(key)) continue
      set.add(key)
      set.add(d.name)
      const mineMatch = myDestinations.find(m => destinationNameKey(m) === key)
      if (mineMatch) set.add(mineMatch.name)
    }
    return set
  }, [compareFriend, compareFriendDests, myDestinations])
  // Compteur "en commun" (uniques, par nom normalisé) pour l'UI.
  const compareCommonCount = useMemo(() => {
    if (!compareFriend) return 0
    const myNorm = destinationNameSet(myDestinations)
    let n = 0
    const seen = new Set<string>()
    for (const d of compareFriendDests) {
      const k = destinationNameKey(d)
      if (myNorm.has(k) && !seen.has(k)) { seen.add(k); n++ }
    }
    return n
  }, [compareFriend, compareFriendDests, myDestinations])
  const viewingFriendDenied = Boolean(viewingFriend && !FAKE_FRIENDS_MODE && !viewedFriendAccess.allowed && viewedFriendAccess.deniedReason)
  const compareFriendDenied = Boolean(compareFriend && !FAKE_FRIENDS_MODE && !compareFriendAccess.allowed && compareFriendAccess.deniedReason)
  const targetedCompareDenied = Boolean(targetedCompareFriend && !FAKE_FRIENDS_MODE && !targetedCompareFriendAccess.allowed && targetedCompareFriendAccess.deniedReason)

  const friendshipWithViewed = useMemo(
    () => viewingFriend ? (friendships.find(f => f.otherUser === viewingFriend.userId) ?? null) : null,
    [friendships, viewingFriend]
  )

  const [addFriendFeedback, setAddFriendFeedback] = useState<'idle' | 'sent' | 'accepted'>('idle')

  useEffect(() => { setAddFriendFeedback('idle') }, [viewingFriend?.userId])

  const handleAddViewingFriend = useCallback(async () => {
    if (!viewingFriend) return
    const existing = friendships.find(f => f.otherUser === viewingFriend.userId)
    if (existing?.status === 'pending' && existing.initiator === 'them') {
      await acceptRequest(existing.otherUser)
      setAddFriendFeedback('accepted')
    } else {
      await sendRequestByUserId(viewingFriend.userId)
      setAddFriendFeedback('sent')
    }
  }, [viewingFriend, friendships, sendRequestByUserId, acceptRequest])

  const handleCompareViewingFriend = useCallback(() => {
    if (!viewingFriend) return
    const f = friendships.find(fr => fr.otherUser === viewingFriend.userId)
    if (f) {
      setTargetedCompare(null)
      setCompareFriend(f)
      setViewingFriend(null)
    }
  }, [viewingFriend, friendships])
  const handleTargetedCompareFriend = useCallback((friendUserId: string, destination: Destination) => {
    const friend = friendships.find(item => item.otherUser === friendUserId && item.status === 'accepted')
    if (!friend) return
    setViewingFriend(null)
    setCompareFriend(null)
    setTargetedCompare({
      friendUserId,
      destinationKey: destinationNameKey(destination),
    })
  }, [friendships])

  const [flyTarget, setFlyTarget] = useState<{ lat: number; lng: number; name: string } | null>(null)
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [pendingMapFocusName, setPendingMapFocusName] = useState<string | null>(null)
  const [filters, setFilters] = useState<DestinationFilters>(DEFAULT_FILTERS)
  const [sortByScore, setSortByScore] = useState(false)
  const [tierListCollapsed, setTierListCollapsed] = useState(true)
  const [addingDestination, setAddingDestination] = useState(false)
  const [editingDestination, setEditingDestination] = useState<Destination | null>(null)
  const [duplicateConflict, setDuplicateConflict] = useState<{ existing: Destination; incoming: Destination } | null>(null)
  const [activeView, setActiveView] = useState<View>('map')
  const [accountOpen, setAccountOpen] = useState(false)
  const [shareCopied, setShareCopied] = useState(false)
  const [publicId, setPublicId] = useState<string>(loadPublicId)
  const avatarFallbackLabel = getAvatarFallbackLabel(profileDisplayName, profileHandle, publicId)
  const profileAvatarFallbackUrl = profileHandle
    ? `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(profileHandle)}`
    : undefined
  const [mapDetail, setMapDetail] = useState<'simple' | 'detailed'>(() =>
    (localStorage.getItem('outpost-map-detail') as 'simple' | 'detailed' | null) ?? 'simple'
  )
  const isMobileLayout = useMediaQuery('(max-width: 768px)')
  const [desktopDock, setDesktopDock] = useState<DesktopDockState>(DESKTOP_DOCK_DEFAULT)

  useEffect(() => {
    const url = new URL(window.location.href)
    if (!isLocalTestHost() || url.searchParams.get('seed') !== 'achievements') return

    url.searchParams.delete('seed')
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
    setAccountOpen(true)

    if (user) {
      console.warn('[seed] Achievement test data skipped: sign out to seed local-only data.')
      return
    }

    const seededDestinations = ACHIEVEMENT_TEST_DESTINATIONS.map(withRecalculatedScore)
    setViewingFriend(null)
    setCompareFriend(null)
    setTargetedCompare(null)
    setSelectedName(null)
    setSelectedKey(null)
    setPendingMapFocusName(null)
    setFlyTarget(null)
    setFilters(DEFAULT_FILTERS)
    setActiveView('map')
    setDestinations(seededDestinations)
  }, [setDestinations, user])

  useEffect(() => {
    const url = new URL(window.location.href)
    if (!isLocalTestHost() || url.searchParams.get('seed') !== 'friend-only-compare') return

    url.searchParams.delete('seed')
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)

    const fallbackFriend = FAKE_FRIENDSHIPS.find(friend => friend.status === 'accepted') ?? null
    if (!fallbackFriend) return

    const seededMine = (myDestinations.length > 0 || user)
      ? myDestinations
      : getFakeMyDestinations().map(withRecalculatedScore)
    const myKeys = destinationNameSet(seededMine)
    const friendDestinations = getFakeFriendDestinations(fallbackFriend.otherUser).map(withRecalculatedScore)
    const friendOnlyDestination = friendDestinations.find(destination => !myKeys.has(destinationNameKey(destination))) ?? friendDestinations[0]

    if (!friendOnlyDestination) return
    if (!user && myDestinations.length === 0) setDestinations(seededMine)

    setAccountOpen(true)
    setViewingFriend(null)
    setCompareFriend(null)
    setTargetedCompare(null)
    setLocalSeedCompare({
      mode: 'global',
      friend: fallbackFriend,
      mine: undefined,
      theirs: friendOnlyDestination,
    })
    setSelectedName(friendOnlyDestination.name)
    setSelectedKey(destinationNameKey(friendOnlyDestination))
    setPendingMapFocusName(null)
    setFlyTarget({ lat: friendOnlyDestination.lat, lng: friendOnlyDestination.lng, name: friendOnlyDestination.name })
    setFilters(DEFAULT_FILTERS)
    setActiveView('map')
  }, [myDestinations, setDestinations, user])

  useEffect(() => {
    const url = new URL(window.location.href)
    if (!isLocalTestHost() || url.searchParams.get('seed') !== 'verify-tags') return

    url.searchParams.delete('seed')
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)

    const seededMine = (myDestinations.length > 0 || user)
      ? myDestinations
      : getFakeMyDestinations().map(withRecalculatedScore)
    const target = seededMine.find(destination => destination.name === 'Rome') ?? null

    if (!target) return
    if (!user && myDestinations.length === 0) setDestinations(seededMine)

    setAccountOpen(false)
    setViewingFriend(null)
    setCompareFriend(null)
    setTargetedCompare(null)
    setLocalSeedCompare(null)
    setSelectedName(target.name)
    setSelectedKey(destinationNameKey(target))
    setPendingMapFocusName(null)
    setFlyTarget({ lat: target.lat, lng: target.lng, name: target.name })
    setFilters(DEFAULT_FILTERS)
    setActiveView('map')
  }, [myDestinations, setDestinations, user])

  useEffect(() => {
    const url = new URL(window.location.href)
    if (!user && url.searchParams.has('invite')) {
      setAccountOpen(true)
    }
  }, [user])

  useEffect(() => {
    try {
      if (publicId) localStorage.setItem(PUBLIC_ID_KEY, publicId)
      else localStorage.removeItem(PUBLIC_ID_KEY)
    } catch {
      /* ignore */
    }
  }, [publicId])

  // Auto-sync : si on est connecté et qu'on a un handle Supabase mais pas de
  // publicId local (cas typique après signOut+signIn, où le cache localStorage
  // a été purgé pour éviter la fuite entre comptes), on restaure publicId
  // depuis le profile. Sans ça, les boutons "Partager" produisent un slug
  // 'invite' générique au lieu du vrai pseudo de l'utilisateur.
  useEffect(() => {
    if (profileHandle && !publicId) setPublicId(profileHandle)
  }, [profileHandle, publicId])

  useEffect(() => {
    if (authLoading || user) return
    setPublicId('')
    setCompareFriend(null)
    setTargetedCompare(null)
    setViewingFriend(null)
    setSelectedName(null)
    setSelectedKey(null)
  }, [authLoading, user])

  useEffect(() => {
    if (isMobileLayout || activeView !== 'map') {
      setDesktopDock(prev => (
        JSON.stringify(prev) === JSON.stringify(DESKTOP_DOCK_DEFAULT)
          ? prev
          : DESKTOP_DOCK_DEFAULT
      ))
      return
    }

    let frame = 0
    let resizeObserver: ResizeObserver | null = null
    let fontsReadyActive = true
    const hasCompareBar = Boolean(compareFriend && !compareFriendDenied && !viewingFriend)

    const measureDocking = () => {
      const visibleRect = (selector: string) => {
        const element = document.querySelector(selector)
        if (!(element instanceof HTMLElement)) return null
        const style = window.getComputedStyle(element)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null
        const rect = element.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return null
        return rect
      }

      const sidebar = document.querySelector('.sidebar')
      if (!(sidebar instanceof HTMLElement)) return

      const sidebarRect = sidebar.getBoundingClientRect()
      const destinationCardRect = visibleRect('.destination-card')
      const sharedProfileRect = visibleRect('.shared-friend-panel--desktop')
      const tierBoardRect = visibleRect('.tier-board')
      const legendRect = visibleRect('.legend')
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const outerMargin = 16
      const rightMargin = 20
      const stackGap = 16
      const panelStackGap = 16
      const minPanelStackGap = 16
      const bottomMargin = 16
      const controlsBaseOffset = 14
      const controlsGap = 16
      const controlsHeight = 172
      const measuredTierHeight = tierBoardRect ? Math.ceil(tierBoardRect.height) : null
      const measuredLegendHeight = legendRect ? Math.ceil(legendRect.height) : null
      const tierHeight = measuredTierHeight
        ? tierListCollapsed
          ? Math.min(measuredTierHeight, 140)
          : measuredTierHeight
        : tierListCollapsed ? 90 : 310
      const legendHeight = measuredLegendHeight
        ? Math.min(Math.max(measuredLegendHeight, 188), 240)
        : 205
      const leftDockX = Math.round(sidebarRect.left)
      const leftLimit = destinationCardRect ? destinationCardRect.left - rightMargin : viewportWidth - rightMargin
      const availableWidth = Math.max(260, Math.round(leftLimit - leftDockX))
      // Colonne gauche (légende + barre repliée) = largeur exacte de la nav island.
      const leftDockWidth = Math.min(Math.round(sidebarRect.width), availableWidth)
      // Panneau tier déplié = plus large pour afficher les colonnes S/A/B/C/D.
      const tierPanelWidth = Math.max(leftDockWidth, Math.min(700, availableWidth))
      const sharedProfileTop = Math.round(sidebarRect.bottom + stackGap)
      const sharedProfileHeight = sharedProfileRect ? Math.ceil(sharedProfileRect.height) : 0
      const stackTop = sharedProfileHeight > 0
        ? Math.round(sharedProfileTop + sharedProfileHeight + stackGap)
        : Math.round(sidebarRect.bottom + stackGap)
      // Order: My rankings (tier) first, Notation (legend) second.
      const stackedBottom = stackTop + tierHeight + panelStackGap + legendHeight + bottomMargin
      const compactPanelStackGap = stackedBottom <= viewportHeight
        ? panelStackGap
        : Math.max(
          minPanelStackGap,
          Math.floor((viewportHeight - stackTop - tierHeight - legendHeight - bottomMargin) / 2),
        )
      const compactStackBottom = stackTop + tierHeight + compactPanelStackGap + legendHeight + bottomMargin
      const compactStackFits = compactStackBottom <= viewportHeight
      const tierMode: DesktopTierMode = compactStackFits ? 'stacked-left' : 'bottom-left'
      const legendMode: DesktopLegendMode = compactStackFits ? 'stacked-left' : 'bottom-left'
      // Tier is positioned first (at stackTop), legend goes below it.
      const tierStackTop = tierMode === 'stacked-left'
        ? Math.round(stackTop)
        : 0
      // When collapsed: cap the live bottom to stackTop+tierHeight so a mid-animation
      // read doesn't push the legend off-screen. When expanded: use live bottom directly.
      const collapsedBound = stackTop + tierHeight
      const tierActualBottom = tierBoardRect
        ? tierListCollapsed
          ? Math.min(Math.ceil(tierBoardRect.bottom), collapsedBound)
          : Math.ceil(tierBoardRect.bottom)
        : collapsedBound
      const legendStackTop = tierMode === 'stacked-left'
        ? Math.round(tierActualBottom + compactPanelStackGap)
        : Math.round(stackTop)
      const legendBottom = tierMode === 'bottom-left'
        ? Math.round(tierHeight + bottomMargin + compactPanelStackGap)
        : bottomMargin
      const controlsTopUnderTier = tierMode === 'stacked-left'
        ? legendStackTop + legendHeight + 58
        : viewportHeight - bottomMargin - controlsGap - controlsHeight
      const controlsBottom = Math.max(
        bottomMargin,
        Math.round(viewportHeight - controlsTopUnderTier - controlsHeight),
      )
      const controlsWidth = 44
      const controlsLeft = Math.round(Math.min(
        leftDockX + 16,
        leftLimit - controlsWidth,
      ))
      const stackBottom = tierMode === 'stacked-left'
        ? Math.round(legendStackTop + legendHeight)
        : legendMode === 'stacked-left'
          ? Math.round(stackTop + legendHeight)
          : 0

      setDesktopDock(prev => {
        const next: DesktopDockState = {
          controlsBottom,
          controlsLeft,
          controlsMode: 'bottom-left',
          leftDockWidth,
          leftDockX,
          legendBottom,
          legendHeight,
          legendMode,
          legendStackTop,
          sharedProfileHeight,
          sharedProfileTop,
          sidebarBottom: Math.round(sidebarRect.bottom),
          stackBottom,
          stackGap: compactPanelStackGap,
          stackTop,
          tierHeight,
          tierMode,
          tierPanelWidth,
          tierStackTop,
        }
        return JSON.stringify(prev) === JSON.stringify(next) ? prev : next
      })
    }

    const scheduleMeasure = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(measureDocking)
    }

    const observeDockElement = (selector: string) => {
      const element = document.querySelector(selector)
      if (element instanceof HTMLElement) {
        resizeObserver?.observe(element)
      }
    }

    scheduleMeasure()
    // Second pass after tier-board collapse animation (320ms) so the measured
    // height reflects the settled collapsed state, not the mid-animation value.
    const postAnimationMeasure = window.setTimeout(scheduleMeasure, 360)
    resizeObserver = new ResizeObserver(() => {
      scheduleMeasure()
    })
    observeDockElement('.sidebar')
    observeDockElement('.shared-friend-panel--desktop')
    observeDockElement('.tier-board')
    observeDockElement('.legend')

    const fonts = (document as Document & {
      fonts?: {
        ready?: Promise<unknown>
        addEventListener?: (type: string, listener: EventListener) => void
        removeEventListener?: (type: string, listener: EventListener) => void
      }
    }).fonts
    const handleFontsLoadingDone = () => {
      scheduleMeasure()
    }

    if (fonts?.ready) {
      void fonts.ready
        .then(() => {
          if (fontsReadyActive) scheduleMeasure()
        })
        .catch(() => {})
    }

    if (fonts && typeof fonts.addEventListener === 'function' && typeof fonts.removeEventListener === 'function') {
      fonts.addEventListener('loadingdone', handleFontsLoadingDone)
    }

    window.addEventListener('resize', scheduleMeasure)
    return () => {
      fontsReadyActive = false
      window.cancelAnimationFrame(frame)
      window.clearTimeout(postAnimationMeasure)
      resizeObserver?.disconnect()
      if (fonts && typeof fonts.removeEventListener === 'function') {
        fonts.removeEventListener('loadingdone', handleFontsLoadingDone)
      }
      window.removeEventListener('resize', scheduleMeasure)
    }
  }, [
    activeView,
    compareFriend,
    compareFriendDenied,
    isMobileLayout,
    selectedName,
    tierListCollapsed,
    viewingFriend,
  ])

  // Lien partagé `?u=handle` → on charge directement le carnet de cet ami.
  // En mode fake, lookup local ; en prod, RPC find_user_by_handle + public_profiles.
  // Strip le query param de l'URL après consommation.
  useEffect(() => {
    const url = new URL(window.location.href)
    const handle = url.searchParams.get('u')
    if (!handle) return
    let cancelled = false
    void (async () => {
      if (FAKE_FRIENDS_MODE) {
        const match = findFakeFriendByHandle(handle)
        if (!cancelled && match) {
          setViewingFriend(match)
          setActiveView('map')
        }
      } else if (supabase) {
        const clean = handle.trim().toLowerCase().replace(/^@/, '')
        const { data: targetId } = await supabase.rpc('find_user_by_handle', { target_handle: clean })
        if (targetId) {
          const { data: profile } = await supabase
            .from('public_profiles')
            .select('handle, display_name')
            .eq('user_id', targetId as string)
            .maybeSingle()
          if (!cancelled && profile) {
            setViewingFriend({
              userId: targetId as string,
              handle: profile.handle,
              displayName: profile.display_name ?? profile.handle,
            })
            setActiveView('map')
          }
        }
      }
      url.searchParams.delete('u')
      window.history.replaceState({}, '', url.toString())
    })()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const visibleDestinations = useMemo(() => {
    const currentYear = new Date().getFullYear()
    const filtered = destinations.filter(destination => {
      if (filters.coupDeCoeur && !destination.coupDeCoeur) return false
      if (filters.thisYear && destination.tripYear !== currentYear) return false
      if (filters.livedThere && !destination.livedThere) return false
      if (filters.visitedMultiple && (!destination.visitCount || destination.visitCount < 2)) return false
      if (filters.companions !== 'all') {
        const c = destination.companions
        if (filters.companions === 'amis' && c !== 'amis' && c !== 'couple') return false
        if (filters.companions !== 'amis' && c !== filters.companions) return false
      }
      if (filters.budget !== 'all') {
        const b = destination.personalBudget
        if (filters.budget === '$' && (b === undefined || b >= 300)) return false
        if (filters.budget === '$$' && (b === undefined || b < 300 || b > 800)) return false
        if (filters.budget === '$$$' && (b === undefined || b <= 800)) return false
      }
      return true
    })

    return [...filtered].sort((a, b) => {
      if (sortByScore) return getDestinationScore(b) - getDestinationScore(a)
      return a.name.localeCompare(b.name)
    })
  }, [destinations, filters, sortByScore])

  const selectedMine = useMemo(
    () => selectedKey ? (myDestinations.find(destination => destinationNameKey(destination) === selectedKey) ?? null) : null,
    [myDestinations, selectedKey],
  )
  const selectedFriendView = useMemo(
    () => selectedKey ? (destinations.find(destination => destinationNameKey(destination) === selectedKey) ?? null) : null,
    [destinations, selectedKey],
  )
  const selectedCompareDestination = useMemo(
    () => selectedKey && compareFriend ? (compareFriendDests.find(destination => destinationNameKey(destination) === selectedKey) ?? null) : null,
    [selectedKey, compareFriend, compareFriendDests],
  )
  const selectedTargetedCompareDestination = useMemo(() => {
    if (!selectedKey || !targetedCompareFriend || !targetedCompare) return null
    if (selectedKey !== targetedCompare.destinationKey) return null
    return targetedCompareFriendDests.find(destination => destinationNameKey(destination) === targetedCompare.destinationKey) ?? null
  }, [selectedKey, targetedCompareFriend, targetedCompare, targetedCompareFriendDests])
  const activeSheetCompare = useMemo<ActiveSheetCompare | null>(() => {
    if (targetedCompareFriend && selectedTargetedCompareDestination) {
      return {
        mode: 'targeted',
        friend: targetedCompareFriend,
        mine: selectedMine,
        theirs: selectedTargetedCompareDestination,
      }
    }
    if (compareFriend && selectedCompareDestination) {
      return {
        mode: 'global',
        friend: compareFriend,
        mine: selectedMine,
        theirs: selectedCompareDestination,
      }
    }
    if (localSeedCompare && selectedKey === destinationNameKey(localSeedCompare.theirs)) {
      return localSeedCompare
    }
    return null
  }, [targetedCompareFriend, selectedTargetedCompareDestination, compareFriend, selectedCompareDestination, localSeedCompare, selectedKey, selectedMine])
  const isLocalSeedCompareActive = useMemo(
    () => Boolean(
      localSeedCompare
      && activeSheetCompare
      && localSeedCompare.friend.otherUser === activeSheetCompare.friend.otherUser
      && destinationNameKey(localSeedCompare.theirs) === destinationNameKey(activeSheetCompare.theirs)
    ),
    [localSeedCompare, activeSheetCompare]
  )
  const selected = useMemo(() => {
    if (viewingFriend) return selectedFriendView
    if (activeSheetCompare) return activeSheetCompare.mine ?? activeSheetCompare.theirs
    return selectedMine ?? (selectedName ? destinations.find(destination => destination.name === selectedName) ?? null : null)
  }, [viewingFriend, selectedFriendView, activeSheetCompare, selectedMine, selectedName, destinations])

  useEffect(() => {
    if (!targetedCompare) return
    if (!selectedKey || selectedKey !== targetedCompare.destinationKey) {
      setTargetedCompare(null)
    }
  }, [selectedKey, targetedCompare])

  const selectByName = (name: string) => {
    const destination = destinations.find(item => item.name === name)
    if (destination) {
      setSelectedName(destination.name)
      setSelectedKey(destinationNameKey(destination))
      setFlyTarget({ lat: destination.lat, lng: destination.lng, name: destination.name })
      return
    }
    const friendDest = compareFriendDests.find(item => item.name === name)
      ?? targetedCompareFriendDests.find(item => item.name === name)
    if (friendDest) {
      setSelectedName(friendDest.name)
      setSelectedKey(destinationNameKey(friendDest))
      setFlyTarget({ lat: friendDest.lat, lng: friendDest.lng, name: friendDest.name })
    }
  }

  const openDestinationOnMap = (name: string) => {
    const destination = destinations.find(item => item.name === name)
    if (!destination) return
    setSelectedName(destination.name)
    setSelectedKey(destinationNameKey(destination))
    setPendingMapFocusName(destination.name)
    setActiveView('map')
  }

  useEffect(() => {
    if (activeView !== 'map' || !pendingMapFocusName) return
    const destination = destinations.find(item => item.name === pendingMapFocusName)
    if (!destination) {
      setPendingMapFocusName(null)
      return
    }
    setFlyTarget({ lat: destination.lat, lng: destination.lng, name: destination.name })
    setPendingMapFocusName(null)
  }, [activeView, destinations, pendingMapFocusName])

  const focusSelected = () => {
    if (!selected) return
    setFlyTarget({ lat: selected.lat, lng: selected.lng, name: selected.name })
  }

  const coupDeCoeurCount = useMemo(
    () => destinations.filter(d => d.coupDeCoeur).length,
    [destinations],
  )

  const toggleCoupDeCoeur = (name: string) => {
    setDestinations(previous => previous.map(d => {
      if (d.name !== name) return d
      if (d.coupDeCoeur) return withRecalculatedScore({ ...d, coupDeCoeur: false })
      if (previous.filter(x => x.coupDeCoeur).length >= getMaxCoupDeCoeur(previous.length)) return d
      return withRecalculatedScore({ ...d, coupDeCoeur: true })
    }))
  }

  const removeDestination = (name: string) => {
    setDestinations(previous => previous.filter(item => item.name !== name))
    if (selectedName === name) {
      setSelectedName(null)
      setSelectedKey(null)
    }
  }

  const updateDestination = (updated: Destination, options?: SaveOptions) => {
    const originalName = editingDestination?.name ?? updated.name
    const merged = withRecalculatedScore(updated)

    setDestinations(previous => previous.map(item => {
      if (options?.replaceCoupDeCoeurName && item.name === options.replaceCoupDeCoeurName) {
        return { ...item, coupDeCoeur: false }
      }
      return item.name === originalName ? merged : item
    }))
    setSelectedName(merged.name)
    setSelectedKey(destinationNameKey(merged))
    setFlyTarget({ lat: merged.lat, lng: merged.lng, name: merged.name })
    setEditingDestination(null)
  }

  const addDestination = (destination: Destination, options?: SaveOptions) => {
    const normalizedDestination = withRecalculatedScore(destination)
    const dup = findDuplicate(normalizedDestination, destinations)
    if (dup) {
      setDuplicateConflict({ existing: dup, incoming: normalizedDestination })
      setAddingDestination(false)
      return
    }
    setDestinations(previous => [
      ...previous.map(item => (
        options?.replaceCoupDeCoeurName && item.name === options.replaceCoupDeCoeurName
          ? { ...item, coupDeCoeur: false }
          : item
      )),
      normalizedDestination,
    ])
    setSelectedName(normalizedDestination.name)
    setSelectedKey(destinationNameKey(normalizedDestination))
    setFlyTarget({ lat: normalizedDestination.lat, lng: normalizedDestination.lng, name: normalizedDestination.name })
    setAddingDestination(false)
    setActiveView('map')
  }

  const shareTierList = async () => {
    // Feedback visuel IMMÉDIAT — toujours déclenché au clic, même sans publicId,
    // pour que le bouton réponde visuellement dans tous les cas.
    setShareCopied(true)
    window.setTimeout(() => setShareCopied(false), 1800)
    if (!publicId.trim()) return
    const slug = publicId.trim()
    const url = `${window.location.origin}${window.location.pathname}?u=${encodeURIComponent(slug)}`
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
      }
    } catch {
      // Fallback discret : on garde le feedback "Lien copié" mais on log le lien.
      console.warn('[share] clipboard unavailable, link:', url)
    }
  }

  const appClass = [
    'travel-app',
    `view-${activeView}`,
    tierListCollapsed ? 'tier-collapsed' : '',
    !(activeView === 'map' && selected) ? 'no-card' : '',
    compareFriend && !compareFriendDenied && activeView === 'map' && !viewingFriend ? 'compare-active' : '',
    activeSheetCompare && activeView === 'map' ? 'destination-compare-open' : '',
    activeView === 'map' && !isMobileLayout ? `desktop-legend-${desktopDock.legendMode}` : '',
    activeView === 'map' && !isMobileLayout ? `desktop-tier-${desktopDock.tierMode}` : '',
    activeView === 'map' && !isMobileLayout ? `desktop-controls-${desktopDock.controlsMode}` : '',
  ].filter(Boolean).join(' ')

  const appStyle = useMemo(() => (
    {
      '--desktop-controls-bottom': `${desktopDock.controlsBottom}px`,
      '--desktop-controls-left': `${desktopDock.controlsLeft}px`,
      '--desktop-left-dock-w': `${desktopDock.leftDockWidth}px`,
      '--desktop-left-dock-x': `${desktopDock.leftDockX}px`,
      '--desktop-left-stack-bottom': `${desktopDock.stackBottom}px`,
      '--desktop-left-stack-gap': `${desktopDock.stackGap}px`,
      '--desktop-left-stack-top': `${desktopDock.stackTop}px`,
      '--desktop-sidebar-bottom': `${desktopDock.sidebarBottom}px`,
      '--desktop-legend-bottom': `${desktopDock.legendBottom}px`,
      '--desktop-legend-height': `${desktopDock.legendHeight}px`,
      '--desktop-legend-stack-top': `${desktopDock.legendStackTop}px`,
      '--desktop-shared-profile-height': `${desktopDock.sharedProfileHeight}px`,
      '--desktop-shared-profile-top': `${desktopDock.sharedProfileTop}px`,
      '--desktop-tier-height': `${desktopDock.tierHeight}px`,
      '--desktop-tier-panel-w': `${desktopDock.tierPanelWidth}px`,
      '--desktop-tier-stack-top': `${desktopDock.tierStackTop}px`,
    } as CSSProperties
  ), [desktopDock])

  return (
    <div className={appClass} style={appStyle}>
      {myDestinationsError && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 9999,
            background: '#fff1f0',
            color: '#8a1a1a',
            border: '1px solid #f3c2c2',
            borderRadius: 10,
            padding: '8px 14px',
            fontSize: 13,
            boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
            maxWidth: 'min(92vw, 480px)',
          }}
        >
          {t('Sync failed: ', 'Synchronisation échouée : ')}{myDestinationsError}. {t('Your changes are saved locally.', 'Tes changements sont sauvegardés en local.')}
        </div>
      )}
      <div className="mobile-header">
        <BrandLogo className="mobile-brand-logo" />
        <button
          className={`mobile-header-avatar${accountOpen ? ' is-active' : ''}`}
          onClick={() => setAccountOpen(v => !v)}
          aria-label={accountOpen ? t('Close account', 'Fermer mon compte') : t('My account', 'Mon compte')}
          aria-expanded={accountOpen}
        >
          <Avatar
            avatarUrl={profileAvatarUrl}
            fallbackUrl={profileAvatarFallbackUrl}
            initials={avatarFallbackLabel}
            bg={profileAvatarBg}
            fg={profileAvatarFg}
            className="mobile-header-avatar-face"
            ariaHidden={true}
          />
        </button>
      </div>
      <BottomNav
        activeView={activeView}
        pendingFriendCount={pendingFriendCount}
        onViewChange={setActiveView}
        onAddClick={() => setAddingDestination(true)}
        onOpenFriends={() => setFriendsManageOpen(true)}
      />
      <WorldMap
        destinations={visibleDestinations}
        flyTarget={flyTarget}
        selectedName={selected?.name}
        onSelect={selectByName}
        onDeselect={() => {
          setSelectedName(null)
          setSelectedKey(null)
        }}
        onFlyTargetConsumed={() => setFlyTarget(null)}
        friendDestinations={compareFriend && !compareFriendDenied ? compareFriendDests : undefined}
        friendInitials={compareFriend && !compareFriendDenied ? (compareFriend.displayName || '?').slice(0, 1).toUpperCase() : undefined}
        friendAvatarUrl={compareFriend && !compareFriendDenied ? (compareFriend.avatarUrl ?? null) : null}
        friendAvatarBg={compareFriend && !compareFriendDenied ? compareFriend.avatarBg : undefined}
        friendAvatarFg={compareFriend && !compareFriendDenied ? compareFriend.avatarFg : undefined}
        sharedNames={compareFriend && !compareFriendDenied ? compareSharedNames : undefined}
        controlsMode={desktopDock.controlsMode}
        legendMode={desktopDock.legendMode}
        hidden={activeView !== 'map'}
        mapDetail={mapDetail}
      />
      {/* Barre flottante compare (desktop only) — sur mobile la comparaison vit dans le panneau My rankings */}
      {compareFriend && !compareFriendDenied && activeView === 'map' && !viewingFriend && !isMobileLayout && (
        <div
          className={[
            'compare-inline-bar',
            !isMobileLayout && desktopDock.legendMode === 'stacked-left' ? 'compare-inline-bar--stacked-left' : '',
            !isMobileLayout && desktopDock.legendMode === 'bottom-left' ? 'compare-inline-bar--bottom-left' : '',
          ].filter(Boolean).join(' ')}
          role="status"
        >
          <div className="compare-inline-legend">
            <span className="compare-inline-item">
              <span className="compare-legend-dot compare-legend-dot--mine" aria-hidden="true" />
              Toi
            </span>
            <span className="compare-inline-item">
              <Avatar
                className="compare-legend-dot compare-legend-dot--theirs"
                avatarUrl={compareFriend.avatarUrl}
                initials={compareFriend.displayName.slice(0, 1)}
                bg={compareFriend.avatarBg}
                fg={compareFriend.avatarFg}
                ariaHidden={true}
              />
              {compareFriend.displayName.split(' ')[0]}
            </span>
            <span className="compare-inline-item">
              {compareCommonCount} {t('in common', 'en commun')}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-pill btn-sm compare-inline-close"
            onClick={() => setCompareFriend(null)}
            aria-label={`${t('Exit comparison with', 'Quitter la comparaison avec')} ${compareFriend.displayName}`}
          >
            <Icon name="x" /> {t('Exit comparison', 'Quitter la comparaison')}
          </button>
        </div>
      )}
      {/* Empty state quand on visite le carnet d'un ami qui n'a pas encore
          ajouté de destinations (ami qui débute, ou un seed sans data). */}
      {viewingFriendDenied && activeView === 'map' && (
        <div className="empty-friend-carnet" role="status">
          <div className="empty-friend-carnet-card">
            <h3>{getMapPrivacyMessage(viewedFriendAccess.deniedReason, viewingFriend?.handle).title}</h3>
            <p>{getMapPrivacyMessage(viewedFriendAccess.deniedReason, viewingFriend?.handle).body}</p>
            <button
              type="button"
              className="friends-action-btn friends-action-secondary"
              onClick={() => { setViewingFriend(null); setSelectedName(null); setSelectedKey(null) }}
            >
              {t('← My journal', '← Mon carnet')}
            </button>
          </div>
        </div>
      )}
      {/* Profil voyageur de l'ami, visible d'office quand son carnet est ouvert —
          le gating est implicite : `destinations` ne contient ses lignes que si le
          RPC get_public_destinations a autorisé l'accès. Replié en chip sur mobile. */}
      {viewingFriend && activeView === 'map' && !viewingFriendDenied && destinations.length > 0 && !isMobileLayout && (
        <div className="shared-friend-panel shared-friend-panel--desktop">
          <TravelerProfileStrip
            destinations={destinations}
            expandable
            mode="shared-map-dock"
          />
        </div>
      )}
      {viewingFriend && activeView === 'map' && !viewingFriendDenied && destinations.length > 0 && isMobileLayout && (
        <div className="friend-profile-overlay">
          <TravelerProfileStrip
            destinations={destinations}
            expandable
            defaultCollapsed={isMobileLayout}
          />
        </div>
      )}
      {viewingFriend && activeView === 'map' && !viewingFriendDenied && destinations.length === 0 && (
        <div className="empty-friend-carnet" role="status">
          <div className="empty-friend-carnet-card">
            <h3>@{viewingFriend.handle} {t("hasn't added any destinations yet.", "n'a pas encore ajouté de destinations.")}</h3>
            <p>{t('Check back later, or go back to your journal.', 'Reviens plus tard, ou retourne à ton carnet.')}</p>
            <button
              type="button"
              className="friends-action-btn friends-action-secondary"
              onClick={() => { setViewingFriend(null); setSelectedName(null); setSelectedKey(null) }}
            >
              {t('← My journal', '← Mon carnet')}
            </button>
          </div>
        </div>
      )}
      {!viewingFriend && activeView === 'map' && myDestinations.length === 0 && (
        <div className="empty-friend-carnet" role="status">
          <div className="empty-friend-carnet-card">
            <h3>{t('Your journal is empty', 'Ton carnet est vide')}</h3>
            <p>{t('Add your first destination to see it appear on the map.', 'Ajoute ta première destination pour la voir apparaître sur la carte.')}</p>
            <button
              type="button"
              className="add-submit"
              onClick={() => setAddingDestination(true)}
            >
              + {t('Add my first destination', 'Ajouter ma première destination')}
            </button>
          </div>
        </div>
      )}
      {!viewingFriend && activeView === 'map' && myDestinations.length > 0 && visibleDestinations.length === 0 && (
        <div className="empty-friend-carnet" role="status">
          <div className="empty-friend-carnet-card">
            <h3>{t('No results for these filters', 'Aucun résultat pour ces filtres')}</h3>
            <p>{t('Change or reset the filters to see your destinations.', 'Modifie ou réinitialise les filtres pour revoir tes destinations.')}</p>
            <button
              type="button"
              className="friends-action-btn friends-action-secondary"
              onClick={() => setFilters(DEFAULT_FILTERS)}
            >
              {t('Reset filters', 'Réinitialiser les filtres')}
            </button>
          </div>
        </div>
      )}
      {compareFriendDenied && activeView === 'map' && !viewingFriend && (
        <div className="empty-friend-carnet" role="status">
          <div className="empty-friend-carnet-card">
            <h3>{getMapPrivacyMessage(compareFriendAccess.deniedReason, compareFriend?.handle).title}</h3>
            <p>{t('The comparison cannot be shown while this map is not visible to you.', 'La comparaison ne peut pas s\'afficher tant que cette carte n\'est pas visible pour toi.')}</p>
            <button
              type="button"
              className="friends-action-btn friends-action-secondary"
              onClick={() => setCompareFriend(null)}
            >
              {t('Close comparison', 'Fermer la comparaison')}
            </button>
          </div>
        </div>
      )}
      {activeView === 'tier-list' && (
        <Suspense fallback={null}>
          <TierListPage
            destinations={destinations}
            onSelect={openDestinationOnMap}
            incomingCompareFriend={compareFriend && !compareFriendDenied ? compareFriend : null}
            incomingCompareFriendDestinations={compareFriend && !compareFriendDenied ? compareFriendDests : []}
            myProfile={profileDisplayName ? {
              displayName: profileDisplayName,
              avatarUrl: profileAvatarUrl,
              avatarBg: profileAvatarBg,
              avatarFg: profileAvatarFg,
            } : null}
          />
        </Suspense>
      )}
      {activeView === 'explore' && (
        <ExploreView
          destinations={destinations}
          onSelect={name => {
            setActiveView('map')
            selectByName(name)
          }}
        />
      )}
      <Nav
        totalDestinations={visibleDestinations.length}
        activeView={activeView}
        filters={filters}
        shareCopied={shareCopied}
        publicId={publicId}
        avatarFallbackLabel={avatarFallbackLabel}
        profileAvatarUrl={profileAvatarUrl}
        profileAvatarFallbackUrl={profileAvatarFallbackUrl}
        profileAvatarBg={profileAvatarBg}
        profileAvatarFg={profileAvatarFg}
        canShare={!!user && !!publicId}
        accountOpen={accountOpen}
        pendingFriendCount={pendingFriendCount}
        onViewChange={setActiveView}
        onAddClick={() => setAddingDestination(true)}
        onFiltersChange={setFilters}
        onSearch={selectByName}
        destinations={destinations}
        onShare={shareTierList}
        onAccountClick={() => setAccountOpen(value => !value)}
        onOpenFriends={() => setFriendsManageOpen(true)}
        onActivityFlyTo={(lat, lng, name, actor) => {
          if (actor) setViewingFriend(actor)
          setActiveView('map')
          setFlyTarget({ lat, lng, name })
        }}
        viewingFriend={viewingFriend}
        onBackToMyCarnet={() => { setViewingFriend(null); setSelectedName(null); setSelectedKey(null) }}
        isAuthenticated={!!user}
        friendshipWithViewed={friendshipWithViewed}
        addFriendFeedback={addFriendFeedback}
        onAddViewingFriend={handleAddViewingFriend}
        onCompareViewingFriend={handleCompareViewingFriend}
      />
      {friendsManageOpen && (
        <Suspense fallback={null}>
          <FriendsManagePanel
            onClose={() => setFriendsManageOpen(false)}
            onOpenAddFriend={() => { setFriendsManageOpen(false); setAddFriendOpen(true) }}
            onViewFriendCarnet={f => {
              setFriendsManageOpen(false)
              setTargetedCompare(null)
              setViewingFriend({ userId: f.otherUser, handle: f.handle, displayName: f.displayName })
              setActiveView('map')
              setSelectedName(null)
              setSelectedKey(null)
            }}
            onCompareFriend={f => {
              setFriendsManageOpen(false)
              setTargetedCompare(null)
              setCompareFriend(f)
            }}
          />
        </Suspense>
      )}
      {activeView === 'map' && selected && (
        <DestinationSheet
          destination={selected}
          coupDeCoeur={selected.coupDeCoeur ?? false}
          coupDeCoeurCount={coupDeCoeurCount}
          allDestinations={destinations}
          compareWith={activeSheetCompare
            ? {
                friend: activeSheetCompare.friend,
                mine: activeSheetCompare.mine,
                theirs: activeSheetCompare.theirs,
              }
            : undefined}
          compareMode={activeSheetCompare?.mode}
          onClose={() => {
            setSelectedName(null)
            setSelectedKey(null)
            if (targetedCompareDenied) setTargetedCompare(null)
          }}
          onFocus={focusSelected}
          onCompareFriend={friendUserId => handleTargetedCompareFriend(friendUserId, selected)}
          onExitCompare={() => {
            if (isLocalSeedCompareActive) setLocalSeedCompare(null)
            else if (activeSheetCompare?.mode === 'targeted') setTargetedCompare(null)
            else setCompareFriend(null)
          }}
          onCoupDeCoeur={() => toggleCoupDeCoeur(selected.name)}
          onEdit={dest => setEditingDestination(dest)}
          onDelete={name => removeDestination(name)}
          onOpenTrip={selectByName}
        />
      )}
      {activeView === 'map' && (
        <TierListPanel
          destinations={visibleDestinations}
          collapsed={tierListCollapsed}
          coupDeCoeurCount={coupDeCoeurCount}
          maxCoupDeCoeur={getMaxCoupDeCoeur(destinations.length)}
          dockMode={desktopDock.tierMode}
          onCollapseToggle={() => setTierListCollapsed(value => !value)}
          onFlyTo={selectByName}
          onCompareFriend={viewingFriend ? undefined : setCompareFriend}
          onMobileToggle={() => setTierListCollapsed(value => !value)}
          onViewTierList={() => setActiveView('tier-list')}
          onCompareOnTierList={() => setActiveView('tier-list')}
          onExitCompare={() => setCompareFriend(null)}
          compareFriend={compareFriend && !compareFriendDenied ? compareFriend : undefined}
          compareFriendDestinations={compareFriend && !compareFriendDenied ? compareFriendDests : undefined}
          compareFriendName={compareFriend && !compareFriendDenied ? compareFriend.displayName.split(' ')[0] : undefined}
          compareFriendAvatarUrl={compareFriend && !compareFriendDenied ? (compareFriend.avatarUrl ?? null) : null}
          compareCommonCount={compareFriend && !compareFriendDenied ? compareCommonCount : undefined}
        />
      )}
      {addingDestination && (
        <Suspense fallback={null}>
          <AddDestinationWizard
            onClose={() => setAddingDestination(false)}
            onAdd={addDestination}
            existingDestinations={destinations}
            coupDeCoeurDestinations={destinations.filter(destination => destination.coupDeCoeur)}
            onDuplicateFound={(existing, incomingName) => {
              setAddingDestination(false)
              setDuplicateConflict({
                existing,
                incoming: { ...existing, name: incomingName },
              })
            }}
          />
        </Suspense>
      )}
      {editingDestination && (
        <Suspense fallback={null}>
          <AddDestinationWizard
            onClose={() => setEditingDestination(null)}
            onAdd={addDestination}
            initialDestination={editingDestination}
            onUpdate={updateDestination}
            existingDestinations={destinations}
            coupDeCoeurDestinations={destinations.filter(destination => destination.coupDeCoeur)}
          />
        </Suspense>
      )}
      {duplicateConflict && (
        <DuplicateFoundModal
          existing={duplicateConflict.existing}
          incoming={duplicateConflict.incoming}
          onCancel={() => setDuplicateConflict(null)}
          onMerge={() => {
            setEditingDestination(duplicateConflict.existing)
            setDuplicateConflict(null)
          }}
        />
      )}
      {/* Activité récente : autrefois en bandeau fixe en bas de la map, ce qui
          chevauchait la tier list. L'aperçu vit désormais dans la sidebar
          (composant <SidebarActivity /> dans Nav.tsx) et la liste complète
          reste accessible via l'onglet "Amis". Le clic sur un ami va direct
          au carnet ami (viewingFriend) plutôt que d'ouvrir un profil modal. */}
      {addFriendOpen && (
        <Suspense fallback={null}>
          <AddFriendModal onClose={() => setAddFriendOpen(false)} />
        </Suspense>
      )}
      {accountOpen && (
        <AccountPanel
          destinations={myDestinations}
          publicId={publicId}
          mapVisibility={profileMapVisibility}
          mapDetail={mapDetail}
          onPublicIdChange={setPublicId}
          onMapVisibilityChange={onMapVisibilityChange}
          onMapDetailChange={v => { setMapDetail(v); localStorage.setItem('outpost-map-detail', v) }}
          onClose={() => setAccountOpen(false)}
          onResetCarnet={resetMyDestinations}
          carnetCount={myDestinations.length}
        />
      )}
    </div>
  )
}

function ExploreView(_props: { destinations: Destination[]; onSelect: (name: string) => void }) {
  return (
    <main className="explore-page explore-page--soon" aria-label={t('Explore — coming soon', 'Explorer — bientôt disponible')}>
      <section className="explore-soon">
        <span className="explore-soon__chip">{t('Coming soon', 'Bientôt disponible')}</span>
        <h2 className="explore-soon__title">{t('The explorer is coming soon', "L'explorateur arrive bientôt")}</h2>
        <p className="explore-soon__text">
          {t(
            "This section will suggest destinations tailored to your journal, your ratings, and those of your friends. We're working on it — see you soon.",
            "Cette section te proposera des destinations sur mesure à partir de ton carnet et de tes amis. On y travaille — rendez-vous très vite."
          )}
        </p>
      </section>
    </main>
  )
}

interface AccountPanelProps {
  destinations: Destination[]
  publicId: string
  mapVisibility: MapVisibility
  mapDetail: 'simple' | 'detailed'
  onPublicIdChange: (value: string) => void
  onMapVisibilityChange: (value: MapVisibility) => Promise<{ ok: boolean; error?: string }>
  onMapDetailChange: (value: 'simple' | 'detailed') => void
  onClose: () => void
  onResetCarnet: () => Promise<{ error?: string }>
  carnetCount: number
}

type AccountMode = 'profile' | 'map' | 'account'
type PasswordAuthMode = 'signin' | 'signup' | 'forgot' | 'forgot-sent'

function AccountPanel({ destinations, publicId, mapVisibility, mapDetail, onPublicIdChange, onMapVisibilityChange, onMapDetailChange, onClose, onResetCarnet, carnetCount }: AccountPanelProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(true)
  const { user, signInWithPassword, signUpWithPassword, signInWithGoogle, resetPassword, signOut } = useAuth()
  const { profile } = useMyProfile()
  const [draftId, setDraftId] = useState(publicId || profile?.handle || '')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<AccountMode>('profile')
  const [passwordMode, setPasswordMode] = useState<PasswordAuthMode>('signin')
  const [busy, setBusy] = useState(false)
  const [googleBusy, setGoogleBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null)
  const [savedTick, setSavedTick] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  const [visibilityDraft, setVisibilityDraft] = useState<MapVisibility>(mapVisibility)
  const [visibilityBusy, setVisibilityBusy] = useState(false)
  const [confirmResetOpen, setConfirmResetOpen] = useState(false)
  const [resetBusy, setResetBusy] = useState(false)
  const accountAvatarFallback = getAvatarFallbackLabel(profile?.displayName, profile?.handle, publicId, draftId)

  const handleConfirmReset = async () => {
    setResetBusy(true)
    const res = await onResetCarnet()
    setResetBusy(false)
    setConfirmResetOpen(false)
    if (res.error) {
      setFeedback({ kind: 'err', msg: `Échec : ${res.error}` })
    }
  }

  // Synchronise le draftId avec le handle Supabase une fois qu'il est chargé
  useEffect(() => {
    if (profile?.handle && !publicId) {
      setDraftId(profile.handle)
      onPublicIdChange(profile.handle)
    }
  }, [profile, publicId, onPublicIdChange])

  useEffect(() => {
    setVisibilityDraft(mapVisibility)
  }, [mapVisibility])

  const saveLocal = () => {
    const normalized = draftId.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    onPublicIdChange(normalized)
    setDraftId(normalized)
    setSavedTick(true)
    window.setTimeout(() => setSavedTick(false), 1800)
  }

  const submitPasswordAuth = async () => {
    const cleaned = email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
      setFeedback({ kind: 'err', msg: 'Invalid email' })
      return
    }
    if (password.length < 6) {
      setFeedback({ kind: 'err', msg: 'Password too short: use at least 6 characters.' })
      return
    }

    setBusy(true)
    const res: { error?: string; needsConfirmation?: boolean } = passwordMode === 'signin'
      ? await signInWithPassword(cleaned, password)
      : await signUpWithPassword(cleaned, password)
    setBusy(false)
    if (res.error) {
      setFeedback({ kind: 'err', msg: res.error })
      return
    }
    if (res.needsConfirmation) {
      setFeedback({
        kind: 'ok',
        msg: 'Account created. Check your inbox to confirm your email, then sign in.',
      })
      if (import.meta.env.DEV) {
        console.info('[auth] Supabase awaiting email confirmation. Disable "Confirm email" in Supabase to skip SMTP during dev.')
      }
      return
    }
    setFeedback({ kind: 'ok', msg: passwordMode === 'signin'
      ? 'Signed in.'
      : 'Account created. You can use this password to return.' })
  }

  const submitForgotPassword = async () => {
    const cleaned = email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
      setFeedback({ kind: 'err', msg: 'Invalid email' })
      return
    }
    setBusy(true)
    const res = await resetPassword(cleaned)
    setBusy(false)
    if (res.error) {
      setFeedback({ kind: 'err', msg: res.error })
      return
    }
    setPasswordMode('forgot-sent')
    setFeedback(null)
  }

  const connectWithGoogle = async () => {
    setGoogleBusy(true)
    const res = await signInWithGoogle()
    setGoogleBusy(false)
    if (res.error) setFeedback({ kind: 'err', msg: res.error })
  }

  // Fallback slug 'invite' cohérent avec le bouton "Partager" du header.
  // Comme ça l'utilisateur a toujours un lien à copier, même s'il n'a pas
  // encore défini son pseudo (l'app le lui demandera via ProfileSetupModal).
  const shareLink = `${window.location.origin}${window.location.pathname}?u=${encodeURIComponent(draftId.trim() || 'invite')}`

  const copyShareLink = async () => {
    // Feedback immédiat (cf. shareTierList ci-dessus pour la même raison).
    setLinkCopied(true)
    window.setTimeout(() => setLinkCopied(false), 1800)
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareLink)
      } else {
        throw new Error('Clipboard API unavailable')
      }
    } catch {
      console.warn('[share] clipboard unavailable, link:', shareLink)
    }
  }

  const saveVisibility = async () => {
    setVisibilityBusy(true)
    const result = await onMapVisibilityChange(visibilityDraft)
    setVisibilityBusy(false)
    if (!result.ok) {
      setFeedback({ kind: 'err', msg: result.error ?? 'Could not save visibility.' })
      return
    }
    setFeedback({ kind: 'ok', msg: 'Map visibility updated.' })
  }

  return (
    <div ref={trapRef} className="account-overlay" role="dialog" aria-modal="true" aria-label={t('Account', 'Compte')} onClick={onClose}>
      <aside className="account-panel" onClick={event => event.stopPropagation()}>
        <div className="account-panel-head">
          <div className="account-identity">
            <Avatar
              avatarUrl={profile?.avatarUrl}
              initials={accountAvatarFallback}
              bg={profile?.avatarBg ?? '#e5e5e5'}
              fg={profile?.avatarFg ?? '#1a1a1a'}
              className="account-avatar"
            />
            <div>
              <h2>{t('My account', 'Mon compte')}</h2>
              <p>{user?.email ?? (draftId ? `@${draftId}` : t('Local profile', 'Profil local'))}</p>
            </div>
          </div>
          <button className="account-close" aria-label={t('Close', 'Fermer')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>

        <SegmentedControl
          className="account-tabs"
          ariaLabel={t('Account settings', 'Paramètres du compte')}
          role="tablist"
          size="sm"
          layout="fill"
          value={mode}
          options={[
            { value: 'profile', label: t('Profile', 'Profil') },
            { value: 'map', label: t('Map', 'Carte') },
            { value: 'account', label: t('Account', 'Compte') },
          ]}
          onChange={nextMode => {
            setMode(nextMode)
            setFeedback(null)
          }}
        />

        {mode === 'profile' && (
          <div className="account-section account-section--profile">
            <TravelerProfileCard destinations={destinations} />
          </div>
        )}

        {mode === 'map' && (
          <div className="account-section">

            {/* ── Langue ── */}
            <label>{t('Interface language', 'Langue de l\'interface')}</label>
            <SegmentedControl
              className="account-auth-tabs"
              ariaLabel={t('Language', 'Langue')}
              role="radiogroup"
              size="sm"
              layout="fill"
              value={lang}
              options={[
                { value: 'en', label: 'English' },
                { value: 'fr', label: 'Français' },
              ]}
              onChange={v => setLang(v as 'en' | 'fr')}
            />

            {/* ── Détail carte ── */}
            <label style={{ marginTop: 'var(--space-5)' }}>{t('Map detail', 'Détail carte')}</label>
            <SegmentedControl
              className="account-auth-tabs"
              ariaLabel={t('Map detail level', 'Niveau de détail carte')}
              role="radiogroup"
              size="sm"
              layout="fill"
              value={mapDetail}
              options={[
                { value: 'simple', label: t('Simple', 'Simple') },
                { value: 'detailed', label: t('Detailed', 'Détaillé') },
              ]}
              onChange={v => onMapDetailChange(v as 'simple' | 'detailed')}
            />
            <p className="account-hint" style={{ marginTop: 'var(--space-2)' }}>
              <strong>{t('Simple:', 'Simple :')}</strong> {t('major country labels only.', 'grands pays uniquement.')}{' '}
              <strong>{t('Detailed:', 'Détaillé :')}</strong> {t('+ borders and city names.', '+ frontières et villes.')}
            </p>

            {/* ── Visibilité de la carte ── */}
            <div style={{ marginTop: 'var(--space-5)' }}>
              <p className="account-hint">
                {t('Control who can view your map when you share it.', 'Contrôler qui peut voir ta carte quand tu la partages.')}
              </p>
              <label>
                {t('Map visibility', 'Visibilité de la carte')}
                <select
                  value={visibilityDraft}
                  onChange={event => setVisibilityDraft(event.target.value as MapVisibility)}
                  disabled={visibilityBusy}
                >
                  <option value="public">{t('Public', 'Publique')}</option>
                  <option value="friends">{t('Friends only', 'Amis uniquement')}</option>
                  <option value="private">{t('Private', 'Privée')}</option>
                </select>
              </label>
              <p className="account-hint">
                {t('Public: anyone with the link. Friends only: only your friends. Private: only you.',
                   'Publique : tout le monde avec le lien. Amis uniquement : tes amis seulement. Privée : toi uniquement.')}
              </p>
              <div className="account-actions">
                <button
                  className="add-submit account-primary"
                  onClick={saveVisibility}
                  disabled={visibilityBusy || visibilityDraft === mapVisibility}
                >
                  {visibilityBusy ? t('Saving…', 'Enregistrement…') : t('Save visibility', 'Enregistrer la visibilité')}
                </button>
              </div>
              {feedback && mode === 'map' && (
                <p className={feedback.kind === 'ok' ? 'friends-feedback-ok' : 'friends-feedback-err'}>
                  {feedback.msg}
                </p>
              )}
            </div>

          </div>
        )}

        {mode === 'account' && (
          <div className="account-section">
            {user ? (
              <>
                <p className="account-hint">{t('Signed in as', 'Connecté en tant que')} <strong>{user.email}</strong>.</p>

                <p className="account-hint" style={{ marginTop: 16 }}>
                  {t('Your username is used for sharing and lets friends find your journal.', 'Ton pseudo sert au lien de partage et permet aux amis de retrouver ton carnet.')}
                </p>
                <label>
                  {t('Public username', 'Pseudo public')}
                  <input
                    value={draftId}
                    onChange={event => setDraftId(event.target.value)}
                    placeholder={t('your-username', 'ton-pseudo')}
                  />
                </label>
                {shareLink && (
                  <label>
                    {t('Share link', 'Lien de partage')}
                    <input readOnly value={shareLink} onClick={e => (e.target as HTMLInputElement).select()} />
                  </label>
                )}
                <div className="account-actions">
                  <button
                    className="add-submit account-primary"
                    onClick={saveLocal}
                    disabled={!draftId.trim()}
                  >
                    {savedTick ? t('Saved', 'Enregistré') : t('Save', 'Enregistrer')}
                  </button>
                  <button
                    className="account-secondary"
                    onClick={copyShareLink}
                    disabled={!shareLink}
                  >
                    {linkCopied ? t('Copied', 'Copié') : t('Copy link', 'Copier le lien')}
                  </button>
                </div>

                <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button
                    className="account-secondary account-danger"
                    onClick={async () => { await signOut(); onClose() }}
                  >
                    {t('Sign out', 'Me déconnecter')}
                  </button>
                  <button
                    className="account-secondary account-reset"
                    onClick={() => setConfirmResetOpen(true)}
                    disabled={carnetCount === 0}
                    title={carnetCount === 0 ? t('Your journal is already empty', 'Ton carnet est déjà vide') : undefined}
                  >
                    {t('Clear my journal', 'Vider mon carnet')}{carnetCount > 0 ? ` (${carnetCount})` : ''}
                  </button>
                </div>
              </>
            ) : (
              <>
                {(passwordMode === 'signin' || passwordMode === 'signup') && (
                  <>
                    <p className="account-hint">
                      {t('Sync your destinations and access your map on all your devices.', 'Synchronise tes destinations et retrouve ta carte sur tous tes appareils.')}
                    </p>
                    <button className="account-google" onClick={connectWithGoogle} disabled={googleBusy || busy}>
                      <span aria-hidden="true">G</span>
                      {googleBusy ? t('Signing in…', 'Connexion…') : t('Continue with Google', 'Continuer avec Google')}
                    </button>
                    <div className="account-divider"><span>{t('or', 'ou')}</span></div>
                    <SegmentedControl
                      className="account-auth-tabs"
                      ariaLabel={t('Sign in or sign up', 'Connexion ou inscription')}
                      role="tablist"
                      size="sm"
                      layout="fill"
                      value={passwordMode}
                      options={[
                        { value: 'signin', label: t('Sign in', 'Connexion') },
                        { value: 'signup', label: t('Sign up', 'Inscription') },
                      ]}
                      onChange={nextMode => {
                        setPasswordMode(nextMode as PasswordAuthMode)
                        setFeedback(null)
                      }}
                    />
                    <label>
                      Email
                      <input
                        type="email"
                        value={email}
                        onChange={event => setEmail(event.target.value)}
                        placeholder="you@email.com"
                        autoComplete="email"
                        autoFocus
                      />
                    </label>
                    <label>
                      {t('Password', 'Mot de passe')}
                      <input
                        type="password"
                        value={password}
                        onChange={event => setPassword(event.target.value)}
                        placeholder={t('6 characters minimum', '6 caractères minimum')}
                        autoComplete={passwordMode === 'signin' ? 'current-password' : 'new-password'}
                        onKeyDown={event => {
                          if (event.key === 'Enter') void submitPasswordAuth()
                        }}
                      />
                    </label>
                    <button className="add-submit account-primary" onClick={() => void submitPasswordAuth()} disabled={busy || googleBusy}>
                      {busy ? t('Please wait…', 'Patiente…') : passwordMode === 'signin' ? t('Sign in', 'Se connecter') : t('Sign up', "S'inscrire")}
                    </button>
                    {passwordMode === 'signin' && (
                      <button
                        type="button"
                        className="account-forgot-link"
                        onClick={() => { setPasswordMode('forgot'); setFeedback(null) }}
                      >
                        {t('Forgot password?', 'Mot de passe oublié ?')}
                      </button>
                    )}
                    {feedback && (
                      <p className={feedback.kind === 'ok' ? 'friends-feedback-ok' : 'friends-feedback-err'}>
                        {feedback.msg}
                      </p>
                    )}
                  </>
                )}

                {passwordMode === 'forgot' && (
                  <>
                    <p className="account-hint">
                      {t("Enter your email and we'll send you a link to reset your password.", "Saisis ton email et on t'envoie un lien pour réinitialiser ton mot de passe.")}
                    </p>
                    <label>
                      Email
                      <input
                        type="email"
                        value={email}
                        onChange={event => setEmail(event.target.value)}
                        placeholder="you@email.com"
                        autoComplete="email"
                        autoFocus
                        onKeyDown={event => {
                          if (event.key === 'Enter') void submitForgotPassword()
                        }}
                      />
                    </label>
                    <button className="add-submit account-primary" onClick={() => void submitForgotPassword()} disabled={busy}>
                      {busy ? t('Sending…', 'Envoi…') : t('Send reset link', 'Envoyer le lien')}
                    </button>
                    <button
                      type="button"
                      className="account-forgot-link"
                      onClick={() => { setPasswordMode('signin'); setFeedback(null) }}
                    >
                      {t('← Back to sign in', '← Retour à la connexion')}
                    </button>
                    {feedback && (
                      <p className={feedback.kind === 'ok' ? 'friends-feedback-ok' : 'friends-feedback-err'}>
                        {feedback.msg}
                      </p>
                    )}
                  </>
                )}

                {passwordMode === 'forgot-sent' && (
                  <>
                    <p className="friends-feedback-ok" style={{ marginTop: 8 }}>
                      {t("Check your inbox — we've sent a reset link to", "Vérifie ta boîte mail — on a envoyé un lien à")} <strong>{email}</strong>.
                    </p>
                    <button
                      type="button"
                      className="account-forgot-link"
                      onClick={() => { setPasswordMode('signin'); setFeedback(null) }}
                    >
                      {t('← Back to sign in', '← Retour à la connexion')}
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </aside>
      {confirmResetOpen && (
        <div
          className="duplicate-modal-backdrop"
          onClick={() => !resetBusy && setConfirmResetOpen(false)}
          role="presentation"
        >
          <div
            className="duplicate-modal account-reset-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-reset-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="duplicate-modal-body">
              <p className="duplicate-modal-eyebrow">{t('Irreversible action', 'Action irréversible')}</p>
              <h2 id="account-reset-title">{t('Clear your entire journal?', 'Vider tout ton carnet ?')}</h2>
              <p className="duplicate-modal-text">
                {t('You are about to delete', 'Tu vas supprimer')} <strong>{carnetCount} destination{carnetCount > 1 ? 's' : ''}</strong>{' '}
                {t('from your journal. Your account, username and friends are not affected. This cannot be undone.', 'de ton carnet. Ton compte, ton pseudo et tes amis ne sont pas touchés. Cette action ne peut pas être annulée.')}
              </p>
              <div className="duplicate-modal-actions">
                <button
                  className="duplicate-modal-secondary"
                  onClick={() => setConfirmResetOpen(false)}
                  disabled={resetBusy}
                >
                  {t('Cancel', 'Annuler')}
                </button>
                <button
                  className="duplicate-modal-primary account-reset-confirm"
                  onClick={handleConfirmReset}
                  disabled={resetBusy}
                >
                  {resetBusy ? t('Deleting…', 'Suppression…') : t('Yes, clear journal', 'Oui, vider le carnet')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


interface DestinationCardProps {
  destination: Destination
  coupDeCoeur: boolean
  coupDeCoeurCount: number
  totalDestinations: number
  onClose: () => void
  onFocus: () => void
  onCoupDeCoeur: () => void
  onEdit: (destination: Destination) => void
  onDelete: (name: string) => void
}

const COMPANION_LABELS: Record<NonNullable<Destination['companions']>, string> = {
  solo: 'Solo',
  couple: 'Couple',
  amis: 'Amis',
  famille: 'Famille',
  travail: 'Travail',
}

function formatEuro(value: number) {
  return `${Math.round(value).toLocaleString('fr-FR')} €`
}

function getDestinationContext(destination: Destination) {
  const meta: Array<{ icon: string; label: string }> = []
  const details: Array<{ icon: string; label: string; value: string }> = []
  const visitCount = getVisitCount(destination)

  if (destination.tripYear) {
    meta.push({ icon: 'calendar', label: String(destination.tripYear) })
  }
  if (destination.tripDays) {
    meta.push({ icon: 'clock', label: `${destination.tripDays} jour${destination.tripDays > 1 ? 's' : ''}` })
  }
  if (visitCount > 1) {
    meta.push({ icon: 'flame', label: formatVisitCountLabel(visitCount) })
  }
  if (destination.companions) {
    details.push({ icon: 'users', label: 'Avec', value: COMPANION_LABELS[destination.companions] })
  }
  if (destination.personalBudget) {
    const perDay = destination.tripDays ? destination.personalBudget / destination.tripDays : destination.personalBudget
    meta.push({
      icon: 'coins',
      label: destination.tripDays ? `~${formatEuro(perDay)}/jour` : `~${formatEuro(destination.personalBudget)}`,
    })
  }
  if (destination.tripTypes?.length) {
    details.push({ icon: 'sliders', label: 'Type', value: destination.tripTypes.map(getExperienceTagLabel).join(' · ') })
  }
  const standoutValues = destination.standoutTags?.length ? destination.standoutTags : destination.standout ? [destination.standout] : []
  if (standoutValues.length) {
    details.push({ icon: 'sparkles', label: 'Retenu', value: standoutValues.join(' · ') })
  }

  return { meta, details, hasContext: meta.length > 0 || details.length > 0 }
}

function DestinationCard({ destination, coupDeCoeur, coupDeCoeurCount, totalDestinations, onClose, onFocus, onCoupDeCoeur, onEdit, onDelete }: DestinationCardProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const context = getDestinationContext(destination)

  const criteria: Array<[string, number, string]> = []
  if (typeof destination.food === 'number') criteria.push(['Gastronomie', destination.food, 'utensils'])
  if (typeof destination.night === 'number') criteria.push(['Sorties & Vie nocturne', destination.night, 'martini'])
  if (typeof destination.culture === 'number') criteria.push(['Culture & Histoire', destination.culture, 'temple'])
  if (typeof destination.nature === 'number') criteria.push(['Nature & Paysages', destination.nature, 'mountain'])
  if (typeof destination.value === 'number') criteria.push(['Rapport qualité/prix', destination.value, 'coins'])
  if (typeof destination.ease === 'number') {
    criteria.push(['Facilité sur place', destination.ease, 'compass'])
  }

  const maxCoupDeCoeur = getMaxCoupDeCoeur(totalDestinations)
  const coupDeCoeurDisabled = !coupDeCoeur && coupDeCoeurCount >= maxCoupDeCoeur
  const tier = getDestinationTier(destination)

  const closeMenu = () => { setMenuOpen(false); setConfirmDelete(false) }

  return (
    <aside className="destination-card" aria-label={t(`Details for ${destination.name}`, `Détail de ${destination.name}`)}>
      <div className="destination-hero">
        {destination.image && (
          <HeroImage src={destination.image} />
        )}
        <div className="destination-card-actions">
          <div className="floating-kebab-wrap">
            <button
              className={`card-kebab${menuOpen ? ' is-open' : ''}`}
              aria-label="Options"
              aria-expanded={menuOpen}
              onClick={() => { setMenuOpen(v => !v); setConfirmDelete(false) }}
            >
              <Icon name="more-vertical" />
            </button>
            {menuOpen && !confirmDelete && (
              <div className="card-kebab-menu">
                <button onClick={() => { closeMenu(); onEdit(destination) }}>
                  <Icon name="edit" />
                  {t('Edit', 'Modifier')}
                </button>
                <button className="danger" onClick={() => setConfirmDelete(true)}>
                  <Icon name="trash" />
                  {t('Delete', 'Supprimer')}
                </button>
              </div>
            )}
            {menuOpen && confirmDelete && (
              <div className="card-kebab-menu card-delete-confirm">
                <p>{t('Delete', 'Supprimer')} <strong>{destination.name}</strong> ?</p>
                <div className="confirm-actions">
                  <button onClick={closeMenu}>{t('Cancel', 'Annuler')}</button>
                  <button className="danger" onClick={() => onDelete(destination.name)}>{t('Confirm', 'Confirmer')}</button>
                </div>
              </div>
            )}
          </div>
          <button className="floating-close" aria-label={t('Close details', 'Fermer le détail')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {destination.intent && (
          <span className="intent-pill destination-hero-pill">{destination.intent}</span>
        )}
      </div>
      <div className="destination-title-row">
        <span className={`tier-orb tier-${tier ? tier.toLowerCase() : 'unrated'}`}>{tier ?? '?'}</span>
        <div>
          <h2>{destination.name}, {destination.country}</h2>
          <div className="destination-pill-row">
            <button
              className={`coup-de-coeur-button${coupDeCoeur ? ' is-active' : ''}`}
              aria-label={coupDeCoeur ? t('Remove favorite', 'Retirer le coup de coeur') : coupDeCoeurDisabled ? t(`Limit reached (${maxCoupDeCoeur}/${maxCoupDeCoeur})`, `Limite atteinte (${maxCoupDeCoeur}/${maxCoupDeCoeur})`) : t(`Favorite · ${coupDeCoeurCount}/${maxCoupDeCoeur} used`, `Coup de coeur · ${coupDeCoeurCount}/${maxCoupDeCoeur} utilise`)}
              title={coupDeCoeur ? t('Favorite · remove', 'Coup de coeur · retirer') : coupDeCoeurDisabled ? t(`${maxCoupDeCoeur} favorites already used`, `${maxCoupDeCoeur} coups de coeur deja utilises`) : t(`Favorite · ${coupDeCoeurCount}/${maxCoupDeCoeur} used`, `Coup de coeur · ${coupDeCoeurCount}/${maxCoupDeCoeur} utilise`)}
              disabled={coupDeCoeurDisabled}
              onClick={onCoupDeCoeur}
            >
              <Icon name="heart" />
              {t('Favorite', 'Coup de coeur')}
            </button>
          </div>
        </div>
        {/*
          className={`coup-de-coeur-button${coupDeCoeur ? ' is-active' : ''}`}
          aria-label={coupDeCoeur ? 'Retirer le coup de cœur' : coupDeCoeurDisabled ? 'Limite atteinte (2/2)' : `Coup de cœur · ${coupDeCoeurCount}/2 utilisé`}
          title={coupDeCoeur ? 'Coup de cœur · retirer' : coupDeCoeurDisabled ? '2 coups de cœur déjà utilisés' : `Coup de cœur · ${coupDeCoeurCount}/2 utilisé`}
          disabled={coupDeCoeurDisabled}
          onClick={onCoupDeCoeur}
        >
          <Icon name="heart" />
        */}
      </div>
      {context.hasContext && (
        <div className="destination-context" aria-label={t('Trip context', 'Contexte du voyage')}>
          {context.meta.length > 0 && (
            <div className="destination-context-meta">
              {context.meta.map(item => (
                <span key={`${item.icon}-${item.label}`}>
                  <Icon name={item.icon} />
                  {item.label}
                </span>
              ))}
            </div>
          )}
          {context.details.length > 0 && (
            <div className="destination-context-details">
              {context.details.map(item => (
                <div key={`${item.icon}-${item.label}`}>
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <h3>{t('Scores by criterion', 'Notes par critère')}</h3>
      <div className="criteria-list">
        {criteria.map(([label, value, icon]) => (
          <div className="criterion" key={label}>
            <Icon name={icon} />
            <span>{label}</span>
            <strong>{Number(value).toFixed(1).replace('.', t('.', ','))}</strong>
          </div>
        ))}
      </div>
      <button className="map-button" onClick={onFocus}>
        <Icon name="map" />
        Voir sur la carte
      </button>
    </aside>
  )
}
