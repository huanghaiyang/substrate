/**
 * 唯一的「材质输出」节点定义（sink）。
 *
 * 它不参与渲染：求值时引擎只收集各输入口上游的纹理，作为导出/预览的 final 通道。
 * 输入口的 def 是未连接时的中性值（灰色基础色、0.5 高度、法线朝前、金属度 0、AO 1 等），
 * 保证输出节点即使只连了部分通道也能得到合理结果。
 *
 * space 字段用于 UI 提示该端口是颜色还是数据（数据端口不应做 sRGB 编码）。
 */
export const outputDef = {
  type: 'material_output',
  name: 'PBR Output',
  category: 'Output',
  // isOutput 让引擎跳过该节点的渲染，直接把上游纹理登记为最终通道
  isOutput: true,
  space: 'color',
  desc: 'Material sink. Defines which PBR channels are exported, the normal convention and alpha mode.',
  // 8 个标准 PBR 输入口；def 为未连接时的默认常量
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
  // 导出/显示相关的设置：
  // materialName 决定文件名前缀；normalConvention 决定是否翻转法线 Y；
  // normalizeHeight 控制 16 位高度是否拉伸满量程；alphaMode/alphaCutoff 控制透明度语义。
  params: [
    { key: 'materialName', label: 'Material Name', type: 'text', def: 'Untitled Material' },
    { key: 'normalConvention', label: 'Normal Map', type: 'select', options: ['OpenGL (+Y up)', 'DirectX (-Y up)'], def: 0 },
    { key: 'normalizeHeight', label: 'Normalize Height', type: 'bool', def: true },
    { key: 'alphaMode', label: 'Alpha Mode', type: 'select', options: ['Opaque', 'Masked', 'Blended'], def: 0 },
    { key: 'alphaCutoff', label: 'Alpha Cutoff', type: 'float', min: 0.01, max: 0.99, step: 0.01, def: 0.5 }
  ]
}
