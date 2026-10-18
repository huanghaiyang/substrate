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
    createdAt: entry.createdAt,
    attribution: entry.attribution || null
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


// ---------------------------------------------------------------- online asset search
// Keyless defaults: Openverse and Wikimedia Commons. Optional API keys (config file or env):
// PEXELS_API_KEY, PIXABAY_API_KEY, UNSPLASH_ACCESS_KEY.
const SEARCH_CONFIG_PATH = path.join(ROOT, 'asset-search.local.json')
const PRIVATE_HOST = /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|\[?::1\]?$)/i

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

function cleanQuery(q) {
  return String(q || '')
    .replace(/[^\p{L}\p{N} _-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

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
