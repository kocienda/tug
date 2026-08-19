#!/bin/sh
# Tugtool's Tier 1 — "does the joined tree still pass the tests that bear on
# it?" — run once against the candidate, from the dash's workshop worktree.
#
# The selection is derived, never guessed: every app-test declares what it
# exercises with `@covers`, and `select-tests.ts` resolves the candidate's
# changed files through those declarations. That derivation is *this* project's
# and lives here rather than in tugdash-core, which runs what a project
# declares and knows nothing about `@covers`.
#
# The runner hands in TUG_VERIFY_BASE_SHA / TUG_VERIFY_CANDIDATE_SHA,
# TUG_REPO_UNIVERSE (this workshop), and TUG_APPTEST_ASSUME=background.
#
# Three outcomes are *not* failures and must not be reported as unqualified
# greens either. Each prints a TUG-VERIFY-NOTE line, which the runner carries
# onto the verdict:
#
#   - an empty selection — nothing covers what moved, which is an answer;
#   - the selector's over-budget exit (3), where it emits no filenames at all;
#   - its CORE TIER ADVISED advisory, for harness paths no `@covers` can scope.
#
# The last two fall back to the bare core tier, which is the standing answer to
# both. Treating exit 3 as a failure would make a large candidate unjoinable;
# treating it as green would be a lie.
set -eu

note() { echo "TUG-VERIFY-NOTE: $*"; }

base="${TUG_VERIFY_BASE_SHA:-}"
candidate="${TUG_VERIFY_CANDIDATE_SHA:-}"

if [ -z "$base" ] || [ -z "$candidate" ]; then
  note "no head pair in the environment; ran the core tier"
  just app-test
  exit $?
fi

changed=$(git diff --name-only "$base".."$candidate")
if [ -z "$changed" ]; then
  note "the candidate changes no files"
  exit 0
fi

selection_out=$(mktemp)
selection_err=$(mktemp)
trap 'rm -f "$selection_out" "$selection_err"' EXIT

set +e
# shellcheck disable=SC2086
(cd tests/app-test && bun scripts/select-tests.ts $changed) \
  >"$selection_out" 2>"$selection_err"
selector_status=$?
set -e

cat "$selection_err" >&2

if [ "$selector_status" -eq 3 ]; then
  note "selection exceeded the 20-file budget; ran the core tier instead"
  just app-test
  exit $?
fi

if [ "$selector_status" -ne 0 ]; then
  echo "verify-tier1: select-tests failed (exit $selector_status)" >&2
  exit "$selector_status"
fi

if grep -q "CORE TIER ADVISED" "$selection_err"; then
  note "a changed path runs before any test's first assertion; ran the core tier"
  just app-test
  exit $?
fi

selection=$(tr '\n' ' ' <"$selection_out")
if [ -z "$(echo "$selection" | tr -d '[:space:]')" ]; then
  note "no app-test covers what this candidate changed"
  exit 0
fi

# `@foreground` tests are skipped under TUG_APPTEST_ASSUME=background — the
# guard that stops a join from seizing the screen. A green over a selection
# that skipped some is a green with exclusions, and says so.
verdict=$(mktemp)
trap 'rm -f "$selection_out" "$selection_err" "$verdict"' EXIT

set +e
# shellcheck disable=SC2086
TUG_APPTEST_JSON="$verdict" just app-test $selection
run_status=$?
set -e

# `filesSkipped` is exactly the background guard's count: the recipe records a
# SKIP row for every `@foreground` file it declined to run.
skipped=$(jq -r '.totals.filesSkipped // 0' "$verdict" 2>/dev/null || echo 0)
if [ "${skipped:-0}" -gt 0 ]; then
  note "$skipped test file(s) skipped under the background guard — green with exclusions"
fi

exit "$run_status"
