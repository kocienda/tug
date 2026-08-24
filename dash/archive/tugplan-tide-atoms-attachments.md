<!-- tugplan-skeleton v2 -->

## Tide Atoms → Attachments — End-to-End Plan {#tide-atoms-attachments}

**Purpose:** Wire the existing `tug-prompt-entry` atom flow through the full Tide pipeline so file/image/document references reach Claude Code as proper Anthropic content blocks, persist through replay, and render in the transcript. Closes the gap captured in [`atoms-attachments.md`](./atoms-attachments.md): atoms exist in the editor and `Attachment` exists at the tugcode wire, but the reducer ships `attachments: []` and the transcript renders user rows as plain text.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-05-08 |
| Roadmap anchor | [`atoms-attachments.md`](./atoms-attachments.md) (background prose) |
| Predecessor | [`tugplan-tide-card-polish.md`](./tugplan-tide-card-polish.md) (T3.4.d) |
| Related | [`transport-exploration.md`](./transport-exploration.md) §Test 23, §Test 24 · [`ws-verification.md`](./ws-verification.md) · [`session-metadata-feed.md`](./session-metadata-feed.md) |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The browser side already represents file and image references as **atoms** (`AtomSegment { kind, type, label, value }`) inside a CM6 StateField. The tugcode IPC already carries an `Attachment[]` array on `user_message` and tugcode's `buildContentBlocks` already converts that into the `image`/`text` content blocks Claude Code expects on stdin. `test-23-image-attachment` proves the image happy-path round-trips end-to-end against every captured claude version since `v2.1.104`. The `turns` journal in `tugcast::SessionLedger` already declares `user_attachments BLOB NOT NULL`. The replay translator already decodes `image` blocks from JSONL into `Attachment[]`.

What's missing is the glue: `code-session-store/reducer.ts` ships `attachments: []` on every `send-frame` effect, so atoms never reach the wire; `tide-card-transcript.tsx`'s user row is a single `<span>{text}</span>`, so attachments would have nowhere to render even if they arrived; `replay.ts` has no `document` branch; and there's no resolver for `@`-path atoms (which `test-24-at-file-references` proved are *not* expanded by Claude Code in stream-json mode — that's a terminal-only feature).

We close all of this with a single attachment lifecycle that runs from atom-insert through replay-render, riding the existing capture-capabilities harness for empirical regression tracking.

#### Strategy {#strategy}

- **Empirical-first.** New probes and bidirectional capture infrastructure land *before* we change any wire shape, so each subsequent step has a regression baseline to measure itself against. The probes drive the design, not the other way around.
- **Backwards-compatible wire evolution.** The cross-process `Attachment` shape today is `{ filename, content, media_type }`. We extend it into a discriminated union (`kind: "inline" | "ref"`) defaulting to `"inline"` so existing fixtures and tests keep parsing.
- **Resolver in tugcode, not tugdeck.** Workspace path resolution lives where the workspace actually is — tugcode's `cwd` matches what the supervisor canonicalized. Path-containment + size caps + MIME sniffing all run server-side before `buildContentBlocks`.
- **One commit per step.** Build stays green at every commit (`-D warnings`). Probe-table changes that intentionally fail (because they pin behavior we haven't built yet) are bracketed by classification rules in the README and only land alongside the implementation that satisfies them.
- **No new transport.** The WebSocket / supervisor / CODE_INPUT / CODE_OUTPUT path is verified ready (`ws-verification.md` T8-T11 fixed in commit `e0174373`). The `code_watch_tx` snapshot pattern covers in-flight attachment replay; no parallel feed.
- **Tuglaws apply.** Touching `tide-card-transcript.tsx`, the new attachment-strip primitive, the bytes side-table store, and the prompt-entry/clipboard handlers re-checks against [tuglaws.md](../tuglaws/tuglaws.md). The closing step records a walkthrough.

#### Success Criteria (Measurable) {#success-criteria}

**Wire transport:**
- `Attachment` is a discriminated union `{ kind: "inline" | "ref", … }` in `tugdeck/src/protocol.ts` and `tugcode/src/types.ts`. Old `{ filename, content, media_type }` shapes parse with `kind: "inline"` defaulted. (verification: `tugcode/src/__tests__/types.test.ts` round-trip)
- The reducer's `send-frame` effect at `reducer.ts:283` and the queued-send flush at `reducer.ts:892` carry the resolver's output, not `attachments: []`. (verification: `code-session-store/__tests__/reducer.test.ts` asserts shape on submit)

**Empirical regression coverage:**
- The probe table at `tugrust/crates/tugcast/tests/common/probes.rs` contains probes 36-42 plus the bidirectional inbound-log primitive. (verification: `cargo nextest run -p tugcast common::probes::tests`)
- `just capture-capabilities` produces both `<probe>.jsonl` (outbound) and `<probe>.inbound.jsonl` (inbound) fixtures for every attachment-bearing probe. (verification: `ls stream-json-catalog/v<version>/test-23-image-attachment.inbound.jsonl`)
- `stream_json_catalog_drift_regression` watches both fixture files. (verification: deliberate inbound-shape change is caught by drift run)

**Server-side resolution:**
- A `kind: "ref"` attachment with a workspace-relative path is read from disk by tugcode, MIME-sniffed, and emitted as the right content block. (verification: `test-40-ref-resolution`)
- A ref pointing outside the supervisor `cwd` (post-`realpath`) is refused with an `error` event, not a silent drop. (verification: unit test in `tugcode/src/__tests__/`)
- A ref over the per-attachment 5 MB ceiling, or a submission whose summed payload exceeds the 28 MB cap, fails closed with a clean `error` event. (verification: unit test + `test-41-image-too-large`)

**Atom → attachment translation:**
- Every atom variant in [List L01](#l01-atom-attachment-mapping) has a deterministic Attachment output. (verification: `tugdeck/src/__tests__/atom-attachment-resolver.test.ts` covers the cross-product)
- Drop and paste of an image insert an atom *and* stash bytes in the per-card side-table; submit reads from the side-table without an async hop. (verification: integration test + manual)
- The CASE-A interrupt path preserves both atoms and bytes onto `pendingDraftRestore`; re-edit-after-cancel restores the chips with thumbnails. (verification: probe + manual)

**Replay round-trip:**
- `replay.ts` decodes `document` content blocks into `Attachment` records (matching the existing `image` branch). (verification: replay test fixture)
- A cold-mount of a card with attachment-bearing turns in JSONL renders the same chips as the live submit produced. (verification: `code-session-store.replay.test.ts` extension)

**Transcript rendering:**
- A new `tug-attachment-strip.tsx` component renders inside `UserRowCell` above the body when `attachments.length > 0`. Image tiles, doc chips, text chips. (verification: gallery card + manual)
- The `TugListView` row-height accounting includes the strip. (verification: layout test in `tide-card-transcript.test.tsx`)

**Compliance:**
- `bun run check`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run -p tugcast`, `cargo nextest run --workspace` — all pass on every step.
- No new IndexedDB. No localStorage.
- Capture-capabilities drift regression stays Benign-or-better through every step.

#### Scope {#scope}

**In scope:**

1. Probe-table extensions + bidirectional-capture primitive (Steps 1-3).
2. Wire-shape evolution: `Attachment` discriminated union (Step 4).
3. Browser bytes side-table + paste/drop atom-with-bytes plumbing (Step 5).
4. Atom → Attachment resolver in `code-session-store` (Step 6).
5. `TurnEntry.attachments` typed as `AttachmentRecord[]` with thumbnails (Step 7).
6. tugcode `resolveAttachment` + `buildContentBlocks` extensions for `document` and `text` (Step 8).
7. Ref-resolution probe + negative-path probes (Step 9).
8. JSONL replay decoding for `document` (Step 10).
9. `tug-attachment-strip.tsx` + transcript-row evolution (Step 11).
10. Editor atom thumbnails for image atoms (Step 12).
11. Integration checkpoint — end-to-end app-test (Step 13).

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Anthropic Files API uploads** (`source.type: "file", file_id: "…"`). Forward-compatible via a future `kind: "file_id"` arm; not built here. ([Q05](#q05-files-api-uploads))
- **Image downsampling at submit time.** Tracked separately; we observe Anthropic's tokenization behavior empirically before deciding to add `sharp` or a canvas downscaler. ([Q02](#q02-image-downsampling))
- **`.tugattachignore`-style permission gating.** First-pass uses the same permission model as Claude Code (which would happily `Read` the file). Revisited as ([Q05](#q05-permission-model)).
- **Cross-card copy-paste of bytes.** The clipboard sidecar HTML envelope round-trips atom *identities*; bytes for cross-card attachment paste is a future feature. ([Q06](#q06-cross-card-paste))
- **Tugcast verb for `FILETREE_READ`.** Resolver lives in tugcode; no new tugcast verb needed. ([D01](#d01-resolve-in-tugcode))

#### Dependencies / Prerequisites {#dependencies}

- WebSocket / supervisor transport ready (`ws-verification.md`, commit `e0174373`).
- `tugcast::SessionLedger.turns.user_attachments BLOB` column exists (`session_ledger.rs:291`, declared but unused by today's empty-attachments path).
- `capture-capabilities` harness functioning against the local `claude` binary.
- Probe table at `tugrust/crates/tugcast/tests/common/probes.rs` is the authoritative input-script source for the catalog.

#### Constraints {#constraints}

- **Per-image:** ≤ 5 MB decoded; media types `image/png`, `image/jpeg`, `image/gif`, `image/webp` only. (Source: `tugcode/src/session.ts:49` constants, [Vision docs](https://platform.claude.com/docs/en/build-with-claude/vision).)
- **Per-PDF:** ≤ 600 pages, ≤ 32 MB; `application/pdf` only.
- **Per-request total payload:** 32 MB API ceiling; **we cap at 28 MB** to leave headroom for the text body, system prompt, and tool definitions.
- **Stdin to claude:** 10 MB cap (Claude Code v2.1.128). Our 28 MB cap above is the binding constraint; this is a backstop.
- **Image dimensions:** 8000×8000 px max (2000×2000 above 20 images per request); Opus 4.7 long-edge max 2576 px. We don't downsample yet ([Q02](#q02-image-downsampling)).
- **Build:** `-D warnings` in `tugrust/.cargo/config.toml`; no new warnings tolerated.
- **No new IndexedDB / localStorage** per [D-T3-10](./tide.md#decisions-t3).

#### Assumptions {#assumptions}

- Claude continues to accept the existing `image` content-block shape (`source: { type: "base64", media_type, data }`). The drift regression catches breakage.
- The supervisor's canonicalized `cwd` (visible in every `system_metadata` fixture as `"cwd":"…"`) matches what tugcode's `Bun.file()` resolves against. Verified in catalog fixtures.
- `application/pdf` document blocks reach claude on stdin and survive into JSONL as either `document` blocks or extracted text. ([Q04](#q04-pdf-jsonl-roundtrip)) — this assumption is validated by Step 2's empirical probe before Step 8 commits to a replay shape.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows [`tuglaws/tugplan-skeleton.md`](../tuglaws/tugplan-skeleton.md) v2:

- Decisions: `[D01]` … `[D10]` with `{#dNN-...}` anchors.
- Open Questions: `[Q01]` … `[Q06]` with `{#qNN-...}` anchors.
- Specs: `Spec S01` … `Spec S05` with `{#sNN-...}` anchors.
- Tables: `Table T01` … with `{#tNN-...}` anchors.
- Lists: `List L01` … with `{#lNN-...}` anchors.
- Risks: `Risk R01` … with `{#rNN-...}` anchors.
- Steps: `{#step-N}` anchors. Every step has `**Depends on:**` and `**References:**` lines.
- IDs are two-digit, never reused; deletions leave gaps.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Inline `text/*` ref content vs. let claude `Read()` it (OPEN) {#q01-inline-text-refs}

**Question:** When a user `@`-mentions a workspace `.md` or `.ts` file, should tugcode inline its contents as a `text` content block, or pass the path through and let claude's `Read` tool fetch it on demand?

**Why it matters:** Inlining is what users expect from "@-attaching" and matches Claude Code's terminal behavior. But it spends tokens unconditionally; refs claude doesn't need cost the user money.

**Options:**
- (a) Always inline `text/*` refs into a `text` block.
- (b) Always leave as path text, let `Read` fetch on demand.
- (c) Inline below a size threshold (say 4 KB), let `Read` handle larger files.

**Plan to resolve:** Add a research probe that submits the same task with both shapes and compares `cost_update.usage.input_tokens`. Decide on Step 8.

**Resolution:** OPEN. Provisional choice: (a), per [`atoms-attachments.md` §"Open questions"](./atoms-attachments.md#open-questions). Revisit on probe data.

#### [Q02] Image downsampling at submit time (OPEN) {#q02-image-downsampling}

**Question:** Does Claude downsample large images server-side, or do we need to downscale at tugcode resolve time?

**Why it matters:** Opus 4.7 maxes at 2576 px on the long edge. Sending a 4096×4096 PNG either gets downsampled by the API (free) or counts against the 32 MB request cap (expensive).

**Plan to resolve:** Research probe — send a 4096×4096 PNG, observe `cost_update.usage.input_tokens`, compare to a 1568×1568 baseline. Decide whether to add `sharp` or a canvas downscaler.

**Resolution:** OPEN. Out of scope for this plan; tracked as a follow-on after Step 13.

#### [Q03] `source.type: "url"` pass-through for `link` atoms (OPEN) {#q03-url-source-type}

**Question:** Does the API accept `{ "type": "image", "source": { "type": "url", "url": "https://…" } }` for public image URLs, and if so, can we map `link` atoms onto that path without inlining bytes?

**Plan to resolve:** Research probe `test-43-image-url-source` (added as part of Step 9's optional research bracket). Public PNG URL; observe whether claude fetches it.

**Resolution:** OPEN. If yes, link atoms get a free pass-through; if no, we either base64-fetch in tugcode or surface the URL as plain text.

#### [Q04] PDF round-trip in JSONL (OPEN) {#q04-pdf-jsonl-roundtrip}

**Question:** When tugcode sends a `document` content block, what does claude write to JSONL — the `document` block verbatim, only the extracted text, or both?

**Why it matters:** The replay translator's new `document` branch (Step 10) needs to know the on-disk shape.

**Plan to resolve:** Run `test-37-pdf-attachment` against a real claude in Step 2; inspect the captured JSONL fixture. Decide on Step 10.

**Resolution:** OPEN — answered empirically by Step 2.

#### [Q05] Permission model for sensitive ref'd files (OPEN) {#q05-permission-model}

**Question:** A ref atom resolves *as the supervisor's user*. If a workspace contains `.env` and the user `@`-mentions it, we'll ship its contents to claude. Same model as Claude Code's `Read` tool, but more direct.

**Options:**
- (a) Match Claude Code's permission model (allow; rely on user discretion).
- (b) Surface a one-time confirmation per session before the first ref-with-secret-extension submit.
- (c) Honor a workspace-level `.tugattachignore` mirroring `.gitignore`.

**Plan to resolve:** Decide on Step 8 (resolver lands). Provisional: (a) for v1.

**Resolution:** OPEN. Documented as a non-goal for this plan (see [Non-goals](#non-goals)).

#### [Q06] Cross-card paste with bytes (OPEN) {#q06-cross-card-paste}

**Question:** The clipboard sidecar HTML envelope (`clipboard-filters.ts`) round-trips atom *identities* but not bytes. Should cross-card paste of an image atom carry its bytes too, or be invalidated until re-attached?

**Plan to resolve:** Defer; revisit when we have a concrete cross-card-paste use case.

**Resolution:** DEFERRED. Out of scope.

#### [Q07] Files API `file_id` uploads (DEFERRED) {#q07-files-api-uploads}

**Question:** For repeated-attachment scenarios (the same logo across N turns), the Anthropic Files API + `file_id` source avoids re-base64'ing on every turn.

**Resolution:** DEFERRED. The `Attachment` union from [D02](#d02-attachment-discriminated-union) is forward-compatible — add a third arm `kind: "file_id"` when this lands. Tracked as a follow-on.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Anthropic API drift on content blocks | high | low | Bidirectional capture from [D05](#d05-bidirectional-capture); drift regression catches version-over-version changes | Drift regression flags Semantic finding |
| Total payload > 32 MB request cap | medium | medium | 28 MB submission cap + per-attachment 5 MB image / 32 MB doc ceilings; resolver fails closed before claude is reached | User report or `test-41-image-too-large` regression |
| Workspace path escape via symlinks | high | low | Post-`realpath` prefix check against canonicalized `cwd`; ref resolver is the single chokepoint | Audit on resolver landing |
| Memory bloat from full-byte attachments on the snapshot | medium | medium | `AttachmentRecord` carries thumbnails (256 px max edge) only; full bytes live in journal/JSONL | 100-turn session memory profile |
| Probes 37/40 fail before Step 8 lands | low | high | README's `Failed`-status taxonomy permits during a feature bracket; probes pass automatically once Step 8 commits | Drift regression refuses to advance baseline |

**Risk R01: Anthropic content-block drift {#r01-anthropic-drift}**
- **Risk:** Anthropic ships a new content-block shape or deprecates one we depend on; Claude Code's stdin contract drifts; drift goes unnoticed because the catalog only watches outbound.
- **Mitigation:** Step 3 lands bidirectional capture so the catalog watches *both* directions. The drift regression's classification (Benign / Semantic / Ambiguous) refuses to advance the baseline silently.
- **Residual risk:** A drift between a `capture-capabilities` run and a user's live request still happens; the drift regression is opt-in, not real-time.

**Risk R02: Payload cap exhaustion {#r02-payload-cap}**
- **Risk:** A user attaches multiple PDFs and the submission exceeds 32 MB; claude returns a generic error; user can't tell whether to retry, downsize, or drop one.
- **Mitigation:** Resolver tracks running payload size and fails the submit at 28 MB with a specific error event naming the offending file.
- **Residual risk:** Cumulative ref'd `text/*` refs that compress poorly to plain text could still surprise the cap; same surfacing path covers it.

**Risk R03: Workspace path escape {#r03-path-escape}**
- **Risk:** A crafted `path` field in a `kind: "ref"` attachment escapes the workspace via `..`, an absolute path, or a symlink to outside-cwd target; tugcode reads `~/.ssh/id_rsa` or similar.
- **Mitigation:** Post-`realpath` prefix check against the canonicalized `cwd`. Single chokepoint in `resolveAttachment`. Symlink resolution before comparison.
- **Residual risk:** A symlink whose target was created *after* startup could be inserted into the workspace by a separate process; `realpath`-at-submit-time still catches this.

**Risk R04: Snapshot memory bloat {#r04-snapshot-memory}**
- **Risk:** Long sessions accumulate large `AttachmentRecord` objects on every `TurnEntry`; React state size grows unbounded.
- **Mitigation:** [D04](#d04-no-bytes-on-snapshot) — only thumbnails (256 px max edge) and metadata live on the snapshot. Full bytes live exclusively in the tugcast journal and JSONL.
- **Residual risk:** Thumbnails for 1000 turns × 200 KB ≈ 200 MB. Acceptable for a single-day session, monitored via Tug.app heap diagnostics.

---

### Design Decisions {#design-decisions}

#### [D01] Resolve `@`-path refs in tugcode, not tugdeck (DECIDED) {#d01-resolve-in-tugcode}

**Decision:** Workspace path resolution for `kind: "ref"` attachments runs in tugcode at submit time, not in tugdeck before submit.

**Rationale:**
- `test-24-at-file-references` proved the terminal's `@`-completion file-injection is a terminal-only feature. The graphical UI is on the hook; the question is just where.
- tugcode already runs with the supervisor-canonicalized `cwd` and has direct file access via `Bun.file()`.
- A tugdeck-side resolver would require a new `FILETREE_READ` tugcast verb, payload-size flow control over the WebSocket, and a tugcast-side sandbox — all to ship bytes that already exist on the same filesystem as tugcode.
- The browser path is preserved for the `kind: "inline"` arm (paste/drop), where the browser genuinely is the only one with the bytes.

**Implications:**
- New `resolveAttachment(att, cwd)` in `tugcode/src/session.ts` ahead of `buildContentBlocks`.
- Path-containment + size cap + MIME-sniff are tugcode's responsibility.
- The browser only ever ships either raw bytes (`kind: "inline"`) or a workspace-relative path string (`kind: "ref"`).

#### [D02] `Attachment` is a discriminated union (DECIDED) {#d02-attachment-discriminated-union}

**Decision:** Both `tugdeck/src/protocol.ts` and `tugcode/src/types.ts` carry `Attachment` as `{ kind: "inline", … } | { kind: "ref", … }`. Old shape `{ filename, content, media_type }` parses with `kind` defaulted to `"inline"`.

**Rationale:**
- One shape carries both "bytes the browser already has" and "path tugcode must read."
- Backwards compatible: existing `test-23-image-attachment` fixtures continue to parse.
- Forward compatible: a future `kind: "file_id"` arm (Files API) slots in without re-opening the union.

**Implications:**
- The browser side decides which arm at atom-submit time based on atom type and whether the side-table holds bytes.
- `buildContentBlocks` is rewritten to take `InlineAttachment` (the post-resolve shape); `resolveAttachment` does the `ref → inline` conversion.

#### [D03] Inline image bytes via per-card side-table (DECIDED) {#d03-bytes-side-table}

**Decision:** A per-card `atom-bytes-store` (a tiny in-memory map keyed by atom-id) holds base64'd bytes for inline attachments between insert and submit. The atom's `value` field continues to carry a user-visible reference (filename, data-URL, or path); bytes are stored separately and looked up at submit time.

**Rationale:**
- Atoms are JSON-serializable today (round-trip through state preservation). Stuffing 5 MB of base64 into `AtomSegment.value` would balloon every preserved snapshot.
- A dedicated store with explicit lifetimes (mount → unmount + state-preservation snapshot) keeps the atom representation lightweight.
- The store is JSON-serializable too (just base64 strings), so it rides existing state-preservation machinery without a new persistence path.

**Implications:**
- `AtomSegment` gains an optional `id: string` field minted at insert time.
- `useCardStatePreservation`'s save/restore pair includes the bytes-store snapshot.
- CASE-A interrupt restore (`pendingDraftRestore`) carries bytes via the same store, so re-edit-after-cancel keeps thumbnails.

#### [D04] No raw bytes on the React snapshot (DECIDED) {#d04-no-bytes-on-snapshot}

**Decision:** `TurnEntry.userMessage.attachments: ReadonlyArray<AttachmentRecord>` carries thumbnails (256 px max edge for images) and metadata only. Full bytes live in tugcast's `turns.user_attachments` BLOB and in JSONL.

**Rationale:**
- 100 turns × 5 MB attachments = 500 MB on the React snapshot. Unacceptable.
- Tugcast's journal already declares the `user_attachments BLOB` column and serializes via `serde_json::Value`.
- For the in-flight pre-commit window, the bytes-store from [D03](#d03-bytes-side-table) is the source. Once the turn commits, the full bytes are drained out of memory and the journal/JSONL is the source of truth.

**Implications:**
- `AttachmentRecord` is not `Attachment`; it's a display-shape with `thumbnailDataUrl: string | null`, `byteSize: number | null`, `refPath: string | null`, `expanded: boolean`.
- The reducer commit at `reducer.ts:820` runs the thumbnail bake.
- A "show full image" lightbox sources from the journal (or, if still mounted, the bytes-store).

#### [D05] Bidirectional capture in the catalog harness (DECIDED) {#d05-bidirectional-capture}

**Decision:** `tugcode/src/session.ts:2791` mirrors the stream-json envelope to `$TUG_CAPTURE_INBOUND_LOG` when set. The capture binary (`capture_stream_json_catalog.rs`) writes a per-probe `<probe>.inbound.jsonl` next to the existing outbound fixture. The drift regression diffs both files.

**Rationale:**
- The catalog today watches what claude *emits*. A typo in `buildContentBlocks` (e.g., `"type": "Image"` instead of `"type": "image"`) is silent until claude returns an error.
- Pinning the inbound shape catches `buildContentBlocks` regressions on every capture run.
- Same normalization vocabulary (`{{uuid}}`, `{{cwd}}`, `{{text:len=N}}`) applies — they were designed for stream-json shapes regardless of direction.

**Implications:**
- `ProbeRecord` doesn't change; the inbound log is per-probe automatic via env var.
- `stream_json_catalog_drift.rs` learns to glob `*.inbound.jsonl` alongside `*.jsonl`.
- README at `stream-json-catalog/README.md` gets a §"Bidirectional capture" subsection.

#### [D06] Probes precede implementation (DECIDED) {#d06-probes-first}

**Decision:** Steps 1-3 (probe-driver primitives, empirical probes against today's wire shape, bidirectional capture) all land *before* Step 4 (wire-shape evolution). Probes 40-42 land in Step 9 once the resolver and union exist.

**Rationale:**
- We get baselines for media-type breadth (JPEG, PDF, multi-attachment) against today's `Attachment` shape, locking in pre-change behavior.
- The drift regression inherits the new probes and watches them across versions automatically.
- [Q04](#q04-pdf-jsonl-roundtrip) is answered empirically before Step 10's replay extension commits to a shape.

**Implications:**
- Steps 1-3 are pure additive — no production-code shape change. Each is a one-commit unit.
- Step 9 lands probes 40-42 at the same time as the resolver they exercise; no `Failed`-bracket window.

#### [D07] Content-block branching by media_type (DECIDED) {#d07-content-block-branching}

**Decision:** `buildContentBlocks` post-resolve switches on `media_type`:

- `image/*` (allowlist: png, jpeg, gif, webp) → `image` block, `source.type: "base64"`.
- `application/pdf` → `document` block, `source.type: "base64"`, `media_type: "application/pdf"`.
- `text/*` and known code MIMEs (`application/json`, `application/javascript`, `application/typescript`, …) → `text` block, content as the literal string.
- Anything else → reject with a clean error event.

**Rationale:**
- `text` blocks are the catch-all for plain-text documents per Anthropic's [Files docs](https://platform.claude.com/docs/en/build-with-claude/files); concatenating multiple `text` blocks in one user message is supported and avoids the `document` overhead.
- The image branch already works (`test-23-image-attachment` baseline).
- `document` is the right shape for PDFs per [PDF support docs](https://platform.claude.com/docs/en/build-with-claude/pdf-support).

**Implications:**
- The `role: AttachmentRole` field on `Attachment` is advisory; tugcode honors `media_type` for actual block selection.
- A `text/x-not-real` MIME falls into the unknown-bucket and is rejected; we maintain an explicit allowlist of code MIMEs.

#### [D08] Workspace containment + payload caps (DECIDED) {#d08-containment-and-caps}

**Decision:**
- Refs resolve against `path.realpath(cwd)`; `realpath(absoluteRef)` must start with `realpath(cwd) + path.sep`. Otherwise reject.
- Per-image cap: 5 MB decoded (existing).
- Per-document cap: 32 MB decoded.
- Per-submission total cap: 28 MB (leaves 4 MB headroom against the 32 MB API ceiling).
- Per-text-attachment cap: 1 MB encoded (UTF-8 length). Exceeds → reject.

**Rationale:**
- Per [Vision docs](https://platform.claude.com/docs/en/build-with-claude/vision), the API request ceiling is 32 MB. A submission has to fit text + tools + attachments.
- A 28 MB submission cap with a 4 MB headroom leaves room for a long text body and tool definitions without bumping the API ceiling.
- 1 MB text-attachment cap prevents `@`-attaching a large `package-lock.json` from blowing the budget.

**Implications:**
- `resolveAttachment` runs a payload tally; the first attachment that crosses 28 MB fails the entire submission with a specific error.
- The error event includes `filename` and `byteSize` so the user can pare the list.

#### [D09] Three-tier persistence (DECIDED) {#d09-three-tier-persistence}

**Decision:** Attachment data lives in three tiers per [Table T04](#t04-persistence-tiers):

1. **In-memory React snapshot** — `AttachmentRecord` (thumbnails + metadata; no full bytes).
2. **Component state preservation** — bytes-store snapshot (full bytes for the in-flight pre-submit window only).
3. **Tugcast `turns` journal** — full inline bytes serialized as JSON BLOB; `kind: "ref"` rows store the path string.
4. **JSONL** — what claude itself wrote: image content blocks for inline; `Read`-tool inputs for refs claude expanded.

**Rationale:** Each tier has the smallest data shape that satisfies its lifetime. JSONL is the historical truth (forever, until user `forget`s); the journal is the resume-time truth (until claude acks the turn); the snapshot is the render-time truth (mount → unmount); state preservation covers HMR/pane-restore.

**Implications:**
- Replay reads journal *and* JSONL — journal covers refs claude didn't expand; JSONL covers everything claude wrote.
- Cold-mount of a card with attachment-bearing turns reconstructs the same chips the live submit produced.

#### [D10] Snapshot-feed delivery is unchanged (DECIDED) {#d10-snapshot-feed-unchanged}

**Decision:** In-flight attachment delivery to a late-mounting card uses the existing `code_watch_tx` snapshot pattern; we do not introduce a new feed.

**Rationale:**
- `ws-verification.md` confirms the snapshot delivery is reliable post-`e0174373`.
- `pendingUserMessage` already rides the snapshot; adding `attachments` to its payload is additive.
- A new feed would duplicate the snapshot machinery and add another race surface to verify.

**Implications:**
- `CodeSessionSnapshot.pendingUserMessage` typed as `{ text, atoms, attachments, submitAt }` after Step 7.
- No new tugcast feed ID.

---

### Specification {#specification}

#### Spec S01: `Attachment` wire type {#s01-attachment-wire-type}

```ts
type AttachmentRole = "auto" | "image" | "document" | "text";

type Attachment =
  | {
      kind: "inline";
      role: AttachmentRole;
      filename: string;
      media_type: string;          // RFC 6838
      content: string;             // base64 for binary, raw text for text/*
    }
  | {
      kind: "ref";
      role: AttachmentRole;
      filename: string;
      path: string;                // workspace-relative; resolved against tugcode cwd
      media_type?: string;         // optional pre-classification; tugcode may override
    };
```

Compatibility: `kind` defaults to `"inline"` when absent. `role` defaults to `"auto"`.

#### Spec S02: `AttachmentRecord` snapshot type {#s02-attachment-record}

```ts
type AttachmentRecord = {
  role: AttachmentRole;
  filename: string;
  media_type: string;
  thumbnailDataUrl: string | null; // ≤ 256 px max edge for images; null for non-images
  byteSize: number | null;
  refPath: string | null;          // null when inline-only
  expanded: boolean;               // claude wrote it back into JSONL (image) or expanded via Read (ref)
};
```

Lives on `TurnEntry.userMessage.attachments` (typed) and on `CodeSessionSnapshot.pendingUserMessage.attachments` (in-flight).

#### Spec S03: Atom-bytes side-table {#s03-atom-bytes-store}

`tugdeck/src/lib/atom-bytes-store.ts`:

```ts
interface AtomBytesStore {
  /** Stash bytes for an atom, keyed by its id. Idempotent. */
  put(atomId: string, content: string, mediaType: string): void;
  /** Look up bytes by atom id. Returns null if unknown. */
  get(atomId: string): { content: string; mediaType: string } | null;
  /** Remove bytes by atom id. Used when the atom is deleted. */
  delete(atomId: string): void;
  /** JSON-serializable snapshot for state preservation. */
  snapshot(): Record<string, { content: string; mediaType: string }>;
  /** Restore from a snapshot. */
  restore(snap: Record<string, { content: string; mediaType: string }>): void;
}
```

One instance per `CodeSessionStore` (per-tide-card scope).

#### Spec S04: Stream-json envelope written to claude stdin {#s04-stream-json-envelope}

```json
{
  "type": "user",
  "session_id": "",
  "message": {
    "role": "user",
    "content": [
      { "type": "text", "text": "<user prompt>" },
      { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "<b64>" } },
      { "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": "<b64>" } },
      { "type": "text", "text": "<contents of ref'd .md file>" }
    ]
  },
  "parent_tool_use_id": null
}
```

Order: user text first, then attachments in atom-document order. (Anthropic recommends media-before-text but Claude Code's existing `test-23` baseline puts text first; we preserve the existing order.)

#### Spec S05: `tug-attachment-strip` component contract {#s05-attachment-strip}

```tsx
interface TugAttachmentStripProps {
  attachments: ReadonlyArray<AttachmentRecord>;
  /** Click on an image opens a lightbox; click on a doc/text opens a sheet preview. */
  onAttachmentClick?: (attachment: AttachmentRecord, index: number) => void;
  className?: string;
}
```

- Image attachments → `<img src={thumbnailDataUrl} />` in a fixed-aspect tile.
- Document attachments → doc-icon chip with filename + byte-size + (when known) page-count.
- Text attachments → code-icon chip with filename + byte count + first-line preview.
- Ref-only-unexpanded attachments → dimmed treatment.
- Renders nothing when `attachments.length === 0`.

---

### Lists and Tables {#lists-and-tables}

#### List L01: Atom → Attachment mapping {#l01-atom-attachment-mapping}

| Atom type | `value` | Branch | Output |
|-----------|---------|--------|--------|
| `image`   | data-URL or atom-id keyed in bytes-store | inline | `image` attachment, kind=inline |
| `image`   | project-relative path | ref, role=image | `image` attachment, kind=ref |
| `file`    | project-relative path, ext ∈ {png, jpg, jpeg, gif, webp} | ref, role=image | `image` attachment, kind=ref |
| `file`    | project-relative path, ext == pdf | ref, role=document | `document` attachment, kind=ref |
| `file`    | project-relative path, ext ∈ text/code MIMEs | ref, role=text | `text` attachment, kind=ref |
| `doc`     | project-relative path | ref, role=document | `document` attachment, kind=ref |
| `link`    | http(s) URL | passthrough | (Q03 — provisional: text reference) |
| `command` | command name | drop | no attachment; command stays in text body |

#### Table T01: Atom-id minting {#t01-atom-id-minting}

| Atom origin | id minted at | id stable across | Notes |
|-------------|--------------|------------------|-------|
| Drop / paste | DOM event handler before substrate dispatch | mount, state preservation, CASE-A restore | Bytes go into bytes-store keyed by id |
| `@`-completion | `getFileCompletionProvider` result | mount, state preservation | No bytes; ref resolves at submit |
| `/`-completion | command provider result | mount | No bytes ever; not an attachment |
| Synthetic (gallery, tests) | test fixture sets it | test scope | Tests must mint stable ids for reproducibility |

#### Table T02: Failure modes and surfacing {#t02-failure-modes}

| Failure | Where caught | Surface |
|---------|--------------|---------|
| Ref points outside workspace | `tugcode resolveAttachment` | `error` event → `lastError` banner; turn never sent |
| Ref file missing | `tugcode resolveAttachment` | same |
| Ref file too large (per-attachment cap) | `tugcode resolveAttachment` | same, with size in message |
| Submission total > 28 MB | `tugcode resolveAttachment` running tally | same; user pares list |
| Image media type unsupported | `tugcode buildContentBlocks` | same; existing PN-12 path |
| Bad base64 data in inline | Anthropic API | `api_retry` then turn error |
| Atom missing from bytes-store at submit | `tugdeck atom-attachment-resolver` | submit blocked with specific error toast |

#### List L03: New probes (Step 2 + Step 9) {#l03-new-probes}

| Probe | Step | Input | Required events | Pins |
|-------|------|-------|-----------------|------|
| `test-36-jpeg-attachment` | 2 | 32×32 JPEG, `image/jpeg` | `assistant_text`, `cost_update`, `turn_complete` | JPEG branch of `buildContentBlocks` |
| `test-37-pdf-attachment` | 2 | 1-page synthetic PDF | `assistant_text`, `cost_update`, `turn_complete` | `document` block path; answers Q04 |
| `test-38-text-attachment` | 2 | Plain `.md`, `text/plain` | `assistant_text`, `cost_update`, `turn_complete` | `text/*` → `text` block branch |
| `test-39-multi-attachment` | 2 | JPEG + PDF + text body | `assistant_text`, `cost_update`, `turn_complete` | Multi-block ordering |
| `test-40-ref-resolution` | 9 | `kind: "ref"` for workspace `.md` | `assistant_text`, `cost_update`, `turn_complete` | Resolver path-containment + sniff |
| `test-41-image-too-large` | 9 | 6 MB PNG | `error` (`required_error`) | Negative-path: oversize rejection |
| `test-42-image-bad-mime` | 9 | PNG bytes mislabeled `image/tiff` | `error` (`required_error`) | Negative-path: media-type allowlist |
| `test-43-image-url-source` | 9 (research) | `source.type: "url"` PNG | `assistant_text` or `error` | Answers Q03 |

#### Table T04: Persistence tiers {#t04-persistence-tiers}

| Tier | Lifetime | What's stored | Source code |
|------|----------|---------------|-------------|
| In-memory snapshot | Mount → unmount | `AttachmentRecord` (thumbnails + metadata, no full bytes) | `CodeSessionSnapshot` |
| Bytes-store side-table | Mount → unmount + state-preservation snapshot | Base64 bytes for in-flight pre-submit attachments | `atom-bytes-store.ts` |
| Tugcast `turns` journal | Until claude acks the turn | Full inline bytes as JSON BLOB; refs as path strings | `session_ledger.rs:291` |
| JSONL | Forever (until user `forget`s) | Image content blocks for inline; `Read`-tool inputs for refs claude expanded | `~/.claude/projects/<encoded>/<sid>.jsonl` |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/atom-bytes-store.ts` | Per-card bytes side-table (Spec S03) |
| `tugdeck/src/lib/atom-attachment-resolver.ts` | Pure atom → Attachment translator (List L01) |
| `tugdeck/src/components/tugways/cards/tug-attachment-strip.tsx` | Transcript user-row attachment chip strip (Spec S05) |
| `tugdeck/src/components/tugways/cards/tug-attachment-strip.css` | Strip styling |
| `tugcode/src/__tests__/resolve-attachment.test.ts` | Path containment + size cap + MIME sniff coverage |
| `tugdeck/src/__tests__/atom-attachment-resolver.test.ts` | Atom variant cross-product coverage |
| `tugdeck/src/__tests__/tug-attachment-strip.test.tsx` | Strip rendering + lightbox open |

#### Files modified {#files-modified}

| File | Change |
|------|--------|
| `tugdeck/src/protocol.ts` | `Attachment` typed per Spec S01; `InboundMessage.user_message.attachments: Attachment[]` |
| `tugcode/src/types.ts` | `Attachment` discriminated union; backwards-compat shim |
| `tugcode/src/session.ts` | New `resolveAttachment` ahead of `buildContentBlocks`; `buildContentBlocks` learns `document` / `text` branches; `TUG_CAPTURE_INBOUND_LOG` mirror |
| `tugcode/src/replay.ts` | Add `document` block decoding alongside `image` |
| `tugdeck/src/lib/code-session-store.ts` | Plumb `atomBytesStore` ref through to reducer effect builder |
| `tugdeck/src/lib/code-session-store/reducer.ts` | `handleSend` and queued-flush translate atoms → `Attachment[]` |
| `tugdeck/src/lib/code-session-store/types.ts` | `TurnEntry.userMessage.attachments: ReadonlyArray<AttachmentRecord>` |
| `tugdeck/src/lib/tug-atom-img.ts` | `AtomSegment.id?: string`; image atom thumbnail rendering reads bytes-store |
| `tugdeck/src/components/tugways/tug-text-editor/drop-extension.ts` | Read `file.arrayBuffer()`, base64, stash in bytes-store, mint atom-id |
| `tugdeck/src/components/tugways/tug-text-editor/clipboard-filters.ts` | Paste handler for `image/*` clipboard items |
| `tugdeck/src/components/tugways/tug-prompt-entry.tsx` | Pass `bytesStore` ref into the resolver call |
| `tugdeck/src/components/tugways/cards/tide-card-transcript.tsx` | `UserRowCell` renders `TugAttachmentStrip` above body |
| `tugrust/crates/tugcast/tests/common/probes.rs` | New `ProbeMsg::WriteWorkspaceFile` variant; `ProbeRecord.required_error: Option<&str>`; probes 36-43 |
| `tugrust/crates/tugcast/tests/capture_stream_json_catalog.rs` | Set `TUG_CAPTURE_INBOUND_LOG` per probe; copy + normalize the inbound log |
| `tugrust/crates/tugcast/tests/stream_json_catalog_drift.rs` | Diff `*.inbound.jsonl` alongside `*.jsonl` |
| `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/README.md` | New §"Bidirectional capture" |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `Attachment` | type | `tugdeck/src/protocol.ts`, `tugcode/src/types.ts` | Spec S01 |
| `AttachmentRecord` | type | `tugdeck/src/lib/code-session-store/types.ts` | Spec S02 |
| `AtomBytesStore` | interface | `tugdeck/src/lib/atom-bytes-store.ts` | Spec S03 |
| `resolveAttachments` | fn | `tugdeck/src/lib/atom-attachment-resolver.ts` | Pure: `(atoms, bytesStore) => Attachment[]` |
| `resolveAttachment` | fn | `tugcode/src/session.ts` | `(att, cwd) => Promise<InlineAttachment>` |
| `bakeThumbnail` | fn | `tugdeck/src/lib/code-session-store/thumbnail.ts` | Canvas-based downscaler for image-only thumbnails |
| `TugAttachmentStrip` | component | `tugdeck/src/components/tugways/cards/tug-attachment-strip.tsx` | Spec S05 |
| `ProbeMsg::WriteWorkspaceFile` | enum variant | `tugrust/crates/tugcast/tests/common/probes.rs` | Pre-write a workspace file before sending the user_message that refs it |
| `ProbeRecord.required_error` | field | `tugrust/crates/tugcast/tests/common/probes.rs` | `Option<&'static str>`; when set, probe terminates on `error` event with matching message |
| `TUG_CAPTURE_INBOUND_LOG` | env var | `tugcode/src/session.ts` | When set, mirror stream-json envelope to that path |

---

### Documentation Plan {#documentation-plan}

- [ ] Update `dash/transport-exploration.md` with new sub-sections for tests 36-43, in the same prose style as Test 23. Include empirical findings (cost numbers, error classifications, accepted media types).
- [ ] Add §"Bidirectional capture" to `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/README.md` covering the inbound-log mechanism, normalization, and drift-regression coverage.
- [ ] Update `dash/atoms-attachments.md` with a "Resolved" header pointing at this plan once Step 13 lands.
- [ ] Update `tuglaws.md` if any new responder/state-preservation laws emerge from the bytes-store integration.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (TS)** | Pure function coverage | `atom-attachment-resolver`, `bakeThumbnail`, `atom-bytes-store` |
| **Unit (Rust)** | Probe-driver primitives | `ProbeMsg::WriteWorkspaceFile`, `required_error` semantics |
| **Integration (TS)** | Reducer + store + bytes-store wiring | `code-session-store/__tests__/reducer.test.ts` extensions |
| **Integration (tugcode)** | `resolveAttachment` against tmp workspaces | `tugcode/src/__tests__/resolve-attachment.test.ts` |
| **Golden / Catalog** | Fixture-driven regression | All new probes; bidirectional inbound logs |
| **Drift Prevention** | Cross-version stability | `stream_json_catalog_drift_regression` extension |
| **End-to-end (`just app-test`)** | Full submit → render → cold-restart loop | Step 13 integration check |
| **Manual smoke** | UX regressions catchable only by eye | Drop a PNG, paste a screenshot, `@`-mention a `.md`, see thumbnails |

---

### Execution Steps {#execution-steps}

> Probes and supporting infrastructure (Steps 1-3) come *before* the wire-shape evolution (Step 4) per [D06](#d06-probes-first). This gives every subsequent step a regression baseline to measure itself against.

#### Step 1: Probe-driver primitives {#step-1}

**Commit:** `test(tugcast): add probe-driver primitives for attachments and error-expectation`

**References:** [D06](#d06-probes-first), Spec S01, (#strategy)

**Artifacts:**
- New `ProbeMsg::WriteWorkspaceFile { path: &'static str, contents: &'static [u8] }` variant in `probes.rs`.
- New optional field `ProbeRecord.required_error: Option<&'static str>` — when set, the probe terminates successfully on receipt of an `error` event whose `message` field contains the substring (case-insensitive). Mutually exclusive with `required_events.contains("turn_complete")`.
- Test-side helper `TestWs::write_workspace_file(path, bytes)` that writes into the probe's tmp workspace before the next `send_*` call.

**Tasks:**
- [ ] Extend `ProbeMsg` enum at `tugrust/crates/tugcast/tests/common/probes.rs:62` with `WriteWorkspaceFile`.
- [ ] Add the `required_error` field to `ProbeRecord` with default `None`.
- [ ] Update `probe_table_has_35_entries` test temporarily — it'll be replaced in Step 2.
- [ ] Add capture-binary handling in `tugrust/crates/tugcast/tests/capture_stream_json_catalog.rs` for the new variant + `required_error` terminal.

**Tests:**
- [ ] `probes::tests::write_workspace_file_variant_round_trips` — construct a `ProbeRecord` with `WriteWorkspaceFile`, run via probe driver against a stub session, verify file lands in tmp workspace before the user_message.
- [ ] `probes::tests::required_error_terminal_passes_on_match` — synthetic `error` event with matching message terminates the probe cleanly.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast common::probes`
- [ ] `cd tugrust && cargo build --tests --features real-claude-tests` (warnings-as-errors clean)

---

#### Step 2: Empirical attachment probes (today's wire shape) {#step-2}

**Depends on:** #step-1

**Commit:** `test(tugcast): add probes 36-39 for attachment media-type breadth`

**References:** [D06](#d06-probes-first), List L03, (#empirical-regression-coverage)

**Artifacts:**
- New probes in the `PROBES` table:
  - `test-36-jpeg-attachment` — 32×32 JPEG (~4 KB) inline.
  - `test-37-pdf-attachment` — 1-page synthetic PDF (~5 KB) inline.
  - `test-38-text-attachment` — plain `.md` payload, `text/plain`.
  - `test-39-multi-attachment` — one JPEG + one PDF + 200-char text body in one `user_message`.
- `probe_table_has_35_entries` updated to `probe_table_has_39_entries`.
- Static `&'static str` base64 payloads as module-level constants — synthetic PDF generated once and committed; JPEG generated from a 32×32 solid-color test pattern.

**Tasks:**
- [ ] Generate the 32×32 JPEG and 1-page PDF test fixtures; embed as base64 string constants. Document the generation script in a comment so they can be regenerated reproducibly.
- [ ] Add probes 36-39 with `UserMessageWithAttachments` input scripts.
- [ ] Update the count assertion in the unit tests.
- [ ] Run `just capture-capabilities` against the current claude (`2.1.112`) with `TUG_STABILITY=3`. Commit the resulting `v2.1.112/test-3{6,7,8,9}-*.jsonl` baselines as part of this step (or a follow-up commit if the capture run feels separate).

**Tests:**
- [ ] `probes::tests::probe_table_has_39_entries`
- [ ] `cargo nextest run -p tugcast --features real-claude-tests --run-ignored only capture_all_probes` for the four new probes (manual; not in CI).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast common::probes`
- [ ] Manual: `just capture-capabilities` produces `v2.1.112/test-3{6,7,8,9}-*.jsonl` with `status: "passed"` in the manifest.
- [ ] Open `v2.1.112/test-37-pdf-attachment.jsonl` and record the answer to [Q04](#q04-pdf-jsonl-roundtrip): does claude write `document` blocks back into JSONL or only extracted text? Update Q04 resolution.

---

#### Step 3: Bidirectional capture (`TUG_CAPTURE_INBOUND_LOG`) {#step-3}

**Depends on:** #step-2

**Commit:** `feat(tugcode): mirror stream-json envelope to TUG_CAPTURE_INBOUND_LOG`

**References:** [D05](#d05-bidirectional-capture), Risk R01, (#what-the-catalog-does-not-capture)

**Artifacts:**
- `tugcode/src/session.ts` — when `process.env.TUG_CAPTURE_INBOUND_LOG` is a non-empty string, append the JSON-stringified envelope (`{ type: "user", … }` and any other inbound writes to claude's stdin) to that file path with `\n` termination. Open with `O_APPEND | O_CREAT`.
- `tugrust/crates/tugcast/tests/capture_stream_json_catalog.rs` — point each probe at a unique inbound-log path under the probe's tmp dir; after the probe, read the file, normalize via the existing placeholder vocabulary, write to `<probe>.inbound.jsonl` next to the existing fixture.
- `tugrust/crates/tugcast/tests/stream_json_catalog_drift.rs` — diff `*.inbound.jsonl` alongside `*.jsonl`. Same Benign/Semantic/Ambiguous classification.
- README §"Bidirectional capture" describing the env var, the per-probe convention, and the drift-regression coverage.

**Tasks:**
- [ ] Implement the env-gated mirror in `tugcode/src/session.ts:2791` and any other stdin-write site (`handleToolApproval`, `handleQuestionAnswer`, `handleInterrupt`).
- [ ] Plumb a per-probe `inbound_log_path: PathBuf` through the capture binary; set the env var when spawning tugcode.
- [ ] Implement the post-probe normalization + write of `<probe>.inbound.jsonl`.
- [ ] Extend the drift regression to glob both fixture types.
- [ ] Update the README with a §"Bidirectional capture" subsection.

**Tests:**
- [ ] `tugcode/src/__tests__/inbound-log.test.ts` — synthetic session writes user_message with an attachment; verify the inbound log file contains exactly one line with the expected envelope.
- [ ] Manual: re-run `just capture-capabilities`. Every probe directory now contains paired files: `test-NN-*.jsonl` (outbound) and `test-NN-*.inbound.jsonl` (inbound). Drift-regression run is clean.

**Checkpoint:**
- [ ] `cd tugcode && bun test`
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] Manual: `just capture-capabilities` against `claude 2.1.112` produces inbound logs for every attachment-bearing probe (test-23, test-36, test-37, test-38, test-39) and the drift regression is clean.

---

#### Step 4: Wire-shape evolution {#step-4}

**Depends on:** #step-3

**Commit:** `feat(protocol): Attachment as discriminated union with kind: inline | ref`

**References:** [D02](#d02-attachment-discriminated-union), Spec S01, (#wire-shape-evolution)

**Artifacts:**
- `tugdeck/src/protocol.ts` — `Attachment` typed per Spec S01; `InboundMessage.user_message.attachments: Attachment[]`.
- `tugcode/src/types.ts` — same. `isAttachment` type guard updated.
- `buildContentBlocks` in `tugcode/src/session.ts` accepts the new shape; `kind: "ref"` arms throw with a clear "ref attachments must be resolved before buildContentBlocks" error (resolver lands in Step 8).
- Backwards-compat shim: `kind` defaults to `"inline"` and `role` defaults to `"auto"` when absent.
- Round-trip protocol-fixture tests.

**Tasks:**
- [ ] Update both type files; sync by hand and add a comment block calling out the parallel structure.
- [ ] Update `decodeCodeInputPayload` and `tugcode/src/__tests__/types.test.ts` round-trip cases.
- [ ] Verify all existing `test-23-image-attachment` fixtures still parse — they're inline-shape and should pass cleanly.

**Tests:**
- [ ] `tugcode/src/__tests__/types.test.ts` — parse old-shape and new-shape fixtures.
- [ ] `tugdeck/src/__tests__/protocol-code-input-payload.test.ts` — round-trip `kind: "inline"` and `kind: "ref"` shapes.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugcode && bun test`
- [ ] `cd tugrust && cargo nextest run -p tugcast common::probes` — existing `test-23` parsing unchanged.

---

#### Step 5: Browser bytes side-table + paste/drop wiring {#step-5}

**Depends on:** #step-4

**Commit:** `feat(tugdeck): atom bytes store + paste/drop image bytes capture`

**References:** [D03](#d03-bytes-side-table), Spec S03, Table T01, (#atom-attachment-translation-on-the-browser-side)

**Artifacts:**
- New `tugdeck/src/lib/atom-bytes-store.ts` per Spec S03.
- `AtomSegment` gains optional `id?: string` field minted at insert time (`tugdeck/src/lib/tug-atom-img.ts`).
- `drop-extension.ts` calls `file.arrayBuffer()` per dropped file, base64-encodes synchronously, mints an atom-id, stashes in the per-card store, and inserts the atom with `id` set.
- `clipboard-filters.ts` paste handler — read `image/*` `ClipboardItem` entries, base64-encode, mint id, insert as `image` atom + side-table entry. Falls through unchanged for non-image clipboard items.
- `useCardStatePreservation` save/restore pair includes the bytes-store snapshot (a separate `bag.attachmentBytes` slot, not on `bag.content`, to avoid fattening the prompt-entry's draft snapshot).
- CASE-A interrupt restore: `pendingDraftRestore` already carries atoms; the bytes-store snapshot rides alongside.

**Tasks:**
- [ ] Implement `AtomBytesStore` per Spec S03 with simple in-memory `Map<string, {content, mediaType}>`.
- [ ] Mint atom-ids on every insertion path (drop, paste, completion). Use `crypto.randomUUID()`.
- [ ] Wire bytes-store snapshot into `useCardStatePreservation` (new bag slot).
- [ ] Wire `pendingDraftRestore` reducer path to capture the bytes-store snapshot alongside atoms.
- [ ] Manual smoke: drop an image → close-and-reopen the card → atom is restored with bytes intact.

**Tests:**
- [ ] `tugdeck/src/lib/__tests__/atom-bytes-store.test.ts` — put/get/delete/snapshot/restore round-trips.
- [ ] `tugdeck/src/components/tugways/__tests__/tug-text-editor-drop.test.ts` extension — drop a synthetic `File`, verify atom-id minted and bytes-store populated.
- [ ] `tugdeck/src/components/tugways/__tests__/tug-text-editor-paste.test.ts` (new) — paste a synthetic `image/png` clipboard item, verify atom inserted + bytes-store populated.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bun run check`

---

#### Step 6: Resolver + reducer wiring {#step-6}

**Depends on:** #step-5

**Commit:** `feat(tugdeck): atom-to-attachment resolver in code-session-store`

**References:** [D02](#d02-attachment-discriminated-union), [D03](#d03-bytes-side-table), List L01, (#wire-envelope-in-code-session-store)

**Artifacts:**
- New `tugdeck/src/lib/atom-attachment-resolver.ts` — pure function `(atoms, bytesStore) => Attachment[]` covering List L01.
- `code-session-store.ts` plumbs the per-store `atomBytesStore` ref into the reducer's effect builder. Cleanest path: an extra arg on `reducer.ts:handleSend` carrying a `resolveAttachments` thunk; the store closure binds it.
- `reducer.ts:handleSend` and the queued-send flush at `:892` switch from `attachments: []` to `attachments: resolveAttachments(event.atoms, bytesStore)`.

**Tasks:**
- [ ] Implement `resolveAttachments` per List L01.
- [ ] Update `reducer.ts:handleSend` signature to accept the resolver thunk; thread it through from the store constructor.
- [ ] Update queued-send flush in `handleTurnComplete` to call the resolver too.
- [ ] Update reducer tests that pin `attachments: []` to assert the resolver's output instead.

**Tests:**
- [ ] `tugdeck/src/__tests__/atom-attachment-resolver.test.ts` — cover every row of List L01.
- [ ] `tugdeck/src/lib/code-session-store/__tests__/reducer.test.ts` — submit with one image atom + one ref atom asserts the right `Attachment[]` shape on the `send-frame` effect.
- [ ] Same for queued-send path.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bun run check`

---

#### Step 7: TurnEntry shape + thumbnail bake {#step-7}

**Depends on:** #step-6

**Commit:** `feat(tugdeck): typed AttachmentRecord on TurnEntry with thumbnails`

**References:** [D04](#d04-no-bytes-on-snapshot), Spec S02, Risk R04, (#turn-entry-shape-change)

**Artifacts:**
- `tugdeck/src/lib/code-session-store/types.ts` — `TurnEntry.userMessage.attachments: ReadonlyArray<AttachmentRecord>` (replaces `ReadonlyArray<unknown>`).
- New `tugdeck/src/lib/code-session-store/thumbnail.ts` — `bakeThumbnail(content, mediaType): Promise<string | null>`. Returns a 256-px-max-edge data URL for `image/*`, `null` otherwise. Canvas-based; no library dependency.
- Reducer commit at `reducer.ts:820` runs the thumbnail bake on inline image attachments before writing them to the entry.
- `CodeSessionSnapshot.pendingUserMessage.attachments` typed.

**Tasks:**
- [ ] Implement `bakeThumbnail`.
- [ ] Tighten the type and update every consumer that reads `attachments` (including `tide-card-transcript.tsx`, even if it ignores the field today).
- [ ] Update reducer commit + interrupt paths to construct `AttachmentRecord` from the in-flight `Attachment[]`.
- [ ] Update tests that pin `attachments: []` on `TurnEntry`.

**Tests:**
- [ ] `tugdeck/src/lib/code-session-store/__tests__/reducer.test.ts` — turn_complete commits an `AttachmentRecord` with a populated `thumbnailDataUrl` for image-bearing turns.
- [ ] `tugdeck/src/lib/code-session-store/__tests__/thumbnail.test.ts` — `bakeThumbnail` produces a ≤256 px data URL for a synthetic 1024×1024 PNG; returns null for `application/pdf`.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bun run check`

---

#### Step 8: tugcode resolver + content-block extension {#step-8}

**Depends on:** #step-7

**Commit:** `feat(tugcode): resolveAttachment + document/text content-block branches`

**References:** [D01](#d01-resolve-in-tugcode), [D07](#d07-content-block-branching), [D08](#d08-containment-and-caps), Risk R02, R03, (#tugcode-resolver-ref-bytes-content-block)

**Artifacts:**
- `tugcode/src/session.ts` — new `resolveAttachment(att, cwd)` returning `Promise<InlineAttachment>`. Path-containment via `realpath`; size cap; MIME sniff (extension-based fallback if `media_type` absent). Submission-total tally fails closed at 28 MB.
- `buildContentBlocks` learns `application/pdf` → `document` block and the `text/*` / known-code-MIME → `text` block branches.
- `handleUserMessage` resolves all attachments before the block build; surfacing failures as `error` events.
- Update existing PN-12 image validation to live alongside new branches without regression.

**Tasks:**
- [ ] Implement `resolveAttachment` with the path-containment + size-cap + MIME-sniff trio.
- [ ] Extend `buildContentBlocks` per [D07](#d07-content-block-branching).
- [ ] Update `handleUserMessage` to await resolver outputs and emit `error` events on failure.
- [ ] Add a known-code-MIME allowlist constant (start narrow; expand on demand).
- [ ] Verify backwards-compatibility: existing inline-image fixtures still produce identical content blocks (compare against Step 3's bidirectional logs for `test-23`).

**Tests:**
- [ ] `tugcode/src/__tests__/resolve-attachment.test.ts` — happy path (in-workspace `.md`); negative paths (escape via `..`, escape via symlink, oversize, missing file, bad MIME).
- [ ] `tugcode/src/__tests__/build-content-blocks.test.ts` — three new branches plus the existing image branch unchanged.
- [ ] Bidirectional log for `test-23` matches the pre-step capture (no regression in image branch).

**Checkpoint:**
- [ ] `cd tugcode && bun test`
- [ ] Manual: `just capture-capabilities` — `test-23-image-attachment.inbound.jsonl` is byte-identical to the prior baseline (verified via `git diff`).

---

#### Step 9: Ref-resolution + negative-path probes {#step-9}

**Depends on:** #step-8

**Commit:** `test(tugcast): add probes 40-43 for ref resolution and error paths`

**References:** [D06](#d06-probes-first), [D08](#d08-containment-and-caps), List L03, Q03, (#probes-to-add-as-part-of-this-work)

**Artifacts:**
- `test-40-ref-resolution` — script: `WriteWorkspaceFile { path: "tug-probe-ref.md", contents: <small markdown> }` then `UserMessage { text: "Summarize @tug-probe-ref.md in one sentence." }` … wait, this needs the new `Attachment kind: "ref"` shape. Use a new `ProbeMsg::UserMessageWithRefAttachments` variant or extend the existing `UserMessageWithAttachments` to accept the discriminated union shape. Cleaner: extend the existing variant to take `&'static [Attachment]` where `Attachment` itself is the discriminated union (mirror the wire shape in the probe table).
- `test-41-image-too-large` — 6 MB synthetic PNG inline; `required_error: "exceeds"`.
- `test-42-image-bad-mime` — PNG bytes mislabeled `image/tiff` inline; `required_error: "Unsupported image type"`.
- `test-43-image-url-source` (research probe) — `Attachment { kind: "inline", role: "image", media_type: "image/png", filename: "<empty>", content: "<url-passthrough-marker>" }`. Actually this needs another small variant — `kind: "url"` is not in our union today; the probe answers Q03 by asking whether *Anthropic* accepts `source.type: "url"` via a one-off content-block synthesis. Implementation: extend `buildContentBlocks` in tugcode behind a `TUG_PROBE_URL_SOURCE` env to pass through `source: { type: "url", url }`. Probe sets the env. Result feeds into Q03 resolution. Mark probe `optional` in manifest until Q03 resolves.
- `probe_table_has_43_entries` count update.

**Tasks:**
- [ ] Extend the probe `Attachment` struct to the discriminated union shape.
- [ ] Add `WriteWorkspaceFile` script step before the user_message in test-40.
- [ ] Add the 6 MB PNG (or test-time generator) for test-41.
- [ ] Add the mislabeled-MIME fixture for test-42.
- [ ] Add the `TUG_PROBE_URL_SOURCE` env-gated branch in tugcode behind a sandboxed code path (research only; not exposed to production callers).
- [ ] Run `just capture-capabilities`; commit the new fixtures.

**Tests:**
- [ ] `probes::tests::probe_table_has_43_entries`.
- [ ] Manual: `just capture-capabilities` — fixtures land for 40-42; 43 lands as `optional`. Inbound logs for 40 show a `text` block carrying the `.md` contents; 41 / 42 show no inbound (tugcode rejected before stdin write) and an `error` event on the outbound side.
- [ ] Update [Q03](#q03-url-source-type) resolution in this plan based on `test-43` outcome.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast common::probes`
- [ ] Manual capture run clean; drift regression Benign-or-better.

---

#### Step 10: JSONL replay extensions {#step-10}

**Depends on:** #step-9

**Commit:** `feat(tugcode): replay decodes document content blocks`

**References:** [D09](#d09-three-tier-persistence), Q04, (#jsonl-replay-enhancements)

**Artifacts:**
- `tugcode/src/replay.ts:478` — add `document` branch alongside `image`. Extract `media_type` and base64 `data` into `Attachment { kind: "inline", role: "document", … }`.
- `unknownShape` telemetry no longer fires for `document` blocks.
- `user_message_replay` carries `Attachment[]` containing both inline and (post-Step 5/6) ref-shape entries; reducer-side decoding lands them on `AttachmentRecord` via the existing path.

**Tasks:**
- [ ] Implement `document` decoding in `replay.ts`.
- [ ] Verify against `test-37-pdf-attachment.jsonl` from Step 2: a fresh replay produces an `Attachment` matching the original inline shape.
- [ ] Verify cold-mount of a card with a PDF-bearing turn renders the same chip as the live submit produced (manual + integration test).

**Tests:**
- [ ] `tugcode/src/__tests__/replay.test.ts` — feed the test-37 fixture; assert the decoded `Attachment[]`.
- [ ] `tugdeck/src/lib/code-session-store/__tests__/code-session-store.replay.test.ts` extension — replay path produces a populated `AttachmentRecord[]` on the committed turn.

**Checkpoint:**
- [ ] `cd tugcode && bun test`
- [ ] `cd tugdeck && bun test`

---

#### Step 11: Transcript rendering — `tug-attachment-strip` {#step-11}

**Depends on:** #step-10

**Commit:** `feat(tugdeck): tug-attachment-strip + transcript user-row attachments`

**References:** Spec S05, Risk R04, (#transcript-rendering-tuglistview)

**Artifacts:**
- New `tugdeck/src/components/tugways/cards/tug-attachment-strip.tsx` + `.css` per Spec S05.
- `tide-card-transcript.tsx:UserRowCell` renders the strip above the body when `attachments.length > 0`.
- A new gallery card variant `gallery-attachment-strip.tsx` (parallel to `gallery-atom.tsx`) so the design is tunable in isolation.
- Lightbox on image click — reuse `TugSheet` chrome.
- `TugListView` row-height accounting includes the strip (measured on the same `useLayoutEffect` cycle as the body).

**Tasks:**
- [ ] Build `TugAttachmentStrip` per Spec S05.
- [ ] Build the gallery card.
- [ ] Wire the strip into `UserRowCell`.
- [ ] Implement lightbox open/close.
- [ ] Update `TugListView` row-height contract.
- [ ] Manual smoke against the gallery card; verify accessibility (alt text from `filename`).

**Tests:**
- [ ] `tugdeck/src/components/tugways/cards/__tests__/tug-attachment-strip.test.tsx` — renders image tile, doc chip, text chip, ref-only-dimmed, empty.
- [ ] `tugdeck/src/components/tugways/cards/__tests__/tide-card-transcript.test.tsx` extension — committed turn with attachments renders the strip; row height accounts for it.
- [ ] Visual regression / manual: `just app-test gallery-attachment-strip`.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bun run audit:tokens lint`
- [ ] Manual: open the gallery card, confirm Slack-style layout per [`tugplan-tide-card-polish.md` D6](./tugplan-tide-card-polish.md).

---

#### Step 12: Editor atom thumbnails (cheap polish) {#step-12}

**Depends on:** #step-11

**Commit:** `feat(tugdeck): image atom thumbnails read from atom-bytes-store`

**References:** [D03](#d03-bytes-side-table), (#editor-side-rendering-of-inline-images)

**Artifacts:**
- `tug-atom-img.ts` `createAtomImgElement` — for `type === "image"` atoms with a known atom-id and bytes-store entry, use the bytes (downsampled to chip height) as the `<img src>` directly. Falls back to the generic SVG when no bytes are known.
- Atom theme regeneration handles thumbnail-bearing atoms cleanly (a theme switch doesn't need to rebuild the bitmap, just the chrome).

**Tasks:**
- [ ] Add a small bitmap downscaler reused from `bakeThumbnail` (Step 7).
- [ ] Wire `createAtomImgElement` to receive a `bytesStore` reference (or a per-call lookup callback).
- [ ] Verify atom-decoration regen path doesn't churn unnecessarily.

**Tests:**
- [ ] `tugdeck/src/lib/__tests__/tug-atom-img.test.ts` extension — image atom with bytes renders an `<img src="data:image/...">`; without bytes, renders the generic SVG.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] Manual: drop an image, observe the inline atom shows the thumbnail.

---

#### Step 13: Integration checkpoint {#step-13}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7, #step-8, #step-9, #step-10, #step-11, #step-12

**Commit:** `N/A (verification only)`

**References:** [D01](#d01-resolve-in-tugcode), [D02](#d02-attachment-discriminated-union), [D04](#d04-no-bytes-on-snapshot), [D05](#d05-bidirectional-capture), Spec S01, S02, S04, S05, (#success-criteria)

**Tasks:**
- [ ] Verify all artifacts from Steps 1-12 are complete and cooperate end-to-end.
- [ ] Re-run `just capture-capabilities` against the current claude with `TUG_STABILITY=3`. Drift regression must classify Benign-or-better.
- [ ] Update [Q01](#q01-inline-text-refs), [Q03](#q03-url-source-type), [Q04](#q04-pdf-jsonl-roundtrip) resolutions based on probe data.
- [ ] Walk the tuglaws checklist for the new components (`tug-attachment-strip`, the bytes-store, the resolver, the paste handler).
- [ ] Update `dash/transport-exploration.md` with prose entries for tests 36-43.
- [ ] Update `dash/atoms-attachments.md` with a "Resolved" header pointing here.

**Tests:**
- [ ] `cd tugrust && cargo nextest run --workspace`
- [ ] `cd tugdeck && bun test && bun run check && bun run audit:tokens lint`
- [ ] `cd tugcode && bun test`
- [ ] `just app-test` integration: a probe-driver-equivalent app-test recipe drops a PNG, mentions a workspace `@README.md`, submits, and asserts:
  - (a) the wire frame carries two `Attachment`s with the right shapes (one inline image, one ref);
  - (b) tugcode emits two correct content blocks to claude's stdin (verified against the bidirectional fixture from step 3);
  - (c) the transcript renders a thumbnail tile + a doc/text chip;
  - (d) cold-restart of the card replays both correctly from JSONL + journal.
- [ ] Manual smoke: paste a screenshot, drop a PDF, `@`-mention `CLAUDE.md`, submit. Verify thumbnails in the editor, chips in the transcript, lightbox opens, full bytes survive a card close-and-reopen.

**Checkpoint:**
- [ ] `cd tugrust && env -u ANTHROPIC_API_KEY TUG_REAL_CLAUDE=1 cargo nextest run -p tugcast --features real-claude-tests --run-ignored only stream_json_catalog_drift_regression` — exits 0 (Benign-or-better).
- [ ] All success criteria from [`#success-criteria`](#success-criteria) ticked.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A user-visible attachment lifecycle in Tide: drop / paste / `@`-mention an image, document, or text file in `tug-prompt-entry`; submit; see thumbnails in the transcript user row; cold-restart the card and find the same attachments restored from JSONL + journal. The image content-block path remains a regression-tracked baseline (`test-23`); new media types (JPEG, PDF, plain text) and the ref-resolution path are added to the same baseline.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every success criterion in [`#success-criteria`](#success-criteria) verified by its named verification.
- [ ] `just capture-capabilities` clean against `claude 2.1.112` (or whichever version is current at exit time) — drift regression Benign-or-better; both outbound and inbound fixtures land cleanly for tests 23, 36-42 (43 optional).
- [ ] Manual smoke per [Step 13](#step-13): paste / drop / `@`-mention round-trip works end-to-end.
- [ ] [`atoms-attachments.md`](./atoms-attachments.md) marked "Resolved by [`tugplan-tide-atoms-attachments.md`](./tugplan-tide-atoms-attachments.md)".
- [ ] [`transport-exploration.md`](./transport-exploration.md) has prose entries for tests 36-43.
- [ ] No new IndexedDB or localStorage. No new tugcast verb. No new feed ID.
- [ ] `bun run check`, `bun test` (tugdeck + tugcode), `cargo nextest run --workspace` all clean with `-D warnings`.

**Acceptance tests:**
- [ ] `cargo nextest run -p tugcast --features real-claude-tests --run-ignored only capture_all_probes` — manual; exits with all attachment-bearing probes `passed`.
- [ ] `just app-test` end-to-end recipe (Step 13).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Image downsampling at submit time ([Q02](#q02-image-downsampling)).
- [ ] Files API `file_id` source type ([Q07](#q07-files-api-uploads)).
- [ ] `.tugattachignore` for sensitive files ([Q05](#q05-permission-model)).
- [ ] Cross-card paste with bytes ([Q06](#q06-cross-card-paste)).
- [ ] Token-cost data on inline-text-ref vs `Read`-tool-fetch — re-evaluate [Q01](#q01-inline-text-refs) provisional choice.

| Checkpoint | Verification |
|------------|--------------|
| Wire shape evolved backwards-compatibly | Step 4 round-trip tests + Step 3's `test-23` inbound log byte-identical pre/post |
| Probes for media-type breadth land before implementation | Step 2 fixtures committed before Step 4 wire changes |
| Bidirectional capture watches every attachment-bearing probe | Step 3 produces `*.inbound.jsonl` for tests 23, 36-39; Step 9 extends to 40-43 |
| Resolver + content-block branching | Step 8 unit tests + Step 9's test-40 ref-resolution probe |
| Snapshot stays small | Step 7's `bakeThumbnail` enforced; Risk R04 monitored |
| Replay round-trips PDF | Step 10 + Step 9's test-37 fixture |
| Transcript renders attachments | Step 11 gallery card + transcript tests |
| End-to-end | Step 13 `just app-test` recipe |
