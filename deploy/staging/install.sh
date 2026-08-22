#!/usr/bin/env bash
#
# Videofy Live — staging install. Idempotent: safe to re-run after a deploy.
#
# What this does NOT do: put a provider credential anywhere. Vendor keys are
# supplied by whoever owns the vendor account, by editing /etc/videofy/*.env on
# the box. The INTERNAL shared secrets are different -- they belong to nobody
# outside this machine, so they are generated HERE and never transit a network,
# a terminal, or a report.
set -euo pipefail

APP_DIR=/srv/videofy/app
STATE_DIR=/srv/videofy/state
UPLOAD_DIR=/srv/videofy/uploads
WWW_DIR=/srv/videofy/www
ENV_DIR=/etc/videofy
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then echo "run with sudo" >&2; exit 1; fi

# --- service account: no login, no home, no shell -------------------------
if ! id -u videofy >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin videofy
  echo "created service user: videofy"
fi

install -d -o videofy -g videofy -m 0750 "$STATE_DIR" "$UPLOAD_DIR" \
  "$UPLOAD_DIR/webrtc-staging" "$UPLOAD_DIR/audio-chunks" "$STATE_DIR/call-transcripts"
install -d -o root -g root -m 0755 "$WWW_DIR"
# Caddy runs as its own user and must be able to WRITE here, not merely
# reach it. Owned by root, this fails at startup with a permission error
# that names the log file rather than the ownership.
install -d -o caddy -g caddy -m 0755 /var/log/caddy

# --- environment files ----------------------------------------------------
# 0750 on the directory and 0640 root:videofy on the files: the service reads
# them, nothing else on the box can.
install -d -o root -g videofy -m 0750 "$ENV_DIR"
for svc in gateway media-ingest account; do
  target="$ENV_DIR/$svc.env"
  if [[ ! -f "$target" ]]; then
    install -o root -g videofy -m 0640 "$HERE/env-templates/$svc.env.template" "$target"
    echo "installed template: $target  (values still need filling in)"
  else
    echo "kept existing: $target"
  fi
done

# --- internal shared secrets ---------------------------------------------
# Generated in place, only if still empty. Written with sed into the file the
# service reads; the value is never echoed, so it exists on this disk and
# nowhere else. The gateway/media-ingest pair MUST match, so it is generated
# once and written to both.
fill_secret() {
  local name="$1"; shift
  local value
  local needed=0
  for f in "$@"; do
    grep -qE "^${name}=$" "$f" && needed=1
  done
  if [[ $needed -eq 1 ]]; then
    value="$(openssl rand -hex 32)"
    for f in "$@"; do
      sed -i "s|^${name}=$|${name}=${value}|" "$f"
    done
    unset value
    echo "generated ${name} (value not displayed)"
  else
    echo "${name} already set; left alone"
  fi
}

fill_secret INTERNAL_WEBRTC_TOKEN "$ENV_DIR/gateway.env" "$ENV_DIR/media-ingest.env"
fill_secret VIDEOFY_AUTH_SECRET  "$ENV_DIR/gateway.env" "$ENV_DIR/account.env"
fill_secret CONNECT_AUTH_SECRET  "$ENV_DIR/gateway.env"

# --- systemd --------------------------------------------------------------
# --- preflight: does each unit's entrypoint actually exist? ---------------
# Found the hard way. `media-ingest` sets rootDir to the monorepo root, so its
# build output is nested and its entry is NOT dist/index.js. A wrong ExecStart
# does not fail loudly -- it becomes a restart loop that looks like a crash in
# the application, and the journal fills with MODULE_NOT_FOUND instead of the
# deployment mistake that caused it.
for unit in "$HERE"/systemd/videofy-*.service; do
  entry="$(sed -n 's|^ExecStart=/usr/bin/node ||p' "$unit")"
  workdir="$(sed -n 's|^WorkingDirectory=||p' "$unit")"
  if [[ ! -f "$workdir/$entry" ]]; then
    echo "PREFLIGHT FAILED: $(basename "$unit") runs '$entry' but $workdir/$entry does not exist." >&2
    echo "  Build first, or correct ExecStart to the real build output." >&2
    exit 1
  fi
done
echo "preflight: every unit entrypoint exists"

install -o root -g root -m 0644 "$HERE"/systemd/videofy-*.service /etc/systemd/system/
systemctl daemon-reload
echo "installed units: $(cd "$HERE"/systemd && ls videofy-*.service | tr '\n' ' ')"

# --- caddy ----------------------------------------------------------------
# Caddy reads no environment file by default; the drop-in is what makes
# VIDEOFY_SITE_ADDRESS reach the config adapter.
install -d -o root -g root -m 0755 /etc/systemd/system/caddy.service.d
install -o root -g root -m 0644 "$HERE/systemd/caddy.service.d/videofy.conf"   /etc/systemd/system/caddy.service.d/videofy.conf
systemctl daemon-reload

install -o root -g root -m 0644 "$HERE/Caddyfile" /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
echo "caddy config validated"

# The application tree is READ by the service user and WRITTEN by whoever
# deploys. Handing it to root:videofy locks the deploying account out of its own
# next deploy; handing it to the service user would let a compromised service
# rewrite its own code. So: owned by the deployer, group-readable by the service.
DEPLOY_OWNER="${DEPLOY_OWNER:-${SUDO_USER:-root}}"
chown -R "$DEPLOY_OWNER:videofy" "$APP_DIR"
chmod -R g-w,o-rwx "$APP_DIR"
echo "app tree owned by $DEPLOY_OWNER, readable by videofy"

echo "install complete. Enable with: systemctl enable --now videofy-media-ingest videofy-gateway videofy-account caddy"
