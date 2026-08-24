## Snippets Bringup — a Lens section for reusable prompt text {#phase-slug}

**Purpose:** Ship a new Lens section, **Snippets**, holding an ordered, user-curated list of reusable text fragments stored in a single machine-global `snippets.json`, editable with a Things 3–grade keyboard flow (list/space/return/escape, autosave, undo/redo), drag-reorderable, and draggable into the Session card's prompt entry.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-17 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Developers using Tug type a lot of prompts, and many are similar, reusable hunks of text. Today there is no place to keep them: users re-type or paste from external notes. The Lens (the anchored rail pane of reorderable, collapsible sections — Sessions, Log, Telemetry) is the natural home for a lightweight, always-available snippet list.

The defining constraint is that snippets are **machine-global truth**: the same list must appear in every build of Tug.app (debug, release, any branch). The tugbank defaults store is per-instance by design (`tugbank_db_path()` in `tugrust/crates/tugcore/src/instance.rs` partitions under `instances/<id>/`), so it cannot hold snippets. The repo already has a precedent for machine-global state: `changes_db_path()` in the same file deliberately resolves to `~/Library/Application Support/Tug/changes.db`, a sibling of `instances/`, with a `TUG_CHANGES_DB` env override for hermetic tests. Snippets copy that pattern exactly.

The UX target is Things 3: a list you move through with arrows, open with Return or Space, close with Escape, reorder by dragging a grip — with autosave so there is never a save button, and undo so there is never a confirmation dialog.

#### Strategy {#strategy}

- Build bottom-up: shared file path → tugcast read/write/watch/push plumbing → frontend store → keyboard-list primitive → Lens section → drag-to-prompt. Each step lands independently useful and independently testable.
- Reuse existing machinery at every layer: the `defaults_feed` watch-channel pattern for push, `notify` file watching, the `useBlockReorder` pointer-drag hook for reorder, the `pendingShare`/`pendingCommandInsert` store-slot idiom for prompt insertion, and the drop-extension's accept-ring/caret painters for drag feedback.
- Encapsulate the Things 3 interaction grammar as a reusable primitive (`TugQuickList`) rather than writing it inline in the section — Snippets is its first client, not its only imaginable one.
- Keep the file format boring (versioned JSON, array order = display order) so it is hand-editable, diff-able, and mergeable by eye.
- Concurrency stays simple: atomic whole-document writes, last-writer-wins, hash-gated echo suppression. No merging, no CRDTs.

#### Success Criteria (Measurable) {#success-criteria}

- A snippet created in a debug build appears in a concurrently running release build within ~1 s without any user action (verify: run two builds, add a snippet in one, watch the other).
- Create → edit → reorder → delete → ⌘Z restores the deleted snippet, and `snippets.json` on disk reflects every mutation within the autosave debounce (verify: `cat` the file between gestures).
- Full keyboard round-trip with zero pointer use: focus section → ↓ to select → Return to open → type → Escape to commit → Delete to remove → ⌘Z to restore.
- Dragging a snippet row onto the Session card's prompt entry inserts its text at the drop caret position; the entry shows the existing accept ring + drop caret during hover.
- `cd tugrust && cargo nextest run` passes with no warnings; `bunx vite build` succeeds; `bun run audit:theme-contrast` stays within budget.

#### Scope {#scope}

1. `snippets_path()` shared-path helper in tugcore with `TUG_SNIPPETS_PATH` override.
2. tugcast: atomic read/write HTTP endpoints (`GET`/`PUT /api/snippets`) and a SNIPPETS feed that watches the file and pushes the document to all clients.
3. tugdeck: `snippetsStore` (feed hydration, optimistic mutations, debounced autosave, bounded undo/redo, echo suppression).
4. `TugQuickList` — reusable Things 3–style editable-list primitive (selection, edit-in-place, key grammar, responder registration).
5. Lens section registration with grip drag-reorder and per-theme styling.
6. Pointer-drag from a snippet row into the prompt entry, inserting text via a `pendingSnippetInsert` store slot.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Snippet template variables / placeholders ([Q01], deferred).
- Any Swift/Tug.app host involvement — the file lives outside the per-instance partition and only tugcast touches it.
- Multi-document or per-project snippet scoping — one global list.
- Merge/conflict resolution beyond last-writer-wins ([P03]).
- A `tug` CLI verb for snippets (possible follow-on; the HTTP endpoint is the only writer this phase).
- HTML5 `text/plain` drop support in the prompt editor — insertion goes through the store slot, not `dataTransfer` ([P05]).

#### Dependencies / Prerequisites {#dependencies}

- Existing Lens section registry (`tugdeck/src/components/lens/lens-section-registry.ts`) and band chrome — a new section registers and inherits collapse/reorder/visibility for free.
- Existing `useBlockReorder` (`tugdeck/src/components/lens/block-reorder.ts`), `BlockGrip` (`tugdeck/src/components/tugways/body-kinds/affordances/block-grip.tsx`), `BlockDropCaret` (`tugdeck/src/components/lens/block-drop-caret.tsx`).
- Existing drop feedback painters in `tugdeck/src/components/tugways/tug-text-editor/drop-extension.ts` (`markEditorDropActive`, `paintDropCaret`, `clearDropCaret`, `dropOffsetAtCoords`).
- `notify`-based file watching precedent in `tugrust/crates/tugcast/src/feeds/file_watcher.rs`.

#### Constraints {#constraints}

- **Warnings are errors** across the Rust workspace (`tugrust/.cargo/config.toml` enforces `-D warnings`).
- Tuglaws for all tugdeck work — notably L01 (one render), L02 (external state via `useSyncExternalStore`), L03 (`useLayoutEffect` for registrations events depend on), L06 (appearance via CSS/DOM, never React state), L22 (store-driven DOM writes observe the store directly), L25 (the Lens is a plain card; it owns no chrome).
- No web storage of any kind (no localStorage/sessionStorage/IndexedDB).
- Never hand-roll UI that exists as a Tug\* component; compose the real components.
- Multiple tugcast processes (one per running build) read and write the same file concurrently — every write must be atomic (temp file + rename in the same directory).
- Frontend feed IDs live in `tugdeck/src/protocol.ts` and must mirror `tugrust/crates/tugcast-core/src/protocol.rs` exactly.

#### Assumptions {#assumptions}

- `~/Library/Application Support/Tug/` exists whenever tugcast runs (it already creates/uses `changes.db` and `instances/` there). A missing `snippets.json` means "empty list", never an error.
- Snippet documents stay small (a personal phrasebook, not a corpus); a 1 MB document cap is generous and keeps frames trivially small.
- tugdeck HMR is always live during development; tugcast changes require rebuilding/restarting tugcast.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Snippet template variables (OPEN) {#q01-template-variables}

**Question:** Should snippets support placeholders (e.g. `${selection}`, `${file}`) expanded at insertion time?

**Why it matters:** Placeholders change the insertion path (plain text vs. a mini-expansion step) and the editing UI.

**Resolution:** DEFERRED — plain text only this phase. The insertion path ([P05]) concentrates all inserts through one store slot, so expansion can be added there later without touching the drag machinery.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Watcher echo loops (own write → watch event → UI churn mid-edit) | med | med | Hash-gated echo suppression ([P03]); never clobber an open editor row | Flicker or caret loss while typing |
| Concurrent writes from two builds interleave | low | low | Atomic temp+rename; LWW; watcher re-syncs the loser | Observed lost snippet |
| Keyboard grammar fights Lens focus/Escape-out | med | med | `TugQuickList` claims keys only while its host section has focus; Escape falls through to the Lens after clearing selection | Escape stops closing the Lens |
| Drag-to-prompt hit-testing is brittle across layouts | med | med | Hit-test via a `data-` attribute on the entry root (same idiom as `data-card-drag-target` in `card-drag-coordinator.ts`), not geometry assumptions | Drop misses on split layouts |

**Risk R01: Foreign change arrives while a row is being edited** {#r01-foreign-change-mid-edit}

- **Risk:** Another build writes `snippets.json` while the user has a row open; naive re-hydration replaces the row under the caret.
- **Mitigation:** The store applies foreign documents immediately to all rows except the one currently open for editing; that row's incoming value is parked and applied on commit (the local commit then wins, LWW).
- **Residual risk:** A foreign edit to the *same* row during a local edit is lost — acceptable for a single user's personal phrasebook.

---

### Design Decisions {#design-decisions}

#### [P01] snippets.json lives at the shared Tug root, sibling to instances/ (DECIDED) {#p01-shared-path}

**Decision:** The store is `~/Library/Application Support/Tug/snippets.json`, resolved by a new `snippets_path()` in `tugrust/crates/tugcore/src/instance.rs` next to `changes_db_path()`, deliberately independent of `TUG_INSTANCE_ID`, with a `TUG_SNIPPETS_PATH` env override (constant `ENV_SNIPPETS_PATH`) for hermetic tests.

**Rationale:**
- Snippets are machine-global truth, like the working tree: partitioning per build splits the truth. This copies the documented `changes_db_path()` precedent verbatim.
- tugbank cannot host it: `tugbank_db_path()` partitions per instance, and pointing all builds at one `tugbank.db` fights the deliberate per-instance design.

**Implications:**
- Only tugcast reads/writes the file; Tug.app (Swift) never needs the path.
- Tests set `TUG_SNIPPETS_PATH` to a temp file; no test touches the real user file.

#### [P02] tugcast owns read, watch, and push via a dedicated SNIPPETS feed (DECIDED) {#p02-tugcast-feed}

**Decision:** A new `feeds/snippets.rs` in tugcast reads the file, publishes one JSON frame on `FeedId::SNIPPETS = 0xA0` over a `tokio::sync::watch` channel (the `defaults_feed` pattern, `tugrust/crates/tugcast/src/feeds/defaults.rs`), and re-publishes on file change via a `notify` watcher.

**Rationale:**
- Every running build's tugcast watches the same file, so a write by any build propagates to every running frontend — cross-build live sync falls out of the architecture for free.
- The DEFAULTS feed is the proven template for "serve JSON state, rebuild-and-push on change".

**Implications:**
- New `FeedId` constant on both sides: `tugrust/crates/tugcast-core/src/protocol.rs` and the mirroring `FeedId` map in `tugdeck/src/protocol.ts` (0xA0 is unused; 0x90/0x91 are USAGE, 0xC0 CONTROL, 0xFF HEARTBEAT).
- The feed frame is the whole document plus its content hash (Spec S02).

#### [P03] Atomic whole-document writes, last-writer-wins, hash-gated echo suppression (DECIDED) {#p03-atomic-lww}

**Decision:** `PUT /api/snippets` validates and writes the entire document via temp-file-in-same-directory + `rename`. Conflict policy is last-writer-wins. The PUT response and the feed frame both carry the document's SHA-256; the frontend remembers the hash of its last write and ignores feed frames whose hash matches it.

**Rationale:**
- Multiple tugcast processes write the same file; rename is the only atomicity primitive needed at this size.
- Snippets are one person's phrasebook — merge machinery is over-engineering.
- Echo suppression prevents a build's own write from bouncing back and disturbing an in-progress edit.

**Implications:**
- No partial/patch write API; every mutation ships the whole document.
- Document cap: 1 MB, rejected at the PUT boundary with a 4xx (mirrors the defaults 256 KB boundary-cap idea in `tugrust/crates/tugcast/src/defaults.rs`).

#### [P04] Pointer-based drag everywhere; no HTML5 intra-app DnD (DECIDED) {#p04-pointer-drag}

**Decision:** Row reorder uses `useBlockReorder` (grip + FLIP + midpoint hit-testing + `BlockDropCaret`), and drag-to-prompt is a pointer drag with a ghost element (modeled on `createGhost` in `tugdeck/src/card-drag-coordinator.ts`), hit-testing the prompt entry by a `data-` attribute on its root.

**Rationale:**
- The codebase has zero HTML5 `draggable` intra-app drags; every existing reorder (Lens sections, cards, tabs) is pointer-based. Consistency beats novelty.
- Opening a `text/plain` HTML5 drop path in the editor would also start accepting arbitrary external text drags as a side effect — an unrequested behavior change. The editor's HTML5 drop pipeline stays Files-only.

**Implications:**
- The drag source claims pointer capture; the prompt entry needs no new event listeners for the drag itself, only the `data-` attribute and the existing feedback painters.

#### [P05] Insertion goes through a pendingSnippetInsert store slot (DECIDED) {#p05-store-slot-insert}

**Decision:** Dropping (or click-inserting) a snippet parks `{ text, at: {x,y} | null }` on a new `pendingSnippetInsert` slot on the code-session store; `tug-prompt-entry.tsx` consumes it in a `useLayoutEffect` exactly like `pendingShare` (`tugdeck/src/lib/shell-session-store.ts`) and `pendingCommandInsert` (`tugdeck/src/lib/code-session-store/reducer.ts`), resolving the drop coordinates to a document offset with `dropOffsetAtCoords` and dispatching a CodeMirror change transaction.

**Rationale:**
- Every existing "insert into prompt" gesture (shell share, transcript command insert, changes draft) is store-slot mediated; this is the established seam.
- A single choke point makes later features (placeholders [Q01], multi-snippet insert) one-file changes.

**Implications:**
- A row click affordance ("insert") rides the same slot with `at: null` (append semantics: empty editor takes text as-is, non-empty appends on a new line — the `applyShellShare` behavior).

#### [P06] Escape commits; undo is the safety net (DECIDED) {#p06-escape-commits}

**Decision:** Closing an edit (Escape, clicking elsewhere, opening another row) always commits. There is no cancel gesture and no confirmation dialog anywhere in the section; deletion and unwanted edits are undone with ⌘Z.

**Rationale:**
- This is the Things 3 model the feature is copying: autosave means there is nothing to cancel *to*; undo is strictly more capable than cancel.

**Implications:**
- The store's undo stack must be reliable before delete ships without confirmation (Step ordering: store lands before section UI).

#### [P07] Store-level undo: bounded stack of whole-document snapshots (DECIDED) {#p07-undo-model}

**Decision:** `snippetsStore` keeps a bounded (~50 entry) undo stack of whole-document snapshots. Create, delete, reorder, and edit-commit each push one entry; a typing burst inside one open row coalesces into a single entry at commit. ⌘Z/⇧⌘Z while the section owns the responder chain walk the stack; each step autosaves like any other mutation. Character-level undo inside an open text field belongs to the field's native/CodeMirror undo until commit.

**Rationale:**
- Whole-document snapshots are trivially correct for a small document and make undo-across-autosave (restore a deleted snippet after the file was rewritten) free.
- Two-tier undo (field-level then row-level) matches user expectation: ⌘Z while typing undoes typing; ⌘Z in list mode undoes structure.

**Implications:**
- Undo entries are dropped, not persisted — undo history does not survive reload, and foreign (other-build) changes clear the stack to avoid resurrecting a document state the file never had locally.

#### [P08] The interaction grammar ships as a reusable TugQuickList primitive (DECIDED) {#p08-tugquicklist}

**Decision:** The real Things 3 grammar (see #keyboard-grammar) — list mode (↑/↓ select, **Space** create-below-and-open, Return open selected, ⌘N/`+` create, Delete remove, ⌘Z/⇧⌘Z undo/redo, Escape deselect-then-fall-through) and edit mode (in-place expansion of a single multi-line body, Return = newline, Escape commit-and-close, ⌘Return commit-and-spawn-next) — is encapsulated as `TugQuickList` (component + `useQuickList` hook) under `tugdeck/src/components/tugways/`, with Snippets as its first client.

**Rationale:**
- "Lightweight editable list with excellent keyboard flow" is a general primitive; inlining it in the section would guarantee a second hand-rolled copy later, violating the compose-real-components rule.

**Implications:**
- The edit surface registers CUT/COPY/PASTE/SELECT_ALL/UNDO/REDO responder actions (the `tug-text-editor.tsx` responder pattern via `use-responder.ts` / `responder-chain-provider.tsx`) or ⌘-keys go dead inside it.
- Selection and open-row state are appearance: `data-selected` / `data-editing` attributes + CSS, never React state ([L06]).

#### [P09] Array order is display order; the document is the whole truth (DECIDED) {#p09-array-order}

**Decision:** `snippets.json` holds `{ "version": 1, "snippets": [ { "id", "text" } ] }`; array position is display order (no `order` field); there is **no title** — a snippet is just its multi-line `text`, and a row's handle is the *incipit* (its opening line, à la how papal bulls are named by their first words), derived in the UI; `id` is a client-generated opaque string (`sn_` + random suffix) stable across edits.

**Rationale:**
- One ordering source of truth; hand-editing the file stays obvious.
- Stable ids let the UI key rows, preserve selection across foreign updates, and target the open-row carve-out (R01).

**Implications:**
- Reorder is an array splice + whole-document PUT, like every other mutation.

---

### Deep Dives {#deep-dives}

#### End-to-end data flow {#data-flow}

Write path: UI gesture → `snippetsStore` mutation (optimistic, pushes undo entry) → debounced (~500 ms for text; immediate for create/delete/reorder) `PUT /api/snippets` with the full document → tugcast validates, atomic temp+rename write, records hash, broadcasts a rebuilt SNIPPETS frame → every connected tugcast (including other builds, via their own `notify` watcher on the same file) rebuilds and pushes its frame → each frontend's `snippetsStore` receives the frame; the writer ignores it (hash match), others hydrate.

Read path at boot: the SNIPPETS feed is a `watch` channel, so a newly connected client receives the current frame immediately (same connect-time behavior as DEFAULTS).

Missing/corrupt file: missing → empty document, version 1. Corrupt JSON → feed publishes the last good document plus an `error` field; the PUT path refuses to write until the user resolves it (surfaced in the section as a plain inline notice; never silently overwrite a file the user may have hand-edited). `tugDevLogStore`-visible logging on the Rust side via standard `tracing`.

#### The keyboard grammar, precisely {#keyboard-grammar}

Grounded in Cultured Code's own Things Mac shortcut docs (https://culturedcode.com/things/support/articles/2785159/): in Things, **Space** = "new to-do below selection" (the rapid-entry key), **Return** = open the selected item for editing, **⌘Return** = save & close. Snippets adopt that model. Snippets are **body-led with no title**: a snippet is just its multi-line `text`, and a row's handle is the *incipit* — its opening line ([P09]). Because the body is the only field, plain `Return` is free to be a newline, and `Space` (in the list, no field focused) stays the create key without conflict.

List mode (section focused, no row open):
- `↓`/`↑` — move selection (clamped; `↓` with no selection selects the first row).
- `Space` — **create a new snippet below the selection and open it** (Things' rapid-entry key). Also `⌘N` and the header `+`.
- `Return` — open the selected snippet for editing; with nothing selected, create one.
- `Delete`/`Backspace` — remove the selected snippet, select its successor; no confirmation ([P06]).
- `⌘Z`/`⇧⌘Z` — store-level undo/redo ([P07]).
- `Escape` — clear selection; with nothing selected, do not handle (falls through to the Lens's existing Escape-out in `lens-content.tsx`).

Edit mode (one snippet open, expanded in place: a single multi-line body):
- `Return` — inserts a newline (snippets are multi-line).
- `Escape` — commit and return to the list, the snippet still selected.
- `⌘Return` — commit and immediately spawn the next snippet below, focused (the rapid chain, since plain Return is a newline here).
- Clicking another row — commit the open snippet, select the clicked one.
- `⌘Z` inside the field — field-level (CodeMirror/native) undo; after commit, store-level undo ([P07]).

#### Drag-to-prompt mechanics {#drag-to-prompt}

Pointer down on a row's grip (or a long-ish drag threshold on the row body, ~6 px like `card-drag-coordinator.ts`) starts a drag. While the pointer stays inside the Lens list bounds, it is a reorder (`useBlockReorder` semantics). When it leaves the list, the drag converts to a ghost drag: a small floating chip showing the snippet title follows the pointer (the `createGhost` idiom). Hit-testing on move: `document.elementFromPoint` → closest `[data-snippet-drop-target]` (a new attribute on the prompt entry root in `tug-prompt-entry.tsx`, next to its existing drag props). While over the target, call `markEditorDropActive` + `paintDropCaret` (from `drop-extension.ts`) for the standard accept ring and caret; on leave, `clearDropCaret`. On release over the target, park `{ text, at: {x, y} }` on `pendingSnippetInsert` ([P05]); on release elsewhere, cancel with a snap-back FLIP. This mode conversion (reorder ↔ ghost) mirrors the reorder/detach mode split in `card-drag-coordinator.ts`.

#### Key existing code map (for the cold reader) {#code-map}

| Concern | Where | What to know |
|---|---|---|
| Shared path precedent | `tugrust/crates/tugcore/src/instance.rs` — `changes_db_path()`, `ENV_CHANGES_DB`, `base_data_dir()` | `base_data_dir()` = `dirs::data_dir()/Tug`; the doc comment on `changes_db_path` explains the machine-global rationale to copy |
| Feed template | `tugrust/crates/tugcast/src/feeds/defaults.rs` — `defaults_feed()` | Builds one aggregated frame, publishes over `tokio::sync::watch::Sender<Frame>`, rebuild-on-change callback |
| Feed IDs (Rust) | `tugrust/crates/tugcast-core/src/protocol.rs` — `FeedId` consts | 0xA0 is free; USAGE is 0x90/0x91 |
| Feed IDs (TS) | `tugdeck/src/protocol.ts` — `export const FeedId` | Must mirror the Rust constants |
| Feed wiring | `tugrust/crates/tugcast/src/main.rs` (search `defaults_feed`) | Feeds are created in main and handed to the router as watch receivers |
| HTTP routes | `tugrust/crates/tugcast/src/server.rs` (search `/api/defaults`) | Axum router; loopback-only; add `/api/snippets` GET+PUT here |
| HTTP handler style | `tugrust/crates/tugcast/src/defaults.rs` — `get_domain`, `put_key` | Boundary size cap + JSON validation pattern |
| File watcher | `tugrust/crates/tugcast/src/feeds/file_watcher.rs` | `notify`-based, 100 ms debounce; single-file watch is fine here |
| Frame client | `tugdeck/src/lib/tugbank-client.ts` — `handleDefaultsFrame`, `onDomainChanged` | The subscribe/hydrate pattern `snippetsStore` copies; `connection.onFrame(FeedId.X, …)` |
| useSyncExternalStore adapter | `tugdeck/src/lib/use-tugbank-value.ts` | The hook-shape reference |
| Lens registry | `tugdeck/src/components/lens/lens-section-registry.ts` — `registerLensSection`, `LensSectionDefinition` | Required fields: `kind`, `title`, `glyph`, `collapsedSummary(host)`, `body(host)`; optional `headerActions(host)` |
| Section examples | `tugdeck/src/components/lens/sections/log-section.tsx` (minimal), `sessions-section.tsx` (rich) | Co-located CSS; bodies read app singleton stores via `useSyncExternalStore`; register call in `main.tsx` next to the other three `register*Section()` calls |
| Reorder hook | `tugdeck/src/components/lens/block-reorder.ts` — `useBlockReorder`, `onGripPointerDown` | Pointer + FLIP + midpoint targeting + `commit(order)` callback; `BlockDropCaret` for the caret |
| Grip affordance | `tugdeck/src/components/tugways/body-kinds/affordances/block-grip.tsx` | Owner passes `onGripPointerDown` |
| Ghost drag model | `tugdeck/src/card-drag-coordinator.ts` — `createGhost`, mode split, `data-card-drag-target` | The pattern for cross-container pointer drags |
| Insert idioms | `tugdeck/src/components/tugways/tug-prompt-entry.tsx` — the `useLayoutEffect` consumers of `shellSessionStore.pendingShare` and `codeSessionStore.pendingCommandInsert` | Empty editor takes text as-is; non-empty appends on a new line; command inserts go through `restoreState` |
| Drop feedback painters | `tugdeck/src/components/tugways/tug-text-editor/drop-extension.ts` — exported: `dropOffsetAtCoords`, `paintDropCaret`, `clearDropCaret`, `markEditorDropActive`, `insertAtomsAt`, `tugDropExtension` | Reused verbatim for hover feedback and offset resolution. `insertTextAt` is module-private — the snippet consumer dispatches its own CodeMirror change transaction instead. The Files-only gates in this file are NOT touched |
| Responder registration | `tugdeck/src/components/tugways/tug-text-editor.tsx` header comment + `use-responder.ts`, `responder-chain-provider.tsx` | Editing surfaces must register CUT/COPY/PASTE/SELECT_ALL/UNDO/REDO or ⌘-keys are suppressed dead |
| Dev logging | `tugDevLogStore.{debug,info,warn,error}` (TugDevPanel, Opt-Cmd-/) | Never `console.warn` for runtime state |

---

### Specification {#specification}

**Spec S01: snippets.json document format** {#s01-document-format}

```json
{
  "version": 1,
  "snippets": [
    { "id": "sn_8f3a1c", "text": "Before declaring done, drive the real flow." },
    { "id": "sn_c21b9d", "text": "Explain the tradeoffs, then recommend one." }
  ]
}
```

- `version`: integer, currently 1. Unknown greater versions: serve read-only with an `error` notice; never rewrite.
- `snippets[]`: array position is display order ([P09]).
- `id`: non-empty string, unique within the document; convention `sn_` + 12 hex chars, client-generated.
- `text`: string, the snippet body; may be multi-line. There is **no title** — a row's handle is the *incipit*, the opening line of `text`, derived in the UI (`snippetIncipit`).
- Whole-document size cap: 1 MB at the PUT boundary.
- Missing file ≡ `{ "version": 1, "snippets": [] }`.

**Spec S02: SNIPPETS feed frame and HTTP API** {#s02-wire-contract}

- `FeedId::SNIPPETS = 0xA0` (Rust `tugcast-core/src/protocol.rs` + TS `tugdeck/src/protocol.ts`).
- Feed frame payload (JSON): `{ "doc": <S01 document>, "hash": "<sha256 hex of the file bytes>", "error": null | "<human-readable parse/read error>" }`. Published on connect (watch-channel semantics) and on every file change.
- `GET /api/snippets` → `200 { "doc": …, "hash": … }` (or `error` populated).
- `PUT /api/snippets` with body `{ "doc": <S01 document> }` → validates (S01 rules, size cap), writes atomically (temp file in the same directory + rename), returns `200 { "hash": … }`; `400` on validation failure, `409` if the on-disk document is unreadable/corrupt (refuse to clobber, per #data-flow), `413` over the cap.
- Loopback-only, same as all `/api/*` routes in `server.rs`.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Snippet document (list, titles, texts) | structure | `snippetsStore` singleton + `useSyncExternalStore` | [L02] |
| Undo/redo stack, lastWrittenHash, debounce timer | local-data (store-internal) | plain fields inside `snippetsStore`, never rendered directly | [L02] |
| Row selection, open-for-edit row | appearance | `data-selected` / `data-editing` attributes + CSS | [L06] |
| Drag transforms, ghost position, drop caret/ring | appearance | direct DOM transforms + existing painters (`paintDropCaret`, `markEditorDropActive`) | [L06], [L22] |
| `pendingSnippetInsert` | structure (transient slot) | store slot consumed in `useLayoutEffect` in `tug-prompt-entry.tsx` | [L02], [L03] |
| Responder registration for edit fields | — | `useLayoutEffect` registration via responder chain | [L03], [L11] |
| Collapse/order/visibility of the section | structure (pre-existing) | `lensStore` (unchanged; new `kind` only) | [L02] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/snippets.rs` | Document model, validation, atomic read/write, SHA-256, HTTP handlers (`get_snippets`, `put_snippets`) |
| `tugrust/crates/tugcast/src/feeds/snippets.rs` | `snippets_feed()` — watch-channel frame publisher + `notify` file watcher |
| `tugdeck/src/lib/snippets-doc.ts` | Pure S01 document transforms, undo-stack ops, echo/foreign-merge decisions (no IO — the `bun:test` surface) |
| `tugdeck/src/lib/snippets-store.ts` | `snippetsStore` singleton composing `snippets-doc.ts`: hydration, mutations, autosave, undo/redo, echo suppression |
| `tugdeck/src/components/tugways/tug-quick-list.tsx` (+ `.css`) | `TugQuickList` / `useQuickList` — the Things 3 grammar primitive |
| `tugdeck/src/components/lens/sections/snippets-section.tsx` (+ `.css`) | The Lens section: summary, body, header `+`, reorder wiring, drag source |
| `tugdeck/src/lib/snippet-drag.ts` | Pointer ghost-drag coordinator for drag-to-prompt |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `snippets_path`, `ENV_SNIPPETS_PATH` | fn / const | `tugrust/crates/tugcore/src/instance.rs` | Sibling to `changes_db_path` / `ENV_CHANGES_DB` |
| `FeedId::SNIPPETS` | const `0xA0` | `tugrust/crates/tugcast-core/src/protocol.rs` | + mirror in `tugdeck/src/protocol.ts` |
| `pub mod snippets` | mod decls | `tugcast/src/main.rs` area + `feeds/mod.rs` | Wire feed receiver into the router like `defaults_rx` |
| `/api/snippets` routes | axum routes | `tugrust/crates/tugcast/src/server.rs` | GET + PUT, loopback-only |
| `pendingSnippetInsert` | store slot + actions | `tugdeck/src/lib/code-session-store/` (`types.ts`, `reducer.ts`) | Modeled on `pendingCommandInsert`; set + consume actions |
| `data-snippet-drop-target` | DOM attribute | `tugdeck/src/components/tugways/tug-prompt-entry.tsx` | On the entry root; plus the `useLayoutEffect` consumer of the slot |
| `registerSnippetsSection` | fn | `snippets-section.tsx`, called from `tugdeck/src/main.tsx` | Alongside the existing three `register*Section()` calls |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | Path resolution, S01 validation, atomic write, hash | `instance.rs`, `snippets.rs` |
| **Integration (Rust)** | Write → watcher → rebuilt frame; PUT → frame; corrupt file → error frame + 409 | `feeds/snippets.rs` with `TUG_SNIPPETS_PATH` temp files, following the existing tugcast integration-test style (`integration_tests.rs`, `feeds/defaults.rs` tests) |
| **Store logic (TS, `bun:test`)** | Pure document/store functions (undo stack, hash echo suppression, foreign-merge open-row carve-out, order splice) driven with real S01/S02 payloads, in `tugdeck/src/__tests__/` | Pure logic on real payloads — no live server, no mocks; the transport round-trip is covered at the Rust integration layer, and end-to-end behavior at the running-app checkpoints |
| **Build gates** | `cargo nextest run` (warnings are errors), `bunx vite build`, `bun run audit:theme-contrast` | Every step's checkpoint |

#### What stays out of tests {#test-non-goals}

- jsdom/fake-DOM render tests of the section or `TugQuickList` — banned pattern; keyboard/drag behavior is verified in the running app (checkpoints name the manual gestures).
- App-test coverage of drag gestures — synthetic cross-card pointer drags are brittle in the headless harness; the insertion seam is covered at the reducer layer (`pendingSnippetInsert` set/consume actions) and the file plumbing at the Rust layer.
- TS tests against a live tugcast — no such harness exists (every tugdeck test is pure-logic `bun:test` in `src/__tests__/`); the transport round-trip belongs to the Rust integration tests, and real-app behavior to the running-app checkpoints and `just app-test`.
- Multi-process concurrent-write races — LWW by design ([P03]); the atomic-rename unit test plus the watcher integration test cover the mechanism.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step below.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Shared path helper in tugcore | done | 56f821c6e |
| #step-2 | Snippets document model + HTTP endpoints | done | 149e35cc4 |
| #step-3 | SNIPPETS feed with file watcher | done | b8ecf7d33 |
| #step-4 | snippetsStore in tugdeck | done | 43d29a705 |
| #step-5 | TugQuickList primitive | done | 0f3e762b5 |
| #step-6 | Snippets Lens section | done | eaeb0025a |
| #step-7 | Drag-to-prompt insertion | done | d85ddae51 |
| #step-8 | Integration checkpoint | done | 5928bbab7 (verify fix) |

#### Step 1: Shared path helper in tugcore {#step-1}

**Commit:** `tugcore(snippets): add machine-global snippets_path with TUG_SNIPPETS_PATH override`

**References:** [P01] shared path, (#context, #code-map)

**Artifacts:**
- `snippets_path()` + `ENV_SNIPPETS_PATH` in `tugrust/crates/tugcore/src/instance.rs`, placed next to `changes_db_path()` / `ENV_CHANGES_DB` with a doc comment stating the machine-global rationale (snippets are the user's phrasebook; per-instance partitioning would split the truth).

**Tasks:**
- [ ] Add `ENV_SNIPPETS_PATH: &str = "TUG_SNIPPETS_PATH"` and `snippets_path() -> PathBuf` returning the env override when set and non-empty, else `base_data_dir().join("snippets.json")`.

**Tests:**
- [ ] Unit: default resolves to `…/Tug/snippets.json` under `base_data_dir()`; env override wins; empty env var is ignored (match the `changes_db_path` test style in `instance.rs`).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcore`

---

#### Step 2: Snippets document model + HTTP endpoints {#step-2}

**Depends on:** #step-1

**Commit:** `tugcast(snippets): document model, validation, atomic writes, GET/PUT /api/snippets`

**References:** [P03] atomic LWW, [P09] array order, Spec S01, Spec S02, (#data-flow, #code-map)

**Artifacts:**
- `tugrust/crates/tugcast/src/snippets.rs`: `SnippetsDoc` / `Snippet` serde types, S01 validation (version, unique non-empty ids, 1 MB cap), `read_snippets(path)` (missing → empty doc; parse error → typed error carrying the message), `write_snippets_atomic(path, &doc)` (temp file in same dir + rename), `doc_hash` (SHA-256 of file bytes), handlers `get_snippets` / `put_snippets`.
- Routes registered in `server.rs` next to the `/api/defaults` block: `GET /api/snippets`, `PUT /api/snippets`; `mod snippets;` in `main.rs`.

**Tasks:**
- [ ] Implement types + validation + atomic IO + hash per Spec S01/S02.
- [ ] `put_snippets`: `400` invalid, `413` over cap, `409` when the on-disk file exists but is unreadable/corrupt (never clobber a hand-edited file), `200 {hash}` on success.
- [ ] `get_snippets`: `200 {doc, hash}`; corrupt file → `200` with last-resort `{doc: empty, hash: null, error}` shape consistent with the feed frame (S02).

**Tests:**
- [ ] Unit: validation accepts S01 fixtures, rejects duplicate/empty ids, wrong version, over-cap.
- [ ] Unit: missing file reads as empty doc; atomic write round-trips; corrupt file → read error surfaces, write path refuses (409 semantics).
- [ ] Integration: GET/PUT round-trip against a temp `TUG_SNIPPETS_PATH` using the existing tugcast HTTP integration-test harness.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 3: SNIPPETS feed with file watcher {#step-3}

**Depends on:** #step-2

**Commit:** `tugcast(snippets): SNIPPETS feed (0xA0) — watch snippets.json, push doc+hash frames`

**References:** [P02] tugcast feed, [P03] hash in frame, Spec S02, (#data-flow, #code-map)

**Artifacts:**
- `FeedId::SNIPPETS = 0xA0` in `tugrust/crates/tugcast-core/src/protocol.rs`.
- `tugrust/crates/tugcast/src/feeds/snippets.rs`: `snippets_feed() -> watch::Receiver<Frame>` — no cancel token, matching `defaults_feed`: the spawned task holds the `watch::Sender` and exits when the channel fully closes (`tx.closed().await`). Reads the file, publishes the S02 frame, spawns a `notify` watcher on the file's **parent directory** (watch the directory, filter for the filename — rename-based atomic writes replace the inode, so watching the file itself goes stale) with a ~100 ms debounce like `file_watcher.rs`.
- Wiring in `main.rs`: create the receiver next to `defaults_rx` and push it into the `snapshot_watches` vec that flows to `FeedRouter::add_snapshot_watches` (the `defaults_rx` pattern); `pub mod snippets;` in `feeds/mod.rs`.
- PUT-side broadcast: after a successful `put_snippets` write, nudge the feed to rebuild immediately (channel or shared trigger, mirroring how tugbank CLI writes call `broadcast_domain_changed`) so the writer's own frontend doesn't wait on watcher debounce.

**Tasks:**
- [ ] Implement the feed + watcher + immediate-rebuild nudge from the PUT handler.
- [ ] Frame carries `{doc, hash, error}` per Spec S02; parse failure publishes last good doc + `error`.

**Tests:**
- [ ] Integration: external write to the temp snippets file → new frame within debounce; PUT → new frame; corrupt overwrite → frame with `error` set and last good doc retained.
- [ ] Unit: frame serialization matches Spec S02 (assert `feed_id == FeedId::SNIPPETS`, like the `defaults.rs` frame test).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugcast-core`

---

#### Step 4: snippetsStore in tugdeck {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(snippets): snippetsStore — feed hydration, autosave, undo/redo, echo suppression`

**References:** [P03] echo suppression, [P06] escape commits, [P07] undo model, [P09] ids/order, Spec S01, Spec S02, Risk R01, (#data-flow, #state-zone-mapping)

**Artifacts:**
- `SNIPPETS: 0xA0` added to `FeedId` in `tugdeck/src/protocol.ts`.
- `tugdeck/src/lib/snippets-doc.ts`: pure document functions — `applyCreate`/`applyUpdate`/`applyDelete`/`applyOrder` (immutable S01 transforms), undo-stack push/walk/coalesce, `shouldIgnoreFrame(frame, lastWrittenHash)`, and `mergeForeignDoc(local, foreign, openRowId)` (the R01 open-row carve-out). No IO, no timers — everything decision-shaped lives here so it is testable as pure logic.
- `tugdeck/src/lib/snippets-store.ts`: module-singleton `snippetsStore` composing `snippets-doc.ts`, with `subscribe`/`getSnapshot` (stable snapshots, [L02]); frame hydration via `connection.onFrame(FeedId.SNIPPETS, …)` following `tugbank-client.ts`; mutations `createSnippet(afterId?)`, `updateSnippet(id, {title?, text?})`, `deleteSnippet(id)`, `setOrder(ids)`; `beginEdit(id)`/`commitEdit(id)` bracketing for undo coalescing and the R01 carve-out; `undo()`/`redo()` (bounded 50-entry snapshot stack, cleared on foreign hydration); autosave via `PUT /api/snippets` (immediate for create/delete/reorder, ~500 ms debounce for text), remembering `lastWrittenHash` and ignoring frames whose hash matches.

**Tasks:**
- [ ] Implement the pure module + store per [P07]/R01 semantics; id generation `sn_` + 12 hex chars via `crypto.getRandomValues`.
- [ ] Surface `error` from the frame in the snapshot (the section renders it as an inline notice in Step 6).

**Tests:**
- [ ] `bun:test` (`tugdeck/src/__tests__/snippets-doc.test.ts`) on the pure functions with real S01/S02 payloads: delete → undo restores the snippet; an echo frame (hash match) is a no-op; a foreign frame during an open edit leaves the open row untouched and applies the rest; reorder splices; a typing burst coalesces to one undo entry at commit.
- [ ] The transport round-trip (PUT → file → watcher → frame) is already covered by the Rust integration tests in #step-2/#step-3; end-to-end behavior (create → file within debounce; external edit appears live) is verified in-app at the #step-6/#step-8 checkpoints — no live-server TS tests (per #test-non-goals).

**Checkpoint:**
- [ ] `bunx vite build`
- [ ] `cd tugdeck && bun test snippets-doc` green

---

#### Step 5: TugQuickList primitive {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(tugways): TugQuickList — Things-style list/edit keyboard grammar primitive`

**References:** [P06] escape commits, [P08] TugQuickList, (#keyboard-grammar, #state-zone-mapping)

**Artifacts:**
- `tugdeck/src/components/tugways/tug-quick-list.tsx` + `.css`: `TugQuickList` component + `useQuickList` hook implementing #keyboard-grammar exactly. Props: `items` (id + render data), `renderRow`, `renderEditor` (title field + text area), callbacks `onCreate(afterId?)`, `onCommit(id, {title, text})`, `onDelete(id)`, `onOpen/onClose` hooks for `beginEdit`/`commitEdit` bracketing.
- Selection and open state live in `data-selected`/`data-editing` attributes managed by the hook ([L06]); key handling attaches only while the host has focus; unhandled Escape is left unconsumed so the Lens Escape-out still works.
- Edit fields register CUT/COPY/PASTE/SELECT_ALL/UNDO/REDO on the responder chain (pattern: `tug-text-editor.tsx` header comment, `use-responder.ts`, `responder-chain-provider.tsx`); UNDO/REDO route to field-native undo while editing and to the host's `onUndo`/`onRedo` (store-level) in list mode.

**Tasks:**
- [ ] Implement the hook + component per #keyboard-grammar; registrations in `useLayoutEffect` ([L03]).
- [ ] Before reaching for raw `<input>`/`<textarea>` for the edit fields, check for an existing Tug field component to compose (the compose-real-components rule); use native elements only if no Tug\* equivalent exists.
- [ ] Rows that only display (list mode) render no tabindex (read-only-list focus rule); the container is the focusable unit.

**Tests:**
- [ ] None at this layer (no jsdom render tests, per #test-non-goals) — behavior is exercised via Step 6's checkpoint in the running app.

**Checkpoint:**
- [ ] `bunx vite build`
- [ ] `bunx tsc --noEmit` (or the repo's standing typecheck invocation) clean

---

#### Step 6: Snippets Lens section {#step-6}

**Depends on:** #step-5

**Commit:** `tugdeck(lens): Snippets section — TugQuickList body, grip reorder, all-theme styling`

**References:** [P08] TugQuickList, [P09] array order, [P04] pointer reorder, Spec S01, (#code-map, #state-zone-mapping)

**Artifacts:**
- `tugdeck/src/components/lens/sections/snippets-section.tsx` + `.css`: `registerSnippetsSection()` calling `registerLensSection` with `kind: "snippets"`, a Lucide glyph at `size={14}` (text-quote or scissors, matching neighbor sections), `collapsedSummary` = live count ("7 snippets") via `useSyncExternalStore(snippetsStore…)`, `headerActions` = a `+` that calls `createSnippet()` and opens the new row, `body` = `TugQuickList` bound to `snippetsStore` (untitled rows display first text line, per S01).
- Per-row `BlockGrip` wired to `useBlockReorder` with `commit(order)` → `snippetsStore.setOrder(order)`; `BlockDropCaret` for the insertion caret.
- Inline notice row when the store snapshot carries `error` (corrupt file), stating the path and that edits are paused.
- Registration call added in `tugdeck/src/main.tsx` next to `registerSessionsSection()` / `registerLogSection()` / `registerTelemetrySection()`.
- Styling tokens drawn from the shared theme token set; verify across all six themes.

**Tasks:**
- [ ] Build section + register; compose `TugQuickList`, `BlockGrip`, `BlockDropCaret` — no hand-rolled equivalents.
- [ ] Style with theme tokens only (no literal colors).

**Tests:**
- [ ] None new at this layer (behavior covered by Step 4 store tests + the manual checkpoint; no fake-DOM tests per #test-non-goals).

**Checkpoint:**
- [ ] `bunx vite build` and `bun run audit:theme-contrast` pass
- [ ] In the running app: full keyboard round-trip from #success-criteria (select/open/type/Escape/Delete/⌘Z) works; grip-drag reorders and the order survives an app reload; a snippet added via `echo`-editing `snippets.json` externally appears live; with two builds running, an edit in one appears in the other

---

#### Step 7: Drag-to-prompt insertion {#step-7}

**Depends on:** #step-6

**Commit:** `tugdeck(snippets): pointer ghost-drag from Lens row into prompt entry via pendingSnippetInsert`

**References:** [P04] pointer drag, [P05] store-slot insert, Spec S01, (#drag-to-prompt, #code-map, #state-zone-mapping)

**Artifacts:**
- `pendingSnippetInsert: { text: string, at: { x: number, y: number } | null } | null` slot + set/consume actions in `tugdeck/src/lib/code-session-store/` (`types.ts`, `reducer.ts`), modeled on `pendingCommandInsert`.
- `tugdeck/src/lib/snippet-drag.ts`: ghost-drag coordinator per #drag-to-prompt (reorder↔ghost mode conversion, `createGhost`-style chip, `elementFromPoint` hit-test against `[data-snippet-drop-target]`, hover feedback via `markEditorDropActive`/`paintDropCaret`/`clearDropCaret`, snap-back on cancel).
- In `tug-prompt-entry.tsx`: `data-snippet-drop-target` on the entry root, plus a `useLayoutEffect` consumer of the slot — `at` present → `dropOffsetAtCoords` + change transaction at that offset; `at: null` → the `applyShellShare` append semantics (empty editor takes text as-is; non-empty appends on a new line).
- A row-level "insert" affordance (double-click and a hover action) setting the slot with `at: null`.

**Tasks:**
- [ ] Implement coordinator + slot + consumer; do not touch the Files-only gates in `drop-extension.ts` ([P04]).

**Tests:**
- [ ] `bun:test` at the reducer layer, modeled on the existing `pendingCommandInsert` coverage in `tugdeck/src/lib/code-session-store/`: the set action parks `{text, at}` on the snapshot, the consume action clears it, both `at` shapes covered. Actual insertion into the editor is verified in the running-app checkpoint below (no mounted-component tests, per #test-non-goals).

**Checkpoint:**
- [ ] `bunx vite build`
- [ ] In the running app: drag a row over the prompt entry — accept ring + caret appear; release inserts at the caret; release outside snaps back; double-click appends

---

#### Step 8: Integration checkpoint {#step-8}

**Depends on:** #step-2, #step-3, #step-4, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** [P01]–[P09], Spec S01, Spec S02, (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Walk every item in #success-criteria end-to-end in the running app, including the two-builds cross-sync check.
- [ ] Verify `~/Library/Application Support/Tug/snippets.json` is the only new file touched (no per-instance leakage under `instances/`).

**Tests:**
- [ ] Full suites: `cd tugrust && cargo nextest run`; `cd tugdeck && bun test`; `just app-test` still green (Lens gains a section — confirm no existing app-test assertions break).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` clean
- [ ] `bunx vite build` + `bun run audit:theme-contrast` clean
- [ ] `just app-test` green

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A Snippets section in the Lens backed by machine-global `~/Library/Application Support/Tug/snippets.json`, live-synced across all running builds, with Things 3–grade keyboard editing, autosave, undo/redo, grip reorder, and drag/double-click insertion into the Session card's prompt entry.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All #success-criteria items verified in the running app (Step 8 walkthrough).
- [ ] All Rust and `bun:test` suites green; `vite build`, theme-contrast audit, and `just app-test` clean.
- [ ] No tuglaws violations introduced (State Zone Mapping honored; commit messages name the laws touched for tugdeck steps).

**Acceptance tests:**
- [ ] Rust integration: PUT → frame; external write → frame; corrupt file → error frame + 409 refusal.
- [ ] `bun:test`: undo-restores-delete, echo suppression, and foreign-edit-during-open-row on the pure `snippets-doc.ts` functions with real S01/S02 payloads.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Snippet template variables ([Q01]).
- [ ] `tug` CLI verb for scripted snippet management (the atomic write + watcher already accommodate external writers).
- [ ] Search/filter within the section once lists grow.

| Checkpoint | Verification |
|------------|--------------|
| Cross-build sync | Two builds running; edit in one appears in the other within ~1 s |
| Keyboard round-trip | #success-criteria gesture sequence, pointer-free |
| Drag insertion | Accept ring + caret on hover; text lands at drop offset |
| Suites | `cargo nextest run`, `bun test` (tugdeck), `bunx vite build`, `bun run audit:theme-contrast`, `just app-test` |
