# The Conversation Experience — Roadmap

*Plumb the pipe first. See what comes out. Then build the UI.*

**Exploration journal:** [transport-exploration.md](transport-exploration.md) — 33 tests, protocol documentation, event catalogs.
**Architecture reference:** [tug-feed.md](tug-feed.md) — event schemas, correlation strategy, feed design.

---

## Vision

Build a graphical Claude Code conversation experience: the user types a prompt, the AI responds with streamed markdown, and agent progress is visible throughout.

---

## Action Items — Consolidated

Everything discovered in Phase 1 exploration, organized for action. This is the authoritative todo list.

### Transport Fixes (Phase 2)

| # | Item | Scope | Effort |
|---|------|-------|--------|
| T1 | **Fix `--plugin-dir`** in tugtalk to point to `tugplug/` not project root. Tugplug skills invisible without this. | tugtalk `getTugtoolRoot()` | Tiny |
| T2 | **Fix synthetic `assistant` text forwarding.** Tugtalk drops text from `model: "<synthetic>"` messages. Built-in skills like `/cost`, `/compact` produce text this way. Detect synthetic and emit as `assistant_text`. | tugtalk `routeTopLevelEvent` | Small |
| T3 | **Forward `api_retry` events.** Tugtalk drops `system` events with `subtype: "api_retry"`. Add forwarding. Audit for other dropped subtypes. | tugtalk `routeTopLevelEvent` | Small |
| T4 | **Process lifecycle management.** Tugtalk processes outlive tugcast — 137 zombies after 2 weeks. Use process groups or SIGTERM on shutdown. Card close must kill associated tugtalk. | tugcast process spawn | Medium |
| T5 | **Session command readiness.** `session_command: "new"` and `"fork"` have a gap: `session_init` fires with pending ID before new process is ready. Need clear readiness signal. | tugtalk session handling | Medium |
| T6 | **`--no-auth` flag for tugcast.** Skip session cookie + origin validation for dev/testing. Required to test the full WebSocket path. | tugcast `auth.rs` | Small |
| T7 | **Compile tugtalk to standalone binary.** `bun build --compile` produces a native executable — no Bun runtime dependency in production. Update justfile `app` recipe to build and copy. Agent bridge already prefers sibling binary. | tugtalk build, justfile | Small |
| T8 | **Fix `session_init` race condition.** `session_init` is broadcast (fire-and-forget) via `code_tx` only. Clients connecting after tugtalk startup never see it. Put `session_init` on a watch channel so it's delivered as a snapshot on connect, like `project_info`. | tugcast `agent_bridge.rs` | Small |
| T9 | **Fix double delivery of snapshot feeds.** Router borrows watch receivers for initial snapshot send, then clones them for ongoing watch tasks. Cloned receivers haven't "seen" the current value, so `changed()` fires immediately and re-sends. Fix: use `borrow_and_update()` and take ownership instead of borrow-then-clone. | tugcast `router.rs` | Small |
| T10 | **Encapsulate agent bridge watch channels.** Adding a new snapshot type (e.g. T8) requires touching 5 places across `main.rs` and `agent_bridge.rs`. Bridge should own its watch channels internally and return receivers via `AgentBridgeHandles`. Adding a new snapshot becomes a one-file change. | tugcast `agent_bridge.rs`, `main.rs` | Small |
| T11 | **Move `.tugtool/.session` to tugbank.** Tugtalk persists the current Claude Code session ID to `.tugtool/.session` inside the project directory, which dirties the working tree. Write session ID to tugbank instead. | tugtalk session persistence, tugbank | Small |

### UI Must Build (Phases 3-5 and beyond)

| # | Item | What | Priority |
|---|------|------|----------|
| U1 | **Text accumulation** | `assistant_text` partials are deltas. UI must buffer and accumulate. Final `complete` event has full text for verification. | Critical |
| U2 | **Permission dialog** | `control_request_forward` (`is_question: false`): tool name, input, reason. Allow/deny buttons. Permission suggestions for "always allow." Respond with `tool_approval`. | Critical |
| U3 | **AskUserQuestion dialog** | `control_request_forward` (`is_question: true`): questions with options, single/multi-select. Respond with `question_answer`. | Critical |
| U4 | **Interrupt button** | Send `{ type: "interrupt" }`. Turn ends with `turn_complete(result: "error")`. | Critical |
| U5 | **Streaming indicator** | Show during `assistant_text` partials. Remove on `turn_complete`. | High |
| U6 | **Thinking/reasoning display** | `thinking_text` events arrive before response. Collapsible block. | High |
| U7 | **Tool use display** | `tool_use` → `tool_result` → `tool_use_structured`. Show tool name, input, output, duration. | High |
| U8 | **Subagent activity** | `tool_use: Agent` brackets subagent lifetime. Nested tool calls visible. Show agent type, progress. | High |
| U9 | **Model switcher** | Send `model_change`. Synthetic `assistant_text` confirms. `system_metadata` updates. | High |
| U10 | **Permission mode switcher** | Send `permission_mode`. Cycle: default → acceptEdits → plan → auto. | High |
| U11 | **Cost/token display** | `cost_update` has `total_cost_usd`, `num_turns`, `duration_ms`, `usage` (input/output/cache tokens). | High |
| U12 | **Slash command popup** | Merge `system_metadata.slash_commands` + `system_metadata.skills`. Tugplug skills use `tugplug:` prefix. `/plan` is a name collision — use `tugplug:plan`. | High |
| U13 | **`@` file completion** | Terminal-only. UI must detect `@` in prompt, show file picker, inject file content into message or as attachment. | High |
| U14 | **Session new/fork handling** | Detect pending `session_init` IDs (`"pending"`, `"pending-fork"`). Wait for real ID. `"pending-cont..."` is safe immediately. | Medium |
| U15 | **Image attachments** | Base64 in `user_message.attachments`. Drag-drop/paste → encode → attach. Types: png, jpeg, gif, webp. Max ~5MB. | Medium |
| U16 | **API retry indicator** | `api_retry` events (after T3 fix): attempt count, delay, error type. | Medium |
| U17 | **Compaction indicator** | `compact_boundary` events. Show when context is being compacted. | Medium |
| U18 | **Session-scoped permission reset** | After resume, previously approved tools prompt again. Handle re-approval. | Medium |
| U19 | **Message queueing during turn** | Sending `user_message` mid-stream does NOT interrupt — it queues. UI should disable send (or show queue indicator) during streaming. Use `interrupt` to cancel. | High |
| U20 | **Plan mode choices** | `EnterPlanMode` tool produces approve/reject/keep-planning options. UI must present these when plan mode is active. | Medium |
| U21 | **Stop background task** | Send `{ type: "stop_task", task_id }`. UI needs a button/mechanism to stop running background tasks. | Medium |
| U22 | **Context window budget** | ~20% of context window used at startup (system prompt, memory, CLAUDE.md, etc.) before any user interaction. Token counter (U11) should account for this. | Low |
| U23 | **Task progress events** | `system:task_started`, `system:task_progress`, `system:task_completed` events provide agent lifecycle data (task_id, description, token usage). Use for progress indicators alongside U8. | High |

### Terminal-Only Commands (UI must reimplement)

These built-in commands have no stream-json equivalent — they return "Unknown skill." The UI must build its own versions.

| # | Command | What UI Needs | Priority |
|---|---------|--------------|----------|
| C1 | `/status` | Model, session, context usage from `system_metadata` + `cost_update.usage` | High |
| C2 | `/model` | Model picker → `model_change` message | High |
| C3 | `/permissions` | Mode display + switcher → `permission_mode` message | High |
| C4 | `/clear` | Clear conversation → `session_command: "new"` | High |
| C5 | `/resume` | Session picker (list, preview, rename, filter). Data from filesystem. | High |
| C6 | `/diff` | Run git diff via tool or Bash, render result | Medium |
| C7 | `/export` | Serialize conversation from accumulated events | Medium |
| C8 | `/copy` | Copy last response from accumulated `assistant_text` | Medium |
| C9 | `/btw` | Side question overlay — separate API call, no history impact | Medium |
| C10 | `/compact` | IS a skill (works), but UI should show compaction indicator | Medium |
| C11 | `/rename` | Text input → update session metadata | Low |
| C12 | `/branch`, `/rewind` | Session fork → `session_command: "fork"` | Low |
| C13 | `/vim` | Keybinding mode toggle for prompt input | Low |
| C14 | `/color`, `/theme` | Theme picker | Low |
| C15 | `/help` | Help display | Low |

### Further Exploration (open questions, not blocking)

| # | Area | Status | Notes |
|---|------|--------|-------|
| E1 | Slash command invocation | **Resolved** | Two small tugtalk fixes (T1, T2). |
| E2 | Plugin system | **Resolved** | All 12 tugplug agents + 4 skills visible with correct `--plugin-dir`. Plugin name `tugplug`. Hot-reload, session name untested but non-blocking. |
| E3 | Hooks visibility | Open | Hooks run silently. No events for hook decisions, context injection, timing. |
| E4 | Tugcast WebSocket layer | **Resolved** | Full path verified in Phase 2b. Wire protocol documented. Four issues found (T8-T11). |
| E5 | Session management | Partially tested | New, continue, fork tested. Picker data, concurrent sessions open. |
| E6 | Advanced patterns | Open | Background tasks, MCP, elicitation untested. |

---

## Phases

The work falls into three tiers: **prove the pipe**, **build the UI**, **add the feed layer**. Each phase is scoped to be one `/plan` → `/implement` cycle (or `/dash` for investigation/verification phases).

```
─── TIER 1: PROVE THE PIPE ───────────────────────────────────
Phase 1: Transport Exploration      — DONE (35 tests)
Phase 2: Transport Hardening        — DONE (T1-T7)
Phase 2b: WebSocket Verification    — DONE (probe written, 4 issues found)
Phase 2c: WebSocket Fixes           — DONE (T8-T11)

─── TIER 2: BUILD THE UI ─────────────────────────────────────
Phase 3A: Markdown Rendering Core    — virtualization, prefix sum, two-path rendering — DONE
Phase 3A.1: TugWorkerPool             — typed worker pool for parallel computation across cores — DONE (superseded)
Phase 3A.2: Worker Markdown Pipeline — move parsing off main thread, viewport-only rendering — DONE (superseded)
Phase 3A.3: Worker Pipeline Remediation — partial fixes applied — DONE (superseded)
Phase 3A.4: WASM Markdown Pipeline   — replace worker infra with pulldown-cmark WASM, simplify architecture — DONE
Phase 3A.5: Region Model + API       — addressable keyed regions, imperative handle, gallery rework — DONE
Phase 3A.6: SmartScroll              — scroll state machine, programmatic API, follow-bottom, callbacks
Phase 3A.7: SmartScroll Hardening    — fix phase gaps, orphaned states, dead code, all-key coverage
Phase 3B: Markdown Content Types     — code blocks, thinking, tool use, streaming (U1, U5, U6, U7)
Phase 4: Prompt Input               — input layer (U12, U13, U19)
Phase 5: Conversation Wiring        — core conversation loop (U2, U3, U4, U8, U14, U23)
Phase 6: Chrome & Status            — switchers, indicators, cost (U9-U11, U16, U17, U20-U22)
                                      + terminal commands: C1, C2, C3, C10
Phase 7: Session & Commands         — remaining terminal commands (C4-C9, C11-C15)
                                      + image attachments (U15), permission reset (U18), session picker (E5)

─── TIER 3: ADD THE FEED LAYER ───────────────────────────────
Phase 8: Hook Capture               — agent lifecycle events to feed.jsonl
Phase 9: Feed Correlation           — semantic enrichment with step context
Phase 10: Feed CLI + Tugcast        — tugcode feed commands, events reach browser
Phase 11: Agent-Internal Events     — file/command detail from within agents
Phase 12: Custom Block Renderers    — rich UI for agent output
```

**Item coverage:** Every U1-U23 and C1-C15 item is assigned to a phase. E3 (hooks visibility) and E6 (background tasks, MCP) remain deferred — non-blocking for UI work.

---

### Phase 1: Transport Exploration {#transport-exploration}

**Status: DONE.** 35 tests. See [transport-exploration.md](transport-exploration.md) for full journal.

**Key discoveries:**
- `assistant_text` partials are **deltas**, not accumulated. Final `complete` has full text.
- `thinking_text` is a separate event type arriving before response.
- ALL slash commands go through `user_message` — skills produce full event streams, terminal-only commands return "Unknown skill."
- `control_request_forward` is the unified gate for permissions AND `AskUserQuestion` (dispatch on `is_question`). **Verified live** with `/tugplug:plan` triggering clarifier agent questions.
- Interrupt produces `turn_complete(result: "error")`, not `turn_cancelled`.
- Subagent tool calls are fully visible in the stream (nested under `tool_use: Agent`).
- **`system:task_started/progress/completed`** events provide agent lifecycle tracking with task_id, description, and token usage — ideal for progress indicators.
- `system_metadata` sent every turn contains model, tools, slash commands, skills, plugins, agents, permission mode — the source for all UI chrome. With correct `--plugin-dir`: all 12 tugplug agents + 4 skills visible.
- `--plugin-dir` must point to `tugplug/` for skills/agents to be visible (was the root cause of the slash command mystery).
- Tugtalk drops `api_retry` events and synthetic `assistant` text — needs fixes (T2, T3).
- 137 orphaned tugtalk processes after 2 weeks — process lifecycle needs fixing (T4).

---

### Phase 2: Transport Hardening {#transport-hardening}

**Status: DONE.** All seven items committed.

**Commits:**
1. `ec7fad06` T1 — fix `--plugin-dir` to point to `tugplug/`
2. `923a655c` T2 — forward synthetic assistant text
3. `f3ac0249` T3 — forward `api_retry` events
4. `ac3cdf54` T6 — `--no-auth` flag, port defaults to tugbank
5. `67c22ad1` T4 — process lifecycle (process groups, parent-death watchdog, kill_on_drop)
6. `314a13cc` T5 — session command readiness signaling
7. `70e8733e` T7 — compile tugtalk to standalone binary

**Exit criteria met:**
- All tugplug skills visible in `system_metadata.skills` and invocable via `user_message`
- Built-in skill commands (`/cost`, `/compact`) produce text output through tugtalk
- `api_retry` events forwarded
- No orphaned tugtalk processes after app quit
- `--no-auth` flag available for WebSocket testing
- Session new/fork/continue all signal readiness correctly
- Tugtalk compiles to standalone binary — no Bun runtime dependency in production

---

### Phase 2b: WebSocket Verification {#websocket-verification}

**Status: DONE.** Probe written (`tugtalk/probe-websocket.ts`), full findings in [ws-verification.md](ws-verification.md).

**Key findings:**
- Wire protocol confirmed: binary frames `[1-byte FeedId][4-byte BE u32 length][payload]`
- Full round-trip works: WebSocket connect → `protocol_init` → `user_message` → streamed `assistant_text` → `turn_complete(result=success)`
- Reconnection works: fresh snapshot feeds delivered immediately
- All snapshot feeds (filesystem, git, stats, project_info) arrive on connect

**Issues discovered (T8-T11):**
- T8: `session_init` race — broadcast before client subscribes, missed on every fresh launch
- T9: Double delivery — snapshot feeds sent twice on connect due to watch receiver clone bug
- T10: Five touchpoints to add a watch channel — agent bridge should encapsulate its own channels
- T11: `.tugtool/.session` written to repo tree, dirties working tree

---

### Phase 2c: WebSocket Fixes {#websocket-fixes}

**Goal:** Fix T8-T11. Clean up the issues found in Phase 2b before building UI.

**Inputs:** Phase 2b findings.

**Work:** Items T8-T11 from the action items table. Prioritized:
1. T8 (session_init watch channel) — directly blocks UI session handling
2. T9 (double delivery) — code smell in router, fix while touching snapshot code
3. T10 (encapsulate bridge channels) — clean up the pattern T8 introduced
4. T11 (session file location) — stop dirtying the repo tree

**Exit criteria:**
- `session_init` delivered as snapshot on connect (no race)
- No double delivery of snapshot feeds
- Adding a new agent bridge snapshot type is a one-file change
- No tugtalk-written files inside the repo tree

**Outputs:** Verified WebSocket path. Confidence to build UI.

---

### Phase 3A: Markdown Rendering Core {#markdown-rendering-core}

**Goal:** Build the virtualized markdown rendering engine that handles multi-MB content. This is the foundation everything else renders through.

**Inputs:** Verified transport (Phases 2, 2b). `assistant_text` delta model from Phase 1.

**Key constraint:** Claude Code sessions routinely reach multi-MB sizes (observed: 110MB, 20MB, 3.4MB in real usage). Rendering the full conversation into the DOM is not viable. The component must virtualize, informed by how Monaco editor achieves instant rendering of arbitrarily large files.

#### Monaco-informed architecture

Monaco's rendering performance comes from three core ideas that transfer directly to our markdown use case:

**1. PrefixSumComputer — the single most important data structure.**

Monaco stores per-line heights in a `Uint32Array` with a lazily-computed prefix sum. `getIndexOf(scrollTop)` finds the first visible line via binary search in O(log n). The scrollbar is accurate for million-line files without rendering them. Our equivalent:

- `BlockHeightIndex`: a `Float64Array` of per-block heights (estimated before render, measured after).
- Lazy prefix sum with a validity watermark — recompute only from the point of change.
- `getBlockAtOffset(scrollTop)` → binary search → first visible block. O(log n).
- `getTotalHeight()` → sum of all block heights. Drives the scrollbar/scroll container sizing.
- Estimated heights: paragraph = line count × line height; heading = known per level; code = line count × code line height + header; hr = fixed. Refined to measured heights once a block enters the viewport and renders.

**2. Viewport-only DOM — sliding window of rendered blocks.**

Monaco's `RenderedLinesCollection` maintains a contiguous array of DOM nodes mapped to document line numbers. Only lines in/near the viewport exist in the DOM. Our equivalent:

- `RenderedBlockWindow`: tracks which blocks currently have DOM nodes (startIndex, endIndex).
- On scroll: compute new visible range from `BlockHeightIndex`, diff against current window, add entering blocks, remove exiting blocks.
- Overscan: render 1-2 screens above/below the viewport for smooth scrolling.
- Unchanged blocks in the viewport: reposition only (translate Y), don't rebuild.
- Each block has a dirty flag (Monaco's `_isMaybeInvalid`). Skip DOM update if content unchanged.
- A spacer element above and below the rendered window, sized from the prefix sum, creates the correct scroll height.

**3. Two rendering paths — static and streaming.**

*Static path* — Full content already available (resumed sessions, history, completed messages).
- `marked.lexer()` once → block list. Estimate heights. Populate `BlockHeightIndex`.
- Render only the viewport window. Measure rendered blocks, update heights.
- For very large content (>1MB): lex in chunks via `requestIdleCallback` to avoid blocking. Show a progress indicator or render from the tail (most recent content first).

*Streaming path* — Deltas arriving live from `assistant_text` events.
- Accumulate deltas into a buffer (U1). `PropertyStore<string>` [L02], rAF throttle.
- Incremental lexing: only re-lex from the last stable block boundary. Previous blocks are frozen.
- New blocks append to the block list and `BlockHeightIndex`. Viewport auto-scrolls to tail.
- On `turn_complete`, finalize: full lex of the last block for verification, freeze all blocks.

*Transition:* Prior messages load via static path. Active response uses streaming path. Both coexist in a single scroll container backed by one `BlockHeightIndex`.

**Work:**
- `BlockHeightIndex`: `Float64Array` prefix sum with lazy recomputation, binary search for offset→block mapping.
- `RenderedBlockWindow`: sliding window of DOM nodes, overscan, dirty tracking.
- `marked.lexer()` → keyed block list. Block types: paragraph, heading, code, blockquote, list, table, hr, html.
- Scroll container: spacer elements sized from prefix sum, scroll event → viewport recalc.
- Static path: bulk lex, chunked for large content.
- Streaming path: delta accumulation, incremental tail lexing, auto-scroll.
- Height estimation heuristics per block type. Measure-and-refine cycle.
- Integration with `PropertyStore` [L02] for streaming state.

**Exit criteria:**
- DOM node count stays bounded regardless of content size — verified with 10MB+ test content.
- Static: 1MB renders in <200ms (viewport visible). 10MB renders in <1s (viewport visible, background lex continues). Scrollbar accurate within 5% before full measurement.
- Streaming: 60fps, no jank for 5000+ words of live deltas.
- Scroll through 10MB content at 60fps — no dropped frames.
- `BlockHeightIndex.getBlockAtOffset()` completes in <1ms for 100K blocks.
- Laws compliance: [L02, L06].

**Demo:** Load a 5MB recorded conversation, scroll through it smoothly. Then feed live deltas at the tail and watch it stream while scrolling remains responsive.

---

### Phase 3A.1: TugWorkerPool {#tug-worker-pool}

**Status:** Not started.

**Goal:** Build a typed worker pool that spreads computation across multiple cores. The point is parallelism, throughput, and *never blocking the UI thread with compute-intensive work*. When there are 5,000 markdown blocks to parse, split them across N workers and get the answer N times faster. Dev machines have 8-16+ cores sitting idle; this infrastructure lights them up.

**Inputs:** Phase 3A experience (what goes wrong without workers). Library research and risk validation (below).

**Non-goal:** This is not a job scheduler, not a generic service bus, not a task registry. It's a pool of identical workers that you throw work at in parallel.

**Hard constraint:** The main thread is sacred. No compute-intensive work — lexing, parsing, height estimation, syntax highlighting — may run on the main thread. The main thread handles DOM reads/writes, scroll events, and React rendering. Everything else goes to workers. This is not aspirational; it is a rule. Violating it produces the same 15-second freeze we're fixing.

#### Library research findings

Surveyed MIT-compatible worker libraries for browser use:

| Library | License | Stars | Bundle | Pool | Cancel | Priority | Maintained |
|---------|---------|-------|--------|------|--------|----------|------------|
| **Comlink** | Apache-2.0 | 12.6K | 1.1kB | No | No | No | Stable/low activity |
| **workerpool** | Apache-2.0 | 2.3K | 9kB | Yes | Yes | No | Active |
| **threads.js** | MIT | 3.5K | 3kB | Yes | Partial | No | Semi-maintained |
| **poolifier-web-worker** | MIT | 62 | Small | Yes | ? | Yes | Active |
| **greenlet** | MIT | 4.7K | 1kB | No | No | No | Unmaintained |

**Recommendation: Build our own, informed by the MIT-licensed libraries.** ~200 lines. Zero dependencies. Fits existing tugdeck patterns (DeckManager, ResponderChain, PropertyStore).

#### Patterns adopted from MIT-licensed libraries [L21]

Copyright notices preserved in `THIRD_PARTY_NOTICES.md` per [L21]. Source files must reference the relevant notice entry.

**From threads.js** (Copyright (c) 2019 Andy Wermke, MIT):
- **Thenable task handle with cancellation.** Return object is both `await`-able and has `.cancel()`.
- **Discriminated union message protocol.** `type` field enum for TypeScript narrowing.
- **Init handshake with timeout.** Workers send `init` on load; pool waits with configurable timeout.

**From poolifier-web-worker** (Copyright (c) 2023-2024 Jerome Benoit, MIT):
- **Least-busy worker selection.** Pick the worker with fewest in-flight tasks.
- **Promise-response-map RPC.** `Map<taskId, {resolve, reject}>` resolved on worker response.

**From greenlet** (Copyright (c) Jason Miller, MIT):
- **Counter-based task IDs with stashed resolve/reject.** Simplest correct RPC in ~5 lines.
- **Automatic transferable detection.** Filter for `ArrayBuffer`/`MessagePort`/`ImageBitmap`.

**Pitfalls avoided:** threads.js `delay(0)` timing hack, poolifier's 2,500-line abstract pool with `new Function()` injection, greenlet's missing cleanup and lossy error serialization.

#### Design: TugWorkerPool\<TReq, TRes\>

Each consumer creates its own pool of N identical workers. No shared pool, no cross-type dispatch. Markdown gets a pool. Shiki gets a pool (later). They don't interfere because they have different initialization needs (Shiki workers carry a persistent highlighter instance; markdown workers are stateless).

```
   TugMarkdownView                          Shiki (Phase 3B)
        │                                        │
        ▼                                        ▼
 TugWorkerPool<ParseReq, ParseRes>    TugWorkerPool<HighlightReq, HighlightRes>
   ┌─────┬─────┬─────┐                  ┌─────┬─────┐
   │ W1  │ W2  │ W3  │ W4               │ W1  │ W2  │
   │.....│.....│.....│......             │.....│.....│
   │ md  │ md  │ md  │ md               │shiki│shiki│
   └─────┴─────┴─────┘                  └─────┴─────┘
        ▲                                     ▲
     N = hardwareConcurrency-based         N = separate
```

**The pool is generic over request/response types.** The caller decides what goes in and what comes out. The pool handles:

1. **Spawning N workers** from a single worker script URL.
2. **Dispatching tasks** to the least-busy worker (fewest in-flight tasks).
3. **Promise-response-map RPC** — each `submit()` returns `{ promise, cancel() }`.
4. **Cancellation** — removes queued tasks or signals in-flight workers.
5. **Typed messages** — discriminated union protocol, no `any`.
6. **Lazy spawn + idle timeout** — workers created on first task, terminated after 30s idle.
7. **Graceful degradation** — if `Worker` constructor fails, run handler inline on main thread.

**What the pool does NOT handle:** Priority queuing, task registries, back-pressure signaling, worker selection strategies beyond least-busy. The caller controls what to submit and when — if the viewport scrolls, the component cancels stale tasks and submits new ones. Priority is the caller's concern.

#### Key design decisions

**W13: Per-consumer pools, not a shared service.**
Each feature creates its own `TugWorkerPool` pointing at its own worker file. This avoids the cross-type dispatch problem (Shiki needs persistent state in the worker; markdown is stateless) and keeps the pool implementation simple. If two features compete for cores, the OS scheduler handles it — that's what it's for.

**W14: Pool size from `navigator.hardwareConcurrency`.**
Default: `Math.max(1, Math.min((navigator.hardwareConcurrency || 4) - 2, 12))`. On a 16-core machine: 12 workers. Reserves 2 cores (main thread + OS/browser overhead), caps at 12 to stay reasonable. Target audience runs beefy dev machines with 32-128GB+ RAM — each worker context is ~5-10MB, so even 12 workers is <120MB. Configurable per pool — markdown might want the full 12, a lightweight task might want 4. Lazy spawn: workers created on first task, not at pool creation.

**W15: Cancellation via task ID.**
Every `submit()` returns a handle. `handle.cancel()` either removes from the queue (if pending) or posts a cancellation message to the worker (if in-flight). Workers should check a cancellation flag between processing steps (e.g., between parsing blocks in a batch).

**W16: Graceful degradation.**
If `Worker` construction fails, the pool creates an inline executor that runs the handler function directly on the main thread via `queueMicrotask`. Same `TaskHandle` API. Callers don't know the difference. Essential for test environments and CSP-restricted contexts.

**W17: Typed message protocol.**
Wire protocol: `{ taskId: number, type: 'task', payload: TReq }` → `{ taskId: number, type: 'result', payload: TRes }` | `{ taskId: number, type: 'error', error: { message, stack, name } }`. Plus `{ type: 'init' }` handshake and `{ type: 'cancel', taskId }` signal. Discriminated union, no `any`.

#### API

```typescript
// --- Pool creation (in a component, hook, or module) ---
const mdPool = new TugWorkerPool<MarkdownParseReq, MarkdownParseRes>(
  new URL('./workers/markdown-worker.ts', import.meta.url),
  { poolSize: 4 }  // optional, defaults to hardwareConcurrency-based
);

// --- Submit work ---
const handle = mdPool.submit({ blockIndex: 42, tokenRaw: '## Hello' });
const result = await handle.promise;  // { index: 42, html: '<h2>Hello</h2>' }

// --- Cancel (e.g., user scrolled away) ---
handle.cancel();

// --- Submit a batch in parallel ---
const handles = blocks.map(b => mdPool.submit(b));
const results = await Promise.all(handles.map(h => h.promise));

// --- Cleanup ---
mdPool.terminate();  // kills all workers

// --- In the worker file (markdown-worker.ts) ---
import { marked } from 'marked';

self.onmessage = (e: MessageEvent) => {
  const { taskId, type, payload } = e.data;
  if (type === 'cancel') { /* set flag */ return; }
  if (type === 'task') {
    try {
      const html = marked.parser([rebuildToken(payload)]);
      self.postMessage({ taskId, type: 'result', payload: { index: payload.blockIndex, html } });
    } catch (err) {
      self.postMessage({ taskId, type: 'error', error: serializeError(err) });
    }
  }
};
self.postMessage({ type: 'init' });
```

The worker file is plain — it owns its imports, its state, its `onmessage` handler. The pool doesn't dictate what happens inside the worker. It just manages the fleet and the RPC plumbing.

#### Work

**Step 1: Types (`tugdeck/src/lib/tug-worker-pool.ts`, top section).**
`TaskHandle<T>`, `WorkerMessage<TReq, TRes>` discriminated union, `TugWorkerPoolOptions`. ~40 lines.

**Step 2: Pool implementation (`tugdeck/src/lib/tug-worker-pool.ts`, main class).**
`TugWorkerPool<TReq, TRes>`: constructor takes worker URL + options. Manages `WorkerSlot[]` (worker instance + in-flight count + pending queue). `submit()` picks least-busy slot, posts message, returns handle. `onmessage` resolves/rejects from response map. Lazy spawn on first submit. Idle timeout per worker. `terminate()` kills all. ~150 lines.

**Step 3: Graceful degradation (`tugdeck/src/lib/tug-worker-pool.ts`, fallback path).**
If `new Worker()` throws, create `InlineSlot` that runs a user-provided handler function via `queueMicrotask`. Constructor accepts optional `fallbackHandler: (req: TReq) => TRes | Promise<TRes>`. ~30 lines.

**Step 4: Tests (`tugdeck/src/__tests__/tug-worker-pool.test.ts`).**
Test via degradation path (fallback handler). Verify: submit resolves, cancellation of queued tasks, least-busy dispatch (submit N+1 tasks to pool of N, verify distribution), error propagation (handler throws → promise rejects with structured error), terminate cleans up. ~120 lines.

**Step 5: Integration test with real worker.**
`tugdeck/src/__tests__/tug-worker-pool.integration.test.ts` — create a trivial `echo-worker.ts` that posts back what it receives. Verify real `Worker` spawn in Bun, round-trip message passing, pool of 2 workers handles concurrent tasks. ~50 lines.

**Step 6: Vite build verification.**
`bun run build` emits worker chunk. Manual browser test: pool spawns real workers, devtools shows threads.

#### Checkpoints

- `bun test src/__tests__/tug-worker-pool.test.ts` — all tests pass.
- `bun test src/__tests__/tug-worker-pool.integration.test.ts` — real worker round-trip passes.
- `bunx tsc --noEmit` — no new type errors.
- `bun run build` — build succeeds, worker chunk emitted.

#### Exit criteria

- `new TugWorkerPool(url).submit(req)` dispatches to a real web worker and resolves with the response.
- Pool spreads tasks across N workers (verified: N tasks submitted simultaneously → N workers each get one).
- Cancellation works for queued and in-flight tasks.
- Graceful degradation: fallback handler runs inline when `Worker` constructor fails.
- Idle workers are terminated after timeout. New tasks respawn them.
- `terminate()` kills all workers and rejects all pending promises.
- ~200 lines total. Zero dependencies.

#### Risks (grounded)

- R06: **Vite requires static string literals in `new Worker(new URL(...))`** (confirmed). Must be a literal — no variables, no template literals. Vite handles `.ts` natively. Static imports inside the worker are auto-bundled into the worker chunk. **Risk: LOW.** Each consumer writes the literal `new URL('./workers/foo-worker.ts', import.meta.url)` directly.
- R07: **Dynamic `import()` inside workers is broken with Vite's default IIFE format** (confirmed, Vite issues #18585, #5402). **Mitigation: not our problem.** Worker files use static imports only. Each worker file imports its own dependencies at the top level. The pool doesn't dictate worker internals. **Risk: ELIMINATED.**
- R08: **Bun test runner has native `Worker` global** (confirmed). Real threads spawn in `bun test`. **Mitigation:** Unit tests use the fallback handler (no real threads). Integration tests use real Workers with a trivial echo worker to verify the spawn/message/terminate lifecycle. **Risk: LOW.**

---

### Phase 3A.2: Worker-Based Markdown Pipeline {#worker-markdown-pipeline}

**Status:** Not started.

**Goal:** Move all heavy markdown computation off the main thread. The Phase 3A implementation put lexing, parsing, and sanitization on the main thread, then compounded the problem by pre-rendering all ~5,000 blocks via `scheduleIdleBatch`. The result: ~15 seconds of main-thread blocking for a 1MB document. This phase fixes the architecture.

**Content model:** This is a *viewer*, not an editor. The component supports exactly two operations: (1) loading a potentially large initial markdown document, and (2) appending new content to the end of it (streaming). There is no editing, no insertion at arbitrary positions, no deletion, no cursor. This constraint simplifies the entire architecture — the block list is append-only during streaming, the prefix sum never needs mid-array insertion, the HTML cache is never invalidated by user edits, and the scroll position only auto-advances (tail-follow) or stays put (user-controlled). Do not design for general-purpose editing.

**Inputs:** Phase 3A code (BlockHeightIndex, RenderedBlockWindow, TugMarkdownView). Phase 3A.1 TugWorkerPool. Monaco editor architecture study (below).

#### What went wrong in Phase 3A

The Phase 3A roadmap section correctly identified Monaco's prefix sum and sliding window patterns, but missed Monaco's most important architectural principle: **never compute what isn't visible.** Three specific failures:

1. **`scheduleIdleBatch` pre-renders ALL blocks into the DOM.** After the initial viewport render (~60 blocks), idle callbacks iterate through all remaining ~4,940 blocks, calling `marked.parser()` + `DOMPurify.sanitize()` for each. At ~2ms per block, that's ~13 seconds of main-thread work — even though the user may never scroll to most of those blocks. This defeats the entire purpose of the sliding window.

2. **All parsing runs synchronously on the main thread.** `marked.lexer()` (fast, ~5ms for 1MB) and `marked.parser([token])` + `DOMPurify.sanitize()` (slow, ~2ms per block) all run on the UI thread. When the user scrolls to unrendered blocks, `addBlockNode()` calls `renderToken()` synchronously, causing visible jank.

3. **The streaming path calls `renderToken()` for reconciliation even on off-screen blocks** (line 539), wasting cycles comparing HTML for blocks that have no DOM nodes.

#### Monaco architecture study — what we should have learned

Monaco's rendering performance comes from principles the Phase 3A implementation adopted only partially:

**Principle 1: Viewport-only computation (adopted partially).**
Monaco does NOT tokenize the entire file on load. It tokenizes only the visible lines, then progressively tokenizes the rest in the background. Phase 3A adopted the sliding window for DOM nodes but then undermined it by pre-rendering all blocks anyway.

**Principle 2: Worker threads for heavy computation (not adopted).**
Monaco runs language services (type checking, validation, formatting) in dedicated web workers. The main thread handles only rendering and user interaction. Phase 3A runs everything — lexing, parsing, sanitization — on the main thread.

**Principle 3: Incremental updates with state propagation (adopted partially).**
Monaco retokenizes only the modified line and checks whether the end state changed. If not, subsequent lines are untouched. Phase 3A's streaming path does incremental tail re-lexing, which is good, but still calls `renderToken()` on every reconciled block regardless of visibility.

**Principle 4: Binary-encoded tokens for transfer efficiency (not adopted).**
Monaco encodes tokens as `Uint32Array` (32 bits per token field) for efficient memory and fast transfer between threads. Phase 3A uses full JavaScript Token objects, which are expensive to clone across worker boundaries via `postMessage`. For our use case, we don't need binary encoding — but we do need to be thoughtful about what crosses the worker boundary.

**What Monaco does NOT do (important negative findings):**
- Does not use `SharedArrayBuffer` for token transfer — just `postMessage`.
- Does not scale worker count by `navigator.hardwareConcurrency` — uses one worker per language service.
- Does not pre-tokenize large files — viewport-first, always.
- Falls back gracefully to main thread if workers are unavailable.

#### Architecture: two-phase worker pipeline (Model C)

Three task-to-worker models were evaluated:

**Model A: One task = one block.** Submit 5,000 individual tasks. Maximum parallelism, but ~5,000 `postMessage` round-trips at ~0.1ms each = ~500ms in message overhead alone. Rejected — message overhead dominates parse time.

**Model B: One task = a batch of blocks.** Submit batches of ~100 blocks. Fewer messages (~50), better throughput. But coarser cancellation. Viable but not optimal.

**Model C: Two-phase (chosen).** Phase 1 sends the entire raw text to a single worker for `marked.lexer()` → returns lightweight metadata (token types, raw text lengths, estimated heights). This is fast (~5ms for 1MB) and produces the data needed to populate BlockHeightIndex and render the scrollbar immediately. Phase 2 submits batches of block indices to the worker pool for `marked.parser()` → returns `{ index, html }[]`. Only blocks in the visible + overscan range are submitted. Parsing is the expensive step (~2ms per block) and this is where parallelism pays off.

```
   PHASE 1: LEX (single worker, fast)
   ──────────────────────────────────
   Main thread                    Worker (any one from pool)
       │                              │
       ├─ submit({ type: 'lex',       │
       │    text: '# Hello\n...' }) ──→ marked.lexer(text)
       │                              │  estimateBlockHeight(token) for each
       │                              │  compute byte offsets per token
       │                           ←──┤  { blockCount, heights[], offsets[] }
       │                              │
       ├─ populate BlockHeightIndex   │  (scrollbar now accurate)
       ├─ store offsets               │  (main thread slices raws from content)
       ├─ compute visible range       │
       └─ immediately request Phase 2 │

   Note: Phase 1 returns offsets (block boundary positions in the source
   text), NOT the raw strings themselves. The main thread already has the
   original content string — it slices content.slice(offsets[i-1], offsets[i])
   to get each block's raw text for Phase 2. This keeps the Phase 1 response
   payload at ~80KB (heights + offsets as number arrays) instead of ~1MB+
   (the raw text re-serialized). For a 10MB document, this is the difference
   between ~1ms and ~350ms of structured clone overhead.


   PHASE 2: PARSE (pool of N workers, parallel, on-demand)
   ────────────────────────────────────────────────────────
   Main thread                    Worker pool (N workers)
       │                              │
       │  (slice raws from content    │
       │   using offsets from Phase 1)│
       │                              │
       ├─ submit({ type: 'parse',     │   ← batch 1 of ~10 blocks
       │    batch: [{ index, raw }]}) ────→ W1
       ├─ submit({ type: 'parse',     │   ← batch 2
       │    batch: [{ index, raw }]}) ────→ W2
       ├─ submit(...)                 ────→ W3  ... up to N batches
       │    ...                       ────→ W4     for N workers
       │                              │
       │  ←───── { index, html }[] ───┤  (as each worker finishes)
       │                              │
       ├─ cache HTML per index        │
       ├─ sanitize + render visible   │
       └─ (next scroll → new batches) │

   The main thread splits the uncached blocks in the visible+overscan
   range into N batches (one per worker) and submits N tasks via
   pool.submit(). The pool dispatches each to the least-busy worker.
   As each worker finishes, its results populate the HTML cache and
   visible blocks are rendered immediately.


   STREAMING: tail-lex + parse (batched, low frequency)
   ──────────────────────────────────────────────────────
   Main thread                    Worker (single)
       │                              │
       │  (every ~100ms, not every delta)
       ├─ submit({ type: 'stream',    │
       │    tailText: '...',          │
       │    relexFromOffset: N }) ────→ marked.lexer(tail)
       │                              │  marked.parser for new/changed blocks
       │                           ←──┤  { newHeights[], newOffsets[],
       │                              │    parsedBlocks: {index, html}[] }
       │                              │
       ├─ append to BlockHeightIndex  │
       ├─ extend offsets array        │
       ├─ update cache for changed    │
       ├─ render if in viewport       │
       └─ auto-scroll to tail         │
```

**Why Model C wins:**
- Phase 1 is one message, completes in ~5-10ms, and gives the main thread everything it needs to render the scrollbar and compute the visible range. The response is lightweight (~80KB of number arrays), not a re-serialization of the document text. No waiting for parse results before the UI is interactive.
- Phase 2 uses the full worker pool for parallelism where it matters most: the expensive `marked.parser()` calls. The main thread splits the work into N batches and submits N tasks — one per worker. Message overhead is low (~12 messages for 12 workers) while throughput scales with core count.
- The worker file handles all three message types (`lex`, `parse`, `stream`) via a simple switch. No task registry, no dynamic imports.
- Streaming uses a batched approach (~100ms coalescing, not per-delta) to avoid flooding the worker with 25 requests/second.

**Key design decisions:**

**W07: Two-phase lex/parse pipeline via TugWorkerPool.**
Phase 3A.1's `TugWorkerPool<TReq, TRes>` manages a fleet of identical markdown workers. The component creates one pool at mount time. Phase 1 (lex) and Phase 2 (parse) are both submitted via `pool.submit()`. The pool dispatches to the least-busy worker. Cancellation (W15) and graceful degradation (W16) come from the pool for free.

The pool's generic types use discriminated unions to handle the three message types through a single pool instance:
```typescript
type MdWorkerReq =
  | { type: 'lex'; text: string }
  | { type: 'parse'; batch: { index: number; raw: string }[] }
  | { type: 'stream'; tailText: string; relexFromOffset: number };

type MdWorkerRes =
  | { type: 'lex'; blockCount: number; heights: number[]; offsets: number[] }
  | { type: 'parse'; results: { index: number; html: string }[] }
  | { type: 'stream'; newHeights: number[]; newOffsets: number[];
      parsedBlocks: { index: number; html: string }[] };

const pool = new TugWorkerPool<MdWorkerReq, MdWorkerRes>(workerUrl);
```

The caller narrows the response type by matching on the `type` discriminant. The worker file is a single `markdown-worker.ts` with a switch on `payload.type`:
- `lex`: receives raw text, runs `marked.lexer()`, returns block count + heights + byte offsets (no raw strings, no HTML — the main thread has the original text).
- `parse`: receives a batch of `{ index, raw }` entries, runs `marked.parser(marked.lexer(raw))` for each (see W19), returns `{ index, html }[]`.
- `stream`: receives tail text + relex offset, runs incremental lex + parse for new/changed blocks, returns heights + offsets + HTML for affected blocks.

**W19: Parse workers re-lex from raw strings, not serialized Tokens.**
Phase 2 parse batches send `{ index, raw }` — the block's raw markdown text, not serialized Token objects. The parse worker calls `marked.parser(marked.lexer(raw))` to reconstruct the token and produce HTML. This is the faster path:
- Structured-cloning a full Token object (which contains nested `tokens[]` arrays for inline markup) costs ~0.5ms per token via `postMessage`.
- Re-lexing a single block's raw text (~100-500 bytes) costs ~0.1ms — 5x cheaper than cloning the Token.
- The Phase 1 lex response returns only `heights[]` and `offsets[]` (flat number arrays). The Token objects never cross the worker boundary.
- Each Phase 2 parse worker independently reconstructs its batch's tokens from raw strings. No shared state, no coordination between workers.

**W08: Viewport-priority parsing with deep overscan and scroll coalescing.**
The worker pool receives parse requests only for blocks in the visible + overscan range. Getting overscan right is critical to the illusion that everything is always rendered. The scrollbar cannot hitch, judder, or show placeholders during aggressive scrolling.

Overscan tuning:
- Overscan of 3-5 screens above and below the viewport (tunable, not hardcoded).
- The HTML cache (W09) retains parsed blocks permanently (for the lifetime of the content), so scrolling back never re-parses.

Scroll coalescing:
- The scroll handler does NOT submit worker requests directly. Instead, it updates a `pendingScrollTop` variable and requests a coalescing frame via `requestAnimationFrame`.
- The RAF callback fires once per frame (~16ms). It computes the new visible+overscan range, diffs against the last submitted range, cancels any in-flight parse requests for blocks no longer in the range, and submits a new batch for uncached blocks in the new range.
- This means: rapid scrollbar dragging generates many scroll events per frame, but only ONE worker batch per frame. The pool never receives stale requests because each frame cancels the previous batch before submitting a new one.
- For large jumps (scrollbar yank from top to bottom), the entire new visible+overscan range is submitted as parallel batches across all workers. With 12 workers and ~120 overscan blocks, each worker handles ~10 blocks — completing in ~20ms, well under the next frame.

Placeholder strategy:
- If a block enters the viewport before its HTML arrives from the worker, render a placeholder `<div>` at estimated height. Replace with real content when the worker responds.
- The overscan depth should make placeholders a rare edge case, not the normal path.
- No CSS transition on the swap — transitions add latency and visual noise. The swap should be instantaneous; if the user can see it, the overscan isn't deep enough.

**W09: HTML cache, not pre-rendering.**
Parsed HTML strings are cached in a `Map<number, string>` on the main thread. The cache is populated by worker responses and never evicted (content is append-only per the content model). When a block enters the viewport: cache hit → sanitize + render immediately (synchronous, fast). Cache miss → submit to worker pool, show placeholder. This eliminates `scheduleIdleBatch` entirely.

**W10: DOMPurify only at render time.**
DOMPurify requires the DOM and cannot run in a worker. Sanitize only when a block enters the viewport and is about to be written to the DOM. Cost is bounded: only visible blocks, never more than ~60-100 at a time. The sanitization call is synchronous but fast (~0.5ms per block for typical markdown HTML).

**W11: Streaming path — batched, not per-delta.**
Streaming deltas arrive at ~25/second from the PropertyStore. Sending a worker request per delta would flood the pool with 25 messages/second, most of which would be superseded by the next delta before the worker finishes.

Instead, the streaming path coalesces:
- A `streamingDirty` flag is set on each `useSyncExternalStore` update.
- A `setInterval` at ~100ms (configurable) checks the flag. If dirty: read the accumulated text from the store, compute the tail diff, submit one `stream` task to a single worker (not the full pool — streaming tail-lex is sequential by nature). Clear the flag.
- The worker returns new/changed block metadata + HTML for blocks near the viewport.
- The main thread updates BlockHeightIndex (append new heights), updates the HTML cache for changed blocks, and re-renders if affected blocks are visible.
- Auto-scroll to tail uses RAF for the scroll position write [L05], same as Phase 3A.
- On `isStreaming` transition to false (turn_complete): one final `lex` of the full accumulated text for verification, same as Phase 3A's finalization pass but off-thread.

This bounds streaming worker traffic to ~10 requests/second regardless of delta rate, while keeping the display current within ~100ms of each delta.

**W12: Graceful degradation.**
If worker construction fails, the pool's fallback handler runs lex/parse/stream inline on the main thread via `queueMicrotask`. The viewport-only discipline (W08) still applies — the fallback never pre-renders all blocks. Performance is worse than the worker path but still far better than Phase 3A.

**W18: Height estimation as pluggable infrastructure.**
The Phase 3A `estimateBlockHeight()` function uses naive line-counting heuristics (paragraph = `ceil(text.length / 80) * LINE_HEIGHT`). This is inadequate for two reasons: (1) real content has variable-width fonts, padding, margins, and nested structures that make character-counting unreliable, and (2) MDX and React elements embedded in the document flow will have heights that cannot be estimated from text alone.

The height estimation logic must be shared between the worker (which estimates heights during Phase 1 lex) and the main thread (which uses the estimates for BlockHeightIndex). This means `estimateBlockHeight()` is a pure function in a shared module — importable by both the worker file and the component.

The height estimation system must be designed as pluggable infrastructure, not a hardcoded switch/case:
- **`HeightEstimator` interface** with an `estimate(tokenType: string, raw: string): number` method. Takes token type and raw text, returns estimated pixel height. Pure function, no DOM dependency — works in both main thread and worker.
- **Default text estimator** uses the current heuristic (line counting + constants) as a baseline. Good enough for plain markdown.
- **Measured-height feedback loop** already exists (ResizeObserver → `setHeight()`). The estimator's job is to get *close enough* that the placeholder-to-measured swap doesn't cause visible layout shift. Within 20% is the target.
- **Type-specific estimators** can be registered for block types that need special logic: code blocks (account for line numbers, header chrome, syntax highlighting padding), embedded React components (use a registered default height or query a component registry for preferred size), tables (estimate from row/column count + cell padding).
- **Learning estimator (future)** — after measuring N blocks of a given type, use the median measured height as the estimate for subsequent blocks of the same type. This converges quickly and adapts to theme changes, font size preferences, and container width.

This is forward-looking infrastructure. Phase 3A.2 implements the interface + default estimator + measured-height feedback. Phase 3B adds the code block estimator. MDX/React element estimators come when those content types arrive.

#### Work

**Step 1: Rip out `scheduleIdleBatch` and add HTML cache.**
Fix the immediate performance disaster before touching the worker pipeline. Remove `scheduleIdleBatch`, `RENDER_BATCH_SIZE`, `CHUNKED_CONTENT_THRESHOLD`, and all idle callback plumbing. Ensure `addBlockNode()` is called ONLY by `applyWindowUpdate()` (entering blocks) — never in a pre-render loop. Add an HTML cache (`Map<number, string>`) to `MarkdownEngineState`. Modify `addBlockNode()` to check the cache before calling `renderToken()`. Modify `removeBlockNode()` to NOT evict the cache entry (cache lives forever per content model). This alone should reduce the 1MB render from ~15s to ~200ms. Verify with the gallery card.

**Step 2: Extract shared height estimation module.**
Move `estimateBlockHeight()` and the height constants out of `tug-markdown-view.tsx` into a new shared module: `tugdeck/src/lib/markdown-height-estimator.ts`. Define the `HeightEstimator` interface. Implement `DefaultTextEstimator` using the existing heuristics. This module must be pure (no DOM, no React) so the worker can import it. Update `tug-markdown-view.tsx` and `block-height-index.ts` to import from the new module.

**Step 3: Create the markdown worker file.**
New file: `tugdeck/src/workers/markdown-worker.ts`. A plain `self.onmessage` handler with a switch on message type:
- `lex`: receives `{ type: 'lex', text: string }`. Runs `marked.lexer(text)`, filters space tokens, estimates heights via the shared estimator, computes byte offsets for each block. Returns `{ type: 'result', payload: { blockCount, heights: number[], offsets: number[] } }`. Does NOT return raw strings — the main thread has the original text and slices raws using the offsets.
- `parse`: receives `{ type: 'parse', batch: { index: number, raw: string }[] }`. Runs `marked.parser([reconstructedToken])` for each entry. Returns `{ type: 'result', payload: { results: { index: number, html: string }[] } }`.
- `stream`: receives `{ type: 'stream', tailText: string, relexFromOffset: number }`. Runs incremental tail-lex, estimates heights for new/changed blocks, parses blocks near the viewport hint. Returns `{ type: 'result', payload: { newBlocks: [...], changedBlocks: [...] } }`.

Static imports only: `import { marked } from 'marked'` and `import { DefaultTextEstimator } from '../lib/markdown-height-estimator'`. Sends `{ type: 'init' }` on load.

**Important:** Worker files are separate Vite entry points. The `@/` path alias from `vite.config.ts` may not resolve in the worker build — use relative imports (`../lib/...`) from the worker file to be safe. Verify with `bun run build` that the worker chunk includes the estimator module.

**Step 4: Wire TugMarkdownView to the two-phase pipeline.**
Replace the synchronous static rendering path:
- On `content` prop change: submit `lex` task to pool. On response: populate BlockHeightIndex from returned heights, store offsets in engine state (main thread slices raws from the original `content` string using these offsets), compute visible+overscan range, split uncached blocks into N batches and submit N `parse` tasks. On parse responses: populate HTML cache, sanitize + render visible blocks.
- On scroll: RAF-coalesced handler computes new visible+overscan range, diffs against last range, cancels stale parse tasks, submits new parse batch for uncached blocks. On response: populate cache, sanitize + render entering blocks.
- Create the pool at component mount: `new TugWorkerPool<MdWorkerReq, MdWorkerRes>(new URL('../workers/markdown-worker.ts', import.meta.url))`. Terminate on unmount.

**Step 5: Wire the streaming path to the batched worker model.**
Replace the synchronous streaming useEffect:
- Add `streamingDirty` flag and `streamingInterval` (100ms) to engine state.
- On `useSyncExternalStore` update: set `streamingDirty = true`.
- Interval callback: if dirty, read accumulated text, submit `stream` task to one worker with tail text and relex offset. On response: append new blocks to BlockHeightIndex, update HTML cache for changed blocks, re-render if visible, auto-scroll via RAF.
- On `isStreaming` → false: submit final `lex` of full text for verification (finalization pass), reconcile, clear interval.

**Step 6: Add placeholder blocks for async rendering.**
When `addBlockNode()` encounters a cache miss: create a `<div class="tugx-md-block tugx-md-placeholder">` at estimated height. Store a reference. When the worker responds and the HTML cache is populated, check if the placeholder is still in the DOM (block still in viewport). If so, replace its innerHTML with the sanitized HTML and remove the placeholder class. No CSS transition — if the user sees the swap, the overscan isn't deep enough.

**Step 7: Update gallery card diagnostics.**
Add to the diagnostic overlay: worker pool size, in-flight parse tasks, HTML cache size, cache hit rate (hits / (hits + misses) since last content load). These metrics are essential for tuning overscan depth and batch size.

**Step 8: Performance verification and stress test.**
Run the gallery card through all three modes:
- Static 1MB: viewport visible in <200ms, scroll to any position jank-free, DOM nodes <500.
- Static 10MB: viewport visible in <200ms, scrollbar yank test (drag top to bottom in <1s, zero judder).
- Streaming: 60fps, zero dropped frames during 5000+ word stream, auto-scroll smooth.
Profile with Chrome DevTools Performance tab. Verify: zero long tasks (>50ms) on main thread during any operation. All `marked.parser()` calls happen in worker threads. `DOMPurify.sanitize()` only for visible blocks.

#### Checkpoints

- `bun test` — all existing BlockHeightIndex + RenderedBlockWindow tests still pass.
- `bun test` — new tests for HeightEstimator interface, DefaultTextEstimator, HTML cache behavior.
- `bunx tsc --noEmit` — no new type errors (pre-existing errors in unrelated files are acceptable).
- `bun run build` — build succeeds, markdown worker chunk emitted alongside pool worker chunk.
- Gallery card: 1MB static content appears in <200ms. DOM node count stays <500. Scrolling is jank-free.
- Gallery card: 10MB stress test — viewport appears in <200ms, scrollbar yank test passes.
- Gallery card: streaming mode — 60fps, no dropped frames during 5000+ word stream.
- Gallery diagnostic: cache hit rate, in-flight tasks, pool size all visible and updating.
- Chrome DevTools Performance tab: zero long tasks (>50ms) on main thread during any rendering operation.

#### Exit criteria

- Zero synchronous `marked.parser()` or `DOMPurify.sanitize()` calls for off-screen blocks.
- Zero compute-intensive work on the main thread. Lexing, parsing, and height estimation run in workers only.
- Main thread never blocks for more than 16ms (one frame) during any rendering operation.
- Worker pool processes visible+overscan blocks first; blocks beyond overscan are never pre-parsed.
- 1MB document: viewport visible in <200ms, full scroll range navigable immediately.
- 10MB document: viewport visible in <200ms, scroll to any position in <16ms.
- **Scrollbar yank test:** grab the scrollbar thumb and drag it from top to bottom of a 10MB document in under 1 second. Zero judder, zero placeholder flashes, zero dropped frames. The overscan depth and parallel worker throughput must make this seamless.
- Streaming: 60fps, zero jank for 5000+ words of live deltas.
- `HeightEstimator` interface implemented. Default text estimator produces heights within 20% of measured for standard markdown blocks. BlockHeightIndex accepts a pluggable estimator.
- Graceful degradation: works (slower) without worker.

#### Risks

- R03: **Phase 1 lex response payload size.** Resolved by design: Phase 1 returns `heights: number[]` + `offsets: number[]` (~80KB for 5,000 blocks), not the raw text strings. The main thread already has the original `content` string and slices block raws using the offsets. For a 10MB document, the Phase 1 response is still ~80KB — structured clone cost is negligible (~1ms).
- R04: **Placeholder-to-real swap layout shift.** Mitigation: ResizeObserver measurement + prefix sum recomputation handles this (same mechanism as Phase 3A). The pluggable HeightEstimator (W18) allows type-specific estimation that gets closer to measured heights. The learning estimator (future) will converge after measuring a few blocks of each type. For MDX/React elements, a component registry can provide preferred heights before first render. Deep overscan (W08) should make placeholder visibility rare.
- R05: **Worker pool initialization time.** The pool spawns N workers lazily on first submit. Each worker loads `marked` (~50ms). For 12 workers, that's ~50ms wall time (parallel spawn) + init handshake. Mitigation: create the pool at component mount time (not first content load). The Phase 1 lex request naturally triggers the first worker spawn; by the time Phase 2 parse batches are submitted, most workers should be ready.

#### TugWorkerPool hardening (deferred from Phase 3A.1 review)

These issues were identified during code review of TugWorkerPool but deferred to this phase, where a real consumer exercises the pool under load:

1. **`collectTransferables` walks the entire payload object tree.** For markdown payloads (plain strings), this is wasted work. Evaluate under real load — if profiling shows measurable cost, make transferable detection opt-in (caller passes explicit transferables list) or short-circuit for primitive/string payloads.

2. **Idle timeout respawns the full pool as a batch.** When all workers idle-terminate and `_spawned` resets, the next `submit()` re-creates all N workers at once, paying init handshake cost × N. Under real usage patterns (bursts of scroll-driven parsing separated by idle periods), evaluate whether per-slot lazy respawn is needed to avoid startup latency spikes.

3. **Least-busy dispatch is untested with real workers.** The unit test uses fallback mode (single inline executor), which doesn't exercise multi-slot dispatch. Add a test with real workers that submits tasks with varying durations and verifies they distribute across slots — e.g., submit N slow tasks + 1 fast task and confirm the fast task doesn't queue behind the slow ones on a single worker.

4. **Init handshake timeout path is untested.** A worker that never sends `{ type: 'init' }` should still process tasks after the timeout fires. Add a test with a delayed-init worker to verify the timeout → ready → flush-queue path works.

---

### Phase 3A.3: Worker Pipeline Remediation {#worker-pipeline-remediation}

**Status:** Not started.

**Goal:** Fix all issues that make the Phase 3A.2 worker pipeline non-functional in the browser. The code passed all bun tests but rendered nothing — a blank screen with zero DOM nodes. This phase does not add features. It makes the existing code work correctly and conform to the Tuglaws.

**Inputs:** Phase 3A.2 code (TugWorkerPool, markdown-worker.ts, TugMarkdownView worker pipeline). Audit findings from post-merge debugging session.

#### What went wrong in Phase 3A.2

Three failures compounded to produce a completely non-functional component that silently showed a blank screen:

**Failure 1: Vite could not detect the worker entry point.**
TugWorkerPool's original constructor accepted a `URL` and called `new Worker(url, { type: "module" })` internally. Vite's static analysis requires the `new Worker(new URL(...))` pattern to be a single expression in the source — split across files, Vite cannot detect it. The production build emitted a raw 8.58 kB `.ts` stub instead of a properly bundled `.js` worker. The browser received TypeScript it couldn't execute. The worker errored on load.

This was fixed during debugging by changing TugWorkerPool to accept a `WorkerFactory` (`() => Worker`) and using the `new Worker(new URL(...))` expression inline at the call site. The production build now emits a properly bundled 41.24 kB `.js` worker file with all dependencies (marked, height estimator) included. The API change is correct and should be kept.

**Failure 2: Silent error swallowing.**
Four `.catch(() => {})` handlers in tug-markdown-view.tsx swallowed every error from the worker pipeline — worker load failures, pool terminations, message routing errors. The component showed a blank screen with zero console output. Diagnosing the root cause took hours because the code actively hid its own failures. This violates basic engineering practice: errors that affect user-visible behavior must never be silently swallowed.

This was fixed during debugging by replacing all four handlers with logging that filters out expected cancellations and logs everything else. The fix should be kept.

**Failure 3: Pool lifecycle owned by React.**
The pool was created in `useLayoutEffect` and terminated in its cleanup function. React reconciliation destroyed the pool while a lex task was in flight, producing "pool terminated" errors. The gallery card's mode switching (which unmounts and remounts TugMarkdownView) triggered this reliably.

This was fixed during debugging by moving the pool to module scope. The pool is now a singleton created at module load time — React cannot touch it. Component unmount cancels in-flight tasks but does not terminate the pool. This is correct per L06: the pool is infrastructure, not appearance state.

#### Remaining issues from audit

The debugging session fixed the three showstoppers above. The following issues remain:

**Issue 1: L05 violation — auto-scroll RAF gated on React state commit (lines 768-789).**
A `useEffect` depends on `[streamingText, isStreaming]`. When React commits a new `streamingText`, the effect schedules a RAF to write `scrollTop`. But the height index is updated by the worker's stream response on a separate 100ms interval — not by the React commit. The RAF reads `heightIndex.getTotalHeight()` which may not yet reflect the commit that triggered the effect.

L05: "Never use requestAnimationFrame for operations that depend on React state commits. RAF timing relative to React's commit cycle is a browser implementation detail, not a contract." [D79]

The auto-scroll effect also violates the spirit of L05 as described in react-anti-patterns.md: "every `requestAnimationFrame` used to paper over a React timing gap is a latent bug waiting for a browser update or a React version bump to expose it."

**Issue 2: Pool `onerror` does not switch to fallback mode (tug-worker-pool.ts lines 359-362).**
When a worker errors during execution (not construction), the slot is removed and `_spawned` resets to `false`. The next `submit()` retries worker creation — which may fail again, creating an infinite failure loop. The pool has a `fallbackHandler` (mainThreadFallback) that works correctly, but never engages it when workers die at runtime.

**Issue 3: L16 — missing `@tug-renders-on` annotations in CSS.**
tug-markdown-view.css sets border colors in three rules (blockquote line 121, hr line 138, table line 153) without `background-color` in the same rule and without `@tug-renders-on` annotations. L16: "If a CSS rule sets `color`, `fill`, or `border-color` without setting `background-color` in the same rule, it must include a `@tug-renders-on` annotation."

**Issue 4: Browser verification.**
The factory-based worker pattern (`new Worker(new URL(...))` inside a closure) has not been verified working in the browser runtime. The production build emits the correct output (41 kB bundled `.js`), but the actual round-trip — worker loads in browser, sends init, receives lex task, responds with heights/offsets — must be confirmed.

#### Steps

**Step 1: Fix L05 — move auto-scroll into stream response handler.**
Remove the auto-scroll `useEffect` (lines 768-789). Move the scroll-to-tail logic into the stream response `.then()` callback, after heights are reconciled. The scroll write still uses RAF (correct — it's a DOM write per L06), but the trigger is the worker response completing, not React committing a new `streamingText` value. This eliminates the timing gap where the RAF reads stale height data.

Verify: streaming mode in gallery card auto-scrolls to tail as content arrives. No separate `useEffect` with `[streamingText]` dependency.

**Step 2: Fix pool `onerror` fallback.**
In `_createSlot()`'s `worker.onerror` handler: when `this._slots.length === 0` after removing the broken slot, check `this._fallbackHandler`. If defined, set `this._fallbackMode = true` and log `console.warn("[TugWorkerPool] All workers failed — switching to fallback mode")`. If not defined, reset `this._spawned = false` (existing behavior — allows retry on next submit).

Verify: bun test passes. Manually test by temporarily breaking the worker URL — component should render via fallback path with console warning.

**Step 3: Add `@tug-renders-on` annotations to CSS.**
Add `/* @tug-renders-on --tugx-md-block-bg */` (or the appropriate surface token) to the three CSS rules that set border-color without background-color: blockquote (line 121), hr (line 138), table borders (line 153).

Verify: `audit-tokens lint` passes (if available), or visual inspection confirms annotations are present.

**Step 4: Browser verification.**
Load the gallery card in the browser. Verify all three modes:
- **Static 1MB:** Content renders. DOM nodes > 0. Blocks > 0. No `[TugMarkdownView]` error logs in console. Worker diagnostics (Pool, In-flight, Cache, Hit rate) visible and updating.
- **Streaming:** Content streams incrementally. Auto-scroll follows tail. No errors. Progress shows chunk count advancing.
- **Stress 10MB:** Content renders. DOM nodes < 500. Scrolling is navigable.

If the worker fails to load: verify `[TugWorkerPool] All workers failed — switching to fallback mode` appears in console and content still renders (slower).

#### Checkpoints

- `bun test` — all existing tests pass (1645+).
- `bun run build` — build succeeds, `markdown-worker-*.js` chunk is properly bundled (40+ kB, not a raw `.ts` stub).
- Browser: Static 1MB renders with content visible.
- Browser: Streaming mode renders with auto-scroll.
- Browser: No `[TugMarkdownView]` error logs in console.
- Browser: Worker diagnostics display in gallery card overlay.

#### Exit criteria

- L05 violation resolved: no `useEffect` + RAF combination that depends on React state commits. Auto-scroll triggered by worker response, not React commit.
- Pool `onerror` correctly engages fallback mode when all workers die and `fallbackHandler` exists.
- CSS annotations satisfy L16 for all border-color rules.
- Gallery card renders content in the browser in all three modes (static, streaming, stress).
- Zero silent error swallowing. Every `.catch()` logs non-cancellation errors.
- All four `.catch()` handlers in tug-markdown-view.tsx log with `[TugMarkdownView]` prefix.

---

### Phase 3A.4: WASM Markdown Pipeline {#wasm-markdown-pipeline}

**Status:** Not started.

**Goal:** Replace the entire worker-based markdown pipeline with a pulldown-cmark WASM module that runs synchronously on the main thread. Remove all worker infrastructure. The result is a TugMarkdownView that renders 1MB in under 50ms and 10MB in under 200ms, with no workers, no async chains, no Vite detection issues, and full Tuglaws compliance.

**Inputs:** Phase 3A code (BlockHeightIndex, RenderedBlockWindow — these are keepers). Spike benchmark results: pulldown-cmark WASM lexes+parses 1MB in 14ms and 10MB in 132ms on JSC (Safari/WKWebView). `marked.lexer()` takes 15,000ms for the same 1MB — a confirmed JSC regex regression (marked issue #2863).

#### Why the worker model is being removed

The worker infrastructure (TugWorkerPool, markdown-worker.ts, fallback handler, init handshake, Vite worker detection) was built to work around a slow lexer. With pulldown-cmark WASM performing lex + full HTML generation for 1MB in 14ms — fast enough to run synchronously before the next frame — the entire worker model is unnecessary complexity:

- **Vite worker detection** caused a completely non-functional component (blank screen, silent errors). The `new Worker(new URL(...))` pattern must be a single expression for Vite's static analysis; splitting it across files broke the production build.
- **Pool lifecycle owned by React** caused "pool terminated" errors during reconciliation. Moving the pool to module scope was a patch, not a fix.
- **Silent `.catch(() => {})` handlers** swallowed every error, making diagnosis take hours.
- **The two-phase async pipeline** (lex → `.then()` → parse → `.then()`) created race conditions with `blockWindow.update()` consuming enter ranges, leaving the parse handler with empty diffs.
- **The L05 violation** (RAF gated on React state commits) was an inherent consequence of bridging async worker responses into React's commit cycle.

None of these problems exist when the pipeline is synchronous. The WASM module returns results immediately — no promises, no message passing, no init handshakes, no cancellation protocol.

The worker pool (TugWorkerPool) may have future uses, but not for markdown. If a future feature needs off-thread work, the pool can be rebuilt from the existing code. For now, it goes — completely, no vestiges.

#### What we keep from Phases 3A–3A.3

| Feature | Source | Status |
|---------|--------|--------|
| **BlockHeightIndex** | Phase 3A | KEEP — prefix sum, binary search, lazy recomputation. Proven correct, well-tested. |
| **RenderedBlockWindow** | Phase 3A | KEEP — sliding window, enter/exit diffing, spacer computation. Proven correct, well-tested. |
| **Virtual scroll layout** | Phase 3A | KEEP — spacer divs, `overflow-y: auto`, DOM-only block management per L06. |
| **DOMPurify sanitization at render time** | Phase 3A.2 | KEEP — sanitize HTML when writing to DOM, never before. |
| **Streaming via useSyncExternalStore** | Phase 3A | KEEP — PropertyStore + useSyncExternalStore for streaming text per L02. |
| **Gallery card** | Phase 3A.2 | KEEP (rewrite) — Static 1MB, Streaming, Stress 10MB modes with diagnostic overlay. |
| **CSS file** | Phase 3A.2 | KEEP — scroll container, spacer, block, placeholder styles with L16 annotations. |
| **HeightEstimator interface** | Phase 3A.2 | EVALUATE — may be simpler to estimate directly from WASM block metadata (type + byte length). |

| Feature | Source | Status |
|---------|--------|--------|
| **TugWorkerPool** | Phase 3A.1 | REMOVE — 623 lines. |
| **markdown-worker.ts** | Phase 3A.2 | REMOVE — 234 lines. |
| **Worker fallback handler** | Phase 3A.2 | REMOVE — mainThreadFallback in tug-markdown-view.tsx. |
| **Worker pool tests** | Phase 3A.1–3A.2 | REMOVE — tug-worker-pool.test.ts, integration test, hardening test, echo/slow/delayed-init workers. |
| **markdown-pipeline.test.ts** | Phase 3A.2 | REMOVE — tests the worker pipeline fallback mode. |
| **markdown-height-estimator.ts** | Phase 3A.2 | EVALUATE — may fold into WASM or simplify. |
| **MdWorkerReq/MdWorkerRes types** | Phase 3A.2 | REMOVE — discriminated union for worker messages. |
| **Pool creation, init handshake, task handles** | Phase 3A.2 | REMOVE — all pool lifecycle code in tug-markdown-view.tsx. |

#### Build infrastructure: tugmark-wasm

The spike lives at `tugdeck/crates/tugmark-wasm/`. This becomes a permanent part of the build:

**Crate structure:**
```
tugdeck/crates/tugmark-wasm/
├── Cargo.toml          # pulldown-cmark + wasm-bindgen
├── src/lib.rs          # lex_blocks(), parse_to_html()
└── pkg/                # wasm-pack output (committed)
    ├── tugmark_wasm.js       # JS glue (wasm-bindgen generated)
    ├── tugmark_wasm.d.ts     # TypeScript declarations
    └── tugmark_wasm_bg.wasm  # WASM binary (~240KB)
```

**Build command:** `/Users/kocienda/.cargo/bin/wasm-pack build --target web --release tugdeck/crates/tugmark-wasm`

**justfile integration:** Add a `wasm` recipe that builds tugmark-wasm. Add it as a dependency of `app` (which already builds tugdeck). The `build` recipe (Rust binaries) does NOT include WASM — different toolchain, different target. Keep them separate.

```
# Build WASM modules
wasm:
    wasm-pack build --target web --release tugdeck/crates/tugmark-wasm

# Build the Mac app (with all dependencies)
app: build wasm
    ...
```

**Developer setup:** `rustup target add wasm32-unknown-unknown && cargo install wasm-pack`. One-time, takes seconds. Document in a setup section or README.

**Vite integration:** The `pkg/` output is a standard ES module. Import the JS glue from the component:
```typescript
import init, { lex_blocks, parse_to_html } from "@/lib/tugmark-wasm/tugmark_wasm.js";
```
Configure Vite to serve the `.wasm` file as an asset. The `init()` call loads the WASM binary asynchronously — call it once at app startup (not per-component). After init, `lex_blocks()` returns a `Uint32Array` (packed binary, 4 words per block) and `parse_to_html()` returns a string. Both are synchronous.

**Commit the pkg/ output.** The WASM binary is a build artifact, not source. Committing it means developers don't need wasm-pack for normal TypeScript work — only for modifying the Rust code. The justfile `wasm` recipe rebuilds it when needed.

#### Data transport: packed binary, not JSON

The spike used JSON strings (`serde_json::to_string` → `JSON.parse`). Production uses packed `Vec<u32>` via wasm-bindgen. Each block is 4 u32 words (16 bytes):

| Word | Contents |
|------|----------|
| 0 | `type:u8 \| depth:u8<<8` |
| 1 | `start:u32` (byte offset into source text) |
| 2 | `end:u32` (byte offset into source text) |
| 3 | `item_count:u16 \| row_count:u16<<16` |

For 8000 blocks: 128KB as a flat `Uint32Array`. wasm-bindgen returns `Vec<u32>` as a single memcpy from WASM linear memory into a JS typed array — no serialization, no string encoding, no parsing. The JS side decodes inline with bit shifts.

`parse_to_html(text) -> String` stays as-is (HTML is naturally a string).

The combined `lex_and_parse()` from the spike is removed. Production API is two functions:
- `lex_blocks(text) -> Vec<u32>` — returns packed block metadata
- `parse_to_html(text) -> String` — returns HTML for a single block's raw text

Remove the `serde` and `serde_json` dependencies from Cargo.toml.

#### Architecture: synchronous WASM pipeline

The new pipeline is radically simpler than the worker model:

```
STATIC PATH (content prop change):
────────────────────────────────────
  content string
      │
      ├─ lex_blocks(content)           ← WASM, synchronous, ~7ms for 1MB
      │  returns: Uint32Array, 4 words per block (type, start, end, meta)
      │
      ├─ populate BlockHeightIndex     ← estimate height from block type + byte length
      │  store block offsets            ← start/end from packed array
      │
      ├─ blockWindow.update(scrollTop) ← compute visible range
      │  applyWindowUpdate()           ← create DOM nodes for entering blocks
      │
      └─ for each visible block:
           raw = content.slice(block.start, block.end)
           html = parse_to_html(raw)   ← WASM, synchronous, <1ms per block
           sanitize + innerHTML         ← DOMPurify at render time [D04]

SCROLL (onScroll handler):
──────────────────────────
  scrollTop
      │
      ├─ blockWindow.update(scrollTop)
      │  applyWindowUpdate()           ← enter/exit blocks
      │
      └─ for each entering block:
           html = parse_to_html(raw)   ← cache hit or WASM call
           sanitize + innerHTML

STREAMING PATH (useSyncExternalStore update):
─────────────────────────────────────────────
  streamingText (from PropertyStore via useSyncExternalStore [L02])
      │
      ├─ incremental tail lex:
      │    tail = streamingText.slice(lastStableOffset)
      │    lex_blocks(tail)            ← WASM, <1ms for typical delta
      │    remap offsets: add lastStableOffset to each start/end
      │
      ├─ reconcile BlockHeightIndex    ← append new blocks, update changed
      │
      ├─ blockWindow.update(scrollTop)
      │  applyWindowUpdate()
      │
      └─ auto-scroll to tail           ← direct DOM write [L06]
```

**Streaming uses incremental tail-lex, not full re-lex.** Each delta triggers a lex of only the text from the last stable block boundary forward. For a typical 200-character delta appended to a 500KB document, the tail is ~500 bytes — lex cost is <0.1ms regardless of document size. The "last stable boundary" is the `end` offset of the second-to-last block from the previous lex (the last block may be incomplete during streaming).

This keeps per-delta cost constant. No coalescing interval needed. No threshold for switching strategies. Every delta is cheap.

**Full re-lex** happens only on finalization (when `isStreaming` transitions to false) — one final `lex_blocks(fullText)` to verify block count and boundaries. For a typical conversation (<100KB), this is <1ms. For stress-test 1MB, it's ~7ms.

No promises. No `.then()` chains. No message passing. No cancellation protocol. No init handshake. No fallback handler. The WASM calls return immediately with the answer.

**Laws compliance:**
- **L02:** Streaming text enters via `useSyncExternalStore` — unchanged.
- **L05:** No RAF depends on React state commits. Auto-scroll writes `scrollTop` directly after WASM returns heights — no async gap.
- **L06:** All appearance changes (spacer heights, block DOM, scroll position) via direct DOM writes — unchanged.
- **L07:** WASM module is a stable singleton. No closures over stale state.
- **L16:** CSS annotations carried forward from Phase 3A.3.

#### Steps

**Step 1: Productionize tugmark-wasm.**
Move spike to production quality:
- Rewrite `lib.rs`: remove `serde`, `serde_json`, and the `lex_and_parse()` combined function. Production API is two functions: `lex_blocks(text) -> Vec<u32>` (packed binary, 4 words per block) and `parse_to_html(text) -> String`.
- Proper error handling (no `.unwrap()` in production paths).
- Add `justfile` `wasm` recipe. Add as dependency of `app`.
- Commit the `pkg/` output so developers don't need wasm-pack for normal TypeScript work.
- Document developer setup (wasm-pack, wasm32 target) in the justfile or a README.

Verify: `just wasm` builds cleanly. The `pkg/` output imports correctly from TypeScript. `bun run build` includes the WASM asset.

**Step 2: Delete all worker infrastructure.**
Clean slate before building the new pipeline. Delete these files entirely:
- `tugdeck/src/lib/tug-worker-pool.ts` (623 lines)
- `tugdeck/src/workers/markdown-worker.ts` (234 lines)
- `tugdeck/src/__tests__/tug-worker-pool.test.ts`
- `tugdeck/src/__tests__/tug-worker-pool.integration.test.ts`
- `tugdeck/src/__tests__/tug-worker-pool.hardening.test.ts`
- `tugdeck/src/__tests__/markdown-pipeline.test.ts`
- `tugdeck/src/__tests__/workers/echo-worker.ts`
- `tugdeck/src/__tests__/workers/slow-worker.ts`
- `tugdeck/src/__tests__/workers/delayed-init-worker.ts`
- `tugdeck/src/lib/markdown-height-estimator.ts` (height estimation is simpler with WASM block metadata)
- `tugdeck/src/__tests__/markdown-height-estimator.test.ts`

Strip tug-markdown-view.tsx down to a skeleton:
- Remove `import { marked }`.
- Remove `import { TugWorkerPool }` and `import type { TaskHandle }`.
- Remove `mainThreadFallback` function.
- Remove `MdWorkerReq`, `MdWorkerRes` types.
- Remove `_pool` module-level singleton.
- Remove all `.catch()` handlers for worker promise chains.
- Remove `inFlightParses`, `streamingDirty`, `streamingInterval`, `submitParseBatches`, `cancelInFlightParses` from engine state and component body.
- Keep: BlockHeightIndex, RenderedBlockWindow, virtual scroll layout (spacers, refs, CSS), DOMPurify, useSyncExternalStore for streaming, addBlockNode/removeBlockNode/applyWindowUpdate/rebuildWindow (these are DOM manipulation per L06), onScroll handler, engine state ref.

Verify: `bun test` passes (remaining tests: block-height-index, rendered-block-window). `bun run build` succeeds — no worker chunk, no `tug-worker-pool` import, no `markdown-worker` import anywhere. The component won't render content yet (no lex/parse wired), but it compiles.

**Step 3: Wire WASM into TugMarkdownView (static path).**
Build the static rendering path on the clean skeleton:
- Add WASM init to `main.tsx` startup sequence (parallel with layout/theme fetch).
- Import `lex_blocks`, `parse_to_html` from the tugmark-wasm pkg.
- Update `MarkdownEngineState`: replace the old `blockOffsets: number[]` (cumulative end offsets from the worker pipeline) with `blockStarts: number[]` and `blockEnds: number[]` — direct start/end pairs decoded from the WASM packed `Uint32Array`. Each block's raw text is `content.slice(blockStarts[i], blockEnds[i])`. Update all references.
- On content change: call `lex_blocks(content)` synchronously. Decode the `Uint32Array` (4 words per block: type|depth, start, end, itemCount|rowCount). Populate `blockStarts`/`blockEnds`. Populate BlockHeightIndex with estimated heights (from block type + byte length). Store block count.
- Call `blockWindow.update(scrollTop)` → `applyWindowUpdate()` to enter visible blocks.
- For each visible block: `raw = content.slice(blockStarts[i], blockEnds[i])`, `html = parse_to_html(raw)`, sanitize with DOMPurify, write to innerHTML.
- HTML cache: `Map<number, string>` for parsed HTML. Cache hit skips WASM parse + DOMPurify.
- Parse only visible + overscan blocks on initial load. Remaining blocks parsed on scroll (cache miss → WASM call).

Verify: gallery card Static 1MB renders. DOM nodes > 0. Lex time < 50ms in diagnostic.

**Step 4: Wire WASM into TugMarkdownView (streaming path).**
Build the streaming path using incremental tail-lex:
- On `useSyncExternalStore` update: compute `lastStableOffset` (end of second-to-last block from previous lex). Slice tail: `tail = streamingText.slice(lastStableOffset)`. Call `lex_blocks(tail)` — cost is <0.1ms for typical delta regardless of document size. Remap offsets by adding `lastStableOffset` to each start/end.
- Reconcile: compare new tail blocks against existing. Append new blocks to BlockHeightIndex. Update changed blocks.
- Parse visible blocks. Update DOM. Auto-scroll to tail via direct `scrollTop` write [L06].
- On finalization (`isStreaming` → false): one full `lex_blocks(fullText)` to verify boundaries, then rebuild.

Verify: gallery card Streaming mode renders, auto-scrolls, no jank. Per-delta cost < 1ms regardless of document size.

**Step 5: Cleanup, verification, and laws audit.**

Dead code removal in tug-markdown-view.tsx:
- Remove `rafHandle` from MarkdownEngineState and its cleanup in the unmount handler. Auto-scroll no longer uses RAF — the field is never set.
- Remove `accumulatedText` from MarkdownEngineState if nothing reads it outside the streaming observer.
- Remove `byteToCharMap` from MarkdownEngineState if it's only used as a local variable inside `lexParseAndRender` and the streaming observer (rebuilt each call, never read between calls).
- Final stale comment sweep: remove any remaining references to workers, "Phase 1", D08, or other artifacts of the old worker architecture.

Gallery card updates (gallery-markdown-view.tsx):
- Add WASM diagnostics to the overlay: lex time (ms), parse time (ms), block count.
- Keep DOM node count and streaming progress.

Spike cleanup (tugdeck/crates/tugmark-wasm/bench.html):
- Update or remove. The current bench.html references `lex_blocks_json` which no longer exists. Either update to reflect the current API or remove the file.

Run all three gallery modes and verify:
- **Static 1MB:** Viewport visible in <50ms. Scroll jank-free. DOM nodes <500.
- **Stress 10MB:** Viewport visible in <200ms. Scrollbar navigable.
- **Streaming:** Content streams smoothly. Auto-scroll follows tail.
- **Console:** Zero errors. Timing visible in diagnostics.

Final laws audit — full pass over tug-markdown-view.tsx against tuglaws/:
- L01: no root.render() calls.
- L03: all DOM setup uses useLayoutEffect, not useEffect.
- L05: no RAF gated on React state commits.
- L06: all appearance changes via DOM, no React state.
- L07: all handlers access current state through refs, no stale closures.
- L16: CSS annotations present for all border-color rules (tug-markdown-view.css).
- L19: docstring, props interface, data-slot, file pair all present and accurate.
- L22: streaming observes store directly, no React round-trip.
- Verify: zero useEffect in the component. Zero useSyncExternalStore. Zero useState.

#### Checkpoints

- `just wasm` builds tugmark-wasm cleanly.
- `bun run build` succeeds. No worker chunk in output. WASM asset included.
- `bun test` passes — existing BlockHeightIndex + RenderedBlockWindow tests unaffected.
- No `tug-worker-pool` import exists anywhere in `tugdeck/src/`.
- No `markdown-worker` import exists anywhere in `tugdeck/src/`.
- No `.catch(() => {})` exists anywhere in `tugdeck/src/`.
- Gallery card: Static 1MB renders in <50ms (measured via diagnostic overlay).
- Gallery card: Streaming renders and auto-scrolls.
- Gallery card: Stress 10MB renders in <200ms.

#### Exit criteria

- TugMarkdownView renders all three gallery modes correctly in the browser.
- Static 1MB: viewport visible in <50ms. Full document navigable via scroll.
- Stress 10MB: viewport visible in <200ms.
- Streaming: smooth at 60fps for 5000+ words.
- Zero worker infrastructure remains in the codebase. No TugWorkerPool, no markdown-worker, no worker test fixtures.
- Full Tuglaws compliance: L02 (useSyncExternalStore for streaming), L05 (no RAF on React commits), L06 (DOM-only appearance changes), L07 (refs/singletons, no stale closures), L16 (CSS annotations), L19 (component authoring).
- WASM build integrated into justfile. Developer setup documented.
- pulldown-cmark handles all GFM block types: headings, paragraphs, code blocks, lists, blockquotes, tables, horizontal rules, HTML blocks.

#### WASM initialization

`WebAssembly.instantiate()` returns a promise. The WASM module must be initialized before any `lex_blocks()` or `parse_to_html()` call. This is handled by the existing app startup sequence in `main.tsx`.

The app already has an async IIFE (line 44) that fetches layout, theme, and deck state in parallel before constructing DeckManager (and thus before `root.render()` — L01). WASM init joins this parallel fetch:

```typescript
const [layout, theme, focusedCardId] = await Promise.all([
  fetchLayoutWithRetry(),
  fetchThemeWithRetry(),
  fetchDeckStateWithRetry(),
  initTuglex(),  // WASM init — parallel with settings fetches
]);
```

After the `await`, `lex_blocks()` and `parse_to_html()` are synchronous function calls. Every component is guaranteed WASM is ready because `DeckManager` construction happens after the `await`. No ready flag, no fallback, no conditional checks. If WASM init fails, the `await` throws and the app doesn't start — same as any other critical init failure.

**Laws compliance:** L01 is preserved — `root.render()` still happens exactly once, after all init completes. Components call WASM functions synchronously; no async gap bridging into React's commit cycle (L05). No external state entering React (L02 not involved).

---

### Phase 3A.5: Region Model, Imperative API, and Gallery Card Rework {#region-model}

**Status:** Not started.

**Goal:** Add an addressable region model to TugMarkdownView — an ordered list of keyed content regions, each containing markdown text. Replace the `content` prop with an imperative handle API (`setRegion`, `removeRegion`, `clear`). Rework the gallery card to use action buttons that add content instead of mode-switching buttons. This makes the component ready for real conversation rendering, where messages arrive with IDs and are updated after initial display.

**Inputs:** Phase 3A.4 TugMarkdownView (WASM pipeline, virtual scroll, laws-compliant). Gallery card.

#### Why regions

A conversation is an ordered sequence of messages, each identified by a message ID. Messages are not static — they change after initial rendering:

- A streaming assistant message accumulates text delta by delta, then finalizes.
- A thinking block starts as "Thinking..." and gets replaced with full reasoning text.
- A tool use block shows "Running grep..." then completes with the result.
- Messages can be edited, compacted, or removed.

The component needs to accept content updates *by key* — "update the text for message X" — without touching other messages. The current `content` prop model provides no addressing: the caller passes one big string, the component lexes and renders the whole thing. Every change is a full replacement.

The region model adds addressing. Each region has a key (a message ID, a thinking block ID, etc.) and a markdown text string. The full document is the concatenation of all regions in display order. When one region changes, only its blocks are re-parsed; other regions' blocks are untouched.

#### Data structure: RegionMap

Research into document model libraries (ProseMirror, Yjs, CodeMirror 6, Lexical) concluded that all are massively over-engineered for this use case. We don't need collaborative editing, character-level operations, tree structures, or CRDT semantics. We need an ordered list of keyed text blobs.

The implementation is ~30 lines of code, zero dependencies:

```typescript
class RegionMap {
  private _order: string[] = [];           // region keys in display order
  private _content = new Map<string, string>(); // key → markdown text
  private _text = "";                       // cached concatenation
  private _regionOffsets: number[] = [];    // cumulative char offsets per region

  /** Insert or update a region. If key exists, update in place. If new, append at end. */
  setRegion(key: string, text: string): void { ... }

  /** Remove a region by key. */
  removeRegion(key: string): void { ... }

  /** Clear all regions. */
  clear(): void { ... }

  /** The full concatenated text of all regions. */
  get text(): string { return this._text; }

  /** Number of regions. */
  get regionCount(): number { return this._order.length; }

  /** Given a char offset in the concatenated text, return which region key owns it. */
  regionKeyAtOffset(offset: number): string | undefined { ... }

  /** Get the char range [start, end) for a region's text within the concatenated string. */
  regionRange(key: string): { start: number; end: number } | undefined { ... }
}
```

- `_order` is a `string[]` — insertion order is explicit, supports insertion at position.
- `_content` is a `Map<string, string>` — O(1) lookup by key.
- `_text` is rebuilt on mutation by joining all region texts with a separator (double newline `\n\n` between regions, which is markdown's block separator).
- `_regionOffsets` caches cumulative start offsets, rebuilt alongside `_text`.

When a single region changes, the optimization path: only rebuild `_text` from the changed region forward (splice the old region text out, splice new in, update offsets for subsequent regions). For the common case (updating the last region — streaming), this is O(1) string concatenation.

#### Imperative API

```typescript
export interface TugMarkdownViewHandle {
  /** Insert or update a content region by key. If key exists, update in place. If new, append. */
  setRegion(key: string, text: string): void;
  /** Remove a content region by key. */
  removeRegion(key: string): void;
  /** Clear all content regions and reset the view. */
  clear(): void;
}
```

The component uses `React.forwardRef` + `useImperativeHandle` to expose the handle. Each method:

- **`setRegion(key, text)`** — updates the RegionMap, gets the new concatenated `_text`, does lex+parse+render. For a new region or update to the last region: incremental (same logic as the streaming observer — diff blocks, update changed, append new). For an update to a middle region: full re-lex+parse (the block boundaries shift for everything after the changed region). With pulldown-cmark doing 1MB in 29ms, full re-lex is fast enough even for large documents.
- **`removeRegion(key)`** — removes from RegionMap, full re-lex+parse of the remaining text.
- **`clear()`** — resets RegionMap and engine. Empty view.

All methods are synchronous, direct DOM manipulation per L06. No promises, no effects, no React state.

**Laws compliance:**

- **L06:** Handle methods are direct DOM writes. No React state changes.
- **L07:** Methods access engine and RegionMap through refs. No stale closures.
- **L22:** The streaming PropertyStore observer calls `setRegion("stream", accumulatedText)` — direct store observer → method call → DOM write, no React round-trip.
- **L03:** `useImperativeHandle` runs in `useLayoutEffect` timing — the handle is available before events fire.

#### Streaming integration

The streaming `useLayoutEffect` observer remains (L22). On each store update:

```typescript
streamingStore.observe(streamingPath, () => {
  const text = streamingStore.get(streamingPath) as string;
  if (!text) return;
  handle.setRegion("stream", text);  // updates the stream region incrementally
});
```

The `setRegion` call detects that "stream" is the last region and does an incremental update (no full rebuild). Auto-scroll to tail happens inside `setRegion` when `isStreamingRef.current` is true.

When streaming ends and a new static region is added, it appends after the stream region. The previous stream content stays rendered — no destruction.

#### What changes

**New file: `tugdeck/src/lib/region-map.ts`**
- `RegionMap` class, ~30 lines, zero dependencies.
- Exported for use by TugMarkdownView and tests.

**TugMarkdownView:**
- Remove the `content` prop entirely. All content goes through the imperative handle.
- Remove the static `useLayoutEffect` that watched `content`. Content is set by the caller via `handle.setRegion()`.
- Add `React.forwardRef` wrapper + `useImperativeHandle`.
- Add `RegionMap` as part of engine state.
- `lexParseAndRender` takes the concatenated text from RegionMap.
- The streaming observer calls `setRegion("stream", text)` instead of managing `contentText` directly.
- Extract shared incremental update logic used by both `setRegion` (for last-region updates) and the streaming observer into one function.

**Gallery card:**
- Remove `mode` state and conditional rendering. Mount ONE TugMarkdownView with a ref.
- Action buttons:
  - **Streaming** — starts/stops the streaming simulation. Writes to PropertyStore; the L22 observer calls `setRegion("stream", text)`.
  - **Static 1MB** — calls `ref.current.setRegion("static-1mb", STATIC_1MB_CONTENT)`. Adds a 1MB region.
  - **Static 10MB** — calls `ref.current.setRegion("static-10mb", generated10MB)`. Adds a 10MB region.
  - **Clear** — calls `ref.current.clear()`. Always visible.
- Button order: `Streaming | Static 1MB | Static 10MB | Clear`.
- Single TugMarkdownView instance. No conditional rendering. No unmount/remount.

#### Conversation use case (future — Phase 3B+)

The region model directly supports the conversation rendering pattern:

```typescript
// Assistant streaming message
handle.setRegion("msg-abc-123", accumulatedStreamingText);

// Thinking block
handle.setRegion("thinking-def-456", "Thinking...");
// ... later ...
handle.setRegion("thinking-def-456", fullThinkingText);

// Tool use
handle.setRegion("tool-ghi-789", "Running `grep -r ...`");
// ... later ...
handle.setRegion("tool-ghi-789", "```\nresults...\n```");

// User message
handle.setRegion("msg-jkl-012", "Please explain the output.");
```

Each message is independently addressable. The region model handles ordering and concatenation. The WASM pipeline handles lexing, parsing, and rendering. The virtual scroll handles DOM node management.

#### Steps

**Step 1: Implement RegionMap.**
New file `tugdeck/src/lib/region-map.ts`. The class, unit tests in `tugdeck/src/__tests__/region-map.test.ts`. Test: insert, update, remove, clear, concatenation, offset computation, regionKeyAtOffset.

Verify: `bun test` passes including new tests.

**Step 2: Wire RegionMap into TugMarkdownView.**
- Remove `content` prop.
- Add `forwardRef` + `useImperativeHandle` with `setRegion`, `removeRegion`, `clear`.
- Add RegionMap to engine state.
- `setRegion` calls incremental update (for last region) or full `lexParseAndRender` (for middle region updates).
- Streaming observer calls `setRegion("stream", text)`.
- `clear` resets RegionMap + engine.

Verify: `bun test` passes. `bun run build` succeeds.

**Step 3: Rework gallery card.**
- Remove `mode` state, conditional rendering, `content` prop usage.
- Mount one TugMarkdownView with ref.
- Wire buttons: Streaming (start/stop simulation → PropertyStore → L22 observer → setRegion), Static 1MB (setRegion), Static 10MB (setRegion), Clear (clear).
- Button order: `Streaming | Static 1MB | Static 10MB | Clear`.
- Keep diagnostic overlay.

Verify: all content types work. Regions accumulate. Clear resets. Scrolling smooth. No console errors.

#### Checkpoints

- `bun test` passes including RegionMap tests.
- `bun run build` succeeds.
- Gallery: Streaming adds content incrementally via setRegion.
- Gallery: Static 1MB adds a region via setRegion.
- Gallery: Static 10MB adds a region via setRegion.
- Gallery: Clear resets all regions.
- Gallery: clicking Static 1MB after Streaming adds to existing content (two regions).
- No `content` prop on TugMarkdownView.
- Zero law violations.

#### Exit criteria

- RegionMap: ordered, keyed content container with cached concatenation and offset tracking.
- TugMarkdownView exposes `TugMarkdownViewHandle` with `setRegion`, `removeRegion`, `clear`.
- No `content` prop — all content through the handle.
- Gallery card: action buttons, single component instance, no mode switching.
- Streaming: L22-compliant store observer calls setRegion.
- Full Tuglaws compliance: L03, L06, L07, L19, L22.

---

### Phase 3A.6: SmartScroll — Scroll State Machine {#smart-auto-scroll}

**Status:** Done.

**Goal:** Build a proper scroll management abstraction modeled after UIScrollView/UIScrollViewDelegate. SmartScroll is a standalone class (not a React hook) that manages a scroll container element, tracks scroll phases (idle, tracking, dragging, decelerating, programmatic), provides programmatic scroll methods, fires lifecycle callbacks, and includes auto-follow-bottom as a built-in feature. It is the foundation for all scrolling behavior in tugdeck.

**Inputs:** Phase 3A.5 TugMarkdownView (imperative handle, region model, virtual scroll). UIScrollView/UIScrollViewDelegate API study. Research into web scroll behavior. `use-stick-to-bottom` (StackBlitz Labs, MIT — see THIRD_PARTY_NOTICES.md).

#### Design reference: UIScrollView / UIScrollViewDelegate

SmartScroll is modeled after Apple's UIScrollView. UIScrollView provides: precise scroll state (`contentOffset`, `contentSize`, `isTracking`, `isDragging`, `isDecelerating`), programmatic scrolling (`setContentOffset(_:animated:)`, `scrollRectToVisible(_:animated:)`), and delegate callbacks at every phase transition. The auto-follow-bottom behavior that chat UIs need is trivially built on top of this foundation — it's not the whole thing.

**What UIScrollView provides that the web can replicate:**
- Scroll position and geometry (`scrollTop`, `scrollHeight`, `clientHeight` — exact equivalents)
- Phase state machine (idle → tracking → dragging → decelerating → idle — approximated via pointer/wheel/scroll/scrollend events)
- Programmatic scrolling (`scrollTo`, `scrollToBottom`, `scrollToElement` — via web `scrollTo` API)
- Lifecycle callbacks (`onScroll`, `onWillBeginDragging`, `onDidEndDragging`, `onDidEndDecelerating`, `onDidEndScrollingAnimation` — via event mapping)

**Three gaps — all in momentum/deceleration, none affecting core functionality:**
1. No access to release velocity or deceleration target. UIScrollView's `scrollViewWillEndDragging(_:withVelocity:targetContentOffset:)` gives exact velocity at finger-lift and a mutable target. The web doesn't expose this.
2. No control over deceleration rate. UIScrollView has `.normal`/`.fast` presets. The web's momentum physics are browser-controlled.
3. No "is this momentum or active input?" signal during wheel events. macOS `NSEvent.momentumPhase` distinguishes these; the web doesn't expose it.

None of these gaps affect auto-follow-bottom, the state machine, programmatic scrolling, or lifecycle callbacks.

#### The scroll state machine

Six mutually exclusive phases, detected using web events:

```
IDLE
  │── pointerdown ────────────────────→ TRACKING
  │── wheel event ────────────────────→ DRAGGING (+ start scrollend timer)
  │── scroll key ─────────────────────→ DRAGGING (+ start scrollend timer)
  │── our scrollTo(animated) ─────────→ PROGRAMMATIC

TRACKING
  │── first scroll event ─────────────→ DRAGGING
  │── pointerup (no scroll) ──────────→ IDLE

DRAGGING
  │── pointerup ──────────────────────→ SETTLING (50ms window)
  │── scrollend event ────────────────→ IDLE (drag ended, no momentum)
  │── scrollend fallback timer ───────→ IDLE (drag ended, no momentum)

SETTLING
  │── scrolls arrived within 50ms ────→ DECELERATING
  │── no scrolls within 50ms ─────────→ IDLE

DECELERATING
  │── scrollend event ────────────────→ IDLE
  │── scrollend fallback timer ───────→ IDLE
  │── pointerdown (interrupt) ────────→ TRACKING

PROGRAMMATIC
  │── scrollend event ────────────────→ IDLE
  │── target reached (non-animated) ──→ IDLE
```

**Key rule from UIScrollView:** Programmatic scrolls NEVER fire drag/deceleration callbacks. `onWillBeginDragging` fires only for user input. The state machine enforces this — programmatic scrolling is a separate phase.

#### User scroll detection — all input methods

Every way a user can scroll must be detected for disengagement:

| Input Method | Event | Detection |
|---|---|---|
| Trackpad/wheel (any direction) | `wheel` | Immediate, unambiguous; deltaY < 0 disengages follow-bottom |
| Keyboard scroll keys (all) | `keydown` | PageUp, PageDown, Home, End, ArrowUp, ArrowDown, Space — all enter DRAGGING |
| Keyboard scroll-up keys | `keydown` | PageUp, Home, ArrowUp, Shift+Space — additionally disengage follow-bottom |
| Scrollbar thumb drag | `pointerdown` + `scroll` | Phase is DRAGGING (pointer is down) |
| Scrollbar track click | `pointerdown` + `scroll` | Phase is DRAGGING (pointer is down) |
| Touch scroll | `touchstart` + `scroll` | Phase is DRAGGING |
| Momentum/inertial | scroll events continue after pointerup | Phase is DECELERATING |
| Accessibility (VoiceOver) | `scroll` | Treated as user scroll (no pointer/wheel) |

Every non-user scroll must be filtered:

| Non-User Source | Guard |
|---|---|
| Our programmatic scrollTop write | Phase is PROGRAMMATIC_SCROLLING (we set it before writing) |
| DOM manipulation shifting scrollTop | Phase is IDLE and no user input preceded the scroll event |
| ResizeObserver-triggered auto-scroll | Phase is IDLE, we set PROGRAMMATIC_SCROLLING before writing |

**The state machine is the guard.** If the phase is DRAGGING or DECELERATING and scrollTop decreases, a user is scrolling up — disengage follow-bottom. If the phase is IDLE or PROGRAMMATIC_SCROLLING and scrollTop changes, we caused it — ignore. No timing hacks, no rAF+setTimeout, no flags cleared after arbitrary delays.

#### Follow-bottom behavior

Built on the state machine, not alongside it:

- **Controller (doSetRegion)** checks `isFollowingBottom` and calls `scrollToBottom()` after content settles — no ResizeObserver auto-scroll in SmartScroll.
- **Phase enters DRAGGING** and scroll direction is up → disengage `isFollowingBottom`
- **Phase enters IDLE** and `isNearBottom` → re-engage `isFollowingBottom`
- **`scrollToBottom()` called** → engage `isFollowingBottom`, enter PROGRAMMATIC

#### API

```typescript
/** Scroll phase — mutually exclusive states. */
export type ScrollPhase = 'idle' | 'tracking' | 'dragging' | 'settling' | 'decelerating' | 'programmatic';

/** Lifecycle callbacks — modeled after UIScrollViewDelegate. */
export interface SmartScrollCallbacks {
  /** Fires for ALL scroll sources. Like scrollViewDidScroll. */
  onScroll?: (scroll: SmartScroll) => void;

  /** User drag started (pointer/wheel/keyboard). Like scrollViewWillBeginDragging. */
  onWillBeginDragging?: (scroll: SmartScroll) => void;
  /** User drag ended. Like scrollViewDidEndDragging(willDecelerate:). */
  onDidEndDragging?: (scroll: SmartScroll, willDecelerate: boolean) => void;

  /** Momentum coast started. Like scrollViewWillBeginDecelerating. */
  onWillBeginDecelerating?: (scroll: SmartScroll) => void;
  /** Momentum coast ended. Like scrollViewDidEndDecelerating. */
  onDidEndDecelerating?: (scroll: SmartScroll) => void;

  /** Programmatic animated scroll completed. Like scrollViewDidEndScrollingAnimation. */
  onDidEndScrollingAnimation?: (scroll: SmartScroll) => void;

  /** Any scroll sequence completed (user or programmatic). */
  onDidEndScrolling?: (scroll: SmartScroll) => void;

  /** Auto-follow-bottom state changed. */
  onFollowBottomChanged?: (scroll: SmartScroll, following: boolean) => void;
}

/** Constructor options. */
export interface SmartScrollOptions {
  scrollContainer: HTMLElement;
  callbacks?: SmartScrollCallbacks;
  nearBottomThreshold?: number;     // Default: 60px
  followBottom?: boolean;           // Default: true
}

export class SmartScroll {
  constructor(options: SmartScrollOptions);

  // --- State (read-only) ---
  get phase(): ScrollPhase;
  get scrollTop(): number;
  get scrollHeight(): number;
  get clientHeight(): number;
  get isAtBottom(): boolean;          // Geometric: within threshold of bottom
  get isAtTop(): boolean;             // scrollTop === 0
  get isUserScrolling(): boolean;     // phase is dragging, settling, or decelerating
  get isFollowingBottom(): boolean;   // Auto-follow engaged

  // --- Programmatic scrolling ---
  scrollTo(options: { top?: number; left?: number; animated?: boolean }): void;
  scrollToTop(animated?: boolean): void;
  scrollToBottom(animated?: boolean): void;
  scrollToElement(element: HTMLElement, options?: { animated?: boolean; block?: ScrollLogicalPosition }): void;

  // --- Follow-bottom control ---
  engageFollowBottom(): void;
  disengageFollowBottom(): void;

  // --- Lifecycle ---
  dispose(): void;
}
```

#### Internal listeners

Six DOM listeners, each with a clear job:

1. **`scroll` on container** — fires `onScroll` callback, updates `lastScrollTop`, drives phase transitions and re-engagement check.
2. **`scrollend` on container** — terminal signal for deceleration and programmatic animation. Feature-detected at construction; timer fallback (150ms since last `scroll` event) for browsers without it.
3. **`pointerdown` on container** — enters TRACKING phase. Safari fires `pointerdown` on scrollbar clicks (WebKit bug 25811 was about `mouseup`, not `mousedown` — fixed in 2013). This means the state machine correctly enters TRACKING → DRAGGING for scrollbar interaction.
4. **`pointerup` / `pointercancel` on document** — exits DRAGGING, enters SETTLING (50ms window to detect momentum). Listened on `document` (not container) because the pointer may move outside the container during drag. **Known edge case:** Safari's `pointerup` on scrollbar release has been historically unreliable. For scrollbar drag (which has no momentum), the `scrollend` event or timer fallback handles the DRAGGING → IDLE transition regardless.
5. **`wheel` on container** — skips TRACKING, enters DRAGGING immediately (no pointer involved). Starts scrollend fallback timer. Disengage follow-bottom on `deltaY < 0`.
6. **`keydown` on container** — all scroll keys (PageUp, PageDown, Home, End, ArrowUp, ArrowDown, Space) → skips TRACKING, enters DRAGGING immediately. Starts scrollend fallback timer. Only scroll-up keys disengage follow-bottom. **Note:** requires the scroll container to have `tabindex` for focus. TugMarkdownView should set `tabindex="0"` on its scroll container div.

All event listeners use `{ passive: true }`. All registered in constructor, all removed in `dispose()`.

#### Coalescing and the `onScroll` callback

SmartScroll fires `onScroll` synchronously on every `scroll` event — it does not coalesce internally. This is correct: the state machine must see every scroll event to track phases accurately.

The **consumer** decides whether to coalesce DOM-heavy work. TugMarkdownView's virtual window management (blockWindow.update + applyWindowUpdate) should be RAF-coalesced by the component, not by SmartScroll. The component receives `onScroll`, sets a dirty flag, and its existing RAF handler processes the virtual window update once per frame.

This is not an L05 violation. L05 prohibits RAF for operations that depend on **React state commits**. The virtual window update is a pure DOM operation (L06) triggered by a DOM event (`scroll`). RAF coalescing of DOM-event-driven DOM operations is standard and correct.

SmartScroll provides the state; the consumer decides the rendering strategy.

#### Scrollbar interaction — verified for Safari/WKWebView

Research confirmed:
- **Safari fires `pointerdown`** on scrollbar clicks. The state machine's IDLE → TRACKING → DRAGGING path works.
- **Safari's `pointerup` on scrollbar release** has been historically unreliable (WebKit bug 25811, fixed for `mouseup` in 2013, but `pointerup` edge cases may remain). However, scrollbar drag produces no momentum — when the user releases the thumb, scrolling stops. The `scrollend` event (Safari 26.2+) or timer fallback handles DRAGGING → IDLE.
- **macOS overlay scrollbars** (the default) are thin and transient. Users rarely grab them — most macOS scrolling is trackpad (wheel events) or keyboard. The scrollbar drag path is real but uncommon in practice. It works correctly through the state machine.
- The `offsetWidth - clientWidth` technique for detecting pointer-in-scrollbar-region does not work with overlay scrollbars (zero gutter width). The state machine approach (pointerdown → TRACKING → DRAGGING) is more reliable.

#### Known web limitations (from UIScrollView study)

1. **No release velocity or deceleration target.** Cannot read momentum velocity at finger-lift. Cannot modify where momentum scroll will land. UIScrollView's `scrollViewWillEndDragging(_:withVelocity:targetContentOffset:)` provides this. Impact: none for follow-bottom or state machine.
2. **No deceleration rate control.** Browser decides momentum physics. UIScrollView has `.normal`/`.fast` presets. Impact: none.
3. **No momentum vs active input distinction in wheel events.** macOS `NSEvent.momentumPhase` distinguishes active trackpad contact from inertial coast. The web doesn't expose this. Impact: none for disengagement (both active and momentum wheel-up should disengage).

#### Steps

**Step 1: Rewrite SmartScroll with complete state machine.**
Replace the current `tugdeck/src/lib/smart-scroll.ts` entirely. The new class implements:
- The six-phase state machine with transitions from pointer/wheel/key/scroll/scrollend events
- Lifecycle callbacks (SmartScrollCallbacks)
- Programmatic scroll methods (scrollTo, scrollToTop, scrollToBottom, scrollToElement)
- Follow-bottom with content growth detection (ResizeObserver)
- `scrollend` feature detection with timer fallback
- Comprehensive tests

Verify: `bun test` passes. `bun run build` succeeds.

**Step 2: Wire new SmartScroll into TugMarkdownView.**
- Replace the current SmartScroll instance creation with the new options-based constructor.
- Add `tabindex="0"` to the scroll container div (required for `keydown` listener to receive keyboard events).
- Remove the `onScroll={handleScroll}` JSX prop — SmartScroll owns the scroll listener now.
- Keep the RAF-coalesced virtual window update logic in the component, but trigger it from SmartScroll's `onScroll` callback instead of a direct scroll event. The `onScroll` callback sets a dirty flag; the existing RAF handler processes it.
- Remove the `handleScroll` `useCallback` — replaced by SmartScroll's callback.
- The component is a consumer of SmartScroll's state and callbacks, not a direct scroll event listener.

Verify: `bun test` passes. `bun run build` succeeds.

**Step 3: Rework gallery card, test, and verify.**
Rework gallery controls: size selector (50KB | 1MB | 10MB) + action buttons (Stream | Stop | Static | Clear).

Verify in browser:
- Stream: auto-scrolls to tail as content arrives.
- Scroll up during streaming (wheel, scrollbar drag, keyboard): disengages — content keeps arriving but scroll stays put.
- Scroll back to bottom: re-engages.
- Stop: interrupts stream, content stays.
- Static: dumps selected size. If at bottom, auto-scrolls. If scrolled up, stays put.
- Clear: resets everything.
- No console errors.

#### Exit criteria

- SmartScroll implements the six-phase state machine (idle, tracking, dragging, settling, decelerating, programmatic).
- All user scroll input methods (wheel, scrollbar drag, keyboard, touch) detected for disengagement.
- Programmatic and DOM-manipulation scrolls correctly filtered via phase state (not timing hacks).
- Lifecycle callbacks fire at correct phase transitions.
- Programmatic scroll methods work (scrollTo, scrollToTop, scrollToBottom, scrollToElement).
- Follow-bottom engages/disengages correctly.
- `scrollend` used where supported, timer fallback elsewhere.
- Full Tuglaws compliance: L03, L06, L07, D93.
- No `overflow-anchor` dependency.
- No rAF+setTimeout timing hacks.

---

### Phase 3A.7: SmartScroll Hardening {#smart-scroll-hardening}

**Status:** Done.

**Goal:** Fix eight issues identified during holistic review of the SmartScroll implementation. The state machine is architecturally sound, but has phase gaps, orphaned states, dead code, and incomplete key coverage that must be resolved before moving on.

**Inputs:** Phase 3A.6 SmartScroll (five-phase state machine, 72 tests), TugMarkdownView consumer code.

#### Issue 1: Dead ResizeObserver in SmartScroll

**Problem:** `_handleResize` is an empty method. The ResizeObserver is created, registered, observed, and disposed — but does nothing. Speculative infrastructure with no current purpose.

**Fix:** Remove `_resizeObserver`, `_handleResize`, the `contentElement` parameter from `SmartScrollOptions`, and the `_content` field. The controller-driven model (`doSetRegion` calls `scrollToBottom()`) means SmartScroll doesn't need to observe content changes. If content-change detection is needed later, add it with a clear purpose. Also eliminates one of three ResizeObservers (see Issue 6).

#### Issue 2: Phase gap during deceleration detection

**Problem:** During the 50ms window after pointerup, phase is set to `idle` while the timer checks for momentum scroll events. `isUserScrolling` returns false during this window — an API lie. The `_scrolledAfterPointerUp` flag and `_decelerationTimer` sentinel check in the idle handler are implicit state smuggled outside the phase model.

**Fix:** Add a sixth phase: `settling`. After pointerup from dragging, enter `settling` instead of `idle`. Settling means "pointer released, waiting to determine if momentum follows." After the 50ms timer resolves:
- Scrolls arrived → transition to `decelerating`, fire `onDidEndDragging(willDecelerate: true)` + `onWillBeginDecelerating`
- No scrolls → transition to `idle`, fire `onDidEndDragging(willDecelerate: false)` + `onDidEndScrolling`

`isUserScrolling` returns true for `settling`. The `_scrolledAfterPointerUp` field moves from an implicit flag to an explicit phase. Update the `ScrollPhase` type, the state diagram, `isUserScrolling`, and tests.

#### Issues 3 & 4: Wheel and keyboard scrolls orphaned in DRAGGING

**Problem:** `_handleWheel` and `_handleKeyDown` enter DRAGGING but have no pointer lifecycle to exit it. They rely entirely on `scrollend` to return to idle. If `scrollend` doesn't fire (single wheel tick with no momentum, or browser lacks support), the phase stays stuck in DRAGGING.

**Fix:** After wheel or keydown enters DRAGGING, call `_restartScrollEndTimer()`. This starts/restarts a 150ms fallback timer. Continuous wheel/key events keep pushing the timer forward. When activity stops:
- On browsers WITH `scrollend`: the native event fires first via `_handleScrollEnd`, clears the timer
- On browsers WITHOUT `scrollend`: the timer fires `_onScrollTerminal` after 150ms of silence

This ensures wheel and keyboard scrolls always have an exit path from DRAGGING, regardless of browser support.

#### Issue 5: Scrollend fallback timer doesn't run for DRAGGING phase

**Problem:** `_handleScroll` only restarts the scrollend fallback timer for `decelerating` and `programmatic` phases. If the phase is `dragging` (from wheel or keyboard), no fallback timer runs during scroll events. On Safari (no native `scrollend`), this means wheel/keyboard scrolling can leave the state machine stuck.

**Fix:** Add `dragging` to the fallback timer restart in `_handleScroll`:

```typescript
case 'dragging':
case 'decelerating':
case 'programmatic':
  if (!this._supportsScrollEnd) {
    this._restartScrollEndTimer();
  }
  break;
```

And update `_onScrollTerminal` to handle `dragging` as a terminal phase — treat it as a drag that ended without momentum:

```typescript
if (previousPhase === 'dragging') {
  this._phase = 'idle';
  this._callbacks.onDidEndDragging?.(this, false);
  this._callbacks.onDidEndScrolling?.(this);
  this._checkReEngageFollowBottom();
}
```

Combined with Issues 3 & 4, this provides complete coverage: the event handler starts the timer, scroll events keep it alive, and `_onScrollTerminal` handles the exit for all three applicable phases.

#### Issue 6: Three ResizeObservers

**Problem:** TugMarkdownView creates two ResizeObservers (block measurement, viewport height) and SmartScroll creates a third (dead).

**Fix:** Solved by Issue 1. Removing SmartScroll's dead ResizeObserver reduces the count to two. The remaining two serve genuinely different purposes — one observes the scroll container element (viewport height changes), the other observes individual block elements (measured heights). They watch different targets and can't be merged. Two is correct.

#### Issue 7: Fragile closure capture in `useImperativeHandle`

**Problem:** `doSetRegion` is captured in `useImperativeHandle` with an empty dependency array. It's only safe because everything it touches is a ref. The `eslint-disable` comment hides a fragile assumption — if someone later adds non-ref state to `doSetRegion`, the stale closure bug would be silent.

**Fix:** Replace the blanket `eslint-disable` comments with `eslint-disable-next-line` and an explanatory comment documenting *why* the empty dependency array is correct:

```typescript
// eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally empty:
// doSetRegion, doRemoveRegion, doClear only access refs (.current) at call
// time, never captured values. This handle is stable for the component lifetime.
```

Apply the same treatment to the SmartScroll useLayoutEffect and the streaming observer useLayoutEffect.

#### Issue 8: Incomplete keyboard scroll coverage

**Problem:** Only scroll-up keys (PageUp, Home, ArrowUp, Shift+Space) enter DRAGGING. Scroll-down keys (ArrowDown, PageDown, Space, End) produce scroll events that arrive during idle phase, bypassing the drag lifecycle entirely.

**Fix:** Rename `SCROLL_UP_KEYS` to `SCROLL_KEYS`. Include all scroll keys: PageUp, PageDown, Home, End, ArrowUp, ArrowDown, Space. All keyboard-initiated scrolls enter DRAGGING. The follow-bottom disengagement check remains directional — only scroll-up keys disengage:

```typescript
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'Space']);

private _handleKeyDown(e: KeyboardEvent): void {
  if (this._disposed) return;
  if (!SCROLL_KEYS.has(e.code)) return;

  if (this._phase !== 'dragging') {
    this._enterDragging();
  }
  this._restartScrollEndTimer(); // Issue 3/4 fix

  // Disengage follow-bottom only for scroll-UP keys
  const isUpKey = e.code === 'PageUp' || e.code === 'Home'
    || e.code === 'ArrowUp' || (e.code === 'Space' && e.shiftKey);
  if (isUpKey && this._isFollowingBottom) {
    this._setFollowingBottom(false);
  }
}
```

#### Updated state diagram

After all fixes, the state machine has six phases:

```
IDLE
  │── pointerdown ────────────────────→ TRACKING
  │── wheel event ────────────────────→ DRAGGING (+ start scrollend timer)
  │── scroll key ─────────────────────→ DRAGGING (+ start scrollend timer)
  │── our scrollTo(animated) ─────────→ PROGRAMMATIC

TRACKING
  │── first scroll event ─────────────→ DRAGGING
  │── pointerup (no scroll) ──────────→ IDLE

DRAGGING
  │── pointerup ──────────────────────→ SETTLING (50ms window)
  │── scrollend event ────────────────→ IDLE (drag ended, no momentum)
  │── scrollend fallback timer ───────→ IDLE (drag ended, no momentum)

SETTLING
  │── scrolls arrived within 50ms ────→ DECELERATING
  │── no scrolls within 50ms ─────────→ IDLE

DECELERATING
  │── scrollend event ────────────────→ IDLE
  │── scrollend fallback timer ───────→ IDLE
  │── pointerdown (interrupt) ────────→ TRACKING

PROGRAMMATIC
  │── scrollend event ────────────────→ IDLE
  │── target reached (non-animated) ──→ IDLE
```

#### Steps

**Step 1: SmartScroll fixes (Issues 1-5, 8).**
- Remove dead ResizeObserver and `contentElement` from SmartScroll
- Add `settling` phase to `ScrollPhase` type
- Implement settling transition logic (pointerup from dragging → settling → decelerate or idle)
- Update `isUserScrolling` to include `settling`
- Add `_restartScrollEndTimer()` calls in `_handleWheel` and `_handleKeyDown`
- Add `dragging` to scrollend fallback restart in `_handleScroll`
- Add `dragging` handling in `_onScrollTerminal`
- Rename `SCROLL_UP_KEYS` to `SCROLL_KEYS`, add all scroll keys, make disengagement directional
- Update all tests for new phase, new transitions, and timer behavior

Verify: `bun test` passes. `bun run build` succeeds.

**Step 2: TugMarkdownView fixes (Issues 1, 7).**
- Remove `contentElement` from SmartScroll constructor call (now uses only `scrollContainer`)
- Replace `eslint-disable` with `eslint-disable-next-line` + explanatory comments on all three hooks
- Update D93 docstring comment to reflect six-phase model

Verify: `bun test` passes. `bun run build` succeeds.

**Step 3: Update roadmap and design decisions.**
- Update the Phase 3A.6 state diagram to show six phases
- Update D93 in `tuglaws/design-decisions.md` to document the settling phase and wheel/keyboard timer
- Mark Phase 3A.6 as done, Phase 3A.7 as done

Verify: State diagram and D93 match the implementation.

#### Exit criteria

- Six-phase state machine: idle, tracking, dragging, settling, decelerating, programmatic
- `isUserScrolling` is always truthful — returns true during settling
- Wheel and keyboard scrolls always exit DRAGGING (scrollend event or fallback timer)
- Scrollend fallback timer runs for dragging, decelerating, and programmatic phases
- No dead code (ResizeObserver removed, contentElement removed)
- All scroll keys (up and down) enter DRAGGING; only up-keys disengage follow-bottom
- `eslint-disable` comments replaced with `eslint-disable-next-line` + rationale
- All existing tests pass; new tests cover settling phase, wheel/key timer exit, all-key coverage
- `bun test` passes. `bun run build` succeeds.

---

### Phase 3B: Markdown Content Types {#markdown-content-types}

**Goal:** Rich rendering for all markdown content types, built on the Phase 3A virtualization engine. Addresses U1, U5, U6, U7.

**Inputs:** Phase 3A rendering core (BlockHeightIndex, RenderedBlockWindow, two-path rendering).

**Work:**
- GFM markdown: paragraphs, headings, emphasis, links, images, lists, tables, blockquotes, horizontal rules. All standard pulldown-cmark block types rendered via the WASM pipeline.
- TugCodeBlock: syntax highlighting (approach TBD — evaluate pulldown-cmark's code fence output, Shiki WASM, or lighter alternatives). Copy-to-clipboard, language label, line numbers, collapse/expand. **Lazy highlighting**: only highlight code blocks when they enter the viewport.
- Streaming cursor (U5): visible during `assistant_text` partials. Positioned at end of last block. Removed on `turn_complete`.
- Thinking block rendering (U6): `thinking_text` events → collapsible block. Shows "Thinking..." during streaming, full text when complete.
- Tool use display (U7): `tool_use` → `tool_result` → `tool_use_structured`. Show tool name, input, output, duration. Collapsible.
- `--tugx-md-*` token aliases. `@tug-pairings` per [L16, L19].
- `tug-*` custom block extension point (for future Phase 12 custom renderers).
- Gallery card.

**Exit criteria:**
- All standard GFM markdown renders correctly (test against CommonMark spec examples).
- Code blocks: Shiki highlighting works for top-20 languages. Lazy — only visible blocks highlighted. Copy-to-clipboard works.
- Thinking blocks render and collapse correctly.
- Tool use blocks show name, input/output, duration.
- Streaming cursor visible during partials, gone on complete.
- Laws compliance: [L02, L06, L10, L16, L19, L20].

**Demo:** Full conversation rendering: thinking → streamed response with code blocks → tool use → follow-up. All content types visible and interactive.

---

### Phase 4: Prompt Input {#prompt-input}

**Goal:** tug-prompt-input with history, slash commands, and message queueing. Addresses U12, U13, U19.

**Inputs:** TugTextarea auto-resize. `system_metadata` slash command data.

**Work:**
- Enhanced `<textarea>`, 1 row default, grows to maxRows (8). [L06].
- Keyboard: Enter submit, Shift+Enter newline, Cmd+Enter submit. IME-safe.
- `PromptHistoryStore`: IndexedDB, per-card, `useSyncExternalStore` [L02].
- Slash command popup (U12): merge `system_metadata.slash_commands` + `.skills`, `@floating-ui/react`.
- `@` file completion (U13): detect `@`, file picker, inject content.
- Message queueing during turn (U19): disable send during streaming, show queue indicator. Use `interrupt` to cancel.
- Gallery card.

**Exit criteria:**
- Submit, history navigation, prefix search, slash popup, `@` completion all work
- CJK input works
- Send disabled / queue indicator shown during active turn

**Demo:** Working prompt with slash popup, history, and queueing behavior.

---

### Phase 5: Conversation Wiring {#conversation-wiring}

**Goal:** Wire the core conversation loop end-to-end. Addresses U2, U3, U4, U8, U14, U23.

**Inputs:** tug-markdown (Phases 3A+3B), tug-prompt-input (Phase 4), hardened transport (Phase 2).

**Work:**
- Compose prompt input + submit/stop button.
- Wire to CodeOutput/CodeInput: submit sends `user_message`, stop sends `interrupt` (U4).
- Permission dialog (U2): `control_request_forward` with `is_question: false`. Allow/deny buttons. Permission suggestions.
- AskUserQuestion dialog (U3): `control_request_forward` with `is_question: true`. Single/multi-select options.
- Subagent activity display (U8): `tool_use: Agent` brackets subagent lifetime. Nested tool calls visible.
- Session handling (U14): detect pending session IDs (`"pending"`, `"pending-fork"`), wait for real ID.
- Task progress display (U23): `system:task_started/progress/completed` events for agent lifecycle indicators.
- Gallery card + live integration test.

**Exit criteria:**
- Full round-trip: type prompt → streamed markdown response
- Permission and question dialogs work
- Interrupt stops streaming
- Subagent activity visible
- Session new/fork handled cleanly

**Demo:** Real conversation with Claude through the UI.

---

### Phase 6: Chrome & Status {#chrome-and-status}

**Goal:** Status indicators, switchers, and cost display. Addresses U9, U10, U11, U16, U17, U20, U21, U22, C1, C2, C3, C10.

**Inputs:** Working conversation (Phase 5). `system_metadata` and `cost_update` events.

**Work:**
- Model switcher (U9): send `model_change`, synthetic `assistant_text` confirms, `system_metadata` updates.
- Permission mode switcher (U10): send `permission_mode`, cycle default → acceptEdits → plan → auto.
- Cost/token display (U11): `cost_update` with `total_cost_usd`, `num_turns`, `duration_ms`, `usage`.
- API retry indicator (U16): `api_retry` events — attempt count, delay, error type.
- Compaction indicator (U17): `compact_boundary` events — show when context is being compacted.
- Plan mode choices (U20): `EnterPlanMode` approve/reject/keep-planning options.
- Stop background task (U21): send `{ type: "stop_task", task_id }` button.
- Context window budget (U22): account for ~20% startup overhead in token counter.
- `/status` (C1): model, session, context usage from `system_metadata` + `cost_update.usage`.
- `/model` (C2): model picker → `model_change` message.
- `/permissions` (C3): mode display + switcher → `permission_mode` message.
- `/compact` (C10): invoke skill, show compaction indicator.

**Exit criteria:**
- Model and permission mode switch correctly, UI reflects changes
- Cost display updates each turn
- Retry and compaction indicators visible when events arrive
- /status, /model, /permissions, /compact all functional

**Demo:** Full conversation chrome — switch models, see cost, trigger compaction.

---

### Phase 7: Session & Commands {#session-and-commands}

**Goal:** Terminal command reimplementations, session management, and remaining features. Addresses C4-C9, C11-C15, U15, U18, E5.

**Inputs:** Full conversation UI (Phases 3-6).

**Work:**
- `/clear` (C4): clear conversation → `session_command: "new"`.
- `/resume` (C5): session picker — list, preview, rename, filter. Data from filesystem (E5 exploration).
- `/diff` (C6): run git diff, render result.
- `/export` (C7): serialize conversation from accumulated events.
- `/copy` (C8): copy last response from accumulated `assistant_text`.
- `/btw` (C9): side question overlay — separate API call, no history impact.
- `/rename` (C11): text input → update session metadata.
- `/branch`, `/rewind` (C12): session fork → `session_command: "fork"`.
- `/vim` (C13): keybinding mode toggle.
- `/color`, `/theme` (C14): theme picker.
- `/help` (C15): help display.
- Image attachments (U15): base64 in `user_message.attachments`. Drag-drop/paste → encode → attach.
- Session-scoped permission reset (U18): handle re-approval after resume.

**Exit criteria:**
- All terminal commands have UI equivalents
- Session picker works (list, resume, rename)
- Image attachments work via drag-drop/paste
- Permissions re-prompt correctly after session resume

**Demo:** Full session lifecycle — new, resume, fork, rename. All commands accessible.

---

### Phases 8-12: Feed Layer {#feed-layer}

| Phase | Goal | Scope |
|-------|------|-------|
| 8. Hook Capture | Agent lifecycle → `raw-events.jsonl` | Shell scripts + hooks.json |
| 9. Feed Correlation | Semantic enrichment → `feed.jsonl` | Correlation logic |
| 10. Feed CLI + Tugcast | `tugcode feed` + browser delivery | Rust CLI + tugcast feed |
| 11. Agent-Internal Events | File/command detail | Agent frontmatter hooks |
| 12. Custom Block Renderers | Rich agent output UI | React components |

---

## Deferred

- **tug-rich-text** — Monaco editor wrapper. Future.
- **tug-search-bar** — TugInput + TugButton. Future.
- **Tiptap migration** for tug-prompt-input (@-mentions, ghost text). Future.
- **Mermaid, KaTeX** — tug-markdown extensions via the extension point. When needed.
- **E3 (hooks visibility)** — Hooks run silently. No events for hook decisions, context injection, timing. Non-blocking for UI.
- **E6 (advanced patterns)** — Background tasks, MCP, elicitation untested. Non-blocking for UI.

---

## Risks

1. **Feed hook parsing fragility.** Orchestrator prompts are natural language with embedded JSON.
2. **Shell script overhead on high-frequency hooks.** ~50ms per invocation. Monitor in Phase 11.
3. **Hooks visibility gap (E3).** Hooks run silently — UI blind to hook decisions. May need tugtalk changes. Deferred.
4. ~~**WebSocket unknowns.**~~ Resolved in Phase 2b. Wire protocol documented, four issues found (T8-T11), fixes tracked in Phase 2c.

---

## Resolved Questions

1. **Shiki theme** — Hand-authored file referencing `--tug-syntax-*` CSS custom properties.
2. **History scope** — Per-card via `historyKey`. No global cross-card history for now.
3. **Slash command extensibility** — Declarative list from `system_metadata`. No registration system.
4. **Streaming text model** — Deltas on partials, full text on complete. UI accumulates.
5. **Slash command invocation** — Works via `user_message`. Fixed with T1 (`--plugin-dir`) + T2 (synthetic text).
6. **Custom block renderers** — Extension point in Phase 3, individual blocks in Phase 12.
7. **tug-rich-text / tug-search-bar** — Deferred.
8. **Process lifecycle** — Solved with process groups, parent-death watchdog, kill_on_drop (T4).
9. **Production Bun dependency** — Eliminated. Tugtalk compiles to standalone binary (T7).
10. **Auth bypass for testing** — `--no-auth` flag bypasses WS session/origin checks, auth URL still generated normally (T6).
