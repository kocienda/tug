<!-- brief-skeleton v1 -->

# Split `tugarc-core`'s `ops.rs` along its seams and give the arc engine a typed error

**Purpose:** `tugrust/crates/tugarc-core/src/ops.rs` is 15.7k lines, 6.4k of them production, holding git helpers, document paths, arc identity, every verb, the step ledger, join, and discard in one module of 156 functions. Every error is a `String`, so a typed cause is flattened on the first hop and `tugtool` cannot map "invalid name" and "git failed" to different exit codes.

---

## Purpose {#purpose}

Item 28 of `briefs/audit-punch-list.md`:

> 28. Split `ops.rs` along its seven clusters and give the arc engine a typed error. Today a typed error is flattened to `String` on the first hop, so tugtool cannot map causes to exit codes.

The public surface of the crate does not change: `lib.rs` re-exports every type and function callers use, and that list is the contract.

---

## Evidence {#evidence}

**[F01] The file already names its seams** — `// ---` banners at `git helpers` (425), `the -z path-listing door` (450), `the arc's documents home` (553), `arc identity` (1323), `commands` (1421), `steps` (2616). The commands section runs from 1421 to the test boundary at 6393 and contains create, show, list, status, commit, mark, join (preflight, integrate, progress), discard, and delete-documents without further banners. **(verified)**

**[F02] Size and shape** — 156 functions in the production half, 61 of them `pub`; the largest are `join_in_with_progress` (419 lines), `drop_identical_base_copies` (251), `show` (207), `resolve_base_in` (198), `create_in` (188), `discard_inner` (178), `integrate_join` (177), `arc_detail_entries_in` (173). The test half is 9.3k lines with 217 `#[serial]` tests. **(verified)**

**[F03] The public contract is the `lib.rs` re-export list** — `pub use ops::{…}` names 14 types and 32 functions. tugcast and tugtool together reference 56 distinct `tugarc_core::` items. Nothing outside the crate names `ops::` directly. **(verified)**

**[F04] Errors are strings throughout** — 49 `Result<_, String>` signatures and 31 `Err(format!` in the production half of `ops.rs`; `oplog.rs`, `resolve.rs`, and `workshop.rs` follow the same pattern. The crate defines no error enum and does not depend on `thiserror`. The flattening point is visible at `ops.rs:380` and `:1465`: `validate_arc_name(name).map_err(|e| e.to_string())?`, where `validate_arc_name` (`log.rs:39`) returns a typed `TugError`. **(verified)**

**[F05] tugtool's exit codes exist but cannot be chosen** — `tugtool/src/changes.rs::AppError` has `Exit1`, `Exit2`, `Exit3`, and `ExitStatus(u8)`. `arc::dispatch` converts every `String` from the engine to one of them without knowing the cause. **(verified)**

**[F06] Fourteen cwd-reading wrappers** — `commit`, `create`, `delete_documents`, `discard`, `join`, `list`, `mark`, `show`, `status`, `step_done`, `step_reopen`, `step_reset`, `step_start`, `step_withdraw` call `find_repo_root()` and delegate to a `*_in(repo, …)` sibling. Only tugtool calls them; tugcast calls the `_in` forms. They are why 217 tests are `#[serial]` and 51 call `set_current_dir`. **(verified)**

---

## Decisions {#decisions}

**[B01] `ops.rs` becomes `ops/` with one module per banner plus the unbannered clusters: `git.rs`, `listing.rs` (the `-z` door), `documents.rs`, `identity.rs`, `create.rs`, `show.rs` (show, list, status, detail entries), `steps.rs`, `commit.rs`, `join.rs` (preflight, blockers, integrate, progress), `discard.rs` (discard, delete-documents), and `cwd.rs` for the fourteen wrappers in [F06].** `ops/mod.rs` re-exports what `lib.rs` re-exports today, so `lib.rs` and every caller are untouched ([F03]). The wrappers get their own module so their CLI-only nature is visible and item 20 can delete the file rather than hunt for them.

**[B02] Tests move with their module, and a test that only exists to exercise a cwd wrapper moves to `cwd.rs` with it.** The `#[serial]` attribute follows each test unchanged; un-serialising is item 20's work. A move that leaves a module's tests behind in a shared file has not finished the move.

**[B03] One `ArcError` enum, `thiserror`-derived, in `tugarc-core/src/error.rs`.** Variants named for causes a caller can act on: `InvalidName(TugError)`, `NotFound { name }`, `Git { args, stderr }`, `Io { path, source }`, `Blocked(Vec<JoinBlocker>)`, `Conflicted`, `Refused(String)` for a preflight's sentence, and `Other(String)` as the migration escape hatch. `impl From<ArcError> for String` keeps tugcast's `Result<_, String>` boundary compiling during the migration, and is deleted when the last `Other` goes.

**[B04] The migration runs leaf-first and the escape hatch is a counted debt.** `git.rs` converts first, so every git failure is `Git { args, stderr }` from the start; then `documents.rs` and `identity.rs`; then the verbs. A function may return `Other(String)` while its callees are still strings, and a unit test asserts that the count of `Other` constructions in the crate only goes down between steps. The arc ends when it is zero and `From<ArcError> for String` is gone.

**[B05] tugtool maps variants to exit codes in one function, `arc::exit_code_for(&ArcError)`.** `InvalidName` and `NotFound` are usage errors; `Blocked`, `Conflicted`, and `Refused` are the engine declining with a reason; `Git` and `Io` are failures. The specific numbers are tugtool's to choose against its existing `Exit1..3` convention, and the mapping is one table a reader can find.

**[B06] The split lands before the error type.** The split is pure motion and can be verified by the unchanged test corpus; the error type changes signatures through the whole crate, and doing it across eleven small files is tractable where doing it across one 6k-line file is not.

---

## Open Questions {#open-questions}

- Whether `oplog.rs`, `resolve.rs`, and `workshop.rs` adopt `ArcError` in this arc or keep `String` behind an `Other`. They are 30, 43, and 19 `Err(format!` sites; the default is to convert them in the same leaf-first pass so the crate has one error type, and the arc may stop short if the `resolve.rs` conversion turns out to need its own decisions about conflict reporting.

---

## Non-goals {#non-goals}

- **Removing the cwd wrappers or un-serialising the tests.** Item 20. [B01] isolates them; it does not delete them.
- **Changing any verb's behaviour, message text, or receipt shape.** The receipts tugtool prints are built from the outcome types, which do not change.
- **A typed error for `tugchanges-core::git`.** Separate crate, and item 6 of the Medium list (one `git_output` in `tugcore`) is where that goes.

---

## Exit {#exit}

An arc. First the directory split, one module per step from the leaves up (`git`, `listing`, `documents`, `identity`, then the verbs), each step verified by `cargo nextest run -p tugarc-core -p tugtool` and the crate's line counts. Then `error.rs` with the enum and the `From<ArcError> for String` bridge, and the leaf-first conversion in the same module order, with the `Other`-count test ([B04]) as the running gauge. Last, tugtool's exit-code mapping ([B05]) and the `@covers`-derived app-test selection for `ops.rs`, with the `@covers` lines retargeted at `ops/`.
