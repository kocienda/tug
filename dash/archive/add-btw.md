<!-- devise-skeleton v4 -->

## Native `/btw` Side Questions in the Dev Card {#add-btw}

**Purpose:** Give the Dev card a working `/btw` — ask Claude a quick side question, mid-turn or idle, answered from the live conversation with no tools and never entering the transcript — by driving Claude Code's own `side_question` control-request, the same handler its TUI and Remote Control use.

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

$#### Context {#context}

`/btw` (a "side question") lets you ask Claude something about the current work — "what was that config file again?" — and get a one-shot answer from the full conversation context, **without tools and without adding anything to the transcript**, even while Claude is mid-turn. It is the inverse of a subagent: full context, no tools, versus no context, full tools.

Tug currently **hides** `/btw` (`HIDDEN_SLASH_COMMANDS` in `tugdeck/src/lib/slash-supported.ts`, added by `dash/slash-command-plan.md`). That was the honest minimum at the time: a probe found that sending `/btw …` as **user text** over the stream-json bridge makes Claude refuse it — `"/btw isn't available in this environment."`, a zero-cost local response — and `btw` is absent from the `slash_commands` catalog Claude reports headless. The conclusion was "no headless channel exists."

That conclusion was incomplete. Inspecting the Claude Code 2.1.204 binary (`~/.local/share/claude/versions/2.1.204`, a bun-compiled JS executable with readable identifiers) shows `/btw` is **not** implemented as a slash command that expands to text — it is a **control-request** with `subtype: "side_question"`, dispatched by the same inbound control-request handler that already services `initialize`, `interrupt`, `set_model`, and `set_permission_mode` — every one of which tugcode already sends over Claude's stdin today (`tugcode/src/session.ts`, via `sendControlRequest`). The user-text refusal and the control-request handler are **different doors**; the probe knocked on the wrong one. This plan opens the right one.

#### Strategy {#strategy}

- **Probe the real door first.** Before building anything, confirm Claude services a `control_request { subtype: "side_question", question }` on stdin over stream-json — **both idle and mid-turn** (mid-turn is `/btw`'s defining property and the one genuine protocol uncertainty). Pin captures the way `tugcode/probes/goal-loop/` did.
- **Reuse Claude's implementation, don't rebuild it.** The system-reminder wrapper, tool suppression, cache reuse, and history exclusion all live inside the CLI's `runSideQuestion`; a control-request gets them for free. Tug's job is transport + surface, not semantics ([P01]).
- **Mirror the two request/response patterns Tug already has.** The inbound→control-request→turn-free-`control_response`→outbound-frame round-trip is exactly the `initialize` handshake and the `/rewind` apply (`pendingRewindRequests` + `tryHandleRewindControlResponse` in `session.ts`). The client-side one-shot query store is exactly `HooksInventoryStore` (`tugdeck/src/lib/hooks-inventory-store.ts`).
- **The answer is overlay-only, never transcript ink.** Matches upstream "never enters the conversation history" — and protects replay, which reconstructs the transcript from JSONL where side questions do not appear.
- **Keep a documented fallback.** If the probe shows the control-request is refused over stream-json, fall back to a `--resume --fork-session -p` one-shot (Branch B, [P06]) behind the *same* tugcode verb and deck surface, so the swap is invisible above the transport.
- **Ship mid-turn.** The whole point is asking without interrupting Claude; a non-modal overlay makes it visible, and local slash commands already dispatch before the submit gate (so `/btw` inherits mid-turn for free — [P04]).

#### Success Criteria (Measurable) {#success-criteria}

- Typing `/btw <question>` in the Dev card **while a turn is streaming** shows an answer in an overlay within a few seconds, and the main turn's output is unaffected (no interruption, no extra transcript rows). (Verify: real-claude app-test driving a mid-turn side question.)
- The side-question exchange **never appears in the transcript** and **survives a Developer ▸ Reload with no trace** (replay reconstructs the transcript from JSONL; side questions are not there). (Verify: app-test asserts transcript row count unchanged; reload leaves no side-question ink.)
- The answer reads the live conversation: a `/btw` referencing something said earlier in the session is answered correctly. (Verify: real-claude app-test with a seeded fact.)
- `/btw` classifies `supported-local` (was `hidden`); the classifier and mirror doc agree. (Verify: `slash-supported.test.ts`.)
- The probe's captures + a tugcode integration test pin the `side_question` wire contract on 2.1.204. (Verify: `cd tugcode && bun test`.)
- Earlier side questions from the session list, dimmed, in the overlay, with copy and clear. (Verify: app-test.)

#### Scope {#scope}

1. Probe `side_question` over stream-json (idle + mid-turn), pin captures + findings.
2. tugcode: a new inbound `side_question` verb → `control_request { subtype: "side_question" }`, turn-free `control_response` correlation → a `side_question_answer` outbound frame.
3. tugdeck: a `SideQuestionStore` (session-scoped, ephemeral, keeps ask/answer history) fed by a dedicated CODE_OUTPUT `FeedStore`+filter, and the wire types.
4. tugdeck: `/btw` → `supported-local`; a non-modal side-question overlay surface (mid-turn works via the existing pre-gate local dispatch — no `performSubmit` change).
5. Docs: unhide `/btw`, update the mirror doc + `tuglaws/slash-commands.md`, a new design decision; app-tests.

#### Non-goals (Explicitly out of scope) {#non-goals}

- The TUI's `f` "fork this side question into a full session" affordance — deferred (a natural follow-on if the fork backend is ever used).
- Streaming the answer token-by-token into the overlay. A single settled answer is the target; progressive rendering is a later refinement gated on [Q02].
- Persisting side questions anywhere (tugbank, JSONL, localStorage). They are ephemeral by definition — no persistence ([P03]).
- Remote-Control / cross-device side questions (`sendControlRequest` on a remote transport) — Tug's bridge is local.
- Reworking the WORK cell or any other slash command.

#### Dependencies / Prerequisites {#dependencies}

- Claude CLI ≥ 2.1.204 on PATH (the version the `side_question` inbound subtype was confirmed in; `capabilities/LATEST` reads `2.1.204`).
- Real-claude test tier available on demand (`TUG_REAL_CLAUDE=1`) for the probe and live app-tests.
- The slash-command infrastructure this builds on, already on `main` (originating plan `dash/slash-command-plan.md`, [D107] for the WORK cell / imperative-open precedent, `tuglaws/slash-commands.md` for the three-tier doctrine).

#### Constraints {#constraints}

- **Warnings are errors** across the Rust workspace; `bunx vite build` must pass before any tugdeck step is declared done.
- No localStorage/sessionStorage/IndexedDB — side-question state is in-memory session-scoped React state, no persistence.
- Tuglaws apply to all tugdeck work: [L01] one `root.render()`; [L02] external state via `useSyncExternalStore` only; [L03] `useLayoutEffect` for registrations; [L06] appearance via CSS/DOM, never React state.
- No hand-rolled UI where a `Tug*` component exists — compose `TugPopover`, `TugPopupListFrame`, `PopupCopyButton`, `TugPushButton`, etc.
- A new client→tugcode message needs the full inbound contract update (`INBOUND_VERBS` + payload interface + union member in `tugproto/src/inbound.ts`, then the `INBOUND_HANDLERS` entry in `tugcode/src/inbound-dispatch.ts`); miss the allowlist and the message is rejected as an invalid type.
- App-tests run via `just app-test`; real-claude tests are on-demand only and must exit.

#### Assumptions {#assumptions}

- `side_question` is a live inbound control-request subtype on 2.1.204 (evidence in [#side-question-protocol]); the probe confirms rather than discovers this.
- tugcode's turn-free `control_response` correlation (`handleClaudeLine` catches `control_response` by `request_id` **before** turn routing — see [#control-roundtrip]) works regardless of `activeTurn` state, so a mid-turn side-question response is caught the same way an idle one is. The probe confirms Claude actually *emits* it mid-turn.
- The system-reminder framing, tool suppression, and history exclusion are applied CLI-side inside `runSideQuestion`; Tug does not reproduce them.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Explicit `{#anchor}` on every heading cited later; kebab-case; no phase numbers. Plan-local decisions `[P01]`; open questions `[Q01]`; specs `S01`; risks `R01` — two digits, never reused. Execution steps cite artifacts and anchors, never line numbers; `**Depends on:**` uses `#step-N` anchors.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does Claude service a `side_question` control-request over stream-json, idle AND mid-turn? (DECIDED) {#q01-side-question-servicing}

**Question:** When tugcode writes `{"type":"control_request","request_id":"…","request":{"subtype":"side_question","question":"…"}}` to Claude's stdin in a stream-json session, does Claude answer with a `control_response` carrying `{ response: <text>|null, synthetic: <bool> }` — (a) while idle between turns, and (b) **while a turn is actively streaming**?

**Why it matters:** This is the load-bearing unknown. If yes for both, the whole feature is transport + surface ([P01], Branch A). If yes-idle/no-mid-turn, mid-turn degrades to a queue-until-idle (still useful, smaller). If no for both, fall back to the fork stopgap ([P06], Branch B). The static evidence is strong (`subtype==="side_question"` sits in the binary's inbound control-request dispatch alongside `initialize`/`interrupt`/`set_model`, and the SDK's `askSideQuestion` is literally `this.request({subtype:"side_question",question})` → `{response,synthetic}`), but only a live probe proves the stream-json input path routes it.

**Plan to resolve:** #step-1 probe. Drive Claude directly with tugcode's `buildClaudeArgs` vector; seed a session with a memorable fact; fire the control-request idle and again mid-turn (during a long streaming turn); capture the `control_response`(s) and confirm the main turn is unperturbed.

**Resolution:** **DECIDED — YES for both.** The #step-1 probe (`tugcode/probes/btw/FINDINGS.md`, capture `capture-btw-control-2026-07-09T00-53-51-510Z.*`, CLI 2.1.204) fired a `side_question` control-request idle and again 6s into a long streaming essay turn. Both were serviced with the correct context-aware answer (`XYLOPHONE-42`). The mid-turn `control_response` arrived **33s / ~75 frames before** the essay's own `result`, and the essay completed uninterrupted — genuine mid-turn concurrency. **Branch A (native control-request); no fork fallback ([P06]) needed.**

#### [Q02] What does the `side_question` response look like on the wire — single settled answer, or streamed progress? (DECIDED) {#q02-response-shape}

**Question:** Does the stream-json path deliver one terminal `control_response`, or intermediate progress frames first (the remote path's `onProgress` carried retry/streaming info: `{...Sxy, retryAt}`)? Does `synthetic: true` ever appear (the CLI surfaces synthetic answers differently), and should the overlay distinguish it?

**Why it matters:** Decides whether the `side_question_answer` frame is a one-shot ([P05] renders a settled answer) or needs a progress channel. Default assumption: one settled `control_response` with `{response, synthetic}` (what `askSideQuestion` awaits). Streaming is a refinement, not a blocker (see [#non-goals]).

**Plan to resolve:** #step-1 captures reveal the frame sequence; record in FINDINGS.

**Resolution:** **DECIDED — single settled answer, one leading progress frame.** Each side question emits a two-frame sequence: (1) `{"type":"system","subtype":"control_request_progress","request_id","status":"started"}` (the stream-json analogue of the remote path's `onProgress`, observed carrying only `status:"started"`), then (2) the terminal `control_response`. The answer arrives **whole** in the terminal frame — not streamed token-by-token. `synthetic` was `false` and present in both captures. → the `side_question_answer` frame is a one-shot ([P05]); progressive rendering stays deferred ([#non-goals]). tugcode ignores the progress frame and correlates only the terminal `control_response`.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Control-request refused over stream-json | high | low | Fork stopgap behind the same verb/surface ([P06]) | Probe [Q01] = refused |
| Mid-turn response not serviced | med | low-med | Queue-until-idle degrade; the deck surface is unchanged | Probe [Q01] = idle-only |
| A mid-turn `control_response` collides with turn routing | med | low | Correlation runs pre-routing by `request_id` ([#control-roundtrip]); tugcode test drives a control_response interleaved with turn frames | Any turn misrender in the probe |
| Side-question ink leaks into transcript/replay | med | low | Answer lives only in the overlay store; nothing dispatched to `code-session-store`; app-test asserts transcript unchanged + reload-clean ([P05]) | Transcript row count changes in test |

**Risk R01: A mid-turn side-question response is mis-routed as turn content** {#r01-midturn-routing}

- **Risk:** A `control_response` arriving while `activeTurn !== null` could be handed to `dispatchEventToTurn` and corrupt the streaming turn.
- **Mitigation:** In `handleClaudeLine`, the `control_response` correlation for pending side-questions runs **before** the `system/init` wake check and before turn routing — exactly where `pendingRewindRequests` / `initializeRequestId` are caught today ([#control-roundtrip]). A correlated side-question response is consumed and `return`s; only uncorrelated ones fall through.
- **Residual risk:** Resolved by #step-1. The capture confirms the response is a plain `control_response` tagged by `event.response.request_id` (same as `initialize`/rewind), caught before turn routing. The mid-turn capture proved a `control_response` arriving while the essay turn streamed did not perturb turn routing. The predicate is: `event.type === "control_response"` && `event.response?.request_id ∈ pendingSideQuestions`.

---

### Design Decisions {#design-decisions}

#### [P01] `/btw` drives Claude's native `side_question` control-request; Tug is transport + surface (DECIDED) {#p01-native-control-request}

**Decision:** Tug sends `control_request { subtype: "side_question", question }` to Claude's stdin and renders the `control_response`; it does not reproduce the side-question semantics (system-reminder framing, tool suppression, cache reuse, history exclusion).

**Rationale:**
- Those semantics live inside the CLI's `runSideQuestion` (`<system-reminder>This is a side question…`, "Side questions cannot use tools") and its `askSideQuestion` SDK method is `this.request({subtype:"side_question",question})` — the same `request` primitive as `set_model`. A control-request gets all of it for free.
- tugcode is already a control-request sender (`initialize`/`interrupt`/`set_model`/`set_permission_mode`/`stop_task` via `sendControlRequest`), so this is a new *use* of an existing channel, not new machinery.

**Implications:**
- Correctness rides on Claude's implementation; Tug pins the *wire contract* with fixtures, not the behavior.
- A capability gate exists CLI-side ("This remote connection doesn't support side questions" / "Side questions aren't available when viewing a session read-only"); Tug's local bridge is neither, but the plan tolerates a refusal via [P06].

#### [P02] The side-question surface is a non-modal overlay, never transcript ink (DECIDED) {#p02-nonmodal-overlay}

**Decision:** The answer renders in a **non-modal** overlay (`TugPopover`-based), anchored near the prompt entry — not the pane-modal `TugSheet` (which sets the pane body `inert`, blocking the transcript) and not a transcript row.

**Rationale:**
- Mid-turn is the point ([Q01]b): the user must be able to watch the streaming turn while the side answer loads, so the surface cannot inert the pane. `TugSheet` is documented pane-modal (`tug-sheet.tsx`: "modal scope IS the pane"); `TugPopover` is the non-modal primitive already used by the Z2 popovers.
- "Never enters conversation history" (upstream) maps to "never a transcript row" — and protects replay, which rebuilds the transcript from JSONL where side questions are absent.

**Implications:**
- The overlay composes `TugPopupListFrame`/`TugPopupListItem` (the ask/answer rows) + `PopupCopyButton`, like the WORK popover.
- No dispatch to `code-session-store` — the answer is store-local to the side-question store, so it cannot become transcript state.

#### [P03] Side-question state is ephemeral, session-scoped, un-persisted (DECIDED) {#p03-ephemeral-state}

**Decision:** A `SideQuestionStore` holds the session's ask/answer exchanges in memory only — no tugbank, no JSONL, no localStorage. Cleared on `/clear` (new session) and on card teardown.

**Rationale:**
- Definitionally ephemeral (upstream: "The question and answer are ephemeral"). The constraint bans web storage anyway.
- Session-scoped matches `HooksInventoryStore` (per-card, feed-fed, single request/response) — the store template — extended to keep a short history rather than a single latest.

**Implications:**
- [L02]: the overlay reads the store via `useSyncExternalStore`.
- The dimmed "earlier asks" list is just the store's history array; "clear" empties it.

#### [P04] Mid-turn `/btw` needs no submit-gate change — local commands already dispatch pre-gate (DECIDED) {#p04-submit-exception}

**Decision:** `/btw` inherits mid-turn dispatch for free, with **no change to `performSubmit`**. Local slash commands are already dispatched **before** the send-readiness gate: `tug-prompt-entry.tsx`'s `performSubmit` runs `matchLocalSlashCommand` → `RUN_SLASH_COMMAND` dispatch (the local-command interception block) and the code comment there states it "Runs BEFORE the send-readiness gates … not gated on `canSubmit`"; the `!canSubmit && !canInterrupt` blocked-submit branch sits *after* it. `/btw`, being `supported-local` (added to `LOCAL_SLASH_COMMANDS`), flows through that same pre-gate path.

**Rationale:**
- `/model`, `/tasks`, `/context` etc. already open their surfaces mid-turn today via exactly this path — `/btw` is not special.
- `/btw` never becomes a `user_message`/turn, so the turn-submission gate correctly does not apply; no per-command exception is required (an earlier draft of this plan proposed one — it was unnecessary, verified against the real `performSubmit` ordering).

**Implications:**
- Step 5 makes **no edit to `performSubmit`**; it only registers `btw` in `LOCAL_SLASH_COMMANDS` and wires its surface. The mid-turn behavior is a property of the existing dispatch order.
- The `SideQuestionStore.ask()` → `conn.send(FeedId.CODE_INPUT, …)` is likewise un-gated (the `HooksInventoryStore` precedent sends without a phase gate), so the whole path is turn-state-independent.
- The side-question path has its own in-flight state (the store's `phase`), independent of the turn phase.

#### [P05] The answer is a settled one-shot; the exchange is invisible to the transcript and to replay (DECIDED) {#p05-oneshot-invisible}

**Decision:** The `side_question_answer` frame carries the final `{ response, synthetic }`; the overlay renders it as a single settled answer. Nothing about the exchange is written to the transcript, the code-session store, or any persisted feed.

**Rationale:**
- Matches `askSideQuestion`'s awaited result and upstream's single-response overlay.
- Keeps replay honest — a Developer ▸ Reload re-resumes from JSONL, where side questions never landed, so the reloaded transcript is identical with or without side questions having happened.

**Implications:**
- Streaming/progress is deferred ([Q02], [#non-goals]).
- The app-test can assert transcript row count is unchanged across a `/btw` and that reload leaves no side-question ink.

#### [P06] Fork-resume stopgap behind the same verb/surface if the probe fails (DECIDED, contingent on [Q01]) {#p06-fork-fallback}

**Decision:** If [Q01] shows the control-request is refused over stream-json, tugcode's `side_question` verb instead spawns a one-shot `claude --resume <session-id> --fork-session -p "<question>"` (tool-less), captures its single result, and emits the same `side_question_answer` frame. The deck surface and the inbound/outbound contract are unchanged.

**Rationale:**
- The fork inherits the full conversation (cache reuse) and writes to a *new* session JSONL, leaving the parent transcript untouched — ~90% of the semantics.
- Isolating the backend behind the verb means a later swap to the native channel (when upstream exposes it, or a newer CLI does) touches only tugcode, not the wire contract or the deck.

**Implications:**
- The fork can't see *uncommitted* mid-turn content (a real semantic gap from Branch A) — disclosed in the overlay copy for that branch.
- Branch B is a spawn per question (cost + latency); acceptable for a stopgap, not the target.

---

### Deep Dives {#deep-dives}

#### The `side_question` protocol, from the 2.1.204 binary {#side-question-protocol}

Evidence gathered from `~/.local/share/claude/versions/2.1.204` (bun-compiled; `strings` yields readable identifiers). Cited so a cold reader can re-verify without re-deriving.

- **It is a control-request subtype, not a text-expanding slash command.** The binary's inbound control-request dispatch compares `subtype==="side_question"` alongside `subtype==="initialize"`, `"interrupt"`, `"set_model"`, `"set_permission_mode"`, `"can_use_tool"`, `"mcp_message"` — the known inbound subtypes. An `"Unsupported control request subtype"` error string guards that switch. Every one of `initialize`/`interrupt`/`set_model`/`set_permission_mode` is a subtype **tugcode already sends** via `sendControlRequest` (`tugcode/src/session.ts`).
- **The SDK method is a plain control-request round-trip:**
  `async askSideQuestion(e){ let r=(await this.request({subtype:"side_question",question:e})).response; return r.response===null?null:{response:r.response,synthetic:r.synthetic??false}; }`
  i.e. request `{subtype:"side_question",question}` → response `{ response: string|null, synthetic: boolean }`.
- **The local executor** `runSideQuestion({question, cacheSafeParams, threadHistory:false})` prepends `<system-reminder>This is a side question from the user. You must answer this question directly in a single response.`, enforces "Side questions cannot use tools", reuses the parent conversation's cache-safe params, and does **not** thread the exchange into history (`threadHistory:false`).
- **The remote path** (Remote Control) is `sendControlRequest({subtype:"side_question",question},{signal,onProgress})` and resolves to the same `{response,synthetic}`; `onProgress` carried retry/streaming info. This is the shape [Q02] checks for over stream-json.
- **User-text `/btw` is refused** (`"/btw isn't available in this environment."`, `num_turns:0`) and `btw` is absent from the headless `slash_commands` catalog — which is why the slash-command plan hid it. That refusal is the *text* path; this plan uses the *control-request* path.

#### The control-request round-trip in tugcode (the plumbing template) {#control-roundtrip}

tugcode already runs three host→Claude control round-trips; `/btw` mirrors them exactly.

- **Send:** `sendControlRequest(stdin, requestId, request)` (`tugcode/src/control.ts`) writes `{type:"control_request", request_id, request}` + newline and flushes. Callers in `session.ts`: `initialize` (the turn-free capabilities handshake), `interrupt`, `set_model`, `stop_task`, `set_permission_mode`, and the `/rewind` apply.
- **Correlate the response turn-free:** in `handleClaudeLine`, **before** turn routing and the `system/init` wake check, tugcode catches `control_response` events by `request_id`:
  - the `initialize` handshake: `if (this.initializeRequestId !== null && event.type === "control_response") { … parseInitializeControlResponse(...) … }` → emits `session_capabilities`.
  - `/rewind`: `if (event.type === "control_response" && this.pendingRewindRequests.size > 0 && this.tryHandleRewindControlResponse(event)) return;` where `pendingRewindRequests` is a `Map<requestId, …>` (`session.ts`) and `tryHandleRewindControlResponse` looks up, deletes, and relays as a `rewind_result` frame.
  This pre-routing catch is **turn-state-independent** — it is why a side-question response works idle *and* mid-turn (Risk R01). `/btw` adds a third such branch: a `pendingSideQuestions: Map<requestId, …>` and a `trySideQuestionControlResponse(event)` that emits a `side_question_answer` frame.
- **Inbound verb contract:** a client→tugcode message is admitted only if its `type` is in `INBOUND_VERBS` (`tugproto/src/inbound.ts`) and dispatched only if `INBOUND_HANDLERS` (`tugcode/src/inbound-dispatch.ts`) has an entry. Templates: `stop_task: (msg,{sessionManager}) => sessionManager?.handleStopTask(msg.task_id)` (sends a control-request); `hooks_query: (msg,{…,writeLine}) => writeLine(buildHooksInventory({…, requestId: msg.request_id}))` (request/response with a `request_id`).

#### The client-side query store (the surface template) {#query-store}

`HooksInventoryStore` (`tugdeck/src/lib/hooks-inventory-store.ts`) is the exact shape a `SideQuestionStore` extends:
- constructed per card with `(feedStore, feedId, tugSessionId)`, subscribes to the CODE_OUTPUT feed, and on each update parses the payload filtered to its frame `type` and matches `parsed.request_id !== this._snapshot.requestId` to correlate.
- `requestHooks()` mints a `request_id` (`hk-${seq}`), sets `phase: "loading"`, and `conn.send(FeedId.CODE_INPUT, encode({tug_session_id, type:"hooks_query", request_id}))`.
- exposes `subscribe` / `getSnapshot` for `useSyncExternalStore` ([L02]).

`SideQuestionStore` differs in three ways: the request payload carries `question`; the response comes from Claude (not built locally by tugcode); and it keeps a **history array** of `{question, answer, synthetic, at}` rather than a single latest, so the overlay can dim earlier asks.

The card wires it in `card-services-store.ts` (where `hooksInventoryStore` is constructed and the CODE_OUTPUT feed is filtered per session), and the `/btw` surface opens from `slashCommandSurfaces` in `dev-card.tsx` — the compile-enforced `Record<LocalCommandName, …>` map (the `/tasks` → `openWorkPopover()` precedent, [D107]).

---

### Specification {#specification}

**Spec S01: the `side_question` wire contract** {#s01-wire-contract}

- **Inbound (client → tugcode), new verb:**
  ```ts
  interface SideQuestion { type: "side_question"; request_id: string; question: string; }
  ```
  Added to `INBOUND_VERBS` + the `InboundMessage` union in `tugproto/src/inbound.ts`, and to `INBOUND_HANDLERS` in `tugcode/src/inbound-dispatch.ts`.
- **tugcode → Claude (control-request):** `sendControlRequest(stdin, request_id, { subtype: "side_question", question })`. The client's `request_id` is reused as the control `request_id` so one map keys the whole round-trip.
- **Claude → tugcode (control-response):** `{ type:"control_response", response:{ subtype:"success", request_id, response:{ response: string|null, synthetic: boolean } } }` — **exact nesting confirmed at #step-1** (`FINDINGS.md`): correlate on `event.response.request_id`; answer is `event.response.response.response` (string|null); flag is `event.response.response.synthetic` (may be absent → default `false`). A leading `{ type:"system", subtype:"control_request_progress", request_id, status:"started" }` frame precedes it and is **ignored** by the correlation predicate (it is not a `control_response`).
- **tugcode → client (new outbound frame):**
  ```ts
  interface SideQuestionAnswer {
    type: "side_question_answer";
    tug_session_id: string;  // the filter narrows per session (mirrors HooksInventory)
    request_id: string;
    answer: string | null;   // null → "no response received"
    synthetic: boolean;
    ipc_version: number;
  }
  ```
  Added to the `OutboundMessage` union in `tugcode/src/types.ts`. **It is NOT added to `KNOWN_CODE_OUTPUT_TYPES`** — that set is the *code-session store's own* allowlist (`code-session-store.ts`: `if (!KNOWN_CODE_OUTPUT_TYPES.has(ev.type)) return null` drops any type not in it), and leaving `side_question_answer` out is exactly what keeps it invisible to the transcript store ([P05]). The frame is instead read by `SideQuestionStore` via a **dedicated `FeedStore` + `FeedStoreFilter`** narrowing to `type === "side_question_answer"` && the session id — the same mechanism `hooks_inventory` uses (`hooksInventoryFilter` / `hooksInventoryFeedStore` in `card-services-store.ts`), NOT the code-session store. The `tug_session_id` field is what the filter matches on (mirroring the `HooksInventory` frame).

**Spec S02: `SideQuestionStore`** {#s02-store}

```ts
interface SideQuestionExchange {
  readonly id: string;            // the request_id
  readonly question: string;
  readonly phase: "loading" | "answered" | "error";
  readonly answer: string | null; // settled answer, or null
  readonly synthetic: boolean;
  readonly at: number;            // ask time (impure wrapper stamps it)
}
interface SideQuestionSnapshot {
  readonly exchanges: readonly SideQuestionExchange[]; // newest last; current is the tail
}
```
- `ask(question)`: mint `request_id` (`btw-${seq}`), push a `loading` exchange, `conn.send(CODE_INPUT, encode({tug_session_id, type:"side_question", request_id, question}))`.
- feed update: parse `side_question_answer`, match `request_id`, flip that exchange to `answered`/`error` with the settled `answer`.
- `clear()`: empty the history (the overlay's `x`).
- Ephemeral, per-card ([P03]); no persistence.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `SideQuestionStore.exchanges` | local-data (session store, ephemeral) | dedicated store + `useSyncExternalStore`; fed by the CODE_OUTPUT feed; no persistence | [L02] |
| Overlay open/closed | local-data (component) | `TugPopover` imperative handle (the Z2 `popoverRef` precedent) | — |
| Overlay + row appearance (dim earlier asks, synthetic marker) | appearance | CSS + `data-*` attrs, never React state | [L06] |
| Mid-turn dispatch | structure (route) | none — inherits the existing pre-`canSubmit` local-command dispatch in `performSubmit` ([P04]) | — |
| `side_question_answer` correlation | local-data (dedicated feed) | `SideQuestionStore` reads a `FeedStore`+`FeedStoreFilter` on CODE_OUTPUT (the `hooksInventory` pattern), NOT the code-session store | [L02] |
| `pendingSideQuestions` (tugcode) | n/a (Node bridge) | `Map<requestId,…>` on `SessionManager`, mirrors `pendingRewindRequests` | — |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugcode/probes/btw/probe-btw-control.mjs` | [Q01]/[Q02] probe: `side_question` control-request idle + mid-turn |
| `tugcode/probes/btw/FINDINGS.md` | Probe findings, cited by #step-2 resolutions |
| `tugdeck/src/lib/side-question-store.ts` | `SideQuestionStore` (Spec S02) |
| `tugdeck/src/components/tugways/cards/side-question-overlay.tsx` | The non-modal `/btw` overlay ([P02]) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `SideQuestion` | interface + verb | `tugproto/src/inbound.ts` | `INBOUND_VERBS` + union member (Spec S01) |
| `side_question` handler | entry | `tugcode/src/inbound-dispatch.ts` | → `sessionManager.handleSideQuestion(msg)` |
| `handleSideQuestion` | method | `tugcode/src/session.ts` | sends the control-request; registers `pendingSideQuestions` |
| `pendingSideQuestions` | field | `tugcode/src/session.ts` | `Map<requestId,{question}>`, mirrors `pendingRewindRequests` |
| `trySideQuestionControlResponse` | method | `tugcode/src/session.ts` | pre-routing catch in `handleClaudeLine`; emits `side_question_answer` |
| `SideQuestionAnswer` | interface | `tugcode/src/types.ts` | `OutboundMessage` union (Spec S01) |
| `SideQuestionStore`, `parseSideQuestionAnswerPayload` | class/fn | `tugdeck/src/lib/side-question-store.ts` | Spec S02; reads a dedicated `FeedStore`, not the code-session store |
| `sideQuestionFilter`, `sideQuestionFeedStore`, `sideQuestionStore` | fields | `tugdeck/src/lib/card-services-store.ts` | `FeedStoreFilter` (`type === "side_question_answer"` && session) + `FeedStore` + store, mirroring `hooksInventoryFilter`/`hooksInventoryFeedStore`/`hooksInventoryStore`. **`KNOWN_CODE_OUTPUT_TYPES` is NOT touched** ([P05]). |
| `btw` | entry | `tugdeck/src/lib/slash-commands.ts` `LOCAL_SLASH_COMMANDS` | `{name:"btw", description, takesArgs:true}` |
| `btw` removal | edit | `tugdeck/src/lib/slash-supported.ts` `HIDDEN_SLASH_COMMANDS` | drop the hidden entry |
| `btw` surface | entry | `tugdeck/src/components/tugways/cards/dev-card.tsx` `slashCommandSurfaces` | opens the overlay with the arg as the question |
| (mid-turn) | — | `tug-prompt-entry.tsx` `performSubmit` | **no edit** — `/btw` inherits the existing pre-`canSubmit` local-command dispatch ([P04]) |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/dev-card-unsupported-slash-commands.md` — remove `/btw` from the hidden list; note it graduated to `supported-local` (native side-question channel).
- [ ] `tuglaws/slash-commands.md` — update the `/btw` worked example (from "hidden — refused headless" to "supported-local — native `side_question` control-request"); document the control-request path as a fourth support mechanism beyond text pass-through.
- [ ] `tuglaws/design-decisions.md` — a new global decision recording the native side-question channel and the overlay-only / ephemeral / mid-turn rules.
- [ ] `reference` memory: the `side_question` control-request subtype (so it isn't re-discovered).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Probe capture** | pin the `side_question` wire contract (idle + mid-turn) on 2.1.204 | #step-1 |
| **Unit** | `SideQuestionStore` correlation/history; the control-response parser; classifier tier | pure logic |
| **Integration (tugcode)** | `handleSideQuestion` → control-request; `trySideQuestionControlResponse` emits the frame, interleaved with turn frames | `tugcode` tests, style of the rewind/control tests |
| **App-test (real app)** | `/btw` overlay renders; transcript unchanged; reload-clean; mid-turn ask during a live turn (real-claude) | `just app-test`; real-claude on-demand |

#### What stays out of tests {#test-non-goals}

- jsdom/RTL render tests and mock-store assertion tests — banned; behavior proven in the real app.
- Claude's side-question *answer quality* — upstream's; we pin the wire shape (captures), not the content.
- Streaming/progressive rendering — deferred ([Q02]).
- The fork stopgap ([P06]) unless [Q01] forces Branch B.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Applies to every step.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Probe `side_question` control-request | done | 7520cc942 |
| #step-2 | Decision gate: resolve Q01/Q02 | done | 9ccb2db27 |
| #step-3 | tugcode: inbound verb + control round-trip + frame | done | acd887551 |
| #step-4 | tugdeck: SideQuestionStore + wire types | done | ec7c63b9d |
| #step-5 | tugdeck: `/btw` local command + overlay + mid-turn exception | done | 17a5abaa8 |
| #step-6 | Docs + design decision + reload-clean app-test | done | 2cddcca5f |
| #step-7 | Integration checkpoint | done | (verification only) |

#### Step 1: Probe `side_question` control-request {#step-1}

**Commit:** `probe(btw): capture side_question control-request over stream-json on 2.1.204`

**References:** [Q01] servicing, [Q02] response shape, (#side-question-protocol, #control-roundtrip)

**Artifacts:**
- `tugcode/probes/btw/probe-btw-control.mjs` + timestamped captures (style of `tugcode/probes/goal-loop/`).
- `tugcode/probes/btw/FINDINGS.md`.

**Tasks:**
- [ ] Spawn Claude directly with tugcode's `buildClaudeArgs` vector (see the goal/loop probes for the exact flags; `--input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --permission-mode bypassPermissions --session-id <uuid>`).
- [ ] Seed context: send a normal user turn establishing a memorable fact.
- [ ] **Idle case:** after the turn completes, write `{"type":"control_request","request_id":"btw-1","request":{"subtype":"side_question","question":"<about the fact>"}}` to stdin; capture the `control_response`; record the exact nesting and whether `synthetic` appears.
- [ ] **Mid-turn case:** start a long streaming turn (e.g. "count slowly to 30, one line each"), and *while it streams* write a second side-question control-request; capture whether a `control_response` arrives before the turn's `result`, and confirm the turn's own output is complete and uninterrupted.
- [ ] Inspect the session JSONL afterward: confirm neither side question entered history.
- [ ] Record [Q01] (idle yes/no, mid-turn yes/no) and [Q02] (single vs streamed; `synthetic`) in FINDINGS.md.

**Tests:**
- [ ] N/A (probe artifacts are the deliverable).

**Checkpoint:**
- [ ] FINDINGS.md states, with capture evidence, whether the control-request is serviced idle and mid-turn, the exact `control_response` nesting, and the response shape.

---

#### Step 2: Decision gate — resolve Q01/Q02 {#step-2}

**Depends on:** #step-1

**Commit:** `plan(btw): resolve open questions from the side_question probe`

**References:** [Q01], [Q02], [P01], [P06], Spec S01, (#open-questions)

**Artifacts:**
- This document updated: [Q01]/[Q02] flipped to DECIDED with pointers into `tugcode/probes/btw/FINDINGS.md`; Spec S01's `control_response` nesting finalized; the Branch (A native / B fork) chosen; #step-3 scoped to it.

**Tasks:**
- [ ] Write the resolutions. If [Q01] = serviced (expected), Branch A; if idle-only, note the queue-until-idle degrade; if refused, switch #step-3 to Branch B ([P06]) and record the upstream ask.
- [ ] Finalize the exact parser predicate for `trySideQuestionControlResponse` from the capture.

**Tests:**
- [ ] N/A.

**Checkpoint:**
- [ ] No `(OPEN)` markers remain in this plan's Open Questions.

---

#### Step 3: tugcode — inbound verb + control round-trip + frame {#step-3}

**Depends on:** #step-2

**Commit:** `feat(tugcode): side_question verb → control-request → side_question_answer frame`

**References:** [P01] native channel, [P05] one-shot, Spec S01, Risk R01, (#control-roundtrip)

**Artifacts:**
- `tugproto/src/inbound.ts`: `SideQuestion` interface + `INBOUND_VERBS` entry + union member.
- `tugcode/src/inbound-dispatch.ts`: `side_question` handler → `sessionManager.handleSideQuestion(msg)`.
- `tugcode/src/session.ts`: `pendingSideQuestions` map; `handleSideQuestion` (sends `sendControlRequest(stdin, msg.request_id, {subtype:"side_question", question:msg.question})`, registers the map); `trySideQuestionControlResponse` caught in `handleClaudeLine` **before** turn routing (beside the `initialize`/`pendingRewindRequests` catches), emitting `side_question_answer`.
- `tugcode/src/types.ts`: `SideQuestionAnswer` (with `tug_session_id`) in the `OutboundMessage` union; `handleSideQuestion` stamps `tug_session_id` on the emitted frame so the deck's per-session filter can narrow it (the `buildHooksInventory` precedent).
- (Branch B only: `handleSideQuestion` spawns `claude --resume … --fork-session -p` instead — same frame out.)

**Tasks:**
- [ ] Implement the verb + round-trip per the #step-1 capture; parser tolerant of missing `synthetic`.
- [ ] Ensure the pre-routing catch consumes and `return`s a correlated response (Risk R01) and lets uncorrelated ones fall through.

**Tests:**
- [ ] tugcode integration test: `handleSideQuestion` writes the expected control-request; a matching `control_response` (from the captured shape) yields one `side_question_answer` frame; an interleaving where the response arrives between turn frames still correlates and does not perturb turn routing.
- [ ] Inbound-contract coverage test still passes (every non-special verb has a handler).

**Checkpoint:**
- [ ] `cd tugcode && bun test` green.

---

#### Step 4: tugdeck — SideQuestionStore + wire types {#step-4}

**Depends on:** #step-3

**Commit:** `feat(tugdeck): SideQuestionStore + side_question wire types`

**References:** [P03] ephemeral, [P05] invisible, Spec S02, (#query-store, #state-zone-mapping)

**Artifacts:**
- `tugdeck/src/lib/side-question-store.ts`: `SideQuestionStore` + `parseSideQuestionAnswerPayload` (Spec S02), mirroring `HooksInventoryStore` (reads a `FeedStore`, exposes `subscribe`/`getSnapshot`).
- `tugdeck/src/lib/card-services-store.ts`: a `sideQuestionFilter` (`FeedStoreFilter` narrowing to `type === "side_question_answer"` && `tug_session_id === binding.tugSessionId`) + a `sideQuestionFeedStore` (`new FeedStore(connection, [FeedId.CODE_OUTPUT], undefined, sideQuestionFilter)`) + the `sideQuestionStore`, exactly mirroring the `hooksInventoryFilter`/`hooksInventoryFeedStore`/`hooksInventoryStore` triple.
- **No change to `KNOWN_CODE_OUTPUT_TYPES`** — leaving `side_question_answer` out keeps `code-session-store`'s `frameToEvent` dropping it (`return null`), which is precisely the [P05] transcript-invisibility invariant. The dedicated feed store above is the read path.

**Tasks:**
- [ ] Implement the store: `ask(question)` sends the CODE_INPUT `side_question` verb with a minted `request_id`; feed updates correlate by `request_id` and flip the exchange; `clear()` empties history.
- [ ] Confirm no path dispatches the answer into `code-session-store` (transcript stays clean).

**Tests:**
- [ ] Unit: `ask` → loading exchange; a matching `side_question_answer` → answered with the settled text; a non-matching id is ignored; `clear` empties; history preserves order.

**Checkpoint:**
- [ ] `cd tugdeck && bun test` green; `bunx tsc --noEmit` clean.

---

#### Step 5: tugdeck — `/btw` local command + overlay + mid-turn exception {#step-5}

**Depends on:** #step-4

**Commit:** `feat(tugdeck): /btw side-question overlay, usable mid-turn`

**References:** [P02] non-modal overlay, [P04] inherited pre-gate dispatch, [P05], [D107] (surface precedent), Spec S02, (#state-zone-mapping)

**Artifacts:**
- `tugdeck/src/lib/slash-commands.ts`: `btw` added to `LOCAL_SLASH_COMMANDS` (`takesArgs:true`); auto-classifies `supported-local`.
- `tugdeck/src/lib/slash-supported.ts`: `btw` removed from `HIDDEN_SLASH_COMMANDS`.
- `tugdeck/src/components/tugways/cards/side-question-overlay.tsx`: a non-modal `TugPopover`-anchored panel composing `TugPopupListFrame`/`TugPopupListItem` — the current answer (or a loading pose), earlier asks dimmed above it, `PopupCopyButton`, and a clear (`x`). Reads `sideQuestionStore` via `useSyncExternalStore`.
- `tugdeck/src/components/tugways/cards/dev-card.tsx`: `slashCommandSurfaces.btw = (arg) => { sideQuestionStore.ask(arg); openSideQuestionOverlay(); }`.
- **No `performSubmit` edit** ([P04]): `/btw`, as a `LOCAL_SLASH_COMMANDS` entry, is dispatched by the existing local-command interception which already runs before the `canSubmit` gate — mid-turn works for free, like `/model`. Step verifies this rather than adding an exception.

**Tasks:**
- [ ] Wire the command → surface; the trailing text is the question (`takesArgs`).
- [ ] Build the overlay from Tug primitives (no hand-rolled UI); answer never renders as transcript ink.
- [ ] Verify mid-turn works with **no** `performSubmit` change — the pre-`canSubmit` local dispatch already covers it ([P04]); confirm by driving `/btw` while a turn streams in the app-test.

**Tests:**
- [ ] Classifier test: `btw` is `supported-local`, absent from `HIDDEN_SLASH_COMMANDS`.
- [ ] App-test (standard tier): typing `/btw x` opens the overlay and the transcript row count is unchanged.

**Checkpoint:**
- [ ] `cd tugdeck && bun test` + `bunx vite build` green; `just app-test <overlay test>` PASS.

---

#### Step 6: Docs + design decision + reload-clean app-test {#step-6}

**Depends on:** #step-5

**Commit:** `docs(tuglaws): record native /btw side questions; assert reload-clean`

**References:** [P02], [P03], [P05], Spec S01, (#documentation-plan)

**Artifacts:**
- `tuglaws/dev-card-unsupported-slash-commands.md`, `tuglaws/slash-commands.md`, `tuglaws/design-decisions.md` updated per (#documentation-plan).
- A `reference` memory for the `side_question` control-request subtype.
- App-test: a `/btw` exchange leaves no transcript ink and a Developer ▸ Reload reconstructs the transcript with no side-question trace ([P05]).

**Tasks:**
- [ ] Write the doc updates + the design decision.
- [ ] Add the reload-clean assertion (resume-from-JSONL is the established mechanism; the reloaded transcript must equal the pre-`/btw` transcript).

**Tests:**
- [ ] App-test: transcript unchanged across `/btw`; reload-clean.

**Checkpoint:**
- [ ] Grep confirms no doc still calls `/btw` hidden/unsupported; suites green.

---

#### Step 7: Integration checkpoint {#step-7}

**Depends on:** #step-3, #step-4, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria), Risk R01

**Tasks:**
- [ ] Full suites: `cd tugdeck && bun test`, `bunx vite build`, `cd tugcode && bun test`, `cd tugrust && cargo nextest run`, `just app-test`.
- [ ] Real-claude (on-demand) end-to-end: ask `/btw` **mid-turn** during a live streaming turn — the answer appears in the overlay, the main turn finishes uninterrupted, the transcript gains no rows, and a reload leaves no trace. Ask a `/btw` referencing an earlier session fact — answered correctly.
- [ ] Walk the Success Criteria; check each with its verification.

**Tests:**
- [ ] The above, aggregated.

**Checkpoint:**
- [ ] Every Success Criterion verified; all suites green.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** `/btw` is a first-class Dev-card side question — ask mid-turn or idle, answered from the live conversation with no tools, rendered in a non-modal overlay that never touches the transcript — driven by Claude Code's native `side_question` control-request.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] The `side_question` wire contract is pinned by probe captures + a tugcode test on 2.1.204. (`cd tugcode && bun test`)
- [ ] `/btw` classifies `supported-local`; hidden-list + mirror doc agree. (`bun test slash`)
- [ ] A mid-turn `/btw` shows an answer in the overlay without interrupting the streaming turn. (real-claude app-test)
- [ ] The exchange adds no transcript rows and survives a reload with no trace. (app-test)
- [ ] `bunx vite build` + full `just app-test` green.

**Acceptance tests:**
- [ ] `just app-test` (standard tier) — overlay renders, transcript unchanged, reload-clean.
- [ ] Real-claude tier (on-demand) — mid-turn side question; context-aware answer.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Fork-into-session (`f`) — bind the forked side question as a new card session.
- [ ] Streamed/progressive answer rendering (gated on [Q02]).
- [ ] Retire the fork stopgap if Branch B shipped and the native channel later opens.

| Checkpoint | Verification |
|------------|--------------|
| Probe answers Q01/Q02 | `tugcode/probes/btw/FINDINGS.md` |
| Native round-trip works | `cd tugcode && bun test` |
| `/btw` overlay + mid-turn | real-claude app-test |
| Transcript/replay clean | `just app-test` |
