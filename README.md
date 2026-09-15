# PDF 去水印工具（纯浏览器端）

在线站点：`https://<你的用户名>.github.io/pdf-watermark-remover/`

精准移除 PDF 里的**水印标记内容**（`/Artifact <</Subtype/Watermark>> BDC … EMC`），
图纸线条、位号丝印、隐藏 OCR 文字层、字体全部原样保留。
**所有处理都在浏览器本地完成，文件不会上传到任何服务器。**

## 它解决什么问题

PADS / ClibPDF 导出并加了「试用水印」的位号图，水印不是注释、也不是背景图，而是页面内容流末尾的一段标记内容：

```
/Artifact <</Subtype/Watermark/Type/Pagination>> BDC
q
/KSPE4 gs
0.572196 0.208262 -0.208262 0.572196 116.387360 309.720612 cm
/KSPX4 Do        % 水印 Form XObject，内含红色半透明「试用水印」JPEG
Q
EMC
```

同时它在文件级注册为可选内容组（OCG，名为 `Watermark`）。
因此正确的做法是**按标记内容精确切除**，而不是涂抹或重画：

1. 定位页面内容流里的 `/Artifact <</Subtype/Watermark…>> BDC`；
2. 按 BDC/EMC 嵌套深度匹配到配对的 `EMC`，整块删除；
3. 从页面资源里移除水印 XObject（`/KSPX*`）——水印的 `/OC` 图层引用就挂在这些对象上；
4. 移除文件级 `/OCProperties` 图层目录；
5. 做一次**可达性 GC**，清掉已不可达的孤立对象（水印图层字典、Adobe `/PieceInfo` 水印设置等），
   否则 pdf-lib 会把它们一并写回，文件几乎不会变小。

不含水印的 PDF 会**原样返回**（输出与输入字节完全一致），不会误改。

## 本机验证结论（真实样本：2GB013_V1.01_位号图(260914).pdf，2 页）

| 校验项 | 结果 |
| --- | --- |
| 水印块删除 | 2/2（每页 1 块），残留 `/KSPX` 引用 0 |
| 水印资源清理 | `KSPX1`、`KSPX2`、`KSPX3`、`KSPX4` 全部移除 |
| 可达性 GC | 清理 17 个孤立对象，文件 2.33 MB → **773 KB** |
| 与原件渲染比对 | 最大像素差 34/255，**超阈值(40)像素 0 个**（仅抗锯齿噪声） |
| 文字层 | 第 1 页 3523 字符、第 2 页 18372 字符，完全一致 |
| 与 Python 参考实现比对 | **逐像素 0 差异**（652.8 万像素/页全等） |
| 浏览器端到端 | 真实 Edge 无头驱动页面完成处理、预览、下载，产物与参考实现逐像素一致 |

## 快速开始

```bash
npm install          # 安装依赖，并自动把 pdf.js worker 复制到 public/
npm run dev          # 本地开发（默认 http://localhost:5173/）
npm test             # 核心逻辑 + 合成夹具 + 真实样本回归
npm run build        # 产出 dist/（静态站点，可直接托管）
npm run preview      # 预览构建产物
```

浏览器端到端冒烟测试（需要本机有 Edge/Chrome）：

```bash
npm run build
node scripts/e2e-smoke.mjs "样本.pdf" e2e-output.pdf
```

命令行跑真实文件（无需浏览器）：

```bash
node scripts/run-sample.mjs 输入.pdf 输出.pdf
python tools/compare_pdfs.py 输入.pdf 输出.pdf   # 渲染 + 文字层等价校验
```

## 目录结构

```
src/pdf/removeWatermark.ts   去水印核心：标记内容删除 + 资源清理 + GC 串联
src/pdf/gc.ts                可达性垃圾回收（重写 xref/trailer，失败自动回退）
src/preview.ts               pdf.js 渲染预览（前后对比用）
src/main.ts                  页面逻辑：拖放、处理、对比滑块、下载、明细报告
test/removeWatermark.test.ts 语法层 + 合成夹具 + 真实样本结构回归
test/realSample.test.ts      结构校验 + 与 Python 参考实现逐像素比对
tools/compare_pdfs.py        任意两份 PDF 的渲染/文字等价校验
tools/pixels.py              页面渲染成原始 RGB（供 Node 侧比对）
scripts/e2e-smoke.mjs        CDP 驱动的浏览器端到端冒烟测试
scripts/run-sample.mjs       命令行批量处理入口
```

## 适用范围与限制

- 适用于水印以 `Watermark` 标记内容形式写入的 PDF（Adobe、ClibPDF、PADS 输出等）。
- 水印被**压平**进图纸位图（扫描件、整页图片）时，本工具无能为力——那属于图像修复范畴。
- 内容流过滤器目前只处理 `FlateDecode` / 无过滤器；遇到其它编码会明确报告「跳过」，不会盲目改写。
- 输出使用经典 xref 表（pdf-lib 的写出格式）；输入若使用 xref 流/对象流，GC 会自动跳过且不影响去水印结果。

## 部署到 GitHub Pages

仓库已内置工作流 `.github/workflows/deploy-pages.yml`：推送到 `main` 后自动测试、构建并发布。

1. 在 GitHub 新建仓库 `pdf-watermark-remover`（建议 Public，不要勾选 Add README/.gitignore/license）；
2. 本地推送：
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\publish.ps1
   ```
   若提示凭据不可用，先手动执行一次 `git push -u origin main` 并在弹窗中授权（详见 `PUBLISH.md`）；
3. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**；
4. 等待 Actions 完成，访问 `https://<用户名>.github.io/pdf-watermark-remover/`。

## 免责声明

本工具用于处理你**有权处理**的文档（例如自家产品的图纸、已获授权的资料）。
请遵守原始文档的授权条款，不要用它规避合法的版权保护。
