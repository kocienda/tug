#!/usr/bin/env bash
# lint-checks.sh — run one group of the repository's lint checks.
#
#   bash scripts/lint-checks.sh <audit|ts|rust|all>
#
# Each check runs from the repository root with its own output passing
# through, then prints `PASS: <name>` or `FAIL: <name>` on a line of its own.
# A failure does not stop the group, so one run names every red check; the
# script exits 1 if any failed. The `PASS:`/`FAIL:` lines are the items
# `tugtool test run --kind lines` records, which is how `tugtool test last
# --failures` names a red check without a second run (the `lint-*` recipes).
#
# `BUN_HANG_GUARD_MS` is the Justfile's one bun hang guard, passed in by the
# recipes so the value is written once.

set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

: "${BUN_HANG_GUARD_MS:?set by the Justfile lint recipes}"
guard="--timeout $BUN_HANG_GUARD_MS"

failed=0
check() {
    local name="$1" command="$2"
    if bash -c "$command"; then
        echo "PASS: $name"
    else
        echo "FAIL: $name"
        failed=1
    fi
}

audit() {
    check tugplug-lint "bun scripts/tugplug-lint.ts"
    check recipe-lint "bun scripts/recipe-lint.ts && bun test $guard scripts/__tests__/recipe-lint.test.ts"
    check test-shape-lint "bun scripts/test-shape-lint.ts && bun test $guard scripts/__tests__/test-shape-lint.test.ts"
    check workflow-lint "bun scripts/workflow-lint.ts && bun test $guard scripts/__tests__/workflow-lint.test.ts"
    check shellcheck "just shellcheck"
    check app-test-foreground-check "just app-test-foreground-check"
    check audit-visibility "cd tugdeck && bun run audit:visibility"
    check audit-motion "cd tugdeck && bun run audit:motion"
    check audit-type-alignment "cd tugdeck && bun run audit:type-alignment"
    check audit-tokens "cd tugdeck && bun run audit:tokens lint"
    check third-party-notices "bun scripts/third-party-notices.ts --check"
}

ts() {
    check tugdeck-check "cd tugdeck && bun run check"
    check tugdeck-lint "cd tugdeck && bun run lint"
    check tugcode-check "cd tugcode && bun run check"
    check tugcode-lint "cd tugcode && bun run lint"
    check app-test-check "cd tests/app-test && bun run check"
    check app-test-lint "cd tests/app-test && bun run lint"
}

rust() {
    check clippy "cd tugrust && cargo clippy --workspace --all-targets -- -D warnings"
    check fmt "cd tugrust && cargo fmt --all -- --check"
}

case "${1:-}" in
    audit) audit ;;
    ts) ts ;;
    rust) rust ;;
    all) audit; ts; rust ;;
    *)
        echo "usage: $(basename "$0") <audit|ts|rust|all>" >&2
        exit 2
        ;;
esac
exit "$failed"
