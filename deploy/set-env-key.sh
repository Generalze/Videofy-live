#!/usr/bin/env bash
# Set ONE named value in ONE environment file, on the box, from stdin.
#
# WHY STDIN. A secret passed as an argument is visible in the remote
# process list for as long as the command runs, and lands in whatever
# shell history the caller keeps. Read from stdin it exists in this
# process's memory and in the file it is written to, and nowhere else.
#
# WHY THIS IS SEPARATE FROM set-provider-credentials.ps1. That script
# rewrites the whole environment file and prompts for every vendor, so
# adding one key means re-entering all of them -- and a re-entered key is
# a mistyped key. This adds or replaces exactly one name.
#
#   printf '%s' "$SECRET" | bash set-env-key.sh /etc/videofy/media-ingest.env NAIJALINGO_API_KEY
#
# Prints the NAME and whether it was added or replaced. Never the value.
set -euo pipefail

FILE="${1:?usage: set-env-key.sh <env-file> <NAME>}"
NAME="${2:?usage: set-env-key.sh <env-file> <NAME>}"

case "$NAME" in
  [A-Z_][A-Z0-9_]*) ;;
  *) echo "refusing: '$NAME' is not an environment variable name" >&2; exit 2 ;;
esac

# THROUGH sudo, always. The environment directory is 0750 root:videofy, so an
# unprivileged `[ -f ]` answers "no such file" for a file that is plainly
# there -- a permission answer wearing an existence answer's clothes.
if ! sudo -n test -f "$FILE"; then
  echo "refusing: $FILE does not exist (install the environment first)" >&2
  exit 2
fi

VALUE="$(cat)"
# A trailing newline from a shell heredoc or a copied line would become part
# of the value and produce a 401 nobody can explain by looking at the file.
VALUE="${VALUE%$'\n'}"
VALUE="${VALUE%$'\r'}"

if [ -z "$VALUE" ]; then
  echo "refusing: no value on stdin for $NAME" >&2
  exit 2
fi
case "$VALUE" in
  *$'\n'*) echo "refusing: $NAME value contains a newline" >&2; exit 2 ;;
esac

ACTION=replaced
sudo -n grep -q "^${NAME}=" "$FILE" || ACTION=added

# Written through a temp file with the same ownership and mode, then moved:
# a half-written environment file is a service that will not start.
TMP="$(sudo -n mktemp "${FILE}.XXXXXX")"
sudo -n chown --reference="$FILE" "$TMP"
sudo -n chmod --reference="$FILE" "$TMP"

if [ "$ACTION" = replaced ]; then
  sudo -n grep -v "^${NAME}=" "$FILE" | sudo -n tee "$TMP" >/dev/null
else
  sudo -n cat "$FILE" | sudo -n tee "$TMP" >/dev/null
fi
printf '%s=%s\n' "$NAME" "$VALUE" | sudo -n tee -a "$TMP" >/dev/null
sudo -n mv "$TMP" "$FILE"

echo "$NAME $ACTION in $FILE (value not displayed, ${#VALUE} characters)"
