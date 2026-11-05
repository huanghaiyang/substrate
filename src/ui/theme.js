/**
 * 界面主题与「选项常量」的集中定义。
 *
 * 目的：节点分类配色、分辨率档位、预览缩放、预览几何体这些取值同时被节点库、
 * 顶栏下拉框、状态栏与 3D 预览使用；集中在这里可以避免各处写死同一份数组/色值，
 * 新增分类或档位时只改这一处。本模块不依赖 Vue，纯数据 + 一个小工具函数。
 */

/** 节点分类 → 分类色：用于节点库分类圆点、节点标题角标与连线强调色 */
export const CAT_COLORS = {
  Input: '#4fb3d9',
  Noise: '#7b8cff',
  Pattern: '#9d7bff',
  Shape: '#b06bd9',
  Color: '#e0679f',
  Paint: '#e0574a',
  Filter: '#43b581',
  Blend: '#4aa8d8',
  Adjust: '#d9a44a',
  Normal: '#57c2b0',
  Output: '#f0a44a'
}

/**
 * 取节点分类色。
 * @param {string} cat 节点定义里的 category 字段
 * @returns {string} 十六进制颜色；未登记的分类回退到中性灰，保证界面不会出现 undefined 色值
 */
export function catColor(cat) {
  return CAT_COLORS[cat] || '#8b93a1'
}

/** 输出纹理的边长档位（正方形），顶栏下拉框直接遍历此数组 */
export const RESOLUTIONS = [512, 1024, 2048, 4096]

/** 实时预览的渲染倍率：低倍率用于大分辨率下保持流畅，100% 才是最终画质 */
export const PROXIES = [
  { value: 0.5, label: '50%' },
  { value: 0.75, label: '75%' },
  { value: 1, label: '100%' }
]

/** 3D 预览可切换的几何体；id 传给预览引擎，label 直接展示给用户（暂不做多语言） */
export const SHAPES = [
  { id: 'sphere', label: 'Sphere' },
  { id: 'plane', label: 'Plane' },
  { id: 'cube', label: 'Cube' },
  { id: 'cylinder', label: 'Cylinder' },
  { id: 'torus', label: 'Torus' }
]
