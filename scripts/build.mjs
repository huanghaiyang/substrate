/**
 * 零打包构建脚本：不做任何 bundle/transpile，只把应用源码、依赖的 ESM 入口和文档复制到 dist/。
 *
 * 这与项目「零打包 ESM + 浏览器原生 import map」的设计一致：构建产物结构与源码一致，
 * 直接把 dist/ 交给静态服务器即可运行。
 *
 * 用法：node scripts/build.mjs（之后运行 node server/index.js --dist 预览构建结果）
 */
import { cpSync, mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 以本脚本所在目录为基准向上定位项目根目录，保证从任意工作目录运行都能找到源文件
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')

// 每次构建先清空 dist/，避免残留旧版本文件掩盖问题
if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true })
mkdirSync(DIST, { recursive: true })

/**
 * 递归复制 from → dist/to。
 * 源不存在时只打印警告而不中断构建，这样即使缺少可选文档也能产出可运行的应用。
 */
const copy = (from, to) => {
  const src = path.join(ROOT, from)
  const dst = path.join(DIST, to)
  if (!existsSync(src)) {
    console.warn('[build] missing', from)
    return
  }
  cpSync(src, dst, { recursive: true })
}

// 应用入口、源码与静态资源
copy('index.html', 'index.html')
copy('src', 'src')
copy('public', 'public')
// 中英文文档会由应用直接提供（帮助对话框里有链接），因此一并复制
copy('README.md', 'README.md')
copy('README.zh-CN.md', 'README.zh-CN.md')
copy('docs', 'docs')
// 第三方 ESM 依赖：只复制运行期真正需要的入口文件，保持 dist 精简
copy('node_modules/vue/dist/vue.esm-browser.prod.js', 'vendor/vue.esm-browser.prod.js')
copy('node_modules/three/build/three.module.js', 'vendor/three.module.js')
copy('node_modules/three/examples/jsm/controls/OrbitControls.js', 'vendor/addons/controls/OrbitControls.js')
copy('node_modules/three/examples/jsm/environments/RoomEnvironment.js', 'vendor/addons/environments/RoomEnvironment.js')
copy('vendor/json-formatter.umd.js', 'vendor/json-formatter.umd.js')

console.log('[build] wrote dist/ — run: node server/index.js --dist')
