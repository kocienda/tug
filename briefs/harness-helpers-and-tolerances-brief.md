<!-- brief-skeleton v1 -->

# Lift the app-tests' copied helpers into `_harness/`, name the tolerances once, and tag the motion files

**Purpose:** 299 app-test files each define their own `deckShape`, 84 of them in three byte-identical groups that differ only in window size; eight more helpers are copied into nine to fifteen files each; pixel and timing tolerances are 56 locally named constants and hundreds of literals; and the motion files that fail under batch contention carry nothing the selector can read to keep them out of a batch.

---

## Purpose {#purpose}

Item 25 of `briefs/audit-punch-list.md`:

> 25. Lift the 83 byte-identical harness helpers into `_harness/`, route pixel and timing thresholds through one tolerance table, and tag motion files so the selector can keep them out of contended batches.

No assertion changes its threshold. A test that passed before the sweep passes after it with the same number, now spelled by name.

---

## Evidence {#evidence}

**[F01] `deckShape`** — 299 definitions in 299 of 469 `*.test.ts` files; hashing each body gives 150 distinct bodies. The three largest identical groups have 44, 22, and 18 members (84, not 83), and all three are the single-pane session-card shape differing only in `size`: 900×680, 820×620, 900×640. The next groups are 14, 6, 6, 5, 5. **(verified)**

**[F02] Eight more helpers, defined where they are used and exported by nothing** — `seed` 15 files, `mkFixture` 14, `priorCardDeck` 13, `census` 13, `buildFixtureJsonl` 12, `arcReport` 11, `standUp` 10, `inputSelectorFor` 9. Whether each group's bodies are identical was not hashed; [F01]'s ratio suggests most are. **(verified for the counts; the bodies are the arc's first reading)**

**[F03] `_harness/`** — `index.ts` is 2,768 lines (`App`, `launchTugApp`, `note`, the motion census, and re-exports); beside it `client.ts` 1,950, `matchers.ts` 970, `types.ts` 697, `rpc.ts` 354, and a dozen smaller files; 9,096 lines in all. No tolerance module: zero matches for `TOLERANCE` or `EPSILON`; the only `_MS` constants are the settle and quiesce budgets. **(verified)**

**[F04] Thresholds** — 246 files use a numeric matcher; `toBeLessThanOrEqual` 311 uses, `toBeGreaterThan` 455, `toBeLessThan` 199, `toBeCloseTo` 107. Literal upper bounds take 26 distinct values, led by 1 (63), 0.5 (50), 2 (22), 1.5 (14), 4, 8, 0.51. Named local constants: 56 in 51 files (`TOL = 1.5` ×10, `EPSILON = 3` ×6, `EPSILON = 1.5` ×4, `SCROLL_TOLERANCE_PX = 8` ×3, `RESTORE_TOLERANCE_PX = 2` ×3). **(verified)**

**[F05] Motion files and the selector** — `at0538`, `at0539`, `at0624`, `at0643`, `at0685`, `at0696` to `at0718` exist (`at0707` is two files; `at0719` does not exist). Their docblocks carry only `@covers`. The selector (`select-tests.ts:445-446`) knows two tags, `@covers` and `@foreground` (43 files). The batch loop is `justfile:2333-2352` with `JOBS` from `TUG_APPTEST_JOBS` (default 4, clamped 1 to 8, :2113-2122), and the memory notes record that these files go red in batches and green alone. **(verified)**

---

## Decisions {#decisions}

**[B01] `_harness/shapes.ts` exports `sessionCardShape(size)` and the three named sizes, and the 84 files import it; the groups of 14 and below are read and lifted where the body is the same shape with another size, left where it is a different deck.** The gauge is `function deckShape` definitions: from 299 down to the count of genuinely distinct decks, which the arc records. A copied body in a test file is a fixture nobody reviews; a shared one is.

**[B02] `_harness/fixtures.ts` takes the eight helpers in [F02], after hashing each group: identical bodies lift as one export, variants lift as one export with a parameter where the difference is a value, and a variant that is a different function keeps its name and a comment saying why.** Same gauge, per helper. `_harness/index.ts` does not grow; the new files are imported by name.

**[B03] `_harness/tolerances.ts` names the house values: `PIXEL_TOL` 1.5, `SUBPIXEL_TOL` 0.5, `SCROLL_TOL_PX` 8, `RESTORE_TOL_PX` 2, and the timing budgets already in `index.ts`, each with a sentence saying what it tolerates.** The 56 local constants whose value matches a named one import it; a local constant with another value keeps its number and gains a comment, because a different tolerance is a decision and the sweep must not flatten it. The hundreds of bare literals in [F04] are not touched in this arc: most of them are counts and orderings, not tolerances, and telling one from the other is a reading per site that a later sweep can do against the table once it exists.

**[B04] A `@motion` docblock tag, read by the selector beside `@covers` and `@foreground`, and honoured by the batch loop: motion files run last, one at a time.** [F05]. The 30 files get the tag in one step; `app-test-covers-check` gains the rule that a file under the per-gesture settle range carries it; the batch loop in the runner script (or the Justfile, if `app-test-runner-script` has not landed) partitions the selection into the batched set and the serial tail. A motion file red in a batch and green alone is the shape the memory notes describe, and running it alone by default ends the re-run.

**[B05] Order: [B04] first, then [B01], [B02], [B03].** The tag is the smallest change and the one that changes a verdict; the lifts are mechanical and large; the tolerance table is last because it is the one the arc should spend its judgment on, with the lifts already proving the harness can absorb new modules without the core tier moving.

---

## Open Questions {#open-questions}

- Whether `@motion` files should also force `JOBS=1` for the whole run when they are in the selection, or only be serialized among themselves. The default is the serial tail in [B04]; if the tail still goes red beside a concurrent `build-app`, that is the gate's problem (the runner brief), not the tag's.

---

## Non-goals {#non-goals}

- **Changing any threshold's value.** [B03].
- **Sweeping the bare literals.** [B03].
- **Splitting `_harness/index.ts`.** The new modules go beside it; carving `App` is its own arc.
- **Changing the selector's cap or ranking.**

---

## Exit {#exit}

An arc. Steps as ordered in [B05]. `just app-test-logic` (the selector and harness unit tests) and `bun run check` in `tests/app-test` are each step's verdict. The core tier (`just app-test`) runs once after the first harness module lands, since `_harness/` runs before any test's first assertion, and once more at the end; the motion tail runs once after [B04] as the proof it runs serial.
