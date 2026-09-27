import { Matrix4, Quaternion, Vector3 } from 'three'

export const DEG = Math.PI / 180
export const RAD = 180 / Math.PI

export function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value
}

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

export function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

export function isFiniteVector(v: Vector3) {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
}

export function isFiniteQuaternion(q: Quaternion) {
  return Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w)
}

/** Component of `v` orthogonal to unit vector `axis`. Returns a new vector. */
export function rejectFrom(v: Vector3, axis: Vector3) {
  return v.clone().addScaledVector(axis, -v.dot(axis))
}

/**
 * Signed angle that rotates `from` onto `to` about `axis` (right-hand rule),
 * after projecting both onto the plane orthogonal to `axis`.
 */
export function signedAngleAbout(from: Vector3, to: Vector3, axis: Vector3) {
  const a = rejectFrom(from, axis)
  const b = rejectFrom(to, axis)
  if (a.lengthSq() < 1e-12 || b.lengthSq() < 1e-12) return 0
  const cross = new Vector3().crossVectors(a, b)
  return Math.atan2(cross.dot(axis), a.dot(b))
}

/** Right-handed orthonormal basis quaternion from a primary and secondary axis. */
export function basisFromAxes(primaryY: Vector3, secondaryZ: Vector3) {
  const y = primaryY.clone().normalize()
  const x = new Vector3().crossVectors(y, secondaryZ).normalize()
  const z = new Vector3().crossVectors(x, y).normalize()
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z))
}

/** Rotation mapping orthonormal frame A (columns a0,a1,a2) onto frame B. */
export function frameDelta(a: [Vector3, Vector3, Vector3], b: [Vector3, Vector3, Vector3]) {
  const ma = new Matrix4().makeBasis(a[0], a[1], a[2])
  const mb = new Matrix4().makeBasis(b[0], b[1], b[2])
  const qa = new Quaternion().setFromRotationMatrix(ma)
  const qb = new Quaternion().setFromRotationMatrix(mb)
  return qb.multiply(qa.invert()).normalize()
}

/** Keep `q` in the same 4D hemisphere as `reference` (q and -q are the same rotation). */
export function alignHemisphere(q: Quaternion, reference: Quaternion) {
  if (q.dot(reference) < 0) q.set(-q.x, -q.y, -q.z, -q.w)
  return q
}

/**
 * Swing-twist decomposition: q = swing * twist, where twist is a rotation about
 * unit `axis`. Returns the signed twist angle (radians) and the swing quaternion.
 */
export function swingTwist(q: Quaternion, axis: Vector3) {
  const projection = axis.x * q.x + axis.y * q.y + axis.z * q.z
  const twist = new Quaternion(axis.x * projection, axis.y * projection, axis.z * projection, q.w)
  if (twist.lengthSq() < 1e-12) {
    // 180 degree swing: twist is undefined; treat as zero twist.
    return { swing: q.clone(), twist: new Quaternion(), twistAngle: 0 }
  }
  twist.normalize()
  if (twist.w < 0) twist.set(-twist.x, -twist.y, -twist.z, -twist.w)
  const sign = twist.x * axis.x + twist.y * axis.y + twist.z * axis.z >= 0 ? 1 : -1
  const twistAngle = 2 * Math.acos(clamp(twist.w, -1, 1)) * sign
  const swing = q.clone().multiply(twist.clone().invert())
  return { swing, twist, twistAngle }
}

/** Angle of a unit quaternion's rotation in radians, [0, pi]. */
export function quaternionAngle(q: Quaternion) {
  return 2 * Math.acos(clamp(Math.abs(q.w), 0, 1))
}

export function angleBetweenQuaternions(a: Quaternion, b: Quaternion) {
  return 2 * Math.acos(clamp(Math.abs(a.dot(b)), 0, 1))
}

export function axisAngle(axis: Vector3, angle: number) {
  return new Quaternion().setFromAxisAngle(axis, angle)
}

export function roundTo(value: number, decimals: number) {
  const f = 10 ** decimals
  return Math.round(value * f) / f
}
