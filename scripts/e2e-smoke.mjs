/**
 * 浏览器端到端冒烟测试（CDP 驱动，无需额外依赖）：
 *   1) 启动本地静态服务托管 dist/（或用 --site 指定线上地址）
 *   2) 用 Edge/Chrome 无头模式打开页面
 *   3) 通过 DOM 注入 PDF 并触发选择事件
 *   4) 等待处理完成，校验报告与预览图，并把页面产出的 PDF 取回落盘
 *
 * 用法：node scripts/e2e-smoke.mjs <样本.pdf> [输出.pdf] [--site <url>] [--headful]
 *   样本路径必须显式提供（仓库内不保存任何真实图纸）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const dist = path.join(root, 'dist')

const pdfPath = process.argv[2]
if (!pdfPath) {
  console.error('用法：node scripts/e2e-smoke.mjs <样本.pdf> [输出.pdf] [--site <url>] [--headful]')
  process.exit(2)
}
if (!fs.existsSync(pdfPath)) {
  console.error(`样本不存在：${pdfPath}`)
  process.exit(2)
}
const outPath = process.argv[3] ?? path.join(root, 'e2e-output.pdf')
const headful = process.argv.includes('--headful')
// --site <url>：直接测线上地址（例如 GitHub Pages），不再启动本地静态服务
const siteArgIdx = process.argv.indexOf('--site')
const siteOverride = siteArgIdx >= 0 ? process.argv[siteArgIdx + 1] : null

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
]
const browserPath = BROWSERS.find((p) => p && fs.existsSync(p))
if (!browserPath) {
  console.error('[e2e] 未找到 Edge/Chrome')
  process.exit(2)
}

/* ------------------------------ 静态服务器 ------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  const file = path.join(dist, rel)
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found')
    return
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const siteUrl = siteOverride ?? `http://127.0.0.1:${port}/`
console.log('[e2e] 站点:', siteUrl, siteOverride ? '(线上地址)' : '(本地 dist)')

/* ------------------------------ 启动浏览器 ------------------------------ */
const userDataDir = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'pdfwm-e2e-'))
const args = [
  '--remote-debugging-port=0',
  `--user-data-dir=${userDataDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--allow-file-access-from-files',
  'about:blank',
]
if (!headful) args.unshift('--headless=new')

const browser = spawn(browserPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
browser.stderr.on('data', (d) => (stderr += d.toString()))

const wsEndpoint = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('等待 DevTools 端口超时\n' + stderr)), 20000)
  browser.stderr.on('data', (chunk) => {
    const m = /ws:\/\/[^\s]+/.exec(chunk.toString())
    if (m) {
      clearTimeout(timer)
      resolve(m[0])
    }
  })
  browser.on('exit', (code) => reject(new Error(`浏览器提前退出 code=${code}\n${stderr}`)))
})

/* ------------------------------ CDP 客户端 ------------------------------ */
const ws = new WebSocket(wsEndpoint)
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true })
  ws.addEventListener('error', j, { once: true })
})

let msgId = 0
const pending = new Map()
const events = []
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  } else if (msg.method) {
    events.push(msg)
  }
})

function send(method, params = {}, sessionId) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params, sessionId }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`CDP 超时: ${method}`))
      }
    }, 60000)
  })
}

// 新建 target 并附加
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const call = (method, params) => send(method, params, sessionId)

await call('Runtime.enable')
await call('Log.enable')
await call('Page.enable')

const consoleErrors = []
const pageExceptions = []
const netFailures = []
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    consoleErrors.push(msg.params.entry.text)
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageExceptions.push(msg.params.exceptionDetails?.exception?.description ?? 'unknown')
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '))
  }
  if (msg.method === 'Network.loadingFailed') {
    netFailures.push(`${msg.params.type} ${msg.params.errorText}`)
  }
})

await call('Network.enable')

const evaluate = async (expression, awaitPromise = true) => {
  const r = await call('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (r.exceptionDetails) {
    throw new Error('页面脚本异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails))
  }
  return r.result.value
}

await call('Page.navigate', { url: siteUrl })

// 等应用脚本就绪（模块可能较大；main.ts 就绪后会把 repoLink 的 href 从 '#' 改成仓库地址）
const waitAppReady = async () => {
  for (let i = 0; i < 120; i++) {
    const r = await evaluate(
      `({ href: document.getElementById('repoLink')?.getAttribute('href') ?? '', input: !!document.getElementById('fileInput') })`,
    )
    if (r.input && r.href && r.href !== '#') return r
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('等待应用脚本就绪超时（JS 未加载或执行失败）')
}
const appReady = await waitAppReady()
console.log('[e2e] 应用就绪:', JSON.stringify(appReady))

const title = await evaluate('document.title')
console.log('[e2e] 页面标题:', title)

/* --------------------------- 注入真实 PDF 并处理 --------------------------- */
const pdfBase64 = fs.readFileSync(pdfPath).toString('base64')
console.log('[e2e] 样本:', path.basename(pdfPath), fs.statSync(pdfPath).size, '字节')

await evaluate(`
  (async () => {
    const bin = atob(${JSON.stringify(pdfBase64)});
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], ${JSON.stringify(path.basename(pdfPath))}, { type: 'application/pdf' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()
`)

// 等待处理完成：徽标不再是“处理中…”
const waitBadge = async () => {
  for (let i = 0; i < 240; i++) {
    const txt = await evaluate(`(document.querySelector('[data-role="status"]')?.textContent ?? '')`)
    if (txt && txt !== '处理中…') return txt
    if (i > 0 && i % 20 === 0) {
      const diag = await evaluate(
        `({ cards: document.querySelectorAll('#results .card').length, ready: document.readyState })`,
      )
      console.log(`[e2e] 等待中… ${JSON.stringify(diag)} 网络失败=${netFailures.length}`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  console.log('[e2e] 控制台错误:', consoleErrors)
  console.log('[e2e] 页面异常:', pageExceptions)
  console.log('[e2e] 网络失败:', netFailures.slice(0, 10))
  throw new Error('等待处理结果超时')
}

const badge = await waitBadge()
console.log('[e2e] 结果徽标:', badge)

// 预览图是异步渲染的（pdf.js worker），等它们真正解码完成
const waitImages = async () => {
  for (let i = 0; i < 60; i++) {
    const ready = await evaluate(`
      (() => {
        const b = document.querySelector('[data-role="before"]');
        const a = document.querySelector('[data-role="after"]');
        return { b: !!b && b.naturalWidth > 0, a: !!a && a.naturalWidth > 0,
                 bSrc: (b?.src ?? '').slice(0, 24), aSrc: (a?.src ?? '').slice(0, 24) };
      })()
    `)
    if (ready.b && ready.a) return ready
    if (i === 59) return ready
    await new Promise((r) => setTimeout(r, 500))
  }
}
const imgReady = await waitImages()
console.log('[e2e] 预览图:', JSON.stringify(imgReady))

const summary = await evaluate(`
  (() => {
    const card = document.querySelector('#results .card');
    const link = card?.querySelector('a.btn');
    const before = card?.querySelector('[data-role="before"]');
    const after = card?.querySelector('[data-role="after"]');
    const rows = [...(card?.querySelectorAll('.stat-table tbody tr') ?? [])].map(tr =>
      [...tr.children].map(td => td.textContent.trim()));
    return {
      downloadName: link?.getAttribute('download') ?? null,
      hasBlobUrl: (link?.getAttribute('href') ?? '').startsWith('blob:'),
      beforeReady: !!before && before.naturalWidth > 0,
      afterReady: !!after && after.naturalWidth > 0,
      beforeSize: before ? [before.naturalWidth, before.naturalHeight] : null,
      afterSize: after ? [after.naturalWidth, after.naturalHeight] : null,
      rows,
      detailsText: card?.querySelector('details p.toolbar')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    };
  })()
`)
console.log('[e2e] 页面摘要:', JSON.stringify(summary, null, 1))

// 取回页面生成的 PDF（blob -> base64）
const outBase64 = await evaluate(`
  (async () => {
    const link = document.querySelector('#results .card a.btn');
    const buf = await (await fetch(link.href)).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  })()
`)
fs.writeFileSync(outPath, Buffer.from(outBase64, 'base64'))
console.log('[e2e] 已保存页面产出:', outPath, fs.statSync(outPath).size, '字节')

// 页面里再跑一次「无残留」断言
const pageAssert = await evaluate(`
  (async () => {
    const link = document.querySelector('#results .card a.btn');
    const buf = await (await fetch(link.href)).arrayBuffer();
    const txt = new TextDecoder('latin1').decode(new Uint8Array(buf));
    return { hasWatermark: txt.includes('Watermark'), hasKSPX: txt.includes('/KSPX') };
  })()
`)
console.log('[e2e] 页内字节断言:', JSON.stringify(pageAssert))

const ok =
  badge.includes('已移除') &&
  summary.hasBlobUrl &&
  summary.beforeReady &&
  summary.afterReady &&
  !pageAssert.hasWatermark &&
  !pageAssert.hasKSPX
console.log(ok ? '[e2e] 通过' : '[e2e] 失败')
if (consoleErrors.length) console.log('[e2e] 控制台错误:', consoleErrors)

/* -------------------------------- 收尾 -------------------------------- */
ws.close()
const exited = new Promise((r) => browser.once('exit', r))
browser.kill()
await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
server.close()
// 浏览器 profile 目录可能仍被占用，清理失败不影响结论
try {
  fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 })
} catch {
  console.log('[e2e] 临时 profile 未清理（被占用）:', userDataDir)
}
process.exit(ok ? 0 : 1)
