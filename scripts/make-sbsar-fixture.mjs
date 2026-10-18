// Generate the demo/test archives used by the browser flow and the report.
//   node scripts/make-sbsar-fixture.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { makeZipSbsar, makeNativeSbsar, makeZip, makePng, GRAPH_XML, SBAM } from './sbsar-fixture.mjs'

const out = 'docs/reports/sbsar-import/fixtures'
mkdirSync(out, { recursive: true })

const zip = makeZipSbsar()
writeFileSync(out + '/TestMaterial.sbsar', zip)
writeFileSync(out + '/TestMaterial-deflated.sbsar', makeZip([
  { name: 'TestMaterial.xml', data: Buffer.from(GRAPH_XML, 'utf8') },
  { name: 'thumbnail.png', data: makePng(128, 128, 90) },
  { name: 'TestMaterial.sbsasm', data: SBAM }
], { deflate: true }))
writeFileSync(out + '/Native-Container.sbsar', makeNativeSbsar())
console.log('wrote fixtures to', out, '· zip', zip.length, 'bytes')
