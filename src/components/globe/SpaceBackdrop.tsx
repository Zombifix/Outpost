import { useEffect, useRef } from 'react'

// Fond spatial de la vue 3D, entièrement généré par un shader (aucune image) :
// Voie lactée en diagonale (cœur chaud en bas à gauche, bandes de poussière
// sombres), nébuleuses bleues, violettes et cyan, champ d'étoiles sur plusieurs
// plans, plus dense dans la bande, avec quelques étoiles brillantes au halo
// discret. Calculé une seule fois, à la résolution de l'écran (net partout),
// puis redessiné seulement si la taille change : aucun coût par image.

const vertexSource = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`

const fragmentSource = `
precision highp float;
uniform vec2 uResolution;
uniform float uPixelRatio;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
const mat2 TURN = mat2(0.8, -0.6, 0.6, 0.8);
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 7; i++) {
    v += a * noise(p);
    p = TURN * p * 2.02 + 17.3;
    a *= 0.5;
  }
  return v;
}
vec3 starTint(float h) {
  vec3 cool = vec3(0.72, 0.82, 1.0);
  vec3 white = vec3(1.0, 0.98, 0.95);
  vec3 warm = vec3(1.0, 0.82, 0.6);
  return h < 0.45 ? mix(cool, white, h / 0.45) : mix(white, warm, (h - 0.45) / 0.55);
}

// Un plan d'étoiles : au plus une étoile par cellule, position, éclat, taille et
// couleur aléatoires. Tailles en pixels CSS (multipliées par la densité d'écran).
vec3 starLayer(vec2 frag, float cell, float threshold, float sizeMin, float sizeMax, float gain, float glow) {
  float px = uPixelRatio;
  vec2 c = floor(frag / (cell * px));
  vec3 acc = vec3(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 cc = c + vec2(float(i), float(j));
      float h = hash12(cc * 1.37 + cell);
      if (h < threshold) continue;
      float m = (h - threshold) / (1.0 - threshold);
      vec2 pos = (cc + 0.15 + 0.7 * hash22(cc + cell)) * cell * px;
      vec2 d = frag - pos;
      float dist = length(d) / px;
      float size = mix(sizeMin, sizeMax, m * m);
      float core = exp(-dist * dist / (size * size));
      float halo = glow * m * m * exp(-dist / (size * 3.5)) * 0.35;
      // Rares étoiles très brillantes : deux fines aigrettes, courtes et pâles.
      float spikes = 0.0;
      if (glow > 0.0 && m > 0.93) {
        vec2 a = abs(d) / px;
        spikes = (exp(-a.y / 0.5) * exp(-a.x / (size * 9.0)) + exp(-a.x / 0.5) * exp(-a.y / (size * 9.0))) * 0.22 * (m - 0.93) / 0.07;
      }
      acc += starTint(hash12(cc + 91.7)) * (core + halo + spikes) * (0.25 + 0.75 * m) * gain;
    }
  }
  return acc;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);

  // Bande de la Voie lactée : du bas à gauche au haut à droite, en passant
  // derrière la Terre, légèrement ondulée.
  vec2 dir = normalize(vec2(aspect, 0.72));
  vec2 rel = p - vec2(0.0, -0.02);
  float along = dot(rel, dir);
  float across = dot(rel, vec2(-dir.y, dir.x));
  across += 0.07 * (fbm(vec2(along * 1.1, 4.7)) - 0.5);
  // Plus large et plus lumineuse côté bas gauche (vers le centre galactique).
  float side = smoothstep(0.9, -0.9, along);
  float width = 0.1 + 0.07 * side;
  float envelope = exp(-pow(across / (width * 1.25), 2.0));
  float ribbon = exp(-pow(across / (width * 0.45), 2.0));

  // Matière : champs déformés par eux-mêmes (volutes), à deux échelles.
  vec2 q = p * 2.4;
  vec2 w = vec2(fbm(q + 1.7), fbm(q + vec2(8.3, 2.8)));
  vec2 w2 = vec2(fbm(q * 2.0 + 3.0 * w + 4.1), fbm(q * 2.0 + 3.0 * w + 9.4));
  float billows = fbm(q * 1.4 + 2.6 * w);
  float fine = fbm(p * 14.0 + 2.0 * w2);

  // Nuages de la nébuleuse : bords nets (seuil), cœur lumineux, voile autour.
  float cloudField = billows * 0.75 + fine * 0.35;
  float nebula = smoothstep(0.42, 0.78, cloudField) * envelope;
  float haze = envelope * (0.25 + 0.5 * billows);
  // Nuées d'étoiles du ruban : grumeleuses, presque blanches.
  float clumps = smoothstep(0.35, 0.95, fbm(p * 7.0 + 1.5 * w2)) * ribbon;

  // Poussière : masses sombres irrégulières au cœur de la bande, avec une lueur
  // chaude sur leur bord.
  float dustField = fbm(p * vec2(5.5, 3.2) + 2.2 * w2 + 3.0);
  float dust = smoothstep(0.5, 0.68, dustField) * ribbon;
  float rim = (smoothstep(0.42, 0.5, dustField) - smoothstep(0.5, 0.6, dustField)) * ribbon;

  // Fond : bleu nuit profond, avec un voile bleuté très léger.
  vec3 col = mix(vec3(0.008, 0.016, 0.045), vec3(0.012, 0.024, 0.062), uv.y);
  col += vec3(0.025, 0.05, 0.13) * smoothstep(0.35, 0.8, fbm(p * 1.2 + 11.0)) * 0.7;

  vec3 royal = vec3(0.07, 0.27, 1.0);
  vec3 deepViolet = vec3(0.38, 0.14, 0.78);
  vec3 magenta = vec3(0.72, 0.22, 0.7);
  vec3 cyan = vec3(0.42, 0.8, 1.0);
  vec3 cream = vec3(1.0, 0.96, 0.9);
  vec3 amber = vec3(1.0, 0.58, 0.24);

  // Teinte : bleu roi au cœur, violet sur les bords et par endroits.
  vec3 tint = mix(royal, deepViolet, clamp(smoothstep(0.45, 0.8, w.x) * 0.5 + (1.0 - envelope) * 0.35, 0.0, 1.0));
  // Quelques reflets magenta dans les volutes, discrets.
  tint = mix(tint, magenta, smoothstep(0.62, 0.85, w2.x) * 0.45);
  col += tint * haze * 0.5;
  col += mix(tint, cyan, smoothstep(0.55, 0.95, cloudField)) * nebula * 1.15;
  col += mix(cyan, cream, 0.55) * clumps * (0.8 + 0.9 * side);
  // Cœur du ruban : lueur blanc bleuté continue sous les amas.
  col += mix(royal, cyan, 0.6) * ribbon * (0.12 + 0.18 * billows) * (0.6 + 0.6 * side);
  // Accents chauds : lueurs le long de la poussière et quelques plages ambrées,
  // surtout en bas à gauche.
  float warmPatch = smoothstep(0.5, 0.78, fbm(q * 1.2 + 6.0)) * envelope * side;
  col += amber * (rim * 0.65 + warmPatch * 0.6) * (0.3 + 0.95 * side);
  col *= 1.0 - 0.8 * dust;

  // Quelques nébuleuses lointaines hors de la bande (haut droite, bas droite).
  float far = smoothstep(0.55, 0.85, fbm(p * 1.7 + vec2(4.0, 9.0) + 1.4 * w));
  col += mix(royal, deepViolet, w.y) * far * (1.0 - envelope) * 0.12 * (0.5 + fine);

  // Étoiles : fines et peu nombreuses hors de la bande, amas denses dedans.
  float crowd = clamp(envelope * 0.8 + clumps * 1.5, 0.0, 1.0);
  col += starLayer(frag, 4.0, 0.93 - 0.35 * crowd, 0.4, 0.75, 0.6, 0.0) * (0.35 + 0.9 * crowd);
  col += starLayer(frag, 13.0, 0.8 - 0.2 * crowd, 0.55, 1.2, 1.0, 0.0);
  col += starLayer(frag, 52.0, 0.74, 0.85, 1.9, 1.45, 1.0);

  // Plus calme derrière les panneaux (colonne de gauche, en haut) et le titre.
  float panels = smoothstep(0.24, 0.16, uv.x) * smoothstep(0.2, 0.32, uv.y);
  float title = smoothstep(0.42, 0.3, uv.x) * smoothstep(0.84, 0.94, uv.y);
  col *= 1.0 - 0.3 * max(panels, title);

  // Vignette douce et compression des hautes lumières (aucun bloom).
  float vig = 1.0 - 0.35 * smoothstep(0.55, 1.2, length(p / vec2(aspect * 0.62, 0.62)));
  col *= vig;
  col = col / (1.0 + col * 0.45);
  col += (hash12(frag) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('SpaceBackdrop shader:', gl.getShaderInfoLog(shader))
    return null
  }
  return shader
}

export default function SpaceBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: true, alpha: false })
    if (!gl) return
    const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource)
    const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
    if (!vertex || !fragment) return
    const program = gl.createProgram()
    if (!program) return
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    gl.useProgram(program)
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'position')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    const resolution = gl.getUniformLocation(program, 'uResolution')
    const pixelRatio = gl.getUniformLocation(program, 'uPixelRatio')

    const draw = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio))
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio))
      if (canvas.width === width && canvas.height === height) return
      canvas.width = width
      canvas.height = height
      gl.viewport(0, 0, width, height)
      gl.uniform2f(resolution, width, height)
      gl.uniform1f(pixelRatio, ratio)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    draw()
    let timeout = 0
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timeout)
      timeout = window.setTimeout(draw, 150)
    })
    observer.observe(canvas)
    return () => {
      observer.disconnect()
      window.clearTimeout(timeout)
      gl.deleteProgram(program)
      gl.deleteBuffer(buffer)
    }
  }, [])

  return <canvas ref={canvasRef} className="space-backdrop" aria-hidden="true" />
}
