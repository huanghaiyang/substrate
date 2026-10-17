export const outputDef = {
  type: 'material_output',
  name: 'PBR Output',
  category: 'Output',
  isOutput: true,
  space: 'color',
  desc: 'Material sink. Defines which PBR channels are exported, the normal convention and alpha mode.',
  inputs: [
    { name: 'basecolor', label: 'Base Color', space: 'color', def: [0.5, 0.5, 0.5] },
    { name: 'height', label: 'Height', space: 'data', def: 0.5 },
    { name: 'normal', label: 'Normal', space: 'data', def: [0.5, 0.5, 1] },
    { name: 'roughness', label: 'Roughness', space: 'data', def: 0.5 },
    { name: 'metallic', label: 'Metallic', space: 'data', def: 0 },
    { name: 'ao', label: 'AO', space: 'data', def: 1 },
    { name: 'emissive', label: 'Emissive', space: 'color', def: [0, 0, 0] },
    { name: 'opacity', label: 'Opacity', space: 'data', def: 1 }
  ],
  params: [
    { key: 'materialName', label: 'Material Name', type: 'text', def: 'Untitled Material' },
    { key: 'normalConvention', label: 'Normal Map', type: 'select', options: ['OpenGL (+Y up)', 'DirectX (-Y up)'], def: 0 },
    { key: 'normalizeHeight', label: 'Normalize Height', type: 'bool', def: true },
    { key: 'alphaMode', label: 'Alpha Mode', type: 'select', options: ['Opaque', 'Masked', 'Blended'], def: 0 },
    { key: 'alphaCutoff', label: 'Alpha Cutoff', type: 'float', min: 0.01, max: 0.99, step: 0.01, def: 0.5 }
  ]
}
