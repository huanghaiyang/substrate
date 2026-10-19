// Integration tests for the recycle bin (materials/projects + library assets).
//
// Runs against a live studio server (npm start). If the server is not reachable the suite reports SKIP
// instead of failing, so it stays usable in a bare checkout.
//
//   npm run test:trash            # uses http://127.0.0.1:3000
//   SUBSTRATE_URL=http://host:port npm run test:trash
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
// the asset library is content-addressed, so every test needs *unique pixels* — otherwise a second
// import just returns the first asset and the assertions get confusing.
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

  // second round: delete + purge
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
  // a material that is open in the editor cannot be deleted
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

  // an asset referenced by a saved material cannot be deleted
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

  // cleanup: bin the consumer, purge it (that is what releases the binding), then the asset can go
  const consumerBinned = await api('/api/projects/delete', { name: consumer, force: true })
  if (consumerBinned.json.trashed) await api('/api/trash/purge', { kind: 'project', id: consumerBinned.json.trashed.id })
  const afterConsumer = await api('/api/assets/delete', { id: usedId })
  ok('without its consumer the asset can be binned', afterConsumer.json.ok === true, JSON.stringify(afterConsumer.json))
  await api('/api/trash/empty', {})
}

console.log('\n6. bindings survive the recycle bin')
{
  // an asset used by a material that is only *binned* must stay locked
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
  // permanently deleting the material is the only thing that releases the binding
  const purge = await api('/api/trash/purge', { kind: 'project', id: binned.json.trashed.id })
  ok('purging the binned material succeeds', purge.json.ok === true)
  const released = await api('/api/assets/delete', { id: bindAsset })
  ok('the asset becomes deletable only after the purge', released.json.ok === true, JSON.stringify(released.json))
  await api('/api/trash/empty', {})
}

console.log(`\n${fail ? '✕ FAILED' : '✓ PASSED'} — ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
