<!-- brief-skeleton v1 -->

# Move the `app-test` recipe into a script, kill the process group on a wedge, and cap on a median

**Purpose:** The `app-test` recipe is 1,163 lines of bash inside the Justfile, where no linter and no test can reach it. Its watchdog kills direct children only, so a wedged test's grandchildren outlive the kill, and its cap is three times the last run, so one slow run triples the next cap.

---

## Purpose {#purpose}

Item 24 of `briefs/audit-punch-list.md`:

> 24. Move the `app-test` recipe out of the Justfile into a script shellcheck and the existing script tests can reach, kill the process group on wedge, and base the cap on a median rather than the last run.

Every recipe name, flag, environment variable, and output line stays the same. `just app-test …` is the door and remains it.

---

## Evidence {#evidence}

**[F01] The recipe** — `justfile:1575-2737`, 1,163 lines with a `#!/usr/bin/env bash` shebang and `set -uo pipefail` (no `-e`, on purpose). It re-executes itself through the gate at :1731 (`tugtool host gate run --name apptest … -- just --quiet app-test`), marking the inner pass with `TUG_APPTEST_GATED=1`. Its siblings are small: `app-test-changed` (14 lines), `app-test-all` (5), `app-test-build` (15), and the rest two lines each. **(verified)**

**[F02] The scripts beside it are tested; the recipe is not** — `tests/app-test/scripts/` has `select-tests.ts` (1,322 lines) with five test files, `wedge-cap.ts` (89) with `wedge-cap.test.ts` (153), `run-capped.sh` (51) with four tests inside `wedge-cap.test.ts`, and `rank.ts` with its test. `just app-test-logic` runs them (`justfile:123`). `shellcheck` is not installed and nothing in `just lint`, CI, or any package.json runs it. **(verified)**

**[F03] The kill reaches one generation** — `run-capped.sh` starts the command with `"$@" &`, and past the cap does `kids="$(pgrep -P "$child")"; kill -TERM $kids "$child"`, then `-KILL` after `TUG_APPTEST_WEDGE_GRACE` (5 s). Its trap forwards the same way. There is no `setsid`, `set -m`, or `setpgid` anywhere in the Justfile or the scripts, so every per-file `bun test` and the `Tug.app` it launches share the recipe's process group; the recipe's `reap_stragglers` (:2145) covers the app with a prefix-scoped `tugtool host instance stop` because the kill cannot. **(verified)**

**[F04] The cap is the last run times three** — `wedge-cap.ts`: `WEDGE_MULTIPLE = 3`, `WEDGE_FLOOR_SECS = 120`, `capSecs = max(120, ceil(lastSecs * 3))`, falling back to the file's declared `TEST_TIMEOUT_MS`. It reads `tugtool apptest history --json`, whose `file_history` (`tugtool-core/src/apptest_ledger.rs:361`) returns a per-file summary with one `lastSecs`: the newest non-skip, non-wedge outcome's seconds. No list of durations is returned, so a median cannot be computed from what the ledger offers today. **(verified)**

---

## Decisions {#decisions}

**[B01] The recipe body moves verbatim to `tests/app-test/scripts/app-test.sh`, and the recipe becomes three lines that `exec` it with `{{FILES}}`.** Verbatim first: the move is proven by a run whose output is byte-identical to the one before it, and only then does anything inside change. `app-test-changed` and `app-test-all` keep calling `just app-test`, so the gate re-exec at [F01] is unchanged.

**[B02] `shellcheck` joins `just lint` over `tests/app-test/scripts/*.sh` and `tugrust/scripts/*.sh`, with a `.shellcheckrc` for the two or three codes the house style disables and a reason each.** It is on the CI runner's image and one `brew install` locally; `just lint` prints the install line when it is missing rather than failing silently. The first run is a sweep of what it finds in the moved body, each fix its own small edit.

**[B03] `run-capped.sh` puts the command in its own process group with `set -m` and kills the group: `kill -TERM -- -$child`, then `-KILL` after the grace.** [F03]. macOS ships no `setsid`, and job control is the portable way to get a group. The four existing tests gain a fifth that spawns a grandchild and asserts it is gone after the cap. `reap_stragglers` stays as the belt to this suspender.

**[B04] `file_history` returns the last five non-wedge durations as `recentSecs`, and `wedge-cap.ts` caps on three times their median, floored at 120 s.** Five is enough to shrug off one slow run and few enough that a file that got slower on purpose moves the cap within a week. `lastSecs` stays in the JSON for the `history:` line. The ledger query is one more column in the row it already reads; the JSON field is additive.

**[B05] Beyond [B02]'s sweep, the script's logic is not refactored in this arc.** The body is a single bash program with twenty-odd functions; the arc puts it where a test can reach it and proves the move. Splitting its phases is a follow-on once it has lived outside the Justfile for a while and the first tests against it say which seams are real.

---

## Open Questions {#open-questions}

- None. The script's behaviour is observable from its output, which the arc holds fixed.

---

## Non-goals {#non-goals}

- **Changing any output line, flag, or environment variable.** The report format is a contract with the memory notes and the skills.
- **Refactoring the script's structure.** [B05].
- **Changing the selection, `@covers`, or the batch size.** `harness-helpers-and-tolerances-brief.md` touches the selector.

---

## Exit {#exit}

An arc. Steps as ordered: the verbatim move with a before-and-after run of one fast file (tens of seconds each); `shellcheck` into `just lint` and its sweep; the process-group kill with its test; `recentSecs` in the ledger and the median cap with its tests. `just app-test-logic` and `cargo nextest run -p tugtool-core` are each step's verdict; the core tier (`just app-test`) runs once at the end, since the runner itself runs before any test's first assertion.
