## Markdown Attachments Follow-on — one attachment experience across two surfaces {#markdown-attachments-follow-on}

**Purpose:** Make attaching a file mean one thing everywhere in Tug: both the Session card's prompt entry and the Text card's markdown editor accept any drop or paste without preconditions, show what landed in a preview strip below the editor, interoperate through copy/paste, and never raise a modal error.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-14 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-14, fable.** Lint: 0 errors, 1 warning (the missing review record itself, now fixed by this entry). Read the shipped surfaces the plan builds on rather than the plan's account of them — `tug-attachment-preview.tsx`, `tug-text-card-editor.tsx`'s `anchorLinkExtension` wiring, `text-card-store.ts`'s draft/`saveAs` paths, `draft_gc.rs`, `attachments.rs`, and `MainWindow.swift`'s message-handler dispatch. Applied four substantive fixes. **Correctness — a silent ⌘-click regression:** Step 5 said to move the `canOpenRelative`/`openRelative` callbacks onto `resolveAssetPath` "keeping ⌘-click behavior identical", but `resolveAssetPath` is `assets/`-only by [P12] while the shipped `resolveAgainstDoc` resolves *any* in-tree relative destination, so a hand-written `images/diagram.png` link would have gone inert; split into `resolveRelativePath` (⌘-click, semantics unchanged) and `resolveAssetPath` (strip only), and noted in the same step that those callbacks read a `path` that is `null` for an untitled buffer, so they should take the asset base and start working there. **Under-specification that would have shipped invisible UI:** [P10]/Step 6 said the tile renderer "keys off the segment type", but `TileSnapshot` carries no type, `AttachmentPreviewTile`'s `src` ladder paints a transparent placeholder when there are no pixels, and the ✕ is gated on `src !== undefined || broken` — so every non-image tile would have rendered as an invisible slot with no delete affordance; enumerated the three concrete changes required. **A resource leak the plan introduced:** `draft-docs/<draftId>/` homes are never reclaimed, because the shipped `sweep_draft_attachments` walks files only and explicitly skips subdirectories; added a `sweep_draft_docs` pass with tests to Step 1, matching on the draft id the Text card bag already carries. **Test hygiene:** at0414 trashes real files into the running machine's Trash, so every ✕ case must close on its restore assertion or each run litters a developer's Trash. Also confirmed two claims the plan rests on that turned out sound: multiple mounted strips do not contend (`registerAttachmentPreviewOpener` holds a `Set` and `openAttachmentPreview` tries each opener), and `NSWorkspace.recycle` fits the existing `clipboardRead` request/response bridge shape exactly. Deferred: nothing new — [Q02] and [Q03] stand as written, and [Q01] remains correctly closed by the system-Trash decision.

**Round 2 — 2026-08-14, opus.** Lint: 0 errors, 0 warnings on entry. Read the surfaces Round 1 had not: the `fs` route table in `tugcast/src/server.rs`, `fs_write.rs`'s request struct, `fs_blob.rs`'s response contract, `tugchanges-core::git::repo_root_for`, `MainWindow.swift`'s `cleanupBridge`, and `AtomBytesEntry`'s field set. Four fixes, all of them things the plan asserted about code it had not checked. **Correctness — the restore path did not exist.** [Spec S03](#s03-trash-bridge) and Step 10 said undo moves the file back from the trashed URL "through the existing `fs` write surface." There is no such surface: the `fs` family is `complete`/`read`/`blob`/`mkdir`/`stat`/`attach`/`write` with no move or copy verb, and `POST /api/fs/write` takes `content: String` and writes `content.as_bytes()` under a `baseline_sha256` precondition — a text-document writer that would corrupt any binary asset routed through it. Undo would have failed on the first photo. Made `restorePath` a second host handler, symmetric with `trashPath`, doing a `FileManager.moveItem` from the URL the host itself minted, resolving a destination collision and reporting the path it actually restored to; specified through S03, Step 3, and Step 10. **Correctness — the git exclusion breaks in exactly the worktree Tug creates.** Step 4 said to write `<repo>/.git/info/exclude` where `repo` comes from `repo_root_for`, but that function deliberately returns the *linked worktree's* root (its docblock says so), and a linked worktree's `.git` is a **file** — so on every dash worktree the join names a path that cannot be created. Rewrote the step to locate the file through `git rev-parse --git-common-dir` and the anchored path through `--show-toplevel`, which is also what makes [P09]'s "shared across worktrees" claim true rather than incidental; added a `git worktree add` fixture test. **Efficiency — the strip would have held every asset twice over.** [P10] and Step 6 said the projection populates a card-local `AtomBytesStore` from `/api/fs/blob`, but `AtomBytesEntry.content` is required base64 and `AttachmentPreviewTile`'s `src` ladder paints `thumbnailDataUrl`, else a `data:` URL built from `content`, else nothing — so a ten-image document would have parked ten base64-inflated files in JS memory for the life of the card, to render thumbnails. The entry already carries an optional `path` and `/api/fs/blob` is streamed, `ETag`-revalidated, and `Range`-capable; specified a `blobUrl(path)` branch in the ladder, `path` on `TileSnapshot`/`snapshotKey`, and `content` relaxed to optional, which lets the projection do no byte I/O at all — and corrected [Risk R02](#r02-projection-cost)'s mitigation, which had promised to de-duplicate fetches that now do not happen. **Leak — `cleanupBridge()`.** `MainWindow` removes each script-message handler by name at teardown; Step 3 registered `trashPath` without adding it there, which retains `self` through the `WKUserContentController`. Both new names now appear in both places. Verified sound and left alone: `sweep_at_startup` is the real entry point and reads the card-state domain the draft id lives in, so Round 1's `sweep_draft_docs` addition lands correctly; `classifyFileKind`, `extractImageFiles`, `CardContentResponderScope`, `REMOVE_ATTACHMENT`, and `resolveDroppedFile` all exist as named; and the three app-test files the plan adds do not collide with existing numbers. Deferred: nothing new.

**Round 3 — 2026-08-14, fable.** Lint: 0 errors, 0 warnings on entry. This pass read the clipboard and undo machinery Step 9 and Step 10 stand on — `clipboard-filters.ts` end to end, `pasteWithTransform` in `tug-text-card-editor.tsx`, `atom-decoration.ts`'s `atomInvertedEffects`, `serializeClipboard`'s one non-test caller in `tug-text-editor.tsx`, and the current `AttachQuery`. Three substantive fixes, one small one. **Correctness — the interop's new fields would not survive their own parser.** `parseClipboardSidecar` validates by *reconstructing* every entry from a fixed field list, and `parseBytesEntry` rebuilds `{content, mediaType, thumbnailDataUrl}` and drops everything else — including the `path` that `AtomBytesEntry` already carries. So the plan's additive `assetPath`/`assetName` would be silently stripped on every paste, and worse, a prompt→document paste could only reach the atom's *downsampled* bytes, storing a degraded image that renders convincingly; the success criterion now demands byte-identity with the original upload and Step 9 extends both parsers, guarded by a serialize→parse deep-equal round-trip test that fails against today's code. **Design hole — the sidecar had no way to say "this range is a link."** The payload schema is positional (U+FFFC per atom); a markdown link is a range of literal text, and Step 9's "build a sidecar for `assets/`-scoped links" never said how the two shapes meet — the naive reading has `insertSidecar` planting atom widgets over literal markup in the prompt, violating [P05]. [P04] now specifies the geometry: image links are substituted as U+FFFC atom entries (so the prompt's existing `insertSidecar` reconstitutes them with no special case), non-image links stay literal text recorded in an optional top-level `assets` range list (so [P05] holds by construction). Step 9 also now names the **two** paste entry points a Text-card gesture actually has — `pasteWithTransform` on the responder route (which today destructures only `{ text }`, the very discard being fixed) and Step 7's DOM handler, which cannot see the native pasteboard type in `clipboardData` and must ask the bridge as `clipboard-filters.ts` branch 2b does — and requires one shared routine behind both. **Technical choice — Step 10's undo coupling hand-rolled what the tree already solves.** "Watch the update listener for the undo of that specific change" invents undone-or-not bookkeeping that `@codemirror/commands`' `invertedEffects` exists to eliminate, and `atomInvertedEffects` is the in-tree precedent using it for exactly this shape of problem; the ✕ transaction now registers an inverted `restoreAssetEffect` (with the reverse inversion so redo re-trashes), and Spec S03, [P07], and the State Zone Mapping row were corrected to match — the trashed URL rides in the history, not in a `useRef` keyed by annotation. **Small:** Step 7 exports `extractImageFiles` instead of re-authoring its `DataTransferItem` quirk-handling. Confirmed against the code and left alone: `openUntitled(draftId, …)` gives a manual untitled buffer a real `draftId`, so [P02]'s base rule covers both save modes as claimed; and `AttachQuery` is `{doc: String, name: String}` today, matching Step 1's starting point. Laws named this round: [L02] (the trashed-URL state now participates in CM6 history rather than a parallel ref), [L07]/[L11] unchanged, [P05]/[P04] internal consistency restored. Deferred: nothing new.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The first attachment round ([dash/markdown-attachments.md](markdown-attachments.md), landed as `4888b9991`) shipped the storage story whole: `POST /api/attachments` for the composer's draft tier, `POST /api/fs/attach` for document-sibling `assets/` folders, a startup GC sweep in `tugcast/src/draft_gc.rs`, durable prompt-entry images across relaunch, and ⌘-click-to-open on asset links. That storage split is sound and survives this plan unchanged.

What it got wrong was above the storage line. The plan's own Strategy said "The Text card stays a raw-source editor. No image widgets, no preview pane", and `tug-text-card-editor.tsx`'s module docblock enshrines "What is deliberately NOT here (prompt-only concerns): atoms, completion/typeahead, inline attachment payloads". Executed faithfully, that doctrine produced two unrelated experiences sharing one word. A 2026-08-14 vetting read found: an image copied from the prompt entry pastes into a Text card as the literal text `image-1` (the label-substituted clipboard fallback — `tug-text-card-editor.tsx`'s `pasteWithTransform` reads `readClipboardViaNative()` and discards the `atoms` field); a screenshot pasted on a Text card does nothing at all; a drop on an unsaved buffer raises a card-modal `TugPaneBanner` whose detail panel renders empty because no `detailTitle`/`children` are passed, over a pane body the banner sets `inert` on; and a *successful* drop's entire feedback is a percent-encoded markdown link (`![Screenshot 2026-08-14 at 6.54.47 AM](assets/Screenshot%202026-08-14%20at%206.54.47 AM.png)`).

The decided replacement is recorded in [dash/markdown-attachments-follow-on.md](markdown-attachments-follow-on.md) — the brief this plan implements. Read it first; this document is its execution.

#### Strategy {#strategy}

- **Server first, deck second.** Every new storage behavior (draft-document asset homes, save-as migration, trash, git exclusion) lands and is unit-tested in tugcast before any deck code depends on it — the same sequencing the first round used successfully.
- **One shared resolution library.** `assets/`-link parsing, decoding, resolution, and encoding live in exactly one deck module that the strip, the drop path, the ⌘-click path, and the interop paths all call. Divergent parsers are how the two surfaces drifted the first time.
- **The strip is derived, never stored** ([P01]). No second source of truth for what a document has attached; the strip is a pure function of the buffer text plus disk.
- **Reuse `TugAttachmentPreview`, do not fork it** ([P10]). The Text card feeds a card-local `AtomBytesStore` from its projection and mounts the same component the prompt entry does, extended for non-image tiles.
- **Delete guards before affordances.** The trash and its undo land ([P07]) *before* the ✕ appears in the strip, so no shipped intermediate state can destroy a user's file irreversibly.
- **Remove the error vocabulary last but completely** — the modal banner comes out only once the failure paths that used it have somewhere honest to render ([P06]).

#### Success Criteria (Measurable) {#success-criteria}

- Drop `photo.png` on a Text card editing a **brand-new, never-saved** buffer: no error appears, `assets/photo.png` exists under the buffer's draft home, a link is inserted, and a strip tile shows the image. Save the buffer to `~/somewhere/notes.md`: `~/somewhere/assets/photo.png` exists byte-identical, the document text is unchanged, and the tile still renders. (App-test.)
- Copy an image atom from the prompt entry, paste into a Text card bound to `foo.md`: `assets/<name>` appears on disk **byte-identical to the originally attached file** (sourced from the atom's original-upload path, never its downsampled `content`), a markdown link is inserted, and a tile renders. Copy that link back out and paste into the prompt entry: an image atom with a thumbnail appears, and `buildWirePayload` yields a non-empty `content` for it. (App-test.)
- Copy a `[notes.zip](assets/notes.zip)` link from a Text card into the prompt entry: the markup appears as text with **no** tile and **no** atom. Paste it into a second Text card in a different directory: `assets/notes.zip` is copied there and a tile appears. (App-test.)
- ⌘V with a screenshot on the clipboard, in a Text card: a file appears in `assets/`, a link is inserted, a tile renders. Nothing is silently dropped. (App-test.)
- Hand-edit the document — type a link to an existing file in `assets/`, then delete it: the tile appears and disappears with the text, and ⌘Z restores both. (App-test.)
- ✕ on a strip tile removes the link text *and* moves the file to the macOS Trash (where Finder shows it with a working Put Back); ⌘Z restores the text and the file, byte-identical. (App-test.)
- No document text produced by any drop, paste, or migration contains `%20` or any other percent-escape. (Unit test over the encoder; app-test assertion on the inserted text.)
- `TugPaneBanner` no longer appears anywhere in `cards/text-card.tsx` for attachment failures, and at most one banner instance is rendered by that card. (Grep-level assertion in the step checkpoint plus a unit test on the derived-banner spec.)
- The first asset written into a git repo adds exactly one anchored line inside a `# tug:attachments` block in `.git/info/exclude`, and `git status --porcelain` reports nothing for that directory. A repo whose `assets/` is already tracked is unaffected. (Rust unit tests over real `git init` fixtures.)
- tugbank card-state writes stay positions-only for the Text card — the strip is derived, so nothing about attachments enters the bag. (Unit test on the Text card bag payload.)

#### Scope {#scope}

1. Draft-document asset homes so an untitled or draft buffer accepts attachments with no precondition, and migration of those assets when the document is saved to a real path.
2. A host bridge to the macOS Trash, and the compound undoable ✕ gesture that uses it.
3. The Text card's derived attachment strip (images and non-images), mounted below the editor.
4. Screenshot/image-data paste on the Text card.
5. Clipboard interop in both directions between the prompt entry's atoms and the Text card's links, including asset-copy on cross-document paste.
6. Removal of the attachment error banner and the double-banner `inert` defect; in-place failure states on tiles.
7. Human-readable link destinations everywhere.
8. Git exclusion of Tug-created `assets/` directories via `.git/info/exclude`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Inline rendering or link-chip decorations in the Text card document.** The buffer stays literal text; the strip is the only new visual surface. This is stronger than the first round's stance, not weaker.
- **A Tug trash UI, or any Tug-owned trash storage.** Assets go to the macOS Trash; Finder is the surface ([P07], [Q01]).
- **Committing assets to git.** Assets are excluded by default; a setting to opt a project (or document) back into committing is deferred ([Q02]).
- **Attachment support in Jots (`TugMessageEditor`) or other `TugTextEditor` hosts.** Unchanged from the first round's non-goals.
- **Non-`assets/` links in the strip.** Ordinary relative links between markdown documents are not attachments ([P12]).
- **Rewriting links when a document is moved by any means other than Tug's own Save As.** An external `mv` breaks relative links, as in every tool using this pattern.
- **The Gazette composer.** Already path-backed; untouched.

#### Dependencies / Prerequisites {#dependencies}

- The shipped first-round surface: `tugrust/crates/tugcast/src/attachments.rs` (`write_attachment_atomic`, `validate_asset_name`, `resolve_collision_name`, `store_doc_attachment`, `attachment_extension`), `tugrust/crates/tugcast/src/draft_gc.rs`, and `tugdeck/src/lib/attachment-upload.ts` (`uploadDocAttachment`, `uploadDraftAttachment`, `rehydrateDraftAttachments`, `toBase64`).
- `guard_absolute_path` / `fs_error` from `tugrust/crates/tugcast/src/fs_read.rs` — the [L29] canonicalization gateway for every path argument.
- `GET /api/fs/blob` (`tugrust/crates/tugcast/src/fs_blob.rs`) and its `mime_for_extension` table, which the strip's image tiles read through.
- `tugchanges-core::git::repo_root_for` (`tugrust/crates/tugchanges-core/src/git.rs`) — already a tugcast dependency (`tugcast/Cargo.toml` lists `tugchanges-core`), and the correct root finder for a linked worktree.
- `TugAttachmentPreview` (`tugdeck/src/components/tugways/cards/tug-attachment-preview.tsx`) and `AtomBytesStore` (`tugdeck/src/lib/atom-bytes-store.ts`).
- The clipboard sidecar: `TUG_ATOMS_MIME` / `TugAtomsClipboardPayload` / `serializeClipboard` / `parseClipboardSidecar` in `tugdeck/src/components/tugways/tug-text-editor/clipboard-filters.ts`, and the native pasteboard bridge `tugdeck/src/lib/tug-native-clipboard.ts` (`writeClipboardViaNative`, `readClipboardViaNative` — whose result carries `text` / `html` / `atoms` and **no image data**).
- `TextCardStore` (`tugdeck/src/lib/text-card-store.ts`) — `saveAs`, `openUntitled`, `openDraft`, `draftPathFor`, and the `draftId` / `path` / `untitled` snapshot fields.
- `tugdeck/src/lib/file-kinds.ts` (`VIEWABLE_EXTENSIONS`, `isViewableFile`, `blobUrl`) and `tugdeck/src/lib/open-file-in-card.ts` (`openFileInCard`).
- The host bridge in `tugapp/Sources/MainWindow.swift`: handlers are registered with `contentController.add(self, name:)` and dispatched in `userContentController(_:didReceive:)`. `openPath` shows the tilde-expansion + `NSWorkspace` shape; `clipboardRead` shows the request/response shape (a `requestId` in, a JSON-quoted `evaluateJavaScript` callback out). [Spec S03](#s03-trash-bridge) follows both.

#### Constraints {#constraints}

- **Warnings are errors** (`-D warnings` via `tugrust/.cargo/config.toml`).
- **[L29] canonicalization gateway.** Every path this plan persists or compares comes from `guard_absolute_path` output or from `tugcore::instance::data_dir()`. The trash index keys on a minted token, never on a path spelling — the same reasoning that made the first round's GC match UUIDs.
- Documents stay pure markdown: every inserted link must be standard CommonMark resolvable by non-Tug tools.
- No Web storage; persistence goes through tugbank or files.
- tugdeck laws: [L02] external state via stores + `useSyncExternalStore`, [L03] registrations in `useLayoutEffect`, [L06] appearance via CSS/DOM never React state, [L07] refs read at dispatch time, [L11] controls dispatch through the chain to the owner, [L23] single-channel state preservation.
- **Never hand-roll UI that exists as a Tug component** — the Text card's strip is `TugAttachmentPreview`, extended, not a new lookalike.
- App-tests run selectively via `just app-test-changed`; every new test carries a `@covers` header. Never pipe app-test output through a filter.
- Verify tugdeck changes with `bunx vite build` before declaring done (the debug app loads the prod rollup bundle).

#### Assumptions {#assumptions}

- `tugcore::instance::data_dir()` is stable across relaunches of the same instance (keyed by `TUG_INSTANCE_ID`), so draft-document asset homes and trash entries recorded in one session are reachable in the next.
- WebKit delivers image data on the DOM `paste` event inside Tug.app. This is how the prompt entry's screenshot paste works today: `TUG_ACTIONS.PASTE` is `routing: "native"` in `command-registry.ts`, so AppKit performs the paste against the WKWebView and a DOM `paste` event fires with `clipboardData.items`. The native bridge's read result carries no image data, so the DOM event is the only image-paste channel and the Text card must register a CM6 `domEventHandlers.paste` to see it.
- A document is edited by at most one Text card at a time in practice. Two cards on the same file would each project their own strip from the same text; the projections agree because they derive from the same source, so this needs no coordination.
- `git` is on `PATH` for the exclusion work (already assumed throughout tugchanges-core).
- App-tests run inside a real Tug.app, so the `trashPath` bridge is available to them; only browser-dev lacks it, and there ✕ reports failure rather than half-completing ([Spec S03](#s03-trash-bridge)).
- `NSWorkspace.recycle` can trash a file in a user project directory. Assets live beside the user's own documents on a normal volume; a location where trashing is refused (some network mounts) surfaces as a failed restore-less ✕, reported on the tile.

---

### Reference and Anchor Conventions {#reference-conventions}

This plan uses explicit `{#anchor}` headings, plan-local decisions labelled `[P01]`…, open questions `[Q01]`…, specs `S01`…, and risks `R01`…. Execution steps carry `**Commit:**`, `**References:**`, `**Depends on:**`, Tasks, Tests, and a falsifiable Checkpoint.

---

### Open Questions {#open-questions}

#### [Q01] A user-facing trash surface (DECIDED) {#q01-trash-surface}

**Question:** Should Tug offer a browsable "Trash" where a user can see and restore assets removed by ✕ beyond the undo window?

**Why it matters:** Undo covers the immediate mistake; a file discovered missing an hour later needs somewhere to be found. A Tug-private trash would have made this a real design problem — listing, search, restore-to-where, empty.

**Options:** a Lens section; a card; a menu command; the system Trash.

**Plan to resolve:** Decide the storage first — the surface question only exists if the storage is Tug-private.

**Resolution:** DECIDED (see [P07]) — the question dissolves. Assets go to the **macOS Trash**, so Finder already is the browse-and-restore surface, complete with Put Back, and the user's existing mental model applies with nothing new to learn. Tug builds no trash UI.

#### [Q02] Opting a project back into committing assets (DEFERRED) {#q02-commit-assets-setting}

**Question:** Where does the "commit this project's assets" setting live — per project, per document, or a deck-wide default?

**Why it matters:** It decides whether the setting is a tugbank default keyed by repo root, a per-card control, or a front-matter key.

**Options:** tugbank default keyed by canonical repo root; a Text card `…` menu toggle; a global default with per-project override.

**Plan to resolve:** Ship exclusion-by-default first ([P09]); the `# tug:attachments` block in `.git/info/exclude` is line-addressable, so any of these can drive it later.

**Resolution:** DEFERRED — no user-visible setting this phase. The brief records that committing is "a later mode".

#### [Q03] Asset lifetime when a document is deleted (OPEN) {#q03-orphan-assets}

**Question:** When a user deletes a markdown document, its `assets/` folder is orphaned. Does anything reclaim it?

**Why it matters:** Ephemeral screenshots accumulating in an ignored directory are invisible to `git status` (that is the point of [P09]) and therefore invisible to the user, so the usual "you can see it and delete it" answer is weaker than it was.

**Options:** nothing (user space, user's problem); a sweep verb on `tugutil`; count it as part of a future trash/maintenance surface.

**Plan to resolve:** Not resolvable from the code; needs use. The first round accepted the same exposure with `assets/` git-visible.

**Resolution:** OPEN — carried into the Roadmap ([#roadmap](#roadmap)) rather than solved here. Nothing in this plan forecloses any option.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Save-As asset migration loses or clobbers files | high | low | Copy-then-verify-then-remove, collision-resolved at the destination, rename map returned and applied to the document in one transaction ([Risk R01](#r01-migration-safety)) | Any report of a missing asset after Save As |
| ✕ destroys a file the user wanted | high | low | The file moves to the macOS Trash, never `unlink`; undo restores byte-identically from the reported URL; Finder's Put Back covers the user who never presses ⌘Z ([P07]) | Any report of an unrecoverable asset |
| Undo cannot restore because the user emptied the Trash | low | low | Report the failure on the tile rather than silently leaving the text edited ([P06]); the outcome matches every other Mac app | Users hit it often enough to want a warning |
| `.git/info/exclude` write surprises a user | med | low | Only exact anchored paths Tug created, inside a marked block, never a bare `assets/` pattern ([P09]) | A user reports a hidden source directory |
| The projection strip re-parses on every keystroke and costs typing latency | med | med | Parse is debounced and runs off the edit path; blob fetches are keyed and de-duplicated ([Risk R02](#r02-projection-cost)) | Any regression in the typing-lag campaign's metrics |
| Interop asset-copy silently duplicates large files | low | med | Copy happens only for `assets/`-scoped links pasted into a *different* document directory; same-directory paste is reference-only | Users report duplicate assets |
| Two Text cards on one document disagree | low | low | Both derive from the same text; no stored state to diverge | — |

**Risk R01: Save-As migration safety** {#r01-migration-safety}

- **Risk:** Moving a draft's `assets/` into the destination directory could overwrite an existing file of the same name, or leave the document pointing at names that changed.
- **Mitigation:**
  - The migration resolves collisions at the destination with the same `resolve_collision_name` the attach route uses, so nothing is ever overwritten.
  - It returns a rename map (`old relative name → new relative name`); the deck applies it to the buffer in a single transaction, so the document and disk stay consistent and one undo reverses the rewrite.
  - Files are copied and verified before the source is removed; a failure leaves the draft home intact and reports rather than half-moving.
- **Residual risk:** A destination directory the user cannot write to fails the migration; the document saves but its links break. Surfaced as failed tiles ([P06]), not a modal.

**Risk R02: Projection cost on the edit path** {#r02-projection-cost}

- **Risk:** The strip derives from the document text, and a naive implementation re-parses the whole buffer on every keystroke — exactly the class of writer the typing-lag campaign has been removing.
- **Mitigation:**
  - The parse is debounced (idle-triggered), never synchronous with the edit transaction.
  - The parse output is compared structurally; an unchanged link set publishes nothing, so a keystroke in prose costs one regex pass and no store write or React render.
  - The projection performs no byte I/O: tiles paint from `blobUrl(path)` ([P10]), so a re-parse costs a string compare and never a fetch, and WebKit's own `ETag` revalidation handles the rest.
- **Residual risk:** A very large document pays a regex pass per idle window. Bounded and measurable; the checkpoint measures it.

---

### Design Decisions {#design-decisions}

#### [P01] The Text card's strip is a projection of the document (DECIDED) {#p01-strip-is-projection}

**Decision:** The Text card's attachment strip is derived by parsing the buffer for `assets/`-scoped markdown links and resolving them against the document's asset base. There is no stored list of a document's attachments anywhere.

**Rationale:**
- The document is the source of truth for what it references; a parallel store could disagree with it, and the first thing a user does with a text editor is edit the text.
- It makes hand-editing links work with no extra machinery — the brief's stated requirement. Typing a link lights a tile; deleting it removes the tile; undo restores both.
- It makes "re-ification" of pasted markup automatic: pasted text that resolves simply appears in the strip, so no hidden "this was an attachment" state has to survive the clipboard.

**Implications:**
- Nothing about attachments enters the Text card's persisted bag ([L23] — the bag stays positions-only).
- The parse must be cheap and off the edit path ([Risk R02](#r02-projection-cost)).
- A link to a file that does not exist renders a *missing* tile rather than nothing, so a typo is visible instead of silent.

#### [P02] Every document has an asset base, including one that is not a file yet (DECIDED) {#p02-asset-base}

**Decision:** A document's asset base is `data_dir()/draft-docs/<draftId>/` whenever the card carries a `draftId`, and `dirname(path)` otherwise. Drops, pastes, link resolution, and the strip all resolve against that one answer.

**Rationale:**
- It removes the untitled precondition entirely, which the brief requires: an unsaved buffer has a real, writable directory from its first keystroke.
- Keying on `draftId` rather than `dirname(path)` covers both save modes uniformly. In **manual** mode an untitled buffer has `path === null` and only an aside record (`asidePathForUntitled` in `file-aside.ts`), so there is no directory to be a sibling of. In **automatic** mode `openDraft` gives a real path under `~/Library/Application Support/Tug/Drafts/`, whose `dirname` is *shared by every draft* — a sibling `assets/` there would collide across documents.
- The links stay relative and identical in form (`assets/x.png`) at every stage of the document's life, so migration rewrites nothing in the common case.

**Implications:**
- `POST /api/fs/attach` grows a `draft=<draftId>` alternative to `doc=<path>` ([Spec S01](#s01-attach-routes)).
- The deck needs to learn the absolute base for a draft, since `data_dir()` is per-instance and the deck does not compute it — hence `GET /api/fs/attach-base` ([Spec S01](#s01-attach-routes)).
- Save As must migrate ([P03]).

#### [P03] Save As migrates the asset home and rewrites only what it must (DECIDED) {#p03-migrate-on-save}

**Decision:** When a draft-backed buffer is saved to a real path, its `draft-docs/<draftId>/assets/` contents move into `dirname(newPath)/assets/`, colliding names are resolved at the destination, and the returned rename map is applied to the buffer in one transaction.

**Rationale:**
- The relative link is stable across the move by construction, so in the overwhelmingly common case the document text does not change at all — which is what makes the untitled story seamless rather than a rewrite-everything migration.
- Collisions must be resolved rather than overwritten; a destination `assets/photo.png` belonging to another document is not ours to clobber.
- Doing the rewrite in one transaction keeps undo coherent.

**Implications:**
- A new route `POST /api/fs/attach/migrate` ([Spec S01](#s01-attach-routes)).
- `TextCardStore.saveAs` grows a post-write migration step, before the snapshot rebind so the strip's next projection resolves against the new base.
- A migration failure is reported through the tile-failure channel ([P06]), never a modal.

#### [P04] The clipboard sidecar carries resolved absolute paths (DECIDED) {#p04-sidecar-abs-path}

**Decision:** `TugAtomsClipboardEntry` grows an optional `assetPath` (absolute, canonical) and `assetName` (the human name). A copy originating in any Tug surface fills it for every attachment in the selection; a paste destination uses it to copy bytes into its own asset base when needed.

**Rationale:**
- A relative link means nothing without its document. The absolute path is the only spelling that survives a hop through the clipboard into a surface with a different base — and the prompt entry, though it has a project directory, is not the document the link was relative to.
- It is the mechanism behind the brief's "asset copy when between text files": the destination knows exactly which bytes to copy.
- Plain text pasted from outside Tug carries no sidecar and therefore stays reference-only, which is the right default — arbitrary text should not trigger file copies.

**Implications:**
- `serializeClipboard` gains a resolver callback; the Text card supplies one, the prompt entry supplies one for atoms it can resolve.
- The sidecar `version` stays `1` — the fields are additive and optional, and readers that ignore them degrade to reference-only, which is a correct behavior rather than a broken one.
- **"Additive" is not free on the read side.** `parseClipboardSidecar` does not pass objects through — it validates and *reconstructs* every entry from a fixed field list, and `parseBytesEntry` likewise rebuilds `{content, mediaType, thumbnailDataUrl}` and nothing else. An added field that is not explicitly parsed is silently stripped on every paste. So the same change that adds `assetPath`/`assetName` to the writer must add them to `parseClipboardSidecar`, and `parseBytesEntry` must start preserving the `path` that `AtomBytesEntry` already carries — without which a prompt→document paste can only see the atom's *downsampled* bytes and would store a degraded copy of the image while looking correct.
- The native pasteboard path (`dev.tug.prompt-atoms`) carries it for free, since it is the same JSON.

**The sidecar geometry for a Text-card copy.** The payload schema is positional: `text` carries U+FFFC at each atom position and `atoms[i].position` points at one such character. A markdown link is a *range* of literal text, so the two attachment classes ride differently:
- An **image** asset link is substituted with U+FFFC in the sidecar `text` (the `text/plain` flavor keeps the literal markdown), with an entry whose segment is a real image atom carrying `assetPath`/`assetName` and no inline bytes. The prompt's existing `insertSidecar` then reconstitutes it as an image atom with no special casing, and fetches the bytes through `/api/fs/blob` from `assetPath`.
- A **non-image** asset link stays literal text in the sidecar, recorded in a new optional top-level `assets: [{from, to, assetPath, assetName}]` range list. The prompt inserts it as markup untouched — [P05] holds by construction, because there is no atom entry to place — and a Text-card destination uses the range to copy the bytes in and rewrite the destination when the link resolves outside its own base.

#### [P05] Non-images in the prompt entry are link markup, never atoms (DECIDED) {#p05-nonimage-is-markup}

**Decision:** The prompt entry keeps images-only for atoms. A non-image attachment copied from a Text card arrives in the prompt as its literal markdown link text, with no tile and no atom. This resolves the first round's deferred `[Q01]`.

**Rationale:**
- It is the brief's stated line, and it keeps the prompt's wire contract untouched (`build-wire-payload.ts`'s "text-file inline attachments not supported" stance holds).
- The markup round-trips losslessly: pasted back into a document it re-ifies into a real link with a tile, because the strip is a projection ([P01]).
- A file atom would be a third representation to keep consistent for no gain the model can use.

**Implications:**
- The prompt entry learns the *link scheme* (it must recognize `assets/` markup on paste well enough to leave it alone and to resolve it when it names an image), not a new atom type.
- A non-image dropped directly on the prompt from Finder inserts its absolute path as text ([P13]).

#### [P06] Failures render in place; there is no error vocabulary (DECIDED) {#p06-in-place-failures}

**Decision:** The attachment `TugPaneBanner` is deleted from `cards/text-card.tsx`. Every attachment failure renders as a strip tile in a failed state carrying the file's name and a retry affordance. The card renders at most one banner instance, derived from a single spec.

**Rationale:**
- The banner the user hit was a *designed refusal* dressed as an error; with the untitled case designed away ([P02]) what remains is disk-full, permission-denied, and server-down — genuinely rare.
- The codebase already holds this policy: `cards/transient-notice.ts`'s header says recoverable interruptions "must never lock the card the way the `error` banner does", and `gazette-card.tsx` renders its attachment failure as an inline label.
- The two sibling banners in `text-card.tsx` each set and remove `inert` on the same `.tug-pane-body` with no refcount, so whichever unmounts first un-inerts the body under the other. The Session card avoids this by construction (`session-card.tsx` renders one banner from a derived spec); the Text card adopts the same shape.
- A tile is where the user is already looking, and it names the specific file that failed — which a banner cannot.

**Implications:**
- `TugTextCardEditor`'s `onAttachmentError` prop is replaced by a failure channel into the projection ([Spec S02](#s02-projection-model)).
- The conflict banner stays, as the one derived banner.

#### [P07] ✕ moves the asset to the macOS Trash, and undo restores both halves (DECIDED) {#p07-trash-and-undo}

**Decision:** ✕ on a strip tile is one compound gesture: remove the link text from the document *and* move the asset file to the **system Trash** through a new `trashPath` host bridge backed by `NSWorkspace.recycle(_:completionHandler:)`. Undo moves the file back from the trash URL the host reported and restores the text in the same undo entry.

**Rationale:**
- A ✕ that only edited text would leave the file behind (accumulating invisibly, since assets are git-ignored); a ✕ that deleted the file would be an unrecoverable destructive act behind a small glyph.
- **Undo never needs "Put Back."** `recycle` returns a source→destination URL map, so restoring is a plain move from a URL we recorded ourselves. An earlier draft of this plan rejected the system Trash on the belief that programmatic Put Back was required and unreliable; that belief was wrong, and it was the only argument for inventing a Tug-private trash.
- It is the model the user already has: deleted things go to the Trash, you get them back from the Trash, emptying the Trash means gone. A Tug-private trash would answer "where did my file go?" with a location nobody can find, which is the opposite of the ergonomics this gesture is for.
- It deletes an entire invented concept: no token index, no retention policy, no grace period, no sweep, and no new user-facing surface to design ([Q01]).
- `recycle` additionally sets Finder's Put Back metadata, so a user who never presses ⌘Z can still restore by hand — a recovery path a private trash could not offer.

**Implications:**
- A `trashPath` **and** a `restorePath` `WKScriptMessageHandler` in `tugapp/Sources/MainWindow.swift`, following the request/response shape `clipboardRead` established. Both halves live in the host because the `fs` route family has no move verb and `/api/fs/write` is a text writer ([Spec S03](#s03-trash-bridge)).
- The document edit and the file move must be coupled through the history itself: the ✕ transaction registers an inverted effect (`invertedEffects`, the mechanism `atomInvertedEffects` already uses) carrying the trashed URL, so the undo transaction arrives with its own restore instruction and redo re-trashes symmetrically.
- Recovery is bounded by the user's own Trash rather than by a retention window. If they emptied it between ✕ and undo, the restore fails and says so through the failed-tile channel ([P06]) — an outcome the user can completely understand.
- Outside Tug.app (browser dev) the bridge is absent; ✕ reports failure rather than silently editing text and orphaning the file ([L23] honest feedback).

#### [P08] Link destinations are readable; no percent-escapes (DECIDED) {#p08-readable-destinations}

**Decision:** A destination containing characters that would break CommonMark parsing is wrapped in angle brackets — `![Screenshot](<assets/Screenshot 2026-08-14 at 6.54.47 AM.png>)` — rather than percent-encoded. `encodeLinkDestination` is replaced by this rule and the parser accepts both forms.

**Rationale:**
- The brief requires the user see the mapped character everywhere, and `%20` soup was the single most visible defect in the shipped drop.
- Angle-bracket destinations are standard CommonMark and render identically on GitHub, pandoc, and Obsidian.
- Sanitizing the stored filename instead (spaces → dashes) would reintroduce exactly the leak the first round's last fix removed: a document describing a file by a name the user never chose.

**Implications:**
- The parser in the shared link module accepts bare, angle-bracketed, and (for documents written by the shipped version) percent-encoded destinations, decoding all three to a real path.
- Only `<`, `>`, and a literal newline are impossible inside an angle-bracket destination; a filename containing `<` or `>` falls back to percent-encoding those two characters alone.

#### [P09] Tug-created asset directories are git-excluded by exact path (DECIDED) {#p09-git-exclude}

**Decision:** The first time an asset is written into a directory inside a git working tree, tugcast appends the anchored, repo-relative path of that `assets/` directory to `.git/info/exclude`, inside a `# tug:attachments` marked block. Never a bare `assets/` pattern, and never the project's `.gitignore`.

**Rationale:**
- These are overwhelmingly ephemeral screenshots; committing them to history forever is the wrong default.
- `.git/info/exclude` needs no commit, produces no working-tree diff, is invisible to collaborators, reverses by deleting a line, and is shared across worktrees of the same repo — so dash worktrees inherit the policy.
- Writing to the project's `.gitignore` would create an uncommitted diff in the act of avoiding uncommitted noise, and edits a file the user owns.
- A bare `assets/` pattern would hide a load-bearing source directory in an arbitrary repo. Exact anchored paths cannot collide with anything.
- Tracked files win over ignore rules in git's own semantics, so a project that later commits its assets is unaffected — the flip is safe in both directions with no migration.

**Implications:**
- Assets do not appear in the Changes card, and do not travel with a push (a pushed document renders broken images for others). Both accepted deliberately.
- The migration ([P03]) writes an exclusion at the destination repo and sweeps a stale one at the source.
- The block is line-addressable so [Q02]'s future setting can drive it.

#### [P10] The Text card mounts `TugAttachmentPreview`, extended for file tiles (DECIDED) {#p10-reuse-preview}

**Decision:** The Text card feeds a card-local `AtomBytesStore` from its projection and mounts the existing `TugAttachmentPreview`. The component gains a non-image tile rendering (icon + name) and a *missing* tile state; it does not gain a second implementation.

**Rationale:**
- The house rule is to never hand-roll UI that exists as a Tug component, and borrowing its CSS is still hand-rolling.
- The component already solves everything the Text card needs: `useSyncExternalStore` subscription, late-arriving thumbnails, the row-overflow measurement, click-to-zoom with paging, the ✕ affordance dispatching `REMOVE_ATTACHMENT` through the chain to the owner ([L11]), and focus-cycle authoring.
- Both surfaces then look and behave identically, which is the entire point of the round.

**Implications:**
- The projection mints synthetic `AtomSegment`s: `id` is a stable key derived from the link's resolved path, `label`/`value` the human name, `type` `"image"` or `"file"`.
- `AtomBytesEntry` needs no schema change for images. Non-image tiles carry no bytes — which means the component needs three specific changes, because today it is image-only by construction:
  1. `TileSnapshot` (built by `buildSnapshot`) carries no segment `type`, so a bytes-less tile is indistinguishable from one whose pixels have not arrived. Add `type` to the snapshot and to `snapshotKey`, or every file tile renders as the transparent reserved slot — invisible.
  2. `AttachmentPreviewTile` picks its `src` from thumbnail → content → `undefined`, and `undefined` with `broken === false` paints the placeholder. A `"file"` tile must take a fourth branch: an extension-derived glyph plus the name.
  3. The ✕ is gated on `deletable && (src !== undefined || tile.broken)`, so a file tile would never show one. The gate becomes `deletable && (src !== undefined || tile.broken || type === "file")`.
- **An image tile in the strip renders from its path, not from base64.** `AtomBytesEntry.content` is required today and is base64 with no `data:` prefix, and `AttachmentPreviewTile` paints `thumbnailDataUrl`, else `data:<mediaType>;base64,<content>`, else nothing — so a projection that filled the store the shipped way would hold every referenced asset's full bytes, base64-inflated, in memory for as long as the card is open. That is the prompt entry's contract, where the bytes must exist in JS because they go on the wire; the strip's do not. The entry already carries an optional `path`, and `GET /api/fs/blob` was built for exactly this (streamed, constant-memory, `ETag`-revalidated, `Range`-capable). So: carry `path` onto `TileSnapshot` and `snapshotKey`, add `blobUrl(path)` as a branch of the `src` ladder below `content`, and let the projection mint entries with an empty `content` — which requires relaxing `AtomBytesEntry.content` to optional, a change no existing producer notices since all of them fill it.
- Clicking a `"file"` tile reveals its link in the text rather than opening the image sheet — `openPreview` is image-only and must not be entered for a tile with no pixels.
- Multiple mounted strips are already safe: `registerAttachmentPreviewOpener` keeps a `Set` of openers and `openAttachmentPreview` tries each until one claims the atom, so a Text card strip and a Session card strip coexist without contention.
- The Text card registers a `REMOVE_ATTACHMENT` responder action, which is where [P07]'s compound gesture is implemented. The strip's `useControlDispatch` resolves the parent responder at its render location, so the strip must mount inside the card's `CardContentResponderScope`.

#### [P11] A pasted image is stored under a timestamped name (DECIDED) {#p11-paste-name}

**Decision:** Image data pasted with no filename is stored as `pasted-YYYY-MM-DD-HHMMSS.<ext>`, in the document's local time, with the extension from the media type via `attachment_extension`.

**Rationale:**
- The name appears in `git status`, in the folder, and in the link — it should say what the file is and when it arrived.
- `image-1.png` would collide conceptually with the prompt entry's `image-N` atom labels, which are per-message ordinals and mean something different.
- Collision resolution still applies on top, so two pastes in the same second are safe.

**Implications:** The name is minted server-side, in the attach route, when the caller supplies no `name` — so the timestamp and the write are one step, like collision resolution.

#### [P12] Only `assets/`-scoped destinations project into the strip (DECIDED) {#p12-strip-scope}

**Decision:** A link feeds the strip if and only if its destination resolves to a path under the document's own `assets/` directory.

**Rationale:**
- Roadmap and tuglaws documents are full of relative links to other documents; projecting all of them would produce a strip of dozens of tiles that are not attachments.
- `assets/` is the convention this feature writes, so it is learnable in one glance by anyone hand-editing.

**Implications:** A user who hand-writes a link to a file elsewhere gets a normal markdown link with no tile — correct, since Tug did not attach it.

#### [P13] A non-image dropped on the prompt inserts its absolute path (DECIDED) {#p13-prompt-nonimage-drop}

**Decision:** A non-image file dropped directly on the prompt entry from Finder inserts its absolute path as text, replacing today's bare-filename degradation.

**Rationale:**
- A path is genuinely actionable — the model can read the file — where a bare filename is not.
- It is consistent with [P05]: the prompt holds references to files as text, not as atoms.

**Implications:** A one-line change in `resolveDroppedFile`'s text degradation in `drop-extension.ts`; no new storage.

---

### Deep Dives {#deep-dives}

#### What the macOS document APIs can and cannot do for this feature {#macos-document-apis}

The untitled-buffer design ([P02]) invents a draft asset home, which invites the reasonable question of whether AppKit's document machinery already solves it. It was evaluated on 2026-08-14 and does not. Recorded here so it is not re-proposed.

**`NSDocument` / `NSDocumentController` — no.** Two independent reasons. First, Apple's answer to "a document with attachments" is a **file package**: a directory that presents as a single file, authored with `NSFileWrapper`, which is what RTFD is. That is exactly the shape the first round rejected and this round reaffirms — the document must stay a plain `.md` that `cat`, pandoc, GitHub, and Obsidian all agree on. An untitled `NSDocument` whose contents are a *single* autosaved file has precisely the sidecar problem we have, so it inherits the question rather than answering it. Second, `NSDocument` is bound to `NSWindowController` and the AppKit responder chain; Tug's documents are cards inside one WKWebView with the deck's own responder chain, so adopting it would invert the architecture. `TextCardStore` has already reimplemented the parts that pay — asides, Save As, Revert, Reload, hash-based conflict detection — and `file-aside.ts` documents itself as "the analog of macOS's `~/Library/Autosave Information`".

**The Trash — yes, and it changed the plan.** See [P07]. The operative fact is that `NSWorkspace.recycle(_:completionHandler:)` reports the destination URL, so undo restores with an ordinary move and never needs Finder's Put Back to be programmatically drivable. An earlier draft invented a Tug-private trash on the mistaken belief that it did.

**`NSFileCoordinator` / `NSFilePresenter`, `NSFileVersion` — real, but a different feature.** Both would improve the Text card's document story (coordinated I/O for synced folders; version browsing for free), neither touches attachments. Carried as follow-ons ([#roadmap](#roadmap)).

**Security-scoped bookmarks — no.** A bookmark survives a file being moved or renamed, which sounds like it would keep asset links alive across a Finder move. But a bookmark is an app-private binary blob, so a document referencing one is dead outside Tug — the same failure the first round rejected database-backed links for.

---

### Specification {#specification}

**Spec S01: The attach route family** {#s01-attach-routes}

All routes are loopback-only and take raw bytes as the body, consistent with the shipped `POST /api/fs/attach`.

| Route | Query | Body | Response | Notes |
|---|---|---|---|---|
| `POST /api/fs/attach` | `doc=<abs path>` **or** `draft=<draftId>`; `name=<filename>` optional | file bytes | `{ path, relativePath }` | `doc` keeps today's behavior exactly. `draft` writes into `data_dir()/draft-docs/<draftId>/assets/`, creating it. `name` omitted → minted per [P11] from the `Content-Type`. |
| `GET /api/fs/attach-base` | `draft=<draftId>` | — | `{ base }` | The absolute directory a draft's relative links resolve against. Created on demand so the answer is always a real directory. |
| `POST /api/fs/attach/migrate` | `draft=<draftId>`; `doc=<abs path>` | — | `{ renames: [{from, to}] }` | Moves the draft home's `assets/` into `dirname(doc)/assets/`, collision-resolved. Copy → verify → remove source. Empty `renames` is the common case. |

`draftId` is validated with the same single-ordinary-component rule as `validate_asset_name`, so it can never escape `draft-docs/`.

**Spec S02: The Text card projection model** {#s02-projection-model}

A single deck module owns the derivation. Its shape:

- `parseAssetLinks(text): AssetLinkRef[]` — every markdown link/image whose destination is `assets/`-scoped, with its document range, the decoded relative destination, and the label. Accepts bare, angle-bracketed, and percent-encoded destinations ([P08]).
- **Two resolvers, deliberately.** `resolveRelativePath(base, destination)` keeps the shipped `resolveAgainstDoc` semantics verbatim — any plain relative destination inside the document's tree, rejecting absolute paths, URLs, anchors, `.`/`..`, and empty segments — and remains what ⌘-click uses. `resolveAssetPath(base, destination)` is `resolveRelativePath` plus the `assets/`-first-segment requirement, and is what the strip projection uses ([P12]). Collapsing them would silently narrow ⌘-click: today a hand-written `images/diagram.png` link opens in a viewer card, and `assets/`-only resolution would make it inert.
- `AssetProjection` — a store ([L02]) holding the current tile set, fed by a debounced parse of the buffer plus resolution against the asset base ([P02]). It owns the card-local `AtomBytesStore` that `TugAttachmentPreview` reads ([P10]), minting path-only entries so image tiles paint straight from `/api/fs/blob` rather than from base64 the projection would have to hold.
- Tile states: **ready** (bytes present), **pending** (fetch in flight — the existing reserved-slot appearance), **missing** (resolved path does not exist — the existing `ImageOff` broken state, relabelled), **failed** (an attach or migration failed for this name, carrying a retry) ([P06]).

**Spec S03: The trash host bridge** {#s03-trash-bridge}

A new `trashPath` `WKScriptMessageHandler` registered in `MainWindow.swift` beside the existing handlers, using the request/response shape `clipboardRead` established (post a `requestId`, receive a callback via `evaluateJavaScript`).

Two handlers, not one: `trashPath` and `restorePath`. Both follow the request/response shape `clipboardRead` established (post a `requestId`, receive a callback via `evaluateJavaScript`).

| Direction | Payload |
|---|---|
| deck → host (`trashPath`) | `{ requestId, path }` (absolute; the host expands a leading `~` as `openPath` does) |
| host → deck | `{ requestId, ok: true, trashedPath }` or `{ requestId, ok: false, error }` |
| deck → host (`restorePath`) | `{ requestId, trashedPath, destination }` |
| host → deck | `{ requestId, ok: true, restoredPath }` or `{ requestId, ok: false, error }` |

- The host calls `NSWorkspace.shared.recycle([url])` and reports the destination URL from its completion handler's source→destination map. That URL is the whole restore mechanism — it needs no Put Back metadata and no Trash enumeration.
- **The restore is a host operation too, and it has to be.** The obvious cheaper design — "move it back through the existing `fs` write surface" — does not exist: `POST /api/fs/write` takes `content: String` and writes `content.as_bytes()` under a `baseline_sha256` precondition (`fs_write.rs`), so it is a text-document writer that would corrupt any binary asset routed through it, and the `fs` route family (`complete`, `read`, `blob`, `mkdir`, `stat`, `attach`, `write`) has no move or copy verb at all. Adding one would push a whole file's bytes through the JSON bridge for an operation the host can do with a single `FileManager.moveItem`, and the host is already holding the trashed URL it minted. So `restorePath` is the symmetric half of `trashPath`.
- The host resolves a collision at `destination` itself (suffixing as `resolve_collision_name` does) and reports the path it actually restored to, so the deck rewrites the re-inserted link's destination in the same transaction when they differ.
- **Both handlers must be torn down as well as registered.** `MainWindow.cleanupBridge()` removes every handler by name with `removeScriptMessageHandler(forName:)`; a handler added to `add(self, name:)` and not to that list holds `self` alive through the `WKUserContentController`. Add both names to both places.
- There is no Tug-owned trash directory, no token index, and no retention sweep: the user's Trash is the store and the user's Finder is the surface.
- Nothing persists across a relaunch. A trashed-file URL rides in the CM6 history as an inverted effect on the ✕ transaction, and dies with the editor state — undo across a relaunch was never offered for text edits either.

#### State Zone Mapping {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Text card tile set (the projection) | local-data | `AssetProjection` store + `useSyncExternalStore` | [L02] |
| Card-local `AtomBytesStore` for tiles | local-data | store instance owned by the card, subscribed by `TugAttachmentPreview` | [L02] |
| Drop ring / drop caret on the Text card | appearance | `data-drop-active` attribute + CSS (already shipped) | [L06] |
| Tile failed/pending/missing appearance | appearance | `data-*` attributes on the tile + CSS | [L06] |
| Debounced parse timer | structure | `useRef` inside the projection owner; never React state | [L24] |
| Asset base for the current binding | local-data | derived from the `TextCardStore` snapshot (`draftId` / `path`), read at dispatch time | [L07] |
| Projection registration + teardown | structure | `useLayoutEffect` | [L03] |
| Trashed-file URLs awaiting undo | structure | inverted `StateEffect` in the CM6 history (`invertedEffects`, as `atomInvertedEffects` does); never persisted | [L02] |
| Banner spec (conflict only) | local-data | derived from the store snapshot, one instance | [L02], [L23] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/git_exclude.rs` | `.git/info/exclude` marked-block management ([P09]) |
| `tugdeck/src/lib/os-trash.ts` | Deck half of the `trashPath` / `restorePath` host bridges ([Spec S03](#s03-trash-bridge)) |
| `tugdeck/src/lib/asset-links.ts` | Parse / decode / encode / resolve `assets/` links ([Spec S02](#s02-projection-model), [P08], [P12]) |
| `tugdeck/src/lib/asset-projection.ts` | The `AssetProjection` store ([P01], [Spec S02](#s02-projection-model)) |
| `tests/app-test/at0412-text-card-asset-strip.test.ts` | Strip projection, hand-edit, untitled drop, save-as migration |
| `tugdeck/src/components/tugways/tug-text-card-editor/asset-clipboard.ts` | Sidecar geometry + asset copy on paste ([P04], [P05]) |
| `tugdeck/src/components/tugways/tug-text-card-editor/asset-trash.ts` | ✕ + compound undo through `invertedEffects` ([P07]) |
| `tests/app-test/at0414-asset-trash-undo.test.ts` | ✕ + compound undo |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `AttachQuery` | struct | `tugcast/src/attachments.rs` | `doc` becomes optional; add `draft`, make `name` optional |
| `draft_doc_assets_dir` | fn | `tugcast/src/attachments.rs` | `data_dir()/draft-docs/<draftId>/assets` |
| `mint_pasted_name` | fn | `tugcast/src/attachments.rs` | [P11] timestamped name from a media type |
| `get_attach_base` | fn | `tugcast/src/attachments.rs` | `GET /api/fs/attach-base` |
| `post_attach_migrate` | fn | `tugcast/src/attachments.rs` | `POST /api/fs/attach/migrate` ([P03]) |
| `ensure_assets_excluded` | fn | `tugcast/src/git_exclude.rs` | Idempotent anchored-line insertion ([P09]) |
| `trashPath` / `restorePath` handlers | case | `tugapp/Sources/MainWindow.swift` | `NSWorkspace.recycle` and `FileManager.moveItem`; request/response like `clipboardRead`; both registered **and** removed in `cleanupBridge()` ([Spec S03](#s03-trash-bridge)) |
| `trashPathInOS` / `restoreTrashedPathInOS` | fn | `tugdeck/src/lib/os-trash.ts` | Resolve the trashed / restored path, or null off-host |
| `AtomBytesEntry` | interface | `tugdeck/src/lib/atom-bytes-store.ts` | `content` becomes optional so a projection tile can be path-only ([P10]) |
| `parseAssetLinks` / `encodeLinkDestination` / `resolveAssetPath` | fn | `tugdeck/src/lib/asset-links.ts` | `encodeLinkDestination` moves here from `file-drop.ts` and changes to [P08] |
| `AssetProjection` | class | `tugdeck/src/lib/asset-projection.ts` | [Spec S02](#s02-projection-model) |
| `uploadDocAttachment` | fn | `tugdeck/src/lib/attachment-upload.ts` | Accepts a base descriptor (`{doc}` or `{draft}`) and an optional name |
| `migrateDraftAssets` / `fetchAttachBase` | fn | `tugdeck/src/lib/attachment-upload.ts` | Deck side of the new routes |
| `TugAttachmentPreviewProps` | interface | `cards/tug-attachment-preview.tsx` | Non-image + missing/failed tile support ([P10]) |
| `TugAtomsClipboardEntry` / `TugAtomsClipboardPayload` | interface | `tug-text-editor/clipboard-filters.ts` | Add `assetPath` / `assetName` per entry and the top-level `assets` range list ([P04]) |
| `parseClipboardSidecar` / `parseBytesEntry` | fn | `tug-text-editor/clipboard-filters.ts` | Parse the new fields and preserve `bytes.path` — the parser reconstructs field-by-field, so unparsed fields are stripped ([P04]) |
| `extractImageFiles` | fn | `tug-text-editor/clipboard-filters.ts` | Becomes exported; the Text card's paste handler reuses it |
| `saveAs` | method | `lib/text-card-store.ts` | Migration step ([P03]) |
| `TugTextCardEditorProps` | interface | `tug-text-card-editor.tsx` | Drop `onAttachmentError`; add the projection wiring |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Rust unit** | Storage semantics — draft homes, migration collisions, trash round-trip, exclude-block idempotence | Every server step, against real temp dirs and real `git init` fixtures |
| **Deck unit (bun)** | Pure functions — link parsing/encoding across all three destination forms, projection diffing, sidecar round-trip | Every parser/serializer change |
| **App-test** | The gestures, driven against a real Tug.app: drop, paste, hand-edit, ✕, undo, save-as | Every user-visible behavior in the success criteria |

#### What stays out of tests {#test-non-goals}

- **Fake-DOM / RTL render tests of the strip** — banned in this project; the strip is covered by app-tests against the real component.
- **Mock-store assertion tests** for the projection — it is exercised through the real editor in app-tests; a mock would assert our own test double.
- **"The model describes the image"** — needs a live model. App-tests assert the `content.length > 0` gate that `buildWirePayload` actually uses, as the first round settled.
- **Percent-encoded legacy destinations beyond parsing** — we parse them so documents written by the shipped version keep working, but we do not test writing them, because we no longer write them.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Draft-document asset homes + attach-base route | done | `20776ae75` |
| #step-2 | Save-As asset migration route | done | `6e1e6a53f` |
| #step-3 | The trash host bridge | done | `2c189b35c` |
| #step-4 | Git exclusion of Tug-created assets directories | done | `a0b5436c9` |
| #step-5 | Shared asset-link library with readable destinations | done | `73d089331` |
| #step-6 | The projection store and the Text card strip | done | `50ea2879f` |
| #step-7 | Drops and pastes that never refuse | done | `b444662ac` |
| #step-8 | Remove the error vocabulary; one derived banner | done | `3db4b2c06` |
| #step-9 | Clipboard interop in both directions | done | `d7141113d` |
| #step-10 | The ✕ gesture with compound undo | done | `388b0ad7d` |
| #step-11 | Integration checkpoint | done | `1267632cd` |

---

#### Step 1: Draft-document asset homes + attach-base route {#step-1}

**Commit:** `tugcast(attachments): give a not-yet-saved document a real asset home`

**References:** [P02] Every document has an asset base, [P11] Timestamped paste names, Spec S01, (#context, #assumptions)

**Artifacts:**
- `AttachQuery` accepts `doc` **or** `draft`, with `name` optional
- `draft_doc_assets_dir`, `mint_pasted_name`, `get_attach_base` in `tugcast/src/attachments.rs`
- `GET /api/fs/attach-base` registered in `tugcast/src/server.rs`
- A `draft-docs/` pass in `draft_gc`

**Tasks:**
- [ ] Change `AttachQuery` to `{ doc: Option<String>, draft: Option<String>, name: Option<String> }`; exactly one of `doc`/`draft` must be present (400 `bad_request` otherwise).
- [ ] Add `draft_doc_assets_dir(draft_id) -> PathBuf` returning `tugcore::instance::data_dir().join("draft-docs").join(draft_id).join("assets")`. Validate `draft_id` with the same single-`Component::Normal` rule `validate_asset_name` uses, so it cannot escape.
- [ ] Factor the existing `store_doc_attachment` body so the assets directory is a parameter: the `doc` arm keeps its existing-regular-file precondition (which is what bounds the directory-creation relaxation — see that function's comment), the `draft` arm creates the draft home unconditionally since it is inside `data_dir()`.
- [ ] Add `mint_pasted_name(media_type, now) -> Option<String>` producing `pasted-YYYY-MM-DD-HHMMSS.<ext>` via `attachment_extension`; `None` for an unmapped type (the caller answers 415, matching `store_draft_attachment`). Take `now` as a parameter so the test is deterministic.
- [ ] When `name` is absent, mint it; when present, keep today's `validate_asset_name` path.
- [ ] Add `get_attach_base` handler for `GET /api/fs/attach-base?draft=<id>`, creating the directory and returning `{ base }` (the draft home, *not* its `assets/` child — the base is what relative links resolve against).
- [ ] Register the new route in `server.rs` beside the existing attach route, with the same `DefaultBodyLimit` posture where a body applies.
- [ ] **Reclaim abandoned draft homes.** A draft closed without saving (the "Don't Save" path, `discardAside`) leaves `draft-docs/<draftId>/` behind forever: the shipped `sweep_draft_attachments` walks **files only** and explicitly skips subdirectories ("a subdirectory is not ours to reason about"), so nothing collects these. Add `sweep_draft_docs(dir, root_json, grace, now) -> usize` removing a `draft-docs/<id>/` tree whose id appears in no root-set JSON and whose mtime is past `GRACE`, and call it from `sweep_at_startup`. The existing root set already suffices — the Text card's bag carries `draftId`, so the same substring match over card-state JSON that protects draft attachments protects these. Age the clock, not the files, in tests (the crate has no `filetime` dependency; `draft_gc.rs`'s tests already do this).

**Note on why the id match is safe here:** the sweep compares a draft id, not a path, for the same reason the shipped sweep compares a UUID — a spelling that fails to match would mean deleting live user bytes ([L29]).

**Tests:**
- [ ] `draft_attach_creates_the_home_and_lands_in_assets` — a `draft` write with no prior directory produces `draft-docs/<id>/assets/<name>` and returns `relativePath == "assets/<name>"`.
- [ ] `draft_id_cannot_escape_the_draft_docs_root` — `../`, `a/b`, empty, and a leading dot are all refused before anything is created.
- [ ] `doc_attach_behavior_is_unchanged` — the existing `doc_attachment_lands_in_a_sibling_assets_folder` and `doc_attachment_refuses_a_nonexistent_or_directory_doc` still pass verbatim.
- [ ] `minted_paste_name_is_timestamped_and_servable` — a `image/png` body with no `name` lands as `pasted-<stamp>.png`; an unmapped media type with no name answers 415.
- [ ] `attach_base_creates_and_reports_the_draft_home`.
- [ ] `sweep_removes_an_unreferenced_aged_draft_home` and `sweep_keeps_a_referenced_or_young_one` — the referenced case seeds a root-set JSON containing the draft id.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast attachments draft_gc`
- [ ] `cd tugrust && cargo build -p tugcast`

---

#### Step 2: Save-As asset migration route {#step-2}

**Depends on:** #step-1

**Commit:** `tugcast(attachments): move a draft's assets when the document gets a real home`

**References:** [P03] Save As migrates the asset home, Spec S01, Risk R01, (#r01-migration-safety)

**Artifacts:**
- `post_attach_migrate` in `tugcast/src/attachments.rs`
- `POST /api/fs/attach/migrate` registered in `server.rs`

**Tasks:**
- [ ] Implement `migrate_draft_assets(draft_id, doc) -> (StatusCode, Value)`: resolve the draft home, require `doc` to be an existing regular file (same precondition as the attach route), create `dirname(doc)/assets/`, then for each entry copy → verify byte length and content hash → remove the source, resolving collisions at the destination with `resolve_collision_name`.
- [ ] Collect `{ from, to }` for every entry whose name changed and return them as `renames`; return an empty array when nothing collided (the common case).
- [ ] On any failure, stop and leave the source intact — report `{ error }` with the entries already moved reflected in `renames` so the caller can still reconcile the document. Never leave a file existing in neither place.
- [ ] Remove the now-empty `draft-docs/<id>/` tree on full success.
- [ ] Register the route; `guard_absolute_path` is the gateway for `doc`.

**Tests:**
- [ ] `migration_moves_every_asset_and_reports_no_renames` — three files, empty destination, `renames == []`, all bytes identical at the destination, source tree gone.
- [ ] `migration_resolves_collisions_and_reports_them` — a destination already holding `photo.png` produces `photo-2.png` and one rename entry; the pre-existing file is untouched.
- [ ] `migration_leaves_the_source_intact_when_the_destination_is_unwritable` — a read-only destination directory yields an error and every source file still present.
- [ ] `migration_of_an_empty_or_absent_draft_home_is_a_no_op_success`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast attachments`

---

#### Step 3: The trash host bridge {#step-3}

**Commit:** `tugapp(trash): let the deck move a file to the macOS Trash`

**References:** [P07] ✕ moves the asset to the macOS Trash, Spec S03, (#s03-trash-bridge)

**Artifacts:**
- `trashPath` and `restorePath` message handlers in `tugapp/Sources/MainWindow.swift`
- `trashPathInOS` / `restoreTrashedPathInOS` in a deck module beside `lib/os-open.ts`

**Tasks:**
- [ ] Register `contentController.add(self, name: "trashPath")` and `…"restorePath"` alongside the existing handlers in `MainWindow.swift`, **and add both names to `cleanupBridge()`'s `removeScriptMessageHandler(forName:)` list** — that method removes each handler by name, so one left out of it keeps `self` retained by the `WKUserContentController` ([Spec S03](#s03-trash-bridge)).
- [ ] Handle `trashPath` in `userContentController(_:didReceive:)`: read `{ requestId, path }`, expand a leading `~` exactly as the `openPath` arm does, and call `NSWorkspace.shared.recycle([url])`.
- [ ] In the completion handler, report `{ requestId, ok, trashedPath }` back to JavaScript through the same JSON-quoted `evaluateJavaScript` callback pattern `clipboardRead` uses (which double-serializes to survive ` `/` `); on error report `ok: false` with the message.
- [ ] Handle `restorePath`: read `{ requestId, trashedPath, destination }`, `FileManager.moveItem` the file back, suffixing the destination name when it is occupied, and report the path actually restored to. The restore belongs to the host because the `fs` route family has no move or copy verb and `POST /api/fs/write` is a text writer (`content: String` → `content.as_bytes()`, under a `baseline_sha256` precondition) that would corrupt binary bytes ([Spec S03](#s03-trash-bridge)).
- [ ] Add the deck half — `trashPathInOS(path): Promise<string | null>` and `restoreTrashedPathInOS(trashedPath, destination): Promise<string | null>`, each resolving `null` when the bridge is absent (browser dev) or the host reported failure. Model the pending-callback map on `tug-native-clipboard.ts`.
- [ ] Confirm no tugcast route, no `data_dir()/trash`, and no retention sweep are introduced — the user's Trash is the store ([P07]).

**Tests:**
- [ ] App-test coverage lands with the gesture in [#step-10](#step-10) — this step's bridge has no behavior of its own to assert beyond a successful round-trip, which Step 10's ✕/undo test exercises end to end against the real host.
- [ ] Manual verification in a debug instance: trash a scratch file through the bridge and confirm it appears in Finder's Trash with a working Put Back.

**Checkpoint:**
- [ ] `just build-app`
- [ ] `cd tugdeck && bunx tsc --noEmit`

---

#### Step 4: Git exclusion of Tug-created assets directories {#step-4}

**Depends on:** #step-1, #step-2

**Commit:** `tugcast(attachments): keep Tug-created assets out of git by default`

**References:** [P09] Tug-created asset directories are git-excluded by exact path, Risk table (#risks)

**Artifacts:**
- `tugrust/crates/tugcast/src/git_exclude.rs` (new), declared in `main.rs`
- Calls from the attach and migrate paths

**Tasks:**
- [ ] Create `git_exclude.rs` with `ensure_assets_excluded(assets_dir: &Path)`: resolve the repo root via `tugchanges_core::git::repo_root_for` (already a tugcast dependency); return quietly when the directory is not inside a working tree (`repo_root_for` falls back to returning `dir` itself, so detect the non-repo case explicitly rather than trusting the return).
- [ ] **Find the exclude file through `git rev-parse --git-common-dir`, never by joining `<root>/.git`.** `repo_root_for` deliberately returns the *linked worktree's* root rather than the main repo's (its docblock says so — that is what makes the changes join correct), and in a linked worktree — every dash worktree — `.git` is a **file**, not a directory, so `<root>/.git/info/exclude` does not exist and `create_dir_all` on it fails. `--git-common-dir` answers with the shared `info/` in both layouts, which is also what makes [P09]'s "shared across worktrees" claim true: the rule written from a dash worktree is the same rule the main checkout reads, at the same worktree-relative path.
- [ ] Compute the path relative to `--show-toplevel` (the worktree root, which is what an anchored exclude line is resolved against) and write an **anchored** entry (`/dash/assets/`) into `<common-dir>/info/exclude`, inside a block delimited by `# tug:attachments` and `# end tug:attachments`. Create the block if absent; append inside it if present; do nothing if the exact line is already there (idempotent).
- [ ] Skip the write entirely when the directory's files are already tracked (`git ls-files --error-unmatch` on the directory), so a project that has chosen to commit its assets is never touched.
- [ ] Never write a bare `assets/` pattern, and never touch the project's `.gitignore` — assert both in tests.
- [ ] Call it from the `doc` arm of the attach route after a successful write, and from the migration's destination side; sweep the source repo's stale entry after a migration when its `assets/` directory is gone.
- [ ] Run it off the request's critical path (`spawn_blocking` alongside the write is fine); a failure is logged and never fails the attach.

**Tests:**
- [ ] `first_asset_writes_one_anchored_line_in_a_marked_block` — real `git init` fixture; assert the file's exact contents and that `git status --porcelain` is empty for that directory.
- [ ] `a_second_asset_in_the_same_directory_adds_nothing` — idempotence.
- [ ] `two_directories_get_two_anchored_lines_in_one_block`.
- [ ] `a_tracked_assets_directory_is_left_alone` — `git add` the directory first, then attach; assert `.git/info/exclude` is unchanged.
- [ ] `a_non_repo_directory_writes_no_exclude_file`.
- [ ] `the_project_gitignore_is_never_modified`.
- [ ] `a_linked_worktree_writes_into_the_shared_common_dir` — `git worktree add` a fixture, attach inside it, and assert the line landed in the main repo's `.git/info/exclude` (not in a `.git/info` under the worktree, which cannot exist) and that `git status --porcelain` is empty in the worktree.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast git_exclude attachments`

---

#### Step 5: Shared asset-link library with readable destinations {#step-5}

**Depends on:** #step-1

**Commit:** `tugdeck(assets): one parser for asset links, and no percent-escapes in prose`

**References:** [P08] Readable destinations, [P12] Only assets/-scoped destinations project, Spec S02, (#s02-projection-model)

**Artifacts:**
- `tugdeck/src/lib/asset-links.ts` (new)
- `encodeLinkDestination` removed from `tug-text-card-editor/file-drop.ts`
- Deck-side clients of the new routes in `tugdeck/src/lib/attachment-upload.ts`

**Tasks:**
- [ ] Create `asset-links.ts` with `parseAssetLinks(text): AssetLinkRef[]` — one pass over the document finding `![label](dest)` and `[label](dest)`, returning `{ from, to, label, destination, isImage }` where `destination` is **decoded**. Accept bare destinations, angle-bracketed `<…>`, and percent-encoded forms (documents written by the shipped version).
- [ ] Add `encodeLinkDestination(relativePath)` implementing [P08]: return the path bare when it contains none of space, `(`, `)`, `<`, `>`; wrap in angle brackets when it contains spaces or parentheses; percent-encode only `<` and `>` when the name itself contains them (then wrap).
- [ ] Add **both** resolvers per [Spec S02](#s02-projection-model): `resolveRelativePath(base, destination)` carrying `resolveAgainstDoc`'s exact current semantics, and `resolveAssetPath` = that plus the `assets/`-first-segment requirement ([P12]).
- [ ] Move `resolveAgainstDoc`'s callers — the `canOpenRelative` / `openRelative` pair passed to `anchorLinkExtension` in `tug-text-card-editor.tsx` — onto `resolveRelativePath`, **not** `resolveAssetPath`. ⌘-click must keep working for a hand-written non-`assets/` relative link; narrowing it would be a silent regression.
- [ ] While moving them: those callbacks read `storeRef.current.getSnapshot().path`, which is `null` for an untitled manual buffer, so ⌘-click is dead there today. Give them the asset base ([P02]) instead, so a link in an unsaved document opens like any other.
- [ ] Add `fetchAttachBase(draftId)` and `migrateDraftAssets(draftId, docPath)` to `attachment-upload.ts`, and widen `uploadDocAttachment` to take `{ doc } | { draft }` plus an optional `name`. (Trashing is a host-bridge call, not a route — see [#step-3](#step-3).)
- [ ] Update `linkForAsset` in `file-drop.ts` to use the new encoder. Its label contract is unchanged and must stay: **the label is the name the user dropped, never the collision-suffixed stored name** (see that function's docblock).

**Tests:**
- [ ] `parses_bare_angle_and_percent_encoded_destinations` — all three forms decode to the same path.
- [ ] `round_trips_a_name_with_spaces_without_percent_escapes` — encode → parse → identical, and the encoded form contains no `%`.
- [ ] `refuses_urls_anchors_absolute_and_dot_dot_destinations`.
- [ ] `only_assets_scoped_destinations_resolve` — `other/x.png` and `../assets/x.png` yield null.
- [ ] `an_image_link_and_a_plain_link_are_distinguished`.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/asset-links.test.ts`
- [ ] `cd tugdeck && bunx tsc --noEmit`

---

#### Step 6: The projection store and the Text card strip {#step-6}

**Depends on:** #step-5

**Commit:** `tugdeck(text-card): show what a document has attached, derived from its text`

**References:** [P01] The strip is a projection, [P10] Reuse TugAttachmentPreview, [P02] Every document has an asset base, Spec S02, Risk R02, (#state-zone-mapping)

**Artifacts:**
- `tugdeck/src/lib/asset-projection.ts` (new)
- `TugAttachmentPreview` extended for non-image and missing tiles
- The strip mounted in `cards/text-card.tsx` below the editor

**Tasks:**
- [ ] Create `AssetProjection`: holds the asset base, accepts `noteText(text)` from the editor's update listener (debounced, off the edit path — [Risk R02](#r02-projection-cost)), parses with `parseAssetLinks`, resolves with `resolveAssetPath`, and publishes a tile list plus a card-local `AtomBytesStore`. Structural diff before publishing so an unchanged link set notifies nobody.
- [ ] Mint image entries carrying only `{ path, mediaType }` and let the tile paint from `blobUrl(path)` ([P10]) — never fetch and base64 the file. The projection therefore does no byte I/O at all: `<img>` pulls through `/api/fs/blob`, which revalidates by `ETag` and streams. This is also what keeps [Risk R02](#r02-projection-cost)'s "blob fetches are keyed and de-duplicated" honest — there are no fetches to key.
- [ ] Mint synthetic `AtomSegment`s per [P10]: stable `id` derived from the resolved path, `label`/`value` the decoded human name, `type` `"image"` when `classifyFileKind` says image, `"file"` otherwise.
- [ ] Resolve the base from the `TextCardStore` snapshot: `fetchAttachBase(draftId)` when `draftId !== null`, else `dirname(path)` ([P02]). Re-resolve when the binding changes.
- [ ] Extend `TugAttachmentPreview` with the specific changes [P10] enumerates — `type` and `path` on `TileSnapshot` and `snapshotKey`, a `blobUrl(path)` branch and a `"file"` branch in `AttachmentPreviewTile`'s `src` ladder, the widened ✕ gate, and `AtomBytesEntry.content` relaxed to optional — plus a "missing" label on the existing `ImageOff` state. Keep every existing behavior for image atoms so the prompt entry is untouched.
- [ ] Mount the strip in `text-card.tsx` below the editor and above the find bar, **inside `CardContentResponderScope`** so its `REMOVE_ATTACHMENT` dispatch resolves to the card ([P10]), subscribed via `useSyncExternalStore` ([L02]), registered in a `useLayoutEffect` ([L03]).
- [ ] Confirm nothing about attachments enters `TextCardBagContent` — the bag stays positions-only.

**Tests:**
- [ ] Deck unit: `projection_publishes_nothing_when_the_link_set_is_unchanged` (diffing), `projection_distinguishes_image_and_file_tiles`, `projection_marks_an_unresolvable_link_missing`.
- [ ] App-test `at0412` (new, with `@covers` for `asset-projection.ts`, `asset-links.ts`, `cards/text-card.tsx`): open a document that already contains an `assets/` image link and assert a tile renders; type a second link by hand and assert a second tile appears; delete it and assert the tile goes; ⌘Z and assert it returns.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test at0412-text-card-asset-strip.test.ts`

---

#### Step 7: Drops and pastes that never refuse {#step-7}

**Depends on:** #step-2, #step-6

**Commit:** `tugdeck(text-card): accept every drop and paste, saved or not`

**References:** [P02] Every document has an asset base, [P03] Save As migrates, [P11] Timestamped paste names, [P13] Non-image prompt drops, Spec S01, (#success-criteria)

**Artifacts:**
- The untitled guard removed from `tug-text-card-editor/file-drop.ts`
- Image-data paste on the Text card
- Migration wired into `TextCardStore.saveAs`

**Tasks:**
- [ ] Delete the `docPath === null` refusal in `file-drop.ts`'s `onDrop` and route the upload through the asset-base descriptor ([P02]) so an untitled buffer attaches into its draft home.
- [ ] Register a CM6 `domEventHandlers.paste` on the Text card editor that extracts image files from `clipboardData.items` — **export `extractImageFiles` from `clipboard-filters.ts` and reuse it**, rather than re-authoring its `DataTransferItem` quirk-handling — uploads them with no `name` (server mints per [P11]), and inserts links in one transaction. (Step 9 later widens this same handler with the sidecar branch; leave text pastes falling through to the default here.) This is the only image-paste channel: the native bridge's read result carries no image data (see #assumptions).
- [ ] Wire migration into `TextCardStore.saveAs`: after the successful write and **before** the snapshot rebind, call `migrateDraftAssets(draftId, newPath)`; apply any returned renames to the buffer through the bridge in one transaction.
- [ ] Change the non-image degradation in `drop-extension.ts`'s `resolveDroppedFile` to insert the absolute path ([P13]).
- [ ] Keep the drop caret, the drop ring, and the one-transaction/one-undo property exactly as shipped.

**Tests:**
- [ ] App-test in `at0412`: create a brand-new untitled Text card, drop an image, assert no banner appears, a link is inserted, and a tile renders; then Save As into a temp directory and assert the asset is present beside the saved file, the document text is unchanged, and the tile still renders. (Use `fs.realpathSync(fs.mkdtempSync(...))` — macOS `/var` canonicalizes to `/private/var` and a raw temp path will fail the comparison.)
- [ ] App-test in `at0412`: paste image data into a bound document and assert a `pasted-*` file lands with a link and a tile.
- [ ] Deck unit: the rename map is applied to the buffer text correctly for a colliding migration.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test at0412-text-card-asset-strip.test.ts`

---

#### Step 8: Remove the error vocabulary; one derived banner {#step-8}

**Depends on:** #step-6, #step-7

**Commit:** `tugdeck(text-card): failures show on the thing that failed, not in a modal`

**References:** [P06] Failures render in place, (#p06-in-place-failures, #risks)

**Artifacts:**
- The attachment `TugPaneBanner` deleted from `cards/text-card.tsx`
- `onAttachmentError` removed from `TugTextCardEditor`
- A single derived banner spec for the conflict case

**Tasks:**
- [ ] Delete the second `TugPaneBanner` and the `attachmentError` `useState` from `text-card.tsx`.
- [ ] Replace `onAttachmentError` on `TugTextCardEditor` with a failure channel into the projection: a failed attach records a failed tile carrying the file's name and a retry ([Spec S02](#s02-projection-model)).
- [ ] Render the remaining conflict banner from **one** derived spec, following the Session card's pattern (`session-card.tsx` derives a single banner and documents the mutual-exclusion-by-construction invariant), so two instances can never both toggle `inert` on `.tug-pane-body`.
- [ ] Add the failed-tile appearance to `TugAttachmentPreview` via `data-*` + CSS ([L06]), with a retry affordance that re-runs the upload for that file.
- [ ] Sweep for any other attachment-error copy left in the tree (the "Save the file first" string must be gone).

**Tests:**
- [ ] Deck unit: the banner spec derivation yields at most one banner for every combination of conflict/save-mode inputs.
- [ ] App-test in `at0412`: force an attach failure (drop into a document whose `assets/` path is unwritable), assert no banner and no `inert` on the pane body, and assert a failed tile naming the file.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test at0412-text-card-asset-strip.test.ts at0210-text-card-options.test.ts`

---

#### Step 9: Clipboard interop in both directions {#step-9}

**Depends on:** #step-6, #step-7

**Commit:** `tugdeck(attachments): images and links travel between the prompt and a document`

**References:** [P04] The sidecar carries resolved absolute paths, [P05] Non-images are markup, [P10] Reuse TugAttachmentPreview, (#success-criteria)

**Artifacts:**
- `assetPath` / `assetName` on `TugAtomsClipboardEntry`
- Sidecar-aware copy and paste on the Text card editor
- Asset-aware paste in the prompt entry

**Tasks:**
- [ ] Add optional `assetPath` / `assetName` to `TugAtomsClipboardEntry`, the optional top-level `assets` range list to `TugAtomsClipboardPayload`, and fill them in `serializeClipboard` through a new resolver callback ([P04]). Version stays `1` — the fields are additive and a reader that ignores them degrades to reference-only.
- [ ] **Extend the parsers, not just the writers.** `parseClipboardSidecar` validates and reconstructs entries field-by-field, so an unparsed field is stripped on every paste: teach it `assetPath`/`assetName` and the `assets` range list, and teach `parseBytesEntry` to preserve `AtomBytesEntry.path` (today it rebuilds `{content, mediaType, thumbnailDataUrl}` and drops the rest). A deck unit test that round-trips serialize → JSON → parse and compares deep-equal is the guard; it fails today.
- [ ] Text card **copy**: serialize per [P04]'s geometry — image asset links substituted as U+FFFC entries carrying `assetPath`/`assetName`, non-image links recorded in the `assets` range list — and write it through `writeClipboardViaNative`, replacing today's always-empty sidecar. The plain-text flavor stays the literal markdown, so external apps get exactly what the document says.
- [ ] Text card **paste** — one shared routine behind **both** entry points, which is what "stop discarding `atoms`" means concretely: `pasteWithTransform` (the responder route — it already calls `readClipboardViaNative` and destructures only `{ text }`) and Step 7's CM6 `domEventHandlers.paste` (the DOM route, which cannot see the `dev.tug.prompt-atoms` pasteboard type in `clipboardData` and must ask the bridge, exactly as `clipboard-filters.ts`'s branch 2b does for the prompt). Two implementations of one gesture is how the surfaces drifted the first time.
- [ ] In that routine: an image-atom entry becomes an upload into this document's asset base plus a minted link replacing its U+FFFC — sourcing the bytes from the entry's `assetPath` (or `bytes.path`) via `/api/fs/blob`, never from `bytes.content`, which is the downsample output; an `assets` range whose link resolves outside this document's base is copied in (asset copy between text files, per the brief) and left reference-only when it already resolves here.
- [ ] Prompt entry **paste**: when a sidecar entry carries an `assetPath` naming an image, fetch it through `/api/fs/blob` and mint a real image atom with bytes; `insertSidecar` needs no non-image special case because non-image links never arrive as entries ([P04] geometry, [P05]).
- [ ] Prompt entry resolution base: use the sidecar's absolute path when present; fall back to the session's project directory for bare pasted text.

**Tests:**
- [ ] Deck unit: serialize → JSON → `parseClipboardSidecar` round-trips deep-equal — `assetPath`/`assetName`, the `assets` range list, and `bytes.path` all survive; a v1 payload without any of them parses unchanged.
- [ ] Deck unit: the sidecar geometry — an image link becomes a U+FFFC atom entry, a non-image link stays literal text in the `assets` range list, and every offset indexes the payload's own text rather than the document's.

**Note — why the interop has no app-test.** This step planned an `at0413` driving ⌘C in one Text card and ⌘V in another. It cannot be written against this harness. ⌘C / ⌘V are `routing: "native"` commands, so what runs is the editor's DOM `copy` / `paste` handler; delivering those events by hand is fine (the drop and paste tests already do it), but the copy needs a real CM6 selection first, and neither route to one exists here — ⌘A is swallowed because the harness cannot make an editor the responder chain's leaf ([app-test chain first responder]), and a DOM `Selection` set directly does not stick in the app-test's background window. Both limits are pre-existing and recorded. So the geometry — the part with real design risk, and the part that caught an offset bug on its first run — is pinned by unit tests, and the file-copy half is verified in the walkthrough below.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `cd tugdeck && bun test src/components/tugways/tug-text-card-editor/__tests__/asset-clipboard.test.ts src/components/tugways/__tests__/tug-text-editor-clipboard.test.ts`

---

#### Step 10: The ✕ gesture with compound undo {#step-10}

**Depends on:** #step-3, #step-6

**Commit:** `tugdeck(text-card): removing an attachment takes the link and the file, and undo brings both back`

**References:** [P07] ✕ moves the asset to the macOS Trash, Spec S03, (#s03-trash-bridge)

**Artifacts:**
- `REMOVE_ATTACHMENT` handled by the Text card
- Trash + restore coupled to the CM6 undo stack

**Tasks:**
- [ ] Register a `REMOVE_ATTACHMENT` responder action on the Text card ([L11] — the strip dispatches, the owner performs), resolving the atom id back to its link range through the projection.
- [ ] Perform the compound gesture: remove the link's text range in one transaction, and call `trashPathInOS(resolvedPath)`; when it resolves, record `{trashedPath, originalPath}` against that change.
- [ ] **Couple to undo through `invertedEffects`, not a hand-watched update listener.** The tree already holds the precedent: `atomInvertedEffects` (`tug-text-editor/atom-decoration.ts`) uses `@codemirror/commands`' `invertedEffects` facet — its docblock calls it "the supported hook for make a custom field's state survive undo" — to re-attach atom decorations when history re-inserts their text. Register the ✕ transaction with an inverted `restoreAssetEffect` carrying `{trashedPath, originalPath}`; when the user undoes, history replays that effect in the undo transaction itself, and the editor's effect handler calls `restoreTrashedPathInOS(trashedPath, originalPath)` — the host performs the move ([Spec S03](#s03-trash-bridge)); there is no `fs` move route and `/api/fs/write` cannot carry binary bytes. Register the inverse direction too (`restoreAssetEffect` inverts back to a `trashAssetEffect`), so redo re-trashes and a second undo re-restores — cycles work without any bookkeeping of "is this change currently undone," which is exactly the state a hand-rolled listener has to invent and then get wrong.
- [ ] When the host reports a restored path different from the one asked for (the original was occupied), rewrite the re-inserted link's destination in a follow-up transaction marked `addToHistory: false`.
- [ ] Report a failed restore (Trash emptied, file moved) on the tile ([P06]) rather than leaving the text silently edited.
- [ ] Enable `deletable` on the Text card's strip only now, so no shipped intermediate state can remove a file without a restore path.
- [ ] Confirm the ✕ is the only mutation affordance on a Text card tile — no rename, no replace.

**Tests:**
- [ ] App-test `at0414` (new, `@covers` `cards/text-card.tsx`, `asset-projection.ts`, `tug-attachment-preview.tsx`, `lib/os-trash.ts`): ✕ a tile, assert the link text is gone and the file is no longer in `assets/`; ⌘Z and assert both the text and the file return, byte-identical. Assert against the file's own bytes, not the Trash location — the test must not depend on the user's Trash contents.
- [ ] App-test in `at0414`: ✕ two tiles and undo twice; assert both files return to `assets/`.
- [ ] **Every ✕ in this file must be undone before the test ends.** These tests trash real files into the running machine's Trash, so a test that trashes without restoring leaves litter behind on every run — a developer's Trash slowly filling with `photo.png` is a self-inflicted wound the harness cannot clean up for us. Assert the restore, and treat "the file is back in `assets/`" as the closing assertion of every case that presses ✕.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test at0414-asset-trash-undo.test.ts`

---

#### Step 11: Integration checkpoint {#step-11}

**Depends on:** #step-4, #step-8, #step-9, #step-10

**Commit:** `N/A (verification only)`

**References:** [P01]–[P13], (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Walk every Success Criterion by hand in a debug instance built with `just app-debug`, including the git-status check on a real repo.
- [ ] Confirm no attachment path produces a percent-escape in document text.
- [ ] Confirm `cards/text-card.tsx` renders at most one `TugPaneBanner` and none for attachments.
- [x] Rename the duplicate app-test number: `at0409-attachment-durability.test.ts` and `at0409-plan-review-borrow.test.ts` both existed on `main`; the durability test is now `at0413-attachment-durability.test.ts`.
- [ ] Update `dash/markdown-attachments.md`'s Status to record that this follow-on supersedes its raw-source-editor doctrine, its untitled guard, and its `[Q01]`.

**Tests:**
- [ ] The full new-test set plus the first round's, run together.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test at0410-text-card-file-drop.test.ts at0412-text-card-asset-strip.test.ts at0413-attachment-durability.test.ts at0414-asset-trash-undo.test.ts`
- [ ] `just app-test-covers-check`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Attaching a file means one thing in Tug — drop or paste anything, anywhere, saved or not; see it in a strip below the editor; move it between the prompt and a document by copy/paste; remove it with a ✕ that undo can take back; and never meet a modal error.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every Success Criterion in [#success-criteria](#success-criteria) verified by an automated test or the Step 11 walkthrough.
- [ ] No `TugPaneBanner` for attachment failures anywhere; at most one banner instance in the Text card.
- [ ] No percent-escapes in any document text Tug writes.
- [ ] `git status` is clean after attaching in a repo; `.git/info/exclude` carries one marked block of anchored paths; the project `.gitignore` is untouched.
- [ ] The Text card's persisted bag remains positions-only.
- [ ] `cargo nextest run -p tugcast` green; `bunx tsc --noEmit` and `bunx vite build` clean; the five app-test files green.

**Acceptance tests:**
- [ ] `at0412-text-card-asset-strip.test.ts`
- [ ] The interop's sidecar geometry, as deck unit tests — see the Step 9 note on why it is not an app-test.
- [ ] `at0414-asset-trash-undo.test.ts`
- [ ] The first round's `at0410-text-card-file-drop.test.ts` and the attachment-durability test still green.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] A setting to commit a project's or document's assets ([Q02]).
- [ ] Reclaiming assets orphaned by a deleted document ([Q03]).
- [ ] Attachments in Jots and other `TugTextEditor` hosts (carried from the first round's `[Q02]`).
- [ ] The Gazette `.img` extension fallback — a pre-existing latent bug noted by the first round.
- [ ] **`NSFileCoordinator` / `NSFilePresenter` for the Text card's document I/O.** Tug detects external changes with its own hash comparison plus a filesystem watcher; coordinated reads/writes are the system answer and behave correctly for documents in iCloud- or Dropbox-synced folders, where an uncoordinated write can lose data. Out of scope here (it is the conflict-banner story, not the attachment story), but it is the strongest remaining macOS document API for Tug to adopt.
- [ ] **`NSFileVersion` for document history.** Would give the Text card Time-Machine-style "Browse All Versions" over any file with no storage of our own. Independent of attachments; noted because it is the other document API that pays off without requiring `NSDocument`.
- [ ] **`UTType` for minted paste names.** `attachment_extension`'s hardcoded 12-entry table could defer to the system's media-type↔extension mapping for the document tier, which now accepts any file type. Needs a Rust→Swift hop, so it is only worth it if the table starts costing real misses.

| Checkpoint | Verification |
|------------|--------------|
| Server storage semantics | `cd tugrust && cargo nextest run -p tugcast` |
| Deck types and bundle | `cd tugdeck && bunx tsc --noEmit && bunx vite build` |
| The gestures, end to end | `just app-test at0412-… at0414-…` |
| Test coverage declarations | `just app-test-covers-check` |
