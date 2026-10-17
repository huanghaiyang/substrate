// Shared, non-reactive preview texture cache (Uint8Array data is too heavy for deep reactivity).
export const previewStore = {
  maps: null,
  version: 0
}

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
