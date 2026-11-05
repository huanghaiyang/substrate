/**
 * 轻量级响应式国际化模块。
 *
 * 设计意图：不引入 vue-i18n 这类依赖，只用 Vue 的 reactive 保存当前语言。
 * t()/tr() 在渲染期读取 locale.value，因此语言一变，所有用到 $t/$tr 的模板会自动重渲染。
 *
 * 两套词表分别服务两类文本：
 *  - messages.js（EN/ZH）: 语义化的界面 key，如 'top.save'，缺失时告警并回退到英文；
 *  - text.zh.js（ZH_NODE 等）: 以「英文原文」为键的节点库/参数词典，用于把英文节点名、
 *    参数标签、选项翻译成中文，英文模式下直接返回原文，无需查表。
 */
import { reactive } from 'vue'
import { EN, ZH } from './messages.js'
import { ZH_NODE, ZH_LABEL, ZH_INPUT, ZH_OPTION, ZH_GENERAL } from './text.zh.js'

/** localStorage 中保存语言选择的键名 */
const STORAGE_KEY = 'substrate.locale'

/** 语言切换按钮的候选列表：id 用于持久化与判断，label 显示在顶栏，name 用于可读描述 */
export const locales = [
  { id: 'en', label: 'EN', name: 'English' },
  { id: 'zh', label: '中文', name: '简体中文' }
]

/** 响应式的当前语言；每次 t()/tr() 调用都会读它，所以切换后 Vue 会自动重渲染 */
export const locale = reactive({ value: 'en' })

/**
 * 当前是否中文界面。
 * @returns {boolean} true 表示中文
 */
export function isZh() {
  return locale.value === 'zh'
}

/**
 * 按优先级探测初始语言：URL 参数 ?lang= → localStorage 记录 → 浏览器语言 → 英文兜底。
 * 每层都用 try/catch 包裹，因为在 SSR、隐私模式或 file:// 下 location/localStorage 可能不可用。
 * @returns {'zh'|'en'} 探测到的语言 id
 */
function detectLocale() {
  try {
    const fromUrl = new URLSearchParams(location.search).get('lang')
    if (fromUrl === 'zh' || fromUrl === 'en') return fromUrl
  } catch (e) {
    /* ignore */
  }
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'zh' || saved === 'en') return saved
  } catch (e) {
    /* ignore */
  }
  try {
    if ((navigator.language || '').toLowerCase().startsWith('zh')) return 'zh'
  } catch (e) {
    /* ignore */
  }
  return 'en'
}

/**
 * 把语言同步到文档层面：<html lang> 影响浏览器断词/无障碍朗读，title 走词表。
 * 两者都非关键路径，失败时静默忽略。
 * @param {'zh'|'en'} id 目标语言
 */
function applyDocumentLocale(id) {
  try {
    document.documentElement.lang = id === 'zh' ? 'zh-CN' : 'en'
  } catch (e) {
    /* ignore */
  }
  try {
    document.title = t('app.title')
  } catch (e) {
    /* ignore */
  }
}

/**
 * 持久化语言选择。隐私模式或存储配额满时 setItem 会抛异常，故吞掉错误：
 * 语言只在本次会话生效，不影响主流程。
 * @param {'zh'|'en'} id 目标语言
 */
function persistLocale(id) {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch (e) {
    /* storage may be unavailable (private mode) */
  }
}

/**
 * 把 ?lang= 同步到地址栏，使「直接刷新当前 URL」也能保持用户的选择。
 * 若不同步，像 ?lang=en 这样的旧 URL 会在每次刷新时覆盖掉已保存的语言。
 * 用 replaceState 而非 pushState，避免语言切换污染浏览器历史记录。
 * @param {'zh'|'en'} id 目标语言
 */
function syncUrlLocale(id) {
  try {
    if (typeof history === 'undefined' || !history.replaceState) return
    const url = new URL(location.href)
    if (url.searchParams.get('lang') === id) return
    url.searchParams.set('lang', id)
    history.replaceState(history.state, '', url)
  } catch (e) {
    /* ignore */
  }
}

/**
 * 应用启动时初始化语言：探测 → 写入响应式状态 → 同步文档 → 持久化。
 * @returns {'zh'|'en'} 最终生效的语言 id
 */
export function initLocale() {
  const id = detectLocale()
  locale.value = id
  applyDocumentLocale(id)
  // 首次访问的语言也记下来：首次可能来自浏览器语言，也可能来自显式 ?lang=，
  // 记住后下次不带参数访问也能沿用
  persistLocale(id)
  return id
}

/**
 * 切换界面语言。
 * @param {'zh'|'en'} id 目标语言（其它值一律归为 'en'）
 * @param {boolean} [persist=true] 是否持久化。默认 true（顶栏开关用），会写 localStorage
 *   并把选择镜像到 ?lang=，刷新后仍生效；false 用于一次性覆盖（文档截图、自动化审计）。
 * @returns {'zh'|'en'} 实际生效的语言
 * @sideEffect 修改 locale.value、document 的 lang/title，persist 时还写 localStorage 与 URL
 */
export function setLocale(id, persist = true) {
  locale.value = id === 'zh' ? 'zh' : 'en'
  applyDocumentLocale(locale.value)
  if (persist) {
    persistLocale(locale.value)
    syncUrlLocale(locale.value)
  }
  return locale.value
}

/**
 * 在中文/英文之间来回切换（顶栏语言按钮的快捷入口）。
 * @returns {'zh'|'en'} 切换后的语言
 */
export function toggleLocale() {
  return setLocale(locale.value === 'en' ? 'zh' : 'en')
}

/**
 * 翻译一个语义化界面 key，支持 {placeholder} 插值。
 * 缺失 key 时：先回退英文词表，仍缺失则告警并原样返回 key，让漏翻译一眼可见。
 * @param {string} key messages.js 中的键，如 'toast.saved'
 * @param {Object<string, string|number>} [vars] 插值变量，如 { file: 'x.json' }
 * @returns {string} 翻译后的文本
 */
export function t(key, vars) {
  const dict = locale.value === 'zh' ? ZH : EN
  let text = dict[key]
  if (text === undefined) text = EN[key]
  if (text === undefined) {
    if (typeof console !== 'undefined') console.warn('[i18n] missing key:', key)
    text = key
  }
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (match, name) => (vars[name] !== undefined ? String(vars[name]) : ''))
}

/**
 * 节点词典查表：仅在中文模式下生效，英文模式原样返回（词典本身以英文为键）。
 * @param {Object<string, string>} map 主词典，如 ZH_NODE
 * @param {string} text 英文原文
 * @param {Object<string, string>} [fallback] 主词典未命中时的备用词典（如 ZH_LABEL→ZH_GENERAL）
 * @returns {string} 翻译结果或原文
 */
function pick(map, text, fallback) {
  if (locale.value !== 'zh' || typeof text !== 'string') return text
  if (map[text] !== undefined) return map[text]
  if (fallback && fallback[text] !== undefined) return fallback[text]
  return text
}

/** 节点名/描述翻译（$trNode） */
export const trNode = (text) => pick(ZH_NODE, text)
/** 参数标签翻译，主词典未命中时再用通用词典兜底 */
export const trLabel = (text) => pick(ZH_LABEL, text, ZH_GENERAL)
/** 输入端口名翻译 */
export const trInput = (text) => pick(ZH_INPUT, text)
/** 下拉选项文案翻译，未命中时按参数标签词典兜底 */
export const trOption = (text) => pick(ZH_OPTION, text, ZH_LABEL)
/** 通用文本翻译：优先通用词典，再退回节点词典 */
export const trText = (text) => pick(ZH_GENERAL, text, ZH_NODE)
/** 模板里的通用翻译助手（$tr）：频道名、预设名、示例素材名、预览形状等 */
export const tr = trText

/** 节点定义翻译结果缓存：key 为定义对象本体，value 同时记录语言，语言切换后自动失效 */
const defCache = new WeakMap()

/**
 * 返回某份节点定义的语言化副本（名称、描述、分类、参数标签/选项、输入端口标签都已翻译）。
 *
 * 注意：只返回浅拷贝的新对象，不会修改原始定义；英文模式下直接返回原对象以避免分配。
 * 用 WeakMap 缓存可避免每帧为同一节点重复构造对象，同时不阻止定义对象被回收。
 * @param {Object} def 节点定义（含 name/desc/category/params/inputs）
 * @returns {Object} 语言化后的定义；def 为空时原样返回
 */
export function localizeDef(def) {
  if (!def) return def
  if (locale.value !== 'zh') return def
  const cached = defCache.get(def)
  if (cached && cached.locale === locale.value) return cached.value
  // 逐层浅拷贝：顶层字段、每个 param、每个 option、每个 input 都换新对象，
  // 调用方修改副本不会污染原始定义
  const value = {
    ...def,
    name: trNode(def.name),
    desc: trNode(def.desc),
    category: trNode(def.category),
    params: (def.params || []).map((p) => ({
      ...p,
      label: trLabel(p.label),
      options: p.options ? p.options.map((o) => trOption(o)) : p.options
    })),
    inputs: (def.inputs || []).map((i) => ({ ...i, label: trInput(i.label) }))
  }
  defCache.set(def, { locale: locale.value, value })
  return value
}
