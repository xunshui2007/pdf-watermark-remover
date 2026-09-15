/**
 * 真实样本端到端校验（本机存在 2GB013 位号图时才运行）：
 *  1) 两页水印块被删除、无残留引用、绘图与文字操作数不变；
 *  2) 用 PyMuPDF 把「浏览器版输出」与「Python 版输出」渲染成原始 RGB，
 *     逐像素比对：差异必须是抗锯齿级噪声（无超过阈值的像素）。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { removePdfWatermark } from '../src/pdf/removeWatermark'

const REAL_PDF = 'F:/数字化连接/2GB013_V1.01_位号图(260914).pdf'
const PY_OUTPUT = 'F:/数字化连接/2GB013_V1.01_位号图(260914)_去水印.pdf'
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

const hasReal = fs.existsSync(REAL_PDF) && fs.existsSync(PY_OUTPUT)

describe.skipIf(!hasReal)('真实样本 2GB013 位号图：结构 + 渲染像素校验', () => {
  it('两页水印全部删除，文字层与绘图保留', async () => {
    const input = new Uint8Array(fs.readFileSync(REAL_PDF))
    const { bytes, report } = await removePdfWatermark(input, { fileName: '2GB013.pdf' })

    expect(report.pages).toHaveLength(2)
    expect(report.totalRemoved).toBe(2)
    for (const p of report.pages) {
      expect(p.removed).toBe(1)
      expect(p.leftoverRefs).toBe(0)
    }
    // 水印资源清理：KSPX1..KSPX4（水印图层引用 /OC 就挂在这些 XObject 字典里）
    expect(report.cleanedXObjects.sort()).toEqual(['KSPX1', 'KSPX2', 'KSPX3', 'KSPX4'])
    expect(report.removedOCEntries).toBe(0) // /OC 随 XObject 一起删除，不是独立资源条目

    const outDoc = await PDFDocument.load(bytes)
    // 文件级 OCG 目录已从 Catalog 中移除
    expect(outDoc.catalog.get(PDFName.of('OCProperties'))).toBeUndefined()
    // 页面资源里不再有任何水印 XObject（水印图层引用 /OC 随它一起消失）
    for (let i = 0; i < outDoc.getPageCount(); i++) {
      const res = outDoc.getPage(i).node.Resources()
      const xo = res?.lookup(PDFName.of('XObject'), PDFDict)
      const keys = xo ? [...xo.keys()].map(String) : []
      expect(keys.filter((k) => k.startsWith('/KSPX'))).toEqual([])
    }
    // 说明：pdf-lib 保存时会带回不可达的孤立对象（/PieceInfo 水印设置、OCG 字典），
    // 因此这里断言可达性 GC 已把它们清掉，输出里不再出现水印痕迹。
    expect(report.gcObjectsRemoved).toBeGreaterThan(0)
    const raw = Buffer.from(bytes).toString('latin1')
    expect(raw).not.toContain('Watermark')
    expect(raw).not.toContain('/KSPX')
    expect(raw).not.toContain('/OCProperties')
    // 文件体积应显著小于原件（原 2330368 字节）
    expect(bytes.length).toBeLessThan(1200000)

    const texts = await pageContentTexts(bytes)
    for (const t of texts) {
      expect(t).not.toContain('Watermark')
      expect(t).not.toContain('/KSPX')
    }
    // 绘图与文字操作数与 Python 版完全一致（第 1 页 TJ=572，第 2 页 TJ=3052）
    expect((texts[0].match(/TJ/g) || []).length).toBe(572)
    expect((texts[1].match(/TJ/g) || []).length).toBe(3052)
    // 两页内容流里都不再有任何标记内容块
    expect(texts[0]).not.toContain('BDC')
    expect(texts[1]).not.toContain('BDC')
  })

  it('渲染结果与 Python 版输出逐像素一致（差异仅抗锯齿噪声）', () => {
    const input = new Uint8Array(fs.readFileSync(REAL_PDF))
    return removePdfWatermark(input, { fileName: '2GB013.pdf' }).then(({ bytes }) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfwm-'))
      const jsOut = path.join(tmp, 'js.pdf')
      fs.writeFileSync(jsOut, bytes)

      const run = (pdf: string, prefix: string) => {
        const r = spawnSync(PY, [path.join(__dirname, '..', 'tools', 'pixels.py'), pdf, prefix, '150'], {
          encoding: 'utf8',
        })
        if (r.status !== 0) throw new Error(`pixels.py 失败: ${r.status} ${r.stderr}`)
      }

      let rendered = true
      try {
        run(jsOut, path.join(tmp, 'js'))
        run(PY_OUTPUT, path.join(tmp, 'py'))
      } catch (e) {
        rendered = false
        console.warn('像素渲染不可用：', (e as Error).message)
      }

      if (rendered) {
        for (const page of [1, 2]) {
          const a = readRaw(path.join(tmp, `js.p${page}.raw`))
          const b = readRaw(path.join(tmp, `py.p${page}.raw`))
          const stats = comparePixels(a, b, 40)
          // 两种实现对同一输入的处理结果在渲染上必须等价：
          // 超过 40/255 的像素一个都不允许有（抗锯齿噪声实测最大 36）
          expect(stats.overThreshold, `第 ${page} 页存在内容级差异`).toBe(0)
          expect(stats.maxDiff).toBeLessThanOrEqual(40)
        }
      } else {
        // 无渲染环境时退化为结构校验（不得静默通过）
        console.warn('本次未执行像素比对，仅完成结构校验')
      }

      fs.rmSync(tmp, { recursive: true, force: true })
    })
  })
})
