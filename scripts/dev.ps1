# Videofy Live - start all development services (Windows PowerShell)
$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$PythonExe = Join-Path $Root "services\speech-worker\.venv\Scripts\python.exe"
$LogDir = Join-Path $Root ".videofy-dev-logs"
$GatewayHealthUrl = "http://localhost:3001/health"
$ReadinessTimeoutSeconds = 45
$script:Services = @()
$script:Stopping = $false

$RequiredPorts = @(
  @{ Port = 3001; Name = "Realtime Gateway" },
  @{ Port = 3002; Name = "Media Ingest" },
  @{ Port = 5173; Name = "Listener App" },
  @{ Port = 5174; Name = "Operator App" },
  @{ Port = 8001; Name = "Speech Worker" }
)

function Confirm-PythonVenv {
  if (Test-Path $PythonExe) {
    return
  }

  Write-Host "Python virtual environment is missing." -ForegroundColor Red
  Write-Host "Run these commands first:" -ForegroundColor Yellow
  Write-Host "  cd services\speech-worker"
  Write-Host "  python -m venv .venv"
  Write-Host "  .\.venv\Scripts\python.exe -m pip install -e .[dev]"
  exit 1
}

function Confirm-PortsFree {
  $occupied = @()

  foreach ($entry in $RequiredPorts) {
    $connections = Get-NetTCPConnection -LocalPort $entry.Port -State Listen -ErrorAction SilentlyContinue
    foreach ($connection in $connections) {
      $processName = "unknown"
      try {
        $processName = (Get-Process -Id $connection.OwningProcess -ErrorAction Stop).ProcessName
      } catch {
        $processName = "unknown"
      }
      $occupied += [pscustomobject]@{
        Service = $entry.Name
        Port = $entry.Port
        Pid = $connection.OwningProcess
        ProcessName = $processName
      }
    }
  }

  if ($occupied.Count -gt 0) {
    Write-Host "Cannot start Videofy Live because required ports are already in use:" -ForegroundColor Red
    foreach ($item in $occupied) {
      Write-Host "  $($item.Service) port $($item.Port) is owned by PID $($item.Pid) ($($item.ProcessName))" -ForegroundColor Yellow
    }
    exit 1
  }
}

function New-LogPath {
  param([string] $Name, [string] $Stream)
  $safeName = $Name.ToLowerInvariant() -replace "[^a-z0-9]+", "-"
  return Join-Path $LogDir "$safeName.$Stream.log"
}

function Start-DevProcess {
  param(
    [string] $Name,
    [string] $WorkingDirectory,
    [string] $Command,
    [string] $Arguments
  )

  $stdout = New-LogPath $Name "stdout"
  $stderr = New-LogPath $Name "stderr"

  Write-Host "Starting $Name..." -ForegroundColor Cyan
  $process = Start-Process `
    -FilePath $Command `
    -ArgumentList $Arguments `
    -WorkingDirectory $WorkingDirectory `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden `
    -PassThru

  $service = [pscustomobject]@{
    Name = $Name
    Process = $process
    WorkingDirectory = $WorkingDirectory
    Stdout = $stdout
    Stderr = $stderr
  }

  $script:Services += $service
  Write-Host "  $Name PID $($process.Id)" -ForegroundColor DarkGray
  Write-Host "  logs: $stdout / $stderr" -ForegroundColor DarkGray
}

function Stop-ProcessTree {
  param([System.Diagnostics.Process] $Process)

  if ($null -eq $Process -or $Process.HasExited) {
    return
  }

  Write-Host "Stopping PID $($Process.Id) and child processes..." -ForegroundColor DarkGray
  & taskkill.exe /PID $Process.Id /T /F | Out-Null
}

function Stop-DevProcesses {
  $script:Stopping = $true
  foreach ($service in ($script:Services | Sort-Object { $_.Process.StartTime } -Descending)) {
    Stop-ProcessTree $service.Process
  }
}

function Write-LogTail {
  param([pscustomobject] $Service)

  Write-Host ""
  Write-Host "$($Service.Name) failed. Last log lines:" -ForegroundColor Red
  foreach ($path in @($Service.Stderr, $Service.Stdout)) {
    if (Test-Path $path) {
      Write-Host "--- $path ---" -ForegroundColor Yellow
      Get-Content $path -Tail 40
    }
  }
}

function Wait-ForGateway {
  $deadline = (Get-Date).AddSeconds($ReadinessTimeoutSeconds)

  while ((Get-Date) -lt $deadline) {
    $gateway = $script:Services | Where-Object { $_.Name -eq "Realtime Gateway" } | Select-Object -First 1
    if ($gateway -and $gateway.Process.HasExited) {
      Write-LogTail $gateway
      throw "Realtime Gateway exited before becoming healthy."
    }

    try {
      $response = Invoke-WebRequest -Uri $GatewayHealthUrl -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        Write-Host "Realtime Gateway is healthy." -ForegroundColor Green
        return
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }

  throw "Timed out waiting $ReadinessTimeoutSeconds seconds for $GatewayHealthUrl"
}

function Watch-Processes {
  while ($true) {
    Start-Sleep -Seconds 1
    foreach ($service in $script:Services) {
      if (-not $script:Stopping -and $service.Process.HasExited) {
        Write-LogTail $service
        throw "Development service exited: $($service.Name) (PID $($service.Process.Id), exit code $($service.Process.ExitCode))"
      }
    }
  }
}

trap {
  Stop-DevProcesses
  throw $_
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Confirm-PythonVenv
Confirm-PortsFree

if (-not $env:VITE_SOCKET_TRANSPORT) {
  $env:VITE_SOCKET_TRANSPORT = "polling"
}

Write-Host "Starting Videofy Live development services..." -ForegroundColor Cyan
Write-Host "Logs: $LogDir" -ForegroundColor DarkGray
Write-Host "Browser Socket.IO transport: $($env:VITE_SOCKET_TRANSPORT)" -ForegroundColor DarkGray

try {
  Start-DevProcess "Realtime Gateway" $Root "cmd.exe" "/c npm.cmd run dev -w services/realtime-gateway"
  Wait-ForGateway

  Start-DevProcess "Media Ingest" $Root "cmd.exe" "/c npm.cmd run dev -w services/media-ingest"
  Start-DevProcess "Listener App" $Root "cmd.exe" "/c npm.cmd run dev -w apps/listener-web"
  Start-DevProcess "Operator App" $Root "cmd.exe" "/c npm.cmd run dev -w apps/operator-web"
  Start-DevProcess "Speech Worker" (Join-Path $Root "services\speech-worker") $PythonExe "main.py"

  Write-Host ""
  Write-Host "Services started. Press Ctrl+C to stop all child processes." -ForegroundColor Green
  Write-Host "  Realtime Gateway  http://localhost:3001/health"
  Write-Host "  Media Ingest      http://localhost:3002/health"
  Write-Host "  Listener App      http://localhost:5173"
  Write-Host "  Operator App      http://localhost:5174"
  Write-Host "  Speech Worker     http://localhost:8001/health"

  Watch-Processes
} finally {
  Stop-DevProcesses
}
