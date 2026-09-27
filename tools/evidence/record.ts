/**
 * Render continuous avatar motion (or stills) with the evidence harness.
 *
 *   npx tsx tools/evidence/record.ts --mode clip --view full --out evidence/after-full.mp4
 *   npx tsx tools/evidence/record.ts --mode legacy --raw /motion/qassem-story/raw-landmarks.json.gz --out evidence/before-full.mp4
 *   npx tsx tools/evidence/record.ts --mode clip --frames 150,420,700 --stills evidence/stills
 *
 * Requires a running dev server (npm run dev -- --port 5174) and Playwright's
 * Chromium (npx playwright install chromium). Rendering is frame-stepped and
 * deterministic: output frame k is the pose at t = k / fps.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs, repoPath } from '../lib/cli'

const args = parseArgs(process.argv.slice(2), {
  server: 'http://127.0.0.1:5174',
  mode: 'clip',
  clip: '/motion/qassem-story/avatar-motion.json.gz',
  raw: '/motion/qassem-story/raw-landmarks.json.gz',
  view: 'full',
  width: 640,
  height: 640,
  start: 0,
  end: -1,
  step: 1,
  frames: '',
  out: '',
  stills: '',
  quality: 0.9,
  chromium: ''
})

async function main() {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({
    executablePath: args.chromium || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  })
  const page = await browser.newPage({ viewport: { width: args.width, height: args.height } })
  page.on('pageerror', (error) => console.error('[page]', error.message))
  const query = new URLSearchParams({ mode: args.mode, clip: args.clip, raw: args.raw, view: args.view, width: String(args.width), height: String(args.height) })
  await page.goto(`${args.server}/tools/evidence/harness.html?${query}`)
  await page.waitForFunction(() => document.title === 'ready' || document.title.startsWith('error'), null, { timeout: 600_000 })
  const title = await page.title()
  if (title.startsWith('error')) throw new Error(title)
  const frameCount = await page.evaluate(() => (window as unknown as { harness: { frameCount: number } }).harness.frameCount)

  const list = args.frames
    ? args.frames.split(',').map((v) => Number(v.trim())).filter((v) => Number.isInteger(v) && v >= 0 && v < frameCount)
    : (() => {
        const end = args.end < 0 ? frameCount - 1 : Math.min(args.end, frameCount - 1)
        const out: number[] = []
        for (let k = args.start; k <= end; k += args.step) out.push(k)
        return out
      })()

  let encoder: ReturnType<typeof spawn> | null = null
  if (args.out) {
    mkdirSync(dirname(repoPath(args.out)), { recursive: true })
    encoder = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(30 / args.step), '-i', '-',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', repoPath(args.out)], { stdio: ['pipe', 'inherit', 'inherit'] })
  }
  if (args.stills) mkdirSync(repoPath(args.stills), { recursive: true })

  const started = Date.now()
  for (let i = 0; i < list.length; i += 1) {
    const k = list[i]
    const dataUrl = await page.evaluate(({ frame, quality }) => {
      const h = (window as unknown as { harness: { renderFrame: (k: number) => void; capture: (q: number) => string } }).harness
      h.renderFrame(frame)
      return h.capture(quality)
    }, { frame: k, quality: args.quality })
    const jpeg = Buffer.from(dataUrl.split(',')[1], 'base64')
    if (encoder?.stdin) {
      if (!encoder.stdin.write(jpeg)) await new Promise((resolve) => encoder!.stdin!.once('drain', resolve))
    }
    if (args.stills) writeFileSync(join(repoPath(args.stills), `frame-${String(k).padStart(5, '0')}.jpg`), jpeg)
    if (i % 300 === 0) console.log(`frame ${k} (${i + 1}/${list.length}) ${((Date.now() - started) / 1000).toFixed(0)} s`)
  }
  if (encoder?.stdin) {
    encoder.stdin.end()
    await new Promise((resolve) => encoder!.on('close', resolve))
  }
  await browser.close()
  console.log(`rendered ${list.length} frames in ${((Date.now() - started) / 1000).toFixed(1)} s`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
