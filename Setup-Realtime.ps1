#requires -Version 7.0
<#
.SYNOPSIS
Install only paho-mqtt into the existing application environment and the locked broker dependencies into a separate environment.
.EXAMPLE
pwsh -File .\Setup-Realtime.ps1
#>
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$runtimeRoot = Join-Path $PSScriptRoot '.runtime'
New-Item -ItemType Directory -Path (Join-Path $runtimeRoot 'tmp') -Force | Out-Null
$env:TEMP = Join-Path $runtimeRoot 'tmp'
$env:TMP = $env:TEMP
$env:PIP_CACHE_DIR = Join-Path $runtimeRoot 'pip-cache'
$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'
$pythonExecutable = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$brokerEnvironment = Join-Path $runtimeRoot 'broker-venv'
$brokerPython = Join-Path $brokerEnvironment 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonExecutable)) {
    throw '主环境不存在；请先按 README 创建 .venv 并安装项目依赖。'
}
& $pythonExecutable -B -m pip install --no-deps 'paho-mqtt==2.1.0'
if ($LASTEXITCODE -ne 0) { throw '安装 paho-mqtt 失败。' }
if (-not (Test-Path -LiteralPath $brokerPython)) {
    & $pythonExecutable -B -m venv $brokerEnvironment
    if ($LASTEXITCODE -ne 0) { throw '创建独立 Broker 环境失败。' }
}
& $brokerPython -B -m pip install -r (Join-Path $PSScriptRoot 'requirements-broker-lock.txt')
if ($LASTEXITCODE -ne 0) { throw '安装 Broker 锁定依赖失败。' }
& $pythonExecutable -B -m pip check
if ($LASTEXITCODE -ne 0) { throw '主环境依赖检查失败。' }
& $brokerPython -B -m pip check
if ($LASTEXITCODE -ne 0) { throw 'Broker 环境依赖检查失败。' }
Write-Host '阶段 01 依赖已就绪。运行 pwsh -File .\Start-Realtime.ps1。'
