/**
 * 打开指定 URL、注入可选 PDF、截图保存（CDP，无额外依赖）。
 * 用法：node scripts/shot.mjs <url> <输出.png> [pdf路径]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const url = process.argv[2]
const outPng = process.argv[3]
const pdfPath = process.argv[4]

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
]
const browserPath = BROWSERS.find((p) => p && fs.existsSync(p))
const userDataDir = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'pdfwm-shot-'))

const browser = spawn(
  browserPath,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,1500',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)

const wsEndpoint = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('DevTools 端口超时')), 20000)
  browser.stderr.on('data', (c) => {
    const m = /ws:\/\/[^\s]+/.exec(c.toString())
    if (m) {
      clearTimeout(t)
      resolve(m[0])
    }
  })
})

const ws = new WebSocket(wsEndpoint)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
  }
})
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const myId = ++id
    pending.set(myId, { resolve, reject })
    ws.send(JSON.stringify({ id: myId, method, params, sessionId }))
    setTimeout(() => pending.has(myId) && (pending.delete(myId), reject(new Error('CDP 超时 ' + method))), 60000)
  })

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const call = (m, p) => send(m, p, sessionId)
await call('Page.enable')
await call('Runtime.enable')
await call('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 1200,
  deviceScaleFactor: 1,
  mobile: false,
})
await call('Page.navigate', { url })
await new Promise((r) => setTimeout(r, 1500))

if (pdfPath) {
  const b64 = fs.readFileSync(pdfPath).toString('base64')
  await call('Runtime.evaluate', {
    expression: `(async () => {
      const bin = atob(${JSON.stringify(b64)});
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([arr], ${JSON.stringify(path.basename(pdfPath))}, { type: 'application/pdf' }));
      const input = document.getElementById('fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  // 等处理 + 预览渲染
  for (let i = 0; i < 90; i++) {
    const r = await call('Runtime.evaluate', {
      expression: `(() => {
        const b = document.querySelector('[data-role="before"]');
        const a = document.querySelector('[data-role="after"]');
        const s = document.querySelector('[data-role="status"]');
        return { ready: !!b && b.naturalWidth > 0 && !!a && a.naturalWidth > 0, status: s?.textContent ?? '' };
      })()`,
      returnByValue: true,
    })
    if (r.result.value.ready) break
    await new Promise((r) => setTimeout(r, 500))
  }
  await call('Runtime.evaluate', { expression: `document.querySelector('#results').scrollIntoView()`, awaitPromise: true })
  await new Promise((r) => setTimeout(r, 400))
}

const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
fs.writeFileSync(outPng, Buffer.from(shot.data, 'base64'))
console.log('saved', outPng, fs.statSync(outPng).size, '字节')

ws.close()
const exited = new Promise((r) => browser.once('exit', r))
browser.kill()
await Promise.race([exited, new Promise((r) => setTimeout(r, 4000))])
try {
  fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 300 })
} catch {}
void here
process.exit(0)
