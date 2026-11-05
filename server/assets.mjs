// 素材库（材质素材）本地存储：导入的位图与 .sbsar 归档都放在服务端 assets/ 目录，
// 由 /assets/<file> 直接对外提供；元数据统一记录在 assets/index.json（数组，一条一个素材）。
//
// 职责：
//   * 导入：data URL 图片（PNG/JPEG/WebP）、.sbsar 归档、公网 URL 图片；
//   * 查询：列表（过滤回收站）、原始索引条目（供引用关系分析）、在线图库搜索；
//   * 生命周期：软删除（deletedAt 标记，文件保留）→ 还原 → 永久删除（deleteAsset）；
//   * 归档：解包时把内嵌位图登记为子素材（parentId 指向归档 id），检查报告缓存为 sbsar-<id>.json。
//
// 与其他模块的关系：sbsar.mjs 提供归档解析，index.js 负责 HTTP 路由与引用校验（usage.mjs）。
// 安全边界：
//   * 只接受 PNG/JPEG/WebP，且校验文件头签名必须与声明的 MIME 一致（防止把任意文件伪装成图片）；
//   * 单图上限 32 MB、归档上限 64 MB、素材总数上限 400 条；
//   * assetFilePath() 只允许 /assets/ 下的单段文件名，拒绝 ".." 与路径分隔符；
//   * 在线导入仅允许 http(s)，禁止回环/内网主机（SSRF 防护），重定向后二次校验。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectSbsar } from './sbsar.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ASSETS_DIR = path.join(ROOT, 'assets')
const INDEX_PATH = path.join(ASSETS_DIR, 'index.json')
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
// 限额集中定义：单图 32 MB、归档 64 MB、素材总数 400。调大任何一项都会放大磁盘与内存压力。
const MAX_BYTES = 32 * 1024 * 1024
const MAX_SBSAR_BYTES = 64 * 1024 * 1024
const MAX_ASSETS = 400

/**
 * 确保 assets/ 目录与 index.json 存在（首次运行时写入空数组）。
 * 所有对外函数在读写索引前都会调用它，可重复执行。
 * @returns {void}
 */
export function initAssets() {
  mkdirSync(ASSETS_DIR, { recursive: true })
  if (!existsSync(INDEX_PATH)) writeFileSync(INDEX_PATH, '[]', 'utf8')
}

/**
 * 读取素材索引。文件缺失/损坏/不是数组时返回空数组（不抛错，保证服务可用）。
 * @returns {object[]} 原始索引条目（含已软删除项）
 */
function readIndex() {
  try {
    const list = JSON.parse(readFileSync(INDEX_PATH, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

/**
 * 把索引数组整体写回 index.json（2 空格缩进，UTF-8）。
 * @param {object[]} list 完整索引数组
 * @returns {void}
 */
function writeIndex(list) {
  writeFileSync(INDEX_PATH, JSON.stringify(list, null, 2), 'utf8')
}

/**
 * 把索引条目转成对外（浏览器可见）的素材对象。
 * 归档额外暴露 inspectionUrl / inspection 摘要 / children；其余只给必要字段，避免泄露内部细节。
 * @param {object} entry 索引条目
 * @returns {object} 公开素材对象
 */
function publicAsset(entry) {
  const base = {
    id: entry.id,
    name: entry.name,
    file: entry.file,
    url: '/assets/' + entry.file,
    mime: entry.mime,
    bytes: entry.bytes,
    width: entry.width || null,
    height: entry.height || null,
    createdAt: entry.createdAt,
    attribution: entry.attribution || null,
    kind: entry.kind || 'bitmap',
    role: entry.role || null,
    parentId: entry.parentId || null
  }
  if (entry.kind === 'sbsar') {
    base.inspectionUrl = '/api/assets/sbsar?id=' + entry.id
    base.inspection = entry.inspection || null
    base.children = entry.children || []
  }
  return base
}

/**
 * 列出回收站之外的素材，按创建时间倒序。
 * @returns {object[]} 公开素材对象数组
 */
export function listAssets() {
  return readIndex()
    .filter((a) => !a.deletedAt) // the recycle bin hides soft-deleted entries
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map(publicAsset)
}

/**
 * 返回原始索引条目（含回收站项与归档子项）。引用关系分析需要 parentId / children 等内部字段，
 * 因此不能直接用 listAssets()。
 * @returns {object[]} 原始索引数组
 */
export function assetIndexEntries() {
  initAssets()
  return readIndex()
}

/**
 * 回收站中的素材根条目（归档子项随父项一起展示，不单列），按删除时间倒序。
 * @returns {object[]} 公开素材对象 + deletedAt + childCount
 */
export function listTrashedAssets() {
  const index = readIndex()
  const trashed = index.filter((a) => a.deletedAt)
  const trashedIds = new Set(trashed.map((a) => a.id))
  const roots = trashed.filter((a) => !a.parentId || !trashedIds.has(a.parentId))
  return roots
    .slice()
    .sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0))
    .map((a) => ({
      ...publicAsset(a),
      deletedAt: a.deletedAt,
      childCount: index.filter((c) => c.parentId === a.id).length
    }))
}

/**
 * Move an asset (and, for an archive, the bitmaps it extracted) into the recycle bin.
 * Files stay on disk so a restore is instant and lossless.
 */
/**
 * 把素材（归档则连同其抽取出的全部子位图）标记为回收站状态。
 * 只改索引里的 deletedAt，文件仍留在磁盘，因此还原无损且即时。
 * @param {string} id 素材 id
 * @returns {{ok:boolean,id:string,children:number,deletedAt?:number,alreadyTrashed?:boolean}}
 *          找不到素材时抛 Error('Asset not found')
 */
export function trashAsset(id) {
  initAssets()
  const index = readIndex()
  const entry = index.find((a) => a.id === id)
  if (!entry) throw new Error('Asset not found')
  if (entry.deletedAt) return { ok: true, id, children: 0, alreadyTrashed: true }
  const owned = entry.kind === 'sbsar' ? index.filter((a) => a.parentId === id) : []
  const now = Date.now()
  entry.deletedAt = now
  for (const child of owned) child.deletedAt = now
  writeIndex(index)
  return { ok: true, id, children: owned.length, deletedAt: now }
}

/** restore an asset and everything it owns */
/**
 * 还原素材（递归包含归档的所有子位图）：把 deletedAt 清零。
 * @param {string} id 素材 id
 * @returns {{ok:boolean,id:string,children:number,alreadyRestored?:boolean}}
 *          找不到素材时抛 Error('Asset not found')
 */
export function restoreAsset(id) {
  initAssets()
  const index = readIndex()
  const entry = index.find((a) => a.id === id)
  if (!entry) throw new Error('Asset not found')
  if (!entry.deletedAt) return { ok: true, id, alreadyRestored: true }
  const owned = entry.kind === 'sbsar' ? index.filter((a) => a.parentId === id) : []
  entry.deletedAt = 0
  for (const child of owned) child.deletedAt = 0
  writeIndex(index)
  return { ok: true, id, children: owned.length }
}

/** Parse a data: URL into bytes + mime, rejecting anything that is not a PNG/JPEG/WebP image. */
/**
 * 解析 `data:image/(png|jpeg|webp);base64,…` 并校验内容确实是该图片格式。
 * 校验点：严格 data URL 格式、非空、≤32 MB、PNG/JPEG/WebP 文件头签名与 MIME 一致。
 * @param {string} dataUrl
 * @returns {{mime:string,buffer:Buffer}}
 * @throws {Error} 不支持的类型 / 空图 / 过大 / 签名不匹配
 */
export function decodeDataUrl(dataUrl) {
  const text = String(dataUrl || '')
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(text)
  if (!match) throw new Error('Unsupported image data URL (PNG/JPEG/WebP only)')
  const mime = match[1]
  const buffer = Buffer.from(match[2], 'base64')
  if (!buffer.length) throw new Error('Empty image')
  if (buffer.length > MAX_BYTES) throw new Error('Image is too large (max 32 MB)')
  // 声明的 MIME 不可信：必须用文件头签名二次确认，防止任意文件伪装成图片入库。
  const sig = buffer.subarray(0, 12)
  const isPng = sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47
  const isJpeg = sig[0] === 0xff && sig[1] === 0xd8 && sig[2] === 0xff
  const isWebp = buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  if ((mime === 'image/png' && !isPng) || (mime === 'image/jpeg' && !isJpeg) || (mime === 'image/webp' && !isWebp)) {
    throw new Error('File signature does not match its image type')
  }
  return { mime, buffer }
}

/**
 * 从 PNG 头部（IHDR）读宽高。非法/过短返回 null。
 * @param {Buffer} buf PNG 字节
 * @returns {{width:number,height:number}|null}
 */
function readPngSize(buf) {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * 扫描 JPEG 的 SOF 段读出宽高；遇到 SOS 或越界返回 null。
 * @param {Buffer} buf JPEG 字节
 * @returns {{width:number,height:number}|null}
 */
function readJpegSize(buf) {
  let offset = 2
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = buf[offset + 1]
    const length = buf.readUInt16BE(offset + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) }
    }
    offset += 2 + length
  }
  return null
}

/**
 * 清洗素材显示名：去掉文件系统非法字符，截断到 80 字符；为空时用 id 前 6 位兜底。
 * @param {string} name 用户提供的名称
 * @param {string} id 素材 id
 * @returns {string}
 */
const cleanAssetName = (name, id) =>
  String(name || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .slice(0, 80) || 'Asset ' + id.slice(0, 6)

/** Write one decoded image into the library and return its index entry. */
/**
 * 把解码后的图片写入素材库并登记索引。
 * id 为内容的 SHA-1 前 12 位（天然去重：同一张图重复导入直接返回旧条目）。
 * 会再校验一次大小与总数上限，必要时读出宽高。
 * @param {{buffer:Buffer,mime:string,name:string,extra?:object}} opts
 * @returns {object} 索引条目（可能为已存在的同 id 条目）
 * @throws {Error} 图片过大 / 素材库已满
 */
function storeImage({ buffer, mime, name, extra = {} }) {
  if (buffer.length > MAX_BYTES) throw new Error('Image is too large (max 32 MB)')
  const id = createHash('sha1').update(buffer).digest('hex').slice(0, 12)
  const index = readIndex()
  const existing = index.find((a) => a.id === id)
  if (existing) return existing
  if (index.length >= MAX_ASSETS) throw new Error('Asset library is full (max ' + MAX_ASSETS + ' files)')
  const file = id + '.' + (MIME_EXT[mime] || 'png')
  writeFileSync(path.join(ASSETS_DIR, file), buffer)
  const size = (mime === 'image/png' ? readPngSize(buffer) : mime === 'image/jpeg' ? readJpegSize(buffer) : null) || {}
  const entry = {
    id,
    name: cleanAssetName(name, id),
    file,
    mime,
    bytes: buffer.length,
    width: size.width || null,
    height: size.height || null,
    createdAt: Date.now(),
    ...extra
  }
  index.push(entry)
  writeIndex(index)
  return entry
}

/**
 * 导入一张位图（对外 API）。
 * @param {{name:string,dataUrl:string}} input
 * @returns {object} 公开素材对象
 * @throws {Error} 解码/校验失败（见 decodeDataUrl）
 */
export function importAsset({ name, dataUrl }) {
  initAssets()
  const { mime, buffer } = decodeDataUrl(dataUrl)
  return publicAsset(storeImage({ buffer, mime, name }))
}

/** decode `data:<mime>;base64,…` or a bare base64 string (used for non-image payloads like .sbsar) */
/**
 * 解码归档负载：接受 data URL 或长度 ≥64 的裸 base64 字符串。
 * @param {string} data
 * @returns {Buffer} 归档字节
 * @throws {Error} 格式不对 / 空文件 / 超过 64 MB
 */
function decodeArchivePayload(data) {
  const text = String(data || '')
  const m = /^data:[^;,]+;base64,([A-Za-z0-9+/=]+)$/.exec(text) || /^([A-Za-z0-9+/=]{64,})$/.exec(text)
  if (!m) throw new Error('Expected base64 data (data URL or bare base64)')
  const buffer = Buffer.from(m[1], 'base64')
  if (!buffer.length) throw new Error('Empty file')
  if (buffer.length > MAX_SBSAR_BYTES) throw new Error('Archive is too large (max 64 MB)')
  return buffer
}

/**
 * Import a Substance archive: keep the original file, store every extracted bitmap as a normal
 * texture asset, and cache the inspection report next to it.
 *
 * NOTE: a .sbsar cannot be *evaluated* here (its .sbsasm is Adobe engine bytecode), so this import
 * yields metadata + embedded bitmaps, never a baked PBR set. `inspection.canEvaluate` is always
 * false and the UI states the reason.
 */
/**
 * 导入一个 Substance 归档：保存原始 .sbsar、把解包出的位图登记为子素材、缓存检查报告。
 * 注意：.sbsasm 是 Adobe 引擎字节码，此导入只产出元数据 + 内嵌位图，永远不产出烘焙后的 PBR 集；
 * inspection.canEvaluate 恒为 false，UI 会据此说明原因。
 * @param {{name?:string,data:string}} input data 为 data URL 或裸 base64
 * @returns {{asset:object,inspection:object}} 公开归档素材与检查摘要
 * @throws {Error} 负载/大小/总数超限，或内容不像 Substance 归档
 */
export function importSbsarAsset({ name, data }) {
  initAssets()
  const index = readIndex()
  if (index.length >= MAX_ASSETS) throw new Error('Asset library is full (max ' + MAX_ASSETS + ' files)')
  const buffer = decodeArchivePayload(data)
  const id = createHash('sha1').update(buffer).digest('hex').slice(0, 12)
  const existing = index.find((a) => a.id === id)
  if (existing) return { asset: publicAsset(existing), inspection: readSbsarInspection(id) }

  const inspection = inspectSbsar(buffer, { maxImages: 16 })
  const file = 'sbsar-' + id + '.sbsar'
  writeFileSync(path.join(ASSETS_DIR, file), buffer)

  const label = cleanAssetName(name || 'Substance archive', id).replace(/\.sbsar$/i, '')
  const children = []
  inspection.imagePayloads.forEach((payload, i) => {
    try {
      const role = payload.role === 'preview' ? 'substance-preview' : 'substance-resource'
      const entry = storeImage({
        buffer: payload.bytes,
        mime: payload.mime,
        name: `${label} · ${payload.role === 'preview' ? 'preview' : 'resource'} ${i + 1}`,
        extra: { role, parentId: id }
      })
      children.push(entry.id)
    } catch (e) {
      inspection.warnings.push(`image ${i + 1}: ${e.message}`)
    }
  })

  const summary = {
    container: inspection.container,
    containerConfidence: inspection.containerConfidence,
    graphs: inspection.graphs,
    parameterCount: inspection.parameters.length,
    // group histogram over ALL parameters (the list below is truncated for the index)
    parameterGroups: (() => {
      const m = new Map()
      for (const p of inspection.parameters) {
        const g = p.group || '·'
        m.set(g, (m.get(g) || 0) + 1)
      }
      return [...m.entries()].map(([name, count]) => ({ name, count }))
    })(),
    parameters: inspection.parameters.slice(0, 40),
    outputs: inspection.outputs,
    channels: inspection.channels || [],
    entries: (inspection.entries || []).slice(0, 60),
    metadata: inspection.metadata,
    imageCount: inspection.images.length,
    images: inspection.images.map(({ data, ...rest }) => rest),
    assemblies: inspection.assemblies,
    canEvaluate: false,
    evaluateBlockedReason: inspection.evaluateBlockedReason,
    warnings: inspection.warnings,
    notes: inspection.notes,
    sha256: inspection.sha256,
    fileBytes: inspection.fileBytes,
    graphXml: inspection.graphXml,
    entryCount: inspection.entryCount
  }

  const entry = {
    id,
    kind: 'sbsar',
    name: label + '.sbsar',
    file,
    mime: 'application/octet-stream',
    bytes: buffer.length,
    width: null,
    height: null,
    createdAt: Date.now(),
    children,
    inspection: summary
  }
  // re-read: storeImage() below already wrote the extracted bitmaps into the index
  const fresh = readIndex()
  fresh.push(entry)
  writeIndex(fresh)
  try {
    writeFileSync(path.join(ASSETS_DIR, 'sbsar-' + id + '.json'), JSON.stringify({ ...inspection, imagePayloads: undefined }, null, 2), 'utf8')
  } catch (e) {
    /* the sidecar is a convenience copy; the index summary is authoritative */
  }
  return { asset: publicAsset(entry), inspection: summary }
}

/** Full cached inspection report of an imported archive (falls back to the index summary). */
/**
 * 读取归档的完整检查报告：优先 assets/sbsar-<id>.json（含解析细节），
 * 缺失时回退索引里保存的摘要。
 * @param {string} id 素材 id
 * @returns {object|null} 检查报告
 * @throws {Error} 素材不存在，或不是归档类型
 */
export function readSbsarInspection(id) {
  const entry = readIndex().find((a) => a.id === id)
  if (!entry) throw new Error('Asset not found')
  if (entry.kind !== 'sbsar') throw new Error('Asset is not a Substance archive')
  try {
    return JSON.parse(readFileSync(path.join(ASSETS_DIR, 'sbsar-' + entry.id + '.json'), 'utf8'))
  } catch (e) {
    return entry.inspection || null
  }
}

/** Permanently remove an asset and its archive children (the only unlinking path). */
/**
 * 永久删除素材：删掉归档原始文件、它抽取出的所有子位图、sidecar JSON 与索引条目。
 * 这是唯一真正 unlink 素材字节的路径（回收站里的 purge 也最终走这里）。
 * 单个文件删除失败会被忽略（best effort），索引仍会更新。
 * @param {string} id 素材 id
 * @returns {{ok:boolean,deleted:string,children:number}}
 * @throws {Error} 素材不存在
 */
export function deleteAsset(id) {
  initAssets()
  const index = readIndex()
  const entry = index.find((a) => a.id === id)
  if (!entry) throw new Error('Asset not found')
  // an archive owns the bitmaps it extracted
  const owned = entry.kind === 'sbsar' ? index.filter((a) => a.parentId === id) : []
  for (const child of owned) {
    try {
      rmSync(path.join(ASSETS_DIR, child.file), { force: true })
    } catch (e) {
      /* best effort */
    }
  }
  try {
    rmSync(path.join(ASSETS_DIR, entry.file), { force: true })
    if (entry.kind === 'sbsar') rmSync(path.join(ASSETS_DIR, 'sbsar-' + entry.id + '.json'), { force: true })
  } catch (e) {
    /* best effort */
  }
  const drop = new Set([id, ...owned.map((c) => c.id)])
  writeIndex(index.filter((a) => !drop.has(a.id)))
  return { ok: true, deleted: id, children: owned.length }
}

/** Resolve a request pathname (/assets/<file>) to a file inside the asset directory. */
/**
 * 把请求路径 `/assets/<file>` 解析为 assets/ 内的真实文件路径。
 * 只允许单段文件名：含 ".."、"/"、"\\" 或为空一律返回 null（路径穿越防护）。
 * @param {string} pathname 例如 /assets/ab12cd34ef56.png
 * @returns {string|null} 绝对路径；不存在/不是普通文件/非法路径返回 null
 */
export function assetFilePath(pathname) {
  const rel = String(pathname || '').replace(/^\/assets\//, '')
  if (!rel || rel.includes('..') || rel.includes('/') || rel.includes('\\')) return null
  const full = path.join(ASSETS_DIR, rel)
  if (!existsSync(full)) return null
  try {
    if (!statSync(full).isFile()) return null
  } catch (e) {
    return null
  }
  return full
}

/**
 * 统计素材库中未删除的素材数量（健康检查用）。
 * @returns {number}
 */
export function assetsCount() {
  try {
    return readIndex().filter((a) => !a.deletedAt).length
  } catch (e) {
    return 0
  }
}


// ---------------------------------------------------------------- online asset search
// Keyless defaults: Openverse and Wikimedia Commons. Optional API keys (config file or env):
// PEXELS_API_KEY, PIXABAY_API_KEY, UNSPLASH_ACCESS_KEY.
const SEARCH_CONFIG_PATH = path.join(ROOT, 'asset-search.local.json')
const PRIVATE_HOST = /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|\[?::1\]?$)/i

/**
 * 读取在线图库 API Key，优先环境变量，其次 asset-search.local.json。
 * Openverse / Wikimedia 无需 key，因此缺 key 时仍可搜索。
 * @returns {{pexels:string,pixabay:string,unsplash:string}}
 */
function loadSearchKeys() {
  let config = {}
  try {
    config = JSON.parse(readFileSync(SEARCH_CONFIG_PATH, 'utf8')) || {}
  } catch (e) {
    config = {}
  }
  return {
    pexels: String(process.env.PEXELS_API_KEY || config.pexels || config.PEXELS_API_KEY || ''),
    pixabay: String(process.env.PIXABAY_API_KEY || config.pixabay || config.PIXABAY_API_KEY || ''),
    unsplash: String(process.env.UNSPLASH_ACCESS_KEY || config.unsplash || config.UNSPLASH_ACCESS_KEY || '')
  }
}

/**
 * 带超时的 JSON GET（AbortController，默认 15 秒）。
 * @param {string} url
 * @param {Record<string,string>} [headers]
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<any>} 解析后的 JSON
 * @throws {Error} 非 2xx（HTTP <status>）或超时中止
 */
async function getJSON(url, headers = {}, timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: controller.signal })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 清洗搜索关键词：只保留字母/数字/空格/下划线/连字符，压缩空白，截断 80 字符。
 * @param {string} q
 * @returns {string}
 */
function cleanQuery(q) {
  return String(q || '')
    .replace(/[^\p{L}\p{N} _-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/**
 * Openverse（知识共享图库，无需 key）搜索。
 * @param {string} query 已清洗的关键词
 * @param {number} limit 结果数
 * @returns {Promise<object[]>} 统一字段 { provider,id,title,creator,license,licenseUrl,sourceUrl,thumbnail,downloadUrl }
 */
async function searchOpenverse(query, limit) {
  const url = 'https://api.openverse.org/v1/images/?q=' + encodeURIComponent(query) + '&page_size=' + limit + '&license_type=all-cc'
  const data = await getJSON(url)
  return (data.results || []).map((r) => ({
    provider: 'Openverse',
    id: 'openverse:' + r.id,
    title: r.title || 'Untitled',
    creator: r.creator || 'Unknown',
    license: (r.license || '') + (r.license_version ? ' ' + r.license_version : ''),
    licenseUrl: r.license_url || '',
    sourceUrl: r.foreign_landing_url || '',
    thumbnail: r.thumbnail || r.url,
    downloadUrl: r.url
  }))
}

/**
 * Wikimedia Commons 搜索（无需 key），只返回带缩略图的文件页。
 * extmetadata 内的 HTML 会被剥离后再作为作者/许可文案。
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<object[]>}
 */
async function searchWikimedia(query, limit) {
  const url =
    'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=' +
    encodeURIComponent(query) +
    '&gsrnamespace=6&gsrlimit=' +
    limit +
    '&prop=imageinfo&iiprop=url%7Cextmetadata&iiurlwidth=480&format=json&origin=*'
  const data = await getJSON(url)
  const pages = data?.query?.pages ? Object.values(data.query.pages) : []
  return pages
    .filter((p) => (p.imageinfo || [])[0]?.thumburl)
    .map((p) => {
      const info = p.imageinfo[0]
      const meta = info.extmetadata || {}
      const strip = (v) => String(v?.value || '').replace(/<[^>]*>/g, '').trim()
      return {
        provider: 'Wikimedia Commons',
        id: 'commons:' + p.pageid,
        title: p.title || 'Untitled',
        creator: strip(meta.Artist) || 'Unknown',
        license: strip(meta.LicenseShortName) || 'See source',
        licenseUrl: 'https://commons.wikimedia.org/wiki/' + encodeURIComponent(String(p.title || '')),
        sourceUrl: 'https://commons.wikimedia.org/wiki/' + encodeURIComponent(String(p.title || '')),
        thumbnail: info.thumburl,
        downloadUrl: info.url
      }
    })
}

/**
 * Pexels 搜索（需要 PEXELS_API_KEY）。
 * @param {string} query
 * @param {number} limit
 * @param {string} key
 * @returns {Promise<object[]>}
 */
async function searchPexels(query, limit, key) {
  const data = await getJSON('https://api.pexels.com/v1/search?query=' + encodeURIComponent(query) + '&per_page=' + limit, { Authorization: key })
  return (data.photos || []).map((p) => ({
    provider: 'Pexels',
    id: 'pexels:' + p.id,
    title: p.alt || 'Pexels photo',
    creator: p.photographer || 'Pexels',
    license: 'Pexels License',
    licenseUrl: 'https://www.pexels.com/license/',
    sourceUrl: p.url,
    thumbnail: p.src?.medium || p.src?.small,
    downloadUrl: p.src?.large2x || p.src?.large || p.src?.original
  }))
}

/**
 * Pixabay 搜索（需要 PIXABAY_API_KEY）。
 * @param {string} query
 * @param {number} limit
 * @param {string} key
 * @returns {Promise<object[]>}
 */
async function searchPixabay(query, limit, key) {
  const data = await getJSON('https://pixabay.com/api/?key=' + encodeURIComponent(key) + '&q=' + encodeURIComponent(query) + '&per_page=' + limit + '&image_type=photo')
  return (data.hits || []).map((p) => ({
    provider: 'Pixabay',
    id: 'pixabay:' + p.id,
    title: p.tags || 'Pixabay image',
    creator: p.user || 'Pixabay',
    license: 'Pixabay Content License',
    licenseUrl: 'https://pixabay.com/service/license-summary/',
    sourceUrl: p.pageURL,
    thumbnail: p.webformatURL,
    downloadUrl: p.largeImageURL
  }))
}

/**
 * Unsplash 搜索（需要 UNSPLASH_ACCESS_KEY，以 Client-ID 方式鉴权）。
 * @param {string} query
 * @param {number} limit
 * @param {string} key
 * @returns {Promise<object[]>}
 */
async function searchUnsplash(query, limit, key) {
  const data = await getJSON('https://api.unsplash.com/search/photos?query=' + encodeURIComponent(query) + '&per_page=' + limit, { Authorization: 'Client-ID ' + key })
  return (data.results || []).map((p) => ({
    provider: 'Unsplash',
    id: 'unsplash:' + p.id,
    title: p.alt_description || 'Unsplash photo',
    creator: p.user?.name || 'Unsplash',
    license: 'Unsplash License',
    licenseUrl: 'https://unsplash.com/license',
    sourceUrl: p.links?.html,
    thumbnail: p.urls?.small,
    downloadUrl: p.urls?.regular
  }))
}

// Last-resort online fallback: Lorem Picsum serves deterministic stock photos by seed.
// It is not semantic search, so results are labelled and reported as a fallback.
/**
 * 兜底：Lorem Picsum 按种子返回确定性图片。它不是语义搜索，结果会被标记 fallback=true。
 * @param {string} query
 * @param {number} limit 最多 6 条
 * @returns {object[]}
 */
function searchPicsum(query, limit) {
  const results = []
  const n = Math.min(limit, 6)
  for (let i = 0; i < n; i++) {
    const seed = encodeURIComponent(String(query).slice(0, 40) + '-' + i)
    const url = 'https://picsum.photos/seed/' + seed + '/640/640'
    results.push({
      provider: 'Lorem Picsum (fallback)',
      id: 'picsum:' + seed,
      title: 'Stock photo · ' + query + ' #' + (i + 1),
      creator: 'Unsplash / Lorem Picsum contributors',
      license: 'Unsplash License (served via Lorem Picsum)',
      licenseUrl: 'https://unsplash.com/license',
      sourceUrl: 'https://picsum.photos/',
      thumbnail: url,
      downloadUrl: url,
      fallback: true
    })
  }
  return results
}

/**
 * 在线素材搜索：按「有 key 的付费/授权图库 → Openverse → Wikimedia → Picsum 兜底」顺序
 * 逐个尝试，第一个有结果的供应商胜出；全程记录 providersTried 与 errors 便于排查。
 * @param {string} query 原始关键词（内部会清洗）
 * @param {number} [limit=12]
 * @returns {Promise<object>} 成功 { ok:true, query, provider, results, providersTried, errors, fallback? , warning? }；
 *          全部失败 { ok:false, error:{ code:'ASSET_SEARCH_UNAVAILABLE', message, details } }
 * @throws 空关键词时抛出 code=INVALID_ARGUMENT 的错误
 */
export async function searchAssets(query, limit = 12) {
  const q = cleanQuery(query)
  if (!q) throw Object.assign(new Error('Empty search query'), { code: 'INVALID_ARGUMENT' })
  const keys = loadSearchKeys()
  const providers = []
  if (keys.pexels) providers.push({ name: 'Pexels', run: (l) => searchPexels(q, l, keys.pexels) })
  if (keys.unsplash) providers.push({ name: 'Unsplash', run: (l) => searchUnsplash(q, l, keys.unsplash) })
  if (keys.pixabay) providers.push({ name: 'Pixabay', run: (l) => searchPixabay(q, l, keys.pixabay) })
  providers.push({ name: 'Openverse', run: (l) => searchOpenverse(q, l) })
  providers.push({ name: 'Wikimedia Commons', run: (l) => searchWikimedia(q, l) })
  const errors = []
  for (const provider of providers) {
    try {
      const results = (await provider.run(limit)).filter((r) => r.thumbnail && r.downloadUrl)
      if (results.length) {
        return { ok: true, query: q, provider: provider.name, results: results.slice(0, limit), providersTried: providers.map((p) => p.name), errors }
      }
      errors.push(provider.name + ': no results')
    } catch (e) {
      errors.push(provider.name + ': ' + (e?.message || String(e)))
    }
  }
  // semantic providers are unreachable (network policy / no API keys): fall back to online
  // deterministic stock photos so the feature still works, clearly marked as a fallback
  try {
    const fallbackResults = searchPicsum(q, limit)
    if (fallbackResults.length) {
      return {
        ok: true,
        query: q,
        provider: 'Lorem Picsum (fallback)',
        fallback: true,
        warning: 'Semantic providers unavailable; showing random stock photos. Configure PEXELS_API_KEY / PIXABAY_API_KEY / UNSPLASH_ACCESS_KEY for relevant search.',
        results: fallbackResults,
        providersTried: providers.map((p) => p.name),
        errors
      }
    }
  } catch (e) {
    errors.push('Picsum fallback: ' + (e?.message || String(e)))
  }
  return {
    ok: false,
    query: q,
    error: {
      code: 'ASSET_SEARCH_UNAVAILABLE',
      message:
        'Online asset search is unavailable. Add PEXELS_API_KEY / PIXABAY_API_KEY / UNSPLASH_ACCESS_KEY (env or asset-search.local.json) to use a reachable provider.',
      details: errors
    }
  }
}

/**
 * SSRF 防护：只允许 http/https，且主机名不能是 localhost/回环/私有网段/链路本地地址。
 * @param {string} raw 用户提供的 URL
 * @returns {URL} 通过校验的 URL 对象
 * @throws {Error} 非法 URL / 协议不允许 / 指向内网
 */
function assertPublicUrl(raw) {
  let url
  try {
    url = new URL(String(raw || ''))
  } catch (e) {
    throw new Error('Invalid image URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed')
  if (PRIVATE_HOST.test(url.hostname)) throw new Error('Private/local URLs are not allowed')
  return url
}

/**
 * 从公网 URL 下载图片并入库，同时写入 attribution（来源/作者/许可）。
 * 流程：校验 URL → 25 秒超时下载 → 校验重定向后的最终地址 → 校验 Content-Type → 大小校验
 * → 复用 importAsset（因此同样经过文件头签名校验）→ 回写 attribution 到索引。
 * @param {{url?:string,downloadUrl?:string,name?:string,provider?:string,creator?:string,license?:string,licenseUrl?:string,sourceUrl?:string}} [input]
 * @returns {Promise<object>} 公开素材对象（附 attribution）
 * @throws {Error} URL 非法/内网、下载失败、类型不支持、空图、过大
 */
export async function importAssetFromUrl(input = {}) {
  const url = assertPublicUrl(input.url || input.downloadUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25000)
  let res
  try {
    res = await fetch(url, { signal: controller.signal, headers: { Accept: 'image/*', 'User-Agent': 'SubstrateTextureStudio/1.0' } })
  } catch (e) {
    throw new Error('Download failed: ' + (e?.message || String(e)))
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw new Error('Download failed: HTTP ' + res.status)
  // verify the final redirect target is still public
  assertPublicUrl(res.url)
  const mime = String(res.headers.get('content-type') || '').split(';')[0].trim()
  if (!MIME_EXT[mime]) throw new Error('Unsupported image type: ' + (mime || 'unknown'))
  const buffer = Buffer.from(await res.arrayBuffer())
  if (!buffer.length) throw new Error('Empty image')
  if (buffer.length > MAX_BYTES) throw new Error('Image is too large (max 32 MB)')
  const dataUrl = 'data:' + mime + ';base64,' + buffer.toString('base64')
  const asset = importAsset({ name: input.name || 'Online asset', dataUrl })
  // attach attribution metadata
  const index = readIndex()
  const entry = index.find((e) => e.id === asset.id)
  if (entry) {
    entry.attribution = {
      provider: String(input.provider || '').slice(0, 60),
      creator: String(input.creator || '').slice(0, 200),
      license: String(input.license || '').slice(0, 120),
      licenseUrl: String(input.licenseUrl || '').slice(0, 500),
      sourceUrl: String(input.sourceUrl || url.href).slice(0, 500)
    }
    writeIndex(index)
  }
  return { ...publicAsset(entry || asset), attribution: entry?.attribution || null }
}
