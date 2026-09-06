#!/usr/bin/env bash
# @author masterzee001
#
# A systemctl that answers from a fixture instead of from the host.
#
# The deployment gates exist to catch what the REAL daemon reports, so a test
# that stubbed the gate functions themselves would prove only that the test
# author agreed with the code. This stubs the boundary the code actually talks
# to -- `systemctl show <unit> -p <property> --value` -- and lets the gate run
# unmodified, which is the only way the parsing, the drop-in walk and the
# refusal messages get exercised at all.
#
# Fixtures live one file per unit in $STUB_SYSTEMD_DIR:
#   <unit>.WorkingDirectory
#   <unit>.DropInPaths
#   <unit>.StartLimitIntervalUSec
#   <unit>.StartLimitBurst
#
# A missing file answers empty, exactly as the real systemctl does for a unit
# it does not know -- including its exit code of 0, which is what stops a
# caller running under `set -e` from aborting on an unknown unit.
set -uo pipefail

DIR="${STUB_SYSTEMD_DIR:?STUB_SYSTEMD_DIR is required}"

if [ "${1:-}" != "show" ]; then
  # Nothing in the deployment gates calls anything but `show`. If that changes,
  # the test should fail loudly here rather than silently answer nothing.
  echo "stub-systemctl: unsupported verb '${1:-}'" >&2
  exit 64
fi
shift

unit=""
property=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) property="$2"; shift 2 ;;
    --value) shift ;;
    -*) shift ;;
    *) unit="$1"; shift ;;
  esac
done

file="$DIR/${unit}.${property}"
if [ -f "$file" ]; then
  cat "$file"
fi
exit 0
