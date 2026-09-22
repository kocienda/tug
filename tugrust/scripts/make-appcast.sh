#!/usr/bin/env bash
# make-appcast.sh — generate the Sparkle appcast for a release archive.
#
# The feed carries exactly one item: the archive it is handed. Sparkle only
# needs the newest entry to offer an update, and a single-item feed means no
# appcast state has to survive between CI runs — nothing to merge, no prior
# zips to re-download.
#
# Usage:
#   make-appcast.sh <archive.zip> [<output-appcast.xml>]
#
# Output defaults to products/appcast.xml.
#
# Release notes [B11]: generate_appcast embeds a same-named .html/.md/.txt
# sitting beside the archive, so this script stages one into the scratch
# directory before it runs. The file is looked for at
# release-notes/<version>.md, where <version> is read out of the archive's own
# Tug-<version>.zip name, or named outright with --notes. A release with no
# notes file is a warning and nothing more: the popover shows the version and
# its controls without them, and an absent file never blocks an update.
#
# Key material, two modes:
#   - $SPARKLE_ED_PRIVATE_KEY set (CI): piped to generate_appcast on stdin.
#   - unset (a developer machine that ran generate_keys): omitted entirely, so
#     generate_appcast signs with the login-Keychain key, which is its default.
#
# generate_appcast itself is resolved in this order:
#   1. $SPARKLE_GENERATE_APPCAST, if set and executable.
#   2. The SwiftPM artifact bundle in DerivedData, from `xcodebuild
#      -resolvePackageDependencies`.
#   3. Sparkle's published release tarball, unpacked into
#      $REPO_ROOT/.build-tools/sparkle-<version> (gitignored) and reused.
# The version comes from Package.resolved, so the tool always matches the
# framework the app is built against.
set -euo pipefail

DOWNLOAD_URL_PREFIX="https://github.com/kocienda/tug/releases/download/updates/"
PROJECT_LINK="https://github.com/kocienda/tug"

usage() {
    echo "usage: $(basename "$0") [--notes <file>] <archive.zip> [<output-appcast.xml>]" >&2
    exit 2
}

NOTES=""
POSITIONAL=()
while [ "$#" -gt 0 ]; do
    case "$1" in
        --notes)
            [ "$#" -ge 2 ] || usage
            NOTES="$2"
            shift 2
            ;;
        -h|--help)
            usage
            ;;
        *)
            POSITIONAL+=("$1")
            shift
            ;;
    esac
done

if [ "${#POSITIONAL[@]}" -lt 1 ] || [ "${#POSITIONAL[@]}" -gt 2 ]; then
    usage
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

ARCHIVE="${POSITIONAL[0]}"
if [ ! -f "$ARCHIVE" ]; then
    echo "error: archive not found: $ARCHIVE" >&2
    exit 1
fi
ARCHIVE="$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")"

OUTPUT="${POSITIONAL[1]:-$REPO_ROOT/products/appcast.xml}"

PACKAGE_RESOLVED="$REPO_ROOT/tugapp/Tug.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
if [ ! -f "$PACKAGE_RESOLVED" ]; then
    echo "error: $PACKAGE_RESOLVED not found — resolve the Sparkle package first" >&2
    exit 1
fi
SPARKLE_VERSION="$(
    /usr/bin/python3 -c '
import json, sys
with open(sys.argv[1]) as handle:
    pins = json.load(handle).get("pins", [])
for pin in pins:
    if pin.get("identity") == "sparkle":
        print(pin["state"]["version"])
        break
' "$PACKAGE_RESOLVED"
)"
if [ -z "$SPARKLE_VERSION" ]; then
    echo "error: no sparkle pin in $PACKAGE_RESOLVED" >&2
    exit 1
fi

resolve_generate_appcast() {
    if [ -n "${SPARKLE_GENERATE_APPCAST:-}" ] && [ -x "${SPARKLE_GENERATE_APPCAST}" ]; then
        echo "$SPARKLE_GENERATE_APPCAST"
        return
    fi

    local from_artifacts
    from_artifacts="$(
        find "$HOME/Library/Developer/Xcode/DerivedData" \
            -type f -perm -111 -name generate_appcast \
            -path '*/artifacts/sparkle/Sparkle/bin/*' 2>/dev/null | head -1
    )"
    if [ -n "$from_artifacts" ]; then
        echo "$from_artifacts"
        return
    fi

    local tools_dir="$REPO_ROOT/.build-tools/sparkle-$SPARKLE_VERSION"
    local binary="$tools_dir/bin/generate_appcast"
    if [ ! -x "$binary" ]; then
        echo "==> Fetching Sparkle $SPARKLE_VERSION tooling" >&2
        local tarball="$tools_dir/Sparkle.tar.xz"
        mkdir -p "$tools_dir"
        curl -fsSL -o "$tarball" \
            "https://github.com/sparkle-project/Sparkle/releases/download/$SPARKLE_VERSION/Sparkle-$SPARKLE_VERSION.tar.xz"
        tar -xJf "$tarball" -C "$tools_dir"
        rm -f "$tarball"
    fi
    if [ ! -x "$binary" ]; then
        echo "error: generate_appcast not found after unpacking $tools_dir" >&2
        exit 1
    fi
    echo "$binary"
}

GENERATE_APPCAST="$(resolve_generate_appcast)"
echo "==> generate_appcast: $GENERATE_APPCAST"

# generate_appcast reads a directory of archives and writes deltas and an
# old_updates/ folder beside them. It gets a scratch directory holding only
# this release so neither the feed nor products/ picks up strays.
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
cp "$ARCHIVE" "$WORK_DIR/"

# Stage the release notes beside the archive under the archive's own stem,
# which is the whole of generate_appcast's convention for finding them.
ARCHIVE_STEM="$(basename "$ARCHIVE")"
ARCHIVE_STEM="${ARCHIVE_STEM%.*}"

if [ -z "$NOTES" ]; then
    # Tug-0.8.0.zip -> release-notes/0.8.0.md. A stem that is not in that
    # shape simply leaves NOTES empty and takes the warning below.
    case "$ARCHIVE_STEM" in
        Tug-*) NOTES="$REPO_ROOT/release-notes/${ARCHIVE_STEM#Tug-}.md" ;;
    esac
fi

NOTES_ARGS=()
if [ -n "$NOTES" ] && [ -f "$NOTES" ]; then
    cp "$NOTES" "$WORK_DIR/$ARCHIVE_STEM.${NOTES##*.}"
    NOTES_ARGS=(--embed-release-notes)
    echo "==> Release notes: $NOTES"
else
    # Never fatal [B11]. The popover shows the version and its controls with
    # no notes, and a release is worth more than its changelog.
    echo "==> Release notes: none found${NOTES:+ at $NOTES} — the feed will carry no description" >&2
fi

ARGS=(
    --download-url-prefix "$DOWNLOAD_URL_PREFIX"
    --link "$PROJECT_LINK"
    -o "$WORK_DIR/appcast.xml"
    "${NOTES_ARGS[@]+"${NOTES_ARGS[@]}"}"
)

if [ -n "${SPARKLE_ED_PRIVATE_KEY:-}" ]; then
    echo "==> Signing the appcast with SPARKLE_ED_PRIVATE_KEY"
    printf '%s' "$SPARKLE_ED_PRIVATE_KEY" \
        | "$GENERATE_APPCAST" --ed-key-file - "${ARGS[@]}" "$WORK_DIR"
else
    echo "==> Signing the appcast with the login-Keychain key"
    "$GENERATE_APPCAST" "${ARGS[@]}" "$WORK_DIR"
fi

if [ ! -f "$WORK_DIR/appcast.xml" ]; then
    echo "error: generate_appcast produced no appcast" >&2
    exit 1
fi

# An unsigned feed would be silently rejected by every installed app, so it is
# worth failing here rather than at update time.
if ! grep -q 'sparkle:edSignature' "$WORK_DIR/appcast.xml"; then
    echo "error: the generated appcast has no sparkle:edSignature" >&2
    exit 1
fi

mkdir -p "$(dirname "$OUTPUT")"
cp "$WORK_DIR/appcast.xml" "$OUTPUT"
echo "==> Appcast: $OUTPUT"
