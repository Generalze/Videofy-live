#!/usr/bin/env bash
#
# Back up the account database.
#
# WHAT A BACKUP ON THE SAME DISK PROTECTS AGAINST: an accidental DROP TABLE, a
# bad migration, somebody deleting the wrong rows. Real failures, worth having.
#
# WHAT IT DOES NOT PROTECT AGAINST: losing the disk, losing the machine, the
# provider losing the machine, or anything that encrypts both at once. Those
# are the failures that end a company rather than a bad afternoon, and only an
# OFF-BOX copy survives them.
#
# So this script writes locally and then, if a destination is configured,
# copies off the box. The destination is DELIBERATELY UNSET for now: the owner
# has not chosen where off-box copies live. Rather than pretend that decision
# has been made, the script says loudly, on every run, that the backup it just
# took would not survive losing this machine.
#
# It exits 0 in that state on purpose. A cron job that fails every night is a
# cron job whose failures stop being read within a week, and then a real failure
# is invisible among them. The warning is in the output and in the exit
# ANNOTATION, not in a red exit code that trains people to ignore it.
#
#   BACKUP_OFF_BOX_TARGET   rclone remote, e.g. "b2:c7-backups/account"
#                           Unset means local-only, with the warning above.
#   BACKUP_RETAIN_DAYS      how long local dumps are kept (default 14)
#   DATABASE_URL            read from /etc/videofy/account.env
set -uo pipefail

ENV_FILE=${ENV_FILE:-/etc/videofy/account.env}
BACKUP_DIR=${BACKUP_DIR:-/srv/videofy/backups}
RETAIN_DAYS=${BACKUP_RETAIN_DAYS:-14}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TARGET="$BACKUP_DIR/account-$STAMP.dump"

log() { printf '{"command":"backup-database",%s}\n' "$1"; }

if [ ! -r "$ENV_FILE" ]; then
  log "\"error\":\"cannot read $ENV_FILE\""
  exit 1
fi

# READ, NOT SOURCED.
#
# /etc/videofy/account.env is a systemd EnvironmentFile, and that format is NOT
# shell syntax. systemd is perfectly happy with
#   C7_EMAIL_FROM=Consummate 7 <no-reply@consummate7.com>
# and `.` on the same line is a syntax error on the unquoted spaces and the
# redirection characters. Sourcing it aborted the script before it reached the
# variable it wanted -- so the value is extracted directly instead.
#
# The URL CONTAINS THE PASSWORD, so it is handed to pg_dump through the
# PGDATABASE environment variable rather than as --dbname. A command argument
# is visible in `ps` to every user on the machine for as long as the dump runs,
# and a dump is not quick. libpq treats a value beginning with a connection URI
# scheme as a full conninfo string, so this is the same connection by a route
# that does not publish the credential.
read_env() {
  # cut -d= -f2- keeps everything after the FIRST '=', so a password containing
  # '=' survives intact.
  grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2-
}
DATABASE_URL=$(read_env DATABASE_URL)
# Split the URL into libpq's own environment variables.
#
# PGDATABASE takes a database NAME, not a connection URI -- passing a full
# postgres:// URL through it makes libpq ignore the host, the user and the
# password entirely and connect to the local socket as whoever is running the
# script. That failed loudly here as 'role "root" does not exist'; against a
# machine where a root role happened to exist it would have connected to the
# WRONG DATABASE and backed that up instead.
#
# So the URL is decomposed. Only the password is secret, and it travels in the
# environment; the rest may safely be argv, and in fact is not passed at all
# because libpq reads these directly.
parse_database_url() {
  local url="$1" rest creds hostpart hostport
  rest="${url#*://}"
  creds="${rest%%@*}"
  hostpart="${rest#*@}"
  export PGUSER="${creds%%:*}"
  export PGPASSWORD="${creds#*:}"
  hostport="${hostpart%%/*}"
  export PGHOST="${hostport%%:*}"
  if [ "$hostport" = "$PGHOST" ]; then export PGPORT=5432; else export PGPORT="${hostport#*:}"; fi
  local db="${hostpart#*/}"
  export PGDATABASE="${db%%\?*}"
}
BACKUP_OFF_BOX_TARGET=${BACKUP_OFF_BOX_TARGET:-$(read_env BACKUP_OFF_BOX_TARGET)}

if [ -z "${DATABASE_URL:-}" ]; then
  log "\"error\":\"DATABASE_URL is not set in $ENV_FILE; nothing to back up\""
  exit 1
fi

parse_database_url "$DATABASE_URL"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# --format=custom, not plain SQL. It compresses, it can be restored selectively,
# and pg_restore can read it in parallel. Plain SQL is only easier to read, and
# nobody reads a backup -- they restore it.
if ! pg_dump --format=custom --no-owner --no-privileges \
     --file="$TARGET" 2>/tmp/pgdump.err; then
  # The vendor error may contain the connection string, which contains the
  # password. Report that it failed and where to look, never the message.
  log "\"error\":\"pg_dump failed; see /tmp/pgdump.err on the host\""
  rm -f "$TARGET"
  exit 1
fi
rm -f /tmp/pgdump.err
chmod 600 "$TARGET"

SIZE=$(stat -c %s "$TARGET")
# A dump far smaller than expected is the shape of a backup taken against an
# empty or half-migrated database, which is worse than no backup because it
# looks like one. 5 KB is below anything a real schema produces.
if [ "$SIZE" -lt 5120 ]; then
  log "\"warning\":\"dump is only ${SIZE} bytes, which is too small to be a real database\",\"file\":\"$TARGET\""
fi

# --------------------------------------------------------------------- off box
OFF_BOX_STATE="not-configured"
if [ -n "${BACKUP_OFF_BOX_TARGET:-}" ]; then
  if ! command -v rclone >/dev/null 2>&1; then
    OFF_BOX_STATE="rclone-missing"
  elif rclone copy "$TARGET" "$BACKUP_OFF_BOX_TARGET" --quiet; then
    OFF_BOX_STATE="copied"
  else
    OFF_BOX_STATE="failed"
  fi
fi

# ------------------------------------------------------------------- retention
# Only local copies are pruned. Whatever is off box is governed by that store's
# own lifecycle rules, and deleting remote copies from the machine being backed
# up would mean a compromise of this machine can also destroy its backups --
# which is the entire scenario off-box copies exist for.
DELETED=$(find "$BACKUP_DIR" -name 'account-*.dump' -type f -mtime "+$RETAIN_DAYS" -print -delete | wc -l)

log "\"file\":\"$TARGET\",\"bytes\":$SIZE,\"offBox\":\"$OFF_BOX_STATE\",\"prunedLocal\":$DELETED,\"retainDays\":$RETAIN_DAYS"

if [ "$OFF_BOX_STATE" = "not-configured" ]; then
  cat >&2 <<'WARNING'
--------------------------------------------------------------------------
THIS BACKUP WOULD NOT SURVIVE LOSING THIS MACHINE.

BACKUP_OFF_BOX_TARGET is unset, so the only copy of the database is on the
same disk as the database. That protects against a bad migration or a
mistaken delete. It does not protect against losing the disk, losing the
server, or anything that reaches both at once.

Set BACKUP_OFF_BOX_TARGET in /etc/videofy/account.env to an rclone remote
once a destination has been chosen, and run restore-database.sh to prove a
restore actually works before trusting any of this.
--------------------------------------------------------------------------
WARNING
fi

if [ "$OFF_BOX_STATE" = "failed" ] || [ "$OFF_BOX_STATE" = "rclone-missing" ]; then
  # Configured and not working IS a failure. Somebody asked for off-box copies
  # and is not getting them, which is worse than never having asked.
  exit 1
fi
exit 0
