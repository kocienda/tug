#!/bin/bash
set -euo pipefail

# test-slug-parity.sh — verifies that the bash and Swift implementations
# of the branch-slug algorithm produce byte-for-byte identical output
# across the full case table.
#
# Drift between the two implementations would silently produce wrong
# bundle IDs (assign-bundle-id.sh would compute one slug; Swift's
# BuildInfo.instanceId would compute another), so this test runs on
# every commit that touches either side.
#
# Inputs:
#   tugrust/scripts/branch-slug.sh      — canonical bash slugifier
#   tugapp/Sources/BranchSlug.swift     — canonical Swift slugifier
#   tugapp/TugTests/BranchSlugTests.swift — shared case table (24 cases)
#
# Strategy:
#   1. Parse the inputs out of the XCTest case table via awk, so adding
#      a case to BranchSlugTests.swift extends both the unit test
#      (`just test-swift`) and this parity test automatically.
#   2. Compile a one-shot Swift binary that reads inputs on stdin and
#      prints slugs (vs. spawning `swift` per case, which is ~1s/case).
#   3. Run the same inputs through `bash branch-slug.sh` line by line.
#   4. Diff the outputs.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

BASH_SLUG="$REPO_ROOT/tugrust/scripts/branch-slug.sh"
SWIFT_SLUG="$REPO_ROOT/tugapp/Sources/BranchSlug.swift"
DRIVER="$REPO_ROOT/tugapp/TugTests/BranchSlugTests.swift"

for f in "$BASH_SLUG" "$SWIFT_SLUG" "$DRIVER"; do
    if [ ! -f "$f" ]; then
        echo "error: $f not found" >&2
        exit 1
    fi
done

WORKDIR="$(mktemp -d -t test-slug-parity.XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT INT TERM

INPUTS="$WORKDIR/inputs.txt"
SWIFT_SRC="$WORKDIR/parity.swift"
SWIFT_BIN="$WORKDIR/parity"

# Parse inputs out of BranchSlugTests.swift's case table. The table
# uses literal Swift syntax with no escaped quotes inside the input
# strings, so a simple "first quoted segment per case line" extractor
# is sufficient.
awk '
    /^let branchSlugCases:/ { in_cases = 1; next }
    in_cases && /^\]/  { in_cases = 0; next }
    in_cases && /^[[:space:]]*\("/ {
        s = $0
        sub(/^[[:space:]]*\("/, "", s)
        sub(/".*$/, "", s)
        print s
    }
' "$DRIVER" > "$INPUTS"

case_count="$(wc -l < "$INPUTS" | tr -d ' ')"
if [ "$case_count" -lt 20 ]; then
    echo "error: parsed only $case_count cases from $DRIVER — extractor regex may be stale" >&2
    exit 1
fi

# Build the one-shot Swift binary: BranchSlug source + a readLine
# driver. `swiftc -O` produces a binary that processes all 24 inputs
# in milliseconds; the one-time compile is ~1s.
cat "$SWIFT_SLUG" > "$SWIFT_SRC"
cat >> "$SWIFT_SRC" <<'SWIFT_END'
while let line = readLine(strippingNewline: true) {
    print(BranchSlug.compute(line))
}
SWIFT_END

if ! swiftc -O -o "$SWIFT_BIN" "$SWIFT_SRC" 2>"$WORKDIR/swiftc.err"; then
    echo "error: swiftc failed to compile the parity driver" >&2
    cat "$WORKDIR/swiftc.err" >&2
    exit 1
fi

# Run both implementations against the same input set. Write outputs
# to files (rather than command-substitution capture) so the trailing
# empty-string case survives — `$(...)` strips trailing newlines.
SWIFT_OUT="$WORKDIR/swift.out"
BASH_OUT="$WORKDIR/bash.out"

"$SWIFT_BIN" < "$INPUTS" > "$SWIFT_OUT"

# `bash branch-slug.sh` deliberately emits no trailing newline (the
# caller interpolates the output into a string literal). Append `\n`
# explicitly so the per-case outputs are line-separated for diff.
: > "$BASH_OUT"
while IFS= read -r input || [ -n "$input" ]; do
    bash "$BASH_SLUG" "$input" >> "$BASH_OUT"
    printf '\n' >> "$BASH_OUT"
done < "$INPUTS"

if diff -q "$BASH_OUT" "$SWIFT_OUT" >/dev/null; then
    echo "ok: $case_count parity cases — bash and Swift slugify agree byte-for-byte"
    exit 0
fi

echo "FAIL: bash and Swift slugify diverge"
paste "$INPUTS" "$BASH_OUT" "$SWIFT_OUT" \
    | awk -F'\t' '$2 != $3 {
        printf "  input=<%s>  bash=<%s>  swift=<%s>\n", $1, $2, $3
      }'
exit 1
