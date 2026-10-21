import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent, PointerEvent } from 'react'
import type { Destination, Friendship, Tier } from '../types'
import { TIER_COLORS, TIER_ORDER } from '../data'
import { getDestinationScore, getDestinationTier } from '../utils'
import CompareWithFriendButton from './friends/CompareWithFriendButton'
import { SegmentedControl } from './SegmentedControl'
import { Avatar } from './Avatar'
import { t } from '../i18n'

interface TierListPanelProps {
  destinations: Destination[]
  collapsed: boolean
  coupDeCoeurCount: number
  maxCoupDeCoeur: number
  dockMode?: 'stacked-left' | 'bottom-left' | 'overlay-bottom'
  onCollapseToggle: () => void
  onFlyTo: (name: string) => void
  onCompareFriend?: (friend: Friendship) => void
  onMobileToggle?: () => void
  onViewTierList?: () => void
  onCompareOnTierList?: () => void
  onExitCompare?: () => void
  compareFriend?: Friendship | null
  compareFriendDestinations?: Destination[]
  compareFriendName?: string
  compareFriendAvatarUrl?: string | null
  compareCommonCount?: number
}

const tierLabels: Record<Tier, string> = {
  S: t('Gem', 'Pépite'),
  A: t('Great', 'Génial'),
  B: t('Nice', 'Sympa'),
  C: t('Mixed', 'Mitigé'),
  D: t('Not for me', 'Pas pour moi'),
}

type SortMode = 'score' | 'recent'

const sortLabels: Record<SortMode, string> = {
  score: t('Top rated', 'Meilleures notes'),
  recent: t('Most recent', 'Derniers voyages'),
}

const mobileSortLabels: Record<SortMode, string> = {
  score: t('By rating', 'Par note'),
  recent: t('By date', 'Par date'),
}

function destinationScore(destination: Destination) {
  return getDestinationScore(destination)
}

function compareDestinations(a: Destination, b: Destination, sortMode: SortMode) {
  const aScore = destinationScore(a)
  const bScore = destinationScore(b)

  if (sortMode === 'recent') {
    const aYear = a.tripYear ?? -Infinity
    const bYear = b.tripYear ?? -Infinity
    if (aYear !== bYear) return bYear - aYear
  }

  if (aScore !== bScore) return bScore - aScore
  return a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })
}

export default function TierListPanel({
  destinations,
  collapsed,
  coupDeCoeurCount,
  maxCoupDeCoeur,
  dockMode = 'overlay-bottom',
  onCollapseToggle,
  onFlyTo,
  onCompareFriend,
  onViewTierList,
  onCompareOnTierList,
  onExitCompare,
  compareFriend,
  compareFriendDestinations,
  compareFriendName,
  compareFriendAvatarUrl,
  compareCommonCount,
}: TierListPanelProps) {
  const tiersWithItems = TIER_ORDER.filter(tier =>
    destinations.some(d => getDestinationTier(d) === tier && d.kind !== 'stop')
  )
  const [mobileTier, setMobileTier] = useState<Tier | 'all'>('all')
  const [sortMode, setSortMode] = useState<SortMode>('score')
  const railRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef({ active: false, moved: false, startX: 0, scrollLeft: 0 })
  const suppressClickRef = useRef(false)
  const scrollFrameRef = useRef<number | null>(null)
  const [canScrollPrev, setCanScrollPrev] = useState(false)
  const [canScrollNext, setCanScrollNext] = useState(false)

  const updateRailControls = () => {
    const rail = railRef.current
    if (!rail) return
    const maxScroll = rail.scrollWidth - rail.clientWidth
    setCanScrollPrev(rail.scrollLeft > 2)
    setCanScrollNext(rail.scrollLeft < maxScroll - 2)
  }

  const scheduleRailControlsUpdate = () => {
    if (scrollFrameRef.current !== null) return
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null
      updateRailControls()
    })
  }

  useEffect(() => {
    updateRailControls()
    window.addEventListener('resize', updateRailControls)
    return () => {
      window.removeEventListener('resize', updateRailControls)
      if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
    }
  }, [destinations])

  const scrollRail = (direction: -1 | 1) => {
    const rail = railRef.current
    if (!rail) return
    rail.scrollBy({ left: direction * Math.round(rail.clientWidth * 0.72), behavior: 'smooth' })
  }

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    if (event.pointerType !== 'mouse') return
    if ((event.target as HTMLElement).closest('button')) return
    const rail = event.currentTarget
    dragRef.current = {
      active: true,
      moved: false,
      startX: event.clientX,
      scrollLeft: rail.scrollLeft,
    }
    rail.setPointerCapture(event.pointerId)
    rail.classList.add('is-grabbing')
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag.active) return
    const delta = event.clientX - drag.startX
    if (Math.abs(delta) > 6) drag.moved = true
    event.currentTarget.scrollLeft = drag.scrollLeft - delta
    scheduleRailControlsUpdate()
  }

  const endPointerDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag.moved) {
      suppressClickRef.current = true
      window.setTimeout(() => { suppressClickRef.current = false }, 0)
    }
    dragRef.current = { active: false, moved: false, startX: 0, scrollLeft: 0 }
    event.currentTarget.classList.remove('is-grabbing')
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    updateRailControls()
  }

  const handleRailClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return
    event.preventDefault()
    event.stopPropagation()
  }

  const sortControl = (className = '', compact = false) => (
    <div className={`tier-sort-toggle${className ? ` ${className}` : ''}`} role="group" aria-label={t('Sort tier list', 'Trier le classement')}>
      {(['score', 'recent'] as SortMode[]).map(mode => (
        <button
          key={mode}
          type="button"
          className={sortMode === mode ? 'is-active' : ''}
          aria-pressed={sortMode === mode}
          onClick={() => setSortMode(mode)}
        >
          {compact ? mobileSortLabels[mode] : sortLabels[mode]}
        </button>
      ))}
    </div>
  )

  const isComparing = Boolean(compareFriend && compareFriendDestinations)
  const rankedDestinationsCount = destinations.filter(d => d.kind !== 'stop').length
  const tierCounts = TIER_ORDER.map(tier => ({
    tier,
    count: destinations.filter(d => d.kind !== 'stop' && getDestinationTier(d) === tier).length,
  })).filter(item => item.count > 0)
  const friendTierCounts = compareFriendDestinations
    ? TIER_ORDER.map(tier => ({
        tier,
        count: compareFriendDestinations.filter(d => d.kind !== 'stop' && getDestinationTier(d) === tier).length,
      })).filter(item => item.count > 0)
    : null
  const renderTierChips = (counts: { tier: Tier; count: number }[]) =>
    counts.length > 0 ? counts.map(({ tier, count }) => (
      <span
        key={tier}
        className={`tier-board-collapsed-count tier-board-collapsed-count--${tier.toLowerCase()}`}
      >
        <span className="tier-board-collapsed-dot" aria-hidden="true" />
        {count}
      </span>
    )) : (
      <span className="tier-board-collapsed-count tier-board-collapsed-count--empty">0</span>
    )
  const unratedCount = destinations.filter(d => d.kind !== 'stop' && getDestinationTier(d) === null).length
  const unratedChip = unratedCount > 0 ? (
    <span
      className="tier-board-collapsed-count tier-board-collapsed-count--empty"
      aria-label={t(`${unratedCount} to rate`, `${unratedCount} à noter`)}
      title={t(`${unratedCount} to rate`, `${unratedCount} à noter`)}
    >
      ? {unratedCount}
    </span>
  ) : null
  const tierCountChips = tierCounts.length === 0 && unratedChip
    ? unratedChip
    : <>{renderTierChips(tierCounts)}{unratedChip}</>
  const favoriteChip = (
    <span
      className="tier-board-favorite-chip"
      aria-label={t(`${coupDeCoeurCount} favorites used out of ${maxCoupDeCoeur}`, `${coupDeCoeurCount} coups de cœur utilisés sur ${maxCoupDeCoeur}`)}
    >
      <span className="tier-board-favorite-chip-heart" aria-hidden="true">♥</span>
      {coupDeCoeurCount}/{maxCoupDeCoeur}
    </span>
  )

  const tierOptions = [
    { value: 'all' as const, label: t('All', 'Tous') },
    ...tiersWithItems.map(tier => ({
      value: tier,
      label: tier,
      accentColor: TIER_COLORS[tier].pin,
      ariaLabel: tierLabels[tier],
    })),
  ]

  const dockClass = dockMode === 'stacked-left'
    ? ' tier-board--stacked-left'
    : dockMode === 'bottom-left'
      ? ' tier-board--bottom-left'
      : ''

  return (
    <section className={`tier-board ${collapsed ? 'is-collapsed' : ''}${dockClass}`} aria-label={t('My rankings', 'Mon classement')}>
      {/* iOS drag handle — clickable to collapse/expand on mobile */}
      <button
        type="button"
        className="tier-board-handle"
        onClick={onCollapseToggle}
        aria-label={collapsed ? t('Expand', 'Déplier') : t('Collapse', 'Replier')}
      >
        <span className="tier-board-handle-bar" />
        {collapsed && (
          <span className="tier-board-collapsed-hint" aria-hidden="true">
            <span className="tier-board-collapsed-row">
              <span className="tier-board-collapsed-label">{t('My rankings', 'Mon classement')}</span>
              <span className="tier-board-collapsed-counts" aria-label={t('Summary by rating', 'Résumé par note')}>
                {tierCounts.length > 0 ? tierCounts.map(({ tier, count }) => (
                  <span
                    key={tier}
                    className={`tier-board-collapsed-count tier-board-collapsed-count--${tier.toLowerCase()}`}
                  >
                    <span className="tier-board-collapsed-dot" aria-hidden="true" />
                    {count}
                  </span>
                )) : (
                  <span className="tier-board-collapsed-count tier-board-collapsed-count--empty">0</span>
                )}
                {favoriteChip}
              </span>
            </span>
            {friendTierCounts && compareFriendName && (
              <span className="tier-board-collapsed-row tier-board-collapsed-row--friend">
                <span className="tier-board-collapsed-label tier-board-collapsed-label--friend">
                  {compareFriendAvatarUrl && (
                    <img src={compareFriendAvatarUrl} alt="" aria-hidden="true" className="tier-board-friend-avatar" />
                  )}
                  {compareFriendName}
                </span>
                <span className="tier-board-collapsed-counts">
                  {friendTierCounts.length > 0 ? friendTierCounts.map(({ tier, count }) => (
                    <span
                      key={tier}
                      className={`tier-board-collapsed-count tier-board-collapsed-count--${tier.toLowerCase()}`}
                    >
                      <span className="tier-board-collapsed-dot" aria-hidden="true" />
                      {count}
                    </span>
                  )) : (
                    <span className="tier-board-collapsed-count tier-board-collapsed-count--empty">0</span>
                  )}
                </span>
              </span>
            )}
          </span>
        )}
      </button>

      <div className="tier-board-head">
        <div className="tier-board-title">
          <h2>{t('My rankings', 'Mon classement')} <span>· {rankedDestinationsCount}</span></h2>
          {collapsed && (
            <div className="tier-board-title-counts" aria-label={t('Summary by rating', 'Résumé par note')}>
              {tierCountChips}
              {favoriteChip}
            </div>
          )}
        </div>
        <div className="tier-board-actions">
          {onCompareFriend && (
            <CompareWithFriendButton onPick={onCompareFriend} compact />
          )}
          <button
            className="next-control-inline next-control-inline--fold"
            aria-label={collapsed ? t('Expand rankings', 'Déplier le classement') : t('Collapse rankings', 'Replier le classement')}
            onClick={onCollapseToggle}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={collapsed ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'} />
            </svg>
            <span>{collapsed ? t('Expand', 'Déplier') : t('Collapse', 'Replier')}</span>
          </button>
        </div>
      </div>

      <div className="tier-desktop-tabs" aria-label={t('Filter by tier', 'Filtrer par tier')}>
        <SegmentedControl
          className="tier-desktop-tabs-list"
          ariaLabel={t('Filter by tier', 'Filtrer par tier')}
          role="radiogroup"
          size="sm"
          layout="hug"
          tone="tinted"
          value={mobileTier}
          options={tierOptions}
          onChange={setMobileTier}
        />
        {sortControl('tier-sort-toggle-desktop')}
      </div>

      {/* ── Mobile view: solo = chips only (static) · compare = unified panel ── */}
      <div className="tier-mobile-section">
        {!isComparing && (
          <div className="tier-mobile-topline">
            <div className="tier-mobile-title-row">
              <h2 className="tier-mobile-title">{t('My rankings', 'Mon classement')}</h2>
              <span className="tier-mobile-total-badge" aria-label={t(`${rankedDestinationsCount} ranked destinations`, `${rankedDestinationsCount} destinations classées`)}>
                {rankedDestinationsCount}
              </span>
            </div>
            <div className="tier-mobile-summary" aria-label={t('Summary by rating', 'Résumé par note')}>
              {tierCountChips}
              {favoriteChip}
            </div>
          </div>
        )}
        {isComparing && (
          <div className="tier-mobile-compare">
            <div className="tier-mobile-compare-legend">
              <span className="tier-mobile-compare-legend-item">
                <span className="compare-legend-dot compare-legend-dot--mine" aria-hidden="true" />
                {t('You', 'Toi')}
              </span>
              <span className="tier-mobile-compare-legend-item">
                {compareFriend ? (
                  <Avatar
                    className="compare-legend-dot compare-legend-dot--theirs"
                    avatarUrl={compareFriend.avatarUrl}
                    initials={(compareFriendName ?? compareFriend.displayName).slice(0, 1)}
                    bg={compareFriend.avatarBg}
                    fg={compareFriend.avatarFg}
                    ariaHidden
                  />
                ) : (
                  <span className="compare-legend-dot compare-legend-dot--theirs" aria-hidden="true" />
                )}
                {compareFriendName ?? t('Friend', 'Ami')}
              </span>
              {typeof compareCommonCount === 'number' && (
                <span className="tier-mobile-compare-legend-item">
                  <span className="compare-legend-dot compare-legend-dot--shared" aria-hidden="true" />
                  {compareCommonCount} {t('in common', 'en commun')}
                </span>
              )}
            </div>
            <div className="tier-mobile-compare-rows">
              <div className="tier-mobile-compare-row">
                <span className="tier-mobile-compare-who">{t('Me', 'Moi')}</span>
                <span className="tier-mobile-summary">{renderTierChips(tierCounts)}</span>
              </div>
              <div className="tier-mobile-compare-row tier-mobile-compare-row--friend">
                <span className="tier-mobile-compare-who">
                  {compareFriendAvatarUrl && (
                    <img src={compareFriendAvatarUrl} alt="" aria-hidden="true" className="tier-board-friend-avatar" />
                  )}
                  {compareFriendName ?? t('Friend', 'Ami')}
                </span>
                <span className="tier-mobile-summary">{renderTierChips(friendTierCounts ?? [])}</span>
              </div>
            </div>
            <div className="tier-mobile-compare-actions">
              {onExitCompare && (
                <button
                  type="button"
                  className="tier-mobile-compare-exit"
                  onClick={onExitCompare}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                  {t('Exit', 'Quitter')}
                </button>
              )}
              {onCompareOnTierList && (
                <button
                  type="button"
                  className="tier-mobile-compare-cta"
                  onClick={onCompareOnTierList}
                >
                  {t('Compare on the tier list', 'Comparer sur la tier list')}
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Desktop view: full tier columns ── */}
      <div className="tier-rail">
        <button
          className="tier-rail-control tier-rail-control-prev"
          aria-label={t('See previous tiers', 'Voir les tiers précédents')}
          disabled={!canScrollPrev}
          onClick={() => scrollRail(-1)}
        >
          <ChevronIcon direction="left" />
        </button>
        <div
          ref={railRef}
          className="tier-columns"
          onScroll={scheduleRailControlsUpdate}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endPointerDrag}
          onPointerCancel={endPointerDrag}
          onClickCapture={handleRailClickCapture}
        >
          {TIER_ORDER.map(tier => {
            const items = destinations
              .filter(destination => getDestinationTier(destination) === tier && destination.kind !== 'stop')
              .filter(() => mobileTier === 'all' || mobileTier === tier)
              .sort((a, b) => compareDestinations(a, b, sortMode))
            const colors = TIER_COLORS[tier]

            return (
              <article
                className={`tier-column tier-column-${tier.toLowerCase()}`}
                key={tier}
                style={{ '--tier-items': Math.max(items.length, 1) } as CSSProperties}
              >
                <header>
                  <strong style={{ color: colors.label }}>{tier}</strong>
                  <span style={{ color: colors.label }}>{tierLabels[tier]}</span>
                  <small>{items.length}</small>
                </header>
                <div className="destination-strip-wrap">
                  <div className="destination-strip">
                  {items.map(destination => {
                    const isCoupDeCoeur = Boolean(destination.coupDeCoeur)

                    return (
                      <article
                        className={`mini-destination ${isCoupDeCoeur ? 'is-coup-de-coeur' : ''}`}
                        key={destination.name}
                        style={{ backgroundImage: destination.image ? `url(${destination.image})` : undefined }}
                      >
                        <button
                          className="mini-destination-main"
                          onClick={() => onFlyTo(destination.name)}
                          aria-label={t(`View ${destination.name} on the map`, `Voir ${destination.name} sur la carte`)}
                        >
                          <span>{destination.name}</span>
                        </button>
                        {isCoupDeCoeur && (
                          <span className="mini-favorite-button is-active" aria-label={t('Favorite', 'Coup de coeur')} title={t('Favorite', 'Coup de coeur')}>
                            <HeartIcon filled />
                          </span>
                        )}
                      </article>
                    )
                  })}
                  </div>
                  {items.length > 3 && (
                    <span className="destination-strip-more">+{items.length - 3}</span>
                  )}
                </div>
              </article>
            )
          })}
        </div>
        <button
          className="tier-rail-control tier-rail-control-next"
          aria-label={t('See next tiers', 'Voir les tiers suivants')}
          disabled={!canScrollNext}
          onClick={() => scrollRail(1)}
        >
          <ChevronIcon direction="right" />
        </button>
      </div>

    </section>
  )
}

function ChevronIcon({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={direction === 'left' ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'} />
    </svg>
  )
}

function HeartIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.8 4.6a5.4 5.4 0 0 0-7.7 0L12 5.7l-1.1-1.1a5.4 5.4 0 0 0-7.7 7.7L12 21l8.8-8.7a5.4 5.4 0 0 0 0-7.7Z" />
    </svg>
  )
}
