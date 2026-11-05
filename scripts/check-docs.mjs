#!/usr/bin/env node
/**
 * 文档一致性检查脚本（不是单元测试，而是文档规范的守门人）。
 *
 * 检查项：
 * 1. 中英文文档成对存在；
 * 2. 中文文档确实包含足够的中文（≥50 个汉字），防止只放了个空壳；
 * 3. 双向语言切换链接存在（英文→中文、中文→英文）；
 * 4. 二级标题数量大致对齐（允许相差 1 个），避免翻译漏章节；
 * 5. 所有相对链接与图片引用都能解析到真实文件；
 * 6. 中文文档索引覆盖每一篇中文文档；
 * 7. 应用内帮助对话框与 dist 构建都包含这些文档。
 *
 * 运行：node scripts/check-docs.mjs（有失败项时以退出码 1 结束，可直接用于 CI）
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 需要保持中英文对齐的文档对
const pairs = [
  { en: 'README.md', zh: 'README.zh-CN.md' },
  { en: 'docs/mcp.md', zh: 'docs/zh/mcp.md' },
  { en: 'docs/llm.md', zh: 'docs/zh/llm.md' },
  { en: 'docs/asset-search.md', zh: 'docs/zh/asset-search.md' },
  { en: 'docs/brushes.md', zh: 'docs/zh/brushes.md' }
]
const extras = ['docs/zh/README.md']
const results = []
let failed = 0
/**
 * 记录一条检查结果；失败时同时递增全局失败计数。
 * info 只在该项失败时展示，用来提示具体原因。
 */
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info: ok ? '' : info })
  if (!ok) failed++
}

/** 读取相对项目根目录的文档内容（UTF-8）。 */
function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8')
}
/** 统计指定级别的 Markdown 标题数量（level=2 即 '## '）。 */
function countHeadings(text, level) {
  return (text.match(new RegExp('^' + '#'.repeat(level) + ' ', 'gm')) || []).length
}
/** 统计文本中的汉字数量，用于判断中文文档是否真的翻译过。 */
function countCjk(text) {
  return (text.match(/[\u4e00-\u9fff]/g) || []).length
}
/**
 * 解析文档中所有 Markdown 链接（含图片 ![]()），跳过外部协议与锚点，
 * 检查剩余相对路径在磁盘上是否存在。路径中的 #fragment 与 URL 编码会先被剥离/解码。
 */
function checkLinks(rel) {
  const text = read(rel)
  const dir = path.dirname(path.join(ROOT, rel))
  const links = [...text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1])
  const broken = []
  for (const raw of links) {
    if (/^(https?:|mailto:|data:|javascript:|#)/i.test(raw)) continue
    const clean = decodeURIComponent(raw.split('#')[0])
    const target = path.resolve(dir, clean)
    if (!existsSync(target)) broken.push(raw)
    else if (!statSync(target).isDirectory() && !statSync(target).isFile()) broken.push(raw)
  }
  check(rel + ': relative links/images resolve', broken.length === 0, broken.join(', '))
}

check('Chinese docs index exists', existsSync(path.join(ROOT, 'docs/zh/README.md')))
for (const extra of extras) check(extra + ': exists', existsSync(path.join(ROOT, extra)))

for (const pair of pairs) {
  const enPath = path.join(ROOT, pair.en)
  const zhPath = path.join(ROOT, pair.zh)
  check(pair.en + ': exists', existsSync(enPath))
  check(pair.zh + ': exists', existsSync(zhPath))
  if (!existsSync(enPath) || !existsSync(zhPath)) continue
  const en = read(pair.en)
  const zh = read(pair.zh)
  check(pair.zh + ': contains Chinese text', countCjk(zh) >= 50, String(countCjk(zh)))
  const zhBase = path.basename(pair.zh)
  const enBase = path.basename(pair.en)
  if (pair.en === 'README.md') {
    check('README.md: switch to Chinese docs', en.includes('README.zh-CN.md') && en.includes('docs/zh/README.md'))
    check('README.zh-CN.md: switch back to English', zh.includes('README.md') && zh.includes('docs/zh/README.md'))
  } else {
    check(pair.en + ': links to Chinese version', en.includes('zh/' + zhBase), 'missing zh/' + zhBase)
    check(pair.zh + ': links to English version', zh.includes('../' + enBase), 'missing ../' + enBase)
  }
  const enH2 = countHeadings(en, 2)
  const zhH2 = countHeadings(zh, 2)
  // 章节数量不应出现明显偏差（允许 ±1），否则通常意味着翻译漏掉了整节
  check(pair.zh + ': section parity', Math.abs(enH2 - zhH2) <= 1, `EN ${enH2} vs ZH ${zhH2}`)
}

const allDocs = [...pairs.flatMap((p) => [p.en, p.zh]), ...extras]
for (const doc of allDocs) checkLinks(doc)

// 中文索引应链接到每一篇中文文档，方便用户在一处找到全部资料
const index = read('docs/zh/README.md')
for (const extra of ['mcp.md', 'llm.md', 'asset-search.md', 'brushes.md']) {
  check('docs/zh/README.md: links ' + extra, index.includes(extra))
}

// 应用内「帮助」对话框需要暴露中英文文档入口，且 dist 构建必须带上这些文档
const appJs = read('src/App.js')
check('Help dialog links Chinese docs', appJs.includes('/README.zh-CN.md') && appJs.includes('/docs/zh/README.md'))
const buildJs = read('scripts/build.mjs')
check('dist build copies documentation', buildJs.includes("copy('docs'") && buildJs.includes("copy('README.zh-CN.md'"))

console.log('')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : ' — ' + r.info}`)
console.log('')
console.log(`DOCS TEST ${failed === 0 ? 'PASSED' : 'FAILED'} — ${results.length - failed} passed, ${failed} failed`)
if (failed) process.exit(1)
