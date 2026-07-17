# Videofy Live – start all development services (Windows PowerShell)
$ErrorActionPreference = "Stop"

$processes = @()

Write-Host "Starting Videofy Live development services..." -ForegroundColor Cyan

$processes += Start-Process -PassThru -NoNewWindow powershell -ArgumentList `
  "-Command", "npm run dev -w services/realtime-gateway"

$processes += Start-Process -PassThru -NoNewWindow powershell -ArgumentList `
  "-Command", "npm run dev -w services/media-ingest"

$processes += Start-Process -PassThru -NoNewWindow powershell -ArgumentList `
  "-Command", "npm run dev -w apps/listener-web"

$processes += Start-Process -PassThru -NoNewWindow powershell -ArgumentList `
  "-Command", "npm run dev -w apps/operator-web"

Write-Host "All services started. Press Ctrl+C to stop." -ForegroundColor Green
Write-Host "  Listener  →  http://localhost:5173" -ForegroundColor Green
Write-Host "  Operator  →  http://localhost:5174" -ForegroundColor Green
Write-Host "  Gateway   →  http://localhost:3001" -ForegroundColor Green

try {
  $processes | Wait-Process
} finally {
  $processes | ForEach-Object { $_.Kill() }
}
