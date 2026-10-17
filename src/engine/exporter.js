// Material package exporter: PBR channel packing, PNG encoding and server packaging.
import { encodePngAsync } from './pngClient.js'

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

export function sanitizeName(name) {
  const clean = String(name || 'Material')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
  return clean || 'Material'
}

/** Build the file plan for a preset without touching the GPU (used by the export dialog UI). */
export function planFiles(opts) {
  const { preset = 'gltf', name = 'Material', hasEmissive = false, hasOpacity = false, alphaMode = 0 } = opts
  const n = sanitizeName(name)
  const files = []
  const add = (spec) => files.push(spec)
  const alpha = alphaMode !== 0 && hasOpacity

  if (preset === 'gltf') {
    add({ kind: 'basecolor', fileName: `T_${n}_BaseColor.png`, colorType: alpha ? 6 : 2, srgb: true, label: 'Base Color' })
    add({ kind: 'normal', fileName: `T_${n}_Normal.png`, colorType: 2, srgb: false, label: 'Normal' })
    add({ kind: 'orm', fileName: `T_${n}_ORM.png`, colorType: 2, srgb: false, label: 'ORM (AO/Rough/Metal)' })
    add({ kind: 'height', fileName: `T_${n}_Height.png`, colorType: 0, bitDepth: 16, srgb: false, label: 'Height' })
    if (hasEmissive) add({ kind: 'emissive', fileName: `T_${n}_Emissive.png`, colorType: 2, srgb: true, label: 'Emissive' })
  } else if (preset === 'unreal') {
    add({ kind: 'basecolor', fileName: `T_${n}_BC.png`, colorType: alpha ? 6 : 2, srgb: true, label: 'Base Color' })
    add({ kind: 'normal', fileName: `T_${n}_N.png`, colorType: 2, srgb: false, label: 'Normal (DirectX)' })
    add({ kind: 'orm', fileName: `T_${n}_ORM.png`, colorType: 2, srgb: false, label: 'ORM' })
    add({ kind: 'height', fileName: `T_${n}_H.png`, colorType: 0, bitDepth: 16, srgb: false, label: 'Height' })
    if (hasEmissive) add({ kind: 'emissive', fileName: `T_${n}_E.png`, colorType: 2, srgb: true, label: 'Emissive' })
  } else if (preset === 'unity') {
    add({ kind: 'basecolor', fileName: `${n}_AlbedoTransparency.png`, colorType: alpha ? 6 : 2, srgb: true, label: 'Albedo' })
    add({ kind: 'normal', fileName: `${n}_Normal.png`, colorType: 2, srgb: false, label: 'Normal (DirectX)' })
    add({ kind: 'maskmap', fileName: `${n}_MaskMap.png`, colorType: 6, srgb: false, label: 'Mask Map (M/AO/D/S)' })
    add({ kind: 'height', fileName: `${n}_Height.png`, colorType: 0, bitDepth: 16, srgb: false, label: 'Height' })
    if (hasEmissive) add({ kind: 'emissive', fileName: `${n}_Emissive.png`, colorType: 2, srgb: true, label: 'Emissive' })
  } else if (preset === 'substance') {
    add({ kind: 'basecolor', fileName: `${n}_basecolor.png`, colorType: alpha ? 6 : 2, srgb: true, label: 'Base Color' })
    add({ kind: 'normal', fileName: `${n}_normal.png`, colorType: 2, srgb: false, label: 'Normal' })
    add({ kind: 'roughness', fileName: `${n}_roughness.png`, colorType: 0, srgb: false, label: 'Roughness' })
    add({ kind: 'metallic', fileName: `${n}_metallic.png`, colorType: 0, srgb: false, label: 'Metallic' })
    add({ kind: 'ao', fileName: `${n}_ao.png`, colorType: 0, srgb: false, label: 'AO' })
    add({ kind: 'height', fileName: `${n}_height.png`, colorType: 0, bitDepth: 16, srgb: false, label: 'Height' })
    if (hasEmissive) add({ kind: 'emissive', fileName: `${n}_emissive.png`, colorType: 2, srgb: true, label: 'Emissive' })
  } else {
    add({ kind: 'basecolor', fileName: `${n}_BaseColor.png`, colorType: alpha ? 6 : 2, srgb: true, label: 'Base Color' })
    add({ kind: 'normal', fileName: `${n}_Normal.png`, colorType: 2, srgb: false, label: 'Normal' })
    add({ kind: 'roughness', fileName: `${n}_Roughness.png`, colorType: 0, srgb: false, label: 'Roughness' })
    add({ kind: 'metallic', fileName: `${n}_Metallic.png`, colorType: 0, srgb: false, label: 'Metallic' })
    add({ kind: 'ao', fileName: `${n}_AO.png`, colorType: 0, srgb: false, label: 'AO' })
    add({ kind: 'height', fileName: `${n}_Height.png`, colorType: 0, bitDepth: 16, srgb: false, label: 'Height' })
    if (hasEmissive) add({ kind: 'emissive', fileName: `${n}_Emissive.png`, colorType: 2, srgb: true, label: 'Emissive' })
  }
  return files
}

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

function bytesToBase64(bytes) {
  let out = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(out)
}

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
  const plan = planFiles({ preset, name: materialName, hasEmissive, hasOpacity, alphaMode })
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
  const flipY = sourceNormal !== targetNormal

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

  const blobUrls = files.map((f) => ({
    path: f.path,
    url: URL.createObjectURL(new Blob([f.bytes], { type: 'image/png' })),
    bytes: f.bytes.length
  }))

  return { ok: !!server, server, serverError, files, blobUrls, manifest, readme }
}
