// Color space + small math utilities shared by UI and engine.
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
export function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}
export function hexToRgb(hex) {
  hex = String(hex || '#000000').replace('#', '')
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  const n = parseInt(hex.slice(0, 6), 16)
  if (Number.isNaN(n)) return [0, 0, 0]
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
export function rgbToHex(rgb) {
  const to = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')
  return '#' + to(rgb[0]) + to(rgb[1]) + to(rgb[2])
}
export function hexToLinear(hex) {
  return hexToRgb(hex).map(srgbToLinear)
}
export function linearToHex(rgb) {
  return rgbToHex(rgb.map(linearToSrgb))
}
export function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v))
}
export function lerp(a, b, t) {
  return a + (b - a) * t
}
export function hashString(str) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}
