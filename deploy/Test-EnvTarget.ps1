<#
.SYNOPSIS
  Prove the secret path resolves where it must and nowhere else.

.DESCRIPTION
  Run with:  pwsh -File .\deploy\Test-EnvTarget.ps1   (or powershell -File)

  WHY THIS EXISTS. The first instruction given to the founder named a
  -EnvFile parameter that does not exist, and the proposed fix -- adding one --
  would have let any caller write a credential to any path on the box. The CTO
  refused it and required a proof instead.

  These assertions are about what CANNOT happen, which is the only kind worth
  writing for a thing that handles secrets.
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'EnvTarget.ps1')

$failures = New-Object System.Collections.Generic.List[string]
function Check([string]$what, [scriptblock]$test) {
  try {
    if (& $test) { Write-Host "  PASS  $what" -ForegroundColor Green }
    else { $failures.Add($what); Write-Host "  FAIL  $what" -ForegroundColor Red }
  }
  catch {
    $failures.Add("$what -- threw: $($_.Exception.Message)")
    Write-Host "  FAIL  $what -- threw: $($_.Exception.Message)" -ForegroundColor Red
  }
}
function CheckThrows([string]$what, [scriptblock]$test) {
  try { & $test | Out-Null; $failures.Add($what); Write-Host "  FAIL  $what (did not throw)" -ForegroundColor Red }
  catch { Write-Host "  PASS  $what" -ForegroundColor Green }
}

Write-Host "`nbenchmark resolves to exactly one file" -ForegroundColor Cyan
Check 'benchmark -> /etc/videofy/bench.env' {
  (Resolve-EnvTarget -Environment benchmark).EnvFile -ceq '/etc/videofy/bench.env'
}
Check 'benchmark has no unit to restart' {
  $t = Resolve-EnvTarget -Environment benchmark
  ($null -eq $t.Unit) -and ($t.Restartable -eq $false)
}
Check 'benchmark never resolves into a live service directory' {
  $f = (Resolve-EnvTarget -Environment benchmark).EnvFile
  ($f -notmatch 'videofy-prod') -and
  ($f -notmatch 'media-ingest') -and ($f -notmatch 'account') -and ($f -notmatch 'gateway')
}

Write-Host "`nno arbitrary path reaches the target" -ForegroundColor Cyan
CheckThrows 'an unknown environment name is refused' {
  Resolve-EnvTarget -Environment '../../etc/passwd'
}
CheckThrows 'an unknown service is refused' {
  Resolve-EnvTarget -Environment staging -Service '../../root/.ssh/authorized_keys'
}
CheckThrows 'benchmark refuses a service (it has none)' {
  Resolve-EnvTarget -Environment benchmark -Service media-ingest
}
CheckThrows 'staging refuses to guess a missing service' {
  Resolve-EnvTarget -Environment staging
}
Check 'no resolved path escapes its directory' {
  $all = @(
    Resolve-EnvTarget -Environment benchmark
    Resolve-EnvTarget -Environment staging -Service media-ingest
    Resolve-EnvTarget -Environment production -Service account
  )
  -not ($all.EnvFile | Where-Object { $_ -match '\.\.' -or $_ -notmatch '^/etc/videofy' })
}

Write-Host "`nexisting staging and production behaviour is unchanged" -ForegroundColor Cyan
Check 'staging media-ingest -> /etc/videofy/media-ingest.env, unit videofy-media-ingest' {
  $t = Resolve-EnvTarget -Environment staging -Service media-ingest
  ($t.EnvFile -ceq '/etc/videofy/media-ingest.env') -and ($t.Unit -ceq 'videofy-media-ingest')
}
Check 'staging gateway keeps its special unit name' {
  (Resolve-EnvTarget -Environment staging -Service gateway).Unit -ceq 'videofy-gateway'
}
Check 'production account -> /etc/videofy-prod/account.env, unit videofy-prod-account' {
  $t = Resolve-EnvTarget -Environment production -Service account
  ($t.EnvFile -ceq '/etc/videofy-prod/account.env') -and ($t.Unit -ceq 'videofy-prod-account')
}
Check 'production and staging remain restartable' {
  (Resolve-EnvTarget -Environment production -Service gateway).Restartable -and
  (Resolve-EnvTarget -Environment staging -Service account).Restartable
}

Write-Host "`nthe secret never reaches an argument or the screen" -ForegroundColor Cyan
$src = Get-Content (Join-Path $PSScriptRoot 'Set-EnvKey.ps1') -Raw
Check 'the value is read as a SecureString' { $src -match 'Read-Host[^\r\n]*-AsSecureString' }
Check 'the value is piped to ssh on stdin, not passed as an argument' {
  ($src -match '\$plain \| & ssh') -and ($src -notmatch 'ssh[^\r\n]*\$plain[^\r\n]*"')
}
Check 'nothing writes the value to the host' {
  -not ($src -match 'Write-(Host|Output)[^\r\n]*\$plain')
}
Check 'the plaintext buffer is zeroed in a finally block' {
  $src -match 'ZeroFreeBSTR'
}

if ($failures.Count -gt 0) {
  Write-Host "`n$($failures.Count) FAILED" -ForegroundColor Red
  exit 1
}
Write-Host "`nall checks passed" -ForegroundColor Green
exit 0
