# 发布到 GitHub

## 当前状态（已上线）

- 仓库：<https://github.com/xunshui2007/pdf-watermark-remover>
- 站点：<https://xunshui2007.github.io/pdf-watermark-remover/>（workflow 方式部署，推 `main` 自动发布）

## 注意：本机 git 推到 github.com 会失败

本机到 `github.com:443` 的 git 传输被网络阻断（`api.github.com` 却正常），
`git push` 会报 `Failed to connect to github.com port 443`。
因此仓库内容改用 **GitHub REST Contents API** 上传：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\upload-via-api.ps1
```

脚本幂等（先查文件 sha 再 PUT），可反复执行；中文脚本必须存成 **UTF-8 with BOM**，
否则 Windows PowerShell 5.1 会按 ANSI 解码而报语法错误。

若换到网络正常的机器，直接 `git remote -v` 确认后 `git push` 即可。

## 在 GitHub 上开启 Pages（若尚未开启）

仓库页 → **Settings** → **Pages** → **Build and deployment** → **Source** 选
**GitHub Actions** → 保存。之后每次推送到 `main` 都会自动测试、构建并发布。

站点地址：<https://xunshui2007.github.io/pdf-watermark-remover/>

## 新建仓库（换账号时）

1. 打开 https://github.com/new
2. Repository name 填 `pdf-watermark-remover`
3. 选择 **Public**（Pages 免费站点需要公开仓库）
4. **不要**勾选 Add README / .gitignore / license（本地已有）
5. 点 **Create repository**，然后运行 `scripts/upload-via-api.ps1 -Repo <用户名>/<仓库名>`
