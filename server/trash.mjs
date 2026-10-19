// Recycle bin.
//
// Two kinds of things can be deleted in the studio, and both go here instead of vanishing:
//   * **projects** (a material file under projects/) — moved into trash/, metadata kept in trash/index.json;
//   * **assets** (bitmaps and .sbsar archives in the material library) — kept on disk but flagged
//     `deletedAt` in assets/index.json (soft delete), so an archive and its extracted bitmaps can be
//     restored together.
//
// Restoring a project puts the file back under its original name (or `restored-…` on collision).
// Purging is the only operation that actually unlinks bytes.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const TRASH_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'trash')
const INDEX_PATH = path.join(TRASH_DIR, 'index.json')

function ensure() {
  mkdirSync(TRASH_DIR, { recursive: true })
}
function readIndex() {
  ensure()
  try {
    const data = JSON.parse(readFileSync(INDEX_PATH, 'utf8'))
    return Array.isArray(data.items) ? data : { items: [] }
  } catch (e) {
    return { items: [] }
  }
}
function writeIndex(index) {
  ensure()
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf8')
}

const newId = (prefix) => prefix + '-' + Date.now().toString(36) + '-' + createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 4)

/** move a project file into the bin; `file` is an absolute path under projects/ */
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
export function listTrashedProjects() {
  return readIndex().items.slice().sort((a, b) => b.deletedAt - a.deletedAt)
}

function findItem(id) {
  return readIndex().items.find((it) => it.id === id) || null
}

/** restore a binned project; on a name collision it becomes `restored-<id>` */
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
export function trashProjectBytes() {
  return readIndex().items.reduce((sum, it) => sum + (it.bytes || 0), 0)
}

/** files currently in the bin directory (used by tests/diagnostics) */
export function binnedFiles() {
  try {
    return readdirSync(TRASH_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json')
  } catch (e) {
    return []
  }
}

export { TRASH_DIR }
