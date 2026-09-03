#!/bin/bash
set -euo pipefail

# test-bundle-id-mapping.sh — exercises every branch of [D10]'s
# (profile, branch) → CFBundleIdentifier mapping (with profile tokens
# renamed per [D19]) without requiring a real Xcode build for each
# variant.
#
# Strategy:
#   1. Create a minimal Info.plist scratch file containing the keys
#      assign-bundle-id.sh reads (BuildProfile, BuildBranch) plus
#      CFBundleIdentifier to overwrite.
#   2. For each (profile, branch) variant in the case table, plant the
#      values in the scratch plist, run assign-bundle-id.sh against a
#      synthetic bundle layout (TARGET_BUILD_DIR/CONTENTS_FOLDER_PATH
#      env vars point at the scratch dir), and read back CFBundleIdentifier.
#   3. Compare against the expected value computed via the canonical
#      bash slugifier.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

ASSIGN_CMD="$REPO_ROOT/tugrust/scripts/assign-bundle-id.sh"
SLUG_CMD="$REPO_ROOT/tugrust/scripts/branch-slug.sh"

WORKDIR="$(mktemp -d -t test-bundle-id-mapping.XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT INT TERM

# Synthetic bundle layout. assign-bundle-id.sh reads/writes
# $TARGET_BUILD_DIR/$CONTENTS_FOLDER_PATH/Info.plist.
BUNDLE_CONTENTS="$WORKDIR/bundle.app/Contents"
mkdir -p "$BUNDLE_CONTENTS"
PLIST="$BUNDLE_CONTENTS/Info.plist"

# Variants. The bash array carries (profile, branch, expected) triples
# colon-separated so we can iterate cleanly.
declare -a CASES=(
    "release:main:dev.tugapp.app"
    "debug:main:dev.tugapp.app.debug"
    "debug:dev-foo:dev.tugapp.app.debug-dev-foo"
    "release:dev-foo:dev.tugapp.app.release-dev-foo"
    # Branch with characters that exercise the slugifier:
    "debug:feat/foo:dev.tugapp.app.debug-feat-foo"
    "release:wip/foo bar:dev.tugapp.app.release-wip-foo-bar"
    # Detached-HEAD shape:
    "debug:detached-abcd1234:dev.tugapp.app.debug-detached-abcd1234"
    # Uppercase / mixed:
    "debug:Dev-Wake-1:dev.tugapp.app.debug-dev-wake-1"
)

# Failure-only variant: a branch that slugifies to empty should be
# rejected with a clear error (we don't want the bundle ID to end with
# `-` and a trailing nothing).
declare -a FAIL_CASES=(
    "debug:###"
    "debug:   "
)

fail=0

# Verifies that running the canonical slug pipeline by hand reproduces
# the expected bundle ID (this is also covered by test-slug-parity.sh,
# but redoing it here confirms the [D10] case table itself).
verify_expected() {
    local profile="$1"
    local branch="$2"
    local expected="$3"
    case "$profile-$branch" in
        release-main)
            [ "$expected" = "dev.tugapp.app" ] && return 0
            ;;
        debug-main)
            [ "$expected" = "dev.tugapp.app.debug" ] && return 0
            ;;
        *)
            local slug
            slug="$(bash "$SLUG_CMD" "$branch")"
            [ "$expected" = "dev.tugapp.app.${profile}-${slug}" ] && return 0
            ;;
    esac
    printf '  table-bug %-12s %-22s   expected=%s  does not satisfy [D10]/[D19]\n' \
        "$profile" "<$branch>" "$expected" >&2
    return 1
}

for entry in "${CASES[@]}"; do
    profile="${entry%%:*}"
    rest="${entry#*:}"
    branch="${rest%:*}"
    expected="${rest##*:}"

    # Self-check the case table.
    verify_expected "$profile" "$branch" "$expected" || { fail=$((fail + 1)); continue; }

    # Plant the input keys + a stub CFBundleIdentifier into the plist.
    plutil -create xml1 "$PLIST"
    plutil -insert BuildProfile -string "$profile" "$PLIST"
    plutil -insert BuildBranch -string "$branch" "$PLIST"
    plutil -insert CFBundleIdentifier -string "PLACEHOLDER" "$PLIST"

    TARGET_BUILD_DIR="$WORKDIR" CONTENTS_FOLDER_PATH="bundle.app/Contents" \
        bash "$ASSIGN_CMD" >"$WORKDIR/last.out" 2>&1 || true

    actual="$(plutil -extract CFBundleIdentifier raw "$PLIST" 2>/dev/null || echo "<missing>")"
    if [ "$actual" = "$expected" ]; then
        printf '  ok    %-12s %-24s → %s\n' "$profile" "<$branch>" "$actual"
    else
        printf '  FAIL  %-12s %-24s → %s  (expected %s)\n' "$profile" "<$branch>" "$actual" "$expected"
        echo "        last-output: $(cat "$WORKDIR/last.out")"
        fail=$((fail + 1))
    fi
done

echo ""
echo "==> failure cases — branches that slugify to empty must be rejected"
for entry in "${FAIL_CASES[@]}"; do
    profile="${entry%%:*}"
    branch="${entry#*:}"

    plutil -create xml1 "$PLIST"
    plutil -insert BuildProfile -string "$profile" "$PLIST"
    plutil -insert BuildBranch -string "$branch" "$PLIST"
    plutil -insert CFBundleIdentifier -string "PLACEHOLDER" "$PLIST"

    if TARGET_BUILD_DIR="$WORKDIR" CONTENTS_FOLDER_PATH="bundle.app/Contents" \
        bash "$ASSIGN_CMD" >"$WORKDIR/last.out" 2>&1; then
        printf '  FAIL  %-12s %-24s   accepted (should have rejected)\n' "$profile" "<$branch>"
        fail=$((fail + 1))
    else
        # Ensure the error message mentions slugify, so a future
        # contributor seeing this error knows where to look.
        if grep -q "slugifies to the empty string" "$WORKDIR/last.out"; then
            printf '  ok    %-12s %-24s   rejected with clear message\n' "$profile" "<$branch>"
        else
            printf '  FAIL  %-12s %-24s   rejected but with vague message:\n' "$profile" "<$branch>"
            sed 's/^/        /' "$WORKDIR/last.out"
            fail=$((fail + 1))
        fi
    fi
done

if [ "$fail" -eq 0 ]; then
    echo ""
    echo "ok: ${#CASES[@]} mapping cases + ${#FAIL_CASES[@]} failure cases all pass"
    exit 0
fi
echo "FAIL: $fail case(s) did not match expectations" >&2
exit 1
