// Material library storage: imported bitmap assets live on the Node server and are served from
// /assets/<file>. Metadata is kept in assets/index.json. Zero dependencies.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ASSETS_DIR = path.join(ROOT, 'assets')
const INDEX_PATH = path.join(ASSETS_DIR, 'index.json')
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
const MAX_BYTES = 32 * 1024 * 1024
const MAX_ASSETS = 400

export function initAssets() {
  mkdirSync(ASSETS_DIR, { recursive: true })
  if (!existsSync(INDEX_PATH)) writeFileSync(INDEX_PATH, '[]', 'utf8')
}

function readIndex() {
  try {
    const list = JSON.parse(readFileSync(INDEX_PATH, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

function writeIndex(list) {
  writeFileSync(INDEX_PATH, JSON.stringify(list, null, 2), 'utf8')
}

function publicAsset(entry) {
  return {
    id: entry.id,
    name: entry.name,
    file: entry.file,
    url: '/assets/' + entry.file,
    mime: entry.mime,
    bytes: entry.bytes,
    width: entry.width || null,
    height: entry.height || null,
    createdAt: entry.createdAt
  }
}

export function listAssets() {
  return readIndex()
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map(publicAsset)
}

/** Parse a data: URL into bytes + mime, rejecting anything that is not a PNG/JPEG/WebP image. */
export function decodeDataUrl(dataUrl) {
  const text = String(dataUrl || '')
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(text)
  if (!match) throw new Error('Unsupported image data URL (PNG/JPEG/WebP only)')
  const mime = match[1]
  const buffer = Buffer.from(match[2], 'base64')
  if (!buffer.length) throw new Error('Empty image')
  if (buffer.length > MAX_BYTES) throw new Error('Image is too large (max 32 MB)')
  const sig = buffer.subarray(0, 12)
  const isPng = sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47
  const isJpeg = sig[0] === 0xff && sig[1] === 0xd8 && sig[2] === 0xff
  const isWebp = buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  if ((mime === 'image/png' && !isPng) || (mime === 'image/jpeg' && !isJpeg) || (mime === 'image/webp' && !isWebp)) {
    throw new Error('File signature does not match its image type')
  }
  return { mime, buffer }
}

function readPngSize(buf) {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : null
}

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

export function importAsset({ name, dataUrl }) {
  initAssets()
  const index = readIndex()
  if (index.length >= MAX_ASSETS) throw new Error('Asset library is full (max ' + MAX_ASSETS + ' files)')
  const { mime, buffer } = decodeDataUrl(dataUrl)
  const id = createHash('sha1').update(buffer).digest('hex').slice(0, 12)
  const existing = index.find((a) => a.id === id)
  if (existing) return publicAsset(existing)
  const ext = MIME_EXT[mime] || 'png'
  const file = id + '.' + ext
  writeFileSync(path.join(ASSETS_DIR, file), buffer)
  const size = (mime === 'image/png' ? readPngSize(buffer) : mime === 'image/jpeg' ? readJpegSize(buffer) : null) || {}
  const cleanName = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .slice(0, 80) || 'Asset ' + id.slice(0, 6)
  const entry = {
    id,
    name: cleanName,
    file,
    mime,
    bytes: buffer.length,
    width: size.width || null,
    height: size.height || null,
    createdAt: Date.now()
  }
  index.push(entry)
  writeIndex(index)
  return publicAsset(entry)
}

export function deleteAsset(id) {
  initAssets()
  const index = readIndex()
  const entry = index.find((a) => a.id === id)
  if (!entry) throw new Error('Asset not found')
  try {
    rmSync(path.join(ASSETS_DIR, entry.file), { force: true })
  } catch (e) {
    /* best effort */
  }
  writeIndex(index.filter((a) => a.id !== id))
  return { ok: true, deleted: id }
}

/** Resolve a request pathname (/assets/<file>) to a file inside the asset directory. */
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

export function assetsCount() {
  try {
    return readdirSync(ASSETS_DIR).filter((f) => f !== 'index.json').length
  } catch (e) {
    return 0
  }
}
