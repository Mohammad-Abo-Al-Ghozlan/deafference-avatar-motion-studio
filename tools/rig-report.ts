/**
 * Programmatic rig report for the supplied GLB.
 *
 *   npm run rig:report [-- --glb public/models/deafference-avatar.glb --out motion/rig-report.json]
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { loadGltfRig } from './lib/gltfRig'
import { parseArgs, repoPath } from './lib/cli'
import { claudiaProfile, FINGERS, LONG_FINGERS, SIDES, validateSemanticSkeleton } from '../src/motion/rig/semanticMap'
import { buildRigGeometry, describeAngle } from '../src/motion/rig/rigGeometry'
import { RAD } from '../src/motion/math'

const args = parseArgs(process.argv.slice(2), {
  glb: 'public/models/deafference-avatar.glb',
  out: 'motion/rig-report.json',
  md: 'motion/rig-report.md'
})

const r3 = (v: Vector3 | number[], d = 5) => (Array.isArray(v) ? v : v.toArray()).map((x) => Math.round(x * 10 ** d) / 10 ** d)
const r4 = (q: Quaternion, d = 6) => q.toArray().map((x) => Math.round(x * 10 ** d) / 10 ** d)

async function main() {
  const glbPath = repoPath(args.glb)
  const { document, rig, jointNames } = await loadGltfRig(glbPath)
  const root = document.getRoot()
  const skins = root.listSkins()
  const meshes = root.listMeshes()

  // Skin influence per joint.
  const influence = new Map<string, { vertices: number; maxWeight: number }>()
  const meshInfo = meshes.map((mesh) => ({
    name: mesh.getName(),
    primitives: mesh.listPrimitives().map((primitive) => {
      const position = primitive.getAttribute('POSITION')
      const joints = primitive.getAttribute('JOINTS_0')
      const weights = primitive.getAttribute('WEIGHTS_0')
      if (joints && weights && skins[0]) {
        const names = skins[0].listJoints().map((joint) => joint.getName())
        const j = [0, 0, 0, 0]
        const w = [0, 0, 0, 0]
        for (let i = 0; i < joints.getCount(); i += 1) {
          joints.getElement(i, j)
          weights.getElement(i, w)
          for (let k = 0; k < 4; k += 1) {
            if (w[k] <= 0.01) continue
            const entry = influence.get(names[j[k]]) ?? { vertices: 0, maxWeight: 0 }
            entry.vertices += 1
            entry.maxWeight = Math.max(entry.maxWeight, w[k])
            influence.set(names[j[k]], entry)
          }
        }
      }
      return {
        attributes: primitive.listSemantics(),
        vertexCount: position?.getCount() ?? 0,
        indexCount: primitive.getIndices()?.getCount() ?? 0,
        morphTargets: primitive.listTargets().length,
        material: primitive.getMaterial()?.getName() ?? null
      }
    })
  }))

  const map = claudiaProfile()
  const validation = validateSemanticSkeleton(rig, map)
  if (!validation.ok) {
    console.error(validation.issues)
    throw new Error('Semantic skeleton validation failed; refusing to write a misleading report')
  }
  const geometry = buildRigGeometry(rig, map, validation.facing, validation.characterLeft)

  const bones = rig.joints
    .filter((joint) => joint.isJoint)
    .map((joint) => {
      const children = joint.children.map((index) => rig.joints[index])
      const firstChild = children.find((child) => child.isJoint)
      const length = firstChild ? firstChild.restLocalPosition.length() : 0
      const childDirectionWorld = firstChild
        ? firstChild.restWorldPosition.clone().sub(joint.restWorldPosition).normalize()
        : null
      const childDirectionLocal = firstChild ? firstChild.restLocalPosition.clone().normalize() : null
      return {
        name: joint.name,
        parent: joint.parent >= 0 ? rig.joints[joint.parent].name : null,
        children: children.map((child) => child.name),
        restLocalPosition: r3(joint.restLocalPosition),
        restLocalQuaternion: r4(joint.restLocalQuaternion),
        restLocalScale: r3(joint.restLocalScale),
        restWorldPosition: r3(joint.restWorldPosition),
        restWorldQuaternion: r4(joint.restWorldQuaternion),
        length: Math.round(length * 1e5) / 1e5,
        childDirectionWorld: childDirectionWorld ? r3(childDirectionWorld, 4) : null,
        childDirectionLocal: childDirectionLocal ? r3(childDirectionLocal, 4) : null,
        skinInfluence: influence.get(joint.name) ?? { vertices: 0, maxWeight: 0 }
      }
    })

  // Inverse bind matrix consistency: IBM * restWorld(joint) should be identity
  // up to the skinned mesh node transform.
  const ibmCheck = skins.map((skin) => {
    const ibm = skin.getInverseBindMatrices()
    const joints = skin.listJoints()
    let maxError = 0
    const element = new Array<number>(16).fill(0)
    joints.forEach((joint, index) => {
      if (!ibm) return
      ibm.getElement(index, element)
      const product = new Matrix4().fromArray(element).premultiply(rig.get(joint.getName()).restWorldMatrix)
      const identity = new Matrix4()
      for (let k = 0; k < 16; k += 1) maxError = Math.max(maxError, Math.abs(product.elements[k] - identity.elements[k]))
    })
    return { skin: skin.getName(), joints: joints.length, restPoseIsBindPose: maxError < 1e-3, maxAbsError: maxError }
  })

  const hands = Object.fromEntries(SIDES.map((side) => {
    const hand = geometry.hands[side]
    const deg = (v: number) => describeAngle(v)
    return [side, {
      palm: {
        forward: r3(hand.palm.forward, 4),
        radial: r3(hand.palm.radial, 4),
        volar: r3(hand.palm.volar, 4),
        palmLengthM: Math.round(hand.palmLength * 1e5) / 1e5
      },
      fingers: Object.fromEntries(LONG_FINGERS.map((finger) => {
        const f = hand.fingers[finger]
        return [finger, {
          bones: [f.mcp.bone, f.pip.bone, f.dip.bone],
          lengthsM: f.lengths.map((v) => Math.round(v * 1e5) / 1e5),
          restMcpFlexionDeg: deg(f.mcp.restFlexion),
          restMcpAbductionDeg: deg(f.mcp.restAbduction),
          restPipDeg: deg(f.pip.restAngle),
          restDipDeg: deg(f.dip.restAngle),
          mcpFlexAxisHandLocal: r3(f.mcp.flexAxisParent, 4),
          mcpAbductionAxisHandLocal: r3(f.mcp.abductionAxisParent, 4),
          pipHingeAxisParentLocal: r3(f.pip.axisParent, 4),
          dipHingeAxisParentLocal: r3(f.dip.axisParent, 4)
        }]
      })),
      thumb: {
        bones: [hand.thumb.cmc.bone, hand.thumb.mcp.bone, hand.thumb.ip.bone],
        lengthsM: hand.thumb.lengths.map((v) => Math.round(v * 1e5) / 1e5),
        restCmcPalmarElevationDeg: deg(hand.thumb.cmc.restFlexion),
        restCmcRadialAzimuthDeg: deg(hand.thumb.cmc.restAbduction),
        restMcpDeg: deg(hand.thumb.mcp.restAngle),
        restIpDeg: deg(hand.thumb.ip.restAngle),
        cmcAxialAxisHandLocal: r3(hand.thumb.cmc.axialAxisParent, 4),
        mcpHingeAxisParentLocal: r3(hand.thumb.mcp.axisParent, 4),
        ipHingeAxisParentLocal: r3(hand.thumb.ip.axisParent, 4)
      }
    }]
  }))

  const arms = Object.fromEntries(SIDES.map((side) => {
    const arm = geometry.arms[side]
    return [side, {
      chain: [arm.clavicle, arm.upperArm, arm.forearm, arm.hand],
      twistBones: { upperArm: arm.upperArmTwist ?? null, forearm: arm.forearmTwist ?? null },
      upperLengthM: Math.round(arm.upperLength * 1e5) / 1e5,
      forearmLengthM: Math.round(arm.forearmLength * 1e5) / 1e5,
      restElbowFlexionDeg: describeAngle(arm.restElbowFlexion),
      elbowAxisUpperLocal: r3(arm.elbowAxisUpper, 4),
      upperAxisLocal: r3(arm.upperAxisLocal, 4),
      forearmAxisLocal: r3(arm.forearmAxisLocal, 4)
    }]
  }))

  const report = {
    schema: 'deafference.rig-report',
    schemaVersion: 1,
    source: args.glb,
    generator: 'tools/rig-report.ts',
    summary: {
      nodes: rig.joints.length - 1,
      joints: jointNames.size,
      skins: skins.map((skin) => ({ name: skin.getName(), joints: skin.listJoints().length })),
      meshes: meshInfo,
      morphTargets: meshInfo.reduce((sum, mesh) => sum + mesh.primitives.reduce((s, p) => s + p.morphTargets, 0), 0),
      animations: root.listAnimations().map((animation) => animation.getName()),
      materials: root.listMaterials().map((material) => material.getName()),
      textures: root.listTextures().map((texture) => ({ name: texture.getName(), mimeType: texture.getMimeType(), bytes: texture.getImage()?.byteLength ?? 0 })),
      bindPose: ibmCheck,
      facing: r3(validation.facing, 4),
      characterLeft: r3(validation.characterLeft, 4),
      axisConvention: 'Every bone points along its local +Y toward its child (Blender export); verified per bone in childDirectionLocal.'
    },
    semanticMapping: {
      profile: map.profile,
      validation: validation.issues.length ? validation.issues : 'all structural checks passed',
      mapping: map
    },
    anatomy: { hands, arms, torso: {
      shoulderWidthM: Math.round(geometry.torso.shoulderWidth * 1e5) / 1e5,
      chestProxy: { center: r3(geometry.torso.chest.center, 4), radii: r3(geometry.torso.chest.radii, 4) },
      headProxy: { center: r3(geometry.torso.head3.center, 4), radii: r3(geometry.torso.head3.radii, 4) }
    } },
    bones
  }

  const outPath = repoPath(args.out)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(report, null, 2))

  const yAxisOk = bones.filter((bone) => bone.childDirectionLocal).every((bone) => {
    const [x, y, z] = bone.childDirectionLocal as number[]
    return y > 0.99
  })
  const md: string[] = []
  md.push('# Rig report — supplied Deafference GLB', '')
  md.push(`Generated by \`tools/rig-report.ts\` from \`${args.glb}\`. Full data: \`${args.out}\`.`, '')
  md.push('| Property | Value |', '|---|---|')
  md.push(`| Nodes / joints | ${report.summary.nodes} / ${report.summary.joints} |`)
  md.push(`| Skinned meshes | ${meshInfo.map((m) => `${m.name} (${m.primitives.map((p) => `${p.vertexCount} verts`).join(', ')})`).join('; ')} |`)
  md.push(`| Morph targets | ${report.summary.morphTargets} (face is bone-driven) |`)
  md.push(`| Animation clips | ${report.summary.animations.length} |`)
  md.push(`| Rest pose == bind pose | ${ibmCheck.map((c) => `${c.restPoseIsBindPose} (max err ${c.maxAbsError.toExponential(2)})`).join(', ')} |`)
  md.push(`| Facing / character-left | ${report.summary.facing.join(', ')} / ${report.summary.characterLeft.join(', ')} |`)
  md.push(`| Bone axis convention | local +Y points to child for every bone: ${yAxisOk} |`)
  md.push(`| Semantic validation | ${typeof report.semanticMapping.validation === 'string' ? report.semanticMapping.validation : JSON.stringify(report.semanticMapping.validation)} |`, '')
  md.push('## Hierarchy (deforming joints: vertex count)', '', '```')
  const printTree = (index: number, depth: number) => {
    const joint = rig.joints[index]
    if (joint.isJoint) {
      const info = influence.get(joint.name)
      md.push(`${'  '.repeat(depth)}${joint.name}${info ? `  [${info.vertices} v]` : '  [no weights]'}`)
    }
    joint.children.forEach((child) => printTree(child, joint.isJoint ? depth + 1 : depth))
  }
  printTree(0, 0)
  md.push('```', '')
  md.push('## Hands (rest pose, degrees)', '')
  for (const side of SIDES) {
    md.push(`### ${side}`, '', '| Digit | Lengths (cm) | MCP/CMC flex | MCP/CMC abd | PIP/MCP | DIP/IP |', '|---|---|---|---|---|---|')
    for (const finger of FINGERS) {
      if (finger === 'thumb') {
        const t = hands[side].thumb
        md.push(`| thumb | ${t.lengthsM.map((v: number) => (v * 100).toFixed(2)).join(' / ')} | ${t.restCmcPalmarElevationDeg} | ${t.restCmcRadialAzimuthDeg} | ${t.restMcpDeg} | ${t.restIpDeg} |`)
      } else {
        const f = hands[side].fingers[finger]
        md.push(`| ${finger} | ${f.lengthsM.map((v: number) => (v * 100).toFixed(2)).join(' / ')} | ${f.restMcpFlexionDeg} | ${f.restMcpAbductionDeg} | ${f.restPipDeg} | ${f.restDipDeg} |`)
      }
    }
    md.push('')
  }
  md.push('## Arms', '', '| Side | Upper (cm) | Forearm (cm) | Rest elbow flexion | Twist bones |', '|---|---|---|---|---|')
  for (const side of SIDES) {
    const a = arms[side]
    md.push(`| ${side} | ${(a.upperLengthM * 100).toFixed(1)} | ${(a.forearmLengthM * 100).toFixed(1)} | ${a.restElbowFlexionDeg} | ${a.twistBones.upperArm}, ${a.twistBones.forearm} |`)
  }
  md.push('', `Torso shoulder width: ${(geometry.torso.shoulderWidth * 100).toFixed(1)} cm.`, '')
  writeFileSync(repoPath(args.md), md.join('\n'))
  console.log(`rig report: ${bones.length} joints, validation ok, axis convention +Y: ${yAxisOk}`)
  console.log(`wrote ${args.out} and ${args.md}`)
  void RAD
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
