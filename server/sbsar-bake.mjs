// Local Substance bake bridge.
//
// Why this exists instead of a WebAssembly port of Adobe's engine:
//   * The Blender add-on is a Python UI (Substance3DInBlender.zip) on top of the **Substance 3D
//     Integration Tools** — per-platform *native* engine binaries (Windows DLL / macOS dylib / Linux
//     .so). That engine is closed-source, GPU-backed (D3D11 / OpenGL / Vulkan) and licensed per user;
//     downloadable only after an Adobe sign-in. It cannot be compiled to wasm (no sources), cannot be
//     mechanically translated (x86-64 machine code + GPU API calls), and the EULA forbids
//     reverse-engineering/redistribution.
//   * So the only sane architecture is: keep the engine where it legally runs (locally installed SAT
//     or Blender's integration tools) and stream the *results* into the browser. This module is that
//     bridge: the studio server shells out to `sbsrender` (SAT) and imports the baked maps as normal
//     library assets, which the app then wires into a material.
//
// Everything degrades gracefully: with no SAT installed, `bakeStatus()` reports why and the UI explains
// what to install; nothing crashes and nothing pretends to bake.
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const SAT_DOWNLOAD = 'https://helpx.adobe.com/substance-3d-sat/'
const TIMEOUT_MS = 15 * 60 * 1000

const SAT_HINTS = [
  'C:/Program Files/Allegorithmic/Substance Automation Toolkit/sbsrender.exe',
  'C:/Program Files/Adobe/Substance 3D Automation Toolkit/sbsrender.exe',
  '/Applications/Substance Automation Toolkit/sbsrender',
  '/opt/Substance Automation Toolkit/sbsrender'
]

// Substance 3D Player (free viewer). It embeds the same cooked-graph engine as sbsrender but exposes
// no batch/C LI entry point: it drives the engine through an internal "Cooking → Linker" pipeline that
// is statically linked into the Qt executable, so the engine assembly it feeds the engine DLL cannot be
// produced from the outside. Detection is therefore informational (the user can open/preview/export
// manually), *not* a bake provider. See docs/reports/sbsar-engine-re/REPORT.md for the evidence.
const PLAYER_HINTS = [
  'D:/Substance Player/Substance Player.exe',
  'C:/Program Files/Adobe/Substance 3D Player/Substance Player.exe',
  'C:/Program Files/Adobe/Substance Player/Substance Player.exe',
  'C:/Program Files/Allegorithmic/Substance Player/Substance Player.exe',
  '/Applications/Substance 3D Player.app/Contents/MacOS/Substance 3D Player'
]

/** locate a locally installed Substance 3D Player (information only, not a bake backend) */
export function findPlayer() {
  for (const key of ['SBSAR_PLAYER', 'SUBSTANCE_PLAYER', 'SUBSTANCE_PLAYER_DIR']) {
    const value = process.env[key]
    if (!value) continue
    const candidates = /\.exe$|Player$/i.test(value)
      ? [value]
      : [path.join(value, 'Substance Player.exe'), path.join(value, 'Substance Player')]
    for (const candidate of candidates) if (existsSync(candidate)) return { path: candidate, source: 'env:' + key }
  }
  for (const c of PLAYER_HINTS) if (existsSync(c)) return { path: c, source: 'known-path' }
  return null
}

/** locate sbsrender: explicit env/config → known install dirs → PATH */
export function findSbsrender() {
  const explicit = process.env.SBSRENDER
  if (explicit && existsSync(explicit)) return { path: explicit, source: 'env:SBSRENDER' }
  const home = process.env.SUBSTANCE_SAT_HOME
  if (home) {
    for (const candidate of [path.join(home, 'sbsrender.exe'), path.join(home, 'bin', 'sbsrender.exe'), path.join(home, 'sbsrender')]) {
      if (existsSync(candidate)) return { path: candidate, source: 'env:SUBSTANCE_SAT_HOME' }
    }
  }
  for (const c of SAT_HINTS) if (existsSync(c)) return { path: c, source: 'known-path' }
  try {
    const which = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(which, ['sbsrender'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const first = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean)
    if (first && existsSync(first)) return { path: first, source: 'PATH' }
  } catch (e) {
    /* not installed */
  }
  return null
}

/** what the UI needs to know before offering a bake button */
export function bakeStatus() {
  const found = findSbsrender()
  const player = findPlayer()
  return {
    available: !!found,
    sbsrender: found ? found.path : null,
    source: found ? found.source : null,
    // exact rendering needs Adobe's native, per-user-licensed engine; the browser cannot do it
    paramBake: !!found,
    player: player ? { path: player.path, source: player.source, batch: false } : null,
    platform: process.platform,
    installUrl: SAT_DOWNLOAD,
    reason: found
      ? player
        ? null
        : 'The Substance 3D Player was found. It can render with the same native engine, but it has no batch/C LI entry point (its cook→link step is statically linked into the Qt executable), so it cannot be driven from here — bakes use sbsrender.'
      : player
        ? 'Only the Substance 3D Player was found. It uses Adobe\'s native engine but exposes no batch entry point (its cook→link step is internal), so parameter-aware bakes need the Substance Automation Toolkit (sbsrender).'
        : 'Adobe Substance Automation Toolkit (sbsrender) was not found. The Substance engine is native, closed-source and licensed per user, so it cannot be shipped as WebAssembly; install SAT (or the Blender integration tools) and the studio will drive it locally.'
  }
}

const CHANNEL_PATTERNS = [
  ['basecolor', /(base ?colou?r|albedo|diffuse|_diff|_bc\b)/i],
  ['normal', /(normal|_nor\b|_nrm\b|_n\b)/i],
  ['roughness', /(rough|_r\b|rgh)/i],
  ['metallic', /(metal|_m\b|mtl)/i],
  ['height', /(height|displac|_disp|_h\b|elev)/i],
  ['ao', /(occlusion|ambient|_ao\b|\bao_|_ao)/i],
  ['emissive', /(emiss|glow)/i],
  ['opacity', /(opacity|alpha|_mask\b)/i]
]
export const detectChannel = (name) => {
  const base = String(name || '').replace(/\.[a-z0-9]+$/i, '')
  const hit = CHANNEL_PATTERNS.find(([, re]) => re.test(base))
  return hit ? hit[0] : null
}

const VECTOR_KINDS = new Set(['vector2', 'vector3', 'vector4', 'color'])

/** round a number for the command line without scientific notation */
function fmtNumber(n) {
  if (!Number.isFinite(n)) return null
  const r = Math.round(n * 1e6) / 1e6
  return String(r)
}

/**
 * Turn one UI value into the string sbsrender expects in `--set-value <id>@<value>`.
 * Enum parameters take their index, booleans take 0/1, vectors a comma separated list.
 * Returns null when the value cannot be represented (caller skips it instead of writing garbage).
 */
export function normalizeParamValue(param, raw) {
  if (raw === null || raw === undefined || raw === '') return null
  const kind = String(param.kind || param.type || '').toLowerCase()
  if (kind === 'bool' || kind === 'boolean') {
    if (typeof raw === 'boolean') return raw ? '1' : '0'
    const s = String(raw).trim().toLowerCase()
    if (s === 'true' || s === '1' || s === 'on') return '1'
    if (s === 'false' || s === '0' || s === 'off') return '0'
    return null
  }
  if (kind === 'enum') {
    const items = param.enumItems || []
    if (typeof raw === 'number' || /^\d+$/.test(String(raw).trim())) {
      const idx = Number(raw)
      return Number.isInteger(idx) && idx >= 0 ? String(idx) : null
    }
    const label = String(raw).trim().toLowerCase()
    const idx = items.findIndex((i) => String(i).toLowerCase() === label)
    return idx >= 0 ? String(idx) : null
  }
  if (VECTOR_KINDS.has(kind) || Array.isArray(raw) || String(raw).includes(',')) {
    const parts = (Array.isArray(raw) ? raw : String(raw).split(','))
      .map((v) => Number(v))
      .map((v) => (param.min != null ? Math.max(Number(param.min), v) : v))
      .map((v) => (param.max != null ? Math.min(Number(param.max), v) : v))
    if (!parts.length || parts.some((v) => !Number.isFinite(v))) return null
    return parts.map(fmtNumber).join(',')
  }
  let n = Number(raw)
  if (!Number.isFinite(n)) return null
  if (param.min != null) n = Math.max(Number(param.min), n)
  if (param.max != null) n = Math.min(Number(param.max), n)
  return fmtNumber(n)
}

/**
 * Build the `--set-value` argument list for a baked graph from UI parameter values.
 * `$outputsize` is deliberately excluded: it is driven by the requested resolution.
 *
 * @param {Record<string,any>|Array<{id:string,value:any}>} values
 * @param {Array<object>} parameters  the inspection's `parameters` array (id/kind/min/max/enumItems)
 * @returns {{args:string[], applied:{id:string,value:string}[], skipped:string[]}}
 */
export function buildSetValueArgs(values, parameters = []) {
  const byId = new Map((parameters || []).map((p) => [String(p.id), p]))
  const entries = Array.isArray(values)
    ? values.map((v) => [String(v && v.id), v ? v.value : undefined])
    : Object.entries(values || {})
  const args = []
  const applied = []
  const skipped = []
  for (const [id, raw] of entries) {
    if (!id || id === '$outputsize') continue
    const param = byId.get(id)
    if (!param) {
      skipped.push(id)
      continue
    }
    const value = normalizeParamValue(param, raw)
    if (value === null) {
      skipped.push(id)
      continue
    }
    const def = normalizeParamValue(param, param.default)
    if (def !== null && def === value) continue // already the cooked default: nothing to override
    args.push('--set-value', `${id}@${value}`)
    applied.push({ id, value })
  }
  return { args, applied, skipped }
}

/**
 * Bake every output of a .sbsar into PNG files inside a scratch directory.
 * @param {object} opts
 * @param {string} opts.file      absolute path of the .sbsar on disk
 * @param {number} [opts.res]     resolution for $outputsize (default 2048)
 * @param {string} [opts.graph]   optional graph url to render only one graph
 * @param {Record<string,any>} [opts.params]  parameter overrides (id → value) applied with --set-value
 * @param {Array<object>} [opts.parameters]   the inspection parameter list used to validate overrides
 * @returns {Promise<{files:{name:string,path:string,bytes:number,channel:string|null}[], log:string, dir:string, applied:{id:string,value:string}[], skipped:string[]}>}
 */
export function bakeSbsar({ file, res = 2048, graph = null, params = null, parameters = [] }) {
  const found = findSbsrender()
  if (!found) {
    const err = new Error(bakeStatus().reason)
    err.code = 'SAT_MISSING'
    throw err
  }
  if (!existsSync(file)) {
    const err = new Error('Archive file not found: ' + file)
    err.code = 'FILE_MISSING'
    throw err
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'sbsar-bake-'))
  const args = [
    'render',
    '--input',
    file,
    '--output-path',
    dir,
    '--output-name',
    '{inputName}_{outputNodeName}',
    '--output-format',
    'png',
    '--output-bit-depth',
    '16',
    '--no-report'
  ]
  if (graph) args.push('--input-graph', graph)
  args.push('--set-value', `$outputsize@${res},${res}`)

  // parameter overrides (the "edit" half of the workbench): validated against the archive interface
  const overrides = buildSetValueArgs(params || {}, parameters)
  args.push(...overrides.args)

  return new Promise((resolve, reject) => {
    execFile(found.path, args, { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const log = [String(stdout || '').trim(), String(stderr || '').trim()].filter(Boolean).join('\n').slice(-8000)
      if (error) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch (e) {
          /* ignore */
        }
        const err = new Error('sbsrender failed: ' + (log.split('\n').slice(-3).join(' ') || error.message))
        err.code = 'BAKE_FAILED'
        err.log = log
        return reject(err)
      }
      let files = []
      try {
        files = readdirSync(dir)
          .filter((f) => /\.(png|tga|tif{1,2}|exr)$/i.test(f))
          .map((f) => {
            const p = path.join(dir, f)
            return { name: f, path: p, bytes: statSync(p).size, channel: detectChannel(f) }
          })
      } catch (e) {
        /* ignore */
      }
      if (!files.length) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch (e) {
          /* ignore */
        }
        const err = new Error('sbsrender produced no image files (log tail: ' + log.split('\n').slice(-2).join(' ') + ')')
        err.code = 'NO_OUTPUT'
        err.log = log
        return reject(err)
      }
      resolve({ files, log, dir, applied: overrides.applied, skipped: overrides.skipped })
    })
  })
}

/** read one baked file back as a buffer (the API imports it into the asset library) */
export function readBakedFile(p) {
  return readFileSync(p)
}

/** remove a bake scratch dir */
export function cleanupBake(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    /* ignore */
  }
}

/** mkdir helper used by the API for its own scratch space */
export function ensureDir(p) {
  mkdirSync(p, { recursive: true })
  return p
}
