import { lazy, memo, Suspense, useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Destination, RoadTripStop, Tier } from '../types'
import { TIER_COLORS, UNRATED_COLORS } from '../data'
import { formatVisitCountLabel, getDestinationScore, getDestinationTier, getVisitCount } from '../utils'
import { destinationNameKey } from '../utils/destinationIdentity'
import { haversineMeters } from '../utils/duplicates'
import { ROAD_TRIP_TAG_ID } from '../lib/experienceTags'
import { t } from '../i18n'
import SpaceBackdrop from './globe/SpaceBackdrop'

// Globe 3D (Three.js), chargé seulement quand la scène « Terre 3D » est choisie.
const EarthGlobe = lazy(() => import('./globe/EarthGlobe'))
type GlobeCameraRequest = { lat: number; lng: number; token: number; distance?: number }

// Correspondance d'échelle entre le globe 3D (caméra à `distance` rayons, champ
// vertical de 32°) et la carte : au centre de l'écran, un rayon terrestre fait
// 512 × 2^zoom / (2π cos lat) pixels sur la carte (formule du globe MapLibre,
// vérifiée avec map.project) et focale / (distance − 1) sur le globe 3D. Le
// relais se fait donc sans saut de taille, à toutes les latitudes.
const GLOBE_FOV = 32
const HANDOFF_ZOOM = 4.2
// Bascules entre globe et carte, exprimées en distance de caméra du globe 3D
// (donc en taille apparente de la Terre), identiques à toutes les latitudes ;
// le zoom de carte correspondant en découle (≈ 3,9 et 3,6 vers 45°, plus fort à
// l'équateur, plus faible vers les pôles). Écart entre les deux : pas de
// va-et-vient.
const ZOOM_THROUGH_DISTANCE = 1.9
const RETURN_TO_GLOBE_DISTANCE = 2.1
// Fondu du globe 3D sur la carte au relais (doit couvrir la transition CSS de
// .earth-globe-layer) : le globe continue d'être dessiné pendant ce temps.
const GLOBE_FADE_MS = 450
// Arrivée sur une destination : centrée dans l'espace libre, entre la barre
// latérale et la fiche ouverte (à droite sur ordinateur, en bas sur mobile).
function destinationPaddingFor(map: maplibregl.Map) {
  const container = map.getContainer().getBoundingClientRect()
  const padding = { top: 0, right: 0, bottom: 0, left: getSidebarInset(map) }
  const card = document.querySelector('.destination-card')?.getBoundingClientRect()
  if (card && card.width > 0 && card.left > container.left + container.width / 2) {
    padding.right = Math.max(0, Math.round(container.right - card.left + 16))
  }
  const sheet = document.querySelector('.destination-sheet')?.getBoundingClientRect()
  if (sheet && sheet.height > 0 && sheet.top > container.top + container.height * 0.3) {
    padding.bottom = Math.max(0, Math.round(container.bottom - sheet.top + 16))
  }
  return padding
}
function globeFocalPx(map: maplibregl.Map) {
  return (map.getContainer().clientHeight / 2) / Math.tan((GLOBE_FOV / 2) * Math.PI / 180)
}
function mapRadiusPx(zoom: number, lat: number) {
  return (512 * 2 ** zoom) / (2 * Math.PI * Math.max(0.05, Math.cos(lat * Math.PI / 180)))
}
function globeDistanceForZoom(map: maplibregl.Map, zoom: number, lat: number) {
  return 1 + globeFocalPx(map) / mapRadiusPx(zoom, lat)
}
function zoomForGlobeDistance(map: maplibregl.Map, distance: number, lat: number) {
  const radiusPx = globeFocalPx(map) / Math.max(0.01, distance - 1)
  return Math.log2((radiusPx * 2 * Math.PI * Math.max(0.05, Math.cos(lat * Math.PI / 180))) / 512)
}

const MAPTILER_KEY = 'aETkeQlWzYNolMJrUTIx'
const STYLE_URL = `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`
const INIT_CENTER: [number, number] = [10, 10]
const INIT_ZOOM = 1.5
// Plan « orbital » en vue globe : caméra plongeante et Terre légèrement penchée.
// Elle se redresse (nord en haut, vue de dessus) une fois zoomé sur une région.
const CINEMATIC_CAMERA = { bearing: -10, pitch: 20 }
const FLAT_CAMERA = { bearing: 0, pitch: 0 }

// Part de la pose cinématique selon le zoom : entière jusqu'au zoom 3, nulle à
// partir de 5,5, en courbe douce entre les deux. Appliquée à chaque image de
// caméra (transformCameraUpdate) : la caméra se redresse pendant le zoom même,
// jamais après coup.
function cinematicAmount(zoom: number) {
  const t = Math.min(1, Math.max(0, (5.5 - zoom) / 2.5))
  return t * t * (3 - 2 * t)
}
type Proj = (ll: [number, number]) => [number, number] | null
const MARKER_PROJ: Proj = () => [0, 0]


function getTierColor(tier?: Tier | null) {
  return tier ? TIER_COLORS[tier]?.pin : UNRATED_COLORS.pin
}

function getDestinationColor(destination: Destination) {
  return getTierColor(getDestinationTier(destination))
}

function isFiniteLngLat(point: { lng: number; lat: number }) {
  return Number.isFinite(point.lng) && Number.isFinite(point.lat)
}

function getDestinationFocusPoints(destination: Destination): Array<{ lng: number; lat: number }> {
  const points: Array<{ lng: number; lat: number }> = []

  if (Array.isArray(destination.extent) && destination.extent.length === 4) {
    // Format attendu (écrit par AddDestinationWizard via geoCentroid) :
    // [west, south, east, north]. Pour les destinations legacy issues directement
    // de Photon, le format peut être [w, n, e, s] — sans impact ici car on s'en
    // sert uniquement comme deux coins diagonaux pour le fit bounds.
    const [west, south, east, north] = destination.extent
    if ([west, south, east, north].every(Number.isFinite)) {
      points.push(
        { lng: west, lat: south },
        { lng: east, lat: north },
      )
    }
  }

  if (isRoadTripTagged(destination) && destination.stops?.length) {
    for (const stop of destination.stops) {
      if (isFiniteLngLat(stop)) points.push({ lng: stop.lng, lat: stop.lat })
    }
  }

  if (isFiniteLngLat(destination)) {
    points.push({ lng: destination.lng, lat: destination.lat })
  }

  return points
}

function getMapFocusPoints(destinations: Destination[], friendDestinations?: Destination[]) {
  return [...destinations, ...(friendDestinations ?? [])].flatMap(getDestinationFocusPoints)
}

function getMapFocusFingerprint(destinations: Destination[], friendDestinations?: Destination[]) {
  return getMapFocusPoints(destinations, friendDestinations)
    .map(point => `${point.lng.toFixed(4)},${point.lat.toFixed(4)}`)
    .sort()
    .join('|')
}

// Zoom de la vue monde, estimé avant que la carte existe : le globe occupe environ
// 92 % du plus petit côté.
function getWorldZoom(width: number, height: number) {
  const side = Math.min(width, height)
  if (!side) return INIT_ZOOM
  return Math.min(3, Math.max(0.5, Math.log2((side * 0.92) / 150)))
}

// Taille réelle du globe à l'écran pour un zoom donné (diamètre / 2^zoom), mesurée
// sur la carte : elle dépend de l'inclinaison et de la hauteur de l'écran, d'où un
// globe qui débordait sur téléphone avec l'estimation fixe.
const globeScaleByMap = new WeakMap<maplibregl.Map, number>()

// Marges de la caméra, sans transform CSS :
// - à gauche, la largeur de la barre latérale (sur ordinateur) : le globe se centre
//   dans l'espace libre, donc un peu à droite ;
// - en bas, en vue globe seulement : la caméra inclinée fait descendre le globe
//   d'environ rayon × sin(inclinaison) ; cette marge le remonte au centre.
function getSidebarInset(map: maplibregl.Map) {
  const container = map.getContainer()
  const sidebar = container.ownerDocument.querySelector('.sidebar')
  const rect = sidebar instanceof HTMLElement && sidebar.offsetParent ? sidebar.getBoundingClientRect() : null
  return rect && rect.width > 0 && rect.left < container.clientWidth / 3 ? Math.round(rect.right) : 0
}

// Marge basse fixée une fois pour la vue monde puis gardée telle quelle : une
// marge qui varierait avec le zoom ferait monter et descendre le globe. Elle ne
// compense que la moitié de la descente due à l'inclinaison : le globe reste
// presque centré en vue monde, et la vue rapprochée (sans inclinaison) n'est
// décalée que d'une soixantaine de pixels vers le haut.
const bottomPaddingByMap = new WeakMap<maplibregl.Map, number>()

function measureBottomPadding(map: maplibregl.Map, worldZoom: number) {
  const scale = globeScaleByMap.get(map)
  if (!scale) return
  const radius = scale * 2 ** worldZoom / 2
  bottomPaddingByMap.set(map, Math.round(radius * Math.sin(CINEMATIC_CAMERA.pitch * Math.PI / 180)))
}

function cameraPaddingFor(map: maplibregl.Map) {
  return { top: 0, right: 0, bottom: bottomPaddingByMap.get(map) ?? 0, left: getSidebarInset(map) }
}

function updateMapPadding(map: maplibregl.Map) {
  const padding = cameraPaddingFor(map)
  const current = map.getPadding()
  if (current.left !== padding.left || current.bottom !== padding.bottom) map.setPadding(padding)
}

// Zoom de la vue monde : le globe occupe ~80 % de la hauteur, sans dépasser 94 %
// de la largeur libre (hors barre latérale).
function getWorldZoomFor(map: maplibregl.Map) {
  const container = map.getContainer()
  const width = container.clientWidth - (map.getPadding().left ?? 0)
  const height = container.clientHeight
  const disc = measureGlobeDisc(map)
  if (disc) globeScaleByMap.set(map, Math.max(disc.width, disc.height) / 2 ** map.getZoom())
  const scale = globeScaleByMap.get(map)
  if (!scale || !width || !height) return getWorldZoom(width, height)
  return Math.min(3.2, Math.max(0.3, Math.log2(Math.min(width * 0.94, height * 0.8) / scale)))
}

// Dézoom bloqué un peu en dessous de la vue monde : le globe ne devient pas une bille.
function updateMinZoom(map: maplibregl.Map) {
  map.setMinZoom(Math.max(0, getWorldZoomFor(map) - 0.35))
}

// Point à `distance` degrés du départ, dans la direction `bearing` (grand cercle).
function destinationPoint([lng, lat]: [number, number], bearing: number, distance: number): [number, number] {
  const rad = Math.PI / 180
  const φ1 = lat * rad
  const λ1 = lng * rad
  const θ = bearing * rad
  const δ = distance * rad
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return [((λ2 / rad + 540) % 360) - 180, φ2 / rad]
}

// Cale le halo sur le disque du globe : on cherche, dans 16 directions, où la Terre
// bascule sur sa face cachée, puis on prend la boîte englobante de ces bords (juste
// aussi avec la caméra inclinée). Masqué quand la carte est plate ou zoomée.
function updateGlobeGlow(map: maplibregl.Map, ...elements: Array<HTMLDivElement | null>) {
  const disc = measureGlobeDisc(map)
  if (disc) globeScaleByMap.set(map, Math.max(disc.width, disc.height) / 2 ** map.getZoom())
  for (const element of elements) {
    if (!element) continue
    if (!disc) {
      element.style.opacity = '0'
      continue
    }
    element.style.width = `${disc.width}px`
    element.style.height = `${disc.height}px`
    element.style.transform = `translate3d(${disc.x - disc.width / 2}px, ${disc.y - disc.height / 2}px, 0)`
    element.style.opacity = Math.min(1, Math.max(0, (6 - map.getZoom()) / 1.5)).toFixed(3)
  }
}

function measureGlobeDisc(map: maplibregl.Map) {
  const center = map.getCenter()
  const origin: [number, number] = [center.lng, center.lat]
  const isOccluded = (bearing: number, distance: number) =>
    map.transform.isLocationOccluded(new maplibregl.LngLat(...destinationPoint(origin, bearing, distance)))
  if (map.getZoom() > 6 || !isOccluded(0, 179)) return null
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let bearing = 0; bearing < 360; bearing += 22.5) {
    let visible = 0
    let hidden = 179
    for (let step = 0; step < 12; step++) {
      const middle = (visible + hidden) / 2
      if (isOccluded(bearing, middle)) hidden = middle
      else visible = middle
    }
    const edge = map.project(destinationPoint(origin, bearing, visible) as maplibregl.LngLatLike)
    minX = Math.min(minX, edge.x); maxX = Math.max(maxX, edge.x)
    minY = Math.min(minY, edge.y); maxY = Math.max(maxY, edge.y)
  }
  // Ellipse et non cercle : vue de biais, la silhouette s'écrase un peu.
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, width: maxX - minX, height: maxY - minY }
}

// Projette un point à l'écran, ou null s'il est sur la face cachée du globe.
function projectVisible(map: maplibregl.Map, lng: number, lat: number): [number, number] | null {
  if (map.transform.isLocationOccluded(new maplibregl.LngLat(lng, lat))) return null
  const { x, y } = map.project([lng, lat] as maplibregl.LngLatLike)
  return [x, y]
}

// Préchargement des tuiles autour des destinations, au zoom d'arrivée de la
// plongée : au clic, tout est déjà dans le cache du navigateur (même adresse, même
// fichier). MapTiler compte ses requêtes : on le limite aux premières destinations ;
// le relief (AWS) et l'image NASA, gratuits, sont préchargés pour toutes.
const PREFETCH_PLAN: Array<{ source: string; zoom: number; radius: number; paid?: boolean }> = [
  { source: 'maptiler_planet', zoom: 7, radius: 1, paid: true },
  { source: 'outdoor', zoom: 7, radius: 1, paid: true },
  { source: 'atlas-dem', zoom: 8, radius: 2 },
  { source: 'atlas-satellite', zoom: 8, radius: 1 },
]
const PREFETCH_PAID_MAX_DESTINATIONS = 12

function tileUrlsAround(template: string, lng: number, lat: number, zoom: number, radius: number) {
  const n = 2 ** zoom
  const clampedLat = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat)) * Math.PI / 180
  const cx = Math.floor((lng + 180) / 360 * n)
  const cy = Math.floor((1 - Math.log(Math.tan(clampedLat) + 1 / Math.cos(clampedLat)) / Math.PI) / 2 * n)
  const urls: string[] = []
  for (let dy = -radius; dy <= radius; dy++) {
    const y = cy + dy
    if (y < 0 || y >= n) continue
    for (let dx = -radius; dx <= radius; dx++) {
      const x = ((cx + dx) % n + n) % n
      urls.push(template.replace('{z}', String(zoom)).replace('{x}', String(x)).replace('{y}', String(y)))
    }
  }
  return urls
}

async function prefetchDestinationTiles(map: maplibregl.Map, points: Array<{ lng: number; lat: number }>, signal: AbortSignal) {
  const urls = new Set<string>()
  points.forEach((point, index) => {
    for (const step of PREFETCH_PLAN) {
      if (step.paid && index >= PREFETCH_PAID_MAX_DESTINATIONS) continue
      const source = map.getSource(step.source) as { tiles?: unknown } | undefined
      const template = Array.isArray(source?.tiles) ? String(source.tiles[0]) : null
      if (!template) continue
      for (const url of tileUrlsAround(template, point.lng, point.lat, step.zoom, step.radius)) urls.add(url)
    }
  })
  const queue = [...urls]
  const worker = async () => {
    while (queue.length && !signal.aborted) {
      const url = queue.shift()!
      try { await fetch(url, { signal, mode: 'cors', credentials: 'omit', priority: 'low' } as RequestInit) } catch { /* tuile manquante : sans gravité */ }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
}

// Centre du globe qui montre le plus de destinations sur la face visible : on
// essaie chaque destination comme centre, on garde celle qui en voit le plus à
// moins de 70°, puis on centre sur la moyenne de celles-ci.
function getBestGlobeCenter(points: Array<{ lng: number; lat: number }>): [number, number] | null {
  if (!points.length) return null
  const rad = Math.PI / 180
  const toVector = ({ lng, lat }: { lng: number; lat: number }) => [
    Math.cos(lat * rad) * Math.cos(lng * rad),
    Math.cos(lat * rad) * Math.sin(lng * rad),
    Math.sin(lat * rad),
  ]
  const vectors = points.map(toVector)
  const limit = Math.cos(70 * rad)
  let best: number[][] = []
  for (const candidate of vectors) {
    const seen = vectors.filter(v => v[0] * candidate[0] + v[1] * candidate[1] + v[2] * candidate[2] >= limit)
    if (seen.length > best.length) best = seen
  }
  const sum = best.reduce((acc, v) => [acc[0] + v[0], acc[1] + v[1], acc[2] + v[2]], [0, 0, 0])
  const length = Math.hypot(sum[0], sum[1], sum[2])
  if (!length) return null
  return [Math.atan2(sum[1], sum[0]) / rad, Math.asin(sum[2] / length) / rad]
}

function fitMapToDestinations(
  map: maplibregl.Map,
  destinations: Destination[],
  friendDestinations: Destination[] | undefined,
  options?: { duration?: number; fallbackToWorld?: boolean },
) {
  const visiblePoints = getMapFocusPoints(destinations, friendDestinations)
  const duration = options?.duration ?? 650
  const worldZoom = getWorldZoomFor(map)

  // Toujours le globe entier, tourné vers l'endroit où l'on voit le plus de
  // destinations ; on zoome ensuite soi-même ou en cliquant sur un pin.
  const center = getBestGlobeCenter(visiblePoints)
  if (center) {
    map.flyTo({ center, zoom: worldZoom, ...CINEMATIC_CAMERA, padding: cameraPaddingFor(map), duration, easing: t => 1 - Math.pow(1 - t, 3) })
    correctWorldZoomOnArrival(map)
    return true
  }

  if (options?.fallbackToWorld) {
    map.flyTo({ center: INIT_CENTER, zoom: worldZoom, ...CINEMATIC_CAMERA, padding: cameraPaddingFor(map), duration: Math.min(duration, 400) })
    correctWorldZoomOnArrival(map)
  }

  return false
}

// La taille du globe se mesure mieux une fois arrivé (la mesure prise avant le
// premier rendu en globe est approximative) : on ajuste alors le zoom et la marge
// basse en douceur, deux fois au plus pour converger. Si l'on est parti ailleurs
// entre-temps (zoom, plongée vers la carte), on ne ramène pas à la vue monde.
function correctWorldZoomOnArrival(map: maplibregl.Map, attempts = 2) {
  map.once('moveend', () => {
    const corrected = getWorldZoomFor(map)
    updateMinZoom(map)
    if (Math.abs(map.getZoom() - corrected) > 0.6) return
    measureBottomPadding(map, corrected)
    const padding = cameraPaddingFor(map)
    const needsZoom = Math.abs(map.getZoom() - corrected) > 0.04
    const needsPadding = Math.abs((map.getPadding().bottom ?? 0) - padding.bottom) > 6
    if (!needsZoom && !needsPadding) return
    map.easeTo({ zoom: corrected, padding, duration: 500 })
    if (attempts > 1) correctWorldZoomOnArrival(map, attempts - 1)
  })
}

interface FlyTarget { lat: number; lng: number; name: string }
type DockMode = 'stacked-left' | 'bottom-left' | 'overlay-bottom'

interface WorldMapProps {
  destinations: Destination[]
  flyTarget: FlyTarget | null
  selectedName?: string
  onSelect: (name: string) => void
  onDeselect?: () => void
  onFlyTargetConsumed: () => void
  friendDestinations?: Destination[]
  friendInitials?: string
  friendAvatarUrl?: string | null
  friendAvatarBg?: string
  friendAvatarFg?: string
  sharedNames?: Set<string>
  controlsMode?: DockMode
  legendMode?: DockMode
  hidden?: boolean
  mapDetail?: 'simple' | 'detailed'
}

interface MapMarkerPin {
  key: string
  destination: Destination
  owner: 'me' | 'friend'
  selected: boolean
  badge?: string
  badgeAvatarUrl?: string | null
  badgeBg?: string
  badgeFg?: string
  shared?: boolean
  tripBadges?: PinTripBadge[]
}


const ATLAS_PREMIUM_PALETTE = {
  sea: '#c9e3ee',
  land: '#e9dcbb',
  sand: '#e2c48c',
  seaVivid: '#4b8fcb',
  seaDeep: '#4787c0',
  forest: '#5f9945',
  meadow: '#9fc06a',
  // Ombre froide et légère : elle va aussi bien aux terres qu'aux fonds marins.
  relief: 'rgba(30, 52, 92, 0.58)',
  shallows: '#a9dcf3',
  labelOcean: '#eef6fc',
  border: 'rgba(145, 131, 110, 0.18)',
  borderSoft: 'rgba(145, 131, 110, 0.10)',
  coast: 'rgba(172, 207, 220, 0.42)',
}

const ATLAS_COUNTRY_LABELS: GeoJSON.FeatureCollection<GeoJSON.Point, { name: string; priority: number }> = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'CANADA', priority: 1 }, geometry: { type: 'Point', coordinates: [-103, 58] } },
    { type: 'Feature', properties: { name: 'UNITED STATES', priority: 1 }, geometry: { type: 'Point', coordinates: [-98, 39] } },
    { type: 'Feature', properties: { name: 'MEXICO', priority: 2 }, geometry: { type: 'Point', coordinates: [-102, 23] } },
    { type: 'Feature', properties: { name: 'BRAZIL', priority: 1 }, geometry: { type: 'Point', coordinates: [-52, -11] } },
    { type: 'Feature', properties: { name: 'ARGENTINA', priority: 2 }, geometry: { type: 'Point', coordinates: [-64, -35] } },
    { type: 'Feature', properties: { name: 'UNITED KINGDOM', priority: 2 }, geometry: { type: 'Point', coordinates: [-2, 54] } },
    { type: 'Feature', properties: { name: 'FRANCE', priority: 1 }, geometry: { type: 'Point', coordinates: [2, 46] } },
    { type: 'Feature', properties: { name: 'SPAIN', priority: 2 }, geometry: { type: 'Point', coordinates: [-3.5, 40] } },
    { type: 'Feature', properties: { name: 'GERMANY', priority: 1 }, geometry: { type: 'Point', coordinates: [10, 51] } },
    { type: 'Feature', properties: { name: 'ITALY', priority: 2 }, geometry: { type: 'Point', coordinates: [12, 43] } },
    { type: 'Feature', properties: { name: 'POLAND', priority: 2 }, geometry: { type: 'Point', coordinates: [19, 52] } },
    { type: 'Feature', properties: { name: 'UKRAINE', priority: 2 }, geometry: { type: 'Point', coordinates: [31, 49] } },
    { type: 'Feature', properties: { name: 'TURKEY', priority: 2 }, geometry: { type: 'Point', coordinates: [35, 39] } },
    { type: 'Feature', properties: { name: 'RUSSIA', priority: 1 }, geometry: { type: 'Point', coordinates: [80, 60] } },
    { type: 'Feature', properties: { name: 'MOROCCO', priority: 2 }, geometry: { type: 'Point', coordinates: [-6, 31] } },
    { type: 'Feature', properties: { name: 'ALGERIA', priority: 1 }, geometry: { type: 'Point', coordinates: [2, 28] } },
    { type: 'Feature', properties: { name: 'MAURITANIA', priority: 2 }, geometry: { type: 'Point', coordinates: [-10, 20] } },
    { type: 'Feature', properties: { name: 'LIBYA', priority: 2 }, geometry: { type: 'Point', coordinates: [18, 27] } },
    { type: 'Feature', properties: { name: 'EGYPT', priority: 2 }, geometry: { type: 'Point', coordinates: [30, 27] } },
    { type: 'Feature', properties: { name: 'MALI', priority: 3 }, geometry: { type: 'Point', coordinates: [-4, 17] } },
    { type: 'Feature', properties: { name: 'NIGER', priority: 3 }, geometry: { type: 'Point', coordinates: [9, 17] } },
    { type: 'Feature', properties: { name: 'CHAD', priority: 3 }, geometry: { type: 'Point', coordinates: [19, 15] } },
    { type: 'Feature', properties: { name: 'SUDAN', priority: 2 }, geometry: { type: 'Point', coordinates: [30, 15] } },
    { type: 'Feature', properties: { name: 'ETHIOPIA', priority: 3 }, geometry: { type: 'Point', coordinates: [40, 9] } },
    { type: 'Feature', properties: { name: 'SOUTH AFRICA', priority: 2 }, geometry: { type: 'Point', coordinates: [24, -29] } },
    { type: 'Feature', properties: { name: 'SAUDI ARABIA', priority: 2 }, geometry: { type: 'Point', coordinates: [45, 24] } },
    { type: 'Feature', properties: { name: 'IRAN', priority: 2 }, geometry: { type: 'Point', coordinates: [53, 32] } },
    { type: 'Feature', properties: { name: 'INDIA', priority: 1 }, geometry: { type: 'Point', coordinates: [78, 22] } },
    { type: 'Feature', properties: { name: 'CHINA', priority: 1 }, geometry: { type: 'Point', coordinates: [104, 35] } },
    { type: 'Feature', properties: { name: 'JAPAN', priority: 2 }, geometry: { type: 'Point', coordinates: [138, 38] } },
    { type: 'Feature', properties: { name: 'AUSTRALIA', priority: 1 }, geometry: { type: 'Point', coordinates: [134, -25] } },
  ],
}

function safeSetPaint(map: maplibregl.Map, layerId: string, property: string, value: unknown) {
  try { map.setPaintProperty(layerId, property, value) } catch { /* layer/property not supported in this style */ }
}

function safeSetLayout(map: maplibregl.Map, layerId: string, property: string, value: unknown) {
  try { map.setLayoutProperty(layerId, property, value) } catch { /* layer/property not supported in this style */ }
}

function safeSetFilter(map: maplibregl.Map, layerId: string, filter: unknown) {
  try { map.setFilter(layerId, filter as maplibregl.FilterSpecification) } catch { /* tile schemas may vary */ }
}

function safeSetLayerZoomRange(map: maplibregl.Map, layerId: string, minzoom: number, maxzoom: number) {
  try { map.setLayerZoomRange(layerId, minzoom, maxzoom) } catch { /* layer may not support zoom range updates */ }
}

function hideLayer(map: maplibregl.Map, layerId: string) {
  safeSetLayout(map, layerId, 'visibility', 'none')
}

// Imagerie « Blue Marble » de la NASA (domaine public, sans clé) : elle apporte
// les dégradés naturels. Posée juste au-dessus de l'eau, sous les hauts-fonds et
// le relief, qui la sculptent par-dessus (rendu illustré, presque cel-shading).
// Deux étages : une image de toute la Terre (public/earth-bluemarble.jpg, tuiles
// du zoom 4 assemblées), chargée une fois, qui sert seule en vue globe et de fond
// sans trou ensuite ; puis les tuiles plus fines par-dessus à partir du zoom 3,4.
// Les deux s'effacent entre les zooms 5,5 et 7,5 (les tuiles s'arrêtent au zoom 8).
const ATLAS_SATELLITE_PAINT = {
  'raster-opacity': ['interpolate', ['linear'], ['zoom'], 5.5, 1, 7.5, 0],
  'raster-brightness-min': 0.12,
  'raster-brightness-max': 1,
  'raster-contrast': 0.1,
  'raster-saturation': 0.3,
} satisfies maplibregl.RasterLayerSpecification['paint']
const MERCATOR_MAX_LAT = 85.0511287798
function addAtlasSatellite(map: maplibregl.Map) {
  if (map.getLayer('atlas-satellite')) return
  const layers = map.getStyle().layers
  const waterIndex = layers.findIndex(layer => layer.type === 'fill' && /water/i.test(layer.id) && !/waterway/i.test(layer.id))
  const beforeId = waterIndex >= 0 ? layers[waterIndex + 1]?.id : undefined
  try {
    map.addSource('atlas-earth', {
      type: 'image',
      url: '/earth-bluemarble.jpg',
      coordinates: [[-180, MERCATOR_MAX_LAT], [180, MERCATOR_MAX_LAT], [180, -MERCATOR_MAX_LAT], [-180, -MERCATOR_MAX_LAT]],
    })
    map.addLayer({
      id: 'atlas-earth',
      type: 'raster',
      source: 'atlas-earth',
      paint: { ...ATLAS_SATELLITE_PAINT, 'raster-fade-duration': 0 },
    }, beforeId)
    map.addSource('atlas-satellite', {
      type: 'raster',
      tiles: ['https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg'],
      // Tuiles de 256 px déclarées en 128 : MapLibre charge un niveau plus fin,
      // l'image reste nette en vue globe.
      tileSize: 128,
      maxzoom: 8,
    })
    map.addLayer({
      id: 'atlas-satellite',
      type: 'raster',
      source: 'atlas-satellite',
      minzoom: 3.4,
      paint: { ...ATLAS_SATELLITE_PAINT, 'raster-fade-duration': 450 },
    }, beforeId)
    // Voile bleu translucide sur la mer : garde les dégradés de profondeur de
    // l'imagerie avec un bleu plus lumineux. Disparaît avec elle.
    const water = layers[waterIndex]
    // Au-dessus de l'ombrage du relief : sur la mer, le voile lisse aussi son grain.
    const styleLayers = map.getStyle().layers
    const hillshadeIndex = styleLayers.findIndex(layer => layer.type === 'hillshade')
    const tintBeforeId = hillshadeIndex >= 0 ? styleLayers[hillshadeIndex + 1]?.id : beforeId
    if (water && 'source' in water) {
      map.addLayer({
        id: 'atlas-sea-tint',
        type: 'fill',
        source: water.source,
        'source-layer': water['source-layer'],
        filter: OCEAN_ONLY_FILTER,
        paint: {
          // Assez couvrant pour lisser le grain du fond marin.
          'fill-color': '#2f88cc',
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5.5, 0.62, 7.5, 0],
          'fill-antialias': true,
        },
      }, tintBeforeId)
    }
  } catch { /* imagerie indisponible : la carte vectorielle reste seule */ }
}

// Mer seulement (pas les lacs ni les rivières), d'après la classe OpenMapTiles.
const OCEAN_ONLY_FILTER: maplibregl.FilterSpecification = ['==', ['get', 'class'], 'ocean']

// Reflets sur la mer (public/sea-ripples.png, texture raccordable) : de larges
// reflets doux, sans lignes, posés sur la mer seulement. L'animation fait glisser
// la texture elle-même (pas la forme de la mer, qui reste calée sur les côtes).
const SEA_RIPPLES_IMAGE = 'atlas-sea-ripples'

async function addAtlasSeaRipples(map: maplibregl.Map) {
  if (map.getLayer(SEA_RIPPLES_IMAGE)) return null
  const { data } = await map.loadImage('/sea-ripples.png')
  const width = data.width
  const height = data.height
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null
  context.drawImage(data as CanvasImageSource, 0, 0)
  const pixels = context.getImageData(0, 0, width, height).data
  if (!map.getStyle()) return null
  map.addImage(SEA_RIPPLES_IMAGE, { width, height, data: new Uint8Array(pixels) })
  const above = map.getLayer('atlas-sea-tint') ? map.getStyle().layers.findIndex(layer => layer.id === 'atlas-sea-tint') : -1
  const water = map.getStyle().layers.find(l => l.type === 'fill' && /water/i.test(l.id) && !/waterway/i.test(l.id))
  if (!water || !('source' in water)) return null
  map.addLayer({
    id: SEA_RIPPLES_IMAGE,
    type: 'fill',
    source: water.source,
    'source-layer': water['source-layer'],
    filter: OCEAN_ONLY_FILTER,
    paint: {
      'fill-pattern': SEA_RIPPLES_IMAGE,
      'fill-opacity': ['interpolate', ['linear'], ['zoom'], 0, 1, 6, 0.85, 10, 0.45],
    },
  }, above >= 0 ? map.getStyle().layers[above + 1]?.id : undefined)
  return { width, height, pixels }
}

// Fait glisser les reflets doucement (≈ 12 images/s), en pause pendant les
// mouvements de carte (et 1,5 s après), quand l'onglet est caché, en vue très
// rapprochée ou si l'appareil demande moins d'animations.
const SEA_RIPPLES_QUIET_MS = 1500
function animateSeaRipples(map: maplibregl.Map, base: { width: number; height: number; pixels: Uint8ClampedArray }) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return () => {}
  const { width, height, pixels } = base
  const frame = new Uint8Array(pixels.length)
  const rowBytes = width * 4
  let raf = 0
  let last = 0
  let moving = false
  let movedAt = 0
  const onMoveStart = () => { moving = true }
  const onMoveEnd = () => { moving = false; movedAt = performance.now() }
  map.on('movestart', onMoveStart)
  map.on('moveend', onMoveEnd)
  const start = performance.now()
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick)
    // En pause pendant les zooms et déplacements : chaque image de reflets est
    // recopiée dans toutes les tuiles visibles (20 à 45 ms sur l'image suivante).
    // Entre deux crans de molette, la carte s'arrête un instant : on attend donc
    // un vrai moment de calme avant de reprendre.
    if (moving || now - movedAt < SEA_RIPPLES_QUIET_MS) return
    if (now - last < 80 || document.hidden || map.getZoom() > 10) return
    // Carte au repos sous le globe 3D : on ne la redessine pas pour rien.
    if (document.documentElement.dataset.globeVisible === 'true') return
    last = now
    // L'horodatage d'image peut précéder `start` : jamais de décalage négatif.
    const seconds = Math.max(0, now - start) / 1000
    const dx = Math.floor(seconds * 5) % width
    const dy = Math.floor(seconds * 1.2 + Math.sin(seconds * 0.25) * 8 + height * 4) % height
    for (let y = 0; y < height; y++) {
      const source = ((y + dy) % height) * rowBytes
      const target = y * rowBytes
      const split = dx * 4
      frame.set(pixels.subarray(source + split, source + rowBytes), target)
      frame.set(pixels.subarray(source, source + split), target + rowBytes - split)
    }
    try { map.updateImage(SEA_RIPPLES_IMAGE, { width, height, data: frame }) } catch { /* style rechargé */ }
  }
  raf = requestAnimationFrame(tick)
  return () => {
    cancelAnimationFrame(raf)
    map.off('movestart', onMoveStart)
    map.off('moveend', onMoveEnd)
  }
}

// Calottes aux pôles : textures et relief y convergent vers un point et dessinent
// des anneaux. Un fondu vers le bleu de l'océan les recouvre discrètement.
function addAtlasPolarCaps(map: maplibregl.Map, beforeId?: string) {
  if (map.getSource('atlas-polar-caps')) return
  const band = (from: number, to: number, opacity: number): GeoJSON.Feature<GeoJSON.Polygon, { opacity: number }> => ({
    type: 'Feature',
    properties: { opacity },
    geometry: {
      type: 'Polygon',
      coordinates: [[[-180, from], [180, from], [180, to], [-180, to], [-180, from]]],
    },
  })
  // Bandes d'un quart de degré de 79° à 85°, opacité en courbe douce (aucun bord
  // visible), puis une bande pleine jusqu'au pôle : au-delà de 85°, la carte étire
  // ce qu'elle a au bord, il faut donc que ce bord soit déjà couvert.
  const bands: Array<readonly [number, number, number]> = Array.from({ length: 24 }, (_, i) => {
    const t = (i + 1) / 24
    return [79 + i / 4, 79 + (i + 1) / 4, t * t * (3 - 2 * t)] as const
  })
  bands.push([85, 90, 1])
  map.addSource('atlas-polar-caps', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: bands.flatMap(([from, to, opacity]) => [band(from, to, opacity), band(-from, -to, opacity)]),
    },
  })
  map.addLayer({
    id: 'atlas-polar-caps',
    type: 'fill',
    source: 'atlas-polar-caps',
    paint: {
      // Bleu d'océan, proche de la mer voisine : la calotte se fond dans le décor.
      'fill-color': '#2f6fa6',
      'fill-opacity': ['get', 'opacity'],
    },
  }, beforeId)
}

// Hauts-fonds : frange claire et floue le long des côtes, décalée côté mer.
function addAtlasShallows(map: maplibregl.Map) {
  if (map.getLayer('atlas-shallows')) return
  const layers = map.getStyle().layers
  const water = layers.find(l => l.type === 'fill' && /water/i.test(l.id) && !/waterway/i.test(l.id))
  if (!water || !('source' in water)) return
  const width: maplibregl.ExpressionSpecification = ['interpolate', ['exponential', 1.6], ['zoom'], 0, 2, 3, 6, 6, 16, 9, 30]
  try {
    map.addLayer({
      id: 'atlas-shallows',
      type: 'line',
      source: water.source,
      'source-layer': water['source-layer'],
      filter: OCEAN_ONLY_FILTER,
      paint: {
        'line-color': ATLAS_PREMIUM_PALETTE.shallows,
        'line-width': width,
        'line-offset': ['interpolate', ['exponential', 1.6], ['zoom'], 0, 1, 3, 3, 6, 8, 9, 15],
        'line-blur': width,
        // Disparaît en vue rapprochée : sur les lacs, elle ferait des taches floues.
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.75, 5, 0.6, 7, 0],
      },
    }, layers[layers.indexOf(water) + 1]?.id)
  } catch { /* tile schemas may vary */ }
}

// Au dézoom maximal, les continents plutôt que les pays.
const ATLAS_CONTINENT_MAX_ZOOM = 3.4

function addAtlasContinentLabels(map: maplibregl.Map) {
  if (map.getSource('atlas-continent-labels')) return
  const continents: Array<[string, string, [number, number]]> = [
    ['AFRICA', 'AFRIQUE', [20, 4]],
    ['EUROPE', 'EUROPE', [15, 52]],
    ['ASIA', 'ASIE', [90, 45]],
    ['NORTH AMERICA', 'AMÉRIQUE DU NORD', [-100, 45]],
    ['SOUTH AMERICA', 'AMÉRIQUE DU SUD', [-60, -15]],
    ['OCEANIA', 'OCÉANIE', [134, -25]],
    ['ANTARCTICA', 'ANTARCTIQUE', [0, -80]],
  ]
  map.addSource('atlas-continent-labels', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: continents.map(([en, fr, coordinates]) => ({
        type: 'Feature',
        properties: { name: t(en, fr) },
        geometry: { type: 'Point', coordinates },
      })),
    },
  })
  map.addLayer({
    id: 'atlas-continent-labels',
    type: 'symbol',
    source: 'atlas-continent-labels',
    maxzoom: ATLAS_CONTINENT_MAX_ZOOM,
    layout: {
      'text-allow-overlap': true,
      'text-field': ['get', 'name'],
      'text-font': ['Roboto Bold', 'Noto Sans Bold'],
      'text-letter-spacing': 0.42,
      'text-max-width': 14,
      'text-size': ['interpolate', ['linear'], ['zoom'], 0, 12, 3, 16],
    },
    paint: {
      'text-color': 'rgba(255, 255, 255, 0.92)',
      'text-halo-color': 'rgba(20, 44, 80, 0.45)',
      'text-halo-width': 1.4,
      'text-halo-blur': 0.8,
    },
  })
}

function addAtlasCountryLabels(map: maplibregl.Map) {
  if (map.getSource('atlas-country-labels')) return

  map.addSource('atlas-country-labels', {
    type: 'geojson',
    data: ATLAS_COUNTRY_LABELS,
  })

  map.addLayer({
    id: 'atlas-country-labels',
    type: 'symbol',
    source: 'atlas-country-labels',
    // Les pays prennent le relais des continents en zoomant.
    minzoom: ATLAS_CONTINENT_MAX_ZOOM,
    maxzoom: 8,
    layout: {
      'symbol-sort-key': ['get', 'priority'],
      'text-allow-overlap': true,
      'text-field': ['get', 'name'],
      'text-font': ['Roboto Bold', 'Noto Sans Bold'],
      'text-ignore-placement': false,
      'text-letter-spacing': 0.16,
      'text-max-width': 8,
      'text-size': [
        'interpolate', ['linear'], ['zoom'],
        0, 9.5,
        2, 11.5,
        4, 13.5,
        7, 15,
      ],
    },
    paint: {
      // Blanc avec ombre bleutée, comme les continents : lisible sur l'imagerie.
      'text-color': 'rgba(255, 255, 255, 0.95)',
      'text-halo-blur': 0.8,
      'text-halo-color': 'rgba(20, 44, 80, 0.5)',
      'text-halo-width': 1.4,
      'text-opacity': [
        'interpolate', ['linear'], ['zoom'],
        0, 0.62,
        2, 0.86,
        7, 0.78,
      ],
    },
  })
}

// Ombrage refait de zéro (nouvelle source, visible dès la vue monde alors que
// MapTiler ne l'affiche qu'à partir du zoom 3).
// Le relief MapTiler n'a pas de fonds marins (0 m partout en mer). Les Terrain
// Tiles (données ouvertes AWS, sans clé) les ont : on les utilise pour tout le
// relief, posé au-dessus de l'eau pour sculpter dorsales, fosses et plateaux.
const ATLAS_DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

function replaceAtlasHillshade(map: maplibregl.Map, layer: maplibregl.LayerSpecification) {
  if (layer.type !== 'hillshade') return
  const palette = ATLAS_PREMIUM_PALETTE
  const layers = map.getStyle().layers
  const waterIndex = layers.findIndex(l => l.type === 'fill' && /water/i.test(l.id) && !/waterway/i.test(l.id))
  const beforeId = waterIndex >= 0 ? layers[waterIndex + 1]?.id : undefined
  try {
    map.removeLayer(layer.id)
    if (!map.getSource('atlas-dem')) {
      map.addSource('atlas-dem', { type: 'raster-dem', tiles: [ATLAS_DEM_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 8 })
    }
    map.addLayer({
      id: layer.id,
      type: 'hillshade',
      source: 'atlas-dem',
      minzoom: 0,
      paint: {
        // Méthode « igor » : ombrage doux, sans le grain du multidirectionnel.
        'hillshade-method': 'igor',
        'hillshade-illumination-direction': 315,
        'hillshade-highlight-color': 'rgba(255, 252, 244, 0.7)',
        'hillshade-shadow-color': palette.relief,
        'hillshade-accent-color': 'rgba(0, 0, 0, 0)',
        'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 0, 1, 4, 0.7, 8, 0.4],
      },
    }, beforeId)
  } catch { /* tile schemas may vary */ }
}

function customizeAtlasPremiumStyle(map: maplibregl.Map) {
  const palette = ATLAS_PREMIUM_PALETTE

  const layers = map.getStyle().layers
  for (const layer of layers) {
    const { id, type } = layer
    const lid = id.toLowerCase()

    if (type === 'hillshade') {
      replaceAtlasHillshade(map, layer)
      continue
    }

    if (type === 'background') {
      safeSetPaint(map, id, 'background-color', palette.land)
      continue
    }

    if (type === 'fill') {
      if (/water/.test(lid) && !/waterway|waterfall|land/.test(lid)) {
        // Bleu franc mais clair sur le globe, plus profond quand on zoome.
        safeSetPaint(map, id, 'fill-color', ['interpolate', ['linear'], ['zoom'], 2.5, palette.seaVivid, 7, palette.seaDeep])
        safeSetPaint(map, id, 'fill-opacity', 0.94)
        continue
      }

      // Végétation, glaces et déserts colorés dès le globe, comme un atlas.
      if (/wood|forest|tree/.test(lid)) {
        safeSetPaint(map, id, 'fill-color', palette.forest)
        safeSetPaint(map, id, 'fill-opacity', ['interpolate', ['linear'], ['zoom'], 0, 0.62, 4, 0.5, 7, 0.38])
        continue
      }

      if (/scrub|grass|meadow|park|green/.test(lid)) {
        safeSetPaint(map, id, 'fill-color', palette.meadow)
        safeSetPaint(map, id, 'fill-opacity', ['interpolate', ['linear'], ['zoom'], 0, 0.55, 4, 0.42, 7, 0.32])
        continue
      }

      if (/glacier|ice|snow/.test(lid)) {
        safeSetPaint(map, id, 'fill-color', '#ffffff')
        safeSetPaint(map, id, 'fill-opacity', 0.92)
        continue
      }

      if (/sand|beach|desert/.test(lid)) {
        safeSetPaint(map, id, 'fill-color', palette.sand)
        safeSetPaint(map, id, 'fill-opacity', 0.72)
        continue
      }

      if (/landcover|landuse|earth|land|country|admin/.test(lid) && !/label|boundary|border/.test(lid)) {
        safeSetPaint(map, id, 'fill-color', palette.land)
        safeSetPaint(map, id, 'fill-opacity', 0.68)
        continue
      }

      hideLayer(map, id)
      continue
    }

    if (type === 'symbol') {
      if (/country/.test(lid) && /label/.test(lid)) {
        hideLayer(map, id)
        continue
      }

      if (/ocean/.test(lid) && /label/.test(lid)) {
        safeSetLayout(map, id, 'visibility', 'visible')
        safeSetLayerZoomRange(map, id, 0, 24)
        safeSetPaint(map, id, 'text-color', palette.labelOcean)
        safeSetPaint(map, id, 'text-opacity', 0.85)
        safeSetPaint(map, id, 'text-halo-color', 'rgba(52, 110, 160, 0.35)')
        safeSetPaint(map, id, 'text-halo-width', 1.1)
        safeSetPaint(map, id, 'text-halo-blur', 0.25)
        safeSetLayout(map, id, 'text-font', ['Open Sans Italic'])
        safeSetLayout(map, id, 'text-letter-spacing', 0.18)
        safeSetLayout(map, id, 'text-size', ['interpolate', ['linear'], ['zoom'], 0, 12, 3, 15, 6, 17])
        continue
      }

      if (/sea/.test(lid) && /label/.test(lid)) {
        safeSetLayout(map, id, 'visibility', 'visible')
        safeSetLayerZoomRange(map, id, 0, 24)
        safeSetPaint(map, id, 'text-color', palette.labelOcean)
        safeSetPaint(map, id, 'text-opacity', 0.5)
        safeSetPaint(map, id, 'text-halo-color', 'rgba(52, 110, 160, 0.3)')
        safeSetPaint(map, id, 'text-halo-width', 0.8)
        safeSetLayout(map, id, 'text-font', ['Open Sans Italic'])
        safeSetLayout(map, id, 'text-letter-spacing', 0.14)
        continue
      }

      hideLayer(map, id)
      continue
    }

    if (/road|tunnel|bridge|transit|rail|aeroway|building|poi|ferry|indoor|path|track|gate|aerodrome|runway|taxiway|pier|dam|parking|steps|pedestrian|cycleway|footway/.test(lid)) {
      hideLayer(map, id)
      continue
    }

    if (/contour|graticule|grid|tropic|equator|arctic|antarctic|polar|meridian|parallel/.test(lid)) {
      hideLayer(map, id)
      continue
    }

    if (type === 'line' && /coast|shore|water/.test(lid)) {
      safeSetPaint(map, id, 'line-color', palette.coast)
      safeSetPaint(map, id, 'line-opacity', ['interpolate', ['linear'], ['zoom'], 0, 0.16, 3, 0.32, 7, 0.22])
      safeSetPaint(map, id, 'line-width', ['interpolate', ['linear'], ['zoom'], 0, 0.6, 4, 1.9, 8, 3.2])
      safeSetPaint(map, id, 'line-blur', 1.7)
      continue
    }

    if (type === 'line' && /river|canal|stream/.test(lid)) {
      safeSetPaint(map, id, 'line-color', 'rgba(137, 184, 204, 0.18)')
      safeSetPaint(map, id, 'line-width', 0.35)
      safeSetPaint(map, id, 'line-opacity', 0.32)
      safeSetPaint(map, id, 'line-blur', 0.4)
      continue
    }

    if (type === 'line' && /boundary|admin|border/.test(lid) && (/-bg$/.test(lid) || /disputed|claim/.test(lid))) {
      hideLayer(map, id)
      continue
    }

    if (type === 'line' && /boundary|admin|border/.test(lid)) {
      safeSetPaint(map, id, 'line-color', palette.border)
      safeSetPaint(map, id, 'line-opacity', ['interpolate', ['linear'], ['zoom'], 0, 0.2, 4, 0.28, 7, 0.18])
      safeSetPaint(map, id, 'line-width', ['interpolate', ['linear'], ['zoom'], 0, 0.25, 4, 0.38, 8, 0.55])
      safeSetPaint(map, id, 'line-blur', 0.25)
      continue
    }

    if (type === 'line') {
      safeSetPaint(map, id, 'line-color', palette.borderSoft)
      safeSetPaint(map, id, 'line-width', 0.25)
      safeSetPaint(map, id, 'line-opacity', 0.16)
    }
  }

  addAtlasShallows(map)
  addAtlasSatellite(map)
  // Au-dessus de l'eau, du relief et des reflets, sous les frontières et les noms :
  // premier calque de type ligne ou texte après l'ombrage du relief.
  const styleLayers = map.getStyle().layers
  const afterHillshade = styleLayers.slice(styleLayers.findIndex(layer => layer.type === 'hillshade') + 1)
  addAtlasPolarCaps(map, afterHillshade.find(layer => layer.type === 'line' || layer.type === 'symbol')?.id)
  addAtlasCountryLabels(map)
  addAtlasContinentLabels(map)
}

// ─── Customize MapTiler style layers ─────────────────────────────────────────
// Stratégie : ESRI raster très désaturé (hillshade/texture) + fills vector atlas
// sur palette : bleu glacier / blanc sable / vert sauge / frontières fantôme
function customizeStyle(map: maplibregl.Map) {
  // ── ESRI World Physical en fond — relief ombré, quasi greyscale
  map.addSource('esri-physical', {
    type: 'raster',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Physical_Map/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    attribution: '© Esri'
  })
  const firstLayerId = map.getStyle().layers[0]?.id
  map.addLayer({
    id: 'esri-physical-raster',
    type: 'raster',
    source: 'esri-physical',
    paint: {
      'raster-opacity': 0.32,        // texture relief uniquement — couleur via fills vector
      'raster-saturation': -0.80,    // quasi greyscale → la couleur vient du vector
      'raster-contrast': 0.22,
      'raster-brightness-max': 0.88,
    }
  }, firstLayerId)

  // ── Layers MapTiler vector : palette atlas premium
  for (const layer of map.getStyle().layers) {
    const { id, type } = layer
    const lid = id.toLowerCase()

    // ── Hillshade → masqué (ESRI fournit)
    if (type === 'hillshade') {
      map.setLayoutProperty(id, 'visibility', 'none')
      continue
    }

    // ── Background → fond terre blanc cassé sable
    if (type === 'background') {
      map.setPaintProperty(id, 'background-color', '#ede8dc')
      continue
    }

    // ── Fills → palette sélective
    if (type === 'fill') {
      // Eau (océan / lacs) → bleu glacier pâle semi-transparent
      if (/water/.test(lid) && !/waterway|waterfall|land/.test(lid)) {
        map.setPaintProperty(id, 'fill-color', '#b6d4e3')
        map.setPaintProperty(id, 'fill-opacity', 0.58)
        continue
      }
      // Forêt → vert sauge désaturé
      if (/wood|forest|tree/.test(lid)) {
        map.setPaintProperty(id, 'fill-color', '#a8c490')
        map.setPaintProperty(id, 'fill-opacity', 0.28)
        continue
      }
      // Scrub / prairie / parc → vert sauge plus clair
      if (/scrub|grass|meadow|park|green/.test(lid)) {
        map.setPaintProperty(id, 'fill-color', '#b8cc9e')
        map.setPaintProperty(id, 'fill-opacity', 0.22)
        continue
      }
      // Glace / neige → blanc bleuté
      if (/glacier|ice|snow/.test(lid)) {
        map.setPaintProperty(id, 'fill-color', '#e8f2f5')
        map.setPaintProperty(id, 'fill-opacity', 0.65)
        continue
      }
      // Sable / désert → beige chaud
      if (/sand|beach|desert/.test(lid)) {
        map.setPaintProperty(id, 'fill-color', '#e8dfc8')
        map.setPaintProperty(id, 'fill-opacity', 0.40)
        continue
      }
      // Tout le reste (urbain, landuse, bâtiments…) → masqué
      map.setLayoutProperty(id, 'visibility', 'none')
      continue
    }

    // ── Labels : typographie atlas premium — matching strict sur les noms exacts
    if (type === 'symbol') {
      if (lid === 'country labels') {
        // Pays : uppercase espacé, gris chaud — filtre zoom natif outdoor-v2 conservé
        map.setPaintProperty(id, 'text-color', '#7a7060')
        map.setPaintProperty(id, 'text-halo-color', 'rgba(242,238,228,0.82)')
        map.setPaintProperty(id, 'text-halo-width', 1.8)
        map.setLayoutProperty(id, 'text-font', ['Open Sans Bold'])
        map.setLayoutProperty(id, 'text-transform', 'uppercase')
        map.setLayoutProperty(id, 'text-letter-spacing', 0.18)
        continue
      }
      if (lid === 'ocean labels') {
        map.setPaintProperty(id, 'text-color', 'rgba(130,165,188,0.88)')
        map.setPaintProperty(id, 'text-halo-color', 'rgba(180,215,235,0.20)')
        map.setPaintProperty(id, 'text-halo-width', 1.2)
        map.setLayoutProperty(id, 'text-font', ['Open Sans Italic'])
        map.setLayoutProperty(id, 'text-letter-spacing', 0.22)
        continue
      }
      if (lid === 'sea labels') {
        map.setPaintProperty(id, 'text-color', 'rgba(130,165,188,0.72)')
        map.setPaintProperty(id, 'text-halo-color', 'rgba(180,215,235,0.16)')
        map.setPaintProperty(id, 'text-halo-width', 1.0)
        map.setLayoutProperty(id, 'text-font', ['Open Sans Italic'])
        map.setLayoutProperty(id, 'text-letter-spacing', 0.18)
        continue
      }
      // Tout le reste (régions, villes, oblasts…) → masqué
      map.setLayoutProperty(id, 'visibility', 'none')
      continue
    }

    // ── Routes, transport, infra → masqués
    if (/road|tunnel|bridge|transit|rail|aeroway|building|poi|ferry|indoor|path|track|gate|aerodrome|runway|taxiway|pier|dam|parking|steps|pedestrian|cycleway|footway/.test(lid)) {
      map.setLayoutProperty(id, 'visibility', 'none')
      continue
    }

    // ── Contours / graticule → masqués
    if (/contour|graticule|grid|tropic|equator|arctic|antarctic|polar|meridian|parallel/.test(lid)) {
      map.setLayoutProperty(id, 'visibility', 'none')
      continue
    }

    // ── Rivières / côtes → masqués (ESRI les montre)
    if (type === 'line' && /waterway|river|canal|stream|coast/.test(lid)) {
      map.setLayoutProperty(id, 'visibility', 'none')
      continue
    }

    // ── Halos admin / frontières disputées → masqués
    if (type === 'line' && /boundary|admin|border/.test(lid) && (/-bg$/.test(lid) || /disputed|claim/.test(lid))) {
      map.setLayoutProperty(id, 'visibility', 'none')
      continue
    }

    // ── Frontières → fantôme atlas (gris chaud très léger)
    if (type === 'line' && /boundary|admin|border/.test(lid)) {
      map.setPaintProperty(id, 'line-color', 'rgba(168,152,128,0.16)')
      map.setPaintProperty(id, 'line-width', 0.45)
      continue
    }
  }
}

// ─── Zone + route layers ──────────────────────────────────────────────────────
function clearZoneRouteLayers(map: maplibregl.Map) {
  const style = map.getStyle()
  if (!style?.layers || !style.sources) return
  for (const l of style.layers) {
    if (l.id.startsWith('_z_') || l.id.startsWith('_r_')) {
      try { map.removeLayer(l.id) } catch { /* already removed */ }
    }
  }
  for (const sid of Object.keys(style.sources)) {
    if (sid.startsWith('_z_') || sid.startsWith('_r_')) {
      try { map.removeSource(sid) } catch { /* already removed */ }
    }
  }
}

function addZoneLayer(map: maplibregl.Map, d: Destination, owner: 'me' | 'friend') {
  if (!map.isStyleLoaded()) return
  const color = getDestinationColor(d)
  if (!color) return
  const sid = `_z_${owner}_${d.name}`

  let geometry: GeoJSON.Geometry | null = null
  if (d.geojson) {
    geometry = d.geojson
  } else if (d.extent) {
    const [w, s, e, n] = d.extent
    geometry = { type: 'Polygon', coordinates: [[[w,s],[e,s],[e,n],[w,n],[w,s]]] }
  }
  if (!geometry || map.getSource(sid)) return

  map.addSource(sid, { type: 'geojson', data: { type: 'Feature', geometry, properties: {} } })
  map.addLayer({
    id: `${sid}_fill`, type: 'fill', source: sid,
    paint: { 'fill-color': color, 'fill-opacity': owner === 'friend' ? 0.35 : 0.13 },
  })
  // White glow border for organic feel
  map.addLayer({
    id: `${sid}_line_glow`, type: 'line', source: sid,
    paint: {
      'line-color': '#ffffff',
      'line-width': owner === 'friend' ? 5 : 4,
      'line-opacity': owner === 'friend' ? 0.55 : 0.45,
      'line-blur': 2,
    },
  })
  // Colored border on top
  map.addLayer({
    id: `${sid}_line`, type: 'line', source: sid,
    paint: {
      'line-color': owner === 'friend' ? '#7C8DB5' : color,
      'line-width': owner === 'friend' ? 1.8 : 1.4,
      'line-opacity': owner === 'friend' ? 0.75 : 0.55,
    },
  })
}

// Route line + stops are rendered by SVG overlay (RoutePath + RouteStop) — no MapLibre layer needed.

function syncZoneRouteLayers(
  map: maplibregl.Map,
  destinations: Destination[],
  friendDestinations?: Destination[],
  sharedNames?: Set<string>,
) {
  clearZoneRouteLayers(map)
  const shared = sharedNames ?? new Set<string>()
  for (const d of destinations) {
    if (d.kind === 'zone') {
      addZoneLayer(map, d, 'me')
    }
  }
  if (friendDestinations) {
    for (const d of friendDestinations) {
      if (d.kind === 'zone' && !shared.has(destinationNameKey(d))) addZoneLayer(map, d, 'friend')
    }
  }
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function WorldMap({
  destinations, flyTarget, selectedName, onSelect, onDeselect, onFlyTargetConsumed,
  friendDestinations, friendInitials, friendAvatarUrl, friendAvatarBg, friendAvatarFg, sharedNames,
  controlsMode = 'overlay-bottom',
  legendMode = 'overlay-bottom',
  hidden,
  mapDetail = 'simple',
}: WorldMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapRef          = useRef<maplibregl.Map | null>(null)
  const svgRef          = useRef<SVGSVGElement>(null)
  const pinsGroupRef    = useRef<SVGGElement>(null)
  const globeGlowRef    = useRef<HTMLDivElement>(null)
  const stopSeaRipplesRef = useRef<(() => void) | null>(null)
  const htmlMarkersRef  = useRef<Array<{ marker: maplibregl.Marker; root?: Root; element: HTMLDivElement }>>([])
  const projFnRef       = useRef<Proj>(() => null)
  const lastAutoFitFingerprintRef = useRef<string | null>(null)
  const autoFitTimeoutRef = useRef<number | null>(null)

  const [mapReady, setMapReady] = useState(false)
  const [mapError, setMapError] = useState<string | null>(null)
  const [compactPins, setCompactPins] = useState(true)
  const [mapZoom, setMapZoom] = useState(INIT_ZOOM)
  const [mapSize, setMapSize] = useState({ width: 0, height: 0 })
  const [expandedRouteKey, setExpandedRouteKey] = useState<string | null>(null)
  const [notationOpen, setNotationOpen] = useState(true)
  // Globe 3D : visible en vue monde ; il passe le relais à la carte au clic sur
  // une destination ou en zoomant, et revient au dézoom.
  const [globeVisible, setGlobeVisible] = useState(true)
  const [globeFly, setGlobeFly] = useState<GlobeCameraRequest | null>(null)
  const [globeReturn, setGlobeReturn] = useState<GlobeCameraRequest | null>(null)
  const earthPinElements = useRef(new Map<string, HTMLDivElement>())
  // Globe en train de s'effacer sur la carte : il reste animé jusqu'au bout du
  // fondu (la caméra continue sa plongée dans les nuages).
  const [globeFading, setGlobeFading] = useState(false)
  const globeVisibleRef = useRef(globeVisible)
  globeVisibleRef.current = globeVisible
  useEffect(() => {
    // Pins de la carte affichés seulement une fois le globe effacé : jamais deux
    // jeux de pins à la fois pendant le fondu.
    document.documentElement.dataset.globeVisible = String(globeVisible || globeFading)
    return () => { delete document.documentElement.dataset.globeVisible }
  }, [globeVisible, globeFading])
  // Fond spatial du globe : titre de la page en clair (index.css). Seul décor
  // restant depuis le retrait des scènes de démonstration.
  useEffect(() => {
    document.documentElement.dataset.mapScene = 'earth3d'
    return () => { delete document.documentElement.dataset.mapScene }
  }, [])

  const legendTooltipIdBase = useId()
  const controlsClass = controlsMode === 'stacked-left'
    ? ' map-controls--stacked-left'
    : controlsMode === 'bottom-left'
      ? ' map-controls--bottom-left'
      : ''
  const legendClass = legendMode === 'stacked-left'
    ? ' legend--stacked-left'
    : legendMode === 'bottom-left'
      ? ' legend--bottom-left'
      : ''
  const showLegendLabel = legendMode === 'stacked-left' || legendMode === 'bottom-left'
  const legendItems = [
    {
      tier: 'S',
      label: t('Gem', 'Pépite'),
      description: t("A favorite you'd send anyone to.", "Un coup de cœur où tu enverrais n'importe qui."),
    },
    {
      tier: 'A',
      label: t('Great', 'Génial'),
      description: t("You'd tell a friend to go for it.", "Tu dirais à un ami de foncer."),
    },
    {
      tier: 'B',
      label: t('Nice', 'Sympa'),
      description: t("Worth it, without getting carried away.", "Ça vaut le coup, sans s'emballer."),
    },
    {
      tier: 'C',
      label: t('Mixed', 'Mitigé'),
      description: t("Meh, there's better out there.", "Bof, il y a mieux ailleurs."),
    },
    {
      tier: 'D',
      label: t('Not for me', 'Pas pour moi'),
      description: t("Not your thing, you'd tell people to skip it.", "Pas pour toi, tu le déconseilles."),
    },
  ] as const

  function clearHtmlMarkers() {
    for (const entry of htmlMarkersRef.current) {
      entry.marker.remove()
      if (entry.root) window.setTimeout(() => entry.root?.unmount(), 0)
    }
    htmlMarkersRef.current = []
  }

  function describeMapInitError(error: unknown, source?: string) {
    const raw = error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'WebGL initialization failed.'
    const normalized = raw.replace(/\s+/g, ' ').trim()

    let detail = 'Browser hardware acceleration is unavailable.'
    if (/EGL_NO_CONFIG|EXHAUSTED_DRIVERS|Failed to initialize WebGL|webgl/i.test(normalized)) {
      detail = 'Browser hardware acceleration is unavailable.'
    } else if (/context/i.test(normalized)) {
      detail = 'The graphics context could not be created.'
    }

    return source ? `${source} ${detail}` : detail
  }

  // ── Init MapLibre ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return

    const container = mapContainerRef.current
    const handleWebGlError = (event: Event) => {
      const webglEvent = event as Event & { statusMessage?: string; message?: string }
      const detail = webglEvent.statusMessage ?? webglEvent.message ?? 'The browser could not create a WebGL context.'
      console.error('WorldMap WebGL context creation failed:', webglEvent)
      setMapError(describeMapInitError(detail, 'Map unavailable.'))
    }

    container.addEventListener('webglcontextcreationerror', handleWebGlError as EventListener)

    let map: maplibregl.Map
    try {
      map = new maplibregl.Map({
        container,
        style: STYLE_URL,
        center: INIT_CENTER,
        zoom: getWorldZoom(container.clientWidth, container.clientHeight),
        // Un seul monde. Ne pas ajouter de maxBounds [-180, 180] : les deux bords
        // se confondent et le calcul du zoom plante.
        renderWorldCopies: false,
        ...CINEMATIC_CAMERA,
        transformCameraUpdate: ({ zoom }) => {
          const amount = cinematicAmount(zoom)
          return { pitch: CINEMATIC_CAMERA.pitch * amount, bearing: CINEMATIC_CAMERA.bearing * amount }
        },
        // Zoom plus fluide : on garde plus de tuiles en mémoire (le dézoom les
        // retrouve), on laisse finir celles demandées pendant un zoom au lieu de
        // les annuler, et les textures apparaissent en fondu.
        maxTileCacheSize: 1200,
        maxTileCacheZoomLevels: 8,
        cancelPendingTileRequestsWhileZooming: false,
        fadeDuration: 350,
        attributionControl: false,
        pitchWithRotate: false,
        dragRotate: false,
        canvasContextAttributes: {
          antialias: false,
          preserveDrawingBuffer: false,
          powerPreference: 'default',
          failIfMajorPerformanceCaveat: false,
          desynchronized: false,
          alpha: true,
          depth: true,
          stencil: true,
          premultipliedAlpha: true,
          // Pas de contextType : MapLibre essaie WebGL2 puis retombe sur WebGL1.
          // Forcer WebGL1 faisait mesurer la projection du globe par une lecture
          // GPU synchrone (readPixels) à chaque zoom : de petits à-coups.
        },
      })
      setMapError(null)
    } catch (error) {
      console.error('WorldMap failed to initialize MapLibre:', error)
      setMapError(describeMapInitError(error, 'Map unavailable.'))
      container.removeEventListener('webglcontextcreationerror', handleWebGlError as EventListener)
      return
    }

    // Molette plus rapide que le réglage par défaut (1/450) : revenir d'une
    // destination au globe demandait près de 40 crans, une douzaine maintenant.
    map.scrollZoom.setWheelZoomRate(1 / 130)
    map.on('load', () => {
      customizeAtlasPremiumStyle(map)
      void addAtlasSeaRipples(map).then(base => {
        if (base && mapRef.current === map) stopSeaRipplesRef.current = animateSeaRipples(map, base)
      }).catch(() => { /* reflets indisponibles : la mer reste fixe */ })
      // Globe en vue monde ; MapLibre repasse tout seul en carte plate en zoomant.
      map.setProjection({ type: 'globe' })
      // Ciel MapLibre transparent aussi : sinon une bande laiteuse coupe le haut du
      // globe quand la caméra est inclinée.
      map.setSky({
        // Atmosphère native (diffusion de la lumière) : liseré bleu clair autour
        // du globe, qui s'efface quand la carte redevient plate.
        'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.65, 3.5, 0.55, 6, 0],
        'sky-color': 'rgba(0, 0, 0, 0)',
        'horizon-color': 'rgba(0, 0, 0, 0)',
        'fog-color': 'rgba(0, 0, 0, 0)',
        'sky-horizon-blend': 0,
        'horizon-fog-blend': 0,
        'fog-ground-blend': 1,
      })
      // Lumière de l'atmosphère, fixe par rapport à l'écran (lumière de studio) :
      // presque de face, légèrement en haut à gauche ; le liseré reste fin et un peu
      // plus clair de ce côté. Le moteur n'éclaire pas la surface du globe elle-même.
      map.setLight({ anchor: 'viewport', position: [1.5, 300, 25] })
      updateMapPadding(map)
      // Projection brute pour le rendu React : updatePins masque ensuite la face cachée.
      projFnRef.current = ([lng, lat]) => {
        const { x, y } = map.project([lng, lat] as maplibregl.LngLatLike)
        return [x, y]
      }
      setCompactPins(Math.pow(2, map.getZoom() - INIT_ZOOM) < 2)
      setMapZoom(map.getZoom())
      // À l'image suivante : la projection globe doit être en place pour mesurer
      // le globe. (Pas de map.redraw() ici : « load » est émis pendant un rendu.)
      requestAnimationFrame(() => updateMinZoom(map))
      updateGlobeGlow(map, globeGlowRef.current)
      setMapReady(true)
    })

    // Mise à jour directe du DOM des pins — zéro re-render React par frame
    map.on('move', () => {
      updatePins(map)
      updateGlobeGlow(map, globeGlowRef.current)
    })
    map.on('resize', () => {
      updateMapPadding(map)
      updateMinZoom(map)
      updateGlobeGlow(map, globeGlowRef.current)
    })
    // Retour au globe 3D pendant le dézoom, dès qu'on repasse sous l'échelle du
    // relais (avec une marge, pour ne pas faire de va-et-vient).
    let lastZoom = map.getZoom()
    map.on('zoom', () => {
      const zoom = map.getZoom()
      const zoomingOut = zoom < lastZoom
      lastZoom = zoom
      if (!zoomingOut || globeVisibleRef.current) return
      const center = map.getCenter()
      if (globeDistanceForZoom(map, zoom, center.lat) <= RETURN_TO_GLOBE_DISTANCE) return
      map.stop()
      setGlobeReturn({ lat: center.lat, lng: center.lng, token: Date.now(), distance: globeDistanceForZoom(map, zoom, center.lat) })
      setGlobeVisible(true)
    })
    map.on('zoomend', () => {
      setCompactPins(Math.pow(2, map.getZoom() - INIT_ZOOM) < 2)
      setMapZoom(map.getZoom())
    })

    mapRef.current = map
    return () => {
      if (autoFitTimeoutRef.current !== null) window.clearTimeout(autoFitTimeoutRef.current)
      clearHtmlMarkers()
      container.removeEventListener('webglcontextcreationerror', handleWebGlError as EventListener)
      stopSeaRipplesRef.current?.()
      map.remove()
      mapRef.current = null
      setMapReady(false)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Toggle detail layers (city/place labels + more visible borders) when mapDetail changes.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const style = map.getStyle()
    if (!style?.layers) return
    const isDetailed = mapDetail === 'detailed'
    for (const layer of style.layers) {
      const lid = layer.id.toLowerCase()
      if (layer.type === 'symbol' && /place|city|town|village|capital|settlement|suburb|locality|neighbourhood/.test(lid)) {
        safeSetLayout(map, layer.id, 'visibility', isDetailed ? 'visible' : 'none')
      }
      if (layer.type === 'line' && /boundary|admin|border/.test(lid) && !/-bg$/.test(lid) && !/disputed|claim/.test(lid)) {
        if (isDetailed) {
          safeSetPaint(map, layer.id, 'line-opacity', 0.55)
          safeSetPaint(map, layer.id, 'line-width', ['interpolate', ['linear'], ['zoom'], 0, 0.5, 4, 0.9, 8, 1.4])
        } else {
          safeSetPaint(map, layer.id, 'line-opacity', ['interpolate', ['linear'], ['zoom'], 0, 0.2, 4, 0.28, 7, 0.18])
          safeSetPaint(map, layer.id, 'line-width', ['interpolate', ['linear'], ['zoom'], 0, 0.25, 4, 0.38, 8, 0.55])
        }
      }
    }
  }, [mapDetail, mapReady])

  useEffect(() => {
    if (!mapContainerRef.current) return
    const updateMapSize = () => {
      const rect = mapContainerRef.current?.getBoundingClientRect()
      if (!rect) return
      setMapSize(previous => {
        const width = Math.round(rect.width)
        const height = Math.round(rect.height)
        return previous.width === width && previous.height === height ? previous : { width, height }
      })
    }
    updateMapSize()
    const observer = new ResizeObserver(updateMapSize)
    observer.observe(mapContainerRef.current)
    return () => observer.disconnect()
  }, [])

  // ── Resize MapLibre quand la map redevient visible ─────────────────────────
  useEffect(() => {
    if (hidden || !mapReady || !mapRef.current) return
    mapRef.current.resize()
    updatePins(mapRef.current)
  }, [hidden, mapReady]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Clic sur le fond de carte → désélectionne ──────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const handler = () => {
      setExpandedRouteKey(null)
      onDeselect?.()
    }
    map.on('click', handler)
    return () => { map.off('click', handler) }
  }, [mapReady, onDeselect])

  // ── Sync zones / routes quand destinations change ───────────────────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    try {
      syncZoneRouteLayers(mapRef.current, destinations, friendDestinations, sharedNames)
    } catch {
      // style not yet ready — will re-run when mapReady changes
    }
  }, [mapReady, destinations, friendDestinations, sharedNames])

  // ── Repositionner les pins au chargement et aux changements ─────────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    updatePins(mapRef.current)
  }, [mapReady, destinations, friendDestinations, expandedRouteKey, selectedName])

  // Cadrage automatique du carnet au premier affichage (et quand on change de jeu
  // de destinations), sans voler la caméra pendant un focus explicite sur un pin.
  useEffect(() => {
    if (hidden || !mapReady || !mapRef.current || flyTarget || selectedName) return
    const fingerprint = getMapFocusFingerprint(destinations, friendDestinations)
    const fitKey = `${fingerprint}@${mapSize.width}x${mapSize.height}`
    if (fitKey === lastAutoFitFingerprintRef.current || !mapSize.width || !mapSize.height) return
    lastAutoFitFingerprintRef.current = fitKey
    if (autoFitTimeoutRef.current !== null) window.clearTimeout(autoFitTimeoutRef.current)
    autoFitTimeoutRef.current = window.setTimeout(() => {
      if (!mapRef.current) return
      // Déjà descendu du globe 3D vers la carte : on ne vole pas la caméra.
      if (!globeVisibleRef.current) return
      mapRef.current.resize()
      fitMapToDestinations(mapRef.current, destinations, friendDestinations, { duration: 780 })
    }, 120)
  }, [hidden, mapReady, destinations, friendDestinations, flyTarget, selectedName, mapSize])

  // Préchargement des tuiles autour des destinations, une fois le globe affiché.
  // Relancé seulement si les positions changent, pas à chaque rendu.
  const prefetchKey = getMapFocusFingerprint(destinations, friendDestinations)
  useEffect(() => {
    if (!mapReady || !mapRef.current || !prefetchKey) return
    const map = mapRef.current
    const points = prefetchKey.split('|').map(pair => {
      const [lng, lat] = pair.split(',').map(Number)
      return { lng, lat }
    })
    const controller = new AbortController()
    const timeout = window.setTimeout(() => {
      void prefetchDestinationTiles(map, points, controller.signal)
    }, 2500)
    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [mapReady, prefetchKey])

  // ── Mise à jour directe des transforms SVG (bypass React) ──────────────────
  function updatePins(map: maplibregl.Map) {
    if (!pinsGroupRef.current) return

    pinsGroupRef.current.querySelectorAll<SVGGElement>('g.stop-root').forEach(el => {
      const lng = parseFloat(el.dataset.lng ?? '0')
      const lat = parseFloat(el.dataset.lat ?? '0')
      if (!isFinite(lng) || !isFinite(lat)) return
      const point = projectVisible(map, lng, lat)
      el.style.visibility = point ? '' : 'hidden'
      if (point) el.setAttribute('transform', `translate(${point[0]},${point[1]})`)
    })

    pinsGroupRef.current.querySelectorAll<SVGGElement>('g.route-stop-root').forEach(el => {
      const lng = parseFloat(el.dataset.lng ?? '0')
      const lat = parseFloat(el.dataset.lat ?? '0')
      if (!isFinite(lng) || !isFinite(lat)) return
      const point = projectVisible(map, lng, lat)
      el.style.visibility = point ? '' : 'hidden'
      if (point) el.setAttribute('transform', `translate(${point[0]},${point[1]})`)
    })

    pinsGroupRef.current.querySelectorAll<SVGGElement>('g.trip-pin-root').forEach(el => {
      const lng = parseFloat(el.dataset.lng ?? '0')
      const lat = parseFloat(el.dataset.lat ?? '0')
      if (!isFinite(lng) || !isFinite(lat)) return
      const point = projectVisible(map, lng, lat)
      el.style.visibility = point ? '' : 'hidden'
      if (point) el.setAttribute('transform', `translate(${point[0]},${point[1]})`)
    })

    // Re-build route paths every map move — geodesic samples + fresh projection.
    const project: Proj = ([lng, lat]) => projectVisible(map, lng, lat)
    pinsGroupRef.current.querySelectorAll<SVGGElement>('g.route-path-root').forEach(group => {
      const raw = group.dataset.stops
      if (!raw) {
        group.querySelectorAll<SVGPathElement>('path').forEach(p => p.setAttribute('d', ''))
        return
      }
      const stops: { lng: number; lat: number }[] = []
      for (const pair of raw.split(';')) {
        const [lngStr, latStr] = pair.split(',')
        const lng = parseFloat(lngStr)
        const lat = parseFloat(latStr)
        if (isFinite(lng) && isFinite(lat)) stops.push({ lng, lat })
      }
      const d = stops.length >= 2 ? buildRoutePath(stops, project) : ''
      group.querySelectorAll<SVGPathElement>('path').forEach(p => p.setAttribute('d', d))
    })
  }

  // ── Fly to destination ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!flyTarget || !mapRef.current || !mapReady) return
    if (globeVisible) {
      // La carte se place tout de suite à l'arrivée du relais, cachée sous le
      // globe : ses tuiles chargent pendant l'approche.
      mapRef.current.jumpTo({ center: [flyTarget.lng, flyTarget.lat], zoom: HANDOFF_ZOOM })
      setGlobeFly({ lat: flyTarget.lat, lng: flyTarget.lng, token: Date.now(), distance: globeDistanceForZoom(mapRef.current, HANDOFF_ZOOM, flyTarget.lat) })
      onFlyTargetConsumed()
      return
    }
    const zoneTargetMine = destinations.find(d => d.name === flyTarget.name && d.kind === 'zone')
    const zoneTargetFriend = !zoneTargetMine
      ? (friendDestinations ?? []).find(d => d.name === flyTarget.name && d.kind === 'zone')
      : null
    const zoneTarget = zoneTargetMine ?? zoneTargetFriend
    if (zoneTarget) {
      setExpandedRouteKey(`${zoneTargetMine ? 'me' : 'friend'}:${zoneTarget.name}`)
      zoomToZone(zoneTarget)
      onFlyTargetConsumed()
      return
    }
    // Vol de caméra : on prend de la hauteur, puis on plonge vite sur la
    // destination (accélération franche, freinage net) en redressant la caméra.
    // Les nuages de zoom défilent pendant la descente.
    mapRef.current.flyTo({
      center: [flyTarget.lng, flyTarget.lat] as maplibregl.LngLatLike,
      zoom: Math.max(mapRef.current.getZoom(), 7.6),
      ...FLAT_CAMERA,
      padding: cameraPaddingFor(mapRef.current),
      duration: 2100,
      curve: 1.9,
      easing: t => (t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2),
      essential: true,
    })
    onFlyTargetConsumed()
  }, [flyTarget, mapReady, onFlyTargetConsumed, destinations, friendDestinations, globeVisible])

  const zoomBy = (factor: number) => {
    const map = mapRef.current
    if (!map) return
    map.zoomTo(map.getZoom() + Math.log2(factor), { duration: 260 })
  }

  const resetZoom = () => {
    const map = mapRef.current
    if (!map) return
    fitMapToDestinations(map, destinations, friendDestinations, { duration: 520, fallbackToWorld: true })
  }

  const zoomToZone = (d: Destination) => {
    const map = mapRef.current
    if (!map) return
    let bounds: [[number, number], [number, number]] | null = null
    if (d.extent) {
      const [w, s, e, n] = d.extent
      bounds = [[w, s], [e, n]]
    } else if (isRoadTripTagged(d) && d.stops?.length) {
      const valid = d.stops.filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng))
      if (valid.length) {
        const lngs = valid.map(s => s.lng), lats = valid.map(s => s.lat)
        bounds = [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]]
      }
    }
    if (!bounds) return
    map.fitBounds(bounds, { padding: 80, maxZoom: 7, duration: 800 })
  }

  const expandTripRoute = (d: Destination, owner: 'me' | 'friend') => {
    setExpandedRouteKey(`${owner}:${d.name}`)
    onSelect(d.name)
    zoomToZone(d)
  }

  const shared = sharedNames ?? new Set<string>()
  const friendOnly = friendDestinations
    ? friendDestinations.filter(d => !shared.has(destinationNameKey(d)))
    : []
  const isTripZone = (destination: Destination) => destination.kind === 'zone' && isRoadTripTagged(destination) && getValidStops(destination).length > 0

  const placeDests = destinations.filter(d => d.kind !== 'zone' && d.kind !== 'stop')
  const overlapsByDest: Record<string, PinTripBadge[]> = {}
  const skipStops = new Set<string>() // `${tripName}|${stopIndex}`

  for (const trip of destinations) {
    const validStops = getValidStops(trip)
    if (trip.kind !== 'zone' || !isRoadTripTagged(trip) || !validStops.length) continue
    const tripColor = getDestinationColor(trip) ?? '#1B5FE8'
    let stageCounter = 0
    trip.stops?.forEach((stop, index) => {
      const stageNumber = ++stageCounter
      if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lng)) return
      const match = placeDests.find(p => haversineMeters(p, stop) <= 50)
      if (match) {
        ;(overlapsByDest[match.name] ||= []).push({
          tripName: trip.name,
          color: tripColor,
          stageNumber,
        })
        skipStops.add(`${trip.name}|${index}`)
      }
    })
  }

  const renderRouteGroup = (d: Destination, owner: 'me' | 'friend') => {
    const color = getDestinationColor(d)
    const validStops = getValidStops(d)
    if (!validStops.length || !color) return [] as JSX.Element[]
    if (!isRoadTripTagged(d)) return [] as JSX.Element[]
    if (expandedRouteKey !== `${owner}:${d.name}` && selectedName !== d.name) return [] as JSX.Element[]
    const stopEls = d.stops?.map((stop, index) => {
      if (owner === 'me' && skipStops.has(`${d.name}|${index}`)) return null
      return (
        <RouteStop
          key={`${owner}-stop:${d.name}:${stop.name}:${index}`}
          stop={stop}
          parentName={d.name}
          projection={projFnRef.current}
          color={color}
          owner={owner}
          onSelect={onSelect}
        />
      )
    })
    return [
      <RoutePath
        key={`${owner}-path:${d.name}`}
        stops={validStops}
        projection={projFnRef.current}
        color={color}
        owner={owner}
      />,
      ...(stopEls ?? []).filter((el): el is JSX.Element => el !== null),
    ]
  }


  useEffect(() => {
    if (!mapReady || !mapRef.current) {
      clearHtmlMarkers()
      return
    }

    const map = mapRef.current
    clearHtmlMarkers()

    const markerPins: MapMarkerPin[] = [
      ...friendOnly
        .filter(d => d.kind !== 'stop' && !isTripZone(d))
        .map(destination => ({
          key: `friend:${destination.name}`,
          destination,
          owner: 'friend' as const,
          selected: destination.name === selectedName || destination.name === flyTarget?.name || expandedRouteKey === `friend:${destination.name}`,
          badge: friendInitials,
          badgeAvatarUrl: friendAvatarUrl,
          badgeBg: friendAvatarBg,
          badgeFg: friendAvatarFg,
          shared: false,
          tripBadges: undefined as PinTripBadge[] | undefined,
        })),
      ...destinations
        .filter(d => d.kind !== 'stop' && !isTripZone(d))
        .map(destination => ({
          key: `me:${destination.name}`,
          destination,
          owner: 'me' as const,
          selected: destination.name === selectedName || destination.name === flyTarget?.name || expandedRouteKey === `me:${destination.name}`,
          badge: undefined,
          badgeAvatarUrl: undefined as string | null | undefined,
          shared: shared.has(destinationNameKey(destination)),
          tripBadges: overlapsByDest[destination.name],
        })),
    ]

    // Pastille de groupe : jusqu'à trois photos empilées et le nombre de
    // destinations ; au clic, la caméra cadre le groupe pour le déplier.
    const addClusterMarker = (pins: MapMarkerPin[]) => {
      const lng = pins.reduce((sum, pin) => sum + pin.destination.lng, 0) / pins.length
      const lat = pins.reduce((sum, pin) => sum + pin.destination.lat, 0) / pins.length
      const element = document.createElement('div')
      element.className = 'map-pin-marker-host'
      element.style.width = '0'
      element.style.height = '0'
      element.style.overflow = 'visible'
      element.style.pointerEvents = 'auto'
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'map-pin-cluster'
      button.setAttribute('aria-label', t(`${pins.length} destinations, zoom in`, `${pins.length} destinations, zoomer`))
      pins.slice(0, 3).forEach((pin, index) => {
        const photo = document.createElement('span')
        photo.className = 'map-pin-cluster-photo'
        photo.style.setProperty('--stack-index', String(index))
        const url = pin.destination.image
        photo.style.setProperty('--pin-photo', url && !failedPhotos.has(url) ? `url("${url}")` : 'none')
        button.appendChild(photo)
      })
      const count = document.createElement('span')
      count.className = 'map-pin-cluster-count'
      count.textContent = String(pins.length)
      button.appendChild(count)
      element.appendChild(button)
      element.addEventListener('pointerdown', stopMarkerEvent)
      element.addEventListener('click', (event) => {
        stopMarkerEvent(event)
        const bounds = new maplibregl.LngLatBounds()
        for (const pin of pins) bounds.extend([pin.destination.lng, pin.destination.lat])
        map.fitBounds(bounds, { padding: 160, maxZoom: 7.6, ...FLAT_CAMERA, duration: 1500, essential: true })
      })
      const marker = new maplibregl.Marker({ element, anchor: 'top-left', opacityWhenCovered: '0' })
        .setLngLat([lng, lat])
        .addTo(map)
      element.style.zIndex = String(Math.round((90 - lat) * 10) + 5000)
      htmlMarkersRef.current.push({ marker, element })
    }

    // Pins à moins de 46 px les uns des autres à l'écran : regroupés en une
    // pastille. Le pin sélectionné reste toujours seul, et on ne regroupe plus en
    // vue rapprochée.
    const clustered = new Set<MapMarkerPin>()
    if (map.getZoom() < 7.5) {
      const placed = markerPins.map(pin => ({ pin, point: projectVisible(map, pin.destination.lng, pin.destination.lat) }))
      const grouped = new Set<number>()
      placed.forEach((entry, i) => {
        const origin = entry.point
        if (grouped.has(i) || !origin || entry.pin.selected) return
        const group = [entry.pin]
        placed.forEach((other, j) => {
          if (j <= i || grouped.has(j) || !other.point || other.pin.selected) return
          if (Math.hypot(other.point[0] - origin[0], other.point[1] - origin[1]) >= 46) return
          group.push(other.pin)
          grouped.add(j)
        })
        if (group.length < 2) return
        grouped.add(i)
        group.forEach(pin => clustered.add(pin))
        addClusterMarker(group)
      })
    }

    for (const pin of markerPins) {
      if (clustered.has(pin)) continue
      const element = document.createElement('div')
      element.className = 'map-pin-marker-host'
      element.style.width = '0'
      element.style.height = '0'
      element.style.overflow = 'visible'
      element.style.pointerEvents = 'auto'
      const activateMarker = () => {
        if (pin.destination.kind === 'zone' && isRoadTripTagged(pin.destination) && pin.destination.stops?.length) {
          expandTripRoute(pin.destination, pin.owner)
          return
        }
        onSelect(pin.destination.name)
      }
      element.addEventListener('pointerdown', stopMarkerEvent)
      element.addEventListener('click', (event) => {
        stopMarkerEvent(event)
        activateMarker()
      })

      const root = createRoot(element)
      root.render(
        <Pin
          destination={pin.destination}
          projection={MARKER_PROJ}
          compactMode={compactPins}
          selected={pin.selected}
          onSelect={onSelect}
          onZoomToZone={zoomToZone}
          onExpandTrip={expandTripRoute}
          owner={pin.owner}
          badge={pin.badge}
          badgeAvatarUrl={pin.badgeAvatarUrl}
          badgeBg={pin.badgeBg}
          badgeFg={pin.badgeFg}
          shared={pin.shared}
          tripBadges={pin.tripBadges}
        />,
      )

      const marker = new maplibregl.Marker({
        element,
        anchor: 'top-left',
        opacityWhenCovered: '0',
      })
        .setLngLat([pin.destination.lng, pin.destination.lat] as maplibregl.LngLatLike)
        .addTo(map)

      // Superposition propre : les pins plus au sud (plus proches avec la caméra
      // inclinée) passent devant ; le pin sélectionné passe devant tout.
      element.style.zIndex = String(Math.round((90 - pin.destination.lat) * 10) + (pin.selected ? 10000 : 0))

      htmlMarkersRef.current.push({ marker, root, element })
    }

    return () => clearHtmlMarkers()
  }, [
    mapReady,
    destinations,
    friendDestinations,
    friendInitials,
    shared,
    overlapsByDest,
    expandedRouteKey,
    selectedName,
    flyTarget,
    compactPins,
    mapZoom,
    mapSize.width,
    onSelect,
  ])

  const earthFocus = getBestGlobeCenter(getMapFocusPoints(destinations, friendDestinations))
  const earthPinDestinations = destinations.filter(d => d.kind !== 'stop' && d.kind !== 'zone' && Number.isFinite(d.lat) && Number.isFinite(d.lng))

  // Le globe s'efface sur la carte en fondu, pendant que sa caméra continue de
  // plonger à travers les nuages (voir EarthGlobe, CameraRig).
  const fadeOutGlobe = () => {
    setGlobeVisible(false)
    setGlobeFading(true)
  }
  useEffect(() => {
    if (!globeFading) return
    const timeout = window.setTimeout(() => setGlobeFading(false), GLOBE_FADE_MS)
    return () => window.clearTimeout(timeout)
  }, [globeFading])

  // Le globe 3D arrive lancé sur la destination, au cœur des nuages : la carte
  // (déjà en place, voir l'effet de vol) prend le relais sans pause et freine
  // jusqu'à l'arrivée.
  const handleGlobeDiveComplete = (lat: number, lng: number) => {
    const map = mapRef.current
    if (!map) return
    fadeOutGlobe()
    map.easeTo({
      center: [lng, lat],
      zoom: 9,
      ...FLAT_CAMERA,
      padding: destinationPaddingFor(map),
      duration: 1500,
      easing: t => 1 - Math.pow(1 - t, 3),
      essential: true,
    })
  }

  // Molette : le seuil est franchi et le globe plonge seul à travers les nuages
  // jusqu'à `distance`. La carte se place déjà à l'échelle de l'arrivée, cachée
  // sous le globe, pour charger ses tuiles pendant la plongée.
  const handleGlobeZoomThrough = (lat: number, lng: number, distance: number) => {
    const map = mapRef.current
    if (!map) return
    map.jumpTo({ center: [lng, lat], zoom: zoomForGlobeDistance(map, distance, lat) })
  }

  // Fin de cette plongée, dans la couche de nuages : la carte prend le relais et
  // poursuit la chute en freinant (+1 zoom), pendant que le globe s'efface.
  const handleGlobeZoomThroughComplete = (lat: number, lng: number, distance: number) => {
    const map = mapRef.current
    if (!map) return
    const zoom = zoomForGlobeDistance(map, distance, lat)
    map.jumpTo({ center: [lng, lat], zoom })
    fadeOutGlobe()
    map.easeTo({ zoom: zoom + 1, duration: 1100, easing: t => 1 - Math.pow(1 - t, 3), essential: true })
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <section
      className="map-area"
      aria-label={t('Destination map', 'Carte des destinations')}
      draggable={false}
      onDragStartCapture={(event) => event.preventDefault()}
    >
      <div className="map-aurora" aria-hidden="true" />
      <div ref={globeGlowRef} className="map-globe-glow" aria-hidden="true" />
      <div className={`earth-globe-layer${globeVisible ? '' : ' is-hidden'}`}>
        <SpaceBackdrop />
        <Suspense fallback={null}>
          <EarthGlobe
            focusLng={earthFocus?.[0] ?? null}
            focusLat={earthFocus?.[1] ?? null}
            offsetLeft={mapRef.current ? getSidebarInset(mapRef.current) : 0}
            active={globeVisible || globeFading}
            pins={earthPinDestinations.map(d => ({ key: d.name, lat: d.lat, lng: d.lng }))}
            pinElements={earthPinElements}
            flyTo={globeFly}
            returnTo={globeReturn}
            onDiveComplete={handleGlobeDiveComplete}
            onZoomThrough={handleGlobeZoomThrough}
            onZoomThroughComplete={handleGlobeZoomThroughComplete}
            zoomThroughDistance={ZOOM_THROUGH_DISTANCE}
          />
        </Suspense>
        <div className="earth-globe-pins">
          {earthPinDestinations.map(d => (
            <div
              key={d.name}
              className="earth-globe-pin"
              style={{ visibility: 'hidden' }}
              ref={element => {
                if (element) earthPinElements.current.set(d.name, element)
                else earthPinElements.current.delete(d.name)
              }}
            >
              <Pin
                destination={d}
                projection={MARKER_PROJ}
                compactMode
                selected={d.name === selectedName}
                onSelect={onSelect}
                onZoomToZone={zoomToZone}
                onExpandTrip={expandTripRoute}
                owner="me"
                shared={shared.has(destinationNameKey(d))}
              />
            </div>
          ))}
        </div>
      </div>
      <div ref={mapContainerRef} className="map-gl-container" draggable={false} />
      {!mapReady && !mapError && (
        <div
          className="map-loading-shimmer"
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(110deg, #f2eee4 30%, #f7f3ea 50%, #f2eee4 70%)',
            backgroundSize: '200% 100%',
            animation: 'mapShimmer 1.4s ease-in-out infinite',
            pointerEvents: 'none',
            zIndex: 1,
          }}
        />
      )}
      {mapError && (
        <div className="map-fallback" role="status" aria-live="polite">
          <div className="map-fallback-card">
            <h3>{t('Interactive map unavailable', 'Carte interactive indisponible')}</h3>
            <p>{t('WebGL could not start on this device or browser configuration.', 'WebGL n\'a pas pu démarrer sur cet appareil ou cette configuration de navigateur.')}</p>
            <p className="map-fallback-detail">{mapError}</p>
          </div>
        </div>
      )}

      {/* width/height attrs requis par Safari WebKit pour établir le viewport SVG
          et permettre le rendu des éléments <foreignObject> enfants. */}
      <svg ref={svgRef} className="map-pins-overlay" width="100%" height="100%" aria-label={t('Destination pins', 'Épingles des destinations')}>
        <g ref={pinsGroupRef}>
          {mapReady && !mapError && (
            <>
              {/*
            // Index of standalone destinations (place/stage) — used to detect
            // when a roadtrip stop sits at the same location as one of them.
                // Stop fusionné avec une destination solo → masqué au profit du pin photo
              */}
                {friendOnly.flatMap(d => d.kind === 'zone' ? renderRouteGroup(d, 'friend') : [])}
                {destinations.flatMap(d => d.kind === 'zone' ? renderRouteGroup(d, 'me') : [])}
                {friendOnly.filter(isTripZone).map(d => (
                  <TripPinOverlay
                    key={`friend:trip:${d.name}`}
                    destination={d}
                    projection={projFnRef.current}
                    selected={expandedRouteKey === `friend:${d.name}`}
                    owner="friend"
                    onExpandTrip={expandTripRoute}
                  />
                ))}
                {destinations.filter(isTripZone).map(d => (
                  <TripPinOverlay
                    key={`me:trip:${d.name}`}
                    destination={d}
                    projection={projFnRef.current}
                    selected={d.name === selectedName || expandedRouteKey === `me:${d.name}`}
                    owner="me"
                    onExpandTrip={expandTripRoute}
                  />
                ))}
                {friendOnly.filter(d => d.kind === 'stop').map(d => (
                  <Pin key={`friend:${d.name}`} destination={d} projection={projFnRef.current}
                    compactMode={compactPins} selected={d.name === selectedName || expandedRouteKey === `friend:${d.name}`} onSelect={onSelect} onZoomToZone={zoomToZone} onExpandTrip={expandTripRoute}
                    owner="friend" badge={friendInitials} badgeAvatarUrl={friendAvatarUrl} badgeBg={friendAvatarBg} badgeFg={friendAvatarFg} />
                ))}
                {destinations.filter(d => d.kind === 'stop').map(d => (
                  <Pin key={d.name} destination={d} projection={projFnRef.current}
                    compactMode={compactPins} selected={d.name === selectedName || expandedRouteKey === `me:${d.name}`} onSelect={onSelect} onZoomToZone={zoomToZone} onExpandTrip={expandTripRoute}
                    owner="me" shared={shared.has(destinationNameKey(d))}
                    tripBadges={overlapsByDest[d.name]} />
                ))}
              </>
          )}
        </g>
      </svg>

      {!mapError && <div className={`map-controls${controlsClass}`} aria-label={t('Map controls', 'Contrôles de la carte')}>
        <button className="map-control-zoom-in" aria-label={t('Zoom in', 'Zoomer')} onClick={() => zoomBy(1.35)}>+</button>
        <button className="map-control-zoom-out" aria-label={t('Zoom out', 'Dézoomer')} onClick={() => zoomBy(0.75)}>−</button>
        <span className="map-controls-divider" aria-hidden="true" />
        <button aria-label={t('Reset map view', 'Réinitialiser la vue')} onClick={resetZoom}>
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9V4h5" /><path d="M21 9V4h-5" />
            <path d="M3 15v5h5" /><path d="M21 15v5h-5" />
          </svg>
        </button>
      </div>}

      {!mapError && <div className={`legend${legendClass}${showLegendLabel && !notationOpen ? ' is-collapsed' : ''}`}>
        {showLegendLabel ? (
          <button
            type="button"
            className="legend-header"
            onClick={() => setNotationOpen(o => !o)}
            aria-expanded={notationOpen}
          >
            <strong className="legend-label">{t('Rating', 'Notation')}</strong>
            <svg
              className={`legend-chevron${notationOpen ? '' : ' is-closed'}`}
              width="14" height="14" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        ) : null}
        <div className="legend-items">
          {legendItems.map(({ tier, label }) => (
            <span key={tier} className="legend-item-help" aria-label={`${tier} · ${label}`}>
              <i className={`tier-dot tier-${tier.toLowerCase()}`}>{tier}</i>
              {label}
            </span>
          ))}
        </div>
      </div>}

      {!mapError && <p className="map-attribution">
        <a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener noreferrer">© MapTiler</a>
        {' · '}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap</a>
        {' · '}
        <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener noreferrer">Terrain Tiles</a>
        {' · '}
        <a href="https://earthobservatory.nasa.gov/features/BlueMarble" target="_blank" rel="noopener noreferrer">NASA Blue Marble</a>
        {' · '}
        <a href="https://www.solarsystemscope.com/textures/" target="_blank" rel="noopener noreferrer">Solar System Scope</a>
      </p>}
    </section>
  )
}

// ─── Pin component ────────────────────────────────────────────────────────────
export interface PinTripBadge {
  tripName: string
  color: string
  stageNumber?: number
}

interface PinProps {
  destination: Destination
  projection: Proj
  compactMode: boolean
  selected: boolean
  onSelect: (name: string) => void
  onZoomToZone?: (d: Destination) => void
  onExpandTrip?: (d: Destination, owner: 'me' | 'friend') => void
  owner?: 'me' | 'friend'
  badge?: string
  badgeAvatarUrl?: string | null
  badgeBg?: string
  badgeFg?: string
  shared?: boolean
  tripBadges?: PinTripBadge[]
}

interface RouteStopProps {
  stop: RoadTripStop
  parentName: string
  projection: Proj
  color: string
  owner: 'me' | 'friend'
  onSelect: (name: string) => void
}

interface TripPinOverlayProps {
  destination: Destination
  projection: Proj
  selected: boolean
  owner: 'me' | 'friend'
  onExpandTrip: (d: Destination, owner: 'me' | 'friend') => void
}

function stopMarkerEvent(event: { stopPropagation: () => void }) {
  event.stopPropagation()
}

function getValidStops(destination: Destination) {
  return destination.stops?.filter(stop => stop.name.trim() && Number.isFinite(stop.lat) && Number.isFinite(stop.lng)) ?? []
}

function isRoadTripTagged(destination: Destination) {
  return Boolean(destination.tripTypes?.includes(ROAD_TRIP_TAG_ID))
}

const RouteStop = memo(function RouteStop({
  stop, parentName, projection, color, owner, onSelect,
}: RouteStopProps) {
  if (!stop.name.trim() || !Number.isFinite(stop.lat) || !Number.isFinite(stop.lng)) return null
  const projected = projection([stop.lng, stop.lat])
  if (!projected) return null
  const [cx, cy] = projected

  return (
    <g
      className={`route-stop-root route-stop-root--${owner}`}
      data-lng={stop.lng}
      data-lat={stop.lat}
      transform={`translate(${cx},${cy})`}
      style={{ '--pin-color': color } as CSSProperties}
      onClick={() => onSelect(parentName)}
    >
      <title>{stop.name}</title>
      <circle className="route-stop-hit" r={16} />
      <circle className="route-stop-dot" r={4} />
      <foreignObject className="route-stop-label-object" x="-64" y="-34" width="128" height="28" overflow="visible">
        <div className="route-stop-label-pill">{stop.name}</div>
      </foreignObject>
    </g>
  )
})

const TripPinOverlay = memo(function TripPinOverlay({
  destination, projection, selected, owner, onExpandTrip,
}: TripPinOverlayProps) {
  const [tripHovered, setTripHovered] = useState(false)
  const projected = projection([destination.lng, destination.lat])
  if (!projected) return null
  const [cx, cy] = projected
  const destinationTier = getDestinationTier(destination)
  const color = getTierColor(destinationTier)
  const stageCount = getValidStops(destination).length
  const taggedRoadTrip = isRoadTripTagged(destination)
  if (!color || (stageCount === 0 && !taggedRoadTrip)) return null

  // Flip card to expand left when near right edge (prevents off-screen overflow)
  // Normal:  fo x=-36,  circle at fo[0..60],   circle center = cx-6
  // Flipped: fo x=-166, circle at fo[130..190], circle center = cx-6 (same)
  const flipLeft = cx > window.innerWidth - 220
  const foX = flipLeft ? -166 : -36

  return (
    <g
      className={`trip-pin-root trip-pin-root--${owner}`}
      data-lng={destination.lng}
      data-lat={destination.lat}
      transform={`translate(${cx},${cy})`}
      style={{ '--pin-color': color } as CSSProperties}
    >
      <rect
        className="trip-pin-hit"
        x={foX}
        y={-42}
        width={190}
        height={102}
        rx={32}
        ry={32}
        onClick={(event) => {
          stopMarkerEvent(event)
          onExpandTrip(destination, owner)
        }}
      />
      <foreignObject
        className="trip-pin-foreign-object"
        x={foX}
        y={-42}
        width={190}
        height={102}
        overflow="visible"
      >
        <div className="trip-pin-html-shell">
          <div className={`pin-stage trip-pin-stage${flipLeft ? ' trip-pin-stage--flip-left' : ''}`}>
            <div
              className={`map-pin-trip-card${owner === 'friend' ? ' map-pin-trip-card--friend' : ''}${(tripHovered || selected) ? ' map-pin-trip-card--revealed' : ''}${flipLeft ? ' map-pin-trip-card--flip-left' : ''}`}
              style={{ '--pin-color': color, '--pin-photo': destination.image ? `url("${destination.image}")` : 'none' } as CSSProperties}
              onPointerEnter={() => setTripHovered(true)}
              onPointerLeave={() => setTripHovered(false)}
              onPointerDown={stopMarkerEvent}
              onClick={(event) => {
                stopMarkerEvent(event)
                onExpandTrip(destination, owner)
              }}
            >
              <span className="map-pin-trip-thumb">
                <span className="map-pin-trip-badge">{destinationTier ?? '?'}</span>
                <span className="map-pin-trip-icon" aria-hidden="true">🚗</span>
              </span>
              <span className="map-pin-pill-name">{destination.name}</span>
              <span className="map-pin-pill-sub">· {stageCount} arrêt{stageCount > 1 ? 's' : ''}</span>
            </div>
          </div>
        </div>
      </foreignObject>
    </g>
  )
})

// ── Route polyline ───────────────────────────────────────────────────────────
interface RoutePathProps {
  stops: RoadTripStop[]
  projection: Proj
  color: string
  owner: 'me' | 'friend'
}

/**
 * Sample N intermediate points along the great circle between two lng/lat coords.
 * Returns [a, ..., b] (inclusive). Used so long segments curve along Earth's surface
 * instead of cutting straight through unrelated geography on a Mercator map.
 */
function greatCircleSamples(a: [number, number], b: [number, number], segments = 24): [number, number][] {
  const toRad = (d: number) => d * Math.PI / 180
  const toDeg = (r: number) => r * 180 / Math.PI
  const lon1 = toRad(a[0]), lat1 = toRad(a[1])
  const lon2 = toRad(b[0]), lat2 = toRad(b[1])
  const haver = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2
  const d = 2 * Math.atan2(Math.sqrt(haver), Math.sqrt(1 - haver))
  if (d < 1e-9) return [a, b]
  const out: [number, number][] = []
  for (let i = 0; i <= segments; i++) {
    const f = i / segments
    const A = Math.sin((1 - f) * d) / Math.sin(d)
    const B = Math.sin(f * d) / Math.sin(d)
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2)
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2)
    const z = A * Math.sin(lat1) + B * Math.sin(lat2)
    const latI = Math.atan2(z, Math.sqrt(x * x + y * y))
    const lonI = Math.atan2(y, x)
    out.push([toDeg(lonI), toDeg(latI)])
  }
  return out
}

/**
 * Build the screen-space path for a sequence of geographic stops.
 * Each consecutive pair is interpolated along the great circle (so the rendered
 * curve follows Earth, not a Mercator straight line) and the resulting screen
 * points are connected with a cubic-smooth polyline.
 */
function buildRoutePath(stops: { lng: number; lat: number }[], project: (ll: [number, number]) => [number, number] | null): string {
  if (stops.length < 2) return ''
  const allScreen: [number, number][] = []
  for (let i = 0; i < stops.length - 1; i++) {
    const a: [number, number] = [stops[i].lng, stops[i].lat]
    const b: [number, number] = [stops[i + 1].lng, stops[i + 1].lat]
    const dLng = Math.abs(b[0] - a[0]); const dLat = Math.abs(b[1] - a[1])
    const rough = Math.hypot(dLng, dLat)
    const segs = Math.max(8, Math.min(64, Math.round(rough * 1.5)))
    const samples = greatCircleSamples(a, b, segs)

    // Project this segment's samples
    const projected: [number, number][] = []
    for (const s of samples) {
      const p = project(s)
      if (p) projected.push(p)
    }
    if (projected.length < 2) continue

    // Gentle perpendicular arc that bows northward (negative SVG-y) for organic feel
    const pA = projected[0], pB = projected[projected.length - 1]
    const cdx = pB[0] - pA[0], cdy = pB[1] - pA[1]
    const clen = Math.hypot(cdx, cdy) || 1
    let nx = -cdy / clen, ny = cdx / clen
    if (ny > 0) { nx = -nx; ny = -ny } // ensure bow goes up (north)
    const arcH = Math.min(clen * 0.1, 55)

    for (let k = (i === 0 ? 0 : 1); k < projected.length; k++) {
      const t = k / (projected.length - 1)
      const bow = Math.sin(t * Math.PI) * arcH
      allScreen.push([projected[k][0] + nx * bow, projected[k][1] + ny * bow])
    }
  }
  if (allScreen.length < 2) return ''
  // Catmull-Rom → cubic bezier
  const parts: string[] = [`M ${allScreen[0][0].toFixed(1)} ${allScreen[0][1].toFixed(1)}`]
  for (let i = 1; i < allScreen.length; i++) {
    const p0 = allScreen[Math.max(0, i - 2)]
    const p1 = allScreen[i - 1]
    const p2 = allScreen[i]
    const p3 = allScreen[Math.min(allScreen.length - 1, i + 1)]
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6
    parts.push(`C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)} ${cp2x.toFixed(1)} ${cp2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`)
  }
  return parts.join(' ')
}

const RoutePath = memo(function RoutePath({ stops, projection, color, owner }: RoutePathProps) {
  const validStops = stops.filter(s => s.name.trim() && Number.isFinite(s.lat) && Number.isFinite(s.lng))
  if (validStops.length < 2) return null
  const d = buildRoutePath(validStops, projection)
  // Serialize stops as `lng,lat;lng,lat;...` for imperative re-projection on map move.
  const stopsAttr = validStops.map(s => `${s.lng},${s.lat}`).join(';')
  return (
    <g
      className={`route-path-root route-path-root--${owner}`}
      data-stops={stopsAttr}
      style={{ '--pin-color': color } as CSSProperties}
    >
      <path className="route-path-glow" d={d} />
      <path className="route-path-halo" d={d} />
      <path className="route-path" d={d} />
    </g>
  )
})


// Photos dont l'adresse ne se charge pas : le pin montre alors l'initiale au lieu
// d'un rond vide. Mémorisé pour ne pas retenter à chaque reconstruction des pins.
const failedPhotos = new Set<string>()

function useLoadablePhoto(url?: string | null) {
  const [failed, setFailed] = useState(() => !!url && failedPhotos.has(url))
  useEffect(() => {
    if (!url) return
    if (failedPhotos.has(url)) {
      setFailed(true)
      return
    }
    setFailed(false)
    const image = new Image()
    image.onerror = () => {
      failedPhotos.add(url)
      setFailed(true)
    }
    image.src = url
    return () => { image.onerror = null }
  }, [url])
  return url && !failed ? url : null
}

const Pin = memo(function Pin({
  destination, projection, compactMode, selected, onSelect, onZoomToZone, onExpandTrip, owner = 'me', badge, badgeAvatarUrl, badgeBg, badgeFg, shared, tripBadges,
}: PinProps) {
  const photoUrl = useLoadablePhoto(destination.image)
  const projected = projection([destination.lng, destination.lat])
  if (!projected) return null
  const [cx, cy] = projected
  const pinScale = 1
  const isCompact = compactMode
  const usesMapLibreMarker = projection === MARKER_PROJ
  const rootStyle: CSSProperties = usesMapLibreMarker
    ? {
        position: 'relative',
        overflow: 'visible',
      }
    : {
        position: 'absolute',
        top: 0,
        left: 0,
        transformOrigin: 'center bottom',
        pointerEvents: 'none',
        transform: `translate(${cx}px, ${cy}px) scale(${pinScale})`,
      }

  // ── Stop (road trip waypoint) ──────────────────────────────────────────────
  if (destination.kind === 'stop') {
    return (
      <g className="stop-root" data-lng={destination.lng} data-lat={destination.lat}
         transform={`translate(${cx},${cy})`}
         style={{ cursor: 'pointer' }}
         onClick={() => onSelect(destination.name)}>
        <circle r={16} fill="transparent" />
        <circle r={6.5}
          fill={owner === 'friend' ? '#fff' : '#8b9db5'}
          stroke={owner === 'friend' ? '#7C8DB5' : 'white'}
          strokeWidth={owner === 'friend' ? 1.8 : 1.4}
          opacity={0.85}
          pointerEvents="none" />
      </g>
    )
  }

  const destinationTier = getDestinationTier(destination)
  const color = getTierColor(destinationTier)
  if (!color) return null
  const score = destinationTier
    ? getDestinationScore(destination).toFixed(1).replace('.', ',')
    : '?'

  // ── Zone (road trip / région)
  // Note: si zone sans étape → fall-through vers le pin standard (rendu identique
  // à une destination 'place'), pour éviter la petite pill discrète sans photo.
  if (destination.kind === 'zone') {
    if (isRoadTripTagged(destination) && getValidStops(destination).length > 0) return null

    // Zone sans étape → rendu identique au pin standard (fall-through)
  }

  // ── Full destination pin ───────────────────────────────────────────────────
  const isCoupDeCoeur = Boolean(destination.coupDeCoeur)
  const isLivedThere = Boolean(destination.livedThere)
  const isRoadTrip = isRoadTripTagged(destination)
  const visitCount = getVisitCount(destination)
  const isRevisited = visitCount > 1
  const basePinLabel = destination.kind === 'stage' && destination.tripName
    ? `${destination.name} · ${destination.tripName}`
    : destination.name
  const pinLabel = isRevisited
    ? `🔥 ${basePinLabel} · ${formatVisitCountLabel(visitCount)}`
    : basePinLabel
  return (
    <div className={`map-pin-html-root pin-root pin-owner-${owner}${selected ? ' pin-selected' : ''}${isCoupDeCoeur ? ' pin-coup-de-coeur' : ''}`}
       data-lng={destination.lng} data-lat={destination.lat}
       style={rootStyle}>
      <div className="pin-stage" style={{ marginLeft: '-82px', marginTop: '-148px', pointerEvents: 'auto' }}>
          <div
            className={`map-pin${isCompact ? ' map-pin--compact' : ''}${destination.kind === 'stage' ? ' map-pin-stage' : ''}${owner === 'friend' ? ' map-pin--friend' : ''}${photoUrl ? ' map-pin--has-photo' : ''}${isCoupDeCoeur ? ' map-pin--coup-de-coeur' : ''}${isRevisited ? ' map-pin--revisited' : ''}`}
            draggable={false}
            onPointerDown={stopMarkerEvent}
            onClick={(event) => {
              stopMarkerEvent(event)
              onSelect(destination.name)
            }}
            style={{
              '--pin-color': color,
              '--pin-photo': photoUrl ? `url("${photoUrl}")` : 'none',
            } as CSSProperties}>
            {/* Sans photo : l'initiale de la ville plutôt qu'un rond vide. */}
            {!photoUrl && (
              <span className="map-pin-initial" aria-hidden="true">{destination.name.trim().charAt(0).toUpperCase()}</span>
            )}
            {/* Une seule capsule sous la photo : tier, puis les marqueurs éventuels. */}
            <span className="map-pin-capsule">
              <span className="map-pin-tier">{destinationTier ?? '?'}</span>
              {isCoupDeCoeur && (
                <span className="map-pin-capsule-icon map-pin-heart" aria-label={t('Favorite', 'Coup de coeur')}>
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M20.8 4.6a5.4 5.4 0 0 0-7.7 0L12 5.7l-1.1-1.1a5.4 5.4 0 0 0-7.7 7.7L12 21l8.8-8.7a5.4 5.4 0 0 0 0-7.7Z" />
                  </svg>
                </span>
              )}
              {isLivedThere && (
                <span className="map-pin-capsule-icon map-pin-home" aria-label={t('Lived there', 'A vécu là-bas')}>
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M12 3.2 2.6 11h2.6v8.6c0 .6.4 1 1 1H10v-6h4v6h3.8c.6 0 1-.4 1-1V11h2.6Z" />
                  </svg>
                </span>
              )}
              {isRoadTrip && (
                <span className="map-pin-capsule-icon map-pin-roadtrip" aria-label={t('Road trip', 'Road trip')}>
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M6.6 5.4A2 2 0 0 1 8.5 4h7a2 2 0 0 1 1.9 1.4L19 10h.5c.8 0 1.5.7 1.5 1.5V17h-2v2.2h-3V17H8v2.2H5V17H3v-5.5c0-.8.7-1.5 1.5-1.5H5Zm1.5 4.6h7.8l-1-3.2H9.1ZM6.5 15a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6Zm11 0a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6Z" />
                  </svg>
                </span>
              )}
              {shared && <span className="map-pin-capsule-shared" aria-label={t('Shared destination', 'Destination en commun')}>2x</span>}
            </span>
            <strong>{pinLabel}</strong>
            {owner === 'friend' && badge && (
              <em
                className="pin-friend-badge"
                style={{
                  '--pin-badge-bg': badgeBg ?? '#ffffff',
                  '--pin-badge-fg': badgeFg ?? '#1f2937',
                } as CSSProperties}
              >
                {badgeAvatarUrl
                  ? <img src={badgeAvatarUrl} alt="" aria-hidden="true" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; if (e.currentTarget.parentElement) e.currentTarget.parentElement.textContent = badge }} />
                  : badge}
              </em>
            )}
            {tripBadges && tripBadges.length > 0 && (
              <span className="pin-trip-badges" aria-hidden="true">
                {tripBadges.map((b, i) => (
                  <span
                    key={`${b.tripName}-${i}`}
                    className="pin-trip-badge"
                    title={`Étape de ${b.tripName}`}
                    style={{ '--trip-color': b.color } as CSSProperties}
                  >
                    {b.stageNumber !== undefined ? `#${b.stageNumber}` : '•'}
                  </span>
                ))}
              </span>
            )}
          </div>
      </div>
    </div>
  )
})
