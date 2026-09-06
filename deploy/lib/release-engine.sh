#!/usr/bin/env bash
# @author masterzee001
#
# Immutable releases, and one atomic instant where a deployment becomes real.
#
# WHAT WENT WRONG WITH THE OLD MODEL. A deploy checked the target SHA out into
# the tree the services were running from, then built, then reconciled units,
# then ran its gates, then restarted. Every one of those steps happened while
# the live services could be restarted by something else -- and on 2026-09-05
# something else did exactly that: unattended-upgrades restarted the production
# gateway at 06:19 with nobody watching. Had a deploy been mid-flight, or had
# it been about to REFUSE at a gate, the gateway would have come up on code
# that never passed one.
#
# So the property this file exists to give is narrow and absolute:
#
#   AT EVERY INSTANT, A SERVICE THAT RESTARTS BOOTS A RELEASE THAT PASSED
#   EVERY GATE.
#
# It holds without cooperation. Nothing has to be quiet, no timer has to be
# disabled, and nobody has to refrain from typing `systemctl restart`. It holds
# because the bytes a service resolves are never the bytes a deployment is
# working on.
#
#   releases/<sha>/            prepared once, then never written to again
#   current -> releases/<sha>      THE ONLY POINTER A DEPLOYMENT MOVES
#   www     -> current/www         structural; installed once, never moves again
#
# Preparation writes only inside a candidate directory nothing points at.
# Publication is ONE rename over a symlink -- a single syscall, with no interval
# in which the pointer is missing or half-written, and none in which the API and
# the site are on different releases. A failed preparation leaves the pointer
# exactly where it was, which is why a failed deploy is not an event the running
# system can observe at all.

# shellcheck source=./release-paths.sh
. "$(dirname "${BASH_SOURCE[0]}")/release-paths.sh"

# Where a release lives. Never built by concatenation at a call site.
release_dir() {
  local releases="$1" sha="$2"
  assert_full_sha 'release sha' "$sha" || return 1
  printf '%s/%s' "$releases" "$sha"
}

# What a caller must prove before a release may be pointed at.
#
# A DIRECTORY THAT EXISTS IS NOT A RELEASE. An interrupted preparation, a
# half-copied tree, a release from a build that failed after writing some of
# its output -- all of them are directories with the right name. The marker is
# written LAST, atomically, and only after every gate has passed, so its
# presence is the one fact that distinguishes a release from a directory.
release_is_complete() {
  local dir="$1"
  [ -n "$dir" ] || return 1
  [ -f "$dir/RELEASE.json" ] || return 1
  grep -q '"complete": *true' "$dir/RELEASE.json" 2>/dev/null || return 1
  #
  # THE MARKER MUST ALSO AGREE WITH THE NAME IT IS FILED UNDER.
  #
  # Sealed-ness alone was not enough, and an adversarial probe found it: a
  # release directory copied, renamed or restored by hand can carry a perfectly
  # valid marker for a DIFFERENT commit. Publishing it would point `current` at
  # releases/<A> while the bytes are B, with DEPLOY-STATE.md, the deploy log
  # and the printed rollback command all confidently naming A. That is exactly
  # the ambiguous state this engine exists to make impossible.
  [ "$(release_recorded_sha "$dir")" = "$(basename "$dir")" ] || return 1
  #
  # AND THE BYTES MUST STILL BE THE SEALED ONES.
  #
  # Checked here rather than at each call site so that reuse, publication and
  # rollback cannot disagree about what "complete" means. A tampered or
  # truncated release stops being a release for every one of them at once.
  release_integrity_holds "$dir" || return 1
  #
  # AND NO LINK MAY REACH OUT OF THE RELEASE.
  #
  # Manifest equality is not enough on its own: a symlink whose TARGET STRING
  # never changes can still point at mutable bytes outside the release, and
  # those bytes are nobody's version of anything. An immutable release that
  # depends on external state is not immutable, it just looks it.
  #
  # Checked here rather than at the call sites so sealing, reuse, publication
  # and rollback cannot disagree about what a valid release is.
  release_symlinks_stay_inside "$dir" >/dev/null 2>&1 || return 1
  return 0
}

# The SHA a release directory says it is.
release_recorded_sha() {
  local dir="$1"
  sed -n 's/.*"sha": *"\([0-9a-f]\{40\}\)".*/\1/p' "$dir/RELEASE.json" 2>/dev/null | head -1
}

# Everything in a release whose bytes must not change after sealing.
#
# WHAT IS EXCLUDED AND WHY. `.git` is administration rather than payload and
# its loose objects repack themselves; the seal files describe the manifest and
# cannot be inside it. Everything else -- server dist, node_modules, the web
# bundles Caddy serves -- IS the release, because any of it changing changes
# what runs or what a visitor downloads.
release_manifest_of() {
  local dir="$1"
  (
    cd "$dir" || return 1
    # SYMLINKS ARE PART OF THE RUNTIME NAMESPACE, NOT DECORATION.
    #
    # An earlier manifest listed `-type f` only, which in this monorepo is a
    # hole big enough to drive a release through: workspace linkage lives in
    # `node_modules/@videofy-live/*` as symlinks, and repointing one changes
    # which code executes while every ordinary file hash stays byte-identical.
    # The seal would have passed, publication would have passed, and the
    # runtime would have followed the altered link.
    #
    # So each entry records its TYPE as well as its identity: a file by content
    # hash, a link by its target. A link that changes target, appears or
    # disappears changes the manifest, because the manifest describes the
    # namespace rather than a set of blobs.
    find . \( -type f -o -type l \)       -not -path './.git/*'       -not -name 'RELEASE.json'       -not -name 'RELEASE.manifest.sha256'       -not -name '.RELEASE.json.tmp'       -print0 | LC_ALL=C sort -z | while IFS= read -r -d '' entry; do
        if [ -L "$entry" ]; then
          # The target is recorded as WRITTEN, unresolved. Resolving it would
          # follow the link out of the release and hash whatever it happens to
          # point at today, which is the opposite of sealing.
          printf 'link %s -> %s
' "$entry" "$(readlink "$entry")"
        else
          printf 'file %s %s
' "$entry" "$(sha256sum < "$entry" | cut -d' ' -f1)"
        fi
      done
  )
}

# Does every symlink in a release stay inside it?
#
# A release that reaches outside itself is not sealed, whatever its manifest
# says: the bytes behind an escaping link are mutable state nobody versioned.
# npm workspace links are relative and land back inside the release, which is
# why this can be an assertion rather than an allowlist.
release_symlinks_stay_inside() {
  local dir="$1" entry resolved escapes=0 root
  root="$(cd "$dir" && pwd -P)" || return 1
  while IFS= read -r -d '' entry; do
    # `-m` canonicalises without requiring the target to exist, so a link that
    # escapes to something absent is still caught rather than skipped -- and a
    # link is resolved in ONE call instead of a subshell per entry, which
    # matters when node_modules holds thousands of them.
    resolved="$(readlink -m -- "$dir/$entry" 2>/dev/null)"
    [ -n "$resolved" ] || { escapes=1; continue; }
    case "$resolved/" in
      "$root"/*) ;;
      *)
        echo "REFUSED: $entry escapes the release, resolving to $resolved" >&2
        escapes=1 ;;
    esac
  done < <(cd "$dir" && find . -type l -not -path './.git/*' -print0)
  [ "$escapes" -eq 0 ]
}

# Does this release still contain the bytes it was sealed with?
#
# RELEASE.json ALONE PROVES ONLY THAT SOMETHING WAS ONCE SEALED and claims a
# SHA. It says nothing about whether the dist a service is about to execute, or
# the bundle a visitor is about to download, is still what passed the gates. A
# release is on disk for weeks and is the thing a rollback returns to; "it had
# a marker" is not the same as "it is intact".
release_integrity_holds() {
  local dir="$1"
  [ -f "$dir/RELEASE.manifest.sha256" ] || return 1
  # Compared as WHOLE CONTENT, not by re-running `sha256sum --check`, so that a
  # file ADDED after sealing is caught too: `--check` only verifies the lines it
  # is given and would happily pass a release carrying an extra runtime file.
  [ "$(release_manifest_of "$dir")" = "$(cat "$dir/RELEASE.manifest.sha256")" ]
}

# Seal a prepared candidate.
#
# Written with a temporary file and a rename so that a process killed during
# this call leaves either no marker or a whole one, never half of one. A
# half-written marker would be a release that reads complete and is not.
release_seal() {
  local dir="$1" sha="$2" ref="$3" prepared_by="$4"
  # THE MANIFEST IS WRITTEN BEFORE THE MARKER, and the marker is what makes the
  # release readable at all -- so a process killed between them leaves a
  # release with no marker, which is simply not a release, rather than one that
  # claims completeness with no integrity record behind it.
  release_manifest_of "$dir" > "$dir/RELEASE.manifest.sha256"
  local tmp="$dir/.RELEASE.json.tmp"
  cat > "$tmp" <<EOF
{
  "sha": "$sha",
  "ref": "$ref",
  "preparedAtUtc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "preparedBy": "$prepared_by",
  "host": "$(hostname 2>/dev/null || echo unknown)",
  "complete": true
}
EOF
  mv -f "$tmp" "$dir/RELEASE.json"
}

# What the pointer resolves to right now, or empty when it does not exist.
#
# `readlink` without -f on purpose: the question is what the pointer SAYS, and
# resolving it would silently follow a chain and answer about something else.
pointer_target() {
  local pointer="$1"
  [ -L "$pointer" ] || { [ -e "$pointer" ] && printf '%s' "$pointer"; return 0; }
  readlink "$pointer"
}

# The SHA currently published, or "none".
pointer_sha() {
  local pointer="$1" releases="$2"
  local target
  target="$(pointer_target "$pointer")"
  [ -n "$target" ] || { printf 'none'; return 0; }
  case "$target" in
    "$releases"/*)
      local rest="${target#"$releases"/}"
      printf '%s' "${rest%%/*}" ;;
    *) printf 'unmanaged:%s' "$target" ;;
  esac
}

# Point a stable name at a release, atomically.
#
# THE PATTERN THAT IS NOT USED HERE is `rm current && ln -s new current`,
# because between those two commands the pointer does not exist. A service that
# restarts in that window has no working directory at all, and on this host
# something restarts services on its own schedule. The window is small, which
# is the property that makes it survive testing and fail in production.
#
# `ln -sfn` writes a NEW symlink beside the live one, and `mv -Tf` renames it
# over the top. rename(2) on the same filesystem is atomic: every observer sees
# the old target or the new one, and no observer ever sees neither.
pointer_publish() {
  local pointer="$1" target="$2"
  assert_safe_path 'pointer' "$pointer" || return 1
  assert_safe_path 'pointer target' "$target" || return 1
  [ -e "$target" ] || { echo "REFUSED: pointer target does not exist: $target" >&2; return 1; }
  local tmp="$pointer.publishing.$$"
  ln -sfn "$target" "$tmp" || return 1
  # -T so a rename onto an existing symlink-to-a-directory replaces the LINK
  # rather than moving the new link inside the directory it points at.
  mv -Tf "$tmp" "$pointer" || { rm -f "$tmp"; return 1; }
  return 0
}

# Prepare a release without the running system being able to observe it.
#
# The candidate is built under a name nothing points at and which no release
# path can collide with, then renamed into place only once it is sealed. So
# `releases/<sha>` is either absent or a release that passed every gate; there
# is no third state for a later deploy, a rollback, or an operator to trip on.
#
# `prepare_body` is the caller's build. It receives the candidate directory and
# must write everything the release needs into it. If it fails, this function
# leaves the candidate on disk for inspection and the pointers untouched.
release_prepare() {
  local releases="$1" sha="$2" ref="$3" prepare_body="$4"
  assert_safe_path 'RELEASES_DIR' "$releases" || return 1
  assert_full_sha 'release sha' "$sha" || return 1

  local final candidate
  final="$(release_dir "$releases" "$sha")" || return 1

  if [ -e "$final" ]; then
    if release_is_complete "$final" && [ "$(release_recorded_sha "$final")" = "$sha" ]; then
      echo "release $sha already prepared and sealed; reusing"
      return 0
    fi
    #
    # NEVER MOVE THE RELEASE THAT IS CURRENTLY LIVE.
    #
    # The move-aside below is right for an unused candidate and catastrophic
    # for the active one. If `current` points at this release, renaming it
    # leaves `current` DANGLING -- and it does so BEFORE a replacement has been
    # built, let alone qualified. For however long the rebuild takes, an
    # external restart resolves nothing at all: the exact invariant this engine
    # exists to guarantee, broken by its own repair path.
    #
    # An active release that fails integrity is an incident, not a redeploy.
    # Everything is left exactly where it is and the operator is told what
    # happened, because the recovery depends on facts this code does not have.
    if [ -n "${ATOMIC_CURRENT:-}" ] && [ "$(pointer_target "$ATOMIC_CURRENT")" = "$final" ]; then
      echo "ACTIVE RELEASE INTEGRITY FAILURE: $sha is live and its bytes have changed." >&2
      echo "  current -> $final" >&2
      echo "  Nothing has been moved, deleted or overwritten; the pointer is untouched" >&2
      echo "  and a restart still resolves this release." >&2
      echo "  This is an incident: decide deliberately whether to roll back to a known" >&2
      echo "  good release or to investigate the corruption first." >&2
      return 1
    fi
    # A directory with the right name and no proof of what is in it. It is not
    # deleted -- it may be the wreckage of something worth reading -- and it is
    # not reused, because "we have a directory called $sha" is not evidence
    # that its bytes are $sha.
    local aside="$releases/$sha.unverified.$(date -u +%Y%m%dT%H%M%SZ)"
    echo "release $sha exists but is not sealed; moving aside to $aside"
    mv -T "$final" "$aside" || return 1
  fi

  mkdir -p "$releases" || return 1
  candidate="$releases/.candidate-$sha.$$"
  rm -rf "$candidate"
  mkdir -p "$candidate" || return 1

  if ! "$prepare_body" "$candidate"; then
    echo "release preparation FAILED; candidate left at $candidate" >&2
    echo "  nothing was published: the running system is untouched" >&2
    return 1
  fi

  # CHECKED BEFORE THE MARKER IS WRITTEN. A release that reaches outside itself
  # must never acquire the one property that makes it usable, so this refuses
  # while the candidate is still just a directory.
  if ! release_symlinks_stay_inside "$candidate"; then
    echo "release preparation FAILED: a symlink escapes the release" >&2
    echo "  candidate left at $candidate; nothing was published" >&2
    return 1
  fi
  release_seal "$candidate" "$sha" "$ref" "${USER:-unknown}"
  # Sealed first, then named. A candidate that becomes `releases/<sha>` is
  # already complete at the instant it acquires the name, so no reader can see
  # the name without the contents.
  mv -T "$candidate" "$final" || return 1
  echo "release $sha prepared at $final"
  return 0
}

# Make a prepared release the one services resolve.
#
# ONE POINTER MOVES. THAT IS THE WHOLE TRANSACTION.
#
# This function used to move two: `current` to the release and `www` to that
# release's assets. Each rename was individually atomic, and the conclusion
# that the pair was therefore atomic is simply wrong -- between them there is a
# real, observable interval in which the backend is release B and the site is
# still serving release A's bundles. Nothing crashes; a visitor just loads a
# bundle built against a different API than the one answering it, which is the
# kind of fault that shows up as one broken feature and no error anywhere.
#
# So `www` is no longer a release pointer at all. It is STRUCTURAL:
#
#     www -> current/www        installed once, during convergence
#     current -> releases/<sha> moved by every deployment
#
# Because `www` resolves THROUGH `current`, the single rename below moves the
# API and the assets in the same instant, by construction rather than by
# ordering. There is no interleaving left to get wrong, and no window for an
# observer to catch the two disagreeing.
release_publish() {
  local releases="$1" sha="$2" current="$3"
  local dir
  dir="$(release_dir "$releases" "$sha")" || return 1
  release_is_complete "$dir" || {
    echo "REFUSED: $dir is not a sealed release; nothing may point at it" >&2
    return 1
  }
  #
  # WHO IS ALLOWED TO REPLACE THE POINTER.
  #
  # Replacing a symlink needs write permission on the directory holding it, and
  # on production that directory is root-owned -- deliberately, since the deploy
  # identity has no business creating files beside the release store, the
  # uploads or the environment files. So when the directory is not writable, the
  # rename is performed by a root-owned helper that can do this one thing and
  # nothing else.
  #
  # Where the directory IS writable (staging, and every test rig), the ordinary
  # path is used. The atomic guarantee is identical either way: both end in a
  # rename over the pointer.
  if [ -w "$(dirname "$current")" ]; then
    pointer_publish "$current" "$dir"
  else
    publication_authority_publish "$sha" "$current"
  fi
}

# The publication helper, or a clear refusal.
#
# Overridable for tests, which supply a stub at a temporary path. On a real
# host it is the root-owned program installed by install.sh.
ATOMIC_PUBLISH_HELPER="${ATOMIC_PUBLISH_HELPER:-/usr/local/sbin/videofy-publish-current}"

publication_authority_publish() {
  local sha="$1" current="$2"
  if [ ! -x "$ATOMIC_PUBLISH_HELPER" ]; then
    echo "REFUSED: $(dirname "$current") is not writable and the publication" >&2
    echo "  helper $ATOMIC_PUBLISH_HELPER is not installed." >&2
    echo "  Nothing can move the pointer. Run deploy/production/install.sh." >&2
    return 1
  fi
  # `-n`: never prompt. A deployment that stops for a password is a deployment
  # that hangs in automation rather than failing.
  sudo -n "$ATOMIC_PUBLISH_HELPER" "$sha" || {
    echo "REFUSED: the publication helper would not publish $sha" >&2
    return 1
  }
  # Verified from THIS side too. The helper reports success; the pointer is the
  # authority, and a helper that lied would otherwise go unnoticed.
  local landed
  landed="$(pointer_target "$current")"
  if [ "$landed" != "$(release_dir "$ATOMIC_RELEASES" "$sha")" ]; then
    echo "REFUSED: after publication $current points at $landed, not $sha" >&2
    return 1
  fi
  return 0
}

# Install the structural web pointer. ONE-TIME CONVERGENCE ONLY.
#
# Deliberately not called by any deployment. `www` points at `current/www` and
# then never moves again, so an ordinary release cannot touch it -- which is
# precisely what makes a release one atomic act instead of two.
release_install_web_pointer() {
  local www="$1" current="$2"
  assert_safe_path 'WWW_POINTER' "$www" || return 1
  assert_safe_path 'CURRENT_POINTER' "$current" || return 1
  pointer_publish "$www" "$current/www"
}

# Go back to a release that was already qualified.
#
# NO REBUILD, because the release is still on disk exactly as it was when it
# passed. A rollback that rebuilds is a new deployment wearing the name of an
# old one: it can fail, it can produce different bytes from a moved dependency,
# and it takes minutes at the moment when minutes are what nobody has.
release_rollback() {
  local releases="$1" sha="$2" current="$3"
  local dir
  dir="$(release_dir "$releases" "$sha")" || return 1
  if ! release_is_complete "$dir"; then
    echo "REFUSED: cannot roll back to $sha; it is not a sealed release on this host" >&2
    return 1
  fi
  # One pointer back, so a rollback is exactly as atomic as a deployment --
  # and cannot leave the site and the API on different releases either.
  release_publish "$releases" "$sha" "$current"
}

# What an operator needs to know, in the order they need it.
release_state() {
  local releases="$1" current="$2" www="$3"
  printf 'active release: %s\n' "$(pointer_sha "$current" "$releases")"
  printf 'current -> %s\n' "$(pointer_target "$current")"
  # Reported as STRUCTURE, not as a second release pointer. Reading it as one
  # is what made the two-rename design look acceptable in the first place: it
  # should say `current/www` on every converged host, forever, and a release
  # SHA appearing here means somebody has reintroduced the split.
  printf 'www     -> %s   (structural; must never name a release)\n' "$(pointer_target "$www")"
  printf 'sealed releases:\n'
  local d
  for d in "$releases"/*; do
    [ -d "$d" ] || continue
    case "$d" in *.unverified.*|*/.candidate-*) continue ;; esac
    if release_is_complete "$d"; then
      printf '  %s  %s\n' "$(basename "$d")" \
        "$(sed -n 's/.*"preparedAtUtc": *"\([^"]*\)".*/\1/p' "$d/RELEASE.json" | head -1)"
    fi
  done
}
