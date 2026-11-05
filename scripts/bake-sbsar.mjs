/**
 * 通过 Adobe Substance Automation Toolkit（SAT）把 .sbsar 烘焙成真实的 PBR 贴图。
 *
 * 为什么需要这一步：.sbsar 本身不含像素。它只发布「图描述(.xml) + 已编译的引擎字节码(.sbsasm)」，
 * 只有经过 Adobe Substance Engine 真正「求值」之后才会产生 PBR 输出。
 * SAT 是官方支持的批处理途径（其中包含引擎与 sbsrender 命令行工具）。
 *
 *   npm run bake:sbsar -- path/to/asset.sbsar [--out baked/name] [--res 2048] [--graph "pkg://…"]
 *
 * 烘焙完成后，用工作台的「Import PBR set」（素材库）导入这些 PNG：
 * 它会按文件名识别 basecolor/normal/roughness/metallic/height/ao，并自动接好材质节点。
 *
 * 查找 SAT 的顺序：--sbsrender <路径> → 环境变量 SBSRENDER / SUBSTANCE_SAT_HOME → PATH 中的 sbsrender。
 * 安装说明：https://helpx.adobe.com/substance-3d-sat/（需要 Substance 3D 订阅）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
/** 读取 --name 形式的参数值；未出现时返回 def。 */
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : def
}
/** 判断命令行是否包含某个 --name 开关。 */
const has = (name) => argv.includes('--' + name)
// 识别第一个「不是选项值」的位置参数作为输入文件
const input = argv.find((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--')))
if (!input) {
  console.error('usage: node scripts/bake-sbsar.mjs <asset.sbsar> [--out dir] [--res 2048] [--graph url] [--sbsrender path]')
  process.exit(2)
}

// 常见安装位置（Windows 默认两处、macOS 与 Linux 各一处），另加 Node 可执行文件同目录，
// 方便把 SAT 直接放到便携包旁边
const SAT_HINTS = [
  path.resolve(path.dirname(process.execPath), 'sbsrender.exe'),
  'C:/Program Files/Allegorithmic/Substance Automation Toolkit/sbsrender.exe',
  'C:/Program Files/Adobe/Substance 3D Automation Toolkit/sbsrender.exe',
  '/Applications/Substance Automation Toolkit/sbsrender',
  '/opt/Substance Automation Toolkit/sbsrender'
]

/**
 * 按优先级查找 sbsrender 可执行文件：
 * 1. 显式参数 --sbsrender 或环境变量 SBSRENDER；
 * 2. SUBSTANCE_SAT_HOME 下的常见相对路径（根目录 / bin 子目录 / 无扩展名）；
 * 3. 各平台的默认安装位置；
 * 4. 最后尝试从 PATH 中查找（Windows 用 where，其他平台用 which）。
 *
 * @returns {string|null} 可执行文件路径；找不到返回 null
 */
function findSbsrender() {
  const explicit = flag('sbsrender') || process.env.SBSRENDER
  if (explicit && existsSync(explicit)) return explicit
  const home = process.env.SUBSTANCE_SAT_HOME
  if (home) {
    const candidates = [
      path.join(home, 'sbsrender.exe'),
      path.join(home, 'bin', 'sbsrender.exe'),
      path.join(home, 'sbsrender')
    ]
    const hit = candidates.find((c) => existsSync(c))
    if (hit) return hit
  }
  for (const c of SAT_HINTS) if (existsSync(c)) return c
  try {
    const which = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(which, ['sbsrender'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
    if (first && existsSync(first)) return first
  } catch (e) {
    /* PATH 中没有找到，属于预期情况 */
  }
  return null
}

const sbsrender = findSbsrender()
if (!sbsrender) {
  console.error(
    [
      '',
      '✕ sbsrender (Substance Automation Toolkit) was not found.',
      '',
      'A .sbsar cannot be turned into PBR maps without Adobe\'s Substance Engine; SAT is the supported',
      'batch path. Install SAT (Substance 3D subscription) and re-run with one of:',
      '',
      '  set SBSRENDER="C:\\Program Files\\Allegorithmic\\Substance Automation Toolkit\\sbsrender.exe"',
      '  set SUBSTANCE_SAT_HOME="C:\\Program Files\\Allegorithmic\\Substance Automation Toolkit"',
      '  node scripts/bake-sbsar.mjs asset.sbsar --sbsrender "…\\sbsrender.exe"',
      '',
      'Alternatives that bake the same graph: Substance 3D Designer (open the .sbsar → Export outputs),',
      'Substance 3D Player, or the Adobe Substance plugin for Unity/Unreal/Blender.',
      ''
    ].join('\n')
  )
  process.exit(1)
}

const res = Number(flag('res', 1024)) || 1024
// 输出目录默认放在 baked/<材质名>-<分辨率>/，便于一次烘焙多个分辨率而不互相覆盖
const outDir = path.resolve(flag('out', path.join('baked', path.basename(input).replace(/\.sbsar$/i, '') + '-' + res)))
const graph = flag('graph')
mkdirSync(outDir, { recursive: true })

console.log('sbsrender :', sbsrender)
console.log('input     :', input)
console.log('resolution:', res + '×' + res)
console.log('output    :', outDir)

// 步骤 1：先描述资产（图、输入、输出），确认输出名称后再渲染，避免白白等待一次高分辨率烘焙
try {
  const info = execFileSync(sbsrender, ['info', '--input', input], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const start = info.indexOf('{')
  const js = start >= 0 ? JSON.parse(info.slice(start)) : null
  if (js) {
    const graphs = js.graphs || js.substances || []
    for (const g of graphs) {
      console.log('\ngraph:', g.graphUrl || g.url || g.identifier || '(unnamed)')
      for (const o of g.outputs || []) {
        console.log('  output:', o.identifier || o.name, '· usage:', o.usage || '-', '· format:', o.format || '-')
      }
    }
  } else {
    console.log('\n[sbsrender info]\n' + info.trim().split('\n').slice(0, 20).join('\n'))
  }
} catch (e) {
  console.warn('warning: `sbsrender info` failed, continuing to render:', (e.stdout || e.message || '').toString().split('\n')[0])
}

// 步骤 2：把每个输出节点渲染成一张 PNG（文件名由「输入名_输出节点名」组合而成）
const args = [
  'render',
  '--input', input,
  '--output-path', outDir,
  '--output-name', '{inputName}_{outputNodeName}',
  '--output-format', 'png',
  '--output-bit-depth', '16',
  '--no-report'
]
if (graph) args.push('--input-graph', graph)
// 图级分辨率参数：描述文件把输出尺寸暴露为 $outputsize（vector2），这里按 <res>,<res> 传入
args.push('--set-value', `$outputsize@${res},${res}`)

console.log('\n$', path.basename(sbsrender), args.join(' '))
try {
  execFileSync(sbsrender, args, { stdio: 'inherit' })
} catch (e) {
  console.error('\n✕ sbsrender failed:', e.message)
  process.exit(1)
}

const files = readdirSync(outDir)
  .filter((f) => /\.(png|tga|exr|tif?f)$/i.test(f))
  .map((f) => ({ f, kb: Math.round(statSync(path.join(outDir, f)).size / 1024) }))
console.log('\nbaked ' + files.length + ' map(s):')
for (const { f, kb } of files) console.log('  ' + f + '  ' + kb + ' KB')
console.log(
  [
    '',
    'next: open the studio → Material Library → “Import PBR set” and select these files.',
    '      Channels are recognised by name (basecolor/normal/roughness/metallic/height/ao/…);',
    '      data maps are wired in raw (Data (RGB)) so normals/roughness keep their numeric values.',
    ''
  ].join('\n')
)
