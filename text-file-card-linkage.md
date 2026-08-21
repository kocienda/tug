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

### Phase Overview {#phase-overview}

#### Context {#context}

Whenever the user joins a dash, Text cards on files the join touched raise the modal "File Deleted — '<name>' was deleted by another application" sheet. The file was never deleted: git replaces a worktree file by unlinking and recreating it, and FSEvents (via `notify` v8) reports that as a coalesced batch of `Remove(File)` + `Create(File)` + `Modify(Metadata)` + `Modify(Data)` for the **same path**. This was reproduced directly with a `notify` v8 probe watching a scratch repo during `git merge --squash` — the exact call `join_in` makes on the main worktree (`tugrust/crates/tugdash-core/src/ops.rs`, the squash arm of `join_in_with_progress`).

The failure chain has three links, each individually defective:

1. **The watcher erases the truth.** `deduplicate_batch` (`tugrust/crates/tugcast/src/feeds/file_watcher.rs`) drops every `Modified` event whose path also carries a `Created` or `Removed` in the same batch — so the one event that says "this file's content changed" never reaches the client. The frame arrives as `[Removed{p}, Created{p}]`.
2. **The client never checks existence.** `_onFilesystemFrame` in `tugdeck/src/lib/text-card-store.ts` sees a `Removed` for its own path and goes straight to `_tryAdoptRemovedRename`, which decides identity **by content hash**: it reads each `Created` candidate and compares its sha256 to `_baselineSha256`. A join changes the content, so no candidate matches — and the code concludes the file is gone without ever probing whether its own path still exists.
3. **The verdict is a modal with dangerous defaults.** The missing sheet's default button is "Save" (recreate from buffer); when the file actually exists, that write 409s into the conflict sheet whose default is "Save Anyway". During a join the buffer is typically clean and equal to the *pre-join* bytes, so pressing the two defaults silently reverts the join in that file.

Three adjacent defects ride along: the rename-follow branches in `_onFilesystemFrame` run **before** the `saveState === "writing"` guard, so the card's own atomic save (temp + rename in `/api/fs/write`) can raise the same false verdict; a raised conflict latches (`if (snap.conflict !== null) return;`) so the card ignores the file coming back; and a **clean** buffer gets a modal claiming unsaved changes are at risk. Finally, when a join removes the dash worktree (`remove_dash_worktree`, `ops.rs`), cards on files *inside* the dash see a genuinely-gone path — but the file's successor sits at `<repo_root>/<same rel path>`, and the current sheet doesn't know that.

#### Strategy {#strategy}

- **Fix the lie at the source first.** Collapse same-path `Removed`+`Created` into `Modified` inside the watcher's batch dedup — that is what actually happened on disk, and it corrects every consumer (Text cards, FileTreeFeed, git_watch) in one move.
- **Then make the client's verdict evidence-based.** Before declaring a file missing, probe the card's own path; a replace-in-place routes to the ordinary external-change path (clean → silent reload, dirty → hash conflict). This holds even when `Removed` and `Created` straddle two debounce batches, which the watcher fix alone cannot guarantee.
- **Give a `Removed` a settle window.** Never render a "missing" verdict synchronously from one frame; arm a short timer, re-probe, and only then decide. Large checkouts take longer than one 100 ms debounce window.
- **Upgrade rename-following from content-hash identity to inode identity**, with the hash as fallback — moves-with-edits follow correctly, and two identical files never mis-bind.
- **Teach the card the dash lifecycle.** A path under `<workspaceRoot>/.tug/worktrees/<name>/<rel>` whose worktree vanishes has a knowable successor at `<workspaceRoot>/<rel>`; re-anchor there instead of claiming deletion.
- **Right-size the UX last.** Modal only when unsaved edits are genuinely at risk; un-latch a missing verdict when the file reappears; remove the destructive-default chain.
- Sequence Rust-first, then store, then UI, so each layer's tests gate the next.

#### Success Criteria (Measurable) {#success-criteria}

- Running a real `git merge --squash` under an open, clean Text card produces **no sheet and no banner**; the editor silently shows the joined content (app-test asserts absence of the sheet and presence of the new content).
- The same scenario with a **dirty** card raises the hash-**conflict** adjudication (never the missing/"deleted" verdict) — asserted by app-test.
- A true external delete still raises the missing verdict after the settle window (store-level behavior preserved; covered by test).
- A file renamed on disk under a card rebinds silently to the new path even when its content was also edited in the same batch (inode identity; covered by test).
- `deduplicate_batch` unit tests prove `[Removed{p}, Created{p}, Modified{p}]` → `[Modified{p}]` and that a genuine rename pair `[Removed{a}, Created{b}]` is left intact.
- After a dash join removes `.tug/worktrees/<name>/`, a clean card on a file inside it re-anchors to the repo-root successor path without any dialog (covered by test).
- `cd tugrust && cargo nextest run` green; `cd tugdeck && bunx vite build` green; `just app-test-changed` green.

#### Scope {#scope}

1. Watcher batch semantics: same-path remove+create collapse (`file_watcher.rs`).
2. `TextCardStore` filesystem-frame handling: guard ordering, existence-before-verdict, settle window, un-latch.
3. File identity plumbing: `dev`/`ino` in `/api/fs/read` and `/api/fs/stat` responses, client types, identity-first rename adoption.
4. Dash-worktree retirement re-anchor in the store.
5. Sheet modality, copy, and defaults in `text-card.tsx` / `text-card-save-sheets.tsx`.
6. Tests at every layer, including one end-to-end app-test that runs a real squash-merge under an open card.

#### Non-goals (Explicitly out of scope) {#non-goals}

- A server-side locate-by-inode endpoint (search the FileTreeFeed index for a held `(dev, ino)` to follow moves the watcher never paired). Valuable, but it needs per-workspace index plumbing into an HTTP handler; deferred to follow-ons (#roadmap).
- Any change to the autosave write path, hash-conditioning, or aside (crash-safety) machinery — those are correct and untouched.
- Changes to FileTreeFeed's own remove/insert handling beyond what the collapsed event stream implies (it handles `Modified` as a no-op already, which is correct for a replace-in-place).
- Following moves of files **outside** all workspace roots (unchanged: `recheckOnActivation` backstop plus the missing sheet).
- Legacy dash worktree homes (`.tugtree/tugdash__<name>`) in the re-anchor path-shape check — see [P05].

#### Dependencies / Prerequisites {#dependencies}

- `notify` v8 (already the workspace dependency, `tugrust/Cargo.toml`).
- No protocol/schema version bumps: `FsEvent` wire shape is unchanged; `/api/fs/read` and `/api/fs/stat` gain **additive** JSON fields only.
- Rust changes to tugcast require `just build-app` before app-tests exercise them (the app-test recipe refreshes `dist` but never rebuilds the binary).

#### Constraints {#constraints}

- Warnings are errors in the Rust workspace (`-D warnings`).
- tugdeck laws apply: external state enters React via `useSyncExternalStore` only [L02]; the store snapshot remains the single source the card renders from.
- App-tests: selective runs via `just app-test-changed`; every new test carries `@covers` lines; never pipe app-test output.
- No `localStorage`; no new persistent client state is introduced by this plan.

#### Assumptions {#assumptions}

- macOS FSEvents coalescing behavior as measured: git's replace-in-place arrives as same-path `Remove`+`Create`(+`Modify`) in one `notify` batch *most* of the time, but the design must not depend on single-batch delivery (hence the existence probe and settle window).
- `stat`'s `(dev, ino)` pair is a stable file identity across a rename on the same volume (true on APFS; a cross-volume move changes both and falls back to the hash match, then the missing flow — acceptable).
- Dash worktrees live at `<repo>/.tug/worktrees/<name>` (`worktree_path` / `new_worktree_path` in `tugrust/crates/tugdash-core/src/ops.rs`), i.e. **inside** the watched workspace root, so their file events already flow to the client (the watcher does not gitignore-filter events — see the header comment in `file_watcher.rs`).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings, `[P##]` plan-local decisions, `[Q##]` open questions, `Spec S##`, `Risk R##`, and `**References:**`/`**Depends on:**` lines on every execution step, per `tuglaws/devise-skeleton.md`. Global design decisions are cited as `[D##]`; tuglaws as `[L##]`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Server-side locate-by-inode for unpaired moves (OPEN) {#q01-locate-by-inode}

**Question:** Should tugcast grow an endpoint that, given a held `(dev, ino)`, searches the workspace file index and returns the file's current path — so a card can follow a move that produced no usable event pair (e.g. moved out and back over minutes, or events dropped in a rescan)?

**Why it matters:** It is the only mechanism that follows a move with **zero** reliance on event pairing. Without it, an unpaired out-of-batch move of a *dirty* card's file still ends at the missing sheet.

**Options (if known):**
- Extend `POST /api/fs/stat` with a `locate: {dev, ino}` mode that walks the workspace index.
- A dedicated `POST /api/fs/locate` handler with access to the per-workspace `FileTreeFeed` set.
- Do nothing; the settle window + existence probe covers the observed failure modes.

**Plan to resolve:** Ship this plan, then measure whether any missing-sheet reports survive. Revisit in a follow-on if they do.

**Resolution:** DEFERRED — the observed failures are all replace-in-place or same-batch renames, which Steps 1–4 close without new server surface. Tracked in #roadmap.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Collapsing remove+create hides a true delete-then-recreate-with-different-content from some consumer | low | low | The collapse emits `Modified`, which every consumer treats as "content changed at this path" — the correct reading; Text cards re-read and hash-compare anyway | A consumer found relying on Removed/Created pairs for same-path replace |
| Settle-window timer interacts with card dispose | med | low | Timer handle cleared in `dispose()`; all async continuations already guard on `_disposed` and path identity — new code follows the same pattern | Flaky store test |
| Inode reuse mis-binds a rename candidate | low | low | Identity match requires same `dev` **and** `ino` from a candidate named in the same event batch; hash fallback unchanged; ambiguity still falls to the missing flow, never a wrong rebind | A reproduced mis-bind |
| Changing sheet defaults surprises muscle memory | low | med | Only the *missing→409→conflict* chain changes default (to "Reload from Disk"); the plain external-edit conflict sheet keeps "Save Anyway" as default | User feedback |

**Risk R01: Two-batch straddle** {#r01-two-batch-straddle}

- **Risk:** A slow checkout delivers `Removed{p}` in one debounce batch and `Created{p}` in the next, so the watcher-level collapse (Step 1) never sees the pair.
- **Mitigation:** Step 2's existence probe + settle window decides from disk state, not event pairing; by the time the settle window re-probes, the file is back.
- **Residual risk:** A checkout stalled longer than the settle window on exactly the probed path still raises the (now non-modal for clean buffers) verdict; the un-latch (Step 6) clears it when the file lands.

**Risk R02: Own-write echo classified as external** {#r02-own-write-echo}

- **Risk:** Reordering the writing guard ahead of the rename branches could make the card miss a genuine external rename that occurs during its own write.
- **Mitigation:** The writing guard path already sets `_recheckQueued`, and the post-write settle re-checks disk; a rename during a write leaves the old path missing at recheck, which then routes through the same existence-probe → adopt → settle machinery (Step 2 factors that routine so both entry points share it).
- **Residual risk:** One extra read round-trip in that rare interleave.

---

### Design Decisions {#design-decisions}

#### [P01] Same-path remove+create collapses to Modified at the watcher (DECIDED) {#p01-collapse-at-watcher}

**Decision:** In `deduplicate_batch` (`tugrust/crates/tugcast/src/feeds/file_watcher.rs`), when one batch contains both `Removed{p}` and `Created{p}` for the same path `p`, replace the pair with a single `Modified{p}` (and keep dropping the now-redundant raw `Modified{p}` duplicates).

**Rationale:**
- The on-disk truth of git's unlink+recreate is "the content at this path changed"; the current dedup *inverts* the truth by dropping the `Modified` and keeping the misleading pair.
- Fixes every consumer at once: Text cards stop seeing phantom deletes; FileTreeFeed stops a pointless evict+reinsert; git_watch is unaffected (it only asks whether a path is under `.git/`).

**Implications:**
- The collapse must **not** touch a genuine rename pair (`Removed{a}` + `Created{b}`, `a ≠ b`) — same-path matching only.
- Unit tests in the existing `mod tests` of `file_watcher.rs` pin both directions.
- The client keeps its Removed-handling (Risk R01: pairs can straddle batches), so this is belt *and* suspenders, not a substitute for Step 2.

#### [P02] Existence before verdict, and the writing guard runs first (DECIDED) {#p02-existence-before-verdict}

**Decision:** Restructure `_onFilesystemFrame` in `tugdeck/src/lib/text-card-store.ts` so that (a) the `saveState === "writing"` echo-guard is evaluated before any rename/removed branch, and (b) a `Removed` (or unpaired absence) for the card's own path first probes the path itself — if it exists, route to the ordinary external-change path (clean → `_recheckDisk`, manual+dirty → `_raiseConflictIfDiverged`), and only if it does not exist proceed to rename adoption and then the settle window.

**Rationale:**
- The root defect: the current code decides "deleted" from an event flag plus a content hash, never asking the one question that matters. `readFileFromDisk` succeeding on our own path *is* the proof of replace-in-place.
- The current branch order lets the card's own atomic save (temp+rename in `/api/fs/write`) enter the rename/missing machinery mid-write, before `_baselineSha256` is updated on settle — a live race behind sporadic non-join dialogs.

**Implications:**
- The Removed-handling becomes an async routine (probe → classify → adopt → settle) shared by the frame handler and the post-write `_recheckQueued` path; all continuations guard on `_disposed` and `_snapshot.path` identity, matching the file's existing async discipline.
- `conflict !== null` no longer unconditionally deafens the handler (see [P06]).

#### [P03] A "missing" verdict requires a settle window (DECIDED) {#p03-settle-window}

**Decision:** The store never sets `conflict: {reason: "missing"}` synchronously from a filesystem frame. An apparent disappearance arms a single-shot settle timer (`MISSING_SETTLE_MS = 500`); on fire, re-probe the path (and any held identity per [P04]); only a still-absent file becomes a missing verdict. A new event for the path, a successful adoption, or `dispose()` cancels the timer.

**Rationale:**
- Checkouts, branch switches, and editors' safe-write dances routinely exceed one 100 ms debounce window; a verdict rendered from a single frame is a guess.
- 500 ms is imperceptible for a *true* delete (the sheet's cost is modal attention, not latency) and generous for a replace.

**Implications:**
- One new private field (timer handle) + constant in `text-card-store.ts`; cleared in `dispose()`.
- Paths that legitimately vanish still reach the missing flow — nothing is silently swallowed (per the errors-never-fail-silently doctrine, the verdict still surfaces; it is just no longer premature).

#### [P04] File identity is `(dev, ino)`, content hash is the fallback (DECIDED) {#p04-inode-identity}

**Decision:** `/api/fs/read` and `/api/fs/stat` responses gain additive `dev` and `ino` fields (from `std::os::unix::fs::MetadataExt`; on non-unix, omitted). `TextCardStore` records the identity at open/save-settle. `_tryAdoptRemovedRename` matches candidates identity-first (same `dev`+`ino`), falling back to the existing sha256 match, then to the missing flow.

**Rationale:**
- Content-hash identity fails exactly when moves matter most: a move-plus-edit in one batch, and it can mis-bind two identical files (boilerplate, licenses).
- The inode survives a same-volume rename; git's replace-in-place *changes* the inode, which is fine — that case never reaches adoption once [P02] probes existence first.

**Implications:**
- `fs_read.rs::read_file` and `fs_stat.rs::stat_paths` each add two JSON fields; `FileReadResult` in `tugdeck/src/lib/file-io.ts` and the stat client (`tugdeck/src/lib/dir-existence.ts` shape stays untouched — the Text card uses `readFileFromDisk` for probes) gain optional `dev?: number; ino?: number`.
- Absent fields (old server, non-unix) degrade gracefully to today's hash behavior — no version coupling.

#### [P05] Dash-worktree retirement re-anchors by path shape (DECIDED) {#p05-dash-reanchor}

**Decision:** When the store's missing-classification routine finds the card's path matches `<root>/.tug/worktrees/<name>/<rel>` (where `<root>` is the frame's `workspace_key`, or is derived by scanning the absolute path for the `/.tug/worktrees/<name>/` segment) and the path is gone, it probes the successor `<root>/<rel>`. Successor exists + buffer clean → adopt via `_adoptRename(successor)` then `_recheckDisk({force: true})` (silent, no prompt). Successor exists + buffer dirty (manual mode) → adopt the path, then raise the **hash conflict** against the successor's bytes — the honest question ("your unsaved edits differ from what joined"), never the "deleted" sheet. Successor absent → the normal missing flow. Legacy `.tugtree/tugdash__<name>/` homes are out of scope: they are migrated on dash access (`migrate_worktrees` in `ops.rs`) and no new cards bind into them.

**Rationale:**
- Join tears down the worktree (`remove_dash_worktree`), so the path is *genuinely* gone — the only case where "missing" is factually true today, and still the wrong answer, because the file's successor is knowable from shape alone.
- Requires zero new server plumbing: `.tug/worktrees/` is a fixed, tugtool-owned convention inside the watched root.

**Implications:**
- A small pure helper `dashSuccessorPath(path: string): string | null` in `text-card-store.ts` (exported for unit testing) encodes the shape rule.
- The dirty-adopt raises `conflict: {reason: "hash", diskSha256}` with the adopted path, so the existing conflict sheet and its resolutions (Reload / Save As / Save Anyway) apply unchanged.

#### [P06] Modality follows risk; verdicts un-latch (DECIDED) {#p06-modality-and-unlatch}

**Decision:** Three UX corrections. (1) In manual mode, a missing verdict on a **clean** buffer renders as the non-modal banner (the same `TextCardBanner` automatic mode uses, with "File deleted" copy and Close / Save As… actions), not the modal sheet; the modal missing sheet is reserved for a **dirty** buffer, where unsaved bytes are genuinely at risk. (2) While `conflict.reason === "missing"`, the frame handler keeps listening for the card's own path: a `Created`/`Modified` for it (or a settle-window re-probe finding it) clears the conflict and routes through the normal external-change path. (3) The conflict sheet presented as the follow-up to `resolveMissing`'s 409 (the missing→Save→file-exists-now chain in `text-card.tsx`) defaults to "Reload from Disk", not "Save Anyway"; `presentConflictSheet` gains an options argument for the default, and the plain external-edit conflict sheet keeps its current default.

**Rationale:**
- A modal about unsaved changes over a clean buffer asserts a falsehood; nothing is at risk.
- The current `if (snap.conflict !== null) return;` latch means Cancel leaves the card deaf to the file returning — the user must resolve a stale question by hand.
- The two-defaults chain (Save → Save Anyway) is a data-loss path that can silently revert a join; after this plan it is rare, but the default should still not be the destructive branch.

**Implications:**
- `text-card.tsx`: the conflict-presentation `useLayoutEffect` gates the modal on `snapshot.saveState !== "clean"` for missing verdicts; the banner branch (already rendered for automatic mode) also renders for manual+clean+missing. Banner visibility/state flows from the store snapshot via `useSyncExternalStore` [L02]; no new React state.
- `text-card-save-sheets.tsx`: `presentConflictSheet(fileName, opts?: {defaultChoice?: ConflictSheetChoice})`.
- Store: clearing a missing conflict on reappearance updates `conflict: null` and then runs the normal recheck — the sheet, if up, is dismissed by the same snapshot-driven effect that raised it (single-flight ref already exists).

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

`_onFilesystemFrame` (`tugdeck/src/lib/text-card-store.ts`) branch order today: (a) explicit `Renamed{from == ours}` → `_adoptRename(to)`; (b) `Removed{ours}` → `_tryAdoptRemovedRename` → hash-match Created candidates → else `conflict: {reason: "missing"}`; then the generic hit test, the `writing` echo-guard (sets `_recheckQueued`, consumed at write settle), the `conflict !== null` latch, and the clean/dirty routing. The blind spot: branch (b) never probes `snap.path` itself. `_adoptRename` (rebind path/fileName, re-key the manual-mode aside) and the hash-conditioned write machinery are correct and are kept as-is. Frame parsing (`parseFilesystemFrame`) and the `workspace_key` splice are also untouched by this plan.

#### Why every consumer tolerates the collapse {#consumer-tolerance}

- `FileTreeFeed::apply_events` treats `Modified` as a no-op ("file saves don't change the file list") — correct for replace-in-place, and strictly better than the current evict+reinsert churn.
- `git_watch::batch_touches_git` matches all event kinds uniformly by path prefix.
- `FilesystemFeed` forwards batches verbatim.
- The Text card store treats `Modified{ours}` as the generic hit → clean reload / dirty adjudication — exactly the desired behavior for a join.

---

### Specification {#specification}

**Spec S01: Removed-path classification ladder (client)** {#s01-classification-ladder}

For a frame event indicating the card's own path was removed (or a settle-window re-probe), the store classifies in strict order:

1. **Echo:** `saveState === "writing"` → set `_recheckQueued`; stop.
2. **Replace-in-place:** `readFileFromDisk(path)` succeeds → clean: `_recheckDisk()`; manual+dirty: `_raiseConflictIfDiverged()`; automatic+dirty: leave to the conditional write. Stop.
3. **Paired rename:** identity-first, hash-fallback adoption over the batch's `Created` candidates ([P04]) → `_adoptRename`. Stop.
4. **Dash retirement:** `dashSuccessorPath(path)` non-null and successor readable ([P05]) → adopt + reload (clean) or adopt + hash conflict (dirty). Stop.
5. **Settle:** arm/refresh the `MISSING_SETTLE_MS` timer ([P03]); on fire, re-run this ladder from rung 2; a second consecutive absence → `conflict: {reason: "missing"}`.

**Spec S02: Additive identity fields (wire)** {#s02-identity-fields}

- `/api/fs/read` 200 body gains `"dev": <u64>, "ino": <u64>`.
- `/api/fs/stat` response gains a top-level `"identity": { <rawPath>: {"dev": <u64>, "ino": <u64>} }` map, populated only for reachable paths.
- Both are additive; no existing field changes. Non-unix builds omit them (`#[cfg(unix)]`).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Settle-timer handle, held identity `(dev, ino)`, `_recheckQueued` extensions | store-internal (non-rendered) | private `TextCardStore` fields | [L02] |
| Missing/conflict verdict + banner variant | external state rendered by React | store snapshot via `useSyncExternalStore` | [L02] |
| Sheet presentation (modal missing/conflict) | derived effect from snapshot | existing `useLayoutEffect` + single-flight ref in `text-card.tsx` | [L03] |
| Banner show/hide | appearance driven by snapshot props | existing `TextCardBanner` `visible` prop | [L06] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files (if any) {#new-files}

| File | Purpose |
|------|---------|
| `tests/app-test/atNNNN-text-card-join-replace.test.ts` | End-to-end: real squash-merge under an open card (allocate the next unused `at` number; `at0460` is free as of this writing) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `deduplicate_batch` | fn (modify) | `tugrust/crates/tugcast/src/feeds/file_watcher.rs` | same-path Removed+Created → Modified ([P01]) |
| `read_file` | fn (modify) | `tugrust/crates/tugcast/src/fs_read.rs` | add `dev`/`ino` (Spec S02) |
| `stat_paths` | fn (modify) | `tugrust/crates/tugcast/src/fs_stat.rs` | add `identity` map (Spec S02) |
| `FileReadResult.dev` / `.ino` | optional fields | `tugdeck/src/lib/file-io.ts` | parsed when present |
| `_onFilesystemFrame` | method (restructure) | `tugdeck/src/lib/text-card-store.ts` | guard order + ladder entry ([P02], Spec S01) |
| `_classifyRemovedPath` | private async method (new) | `tugdeck/src/lib/text-card-store.ts` | rungs 2–5 of Spec S01; shared by frame handler and settle timer |
| `_missingSettleTimer`, `MISSING_SETTLE_MS` | field + const (new) | `tugdeck/src/lib/text-card-store.ts` | [P03]; cleared in `dispose()` |
| `_heldIdentity` | field (new) | `tugdeck/src/lib/text-card-store.ts` | `(dev, ino)` captured at open + write settle ([P04]) |
| `_tryAdoptRemovedRename` | method (modify) | `tugdeck/src/lib/text-card-store.ts` | identity-first candidate match ([P04]) |
| `dashSuccessorPath` | exported fn (new) | `tugdeck/src/lib/text-card-store.ts` | [P05] path-shape rule; pure, unit-testable |
| `presentConflictSheet` | fn (modify) | `tugdeck/src/components/tugways/cards/text-card-save-sheets.tsx` | `defaultChoice` option ([P06]) |
| conflict-presentation effect | modify | `tugdeck/src/components/tugways/cards/text-card.tsx` | clean+missing → banner, dirty → sheet ([P06]) |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | Pin `deduplicate_batch` collapse + rename-pair preservation; `read_file`/`stat_paths` field presence | Steps 1, 3 |
| **Unit (TS)** | `dashSuccessorPath` shape rule | Step 5 |
| **App-test (end-to-end)** | Real squash-merge / rename / delete under a live card; drives real git, real FSEvents, real tugcast, real store | Steps 2, 4, 5, 6 |
| **Drift Prevention** | Existing at0209 scenarios must stay green (external-edit conflict + reload unchanged) | every step's checkpoint |

#### What stays out of tests {#test-non-goals}

- Mock-store or jsdom render tests — banned; every behavioral assertion drives the real app on real files (real-not-fake doctrine).
- Timing-precise assertions on the 500 ms settle window (flake-prone); tests assert outcomes after generous waits, not window edges.
- The `notify` crate's own coalescing behavior — measured once (#measured-event-shape), not re-proven per run.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step below.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Watcher: collapse same-path remove+create to Modified | pending | — |
| #step-2 | Store: guard order, existence probe, settle window | pending | — |
| #step-3 | Identity fields on the fs endpoints | pending | — |
| #step-4 | Identity-first rename adoption | pending | — |
| #step-5 | Dash-worktree retirement re-anchor | pending | — |
| #step-6 | Sheet modality, un-latch, and defaults | pending | — |
| #step-7 | End-to-end join-replace app-test | pending | — |
| #step-8 | Integration checkpoint | pending | — |

#### Step 1: Watcher: collapse same-path remove+create to Modified {#step-1}

**Commit:** `tugcast(file-watcher): a same-path remove+create batch is a content change, not a delete`

**References:** [P01] Collapse at the watcher, (#measured-event-shape, #consumer-tolerance)

**Artifacts:** (what this step produces/changes)
- Modified `deduplicate_batch` in `tugrust/crates/tugcast/src/feeds/file_watcher.rs` + unit tests in its `mod tests`.

**Tasks:**
- [ ] In `deduplicate_batch`, before the existing Modified-drop pass, find every path carrying both a `Removed` and a `Created` in the batch; remove both events and ensure exactly one `Modified{path}` survives for it (synthesize one if the raw batch carried none — metadata-only coalescing can drop it).
- [ ] Preserve batch-relative ordering for untouched events; leave genuine rename pairs (`Removed{a}` + `Created{b}`, `a ≠ b`) and explicit `Renamed` events untouched.
- [ ] Update the function's doc comment to state the collapse rule and why (what the code does — no bug-history narration).

**Tests:**
- [ ] `[Removed{p}, Created{p}, Modified{p}]` → `[Modified{p}]`.
- [ ] `[Removed{p}, Created{p}]` (no raw Modified) → `[Modified{p}]`.
- [ ] `[Removed{a}, Created{b}]` unchanged.
- [ ] Mixed batch: collapse on `p` while an unrelated `Created{q}` and `Renamed{x→y}` pass through.
- [ ] Existing dedup tests stay green.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 2: Store: guard order, existence probe, settle window {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(text-card-store): probe the path before declaring it missing; settle window for removals`

**References:** [P02] Existence before verdict, [P03] Settle window, Spec S01, Risk R01, Risk R02, (#current-client-flow, #state-zone-mapping)

**Artifacts:** (what this step produces/changes)
- Restructured `_onFilesystemFrame`, new `_classifyRemovedPath`, `_missingSettleTimer` + `MISSING_SETTLE_MS` in `tugdeck/src/lib/text-card-store.ts`.

**Tasks:**
- [ ] Move the `saveState === "writing"` echo-guard to the top of `_onFilesystemFrame`: any event hitting the card's path (including `Removed` and `Renamed{from}`) while writing sets `_recheckQueued` and returns.
- [ ] Extract rungs 2–5 of Spec S01 into `_classifyRemovedPath()`: probe own path via `readFileFromDisk`; exists → clean `_recheckDisk()` / manual-dirty `_raiseConflictIfDiverged()` / automatic-dirty no-op; absent → existing `_tryAdoptRemovedRename` candidates; unresolved → arm the settle timer instead of setting the missing conflict.
- [ ] Settle-timer fire re-runs `_classifyRemovedPath`; a second consecutive absence (no adoption, no successor) sets `conflict: {reason: "missing"}`. Any new frame event for the path, a successful adoption, or `dispose()` clears the timer.
- [ ] All new async continuations guard on `this._disposed` and `this._snapshot.path` identity, matching the file's existing pattern.
- [ ] Route the post-write `_recheckQueued` settle path through the same routine when the re-read finds the file absent.

**Tests:**
- [ ] Extend `tests/app-test/at0209-text-card-live-autosave.test.ts` scenario 1 or add a scenario: externally delete the fixture file and assert the missing verdict still arrives (after the settle window) — the true-delete path is preserved.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 3: Identity fields on the fs endpoints {#step-3}

**Commit:** `tugcast(fs): report (dev, ino) file identity from /api/fs/read and /api/fs/stat`

**References:** [P04] Inode identity, Spec S02, (#symbols)

**Artifacts:** (what this step produces/changes)
- `dev`/`ino` in `read_file` (`tugrust/crates/tugcast/src/fs_read.rs`); `identity` map in `stat_paths` (`tugrust/crates/tugcast/src/fs_stat.rs`); optional `dev?`/`ino?` on `FileReadResult` + parsing in `tugdeck/src/lib/file-io.ts`.

**Tasks:**
- [ ] Rust: under `#[cfg(unix)]`, read `MetadataExt::dev()`/`ino()` from the already-fetched `std::fs::Metadata` in both handlers; add the fields per Spec S02.
- [ ] TS: extend `FileReadResult` and `readFileFromDisk`'s response parsing; fields are optional and absent values change nothing downstream.

**Tests:**
- [ ] Rust unit test per handler: response for a real temp file carries `dev`/`ino` matching a direct `std::fs::metadata` read; `identity` omits unreachable paths.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 4: Identity-first rename adoption {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tugdeck(text-card-store): follow renames by file identity, hash as fallback`

**References:** [P04] Inode identity, Spec S01, (#current-client-flow)

**Artifacts:** (what this step produces/changes)
- `_heldIdentity` captured at `openPath` and write settle; identity-first matching in `_tryAdoptRemovedRename` in `tugdeck/src/lib/text-card-store.ts`.

**Tasks:**
- [ ] Capture `(dev, ino)` from every successful `readFileFromDisk`/write-settle re-read into `_heldIdentity` (write settle: the existing `/api/fs/write` response carries no identity — refresh it lazily on the next read, or extend the write response too if trivial; decide in-code, both are additive).
- [ ] In `_tryAdoptRemovedRename`, read each candidate once and match: identity equal → adopt; else sha256 equal → adopt (existing behavior); widen the candidate set from same-basename-else-sole-creation to *all* `Created` events in the batch when an identity is held (identity cannot mis-bind; the hash fallback keeps the current narrow candidate rule).
- [ ] `_adoptRename` refreshes `_heldIdentity` from the adopted read.

**Tests:**
- [ ] App-test (may extend the Step 7 file or at0209): `mv` the bound fixture to a new name **and** append bytes to it before the watcher settles; assert the card rebinds to the new path with no sheet (identity match despite hash divergence).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 5: Dash-worktree retirement re-anchor {#step-5}

**Depends on:** #step-2

**Commit:** `tugdeck(text-card-store): a joined dash's file re-anchors to its repo-root successor`

**References:** [P05] Dash re-anchor, Spec S01, (#assumptions, #symbols)

**Artifacts:** (what this step produces/changes)
- Exported `dashSuccessorPath` helper + rung 4 wiring in `_classifyRemovedPath` in `tugdeck/src/lib/text-card-store.ts`.

**Tasks:**
- [ ] Implement `dashSuccessorPath(path)`: locate the `/.tug/worktrees/<name>/` segment; return the path with `.tug/worktrees/<name>/` excised, else `null`. Pure string logic; no filesystem access.
- [ ] Wire rung 4: successor readable + clean → `_adoptRename(successor)` then `_recheckDisk({force: true})`; successor readable + manual-dirty → `_adoptRename(successor)` then set `conflict: {reason: "hash", diskSha256: <successor sha>}`; successor absent → fall through to rung 5.
- [ ] Automatic-mode dirty: adopt and let the conditional write adjudicate (matches the mode's existing conflict philosophy).

**Tests:**
- [ ] Unit test (`tugdeck` bun test, colocated per repo convention) for `dashSuccessorPath`: worktree path → successor; repo-root path → null; nested `<rel>` with directories preserved.
- [ ] App-test coverage lands in Step 7 (the join scenario exercises this rung when the card fronts a dash-worktree file).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `cd tugdeck && bun test src/lib`

---

#### Step 6: Sheet modality, un-latch, and defaults {#step-6}

**Depends on:** #step-2

**Commit:** `tugdeck(text-card): missing verdicts match their risk — banner when clean, sheet when dirty, and they clear when the file returns`

**References:** [P06] Modality and un-latch, (#state-zone-mapping, #symbols)

**Artifacts:** (what this step produces/changes)
- Modified conflict-presentation effect + banner branch in `tugdeck/src/components/tugways/cards/text-card.tsx`; `defaultChoice` option on `presentConflictSheet` in `tugdeck/src/components/tugways/cards/text-card-save-sheets.tsx`; un-latch handling in `text-card-store.ts`.

**Tasks:**
- [ ] Store: while `conflict?.reason === "missing"`, a frame event for the card's path (Created/Modified, or the collapsed replace) re-probes and, when the file is readable, clears the conflict and routes clean→reload / dirty→hash-adjudication. The frame handler's `conflict !== null` early-return is narrowed accordingly (hash conflicts stay latched until the user resolves — only missing un-latches).
- [ ] `text-card.tsx`: gate the modal missing sheet on `snapshot.saveState !== "clean"`; render the existing banner (with "File deleted" copy and Close / Save As… affordances) for manual+clean+missing. Snapshot-driven only; no new React state.
- [ ] `presentConflictSheet` gains `opts?: {defaultChoice?: ConflictSheetChoice}`; the `resolveMissing`-409 call site passes `"reload"`; all other call sites unchanged.
- [ ] If the sheet is up when the store clears a missing conflict, the presentation effect's single-flight ref path dismisses it (verify the existing snapshot-driven dismissal covers this; wire it if not — a cleared verdict must never leave a stale modal, and never a silent dead-end).

**Tests:**
- [ ] App-test scenario (Step 7 file): delete the bound file, wait past the settle window for the verdict, recreate the file externally, assert the verdict clears without user action.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 7: End-to-end join-replace app-test {#step-7}

**Depends on:** #step-1, #step-2, #step-4, #step-5, #step-6

**Commit:** `app-test(text-card): git replacing a card's file in place is a content change, never a delete dialog`

**References:** [P01]–[P06], Spec S01, (#success-criteria, #test-categories, #new-files)

**Artifacts:** (what this step produces/changes)
- `tests/app-test/atNNNN-text-card-join-replace.test.ts` (next unused number; `at0460` free as of this writing), with `@covers` lines for `tugdeck/src/lib/text-card-store.ts`, `tugdeck/src/lib/file-io.ts`, `tugdeck/src/components/tugways/cards/text-card.tsx`, `tugdeck/src/components/tugways/cards/text-card-save-sheets.tsx`, and `tugrust/crates/tugcast/src/feeds/file_watcher.rs`.

**Tasks:**
- [ ] Model the harness on `at0209-text-card-live-autosave.test.ts`: real temp **git repo** fixture (init, commit a file, branch, diverge), open a Text card on the file.
- [ ] Scenario 1 (clean replace): run a real `git merge --squash <branch>` + commit in the fixture repo; assert no sheet and no banner appear and the editor shows the merged content.
- [ ] Scenario 2 (dirty replace, manual mode): with unsaved edits, run the merge; assert the **hash-conflict** adjudication appears (banner in automatic / sheet in manual), never the "deleted" verdict.
- [ ] Scenario 3 (true delete + return): delete the file; assert the missing verdict arrives; recreate it; assert the verdict clears (Step 6 un-latch).
- [ ] Because Step 1 changed tugcast, run `just build-app` before this test file's first run (app-test refreshes dist, never the binary).

**Tests:**
- [ ] The three scenarios above are the tests.

**Checkpoint:**
- [ ] `just build-app`
- [ ] `just app-test-covers-check`
- [ ] `just app-test tests/app-test/atNNNN-text-card-join-replace.test.ts` (substitute the allocated number)

---

#### Step 8: Integration checkpoint {#step-8}

**Depends on:** #step-3, #step-7

**Commit:** `N/A (verification only)`

**References:** [P01]–[P06], (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Verify all artifacts from Steps 1–7 work together: full Rust suite, tugdeck build, and the derived app-test selection over the whole working diff.

**Tests:**
- [ ] `at0209` (existing external-edit conflict + reload scenarios) green — drift prevention.
- [ ] New join-replace test green.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Text cards survive joins, checkouts, and their own atomic saves without false "File Deleted" dialogs; renames follow by file identity; dash-worktree files re-anchor to their repo-root successors; and the remaining genuine verdicts match their actual risk and clear themselves when the file returns.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] A squash-merge under a clean open card produces no dialog and shows the joined content (app-test Scenario 1).
- [ ] The same under a dirty card raises hash adjudication, never "deleted" (Scenario 2).
- [ ] A true delete still verdicts, and the verdict clears on reappearance (Scenario 3).
- [ ] A move-plus-edit rebinds silently by inode identity (Step 4 test).
- [ ] `dashSuccessorPath` unit tests and `deduplicate_batch` unit tests green.
- [ ] `cargo nextest run`, `bunx vite build`, `just app-test-changed` all green.

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
| Store ladder + settle | join-replace app-test Scenarios 1–3 |
| Identity adoption | move-plus-edit app-test |
| Dash re-anchor | `bun test src/lib` + join-replace app-test |
| No drift | `at0209` green, `just app-test-changed` green |
