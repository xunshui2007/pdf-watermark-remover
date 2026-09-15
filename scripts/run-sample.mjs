/**
 * 用真实 PDF 跑一遍完整流水线并把产物落盘，便于用其它工具离线校验。
 * 用法：node scripts/run-sample.mjs <输入.pdf> [输出.pdf]
 */
import { buildSync } from 'esbuild'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const src = process.argv[2]
if (!src || !fs.existsSync(src)) {
  console.error('用法：node scripts/run-sample.mjs <输入.pdf> [输出.pdf]')
  process.exit(2)
}
const dst = process.argv[3] ?? path.join(root, '_js-output.pdf')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfwm-run-'))
const entry = path.join(tmp, 'entry.ts')
fs.writeFileSync(
  entry,
  `import fs from 'node:fs'
import { removePdfWatermark } from ${JSON.stringify(path.join(root, 'src', 'pdf', 'removeWatermark.ts'))}
const bytes = new Uint8Array(fs.readFileSync(${JSON.stringify(src)}))
const { bytes: out, report } = await removePdfWatermark(bytes, { fileName: ${JSON.stringify(path.basename(src))} })
fs.writeFileSync(${JSON.stringify(dst)}, out)
console.log(JSON.stringify(report))
`,
)

const bundle = path.join(tmp, 'entry.mjs')
buildSync({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'warning',
})

const r = spawnSync(process.execPath, [bundle], { stdio: 'inherit' })
fs.rmSync(tmp, { recursive: true, force: true })
if (r.status !== 0) process.exit(r.status ?? 1)
console.log('输出:', dst, fs.statSync(dst).size, '字节')
