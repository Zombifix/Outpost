import { useState } from 'react'
import type { Destination, Friendship, Tier } from '../../types'
import { TIER_COLORS, TIER_ORDER } from '../../data'
import { destinationNameKey } from '../../utils/destinationIdentity'
import { getDestinationTier } from '../../utils'
import { t } from '../../i18n'

interface FriendCompareViewProps {
  friend: Friendship
  myDestinations: Destination[]
  theirDestinations: Destination[]
  onSelectMine?: (destination: Destination) => void
  onSelectTheirs?: (destination: Destination) => void
  variant?: 'default' | 'tier-list-page'
}

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
  "États-Unis d'Amérique": 'us', 'Etats-Unis d\'Amérique': 'us', 'États-Unis': 'us', 'Etats-Unis': 'us',
}

function getCountryFlag(destination: Destination): string | undefined {
  const code = destination.countryCode ?? COUNTRY_CODE_MAP[destination.country]
  if (!code) return undefined
  return `https://flagcdn.com/24x18/${code.toLowerCase()}.png`
}

/**
 * Comparateur Moi vs Ami — source unique de vérité.
 * Utilisé depuis :
 *   - FriendProfileSheet (onglet Tier list)
 *   - TierListPage (bouton "Comparer avec un ami")
 *
 * Rendu en flux (pas en modal/overlay) : le parent décide du cadrage.
 */
export default function FriendCompareView({
  friend,
  myDestinations,
  theirDestinations,
  onSelectMine,
  onSelectTheirs,
  variant = 'default',
}: FriendCompareViewProps) {
  return (
    <div className={`friend-compare${variant === 'tier-list-page' ? ' friend-compare--tier-list' : ''}`}>
      <CommonDests mine={myDestinations} theirs={theirDestinations} friendName={friend.displayName} />
      <div className="friend-compare-grid">
        <DestList
          destinations={myDestinations}
          label={t('Me', 'Moi')}
          emptyLabel={t('No destinations in your tier list yet.', 'Aucune destination dans ta tier list pour le moment.')}
          onSelect={onSelectMine}
          tone="mine"
        />
        <div className="friend-compare-sep" />
        <DestList
          destinations={theirDestinations}
          label={friend.displayName}
          emptyLabel={t('No destinations in their tier list yet.', 'Aucune destination dans sa tier list pour le moment.')}
          onSelect={onSelectTheirs}
          tone="friend"
        />
      </div>
    </div>
  )
}

function CommonDests({ mine, theirs, friendName }: { mine: Destination[]; theirs: Destination[]; friendName: string }) {
  const [collapsed, setCollapsed] = useState(false)
  const myMap = new Map(mine.map(d => [destinationNameKey(d), d]))
  const common = theirs
    .map(t => ({ them: t, mine: myMap.get(destinationNameKey(t)) }))
    .filter((x): x is { them: Destination; mine: Destination } => !!x.mine)
  if (common.length === 0) {
    return null
  }
  return (
    <section className={`friend-compare-common${collapsed ? ' is-collapsed' : ''}`}>
      <h4 className="friend-compare-common-header" onClick={() => setCollapsed(c => !c)}>
        {common.length} destination{common.length > 1 ? 's' : ''} {t('in common', 'en commun')}
        <span className={`friend-compare-common-chevron${collapsed ? ' is-collapsed' : ''}`}>▾</span>
      </h4>
      {!collapsed && <div className="friend-compare-common-list">
        {common.map(({ them, mine: m }) => {
          const myTier = getDestinationTier(m)
          const theirTier = getDestinationTier(them)
          const same = theirTier === myTier
          return (
            <div key={them.name} className={`friend-compare-common-row${same ? ' is-match' : ''}`}>
              <span className="friend-compare-common-name">{them.name}</span>
              <span className="friend-compare-common-tiers">
                <TierBadge tier={myTier} />
                <span className="friend-compare-vs">{same ? '=' : 'vs'}</span>
                <TierBadge tier={theirTier} />
              </span>
            </div>
          )
        })}
      </div>}
    </section>
  )
}

function TierBadge({ tier }: { tier: Tier | null }) {
  return (
    <span className={`tier-orb tier-${tier ? tier.toLowerCase() : 'unrated'} friend-compare-tier-orb`}>{tier ?? '?'}</span>
  )
}

function DestList({
  destinations,
  label,
  emptyLabel,
  onSelect,
  tone = 'mine',
}: {
  destinations: Destination[]
  label: string
  emptyLabel: string
  onSelect?: (destination: Destination) => void
  tone?: 'mine' | 'friend'
}) {
  return (
    <div className={`friend-compare-col friend-compare-col--${tone}`}>
      <h5 className="friend-compare-col-label">{label}</h5>
      {TIER_ORDER.map(tier => {
        const items = destinations.filter(d => getDestinationTier(d) === tier)
        if (items.length === 0) return null
        const c = TIER_COLORS[tier]
        return (
          <div key={tier} className="friend-compare-tier-block">
            <div className="friend-compare-tier-header">
              <span className={`tier-orb tier-${tier.toLowerCase()} friend-compare-tier-orb`}>{tier}</span>
              <span className="friend-compare-tier-line" style={{ background: c.pin + '30' }} />
            </div>
            {items.map(d => (
              <CompareTierItem
                key={d.name}
                destination={d}
                tierColor={c.pin}
                onSelect={onSelect}
              />
            ))}
          </div>
        )
      })}
      {destinations.length === 0 && (
        <p className="friends-muted">{emptyLabel}</p>
      )}
    </div>
  )
}

function CompareTierItem({
  destination,
  tierColor,
  onSelect,
}: {
  destination: Destination
  tierColor: string
  onSelect?: (destination: Destination) => void
}) {
  const flagUrl = getCountryFlag(destination)

  return (
    <button
      type="button"
      className={`friend-compare-tier-item${onSelect ? ' is-interactive' : ''}${destination.image ? ' has-image' : ''}`}
      onClick={() => onSelect?.(destination)}
    >
      <div
        className="friend-compare-tier-thumb"
        style={destination.image ? { backgroundImage: `url(${destination.image})`, '--tier-accent': tierColor } as React.CSSProperties : { '--tier-accent': tierColor } as React.CSSProperties}
        aria-hidden="true"
      >
        {!destination.image && <span className="friend-compare-tier-thumb-placeholder">{destination.name[0]}</span>}
      </div>
      <span className="friend-compare-tier-dot" style={{ background: tierColor }} />
      <span className="friend-compare-tier-copy">
        <span className="friend-compare-tier-name">{destination.name}</span>
        <span className="friend-compare-tier-country">
          {flagUrl && <img src={flagUrl} alt="" className="friend-compare-tier-flag" loading="lazy" />}
          {destination.country}
        </span>
      </span>
    </button>
  )
}
