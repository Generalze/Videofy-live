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
  # Your SSH alias for the Contabo box.
  [string]$Server = 'c7-eu-01'
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
  throw 'All three values are required. Nothing was sent.'
}

$translation = Read-Host 'TRANSLATION_PROVIDER [opus-mt]'
if ([string]::IsNullOrWhiteSpace($translation)) { $translation = 'opus-mt' }

# The exact names the code reads. Selectors travel with the credentials so the
# server can never end up holding a key it is not configured to use.
$lines = @(
  "STREAMING_TRANSCRIPTION_PROVIDER=deepgram-flux",
  "DEEPGRAM_API_KEY=$deepgramKey",
  "STREAMING_SYNTHESIS_PROVIDER=elevenlabs",
  "ELEVENLABS_API_KEY=$elevenKey",
  "ELEVENLABS_DEFAULT_VOICE_ID=$elevenVoice",
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
cat "`$TMP" >> "`$ENV_FILE"

chown root:root "`$ENV_FILE"
chmod 640 "`$ENV_FILE"

systemctl restart videofy-media-ingest videofy-gateway
sleep 6
systemctl is-active videofy-media-ingest videofy-gateway

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

# Drop the plaintext copies as soon as they are no longer needed.
$deepgramKey = $null; $elevenKey = $null; $lines = $null; $payload = $null
[GC]::Collect()

Write-Host ''
Write-Host 'Done. If "real" is still False, the line above names what is missing.' -ForegroundColor DarkGray
