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

function Test-PortAvailable {
    param(
        [int]$Port,
        [string]$Name
    )

    $pattern = "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$"
    $pids = @(
        netstat -ano |
            ForEach-Object {
                if ($_ -match $pattern) {
                    $Matches[1]
                }
            } |
            Select-Object -Unique
    )

    if ($pids.Count -eq 0) {
        return $true
    }

    Write-Host "$Name port $Port is already in use by PID(s): $($pids -join ', ')." -ForegroundColor Yellow
    Write-Host "Close the existing dev window, or run: taskkill /PID <pid> /T /F" -ForegroundColor Yellow
    return $false
}

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

if (-not (Test-PortAvailable -Port $BackendPort -Name "Backend")) {
    exit 1
}

if (-not (Test-PortAvailable -Port $FrontendPort -Name "Frontend")) {
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
