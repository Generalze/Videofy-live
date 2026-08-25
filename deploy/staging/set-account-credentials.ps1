<#
.SYNOPSIS
  Put the email verification credentials onto the staging account service.

.DESCRIPTION
  Prompts for the Resend key and sending identity, sends them to the server
  over SSH, merges them into /etc/videofy/account.env, restarts the account
  service and reports whether email delivery came up REAL rather than synthetic.

  WHY IT PROMPTS INSTEAD OF TAKING ARGUMENTS. A secret passed as a command
  argument is visible in `ps` to every user on the machine and is written to
  PowerShell's history file, where it outlives the session and any rotation.
  Read-Host -AsSecureString keeps it off both. The values then travel INSIDE
  the SSH stream (stdin), never as part of a command line on either end.

  Nothing here writes a credential to disk locally, echoes one, or logs one.
  The remote temp file is shredded whether or not the merge succeeds.

  WHY IT VALIDATES BEFORE SENDING. The sibling translation script discovered a
  blank DEEPGRAM_MODEL only by crash-looping the service eighteen times. Every
  value the server would refuse is refused HERE, where the cost is a re-prompt
  rather than an outage.

  PHONE IS LEFT ALONE, DELIBERATELY. Termii sender-id registration in Nigeria
  takes weeks, so C7_PHONE_PROVIDER stays synthetic and this script does not
  touch it. That is safe while C7_ENVIRONMENT=staging; in production the
  service REFUSES TO START with any synthetic channel, which is the point.

.EXAMPLE
  .\deploy\staging\set-account-credentials.ps1
  .\deploy\staging\set-account-credentials.ps1 -Server c7-eu-01
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
Write-Host 'Email verification delivery -> ' -NoNewline
Write-Host $Server -ForegroundColor Cyan
Write-Host 'Values are not echoed and are not stored locally.' -ForegroundColor DarkGray
Write-Host ''
Write-Host 'Before running this, the Resend domain must show VERIFIED.' -ForegroundColor DarkGray
Write-Host 'A pending domain accepts the key and then refuses every send.' -ForegroundColor DarkGray
Write-Host ''

$resendKey = Read-Secret 'RESEND_API_KEY          (Resend dashboard -> API Keys)'

if ([string]::IsNullOrWhiteSpace($resendKey)) {
  throw 'RESEND_API_KEY is required. Nothing was sent.'
}
# Resend issues keys prefixed re_. A pasted dashboard URL, an account id or a
# truncated copy all fail this, and all of them would otherwise present as
# "email silently never arrives" -- the hardest failure of the set to diagnose,
# because the service starts perfectly and every send returns an error nobody
# is watching.
if ($resendKey -notmatch '^re_[A-Za-z0-9_-]{10,}$') {
  $resendKey = $null
  throw 'That does not look like a Resend API key (expected re_...). Nothing was sent.'
}

$from = Read-Host 'C7_EMAIL_FROM           e.g. Consummate 7 <verify@consummate7.com>'
if ([string]::IsNullOrWhiteSpace($from)) {
  $resendKey = $null
  throw 'C7_EMAIL_FROM is required. Nothing was sent.'
}
# Must carry a real address. Resend rejects a bare display name, and the
# rejection arrives per-send rather than at boot.
if ($from -notmatch '[^@\s]+@[^@\s]+\.[^@\s]+') {
  $resendKey = $null
  throw 'C7_EMAIL_FROM must contain an address on your VERIFIED Resend domain. Nothing was sent.'
}

$origin = Read-Host 'C7_PUBLIC_ORIGIN        [https://staging.consummate7.com]'
if ([string]::IsNullOrWhiteSpace($origin)) { $origin = 'https://staging.consummate7.com' }
# The same shape the server enforces, checked here so a malformed origin costs
# a re-prompt rather than a refusing service. This string ends up inside a link
# mailed to a real person: a trailing path or a stray space produces a dead
# link, and a wrong host mails somebody else's domain a working token.
if ($origin -notmatch '^https?://[^/\s]+$') {
  $resendKey = $null
  throw 'C7_PUBLIC_ORIGIN must be an absolute scheme://host with NO trailing path or slash. Nothing was sent.'
}

Write-Host ''
Write-Host 'About to write:' -ForegroundColor DarkGray
Write-Host '  C7_EMAIL_PROVIDER = resend' -ForegroundColor DarkGray
Write-Host "  C7_EMAIL_FROM     = $from" -ForegroundColor DarkGray
Write-Host "  C7_PUBLIC_ORIGIN  = $origin" -ForegroundColor DarkGray
Write-Host '  RESEND_API_KEY    = (not shown)' -ForegroundColor DarkGray
Write-Host '  phone channel     = untouched' -ForegroundColor DarkGray
Write-Host ''

# The exact names the code reads. The SELECTOR travels with the credential, so
# the server can never end up holding a key it is not configured to use -- nor
# configured for a provider whose key never arrived.
$lines = @(
  "C7_EMAIL_PROVIDER=resend",
  "RESEND_API_KEY=$resendKey",
  "C7_EMAIL_FROM=$from",
  "C7_PUBLIC_ORIGIN=$origin"
) -join "`n"

# Base64 so no value can be mangled by quoting on the way through two shells,
# whatever characters a vendor puts in a key or a display name.
$payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($lines))

$remote = @"
set -euo pipefail
ENV_FILE=/etc/videofy/account.env
TMP=`$(mktemp)
cleanup() { shred -u "`$TMP" 2>/dev/null || rm -f "`$TMP"; }
trap cleanup EXIT

if [ ! -f "`$ENV_FILE" ]; then
  echo "`$ENV_FILE does not exist. Run install.sh first; this script configures, it does not provision."
  exit 1
fi

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
# it: TRANSLATION_PROVIDER=opus-mt once became
# `TRANSLATION_PROVIDER=opus-mtOPUS_MT_PYTHON=...` and the service refused to
# start. Guarantee the terminator on BOTH sides before joining them.
[ -s "`$ENV_FILE" ] && [ -n "`$(tail -c1 "`$ENV_FILE")" ] && printf '\n' >> "`$ENV_FILE"
cat "`$TMP" >> "`$ENV_FILE"
[ -n "`$(tail -c1 "`$ENV_FILE")" ] && printf '\n' >> "`$ENV_FILE"

# systemd reads EnvironmentFile as root BEFORE dropping to User=videofy, so the
# service does not need to read this itself. Group-read is kept because the
# template documents root:videofy, and nothing outside that group may see it.
chown root:videofy "`$ENV_FILE"
chmod 640 "`$ENV_FILE"

systemctl restart videofy-account

# Wait for the port, do not guess at a duration. A fixed sleep reports a
# connection refused against a service that was still starting, which reads as
# a failed deploy; and if it never comes up, the crash-loop is the finding.
for attempt in `$(seq 1 30); do
  curl -fsS -o /dev/null http://127.0.0.1:3006/health && break
  sleep 1
done

if ! systemctl is-active --quiet videofy-account; then
  echo '--- videofy-account did NOT start; last errors ---'
  journalctl -u videofy-account --no-pager -n 40 | grep -iE 'error|refus|throw|must be' | tail -8
  exit 1
fi

# /health reports liveness only -- it says nothing about WHICH provider was
# selected, so a synthetic service answers it exactly as a real one does. The
# boot line is the only place that distinguishes them, which is why this reads
# the log rather than trusting a 200.
echo '--- verification delivery ---'
journalctl -u videofy-account --no-pager -n 200 \
  | grep -F 'Verification providers selected' | tail -1 \
  | sed 's/^[^{]*//' \
  | python3 -c "
import sys, json
raw = sys.stdin.read().strip()
if not raw:
    print('  no provider line in the log; check: journalctl -u videofy-account -n 50')
    raise SystemExit(1)
d = json.loads(raw)
email = d.get('email', {})
phone = d.get('phone', {})
print('  environment   :', d.get('environment'))
print('  email provider:', email.get('provider'))
print('  email config  :', email.get('configuration'))
print('  phone provider:', phone.get('provider'), '(left synthetic on purpose)')
if email.get('provider') != 'resend' or email.get('configuration') != 'credentials-present':
    print('')
    print('  EMAIL IS NOT LIVE. Nothing will be delivered and nobody can verify an address.')
    raise SystemExit(1)
print('')
print('  email delivery is REAL.')
"
"@

Write-Host 'Sending...' -ForegroundColor DarkGray
$remote | ssh $Server 'sudo bash -s'
$sshExit = $LASTEXITCODE

# Drop the plaintext copies as soon as they are no longer needed, whether or
# not the send worked.
$resendKey = $null; $lines = $null; $payload = $null; $remote = $null
[GC]::Collect()

Write-Host ''
if ($sshExit -ne 0) {
  # Two different failures, and saying the wrong one costs real time. This
  # refuses to guess: the output above says which happened.
  Write-Host "ssh to '$Server' exited $sshExit." -ForegroundColor Red
  Write-Host ''
  Write-Host 'Read the output above before re-running:' -ForegroundColor DarkGray
  Write-Host '  - could not resolve host / permission denied -> nothing was written; fix -Server and re-run.' -ForegroundColor DarkGray
  Write-Host '  - systemctl output appeared -> the credentials WERE written and the service restarted;' -ForegroundColor DarkGray
  Write-Host '    only the reporting failed. Re-running is safe (it replaces rather than appends).' -ForegroundColor DarkGray
  Write-Host '  - "EMAIL IS NOT LIVE" -> the values were written but did not select resend.' -ForegroundColor DarkGray
  exit $sshExit
}

Write-Host 'Done.' -ForegroundColor Green
Write-Host ''
Write-Host 'Next, prove it end to end -- a service that STARTED is not a mail that ARRIVED:' -ForegroundColor DarkGray
Write-Host '  1. Register a real address you can open.' -ForegroundColor DarkGray
Write-Host '  2. Confirm the mail arrives, and lands in the inbox rather than spam.' -ForegroundColor DarkGray
Write-Host '  3. Follow the link and confirm the account turns verified.' -ForegroundColor DarkGray
Write-Host '  A send that Resend accepts can still be rejected by the recipient;' -ForegroundColor DarkGray
Write-Host '  DKIM missing or a pending domain both present exactly that way.' -ForegroundColor DarkGray
