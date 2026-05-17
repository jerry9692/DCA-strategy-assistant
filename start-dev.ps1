param(
    [int]$BackendPort = 8000,
    [int]$FrontendPort = 5173,
    [switch]$Install
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Join-Path $Root "backend"
$FrontendDir = Join-Path $Root "frontend"
$PythonExe = Join-Path $BackendDir ".venv\Scripts\python.exe"

function Start-DevWindow {
    param(
        [string]$Title,
        [string]$WorkingDirectory,
        [string]$Command
    )

    $escapedTitle = $Title.Replace("'", "''")
    $escapedDir = $WorkingDirectory.Replace("'", "''")
    $escapedCommand = $Command.Replace("'", "''")
    $windowCommand = @"
`$Host.UI.RawUI.WindowTitle = '$escapedTitle'
Set-Location '$escapedDir'
$escapedCommand
"@

    Start-Process powershell -ArgumentList @(
        "-NoExit",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        $windowCommand
    ) | Out-Null
}

if ($Install -and -not (Test-Path $PythonExe)) {
    Write-Host "Creating backend virtual environment..." -ForegroundColor Cyan
    py -3 -m venv (Join-Path $BackendDir ".venv")
}

if ($Install) {
    Write-Host "Installing backend dependencies..." -ForegroundColor Cyan
    & $PythonExe -m pip install -r (Join-Path $BackendDir "requirements.txt")

    Write-Host "Installing frontend dependencies..." -ForegroundColor Cyan
    Push-Location $FrontendDir
    npm install
    Pop-Location
}

if (-not (Test-Path $PythonExe)) {
    Write-Host "backend/.venv not found. Run '.\start-dev.ps1 -Install' once, then start again." -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path (Join-Path $FrontendDir "node_modules"))) {
    Write-Host "frontend/node_modules not found. Run '.\start-dev.ps1 -Install' once, then start again." -ForegroundColor Yellow
    exit 1
}

$backendCommand = ".\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port $BackendPort --reload"
$frontendCommand = "npm run dev -- --port $FrontendPort"

Start-DevWindow -Title "DCA Backend :$BackendPort" -WorkingDirectory $BackendDir -Command $backendCommand
Start-DevWindow -Title "DCA Frontend :$FrontendPort" -WorkingDirectory $FrontendDir -Command $frontendCommand

Write-Host ""
Write-Host "DCA Strategy Assistant is starting:" -ForegroundColor Green
Write-Host "  Backend : http://127.0.0.1:$BackendPort"
Write-Host "  Frontend: http://127.0.0.1:$FrontendPort"
Write-Host ""
Write-Host "Close the two opened PowerShell windows to stop the dev servers."
