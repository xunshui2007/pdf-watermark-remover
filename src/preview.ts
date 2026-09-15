/**
 * 用 pdf.js 把指定页渲染到 canvas，用于「处理前 / 处理后」对比预览。
 * 预览只是为了直观验收，实际去水印走 src/pdf/removeWatermark.ts（pdf-lib）。
 */
import * as pdfjs from 'pdfjs-dist'

// worker 由站点自身托管（构建时复制到根目录，配合 base:'./' 支持子路径部署）
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', document.baseURI).href

export interface RenderedPage {
  canvas: HTMLCanvasElement
  pageNumber: number
  totalPages: number
  width: number
  height: number
}

/**
 * 渲染 PDF 的第 pageNumber 页（1 起）到新 canvas。
 * @param maxWidth 目标显示宽度（CSS 像素），按此计算缩放比
 */
export async function renderPdfPage(
  bytes: Uint8Array,
  pageNumber = 1,
  maxWidth = 760,
  dpr = Math.min(window.devicePixelRatio || 1, 2),
): Promise<RenderedPage> {
  // pdf.js 会转移传入的 buffer，这里必须复制，避免影响后续处理
  const data = bytes.slice()
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise
  try {
    const page = await doc.getPage(Math.min(Math.max(pageNumber, 1), doc.numPages))
    const base = page.getViewport({ scale: 1 })
    const scale = Math.max(0.2, Math.min(maxWidth / base.width, 4))
    const viewport = page.getViewport({ scale: scale * dpr })
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    canvas.style.width = `${Math.floor(viewport.width / dpr)}px`
    canvas.style.height = `${Math.floor(viewport.height / dpr)}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法获取 2D 绘图上下文')
    await page.render({ canvasContext: ctx, viewport }).promise
    return {
      canvas,
      pageNumber: page.pageNumber,
      totalPages: doc.numPages,
      width: viewport.width,
      height: viewport.height,
    }
  } finally {
    await doc.destroy()
  }
}

/** 渲染成 objectURL 形式的 PNG，便于 <img> 展示与对比 */
export async function renderPdfPageToDataUrl(
  bytes: Uint8Array,
  pageNumber = 1,
  maxWidth = 760,
): Promise<{ url: string; pageNumber: number; totalPages: number }> {
  const rendered = await renderPdfPage(bytes, pageNumber, maxWidth)
  return {
    url: rendered.canvas.toDataURL('image/png'),
    pageNumber: rendered.pageNumber,
    totalPages: rendered.totalPages,
  }
}
