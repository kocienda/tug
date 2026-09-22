#!/bin/bash
set -euo pipefail

# version.sh — unified version management for all tugtool components
#
# Single source of truth: tugrust/Cargo.toml [workspace.package] version
# Propagates to: tugcode/package.json, tugdeck/package.json, tugapp/Info.plist
#
# A version bump also seeds release-notes/<version>.md, because the update
# popover's notes come from that file by way of generate_appcast [B11] and a
# file nobody is reminded to write is a file nobody writes. Seeding is never
# overwriting: a notes file that already exists is left exactly as it is.
#
# Usage:
#   version.sh show               Print current version
#   version.sh set <M.m.p>        Set version everywhere
#   version.sh bump major|minor|patch   Increment and set

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CARGO_TOML="$REPO_ROOT/tugrust/Cargo.toml"
TUGCODE_PKG="$REPO_ROOT/tugcode/package.json"
TUGDECK_PKG="$REPO_ROOT/tugdeck/package.json"
INFO_PLIST="$REPO_ROOT/tugapp/Info.plist"
NOTES_DIR="$REPO_ROOT/release-notes"

# Read current version from workspace Cargo.toml
read_version() {
    grep '^version = ' "$CARGO_TOML" | head -1 | sed 's/version = "//;s/"//'
}

# Compute CFBundleVersion integer: major*10000 + minor*100 + patch
bundle_version() {
    local ver="$1"
    local major minor patch
    IFS='.' read -r major minor patch <<< "$ver"
    echo $(( major * 10000 + minor * 100 + patch ))
}

# Set one <string> value in Info.plist, touching nothing but that line. The
# key's line is matched and the value is on the next; the read-back through
# PlistBuddy (a read, which does not rewrite) is what makes a silent no-match
# a loud failure instead.
set_plist_string() {
    local key="$1" value="$2"
    sed -i '' "/<key>$key<\/key>/{n;s|<string>[^<]*</string>|<string>$value</string>|;}" "$INFO_PLIST"
    local got
    got="$(/usr/libexec/PlistBuddy -c "Print :$key" "$INFO_PLIST")"
    if [ "$got" != "$value" ]; then
        echo "error: $INFO_PLIST $key reads '$got' after setting it to '$value'" >&2
        exit 1
    fi
}

# Seed release-notes/<version>.md for a version that has none yet.
seed_release_notes() {
    local ver="$1"
    local notes="$NOTES_DIR/$ver.md"

    if [ -f "$notes" ]; then
        echo "release notes: $notes (already written)" >&2
        return
    fi

    mkdir -p "$NOTES_DIR"
    cat > "$notes" <<NOTES
# Tug $ver

<!-- What changed, for someone who has been using $ver's predecessor. This
     markdown is embedded in the appcast and rendered in the update popover,
     so write it for that reader: a few sentences or a short list, not a
     commit log. Delete this comment. -->
NOTES
    echo "release notes: $notes (seeded — write it before releasing)" >&2
}

# Set version in all files
do_set() {
    local ver="$1"

    # Validate format
    if ! echo "$ver" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
        echo "error: version must be in M.m.p format (e.g., 0.8.0)" >&2
        exit 1
    fi

    local bv
    bv=$(bundle_version "$ver")

    # 1. Cargo.toml workspace version
    sed -i '' "s/^version = \".*\"/version = \"$ver\"/" "$CARGO_TOML"

    # 2. tugcode/package.json
    sed -i '' "s/\"version\": \".*\"/\"version\": \"$ver\"/" "$TUGCODE_PKG"

    # 3. tugdeck/package.json
    sed -i '' "s/\"version\": \".*\"/\"version\": \"$ver\"/" "$TUGDECK_PKG"

    # 4. tugapp/Info.plist — CFBundleShortVersionString and CFBundleVersion
    #    Edited in place rather than through PlistBuddy: `Set` rewrites the
    #    whole file with its keys sorted, so two changed values arrive as an
    #    80-line diff that buries them. The value sits on the line after its
    #    key, and that is the only line touched.
    set_plist_string "CFBundleShortVersionString" "$ver"
    set_plist_string "CFBundleVersion" "$bv"

    # 5. Cargo.lock — only the workspace crates' own entries. `generate-lockfile`
    #    would resolve every dependency afresh, so a version bump carried a
    #    thousand-line upgrade of crates nobody asked to move.
    (cd "$REPO_ROOT/tugrust" && cargo update --workspace --offline --quiet)

    # 6. Seed the release notes. stderr, because stdout is the version and
    # every caller reads it.
    seed_release_notes "$ver"

    echo "$ver"
}

# Bump version component
do_bump() {
    local component="$1"
    local ver
    ver=$(read_version)

    local major minor patch
    IFS='.' read -r major minor patch <<< "$ver"

    case "$component" in
        major)
            major=$((major + 1))
            minor=0
            patch=0
            ;;
        minor)
            minor=$((minor + 1))
            patch=0
            ;;
        patch)
            patch=$((patch + 1))
            ;;
        *)
            echo "error: unknown component '$component' (use major, minor, or patch)" >&2
            exit 1
            ;;
    esac

    do_set "$major.$minor.$patch"
}

# Main
case "${1:-}" in
    show)
        read_version
        ;;
    set)
        if [ -z "${2:-}" ]; then
            echo "usage: version.sh set <M.m.p>" >&2
            exit 1
        fi
        do_set "$2"
        ;;
    bump)
        if [ -z "${2:-}" ]; then
            echo "usage: version.sh bump major|minor|patch" >&2
            exit 1
        fi
        do_bump "$2"
        ;;
    *)
        echo "usage: version.sh {show|set <M.m.p>|bump major|minor|patch}" >&2
        exit 1
        ;;
esac
