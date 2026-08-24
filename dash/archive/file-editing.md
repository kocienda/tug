<!-- devise-skeleton v4 -->

## File Editing — the File card and TugFileEditor {#file-editing}

**Purpose:** Ship a File card: open any text file on disk in a CodeMirror 6 editor inside Tug.app, edit it with live autosave-in-place (the macOS saveless document model — no dirty state, no save prompts), with syntax highlighting, external-change auto-revert, version checkpoints via the macOS revision store, and one-click links from transcript tool calls and file atoms into the editor.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-08 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Tug's Dev card can display file content (the read-only `FileBlock` body kind, backed by `TugCodeView`), and the assistant reads, writes, and edits files constantly — but the user has no way to open, browse, and edit a file inside Tug.app. Every "let me just fix that line" moment forces a context switch to an external editor. The file-editing feature closes that loop: a File card opens a text file from disk, the user edits it in a CM6 surface, and the system keeps disk continuously in sync with the buffer.

The persistence model is deliberately not the 1990s dirty-buffer/Cmd-S model. It follows macOS's saveless document architecture (`NSDocument` `autosavesInPlace`, shipped in 10.7): the document data the user sees in the window is effectively identical to the data on disk at all times; explicit save survives only as "flush now + cut a version"; safety against over-eager writes comes from the system version store (`NSFileVersion` / `.DocumentRevisions-V100`), not from withholding writes. Closing a File card is always safe. Nothing about a file's content is ever persisted in tugbank — tugbank stores card *positions* (path, cursor, scroll), the same split NSDocument makes between the file and its window-restoration state.

#### Strategy {#strategy}

- **Backend first, smallest possible surface:** two loopback HTTP endpoints on tugcast (`/api/fs/read`, `/api/fs/write`) modeled on the existing `fs_complete.rs` / `permissions.rs` handler shapes. No new WebSocket feed family; no tugcode/tugproto changes (file editing must not ride the Claude session).
- **Editor primitive by fork, not by stripping:** `TugFileEditor` forks `TugCodeView` (the read-only CM6 peer primitive that already renders file bytes) and grafts on the write-side machinery from `TugTextEditor` — responder registration, keymap, undo-menu mirroring — with plain-text clipboard (no atom sidecar). `TugTextEditor` itself (~3,100 lines) stays untouched; most of it is prompt-only (atoms, typeahead, attachments, submit).
- **Live autosave as the core loop, not a later refinement:** the debounced write-through engine (`FileEditorStore`) lands in the first integration milestone; everything after (highlighting, links, versions) layers onto a working saveless editor.
- **One `open-file` action, many entry points:** menu bar, `[+]` picker, tool-call headers (`ToolFileRef` is the single component behind Read/Edit/Write/NotebookEdit headers), `FileBlock` headers, and prompt-editor file atoms all dispatch the same action.
- **External-change handling reuses the existing watcher:** tugcast's `FileWatcher`/`FILESYSTEM` feed (0x10) already pushes debounced FSEvents per registered workspace; the frontend filters, it does not build a new watch loop.
- **Versions use the real macOS store:** the Swift host calls `NSFileVersion` on Tug's behalf, so Tug's aggressive writes are as recoverable as TextEdit's.
- Sequencing: core loop (M01) → editor quality + integration links (M02) → versions + drafts (M03).

#### Success Criteria (Measurable) {#success-criteria}

- Open a file by path in a File card; the buffer matches disk bytes exactly (app-test: read a fixture through the card, compare).
- Type into the editor and stop; within the debounce window + 1 s the file on disk contains the edit, written atomically (app-test: poll disk content).
- Kill and relaunch Tug.app; the File card returns on the same file at the same cursor/scroll position, content re-read from disk (app-test against the state-preservation harness).
- Edit the file externally while the card is open and clean; the buffer auto-reverts to disk content without a dialog (app-test with a workspace-registered file).
- Force a write conflict (external write inside the debounce window); the write is rejected by hash mismatch, a non-modal banner appears, and no disk content is silently lost (Rust unit test for the 409; app-test for the banner).
- Click the file ref in a Read/Edit/Write tool-call header; a File card opens on that file (reusing an existing card for the same path) at the relevant line (app-test).
- A `.rs`/`.ts` file renders with Lezer syntax highlighting whose colors come from `--tug7-*` theme tokens and switch live with the theme (visual app-test screenshot per theme budget rules).
- Cmd-S flushes pending edits immediately and deposits an `NSFileVersion` checkpoint; the version appears in the restore sheet (app-test in the macOS host).
- `cd tugrust && cargo nextest run` and `bunx vite build` pass at every step boundary (warnings are errors).

#### Scope {#scope}

1. tugcast HTTP endpoints for reading and atomically writing arbitrary text files (any absolute path, loopback-only, UTF-8).
2. `TugFileEditor` — a read-write CM6 tugways primitive with full responder/menu integration, full-height scrolling, plain-text clipboard.
3. The File card: registration, open-by-path chooser surface, live autosave engine (`FileEditorStore`), position-only state preservation.
4. External-change auto-revert and hash-conflict banner via the FILESYSTEM feed.
5. Lezer syntax highlighting mapped to Tug theme tokens; find UI; line numbers.
6. `open-file` action with all entry points: File ▸ Open (NSOpenPanel), `[+]` picker, `ToolFileRef` headers, `FileBlock` header affordance, file-atom context menu — with jump-to-line where the tool input carries one.
7. SAVE action + Cmd-S (flush + version checkpoint); File menu items with validation.
8. Version checkpoints and restore via `NSFileVersion` through the Swift bridge; a version-list restore sheet.
9. Untitled drafts (autosave-elsewhere under `~/Library/Application Support/Tug/Drafts/`) with Move To promotion.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Binary or non-UTF-8 file editing (structured rejection instead; encoding detection is a follow-on).
- Multi-caret / minimap / IDE features beyond CM6 defaults; LSP anything.
- A Shiki→CM6 highlighting bridge (Lezer decided; Shiki stays where it is, in markdown/diff blocks).
- Apple's Versions browser UI (NSDocument-private); Tug ships a simple version-list sheet.
- Watching files outside registered workspaces (degraded mode: save-time hash check still catches conflicts; see [P04]).
- Editing over the wire for very large files (> 8 MiB read cap in v1; see Spec S01).
- SC/TC CJK, image editing, hex view.

#### Dependencies / Prerequisites {#dependencies}

- tugcast HTTP handler infrastructure (`server.rs::build_app`, loopback guard pattern) — exists.
- `TugCodeView`, `TugTextEditor`, responder chain, action vocabulary — exist.
- `FileWatcher` / FILESYSTEM feed (0x10) — exists; watchers are created per registered workspace (Dev-card session spawn).
- Swift `WKScriptMessageHandler` bridge in `MainWindow.swift` — exists (`choosePath`, `openPath`, `exportSession` are the templates).
- New npm deps: `@codemirror/language`, `@lezer/highlight`, and grammar packages (Step 9). Installed with **bun**, never npm.

#### Constraints {#constraints}

- **Warnings are errors** across the Rust workspace (`tugrust/.cargo/config.toml` sets `-D warnings`).
- Tugdeck changes must pass `bunx vite build` (the debug app loads the production rollup bundle; dev-esbuild-only imports hang the app at splash).
- All tuglaws apply; the plan's State Zone Mapping (#state-zone-mapping) is binding. Key laws: [L01] one root render, [L02] external state via `useSyncExternalStore` only, [L03] `useLayoutEffect` for registrations, [L06] appearance via CSS/DOM.
- No localStorage/sessionStorage/IndexedDB — persistent state goes through tugbank `/api/defaults` (and only *positions*, per [P07]).
- No hand-rolled UI that exists as a Tug\* component; compose the real components (TugAlert, TugSheet, TugListView, …).
- The WS envelope caps payloads at 16 MiB — irrelevant here because content moves over HTTP ([P02]), but it is why HTTP was chosen.
- Editor lines must obey the atom line-height/baseline doctrine only insofar as `TugFileEditor` has no atoms — it uses plain CM6 line metrics.

#### Assumptions {#assumptions}

- `WorkspaceKey` is the canonicalized project-dir path as a string (`tugrust/crates/tugcast/src/feeds/workspace_registry.rs`, `pub struct WorkspaceKey(Arc<str>)`, "Dedup registry of workspace entries keyed by canonical path") — so the frontend can join `workspace_key + "/" + event.path` and compare against a canonicalized open-file path.
- FILESYSTEM frames reach every connected client for every registered workspace (broadcast, no subscription filter) — the File card filters client-side.
- `NSFileVersion.addOfItem(at:withContentsOf:options:)` works for arbitrary (non-NSDocument) processes writing versions for user files. If sandbox/entitlement friction appears, the fallback is a Tug-owned local-history directory (Risk R04).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton v4 conventions: explicit `{#anchor}` on every cited heading, `[P##]` plan-local decisions, `[Q##]` questions, `Spec S##`, `Table T##`, `Risk R##`, `Milestone M##`, `**Depends on:**` lines with `#step-N` anchors, and `**References:**` lines on every step. No line-number citations.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Autosave debounce interval (DECIDED) {#q01-debounce-interval}

**Question:** How long after the last keystroke before the buffer is flushed to disk?

**Why it matters:** Too short → the user's own file watchers (HMR, `cargo watch`) churn on every pause and version/undo granularity gets noisy; too long → larger crash-loss window and staler disk.

**Resolution:** DECIDED (see [P01]) — 1000 ms idle debounce, with hard flush triggers overriding the timer (card deactivation, card/pane close, app deactivation, quit, Cmd-S). Interval lives in one exported constant (`AUTOSAVE_DEBOUNCE_MS` in `file-editor-store.ts`) so it is a one-line tuning knob. This matches VS Code's `afterDelay` default and NSDocument's "often enough and at the correct times" doctrine.

#### [Q02] What happens when the edited file is deleted or renamed on disk? (DECIDED) {#q02-file-deleted}

**Question:** External `Removed`/`Renamed` FSEvents (or ENOENT on write) for the open file — revert to what?

**Why it matters:** Auto-revert semantics assume the file still exists; a naive revert would blank the buffer and autosave would then recreate the file.

**Resolution:** DECIDED — the buffer is preserved, autosave pauses, and the banner (Spec S03 `conflict` state, reason `missing`) offers "Close" in M01; "Save As…" (re-anchor via the NSSavePanel-capable bridge) joins the banner in Step 14, which is where that bridge ships. Tug never silently recreates a deleted file. Rename detection beyond the workspace watcher is out of scope (the write's ENOENT is the universal catch). The buffer content is never discarded until the user chooses — the card simply stops autosaving.

#### [Q03] Draft-file format for untitled buffers (DECIDED) {#q03-draft-format}

**Question:** How are untitled drafts stored under `~/Library/Application Support/Tug/Drafts/`?

**Resolution:** DECIDED — one plain UTF-8 file per draft named `draft-<cardId>.txt`, written by the same `/api/fs/write` path (it is just an absolute path). The card bag records `draftId` instead of `path`. Move To renames by: read draft → write to chosen path → delete draft → card re-anchors. No sidecar metadata file; the bag carries what little there is.

#### [Q04] Does `EditorSettingsStore`-style per-card settings apply to File cards? (DEFERRED) {#q04-editor-settings}

**Question:** Line-wrap toggle, gutter toggle, font size per File card.

**Resolution:** DEFERRED — `TugFileEditor` exposes the same Compartment-based reconfig knobs `TugCodeView` has (lineWrap, lineNumbers), wired to sensible defaults (numbers on, wrap off). A settings surface is a follow-on (#roadmap); the Compartments make it cheap later.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Autosave clobbers content the user wanted (they "just looked", then typed accidentally) | high | low | NSFileVersion checkpoint before first write of a session ([P09]); undo history in-memory; git for repo files | User reports lost content |
| Write-through churns user's build watchers | med | med | 1 s debounce coalescing [Q01]; single exported constant to tune | Complaints about HMR/build churn |
| Lezer grammars bloat the bundle | med | med | Lazy-load grammar modules per language on first open (dynamic `import()`, same convention as WASM crates' lazy-load) | `bunx vite build` bundle-size jump |
| NSFileVersion unavailable/fails outside NSDocument context | med | low | Feature-detect in Swift; on failure, checkpoint silently no-ops and the restore sheet hides (versions are a net, not a gate) | Step 13 spike fails |
| FILESYSTEM events miss files outside workspaces | low | high (by design) | Hash-conditional write is the universal conflict guard; degraded mode documented ([P04]) | Users routinely edit non-workspace files |

**Risk R01: Conflict window during live autosave** {#r01-conflict-window}

- **Risk:** An external writer (including Claude via the Dev card) writes the file inside the debounce window while the user is typing; last-writer-wins would lose one side.
- **Mitigation:** Every write is conditional on `baselineSha256` (Spec S02); mismatch → 409 → banner with explicit user choice; the buffer is never silently replaced while it has unflushed edits.
- **Residual risk:** The user must choose; there is no automatic merge. Acceptable — the window is ~1 s and the choice is explicit.

**Risk R02: Full-file PUT on every autosave is O(file size)** {#r02-write-cost}

- **Risk:** An 8 MiB file rewritten every pause is wasteful.
- **Mitigation:** Debounce coalescing; 8 MiB read cap keeps the ceiling bounded; atomic temp+rename is one syscall-cheap rename after the write.
- **Residual risk:** No delta protocol in v1. Revisit only if profiling shows pain.

**Risk R03: CM6 editable full-height config is new territory in this codebase** {#r03-cm6-fullheight}

- **Risk:** Both existing CM6 surfaces are auto-height (`TugTextEditor`, max-rows cap) or content-sized with host-delegated scroll (`TugCodeView`, `EditorView.scrollHandler`); a scrolling editor pane is a third configuration and may interact badly with card scroll preservation or `keepCaretVisible`.
- **Mitigation:** `TugFileEditor` owns its scroller (standard CM6 `.cm-scroller`), registers `data-tug-scroll-key` for the region, and the card's outer host does not scroll; app-test AT coverage for scroll restore.
- **Residual risk:** Sticky-header-style reveal gotchas don't apply (no stuck headers in the File card).

**Risk R04: revisiond / DocumentRevisions store friction** {#r04-revisiond}

- **Risk:** `NSFileVersion.addOfItem` may fail on some volumes (network mounts, e.g. this repo's `/Users/kocienda/Mounts/u/...`) or for non-document processes.
- **Mitigation:** Step 13 begins with a feasibility spike in the real app; per-write failures are logged (tugDevLogStore, never console.warn) and non-fatal.
- **Residual risk:** Versions silently unavailable on some volumes; the hash-conflict guard and git remain.

---

### Design Decisions {#design-decisions}

#### [P01] Live autosave-in-place; no dirty-buffer model (DECIDED) {#p01-autosave-in-place}

**Decision:** The File card continuously writes the buffer to disk — a 1000 ms idle debounce plus hard flush triggers (card deactivation, card/pane close, app deactivation via the existing Swift `deactivateApp` signal path, quit/`beforeunload`, Cmd-S). There is no dirty dot, no save prompt, and no `confirmClose` on the File card.

**Rationale:**
- Mirrors macOS `NSDocument` `autosavesInPlace`: "the document data users see in an app window is identical to the document data on disk at all times", saved "often enough and at the correct times".
- Eliminates the unsaved-buffer persistence problem entirely — there is never an unsaved buffer to store, so tugbank is never misused for file content.
- Closing a card is always safe; sudden termination loses at most the debounce window.

**Implications:**
- `FileEditorStore` owns the debounce/flush state machine (Spec S03).
- A subtle transient "saving…" indicator is permissible chrome; a dirty dot is not.
- Cmd-S survives as flush + version checkpoint ([P11]), exactly as macOS kept it.

#### [P02] Content moves over loopback HTTP on tugcast, not a WebSocket feed (DECIDED) {#p02-http-transport}

**Decision:** Add `GET /api/fs/read` and `POST /api/fs/write` to tugcast's axum router (`tugrust/crates/tugcast/src/server.rs`, `build_app`). No new FeedId family; tugcode and tugproto are untouched.

**Rationale:**
- Request/response is the natural shape for open and save; the WS envelope's 16 MiB frame cap would force chunking for no benefit.
- The handler pattern exists twice already: `fs_complete.rs` (loopback guard, `Query` extraction, best-effort fs) and `permissions.rs` (the only existing content write-back, scoped to settings.json).
- The codebase already embraces the asymmetry — tugbank defaults are read via the DEFAULTS feed but *written* via HTTP PUT.
- File editing must work with zero Claude sessions; the CODE feeds would couple it to session lifecycle.

**Implications:**
- Push (external-change notification) comes from the existing FILESYSTEM feed ([P04]), not from the new endpoints.
- In dev mode the Vite proxy already forwards `/api` to tugcast (`tugdeck/vite.config.ts`) — no proxy change needed.

#### [P03] Any absolute path; loopback-only; SecretFilter denylist retained (DECIDED) {#p03-any-path}

**Decision:** The endpoints accept any absolute path (canonicalized through `PathResolver`), matching the posture of `fs_complete.rs` and `/api/permissions?cwd=`. Reads and writes of paths matching the `SecretFilter` denylist (`.env`, `*.pem`, `id_rsa*`, `.tugattachignore` patterns — `tugcast/src/feeds/secret_filter.rs`) are refused with `denied`.

**Rationale:**
- User decision: "We must support any path."
- Consistent with the rest of the `/api` surface: the trust boundary is loopback + the local user, not a directory jail.

**Implications:**
- No workspace-root confinement logic; `is_absolute()` rejection for relative paths, mirroring `permissions.rs`.

#### [P04] External change → auto-revert when clean; hash-conditional writes are the universal conflict guard (DECIDED) {#p04-auto-revert}

**Decision:** The File card subscribes to the FILESYSTEM feed (0x10) and filters frames for its file: frames are `{"workspace_key": "<canonical project dir>", "events": [{"kind": "Created"|"Modified"|"Removed"|"Renamed", "path": "<relative>"}]}` (see `tugcast-core/src/types.rs::FsEvent` and the splice tests in `tugcast/src/feeds/filesystem.rs`). On a hit with no unflushed edits, the store re-fetches and reverts the buffer in place, preserving cursor/scroll where the text allows. With unflushed edits, nothing reverts — the next autosave's `baselineSha256` mismatch (409) raises the conflict banner. Files outside any registered workspace get no live events; the hash check on write remains their only (and sufficient) conflict guard.

**Rationale:**
- Mirrors NSDocument file-coordination auto-revert; makes "watch Claude edit the open file live" work by construction.
- Reuses the existing `FileWatcher` (notify/FSEvents, 100 ms debounce) — no new watch infrastructure.

**Implications:**
- Frontend needs a canonical-path comparison; the read response echoes the canonicalized path (Spec S01) so the store compares like with like.
- The conflict banner is a `TugAlert`-composed non-modal strip inside the card, never a blocking dialog.

#### [P05] `TugFileEditor` is a new peer primitive forked from `TugCodeView` (DECIDED) {#p05-fork-code-view}

**Decision:** Build `tugdeck/src/components/tugways/tug-file-editor.tsx` (+ `.css`, + `tug-file-editor/` extension dir) by forking `TugCodeView` and grafting the write-side pieces from `TugTextEditor`'s extension folder: the responder-registration shape (full editing action set with `validateAction` undo/redo depths), keymap, undo-label→Edit-menu mirroring (`undo-labels.ts`), caret/selection layers, native-clipboard bridge (`lib/tug-native-clipboard.ts`) — with **plain-text** clipboard handlers (no atom sidecar), no atoms, no completion, no attachments, no submit/history.

**Rationale:**
- `TugCodeView` is already the "canonical engine for any file-based content" (its own docstring) and mirrors the Compartment reconfig pattern; forking read-only→editable is far smaller than stripping ~3,100 lines of prompt concerns out of `TugTextEditor`.
- Peer-primitive precedent: `TugCodeView` was explicitly built as "a peer primitive, not a flag on tug-text-editor".

**Implications:**
- Third CM6 surface; theming comes free by installing the token-reading theme extension (the `tugTheme`/`tugCodeViewTheme` pattern in `tug-text-editor/theme.ts` — reads `var(--tug7-…)` live, so theme switches propagate without remount).
- Registers CUT/COPY/PASTE/SELECT_ALL/UNDO/REDO (+ FIND, SAVE) via `useOptionalResponder`, else Cmd-A/C/X/V/Z go dead (capture-phase preventDefault pipeline).
- Full-height scrolling config is new (Risk R03); `data-tug-select="custom"` exempts it from SelectionGuard clipping (same as `tug-prompt-input`).

#### [P06] Lezer for syntax highlighting (DECIDED) {#p06-lezer}

**Decision:** Add `@codemirror/language` + `@lezer/highlight` + grammar packages; starter set: `@codemirror/lang-javascript` (covers TS/TSX), `@codemirror/lang-rust`, `@codemirror/lang-python`, `@codemirror/lang-json`, `@codemirror/lang-css`, `@codemirror/lang-html`, `@codemirror/lang-markdown`, and `@codemirror/legacy-modes` (Swift, shell, TOML, YAML). Language chosen by file extension; grammar modules lazy-loaded via dynamic `import()`. A single `HighlightStyle` maps Lezer tags to `--tug7-*` tokens (new token slots if needed, registered across all six theme files and validated with `bun run audit:theme-contrast`).

**Rationale:**
- Lezer is CM6-native and incremental — right for keystroke-latency editing. Shiki (in-repo) is a static tokenizer used for markdown/diff blocks; a Shiki→CM6 decoration bridge would be novel work with worse edit-time behavior.
- User decision: "OK. Lezer. Let's bring on this dependency."

**Implications:**
- Bundle growth mitigated by lazy loading (Risk table); `bunx vite build` is the gate.
- `TugCodeView.language` (currently informational-only) can adopt the same registry later — build the extension-to-language registry as a shared module (`lib/language-registry.ts`).

#### [P07] Card bag stores positions only, never content (DECIDED) {#p07-positions-only}

**Decision:** `bag.content` for a File card is `{ path?, draftId?, anchor: { line, ch }, scrollTop, findQuery? }` (Spec S06). Content always comes from disk on restore.

**Rationale:**
- With [P01], disk is authoritative — there is no unsaved buffer.
- tugbank is a settings/prefs store; file content in it would be a misuse (user decision).

**Implications:**
- Restore = read `/api/fs/read` for `path`, then apply positions; a read failure restores the card in the `missing` banner state, not empty.

#### [P08] One `open-file` action; path-keyed card reuse (DECIDED) {#p08-open-file-action}

**Decision:** A new deck-level action `"open-file"` with payload `{ path: string, line?: number }` (Spec S04), registered in `tugdeck/src/action-dispatch.ts` beside `"show-card"`. The handler scans `deckState.cards` for an existing File card whose bag/store path canonically equals `path`; if found, activate it and jump to `line`; else create one seeded with the path. `DeckManager.addCard` gains an optional initial-content parameter that seeds `cardStateCache` (the `Map<cardId, CardStateBag>` the restore path reads) before the deck-state commit, so the new card mounts with the path already in its bag.

**Rationale:**
- Many entry points (menu, headers, atoms, file blocks) must converge on identical behavior.
- Two cards live-editing the same file would fight through the watcher; reuse is the correct default.

**Implications:**
- `addCard(componentId: string, initialContent?: unknown)` — a minimal, backward-compatible signature change in `deck-manager.ts`.
- The File card is *not* in `SINGLETON_CARDS` — many File cards may exist, one per path.

#### [P09] Version checkpoints via NSFileVersion through the Swift bridge (DECIDED) {#p09-nsfileversion}

**Decision:** Three new `WKScriptMessageHandler` messages in `tugapp/Sources/MainWindow.swift` (registered/removed alongside `choosePath`/`exportSession`): `checkpointVersion { id, path }` → `NSFileVersion.addOfItem`, `listVersions { id, path }` → array of `{ versionId, modificationDate }` from `otherVersionsOfItem`, `restoreVersion { id, path, versionId }` → replace + reply. The frontend checkpoints before the first write of an editing session and on every Cmd-S.

**Rationale:**
- Tug.app is a native host; using the real revision store (`.DocumentRevisions-V100`, managed by `revisiond` — the same store TextEdit uses) beats imitating it.
- Makes aggressive autosave trustworthy: overwrites are never destructive.

**Implications:**
- Restore UI is a Tug sheet (TugSheet + TugListView) — Apple's Versions browser is NSDocument-private.
- Failures are logged and non-fatal (Risk R04); the feature degrades to "no versions", never to "no saving".

#### [P10] Untitled drafts autosave-elsewhere (DECIDED) {#p10-drafts}

**Decision:** A File card created with no path autosaves to `~/Library/Application Support/Tug/Drafts/draft-<cardId>.txt` through the same write endpoint ([Q03]); the analog of `~/Library/Autosave Information`. "Move To…" (NSSavePanel via a `choosePath`-style bridge call with `kind:"save"`) promotes the draft to a real path.

**Rationale:**
- Completes the saveless model: even a never-named scratch buffer survives quit and relaunch.
- `~/Library/Application Support/Tug` is already an additional working directory for the app.

**Implications:**
- The drafts dir is created on demand by the write endpoint's parent-dir handling (Spec S02).

#### [P11] SAVE action + Cmd-S = flush + checkpoint (DECIDED) {#p11-save-action}

**Decision:** Add `SAVE: "save"` to `TUG_ACTIONS` (`tugdeck/src/components/tugways/action-vocabulary.ts`) and a `KeyS`+meta binding in `keybinding-map.ts` with `preventDefaultOnMatch: true` (note: `KeyS`+meta+shift is already taken by `SELECT_ROUTE "$"` — plain meta is free). `TugFileEditor` registers a SAVE handler: flush pending autosave now, then checkpoint a version. `validateAction` enables File ▸ Save only when a File card's editor is first responder.

**Rationale:**
- macOS kept Cmd-S under autosave; muscle memory is respected, semantics upgraded.

**Implications:**
- A File ▸ Save menu item on the Swift side rides the existing menuState wire contract (validation tiers per `tuglaws/menus.md`).

#### [P12] UTF-8 only; structured errors; 8 MiB read cap (DECIDED) {#p12-utf8-only}

**Decision:** `/api/fs/read` rejects non-UTF-8 content with `{ error: "binary" }` and files over 8 MiB with `{ error: "too_large" }`; write accepts UTF-8 strings only (JSON transport guarantees it).

**Rationale:**
- CM6 is a text editor; binary safety-nets belong to a future hex/preview mode.
- 8 MiB is comfortably above source-file sizes while bounding autosave cost (Risk R02).

---

### Deep Dives {#deep-dives}

#### Investigation findings — where everything lives {#investigation-findings}

This section transcribes the codebase findings the steps rely on. All paths repo-relative.

**Backend (tugcast):**
- Routes are declared in `tugrust/crates/tugcast/src/server.rs::build_app` — a plain axum `Router::new().route(...)` chain with `.with_state(router)`, `CorsLayer` allow-any (safe: loopback bind only), and a `ServeDir` fallback for `tugdeck/dist`.
- Handler template: `tugrust/crates/tugcast/src/fs_complete.rs` — `ConnectInfo<SocketAddr>` loopback rejection, `Query<T>` extraction with serde, best-effort fs, `MAX_COMPLETIONS`-style caps, "never file contents" doc discipline.
- Write template: `tugrust/crates/tugcast/src/permissions.rs` — reads and read-modify-writes `.claude/settings*.json` via `std::fs::write`; the new write handler must upgrade this to atomic temp-file-in-same-dir + `rename`.
- Path canonicalization: `tugrust/crates/tugcast/src/path_resolver.rs` (`PathResolver`) — symlinks, macOS firmlinks, APFS synthetic paths. Route all inbound paths through it.
- Secrets: `tugrust/crates/tugcast/src/feeds/secret_filter.rs` — denylist applied today to completion/index results; reuse for read/write refusal ([P03]).
- FSEvents: `tugrust/crates/tugcast/src/feeds/file_watcher.rs` (notify watcher, `DEBOUNCE_MILLIS = 100`, broadcasts `Vec<FsEvent>`); `tugrust/crates/tugcast-core/src/types.rs::FsEvent` serializes as `{"kind":"Modified","path":"src/lib.rs"}` with paths **relative to the watched directory**; `feeds/filesystem.rs` splices `workspace_key` as the first JSON field of each FILESYSTEM frame.
- `WorkspaceKey` (`feeds/workspace_registry.rs`) is the canonicalized project-dir path (`Arc<str>`), created per Dev-card session spawn; no watcher exists for directories with no session.
- tugcode/tugproto: **no changes anywhere in this plan.**

**Frontend (tugdeck):**
- Card registry: `tugdeck/src/card-registry.ts` — `registerCard(registration)`; `CardRegistration` fields used here: `componentId`, `contentFactory: (cardId) => ReactNode`, `defaultMeta { title, icon?, closable? }` (no `confirmClose` for File cards per [P01]), `defaultFeedIds?`, `sizePolicy?`, `category?`, `engineKind: "em"` (card owns focus; `focus-transfer.ts::resolveActivationTarget` then routes activation to `onCardActivated`).
- Registration wiring: `tugdeck/src/main.tsx` — import + call the register fn in the block that registers `hello`/`git`/`dev`/`about`/`settings`, **before** `new DeckManager(...)`. Keep component and register-fn in separate files (the `dev-card.tsx` / `dev-card-registration.tsx` split) for Fast-Refresh hygiene.
- Card creation: `tugdeck/src/deck-manager.ts::addCard(componentId)` mints pane+card ids, clamps preferred size, commits, `scheduleSave()`. Per-card persisted state lives in `cardStateCache: Map<string, CardStateBag>` with accessors near `getCardState`/`setCardState`; the seeding hook for [P08] inserts a bag before the deck-state commit.
- Actions: `tugdeck/src/action-dispatch.ts::registerAction(action, handler)`; the `"show-card"` handler and `SINGLETON_CARDS` set are the model for `"open-file"`.
- State preservation: `tugdeck/src/components/tugways/use-card-state-preservation.tsx` — `useCardStatePreservation<T>({ onSave, onRestore, onCardActivated })`; payload lands in `bag.content`, persisted to tugbank domain `dev.tugtool.deck.cardstate/<cardId>` via `settings-api.ts::putCardState`. Inner scroll regions use `data-tug-scroll-key`.
- Connection: `tugdeck/src/connection.ts::TugConnection.onFrame(feedId, cb)` (replays last cached payload on subscribe); singleton via `tugdeck/src/lib/connection-singleton.ts::getConnection()`. FeedId constants in `tugdeck/src/protocol.ts` (`FILESYSTEM: 0x10` exists; **no frontend consumer of FILESYSTEM exists yet** — the File card's store is the first).
- CM6 surfaces: `tugdeck/src/components/tugways/tug-code-view.tsx` (read-only peer primitive; props `value`, `language` (informational), 1-based `firstLine` gutter offset; delegate with `findNext`/`findPrevious`/`setSearchQuery`; registers only SELECT_ALL/COPY/FIND; installs `@codemirror/search` machinery but routes Cmd-F to the host via `onFindRequested`). `tugdeck/src/components/tugways/tug-text-editor.tsx` + `tug-text-editor/` extension dir (theme.ts, keymap.ts, caret-layer.ts, selection-layer.ts, line-numbers-gutter.ts, state-preservation.ts, undo-labels.ts are the generic modules to lift; atom-*, completion-*, drop-*, argument-hint-* are prompt-only and must NOT come along).
- Clipboard: `tugdeck/src/lib/tug-native-clipboard.ts` — required to avoid WKWebView's paste permission popup.
- Responders: `tugways/use-responder.tsx` (`useOptionalResponder({ id, actions, validateAction, focus })`), `tugways/action-vocabulary.ts` (`TUG_ACTIONS`), `tugways/keybinding-map.ts` (chord table; `preventDefaultOnMatch` keeps CM6's own keymap from seeing the chord).
- Existing CM6 deps in `tugdeck/package.json`: `@codemirror/commands`, `@codemirror/search`, `@codemirror/state`, `@codemirror/view`. **No** `@codemirror/language`, no Lezer packages yet.
- Open-by-path UI: `tugdeck/src/components/tugways/tug-file-chooser.tsx` (`TugFileChooser`, completion-backed path input, used by the Dev card) + `tugdeck/src/lib/fs-complete.ts::fetchPathCompletions(base, partial)`.
- Transcript file references: `tugdeck/src/components/tugways/cards/blocks/tool-file-ref.tsx` (`ToolFileRef { path }` — muted glyph + basename, full path in `title`) is the **single component** used by `read-tool-block.tsx`, `edit-tool-block.tsx`, `write-tool-block.tsx`, `notebook-edit-tool-block.tsx` headers → one edit point for the click/context-menu affordance. `tugdeck/src/components/tugways/body-kinds/file-block.tsx` (`FileBlock`, `FileData { content, filePath, startLine, numLines, totalLines }`) is the read-only body; its header affordances portal via the chrome's actions slot (`block-header.tsx::actionsSlotRef` / `ChromeActionsTargetContext`). Tool blocks register through `cards/dev-assistant-renderer-dispatch.ts::registerToolBlock`.
- File atoms: `tug-text-editor/atom-decoration.ts` renders path-bearing atom chips in the prompt editor; the editor's context menu is `TugEditorContextMenu`.
- Reveal-in-OS: `tugdeck/src/lib/os-open.ts::openPathInOS(path, kind)`.
- Logging: `tugDevLogStore.{debug,info,warn,error}` (TugDevPanel, Opt-Cmd-/), never `console.warn`.

**Swift host (tugapp):**
- `tugapp/Sources/MainWindow.swift` — `WKScriptMessageHandler` bridge: handlers registered by name in `contentController.add(self, name: "...")` (and removed in the teardown block); dispatched in a `switch` on message name. Templates: `"choosePath"` (`{ id, initialPath, kind }` → `NSOpenPanel` → JS callback `onPathChosen(id, path|null)`), `"exportSession"` (frontend-supplied content → `NSSavePanel` → `content.write(to:atomically:encoding:)` → `onExportDone`), `"openPath"`. New handlers for [P09]/[P10] follow this exact shape, including the removeScriptMessageHandler teardown.
- Menu items: `tugapp/Sources/AppDelegate.swift` defines menu items that dispatch IPC actions (e.g. `show-card`); File ▸ Open / Save ride the same path with menuState validation (`tuglaws/menus.md`).

#### End-to-end autosave data flow {#autosave-flow}

1. CM6 `updateListener` (docChanged) → `FileEditorStore.noteEdit()` — arms/pushes the 1000 ms debounce timer; store state → `editing`.
2. Timer fires (or a flush trigger) → store snapshots `view.state.doc.toString()` → `POST /api/fs/write { path, content, baselineSha256 }` → state `writing`.
3. `200 { sha256 }` → baseline updates → state `clean`. `409 { diskSha256 }` → state `conflict` → banner. Network failure → retry with backoff, state `writing` persists, banner after N failures.
4. FILESYSTEM frame for the file while `clean` → `GET /api/fs/read` → if `sha256 != baseline`, replace doc in place (single CM6 transaction, cursor/scroll mapped through `changes`), baseline updates. While `editing`/`writing` → ignore (the conditional write adjudicates).
5. Flush triggers wired via: `useCardStatePreservation.onSave` (card deactivation — flush synchronously via `navigator.sendBeacon`-style keepalive fetch if needed), deck lifecycle delegate `cardWillBeginDestruction`, `visibilitychange`/`pagehide`, and the SAVE action.

#### Transcript-link entry points {#transcript-links}

| Entry point | Component | Affordance | Line info |
|---|---|---|---|
| Read/Edit/Write/NotebookEdit header | `ToolFileRef` | click = `open-file`; right-click menu: Open in Editor / Reveal in Finder | Read: `input.offset`; Edit: locate `old_string` in file (best-effort, else line 1) |
| File body in transcript | `FileBlock` header actions slot | "Open in editor" affordance | `startLine` |
| Prompt file atom | atom context menu (`TugEditorContextMenu` extension point in `tug-text-editor`) | Open in Editor item | — |
| macOS File ▸ Open… | AppDelegate menu → `choosePath` bridge (`kind:"file"`) → `open-file` | — | — |
| `[+]` type picker | File card registration `category` | opens empty card with `TugFileChooser` surface | — |

All converge on the `"open-file"` action (Spec S04). The action must not steal focus rules: card activation follows the normal `engineKind:"em"` path.

---

### Specification {#specification}

**Spec S01: `GET /api/fs/read`** {#s01-fs-read}

Query: `path` (absolute; else 400). Loopback-only (403 otherwise, matching sibling handlers).

Success `200`:
```json
{ "path": "/canonical/resolved/path", "content": "<utf-8 text>", "sha256": "<hex of content bytes>", "size": 1234, "mtimeMs": 1751970000000, "readOnly": false }
```
`path` is the `PathResolver`-canonicalized form (the frontend adopts it as the card's canonical path). `readOnly` reflects a write-permission probe.

Errors (all `200`-with-error-body is NOT used; real status codes): `404 { "error": "not_found" }`, `403 { "error": "denied" }` (secret-filtered or permission), `422 { "error": "binary" }`, `413 { "error": "too_large", "size": n }` (cap 8 MiB), `400 { "error": "bad_path" }`.

**Spec S02: `POST /api/fs/write`** {#s02-fs-write}

Body:
```json
{ "path": "/abs/path", "content": "<utf-8 text>", "baselineSha256": "<hex|null>" }
```
`baselineSha256: null` means "creating a new file" — the write fails `409` if the file already exists. Otherwise the handler reads current bytes, hashes, compares; mismatch → `409 { "error": "conflict", "diskSha256": "<hex>" }`. Match → write to `.<name>.tug-tmp-<pid>` in the same directory, fsync, `rename` over the target (preserving the original's permission bits via a pre-read `metadata().permissions()` + `set_permissions` on the temp), respond `200 { "sha256": "<hex of new content>", "mtimeMs": ... }`. Missing parent directories are created only under the Drafts root ([P10]); elsewhere → `404 { "error": "parent_missing" }`. Target vanished (ENOENT on hash-read) with non-null baseline → `409 { "error": "missing" }` ([Q02]). Same loopback/secret/path guards as S01. fs work in `spawn_blocking`.

**Spec S03: `FileEditorStore` states** {#s03-store-states}

`useSyncExternalStore`-shaped class in `tugdeck/src/lib/file-editor-store.ts`, one instance per File card.

States: `empty` (no path; chooser surface) → `loading` → `ready.clean` | `ready.editing` (debounce armed) | `ready.writing` (flush in flight) | `conflict { reason: "hash" | "missing", diskSha256? }` | `error { kind }` (read failed). A `readOnly` flag (from Spec S01) rides alongside `ready.*`: when set, `noteEdit` never arms the debounce and the editor mounts its readOnly Compartment. Exported constant `AUTOSAVE_DEBOUNCE_MS = 1000`.

Public surface: `openPath(path)`, `noteEdit()`, `flush()` (returns promise; used by SAVE and lifecycle), `resolveConflict("reload" | "overwrite")`, `saveAs(path)`, `snapshotPositions()` / `applyPositions(p)`. External-change input: `onFsEvents(workspaceKey, events)` per [P04].

**Spec S04: `open-file` action** {#s04-open-file}

Action name `"open-file"`, payload `{ path: string, line?: number }`. Behavior per [P08]. Dispatchable from the responder chain (a `TUG_ACTIONS.OPEN_FILE` constant) and from `registerAction` (Swift menu IPC), mirroring how `show-card` is reachable both ways.

**Spec S05: Version bridge messages** {#s05-version-bridge}

`checkpointVersion { id, path }` → JS callback `onVersionCheckpointed(id, ok: boolean)`.
`listVersions { id, path }` → `onVersionsListed(id, [{ versionId, modificationDate }] | null)`.
`restoreVersion { id, path, versionId }` → `onVersionRestored(id, ok: boolean)`; on success the frontend treats it as an external change (re-read + revert).
`versionId` is an opaque string the Swift side derives (persistentIdentifier archived to base64). All three follow the `choosePath` request/callback-with-id shape.

**Spec S06: File-card `bag.content`** {#s06-bag-content}

```json
{ "path": "/canonical/path", "draftId": null, "anchor": { "line": 12, "ch": 4 }, "scrollTop": 340, "findQuery": "" }
```
`path` xor `draftId` ([P10]). Never contains file content ([P07]).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Buffer text, selection, undo history | component-owned (CM6 runtime) | `EditorView` state, not React state | [L02], [L06] |
| Autosave state machine (`clean`/`editing`/`writing`/`conflict`) | local-data | `FileEditorStore` + `useSyncExternalStore` | [L02] |
| Conflict banner visibility | appearance driven by store state | React render from store snapshot; banner is composed `TugAlert` | [L02], [L06] |
| "saving…" transient indicator | appearance | store observer in `useLayoutEffect` drives a DOM class toggle directly — no `useSyncExternalStore` round-trip through render | [L06], [L22] |
| Path / positions across reload | structure (persisted) | `useCardStatePreservation` → `bag.content` → tugbank cardstate | [L23] |
| Editor scroll | structure (persisted) | `data-tug-scroll-key` on the CM6 scroller | [L23] |
| Responder registration | structure | `useOptionalResponder` in `useLayoutEffect` | [L03], [L11] |
| Selection containment | structure | `data-tug-select="custom"` (SelectionGuard exemption) | [L12] |
| FILESYSTEM subscription | local-data | `getConnection().onFrame` wired inside the store, torn down on card destruction | [L02], [L03] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/fs_read.rs` | `GET /api/fs/read` handler (Spec S01) |
| `tugrust/crates/tugcast/src/fs_write.rs` | `POST /api/fs/write` handler (Spec S02) |
| `tugdeck/src/lib/file-io.ts` | Fetch helpers `readFileFromDisk(path)`, `writeFileToDisk(req)` typed against S01/S02 |
| `tugdeck/src/lib/file-editor-store.ts` | Autosave state machine (Spec S03) |
| `tugdeck/src/lib/language-registry.ts` | Extension→lazy Lezer grammar registry + token-mapped `HighlightStyle` |
| `tugdeck/src/components/tugways/tug-file-editor.tsx` / `.css` | The read-write CM6 primitive ([P05]) |
| `tugdeck/src/components/tugways/tug-file-editor/` | Editor extension modules lifted/adapted from `tug-text-editor/` (theme, keymap, plain clipboard) |
| `tugdeck/src/components/tugways/cards/file-card.tsx` / `.css` | Card body: chooser surface / editor / banner |
| `tugdeck/src/components/tugways/cards/file-card-registration.tsx` | `registerFileCard()` (Fast-Refresh split) |
| `tugdeck/src/components/tugways/cards/file-card-versions-sheet.tsx` | Version list + restore (TugSheet + TugListView) |
| `tugdeck/src/lib/version-bridge.ts` | JS side of Spec S05 bridge messages |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `get_fs_read`, `get_fs_write` route lines | fn/route | `tugcast/src/server.rs::build_app` | beside `/api/fs/complete` |
| `TUG_ACTIONS.OPEN_FILE`, `TUG_ACTIONS.SAVE` | const | `tugways/action-vocabulary.ts` | S04, [P11] |
| `KeyS`+meta → SAVE | entry | `tugways/keybinding-map.ts` | `preventDefaultOnMatch: true` |
| `addCard(componentId, initialContent?)` | method | `src/deck-manager.ts` | seeds `cardStateCache` ([P08]) |
| `"open-file"` handler | registerAction | `src/action-dispatch.ts` | [P08] |
| `ToolFileRef` click/context-menu | component | `cards/blocks/tool-file-ref.tsx` | one edit covers 4 tool headers |
| `FileBlock` open-in-editor affordance | component | `body-kinds/file-block.tsx` | via chrome actions slot |
| `checkpointVersion`/`listVersions`/`restoreVersion` cases | Swift handlers | `tugapp/Sources/MainWindow.swift` | S05; register + teardown |
| File ▸ Open…/Save menu items | Swift menu | `tugapp/Sources/AppDelegate.swift` | menuState validation |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/design-decisions.md`: promote the durable decisions (saveless model, HTTP transport, positions-only bags) as global `[D##]` entries at phase close (user's call on wording).
- [ ] Module docstrings carry the contract (per repo convention); no freestanding docs/*.md dropfiles.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Rust unit/integration (`cargo nextest run`)** | Endpoint contracts: canonicalization, secret denial, atomicity (temp+rename observable), hash-conditional 409, binary/too-large rejection, permission preservation | Steps 1–2 |
| **App-tests (`just app-test`)** | Real Tug.app driving real files in a temp fixture dir: open/edit/autosave/relaunch-restore/auto-revert/conflict-banner/link-clicks/Cmd-S | Steps 5–14 |
| **Build gates** | `bunx vite build` after every tugdeck step; `bun run audit:theme-contrast` after token additions | every step |

#### What stays out of tests {#test-non-goals}

- jsdom render tests, mock-store assertions, synthetic fixtures — banned patterns in this repo; app-tests drive the real app on real files instead.
- CM6 internals (Lezer parse correctness, viewport virtualization) — upstream-tested.
- NSFileVersion storage internals — we test the bridge round-trip observable from JS, not revisiond.
- Real-claude flows — file editing has no Claude dependency by design ([P02]).

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Commits land per the repo git policy (user commits, or per authorized skill flow).

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | fs_read endpoint | done | f6063ffc4 |
| #step-2 | fs_write endpoint | done | 2ab33de2e |
| #step-3 | file-io client + FileEditorStore | done | bc8cc65d6 |
| #step-4 | TugFileEditor primitive core | done | bc8cc65d6 (folded with #step-3) |
| #step-5 | TugFileEditor responders, clipboard, SAVE plumbing | done | bc8cc65d6 (folded with #step-3) |
| #step-6 | File card + registration + chooser + preservation | done | 4e1692155 |
| #step-7 | open-file action + addCard seeding | done | 4e1692155 (folded) |
| #step-8 | External change: auto-revert + conflict banner | done | 4e1692155 (folded) |
| #step-9 | Integration checkpoint: core live loop (M01) | done | 50c59e324 |
| #step-10 | Lezer highlighting | done | a5b6cdc43 |
| #step-11 | Find UI + menus (File ▸ Open/Save, Cmd-S) | done | 4e1692155 (Swift compile verified at build) |
| #step-12 | Transcript links (headers, file-block, atoms) | done | 4e1692155 |
| #step-13 | NSFileVersion bridge + versions sheet | done | 4e1692155 (R04 spike at build/iterate) |
| #step-14 | Untitled drafts + Move To | done | ec0f4cd83 |
| #step-15 | Final integration checkpoint (M02+M03) | done | 50c59e324 |

#### Step 1: fs_read endpoint {#step-1}

**Commit:** `Add /api/fs/read: canonicalized UTF-8 file reads over loopback`

**References:** [P02] HTTP transport, [P03] any-path, [P12] UTF-8 only, Spec S01, (#investigation-findings)

**Artifacts:**
- `tugrust/crates/tugcast/src/fs_read.rs`; route in `server.rs::build_app`; `pub(crate) mod fs_read;` wiring.

**Tasks:**
- [ ] Handler per Spec S01: loopback guard (copy `fs_complete.rs`), `Query { path }`, `is_absolute()` check, `PathResolver` canonicalization, `SecretFilter` refusal, `spawn_blocking` read, UTF-8 validation, 8 MiB cap, sha256 (add `sha2` to tugcast's deps if absent — check `Cargo.toml` first), `readOnly` probe.
- [ ] Echo the canonicalized path in the response.

**Tests:**
- [ ] Reads a temp file byte-exact; sha256 matches; canonical path echoed for a symlinked input.
- [ ] 404 missing, 400 relative, 422 binary bytes, 413 over-cap, 403 for `.env`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 2: fs_write endpoint {#step-2}

**Depends on:** #step-1

**Commit:** `Add /api/fs/write: atomic hash-conditional file writes`

**References:** [P02], [P03], Spec S02, Risk R01, (#investigation-findings)

**Artifacts:**
- `tugrust/crates/tugcast/src/fs_write.rs`; route in `server.rs`.

**Tasks:**
- [ ] Handler per Spec S02: JSON body, guards as Step 1, hash-compare against `baselineSha256`, temp-in-same-dir + fsync + rename, permission-bit preservation, Drafts-root parent creation ([P10]) vs `parent_missing`.
- [ ] `null` baseline = create-new semantics; ENOENT-with-baseline → `409 missing` ([Q02]).

**Tests:**
- [ ] Round-trip write→read; concurrent-modification 409 with correct `diskSha256`; mode bits preserved (chmod 600 fixture); no partial file visible on simulated failure (temp name never at target).
- [ ] Create-new success and already-exists 409.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 3: file-io client + FileEditorStore {#step-3}

**Depends on:** #step-2

**Commit:** `Add file-io client and the FileEditorStore autosave engine`

**References:** [P01] autosave-in-place, [P04] auto-revert, [P07] positions-only, Spec S01–S03, [Q01], [Q02], (#autosave-flow, #state-zone-mapping)

**Artifacts:**
- `tugdeck/src/lib/file-io.ts`, `tugdeck/src/lib/file-editor-store.ts`.

**Tasks:**
- [ ] Typed fetch helpers against S01/S02 (same-origin `/api/fs/*`; Vite proxy already covers dev).
- [ ] Store per Spec S03: debounce (`AUTOSAVE_DEBOUNCE_MS`), flush triggers API, retry/backoff on network failure, conflict + missing states, `onFsEvents` filtering (canonical-path join per [P04] and the `WorkspaceKey`-is-canonical-path assumption), FILESYSTEM subscription via `getConnection().onFrame(FeedId.FILESYSTEM, …)` — first frontend consumer of that feed.
- [ ] Log through `tugDevLogStore`, never console.

**Tests:**
- [ ] None standalone (store is exercised end-to-end by Step 9 app-tests; mock-store unit tests are a banned pattern).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 4: TugFileEditor primitive core {#step-4}

**Depends on:** #step-3

**Commit:** `Add TugFileEditor: editable full-height CM6 peer primitive`

**References:** [P05] fork TugCodeView, Risk R03, (#investigation-findings)

**Artifacts:**
- `tugways/tug-file-editor.tsx` + `.css` + `tug-file-editor/` (theme, compartments).

**Tasks:**
- [ ] Fork `tug-code-view.tsx`: drop `EditorState.readOnly`, keep Compartment reconfig (lineWrap, lineNumbers, gutter), lift the token-reading theme (pattern of `tug-text-editor/theme.ts`), caret/selection layers, line-numbers gutter.
- [ ] Full-height scrolling: editor owns `.cm-scroller` (no host-delegated `scrollHandler`, unlike TugCodeView); `data-tug-scroll-key` on the scroller; `keepCaretVisible`.
- [ ] `data-tug-select="custom"` on the root; StrictMode-safe mount via `useLayoutEffect`.
- [ ] Props: `store: FileEditorStore` (doc seeded from store, `updateListener` → `noteEdit`), `onReady(view)`.

**Tests:**
- [ ] Deferred to Step 9 app-tests (real-render coverage).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] Gallery smoke: temporary gallery registration renders and accepts typing (manual, HMR)

---

#### Step 5: TugFileEditor responders, clipboard, SAVE plumbing {#step-5}

**Depends on:** #step-4

**Commit:** `Wire TugFileEditor into the responder chain with plain-text clipboard`

**References:** [P05], [P11] SAVE action, Spec S04 (constant only), (#investigation-findings)

**Artifacts:**
- Responder registration in `tug-file-editor.tsx`; `TUG_ACTIONS.SAVE`; `KeyS`+meta binding; plain clipboard handlers; undo-labels integration.

**Tasks:**
- [ ] Copy `TugTextEditor`'s `useOptionalResponder` registration shape: CUT/COPY/PASTE/PASTE_AS_PLAIN_TEXT/SELECT_ALL/UNDO/REDO/DELETE_*/MOVE_* via `@codemirror/commands`; `validateAction` from live `undoDepth`/`redoDepth`; `focus` → `view.focus()`. Plain-text clipboard via `tug-native-clipboard.ts` — no atom sidecar.
- [ ] FIND registration mirroring TugCodeView (query machinery + host-routed find).
- [ ] Right-click context menu via `useTextSurfaceContextMenu` (the hook `tug-text-editor.tsx` already uses) with the full editable item set — every right-click in the app must produce a Tug menu, never the browser's (card-state-model context-menu hierarchy).
- [ ] Add `TUG_ACTIONS.SAVE`; keybinding-map `KeyS`+meta (`preventDefaultOnMatch: true`; plain-meta is free — meta+shift+S is `SELECT_ROUTE "$"`); SAVE handler = `store.flush()` (version checkpoint attaches in Step 13).
- [ ] `undo-labels.ts` integration so Edit ▸ Undo shows labels.

**Tests:**
- [ ] Deferred to Step 9 app-tests (Cmd-A/C/X/V/Z/S through the real chain).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 6: File card + registration + chooser + preservation {#step-6}

**Depends on:** #step-5

**Commit:** `Add the File card: open by path, edit, live autosave`

**References:** [P01], [P07], Spec S03, S06, (#investigation-findings, #state-zone-mapping)

**Artifacts:**
- `cards/file-card.tsx` + `.css`, `cards/file-card-registration.tsx`, wiring in `main.tsx`.

**Tasks:**
- [ ] Registration: `componentId: "file"`, `engineKind: "em"`, `defaultMeta { title: "File", closable: true }` (no confirmClose), `sizePolicy` (min ~500×300, preferred ~800×600), `category` for the `[+]` picker. Separate registration file (Fast-Refresh split).
- [ ] Body: store-driven — `empty` state renders a `TugFileChooser` open surface (base = `$HOME`); once a file is open, `TugFileEditor` stays mounted and the `error`/`conflict` banner strip (composed `TugAlert`) renders **alongside** it, never in its place. **[L26]:** the body is ONE component branching internally on store state; the editor's key, component type, and renderer reference must be byte-identical across `clean`/`editing`/`writing`/`conflict` — a banner appearing must not remount the editor (that would destroy scroll, selection, and the undo stack at the moment the user must choose "keep mine").
- [ ] Read-only files: consume Spec S01's `readOnly` bit — CM6 readOnly Compartment on, autosave disabled in the store (no debounce arming), a quiet read-only indicator in the card chrome; SAVE's `validateAction` reports disabled.
- [ ] `useCardStatePreservation`: `onSave` is **synchronous** — it returns `snapshotPositions()` (S06 bag) and *initiates* the flush (keepalive fetch, fire-and-forget); it cannot await it. `onRestore` → `openPath` + `applyPositions`; `onCardActivated` → editor focus.
- [ ] Title sync to basename: verify `deck-manager.ts` exposes a card-meta/title update path (none was confirmed during planning) — if absent, add a minimal `updateCardTitle(cardId, title)` that commits and `scheduleSave()`s, following the existing deck-state commit pattern.
- [ ] Lifecycle flushes: `cardWillBeginDestruction` delegate, `pagehide`/`visibilitychange` (keepalive fetch for the final flush).

**Tests:**
- [ ] Deferred to Step 9 (integration).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] Manual: `[+]` → File → choose a path → edit → observe disk update

---

#### Step 7: open-file action + addCard seeding {#step-7}

**Depends on:** #step-6

**Commit:** `Add the open-file action with path-keyed File-card reuse`

**References:** [P08], Spec S04, (#transcript-links, #investigation-findings)

**Artifacts:**
- `addCard(componentId, initialContent?)` in `deck-manager.ts`; `"open-file"` in `action-dispatch.ts`; `TUG_ACTIONS.OPEN_FILE`.

**Tasks:**
- [ ] Extend `addCard` to seed `cardStateCache` with `{ content: initialContent }` before the deck-state commit (verify the restore path reads the cache for freshly minted ids; adjust seeding point if `CardHost` reads elsewhere).
- [ ] `"open-file"` handler per [P08]: canonical-path match against live File-card stores/bags → activate + `revealLine(line)`, else `addCard("file", { path, anchor: { line, ch: 0 } })`.
- [ ] Expose jump-to-line on the store/editor (`revealLine` centers the line, clearing any stuck chrome).

**Tests:**
- [ ] Deferred to Step 9 / Step 12 app-tests.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 8: External change — auto-revert + conflict banner {#step-8}

**Depends on:** #step-6

**Commit:** `Auto-revert clean File cards on external change; banner on conflict`

**References:** [P04], Risk R01, [Q02], Spec S02, S03, (#autosave-flow)

**Artifacts:**
- FILESYSTEM wiring live in the store (Step 3 built it); banner UI in `file-card.tsx`; revert transaction in `tug-file-editor`.

**Tasks:**
- [ ] Revert-in-place: single CM6 transaction replacing the doc, cursor/scroll preserved via change mapping; store baseline updates.
- [ ] Conflict banner (hash + missing variants): hash → "Reload from disk" / "Keep mine (overwrite)"; missing → "Close" only in M01 (the buffer is preserved and autosave paused until the user chooses — [Q02]; "Save As…" joins this banner in Step 14 when the NSSavePanel bridge ships). Overwrite = write with `baselineSha256` set to the 409's `diskSha256`.
- [ ] Ensure revert never fires while `editing`/`writing`.

**Tests:**
- [ ] Deferred to Step 9.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 9: Integration checkpoint — core live loop (M01) {#step-9}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7, #step-8

**Commit:** `N/A (verification only — app-tests land here)` — **Milestone M01** {#m01-core-loop}

**References:** [P01]–[P08], [P11], [P12], Spec S01–S04, S06, (#success-criteria)

**Artifacts:**
- App-tests under `tests/` covering the core loop (new AT tags per `tuglaws/app-test-inventory.md`, append-only).

**Tasks:**
- [ ] App-tests on real temp fixture files: open→byte-exact; type→disk updated within debounce+1 s; relaunch→same file/cursor/scroll; external edit (workspace-registered fixture)→auto-revert; conflict→banner, no silent loss; Cmd-A/C/V/Z/S through the chain; close+reopen card.
- [ ] Fix everything the harness surfaces (including pre-existing issues it trips over).

**Tests:**
- [ ] The app-tests above.

**Checkpoint:**
- [ ] `just app-test`
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 10: Lezer highlighting {#step-10}

**Depends on:** #step-9

**Commit:** `Add Lezer syntax highlighting mapped to theme tokens`

**References:** [P06], Risk table (bundle), (#investigation-findings)

**Artifacts:**
- `lib/language-registry.ts`; deps added with bun; token additions across all six theme files if new slots are needed.

**Tasks:**
- [ ] `bun add @codemirror/language @lezer/highlight @codemirror/lang-{javascript,rust,python,json,css,html,markdown} @codemirror/legacy-modes`.
- [ ] Registry: extension→`() => import(...)` lazy grammar map; `syntaxHighlighting(HighlightStyle.define([...]))` reading `--tug7-*` vars (follow the theme-engine doctrine; validate with `bun run audit:theme-contrast` if tokens are added).
- [ ] Wire into `TugFileEditor` via a language Compartment swapped when the grammar module resolves; plain text until then.

**Tests:**
- [ ] App-test: open `.rs` and `.ts` fixtures, screenshot-assert highlighted tokens differ from plain text; theme switch re-colors without remount.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build` (watch bundle: grammars must be split chunks)
- [ ] `bun run audit:theme-contrast` (if tokens added)
- [ ] `just app-test`

---

#### Step 11: Find UI + menus (File ▸ Open/Save, Cmd-S) {#step-11}

**Depends on:** #step-9

**Commit:** `File-card find bar and File menu Open/Save integration`

**References:** [P11], Spec S04, (#transcript-links, #investigation-findings)

**Artifacts:**
- Find bar in `file-card.tsx` (host-rendered, driven by the editor delegate's `setSearchQuery`/`findNext`/`findPrevious`, mirroring how `FileBlock`/TugCodeView route FIND); Swift menu items.

**Tasks:**
- [ ] Cmd-F → FIND responder → card shows the find bar; Cmd-G/shift-Cmd-G already map to FIND_NEXT/FIND_PREVIOUS.
- [ ] AppDelegate: File ▸ Open… → `choosePath` (`kind:"file"`) → dispatch `open-file`; File ▸ Save menu item dispatching SAVE with menuState validation (enabled only when a File editor is first responder), per `tuglaws/menus.md` and the promoted-chord rule.

**Tests:**
- [ ] App-test: Cmd-F find and navigate; File ▸ Open opens the chosen file (harness fidelity permitting — NSOpenPanel may need the test-mode path used by existing panel flows; follow `exportSession` test precedent).

**Checkpoint:**
- [ ] `just app-test`; Swift build via the normal app build path

---

#### Step 12: Transcript links {#step-12}

**Depends on:** #step-9

**Commit:** `Open-in-editor links from tool headers, file blocks, and file atoms`

**References:** [P08], Spec S04, Table in (#transcript-links), (#investigation-findings)

**Artifacts:**
- `ToolFileRef` affordance; `FileBlock` header action; atom context-menu item.

**Tasks:**
- [ ] `ToolFileRef`: click dispatches `open-file` (with line from tool input where the wrapper passes it — Read `offset`; Edit best-effort locate of `old_string` post-result); right-click `TugEditorContextMenu` with Open in Editor / Reveal in Finder (`openPathInOS`). Respect chrome focus rules (`data-tug-focus="refuse"` so the click doesn't steal first responder before the action lands — verify against the mousedown-focus doctrine).
- [ ] Wrappers (`read-`, `edit-`, `write-`, `notebook-edit-tool-block.tsx`) pass their line info to `ToolFileRef` via a new optional prop.
- [ ] `FileBlock` header: "Open in editor" in the chrome actions slot (portal via `actionsSlotRef`), payload `{ filePath, startLine }`.
- [ ] File atoms: add an "Open in Editor" item to the prompt editor's context menu via `useTextSurfaceContextMenu` (the hook `tug-text-editor.tsx` wires its `TugEditorContextMenu` through), shown conditionally when the right-click target is a path-bearing atom (`atom-decoration.ts` chips carry the path).

**Tests:**
- [ ] App-test: drive a real Read tool call (existing harness fixtures), click the header ref, assert a File card opens on that path at the expected line; second click reuses the same card.

**Checkpoint:**
- [ ] `just app-test`; `cd tugdeck && bunx vite build`

---

#### Step 13: NSFileVersion bridge + versions sheet {#step-13}

**Depends on:** #step-9

**Commit:** `Version checkpoints via NSFileVersion with a restore sheet`

**References:** [P09], Spec S05, Risk R04, (#investigation-findings)

**Artifacts:**
- Swift handlers in `MainWindow.swift`; `lib/version-bridge.ts`; `cards/file-card-versions-sheet.tsx`; checkpoint hooks in the store.

**Tasks:**
- [ ] **Spike first:** verify `NSFileVersion.addOfItem` works from Tug.app for a plain file on the boot volume and on a network mount; record the result in this plan (flip Risk R04 residual).
- [ ] Swift: three handlers per Spec S05, registered + torn down like `choosePath`; `versionId` = archived persistentIdentifier, base64.
- [ ] Store: checkpoint before the first successful write of an editing session and on SAVE; failures logged, non-fatal.
- [ ] Sheet: TugSheet + TugListView of versions (date-formatted), Restore button → `restoreVersion` → treat success as external change (re-read + revert). Entry point: a quiet card-chrome affordance (e.g. title-area menu "Browse Versions…").

**Tests:**
- [ ] App-test (macOS host): edit → Cmd-S ×2 → versions list shows ≥2 entries → restore older → buffer matches older content.

**Checkpoint:**
- [ ] `just app-test`

---

#### Step 14: Untitled drafts + Move To {#step-14}

**Depends on:** #step-9

**Commit:** `Untitled File cards autosave as drafts with Move To promotion`

**References:** [P10], [Q02] (Save As joins the missing banner here), [Q03], Spec S02 (Drafts parent creation), S06, (#investigation-findings)

**Artifacts:**
- "New File" path in the card's empty state; draft handling in the store; Move To flow.

**Tasks:**
- [ ] Empty-state "New untitled file" → store enters draft mode (`draftId = cardId`), autosaves to the Drafts path; title "Untitled".
- [ ] Move To…: NSSavePanel via a save-kind bridge call (extend `choosePath` with `kind:"save"` or add a sibling handler — follow whichever the Swift code accommodates more cleanly), then read-draft→write-target→delete-draft→re-anchor ([Q03]).
- [ ] Wire "Save As…" into the missing-file conflict banner (Step 8 shipped it Close-only per [Q02]) using the same save-kind bridge: chosen path → write buffer with `baselineSha256: null` semantics adjusted for create-new → card re-anchors.
- [ ] Draft GC: on card destruction with an empty draft, delete the draft file.

**Tests:**
- [ ] App-test: new untitled → type → relaunch → content back; Move To → file at target, draft gone, card re-anchored.

**Checkpoint:**
- [ ] `just app-test`

---

#### Step 15: Final integration checkpoint (M02 + M03) {#step-15}

**Depends on:** #step-10, #step-11, #step-12, #step-13, #step-14

**Commit:** `N/A (verification only)` — **Milestone M02** {#m02-editor-quality} / **Milestone M03** {#m03-versions-drafts}

**References:** [P01]–[P12], (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Full pass over #success-criteria; run every suite; sweep for tuglaws conformance (name the laws touched); verify no console logging, no localStorage, no hand-rolled Tug-component lookalikes.

**Tests:**
- [ ] Full app-test suite; full `cargo nextest run`.

**Checkpoint:**
- [ ] `just app-test && cd tugrust && cargo nextest run && cd ../tugdeck && bunx vite build`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A File card in Tug.app that opens any text file on disk, edits it in a themed, syntax-highlighted CM6 surface with the macOS saveless model (live autosave-in-place, version checkpoints, auto-revert), reachable from menus, the type picker, and one click from any transcript file reference.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every item in #success-criteria verified by an automated test or a named manual check.
- [ ] `cd tugrust && cargo nextest run` green; `bunx vite build` green; `just app-test` green.
- [ ] No tugbank value anywhere contains file content (grep the cardstate domain in a live session).
- [ ] Step Status Ledger fully `done` with commit hashes.

**Acceptance tests:**
- [ ] The Step 9 core-loop app-test suite.
- [ ] The Step 12 transcript-link app-test.
- [ ] The Step 13 version round-trip app-test.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Per-card editor settings surface (wrap/gutter/font) — [Q04].
- [ ] Encoding detection beyond UTF-8; large-file/hex mode.
- [ ] Adopt `lib/language-registry.ts` in `TugCodeView`/`FileBlock` (highlighted read-only transcript files).
- [ ] Delta-based writes if profiling demands (Risk R02).
- [ ] Promote durable decisions into `tuglaws/design-decisions.md` as `[D##]`.

| Checkpoint | Verification |
|------------|--------------|
| M01 core live loop | Step 9 gate |
| M02 editor quality + links | Steps 10–12 gates |
| M03 versions + drafts | Steps 13–14 gates |
| Phase close | Step 15 gate |
