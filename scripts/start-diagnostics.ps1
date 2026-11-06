$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
try {
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    & $nodePath (Join-Path $projectRoot 'node_modules\typescript\bin\tsc')
    if ($LASTEXITCODE -ne 0) { throw '编译失败，请查看上方输出。' }
    Write-Host '在浏览器打开 http://127.0.0.1:4318；此窗口保持打开。'
    Write-Host '只读取诊断日志，不连接游戏；新版伙伴启动后会写入实时记录。'
    $env:SIM_DIAGNOSTICS_OPEN_BROWSER = '1'
    & $nodePath (Join-Path $projectRoot 'dist\examples\diagnostics.js')
} catch {
    Write-Host "诊断台启动失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
