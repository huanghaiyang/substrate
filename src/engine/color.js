/**
 * 颜色空间与小数学工具，供 UI 与引擎共用。
 *
 * 全项目统一约定：参数/存储使用 sRGB 十六进制（便于 UI 展示），
 * 而 GPU 内部运算使用线性光，因此两者之间的转换必须通过这里的函数完成。
 */

/**
 * 单个分量的 sRGB → 线性光转换。
 * 使用 IEC 61966-2-1 的分段公式（低值区为线性段，避免 0 附近斜率无限大）。
 */
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
/** 单个分量的线性光 → sRGB 转换（与 srgbToLinear 互为逆运算）。 */
export function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}
/**
 * 十六进制颜色 → [r, g, b]（每个分量 0..1，仍处于 sRGB 空间）。
 * 支持 #abc 简写与 #aabbcc 完整写法；非法输入返回黑色。
 */
export function hexToRgb(hex) {
  hex = String(hex || '#000000').replace('#', '')
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  const n = parseInt(hex.slice(0, 6), 16)
  if (Number.isNaN(n)) return [0, 0, 0]
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
/**
 * [r, g, b]（0..1，sRGB）→ #rrggbb 十六进制字符串。
 * 每分量先 clamp 再四舍五入到 8 位，保证输出长度固定。
 */
export function rgbToHex(rgb) {
  const to = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')
  return '#' + to(rgb[0]) + to(rgb[1]) + to(rgb[2])
}
/** 十六进制（sRGB）→ 线性光三元组，用于上传到 GPU 的 color uniform。 */
export function hexToLinear(hex) {
  return hexToRgb(hex).map(srgbToLinear)
}
/** 线性光三元组 → 十六进制（sRGB），用于把 GPU 回读结果写回 UI。 */
export function linearToHex(rgb) {
  return rgbToHex(rgb.map(linearToSrgb))
}
/** 把 v 限制在 [a, b] 范围内。 */
export function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v))
}
/** 线性插值：t=0 返回 a，t=1 返回 b。 */
export function lerp(a, b, t) {
  return a + (b - a) * t
}
/**
 * FNV-1a 32 位字符串哈希，输出 36 进制短字符串。
 * 用于给节点 / 缓存键等生成稳定的短标识（非加密用途）。
 */
export function hashString(str) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}
