/**
 * Deterministic, frame-stepped renderer used to produce visual evidence.
 * Served by the Vite dev server (never part of the production build):
 *   /tools/evidence/harness.html?mode=clip&clip=/motion/qassem-story/avatar-motion.json.gz
 *   /tools/evidence/harness.html?mode=legacy&raw=/motion/qassem-story/raw-landmarks.json.gz
 * Playwright drives it through window.harness (see tools/evidence/record.ts).
 */
import {
  ACESFilmicToneMapping, AmbientLight, Box3, Color, DirectionalLight, HemisphereLight, Mesh, type Object3D,
  PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MotionClip } from '../../src/motion/clip/MotionClip'
import { AvatarRetargeter as LegacyRetargeter } from './legacy/AvatarRetargeter.legacy'
import type { Landmark, TrackingFrame } from '../../src/types/tracking'

type View = 'full' | 'right' | 'left' | 'hands'

const params = new URLSearchParams(location.search)
const mode = (params.get('mode') ?? 'clip') as 'clip' | 'legacy' | 'rest'
const width = Number(params.get('width') ?? 640)
const height = Number(params.get('height') ?? 640)
const fps = Number(params.get('fps') ?? 30)
let view = (params.get('view') ?? 'full') as View

async function fetchJson(url: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    return JSON.parse(await new Response(stream).text())
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

function unpack(flat: number[] | null, stride: number): Landmark[] | undefined {
  if (!flat) return undefined
  const out: Landmark[] = []
  for (let i = 0; i < flat.length; i += stride) out.push({ x: flat[i], y: flat[i + 1], z: flat[i + 2], visibility: stride >= 4 ? flat[i + 3] : undefined })
  return out
}

async function main() {
  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(1)
  renderer.setSize(width, height, false)
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.03
  document.body.appendChild(renderer.domElement)

  const scene = new Scene()
  scene.background = new Color('#11191d')
  scene.add(new HemisphereLight('#effaff', '#172126', 2.6))
  const key = new DirectionalLight('#fff9ef', 4.1)
  key.position.set(-2.8, 4.4, 3.6)
  scene.add(key)
  const rim = new DirectionalLight('#72d9ff', 2.2)
  rim.position.set(3.2, 2.5, -2.5)
  scene.add(rim)
  scene.add(new AmbientLight('#a5c0ca', 0.9))

  const gltf = await new GLTFLoader().loadAsync('/models/deafference-avatar.glb')
  const avatar = gltf.scene
  avatar.traverse((node) => { if ((node as Mesh).isMesh) (node as Mesh).frustumCulled = false })
  // Same placement as the app (AvatarStage.vue): centred, feet on the floor.
  const bounds = new Box3().setFromObject(avatar)
  const center = bounds.getCenter(new Vector3())
  avatar.position.set(-center.x, -bounds.min.y, -center.z)
  avatar.updateMatrixWorld(true)
  scene.add(avatar)
  const camera = new PerspectiveCamera(28, width / height, 0.01, 50)

  const nodes = new Map<string, Object3D>()
  avatar.traverse((node) => { if (node.name) nodes.set(node.name, node) })
  const worldOf = (name: string) => nodes.get(name)!.getWorldPosition(new Vector3())

  let frameCount = 0
  let apply: (k: number) => void = () => {}
  if (mode === 'clip') {
    const clip = await MotionClip.load(params.get('clip')!)
    const binding = clip.bind(avatar)
    frameCount = clip.file.frameCount
    apply = (k) => clip.applyTo(binding, k / clip.file.fps)
  } else if (mode === 'legacy') {
    // Faithful replay of the ORIGINAL solver: update() per tracker result,
    // tick() at 60 Hz render rate, timestamps on the source timeline.
    const raw = await fetchJson(params.get('raw')!)
    const legacy = new LegacyRetargeter(avatar)
    legacy.setSmoothing(Number(params.get('smoothing') ?? 15))
    legacy.setStrength(1)
    const bySlot = new Map<number, TrackingFrame>()
    for (const frame of raw.frames) {
      const k = Math.round(frame.t * fps)
      if (bySlot.has(k)) continue
      bySlot.set(k, {
        poseLandmarks: unpack(frame.pose, 5),
        leftHandLandmarks: unpack(frame.leftHand, 3),
        rightHandLandmarks: unpack(frame.rightHand, 3),
        faceLandmarks: expandFace(frame.face, raw.layout.faceIndices),
        timestamp: frame.t * 1000
      })
    }
    frameCount = Math.round(raw.frames[raw.frames.length - 1].t * fps) + 1
    let lastApplied = -1
    apply = (k) => {
      // Advance the stateful legacy filters through every slot up to k.
      if (k < lastApplied) throw new Error('legacy mode renders forward only')
      for (let s = lastApplied + 1; s <= k; s += 1) {
        const frame = bySlot.get(s)
        if (frame) legacy.update(frame)
        const base = (s / fps) * 1000
        legacy.tick(1 / 60, base + 1000 / 120, true)
        legacy.tick(1 / 60, base + 1000 / 60, true)
      }
      lastApplied = k
    }
  }

  let smoothedFocus: Vector3 | null = null
  const frameCamera = () => {
    avatar.updateMatrixWorld(true)
    if (view === 'full') {
      // Source-like framing: long lens from ~3.2 m at chest height (the
      // reference video is a tight, weak-perspective head-to-chest shot).
      const target = new Vector3(0, 1.46, 0.08)
      camera.fov = 14
      camera.position.set(0, 1.44, 3.3)
      camera.lookAt(target)
    } else {
      const focus = view === 'hands'
        ? worldOf('hand_r').add(worldOf('hand_l')).multiplyScalar(0.5)
        : worldOf(view === 'right' ? 'middle_01_r' : 'middle_01_l')
      smoothedFocus = smoothedFocus ? smoothedFocus.lerp(focus, 0.35) : focus.clone()
      camera.fov = view === 'hands' ? 30 : 22
      camera.position.set(smoothedFocus.x, smoothedFocus.y + 0.03, smoothedFocus.z + (view === 'hands' ? 1.0 : 0.5))
      camera.lookAt(smoothedFocus)
    }
    camera.updateProjectionMatrix()
  }

  let lastFrame = -10
  const renderFrame = (k: number) => {
    apply(k)
    // Camera follow is smoothed only across consecutive frames (videos);
    // isolated stills are framed exactly on the hand.
    if (Math.abs(k - lastFrame) > 1) smoothedFocus = null
    lastFrame = k
    frameCamera()
    renderer.render(scene, camera)
  }

  ;(window as unknown as { harness: unknown }).harness = {
    frameCount,
    fps,
    renderFrame,
    setView: (v: View) => { view = v; smoothedFocus = null },
    capture: (quality = 0.9) => renderer.domElement.toDataURL('image/jpeg', quality),
    bonePose: (names: string[]) => names.map((name) => nodes.get(name)?.quaternion.toArray())
  }
  document.title = 'ready'
}

/** Rebuild a 478-length face array from the stored subset (legacy solver indexes the full mesh). */
function expandFace(flat: number[] | null, indices: number[]): Landmark[] | undefined {
  if (!flat) return undefined
  const out: Landmark[] = new Array(478)
  indices.forEach((meshIndex, k) => { out[meshIndex] = { x: flat[k * 3], y: flat[k * 3 + 1], z: flat[k * 3 + 2] } })
  return out
}

main().catch((error) => {
  document.title = `error: ${error instanceof Error ? error.message : String(error)}`
  console.error(error)
})
