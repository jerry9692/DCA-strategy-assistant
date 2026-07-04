param(
    [string]$OutputDir = "dist-portable\DCA-strategy-assistant-portable",
    [switch]$SkipFrontendBuild,
    [switch]$IncludeCache = $true
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$OutputPath = Join-Path $Root $OutputDir
$BackendDir = Join-Path $Root "backend"
$FrontendDir = Join-Path $Root "frontend"
$PythonExe = Join-Path $BackendDir ".venv\Scripts\python.exe"
$PythonBase = $null
$SitePackages = $null

if (-not (Test-Path $PythonExe)) {
    throw "backend\.venv is missing. Run .\start-dev.ps1 -Install first."
}

$PythonBase = (& $PythonExe -c "import sys; print(sys.base_prefix)").Trim()
$SitePackages = (& $PythonExe -c "import sysconfig; print(sysconfig.get_paths()['purelib'])").Trim()
if (-not (Test-Path (Join-Path $PythonBase "python.exe"))) {
    throw "Cannot locate base python.exe under $PythonBase"
}
if (-not (Test-Path $SitePackages)) {
    throw "Cannot locate site-packages under $SitePackages"
}

if (-not $SkipFrontendBuild) {
    Push-Location $FrontendDir
    npm run build
    Pop-Location
}

if (Test-Path $OutputPath) {
    Remove-Item -LiteralPath $OutputPath -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $OutputPath "backend") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $OutputPath "frontend") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $OutputPath "runtime") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $OutputPath "tools") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $OutputPath "cache-patches") | Out-Null

Copy-Item -LiteralPath (Join-Path $BackendDir "app") -Destination (Join-Path $OutputPath "backend\app") -Recurse
Copy-Item -LiteralPath (Join-Path $BackendDir "requirements.txt") -Destination (Join-Path $OutputPath "backend\requirements.txt")
Copy-Item -LiteralPath (Join-Path $FrontendDir "dist") -Destination (Join-Path $OutputPath "frontend\dist") -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "import_cache_patch.py") -Destination (Join-Path $OutputPath "tools\import_cache_patch.py")

$RuntimePythonDir = Join-Path $OutputPath "runtime\python"
# L52 already copies the entire base Python (which includes
# Lib/site-packages) into $RuntimePythonDir. The previous L53 then
# re-copied with a `*` glob, which (a) PowerShell expands to literal
# filenames — silently producing an empty copy if the site-packages
# directory is empty after a fresh `pip install` and (b) duplicated
# every file. Use -LiteralPath on the directory itself and merge into
# the existing Lib/.
$SitePackagesDest = Join-Path $RuntimePythonDir "Lib\site-packages"
if (-not (Test-Path $SitePackagesDest)) {
    New-Item -ItemType Directory -Force -Path $SitePackagesDest | Out-Null
}
Get-ChildItem -LiteralPath $SitePackages -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $SitePackagesDest -Recurse -Force
}

New-Item -ItemType Directory -Force -Path (Join-Path $OutputPath "backend\data") | Out-Null
if ($IncludeCache) {
    $cacheDb = Join-Path $BackendDir "data\dca_assistant.sqlite"
    if (Test-Path $cacheDb) {
        Copy-Item -LiteralPath $cacheDb -Destination (Join-Path $OutputPath "backend\data\dca_assistant.sqlite")
    }
}

@'
@echo off
setlocal
set DCA_OFFLINE_MODE=1
set PYTHON=%~dp0runtime\python\python.exe
set URL=http://127.0.0.1:8000
if not exist "%PYTHON%" (
  echo Python runtime not found: %PYTHON%
  pause
  exit /b 1
)
start "" "%URL%"
"%PYTHON%" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir "%~dp0backend"
pause
'@ | Set-Content -Path (Join-Path $OutputPath "start-offline.bat") -Encoding ASCII

@'
@echo off
setlocal
if "%~1"=="" (
  echo Usage: import-cache.bat path\to\dca-cache.zip
  pause
  exit /b 1
)
"%~dp0runtime\python\python.exe" "%~dp0tools\import_cache_patch.py" "%~1" --db "%~dp0backend\data\dca_assistant.sqlite"
pause
'@ | Set-Content -Path (Join-Path $OutputPath "import-cache.bat") -Encoding ASCII

@'
# DCA Strategy Assistant 便携版

1. 双击 `start-offline.bat` 启动。
2. 浏览器会打开 `http://127.0.0.1:8000`。
3. Python runtime 在 `runtime\python`，不会依赖打包机器上的绝对路径。
4. 便携版默认离线模式，只使用 `backend\data\dca_assistant.sqlite`。
5. 如果某个区间提示缓存不覆盖，把新的 `dca-cache-*.zip` 拖到 `import-cache.bat` 上导入。

API Key 仍只保存在本机浏览器 localStorage，不会写进缓存补丁。
'@ | Set-Content -Path (Join-Path $OutputPath "README-便携版.md") -Encoding UTF8

$ZipPath = "$OutputPath.zip"
if (Test-Path $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
}
# Always use Compress-Archive for the zip. The previous branch
# preferred `tar -a -cf ...zip`, which on Windows 10/11's bsdtar
# can produce a tar-format file with a .zip suffix (7-Zip / WinRAR
# then refuse to extract it with "not a zip archive"). Compress-Archive
# is slower but produces a zip that every consumer opens cleanly.
Compress-Archive -LiteralPath $OutputPath -DestinationPath $ZipPath -Force
if ($LASTEXITCODE -ne 0) {
    throw "Compress-Archive failed to create $ZipPath"
}
Write-Host "Portable build created:" -ForegroundColor Green
Write-Host "  $OutputPath"
Write-Host "  $ZipPath"
