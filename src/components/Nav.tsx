import { useEffect, useMemo, useRef, useState } from 'react'
import type { DestinationFilters } from '../App'
import type { Destination, Friendship } from '../types'
import { BrandLogo } from './BrandLogo'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { useActivityFeed } from '../hooks/useActivityFeed'
import { t } from '../i18n'

type View = 'map' | 'tier-list' | 'explore' | 'friends'

interface NavProps {
  totalDestinations: number
  destinations: Destination[]
  activeView: View
  filters: DestinationFilters
  shareCopied: boolean
  publicId: string
  avatarFallbackLabel: string
  profileAvatarUrl?: string | null
  profileAvatarFallbackUrl?: string
  profileAvatarBg: string
  profileAvatarFg: string
  canShare: boolean
  accountOpen: boolean
  pendingFriendCount: number
  onViewChange: (view: View) => void
  onAddClick: () => void
  onFiltersChange: (filters: DestinationFilters) => void
  onSearch: (name: string) => void
  onShare: () => void
  onAccountClick: () => void
  /** `anchor` : position du bouton Amis, pour ouvrir le panneau en menu déroulant. */
  onOpenFriends: (anchor: DOMRect) => void
  onActivityFlyTo?: (lat: number, lng: number, name: string, actor?: { userId: string; handle: string; displayName: string }) => void
  viewingFriend?: { userId: string; handle: string; displayName: string } | null
  onBackToMyCarnet?: () => void
  isAuthenticated?: boolean
  friendshipWithViewed?: Friendship | null
  addFriendFeedback?: 'idle' | 'sent' | 'accepted'
  onAddViewingFriend?: () => void
  onCompareViewingFriend?: () => void
}

export default function Nav({
  totalDestinations,
  destinations,
  activeView,
  filters,
  shareCopied,
  publicId,
  avatarFallbackLabel,
  profileAvatarUrl,
  profileAvatarFallbackUrl,
  profileAvatarBg,
  profileAvatarFg,
  canShare,
  accountOpen,
  pendingFriendCount,
  onViewChange,
  onAddClick,
  onFiltersChange,
  onSearch,
  onShare,
  onAccountClick,
  onOpenFriends,
  onActivityFlyTo,
  viewingFriend,
  onBackToMyCarnet,
  isAuthenticated,
  friendshipWithViewed,
  addFriendFeedback = 'idle',
  onAddViewingFriend,
  onCompareViewingFriend,
}: NavProps) {
  const [filtersOpen, setFiltersOpen] = useState(false)
  const showFilters = activeView === 'map' && !viewingFriend
  const activeFilterCount = [
    filters.coupDeCoeur,
    filters.thisYear,
    filters.livedThere,
    filters.visitedMultiple,
    filters.companions !== 'all',
    filters.budget !== 'all',
  ].filter(Boolean).length

  const updateFilters = (patch: Partial<DestinationFilters>) => {
    onFiltersChange({ ...filters, ...patch })
  }

  useEffect(() => {
    if (!showFilters && filtersOpen) setFiltersOpen(false)
  }, [showFilters, filtersOpen])

  const navMapStats = useMemo(() => {
    const countryCount = new Set(destinations.map(d => d.country).filter(Boolean)).size
    const favCount = destinations.filter(d => d.coupDeCoeur).length
    return { countryCount, favCount }
  }, [destinations])

  return (
    <>
      <aside className="sidebar">
        <button className="brand" onClick={() => onViewChange('map')} aria-label={t('Home', 'Accueil')}>
          <BrandLogo />
        </button>

        <button className="btn btn-primary create-button" onClick={onAddClick}>
          <span className="create-icon"><Icon name="plus" /></span>
          <span>{t('Destination', 'Destination')}</span>
        </button>

        <nav className="side-menu" aria-label={t('Main navigation', 'Navigation principale')}>
          <button className={activeView === 'map' ? 'active' : ''} onClick={() => onViewChange('map')}>
            <Icon name="map" />
            {t('My journal', 'Mon carnet')}
          </button>
          <button className={activeView === 'tier-list' ? 'active' : ''} onClick={() => onViewChange('tier-list')}>
            <Icon name="sliders" />
            {t('Tier list', 'Tier list')}
          </button>
          <button className={activeView === 'explore' ? 'active' : ''} onClick={() => onViewChange('explore')}>
            <Icon name="compass" />
            {t('Explore', 'Explorer')}
          </button>
        </nav>

      </aside>

      <header className="topbar">
        <div className="topbar-title" aria-label={t('Page title', 'Titre de la page')}>
          {viewingFriend && activeView === 'map' && onBackToMyCarnet && (
            <button
              type="button"
              className="page-title-back"
              onClick={onBackToMyCarnet}
              aria-label={t('Back to my journal', 'Retour à mon carnet')}
            >
              <Icon name="arrow-left" />
              <span>{t('My journal', 'Mon carnet')}</span>
            </button>
          )}
          <div className="topbar-title-text">
            <h1>
              {activeView === 'map' && (viewingFriend ? `${viewingFriend.handle} · ${t('travel journal', 'carnet de voyage')}` : t('My travel journal', 'Mon carnet de voyages'))}
              {activeView === 'explore' && t('Explore · AI Suggestions', 'Explorer · Suggestions IA')}
              {activeView === 'tier-list' && t('Tier list', 'Tier list')}
              {activeView === 'friends' && t('Friends', 'Amis')}
            </h1>
            {activeView === 'map' && (() => {
              const { countryCount, favCount } = navMapStats
              const bits: string[] = []
              if (countryCount > 0) bits.push(`${countryCount} ${t(countryCount > 1 ? 'countries' : 'country', 'pays')}`)
              if (favCount > 0) bits.push(`${favCount} ${t(favCount > 1 ? 'favorites' : 'favorite', favCount > 1 ? 'coups de cœur' : 'coup de cœur')}`)
              return bits.length > 0 ? <span className="topbar-title-sub">{bits.join(' · ')}</span> : null
            })()}
          </div>
        </div>
        <div className="top-actions">
          {showFilters && (
            <div className="filter-menu-wrap">
              <button
                className={activeFilterCount ? 'active-action' : ''}
                onClick={() => setFiltersOpen(value => !value)}
                aria-expanded={filtersOpen}
              >
                <Icon name="sliders" />
                {t('Filters', 'Filtres')}{activeFilterCount ? ` (${activeFilterCount})` : ''}
              </button>
              {filtersOpen && (
                <div className="filter-popover">
                <div className="filter-popover-head">
                  <strong>{t('Filters', 'Filtres')}</strong>
                  {activeFilterCount > 0 && (
                    <button
                      type="button"
                      onPointerDown={() => onFiltersChange({ coupDeCoeur: false, thisYear: false, livedThere: false, visitedMultiple: false, companions: 'all', budget: 'all' })}
                    >
                      {t('Reset', 'Réinitialiser')}
                    </button>
                  )}
                </div>
                <div className="filter-chip-grid">
                  <button type="button" className={filters.coupDeCoeur ? 'is-active' : ''} onPointerDown={() => updateFilters({ coupDeCoeur: !filters.coupDeCoeur })}>
                    ❤️ {t('Favorites', 'Coups de cœur')}
                  </button>
                  <button type="button" className={filters.thisYear ? 'is-active' : ''} onPointerDown={() => updateFilters({ thisYear: !filters.thisYear })}>
                    📅 {t('This year', 'Cette année')}
                  </button>
                  <button type="button" className={filters.livedThere ? 'is-active' : ''} onPointerDown={() => updateFilters({ livedThere: !filters.livedThere })}>
                    🏠 {t('Lived there', 'A vécu ici')}
                  </button>
                  <button type="button" className={filters.visitedMultiple ? 'is-active' : ''} onPointerDown={() => updateFilters({ visitedMultiple: !filters.visitedMultiple })}>
                    🔁 {t('Revisited', 'Revisité')}
                  </button>
                </div>
                <div className="filter-duration">
                  <span>{t('With', 'Avec qui')}</span>
                  <div className="filter-grid-2">
                    <button type="button" className={filters.companions === 'all' ? 'is-active' : ''} onPointerDown={() => updateFilters({ companions: 'all' })}>{t('All', 'Tous')}</button>
                    <button type="button" className={filters.companions === 'solo' ? 'is-active' : ''} onPointerDown={() => updateFilters({ companions: 'solo' })}>🎒 Solo</button>
                    <button type="button" className={filters.companions === 'amis' ? 'is-active' : ''} onPointerDown={() => updateFilters({ companions: 'amis' })}>👯 {t('With friends', 'Entre amis')}</button>
                    <button type="button" className={filters.companions === 'famille' ? 'is-active' : ''} onPointerDown={() => updateFilters({ companions: 'famille' })}>👨‍👩‍👧 {t('With family', 'En famille')}</button>
                  </div>
                </div>
                <div className="filter-duration">
                  <span>{t('Budget', 'Budget')}</span>
                  <div className="filter-grid-4">
                    <button type="button" className={filters.budget === 'all' ? 'is-active' : ''} onPointerDown={() => updateFilters({ budget: 'all' })}>{t('All', 'Tous')}</button>
                    <button type="button" className={filters.budget === '$' ? 'is-active' : ''} onPointerDown={() => updateFilters({ budget: '$' })}>$</button>
                    <button type="button" className={filters.budget === '$$' ? 'is-active' : ''} onPointerDown={() => updateFilters({ budget: '$$' })}>$$</button>
                    <button type="button" className={filters.budget === '$$$' ? 'is-active' : ''} onPointerDown={() => updateFilters({ budget: '$$$' })}>$$$</button>
                  </div>
                </div>
                </div>
              )}
            </div>
          )}
          <button
            onClick={e => {
              setFiltersOpen(false)
              onOpenFriends(e.currentTarget.getBoundingClientRect())
            }}
            aria-label={t('Friends', 'Amis')}
          >
            <Icon name="users" />
            {t('Friends', 'Amis')}
            {pendingFriendCount > 0 && (
              <span className="top-action-badge" aria-label={`${pendingFriendCount} ${t('pending requests', 'demandes en attente')}`}>
                {pendingFriendCount}
              </span>
            )}
          </button>
          {viewingFriend && isAuthenticated ? (
            friendshipWithViewed?.status === 'accepted' ? (
              <button className="btn btn-primary btn-pill btn-sm share share-compare" onClick={onCompareViewingFriend}>
                <Icon name="versus" />
                {t('Compare', 'Comparer')}
              </button>
            ) : addFriendFeedback !== 'idle' ? (
              <span className="share-feedback">
                {addFriendFeedback === 'accepted' ? t('Friend ✓', 'Ami ✓') : t('Request sent ✓', 'Demande envoyée ✓')}
              </span>
            ) : (
              <button
                className="btn btn-primary btn-pill btn-sm share share-add-friend"
                onClick={onAddViewingFriend}
                disabled={friendshipWithViewed?.status === 'pending' && friendshipWithViewed.initiator === 'me'}
              >
                <Icon name="user-plus" />
                {friendshipWithViewed?.status === 'pending' && friendshipWithViewed.initiator === 'me'
                  ? t('Request sent', 'Demande envoyée')
                  : friendshipWithViewed?.status === 'pending' && friendshipWithViewed.initiator === 'them'
                    ? t('+ Accept', '+ Accepter')
                    : t('+ Add friend', '+ Ajouter en ami')}
              </button>
            )
          ) : !viewingFriend ? (
            <button
              className={`btn btn-primary btn-pill btn-sm share${shareCopied ? ' is-copied' : ''}`}
              onClick={onShare}
            >
              <Icon name={shareCopied ? 'check' : 'share'} />
              {shareCopied ? t('Link copied', 'Lien copié') : t('Share', 'Partager')}
            </button>
          ) : null}
          <button
            className={`user-badge${accountOpen ? ' is-active' : ''}`}
            onClick={onAccountClick}
            aria-label={accountOpen ? t('Close account', 'Fermer mon compte') : t('My account', 'Mon compte')}
            aria-expanded={accountOpen}
          >
            <Avatar
              avatarUrl={profileAvatarUrl}
              fallbackUrl={profileAvatarFallbackUrl}
              initials={avatarFallbackLabel || publicId}
              bg={profileAvatarBg}
              fg={profileAvatarFg}
              className="user-badge-avatar"
              ariaHidden={true}
            />
          </button>
        </div>
      </header>

    </>
  )
}


function SidebarActivity({ onSeeAll, onFlyTo }: { onSeeAll: () => void; onFlyTo?: (lat: number, lng: number, name: string, actor?: { userId: string; handle: string; displayName: string }) => void }) {
  const { events: allEvents } = useActivityFeed(20)
  const events = useMemo(() => allEvents.filter(e => e.kind === 'destination_added'), [allEvents])
  const activityRef = useRef<HTMLElement | null>(null)

  // Mémorise les IDs déjà vus pour ne marquer "is-new" que les arrivées live.
  const seenRef = useRef<Set<string>>(new Set())
  const initializedRef = useRef(false)
  const [pulseId, setPulseId] = useState<string | null>(null)
  const [rowLimit, setRowLimit] = useState(3)

  useEffect(() => {
    if (!initializedRef.current) {
      events.forEach(e => seenRef.current.add(e.id))
      initializedRef.current = true
      return
    }
    const fresh = events.find(e => !seenRef.current.has(e.id))
    if (fresh) {
      seenRef.current.add(fresh.id)
      setPulseId(fresh.id)
      const t = setTimeout(() => setPulseId(null), 2200)
      return () => clearTimeout(t)
    }
  }, [events])

  useEffect(() => {
    const element = activityRef.current
    if (!element) return
    const container = element.parentElement
    if (!container) return

    const updateRowLimit = () => {
      const elementRect = element.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      const availableHeight = containerRect.bottom - elementRect.top
      const nextLimit = availableHeight < 235 ? 0 : availableHeight < 290 ? 1 : availableHeight < 345 ? 2 : 3
      setRowLimit(current => current === nextLimit ? current : nextLimit)
    }

    updateRowLimit()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateRowLimit)
      return () => window.removeEventListener('resize', updateRowLimit)
    }

    const observer = new ResizeObserver(updateRowLimit)
    observer.observe(container)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  if (events.length === 0) {
    return (
      <section className="sidebar-activity is-empty" aria-label="Recent activity">
        <header className="sidebar-activity-head">
          <h4>
            <span className="sidebar-activity-live" aria-hidden="true" />
            {t('Recent activity', 'Activité récente')}
          </h4>
        </header>
        <p className="sidebar-activity-sub">{t('No activity yet.', 'Aucune activité pour l\'instant.')}</p>
      </section>
    )
  }
  // Pour le hero, on préfère une destination_added récente (riche en visuel : image + tier).
  // Si aucune, on retombe sur le premier event peu importe le kind.
  const heroIdx = events.findIndex(e => e.kind === 'destination_added')
  const hero = heroIdx >= 0 ? events[heroIdx] : events[0]
  const rest = events.filter(e => e.id !== hero.id).slice(0, rowLimit)

  // Extrait les infos communes pour un event (clic, payload, etc.)
  const buildHandler = (ev: typeof events[number]) => {
    const name = (typeof ev.payload?.name === 'string' && ev.payload.name)
      || (typeof ev.payload?.destination_name === 'string' && ev.payload.destination_name)
      || ''
    const lat = typeof ev.payload?.lat === 'number' ? ev.payload.lat : undefined
    const lng = typeof ev.payload?.lng === 'number' ? ev.payload.lng : undefined
    const actorInfo = ev.actorHandle
      ? { userId: ev.actor, handle: ev.actorHandle, displayName: ev.actorDisplayName ?? ev.actorHandle }
      : undefined
    const canFly = lat !== undefined && lng !== undefined && name && onFlyTo
    return canFly
      ? () => onFlyTo!(lat as number, lng as number, name, actorInfo)
      : () => onSeeAll()
  }

  return (
    <section
      ref={activityRef}
      className="sidebar-activity"
      data-row-count={rest.length}
      aria-label={t('Recent activity', 'Activité récente')}
    >
      <header className="sidebar-activity-head">
        <h4>
          <span className="sidebar-activity-live" aria-hidden="true" />
          {t('Recent activity', 'Activité récente')}
        </h4>
      </header>
      <p className="sidebar-activity-sub">{t('Latest destinations added', 'Dernières destinations ajoutées')}</p>

      {hero && (
        <HeroCard
          event={hero}
          onClick={buildHandler(hero)}
          isPulse={pulseId === hero.id}
        />
      )}

      <ul className="sidebar-activity-rows">
        {rest.map(ev => (
          <li key={ev.id} className={pulseId === ev.id ? 'is-new' : ''}>
            <RowCard event={ev} onClick={buildHandler(ev)} />
          </li>
        ))}
      </ul>
    </section>
  )
}

// ─── Hero (1ère carte, grand format avec image plein largeur) ──────────────────
function HeroCard({ event: ev, onClick, isPulse }: {
  event: ReturnType<typeof useActivityFeed>['events'][number]
  onClick: () => void
  isPulse: boolean
}) {
  const actor = ev.actorDisplayName ?? ev.actorHandle ?? t('Anonymous', 'Anonyme')
  const name = (typeof ev.payload?.name === 'string' && ev.payload.name)
    || (typeof ev.payload?.destination_name === 'string' && ev.payload.destination_name)
    || ''
  const country = extractCountry(name)
  const destShort = extractDestShort(name)
  const image = typeof ev.payload?.image === 'string' ? ev.payload.image : undefined
  const tier = typeof ev.payload?.tier === 'string' ? (ev.payload.tier as string) : undefined

  return (
    <button
      className={`sidebar-hero${isPulse ? ' is-new' : ''}`}
      onClick={onClick}
      title={name || actor}
      style={image ? { backgroundImage: `url(${image})` } : {
        background: `linear-gradient(135deg, ${ev.actorAvatarBg ?? 'var(--avatar-bg-default)'}, ${ev.actorAvatarBg ?? 'var(--avatar-bg-default)'})`,
      }}
    >
      <span className="sidebar-hero-shade" aria-hidden="true" />
      {tier && <span className={`sidebar-hero-tier tier-${tier.toLowerCase()}`}>{tier}</span>}
      <span className="sidebar-hero-body">
        <strong className="sidebar-hero-dest">{destShort || name}</strong>
        {country && <span className="sidebar-hero-country">{country}</span>}
      </span>
      <span className="sidebar-hero-footer">
        <span className="sidebar-hero-actor">
          <span
            className="sidebar-hero-avatar"
            style={{ background: ev.actorAvatarBg ?? 'var(--avatar-bg-default)', color: ev.actorAvatarFg ?? 'var(--avatar-fg-default)' }}
            aria-hidden="true"
          >
            {actor.slice(0, 1).toUpperCase()}
          </span>
          <span>{actor}</span>
        </span>
        <span className="sidebar-hero-time">{relTime(ev.createdAt)}</span>
      </span>
    </button>
  )
}

// ─── Row (cartes secondaires, format épuré : thumb + dest/pays + tier) ────────
// L'acteur et le temps n'apparaissent que sur la hero. Les rows restent
// minimalistes pour éviter la surcharge visuelle.
function RowCard({ event: ev, onClick }: {
  event: ReturnType<typeof useActivityFeed>['events'][number]
  onClick: () => void
}) {
  const actor = ev.actorDisplayName ?? ev.actorHandle ?? t('Anonymous', 'Anonyme')
  const name = (typeof ev.payload?.name === 'string' && ev.payload.name)
    || (typeof ev.payload?.destination_name === 'string' && ev.payload.destination_name)
    || ''
  const country = extractCountry(name)
  const destShort = extractDestShort(name)
  const image = typeof ev.payload?.image === 'string' ? ev.payload.image : undefined
  const tier = typeof ev.payload?.tier === 'string' ? (ev.payload.tier as string) : undefined

  return (
    <button className="sidebar-row" onClick={onClick} title={`${name || actor} · ${actor}`}>
      <span
        className="sidebar-row-thumb"
        style={image
          ? { backgroundImage: `url(${image})` }
          : { background: `linear-gradient(135deg, ${ev.actorAvatarBg ?? 'var(--avatar-bg-default)'}, ${ev.actorAvatarBg ?? 'var(--avatar-bg-default)'})` }}
        aria-hidden="true"
      />
      <span className="sidebar-row-body">
        <strong>{destShort || name || renderShortLabel(ev.kind, name)}</strong>
        {country && <span className="sidebar-row-country">{country}</span>}
        <span className="sidebar-row-actor">{actor}</span>
      </span>
      {tier && <span className={`sidebar-row-tier tier-${tier.toLowerCase()}`}>{tier}</span>}
    </button>
  )
}

// "Tokyo, Japon" → { dest: "Tokyo", country: "Japon" }
function extractDestShort(fullName: string): string {
  const i = fullName.indexOf(',')
  return i > 0 ? fullName.slice(0, i).trim() : fullName
}
function extractCountry(fullName: string): string {
  const i = fullName.indexOf(',')
  return i > 0 ? fullName.slice(i + 1).trim() : ''
}

function renderShortLabel(kind: string, name: string): string {
  switch (kind) {
    case 'destination_added': return name ? `+ ${name}` : t('new destination', 'nouvelle destination')
    case 'tier_changed': return name ? `${t('moved', 'déplace')} ${name}` : t('tier change', 'déplacement de tier')
    case 'coup_de_coeur_set': return name ? `❤ ${name}` : t('favorite', 'coup de cœur')
    case 'roadtrip_created': return name ? `roadtrip ${name}` : t('new roadtrip', 'nouveau roadtrip')
    case 'roadtrip_stop_added': return name ? `${t('stop', 'étape')} ${name}` : t('new stop', 'nouvelle étape')
    case 'friendship_accepted': return t('new friend', 'nouvel ami')
    case 'mutual_destination': return name ? `${t('shared', 'partage')} ${name}` : t('shared destination', 'destination partagée')
    case 'milestone': return name ? `${t('milestone:', 'cap :')} ${name}` : t('reached a milestone', 'a atteint un cap')
    default: return kind
  }
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return t('just now', 'à l\'instant')
  if (min < 60) return t(`${min}m ago`, `il y a ${min} min`)
  const hr = Math.floor(min / 60)
  if (hr < 24) return t(`${hr}h ago`, `il y a ${hr} h`)
  const day = Math.floor(hr / 24)
  return t(`${day}d ago`, `il y a ${day} j`)
}
