// SBSAR（.sbsar / Substance Archive）检查器 — 零依赖。
//
// 真实 .sbsar 是 7-Zip 归档。Adobe 发布文档给出的布局，并说明读取方应「用任意 LZMA 解码器打开」：
//   assemblies/content/<n>/<Graph>.xml      图描述 —— 工具真正解析的 XML
//   assemblies/content/<n>/<Graph>.sbsasm   引擎字节码（magic "SBAM"），按平台构建
//   assemblies/content/<n>/metadata.json    包元数据（JSON，不是 XML）
//   assemblies/content/<n>/resources/<id>/  通用资源（图片、文本等）
//
// 本导入器能做与不能做的事：
//   1. 读取归档（元数据、图、带范围/默认值的输入参数、输出 usage、内嵌位图），并把位图作为普通
//      贴图素材交出去；
//   2. 明确解释为什么这里**无法求值**：.sbsasm 是 Adobe Substance Engine 的私有字节码，
//      换分辨率烘焙必须用 Adobe 引擎，浏览器做不到（报告里 canEvaluate 恒为 false）。
//
// 容器处理分三层：
//   * 7z     —— 真实格式（sevenzip.mjs + lzma.mjs 解码 LZMA/LZMA2/Copy），结果可信。
//   * zip    —— 某些工具会把归档重打包成普通 zip，此时中央目录同样可信。
//   * scan   —— 不透明/混淆容器：用扫描方式恢复描述 XML（含 zlib 压缩的）与图片块，
//              所有由此发现的条目都标记 confidence='heuristic'。
//
// 对外接口：inspectSbsar(buf, options)（被 server/assets.mjs 与 SBSAR 检查接口调用）、SBSAR_LIMITS。
// 安全边界：XML 最多 4 MB 字符、单图最多 24 MB、最多 24 张图；扫描用 zlib 试探时捕获所有异常，
// 不会因畸形归档崩溃；最终若既无 XML/元数据又无位图/汇编，则判定「不是 Substance 归档」并抛错。
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'
import { is7z, read7z } from './sevenzip.mjs'

const MAX_XML_CHARS = 4 * 1024 * 1024
const MAX_IMAGE_BYTES = 24 * 1024 * 1024
const MAX_IMAGES = 24

/**
 * 计算 SHA-256 十六进制摘要（用于图片去重与归档指纹）。
 * @param {Buffer|Uint8Array} buf
 * @returns {string}
 */
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// ---------------------------------------------------------------------------- container: zip
/**
 * 把普通 ZIP 当作归档读取（用于被重打包的 .sbsar）。
 * 从 EOCD（0x06054b50）反查中央目录，逐条读取方法/压缩大小/原始大小/局部头偏移；
 * method=0 直接取字节，method=8 用 zlib.inflateRawSync 解压；其他方法或解压失败只记录 error 不中断。
 * ZIP64（count/offset 为 0xFFFF/0xFFFFFFFF）只返回空表并给出提示，不做完整支持。
 * @param {Buffer} buf 归档字节
 * @returns {{entries:object[],zip64:boolean}|null} 未找到 EOCD 时返回 null
 */
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
/**
 * 极简容错 XML 解析器：只用正则扫描，不依赖任何库，也不做 DTD/实体展开。
 * 产出 { name, attrs, children, text } 树；支持注释/处理指令/DOCTYPE 跳过、CDATA、自闭合标签。
 * 关闭标签只弹栈而不校验名字，遇到不配对文档也能得到近似树（导入场景够用）。
 * @param {string} text XML 文本
 * @returns {{name:string,attrs:object,children:object[],text:string}} 根节点（#root）
 */
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

/**
 * 深度优先遍历所有节点（含自身）。
 * @param {object} node 起始节点
 * @param {(node:object)=>void} visit 回调
 * @returns {void}
 */
function walk(node, visit) {
  visit(node)
  for (const c of node.children) walk(c, visit)
}

/**
 * 取标签/属性的本地名（去掉命名空间前缀并转小写）。
 * @param {string} n
 * @returns {string}
 */
function localName(n) {
  const i = String(n || '').indexOf(':')
  return (i >= 0 ? String(n).slice(i + 1) : String(n || '')).toLowerCase()
}

// ---------------------------------------------------------------------------- bitmap blobs
/**
 * 识别 PNG 并取宽高/位深/颜色类型；用尾部 IEND 标记裁掉多余尾随字节。
 * @param {Buffer|Uint8Array} buf 可能是从更大缓冲区切出的片段
 * @returns {{mime:string,width:number,height:number,bitDepth:number,colorType:number,bytes:Buffer}|null}
 *          不是 PNG 时返回 null
 */
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

/**
 * 识别 JPEG，扫描 SOF 段取宽高，用尾部 EOI(0xFFD9) 裁剪数据。
 * @param {Buffer|Uint8Array} buf
 * @returns {{mime:string,width:number|null,height:number|null,bitDepth:number,colorType:number,bytes:Buffer}|null}
 */
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
/**
 * 在不透明容器里扫描图片：先按 PNG/JPEG 魔数顺序查找，再（可选）遍历疑似 zlib 头尝试 inflate。
 * 用「字节数 + 宽高」去重，最多返回 max 张。
 * @param {Buffer} buf 容器字节
 * @param {{zlibProbe:boolean,max:number}} opts zlibProbe 是否尝试解压流，max 结果上限
 * @returns {object[]} pngInfo/jpegInfo 结果 + via('raw'|'zlib')
 */
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

/**
 * 按别名顺序找第一个存在的属性值（大小写/命名空间不敏感）。
 * @param {Record<string,string>} attrs 属性表
 * @param {string[]} keys 本地名别名列表
 * @returns {string|undefined}
 */
function firstAttr(attrs, keys) {
  for (const k of keys) {
    for (const name of Object.keys(attrs)) {
      if (localName(name) === k) return attrs[name]
    }
  }
  return undefined
}

/** pull numeric hints out of child <gui*-like> elements: attributes first (real SBSAR), then text */
/**
 * 从子级 <gui*> 元素提取数值提示：min/max/step/default。
 * 真实 SBSAR 把范围放在属性（<guislider min="1" max="64" step="1"/>），旧格式放在文本节点。
 * 同时收集 combo 的枚举项与 toggle 的布尔标签。
 * @param {object} node 参数节点
 * @returns {{min?:number,max?:number,step?:number,default?:any,enumItems?:string[],hasCombo?:boolean,boolLabels?:string[]}}
 */
function guiHints(node) {
  const out = {}
  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v))
  const put = (key, v) => {
    const n = num(v)
    if (n !== undefined && out[key] === undefined) out[key] = n
  }
  const readNode = (n) => {
    const ln = localName(n.name)
    // real sbsar: <guislider min="1" max="64" step="1"/>
    for (const [k, v] of Object.entries(n.attrs || {})) {
      const ak = localName(k)
      if (ak === 'min' || ak === 'minimum') put('min', v)
      else if (ak === 'max' || ak === 'maximum') put('max', v)
      else if (ak === 'step' || ak === 'increment') put('step', v)
      else if (ak === 'default' || ak === 'value') put('default', v)
    }
    // older/other schemas: <min>0</min> text content
    if (['min', 'minimum', 'max', 'maximum', 'step', 'increment', 'default', 'value'].includes(ln)) {
      const key = ln === 'minimum' ? 'min' : ln === 'maximum' ? 'max' : ln === 'increment' ? 'step' : ln
      put(key, firstAttr(n.attrs || {}, ['value', 'v']) ?? n.text.trim())
    }
    // <guibutton label0="False" label1="True"/> → boolean kind
    if (ln === 'guibutton' && firstAttr(n.attrs || {}, ['label0'])) out.boolLabels = [firstAttr(n.attrs || {}, ['label0']), firstAttr(n.attrs || {}, ['label1'])]
    if (ln === 'guicomboboxitem') {
      const text = firstAttr(n.attrs || {}, ['text', 'label', 'value']) ?? n.text.trim()
      if (text) (out.enumItems = out.enumItems || []).push(text)
    }
    if (ln === 'guicombobox' && (out.enumItems || []).length) out.hasCombo = true
  }
  walk(node, readNode)
  return out
}

/** map a real-SBSAR widget/type pair to a friendly parameter kind */
/**
 * 把真实 SBSAR 的 widget/showAs/type 映射成前端使用的参数 kind：
 * bool / enum / angle / float / color / image / vector2 / output / other。
 * 优先看 widget，其次 showAs，最后用数字化 type（'4'=float，'8'=vector2，'5'=output）。
 * @param {string} widget
 * @param {string} showAs
 * @param {string|null} typeRaw
 * @param {object} hints guiHints() 结果
 * @returns {string}
 */
function paramKind(widget, showAs, typeRaw, hints) {
  const w = String(widget || '').toLowerCase()
  const s2 = String(showAs || '').toLowerCase()
  if (w === 'togglebutton' || s2 === 'bool' || s2 === 'boolean') return 'bool'
  if (w === 'combobox' || (hints && hints.hasCombo)) return 'enum'
  if (w === 'angle' || s2 === 'angle') return 'angle'
  if (w === 'slider' || w === 'spinbox') return 'float'
  if (w === 'color' || s2 === 'color') return 'color'
  if (w === 'image' || s2 === 'image') return 'image'
  const t = String(typeRaw == null ? '' : typeRaw)
  if (t === '4') return 'float'
  if (t === '8') return 'vector2'
  if (t === '5') return 'output'
  return 'other'
}

/**
 * 从一段 XML 字节里提取图、参数、输出、通道与元数据。
 * 容错策略：使用多个标签别名（input/param/parameter/compinput/graphinput），
 * 参数的范围/枚举既支持属性也支持嵌套 <gui*> 文本；同名元数据保留首个值。
 * @param {Buffer} buf XML 字节
 * @returns {{rootName:string,graphs:object[],parameters:object[],outputs:object[],channels:object[],metadata:object}|null}
 *          文本不像 XML 时返回 null
 */
function collectFromXml(buf) {
  const text = buf.toString('utf8')
  if (!/^[\s\uFEFF]*(<\?xml|<\w)/.test(text)) return null
  const tree = parseXml(text)
  const graphs = []
  const parameters = []
  const outputs = []
  const channels = []
  const metadata = {}
  let rootName = ''

  walk(tree, (node) => {
    const ln = localName(node.name)
    if (!rootName && node !== tree && node.children.length) rootName = ln
    const a = node.attrs || {}

    if (ln === 'graph') {
      const pkgurl = firstAttr(a, ['pkgurl', 'identifier', 'id', 'name'])
      const id = (pkgurl || '').replace(/^pkg:\/\//, '')
      const label = firstAttr(a, ['label', 'displayname']) || id
      if (id || label) {
        graphs.push({
          identifier: id || label,
          label: label || id,
          graphType: firstAttr(a, ['graphtype', 'type']) || null,
          physicalSize: firstAttr(a, ['physicalsize']) || null,
          icon: firstAttr(a, ['icon']) || null
        })
      }
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
      // real sbsar keeps label/group/description/widget on the nested <inputgui> element
      let gui = null
      walk(node, (n) => {
        if (!gui && localName(n.name) === 'inputgui') gui = n.attrs || {}
      })
      const typeRaw = firstAttr(a, ATTR_ALIASES.type) || null
      const widget = gui ? firstAttr(gui, ['widget']) : undefined
      parameters.push({
        id,
        label: (gui && firstAttr(gui, ['label'])) || firstAttr(a, ATTR_ALIASES.label) || id,
        kind: paramKind(widget, gui ? firstAttr(gui, ['showas']) : undefined, typeRaw, hints),
        widget: widget || null,
        group: (gui && firstAttr(gui, ['group'])) || null,
        description: (gui && firstAttr(gui, ['description'])) || null,
        enumItems: hints.enumItems && hints.enumItems.length ? hints.enumItems : undefined,
        type: typeRaw,
        default: firstAttr(a, ATTR_ALIASES.def) ?? hints.default ?? null,
        min: num(firstAttr(a, ATTR_ALIASES.min)) ?? hints.min ?? null,
        max: num(firstAttr(a, ATTR_ALIASES.max)) ?? hints.max ?? null,
        step: num(firstAttr(a, ATTR_ALIASES.step)) ?? hints.step ?? null
      })
      return
    }
    if (ln === 'channel' || ln === 'channels') {
      const name = firstAttr(a, ['names', 'name', 'identifier'])
      if (name) channels.push({ name, colorspace: firstAttr(a, ['colorspace', 'space']) || null })
      return
    }
    if (['output', 'usage', 'outputusage'].includes(ln)) {
      const usage = firstAttr(a, ['usage', 'identifier', 'name'])
      if (!usage) return
      outputs.push({
        usage,
        format: firstAttr(a, ['format']) || null,
        width: firstAttr(a, ['width']) || null,
        height: firstAttr(a, ['height']) || null
      })
    }
  })

  return { rootName, graphs, parameters, outputs, channels, metadata }
}

// ---------------------------------------------------------------------------- public entry
/**
 * 按归档内路径判断图片角色：含 thumb/icon/preview 记为 'preview'，否则 'resource'。
 * @param {string} name
 * @returns {'preview'|'resource'}
 */
function imgRole(name) {
  return /thumb|icon|preview|.png$/i.test(name) && /thumb|icon|preview/i.test(name) ? 'preview' : 'resource'
}

/**
 * 检查一个 .sbsar 缓冲区，返回完整报告（默认不内联图片字节，服务端另行存盘）。
 * 容器识别顺序：7z（权威）→ zip（权威）→ 扫描（启发式）。报告包含 container/containerConfidence、
 * graphs、parameters、outputs、channels、images、assemblies、entries、warnings/notes，
 * 以及固定为 false 的 canEvaluate 与原因 evaluateBlockedReason。
 * @param {Buffer} buf 归档字节
 * @param {{includeImageBytes?:boolean,maxImages?:number}} [options]
 * @returns {object} 检查报告；imagePayloads 保留原始图片 Buffer 供导入器落盘
 * @throws {Error} 文件过小，或既无描述 XML/元数据又无位图/SBAM 汇编（判定为非 Substance 归档）
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
  const metadataFromJson = {}

  // 第一优先：标准 7z 容器。中央目录/文件头是权威来源，解析失败时仍继续尝试其它路径。
  if (is7z(buf)) {
    container = '7z'
    try {
      const archive = read7z(buf)
      entries = archive.entries.filter((e) => !e.isDir)
    } catch (e) {
      warnings.push('7z container detected but could not be read: ' + e.message)
    }
    for (const e of entries) {
      if (/\.(png|jpe?g)$/i.test(e.name)) {
        const info = pngInfo(e.data) || jpegInfo(e.data)
        if (info) images.push({ ...info, name: e.name, role: imgRole(e.name), bytes: info.bytes })
      } else if (/\.xml$/i.test(e.name)) {
        xmlCandidates.push({ name: e.name, data: e.data })
      } else if (/metadata\.json$/i.test(e.name)) {
        try {
          const meta = JSON.parse(e.data.toString('utf8'))
          if (meta && typeof meta === 'object') for (const [k, v] of Object.entries(meta)) if (!metadataFromJson[k]) metadataFromJson[k] = String(v)
        } catch (err) {
          warnings.push(e.name + ': metadata.json is not valid JSON')
        }
      } else if (/\.sbsasm$/i.test(e.name)) {
        assemblies.push({ name: e.name, bytes: e.data.length })
      }
    }
    notes.push('7z archive read from its entry table (authoritative).')
  }

  // 第二优先：被工具重打包成普通 zip 的归档。
  const zip = container === 'unknown' ? readZip(buf) : null
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
  } else if (container === 'unknown') {
    // 第三优先：不透明原生容器。没有公开的目录结构，只能做启发式扫描，
    // 结果可能不完整，因此报告中所有条目都标 confidence='heuristic'。
    // opaque container: scan for what we can recognise
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
        : container === '7z'
          ? 'Not a Substance archive: the 7z payload has no descriptor XML, bitmap or SBAM assembly'
          : 'Not a Substance archive: no descriptor XML, bitmap or SBAM assembly was found'
    )
  }

  if (parsed) {
    for (const [k, v] of Object.entries(metadataFromJson)) if (!(k in parsed.metadata)) parsed.metadata[k] = v
  }
  if (!parsed) {
    parsed = { rootName: '', graphs: [], parameters: [], outputs: [], channels: [], metadata: {} }
    for (const [k, v] of Object.entries(metadataFromJson)) parsed.metadata[k] = v
    if (container === 'zip' || container === '7z') warnings.push('Archive has no readable graph XML; only bitmaps were imported.')
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
      confidence: container === 'zip' || container === '7z' ? 'certain' : 'heuristic',
      sha256: key,
      ...(includeImageBytes ? { data: img.bytes.toString('base64') } : {})
    })
  }

  const shape = {
    container,
    containerConfidence: container === 'zip' || container === '7z' ? 'certain' : 'heuristic',
    fileBytes: buf.length,
    sha256: sha256(buf),
    graphXml: parsedFrom,
    rootElement: parsed.rootName || null,
    metadata: parsed.metadata,
    graphs: parsed.graphs,
    parameters: parsed.parameters,
    outputs,
    channels: parsed.channels || [],
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
/**
 * 从不透明容器里扫描 XML 描述：直接读取明文 XML；若失败，遍历疑似 zlib 头并尝试解压。
 * @param {Buffer} buf 容器字节
 * @returns {Buffer[]} 找到的 XML 字节（去重、最多 8 份）
 */
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

/**
 * 在整个缓冲区里找最后一个可能的根闭合标签，返回其结束位置。
 * 扫描得到的是近似片段，因此取「最后一个」而非配对扫描，容错性更好；找不到返回 0。
 * @param {Buffer} buf 容器字节
 * @returns {number} 片段结束下标（不含）；0 表示没找到
 */
function findXmlEnd(buf) {
  // last plausible closing tag of the outermost element we started at
  for (const tag of ['</sbsar>', '</substance>', '</sbsdoc>', '</package>']) {
    const at = buf.lastIndexOf(Buffer.from(tag))
    if (at > 0) return at + tag.length
  }
  return 0
}

/**
 * 对外暴露的资源限额（导入器与前端据此给出友好提示）。
 * MAX_IMAGE_BYTES=24MB，MAX_IMAGES=24。
 */
export const SBSAR_LIMITS = { MAX_IMAGE_BYTES, MAX_IMAGES }
