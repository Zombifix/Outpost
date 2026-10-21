// Liquid glass refraction for floating surfaces.
//
// CSS alone only gives frosted glass (blur + tint). The lensing seen on Apple's
// Liquid Glass — the backdrop bending near the rounded edges — needs an SVG
// displacement filter fed into `backdrop-filter: url(#…)`. Only Chromium renders
// that today (Safari and Firefox parse it but draw nothing), so this runs on
// Chromium only and everyone else keeps the frosted CSS fallback.
//
// Each surface gets its own filter, because the displacement map depends on the
// element's size and corner radius. Maps are rebuilt on resize and cached by size.

type Kind = 'control' | 'panel'

// Surfaces that float over the map. Primary buttons with opaque gradients are
// left out: nothing shows through them, so refraction would be wasted GPU.
const TARGETS: Array<{ selector: string; kind: Kind }> = [
  { selector: '.map-controls button', kind: 'control' },
  { selector: '.top-actions > button:not(.btn-primary)', kind: 'control' },
  { selector: '.filter-menu-wrap > button', kind: 'control' },
  { selector: '.user-badge', kind: 'control' },
  { selector: '.mobile-header-avatar', kind: 'control' },
  { selector: '.bottom-nav', kind: 'panel' },
  { selector: '.sidebar', kind: 'panel' },
  { selector: '.legend', kind: 'panel' },
  { selector: '.tier-board', kind: 'panel' },
  { selector: '.empty-friend-carnet-card', kind: 'panel' },
]

const SETTINGS: Record<Kind, { bezel: number; scale: number }> = {
  control: { bezel: 16, scale: 40 },
  panel: { bezel: 24, scale: 56 },
}

// Large maps cost memory and filter time; the bezel profile survives downscaling.
const MAX_MAP_SIDE = 600
const SVG_NS = 'http://www.w3.org/2000/svg'

interface Attached {
  id: string
  kind: Kind
  filter: SVGFilterElement
  key: string
}

const attached = new Map<HTMLElement, Attached>()
const mapCache = new Map<string, string>()
let defs: SVGDefsElement | null = null
let counter = 0

function supportsBackdropUrl(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  const brands = (navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } })
    .userAgentData?.brands
  if (!brands?.some((b) => b.brand === 'Chromium')) return false
  if (window.matchMedia('(prefers-reduced-transparency: reduce)').matches) return false
  return CSS.supports('backdrop-filter', 'url(#a)')
}

// Convex "squircle" bezel: the slope is steepest at the rim and flattens toward
// the inside, which is what makes the edge read as a thick rounded lens.
function bezelSlope(t: number): number {
  const s = 1 - t
  return s * s * s
}

function buildDisplacementMap(w: number, h: number, radius: number, bezel: number): string {
  const key = `${w}x${h}r${radius}b${bezel}`
  const cached = mapCache.get(key)
  if (cached) return cached

  const k = Math.min(1, MAX_MAP_SIDE / Math.max(w, h))
  const mw = Math.max(1, Math.round(w * k))
  const mh = Math.max(1, Math.round(h * k))
  const canvas = document.createElement('canvas')
  canvas.width = mw
  canvas.height = mh
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(mw, mh)
  const data = img.data

  const hw = w / 2
  const hh = h / 2
  const r = Math.min(radius, hw, hh)

  for (let py = 0; py < mh; py++) {
    for (let px = 0; px < mw; px++) {
      const x = (px + 0.5) / k - hw
      const y = (py + 0.5) / k - hh
      const ax = Math.abs(x)
      const ay = Math.abs(y)
      const qx = ax - (hw - r)
      const qy = ay - (hh - r)

      // Signed distance to the rounded-rect edge (positive inside) and outward normal.
      let dist: number
      let nx: number
      let ny: number
      if (qx > 0 && qy > 0) {
        const len = Math.hypot(qx, qy) || 1
        dist = r - len
        nx = (qx / len) * Math.sign(x)
        ny = (qy / len) * Math.sign(y)
      } else if (qx > qy) {
        dist = r - qx
        nx = Math.sign(x)
        ny = 0
      } else {
        dist = r - qy
        nx = 0
        ny = Math.sign(y)
      }

      let dx = 0
      let dy = 0
      if (dist >= 0 && dist < bezel) {
        // Sample inward: the rim magnifies what sits just inside it.
        const m = bezelSlope(dist / bezel)
        dx = -nx * m
        dy = -ny * m
      }

      const i = (py * mw + px) * 4
      data[i] = Math.round(127.5 + dx * 127.5)
      data[i + 1] = Math.round(127.5 + dy * 127.5)
      data[i + 2] = 128
      data[i + 3] = 255
    }
  }

  ctx.putImageData(img, 0, 0)
  const url = canvas.toDataURL()
  mapCache.set(key, url)
  return url
}

function ensureDefs(): SVGDefsElement {
  if (defs?.isConnected) return defs
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.style.position = 'absolute'
  svg.style.pointerEvents = 'none'
  defs = document.createElementNS(SVG_NS, 'defs')
  svg.appendChild(defs)
  document.body.appendChild(svg)
  return defs
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value))
  return node
}

// Three displacement passes at slightly different strengths, one per colour
// channel, recombined with screen: a light chromatic fringe on the rim.
function fillFilter(filter: SVGFilterElement, w: number, h: number, mapUrl: string, scale: number) {
  filter.replaceChildren()
  for (const [name, value] of Object.entries({
    x: 0, y: 0, width: w, height: h,
    filterUnits: 'userSpaceOnUse',
    'color-interpolation-filters': 'sRGB',
  })) filter.setAttribute(name, String(value))

  filter.append(
    el('feImage', { href: mapUrl, x: 0, y: 0, width: w, height: h, preserveAspectRatio: 'none', result: 'map' }),
  )
  const channels: Array<[string, number, string]> = [
    ['r', scale * 1.06, '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'],
    ['g', scale, '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0'],
    ['b', scale * 0.94, '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'],
  ]
  for (const [c, s, matrix] of channels) {
    filter.append(
      el('feDisplacementMap', {
        in: 'SourceGraphic', in2: 'map', scale: s.toFixed(2),
        xChannelSelector: 'R', yChannelSelector: 'G', result: `d${c}`,
      }),
      el('feColorMatrix', { in: `d${c}`, type: 'matrix', values: matrix, result: c }),
    )
  }
  filter.append(
    el('feBlend', { in: 'r', in2: 'g', mode: 'screen', result: 'rg' }),
    el('feBlend', { in: 'rg', in2: 'b', mode: 'screen' }),
  )
}

function update(node: HTMLElement) {
  const entry = attached.get(node)
  if (!entry) return
  const w = Math.round(node.offsetWidth)
  const h = Math.round(node.offsetHeight)
  if (!w || !h) return
  const style = getComputedStyle(node)
  // A percentage radius (round buttons) resolves against the box size.
  const raw = style.borderTopLeftRadius
  const radius = raw.endsWith('%') ? (parseFloat(raw) / 100) * Math.min(w, h) : parseFloat(raw) || 0
  const { bezel, scale } = SETTINGS[entry.kind]
  const b = Math.min(bezel, w / 2, h / 2)
  const key = `${w}x${h}r${radius}b${b}`
  if (key === entry.key) return
  entry.key = key
  fillFilter(entry.filter, w, h, buildDisplacementMap(w, h, radius, b), scale)
}

const resizeObserver =
  typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver((entries) => entries.forEach((e) => update(e.target as HTMLElement)))
    : null

function attach(node: HTMLElement, kind: Kind) {
  if (attached.has(node)) return
  const id = `lg-${++counter}`
  const filter = el('filter', { id })
  ensureDefs().appendChild(filter)
  attached.set(node, { id, kind, filter, key: '' })
  node.style.setProperty('--lg-filter', `url(#${id})`)
  // A data attribute, not a class: React rewrites className on re-render.
  node.dataset.lg = kind
  update(node)
  resizeObserver?.observe(node)
}

function detach(node: HTMLElement) {
  const entry = attached.get(node)
  if (!entry) return
  entry.filter.remove()
  resizeObserver?.unobserve(node)
  attached.delete(node)
}

function scan() {
  for (const { selector, kind } of TARGETS) {
    document.querySelectorAll<HTMLElement>(selector).forEach((node) => attach(node, kind))
  }
  for (const node of attached.keys()) if (!node.isConnected) detach(node)
}

export function initLiquidGlass() {
  if (!supportsBackdropUrl()) return
  document.documentElement.classList.add('lg-on')
  scan()
  let pending = false
  new MutationObserver(() => {
    if (pending) return
    pending = true
    // setTimeout, not requestAnimationFrame: rAF is paused in background tabs.
    setTimeout(() => {
      pending = false
      scan()
    })
  }).observe(document.body, { childList: true, subtree: true })
}
