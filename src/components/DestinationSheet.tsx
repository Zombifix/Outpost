import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Destination, Friendship, Tier } from '../types'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { TIER_COLORS } from '../data'
import { formatVisitCountLabel, getDestinationScore, getDestinationTier, getMaxCoupDeCoeur, getVisitCount } from '../utils'
import { findDestinationAtLocation, findRoadtripStopsAtLocation } from '../utils/duplicates'
import { Icon } from './Icon'
import { HeroImage } from './HeroImage'
import { useActivityFeed } from '../hooks/useActivityFeed'
import { getExperienceTagLabel, ROAD_TRIP_TAG_ID } from '../lib/experienceTags'
import { lang, t } from '../i18n'
import { AXIS_SHORT_LABELS, getAnswerParts } from '../lib/ratingQuestions'

interface DestinationSheetProps {
  destination: Destination
  coupDeCoeur: boolean
  coupDeCoeurCount: number
  allDestinations?: Destination[]
  compareWith?: {
    friend: Friendship
    mine?: Destination | null
    theirs: Destination
  }
  compareMode?: 'targeted' | 'global'
  onClose: () => void
  onFocus: () => void
  onCompareFriend?: (friendUserId: string) => void
  onExitCompare?: () => void
  onCoupDeCoeur: () => void
  onEdit: (destination: Destination) => void
  onDelete: (name: string) => void
  onOpenTrip?: (tripName: string) => void
}

interface FriendVisitor {
  userId: string
  displayName: string
  handle?: string
  bg?: string
  fg?: string
  tier?: Tier
}

type SnapState = 'peek' | 'full'

const PEEK_RATIO = 0.55
const FULL_RATIO = 0.08
const CLOSE_RATIO = 0.85

const COMPANION_LABELS: Record<NonNullable<Destination['companions']>, string> = {
  solo: t('Solo', 'Solo'),
  couple: t('Couple', 'En couple'),
  amis: t('Friends', 'Entre amis'),
  famille: t('Family', 'En famille'),
  travail: t('Work', 'Travail'),
}

function formatEuro(value: number) {
  return `${Math.round(value).toLocaleString('en-US')} EUR`
}

// Accueil (vibeBoost), verdict (retourBonus) et retour (returnIntent) du
// wizard, affichés en pastilles dans le hero. Cf. docs/notation-v2.md.
type HeroPill = { emoji: string; label: string; tone: 'positive' | 'neutral' | 'negative' }

function getFeelingPill(destination: Destination): HeroPill | null {
  const v = destination.vibeBoost
  if (typeof v !== 'number') return null
  if (v >= 5) return { emoji: '🥰', label: t('Lovely people', 'Des gens adorables'), tone: 'positive' }
  if (v >= 4) return { emoji: '👍', label: t('Good vibe', 'Bonne ambiance'), tone: 'positive' }
  if (v >= 3) return null
  if (v >= 2) return { emoji: '🥶', label: t('People a bit cold', 'Accueil plutôt froid'), tone: 'neutral' }
  return { emoji: '⚠️', label: t('Didn\'t feel safe', 'Pas en sécurité'), tone: 'negative' }
}

function getRecoPill(destination: Destination): HeroPill | null {
  const v = destination.retourBonus
  if (typeof v !== 'number') return null
  if (v >= 0.3) return { emoji: '💌', label: t('Go for it', 'Fonce'), tone: 'positive' }
  if (v >= 0.1) return { emoji: '👍', label: t('Worth it', 'Ça vaut le coup'), tone: 'positive' }
  if (v <= -0.3) return { emoji: '🙅', label: t('Skip it', 'À éviter'), tone: 'negative' }
  return { emoji: '🤷', label: t('There\'s better', 'Il y a mieux'), tone: 'neutral' }
}

function getReturnPill(destination: Destination): HeroPill | null {
  if (destination.returnIntent === 'tomorrow') return { emoji: '🛫', label: t('Would go back tomorrow', 'Y retournerait demain'), tone: 'positive' }
  if (destination.returnIntent === 'once') return { emoji: '✅', label: t('Once was enough', 'Une fois suffit'), tone: 'neutral' }
  return null
}

/** Pastilles du haut de la fiche : deux au plus, pour ne pas recouvrir la photo. */
function getHeroPills(destination: Destination): HeroPill[] {
  return [getRecoPill(destination), getReturnPill(destination)].filter((p): p is HeroPill => p !== null)
}

function getFeelingRecoPills(destination: Destination): HeroPill[] {
  return [getRecoPill(destination), getReturnPill(destination), getFeelingPill(destination)].filter((p): p is HeroPill => p !== null)
}

type ContextDetail =
  | { kind: 'text'; icon: string; label: string; value: string }
  | { kind: 'chips'; icon: string; label: string; chips: Array<{ label: string; tone: 'neutral' | 'positive' | 'negative' }> }

type ContextChip = Extract<ContextDetail, { kind: 'chips' }>['chips'][number]

const NEGATIVE_TAG_LABELS = new Set([
  // labels actuels (avec emoji)
  '⚠️ Craignos', '📉 Surcoté', '💰 Trop cher', '🚇 Transports galère',
  '📍 Trop touristique', '🪤 Pièges à touristes',
  // labels legacy
  'Budget qui pique', 'Transports galere', 'La foule', 'Pieges a touristes',
  'Rythme epuisant', 'Meteo capricieuse',
])

// Dans la famille "tourisme négatif", si Trop touristique ou Surcoté est déjà affiché,
// Pièges à touristes est redondant — on le masque.
const TOURISM_FAMILY_DISPLAY = new Set(['📍 Trop touristique', '📉 Surcoté', '🪤 Pièges à touristes'])
const TOURISM_REDUNDANT = new Set(['🪤 Pièges à touristes', 'Pieges a touristes'])

function filterDisplayTags(tags: string[]): string[] {
  const negative = tags.filter(t => NEGATIVE_TAG_LABELS.has(t))
  const positive = tags.filter(t => !NEGATIVE_TAG_LABELS.has(t))

  // Déduplication famille tourisme
  const tourismPresent = negative.filter(t => TOURISM_FAMILY_DISPLAY.has(t))
  const hasNonRedundantTourism = tourismPresent.some(t => !TOURISM_REDUNDANT.has(t))
  const filteredNegative = hasNonRedundantTourism
    ? negative.filter(t => !TOURISM_REDUNDANT.has(t))
    : negative

  const keptNegative = filteredNegative.slice(0, 2)
  const keptPositive = positive.slice(0, 5 - keptNegative.length)
  return [...keptPositive, ...keptNegative]
}

// Gardé pour rétro-compat (tone negative sur les chips)
const STANDOUT_FLOP_LABELS = NEGATIVE_TAG_LABELS
const MAX_COLLAPSED_CONTEXT_CHIPS = 3

function normalizeTagPriorityText(label: string) {
  return label
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .trim()
}

function getTagScoreImpact(label: string) {
  const normalized = normalizeTagPriorityText(label)

  if (normalized.includes('craignos')) return -0.45
  if (normalized.includes('surcote')) return -0.28
  if (normalized.includes('trop cher')) return -0.22
  if (normalized.includes('pieges a touristes')) return -0.20
  if (normalized.includes('transports galere') || normalized.includes('transports galre')) return -0.18
  if (normalized.includes('pas cher')) return 0.12
  if (normalized.includes('facile a vivre')) return 0.10
  if (normalized.includes('beau partout') || normalized.includes('patrimoine marquant')) return 0.10
  if (normalized.includes('ambiance locale') || normalized.includes('ville a flaner') || normalized.includes('ville a flaneur')) return 0.08
  if (normalized.includes('trop touristique')) return -0.10
  if (normalized.includes('belle surprise')) return 0.15

  return 0
}

function prioritizeContextChips(chips: ContextChip[]) {
  return chips
    .map((chip, index) => ({ chip, index, scoreImpact: getTagScoreImpact(chip.label) }))
    .sort((a, b) => {
      const impactDelta = Math.abs(b.scoreImpact) - Math.abs(a.scoreImpact)
      if (impactDelta !== 0) return impactDelta
      const signDelta = b.scoreImpact - a.scoreImpact
      if (signDelta !== 0) return signDelta
      return a.index - b.index
    })
    .map(({ chip }) => chip)
}

function getDestinationContext(destination: Destination) {
  const meta: Array<{ icon: string; label: string }> = []
  const details: ContextDetail[] = []
  const visitCount = getVisitCount(destination)

  if (destination.tripYear) {
    meta.push({ icon: 'calendar', label: String(destination.tripYear) })
  }
  if (destination.tripDays) {
    meta.push({ icon: 'clock', label: `${destination.tripDays} ${t('day', 'jour')}${destination.tripDays > 1 ? 's' : ''}` })
  }
  if (visitCount > 1) {
    meta.push({ icon: 'flame', label: formatVisitCountLabel(visitCount, lang) })
  }
  if (destination.personalBudget) {
    const perDay = destination.tripDays ? destination.personalBudget / destination.tripDays : destination.personalBudget
    meta.push({
      icon: 'coins',
      label: destination.tripDays ? `~${formatEuro(perDay)}${t('/day', '/jour')}` : `~${formatEuro(destination.personalBudget)}`,
    })
  }
  if (destination.companions) {
    details.push({
      kind: 'chips',
      icon: 'users',
      label: t('With', 'Avec'),
      chips: [{ label: COMPANION_LABELS[destination.companions], tone: 'neutral' as const }],
    })
  }
  if (destination.tripTypes?.length) {
    details.push({
      kind: 'chips',
      icon: 'sliders',
      label: t('Tags', 'Tags'),
      chips: prioritizeContextChips(destination.tripTypes.map(id => ({ label: getExperienceTagLabel(id), tone: 'neutral' as const }))),
    })
  }
  const standoutRaw = destination.standoutTags?.length ? destination.standoutTags : destination.standout ? [destination.standout] : []
  const standoutValues = filterDisplayTags(standoutRaw)
  if (standoutValues.length) {
    details.push({
      kind: 'chips',
      icon: 'sparkles',
      label: t('Highlights', 'Points marquants'),
      chips: prioritizeContextChips(standoutValues.map(label => ({
        label,
        tone: STANDOUT_FLOP_LABELS.has(label) ? ('negative' as const) : ('positive' as const),
      }))),
    })
  }

  return { meta, details, hasContext: meta.length > 0 || details.length > 0 }
}

type CriterionKey = 'food' | 'night' | 'culture' | 'nature' | 'vibeBoost' | 'value' | 'ease'

const CRITERION_LABELS: Record<CriterionKey, string> = {
  food: AXIS_SHORT_LABELS.food,
  night: AXIS_SHORT_LABELS.night,
  culture: AXIS_SHORT_LABELS.culture,
  nature: AXIS_SHORT_LABELS.nature,
  vibeBoost: AXIS_SHORT_LABELS.vibeBoost,
  value: AXIS_SHORT_LABELS.value,
  ease: AXIS_SHORT_LABELS.ease,
}

// Axes qui peuvent émerveiller : leur meilleure réponse est mise en avant
// (même règle que le calcul, cf. computeTierBreakdown dans src/utils.ts).
const WOW_CRITERIA = new Set<CriterionKey>(['culture', 'nature', 'food', 'night', 'vibeBoost'])

function AnswerTiles({ criteria }: { criteria: ReturnType<typeof getCriteria> }) {
  return (
    <div className="answer-tiles">
      {criteria.map(([key, value, icon]) => {
        const parts = getAnswerParts(key, value)
        const tone = value >= 5 && WOW_CRITERIA.has(key) ? 'wow' : value <= 1 ? 'flop' : 'neutral'
        return (
          <div className={`answer-tile answer-tile--${tone}`} key={key}>
            <span className="answer-tile-emoji" aria-hidden="true">
              {parts?.emoji || <Icon name={icon} />}
            </span>
            <span className="answer-tile-body">
              <span className="answer-tile-axis">{CRITERION_LABELS[key]}</span>
              <strong className="answer-tile-text">
                {parts ? parts.text : Number(value).toFixed(1).replace('.', ',')}
              </strong>
            </span>
          </div>
        )
      })}
    </div>
  )
}

const CRITERION_ICONS: Record<CriterionKey, string> = {
  food: 'utensils',
  night: 'martini',
  culture: 'temple',
  nature: 'mountain',
  vibeBoost: 'users',
  value: 'coins',
  ease: 'compass',
}

const CRITERION_KEYS: CriterionKey[] = ['culture', 'nature', 'food', 'night', 'vibeBoost', 'ease', 'value']

function getCriteria(destination: Destination) {
  const base: Array<[CriterionKey, number, string]> = []
  for (const key of CRITERION_KEYS) {
    const value = destination[key]
    if (typeof value === 'number') base.push([key, value, CRITERION_ICONS[key]])
  }
  return base
}

type CompareCriterion = {
  key: CriterionKey
  icon: string
  mine: number
  theirs: number
  gap: number
}

function getComparableCriteria(destination: Destination, compareDestination: Destination): CompareCriterion[] {
  const mine = new Map(getCriteria(destination).map(([key, value, icon]) => [key, { value, icon }]))
  return getCriteria(compareDestination).flatMap(([key, compareValue]) => {
    const current = mine.get(key)
    if (!current) return []
    return [{
      key,
      icon: current.icon,
      mine: current.value,
      theirs: compareValue,
      gap: Math.abs(current.value - compareValue),
    }]
  })
}

type CompareBuckets = {
  aligned: CompareCriterion[]
  close: CompareCriterion[]
  gaps: CompareCriterion[]
}

function classifyCompareCriteria(items: CompareCriterion[]): CompareBuckets {
  return {
    aligned: items.filter(item => item.gap === 0),
    close: items.filter(item => item.gap === 1),
    gaps: items.filter(item => item.gap >= 2).sort((a, b) => b.gap - a.gap),
  }
}

function getGapIndicator(gap: number) {
  if (gap === 0) return { symbol: '🤝', tone: 'aligned', label: t('Aligned', 'Alignés') }
  if (gap === 1) return { symbol: '≈', tone: 'close', label: t('Close', 'Proches') }
  if (gap === 2) return { symbol: '!', tone: 'gap', label: t('Notable gap', 'Écart notable') }
  return { symbol: '‼', tone: 'big-gap', label: t('Big gap', 'Gros écart') }
}

function formatCriterionList(items: CompareCriterion[]) {
  const labels = items.map(item => CRITERION_LABELS[item.key].toLowerCase())
  if (labels.length <= 1) return labels.join('')
  return `${labels.slice(0, -1).join(', ')} ${t('and', 'et')} ${labels[labels.length - 1]}`
}

function getCompareInsight(buckets: CompareBuckets) {
  const alignedish = [...buckets.aligned, ...buckets.close]
  const gapCount = buckets.gaps.length
  const headline = gapCount === 0
    ? t('Same city, same eyes.', 'Même ville, mêmes yeux.')
    : gapCount >= alignedish.length
      ? t('Two very different trips.', 'Deux voyages très différents.')
      : t('Same city, different reasons.', 'Même ville, autres raisons.')

  const parts: string[] = []
  if (alignedish.length > 0) {
    parts.push(t(
      `You align on ${formatCriterionList(alignedish)}.`,
      `Vous vous rejoignez sur ${formatCriterionList(alignedish)}.`
    ))
  }
  if (buckets.gaps.length > 0) {
    parts.push(t(
      `Biggest gaps: ${formatCriterionList(buckets.gaps)}.`,
      `Plus gros écarts : ${formatCriterionList(buckets.gaps)}.`
    ))
  }

  const footer = t(
    `${buckets.aligned.length} aligned · ${buckets.close.length} close · ${buckets.gaps.length} gaps`,
    `${buckets.aligned.length} alignés · ${buckets.close.length} proches · ${buckets.gaps.length} écarts`
  )

  return { headline, sentence: parts.join(' '), footer }
}

function getCompareTags(destination: Destination, compareDestination: Destination) {
  const mine = destination.standoutTags?.length ? destination.standoutTags : destination.standout ? [destination.standout] : []
  const theirs = compareDestination.standoutTags?.length ? compareDestination.standoutTags : compareDestination.standout ? [compareDestination.standout] : []
  const mineSet = new Set(mine)
  const theirSet = new Set(theirs)
  return {
    common: mine.filter(tag => theirSet.has(tag)),
    mineOnly: mine.filter(tag => !theirSet.has(tag)),
    theirsOnly: theirs.filter(tag => !mineSet.has(tag)),
  }
}


function formatScore(destination: Destination) {
  if (!getDestinationTier(destination)) return '–'
  return getDestinationScore(destination)
    .toFixed(1)
    .replace('.', t('.', ','))
}

function getDisplayTier(destination: Destination) {
  return getDestinationTier(destination)
}

function isRoadTripTagged(destination: Destination) {
  return Boolean(destination.tripTypes?.includes(ROAD_TRIP_TAG_ID))
}

function hasRenderableStops(destination: Destination) {
  return isRoadTripTagged(destination) && Boolean(destination.stops?.some(stop => stop.name.trim() && Number.isFinite(stop.lat) && Number.isFinite(stop.lng)))
}

export default function DestinationSheet(props: DestinationSheetProps) {
  const isComparison = Boolean(props.compareWith)
  const useSheetLayout = useMediaQuery(isComparison ? '(max-width: 1100px)' : '(max-width: 768px)')

  if (useSheetLayout) return <MobileSheet {...props} />
  return (
    <aside className={`destination-card${isComparison ? ' is-comparison' : ''}`} aria-label={t(`Details: ${props.destination.name}`, `Détail de ${props.destination.name}`)}>
      <DestinationCardContent {...props} />
    </aside>
  )
}

function ContextBlock({ context, className, ariaLabel }: {
  context: ReturnType<typeof getDestinationContext>
  className?: string
  ariaLabel: string
}) {
  const hasPairedChipColumns = context.details.some(item => item.kind === 'chips' && item.icon === 'sliders')
    && context.details.some(item => item.kind === 'chips' && item.icon === 'sparkles')

  return (
    <div className={`destination-context${className ? ` ${className}` : ''}`} aria-label={ariaLabel}>
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
        <div className={`destination-context-details${hasPairedChipColumns ? ' destination-context-details--paired-chips' : ''}`}>
          {context.details.map(item => (
            <div
              key={`${item.icon}-${item.label}`}
              className={[
                'destination-context-row',
                item.kind === 'chips' ? 'destination-context-row--chips' : '',
                hasPairedChipColumns && item.icon !== 'sliders' && item.icon !== 'sparkles' ? 'destination-context-row--span-full' : '',
              ].filter(Boolean).join(' ')}
            >
              <div className="destination-context-row-head">
                <Icon name={item.icon} />
                {item.label && <span className="destination-context-row-label">{item.label}</span>}
              </div>
              {item.kind === 'text' ? (
                <strong className="destination-context-row-value">{item.value}</strong>
              ) : (
                <ContextChipGroup chips={item.chips} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ContextChipGroup({ chips }: { chips: ContextChip[] }) {
  const [expanded, setExpanded] = useState(false)
  const hasOverflow = chips.length > MAX_COLLAPSED_CONTEXT_CHIPS
  const hiddenCount = Math.max(0, chips.length - MAX_COLLAPSED_CONTEXT_CHIPS)
  const visibleChips = hasOverflow && !expanded
    ? chips.slice(0, MAX_COLLAPSED_CONTEXT_CHIPS)
    : chips

  return (
    <div className="destination-context-chips">
      {visibleChips.map(chip => (
        <span
          key={chip.label}
          className={`destination-context-chip destination-context-chip--${chip.tone}`}
        >
          {chip.label}
        </span>
      ))}
      {hasOverflow && (
        <button
          type="button"
          className="destination-context-chip destination-context-chip--toggle"
          aria-expanded={expanded}
          aria-label={
            expanded
              ? t('Collapse tags', 'Réduire les tags')
              : t(`Show ${hiddenCount} more tags`, `Afficher ${hiddenCount} tags en plus`)
          }
          onClick={() => setExpanded(value => !value)}
        >
          {expanded ? <Icon name="chevron-up" /> : `+${hiddenCount}`}
        </button>
      )}
    </div>
  )
}

type DragState = { startY: number; lastY: number; lastT: number; v: number; current: number } | null

function MobileSheet(props: DestinationSheetProps) {
  const isComparison = Boolean(props.compareWith)
  const sheetRef = useRef<HTMLElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [snap, setSnap] = useState<SnapState>(isComparison ? 'full' : 'peek')
  const dragRef = useRef<DragState>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [dragOffset, setDragOffset] = useState(0)

  // A comparison needs its full reading surface; a regular card keeps the peek affordance.
  useEffect(() => {
    setSnap(isComparison ? 'full' : 'peek')
    setDragOffset(0)
  }, [props.destination.name, isComparison])

  // Lock body scroll while sheet open
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    const t = e.target as HTMLElement
    // Initiate drag only from the handle bar or the hero image area; never from
    // inner scrollable content so vertical scroll inside the sheet still works.
    if (!t.closest('.destination-sheet-handle, .destination-hero')) return
    const captureTarget = e.currentTarget as HTMLElement
    try { captureTarget.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    dragRef.current = { startY: e.clientY, lastY: e.clientY, lastT: performance.now(), v: 0, current: 0 }
    setIsDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const delta = e.clientY - d.startY
    const now = performance.now()
    const dt = now - d.lastT
    const v = dt > 0 ? (e.clientY - d.lastY) / dt : 0
    dragRef.current = { ...d, lastY: e.clientY, lastT: now, v, current: delta }
    setDragOffset(delta)
  }

  const onPointerUp = () => {
    const d = dragRef.current
    if (!d) return
    const vh = window.innerHeight
    const moved = Math.abs(d.current)
    const baseTop = snap === 'peek' ? vh * PEEK_RATIO : vh * FULL_RATIO
    const finalTop = baseTop + d.current
    const velocity = d.v

    dragRef.current = null
    setIsDragging(false)
    setDragOffset(0)

    if (moved < 6) {
      setSnap(s => (s === 'peek' ? 'full' : 'peek'))
      return
    }

    if (snap === 'peek') {
      if (finalTop > vh * 0.68 || velocity > 0.5) { props.onClose(); return }
      if (velocity < -0.6) { setSnap('full'); return }
      return
    }

    if (finalTop > vh * CLOSE_RATIO || velocity > 1.0) { props.onClose(); return }
    if (velocity < -0.6) { setSnap('full'); return }
    if (velocity > 0.6) { setSnap('peek'); return }
    const midpoint = vh * ((PEEK_RATIO + FULL_RATIO) / 2)
    setSnap(finalTop < midpoint ? 'full' : 'peek')
  }

  const style: React.CSSProperties = isDragging
    ? { transform: `translateY(${dragOffset}px)`, transition: 'none' }
    : {}

  return (
    <div className="destination-sheet-backdrop" onClick={props.onClose} role="presentation">
      <aside
        ref={sheetRef}
        className={`destination-sheet is-${snap}${isComparison ? ' is-comparison' : ''}${isDragging ? ' is-dragging' : ''}`}
        aria-label={t(`Details: ${props.destination.name}`, `Détail de ${props.destination.name}`)}
        onClick={e => e.stopPropagation()}
        style={style}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <button
          type="button"
          className="destination-sheet-handle"
          aria-label={snap === 'peek' ? t('Expand', 'Agrandir') : t('Collapse', 'Réduire')}
          onClick={() => setSnap(s => s === 'peek' ? 'full' : 'peek')}
        >
          <span className="destination-sheet-grabber" />
        </button>
        <div className="destination-sheet-body" ref={bodyRef}>
          <DestinationCardContent {...props} />
        </div>
      </aside>
    </div>
  )
}

function DestinationCardContent({
  destination,
  coupDeCoeur,
  coupDeCoeurCount,
  allDestinations,
  compareMode,
  onClose,
  onFocus,
  onCompareFriend,
  onExitCompare,
  onCoupDeCoeur,
  onEdit,
  onDelete,
  onOpenTrip,
  compareWith,
}: DestinationSheetProps) {
  const isMobileContext = useMediaQuery('(max-width: 768px)')
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [visitorPickerOpen, setVisitorPickerOpen] = useState(false)
  const visitorPickerRef = useRef<HTMLDivElement | null>(null)
  const mineDestination = compareWith?.mine ?? null
  const compareDestination = compareWith?.theirs ?? null
  const isFriendOnlyComparison = Boolean(compareWith && !mineDestination && compareDestination)
  const canEditOwnDestination = !isFriendOnlyComparison
  const context = getDestinationContext(destination)
  const criteria = getCriteria(destination)
  const compareCriteria = useMemo(
    () => mineDestination && compareDestination ? getComparableCriteria(mineDestination, compareDestination) : [],
    [mineDestination, compareDestination]
  )
  const compareTags = useMemo(
    () => mineDestination && compareDestination ? getCompareTags(mineDestination, compareDestination) : { common: [], mineOnly: [], theirsOnly: [] },
    [mineDestination, compareDestination]
  )
  const compareInsight = useMemo(
    () => getCompareInsight(classifyCompareCriteria(compareCriteria)),
    [compareCriteria]
  )
  const mineContext = useMemo(
    () => (mineDestination ? getDestinationContext(mineDestination) : null),
    [mineDestination]
  )
  const displayTier = getDisplayTier(destination)

  const tripStopsHere = useMemo(() => {
    if (!allDestinations?.length) return []
    if (destination.kind === 'zone' || destination.kind === 'stop') return []
    return findRoadtripStopsAtLocation(destination, allDestinations.filter(isRoadTripTagged), destination.name)
  }, [destination, allDestinations])

  const tripsHereByName = useMemo(() => {
    const map = new Map<string, { stages: number[]; color: string }>()
    for (const m of tripStopsHere) {
      const trip = allDestinations?.find(d => d.name === m.tripName)
      const tripTier = trip ? getDisplayTier(trip) : undefined
      const tierColor = tripTier ? TIER_COLORS[tripTier]?.pin : undefined
      const entry = map.get(m.tripName) ?? { stages: [], color: tierColor ?? 'var(--purple)' }
      if (m.stageNumber !== undefined) entry.stages.push(m.stageNumber)
      map.set(m.tripName, entry)
    }
    return Array.from(map.entries())
  }, [tripStopsHere, allDestinations])

  // Amis qui ont aussi visitÃ© cette destination (events destination_added).
  // Lit le feed dÃ©jÃ  chargÃ© (60 events) â€" pas de requÃªte supplÃ©mentaire.
  const { events: activityEvents } = useActivityFeed(60)
  const friendVisitors = useMemo(() => {
    const targetName = destination.name.toLowerCase().trim()
    const seen = new Map<string, FriendVisitor>()
    for (const ev of activityEvents) {
      if (ev.kind !== 'destination_added') continue
      const evName = (typeof ev.payload?.name === 'string' ? ev.payload.name : '')
        || (typeof ev.payload?.destination_name === 'string' ? ev.payload.destination_name : '')
      if (!evName || evName.toLowerCase().trim() !== targetName) continue
      if (seen.has(ev.actor)) continue
      const payloadTier = typeof ev.payload?.tier === 'string' && ['S', 'A', 'B', 'C', 'D'].includes(ev.payload.tier)
        ? ev.payload.tier as Tier
        : undefined
      seen.set(ev.actor, {
        userId: ev.actor,
        displayName: ev.actorDisplayName ?? ev.actorHandle ?? t('A friend', 'Un ami'),
        handle: ev.actorHandle,
        bg: ev.actorAvatarBg,
        fg: ev.actorAvatarFg,
        tier: payloadTier,
      })
    }
    return Array.from(seen.values())
  }, [activityEvents, destination.name])
  const compareableVisitor = !compareWith && friendVisitors.length === 1 ? friendVisitors[0] : null
  const hasMultipleVisitors = !compareWith && friendVisitors.length > 1
  const hasSingleCompareVisitorCta = Boolean(compareableVisitor && onCompareFriend)
  const firstName = compareWith?.friend.displayName.split(' ')[0] ?? ''

  const closeMenu = () => { setMenuOpen(false); setConfirmDelete(false) }
  const maxCoupDeCoeur = getMaxCoupDeCoeur(allDestinations?.length ?? 0)
  const coupDeCoeurDisabled = !coupDeCoeur && coupDeCoeurCount >= maxCoupDeCoeur

  useEffect(() => {
    setVisitorPickerOpen(false)
  }, [destination.name, compareWith])

  useEffect(() => {
    if (!visitorPickerOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (visitorPickerRef.current?.contains(event.target as Node)) return
      setVisitorPickerOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setVisitorPickerOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [visitorPickerOpen])

  const cardActions = (
    <div className="destination-card-actions">
      <div className="floating-kebab-wrap">
        <button
          className={`card-kebab${menuOpen ? ' is-open' : ''}`}
          aria-label={t('Options', 'Options')}
          aria-expanded={menuOpen}
          onClick={() => { setMenuOpen(v => !v); setConfirmDelete(false) }}
        >
          <Icon name="more-vertical" />
        </button>
        {menuOpen && !confirmDelete && (
          <div className="card-kebab-menu">
            <button onClick={() => { closeMenu(); onFocus() }}>
              <Icon name="map" />
              {t('Focus on map', 'Centrer sur la carte')}
            </button>
            {canEditOwnDestination && (
              <button onClick={() => { closeMenu(); onEdit(destination) }}>
                <Icon name="edit" />
                {t('Edit', 'Modifier')}
              </button>
            )}
            {canEditOwnDestination && (
              <button className="danger" onClick={() => setConfirmDelete(true)}>
                <Icon name="trash" />
                {t('Delete', 'Supprimer')}
              </button>
            )}
          </div>
        )}
        {menuOpen && confirmDelete && (
          <div className="card-kebab-menu card-delete-confirm">
            <p>{t('Delete', 'Supprimer')} <strong>{destination.name}</strong>{t('?', ' ?')}</p>
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
  )

  return (
    <>
      {destination.kind === 'zone' && hasRenderableStops(destination) ? (
        <RoadTripCardContent
          destination={destination}
          coupDeCoeur={coupDeCoeur}
          coupDeCoeurDisabled={coupDeCoeurDisabled}
          coupDeCoeurCount={coupDeCoeurCount}
          canEditOwnDestination={canEditOwnDestination}
          context={context}
          criteria={criteria}
          allDestinations={allDestinations}
          onCoupDeCoeur={onCoupDeCoeur}
          onOpenDestination={onOpenTrip}
          cardActions={cardActions}
        />
      ) : (
        <>
      <div className="destination-hero-wrap">
      <div className="destination-hero">
        {destination.image && (
          <HeroImage src={destination.image} />
        )}
        <span className={`tier-orb destination-hero-badge tier-${displayTier ? displayTier.toLowerCase() : 'unrated'}`}>{displayTier ?? '?'}</span>
        <div className="destination-hero-overlay">
        <h2 className="destination-hero-title">
          {destination.name}{destination.country && destination.country !== destination.name ? `, ${destination.country}` : ''}
        </h2>
        <div className="destination-hero-pills">
          {compareWith && (
            <span className="intent-pill destination-hero-pill">
              <Icon name="users" />
              {t('You', 'Toi')} + {compareWith.friend.displayName.split(' ')[0]}
            </span>
          )}
          {getHeroPills(destination).map(pill => (
            <span key={pill.label} className={`intent-pill destination-hero-pill destination-hero-pill--${pill.tone}`}>
              <span aria-hidden="true">{pill.emoji}</span>
              {pill.label}
            </span>
          ))}
          {canEditOwnDestination && coupDeCoeur && (
            <button
              className="coup-de-coeur-button destination-hero-favorite is-active"
              aria-label={t('Remove from favorites', 'Retirer des coups de cœur')}
              title={t('Favorite — remove', 'Coup de cœur — retirer')}
              onClick={onCoupDeCoeur}
            >
              <Icon name="heart" />
              {t('Favorite', 'Coup de cœur')}
            </button>
          )}
        </div>
        </div>
      </div>
      {cardActions}
      </div>
      <div className="destination-body-sheet">
      {!displayTier && canEditOwnDestination && (
        <button type="button" className="wizard-submit sheet-rate-cta" onClick={() => onEdit(destination)}>
          {t('Rate this trip', 'Noter ce voyage')}
        </button>
      )}
      {compareWith && (
        <section className="sheet-compare-banner" aria-label={t('Comparison in progress', 'Comparaison en cours')}>
          <div className="sheet-compare-banner-copy">
            <span
              className="compare-banner-avatar"
              style={{ background: compareWith.friend.avatarBg, color: compareWith.friend.avatarFg }}
              aria-hidden="true"
            >
              {compareWith.friend.avatarUrl
                ? <img src={compareWith.friend.avatarUrl} alt="" />
                : (firstName.slice(0, 1).toUpperCase() || '?')}
            </span>
            <div className="sheet-compare-banner-text">
              <strong>{t('Comparing with', 'Comparaison avec')} {firstName}</strong>
              {isFriendOnlyComparison && compareDestination && (
                <small>
                  {t(
                    `${compareWith.friend.displayName.split(' ')[0]} has been to ${compareDestination.name}. You have not visited or rated this destination yet.`,
                    `${compareWith.friend.displayName.split(' ')[0]} est allé à ${compareDestination.name}. Tu n’as pas encore visité ou noté cette destination.`
                  )}
                </small>
              )}
            </div>
          </div>
          {onExitCompare && (
            <button
              type="button"
              className="sheet-compare-banner-action"
              onClick={onExitCompare}
            >
              {t('Exit', 'Quitter')}
            </button>
          )}
        </section>
      )}
      {!compareWith && friendVisitors.length > 0 && (
        <div
          className={`friend-visitors${hasSingleCompareVisitorCta ? ' friend-visitors--single-compare' : ''}${visitorPickerOpen ? ' is-popover-open' : ''}`}
          aria-label={t("Friends who've been there", 'Amis qui y sont allés')}
          ref={visitorPickerRef}
        >
          <button
            type="button"
            className={`friend-visitors-avatars friend-visitors-avatars-btn${hasMultipleVisitors ? ' is-interactive' : ''}`}
            onClick={() => {
              if (compareableVisitor && onCompareFriend) onCompareFriend(compareableVisitor.userId)
              else if (hasMultipleVisitors) setVisitorPickerOpen(value => !value)
            }}
            aria-haspopup={hasMultipleVisitors ? 'menu' : undefined}
            aria-expanded={hasMultipleVisitors ? visitorPickerOpen : undefined}
            disabled={!compareableVisitor && !hasMultipleVisitors}
          >
            {friendVisitors.slice(0, 3).map((v, i) => (
              <span
                key={i}
                className="friend-visitors-avatar"
                style={{ background: v.bg ?? 'var(--avatar-bg-default)', color: v.fg ?? 'var(--avatar-fg-default)' }}
                title={v.displayName}
              >
                {v.displayName.slice(0, 1).toUpperCase()}
              </span>
            ))}
          </button>
          <span className="friend-visitors-text">
            {friendVisitors.length === 1
              ? <><strong>{friendVisitors[0].displayName}</strong> {t('has been there', 'y est déjà allé')}</>
              : friendVisitors.length <= 3
                ? <>{friendVisitors.slice(0, -1).map(v => v.displayName).join(', ')} {t('and', 'et')} <strong>{friendVisitors[friendVisitors.length - 1].displayName}</strong> {t('have been there', 'y sont déjà allés')}</>
                : <><strong>{friendVisitors[0].displayName}</strong>, {friendVisitors[1].displayName} {t('and', 'et')} {friendVisitors.length - 2} {t('other', 'autre')}{friendVisitors.length - 2 > 1 ? 's' : ''} {t('have been there', 'y sont déjà allés')}</>
            }
          </span>
          {compareableVisitor && onCompareFriend && (
            <button
              type="button"
              className="friend-visitors-action"
              onClick={() => onCompareFriend(compareableVisitor.userId)}
            >
              {isMobileContext
                ? t('Compare', 'Comparer')
                : t(
                    `Compare with ${compareableVisitor.displayName.split(' ')[0]}`,
                    `Comparer avec ${compareableVisitor.displayName.split(' ')[0]}`
                  )}
            </button>
          )}
          {hasMultipleVisitors && (
            <>
              <button
                type="button"
                className="friend-visitors-action"
                onClick={() => setVisitorPickerOpen(value => !value)}
                aria-haspopup="menu"
                aria-expanded={visitorPickerOpen}
              >
                {t('Compare with…', 'Comparer avec…')}
              </button>
              {visitorPickerOpen && (
                <div className="friend-visitors-popover" role="menu" aria-label={t('Choose a friend to compare', 'Choisis un ami à comparer')}>
                  {friendVisitors.map(visitor => (
                    <button
                      key={visitor.userId}
                      type="button"
                      className="friend-visitors-option"
                      role="menuitem"
                      onClick={() => {
                        setVisitorPickerOpen(false)
                        onCompareFriend?.(visitor.userId)
                      }}
                    >
                      <span
                        className="friend-visitors-option-avatar"
                        style={{ background: visitor.bg ?? 'var(--avatar-bg-default)', color: visitor.fg ?? 'var(--avatar-fg-default)' }}
                      >
                        {visitor.displayName.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="friend-visitors-option-copy">
                        <strong>{visitor.displayName}</strong>
                        <small>{t(
                          `Compare with ${visitor.displayName.split(' ')[0]}`,
                          `Comparer avec ${visitor.displayName.split(' ')[0]}`
                        )}</small>
                      </span>
                      {visitor.tier && (
                        <span
                          className="friend-visitors-option-tier"
                          style={{ color: TIER_COLORS[visitor.tier].label, background: `${TIER_COLORS[visitor.tier].pin}22` }}
                        >
                          {visitor.tier}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {!compareWith && context.hasContext && (
        <ContextBlock context={context} ariaLabel={t('Trip context', 'Contexte du voyage')} />
      )}
      {compareWith && (
        <>
          <div className="compare-meta" aria-label={t(`Comparison with ${compareWith.friend.displayName}`, `Comparaison avec ${compareWith.friend.displayName}`)}>
            <div className="compare-meta-list">
              {compareDestination?.tripYear && (
                <span className="compare-meta-item">
                  <Icon name="calendar" />
                  {t(`${firstName} in ${compareDestination.tripYear}`, `${firstName} en ${compareDestination.tripYear}`)}
                </span>
              )}
              {compareDestination?.tripDays && (
                <span className="compare-meta-item">
                  <Icon name="clock" />
                  {firstName} {compareDestination.tripDays}{t('d', 'j')}
                </span>
              )}
              {compareDestination?.personalBudget && (
                <span className="compare-meta-item">
                  <Icon name="coins" />
                  {firstName} ~{Math.round(compareDestination.personalBudget / Math.max(compareDestination.tripDays ?? 1, 1)).toLocaleString('fr-FR')} EUR/{t('d', 'j')}
                </span>
              )}
            </div>
          </div>

          {mineDestination && compareDestination ? (
            compareCriteria.length > 0 && (
              <section className="compare-insight" aria-label={t('Comparison insight', 'Lecture de la comparaison')}>
                <span className="card-section-label">{t('Comparison insight', 'Lecture de la comparaison')}</span>
                <h3 className="compare-insight-headline">{compareInsight.headline}</h3>
                {compareInsight.sentence && <p className="compare-insight-sentence">{compareInsight.sentence}</p>}
                <span className="compare-insight-footer">{compareInsight.footer}</span>
              </section>
            )
          ) : (
            <section className="compare-insight compare-insight--friend-only" aria-label={t(`${compareWith.friend.displayName} rating`, `Note de ${compareWith.friend.displayName}`)}>
              <span className="card-section-label">{t(`${firstName}'s rating`, `La note de ${firstName}`)}</span>
              <h3 className="compare-insight-headline">
                {formatScore(compareDestination ?? destination)} · {t('Tier', 'Tier')} {getDisplayTier(compareDestination ?? destination)}
              </h3>
              <p className="compare-insight-sentence">
                {t(
                  'Add this destination to your journal to compare your experiences side by side.',
                  'Ajoute cette destination à ton carnet pour comparer vos expériences côte à côte.'
                )}
              </p>
            </section>
          )}

          {(mineDestination && compareDestination) ? (
            (compareTags.mineOnly.length > 0 || compareTags.common.length > 0 || compareTags.theirsOnly.length > 0) && (
              <section className="compare-takeaways" aria-label={t('Takeaways', 'Ce qui a marqué')}>
                <span className="card-section-label">{t('Takeaways', 'Ce qui a marqué')}</span>
                {compareTags.mineOnly.length > 0 && (
                  <div className="compare-takeaways-row">
                    <span className="compare-takeaways-who compare-takeaways-who--you">{t('You', 'Toi')}</span>
                    <div className="compare-takeaways-chips">
                      {compareTags.mineOnly.map(tag => (
                        <span key={tag} className="compare-takeaway-chip compare-takeaway-chip--you">{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
                {compareTags.common.length > 0 && (
                  <div className="compare-takeaways-row">
                    <span className="compare-takeaways-who compare-takeaways-who--both">{t('Both', 'En commun')}</span>
                    <div className="compare-takeaways-chips">
                      {compareTags.common.map(tag => (
                        <span key={tag} className="compare-takeaway-chip compare-takeaway-chip--both">{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
                {compareTags.theirsOnly.length > 0 && (
                  <div className="compare-takeaways-row">
                    <span className="compare-takeaways-who compare-takeaways-who--friend">{firstName}</span>
                    <div className="compare-takeaways-chips">
                      {compareTags.theirsOnly.map(tag => (
                        <span key={tag} className="compare-takeaway-chip compare-takeaway-chip--friend">{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            )
          ) : context.hasContext ? (
            <section className="compare-takeaways" aria-label={t(`${compareWith.friend.displayName} trip details`, `Détails du voyage de ${compareWith.friend.displayName}`)}>
              <span className="card-section-label">{t(`${firstName}'s trip`, `Le voyage de ${firstName}`)}</span>
              <div className="compare-takeaways-row">
                <span className="compare-takeaways-who compare-takeaways-who--friend">{firstName}</span>
                <div className="compare-takeaways-chips">
                  {context.details.flatMap(item => (
                    item.kind === 'text'
                      ? [<span key={`${item.label}-${item.value}`} className="compare-takeaway-chip compare-takeaway-chip--friend">{item.label}: {item.value}</span>]
                      : item.chips.map(chip => (
                        <span key={`${item.label}-${chip.label}`} className="compare-takeaway-chip compare-takeaway-chip--friend">
                          {chip.label}
                        </span>
                      ))
                  ))}
                  {context.details.length === 0 && context.meta.map(item => (
                    <span key={`${item.icon}-${item.label}`} className="compare-takeaway-chip compare-takeaway-chip--friend">
                      {item.label}
                    </span>
                  ))}
                </div>
              </div>
            </section>
          ) : null}
          {mineDestination && compareDestination && (() => {
            const minePills = getFeelingRecoPills(mineDestination)
            const theirPills = getFeelingRecoPills(compareDestination)
            if (minePills.length === 0 && theirPills.length === 0) return null
            return (
              <section className="compare-takeaways" aria-label={t('Feel & recommendation', 'Ressenti & reco')}>
                <span className="card-section-label">{t('Feel & recommendation', 'Ressenti & reco')}</span>
                {minePills.length > 0 && (
                  <div className="compare-takeaways-row">
                    <span className="compare-takeaways-who compare-takeaways-who--you">{t('You', 'Toi')}</span>
                    <div className="compare-takeaways-chips">
                      {minePills.map(pill => (
                        <span key={pill.label} className="compare-takeaway-chip compare-takeaway-chip--you">{pill.emoji} {pill.label}</span>
                      ))}
                    </div>
                  </div>
                )}
                {theirPills.length > 0 && (
                  <div className="compare-takeaways-row">
                    <span className="compare-takeaways-who compare-takeaways-who--friend">{firstName}</span>
                    <div className="compare-takeaways-chips">
                      {theirPills.map(pill => (
                        <span key={pill.label} className="compare-takeaway-chip compare-takeaway-chip--friend">{pill.emoji} {pill.label}</span>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            )
          })()}
        </>
      )}
      {(criteria.length > 0 || compareWith) && <h3 className="card-section-label card-section-title">{t('Your answers', 'Tes réponses')}</h3>}
      {compareWith && compareCriteria.length > 0 ? (
        <div className="compare-ratings" aria-label={t(`Comparison with ${compareWith.friend.displayName}`, `Comparaison avec ${compareWith.friend.displayName}`)}>
          <div className="compare-ratings-head">
            <span />
            <strong className="cr-head cr-head--you">{t('You', 'Toi')}</strong>
            <strong className="cr-head cr-head--friend">{firstName}</strong>
            <span />
          </div>
          <div className="compare-ratings-list">
            {compareCriteria.map(item => {
              const gapInfo = getGapIndicator(item.gap)
              return (
                <div className="compare-ratings-row" key={item.key}>
                  <span className="cr-label">
                    <Icon name={item.icon} />
                    {CRITERION_LABELS[item.key]}
                  </span>
                  <span className="cr-chip cr-chip--you">{item.mine.toFixed(1).replace('.', ',')}</span>
                  <span className="cr-chip cr-chip--friend">{item.theirs.toFixed(1).replace('.', ',')}</span>
                  <span
                    className={`cr-gap cr-gap--${gapInfo.tone}`}
                    role="img"
                    title={gapInfo.label}
                    aria-label={gapInfo.label}
                  >
                    {gapInfo.symbol}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <AnswerTiles criteria={criteria} />
      )}
      {compareWith && criteria.length === 0 && (
        <p className="compare-fallback-empty">
          {isFriendOnlyComparison
            ? t(
                `${firstName} has not added detailed criterion ratings for this destination yet.`,
                `${firstName} n’a pas encore noté cette destination en détail.`
              )
            : t(
                'One of the two profiles is missing detailed criterion ratings for this destination.',
                'L’un des deux profils n’a pas de notes détaillées pour cette destination.'
              )}
        </p>
      )}
      {compareWith && mineContext?.hasContext && (
        <section className="compare-your-trip" aria-label={t('Your trip', 'Ton voyage')}>
          <span className="card-section-label">{t('Your trip', 'Ton voyage')}</span>
          <ContextBlock context={mineContext} ariaLabel={t('Your trip context', 'Contexte de ton voyage')} />
        </section>
      )}
      {tripsHereByName.length > 0 && (
        <div className="sheet-cross-links">
          <p className="sheet-cross-links-title">{t('Also a stop in', 'Aussi une étape de')}</p>
          <ul>
            {tripsHereByName.map(([tripName, info]) => {
              const stageLabel = info.stages.length
                ? `${t('stop', 'étape')} #${info.stages.join(', #')}`
                : t('itinerary', 'itinéraire')
              return (
                <li key={tripName}>
                  <span className="trip-dot" style={{ '--trip-color': info.color } as CSSProperties} />
                  {onOpenTrip ? (
                    <button
                      type="button"
                      className="trip-link"
                      onClick={() => onOpenTrip(tripName)}
                      style={{ background: 'none', border: 0, padding: 0, color: 'inherit', cursor: 'pointer', font: 'inherit', textAlign: 'left' }}
                    >
                      {tripName}
                    </button>
                  ) : (
                    <span>{tripName}</span>
                  )}
                  <span className="stop-num">{stageLabel}</span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
      </div>
        </>
      )}
    </>
  )
}

interface RoadTripCardContentProps {
  destination: Destination
  coupDeCoeur: boolean
  coupDeCoeurDisabled: boolean
  coupDeCoeurCount: number
  canEditOwnDestination?: boolean
  context: ReturnType<typeof getDestinationContext>
  criteria: ReturnType<typeof getCriteria>
  allDestinations?: Destination[]
  onCoupDeCoeur: () => void
  onOpenDestination?: (name: string) => void
  cardActions: JSX.Element
}

function RoadTripCardContent({
  destination,
  coupDeCoeur,
  coupDeCoeurDisabled,
  coupDeCoeurCount,
  canEditOwnDestination = true,
  context,
  criteria,
  allDestinations,
  onCoupDeCoeur,
  onOpenDestination,
  cardActions,
}: RoadTripCardContentProps) {
  const validStops = destination.stops?.filter(stop => stop.name.trim() && Number.isFinite(stop.lat) && Number.isFinite(stop.lng)) ?? []
  const stageCount = validStops.length
  const score = formatScore(destination)
  const displayTier = getDisplayTier(destination)

  return (
    <>
      <div className="destination-hero-wrap">
      <div className="destination-hero roadtrip-hero">
        {destination.image && (
          <HeroImage src={destination.image} />
        )}
        <div className="destination-hero-pills">
          <span className="intent-pill destination-hero-pill">
            <Icon name="map" />
            {t('Road trip', 'Road trip')}
          </span>
          <span className="intent-pill destination-hero-pill">
            {stageCount} {t('stop', 'étape')}{stageCount > 1 ? 's' : ''}
          </span>
          {getHeroPills(destination).map(pill => (
            <span key={pill.label} className={`intent-pill destination-hero-pill destination-hero-pill--${pill.tone}`}>
              <span aria-hidden="true">{pill.emoji}</span>
              {pill.label}
            </span>
          ))}
          {canEditOwnDestination && coupDeCoeur && (
            <button
              className="coup-de-coeur-button destination-hero-favorite is-active"
              aria-label={t('Remove from favorites', 'Retirer des coups de cœur')}
              title={t('Favorite — remove', 'Coup de cœur — retirer')}
              onClick={onCoupDeCoeur}
            >
              <Icon name="heart" />
              {t('Favorite', 'Coup de cœur')}
            </button>
          )}
        </div>
      </div>
      {cardActions}
      </div>

      <div className="destination-body-sheet">
      <div className="destination-title-row roadtrip-title-row">
        {displayTier && <span className={`tier-orb tier-${displayTier.toLowerCase()}`}>{displayTier}</span>}
        <div>
          <h2>{destination.name}</h2>
          <p className="roadtrip-title-sub">{t('Overall trip experience', 'Expérience globale du voyage')}</p>
        </div>
      </div>

      <section className="roadtrip-score-card" aria-label={t('Overall road trip rating', 'Note globale du road trip')}>
        <div>
          <span>{t('Overall rating', 'Note globale')}</span>
          <strong>{score}</strong>
        </div>
        <p>{t(
          'Rate the road trip as the experience you actually lived. Stops tell the story of the route; detail a city only if it deserves its own entry.',
          'Note le road trip comme l’expérience que tu as vraiment vécue. Les étapes racontent la route ; détaille une ville seulement si elle mérite sa propre fiche.'
        )}</p>
      </section>

      {context.hasContext && (
        <ContextBlock context={context} className="roadtrip-context" ariaLabel={t('Road trip context', 'Contexte du road trip')} />
      )}

      <h3>{t('Overall ratings', 'Notes globales')}</h3>
      <AnswerTiles criteria={criteria} />

      <section className="roadtrip-itinerary" aria-label={t('Road trip itinerary', 'Itinéraire du road trip')}>
        <div className="roadtrip-section-head">
          <h3>{t('Itinerary', 'Itinéraire')}</h3>
          <span>{validStops.length} {t('stop', 'étape')}{validStops.length > 1 ? 's' : ''}</span>
        </div>
        {validStops.length > 0 ? (
          <ol className="roadtrip-timeline">
            {validStops.map((stop, index) => {
              const linkedDestination = allDestinations ? findDestinationAtLocation(stop, allDestinations) : null
              return (
                <li key={`${stop.name}-${index}`}>
                  <span className="roadtrip-step-dot">{index + 1}</span>
                  <div className="roadtrip-step-body">
                    <div>
                      <strong>{stop.name}</strong>
                      <span>{t('Route stop', 'Étape du parcours')}</span>
                    </div>
                    {linkedDestination && linkedDestination.name !== destination.name ? (
                      <button type="button" onClick={() => onOpenDestination?.(linkedDestination.name)}>
                        {t('See entry', 'Voir la fiche')}
                      </button>
                    ) : (
                      <em>{t('Itinerary', 'Itinéraire')}</em>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        ) : (
          <p className="roadtrip-empty">{t(
            'Add stops to tell the story of the route without having to rate each city.',
            'Ajoute des étapes pour raconter la route sans devoir noter chaque ville.'
          )}</p>
        )}
      </section>
      </div>
    </>
  )
}
