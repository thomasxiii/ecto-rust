// Browser-side npm sidecar loader.
//
// Bridges the engine's NpmPackage / NpmExport graph nodes to the runtime.
// Workflow:
//   1. POST /api/bundles/build with { target: 'browser', name, version, exports }
//      → returns { hash, url }
//   2. Dynamic-import the URL, cache the resulting Module
//   3. Resolve a named export and return it
//
// The cache key is the build hash so identical requests share a Promise.

import type { BundleBuildRequest, BundleBuildResponse, GraphNode } from '@ecto/shared'

const SERVER_BASE = (() => {
  // Vite dev: same origin as page, but server is on :4000.
  if (typeof window === 'undefined') return 'http://localhost:4000'
  const { hostname, protocol } = window.location
  return `${protocol}//${hostname}:4000`
})()

type ModuleCache = Map<string, Promise<Record<string, unknown>>>
type BuildCache = Map<string, Promise<BundleBuildResponse>>

const moduleCache: ModuleCache = new Map()
const buildCache: BuildCache = new Map()

function reqKey(req: BundleBuildRequest): string {
  return `${req.target}::${req.name}@${req.version}::${[...req.exports].sort().join(',')}`
}

export async function buildBundle(req: BundleBuildRequest): Promise<BundleBuildResponse> {
  const k = reqKey(req)
  const cached = buildCache.get(k)
  if (cached) return cached
  const promise = (async () => {
    const res = await fetch(`${SERVER_BASE}/api/bundles/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`bundle build failed (${res.status}): ${body}`)
    }
    return (await res.json()) as BundleBuildResponse
  })().catch((err) => {
    // Drop the failed promise from the cache so the next call retries.
    buildCache.delete(k)
    throw err
  })
  buildCache.set(k, promise)
  return promise
}

export async function loadModule(req: BundleBuildRequest): Promise<Record<string, unknown>> {
  const build = await buildBundle(req)
  if (build.target !== 'browser') {
    throw new Error(`loadModule expects a browser bundle, got ${build.target}`)
  }
  const url = `${SERVER_BASE}${build.url}`
  const cached = moduleCache.get(url)
  if (cached) return cached
  const promise = import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>
  moduleCache.set(url, promise)
  return promise
}

export async function getExport<T = unknown>(
  req: BundleBuildRequest,
  exportName: string,
): Promise<T> {
  const mod = await loadModule(req)
  if (!(exportName in mod)) {
    throw new Error(
      `export "${exportName}" not found in bundle for ${req.name}@${req.version}; available: ${Object.keys(mod).join(', ')}`,
    )
  }
  return mod[exportName] as T
}

// ── Graph helpers ────────────────────────────────────────────────────
// Resolve a BundleBuildRequest from an NpmPackage graph node. The node's
// data shape mirrors NpmPackageData from @ecto/shared.

export function packageRequestFromNode(node: GraphNode): BundleBuildRequest {
  const d = node.data as {
    name?: string
    version?: string
    target?: 'browser' | 'server'
    exports?: string[]
  }
  if (!d?.name || !d?.version) {
    throw new Error(`NpmPackage node "${node.id}" missing name/version`)
  }
  return {
    target: d.target ?? 'browser',
    name: d.name,
    version: d.version,
    exports: d.exports ?? ['default'],
  }
}

// Convenience: resolve `getExport` directly from graph nodes.
export async function getExportFromGraph<T = unknown>(
  packageNode: GraphNode,
  exportName: string,
): Promise<T> {
  return getExport<T>(packageRequestFromNode(packageNode), exportName)
}

// Visibility / status for the sidebar UI.
export function listInflightBuilds(): string[] {
  return Array.from(buildCache.keys())
}
