/**
 * 生成 .sbsar 测试夹具，并用导入器验证解析结果。
 *
 * 为什么需要它：真实的 .sbsar 是 7-Zip 容器，里面是
 *   assemblies/content/0000/<Graph>.xml · <Graph>.sbsasm · metadata.json · resources/<n>/…
 * 这样一层目录结构。本脚本会生成完全一致的目录树，再调用本机安装的 7-Zip 压缩成真正的
 * LZMA/LZMA2 归档，从而让测试跑在真实的容器格式与解压器上，而不是手搓的近似格式。
 *
 * 用法：node scripts/make-sbsar-fixture.mjs（产物写入 docs/reports/sbsar-import/fixtures）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makePng, makeZip, makeNativeSbsar, GRAPH_XML, SBAM } from './sbsar-fixture.mjs'
import { inspectSbsar } from '../server/sbsar.mjs'

// 夹具输出目录（相对项目根）
const OUT = 'docs/reports/sbsar-import/fixtures'
mkdirSync(OUT, { recursive: true })

// 依次探测常见的 7-Zip 安装路径与命令名，取第一个能正常执行的
const SEVEN_ZIP_CANDIDATES = [
  'C:/Program Files/7-Zip/7z.exe',
  'C:/Program Files (x86)/7-Zip/7z.exe',
  '7z',
  '7za'
]
const sevenZip = SEVEN_ZIP_CANDIDATES.find((p) => {
  try {
    execFileSync(p, ['i'], { stdio: 'ignore' })
    return true
  } catch (e) {
    return false
  }
})

// ---------------------------------------------------------------- 合成容器变体
// 两个「扁平/近似」的 .sbsar：用于验证导入器对非标准结构的容错能力
writeFileSync(path.join(OUT, 'TestMaterial.sbsar'), makeZip([
  { name: 'TestMaterial.xml', data: Buffer.from(GRAPH_XML, 'utf8') },
  { name: 'thumbnail.png', data: makePng(128, 128, 90) },
  { name: 'resources/albedo.png', data: makePng(512, 512, 160) },
  { name: 'TestMaterial.sbsasm', data: SBAM }
]))
writeFileSync(path.join(OUT, 'Native-Container.sbsar'), makeNativeSbsar())

/**
 * 在指定目录下生成真实的 7z 目录布局，并返回 assemblies/content/0000 路径。
 * 每个模拟资源都用不同尺寸/灰度生成图片，便于验证导入器能否按角色区分预览图与贴图。
 */
export function makeRealLayoutTree(dir) {
  const root = path.join(dir, 'assemblies', 'content', '0000')
  mkdirSync(path.join(root, 'resources', '0'), { recursive: true })
  mkdirSync(path.join(root, 'resources', '1'), { recursive: true })
  writeFileSync(path.join(root, 'TestMaterial.xml'), GRAPH_XML)
  writeFileSync(path.join(root, 'TestMaterial.sbsasm'), SBAM)
  writeFileSync(
    path.join(root, 'metadata.json'),
    JSON.stringify(
      { author: 'Substrate test fixture', description: 'Synthetic archive with the real 7z layout', url: 'https://example.invalid/asset' },
      null,
      2
    )
  )
  writeFileSync(path.join(root, 'resources', '0', 'preview.png'), makePng(256, 256, 100))
  writeFileSync(path.join(root, 'resources', '1', 'albedo.png'), makePng(512, 512, 170))
  return root
}

if (!sevenZip) {
  // 未安装 7-Zip：仍保留两个合成夹具，只是跳过需要真实压缩器的部分
  console.log('7-Zip not found — skipped the real-layout fixtures (synthetic ones were written)')
} else {
  console.log('using', sevenZip)
  // 在临时目录生成目录树，然后分别用 lzma2 / lzma / 不压缩三种方式打包，覆盖不同解码路径
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'sbsar-fixture-'))
  try {
    makeRealLayoutTree(tmp)
    for (const [name, method] of [
      ['RealLayout-lzma2.sbsar', 'lzma2'],
      ['RealLayout-lzma1.sbsar', 'lzma'],
      ['RealLayout-copy.sbsar', 'copy']
    ]) {
      const out = path.resolve(OUT, name)
      if (existsSync(out)) rmSync(out)
      execFileSync(sevenZip, ['a', '-t7z', `-m0=${method}`, '-mx=9', out, path.join(tmp, '*'), '-r'], { stdio: 'ignore' })
      console.log('wrote', name)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 用导入器做验证
let failures = 0
/** 打印一条断言的通过/失败结果，失败时累加计数。 */
const check = (label, cond, info = '') => {
  console.log((cond ? '  PASS ' : '  FAIL ') + label + (cond ? '' : ' :: ' + info))
  if (!cond) failures++
}
for (const name of ['RealLayout-lzma2.sbsar', 'RealLayout-lzma1.sbsar', 'RealLayout-copy.sbsar']) {
  const file = path.join(OUT, name)
  if (!existsSync(file)) {
    console.log('skip', name)
    continue
  }
  console.log('\n' + name)
  const r = inspectSbsar(readFileSync(file))
  // 逐项核对解析结果：容器识别、参数/图/输出数量、metadata 合并、资源图与 sbsasm 识别，
  // 以及「没有 Substance Engine 时不可求值」这一预期行为
  check('container is 7z', r.container === '7z', r.container)
  check('parameters parsed (3)', r.parameters.length === 3, String(r.parameters.length))
  check('graph parsed', r.graphs.length >= 1, JSON.stringify(r.graphs))
  check('output usages (3)', r.outputs.length === 3, JSON.stringify(r.outputs))
  check('metadata.json merged', r.metadata.author === 'Substrate test fixture', JSON.stringify(r.metadata))
  check('xml metadata kept', r.metadata.label === 'Test Material', JSON.stringify(r.metadata))
  check('2 resource bitmaps', r.images.length === 2, JSON.stringify(r.images.map((i) => i.name)))
  check('sbsasm recognised', r.assemblies.length === 1, JSON.stringify(r.assemblies))
  check('cannot evaluate (documented)', r.canEvaluate === false && /Substance Engine/.test(r.evaluateBlockedReason))
}
console.log(failures ? `\n✕ ${failures} check(s) failed` : '\n✓ fixtures and importer agree')
process.exit(failures ? 1 : 0)
