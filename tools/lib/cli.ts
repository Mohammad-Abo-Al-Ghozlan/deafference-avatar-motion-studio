import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Resolve a CLI path relative to the repository root (never a device path). */
export function repoPath(path: string) {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path)
}

/**
 * Minimal `--key value` / `--flag` parser with typed defaults. Unknown keys are
 * rejected so typos never silently fall back to defaults.
 */
export function parseArgs<T extends Record<string, string | number | boolean>>(argv: string[], defaults: T): T {
  const result: Record<string, string | number | boolean> = { ...defaults }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) throw new Error(`Unexpected argument "${token}"`)
    const key = token.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    if (!(key in defaults)) throw new Error(`Unknown option --${token.slice(2)}. Known: ${Object.keys(defaults).join(', ')}`)
    const fallback = defaults[key]
    if (typeof fallback === 'boolean') {
      const next = argv[i + 1]
      if (next === 'true' || next === 'false') {
        result[key] = next === 'true'
        i += 1
      } else {
        result[key] = true
      }
      continue
    }
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`Missing value for --${token.slice(2)}`)
    i += 1
    if (typeof fallback === 'number') {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) throw new Error(`--${token.slice(2)} expects a number`)
      result[key] = parsed
    } else {
      result[key] = value
    }
  }
  return result as T
}

export function readJson<T = unknown>(path: string): T {
  const full = repoPath(path)
  if (!existsSync(full)) throw new Error(`File not found: ${full}`)
  const buffer = readFileSync(full)
  const text = buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer).toString('utf8') : buffer.toString('utf8')
  return JSON.parse(text) as T
}

/** Deterministic JSON writer; `.gz` paths are gzip-compressed with a zero mtime. */
export function writeJson(path: string, value: unknown, pretty = false) {
  const full = repoPath(path)
  mkdirSync(dirname(full), { recursive: true })
  const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)
  if (full.endsWith('.gz')) {
    const gz = gzipSync(Buffer.from(text, 'utf8'), { level: 9 })
    // Node's gzip header carries mtime=0 already; OS byte is platform-specific.
    gz[9] = 0xff
    writeFileSync(full, gz)
  } else {
    writeFileSync(full, text)
  }
  return full
}
