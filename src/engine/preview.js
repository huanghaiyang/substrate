/**
 * 预览数据仓库。
 *
 * 为什么单独抽出来：预览数据是若干张 Uint8Array（默认 384×384×4），体量很大；
 * 如果放进 Vue 的响应式对象（reactive），深层代理会产生巨大的性能开销，
 * 因此这里用一个普通的非响应式单例 + 递增 version 来通知 UI 刷新。
 *
 * 使用方式：调用 buildPreview 更新数据；界面监听 previewStore.version 变化后重新取用 maps。
 */
export const previewStore = {
  maps: null,
  version: 0
}

/**
 * 从引擎回读所有通道并写入 previewStore。
 *
 * @param {import('./engine.js').TextureEngine} engine
 * @param {number} [size=384] 预览分辨率
 * @returns {boolean} 是否成功生成预览
 */
export function buildPreview(engine, size = 384) {
  if (!engine) return false
  try {
    const maps = engine.previewMaps(size)
    if (!maps) return false
    previewStore.maps = maps
    previewStore.version++
    return true
  } catch (e) {
    console.warn('[preview] failed', e)
    return false
  }
}
