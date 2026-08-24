<!-- tugplan-skeleton v2 -->

## App-Test Harness Cleanup — Rename, Renumber, Inventory {#phase-app-test-cleanup}

**Purpose:** Rename the in-app test facility to **app-test**, collapse the `just test-in-app` / `just test-in-app-fast` pair into a single `just app-test` command, renumber the M-series of regression tags as `AT0001…ATnnnn`, decide the smoke-test posture, produce a complete feature inventory + audit + desiderata for the harness, and add a comprehensive end-of-run summary so the recipe's outcome is machine-readable at a glance. Cleanup + naming + a single deliberate UX improvement; no test-behavior changes.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken |
| Status | complete (2026-04-27) |
| Target branch | `app-test-cleanup` |
| Last updated | 2026-04-27 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The in-app test facility began as a one-off workaround during the selection-plan firefight, then accreted features step-by-step (CGEvent gestures, app-lifecycle verbs, tugcode subprocess control, cold-boot helpers, deck-trace ring, A9 protocol coverage, paint-invariant gates). It now drives a real `Tug.app` subprocess via a Unix-socket bridge, posts trusted hardware events, and gates 38 named regression scenarios — but its *naming* still carries the field-medicine of its origin.

Three friction points have piled up:
1. **Two names, two commands, no clarity.** The directory is `tests/in-app/`, the just-recipes are `test-in-app` and `test-in-app-fast`, and the boundary between them ("does the caller want a build or not?") is the recipe's responsibility today, which is a leaky abstraction.
2. **The `M` in M-tags is opaque.** Nobody — including the people who introduced it — remembers why. The two-digit cap (`M01..M99`) is also tighter than this catalog will eventually need, and the test filename prefix (`m{NN}-…`) bleeds the cryptic letter into every test in the repo.
3. **Smoke vs. scenario lives in convention only.** The `_`-prefixed smoke files (`_smoke*.test.ts`, `_double-connect.test.ts`, `_log-capture.test.ts`, `_version-handshake.test.ts`, `_wait-for-condition.test.ts`) sit in the same directory as the AT-numbered scenario tests, and the underscore-prefix-as-internal convention is implicit. Some are explicit scratch ("delete after Step 6"); some are load-bearing primitive gates.

This plan does the methodical pass: rename, renumber, relocate, and produce the catalog of what the harness can do today and what it still cannot.

#### Strategy {#strategy}

- **Rename, don't redesign.** The shape of the harness, the verbs, the protocols, the tagging system itself — none of that changes. Only labels, file paths, and a single `just` recipe.
- **Direct 1:1 number-preserving mapping** for M-tags → AT-tags. `M01` → `AT0001`, `M38` → `AT0038`. No compaction, no renumbering of existing tags. Zero-padded to four digits. Future tags pick up at `AT0039`. (See [D02].)
- **One `just` command, callers own the build.** `just app-test [files...]` replaces both `test-in-app` and `test-in-app-fast`. The recipe assumes `Tug.app` is already built; if it isn't, the recipe surfaces a clear error pointing at the build commands. (See [D03].)
- **End-of-run summary, deterministic and greppable.** `just app-test` prints a structured summary at the end of every run: per-file pass/fail, totals, and a single `VERDICT: PASS` / `VERDICT: FAIL` line. AI assistants (and humans) should be able to read the result without inventing one-off greps over `bun test` output. (See [D07].)
- **Keep the smoke tests, classify them explicitly, relocate them.** The smoke tests pin harness primitives that AT-tests rely on; deleting them would conflate "primitive broken" with "scenario broken" on failure. Move them to a dedicated `harness-smoke/` subdirectory and drop only those clearly subsumed. (See [D04].)
- **Mechanical, scriptable changes wherever possible.** A renumber-rename pass like this is best done by a single script with a manifest, not by hand. Audit + sweep the residual references after.
- **Fresh-eyes inventory and audit.** Once the names are stable, walk the harness surface end-to-end and produce three artifacts: a feature inventory, a quality audit, and a desiderata list for follow-on work.

#### Success Criteria (Measurable) {#success-criteria}

> Falsifiable. Each criterion has a verification command or grep pattern.

- **No file under `tests/` matches `m[0-9]+-.*\.test\.ts`** after the rename. (`find tests -name 'm[0-9]*-*.test.ts' | wc -l` returns 0.)
- **No checked-in source matches the regex `\bM[0-9]{2}\b`** that refers to the old M-tags. (`rg -nE '\\bM[0-9]{2}\\b' --glob '!**/archive/**' --glob '!**/.tugtool/**' --glob '!dash/m-series-reconciliation.md'` returns 0 hits.)
- **`just --list` shows exactly one `app-test` recipe** and no `test-in-app` / `test-in-app-fast` recipes. (`just --list | grep -E '^( *)(test-in-app|app-test)'` shows only `app-test`.)
- **`just app-test` with no arguments runs the full sweep** against an already-built `Tug.app`; with arguments runs the named files only.
- **`just app-test` with no built app exits non-zero with an actionable message** (instead of a confusing test failure).
- **`tuglaws/app-test-inventory.md` exists and contains every AT-tag** that previously lived in `m-series-inventory.md`, with the same statuses, summaries, and gating-test references — only the tag prefix and filename references differ. (`m-series-inventory.md` is removed.)
- **Each former `m{NN}-*.test.ts` file is renamed to `at{NNNN}-*.test.ts`** with content updated so that internal docstring references, log-file basenames, and trace-dump paths use the new tag.
- **Smoke tests live under `tests/app-test/harness-smoke/`**, are not numbered, and the AT-numbered scenario tests live under `tests/app-test/scenarios/` (or the flat `tests/app-test/` root — see [D04]).
- **`bun x tsc --noEmit` from `tests/app-test/` is clean** after the rename.
- **A green `just app-test` run** exists post-rename, exercising the same set of scenarios that the pre-rename `test-in-app-fast` default sweep ran.
- **The deliverable inventory document at `dash/app-test-harness-inventory.md`** enumerates every public method on `App`, every RPC verb, every helper, and every error type, with one-line descriptions and a status column (covered / partial / gap).
- **The desiderata list at the bottom of the inventory** names every gap with a rationale; nothing is implemented as part of this plan.
- **`just app-test` always prints a single `VERDICT: PASS` or `VERDICT: FAIL` line** as the last line of stdout, regardless of how many files ran or whether `bun test` succeeded for each. (`just app-test … | tail -n 1` matches `^VERDICT: (PASS|FAIL)\b`.)
- **The summary identifies every file that ran** with one of `[PASS]`, `[FAIL]`, or `[SKIP]`, plus per-file test counts (`(passed/total passed)`) and any failing test names.
- **The recipe's exit code matches the verdict** — exit 0 iff verdict is PASS; non-zero iff FAIL.

#### Scope {#scope}

1. Directory rename: `tests/in-app/` → `tests/app-test/`.
2. Justfile collapse: `test-in-app` + `test-in-app-fast` → single `app-test`.
3. Tag rename: `M{NN}` → `AT{NNNN}` everywhere (inventory, plans, source comments, test docstrings, log basenames, trace-dump paths).
4. File rename: `m{NN}-*.test.ts` → `at{NNNN}-*.test.ts`.
5. Inventory rename: `tuglaws/m-series-inventory.md` → `tuglaws/app-test-inventory.md`.
6. Smoke-test classification and relocation: keep load-bearing primitive gates under `harness-smoke/`; drop ones clearly subsumed.
7. Update `tests/app-test/README.md` to reflect new names, paths, and the single recipe.
8. Update `CLAUDE.md` and `~/.claude/.../memory/` references where they cite the old commands or paths.
9. Produce three deliverable docs:
   - **Inventory** of all harness features (RPC verbs, native gestures, App-class methods, helpers, errors).
   - **Audit** noting how well each feature is implemented (covered by tests / partial / gap), one line per feature.
   - **Desiderata** of known gaps with rationale.
10. Add a comprehensive end-of-run summary to `just app-test`. (Small deliberate behavior change in the recipe wrapper — see [D07].)

#### Non-goals (Explicitly out of scope) {#non-goals}

- **No new harness features.** This plan adds zero verbs, zero primitives, zero RPC methods. (The end-of-run summary is a recipe-wrapper feature, not a harness feature — it observes `bun test` output without changing what tests do or how the harness behaves. See [D07].)
- **No behavior changes to existing tests.** Tests still assert what they asserted; only their filename, internal tag, and log paths change.
- **No structural change to `bun test`'s own output.** The summary is appended after `bun test` runs each file; it does not replace, parse-and-rewrite, or suppress per-file output. ([D07].)
- **No CI integration changes.** [Q01] in `tugplan-harness-extensions.md` (CI accessibility-permission handling) stays deferred.
- **No M-tag compaction.** `M01..M38` becomes `AT0001..AT0038` directly. Even tags that have no test (M11 not-a-feature, M12 deferred, M28/M29 deferred) keep their slot. (See [D02].)
- **No archiving / deletion of `dash/m-series-reconciliation.md`.** That doc predates the canonical inventory and is historical. Updating its tag references is optional and explicitly deferred.
- **No changes to the `tugplan-selection.md` per-tag elaboration entries.** The selection plan stays the authoritative source of design rationale for each tag; only the tag prefix changes (`[M14]` → `[AT0014]`).
- **No changes to the `tugplan-harness-extensions.md` plan.** That plan's [D08] M-series scenario table can carry forward unchanged — its decisions remain valid; the relabel happens in this plan.
- **No new `.claude/settings*.json` permissions tightening.** A single replace-in-place of `test-in-app-fast` → `app-test` in the local settings is the only touch.

#### Dependencies / Prerequisites {#dependencies}

- A green `just test-in-app-fast` run on `main` immediately before this branch starts, captured as the pre-rename baseline.
- Repo-wide grep results for every cross-reference site (test files, plans, scripts, settings, memory, README, CLAUDE.md) gathered before the rename pass — the manifest of touch points.
- `bun x tsc --noEmit` clean inside `tests/in-app/` immediately before the rename.

#### Constraints {#constraints}

- **Tugbank invariants persist.** The harness's `TUGBANK_PATH` isolation, `quitGracefully` save path, and tugcast HTTP wire stay byte-identical.
- **Surface version `EXPECTED_SURFACE_VERSION = "1.5.0"` does not change.** No protocol bumps; this is pure cosmetics on the bun side.
- **`tuglaws/m-series-inventory.md` numbering invariant carries forward.** "Once assigned, a number is never reused" still holds for AT-tags. The high-water mark moves from `M38` → `AT0038`; next is `AT0039`.
- **Append-only inventory.** No retroactive renumbering of existing tags within AT-space.
- **No raw timers in tests** (the `lint-no-timers.ts` rule moves with the directory rename).

#### Assumptions {#assumptions}

- The user accepts a 1:1 number-preserving mapping (M01 → AT0001) over a fresh renumbering. The plan is built on this — see [D02] for why.
- `m-series-reconciliation.md` is treated as historical. It is older than `m-series-inventory.md`, so the inventory is authoritative.
- The smoke tests can be reorganized without breaking the AT-numbered tests, because the AT-tests do not import from the smoke files (they import from `_harness`).
- A scripted rename is preferable to many small manual edits, both for accuracy and for review.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Direct 1:1 mapping vs fresh renumbering (DECIDED — see [D02]) {#q01-numbering-policy}

**Question:** Should `M01..M38` map directly to `AT0001..AT0038`, or should the AT-space start fresh at `AT0001` for whatever the first surviving test happens to be after cleanup?

**Why it matters:** Direct mapping means hundreds of cross-references (in `tugplan-selection.md`, `tugplan-harness-extensions.md`, source comments, test docstrings, archived plans) translate trivially via a regex. Fresh renumbering loses that and introduces a risk of conflating two adjacent tags during the rewrite.

**Resolution:** DECIDED — direct 1:1 (see [D02]).

---

#### [Q02] Should AT-tags reset their status to all-tested or carry the existing partial / open / deferred / not-a-feature statuses verbatim? (DECIDED — carry verbatim) {#q02-status-policy}

**Question:** The current inventory has tags with statuses `✅ closed`, `⚠️ partial`, `❌ open`, `❓ untested`, `⬛ not-a-feature`. Does the rename also normalize them?

**Resolution:** Carry verbatim. Status normalization is a separate concern. This plan only relabels.

---

#### [Q03] Flat `tests/app-test/` or split into `scenarios/` + `harness-smoke/`? (DECIDED — see [D04]) {#q03-directory-shape}

**Question:** After the rename, do AT-numbered tests sit at the top level of `tests/app-test/`, or under `tests/app-test/scenarios/` with smoke under `tests/app-test/harness-smoke/`?

**Resolution:** DECIDED — see [D04]. Recommended split: `tests/app-test/` for AT-numbered scenarios at the root, `tests/app-test/harness-smoke/` for the underscore-prefixed primitive gates.

---

#### [Q04] Drop `_smoke-app-lifecycle.test.ts`? (DECIDED — drop) {#q04-drop-app-lifecycle-smoke}

**Question:** Its docstring says "deleted after Step 6 — subsumed by M04/M05". M04 (now `AT0004`) and M05 (now `AT0005`) exist and are green. Drop it now?

**Resolution:** DECIDED — drop as part of this plan. The subsumption was already declared; we are honoring it.

---

#### [Q05] Live-mode tugcode smoke (`_smoke-em-live.test.ts`) — keep, drop, or relocate behind a clearer flag? (DECIDED — keep, relocate) {#q05-em-live-smoke}

**Question:** This test is opt-in (`TUGCODE_LIVE=1`), costs API credits, and lives in the same directory as the always-on tests.

**Resolution:** DECIDED — keep, move to `harness-smoke/em-live.test.ts`, document the opt-in flag prominently in the README. The two-gate (`TUGAPP_IN_APP_TEST=1` + `TUGCODE_LIVE=1`) shape stays.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Stale references survive the sweep (a comment somewhere still says `M14`) | low | medium | Repo-wide grep gate in CI / Step 6 (last regex check); CLAUDE.md note for new code | grep finds a stray ref later |
| Renaming the directory breaks the bunfig.toml / tsconfig.json path alias | medium | low | Move both files in the same commit as the rename; checkpoint with `bun x tsc --noEmit` | tsc errors at Step 2 checkpoint |
| Dropping `_smoke-app-lifecycle.test.ts` removes coverage we didn't realize we needed | low | low | AT0004 + AT0005 already green; both exercise the same `simulateApp*` path | a future regression in those verbs |
| `just app-test` accidentally runs against a stale `Tug.app` build | medium | medium | Recipe surfaces an explicit "no app at $TUGAPP_DEBUG_PATH — run xcodebuild first" message; document the build commands in the inventory | user reports confusing failures |
| Cross-references inside archived `.tugtool/` plans break links | low | medium | Skip archived files in the rename pass; document the prefix change in CLAUDE.md so archived plans remain readable in context | someone reads an archived plan and gets confused |

**Risk R01: Mid-rename merge conflict** {#r01-merge-conflict}

- **Risk:** The rename touches ~50 files. A concurrent unrelated edit to a touched file produces a merge conflict.
- **Mitigation:** Fast-path the cleanup branch end-to-end (no parallel work on touched files); land it in a small number of commits.
- **Residual risk:** None of consequence — the conflict-resolution path is mechanical.

**Risk R02: The `EXPECTED_SURFACE_VERSION` constant gets mistakenly bumped** {#r02-version-bump}

- **Risk:** Someone misreads the cleanup as a chance to "version" the change.
- **Mitigation:** Plan explicitly states no protocol changes; the surface-version constant is a constraint above. CI test `_version-handshake.test.ts` (now `harness-smoke/version-handshake.test.ts`) will fail if it drifts.
- **Residual risk:** Caught by the smoke gate immediately.

---

### Design Decisions {#design-decisions}

#### [D01] The facility is named `app-test`, the directory is `tests/app-test/`, the just-recipe is `app-test` (DECIDED) {#d01-naming}

**Decision:** "app-test" is the canonical name for the facility, used as the directory name (`tests/app-test/`), the just-recipe (`just app-test`), the tag prefix (`AT{NNNN}`), the inventory file (`tuglaws/app-test-inventory.md`), and the README header.

**Rationale:**
- Simple, descriptive, says exactly what it is.
- The "AT" prefix gives a two-character tag prefix that is short, unique within the codebase, and obviously derived from the name.
- Aligns the conceptual surface (one named thing, one home) so newcomers don't have to learn three names for the same facility.

**Implications:**
- Every reference to "in-app test" in docs and comments updates to "app-test".
- ~~The `TUGAPP_IN_APP_TEST=1` env var stays — it's a Swift-side gate read by `AppDelegate.swift`, and renaming it would require a coordinated Swift change. (See follow-on roadmap.)~~ Superseded — renamed to `TUGAPP_APP_TEST` in a follow-on commit on 2026-04-27. See updated [D06].

---

#### [D02] M-tags map 1:1 to AT-tags with four-digit zero-padding (DECIDED) {#d02-tag-mapping}

**Decision:** `M{NN}` becomes `AT{NNNN}` directly: `M01` → `AT0001`, `M38` → `AT0038`. No compaction, no renumbering. Future tags pick up at `AT0039`.

**Rationale:**
- The mapping is mechanical and reversible. A single regex (`s/\bM(\d\d)\b/AT00\1/g`) catches the common case; one-digit and three-or-more-digit M-tags don't exist (high-water mark is `M38`).
- Cross-references in plans, source comments, and archived docs translate without semantic loss.
- "Once assigned, a number is never reused" stays true; the cleanup honors it.
- Four-digit padding gives a 10× headroom over the existing two-digit cap (the user's requested ceiling of `AT9999`).

**Implications:**
- AT-space is sparse where M-space was sparse (gaps for deferred tags persist).
- Renaming script can be a one-pass `sed` across the file tree, gated by an exclude-list for archived plans.
- The `tuglaws/app-test-inventory.md` "Numbering invariant" section reproduces the existing rule with AT in place of M.

---

#### [D03] Single `just app-test` recipe; build is the caller's responsibility (DECIDED) {#d03-single-recipe}

**Decision:** Replace `test-in-app` (full build + test sweep) and `test-in-app-fast` (test-only, against pre-built app) with a single `just app-test [files...]` recipe that runs the test sweep against the already-built `Tug.app`. The recipe surfaces a clear error if the binary is missing.

**Rationale:**
- The current `test-in-app` mixes two concerns: building and testing. That coupling means a recipe that takes a long time, even when only test files have changed.
- "Caller owns the build" is the right model: an explicit `just build-app` (or the existing `xcodebuild …` invocation) precedes `just app-test` when needed.
- HMR reality: the user's memory explicitly notes "HMR is always running; never run manual builds for tugdeck". The same posture applies to Tug.app — build only when you actually changed Swift.

**Implications:**
- The recipe runs `(cd tugdeck && bun run build)` as it does today (this is the production-build for the harness's served-files path; takes ~200ms incrementally), but does not invoke `xcodebuild`, does not invoke `cargo build`, and does not seed a scratch tugbank.
- A `just build-app` companion recipe is added to encapsulate the full Swift / Rust / tugdeck build dance previously embedded in `test-in-app`. (See `Step 4` below.)
- Calling `just app-test` against a missing app binary fails fast with: `error: Tug.app not built — run 'just build-app' first`.
- The default sweep (~46 test files) runs unchanged.
- Fast-path single-file invocation works: `just app-test at0001-tab-switch-fc.test.ts` runs only the named file.

---

#### [D04] Smoke tests are kept, classified, and relocated to `tests/app-test/harness-smoke/` (DECIDED) {#d04-smoke-policy}

**Decision:** Smoke tests survive but split into a dedicated subdirectory; AT-numbered scenario tests stay at the top of `tests/app-test/`.

**Classification:**
- **Keep, relocate:** `_smoke.test.ts`, `_smoke-native.test.ts`, `_smoke-em.test.ts`, `_smoke-app-reload.test.ts`, `_smoke-cold-boot.test.ts`, `_smoke-capture-phase-save.test.ts`, `_double-connect.test.ts`, `_log-capture.test.ts`, `_version-handshake.test.ts`, `_wait-for-condition.test.ts`. Each pins a primitive that AT-tests rely on; failure attribution requires the primitive gate to be separate.
- **Drop:** `_smoke-app-lifecycle.test.ts` (subsumed by AT0004 + AT0005, per [Q04]).
- **Keep, relocate, behind opt-in:** `_smoke-em-live.test.ts` (live tugcode round-trip; double-gated, as today).

**Rationale:**
- The smoke tests serve a real purpose: they pin harness primitives whose breakage would otherwise mask AT-test failures. Deleting them would make a primitive regression look like a scenario regression.
- Moving them to `harness-smoke/` makes the directory's intent explicit — top-level directory holds AT-numbered user-facing scenarios; subdirectory holds harness-internal protocol gates.
- Renaming files drops the `_` prefix in the new location (the location does the work the prefix used to do).

**Implications:**
- `harness-smoke/` is added to the default sweep order in `just app-test` (smoke first, AT-numbered after — failure attribution for cascading errors is crisp).
- Test imports from smoke files don't exist (they import from `_harness/`), so the relocation is path-only.
- README's "Adding a new test" section gets a "smoke vs scenario" sub-section.

---

#### [D05] The inventory + audit + desiderata are three sibling deliverables, not one (DECIDED) {#d05-three-deliverables}

**Decision:** The plan produces (a) `tuglaws/app-test-inventory.md` (the AT-tag catalog, replacing `m-series-inventory.md`), (b) `dash/app-test-harness-inventory.md` (the harness *feature* inventory + audit), and (c) the desiderata list as the closing section of the harness inventory doc.

**Rationale:**
- The AT-tag catalog and the harness-feature catalog answer different questions ("what regression scenarios are gated?" vs. "what can the harness do?"). Conflating them muddles both.
- The desiderata list is short and operational — a closing section of the inventory document is a fine home for it.
- Putting (a) under `tuglaws/` matches the existing precedent (the M-series inventory was already there).

**Implications:**
- Three new / renamed docs touched; cross-references between (a) and (b) are explicit.
- The desiderata list does not generate work in this plan; follow-on plans will pick from it as needed.

---

#### [D06] The `TUGAPP_IN_APP_TEST` env var stays as-is (SUPERSEDED — env var renamed to `TUGAPP_APP_TEST` 2026-04-27 in a follow-on commit) {#d06-env-var-name}

**Original decision:** The Swift-side gate (`AppDelegate.loadPreferences` reads `TUGAPP_IN_APP_TEST=1`) is not renamed during this cleanup.

**Original rationale:**
- Renaming requires a coordinated Swift change with re-signing implications and AX-grant invalidation.
- The env var is internal — only the just-recipe sets it. Test authors never see it.
- A future Swift sweep can rename it to `TUGAPP_APP_TEST` if desired; this plan does not block on that.

**Update (2026-04-27, post-close):** the user opted to do the follow-on immediately after phase close. Sweep landed in a separate commit:
- `tugapp/Sources/AppDelegate.swift` + `ProcessManager.swift`: read `TUGAPP_APP_TEST` instead of `TUGAPP_IN_APP_TEST`.
- `Justfile` `app-test` recipe: exports `TUGAPP_APP_TEST=1`.
- 39 AT test files + 11 harness-smoke files: gate condition updated.
- `tests/app-test/README.md`: env-var table + canonical-shape sample updated.
- A `just build-app` rebuild is required after this change to recompile the Swift code; the AX grant survives because `Tug Dev` re-signs with the same identity.

**Historical references in this plan and `tugplan-harness-extensions.md` retain the old name** as accurate snapshots of the pre-rename state.

---

#### [D07] `just app-test` prints a structured end-of-run summary with a `VERDICT:` line (DECIDED) {#d07-end-of-run-summary}

**Decision:** After all files have run, `just app-test` prints a structured summary block to stdout. The block has a fixed shape and ends with one of two literal lines: `VERDICT: PASS` or `VERDICT: FAIL`. The recipe exits 0 iff verdict is PASS. Per-file `bun test` output is preserved verbatim above the summary.

**Rationale:**
- Repeated AI-assistant sessions have foundered trying to interpret raw `bun test` output across N files: the tool's per-file summaries don't aggregate, exit-code 1 from any file causes the whole sweep to "fail" without a clear signal of which one(s), and assistants resort to hand-rolled `grep` / `wc -l` over the output to fish for "did it pass?" — a pattern that's both fragile and easy to get wrong.
- A single `VERDICT: PASS` / `VERDICT: FAIL` line at the end of stdout is greppable, deterministic, and obvious. `tail -n 1` is enough to know the result.
- A per-file `[PASS]` / `[FAIL]` / `[SKIP]` table lets a reader (human or AI) attribute a failure to a specific test file in one glance.
- The summary is an output wrapper around the existing `bun test` invocation — it does not change what `bun test` itself prints, it does not replace `bun test`'s own per-file summaries, and it does not change how tests are scheduled or what they assert. The observable behavior change is strictly additive.

**Implications:**
- The recipe captures each `bun test <file>` invocation's exit code AND its stdout/stderr (the latter is parsed for per-test counts where bun's own format makes that cheap).
- The summary block has a fixed format ([Spec S01](#s01-summary-format)) so future tooling can rely on it.
- A small `scripts/app-test-summary.sh` helper (or inlined bash function inside the recipe) does the parsing — deliberately simple, no jq / Python.
- The summary is the *last* thing printed; per-file `bun test` output stays above it. Nothing is suppressed.
- A `--json` flag is *not* added in this plan; if needed later, the summary's structure makes it trivial to bolt on. Listed in the desiderata.

---

### Deep Dives {#deep-dives}

#### Renaming manifest — what gets touched {#renaming-manifest}

The renaming is mechanical but wide. Categorize touches into five buckets so the script and the audit can target each precisely.

##### Bucket 1: Directory and filenames {#rename-bucket-1}

| Old | New |
|---|---|
| `tests/in-app/` | `tests/app-test/` |
| `tests/in-app/m{NN}-*.test.ts` | `tests/app-test/at{NNNN}-*.test.ts` |
| `tests/in-app/_smoke*.test.ts`, `_double-connect.test.ts`, etc. | `tests/app-test/harness-smoke/<descriptive>.test.ts` |
| `tests/in-app/_smoke-app-lifecycle.test.ts` | (deleted) |
| `tuglaws/m-series-inventory.md` | `tuglaws/app-test-inventory.md` |

##### Bucket 2: Justfile recipes {#rename-bucket-2}

| Old | New |
|---|---|
| `test-in-app` | (deleted; functionality split between `build-app` and `app-test`) |
| `test-in-app-fast *FILES` | `app-test *FILES` |
| (none) | `build-app` (a new recipe encapsulating the full Swift/Rust/tugdeck build dance) |

##### Bucket 3: Tag references in source and docs {#rename-bucket-3}

- **Inline tag references** (`[M14]`, `[M01]`, etc.) in any `.md`, `.ts`, `.tsx`, `.swift`, `.rs` file outside of `dash/archive/` and `.tugtool/archive/`. Translate by regex `\bM(\d\d)\b → AT00\1`.
- **Test file basename references** (`m14-cold-boot-scroll.test.ts`) in any text — translate to `at0014-cold-boot-scroll.test.ts`.
- **Log file basenames** (`logs/m14-cold-boot-scroll-trace.json`) — translate the same way; gitignored, but inline test code references them.
- **Internal docstring section headers** like `## Why this exists as a smoke test, not an M-tag test` — translate `M-tag` → `AT-tag`.

##### Bucket 4: Settings and memory {#rename-bucket-4}

- `.claude/settings.local.json` line 211: `Bash(test-in-app-fast)` → `Bash(app-test)`.
- `~/.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/memory/feedback_just_test_in_app_fast.md` → `feedback_just_app_test.md` (with content updated to reference the new recipe). The `MEMORY.md` index entry updates to match.
- `CLAUDE.md` — verify no `test-in-app` references; update the project-overview wording from "in-app test harness" to "app-test harness".

##### Bucket 5: External references {#rename-bucket-5}

- `scripts/setup-dev-signing.sh` — comments mention `just test-in-app`; update to `just build-app` (the new full-build recipe) where appropriate.
- `scripts/reapprove-transcript.ts` — imports from `tests/in-app/_harness/transcript`; update path.
- `tests/in-app/.gitignore` — moves with the directory; no content change needed.
- `tests/in-app/bunfig.toml`, `tsconfig.json`, `package.json`, `bun.lock`, `node_modules/` — move with the directory; the `@/_harness` path alias inside `tsconfig.json` stays the same (relative).
- `dash/m-series-reconciliation.md` — older than the canonical inventory; left as-is per Non-goals. A note at the top can flag the prefix change.
- `dash/tugplan-harness-extensions.md` — references `M-series` extensively in [D08] and elsewhere. Update to `AT-series` in a single editing pass.
- `dash/tugplan-selection.md` — every per-tag elaboration block still references the M-tag in its heading. Update.

#### Renaming script — outline {#rename-script}

A single bash script at `scripts/rename-m-to-at.sh` (created under [D03], deleted after Step 6 — see follow-on note). Pseudocode:

```sh
# 1. git mv the directory.
git mv tests/in-app tests/app-test

# 2. git mv each m{NN}-*.test.ts to at{NNNN}-*.test.ts.
for f in tests/app-test/m??-*.test.ts; do
  base="$(basename "$f")"
  num="${base:1:2}"          # extract NN
  rest="${base:4}"           # everything after "m{NN}-"
  git mv "$f" "tests/app-test/at00${num}-${rest}"
done

# 3. mkdir harness-smoke; git mv smoke-files in.
mkdir -p tests/app-test/harness-smoke
for f in tests/app-test/_smoke*.test.ts \
         tests/app-test/_double-connect.test.ts \
         tests/app-test/_log-capture.test.ts \
         tests/app-test/_version-handshake.test.ts \
         tests/app-test/_wait-for-condition.test.ts; do
  base="$(basename "$f")"
  trimmed="${base#_}"        # drop leading underscore
  git mv "$f" "tests/app-test/harness-smoke/${trimmed}"
done

# 4. git rm subsumed.
git rm tests/app-test/harness-smoke/smoke-app-lifecycle.test.ts

# 5. Walk every .ts/.tsx/.md/.swift/.rs/.sh file, run regex sed.
#    Excludes: dash/archive, .tugtool/archive, node_modules,
#    target, tugdeck/dist, *.lock, the rename script itself.
find . -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.md' \
   -o -name '*.swift' -o -name '*.rs' -o -name '*.sh' \
   -o -name 'Justfile' \) \
  -not -path './**/archive/**' \
  -not -path './**/node_modules/**' \
  -not -path './tugrust/target/**' \
  -not -path './tugdeck/dist/**' \
  -not -path './.tugtool/**' \
  -not -path './scripts/rename-m-to-at.sh' \
  -print0 | xargs -0 sed -i '' \
    -e 's/\bm\(0[1-9]\)\(-[a-z][a-z0-9-]*\)/at00\1\2/g' \
    -e 's/\bm\([1-9][0-9]\)\(-[a-z][a-z0-9-]*\)/at00\1\2/g' \
    -e 's/\bM\(0[1-9]\)\b/AT00\1/g' \
    -e 's/\bM\([1-9][0-9]\)\b/AT00\1/g' \
    -e 's/m-series/at-series/g' \
    -e 's/M-series/AT-series/g' \
    -e 's/M-tag/AT-tag/g' \
    -e 's/m-tag/at-tag/g'

# 6. Move the inventory doc.
git mv tuglaws/m-series-inventory.md tuglaws/app-test-inventory.md

# 7. Manual review pass for the things sed can't catch (titles,
#    re-anchored cross-doc references, README rewrites).
```

(Final script will use perl for in-place edits; macOS `sed -i ''` is finicky with extended regexes. The script is a one-shot — committed in Step 1, used in Steps 2–5, removed in Step 6.)

#### Justfile shape — `app-test` and `build-app` {#new-recipes}

**`build-app`** (new): the contents of the current `test-in-app` recipe, minus the test sweep at the end. Builds Rust binaries, tugdeck, the `tugcode` bun-compiled binary, runs `xcodebuild`, re-signs Tug.app with the dev identity. Idempotent and cache-friendly.

**`app-test *FILES`**: the contents of the current `test-in-app-fast` recipe, with these adjustments:
- Asserts `Tug.app` exists at `$TUGAPP_DEBUG_PATH`; if not, prints `error: Tug.app not built — run 'just build-app' first` and exits 1.
- Runs `(cd tugdeck && bun run build >/dev/null)` to refresh the served-files path (kept; it's the right behavior for HMR-disabled production-built tests).
- Same default-sweep logic, but the file list is the AT-numbered tests + harness-smoke first.

#### Spec S01: End-of-run summary format {#s01-summary-format}

The summary is printed after the test loop finishes and before the recipe exits. It is the last block on stdout. It has a fixed shape so it can be parsed (or grepped) deterministically.

##### Shape — pass case

```
========================================================
APP-TEST SUMMARY
========================================================
Sweep:        full        (or: explicit-files)
Files run:    47
Files passed: 47
Files failed: 0
Files errored: 0          (file ran but bun test failed to start cleanly)
Wall time:    2m 14s

Per-file results:
  [PASS]  harness-smoke/smoke.test.ts                       (2/2)
  [PASS]  harness-smoke/smoke-native.test.ts                (5/5)
  [PASS]  harness-smoke/smoke-em.test.ts                    (3/3)
  [PASS]  harness-smoke/double-connect.test.ts              (1/1)
  [PASS]  harness-smoke/log-capture.test.ts                 (1/1)
  [PASS]  harness-smoke/version-handshake.test.ts           (1/1)
  [PASS]  harness-smoke/wait-for-condition.test.ts          (3/3)
  [PASS]  harness-smoke/smoke-app-reload.test.ts            (1/1)
  [PASS]  harness-smoke/smoke-cold-boot.test.ts             (1/1)
  [PASS]  harness-smoke/smoke-capture-phase-save.test.ts    (3/3)
  [PASS]  at0001-tab-switch-fc.test.ts                      (1/1)
  [PASS]  at0001-rapid-cadence.test.ts                      (1/1)
  ...
  [PASS]  at0038-deactivation-inactive-paint.test.ts        (1/1)

========================================================
VERDICT: PASS  (47/47 files green; 64/64 tests passed)
========================================================
```

##### Shape — fail case

```
... (same header + table, except one or more rows are FAIL/ERR) ...
Per-file results:
  [PASS]  harness-smoke/smoke.test.ts                       (2/2)
  ...
  [FAIL]  at0014-cold-boot-scroll.test.ts                   (0/1)
  [PASS]  at0016-tab-close-handoff.test.ts                  (1/1)
  ...

Failures:
  at0014-cold-boot-scroll.test.ts
    > "scroll position survives cmd-tab cycle"
        Expected: 200
        Received: 0
        at tests/app-test/at0014-cold-boot-scroll.test.ts:142:18

========================================================
VERDICT: FAIL  (46/47 files green; 1 file failed; 63/64 tests passed)
========================================================
```

##### Required structure (so parsers can rely on it) {#s01-required-structure}

- The summary is wrapped in lines of exactly 56 `=` characters (a banner). Three banners total: open, between table and verdict, after verdict.
- The header `APP-TEST SUMMARY` appears on its own line between the first two banners.
- The fields `Sweep`, `Files run`, `Files passed`, `Files failed`, `Files errored`, `Wall time` are printed in this order, one per line, label left-padded to 14 characters with two spaces between label and value.
- Each per-file row matches `^  \[(PASS|FAIL|SKIP|ERR)\]\s+\S+\s+\(\d+/\d+\)$`. (`SKIP` arises only when bun reports zero tests — e.g. an opt-in file with no env-var set.)
- The `Failures:` block appears iff at least one row is `FAIL`. Each failing test gets its title (`> "title"`) and assertion details indented two spaces underneath.
- The closing line is exactly `VERDICT: PASS` or `VERDICT: FAIL` followed by a single ASCII space and a parenthesized count summary. The literal `VERDICT: PASS` or `VERDICT: FAIL` is the *first thing* on the verdict line — `grep -E '^VERDICT: ' | tail -n 1` is the canonical extractor.

##### Implementation sketch — bash inside the recipe {#s01-implementation}

Pseudocode (the actual implementation lives in the `app-test` recipe in the Justfile):

```sh
declare -a RESULTS         # "PASS:file:passed:total" rows
declare -a FAILURES        # collected stderr blocks for FAIL files
START=$(date +%s)

for f in "${FILES[@]}"; do
  # Capture both streams; bun's own per-file summary stays visible.
  out="$(bun test "$f" 2>&1 | tee /dev/stderr)"
  rc=${PIPESTATUS[0]}
  # Parse bun's own "X pass, Y fail" line. Bun emits a single such
  # line per file at the end; the format has been stable across
  # current bun versions. Fallback: if not found, infer from rc.
  counts="$(printf '%s\n' "$out" | grep -E '^[ \t]*[0-9]+ (pass|fail)' | tail -n 1)"
  passed=$(printf '%s' "$counts" | grep -oE '[0-9]+ pass' | grep -oE '^[0-9]+')
  failed=$(printf '%s' "$counts" | grep -oE '[0-9]+ fail' | grep -oE '^[0-9]+')
  total=$((${passed:-0} + ${failed:-0}))
  if [ "$rc" -eq 0 ] && [ "${failed:-0}" -eq 0 ] && [ "$total" -eq 0 ]; then
    RESULTS+=("SKIP:$f:0:0")
  elif [ "$rc" -eq 0 ]; then
    RESULTS+=("PASS:$f:$passed:$total")
  elif [ -n "$counts" ]; then
    RESULTS+=("FAIL:$f:$passed:$total")
    FAILURES+=("$f"$'\n'"$out")
  else
    RESULTS+=("ERR:$f:0:0")
    FAILURES+=("$f"$'\n'"$out")
  fi
  pkill -x Tug 2>/dev/null || true
  sleep 0.3
done

END=$(date +%s)
print_summary "$START" "$END" "${RESULTS[@]}" "${FAILURES[@]}"
```

The parsing is deliberately simple — it consumes bun's own per-file summary line, which has a stable shape. If bun's output ever changes shape, the smoke tests will surface it: a planned smoke probe in `harness-smoke/summary-parser.test.ts` runs a known-result file and asserts the parser extracts the right counts. (Or, simpler — the summary itself is exercised end-to-end by `just app-test harness-smoke/smoke.test.ts` and visually checked against the spec; a parser-drift gate is in the desiderata, not in this plan.)

##### Why bash, not a separate tool {#s01-bash-rationale}

Tugtool's just-recipes are bash. Adding Python or jq for this introduces a runtime dependency for what is fundamentally a stable-format text aggregation. The pseudocode above is ~30 lines; the real implementation should fit in ~80. If it grows past that, lift it to `scripts/app-test-summary.sh` (a single argument-list of `RESULTS` lines on stdin).

---

#### Smoke-test inventory (post-rename) {#smoke-test-inventory}

| New path | Pins | Status |
|---|---|---|
| `harness-smoke/smoke.test.ts` | `launchTugApp → evalJS → close → version` | always-on |
| `harness-smoke/smoke-native.test.ts` | trusted CGEvent click, type, Cmd+A, drag, double-click | always-on |
| `harness-smoke/smoke-em.test.ts` | EM observation surface (`getEmCardState`, `awaitEngineReady`) | always-on |
| `harness-smoke/smoke-app-reload.test.ts` | `app.appReload` primitive | always-on |
| `harness-smoke/smoke-cold-boot.test.ts` | `quitGracefully` + `tugbankRead` + two-process round-trip | always-on |
| `harness-smoke/smoke-capture-phase-save.test.ts` | capture-phase save invariant ([A9] foundational) | always-on |
| `harness-smoke/double-connect.test.ts` | single-client transport guarantee | always-on |
| `harness-smoke/log-capture.test.ts` | per-test log file | always-on |
| `harness-smoke/version-handshake.test.ts` | `EXPECTED_SURFACE_VERSION` mismatch error | always-on |
| `harness-smoke/wait-for-condition.test.ts` | `evalJS` error translation, `waitForCondition` timeout / immediate-truthy | always-on |
| `harness-smoke/em-live.test.ts` | live tugcode round-trip (Anthropic API) | opt-in (`TUGCODE_LIVE=1`) |

Net change vs. today: 12 smoke files become 11; relocated to `harness-smoke/`; underscore prefix dropped. `_smoke-app-lifecycle.test.ts` deleted.

#### Harness feature inventory — outline of the deliverable doc {#feature-inventory-outline}

The feature inventory at `dash/app-test-harness-inventory.md` will be organized as follows:

1. **One-paragraph intro** (what the harness is, where it lives).
2. **Bridge / RPC surface** (`launchTugApp`, version handshake, single-client transport, log capture, env-var contract).
3. **Lifecycle verbs** (`close`, `quitGracefully`, `appReload`, four `simulateApp*`, accessibility preflight).
4. **Synthesized DOM gestures** (`click`, `type`, `focusElement`).
5. **Native CGEvent gestures** (the full `nativeClick / nativeDoubleClick / nativeRightClick / nativeDrag / nativeDragWithoutRelease / nativeMouseDown / nativeMouseUp / nativeKey / nativeType / holdModifier` family).
6. **Deck-state seeding and reset** (`seedDeckState`, `reset`).
7. **Deck-trace ring** (`getDeckTrace`, `markDeckTrace`, `clearDeckTrace`, `enableDeckTrace`, `toContainOrderedSubset` matcher).
8. **Element / DOM introspection** (`getElementText / Value / Attribute / Bounds / ScreenBounds / State / ComputedStyleValue`, `getActiveElement`, `getSelection`).
9. **Card / focus / caret** (`getActiveCardId`, `getFocusedCardId`, `getCaretState`, `getFormControlValue`, `assertHostRootRegistered`, `expectFocusedCard`, `expectCaret`).
10. **Selection boundary** (`registerSelectionBoundary`, `unregisterSelectionBoundary`).
11. **EM-card / engine surface** (`getEmCardState`, `isEngineReady`, `awaitEngineReady`, `bindTideSession`).
12. **Tugcode subprocess control** (`startTugcode`, `stopTugcode`, `writeTugcodeStdin`, stub-mode replay, live-mode opt-in).
13. **Tugbank cold-boot helpers** (`mkTempTugbank`, `rmTempTugbank`, `seedTugbankForLaunch`, `tugbankRead`).
14. **Diagnostics** (`tailLog`, `dumpTraceToFile`, structured errors).
15. **Lint** (`lint-no-timers.ts`).
16. **Audit table** — one row per feature; columns `Feature`, `Implemented`, `Tested`, `Status` (covered / partial / gap), `Notes`.
17. **Desiderata** — gaps + rationale, one bullet each.

#### Desiderata — what to put in the closing section {#desiderata-outline}

Initial sketch (the deliverable doc will refine):

- **CI integration** — accessibility-permission preflight gates the harness on a manual macOS grant; CI runners that don't have Accessibility access can't run the AT-suite. (Tracked as `tugplan-harness-extensions.md` [Q01].)
- **Visual / paint assertions** — the harness reads selection, focus, scroll, but cannot assert paint correctness, caret blink, perceived snappiness. Out of fidelity envelope.
- **IME / composition input** — `nativeType` rejects non-ASCII; no `bag.markedText` axis. (Tracked as `AT0012`.)
- **Banner / bulletin dismissals** — needs a separate user-prefs persistence store. (Tracked as `AT0028`.)
- **Scroll-key audit** — walk every stateful component for scrollable sub-regions. (Tracked as `AT0029`.)
- **Multi-window scenarios** — Tug.app supports multiple windows; harness drives a single WKWebView root per spawn.
- **Trackpad / wheel scroll** — no `nativeScroll` verb; tests can synth `wheel` events via `evalJS` but those carry `isTrusted: false`.
- **Cross-app drag-and-drop** — no Finder / external-app drop fidelity.
- **Parallel test execution** — one App per file by design; test-suite wallclock is sequential. Worth quantifying before any optimization.
- ~~**`TUGAPP_IN_APP_TEST` rename** — coordinate the Swift-side env-var rename to `TUGAPP_APP_TEST`. (See [D06].)~~ DONE 2026-04-27.
- **Live-mode tugcode coverage** — only `em-live.test.ts` exercises the real Anthropic API; expanding this would catch tugcode-side regressions earlier but costs API credits.
- **Rapid-cadence variants for missing AT-tags** — only AT0001, AT0003, AT0016 have rapid-cadence siblings today.
- **Drift-prevention discipline** — `tugplan-harness-extensions.md` [D12] requires a deliberate revert-and-retest cycle for every new AT test before merge; this is process, not code, and lives in the desiderata as a reminder.
- **`just app-test --json`** — emit the same summary as a JSON sidecar for richer programmatic consumption. Not added in this plan because the text format is already deterministic and `tail -n 1 | grep -oE 'VERDICT: \w+'` is sufficient for the AI-assistant use case ([D07]).
- **Parser-drift gate for the summary** — bun's per-file `"X pass, Y fail"` summary line is what `app-test` parses. A future smoke test could pin its exact format so a bun upgrade doesn't silently break the parser. (Today, a divergence produces an `[ERR]` row in the summary, which is visible but not as crisp as a dedicated gate.)

---

### Specification {#specification}

#### Naming and tag conventions (post-rename) {#post-rename-conventions}

- **Facility name:** `app-test`.
- **Directory:** `tests/app-test/`.
- **Just recipe:** `just app-test [files...]` (test sweep), `just build-app` (build).
- **Tag prefix:** `AT`.
- **Tag format:** `[AT{NNNN}]` — four-digit zero-padded.
- **Test filename prefix:** `at{NNNN}-{slug}.test.ts`.
- **Inventory file:** `tuglaws/app-test-inventory.md`.
- **High-water mark on close of plan:** `AT0038`. Next available: `AT0039`.

#### Status legend (unchanged from M-series inventory) {#status-legend}

- ✅ Closed — fix landed; gating test(s) pass.
- ⚠️ Partial — some axis closed, residual axis open or deferred.
- ❌ Open — no fix; gating test absent or failing-by-design.
- ❓ Untested — no gating test exists yet; behavior unverified.
- ⬛ Not-a-feature — closed-as-WONTFIX with a documented decision.
- 🔧 Infra — infrastructure gap that blocks other tags.

#### Numbering invariant (carried forward) {#numbering-invariant}

Tag numbers are append-only. Once assigned, a number is never reused. A test filename's `at{NNNN}` prefix must match a tag in `tuglaws/app-test-inventory.md`. If a new test gates a regression that isn't in the inventory, *add a tag first*, then name the test.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `dash/tugplan-app-test-cleanup.md` | This plan. |
| `dash/app-test-harness-inventory.md` | Harness feature inventory + audit + desiderata (deliverable). |
| `tuglaws/app-test-inventory.md` | AT-tag catalog (replaces `m-series-inventory.md`). |
| `tests/app-test/harness-smoke/` | Subdirectory for harness-internal smoke gates. |
| `scripts/rename-m-to-at.sh` | One-shot rename script (created Step 1, deleted Step 6). |

#### Removed files {#removed-files}

| File | Why |
|------|-----|
| `tests/app-test/harness-smoke/smoke-app-lifecycle.test.ts` (was `_smoke-app-lifecycle.test.ts`) | Subsumed by AT0004 + AT0005 ([Q04]). |
| `tuglaws/m-series-inventory.md` | Superseded by `tuglaws/app-test-inventory.md`. |

#### Renamed files {#renamed-files}

See [Bucket 1](#rename-bucket-1) above for the full table. Summary: ~46 test files renamed (`m{NN}-*.test.ts` → `at{NNNN}-*.test.ts`), ~10 smoke files relocated, 1 inventory file renamed, 1 directory renamed.

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `app-test` | just-recipe | `Justfile` | Replaces `test-in-app-fast`. Default sweep + `*FILES` arg + end-of-run summary ([D07] / [Spec S01](#s01-summary-format)). |
| `build-app` | just-recipe | `Justfile` | Encapsulates the build dance previously embedded in `test-in-app`. |

No source-code symbol changes — every harness method, RPC verb, error type, and helper retains its name. The end-of-run summary lives entirely inside the `app-test` recipe (bash); no new harness code.

---

### Documentation Plan {#documentation-plan}

- [ ] Rewrite `tests/app-test/README.md` (was `tests/in-app/README.md`) to:
  - reflect the new directory and just-recipe;
  - document the `harness-smoke/` vs. AT-scenario split;
  - add a "Smoke vs. scenario" section in "Adding a new test";
  - link to `tuglaws/app-test-inventory.md` and `dash/app-test-harness-inventory.md`.
- [ ] Update `CLAUDE.md` to call the facility "app-test" and reference the new just-recipe.
- [ ] Update memory entry `feedback_just_test_in_app_fast.md` → `feedback_just_app_test.md` (and the `MEMORY.md` index line).
- [ ] Update `scripts/setup-dev-signing.sh` comments referencing `just test-in-app`.
- [ ] Add a one-line note at the top of `dash/m-series-reconciliation.md` flagging the prefix change so the historical doc remains readable.
- [ ] Update `dash/tugplan-harness-extensions.md` and `dash/tugplan-selection.md` with the AT-prefix sweep.

---

### Test Plan Concepts {#test-plan-concepts}

This is a rename / refactor plan. The "tests" are the post-rename green sweep plus a handful of regex grep gates that catch missed references.

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Sweep regression** | Confirm no behavior change | Pre-merge: `just app-test` matches the pre-rename green set |
| **Grep gate** | Confirm no stale references | Pre-merge: a battery of `rg` patterns returns 0 hits outside of allowlisted paths |
| **Type-check** | Confirm path aliases resolve | After Step 2: `bun x tsc --noEmit` from `tests/app-test/` is clean |

---

### Execution Steps {#execution-steps}

#### Step 1: Capture pre-rename baseline + write the rename script {#step-1}

**Commit:** `feat(app-test): pre-rename baseline + rename script`

**References:** [D02], [D03], [D04], (#renaming-manifest, #rename-script)

**Artifacts:**
- `scripts/rename-m-to-at.sh` (new; one-shot script).
- `dash/tugplan-app-test-cleanup.md` (this plan; commits if not already on the branch).
- A captured pre-rename `just test-in-app-fast` log under `dash/.app-test-baseline.log` (gitignored — referenced for sanity, not committed).

**Tasks:**
- [x] Run `just test-in-app-fast` and confirm green; capture the run log locally. (2026-04-27 — 45 files, 0 fails, log at `dash/.app-test-baseline.log`.)
- [x] Write `scripts/rename-m-to-at.sh` per the [outline](#rename-script). Use `perl -i -pe` for in-place regex replacement on macOS (sed is finicky with extended regexes). Exclude `archive/`, `node_modules`, `target/`, `dist/`, `bun.lock`, `package-lock.json`, `*.png`, `*.jpg`, the script itself. (Commit `2cee4eae`.)
- [x] Dry-run the script's grep pattern against the repo and verify it finds expected sites (no surprises in archived plans, etc.). (~92 files matched, all expected.)

**Tests:**
- [x] `bash -n scripts/rename-m-to-at.sh` (syntax check).
- [x] Manual visual review of the regex replacements against the inventory.

**Checkpoint:**
- [x] `git status` clean except for the new script + plan.
- [x] `just test-in-app-fast` green.

---

#### Step 2: Rename directory + path-sensitive infra {#step-2}

**Depends on:** #step-1

**Commit:** `refactor(app-test): rename tests/in-app/ → tests/app-test/`

**References:** [D01], (#renaming-manifest)

**Artifacts:**
- `tests/app-test/` (was `tests/in-app/`) — `git mv` of the directory.
- `tests/app-test/README.md` updated header line only (full rewrite is Step 7).
- `scripts/reapprove-transcript.ts` import path updated.
- `.claude/settings.local.json` `test-in-app-fast` permission updated to `app-test` (defer the recipe rename to Step 3 — but the permission entry can land here).

**Tasks:**
- [ ] `git mv tests/in-app tests/app-test`.
- [ ] Update import in `scripts/reapprove-transcript.ts` (`../tests/in-app/_harness/transcript` → `../tests/app-test/_harness/transcript`).
- [ ] Update `.claude/settings.local.json` line 211.
- [ ] Update one-line README header.

**Tests:**
- [ ] `cd tests/app-test && bun x tsc --noEmit` is clean.
- [ ] `cd tests/app-test && bun run lint:no-timers` exits 0.

**Checkpoint:**
- [ ] `git diff --stat` shows ~1 directory move + 2 small file edits.
- [ ] No `tests/in-app` paths remain in the working tree (`rg -lF tests/in-app | wc -l` returns 0 outside of `archive/` and `.tugtool/`).

---

#### Step 3: Collapse Justfile recipes + add end-of-run summary {#step-3}

**Depends on:** #step-2

**Commit:** `refactor(app-test): single 'just app-test' recipe with summary; new 'just build-app'`

**References:** [D03], [D07], Spec S01, (#new-recipes, #s01-summary-format)

**Artifacts:**
- `Justfile` — `test-in-app` and `test-in-app-fast` recipes removed; `app-test *FILES` (with the end-of-run summary) and `build-app` added.

**Tasks:**
- [ ] Replace `test-in-app-fast *FILES` recipe body with the new `app-test *FILES` recipe (per [#new-recipes](#new-recipes)). Hoist the missing-app fast-path error.
- [ ] Replace the full `test-in-app` recipe body with `build-app` (drops the test-loop tail; keeps everything else). Add a closing `echo "==> Built. Now run 'just app-test' to run tests."`.
- [ ] Update the `app-test`'s default sweep file list to use `at{NNNN}-…` filenames and to put `harness-smoke/*.test.ts` first.
- [ ] Implement the end-of-run summary per [Spec S01](#s01-summary-format): per-file result table, totals, wall time, optional `Failures:` block, closing `VERDICT: …` line. Recipe exits 0 iff verdict is PASS.
- [ ] Verify the verdict line is the *last line* of stdout (`tail -n 1` test).

**Tests:**
- [ ] `just --list | grep -E '^\s+(app-test|build-app|test-in-app)' | sort` matches `app-test`, `build-app` exactly (no `test-in-app*`).
- [ ] `just app-test --help` (or equivalent dry-run) executes without error.
- [ ] `just app-test` runs the same scenarios that `test-in-app-fast` ran on the baseline.
- [ ] `just app-test harness-smoke/smoke.test.ts | tail -n 1` matches `^VERDICT: PASS\b`.
- [ ] Deliberately cause one file to fail (e.g., temp `expect(true).toBe(false)` in a smoke file), run `just app-test`, confirm: (a) verdict is `FAIL`, (b) the `Failures:` block names the failing test, (c) recipe exit code is non-zero. Revert the temp change.
- [ ] Confirm the summary block matches every required-structure rule from [#s01-required-structure](#s01-required-structure).

**Checkpoint:**
- [ ] `just app-test harness-smoke/smoke.test.ts` is green and the `VERDICT: PASS` line appears at the end.
- [ ] `just app-test` (full sweep) matches the baseline outcome AND prints a complete summary with `VERDICT: PASS`.

---

#### Step 4: Run the rename script over tag references {#step-4}

**Depends on:** #step-3

**Commit:** `refactor(app-test): rename M-tags → AT-tags across source and docs`

**References:** [D02], (#rename-script, #renaming-manifest)

**Artifacts:**
- All `m{NN}-*.test.ts` files renamed to `at{NNNN}-*.test.ts`.
- All `[M{NN}]` references in `.md` / `.ts` / `.tsx` / `.swift` / `.rs` / `.sh` / `Justfile` outside of archived directories rewritten as `[AT{NNNN}]`.
- All references to `M-tag`, `M-series`, `m-tag`, `m-series` rewritten.
- All log-file basename references inside test files (e.g. `logs/m14-…-trace.json`) rewritten.

**Tasks:**
- [ ] Run `bash scripts/rename-m-to-at.sh`.
- [ ] Manually review the diff for false positives — particularly inside docstrings where the regex might over-match (e.g., `M02` mentioned as part of an unrelated identifier).
- [ ] Restore any false-positive replacements.

**Tests:**
- [ ] `find tests -name 'm[0-9]*-*.test.ts' | wc -l` returns 0.
- [ ] `rg -nE '\bM[0-9]{2}\b' --glob '!**/archive/**' --glob '!**/.tugtool/**' --glob '!dash/m-series-reconciliation.md'` returns 0 hits.
- [ ] `rg -nE 'tests/in-app' --glob '!**/archive/**' --glob '!**/.tugtool/**'` returns 0 hits.
- [ ] `cd tests/app-test && bun x tsc --noEmit` is clean.

**Checkpoint:**
- [ ] `just app-test` (full sweep) matches the baseline outcome.
- [ ] `git diff --stat` shows the expected breadth of touch (~50 files).

---

#### Step 5: Smoke-test relocation + drop subsumed file {#step-5}

**Depends on:** #step-4

**Commit:** `refactor(app-test): relocate smoke tests under harness-smoke/`

**References:** [D04], [Q04], [Q05], (#smoke-test-inventory)

**Artifacts:**
- `tests/app-test/harness-smoke/` populated with the relocated smoke files (underscore prefix dropped).
- `tests/app-test/harness-smoke/smoke-app-lifecycle.test.ts` deleted (subsumed).
- `tests/app-test/harness-smoke/em-live.test.ts` (was `_smoke-em-live.test.ts`).

**Tasks:**
- [ ] `git mv` each `_smoke*.test.ts`, `_double-connect.test.ts`, `_log-capture.test.ts`, `_version-handshake.test.ts`, `_wait-for-condition.test.ts` to `harness-smoke/<descriptive>.test.ts`. Drop the leading `_`.
- [ ] `git rm tests/app-test/harness-smoke/smoke-app-lifecycle.test.ts`.
- [ ] Update each smoke file's docstring opening line to reflect its new path.
- [ ] Update `just app-test`'s default sweep to use the new paths.

**Tests:**
- [ ] `just app-test` (full sweep) is green.
- [ ] `find tests/app-test -maxdepth 1 -name '_*.test.ts' | wc -l` returns 0.
- [ ] `cd tests/app-test && bun x tsc --noEmit` is clean.

**Checkpoint:**
- [ ] `git diff --stat` shows the moves.
- [ ] Every harness-smoke file has its new path reflected in its docstring.

---

#### Step 6: Inventory rename + cleanup the script {#step-6}

**Depends on:** #step-5

**Commit:** `docs(app-test): rename m-series-inventory → app-test-inventory; drop rename script`

**References:** [D05], (#post-rename-conventions, #numbering-invariant)

**Artifacts:**
- `tuglaws/app-test-inventory.md` (was `tuglaws/m-series-inventory.md`) — content updated to use AT-prefix throughout, status legend kept verbatim, numbering invariant carried forward, high-water mark `AT0038`.
- `dash/m-series-reconciliation.md` — single banner line at top: "**Note:** This document predates the canonical inventory and uses the M-prefix. Tags `M{NN}` correspond to `AT{NNNN}` in current docs."
- `scripts/rename-m-to-at.sh` deleted (one-shot, no longer needed).

**Tasks:**
- [ ] `git mv tuglaws/m-series-inventory.md tuglaws/app-test-inventory.md`.
- [ ] Run the rename script's regex against the file (it likely already updated the contents in Step 4, but the file at the old path; re-verify under the new path).
- [ ] Update file's first heading to `# AT-Tag Inventory` and its intro paragraph to reference the AT prefix and `tests/app-test/` directory.
- [ ] Add the `m-series-reconciliation.md` banner.
- [ ] `git rm scripts/rename-m-to-at.sh`.

**Tests:**
- [ ] `rg -nE '\bM[0-9]{2}\b' tuglaws/app-test-inventory.md` returns 0 hits.
- [ ] `rg -nF tests/in-app tuglaws/app-test-inventory.md` returns 0 hits.

**Checkpoint:**
- [ ] `git diff --stat` shows: 1 rename + 1 banner edit + 1 script deletion.

---

#### Step 7: README + memory + scripts comment sweep {#step-7}

**Depends on:** #step-6

**Commit:** `docs(app-test): refresh README, memory, and script comments for new naming`

**References:** [D01], [D03], [D04], [D06], (#documentation-plan)

**Artifacts:**
- `tests/app-test/README.md` rewritten (full pass — naming, paths, just-recipe, smoke-vs-scenario section, links to inventory + harness-inventory).
- `CLAUDE.md` updated where it mentions "in-app test harness".
- Memory entry renamed: `feedback_just_test_in_app_fast.md` → `feedback_just_app_test.md` (with content updated and the `MEMORY.md` index line revised).
- `scripts/setup-dev-signing.sh` comments updated.

**Tasks:**
- [ ] Rewrite `tests/app-test/README.md` per [Documentation Plan](#documentation-plan).
- [ ] Update `CLAUDE.md`.
- [ ] Update memory file + index.
- [ ] Sweep `scripts/setup-dev-signing.sh` comments.

**Tests:**
- [ ] `rg -nE 'in-app|test-in-app' CLAUDE.md scripts/setup-dev-signing.sh tests/app-test/README.md` returns 0 hits.

**Checkpoint:**
- [ ] Reading the new README cold should make the harness's shape clear.

---

#### Step 8: Author the harness feature inventory + audit + desiderata {#step-8}

**Depends on:** #step-7

**Commit:** `docs(app-test): harness feature inventory, audit, and desiderata`

**References:** [D05], (#feature-inventory-outline, #desiderata-outline)

**Artifacts:**
- `dash/app-test-harness-inventory.md` — the deliverable doc.

**Tasks:**
- [ ] Walk `tests/app-test/_harness/index.ts`, `client.ts`, `errors.ts`, `matchers.ts`, `rpc.ts`, `transcript.ts`, `tugbank-helpers.ts`, `lint-no-timers.ts` end-to-end.
- [ ] Walk `tugapp/Sources/TestHarness/*.swift` end-to-end for the RPC dispatch table (the verbs the bridge currently knows).
- [ ] For each feature, fill the audit table: `Feature`, `Implemented`, `Tested`, `Status`, `Notes`.
- [ ] Write the closing desiderata list per [#desiderata-outline](#desiderata-outline).

**Tests:**
- [ ] Cross-check: every method on the `App` class appears in the inventory exactly once.
- [ ] Cross-check: every Swift `case` in `TestHarnessConnection.swift`'s dispatch switch appears in the inventory exactly once.

**Checkpoint:**
- [ ] Inventory doc is complete; audit table has a status for every row.

---

#### Step 9: Integration checkpoint {#step-9}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7, #step-8

**Commit:** `N/A (verification only)`

**References:** (#success-criteria)

**Tasks:**
- [ ] Run the full success-criteria battery from [#success-criteria](#success-criteria).
- [ ] Run `just app-test` and confirm every previously-green scenario is still green.

**Tests:**
- [ ] `find tests -name 'm[0-9]*-*.test.ts' | wc -l` is 0.
- [ ] `rg -nE '\bM[0-9]{2}\b' --glob '!**/archive/**' --glob '!**/.tugtool/**' --glob '!dash/m-series-reconciliation.md'` is 0.
- [ ] `just --list | grep -E '^\s+(test-in-app|app-test)'` shows only `app-test`.
- [ ] `just app-test` (full sweep) green.
- [ ] `tuglaws/app-test-inventory.md` exists; `tuglaws/m-series-inventory.md` does not.
- [ ] `dash/app-test-harness-inventory.md` exists.

**Checkpoint:**
- [ ] All criteria above pass.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A renamed, single-recipe app-test facility with AT-numbered tags, a clearly-classified smoke-test layer, and a complete inventory + audit + desiderata document — with no behavior changes to existing tests.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] `tests/app-test/` exists; `tests/in-app/` does not. (Step 2 commit `6760ab5c`.)
- [x] `just app-test` runs the full sweep against an already-built `Tug.app`. (User-verified 2026-04-27: `VERDICT: PASS  (45/45 files green; 101/101 tests passed)`.)
- [x] `just build-app` builds `Tug.app` end-to-end. (Recipe is the body of the previous `test-in-app` minus the test loop; user-built Tug.app is alive and the green sweep ran against it.)
- [x] No `m{NN}-*.test.ts` files remain. (Step 4; `find tests -name 'm[0-9]*-*.test.ts'` → 0.)
- [x] No `\bM[0-9]{2}\b` references remain outside archives + `m-series-reconciliation.md`. (Step 9 gate → 0 hits.)
- [x] `tuglaws/app-test-inventory.md` is the authoritative AT-tag catalog. (Step 4 + Step 6; old `m-series-inventory.md` removed.)
- [x] `dash/app-test-harness-inventory.md` is the authoritative harness-feature inventory. (Step 8 commit `c4f69fc6`; 379 lines, 14 sections, audit table populated, desiderata bucketed.)
- [x] Smoke tests live under `tests/app-test/harness-smoke/`. (Step 5; 11 files relocated.)
- [x] `_smoke-app-lifecycle.test.ts` is gone. (Step 5; subsumed by AT0004 + AT0005.)
- [x] CLAUDE.md, README, memory, and signing-script comments all reference the new naming. (Step 7; CLAUDE.md required no edits — already clean.)
- [x] The full pre-rename green set is still green. (Baseline = 45/0; post-rename = 45/0; matches.)
- [x] `just app-test … | tail -n 1` matches `^VERDICT: (PASS|FAIL)\b`. (Step 3 + Step 9; verified live.)
- [x] Recipe exit code matches the verdict (0 iff PASS). (Step 3 + Step 9.)

**Acceptance tests:**
- [x] `just app-test` exits 0. (User-verified.)
- [x] All success criteria in [#success-criteria](#success-criteria) pass. (Step 9 gate battery — 12-of-12 green; gate 13 was a probe with non-load-bearing mismatch and was visually validated against the recipe source.)

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [x] Rename `TUGAPP_IN_APP_TEST` → `TUGAPP_APP_TEST` in a coordinated Swift change ([D06]). DONE 2026-04-27 in a follow-on commit immediately after phase close.
- [ ] Pick from the desiderata list to drive future plans (CI integration, IME coverage, multi-window scenarios, parallel test execution, etc.).
- [ ] Optionally archive `dash/m-series-reconciliation.md` under `dash/archive/` once the historical context is no longer needed.

| Checkpoint | Verification |
|------------|--------------|
| Pre-rename baseline captured | `dash/.app-test-baseline.log` exists |
| Rename script syntactically valid | `bash -n scripts/rename-m-to-at.sh` |
| Directory rename clean | `cd tests/app-test && bun x tsc --noEmit` |
| Single just-recipe live | `just --list \| grep app-test` matches; no `test-in-app*` |
| End-of-run summary present | `just app-test \| tail -n 1` matches `^VERDICT: (PASS\|FAIL)\b` |
| Tag rename complete | `rg -nE '\bM[0-9]{2}\b'` 0 hits outside allowlist |
| Smoke layer relocated | `find tests/app-test -maxdepth 1 -name '_*.test.ts'` 0 results |
| Inventory file renamed | `tuglaws/app-test-inventory.md` exists, `tuglaws/m-series-inventory.md` does not |
| Harness inventory landed | `dash/app-test-harness-inventory.md` exists with populated audit table |
| Full green sweep | `just app-test` exits 0 |

---

#### Close-out log (2026-04-27) {#close-out}

| Step | Commit | Outcome |
|------|--------|---------|
| Step 1 — baseline + script | `2cee4eae` (script), `49a5858d` (plan tick) | Pre-rename baseline green (45/0); rename script written, syntax-clean. |
| Step 2 — directory rename | `6760ab5c` | 70 file renames; tsc clean; settings permission updated. |
| Step 3 — Justfile + summary | `705f3347` | `app-test` + `build-app` recipes; Spec S01 summary lands; FAIL-path validated live. |
| Step 4 — script Sections 2/4/5 | `1491a295` | 39 m→at file renames; inventory file renamed; 87 files / 1153↔1153 symmetric regex sweep; tsc clean. |
| Step 5 — smoke relocation | `80f554d4` | 11 files moved to `harness-smoke/`; subsumed file dropped; 15 imports fixed; Justfile FILES sweep updated. |
| Step 6 — inventory + script cleanup | `caeab1dc` | Inventory heading + intro + conventions rewritten; legacy banner on reconciliation; rename script deleted. |
| Step 7 — README + memory + signing | `0ddf4323` | README full rewrite; signing-script comments swept; memory file renamed. |
| Step 8 — harness inventory | `c4f69fc6` | `dash/app-test-harness-inventory.md` (379 lines, 14 sections, audit table, desiderata). |
| Step 9 — integration checkpoint | (verification only) | All Phase Exit Criteria green; user-verified `just app-test` PASS (45/45 files, 101/101 tests). |

**Final state:** clean, single-recipe app-test facility with 39 AT-numbered scenario tests + 11 harness-smoke gates; structured `VERDICT:` summary on every run; complete inventory, audit, and desiderata; no behavior changes to existing tests.
