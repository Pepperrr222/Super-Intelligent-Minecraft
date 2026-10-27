$ErrorActionPreference = 'Stop'
$simServer = Join-Path $PSScriptRoot '..\runtime\server'
if (-not (Test-Path -LiteralPath (Join-Path $simServer 'server.jar'))) {
    throw 'Run python scripts/setup_lab.py --accept-eula first.'
}
$simJava = if ($env:SIM_JAVA) { $env:SIM_JAVA } else { 'java' }
Push-Location $simServer
try {
    & $simJava -Xms512M -Xmx1536M -jar server.jar nogui
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
