import { Quaternion, Vector3 } from 'three'

/**
 * Head pose and restrained facial measurements from the face mesh subset.
 *
 * Head rotation: Horn's closed-form absolute orientation between a neutral
 * template of RIGID face points (forehead, nose bridge, eye corners, cheek
 * contour; never lips/jaw/brows) and the observed points. Expression
 * measurements are taken AFTER removing head rotation and scale (neutral
 * head frame, unit = inter-ocular distance), so turning the head is not read
 * as a smile or a blink.
 */

export const FACE_POINTS = {
  rigid: [6, 168, 197, 195, 5, 4, 1, 33, 133, 263, 362, 234, 454, 127, 356, 93, 323, 10, 109, 338, 67, 297, 21, 251, 54, 284, 103, 332],
  innerLipTop: 13,
  innerLipBottom: 14,
  mouthRight: 61,
  mouthLeft: 291,
  // Subject's right eye (image left) / left eye.
  rightEye: { outer: 33, inner: 133, upper: [159, 158, 160], lower: [145, 153, 144] },
  leftEye: { outer: 263, inner: 362, upper: [386, 385, 387], lower: [374, 380, 373] },
  rightBrow: [70, 63, 105, 66, 107],
  leftBrow: [300, 293, 334, 296, 336]
} as const

export interface FaceTemplate {
  zScale: number
  /** Neutral rigid-point shape: mesh index -> [x,y,z] (model axes, centred, IOD units). */
  rigid: Record<number, [number, number, number]>
}

export interface FaceMeasurements {
  /** Head rotation relative to the neutral template (model-aligned space). */
  rotation: Quaternion
  /** RMS rigid-fit residual in IOD units (quality). */
  residual: number
  /** Inter-ocular distance in pixels (face scale). */
  iodPx: number
  mouthOpen: number
  mouthWidth: number
  cornerLiftLeft: number
  cornerLiftRight: number
  eyeOpenLeft: number
  eyeOpenRight: number
  browLeft: number
  browRight: number
}

export type FacePointLookup = (meshIndex: number) => Vector3 | null

/** Horn (1987) quaternion absolute orientation for centred point sets. */
export function hornRotation(source: Vector3[], target: Vector3[], weights?: number[]): Quaternion {
  let sxx = 0, sxy = 0, sxz = 0, syx = 0, syy = 0, syz = 0, szx = 0, szy = 0, szz = 0
  for (let i = 0; i < source.length; i += 1) {
    const w = weights ? weights[i] : 1
    const a = source[i]
    const b = target[i]
    sxx += w * a.x * b.x; sxy += w * a.x * b.y; sxz += w * a.x * b.z
    syx += w * a.y * b.x; syy += w * a.y * b.y; syz += w * a.y * b.z
    szx += w * a.z * b.x; szy += w * a.z * b.y; szz += w * a.z * b.z
  }
  const n = [
    [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz]
  ]
  const { vector } = largestEigenvector4(n)
  // Horn's quaternion is (w, x, y, z).
  return new Quaternion(vector[1], vector[2], vector[3], vector[0]).normalize()
}

/** Jacobi eigen-decomposition of a symmetric 4x4 matrix; returns the top eigenvector. */
function largestEigenvector4(input: number[][]) {
  const a = input.map((row) => [...row])
  const v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
  for (let sweep = 0; sweep < 50; sweep += 1) {
    let off = 0
    for (let p = 0; p < 4; p += 1) for (let q = p + 1; q < 4; q += 1) off += a[p][q] * a[p][q]
    if (off < 1e-18) break
    for (let p = 0; p < 4; p += 1) {
      for (let q = p + 1; q < 4; q += 1) {
        if (Math.abs(a[p][q]) < 1e-20) continue
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < 4; k += 1) {
          const akp = a[k][p]
          const akq = a[k][q]
          a[k][p] = c * akp - s * akq
          a[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < 4; k += 1) {
          const apk = a[p][k]
          const aqk = a[q][k]
          a[p][k] = c * apk - s * aqk
          a[q][k] = s * apk + c * aqk
        }
        for (let k = 0; k < 4; k += 1) {
          const vkp = v[k][p]
          const vkq = v[k][q]
          v[k][p] = c * vkp - s * vkq
          v[k][q] = s * vkp + c * vkq
        }
      }
    }
  }
  let best = 0
  for (let i = 1; i < 4; i += 1) if (a[i][i] > a[best][best]) best = i
  return { value: a[best][best], vector: [v[0][best], v[1][best], v[2][best], v[3][best]] }
}

/** Centred, IOD-normalised rigid points in model-aligned axes. */
export function rigidShape(lookup: FacePointLookup): { points: Map<number, Vector3>; centroid: Vector3; iod: number } | null {
  const raw = new Map<number, Vector3>()
  for (const index of FACE_POINTS.rigid) {
    const p = lookup(index)
    if (!p) return null
    raw.set(index, p)
  }
  const centroid = new Vector3()
  raw.forEach((p) => centroid.add(p))
  centroid.divideScalar(raw.size)
  const iod = raw.get(33)!.distanceTo(raw.get(263)!)
  if (!(iod > 1e-6)) return null
  const points = new Map<number, Vector3>()
  raw.forEach((p, index) => points.set(index, p.clone().sub(centroid).divideScalar(iod)))
  return { points, centroid, iod }
}

export function measureFace(lookup: FacePointLookup, template: FaceTemplate): FaceMeasurements | null {
  const shape = rigidShape(lookup)
  if (!shape) return null
  const source: Vector3[] = []
  const target: Vector3[] = []
  for (const index of FACE_POINTS.rigid) {
    const t = template.rigid[index]
    if (!t) continue
    source.push(new Vector3(t[0], t[1], t[2]))
    target.push(shape.points.get(index)!)
  }
  const rotation = hornRotation(source, target)
  let residual = 0
  for (let i = 0; i < source.length; i += 1) residual += source[i].clone().applyQuaternion(rotation).distanceToSquared(target[i])
  residual = Math.sqrt(residual / source.length)

  // Neutral head frame: undo rotation, centre and scale.
  const inverse = rotation.clone().invert()
  const head = (index: number) => {
    const p = lookup(index)
    return p ? p.clone().sub(shape.centroid).divideScalar(shape.iod).applyQuaternion(inverse) : null
  }
  const dist = (a: number, b: number) => {
    const pa = head(a)
    const pb = head(b)
    return pa && pb ? pa.distanceTo(pb) : NaN
  }
  const meanY = (indices: readonly number[]) => {
    let sum = 0
    for (const index of indices) {
      const p = head(index)
      if (!p) return NaN
      sum += p.y
    }
    return sum / indices.length
  }
  const eyeOpen = (eye: typeof FACE_POINTS.leftEye | typeof FACE_POINTS.rightEye) => {
    let vertical = 0
    for (let k = 0; k < 3; k += 1) vertical += dist(eye.upper[k], eye.lower[k])
    return vertical / 3 / dist(eye.outer, eye.inner)
  }
  const lipMidY = (meanY([FACE_POINTS.innerLipTop]) + meanY([FACE_POINTS.innerLipBottom])) / 2

  return {
    rotation,
    residual,
    iodPx: shape.iod,
    mouthOpen: dist(FACE_POINTS.innerLipTop, FACE_POINTS.innerLipBottom),
    mouthWidth: dist(FACE_POINTS.mouthLeft, FACE_POINTS.mouthRight),
    cornerLiftLeft: meanY([FACE_POINTS.mouthLeft]) - lipMidY,
    cornerLiftRight: meanY([FACE_POINTS.mouthRight]) - lipMidY,
    eyeOpenLeft: eyeOpen(FACE_POINTS.leftEye),
    eyeOpenRight: eyeOpen(FACE_POINTS.rightEye),
    browLeft: meanY(FACE_POINTS.leftBrow) - meanY(FACE_POINTS.leftEye.upper),
    browRight: meanY(FACE_POINTS.rightBrow) - meanY(FACE_POINTS.rightEye.upper)
  }
}

/** Generalised-Procrustes neutral template from many frames of rigid points. */
export function buildFaceTemplate(shapes: Map<number, Vector3>[], zScale: number, iterations = 4): FaceTemplate {
  if (!shapes.length) throw new Error('No face shapes to build a template from')
  let reference = shapes[0]
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sums = new Map<number, Vector3[]>()
    for (const shape of shapes) {
      const source: Vector3[] = []
      const target: Vector3[] = []
      for (const index of FACE_POINTS.rigid) {
        source.push(shape.get(index)!)
        target.push(reference.get(index)!)
      }
      const rotation = hornRotation(source, target)
      for (const index of FACE_POINTS.rigid) {
        const list = sums.get(index) ?? []
        list.push(shape.get(index)!.clone().applyQuaternion(rotation))
        sums.set(index, list)
      }
    }
    const next = new Map<number, Vector3>()
    for (const index of FACE_POINTS.rigid) {
      const list = sums.get(index)!
      // Coordinate-wise median for robustness to occluded frames.
      const med = (axis: 'x' | 'y' | 'z') => {
        const values = list.map((v) => v[axis]).sort((a, b) => a - b)
        return values[values.length >> 1]
      }
      next.set(index, new Vector3(med('x'), med('y'), med('z')))
    }
    reference = next
  }
  // Remove any residual rotation so the template's frontal axes match the
  // median head pose (keeps "neutral" = typical pose of the clip).
  const rigid: FaceTemplate['rigid'] = {}
  reference.forEach((p, index) => { rigid[index] = [p.x, p.y, p.z] })
  return { zScale, rigid }
}

/** Average rotation (Markley) of unit quaternions. */
export function averageQuaternion(quaternions: Quaternion[]): Quaternion {
  const m = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]
  for (const q of quaternions) {
    const v = [q.w, q.x, q.y, q.z]
    for (let a = 0; a < 4; a += 1) for (let b = 0; b < 4; b += 1) m[a][b] += v[a] * v[b]
  }
  const { vector } = largestEigenvector4(m)
  return new Quaternion(vector[1], vector[2], vector[3], vector[0]).normalize()
}

/** Rotate a template so that the average of `rotations` becomes identity. */
export function recenterTemplate(template: FaceTemplate, rotations: Quaternion[]): FaceTemplate {
  const mean = averageQuaternion(rotations)
  const rigid: FaceTemplate['rigid'] = {}
  for (const [index, value] of Object.entries(template.rigid)) {
    const p = new Vector3(value[0], value[1], value[2]).applyQuaternion(mean)
    rigid[Number(index)] = [p.x, p.y, p.z]
  }
  return { zScale: template.zScale, rigid }
}

/** Clip- or session-level reference values for normalising expression features. */
export interface FaceFeatureBaselines {
  mouthOpen: { closed: number; open: number }
  mouthWidth: { neutral: number; wide: number; narrow: number }
  cornerLift: { neutral: number; range: number }
  eyeOpen: { left: { open: number; closed: number }; right: { open: number; closed: number } }
  brow: { left: { neutral: number; up: number; down: number }; right: { neutral: number; up: number; down: number } }
}

export type FaceFeatureValues = Pick<FaceMeasurements, 'mouthOpen' | 'mouthWidth' | 'cornerLiftLeft' | 'cornerLiftRight' | 'eyeOpenLeft' | 'eyeOpenRight' | 'browLeft' | 'browRight'>

export interface NormalizedFaceSignals {
  jawOpen: number
  smile: number
  mouthStretch: number
  blinkLeft: number
  blinkRight: number
  browLeft: number
  browRight: number
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/**
 * Map raw expression measurements to restrained, normalised signals
 * (0..1, or -1..1 for signed ones) relative to the baselines. Shared by the
 * offline cleaner (whole-clip baselines) and the live tracker (rolling ones).
 */
export function normalizeFaceSignals(v: FaceFeatureValues, b: FaceFeatureBaselines): NormalizedFaceSignals {
  const signed = (value: number, neutral: number, up: number, down: number) =>
    value >= neutral ? clamp01((value - neutral) / Math.max(1e-6, up - neutral)) : -clamp01((neutral - value) / Math.max(1e-6, neutral - down))
  const blink = (value: number, eye: { open: number; closed: number }) => clamp01((eye.open - value) / Math.max(1e-6, eye.open - eye.closed))
  const corners = ((v.cornerLiftLeft + v.cornerLiftRight) / 2 - b.cornerLift.neutral) / b.cornerLift.range
  return {
    jawOpen: clamp01((v.mouthOpen - b.mouthOpen.closed) / Math.max(1e-6, b.mouthOpen.open - b.mouthOpen.closed)),
    smile: Math.min(1, Math.max(-1, corners)),
    mouthStretch: signed(v.mouthWidth, b.mouthWidth.neutral, b.mouthWidth.wide, b.mouthWidth.narrow),
    blinkLeft: blink(v.eyeOpenLeft, b.eyeOpen.left),
    blinkRight: blink(v.eyeOpenRight, b.eyeOpen.right),
    browLeft: signed(v.browLeft, b.brow.left.neutral, b.brow.left.up, b.brow.left.down),
    browRight: signed(v.browRight, b.brow.right.neutral, b.brow.right.up, b.brow.right.down)
  }
}
