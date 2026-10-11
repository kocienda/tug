<!-- brief-skeleton v1 -->

# Lift the five app-test helpers the harness arc left copied

**Purpose:** The harness arc lifted three of the eight copied helpers its brief named and left five in place. Each of the five has exactly one body across every copy: `seed` in 15 files, `census` in 12, `arcReport` in 11, `standUp` in 10, `buildFixtureJsonl` in 9. Fifty-seven files carry a fixture that one file should own.

---

## Purpose {#purpose}

From the audit of 2026-10-11:

> Five harness helpers were left copied. `seed`, `census`, `arcReport`, `standUp`, and `buildFixtureJsonl` still exist in 57 files between them, and each has exactly one body across all its copies.

No test changes what it asserts. A lifted helper is byte-for-byte the body the file had, called by import instead of defined in place.

---

## Evidence {#evidence}

**[F01] The five, and that each is one body** — hashing the body of every definition from its `function` line to its closing brace: `seed` 15 files, 1 body (8 lines); `census` 12 files, 1 body (39 lines); `arcReport` 11 files, 1 body (7 lines); `standUp` 10 files, 1 body (16 lines); `buildFixtureJsonl` 9 files, 1 body (73 lines). **(verified)**

**[F02] What they are** — `seed(app)` seeds a three-pane deck and waits for the panes; `census(app, cardId, value, …)` reads a fold census off the deck; `arcReport(name)` reads an arc's stopped, resume, and done facts from its report; `standUp(testName)` launches the app with deck trace on and seeds a 900×760 session card; `buildFixtureJsonl(cwd, sessionId)` builds a replay transcript. **(verified by reading the first copy of each)**

**[F03] `seed` and `standUp` are not free-standing** — `seed` calls the file's local `deckShape()`, and `standUp` calls `sessionCardShape` with a fixed size. The hash in [F01] says the `seed` bodies agree, so the fifteen files' `deckShape()` is the lifted `sessionCardShape` or a sibling in every case; which, is read at the step. **(verified for the call; inferred for the shape)**

**[F04] Where the lifted ones went** — `_harness/fixtures.ts` holds `inputSelectorFor`, `mkTextFixture`, `oneTurnSessionJsonl`; `_harness/shapes.ts` holds `sessionCardShape`, the three named sizes, and `priorCardDeck`. **(verified)**

---

## Decisions {#decisions}

**[B01] The five join `_harness/fixtures.ts`, each exported under its own name with its body unchanged, and the 57 definitions become imports.** The one-body fact in [F01] is what makes this a move; a helper whose copies disagreed would be a design question, and none of these is.

**[B02] `seed` takes the shape as a parameter, defaulting to the shape the fifteen files share, and `standUp` takes its size the same way.** [F03]: a helper that reaches for a file-local name cannot be lifted as is; a parameter with the current value as its default keeps every call site a one-word change.

**[B03] The gauge is zero local definitions of the five names across `tests/app-test/*.test.ts`, checked by a test in `_harness/` that greps for them, in the same shape as the existing `@covers` check.** A sweep without a gate is a sweep that gets undone one file at a time.

---

## Open Questions {#open-questions}

- None.

---

## Non-goals {#non-goals}

- **Lifting anything beyond the five.** The arc that found these also found groups of six and smaller; they are not one-body groups and are not in scope.
- **Changing any helper's behaviour or any assertion.**

---

## Exit {#exit}

An arc, likely one step per helper with the gate landing with the last. `bun run check` in `tests/app-test` and the harness unit suite are each step's verdict. The core tier (`just app-test`) runs once at the end, since `_harness/` runs before any test's first assertion; no other app-test run is needed because no test's behaviour changes.
