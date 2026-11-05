// 回收站（工程部分）。
//
// 工作室里可删除的东西有两类，都不会直接消失：
//   * **工程**（projects/ 下的材质文件）—— 文件被移动到 trash/，元数据记录在 trash/index.json；
//   * **素材**（素材库里的位图与 .sbsar 归档）—— 文件仍在磁盘，只在 assets/index.json 里打
//     `deletedAt` 标记（软删除），这样归档与它抽取出的位图可以一起还原。
//     这部分实现位于 assets.mjs（trashAsset / restoreAsset / deleteAsset），本文件只管工程。
//
// 还原工程会把文件放回原文件名（重名时改名 `…-restored-<id>`）；只有「永久删除」才真正 unlink 字节。
//
// 对外 HTTP（server/index.js 挂载）：
//   GET  /api/trash            → listTrashedProjects() + trashProjectBytes()
//   POST /api/trash/restore    → restoreProject()
//   POST /api/trash/purge      → purgeProject()
//   POST /api/trash/empty      → emptyProjectsTrash()
//
// 安全边界：工程文件名一律取自索引里的 basename，拼接后不信任用户输入；文件缺失时抛 NOT_FOUND
// 而不是静默成功，避免索引与磁盘状态长期不一致。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const TRASH_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'trash')
const INDEX_PATH = path.join(TRASH_DIR, 'index.json')

/**
 * 确保回收站目录存在（递归创建，可重复调用）。
 * @returns {void}
 */
function ensure() {
  mkdirSync(TRASH_DIR, { recursive: true })
}
/**
 * 读取 trash/index.json。缺失、损坏或 items 不是数组时返回 { items: [] }。
 * @returns {{items:object[]}}
 */
function readIndex() {
  ensure()
  try {
    const data = JSON.parse(readFileSync(INDEX_PATH, 'utf8'))
    return Array.isArray(data.items) ? data : { items: [] }
  } catch (e) {
    return { items: [] }
  }
}
/**
 * 覆盖写入回收站索引（2 空格缩进）。
 * @param {{items:object[]}} index
 * @returns {void}
 */
function writeIndex(index) {
  ensure()
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf8')
}

/**
 * 生成带前缀的回收站条目 id：prefix-<base36 时间>-<4 位随机 hex>。
 * 随机部分用 SHA-1 只是为了让同一毫秒内的两次删除不撞 id。
 * @param {string} prefix 'project' 等
 * @returns {string}
 */
const newId = (prefix) => prefix + '-' + Date.now().toString(36) + '-' + createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 4)

/** move a project file into the bin; `file` is an absolute path under projects/ */
/**
 * 把一个工程文件移入回收站：先尝试读 JSON 取名称/节点数/分辨率，再 rename 到 trash/<id>.json，
 * 最后写入索引。损坏的工程 JSON 也能被回收（只是摘要字段取默认值）。
 * @param {{file:string,name?:string}} input file 为 projects/ 下的绝对路径
 * @returns {{id:string,name:string,kind:'project'}}
 * @throws {Error} file 不存在（code=NOT_FOUND）
 */
export function trashProject({ file, name }) {
  if (!file || !existsSync(file)) throw Object.assign(new Error('Project file not found'), { code: 'NOT_FOUND' })
  const stat = statSync(file)
  let data = {}
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    /* a broken project can still be trashed */
  }
  const id = newId('project')
  const stored = path.join(TRASH_DIR, id + '.json')
  ensure()
  renameSync(file, stored)
  const index = readIndex()
  index.items.unshift({
    id,
    kind: 'project',
    name: String(name || data.name || path.basename(file, '.json')),
    file: path.basename(file),
    stored: path.basename(stored),
    deletedAt: Date.now(),
    nodes: data.graph?.nodes?.length || 0,
    resolution: data.resolution || 1024,
    bytes: stat.size
  })
  writeIndex(index)
  return { id, name: String(name || data.name || ''), kind: 'project' }
}

/** list binned projects (newest first) */
/**
 * 列出回收站中的条目（按删除时间倒序）。
 * 注意：索引也可能含素材类条目，调用方按 kind 过滤。
 * @returns {object[]}
 */
export function listTrashedProjects() {
  return readIndex().items.slice().sort((a, b) => b.deletedAt - a.deletedAt)
}

/**
 * 按 id 查找索引条目。
 * @param {string} id
 * @returns {object|null}
 */
function findItem(id) {
  return readIndex().items.find((it) => it.id === id) || null
}

/** restore a binned project; on a name collision it becomes `restored-<id>` */
/**
 * 还原一个工程：从 trash/ 移回 projects/；若目标名已存在，则改名 `<slug>-restored-<id4>.json`，
 * 显示名追加 " (restored)"，绝不覆盖现有工程。
 * @param {string} id 回收站条目 id
 * @param {string} projectsDir projects/ 的绝对路径
 * @returns {{id:string,kind:'project',name:string,file:string}}
 * @throws {Error} 条目不存在或源文件丢失（code=NOT_FOUND）
 */
export function restoreProject(id, projectsDir) {
  const index = readIndex()
  const item = index.items.find((it) => it.id === id && it.kind === 'project')
  if (!item) throw Object.assign(new Error('Project is not in the bin'), { code: 'NOT_FOUND' })
  const stored = path.join(TRASH_DIR, item.stored)
  if (!existsSync(stored)) throw Object.assign(new Error('Binned file is missing'), { code: 'NOT_FOUND' })
  let target = path.join(projectsDir, item.file)
  let name = item.name
  if (existsSync(target)) {
    const slug = String(item.file).replace(/\.json$/, '')
    const alt = slug + '-restored-' + id.slice(-4) + '.json'
    target = path.join(projectsDir, alt)
    name = item.name + ' (restored)'
  }
  mkdirSync(projectsDir, { recursive: true })
  renameSync(stored, target)
  writeIndex({ items: index.items.filter((it) => it.id !== id) })
  return { id, kind: 'project', name, file: path.basename(target) }
}

/** permanently delete one binned project */
/**
 * 永久删除一个回收站工程（删除失败 best effort，仍会移出索引）。
 * @param {string} id
 * @returns {{id:string,kind:'project',purged:true}}
 * @throws {Error} 条目不存在（code=NOT_FOUND）
 */
export function purgeProject(id) {
  const index = readIndex()
  const item = index.items.find((it) => it.id === id && it.kind === 'project')
  if (!item) throw Object.assign(new Error('Project is not in the bin'), { code: 'NOT_FOUND' })
  try {
    rmSync(path.join(TRASH_DIR, item.stored), { force: true })
  } catch (e) {
    /* best effort */
  }
  writeIndex({ items: index.items.filter((it) => it.id !== id) })
  return { id, kind: 'project', purged: true }
}

/** permanently delete every binned project */
/**
 * 永久删除所有工程类回收项，并清空索引（素材条目由 assets.mjs 另行处理）。
 * @returns {{purged:number}} 实际删除成功的文件数
 */
export function emptyProjectsTrash() {
  const index = readIndex()
  let count = 0
  for (const item of index.items) {
    if (item.kind !== 'project') continue
    try {
      rmSync(path.join(TRASH_DIR, item.stored), { force: true })
      count++
    } catch (e) {
      /* best effort */
    }
  }
  writeIndex({ items: [] })
  return { purged: count }
}

/** total size of binned project files (for the UI summary) */
/**
 * 回收站工程文件的总字节数（UI 汇总用）。
 * @returns {number}
 */
export function trashProjectBytes() {
  return readIndex().items.reduce((sum, it) => sum + (it.bytes || 0), 0)
}

/** files currently in the bin directory (used by tests/diagnostics) */
/**
 * 列出回收站目录下的工程文件（排除 index.json）；目录不可读时返回空数组。
 * @returns {string[]}
 */
export function binnedFiles() {
  try {
    return readdirSync(TRASH_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json')
  } catch (e) {
    return []
  }
}

export { TRASH_DIR }
