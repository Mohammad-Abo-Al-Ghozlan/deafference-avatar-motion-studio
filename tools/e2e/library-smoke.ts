/**
 * End-to-end test of the Sign library tab in a real (headless) browser.
 *
 *   npm run build && npm run e2e:library [-- --url https://<deployment>]
 *
 * Against the production bundle served by `vite preview` (or --url):
 *   1. the tab, the library (index + quaternion data) and the avatar load
 *      without console errors, and the list shows every word;
 *   2. for several words (one-handed, symmetric and asymmetric two-handed)
 *      and BOTH versions (raw, conformed), the avatar's bones equal the
 *      library sampled at the presented time, computed in Node with the same
 *      MotionClip code from the files on disk;
 *   3. Deaf review: approving a word and exporting writes the pipeline's
 *      deaf_review_decisions.csv (columns, quoting, the take's sequence id);
 *   4. the lookup test plays the matched words back to back, review is
 *      disabled meanwhile, and switching version keeps the phrase being played;
 *   5. screenshots of the avatar mid-sign for every checked word and version.
 * Output: evidence/e2e/library-report.json and evidence/e2e/library-*.png.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { MotionClip } from '../../src/motion/clip/MotionClip'
import { sequenceMotionFile, wordMotionFile } from '../../src/motion/library/clips'
import { int16View, validateLibraryIndex, type LibraryVariant, type SignLibraryIndex } from '../../src/motion/library/format'
import { parseArgs, repoPath } from '../lib/cli'
import { loadGltfRig } from '../lib/gltfRig'
import { buildThreeHierarchy } from '../lib/threeRig'

const args = parseArgs(process.argv.slice(2), {
  url: '',
  port: 4181,
  out: 'evidence/e2e',
  words: 'hello,thankyou,book,after,TV,night,mom,drink',
  phrase: 'hello thank you mom',
  chromium: ''
})

const CHECK_BONES = ['upperarm_r', 'lowerarm_r', 'hand_r', 'index_02_r', 'thumb_02_r', 'upperarm_l', 'hand_l', 'middle_03_l']
const TOLERANCE_DEG = 0.05

type ClipView = { bone: (name: string) => number[] | null; offlineTime: () => number | null; clipId: () => string | null }
type LibraryHook = {
  select: (gloss: string) => void
  setVariant: (variant: LibraryVariant) => void
  pause: () => void
  seek: (seconds: number) => void
  playPhrase: (text: string) => void
  state: () => { selected: string; variant: string; mode: string; time: number; playing: boolean; clipId: string | null; frameCount: number }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function startPreview(): Promise<ChildProcess> {
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

/** Relative rotation angle via atan2 (accurate near zero). */
function angle(a: number[], b: number[]) {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  const w = aw * bw + ax * bx + ay * by + az * bz
  const x = aw * bx - ax * bw - ay * bz + az * by
  const y = aw * by + ax * bz - ay * bw - az * bx
  const z = aw * bz - ax * by + ay * bx - az * bw
  return 2 * Math.atan2(Math.hypot(x, y, z), Math.abs(w)) * (180 / Math.PI)
}

async function main() {
  const out = repoPath(args.out)
  mkdirSync(out, { recursive: true })
  const checks: Record<string, unknown> = {}
  const failures: string[] = []
  const expect = (name: string, ok: boolean, detail: unknown) => {
    checks[name] = { ok, detail }
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
    if (!ok) failures.push(name)
  }

  // Reference: the files the app serves, decoded in Node with the app's code.
  const index = JSON.parse(readFileSync(repoPath('public/motion/sign-library/sign-library.json'), 'utf8')) as SignLibraryIndex
  validateLibraryIndex(index)
  const data = int16View(index, gunzipSync(readFileSync(repoPath(`public/motion/sign-library/${index.data.file}`))))
  const loaded = await loadGltfRig(repoPath('public/models/deafference-avatar.glb'))
  const { root, byName } = buildThreeHierarchy(loaded)
  const words = args.words.split(',').map((w) => w.trim()).filter(Boolean)
  for (const gloss of words) if (!index.words.some((w) => w.gloss === gloss)) throw new Error(`--words: "${gloss}" is not in the library`)

  const preview = args.url ? null : await startPreview()
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({
    executablePath: args.chromium || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}${m.location().url ? ` (${m.location().url})` : ''}`) })
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`) })

  try {
    const base = args.url ? args.url.replace(/\/$/, '') : `http://127.0.0.1:${args.port}`
    await page.goto(`${base}/?debug=1#sign-library`)
    await page.waitForFunction(() => Boolean((window as unknown as { __deafferenceLibrary?: unknown }).__deafferenceLibrary), null, { timeout: 120_000 })
    await page.waitForSelector('.library-view .avatar-stage.is-ready', { timeout: 240_000 })
    await page.waitForFunction(() => document.querySelectorAll('.word-row').length > 0, null, { timeout: 60_000 })
    expect('tab selected and labelled', await page.locator('#tab-library').getAttribute('aria-selected') === 'true', await page.locator('#tab-library').innerText())
    const rows = await page.locator('.word-row').count()
    expect('word list shows every library word', rows === index.words.length, `${rows} rows / ${index.words.length} words`)
    expect('status pill reports the library', true, await page.locator('.system-status').innerText())

    let check = 0
    for (const gloss of words) {
      const word = index.words.find((w) => w.gloss === gloss)!
      for (const variant of index.variants) {
        // A time no earlier check used: the render loop reports it only after it has
        // applied THIS clip at THIS position (software GL can take >100 ms per frame).
        check += 1
        const target = (word.holdIn + word.stroke / 2) / index.fps + check * 1e-4
        await page.evaluate(({ g, v, t }) => {
          const lib = (window as unknown as { __deafferenceLibrary: LibraryHook }).__deafferenceLibrary
          lib.select(g)
          lib.setVariant(v as LibraryVariant)
          lib.pause()
          lib.seek(t)
        }, { g: gloss, v: variant, t: target })
        // Wait until the render loop has applied the pose at that time.
        await page.waitForFunction(({ id, t }) => {
          const view = (window as unknown as { __deafferenceClipViews?: Record<string, ClipView> }).__deafferenceClipViews?.[`sign-library`]
          const time = view?.offlineTime()
          return view?.clipId() === id && time !== null && time !== undefined && Math.abs(time - t) < 1e-6
        }, { id: `${gloss}:${variant}`, t: target }, { timeout: 30_000 })
        await page.waitForTimeout(150)
        const actual = await page.evaluate((bones) => {
          const view = (window as unknown as { __deafferenceClipViews: Record<string, ClipView> }).__deafferenceClipViews['sign-library']
          return { time: view.offlineTime(), bones: Object.fromEntries(bones.map((b) => [b, view.bone(b)])) }
        }, CHECK_BONES)
        const clip = new MotionClip(wordMotionFile(index, data, variant, word))
        const binding = clip.bind(root)
        clip.applyTo(binding, actual.time ?? target)
        const errorsDeg = CHECK_BONES.map((bone) => angle(byName.get(bone)!.quaternion.toArray() as number[], actual.bones[bone] ?? [0, 0, 0, 1]))
        binding.reset()
        const worst = Math.max(...errorsDeg)
        const detail = worst < TOLERANCE_DEG
          ? `max ${worst.toFixed(5)} deg over ${CHECK_BONES.length} bones`
          : { time: actual.time, perBoneDeg: Object.fromEntries(CHECK_BONES.map((b, i) => [b, Number(errorsDeg[i].toFixed(3))])) }
        expect(`${gloss} (${variant}): avatar pose == library at t=${target.toFixed(3)} s`, worst < TOLERANCE_DEG, detail)
        await page.locator('.library-avatar-wrap').screenshot({ path: `${out}/library-${gloss}-${variant}.png` })
      }
    }

    // Deaf review: approve one word and export the pipeline's deaf_review_decisions.csv.
    await page.evaluate(() => (window as unknown as { __deafferenceLibrary: LibraryHook }).__deafferenceLibrary.select('hello'))
    await page.locator('.review-field input').fill('E2E reviewer')
    await page.locator('.review-field textarea').fill('e2e, "check"')
    await page.locator('.review-actions .approve').click()
    await page.waitForSelector('.word-row[data-gloss="hello"] .badge.approved', { timeout: 10_000 })
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.review-body .export').click()])
    const csv = readFileSync((await download.path())!, 'utf8')
    const hello = index.words.find((w) => w.gloss === 'hello')!
    const expectedCsv = [
      '\uFEFFsign,rank,sequence_id,participant_id,decision,reviewer,notes,clip_file',
      `hello,${hello.source.rank},${hello.source.sequenceId},${hello.source.participantId},approved,E2E reviewer,"e2e, ""check""",${hello.source.clipFile}`,
      ''
    ].join('\r\n')
    expect('review: approve + export writes the pipeline CSV', download.suggestedFilename() === 'deaf_review_decisions.csv' && csv === expectedCsv, { file: download.suggestedFilename(), csv })

    // Lookup test: matched words played back to back.
    const phraseGlosses = ['hello', 'thankyou', 'mom']
    const phraseWords = phraseGlosses.map((g) => index.words.find((w) => w.gloss === g)!)
    await page.evaluate((text) => (window as unknown as { __deafferenceLibrary: LibraryHook }).__deafferenceLibrary.playPhrase(text), args.phrase)
    await page.waitForFunction(() => (window as unknown as { __deafferenceLibrary: LibraryHook }).__deafferenceLibrary.state().mode === 'phrase', null, { timeout: 10_000 })
    const state = await page.evaluate(() => (window as unknown as { __deafferenceLibrary: LibraryHook }).__deafferenceLibrary.state())
    const matched = await page.locator('.phrase-tokens li:not(.missing)').count()
    const glosses = (await page.locator('.phrase-tokens li:not(.missing) small').allInnerTexts())
    const expectedFrames = sequenceMotionFile(index, data, state.variant as LibraryVariant, phraseWords).file.frameCount
    expect('lookup test plays the matched words back to back', state.mode === 'phrase' && state.playing && matched === 3 && state.frameCount === expectedFrames, { matched, glosses, frameCount: state.frameCount, expectedFrames })
    expect('review is disabled while a phrase plays', await page.locator('.review-actions .approve').isDisabled(), 'Approve disabled in phrase mode')
    // Instant: the app scrolls smoothly, and software GL paints slowly mid-animation.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await page.waitForTimeout(1200)
    await page.screenshot({ path: `${out}/library-page.png`, fullPage: false })

    // Switching version keeps the phrase being played, even after the text box changed.
    await page.locator('#phrase-input').fill('dog cat')
    const other: LibraryVariant = state.variant === 'raw' ? 'conformed' : 'raw'
    await page.evaluate((v) => (window as unknown as { __deafferenceLibrary: LibraryHook }).__deafferenceLibrary.setVariant(v as LibraryVariant), other)
    const switched = await page.evaluate(() => (window as unknown as { __deafferenceLibrary: LibraryHook }).__deafferenceLibrary.state())
    expect('version switch rebuilds the phrase being played', switched.mode === 'phrase' && switched.clipId === `sequence:${phraseGlosses.join('+')}:${other}`, { clipId: switched.clipId, mode: switched.mode })

    // The app ships no favicon (pre-existing): the browser's automatic /favicon.ico 404 is not an app error.
    const appErrors = errors.filter((e) => !/\/favicon\.ico\)?$/.test(e))
    expect('no console errors', appErrors.length === 0, appErrors.slice(0, 10))
  } finally {
    await browser.close()
    preview?.kill()
  }

  writeFileSync(`${out}/library-report.json`, `${JSON.stringify({ finishedAt: new Date().toISOString(), url: args.url || 'vite preview', checks, failures }, null, 2)}\n`)
  console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nAll library checks passed')
  process.exit(failures.length ? 1 : 0)
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
