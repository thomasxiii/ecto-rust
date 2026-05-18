// Sidecar worker: runs ServerFunction bodies in a Node subprocess.
//
// Protocol: line-delimited JSON-RPC over stdin/stdout.
//   Request:  { id, method, params }
//   Response: { id, result }  or  { id, error: { message } }
//
// Methods:
//   ping                                 → { pong: <ts> }
//   invoke({ body, args, imports[] })    → { result }
//     where imports is an array of
//       { alias: string, bundlePath: string, exportName: string }
//     The worker `require()`s each bundle once, picks the named export
//     (or `default` / module-as-default), and exposes it on `ctx[alias]`
//     inside the function body.
//
// The body is wrapped as `async function(args, ctx) { <body> }` and
// evaluated via `vm.runInNewContext` so it can't reach the worker's
// internals (no `process`, no `require` from the body itself).

import readline from 'node:readline'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const moduleCache = new Map()
// Process-global mutable state, exposed to every ServerFunction body as
// `ctx.state`. Lets graphs build in-memory stores (Storm uses this for
// the idea/concept/map graph) without redesigning the RPC contract.
const sharedState = {}

function resolveExport(mod, exportName) {
  if (exportName === 'default') {
    if (mod && typeof mod === 'object' && 'default' in mod) return mod.default
    return mod
  }
  if (mod && typeof mod === 'object' && exportName in mod) return mod[exportName]
  throw new Error(`export "${exportName}" not found; available: ${mod ? Object.keys(mod).join(', ') : '(none)'}`)
}

async function handle(req) {
  switch (req.method) {
    case 'ping':
      return { pong: Date.now() }
    case 'invoke': {
      const { body, args, imports } = req.params ?? {}
      if (typeof body !== 'string') throw new Error('invoke: body must be a string')
      const ctx = Object.create(null)
      for (const imp of imports ?? []) {
        let mod = moduleCache.get(imp.bundlePath)
        if (!mod) {
          mod = require(imp.bundlePath)
          moduleCache.set(imp.bundlePath, mod)
        }
        ctx[imp.alias] = resolveExport(mod, imp.exportName)
      }
      // Sandbox: only the things the body needs. No `process`, no `require`.
      // `state` is a single mutable object shared across all invocations in
      // this worker process — bodies can read/write it for in-memory
      // persistence (e.g., a graph store). It's not durable across worker
      // restarts; callers that need durability should serialize to disk
      // themselves.
      const sandbox = { console, JSON, Math, Date, Buffer, URL, fetch }
      ctx.state = sharedState
      const wrapped = `(async function(args, ctx) {\n${body}\n})`
      const fn = vm.runInNewContext(wrapped, sandbox, { timeout: 30000 })
      const result = await fn(args, ctx)
      return { result }
    }
    case 'shutdown':
      process.exit(0)
    default:
      throw new Error(`unknown method: ${req.method}`)
  }
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return
  let req
  try {
    req = JSON.parse(line)
  } catch {
    // Skip malformed lines silently — the host is responsible for clean RPC.
    return
  }
  handle(req).then(
    (res) => write({ id: req.id, ...res }),
    (err) => write({ id: req.id, error: { message: err instanceof Error ? err.message : String(err) } }),
  )
})

// Announce readiness so the host knows we're alive.
write({ event: 'ready', pid: process.pid })
