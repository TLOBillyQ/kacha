# 对 UGC AI 生图工具可执行文件做 Windows Authenticode 签名。
#
# 优先使用 Windows SDK 的 signtool（支持 RFC3161 时间戳与更完整的验证），
# 找不到时退回 PowerShell 的 Set-AuthenticodeSignature。
#
# 用法（示例，单行即可，避免反引号续行）：
#   pwsh -NoProfile -ExecutionPolicy Bypass -File packaging/sign.ps1 -ExePath <exe> -CertificatePath <cert.pfx> [-Password <pwd>] [-TimestampServer <url>] [-SigntoolPath <path>]
#
# 输出 SIGNED 与 SIGNATURE_STATUS 两个标记；签名结果必须为 Valid 才成功，否则退出码非零。

param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [string]$CertificatePath = "",
    [string]$Password = "",
    [string]$TimestampServer = "http://timestamp.digicert.com",
    [string]$SigntoolPath = ""
)

$ErrorActionPreference = "Stop"

# 口令优先取命令行参数；为空时从环境变量读取，避免口令出现在进程参数里。
if (-not $Password) { $Password = $env:UGC_IMAGE_TOOL_CERT_PASSWORD }

function Invoke-Signtool {
    param([string]$Tool, [string[]]$Arguments)
    & $Tool @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "signtool failed with exit code $LASTEXITCODE"
    }
}

function Resolve-Signtool {
    param([string]$Override)
    if ($Override) { return $Override }
    $cmd = Get-Command signtool -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $kit = "C:\Program Files (x86)\Windows Kits\10\bin"
    if (Test-Path $kit) {
        $candidate = Get-ChildItem -Path $kit -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match "x64" } |
            Sort-Object FullName -Descending | Select-Object -First 1
        if ($candidate) { return $candidate.FullName }
    }
    return ""
}

$resolved = Resolve-Signtool -Override $SigntoolPath

if ($resolved) {
    Write-Output "SIGNTOOL=$resolved"
    $signArgs = @("sign", "/fd", "SHA256", "/tr", $TimestampServer, "/td", "SHA256", "/f", $CertificatePath)
    if ($Password) { $signArgs += @("/p", $Password) }
    $signArgs += $ExePath
    Invoke-Signtool -Tool $resolved -Arguments $signArgs
    Write-Output "SIGNED=true"
}
else {
    if (-not $CertificatePath) {
        throw "no signtool found and no certificate path provided; cannot sign"
    }
    $secure = ConvertTo-SecureString -String $Password -AsPlainText -Force
    $cert = Get-PfxCertificate -FilePath $CertificatePath -Password $secure
    $signature = Set-AuthenticodeSignature -FilePath $ExePath -Certificate $cert -HashAlgorithm SHA256 -TimestampServer $TimestampServer
    Write-Output "SIGNED=$($signature.Status)"
}

$final = Get-AuthenticodeSignature -FilePath $ExePath
Write-Output "SIGNATURE_STATUS=$($final.Status)"
if ($final.Status -ne "Valid") {
    throw "signature status is $($final.Status); expected Valid"
}
