## Text-File Card ↔ Disk Linkage Repair {#phase-slug}

**Purpose:** Stop Text cards from raising false "File Deleted" dialogs when a join (or any git checkout, or the card's own atomic save) replaces their file in place, while making the genuine move-following and delete-detection machinery honest: verdicts rest on path existence and file identity, not on unpaired FSEvents flags and content hashes.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-21 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-21, opus.** Reviewed `plan:72d2f93ea433b816`. Lint: 0 errors, 1 warning (fixed — this section).
Oriented on: the full document (first round, never reviewed).
Applied: **holes** — found two more sites that latch the false verdict, `save()` and `_onWriteSettled` in `text-card-store.ts`, reachable during a join because `fs_write` returns `missing` for a vanished file with a non-null baseline (`fs_write.rs`); added [P07] and folded them into the Spec S01 ladder. **holes** — `_recheckQueued` is consumed only on the `ok && !editedDuringWrite` write outcome, so a frame arriving during a write that then conflicts loses its recheck entirely; Step 2 now fixes that, which the original guard-reorder would otherwise have made worse. **technical choice** — [P01]'s collapse would have skipped `FileTreeFeed::remove_path`'s directory-child eviction for a same-path directory replace, silently stranding children in the completion index; the collapse is now files-only and `deduplicate_batch` takes the watch root (Risk R03). **law [L29]** — Step 5 adopted a string-constructed successor path; corrected to adopt the canonical `outcome.file.path` the probe read returns, matching what `_tryAdoptRemovedRename` already does. **test plan** — the plan ignored `tugdeck/src/lib/__tests__/text-card-store.manual.test.ts` (842 lines, faithful in-memory `file-io` substrate) and pushed pure state-machine work to expensive app-tests; the ladder, settle window, un-latch, and successor-path rules now test there, with the `connection-singleton` seam named (`getConnection()` returns null under `bun:test`, so `_onFilesystemFrame` is never wired today). **test plan** — the proposed app-test would have passed vacuously: at0209's fixture lives in `os.tmpdir()`, outside every watched workspace, so no FILESYSTEM frame is produced at all; the new test must bind a session to the fixture repo, and `tests/app-test/dash-fixture.ts` already ships `makeDashScratchRepo` / `createDash` / `commitRound` / `makeJoinScratchRepo` for exactly this. **sequencing** — the reported bug's regression proof sat at Step 7, six steps behind its fix; the join-replace app-test is now Step 3, directly after the store repair. **context** — recorded that manual is the shipping save mode (at0209 opts into automatic explicitly), which is why the user sees a modal and not a banner.
Deferred: the modality-escalation question — asked in review, and the user chose to latch modality at raise time; now [P06] and Spec S03, not an Open Question. [Q01] (server-side locate-by-inode) stands as devised.

---

### Phase Overview {#phase-overview}

#### Context {#context}

Whenever the user joins a dash, Text cards on files the join touched raise the modal "File Deleted — '<name>' was deleted by another application" sheet. The file was never deleted: git replaces a worktree file by unlinking and recreating it, and FSEvents (via `notify` v8) reports that as a coalesced batch of `Remove(File)` + `Create(File)` + `Modify(Metadata)` + `Modify(Data)` for the **same path**. This was reproduced directly with a `notify` v8 probe watching a scratch repo during `git merge --squash` — the exact call `join_in` makes on the main worktree (`tugrust/crates/tugdash-core/src/ops.rs`, the squash arm of `join_in_with_progress`).

The verdict is *modal* because **manual is the shipping save mode**: `text-card.tsx` constructs its store with `readSaveMode()`, and `at0209-text-card-live-autosave.test.ts` opts into automatic explicitly precisely because manual is the default. In manual mode a store `conflict` is presented as a pane-modal sheet; in automatic mode the same verdict renders as the `TugPaneBanner`. Both are wrong here; the modal is what the user sees.

The failure chain has three links, each individually defective:

1. **The watcher erases the truth.** `deduplicate_batch` (`tugrust/crates/tugcast/src/feeds/file_watcher.rs`) drops every `Modified` event whose path also carries a `Created` or `Removed` in the same batch — so the one event that says "this file's content changed" never reaches the client. The frame arrives as `[Removed{p}, Created{p}]`.
2. **The client never checks existence.** `_onFilesystemFrame` in `tugdeck/src/lib/text-card-store.ts` sees a `Removed` for its own path and goes straight to `_tryAdoptRemovedRename`, which decides identity **by content hash**: it reads each `Created` candidate and compares its sha256 to `_baselineSha256`. A join changes the content, so no candidate matches — and the code concludes the file is gone without ever probing whether its own path still exists.
3. **The verdict is a modal with dangerous defaults.** The missing sheet's default button is "Save" (recreate from buffer); when the file actually exists, `resolveMissing`'s null-baseline write 409s into the conflict sheet whose default is "Save Anyway". During a join the buffer is typically clean and equal to the *pre-join* bytes, so pressing the two defaults silently reverts the join in that file.

Four adjacent defects ride along. The rename-follow branches in `_onFilesystemFrame` run **before** the `saveState === "writing"` guard, so the card's own atomic save (temp + rename in `/api/fs/write`) can raise the same false verdict. Two *other* sites latch the missing verdict with no filesystem frame involved at all — `save()` and `_onWriteSettled` both translate `fs_write`'s `missing` error straight into `conflict: {reason: "missing"}`, and `fs_write.rs` returns exactly that for a vanished file with a non-null baseline, which is what a save landing inside git's unlink window receives. A raised conflict latches (`if (snap.conflict !== null) return;`) so the card ignores the file coming back. And a **clean** buffer gets a modal claiming unsaved changes are at risk. Finally, when a join removes the dash worktree (`remove_dash_worktree`, `ops.rs`), cards on files *inside* the dash see a genuinely-gone path — but the file's successor sits at `<repo_root>/<same rel path>`, and the current sheet doesn't know that.

#### Strategy {#strategy}

- **Fix the lie at the source first.** Collapse same-path `Removed`+`Created` into `Modified` inside the watcher's batch dedup — that is what actually happened on disk — restricted to files, so `FileTreeFeed`'s directory-child eviction is never skipped.
- **Then make the client's verdict evidence-based.** Before declaring a file missing, probe the card's own path; a replace-in-place routes to the ordinary external-change path (clean → silent reload, dirty → hash conflict). Every entry point that can conclude "missing" — frame, activation recheck, and both write settles — goes through the one ladder, because two code paths that can disagree about whether a file exists eventually will.
- **Prove the reported bug fixed immediately after fixing it.** The real-git join-replace app-test lands as Step 3, not at the end, so the primary success criterion is green before the enhancement steps begin.
- **Give a `Removed` a settle window.** Never render a "missing" verdict synchronously from one frame; arm a short timer, re-probe, and only then decide. Large checkouts take longer than one 100 ms debounce window.
- **Upgrade rename-following from content-hash identity to inode identity**, with the hash as fallback — moves-with-edits follow correctly, and two identical files never mis-bind.
- **Teach the card the dash lifecycle.** A path under `<workspaceRoot>/.tug/worktrees/<name>/<rel>` whose worktree vanishes has a knowable successor at `<workspaceRoot>/<rel>`; re-anchor there instead of claiming deletion.
- **Right-size the UX last.** Modal only when unsaved edits were genuinely at risk *when the verdict was raised*; un-latch a missing verdict when the file reappears; remove the destructive-default chain.
- **Test at the layer that can fail for the right reason.** State-machine rules go in the existing `text-card-store.manual.test.ts` substrate; real-git / real-FSEvents proof goes in one app-test (#test-layers).
- Sequence Rust-first, then store, then the regression proof, then the enhancements.

#### Success Criteria (Measurable) {#success-criteria}

- Running a real `git merge --squash` under an open, clean Text card produces **no sheet and no banner**; the editor silently shows the joined content (the app-test asserts content adoption *positively*, so an absent feed fails it rather than passing it — Risk R04).
- The same scenario with a **dirty** card raises the hash-**conflict** adjudication (never the missing/"deleted" verdict) — asserted by app-test.
- A save that lands inside git's unlink window resolves to a hash conflict or a clean reload, never a missing verdict (store test over the `fs_write` `missing` outcome).
- A true external delete still raises the missing verdict after the settle window (store test + app-test scenario).
- A file renamed on disk under a card rebinds silently to the new path even when its content was also edited in the same batch (inode identity; covered by test).
- `deduplicate_batch` unit tests prove `[Removed{p}, Created{p}, Modified{p}]` → `[Modified{p}]` for a file, that a genuine rename pair `[Removed{a}, Created{b}]` is left intact, and that a **directory** replace is left uncollapsed.
- After a dash join removes `.tug/worktrees/<name>/`, a clean card on a file inside it re-anchors to the repo-root successor path without any dialog (covered by test).
- A missing verdict raised over a clean buffer stays a banner for its whole life, even after the user types (Spec S03).
- `cd tugrust && cargo nextest run` green; `cd tugdeck && bunx vite build` green; `just app-test-changed` green.

#### Scope {#scope}

1. Watcher batch semantics: same-path remove+create collapse for files (`file_watcher.rs`).
2. `TextCardStore` verdict machinery: one classification ladder shared by the frame handler, the activation recheck, and both write settles; guard ordering; settle window; un-latch.
3. File identity plumbing: `dev`/`ino` in `/api/fs/read` and `/api/fs/stat` responses, client types, identity-first rename adoption.
4. Dash-worktree retirement re-anchor in the store.
5. Sheet modality (latched at raise), copy, and defaults in `text-card.tsx` / `text-card-save-sheets.tsx`.
6. Tests at every layer: Rust units, store-substrate units, and one end-to-end app-test that runs a real squash-merge under an open card bound to a real watched workspace.

#### Non-goals (Explicitly out of scope) {#non-goals}

- A server-side locate-by-inode endpoint (search the FileTreeFeed index for a held `(dev, ino)` to follow moves the watcher never paired). Valuable, but it needs per-workspace index plumbing into an HTTP handler; deferred to follow-ons (#roadmap).
- Any change to the autosave write path, hash-conditioning, or aside (crash-safety) machinery — those are correct and untouched. Only the *interpretation* of a write's `missing` outcome changes ([P07]).
- Changes to `FileTreeFeed`'s own remove/insert handling: the collapse is restricted so its behavior is unchanged (Risk R03).
- Following moves of files **outside** all workspace roots (unchanged: `recheckOnActivation` backstop plus the missing flow).
- Legacy dash worktree homes (`.tugtree/tugdash__<name>`) in the re-anchor path-shape check — see [P05].

#### Dependencies / Prerequisites {#dependencies}

- `notify` v8 (already the workspace dependency, `tugrust/Cargo.toml`).
- No protocol/schema version bumps: `FsEvent` wire shape is unchanged; `/api/fs/read` and `/api/fs/stat` gain **additive** JSON fields only.
- Rust changes to tugcast require `just build-app` before app-tests exercise them (the app-test recipe refreshes `dist` but never rebuilds the binary).
- The app-test fixture surface in `tests/app-test/dash-fixture.ts` (`makeDashScratchRepo`, `createDash`, `commitRound`, `seedScratchSession`, `makeJoinScratchRepo`) and `App.spawnSessionResume`.

#### Constraints {#constraints}

- Warnings are errors in the Rust workspace (`-D warnings`).
- tugdeck laws apply — see the cross-check in #law-crosscheck. In particular [L02] (external state via `useSyncExternalStore`), [L03] (registration effects), [L29] (path canonicalization gateway), [L31] (no silent refusals), [L27] (every acquisition returns its release).
- App-tests: selective runs via `just app-test-changed`; every new test carries `@covers` lines; never pipe app-test output.
- No `localStorage`; no new persistent client state is introduced by this plan.

#### Assumptions {#assumptions}

- macOS FSEvents coalescing behavior as measured: git's replace-in-place arrives as same-path `Remove`+`Create`(+`Modify`) in one `notify` batch *most* of the time, but the design must not depend on single-batch delivery (hence the existence probe and settle window).
- `stat`'s `(dev, ino)` pair is a stable file identity across a rename on the same volume (true on APFS; a cross-volume move changes both and falls back to the hash match, then the missing flow — acceptable).
- Dash worktrees live at `<repo>/.tug/worktrees/<name>` (`worktree_path` / `new_worktree_path` in `tugrust/crates/tugdash-core/src/ops.rs`), i.e. **inside** the watched workspace root, so their file events already flow to the client (the watcher does not gitignore-filter events — see the header comment in `file_watcher.rs`).
- FILESYSTEM frames exist for a directory only once a workspace is registered for it, which happens when a session is spawned against that project dir (the `spawn_session_ok` ack carries the canonical `workspace_key`). A Text card alone never opens a workspace — see Risk R04.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings, `[P##]` plan-local decisions, `[Q##]` open questions, `Spec S##`, `Risk R##`, and `**References:**`/`**Depends on:**` lines on every execution step, per `tuglaws/devise-skeleton.md`. Global design decisions are cited as `[D##]`; tuglaws as `[L##]`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Server-side locate-by-inode for unpaired moves (OPEN) {#q01-locate-by-inode}

**Question:** Should tugcast grow an endpoint that, given a held `(dev, ino)`, searches the workspace file index and returns the file's current path — so a card can follow a move that produced no usable event pair (e.g. moved out and back over minutes, or events dropped in a rescan)?

**Why it matters:** It is the only mechanism that follows a move with **zero** reliance on event pairing. Without it, an unpaired out-of-batch move of a *dirty* card's file still ends at the missing verdict.

**Options (if known):**
- Extend `POST /api/fs/stat` with a `locate: {dev, ino}` mode that walks the workspace index.
- A dedicated `POST /api/fs/locate` handler with access to the per-workspace `FileTreeFeed` set.
- Do nothing; the settle window + existence probe covers the observed failure modes.

**Plan to resolve:** Ship this plan, then measure whether any false missing-verdict reports survive. Revisit in a follow-on if they do.

**Resolution:** DEFERRED — the observed failures are all replace-in-place or same-batch renames, which Steps 1–7 close without new server surface. Tracked in #roadmap.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Collapsing a *directory* remove+create strands indexed children | med | med | Collapse restricted to non-directory paths ([P01], Risk R03) | A completion-index staleness report |
| An app-test that produces no FILESYSTEM frames passes vacuously | high | high | The test binds a session to the fixture repo so a workspace is watched, and asserts adoption positively (Risk R04) | Any new watcher-dependent test |
| Settle-window timer interacts with card dispose | med | low | Timer handle cleared in `dispose()` per [L27]; all async continuations already guard on `_disposed` and path identity — new code follows the same pattern | Flaky store test |
| Inode reuse mis-binds a rename candidate | low | low | Identity match requires same `dev` **and** `ino` from a candidate named in the same event batch; hash fallback unchanged; ambiguity still falls to the missing flow, never a wrong rebind | A reproduced mis-bind |
| Changing sheet defaults surprises muscle memory | low | med | Only the *missing→409→conflict* chain changes default (to "Reload from Disk"); the plain external-edit conflict sheet keeps "Save Anyway" as default | User feedback |

**Risk R01: Two-batch straddle** {#r01-two-batch-straddle}

- **Risk:** A slow checkout delivers `Removed{p}` in one debounce batch and `Created{p}` in the next, so the watcher-level collapse (Step 1) never sees the pair.
- **Mitigation:** Step 2's existence probe + settle window decides from disk state, not event pairing; by the time the settle window re-probes, the file is back.
- **Residual risk:** A checkout stalled longer than the settle window on exactly the probed path still raises the (now banner-for-clean) verdict; the un-latch (Step 7) clears it when the file lands.

**Risk R02: Own-write echo classified as external, and a dropped recheck** {#r02-own-write-echo}

- **Risk:** Reordering the writing guard ahead of the rename branches could make the card miss a genuine external rename that occurs during its own write. Worse, today's `_recheckQueued` is consumed **only** on the `outcome.ok && !editedDuringWrite` branch of `_onWriteSettled` — so a queued recheck is silently dropped when the write conflicts, fails, or the buffer moved under it. Reordering without fixing that would widen an existing hole.
- **Mitigation:** Step 2 makes `_recheckQueued` honored on **every** write outcome, routing it through the shared ladder; a rename during a write leaves the old path absent at recheck, which then flows through probe → adopt → settle exactly as a frame-driven removal does.
- **Residual risk:** One extra read round-trip in that rare interleave.

**Risk R03: Directory replace strands indexed children** {#r03-directory-collapse}

- **Risk:** `FileTreeFeed::remove_path` evicts a removed **directory** plus every path indexed beneath it, precisely because the watcher is not guaranteed to emit per-child events. Collapsing a same-path directory `Removed`+`Created` into `Modified` would skip that eviction entirely (`apply_events` treats `Modified` as a no-op), leaving stale children in the completion index with no event that ever clears them.
- **Mitigation:** The collapse is restricted to paths that are not directories at collapse time; `deduplicate_batch` takes the watch root so it can classify (the `run()` call site already holds `watch_path`). A unit test pins that a directory pair survives uncollapsed.
- **Residual risk:** A path that is a directory at collapse time but a file moments later (or vice versa) is classified by the snapshot the watcher saw — the same tolerance `FileTreeFeed::insert_path` already lives with.

**Risk R04: A vacuous watcher app-test** {#r04-vacuous-app-test}

- **Risk:** `at0209-text-card-live-autosave.test.ts` seeds its fixture into `os.tmpdir()`, which is inside **no** watched workspace — its external-change scenarios exercise the conditional-write path, never the FILESYSTEM feed. A join-replace test built on that pattern would produce zero frames and pass while proving nothing.
- **Mitigation:** The Step 3 test binds a session to the fixture repo (`App.spawnSessionResume` with `projectDir` = the scratch repo, the pattern `at0417-join-mode.test.ts` uses), which is what registers the workspace and starts its `FileWatcher`. The test asserts positively that a frame-driven reload occurred (clean content adoption with no write), so an absent feed fails it rather than passing it.
- **Residual risk:** None material; the positive assertion is the guard.

---

### Design Decisions {#design-decisions}

#### [P01] Same-path remove+create collapses to Modified at the watcher, for files only (DECIDED) {#p01-collapse-at-watcher}

**Decision:** In `deduplicate_batch` (`tugrust/crates/tugcast/src/feeds/file_watcher.rs`), when one batch contains both `Removed{p}` and `Created{p}` for the same path `p` **and `p` is not a directory**, replace the pair with a single `Modified{p}` (and keep dropping the now-redundant raw `Modified{p}` duplicates). `deduplicate_batch` gains the watch root as a parameter so it can make that classification; the `run()` call site already holds `watch_path`.

**Rationale:**
- The on-disk truth of git's unlink+recreate is "the content at this path changed"; the current dedup *inverts* the truth by dropping the `Modified` and keeping the misleading pair.
- Fixes every file consumer at once: Text cards stop seeing phantom deletes; `FileTreeFeed` stops a pointless evict+reinsert; `git_watch` is unaffected (it only asks whether a path is under `.git/`).
- The directory carve-out is not tidiness: `FileTreeFeed::remove_path` uses a directory `Removed` to evict every indexed child, and `apply_events` treats `Modified` as a no-op, so collapsing a directory pair would strand those children permanently (Risk R03).

**Implications:**
- The collapse must **not** touch a genuine rename pair (`Removed{a}` + `Created{b}`, `a ≠ b`) — same-path matching only.
- Unit tests in the existing `mod tests` of `file_watcher.rs` pin file collapse, directory non-collapse, and rename-pair preservation.
- The client keeps its own removed-path handling (Risk R01: pairs can straddle batches), so this is belt *and* suspenders, not a substitute for Step 2.

#### [P02] Existence before verdict, and the writing guard runs first (DECIDED) {#p02-existence-before-verdict}

**Decision:** Restructure `_onFilesystemFrame` in `tugdeck/src/lib/text-card-store.ts` so that (a) the `saveState === "writing"` echo-guard is evaluated before any rename/removed branch, and (b) a `Removed` (or unpaired absence) for the card's own path first probes the path itself — if it exists, route to the ordinary external-change path (clean → `_recheckDisk`, manual+dirty → `_raiseConflictIfDiverged`), and only if it does not exist proceed to rename adoption and then the settle window.

**Rationale:**
- The root defect: the current code decides "deleted" from an event flag plus a content hash, never asking the one question that matters. `readFileFromDisk` succeeding on our own path *is* the proof of replace-in-place.
- The current branch order lets the card's own atomic save (temp+rename in `/api/fs/write`) enter the rename/missing machinery mid-write, before `_baselineSha256` is updated on settle — a live race behind sporadic non-join dialogs.

**Implications:**
- The removed-path handling becomes an async routine (probe → classify → adopt → settle) shared by the frame handler, the activation recheck, and both write settles ([P07]); all continuations guard on `_disposed` and `_snapshot.path` identity, matching the file's existing async discipline.
- `_recheckQueued` must be honored on every write outcome, not only the clean-success branch (Risk R02).
- `conflict !== null` no longer unconditionally deafens the handler (see [P06]).

#### [P03] A "missing" verdict requires a settle window (DECIDED) {#p03-settle-window}

**Decision:** The store never sets `conflict: {reason: "missing"}` synchronously from a filesystem frame. An apparent disappearance arms a single-shot settle timer (`MISSING_SETTLE_MS = 500`); on fire, re-probe the path (and any held identity per [P04]); only a still-absent file becomes a missing verdict. A new event for the path, a successful adoption, or `dispose()` cancels the timer.

**Rationale:**
- Checkouts, branch switches, and editors' safe-write dances routinely exceed one 100 ms debounce window; a verdict rendered from a single frame is a guess.
- 500 ms is imperceptible for a *true* delete (the verdict's cost is attention, not latency) and generous for a replace.

**Implications:**
- One new private field (timer handle) + constant in `text-card-store.ts`; cleared in `dispose()` alongside the existing debounce clear and FILESYSTEM unsubscribe, per [L27].
- Paths that legitimately vanish still reach the missing flow — nothing is silently swallowed, which is what [L31] requires of a deferred verdict; it is just no longer premature.

#### [P04] File identity is `(dev, ino)`, content hash is the fallback (DECIDED) {#p04-inode-identity}

**Decision:** `/api/fs/read` and `/api/fs/stat` responses gain additive `dev` and `ino` fields (from `std::os::unix::fs::MetadataExt`; on non-unix, omitted). `TextCardStore` records the identity on every successful read. `_tryAdoptRemovedRename` matches candidates identity-first (same `dev`+`ino`), falling back to the existing sha256 match, then to the settle window.

**Rationale:**
- Content-hash identity fails exactly when moves matter most: a move-plus-edit in one batch, and it can mis-bind two identical files (boilerplate, licenses).
- The inode survives a same-volume rename; git's replace-in-place *changes* the inode, which is fine — that case never reaches adoption once [P02] probes existence first.

**Implications:**
- `fs_read.rs::read_file` and `fs_stat.rs::stat_paths` each add fields per Spec S02; both already carry a `mod tests` for the unit coverage.
- `FileReadResult` in `tugdeck/src/lib/file-io.ts` gains optional `dev?: number; ino?: number`. `tugdeck/src/lib/dir-existence.ts` is untouched — the Text card probes through `readFileFromDisk`.
- Absent fields (old server, non-unix) degrade gracefully to today's hash behavior — no version coupling.

#### [P05] Dash-worktree retirement re-anchors by path shape, binding the canonical result (DECIDED) {#p05-dash-reanchor}

**Decision:** When the classification ladder finds the card's path matches `<root>/.tug/worktrees/<name>/<rel>` (derived by scanning the absolute path for the `/.tug/worktrees/<name>/` segment) and the path is gone, it probes the successor `<root>/<rel>`. Successor readable + buffer clean → adopt, then `_recheckDisk({force: true})` (silent, no prompt). Successor readable + buffer dirty (manual mode) → adopt, then raise the **hash conflict** against the successor's bytes — the honest question ("your unsaved edits differ from what joined"), never the "deleted" verdict. Successor absent → the normal settle/missing flow. **The path bound is the canonical `path` the probe read returns, never the string-constructed candidate.** Legacy `.tugtree/tugdash__<name>/` homes are out of scope: they are migrated on dash access (`migrate_worktrees` in `ops.rs`) and no new cards bind into them.

**Rationale:**
- Join tears down the worktree (`remove_dash_worktree`), so the path is *genuinely* gone — the only case where "missing" is factually true today, and still the wrong answer, because the file's successor is knowable from shape alone.
- Requires zero new server plumbing: `.tug/worktrees/` is a fixed, tugtool-owned convention inside the watched root.
- [L29] forbids binding or comparing a raw path. `readFileFromDisk` already returns the canonicalized form (`resolve_to_claude_form` server-side), and `_tryAdoptRemovedRename` already adopts `outcome.file.path` for exactly this reason; the successor adopt follows the same discipline. The constructed string is a *probe input* only.

**Implications:**
- A small pure helper `dashSuccessorPath(path: string): string | null` in `text-card-store.ts` (exported for unit testing) encodes the shape rule and nothing else — no filesystem access, no binding.
- The dirty-adopt raises `conflict: {reason: "hash", diskSha256}` against the adopted path, so the existing conflict sheet and its resolutions (Reload / Save As / Save Anyway) apply unchanged.

#### [P06] Modality is latched at raise time; verdicts un-latch (DECIDED) {#p06-modality-and-unlatch}

**Decision:** Three UX corrections. (1) A missing verdict records, at raise time, whether the buffer was clean; a verdict raised over a **clean** buffer renders as the non-modal banner for its entire life — even after the user types — and only a verdict raised over an **already-dirty** buffer is ever the modal sheet. (2) While a missing verdict is up, the frame handler keeps listening for the card's own path: a `Created`/`Modified` for it (or a settle-window re-probe finding it) clears the verdict and routes through the normal external-change path. (3) The conflict sheet presented as the follow-up to `resolveMissing`'s 409 (the missing→Save→file-exists-now chain in `text-card.tsx`) defaults to "Reload from Disk", not "Save Anyway"; `presentConflictSheet` gains an options argument for the default, and the plain external-edit conflict sheet keeps its current default.

**Rationale:**
- A modal about unsaved changes over a clean buffer asserts a falsehood; nothing is at risk.
- Modality must not follow *live* `saveState`, because `noteEdit` deliberately flips a clean buffer to `editing` on the first keystroke while a conflict is set (so the aside gate opens, the dirty dot shows, and the close guard cannot destroy the edits) — a behavior pinned by the existing store test "a missing conflict on a clean buffer goes dirty on the next edit". Live-gating would slam a modal up mid-typing. Latching at raise time is the user's decision, taken in review.
- The current `if (snap.conflict !== null) return;` latch means Cancel leaves the card deaf to the file returning — the user must resolve a stale question by hand.
- The two-defaults chain (Save → Save Anyway) is a data-loss path that can silently revert a join; after this plan it is rare, but the default should still not be the destructive branch.

**Implications:**
- The conflict shape carries the latched modality (Spec S03), so the card renders from the snapshot alone — no React-side memory of a prior state, honoring [L02].
- `text-card.tsx`: the conflict-presentation `useLayoutEffect` gates the modal on that flag; the existing `TugPaneBanner` — which already ships the exact "File deleted" copy with `Save As…` and `Close` affordances — widens its `visible` condition to cover manual-mode banner verdicts. It remains the card's ONE banner, so the un-refcounted `inert` hazard documented at that call site is untouched.
- `text-card-save-sheets.tsx`: `presentConflictSheet(fileName, opts?: {defaultChoice?: ConflictSheetChoice})`.
- Store: clearing a verdict on reappearance updates `conflict: null` and runs the normal recheck; the snapshot-driven presentation effect (single-flight ref already present) must dismiss a live sheet rather than strand it — a cleared verdict behind a stale modal is exactly the silent dead-end [L31] forbids.

#### [P07] Every path to a missing verdict goes through the one ladder (DECIDED) {#p07-write-side-unification}

**Decision:** The `missing` outcomes in `save()` and `_onWriteSettled` no longer set `conflict: {reason: "missing"}` directly. Both enter the Spec S01 ladder at the probe rung: file present → hash conflict against the current bytes (or clean reload); file absent → adoption attempt, then the settle window.

**Rationale:**
- `fs_write.rs` returns `missing` for a vanished file with a non-null baseline — precisely what a save landing inside git's unlink window receives. These two sites can therefore raise the false verdict with **no filesystem frame involved at all**, so fixing only the frame handler would leave the reported bug reachable through the save path.
- One ladder with five entry points is also the only way the verdict stays consistent: two code paths that can disagree about whether a file exists eventually will.

**Implications:**
- `save()` still returns a `FileSaveResult` to its caller synchronously (the sheet-presentation contract in `text-card.tsx` depends on it); what changes is that the *verdict state* is set by the ladder rather than inline. Where the ladder resolves to "present", `save()` returns `"conflict"` instead of `"missing"` — the honest answer, and one the existing caller already handles.
- The existing store tests `resolveMissing recreates a deleted file` and `resolveMissing conflicts instead of clobbering a reappeared file` must stay green; they exercise a genuinely-absent file, which the ladder still resolves to missing.

---

### Deep Dives {#deep-dives}

#### Measured event shape of git replace-in-place {#measured-event-shape}

A `notify` v8 probe (same crate + version as tugcast) watching a scratch repo during `git merge --squash` + `git commit` delivered, in one coalesced burst for the merged file:

```
Remove(File)               [<repo>/f.txt]
Create(File)               [<repo>/f.txt]
Modify(Metadata(Extended)) [<repo>/f.txt]
Modify(Data(Content))      [<repo>/f.txt]
```

`convert_event` maps these to `Removed`, `Created`, `Modified` (metadata dropped); `deduplicate_batch` then deletes the `Modified` because the path has Created/Removed events, leaving `[Removed{p}, Created{p}]` on the wire. That pair is what the Text card store misreads as a rename-or-delete. The same unlink+recreate shape is produced by `git checkout`, `git reset --hard`, and tugcast's own atomic `/api/fs/write` (temp + rename).

#### Current client flow and its blind spot {#current-client-flow}

`_onFilesystemFrame` (`tugdeck/src/lib/text-card-store.ts`) branch order today: (a) explicit `Renamed{from == ours}` → `_adoptRename(to)`; (b) `Removed{ours}` → `_tryAdoptRemovedRename` → hash-match Created candidates → else `conflict: {reason: "missing"}`; then the generic hit test, the `writing` echo-guard (sets `_recheckQueued`), the `conflict !== null` latch, and the clean/dirty routing. The blind spot: branch (b) never probes `snap.path` itself.

There are **five** places that can conclude "missing" today: `_raiseConflictIfDiverged`, `_tryAdoptRemovedRename`, `_recheckDisk`, `save()`, and `_onWriteSettled`. The first three are read-driven; the last two are write-driven ([P07]). All five collapse into the one ladder.

A second, quieter defect lives in the echo-guard's partner: `_recheckQueued` is consumed **only** on `_onWriteSettled`'s `outcome.ok && !editedDuringWrite` branch, so a recheck queued during a write that then conflicts, fails, or was edited under is dropped without a trace (Risk R02).

`_adoptRename` (rebind path/fileName, re-key the manual-mode aside, delete the old aside, re-flush when dirty) is correct and kept as-is, as are the hash-conditioned write machinery, `parseFilesystemFrame`, and the `workspace_key` splice.

#### Why every consumer tolerates the collapse {#consumer-tolerance}

- `FileTreeFeed::apply_events` treats `Modified` as a no-op ("file saves don't change the file list") — correct for a *file* replace-in-place, and strictly better than the current evict+reinsert churn. It is **not** correct for a directory, whose `Removed` is what drives `remove_path`'s eviction of every indexed child; that is why [P01] carves directories out (Risk R03).
- `git_watch::batch_touches_git` matches all event kinds uniformly by path prefix.
- `FilesystemFeed` forwards batches verbatim.
- The Text card store treats `Modified{ours}` as the generic hit → clean reload / dirty adjudication — exactly the desired behavior for a join.

#### Test layers and the substrate that already exists {#test-layers}

`tugdeck/src/lib/__tests__/text-card-store.manual.test.ts` (842 lines) already drives the **real** `TextCardStore` against a faithful in-memory `file-io` module: conditional writes, create-new, delete, `conflict`, and `missing` outcomes, keyed by path so a test can assert exactly which file was touched. That is the right layer for everything in Spec S01 and Spec S03 that is pure state machine — ladder ordering, the settle window, the un-latch, the write-side unification, `dashSuccessorPath` — because those can fail there for the right reason, deterministically, without a 240-second app-test.

One seam is missing: the store subscribes to the FILESYSTEM feed in its constructor via `getConnection()`, which returns `null` under `bun:test`, so `_onFilesystemFrame` is never wired today. Add a `mock.module("@/lib/connection-singleton", …)` alongside the existing `file-io` mock, returning an object whose `onFrame(feedId, cb)` captures the callback and hands back an unsubscribe; the test then feeds real `FilesystemFrame` JSON bytes through it. This mocks a **transport seam**, not a core interface being asserted on — the assertions remain on store behavior, exactly as the existing file's do.

What stays in the app-test is what only the real app can prove: real git mutating a real watched worktree, real FSEvents, real tugcast, real feed frames, real sheet/banner DOM.

#### The law cross-check {#law-crosscheck}

- **[L02] External state enters React through `useSyncExternalStore` only.** Honored. Every verdict — including the latched modality and the un-latch — lives in the store snapshot the card already reads through `useSyncExternalStore`; the card gains no React state and no memory of prior snapshots. Spec S03 exists specifically to keep the fact in the store rather than in the component.
- **[L03] `useLayoutEffect` for registrations that events depend on.** Honored. The conflict-presentation effect in `text-card.tsx` is already `useLayoutEffect` with a single-flight ref; this plan changes its condition, not its kind.
- **[L06] Ephemeral appearance state goes through CSS and DOM.** Not engaged. Banner visibility is a rendered consequence of store data, not an appearance-zone toggle.
- **[L29] Every persisted or compared path routes through the canonicalization gateway.** At risk in the original [P05] and now corrected: `dashSuccessorPath` produces a *probe input*, and the path actually bound is the canonical `path` the read returns. `_tryAdoptRemovedRename` already sets this precedent.
- **[L31] A user gesture produces either the act or a visible reason — never silence.** Honored. The settle window defers a verdict; it never discards one. The un-latch clears a verdict only by replacing it with the correct state (reload or hash conflict), and [P06] requires a live sheet be dismissed rather than stranded when its verdict clears.
- **[L27] Every acquisition returns its release.** Honored. The settle timer is cleared in `dispose()` beside the existing debounce clear and the FILESYSTEM unsubscribe.

---

### Specification {#specification}

**Spec S01: The one classification ladder** {#s01-classification-ladder}

Entered from five places: the frame handler on a `Removed`/`Renamed{from}` for the card's path, `recheckOnActivation`, `_recheckDisk`'s not-found branch, `save()`'s `missing` outcome, and `_onWriteSettled`'s `missing` outcome ([P07]). Rungs run in strict order:

1. **Echo:** `saveState === "writing"` → set `_recheckQueued`; stop. (Frame entry only; the write settle honors that flag on **every** outcome — Risk R02.)
2. **Replace-in-place:** `readFileFromDisk(path)` succeeds → clean: `_recheckDisk()`; manual+dirty: `_raiseConflictIfDiverged()`; automatic+dirty: leave to the conditional write. Stop.
3. **Paired rename:** identity-first, hash-fallback adoption over the batch's `Created` candidates ([P04]) → `_adoptRename(outcome.file.path)`. Stop.
4. **Dash retirement:** `dashSuccessorPath(path)` non-null and the successor readable ([P05]) → adopt the read's canonical path, then reload (clean) or raise a hash conflict (dirty). Stop.
5. **Settle:** arm/refresh the `MISSING_SETTLE_MS` timer ([P03]); on fire, re-run rungs 2–4; a second consecutive absence → raise the missing verdict per Spec S03.

**Spec S02: Additive identity fields (wire)** {#s02-identity-fields}

- `/api/fs/read` 200 body gains `"dev": <u64>, "ino": <u64>`.
- `/api/fs/stat` response gains a top-level `"identity": { <rawPath>: {"dev": <u64>, "ino": <u64>} }` map, populated only for reachable paths.
- Both are additive; no existing field changes. Non-unix builds omit them (`#[cfg(unix)]`).

**Spec S03: The missing verdict carries its modality** {#s03-verdict-modality}

The missing conflict variant gains `raisedOverCleanBuffer: boolean`, set from `saveState === "clean"` at the moment the verdict is raised and never recomputed. `text-card.tsx` reads it: `true` → the `TugPaneBanner` path (manual and automatic alike); `false` → the modal sheet in manual mode, the banner in automatic. Because `noteEdit` deliberately flips a clean buffer to `editing` on the first keystroke under a conflict — pinned by the existing store test "a missing conflict on a clean buffer goes dirty on the next edit" — live `saveState` is never a legal input to this choice.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Settle-timer handle, held identity `(dev, ino)`, `_recheckQueued` | store-internal (non-rendered) | private `TextCardStore` fields; timer released in `dispose()` | [L27] |
| Missing/conflict verdict + `raisedOverCleanBuffer` | external state rendered by React | store snapshot via `useSyncExternalStore` | [L02] |
| Sheet presentation (modal missing/conflict) | derived effect from snapshot | existing `useLayoutEffect` + single-flight ref in `text-card.tsx` | [L03] |
| Banner show/hide | rendered consequence of snapshot data | existing `TugPaneBanner` `visible` prop | [L02] |
| Adopted path after a rename or re-anchor | persisted/compared path | the canonical `path` returned by `/api/fs/read` | [L29] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files (if any) {#new-files}

| File | Purpose |
|------|---------|
| `tests/app-test/atNNNN-text-card-join-replace.test.ts` | End-to-end: real squash-merge under an open card in a watched workspace (allocate the next unused `at` number; `at0460` is free as of this writing) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `deduplicate_batch` | fn (modify) | `tugrust/crates/tugcast/src/feeds/file_watcher.rs` | takes the watch root; same-path Removed+Created → Modified for files only ([P01]) |
| `read_file` | fn (modify) | `tugrust/crates/tugcast/src/fs_read.rs` | add `dev`/`ino` (Spec S02); `mod tests` exists |
| `stat_paths` | fn (modify) | `tugrust/crates/tugcast/src/fs_stat.rs` | add `identity` map (Spec S02); `mod tests` exists |
| `FileReadResult.dev` / `.ino` | optional fields | `tugdeck/src/lib/file-io.ts` | parsed when present |
| `TextCardConflict` missing variant | type (modify) | `tugdeck/src/lib/text-card-store.ts` | `raisedOverCleanBuffer` (Spec S03) |
| `_onFilesystemFrame` | method (restructure) | `tugdeck/src/lib/text-card-store.ts` | guard order + ladder entry ([P02], Spec S01) |
| `_classifyAbsentPath` | private async method (new) | `tugdeck/src/lib/text-card-store.ts` | rungs 2–5 of Spec S01; shared by all five entry points |
| `_missingSettleTimer`, `MISSING_SETTLE_MS` | field + const (new) | `tugdeck/src/lib/text-card-store.ts` | [P03]; cleared in `dispose()` |
| `_heldIdentity` | field (new) | `tugdeck/src/lib/text-card-store.ts` | `(dev, ino)` captured on every successful read ([P04]) |
| `_tryAdoptRemovedRename` | method (modify) | `tugdeck/src/lib/text-card-store.ts` | identity-first candidate match ([P04]) |
| `save`, `_onWriteSettled` | methods (modify) | `tugdeck/src/lib/text-card-store.ts` | `missing` outcome enters the ladder ([P07]); `_recheckQueued` honored on every outcome |
| `dashSuccessorPath` | exported fn (new) | `tugdeck/src/lib/text-card-store.ts` | [P05] path-shape rule; pure, unit-testable, probe input only |
| `presentConflictSheet` | fn (modify) | `tugdeck/src/components/tugways/cards/text-card-save-sheets.tsx` | `defaultChoice` option ([P06]) |
| conflict-presentation effect + banner `visible` | modify | `tugdeck/src/components/tugways/cards/text-card.tsx` | gate on `raisedOverCleanBuffer` (Spec S03) |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | `deduplicate_batch` collapse / directory carve-out / rename preservation; `read_file` + `stat_paths` field presence | Steps 1, 4 |
| **Store substrate (bun:test)** | The Spec S01 ladder, settle window, un-latch, write-side unification, Spec S03 latch, `dashSuccessorPath` — against the real store over the in-memory `file-io` fake (#test-layers) | Steps 2, 5, 6, 7 |
| **App-test (end-to-end)** | Real git mutating a real watched worktree: FSEvents → tugcast → feed → store → sheet/banner DOM | Steps 3, 6, 7 |
| **Drift Prevention** | `at0209` scenarios and the existing manual-mode store suite stay green | every step's checkpoint |

#### What stays out of tests {#test-non-goals}

- Fake-DOM / RTL render tests — banned; there is no in-process DOM substrate.
- Mock-store assertion tests that count mock method calls. The store substrate in `text-card-store.manual.test.ts` is the opposite of that: a faithful in-memory filesystem, with every assertion on real store behavior.
- Timing-precise assertions on the 500 ms settle window (flake-prone); tests assert outcomes after generous waits, not window edges.
- The `notify` crate's own coalescing behavior — measured once (#measured-event-shape), not re-proven per run.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step below.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Watcher: collapse same-path remove+create for files | done | `fbade5129` |
| #step-2 | Store: one ladder, guard order, settle window | done | `9065f04fc` |
| #step-3 | Join-replace app-test — the regression proof | done | `6282de6bd` |
| #step-4 | Identity fields on the fs endpoints | done | `6abdb34b8` |
| #step-5 | Identity-first rename adoption | done | `c13bdcff0` |
| #step-6 | Dash-worktree retirement re-anchor | done | `085541a14` |
| #step-7 | Modality latch, un-latch, and defaults | done | `4826bcc68` |
| #step-8 | Integration checkpoint | in progress | — |

#### Step 1: Watcher: collapse same-path remove+create for files {#step-1}

**Commit:** `tugcast(file-watcher): a same-path remove+create batch is a content change, not a delete`

**References:** [P01] Collapse at the watcher, Risk R03, (#measured-event-shape, #consumer-tolerance)

**Artifacts:** (what this step produces/changes)
- Modified `deduplicate_batch` in `tugrust/crates/tugcast/src/feeds/file_watcher.rs` (now taking the watch root) + unit tests in its `mod tests`.

**Tasks:**
- [ ] Give `deduplicate_batch` the watch root as a parameter; update the `run()` call site, which already holds `watch_path`.
- [ ] Before the existing Modified-drop pass, find every path carrying both a `Removed` and a `Created` in the batch; for paths that are **not** directories (`root.join(path).is_dir()` is false), remove both events and ensure exactly one `Modified{path}` survives (synthesize one if the raw batch carried none — metadata-only coalescing can drop it).
- [ ] Leave directory pairs untouched, so `FileTreeFeed::remove_path`'s child eviction still runs (Risk R03).
- [ ] Preserve batch-relative ordering for untouched events; leave genuine rename pairs (`Removed{a}` + `Created{b}`, `a ≠ b`) and explicit `Renamed` events untouched.
- [ ] Update the function's doc comment to state the collapse rule and the directory carve-out (what the code does — no bug-history narration).

**Tests:**
- [ ] `[Removed{p}, Created{p}, Modified{p}]` for a real temp file → `[Modified{p}]`.
- [ ] `[Removed{p}, Created{p}]` (no raw Modified) → `[Modified{p}]`.
- [ ] `[Removed{d}, Created{d}]` where `d` is a real directory → unchanged.
- [ ] `[Removed{a}, Created{b}]` unchanged.
- [ ] Mixed batch: collapse on `p` while an unrelated `Created{q}` and `Renamed{x→y}` pass through.
- [ ] Existing dedup tests stay green.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 2: Store: one ladder, guard order, settle window {#step-2}

**Commit:** `tugdeck(text-card-store): probe the path before declaring it missing; one ladder for every verdict`

**References:** [P02] Existence before verdict, [P03] Settle window, [P07] Write-side unification, Spec S01, Risk R01, Risk R02, (#current-client-flow, #test-layers, #law-crosscheck)

**Artifacts:** (what this step produces/changes)
- Restructured `_onFilesystemFrame`, new `_classifyAbsentPath`, `_missingSettleTimer` + `MISSING_SETTLE_MS`, rerouted `save()` / `_onWriteSettled` missing outcomes in `tugdeck/src/lib/text-card-store.ts`.
- A `connection-singleton` mock added to `tugdeck/src/lib/__tests__/text-card-store.manual.test.ts` so frames can be fed to the real store.

**Tasks:**
- [ ] Move the `saveState === "writing"` echo-guard to the top of `_onFilesystemFrame`: any event hitting the card's path (including `Removed` and `Renamed{from}`) while writing sets `_recheckQueued` and returns.
- [ ] Honor `_recheckQueued` on **every** `_onWriteSettled` outcome, not only `ok && !editedDuringWrite` (Risk R02) — today it is silently dropped on conflict, on failure, and when the buffer was edited during the write.
- [ ] Implement `_classifyAbsentPath()` as rungs 2–5 of Spec S01: probe own path via `readFileFromDisk`; present → clean `_recheckDisk()` / manual-dirty `_raiseConflictIfDiverged()` / automatic-dirty no-op; absent → existing `_tryAdoptRemovedRename` candidates; unresolved → arm the settle timer instead of raising the verdict.
- [ ] Route `save()`'s and `_onWriteSettled`'s `missing` outcomes into the ladder ([P07]); where the ladder resolves to "present", `save()` returns `"conflict"` rather than `"missing"`.
- [ ] Settle-timer fire re-runs rungs 2–4; a second consecutive absence raises the missing verdict. Any new frame event for the path, a successful adoption, or `dispose()` clears the timer ([L27]).
- [ ] All new async continuations guard on `this._disposed` and `this._snapshot.path` identity, matching the file's existing pattern.
- [ ] Add `mock.module("@/lib/connection-singleton", …)` to the store test file, capturing the `onFrame` callback so tests can deliver real `FilesystemFrame` JSON bytes (#test-layers).

**Tests:** (all in `tugdeck/src/lib/__tests__/text-card-store.manual.test.ts`)
- [ ] A `[Removed{p}, Created{p}]` frame over a clean buffer whose disk bytes changed → the buffer adopts the new content and `conflict` stays null.
- [ ] The same frame over a dirty manual buffer → `conflict.reason === "hash"`, never `"missing"`.
- [ ] A frame removing the path while the file is genuinely gone → no verdict before the settle window, missing verdict after it.
- [ ] A `missing` write outcome while the file is present on disk → hash conflict, and `save()` returns `"conflict"`.
- [ ] A frame arriving mid-write whose write then **conflicts** → the queued recheck still runs (Risk R02).
- [ ] Existing `resolveMissing` tests stay green.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 3: Join-replace app-test — the regression proof {#step-3}

**Depends on:** #step-1, #step-2

**Commit:** `app-test(text-card): git replacing a card's file in place is a content change, never a delete dialog`

**References:** [P01], [P02], [P03], [P07], Spec S01, Risk R04, (#success-criteria, #test-layers)

**Artifacts:** (what this step produces/changes)
- `tests/app-test/atNNNN-text-card-join-replace.test.ts` (next unused number; `at0460` free as of this writing), with `@covers` lines for `tugdeck/src/lib/text-card-store.ts`, `tugdeck/src/lib/file-io.ts`, `tugdeck/src/components/tugways/cards/text-card.tsx`, `tugdeck/src/components/tugways/cards/text-card-save-sheets.tsx`, and `tugrust/crates/tugcast/src/feeds/file_watcher.rs`.

**Tasks:**
- [ ] Build the fixture with `makeDashScratchRepo` from `tests/app-test/dash-fixture.ts` (or `makeJoinScratchRepo` where a full join is wanted), plus `seedScratchSession` — the pattern `at0417-join-mode.test.ts` uses.
- [ ] **Bind a session to the fixture repo** via `app.spawnSessionResume(cardId, { tugSessionId, projectDir })` so tugcast registers the workspace and starts its `FileWatcher`. Without this there are no FILESYSTEM frames at all and the test would pass vacuously (Risk R04).
- [ ] Open a Text card on a file inside that repo (model the seeding on `seedTextCard` in `at0209-text-card-live-autosave.test.ts`). Seed the save mode explicitly per scenario via `window.__tug.setTugbankValue("dev.tugtool.text-card","save-mode",…)` — manual is the shipping default.
- [ ] Scenario 1 (clean replace, manual mode): run a real `git merge --squash <branch>` + commit in the fixture repo; assert **positively** that the editor adopts the merged content (proving a frame arrived and drove a reload), and that neither the sheet nor the banner is present.
- [ ] Scenario 2 (dirty replace, manual mode): with unsaved edits, run the merge; assert the **hash-conflict** sheet appears, never the "File Deleted" one.
- [ ] Because Step 1 changed tugcast, run `just build-app` before this test file's first run (app-test refreshes dist, never the binary).

**Tests:**
- [ ] The two scenarios above are the tests.

**Checkpoint:**
- [ ] `just build-app`
- [ ] `just app-test-covers-check`
- [ ] `just app-test tests/app-test/atNNNN-text-card-join-replace.test.ts` (substitute the allocated number)

---

#### Step 4: Identity fields on the fs endpoints {#step-4}

**Commit:** `tugcast(fs): report (dev, ino) file identity from /api/fs/read and /api/fs/stat`

**References:** [P04] Inode identity, Spec S02, (#symbols)

**Artifacts:** (what this step produces/changes)
- `dev`/`ino` in `read_file` (`tugrust/crates/tugcast/src/fs_read.rs`); `identity` map in `stat_paths` (`tugrust/crates/tugcast/src/fs_stat.rs`); optional `dev?`/`ino?` on `FileReadResult` + parsing in `tugdeck/src/lib/file-io.ts`.

**Tasks:**
- [ ] Rust: under `#[cfg(unix)]`, read `MetadataExt::dev()`/`ino()` from the already-fetched `std::fs::Metadata` in both handlers; add the fields per Spec S02.
- [ ] TS: extend `FileReadResult` and `readFileFromDisk`'s response parsing; fields are optional and absent values change nothing downstream.

**Tests:**
- [ ] `fs_read.rs` `mod tests`: the response for a real temp file carries `dev`/`ino` matching a direct `std::fs::metadata` read.
- [ ] `fs_stat.rs` `mod tests`: `identity` carries entries for reachable paths and omits unreachable ones.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 5: Identity-first rename adoption {#step-5}

**Depends on:** #step-2, #step-4

**Commit:** `tugdeck(text-card-store): follow renames by file identity, hash as fallback`

**References:** [P04] Inode identity, Spec S01, [L29] canonical adopt, (#current-client-flow, #law-crosscheck)

**Artifacts:** (what this step produces/changes)
- `_heldIdentity` captured on every successful read; identity-first matching in `_tryAdoptRemovedRename` in `tugdeck/src/lib/text-card-store.ts`.

**Tasks:**
- [ ] Capture `(dev, ino)` from every successful `readFileFromDisk` into `_heldIdentity` (open, probe, recheck, adopt). The `/api/fs/write` response carries no identity, so a post-write refresh rides the next read rather than adding a field — see #roadmap.
- [ ] In `_tryAdoptRemovedRename`, read each candidate once and match: identity equal → adopt; else sha256 equal → adopt (existing behavior). Widen the candidate set from same-basename-else-sole-creation to *all* `Created` events in the batch when an identity is held (identity cannot mis-bind); the hash fallback keeps the current narrow candidate rule.
- [ ] Adopt `outcome.file.path` — the canonical path the read returns — never a constructed one ([L29]).
- [ ] `_adoptRename` refreshes `_heldIdentity` from the adopted read.

**Tests:** (in `tugdeck/src/lib/__tests__/text-card-store.manual.test.ts`; the in-memory `file-io` fake gains a `dev`/`ino` per file)
- [ ] A `[Removed{a}, Created{b}]` frame where `b` carries the held identity but **different** content → the card rebinds to `b` with no verdict (a hash match would have failed).
- [ ] Two `Created` candidates with identical content, one carrying the held identity → the identity-matching one is adopted.
- [ ] With no identity held (fields absent), the existing hash-match behavior is unchanged.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 6: Dash-worktree retirement re-anchor {#step-6}

**Depends on:** #step-2, #step-3

**Commit:** `tugdeck(text-card-store): a joined dash's file re-anchors to its repo-root successor`

**References:** [P05] Dash re-anchor, Spec S01, [L29] canonical adopt, (#assumptions, #law-crosscheck)

**Artifacts:** (what this step produces/changes)
- Exported `dashSuccessorPath` helper + rung 4 wiring in `_classifyAbsentPath` in `tugdeck/src/lib/text-card-store.ts`.
- A scenario appended to the Step 3 app-test file.

**Tasks:**
- [ ] Implement `dashSuccessorPath(path)`: locate the `/.tug/worktrees/<name>/` segment; return the path with `.tug/worktrees/<name>/` excised, else `null`. Pure string logic; no filesystem access; the result is a probe input only.
- [ ] Wire rung 4: successor readable + clean → adopt the read's canonical path then `_recheckDisk({force: true})`; successor readable + manual-dirty → adopt, then set `conflict: {reason: "hash", diskSha256: <successor sha>}`; successor absent → fall through to rung 5.
- [ ] Automatic-mode dirty: adopt and let the conditional write adjudicate (matches the mode's existing conflict philosophy).

**Tests:**
- [ ] Store-substrate unit tests for `dashSuccessorPath`: worktree path → successor; repo-root path → null; nested `<rel>` with directories preserved; a `.tug/worktrees` segment that is not a dash-home shape → null.
- [ ] Store-substrate test: the bound path vanishes and the successor exists → the card rebinds to the successor, clean, with no verdict.
- [ ] App-test scenario (Step 3 file): a Text card on a file inside `createDash(...).worktree`, then a real join; assert the card re-anchors to the repo-root path with no dialog.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib`
- [ ] `just app-test tests/app-test/atNNNN-text-card-join-replace.test.ts`

---

#### Step 7: Modality latch, un-latch, and defaults {#step-7}

**Depends on:** #step-2, #step-3

**Commit:** `tugdeck(text-card): missing verdicts match their risk, and clear when the file returns`

**References:** [P06] Modality and un-latch, Spec S03, [L02], [L31], (#state-zone-mapping, #law-crosscheck)

**Artifacts:** (what this step produces/changes)
- `raisedOverCleanBuffer` on the missing conflict + un-latch handling in `tugdeck/src/lib/text-card-store.ts`; modified conflict-presentation effect + banner `visible` in `tugdeck/src/components/tugways/cards/text-card.tsx`; `defaultChoice` option on `presentConflictSheet` in `tugdeck/src/components/tugways/cards/text-card-save-sheets.tsx`.

**Tasks:**
- [ ] Store: add `raisedOverCleanBuffer` to the missing conflict, set once at raise time from `saveState === "clean"` and never recomputed (Spec S03).
- [ ] Store: while a missing verdict is up, a frame event for the card's path re-probes and, when the file is readable, clears the verdict and routes clean→reload / dirty→hash-adjudication. Narrow the `conflict !== null` early-return accordingly — hash conflicts stay latched until the user resolves; only missing un-latches.
- [ ] `text-card.tsx`: gate the modal missing sheet on `raisedOverCleanBuffer === false`; widen the existing `TugPaneBanner` `visible` condition to cover manual-mode banner verdicts. The banner already carries the "File deleted" copy with `Save As…` and `Close`; it remains the card's ONE banner.
- [ ] `presentConflictSheet` gains `opts?: {defaultChoice?: ConflictSheetChoice}`; the `resolveMissing`-409 call site passes `"reload"`; all other call sites unchanged.
- [ ] Ensure a live sheet is dismissed when the store clears its verdict — a cleared verdict behind a stale modal is exactly the silent dead-end [L31] forbids. Verify the existing single-flight presentation effect covers it; wire it if not.

**Tests:**
- [ ] Store-substrate: a verdict raised over a clean buffer keeps `raisedOverCleanBuffer === true` after `noteEdit()` flips the buffer dirty (the pinned `a missing conflict on a clean buffer goes dirty on the next edit` behavior must stay green).
- [ ] Store-substrate: the file reappears → the verdict clears without any user action.
- [ ] App-test scenario (Step 3 file): delete the bound file, wait past the settle window for the banner, recreate it externally, assert the banner clears with no gesture.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test tests/app-test/atNNNN-text-card-join-replace.test.ts`

---

#### Step 8: Integration checkpoint {#step-8}

**Depends on:** #step-3, #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** [P01]–[P07], (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Verify all artifacts from Steps 1–7 work together: full Rust suite, tugdeck build, tugdeck unit tests, and the derived app-test selection over the whole working diff.

**Tests:**
- [ ] `at0209` (existing external-edit conflict + reload scenarios) green — drift prevention.
- [ ] The full existing `text-card-store.manual.test.ts` suite green — drift prevention.
- [ ] The join-replace app-test green across all its scenarios.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bun test src/lib`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Text cards survive joins, checkouts, and their own atomic saves without false "File Deleted" dialogs; renames follow by file identity; dash-worktree files re-anchor to their repo-root successors; and the remaining genuine verdicts match their actual risk and clear themselves when the file returns.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] A squash-merge under a clean open card produces no dialog and shows the joined content (app-test Scenario 1, positively asserted).
- [ ] The same under a dirty card raises hash adjudication, never "deleted" (Scenario 2).
- [ ] A save landing in git's unlink window resolves to a conflict, not a missing verdict (store test).
- [ ] A true delete still verdicts after the settle window, and the verdict clears on reappearance.
- [ ] A move-plus-edit rebinds silently by inode identity (Step 5 tests).
- [ ] A joined dash's file re-anchors to the repo-root successor with no dialog (Step 6 scenario).
- [ ] A verdict raised over a clean buffer never becomes a modal, even after the user types (Spec S03 test).
- [ ] `dashSuccessorPath` unit tests and `deduplicate_batch` unit tests green, including the directory carve-out.
- [ ] `cargo nextest run`, `bun test src/lib`, `bunx vite build`, `just app-test-changed` all green.

**Acceptance tests:**
- [ ] `just app-test tests/app-test/atNNNN-text-card-join-replace.test.ts`
- [ ] `just app-test tests/app-test/at0209-text-card-live-autosave.test.ts`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] [Q01] Server-side locate-by-inode over the workspace index, for moves with no usable event pair.
- [ ] `(dev, ino)` on the `/api/fs/write` response so `_heldIdentity` never goes stale between writes.
- [ ] Out-of-workspace move following (today: settle window → missing flow, `recheckOnActivation` backstop).

| Checkpoint | Verification |
|------------|--------------|
| Watcher collapse | `cargo nextest run -p tugcast` |
| Store ladder + settle + write-side | `bun test src/lib` |
| Reported bug fixed | join-replace app-test Scenarios 1–2 |
| Identity adoption | Step 5 store tests |
| Dash re-anchor | `dashSuccessorPath` units + join-replace scenario |
| No drift | `at0209` green, full manual-mode store suite green, `just app-test-changed` green |
