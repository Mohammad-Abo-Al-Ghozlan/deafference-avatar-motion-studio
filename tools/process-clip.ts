/**
 * Run the complete offline pipeline for one clip, in order:
 *
 *   extract (Python) -> clean -> playback MP4 (Python) -> solve -> QA -> GLB export
 *
 *   npm run motion:clip -- --clip sign-clip-1 --python .venv/bin/python
 *
 * Expects the original video at media/source/<clip>.original.mp4 (never
 * modified). The landmark cache is reused when it exists (extraction is the
 * slow, deterministic step); pass `--extract` to force re-extraction. Stops
 * at the first failing stage; a QA failure fails the run.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { parseArgs, repoPath } from './lib/cli'

const args = parseArgs(process.argv.slice(2), {
  clip: '',
  video: '',
  /** Python with pipeline/requirements.txt installed (mediapipe 0.10.14). */
  python: 'python3',
  extract: false,
  export: true
})

function run(label: string, command: string, commandArgs: string[], shown = [command, ...commandArgs].join(' ')) {
  console.log(`\n== ${label}: ${shown}`)
  const result = spawnSync(command, commandArgs, { cwd: repoPath('.'), stdio: 'inherit' })
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status})`)
}

function main() {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(args.clip)) throw new Error('--clip <id> is required (lowercase letters, digits and dashes)')
  const video = args.video || `media/source/${args.clip}.original.mp4`
  if (!existsSync(repoPath(video))) throw new Error(`Source video not found: ${video}`)
  const tsx = [repoPath('node_modules/tsx/dist/cli.mjs')]
  const node = (script: string, extra: string[] = []) => {
    const scriptArgs = [`tools/${script}.ts`, '--clip', args.clip, ...extra]
    run(script, process.execPath, [...tsx, ...scriptArgs], ['tsx', ...scriptArgs].join(' '))
  }

  if (args.extract || !existsSync(repoPath(`motion/${args.clip}/raw-landmarks.json.gz`))) {
    run('extract', args.python, ['pipeline/extract_landmarks.py', '--video', video, '--clip-id', args.clip])
  } else {
    console.log(`\n== extract: reusing motion/${args.clip}/raw-landmarks.json.gz (pass --extract to re-run)`)
  }
  node('clean-landmarks')
  run('playback', args.python, ['pipeline/make_playback.py', '--video', video, '--clip-id', args.clip])
  node('solve-motion', ['--playback-video', `public/samples/${args.clip}.mp4`])
  node('validate-motion')
  if (args.export) node('export-glb')
  console.log(`\nclip ${args.clip}: done. Add it to src/views/signClips.ts to show it in the app.`)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
