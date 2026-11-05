/**
 * 内置笔刷预设与 CPU 笔尖绘制辅助（供 Paint Studio 使用）。
 *
 * 一个笔刷预设描述「笔尖性格」：形状、边缘衰减、颗粒、散布、间距、流量等。一笔的颜色、
 * 不透明度、大小、是否擦除与对称设置由笔画（stroke）携带，用户也可以在 Paint Studio
 * 里覆盖 hardness / flow / spacing。
 *
 * 预设字段含义：
 *  - shape：round 圆形 / flat 扁圆 / spray 喷点 / flora 植物图形；
 *  - hardness：0 最柔（纯径向渐变），1 最硬，接近 0.98 时边缘几乎没有过渡；
 *  - spacing：相邻笔尖的间距（按笔刷直径的比例），越小越连续，越大越像点彩；
 *  - flow：单个笔尖的不透明度系数；
 *  - grain：颗粒侵蚀强度，用 destination-out 在笔尖上打出小孔；
 *  - scatter：笔尖位置随机抖动的幅度（相对半径）；
 *  - angle / flatness：整体旋转角（度）与 Y 轴压扁比例（用于扁笔）；
 *  - sizeScale：笔尖尺寸相对笔画半径的缩放；
 *  - pressureSize / pressureFlow：笔压是否影响笔尖大小 / 不透明度；
 *  - rotateJitter / scaleJitter：每个笔尖的旋转与缩放随机量（主要给 flora 图形）；
 *  - motif：flora 使用的具体图形（草 / 叶 / 花 / 树 / 蕨 / 枝）。
 *
 * 性能设计：每个笔尖形状会预先渲染成一张小精灵画布（含 3 个颗粒变体），之后用
 * drawImage 直接贴图。画一条长笔画时每个笔尖只需一次 blit，而不必每次重建径向渐变
 * 和几百个颗粒圆，所以画布能保持流畅。
 */

const TAU = Math.PI * 2

// 基础笔刷：圆形/扁圆/喷点等通用笔尖，覆盖柔边、硬边、铅笔、墨水、喷枪等常见手感。
const BASIC_BRUSHES = [
  {
    id: 'soft-round',
    nameKey: 'brush.softRound',
    category: 'basic',
    shape: 'round',
    hardness: 0.05,
    spacing: 0.1,
    flow: 0.55,
    grain: 0,
    scatter: 0,
    angle: 0,
    flatness: 1,
    pressureSize: true,
    pressureFlow: false
  },
  {
    id: 'hard-round',
    nameKey: 'brush.hardRound',
    category: 'basic',
    shape: 'round',
    hardness: 0.96,
    spacing: 0.08,
    flow: 1,
    grain: 0,
    scatter: 0,
    angle: 0,
    flatness: 1,
    pressureSize: true,
    pressureFlow: false
  },
  {
    id: 'pencil',
    nameKey: 'brush.pencil',
    category: 'basic',
    shape: 'round',
    hardness: 0.92,
    spacing: 0.045,
    flow: 0.7,
    grain: 0.45,
    scatter: 0.05,
    angle: 18,
    flatness: 1,
    sizeScale: 0.72,
    pressureSize: true,
    pressureFlow: true
  },
  {
    id: 'ink',
    nameKey: 'brush.ink',
    category: 'basic',
    shape: 'round',
    hardness: 0.98,
    spacing: 0.03,
    flow: 1,
    grain: 0,
    scatter: 0,
    angle: 0,
    flatness: 1,
    sizeScale: 0.62,
    pressureSize: true,
    pressureFlow: true
  },
  {
    id: 'airbrush',
    nameKey: 'brush.airbrush',
    category: 'basic',
    shape: 'round',
    hardness: 0,
    spacing: 0.055,
    flow: 0.09,
    grain: 0.06,
    scatter: 0.14,
    angle: 0,
    flatness: 1,
    pressureSize: true,
    pressureFlow: true
  },
  {
    id: 'marker',
    nameKey: 'brush.marker',
    category: 'basic',
    shape: 'flat',
    hardness: 0.72,
    spacing: 0.035,
    flow: 0.45,
    grain: 0,
    scatter: 0,
    angle: 32,
    flatness: 0.42,
    pressureSize: false,
    pressureFlow: false
  },
  {
    id: 'chalk',
    nameKey: 'brush.chalk',
    category: 'basic',
    shape: 'round',
    hardness: 0.5,
    spacing: 0.07,
    flow: 0.5,
    grain: 0.92,
    scatter: 0.5,
    angle: 24,
    flatness: 1,
    pressureSize: true,
    pressureFlow: true
  },
  {
    id: 'spray',
    nameKey: 'brush.spray',
    category: 'basic',
    shape: 'spray',
    hardness: 0.9,
    spacing: 0.1,
    flow: 0.7,
    grain: 0.55,
    scatter: 1.1,
    angle: 0,
    flatness: 1,
    dots: 9,
    dotScale: 0.16,
    pressureSize: true,
    pressureFlow: true
  },
  {
    id: 'sponge',
    nameKey: 'brush.sponge',
    category: 'basic',
    shape: 'round',
    hardness: 0.42,
    spacing: 0.16,
    flow: 0.38,
    grain: 0.85,
    scatter: 0.42,
    angle: 0,
    flatness: 1,
    pressureSize: false,
    pressureFlow: true
  },
  {
    id: 'flat',
    nameKey: 'brush.flat',
    category: 'basic',
    shape: 'flat',
    hardness: 0.88,
    spacing: 0.05,
    flow: 0.66,
    grain: 0,
    scatter: 0,
    angle: 60,
    flatness: 0.22,
    pressureSize: true,
    pressureFlow: false
  }
]

// 自然笔刷：flora 图形笔尖（草、叶、花、树、蕨、枝），常用于植被与细节装饰。
const NATURE_BRUSHES = [
  {
    id: 'grass',
    nameKey: 'brush.grass',
    category: 'nature',
    shape: 'flora',
    motif: 'grass',
    hardness: 0.9,
    spacing: 0.36,
    flow: 0.9,
    grain: 0.32,
    scatter: 0.5,
    angle: 0,
    rotateJitter: 42,
    sizeScale: 1.4,
    pressureSize: true,
    pressureFlow: true
  },
  {
    id: 'leaf',
    nameKey: 'brush.leaf',
    category: 'nature',
    shape: 'flora',
    motif: 'leaf',
    hardness: 0.95,
    spacing: 0.62,
    flow: 0.95,
    grain: 0.18,
    scatter: 0.9,
    angle: 0,
    rotateJitter: 85,
    scaleJitter: 0.35,
    sizeScale: 1.15
  },
  {
    id: 'flower',
    nameKey: 'brush.flower',
    category: 'nature',
    shape: 'flora',
    motif: 'flower',
    hardness: 0.98,
    spacing: 0.95,
    flow: 1,
    grain: 0.06,
    scatter: 1.1,
    angle: 0,
    rotateJitter: 180,
    scaleJitter: 0.35,
    sizeScale: 1.1
  },
  {
    id: 'tree',
    nameKey: 'brush.tree',
    category: 'nature',
    shape: 'flora',
    motif: 'tree',
    hardness: 0.9,
    spacing: 1.6,
    flow: 1,
    grain: 0.14,
    scatter: 0.8,
    angle: 0,
    rotateJitter: 10,
    scaleJitter: 0.3,
    sizeScale: 1.5,
    pressureSize: false
  },
  {
    id: 'fern',
    nameKey: 'brush.fern',
    category: 'nature',
    shape: 'flora',
    motif: 'fern',
    hardness: 0.92,
    spacing: 0.5,
    flow: 0.92,
    grain: 0.22,
    scatter: 0.45,
    angle: 0,
    rotateJitter: 35,
    sizeScale: 1.25
  },
  {
    id: 'branch',
    nameKey: 'brush.branch',
    category: 'nature',
    shape: 'flora',
    motif: 'branch',
    hardness: 0.94,
    spacing: 0.9,
    flow: 0.95,
    grain: 0.14,
    scatter: 0.35,
    angle: 0,
    rotateJitter: 70,
    scaleJitter: 0.25,
    sizeScale: 1.15
  }
]

// 全部内置笔刷（基础 + 自然），按 id 查找时使用。
export const BRUSHES = [...BASIC_BRUSHES, ...NATURE_BRUSHES]
// 笔刷选择器分组（每组带一个 i18n 标题 key）。
export const BRUSH_GROUPS = [
  { key: 'brush.catBasic', items: BASIC_BRUSHES },
  { key: 'brush.catNature', items: NATURE_BRUSHES }
]

// ---------------------------------------------------------------- 自定义（导入）笔刷
// 自定义笔刷持久化在 localStorage 的键名，以及允许的形状 / 图形白名单。
const CUSTOM_BRUSH_KEY = 'substrate.customBrushes'
const CUSTOM_SHAPES = ['round', 'flat', 'spray', 'flora']
const CUSTOM_MOTIFS = ['grass', 'leaf', 'flower', 'tree', 'fern', 'branch']
// 内存中的自定义笔刷列表与 id → 笔刷的索引（避免每次查找都线性扫描）。
let customBrushes = []
const customMap = new Map()

/**
 * 数值限幅：非有限数字时返回 fallback，否则钳到 [min, max] 区间。
 * 用于清洗外部导入的笔刷 JSON，保证非法参数不会破坏绘制。
 */
function clampNum(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * 把笔刷名称转成可放进 id 的 slug：小写、非字母数字替换为连字符、去掉首尾连字符、
 * 最长 32 字符；结果为空时回退为 'brush'。
 */
function brushSlug(name) {
  return String(name || 'brush')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'brush'
}

/**
 * 校验并规范化一条自定义笔刷定义。
 *
 * 规则：
 *  - name 必填（截断到 48 字符），否则抛错；
 *  - shape 不在白名单内时回退为 round；
 *  - 所有数值参数用 clampNum 钳制，并给出各形状合理的默认值；
 *  - spray 额外要求 dots / dotScale；flora 要求 motif，并补齐旋转/缩放抖动默认值。
 *
 * @param {Object} def 原始笔刷定义
 * @param {number} [index] 同名笔刷在列表中的序号，用于生成无冲突 id
 * @returns {Object} 规范化后的笔刷对象（source = 'custom'）
 * @throws {Error} 非对象或缺少名称时抛出
 */
function normalizeCustomBrush(def, index = 0) {
  if (!def || typeof def !== 'object') throw new Error('Brush definition must be an object')
  const name = String(def.name || def.label || '').trim().slice(0, 48)
  if (!name) throw new Error('Brush needs a "name"')
  const shape = CUSTOM_SHAPES.includes(def.shape) ? def.shape : 'round'
  const brush = {
    id: 'custom-' + brushSlug(name) + '-' + (index + 1),
    name,
    nameKey: null,
    source: 'custom',
    category: 'custom',
    shape,
    hardness: clampNum(def.hardness, 0, 0.999, shape === 'round' ? 0.8 : 0.7),
    spacing: clampNum(def.spacing, 0.01, 1, 0.1),
    flow: clampNum(def.flow, 0.01, 1, 0.8),
    grain: clampNum(def.grain, 0, 1, 0),
    scatter: clampNum(def.scatter, 0, 2, 0),
    angle: clampNum(def.angle, -360, 360, 0),
    flatness: clampNum(def.flatness, 0.05, 1, 1),
    rotateJitter: clampNum(def.rotateJitter, 0, 360, 0),
    scaleJitter: clampNum(def.scaleJitter, 0, 1, 0),
    sizeScale: clampNum(def.sizeScale, 0.1, 4, 1),
    pressureSize: def.pressureSize !== false,
    pressureFlow: def.pressureFlow === true
  }
  if (shape === 'spray') {
    brush.dots = Math.round(clampNum(def.dots, 1, 40, 8))
    brush.dotScale = clampNum(def.dotScale, 0.01, 1, 0.16)
  }
  if (shape === 'flora') {
    brush.motif = CUSTOM_MOTIFS.includes(def.motif) ? def.motif : 'leaf'
    if (!brush.rotateJitter) brush.rotateJitter = 45
    if (!brush.scaleJitter) brush.scaleJitter = 0.2
  }
  return brush
}

/**
 * 把自定义笔刷列表写入 localStorage。
 * 存储不可用时静默忽略——自定义笔刷只在当前会话有效。
 */
function persistCustomBrushes() {
  try {
    localStorage.setItem(CUSTOM_BRUSH_KEY, JSON.stringify(customBrushes))
  } catch (e) {
    /* 存储不可用（隐私模式 / 配额已满）时忽略 */
  }
}

/**
 * 从 localStorage 读取自定义笔刷（模块加载时会自动调用一次）。
 *
 * 逐条规范化；单条非法数据只跳过该条，不影响其他笔刷。若存储里的 id 形如
 * 'custom-' 则保留原 id，以便历史笔画仍能引用到同一支笔刷；重复 id 会被丢弃。
 *
 * @returns {Array<Object>} 自定义笔刷数组的浅拷贝
 */
export function loadCustomBrushes() {
  customBrushes = []
  customMap.clear()
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_BRUSH_KEY) || '[]')
    if (Array.isArray(raw)) {
      raw.forEach((def, i) => {
        try {
          const brush = normalizeCustomBrush(def, i)
          // 若存档中的 id 形式合法（custom- 前缀）则保留，避免旧笔画丢失笔刷引用。
          if (typeof def.id === 'string' && def.id.startsWith('custom-')) brush.id = def.id
          if (!customMap.has(brush.id)) {
            customBrushes.push(brush)
            customMap.set(brush.id, brush)
          }
        } catch (e) {
          /* 跳过非法条目 */
        }
      })
    }
  } catch (e) {
    customBrushes = []
  }
  return customBrushes.slice()
}

// 模块初始化时立即恢复上次保存的自定义笔刷。
loadCustomBrushes()

/**
 * 取「内置 + 自定义」全部笔刷（新数组，调用方可安全排序）。
 * @returns {Array<Object>}
 */
export function getAllBrushes() {
  return [...BRUSHES, ...customBrushes]
}

/**
 * 取笔刷选择器分组；存在自定义笔刷时追加一个「自定义」分组。
 * @returns {Array<{key:string, items:Array<Object>}>}
 */
export function getBrushGroups() {
  const groups = [...BRUSH_GROUPS]
  if (customBrushes.length) groups.push({ key: 'brush.catCustom', items: customBrushes.slice() })
  return groups
}

/**
 * 取自定义笔刷列表的浅拷贝。
 * @returns {Array<Object>}
 */
export function getCustomBrushes() {
  return customBrushes.slice()
}

/**
 * 生成不与现有笔刷（内置或自定义）冲突的 id：冲突时依次追加 -2、-3 …
 */
function uniqueCustomId(base) {
  let id = base
  let n = 2
  while (customMap.has(id) || BRUSHES.some((b) => b.id === id)) id = base + '-' + n++
  return id
}

/**
 * 校验并注册一条自定义笔刷，同时持久化整个笔刷库。
 * @param {Object} def 笔刷定义（至少包含 name）
 * @returns {Object} 新增笔刷的浅拷贝
 * @throws {Error} 定义非法时抛出（见 normalizeCustomBrush）
 */
export function addCustomBrush(def) {
  const brush = normalizeCustomBrush(def, customBrushes.length)
  brush.id = uniqueCustomId(brush.id)
  customBrushes.push(brush)
  customMap.set(brush.id, brush)
  persistCustomBrushes()
  return { ...brush }
}

/**
 * 删除一支自定义笔刷并持久化。
 * @param {string} id 笔刷 id
 * @returns {boolean} 是否真的删除了（id 不存在时返回 false）
 */
export function removeCustomBrush(id) {
  const before = customBrushes.length
  customBrushes = customBrushes.filter((b) => b.id !== id)
  customMap.delete(id)
  if (customBrushes.length !== before) persistCustomBrushes()
  return customBrushes.length !== before
}

/**
 * 从 JSON 文本批量导入自定义笔刷。
 *
 * 兼容四种输入格式：
 *  - 单个笔刷对象；
 *  - 笔刷数组；
 *  - { brushes: [...] }；
 *  - { version: 1, brushes: [...] }。
 *
 * 为保证 UI 与存储不被一次导入撑爆，最多只处理前 50 条；任何一条校验失败都会抛出，
 * 但已成功加入的笔刷会保留（导入是逐条注册的）。
 *
 * @param {string} text JSON 文本
 * @returns {Array<Object>} 成功导入的笔刷列表
 * @throws {Error} JSON 非法或未包含任何笔刷定义时抛出
 */
export function importCustomBrushJson(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text || ''))
  } catch (e) {
    throw new Error('Invalid JSON: ' + e.message)
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.brushes) ? parsed.brushes : parsed && typeof parsed === 'object' ? [parsed] : []
  if (!list.length) throw new Error('No brush definitions found')
  const added = []
  for (const def of list.slice(0, 50)) added.push(addCustomBrush(def))
  return added
}

/**
 * 清空所有自定义笔刷，并删除本地存档。
 */
export function resetCustomBrushes() {
  customBrushes = []
  customMap.clear()
  try {
    localStorage.removeItem(CUSTOM_BRUSH_KEY)
  } catch (e) {
    /* 存储不可用时忽略 */
  }
}


// 默认笔刷 id（柔边圆刷），新建工程 / 找不到指定笔刷时使用。
export const DEFAULT_BRUSH_ID = 'soft-round'

/**
 * 按 id 查找笔刷：先找自定义笔刷，再找内置笔刷，都找不到时回退到第一支内置笔刷。
 * 回退策略保证绘制永远不会因笔刷缺失而中断。
 * @param {string} id 笔刷 id
 * @returns {Object} 笔刷预设
 */
export function brushById(id) {
  return customMap.get(id) || BRUSHES.find((b) => b.id === id) || BRUSHES[0]
}

/**
 * 把笔画的覆盖参数与选中的笔刷预设计算成最终绘制参数。
 *
 * 合并规则：笔画字段优先，缺省则用预设默认值；所有数值都做区间钳制
 * （opacity 0~1、hardness 0~0.999、flow/spacing 0.01~1、scatter 0~2、grain 0~1），
 * 避免外部传入的越界值破坏绘制效果。
 *
 * @param {Object} [stroke] 笔画数据（含 brushId、size、opacity、hardness…）
 * @returns {Object} 合并后的笔刷参数（额外带 erase 与 symmetry）
 */
export function resolveBrush(stroke = {}) {
  const base = brushById(stroke.brushId || DEFAULT_BRUSH_ID)
  const num = (v, fallback) => (v === undefined || v === null || Number.isNaN(Number(v)) ? fallback : Number(v))
  return {
    ...base,
    size: num(stroke.size, 40),
    opacity: Math.min(1, Math.max(0, num(stroke.opacity, 1))),
    hardness: Math.min(0.999, Math.max(0, num(stroke.hardness, base.hardness))),
    flow: Math.min(1, Math.max(0.01, num(stroke.flow, base.flow))),
    spacing: Math.min(1, Math.max(0.01, num(stroke.spacing, base.spacing))),
    scatter: Math.min(2, Math.max(0, num(stroke.scatter, base.scatter))),
    grain: Math.min(1, Math.max(0, num(stroke.grain, base.grain))),
    angle: num(stroke.angle, base.angle),
    erase: !!stroke.erase,
    symmetry: stroke.symmetry || {}
  }
}

/**
 * 确定性哈希噪声：同样的 (x, y, z) 永远得到同样的 0~1 随机数。
 *
 * 为什么不用 Math.random：同一笔画在实时绘制、撤销/重做、重新加载工程时都必须
 * 呈现完全一致的颗粒 / 散布 / 旋转抖动，否则画面会“跳变”。
 * 实现是经典的整数位混合（MurmurHash 风格），计算廉价且分布均匀。
 *
 * @returns {number} [0, 1) 区间的伪随机数
 */
export function hash01(x, y, z = 0) {
  let h = Math.imul(Math.floor(x * 127.1 + y * 311.7 + z * 74.7), 0x27d4eb2d)
  h ^= h >>> 15
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}

/** 构造一个椭圆路径（半径下限 0.01 防止 Canvas 对零半径报错）。 */
function ellipsePath(ctx, x, y, rx, ry, angle) {
  ctx.beginPath()
  ctx.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), angle, 0, TAU)
  ctx.closePath()
}

// ---------------------------------------------------------------- 自然图形（motif）
/**
 * 画一片「两端收尖的叶片 / 草叶」：沿 p0→p1 方向，用两条二次贝塞尔曲线构成
 * 起点宽度为 w、终点收尖的形状。用于草叶、树干和蕨类主茎。
 */
function taperedBlade(ctx, x0, y0, x1, y1, w) {
  const dx = x1 - x0
  const dy = y1 - y0
  const len = Math.hypot(dx, dy) || 1
  const nx = (-dy / len) * w
  const ny = (dx / len) * w
  ctx.beginPath()
  ctx.moveTo(x0 + nx, y0 + ny)
  ctx.quadraticCurveTo(x0 + dx * 0.5 + nx * 0.55, y0 + dy * 0.5 + ny * 0.55, x1, y1)
  ctx.quadraticCurveTo(x0 + dx * 0.5 - nx * 0.55, y0 + dy * 0.5 - ny * 0.55, x0 - nx, y0 - ny)
  ctx.closePath()
  ctx.fill()
}

/**
 * 画一片叶子：两条贝塞尔曲线围成叶形，再用 destination-out 把叶脉「挖空」。
 * 用挖空而不是画深色线条，是为了让叶脉在任意笔刷颜色下都能看清（相当于透明缝隙）。
 * @param {number} r 半径（图形整体尺寸基准）
 * @param {string} col 颜色字符串（"r,g,b" 形式，拼进 rgba()）
 * @param {number} seed 形状随机种子
 */
function drawLeaf(ctx, r, col, seed) {
  const w = r * 0.58
  const base = r * 0.5
  const tip = -r * 0.95
  ctx.fillStyle = `rgba(${col},0.94)`
  ctx.beginPath()
  ctx.moveTo(0, base)
  ctx.bezierCurveTo(w, base * 0.35, w * 0.92, tip * 0.5, 0, tip)
  ctx.bezierCurveTo(-w * 0.92, tip * 0.5, -w, base * 0.35, 0, base)
  ctx.closePath()
  ctx.fill()
  // 叶脉：从轮廓里挖掉，这样无论笔刷是什么颜色都能读出来。
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.strokeStyle = 'rgba(0,0,0,0.32)'
  ctx.lineWidth = Math.max(0.7, r * 0.055)
  ctx.beginPath()
  ctx.moveTo(0, base * 0.85)
  ctx.lineTo(0, tip * 0.82)
  ctx.stroke()
  for (let i = 0; i < 3; i++) {
    const y = base * 0.35 - i * r * 0.3
    const span = w * (0.72 - i * 0.14)
    ctx.lineWidth = Math.max(0.5, r * 0.04)
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.quadraticCurveTo(span * 0.5, y + r * 0.12, span, y - r * 0.06)
    ctx.moveTo(0, y)
    ctx.quadraticCurveTo(-span * 0.5, y + r * 0.12, -span, y - r * 0.06)
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * 画一丛草：6~9 片草叶，从底部同一点向不同角度（-0.925~0.925 rad）发散，
 * 每片长度与宽度由种子随机，形成自然的疏密变化。
 */
function drawGrass(ctx, r, col, seed) {
  const blades = 6 + Math.floor(hash01(seed, 1, 5) * 4)
  const baseY = r * 0.82
  ctx.fillStyle = `rgba(${col},0.9)`
  for (let i = 0; i < blades; i++) {
    const spread = (hash01(seed, i, 3) - 0.5) * 1.85
    const len = r * (0.85 + hash01(seed, i, 7) * 0.6)
    const tipX = Math.sin(spread) * len
    const tipY = baseY - Math.cos(spread) * len
    taperedBlade(ctx, 0, baseY, tipX, tipY, r * (0.05 + hash01(seed, i, 11) * 0.045))
  }
}

/**
 * 画一朵花：5~7 片椭圆花瓣围绕中心放射排列，中心用实心圆，再用 destination-out
 * 在花心挖几个小孔作为花蕊阴影。
 */
function drawFlower(ctx, r, col, seed) {
  const petals = 5 + Math.floor(hash01(seed, 2, 7) * 3)
  const dist = r * 0.42
  const prx = r * 0.27
  const pry = r * 0.4
  ctx.fillStyle = `rgba(${col},0.9)`
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * TAU + hash01(seed, i, 13) * 0.35
    ctx.save()
    ctx.rotate(a)
    ctx.beginPath()
    ctx.ellipse(0, -dist, prx, pry, 0, 0, TAU)
    ctx.fill()
    ctx.restore()
  }
  ctx.fillStyle = `rgba(${col},1)`
  ctx.beginPath()
  ctx.arc(0, 0, r * 0.19, 0, TAU)
  ctx.fill()
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < 6; i++) {
    const a = hash01(seed, i, 19) * TAU
    const d = hash01(seed, i, 23) * r * 0.14
    ctx.globalAlpha = 0.5
    ctx.beginPath()
    ctx.arc(Math.cos(a) * d, Math.sin(a) * d, Math.max(0.5, r * 0.035), 0, TAU)
    ctx.fill()
  }
  ctx.restore()
}

/**
 * 画一棵树：一根收尖的树干 + 6~8 个随机大小/位置的圆形树冠，
 * 树冠透明度略有差异，形成蓬松的层次感。
 */
function drawTree(ctx, r, col, seed) {
  ctx.fillStyle = `rgba(${col},0.95)`
  taperedBlade(ctx, 0, r * 0.88, 0, -r * 0.02, r * 0.11)
  const blobs = 6 + Math.floor(hash01(seed, 3, 9) * 3)
  for (let i = 0; i < blobs; i++) {
    const cx = (hash01(seed, i, 29) - 0.5) * r * 0.95
    const cy = -r * 0.42 + (hash01(seed, i, 31) - 0.5) * r * 0.5
    const rr = r * (0.26 + hash01(seed, i, 37) * 0.24)
    ctx.fillStyle = `rgba(${col},${0.72 + hash01(seed, i, 41) * 0.2})`
    ctx.beginPath()
    ctx.arc(cx, cy, rr, 0, TAU)
    ctx.fill()
  }
}

/**
 * 画一株蕨类：一根略向右倾的主茎，沿茎均匀分布 6 对小叶片；
 * 越往上叶片越短，形成典型的蕨叶锥形轮廓。
 */
function drawFern(ctx, r, col, seed) {
  ctx.fillStyle = `rgba(${col},0.92)`
  taperedBlade(ctx, 0, r * 0.88, r * 0.2, -r * 0.82, r * 0.055)
  for (let i = 0; i < 6; i++) {
    const t = i / 5
    const y = r * 0.66 - t * r * 1.4
    const len = r * (0.52 - t * 0.3)
    for (const side of [-1, 1]) {
      taperedBlade(ctx, r * 0.12 * t, y, side * len, y - len * 0.42, r * (0.05 - t * 0.018))
    }
  }
}

/**
 * 画一根枝条：一条带弧度的主枝 + 3 条细分叉 + 沿枝干分布的 7 片小椭圆叶。
 * 叶子位置沿一条斜线插值，并附加正弦扰动，避免排列过于机械。
 */
function drawBranch(ctx, r, col, seed) {
  ctx.fillStyle = `rgba(${col},0.95)`
  ctx.strokeStyle = `rgba(${col},0.95)`
  ctx.lineCap = 'round'
  ctx.lineWidth = r * 0.13
  ctx.beginPath()
  ctx.moveTo(-r * 0.65, r * 0.85)
  ctx.quadraticCurveTo(-r * 0.1, r * 0.15, r * 0.15, -r * 0.5)
  ctx.quadraticCurveTo(r * 0.28, -r * 0.78, r * 0.55, -r * 0.88)
  ctx.stroke()
  ctx.lineWidth = r * 0.07
  for (const [sx, sy, ex, ey] of [
    [-0.25, 0.35, -0.62, 0.02],
    [0.02, -0.12, 0.5, -0.3],
    [0.2, -0.56, -0.28, -0.78]
  ]) {
    ctx.beginPath()
    ctx.moveTo(sx * r, sy * r)
    ctx.lineTo(ex * r, ey * r)
    ctx.stroke()
  }
  const leaves = 7
  for (let i = 0; i < leaves; i++) {
    const t = i / (leaves - 1)
    const x = -r * 0.5 + t * r * 0.95
    const y = r * 0.7 - t * r * 1.25 + Math.sin(t * 3) * r * 0.08
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate((hash01(seed, i, 43) - 0.5) * 2.2)
    ellipsePath(ctx, 0, 0, r * 0.16, r * 0.075, 0)
    ctx.fill()
    ctx.restore()
  }
}

/**
 * 在 (x, y) 处绘制指定的自然图形，按 brush.motif 分派；未知 motif 回退为叶子。
 * 所有图形都围绕局部原点绘制，因此先用 translate 平移到目标位置。
 */
function drawMotif(ctx, x, y, radius, brush, colStr, seed) {
  const motif = brush.motif || 'leaf'
  ctx.save()
  ctx.translate(x, y)
  if (motif === 'grass') drawGrass(ctx, radius, colStr, seed)
  else if (motif === 'flower') drawFlower(ctx, radius, colStr, seed)
  else if (motif === 'tree') drawTree(ctx, radius, colStr, seed)
  else if (motif === 'fern') drawFern(ctx, radius, colStr, seed)
  else if (motif === 'branch') drawBranch(ctx, radius, colStr, seed)
  else drawLeaf(ctx, radius, colStr, seed)
  ctx.restore()
}

/**
 * 在笔尖上打「颗粒孔洞」以模拟粗糙材质。
 *
 * 用 destination-out 擦掉随机分布的小圆（数量随 grain 从 6 到 40），孔洞半径同样随
 * grain 变化，并带 0.35~0.95 的随机透明度，形成不均匀的磨损感。
 * 分布用 sqrt(随机数) 采样半径，保证孔洞在圆内均匀铺开而不是集中在中心。
 */
function applyGrain(ctx, x, y, radius, brush, seed) {
  if (brush.grain <= 0.01) return
  const holes = Math.round(6 + brush.grain * 34)
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < holes; i++) {
    const a = hash01(seed, i, 3) * TAU
    const d = Math.sqrt(hash01(seed, i, 9)) * radius
    const hr = Math.max(0.4, radius * (0.06 + hash01(seed, i, 17) * 0.22) * brush.grain)
    ctx.globalAlpha = 0.35 + hash01(seed, i, 23) * 0.6
    ctx.beginPath()
    ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, hr, 0, TAU)
    ctx.fill()
  }
  ctx.restore()
}

/**
 * 在画布上绘制单个笔尖形状（不带散布 / 对称，那些由 stampDab 负责）。
 *
 * 分三种形状：
 *  - spray：在散布半径内随机撒若干个点；
 *  - flora：调用自然图形绘制 + 颗粒；
 *  - round / flat：径向渐变圆（flat 用椭圆并压扁 Y 轴、按 angle 旋转）。
 * 最后统一叠加颗粒（applyGrain）。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} radius 笔尖半径（像素）
 * @param {number} alpha 不透明度（0~1）
 * @param {string} colStr "r,g,b" 形式的颜色串
 * @param {number} seed 随机种子，决定形状细节
 */
function paintStampShape(ctx, x, y, radius, brush, alpha, colStr, seed) {
  const hardness = brush.hardness
  const angle = ((brush.angle || 0) * Math.PI) / 180
  const flatness = Math.max(0.08, Math.min(1, brush.flatness ?? 1))
  if (brush.shape === 'spray') {
    const dots = brush.dots || 8
    const spread = radius * (0.9 + brush.scatter * 0.6)
    ctx.fillStyle = `rgba(${colStr},${Math.min(1, alpha * 1.25)})`
    for (let i = 0; i < dots; i++) {
      const a = hash01(seed, i, 11) * TAU
      const d = Math.sqrt(hash01(seed, i, 37)) * spread
      const dr = Math.max(0.6, radius * (brush.dotScale || 0.16) * (0.6 + hash01(seed, i, 71) * 0.9))
      ctx.beginPath()
      ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, dr, 0, TAU)
      ctx.fill()
    }
    return
  }
  if (brush.shape === 'flora') {
    drawMotif(ctx, x, y, radius, brush, colStr, seed)
    applyGrain(ctx, x, y, radius, brush, seed)
    return
  }
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius)
  const inner = Math.max(0, Math.min(0.985, hardness))
  g.addColorStop(0, `rgba(${colStr},${alpha})`)
  g.addColorStop(inner, `rgba(${colStr},${alpha})`)
  g.addColorStop(1, `rgba(${colStr},0)`)
  ctx.save()
  ctx.translate(x, y)
  if (flatness < 0.999) {
    ctx.rotate(angle)
    ctx.scale(1, flatness)
  }
  ctx.fillStyle = g
  if (brush.shape === 'flat') {
    ellipsePath(ctx, 0, 0, radius, radius, 0)
    ctx.fill()
  } else {
    ctx.beginPath()
    ctx.arc(0, 0, radius, 0, TAU)
    ctx.fill()
  }
  ctx.restore()
  applyGrain(ctx, x, y, radius, brush, seed)
}

// ---------------------------------------------------------------- 笔尖精灵缓存
// 每支笔刷预渲染 3 个不同随机种子的变体，连续笔尖交替使用可避免出现明显规律。
const SPRITE_VARIANTS = 3
// 缓存 key -> { sprites, dim, base }；LRU 上限 144，避免无限占用内存。
const spriteCache = new Map()
const SPRITE_CACHE_LIMIT = 144

/**
 * 生成精灵缓存键：把影响笔尖外观的所有参数拼成字符串（数值做定点化，
 * 避免浮点细微差异导致缓存命中失败）。
 */
function spriteKey(brush, colStr, baseSize) {
  return [
    brush.id,
    Math.round(baseSize),
    colStr,
    brush.shape,
    brush.motif || '',
    Number(brush.hardness).toFixed(2),
    Number(brush.grain).toFixed(2),
    Number(brush.flatness ?? 1).toFixed(2),
    Number(brush.rotateJitter ? 0 : brush.angle || 0).toFixed(1),
    Number(brush.rotateJitter || 0).toFixed(1),
    brush.dots || 0,
    Number(brush.dotScale || 0).toFixed(2)
  ].join('|')
}

/**
 * 预渲染 3 个笔尖精灵。
 *
 * 说明：base 是笔尖实际像素尺寸（按 sizeScale 缩放并钳到 2~640，防止极端值撑爆画布）；
 * pad 预留 22% 边距，给散布 / 颗粒 / 抗锯齿留出空间，避免贴图时被裁切。
 *
 * @returns {{sprites: HTMLCanvasElement[], dim: number, base: number}}
 */
function buildSprites(brush, colStr, baseSize) {
  const base = Math.max(2, Math.min(640, Math.round(baseSize * (brush.sizeScale || 1))))
  // flora 图形本身是正立的、每个笔尖再按 rotateJitter 旋转，所以烘焙时固定 angle = 0°，
  // 否则精灵会被预先旋转两次。
  const bakeBrush = brush.rotateJitter ? { ...brush, angle: 0 } : brush
  const pad = Math.ceil(base * 0.22) + 2
  const dim = base + pad * 2
  const sprites = []
  for (let v = 0; v < SPRITE_VARIANTS; v++) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = dim
    const ctx = canvas.getContext('2d')
    ctx.translate(dim / 2, dim / 2)
    paintStampShape(ctx, 0, 0, base / 2, bakeBrush, 1, colStr, 17.31 + v * 91.7)
    sprites.push(canvas)
  }
  return { sprites, dim, base }
}

/**
 * 取（必要时构建并缓存）当前笔刷的预渲染精灵。
 * 缓存超过上限时按插入顺序淘汰最旧的一项（Map 保持插入序，近似 FIFO）。
 *
 * @returns {{sprites: HTMLCanvasElement[], dim: number, base: number}}
 */
export function getStampSprites(brush, colStr, baseSize) {
  const key = spriteKey(brush, colStr, baseSize)
  let entry = spriteCache.get(key)
  if (!entry) {
    entry = buildSprites(brush, colStr, baseSize)
    spriteCache.set(key, entry)
    if (spriteCache.size > SPRITE_CACHE_LIMIT) {
      const first = spriteCache.keys().next().value
      spriteCache.delete(first)
    }
  }
  return entry
}

/**
 * 绘制一个笔尖（一次「落笔」）。
 *
 * 处理内容：
 *  - 笔压对尺寸 / 不透明度的影响；
 *  - 散布（scatter）：按确定性噪声偏移笔尖位置；
 *  - 旋转 / 缩放抖动（flora 常用）；
 *  - 3 个颗粒变体随机挑选；
 *  - X / Y 对称复制（最多 4 个落点）；
 *  - 擦除模式（destination-out）。
 *
 * @param {CanvasRenderingContext2D} ctx 目标画布上下文
 * @param {number} x 落笔点 X（像素）
 * @param {number} y 落笔点 Y（像素）
 * @param {number} radius 笔尖半径（像素）
 * @param {Object} brush resolveBrush() 之后的笔刷参数
 * @param {string} colStr "r,g,b"
 * @param {number} [pressure] 笔压（0~1，缺省视为 1）
 * @param {number} width 画布宽（对称用）
 * @param {number} height 画布高（对称用）
 */
export function stampDab(ctx, x, y, radius, brush, colStr, pressure, width, height) {
  const p = Math.max(0.05, Math.min(1, pressure == null ? 1 : pressure))
  let r = brush.sizeScale ? radius * brush.sizeScale : radius
  if (brush.pressureSize) r *= 0.35 + 0.65 * p
  r = Math.max(0.6, r)
  let alpha = brush.opacity * brush.flow
  if (brush.pressureFlow) alpha *= 0.3 + 0.7 * p
  alpha = Math.max(0.015, Math.min(1, alpha))
  const baseSize = brush.size || radius * 2
  const entry = getStampSprites(brush, colStr, baseSize)
  const nominalRadius = entry.base / 2
  const scatter = brush.scatter * r * 0.65
  const rotateJitter = brush.rotateJitter || 0
  const scaleJitter = brush.scaleJitter || 0
  const positions = [[x, y]]
  const sym = brush.symmetry || {}
  if (sym.x) positions.push([width - x, y])
  if (sym.y) positions.push([x, height - y])
  if (sym.x && sym.y) positions.push([width - x, height - y])
  ctx.save()
  ctx.globalCompositeOperation = brush.erase ? 'destination-out' : 'source-over'
  ctx.globalAlpha = Math.max(0.01, Math.min(1, alpha))
  for (const [baseX, baseY] of positions) {
    let px = baseX
    let py = baseY
    if (scatter > 0) {
      px += (hash01(baseX, baseY, 51) - 0.5) * 2 * scatter
      py += (hash01(baseX, baseY, 83) - 0.5) * 2 * scatter
    }
    if (px < -r || py < -r || px > width + r || py > height + r) continue
    const variant = entry.sprites[Math.floor(hash01(px, py, 7) * SPRITE_VARIANTS) % SPRITE_VARIANTS]
    const jitterScale = scaleJitter ? 1 + (hash01(px, py, 61) - 0.5) * 2 * scaleJitter : 1
    let rot = 0
    if (rotateJitter) {
      rot = (((brush.angle || 0) + (hash01(px, py, 29) - 0.5) * 2 * rotateJitter) * Math.PI) / 180
    }
    const scale = (r / nominalRadius) * jitterScale
    const dw = entry.dim * scale
    if (rot) {
      ctx.save()
      ctx.translate(px, py)
      ctx.rotate(rot)
      ctx.drawImage(variant, -dw / 2, -dw / 2, dw, dw)
      ctx.restore()
    } else {
      ctx.drawImage(variant, px - dw / 2, py - dw / 2, dw, dw)
    }
  }
  ctx.restore()
}

// 笔刷预览图缓存：key 为 "id:size"，值为 PNG data URL，避免每次重绘。
const previewCache = new Map()

/**
 * 生成笔刷的小尺寸预览图（供笔刷选择器显示），结果按 "id:size" 缓存为 data URL。
 *
 * 预览用 14 个笔尖沿一条轻微正弦弧线绘制，模拟真实一笔；颜色固定为浅灰蓝，
 * 不透明度沿笔画两端渐弱，让笔尖形状与边缘衰减更直观。
 *
 * @param {Object} brush 笔刷预设
 * @param {number} [size] 预览图边长（像素）
 * @returns {string} PNG data URL
 */
export function brushPreview(brush, size = 44) {
  const key = brush.id + ':' + size
  if (previewCache.has(key)) return previewCache.get(key)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const b = { ...brush, size: size * 0.6, opacity: Math.min(1, brush.opacity || 1), flow: Math.min(1, Math.max(0.35, brush.flow ?? 0.7)), erase: false, symmetry: {} }
  const col = '222,230,242'
  const n = 14
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    stampDab(ctx, size * (0.2 + 0.6 * t), size * (0.7 - 0.42 * Math.sin(t * Math.PI * 0.9)), size * 0.24, b, col, 0.45 + 0.55 * Math.sin(t * Math.PI), size, size)
  }
  const url = canvas.toDataURL('image/png')
  previewCache.set(key, url)
  return url
}
