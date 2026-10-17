// PNG encoding entry point. CompressionStream keeps encoding off the critical path
// (zlib runs in the browser's compression pipeline), so no dedicated worker is required.
import { encodePng } from './png.js'

export function encodePngAsync(payload) {
  return encodePng(payload)
}
