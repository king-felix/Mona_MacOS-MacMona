#!/bin/sh
# Mona uninstall utility (P23).
#
# Removes only the paths the installed package owns, and only after checking
# each one's identity against the ownership manifest and its bundle identifier.
# User state, projects, credentials, and any external Codewhale installation are
# preserved unless --remove-user-data names ONE user explicitly.
#
#   sudo sh uninstall-mona.sh --dry-run          # print the plan, change nothing
#   sudo sh uninstall-mona.sh --yes              # remove the app and the Service
#   sh uninstall-mona.sh --remove-user-data --home /Users/you --yes
#
# There is no "--all-users", no home-directory walk, and no wildcard: an
# uninstall that guesses is an uninstall that eventually deletes someone's work.
set -eu

APP_ID="com.mona.workbench"
SERVICE_ID="com.mona.workbench.service"

# Rehearsal hook, the same one the installer scripts use: an absolute temporary
# root lets the build and the smoke run this exact script without touching the
# real /Applications. A real uninstall leaves it unset.
ROOT=""
if [ -n "${MONA_UNINSTALL_ROOT:-}" ]; then
  case "$MONA_UNINSTALL_ROOT" in
    /*) ROOT="$MONA_UNINSTALL_ROOT" ;;
    *)
      echo "mona-uninstall: invalid MONA_UNINSTALL_ROOT (must be absolute)" >&2
      exit 2
      ;;
  esac
  if [ "$ROOT" = "/" ]; then ROOT=""; fi
fi

MONA_DIR="$ROOT/Library/Application Support/Mona"
OWNED_MANIFEST="$MONA_DIR/owned-paths.json"
RECEIPT="$MONA_DIR/install-receipt.json"
UTILITY="$MONA_DIR/uninstall-mona.sh"
APP_BUNDLE="$ROOT/Applications/Mona.app"
SERVICE_BUNDLE="$ROOT/Library/Services/Mona.service"

DRY_RUN=0
ASSUME_YES=0
REMOVE_USER_DATA=0
HOME_TO_CLEAN=""

usage() {
  cat <<'TEXT'
Mona uninstall

  sh uninstall-mona.sh --dry-run
      Show every path that would be removed. Changes nothing.

  sudo sh uninstall-mona.sh --yes
      Remove the package-owned app and Finder Service. Your projects, state,
      credentials, and external Codewhale installation are kept.

  sh uninstall-mona.sh --remove-user-data --home <users home> --yes
      After the system payload is gone, delete ONE user's product state.
      This is a separate, explicit action and it is not reversible.

Options:
  --dry-run            print the plan only
  --yes                do not ask for confirmation
  --remove-user-data   delete the named user's Mona state (requires --home)
  --home <path>        the one user whose state may be removed
  -h, --help           this text
TEXT
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --remove-user-data) REMOVE_USER_DATA=1 ;;
    --home)
      shift
      [ $# -gt 0 ] || { echo "Mona: --home needs a path" >&2; exit 2; }
      HOME_TO_CLEAN="$1"
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Mona: unknown option $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

say() { echo "mona-uninstall: $*"; }
die() {
  echo "mona-uninstall: $*" >&2
  exit 1
}

bundle_id() {
  /usr/bin/plutil -extract CFBundleIdentifier raw "$1/Contents/Info.plist" 2>/dev/null || true
}

# ---------------------------------------------------------------- user data

if [ "$REMOVE_USER_DATA" -eq 1 ]; then
  [ -n "$HOME_TO_CLEAN" ] || die "--remove-user-data requires --home <one user's home>"
  case "$HOME_TO_CLEAN" in
    *".."*) die "--home may not contain .." ;;
  esac
  if [ -n "$ROOT" ]; then
    # Rehearsal mode: the destructive branch is confined to the same temporary
    # root as the payload rehearsal, so `MONA_UNINSTALL_ROOT` bounds it too.
    case "$HOME_TO_CLEAN" in
      "$ROOT"/*) ;;
      *) die "--home must be inside MONA_UNINSTALL_ROOT during a rehearsal" ;;
    esac
  else
    case "$HOME_TO_CLEAN" in
      /Users/* | /private/var/*) ;;
      *) die "--home must be an absolute user home under /Users" ;;
    esac
    # Never act on an account that is not a real user home by accident.
    [ "$(basename "$HOME_TO_CLEAN")" != "Shared" ] ||
      die "refusing to treat /Users/Shared as a user home"
  fi
  [ -d "$HOME_TO_CLEAN" ] || die "$HOME_TO_CLEAN is not a directory"

  targets="
$HOME_TO_CLEAN/Library/Application Support/Mona
$HOME_TO_CLEAN/Library/Caches/Mona
$HOME_TO_CLEAN/Library/Logs/Mona
$HOME_TO_CLEAN/Library/Preferences/com.mona.workbench.plist
"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "would delete this user's Mona state:"
    printf '%s\n' "$targets" | while IFS= read -r target; do
      if [ -n "$target" ]; then
        if [ -e "$target" ]; then say "  [present] $target"; else say "  [absent]  $target"; fi
      fi
    done
    say "projects and any external Codewhale installation are never touched"
    exit 0
  fi
  if [ "$ASSUME_YES" -ne 1 ]; then
    printf 'Delete %s product state permanently? [y/N] ' "$HOME_TO_CLEAN"
    read -r answer
    case "$answer" in
      y | Y | yes | YES) ;;
      *) die "cancelled; nothing was deleted" ;;
    esac
  fi
  printf '%s\n' "$targets" | while IFS= read -r target; do
    if [ -n "$target" ]; then
      if [ -e "$target" ]; then
        /bin/rm -rf "$target"
        say "deleted $target"
      fi
    fi
  done
  say "projects and any external Codewhale installation were not touched"
  exit 0
fi

# ------------------------------------------------------------ system payload

[ -f "$OWNED_MANIFEST" ] || die "no ownership manifest at $OWNED_MANIFEST. This copy was not installed by the package; remove it the way you installed it."
[ -f "$RECEIPT" ] || die "no install receipt at $RECEIPT. Refusing to guess which files Mona owns."

# The removal plan below is a fixed allowlist of the paths this package installs,
# each verified by identity. The manifest is a precondition, not an instruction:
# a manifest that names anything else cannot widen the plan, which is why this
# script never deletes a path it did not already know. (Reported by review: the
# ADR described the manifest as the source of the plan, which it never was.)
if ! /usr/bin/grep -q "Applications/Mona.app" "$OWNED_MANIFEST" 2>/dev/null; then
  die "the ownership manifest does not describe this product."
fi

version="$(/usr/bin/plutil -extract version raw "$RECEIPT" 2>/dev/null || echo unknown)"
say "installed Mona version: $version"

# The manifest is the only source of owned paths. A path missing from it is
# never removed, even if it looks like ours.
plan=""
add_plan() { plan="$plan$1
"; }

if [ -e "$APP_BUNDLE" ]; then
  if [ "$(bundle_id "$APP_BUNDLE")" = "$APP_ID" ]; then
    add_plan "$APP_BUNDLE"
  else
    die "$APP_BUNDLE exists but is not Mona ($APP_ID); refusing to remove it"
  fi
fi

if [ -e "$SERVICE_BUNDLE" ]; then
  if [ "$(bundle_id "$SERVICE_BUNDLE")" = "$SERVICE_ID" ]; then
    add_plan "$SERVICE_BUNDLE"
  else
    die "$SERVICE_BUNDLE exists but is not Mona's Finder Service; refusing to remove it"
  fi
fi

for owned in "$RECEIPT" "$OWNED_MANIFEST" "$UTILITY"; do
  if [ -e "$owned" ]; then add_plan "$owned"; fi
done

if [ -z "$plan" ]; then
  say "nothing package-owned is installed; nothing to remove"
  exit 0
fi

say "the following package-owned paths will be removed:"
printf '%s\n' "$plan" | while IFS= read -r path; do
  if [ -n "$path" ]; then say "  $path"; fi
done
say "preserved: this and every user's state, projects, credentials, external Codewhale"

if [ "$DRY_RUN" -eq 1 ]; then
  say "dry run: nothing was removed"
  exit 0
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Remove these paths? [y/N] '
  read -r answer
  case "$answer" in
    y | Y | yes | YES) ;;
    *) die "cancelled; nothing was removed" ;;
  esac
fi

lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -z "$ROOT" ] && [ -x "$lsregister" ]; then
  "$lsregister" -u "$APP_BUNDLE" >/dev/null 2>&1 || true
  "$lsregister" -u "$SERVICE_BUNDLE" >/dev/null 2>&1 || true
fi

printf '%s\n' "$plan" | while IFS= read -r path; do
  if [ -n "$path" ]; then
    /bin/rm -rf "$path"
    say "removed $path"
  fi
done

# The directory itself is ours only when it holds nothing else.
if [ -d "$ROOT/Library/Application Support/Mona" ]; then
  if [ -z "$(/bin/ls -A "$ROOT/Library/Application Support/Mona" 2>/dev/null)" ]; then
    /bin/rmdir "$ROOT/Library/Application Support/Mona" || true
    say "removed $ROOT/Library/Application Support/Mona (now empty)"
  fi
fi

say "Mona was uninstalled. Your projects and state were kept; delete them per user only with --remove-user-data."
exit 0
