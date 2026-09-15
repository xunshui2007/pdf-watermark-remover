/**
 * 真实样本端到端校验（可选，通过环境变量提供样本路径；未提供时自动跳过）：
 *   SAMPLE_PDF        待处理的真实 PDF 路径
 *   SAMPLE_REFERENCE  参考实现的输出，用于逐像素比对（可选）
 *   PYTHON            python 解释器（默认 python）
 *
 * 校验内容：
 *  1) 水印块被删除、无残留引用、绘图与文字操作数不变；
 *  2) 用 PyMuPDF 把「本工具输出」与「参考实现输出」渲染成原始 RGB 逐像素比对，
 *     差异必须是抗锯齿级噪声（不允许有超过阈值的像素）。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { removePdfWatermark } from '../src/pdf/removeWatermark'

const SAMPLE = process.env.SAMPLE_PDF ?? ''
const REFERENCE = process.env.SAMPLE_REFERENCE ?? ''
const PY = process.env.PYTHON ?? 'python'
const MAGIC = 'DSHPIX1\0'

async function pageContentTexts(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const out: string[] = []
  for (let i = 0; i < doc.getPageCount(); i++) {
    const ref = doc.getPage(i).node.get(PDFName.of('Contents'))
    const s = doc.context.lookup(ref)
    if (s instanceof PDFRawStream) {
      out.push(Buffer.from(decodePDFRawStream(s).decode()).toString('latin1'))
    }
  }
  return out
}

interface RawImage {
  width: number
  height: number
  data: Buffer
}

function readRaw(file: string): RawImage {
  const buf = fs.readFileSync(file)
  const magic = buf.subarray(0, 8).toString('latin1')
  if (magic !== MAGIC) throw new Error(`非法 raw 文件：${file}`)
  const width = buf.readUInt32LE(8)
  const height = buf.readUInt32LE(12)
  return { width, height, data: buf.subarray(16) }
}

/** 逐像素比较，返回最大差值、超阈值像素数、差异像素数 */
function comparePixels(a: RawImage, b: RawImage, threshold: number) {
  expect(a.width).toBe(b.width)
  expect(a.height).toBe(b.height)
  expect(a.data.length).toBe(b.data.length)
  let maxDiff = 0
  let overThreshold = 0
  let differing = 0
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i] - b.data[i])
    if (d > 0) differing++
    if (d > maxDiff) maxDiff = d
    if (d > threshold) overThreshold++
  }
  return { maxDiff, overThreshold, differing, total: a.data.length }
}

const hasSample = SAMPLE !== '' && fs.existsSync(SAMPLE)

describe.skipIf(!hasSample)('真实样本：结构 + 渲染像素校验', () => {
  it('水印全部删除，文字层与绘图保留，水印资源被清理', async () => {
    const input = new Uint8Array(fs.readFileSync(SAMPLE))
    const { bytes, report } = await removePdfWatermark(input, { fileName: path.basename(SAMPLE) })

    expect(report.pages.length).toBeGreaterThan(0)
    for (const p of report.pages) {
      expect(p.leftoverRefs).toBe(0)
    }
    // 原始样本的每一页都应当含有水印标记内容
    expect(report.totalRemoved).toBeGreaterThan(0)

    const texts = await pageContentTexts(bytes)
    for (const t of texts) {
      expect(t).not.toContain('Watermark')
      expect(t).not.toContain('/KSPX')
    }

    const outDoc = await PDFDocument.load(bytes)
    expect(outDoc.catalog.get(PDFName.of('OCProperties'))).toBeUndefined()
    for (let i = 0; i < outDoc.getPageCount(); i++) {
      const res = outDoc.getPage(i).node.Resources()
      const xo = res?.lookup(PDFName.of('XObject'), PDFDict)
      const keys = xo ? [...xo.keys()].map(String) : []
      expect(keys.filter((k) => k.startsWith('/KSPX'))).toEqual([])
    }
    // 可达性 GC 应清掉不可达的水印图层字典等孤立对象
    expect(report.gcObjectsRemoved).toBeGreaterThan(0)
    const raw = Buffer.from(bytes).toString('latin1')
    expect(raw).not.toContain('Watermark')
    expect(raw).not.toContain('/KSPX')
  })

  it('渲染结果与参考实现逐像素一致（提供 SAMPLE_REFERENCE 时）', () => {
    if (!REFERENCE || !fs.existsSync(REFERENCE)) {
      console.warn('未提供 SAMPLE_REFERENCE，跳过逐像素比对')
      return
    }
    const input = new Uint8Array(fs.readFileSync(SAMPLE))
    return removePdfWatermark(input, { fileName: path.basename(SAMPLE) }).then(({ bytes }) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfwm-'))
      const jsOut = path.join(tmp, 'js.pdf')
      fs.writeFileSync(jsOut, bytes)

      const run = (pdf: string, prefix: string) => {
        const r = spawnSync(PY, [path.join(__dirname, '..', 'tools', 'pixels.py'), pdf, prefix, '150'], {
          encoding: 'utf8',
        })
        if (r.status !== 0) throw new Error(`pixels.py 失败: ${r.status} ${r.stderr}`)
      }

      try {
        run(jsOut, path.join(tmp, 'js'))
        run(REFERENCE, path.join(tmp, 'py'))

        let page = 1
        while (fs.existsSync(path.join(tmp, `js.p${page}.raw`))) {
          const a = readRaw(path.join(tmp, `js.p${page}.raw`))
          const b = readRaw(path.join(tmp, `py.p${page}.raw`))
          const stats = comparePixels(a, b, 40)
          // 两种实现对同一输入的处理结果在渲染上必须等价：
          // 超过 40/255 的像素一个都不允许有（抗锯齿噪声实测远低于该值）
          expect(stats.overThreshold, `第 ${page} 页存在内容级差异`).toBe(0)
          expect(stats.maxDiff).toBeLessThanOrEqual(40)
          page++
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
      }
    })
  })
})
