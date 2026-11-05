/**
 * PNG 编码的统一入口。
 *
 * 目前的实现是直接在调用线程里调用 encodePng：
 * 压缩交给浏览器的 CompressionStream 原生管线完成，不占用 JS 主线程做长时间计算，
 * 因此不需要再额外开一个 Web Worker。若未来换成纯 JS 压缩实现，可在这里改为 worker 调用，
 * 调用方（exporter.js）无需改动。
 */
import { encodePng } from './png.js'

/**
 * 异步编码 PNG。
 * @param {object} payload 与 encodePng 的参数完全一致（width/height/data/colorType/bitDepth/srgb）
 * @returns {Promise<Uint8Array>} PNG 文件字节
 */
export function encodePngAsync(payload) {
  return encodePng(payload)
}
