<#
.SYNOPSIS
  Put one secret into one environment file on the box, without it passing
  through the screen, the clipboard, this machine's disk, or any history.

.DESCRIPTION
  The prompt is a PowerShell SecureString, so nothing is echoed while you
  type and nothing lands in PSReadLine history. The value travels over the
  existing SSH connection on STDIN -- never as an argument, so it is not in
  the remote process list either -- and the remote helper writes it into
  the file through a temp file with the same owner and mode.

  Nothing prints the value. The confirmation is the NAME, whether it was
  added or replaced, and how many characters it had.

  Run it from PowerShell, not Git Bash: Git Bash's ssh cannot see the
  Windows ssh-agent on this workstation.

.EXAMPLE
  .\deploy\Set-EnvKey.ps1 -Environment staging -Service media-ingest -Name NAIJALINGO_API_KEY

.EXAMPLE
  .\deploy\Set-EnvKey.ps1 -Environment production -Service account -Name RESEND_API_KEY -Restart

.EXAMPLE
  # Benchmark credentials are isolated: no -Service, no restart, and the only
  # file they can reach is /etc/videofy/bench.env, which nothing serving
  # traffic reads.
  .\deploy\Set-EnvKey.ps1 -Environment benchmark -Name HF_TOKEN
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('staging', 'production', 'benchmark')][string]$Environment,
  # Required for staging and production, forbidden for benchmark. Enforced by
  # Resolve-EnvTarget rather than by attribute, because the rule differs per
  # environment and a wrong combination must fail loudly, not silently pick a
  # default file.
  [ValidateSet('account', 'gateway', 'media-ingest')][string]$Service,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Z_][A-Z0-9_]*$')][string]$Name,
  [string]$SshHost = 'c7-claude',
  [switch]$Restart
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'EnvTarget.ps1')
$targetArgs = @{ Environment = $Environment }
if ($Service) { $targetArgs['Service'] = $Service }
$target = Resolve-EnvTarget @targetArgs
$envFile = $target.EnvFile
$unit = $target.Unit

if ($Environment -eq 'benchmark' -and $Restart) {
  throw 'benchmark has no service to restart: omit -Restart'
}

Write-Host "Target: $SshHost  $envFile  ($Name)" -ForegroundColor Cyan

# --- the helper goes over first, so the secret only ever meets a known script
$helper = Join-Path $PSScriptRoot 'set-env-key.sh'
if (-not (Test-Path $helper)) { throw "missing $helper" }
& scp -q $helper "${SshHost}:/tmp/set-env-key.sh"
if ($LASTEXITCODE -ne 0) { throw 'could not copy the helper to the box' }

# --- the prompt: never echoed, never stored
$secure = Read-Host -Prompt "Paste the value for $Name (it will not be shown)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ([string]::IsNullOrWhiteSpace($plain)) { throw 'nothing entered; nothing was changed' }

  # -NoNewline: a trailing newline would become part of the value and produce
  # an authentication failure that the file itself looks innocent of.
  $plain | & ssh $SshHost "bash /tmp/set-env-key.sh '$envFile' '$Name'"
  if ($LASTEXITCODE -ne 0) { throw "the box refused the write (exit $LASTEXITCODE)" }
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  if (Get-Variable -Name plain -Scope Local -ErrorAction SilentlyContinue) {
    Set-Variable -Name plain -Scope Local -Value $null
  }
  & ssh $SshHost 'rm -f /tmp/set-env-key.sh' | Out-Null
}

if (-not $target.Restartable) {
  # Nothing serving traffic reads this file, so there is nothing to restart and
  # saying "remember to restart" would be a false instruction.
  Write-Host "Benchmark credential stored. No service reads this file." -ForegroundColor Green
}
elseif ($Restart) {
  Write-Host "Restarting $unit ..." -ForegroundColor Cyan
  & ssh $SshHost "sudo -n systemctl restart $unit && sleep 4 && systemctl is-active $unit"
}
else {
  Write-Host "Not restarted. The service reads its environment at start:" -ForegroundColor Yellow
  Write-Host "  ssh $SshHost 'sudo -n systemctl restart $unit'"
}
