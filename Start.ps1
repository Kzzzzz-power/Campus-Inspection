param([ValidateRange(1024,65535)][int]$Port = 8000)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$runtimeRoot = Join-Path $PSScriptRoot '.runtime'
New-Item -ItemType Directory -Path (Join-Path $runtimeRoot 'tmp') -Force | Out-Null
$env:TEMP = Join-Path $runtimeRoot 'tmp'
$env:TMP = $env:TEMP
$env:PIP_CACHE_DIR = Join-Path $runtimeRoot 'pip-cache'
$env:PYTHONDONTWRITEBYTECODE = '1'
$pythonExecutable = if ($env:INSPECTGO_PYTHON) { $env:INSPECTGO_PYTHON } else { Join-Path $PSScriptRoot '.venv\Scripts\python.exe' }
if (-not (Test-Path -LiteralPath $pythonExecutable)) { throw '请先按 README 创建 .venv 并安装依赖。' }
Write-Host "巡到位：http://127.0.0.1:$Port/ ；按 Ctrl+C 停止。"
& $pythonExecutable -B -m uvicorn main:app --app-dir (Join-Path $PSScriptRoot 'backend') --host 127.0.0.1 --port $Port
exit $LASTEXITCODE
