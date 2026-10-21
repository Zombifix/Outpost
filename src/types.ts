export type Tier = 'S' | 'A' | 'B' | 'C' | 'D'

export type ReturnIntent = 'tomorrow' | 'someday' | 'once'

export type Intent =
  | 'city-trip'
  | 'tourisme'
  | 'sorties'
  | 'gastro'
  | 'nature'
  | 'travail'

export interface RoadTripStop {
  name: string
  lat: number
  lng: number
  type?: 'stage' | 'passage'
}

export type DestinationImageSource = 'unsplash' | 'pexels' | 'wikivoyage' | 'wikipedia' | 'wikimedia' | 'fallback'
export type MapVisibility = 'public' | 'friends' | 'private'

export interface Destination {
  destinationKey?: string
  name: string
  country: string
  lat: number
  lng: number
  tier?: Tier
  kind?: 'place' | 'zone' | 'stop' | 'stage'
  tripName?: string
  extent?: [number, number, number, number]
  geojson?: GeoJSON.Geometry
  state?: string
  osmValue?: string
  osmId?: number
  osmType?: 'N' | 'W' | 'R' | 'node' | 'way' | 'relation'
  countryCode?: string
  image?: string
  imageProvider?: DestinationImageSource
  imageAuthor?: string
  imageSourceUrl?: string
  imageQuery?: string
  imageSearchVersion?: number
  score?: number
  notes?: number
  summary?: string
  stops?: RoadTripStop[]
  visitCount?: number
  tripYear?: number
  tripDays?: number
  companions?: 'solo' | 'couple' | 'amis' | 'famille' | 'travail'
  personalBudget?: number
  tripTypes?: string[]
  standout?: string
  standoutTags?: string[]
  food?: number
  night?: number
  culture?: number
  nature?: number
  value?: number
  ease?: number
  memorability?: number // legacy: conserved for rollback, no longer used by product scoring/UI
  vibeBoost?: number
  retourBonus?: number
  /** Notation v2 : « Et toi, tu y retournerais ? » */
  returnIntent?: ReturnIntent
  /** Notation v2 : « Ce que tu retiens », 80 caractères au plus */
  memoryNote?: string
  /** Notation v2 : correction manuelle d'un cran (-1, 0, 1) */
  tierAdjust?: number
  intent: Intent
  coupDeCoeur?: boolean
  livedThere?: boolean
}

// Identité publique d'un utilisateur Outpost (cf. table public_profiles)
export interface PublicProfile {
  userId: string
  handle: string
  displayName: string
  avatarBg: string
  avatarFg: string
  avatarUrl?: string
  bio?: string
  mapVisibility: MapVisibility
}

export type FriendshipStatus = 'pending' | 'accepted' | 'blocked'

// Une amitié vue de mon côté (cf. RPC my_friendships)
export interface Friendship {
  otherUser: string
  handle: string
  displayName: string
  avatarBg: string
  avatarFg: string
  avatarUrl?: string
  status: FriendshipStatus
  /** 'me' si c'est moi qui ai initié la demande, 'them' si c'est l'autre */
  initiator: 'me' | 'them'
  createdAt: string
  acceptedAt?: string
}

export type ActivityKind =
  | 'destination_added'
  | 'tier_changed'
  | 'coup_de_coeur_set'
  | 'roadtrip_created'
  | 'roadtrip_stop_added'
  | 'friendship_accepted'
  | 'reaction_received'
  | 'mutual_destination'
  | 'milestone'

export interface ActivityEvent {
  id: string
  actor: string
  kind: ActivityKind
  payload: Record<string, unknown>
  createdAt: string
}

/** @deprecated — utilise Friendship + PublicProfile. Conservé temporairement pour les composants legacy. */
export interface Friend {
  initials: string
  name: string
  color: string
  bg: string
  count: number
  avatarUrl?: string
}

/** @deprecated — utilise ActivityEvent. */
export interface FeedItem {
  friend: string
  dest: string
  flag: string
  tier: Tier
  time: string
  lat: number
  lng: number
}

export interface NewDestinationForm {
  name: string
  intent: Intent
  food?: number
  night?: number
  culture?: number
  nature?: number
  value?: number
  ease?: number
  memorability?: number
}
