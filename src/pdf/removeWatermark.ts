/**
 * PDF 水印移除核心逻辑（纯浏览器端，复用经 Python 版验证的算法）。
 *
 * 原理：这类 PDF（PADS/ClibPDF 输出、Adobe 加水印）的水印不是注释也不是背景图，
 * 而是页面内容流中的一段标记内容：
 *
 *   /Artifact <</Subtype/Watermark/Type/Pagination>> BDC
 *   q /KSPE4 gs 0.572 0.208 -0.208 0.572 116.387 309.721 cm
 *   /KSPX4 Do        % 水印 Form XObject，内含 “试用水印” JPEG
 *   Q EMC
 *
 * 本模块按嵌套深度精确删除 BDC..EMC，其余绘图、文字（含隐藏 OCR 文本层）、
 * 字体与图像资源全部保留，因此成品与原件渲染逐像素一致（差异仅抗锯齿噪声）。
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from 'pdf-lib'
import { garbageCollectPdf } from './gc'

/** 匹配水印标记内容的起始 BDC（允许 <</...>> BDC 之间有空白） */
const WATERMARK_BDC = /\/Artifact\s*<<[^>]*?\/Subtype\s*\/Watermark[^>]*?>>\s*BDC/g

const MARKED_CONTENT_OPS = new Set(['BDC', 'EMC', 'BMC'])

export interface PageResult {
  /** 第几页（从 1 开始） */
  page: number
  /** 删除的水印块数量 */
  removed: number
  /** 内容流字节数变化 */
  bytesBefore: number
  bytesAfter: number
  /** 该页内容流是否真的被改写（用于“无需处理即字节级不变”的验证） */
  contentChanged: boolean
  /** 删除水印后残留的可疑引用（应为 0） */
  leftoverRefs: number
  /** 是否跳过了该页（例如内容流过滤器不支持） */
  skipped?: string
}

export interface Report {
  fileName: string
  pages: PageResult[]
  totalRemoved: number
  /** 从资源字典中清除的水印 XObject 名 */
  cleanedXObjects: string[]
  /** 从图形资源中清除的水印图层（/OC）引用数量 */
  removedOCEntries: number
  /** 是否移除了文件级可选内容组目录（/OCProperties） */
  droppedOCProperties: boolean
  /** 通过可达性 GC 清理掉的孤立对象数量（水印图层字典、水印设置等） */
  gcObjectsRemoved: number
  /** 输出文件字节数 */
  outputBytes: number
  /** 耗时（毫秒） */
  elapsedMs: number
}

export interface RemoveResult {
  bytes: Uint8Array
  report: Report
}

/** 解码后的内容流文本 + 原始编码字节。无法安全解码时返回 null。 */
interface DecodedContent {
  /** 原始字节（latin1 视角的字符串，便于按字节做正则替换） */
  original: string
  /** 过滤器是否受支持（FlateDecode / 无过滤器） */
  supported: boolean
  filters: string[]
}

function filterNames(dict: PDFDict | undefined): string[] {
  const raw = dict?.get(PDFName.of('Filter'))
  if (!raw) return []
  const obj = raw instanceof PDFRef ? undefined : raw
  const asArray = obj instanceof PDFArray ? obj : null
  const names: string[] = []
  if (asArray) {
    for (let i = 0; i < asArray.size(); i++) names.push(String(asArray.get(i)))
  } else {
    names.push(String(raw))
  }
  return names.map((n) => n.replace(/^\//, ''))
}

/**
 * 取出内容流的解码字节（latin1 字符串形态，便于按字节做正则替换）。
 * pdf-lib 里 PDFRawStream / PDFContentStream 都保留原始字节 + Filter，
 * 因此统一走 decodePDFRawStream，行为与 Python 版 pymupdf.read_contents() 一致。
 */
export function decodeContentBytes(stream: PDFStream): Uint8Array {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode()
  const filters = filterNames(stream.dict)
  if (filters.length === 0) return stream.getContents()
  // 非原始流且带 Filter：用同一解码器（需构造等价的原始流）
  return decodePDFRawStream(PDFRawStream.of(stream.dict, stream.getContents())).decode()
}

function decodeContentStream(stream: PDFStream): DecodedContent {
  const filters = filterNames(stream.dict)
  try {
    return {
      original: BufferLikeToString(decodeContentBytes(stream)),
      supported: true,
      filters,
    }
  } catch {
    return { original: '', supported: false, filters }
  }
}

/** Uint8Array -> latin1 字符串（逐字节映射，保证替换后可无损还原） */
function BufferLikeToString(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let out = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length))) as unknown as number[],
    )
  }
  return out
}

function StringToBufferLike(str: string): Uint8Array {
  const out = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff
  return out
}

/**
 * 删除内容流中的全部水印标记内容块。
 * 返回 [新内容流, 删除块数]。与 Python 版逐 token 深度匹配逻辑一致。
 */
export function stripWatermarkBlocks(source: string): [string, number] {
  let out = ''
  let pos = 0
  let removed = 0
  WATERMARK_BDC.lastIndex = 0

  for (;;) {
    WATERMARK_BDC.lastIndex = pos
    const m = WATERMARK_BDC.exec(source)
    if (!m) {
      out += source.slice(pos)
      break
    }
    out += source.slice(pos, m.index)

    // 从 BDC 之后扫描 token，直到嵌套深度归零的 EMC
    let i = m.index + m[0].length
    let depth = 1
    while (i < source.length && depth > 0) {
      while (i < source.length && /\s/.test(source[i])) i++
      const op = source.slice(i, i + 3)
      if (MARKED_CONTENT_OPS.has(op)) {
        depth += op === 'EMC' ? -1 : 1
        i += 3
      } else {
        // 跳到下一个标记内容操作符
        let j = i
        for (;;) {
          if (j >= source.length) break
          const maybe = source.slice(j, j + 3)
          if (MARKED_CONTENT_OPS.has(maybe)) break
          j++
        }
        if (j >= source.length) {
          i = source.length
          break
        }
        i = j
      }
    }
    removed++
    pos = i
  }

  return [out, removed]
}

/** 从图形资源字典中删除水印图层引用（/OC），返回删除数量。 */
function dropOCEntries(resources: PDFDict | undefined): number {
  if (!(resources instanceof PDFDict)) return 0
  let dropped = 0
  for (const [key, value] of resources.entries()) {
    if (String(key) === '/OC') {
      resources.delete(key)
      dropped++
      continue
    }
    if (value instanceof PDFDict) dropped += dropOCEntries(value)
  }
  return dropped
}

export interface RemoveOptions {
  fileName?: string
  /** 额外按名删除的水印 XObject（默认 KSPX1..KSPX9） */
  watermarkXObjectPrefixes?: string[]
  /** 是否删除文件级可选内容组目录 /OCProperties（默认 true） */
  dropOCProperties?: boolean
  /** 是否做可达性 GC 清理孤立对象（默认 true） */
  garbageCollect?: boolean
}

/**
 * 移除 PDF 中的水印：按标记内容删除 + 清理水印资源。
 */
export async function removePdfWatermark(
  input: Uint8Array,
  options: RemoveOptions = {},
): Promise<RemoveResult> {
  const startedAt = Date.now()
  const prefixes = options.watermarkXObjectPrefixes ?? ['KSPX']
  const doc = await PDFDocument.load(input, { updateMetadata: false })
  const pages: PageResult[] = []
  const cleanedXObjects = new Set<string>()
  let totalRemoved = 0

  for (let i = 0; i < doc.getPageCount(); i++) {
    const page = doc.getPage(i)
    const contentsRef = page.node.get(PDFName.of('Contents'))
    const refs: PDFRef[] = []
    let lookup: unknown
    try {
      lookup = doc.context.lookup(contentsRef)
    } catch {
      lookup = undefined
    }
    if (lookup instanceof PDFArray) {
      for (let k = 0; k < lookup.size(); k++) {
        const r = lookup.get(k)
        if (r instanceof PDFRef) refs.push(r)
      }
    } else if (contentsRef instanceof PDFRef) {
      refs.push(contentsRef)
    }

    let pageRemoved = 0
    let bytesBefore = 0
    let bytesAfter = 0
    let leftoverRefs = 0
    let skipped: string | undefined
    let contentChanged = false

    for (const ref of refs) {
      // pdf-lib 的 lookupMaybe 遇到类型不符会抛异常，这里统一按“非内容流”跳过
      let stream: unknown
      try {
        stream = doc.context.lookupMaybe(ref, PDFStream)
      } catch {
        stream = undefined
      }
      if (!(stream instanceof PDFStream)) continue
      const decoded = decodeContentStream(stream)
      if (!decoded.supported) {
        skipped = `第 ${i + 1} 页内容流过滤器 [${decoded.filters.join(',')}] 不支持安全改写`
        continue
      }
      bytesBefore += decoded.original.length
      const [next, removed] = stripWatermarkBlocks(decoded.original)
      bytesAfter += next.length
      pageRemoved += removed
      if (removed > 0 && next !== decoded.original) {
        contentChanged = true
        doc.context.assign(ref, doc.context.flateStream(StringToBufferLike(next)))
      }
      leftoverRefs += (next.match(/\/KSPX\d/g) || []).length
    }

    // 清理该页资源中的水印 XObject
    const resources = page.node.Resources()
    const xobjects = resources?.lookup(PDFName.of('XObject'), PDFDict)
    if (xobjects instanceof PDFDict) {
      for (const key of [...xobjects.keys()]) {
        const name = String(key).replace(/^\//, '')
        if (prefixes.some((p) => name.startsWith(p))) {
          xobjects.delete(key as PDFName)
          cleanedXObjects.add(name)
        }
      }
    }

    totalRemoved += pageRemoved
    pages.push({
      page: i + 1,
      removed: pageRemoved,
      bytesBefore,
      bytesAfter,
      contentChanged,
      leftoverRefs,
      skipped,
    })
  }

  let removedOCEntries = 0
  for (let i = 0; i < doc.getPageCount(); i++) {
    removedOCEntries += dropOCEntries(doc.getPage(i).node.Resources())
  }
  let droppedOCProperties = false
  if (options.dropOCProperties !== false && doc.catalog.get(PDFName.of('OCProperties'))) {
    doc.catalog.delete(PDFName.of('OCProperties'))
    droppedOCProperties = true
  }

  let bytes = await doc.save({ useObjectStreams: false, addDefaultPage: false })

  // pdf-lib 会把不可达的孤立对象（水印图层字典、/PieceInfo 水印设置等）一并写回，
  // 导致文件几乎不变小；这里做一次可达性 GC。失败则原样回退，绝不影响正确性。
  let gcObjectsRemoved = 0
  if (options.garbageCollect !== false) {
    try {
      const gc = garbageCollectPdf(bytes)
      // 只有在确实清理了对象且体积未变大的情况下才采用
      if (gc.objectsAfter < gc.objectsBefore && gc.bytes.length <= bytes.length * 1.05) {
        gcObjectsRemoved = gc.objectsBefore - gc.objectsAfter
        bytes = gc.bytes
      }
    } catch (err) {
      console.warn('可达性 GC 未生效，输出保留孤立对象：', err)
      gcObjectsRemoved = 0
    }
  }

  const report: Report = {
    fileName: options.fileName ?? 'document.pdf',
    pages,
    totalRemoved,
    cleanedXObjects: [...cleanedXObjects],
    removedOCEntries,
    droppedOCProperties,
    gcObjectsRemoved,
    outputBytes: bytes.length,
    elapsedMs: Date.now() - startedAt,
  }

  return { bytes, report }
}
