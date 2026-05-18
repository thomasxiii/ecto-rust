// Sandbox view for verifying the npm sidecar end-to-end. Lets you pick a
// package, build it, load it, and call an export — all without touching
// the main engine graph. Used as a smoke test before Phase 4 wires the
// sidecar into real graphs.

import { useState } from 'react'
import { buildBundle, loadModule } from './npmLoader'
import { tokens } from './ui'

const SERVER_BASE = (() => {
  if (typeof window === 'undefined') return 'http://localhost:4000'
  const { hostname, protocol } = window.location
  return `${protocol}//${hostname}:4000`
})()

interface BuildResultView {
  hash: string
  url: string
  bytes: number
  cached: boolean
  durationMs: number
}

interface RunResult {
  ok: boolean
  detail: string
}

export function NpmSandbox({ onBack }: { onBack: () => void }) {
  const [name, setName] = useState('zod')
  const [version, setVersion] = useState('^3.23.0')
  const [exportsCsv, setExportsCsv] = useState('z')
  const [building, setBuilding] = useState(false)
  const [buildResult, setBuildResult] = useState<BuildResultView | null>(null)
  const [moduleKeys, setModuleKeys] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [runResult, setRunResult] = useState<RunResult | null>(null)
  const [runInput, setRunInput] = useState('hello world')

  const exportList = exportsCsv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  async function doBuild() {
    setError(null)
    setBuildResult(null)
    setModuleKeys(null)
    setRunResult(null)
    setBuilding(true)
    try {
      const res = await buildBundle({
        target: 'browser',
        name,
        version,
        exports: exportList,
      })
      setBuildResult({
        hash: res.hash,
        url: res.url,
        bytes: res.bytes,
        cached: res.cached,
        durationMs: res.durationMs,
      })
      const mod = await loadModule({
        target: 'browser',
        name,
        version,
        exports: exportList,
      })
      setModuleKeys(Object.keys(mod))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBuilding(false)
    }
  }

  async function doRunZod() {
    setError(null)
    setRunResult(null)
    try {
      const mod = await loadModule({
        target: 'browser',
        name,
        version,
        exports: exportList,
      })
      // Verify zod by validating a string. Avoids tying the sandbox to a
      // specific export shape — if the user pointed at a different
      // package, this just reports "z not found".
      const z = (mod as { z?: unknown }).z as
        | { string: () => { parse: (v: unknown) => unknown } }
        | undefined
      if (!z) {
        setRunResult({ ok: false, detail: '`z` export not found in bundle' })
        return
      }
      const parsed = z.string().parse(runInput)
      setRunResult({ ok: true, detail: `z.string().parse() → ${JSON.stringify(parsed)}` })
    } catch (e) {
      setRunResult({ ok: false, detail: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div
      style={{
        padding: 24,
        maxWidth: 720,
        margin: '24px auto',
        background: tokens.bg,
        color: tokens.fg,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <button onClick={onBack} className="ec-btn ec-btn-secondary">
          ← back
        </button>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>NPM Sandbox</h2>
      </div>
      <p style={{ fontSize: 13, color: tokens.fgMuted, marginTop: 0 }}>
        Verify the npm sidecar end-to-end. The server compiles the chosen package via esbuild,
        serves it as ESM at <code>/bundles/&lt;hash&gt;.mjs</code>, and we dynamic-import it here.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16 }}>
        <Field label="Package name">
          <input className="ec-input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Version (npm semver)">
          <input className="ec-input" value={version} onChange={(e) => setVersion(e.target.value)} />
        </Field>
      </div>
      <div style={{ marginTop: 12 }}>
        <Field label="Exports (comma-separated)">
          <input
            className="ec-input"
            value={exportsCsv}
            onChange={(e) => setExportsCsv(e.target.value)}
          />
        </Field>
      </div>

      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <button onClick={doBuild} className="ec-btn" disabled={building}>
          {building ? 'Building…' : 'Build + load'}
        </button>
        {buildResult ? (
          <button onClick={doRunZod} className="ec-btn ec-btn-secondary">
            Run zod.string().parse()
          </button>
        ) : null}
      </div>

      {error ? (
        <pre
          style={{
            marginTop: 16,
            padding: 12,
            background: '#fee2e2',
            color: '#991b1b',
            borderRadius: tokens.radius,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
          }}
        >
          {error}
        </pre>
      ) : null}

      {buildResult ? (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            background: '#f3f4f6',
            borderRadius: tokens.radius,
            fontSize: 12,
            fontFamily: tokens.fontMono,
          }}
        >
          <div>
            <strong>hash:</strong> {buildResult.hash}
          </div>
          <div>
            <strong>url:</strong> {buildResult.url}
          </div>
          <div>
            <strong>bytes:</strong> {buildResult.bytes.toLocaleString()} ({(buildResult.bytes / 1024).toFixed(1)}{' '}
            KB)
          </div>
          <div>
            <strong>cached:</strong> {String(buildResult.cached)}
          </div>
          <div>
            <strong>duration:</strong> {buildResult.durationMs} ms
          </div>
          {moduleKeys ? (
            <div style={{ marginTop: 8 }}>
              <strong>module exports:</strong> [{moduleKeys.join(', ')}]
            </div>
          ) : null}
        </div>
      ) : null}

      {runResult ? (
        <div style={{ marginTop: 16 }}>
          <Field label="Input string">
            <input
              className="ec-input"
              value={runInput}
              onChange={(e) => setRunInput(e.target.value)}
            />
          </Field>
          <pre
            style={{
              marginTop: 8,
              padding: 12,
              background: runResult.ok ? '#dcfce7' : '#fee2e2',
              color: runResult.ok ? '#166534' : '#991b1b',
              borderRadius: tokens.radius,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
            }}
          >
            {runResult.detail}
          </pre>
        </div>
      ) : null}

      <ServerFnPanel />
    </div>
  )
}

// ── Server-side sidecar demo ────────────────────────────────────────
// Sends an ad-hoc ServerFunction body to the Node sidecar subprocess.

function ServerFnPanel() {
  const [body, setBody] = useState(`return ctx.lodash.kebabCase(args.input)`)
  const [pkg, setPkg] = useState('lodash')
  const [pkgVersion, setPkgVersion] = useState('^4.17.21')
  const [alias, setAlias] = useState('lodash')
  const [exportName, setExportName] = useState('default')
  const [input, setInput] = useState('Hello World From Ecto')
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState<{ ok: boolean; detail: string; ms?: number } | null>(null)

  async function invoke() {
    setRunning(true)
    setOutput(null)
    try {
      const res = await fetch(`${SERVER_BASE}/api/server-fn/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          body,
          args: { input },
          imports: [
            {
              alias,
              packageName: pkg,
              packageVersion: pkgVersion,
              exportName,
            },
          ],
        }),
      })
      const json = (await res.json()) as
        | { ok: true; result: unknown; durationMs: number }
        | { ok: false; error: string }
      if (res.ok && json.ok) {
        setOutput({ ok: true, detail: JSON.stringify(json.result, null, 2), ms: json.durationMs })
      } else {
        setOutput({ ok: false, detail: 'error' in json ? json.error : 'unknown error' })
      }
    } catch (e) {
      setOutput({ ok: false, detail: e instanceof Error ? e.message : String(e) })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div
      style={{
        marginTop: 32,
        padding: 16,
        border: `1px solid ${tokens.border}`,
        borderRadius: tokens.radius,
      }}
    >
      <h3 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600 }}>
        Server-side sidecar invoke
      </h3>
      <p style={{ fontSize: 12, color: tokens.fgMuted, marginTop: 0 }}>
        Runs a JS body inside the Node sidecar subprocess. Imports are bundled with target=server
        and required by the worker; the body sees them on <code>ctx.&lt;alias&gt;</code>.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Field label="Package">
          <input className="ec-input" value={pkg} onChange={(e) => setPkg(e.target.value)} />
        </Field>
        <Field label="Version">
          <input
            className="ec-input"
            value={pkgVersion}
            onChange={(e) => setPkgVersion(e.target.value)}
          />
        </Field>
        <Field label="Alias (ctx.<alias>)">
          <input className="ec-input" value={alias} onChange={(e) => setAlias(e.target.value)} />
        </Field>
        <Field label="Export name">
          <input
            className="ec-input"
            value={exportName}
            onChange={(e) => setExportName(e.target.value)}
          />
        </Field>
      </div>
      <div style={{ marginTop: 8 }}>
        <Field label="Function body (args, ctx in scope)">
          <textarea
            className="ec-input"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            style={{ width: '100%', fontFamily: tokens.fontMono, fontSize: 12 }}
          />
        </Field>
      </div>
      <div style={{ marginTop: 8 }}>
        <Field label="Input (passed as args.input)">
          <input className="ec-input" value={input} onChange={(e) => setInput(e.target.value)} />
        </Field>
      </div>
      <button onClick={invoke} className="ec-btn" disabled={running} style={{ marginTop: 12 }}>
        {running ? 'Invoking…' : 'Invoke'}
      </button>
      {output ? (
        <pre
          style={{
            marginTop: 12,
            padding: 12,
            background: output.ok ? '#dcfce7' : '#fee2e2',
            color: output.ok ? '#166534' : '#991b1b',
            borderRadius: tokens.radius,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
          }}
        >
          {output.ms !== undefined ? `(${output.ms} ms)\n` : ''}
          {output.detail}
        </pre>
      ) : null}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', fontSize: 11, color: tokens.fgMuted }}>
      {label}
      <div style={{ marginTop: 4 }}>{children}</div>
    </label>
  )
}
