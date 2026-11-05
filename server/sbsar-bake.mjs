// 本地 Substance 烘焙桥。
//
// 为什么需要这个桥、而不是把 Adobe 引擎移植成 WebAssembly：
//   * Blender 插件只是 Python UI（Substance3DInBlender.zip），底层是 **Substance 3D Integration Tools**，
//     即各平台的原生引擎二进制（Windows DLL / macOS dylib / Linux .so）。该引擎闭源、依赖 GPU
//     （D3D11 / OpenGL / Vulkan）、按用户授权，且只能在登录 Adobe 后下载；没有源码因此无法编译到
//     wasm，x86-64 机器码 + GPU 调用也无法机械翻译，EULA 亦禁止逆向与再分发。
//   * 因此唯一合理的架构是：让引擎留在它能合法运行的地方（本机 SAT 或 Blender 集成工具），
//     只把**结果**流回浏览器。本模块就是这个桥：服务端调用 `sbsrender`，把烘焙出的贴图当作普通
//     素材导入素材库，再由应用接线成材质。
//
// 优雅降级：没有 SAT 时 bakeStatus() 会说明原因、UI 提示安装什么，绝不崩溃，也绝不假装烘焙成功。
//
// 对外接口（server/index.js 挂载）：
//   GET  /api/sbsar/bake/status → bakeStatus()
//   POST /api/sbsar/bake        → bakeSbsar() + readBakedFile() + cleanupBake()
//
// 安全边界：
//   * 只执行找到的 sbsrender 可执行文件，参数以数组形式传给 execFile（不经 shell，无注入面）；
//   * 15 分钟超时、stdout/stderr 缓冲上限 8 MB、日志只保留尾部 8000 字符；
//   * 参数覆盖先经 normalizeParamValue 校验类型/范围，非法值跳过而不写进命令行；
//   * 临时目录使用 mkdtemp 创建，失败与无输出路径都会清理，调用方负责 finally 清理。
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
/**
 * 查找本机安装的 Substance 3D Player（仅用于提示，不是烘焙后端）。
 * 顺序：环境变量 SBSAR_PLAYER / SUBSTANCE_PLAYER / SUBSTANCE_PLAYER_DIR（可给目录）→ 已知安装路径。
 * @returns {{path:string,source:string}|null}
 */
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
/**
 * 查找 sbsrender：显式环境变量 → SUBSTANCE_SAT_HOME → 已知安装目录 → PATH（where/which）。
 * 只做文件存在性判断；找不到返回 null，由调用方给出安装提示。
 * @returns {{path:string,source:string}|null}
 */
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
/**
 * 烘焙能力探测结果（UI 决定是否展示烘焙按钮、以及解释为何不可用）。
 * @returns {{available:boolean,sbsrender:string|null,source:string|null,paramBake:boolean,player:{path:string,source:string,batch:boolean}|null,platform:string,installUrl:string,reason:string|null}}
 */
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
/**
 * 按文件名猜测 PBR 通道（去扩展名后匹配正则表），识别不出返回 null。
 * 仅用于给烘焙产物打标签，最终以用户/图配置为准。
 * @param {string} name 文件名
 * @returns {string|null} basecolor/normal/roughness/metallic/height/ao/emissive/opacity
 */
export const detectChannel = (name) => {
  const base = String(name || '').replace(/\.[a-z0-9]+$/i, '')
  const hit = CHANNEL_PATTERNS.find(([, re]) => re.test(base))
  return hit ? hit[0] : null
}

const VECTOR_KINDS = new Set(['vector2', 'vector3', 'vector4', 'color'])

/** round a number for the command line without scientific notation */
/**
 * 为命令行格式化数字：保留最多 6 位小数并去掉科学计数法；非有限数返回 null。
 * @param {number} n
 * @returns {string|null}
 */
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
/**
 * 把 UI 值转成 sbsrender `--set-value <id>@<value>` 需要的字符串。
 * bool → 1/0；enum → 索引（接受数字或枚举文案）；vector/color → 逗号分隔并夹到 min/max；
 * 标量 → 数字并夹到 min/max。无法表示时返回 null（调用方跳过，避免把垃圾写进命令行）。
 * @param {object} param 参数定义（kind/type、min、max、enumItems、default）
 * @param {unknown} raw UI 原值
 * @returns {string|null}
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
 * 根据 UI 参数值生成烘焙图的 `--set-value` 参数列表。
 * `$outputsize` 被刻意排除：它由请求的分辨率统一驱动，避免两者冲突。
 * 与参数默认值相同的覆盖会被省略（不产生无意义参数）；未知 id 或非法值进入 skipped。
 *
 * @param {Record<string,any>|Array<{id:string,value:any}>} values 对象或 [{id,value}] 数组
 * @param {Array<object>} parameters 检查结果中的 parameters（含 id/kind/min/max/enumItems/default）
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
    // 与烘焙时的默认值一致就不必传：既减少命令行长度，也避免某些版本的 sbsrender 报重复设置。
    if (def !== null && def === value) continue // already the cooked default: nothing to override
    args.push('--set-value', `${id}@${value}`)
    applied.push({ id, value })
  }
  return { args, applied, skipped }
}

/**
 * 把一个 .sbsar 的所有输出烘焙成临时目录里的 PNG 文件。
 * 调用 `sbsrender render`：输出命名 {inputName}_{outputNodeName}、格式 png、位深 16、不生成报告；
 * 用 `--set-value $outputsize@res,res` 控制分辨率，其余覆盖来自 buildSetValueArgs。
 * 失败时清理临时目录并抛出带 code 的错误：SAT_MISSING / FILE_MISSING / BAKE_FAILED / NO_OUTPUT。
 * @param {object} opts
 * @param {string} opts.file      .sbsar 的绝对路径
 * @param {number} [opts.res]     $outputsize 分辨率（默认 2048）
 * @param {string} [opts.graph]   可选 graph url，只渲染指定图
 * @param {Record<string,any>} [opts.params]  参数覆盖（id → value）
 * @param {Array<object>} [opts.parameters]   用于校验覆盖的检查结果参数表
 * @returns {Promise<{files:{name:string,path:string,bytes:number,channel:string|null}[], log:string, dir:string, applied:{id:string,value:string}[], skipped:string[]}>}
 *          成功时 dir 由调用方负责 cleanupBake
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
/**
 * 读取一个烘焙产物（API 随后把它导入素材库）。
 * @param {string} p 文件绝对路径
 * @returns {Buffer}
 */
export function readBakedFile(p) {
  return readFileSync(p)
}

/** remove a bake scratch dir */
/**
 * 递归删除烘焙临时目录；失败静默忽略（清理不应影响主流程）。
 * @param {string} dir 临时目录
 * @returns {void}
 */
export function cleanupBake(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    /* ignore */
  }
}

/** mkdir helper used by the API for its own scratch space */
/**
 * 递归创建目录（已存在则忽略），返回同一路径便于链式调用。
 * @param {string} p
 * @returns {string}
 */
export function ensureDir(p) {
  mkdirSync(p, { recursive: true })
  return p
}
