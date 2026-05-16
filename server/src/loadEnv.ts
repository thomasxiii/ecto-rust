import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Load .env.local from the repo root (one level above server/) into process.env.
// Resolved relative to this file so it works regardless of cwd.
//
// Existing process.env entries always win — explicit shell overrides are
// expected to take precedence over the file.
export function loadEnvLocal(): void {
  const here = dirname(fileURLToPath(import.meta.url))
  const envPath = resolve(here, '../../.env.local')
  if (!existsSync(envPath)) return

  // Node 20.12+ has process.loadEnvFile; fall back to a tiny parser otherwise.
  const proc = process as unknown as { loadEnvFile?: (path: string) => void }
  if (typeof proc.loadEnvFile === 'function') {
    try {
      proc.loadEnvFile(envPath)
      return
    } catch {
      // fall through to manual parse
    }
  }

  const raw = readFileSync(envPath, 'utf8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (process.env[key] == null) process.env[key] = val
  }
}
