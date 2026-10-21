import { useEffect, useMemo, useRef, useState } from 'react'
import type { Destination, Friend, Friendship, Intent, Tier } from '../types'

interface MyProfileInfo {
  displayName?: string | null
  avatarUrl?: string | null
  avatarBg?: string
  avatarFg?: string
}
import {
  FRIENDS,
  FRIEND_DESTINATIONS,
  TIER_COLORS,
  UNRATED_COLORS,
  TIER_ORDER,
} from '../data'
import { FAKE_FRIENDS_MODE, getFakeFriendDestinations } from '../hooks/_fakeFriends'
import { useFriends } from '../hooks/useFriends'
import { useFriendDestinations } from '../hooks/useFriendDestinations'
import { destinationNameKey, destinationNameSet, destinationCommunityKey } from '../utils/destinationIdentity'
import { useCommunityRatings, type CommunityRating } from '../hooks/useCommunityRatings'
import { computeTravelerProfile, getDestinationScore, getDestinationTier, scoreToTier } from '../utils'
import { Avatar } from './Avatar'
import { SegmentedControl } from './SegmentedControl'
import { Icon } from './Icon'
import FriendCompareView from './friends/FriendCompareView'
import { TravelerProfileStrip } from './TravelerProfileCard'
import { CommunityBadge } from './CommunityBadge'
import { CommunityLeaderboard } from './CommunityLeaderboard'
import { t } from '../i18n'

interface TierListPageProps {
  destinations: Destination[]
  onSelect: (name: string) => void
  incomingCompareFriend?: Friendship | null
  incomingCompareFriendDestinations?: Destination[]
  myProfile?: MyProfileInfo | null
}

type TierListFilter =
  | 'all' | 'recent' | 'favorites' | 'friends' | 'solo'
  | 'versus' | 'friend-only' | 'mine-only'
  | 'shared' | 'disagreements'

const BASE_TIER_FILTERS: TierListFilter[] = ['all', 'recent', 'favorites', 'friends', 'solo']
const COMPARE_TIER_FILTERS: TierListFilter[] = ['versus', 'friend-only', 'mine-only']

const TIER_FILTER_LABEL: Record<TierListFilter, string> = {
  all: t('All', 'Toutes'),
  recent: t('Recent', 'Récents'),
  favorites: t('Favorites', 'Coups de cœur'),
  friends: t('With friends', 'Entre amis'),
  solo: t('Solo', 'Solo'),
  versus: t('Tier list versus', 'Tier list versus'),
  'friend-only': t('Their tier list', 'Sa tier list'),
  'mine-only': t('My tier list', 'Ma tier list'),
  shared: t('Both seen', 'Vus tous les deux'),
  disagreements: t('Disagreements', 'Avis opposés'),
}

const INTENT_LABEL: Record<Intent, string> = {
  tourisme: t('Tourism', 'Tourisme'),
  sorties: t('Nightlife', 'Sorties'),
  gastro: t('Food & Gastronomy', 'Gastronomie'),
  nature: t('Nature', 'Nature'),
  travail: t('Work', 'Travail'),
  'city-trip': t('City trip', 'City-trip'),
}

const INTENT_EMOJI: Record<Intent, string> = {
  tourisme: '🗺',
  sorties: '🌙',
  gastro: '🍽',
  nature: '🌿',
  travail: '💼',
  'city-trip': '🏙',
}

const COMPANION_LABEL: Record<NonNullable<Destination['companions']>, string> = {
  solo: 'Solo',
  couple: 'Couple',
  amis: t('Friends', 'Amis'),
  famille: t('Family', 'Famille'),
  travail: 'Work',
}

const COMPANION_EMOJI: Record<NonNullable<Destination['companions']>, string> = {
  solo: '🧭',
  couple: '💞',
  amis: '👥',
  famille: '🏡',
  travail: '💼',
}

const TIER_RANK: Record<Tier, number> = { S: 5, A: 4, B: 3, C: 2, D: 1 }

const COUNTRY_CODE_MAP: Record<string, string> = {
  'Japon': 'jp', 'Portugal': 'pt', 'Espagne': 'es', 'France': 'fr',
  'Italie': 'it', 'Canada': 'ca', 'Brésil': 'br', 'Mexique': 'mx',
  'Indonésie': 'id', 'Indonesie': 'id', 'Thaïlande': 'th', 'Maroc': 'ma',
  'Islande': 'is', 'Afrique du Sud': 'za', 'Nouvelle-Zélande': 'nz',
  'Nouvelle-Zelande': 'nz', 'Émirats arabes unis': 'ae', 'Emirats arabes unis': 'ae',
  'Singapour': 'sg', 'Corée du Sud': 'kr', 'Coree du Sud': 'kr',
  'Taïwan': 'tw', 'Taiwan': 'tw', 'Vietnam': 'vn', 'Pologne': 'pl',
  'Allemagne': 'de', 'Belgique': 'be', 'Pays-Bas': 'nl', 'Irlande': 'ie',
  'Royaume-Uni': 'gb', 'Royaume-Uni (Écosse)': 'gb', 'Royaume-Uni (UK)': 'gb',
}

function getCountryFlag(destination: Destination): string | undefined {
  const code = destination.countryCode ?? COUNTRY_CODE_MAP[destination.country]
  if (!code) return undefined
  return `https://flagcdn.com/24x18/${code.toLowerCase()}.png`
}

function getAvgScore(destinations: Destination[]): number | null {
  const ranked = destinations.filter(d => d.kind !== 'stop' && getDestinationTier(d) !== null)
  if (!ranked.length) return null
  return ranked.reduce((sum, d) => sum + getDestinationScore(d), 0) / ranked.length
}

const DEMO_FRIEND_DESTINATIONS: Record<string, Destination[]> = {
  AS: (FRIEND_DESTINATIONS.AS ?? []).map(destination => ({
    ...destination,
    tier: destination.name === 'Kyoto'
      ? 'A'
      : destination.name === 'Lisbonne'
        ? 'S'
        : destination.name === 'Barcelone'
          ? 'B'
          : destination.tier,
    coupDeCoeur: destination.name === 'Lisbonne' || destination.name === 'Bali',
    personalBudget: destination.personalBudget ?? {
      Kyoto: 520,
      Bali: 390,
      Lisbonne: 320,
      Barcelone: 540,
      Bangkok: 280,
      'Le Cap': 610,
      Vancouver: 760,
    }[destination.name],
    tripDays: destination.tripDays ?? {
      Kyoto: 7,
      Bali: 8,
      Lisbonne: 4,
      Barcelone: 3,
      Bangkok: 5,
      'Le Cap': 6,
      Vancouver: 5,
    }[destination.name],
    companions: destination.companions ?? (destination.name === 'Lisbonne' ? 'couple' : 'amis'),
  })),
  LM: (FRIEND_DESTINATIONS.LM ?? []).map(destination => ({
    ...destination,
    tier: destination.name === 'Bangkok'
      ? 'A'
      : destination.name === 'Dubai'
        ? 'D'
        : destination.tier,
    coupDeCoeur: destination.name === 'Le Cap' || destination.name === 'Mexico',
    personalBudget: destination.personalBudget ?? 420,
    tripDays: destination.tripDays ?? 5,
    companions: destination.companions ?? 'solo',
  })),
  JB: (FRIEND_DESTINATIONS.JB ?? []).map(destination => ({
    ...destination,
    tier: destination.name === 'Rio de Janeiro'
      ? 'A'
      : destination.name === 'New York'
        ? 'C'
        : destination.tier,
    coupDeCoeur: destination.name === 'Bangkok' || destination.name === 'Rio de Janeiro',
    personalBudget: destination.personalBudget ?? 680,
    tripDays: destination.tripDays ?? 6,
    companions: destination.companions ?? 'amis',
  })),
}

const TIER_DESCRIPTIONS: Record<Tier, string> = {
  S: t("Favorites you'd send anyone to.", "Des coups de cœur où tu enverrais n'importe qui."),
  A: t("Places you'd tell a friend to go for.", "Des endroits où tu dirais à un ami de foncer."),
  B: t("Worth it, without getting carried away.", "Ça vaut le coup, sans s'emballer."),
  C: t("Meh, there's better out there.", "Bof, il y a mieux ailleurs."),
  D: t("Not your thing, you'd tell people to skip it.", "Pas pour toi, tu le déconseilles."),
}

const TIER_LABEL: Record<Tier, string> = {
  S: t('Gem', 'Pépite'),
  A: t('Great', 'Génial'),
  B: t('Nice', 'Sympa'),
  C: t('Mixed', 'Mitigé'),
  D: t('Not for me', 'Pas pour moi'),
}

// Groupe « À noter » : destinations sans tier (notation v2, cf. docs/notation-v2.md).
const UNRATED_LABEL = t('To rate', 'À noter')
const UNRATED_DESCRIPTION = t('Not rated yet. Open one to rate it.', 'Pas encore notées. Ouvre-en une pour la noter.')

function tierKey(tier: Tier | null) {
  return tier ? tier.toLowerCase() : 'unrated'
}

function tierColors(tier: Tier | null) {
  return tier ? TIER_COLORS[tier] : UNRATED_COLORS
}

function filterDestinations(list: Destination[], filter: TierListFilter, compareList: Destination[] = []): Destination[] {
  const compareByName = new Map(compareList.map(destination => [destinationNameKey(destination), destination]))
  const currentYear = new Date().getFullYear()

  const filtered = list.filter(destination => {
    if (filter === 'recent') return Boolean(destination.tripYear && destination.tripYear >= currentYear - 2)
    if (filter === 'favorites') return Boolean(destination.coupDeCoeur)
    if (filter === 'friends') return destination.companions === 'amis'
    if (filter === 'solo') return destination.companions === 'solo'
    if (filter === 'shared') return compareByName.has(destinationNameKey(destination))
    if (filter === 'disagreements') {
      const theirs = compareByName.get(destinationNameKey(destination))
      return Boolean(theirs && getDestinationTier(theirs) !== getDestinationTier(destination))
    }
    return true
  })

  if (filter === 'disagreements') {
    const tiersCache = new Map(
      [...filtered, ...compareList].map(d => [destinationNameKey(d), getDestinationTier(d)])
    )
    return filtered.sort((a, b) => {
      const aTier = tiersCache.get(destinationNameKey(a)) ?? 'B'
      const bTier = tiersCache.get(destinationNameKey(b)) ?? 'B'
      const aCompare = compareByName.get(destinationNameKey(a))
      const bCompare = compareByName.get(destinationNameKey(b))
      const aCompareTier = aCompare ? (tiersCache.get(destinationNameKey(aCompare)) ?? aTier) : aTier
      const bCompareTier = bCompare ? (tiersCache.get(destinationNameKey(bCompare)) ?? bTier) : bTier
      return Math.abs(TIER_RANK[bTier] - TIER_RANK[bCompareTier]) - Math.abs(TIER_RANK[aTier] - TIER_RANK[aCompareTier])
    })
  }

  return filtered.sort((a, b) => {
    if (filter === 'recent') return (b.tripYear ?? 0) - (a.tripYear ?? 0)
    if (filter === 'favorites') return Number(Boolean(b.coupDeCoeur)) - Number(Boolean(a.coupDeCoeur))
    return 0
  })
}

function DestRow({
  myDest,
  friendDest,
  friendName,
  isShared,
  isCompareMode,
  communityRating,
  onSelect,
}: {
  myDest: Destination
  friendDest?: Destination | null
  friendName?: string
  isShared?: boolean
  isCompareMode?: boolean
  communityRating?: CommunityRating | null
  onSelect?: (destination: Destination) => void
}) {
  const isCoupDeCoeur = Boolean(myDest.coupDeCoeur)
  const myScore = getDestinationScore(myDest)
  const friendScore = friendDest && getDestinationTier(friendDest) ? getDestinationScore(friendDest) : null
  const flagUrl = getCountryFlag(myDest)
  const tier = getDestinationTier(myDest)
  const colors = tierColors(tier)
  const myScoreLabel = tier ? myScore.toFixed(1) : '–'
  const intentEmoji = INTENT_EMOJI[myDest.intent]
  const intentLabel = INTENT_LABEL[myDest.intent]

  return (
    <article className={`dest-row${isCoupDeCoeur ? ' is-coup-de-coeur' : ''}`}>
      <button
        type="button"
        className="dest-row-btn"
        onClick={() => onSelect?.(myDest)}
        aria-label={`Voir ${myDest.name}`}
      >
        <div
          className="dest-row-thumb"
          style={myDest.image ? { backgroundImage: `url(${myDest.image})` } as React.CSSProperties : undefined}
          aria-hidden="true"
        >
          {!myDest.image && <span className="dest-row-thumb-placeholder">{myDest.name[0]}</span>}
        </div>
        <div className="dest-row-info">
          <span className="dest-row-name">{myDest.name}</span>
          <span className="dest-row-country">
            {flagUrl && <img src={flagUrl} alt="" className="dest-row-flag" loading="lazy" />}
            {myDest.country}
          </span>
        </div>
        <div className="dest-row-signals" aria-label={intentLabel}>
          <span className="dest-row-signal dest-row-signal--intent" title={intentLabel} aria-hidden="true">
            <span>{intentEmoji}</span>
            <span className="dest-row-signal-label">{intentLabel}</span>
          </span>
          {isCoupDeCoeur && (
            <span className="dest-row-signal dest-row-signal--heart" aria-label={t('Favorite', 'Coup de cœur')}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
                <path d="M20.8 4.6a5.4 5.4 0 0 0-7.7 0L12 5.7l-1.1-1.1a5.4 5.4 0 0 0-7.7 7.7L12 21l8.8-8.7a5.4 5.4 0 0 0 0-7.7Z" />
              </svg>
            </span>
          )}
          {isCompareMode && myDest.companions && (
            <span className="dest-row-chip" aria-hidden="true">
              {COMPANION_EMOJI[myDest.companions]} {COMPANION_LABEL[myDest.companions]}
            </span>
          )}
          {isCompareMode && myDest.tripDays && (
            <span className="dest-row-chip" aria-hidden="true">
              {myDest.tripDays}j
            </span>
          )}
          {isShared && (
            <span className="dest-row-signal dest-row-signal--shared" aria-label={t('Shared destination', 'Destination en commun')}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                <circle cx="9" cy="7" r="3" /><circle cx="15" cy="7" r="3" />
                <path d="M3 21c0-3.31 2.69-6 6-6h6c3.31 0 6 2.69 6 6" />
              </svg>
            </span>
          )}
          {/* La note du peuple n'apparaît que quand elle raconte quelque chose :
              un désaccord d'au moins un tier avec ma propre note. */}
          {tier && communityRating && Math.abs(TIER_RANK[tier] - TIER_RANK[communityRating.tier]) >= 1 && (
            <CommunityBadge rating={communityRating} myTier={tier} />
          )}
        </div>
        <div className={`dest-row-scores${friendDest !== undefined ? ' dest-row-scores--versus' : ''}`}>
          {friendDest !== undefined ? (
            <>
              <span className="dest-score-stacked-me" style={{ color: colors.pin } as React.CSSProperties}>
                {myScoreLabel}
              </span>
              <span className="dest-score-stacked-friend">
                {friendScore !== null ? friendScore.toFixed(1) : '–'}
              </span>
            </>
          ) : (
            <span className="dest-score-pill dest-score-pill--solo" style={{ borderColor: `${colors.pin}44` } as React.CSSProperties}>
              {myScoreLabel}
            </span>
          )}
        </div>
      </button>
    </article>
  )
}

function ComparisonBanner({
  friend,
  myProfile,
  myDests,
  friendDests,
  friendOnlyCount,
  onClose,
}: {
  friend: Friend
  myProfile?: MyProfileInfo | null
  myDests: Destination[]
  friendDests: Destination[]
  friendOnlyCount: number
  onClose: () => void
}) {
  const myMap = new Map(myDests.map(d => [destinationNameKey(d), d]))
  const sharedCount = friendDests.filter(d => myMap.has(destinationNameKey(d))).length
  const myAvg = getAvgScore(myDests)
  const friendAvg = getAvgScore(friendDests)
  const friendFirstName = friend.name.split(' ')[0]
  const myName = myProfile?.displayName?.split(' ')[0] ?? t('Me', 'Moi')
  const myInitials = myProfile?.displayName?.trim().slice(0, 2).toUpperCase() ?? 'M'

  return (
    <div className="compare-banner">
      <div className="compare-banner-player compare-banner-player--me">
        <Avatar
          avatarUrl={myProfile?.avatarUrl}
          initials={myInitials}
          bg={myProfile?.avatarBg ?? 'var(--purple)'}
          fg={myProfile?.avatarFg ?? '#ffffff'}
          className="compare-banner-avatar"
          ariaHidden={true}
        />
        <div className="compare-banner-copy">
          <div className="compare-banner-identity">
            <span className="compare-banner-name">{myName}</span>
          </div>
          {myAvg !== null && (
            <span className="compare-banner-score-block">
              <span className="compare-banner-score">{myAvg.toFixed(1)}</span>
              <span className="compare-banner-score-label">{t('Overall average', 'Moyenne générale')}</span>
            </span>
          )}
        </div>
      </div>

      <div className="compare-banner-center">
        <span className="compare-banner-center-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 4v16" />
            <path d="M16 4v16" />
            <path d="M4 8h4" />
            <path d="M4 16h4" />
            <path d="M16 8h4" />
            <path d="M16 16h4" />
          </svg>
        </span>
        <span className="compare-banner-vs" aria-hidden="true">VS</span>
        <span className="compare-banner-stat">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="9" cy="7" r="3" /><circle cx="15" cy="7" r="3" />
            <path d="M3 21c0-3.31 2.69-6 6-6h6c3.31 0 6 2.69 6 6" />
          </svg>
          {sharedCount} {t('shared', 'en commun')}
        </span>
        {friendOnlyCount > 0 && (
          <span className="compare-banner-stat">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M5 12h14M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {friendOnlyCount} {t('unique to', 'uniques à')} {friendFirstName}
          </span>
        )}
      </div>

      <div className="compare-banner-player compare-banner-player--friend">
        <div className="compare-banner-copy compare-banner-copy--right">
          <div className="compare-banner-identity compare-banner-identity--right">
            <span className="compare-banner-name">{friendFirstName}</span>
          </div>
          {friendAvg !== null && (
            <span className="compare-banner-score-block">
              <span className="compare-banner-score">{friendAvg.toFixed(1)}</span>
              <span className="compare-banner-score-label">{t('Overall average', 'Moyenne générale')}</span>
            </span>
          )}
        </div>
        <Avatar
          avatarUrl={friend.avatarUrl}
          initials={friend.initials}
          bg={friend.bg}
          fg={friend.color}
          className="compare-banner-avatar"
          ariaHidden={true}
        />
      </div>

      {/* Profils voyageurs face à face, dans la bannière — visibles d'office.
          Mon strip est masqué sur mobile via CSS (il vit déjà dans mon compte). */}
      {(myDests.length > 0 || friendDests.length > 0) && (
        <div className="compare-banner-profiles">
          <div className="compare-banner-profiles-slot compare-banner-profiles-slot--me">
            <TravelerProfileStrip destinations={myDests} />
          </div>
          <div className="compare-banner-profiles-slot">
            <TravelerProfileStrip destinations={friendDests} align="right" />
          </div>
        </div>
      )}
    </div>
  )
}

function DestinationPreview({
  destination,
  ownerLabel,
  ownerColor,
  onClose,
  onOpenMap,
}: {
  destination: Destination
  ownerLabel: string
  ownerColor?: string
  onClose: () => void
  onOpenMap: (name: string) => void
}) {
  const stats = getPreviewStats(destination)
  const tier = getDestinationTier(destination)

  return (
    <aside className="tier-destination-preview" aria-label={`Apercu de ${destination.name}`}>
      <div
        className="tier-destination-preview-image"
        style={{ backgroundImage: destination.image ? `url(${destination.image})` : undefined }}
      >
        <span className="tier-preview-owner" style={ownerColor ? { '--owner-color': ownerColor } as React.CSSProperties : undefined}>
          {ownerLabel}
        </span>
      </div>
      <div className="tier-destination-preview-body">
        <button className="tier-destination-preview-close" onClick={onClose} aria-label={t('Close preview', 'Fermer l\'aperçu')}>×</button>
        <div className="tier-preview-heading">
          <span className={`tier-orb tier-${tier ? tier.toLowerCase() : 'unrated'}`}>{tier ?? '?'}</span>
          {destination.coupDeCoeur && <span className="tier-preview-favorite">♥ Favorite</span>}
        </div>
        <h3>{destination.name}, {destination.country}</h3>
        {destination.summary && <p>{destination.summary}</p>}
        <dl className="tier-preview-stats">
          {stats.map(item => (
            <div key={item.label}>
              <dt><span aria-hidden="true">{item.icon}</span>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
        {destination.standout && (
          <div className="tier-preview-note">
            <span>{t('✨ Highlight', '✨ Point fort')}</span>
            <strong>{destination.standout}</strong>
          </div>
        )}
        <button className="tier-preview-map-button" onClick={() => onOpenMap(destination.name)}>
          See on map
        </button>
      </div>
    </aside>
  )
}

function TierRow({
  tier,
  myDests,
  friendDests,
  friend,
  sharedNames,
  collapsed,
  isCompareMode,
  communityRatings,
  onToggle,
  onSelectMine,
}: {
  tier: Tier | null
  myDests: Destination[]
  friendDests: Destination[]
  friend: Friend | null
  sharedNames: Set<string>
  collapsed: boolean
  isCompareMode?: boolean
  communityRatings?: Map<string, CommunityRating>
  onToggle: () => void
  onSelectMine: (destination: Destination) => void
}) {
  const colors = tierColors(tier)
  const mine = useMemo(() =>
    myDests
      .filter(d => getDestinationTier(d) === tier && d.kind !== 'stop')
      .sort((a, b) => getDestinationScore(b) - getDestinationScore(a) || a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })),
    [myDests, tier]
  )
  const friendLookup = useMemo(() =>
    new Map(
      friendDests
        .filter(d => d.kind !== 'stop')
        .map(d => [destinationNameKey(d), d])
    ),
    [friendDests]
  )
  const count = String(mine.length)

  return (
    <article className={`tier-list-row tier-list-row-${tierKey(tier)}`}>
      <header onClick={onToggle}>
        <span
          className={`tier-orb tier-${tierKey(tier)}`}
          style={{ boxShadow: `0 6px 16px ${colors.pin}33` }}
        >
          {tier ?? '?'}
        </span>
        <div className="tier-row-label-group">
          <strong style={{ color: colors.label }}>{tier ? TIER_LABEL[tier] : UNRATED_LABEL}</strong>
          <span className="tier-row-description">{tier ? TIER_DESCRIPTIONS[tier] : UNRATED_DESCRIPTION}</span>
        </div>
        <div className="tier-row-right">
          <span className="tier-row-count">{count}</span>
          <svg
            className={`tier-row-chevron ${collapsed ? '' : 'is-open'}`}
            width="16" height="16" viewBox="0 0 16 16" fill="none"
          >
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </header>

      {!collapsed && (
        <div className="tier-row-body">
          <div className="tier-list-row-strip">
            {(() => {
              const rows = mine.map(d => ({
                my: d,
                their: friend ? (friendLookup.get(destinationNameKey(d)) ?? null) : null,
                isShared: sharedNames.has(destinationNameKey(d)),
              }))
              if (rows.length === 0) return <span className="tier-list-empty">{t('No destinations', 'Aucune destination')}</span>
              return rows.map(({ my, their, isShared: shared }) => (
                <DestRow
                  key={destinationNameKey(my)}
                  myDest={my}
                  friendDest={friend ? their : undefined}
                  friendName={friend?.name.split(' ')[0]}
                  isShared={shared}
                  isCompareMode={isCompareMode}
                  communityRating={communityRatings?.get(destinationCommunityKey(my)) ?? null}
                  onSelect={onSelectMine}
                />
              ))
            })()}
          </div>
        </div>
      )}
    </article>
  )
}

function DesktopTierCard({
  destination,
  onSelect,
}: {
  destination: Destination
  onSelect: (destination: Destination) => void
}) {
  const isCoupDeCoeur = Boolean(destination.coupDeCoeur)
  const score = getDestinationScore(destination)
  const flagUrl = getCountryFlag(destination)
  const tier = getDestinationTier(destination)
  const colors = tier ? TIER_COLORS[tier] : UNRATED_COLORS

  return (
    <article className={`tier-desktop-destination${isCoupDeCoeur ? ' is-coup-de-coeur' : ''}`}>
      <button
        type="button"
        className="tier-desktop-destination-btn"
        onClick={() => onSelect(destination)}
        aria-label={`Voir ${destination.name}`}
      >
        <div
          className="tier-desktop-destination-thumb"
          style={destination.image ? { backgroundImage: `url(${destination.image})` } as React.CSSProperties : undefined}
          aria-hidden="true"
        >
          {!destination.image && <span className="tier-desktop-destination-thumb-placeholder">{destination.name[0]}</span>}
        </div>
        <div className="tier-desktop-destination-copy">
          <span className="tier-desktop-destination-name">{destination.name}</span>
          <span className="tier-desktop-destination-country">
            {flagUrl && <img src={flagUrl} alt="" className="tier-desktop-destination-flag" loading="lazy" />}
            {destination.country}
          </span>
        </div>
        <div className="tier-desktop-destination-meta">
          {isCoupDeCoeur && (
            <span className="tier-desktop-destination-heart" aria-label={t('Favorite', 'Coup de coeur')}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
                <path d="M20.8 4.6a5.4 5.4 0 0 0-7.7 0L12 5.7l-1.1-1.1a5.4 5.4 0 0 0-7.7 7.7L12 21l8.8-8.7a5.4 5.4 0 0 0 0-7.7Z" />
              </svg>
            </span>
          )}
          <span
            className="tier-desktop-destination-score"
            style={{ color: colors.pin, borderColor: `${colors.pin}26` } as React.CSSProperties}
          >
            {score.toFixed(1)}
          </span>
        </div>
      </button>
    </article>
  )
}

function DesktopTierColumn({
  tier,
  destinations,
  onSelect,
}: {
  tier: Tier | null
  destinations: Destination[]
  onSelect: (destination: Destination) => void
}) {
  const colors = tierColors(tier)
  const sortedDestinations = useMemo(() =>
    destinations
      .filter(d => d.kind !== 'stop' && getDestinationTier(d) === tier)
      .sort((a, b) => getDestinationScore(b) - getDestinationScore(a) || a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })),
    [destinations, tier]
  )

  return (
    <article className={`tier-desktop-column tier-desktop-column--${tierKey(tier)}`}>
      <header className="tier-desktop-column-header">
        <div className="tier-desktop-column-heading">
          <span
            className={`tier-orb tier-${tierKey(tier)} tier-desktop-column-orb`}
            style={{ boxShadow: `0 8px 18px ${colors.pin}33` }}
          >
            {tier ?? '?'}
          </span>
          <div className="tier-desktop-column-copy">
            <strong style={{ color: colors.label }}>{tier ? TIER_LABEL[tier] : UNRATED_LABEL}</strong>
            <span>{tier ? TIER_DESCRIPTIONS[tier] : UNRATED_DESCRIPTION}</span>
          </div>
        </div>
        <span className="tier-desktop-column-count">{sortedDestinations.length}</span>
      </header>

      <div className="tier-desktop-column-list">
        {sortedDestinations.length > 0 ? (
          sortedDestinations.map(destination => (
            <DesktopTierCard
              key={destinationNameKey(destination)}
              destination={destination}
              onSelect={onSelect}
            />
          ))
        ) : (
          <p className="tier-desktop-column-empty">{t('No destinations', 'Aucune destination')}</p>
        )}
      </div>
    </article>
  )
}

export default function TierListPage({
  destinations,
  onSelect,
  incomingCompareFriend = null,
  incomingCompareFriendDestinations = [],
  myProfile,
}: TierListPageProps) {
  const [friend, setFriend] = useState<Friend | null>(null)
  const [friendUserId, setFriendUserId] = useState<string | null>(null)
  // 'personal' = mon classement (avec compare) ; 'global' = classement du peuple.
  const [pageMode, setPageMode] = useState<'personal' | 'global'>('personal')
  const [filter, setFilter] = useState<TierListFilter>('all')
  const [collapsed, setCollapsed] = useState<Record<Tier, boolean>>({ S: false, A: false, B: true, C: true, D: true })
  const [unratedCollapsed, setUnratedCollapsed] = useState(false)
  const [comparePicker, setComparePicker] = useState(false)
  const [preview, setPreview] = useState<{ destination: Destination; ownerLabel: string; ownerColor?: string } | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const { accepted: realFriends } = useFriends()
  const {
    destinations: realFriendDests,
    access: realFriendAccess,
  } = useFriendDestinations(friendUserId)

  function openPreview(destination: Destination, ownerLabel: string, ownerColor?: string) {
    setPreview({ destination, ownerLabel, ownerColor })
  }

  function closePreview() {
    setPreview(null)
  }

  function handlePageModeChange(nextMode: 'personal' | 'global') {
    closePreview()
    setPageMode(nextMode)
  }

  useEffect(() => {
    if (!incomingCompareFriend) return
    setFriend({
      initials: incomingCompareFriend.displayName.slice(0, 2).toUpperCase(),
      name: incomingCompareFriend.displayName,
      color: incomingCompareFriend.avatarFg,
      bg: incomingCompareFriend.avatarBg,
      count: 0,
      avatarUrl: incomingCompareFriend.avatarUrl,
    })
    setFriendUserId(incomingCompareFriend.otherUser)
    setFilter('versus')
    setPageMode('personal')
  }, [incomingCompareFriend?.otherUser])

  useEffect(() => {
    if (!comparePicker) return
    function handleClick(e: MouseEvent) {
      if (!(e.target as Element).closest?.('.tier-list-actions')) {
        setComparePicker(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [comparePicker])

  useEffect(() => {
    closePreview()
  }, [pageMode])

  const friendDests = friend
    ? friendUserId
      ? (FAKE_FRIENDS_MODE
          ? getFakeFriendDestinations(friendUserId)
          : incomingCompareFriend && incomingCompareFriend.otherUser === friendUserId
            ? incomingCompareFriendDestinations
            : realFriendDests)
      : DEMO_FRIEND_DESTINATIONS[friend.initials] ?? FRIEND_DESTINATIONS[friend.initials] ?? []
    : []
  const compareDenied = Boolean(friend && friendUserId && !realFriendAccess.allowed && realFriendAccess.deniedReason)
  const visibleFilters = friend ? COMPARE_TIER_FILTERS : BASE_TIER_FILTERS
  const myFiltered = useMemo(() => filterDestinations(destinations, filter, friendDests), [destinations, filter, friendDests])
  const hasUnrated = useMemo(() => myFiltered.some(d => d.kind !== 'stop' && getDestinationTier(d) === null), [myFiltered])
  const friendFiltered = useMemo(() => filterDestinations(friendDests, filter, destinations), [friendDests, filter, destinations])

  useEffect(() => {
    if (!visibleFilters.includes(filter)) {
      setFilter(friend ? 'versus' : 'all')
    }
  }, [filter, visibleFilters, friend])

  const sharedNames = useMemo(() => {
    if (!friend) return new Set<string>()
    const myNames = destinationNameSet(myFiltered)
    return new Set(friendFiltered.filter(destination => myNames.has(destinationNameKey(destination))).map(destinationNameKey))
  }, [friend, myFiltered, friendFiltered])

  // Notes du peuple pour mes destinations ET celles de l'ami affiché —
  // un seul batch couvre toutes les rangées visibles.
  const allVisibleDests = useMemo(() => [...destinations, ...friendDests], [destinations, friendDests])
  const { ratings: communityRatings } = useCommunityRatings(allVisibleDests)

  const myTripCount = useMemo(() => destinations.filter(d => d.kind !== 'stop').length, [destinations])
  const friendFirstName = friend?.name.split(' ')[0] ?? t('Friend', 'Ami')
  const myAverage = useMemo(() => getAvgScore(destinations), [destinations])
  const myFavoriteCount = useMemo(() => destinations.filter(d => d.coupDeCoeur && d.kind !== 'stop').length, [destinations])
  const friendOnlyCount = useMemo(() => {
    if (!friend) return 0
    const myNames = destinationNameSet(destinations)
    return friendDests.filter(destination => !myNames.has(destinationNameKey(destination))).length
  }, [destinations, friend, friendDests])
  const tierSummaryCounts = useMemo(
    () => TIER_ORDER.map(tier => ({
      tier,
      count: destinations.filter(d => d.kind !== 'stop' && getDestinationTier(d) === tier).length,
    })).filter(item => item.count > 0),
    [destinations]
  )
  const myTiers = useMemo(
    () => TIER_ORDER.filter(tier => myFiltered.some(d => getDestinationTier(d) === tier && d.kind !== 'stop')),
    [myFiltered]
  )
  const friendTiers = useMemo(
    () => TIER_ORDER.filter(tier => friendFiltered.some(d => getDestinationTier(d) === tier && d.kind !== 'stop')),
    [friendFiltered]
  )

  const myProfileTitle = useMemo(
    () => destinations.length >= 1 ? computeTravelerProfile(destinations).title : null,
    [destinations]
  )
  function toggleCollapse(tier: Tier) {
    setCollapsed(prev => ({ ...prev, [tier]: !prev[tier] }))
  }

  function clearComparison() {
    setFriend(null)
    setFriendUserId(null)
    setComparePicker(false)
  }

  function selectFriend(friendShape: Friend, userId: string | null) {
    setFriend(friendShape)
    setFriendUserId(userId)
    setComparePicker(false)
    setFilter('versus')
    setPageMode('personal')
  }

  const myInitials = myProfile?.displayName?.trim().slice(0, 2).toUpperCase() ?? 'M'

  // En comparaison active, le switch Mon classement / Global disparaît :
  // la comparaison est un contexte à part, on n'en sort que par sa croix.
  const isComparing = Boolean(friend && !compareDenied)

  // Deux emplacements pour le même switch : le hero (mobile — la filter row n'y
  // montre pas Comparer) et la filter row (desktop — le hero-head y est masqué).
  // CSS n'affiche jamais les deux à la fois.
  const renderPageModeControl = (variant: 'hero' | 'row') => isComparing ? null : (
    <SegmentedControl
      className={`tier-list-page-mode tier-list-page-mode--${variant}`}
      ariaLabel={t('Switch between my ranking and the global ranking', 'Basculer entre mon classement et le classement global')}
      role="tablist"
      size="sm"
      layout="fill"
      value={pageMode}
      options={[
        { value: 'personal' as const, label: t('My rankings', 'Mon classement') },
        { value: 'global' as const, label: t('Global', 'Global'), icon: <Icon name="users" /> },
      ]}
      onChange={handlePageModeChange}
    />
  )

  return (
    <main className={`tier-list-page${friend && !compareDenied ? ' is-comparing' : ' is-solo'}`} aria-label={t('Tier list', 'Tier list')}>
      <section className="tier-list-hero" aria-label={t('Ranking summary', 'Résumé du classement')}>
        <div className="tier-list-hero-head">
          <div className="tier-list-title">
            <span className="tier-list-eyebrow">Outpost</span>
            <h1>{pageMode === 'global' ? t('Global ranking', 'Classement global') : t('My rankings', 'Mon classement')}</h1>
          </div>

          <div className="tier-list-hero-actions">
            <span className="tier-list-hero-count" aria-label={`${myTripCount} destinations`}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 17 9 11l4 4 7-8" />
                <path d="M15 7h5v5" />
              </svg>
              {myTripCount}
              <span className="tier-list-hero-count-label">destinations</span>
            </span>

            {renderPageModeControl('hero')}

            {pageMode === 'personal' && (
            <div className="tier-list-actions" ref={pickerRef}>
              <button
                className={`tier-list-compare-btn${friend ? ' has-selection' : ''}`}
                type="button"
                onClick={() => setComparePicker(value => !value)}
                aria-expanded={comparePicker}
                style={friend ? { '--friend-bg': friend.bg, '--friend-color': friend.color } as React.CSSProperties : undefined}
              >
                {friend ? (
                  <>
                    <Avatar
                      avatarUrl={friend.avatarUrl}
                      initials={friend.initials}
                      bg={friend.bg}
                      fg={friend.color}
                      className="tier-list-compare-chip-avatar"
                      ariaHidden={true}
                    />
                    <span className="tier-list-compare-chip-label">{friend.name.split(' ')[0]}</span>
                    <span
                      className="tier-list-compare-chip-remove"
                      role="button"
                      tabIndex={0}
                      aria-label={t('Stop comparing', 'Arrêter de comparer')}
                      onClick={e => { e.stopPropagation(); clearComparison() }}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); clearComparison() } }}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" aria-hidden="true">
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    </span>
                  </>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <circle cx="5.5" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.4" />
                      <circle cx="10.5" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.4" />
                      <path d="M1 13c0-2.21 2.015-4 4.5-4s4.5 1.79 4.5 4M10.5 9c2.485 0 4.5 1.79 4.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    </svg>
                    <span className="tier-list-compare-chip-label">{t('Compare', 'Comparer')}</span>
                    <svg className="tier-list-compare-chip-caret" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </>
                )}
              </button>

              {comparePicker && (
                <div className="friend-picker">
                  <button className="friend-picker-clear" type="button" onClick={clearComparison}>
                    {t('No one', 'Personne')}
                  </button>
                  {realFriends.length === 0 && (
                    <p className="friends-muted" style={{ padding: 'var(--space-2) var(--space-3)' }}>
                      Local demo friends for testing comparison.
                    </p>
                  )}
                  {realFriends.map(realFriend => {
                    const initials = realFriend.displayName.slice(0, 2).toUpperCase()
                    const friendShape: Friend = {
                      initials,
                      name: realFriend.displayName,
                      color: realFriend.avatarFg,
                      bg: realFriend.avatarBg,
                      count: 0,
                      avatarUrl: realFriend.avatarUrl,
                    }
                    return (
                      <button
                        key={realFriend.otherUser}
                        className={`friend-picker-item ${friendUserId === realFriend.otherUser ? 'is-active' : ''}`}
                        onClick={() => selectFriend(friendShape, realFriend.otherUser)}
                        style={{ '--friend-color': realFriend.avatarFg, '--friend-bg': realFriend.avatarBg } as React.CSSProperties}
                      >
                        <Avatar
                          avatarUrl={realFriend.avatarUrl}
                          initials={initials}
                          bg={realFriend.avatarBg}
                          fg={realFriend.avatarFg}
                          className="friend-picker-avatar"
                        />
                        <span className="friend-picker-name">{realFriend.displayName}</span>
                        <span className="friend-picker-count">@{realFriend.handle}</span>
                      </button>
                    )
                  })}
                  {realFriends.length === 0 && FRIENDS.map(demoFriend => (
                    <button
                      key={demoFriend.initials}
                      className={`friend-picker-item ${friend?.name === demoFriend.name ? 'is-active' : ''}`}
                      onClick={() => selectFriend(demoFriend, null)}
                      style={{ '--friend-color': demoFriend.color, '--friend-bg': demoFriend.bg } as React.CSSProperties}
                    >
                      <span className="friend-picker-avatar">{demoFriend.initials}</span>
                      <span className="friend-picker-name">{demoFriend.name}</span>
                      <span className="friend-picker-count">{demoFriend.count} destinations</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            )}
          </div>
        </div>

        {pageMode === 'personal' && (friend && !compareDenied ? (
          <ComparisonBanner
            friend={friend}
            myProfile={myProfile}
            myDests={destinations}
            friendDests={friendDests}
            friendOnlyCount={friendOnlyCount}
            onClose={clearComparison}
          />
        ) : (
          <div className="tier-list-solo-summary page-mode-fade">
            <div className="tier-list-solo-primary">
              <div className="tier-list-solo-player">
              <Avatar
                avatarUrl={myProfile?.avatarUrl}
                initials={myInitials}
                bg={myProfile?.avatarBg ?? 'var(--purple)'}
                fg={myProfile?.avatarFg ?? '#ffffff'}
                className="tier-list-solo-avatar"
                ariaHidden={true}
              />
              <div className="tier-list-solo-player-main">
                <div className="tier-list-solo-identity">
                  <span>{myProfile?.displayName?.split(' ')[0] ?? t('Me', 'Moi')}</span>
                  {myProfileTitle && <span className="tier-list-solo-title">{myProfileTitle}</span>}
                  <strong>{myAverage !== null ? myAverage.toFixed(1) : '—'}</strong>
                </div>
              </div>
            </div>
            <strong className="tier-list-solo-score" aria-hidden="true">{myAverage !== null ? myAverage.toFixed(1) : '—'}</strong>
            <div className="tier-list-solo-secondary">
            <div className="tier-list-solo-meta">
              <span>{myFavoriteCount} {t('favorites', 'favoris')}</span>
              <span>{tierSummaryCounts.length} tiers</span>
            </div>
            </div>
            <div className="tier-list-hero-tier-chips" aria-label={t('Summary by tier', 'Résumé par tier')}>
              {tierSummaryCounts.map(({ tier, count }) => (
                <span key={tier} className={`tier-list-hero-tier-chip tier-list-hero-tier-chip--${tier.toLowerCase()}`}>
                  <b>{tier}</b>{count}
                </span>
              ))}
            </div>
            </div>
          </div>
        ))}
      </section>

      <div className="tier-list-filter-row">
        {/* Desktop : le switch Mon classement / Global vit ici, sur la même
            ligne que Comparer (le hero-head est masqué sur desktop). */}
        {renderPageModeControl('row')}
        {pageMode === 'personal' && (
        <SegmentedControl
          className="tier-list-filters"
          ariaLabel={t('Filter tier list', 'Filtrer la tier list')}
          role="radiogroup"
          size="sm"
          layout="scrollable"
          tone="tinted"
          value={filter}
          options={visibleFilters.map(filterItem => ({
            value: filterItem,
            label: TIER_FILTER_LABEL[filterItem],
            accentColor: filterItem === 'favorites' ? 'var(--tier-s)' : 'var(--purple)',
          }))}
          onChange={setFilter}
        />
        )}
        {/* Desktop-only: Comparer button at right of filter row (hidden on mobile via CSS) */}
        {pageMode === 'personal' && (
        <div className="tier-list-actions">
          <button
            className={`tier-list-compare-btn${friend ? ' has-selection' : ''}`}
            type="button"
            onClick={() => setComparePicker(value => !value)}
            aria-expanded={comparePicker}
            style={friend ? { '--friend-bg': friend.bg, '--friend-color': friend.color } as React.CSSProperties : undefined}
          >
            {friend ? (
              <>
                <Avatar
                  avatarUrl={friend.avatarUrl}
                  initials={friend.initials}
                  bg={friend.bg}
                  fg={friend.color}
                  className="tier-list-compare-chip-avatar"
                  ariaHidden={true}
                />
                <span className="tier-list-compare-chip-label">{friend.name.split(' ')[0]}</span>
                <span
                  className="tier-list-compare-chip-remove"
                  role="button"
                  tabIndex={0}
                  aria-label={t('Stop comparing', 'Arrêter de comparer')}
                  onClick={e => { e.stopPropagation(); clearComparison() }}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); clearComparison() } }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </span>
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <circle cx="5.5" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.4" />
                  <circle cx="10.5" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M1 13c0-2.21 2.015-4 4.5-4s4.5 1.79 4.5 4M10.5 9c2.485 0 4.5 1.79 4.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
                <span className="tier-list-compare-chip-label">{t('Compare', 'Comparer')}</span>
                <svg className="tier-list-compare-chip-caret" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </>
            )}
          </button>

          {comparePicker && (
            <div className="friend-picker">
              <button className="friend-picker-clear" type="button" onClick={clearComparison}>
                {t('No one', 'Personne')}
              </button>
              {realFriends.length === 0 && (
                <p className="friends-muted" style={{ padding: 'var(--space-2) var(--space-3)' }}>
                  Local demo friends for testing comparison.
                </p>
              )}
              {realFriends.map(realFriend => {
                const initials = realFriend.displayName.slice(0, 2).toUpperCase()
                const friendShape: Friend = {
                  initials,
                  name: realFriend.displayName,
                  color: realFriend.avatarFg,
                  bg: realFriend.avatarBg,
                  count: 0,
                  avatarUrl: realFriend.avatarUrl,
                }
                return (
                  <button
                    key={realFriend.otherUser}
                    className={`friend-picker-item ${friendUserId === realFriend.otherUser ? 'is-active' : ''}`}
                    onClick={() => selectFriend(friendShape, realFriend.otherUser)}
                    style={{ '--friend-color': realFriend.avatarFg, '--friend-bg': realFriend.avatarBg } as React.CSSProperties}
                  >
                    <Avatar
                      avatarUrl={realFriend.avatarUrl}
                      initials={initials}
                      bg={realFriend.avatarBg}
                      fg={realFriend.avatarFg}
                      className="friend-picker-avatar"
                    />
                    <span className="friend-picker-name">{realFriend.displayName}</span>
                    <span className="friend-picker-count">@{realFriend.handle}</span>
                  </button>
                )
              })}
              {realFriends.length === 0 && FRIENDS.map(demoFriend => (
                <button
                  key={demoFriend.initials}
                  className={`friend-picker-item ${friend?.name === demoFriend.name ? 'is-active' : ''}`}
                  onClick={() => selectFriend(demoFriend, null)}
                  style={{ '--friend-color': demoFriend.color, '--friend-bg': demoFriend.bg } as React.CSSProperties}
                >
                  <span className="friend-picker-avatar">{demoFriend.initials}</span>
                  <span className="friend-picker-name">{demoFriend.name}</span>
                  <span className="friend-picker-count">{demoFriend.count} destinations</span>
                </button>
              ))}
            </div>
          )}
        </div>
        )}
      </div>

      {pageMode === 'global' && (
        <CommunityLeaderboard
          myDestinations={destinations}
          onSelectMine={destination => openPreview(destination, t('Me', 'Moi'), 'var(--purple)')}
        />
      )}

      {pageMode === 'personal' && compareDenied && (
        <section className="empty-friend-carnet" role="status">
          <div className="empty-friend-carnet-card">
            <h3>{realFriendAccess.deniedReason === 'friends_only'
              ? 'This map is visible to friends only.'
              : 'This map is private.'}</h3>
            <p>The comparison cannot be shown while this map is not visible to you.</p>
            <button
              type="button"
              className="friends-action-btn friends-action-secondary"
              onClick={() => { setFriend(null); setFriendUserId(null) }}
            >
              Close comparison
            </button>
          </div>
        </section>
      )}

      {/* Solo mode or comparison denied */}
      {pageMode === 'personal' && (!friend || compareDenied) && (
        <>
          <section className="tier-desktop-columns page-mode-fade" aria-label={t('Rankings by tier', 'Classement par tier')}>
            {hasUnrated && (
              <DesktopTierColumn
                key="desktop-unrated"
                tier={null}
                destinations={myFiltered}
                onSelect={destination => openPreview(destination, t('Me', 'Moi'), 'var(--purple)')}
              />
            )}
            {TIER_ORDER.map(tier => (
              <DesktopTierColumn
                key={`desktop-${tier}`}
                tier={tier}
                destinations={myFiltered}
                onSelect={destination => openPreview(destination, t('Me', 'Moi'), 'var(--purple)')}
              />
            ))}
          </section>
          <section className="tier-list-rows tier-list-rows--solo-mobile page-mode-fade" aria-label={t('Rankings by tier', 'Classement par tier')}>
            {hasUnrated && (
              <TierRow
                key="unrated"
                tier={null}
                myDests={myFiltered}
                friendDests={[]}
                friend={null}
                sharedNames={sharedNames}
                collapsed={unratedCollapsed}
                communityRatings={communityRatings}
                onToggle={() => setUnratedCollapsed(value => !value)}
                onSelectMine={destination => openPreview(destination, t('Me', 'Moi'), 'var(--purple)')}
              />
            )}
            {TIER_ORDER.map(tier => (
              <TierRow
                key={tier}
                tier={tier}
                myDests={myFiltered}
                friendDests={[]}
                friend={null}
                sharedNames={sharedNames}
                collapsed={collapsed[tier]}
                communityRatings={communityRatings}
                onToggle={() => toggleCollapse(tier)}
                onSelectMine={destination => openPreview(destination, t('Me', 'Moi'), 'var(--purple)')}
              />
            ))}
          </section>
        </>
      )}

      {/* Compare mode — versus: my list with friend scores side by side */}
      {pageMode === 'personal' && friend && !compareDenied && filter === 'versus' && (
        <section
          className="tier-list-rows tier-list-rows--compare"
          style={{ '--friend-bg': friend.bg, '--friend-color': friend.color } as React.CSSProperties}
          aria-label={`${t('My rankings', 'Mon classement')} ${t('with', 'avec')} ${friendFirstName}`}
        >
          <FriendCompareView
            friend={{
              otherUser: friendUserId ?? 'demo-friend',
              handle: friendFirstName.toLowerCase(),
              displayName: friend.name,
              avatarBg: friend.bg,
              avatarFg: friend.color,
              avatarUrl: friend.avatarUrl,
              status: 'accepted',
              initiator: 'me',
              createdAt: '',
            }}
            myDestinations={myFiltered.filter(destination => destination.kind !== 'stop')}
            theirDestinations={friendFiltered.filter(destination => destination.kind !== 'stop')}
            onSelectMine={destination => openPreview(destination, t('Me', 'Moi'), 'var(--purple)')}
            onSelectTheirs={destination => openPreview(destination, friendFirstName, friend.bg)}
            variant="tier-list-page"
          />
        </section>
      )}

      {/* Compare mode — friend-only: friend's tier list in solo mode */}
      {pageMode === 'personal' && friend && !compareDenied && filter === 'friend-only' && (
        <section
          className="tier-list-rows tier-list-rows--friend-only"
          aria-label={`Tier list de ${friendFirstName}`}
        >
          {friendTiers.length === 0 ? (
            <p className="tier-list-empty">{t('No destinations', 'Aucune destination')}</p>
          ) : friendTiers.map(tier => (
            <TierRow
              key={`friend-${tier}`}
              tier={tier}
              myDests={friendFiltered}
              friendDests={[]}
              friend={null}
              sharedNames={new Set()}
              collapsed={collapsed[tier]}
              communityRatings={communityRatings}
              onToggle={() => toggleCollapse(tier)}
              onSelectMine={destination => openPreview(destination, friendFirstName, friend.bg)}
            />
          ))}
        </section>
      )}

      {/* Compare mode — mine-only: my list in solo mode */}
      {pageMode === 'personal' && friend && !compareDenied && filter === 'mine-only' && (
        <section
          className="tier-list-rows tier-list-rows--mine-only"
          aria-label={t('My rankings', 'Mon classement')}
        >
          {myTiers.length === 0 ? (
            <p className="tier-list-empty">{t('No destinations', 'Aucune destination')}</p>
          ) : myTiers.map(tier => (
            <TierRow
              key={`mine-${tier}`}
              tier={tier}
              myDests={myFiltered}
              friendDests={[]}
              friend={null}
              sharedNames={sharedNames}
              collapsed={collapsed[tier]}
              communityRatings={communityRatings}
              onToggle={() => toggleCollapse(tier)}
              onSelectMine={destination => openPreview(destination, t('Me', 'Moi'), 'var(--purple)')}
            />
          ))}
        </section>
      )}

      {preview && (
        <DestinationPreview
          destination={preview.destination}
          ownerLabel={preview.ownerLabel}
          ownerColor={preview.ownerColor}
          onClose={closePreview}
          onOpenMap={onSelect}
        />
      )}
    </main>
  )
}


function getPreviewStats(destination: Destination) {
  const stats: Array<{ icon: string; label: string; value: string }> = []
  if (destination.personalBudget) stats.push({ icon: '💸', label: 'Spent', value: `${Math.round(destination.personalBudget)} €` })
  if (destination.tripDays) stats.push({ icon: '⏱', label: 'Duration', value: `${destination.tripDays}d` })
  if (destination.tripYear) stats.push({ icon: '🗓', label: 'Year', value: String(destination.tripYear) })
  if (destination.companions) stats.push({ icon: COMPANION_EMOJI[destination.companions], label: 'With', value: COMPANION_LABEL[destination.companions] })
  stats.push({ icon: INTENT_EMOJI[destination.intent], label: 'Style', value: INTENT_LABEL[destination.intent] })
  stats.push({ icon: '⭐', label: 'Score', value: getDestinationScore(destination).toFixed(1) })
  if (destination.value !== undefined) stats.push({ icon: '💶', label: 'Value', value: `${destination.value.toFixed(1)}/5` })
  return stats
}
