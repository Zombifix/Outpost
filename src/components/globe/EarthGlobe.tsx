import { useEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, useTexture } from '@react-three/drei'
import * as THREE from 'three'

// Globe 3D de la vue monde (Three.js / React Three Fiber) : Terre éclairée avec
// séparation jour / nuit, reflets sur les océans, nuages, vraie couche
// d'atmosphère (sphère plus grande, effet Fresnel). Le fond spatial n'est pas
// dans la scène : il est généré derrière le canvas, transparent (SpaceBackdrop).
// Textures dans public/globe/ : Solar System Scope (CC BY 4.0) et, pour la nuit,
// NASA Black Marble (domaine public).

const TEXTURES = {
  day: '/globe/earth-day.jpg',
  night: '/globe/earth-night.jpg',
  clouds: '/globe/earth-clouds.jpg',
  ocean: '/globe/earth-ocean.jpg',
}

// Lumière « de studio » : le soleil suit la caméra, en haut à gauche et un peu
// de face. On voit toujours une face éclairée, avec la limite jour / nuit qui
// passe sur le bord droit de la Terre.
const SUN_FROM_CAMERA = new THREE.Vector3(-0.78, 0.38, 0.5)
// De près, le soleil passe de face : la zone visée est en plein jour quand la
// carte (toujours de jour) prend le relais.
const SUN_FROM_CAMERA_CLOSE = new THREE.Vector3(-0.3, 0.3, 0.9)

// Coordonnées géographiques → direction sur la sphère, avec la même convention
// que la texture équirectangulaire de THREE.SphereGeometry.
export function latLngToVector(lat: number, lng: number, radius = 1) {
  const phi = ((lng + 180) / 360) * Math.PI * 2
  const latRad = (lat * Math.PI) / 180
  return new THREE.Vector3(
    -Math.cos(phi) * Math.cos(latRad) * radius,
    Math.sin(latRad) * radius,
    Math.sin(phi) * Math.cos(latRad) * radius,
  )
}

export function vectorToLatLng(vector: THREE.Vector3) {
  const v = vector.clone().normalize()
  const lat = (Math.asin(v.y) * 180) / Math.PI
  const phi = Math.atan2(v.z, -v.x)
  let lng = (phi * 180) / Math.PI - 180
  if (lng < -180) lng += 360
  return { lat, lng }
}

const earthVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPosW = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const earthFragment = /* glsl */ `
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform sampler2D oceanMap;
  uniform sampler2D cloudMap;
  uniform vec3 sunDir;
  uniform float cloudOffset;
  uniform float closeness;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vPosW);
    float ndl = dot(N, sunDir);
    float dayAmount = smoothstep(-0.12, 0.25, ndl);

    vec3 day = texture2D(dayMap, vUv).rgb;
    vec3 night = texture2D(nightMap, vUv).rgb;
    float ocean = texture2D(oceanMap, vUv).r;
    float cloud = texture2D(cloudMap, vUv + vec2(cloudOffset, 0.0)).r;

    // Côté jour : diffus doux. (Pas d'ombre de nuages : elle glissait sur les
    // continents et donnait l'impression d'un double calque.)
    vec3 color = day * (0.035 + 1.08 * max(ndl, 0.0));
    // Côté nuit : lumières des villes, chaudes, qui s'effacent vers le jour.
    color += night * vec3(1.0, 0.82, 0.58) * 1.5 * (1.0 - dayAmount) * (1.0 - cloud * 0.6);
    // Océans : reflet du soleil, fin et discret.
    vec3 H = normalize(sunDir + V);
    float spec = pow(max(dot(N, H), 0.0), 70.0) * ocean * dayAmount;
    color += vec3(1.0, 0.96, 0.88) * spec * 0.55 * (1.0 - closeness);
    // Bord de la planète légèrement bleui côté jour (épaisseur d'atmosphère).
    float rim = pow(1.0 - max(dot(N, V), 0.0), 2.6);
    color += vec3(0.32, 0.58, 1.0) * rim * 0.5 * smoothstep(-0.2, 0.5, ndl) * (1.0 - 0.7 * closeness);

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

const cloudFragment = /* glsl */ `
  uniform sampler2D cloudMap;
  uniform vec3 sunDir;
  uniform float cloudOffset;
  uniform float closeness;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vec3 N = normalize(vNormalW);
    float ndl = dot(N, sunDir);
    float cloud = texture2D(cloudMap, vUv + vec2(cloudOffset, 0.0)).r;
    float light = 0.06 + 0.98 * max(ndl, 0.0);
    float alpha = smoothstep(0.08, 0.9, cloud) * 0.92 * (0.15 + 0.85 * smoothstep(-0.2, 0.2, ndl)) * (1.0 - closeness);
    gl_FragColor = vec4(vec3(light), alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

// Atmosphère : sphère un peu plus grande, vue de l'intérieur (BackSide), mélange
// additif. L'effet Fresnel la rend visible surtout sur le contour ; elle est plus
// lumineuse côté soleil et s'éteint côté nuit.
const atmosphereVertex = /* glsl */ `
  varying vec3 vNormalV;
  varying vec3 vNormalW;
  void main() {
    vNormalV = normalize(normalMatrix * normal);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// Halo : nul sur le bord extérieur de la sphère d'atmosphère (t = 0), maximal
// contre le bord de la Terre, en courbe douce : pas de bordure nette.
const ATMOSPHERE_SCALE = 1.16
const atmosphereFragment = /* glsl */ `
  uniform vec3 sunDir;
  varying vec3 vNormalV;
  varying vec3 vNormalW;
  void main() {
    float t = clamp(-vNormalV.z, 0.0, 1.0);
    float limb = sqrt(1.0 - 1.0 / (${ATMOSPHERE_SCALE} * ${ATMOSPHERE_SCALE}));
    float glow = pow(smoothstep(0.0, limb, t), 2.2);
    float sun = 0.08 + 0.92 * smoothstep(-0.3, 0.6, dot(vNormalW, sunDir));
    vec3 color = mix(vec3(0.3, 0.55, 1.0), vec3(0.7, 0.85, 1.0), glow * sun);
    // Le canvas est transparent (fond spatial derrière) : la lumière s'ajoute,
    // et l'opacité suit son intensité, sinon tout le halo deviendrait opaque.
    vec3 light = color * glow * sun * 0.55;
    gl_FragColor = vec4(light, max(light.r, max(light.g, light.b)));
  }
`

function Earth({ focusLat, focusLng }: { focusLat: number | null; focusLng: number | null }) {
  const maps = useTexture(TEXTURES)
  const { camera, gl } = useThree()
  const cloudsRef = useRef<THREE.Mesh>(null)

  useMemo(() => {
    for (const key of ['day', 'night'] as const) maps[key].colorSpace = THREE.SRGBColorSpace
    const anisotropy = gl.capabilities.getMaxAnisotropy()
    for (const texture of Object.values(maps)) {
      texture.anisotropy = Math.min(8, anisotropy)
      texture.wrapS = THREE.RepeatWrapping
    }
  }, [maps, gl])

  const uniforms = useMemo(() => ({
    dayMap: { value: maps.day },
    nightMap: { value: maps.night },
    oceanMap: { value: maps.ocean },
    cloudMap: { value: maps.clouds },
    sunDir: { value: new THREE.Vector3(1, 0, 0) },
    cloudOffset: { value: 0 },
    // 0 en vue monde, 1 à l'altitude du relais vers la carte (qui n'a ni
    // nuages ni reflet) : le globe lui ressemble au moment du passage.
    closeness: { value: 0 },
  }), [maps])

  // Première vue tournée vers les destinations, une seule fois : ensuite la
  // caméra appartient aux contrôles.
  const focused = useRef(false)
  useEffect(() => {
    if (focused.current || focusLat === null || focusLng === null) return
    focused.current = true
    // Un peu au-dessus des destinations : vue légèrement plongeante.
    const direction = latLngToVector(focusLat + 14, focusLng)
    camera.position.copy(direction.multiplyScalar(camera.position.length()))
    camera.lookAt(0, 0, 0)
  }, [focusLat, focusLng, camera])

  const sun = useMemo(() => new THREE.Vector3(), [])
  const sunLocal = useMemo(() => new THREE.Vector3(), [])
  const basis = useMemo(() => ({ forward: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() }), [])
  useFrame(() => {
    // Soleil exprimé dans le repère de la caméra (lumière de studio).
    basis.forward.copy(camera.position).normalize()
    basis.right.crossVectors(camera.up, basis.forward).normalize()
    basis.up.crossVectors(basis.forward, basis.right).normalize()
    const close = Math.min(1, Math.max(0, (3.2 - camera.position.length()) / 1.6))
    sunLocal.lerpVectors(SUN_FROM_CAMERA, SUN_FROM_CAMERA_CLOSE, close)
    sun.set(0, 0, 0)
      .addScaledVector(basis.right, sunLocal.x)
      .addScaledVector(basis.up, sunLocal.y)
      .addScaledVector(basis.forward, sunLocal.z)
      .normalize()
    uniforms.sunDir.value.copy(sun)
    uniforms.closeness.value = THREE.MathUtils.smoothstep(2.5 - camera.position.length(), 0, 0.75)
  })

  return (
    <group>
      <mesh>
        <sphereGeometry args={[1, 160, 160]} />
        <shaderMaterial uniforms={uniforms} vertexShader={earthVertex} fragmentShader={earthFragment} />
      </mesh>
      <mesh ref={cloudsRef} scale={1.006}>
        <sphereGeometry args={[1, 128, 128]} />
        <shaderMaterial
          uniforms={uniforms}
          vertexShader={earthVertex}
          fragmentShader={cloudFragment}
          transparent
          depthWrite={false}
        />
      </mesh>
      <mesh scale={ATMOSPHERE_SCALE}>
        <sphereGeometry args={[1, 96, 96]} />
        <shaderMaterial
          uniforms={uniforms}
          vertexShader={atmosphereVertex}
          fragmentShader={atmosphereFragment}
          side={THREE.BackSide}
          blending={THREE.CustomBlending}
          blendSrc={THREE.OneFactor}
          blendDst={THREE.OneFactor}
          blendSrcAlpha={THREE.OneFactor}
          blendDstAlpha={THREE.OneFactor}
          transparent
          depthWrite={false}
        />
      </mesh>
    </group>
  )
}

// Décale le rendu vers la droite de la moitié de la barre latérale : le globe se
// centre dans l'espace libre, par la caméra (pas de transform CSS).
// Lever de soleil sur le bord de la Terre, en haut à gauche (côté du soleil) :
// une lueur posée juste derrière le contour, que la planète masque à moitié. Un
// cœur chaud et fin, un halo bleuté large, quelques rayons très pâles. Elle
// s'efface en s'approchant de la Terre.
function sunGlowTexture() {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (context) {
    const half = size / 2
    const glow = context.createRadialGradient(half, half, 0, half, half, half)
    glow.addColorStop(0, 'rgba(255, 252, 244, 1)')
    glow.addColorStop(0.08, 'rgba(255, 244, 222, 0.85)')
    glow.addColorStop(0.22, 'rgba(255, 226, 196, 0.32)')
    glow.addColorStop(0.45, 'rgba(170, 205, 255, 0.12)')
    glow.addColorStop(1, 'rgba(120, 170, 255, 0)')
    context.fillStyle = glow
    context.fillRect(0, 0, size, size)
    context.globalCompositeOperation = 'lighter'
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI + 0.3
      const ray = context.createLinearGradient(
        half - Math.cos(angle) * half, half - Math.sin(angle) * half,
        half + Math.cos(angle) * half, half + Math.sin(angle) * half,
      )
      ray.addColorStop(0, 'rgba(255, 240, 220, 0)')
      ray.addColorStop(0.5, `rgba(255, 240, 220, ${i % 2 ? 0.1 : 0.18})`)
      ray.addColorStop(1, 'rgba(255, 240, 220, 0)')
      context.save()
      context.translate(half, half)
      context.rotate(angle)
      context.fillStyle = ray
      context.fillRect(-half, -0.8, size, 1.6)
      context.restore()
    }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function SunGlow() {
  const { camera } = useThree()
  const texture = useMemo(() => sunGlowTexture(), [])
  const core = useRef<THREE.Sprite>(null)
  const bloom = useRef<THREE.Sprite>(null)
  const forward = useMemo(() => new THREE.Vector3(), [])
  const right = useMemo(() => new THREE.Vector3(), [])
  const up = useMemo(() => new THREE.Vector3(), [])
  const toward = useMemo(() => new THREE.Vector3(), [])
  useEffect(() => () => texture.dispose(), [texture])
  useFrame(() => {
    const distance = camera.position.length()
    forward.copy(camera.position).normalize()
    right.crossVectors(camera.up, forward).normalize()
    up.crossVectors(forward, right).normalize()
    // Point du contour visible dans la direction du soleil (haut gauche) :
    // à 1/d vers la caméra, et à sqrt(1 - 1/d²) sur le côté.
    toward.set(0, 0, 0).addScaledVector(right, -0.7).addScaledVector(up, 0.72).normalize()
    const side = Math.sqrt(Math.max(0, 1 - 1 / (distance * distance)))
    const fade = THREE.MathUtils.smoothstep(distance, 2.2, 3.2)
    for (const [sprite, size, strength, depth] of [[core.current, 0.62, 1, 0.05], [bloom.current, 2.3, 0.6, 0.0]] as const) {
      if (!sprite) continue
      sprite.position.copy(toward).multiplyScalar(side * 1.004).addScaledVector(forward, 1 / distance - depth)
      sprite.scale.setScalar(size)
      ;(sprite.material as THREE.SpriteMaterial).opacity = strength * fade
      sprite.visible = fade > 0.01
    }
  })
  return (
    <>
      <sprite ref={bloom}>
        <spriteMaterial map={texture} blending={THREE.AdditiveBlending} depthWrite={false} transparent toneMapped={false} />
      </sprite>
      <sprite ref={core}>
        <spriteMaterial map={texture} blending={THREE.AdditiveBlending} depthWrite={false} transparent toneMapped={false} />
      </sprite>
    </>
  )
}

function CenterInFreeSpace({ offsetLeft }: { offsetLeft: number }) {
  const { camera, size } = useThree()
  useEffect(() => {
    const perspective = camera as THREE.PerspectiveCamera
    perspective.setViewOffset(size.width, size.height, -offsetLeft / 2, 0, size.width, size.height)
    perspective.updateProjectionMatrix()
  }, [camera, size, offsetLeft])
  return null
}

export interface GlobePin {
  key: string
  lat: number
  lng: number
}

export interface GlobeCameraRequest {
  lat: number
  lng: number
  token: number
  // Distance caméra visée (rayons terrestres) : calculée par WorldMap pour que
  // le globe ait la même taille à l'écran que la carte au moment du relais.
  distance?: number
}

// Voiles de nuages traversés en passant du globe à la carte (et inversement) :
// quelques fines couches posées l'une sous l'autre au-dessus du point visé,
// perpendiculaires à la plongée. Chaque couche est un bruit fractal déformé
// (fBm), calculé par le GPU : des filaments clairs et translucides, comme des
// cirrus, sans contour ni « boule ». La caméra les traverse l'une après l'autre.
interface CloudBankState {
  center: THREE.Vector3
  inner: number
  outer: number
  born: number
  // Durée de vie avant de s'effacer (ms).
  life: number
  seed: number
}
const CLOUD_VEIL_COUNT = 6
// Côté d'une couche (rayons terrestres) : de quoi déborder de l'écran de près.
const CLOUD_VEIL_SIZE = 1.3

function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

const veilVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const veilFragment = /* glsl */ `
  varying vec2 vUv;
  uniform float uOpacity;
  uniform float uTime;
  uniform vec2 uOffset;
  uniform float uScale;
  uniform float uCover;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    mat2 turn = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 6; i++) {
      value += amplitude * noise(p);
      p = turn * p * 2.03 + 11.7;
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    vec2 p = (vUv - 0.5) * uScale + uOffset;
    // Déformation du bruit par lui-même : des filaments étirés et enroulés.
    vec2 warp = vec2(fbm(p + vec2(0.0, uTime * 0.015)), fbm(p + vec2(5.2, 1.3)));
    float shape = fbm(p + 1.8 * warp + vec2(uTime * 0.01, 0.0));
    float density = smoothstep(uCover, uCover + 0.32, shape);
    // Grain fin à l'intérieur des filaments.
    density *= 0.55 + 0.45 * fbm(p * 5.0 + warp * 2.0);
    // Bords de la couche invisibles.
    float edge = 1.0 - smoothstep(0.45, 1.0, length(vUv - 0.5) * 2.0);
    vec3 color = mix(vec3(0.74, 0.8, 0.9), vec3(1.0), smoothstep(0.05, 0.7, density));
    gl_FragColor = vec4(color, density * edge * uOpacity);
  }
`

function CloudBank({ bank }: { bank: React.MutableRefObject<CloudBankState | null> }) {
  const { camera } = useThree()
  const group = useRef<THREE.Group>(null)
  const veils = useMemo(
    () =>
      Array.from({ length: CLOUD_VEIL_COUNT }, () => {
        const material = new THREE.ShaderMaterial({
          vertexShader: veilVertex,
          fragmentShader: veilFragment,
          uniforms: {
            uOpacity: { value: 0 },
            uTime: { value: 0 },
            uOffset: { value: new THREE.Vector2() },
            uScale: { value: 6 },
            uCover: { value: 0.52 },
          },
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(CLOUD_VEIL_SIZE, CLOUD_VEIL_SIZE), material)
        mesh.visible = false
        return { mesh, material, radius: 1, base: 1 }
      }),
    [],
  )
  useEffect(() => {
    const parent = group.current
    if (!parent) return
    veils.forEach(({ mesh }) => parent.add(mesh))
    return () => {
      veils.forEach(({ mesh, material }) => {
        parent.remove(mesh)
        mesh.geometry.dispose()
        material.dispose()
      })
    }
  }, [veils])

  const placedFor = useRef<CloudBankState | null>(null)
  const facing = useMemo(() => new THREE.Vector3(0, 0, 1), [])
  useFrame(({ clock }) => {
    const current = bank.current
    if (!current) {
      if (placedFor.current) veils.forEach(({ mesh }) => { mesh.visible = false })
      placedFor.current = null
      return
    }
    if (placedFor.current !== current) {
      // Nouvelles couches, étagées entre les deux altitudes, chacune avec son
      // propre motif (décalage, échelle, couverture).
      placedFor.current = current
      const random = seededRandom(current.seed)
      const axis = current.center.clone().normalize()
      veils.forEach((veil, index) => {
        const step = (index + 0.3 + random() * 0.4) / CLOUD_VEIL_COUNT
        veil.radius = current.inner + step * (current.outer - current.inner)
        veil.mesh.position.copy(axis).multiplyScalar(veil.radius)
        veil.mesh.quaternion.setFromUnitVectors(facing, axis)
        veil.mesh.rotateZ(random() * Math.PI * 2)
        veil.material.uniforms.uOffset.value.set(random() * 50, random() * 50)
        veil.material.uniforms.uScale.value = 5 + random() * 4
        veil.material.uniforms.uCover.value = 0.48 + random() * 0.1
        veil.base = 0.45 + random() * 0.25
      })
    }
    const age = performance.now() - current.born
    // Apparaît en un quart de seconde (pas d'un coup), s'efface en fin de vie.
    const life = Math.min(1, age / 250) * (age < current.life ? 1 : Math.max(0, 1 - (age - current.life) / 500))
    if (age > current.life && life <= 0) {
      bank.current = null
      return
    }
    const height = camera.position.length()
    for (const veil of veils) {
      // Couche sous la caméra : visible en approchant, s'efface juste au moment
      // de la traverser (de trop près le motif ne serait qu'un aplat).
      const below = height - veil.radius
      const ahead = THREE.MathUtils.smoothstep(below, 0, 0.05) * (1 - THREE.MathUtils.smoothstep(below, 0.2, 0.6))
      const opacity = veil.base * ahead * life
      veil.material.uniforms.uOpacity.value = opacity
      veil.material.uniforms.uTime.value = clock.elapsedTime
      veil.mesh.visible = opacity > 0.01
    }
  })
  return <group ref={group} />
}

type ControlsLike = { enabled: boolean; autoRotate: boolean; update: () => void }

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
// Approche d'une destination : départ doux puis accélération ; la carte prend
// le relais lancée et freine jusqu'à l'arrivée (un seul mouvement).
const easeInApproach = (t: number) => t * t * (2.2 * t - 1.2 * t * t)
const DIVE_DISTANCE = 1.75
// Plongée automatique après le seuil de la molette : de combien la caméra
// descend (rayons terrestres) avant que la carte prenne le relais.
const WHEEL_DIVE_DEPTH = 0.45
const easeInQuad = (t: number) => t * t
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
const WORLD_DISTANCE = 4.2
// Pose cinématique en vue globe : image légèrement inclinée, qui se redresse en
// s'approchant de la Terre (comme la carte détaillée).
const CINEMATIC_ROLL = (-10 * Math.PI) / 180
function rollForDistance(distance: number) {
  const t = Math.min(1, Math.max(0, (distance - 1.9) / 1.6))
  return CINEMATIC_ROLL * t * t * (3 - 2 * t)
}
// Caméra tournée vers la Terre, avec l'inclinaison cinématique de sa distance.
// À utiliser après tout déplacement fait pendant une image, sinon l'inclinaison
// saute le temps de cette image.
function orientCamera(camera: THREE.Camera) {
  camera.lookAt(0, 0, 0)
  camera.rotateZ(rollForDistance(camera.position.length()))
  camera.updateMatrixWorld()
}

// Pilotage de la caméra : rotation + rapprochement vers une destination (puis
// passage de relais à la carte), retour depuis la carte, et passage à la carte
// quand on zoome assez près à la molette.
function CameraRig({
  flyTo,
  returnTo,
  zoomThroughDistance,
  onDiveComplete,
  onZoomThrough,
  onZoomThroughComplete,
  controlsRef,
  bank,
  busy,
  focusPin,
}: {
  flyTo: GlobeCameraRequest | null
  returnTo: GlobeCameraRequest | null
  // Distance sous laquelle la carte prend le relais.
  zoomThroughDistance: number
  // Fin de l'approche d'une destination cliquée : la carte prend le relais.
  onDiveComplete: (lat: number, lng: number, distance: number) => void
  // Seuil franchi à la molette : la plongée commence et finira à `distance`.
  onZoomThrough: (lat: number, lng: number, distance: number) => void
  // Fin de cette plongée, au cœur des nuages : la carte prend le relais.
  onZoomThroughComplete: (lat: number, lng: number, distance: number) => void
  controlsRef: React.MutableRefObject<ControlsLike | null>
  bank: React.MutableRefObject<CloudBankState | null>
  // Vrai pendant une animation de caméra : la molette ne doit pas s'en mêler.
  busy: React.MutableRefObject<boolean>
  // Pin gardé visible pendant une plongée (direction sur la sphère), ou aucun.
  focusPin: React.MutableRefObject<THREE.Vector3 | null>
}) {
  const { camera } = useThree()
  const animation = useRef<{
    from: THREE.Vector3
    rotation: THREE.Quaternion
    easing: (t: number) => number
    fromDistance: number
    toDistance: number
    start: number
    duration: number
    done?: () => void
  } | null>(null)
  const throughFired = useRef(false)
  const identity = useMemo(() => new THREE.Quaternion(), [])
  const step = useMemo(() => new THREE.Quaternion(), [])
  const reduceMotion = useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, [])

  const animateTo = (lat: number, lng: number, distance: number, duration: number, done?: () => void, easing = easeInOut) => {
    const from = camera.position.clone().normalize()
    const to = latLngToVector(lat, lng).normalize()
    animation.current = {
      from,
      rotation: new THREE.Quaternion().setFromUnitVectors(from, to),
      easing,
      fromDistance: camera.position.length(),
      toDistance: distance,
      start: performance.now(),
      duration: reduceMotion ? 1 : duration,
      done,
    }
  }

  // Plongée vers (lat, lng) jusqu'à `to`, à travers un banc de nuages posé
  // autour de cette altitude : au moment du relais (fin de la plongée), la caméra
  // est dans la couche. Elle continue ensuite sur sa lancée, en freinant, pendant
  // que le globe s'efface sur la carte qui poursuit le même mouvement.
  const diveThroughClouds = (
    lat: number,
    lng: number,
    to: number,
    duration: number,
    easing: (t: number) => number,
    onSwap: (lat: number, lng: number, distance: number) => void,
    clouds: boolean,
  ) => {
    // Pendant la plongée, seul le pin visé reste affiché (aucun au zoom molette).
    focusPin.current = clouds ? null : latLngToVector(lat, lng).normalize()
    bank.current = clouds
      ? {
          center: latLngToVector(lat, lng),
          inner: Math.max(1.03, to - 0.22),
          outer: to + 0.5,
          born: performance.now(),
          life: duration + 900,
          seed: Math.floor(Math.random() * 1e9),
        }
      : null
    animateTo(lat, lng, to, duration, () => {
      onSwap(lat, lng, to)
      animateTo(lat, lng, 1 + (to - 1) * 0.55, 700, undefined, easeOutCubic)
    }, easing)
  }

  useEffect(() => {
    if (!flyTo) return
    // En fin d'approche la caméra est sous le seuil du zoom molette : on bloque ce
    // déclenchement, sinon un second relais annulait la plongée de la carte.
    throughFired.current = true
    diveThroughClouds(flyTo.lat, flyTo.lng, flyTo.distance ?? DIVE_DISTANCE, 900, easeInApproach, onDiveComplete, false)
  }, [flyTo?.token]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!returnTo) return
    // Retour depuis la carte : même endroit, même taille, sans animation ; la
    // molette continue ensuite directement sur le globe. On sort par le haut
    // d'une couche de nuages, qui s'éloigne sous la caméra.
    animation.current = null
    const distance = returnTo.distance ?? 2.3
    camera.position.copy(latLngToVector(returnTo.lat, returnTo.lng).multiplyScalar(distance))
    camera.lookAt(0, 0, 0)
    throughFired.current = true
    bank.current = {
      center: latLngToVector(returnTo.lat, returnTo.lng),
      inner: Math.max(1.03, distance - 0.75),
      outer: distance - 0.16,
      born: performance.now(),
      life: 900,
      seed: Math.floor(Math.random() * 1e9),
    }
  }, [returnTo?.token]) // eslint-disable-line react-hooks/exhaustive-deps

  useFrame(() => {
    const controls = controlsRef.current
    const current = animation.current
    busy.current = current !== null
    if (current) {
      const t = Math.min(1, (performance.now() - current.start) / current.duration)
      const eased = current.easing(t)
      step.slerpQuaternions(identity, current.rotation, eased)
      const distance = current.fromDistance + (current.toDistance - current.fromDistance) * eased
      camera.position.copy(current.from).applyQuaternion(step).multiplyScalar(distance)
      camera.lookAt(0, 0, 0)
      if (controls) {
        controls.enabled = false
        controls.autoRotate = false
      }
      if (t >= 1) {
        animation.current = null
        if (controls) {
          controls.enabled = true
          controls.autoRotate = true
          controls.update()
        }
        current.done?.()
      }
      applyRoll()
      return
    }
    const distance = camera.position.length()
    const { lat, lng } = vectorToLatLng(camera.position)
    if (distance < zoomThroughDistance && !throughFired.current) {
      // Seuil franchi à la molette : on plonge d'un coup à travers les nuages,
      // en accélérant, jusqu'au relais.
      throughFired.current = true
      const to = Math.max(MIN_CAMERA_DISTANCE, distance - WHEEL_DIVE_DEPTH)
      onZoomThrough(lat, lng, to)
      diveThroughClouds(lat, lng, to, 750, easeInQuad, onZoomThroughComplete, true)
    } else if (distance > zoomThroughDistance + 0.04) {
      // Réarmé dès qu'on remonte un peu : le retour depuis la carte place la
      // caméra juste au-dessus du seuil, et un aller-retour de molette doit
      // pouvoir repasser sur la carte.
      throughFired.current = false
    }
    applyRoll()
  })

  // Inclinaison de l'image autour de l'axe de visée, réappliquée à chaque image
  // (les contrôles remettent la caméra droite à chaque mise à jour).
  function applyRoll() {
    camera.rotateZ(rollForDistance(camera.position.length()))
    camera.updateMatrixWorld()
  }
  return null
}

// La caméra ne passe pas au-dessus des pôles (sinon elle se retourne et saute).
const MIN_POLAR = 0.22
// Ramène la caméra à la limite (même longitude, même distance) plutôt que de
// refuser le mouvement : en tirant vers un pôle, le globe glisse au lieu de se
// figer. Renvoie true si la position a été corrigée.
const clampSpherical = new THREE.Spherical()
function clampToPolarLimits(position: THREE.Vector3) {
  clampSpherical.setFromVector3(position)
  const phi = THREE.MathUtils.clamp(clampSpherical.phi, MIN_POLAR, Math.PI - MIN_POLAR)
  if (phi === clampSpherical.phi) return false
  clampSpherical.phi = phi
  position.setFromSpherical(clampSpherical)
  return true
}
const MIN_CAMERA_DISTANCE = 1.15
const MAX_CAMERA_DISTANCE = 6

// Élan au lâcher : vitesse mesurée sur les derniers mouvements, plafonnée, puis
// amortie en ~0,3 s. Pas d'élan si la souris était déjà arrêtée au lâcher.
const MAX_SPIN_SPEED = 0.08 // degrés d'arc par ms
const SPIN_DAMPING_MS = 280
const SPIN_STALE_MS = 80
const MAX_CAMERA_LAT = 90 - (MIN_POLAR * 180) / Math.PI
const wrapLng = (lng: number) => ((((lng + 180) % 360) + 360) % 360) - 180

// Saisie du globe, comme sur une carte : le nord reste en haut, un glissement
// horizontal fait tourner la Terre sur son axe (longitude exacte) et un
// glissement vertical la fait basculer, le point attrapé suivant le curseur.
// Élan amorti au lâcher ; la rotation automatique repart 2,5 s après.
function GrabRotate({ controlsRef }: { controlsRef: React.MutableRefObject<ControlsLike | null> }) {
  const { camera, gl, size } = useThree()
  const state = useRef({
    dragging: false,
    grabbed: new THREE.Vector3(),
    velocity: { lat: 0, lng: 0 }, // degrés par ms
    lastMove: 0,
    idleSince: 0,
  })
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const sphere = useMemo(() => new THREE.Sphere(new THREE.Vector3(), 1), [])

  const hit = (clientX: number, clientY: number, target: THREE.Vector3) => {
    const rect = gl.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(ndc, camera)
    return raycaster.ray.intersectSphere(sphere, target)
  }

  // Déplace la caméra de (dLat, dLng) degrés ; renvoie false en butée près d'un pôle.
  const moveCamera = (dLat: number, dLng: number) => {
    const from = vectorToLatLng(camera.position)
    const lat = THREE.MathUtils.clamp(from.lat + dLat, -MAX_CAMERA_LAT, MAX_CAMERA_LAT)
    camera.position.copy(latLngToVector(lat, from.lng + dLng, camera.position.length()))
    orientCamera(camera)
    return lat === from.lat + dLat
  }

  useEffect(() => {
    const element = gl.domElement
    const current = new THREE.Vector3()
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || !hit(event.clientX, event.clientY, state.current.grabbed)) return
      state.current.dragging = true
      state.current.velocity = { lat: 0, lng: 0 }
      state.current.lastMove = performance.now()
      element.setPointerCapture(event.pointerId)
      if (controlsRef.current) controlsRef.current.autoRotate = false
    }
    const onMove = (event: PointerEvent) => {
      const s = state.current
      if (!s.dragging || !hit(event.clientX, event.clientY, current)) return
      // Le point sous le curseur doit redevenir le point attrapé : la caméra se
      // décale de l'écart entre les deux (exact en longitude, et en latitude au
      // fil des mouvements).
      const grabbed = vectorToLatLng(s.grabbed)
      const under = vectorToLatLng(current)
      const dLat = grabbed.lat - under.lat
      const dLng = wrapLng(grabbed.lng - under.lng)
      moveCamera(dLat, dLng)
      const now = performance.now()
      const dt = Math.max(8, now - s.lastMove)
      s.velocity = {
        lat: s.velocity.lat * 0.5 + (dLat / dt) * 0.5,
        lng: s.velocity.lng * 0.5 + (dLng / dt) * 0.5,
      }
      s.lastMove = now
    }
    const onUp = (event: PointerEvent) => {
      const s = state.current
      if (!s.dragging) return
      s.dragging = false
      const now = performance.now()
      if (now - s.lastMove > SPIN_STALE_MS) {
        s.velocity = { lat: 0, lng: 0 }
      } else {
        // Plafond sur la vitesse réelle à la surface (la longitude compte moins
        // près des pôles).
        const lat = vectorToLatLng(camera.position).lat
        const speed = Math.hypot(s.velocity.lat, s.velocity.lng * Math.cos((lat * Math.PI) / 180))
        if (speed > MAX_SPIN_SPEED) {
          s.velocity = { lat: (s.velocity.lat * MAX_SPIN_SPEED) / speed, lng: (s.velocity.lng * MAX_SPIN_SPEED) / speed }
        }
      }
      s.idleSince = now
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId)
    }
    element.addEventListener('pointerdown', onDown)
    element.addEventListener('pointermove', onMove)
    element.addEventListener('pointerup', onUp)
    element.addEventListener('pointercancel', onUp)
    return () => {
      element.removeEventListener('pointerdown', onDown)
      element.removeEventListener('pointermove', onMove)
      element.removeEventListener('pointerup', onUp)
      element.removeEventListener('pointercancel', onUp)
    }
  }, [camera, gl, size, controlsRef]) // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((_, delta) => {
    const s = state.current
    if (s.dragging) return
    // Élan : on continue à la vitesse du lâcher, en l'amortissant.
    const v = s.velocity
    if (Math.abs(v.lat) + Math.abs(v.lng) > 1e-5) {
      const ms = Math.min(delta * 1000, 50)
      const free = moveCamera(v.lat * ms, v.lng * ms)
      const decay = Math.exp(-ms / SPIN_DAMPING_MS)
      // En butée près d'un pôle, seule la rotation en longitude continue.
      s.velocity = { lat: free ? v.lat * decay : 0, lng: v.lng * decay }
    }
    if (s.idleSince && performance.now() - s.idleSince > 2500 && controlsRef.current) {
      controlsRef.current.autoRotate = true
      s.idleSince = 0
    }
  })
  return null
}

// Zoom molette vers le curseur : la distance suit une cible lissée, et à chaque
// image la caméra tourne juste ce qu'il faut pour que le point sous le curseur y
// reste (comme sur une carte). Il ne glisse plus vers le centre, donc la vue ne
// dérive plus vers un pôle en zoomant.
function WheelZoom({ busy }: { busy: React.MutableRefObject<boolean> }) {
  const { camera, gl } = useThree()
  const target = useRef(camera.position.length())
  const lastWheel = useRef(0)
  const cursor = useRef(new THREE.Vector2())
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const sphere = useMemo(() => new THREE.Sphere(new THREE.Vector3(), 1), [])

  useEffect(() => {
    // Tout le calque du globe, pins compris : une molette au-dessus d'un pin doit
    // aussi zoomer.
    const element = (gl.domElement.closest('.earth-globe-layer') as HTMLElement | null) ?? gl.domElement
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      // Plongée en cours : elle va au bout, les crans de plus sont ignorés.
      if (busy.current) return
      const now = performance.now()
      if (now - lastWheel.current > 250) target.current = camera.position.length()
      lastWheel.current = now
      // Delta en pixels (Firefox l'envoie parfois en lignes). Chrome regroupe
      // plusieurs crans en un seul événement quand la page est chargée : on
      // garde leur somme, en bornant seulement les valeurs aberrantes.
      const unit = event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 800 : 1
      const factor = Math.exp(THREE.MathUtils.clamp(event.deltaY * unit, -600, 600) * 0.0022)
      target.current = THREE.MathUtils.clamp(target.current * factor, MIN_CAMERA_DISTANCE, MAX_CAMERA_DISTANCE)
      const rect = gl.domElement.getBoundingClientRect()
      cursor.current.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [camera, gl, busy])

  const before = useMemo(() => new THREE.Vector3(), [])
  const after = useMemo(() => new THREE.Vector3(), [])
  const turn = useMemo(() => new THREE.Quaternion(), [])
  const hitUnderCursor = (out: THREE.Vector3) => {
    raycaster.setFromCamera(cursor.current, camera)
    return raycaster.ray.intersectSphere(sphere, out) !== null
  }
  useFrame(() => {
    if (busy.current) {
      // Animation de caméra en cours : les crans déjà reçus ne la contrarient pas.
      lastWheel.current = 0
      return
    }
    if (performance.now() - lastWheel.current > 600) return
    const distance = camera.position.length()
    const nextDistance = distance + (target.current - distance) * 0.18
    orientCamera(camera)
    const anchored = hitUnderCursor(before)
    camera.position.setLength(nextDistance)
    orientCamera(camera)
    if (anchored && hitUnderCursor(after)) {
      turn.setFromUnitVectors(after.normalize(), before.normalize())
      camera.position.applyQuaternion(turn)
      clampToPolarLimits(camera.position)
      orientCamera(camera)
    }
  })
  return null
}

// Pins : chaque pin (élément HTML de WorldMap) est placé à la projection écran de
// sa position sur la sphère, et masqué quand il passe sur la face cachée.
function PinProjector({
  pins,
  elements,
  busy,
  focusPin,
}: {
  pins: GlobePin[]
  elements: React.MutableRefObject<Map<string, HTMLDivElement>>
  busy: React.MutableRefObject<boolean>
  focusPin: React.MutableRefObject<THREE.Vector3 | null>
}) {
  const { camera, size } = useThree()
  const points = useMemo(() => pins.map(pin => ({ key: pin.key, normal: latLngToVector(pin.lat, pin.lng).normalize() })), [pins])
  const projected = useMemo(() => new THREE.Vector3(), [])
  const toCamera = useMemo(() => new THREE.Vector3(), [])
  useFrame(() => {
    const distance = camera.position.length()
    toCamera.copy(camera.position).normalize()
    const horizon = 1 / distance + 0.04
    for (const point of points) {
      const element = elements.current.get(point.key)
      if (!element) continue
      const facing = point.normal.dot(toCamera)
      // Plongée en cours : les autres pins ne défilent pas à l'écran.
      const focus = focusPin.current
      const hiddenByDive = busy.current && (!focus || point.normal.dot(focus) < 0.99999)
      if (facing < horizon || hiddenByDive) {
        element.style.visibility = 'hidden'
        continue
      }
      projected.copy(point.normal).multiplyScalar(1.005).project(camera)
      const x = ((projected.x + 1) / 2) * size.width
      const y = ((1 - projected.y) / 2) * size.height
      element.style.visibility = 'visible'
      element.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`
      element.style.zIndex = String(Math.round(facing * 1000))
    }
  })
  return null
}

export default function EarthGlobe({
  focusLat,
  focusLng,
  offsetLeft = 0,
  active = true,
  pins = [],
  pinElements,
  flyTo = null,
  returnTo = null,
  onDiveComplete = () => {},
  onZoomThrough = () => {},
  onZoomThroughComplete = () => {},
  zoomThroughDistance = 1.9,
}: {
  focusLat: number | null
  focusLng: number | null
  offsetLeft?: number
  active?: boolean
  pins?: GlobePin[]
  pinElements?: React.MutableRefObject<Map<string, HTMLDivElement>>
  flyTo?: GlobeCameraRequest | null
  returnTo?: GlobeCameraRequest | null
  onDiveComplete?: (lat: number, lng: number, distance: number) => void
  onZoomThrough?: (lat: number, lng: number, distance: number) => void
  onZoomThroughComplete?: (lat: number, lng: number, distance: number) => void
  zoomThroughDistance?: number
}) {
  const controlsRef = useRef<ControlsLike | null>(null)
  const bank = useRef<CloudBankState | null>(null)
  const busy = useRef(false)
  const focusPin = useRef<THREE.Vector3 | null>(null)
  return (
    <Canvas
      className="earth-globe-canvas"
      dpr={[1, 1.5]}
      frameloop={active ? 'always' : 'never'}
      camera={{ fov: 32, near: 0.1, far: 200, position: [0, 0, WORLD_DISTANCE] }}
      gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.05 }}
    >
      <CenterInFreeSpace offsetLeft={offsetLeft} />
      <Earth focusLat={focusLat} focusLng={focusLng} />
      <SunGlow />
      <CameraRig
        flyTo={flyTo}
        returnTo={returnTo}
        zoomThroughDistance={zoomThroughDistance}
        onDiveComplete={onDiveComplete}
        onZoomThrough={onZoomThrough}
        onZoomThroughComplete={onZoomThroughComplete}
        controlsRef={controlsRef}
        bank={bank}
        busy={busy}
        focusPin={focusPin}
      />
      <CloudBank bank={bank} />
      <GrabRotate controlsRef={controlsRef} />
      <WheelZoom busy={busy} />
      {pinElements && <PinProjector pins={pins} elements={pinElements} busy={busy} focusPin={focusPin} />}
      <OrbitControls
        ref={controlsRef as never}
        enablePan={false}
        enableRotate={false}
        enableZoom={false}
        enableDamping
        dampingFactor={0.08}
        rotateSpeed={0.45}
        minDistance={MIN_CAMERA_DISTANCE}
        maxDistance={MAX_CAMERA_DISTANCE}
        minPolarAngle={MIN_POLAR}
        maxPolarAngle={Math.PI - MIN_POLAR}
        autoRotate
        autoRotateSpeed={0.05}
      />
    </Canvas>
  )
}
