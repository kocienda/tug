# Atoms → Attachments — End-to-End Plan

**Status:** Proposed
**Date:** 2026-05-08
**Owner:** open
**Depends on:** code-session-store reducer, protocol.ts InboundMessage union, tugcast supervisor + journal, tugcode session/replay, tide-card-transcript
**Relates to:**
- [`transport-exploration.md`](transport-exploration.md) §"Test 23: Image Attachment" (image happy-path), §"Test 24: `@` File References" (load-bearing finding for ref-resolution scope)
- [`ws-verification.md`](ws-verification.md) (transport readiness; T8-T11 fixed in commit `e0174373`)
- [`tide.md`](tide.md) §T3.4.b (prompt-entry → transcript flow that this proposal feeds into)
- [`session-metadata-feed.md`](session-metadata-feed.md) (snapshot-feed pattern reused for in-flight attachment delivery)
- `tugrust/crates/tugcast/tests/common/probes.rs` `test-23-image-attachment` (live regression baseline) and `test-24-at-file-references`
- `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.112/test-23-image-attachment.jsonl` (frozen golden)
- `Justfile:48` `capture-capabilities` (the harness this proposal rides)

---

## TL;DR

The browser-side prompt entry already represents file/image references as **atoms** in the CM6 document. The Rust ↔ tugcode wire already carries an `Attachment { filename, content, media_type }` array on every `user_message`, and tugcode already converts those into Anthropic content blocks (`text` + `image`) before writing to Claude Code's stdin. The replay translator already round-trips image blocks back out of JSONL. **The image path is empirically validated end-to-end** by `test-23-image-attachment` in the stream-json catalog — every supported claude version since `v2.1.104` has a passing fixture for a 1×1 PNG round-trip.

**The hole is in the middle.** The reducer's `send-frame` effect today emits `attachments: []` unconditionally — atoms never reach the wire. The transcript view today renders user rows as plain text — atoms never reach the eye. The proposal closes both gaps with a single attachment lifecycle that runs from atom-insert through replay-render.

**One previous finding decides a major question.** `test-24-at-file-references` proved that `@`-mentions in headless `--input-format stream-json` mode do **not** trigger client-side file injection — the `@` machinery is a terminal-only feature. Claude only saw `@CLAUDE.md`'s contents because they were already in session context. So the graphical UI is on the hook for `@`-resolution, end of story. This proposal puts that resolver in tugcode (closer to the workspace) rather than tugdeck (closer to the user), with rationale below.

This document specifies:

1. **Atom → attachment translation** at the browser, with two code paths (inline bytes vs path reference).
2. **Wire-shape evolution** of the `Attachment` type to carry `kind: "inline" | "ref"` so tugcode can resolve refs server-side.
3. **tugcode resolver** that reads referenced files from the workspace, classifies them by MIME, builds the right Anthropic content block (`image` / `document` / `text`).
4. **JSONL replay round-trip** — what we already do, plus document-block decoding (currently we only handle `image`).
5. **TugListView rendering** in the transcript: thumbnail row above the user body for images, atom-chip row for files/docs/links.
6. **Persistence** of bytes on inline attachments via tugcast's existing `turns` journal.

---

## Today's state (verified by reading code)

### 1. Browser atom representation

`tugdeck/src/lib/tug-atom-img.ts:24` declares the canonical atom shape:

```ts
interface AtomSegment {
  kind: "atom";
  type: string;   // "file" | "image" | "doc" | "link" | "command"
  label: string;  // display text inside the chip
  value: string;  // free-form string — path, URL, or command name
}
```

Atoms are inserted three ways today:

- `@`-completion via `FileTreeStore.getFileCompletionProvider()` — `tugdeck/src/lib/filetree-store.ts:147` builds `{ kind, type: "file", label: r.path, value: r.path }`. The `value` is the **project-relative path** the supervisor returned.
- Drop from Finder via `defaultFilesToAtoms()` — `tugdeck/src/components/tugways/tug-text-editor/drop-extension.ts:120` only reads file *names* (no `arrayBuffer()` call). `value` is the bare filename.
- Custom `dropHandler` prop — declared in `tug-text-types.ts:60` as `(files: FileList) => AtomSegment[]`. Tide-card does **not** wire one today (`tide-card.tsx:2002` omits `dropHandler`).

Paste of an image blob from the OS clipboard would hit `clipboardExt` in `tugdeck/src/components/tugways/tug-text-editor/clipboard-filters.ts`. Today that path handles **only** the substrate's own atom-sidecar HTML envelope; raw `image/*` clipboard items are dropped on the floor.

### 2. Atoms on the in-flight submission

`code-session-store.send(text, atoms)` (`tugdeck/src/lib/code-session-store.ts:349`) dispatches `{ type: "send", text, atoms }`. The reducer (`reducer.ts:260`):

```ts
return {
  state: { ...state, phase: "submitting", pendingUserMessage: { text, atoms, submitAt }, ... },
  effects: [{ kind: "send-frame", msg: { type: "user_message", text, attachments: [] } }],
};
```

Atoms ride the in-process snapshot but are stripped from the wire effect. The same `attachments: []` shows up at `reducer.ts:892` (queued-send flush) and on the `TurnEntry.userMessage.attachments` slot — which today aliases the atom list, but only because the field name and the slot semantics happen to coincide.

The CASE-A interrupt restore *does* preserve atoms (`reducer.ts:354`) so re-edit-after-cancel keeps the chips. That logic stays correct under any plan we adopt — atoms continue to live on `pendingUserMessage` and `pendingDraftRestore`.

### 3. The wire shape from tugdeck's perspective

`tugdeck/src/protocol.ts:248`:

```ts
type InboundMessage = { type: "user_message"; text: string; attachments: unknown[] } | …
```

`encodeCodeInputPayload` JSON-stringifies and prepends `tug_session_id`. The `unknown[]` is an honest deferral — the browser side has never had to commit to an attachment shape because nothing has flown.

### 4. The wire shape from tugcode's perspective

`tugcode/src/types.ts:4`:

```ts
interface Attachment { filename: string; content: string; media_type: string; }
interface UserMessage { type: "user_message"; text: string; attachments: Attachment[]; }
```

`session.ts:276-322` — `buildContentBlocks(text, attachments)` is the converter:

- Image media types (`image/png`, `image/jpeg`, `image/gif`, `image/webp`) become `{ type: "image", source: { type: "base64", media_type, data } }`.
- 5 MB decoded ceiling, PNG/JPEG/GIF/WebP allowlist (constants at `session.ts:49`).
- Anything else gets emitted as a `text` block carrying `att.content` literally — i.e., the bytes are presumed to already be UTF-8 text. There is no PDF, no `document` block, no path resolution.

`session.ts:2789-2799` writes the resulting blocks straight to Claude Code's stdin as:

```json
{
  "type": "user",
  "session_id": "",
  "message": { "role": "user", "content": <blocks> },
  "parent_tool_use_id": null
}
```

That envelope matches the Agent SDK's documented stream-json shape ([streaming-vs-single-mode docs](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)).

### 5. JSONL replay (read-back)

`tugcode/src/replay.ts:432-528` walks `user` JSONL entries and rebuilds `Attachment[]`:

```ts
if (blockType === "image") {
  attachments.push({ filename: "", content: source.data, media_type: source.media_type ?? "image/png" });
}
```

Other block types (`text`, `tool_result`) are handled. **PDFs, plain-text documents, file references — none are decoded.** An unknown block kind fires `telemetry.unknownShape`.

Replay then emits `user_message_replay` carrying the decoded attachments back through the wire. The reducer treats it as a synthetic send (`reducer.ts:1511-1520`).

### 6. tugcast supervisor + journal

`tugrust/crates/tugcast/src/session_ledger.rs:287-293` already declares the journal:

```sql
CREATE TABLE turns (
  journal_id        TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  user_text         TEXT NOT NULL,
  user_attachments  BLOB NOT NULL,
  created_at        INTEGER NOT NULL
);
```

`agent_supervisor.rs:423` and `:670` — `insert_pending_turn(user_text, user_attachments: &[serde_json::Value], …)` is wired into the CODE_INPUT intercept and serializes `user_attachments` as a JSON BLOB. Today the slice is empty because tugdeck never populates it; the moment we start sending attachments, journaling is already done.

### 7. Transcript rendering

`tugdeck/src/components/tugways/cards/tide-card-transcript.tsx:312`:

```ts
const rawText = row.turn?.userMessage.text ?? row.inflight?.text ?? "";
```

The user-row body is a single `<span>{text}</span>`. The file-level header explicitly notes (`:9`):

> "v1 user bodies are plain text; atom-aware rendering lands once the prompt-entry's atom flow reaches transcript form."

That step is exactly what this plan does.

---

## Anthropic content-block reference

These are the targets we need to hit. Sources: [Vision docs](https://platform.claude.com/docs/en/build-with-claude/vision), [PDF support docs](https://platform.claude.com/docs/en/build-with-claude/pdf-support), [Files API docs](https://platform.claude.com/docs/en/build-with-claude/files).

### Image

```json
{ "type": "image", "source": { "type": "base64",  "media_type": "image/png", "data": "<b64>" } }
{ "type": "image", "source": { "type": "url",     "url": "https://…" } }
{ "type": "image", "source": { "type": "file",    "file_id": "file_…" } }
```

- Media types: `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
- Up to 100 images / 200k-context request, 600 / smaller models. Per-request payload 32 MB.
- Max dimensions 8000×8000 px (down to 2000×2000 above 20 images).
- Opus 4.7 long-edge resolution: 2576 px (was 1568 px).

### Document (PDFs and other "document"-class files)

```json
{ "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": "<b64>" } }
{ "type": "document", "source": { "type": "url",     "url": "https://…" } }
{ "type": "document", "source": { "type": "file",    "file_id": "file_…" } }
```

- Up to 600 pages (100 for 200k-context models). 32 MB request ceiling.
- Optional `title`, `context`, `citations` fields.
- Files API uploads gated behind `anthropic-beta: files-api-2025-04-14`.

### Text

```json
{ "type": "text", "text": "…" }
```

This is the catch-all for plain-text documents (`.md`, `.ts`, `.csv`, etc.). Concatenating multiple text blocks in a single user message is allowed and is how we fan out N file attachments without paying the document-block toll.

### Stream-json envelope (Claude Code stdin)

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      { "type": "text", "text": "Review this diagram" },
      { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "…" } }
    ]
  }
}
```

Matches what `tugcode/src/session.ts:2791` already writes; we don't need to invent envelope semantics.

---

## Design

### Single source of truth: the `Attachment` wire type

We extend the cross-process `Attachment` shape into a discriminated union so the browser can hand tugcode either bytes-it-already-has or a path-tugcode-must-read.

```ts
// tugdeck/src/protocol.ts and tugcode/src/types.ts (sync these by hand)

type AttachmentRole = "auto" | "image" | "document" | "text";

type Attachment =
  | {
      kind: "inline";
      role: AttachmentRole;     // hint; tugcode honors media_type below for actual block type
      filename: string;          // user-visible label, also used for content-disposition guesses
      media_type: string;        // RFC 6838 type; "image/png", "application/pdf", "text/plain", …
      content: string;           // base64 for binary, raw text for text/*
    }
  | {
      kind: "ref";
      role: AttachmentRole;
      filename: string;          // last path component for display
      path: string;              // workspace-relative; resolved by tugcode against its cwd
      media_type?: string;       // optional pre-classification; tugcode may override after sniff
    };
```

Backwards compat: today's tugcode reads `{ filename, content, media_type }`. We add `kind` as an optional discriminator with default `"inline"` and a one-line shim in `buildContentBlocks` so old fixtures parse.

`role` lets the browser express **intent** ("treat this as an image") independent of MIME ("image/png"). Useful for screenshot pastes where the OS may report `image/tiff` but the model sees fine with auto-conversion to PNG. tugcode honors `media_type` for actual block selection; `role` is advisory.

### Atom → Attachment, on the browser side

The translation lives in a new `tugdeck/src/lib/atom-attachment-resolver.ts` invoked by `code-session-store.send`. The resolver runs **synchronously when possible** so submit isn't blocked by IO:

| Atom type   | `value` | Branch | Output |
|-------------|---------|--------|--------|
| `image`     | data-URL or blob handle the editor stashed at insert time | inline | base64 image attachment |
| `image`     | project-relative path | ref | image attachment, kind=ref |
| `file`      | project-relative path, ext ∈ image set | ref, role=image | image attachment, kind=ref |
| `file`      | project-relative path, ext ∈ pdf | ref, role=document | document attachment, kind=ref |
| `file`      | project-relative path, ext ∈ text/code | ref, role=text | text attachment, kind=ref |
| `doc`       | project-relative path | ref, role=document | document attachment, kind=ref |
| `link`      | http(s) URL | inline-passthrough | image-or-document with `source.type: "url"` (server-side; see resolver) |
| `command`   | command name | drop | no attachment; the command stays in the text body |

Two open shapes the resolver depends on:

1. **Inline image bytes from paste/drop.** Today drop sets `value: filename`. We extend `dropHandler` (and add a paste handler in `clipboard-filters.ts`) to also call `file.arrayBuffer()` and stash a base64 data URL on a side-table keyed by atom identity. The atom's `value` becomes the same data URL — visible-but-opaque to the rest of the pipeline. State preservation already round-trips the value field, so re-mount restores the bytes for free.

2. **Workspace path resolution.** `@`-completion atoms already carry workspace-relative paths. They go on the wire as `kind: "ref"` and tugcode resolves them. No new tugcast verb needed.

### tugcode resolver: ref → bytes → content block

`tugcode/src/session.ts` gains a small resolver that runs **before** `buildContentBlocks`:

```ts
async function resolveAttachment(att: Attachment, cwd: string): Promise<InlineAttachment> {
  if (att.kind === "inline") return att;
  const abs = path.resolve(cwd, att.path);
  // Path containment check: refuse to read outside cwd.
  if (!abs.startsWith(cwd + path.sep) && abs !== cwd) {
    throw new Error(`Attachment path escapes workspace: ${att.path}`);
  }
  const stat = await Bun.file(abs).stat();
  if (stat.size > MAX_REF_SIZE) throw new Error(`Attachment too large: ${att.path}`);
  const mediaType = att.media_type ?? sniffMediaType(abs);
  const bytes = await Bun.file(abs).arrayBuffer();
  if (mediaType.startsWith("text/") || isCodeMediaType(mediaType)) {
    return { kind: "inline", role: "text", filename: att.filename,
             media_type: mediaType, content: new TextDecoder().decode(bytes) };
  }
  return { kind: "inline", role: att.role, filename: att.filename,
           media_type: mediaType, content: bufferToBase64(bytes) };
}
```

Two safety properties:

- **Workspace containment.** A ref must resolve inside the supervisor-canonicalized `cwd`. Symlinks resolve too; the comparison is post-`realpath`. This prevents `@../../etc/passwd` from reading host files.
- **Size ceiling.** Default 5 MB inherited from images; documents get up to 32 MB to match the API request limit but the per-request budget is tracked across all attachments and a single submission caps at 28 MB to leave headroom for the text body and tool definitions.

`buildContentBlocks` extends to handle `application/pdf` (→ `document` block) and any `text/*` or known code MIME (→ `text` block). The image branch stays unchanged.

### Wire envelope in `code-session-store`

`reducer.ts` `handleSend` builds the effect from `event.atoms`:

```ts
{
  kind: "send-frame",
  msg: {
    type: "user_message",
    text: event.text,
    attachments: atomsToAttachments(event.atoms, atomBytesIndex.current),
  },
}
```

`atomsToAttachments` is pure given the `event.atoms` list and the per-store inline-bytes side-table. The side-table is populated synchronously by drop/paste extensions before the atom is committed to the doc, so submit has everything it needs without an async hop.

The same translation runs at queued-send flush time (`reducer.ts:892`) so deferred submissions carry their attachments too.

### TurnEntry shape change

`TurnEntry.userMessage.attachments` today is `ReadonlyArray<unknown>` and is implicitly the atom list. We tighten it to `ReadonlyArray<AttachmentRecord>` where:

```ts
type AttachmentRecord = {
  role: AttachmentRole;
  filename: string;
  media_type: string;
  // Display affordances:
  thumbnailDataUrl: string | null;     // small inline preview for images
  byteSize: number | null;             // for "12 KB" style label
  // Source-of-truth back-link for "open in finder":
  refPath: string | null;              // null when inline-only (paste/drop)
};
```

**No raw bytes live on the snapshot.** Image thumbnails are pre-baked at submit time (256 px max edge) so the transcript can render them without holding the full payload in React state. This matters for memory: a 5 MB PNG ×100 turns = 500 MB on the snapshot otherwise.

The full bytes for inline attachments live in the tugcast journal for replay and on the JSONL via Claude's own write path; tugdeck never re-loads them.

### Persistence

Three storage tiers, in order of what the user sees first after a cold reload:

| Tier | Lifetime | What's stored |
|------|----------|---------------|
| **In-memory snapshot** | Mount → unmount | `AttachmentRecord` (thumbnails + metadata, no full bytes) |
| **Component state preservation** | Across HMR / pane restore | `AttachmentRecord` for the in-flight pre-submit prompt only — same bag as `pendingDraftRestore` |
| **tugcast `turns` journal** | Until claude acks the turn | Full inline bytes as JSON BLOB; refs as path strings |
| **JSONL** | Forever (until user `forget`s) | What claude itself wrote — image content blocks for inline, `Read` tool inputs for refs claude chose to load |

Note refs that claude *didn't* read are not in JSONL. To round-trip them on replay we read the journal too — and tugcode already does that during Step 5.6 of the mid-turn-replay plan (`session.ts:2189` reads `turns` rows). The journal is the resume-time source of truth; JSONL is the historical truth.

### JSONL replay enhancements

`tugcode/src/replay.ts` already decodes `image` blocks. We add:

- `document` block decoding → `Attachment { kind: "inline", role: "document", media_type: "application/pdf", … }`. The PDF data round-trips as base64 and the transcript renders a generic doc chip with byte-size + filename hint.
- `text`-block-following-an-`@path`-mention: today, claude's `Read`-tool path makes the file contents land in a `tool_result` rather than the user message. That's fine — we surface them via the existing tool-call rendering, not the attachment bar. No work needed here unless we decide to inline ref bodies, which we don't.
- A minor change: when the journal carries refs but the JSONL never showed them (claude never expanded), the `user_message_replay` carries the refs verbatim and the transcript renders them as un-expanded chips. This is a mode bit on `AttachmentRecord` (`expanded: boolean`).

### Transcript rendering — `TugListView`

`tide-card-transcript.tsx` `UserRowCell` evolves from a single `<span>` to a small composition:

```
┌─────────────────────────────────────────────────────────┐
│ You · 14:32                                             │
│ Review this architecture diagram and the proposal PDF.  │
│ ┌──────────┐ ┌──────────────────┐                       │
│ │ [thumb]  │ │ proposal.pdf     │                       │
│ │ diagram  │ │ 312 KB · doc     │                       │
│ │   .png   │ │                  │                       │
│ └──────────┘ └──────────────────┘                       │
└─────────────────────────────────────────────────────────┘
```

A new `tug-attachment-strip.tsx` component owns the chip row. It renders:

- **Image attachments** as a `<img src={thumbnailDataUrl} />` inside a fixed-aspect tile. Click opens a lightbox sourced from the tugcast journal (or from the editor's inline-bytes side-table if still mounted).
- **Document attachments** as a doc-icon chip with filename + byte-size + page-count when known.
- **Text attachments** as a code-icon chip with filename + byte count + first-line preview.
- **Ref-only attachments** (claude never expanded) get a dimmed treatment so the eye can tell "claude saw this path" from "claude read this content".

The strip lives **inside** the user-row body, above the text, so the visual order matches the model's content-block order (Anthropic recommends placing media before text for best results — [Vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)).

`TugListView`'s row-height accounting needs the strip's height summed with the body. We measure on the same `useLayoutEffect` cycle that the body uses. If the row's content overflows, the strip stays sticky-visible at the top so attachments don't scroll out of frame on long rows.

### Editor-side rendering of inline images

A bonus side effect of having bytes on the atom: the atom widget can render a small thumbnail for image atoms instead of the generic image-icon SVG. This is in `tug-atom-img.ts`'s `createAtomImgElement` — when `type === "image"` and the side-table has a data URL, we use it as the `<img src>` directly, sized to the existing chip dimensions. Pre-existing CM6 rendering path, no new substrate work.

### Failure modes and surfacing

| Failure | Where | Surface |
|---------|-------|---------|
| Ref points outside workspace | tugcode resolver | `error` event → `lastError` banner; turn never sent |
| Ref file missing | tugcode resolver | same |
| Ref file too large | tugcode resolver | same, with size in message |
| Image media type unsupported | tugcode `buildContentBlocks` | same; existing PN-12 path |
| Total payload > 28 MB cap | tugcode resolver (running tally) | same; user pares list |
| Inline base64 data corrupt | Anthropic API | `api_retry` then surface as turn error |

All of these block the submit rather than silently dropping the attachment. Empty attachments are not the same as missing attachments.

---

## What previous work tells us

Before committing to a design we should be honest about how much of this question has *already been answered empirically*. The transport-exploration journal, the WS verification report, the stream-json catalog, the capabilities snapshot pipeline, and the existing real-claude probes are not background — they're the substrate this proposal builds on.

### The transport path is verified ready

`dash/ws-verification.md` records the four issues that previously blocked UI work on this surface (T8 `session_init` race, T9 double-snapshot delivery, T10 agent-bridge channel encapsulation, T11 session-id move into tugbank). All four were resolved in commit `e0174373`. The conclusion in that document is explicit: "The WebSocket path is fully verified and ready for UI development." That means we are not gambling that any layer below `code-session-store` will move under us — the framing layer, the supervisor's session-bound feed routing, and the snapshot-feed delivery for late-mounting cards are all live.

For this proposal that translates to: a tide-card mounting after a submit-with-attachments still happened will see the in-flight turn re-rendered correctly via the existing `code_watch_tx` snapshot path, including its `Attachment[]` payload. We don't need to invent a separate "attachment broadcast." Existing transport machinery covers it.

### The image content-block path is empirically known to work

`tugrust/crates/tugcast/tests/common/probes.rs:645` defines `test-23-image-attachment` — an inbound `user_message` carrying a 1×1 PNG via `UserMessageWithAttachments` with `{ filename: "test-pixel.png", content: <b64>, media_type: "image/png" }`. The probe ran clean against `claude 2.1.104`, `2.1.105`, and `2.1.112` and produced reproducible JSONL fixtures at `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v<version>/test-23-image-attachment.jsonl`. Every fixture shows `system_metadata → thinking_text → assistant_text (partials) → cost_update → assistant_text (complete) → turn_complete`, with claude correctly seeing the image and describing it. **The image happy-path is not a hypothesis; it's a regression-tracked fact.**

`dash/transport-exploration.md` §"Test 23" documents the same finding in human-readable form, including the empirical media-type allowlist (`image/png`, `image/jpeg`, `image/gif`, `image/webp`) and the ~5 MB decoded ceiling. Those constants in `tugcode/src/session.ts:49` are not arbitrary — they're calibrated against what was observed to work.

### `@`-mentions are not a transport feature

`test-24-at-file-references` and §"Test 24" together establish a non-obvious load-bearing fact: when you submit `"What's in @CLAUDE.md?"` via `user_message`, the literal text reaches Claude **as text**. No file injection. The terminal's familiar `@`-completion behavior is implemented at the terminal layer; in headless `stream-json` mode, `@` is just an ASCII byte. Claude can answer the question only because `CLAUDE.md` happens to live in its session context (loaded as instructions).

This is decisive for our design. Two ways to make `@`-atoms work:

- **(A)** Resolve in tugdeck before submit: the browser asks for file bytes via a new `FILETREE_READ` verb, base64s them, ships them as inline attachments. Heavy lift on the protocol; needs payload-size flow control over the WebSocket; needs the supervisor to sandbox file reads.
- **(B)** Resolve in tugcode at submit time: the browser ships a `kind: "ref"` with a workspace-relative path, tugcode reads from disk inside its own `cwd`, builds the right content block. Already runs locally; already has the workspace path; already has Bun.file().

This proposal picks (B). The supervisor already canonicalizes `cwd` and writes it into `system_metadata` (visible in every catalog fixture as `"cwd":"{{cwd}}/Mounts/u/src/tugtool"`); tugcode running there is the natural resolver. (A) becomes attractive only if we ever need to attach files from outside the workspace, which is also the case for image paste/drop — and that case is handled by `kind: "inline"`, where the browser DOES have bytes.

### The capture pipeline is the test harness

`just capture-capabilities` (defined at `Justfile:48`) runs the full 35-probe table against the local `claude` binary, normalizes UUIDs/timestamps/costs/paths, writes JSONL fixtures into `stream-json-catalog/v<version>/`, derives a `schema.json`, extracts the `system_metadata` payload into `capabilities/<version>/`, updates `capabilities/LATEST`, runs the drift regression, and (if classification stays Benign-or-better) offers an atomic version-bump commit. Total runtime: ~2-3 min for the default `TUG_STABILITY=1` and ~5-6 min for `TUG_STABILITY=3`.

The drift regression at `tugrust/crates/tugcast/tests/stream_json_catalog_drift.rs` is the long-term safety net. When Anthropic ships a new `claude` and any of our content-block shapes drifts (a new `source.type`, a renamed field, an event reordering), the next `capture-capabilities` flags it and refuses to land until we classify the change. Our attachment work *should ride this rail*, not invent a parallel one.

### What the catalog does NOT capture

A blind spot that matters for this proposal: the catalog records what claude *emits* (claude → tugcode → tugcast → JSONL fixture). It does **not** record what tugcode *writes to claude's stdin* (the stream-json content blocks). So the round-trip currently has only one side instrumented. Two consequences:

1. We can verify "Claude receives an image and produces a sensible response," but we cannot regression-test "tugcode produced exactly *this* `image` block with exactly *this* base64 length and exactly *this* media_type." A typo in `buildContentBlocks` (e.g., emitting `"type": "Image"` instead of `"type": "image"`) would silently fail and we'd notice only when claude returned an error event downstream.
2. New attachment shapes (`document` blocks, `text` blocks for ref'd source files) need a way to pin the inbound shape, separate from the outbound observation. **Adding inbound capture to the probe driver is the right scope for this proposal.**

### What we already know about specific failures

The transport-exploration log has done part of the work for us:

- §"Test 14" — sending a second `user_message` mid-turn does NOT interrupt; it queues. So our reducer's `queuedSends` flush at `reducer.ts:892` is the right place to translate atoms-to-attachments for the *queued* submission, not just the immediate one. (The current proposal handles this; calling it out so it stays unchanged.)
- §"Test 6" — interrupt during streaming produces `turn_complete{result:"error"}`, no `turn_cancelled`. Combined with our CASE-A interrupt path that preserves atoms onto `pendingDraftRestore`, attachment bytes need to survive the interrupt. The byte side-table from Step 2 below has to either (a) ride state-preservation alongside `pendingDraftRestore.atoms`, or (b) be reachable by atom-id from the restored draft. Step 2 picks (a).
- §"Inbound Message Types" table at line 459 already documents `user_message` as carrying `attachments[]` — the slot is part of the publicly catalogued protocol, not an extension we're inventing.

## Probes to add as part of this work

The probe table at `tugrust/crates/tugcast/tests/common/probes.rs` already has the `Attachment` struct and the `UserMessageWithAttachments` variant. Adding probes is a constant-cost extension. Each new probe runs once per `capture-capabilities` invocation, produces a frozen JSONL fixture, and is automatically watched by the drift regression across versions.

| New probe | Input | Required events | What it pins |
|-----------|-------|-----------------|--------------|
| `test-36-jpeg-attachment` | 32×32 JPEG, `image/jpeg`, 4 KB | `assistant_text`, `cost_update`, `turn_complete` | Media-type breadth beyond PNG; verifies the JPEG branch of `buildContentBlocks` |
| `test-37-pdf-attachment` | 1-page synthetic PDF, `application/pdf`, ~5 KB | `assistant_text`, `cost_update`, `turn_complete` | New `document` content-block path; baselines page-count token cost |
| `test-38-text-attachment` | Plain `.md` payload, `text/plain` | `assistant_text`, `cost_update`, `turn_complete` | Verifies our `text/*` → `text` block rebranching against claude's behavior |
| `test-39-multi-attachment` | One JPEG + one PDF + 200-char text body | `assistant_text`, `cost_update`, `turn_complete` | Multi-block ordering; surfaces if claude re-orders content |
| `test-40-ref-resolution` | `kind: "ref"` for a workspace `.md` (probe writes the file first) | `assistant_text`, `cost_update`, `turn_complete` | Our resolver's path-containment + sniff path; baselines that claude treats inlined ref'd text identically to a typed `text` block |
| `test-41-image-too-large` | 6 MB PNG | `error` (recoverable) | Negative-path: tugcode rejects oversize per PN-12 with a clean error event |
| `test-42-image-bad-mime` | PNG bytes mislabeled as `image/tiff` | `error` (recoverable) | Negative-path: tugcode's media-type allowlist holds |

For 36–40, the existing fixture format applies verbatim. For 41–42, we need the probe driver to recognize "tugcode error before claude is reached" as a valid passing terminal — `Attachment` validation throws inside `buildContentBlocks` (`session.ts:290-301`) and tugcode's `handleUserMessage` catches it and writes an `error` event. Today the probe table only knows how to assert "all required events seen and turn_complete arrives"; we'd extend `ProbeStatus` with an `ErrorExpected(reason)` shape, or add a `required_error: Option<&str>` field on `ProbeRecord`. Small change.

## Bidirectional capture: pinning what we send to claude

To test `buildContentBlocks` empirically rather than by inspection, the capture binary should also snapshot the JSON tugcode wrote to claude's stdin. Mechanically: `session.ts:2791` already JSON-stringifies the envelope; if `process.env.TUG_CAPTURE_INBOUND_LOG` is set, mirror that line into a file alongside the fixture. The drift regression learns to compare the inbound log too. Exact same normalization rules (`{{uuid}}`, `{{cwd}}`, `{{text:len=N}}`) — they were designed to handle stream-json shapes regardless of direction.

The output is one extra file per probe: `test-23-image-attachment.inbound.jsonl` carrying a single line:

```json
{"type":"user","session_id":"","message":{"role":"user","content":[
  {"type":"text","text":"{{text:len=63}}"},
  {"type":"image","source":{"type":"base64","media_type":"image/png","data":"{{text:len=120}}"}}
]},"parent_tool_use_id":null}
```

That fixture would have caught (and will catch) any regression in the four-line block-build path. It's also self-documenting: a reader of the fixtures tree learns the inbound shape by inspection.

## Pre-design checks the existing infrastructure already lets us run

Before committing to the design above, we can answer four questions empirically with one capture run:

1. **Does claude tolerate a `text` block carrying a ref'd file followed by the user's text?** Add a probe sending `[{type:text,text:<file contents>},{type:text,text:<question>}]`. Compare token cost against the same content concatenated into a single block.
2. **Does claude downsample large images at the API layer, or do we need to?** Send a 4096×4096 PNG (within current 5 MB limit by careful encoding) and observe `cost_update.usage.input_tokens`. If the input tokens grow super-linearly with edge length, we know to downsample at submit time.
3. **Does the API accept `source.type: "url"` for `https://` images we'd pass through from `link` atoms?** Add `test-43-image-url-source` with a public `https://` PNG and observe whether claude fetches it. If yes, link atoms get a free pass-through path.
4. **What does `application/pdf` look like in the JSONL on the way back?** Run `test-37-pdf-attachment` once, look at the JSONL, see whether claude writes `{type:"document"}` (with the same source shape) or only the extracted text. The replay translator's new `document` branch (Step 6 of the original step list) is informed by this.

These are research probes, not regression probes — they exist to *answer* questions, then either become permanent baselines or get retired when the answer is in the document.

## How this slots into the existing roadmap rituals

- **`just capture-capabilities` runs cleanly today.** Adding probes 36-42 is purely additive. The runbook (capture → diff → classify → commit) is unchanged.
- **`capabilities/LATEST` and the system-metadata snapshot** don't change — the new probes don't alter the `system_metadata` event.
- **`stream_json_catalog_drift_regression`** automatically picks up the new probes once they ship. We get drift-tracking for our content-block surface for free.
- **`session-metadata-feed.md`'s** snapshot pattern is the right shape for the "in-flight turn includes attachments" surface — `code_watch_tx` already covers it; no parallel feed needed.
- **`dash/transport-exploration.md`** gets new sub-sections for tests 36-42, written in the same prose style as Test 23, including the empirical findings (cost numbers, error classifications, accepted media types). The README's drift-banner discipline applies: fixtures win, prose follows.

## Step list

1. **Wire shape evolution.**
   - `tugdeck/src/protocol.ts:248` — type the `attachments` slot, drop the `unknown[]`.
   - `tugcode/src/types.ts:4` — replace single-shape `Attachment` with the discriminated union; backwards-compat shim defaulting `kind: "inline"`.
   - Round-trip protocol-fixture tests under `tugcode/src/__tests__/types.test.ts`.

2. **Browser side-table for inline bytes.**
   - New `tugdeck/src/lib/atom-bytes-store.ts` — a tiny per-tide-card map keyed by a stable atom identity (mint a UUID at insert time, stash on `AtomSegment` as a new optional `id` field).
   - `drop-extension.ts` calls `file.arrayBuffer()` on each drop, base64-encodes, stores in the side table, returns atoms with `id` set.
   - `clipboard-filters.ts` paste handler — read `image/*` clipboard items, base64-encode, insert as `image` atom + side-table entry. Falls through for non-image clipboard items.
   - `useCardStatePreservation` snapshot includes the side-table (already JSON-serializable since base64).

3. **Resolver + reducer wiring.**
   - New `tugdeck/src/lib/atom-attachment-resolver.ts`. Pure function, easy to unit test.
   - `code-session-store.ts` plumbs the per-store `atomBytesStore` ref into the reducer's effect builder. Cleanest path: an extra arg on `reducer.ts:handleSend` carrying a `attachmentResolver` thunk; the store closure binds it.
   - `reducer.ts:handleSend` and the queued-send flush at `:892` switch from `attachments: []` to `attachments: resolveAtoms(event.atoms)`.

4. **TurnEntry.attachments tightening.**
   - `code-session-store/types.ts:81` — replace `ReadonlyArray<unknown>` with `ReadonlyArray<AttachmentRecord>`.
   - Reducer commit at `reducer.ts:820` writes `AttachmentRecord`s — runs the thumbnail bake here for images.
   - Update tests under `code-session-store/__tests__/` that pin `attachments: []`.

5. **tugcode resolver + content-block extension.**
   - `tugcode/src/session.ts` adds `resolveAttachment` ahead of `buildContentBlocks`.
   - `buildContentBlocks` learns `application/pdf` → `document` block and `text/*` → `text` block.
   - Tests under `tugcode/src/__tests__/` cover the path-containment check, the size cap, and the MIME sniffing.

6. **JSONL replay extensions.**
   - `tugcode/src/replay.ts:478` — add `document` branch alongside `image`. Carry `media_type` + base64 `data` through to `Attachment`.
   - `user_message_replay` already carries `Attachment[]`; reducer-side decoding lands on `AttachmentRecord` via the same path Step 4 introduces.

7. **Transcript rendering.**
   - New `tugdeck/src/components/tugways/cards/tug-attachment-strip.tsx` + CSS.
   - `tide-card-transcript.tsx:UserRowCell` renders the strip above the body when `attachments.length > 0`.
   - Lightbox component for image preview — reuse `TugSheet` chrome.
   - `TugListView` row-height contract: extend the cell's measure callback to sum strip + body heights.

8. **Editor atom thumbnails (optional but cheap).**
   - `tug-atom-img.ts` reads from the bytes side-table when rendering an `image` atom; falls back to the generic SVG when no bytes are known (e.g., a ref atom that never had inline bytes).

9. **Probe-table extensions (do this BEFORE step 5).**
   - `tugrust/crates/tugcast/tests/common/probes.rs` — add probes 36-42 from the table above.
   - `ProbeRecord` gets an optional `required_error: Option<&'static str>` for the negative-path probes 41 / 42.
   - Run `just capture-capabilities` against the current claude version, commit `v<version>/test-3{6..9}-*.jsonl` as the new baseline. The probes that pin behavior we haven't built yet (37/38/40) will fail at first and are deliberately committed as `Failed(...)` in the manifest until step 5 lands; `stream_json_catalog_drift_regression` allows that during a feature-development bracket per the README's `Failed`-status taxonomy.

10. **Bidirectional capture (small but high-leverage).**
   - `tugcode/src/session.ts:2791` — when `TUG_CAPTURE_INBOUND_LOG=<path>` is set, mirror the stream-json envelope to that file with the same `\n`-terminated convention.
   - `tugrust/crates/tugcast/tests/capture_stream_json_catalog.rs` — point each probe at a unique inbound-log path; copy + normalize the captured line into `<probe>.inbound.jsonl` next to the existing fixture.
   - `stream_json_catalog_drift.rs` — diff the new `.inbound.jsonl` files alongside the outbound ones. Same placeholder vocabulary; same Benign/Semantic/Ambiguous classification.

11. **End-to-end integration test.**
   - A `just app-test` recipe that drops a PNG, mentions a workspace `@README.md`, submits, asserts:
     (a) the wire frame carries two `Attachment`s with the right shapes;
     (b) tugcode emits two correct content blocks to claude's stdin (verified against the bidirectional fixture from step 10);
     (c) the transcript renders a thumbnail + a doc chip;
     (d) cold-restart of the card replays both correctly from JSONL + journal.

---

## Open questions

- **Files API uploads.** For repeated-attachment scenarios (the same logo across 20 turns), the Anthropic Files API + `file_id` source is the right tool. Out of scope for v1; add a third `kind: "file_id"` to the `Attachment` union when we wire it. The shape is forward-compatible.
- **Copy-paste with HTML envelope.** The substrate's existing atom-sidecar HTML envelope (`clipboard-filters.ts`) round-trips atom *identities* but not bytes. Crossing a copy-paste boundary today would deliver an atom with `value: <data URL>` to the destination editor — that may be larger than the clipboard wants to handle. Defer until we have a concrete cross-card-paste use case.
- **Direct claude `Read` vs. inline text-attachment.** When a user `@`-mentions a 200-line source file, we have a choice: inline its contents as a `text` block (claude sees it for free), or leave it as a path mention and let claude `Read` it on demand (saves tokens if claude doesn't need it). The proposal picks **inline** for `text/*` refs because that matches what users expect "@-attaching" to mean (and matches what Claude Code itself does with `@` mentions). We can revisit on token-cost data.
- **Image dimensions / downsampling.** Anthropic charges by tile count and Opus 4.7 maxes at 2576 px on the long edge. We should downscale large images at submit time (in tugcode, after resolve, before block build) — easy with `sharp` or a tiny canvas-based downscaler. Track separately.
- **Permission model.** A ref atom resolves *as the supervisor's user*. If a workspace contains a `.env` and the user `@`-mentions it, we will ship its contents to claude. That's the same permission model as Claude Code itself (which would happily `Read` the file), but worth surfacing in a confirmation step before the first send-with-attachments per session. Alternatively, a workspace-level `.tugattachignore` mirroring `.gitignore`.
- **CASE-A interrupt with attachments.** The restore slot already carries atoms; with the side-table changes in Step 2 the bytes survive too (state preservation snapshot includes the side-table). Verify with a probe that drops an image, hits Stop before the first delta, and confirms the chip + thumbnail return to the editor.

---

## Sources

- [Vision — Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/vision) — image content block shapes, size and dimension limits, max counts.
- [PDF support — Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/pdf-support) — document content block shapes, page/size limits.
- [Files API — Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/files) — `file_id` source type, beta header.
- [Streaming Input — Agent SDK](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) — exact NDJSON envelope for stream-json input mode (`{ type: "user", message: { role, content } }`).
- [Run Claude Code programmatically (headless)](https://code.claude.com/docs/en/headless) — `--input-format stream-json` and the 10 MB stdin cap.
- [Issue #24594 — undocumented stream-json input](https://github.com/anthropics/claude-code/issues/24594) — community context on the gap that the Agent SDK docs above subsequently filled.
