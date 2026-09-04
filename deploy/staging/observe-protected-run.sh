#!/usr/bin/env bash
#
# Watch a protected run happen, from the host, while it happens.
#
# MEASURED LIVE RATHER THAN RECONSTRUCTED. "First durable segment" and "first
# public segment" are moments, not states: a spool inspected after the fact
# shows what survived, never when it arrived, and the interval between a frame
# being encoded and the cursor releasing it IS the safety delay being
# certified. So this starts before the broadcast and samples throughout.
#
# It reads only what the deployment already publishes about itself -- the
# spool, the journal, and the unauthenticated runtime surface that carries
# timings and counts and no content. It holds no credential and needs none.
#
#   sudo bash observe-protected-run.sh [seconds]
#
set -uo pipefail

SPOOL=/srv/videofy/state/programme-media
INGEST=http://127.0.0.1:3002
SECONDS_TOTAL="${1:-150}"

started_epoch=$(date +%s)
run_id=""
first_dir_at=""
first_segment_at=""
first_public_at=""
first_public_count=0

emit() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

emit "observing; waiting for a run directory under ${SPOOL}"

while :; do
  now=$(date +%s)
  elapsed=$(( now - started_epoch ))
  [ "${elapsed}" -ge "${SECONDS_TOTAL}" ] && break

  # 1. The run announces itself by existing: the origin creates a directory
  #    named by the run id before it writes anything into it.
  if [ -z "${run_id}" ]; then
    candidate="$(ls -1 "${SPOOL}" 2>/dev/null | head -n 1)"
    if [ -n "${candidate}" ]; then
      run_id="${candidate}"
      first_dir_at="$(date -u +%H:%M:%S)"
      emit "RUN DIRECTORY APPEARED run=${run_id}"
    fi
  fi

  if [ -n "${run_id}" ]; then
    dir="${SPOOL}/${run_id}"
    segs=$(ls -1 "${dir}"/seg_*.m4s 2>/dev/null | wc -l)
    inits=$(ls -1 "${dir}"/init.*.mp4 2>/dev/null | tr '\n' ' ')
    bytes=$(du -sb "${dir}" 2>/dev/null | cut -f1)

    if [ -z "${first_segment_at}" ] && [ "${segs}" -gt 0 ]; then
      first_segment_at="$(date -u +%H:%M:%S)"
      emit "FIRST DURABLE SEGMENT at ${first_segment_at} (init objects: ${inits:-none})"
    fi

    # 2. The cursor, from the service's own runtime surface. This is the
    #    number the certification is about: what the audience may have, as
    #    distinct from what the encoder has produced.
    runtime="$(curl -s --max-time 4 "${INGEST}/programmes/${run_id}/runtime" 2>/dev/null)"
    public_ms="$(printf '%s' "${runtime}" | sed -n 's/.*"publicOutputTimeMs":\([0-9-]*\).*/\1/p' | head -1)"
    live_ms="$(printf '%s' "${runtime}" | sed -n 's/.*"programmeTimeMs":\([0-9-]*\).*/\1/p' | head -1)"
    state="$(printf '%s' "${runtime}" | sed -n 's/.*"state":"\([a-z]*\)".*/\1/p' | head -1)"

    # 3. What the audience can actually fetch, which is not the same question:
    #    a manifest is the cursor's answer, not the encoder's.
    playlist="$(curl -s --max-time 4 "${INGEST}/programmes/${run_id}/playlist.m3u8" 2>/dev/null)"
    public_segs=$(printf '%s' "${playlist}" | grep -c '\.m4s' 2>/dev/null || echo 0)
    if [ -z "${first_public_at}" ] && [ "${public_segs}" -gt 0 ]; then
      first_public_at="$(date -u +%H:%M:%S)"
      first_public_count="${public_segs}"
      emit "FIRST PUBLIC SEGMENT at ${first_public_at} (${public_segs} in the manifest)"
    fi

    delay=""
    if [ -n "${live_ms:-}" ] && [ -n "${public_ms:-}" ]; then
      delay=$(( live_ms - public_ms ))
    fi
    emit "t+${elapsed}s run=${run_id} state=${state:-?} live=${live_ms:-?}ms public=${public_ms:-?}ms delay=${delay:-?}ms durable=${segs} public=${public_segs} bytes=${bytes:-0}"
  fi
  sleep 5
done

printf '\n== OBSERVED ==\n'
printf 'runId                %s\n' "${run_id:-NONE}"
printf 'run directory at     %s\n' "${first_dir_at:-never}"
printf 'first durable at     %s\n' "${first_segment_at:-never}"
printf 'first public at      %s\n' "${first_public_at:-never}"
printf 'public at first sight %s segments\n' "${first_public_count}"
if [ -n "${run_id}" ]; then
  printf 'init generations     %s\n' "$(ls -1 "${SPOOL}/${run_id}"/init.*.mp4 2>/dev/null | xargs -n1 basename 2>/dev/null | tr '\n' ' ')"
  printf 'retained segments    %s\n' "$(ls -1 "${SPOOL}/${run_id}"/seg_*.m4s 2>/dev/null | wc -l)"
  printf 'retained bytes       %s\n' "$(du -sb "${SPOOL}/${run_id}" 2>/dev/null | cut -f1)"
fi
