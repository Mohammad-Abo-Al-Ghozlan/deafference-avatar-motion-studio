/**
 * End-to-end smoke test of the BUILT app in a real (headless) browser.
 *
 *   npm run build && npm run e2e -- --video-override <vp9.webm> --camera <clip.y4m>
 *
 * Checks, against the production bundle served by `vite preview`:
 *   1. the page, avatar and precomputed motion load without errors;
 *   2. OFFLINE engine: the avatar pose equals the motion file sampled at the
 *      media time of the presented video frame (lockstep sync), at several
 *      seek positions, and advances during playback;
 *   3. LIVE engine on the sample clip: in-browser Holistic runs, metric world
 *      landmarks are received, the causal solver drives the avatar;
 *   4. CAMERA mode with a fake camera device streaming a real signing clip;
 *   5. UPLOAD mode through the file input;
 *   6. SIGN CLIPS tab: both sections' avatars equal their motion files at the
 *      presented media time, one section plays at a time, both views share a
 *      single WebGL context, and switching back to the studio works.
 * Screenshots and a JSON report go to evidence/e2e/.
 *
 * Environment notes: Playwright's bundled Chromium has no proprietary H.264
 * decoder, so `--video-override` swaps the sample MP4 for a VP9 transcode of
 * the same frames (network interception, test-only); `--clip-video-overrides
 * sign-clip-1=<a.webm>,sign-clip-2=<b.webm>` does the same for the clips tab. Headless SwiftShader
 * runs Holistic at a few seconds per frame, so live checks wait for a handful
 * of results rather than real-time rates.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MotionClip } from '../../src/motion/clip/MotionClip'
import type { AvatarMotionFile } from '../../src/motion/clip/format'
import { parseArgs, readJson, repoPath } from '../lib/cli'
import { loadGltfRig } from '../lib/gltfRig'
import { buildThreeHierarchy } from '../lib/threeRig'
import { SIGN_CLIPS } from '../../src/views/signClips'

const args = parseArgs(process.argv.slice(2), {
  /** Test an already running server instead of starting `vite preview` (e.g. the Windows launcher). */
  url: '',
  port: 4179,
  videoOverride: '',
  /** Comma-separated `<clip-id>=<vp9.webm>` pairs for public/samples/<clip-id>.mp4. */
  clipVideoOverrides: '',
  camera: '',
  out: 'evidence/e2e',
  liveTimeoutSec: 240,
  chromium: ''
})

type Stage = {
  bone: (name: string) => number[] | null
  status: () => { engine: string; handState: { left: string; right: string }; frameIndex: number | null; solveMs: number | null; channels: number } | null
  engine: () => string
  offlineTime: () => number | null
  lastFrameHasWorld: () => boolean
}

type ClipView = {
  bone: (name: string) => number[] | null
  offlineTime: () => number | null
  clipId: () => string | null
}

// Headless SwiftShader runs Holistic on the main thread in multi-second
// (up to ~20 s) tasks, so input actions issued while live tracking runs can
// exceed Playwright's 30 s default before the page handles them.
const BUSY_PAGE_ACTION = { timeout: 120_000 }

const CHECK_BONES = ['upperarm_r', 'lowerarm_r', 'hand_r', 'index_02_r', 'thumb_02_r', 'middle_03_l', 'head', 'jaw']

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function startPreview(): Promise<ChildProcess> {
  // Run vite's CLI directly (not through npx) so killing the child stops the server.
  const child = spawn(process.execPath, [repoPath('node_modules/vite/bin/vite.js'), 'preview', '--port', String(args.port), '--strictPort', '--host', '127.0.0.1'], { cwd: repoPath('.'), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout!.on('data', (d) => { output += String(d) })
  child.stderr!.on('data', (d) => { output += String(d) })
  for (let i = 0; i < 100; i += 1) {
    if (output.includes(`127.0.0.1:${args.port}`)) return child
    await sleep(200)
  }
  child.kill()
  throw new Error(`vite preview did not start:\n${output}`)
}

async function main() {
  if (!args.url && !existsSync(repoPath('dist/index.html'))) throw new Error('Run `npm run build` first (dist/ missing)')
  const out = repoPath(args.out)
  mkdirSync(out, { recursive: true })
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), checks: {} as Record<string, unknown> }
  const checks = report.checks as Record<string, unknown>
  const failures: string[] = []
  const expect = (name: string, ok: boolean, detail: unknown) => {
    checks[name] = { ok, detail }
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
    if (!ok) failures.push(name)
  }

  // Reference pose computation in Node (same MotionClip code as the app).
  const motion = readJson<AvatarMotionFile>('motion/qassem-story/avatar-motion.json.gz')
  const clip = new MotionClip(motion)
  const loaded = await loadGltfRig(repoPath('public/models/deafference-avatar.glb'))
  const { root, byName } = buildThreeHierarchy(loaded)
  const binding = clip.bind(root)
  const rest = new Map(CHECK_BONES.map((b) => [b, byName.get(b)!.quaternion.toArray() as number[]]))
  const expected = (time: number) => {
    clip.applyTo(binding, time)
    return new Map(CHECK_BONES.map((b) => [b, byName.get(b)!.quaternion.toArray() as number[]]))
  }
  // Relative rotation angle via atan2 (accurate near zero, unlike acos of the dot product).
  const angle = (a: number[], b: number[]) => {
    const [ax, ay, az, aw] = a
    const [bx, by, bz, bw] = b
    const w = aw * bw + ax * bx + ay * by + az * bz
    const x = aw * bx - ax * bw - ay * bz + az * by
    const y = aw * by + ax * bz - ay * bw - az * bx
    const z = aw * bz - ax * by + ay * bx - az * bw
    return 2 * Math.atan2(Math.hypot(x, y, z), Math.abs(w))
  }

  const preview = args.url ? null : await startPreview()
  const { chromium } = await import('playwright')
  const launchArgs = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream']
  if (args.camera) launchArgs.push('--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${args.camera}`)
  const browser = await chromium.launch({ executablePath: args.chromium || undefined, args: launchArgs })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, permissions: ['camera'] })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
  // Serve byte ranges like a real static server so the media element can seek.
  const serveVideo = async (pattern: string, file: string) => {
    const bytes = readFileSync(file)
    await page.route(pattern, (route) => {
      const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '')
      if (!range) return route.fulfill({ status: 200, contentType: 'video/webm', headers: { 'accept-ranges': 'bytes' }, body: bytes })
      const start = Number(range[1])
      const end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1
      return route.fulfill({
        status: 206,
        contentType: 'video/webm',
        headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${bytes.length}` },
        body: bytes.subarray(start, end + 1)
      })
    })
  }
  if (args.videoOverride) await serveVideo('**/samples/qassem-story.mp4', args.videoOverride)
  for (const pair of args.clipVideoOverrides.split(',').map((v) => v.trim()).filter(Boolean)) {
    const [id, file] = pair.split('=')
    if (!id || !file || !SIGN_CLIPS.some((c) => c.id === id)) throw new Error(`--clip-video-overrides: bad entry "${pair}"`)
    await serveVideo(`**/samples/${id}.mp4`, file)
  }

  try {
    const url = `${args.url ? args.url.replace(/\/$/, '') : `http://127.0.0.1:${args.port}`}/?debug=1`
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as unknown as { __deafferenceStage?: unknown }).__deafferenceStage), null, { timeout: 180_000 })
    await page.waitForFunction(() => document.querySelector('video')!.readyState >= 2, null, { timeout: 60_000 })
    expect('app loads avatar + motion engine', true, await page.locator('.system-status').innerText())

    // ---- 2. Offline engine lockstep sync.
    await page.evaluate(() => document.querySelector('video')!.pause())
    const engine = await page.evaluate(() => (window as unknown as { __deafferenceStage: Stage }).__deafferenceStage.engine())
    expect('sample clip uses the precomputed (offline) engine by default', engine === 'offline', engine)
    const syncErrors: { frame: number; mediaTime: number | null; maxErrorDeg: number }[] = []
    for (const frame of [100, 2500, 4869]) {
      await page.evaluate((t) => { document.querySelector('video')!.currentTime = t }, frame / 30 + 0.001)
      await page.waitForFunction((t) => Math.abs(document.querySelector('video')!.currentTime - t) < 0.02 && !document.querySelector('video')!.seeking, frame / 30 + 0.001)
      await sleep(600)
      const sample = await page.evaluate((bones) => {
        const s = (window as unknown as { __deafferenceStage: Stage }).__deafferenceStage
        return { time: s.offlineTime(), bones: bones.map((b) => s.bone(b)) }
      }, CHECK_BONES)
      const reference = expected(sample.time ?? 0)
      const maxError = Math.max(...CHECK_BONES.map((b, i) => angle(sample.bones[i]!, reference.get(b)!))) * 180 / Math.PI
      syncErrors.push({ frame, mediaTime: sample.time, maxErrorDeg: Math.round(maxError * 1e5) / 1e5 })
      await page.screenshot({ path: join(out, `offline-frame-${frame}.png`) })
    }
    expect('offline: avatar pose == motion file at the presented media time', syncErrors.every((e) => e.maxErrorDeg < 0.01 && e.mediaTime !== null && Math.abs(e.mediaTime - e.frame / 30) < 0.02), syncErrors)

    await page.evaluate(() => document.querySelector('video')!.play())
    const before = await page.evaluate(() => (window as unknown as { __deafferenceStage: Stage }).__deafferenceStage.offlineTime())
    await sleep(3000)
    const after = await page.evaluate(() => (window as unknown as { __deafferenceStage: Stage }).__deafferenceStage.offlineTime())
    expect('offline: motion advances with playback', (after ?? 0) > (before ?? 0) + 0.5, { before, after })
    await page.screenshot({ path: join(out, 'offline-playing.png') })

    // ---- 3. Live engine on the sample clip (in-browser Holistic).
    await page.getByRole('radio', { name: /Live tracker/ }).click()
    await page.evaluate(() => { const v = document.querySelector('video')!; v.currentTime = 25; return v.play() })
    const liveStart = Date.now()
    let liveStatus: ReturnType<Stage['status']> = null
    let moved = false
    let world = false
    while (Date.now() - liveStart < args.liveTimeoutSec * 1000) {
      await sleep(2000)
      const probe = await page.evaluate((bones) => {
        const s = (window as unknown as { __deafferenceStage: Stage }).__deafferenceStage
        return { status: s.status(), world: s.lastFrameHasWorld(), bones: bones.map((b) => s.bone(b)) }
      }, CHECK_BONES)
      liveStatus = probe.status
      world ||= probe.world
      moved = CHECK_BONES.some((b, i) => angle(probe.bones[i]!, rest.get(b)!) > 5 * Math.PI / 180)
      if (liveStatus?.engine === 'live' && moved && world && (liveStatus.handState.right === 'T' || liveStatus.handState.left === 'T')) break
    }
    await page.screenshot({ path: join(out, 'live-sample.png') })
    expect('live: Holistic runs in-browser and the causal solver drives the avatar', liveStatus?.engine === 'live' && moved, { status: liveStatus, seconds: Math.round((Date.now() - liveStart) / 1000) })
    expect('live: metric world landmarks received from the Holistic bundle', world, world ? 'poseWorldLandmarks present' : 'missing (depth falls back to flat)')

    // ---- 4. Camera mode with a fake device.
    if (args.camera) {
      await page.getByRole('button', { name: /Live camera/ }).click(BUSY_PAGE_ACTION)
      const camStart = Date.now()
      let camStatus: ReturnType<Stage['status']> = null
      let camMoved = false
      while (Date.now() - camStart < args.liveTimeoutSec * 1000) {
        await sleep(2000)
        const probe = await page.evaluate((bones) => {
          const s = (window as unknown as { __deafferenceStage: Stage }).__deafferenceStage
          return { status: s.status(), bones: bones.map((b) => s.bone(b)), camera: Boolean((document.querySelector('video') as HTMLVideoElement).srcObject) }
        }, CHECK_BONES)
        camStatus = probe.status
        camMoved = probe.camera && CHECK_BONES.some((b, i) => angle(probe.bones[i]!, rest.get(b)!) > 5 * Math.PI / 180)
        if (camMoved && (camStatus?.handState.right === 'T' || camStatus?.handState.left === 'T')) break
      }
      await page.screenshot({ path: join(out, 'live-camera.png') })
      expect('camera: fake webcam stream is tracked and retargeted live', camMoved, { status: camStatus, seconds: Math.round((Date.now() - camStart) / 1000) })
    }

    // ---- 5. Upload mode.
    if (args.videoOverride) {
      await page.locator('input[type=file]').setInputFiles(args.videoOverride, BUSY_PAGE_ACTION)
      const upStart = Date.now()
      let upStatus: ReturnType<Stage['status']> = null
      let upMoved = false
      while (Date.now() - upStart < args.liveTimeoutSec * 1000) {
        await sleep(2000)
        const probe = await page.evaluate((bones) => {
          const s = (window as unknown as { __deafferenceStage: Stage }).__deafferenceStage
          return { status: s.status(), bones: bones.map((b) => s.bone(b)), src: document.querySelector('video')!.currentSrc }
        }, CHECK_BONES)
        upStatus = probe.status
        upMoved = probe.src.startsWith('blob:') && CHECK_BONES.some((b, i) => angle(probe.bones[i]!, rest.get(b)!) > 5 * Math.PI / 180)
        if (upMoved) break
      }
      await page.screenshot({ path: join(out, 'live-upload.png') })
      expect('upload: an uploaded video is tracked and retargeted live', upMoved, { status: upStatus, seconds: Math.round((Date.now() - upStart) / 1000) })
    }

    // ---- 6. Sign clips tab (stop live tracking first: it saturates the main thread).
    await page.evaluate(() => document.querySelector('video')?.pause())
    await page.getByRole('tab', { name: /Sign clips/ }).click(BUSY_PAGE_ACTION)
    await page.waitForFunction((ids) => {
      const views = (window as unknown as { __deafferenceClipViews?: Record<string, unknown> }).__deafferenceClipViews
      return ids.every((id) => Boolean(views?.[id]))
    }, SIGN_CLIPS.map((c) => c.id), { timeout: 180_000 })
    await page.waitForFunction((ids) => ids.every((id) => {
      const video = document.querySelector<HTMLVideoElement>(`[data-clip="${id}"] video`)
      return Boolean(video && video.readyState >= 2)
    }), SIGN_CLIPS.map((c) => c.id), { timeout: 60_000 })
    const canvases = await page.evaluate(() => Array.from(document.querySelectorAll('canvas')).map((c) => ({ cls: c.className, twoD: Boolean(c.getContext('2d')) })))
    expect('clips tab: studio unmounted, both avatar views are 2D copies of ONE shared WebGL context', canvases.length === SIGN_CLIPS.length && canvases.every((c) => c.twoD && c.cls.includes('avatar-canvas')), canvases)
    expect('clips tab: URL addresses the tab', page.url().endsWith('#sign-clips'), page.url())

    const clipSync: { clip: string; frame: number; mediaTime: number | null; maxErrorDeg: number }[] = []
    for (const config of SIGN_CLIPS) {
      const clipMotion = new MotionClip(readJson<AvatarMotionFile>(`motion/${config.id}/avatar-motion.json.gz`))
      const clipBinding = clipMotion.bind(root)
      const last = clipMotion.file.frameCount - 1
      for (const frame of [Math.round(last * 0.2), Math.round(last * 0.55), last - 15]) {
        const target = frame / 30 + 0.001
        await page.evaluate(({ id, t }) => { document.querySelector<HTMLVideoElement>(`[data-clip="${id}"] video`)!.currentTime = t }, { id: config.id, t: target })
        await page.waitForFunction(({ id, t }) => {
          const video = document.querySelector<HTMLVideoElement>(`[data-clip="${id}"] video`)!
          return Math.abs(video.currentTime - t) < 0.02 && !video.seeking
        }, { id: config.id, t: target })
        await sleep(600)
        const sample = await page.evaluate(({ id, bones }) => {
          const view = (window as unknown as { __deafferenceClipViews: Record<string, ClipView> }).__deafferenceClipViews[id]
          return { time: view.offlineTime(), clipId: view.clipId(), bones: bones.map((b) => view.bone(b)) }
        }, { id: config.id, bones: CHECK_BONES })
        clipMotion.applyTo(clipBinding, sample.time ?? 0)
        const maxError = Math.max(...CHECK_BONES.map((b, i) => angle(sample.bones[i]!, byName.get(b)!.quaternion.toArray() as number[]))) * 180 / Math.PI
        clipSync.push({ clip: `${config.id}${sample.clipId === config.id ? '' : ` (view shows ${sample.clipId})`}`, frame, mediaTime: sample.time, maxErrorDeg: Math.round(maxError * 1e5) / 1e5 })
      }
      await page.locator(`[data-clip="${config.id}"]`).screenshot({ path: join(out, `clips-${config.id}.png`) })
    }
    expect('clips tab: each avatar == its own motion file at the presented media time', clipSync.every((e) => e.maxErrorDeg < 0.01 && e.mediaTime !== null && Math.abs(e.mediaTime - e.frame / 30) < 0.02 && !e.clip.includes('view shows')), clipSync)

    const clipState = () => page.evaluate((ids) => ids.map((id) => {
      const view = (window as unknown as { __deafferenceClipViews: Record<string, ClipView> }).__deafferenceClipViews[id]
      const video = document.querySelector<HTMLVideoElement>(`[data-clip="${id}"] video`)!
      return { id, avatarTime: view.offlineTime(), videoTime: video.currentTime, paused: video.paused }
    }), SIGN_CLIPS.map((c) => c.id))
    const [first, second] = SIGN_CLIPS
    const videoOf = (id: string) => `[data-clip="${id}"] video`
    // Start both from 1 s so the loop does not wrap inside the observation window.
    for (const config of SIGN_CLIPS) {
      await page.evaluate((selector) => { document.querySelector<HTMLVideoElement>(selector)!.currentTime = 1 }, videoOf(config.id))
      await page.waitForFunction((selector) => !document.querySelector<HTMLVideoElement>(selector)!.seeking, videoOf(config.id))
    }
    const playback: Record<string, unknown> = {}
    let playbackOk = true
    try {
      await page.locator(`[data-clip="${first.id}"]`).getByRole('button', { name: /^Play$/ }).click(BUSY_PAGE_ACTION)
      await page.waitForFunction((selector) => document.querySelector<HTMLVideoElement>(selector)!.currentTime > 2.5, videoOf(first.id), { timeout: 60_000 })
      await sleep(300)
      playback.firstPlaying = await clipState()
      await page.locator(`[data-clip="${second.id}"]`).getByRole('button', { name: /^Play$/ }).click(BUSY_PAGE_ACTION)
      await page.waitForFunction(([a, b]) => document.querySelector<HTMLVideoElement>(a)!.paused && document.querySelector<HTMLVideoElement>(b)!.currentTime > 2.5, [videoOf(first.id), videoOf(second.id)], { timeout: 60_000 })
      await sleep(300)
      playback.secondPlaying = await clipState()
    } catch (error) {
      playbackOk = false
      playback.error = error instanceof Error ? error.message.split('\n')[0] : String(error)
      playback.state = await clipState()
    }
    await page.screenshot({ path: join(out, 'clips-tab.png'), fullPage: true })
    // Exact lockstep is checked above on paused frames. While playing, the
    // avatar time is the time of the last rendered frame, and SwiftShader
    // renders only a few frames per second, so allow up to 1 s of sampling lag.
    const follows = (row: { avatarTime: number | null; videoTime: number }) => row.avatarTime !== null && row.avatarTime > 1.5 && Math.abs(row.avatarTime - row.videoTime) < 1
    const [s1, s2] = [playback.firstPlaying, playback.secondPlaying] as { avatarTime: number | null; videoTime: number; paused: boolean }[][]
    playbackOk &&= Boolean(s1 && s2) && !s1[0].paused && follows(s1[0]) && s2[0].paused && !s2[1].paused && follows(s2[1])
    expect('clips tab: playback drives the avatar, and starting one section pauses the other', playbackOk, playback)

    await page.getByRole('tab', { name: /Motion studio/ }).click()
    await page.waitForFunction(() => document.querySelectorAll('[data-clip]').length === 0 && document.querySelector('.source-switcher') !== null, null, { timeout: 30_000 })
    await page.waitForFunction(() => document.querySelector('video')!.readyState >= 2, null, { timeout: 60_000 })
    await sleep(1500)
    const studioBack = await page.evaluate(() => ({ canvases: document.querySelectorAll('canvas').length, status: document.querySelector('.system-status')?.textContent?.trim(), url: location.href }))
    expect('tabs: back to the studio (clip views released, studio reloaded)', studioBack.canvases === 2 && !studioBack.url.includes('#sign-clips'), studioBack)

    const relevantErrors = errors.filter((e) => !/favicon/i.test(e))
    expect('no page errors', relevantErrors.length === 0, relevantErrors.slice(0, 10))
  } finally {
    await browser.close()
    preview?.kill()
  }
  report.failures = failures
  report.verdict = failures.length ? 'FAIL' : 'PASS'
  writeFileSync(join(out, 'e2e-report.json'), JSON.stringify(report, null, 2))
  console.log(`E2E ${report.verdict} -> ${args.out}/e2e-report.json`)
  if (failures.length) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
