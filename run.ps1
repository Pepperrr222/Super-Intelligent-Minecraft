param([Parameter(ValueFromRemainingArguments=$true)][string[]]$AgentArgs)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $simPython = if (Test-Path -LiteralPath '.venv\Scripts\python.exe') { '.venv\Scripts\python.exe' } else { 'python' }
    & $simPython scripts/dev.py run @AgentArgs
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
