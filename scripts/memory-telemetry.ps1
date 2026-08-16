# Once-per-second memory telemetry for the P6.3 harness-crash investigation.
#
# The question this must answer is narrow: when a crash happens, was the MACHINE
# out of memory, or did one process die while the machine was fine? Reading free
# RAM after the heavy processes have exited cannot distinguish those, which is
# how the first diagnosis went wrong.
param(
    [string]$OutFile = ".openvoice-evidence/memory-telemetry.jsonl"
)

New-Item -ItemType Directory -Force -Path (Split-Path $OutFile) | Out-Null

while ($true) {
    $os = Get-CimInstance Win32_OperatingSystem
    $freeMB = [math]::Round($os.FreePhysicalMemory / 1KB, 0)
    $totalMB = [math]::Round($os.TotalVisibleMemorySize / 1KB, 0)
    $commitMB = [math]::Round(($os.TotalVirtualMemorySize - $os.FreeVirtualMemory) / 1KB, 0)
    $commitLimitMB = [math]::Round($os.TotalVirtualMemorySize / 1KB, 0)

    $nodes = @(Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
        @{ pid = $_.Id; ws = [math]::Round($_.WorkingSet64 / 1MB, 0); priv = [math]::Round($_.PrivateMemorySize64 / 1MB, 0) }
    })
    $pythons = @(Get-Process python -ErrorAction SilentlyContinue | ForEach-Object {
        @{ pid = $_.Id; ws = [math]::Round($_.WorkingSet64 / 1MB, 0); priv = [math]::Round($_.PrivateMemorySize64 / 1MB, 0) }
    })
    $claude = Get-Process claude -ErrorAction SilentlyContinue | Select-Object -First 1

    $vram = try { (nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>$null | Select-Object -First 1) } catch { $null }

    $record = [ordered]@{
        t              = (Get-Date).ToString('HH:mm:ss')
        freeMB         = $freeMB
        totalMB        = $totalMB
        commitMB       = $commitMB
        commitLimitMB  = $commitLimitMB
        nodeCount      = $nodes.Count
        nodeTotalWsMB  = ($nodes | ForEach-Object { $_.ws } | Measure-Object -Sum).Sum
        nodeMaxWsMB    = ($nodes | ForEach-Object { $_.ws } | Measure-Object -Maximum).Maximum
        nodes          = $nodes
        pythonTotalWsMB = ($pythons | ForEach-Object { $_.ws } | Measure-Object -Sum).Sum
        pythons        = $pythons
        claudeWsMB     = if ($claude) { [math]::Round($claude.WorkingSet64 / 1MB, 0) } else { $null }
        vramMB         = $vram
    }
    ($record | ConvertTo-Json -Compress -Depth 4) | Add-Content -Path $OutFile -Encoding utf8
    Start-Sleep -Seconds 1
}
