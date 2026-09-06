#!/usr/bin/env bash
# @author masterzee001
#
# Deployment paths, checked before anything is written through them.
#
# THE FAILURE THIS PREVENTS is a guard that passes everything. The stale-tree
# check shipped as `case "$WD" in "$APP_DIR"/*)`, and with an empty APP_DIR that
# pattern is `/*`, which matches every absolute path there is. The guard would
# have reported success on exactly the configuration it existed to refuse, and
# nothing would have looked wrong. An empty variable is not a missing check; it
# is a check that says yes.
#
# So every path a deployment writes through, points at, or compares against is
# validated once, here, and a comparison is a function rather than a glob
# written from memory at each call site.
#
# NOT A SECURITY BOUNDARY. Anyone who can run the deploy already has the host.
# This is about a deployment that mutates the wrong directory because a
# variable was empty, which is the accident that actually happens.

# Absolute, non-empty, normal, and not the root of the filesystem.
#
# `..` is refused rather than resolved: a path containing it may be perfectly
# valid and still means the caller built it by concatenation and did not know
# where it landed. Deployment paths are configuration, not user input, and a
# configured path that needs resolving is a configured path somebody got wrong.
assert_safe_path() {
  local label="$1" path="$2"
  if [ -z "$path" ]; then
    echo "REFUSED: $label is empty; a path guard with no path passes everything" >&2
    return 1
  fi
  case "$path" in
    /*) ;;
    *) echo "REFUSED: $label is not absolute: $path" >&2; return 1 ;;
  esac
  if [ "$path" = "/" ]; then
    echo "REFUSED: $label is the filesystem root" >&2
    return 1
  fi
  case "$path" in
    *//*) echo "REFUSED: $label is not normalised (double slash): $path" >&2; return 1 ;;
  esac
  case "$path" in
    */..|*/../*|../*|..) echo "REFUSED: $label contains '..': $path" >&2; return 1 ;;
  esac
  case "$path" in
    */.|*/./*) echo "REFUSED: $label contains '.': $path" >&2; return 1 ;;
  esac
  case "$path" in
    */) echo "REFUSED: $label has a trailing slash: $path" >&2; return 1 ;;
  esac
  return 0
}

# Whether `child` is the same as `parent` or genuinely inside it.
#
# THE PREFIX LOOKALIKE IS THE WHOLE POINT. A string comparison of
# "/srv/videofy-prod/app" against "/srv/videofy-prod/app-old/services/x"
# succeeds, and the two directories have nothing to do with each other. Both
# sides get a trailing slash before the comparison so the boundary being tested
# is a path separator rather than a character offset.
#
# Both paths must already have passed assert_safe_path; this answers a
# question, it does not sanitise.
path_is_within() {
  local parent="$1" child="$2"
  [ -n "$parent" ] && [ -n "$child" ] || return 1
  [ "$parent" != "/" ] || return 1
  [ "$child" = "$parent" ] && return 0
  case "$child/" in
    "$parent"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Every deployment path in one call, so a caller cannot validate three of four.
#
# Returns non-zero on the first refusal, having said which one and why.
assert_release_paths() {
  local root="$1" releases="$2" current="$3" www="$4"
  assert_safe_path 'ROOT' "$root" || return 1
  assert_safe_path 'RELEASES_DIR' "$releases" || return 1
  assert_safe_path 'CURRENT_POINTER' "$current" || return 1
  assert_safe_path 'WWW_POINTER' "$www" || return 1
  local p
  for p in "$releases" "$current" "$www"; do
    if ! path_is_within "$root" "$p"; then
      echo "REFUSED: $p is outside the deployment root $root" >&2
      return 1
    fi
  done
  # The pointers are things this code replaces. Pointing either of them AT the
  # release store, or at the root, would make a publication delete or shadow
  # every release the host has.
  if [ "$current" = "$releases" ] || [ "$www" = "$releases" ]; then
    echo "REFUSED: a runtime pointer may not BE the release store ($releases)" >&2
    return 1
  fi
  if [ "$current" = "$root" ] || [ "$www" = "$root" ]; then
    echo "REFUSED: a runtime pointer may not BE the deployment root ($root)" >&2
    return 1
  fi
  if [ "$current" = "$www" ]; then
    echo "REFUSED: the backend and web pointers are the same path: $current" >&2
    return 1
  fi
  return 0
}

# A release directory for one commit, refused unless the SHA looks like one.
#
# A release path is built from a SHA and then written through with rm -rf and
# rename. If the SHA can be any string, the release path can be any path.
assert_full_sha() {
  local label="$1" sha="$2"
  case "$sha" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
      return 0 ;;
    *)
      echo "REFUSED: $label is not a full 40-character lowercase SHA: '$sha'" >&2
      return 1 ;;
  esac
}
