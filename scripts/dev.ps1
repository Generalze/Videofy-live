# Videofy Live - start all Phase 1 development services (Windows PowerShell)
$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$PythonExe = Join-Path $Root "services\speech-worker\.venv\Scripts\python.exe"
$processes = @()

if (-not (Test-Path $PythonExe)) {
  Write-Host "Python virtual environment is missing." -ForegroundColor Red
  Write-Host "Run these commands first:" -ForegroundColor Yellow
  Write-Host "  cd services\speech-worker"
  Write-Host "  python -m venv .venv"
  Write-Host "  .\.venv\Scripts\python.exe -m pip install -e .[dev]"
  exit 1
}

function Start-DevProcess {
  param(
    [string] $Name,
    [string] $WorkingDirectory,
    [string] $Command,
    [string] $Arguments
  )

  Write-Host "Starting $Name..." -ForegroundColor Cyan
  $process = Start-Process `
    -FilePath $Command `
    -ArgumentList $Arguments `
    -WorkingDirectory $WorkingDirectory `
    -WindowStyle Hidden `
    -PassThru
  $script:processes += $process
}

function Stop-DevProcesses {
  foreach ($process in $script:processes) {
    if ($null -ne $process -and -not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
  }
}

trap {
  Stop-DevProcesses
  throw $_
}

Write-Host "Starting Videofy Live development services..." -ForegroundColor Cyan

Start-DevProcess "Realtime Gateway" $Root "cmd.exe" "/c npm.cmd run dev -w services/realtime-gateway"
Start-DevProcess "Media Ingest" $Root "cmd.exe" "/c npm.cmd run dev -w services/media-ingest"
Start-DevProcess "Listener App" $Root "cmd.exe" "/c npm.cmd run dev -w apps/listener-web"
Start-DevProcess "Operator App" $Root "cmd.exe" "/c npm.cmd run dev -w apps/operator-web"
Start-DevProcess "Speech Worker" (Join-Path $Root "services\speech-worker") $PythonExe "main.py"

Write-Host ""
Write-Host "Services started. Press Ctrl+C to stop all child processes." -ForegroundColor Green
Write-Host "  Realtime Gateway  http://localhost:3001"
Write-Host "  Media Ingest      http://localhost:3002/health"
Write-Host "  Listener App      http://localhost:5173"
Write-Host "  Operator App      http://localhost:5174"
Write-Host "  Speech Worker     http://localhost:8001/health"

try {
  while ($true) {
    Start-Sleep -Seconds 1
    foreach ($process in $processes) {
      if ($process.HasExited) {
        throw "Development process exited: PID $($process.Id)"
      }
    }
  }
} finally {
  Stop-DevProcesses
}
