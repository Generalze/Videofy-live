#!/usr/bin/env bash
# @author masterzee001
#
# The ONE table that says what "staging" and "production" mean on c7-eu-01.
#
# Both environments live on the same box. Everything that distinguishes them --
# tree, env dir, unit names, loopback ports, web root, public origin -- is
# spelled out here once and read by deploy.sh, install.sh and smoke.sh. A
# second copy of any of these numbers is a second place for them to drift, and
# a port that drifts is a production service quietly talking to staging.
#
# Sourced, never executed. Call `videofy_env <staging|production>` and the
# VIDEOFY_* variables below are exported into the caller's shell.
#
# LOOPBACK PORT BLOCKS (verified free on the box with `ss -ltnp`, 30 Aug 2026):
#
#   service        staging   production
#   gateway        3001      3101
#   media-ingest   3002      3102
#   account        3006      3106
#
# The production block is staging + 100. Nothing else on the box listens in
# 31xx; coturn holds 3478, Postgres 5432, Caddy 80/443.

videofy_env() {
  local name="${1:?environment name}"
  case "$name" in
    staging)
      export VIDEOFY_ENV=staging
      export VIDEOFY_SSH_HOST="${VIDEOFY_SSH_HOST:-c7-claude}"
      export VIDEOFY_ROOT=/srv/videofy
      export VIDEOFY_APP_DIR=/srv/videofy/app
      export VIDEOFY_WWW_DIR=/srv/videofy/www
      export VIDEOFY_STATE_DIR=/srv/videofy/state
      export VIDEOFY_UPLOAD_DIR=/srv/videofy/uploads
      export VIDEOFY_BACKUP_DIR=/srv/videofy/backups
      export VIDEOFY_MEDIA_DIR=/var/lib/videofy
      export VIDEOFY_ENV_DIR=/etc/videofy
      export VIDEOFY_UNIT_PREFIX=videofy
      export VIDEOFY_GATEWAY_PORT=3001
      export VIDEOFY_INGEST_PORT=3002
      export VIDEOFY_ACCOUNT_PORT=3006
      export VIDEOFY_PUBLIC_HOST=staging.consummate7.com
      export VIDEOFY_PUBLIC_ORIGIN=https://staging.consummate7.com
      export VIDEOFY_DB_NAME=videofy_account
      export VIDEOFY_DB_ROLE=videofy
      ;;
    production)
      export VIDEOFY_ENV=production
      export VIDEOFY_SSH_HOST="${VIDEOFY_SSH_HOST:-c7-claude}"
      export VIDEOFY_ROOT=/srv/videofy-prod
      export VIDEOFY_APP_DIR=/srv/videofy-prod/app
      export VIDEOFY_WWW_DIR=/srv/videofy-prod/www
      export VIDEOFY_STATE_DIR=/srv/videofy-prod/state
      export VIDEOFY_UPLOAD_DIR=/srv/videofy-prod/uploads
      export VIDEOFY_BACKUP_DIR=/srv/videofy-prod/backups
      export VIDEOFY_MEDIA_DIR=/var/lib/videofy-prod
      export VIDEOFY_ENV_DIR=/etc/videofy-prod
      export VIDEOFY_UNIT_PREFIX=videofy-prod
      export VIDEOFY_GATEWAY_PORT=3101
      export VIDEOFY_INGEST_PORT=3102
      export VIDEOFY_ACCOUNT_PORT=3106
      export VIDEOFY_PUBLIC_HOST=consummate7.com
      export VIDEOFY_PUBLIC_ORIGIN=https://consummate7.com
      export VIDEOFY_DB_NAME=videofy_account_prod
      export VIDEOFY_DB_ROLE=videofy_prod
      ;;
    *)
      echo "unknown environment '$name' (staging|production)" >&2
      return 1
      ;;
  esac
  # The three application units, in the order they are restarted. The backup
  # unit is a timer and is never part of a deploy.
  export VIDEOFY_UNITS="${VIDEOFY_UNIT_PREFIX}-account ${VIDEOFY_UNIT_PREFIX}-media-ingest ${VIDEOFY_UNIT_PREFIX}-gateway"
  # The service user is the SAME in both environments. Isolation between them
  # is by tree, env dir, ports and database, not by uid: the translation models
  # under /var/lib/videofy/models (2.7 GB) and the Python runtime under
  # /opt/videofy-ai are shared READ-ONLY, and one uid reads them without a
  # second group grant.
  export VIDEOFY_SERVICE_USER=videofy
  # Shared, read-only, identical in both environments.
  export VIDEOFY_MODELS_DIR=/var/lib/videofy/models
  export VIDEOFY_AI_PYTHON=/opt/videofy-ai/bin/python
}
