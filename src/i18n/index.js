// Lightweight reactive i18n: semantic UI keys + context-aware node-library dictionaries.
import { reactive } from 'vue'
import { EN, ZH } from './messages.js'
import { ZH_NODE, ZH_LABEL, ZH_INPUT, ZH_OPTION, ZH_GENERAL } from './text.zh.js'

const STORAGE_KEY = 'substrate.locale'

export const locales = [
  { id: 'en', label: 'EN', name: 'English' },
  { id: 'zh', label: '中文', name: '简体中文' }
]

/** reactive locale; every t()/tr() call reads it, so Vue re-renders on change */
export const locale = reactive({ value: 'en' })

export function isZh() {
  return locale.value === 'zh'
}

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

export function initLocale() {
  locale.value = detectLocale()
  applyDocumentLocale(locale.value)
  return locale.value
}

export function setLocale(id, persist = true) {
  locale.value = id === 'zh' ? 'zh' : 'en'
  applyDocumentLocale(locale.value)
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, locale.value)
    } catch (e) {
      /* ignore */
    }
  }
  return locale.value
}

export function toggleLocale() {
  return setLocale(locale.value === 'en' ? 'zh' : 'en')
}

/** translate a semantic UI key, with optional {placeholder} interpolation */
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

function pick(map, text, fallback) {
  if (locale.value !== 'zh' || typeof text !== 'string') return text
  if (map[text] !== undefined) return map[text]
  if (fallback && fallback[text] !== undefined) return fallback[text]
  return text
}

export const trNode = (text) => pick(ZH_NODE, text)
export const trLabel = (text) => pick(ZH_LABEL, text, ZH_GENERAL)
export const trInput = (text) => pick(ZH_INPUT, text)
export const trOption = (text) => pick(ZH_OPTION, text, ZH_LABEL)
export const trText = (text) => pick(ZH_GENERAL, text, ZH_NODE)
/** general-purpose template helper ($tr): channels, presets, demo names, preview shapes */
export const tr = trText

const defCache = new WeakMap()

/** Return a locale-aware view of a node definition (names, descriptions, labels, options). */
export function localizeDef(def) {
  if (!def) return def
  if (locale.value !== 'zh') return def
  const cached = defCache.get(def)
  if (cached && cached.locale === locale.value) return cached.value
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
