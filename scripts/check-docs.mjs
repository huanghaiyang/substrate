#!/usr/bin/env node
// Documentation language/consistency check: paired EN/ZH files, language-switch links,
// relative links and image references. Run: node scripts/check-docs.mjs
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info: ok ? '' : info })
  if (!ok) failed++
}

function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8')
}
function countHeadings(text, level) {
  return (text.match(new RegExp('^' + '#'.repeat(level) + ' ', 'gm')) || []).length
}
function countCjk(text) {
  return (text.match(/[\u4e00-\u9fff]/g) || []).length
}
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
  check(pair.zh + ': section parity', Math.abs(enH2 - zhH2) <= 1, `EN ${enH2} vs ZH ${zhH2}`)
}

const allDocs = [...pairs.flatMap((p) => [p.en, p.zh]), ...extras]
for (const doc of allDocs) checkLinks(doc)

// docs index should link every Chinese doc
const index = read('docs/zh/README.md')
for (const extra of ['mcp.md', 'llm.md', 'asset-search.md', 'brushes.md']) {
  check('docs/zh/README.md: links ' + extra, index.includes(extra))
}

// in-app Help dialog exposes both language docs, and dist builds ship the docs
const appJs = read('src/App.js')
check('Help dialog links Chinese docs', appJs.includes('/README.zh-CN.md') && appJs.includes('/docs/zh/README.md'))
const buildJs = read('scripts/build.mjs')
check('dist build copies documentation', buildJs.includes("copy('docs'") && buildJs.includes("copy('README.zh-CN.md'"))

console.log('')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : ' — ' + r.info}`)
console.log('')
console.log(`DOCS TEST ${failed === 0 ? 'PASSED' : 'FAILED'} — ${results.length - failed} passed, ${failed} failed`)
if (failed) process.exit(1)
