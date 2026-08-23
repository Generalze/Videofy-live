#!/usr/bin/env bash
# Installs the TURN relay that makes peer-to-peer call video work between
# people on different networks.
#
# WHY A RELAY IS NEEDED AT ALL. Call video is a peer-to-peer mesh. STUN lets
# two browsers discover their public addresses, which is enough for most home
# networks. It is NOT enough behind symmetric or carrier-grade NAT -- the
# common case on a mobile network -- where the address a peer learns is not
# the one its partner may send to. TURN relays the media instead, so the call
# connects when direct paths cannot.
#
# CREDENTIALS ARE EPHEMERAL. coturn runs with use-auth-secret: there is no
# stored username or password. A client is issued an HMAC credential that
# expires, minted server-side by the gateway. A long-term password would have
# had to ship inside the browser bundle, where it is readable by anyone and
# revocable only by changing it for everybody.
set -euo pipefail

REALM="${TURN_REALM:-staging.consummate7.com}"
SECRET_FILE=/etc/videofy/turn.env
MIN_PORT=49160
MAX_PORT=49300

PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org)"
[ -n "$PUBLIC_IP" ] || { echo "could not determine public IP" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq coturn >/dev/null

install -d -m 0750 /etc/videofy

# The secret is generated ON the server and never leaves it. It is not in the
# repository, not in a build argument, and not printed by this script.
if [ ! -f "$SECRET_FILE" ]; then
  umask 077
  printf 'TURN_STATIC_AUTH_SECRET=%s\nTURN_REALM=%s\nTURN_HOST=%s\n' \
    "$(openssl rand -hex 32)" "$REALM" "$REALM" > "$SECRET_FILE"
fi
chmod 0640 "$SECRET_FILE"
chown root:root "$SECRET_FILE"

# shellcheck disable=SC1090
SECRET="$(grep '^TURN_STATIC_AUTH_SECRET=' "$SECRET_FILE" | cut -d= -f2-)"

cat > /etc/turnserver.conf <<CONF
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=${SECRET}
realm=${REALM}
external-ip=${PUBLIC_IP}
min-port=${MIN_PORT}
max-port=${MAX_PORT}
no-cli
no-tlsv1
no-tlsv1_1
pidfile=/var/run/turnserver.pid
simple-log
log-file=/var/log/turnserver.log

# An authenticated relay must still never become a route INTO this host or
# into anyone else's private network. Without these a valid credential could
# reach 127.0.0.1 and talk to the services bound to loopback.
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
CONF
chmod 0640 /etc/turnserver.conf

sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true

ufw allow 3478/tcp comment 'TURN control' >/dev/null
ufw allow 3478/udp comment 'TURN control' >/dev/null
ufw allow ${MIN_PORT}:${MAX_PORT}/udp comment 'TURN relay' >/dev/null

systemctl enable coturn >/dev/null 2>&1 || true
systemctl restart coturn
sleep 2
systemctl is-active coturn
echo "coturn listening on ${PUBLIC_IP}:3478, realm ${REALM}, relay ${MIN_PORT}-${MAX_PORT}"
