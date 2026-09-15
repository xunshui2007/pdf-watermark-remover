/** 把 pdf.js 的 worker 复制到 public/，由站点自身托管（不依赖 CDN 或全局安装路径） */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 注意：必须用 fileURLToPath，pathname 在含中文的路径里是百分号编码的
const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.join(here, '..')
const candidates = [
  path.join(pkgRoot, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'),
  path.join(pkgRoot, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.mjs'),
]
const target = path.join(pkgRoot, 'public', 'pdf.worker.min.mjs')

const src = candidates.find((p) => fs.existsSync(p))
if (!src) {
  console.error('[copy-pdfjs-worker] 未找到 pdfjs-dist 的 worker，请先 npm install')
  process.exit(1)
}
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.copyFileSync(src, target)
console.log(`[copy-pdfjs-worker] ${path.relative(pkgRoot, src)} -> public/pdf.worker.min.mjs`)
