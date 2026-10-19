// Zero-bundler "build": copy the app and the two vendor ESM entry points into dist/.
import { cpSync, mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')

if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true })
mkdirSync(DIST, { recursive: true })

const copy = (from, to) => {
  const src = path.join(ROOT, from)
  const dst = path.join(DIST, to)
  if (!existsSync(src)) {
    console.warn('[build] missing', from)
    return
  }
  cpSync(src, dst, { recursive: true })
}

copy('index.html', 'index.html')
copy('src', 'src')
copy('public', 'public')
// Documentation (English + Chinese) is served by the app and linked from the Help dialog.
copy('README.md', 'README.md')
copy('README.zh-CN.md', 'README.zh-CN.md')
copy('docs', 'docs')
copy('node_modules/vue/dist/vue.esm-browser.prod.js', 'vendor/vue.esm-browser.prod.js')
copy('node_modules/three/build/three.module.js', 'vendor/three.module.js')
copy('node_modules/three/examples/jsm/controls/OrbitControls.js', 'vendor/addons/controls/OrbitControls.js')
copy('node_modules/three/examples/jsm/environments/RoomEnvironment.js', 'vendor/addons/environments/RoomEnvironment.js')
copy('vendor/json-formatter.umd.js', 'vendor/json-formatter.umd.js')

console.log('[build] wrote dist/ — run: node server/index.js --dist')
