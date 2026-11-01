param([string]$ModelArchive)
$ErrorActionPreference='Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskRuntime=Join-Path $PSScriptRoot '.runtime'
New-Item -ItemType Directory -Force -Path (Join-Path $taskRuntime 'tmp') | Out-Null
$env:TMP=Join-Path $taskRuntime 'tmp'
$env:TEMP=$env:TMP
$env:PIP_CACHE_DIR=Join-Path $taskRuntime 'pip-cache'
$env:PYTHONDONTWRITEBYTECODE='1'
$pythonExecutable=if($env:INSPECTGO_PYTHON){$env:INSPECTGO_PYTHON}else{Join-Path $PSScriptRoot '.venv\Scripts\python.exe'}
if(-not(Test-Path -LiteralPath $pythonExecutable -PathType Leaf)){throw 'Set INSPECTGO_PYTHON to the project Python executable first.'}
& $pythonExecutable -B -m pip install -r requirements-speech.txt --disable-pip-version-check
if($LASTEXITCODE -ne 0){throw 'Speech dependency installation failed.'}
$setupArguments=@('-B','scripts/setup_speech.py')
if($ModelArchive){$setupArguments+=@('--archive',$ModelArchive)}
& $pythonExecutable @setupArguments
if($LASTEXITCODE -ne 0){throw 'Speech model setup failed.'}
Write-Output 'Local Chinese ASR configured. Restart the project and refresh the browser.'
