#requires -Version 7.0
<#
.SYNOPSIS
Start the stage 01 MQTT broker, API and simulator; Ctrl+C stops this run.
.EXAMPLE
pwsh -File .\Start-Realtime.ps1 -Port 8000 -MqttPort 1883
#>
param(
    [ValidateRange(1024,65535)][int]$Port = 8000,
    [ValidateRange(1024,65535)][int]$MqttPort = 1883
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$runtimeRoot = Join-Path $PSScriptRoot '.runtime'
New-Item -ItemType Directory -Path (Join-Path $runtimeRoot 'tmp') -Force | Out-Null
$env:TEMP = Join-Path $runtimeRoot 'tmp'
$env:TMP = $env:TEMP
$env:PIP_CACHE_DIR = Join-Path $runtimeRoot 'pip-cache'
$env:PYTHONDONTWRITEBYTECODE = '1'
$pythonExecutable = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonExecutable)) {
    throw '请先按 README 创建 .venv，再运行 Setup-Realtime.ps1。'
}
& $pythonExecutable -B (Join-Path $PSScriptRoot 'scripts\start_realtime.py') --port $Port --mqtt-port $MqttPort
exit $LASTEXITCODE
