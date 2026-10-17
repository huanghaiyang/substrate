// Substrate Texture Studio — dependency-free Node server.
// Serves the zero-bundler ESM app, project persistence and material package export.
import http from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const USE_DIST = process.argv.includes('--dist')
const WWW = USE_DIST ? path.join(ROOT, 'dist') : ROOT
const PORT = Number(process.env.PORT || 3000)
const PROJECTS_DIR = path.join(ROOT, 'projects')
const EXPORTS_DIR = path.join(ROOT, 'exports')
const DEBUG_DIR = path.join(ROOT, 'debug')
const BODY_LIMIT = 320 * 1024 * 1024

for (const dir of [PROJECTS_DIR, EXPORTS_DIR, DEBUG_DIR]) mkdirSync(dir, { recursive: true })
if (USE_DIST && !existsSync(path.join(WWW, 'index.html'))) {
  console.error('[substrate] dist/ not found — run: npm run build')
  process.exit(1)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.zip': 'application/zip',
  '.sbs': 'application/octet-stream'
}

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

function safeJoin(base, rel) {
  const target = path.resolve(base, '.' + path.sep + String(rel || '').replace(/^[/\\]+/, ''))
  if (!target.startsWith(base + path.sep) && target !== base) return null
  return target
}

function slugify(name, fallback = 'material') {
  const clean = String(name || '')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
  return clean || fallback
}

// Filenames must stay ASCII, but two different non-ASCII names must not collide,
// so append a short stable hash whenever characters had to be stripped.
function nameSlug(name, fallback = 'material') {
  const base = slugify(name, fallback)
  const normalized = String(name || '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
  if (base === normalized) return base
  const hash = createHash('sha1').update(String(name || '')).digest('hex').slice(0, 6)
  return `${base}-${hash}`
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers })
  res.end(body)
}

function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' })
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// ------------------------------------------------------------------ zip writer
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosTime(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f)
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  return { time, day }
}

function zipStore(entries) {
  // entries: [{ name, data: Buffer, compress?: boolean }]
  const localParts = []
  const centralParts = []
  let offset = 0
  const { time, day } = dosTime()
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8')
    const crc = crc32(entry.data)
    const compress = entry.compress !== false
    const body = compress ? deflateRawSync(entry.data, { level: 9 }) : entry.data
    const method = compress ? 8 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, nameBuf, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(day, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBuf)
    offset += local.length + nameBuf.length + body.length
  }
  const cd = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, cd, eocd])
}

// ------------------------------------------------------------------- projects
function projectList() {
  const out = []
  for (const file of readdirSync(PROJECTS_DIR)) {
    if (!file.endsWith('.json')) continue
    try {
      const full = path.join(PROJECTS_DIR, file)
      const data = JSON.parse(readFileSync(full, 'utf8'))
      const st = statSync(full)
      out.push({
        name: data.name || file.replace(/\.json$/, ''),
        file,
        savedAt: data.savedAt || st.mtimeMs,
        resolution: data.resolution || 1024,
        nodes: data.graph?.nodes?.length || 0,
        bytes: st.size
      })
    } catch (e) {
      /* ignore broken project */
    }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt)
}

function handleProjectSave(req, res) {
  readBody(req)
    .then((buf) => {
      const data = JSON.parse(buf.toString('utf8'))
      if (!data || !data.graph) throw new Error('Invalid project payload')
      const name = String(data.name || 'Untitled').slice(0, 120)
      const file = `${nameSlug(name, 'untitled')}.json`
      const payload = { ...data, name, savedAt: Date.now() }
      writeFileSync(path.join(PROJECTS_DIR, file), JSON.stringify(payload, null, 2), 'utf8')
      sendJSON(res, 200, { ok: true, file, name, path: path.join('projects', file) })
    })
    .catch((e) => sendJSON(res, 400, { ok: false, error: e.message }))
}

function handleProjectLoad(res, name) {
  // accept either the display name or the already-hashed file slug returned by /api/projects
  let file = `${nameSlug(name, 'untitled')}.json`
  if (!/^[A-Za-z0-9 _-]+\.json$/.test(file)) file = `${slugify(name, 'untitled')}.json`
  let full = safeJoin(PROJECTS_DIR, file)
  if (!full || !existsSync(full)) {
    const alt = `${slugify(name, 'untitled')}.json`
    if (alt !== file) {
      const altFull = safeJoin(PROJECTS_DIR, alt)
      if (altFull && existsSync(altFull)) {
        full = altFull
        file = alt
      }
    }
  }
  if (!full || !existsSync(full)) return sendJSON(res, 404, { ok: false, error: 'Project not found' })
  send(res, 200, readFileSync(full), { 'Content-Type': 'application/json; charset=utf-8' })
}

// -------------------------------------------------------------------- exports
function handleExport(req, res) {
  readBody(req)
    .then((buf) => {
      const payload = JSON.parse(buf.toString('utf8'))
      if (!payload || !Array.isArray(payload.files)) throw new Error('Invalid export payload')
      const name = String(payload.materialName || 'Material').slice(0, 120)
      let dirName = `${slugify(name)}-${stamp()}`
      let suffix = 2
      while (existsSync(path.join(EXPORTS_DIR, dirName))) dirName = `${slugify(name)}-${stamp()}-${suffix++}`
      const dir = path.join(EXPORTS_DIR, dirName)
      mkdirSync(dir, { recursive: true })
      const entries = []
      const written = []
      for (const file of payload.files) {
        const rel = String(file.path || '').replace(/\\/g, '/')
        if (rel.includes('..') || rel.startsWith('/')) throw new Error('Illegal file path')
        const target = safeJoin(dir, rel)
        if (!target) throw new Error('Illegal file path')
        mkdirSync(path.dirname(target), { recursive: true })
        const data = Buffer.from(String(file.data || ''), 'base64')
        writeFileSync(target, data)
        entries.push({ name: rel, data, compress: false })
        written.push({ path: rel, bytes: data.length })
      }
      const manifestBuf = Buffer.from(JSON.stringify(payload.manifest || {}, null, 2), 'utf8')
      const readmeBuf = Buffer.from(String(payload.readme || ''), 'utf8')
      writeFileSync(path.join(dir, 'manifest.json'), manifestBuf)
      writeFileSync(path.join(dir, 'README.md'), readmeBuf)
      entries.push({ name: 'manifest.json', data: manifestBuf, compress: true })
      entries.push({ name: 'README.md', data: readmeBuf, compress: true })
      const zipBuf = zipStore(entries)
      const zipName = `${slugify(name)}.zip`
      writeFileSync(path.join(dir, zipName), zipBuf)
      pruneExports()
      sendJSON(res, 200, {
        ok: true,
        dir: 'exports/' + dirName,
        url: `/exports/${dirName}/`,
        zip: `/exports/${dirName}/${zipName}`,
        zipBytes: zipBuf.length,
        files: written
      })
    })
    .catch((e) => {
      console.error('[export]', e)
      sendJSON(res, 400, { ok: false, error: e.message })
    })
}

function exportList() {
  const out = []
  if (!existsSync(EXPORTS_DIR)) return out
  const dirs = readdirSync(EXPORTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory())
  for (const d of dirs) {
    const dir = path.join(EXPORTS_DIR, d.name)
    let manifest = null
    try {
      manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    } catch (e) {
      /* skip */
    }
    const files = readdirSync(dir).filter((f) => f !== 'manifest.json' && f !== 'README.md')
    const zip = files.find((f) => f.endsWith('.zip'))
    out.push({
      dir: d.name,
      url: `/exports/${d.name}/`,
      zip: zip ? `/exports/${d.name}/${zip}` : null,
      mtime: statSync(dir).mtimeMs,
      manifest,
      files
    })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

function pruneExports(max = 40) {
  try {
    const dirs = readdirSync(EXPORTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, mtime: statSync(path.join(EXPORTS_DIR, d.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const old of dirs.slice(max)) rmSync(path.join(EXPORTS_DIR, old.name), { recursive: true, force: true })
  } catch (e) {
    /* ignore */
  }
}

// --------------------------------------------------------------------- static
const VENDOR_FILES = {
  'vue.esm-browser.prod.js': 'node_modules/vue/dist/vue.esm-browser.prod.js',
  'vue.esm-browser.js': 'node_modules/vue/dist/vue.esm-browser.js',
  'three.module.js': 'node_modules/three/build/three.module.js'
}

function serveFile(res, file, download = false) {
  if (!existsSync(file) || statSync(file).isDirectory()) {
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' })
  }
  const headers = { 'Content-Type': mimeOf(file), 'Cache-Control': 'no-cache' }
  if (download) headers['Content-Disposition'] = `attachment; filename="${path.basename(file)}"`
  res.writeHead(200, headers)
  createReadStream(file).pipe(res)
}

function serveVendor(res, rel) {
  const clean = rel.replace(/^[/\\]+/, '')
  if (VENDOR_FILES[clean]) return serveFile(res, path.join(ROOT, VENDOR_FILES[clean]))
  if (clean.startsWith('addons/')) {
    const sub = clean.slice('addons/'.length)
    const full = safeJoin(path.join(ROOT, 'node_modules/three/examples/jsm'), sub)
    if (full) return serveFile(res, full)
  }
  send(res, 404, 'vendor not found', { 'Content-Type': 'text/plain' })
}

function serveApp(res, urlPath) {
  // vendor always resolves from node_modules (works for source and dist builds alike)
  if (urlPath.startsWith('/vendor/')) return serveVendor(res, urlPath.slice('/vendor/'.length))
  if (urlPath.startsWith('/exports/')) {
    const full = safeJoin(EXPORTS_DIR, urlPath.slice('/exports/'.length))
    if (!full) return send(res, 400, 'Bad path')
    if (urlPath.endsWith('.zip')) return serveFile(res, full, true)
    if (urlPath.endsWith('/')) {
      // directory index listing (useful when opening the export folder in a browser)
      const dir = full
      if (!existsSync(dir)) return send(res, 404, 'Not found')
      const rows = readdirSync(dir)
        .map((f) => `<li><a href="${encodeURIComponent(f)}">${f}</a></li>`)
        .join('')
      return send(res, 200, `<!doctype html><meta charset="utf-8"><title>Export</title><body style="font:14px system-ui;background:#14161a;color:#ddd;padding:24px"><h2>Export package</h2><ul>${rows}</ul></body>`, {
        'Content-Type': 'text/html; charset=utf-8'
      })
    }
    return serveFile(res, full)
  }
  let rel = urlPath
  if (rel === '/' || rel === '') rel = '/index.html'
  const full = safeJoin(WWW, rel)
  if (!full) return send(res, 400, 'Bad path')
  if (existsSync(full) && statSync(full).isFile()) return serveFile(res, full)
  // SPA fallback
  return serveFile(res, path.join(WWW, 'index.html'))
}

// ----------------------------------------------------------------------- main
const server = http.createServer((req, res) => {
  let url
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  } catch (e) {
    return send(res, 400, 'Bad request')
  }
  const p = decodeURIComponent(url.pathname)
  const method = req.method || 'GET'

  if (p === '/api/health') {
    return sendJSON(res, 200, {
      ok: true,
      service: 'substrate-texture-designer',
      version: '1.0.0',
      mode: USE_DIST ? 'dist' : 'source',
      node: process.version,
      projects: projectList().length,
      exports: exportList().length
    })
  }
  if (p === '/api/projects' && method === 'GET') return sendJSON(res, 200, { ok: true, projects: projectList() })
  if (p === '/api/projects/save' && method === 'POST') return handleProjectSave(req, res)
  if (p === '/api/projects/load' && method === 'GET') return handleProjectLoad(res, url.searchParams.get('name') || '')
  if (p === '/api/projects/delete' && method === 'POST') {
    return readBody(req, 1024 * 1024)
      .then((buf) => {
        const data = JSON.parse(buf.toString('utf8'))
        const file = `${nameSlug(data.name || '', 'untitled')}.json`
        const full = safeJoin(PROJECTS_DIR, file)
        if (full && existsSync(full)) rmSync(full, { force: true })
        sendJSON(res, 200, { ok: true })
      })
      .catch((e) => sendJSON(res, 400, { ok: false, error: e.message }))
  }
  if (p === '/api/export' && method === 'POST') return handleExport(req, res)
  if (p === '/api/exports' && method === 'GET') return sendJSON(res, 200, { ok: true, exports: exportList() })
  if (p === '/api/debug/report' && method === 'POST') {
    return readBody(req, 32 * 1024 * 1024)
      .then((buf) => {
        const payload = JSON.parse(buf.toString('utf8'))
        const kind = slugify(payload.kind || 'report', 'report')
        const file = kind + '.json'
        const body = JSON.stringify({ kind, receivedAt: Date.now(), ...payload }, null, 2)
        writeFileSync(path.join(DEBUG_DIR, file), body, 'utf8')
        sendJSON(res, 200, { ok: true, file: '/api/debug/last?kind=' + kind })
      })
      .catch((e) => sendJSON(res, 400, { ok: false, error: e.message }))
  }
  if (p === '/api/debug/last' && method === 'GET') {
    const kind = slugify(url.searchParams.get('kind') || 'selftest', 'selftest')
    const full = path.join(DEBUG_DIR, kind + '.json')
    if (!existsSync(full)) return sendJSON(res, 404, { ok: false, error: 'No report yet' })
    return send(res, 200, readFileSync(full), { 'Content-Type': 'application/json; charset=utf-8' })
  }
  if (p === '/api/debug/list' && method === 'GET') {
    const files = readdirSync(DEBUG_DIR).filter((f) => f.endsWith('.json'))
    return sendJSON(res, 200, { ok: true, reports: files })
  }
  if (p.startsWith('/api/')) return sendJSON(res, 404, { ok: false, error: 'Unknown endpoint' })

  if (method !== 'GET' && method !== 'HEAD') return send(res, 405, 'Method not allowed')
  return serveApp(res, p)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[substrate] http://127.0.0.1:${PORT}  (${USE_DIST ? 'dist' : 'source'}, node ${process.version})`)
})
