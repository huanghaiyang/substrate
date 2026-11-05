/**
 * 回收站集成测试（覆盖材质工程与素材库资源）。
 *
 * 运行前提：需要已启动的设计器服务器（npm start）。如果服务器不可达，
 * 整套测试会报告 SKIP 而不是 FAIL，这样在裸仓库中也不会误报。
 *
 * 用法：
 *   npm run test:trash              # 默认访问 http://127.0.0.1:3000
 *   SUBSTRATE_URL=http://host:port npm run test:trash
 *
 * 验证内容：删除→进回收站→恢复/彻底删除、素材软删除、清空回收站、
 * 错误路径，以及「正在编辑的材质 / 被引用的素材」这两类删除保护。
 */
const BASE = process.env.SUBSTRATE_URL || 'http://127.0.0.1:3000'

let pass = 0
let fail = 0
let skipped = false
const ok = (label, cond, info = '') => {
  if (cond) {
    pass++
    console.log('  PASS ' + label)
  } else {
    fail++
    console.log('  FAIL ' + label + (info ? ' :: ' + info : ''))
  }
}

/**
 * 调用服务器 API。body 为 undefined 时发 GET，否则发 POST（JSON）。
 * 响应即使不是 JSON 也返回空对象，避免测试因为一个解析异常而中断。
 * @returns {Promise<{status: number, json: any}>}
 */
async function api(path, body) {
  const res = await fetch(BASE + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

const alive = await api('/api/health').then((r) => r.json.ok === true).catch(() => false)
if (!alive) {
  console.log('SKIP — no studio server at ' + BASE + ' (start it with `npm start` first)')
  process.exit(0)
}

const unique = 'trash-test-' + Date.now().toString(36)
// 素材库按内容寻址，因此每个测试都需要「不同的像素」，否则第二次导入只会返回第一个素材，
// 断言会变得混乱。这里每次生成都让 shade 递增，保证内容唯一。
const { makePng } = await import('./sbsar-fixture.mjs')
let seed = 1
const png = () => 'data:image/png;base64,' + makePng(8, 8, seed++ * 37).toString('base64')

console.log('\n1. materials: delete → bin → restore')
{
  const project = {
    name: unique,
    version: 1,
    app: 'substrate-texture-designer',
    resolution: 512,
    graph: { nodes: [{ id: 'material_output-test', type: 'material_output', x: 0, y: 0, params: {}, data: {} }], connections: [] }
  }
  const saved = await api('/api/projects/save', project)
  ok('project saved', saved.json.ok === true, JSON.stringify(saved.json))

  const del = await api('/api/projects/delete', { name: unique })
  ok('delete returns a bin id', del.json.ok === true && !!del.json.trashed?.id, JSON.stringify(del.json))
  const binId = del.json.trashed.id

  const listed = await api('/api/projects')
  ok('deleted project is gone from the material list', !listed.json.projects.some((p) => p.name === unique))

  const trash = await api('/api/trash')
  const item = (trash.json.projects || []).find((p) => p.id === binId)
  ok('it appears in the recycle bin', !!item, JSON.stringify((trash.json.projects || []).map((p) => p.name)))
  ok('bin keeps its metadata (nodes/resolution)', item && item.nodes === 1 && item.resolution === 512, JSON.stringify(item && { nodes: item.nodes, res: item.resolution }))

  const restore = await api('/api/trash/restore', { kind: 'project', id: binId })
  ok('restore succeeds', restore.json.ok === true, JSON.stringify(restore.json))
  const listed2 = await api('/api/projects')
  ok('project is back in the material list', listed2.json.projects.some((p) => p.name === unique))

  // 第二轮：删除后直接彻底清除，验证「清空后不会复活」
  const del2 = await api('/api/projects/delete', { name: unique })
  const purge = await api('/api/trash/purge', { kind: 'project', id: del2.json.trashed.id })
  ok('purge succeeds', purge.json.ok === true, JSON.stringify(purge.json))
  const trash2 = await api('/api/trash')
  ok('purged project is no longer in the bin', !(trash2.json.projects || []).some((p) => p.id === del2.json.trashed.id))
  const listed3 = await api('/api/projects')
  ok('purged project is not resurrected', !listed3.json.projects.some((p) => p.name === unique))
}

console.log('\n2. assets: delete → bin → restore → purge')
{
  const imp = await api('/api/assets/import', { name: unique + '.png', dataUrl: png() })
  ok('asset imported', imp.json.ok === true, JSON.stringify(imp.json))
  const id = imp.json.asset.id

  const del = await api('/api/assets/delete', { id })
  ok('delete flags the asset (soft delete)', del.json.ok === true && !!del.json.deletedAt, JSON.stringify(del.json))
  const visible = await api('/api/assets')
  ok('asset is hidden from the library', !visible.json.assets.some((a) => a.id === id))
  const trash = await api('/api/trash')
  ok('asset appears in the recycle bin', (trash.json.assets || []).some((a) => a.id === id))

  const restore = await api('/api/trash/restore', { kind: 'asset', id })
  ok('restore succeeds', restore.json.ok === true, JSON.stringify(restore.json))
  const visible2 = await api('/api/assets')
  ok('asset is back in the library', visible2.json.assets.some((a) => a.id === id))

  await api('/api/assets/delete', { id })
  const purge = await api('/api/trash/purge', { kind: 'asset', id })
  ok('purge succeeds', purge.json.ok === true, JSON.stringify(purge.json))
  const trash2 = await api('/api/trash')
  ok('purged asset is gone from the bin', !(trash2.json.assets || []).some((a) => a.id === id))
  const visible3 = await api('/api/assets')
  ok('purged asset does not come back', !visible3.json.assets.some((a) => a.id === id))
}

console.log('\n3. archive cascade + empty endpoint')
{
  const first = await api('/api/assets/import', { name: unique + '-a.png', dataUrl: png() })
  const second = await api('/api/assets/import', { name: unique + '-b.png', dataUrl: png() })
  await api('/api/assets/delete', { id: first.json.asset.id })
  await api('/api/assets/delete', { id: second.json.asset.id })
  const trash = await api('/api/trash')
  const before = (trash.json.assets || []).filter((a) => a.name.startsWith(unique)).length
  ok('both binned assets are listed', before === 2, String(before))

  const empty = await api('/api/trash/empty', {})
  ok('empty endpoint reports what it removed', empty.json.ok === true && empty.json.purged.assets >= 2, JSON.stringify(empty.json))
  const trash2 = await api('/api/trash')
  ok('bin is empty afterwards', (trash2.json.assets || []).length === 0 && (trash2.json.projects || []).length === 0, JSON.stringify({ a: (trash2.json.assets || []).length, p: (trash2.json.projects || []).length }))
}

console.log('\n4. error paths')
{
  const missing = await api('/api/trash/restore', { kind: 'project', id: 'project-does-not-exist' })
  ok('restoring an unknown item fails with 404', missing.status === 404, String(missing.status))
  const noId = await api('/api/trash/purge', { kind: 'asset' })
  ok('purging without an id is rejected', noId.status === 400, String(noId.status))
  const delMissing = await api('/api/projects/delete', { name: 'definitely-not-a-project' })
  ok('deleting an unknown project fails with 404', delMissing.status === 404, String(delMissing.status))
}

console.log('\n5. deletion guards: open material + asset in use')
{
  // 正在编辑器中打开的材质不能被直接删除（需要 force）
  const guarded = unique + '-active'
  await api('/api/projects/save', { name: guarded, version: 1, app: 'substrate-texture-designer', resolution: 512, graph: { nodes: [{ id: 'material_output-x', type: 'material_output', x: 0, y: 0, params: {}, data: {} }], connections: [] } })
  await api('/api/projects/active', { name: guarded })
  const activeList = await api('/api/projects')
  const activeRow = activeList.json.projects.find((p) => p.name === guarded)
  ok('project list marks the open material', activeRow && activeRow.active === true, JSON.stringify(activeRow && { active: activeRow.active }))
  const blocked = await api('/api/projects/delete', { name: guarded })
  ok('deleting the open material is refused with 409', blocked.status === 409 && blocked.json.error?.code === 'PROJECT_ACTIVE', JSON.stringify(blocked.json))
  const forcedDel = await api('/api/projects/delete', { name: guarded, force: true })
  ok('force deletes the open material', forcedDel.json.ok === true, JSON.stringify(forcedDel.json))
  if (forcedDel.json.trashed) await api('/api/trash/purge', { kind: 'project', id: forcedDel.json.trashed.id })
  await api('/api/projects/active', { name: '' })

  // 被已保存材质引用的素材不能被删除（要先解除引用）
  const usedImp = await api('/api/assets/import', { name: unique + '-used.png', dataUrl: png() })
  const usedId = usedImp.json.asset.id
  const consumer = unique + '-consumer'
  await api('/api/projects/save', {
    name: consumer,
    version: 1,
    app: 'substrate-texture-designer',
    resolution: 512,
    graph: {
      nodes: [
        { id: 'image_input-consumer', type: 'image_input', x: 0, y: 0, params: {}, data: { imageAssetId: usedId, imageName: unique + '-used.png' } },
        { id: 'material_output-consumer', type: 'material_output', x: 400, y: 0, params: {}, data: {} }
      ],
      connections: [{ id: 'l-consumer', from: { node: 'image_input-consumer', port: 'out' }, to: { node: 'material_output-consumer', port: 'basecolor' } }]
    }
  })
  const withUsage = await api('/api/assets')
  const usedAsset = withUsage.json.assets.find((a) => a.id === usedId)
  ok('library reports the project that uses the asset', usedAsset && Array.isArray(usedAsset.usage) && usedAsset.usage.some((u) => u.project === consumer), JSON.stringify(usedAsset && usedAsset.usage))
  const assetBlocked = await api('/api/assets/delete', { id: usedId })
  ok('deleting an asset in use is refused with 409', assetBlocked.status === 409 && assetBlocked.json.error?.code === 'ASSET_IN_USE', JSON.stringify(assetBlocked.json))
  const stillThere = await api('/api/assets')
  ok('the asset survives the refused deletion', stillThere.json.assets.some((a) => a.id === usedId))

  // 清理：先把引用者移入回收站并彻底删除（这一步才会解除绑定），之后素材就可以删除了
  const consumerBinned = await api('/api/projects/delete', { name: consumer, force: true })
  if (consumerBinned.json.trashed) await api('/api/trash/purge', { kind: 'project', id: consumerBinned.json.trashed.id })
  const afterConsumer = await api('/api/assets/delete', { id: usedId })
  ok('without its consumer the asset can be binned', afterConsumer.json.ok === true, JSON.stringify(afterConsumer.json))
  await api('/api/trash/empty', {})
}

console.log('\n6. bindings survive the recycle bin')
{
  // 被「已进入回收站但未彻底删除」的材质引用的素材，必须继续保持锁定
  const bindImp = await api('/api/assets/import', { name: unique + '-bind.png', dataUrl: png() })
  const bindAsset = bindImp.json.asset.id
  const holder = unique + '-binder'
  await api('/api/projects/save', {
    name: holder,
    version: 1,
    app: 'substrate-texture-designer',
    resolution: 512,
    graph: {
      nodes: [
        { id: 'image_input-binder', type: 'image_input', x: 0, y: 0, params: {}, data: { imageAssetId: bindAsset } },
        { id: 'material_output-binder', type: 'material_output', x: 400, y: 0, params: {}, data: {} }
      ],
      connections: []
    }
  })
  const binned = await api('/api/projects/delete', { name: holder, force: true })
  ok('material moved to the bin', binned.json.ok === true && !!binned.json.trashed?.id)
  const binUsage = await api('/api/assets')
  const lockedAsset = binUsage.json.assets.find((a) => a.id === bindAsset)
  ok('library still reports the binding (trashed flag)', lockedAsset && lockedAsset.usage.some((u) => u.trashed === true && u.project === holder), JSON.stringify(lockedAsset && lockedAsset.usage))
  const blockedByBin = await api('/api/assets/delete', { id: bindAsset })
  ok('asset cannot be deleted while its material sits in the bin', blockedByBin.status === 409 && blockedByBin.json.error?.code === 'ASSET_IN_USE', JSON.stringify(blockedByBin.json))
  const binList = await api('/api/trash')
  const binnedItem = (binList.json.projects || []).find((p) => p.name === holder)
  ok('bin reports how many assets the material still binds', binnedItem && binnedItem.boundAssets === 1, JSON.stringify(binnedItem && { boundAssets: binnedItem.boundAssets }))
  // 只有「彻底删除」这个材质，才会真正解除素材绑定
  const purge = await api('/api/trash/purge', { kind: 'project', id: binned.json.trashed.id })
  ok('purging the binned material succeeds', purge.json.ok === true)
  const released = await api('/api/assets/delete', { id: bindAsset })
  ok('the asset becomes deletable only after the purge', released.json.ok === true, JSON.stringify(released.json))
  await api('/api/trash/empty', {})
}

console.log(`\n${fail ? '✕ FAILED' : '✓ PASSED'} — ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
