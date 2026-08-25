#!/usr/bin/env bash
#
# Restore a backup -- and, by default, PROVE one restores without touching the
# live database.
#
#   restore-database.sh <dump-file>                 # verify into a scratch database
#   restore-database.sh <dump-file> --into-live     # actual disaster recovery
#
# WHY THE DEFAULT IS A SCRATCH DATABASE. A backup nobody has restored is a
# belief, not a backup, and the usual reason nobody restores one is that the
# only way to try is to overwrite the database everyone is using. So the safe
# path is the default: restore into a throwaway copy, count what came back,
# drop it. That can be run on a Tuesday afternoon against production data with
# nothing at stake, which means it can be run OFTEN, which is the only way the
# proof stays true.
#
# The dangerous path exists too, because during an actual incident somebody
# needs it. It is opt-in, it says what it is about to destroy, and it takes a
# fresh backup of the live database first -- restoring the wrong dump over a
# live database is a recoverable mistake only if the thing you overwrote still
# exists somewhere.
set -uo pipefail

ENV_FILE=${ENV_FILE:-/etc/videofy/account.env}
DUMP=${1:-}
MODE=${2:-}

log() { printf '{"command":"restore-database",%s}\n' "$1"; }

if [ -z "$DUMP" ]; then
  log "\"error\":\"usage: restore-database.sh <dump-file> [--into-live]\""
  exit 2
fi
if [ ! -r "$DUMP" ]; then
  log "\"error\":\"cannot read $DUMP\""
  exit 1
fi

# READ, NOT SOURCED -- see the note in backup-database.sh: this file is a
# systemd EnvironmentFile, not a shell script, and sourcing it is a syntax
# error on any value containing spaces or shell metacharacters.
read_env() {
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

if [ -z "${DATABASE_URL:-}" ]; then
  log "\"error\":\"DATABASE_URL is not set in $ENV_FILE\""
  exit 1
fi

parse_database_url "$DATABASE_URL"
LIVE_DB="$PGDATABASE"
SCRATCH_DB="${LIVE_DB}_restorecheck"

# ---------------------------------------------------------------- live restore
if [ "$MODE" = "--into-live" ]; then
  cat >&2 <<WARNING
--------------------------------------------------------------------------
ABOUT TO OVERWRITE THE LIVE DATABASE: $LIVE_DB

Every row currently in it will be replaced by the contents of:
  $DUMP

A backup of the CURRENT state is taken first, so this is reversible.
--------------------------------------------------------------------------
WARNING
  SAFETY="/srv/videofy/backups/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).dump"
  mkdir -p /srv/videofy/backups
  if ! pg_dump --format=custom --file="$SAFETY" 2>/dev/null; then
    log "\"error\":\"could not back up the current database; refusing to overwrite it\""
    exit 1
  fi
  chmod 600 "$SAFETY"
  log "\"safetyBackup\":\"$SAFETY\""

  # --clean --if-exists drops what it is about to replace. Without it a restore
  # merges into what is already there and the result is neither the backup nor
  # the previous state.
  if pg_restore -d "$LIVE_DB" --clean --if-exists --no-owner --no-privileges \
       "$DUMP" 2>/tmp/pgrestore.err; then
    log "\"restored\":\"$LIVE_DB\",\"from\":\"$DUMP\""
    exit 0
  fi
  log "\"error\":\"restore failed; the safety backup above is your way back. See /tmp/pgrestore.err\""
  exit 1
fi

# ------------------------------------------------------------- proof (default)
# THE SCRATCH DATABASE IS CREATED AS postgres, NOT AS THE SERVICE ROLE.
#
# Creating a database needs CREATEDB, and the alternative to this was granting
# that to the application's own role -- permanently widening what a compromised
# service can do, in order to make a verification script convenient. This runs
# under sudo already, so it can borrow the superuser for the two statements that
# need it and hand ownership straight to the service role.
scratch_as_postgres() {
  sudo -u postgres psql -q -c "$1" >/dev/null 2>&1
}
scratch_as_postgres "DROP DATABASE IF EXISTS $SCRATCH_DB" || true
if ! sudo -u postgres createdb -O "$PGUSER" "$SCRATCH_DB" >/dev/null 2>&1; then
  log "\"error\":\"could not create the scratch database $SCRATCH_DB\""
  exit 1
fi

cleanup() {
  scratch_as_postgres "DROP DATABASE IF EXISTS $SCRATCH_DB" || true
}
trap cleanup EXIT

if ! pg_restore -d "$SCRATCH_DB" --no-owner --no-privileges \
     "$DUMP" 2>/tmp/pgrestore.err; then
  log "\"error\":\"pg_restore failed against the scratch database; see /tmp/pgrestore.err\""
  exit 1
fi

# COUNTING IS THE PROOF. A restore that completes without error but produces an
# empty database is the failure this is looking for, and it is exactly what a
# backup taken against a half-migrated or wrong database yields. Comparing
# against the live counts is what turns "it ran" into "it is the same data".
read_counts() {
  PGDATABASE="$1" psql -tA -F'|' -c "
    SELECT
      (SELECT count(*) FROM accounts),
      (SELECT count(*) FROM organizations),
      (SELECT count(*) FROM organization_memberships),
      (SELECT count(*) FROM organization_invitations)
  " 2>/dev/null
}

LIVE_COUNTS=$(read_counts "$LIVE_DB")
RESTORED_COUNTS=$(read_counts "$SCRATCH_DB")

if [ -z "$RESTORED_COUNTS" ]; then
  log "\"error\":\"the restored database has no readable schema; the dump is not usable\""
  exit 1
fi

log "\"scratch\":\"$SCRATCH_DB\",\"liveCounts\":\"$LIVE_COUNTS\",\"restoredCounts\":\"$RESTORED_COUNTS\",\"from\":\"$DUMP\""

if [ "$LIVE_COUNTS" = "$RESTORED_COUNTS" ]; then
  echo "RESTORE PROVEN: the dump restores to the same row counts as the live database." >&2
  exit 0
fi

# NOT automatically a failure. A dump taken an hour ago legitimately has fewer
# rows than a database that has been used since. Saying so, rather than
# guessing, is the difference between a check somebody trusts and one they
# learn to ignore.
echo "Counts differ. That is expected if the dump predates recent writes; it is a" >&2
echo "problem if the dump is supposed to be current. live=$LIVE_COUNTS restored=$RESTORED_COUNTS" >&2
exit 0
