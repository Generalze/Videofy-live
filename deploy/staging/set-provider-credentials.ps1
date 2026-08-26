<#
.SYNOPSIS
  Put the live translation providers' credentials onto the staging server.

.DESCRIPTION
  Prompts for each secret, sends them to the server over SSH, merges them into
  /etc/videofy/media-ingest.env, restarts the services and reports whether the
  translation engine came up real.

  WHY IT PROMPTS INSTEAD OF TAKING ARGUMENTS. A secret passed as a command
  argument is visible in `ps` to every user on the machine and is written to
  PowerShell's history file, where it outlives the session and any rotation.
  Read-Host -AsSecureString keeps it off both. The values then travel INSIDE
  the SSH stream (stdin), never as part of a command line on either end.

  Nothing here writes a credential to disk locally, echoes one, or logs one.
  The remote temp file is shredded whether or not the merge succeeds.

.EXAMPLE
  .\deploy\staging\set-provider-credentials.ps1
  .\deploy\staging\set-provider-credentials.ps1 -Server c7-eu-01
#>
param(
  # Your SSH alias for the Contabo box. c7-admin is the administrative
  # account; credentials should be written by it rather than by a service user.
  [string]$Server = 'c7-admin'
)

$ErrorActionPreference = 'Stop'

function Read-Secret([string]$Prompt) {
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    # Free the unmanaged copy immediately; it is not garbage collected.
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

Write-Host ''
Write-Host 'Live translation providers -> ' -NoNewline
Write-Host $Server -ForegroundColor Cyan
Write-Host 'Values are not echoed and are not stored locally.' -ForegroundColor DarkGray
Write-Host ''

$deepgramKey = Read-Secret 'DEEPGRAM_API_KEY        (recogniser)'
$elevenKey   = Read-Secret 'ELEVENLABS_API_KEY      (voice)'
# NOT a secret, but required: without it media-ingest refuses to start rather
# than picking a voice on your behalf.
$elevenVoice = Read-Host  'ELEVENLABS_DEFAULT_VOICE_ID (from your ElevenLabs voice library)'

if ([string]::IsNullOrWhiteSpace($deepgramKey) -or
    [string]::IsNullOrWhiteSpace($elevenKey) -or
    [string]::IsNullOrWhiteSpace($elevenVoice)) {
  throw 'The first three values are required. Nothing was sent.'
}

# AZURE IS OPTIONAL, and skipping it is a real choice rather than a mistake.
#
# It exists to stand behind ElevenLabs: synthesis is the one pipeline stage
# whose failure a listener hears as SILENCE rather than as degraded output, so
# it is the stage worth having a second vendor for. Without these, the chain has
# nothing behind it and the deployment stays single-vendor -- which works, and
# goes quiet when that vendor does.
Write-Host ''
Write-Host 'Azure speech (optional): the fallback behind ElevenLabs.' -ForegroundColor DarkGray
Write-Host 'Press Enter at the first prompt to skip and stay single-vendor.' -ForegroundColor DarkGray
$azureKey    = Read-Secret 'AZURE_SPEECH_KEY        (leave blank to skip)'
$azureRegion = ''
$azureVoice  = ''
if (-not [string]::IsNullOrWhiteSpace($azureKey)) {
  # Not a secret: it selects the endpoint host. Named here so it is one value
  # rather than a guess repeated in three places.
  $azureRegion = Read-Host 'AZURE_SPEECH_REGION     (e.g. northeurope)'
  $azureVoice  = Read-Host 'AZURE_DEFAULT_VOICE_ID  (e.g. es-ES-ElviraNeural)'
  if ([string]::IsNullOrWhiteSpace($azureRegion) -or [string]::IsNullOrWhiteSpace($azureVoice)) {
    throw 'An Azure key needs a region and a default voice. Nothing was sent.'
  }
}

$translation = Read-Host 'TRANSLATION_PROVIDER [opus-mt]'
if ([string]::IsNullOrWhiteSpace($translation)) { $translation = 'opus-mt' }

$synthesisProvider = if ([string]::IsNullOrWhiteSpace($azureKey)) { 'elevenlabs' } else { 'chain' }

# The exact names the code reads. Selectors travel with the credentials so the
# server can never end up holding a key it is not configured to use.
$lines = @(
  # nova-3, NOT flux. Flux is English-only, so a French or Spanish speaker was
  # simply never recognised -- their partner got captions and silence while the
  # English side worked perfectly, which reads as a broken translator rather
  # than a monolingual recogniser. Nova takes a `language` per session, which
  # is what a translated call needs.
  "STREAMING_TRANSCRIPTION_PROVIDER=deepgram-nova",
  "DEEPGRAM_MODEL=nova-3",
  "DEEPGRAM_API_KEY=$deepgramKey",
  # `chain` is ElevenLabs with Azure behind it; plain `elevenlabs` when no Azure
  # key was given. Chosen HERE, beside the credentials, so the server can never
  # be told to use a fallback it has no key for.
  "STREAMING_SYNTHESIS_PROVIDER=$synthesisProvider",
  "ELEVENLABS_API_KEY=$elevenKey",
  "ELEVENLABS_DEFAULT_VOICE_ID=$elevenVoice",
  "AZURE_SPEECH_KEY=$azureKey",
  "AZURE_SPEECH_REGION=$azureRegion",
  "AZURE_DEFAULT_VOICE_ID=$azureVoice",
  "TRANSLATION_PROVIDER=$translation"
) -join "`n"

# Base64 so no value can be mangled by quoting on the way through two shells,
# whatever characters a vendor puts in a key.
$payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($lines))

$remote = @"
set -euo pipefail
ENV_FILE=/etc/videofy/media-ingest.env
TMP=`$(mktemp)
cleanup() { shred -u "`$TMP" 2>/dev/null || rm -f "`$TMP"; }
trap cleanup EXIT

printf '%s' '$payload' | base64 -d > "`$TMP"

# Replace rather than append: these keys already exist in the file, empty.
# Appending would leave two definitions and let the empty one win depending on
# read order -- which looks exactly like a credential that was never set.
while IFS= read -r line; do
  [ -n "`$line" ] || continue
  key="`${line%%=*}"
  sed -i "/^`${key}=/d" "`$ENV_FILE"
done < "`$TMP"

# A file whose last line has no newline swallows the first appended line onto
# it: TRANSLATION_PROVIDER=opus-mt became
# `TRANSLATION_PROVIDER=opus-mtOPUS_MT_PYTHON=...` and the service refused to
# start. Guarantee the terminator on BOTH sides before joining them.
[ -s "`$ENV_FILE" ] && [ -n "`$(tail -c1 "`$ENV_FILE")" ] && printf '
' >> "`$ENV_FILE"
cat "`$TMP" >> "`$ENV_FILE"
[ -n "`$(tail -c1 "`$ENV_FILE")" ] && printf '
' >> "`$ENV_FILE"

chown root:root "`$ENV_FILE"
chmod 640 "`$ENV_FILE"

systemctl restart videofy-media-ingest videofy-gateway

# Wait for the port, do not guess at a duration. A fixed sleep reported a
# connection refused against a service that was still starting, which reads as
# a failed deploy; and if it never comes up, the crash-loop is the finding.
for attempt in `$(seq 1 30); do
  curl -fsS -o /dev/null http://127.0.0.1:3002/health && break
  sleep 1
done

systemctl is-active videofy-media-ingest videofy-gateway || true
if ! systemctl is-active --quiet videofy-media-ingest; then
  echo '--- media-ingest did NOT start; last errors ---'
  journalctl -u videofy-media-ingest --no-pager -n 40 | grep -iE 'error|refus|throw' | tail -6
  exit 1
fi

echo '--- translation engine ---'
curl -fsS http://127.0.0.1:3002/health | python3 -c "
import sys, json
d = json.load(sys.stdin)
e = d.get('translationEngine', {})
print('  real          :', e.get('real'))
print('  transcription :', e.get('transcription'))
print('  synthesis     :', e.get('synthesis'))
print('  translation   :', e.get('translation'))
if e.get('stubbed'):
    print('  still stubbed :', e['stubbed'])
pairs = d.get('unavailableTranslationPairs') or []
if pairs:
    print('  unavailable pairs:')
    for p in pairs[:5]:
        print('   -', p.get('pair'), '::', p.get('reason'))
"
"@

Write-Host ''
Write-Host 'Sending...' -ForegroundColor DarkGray
$remote | ssh $Server 'sudo bash -s'
$sshExit = $LASTEXITCODE

# Drop the plaintext copies as soon as they are no longer needed, whether or
# not the send worked.
$deepgramKey = $null; $elevenKey = $null; $lines = $null; $payload = $null
[GC]::Collect()

Write-Host ''
if ($sshExit -ne 0) {
  # Two different failures, and saying the wrong one costs real time.
  #
  # It first printed "Done." after an unresolved hostname, when genuinely
  # nothing had been sent. The correction then over-claimed the opposite --
  # "Nothing was written" -- after a run whose credentials HAD been written and
  # whose services HAD restarted, and only the closing health check failed. So
  # this refuses to guess: the output above says which happened.
  Write-Host "ssh to '$Server' exited $sshExit." -ForegroundColor Red
  Write-Host ''
  Write-Host 'Read the output above before re-running:' -ForegroundColor DarkGray
  Write-Host '  - could not resolve host / permission denied -> nothing was written; fix -Server and re-run.' -ForegroundColor DarkGray
  Write-Host '  - systemctl output appeared -> the credentials WERE written and the services restarted;' -ForegroundColor DarkGray
  Write-Host '    only the health check failed. Re-running is safe (it replaces rather than appends).' -ForegroundColor DarkGray
  Write-Host ''
  Write-Host 'Check the service directly with:' -ForegroundColor DarkGray
  Write-Host "  ssh $Server 'systemctl is-active videofy-media-ingest; curl -s http://127.0.0.1:3002/health'" -ForegroundColor DarkGray
  exit 1
}
Write-Host 'Sent. If "real" is still False, the block above names what is missing.' -ForegroundColor DarkGray
