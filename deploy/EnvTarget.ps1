<#
.SYNOPSIS
  Resolve an environment name to the ONE file a secret may be written to.

.DESCRIPTION
  Separated from Set-EnvKey.ps1 so it can be tested without the test having to
  run the thing that writes secrets. A guard that cannot be exercised without
  performing the dangerous action is a guard nobody exercises.

  THE RULE THIS ENFORCES. Every target is a fixed, enumerated path. The caller
  chooses from a closed set of names; it never supplies a path. An earlier
  design was going to take an -EnvFile parameter, which would have let any
  caller -- or any typo -- write a credential into any file on the box,
  including a service's live environment. The CTO refused it, correctly.

  BENCHMARK IS DELIBERATELY ISOLATED. /etc/videofy/bench.env is read by nothing
  that serves traffic. A benchmark credential landing in media-ingest.env would
  be a Hugging Face token sitting in the process that holds the vendor keys,
  for no reason, forever.
#>

function Resolve-EnvTarget {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('staging', 'production', 'benchmark')]
    [string]$Environment,

    # Meaningless for benchmark, which has no service. Validated below rather
    # than by attribute, because the requirement differs per environment.
    [ValidateSet('account', 'gateway', 'media-ingest')]
    [string]$Service
  )

  if ($Environment -eq 'benchmark') {
    if ($PSBoundParameters.ContainsKey('Service') -and $Service) {
      throw 'benchmark has no service: omit -Service'
    }
    return [pscustomobject]@{
      Environment = 'benchmark'
      # A literal. Nothing the caller supplies reaches this string.
      EnvFile     = '/etc/videofy/bench.env'
      Unit        = $null      # nothing to restart; nothing reads this file live
      Restartable = $false
    }
  }

  if (-not $Service) {
    throw "-Service is required for $Environment"
  }

  $envDir = if ($Environment -eq 'production') { '/etc/videofy-prod' } else { '/etc/videofy' }
  $unit = if ($Environment -eq 'production') { "videofy-prod-$Service" } else { "videofy-$Service" }
  if ($Environment -eq 'staging' -and $Service -eq 'gateway') { $unit = 'videofy-gateway' }

  return [pscustomobject]@{
    Environment = $Environment
    EnvFile     = "$envDir/$Service.env"
    Unit        = $unit
    Restartable = $true
  }
}
