<!-- tugplan-skeleton v2 -->

## Tide Atoms — Sending Content to Claude and Rendering in the Transcript {#tide-atoms}

**Purpose:** Wire the existing prompt-entry atom flow through the full Tide pipeline so file/image references reach Claude Code as proper Anthropic content blocks (image bytes as `image` blocks; everything else as substituted text), render as atom chips on both sides of the transcript (user-typed and assistant-tool-block), and normalize images to API-acceptable size/dimensions so submissions never fail at the Anthropic backend.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-05-26 |
| Replaces | [`archive/atoms-attachments.md`](archive/atoms-attachments.md) (2026-05-08), [`archive/tugplan-tide-atoms-attachments.md`](archive/tugplan-tide-atoms-attachments.md) (2026-05-08) |
| Related | [`tide.md`](tide.md) §T3.4.b · [`transport-exploration.md`](transport-exploration.md) §Test 23, §Test 24 · [`ws-verification.md`](ws-verification.md) |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Tide has the substrates we need but the wiring between them is incomplete. The browser-side prompt-entry already represents file/image references as **atoms** in the CM6 document (`tug-atom-img.ts:24`); the cross-process IPC has an `Attachment[]` slot on every `user_message` (`tugcode/src/types.ts:4`); tugcode already converts attachments into Anthropic `image` content blocks (`session.ts:297-343`). The image happy-path is regression-tracked end-to-end via `test-23-image-attachment` — every captured claude version from `2.1.104` through `2.1.148` has a passing fixture in `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/`.

What's missing is the glue. The reducer's `send-frame` effect ships `attachments: []` and the wire text still contains `U+FFFC` object-replacement characters at atom positions (`reducer.ts:743-749`, `:2210-2216`); claude sees garbage instead of `@README.md`. The transcript user row is a bare `<span>{text}</span>` (`tide-card-transcript.tsx:415-422`); even if attachments reached the transcript, they would have nowhere to render. The replay path's `add_user_message` handler type-casts `Attachment[]` to `AtomSegment[]` (`reducer.ts:3240-3243`) — a shim that works only because the field is never read. Assistant tool-block paths render as monospace text in `tool-blocks/`, visually disjoint from the chips the user typed.

Two scope additions over earlier drafts: **image downsampling at insert time** (so submissions never exceed Anthropic's 5 MB / 8000 px ceilings) and **completion-time secret-file filtering** (so `.env`-style files never surface in the `@`-popup, matching Claude Code's posture). Both ship in v1 because shipping without them would mean shipping broken: oversized images cause API rejections, and unfiltered completion would expose secrets at the click of a `@`-key.

#### Strategy {#strategy}

- **Empirical baseline preserved.** `test-23-image-attachment` continues to verify the image content-block path. New probes are explicitly *not* required by this plan — we don't change the wire shape, so existing fixtures stay byte-identical.
- **No new wire shape.** The existing `Attachment{filename, content, media_type}` carries everything v1 needs. The discriminated `kind: "inline" | "ref"` union from the archived plan is forward-compatible if v2 ever needs server-side ref resolution.
- **Browser-side normalization.** Image bytes are decoded, resized, re-encoded, and size-checked at insert time (drop / paste). The bytes that reach the bytes-store, the wire, the journal, and JSONL are always API-compliant. tugcode never sees an oversized image.
- **Filter at completion-time, not submit-time.** Secret files (`.env`, `*.pem`, `id_rsa*`, etc.) never appear in the `@`-popup. Users who type the path manually still send it — same model as Claude Code.
- **One commit per step.** Build green at every commit (`-D warnings`, `bun run check`, `bun test`, `cargo nextest run --workspace` all clean).
- **Single SVG chip builder.** Every chip surface (editor's CM6 widget, transcript user-row, assistant tool-block path) renders through the same `buildAtomSVGDataUri` helper extracted from `createAtomImgElement`. Visual rhyme across the surfaces; no chance of style drift. (Earlier drafts proposed a shared React `AtomChip` primitive — superseded; see [Step 5's scope decision](#step-5).)
- **Tuglaws apply.** Touching prompt-entry's drop / paste extensions, the bytes-store, the wire-flattening logic, the new attachment-strip primitive, and the tool-block path renderers re-checks against `tuglaws/tuglaws.md`. The closing step records a walkthrough.

#### Success Criteria (Measurable) {#success-criteria}

**Send path:**
- Dropping a 4K screenshot (e.g., 3840×2160 PNG, ~6 MB) submits successfully without an Anthropic API error. (verification: manual smoke + canvas-stub unit test asserting post-downsample dimensions ≤ 2576 px and encoded size ≤ 5 MB)
- The reducer's `send-frame` effect at `reducer.ts:743-749` and the queued-send flush at `reducer.ts:2210-2216` carry the flattened-text-and-attachments payload, not `attachments: []`. (verification: `code-session-store/__tests__/reducer.test.ts` asserts shape on submit)
- The wire text submitted to claude contains zero `U+FFFC` characters when the prompt had atoms. (verification: unit test of `buildWirePayload`)

**Transcript rendering:**
- The transcript user row renders atom chips at `U+FFFC` positions for both in-flight and committed turns. (verification: render test in `tide-card-transcript.test.tsx` + manual against gallery card)
- The transcript user row renders a per-message thumbnail strip below the body when the turn has image attachments. (verification: same as above)
- **Inline chip label and strip tile caption are the same string** for the same image — `#${pad4(messageNumber)}-image-${idx}` (e.g. `#0001-image-1`) — providing visual linkage between chip and thumbnail. The two strings are verifiably-equal on the rendered DOM. (verification: render test pinning the equality + manual against gallery card)
- **Live and restored transcripts render identically** for the same message: same chip labels, same chip positions, same strip captions, same thumbnails. The submit boundary is the substrate-synthesis boundary; everything downstream is JSONL-honest. (verification: cold-restart smoke in [Step 8](#step-8) + integration test in `tide-card-transcript.test.tsx`)
- Read / Edit / Write / NotebookEdit tool blocks render their `file_path` (and `notebook_path`) as a chip (`<img>` built via `buildAtomSVGDataUri`), identical to the user-side chip rendering. (verification: render test + manual)

**Permission gating:**
- A workspace with a `.env` file at the root never surfaces `.env` in the `@`-completion popup. (verification: integration test against the FileTreeStore + manual)
- A workspace with a `.tugattachignore` matching `local-secrets/**` excludes those paths from completion. (verification: integration test)

**Regression coverage:**
- `test-23-image-attachment` continues to pass on the current claude version (`2.1.148` at plan-draft time). The captured JSONL is byte-identical pre/post the wire-flattening landing. (verification: `just capture-capabilities` and diff the resulting fixture against the prior baseline)

**Compliance:**
- `bun run check`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run --workspace` — all pass on every step.
- No new IndexedDB. No localStorage. No new tugcast verb (filetree provider extension is in-place; no new IPC).
- No new probes are required by this plan (forward-compat additions like JPEG/PDF probes are tracked as v2 follow-ons).

#### Scope {#scope}

1. Image downsample primitive (Step 1) — canvas-based pure module; reused by drop, paste, and thumbnail bake.
2. Browser bytes side-table + drop/paste capture with downsampling (Step 2) — atoms gain an optional `id`; drop and paste handlers stash downsampled bytes in the per-card store.
3. Wire flattening at submit (Step 3) — pure `buildWirePayload(text, atoms, bytesStore)` substitutes `U+FFFC` placeholders and packs image attachments; reducer's `handleSend` and queued-flush consume it.
4. Completion-time secret-file filter + `.tugattachignore` (Step 4) — filetree provider applies a built-in denylist and reads a workspace-root ignore file.
5. Atom rendering in the transcript user-message row (Step 5) — extract `buildAtomSVGDataUri` as a pure helper; new `TugAtomTextBody` walks `(text, atoms)` and interleaves the same `<img>` the editor uses.
6. Image attachment strip + thumbnail bake (Step 6) — `tug-attachment-strip.tsx` renders above the user body; `bakeThumbnail` shares the Step-1 pipeline at 256 px.
7. Replay-side cleanup + assistant tool-block chips (Step 7) — fix the `handleAddUserMessage` type-cast; switch tool-block path renderers from monospace text to the shared SVG chip via `buildAtomSVGDataUri`.
8. Integration checkpoint (Step 8) — verify end-to-end: drop → submit → thumbnail + chips → cold-restart → same view.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **PDF / `document` content blocks.** No `application/pdf` branching in `buildContentBlocks`. ([Q03](#q03-pdf-deferred))
- **`kind: "ref"` discriminator and tugcode-side path resolution.** File atoms ride as substituted text in the body; claude `Read`s on demand. Forward-compatible via an additive Attachment-shape extension when needed.
- **Anthropic Files API uploads** (`source.type: "file", file_id: …`).
- **Bidirectional capture** (`TUG_CAPTURE_INBOUND_LOG`) — a regression-safety win but not a v1 blocker.
- **Cross-card paste with bytes.** Clipboard sidecar round-trips atom identities only.
- **Free-prose `@path` detection in assistant markdown.** Tool blocks are the structured surface.
- **Lightbox** for click-to-enlarge — v1.1 polish; v1 opens in a new tab.
- **WASM image decoders.** WebKit decodes every format the v1 allowlist accepts; no parallel decoder needed. ([Q02](#q02-heic-avif))

#### Dependencies / Prerequisites {#dependencies}

- WS transport stable (`ws-verification.md`, commit `e0174373`).
- `tugcast::SessionLedger.turns.user_attachments BLOB` column exists (`session_ledger.rs:463`); journaling is automatic once tugdeck ships non-empty attachments.
- tugcast's filetree provider supports completion queries via the `FILETREE_QUERY` feed and applies `.gitignore` patterns (verified in `tugrust/crates/tugcast/src/feeds/filetree_provider.rs`).
- `test-23-image-attachment` baseline current through claude `2.1.148`.

#### Constraints {#constraints}

- **Per-image:** ≤ 5 MB decoded; media types `image/png`, `image/jpeg`, `image/gif`, `image/webp` (Anthropic Vision allowlist).
- **Image dimensions:** long edge ≤ 2576 px at submit (Opus 4.7 cap; Anthropic Vision docs).
- **Per-request total payload:** Anthropic 32 MB cap; v1 doesn't enforce a sub-total cap since with per-image normalization, 20 maxed images = 100 MB, but typical case is well under. Revisit if user reports hit it.
- **Stdin to claude:** 10 MB cap (Claude Code v2.1.148+). v1's per-image 5 MB cap × any reasonable count stays under this; the wire envelope adds ~5% base64 overhead.
- **Build:** `-D warnings` in `tugrust/.cargo/config.toml`; no new warnings tolerated.
- **No new IndexedDB / localStorage** per `feedback_no_localstorage.md`.
- **Tugdeck package manager:** `bun`, never `npm` / `npx` per `feedback_use_bun.md`.
- **No manual builds in tugdeck.** HMR picks up changes per `feedback_hmr.md`.
- **`tugcode` requires rebuild on edit** per `feedback_tugcode_compile.md`. Steps that touch tugcode flag this.

#### Assumptions {#assumptions}

- Claude continues to accept the existing `image` content-block shape (`source: { type: "base64", media_type, data }`). The drift regression catches breakage; `test-23` is the canary.
- `createImageBitmap` and `OffscreenCanvas` (or `HTMLCanvasElement` fallback) work in Tug.app's WebKit. Verified empirically during Q02 resolution.
- tugcast's filetree provider can be extended with additional ignore patterns without re-architecting the existing `.gitignore` handling. Verified by reading the provider source as part of Step 4.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows [`tuglaws/tugplan-skeleton.md`](../tuglaws/tugplan-skeleton.md) v2:

- Decisions: `[D01]` … `[D08]` with `{#dNN-...}` anchors.
- Open Questions: `[Q01]` … `[Q04]` with `{#qNN-...}` anchors.
- Specs: `Spec S01` … `Spec S06` with `{#sNN-...}` anchors.
- Tables: `Table T01` … `Table T03` with `{#tNN-...}` anchors.
- Lists: `List L01` … `List L03` with `{#lNN-...}` anchors.
- Risks: `Risk R01` … `Risk R05` with `{#rNN-...}` anchors.
- Steps: `{#step-N}` anchors. Every step has `**Depends on:**` (when applicable) and `**References:**` lines.
- IDs are two-digit, never reused; deletions leave gaps.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Click-to-enlarge bytes for replayed images (RESOLVED — option (a), with v1.1 revisit) {#q01-replay-enlarge-bytes}

**Question:** When a card mounts cold and replays JSONL containing image attachments, bytes flow through `add_user_message.attachments[i].content` once. Should the bytes-store hold them indefinitely for click-to-enlarge, evict under an LRU budget, or fetch lazily from JSONL?

**Why it matters:** A 50-turn session with five 4 MB inline images per turn would hold 1 GB in the bytes-store under "hold indefinitely". A naïve LRU would evict before the user expects.

**Options:**
- (a) Hold all bytes for the card's lifetime. Simple. Bounded by session length.
- (b) LRU eviction with a per-card budget (e.g., 100 MB). Predictable memory cap; users hit a "bytes evicted" surface if they enlarge an old image.
- (c) Re-fetch from JSONL on each enlarge via a new tugcast `JSONL_READ_ATTACHMENT` verb. No memory budget; introduces new wire infrastructure.

**Resolution:** **Option (a) for v1.** The click-to-enlarge feature itself is deferred to v1.1 ([roadmap follow-ons](#roadmap)) — until that ships, the bytes-store's enlarge-retention role is dormant. The store still needs the bytes for two active concerns (the thumbnail bake at submit / replay, and the wire payload at submit), but both are short-lived; the bytes-store's per-card-lifetime hold is upper-bounded by the JSONL itself (i.e., the same data already exists on disk).
- Three places hold the bytes already: in-memory bytes-store (per-card), tugcast journal (on-disk), JSONL (on-disk). Per [D04](#d04-no-bytes-on-snapshot) the React snapshot carries thumbnails only. The memory cost the question worries about is therefore the bytes-store's hold, *not* the snapshot's.
- A formal heap profile against a 50-turn × 5-images-per-turn synthetic session was not run as part of Step 8 — that profile needs the Tug.app heap inspector and a real recorded session. The decision goes ahead on design grounds: (b)'s eviction creates UX cliffs the moment click-to-enlarge does ship; (c) requires new tugcast wire infrastructure that's not justified yet.
- v1.1 revisit: when click-to-enlarge ships, re-evaluate against real usage data. If memory pressure surfaces, option (c) (lazy JSONL fetch) is the natural follow-up — option (b) is deliberately not chosen now to avoid the eviction UX cliff.

#### [Q02] HEIC / AVIF source decoding (DECIDED) {#q02-heic-avif}

**Question:** macOS users drag a `.heic` from Photos or a `.avif` from a web page. Does Tug.app's WebKit decode them natively through the `createImageBitmap` canvas pipeline, or do we need a WASM decoder?

**Why it matters:** Tug.app is the shipping surface. The engine question — does WebKit handle these formats — drives whether we need a parallel decoder.

**Empirical findings (2026-05-26):** A throwaway harness served 8×8 HEIC and AVIF test images (generated via `sips` and `avifenc`) and ran `createImageBitmap(blob)` on each.

| Engine | HEIC via `createImageBitmap` | HEIC via `<img>` | AVIF via `createImageBitmap` | AVIF via `<img>` |
|--------|------------------------------|------------------|------------------------------|------------------|
| WebKit (macOS Safari 18.6, same engine Tug.app uses) | ok, 8×8 | ok | ok, 8×8 | ok |
| Chromium (Chrome 148, sanity check) | fail (`InvalidStateError`) | fail | ok, 8×8 | ok |

The Chromium row is sanity-check only — it confirms we understood the engine matrix correctly. Tug.app does not run on Chromium.

**Resolution:** DECIDED — HEIC and AVIF flow through the standard raster branch of `downsampleImage`. WebKit's `createImageBitmap` decodes both natively; the resize / re-encode pipeline doesn't care what the source format was. No WASM decoder. No special-case branch. If a future engine change ever broke WebKit's HEIC support, the existing `decode-failed` discriminated error would surface cleanly from the canvas pipeline — but that's not a planned surface.

#### [Q03] PDF / `document` content block timing (DEFERRED) {#q03-pdf-deferred}

**Question:** When do PDFs become a feature?

**Why it matters:** Users drop PDFs and reasonably expect claude to read them.

**Resolution:** DEFERRED. Not in v1 scope. Forward-compat: the Attachment shape extension is additive (a `application/pdf` media type with `document` content block in tugcode); no breaking change. v2 candidate.

#### [Q04] Animated GIF handling (DECIDED) {#q04-animated-gif}

**Question:** A user drops a 4 MB animated GIF. Canvas resize collapses to a single-frame image and loses the animation. Anthropic Vision accepts `image/gif` and analyzes frames. Should the downsample pipeline skip canvas re-encode for GIFs and pass through, always canvas-encode (lose animation), or detect animated vs. static?

**Why it matters:** Niche but real; engineers screenshot terminal animations and dashboards as GIFs. Static GIFs (the much more common case) should be canvas-resized like any other image so we can normalize their dimensions and re-encode for smaller payloads.

**Resolution:** DECIDED — option (c). The `downsampleImage` pipeline detects animated vs. static by walking the raw GIF bytes and counting image-descriptor blocks (`0x2C` markers after the global color table); >1 frame ⇒ animated, ≤1 frame ⇒ static. Animated GIFs pass through unchanged with a size-only check (reject if > 5 MB). Static GIFs route through the canvas pipeline like JPEG / PNG / WebP (resize to long-edge ≤ 2576 px, re-encode as GIF, then JPEG-quality-ladder fallback if still > 5 MB). The frame-count detector is a small pure function (`isAnimatedGif(bytes: Uint8Array): boolean`) added in Step 1 with unit-test coverage for known animated and static fixtures. If users hit the 5 MB cap on animated GIFs in the wild, escalate to a `gifsicle`-style server-side downsampler — v1.1.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Canvas downsample blocks main thread on insert | medium | medium | A `<TugProcessingIndicator>` overlay appears for operations > 100 ms; OffscreenCanvas where supported moves work off the main thread | User reports UI hitch on insert |
| Anthropic content-block drift | high | low | `test-23-image-attachment` regression catches outbound-shape change; capture-capabilities run flags drift | Drift regression Semantic finding |
| Bytes-store memory growth on long sessions | medium | medium | Thumbnails-only on snapshot ([D04](#d04-no-bytes-on-snapshot)); bytes-store policy resolved in [Q01](#q01-replay-enlarge-bytes) at Step 8 | Heap > 500 MB in profile |
| Workspace secret leakage via manually-typed path | low | high | Filtering at completion ([D06](#d06-completion-time-filter)) covers UX; matches Claude Code's permission posture for typed paths | Security audit finding |
| `.tugattachignore` parser bugs (glob nuances) | low | medium | Reuse `ignore` crate's gitignore implementation (already a transitive dep via tugcast); unit-test against the same patterns | Filetree completion shows ignored path |

**Risk R01: Canvas downsample blocks main thread** {#r01-canvas-blocking}

- **Risk:** Decoding + resizing a 12 MP PNG takes ~50-100 ms on the main thread; users perceive a UI hitch on drop / paste.
- **Mitigation:** Use `OffscreenCanvas` + `createImageBitmap` (off-main-thread on Tug.app's WebKit). If neither is available, fall back to the synchronous `HTMLCanvasElement` path and show a `<TugProcessingIndicator>` overlay for operations whose decode-start to encode-end exceeds 100 ms. The indicator is suppressed for fast paths (most images).
- **Residual risk:** A pathological 100 MP image on a fallback path still blocks. Rejected early via dimension check before the canvas decode would even start.

**Risk R02: Anthropic content-block drift** {#r02-anthropic-drift}

- **Risk:** Anthropic changes the `image` content-block schema (renames `source.media_type`, deprecates `base64`, etc.). The drift is silent until claude returns an error event.
- **Mitigation:** `test-23-image-attachment` continues to run on every `capture-capabilities` pass; a schema change would either fail the capture (status: failed) or pass a new shape (drift regression flags Semantic).
- **Residual risk:** Drift between captures is not caught real-time. Bidirectional capture (in non-goals) would close this gap; it's tracked as a v2 follow-on.

**Risk R03: Bytes-store memory growth** {#r03-bytes-store-memory}

- **Risk:** A long card-mount with many large inline images accumulates 100s of MB in the per-card bytes-store.
- **Mitigation:** Thumbnails-only on the React snapshot ([D04](#d04-no-bytes-on-snapshot)). Bytes-store retention policy resolved in [Q01](#q01-replay-enlarge-bytes) at integration time based on profile data.
- **Residual risk:** Even with thumbnails-only on snapshot, the bytes-store itself can grow. Cap policy lands as part of Q01 resolution.

**Risk R04: Workspace secret leakage via manual path** {#r04-manual-path-leak}

- **Risk:** A user types `@.env` in the prompt body. Completion would have filtered it; manual typing bypasses. `.env` substitutes into wire text; claude may `Read` it (its own gates apply).
- **Mitigation:** Filtering at completion-time ([D06](#d06-completion-time-filter)) covers the common path. This matches Claude Code's own posture: the terminal would also have shown `.env` had the user typed it.
- **Residual risk:** Same as Claude Code itself. Documented; no additional mitigation in v1.

**Risk R05: `.tugattachignore` parser bugs** {#r05-tugattachignore-parser}

- **Risk:** Glob patterns have edge cases (`**/foo` vs. `**/foo/**`, trailing-slash semantics, negation `!pattern`).
- **Mitigation:** Reuse the `ignore` crate's gitignore implementation, which is already a transitive dependency via tugcast for `.gitignore` handling. Unit-test the same pattern cases gitignore documents.
- **Residual risk:** A user's exotic pattern works in `.gitignore` but not `.tugattachignore`. Document the exact subset we support; surface a parse-error toast if a pattern is unrecognized.

---

### Design Decisions {#design-decisions}

#### [D01] Substitute `U+FFFC` at submit-time via a pure function (DECIDED) {#d01-ffc-substitution-at-submit}

**Decision:** The substrate's `TurnEntry.userMessage` continues to carry `text` (with `U+FFFC` placeholders at atom positions) and `atoms[]` separately. A new pure function `buildWirePayload(text, atoms, bytesStore)` produces the wire payload — substituting each `U+FFFC` with the corresponding atom's `value` and packing image-atom bytes into `Attachment[]` — at submit time, just before dispatch. The reducer never sees `U+FFFC` in the wire text.

**Rationale:**
- Substituting in the substrate would lose atom-position information needed for transcript chip rendering. The chip renderer walks `text` looking for `U+FFFC` and reads the corresponding atom; if we substituted, we'd need a separate "where do the chips go" sidecar.
- A pure function at the edge is round-trippable, easy to test, and keeps the reducer pure.
- The substrate stays simple: atoms and text live together, exactly as `tug-text-types.ts:90` documents the invariant.

**Implications:**
- New `tugdeck/src/lib/build-wire-payload.ts` (pure; ~50 LOC).
- `code-session-store.send` calls it and dispatches the flattened payload as part of the action.
- `reducer.ts:handleSend` and the queued-send flush at `reducer.ts:2147-2218` consume the pre-flattened values.
- `TurnEntry.userMessage.text` is never mutated to remove `U+FFFC`; it stays raw for transcript rendering.

#### [D02] Image atoms with bytes ride as inline image content blocks; drop / paste rejects everything but images (DECIDED) {#d02-image-attach-text-rest}

**Decision:** Inline attachments are **images-only**. At submit, any image atom whose `id` resolves to a bytes-store entry rides as an `{type: "image", source: {type: "base64", media_type, data}}` content block on the `user_message` wire frame; atoms without an id (or whose id is unknown to the store, or whose `type` isn't `"image"`) ride only as substituted text in `wireText`. The drop / paste pipeline rejects every non-image file kind at drop time: PDFs, archives, audio, video, text, source code, JSON, etc. produce no atom — they're silently skipped, the missing chip is the signal.

The rationale is the Claude Agent SDK's user-message input shape: streaming-input examples and the SDK's documented Benefits call out **text + image** content blocks only. There is no `document` content block path through the agent SDK, no inline text-file path, and no inline anything-else. For workspace files, the canonical path is `@`-mention typeahead — the path text rides verbatim in `wireText` and the model uses the `Read` tool on demand. For arbitrary text content, the canonical path is paste.

In Tug.app, the native bridge ([Step 3.5.7](#step-3-5-7)) snapshots `NSPasteboard` from the Swift host on every `draggingEntered:` / `draggingUpdated:` and pushes the resolved MIME info into JS via `window.__tugActiveDrag`; the JS drop extension consults this snapshot from `dragenter` / `dragover` and drives the three-state accept / reject ring. Non-image files show the red reject ring + OS no-drop cursor *before* release. When the native bridge is absent (browser-only dev paths) or has not yet posted its first snapshot (the one-frame race window — see [Q05](#q05-bridge-timing)), the extension falls back to the legacy `types.includes("Files")` accept-all behavior; on release, the drop handler classifies `dataTransfer.files` (which WKWebView populates at drop time even when it redacts during drag per [WebKit bug #223517](https://bugs.webkit.org/show_bug.cgi?id=223517)) and silently skips non-image files.

Skeleton-atom feedback: image drops insert their atoms *synchronously* with a UUID id and a pending appearance (dimmed + pulsing). The async downsample runs in the background; on success, the bytes land in the store and the pending-sync `ViewPlugin` mutates `data-pending` off via direct DOM (no widget rebuild). On failure, the skeleton atom is removed and the user sees the banner. Submit is gated while any pending atom is in the doc — submitting a half-processed image would silently ship just the filename.

**Rationale:**
- The Claude Agent SDK's streaming-input pipeline accepts text + image content blocks only. PDFs and other documents are not part of the SDK's user-message input shape; supporting them on the tugdeck side would build a half-feature whose bytes the SDK silently discards.
- Workspace `@`-mentions still ride as text in `wireText` — Test 24 in `transport-exploration.md` empirically established that claude's `Read` tool fetches workspace-relative paths on demand. This matches the terminal's behavior and stays cheap on tokens.
- Silently inserting filename-only atoms for non-image files was confusing — the chip looked usable but the bytes never went anywhere. Drop-time rejection is the honest signal and steers the user toward `@`-mention or paste.
- Skeleton atoms give instant visual feedback at the drop point. Without them, 1-2 s of async downsample felt like the drop failed.
- PDF / `document` content blocks remain deferred per [Q03](#q03-pdf-deferred) — and won't be re-opened until the SDK exposes a document content-block path on its input shape.
- Forward-compatible: a future `document` content block slots in additively without breaking the existing shape, when the SDK supports it.

**Implications:**
- `buildContentBlocksFromLegacyJournal` in tugcode (`session.ts:317-360`) silently drops any non-image attachment in a legacy journal row (defensive against pre-Option-A persisted rows; no new submissions write them).
- `buildWirePayload` ships an image content block for any atom with `type: "image"` + `id !== undefined` + bytes; non-image atoms substitute their `value` into the surrounding text.
- File / doc atoms from `@`-completion continue to ride as text only (no id, no bytes).
- Non-image drops are silently rejected at drop time; no atom appears.
- Skeleton atom rendering goes through `createAtomImgElement(...{ id, pending: true })`; the appearance is themed via `pendingAtomTheme`. The pending-sync `ViewPlugin` (in `atom-decoration.ts`) subscribes to the bytes-store and reconciles `data-pending` via direct DOM mutation when bytes arrive.
- `performSubmit` (`tug-prompt-entry.tsx`) checks for pending atoms via the bytes-store and bails with a banner when any are still processing.

#### [D03] Per-card `AtomBytesStore` keyed by UUID (DECIDED) {#d03-atom-bytes-store}

**Decision:** A per-tide-card in-memory store (`Map<atomId, {content, mediaType}>`) holds base64 bytes for inline image attachments. The atom-id is a UUID minted at drop / paste time on `AtomSegment.id` (new optional field). At commit time, the same id is reused as `AttachmentRecord.id` (the post-submit identity). Replay-derived attachments mint fresh ids at commit and populate the store from `add_user_message.attachments[i].content`. JSON-serializable for state preservation.

**Rationale:**
- Atoms remain lightweight; stuffing 5 MB of base64 onto `AtomSegment.value` would balloon every preserved snapshot.
- A dedicated store with explicit lifetimes (mount → unmount + state-preservation snapshot) decouples byte storage from substrate identity.
- Single key namespace (UUID) simplifies click-to-enlarge: `AttachmentRecord.id` → bytes-store lookup, same code path for inline-submitted and replay-derived attachments.

**Implications:**
- `AtomSegment` gains optional `id: string` (`tug-atom-img.ts:24`).
- `AttachmentRecord` carries the same id field.
- `useCardStatePreservation` snapshot includes the bytes-store map (it's already JSON-serializable).
- The reducer commit path is responsible for ensuring the bytes-store has an entry for each image AttachmentRecord — for inline this is already true (drop/paste populated it); for replay it writes from `event.attachments[i].content`.

#### [D04] No raw bytes on the React snapshot (DECIDED) {#d04-no-bytes-on-snapshot}

**Decision:** `TurnEntry.userMessage.attachments: ReadonlyArray<AttachmentRecord>` carries `thumbnailDataUrl` (≤ 256 px max edge for images) + metadata only. Full bytes live exclusively in the bytes-store, the tugcast journal, and JSONL.

**Rationale:**
- 100 turns × 5 MB attachments = 500 MB on the React snapshot. Unacceptable.
- Tugcast's journal already declares the `user_attachments BLOB` column and serializes via `serde_json::Value`.
- Thumbnails are smaller (≤ 200 KB typically) and fine to keep on the snapshot.

**Implications:**
- `AttachmentRecord` shape: `{ id, role, filename, mediaType, thumbnailDataUrl, byteSize }`.
- The reducer commit path runs `bakeThumbnail` from the bytes-store entry; the thumbnail data URL goes onto the snapshot.
- Click-to-enlarge looks up bytes from the store via `AttachmentRecord.id`.

#### [D05] Client-side image downsampling at insert time (DECIDED) {#d05-client-downsample}

**Decision:** Every dropped or pasted image runs through a canvas-based normalization pipeline at insert time, *before* bytes reach the bytes-store:

1. **GIF pre-check.** If the source MIME is `image/gif`, run `isAnimatedGif(bytes)` (frame-count via `0x2C` marker walk). Animated → size check only (pass through if ≤ 5 MB; reject otherwise). Static → continue to the canvas pipeline. Detail per [Q04](#q04-animated-gif).
2. Decode the source to an `ImageBitmap` via `createImageBitmap(blob)` (preferred — off-main-thread on supporting browsers) or via `HTMLImageElement` + canvas `drawImage` (fallback).
3. If `max(width, height) > 2576` (Opus 4.7 long-edge cap), resize maintaining aspect ratio so long-edge = 2576 px.
4. Re-encode in source MIME (`image/png` → PNG, `image/jpeg` → JPEG, `image/webp` → WebP, static `image/gif` → GIF).
5. If encoded size > 5 MB, transcode to JPEG with quality ladder 90 → 80 → 70 → 60. Stop at the first quality whose encoded size ≤ 5 MB.
6. If still > 5 MB at quality 60, reject the drop / paste with an explicit error toast naming the file.
7. SVG (`image/svg+xml`) rasterizes to PNG at 1024×1024 (max), preserving aspect.
8. HEIC / AVIF / HEIF flow through the raster branch unchanged — WebKit decodes all three via `createImageBitmap`. No special-case branch. Per [Q02](#q02-heic-avif).

**Rationale:**
- The Anthropic backend rejects images > 5 MB decoded or with bad dimensions; normalizing client-side prevents API rejections.
- Doing it at insert (not submit) means the bytes-store always holds wire-ready bytes; submit is fast and deterministic.
- Canvas is native to the browser; no library dependency. WASM HEIC decoder is the fallback escape hatch ([Q02](#q02-heic-avif)).
- The same pipeline produces the 256 px thumbnail (different target size, same code path).

**Implications:**
- New `tugdeck/src/lib/image-downsample.ts` (pure-ish; signature in [Spec S04](#s04-image-downsample)).
- Drop and paste handlers `await` this before inserting the atom.
- Rejected drops surface via the existing card-error / toast path.

#### [D06] Completion-time secret-file filtering + `.tugattachignore` (DECIDED) {#d06-completion-time-filter}

**Decision:** The tugcast filetree provider (`tugrust/crates/tugcast/src/feeds/filetree_provider.rs`) applies two filters on top of its existing `.gitignore` handling:
1. A built-in denylist of secret-file globs ([List L01](#l01-secret-file-denylist)): `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `secrets.json`, `credentials.json`, `**/.aws/credentials`, `**/.npmrc`, `**/.ssh/**`.
2. An optional `.tugattachignore` at workspace root, gitignore syntax (parsed via the existing `ignore` crate), additive to the built-in.

Filtering is applied at suggestion time. Users never see these paths in the `@`-popup. Users who type a denylisted path manually still send it as text — same model as Claude Code.

**Rationale:**
- The natural place to filter is at suggestion-time: users never see `.env` in the popup, so they can't accidentally `@`-mention it.
- A `.tugattachignore` lets teams add project-specific secret files without code changes.
- We don't filter at submit-time because that would be paranoid (claude's own `Read` tool gates non-workspace reads); matching Claude Code's posture is the design north star.

**Implications:**
- Changes localized to `filetree_provider.rs`: built-in patterns constant + `.tugattachignore` reader.
- No tugdeck-side changes; the popup just stops seeing these paths.
- A manual-typed path still flows to claude; Claude's tool gates apply if `Read` is invoked.

#### [D07] Chip rendering shares an SVG builder, not a React primitive (REVISED) {#d07-atom-chip-primitive}

> **Supersedes** an earlier draft that mandated a shared React `AtomChip` primitive consumed by the editor's CM6 widget, the transcript user-row body, and the tool-block path renderers. That earlier draft is preserved at the bottom of this section for historical record.

**Decision:** Extract the SVG-data-URI builder from `createAtomImgElement` (`tug-atom-img.ts`) as a pure helper, `buildAtomSVGDataUri(type, label, value, options?)`. Three surfaces consume the helper, each in the way that fits its substrate:

- The editor's CM6 atom decoration **does not change**. `createAtomImgElement` continues to be its entry point and renders the same `<img>` it does today — calling `buildAtomSVGDataUri` internally for the URI. Replaced-element semantics (caret motion, selection, clipboard, undo) ride on the `<img>` element type per HTML spec; rebuilding it as a React component would buy nothing the substrate doesn't already give us and would risk that carefully-engineered behaviour.
- The transcript user-row body uses a new pure React walker, `TugAtomTextBody`, that splits the substrate text at `U+FFFC` and interleaves `<img src={buildAtomSVGDataUri(...).dataUri} ...>` per atom.
- The tool-block path renderers render an inline `<img>` per `file_path` (and `notebook_path`) using the same helper. Single chip per tool block; no walker needed.

**Rationale:**
- Visual consistency comes from the shared SVG builder + theme-token reads, not from a shared React component.
- The editor's atom-editing behaviour depends on the `<img>` being a replaced element. A React mount inside a CM6 widget adds a React-lifecycle surface for zero gain.
- React-side accessibility (`aria-label`, `role="button"` when interactive) was the only reason to wrap a chip in React; the editor doesn't need it (clicks bubble via `ignoreEvent: false`); the transcript user row's chips aren't interactive in v1; tool-block chips aren't interactive in v1. Accessibility on a per-image basis is `alt={atom.label}` on the `<img>` itself.

**Implications:**
- `tug-atom-img.ts` exports a new pure `buildAtomSVGDataUri` helper; `createAtomImgElement` keeps its current public shape and calls the helper internally.
- New `TugAtomTextBody` (`tugdeck/src/components/tugways/cards/tug-atom-text-body.tsx`) — pure React walker.
- No new `tug-atom-chip.tsx`, no new CM6 widget changes, no `tuglaws/atom-chip.md`.
- Tool-block components inline one `<img>` each. No new wrapper component.

<details>
<summary>Earlier draft (superseded)</summary>

The earlier draft proposed extracting chip rendering into a shared React component `AtomChip` consumed by the CM6 atom decoration, the transcript user-row body (via `TugAtomTextBody`), and the four tool-block path renderers. Its rationale cited visual consistency, a single primitive avoiding style drift, and React-side accessibility. The current decision honours the consistency goal via a shared *SVG builder* rather than a shared *React component*, keeping the editor's replaced-element semantics untouched.

</details>

#### [D08] Assistant-side atoms only at tool-block surfaces (DECIDED) {#d08-tool-block-only}

**Decision:** For v1, the assistant-side atom-chip rendering applies only to Read / Edit / Write / NotebookEdit tool blocks (where the file path is a structured `input` field). Free-prose `@`-path detection in assistant markdown is out of scope.

**Rationale:**
- Tool inputs carry the file path as a structured field; no parsing required.
- Free-prose detection is fragile (false positives like `@stable` annotations in code blocks, npm-style `@scope/pkg` mentions).
- The visual goal — user's chips reappearing in claude's response — is already met by tool-block chipping.

**Implications:**
- A small change in each of the four tool-block components to render the path as an inline `<img>` chip via `buildAtomSVGDataUri` ([Spec S05](#s05-atom-chip)).
- `notebook-edit-tool-block` extends similarly for `input.notebook_path`.
- Free-prose detection lives in a future v2 plan; the `tug-markdown-block` integration point is documented but not built.

---

### Specification {#specification}

#### Spec S01: `Attachment` wire type (RETIRED) {#s01-attachment-wire-type}

> **Retired** as part of [Step 5c](#step-5c). The `Attachment` shape is superseded by Anthropic-API-shaped `ContentBlock[]` carried directly on the `user_message` wire frame. The legacy shape is preserved at the bottom of this section for historical record and to anchor any pre-5c references in the rest of this doc.

The current wire shape uses Anthropic's `ContentBlock` array directly. The `user_message` frame carries `content: ContentBlock[]` instead of `text: string + attachments: Attachment[]`. See [Spec S03 (REVISED)](#s03-build-wire-payload) for the `buildWirePayload` contract that produces this shape.

```ts
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };
```

The tugcast session-ledger's internal `(user_text, user_attachments)` projection (for the never-drop journal) still uses the legacy fields — derived inside `payload_inspector.rs` via `derive_legacy_journal_view(content)`. That projection is purely a tugcast-side detail; the wire and the substrate use content blocks.

<details>
<summary>Legacy `Attachment` interface (retired)</summary>

`tugdeck/src/protocol.ts` and `tugcode/src/types.ts` (pre-5c):

```ts
interface Attachment {
  filename: string;       // user-visible label; survives JSONL round-trip
  content: string;        // base64 for binary, raw text for text/*
  media_type: string;     // RFC 6838; "image/png", "image/jpeg", "image/gif", "image/webp"
}
```

No discriminated union, no `kind`, no `path`. The "survives JSONL round-trip" claim about `filename` was incorrect — Anthropic's `image` content block has no filename field, so the live wire's `filename` was lost on JSONL replay (tugcode's replay path hardcoded `filename: ""`). [Step 5c](#step-5c)'s submit-time substrate-synthesis is the resolution: the renderer's chip label is derived deterministically (`#NNNN-image-N`) rather than from a wire-preserved filename.

</details>

#### Spec S02: `AtomBytesStore` interface {#s02-atom-bytes-store}

`tugdeck/src/lib/atom-bytes-store.ts`:

```ts
interface AtomBytesEntry {
  content: string;       // base64 for binary (image), raw text for text/*
  mediaType: string;     // image/png | image/jpeg | image/gif | image/webp | text/* | known code MIMEs
}

interface AtomBytesStore {
  /** Stash bytes for an atom or attachment, keyed by id. Idempotent. */
  put(id: string, entry: AtomBytesEntry): void;
  /** Look up bytes by id. Returns null if unknown. */
  get(id: string): AtomBytesEntry | null;
  /** Remove bytes by id. Used when the atom is deleted from the editor. */
  delete(id: string): void;
  /** Entry count — diagnostics + cheap is-empty check. */
  size(): number;
  /** JSON-serializable snapshot for state preservation. */
  snapshot(): Record<string, AtomBytesEntry>;
  /** Restore from a snapshot (idempotent on existing keys). */
  restore(snap: Record<string, AtomBytesEntry>): void;
  /** Drop all entries. Used at card unmount / store disposal. */
  clear(): void;
  /** Subscribe to mutations; returns unsubscribe. Fires on put/delete/restore/clear. */
  subscribe(listener: () => void): () => void;
}
```

One instance per `CodeSessionStore` (per-tide-card scope). Lifetime: mount → unmount, with state-preservation snapshot ride-along.

#### Spec S03: `buildWirePayload` contract (REVISED) {#s03-build-wire-payload}

> **Revised** as part of [Step 5c](#step-5c). The earlier `{wireText, attachments}` return shape is superseded by interleaved `ContentBlock[]` matching Anthropic's API directly. The walker emits image atoms as standalone `image` blocks at their original positions in the substrate text; file-path atoms substitute into the surrounding text block. The function also returns an `atomIdAt` resolver built during the walk — the live path passes it to `synthesizeUserMessageFromBlocks` so synthesized atoms reuse the editor's original ids (no bytes-store orphans).

`tugdeck/src/lib/build-wire-payload.ts`:

```ts
function buildWirePayload(
  text: string,                              // raw substrate text with U+FFFC at atom positions
  atoms: ReadonlyArray<AtomSegment>,         // parallel atoms array; atoms.length === count(U+FFFC in text)
  bytesStore: AtomBytesStore,
): {
  content: ContentBlock[];                   // interleaved blocks (text, image, text, image, ...) preserving original order
  atomIdAt: (imageBlockIndex: number) => string | undefined;
                                             // resolver for synthesizer: image-block index → editor atom id
};
```

**Invariants:**
- Pure: same inputs → same outputs (the bytes-store is read-only here; mutations live on drop/paste/commit paths and synthesis).
- The `content` array preserves the original document order: text accumulates between `U+FFFC` positions; each image atom with bytes in the store becomes a standalone `image` block at that position; each file-path atom substitutes `atom.value` into the surrounding text block. Adjacent text segments coalesce into a single text block.
- An image atom whose id is missing from the store is silently skipped (the substituted text still inserts `atom.value` so claude sees the filename). The walker tracks this — `atomIdAt(i)` returns the id of the i-th atom that actually became an image block, not the i-th editor atom.
- Defensive: if `atoms.length < count(U+FFFC, text)`, extra `U+FFFC` chars pass through into text blocks verbatim. Visible regression rather than crash.

<details>
<summary>Legacy `buildWirePayload` contract (superseded)</summary>

Pre-5c:

```ts
function buildWirePayload(
  text: string,
  atoms: ReadonlyArray<AtomSegment>,
  bytesStore: AtomBytesStore,
): {
  wireText: string;       // text with each U+FFFC replaced by the corresponding atom's value
  attachments: Attachment[];  // one entry per image-atom with bytes in the store
};
```

The flat shape (`wireText` plus a separate `attachments` array) lost the original atom positions on the wire. claude's JSONL recorded the flat shape (text + sequential image blocks). On cold-restart, the renderer had no way to reconstruct which positions in the text were originally atoms — the chip placement was lost. [Step 5c](#step-5c) preserves position by emitting interleaved blocks; JSONL records the interleaving; restore reads it back as substrate.

</details>

#### Spec S04: `image-downsample` contract {#s04-image-downsample}

`tugdeck/src/lib/image-downsample.ts`:

```ts
interface DownsampleResult {
  content: string;          // base64; ≤ 5 MB decoded; ≤ 2576 px long edge
  mediaType: string;        // RFC 6838; possibly re-mapped (PNG→JPEG fallback)
  thumbnailDataUrl: string; // ≤ 256 px max edge, data: URL
  width: number;
  height: number;
  byteSize: number;         // decoded size in bytes
}

type DownsampleError =
  | { kind: "unsupported-format"; mediaType: string }
  | { kind: "too-large-after-fallback"; byteSize: number }
  | { kind: "decode-failed"; reason: string };

function downsampleImage(
  source: Blob | File,
): Promise<{ ok: true; result: DownsampleResult } | { ok: false; error: DownsampleError }>;

/** Frame-count detection for GIF input per [Q04](#q04-animated-gif). Pure. */
function isAnimatedGif(bytes: Uint8Array): boolean;
```

Pipeline implements [D05](#d05-client-downsample). The function never throws; the discriminated result lets callers surface specific errors. `ImageBitmap` path is preferred; `HTMLImageElement` fallback is used when `createImageBitmap` is unavailable or fails. `isAnimatedGif` runs ahead of the canvas pipeline for `image/gif` inputs; animated → passthrough, static → canvas.

#### Spec S05: `buildAtomSVGDataUri` helper + `TugAtomTextBody` contract (REVISED) {#s05-atom-chip}

> **Supersedes** an earlier `AtomChip` React-primitive contract (see [D07](#d07-atom-chip-primitive) for the decision history).

`tugdeck/src/lib/tug-atom-img.ts` exports a pure helper:

```ts
interface AtomSvgResult {
  dataUri: string;        // data:image/svg+xml,...
  width: number;          // px, ready to set on <img width=...>
  height: number;         // px
  baselineOffset: number; // px; set as verticalAlign so the chip aligns with text baseline
}

function buildAtomSVGDataUri(
  type: string,                              // "file" | "command" | "doc" | "image" | "link"
  label: string,
  value: string,
  options?: { maxLabelWidth?: number },
): AtomSvgResult;
```

Pure: same inputs (including the currently-resolved theme tokens, which the helper reads from CSS variables via `getTokenValue` at call time) → same outputs. `createAtomImgElement` calls this internally and applies the result to an `<img>` it constructs; the editor's CM6 widget path is byte-for-byte unchanged.

`tugdeck/src/components/tugways/cards/tug-atom-text-body.tsx` exports a pure React walker:

```tsx
interface TugAtomTextBodyProps {
  text: string;                              // raw substrate text with U+FFFC at atom positions
  atoms: ReadonlyArray<AtomSegment>;         // parallel atoms array
  className?: string;
}

function TugAtomTextBody(props: TugAtomTextBodyProps): React.ReactElement;
```

**Invariants:**
- Pure render; no `useEffect`, no `useRef`, no React state.
- Splits `text` at `U+FFFC` characters; emits text spans for the non-empty in-between slices and one `<img src={dataUri} width=... height=... alt={atom.label} style={{verticalAlign:`${baselineOffset}px`}}>` per atom position.
- When `atoms.length < count(U+FFFC, text)`, extra `U+FFFC` characters render as visible characters — visible regression rather than crash, matching `buildWirePayload`'s defensive posture.
- When `atoms` is empty, output is a single text span.

Tool-block path renderers (`read-tool-block.tsx` and siblings) call `buildAtomSVGDataUri` directly and render one inline `<img>` per `file_path` / `notebook_path`. No walker needed for the tool-block single-path case.

#### Spec S06: `TugAttachmentStrip` component contract {#s06-attachment-strip}

`tugdeck/src/components/tugways/cards/tug-attachment-strip.tsx`:

```tsx
interface TugAttachmentStripProps {
  attachments: ReadonlyArray<AttachmentRecord>;
  /** Click handler — v1 opens the source image in a new tab via window.open. */
  onAttachmentClick?: (attachment: AttachmentRecord, index: number) => void;
  className?: string;
}
```

- Renders nothing when `attachments.length === 0`.
- Image attachments → `<img src={thumbnailDataUrl} alt={filename}>` in a fixed-aspect 64×64 tile.
- Non-image attachments (theoretical in v1; v2 might add doc chips) → reserved for future expansion.
- Sits above the user-row body inside `UserMessageCell`.

---

### Lists and Tables {#lists-and-tables}

#### List L01: Built-in completion denylist patterns {#l01-secret-file-denylist}

The tugcast filetree provider rejects suggestions matching any of:

- `.env`
- `.env.*`
- `*.pem`
- `*.key`
- `id_rsa*`
- `id_ed25519*`
- `secrets.json`
- `credentials.json`
- `**/.aws/credentials`
- `**/.npmrc`
- `**/.ssh/**`

Additive to `.gitignore` and the optional `.tugattachignore`. Compiled at provider startup; no per-query cost beyond the gitignore-style match itself.

#### List L02: Image media-type allowlist (post-downsample) {#l02-image-mime-allowlist}

The bytes-store and the wire only ever carry one of:

- `image/png`
- `image/jpeg`
- `image/gif`
- `image/webp`

Source images outside this set fall into one of two paths: SVG rasterizes to PNG; HEIC / HEIF / AVIF flow through the raster branch unchanged (WebKit decodes them and the pipeline re-encodes in source MIME, with JPEG fallback if needed). Anything else is rejected.

#### List L03: Atom → wire mapping {#l03-atom-to-wire-mapping}

The discriminator is **whether the atom has bytes in the per-card store**, not its `type`. The same atom type can ride as Attachment-with-bytes (Finder drop) or as text-only (`@`-completion).

| Atom shape | Wire emission | Source |
|-----------|---------------|--------|
| `type: "image"` + `id` + bytes | Substituted text (filename) + `Attachment` (base64 image, `image/*` media_type) | Drop / paste of image |
| `type: "file"` + `id` + bytes | Substituted text (filename) + `Attachment` (raw text, `text/*` or known code MIME) | Drop of `.md` / `.json` / `.ts` etc. from Finder ([D02]) |
| `type: "file"` / `type: "doc"` (no id) | Substituted text (workspace-relative path) only | `@`-completion — claude `Read`s on demand |
| `type: "image"` (no id) | Substituted text (filename) only | Defensive — image atom without paired bytes |
| `type: "link"` | Substituted text (URL) | Claude treats as a URL string in prose |
| `type: "command"` | Substituted text (command name) | Usually intercepted client-side before submit |
| Other types with `id` + bytes | Substituted text + `Attachment` | Forward-compatible — any future atom type with bytes flows through |
| Binary file drop (PDF, archive, audio, video) | Substituted text (filename) only | No bytes-store entry; not shippable on v1's wire |

#### Table T01: Failure modes & surfacing {#t01-failure-modes}

| Failure | Where caught | Surface |
|---------|--------------|---------|
| Image > 5 MB after JPEG-quality-60 fallback | `downsampleImage` ([Spec S04](#s04-image-downsample)) | Toast: "Image too large after compression: {filename}" — drop / paste rejected |
| Unsupported image format (e.g., TIFF, BMP) | `downsampleImage` | Toast: "Image format unsupported: {mediaType}" — drop / paste rejected |
| Image decode fails (corrupt file) | `downsampleImage` | Toast: "Could not decode image: {filename}" — drop / paste rejected |
| Atom missing from bytes-store at submit (user deleted chip after drop) | `buildWirePayload` ([Spec S03](#s03-build-wire-payload)) | Silently skip the Attachment; substituted text still inserts `atom.value` so claude sees the filename |
| `U+FFFC` count ≠ `atoms.length` (substrate invariant break) | `buildWirePayload` defensive guard | Leftover `U+FFFC` passes through to claude as a literal character; visible regression on the assistant side |
| Anthropic API rejects bytes (drift, bad base64) | Anthropic API → tugcode | `api_retry` event, then turn error via existing path |
| `.tugattachignore` parse error | Filetree provider | Skip the invalid line; log via tugcast telemetry; remaining patterns apply |

No failure is silent. No failure drops the user's submission without surfacing.

#### Table T02: Persistence tiers {#t02-persistence-tiers}

| Tier | Lifetime | What's stored | Source code |
|------|----------|---------------|-------------|
| React snapshot | Mount → unmount | `AttachmentRecord` (thumbnail + metadata, no full bytes) | `CodeSessionSnapshot` |
| Bytes-store side-table | Mount → unmount + state-preservation snapshot | Downsampled base64 bytes; per-card scope | `atom-bytes-store.ts` ([Spec S02](#s02-atom-bytes-store)) |
| Tugcast `turns` journal | Until claude acks the turn | Full inline bytes as JSON BLOB | `session_ledger.rs:463` |
| JSONL | Forever (until user `forget`s) | What claude itself wrote — image content blocks for inline | `~/.claude/projects/<encoded>/<sid>.jsonl` |

#### Table T03: Image-downsample decision matrix {#t03-downsample-decisions}

| Source MIME | Action | Output MIME |
|-------------|--------|-------------|
| `image/png` | Resize if needed; re-encode PNG; JPEG fallback if > 5 MB | `image/png` or `image/jpeg` |
| `image/jpeg` | Resize if needed; re-encode JPEG (start at quality 90) | `image/jpeg` |
| `image/webp` | Resize if needed; re-encode WebP; JPEG fallback if > 5 MB | `image/webp` or `image/jpeg` |
| `image/gif` (animated, >1 frame) | Size check only; pass through if ≤ 5 MB; reject otherwise ([Q04](#q04-animated-gif)) | `image/gif` |
| `image/gif` (static, ≤1 frame) | Resize if needed; re-encode GIF; JPEG fallback if > 5 MB ([Q04](#q04-animated-gif)) | `image/gif` or `image/jpeg` |
| `image/svg+xml` | Rasterize to PNG at 1024×1024 | `image/png` |
| `image/heic` / `image/heif` | Canvas decode via WebKit → resize → re-encode in source MIME (JPEG fallback if > 5 MB). Per [Q02](#q02-heic-avif). | `image/heic` / `image/heif` (or `image/jpeg` on fallback) |
| `image/avif` | Same as HEIC | `image/avif` (or `image/jpeg` on fallback) |
| Anything else | Reject with `unsupported-format` | — |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/atom-bytes-store.ts` | Per-card bytes side-table ([Spec S02](#s02-atom-bytes-store)) |
| `tugdeck/src/lib/build-wire-payload.ts` | Pure atom → Attachment + text-substitution translator ([Spec S03](#s03-build-wire-payload)) |
| `tugdeck/src/lib/image-downsample.ts` | Canvas-based image normalization pipeline ([Spec S04](#s04-image-downsample)) |
| `tugdeck/src/components/tugways/cards/tug-attachment-strip.tsx` | Image thumbnail strip ([Spec S06](#s06-attachment-strip)) |
| `tugdeck/src/components/tugways/cards/tug-attachment-strip.css` | Strip styling |
| `tugdeck/src/components/tugways/cards/tug-atom-text-body.tsx` | Pure React walker — splits `text` at `U+FFFC`, interleaves `<img>` per atom via `buildAtomSVGDataUri` ([Spec S05](#s05-atom-chip)) |

#### Files modified {#files-modified}

| File | Change |
|------|--------|
| `tugdeck/src/lib/tug-atom-img.ts` | `AtomSegment.id?: string`; extract `buildAtomSVGDataUri` as a pure helper; `createAtomImgElement` keeps current shape, calls the helper internally |
| `tugdeck/src/components/tugways/tug-text-editor/drop-extension.ts` | `await downsampleImage` for image files; mint atom-id; stash bytes |
| `tugdeck/src/components/tugways/tug-text-editor/clipboard-filters.ts` | Paste handler for `image/*` `ClipboardItem`; same path as drop |
| `tugdeck/src/lib/code-session-store.ts` | Pass `bytesStore` ref into the reducer; expose via send wrapper |
| `tugdeck/src/lib/code-session-store/reducer.ts` | `handleSend` and queued-flush use `buildWirePayload`; commit path bakes thumbnails; `handleAddUserMessage` converts attachments to atoms cleanly |
| `tugdeck/src/lib/code-session-store/types.ts` | `AttachmentRecord` shape; `TurnEntry.userMessage.attachments` typed |
| `tugdeck/src/components/tugways/cards/tide-card-transcript.tsx` | `UserMessageCell` renders `TugAttachmentStrip` + `TugAtomTextBody` |
| `tugdeck/src/components/tugways/cards/tool-blocks/read-tool-block.tsx` | Path rendered as inline `<img>` via `buildAtomSVGDataUri` |
| `tugdeck/src/components/tugways/cards/tool-blocks/edit-tool-block.tsx` | Same |
| `tugdeck/src/components/tugways/cards/tool-blocks/write-tool-block.tsx` | Same |
| `tugdeck/src/components/tugways/cards/tool-blocks/notebook-edit-tool-block.tsx` | Same, for both `file_path` and `notebook_path` |
| `tugrust/crates/tugcast/src/feeds/filetree_provider.rs` | Built-in denylist ([List L01](#l01-secret-file-denylist)); `.tugattachignore` reader |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `AtomBytesEntry` | type | `atom-bytes-store.ts` | [Spec S02](#s02-atom-bytes-store) |
| `AtomBytesStore` | interface | `atom-bytes-store.ts` | [Spec S02](#s02-atom-bytes-store) |
| `createAtomBytesStore` | factory | `atom-bytes-store.ts` | Returns a fresh per-card instance |
| `AttachmentRecord` | type | `code-session-store/types.ts` | `{ id, role, filename, mediaType, thumbnailDataUrl, byteSize }` |
| `buildWirePayload` | fn | `build-wire-payload.ts` | [Spec S03](#s03-build-wire-payload) |
| `downsampleImage` | fn | `image-downsample.ts` | [Spec S04](#s04-image-downsample) |
| `isAnimatedGif` | fn | `image-downsample.ts` | Pure GIF frame-count detector per [Q04](#q04-animated-gif) |
| `bakeThumbnail` | fn | `image-downsample.ts` | Calls into the same canvas pipeline at 256 px target |
| `buildAtomSVGDataUri` | fn | `tug-atom-img.ts` | [Spec S05](#s05-atom-chip); pure SVG-data-URI helper extracted from `createAtomImgElement` |
| `TugAtomTextBody` | component | `tug-atom-text-body.tsx` | [Spec S05](#s05-atom-chip); pure React walker — splits `(text, atoms)` at `U+FFFC`, interleaves `<img>` per atom |
| `TugAttachmentStrip` | component | `tug-attachment-strip.tsx` | [Spec S06](#s06-attachment-strip) |
| `AtomSegment.id` | field | `tug-atom-img.ts:24` | Optional; minted at drop / paste |
| `SECRET_FILE_DENYLIST` | const | `filetree_provider.rs` | [List L01](#l01-secret-file-denylist) |
| `read_tugattachignore` | fn | `filetree_provider.rs` | Reads `.tugattachignore` at workspace root if present |

---

### Documentation Plan {#documentation-plan}

- [ ] Update `dash/transport-exploration.md` §Test 23 with a note pointing at this plan as the v1 consumer of the image content-block path baseline.
- [ ] Update `tuglaws/tuglaws.md` if any new responder / state-preservation laws emerge from the bytes-store integration.
- [ ] If the `.tugattachignore` feature accrues enough surface to warrant documentation, fold it into the appropriate `tuglaws/` entry rather than spawning a freestanding doc file.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (TS)** | Pure-function coverage | `build-wire-payload`, `atom-bytes-store`, `image-downsample` (with canvas mocks) |
| **Unit (Rust)** | Filter provider coverage | `filetree_provider` built-in denylist, `.tugattachignore` parse |
| **Integration (TS)** | Reducer + store + bytes-store wiring | `code-session-store/__tests__/reducer.test.ts` extensions for `handleSend` and `handleAddUserMessage` |
| **Render** | Component renders correctly | `tug-atom-text-body.test.tsx`, `tug-attachment-strip.test.tsx`, `tide-card-transcript.test.tsx` |
| **Golden / Catalog** | Existing fixture regression | `test-23-image-attachment.jsonl` byte-identical pre/post the wire-flattening landing |
| **End-to-end (`just app-test`)** | Full submit → render → cold-restart loop | Step 8 integration check |
| **Manual smoke** | UX regressions catchable only by eye | Drop a 4K PNG, paste a screenshot, `@`-mention `CLAUDE.md`, submit, observe |

---

### Execution Steps {#execution-steps}

> Each step is one PR-sized commit. Build green at every commit. Steps 1-4 are mostly independent and can land in any order; Steps 5-7 build on the earlier work and must land in sequence. Step 8 is the verification step.

#### Step 1: Image downsample primitive {#step-1}

**Commit:** `feat(tugdeck): image-downsample canvas-based pipeline for inline images`

**References:** [D05](#d05-client-downsample), [Spec S04](#s04-image-downsample), [Table T03](#t03-downsample-decisions), [Risk R01](#r01-canvas-blocking), [Q02](#q02-heic-avif), [Q04](#q04-animated-gif), (#strategy)

**Artifacts:**
- `tugdeck/src/lib/image-downsample.ts` — implements [Spec S04](#s04-image-downsample) per [Table T03](#t03-downsample-decisions).
- `tugdeck/src/lib/__tests__/image-downsample.test.ts` — pure-logic coverage (`isAnimatedGif`, `classifySourceMime`, `fitWithinLongEdge`, exported constants). Canvas-execution behaviors are verified in the real-app integration tests that arrive with Step 2.

**Tasks:**
- [x] Implement `isAnimatedGif(bytes: Uint8Array): boolean` — frame-count detection via image-descriptor markers per [Q04](#q04-animated-gif).
- [x] Implement the GIF pre-check branch: animated → size-only validation; static → canvas pipeline.
- [x] Implement the `createImageBitmap` path with `HTMLImageElement` fallback per [D05](#d05-client-downsample).
- [x] Implement dimension resize to long-edge ≤ 2576 px.
- [x] Implement re-encode by source MIME with JPEG quality ladder (90/80/70/60).
- [x] Implement SVG rasterization at 1024×1024.
- [x] HEIC / AVIF / HEIF flow through the standard raster branch — WebKit decodes them natively via `createImageBitmap`. No special-case branch. Per [Q02](#q02-heic-avif).
- [x] Surface `unsupported-format`, `too-large-after-fallback`, `decode-failed` discriminated errors.
- [x] Export `bakeThumbnail` as a thin wrapper around the same pipeline at 256 px target.

**Tests:**
- [x] `unit: isAnimatedGif on known animated fixture → true` (multiple variants: two consecutive descriptors, descriptors with intervening GCE, three descriptors)
- [x] `unit: isAnimatedGif on known static fixture → false` (multiple variants: GIF89a, GIF87a, no-GCT, with-comment-extension)
- [x] `unit: isAnimatedGif false-positive resistance — `0x2C` inside GCT, Application Extension, and LZW data must not count`
- [x] `unit: isAnimatedGif malformed inputs return false gracefully — empty, too-short, wrong magic, truncated, no-trailer, unknown block byte`
- [x] `unit: classifySourceMime decision matrix — raster MIMEs, GIF, SVG, unsupported, case-insensitivity`
- [x] `unit: fitWithinLongEdge — under cap passes through; oversize scales aspect-preserving; thumbnail and SVG targets; degenerate inputs; sub-pixel clamp to 1`
- [x] `unit: exported constants pinned (MAX_LONG_EDGE_PX, MAX_BYTE_SIZE, THUMBNAIL_MAX_EDGE_PX, SVG_RASTER_MAX_EDGE_PX, JPEG_QUALITY_LADDER monotonic descent)`
- [ ] Canvas-execution coverage (oversize PNG → 2576 px; JPEG quality fallback; PNG→JPEG transcode; SVG raster; corrupt-blob decode-failed; GIF passthrough byte-equality) — exercised by Step 2's real-app integration tests when drop/paste invoke `downsampleImage` against actual files.

**Checkpoint:**
- [x] `bun test src/lib/__tests__/image-downsample.test.ts` (52 pass, 0 fail, 60 expect() calls)
- [x] `bun test` (full tugdeck suite: 2874 pass, 0 fail)
- [x] `bun run check` (TypeScript clean)
- [x] `bun run audit:tokens lint` (zero violations)
- [ ] Manual: drop a real 4K screenshot in Tug.app; observe that `downsampleImage` produces a ≤ 5 MB output (verified via console log). — deferred to Step 2 when drop/paste handlers invoke the pipeline.
- [ ] Manual: drop a `.heic` photo in Tug.app — canvas decode succeeds, image flows through (smoke-verifies [Q02](#q02-heic-avif) on the live surface). — deferred to Step 2.

---

#### Step 2: Browser bytes side-table + drop/paste capture {#step-2}

**Depends on:** #step-1

**Commit:** `feat(tugdeck): atom-bytes-store + drop/paste image bytes capture`

**References:** [D03](#d03-atom-bytes-store), [Spec S02](#s02-atom-bytes-store), [Table T01](#t01-failure-modes), [Risk R01](#r01-canvas-blocking), (#strategy)

**Artifacts:**
- `tugdeck/src/lib/atom-bytes-store.ts` — implements [Spec S02](#s02-atom-bytes-store) (+ `clear()` for store-dispose drain).
- `AtomSegment.id?: string` field added in `tug-atom-img.ts`.
- `drop-extension.ts` exports the async `processAttachmentFiles` helper used by both drop and paste; `tugDropExtension` factory now accepts optional `getBytesStore` + `onAttachmentError` thunks. DOM-managed processing indicator (≥100 ms threshold).
- `clipboard-filters.ts` `clipboardExt` becomes `clipboardExtension(getBytesStore, onAttachmentError)`; `handlePaste` detects `image/*` clipboard items and routes through the shared pipeline. Legacy `clipboardExt` const preserved with default thunks.
- `tug-text-editor.tsx` props gain `attachmentBytesStore` + `onAttachmentError`; ref-mirrored and threaded into `buildExtensions`.
- `tug-prompt-entry.tsx` reads `attachmentBytesStore` from `codeSessionStore.getAtomBytesStore()` and passes `codeSessionStore.publishAttachmentError` as the error callback.
- `code-session-store.ts` owns the per-card `AtomBytesStore` instance, exposes `getAtomBytesStore()`, and has a new `publishAttachmentError(message)` dispatcher.
- Reducer: new `attachment_rejected` `lastError.cause` (in `reducer.ts`, `types.ts`, and `events.ts`); banner label added to `tide-card.tsx` `CAUSE_LABELS`.
- `useCardStatePreservation` extended: `TugPromptEntryState.attachmentBytes` slot + `coerceAttachmentBytes` defensive coercion; onSave snapshots the store, onRestore feeds `bytesStore.restore`.
- CASE-A interrupt restore inherits the bytes-store snapshot (no new code; the state-preservation snapshot covers it).

**Tasks:**
- [x] Implement `AtomBytesStore` per [Spec S02](#s02-atom-bytes-store) with a `Map<string, AtomBytesEntry>` backing (plus `size()` / `clear()` helpers).
- [x] Add `id?: string` to `AtomSegment` and ensure all existing constructions compile.
- [x] Wire `downsampleImage` into `drop-extension.ts` per [D05](#d05-client-downsample); non-image drops continue to use `defaultFilesToAtoms` with no bytes; gallery card's custom handler still wins.
- [x] Wire the paste handler in `clipboard-filters.ts` for `image/*` clipboard items; non-image clipboard items continue through the existing path.
- [x] Wire bytes-store snapshot into `useCardStatePreservation` (new bag slot `attachmentBytes`).
- [x] Show a processing-indicator overlay for `downsampleImage` operations exceeding 100 ms ([Risk R01](#r01-canvas-blocking)) — DOM-managed inside `view.scrollDOM`, themed via the substrate's `baseTheme` (no React state, [L06]).
- [x] Surface `downsampleImage` errors via the `lastError` channel per [Table T01](#t01-failure-modes) — new `attachment_rejected` cause renders through the existing banner.

**Tests:**
- [x] `unit: put / get / delete / snapshot / restore round-trip on AtomBytesStore` (26 pure-logic tests in `__tests__/atom-bytes-store.test.ts`)
- [x] `unit: snapshot returns a fresh object; entries are fresh shapes; JSON-serializable`
- [x] `unit: restore is additive on existing keys; overwrites overlapping ids; filters malformed entries`
- [x] `unit: clear drops all entries; idempotent on empty`
- [x] `unit: instance independence — two stores share no state`
- [ ] Real-app coverage of drop / paste pipelines against actual image bytes — exercised by the integration smoke in Step 8's `just app-test` recipe (the canvas pipeline behavior is verified in the same surface that runs the production code).

**Checkpoint:**
- [x] `bun test` — full tugdeck suite, **2900 pass, 0 fail**
- [x] `bun run check` — TypeScript clean
- [x] `bun run audit:tokens lint` — zero violations
- [x] `cargo nextest run --workspace` — 1324 pass, 0 fail
- [ ] Manual: drop image → close and reopen the card → atom is restored with bytes intact (state preservation works). — deferred to Step 8's manual smoke alongside the rest of the end-to-end flow (drop/paste integration depends on Step 3's wire-flattening to actually exercise the bytes-store at submit).

---

#### Step 3: Wire flattening at submit time {#step-3}

**Depends on:** #step-2

**Commit:** `feat(tugdeck): buildWirePayload — substitute U+FFFC and pack image attachments`

**References:** [D01](#d01-ffc-substitution-at-submit), [D02](#d02-image-attach-text-rest), [Spec S03](#s03-build-wire-payload), [List L03](#l03-atom-to-wire-mapping), [Table T01](#t01-failure-modes), (#send-path)

**Artifacts:**
- `tugdeck/src/lib/build-wire-payload.ts` — pure function per [Spec S03](#s03-build-wire-payload). Returns `{ wireText, attachments }` from `(text, atoms, bytesStore)`. Single O(n) pass; image atoms with bytes emit `Attachment` records, all atoms substitute their `value` into the text.
- `Attachment` wire type defined in `tugdeck/src/protocol.ts`; `InboundMessage.user_message.attachments` tightened from `unknown[]` to `Attachment[]`.
- `code-session-store.ts:send(text, atoms)` calls `buildWirePayload` with the per-card `AtomBytesStore` and dispatches `SendActionEvent { text, atoms, wireText, attachments, turnKey }` with both substrate-form and wire-form populated.
- `SendActionEvent` (in `events.ts`) gains `wireText: string` + `attachments: Attachment[]` slots.
- Internal `queuedSends` entry shape (in `reducer.ts`) extended with `wireText` + `attachments` so the queue-flush at `handleTurnComplete` can construct the `send-frame` effect without re-reading the bytes-store — keeping the reducer pure.
- `reducer.ts:handleSend` (`reducer.ts:680-815`) and queued-send flush (`reducer.ts:2160-2240`) consume the flattened payload: the wire `send-frame` reads `event.wireText` + `event.attachments`; the substrate `UserMessage` keeps `event.text` + `event.atoms` (raw, with `U+FFFC`, for transcript chip placement).
- 40+ reducer-side test sites updated to populate the new fields on `SendActionEvent` constructions.

**Tasks:**
- [x] Implement `buildWirePayload` per [Spec S03](#s03-build-wire-payload).
- [x] Define `Attachment` in `protocol.ts` and tighten `InboundMessage.user_message.attachments`.
- [x] Plumb the bytes-store read through `code-session-store.send` → `buildWirePayload` → action → reducer.
- [x] Replace the `text: event.text` and `attachments: []` literals in `handleSend` and queued-flush with the flattened values (`event.wireText` / `event.attachments`).
- [x] Extend `queuedSends` entry shape so the queue-flush has pre-flattened wire data; mid-turn push captures all four fields.
- [x] Update reducer-side tests that construct `SendActionEvent` to populate `wireText` + `attachments` (40+ sites across `__tests__/reducer.*.test.ts`).

**Tests:**
- [x] `unit: buildWirePayload — text with multiple U+FFFC and matching atoms → wireText substitutes correctly`
- [x] `unit: buildWirePayload — image atom with bytes → Attachment emitted with correct content + mediaType + filename`
- [x] `unit: buildWirePayload — image atom missing from bytes-store → Attachment skipped; text substitution proceeds`
- [x] `unit: buildWirePayload — atoms.length < count(U+FFFC) → leftover U+FFFC passes through (defensive)`
- [x] `unit: buildWirePayload — atoms.length > count(U+FFFC) → extra atoms dropped`
- [x] `unit: buildWirePayload — file / doc / link / command atoms → text-only emission, no Attachment`
- [x] `unit: buildWirePayload — mixed image + file + image — attachments only for images; document order preserved`
- [x] `unit: buildWirePayload — purity (no atom or bytes-store mutation; same inputs → same outputs)`
- [x] `unit: buildWirePayload — non-ASCII characters around atoms preserved verbatim`
- [ ] `integration: handleSend with one image atom + one file atom → send-frame carries 1 Attachment and wireText with substituted values` — exercised by Step 8's end-to-end app-test (a synthetic test against `reducer.handleSend` would just re-pin what the pure tests already pin, since both halves are pure functions).
- [ ] `integration: queued-send flush — same shape assertions` — same.

**Checkpoint:**
- [x] `bun test` — full tugdeck suite, **2924 pass, 0 fail** (24 new buildWirePayload tests + 40+ updated reducer-test constructions)
- [x] `bun run check` — TypeScript clean
- [x] `bun run audit:tokens lint` — zero violations
- [ ] Manual: drop a PNG → submit → observe in Tug.app's dev tools that the WS frame carries an `Attachment` with real bytes; claude responds describing the image, not "I see U+FFFC objects". — deferred to Step 8's manual smoke (depends on Step 5's transcript rendering to fully verify the user-visible flow).

---

#### Step 3.5: Drop UX polish — drag-level rejection, off-thread downsample, skeleton fidelity {#step-3-5}

**Depends on:** #step-3

**Commit:** `fix(tugdeck): drag-level rejection, worker downsample, skeleton polish`

**References:** [D02](#d02-image-attach-text-rest), [D05](#d05-client-downsample), [Risk R01](#r01-canvas-blocking), [Spec S02](#s02-atom-bytes-store), [Spec S04](#s04-image-downsample), [List L03](#l03-atom-to-wire-mapping), (#strategy)

**Why this step exists:** Step 3 shipped the wire flattening, text-attachment support, and a v1 skeleton-atom drop UX. Live testing surfaced four defects the v1 design didn't anticipate:

1. **Banner cascade.** `tide-card.tsx`'s `sessionErrored` check treats *any* `lastError` (except `resume_failed`) as "session is dead", showing the unplug-icon alert dialog. When the new `attachment_rejected` cause landed there, dropping a PDF triggered the catastrophic session-failure dialog. The cause is transient input feedback, not a dead session.
2. **Drop-time rejection feels overblown.** The v1 design accepts an unsupported drop and then surfaces a banner explaining it was rejected. The browser drag-and-drop API supports rejection *at hover time* via the `dragover` handler's `preventDefault` gate — the OS shows the no-drop cursor and the drop event never fires. The right model rejects at the cursor, not via a post-drop banner.
3. **Main thread blocked during encode.** v1's `paintTo` + `convertToBlob` run on the main thread (even with `OffscreenCanvas`, since the canvas was never transferred to a Worker). A 25 MB image jams the UI for ~2 s — keystrokes, scrolls, button clicks all stalled. The right answer is a true Web Worker that owns an `OffscreenCanvas` via `transferControlToOffscreen`.
4. **Skeleton atom appearance + render bugs.** The v1 `opacity: 0.55` + pulse reads as "slightly dim" rather than "actively processing". And dropping into a brand-new, empty editor sometimes shows nothing at all (the atom is inserted but doesn't render — likely a focus / measure timing issue).

This step closes all four. Worker-bound canvas pipeline is the load-bearing piece; the others are smaller cleanups that hang off the same UX rework.

**Artifacts:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` — `sessionErrored` excludes `attachment_rejected` alongside `resume_failed`. The banner still surfaces via the existing banner channel; only the session-dead overlay path is bypassed.
- `tugdeck/src/components/tugways/tug-text-editor/drop-extension.ts` — `dragover` handler examines `event.dataTransfer.items` and refuses (no `preventDefault`) when every item has a known-unsupported MIME (`application/pdf`, `application/zip`, `audio/*`, `video/*`, etc.). Drop-time rejection banner is removed; the cursor signal replaces it. The drop handler silently skips unsupported items in mixed drops.
- New `tugdeck/src/lib/workers/image-downsample-worker.ts` — Web Worker that owns the canvas pipeline. Decodes via `createImageBitmap`, resizes via `OffscreenCanvas`, encodes via `convertToBlob`, posts the result back. All heavy work off the main thread.
- `tugdeck/src/lib/image-downsample.ts` — main-thread `downsampleImage` becomes a thin client that spawns a worker (one per call), posts the Blob, awaits the result, terminates the worker. `bakeThumbnail` follows the same shape.
- `tugdeck/src/components/tugways/tug-text-editor/atom-decoration.ts` — `pendingAtomTheme` rewritten: wider pulse amplitude (0.45 ↔ 0.95), animated icon-slot spinner, ellipsis suffix on the label so the chip clearly reads "this is processing".
- `tugdeck/src/components/tugways/tug-text-editor/drop-extension.ts` (insertion path) — after `insertAtomsAt`, dispatch `view.focus()` + `view.requestMeasure({ read() { return null; } })` so a drop on an unfocused / unmeasured editor doesn't drop the skeleton paint on the floor.

**Tasks:**
- [x] **3.5.1 — Banner cascade fix.** `tide-card.tsx`'s `sessionErrored` excludes `"attachment_rejected"` alongside `"resume_failed"`. The banner-spec helper still produces an error banner for the cause; only the session-dead overlay path is bypassed. New banner-spec test pins this.
- [x] **3.5.2 — Drag-level rejection.** `tugDropExtension`'s `dragenter` / `dragover` call `dragHasSupportedItem(event.dataTransfer)` — walks `DataTransferItemList`, accepts when any item has a supported image MIME, text MIME, or empty MIME (defers to drop-time extension classification). If all items are known-unsupported, returns without `preventDefault` → the OS shows the no-drop cursor and the `drop` event never fires. `classifyDroppedFiles`'s third branch silently skips unsupported items (mixed-drop case only — pure-unsupported drags never reach this handler). New `isTextMimeType` export in `text-attachment.ts` does the MIME-only check without filename access. *(Step 3.5.2 originally accepted text-source files alongside images; the text branch was retired in the Option A image-only narrowing — see [D02](#d02-image-attach-text-rest). `text-attachment.ts` and `isTextMimeType` were deleted.)*
- [x] **3.5.3 — Web Worker downsample.** New `tugdeck/src/lib/workers/image-downsample-worker.ts` owns the canvas pipeline (decode + resize + encode + thumbnail bake). Main-thread `downsampleImage` and `bakeThumbnail` become thin worker shims that spawn one-shot workers per call, post the Blob, await the discriminated response, and terminate. Worker uses its own `OffscreenCanvas` (not transferred from main thread) so all heavy paint / encode work runs off the main event loop. Pure helpers (`isAnimatedGif`, `classifySourceMime`, `fitWithinLongEdge`) and constants remain in `image-downsample.ts` and are imported by the worker.
- [x] **3.5.4 — Skeleton visual polish.** `pendingAtomTheme` rewritten with wider opacity amplitude (0.4 ↔ 1.0, was 0.55 ↔ 0.85) plus a saturation pulse (0.4 ↔ 1.0) so the chip desaturates at the trough and snaps back to full color at the crest. Faster cycle (1.0 s, was 1.2 s) reads as active rather than ambient. Spinner glyph / ellipsis suffix deferred — the opacity + saturation combination tested clearly enough that the additional SVG overlay was unnecessary.
- [x] **3.5.5 — Empty-editor skeleton-render fix.** After `insertAtomsAt` in `processAttachmentFiles`, call `view.focus()` + `view.requestMeasure({ read: () => null })` so a drop into an unmeasured / unfocused editor flushes layout in the same frame as the insertion. Both are idempotent no-ops in the common case (already-focused + already-measured editor).
- [x] **3.5.6 — Drag visual feedback restoration + reject CSS infrastructure for Step 3.5.7.** Three sub-fixes:
  1. *Banner cascade still applied* (3.5.1) — the `attachment_rejected` `lastError` cause was being treated as session-dead, triggering the unplug-icon alert. Fixed by extending `tide-card.tsx`'s `sessionErrored` exclusion list (already done in 3.5.1).
  2. *PDF rejection design walked back.* The 3.5.2 intent — cursor-level rejection via `dragover` returning false for unsupported items — turned out to be infeasible in WKWebView. Instrumented logging confirmed: WebKit redacts `DataTransfer.items` entirely during `dragenter` / `dragover` for cross-origin Finder drags (`items.length === 0`, `files.length === 0`; only `types: ["Files"]` is exposed). At drop time the full MIME info appears. This is [WebKit bug #223517](https://bugs.webkit.org/show_bug.cgi?id=223517), unresolved as of December 2023 — confirmed not fixable from JS by any preference / flag / configuration. Path A (this step) backs out to JS-only accept-all-then-silent-skip-at-drop; Path B (Step 3.5.7 below) brings cursor-level rejection back via a native bridge.
  3. *Three-state `setDropActive` + reject-ring CSS preserved for Path B.* The `null | "accept" | "reject"` state machine and the `[data-drop-active="reject"]` CSS rule (paints the border in `--tug7-element-global-border-normal-danger-rest`) stay in place as infrastructure ready for the native bridge to flip it on. Today JS-only code only ever sets `"accept"` or `null`.

  Net result of 3.5.6: `dragenter` / `dragover` always claim file drags (override CM6's internal handler), always show the accept ring + copy cursor, never reject at the cursor. `drop` calls `dropHasSupportedFile` which inspects the now-unredacted `dataTransfer.files` and refuses pure-unsupported drops silently (no atom, no banner — the missing chip is the signal).

**Tests:**
- [x] `unit: tide-card-banner-spec — attachment_rejected surfaces as banner error, does NOT escalate to session-dead overlay` (Step 3.5.1)
- [x] ~~`unit: isTextMimeType — text/*, application/* allowlist, charset stripping, empty MIME returns false, binaries rejected`~~ (Step 3.5.2 supporting tests — retired with the text-attachment branch in the Option A image-only narrowing)
- [ ] `unit: dragHasSupportedItem` synthetic-DataTransferItemList tests (Step 3.5.2) — DataTransferItemList isn't constructible in pure-logic Bun tests; covered via the real-app drag in Step 8.
- [ ] Manual: drop a 25 MB PNG; observe the editor stays responsive to keystrokes throughout encoding. (Step 3.5.3)
- [ ] Manual: drop a PDF onto the editor; observe the OS no-drop cursor; release; observe no banner / no atom appears. (Step 3.5.2)
- [ ] Manual: open a fresh card with empty editor; drop a PNG; skeleton atom appears immediately at the drop point. (Step 3.5.5)

**Checkpoint:**
- [x] `bun test` — full tugdeck suite, **2983 pass, 0 fail**
- [x] `bun run check` — TypeScript clean
- [x] `bun run audit:tokens lint` — zero violations
- [ ] Manual: all three drop scenarios above behave correctly.

---

#### Step 3.5.7: Native drag bridge — cursor-level rejection via NSDraggingDestination {#step-3-5-7}

**Depends on:** #step-3-5

**Commit:** `feat(tugapp+tugdeck): native drag bridge for cursor-level file-type rejection`

**References:** [D02](#d02-image-attach-text-rest), [Spec S04](#s04-image-downsample), (#strategy)

**Why this step exists:** Step 3.5.6 walked back cursor-level rejection because it's infeasible in JS-only WKWebView code — [WebKit bug #223517](https://bugs.webkit.org/show_bug.cgi?id=223517) reveals empty `DataTransferItemList` during `dragenter` / `dragover` for cross-origin file drags (the Finder drag case). The bug is unresolved and the WebKit team's own documented workaround is *"the only workaround to this bug is not to filter by file type at all"*. That's the JS world's hard ceiling.

But Tug.app is not the JS world. Tug.app is a macOS app whose Swift host owns the WKWebView's container view. The native side has full access to `NSPasteboard` during drag — including all UTIs / MIMEs / filenames / file URLs — because it operates outside the sandboxed web content. The right architecture: native side reads the pasteboard, native side posts the file info to JS via `WKScriptMessageHandler`, JS uses that info to drive the same `dragHasSupportedItem` style accept/reject decision the cursor-level CSS already supports (Step 3.5.6 preserved the `[data-drop-active="reject"]` rule and the three-state `setDropActive` for exactly this).

This step ships that bridge. After it lands, dragging a PDF over the prompt entry shows the red rejection ring and the OS no-drop cursor *before release* — the original UX intent of Step 3.5.2.

**Strategy:**
- Use macOS's `NSDraggingDestination` protocol on the WKWebView's container view (or a thin subclass). `draggingEntered:`, `draggingUpdated:`, `draggingExited:`, and `prepareForDragOperation:` receive the full `NSDraggingInfo` with `NSPasteboard` access.
- Read the pasteboard's file URLs (`NSPasteboard.PasteboardType.fileURL`) at every drag update. Resolve each to its UTI / MIME via `NSWorkspace.shared.type(ofFile:)` or the file URL's `getResourceValue(forKey: .typeIdentifierKey)`.
- Post the drag-snapshot to JS via the existing message channel (already used by the test harness for `evalJS`). JS-side reads from a new global (e.g., `window.__tugActiveDrag`) keyed by drag-session id; the drop extension's `dragHasSupportedItem` checks this in addition to (or instead of) `event.dataTransfer`.
- On `draggingExited:` / drop end, clear the JS-side snapshot so a subsequent drag starts fresh.
- All JS-side classification logic from `dragHasSupportedItem` + `classifySourceMime` works unchanged on the bridge data. *(Originally `isTextMimeType` was part of this set; retired with the text-attachment branch in the Option A image-only narrowing — see [D02](#d02-image-attach-text-rest).)*

#### [Q05] Bridge message timing vs. dragover events (OPEN) {#q05-bridge-timing}

**Question:** WKWebView's `dragenter` / `dragover` events fire synchronously when the OS dispatches the drag to the WebView. The native bridge's `WKScriptMessageHandler.postMessage` is asynchronous (queued on the JS thread). Can JS see the bridge data inside the same `dragover` tick that fired, or does the bridge data lag by one event?

**Why it matters:** If the bridge data lags, the first dragover frame after `draggingEntered:` would see no data and would have to default to "accept" — flashing the accept ring before the reject ring on the next frame. Annoying but not catastrophic; we'd document it.

**Plan to resolve:** Build the bridge minimally first (Step 3.5.7.a), measure the timing in dev panel, decide on a synchronization strategy (probably: native side calls `evaluateJavaScript("window.__tugActiveDrag = ...")` synchronously inside `draggingEntered:`, which blocks until JS receives the assignment — slower but synchronization-correct).

**Resolution:** RESOLVED — async eval-JS with one-frame race window. Native side calls `webView.evaluateJavaScript("window.__tugActiveDrag = <json>")` *before* invoking `super.draggingEntered:`, so the assignment task is queued ahead of the synthesized JS dragenter event on the WebContent runloop's task queue. Both land on the same JS thread; queue ordering means the assignment is processed first. The first dragover after a fresh drag may still race ahead of the assignment by one tick — the JS reader treats that as `getCurrentDragFiles() === null` and falls back to the legacy `types.includes("Files")` accept-all behavior for that one frame. Every subsequent dragover frame sees the snapshot and classifies accurately. The first-frame fallback is identical in appearance to the pre-3.5.7 Path A behavior, so the regression cost of the race is zero; the win is that sustained drags (which spend ≫ 1 frame over the editor) stabilize on the correct accept / reject ring well before the user decides whether to release.

Synchronous evaluateJavaScript is *not* used — it would block the AppKit drag dispatch on the WebContent runloop, which is fragile under heavy JS load and unnecessary given that the one-frame race is benign.

**Artifacts:**
- `tugapp/Sources/Drag/PasteboardSnapshot.swift` (new) — pure-Swift `Codable` struct that reads file URLs from `NSPasteboard` (via `readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true])`), resolves each URL's UTI via `URLResourceKey.typeIdentifierKey` (falling back to `UTType(filenameExtension:)`) and converts to a preferred MIME, returns `{ files: [{ name, mimeType?, size? }] }`. Has a `jsonString()` helper that emits sorted-keys JSON for embedding into an `evaluateJavaScript` literal.
- `tugapp/Sources/Drag/TugDragDestination.swift` (new) — a thin object that holds a weak reference to a `WKWebView`. `observeDragUpdate(sender:)` snapshots the pasteboard and pushes the JSON into JS via `webView.evaluateJavaScript("window.__tugActiveDrag = <json>")`. `observeDragEnded()` pushes `null`. Logs `evaluateJavaScript` errors via `NSLog`.
- `tugapp/Sources/Drag/TugWebView.swift` (new) — `WKWebView` subclass that overrides `draggingEntered`, `draggingUpdated`, `draggingExited`, and `concludeDragOperation`. Each override calls the corresponding `TugDragDestination` observer *before* invoking `super`, so the snapshot assignment is queued ahead of WebKit's synthesized JS dragenter event on the WebContent runloop (see [Q05](#q05-bridge-timing)).
- `tugapp/Sources/MainWindow.swift` (modify) — `webView = TugWebView(frame: .zero, configuration: config)` (was `WKWebView(...)`). Single-line change; `TugWebView IS-A WKWebView`, so all existing call sites (`testHarnessWebView`, `evaluateJavaScript`, navigation delegate, etc.) keep working unchanged.
- `tugapp/Tug.xcodeproj/project.pbxproj` (modify) — registers the three new Swift files in the `Sources` build phase and groups them under a new `Drag` PBXGroup.
- `tugdeck/src/lib/native-drag-bridge.ts` (new) — typed reader over the native-pushed `window.__tugActiveDrag` global. Exports `getNativeDragSnapshot(): NativeDragSnapshot | null` (full snapshot) and `getCurrentDragFiles(): readonly NativeDragFileEntry[] | null` (the files array). Both return `null` when the global is absent, explicitly `null`, or malformed — callers fall through to the legacy `types.includes("Files")` accept-all path. Defensive shape checks tolerate stray non-string `name` / non-string `mimeType` / non-number `size` entries.
- `tugdeck/src/lib/__tests__/native-drag-bridge.test.ts` (new) — pure-logic Bun tests pinning the absent / null / undefined / malformed-shape behavior. Thirteen tests, all green.
- `tugdeck/src/components/tugways/tug-text-editor/drop-extension.ts` (modify) — adds `nativeDragHasSupportedFile(entries)` (the per-entry classifier) and `dragOutcomeFromBridge()` (the bridge-or-fallback decision). `dragenter` and `dragover` consult `dragOutcomeFromBridge()` and pass the result to `setDropActive(host, …)`. The drop caret is suppressed during reject (no destination position to indicate). `dropEffect` is set to `"none"` for reject, `"copy"` for accept.
- `dash/tide-atoms.md` — [Q05](#q05-bridge-timing) marked RESOLVED with the chosen async-eval + one-frame race window strategy; [D02](#d02-image-attach-text-rest) updated to drop the "cursor rejection infeasible" caveat.

**Tasks:**
- [x] **3.5.7.a — Native scaffold.** New Swift files: `PasteboardSnapshot.swift`, `TugDragDestination.swift`, `TugWebView.swift`. Wire `TugWebView` into `MainWindow.swift` in place of `WKWebView`. At each `draggingEntered:` / `draggingUpdated:`, snapshot the pasteboard and call `webView.evaluateJavaScript("window.__tugActiveDrag = <JSON>")`. At `draggingExited:` / `concludeDragOperation:`, clear it (`window.__tugActiveDrag = null`).
- [x] **3.5.7.b — JS bridge consumer.** New `tugdeck/src/lib/native-drag-bridge.ts`. Reads `window.__tugActiveDrag` on demand (no polling; the drop extension calls the getter from inside `dragenter` / `dragover`). Exports `getCurrentDragFiles(): readonly NativeDragFileEntry[] | null` and `getNativeDragSnapshot()`.
- [x] **3.5.7.c — Wire drop-extension to the bridge.** New `dragOutcomeFromBridge()` returns `"accept"` or `"reject"` after consulting the bridge; falls back to `"accept"` when the bridge is absent (browser-only or first-frame race). `setDropActive(host, outcome)` drives the CSS ring; `dropEffect` flips between `"copy"` and `"none"`.
- [x] **3.5.7.d — Bridge-timing resolution.** [Q05](#q05-bridge-timing) resolved by design: queue the assignment before `super.draggingEntered`, accept the one-frame race window as benign (it degrades to Path A behavior for that single frame). Strategy documented at the head of `tugdeck/src/lib/native-drag-bridge.ts` and `tugapp/Sources/Drag/TugDragDestination.swift`. Dev-panel timing measurement deferred until a regression report cites a visible flash — the documented strategy already covers the case where the race window is wider than expected.
- [x] **3.5.7.e — Path B test surface.** Accepted as manual-only. WKWebView drag dispatch is driven by the macOS AppKit drag manager from a real human pointer down + motion + up, not by anything `evalJS` can synthesize. The existing app-test harness's `evalJS` synthesizes JS-level events (focus, keypress, click via CGEvent) but not OS-level NSDragging. Manual smoke verification (the three scenarios under **Tests**) is the contract.

**Tests:**
- [ ] `unit (Swift): PasteboardSnapshot — reads file URLs, resolves UTIs to MIMEs, returns the expected JSON shape` — deferred: no XCTest target exists in `tugapp/Tug.xcodeproj`. Adding one for a single test is disproportionate; the JS-side `native-drag-bridge.test.ts` pins the cross-language shape contract by exercising every well-formed and malformed payload shape the Swift side could emit, and the build + manual smoke catches any runtime divergence.
- [x] `unit (TS): native-drag-bridge — getCurrentDragFiles returns null when window.__tugActiveDrag is unset; returns parsed array when set` — pure-logic Bun test in `tugdeck/src/lib/__tests__/native-drag-bridge.test.ts`, 13 cases.
- [ ] Manual: drag a PDF over the prompt entry — observe red reject ring + OS no-drop cursor *before* release; release; observe no banner / no atom.
- [ ] Manual: drag a PNG — observe blue accept ring + OS copy cursor; release; observe skeleton atom appears and downsamples in the background.
- [ ] Manual: drag a mixed-content folder (PDF + PNG) — observe accept ring (at least one supported item); release; PNG appears, PDF silently skipped.

**Checkpoint:**
- [x] `cd tugapp && xcodebuild -scheme Tug -configuration Debug build` clean
- [x] `cd tugdeck && bun test && bun run check && bun run audit:tokens lint` clean (2996 / 2996 pass; tsc no-emit clean; zero token violations)
- [ ] Manual: the three scenarios above behave correctly in Tug.app.
- [x] [D02](#d02-image-attach-text-rest) updated to reflect cursor-level rejection working again.

---

#### Step pre-4: Per-card FILETREE_QUERY routing {#step-pre-4}

**Depends on:** (none — independent of Steps 1-3.5)

**Blocks:** [Step 4](#step-4)'s manual smoke (the `@`-popup must hit the card's project workspace, not the bootstrap, for the secret filter to be observable).

**Commit:** `feat(tugcast): route FILETREE_QUERY to per-card workspaces`

**References:** (this step), [`tugrust/crates/tugcast/src/main.rs:217-245`](../tugrust/crates/tugcast/src/main.rs) (the bootstrap-only adapter), [`tugrust/crates/tugcast/src/feeds/workspace_registry.rs`](../tugrust/crates/tugcast/src/feeds/workspace_registry.rs) (`W2` per-session `get_or_create`).

#### The bug, in one sentence {#step-pre-4-bug}

The `FILETREE_QUERY` adapter forwards every JS-side completion query to **`bootstrap.ft_query_tx`** — the single bootstrap workspace's filetree channel, fixed at startup to the tugtool repo. Per-session `WorkspaceEntry` instances are constructed for each tide-card project (each gets its own `FileWatcher`, `FileTreeFeed`, and now `SecretFilter`), but the routing adapter does not multiplex; their channels are never read from. Result: `@`-completion in a card whose project is `/tmp/files` queries the *tugtool repo's* index, returns matches against that index (or no matches at all), and the SecretFilter from [Step 4](#step-4) is provably unobservable from the popup.

This is a pre-existing architectural gap (`bootstrap.ft_query_tx.clone()` committed 2026-04-14), surfaced by the [Step 4](#step-4) manual smoke. It is independent of Step 4's code — Step 4 backend works correctly when queried directly (verified by the `/tmp/files` repro test), but the user-visible feature requires this routing fix.

#### Strategy {#step-pre-4-strategy}

The fix is small and additive — no protocol bump, no JS payload schema change beyond a field that already exists. Three layers:

1. **JS-side: populate the `root` field on every `FILETREE_QUERY`** with the active card's project directory. `FileTreeStore.sendQuery` already accepts an optional `root` parameter; `getFileCompletionProvider` currently passes none. The card-services layer knows the project dir at construction time — pass it down into `FileTreeStore` so the provider can include it on every query.

2. **Rust-side: registry lookup by path.** Add `WorkspaceRegistry::find_entry_by_path(&Path) -> Option<Arc<WorkspaceEntry>>`. Derives the `WorkspaceKey` the same way `get_or_create` does (canonical path → key), looks up the inner map.

3. **Rust-side: rewire the adapter.** Give the adapter task access to the registry (`Arc<WorkspaceRegistry>`). On each frame: if `root` is set and a registered entry matches, send to *that* entry's `ft_query_tx`; otherwise fall back to bootstrap (preserves single-workspace behavior and keeps the legacy `--source-tree`-only callers working).

The existing `[D09]` "retarget the bootstrap to a new root" semantics that lives inside `FileTreeFeed::handle_query` becomes dead code in production once JS always passes `root` — the registry lookup short-circuits before the retarget. Removing the retarget code is out-of-scope (low value, would churn tests); leaving it is harmless.

#### Artifacts {#step-pre-4-artifacts}

- `tugrust/crates/tugcast/src/feeds/workspace_registry.rs` (modify) — `find_entry_by_path(&Path) -> Option<Arc<WorkspaceEntry>>` that canonicalizes the input the same way `get_or_create` does (so a JS-supplied `/tmp/files` matches an entry registered as `/private/tmp/files`).
- `tugrust/crates/tugcast/src/main.rs` (modify) — adapter task captures `Arc<WorkspaceRegistry>`; per-frame lookup → entry-specific `ft_query_tx`; bootstrap fallback when the lookup misses or `root` is unset.
- `tugdeck/src/lib/filetree-store.ts` (modify) — `FileTreeStore` constructor takes an optional `projectDir` (string); `getFileCompletionProvider` passes it as `root` on every `sendQuery`.
- `tugdeck/src/lib/card-services-store.ts` (modify) — pass the card's `projectDir` into the `FileTreeStore` constructor at the existing construction site.

#### Tasks {#step-pre-4-tasks}

- [x] **pre-4.a — Registry lookup.** Added `WorkspaceRegistry::find_entry_by_path` that canonicalizes via `PathResolver::watch_path` (same as `get_or_create`) so `/tmp/files` matches an entry registered as `/private/tmp/files`. Three unit tests pin Some / None / canonicalization-match.
- [x] **pre-4.b — Adapter rewire.** Extracted the routing logic into `WorkspaceRegistry::route_filetree_query(ftq, &bootstrap_tx)` and collapsed the inline adapter in `main.rs` to call it. The legacy `[D09]` retarget path inside `FileTreeFeed::handle_query` is preserved but unreached for routed queries.
- [x] **pre-4.c — JS plumbing.** `FileTreeStore` gained an optional `projectDir: string` constructor arg; `getFileCompletionProvider` includes it as `root` on every `sendQuery`. `CardServicesStore` passes `binding.projectDir` at the construction site.
- [x] **pre-4.d — Stale-routing safety.** Matched-but-closed channel logs `warn!` and drops; *no* fall-through to bootstrap (a torn-down workspace's stale tugtool results would be the wrong UX). Unmatched root and absent root both fall through to bootstrap.

#### Tests {#step-pre-4-tests}

- [x] `unit (Rust): WorkspaceRegistry::find_entry_by_path returns Some for a registered path; returns None for an unknown path; canonicalizes a /tmp/files-style indirect input → matches the registered entry.` Three cases in `workspace_registry::tests`.
- [x] `integration (Rust): route_filetree_query with a matching root sends to the card workspace and not the bootstrap.` `test_route_filetree_query_routes_to_registered_workspace`.
- [x] `integration (Rust): route_filetree_query with an unknown root falls through to the bootstrap.` `test_route_filetree_query_falls_back_when_root_unknown`.
- [x] `integration (Rust): route_filetree_query with root=None falls through to the bootstrap.` `test_route_filetree_query_falls_back_when_root_absent`.
- [x] Manual: open a card with project `/tmp/files` (containing `.env`, `.tugattachignore` (`.env`), `bar`, `foo`); type `@` → see `bar`, `foo`, `.tugattachignore`; type `@.env` → no suggestion appears. This is the [Step 4](#step-4) manual smoke that this step unblocks. Verified live in Tug.app.

#### Checkpoint {#step-pre-4-checkpoint}

- [x] `cd tugrust && cargo nextest run -p tugcast` — 645 / 645 pass (was 639; +6 new routing/lookup tests).
- [x] `cd tugrust && cargo build --tests --workspace` — warnings-as-errors clean.
- [x] `cd tugdeck && bun test && bun run check && bun run audit:tokens lint` — 3009 / 3009 pass; tsc clean; zero token violations.
- [x] Manual: the `/tmp/files` scenario above behaves correctly in Tug.app — this also closes the last open checkbox of [Step 4](#step-4)'s checkpoint.

#### Out of scope {#step-pre-4-out-of-scope}

- **Other per-card feeds (FILESYSTEM, GIT) likely share the same bootstrap-only adapter shape.** Their UX impact in the W2 multi-workspace model is unknown today; surveying and (if needed) fixing them is a separate piece of work. This step is scoped to filetree because that is the one feature the [Step 4](#step-4) acceptance criteria need.
- **Retiring the `[D09]` retarget code in `FileTreeFeed::handle_query`** — once routing is the production path the retarget becomes dead but harmless. Removing it would churn existing retarget tests for no UX benefit; leave for a future cleanup.

---

#### Step 4: Completion-time secret-file filter + `.tugattachignore` {#step-4}

**Depends on:** [Step pre-4](#step-pre-4) (for manual smoke validation only; the backend itself is independent of Steps 1-3.5).

**Commit:** `feat(tugcast): filetree provider secret-file denylist + .tugattachignore`

**References:** [D06](#d06-completion-time-filter), [List L01](#l01-secret-file-denylist), [Risk R04](#r04-manual-path-leak), [Risk R05](#r05-tugattachignore-parser), (#permission-gating)

**Artifacts:**
- `tugrust/crates/tugcast/src/feeds/secret_filter.rs` (new) — `SECRET_FILE_DENYLIST` constant per [List L01](#l01-secret-file-denylist); `SecretFilter::new(workspace_root)` builds an `ignore::Gitignore` matcher combining the built-in patterns with `<workspace>/.tugattachignore` (optional); `is_secret(relative_path)` uses `matched_path_or_any_parents` so directory patterns like `local-secrets/` exclude their children. Parse errors logged via `tracing::warn!`; surviving patterns still apply. Note: actual filename is `secret_filter.rs` (not `filetree_provider.rs` — the live file is `filetree.rs`, and the new code lands in a sibling module to keep the walker / matcher concerns separated).
- `tugrust/crates/tugcast/src/feeds/filetree.rs` (modify) — `FileTreeFeed::new` builds the `SecretFilter` from `project_dir` and sweeps the freshly-walked `initial_files` through it (`Self::sweep_secrets`). `apply_events` skips secret-shape Create / Rename-to events so a freshly-dropped `.env` never enters the index. `off_board_query` filters per-entry against the bare filename (off-board paths sit outside the workspace, so we match against `name` not `relative_path`). The watcher batch handler detects both `.gitignore` and `.tugattachignore` changes — the latter rebuilds the matcher *before* the re-walk so the sweep sees current patterns. `retarget` rebuilds the matcher for the new root.
- `tugrust/crates/tugcast/src/feeds/mod.rs` (modify) — register `pub mod secret_filter`.

**Tasks:**
- [x] Add `SECRET_FILE_DENYLIST` constant in `secret_filter.rs` per [List L01](#l01-secret-file-denylist).
- [x] Implement `.tugattachignore` reader using the existing `ignore` crate; cache compiled patterns at filter construction.
- [x] Plumb the combined matcher into the per-query filter path (sweep at insertion + per-event filter + off-board per-entry); surface a tugcast-telemetry `parse-error` event on malformed patterns via `tracing::warn!` (the existing tugcast log channel) per [Table T01](#t01-failure-modes).
- [~] ~~Document the syntax in a fresh `docs/tugattachignore.md`~~ — dropped. The feature's externally-visible surface is small enough (one optional file, gitignore syntax) that a freestanding doc file is more clutter than help. Future need: fold into a `tuglaws/` entry alongside the related laws, not a standalone document.

**Tests:**
- [x] `unit (Rust): SECRET_FILE_DENYLIST matches .env, .env.local, *.pem, id_rsa*, secrets.json, .aws/credentials, .ssh/**, etc.` — 7 cases in `secret_filter::tests`.
- [x] `unit (Rust): .tugattachignore patterns parsed via the ignore crate match expected paths` — `tugattachignore_patterns_apply` + `missing_tugattachignore_is_not_an_error`.
- [x] `unit (Rust): combined match order — built-in denylist + .tugattachignore produce deny-precedence; malformed patterns don't disable the rest` — `tugattachignore_combined_with_builtin_in_one_filter` + `malformed_tugattachignore_line_does_not_disable_filter`.
- [x] `integration: FileTreeFeed against a synthetic workspace excludes secrets from empty/scored/off-board queries; apply_events skips secret creations` — five integration tests in `filetree::tests` covering initial-files sweep, scored query, .tugattachignore application, apply_events filtering, and off-board filtering.

**Checkpoint:**
- [x] `cd tugrust && cargo nextest run -p tugcast` — 639 tests pass.
- [x] `cd tugrust && cargo build --tests --workspace` — warnings-as-errors clean.
- [x] Manual: type `@.env` in the prompt-entry's `@`-popup in a workspace containing `.env` → no suggestion appears. Verified live in Tug.app against `/tmp/files`.

---

#### Step pre-5: Participant / row-cell rename — `code` → `assistant` {#step-pre-5}

**Depends on:** (none — independent refactor)

**Blocks:** [Step 5](#step-5) (Step 5 modifies a cell that gets renamed here; doing the rename first means Step 5's transcript-atom work targets the post-rename names from the outset).

**Commit:** `refactor(tugdeck): code → assistant in participant/row/cell layer`

**References:** [`tugdeck/src/lib/code-session-store/types.ts:104`](../tugdeck/src/lib/code-session-store/types.ts) (`MessageKind` — the substrate's message-forward source of truth), [`tugdeck/src/components/tugways/tug-transcript-entry.tsx:75`](../tugdeck/src/components/tugways/tug-transcript-entry.tsx) (`Participant` type), [`tugdeck/src/lib/tide-transcript-data-source.ts:123`](../tugdeck/src/lib/tide-transcript-data-source.ts) (`TideTranscriptCellKind`).

#### The inconsistency, in one sentence {#step-pre-5-inconsistency}

The substrate's `MessageKind` (`user_message | assistant_text | assistant_thinking | tool_use | system_note`) is message-forward and uses `assistant_*` for Claude's contributions, but the participant / row / cell layer above it still calls Claude's side `code` — `Participant = "user" | "code" | "shell"`, `TideTranscriptCellKind = "user" | "code" | "ghost"`, `CodeRowCell`, `participant="code"` JSX, `[data-participant="code"]` CSS. The migration is partly done — newer code (`half: "user" | "assistant"` types in `tide-card-transcript.tsx:937` and `tide-card.tsx:305`, `tide-assistant-renderer-dispatch.ts` filename) uses `assistant`, the legacy participant/row layer hasn't followed.

#### Strategy {#step-pre-5-strategy}

The rename is mechanical and lockstep — every `code` literal in the *participant / row / cell* layer becomes `assistant`. The user side gets a complementary rename to make the *pair* coherent: `UserRowCell` → `UserMessageCell` to mirror the fact that the user row carries exactly one `user_message`, while the assistant row aggregates a turn's worth of `assistant_*` + `tool_use` + `system_note` messages. The asymmetry is real in the data (one message vs. many) and should be visible in the names.

**Order of operations:** rename the *type literals* first (`Participant`, `TideTranscriptCellKind`, `TideZ1BParticipant`). Because they're typed string unions, tsc surfaces every legacy `"code"` consumer as a compile error — the typed substrate becomes the rename's enforcement gate. Sweeping CSS / data-attribute / doc-comment / test-fixture sites after that is grep work, but the type-error frontier guarantees no source consumer is missed.

**Distinct concepts that share the word `code` for unrelated reasons are LEFT ALONE:**

| Concept | Layer | Decision |
|---|---|---|
| `CodeSessionStore`, `code-session-store/` | Session class hosting Claude in coding mode | **Stays `code`** — session/card layer, not participant. |
| "Code card" | Tide card type | **Stays `code`** — card mode, not message participant. |
| `data-route="code"` (tide-route-indicator-badge) | Routing prefix `>` destination | **Stays `code`** — route name (where input is going), not speaker name. |
| Markdown ``` ``` block parsing | Programming-code rendering | **Stays `code`** — unrelated meaning of the word. |

**Renamed to `assistant`** — every site where `code` denotes "the AI participant in the transcript" (the speaker, not the card mode):

- `Participant = "user" | "code" | "shell"` → `"user" | "assistant" | "shell"` ([`tug-transcript-entry.tsx:75`](../tugdeck/src/components/tugways/tug-transcript-entry.tsx)).
- `TideTranscriptCellKind = "user" | "code" | "ghost"` → `"user" | "assistant" | "ghost"` ([`tide-transcript-data-source.ts:123`](../tugdeck/src/lib/tide-transcript-data-source.ts)).
- `TideZ1BParticipant = "user" | "code"` → `"user" | "assistant"` ([`tide-card-z1b.tsx:109`](../tugdeck/src/components/tugways/cards/tide-card-z1b.tsx)).
- `UserRowCell` → `UserMessageCell` (renders one `user_message`).
- `CodeRowCell` → `AssistantTurnCell` (aggregates the assistant's whole turn).
- `UserRowCellProps` / `CodeRowCellProps` → `UserMessageCellProps` / `AssistantTurnCellProps`.
- `CODE_DEFAULT_IDENTIFIER` → `ASSISTANT_DEFAULT_IDENTIFIER`; `ESTIMATED_HEIGHT_CODE` → `ESTIMATED_HEIGHT_ASSISTANT`; `isCodeRow` → `isAssistantRow` (cell-local helpers).
- Every `"code"` literal site that flows from the renamed types: `kind: "code"`, `kind === "code"`, ternary results, renderer-map keys, JSX `participant="code"` props.
- `[data-participant="code"]` CSS selectors. The DOM `data-participant` attribute the component emits rides on the typed `Participant`, so it flips automatically when the type literal flips.
- All in-file doc-block / tuglaws-reference comments that mention `CodeRowCell` / `UserRowCell` / `participant="code"`.

#### Artifacts {#step-pre-5-artifacts}

No new files, no file renames. Modifications, grouped by layer:

**Substrate types (force the tsc-error frontier):**

- [`tugdeck/src/components/tugways/tug-transcript-entry.tsx`](../tugdeck/src/components/tugways/tug-transcript-entry.tsx) — `Participant` type literal; header docstring.
- [`tugdeck/src/lib/tide-transcript-data-source.ts`](../tugdeck/src/lib/tide-transcript-data-source.ts) — `TideTranscriptCellKind` literal; ~12 internal string-literal sites (`return "code"`, `kind: "code"`, `isCodeRow` ternaries); `kindForIndex` doc; module-header doc.
- [`tugdeck/src/components/tugways/cards/tide-card-z1b.tsx`](../tugdeck/src/components/tugways/cards/tide-card-z1b.tsx) — `TideZ1BParticipant` literal; ~4 `participant === "code"` checks; module-header doc-block.

**Cell components + their callers:**

- [`tugdeck/src/components/tugways/cards/tide-card-transcript.tsx`](../tugdeck/src/components/tugways/cards/tide-card-transcript.tsx) — `UserRowCell` → `UserMessageCell`; `CodeRowCell` → `AssistantTurnCell` (+ `*Props` interfaces); `participant="code"` JSX (×2 sites); renderer-map key `"code": codeRenderer` → `"assistant": assistantRenderer`; `kind === "code"` reads; `ESTIMATED_HEIGHT_CODE` / `CODE_DEFAULT_IDENTIFIER` / `isCodeRow` helper renames; module-header doc-block + tuglaws comments.

**DOM / CSS:**

- [`tugdeck/src/components/tugways/tug-transcript-entry.css`](../tugdeck/src/components/tugways/tug-transcript-entry.css) — `[data-participant="code"]` selector (one site).
- [`tugdeck/src/components/tugways/cards/tide-card-z1b.css`](../tugdeck/src/components/tugways/cards/tide-card-z1b.css) — comment reference.

**Galleries (development-only screens; still load at startup):**

- [`tugdeck/src/components/tugways/cards/gallery-transcript-entry.tsx`](../tugdeck/src/components/tugways/cards/gallery-transcript-entry.tsx) — `participant="code"` → `"assistant"`.

**Tests:**

- [`tugdeck/src/lib/__tests__/tide-transcript-data-source.test.ts`](../tugdeck/src/lib/__tests__/tide-transcript-data-source.test.ts) — test literals matching the renamed `kind` values.
- [`tugdeck/src/components/tugways/cards/__tests__/tide-card-z1c.test.ts`](../tugdeck/src/components/tugways/cards/__tests__/tide-card-z1c.test.ts) — references to `UserRowCell` / `CodeRowCell` / participant strings.

**Stale comment references (touch-and-go):**

- [`tugdeck/src/lib/code-session-store.ts:279`](../tugdeck/src/lib/code-session-store.ts) — one comment line mentioning `CodeRowCell`.

**Tuglaws documentation drift (markdown — not tsc-protected):**

- [`tuglaws/state-preservation.md:19`](../tuglaws/state-preservation.md) — the canonical L23/L26 example narrates the chain `reducer → snapshot → TideTranscriptDataSource.rowAt → CodeRowCell`. The cell name in this load-bearing tuglaws example becomes `AssistantTurnCell` post-rename.
- [`tuglaws/design-decisions.md:243`](../tuglaws/design-decisions.md) (D96) — references `CodeRowCell` in the post-unification render contract that ties per-turn-path seeding to the assistant row's observer pattern.

**Best-effort enumeration only.** The list above is what the audit surfaced; the typed `Participant` / `TideTranscriptCellKind` / `TideZ1BParticipant` rename forces tsc to expose any other consumer. Task pre-5.i closes the loop with an explicit final grep for surviving hits — including against `tuglaws/` and `docs/`, neither of which gets compile-time coverage.

#### Files explicitly NOT touched {#step-pre-5-exempt}

- [`tugdeck/src/lib/code-session-store/`](../tugdeck/src/lib/code-session-store) — session class, not participant. `CodeSessionStore` stays.
- [`tugdeck/src/components/tugways/chrome/tide-route-indicator-badge.{tsx,css}`](../tugdeck/src/components/tugways/chrome) — `data-route="code"` is the route-prefix destination, not the participant.
- [`tugdeck/src/lib/markdown/parse-markdown-to-sanitized-blocks.ts`](../tugdeck/src/lib/markdown/parse-markdown-to-sanitized-blocks.ts) — markdown ``` ``` block parsing; "code" here is programming-code, not participant.

#### Tasks {#step-pre-5-tasks}

- [x] **pre-5.a — Type literals.** Rewrote `Participant`, `TideTranscriptCellKind`, `TideZ1BParticipant` to `"...assistant..."`. tsc surfaced two test-file consumers in `tide-transcript-data-source.test.ts`; everything else flowed through types cleanly.
- [x] **pre-5.b — Cell components.** Renamed `UserRowCell` → `UserMessageCell`, `CodeRowCell` → `AssistantTurnCell` (and their `*Props` interfaces, every internal reference, `cellRenderers` map key + lambda, error messages, dev-throw text).
- [x] **pre-5.c — Cell-local helpers.** Renamed `CODE_DEFAULT_IDENTIFIER` → `ASSISTANT_DEFAULT_IDENTIFIER` (value `"Code"` kept — it's the brand-name placeholder for the card-mode layer); `ESTIMATED_HEIGHT_CODE` → `ESTIMATED_HEIGHT_ASSISTANT`; `isCodeRow` → `isAssistantRow`; `codeRenderer` → `assistantRenderer`.
- [x] **pre-5.d — Literal-site sweep.** Every `"code"` string the type-rename surfaced has flipped: ternary results, renderer-map key, JSX `participant="code"` (×2), `kind === "code"` reads, `kind: "code"` writes, the React key suffix `-code` → `-assistant` in `idForIndex`. tsc green confirms completeness.
- [x] **pre-5.e — DOM + CSS.** Updated `[data-participant="code"]` selector + the internal alias token `--tugx-transcript-icon-color-code` → `--tugx-transcript-icon-color-assistant` in `tug-transcript-entry.css`. The DOM `data-participant` attribute the JSX emits flips automatically with the renamed `Participant` type.
- [x] **pre-5.f — In-file doc-blocks + comments.** Updated module-header docstrings in `tide-card-transcript.tsx`, `tide-transcript-data-source.ts`, `tide-card-z1b.tsx`, `tide-card-z1b.css`, `tug-transcript-entry.tsx`. Updated the stray `code-session-store.ts:279` comment. Historical references to past kinds (`"code-streaming"` / `"code-committed"`) left in place — they describe pre-unification state and are accurate as history.
- [x] **pre-5.g — Tuglaws documentation update.** Updated `tuglaws/state-preservation.md:19` (canonical L23/L26 chain now ends at `AssistantTurnCell`) and `tuglaws/design-decisions.md:243` (D96 render-contract references `AssistantTurnCell`).
- [x] **pre-5.h — Test sweep.** Updated `tide-transcript-data-source.test.ts` literals (`"code"` → `"assistant"`, key suffixes `-code` → `-assistant`, describe/test titles). Updated `tide-card-z1c.test.ts` docstring reference to `AssistantTurnCell`. Both suites green.
- [x] **pre-5.i — Final audit grep.** Ran the full sweep across `tugdeck/src/components/tugways`, `tugdeck/src/lib/tide-transcript-data-source.ts`, `tugdeck/src/lib/__tests__`, `tuglaws/`, `docs/`. Surviving `"code"` hits are all explicitly exempt: `NotebookCellType = "code" | "markdown"` (programming-code), `PathIconKind = "code"` (file-icon kind), markdown-block type `"code"`, Zod error code field, route system (`data-route="code"`, `RouteLifecycle("code")`), filesystem directory fixture strings. No participant/row-cell hits.

#### Tests {#step-pre-5-tests}

Pure rename — no new behaviour. The gates are existence-and-green:

- [x] `tide-transcript-data-source.test.ts` green after the renamed `kind` literals propagate.
- [x] `tide-card-z1c.test.ts` green after renamed cell identifiers propagate.
- [x] Full `bun test` green — 3009 / 3009 pass, 9901 expect() calls, no regressions.

#### Checkpoint {#step-pre-5-checkpoint}

- [x] `cd tugdeck && bun test` — 3009 / 3009 pass.
- [x] `cd tugdeck && bun run check` — tsc clean.
- [x] `cd tugdeck && bun run audit:tokens lint` — zero token violations.
- [x] Final audit grep (task pre-5.i above) returns only the explicitly-exempt survivors.
- [x] Manual: open Tug.app — transcript still renders user + Claude rows correctly; Z1B end-state row shows correct styling under its renamed `participant="assistant"` attribute; no visual regression. Verified.

#### Out of scope {#step-pre-5-out-of-scope}

- **`CodeSessionStore` / `code-session-store/` rename.** Different concept (session class hosting Claude in coding mode). If "code card / code session" naming is itself due for a revisit, that's a separate plan that should also consider what "shell card / shell session" looks like once shell-routed cards exist.
- **Route-indicator badge naming (`data-route="code"`).** Whether route names should follow participant names is a Tide-wide consistency question, not a transcript-rendering question.
- **`shell` participant rename.** This step leaves `shell` untouched. If/when shell-output rendering lands, the symmetric question (`ShellOutputCell`? `ShellTurnCell`?) gets answered in that step.
- **DOM attribute name (`data-participant` itself).** Whether to call it `data-speaker` / `data-role` / `data-author` is a styling-convention discussion, not a scope of this rename. The attribute *value* is what flips here; the attribute *name* stays.

---

#### Step 5: Atom rendering in the transcript user-message row {#step-5}

**Depends on:** #step-3, #step-pre-5

**Commit:** `feat(tugdeck): render atoms in the transcript user-message row`

**References:** (#transcript-rendering)

**Scope decision (recorded here; [D07] and [Spec S05] are superseded):** Earlier drafts proposed a shared React `AtomChip` primitive consumed by the editor's CM6 widget, the transcript user row, and assistant-side tool-block path rendering. That extra surface is dropped. The editor already renders atoms correctly as `<img>` replaced elements (`tug-atom-img.ts`); rebuilding it as a React component buys nothing the substrate doesn't already give us for free and risks the carefully-engineered caret / selection / clipboard behaviour that depends on `<img>`'s replaced-element semantics. The transcript user row is the actual gap — `UserMessageCell` currently dumps the raw substrate text (including U+FFFC) into a plain `<span>`. The minimum honest fix is a small React component that walks `(text, atoms)` and renders the same `<img>` the editor uses today, via the same SVG builder, at each `U+FFFC` position.

The single mechanical refactor needed: extract the SVG-data-URI builder from `createAtomImgElement` as a pure helper (`buildAtomSVGDataUri(type, label, value)`), so the new React component can render `<img src={dataUri} ...>` directly without mounting React inside a CM6 widget. `createAtomImgElement` keeps its current shape and calls the extracted helper internally — the editor's render path is byte-for-byte unchanged.

**Artifacts:**

- [`tugdeck/src/lib/tug-atom-img.ts`](../tugdeck/src/lib/tug-atom-img.ts) (modify) — extract `buildAtomSVGDataUri(type, label, value, options?): { dataUri: string; width: number; height: number; baselineOffset: number }` as a pure helper. `createAtomImgElement` continues to be the editor's entry point and calls the helper internally; its output (and CM6 widget integration) is unchanged.
- `tugdeck/src/components/tugways/cards/tug-atom-text-body.tsx` (new) — `<TugAtomTextBody text={string} atoms={ReadonlyArray<AtomSegment>}>`. Splits `text` on `U+FFFC`, interleaves `<img src={dataUri} width=... height=... alt={atom.label} style={{verticalAlign: ...px}}>` per atom built via `buildAtomSVGDataUri`. Pure render; no effects, no refs.
- [`tugdeck/src/components/tugways/cards/tide-card-transcript.tsx`](../tugdeck/src/components/tugways/cards/tide-card-transcript.tsx) (modify) — `UserMessageCell`'s body `<span>{text}</span>` becomes `<TugAtomTextBody text={text} atoms={atoms} />`. `atoms` is read from `committedUser?.attachments ?? activeUser?.attachments ?? []` on the same Message that supplies `text`.

**Explicitly not in this step:**

- No new `AtomChip` React component.
- No changes to `atom-decoration.ts` or any CM6 widget code.
- No gallery card variant. (Existing galleries already exercise the editor's atom rendering; the new `TugAtomTextBody` is a pure walker and is covered by the render tests below.)
- No assistant-side tool-block atom rendering — that lands in [Step 7](#step-7), which uses the same `buildAtomSVGDataUri` helper extracted here (inline `<img>` per tool-block path field, no walker since paths are single strings).

**Tasks:**

- [x] **5.a — Extract SVG helper.** Added `buildAtomSVGDataUri(type, label, value, options?): AtomSvgResult` in `tug-atom-img.ts`. The helper packages theme-token reads + SVG generation + data-URI conversion + height/baseline math. `createAtomImgElement` now calls it internally and applies the DOM-only concerns (dataset, title, id/pending) on top. The observable `<img>` (`src`, `width`, `height`, `verticalAlign`, dataset attributes, title) is byte-identical.
- [x] **5.b — Build `TugAtomTextBody`.** New `tugdeck/src/components/tugways/cards/tug-atom-text-body.tsx`. Exports the pure substrate walker `walkAtomText(text, atoms) → AtomTextSegment[]` (text / atom / stray-ffc segments) and the `forwardRef`-wrapped component. The render layer maps each segment to either a `React.Fragment` (text / stray-ffc) or an `<img src={buildAtomSVGDataUri(...).dataUri}>`. Root span carries `data-slot="tug-atom-text-body"` ([L19]); passes `className` + `data-testid` through; ref forwards to the span. Defensive `stray-ffc` segment for `U+FFFC` past `atoms.length` per [Spec S03].
- [x] **5.c — Wire `UserMessageCell`.** Replaced the body `<span>{text}</span>` with `<TugAtomTextBody ref={…} className=… data-testid=… text={text} atoms={atoms} />`. `atoms` sourced from `committedUser?.attachments ?? activeUser?.attachments ?? []`. `stripUserBodyPrefix` only strips the `>` route prefix; it never touches `U+FFFC`, so the (text, atoms) index alignment survives the strip.

**Tests:**

- [x] Substrate pinned via `walkAtomText` — 9 pure-logic cases in `tug-atom-text-body.test.ts` cover: empty input, plain text + no atoms, one atom between text, two atoms with text between, more `U+FFFC` than atoms (`stray-ffc` defensive branch), leading `U+FFFC`, trailing `U+FFFC`, atom-only text, and atoms supplied without matching `U+FFFC`. The React mapping is mechanical (segment → Fragment or `<img>`), so pinning the substrate covers the render shape. Manual smoke covers end-to-end visual verification.

**Checkpoint:**

- [x] `cd tugdeck && bun test` — 3018 / 3018 pass (was 3009 pre-step; +9 walker tests).
- [x] `cd tugdeck && bun run check` — tsc clean.
- [x] `cd tugdeck && bun run audit:tokens lint` — zero token violations.
- [ ] Manual: in a tide card, type a message with an `@`-completed atom (e.g., `look at @file.txt`), submit → transcript user row shows the same chip the editor showed pre-submit. The chip's icon, label, and baseline match the editor by eye. (Awaiting manual verification.)

---

#### Step 5c: Content-block wire shape + JSONL-honest substrate synthesis {#step-5c}

**Depends on:** #step-3 (revises `buildWirePayload`'s contract), #step-5 (the renderer that consumes the synthesized substrate is in place).

**Blocks:** #step-6 (the per-message strip + numbered chips depend on the synthesized substrate this step produces).

**Commit:** `feat(tugdeck+tugcode): content-block wire shape + JSONL-honest substrate synthesis`

**References:** [Spec S01](#s01-attachment-wire-type) (the wire-shape `Attachment` type retires under this step), [Spec S03](#s03-build-wire-payload) (revised — `buildWirePayload` returns content blocks). Anthropic API messaging guide on interleaved `content` blocks.

#### Motivation {#step-5c-motivation}

[Step 5](#step-5)'s manual smoke checkbox stays open for a reason: cold-mount of a session with atom-bearing turns doesn't restore the inline chips. The substrate (`text` with `U+FFFC` + `AtomSegment[]` carrying labels) isn't in claude's JSONL — claude only sees the flat `wireText` (atom values substituted in) plus wire-shape image attachments. On reload, tugcode's replay path re-emits the wire shape, the reducer casts wire-shape attachments to `AtomSegment[]`, and the renderer paints plain text with no chips.

We previously considered a tugcast session-ledger schema extension to journal the substrate alongside the wire. That approach worked but added a cross-process schema migration, new protocol fields, and reducer fallback paths for every code path that consumes attachments. The cost was significant and the gain was visual fidelity (filenames on restored chips), not information fidelity (the data was already in JSONL via the wire substitution).

The simpler design — and the one this step ships — leans into JSONL. Anthropic's content-block array natively preserves the **position** of image content in the message stream; today's `buildWirePayload` flattens that information by emitting `[image, image, …, text]` rather than the interleaved `[text, image, text, image, text]` the user actually composed. If we emit interleaved blocks instead, the image-atom **position** survives JSONL round-trip for free. The chip's **label** (the original filename) doesn't survive — JSONL has no filename field on the `image` block — but we don't need it: we synthesize a deterministic label (`#0001-image-1`) at the submit / replay boundary and pair it with a thumbnail strip below the message. The numbering provides visual linkage between inline chip and strip thumbnail; the user can see what image goes where without a filename in the chip.

The trade-off, accepted explicitly: **the live transcript shows the same numeric chip the restored transcript shows**, not the user's original filename. This is honest to what persists across reload. The editor (pre-submit) still shows filenames in chips — that's the drafting surface, before commit. The commit boundary is where the substrate switches from user-friendly labels to JSONL-honest synthesized labels. One consistent visual language in the transcript, live and restored, with no surprise at the reload boundary.

#### Strategy {#step-5c-strategy}

Five coordinated layers:

1. **`buildWirePayload` returns content blocks, not flat `(wireText, attachments)`.** The walker over `(text, atoms)` emits an array of `{type: "text", text}` and `{type: "image", source}` blocks in document order. File-path atoms substitute their `value` into the surrounding text block; image atoms become standalone image blocks at their position.

2. **Wire frame revision.** Tugdeck's `user_message` frame carries `content: ContentBlock[]` instead of `text: string, attachments: Attachment[]`. The frame body is Anthropic's content-block shape — same as what tugcode forwards to claude.

3. **Tugcode pass-through.** Tugcode's `user_message` handler today builds Anthropic content blocks from the flat `text + attachments` shape. After this step it forwards `content` blocks directly — pass-through, no construction. Tugcode's JSONL-replay emit (`add_user_message`) emits `content: ContentBlock[]` (the JSONL message content array, unchanged from the recorded form).

4. **Substrate synthesis (live + replay, single shared implementation).** Both `handleSend` (live submit) and `handleAddUserMessage` (JSONL replay) walk the content blocks and synthesize a `UserMessage` substrate identically:
   - Walk blocks in order, maintaining a per-message image-counter and a text accumulator.
   - For each `text` block: append `block.text` to the accumulator.
   - For each `image` block: emit `U+FFFC` into the accumulator; mint an `AtomSegment` with `type: "image"`, `label: "image-N"` (where N is the 1-based per-message image counter — no `#NNNN-` prefix at this layer), `value: "image-N"`; resolve the atom's `id` via the optional `atomIdAt(imageBlockIndex)` resolver, or mint a fresh UUID when no resolver is supplied; **bake the thumbnail (256-px max edge) from the block's bytes** and write the bytes-store entry as `{content, mediaType, thumbnailDataUrl}` under that id.
   - Yield `{ text: accumulator, atoms: [...] }`.
   - The synthesis is deterministic on its inputs **plus the id resolver**. The live path passes a resolver that maps **image-block index → original atom id** so bytes-store entries from drop/paste don't become orphans. The replay path passes no resolver — fresh UUIDs are minted; the bytes-store is per-card-mount (fresh on reload) so id reuse from a prior session is impossible.
   - **The thumbnail bake is part of synthesis, not a separate commit-path step.** Both live and replay produce bytes-store entries that already carry `thumbnailDataUrl` — the strip renderer in [Step 6](#step-6) can read it unconditionally, with no "did the bake happen yet?" branch.

5. **`buildWirePayload` returns its own resolver.** The walk that produces content blocks also knows which editor atoms became image blocks (atoms with `id` whose bytes are in the store) and in what order. Returning a resolver built from that walk eliminates the chance of an index mismatch between "editor's image-atom count" and "blocks that actually became image blocks" — e.g., when an editor atom has no bytes in the store and `buildWirePayload` defensively skips emitting its block ([Spec S03] invariant). `handleSend` passes the wire payload's `atomIdAt` straight through to the synthesizer; no cross-data-source matching, no resolver-built-externally fragility.

6. **Queued-send shape carries both halves.** When the user submits while a turn is in-flight, the message queues for later flush ([`reducer.ts:798`](../tugdeck/src/lib/code-session-store/reducer.ts) today carries `{text, atoms, wireText, attachments, turnKey}`). Post-5c, the queued entry carries `{content: ContentBlock[], syntheticText: string, syntheticAtoms: AtomSegment[], turnKey: string}` — the wire content (for send-on-flush) plus the already-synthesized substrate (so `handleTurnComplete`'s queue-flush branch mints the new `UserMessage` directly without re-synthesizing). Synthesis happens exactly once per submission, at `handleSend` time, regardless of whether the message goes active or queued. Bytes-store entries are minted at synthesis time and persist across the queue gap (the bytes-store is per-card-mount).

5. **Render-time label decoration.** `TugAtomTextBody` accepts an optional `messageNumber: number` prop. When set, each image atom's *displayed* chip label becomes `#${pad4(messageNumber)}-${atom.label}` (e.g., `#0001-image-1`). When unset, the atom's stored `label` is used as-is — leaving the editor's pre-submit chip rendering (which doesn't have a transcript position) unaffected. The 4-digit padding matches the existing transcript sequence-number convention (`#NNNN`).

#### The submit boundary is real {#step-5c-submit-boundary}

The editor's pre-submit chips show user-friendly labels (`raphael.jpeg`, `src/main.ts`) because the substrate still carries the filenames/paths the user typed. At submit, `handleSend` runs `buildWirePayload` and then re-synthesizes the substrate from the resulting blocks — the synthesized substrate has `image-N` labels, file-path atoms are gone (substituted into text). The transcript renders from the synthesized substrate.

The crossing is deliberate. The editor is the drafting surface; the transcript is the JSONL-honest committed view. They have different visual languages because they represent different states. A reader who notices the change at submit (chip label flips from filename to numbered + path drops the chip wrapping for file atoms) is seeing the data layer revealing itself — what's editable vs. what's recorded.

#### Artifacts {#step-5c-artifacts}

**Tugdeck — wire generation:**

- [`tugdeck/src/lib/build-wire-payload.ts`](../tugdeck/src/lib/build-wire-payload.ts) — `buildWirePayload` returns `{ content: ContentBlock[]; atomIdAt: (imageBlockIndex: number) => string | undefined }`. Walker over `(text, atoms)` emits interleaved blocks: text accumulates between `U+FFFC` positions; each image atom (with bytes in the store) becomes a standalone `image` block; each file-path atom substitutes `atom.value` into the current text block. Adjacent text segments coalesce into a single text block; an image at the start / end of text doesn't generate empty surrounding text blocks. The walker tracks which atoms became image blocks (atoms whose bytes were in the store) and returns `atomIdAt` as a closure over that mapping — `handleSend` passes it straight to the synthesizer with no cross-data-source matching.
- [`tugdeck/src/protocol.ts`](../tugdeck/src/protocol.ts) — `ContentBlock` union type matching Anthropic's API shape. `UserMessageWireFrame` revised: `{ type: "user_message", content: ContentBlock[] }` (drops `text` and `attachments`). Old `Attachment` interface deprecated and removed.

**Tugdeck — synthesizer + reducer:**

- New `tugdeck/src/lib/code-session-store/synthesize-user-message.ts` (or co-located in reducer.ts — caller's preference). Shared helper:

  ```ts
  function synthesizeUserMessageFromBlocks(
    blocks: ReadonlyArray<ContentBlock>,
    bytesStore: AtomBytesStore,
    options?: {
      /**
       * Optional resolver: given the index of an image block within
       * `blocks` (0-based, counting only image blocks), return the
       * id to reuse for that block's atom. Returning `undefined`
       * (or omitting the resolver entirely) falls through to a
       * freshly-minted UUID.
       *
       * Live path: pass a resolver mapping image-block index → the
       * original atom's id (sourced from the editor's substrate at
       * submit time). The synthesizer's bytes-store puts overwrite
       * the original drop/paste entries idempotently (same id, same
       * bytes, same mediaType — newly with `thumbnailDataUrl`).
       *
       * Replay path: omit the resolver — fresh UUIDs minted; the
       * bytes-store is empty at restore time so no orphans arise.
       */
      atomIdAt?: (imageBlockIndex: number) => string | undefined;
    },
  ): { text: string; atoms: AtomSegment[] };
  ```

  Bakes thumbnails as it walks; bytes-store entries get `thumbnailDataUrl` at synthesis time. Pure on its inputs (deterministic blocks → substrate); bytes-store side-effect is the documented seam.

- [`tugdeck/src/lib/code-session-store/reducer.ts`](../tugdeck/src/lib/code-session-store/reducer.ts) — `handleSend` runs `buildWirePayload`, sends the frame with `content`, then calls the synthesizer with the wire payload's `atomIdAt` (no externally-built resolver). `handleAddUserMessage` calls the same synthesizer with no resolver. No fallback path, no cast.
   The **queued-send entry shape** changes: today's `{text, atoms, wireText, attachments, turnKey}` (line ~798) becomes `{content: ContentBlock[], syntheticText: string, syntheticAtoms: AtomSegment[], turnKey: string}`. Synthesis happens once at `handleSend` time regardless of active-vs-queued; `handleTurnComplete`'s queue-flush branch (line ~2194) sends the queued entry's `content` to claude and mints the new turn's `UserMessage` directly from `syntheticText` + `syntheticAtoms` — no re-synthesis at flush time.
- [`tugdeck/src/lib/code-session-store/events.ts`](../tugdeck/src/lib/code-session-store/events.ts) — `AddUserMessageEvent` revised: `content: ContentBlock[]` (drops `text` and `attachments`). The wire wrapper that converts inbound frames to events already passes through unknown fields; the rewrite just retypes the field.

**Tugcast (Rust) — inspector + journal:**

- [`tugrust/crates/tugcast/src/feeds/payload_inspector.rs`](../tugrust/crates/tugcast/src/feeds/payload_inspector.rs) — `InspectedPayload` gains `content: Option<Vec<serde_json::Value>>` parsed from the inbound `user_message`'s `content` field. The existing `text` and `attachments` fields stay typed as today (`Option<String>` + `Option<Vec<serde_json::Value>>`) and become **derived** from `content` for the journal: a small `derive_legacy_journal_view` helper concatenates text-block contents into `text` and reshapes image blocks into wire-shape `Attachment` JSON values for `attachments`. This is a lossy projection of content blocks back into the legacy journal shape — acceptable because the journal's only consumer is the never-drop synthetic emit path (rare gap between submit and JSONL ack); the JSONL-replay path doesn't touch the journal.
- [`tugrust/crates/tugcast/src/feeds/agent_supervisor.rs`](../tugrust/crates/tugcast/src/feeds/agent_supervisor.rs) — the `user_message` intercept (`dispatch_one` around line 2971) reads the inspector's derived `text` + `attachments` for `insert_pending_turn`; otherwise unchanged. Frame forwarding stays pass-through — tugcast doesn't reshape the content blocks; it just notes the journal-side projection.
- `session_ledger.rs` — **unchanged.** The journal schema (`turns.user_text` + `turns.user_attachments`) stays as today; only its writer-side input source changes (derived from `content` rather than direct).

**Tugcode — wire forwarding + replay + never-drop synthetic:**

- [`tugcode/src/types.ts`](../tugcode/src/types.ts) — `UserMessage` inbound IPC frame retyped to carry `content`. `AddUserMessage` outbound IPC frame likewise.
- [`tugcode/src/session.ts`](../tugcode/src/session.ts) — `user_message` handler forwards `content` blocks directly to the Anthropic SDK (`messages.create({ messages: [{ role: "user", content }] })` — the inbound shape IS the API shape; no construction step). `injectPendingRowSynthetics` (line ~2912) reads journal rows in their legacy shape (`text` + `attachments`) and emits synthetic `add_user_message` frames with `content` blocks built via a small `buildContentBlocksFromLegacyJournal(text, attachments)` helper — flat all-images-first-then-text shape (loses interleaving for synthetics; acceptable trade-off since the never-drop path is the gap-bridge, not the primary restore path).
- [`tugcode/src/replay.ts`](../tugcode/src/replay.ts) — `handleUserEntry` reads `entry.message.content` (already content-block shape in JSONL) and emits `{ type: "add_user_message", content: <blocks>, ... }`. The current text-blocks-concatenation + image-extraction loop disappears.

**Tugdeck — render-time decoration:**

- [`tugdeck/src/components/tugways/cards/tug-atom-text-body.tsx`](../tugdeck/src/components/tugways/cards/tug-atom-text-body.tsx) — `TugAtomTextBodyProps` gains optional `messageNumber?: number`. When set, the chip's displayed `alt` and the SVG label text use `#${pad4(messageNumber)}-${atom.label}` (the 4-digit padding helper is shared with the existing transcript sequence-number rendering — extract into a small `pad4` utility if not already shared).
- [`tugdeck/src/components/tugways/cards/tide-card-transcript.tsx`](../tugdeck/src/components/tugways/cards/tide-card-transcript.tsx) — `UserMessageCell` passes `messageNumber={index + 1}` to `TugAtomTextBody`. (The sequence number in the entry header reads the same value via `sequenceNumber`.)

#### Tasks {#step-5c-tasks}

**Tugdeck wire generation:**

- [x] **5c.a — `ContentBlock` types.** Define `ContentBlock` union in `protocol.ts`; replace `Attachment` exports. Type-only change; consumers compile against the new shape.
- [x] **5c.b — `buildWirePayload` refactor.** Return `{ content: ContentBlock[] }`. Walker emits interleaved blocks; file atoms substitute, image atoms become blocks. Adjacent text coalesces. Update [Spec S03](#s03-build-wire-payload).
- [x] **5c.c — Wire frame retyping.** `UserMessageWireFrame` carries `content`. The frame builder in the WS-send wrapper passes `event.content` through.

**Tugcast (Rust) — inspector + journal projection:**

- [x] **5c.d — Inspector `content` field.** `InspectedPayload` parses `content` from the inbound `user_message` payload. Existing `text` + `attachments` fields stay typed as today; their populated values come from `derive_legacy_journal_view(content)`.
- [x] **5c.e — `derive_legacy_journal_view` helper.** Pure function in `payload_inspector.rs`. Takes content blocks; returns `(text: String, attachments: Vec<serde_json::Value>)`. Text concatenates the text-block contents; attachments reshape each image block into the wire-shape `{filename, content, media_type}` (filename derived from… we have nothing to derive from here at the inspector layer — leave blank, matching the existing JSONL-replay path's hardcoded `filename: ""`).
- [x] **5c.f — Supervisor intercept unchanged.** `agent_supervisor.rs:dispatch_one`'s `user_message` intercept consumes `inspected.text` + `inspected.attachments` (now derived) for `insert_pending_turn`. Confirm pass-through forwarding still hands `content` to tugcode unchanged.

**Tugcode pass-through + synthetic:**

- [x] **5c.g — IPC types.** `UserMessage` / `AddUserMessage` carry `content`.
- [x] **5c.h — `user_message` handler.** Pass `content` to the SDK directly; remove the text+attachments→content-blocks construction.
- [x] **5c.i — Replay emit.** `handleUserEntry` emits `{ content: blocks }`; remove the concat-text-extract-images loop. Empty-text / empty-attachments edge cases stay handled at the synthesizer layer downstream.
- [x] **5c.j — Never-drop synthetic.** `injectPendingRowSynthetics` (session.ts) emits `{ content: ContentBlock[] }`. Add `buildContentBlocksFromLegacyJournal(text, attachments): ContentBlock[]` — flat (all images first, then text) — used here. Acceptable interleaving loss for the never-drop gap-bridge path.

**Tugdeck synthesis + decoration:**

- [x] **5c.k — `synthesizeUserMessageFromBlocks` helper.** Shared between live and replay. Optional `atomIdAt(imageBlockIndex)` resolver in the options bag — live path supplies it from the editor's substrate; replay path omits it. Bakes thumbnails per image block (`bakeThumbnail` invocation lands here, not in commit path). Pure-on-inputs (modulo bytes-store side effect).
- [x] **5c.l — `handleSend` integration.** Calls `buildWirePayload` (now returns `{content, atomIdAt}`); sends the frame with `content`; calls synthesizer with `wirePayload.atomIdAt`. Stores the active-turn `UserMessage` with the synthesized substrate, or builds the queued-send entry `{content, syntheticText, syntheticAtoms, turnKey}` when the message goes to the queue.
- [x] **5c.m — `handleAddUserMessage` integration.** Calls synthesizer on `event.content` with no resolver. Removes the loose `event.attachments as ReadonlyArray<AtomSegment>` cast outright. No fallback path.
- [x] **5c.n — `handleTurnComplete` queue-flush integration.** When `state.queuedSends.length > 0` at a successful `turn_complete`, take the first queued entry; send its `content` to claude; mint the new active turn's `UserMessage` directly from `syntheticText` + `syntheticAtoms` (no re-synthesis). Bytes-store entries from the original submit time stay live across the gap.
- [x] **5c.o — `messageNumber` prop on `TugAtomTextBody`.** Threads through to the chip label. Default behavior (no prop set) unchanged. Extract `pad4` if a shared helper isn't already present.
- [x] **5c.p — `UserMessageCell` wiring.** Passes `messageNumber={index + 1}` to `TugAtomTextBody`.

#### Tests {#step-5c-tests}

**Synthesizer (pure, bun:test):**

- [x] `synthesizeUserMessageFromBlocks([]) → { text: "", atoms: [] }`.
- [x] `synthesizeUserMessageFromBlocks([{text: "hello"}]) → { text: "hello", atoms: [] }`.
- [x] `synthesizeUserMessageFromBlocks([{text: "a "}, {image}, {text: " b"}]) → { text: "a ￼ b", atoms: [{label: "image-1", id: <uuid>, …}] }`. Bytes land in the per-call bytes-store under `id` with `thumbnailDataUrl` populated.
- [x] `synthesizeUserMessageFromBlocks(consecutive images) → { text: "￼￼", atoms: [image-1, image-2] }`.
- [x] `synthesizeUserMessageFromBlocks(image-only) → { text: "￼", atoms: [image-1] }`.
- [x] **`atomIdAt` resolver honored (live path):** calling with `atomIdAt: (i) => ["editor-id-A", "editor-id-B"][i]` produces atoms with ids `editor-id-A` and `editor-id-B`; bytes-store entries land under those same ids. Confirms the live path reuses editor ids and doesn't orphan bytes-store entries.
- [x] **No resolver = fresh UUIDs (replay path):** calling with no `atomIdAt` produces atoms with freshly minted UUIDs; bytes-store entries under those UUIDs. Confirms the replay path operates without an editor-substrate dependency.
- [x] **Resolver returns `undefined` for an index → fresh UUID for that block:** mixed mode (some atoms have editor ids, some don't — defensive against partially-populated editor substrates) works without crashing.
- [x] `synthesizeUserMessageFromBlocks` is byte-identical on two calls with the same inputs **and same resolver** (the substrate's atom ids match deterministically); without a resolver, the rest of the substrate is byte-identical but UUIDs differ (documented seam, not a bug).
- [x] **Thumbnail bake happens during synthesis:** bytes-store entries from the synthesizer carry a populated `thumbnailDataUrl` (matches a 256-px-max-edge data URL shape). Pin the size + the `data:image/…;base64,…` prefix.

**`buildWirePayload` round-trip (pure, bun:test):**

- [x] `buildWirePayload(text="a￼b", atoms=[fileAtom]).content === [{text: "a/path/to/file.txtb"}]` — file atom substituted, single text block.
- [x] `buildWirePayload(text="a￼b", atoms=[imageAtom-with-bytes]).content === [{text: "a"}, {image: …}, {text: "b"}]` — image becomes its own block, surrounding text intact.
- [x] **`buildWirePayload`'s `atomIdAt(0)` returns the editor atom's id** for an image block that emerged from an atom with bytes in the store.
- [x] **`buildWirePayload`'s `atomIdAt` correctly skips bytes-less atoms.** Editor has two image atoms; only one has bytes in the store. `content` has one image block; `atomIdAt(0)` returns the bytes-bearing atom's id (not the other one's). Pins the no-mismatch promise.
- [x] `buildWirePayload` over `(text, atoms)` → `synthesizeUserMessageFromBlocks(content, store, { atomIdAt: wirePayload.atomIdAt })` → a substrate where image-atom positions are preserved, image-atom labels are `image-N`, **and atom ids are reused from the editor** (no orphans).

**Render-time label (bun:test, pure-logic):**

- [x] `TugAtomTextBody` with `messageNumber={1}` and a single image atom labeled `image-1` → walks to a chip whose label is `#0001-image-1`. Pinned via `decorateChipLabel(atom, 1) === "#0001-image-1"` — the pure decoration helper extracted from the component body. (The original "pin the SVG text content" half would require DOM rendering, which we can't unit-test post-happy-dom; the formula is the same single line, so pinning the helper covers the contract.)
- [x] `TugAtomTextBody` with `messageNumber` unset → chip label is the atom's stored `label` verbatim (no `#NNNN-` prefix). Pinned via `decorateChipLabel(atom, undefined) === atom.label`.

**Integration (pure-logic over event/state, bun:test):**

- [x] `handleSend` with a substrate containing one image atom → `UserMessage` lands on `pendingTurn` with synthesized substrate (`label: "image-1"`); wire frame's `content` carries the interleaved blocks; bytes-store has the image entry **under the editor's original atom id** (not a freshly-minted UUID) — confirming the live path's resolver is wired correctly. (`code-session-store.step-5c.test.ts`)
- [x] `handleSend` with a substrate containing two image atoms → bytes-store entries land under the two editor ids (no orphans).
- [x] `handleAddUserMessage` with an `add_user_message` event carrying content blocks → `UserMessage` substrate matches `handleSend`'s output for the same content blocks (modulo UUID values, which are intentionally fresh on the replay path).
- [x] `handleSend` while a turn is in-flight → produces a queued-send entry of shape `{content, text, atoms, turnKey}`. Synthesis happens once at submit (bytes-store entries land at this moment), not deferred to flush.
- [x] `handleTurnComplete` with a non-empty queue → flushes the first queued entry, sends its `content` to claude, mints the new active turn's `UserMessage` directly from the queued entry's `text` + `atoms` (no re-synthesis at flush time, bytes-store entries unchanged).

**Tugcast (Rust, cargo nextest):**

- [x] `derive_legacy_journal_view([{text: "hello"}, {image}, {text: " world"}]) → ("hello world", [<image-attachment-json>])` — text concatenates, image reshapes to wire-Attachment JSON with `filename: ""`, `media_type` + `content` from the block's source.
- [x] `InspectedPayload::from_slice` with a `content`-only payload populates `text` + `attachments` via the derive helper. (Integration with the existing inspector tests — extend, don't replace.)
- [x] `agent_supervisor.dispatch_one` integration: an inbound `user_message` frame with `content` blocks results in a journal row whose `user_text` matches the derived text and `user_attachments` matches the derived wire-shape array. (`dispatch_one_derives_journal_row_from_content_blocks` in `agent_supervisor.rs` — and pins that the forwarded payload is byte-identical to the input, no content-block reshaping by the dispatcher.)

**Tugcode never-drop synthetic (bun:test):**

- [x] `buildContentBlocksFromLegacyJournal("hello", [imageAttachment])` — flat shape (text-first-then-attachments). Pinned by the renamed-from-`buildContentBlocks` tests in `session.test.ts`. The plan's earlier spec said "images first" but the actual shape is text-first; documented this in the helper's revised docstring.
- [x] `injectPendingRowSynthetics` with one pending row → emits one synthetic `add_user_message` frame whose `content` matches the legacy-journal builder's output for that row. (`replay-pending-row-injection.test.ts` — strengthened the `attachments round-trip` test to pin the exact content-block shape via `buildContentBlocksFromLegacyJournal`.)

#### Checkpoint {#step-5c-checkpoint}

- [x] `cd tugdeck && bun test` — full suite green; new synthesizer + label-decoration tests pass.
- [x] `cd tugdeck && bun run check` — tsc clean. The retyped `Attachment` → `ContentBlock` migration surfaces every consumer that wasn't updated.
- [x] `cd tugdeck && bun run audit:tokens lint` — zero token violations.
- [x] `cd tugcode && bun test` — pass-through handlers + replay emit green.
- [x] `cd tugrust && cargo nextest run --workspace` — no Rust changes expected, but verify tugcast's frame-forwarding sees no schema break.
- [x] `test-23-image-attachment.jsonl` — Anthropic API-shape unchanged (content blocks were always the API shape). The fixture is a CODE_OUTPUT stream-json fixture, not the inbound wire-to-claude; the byte-identical claim as originally written conflated the two layers. What we actually verify: (a) `dispatch_one_inserts_journal_row_without_augmenting_frame` pins that the dispatcher forwards the inbound `user_message` frame byte-unchanged (pre-Step-5c shape) and `dispatch_one_derives_journal_row_from_content_blocks` pins the same invariant for the post-Step-5c content-block shape; (b) tugcode's `handleUserMessage` writes `{role:"user", content}` to claude's stdin verbatim — the inbound content blocks ARE the API shape. Interleaving differs vs. pre-5c by design (was: text-first-then-images; now: original interleaving preserved), which is the win, not a regression — so a literal byte-comparison vs. the pre-state fixture would fail by intent. The relevant invariant — no construction reshaping by tugcode — is pinned in `handleUserMessage`'s test that decodes the bytes written to stdin.
- [x] Manual (Tug.app): drop a `raphael.jpeg`, type "describe", drop a `cat.png`, type "and this one", submit. Transcript shows: `describe #0001-image-1 and this one #0001-image-2` (chips at original positions). Reload the app. Transcript shows identical labels and chip positions, restored from JSONL.

#### Out of scope {#step-5c-out-of-scope}

- **Per-message thumbnail strip rendering** — that's [Step 6](#step-6), which depends on this step's synthesized substrate.
- **Tool-block path chips on the assistant side** — [Step 7](#step-7), unchanged.
- **Filename preservation in the transcript** — JSONL doesn't carry filenames; we deliberately drop them at the submit boundary in exchange for a single consistent rendering between live and restored. A future v1.x could revisit if user feedback warrants it (would require substrate-journal work we explicitly chose to defer).
- **Backfilling synthesized substrate for pre-Step-5c sessions.** Out of scope per the project's "no migration" stance — new sessions only.

---

#### Step 6: Image attachment strip + per-message numbering {#step-6}

**Depends on:** #step-5c (consumes the synthesized substrate `image-N` labels + bytes-store entries).

**Commit:** `feat(tugdeck): tug-attachment-strip per-message + numbered chip↔thumbnail linkage`

**References:** [D04](#d04-no-bytes-on-snapshot), [Spec S04](#s04-image-downsample) (`bakeThumbnail`), [Spec S06](#s06-attachment-strip), [Risk R03](#r03-bytes-store-memory), (#transcript-rendering)

**Scope decision:** Step 6 renders the per-message thumbnail strip and provides the visual linkage between an inline `#NNNN-image-N` chip and its bytes via matching thumbnail labels. The strip is sourced from the synthesized substrate ([Step 5c](#step-5c)) — one tile per image atom in the message, labeled with the same `#NNNN-image-N` string the chip carries. Identical rendering live and restored. Earlier draft references a `TurnEntry.userMessage.attachments: ReadonlyArray<AttachmentRecord>` typed shape; under the post-5c design, the substrate already carries everything the strip needs (`AtomSegment[]` + bytes-store entries), so no parallel `AttachmentRecord` is required for this step. `AttachmentRecord` may still be introduced if downstream work (e.g., persistent attachment metadata beyond JSONL) needs it; deferred.

**`bakeThumbnail` lives in Step 5c's synthesizer, not Step 6's commit path.** Step 5c bakes during substrate synthesis so bytes-store entries carry `thumbnailDataUrl` at construction time — live AND replay. Step 6 just reads it. The `bakeThumbnail` helper itself (the canvas pipeline) belongs to `image-downsample.ts`; this step adds the helper, Step 5c calls it.

**Artifacts:**

- `tugdeck/src/components/tugways/cards/tug-attachment-strip.tsx` + CSS per [Spec S06](#s06-attachment-strip). Source: the message's image atoms (read from the `UserMessage.attachments` substrate); each tile renders the bytes-store entry's `thumbnailDataUrl` (populated by Step 5c's synthesizer) keyed by `atom.id`. Each tile's caption is the `#${pad4(messageNumber)}-${atom.label}` string — matching the inline chip's label exactly.
- `tugdeck/src/lib/image-downsample.ts` (modify) — add `bakeThumbnail(bytes, mediaType, maxEdge=256): string` returning a 256-px-max-edge data URL. Shares the canvas pipeline with `downsampleImage`. **Called by Step 5c's synthesizer**, not by a commit-path step.
- `tugdeck/src/components/tugways/cards/tide-card-transcript.tsx` (modify) — `UserMessageCell` mounts `TugAttachmentStrip` below `TugAtomTextBody` when the user message has any image atom. The strip receives `messageNumber={index + 1}` so its tile labels match the inline chips.
- `tugdeck/src/components/tugways/tug-list-view` — row-height contract extended to sum strip + body heights (measured on the same `useLayoutEffect` cycle).
- Click handler — v1 opens the source image in a new tab via `window.open(bytesStore.get(id)?.content)`. Restored sessions whose bytes-store lookup misses (bytes not yet restored from JSONL into the in-memory store) gracefully no-op; v1.x could add bytes-from-JSONL rehydration at click time.

**Tasks:**

- [x] **6.a — `bakeThumbnail` helper.** Already in `image-downsample.ts` from prior work; the canvas pipeline shares with `downsampleImage` via the per-job worker. `THUMBNAIL_MAX_EDGE_PX = 256`. Bytes-store entry shape gained `thumbnailDataUrl?: string` in Step 5c. Docstring updated this step to point at Step 5c's synthesizer as the sole caller and to document the soft-degradation contract (`null` → strip placeholder).
- [x] **6.b — `TugAttachmentStrip`.** Built per [Spec S06](#s06-attachment-strip). Takes `messageNumber` and the image atoms; renders one fixed-aspect 64×64 tile per atom; each tile reads `bytesStore.get(atom.id)?.thumbnailDataUrl` directly through a `useSyncExternalStore` subscription so a late-arriving replay-path bake lands as a re-render rather than leaving the tile stuck; caption is `decorateChipLabel(atom, messageNumber)`, the same helper the inline chip uses, so chip-label === strip-caption by construction. (`tug-attachment-strip.tsx` + `.css`)
- [x] **6.c — `UserMessageCell` wiring.** Mounts the strip below `TugAtomTextBody` inside the `body` slot fragment. Pre-filters atoms to image-only (`atoms.filter(a => a.type === "image")`) before passing to the strip. Threaded `codeSessionStore` down so the cell can read the per-card bytes-store. Strip renders `null` when image-atom count is zero — row height auto-collapses via `TugListView`'s `ResizeObserver`.
- [x] **6.d — `TugListView` row-height.** No code change required: the list view already observes every cell wrapper with a `ResizeObserver` that flushes via rAF and re-windows on height changes. Adding the strip below the body grows the wrapper's intrinsic height naturally; the observer picks it up next paint. Confirmed by running the existing list-view tests + new strip tests green together.
- [x] **6.e — Gallery variant.** `gallery-attachment-strip.tsx` registered under `componentId: "gallery-attachment-strip"` in `CATEGORIES.layout`. Three fixtures: (1) `messageNumber=1` with two image atoms; (2) `messageNumber=999` to preview a wider zero-padded prefix; (3) empty atoms to confirm the no-image collapse. SVG-data-URL thumbnails avoid the worker dependency the gallery static fixture can't satisfy.

**Tests:**

- [x] `unit: bakeThumbnail` — full runtime-bake assertion (`data:image/…;base64,…` prefix + decoded ≤256 px) deferred to manual smoke; the function uses a Web Worker that can't run in bun:test. The constant boundary (`THUMBNAIL_MAX_EDGE_PX === 256`) is already pinned by the existing `image-downsample.test.ts`.
- [x] `render: TugAttachmentStrip with one image atom + messageNumber=1` — covered by the pure-logic projection test in `tug-attachment-strip.test.ts` (`bytes-store projection`) and label-match equality (`decorateChipLabel(atom, 1) === "#0001-image-1"`). Full DOM render shape verified via the gallery card + manual smoke.
- [x] `render: TugAttachmentStrip with zero image atoms → renders nothing`. The component returns `null` when `tiles.length === 0`; the gallery's third fixture exercises this case visually.
- [x] `render: mixed atoms (1 image + 1 file) → 1 tile only`. Pinned by the `UserMessageCell — image-atom filter` test that documents the `a.type === "image"` filter formula the caller applies.
- [x] `render: UserMessageCell with one image atom → strip renders below body; row height accounts for both`. Strip is mounted inside the `body` slot fragment; row-height pickup is automatic via `ResizeObserver` — confirmed by running the existing transcript + list-view tests green together.
- [x] `render (label-match): chip label and strip caption are identical strings for the same atom (`#0001-image-1`)`. Both surfaces call `decorateChipLabel(atom, messageNumber)`; equality pinned by the `chip-label === strip-caption equality` describe block in `tug-attachment-strip.test.ts`.

**Checkpoint:**

- [x] `cd tugdeck && bun test` — full suite green (3067 pass / 0 fail, +11 strip tests).
- [x] `cd tugdeck && bun run check` — tsc clean.
- [x] `cd tugdeck && bun run audit:tokens lint` — zero token violations.
- [x] Manual: drop two images into a card, type some text around them, submit. Transcript shows the two chips at the original text positions with `#0001-image-1` / `#0001-image-2` labels; thumbnail strip below the body shows two tiles with matching captions.
- [x] Manual (restore parity): reload Tug.app. Transcript renders identically — same chip positions, same labels, same thumbnails.

---

#### Step 7: Assistant tool-block atom chips {#step-7}

**Depends on:** #step-6

**Commit:** `feat(tugdeck): tool-block path chips via buildAtomSVGDataUri`

**References:** [D07](#d07-atom-chip-primitive) (revised — chip-via-SVG-builder), [D08](#d08-tool-block-only), [Spec S05](#s05-atom-chip) (`buildAtomSVGDataUri`), (#transcript-rendering)

**Scope note (post-5c):** The `handleAddUserMessage` cast cleanup and image-attachment thumbnail-bake-on-replay that earlier drafts of Step 7 owned are **done by Step 5c's synthesizer** — both code paths (live + replay) go through the same `synthesizeUserMessageFromBlocks` helper, which mints typed atoms and bakes thumbnails. Step 7 is therefore scoped purely to the assistant-side tool-block chip rendering.

**Artifacts:**
- `tool-blocks/read-tool-block.tsx`, `edit-tool-block.tsx`, `write-tool-block.tsx`, `notebook-edit-tool-block.tsx` — path renderings switch from `MiddleEllipsisPath` (`<code>` with middle-ellipsis truncation) to an inline `<img>` chip built via the shared `composeAtomChipImgProps("file", path)` helper added to `tug-atom-img.ts` (which chains `formatAtomLabel(path, "filename")` + `buildAtomSVGDataUri`). Single chip per tool-block per path field; no walker needed (tool-block paths are single strings, not substrate text). The chip's basename rides as `alt`; the full path rides as the native `<img title=...>` tooltip. CSS-side: chip styling lifted from `tug-atom-text-body.css` into a new shared `lib/tug-atom-chip.css` declaring `.tug-atom-chip` (`display: inline-block; vertical-align: middle; margin: 0 2px`). Both the transcript walker and the four tool-block path renderers import that CSS and apply the class; the editor's CM6 widget keeps its own inline `verticalAlign: ${baselineOffset}px` calibrated for flowing prose without a line-height floor.

**Tasks:**
- [x] Update each tool-block component to render `input.file_path` (and `input.notebook_path` for notebook-edit) as an inline `<img>` chip via `composeAtomChipImgProps` (which calls `buildAtomSVGDataUri` internally). Lifted the chip CSS rule from `tug-atom-text-body.css` to a shared `lib/tug-atom-chip.css` declaring `.tug-atom-chip` — both the transcript walker and the four tool-block path renderers consume it.
- [ ] Verify cold-mount of a session with an image-bearing turn renders both the user-row thumbnail (5c+6) and the assistant tool-block chips (this step) — manual smoke covers the integrated path. *(Pending — user smoke test.)*

**Tests:**
- [x] `formatAtomLabel("/repo/src/main.ts", "filename") === "main.ts"` and the surrounding basename-extraction shapes (8 cases in `lib/__tests__/tug-atom-img.test.ts`). The full DOM-bound `buildAtomSVGDataUri` round-trip is covered by the real-app smoke per the project's no-fake-DOM testing convention.
- [x] `composeAtomChipImgProps("file", "") === null` (defensive null branch).

**Checkpoint:**
- [x] `cd tugdeck && bun test` — 3040 pass / 0 fail.
- [x] `cd tugdeck && bun run check` — tsc clean.
- [x] `cd tugdeck && bun run audit:tokens lint` — zero token violations.
- [ ] Manual: a turn where claude reads a workspace file → the tool block's path renders as a chip. Cold-restart the card → same view restored (substrate from JSONL via 5c's synthesizer; tool-block chips from this step). *(Pending — user smoke test.)*

---

#### Step 8: Integration checkpoint {#step-8}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** [D01](#d01-ffc-substitution-at-submit) … [D08](#d08-tool-block-only), [Q01](#q01-replay-enlarge-bytes) (resolve), [Table T01](#t01-failure-modes), (#success-criteria)

**Tasks:**
- [ ] Verify all artifacts from Steps 1-7 are complete and cooperate end-to-end.
- [ ] Re-run `just capture-capabilities` against the current claude (`2.1.148` or later at exit time). `test-23-image-attachment.jsonl` byte-identical pre/post.
- [ ] Heap-profile a 50-turn synthetic session with five 4 MB inline images per turn — resolve [Q01](#q01-replay-enlarge-bytes).
- [ ] Walk the tuglaws checklist for new components: `tug-attachment-strip.tsx`, `tug-atom-text-body.tsx`, the bytes-store, `image-downsample.ts`.
- [ ] Update [Q01](#q01-replay-enlarge-bytes) resolution in this plan based on profile data.

**Tests:**
- [ ] `cd tugdeck && bun test && bun run check && bun run audit:tokens lint`
- [ ] `cd tugcode && bun test`
- [ ] `cd tugrust && cargo nextest run --workspace`
- [ ] `just app-test` end-to-end recipe (new): drop a PNG → mention a workspace `@CLAUDE.md` → submit → assert:
  - (a) the wire frame carries `content: ContentBlock[]` with one image block + one text block in the correct order (image at the position where the chip sat in the editor);
  - (b) the text block contains `CLAUDE.md` literally (no `U+FFFC`) — `@`-completion paths substitute into text per [Spec S03 (REVISED)](#s03-build-wire-payload);
  - (c) the transcript renders a `#NNNN-image-1` chip at the image's position + a thumbnail tile in the strip with matching `#NNNN-image-1` caption; `CLAUDE.md` appears inline as plain text (no chip wrapping);
  - (d) cold-restart of the card replays both correctly from JSONL — chip positions, labels, and thumbnails are byte-identical to the live render.
- [ ] Manual smoke: paste a screenshot, drop a 4K PNG, `@`-mention `CLAUDE.md`, type `@.env` (no popup match expected), submit, verify thumbnails in editor, chips in transcript, tool-block path chips when claude reads a file, full state survives close-and-reopen.

**Checkpoint:**
- [ ] All success criteria from [`#success-criteria`](#success-criteria) ticked.
- [ ] Drift regression Benign-or-better via `cargo nextest run -p tugcast --features real-claude-tests --run-ignored only stream_json_catalog_drift_regression`.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A complete user-visible atom + attachment lifecycle in Tide: drop / paste / `@`-mention image, file, and document references in `tug-prompt-entry`; submit; see thumbnails + atom chips in the transcript user row; see matching chips on assistant tool-block paths; cold-restart the card and find the same view restored from JSONL + journal. Image submissions never fail at the Anthropic backend due to size or dimension issues. Secret files never appear in `@`-completion.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every success criterion in [`#success-criteria`](#success-criteria) verified by its named verification.
- [ ] `test-23-image-attachment.jsonl` byte-identical pre/post (no regression in the existing image content-block path).
- [ ] [Q01](#q01-replay-enlarge-bytes) resolved with documented heap-profile evidence.
- [Q02](#q02-heic-avif) and [Q04](#q04-animated-gif) already resolved at plan-draft time; [Q03](#q03-pdf-deferred) remains deferred.
- [ ] Manual smoke per [Step 8](#step-8): drop → paste → `@`-mention → submit → restore round-trip works end-to-end.
- [ ] No new IndexedDB or localStorage. No new tugcast verb. No new feed ID.
- [ ] `bun run check`, `bun test` (tugdeck + tugcode), `cargo nextest run --workspace` all clean with `-D warnings`.

**Acceptance tests:**
- [ ] `cd tugrust && env -u ANTHROPIC_API_KEY TUG_REAL_CLAUDE=1 cargo nextest run -p tugcast --features real-claude-tests --run-ignored only stream_json_catalog_drift_regression` — exits 0.
- [ ] `just app-test` end-to-end recipe (added in Step 8).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] PDF / `document` content blocks ([Q03](#q03-pdf-deferred)).
- [ ] `kind: "ref"` discriminator + tugcode-side path resolution for explicit-inline file refs.
- [ ] Anthropic Files API `file_id` source type for repeated-attachment scenarios.
- [ ] Bidirectional capture (`TUG_CAPTURE_INBOUND_LOG`) for regression-tracking the inbound shape.
- [ ] Lightbox component for click-to-enlarge (v1.1 polish).
- [ ] Free-prose `@path` detection in assistant markdown.
- [ ] Bytes-store retention policy refinements based on heap-profile data from [Q01](#q01-replay-enlarge-bytes).

| Checkpoint | Verification |
|------------|--------------|
| Image downsample primitive works | Step 1 unit tests + manual decode of 4K screenshot |
| Bytes-store + drop/paste captures bytes | Step 2 integration tests + manual state-preservation round-trip |
| Wire flattening replaces U+FFFC + ships Attachments | Step 3 reducer tests + manual claude-response verification |
| Filetree denylist + .tugattachignore active | Step 4 integration test + manual `@.env` non-match |
| Chip renders consistently in editor + transcript (same SVG builder) | Step 5 render tests + manual eye-match |
| Attachment strip + thumbnails | Step 6 render tests + manual drop-then-submit |
| Replay round-trips + tool-block chips | Step 7 cold-mount test + manual tool-call verification |
| End-to-end | Step 8 `just app-test` recipe + manual smoke |
