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
copy('node_modules/vue/dist/vue.esm-browser.prod.js', 'vendor/vue.esm-browser.prod.js')
copy('node_modules/three/build/three.module.js', 'vendor/three.module.js')
copy('node_modules/three/examples/jsm/controls/OrbitControls.js', 'vendor/addons/controls/OrbitControls.js')
copy('node_modules/three/examples/jsm/environments/RoomEnvironment.js', 'vendor/addons/environments/RoomEnvironment.js')

console.log('[build] wrote dist/ — run: node server/index.js --dist')
