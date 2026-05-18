// Host side of the server-NPM sidecar.
//
// Spawns the Node worker (worker.mjs), manages its lifecycle, and exposes
// a typed `invokeServerFunction()` to the rest of the server. Communication
// is line-delimited JSON-RPC over stdin/stdout.
//
// Failure modes:
//   - Worker dies → automatically respawned on next request, with all
//     module cache lost. Pending requests get rejected.
//   - Body throws → the worker captures and returns { error }, no impact
//     on the worker process.
//   - Worker hangs → 30s vm timeout inside the worker; on the host side,
//     callers can pass their own AbortSignal.
//
// Loading bundled server modules is the bundler's job — see Bundler.build
// with target='server'. The host passes the bundle file path to the
// worker, which `require()`s it on first use.

import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { ServerFunctionData } from '@ecto/shared'
import { getBundler } from '../bundler/index.js'

const WORKER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'worker.mjs',
)

export interface SidecarImport {
  alias: string // local name inside ctx.<alias>
  packageName: string
  packageVersion: string
  exportName: string
}

export interface InvokeRequest {
  fn: ServerFunctionData
  args: Record<string, unknown>
  imports: SidecarImport[]
}

export interface InvokeResult {
  ok: true
  result: unknown
  durationMs: number
}

export interface InvokeError {
  ok: false
  error: string
}

type Pending = {
  resolve: (v: { result?: unknown; error?: { message: string } }) => void
  reject: (e: Error) => void
}

export class SidecarHost {
  private child: ChildProcess | null = null
  private rl: readline.Interface | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private ready: Promise<void> | null = null
  private starting = false

  async ensureRunning(): Promise<void> {
    if (this.child && !this.child.killed) {
      if (this.ready) await this.ready
      return
    }
    if (this.starting && this.ready) {
      await this.ready
      return
    }
    this.starting = true
    this.ready = new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [WORKER_PATH], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      })
      this.child = child

      const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity })
      this.rl = rl

      let readied = false
      rl.on('line', (line) => {
        if (!line.trim()) return
        let msg: unknown
        try {
          msg = JSON.parse(line)
        } catch {
          // Stray non-JSON output → forward to stderr for debugging.
          process.stderr.write(`[sidecar:stdout] ${line}\n`)
          return
        }
        const m = msg as { event?: string; id?: number; result?: unknown; error?: { message: string } }
        if (!readied && m.event === 'ready') {
          readied = true
          resolve()
          return
        }
        if (typeof m.id === 'number') {
          const pend = this.pending.get(m.id)
          if (pend) {
            this.pending.delete(m.id)
            pend.resolve({ result: m.result, error: m.error })
          }
        }
      })

      child.stderr!.on('data', (chunk: Buffer) => {
        process.stderr.write(`[sidecar:stderr] ${chunk.toString('utf8')}`)
      })

      child.on('exit', (code, signal) => {
        process.stderr.write(`[sidecar] worker exited code=${code} signal=${signal}\n`)
        this.child = null
        this.rl = null
        this.ready = null
        this.starting = false
        // Reject all pending so callers don't hang.
        for (const [, pend] of this.pending) {
          pend.reject(new Error(`sidecar worker exited (code=${code}, signal=${signal})`))
        }
        this.pending.clear()
        if (!readied) reject(new Error('sidecar worker exited before ready'))
      })

      child.on('error', (err) => {
        if (!readied) reject(err)
      })
    })
    try {
      await this.ready
    } finally {
      this.starting = false
    }
  }

  private async rpc<T = unknown>(method: string, params: unknown): Promise<T> {
    await this.ensureRunning()
    if (!this.child) throw new Error('sidecar not started')
    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params }) + '\n'
    const promise = new Promise<{ result?: unknown; error?: { message: string } }>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.child.stdin!.write(payload)
    const res = await promise
    if (res.error) throw new Error(res.error.message)
    return res.result as T
  }

  async ping(): Promise<{ pong: number }> {
    return this.rpc<{ pong: number }>('ping', {})
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult | InvokeError> {
    const t0 = Date.now()
    try {
      // Build (or fetch from cache) each requested import, gather bundle paths.
      const bundler = getBundler()
      const resolvedImports = await Promise.all(
        req.imports.map(async (imp) => {
          const build = await bundler.build({
            target: 'server',
            name: imp.packageName,
            version: imp.packageVersion,
            exports: [imp.exportName],
          })
          const bundlePath = bundler.bundlePath(build.hash, 'server')
          return { alias: imp.alias, bundlePath, exportName: imp.exportName }
        }),
      )
      const result = await this.rpc('invoke', {
        body: req.fn.body,
        args: req.args,
        imports: resolvedImports,
      })
      return { ok: true, result, durationMs: Date.now() - t0 }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  shutdown(): void {
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM')
    }
  }
}

let singleton: SidecarHost | null = null
export function getSidecarHost(): SidecarHost {
  if (!singleton) singleton = new SidecarHost()
  return singleton
}
