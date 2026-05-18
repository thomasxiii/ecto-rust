// NPM-sidecar bundler.
//
// Compiles npm packages on demand using esbuild. Two flavors:
//  - browser: ESM bundle (external React, ReactDOM resolved at runtime via
//    importmap shim in the preview iframe). Served as
//    /bundles/<hash>.mjs by Fastify.
//  - server:  CJS bundle for the Node sidecar subprocess. Written to
//    .bundle-cache/server/<hash>.cjs and loaded via `require()`.
//
// Bundles are content-addressed by hash(name + version + target + exports).
// The cache is on disk (.bundle-cache/) so dev restarts don't recompile.

import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build as esbuild, type BuildOptions } from 'esbuild'
import { spawn } from 'node:child_process'
import type { BundleBuildRequest, BundleBuildResponse, NpmTarget } from '@ecto/shared'

const CACHE_ROOT = path.resolve(process.cwd(), '.bundle-cache')

// React + react-dom stay external for browser bundles — the preview iframe
// already has them on a known global, and we want every npm component to
// share that runtime so hooks work across the boundary.
const BROWSER_EXTERNALS = ['react', 'react-dom', 'react-dom/client']

export interface BundlerOptions {
  cacheRoot?: string
  // If true, the bundler installs missing packages into a per-bundle scratch
  // dir before building. If false, packages must already be resolvable from
  // the server's node_modules.
  autoInstall?: boolean
}

export class Bundler {
  private cacheRoot: string
  private autoInstall: boolean
  // In-flight build promises, keyed by hash. Coalesces concurrent identical
  // requests so we don't fork two esbuilds for the same package.
  private inflight = new Map<string, Promise<BundleBuildResponse>>()

  constructor(opts: BundlerOptions = {}) {
    this.cacheRoot = opts.cacheRoot ?? CACHE_ROOT
    this.autoInstall = opts.autoInstall ?? true
  }

  hashOf(req: BundleBuildRequest): string {
    const exports = [...req.exports].sort()
    const key = JSON.stringify({ t: req.target, n: req.name, v: req.version, e: exports })
    return createHash('sha256').update(key).digest('hex').slice(0, 16)
  }

  bundlePath(hash: string, target: NpmTarget): string {
    const ext = target === 'browser' ? 'mjs' : 'cjs'
    return path.join(this.cacheRoot, target, `${hash}.${ext}`)
  }

  publicUrl(hash: string, target: NpmTarget): string {
    if (target !== 'browser') {
      throw new Error('server bundles are not served over HTTP')
    }
    return `/bundles/${hash}.mjs`
  }

  async ensureCacheDirs(): Promise<void> {
    await mkdir(path.join(this.cacheRoot, 'browser'), { recursive: true })
    await mkdir(path.join(this.cacheRoot, 'server'), { recursive: true })
  }

  async build(req: BundleBuildRequest): Promise<BundleBuildResponse> {
    const hash = this.hashOf(req)
    const inflight = this.inflight.get(hash)
    if (inflight) return inflight

    const promise = this.buildInner(req, hash).finally(() => {
      this.inflight.delete(hash)
    })
    this.inflight.set(hash, promise)
    return promise
  }

  private async buildInner(req: BundleBuildRequest, hash: string): Promise<BundleBuildResponse> {
    await this.ensureCacheDirs()
    const outPath = this.bundlePath(hash, req.target)
    const started = Date.now()

    // Cache hit — already on disk.
    const cached = await fileExists(outPath)
    if (cached) {
      const sz = (await stat(outPath)).size
      return {
        hash,
        target: req.target,
        url: req.target === 'browser' ? this.publicUrl(hash, req.target) : `file://${outPath}`,
        bytes: sz,
        cached: true,
        durationMs: Date.now() - started,
      }
    }

    const installDir = path.join(this.cacheRoot, 'install', hash)
    if (this.autoInstall) {
      await installPackage(installDir, req.name, req.version)
    }

    const entryShim = generateEntryShim(req)
    const entryPath = path.join(this.cacheRoot, 'entries', `${hash}.entry.js`)
    await mkdir(path.dirname(entryPath), { recursive: true })
    await writeFile(entryPath, entryShim, 'utf8')

    const opts: BuildOptions = {
      entryPoints: [entryPath],
      bundle: true,
      outfile: outPath,
      platform: req.target === 'browser' ? 'browser' : 'node',
      format: req.target === 'browser' ? 'esm' : 'cjs',
      target: req.target === 'browser' ? ['es2020'] : ['node20'],
      external: req.target === 'browser' ? BROWSER_EXTERNALS : [],
      logLevel: 'silent',
      minify: false,
      sourcemap: false,
      // When autoInstall, point esbuild at the per-bundle node_modules.
      nodePaths: this.autoInstall ? [path.join(installDir, 'node_modules')] : undefined,
      // Define typical guards so React-style packages know they're in prod.
      define: req.target === 'browser' ? { 'process.env.NODE_ENV': '"production"' } : {},
      // Loader for .css imports baked into a JS string — browser-only.
      loader: req.target === 'browser' ? { '.css': 'text' } : {},
    }

    await esbuild(opts)

    const sz = (await stat(outPath)).size
    return {
      hash,
      target: req.target,
      url: req.target === 'browser' ? this.publicUrl(hash, req.target) : `file://${outPath}`,
      bytes: sz,
      cached: false,
      durationMs: Date.now() - started,
    }
  }
}

function generateEntryShim(req: BundleBuildRequest): string {
  const exports = req.exports.length > 0 ? req.exports : ['default']
  const importLines: string[] = []
  const reExportLines: string[] = []
  for (const exp of exports) {
    if (exp === 'default') {
      importLines.push(`import __default from '${req.name}'`)
      reExportLines.push(`export { __default as default }`)
    } else {
      // Re-export named exports verbatim. esbuild handles tree-shaking.
      importLines.push(`import { ${exp} as __${safeIdent(exp)} } from '${req.name}'`)
      reExportLines.push(`export { __${safeIdent(exp)} as ${exp} }`)
    }
  }
  return `${importLines.join('\n')}\n${reExportLines.join('\n')}\n`
}

function safeIdent(name: string): string {
  return name.replace(/[^a-zA-Z0-9_$]/g, '_')
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function installPackage(dir: string, name: string, version: string): Promise<void> {
  // Skip if package.json already records the desired version.
  const pkgJsonPath = path.join(dir, 'package.json')
  const installedNodeModule = path.join(dir, 'node_modules', name, 'package.json')
  if (await fileExists(installedNodeModule)) {
    try {
      const raw = await readFile(installedNodeModule, 'utf8')
      const parsed = JSON.parse(raw) as { version?: string }
      if (parsed.version === version || version === 'latest' || version.startsWith('^') || version.startsWith('~')) {
        return
      }
    } catch {
      // Fall through to reinstall.
    }
  }
  await mkdir(dir, { recursive: true })
  if (!(await fileExists(pkgJsonPath))) {
    await writeFile(
      pkgJsonPath,
      JSON.stringify({ name: `ecto-bundle-scratch`, private: true, version: '0.0.0' }, null, 2),
      'utf8',
    )
  }
  await runNpm(['install', '--no-audit', '--no-fund', '--no-package-lock', `${name}@${version}`], dir)
}

function runNpm(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, { cwd, stdio: 'pipe' })
    const stderr: Buffer[] = []
    child.stderr.on('data', (b) => stderr.push(b))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`npm ${args.join(' ')} exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`))
    })
  })
}

let singleton: Bundler | null = null
export function getBundler(): Bundler {
  if (!singleton) singleton = new Bundler()
  return singleton
}

// For test isolation.
export function _resetBundlerSingleton(): void {
  singleton = null
}

// Suppress unused tmpdir warning — kept as a documented escape hatch for
// platforms that ship read-only cwds. Not used by default.
void tmpdir
