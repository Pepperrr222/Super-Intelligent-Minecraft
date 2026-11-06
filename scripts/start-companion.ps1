param([switch]$Check)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

function Read-Setting([string]$Label, [string]$Default) {
    $value = Read-Host "$Label [$Default]"
    if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
    return $value.Trim()
}

try {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    $nodePath = if ($nodeCommand) { $nodeCommand.Source } else { $null }
    $bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (-not $nodePath -and (Test-Path -LiteralPath $bundledNode)) { $nodePath = $bundledNode }
    if (-not $nodePath) { throw '找不到 Node.js。请安装 Node.js 22 或更新版本，并重新打开启动入口。' }
    $nodeVersion = & $nodePath --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw "需要 Node.js 22 或更新版本，当前：$nodeVersion" }
    $compiler = Join-Path $projectRoot 'node_modules\typescript\bin\tsc'
    if (-not (Test-Path -LiteralPath $compiler)) { throw '项目依赖尚未安装。请先在项目目录运行 pnpm install --frozen-lockfile。' }

    Write-Host "正在编译项目（Node.js $nodeVersion）..."
    & $nodePath $compiler
    if ($LASTEXITCODE -ne 0) { throw '编译失败，请查看上方错误。' }
    if ($Check) { Write-Host '启动环境检查通过；未连接服务器。'; exit 0 }

    $configPath = Join-Path $projectRoot '.companion.local.json'
    if (Test-Path -LiteralPath $configPath) {
        $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } else {
        Write-Host '首次启动：请填写服务器和玩家信息。按回车使用方括号中的默认值。'
        $config = [ordered]@{
            host = Read-Setting '服务器地址' '127.0.0.1'
            port = Read-Setting '服务器端口' '25565'
            username = Read-Setting '机器人账号名' 'SIMCompanion'
            version = Read-Setting 'Minecraft Java 版本' '1.21.1'
            auth = Read-Setting '认证方式（microsoft 或 offline）' 'microsoft'
            owners = (Read-Host '允许控制机器人的玩家名（多个用英文逗号分隔）').Trim()
        }
        if ([string]::IsNullOrWhiteSpace($config.owners)) { throw '请填写允许控制机器人的玩家名，然后重新启动。' }
        if ($config.auth -notin @('microsoft','offline')) { throw '认证方式只能是 microsoft 或 offline，请重新启动并输入正确值。' }
        $portNumber = 0
        if (-not [int]::TryParse($config.port, [ref]$portNumber) -or $portNumber -lt 1 -or $portNumber -gt 65535) { throw '端口必须是 1 到 65535 的整数，请重新启动。' }
        $config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
        Write-Host '设置已保存在 .companion.local.json；需要修改时可编辑此文件。'
    }
    if ([string]::IsNullOrWhiteSpace([string]$config.owners)) { throw '配置中的 owners 不能为空，请编辑 .companion.local.json。' }
    if ($config.auth -notin @('microsoft','offline')) { throw '配置中的 auth 必须为 microsoft 或 offline。' }
    $portNumber = 0
    if (-not [int]::TryParse([string]$config.port, [ref]$portNumber) -or $portNumber -lt 1 -or $portNumber -gt 65535) { throw '配置中的端口必须是 1 到 65535 的整数。' }
    foreach ($name in @('host','username','version')) {
        if ([string]::IsNullOrWhiteSpace([string]$config.$name)) { throw "配置中的 $name 不能为空。" }
    }
    $env:MC_HOST = [string]$config.host
    $env:MC_PORT = [string]$portNumber
    $env:MC_USERNAME = [string]$config.username
    $env:MC_VERSION = [string]$config.version
    $env:MC_AUTH = [string]$config.auth
    $env:MC_OWNERS = [string]$config.owners
    Write-Host "正在连接 $($config.host):$portNumber，保持此窗口打开；按 Ctrl+C 停止。"
    & $nodePath (Join-Path $projectRoot 'dist\examples\companion.js')
    if ($LASTEXITCODE -ne 0) { throw "伙伴进程退出，代码：$LASTEXITCODE" }
} catch {
    Write-Host "启动失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
