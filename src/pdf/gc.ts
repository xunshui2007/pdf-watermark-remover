/**
 * 极简 PDF 可达性垃圾回收：
 *
 * pdf-lib 保存时会把它解析到的所有间接对象原样写回，包括已经没有引用的
 * 孤立对象（例如水印图层字典 /OCG、Adobe 的 /PieceInfo 水印设置、被删除的
 * 水印 XObject）。这些对象不产生可见内容，但会留在文件里，导致
 * 「去水印后文件几乎没变小」以及「搜 Watermark 还能搜到」。
 *
 * 这里对序列化后的字节做一次解析：
 *   1) 扫描所有 `N 0 obj ... endobj`，记录对象体（含流数据的原始字节区间）；
 *   2) 从 /Root（以及 /Info）出发，递归遍历所有引用；
 *   3) 只保留可达对象，重新编号并重写 xref / trailer。
 *
 * 任何解析上的意外都会让调用方回退到原字节，避免产出损坏文件。
 */

export interface GcResult {
  bytes: Uint8Array
  objectsBefore: number
  objectsAfter: number
}

interface RawObject {
  num: number
  /** 对象体（`<<...>>` 或流对象头），不含流数据 */
  body: string
  /** 流数据原始字节区间（未解码） */
  streamStart?: number
  streamEnd?: number
}

const OBJ_HEAD = /(\d+)\s+(\d+)\s+obj\b/g

function latin1(bytes: Uint8Array): string {
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

/** 从 `stream` 关键字后找到流数据区间（支持 /Length 为数字的常规情况） */
function findStreamRange(
  text: string,
  bodyEnd: number,
  dictText: string,
): { start: number; end: number } | undefined {
  if (!/\bstream\b/.test(text.slice(bodyEnd, bodyEnd + 32))) return undefined
  const sIdx = text.indexOf('stream', bodyEnd)
  if (sIdx < 0) return undefined
  let start = sIdx + 'stream'.length
  if (text[start] === '\r') start++
  if (text[start] === '\n') start++
  const eIdx = text.indexOf('endstream', start)
  if (eIdx < 0) return undefined
  // 以 endstream 前一个换行为流数据结束（PDF 允许，稳妥做法）
  let end = eIdx
  if (text[end - 1] === '\n') end--
  if (text[end - 1] === '\r') end--

  // 若 /Length 是可解析的数字，优先按它裁剪
  const lm = /\/Length\s+(\d+)/.exec(dictText)
  if (lm) {
    const len = Number(lm[1])
    if (Number.isFinite(len) && start + len <= eIdx) return { start, end: start + len }
  }
  return { start, end }
}

function parseObjects(text: string): RawObject[] {
  const objs: RawObject[] = []
  OBJ_HEAD.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = OBJ_HEAD.exec(text))) {
    const num = Number(m[1])
    // 排除 xref 流里出现的 "N 0 obj"（xref 流内容也在压缩数据里，不会以明文出现）
    const bodyStart = m.index + m[0].length
    const endIdx = text.indexOf('endobj', bodyStart)
    if (endIdx < 0) continue
    const stream = findStreamRange(text, bodyStart, text.slice(bodyStart, endIdx))
    const body = text.slice(bodyStart, stream ? text.indexOf('stream', bodyStart) : endIdx)
    objs.push({ num, body, streamStart: stream?.start, streamEnd: stream?.end })
    OBJ_HEAD.lastIndex = stream ? stream.end : endIdx
  }
  return objs
}

const REF_RE = /(\d+)\s+(\d+)\s+R\b/g

/** 收集一段文本中引用的对象号 */
function collectRefs(text: string, into: Set<number>): void {
  REF_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = REF_RE.exec(text))) into.add(Number(m[1]))
}

export function garbageCollectPdf(input: Uint8Array): GcResult {
  const text = latin1(input)
  const objects = parseObjects(text)
  if (objects.length === 0) throw new Error('未解析到任何间接对象')

  const byNum = new Map<number, RawObject>()
  for (const o of objects) if (!byNum.has(o.num)) byNum.set(o.num, o)

  // 找 trailer / Root
  const trailerIdx = text.lastIndexOf('trailer')
  const trailer = trailerIdx >= 0 ? text.slice(trailerIdx, trailerIdx + 4000) : text
  const rootM = /\/Root\s+(\d+)\s+\d+\s+R/.exec(trailer)
  if (!rootM) throw new Error('未找到 trailer /Root')
  const infoM = /\/Info\s+(\d+)\s+\d+\s+R/.exec(trailer)

  // 可达性遍历
  const reachable = new Set<number>()
  const queue: number[] = [Number(rootM[1])]
  if (infoM) queue.push(Number(infoM[1]))
  while (queue.length) {
    const num = queue.pop() as number
    if (reachable.has(num)) continue
    const obj = byNum.get(num)
    if (!obj) continue
    reachable.add(num)
    const refs = new Set<number>()
    collectRefs(obj.body, refs)
    if (obj.streamStart !== undefined && obj.streamEnd !== undefined) {
      // 流内容不解析引用（压缩数据里不会出现真实对象号）
    }
    for (const r of refs) if (!reachable.has(r)) queue.push(r)
  }

  // 重新编号并写出
  const sorted = [...reachable].sort((a, b) => a - b)
  const newNum = new Map<number, number>()
  sorted.forEach((old, i) => newNum.set(old, i + 1))

  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let cursor = 0
  const push = (data: Uint8Array | string) => {
    const buf = typeof data === 'string' ? latin1ToBytes(data) : data
    chunks.push(buf)
    cursor += buf.length
  }

  push('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')

  for (const old of sorted) {
    const obj = byNum.get(old) as RawObject
    offsets[newNum.get(old) as number] = cursor
    // 重写对象体里的引用编号
    const rewritten = obj.body.replace(REF_RE, (whole, a: string) => {
      const target = newNum.get(Number(a))
      return target === undefined ? whole : `${target} 0 R`
    })
    push(`${newNum.get(old)} 0 obj\n${rewritten.trim()}\n`)
    if (obj.streamStart !== undefined && obj.streamEnd !== undefined) {
      push('stream\n')
      push(input.subarray(obj.streamStart, obj.streamEnd))
      push('\nendstream\n')
    }
    push('endobj\n')
  }

  const xrefOffset = cursor
  const count = sorted.length + 1
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`
  for (let i = 1; i < count; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  const rootNew = newNum.get(Number(rootM[1])) as number
  const infoNew = infoM ? newNum.get(Number(infoM[1])) : undefined
  xref += `trailer\n<< /Size ${count} /Root ${rootNew} 0 R${infoNew ? ` /Info ${infoNew} 0 R` : ''} >>\n`
  xref += `startxref\n${xrefOffset}\n%%EOF\n`
  push(xref)

  const total = chunks.reduce((s, c) => s + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return { bytes: out, objectsBefore: objects.length, objectsAfter: sorted.length }
}

function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}
