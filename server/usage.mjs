// Which saved materials use which library assets.
//
// The material library is a shared pool: a bitmap/archive can be referenced by any number of projects.
// Deleting something that is still referenced would silently break those materials, so deletions are
// guarded: an asset may only leave the library when *no* saved project references it (and, for an
// archive, when none of the bitmaps it extracted is referenced either).
//
// References are recorded in the graph as `data.imageAssetId` (Texture Input) and `data.patternAssetId`
// (Paint layer), and the raw asset URL (`/assets/<id>.<ext>`) is also matched as a fallback so older
// projects that predate the id fields are still detected.
//
// **Bindings survive the recycle bin.** Moving a material to trash does not release its assets: the
// project JSON (with its references) is kept intact in trash/ until it is *permanently* deleted, so
// assets are scanned in both projects/ and the bin. Deleting a binned material is therefore the only
// action that releases its bindings.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { TRASH_DIR } from './trash.mjs'

const URL_RE = /\/assets\/([0-9a-f]{8,16})\.[a-z0-9]{2,5}/gi

/** collect asset ids referenced by one graph */
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

/**
 * Scan every saved project and report where each asset is used.
 * @param {string} projectsDir absolute path of the projects directory
 * @returns {{usage: Map<string, {project:string, nodeId:string|null}[]>, projects: number}}
 */
/** register every asset id referenced by a graph into `usage` */
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
 * Scan saved materials **and the recycle bin**. A binned material keeps its bindings until it is
 * permanently deleted, so its assets stay locked.
 * @param {string} projectsDir absolute path of projects/
 * @param {string} [trashDir] absolute path of trash/ (defaults to the repo trash directory)
 * @returns {{usage: Map<string, {project:string,nodeId:string|null,trashed:boolean,trashId:string|null}[]>, projects: number, trashed: number}}
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
 * Usage of one asset, considering that an archive's extracted bitmaps are part of the archive's
 * lifetime: if any child is referenced, the parent counts as in use (and vice versa).
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
