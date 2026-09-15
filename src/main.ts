/**
 * 页面逻辑：选择/拖入 PDF → 浏览器内去水印 → 前后对比预览 → 下载。
 * 每个文件的处理结果都带上结构化报告（删了哪些水印块、资源清理情况）。
 */
import './style.css'
import { removePdfWatermark, type Report } from './pdf/removeWatermark'
import { renderPdfPageToDataUrl } from './preview'

const REPO_URL = import.meta.env.VITE_REPO_URL ?? 'https://github.com/'

interface Job {
  file: File
  originalBytes: Uint8Array
  outputBytes?: Uint8Array
  report?: Report
  error?: string
}

const dropZone = document.getElementById('dropZone') as HTMLDivElement
const fileInput = document.getElementById('fileInput') as HTMLInputElement
const browseBtn = document.getElementById('browseBtn') as HTMLButtonElement
const results = document.getElementById('results') as HTMLElement
const repoLink = document.getElementById('repoLink') as HTMLAnchorElement

repoLink.href = REPO_URL

const jobs: Job[] = []

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function outputName(name: string): string {
  return name.toLowerCase().endsWith('.pdf') ? `${name.slice(0, -4)}_去水印.pdf` : `${name}_去水印.pdf`
}

function splitRatioOf(report: Report): number {
  const before = report.pages.reduce((s, p) => s + p.bytesBefore, 0)
  const after = report.pages.reduce((s, p) => s + p.bytesAfter, 0)
  return before === 0 ? 0 : 1 - after / before
}

/* ---------------------------------- 选择文件 --------------------------------- */

browseBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  fileInput.click()
})

dropZone.addEventListener('click', () => fileInput.click())

fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) void handleFiles([...fileInput.files])
  fileInput.value = ''
})

for (const type of ['dragenter', 'dragover'] as const) {
  dropZone.addEventListener(type, (e) => {
    e.preventDefault()
    dropZone.classList.add('dragover')
  })
}

for (const type of ['dragleave', 'drop'] as const) {
  dropZone.addEventListener(type, (e) => {
    e.preventDefault()
    dropZone.classList.remove('dragover')
  })
}

dropZone.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files ?? [])].filter(
    (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'),
  )
  if (files.length) void handleFiles(files)
})

/* ---------------------------------- 处理流程 --------------------------------- */

async function handleFiles(files: File[]): Promise<void> {
  dropZone.classList.add('busy')
  for (const file of files) {
    const job: Job = { file, originalBytes: new Uint8Array(await file.arrayBuffer()) }
    jobs.unshift(job)
    const placeholder = renderShell(job)
    try {
      const { bytes, report } = await removePdfWatermark(job.originalBytes, { fileName: file.name })
      job.outputBytes = bytes
      job.report = report
      await fillResult(placeholder, job)
    } catch (err) {
      job.error = err instanceof Error ? err.message : String(err)
      fillError(placeholder, job)
    }
  }
  dropZone.classList.remove('busy')
}

function renderShell(job: Job): HTMLElement {
  const card = document.createElement('section')
  card.className = 'card'
  card.innerHTML = `
    <div class="result-head">
      <div>
        <div class="file-name">${escapeHtml(job.file.name)}</div>
        <div class="toolbar"><span>原始大小 ${formatBytes(job.file.size)}</span></div>
      </div>
      <span class="badge warn" data-role="status">处理中…</span>
    </div>
    <div data-role="body"></div>`
  results.prepend(card)
  return card
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function fillError(card: HTMLElement, job: Job): void {
  const status = card.querySelector('[data-role="status"]') as HTMLElement
  status.className = 'badge err'
  status.textContent = '处理失败'
  const body = card.querySelector('[data-role="body"]') as HTMLElement
  body.innerHTML = `<p class="toolbar">${escapeHtml(job.error ?? '未知错误')}</p>`
}

async function fillResult(card: HTMLElement, job: Job): Promise<void> {
  const report = job.report as Report
  const status = card.querySelector('[data-role="status"]') as HTMLElement
  const body = card.querySelector('[data-role="body"]') as HTMLElement
  const total = report.pages.length
  const pagesWithWatermark = report.pages.filter((p) => p.removed > 0).length

  if (report.totalRemoved === 0) {
    status.className = 'badge warn'
    status.textContent = '未发现可删除的水印'
  } else {
    status.className = 'badge ok'
    status.textContent = `已移除 ${report.totalRemoved} 处水印`
  }

  // 下载链接
  const blob = new Blob([job.outputBytes as BlobPart], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)

  body.innerHTML = `
    <div class="result-head" style="margin-top:12px">
      <div class="toolbar">
        <span>输出 ${formatBytes(report.outputBytes)}</span>
        <span>·</span>
        <span>${total} 页${pagesWithWatermark ? `，其中 ${pagesWithWatermark} 页含水印` : ''}</span>
        <span>·</span>
        <span>耗时 ${report.elapsedMs} ms</span>
      </div>
      <a class="btn" download="${escapeHtml(outputName(job.file.name))}" href="${url}">下载去水印 PDF</a>
    </div>
    <div class="toolbar" style="margin-top:12px">
      <label>预览页：<select data-role="pageSel"></select></label>
      <label>分割线：<input type="range" min="0" max="100" value="50" data-role="split" /></label>
      <span>左=处理前，右=处理后</span>
    </div>
    <div class="compare" data-role="compare" style="margin-top:8px">
      <img data-role="before" alt="处理前" />
      <div class="after-layer"><img data-role="after" alt="处理后" /></div>
      <span class="tag before">处理前</span>
      <span class="tag after">处理后</span>
      <div class="divider" data-role="divider"></div>
    </div>
    <details style="margin-top:12px">
      <summary>处理明细</summary>
      <table class="stat-table">
        <thead><tr><th>页</th><th>删除水印块</th><th>内容流字节</th><th>残留引用</th><th>备注</th></tr></thead>
        <tbody>
          ${report.pages
            .map(
              (p) => `<tr>
                <td>${p.page}</td>
                <td>${p.removed}</td>
                <td>${p.bytesBefore} → ${p.bytesAfter}</td>
                <td>${p.leftoverRefs}</td>
                <td>${p.skipped ? escapeHtml(p.skipped) : p.contentChanged ? '已改写内容流' : '未改动'}</td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>
      <p class="toolbar" style="margin-top:8px">
        清理水印资源：${report.cleanedXObjects.length ? escapeHtml(report.cleanedXObjects.join('、')) : '无'}
        ${report.droppedOCProperties ? '；已移除文件级图层目录 /OCProperties' : ''}
        ${report.gcObjectsRemoved > 0 ? `；已清理 ${report.gcObjectsRemoved} 个孤立对象（水印图层字典等）` : ''}
      </p>
    </details>`

  // 预览：处理前 / 处理后
  const pageSel = body.querySelector('[data-role="pageSel"]') as HTMLSelectElement
  for (let i = 1; i <= total; i++) {
    const opt = document.createElement('option')
    opt.value = String(i)
    opt.textContent = `第 ${i} 页`
    pageSel.append(opt)
  }
  const beforeImg = body.querySelector('[data-role="before"]') as HTMLImageElement
  const afterImg = body.querySelector('[data-role="after"]') as HTMLImageElement

  const renderPage = async (pageNumber: number) => {
    const [b, a] = await Promise.all([
      renderPdfPageToDataUrl(job.originalBytes, pageNumber),
      renderPdfPageToDataUrl(job.outputBytes as Uint8Array, pageNumber),
    ])
    beforeImg.src = b.url
    afterImg.src = a.url
  }
  pageSel.addEventListener('change', () => void renderPage(Number(pageSel.value)))
  await renderPage(1)

  // 分割线拖动
  const compare = body.querySelector('[data-role="compare"]') as HTMLElement
  const split = body.querySelector('[data-role="split"]') as HTMLInputElement
  const setSplit = (pct: number) => {
    const v = Math.max(0, Math.min(100, pct))
    compare.style.setProperty('--split', `${v}%`)
    split.value = String(Math.round(v))
  }
  split.addEventListener('input', () => setSplit(Number(split.value)))
  const dragTo = (clientX: number) => {
    const rect = compare.getBoundingClientRect()
    setSplit(((clientX - rect.left) / rect.width) * 100)
  }
  let dragging = false
  compare.addEventListener('pointerdown', (e) => {
    dragging = true
    compare.setPointerCapture(e.pointerId)
    dragTo(e.clientX)
  })
  compare.addEventListener('pointermove', (e) => {
    if (dragging) dragTo(e.clientX)
  })
  compare.addEventListener('pointerup', () => {
    dragging = false
  })
  setSplit(50)

  // 压缩比提示
  if (report.totalRemoved > 0) {
    const ratio = splitRatioOf(report)
    status.title = `内容流体积减少约 ${(ratio * 100).toFixed(1)}%`
  }
}
