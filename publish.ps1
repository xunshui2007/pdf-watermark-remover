# 一键发布到 GitHub（幂等：可反复执行）
# 用法：powershell -ExecutionPolicy Bypass -File .\publish.ps1 [-Repo 用户名/仓库名]
param(
    [string]$Repo = "xunshui2007/pdf-watermark-remover"
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$url = "https://github.com/$Repo.git"
Write-Host "==> 目标仓库: $Repo" -ForegroundColor Cyan

# 1) 检查仓库是否可访问（公开仓库无需凭据即可只读探测）
Write-Host "==> 探测仓库是否存在..."
$probe = & git ls-remote --heads $url 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "仓库尚不存在或不可访问：$Repo" -ForegroundColor Yellow
    Write-Host "请先到 https://github.com/new 创建名为 $($Repo.Split('/')[-1]) 的 Public 仓库" -ForegroundColor Yellow
    Write-Host "（不要勾选 Add a README / .gitignore / license），然后重新运行本脚本。" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "原始信息: $probe"
    exit 1
}
Write-Host "    仓库存在。" -ForegroundColor Green

# 2) 配置 remote 并推送
if (-not (git remote | Select-String -Quiet '^origin$')) {
    git remote add origin $url
} else {
    git remote set-url origin $url
}

Write-Host "==> 开始推送（如弹出 GitHub 登录窗口，请用浏览器授权）..."
git push -u origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "推送失败：本机没有可用的 GitHub 凭据。" -ForegroundColor Red
    Write-Host "请手动执行一次 'git push -u origin main' 并在弹窗中授权，然后重跑本脚本。" -ForegroundColor Yellow
    Write-Host "详见 PUBLISH.md。" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "推送完成。" -ForegroundColor Green
Write-Host "下一步（只需做一次）：打开 https://github.com/$Repo/settings/pages" -ForegroundColor Cyan
Write-Host "  → Build and deployment → Source 选择 'GitHub Actions' → 保存" -ForegroundColor Cyan
Write-Host "站点地址：https://$($Repo.Split('/')[0]).github.io/$($Repo.Split('/')[-1])/" -ForegroundColor Cyan
