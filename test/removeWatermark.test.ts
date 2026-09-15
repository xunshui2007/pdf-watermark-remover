/**
 * 核心逻辑回归测试：
 *  1) 语法级：内容流正则 + 嵌套深度匹配
 *  2) 合成夹具：水印块被删除、其余绘图保留、无残留引用
 *  3) 不误改：不含水印的 PDF 输出与输入字节完全一致
 *  4) 可选真实样本：设置环境变量 SAMPLE_PDF 后逐页校验（未设置则跳过）
 */
import fs from 'node:fs'
import path from 'node:path'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { removePdfWatermark, stripWatermarkBlocks } from '../src/pdf/removeWatermark'
import { buildPlainFixture, buildWatermarkedFixture } from './makeFixture'

/** 取出每页内容流的解码文本（跳过无法解码的非 PDFRawStream） */
async function pageContentTexts(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const out: string[] = []
  for (let i = 0; i < doc.getPageCount(); i++) {
    const node = doc.getPage(i).node
    const contentsRef = node.get(PDFName.of('Contents'))
    const looked = doc.context.lookup(contentsRef)
    const targets: unknown[] = []
    if (looked instanceof PDFArray) {
      for (let k = 0; k < looked.size(); k++) targets.push(looked.get(k))
    } else {
      targets.push(contentsRef)
    }
    for (const t of targets) {
      const s = doc.context.lookup(t as never)
      if (s instanceof PDFRawStream) {
        out.push(Buffer.from(decodePDFRawStream(s).decode()).toString('latin1'))
      }
    }
  }
  return out
}

describe('stripWatermarkBlocks（纯语法层）', () => {
  it('删除水印标记内容并保留前后绘图', () => {
    const src =
      'q 1 0 0 1 0 0 cm 10 10 m 20 20 l S Q\n' +
      '/Artifact <</Subtype/Watermark/Type/Pagination>>BDC\nq\n/WM Do\nQ\nEMC\n' +
      'BT /F1 12 Tf (R1001) Tj ET\n'
    const [out, removed] = stripWatermarkBlocks(src)
    expect(removed).toBe(1)
    expect(out).not.toContain('Watermark')
    expect(out).not.toContain('/WM Do')
    expect(out).toContain('10 10 m 20 20 l S')
    expect(out).toContain('(R1001) Tj')
  })

  it('块内有嵌套 BDC/EMC 时按深度正确闭合（保留块外内容）', () => {
    const src =
      'q\n' +
      '/Artifact <</Subtype/Watermark/Type/Pagination>>BDC\n' +
      '/Span <</Lang(zh)>>BDC\nq /WM Do Q\nEMC\nQ\nEMC\n' +
      'BT (keep) Tj ET\n'
    const [out, removed] = stripWatermarkBlocks(src)
    expect(removed).toBe(1)
    expect(out).not.toContain('Watermark')
    expect(out).not.toContain('/WM Do')
    // 块外的 q 与文字必须保留
    expect(out.replace(/\s+/g, ' ').trim()).toBe('q BT (keep) Tj ET')
  })

  it('多页/多水印块全部删除', () => {
    const block = '/Artifact <</Subtype/Watermark/Type/Pagination>>BDC\nq /WM Do Q\nEMC\n'
    const [out, removed] = stripWatermarkBlocks(`A\n${block}B\n${block}C\n`)
    expect(removed).toBe(2)
    expect(out.replace(/\s+/g, '')).toBe('ABC')
  })

  it('不含水印时原样返回', () => {
    const src = 'q 1 0 0 1 0 0 cm 10 10 m 20 20 l S Q\nBT (x) Tj ET\n'
    const [out, removed] = stripWatermarkBlocks(src)
    expect(removed).toBe(0)
    expect(out).toBe(src)
  })
})

describe('removePdfWatermark（合成夹具）', () => {
  it('删除水印块并清理水印 XObject 与图层引用', async () => {
    const input = await buildWatermarkedFixture()
    const { bytes, report } = await removePdfWatermark(input, { fileName: 'watermarked.pdf' })

    expect(report.totalRemoved).toBe(1)
    expect(report.pages[0].removed).toBe(1)
    expect(report.pages[0].leftoverRefs).toBe(0)
    expect(report.cleanedXObjects).toContain('KSPX1')
    expect(report.droppedOCProperties).toBe(true)

    const texts = (await pageContentTexts(bytes)).join('')
    expect(texts).not.toContain('Watermark')
    expect(texts).not.toContain('/KSPX1 Do')

    const doc = await PDFDocument.load(bytes)
    const xobjects = doc.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'), PDFDict)
    expect(xobjects?.has(PDFName.of('KSPX1')) ?? false).toBe(false)
    expect(doc.catalog.get(PDFName.of('OCProperties'))).toBeUndefined()
  })

  it('不含水印的 PDF 输出与输入字节完全一致（不误改）', async () => {
    const input = await buildPlainFixture()
    const { bytes, report } = await removePdfWatermark(input)
    expect(report.totalRemoved).toBe(0)
    expect(report.pages.every((p) => !p.contentChanged)).toBe(true)
    expect(Buffer.from(bytes).equals(Buffer.from(input))).toBe(true)
  })
})

// 可选真实样本：用环境变量 SAMPLE_PDF 指定文件；未设置或文件不存在则整组跳过。
const REAL_PDF = process.env.SAMPLE_PDF ?? ''
const hasReal = REAL_PDF !== '' && fs.existsSync(REAL_PDF)

describe.skipIf(!hasReal)('removePdfWatermark（真实样本）', () => {
  it('水印全部删除，文字层与绘图保留', async () => {
    const input = new Uint8Array(fs.readFileSync(REAL_PDF))
    const { bytes, report } = await removePdfWatermark(input, { fileName: path.basename(REAL_PDF) })

    expect(report.pages.length).toBeGreaterThan(0)
    expect(report.totalRemoved).toBeGreaterThan(0)
    for (const p of report.pages) {
      expect(p.removed).toBeGreaterThan(0)
      expect(p.leftoverRefs).toBe(0)
    }

    const texts = await pageContentTexts(bytes)
    for (const t of texts) {
      expect(t).not.toContain('Watermark')
      expect(t).not.toContain('/KSPX')
      // 原有标记内容块应全部消失
      expect(t).not.toContain('BDC')
    }
  })
})
