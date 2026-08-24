# Tide Assistant Rendering — Content & Data Type Renderers

*Design proposal. Sibling to [tide.md §Phase T1 — Content Block Types](./tide.md#content-block-types) and the styling pass deferred at [tugplan-tide-card-polish.md §Step 12](./tugplan-tide-card-polish.md#step-12) / §Step 13. Not yet a tugplan; promote to one once the design is ratified.*

**Status:** Pending review — 2026-05-08.
**Author:** captured in conversation; ratify before promoting to a step-numbered plan.

---

## 1. Purpose

Define how Tide renders every content and data type that arrives from a Claude Code session — and a few we synthesize ourselves — so that the assistant surface is *materially* better than what a TUI can show. The terminal rendering bar is "ANSI escapes + monospace + nothing else." Tug's bar is: typography that reads like a publication, content-aware renderers per data shape, and progressive disclosure for long content (collapse/expand for diffs, file viewers, agent transcripts, etc.).

This proposal:

1. Inventories every content and data type we currently receive (or could synthesize) on the assistant side.
2. Lays out a two-layer rendering architecture — reusable **body kinds** + thin **per-tool wrappers** — that lets every Claude tool look hand-crafted without 14 redundant copies of the same diff renderer.
3. Picks libraries and parsers (WASM where the speed/correctness win is real; JS where it isn't).
4. Sequences the work so we can land a great-looking baseline early, then promote individual tools to bespoke treatment as design needs surface.

It does **not** redesign the Phase T1 stub in `tide.md`; it elaborates it. Phase T1's "GFM markdown / TugCodeBlock / thinking / tool use / monospace" line items are the start of the catalog, not the catalog itself.

---

## 2. Where we are today

### 2.1 What renders right now

- **Markdown body via the WASM pipeline.** `tugmark-wasm` (pulldown-cmark compiled to WASM) lexes markdown into packed binary block metadata, then re-parses each block to HTML. `parseMarkdownToSanitizedBlocks` runs each block through DOMPurify under a strict allowlist. `TugMarkdownView` consumes this stream with virtualization (`BlockHeightIndex`, `RenderedBlockWindow`); `TugMarkdownBlock` is the natural-flow sibling for bounded-content cells. Both are streaming-aware via `PropertyStore.observe`.
- **Code blocks inside markdown.** Shiki provides VS Code-grade syntax highlighting via the legacy `enhanceCodeBlocks` path. Lazy language loading. `--tugx-md-*` token surface for typography.
- **Tide card transcript.** `TideTranscriptDataSource` feeds `TugListView` with `(user, code)` row pairs. The `code` row body slots in `TugMarkdownView`/`TugMarkdownBlock` for assistant text.
- **Streaming.** `assistant_text` deltas are accumulated in `CodeSessionStore.streamingPaths.assistant`, observed by `TugMarkdownBlock`, rendered with rAF-coalesced incremental updates.

### 2.2 What's missing (the work this proposal frames)

- **Typography is unstyled.** Default `--tugx-md-*` tokens are still placeholders. `tugplan-tide-card-polish.md §Step 12` is the dedicated styling pass, currently pending.
- **Thinking blocks are unwired.** `streamingPaths.thinking` exists but no UI consumes it.
- **Tool surfaces are unwired.** `streamingPaths.tools` exists. `tool_use` / `tool_result` / `tool_use_structured` arrive but go to `JSON.stringify`-equivalent placeholder rendering (or nothing).
- **No content-aware rendering.** A `tool_result` with structured `file` data is rendered as raw text, not as a file viewer. A `tool_use_structured` for Bash with stdout/stderr split is collapsed back into a single text blob. Edits arrive as `{ old_string, new_string }` and never become a diff. Graphs and math are rendered as fenced code blocks, not diagrams or typeset math.
- **Cost chrome and session metadata are not visualized.** `cost_update` carries per-model token counts; we discard them.
- **Permission and AskUserQuestion dialogs are unbuilt.**
- **No collapse/expand on long content.** A 2000-line diff dominates the transcript.

### 2.3 The data we have to work with

Stream-json events (from `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.105/`):

| Event | Use |
|-------|-----|
| `protocol_ack`, `session_init` | Session lifecycle chrome |
| `system_metadata` | Per-turn metadata: model, tools, plugins, agents, mcp_servers, version, permissionMode |
| `thinking_text` | Pre-response reasoning. Delta-streamed. |
| `assistant_text` | Response body. Delta-streamed; `complete` event has full text. |
| `tool_use` | Tool invocation. Input streams empty → full. |
| `tool_result` | Tool output as text + `is_error` flag. |
| `tool_use_structured` | Tool output as typed structured data (file viewer, bash stdout/stderr, agent transcript, etc.). |
| `control_request_forward` | Permission (`is_question: false`) or AskUserQuestion (`is_question: true`). |
| `cost_update` | Per-turn token + USD breakdown. |
| `turn_complete` | End-of-turn signal. |
| `error` | Error with `recoverable` flag. |

Each of these has a renderer in this proposal.

---

## 3. Design ambition

The rendering bar:

- **Typography reads like a designed document.** Heading scale, paragraph rhythm, list indentation, inline-code chrome, blockquote treatment — all explicitly designed against both `brio` and `harmony` themes. Text should pass the squint test against a high-quality web publication, not a terminal.
- **Every data type has a renderer that fits it.** A file is shown as a file. A diff is shown as a diff. A directory listing is a list with icons and metadata. A bash command is a terminal block with stdout/stderr separation, ANSI colors mapped to CSS, exit code badge. A subagent run is a transcript-within-a-transcript. JSON is a collapsible tree. Math is typeset. Diagrams are diagrams.
- **Progressive disclosure is the default for long content.** Diff blocks > 40 lines, file blocks > 200 lines, agent transcripts of any depth — all render collapsed by default with a one-line summary header and an expand affordance. The user opts in to detail.
- **Streaming feels alive but not jittery.** Deltas land with rAF coalescing; no fade-in/out churn on already-rendered content. New blocks appear at the bottom; existing blocks don't reflow when an unrelated upstream event arrives.
- **Every tool gets a polished renderer the day it lands.** Even unknown tools (a future Claude release; a new MCP server) render usefully via a default wrapper. We're never blank or ugly.
- **Theme tokens are the only customization surface.** No inline styles. Seven-slot naming convention per L19/L20. Both themes verified for every renderer.

---

## 4. Architecture — two-layer hybrid

### 4.1 The two layers

**Layer 1 — Body kinds (reusable rendering primitives).** ~10–14 components, each polished to a high bar, each owning a single content shape. These are where the heavy lifting lives.

**Layer 2 — Tool wrappers (thin per-tool composition).** One component per Claude tool. Each is small: tool-specific chrome (icon, name, args summary, timing/exit-code badges) + a body that's a Layer-1 component (or a small composition of them) + tool-specific interactions (re-run, jump-to-source, copy, approve).

Plus three orthogonal pieces:

- A **dispatch registry** that maps a stream event → renderer.
- A **block transformer pass** over markdown blocks that promotes special fenced code blocks (mermaid, latex, diff, json) to richer renderers.
- A **streaming binding** so any Layer-1 component can consume a `PropertyStore` path and update incrementally.

### 4.2 Mental model

```
┌─────────────────────────── stream-json events ───────────────────────────┐
│                                                                          │
│  thinking_text   assistant_text   tool_use   tool_result                 │
│  tool_use_structured   control_request_forward   cost_update             │
│                                                                          │
└────────┬─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────── CodeSessionStore reducer ─────────────────────────┐
│ Accumulates deltas; produces TurnEntry records:                          │
│   { kind, msg_id, seq, body | toolEvents, status, ... }                  │
└────────┬─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌────────────── Renderer dispatch registry (per TurnEntry kind) ───────────┐
│  user_text          → UserTurnRenderer                                   │
│  assistant_text     → AssistantTurnRenderer (markdown + transformers)    │
│  thinking           → ThinkingBlockRenderer                              │
│  tool_use[name]     → ToolWrapperRegistry[name] | DefaultToolWrapper     │
│  control_request    → PermissionRenderer | QuestionRenderer              │
│  cost_update        → CostBadge / CostChrome                             │
│  error              → ErrorBlock                                         │
└────────┬─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────── Layer 2 — Tool wrappers ──────────────────────┐
│  ReadToolBlock, WriteToolBlock, EditToolBlock, BashToolBlock,            │
│  GlobToolBlock, GrepToolBlock, TaskToolBlock, WebFetchToolBlock,         │
│  WebSearchToolBlock, TodoWriteToolBlock, NotebookEditToolBlock,          │
│  AgentToolBlock, MCP*ToolBlock, DefaultToolWrapper                       │
│                                                                          │
│  Each wrapper: chrome (header/footer/badges) + body ← Layer 1            │
└────────┬─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────── Layer 1 — Body kinds ─────────────────────────┐
│  MarkdownBlock     TerminalBlock      DiffBlock       FileBlock          │
│  PathListBlock     SearchResultBlock  JsonTreeBlock   TodoListBlock      │
│  AgentTranscriptBlock  ImageBlock     MermaidBlock    KaTeXBlock         │
│  TableBlock (rich)  PlainTextBlock                                       │
└──────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Why this answers "is per-tool overkill?"

Per-tool wrappers exist for every tool — exactly what "great rendering" demands. But the bulk of the rendering code is shared, so a wrapper is ~50 lines of decoration over composition. The rendering polish accumulates in body kinds, where it gets reused by every tool that needs that shape.

### 4.4 Three concrete upgrade levers

When a tool needs more bespoke treatment over time, the upgrade path is:

1. **Tune the wrapper.** Add a re-run button to `BashToolBlock`. Add a permalink to `ReadToolBlock`. No body-kind or sibling-tool changes.
2. **Swap the body.** `BashToolBlock` initially uses `<TerminalBlock>`. We later detect `git status --porcelain=v2` output and swap to `<GitStatusBlock>` (which Phase T2 in tide.md already plans for shell adapters — *the same body kind serves both halves*). One-line change in the wrapper.
3. **Specialize a body kind.** `EditToolBlock` initially uses generic `<DiffBlock>`. Notebook edits need cell-aware diffing → ship `<NotebookDiffBlock>` as a sibling primitive; `EditToolBlock` switches based on file extension. The generic `<DiffBlock>` is untouched.

A `toolRendererRegistry` keyed on `tool_name` makes lever-1 trivial. Lever-2 is internal to the wrapper. Lever-3 is the most invasive but localized. New Claude releases / new MCP tools fall back to `DefaultToolWrapper` until promoted.

---

## 5. Body-kind catalog (Layer 1)

Each body kind is a self-contained primitive. All consume tokens scoped to their own slot per L20; consumers tune via wrapping selectors, not by reaching in.

### 5.1 `MarkdownBlock` (existing — `TugMarkdownBlock` / `TugMarkdownView`)

The current WASM-backed renderer. Already handles streaming via `PropertyStore`. **Extensions for this proposal:**

- Block-transformer pass that runs after `parseMarkdownToSanitizedBlocks` and rewrites special fenced code blocks:
  - `lang === "mermaid"` → `MermaidBlock`
  - `lang === "math"` or `lang === "latex"` (display) → `KaTeXBlock` (display mode)
  - `lang === "diff"` → `DiffBlock` (read-only)
  - `lang === "json"` → optionally `JsonTreeBlock` for blocks > N tokens; otherwise stays as `CodeBlock`
- Inline-math support: detect `$...$` (inline) and `$$...$$` (display) in paragraph blocks, swap to KaTeX-rendered spans / blocks. Done as a post-DOMPurify text-node walk so the sanitizer sees only the markdown HTML.
- pulldown-cmark options to enable: `ENABLE_FOOTNOTES`, `ENABLE_SMART_PUNCTUATION` (typography upgrade).
- Collapse/expand support on the block container (any block over a height threshold gets a "show more" affordance — opt-in per consumer).

Streaming behavior is unchanged; the transformer pass and inline-math walk are pure functions over the parsed block list.

### 5.2 `TerminalBlock`

Renders stdout/stderr from `Bash` (and any future shell adapter) with ANSI SGR colors mapped to CSS. Visual model:

- Command line at top (already in the wrapper's chrome, but `TerminalBlock` itself can show a `$ ...` synopsis if used standalone).
- Body: monospace block, optional stdout/stderr column split, ANSI color/styling preserved.
- Footer: exit code badge (zero = subtle, non-zero = strong), wallclock duration, "interrupted" indicator if applicable.
- Long-output collapse: > 40 lines auto-collapse with "Show all 234 lines" affordance.
- Copy-to-clipboard button.

ANSI parsing strategy: see §7 — JS-side `ansi_up` is fine for most cases; a Rust `vtparse` WASM crate is justified only if we hit pathological inputs.

### 5.3 `DiffBlock`

Unified or split-view diff renderer. Inputs:

- A pair of `(beforeText, afterText)` (e.g., from `Edit` tool input) with a language hint, OR
- A pre-formatted unified diff string (e.g., from `git diff` adapter, or a fenced `diff` code block).

Capabilities:

- Side-by-side or inline view. Default inline; user toggle persists per-card.
- Hunk-by-hunk collapse (each hunk is its own collapsible region).
- Syntax highlighting per language inside hunks (via the same Shiki/Tree-sitter pipeline `MarkdownBlock` uses for code blocks).
- Word-level diff highlighting within a changed line (via `diff-match-patch` or equivalent at the JS layer).
- Filename + change-counts header (e.g., `tide-card.tsx · +12 −3`).
- Click-line-to-jump (when paired with a file URL via the wrapper).

Parser: see §7 — `imara-diff` (Rust + WASM) earns its keep here for large diffs; small diffs can fall back to JS `jsdiff` for simplicity.

### 5.4 `FileBlock`

Read-only file viewer. Shape is exactly `tool_use_structured.file` from a `Read` tool call: `{ content, filePath, numLines, startLine, totalLines }`.

- Syntax-highlighted by language (inferred from `filePath` extension).
- Line-numbered gutter, with `startLine` offset honored.
- "Showing N of M lines" indicator.
- Long-content collapse (default folded if > ~50 lines).
- Click-line-to-copy or click-line-to-jump.
- Search-within-file (Cmd+F) when expanded.

### 5.5 `PathListBlock`

Renders a list of file paths. Used by `Glob`, `Grep` (file-only mode), and shell adapters for `ls`/`find`. Shape: `string[]` paths plus optional metadata per path (size, mtime, etc.).

- Icons by file type (extension-driven).
- Path-shortening: collapse common prefixes into `…/`. Hover reveals full path.
- Click → open in editor / select in tugdeck filetree.
- Sortable when count > 20.
- "Truncated at N (showing first K)" indicator when the source flagged truncation.

### 5.6 `SearchResultBlock`

Grouped file:line:content matches. Used by `Grep`, `WebSearch` (with adaptation), and shell adapters for `rg --json`.

- Grouped by file with collapsible headers.
- Highlighted match span per result line.
- Surrounding context lines (configurable).
- Click → open file at that line.

### 5.7 `JsonTreeBlock`

Collapsible JSON tree viewer. Used by:

- Tool inputs/outputs whose shape is unknown or arbitrary (default fallback).
- MCP tool results.
- Any user-pasted JSON that we want to render richly inline.

Standard behavior: keys sortable, search-within-tree, copy-as-path (`response.data[0].id`), copy-subtree.

### 5.8 `TodoListBlock`

Renders the `TodoWrite` tool's todo array — a list of `{ content, status: "pending"|"in_progress"|"completed", activeForm }` items. Visual: checklist with status indicators, in-progress highlighted.

### 5.9 `AgentTranscriptBlock`

The most structurally complex body kind. Renders a subagent's run as a *nested transcript* — the same shape as the outer Tide transcript, but inline. Source: `tool_use_structured` for the `Task`/`Agent` tool, which carries `{ agentType, prompt, content, status, toolStats, totalDurationMs, totalTokens }`.

- Header: agent type + status badge + duration + tool-call count.
- Body: the agent's `content` array as nested message blocks. Recursive: an agent's `tool_use` events render through the same Layer-1/Layer-2 pipeline. Subagent of a subagent? Same pipeline. Recursion is bounded by a max depth that collapses deeper levels with a "+N nested calls" affordance.
- Cost summary line at bottom.

This is also where the "Bash-as-its-own-participant" idea from Step 13 lands cleanly: subagent-flavored runs naturally read as their own speaker.

### 5.10 `ImageBlock`

Inline image renderer. Two sources:

- User-attached images via the `atoms-attachments.md` plan (assistant doesn't generate images, but the user message may contain them, and the transcript renders user messages too).
- Markdown `![alt](url)` references (handled by `MarkdownBlock` today; this primitive is the underlying renderer the markdown pipeline delegates to for richer behavior — thumbnail + click-to-zoom + lazy load + fallback).

Lazy-loaded with a low-res placeholder. EXIF orientation honored. Click-to-fullscreen modal.

### 5.11 `MermaidBlock`

Renders Mermaid diagrams. Activated by the `MarkdownBlock` block transformer when a fenced code block has language `mermaid`. Lazy-loaded — the mermaid bundle (~1 MB even minified) only loads on first encounter, with a placeholder spinner during fetch.

- During streaming: show the raw fenced code as a code block; only swap to the rendered diagram once the block reaches `complete` (avoids partial-syntax render attempts).
- Theme-aware: pass `brio` / `harmony` token values into Mermaid's theme config.
- Pan/zoom on click (large diagrams).
- Fallback to plain code rendering on parse error, with a "Diagram failed to render" toast.

### 5.12 `KaTeXBlock`

Math typesetting via KaTeX (smaller, faster, synchronous; better for streaming than MathJax). Two modes:

- Inline: `$...$` spans inside paragraph text, rendered as KaTeX HTML inline.
- Display: `$$...$$` blocks or fenced `math`/`latex` code blocks, rendered as centered display equations.

Bundle is ~350 KB (core + base font); load lazily on first encounter. Fonts WOFF2 from local bundle (no CDN).

### 5.13 `TableBlock` (rich)

The default GFM table renderer in `MarkdownBlock` produces a plain `<table>`. For tables over ~10 rows or ~5 columns, the block transformer can promote to `TableBlock` with:

- Sortable columns (click header).
- Sticky header on scroll.
- Cell overflow handling (truncate + tooltip).
- Optional row striping by theme.
- Future: cell-content type detection (numbers right-aligned, dates parsed).

Most tables in assistant output are small; this only kicks in above a threshold.

### 5.14 `PlainTextBlock`

The fallback. Monospace, line-wrapped, copy-to-clipboard. Used when nothing else fits or when an upstream parser fails — guarantees we never render blank.

---

## 6. Tool-wrapper catalog (Layer 2)

Each wrapper composes Layer-1 bodies plus tool-specific chrome. All wrappers participate in collapse/expand at the wrapper level (so the entire tool block can be collapsed to a one-line summary).

The shape of every wrapper:

```
┌─────────────────────────────────────────────────────────────────┐
│ [icon] tool_name · args_summary       [duration] [exit] [⌃▾]    │  ← chrome header
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   <Layer-1 body kind, possibly composed>                        │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│ footer badges (file path, lines added/removed, etc.)            │  ← optional
└─────────────────────────────────────────────────────────────────┘
```

### 6.1 `ReadToolBlock`

- Header: `Read · {filePath}` (path-shortened) + line range badge if `startLine` / `numLines` set.
- Body: `FileBlock` with structured_result.file.
- Footer: "Showing N of M lines" if truncated.
- Interaction: click filename → reveal in tugdeck filetree.

### 6.2 `WriteToolBlock`

- Header: `Write · {filePath}` + size badge.
- Body: `FileBlock` showing the written content (preview).
- Footer: file-was-new vs. file-was-overwritten indicator (derived from prior state).

### 6.3 `EditToolBlock`

- Header: `Edit · {filePath}` + change-counts (`+5 −2`).
- Body: `DiffBlock` comparing `old_string` → `new_string` (or full-file diff if `replace_all`).
- Footer: link to the file in tugdeck.
- Interaction: hover-line annotates with "added/removed/unchanged" status.

`MultiEdit` (if/when present): same wrapper, multiple `DiffBlock`s in sequence with shared filename header.

### 6.4 `BashToolBlock`

- Header: `Bash · {command}` (shell-syntax-highlighted, truncated if long with hover-expand) + duration + exit-code badge.
- Body: `TerminalBlock` with stdout/stderr from `tool_use_structured`.
- Footer: re-run button (when re-run is safe — TBD per security policy), copy-command button.
- Specialization opportunity: detect command name (e.g., `git status`, `cargo build`) and swap to a Phase T2 adapter block (`GitStatusBlock`, `BuildOutputBlock`) — this is exactly the upgrade lever §4.4 (2). Until those land, `TerminalBlock` is the universal fallback.

### 6.5 `GlobToolBlock`

- Header: `Glob · {pattern}` + result count + "truncated" indicator.
- Body: `PathListBlock` with `structured_result.filenames`.
- Footer: duration.

### 6.6 `GrepToolBlock`

- Header: `Grep · {pattern}` + match count + file count.
- Body: `SearchResultBlock` (when output_mode is `content`) or `PathListBlock` (when output_mode is `files_with_matches`).
- Footer: duration.

### 6.7 `TaskToolBlock` / `AgentToolBlock`

- Header: `Agent · {agentType}` + status badge + duration + nested-tool-count.
- Body: `AgentTranscriptBlock`.
- Footer: total tokens + cost contribution.

### 6.8 `WebFetchToolBlock`

- Header: `WebFetch · {url}` (favicon + truncated URL).
- Body: rendered as `MarkdownBlock` (the assistant's prompt-shaped extraction is markdown-compatible) — or as `FileBlock` if we surface the raw fetched HTML/text.
- Footer: cache-hit indicator, response time.

### 6.9 `WebSearchToolBlock`

- Header: `WebSearch · {query}` + result count.
- Body: `SearchResultBlock` adapted (each result = title + URL + snippet).
- Footer: search engine attribution.

### 6.10 `TodoWriteToolBlock`

- Header: `TodoWrite` + total-count + in-progress-count.
- Body: `TodoListBlock`.
- Footer: progress bar (completed / total).

### 6.11 `NotebookEditToolBlock`

- Header: `NotebookEdit · {notebookPath} · cell {cellId}` + edit-mode badge (insert/replace/delete).
- Body: `DiffBlock` for replace; `FileBlock` for insert; struck-through cell preview for delete.
- Specialization opportunity: a `NotebookCellBlock` body kind that knows about cell types (markdown vs. code) and renders appropriately. Default to `DiffBlock` until the need is clear.

### 6.12 MCP tool wrappers

MCP tools (`mcp__claude_ai_Gmail__*`, etc.) have wildly varying shapes. Strategy:

- A small set of MCP-server-aware wrappers for high-traffic servers (Gmail, Calendar, Drive) that know the structured shapes and use specific bodies.
- Everything else → `DefaultToolWrapper` until promoted.

### 6.13 `DefaultToolWrapper`

The fallback. Used for any `tool_use` whose `tool_name` isn't in the registry.

- Header: `{tool_name}` + a one-line input-summary (best-effort: extract a `command`/`path`/`url` field if present, else `"…"`).
- Body: `JsonTreeBlock` over `tool_use.input` (collapsed by default), then a separator, then the body of `tool_result`/`tool_use_structured` rendered as: if string → `MarkdownBlock`; if object → `JsonTreeBlock`.
- Footer: duration.

Day-1 guarantee: every tool we've never seen still renders cleanly through this wrapper.

---

## 7. Stream-event chrome (outside the markdown body)

Not every event goes inside a `code` row's transcript body. These are the surrounding chrome renderers.

### 7.1 `ThinkingBlock`

Inline-collapsible block that lives at the *top* of the assistant turn (ahead of `assistant_text`). During streaming: shows "Thinking…" with a low-key animated indicator + a streaming preview that the user can opt into. After `turn_complete`: collapsible block with the full thinking text (italic, dimmed treatment) — the user opens it when curious.

This aligns with `tugplan-tide-card-polish.md §Step 13`'s default recommendation ("inline + collapsible inside the `code` row") but goes further: thinking is *always* collapsed by default after the turn completes. The active-stream display is kept understated so it doesn't dominate the response.

### 7.2 `CostChrome`

`cost_update` events carry `{ total_cost_usd, num_turns, duration_ms, duration_api_ms, modelUsage: {model: {inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD}}, usage }`. Three render levels:

- **Per-turn footer badge.** Tiny chrome at the bottom of each `code` row: `$0.04 · 1.2k tok · 3.4s`. Click to expand.
- **Expanded breakdown.** Stacked bar of input/output/cache tokens per model used in the turn, plus the dollar contribution per model. Useful when a turn used both Opus and Haiku.
- **Card-level cumulative chrome.** Status row already exists per `tide-card.tsx`; replace the gallery placeholder with cumulative session cost + total tokens + turn count for the active session.

### 7.3 `PermissionDialog` (`control_request_forward` with `is_question: false`)

Inline block in the transcript (not a modal — modals break flow). Shape:

- Header: "Permission requested" + tool icon + tool name.
- Body: tool input rendered as a `JsonTreeBlock` (or, where applicable, a body kind that fits — e.g., `Bash` permission shows the command in a `CodeBlock`; `Edit` permission shows the diff via `DiffBlock`).
- Reason line: `decision_reason` if present (e.g., "Path is outside allowed working directories").
- Suggestions: `permission_suggestions` (e.g., "Allow Read for `/foo/**` in this session") rendered as buttons.
- Allow / Deny buttons + an inline "Allow with edits" affordance that lets the user modify `tool_use.input` before allowing.
- After response: the block becomes a static record showing the decision.

### 7.4 `QuestionDialog` (`control_request_forward` with `is_question: true`)

Inline block. Renders the AskUserQuestion shape:

- Question text (markdown-rendered).
- Options as clickable choice cards. Single-select default; `multiSelect` flips to checkboxes.
- "Other" input (free text) per the AskUserQuestion convention.
- Submit button. After response: collapses to a one-line summary.

### 7.5 `SessionInitBanner`

Subtle inline banner at the top of a fresh session (one per Tide card lifetime, dismissable). Shows:

- Project path.
- Model + permission mode.
- A drift-detection warning if `system_metadata.version` doesn't match the pinned golden catalog (per `tide.md §p15-stream-json-version-gate`).

### 7.6 `ErrorBlock`

`error` events with `{ message, recoverable }`. Renders:

- Recoverable: amber inline notice with retry affordance.
- Non-recoverable: red inline notice with copy-error-and-report affordance.

---

## 8. Library and parser strategy

Per the answer to clarifying question 4: **WASM where it earns its keep; JS otherwise.**

### 8.1 Already in the pipeline

| Library | Use | Status |
|---------|-----|--------|
| `pulldown-cmark` (Rust) → `tugmark-wasm` | Markdown lex + parse | Shipped; extending here for footnotes, smart-punct, transformer pass |
| `DOMPurify` (JS) | HTML sanitization | Shipped |
| `Shiki` (JS, OnigWASM) | Code-block syntax highlighting | Shipped via legacy `enhanceCodeBlocks` |
| `marked` (JS) | Legacy markdown path (still in `lib/markdown.ts`) | Slated for removal once WASM pipeline owns everything |

### 8.2 New libraries — recommendations

**Diff parsing → `imara-diff` compiled to WASM.**
`imara-diff` is the strongest Rust diff library for this use case: histogram + Myers algorithms, pathological-input safe (no UI freezes on large diffs — measured 10×–30× faster than `similar` on linux-kernel-scale inputs). Add as a new crate in `tugdeck/crates/tugdiff-wasm/` parallel to `tugmark-wasm`. Gives `DiffBlock` a fast, correct backbone.
*Alternative considered:* `jsdiff` (~30 KB JS). Fine for tiny diffs (single Edit operations) but degrades on large multi-file diffs and word-level intra-line diffs. Use as a JS fallback when the WASM module isn't loaded yet (first-paint), promote to WASM once warm.

**ANSI parsing → `ansi_up` (JS), keep WASM in our back pocket.**
`ansi_up` (zero-deps, 6 KB minified) is sufficient for `TerminalBlock`. Bash output rarely exceeds a few hundred KB and `ansi_up` parses linearly. Only if we hit pathological `top`-style ANSI streams (cursor positioning, unusual escape sequences) do we need `vtparse` (Rust) compiled to WASM.

**Syntax highlighting → keep Shiki for now; evaluate `tree-sitter` later.**
Shiki is fast (3.5 s for 10k lines is acceptable when blocks are virtualized), VS Code-grade quality, lazy language loading. Tree-sitter via `web-tree-sitter` would give us better incremental highlighting under streaming, but the tooling complexity (per-language WASM blobs, async init, query files) isn't worth it until we hit a measurable Shiki bottleneck. Revisit after T1 ships and we have real load profiles.

**Mermaid → `mermaid` with lazy import.**
Per the v9.2+ lazy-loading API, the diagram-specific code only loads on first encounter. Bundle is large (~1 MB) but the cost is paid lazily. The "Tiny" variant (no Mindmap, Architecture, KaTeX) is half the size and probably enough.

**Math → `KaTeX` (not MathJax).**
~350 KB total (core + fonts), synchronous render (no reflow churn during streaming), faster than MathJax v3 in our latency profile. Inline (`$...$`) and display (`$$...$$`) handled by a post-DOMPurify text-node walk inside `MarkdownBlock`. Local font bundling, no CDN.

**JSON tree → custom JS component.**
Don't pull in a heavy library. `JsonTreeBlock` is straightforward to write and we want full control over collapse/expand semantics, copy-as-path, and theming.

**Word-level diff → `diff-match-patch` (JS, ~50 KB).**
Used inside `DiffBlock` to compute character-level diffs *within* a changed line. JS is fine here because the inputs are small (line-pairs, not full files).

### 8.3 Bundle-size budget

Lazy-load aggressively:

- KaTeX (350 KB): loads on first `$...$` or `$$...$$` encounter, or first fenced math block.
- Mermaid (~1 MB): loads on first ` ```mermaid ` encounter.
- `imara-diff` WASM: loads on first `DiffBlock` mount.
- Shiki language packs: already lazy.
- `ansi_up`: small enough to ship in the main bundle.
- `diff-match-patch`: ships with `DiffBlock`.

A Tide card that never sees a diagram, math, or diff pays zero cost for those primitives. The first time the user encounters one, there's a brief load — acceptable, and the result is cached for the session.

---

## 9. Streaming and incremental rendering

The `MarkdownBlock` pipeline already handles streaming via `PropertyStore` + rAF coalescing. Body kinds that *need* to participate in streaming are limited:

| Body kind | Streams? | Approach |
|-----------|----------|----------|
| `MarkdownBlock` | Yes — assistant_text deltas | Existing pipeline |
| `TerminalBlock` | Yes when output streams (Bash) | Re-parse on each delta; ANSI parser is linear |
| `DiffBlock` | No — Edit input arrives whole | Render once on `tool_use_structured` |
| `FileBlock` | No — Read result arrives whole | Render once |
| `PathListBlock` / `SearchResultBlock` | No | Render once |
| `JsonTreeBlock` | No — tool inputs stream but render once on completion | Render once |
| `AgentTranscriptBlock` | Yes recursively — nested tool events stream | Same pipeline as outer transcript |
| `MermaidBlock` | No — wait for complete | Show raw code during stream, swap on complete |
| `KaTeXBlock` | No | Render once |
| `TodoListBlock` | Tool input streams; render once on complete | Render once |
| `ImageBlock` | No | Render once |

For non-streaming primitives, the wrapper still renders them streamingly *at the wrapper level* — i.e., the wrapper shows a "streaming…" placeholder while `tool_use.input` is still empty / partial, and swaps to the body kind when the tool input or `tool_use_structured` arrives. This avoids the ugly intermediate state where a half-formed JSON input is rendered as a tree.

---

## 10. Theming and tokens

Every body kind and every tool wrapper introduces a component slot under the seven-slot convention (L19/L20):

```
--tugx-{kind}-{plane}-control-{constituent}-{emphasis}-{role}-{state}
```

Where `{kind}` is one of: `md` (already exists), `term`, `diff`, `file`, `paths`, `search`, `json`, `todo`, `agent`, `image`, `mermaid`, `katex`, `tooltip-toolblock` (or per-wrapper).

Compliance hooks:

- `bun run audit:tokens lint` exits 0 for every new component.
- Every component pairs a `.tsx` file with a `.css` file per L19 component-authoring.
- `data-slot="..."` attributes on every primitive root.
- Theme verification: every component snapshot-tested against both `brio` and `harmony` themes at `tugdeck/styles/themes/`.

Token-tuning is the *only* customization surface — wrappers don't reach into body-kind CSS.

---

## 11. Sequencing (recommended order of implementation)

This is the order that ships value early and unlocks each subsequent step. Each step is sized so a coder/coder-agent can land it in one focused pass.

1. **Markdown typography pass.** Tune `--tugx-md-*` tokens against both themes. (This is `tugplan-tide-card-polish.md §Step 12`. Land it first — every other body kind inherits the typographic baseline.)
2. **`MarkdownBlock` extensions.** Block-transformer pass infrastructure + footnotes + smart-punctuation + collapse-tall-blocks. No new body kinds yet.
3. **`ThinkingBlock`.** Wire `streamingPaths.thinking`. Inline + collapsible. (Step 13's first half.)
4. **`TerminalBlock` + `BashToolBlock`.** Highest-value tool wrapper, simplest body. ANSI via `ansi_up`. Lands content-aware tool rendering.
5. **`FileBlock` + `ReadToolBlock`.** Second-highest-value tool. File viewer with line numbers, language highlight (Shiki, already present), collapse on long files.
6. **`DiffBlock` + `EditToolBlock`.** Land `imara-diff` WASM crate. Inline diff first; side-by-side toggle as a follow-up.
7. **`JsonTreeBlock` + `DefaultToolWrapper`.** Once these exist, every unknown tool renders cleanly. Unblocks shipping the framework with confidence even before Mr-MCP-Tomorrow ships a new tool.
8. **`PathListBlock` + `GlobToolBlock`** and **`SearchResultBlock` + `GrepToolBlock`.**
9. **`AgentTranscriptBlock` + `TaskToolBlock`.** Nested rendering. Most architecturally interesting; do it once the simpler wrappers have shaken out the registry pattern.
10. **`PermissionDialog` + `QuestionDialog`.** Inline block style; integrate with `CodeSessionStore` request → response flow.
11. **`CostChrome`.** Per-turn footer + expanded breakdown + card-level cumulative.
12. **`KaTeXBlock`** (lazy-loaded). Inline + display math.
13. **`MermaidBlock`** (lazy-loaded).
14. **`TodoWriteToolBlock`, `WebFetchToolBlock`, `WebSearchToolBlock`, `NotebookEditToolBlock`, `WriteToolBlock`.** The remaining first-party tools.
15. **MCP-aware wrappers** for Gmail / Calendar / Drive (or whichever shows up in user traffic).
16. **`TableBlock` (rich)**, **`ImageBlock`**, **`SessionInitBanner`**, **`ErrorBlock`** — polish round.

Each step lands as: new body kind / new wrapper + tests + theme verification + `bun run audit:tokens lint` green + manual smoke against fixture replay (we have the v2.1.105 stream-json catalog as ground truth).

---

## 12. Open questions

1. **Where does the renderer dispatch live?** Two reasonable homes: (a) inside `CodeSessionStore` as part of the reducer's output shape (each `TurnEntry` carries a renderer kind tag); (b) as a separate `assistant-renderer-dispatch.ts` consumed by the transcript view, leaving the store kind-agnostic. Recommendation: (b) — keeps the store concerned with state, the dispatch concerned with presentation. Worth confirming.
2. **Re-run buttons on `BashToolBlock` (and similar).** Security-policy-laden. Default to off until the permission-mode story for re-run is clear.
3. **"Allow with edits" on `PermissionDialog`.** Requires a structured editor over `tool_use.input` — for `Bash`, that's a command-line editor; for `Edit`, that's the diff view editable. Worth designing as a follow-up rather than baking into v1.
4. **Should `AgentTranscriptBlock` be a participant variant on the transcript** (i.e., a Slack-like nested thread) **rather than an inline block?** `tugplan-tide-card-polish.md §Step 13` flags this as a possible follow-up. Defer until we have a working `AgentTranscriptBlock` and can A/B the two layouts.
5. **Streaming behavior for long Bash output.** If a `Bash` tool streams 50 MB of output, what's the cap? Recommendation: TerminalBlock self-virtualizes when length > N lines (reuse the `BlockHeightIndex` machinery from `TugMarkdownView`).
6. **Do we render `system_metadata` per-turn or only on session-init banner?** Per-turn is noisy; session-init-only loses model/permissionMode changes mid-session. Recommendation: per-turn render only when something changed since the previous `system_metadata`. Worth confirming.
7. **MCP-tool taxonomy.** What's the right granularity for MCP wrappers — one per server, one per tool, or one per common shape? Probably per-server with internal dispatch on tool name. Decide when we actually wire the first MCP server.
8. **Drift handling.** When a future Claude Code release ships a new event type or changes a structured_result shape, what's the user-visible behavior? Recommendation: drift telemetry + a "fallback to JsonTreeBlock for the unknown shape" rule + an inline banner. Aligns with `tide.md §p15-stream-json-version-gate`.

---

## 13. Cross-references

- [tide.md §Phase T1 — Content Block Types](./tide.md#content-block-types) — the stub this proposal elaborates.
- [tide.md §Phase T2 — Shell Command Blocks](./tide.md#shell-command-blocks) — the same Layer-1 body kinds serve shell adapters; this proposal reuses them.
- [tugplan-tide-card-polish.md §Step 12](./tugplan-tide-card-polish.md#step-12) — markdown typography pass; first step in §11 above.
- [tugplan-tide-card-polish.md §Step 13](./tugplan-tide-card-polish.md#step-13) — thinking + tool surfaces; this proposal is the design that step is currently a stub for.
- [tide.md §p15-stream-json-version-gate](./tide.md#p15-stream-json-version-gate) — drift detection; mentioned in §12 (8) above.
- [transport-exploration.md](./transport-exploration.md) — empirical event-shape catalog.
- [tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.105/](../tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.105/) — machine-readable fixtures used for manual replay testing of every renderer.
- [tuglaws/component-authoring.md](../tuglaws/component-authoring.md), [tuglaws/token-naming.md](../tuglaws/token-naming.md) — L19, L20, seven-slot convention every component complies with.
- [atoms-attachments.md](./atoms-attachments.md) — the user-side image attachment story; `ImageBlock` cooperates with it.

---

## 14. Library citations (web research, May 2026)

- [imara-diff (GitHub)](https://github.com/pascalkuthe/imara-diff) — performance-stable Rust diff library with histogram + Myers algorithms. 10×–30× faster than `similar` on large inputs.
- [imara-diff announcement (Rust forum)](https://users.rust-lang.org/t/announcing-imara-diff-a-reliably-performant-diffing-library-for-rust/83276)
- [similar (Rust diff)](https://docs.rs/similar) — comparison baseline.
- [Shiki](https://shiki.style/guide/) — current syntax-highlighter; modern versions run in browser.
- [Tree-sitter Syntax Highlighting](https://tree-sitter.github.io/tree-sitter/3-syntax-highlighting.html) — alternative, deferred until a measured Shiki bottleneck.
- [Mermaid lazy loading (Rick Strahl)](https://weblog.west-wind.com/posts/2025/May/10/Lazy-Loading-the-Mermaid-Diagram-Library) — late-binding + per-diagram-type loading recipe.
- [Mermaid bundle size discussion](https://www.sidharth.dev/posts/shrinking-mermaid/) — "Tiny" variant trade-offs.
- [ansi_up (GitHub)](https://github.com/drudru/ansi_up) — zero-dependency JS ANSI → HTML.
- [vtparse (Rust)](https://docs.rs/vtparse/) — heavier, full VT escape parser; reserved for pathological inputs.
- [KaTeX](https://katex.org/) — fast synchronous math typesetting; ~350 KB total.
- [KaTeX vs MathJax comparison (BigGo News, Nov 2025)](https://biggo.com/news/202511040733_KaTeX_MathJax_Web_Rendering_Comparison) — KaTeX wins on bundle and speed; MathJax wins on LaTeX coverage. KaTeX is the right call here.
