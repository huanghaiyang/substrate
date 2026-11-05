/**
 * 材质包导出器：把 GPU 求值得到的各 PBR 通道回读、打包、编码为 PNG，
 * 连同 manifest.json 与 README 一并提交给本地服务器打包成 zip。
 *
 * 在整体架构中的位置：UI 的导出对话框先调用 planFiles 预估文件清单（不碰 GPU），
 * 用户确认后再调用 exportMaterial 真正执行导出。
 *
 * 主要导出：PRESETS（各引擎预设）、sanitizeName、planFiles、exportMaterial。
 *
 * 关键设计：
 * - 颜色贴图（Base Color / Emissive）做 sRGB 编码并写 sRGB chunk；
 * - 数据贴图（Normal/Roughness/Metallic/AO/Height/ORM/MaskMap）保持线性数值；
 * - 法线可根据目标约定做 Y 翻转，实现 OpenGL(+Y) 与 DirectX(-Y) 互转；
 * - 16 位高度图可选归一化到完整 0..65535 动态范围。
 */
import { encodePngAsync } from './pngClient.js'

/**
 * 各引擎/软件的导出预设。
 * targetNormal 表示该预设期望的法线 Y 方向约定：'gl' 为 OpenGL(+Y)，'dx' 为 DirectX(-Y)。
 * 每项中的 name/engine/desc 同时用于导出对话框的展示。
 */
export const PRESETS = [
  {
    id: 'gltf',
    name: 'glTF 2.0 / three.js',
    engine: 'three.js · Babylon.js · glTF · Blender',
    desc: 'Base Color (sRGB), Normal, ORM (AO / Roughness / Metallic), Height, Emissive',
    targetNormal: 'gl'
  },
  {
    id: 'unreal',
    name: 'Unreal Engine 5',
    engine: 'Unreal Engine 4/5',
    desc: 'T_*_BC, T_*_N (DirectX), T_*_ORM, T_*_H (16-bit), T_*_E',
    targetNormal: 'dx'
  },
  {
    id: 'unity',
    name: 'Unity HDRP / URP',
    engine: 'Unity 2021+ (HDRP, URP, Built-in)',
    desc: 'Albedo+Alpha, Normal (DirectX), Mask Map (Metal/AO/Detail/Smoothness), Height',
    targetNormal: 'dx'
  },
  {
    id: 'vray',
    name: 'V-Ray / Arnold / generic',
    engine: '3ds Max · Maya · Blender · Octane',
    desc: 'Separate BaseColor, Roughness, Metallic, AO, Normal, Height, Emissive',
    targetNormal: 'gl'
  },
  {
    id: 'substance',
    name: 'Substance Painter',
    engine: 'Substance Painter · Designer import',
    desc: 'basecolor, normal, roughness, metallic, height, ao, emissive',
    targetNormal: 'gl'
  }
]

/**
 * 清洗材质名，使其可以安全地用作文件名：
 * 只保留字母、数字、空格、下划线和短横线，空格转下划线；
 * 清洗后为空时回退为 'Material'。
 */
export function sanitizeName(name) {
  const clean = String(name || 'Material')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
  return clean || 'Material'
}

/**
 * 根据预设生成文件计划（纯计算，不访问 GPU），供导出对话框提前展示将要生成的文件。
 *
 * @param {object} opts
 * @param {string} [opts.preset='gltf'] 预设 id
 * @param {string} [opts.name='Material'] 材质名（会先被 sanitizeName 清洗）
 * @param {boolean} [opts.hasEmissive=false] 是否存在自发光通道
 * @param {boolean} [opts.hasOpacity=false] 是否存在不透明度通道
 * @param {number} [opts.alphaMode=0] 0=不透明，1=遮罩，2=混合；只有非 0 时才可能输出 alpha
 * @param {boolean} [opts.height16=true] 高度图是否使用 16 位
 * @returns {{kind: string, fileName: string, colorType: number, bitDepth?: number, srgb: boolean, label: string}[]}
 *   每个 kind 对应后续导出时的处理分支；colorType 为 PNG 颜色类型（0 灰度 / 2 RGB / 6 RGBA）
 */
export function planFiles(opts) {
  const { preset = 'gltf', name = 'Material', hasEmissive = false, hasOpacity = false, alphaMode = 0, height16 = true } = opts
  const n = sanitizeName(name)
  const files = []
  const add = (spec) => files.push(spec)
  // 只有 alphaMode 非「Opaque」且确实连接了 opacity 时才输出 RGBA
  const alpha = alphaMode !== 0 && hasOpacity

  if (preset === 'gltf') {
    add({ kind: 'basecolor', fileName: `T_${n}_BaseColor.png`, colorType: alpha ? 6 : 2, srgb: true, label: 'Base Color' })
    add({ kind: 'normal', fileName: `T_${n}_Normal.png`, colorType: 2, srgb: false, label: 'Normal' })
    add({ kind: 'orm', fileName: `T_${n}_ORM.png`, colorType: 2, srgb: false, label: 'ORM (AO/Rough/Metal)' })
    add({ kind: 'height', fileName: `T_${n}_Height.png`, colorType: 0, bitDepth: height16 ? 16 : 8, srgb: false, label: 'Height' })
    if (hasEmissive) add({ kind: 'emissive', fileName: `T_${n}_Emissive.png`, colorType: 2, srgb: true, label: 'Emissive' })
  } else if (preset === 'unreal') {
    add({ kind: 'basecolor', fileName: `T_${n}_BC.png`, colorType: alpha ? 6 : 2, srgb: true, label: 'Base Color' })
    add({ kind: 'normal', fileName: `T_${n}_N.png`, colorType: 2, srgb: false, label: 'Normal (DirectX)' })
    add({ kind: 'orm', fileName: `T_${n}_ORM.png`, colorType: 2, srgb: false, label: 'ORM' })
    add({ kind: 'height', fileName: `T_${n}_H.png`, colorType: 0, bitDepth: height16 ? 16 : 8, srgb: false, label: 'Height' })
    if (hasEmissive) add({ kind: 'emissive', fileName: `T_${n}_E.png`, colorType: 2, srgb: true, label: 'Emissive' })
  } else if (preset === 'unity') {
    add({ kind: 'basecolor', fileName: `${n}_AlbedoTransparency.png`, colorType: alpha ? 6 : 2, srgb: true, label: 'Albedo' })
    add({ kind: 'normal', fileName: `${n}_Normal.png`, colorType: 2, srgb: false, label: 'Normal (DirectX)' })
    add({ kind: 'maskmap', fileName: `${n}_MaskMap.png`, colorType: 6, srgb: false, label: 'Mask Map (M/AO/D/S)' })
    add({ kind: 'height', fileName: `${n}_Height.png`, colorType: 0, bitDepth: height16 ? 16 : 8, srgb: false, label: 'Height' })
    if (hasEmissive) add({ kind: 'emissive', fileName: `${n}_Emissive.png`, colorType: 2, srgb: true, label: 'Emissive' })
  } else if (preset === 'substance') {
    add({ kind: 'basecolor', fileName: `${n}_basecolor.png`, colorType: alpha ? 6 : 2, srgb: true, label: 'Base Color' })
    add({ kind: 'normal', fileName: `${n}_normal.png`, colorType: 2, srgb: false, label: 'Normal' })
    add({ kind: 'roughness', fileName: `${n}_roughness.png`, colorType: 0, srgb: false, label: 'Roughness' })
    add({ kind: 'metallic', fileName: `${n}_metallic.png`, colorType: 0, srgb: false, label: 'Metallic' })
    add({ kind: 'ao', fileName: `${n}_ao.png`, colorType: 0, srgb: false, label: 'AO' })
    add({ kind: 'height', fileName: `${n}_height.png`, colorType: 0, bitDepth: height16 ? 16 : 8, srgb: false, label: 'Height' })
    if (hasEmissive) add({ kind: 'emissive', fileName: `${n}_emissive.png`, colorType: 2, srgb: true, label: 'Emissive' })
  } else {
    add({ kind: 'basecolor', fileName: `${n}_BaseColor.png`, colorType: alpha ? 6 : 2, srgb: true, label: 'Base Color' })
    add({ kind: 'normal', fileName: `${n}_Normal.png`, colorType: 2, srgb: false, label: 'Normal' })
    add({ kind: 'roughness', fileName: `${n}_Roughness.png`, colorType: 0, srgb: false, label: 'Roughness' })
    add({ kind: 'metallic', fileName: `${n}_Metallic.png`, colorType: 0, srgb: false, label: 'Metallic' })
    add({ kind: 'ao', fileName: `${n}_AO.png`, colorType: 0, srgb: false, label: 'AO' })
    add({ kind: 'height', fileName: `${n}_Height.png`, colorType: 0, bitDepth: height16 ? 16 : 8, srgb: false, label: 'Height' })
    if (hasEmissive) add({ kind: 'emissive', fileName: `${n}_Emissive.png`, colorType: 2, srgb: true, label: 'Emissive' })
  }
  return files
}

/**
 * 以下四个函数负责「通道抽离」：
 * 引擎回读的数据统一是 RGBA 排列，这里按导出格式从中取出需要的分量。
 * - gray8：取 R 通道输出 8 位灰度；
 * - gray16：取 R 通道输出 16 位灰度（输入本身就是 Uint16Array）；
 * - rgb8：取 RGB 三个通道丢弃 alpha；
 * - rgab8：取 RGB 并用 opacity 贴图的 R 通道作为 alpha（缺省时不透明 255）。
 */
function gray8(rgba, count) {
  const out = new Uint8Array(count)
  for (let i = 0; i < count; i++) out[i] = rgba[i * 4]
  return out
}
function gray16(rgba, count) {
  const out = new Uint16Array(count)
  for (let i = 0; i < count; i++) out[i] = rgba[i * 4]
  return out
}
function rgb8(rgba, count) {
  const out = new Uint8Array(count * 3)
  for (let i = 0; i < count; i++) {
    out[i * 3] = rgba[i * 4]
    out[i * 3 + 1] = rgba[i * 4 + 1]
    out[i * 3 + 2] = rgba[i * 4 + 2]
  }
  return out
}
function rgab8(base, opacity, count) {
  const out = new Uint8Array(count * 4)
  for (let i = 0; i < count; i++) {
    out[i * 4] = base[i * 4]
    out[i * 4 + 1] = base[i * 4 + 1]
    out[i * 4 + 2] = base[i * 4 + 2]
    out[i * 4 + 3] = opacity ? opacity[i * 4] : 255
  }
  return out
}

/**
 * 把 16 位高度图线性拉伸到完整的 0..65535 动态范围。
 * 用途：GPU 中高度值通常落在很窄的区间，直接导出会浪费 16 位的精度；
 * 拉伸后地形细节对比更明显。全部像素值相同时（无起伏）原样返回，避免除以 0。
 */
function normalize16(arr) {
  let min = 65535
  let max = 0
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] < min) min = arr[i]
    if (arr[i] > max) max = arr[i]
  }
  if (max <= min) return arr
  const scale = 65535 / (max - min)
  const out = new Uint16Array(arr.length)
  for (let i = 0; i < arr.length; i++) out[i] = Math.round((arr[i] - min) * scale)
  return out
}

/**
 * 字节数组 → base64 字符串。
 * 分块（0x8000）调用 String.fromCharCode.apply，避免一次传入过多参数触发调用栈上限。
 */
function bytesToBase64(bytes) {
  let out = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(out)
}

/**
 * 根据 manifest 生成随包 README（Markdown）。
 * 内容包含分辨率、法线约定、通道表、色彩空间规则、各引擎导入要点，
 * 便于用户拿到 zip 后无需额外文档即可正确导入。README 本身是产物的一部分，保持英文内容。
 */
function buildReadme(manifest) {
  const f = manifest.files
    .map((file) => `| ${file.channel} | \`${file.path}\` | ${file.bitDepth}-bit | ${file.colorSpace} |`)
    .join('\n')
  return `# ${manifest.name}

Procedurally authored PBR material set, generated with **Substrate Texture Studio** (node graph on GPU).

- Resolution: **${manifest.resolution} × ${manifest.resolution}**
- Seamless / tileable: **${manifest.seamless ? 'yes' : 'no'}**
- Normal map convention: **${manifest.normalMap.convention}** tangent space
- Metallic workflow: **${manifest.pbr.metallicWorkflow ? 'yes' : 'no'}**
- Alpha mode: **${manifest.alpha.mode}**

## Channels

| Channel | File | Bit depth | Color space |
| --- | --- | --- | --- |
${f}

## Color space rules

- **Base Color / Emissive**: sRGB-encoded. Import with sRGB/color enabled (glTF: \`baseColorTexture\`, Unreal: \`sRGB\` on, Unity: \`sRGB (Color Texture)\` on).
- **Normal / Roughness / Metallic / AO / Height / ORM / Mask Map**: linear data. Import with sRGB off and "Normal map" type where applicable.

## Channel packing

- **ORM** (glTF / Unreal): R = Ambient Occlusion, G = Roughness, B = Metallic.
- **Mask Map** (Unity HDRP): R = Metallic, G = Ambient Occlusion, B = Detail mask (0.5), A = Smoothness (1 − Roughness).

## Engine quick start

### three.js / glTF
\`\`\`js
const maps = {
  map: baseColorTexture,            // colorSpace = SRGBColorSpace
  normalMap: normalTexture,
  roughnessMap: ormTexture,         // three reads the green channel
  metalnessMap: ormTexture,         // three reads the blue channel
  aoMap: ormTexture,                // three reads the red channel (needs uv2)
  displacementMap: heightTexture,
  emissiveMap: emissiveTexture      // colorSpace = SRGBColorSpace
}
\`\`\`

### Unreal Engine 5
Import with **BC = sRGB**, **N = Normalmap (DirectX)**, **ORM = Masks / linear**, **H = Grayscale / 16-bit**.
Wire ORM into the \`ORM\` material expression, H into World Position Offset or a tessellation/displacement slot.

### Unity HDRP
Use **AlbedoTransparency** as \`_BaseColorMap\`, **Normal** as \`_NormalMap\`, **MaskMap** as \`_MaskMap\`, **Height** as \`_HeightMap\`.

## Files in this package

\`\`\`json
${JSON.stringify(manifest.files.map((f) => f.path), null, 2)}
\`\`\`
`
}

/**
 * 执行完整导出流程。
 *
 * 步骤：
 * 1. 清洗材质名并生成文件计划；
 * 2. 调用 engine.beginExport 开启 streaming 求值会话（限制显存峰值）；
 * 3. 按计划逐通道回读、抽离/打包、PNG 编码，并通过 onProgress 回调汇报进度；
 * 4. finally 中一定调用 endExport，确保高分辨率纹理被释放；
 * 5. 组装 manifest + README，POST 到本地 /api/export 打包 zip；
 *    服务端失败时不抛错，而是回退为前端 Blob 下载（blobUrls），保证导出仍然可用。
 *
 * @param {import('./engine.js').TextureEngine} engine
 * @param {object} opts
 * @param {object} opts.graph 节点图
 * @param {number} [opts.resolution=1024] 导出分辨率（正方形边长）
 * @param {string} [opts.preset='gltf'] 预设 id
 * @param {string} [opts.materialName='Material'] 材质名
 * @param {'gl'|'dx'} [opts.targetNormal='gl'] 目标法线 Y 约定
 * @param {'gl'|'dx'} [opts.sourceNormal='gl'] 源法线 Y 约定（与目标不同时自动翻转 G 通道）
 * @param {boolean} [opts.height16=true] 高度图是否 16 位
 * @param {boolean} [opts.normalizeHeight=true] 是否把 16 位高度拉伸到满量程
 * @param {boolean} [opts.hasEmissive=false] 是否导出自发光
 * @param {boolean} [opts.hasOpacity=false] 是否导出 alpha
 * @param {number} [opts.alphaMode=0] 0 不透明 / 1 遮罩 / 2 混合
 * @param {(p: {step: number, total: number, label: string, done?: boolean}) => void} [opts.onProgress]
 * @returns {Promise<{ok: boolean, server: object|null, serverError: string, files: object[], blobUrls: object[], manifest: object, readme: string}>}
 * @throws {Error} 没有连接输出节点或缺少必要通道时抛出
 */
export async function exportMaterial(engine, opts) {
  const {
    graph,
    resolution = 1024,
    preset = 'gltf',
    materialName = 'Material',
    targetNormal = 'gl',
    height16 = true,
    normalizeHeight = true,
    hasEmissive = false,
    hasOpacity = false,
    alphaMode = 0,
    sourceNormal = 'gl',
    onProgress = null
  } = opts

  const name = sanitizeName(materialName)
  const plan = planFiles({ preset, name: materialName, hasEmissive, hasOpacity, alphaMode, height16 })
  const files = []
  const metas = []
  const session = engine.beginExport(graph, resolution)
  if (!session || !Object.keys(session.channelTextures).length) {
    engine.endExport(session)
    throw new Error('Nothing to export — connect an output node')
  }
  const w = resolution
  const h = resolution
  const count = w * h
  // 源与目标法线约定不一致时必须翻转 Y，否则光照方向会相反
  const flipY = sourceNormal !== targetNormal

  // 读取一个 8 位线性通道；缺失即视为图配置错误，直接抛错
  const read8 = (key) => {
    const data = engine.readExportChannel(session, key, { srgb: false })
    if (!data) throw new Error('Missing channel ' + key)
    return data
  }

  try {
    let step = 0
    for (const spec of plan) {
      step++
      if (onProgress) onProgress({ step, total: plan.length, label: spec.label })
      let bytes
      let bitDepth = spec.bitDepth || 8
      let colorType = spec.colorType
      let data
      let srgb = spec.srgb

      if (spec.kind === 'basecolor') {
        const base = engine.readExportChannel(session, 'basecolor', { srgb: true })
        const opacity = alphaMode !== 0 && hasOpacity ? read8('opacity') : null
        data = colorType === 6 ? rgab8(base, opacity, count) : rgb8(base, count)
      } else if (spec.kind === 'normal') {
        data = rgb8(engine.readExportChannel(session, 'normal', { srgb: false, flipY }), count)
      } else if (spec.kind === 'emissive') {
        data = rgb8(engine.readExportChannel(session, 'emissive', { srgb: true }), count)
      } else if (spec.kind === 'height') {
        bitDepth = height16 ? 16 : 8
        if (bitDepth === 16) {
          let raw = engine.readExportChannel(session, 'height', { srgb: false, bitDepth: 16 })
          let g = gray16(raw, count)
          if (normalizeHeight) g = normalize16(g)
          data = g
        } else {
          data = gray8(read8('height'), count)
        }
      } else if (spec.kind === 'roughness') {
        data = gray8(read8('roughness'), count)
      } else if (spec.kind === 'metallic') {
        data = gray8(read8('metallic'), count)
      } else if (spec.kind === 'ao') {
        data = gray8(read8('ao'), count)
      } else if (spec.kind === 'orm') {
        // glTF / UE 的 ORM 打包：R=AO，G=Roughness，B=Metallic
        const ao = read8('ao')
        const rough = read8('roughness')
        const metal = read8('metallic')
        const out = new Uint8Array(count * 3)
        for (let i = 0; i < count; i++) {
          out[i * 3] = ao[i * 4]
          out[i * 3 + 1] = rough[i * 4]
          out[i * 3 + 2] = metal[i * 4]
        }
        data = out
      } else if (spec.kind === 'maskmap') {
        // Unity HDRP MaskMap：R=Metallic，G=AO，B=Detail mask（固定 0.5），A=Smoothness(1-Roughness)
        const metal = read8('metallic')
        const ao = read8('ao')
        const rough = read8('roughness')
        const out = new Uint8Array(count * 4)
        for (let i = 0; i < count; i++) {
          out[i * 4] = metal[i * 4]
          out[i * 4 + 1] = ao[i * 4]
          out[i * 4 + 2] = 128
          out[i * 4 + 3] = 255 - rough[i * 4]
        }
        data = out
      } else {
        throw new Error('Unknown channel kind ' + spec.kind)
      }

      bytes = await encodePngAsync({ width: w, height: h, data, colorType, bitDepth, srgb })
      files.push({ path: spec.fileName, bytes, kind: spec.kind })
      metas.push({
        channel: spec.label,
        path: spec.fileName,
        bitDepth,
        colorSpace: srgb ? 'sRGB' : 'linear',
        bytes: bytes.length,
        colorType
      })
      if (onProgress) onProgress({ step, total: plan.length, label: spec.label, done: true })
    }
  } finally {
    engine.endExport(session)
  }

  const manifest = {
    name,
    displayName: materialName,
    generator: 'Substrate Texture Studio',
    generatorVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    resolution,
    seamless: true,
    preset,
    colorSpace: {
      baseColor: 'sRGB',
      emissive: 'sRGB',
      normal: 'linear',
      roughness: 'linear',
      metallic: 'linear',
      ao: 'linear',
      height: 'linear',
      orm: 'linear'
    },
    normalMap: {
      convention: targetNormal === 'dx' ? 'DirectX (-Y)' : 'OpenGL (+Y)',
      space: 'tangent',
      sourceConvention: sourceNormal === 'dx' ? 'DirectX (-Y)' : 'OpenGL (+Y)'
    },
    alpha: {
      mode: ['Opaque', 'Masked', 'Blended'][alphaMode] || 'Opaque'
    },
    pbr: {
      metallicWorkflow: true,
      orm: { r: 'Ambient Occlusion', g: 'Roughness', b: 'Metallic' }
    },
    files: metas,
    graph: { nodes: (graph.nodes || []).length, connections: (graph.connections || []).length }
  }
  const readme = buildReadme(manifest)

  let server = null
  let serverError = ''
  try {
    // 交给本地开发服务器打包成 zip；若服务不可用（如纯静态部署）则走下面的 Blob 回退
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        materialName: name,
        files: files.map((f) => ({ path: f.path, data: bytesToBase64(f.bytes) })),
        manifest,
        readme
      })
    })
    if (!res.ok) throw new Error(await res.text())
    server = await res.json()
  } catch (e) {
    serverError = e?.message || String(e)
  }

  // 为每个文件生成 Blob URL：即使服务端打包失败，用户也能逐个下载
  const blobUrls = files.map((f) => ({
    path: f.path,
    url: URL.createObjectURL(new Blob([f.bytes], { type: 'image/png' })),
    bytes: f.bytes.length
  }))

  return { ok: !!server, server, serverError, files, blobUrls, manifest, readme }
}
