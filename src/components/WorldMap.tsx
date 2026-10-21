import { memo, useEffect, useId, useRef, useState } from 'react'
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

const MAPTILER_KEY = 'aETkeQlWzYNolMJrUTIx'
const STYLE_URL = `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`
const INIT_CENTER: [number, number] = [10, 10]
const INIT_ZOOM = 1.5
const AUTO_FIT_MAX_ZOOM = 5.6
const PIN_FOCUS_INSET = 92
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

function visibleRect(element: Element | null) {
  if (!(element instanceof HTMLElement)) return null
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  return rect
}

function getMapFitPadding(map: maplibregl.Map) {
  const container = map.getContainer()
  const width = container.clientWidth
  const height = container.clientHeight
  const doc = container.ownerDocument
  const isCompact = width < 720
  const sidebar = visibleRect(doc.querySelector('.sidebar'))
  const topbar = visibleRect(doc.querySelector('.topbar'))
  const mobileHeader = visibleRect(doc.querySelector('.mobile-header'))
  const tierBoard = visibleRect(doc.querySelector('.tier-board'))
  const legend = visibleRect(doc.querySelector('.legend'))

  const overlayLeft = sidebar ? Math.min(sidebar.right, width * 0.42) : 0
  const overlayTop = Math.max(topbar?.bottom ?? 0, mobileHeader?.bottom ?? 0)
  const overlayBottom = Math.max(
    tierBoard && tierBoard.top < height ? height - tierBoard.top : 0,
    legend && legend.top < height ? height - legend.top : 0,
  )

  if (isCompact) {
    return {
      top: Math.min(170, Math.max(118, overlayTop + PIN_FOCUS_INSET * 0.7)),
      right: 64,
      bottom: Math.min(280, Math.max(170, overlayBottom + PIN_FOCUS_INSET)),
      left: 64,
    }
  }

  return {
    top: Math.min(190, Math.max(150, overlayTop + PIN_FOCUS_INSET)),
    right: Math.min(150, Math.max(112, width * 0.1)),
    bottom: Math.min(220, Math.max(132, overlayBottom + PIN_FOCUS_INSET * 0.75)),
    left: Math.min(width * 0.46, Math.max(overlayLeft + PIN_FOCUS_INSET, width * 0.28)),
  }
}

function fitMapToDestinations(
  map: maplibregl.Map,
  destinations: Destination[],
  friendDestinations: Destination[] | undefined,
  options?: { duration?: number; fallbackToWorld?: boolean },
) {
  const visiblePoints = getMapFocusPoints(destinations, friendDestinations)
  const duration = options?.duration ?? 650
  const padding = getMapFitPadding(map)

  if (visiblePoints.length > 1) {
    const bounds = new maplibregl.LngLatBounds()
    for (const point of visiblePoints) {
      bounds.extend([point.lng, point.lat])
    }
    map.fitBounds(bounds, {
      padding,
      maxZoom: AUTO_FIT_MAX_ZOOM,
      duration,
      easing: t => 1 - Math.pow(1 - t, 3),
    })
    return true
  }

  if (visiblePoints.length === 1) {
    map.flyTo({
      center: [visiblePoints[0].lng, visiblePoints[0].lat],
      zoom: Math.min(Math.max(map.getZoom(), 4.4), AUTO_FIT_MAX_ZOOM),
      duration,
      offset: [
        (padding.left - padding.right) / 2,
        (padding.top - padding.bottom) / 2,
      ],
      easing: t => 1 - Math.pow(1 - t, 3),
    })
    return true
  }

  if (options?.fallbackToWorld) {
    map.flyTo({ center: INIT_CENTER, zoom: INIT_ZOOM, duration: Math.min(duration, 400) })
  }

  return false
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
  land: '#f2eee4',
  sand: '#e8ddc8',
  sage: '#aebf9a',
  sageSoft: '#c2ceb2',
  ice: '#eef6f7',
  relief: '#d3c8b6',
  labelCountry: '#766f64',
  labelOcean: '#7fa6bf',
  labelHalo: 'rgba(246, 242, 232, 0.88)',
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
    minzoom: 0,
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
      'text-color': ATLAS_PREMIUM_PALETTE.labelCountry,
      'text-halo-blur': 0.35,
      'text-halo-color': ATLAS_PREMIUM_PALETTE.labelHalo,
      'text-halo-width': 1.5,
      'text-opacity': [
        'interpolate', ['linear'], ['zoom'],
        0, 0.62,
        2, 0.86,
        7, 0.78,
      ],
    },
  })
}

function customizeAtlasPremiumStyle(map: maplibregl.Map) {
  const palette = ATLAS_PREMIUM_PALETTE

  for (const layer of map.getStyle().layers) {
    const { id, type } = layer
    const lid = id.toLowerCase()

    if (type === 'hillshade') {
      safeSetPaint(map, id, 'hillshade-shadow-color', palette.relief)
      safeSetPaint(map, id, 'hillshade-highlight-color', '#fffaf0')
      safeSetPaint(map, id, 'hillshade-accent-color', '#c6bba8')
      safeSetPaint(map, id, 'hillshade-exaggeration', ['interpolate', ['linear'], ['zoom'], 0, 0.22, 4, 0.16, 8, 0.10])
      continue
    }

    if (type === 'background') {
      safeSetPaint(map, id, 'background-color', palette.land)
      continue
    }

    if (type === 'fill') {
      if (/water/.test(lid) && !/waterway|waterfall|land/.test(lid)) {
        safeSetPaint(map, id, 'fill-color', palette.sea)
        safeSetPaint(map, id, 'fill-opacity', 0.82)
        continue
      }

      if (/wood|forest|tree/.test(lid)) {
        safeSetPaint(map, id, 'fill-color', palette.sage)
        safeSetPaint(map, id, 'fill-opacity', 0.14)
        continue
      }

      if (/scrub|grass|meadow|park|green/.test(lid)) {
        safeSetPaint(map, id, 'fill-color', palette.sageSoft)
        safeSetPaint(map, id, 'fill-opacity', 0.1)
        continue
      }

      if (/glacier|ice|snow/.test(lid)) {
        safeSetPaint(map, id, 'fill-color', palette.ice)
        safeSetPaint(map, id, 'fill-opacity', 0.74)
        continue
      }

      if (/sand|beach|desert/.test(lid)) {
        safeSetPaint(map, id, 'fill-color', palette.sand)
        safeSetPaint(map, id, 'fill-opacity', 0.34)
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
        safeSetPaint(map, id, 'text-opacity', 0.72)
        safeSetPaint(map, id, 'text-halo-color', 'rgba(220, 239, 246, 0.42)')
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
        safeSetPaint(map, id, 'text-halo-color', 'rgba(220, 239, 246, 0.30)')
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

  addAtlasCountryLabels(map)
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
  const htmlMarkersRef  = useRef<Array<{ marker: maplibregl.Marker; root: Root; element: HTMLDivElement }>>([])
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
      window.setTimeout(() => entry.root.unmount(), 0)
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
        zoom: INIT_ZOOM,
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
          contextType: 'webgl',
        },
      })
      setMapError(null)
    } catch (error) {
      console.error('WorldMap failed to initialize MapLibre:', error)
      setMapError(describeMapInitError(error, 'Map unavailable.'))
      container.removeEventListener('webglcontextcreationerror', handleWebGlError as EventListener)
      return
    }

    map.on('load', () => {
      customizeAtlasPremiumStyle(map)
      projFnRef.current = ([lng, lat]) => {
        const { x, y } = map.project([lng, lat] as maplibregl.LngLatLike)
        return [x, y]
      }
      setCompactPins(Math.pow(2, map.getZoom() - INIT_ZOOM) < 2)
      setMapZoom(map.getZoom())
      setMapReady(true)
    })

    // Mise à jour directe du DOM des pins — zéro re-render React par frame
    map.on('move', () => updatePins(map))
    map.on('zoomend', () => {
      setCompactPins(Math.pow(2, map.getZoom() - INIT_ZOOM) < 2)
      setMapZoom(map.getZoom())
    })

    mapRef.current = map
    return () => {
      if (autoFitTimeoutRef.current !== null) window.clearTimeout(autoFitTimeoutRef.current)
      clearHtmlMarkers()
      container.removeEventListener('webglcontextcreationerror', handleWebGlError as EventListener)
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
      mapRef.current.resize()
      fitMapToDestinations(mapRef.current, destinations, friendDestinations, { duration: 780 })
    }, 120)
  }, [hidden, mapReady, destinations, friendDestinations, flyTarget, selectedName, mapSize])

  // ── Mise à jour directe des transforms SVG (bypass React) ──────────────────
  function updatePins(map: maplibregl.Map) {
    if (!pinsGroupRef.current) return

    pinsGroupRef.current.querySelectorAll<SVGGElement>('g.stop-root').forEach(el => {
      const lng = parseFloat(el.dataset.lng ?? '0')
      const lat = parseFloat(el.dataset.lat ?? '0')
      if (!isFinite(lng) || !isFinite(lat)) return
      const { x, y } = map.project([lng, lat] as maplibregl.LngLatLike)
      el.setAttribute('transform', `translate(${x},${y})`)
    })

    pinsGroupRef.current.querySelectorAll<SVGGElement>('g.route-stop-root').forEach(el => {
      const lng = parseFloat(el.dataset.lng ?? '0')
      const lat = parseFloat(el.dataset.lat ?? '0')
      if (!isFinite(lng) || !isFinite(lat)) return
      const { x, y } = map.project([lng, lat] as maplibregl.LngLatLike)
      el.setAttribute('transform', `translate(${x},${y})`)
    })

    pinsGroupRef.current.querySelectorAll<SVGGElement>('g.trip-pin-root').forEach(el => {
      const lng = parseFloat(el.dataset.lng ?? '0')
      const lat = parseFloat(el.dataset.lat ?? '0')
      if (!isFinite(lng) || !isFinite(lat)) return
      const { x, y } = map.project([lng, lat] as maplibregl.LngLatLike)
      el.setAttribute('transform', `translate(${x},${y})`)
    })

    // Re-build route paths every map move — geodesic samples + fresh projection.
    const project: Proj = ([lng, lat]) => {
      const { x, y } = map.project([lng, lat] as maplibregl.LngLatLike)
      return [x, y]
    }
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
    mapRef.current.flyTo({
      center: [flyTarget.lng, flyTarget.lat] as maplibregl.LngLatLike,
      zoom: Math.max(mapRef.current.getZoom(), 4),
      duration: 760,
    })
    onFlyTargetConsumed()
  }, [flyTarget, mapReady, onFlyTargetConsumed, destinations, friendDestinations])

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

    for (const pin of markerPins) {
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
      })
        .setLngLat([pin.destination.lng, pin.destination.lat] as maplibregl.LngLatLike)
        .addTo(map)

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

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <section
      className="map-area"
      aria-label={t('Destination map', 'Carte des destinations')}
      draggable={false}
      onDragStartCapture={(event) => event.preventDefault()}
    >
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


const Pin = memo(function Pin({
  destination, projection, compactMode, selected, onSelect, onZoomToZone, onExpandTrip, owner = 'me', badge, badgeAvatarUrl, badgeBg, badgeFg, shared, tripBadges,
}: PinProps) {
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
            className={`map-pin${isCompact ? ' map-pin--compact' : ''}${destination.kind === 'stage' ? ' map-pin-stage' : ''}${owner === 'friend' ? ' map-pin--friend' : ''}${destination.image ? ' map-pin--has-photo' : ''}${isCoupDeCoeur ? ' map-pin--coup-de-coeur' : ''}${isRevisited ? ' map-pin--revisited' : ''}`}
            draggable={false}
            onPointerDown={stopMarkerEvent}
            onClick={(event) => {
              stopMarkerEvent(event)
              onSelect(destination.name)
            }}
            style={{
              '--pin-color': color,
              '--pin-photo': destination.image ? `url("${destination.image}")` : 'none',
            } as CSSProperties}>
            <span className="map-pin-tier">{destinationTier ?? '?'}</span>
            {isCoupDeCoeur && (
              <span className="map-pin-heart" aria-label={t('Favorite', 'Coup de coeur')}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M20.8 4.6a5.4 5.4 0 0 0-7.7 0L12 5.7l-1.1-1.1a5.4 5.4 0 0 0-7.7 7.7L12 21l8.8-8.7a5.4 5.4 0 0 0 0-7.7Z" />
                </svg>
              </span>
            )}
            {isLivedThere && (
              <span className="map-pin-home" aria-label={t('Lived there', 'A vécu là-bas')}>🏠</span>
            )}
            {isRoadTrip && (
              <span className="map-pin-roadtrip" aria-label={t('Road trip', 'Road trip')}>🚗</span>
            )}
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
            {shared && <em className="pin-shared-badge" aria-label={t('Shared destination', 'Destination en commun')}>2x</em>}
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
