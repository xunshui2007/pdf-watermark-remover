# 发布到 GitHub（在“资源管理器里双击”或 PowerShell 里执行本脚本）

本脚本做三件事：

1. 检查仓库地址是否已存在；
2. 推送本地代码到 GitHub（会弹出登录窗口，用浏览器/凭据管理器授权即可）；
3. 提示如何在 GitHub 上开启 Pages 自动发布。

## 使用前

请先在浏览器里创建仓库（**必须手动做一次，因为创建仓库需要你的登录凭据**）：

1. 打开 https://github.com/new
2. Repository name 填 `pdf-watermark-remover`
3. 选择 **Public**（Pages 免费站点需要公开仓库；私有仓库需付费计划）
4. **不要**勾选 "Add a README file"、".gitignore"、"license"（本地已经有了）
5. 点 **Create repository**

## 然后运行

在本目录（`F:\数字化连接\pdf-watermark-remover`）打开 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\publish.ps1
```

脚本会弹出 GitHub 登录窗口（Git Credential Manager），授权后即可推送。

## 推送完成后开启 Pages

仓库页 → **Settings** → 左侧 **Pages** → **Build and deployment** → **Source** 选
**GitHub Actions** → 保存。之后每次推送到 `main` 分支都会自动测试、构建并发布。

站点地址：<https://xunshui2007.github.io/pdf-watermark-remover/>

## 如果脚本推送失败

说明本机没有可用的 GitHub 凭据（例如公司网络禁用了凭据窗口）。可选方案：

- 在本机手动执行一次 `git push -u origin main`，在弹出的窗口里授权，之后脚本就可用；
- 或改用 SSH：`git remote set-url origin git@github.com:xunshui2007/pdf-watermark-remover.git`
  （需要已配置 SSH key）；
- 或在 GitHub 网页上直接上传文件（不推荐，会丢失 Git 历史）。
