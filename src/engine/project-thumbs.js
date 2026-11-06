// ============================================================================
// 历史工程封面缩略图的「静默生成」。
//
// 背景：旧工程在保存时还没有封面功能，工程 JSON 里没有 thumbnail 字段，
// 「打开材质」面板只能显示棋盘格占位。这个模块在面板打开后，用一台临时引擎
// （独立的 WebGL 上下文）把每个缺封面的工程按小分辨率求值一次，生成材质球缩略图，
// 回写给服务端并缓存进工程文件，之后打开面板就直接有图了。
//
// 设计取舍：
// - 串行处理：每张缩略图都要新建纹理、编译着色器，并发会让主线程与显存同时吃紧；
// - 求值分辨率固定 256：材质球缩略图只有 192²，再高分辨率没有可见收益；
// - 结束后立刻 dispose 临时引擎，释放 WebGL 上下文（浏览器对同时存在的上下文数量有限制）；
// - 任何单个工程失败都只跳过它，不影响其余工程，也不会打断用户当前正在编辑的材质。
// ============================================================================
import { TextureEngine } from './engine.js'

// 封面边长：与「打开材质」列表里的 56px 卡片按 2 倍图准备，兼顾清晰度与文件体积
const THUMB_SIZE = 192
// 求值分辨率：材质球缩略图只显示 192²，256 已足够，且求值耗时很短
const EVAL_RES = 256
// 图片节点解码后的长边上限，与 store.setNodeImage / hydrateImages 的 2048 保持一致
const MAX_IMAGE = 2048

// 当前运行序号：每次开始新的一批任务就自增，旧任务在每个循环节点检查后自行退出
let runId = 0
// 复用的临时引擎：同一批任务之间共享，避免反复创建/销毁 WebGL 上下文
let engine = null

/**
 * 惰性创建临时引擎。
 * 拿不到 WebGL2（例如显卡被禁用、上下文数量超限）时返回 null，调用方直接跳过该批任务。
 * @returns {TextureEngine|null}
 */
function ensureEngine() {
  if (engine) return engine
  try {
    engine = new TextureEngine()
  } catch (e) {
    console.warn('[project-thumbs] cannot create offscreen engine', e)
    engine = null
  }
  return engine
}

/** 释放临时引擎及其 WebGL 上下文（幂等，可重复调用）。 */
function disposeEngine() {
  try {
    engine?.dispose()
  } catch (e) {
    /* 上下文可能已丢失，忽略 */
  }
  engine = null
}

/**
 * 把工程里 image_input 节点保存的 data URL 解码成 canvas 并上传为引擎纹理。
 * 与 store.hydrateImages 的逻辑一致：长边限制 2048、只缩不放、单张失败不阻塞。
 * @param {TextureEngine} eng 临时引擎
 * @param {Object[]} nodes 工程图节点数组
 * @returns {Promise<void>}
 */
async function uploadImages(eng, nodes) {
  for (const node of nodes) {
    if (node.type !== 'image_input' || !node.data?.imageSrc) continue
    const canvas = await new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        const scale = Math.min(1, MAX_IMAGE / Math.max(img.width, img.height))
        const c = document.createElement('canvas')
        c.width = Math.max(1, Math.round(img.width * scale))
        c.height = Math.max(1, Math.round(img.height * scale))
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
        resolve(c)
      }
      img.onerror = () => resolve(null)
      img.src = node.data.imageSrc
    })
    if (canvas) eng.setImage(node.id, canvas)
  }
}

/**
 * 把引擎产出的 PNG dataURL 重新编码成 JPEG。
 * 封面只是一张 192² 的小图，JPEG(0.82) 通常只有 5~10 KB，
 * 写进工程 JSON 后不会明显增大文件，也不会撞上服务端 300 KB 的上限。
 * @param {string} dataURL PNG dataURL
 * @returns {Promise<string|null>}
 */
function toJpeg(dataURL) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = THUMB_SIZE
      canvas.height = THUMB_SIZE
      const ctx = canvas.getContext('2d')
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, THUMB_SIZE, THUMB_SIZE)
      resolve(canvas.toDataURL('image/jpeg', 0.82))
    }
    img.onerror = () => resolve(null)
    img.src = dataURL
  })
}

/**
 * 为一个工程 JSON 渲染材质球封面。
 * 流程：上传图片 → 小分辨率求值 → 读输出节点的材质球缩略图 → 转 JPEG → 释放本次求值的纹理。
 * @param {Object} project 工程对象（含 graph）
 * @returns {Promise<string|null>} JPEG dataURL；无输出节点或渲染失败时返回 null
 */
async function renderThumbnail(project) {
  const graph = project?.graph
  if (!graph?.nodes?.length) return null
  const eng = ensureEngine()
  if (!eng) return null
  // 清掉上一个工程留下的缓存，避免结构哈希碰撞时误用旧参数的结果
  eng.clearCache()
  await uploadImages(eng, graph.nodes)
  const result = eng.evaluate(graph, { res: EVAL_RES })
  try {
    const outputId = result.sinks && result.sinks[0]
    if (!outputId) return null
    const png = eng.outputThumbnail(outputId, THUMB_SIZE)
    return png ? await toJpeg(png) : null
  } finally {
    // 必须在读取完像素后再释放，否则材质球通道纹理会被回收到池里
    eng.releaseResult(result)
  }
}

/**
 * 为列表中所有缺少封面的工程静默生成缩略图。
 *
 * 每处理完一个工程都会调用 onUpdate(file, patch)：
 * - 开始处理：{ pending: true }
 * - 生成成功并写回服务端：{ thumbnail: '<dataURL>', pending: false }
 * - 失败或跳过：{ pending: false }
 *
 * 组件可以把 patch 合并进自己的列表项，界面就会逐个亮起封面。
 * 同一时间只允许一批任务运行：新调用会让旧调用在下一个工程前退出。
 *
 * @param {Array<{name:string,file:string,thumbnail?:string}>} projects 工程摘要列表
 * @param {(file: string, patch: Object) => void} [onUpdate] 单项状态回调
 * @returns {Promise<void>}
 */
export async function fillMissingThumbnails(projects, onUpdate) {
  const run = ++runId
  const pending = (projects || []).filter((p) => !p.thumbnail)
  if (!pending.length) return
  try {
    for (const project of pending) {
      if (run !== runId) return
      onUpdate?.(project.file, { pending: true })
      try {
        const res = await fetch('/api/projects/load?name=' + encodeURIComponent(project.name))
        if (!res.ok) throw new Error('load failed: ' + res.status)
        const data = await res.json()
        const thumbnail = await renderThumbnail(data)
        if (run !== runId) return
        if (!thumbnail) throw new Error('no output node')
        // 回写给服务端，下次打开面板就能直接从工程文件里读到封面
        const saved = await fetch('/api/projects/thumbnail', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: project.name, file: project.file, thumbnail })
        })
        if (!saved.ok) throw new Error('save failed: ' + saved.status)
        onUpdate?.(project.file, { thumbnail, pending: false })
      } catch (e) {
        // 单个工程失败只跳过，用户依然可以正常打开它
        console.warn('[project-thumbs] skipped', project.name, e)
        onUpdate?.(project.file, { pending: false })
      }
    }
  } finally {
    // 只有仍是当前批次时才释放；已被 cancelThumbnails 接管的批次由取消方负责释放
    if (run === runId) disposeEngine()
  }
}

/**
 * 取消当前批次的静默生成并释放临时引擎。
 * 面板关闭时调用，避免在用户编辑时后台继续跑 GPU 求值。
 */
export function cancelThumbnails() {
  runId++
  disposeEngine()
}
