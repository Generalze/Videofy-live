#!/usr/bin/env bash
# @author masterzee001
#
# Videofy Live -- PRODUCTION install on c7-eu-01. Idempotent: safe to re-run.
#
# Production is a SECOND ENVIRONMENT ON THE SAME BOX as staging, isolated by
# tree (/srv/videofy-prod), env dir (/etc/videofy-prod), unit names
# (videofy-prod-*), loopback ports (31xx), database (videofy_account_prod) and
# web root. It shares the box, the service user, the Postgres cluster, coturn,
# Caddy, the Python runtime and the model cache -- every one of those is named
# below with what "shared" means for it.
#
# What this does NOT do: put a vendor credential anywhere, start a service, or
# print a secret. Internal secrets are generated HERE, written straight into
# the env file the service reads, and never transit a terminal or a report.
# Vendor keys (Resend, Termii, Deepgram, ...) are the founder's to add by
# editing /etc/videofy-prod/*.env on the box.
#
#   sudo bash deploy/production/install.sh
#
#   DEPLOY_OWNER=<user>   who owns the tree and web root (default: the sudo caller)
#   SKIP_TURN=1           do not touch coturn (it is shared with staging and a
#                         restart drops live relays for a second)
#   SKIP_CADDY=1          do not touch Caddy (same reason)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/env.sh
. "$HERE/../lib/env.sh"
# shellcheck source=../lib/turn-guard.sh
. "$HERE/../lib/turn-guard.sh"
videofy_env production

if [[ $EUID -ne 0 ]]; then echo "run with sudo" >&2; exit 1; fi
DEPLOY_OWNER="${DEPLOY_OWNER:-${SUDO_USER:-root}}"
SVC="$VIDEOFY_SERVICE_USER"

# --- service account (shared with staging; isolation is by path, not uid) --
if ! id -u "$SVC" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC"
  echo "created service user: $SVC"
fi

# --- directories -----------------------------------------------------------
install -d -o root -g root -m 0755 "$VIDEOFY_ROOT"
install -d -o "$SVC" -g "$SVC" -m 0750 \
  "$VIDEOFY_STATE_DIR" "$VIDEOFY_STATE_DIR/call-transcripts" \
  "$VIDEOFY_UPLOAD_DIR" "$VIDEOFY_UPLOAD_DIR/webrtc-staging" \
  "$VIDEOFY_UPLOAD_DIR/audio-chunks" "$VIDEOFY_UPLOAD_DIR/media-ingest"
install -d -o root -g root -m 0755 "$VIDEOFY_MEDIA_DIR"
install -d -o "$SVC" -g "$SVC" -m 0750 \
  "$VIDEOFY_MEDIA_DIR/avatars" "$VIDEOFY_MEDIA_DIR/message-media" "$VIDEOFY_MEDIA_DIR/channel-media"
install -d -o root -g root -m 0700 "$VIDEOFY_BACKUP_DIR"
# Written by the deployer (stage-webapps runs unprivileged), read by Caddy.
install -d -o "$DEPLOY_OWNER" -g root -m 0755 "$VIDEOFY_WWW_DIR"
install -d -o caddy -g caddy -m 0755 /var/log/caddy
# The LOG FILE too, not merely its directory. `caddy validate` never opens a
# log file, so a root-owned one passes validation and then fails the restart
# with "permission denied" -- which is how a valid configuration took the
# public site down for two minutes. Created here, owned by the user that
# writes it.
for logname in videofy videofy-prod; do
  install -o caddy -g caddy -m 0640 /dev/null "/var/log/caddy/$logname.log" 2>/dev/null ||     chown caddy:caddy "/var/log/caddy/$logname.log"
done

# The application tree: an empty repository that deploy.sh fetches bundles
# into. Owned by the deployer (who writes it), group videofy (who reads it).
if [[ ! -d "$VIDEOFY_APP_DIR/.git" ]]; then
  install -d -o "$DEPLOY_OWNER" -g "$SVC" -m 0750 "$VIDEOFY_APP_DIR"
  sudo -u "$DEPLOY_OWNER" git -C "$VIDEOFY_APP_DIR" init -q
  echo "initialised empty tree: $VIDEOFY_APP_DIR (deploy.sh production <ref> fills it)"
fi

# Shared read-only inputs must already exist; production does not install them.
for shared in "$VIDEOFY_MODELS_DIR/silero_vad.onnx" "$VIDEOFY_AI_PYTHON"; do
  [[ -e "$shared" ]] || { echo "missing shared input: $shared (run deploy/staging/install-translation-models.sh first)" >&2; exit 1; }
done
echo "shared read-only: $VIDEOFY_MODELS_DIR, $(dirname "$(dirname "$VIDEOFY_AI_PYTHON")")"

# --- environment files -----------------------------------------------------
install -d -o root -g "$SVC" -m 0750 "$VIDEOFY_ENV_DIR"
for svc in account gateway media-ingest; do
  target="$VIDEOFY_ENV_DIR/$svc.env"
  if [[ ! -f "$target" ]]; then
    install -o root -g "$SVC" -m 0640 "$HERE/env-templates/$svc.env.template" "$target"
    echo "installed template: $target"
  else
    chown "root:$SVC" "$target"; chmod 0640 "$target"
    echo "kept existing: $target"
  fi
done

# --- internal secrets, generated in place ------------------------------------
# Only where the line is still empty; the value is written with sed into every
# file that must carry it and is never echoed. Values are hex, so sed is safe.
fill_secret() {
  local name="$1" generator="$2"; shift 2
  local needed=0 f value
  for f in "$@"; do grep -qE "^${name}=$" "$f" && needed=1; done
  if [[ $needed -eq 1 ]]; then
    value="$($generator)"
    for f in "$@"; do sed -i "s|^${name}=$|${name}=${value}|" "$f"; done
    unset value
    echo "generated ${name} (value not displayed)"
  else
    echo "${name} already set; left alone"
  fi
}
hex32() { openssl rand -hex 32; }
hex24() { openssl rand -hex 24; }
hex16() { openssl rand -hex 16; }
keyring() { printf 'k1:%s:current' "$(openssl rand -hex 32)"; }

A="$VIDEOFY_ENV_DIR/account.env"; G="$VIDEOFY_ENV_DIR/gateway.env"; M="$VIDEOFY_ENV_DIR/media-ingest.env"
fill_secret INTERNAL_WEBRTC_TOKEN      hex32   "$G" "$M" "$A"
fill_secret VIDEOFY_AUTH_SECRET        hex32   "$G" "$A" "$M"
fill_secret CONNECT_AUTH_SECRET        hex32   "$G"
fill_secret CHANNEL_ID_SALT            hex16   "$G"
fill_secret C7_IDENTITY_CALLBACK_SECRET hex32  "$A"
fill_secret C7_MFA_KEYRING             keyring "$A"
fill_secret C7_MFA_RECOVERY_PEPPER     hex32   "$A"
fill_secret C7_SECURITY_TARGET_SALT    hex24   "$A"

# --- database: own role + own database in the shared cluster ---------------
# The password is generated here, handed to psql on STDIN (never argv, never
# `ps`), and written straight into DATABASE_URL. Nothing prints it. If the
# cluster logs every statement (log_statement=all; it does not by default),
# the CREATE/ALTER ROLE line would land in the Postgres log -- check before
# turning that on.
if grep -qE '^DATABASE_URL=$' "$A"; then
  pw="$(openssl rand -hex 24)"
  if sudo -u postgres psql -Atqc "select 1 from pg_roles where rolname='${VIDEOFY_DB_ROLE}'" | grep -q 1; then
    printf "ALTER ROLE %s WITH LOGIN PASSWORD '%s';\n" "$VIDEOFY_DB_ROLE" "$pw" | sudo -u postgres psql -q -v ON_ERROR_STOP=1
    echo "role ${VIDEOFY_DB_ROLE} existed; password reset (value not displayed)"
  else
    printf "CREATE ROLE %s WITH LOGIN PASSWORD '%s';\n" "$VIDEOFY_DB_ROLE" "$pw" | sudo -u postgres psql -q -v ON_ERROR_STOP=1
    echo "created role ${VIDEOFY_DB_ROLE} (password not displayed)"
  fi
  if ! sudo -u postgres psql -Atqc "select 1 from pg_database where datname='${VIDEOFY_DB_NAME}'" | grep -q 1; then
    sudo -u postgres createdb -O "$VIDEOFY_DB_ROLE" "$VIDEOFY_DB_NAME"
    echo "created database ${VIDEOFY_DB_NAME} owned by ${VIDEOFY_DB_ROLE}"
  fi
  sed -i "s|^DATABASE_URL=$|DATABASE_URL=postgres://${VIDEOFY_DB_ROLE}:${pw}@127.0.0.1:5432/${VIDEOFY_DB_NAME}|" "$A"
  unset pw
  echo "wrote DATABASE_URL into $A (value not displayed)"
else
  echo "DATABASE_URL already set; database left alone"
fi

# --- TURN: the shared coturn with a SECOND static secret ---------------------
# coturn accepts several `static-auth-secret=` lines and tries each when it
# checks a REST-API credential (turnserver --help: "Multiple shared secrets can
# be used"). So production gets its own secret without a second daemon, a
# second port or a second realm: the realm is an authentication label the
# gateway never reads, and staging's credentials keep working unchanged.
#
# FOUNDER RULING, LOCKED 30 Aug 2026: "TURN is NEVER behind the ordinary
# Cloudflare proxy: either the proven direct-origin arrangement
# (169.58.215.77) or an optional DNS-only turn.consummate7.com A record."
# BOTH arrangements are supported and neither is assumed. The value the
# GATEWAY reads is TURN_HOST in gateway.env (ice-credentials.ts uses it
# verbatim as the host of `turn:<host>:<port>`); turn.env below records the
# default this installer seeds. The guard runs against the gateway's value and
# REFUSES the install if it is a Cloudflare address -- see the guard block
# after the coturn registration.
TURN_ENV="$VIDEOFY_ENV_DIR/turn.env"
if [[ ! -f "$TURN_ENV" ]]; then
  ( umask 077; printf 'TURN_STATIC_AUTH_SECRET=%s\nTURN_HOST=%s\n' "$(openssl rand -hex 32)" "$VIDEOFY_TURN_ORIGIN_IP" > "$TURN_ENV" )
  chown root:root "$TURN_ENV"; chmod 0640 "$TURN_ENV"
  echo "generated production TURN secret into $TURN_ENV (value not displayed)"
fi
turn_secret="$(grep '^TURN_STATIC_AUTH_SECRET=' "$TURN_ENV" | cut -d= -f2-)"
sed -i "s|^TURN_STATIC_AUTH_SECRET=$|TURN_STATIC_AUTH_SECRET=${turn_secret}|" "$G"
if [[ "${SKIP_TURN:-0}" != "1" ]]; then
  if ! grep -qF -- "static-auth-secret=${turn_secret}" /etc/turnserver.conf; then
    # After the existing line, so the file reads staging-then-production.
    sed -i "0,/^static-auth-secret=/s|^\(static-auth-secret=.*\)$|\1\nstatic-auth-secret=${turn_secret}|" /etc/turnserver.conf
    systemctl restart coturn
    echo "coturn: added production static-auth-secret and restarted (staging relays reconnect)"
  else
    echo "coturn: production secret already present"
  fi
else
  echo "coturn: skipped (SKIP_TURN=1); add the secret from $TURN_ENV as a second static-auth-secret line"
fi
unset turn_secret

# --- TURN host: refuse the proxied hostname, accept either ruled arrangement -
# Read from gateway.env because that is the ONLY value the gateway actually
# dials with. A comment in the template cannot stop a hostname pasted here at
# 2am; this can, and it runs on every re-install.
turn_host="$(sed -n 's/^TURN_HOST=//p' "$G" | tail -1 | tr -d '"'"'"' \r')"
set +e
videofy_turn_guard "$turn_host" "TURN_HOST in $G"
turn_rc=$?
set -e
if [[ $turn_rc -eq 1 ]]; then
  echo "INSTALL FAILED: TURN_HOST in $G would send relay traffic through the Cloudflare proxy." >&2
  echo "Set it to $VIDEOFY_TURN_ORIGIN_IP, or to a DNS-ONLY turn.consummate7.com A record, and re-run." >&2
  exit 1
fi
if [[ $turn_rc -eq 2 ]]; then
  echo "warn: TURN_HOST is empty in $G -- calls that need a relay will fail. Set it before launch."
fi
unset turn_host turn_rc

# --- backup script + units --------------------------------------------------
# The staging script is environment-agnostic (ENV_FILE / BACKUP_DIR); install
# it if it is not there yet, never overwrite a newer one.
if [[ ! -x /usr/local/bin/backup-database.sh && -f "$HERE/../staging/backup-database.sh" ]]; then
  install -o root -g root -m 0755 "$HERE/../staging/backup-database.sh" /usr/local/bin/backup-database.sh
fi

# Preflight: does each unit's entrypoint exist? Before the first deploy it
# cannot, so this warns rather than fails; after a deploy a wrong ExecStart
# would become a restart loop full of MODULE_NOT_FOUND.
for unit in "$HERE"/systemd/videofy-prod-*.service; do
  entry="$(sed -n 's|^ExecStart=/usr/bin/node ||p' "$unit")"
  workdir="$(sed -n 's|^WorkingDirectory=||p' "$unit")"
  [[ -z "$entry" ]] && continue
  if [[ ! -f "$workdir/$entry" ]]; then
    echo "preflight: $(basename "$unit") entry $workdir/$entry does not exist yet (deploy first)"
  fi
done

install -o root -g root -m 0644 "$HERE"/systemd/videofy-prod-*.service "$HERE"/systemd/videofy-prod-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable -q videofy-prod-backup.timer
echo "installed units: $(cd "$HERE"/systemd && ls videofy-prod-* | tr '\n' ' ')"

# --- Caddy: both hostnames in one file --------------------------------------
install -d -o root -g root -m 0755 /etc/systemd/system/caddy.service.d
install -o root -g root -m 0644 "$HERE/../staging/systemd/caddy.service.d/videofy.conf" /etc/systemd/system/caddy.service.d/videofy.conf
systemctl daemon-reload
touch /etc/default/caddy
if ! grep -q '^VIDEOFY_PROD_SITE_ADDRESS=' /etc/default/caddy; then
  printf 'VIDEOFY_PROD_SITE_ADDRESS=%s\n' "$VIDEOFY_PUBLIC_HOST" >> /etc/default/caddy
fi
if [[ "${SKIP_CADDY:-0}" != "1" ]]; then
  if ! cmp -s "$HERE/Caddyfile" /etc/caddy/Caddyfile; then
    cp -p /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-$(date -u +%Y%m%d%H%M%S)"
    install -o root -g root -m 0644 "$HERE/Caddyfile" /etc/caddy/Caddyfile
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
    # `admin off` means reload is impossible; a restart is milliseconds.
    systemctl restart caddy
    echo "caddy: installed the two-site Caddyfile and restarted"
  else
    echo "caddy: Caddyfile already current"
  fi
else
  echo "caddy: skipped (SKIP_CADDY=1)"
fi

# --- ownership --------------------------------------------------------------
chown -R "$DEPLOY_OWNER:$SVC" "$VIDEOFY_APP_DIR"
chown -R "$DEPLOY_OWNER:root" "$VIDEOFY_WWW_DIR"
echo "install complete: $VIDEOFY_ENV on ports $VIDEOFY_GATEWAY_PORT/$VIDEOFY_INGEST_PORT/$VIDEOFY_ACCOUNT_PORT"
echo "next: fill vendor keys in $VIDEOFY_ENV_DIR/*.env, then: bash deploy/deploy.sh production <ref>"
