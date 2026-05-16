import tinycolor from 'tinycolor2'
import type { GraphNode } from '@ecto/shared'
import { getGraph, getNode, updateNodeData } from './repo.js'

// ── Color CSS properties ────────────────────────────────────────────

const COLOR_PROPERTIES = new Set([
  'color', 'background-color', 'border-color',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'outline-color', 'fill', 'stroke', 'text-decoration-color', 'accent-color',
  'caret-color', 'column-rule-color',
])

const SKIP_VALUES = new Set([
  'inherit', 'initial', 'unset', 'currentcolor', 'transparent', 'none', 'revert',
])

// ── Color parsing (handles deconstructed tokens like "123, 168, 255") ──

/**
 * Try to parse any color value into a tinycolor instance.
 * Handles: hex, rgb(), rgba(), hsl(), hsla(), named colors,
 * AND bare comma-separated RGB triples like "123, 168, 255".
 */
function parseAnyColor(value: string): tinycolor.Instance | null {
  value = value.trim()

  // Standard CSS color — tinycolor handles hex, rgb(), hsl(), named
  const tc = tinycolor(value)
  if (tc.isValid()) return tc

  // Deconstructed RGB: "123, 168, 255" (used with rgb(var(--token)))
  const bareRgb = value.match(/^\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*$/)
  if (bareRgb) {
    const r = parseInt(bareRgb[1])
    const g = parseInt(bareRgb[2])
    const b = parseInt(bareRgb[3])
    if (r <= 255 && g <= 255 && b <= 255) {
      return tinycolor({ r, g, b })
    }
  }

  // Deconstructed RGBA: "123, 168, 255, 0.5"
  const bareRgba = value.match(/^\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*([\d.]+)\s*$/)
  if (bareRgba) {
    const r = parseInt(bareRgba[1])
    const g = parseInt(bareRgba[2])
    const b = parseInt(bareRgba[3])
    const a = parseFloat(bareRgba[4])
    if (r <= 255 && g <= 255 && b <= 255 && a >= 0 && a <= 1) {
      return tinycolor({ r, g, b, a })
    }
  }

  return null
}

function isColorValue(value: string): boolean {
  value = value.trim().toLowerCase()
  if (value.startsWith('var(')) return false
  if (SKIP_VALUES.has(value)) return false
  return parseAnyColor(value) !== null
}

/**
 * Perceptual color distance using CIEDE2000 approximation.
 * tinycolor doesn't have CIEDE2000, but we can use a weighted Euclidean
 * in Lab space which is much better than raw RGB distance.
 */
function perceptualDistance(a: tinycolor.Instance, b: tinycolor.Instance): number {
  const labA = rgbToLab(a.toRgb())
  const labB = rgbToLab(b.toRgb())
  // Weighted Lab Euclidean — gives perceptually uniform-ish results
  const dL = labA.l - labB.l
  const da = labA.a - labB.a
  const db = labA.b - labB.b
  return Math.sqrt(dL * dL + da * da + db * db)
}

function rgbToLab(rgb: { r: number; g: number; b: number }): { l: number; a: number; b: number } {
  // sRGB → XYZ → Lab
  let r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255
  r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92
  g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92
  b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92
  let x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047
  let y = (r * 0.2126729 + g * 0.7151522 + b * 0.0721750)
  let z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883
  const f = (t: number) => t > 0.008856 ? Math.pow(t, 1 / 3) : 7.787 * t + 16 / 116
  x = f(x); y = f(y); z = f(z)
  return { l: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) }
}

// ── Palette ─────────────────────────────────────────────────────────

export interface PaletteColor {
  /** Token name like "--clover-cyan" or hex like "#7ba8ff" */
  name: string
  /** How this color should be used in CSS (e.g. "rgb(var(--clover-cyan))" or "#7ba8ff") */
  cssUsage: string
  /** The tinycolor instance for comparison */
  tc: tinycolor.Instance
}

/**
 * Build the project's color palette from style_token nodes and existing
 * style declarations. Understands deconstructed tokens (bare RGB triples).
 */
export function extractPalette(projectId: string, excludeNodeId?: string): PaletteColor[] {
  const { nodes } = getGraph(projectId)
  const colors: PaletteColor[] = []
  const seenHex = new Set<string>()

  const addColor = (name: string, cssUsage: string, tc: tinycolor.Instance) => {
    const hex = tc.toHex8String()
    if (seenHex.has(hex)) return
    seenHex.add(hex)
    colors.push({ name, cssUsage, tc })
  }

  // 1. Style tokens — the canonical design system
  for (const n of nodes) {
    if (n.type !== 'style_token') continue
    const tokName = (n.data?.tokenName as string) ?? n.name
    const tokVal = (n.data?.value as string) ?? ''
    const tc = parseAnyColor(tokVal)
    if (!tc) continue

    // Determine the correct CSS usage pattern:
    // - If the token value is a bare RGB triple (deconstructed), use rgb(var(--name))
    // - Otherwise use var(--name) directly
    const isBareRgb = /^\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?$/.test(tokVal)
    const cssUsage = isBareRgb
      ? `rgb(var(--${tokName}))`
      : `var(--${tokName})`

    addColor(`--${tokName}`, cssUsage, tc)
  }

  // 2. Colors from all other style declarations (the "in-use" palette)
  for (const n of nodes) {
    if (n.type !== 'style') continue
    if (n.id === excludeNodeId) continue
    const decls = n.data?.declarations as Record<string, string> | undefined
    if (!decls) continue
    for (const [prop, val] of Object.entries(decls)) {
      if (!COLOR_PROPERTIES.has(prop)) continue
      if (!isColorValue(val)) continue
      const tc = parseAnyColor(val)
      if (tc) addColor(tc.toHexString(), val, tc)
    }
  }

  return colors
}

// ── Violation detection ─────────────────────────────────────────────

export interface ColorViolation {
  styleNodeId: string
  elementNodeId: string | null
  property: string
  actualColor: string
  closestSystemColor: string
  closestTokenName: string | null
  correctedValue: string
}

// Track recently corrected properties to prevent infinite loops
const recentCorrections = new Set<string>()

function correctionKey(nodeId: string, prop: string): string {
  return `${nodeId}:${prop}`
}

/**
 * Minimum perceptual distance (in CIE Lab space) to flag as "off-palette".
 * ~3 is a just-noticeable difference; we use 5 to allow slight rounding.
 */
const TOLERANCE = 5

/**
 * Check a style node's color declarations against the project palette.
 * Re-reads the node from DB to get the latest state.
 */
export function checkAndCorrectColors(
  projectId: string,
  styleNodeId: string,
): { violations: ColorViolation[]; correctedNode: GraphNode | null } {
  const styleNode = getNode(projectId, styleNodeId)
  if (!styleNode || styleNode.type !== 'style') return { violations: [], correctedNode: null }

  const decls = styleNode.data?.declarations as Record<string, string> | undefined
  if (!decls) return { violations: [], correctedNode: null }

  const palette = extractPalette(projectId, styleNode.id)
  if (palette.length === 0) return { violations: [], correctedNode: null }

  // Find the element this style is applied to
  const { edges } = getGraph(projectId)
  const elementEdge = edges.find(e => e.type === 'styles' && e.toNodeId === styleNode.id)
  const elementNodeId = elementEdge?.fromNodeId ?? null

  const violations: ColorViolation[] = []
  const correctedDecls = { ...decls }
  let hasFixes = false

  for (const [prop, val] of Object.entries(decls)) {
    if (!COLOR_PROPERTIES.has(prop)) continue
    if (!isColorValue(val)) continue

    const key = correctionKey(styleNode.id, prop)
    if (recentCorrections.has(key)) continue

    const tc = parseAnyColor(val)
    if (!tc) continue

    // Find closest palette color using perceptual distance
    let bestDist = Infinity
    let bestColor = palette[0]
    for (const pc of palette) {
      const d = perceptualDistance(tc, pc.tc)
      if (d < bestDist) {
        bestDist = d
        bestColor = pc
      }
    }

    if (bestDist > TOLERANCE) {
      violations.push({
        styleNodeId: styleNode.id,
        elementNodeId,
        property: prop,
        actualColor: val,
        closestSystemColor: bestColor.tc.toHexString(),
        closestTokenName: bestColor.name.startsWith('--') ? bestColor.name : null,
        correctedValue: bestColor.cssUsage,
      })

      correctedDecls[prop] = bestColor.cssUsage
      hasFixes = true

      recentCorrections.add(key)
      setTimeout(() => recentCorrections.delete(key), 5000)
    }
  }

  if (!hasFixes) return { violations, correctedNode: null }

  // Also fix the rules array to match
  const rules = styleNode.data?.rules as Array<{ selector: string; declarations: Record<string, string> }> | undefined
  const correctedRules = rules?.map(r => ({
    ...r,
    declarations: { ...r.declarations },
  }))
  if (correctedRules) {
    for (const v of violations) {
      for (const r of correctedRules) {
        if (r.declarations[v.property] === v.actualColor) {
          r.declarations[v.property] = v.correctedValue
        }
      }
    }
  }

  const patch: Record<string, any> = { declarations: correctedDecls }
  if (correctedRules) patch.rules = correctedRules
  const correctedNode = updateNodeData(projectId, styleNode.id, patch)

  return { violations, correctedNode }
}

// ── Design System Manifest ──────────────────────────────────────────

export interface DesignSystemManifest {
  generatedAt: string
  projectId: string
  colorTokens: Array<{
    tokenName: string
    value: string
    hex: string
    cssUsage: string
    scopes: string[]
    isDeconstructed: boolean
  }>
  inUseColors: Array<{
    hex: string
    usedIn: Array<{ styleNodeId: string; property: string }>
  }>
  summary: string
}

/**
 * Generate a design system manifest for a project. This provides a
 * machine-readable + human-readable summary of the project's color
 * system that background agents can reference.
 */
export function generateDesignSystemManifest(projectId: string): DesignSystemManifest {
  const { nodes, edges } = getGraph(projectId)

  // 1. Collect all color tokens
  const colorTokens: DesignSystemManifest['colorTokens'] = []
  for (const n of nodes) {
    if (n.type !== 'style_token') continue
    const tokName = (n.data?.tokenName as string) ?? n.name
    const tokVal = (n.data?.value as string) ?? ''
    const scopes = (n.data?.scopes as string[]) ?? []
    const tc = parseAnyColor(tokVal)
    if (!tc) continue

    // Check if this is a color token by name or by value
    const nameLower = tokName.toLowerCase()
    const isColorName = /color|bg|background|border|shadow|fill|stroke|accent|primary|secondary|neutral|gray|grey|brand|surface|foreground|text|link|hover|focus|active|muted|subtle|bold|highlight|overlay|cyan|blue|red|green|yellow|orange|pink|purple|violet|indigo|teal|white|black|dark|light/.test(nameLower)
    if (!isColorName && !tc) continue

    const isBareRgb = /^\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?$/.test(tokVal)
    colorTokens.push({
      tokenName: `--${tokName}`,
      value: tokVal,
      hex: tc.toHexString(),
      cssUsage: isBareRgb ? `rgb(var(--${tokName}))` : `var(--${tokName})`,
      scopes,
      isDeconstructed: isBareRgb,
    })
  }

  // 2. Collect in-use colors from style declarations
  const colorUsageMap = new Map<string, Array<{ styleNodeId: string; property: string }>>()
  for (const n of nodes) {
    if (n.type !== 'style') continue
    const decls = n.data?.declarations as Record<string, string> | undefined
    if (!decls) continue
    for (const [prop, val] of Object.entries(decls)) {
      if (!COLOR_PROPERTIES.has(prop)) continue
      if (val.startsWith('var(')) continue
      if (SKIP_VALUES.has(val.trim().toLowerCase())) continue
      const tc = parseAnyColor(val)
      if (!tc) continue
      const hex = tc.toHexString()
      const arr = colorUsageMap.get(hex) ?? []
      arr.push({ styleNodeId: n.id, property: prop })
      colorUsageMap.set(hex, arr)
    }
  }

  const inUseColors = [...colorUsageMap.entries()].map(([hex, usedIn]) => ({ hex, usedIn }))

  // 3. Build summary
  const lines: string[] = []
  if (colorTokens.length > 0) {
    const deconstructed = colorTokens.filter(t => t.isDeconstructed)
    lines.push(`${colorTokens.length} color tokens defined.`)
    if (deconstructed.length > 0) {
      lines.push(`${deconstructed.length} use deconstructed RGB (bare triples like "123, 168, 255") — reference with rgb(var(--name)).`)
    }
    const standard = colorTokens.filter(t => !t.isDeconstructed)
    if (standard.length > 0) {
      lines.push(`${standard.length} use standard values — reference with var(--name).`)
    }
  }
  lines.push(`${inUseColors.length} unique colors in use across style declarations.`)

  return {
    generatedAt: new Date().toISOString(),
    projectId,
    colorTokens,
    inUseColors,
    summary: lines.join(' '),
  }
}
