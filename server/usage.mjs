// 引用关系分析：哪些已保存材质在用哪些素材库素材。
//
// 素材库是共享池：一张位图/一个归档可以被任意多个工程引用。删除仍被引用的素材会静默弄坏这些材质，
// 所以删除前必须先做引用检查——只有**没有任何**已保存工程引用它时，素材才能离开素材库；
// 对归档而言，还要确保它抽取出的位图也没有被引用。
//
// 引用记录方式：
//   * 节点 data.imageAssetId（Texture Input 节点）；
//   * 节点 data.patternAssetId（Paint 图层）；
//   * 兜底：任何字符串值里出现 `/assets/<id>.<ext>`（兼容早于 id 字段的老工程）。
//
// **绑定关系在回收站中依然有效**：把材质放进回收站不会释放素材，工程 JSON（含引用）仍完整保存在
// trash/ 里，直到被永久删除。因此扫描范围同时覆盖 projects/ 与回收站——删除回收站里的材质，
// 才是释放这些绑定的唯一动作。
//
// 对外接口：assetsInGraph(graph)、scanAssetUsage(projectsDir, trashDir)、usageForAsset(usage, entry, index)。
// 与 assets.mjs 的关系：assets.mjs 的 listAssets / trashAsset 依赖本模块计算 usage 来阻止误删。
// 安全边界：只读；JSON 解析失败的工程会被跳过而不是让整个扫描失败。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { TRASH_DIR } from './trash.mjs'

const URL_RE = /\/assets\/([0-9a-f]{8,16})\.[a-z0-9]{2,5}/gi

/** collect asset ids referenced by one graph */
/**
 * 收集单个节点图里引用到的素材 id。
 * 覆盖 imageAssetId / patternAssetId、任意字符串里的 /assets/ URL，以及 paint stroke 的 pattern URL。
 * @param {{nodes?:object[]}} graph 工程图
 * @returns {Set<string>} 素材 id 集合
 */
export function assetsInGraph(graph) {
  const found = new Set()
  const nodes = graph?.nodes || []
  for (const node of nodes) {
    const data = node?.data || {}
    if (typeof data.imageAssetId === 'string') found.add(data.imageAssetId)
    if (typeof data.patternAssetId === 'string') found.add(data.patternAssetId)
    // fallback: any string value that points at a library URL
    for (const value of Object.values(data)) {
      if (typeof value !== 'string' || !value.includes('/assets/')) continue
      URL_RE.lastIndex = 0
      let m
      while ((m = URL_RE.exec(value))) found.add(m[1])
    }
  }
  // paint strokes store their pattern URL; also catch it there
  for (const node of nodes) {
    const strokes = node?.data?.strokes
    if (!Array.isArray(strokes)) continue
    for (const stroke of strokes) {
      const pattern = stroke?.pattern
      if (typeof pattern !== 'string') continue
      URL_RE.lastIndex = 0
      let m
      while ((m = URL_RE.exec(pattern))) found.add(m[1])
    }
  }
  return found
}

// 将某个节点图的引用登记进 usage（内部辅助；scanAssetUsage 的完整说明见其函数声明处）。
/**
 * 把一个节点图里引用的每个素材 id 登记进 usage 映射（按 project + trashed 去重）。
 * @param {Map<string,object[]>} usage 累积结果
 * @param {{nodes?:object[]}} graph 节点图
 * @param {{project:string,trashed?:boolean,trashId?:string|null}} meta 来源信息
 * @returns {void}
 */
function addGraphUsage(usage, graph, meta) {
  const nodes = graph?.nodes || []
  for (const node of nodes) {
    const data = node?.data || {}
    const ids = new Set()
    if (typeof data.imageAssetId === 'string') ids.add(data.imageAssetId)
    if (typeof data.patternAssetId === 'string') ids.add(data.patternAssetId)
    for (const value of Object.values(data)) {
      if (typeof value !== 'string' || !value.includes('/assets/')) continue
      URL_RE.lastIndex = 0
      let m
      while ((m = URL_RE.exec(value))) ids.add(m[1])
    }
    for (const id of ids) {
      const list = usage.get(id) || []
      if (!list.some((u) => u.project === meta.project && u.trashed === meta.trashed)) {
        list.push({ project: meta.project, nodeId: node.id || null, trashed: !!meta.trashed, trashId: meta.trashId || null })
      }
      usage.set(id, list)
    }
  }
}

/**
 * 扫描全部已保存材质**以及回收站**，汇总每个素材被谁引用。
 * 回收站中的材质仍保留绑定，因此必须一起扫描，否则会误判「无人使用」而放走素材。
 * 单个工程读取/解析失败时跳过（不中断整体扫描）。
 * @param {string} projectsDir projects/ 绝对路径
 * @param {string} [trashDir=TRASH_DIR] trash/ 绝对路径
 * @returns {{usage: Map<string,{project:string,nodeId:string|null,trashed:boolean,trashId:string|null}[]>, projects:number, trashed:number}}
 *          projects/trashed 为成功解析的工程数量
 */
export function scanAssetUsage(projectsDir, trashDir = TRASH_DIR) {
  const usage = new Map()
  let projects = 0
  let trashed = 0

  let files = []
  try {
    files = readdirSync(projectsDir).filter((f) => f.endsWith('.json'))
  } catch (e) {
    files = []
  }
  for (const file of files) {
    const full = path.join(projectsDir, file)
    if (!existsSync(full)) continue
    let data
    try {
      data = JSON.parse(readFileSync(full, 'utf8'))
    } catch (e) {
      continue
    }
    projects++
    addGraphUsage(usage, data.graph, { project: String(data.name || file.replace(/\.json$/, '')), trashed: false })
  }

  // binned materials still hold their assets hostage until purged
  let bin = { items: [] }
  try {
    bin = JSON.parse(readFileSync(path.join(trashDir, 'index.json'), 'utf8'))
  } catch (e) {
    bin = { items: [] }
  }
  for (const item of Array.isArray(bin.items) ? bin.items : []) {
    if (item.kind !== 'project') continue
    const stored = path.join(trashDir, item.stored || '')
    if (!existsSync(stored)) continue
    let data
    try {
      data = JSON.parse(readFileSync(stored, 'utf8'))
    } catch (e) {
      continue
    }
    trashed++
    addGraphUsage(usage, data.graph, { project: item.name || 'binned material', trashed: true, trashId: item.id })
  }
  return { usage, projects, trashed }
}

/**
 * 查询单个素材的引用情况，并把「归档 ↔ 其抽取位图」视为同一生命周期：
 * 任一子素材被引用，父归档就算被使用（反之亦然），避免删掉父项却留下悬空的子位图引用。
 * 结果按工程名去重。
 * @param {Map<string,object[]>} usage scanAssetUsage 的结果
 * @param {object} indexEntry 目标素材索引条目
 * @param {object[]} index 完整素材索引（用于查 parentId/children）
 * @returns {{project:string,nodeId:string|null,trashed?:boolean,trashId?:string|null}[]}
 */
export function usageForAsset(usage, indexEntry, index) {
  if (!indexEntry) return []
  const ids = new Set([indexEntry.id])
  if (indexEntry.kind === 'sbsar') for (const child of index.filter((a) => a.parentId === indexEntry.id)) ids.add(child.id)
  if (indexEntry.parentId) ids.add(indexEntry.parentId)
  const out = []
  for (const id of ids) for (const u of usage.get(id) || []) if (!out.some((x) => x.project === u.project)) out.push(u)
  return out
}
