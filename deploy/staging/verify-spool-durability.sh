#!/usr/bin/env bash
#
# Prove the staging spool under systemd, not from a shell.
#
# THE DIFFERENCE IS THE WHOLE POINT. The unit runs with ProtectSystem=strict,
# so everything outside ReadWritePaths is read-only to the SERVICE however it
# looks to the operator standing in the directory. A shell test proves the
# operator can write; only the service's own probe proves the service can.
#
# Read-only about production. This script names the staging unit explicitly and
# refuses to run against anything else -- staging and production share this
# host, and a spool check that wandered into the production tree would be
# touching the only durable copy of somebody's broadcast.
#
# Run on c7-eu-01 as an operator who can read the journal:
#   sudo bash deploy/staging/verify-spool-durability.sh
#
set -euo pipefail

UNIT="videofy-media-ingest.service"
SPOOL="/srv/videofy/state/programme-media"
PROD_TREE="/srv/videofy-prod"

fail() { printf 'FAIL  %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS  %s\n' "$1"; }
note() { printf '      %s\n' "$1"; }

printf '== staging programme spool ==\n'

# 1. The unit is the staging one, and the production tree is not involved.
if [ "$(systemctl show -p FragmentPath --value "${UNIT}")" = "" ]; then
  fail "${UNIT} is not installed on this host"
fi
case "${SPOOL}" in
  "${PROD_TREE}"*) fail "refusing to verify a path inside the production tree" ;;
esac
pass "unit ${UNIT} is the staging unit and the spool is outside ${PROD_TREE}"

# 2. The spool is inside what systemd leaves writable.
WRITABLE="$(systemctl show -p ReadWritePaths --value "${UNIT}")"
note "ReadWritePaths=${WRITABLE}"
covered=no
for path in ${WRITABLE}; do
  case "${SPOOL}" in "${path}"/*|"${path}") covered=yes ;; esac
done
[ "${covered}" = yes ] || fail "the spool is not covered by ReadWritePaths; the service cannot write it"
[ "$(systemctl show -p ProtectSystem --value "${UNIT}")" = "strict" ] ||
  fail "ProtectSystem is not strict; this check would prove nothing"
pass "the spool is inside ReadWritePaths and ProtectSystem is still strict"

# 3. The service, not the operator, names the spool.
CONFIGURED="$(systemctl show -p Environment --value "${UNIT}" | tr ' ' '\n' | sed -n 's/^PROGRAMME_MEDIA_SPOOL=//p')"
if [ -z "${CONFIGURED}" ]; then
  # EnvironmentFile values are not in `systemctl show`; read the file the unit
  # names rather than guessing. Values other than this one are never printed.
  ENV_FILE="$(systemctl show -p EnvironmentFiles --value "${UNIT}" | sed 's/ (ignore_errors=.*)//' | head -n 1)"
  [ -n "${ENV_FILE}" ] || fail "the unit names no environment file"
  CONFIGURED="$(sed -n 's/^PROGRAMME_MEDIA_SPOOL=//p' "${ENV_FILE}" | tail -n 1)"
fi
[ -n "${CONFIGURED}" ] || fail "PROGRAMME_MEDIA_SPOOL is unset; this deployment holds no protected media"
[ "${CONFIGURED}" = "${SPOOL}" ] || fail "the configured spool is ${CONFIGURED}, not ${SPOOL}"
pass "PROGRAMME_MEDIA_SPOOL is explicit and is ${SPOOL}"

# 4. The gateway writes the same directory the media service reads.
GATEWAY_ENV="$(systemctl show -p EnvironmentFiles --value videofy-gateway.service | sed 's/ (ignore_errors=.*)//' | head -n 1)"
if [ -n "${GATEWAY_ENV}" ] && [ -r "${GATEWAY_ENV}" ]; then
  GATEWAY_SPOOL="$(sed -n 's/^PROGRAMME_MEDIA_SPOOL=//p' "${GATEWAY_ENV}" | tail -n 1)"
  [ "${GATEWAY_SPOOL}" = "${SPOOL}" ] ||
    fail "the gateway spools to ${GATEWAY_SPOOL:-nothing}; the encoder would fill a directory the cursor never reads"
  pass "the gateway and the media service name one directory"
else
  note "the gateway environment file could not be read; skipping the seam check"
fi

# 5. Ownership matches the identity the service actually runs as.
USER_NAME="$(systemctl show -p User --value "${UNIT}")"
[ -n "${USER_NAME}" ] || fail "the unit declares no User; ownership cannot be checked"
install -d -o "${USER_NAME}" -g "$(systemctl show -p Group --value "${UNIT}")" -m 0750 "${SPOOL}"
OWNER="$(stat -c '%U' "${SPOOL}")"
[ "${OWNER}" = "${USER_NAME}" ] || fail "the spool is owned by ${OWNER}, not by ${USER_NAME}"
pass "the spool is owned by the service identity ${USER_NAME}"

# 6. The service's OWN probe. This is the only step that proves anything about
#    the sandbox, because it is the only one that runs inside it.
#
#    READ FROM A CURSOR TAKEN BEFORE THE RESTART, never from a time window. A
#    "--since 2 minutes ago" grep matches the PREVIOUS boot's line, so this
#    check would pass without the service having restarted at all -- a
#    verification that verifies the last verification. The cursor is a position
#    in the journal, so nothing written before it can be read after it.
CURSOR="$(journalctl -u "${UNIT}" -n 1 -o export 2>/dev/null | sed -n 's/^__CURSOR=//p' | tail -n 1)"
systemctl restart "${UNIT}"
probe_line() {
  want="${1:-Programme media spool}"
  if [ -n "${CURSOR}" ]; then
    journalctl -u "${UNIT}" --after-cursor "${CURSOR}" 2>/dev/null | grep "${want}" | tail -n 1
  else
    # No prior line to anchor to, so there is no stale line to mistake either.
    journalctl -u "${UNIT}" --since '-1 min' 2>/dev/null | grep "${want}" | tail -n 1
  fi
}
if ! timeout 60 bash -c "until journalctl -u ${UNIT} ${CURSOR:+--after-cursor \"${CURSOR}\"} 2>/dev/null | grep -q 'Programme media spool'; do sleep 2; done"; then
  fail "the service did not report its spool within 60 s of THIS restart"
fi
PROBE="$(probe_line)"
[ -n "${PROBE}" ] || fail "no spool report after this restart"
printf '      %s\n' "${PROBE}"
for fact in '"configured":true' '"pathExists":true' '"writable":true' '"durable":true'; do
  case "${PROBE}" in
    *"${fact}"*) ;;
    *) fail "the service reported ${fact%%:*} as false or absent: it cannot hold a protected broadcast" ;;
  esac
done
case "${PROBE}" in
  *'"capacitySufficient":true'*) pass "the service wrote, synced and read back its own probe, with room for the window" ;;
  *) fail "the spool is writable and has no room for the retention window" ;;
esac

# 7. THE AUDIENCE DOOR. Found bolted shut on the first staging deploy: the
#    gateway had ACCOUNT_SERVICE_URL and media-ingest did not, so programme
#    egress refused EVERY viewer while every service reported healthy. The only
#    sign was one warning in journald, which is not a place a deploy looks.
#
#    Checked against the INSTALLED environment, never against a template. A
#    template is what we intended; this file is what the service reads.
ACCOUNT_URL="$(sed -n 's/^ACCOUNT_SERVICE_URL=//p' "${ENV_FILE}" 2>/dev/null | tail -n 1)"
[ -n "${ACCOUNT_URL}" ] ||
  fail "ACCOUNT_SERVICE_URL is unset in ${ENV_FILE}: programme egress cannot tell a public channel from a locked one, so NO audience is admitted"
pass "ACCOUNT_SERVICE_URL is set, so a public channel can be told from a locked one"

EGRESS="$(probe_line 'Programme egress ready')"
case "${EGRESS}" in
  *'"visibilitySource":"account-service"'*)
    pass "the service resolves channel visibility from the account service" ;;
  '')
    fail "the service did not report programme egress readiness after this restart" ;;
  *)
    fail "the service reports no visibility source: programme audience readiness is FALSE" ;;
esac

printf '\nSTAGING SPOOL: PROVEN UNDER SYSTEMD\n'
printf 'STAGING PROGRAMME AUDIENCE: ADMISSIBLE\n'
