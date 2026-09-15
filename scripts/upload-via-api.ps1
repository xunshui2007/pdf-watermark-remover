# 通过 GitHub REST API 上传仓库内容（本机到 github.com:443 的 git 传输被阻断，改走 api.github.com）
#
# 注意：本文件必须保存为 **UTF-8 with BOM**。Windows PowerShell 5.1 读 .ps1 按 ANSI 解码，
# 含中文的脚本不加 BOM 会乱码并报语法错误。
#
# 用法：powershell -ExecutionPolicy Bypass -File .\scripts\upload-via-api.ps1 [-Repo owner/name] [-Branch main]
param(
    [string]$Repo = "xunshui2007/pdf-watermark-remover",
    [string]$Branch = "main",
    [string]$Message = "feat: 纯浏览器端 PDF 去水印工具（标记内容删除 + 资源清理 + 可达性 GC）"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:GIT_TERMINAL_PROMPT = '0'
$cred = "protocol=https`nhost=github.com`n" | git credential fill 2>$null
$token = ($cred | Select-String '^password=').Line -replace '^password=', ''
if (-not $token) { throw "未能从凭据管理器取到 GitHub 令牌" }

$headers = @{
    Authorization          = "token $token"
    'User-Agent'           = 'dsh'
    Accept                 = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
}

function Send-Gh {
    param([string]$Method, [string]$Uri, $Body)
    $params = @{ Method = $Method; Uri = $Uri; Headers = $headers; UseBasicParsing = $true; TimeoutSec = 180 }
    if ($null -ne $Body) {
        $json = $Body | ConvertTo-Json -Depth 6 -Compress
        # 必须显式用 UTF-8 字节，否则中文会被按 ISO-8859-1 发送而乱码
        $params.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
        $params.ContentType = 'application/json; charset=utf-8'
    }
    try {
        return (Invoke-WebRequest @params).Content | ConvertFrom-Json
    } catch {
        $detail = ''
        if ($_.Exception.Response) {
            $detail = (New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd()
        }
        throw "$Method $Uri 失败: $($_.Exception.Message) $detail"
    }
}

$files = @(git -c core.autocrlf=false ls-files)
Write-Host "==> 上传 $($files.Count) 个文件到 $Repo (分支 $Branch)" -ForegroundColor Cyan

$i = 0
$ok = 0
foreach ($f in $files) {
    $i++
    $full = Join-Path $root ($f -replace '/', '\')
    if (-not (Test-Path $full -PathType Leaf)) {
        Write-Host ("    [{0}/{1}] 跳过（本地不存在）: {2}" -f $i, $files.Count, $f) -ForegroundColor Yellow
        continue
    }
    $bytes = [System.IO.File]::ReadAllBytes($full)

    # 文本统一成 LF（与 .gitattributes 一致）；按内容是否含 NUL 判断二进制
    if ($bytes -contains 0) {
        $content = [Convert]::ToBase64String($bytes)
    } else {
        $text = [System.Text.Encoding]::UTF8.GetString($bytes).Replace("`r`n", "`n")
        $content = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text))
    }

    $uri = "https://api.github.com/repos/$Repo/contents/$f"
    $existingSha = $null
    try {
        $existingSha = (Send-Gh GET "${uri}?ref=$Branch").sha
    } catch {
        $existingSha = $null
    }

    $body = @{ message = $Message; content = $content; branch = $Branch }
    if ($existingSha) { $body.sha = $existingSha }
    Send-Gh PUT $uri $body | Out-Null
    $ok++
    Write-Host ("    [{0}/{1}] {2} ({3} 字节)" -f $i, $files.Count, $f, $bytes.Length)
}

Write-Host ""
Write-Host "==> 完成：$ok/$($files.Count) 个文件已上传" -ForegroundColor Green
Write-Host "    仓库地址：https://github.com/$Repo" -ForegroundColor Green
