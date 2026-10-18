// SBSAR (.sbsar / Substance Archive) inspector — zero dependencies.
//
// What a .sbsar is: Adobe Substance Designer's *compiled* package. It carries the graph description
// (XML), one or more per-platform engine assemblies (.sbsasm, magic "SBAM"), embedded bitmaps
// (icons/thumbnails/resources) and preset metadata. It does NOT carry the engine, and the .sbsasm is
// proprietary bytecode.
//
// Therefore this importer can do two things and nothing more:
//   1. read the archive (metadata: package info, graphs, input parameters with ranges/defaults,
//      output usages, embedded bitmaps) and expose the bitmaps as normal texture assets;
//   2. tell the user precisely why the graph cannot be *evaluated* here.
// Baking a Substance at arbitrary resolution would require Adobe's Substance Engine (native, licensed).
//
// Container handling is layered, because archives in the wild come in two shapes:
//   * zip    — an entry table (PK\x03\x04). Authoritative: every entry is listed and decompressed.
//   * native — Allegorithmic's own container. Undocumented, so we scan it for XML documents and image
//              blobs, including zlib-compressed ones. Anything recovered that way is marked `heuristic`
//              so the caller never presents it as certain.
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'

const MAX_XML_CHARS = 4 * 1024 * 1024
const MAX_IMAGE_BYTES = 24 * 1024 * 1024
const MAX_IMAGES = 24

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// ---------------------------------------------------------------------------- container: zip
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0 || eocd + 22 > buf.length) return null
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) return { entries: [], zip64: true }
  const entries = []
  let p = cdOffset
  const end = Math.min(buf.length, cdOffset + cdSize)
  for (let i = 0; i < count && p + 46 <= end; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const rawSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    // read the local header to find the real data start
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) continue
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const dataEnd = Math.min(buf.length, dataStart + compSize)
    let data = buf.subarray(dataStart, dataEnd)
    if (method === 8) {
      try {
        data = zlib.inflateRawSync(data)
      } catch (e) {
        entries.push({ name, method, error: 'inflate failed', size: compSize })
        continue
      }
    } else if (method !== 0) {
      entries.push({ name, method, error: 'unsupported compression', size: compSize })
      continue
    }
    entries.push({ name, method, data, size: data.length, rawSize })
  }
  return { entries, zip64: false }
}

// ---------------------------------------------------------------------------- XML: tiny tolerant parser
function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' }
  const stack = [root]
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g
  const attrRe = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    const between = text.slice(last, m.index)
    if (between.trim()) stack[stack.length - 1].text += between
    last = re.lastIndex
    if (m[1] !== undefined) { stack[stack.length - 1].text += m[1]; continue }
    if (m[2]) { if (stack.length > 1) stack.pop(); continue }        // closing tag
    if (!m[3]) continue                                             // comment / PI / doctype
    const attrs = {}
    let a
    attrRe.lastIndex = 0
    while ((a = attrRe.exec(m[4] || ''))) attrs[a[1]] = a[2] !== undefined ? a[2] : a[3]
    const node = { name: m[3], attrs, children: [], text: '' }
    stack[stack.length - 1].children.push(node)
    if (!m[5]) stack.push(node)
  }
  return root
}

function walk(node, visit) {
  visit(node)
  for (const c of node.children) walk(c, visit)
}

function localName(n) {
  const i = String(n || '').indexOf(':')
  return (i >= 0 ? String(n).slice(i + 1) : String(n || '')).toLowerCase()
}

// ---------------------------------------------------------------------------- bitmap blobs
function pngInfo(buf) {
  if (buf.length < 33) return null
  if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const bitDepth = buf[24]
  const colorType = buf[25]
  const end = buf.lastIndexOf(Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]))
  const size = end >= 0 ? end + 8 : buf.length
  return { mime: 'image/png', width, height, bitDepth, colorType, bytes: buf.subarray(0, size) }
}

function jpegInfo(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null
  let i = 2
  let width = null
  let height = null
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue }
    const marker = buf[i + 1]
    const len = buf.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      height = buf.readUInt16BE(i + 5)
      width = buf.readUInt16BE(i + 7)
      break
    }
    if (marker === 0xda) break
    i += 2 + Math.max(2, len)
  }
  const end = buf.lastIndexOf(Buffer.from([0xff, 0xd9]))
  return { mime: 'image/jpeg', width, height, bitDepth: 8, colorType: 0, bytes: buf.subarray(0, end >= 0 ? end + 2 : buf.length) }
}

/** Scan a buffer for image blobs; `zlibProbe` also tries compressed streams. */
function scanImages(buf, { zlibProbe, max }) {
  const found = []
  const seen = new Set()
  const push = (info, via) => {
    if (!info || !info.bytes || info.bytes.length < 128) return
    if (seen.has(info.bytes.length + ':' + info.width + 'x' + info.height)) return
    seen.add(info.bytes.length + ':' + info.width + 'x' + info.height)
    found.push({ ...info, via })
  }
  for (const sig of [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff]]) {
    let at = buf.indexOf(Buffer.from(sig))
    while (at >= 0 && found.length < max) {
      const slice = buf.subarray(at, Math.min(buf.length, at + MAX_IMAGE_BYTES))
      push(sig[0] === 0x89 ? pngInfo(slice) : jpegInfo(slice), 'raw')
      at = buf.indexOf(Buffer.from(sig), at + 4)
    }
  }
  if (zlibProbe && found.length < max) {
    // walk for zlib headers and try to inflate; keep streams that decode to an image
    for (let i = 0; i < buf.length - 2 && found.length < max; i++) {
      const cmf = buf[i]
      const flg = buf[i + 1]
      if ((cmf & 0x0f) !== 8 || (cmf >> 4) > 7) continue
      if ((cmf * 256 + flg) % 31 !== 0) continue
      try {
        const out = zlib.inflateSync(buf.subarray(i), { finishFlush: zlib.constants.Z_SYNC_FLUSH })
        const info = pngInfo(out) || jpegInfo(out)
        if (info) push(info, 'zlib')
      } catch (e) { /* not a whole zlib stream */ }
    }
  }
  return found
}

// ---------------------------------------------------------------------------- metadata extraction
const ATTR_ALIASES = {
  id: ['id', 'identifier', 'name', 'paramid', 'inputid'],
  label: ['label', 'displayname', 'caption', 'name'],
  type: ['type', 'valuetype', 'kind'],
  def: ['default', 'value', 'defaultvalue'],
  min: ['min', 'minimum', 'minvalue'],
  max: ['max', 'maximum', 'maxvalue'],
  step: ['step', 'increment']
}

function firstAttr(attrs, keys) {
  for (const k of keys) {
    for (const name of Object.keys(attrs)) {
      if (localName(name) === k) return attrs[name]
    }
  }
  return undefined
}

/** pull numeric hints out of child <gui> elements and from the attribute map */
function guiHints(node) {
  const out = {}
  const read = (n) => {
    const ln = localName(n.name)
    if (['min', 'minimum', 'max', 'maximum', 'step', 'increment', 'default', 'value'].includes(ln)) {
      const v = firstAttr(n.attrs, ['value', 'v']) ?? n.text.trim()
      if (v !== '' && v != null && !Number.isNaN(Number(v))) out[ln === 'minimum' ? 'min' : ln === 'maximum' ? 'max' : ln === 'increment' ? 'step' : ln] = Number(v)
    }
  }
  walk(node, read)
  return out
}

function collectFromXml(buf) {
  const text = buf.toString('utf8')
  if (!/^[\s\uFEFF]*(<\?xml|<\w)/.test(text)) return null
  const tree = parseXml(text)
  const graphs = []
  const parameters = []
  const outputs = []
  const metadata = {}
  let rootName = ''

  walk(tree, (node) => {
    const ln = localName(node.name)
    if (!rootName && node !== tree && node.children.length) rootName = ln
    const a = node.attrs || {}

    if (ln === 'graph') {
      const id = firstAttr(a, ['identifier', 'id', 'name'])
      if (id) graphs.push({ identifier: id, label: firstAttr(a, ['label', 'displayname']) || id })
      return
    }
    // package / graph metadata packs: <metadata name="author" value="..."/>
    if (ln === 'metadata' || ln === 'metadataentry' || ln === 'entry') {
      const key = firstAttr(a, ['name', 'key', 'id'])
      const val = firstAttr(a, ['value', 'v', 'content'])
      if (key && val && !metadata[key]) metadata[key] = val
      return
    }
    // parameters: the SBSAR XML describes inputs as <input>/<param>/<parameter>
    if (['input', 'param', 'parameter', 'compinput', 'graphinput'].includes(ln)) {
      const id = firstAttr(a, ATTR_ALIASES.id)
      if (!id) return
      const hints = guiHints(node)
      const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v))
      parameters.push({
        id,
        label: firstAttr(a, ATTR_ALIASES.label) || id,
        type: firstAttr(a, ATTR_ALIASES.type) || null,
        default: firstAttr(a, ATTR_ALIASES.def) ?? hints.default ?? null,
        min: num(firstAttr(a, ATTR_ALIASES.min)) ?? hints.min ?? null,
        max: num(firstAttr(a, ATTR_ALIASES.max)) ?? hints.max ?? null,
        step: num(firstAttr(a, ATTR_ALIASES.step)) ?? hints.step ?? null
      })
      return
    }
    if (['output', 'usage', 'outputusage'].includes(ln)) {
      const usage = firstAttr(a, ['usage', 'identifier', 'name', 'type'])
      if (usage) outputs.push({ usage })
    }
  })

  return { rootName, graphs, parameters, outputs, metadata }
}

// ---------------------------------------------------------------------------- public entry
/**
 * Inspect a .sbsar buffer.
 * @returns {{container:'zip'|'native'|'unknown', ...}} inspection report (no bytes of images inline
 *          unless `includeImageBytes` — the server stores them separately).
 */
export function inspectSbsar(buf, { includeImageBytes = false, maxImages = MAX_IMAGES } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) throw new Error('File is too small to be a Substance archive')
  const warnings = []
  const notes = []
  let container = 'unknown'
  let entries = []
  let xmlCandidates = []
  let images = []
  let assemblies = []

  const zip = readZip(buf)
  if (zip && zip.entries.length) {
    container = 'zip'
    if (zip.zip64) warnings.push('ZIP64 archives are not fully supported; entry sizes may be wrong')
    entries = zip.entries
    for (const e of entries) {
      if (e.error) { warnings.push(`${e.name}: ${e.error}`); continue }
      if (/\.(png|jpe?g)$/i.test(e.name)) {
        const info = pngInfo(e.data) || jpegInfo(e.data)
        if (info) images.push({ ...info, name: e.name, role: /thumb|icon|preview/i.test(e.name) ? 'preview' : 'resource', bytes: info.bytes })
      } else if (/\.(xml|sbsar)$/i.test(e.name) || /^(sbsdoc|substance)/i.test(e.name)) {
        xmlCandidates.push({ name: e.name, data: e.data })
      } else if (/\.sbsasm$/i.test(e.name)) {
        assemblies.push({ name: e.name, bytes: e.data.length })
      }
    }
  } else {
    // native container: scan for what we can recognise
    container = 'native'
    notes.push('Native Substance container: the archive table is undocumented, so contents were recovered by scanning (tolerant, may be partial).')
    const xml = scanXml(buf)
    xmlCandidates.push(...xml)
    images = scanImages(buf, { zlibProbe: true, max: maxImages })
    let at = buf.indexOf(Buffer.from('SBAM'))
    while (at >= 0 && assemblies.length < 16) {
      assemblies.push({ name: 'assembly@' + at, bytes: null })
      at = buf.indexOf(Buffer.from('SBAM'), at + 4)
    }
    if (!xmlCandidates.length) warnings.push('No graph XML found — parameter/output metadata unavailable for this archive.')
  }

  let parsed = null
  let parsedFrom = null
  for (const c of xmlCandidates) {
    if (c.data.length > MAX_XML_CHARS * 4) continue
    const p = collectFromXml(c.data)
    if (p && (p.parameters.length || p.graphs.length || Object.keys(p.metadata).length)) { parsed = p; parsedFrom = c.name; break }
    if (p && !parsed) { parsed = p; parsedFrom = c.name }
  }

  // Reject anything that carries none of a Substance archive's landmarks. Without this a renamed
  // PNG/JPG would be "imported" as an empty archive.
  const landmarks = parsed && (parsed.parameters.length || parsed.graphs.length || Object.keys(parsed.metadata).length)
  if (!landmarks && !images.length && !assemblies.length) {
    throw new Error(
      container === 'zip'
        ? 'Not a Substance archive: the zip has no graph XML, bitmaps or .sbsasm assembly'
        : 'Not a Substance archive: no descriptor XML, bitmap or SBAM assembly was found'
    )
  }

  if (!parsed) {
    parsed = { rootName: '', graphs: [], parameters: [], outputs: [], metadata: {} }
    if (container === 'zip') warnings.push('Archive has no readable graph XML; only bitmaps were imported.')
  }
  if (!parsed.graphs.length) {
    const name = String(parsed.metadata.graph || parsed.metadata.name || '').trim()
    if (name) parsed.graphs.push({ identifier: name, label: name })
  }

  // de-duplicate outputs and images
  const seenOut = new Set()
  const outputs = parsed.outputs.filter((o) => (seenOut.has(o.usage) ? false : seenOut.add(o.usage)))

  const imagesOut = []
  const seenImg = new Set()
  for (const img of images.slice(0, maxImages)) {
    const key = img.bytes ? sha256(img.bytes) : Math.random().toString(36)
    if (seenImg.has(key)) continue
    seenImg.add(key)
    const isPreview = /thumb|icon|preview/i.test(img.name || '') || (img.width === 128 && img.height === 128)
    imagesOut.push({
      name: img.name || `substance-image-${imagesOut.length + 1}.${img.mime === 'image/png' ? 'png' : 'jpg'}`,
      mime: img.mime,
      width: img.width,
      height: img.height,
      bytes: img.bytes.length,
      role: isPreview ? 'preview' : 'resource',
      confidence: container === 'zip' ? 'certain' : 'heuristic',
      sha256: key,
      ...(includeImageBytes ? { data: img.bytes.toString('base64') } : {})
    })
  }

  const shape = {
    container,
    containerConfidence: container === 'zip' ? 'certain' : 'heuristic',
    fileBytes: buf.length,
    sha256: sha256(buf),
    graphXml: parsedFrom,
    rootElement: parsed.rootName || null,
    metadata: parsed.metadata,
    graphs: parsed.graphs,
    parameters: parsed.parameters,
    outputs,
    images: imagesOut,
    assemblies,
    entryCount: entries.length,
    entries: entries.slice(0, 200).map((e) => ({ name: e.name, size: e.size, method: e.method })),
    canEvaluate: false,
    evaluateBlockedReason:
      'Substance graph evaluation requires Adobe\'s Substance Engine; the .sbsasm in this archive is proprietary bytecode. This importer reads metadata and embedded bitmaps only.',
    warnings,
    notes
  }
  shape.imagePayloads = images.slice(0, maxImages).map((img, i) => ({
    index: i,
    mime: img.mime,
    width: img.width,
    height: img.height,
    name: imagesOut[i]?.name,
    role: imagesOut[i]?.role,
    bytes: img.bytes
  }))
  return shape
}

/** find XML documents in a raw buffer (native containers, or resources inside them) */
function scanXml(buf) {
  const out = []
  const needles = [Buffer.from('<?xml'), Buffer.from('<sbsar'), Buffer.from('<substance'), Buffer.from('<sbsdoc')]
  for (const needle of needles) {
    let at = buf.indexOf(needle)
    while (at >= 0 && out.length < 8) {
      const slice = buf.subarray(at, Math.min(buf.length, at + MAX_XML_CHARS))
      const end = findXmlEnd(slice)
      if (end > 0) out.push({ name: 'xml@' + at, data: slice.subarray(0, end) })
      at = buf.indexOf(needle, at + 4)
    }
  }
  if (!out.length) {
    // compressed XML: try zlib streams
    for (let i = 0; i < buf.length - 2; i++) {
      const cmf = buf[i]
      const flg = buf[i + 1]
      if ((cmf & 0x0f) !== 8 || (cmf >> 4) > 7 || (cmf * 256 + flg) % 31 !== 0) continue
      try {
        const text = zlib.inflateSync(buf.subarray(i), { finishFlush: zlib.constants.Z_SYNC_FLUSH })
        if (text.length > 64 && /^\s*(<\?xml|<sbsar|<substance|<sbsdoc|<graph)/.test(text.toString('utf8', 0, Math.min(64, text.length)))) {
          out.push({ name: 'xml.zlib@' + i, data: text })
          if (out.length >= 4) break
        }
      } catch (e) { /* not a stream */ }
    }
  }
  return out
}

function findXmlEnd(buf) {
  // last plausible closing tag of the outermost element we started at
  for (const tag of ['</sbsar>', '</substance>', '</sbsdoc>', '</package>']) {
    const at = buf.lastIndexOf(Buffer.from(tag))
    if (at > 0) return at + tag.length
  }
  return 0
}

export const SBSAR_LIMITS = { MAX_IMAGE_BYTES, MAX_IMAGES }
