/**
 * 本地烘焙桥（server/sbsar-bake.mjs）的测试。
 *
 * 这里真正要验证的是「失败契约」：未安装 Adobe 引擎时，API 必须明确说明原因，
 * 并且绝不能伪造烘焙结果。原因是 Substance 引擎是原生、按用户授权的闭源二进制，
 * 无法以 WebAssembly 形式随应用分发。
 *
 * 覆盖内容：
 * 1. 引擎发现契约：sbsrender 的查找结果与状态字段自洽；
 * 2. 无引擎时 bakeSbsar 必须抛出 SAT_MISSING，并给出安装提示；
 * 3. 输出文件名 → PBR 通道的映射规则。
 */
import { bakeStatus, bakeSbsar, detectChannel, findSbsrender } from '../server/sbsar-bake.mjs'

let pass = 0
let fail = 0
/** 记录一条断言并打印结果。 */
const ok = (label, cond, info = '') => {
  if (cond) {
    pass++
    console.log('  PASS ' + label)
  } else {
    fail++
    console.log('  FAIL ' + label + (info ? ' :: ' + info : ''))
  }
}

console.log('\n1. engine discovery contract')
const found = findSbsrender()
const st = bakeStatus()
ok('findSbsrender returns null or a result object', found === null || typeof found.path === 'string', JSON.stringify(found))
ok('status mirrors discovery', st.available === !!found)
ok('status always explains the wasm constraint', /WebAssembly|native|closed-source/i.test(st.reason || ''), st.reason)
ok('status exposes an install URL', /^https:\/\//.test(st.installUrl), st.installUrl)
ok('platform is reported', typeof st.platform === 'string' && st.platform.length > 2, st.platform)

console.log('\n2. bake refuses to fake results')
if (!st.available) {
  let err = null
  try {
    await bakeSbsar({ file: '/definitely/not/here.sbsar' })
  } catch (e) {
    err = e
  }
  ok('bakeSbsar throws without an engine', !!err)
  ok('error code is SAT_MISSING', err && err.code === 'SAT_MISSING', err && err.code)
  ok('error message points at the install path', err && /Automation Toolkit|sbsrender/i.test(err.message), err && err.message)
} else {
  console.log('  SKIP (a local engine is installed — exercising the real bake needs a .sbsar fixture)')
}

console.log('\n3. output-name channel mapping')
const cases = [
  ['myMaterial_basecolor.png', 'basecolor'],
  ['myMaterial_albedo.png', 'basecolor'],
  ['myMaterial_normal.png', 'normal'],
  ['myMaterial_roughness.png', 'roughness'],
  ['myMaterial_metallic.png', 'metallic'],
  ['myMaterial_height.png', 'height'],
  ['myMaterial_ambientocclusion.png', 'ao'],
  ['myMaterial_emissive.png', 'emissive'],
  ['myMaterial_opacity.png', 'opacity'],
  ['thumbnail.png', null]
]
for (const [name, expected] of cases) {
  ok(`${name} → ${expected}`, detectChannel(name) === expected, String(detectChannel(name)))
}

console.log(`\n${fail ? '✕ FAILED' : '✓ PASSED'} — ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
