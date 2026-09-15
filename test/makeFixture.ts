/**
 * 生成“带水印样例 PDF”作为自动化测试夹具（与现场 PDF 同构：
 * 内容流里带 Watermark 标记内容 + 水印 Form XObject + Watermark 图层）。
 */
import { PDFArray, PDFDocument, PDFName, PDFStream, StandardFonts, rgb } from 'pdf-lib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeContentBytes } from '../src/pdf/removeWatermark'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, 'fixtures')

export async function buildWatermarkedFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([595, 842])
  const font = await doc.embedFont(StandardFonts.Helvetica)

  // 基础图形与文字（这些必须在水印被删除后完整保留）
  page.drawRectangle({ x: 60, y: 60, width: 200, height: 120, borderColor: rgb(0.8, 0.2, 0.2), borderWidth: 1 })
  page.drawText('R1001 C2002 U3003', { x: 60, y: 700, size: 14, font })
  // 取出 pdf-lib 刚生成的页面内容操作符（Contents 是 [流引用] 的数组）
  const built = page.node.Contents()
  let baseContent = ''
  const collect = (s: unknown) => {
    if (s instanceof PDFStream) baseContent += Buffer.from(decodeContentBytes(s)).toString('latin1')
  }
  if (built instanceof PDFArray) {
    for (let i = 0; i < built.size(); i++) collect(doc.context.lookup(built.get(i)))
  } else {
    collect(built)
  }
  // 文字经子集字体编码为十六进制，故这里只校验存在文字绘制操作符
  if (!baseContent.includes('BT') || !baseContent.includes('Tj')) {
    throw new Error(
      `夹具基础内容生成失败（${baseContent.length} 字节）：${JSON.stringify(baseContent.slice(0, 200))}`,
    )
  }

  // 水印图像：1x1 红色像素（用 Flate 原始位图，避免依赖合法 JPEG 编码）
  const imgData = new Uint8Array([255, 0, 0])
  const imgStream = doc.context.flateStream(imgData, {
    Type: 'XObject',
    Subtype: 'Image',
    Width: 1,
    Height: 1,
    ColorSpace: 'DeviceRGB',
    BitsPerComponent: 8,
  })
  const imgRef = doc.context.register(imgStream)

  // 水印：Form XObject + 可选内容组
  const wmForm = doc.context.flateStream('q\n684 0 0 140 0 0 cm\n/WMIMG Do\nQ\n', {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, 684, 140],
    Resources: doc.context.obj({ XObject: { WMIMG: imgRef } }),
  })
  const wmFormRef = doc.context.register(wmForm)
  const ocg = doc.context.obj({ Type: 'OCG', Name: 'Watermark' })
  const ocgRef = doc.context.register(ocg)
  wmForm.dict.set(PDFName.of('OC'), ocgRef)

  page.node.setXObject(PDFName.of('KSPX1'), wmFormRef)
  doc.catalog.set(
    PDFName.of('OCProperties'),
    doc.context.obj({ OCGs: [ocgRef], D: { ON: [ocgRef] } }),
  )

  // 在页面内容流末尾追加水印标记内容（含嵌套 q/Q，模拟真实结构）
  const wmOps =
    '\n/Artifact <</Subtype/Watermark/Type/Pagination>>BDC\n' +
    'q\n0.572196 0.208262 -0.208262 0.572196 116.387360 309.720612 cm\n/KSPX1 Do\nQ\nEMC\n'
  // 注意：必须用 flateStream 造内容流；context.obj(string) 只会生成 PDFName
  const content = doc.context.flateStream(`${baseContent}${wmOps}`)
  const contentRef = doc.context.register(content)
  page.node.set(PDFName.of('Contents'), contentRef)

  return doc.save({ useObjectStreams: false })
}

/** 生成一个不含任何水印的普通 PDF（用于验证“不误改”） */
export async function buildPlainFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([300, 200])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('plain document, no watermark', { x: 20, y: 160, size: 12, font })
  page.drawRectangle({ x: 20, y: 40, width: 100, height: 60, borderWidth: 1 })
  return doc.save({ useObjectStreams: false })
}

if (process.argv[1] && process.argv[1].endsWith('makeFixture.ts')) {
  fs.mkdirSync(outDir, { recursive: true })
  const wm = await buildWatermarkedFixture()
  const plain = await buildPlainFixture()
  fs.writeFileSync(path.join(outDir, 'watermarked.pdf'), wm)
  fs.writeFileSync(path.join(outDir, 'plain.pdf'), plain)
  console.log('fixtures written:', wm.length, plain.length)
}
