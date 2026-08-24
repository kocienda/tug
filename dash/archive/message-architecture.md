## Message-Centric Transcript Architecture {#message-architecture}

**Purpose:** Replace the Dev card's turn-paired row model with a flat, message-derived row stream so a user message can stand alone in the transcript — unlocking mid-turn message *steering* (queued messages claude picks up while working, like the Claude Code TUI) and leaving the door open for future non-assistant message kinds (e.g. shell interactions) to interleave.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-18 |

---

### Implementation handoff (read first) {#handoff}

> Hard-won context from the design conversation, for the implementer. Step 1 is **done & committed** (`85bf8217`). Implement on a `tugutil dash` worktree (per CLAUDE.md — commit per sub-step via `tugutil dash commit`, never on `main`). **Start with Steps 2–4** (the message-derived row refactor) — independent of the steering unknown and the substrate everything else needs.

**Read the evidence first:** `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.181-steering-spike/queued-command-mechanism.md` (the corpus finding), and real sessions `5eefeaec`, `48d25803`, `17ed0b90` if you need to re-see the mechanism.

**Verified code hooks (this session):**
- `handleToolResult` (reducer.ts) — the mid-turn boundary; the steering forward + placement hangs here (gate to live `tool_work`, not `replaying`).
- `handleSend` (reducer.ts) — already *holds* `queuedSends` without forwarding; keep that (it's what makes retraction work).
- `dev-transcript-data-source.ts` — the row projection (Steps 2–4) and the existing dimmed foot-ghost rendering (reuse, unchanged).
- `handleAddUserMessage` (reducer.ts, replay-oriented) — needs the *mid-turn append* fork for the reload path (append to the in-flight turn, don't open a new one).
- `userMessageKey` / `messageKey` (`${turnKey}-user`) — an absorbed message keeps its own key (`[P04]`).

**Settled decisions — do NOT relitigate (each was a wrong turn earlier):**
- **Hold client-side; do not forward until the boundary.** No timer, no early forward. That hold is *why* a queued message stays retractable.
- **One ghost state** (retractable), reuse the existing foot ghost. No "sent" state, no two-state tuning, no composer-area chrome.
- **Merge at the iteration boundary; no phantom turn.** Place the user row at the boundary; reload from JSONL is authoritative.
- **`/rewind` stays turn-opener anchored** (`[P05]`) — do not move `promptUuid` onto messages in v1.

**The one real risk (`[Q01]` caveat / Step 6):** the merge-vs-buffer ratio is verified for the **TUI**, not the **stream-json/tugcode** path. Step 6 must capture a *real Dev-card* mid-turn steer and measure it. Design degrades gracefully — if claude buffers instead of merges, reload relocates the message to its own turn (reload is authoritative). Don't assume the TUI's 93% holds on the wire path.

**Two tightenings to fold during build:** (1) gate the boundary-flush to live `tool_work` so a reload's replayed `tool_result`s don't re-forward; (2) in Step 6, treat reload as *correcting* placement (incl. relocating a buffered message), not merely nudging offset.

**Build/run:** bun (never npm); tugdeck HMR is live (no manual build); `just app-test` for the real app (default run does **not** spawn real claude — real-claude steering is on-demand only).

---

### Phase Overview {#phase-overview}

#### Context {#context}

Today a user message typed while a turn is streaming is held client-side in `queuedSends` and only forwarded to the backend at `turn_complete(success)` (the legacy `D-T3-07` behavior, documented in `dash/archive/tide.md` and encoded in the reducer's `handleSend` / `handleTurnComplete` comments). The backend is already capable of steering — `tugcode` writes user messages to claude's stdin immediately (`handleUserMessage`) and spawns claude with `--input-format stream-json --include-partial-messages`, so claude *can* merge a mid-turn message into the running turn at an agent-loop boundary. The only thing suppressing steering is the tugdeck reducer refusing to emit the frame until the turn ends.

The deeper blocker is the **rendering model**, not the queue. `dev-transcript-data-source.ts` projects at most two rows per turn — one user row + one assistant row — gated on `TurnEntry.origin`. A user message that claude *merges* mid-turn (a second `user_message` appearing partway through a turn's `messages`) has nowhere to render. So before steering can ship, the transcript must become a flat message-row stream where a user message is a first-class row independent of any assistant response. That refactor is also the architecture we want regardless: the data layer is *already* a flat `messages: ReadonlyArray<Message>` list (paired `userMessage`/`assistant` fields were retired); only the row-projection layer still assumes pairs.

**How steering actually works (Step 1, resolved).** A corpus survey of 470 real `queued_command` injections (`[Q01]`, `stream-json-catalog/v2.1.181-steering-spike/queued-command-mechanism.md`) settles it: a message typed mid-turn is **merged into the running turn at the next agent-loop iteration boundary** — injected as a `user_message` **threaded right after the current step's `tool_result`** (93% of cases), after which the turn continues. It is *not* deferred to the turn boundary (the <1% exception). The Dev card feels "end-of-turn" only because it currently holds `queuedSends` and flushes at `turn_complete`; forwarding mid-turn (`[P06]`) lets claude merge at its iteration boundary like the TUI. The flat row model (Steps 2–4) renders the merged `user_message` directly as a mid-turn user row. The rendering refactor (Steps 2–4) is independent and can land first. claude does **not** echo the steered text on the live wire (`[Q02]`), so the user row is placed **optimistically live** (tugdeck owns the text) and made **exact on reload** from JSONL.

#### Strategy {#strategy}

- **Characterize the mechanism first (Step 1, done).** From real session JSONL: steering = merge into the running turn at the agent-loop iteration boundary, signature `user_message`/`queued_command` after a `tool_result` (`[Q01]`). This grounds the placement design (`[P07]`) before steering code.
- **Refactor the row projection (Steps 2–4), behavior-preserving.** Rows derive from each turn's `messages` (walk + group) instead of the 2-row/origin template; `messageKey` addressing with derived `#uN`/`#aN` labels; multi-user-per-turn rendering. Independent of Step 1 — ships on its own value, and is exactly what renders a merged mid-turn `user_message`.
- **Wire steering on top (Steps 5–6).** Keep the existing `×`-retractable dimmed foot ghost (one state) and hold it client-side; at the next mid-turn `tool_result` boundary pick it up atomically — forward + remove-from-queue + place as a real mid-turn row via the flat model (`[P06]`/`[P07]`). Retractable until pickup; no live echo needed (`[Q02]`), reload from JSONL authoritative.
- **Leave `/rewind` anchored on turn openers** — merged mid-turn messages render but are not independently rewind-targetable in v1, keeping the rewind picker and the "first prompt_anchor wins" reducer invariant untouched.
- **Sequence so each step has a falsifiable checkpoint**, with the steering UX layered only after the rendering substrate is in place.

#### Success Criteria (Measurable) {#success-criteria}

> Make these falsifiable. Avoid "works well".

- Step 1 characterizes the steering mechanism from real session JSONL and `[P07]` records the placement design with evidence. (`#step-1`, `[Q01]`)
- A message queued while `phase` is streaming/tool_work is forwarded at the next mid-turn `tool_result` (not held to `turn_complete`), verifiable by a reducer test asserting a `send-frame` is emitted on a mid-turn `tool_result` before any `turn_complete`. (`#s02-steer-lifecycle`, `[P06]`)
- A queued message is never forwarded twice (boundary forward vs end-of-turn fallback): no test produces two `send-frame`s for one entry. (`[P06]`, `Risk R03`)
- A queued message renders as the existing `×`-retractable dimmed foot ghost (one state) and is retractable until pickup; at the boundary it becomes a real mid-turn user row via the flat row model. (`[P07]`)
- A turn whose `messages` contains a `user_message` at a non-head index renders as `user, assistant, user, assistant` rows in arrival order, each user row keyed by its own `messageKey`, with the per-turn badge on the bracket's last assistant row. (`Spec S01`, `[P04]`)
- All existing `dev-transcript-data-source`, `code-session-store` queue, and `reducer.rewind` tests pass unchanged after the rendering refactor. (`#step-2`, `[P05]`)
- `/rewind` still anchors correctly on turn openers; a merged turn's second user message renders but is correctly absent from the rewind picker. (`[P05]`)
- `cargo`/`bun` builds stay warning-clean and the Dev card app-test for mid-turn steering passes (`just app-test`). (`#exit-criteria`)

#### Scope {#scope}

1. Characterize the steering mechanism from real session JSONL; finalize `[P07]` (merge at the iteration boundary).
2. Row-projection refactor in `dev-transcript-data-source.ts` (layout, addressing, `rowAt`/`kindForIndex`/`idForIndex`).
3. `messageKey`-based addressing + derived `#uN`/`#aN` labels; per-turn-telemetry anchoring for multi-assistant-row turns.
4. Multi-user-per-turn rendering, with the absorbed-message keying invariant and per-turn-token badge placement.
5. Steering forward: hold queued messages client-side (existing retractable foot ghost); pick up at the next mid-turn `tool_result` (forward + remove + place); `turn_complete` fallback.
6. Place the merged `user_message` as a mid-turn user row (after the `tool_result`).
7. Revise the `D-T3-07` behavior note and the reducer/data-source docstrings.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Shell interactions in the transcript. The model is designed to *admit* new `Message.kind`s additively, but no shell kind, renderer, or backend is built here.
- Moving the `/rewind` anchor onto individual messages / making merged mid-turn messages rewind-targetable. Rewind anchors on turn openers in v1 (`[P05]`); per-message rewind is a follow-on.
- Restructuring the "thinking" indicator into standalone phase chrome. The assistant row already renders `assistant_thinking` inline; `[P07]` (no phantom turn) is the only optimistic-turn change this plan makes.
- Changing the backend (`tugcode`/`tugcast`) steering mechanics. The backend already forwards mid-turn; only the tugdeck client and the wire signals it *reads* are in scope. (If the spike shows a merge is truly unobservable live and we *want* it observable, that backend change is a separate plan.)
- A wall-clock cancel window / debounce before forwarding (`[Q03]` retired) — the trigger is the agent-loop boundary, and a message is cancelable until then.

#### Dependencies / Prerequisites {#dependencies}

- The reducer already processes `tool_result` events mid-turn (the boundary trigger) and already holds `queuedSends` — the steering forward is a new branch in the existing reduce path, not new infrastructure.
- `tugcode`'s mid-turn merge/buffer behavior is observable on the wire (`tugcode/.../probe-tool-overlap.ts`, the `stream-json-catalog` fixtures) — the Step 1 spike's substrate.
- Every Message already carries a stable `messageKey` (`MessageBase`).

#### Constraints {#constraints}

- tugdeck laws: external state via `useSyncExternalStore` only (`[L02]`); appearance via CSS/DOM not React state (`[L06]`); mount identity stable across in-flight→committed (`[L26]`) and scroll/content preserved (`[L23]`). The row refactor must not regress the no-remount-at-`turn_complete` guarantee.
- The reducer stays **pure**: the steering forward is triggered by a wire event (`tool_result`) already in the reduce path — no wall-clock/`Date.now()` and no timer machinery.
- Builds enforce `-D warnings`; tugdeck HMR is live (no manual builds); app-tests via `just app-test` (default run does **not** spawn real claude — real-claude steering is the on-demand path).

#### Assumptions {#assumptions}

- The **buffer** path is live-observable: claude runs a buffered mid-turn message as a follow-on turn with its own `result`, and tugcode opens an `ActiveTurn` for it (`session.ts` `pendingTurnInputs` doc). The steering design relies on this; the spike confirms the exact wire shape.
- A turn bracket (one claude `result`) may legitimately contain ≥1 `user_message` after merge; cost/timing/telemetry aggregate over the bracket unchanged.
- The recency relationship ("assistant responds to the most recent user message") is presentational only; `/rewind` uses the turn-opener `promptUuid`, never recency or a merged message.
- The steering pickup is a **merge at the agent-loop iteration boundary** (Step 1 corpus finding, `[Q01]`). claude does **not** echo the steered text on the live wire (`[Q02]`, confirmed), so the mid-turn user row is placed optimistically live and made exact on reload.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings and rich `References:` lines. Plan-local decisions are `[P01]…`; global decisions cited by `[D##]`. Step dependencies cite `#step-N` anchors. No line numbers in references.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] How is a steered message picked up? (RESOLVED — merge at the iteration boundary) {#q01-merge-wire}

**Question:** When a message is typed while a turn runs, how/when does claude pick it up — merge into the running turn, or defer to a turn boundary?

**Resolution:** DECIDED — **it merges into the running turn at the next agent-loop iteration boundary**, i.e. immediately after the current step's `tool_result`. Established from a corpus survey of **470 real `queued_command` injections across 42 sessions** (claude 2.1.133–2.1.177): **93%** thread directly after a `tool_result` (mid-loop), and the large majority are followed by an assistant `stop=tool_use` — the *same turn continues*. Only <1% land at `end_turn` (the rare case where no further tool step was pending — which is what my earlier, retracted "turn boundary" reading generalized from). Wait time (typed → injected) is p50 8s / p90 50s / max ~7min — exactly "time until the current step finishes," which is the "doesn't get handled for a while" experience.

**Mechanism / signature:** `queue-operation:enqueue` (typed while busy) → waits for the current step → `queue-operation:remove` + an injected `user_message` (in the TUI: a `queued_command` attachment) **threaded after a `tool_result`**, surrounding assistant entries `stop=tool_use`. The steered message becomes a `user_message` interleaved **mid-turn**, before the assistant's continuation. Background `<task-notification>`s ride the identical path. Full analysis + evidence: `stream-json-catalog/v2.1.181-steering-spike/queued-command-mechanism.md`.

**Layer caveat:** these records come from the Claude Code **TUI** (`entrypoint: cli`); the **Dev card** (tugcode + stream-json) currently holds `queuedSends` and flushes at `turn_complete` — which is *why* cued messages feel "only at end of turn" in the Dev card. The underlying claude behaviour (merge at the iteration boundary) is available to the Dev card **if it forwards mid-turn** (`[P06]`). claude does not echo the steered text on the live stream-json wire (`[Q02]`, resolved), so the merged user row is placed optimistically live (tugdeck owns the text) and made exact on reload from JSONL.

#### [Q02] Does the live wire surface the merged message? (RESOLVED — no) {#q02-reconcile-fallback}

**Question:** Does the **live** Dev-card/tugcode stream-json wire surface the merged `user_message` in real time, or only persist it to JSONL?

**Resolution:** DECIDED — **no live echo.** Confirmed three ways: (1) the raw probe — after a mid-turn injection the only `user` stdout events are claude's own `[tool_result]`s, never the steered text; (2) tugcode emits `add_user_message` only on synthetic/replay/snapshot paths, never steady-state live; (3) a merged message is not in `turn.userContent` (a stale `pendingTurnInput`). claude *consumes* steered stdin into its context but does not re-emit it. This is *fine* under `[P07]`: tugdeck forwards **and** places the message at the same boundary (the mid-turn `tool_result` it acts on), so it controls placement directly — no echo to wait for. Reload from JSONL (`project_hmr_vs_reload`) is the authoritative backstop. Nothing to correlate live; the message is never lost.

#### [Q03] Cancel-window duration (MOOT — retired) {#q03-window-duration}

**Question:** What is `QUEUE_STEER_WINDOW_MS`?

**Resolution:** MOOT. The earlier design used a wall-clock cancel window before forwarding; the TUI evidence (`[Q01]`) shows the trigger is the **agent-loop boundary** (a `tool_result`), a stream event — not a timer. A queued message is cancelable/editable **until that boundary**, matching the TUI. No `QUEUE_STEER_WINDOW_MS` constant (`[P06]`). (An optional minimum-debounce could be added later if instant-boundary forwards feel too eager, but it is not in scope.)

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Addressing churn breaks app-tests / keyboard nav | med | med | Behavior-preserving Step 2; keep `#uN`/`#aN` labels; only `dev-card-telemetry-popovers.tsx` + the data-source test consume the row-index helpers | Any addressing test red |
| Scroll/mount regression (L26/L23) | high | med | Preserve per-Message `messageKey` keys; unit-test id stability across in-flight→committed | Scroll-jump observed in app-test |
| Double-forward (boundary forward + end-of-turn fallback) | med | low | Remove the entry from `queuedSends` on its boundary forward (existence-guarded); the fallback only sees entries that never hit a boundary | Any test shows >1 `send-frame` per entry |
| Optimistic mid-turn placement of a steered message goes wrong | high | low (if we match TUI) | JSONL evidence: the reference (TUI) does **not** place mid-turn — it buffers to the turn boundary and submits as the next turn; matching that avoids optimistic placement entirely (`[Q01]`, `[P07]`) | We decide to attempt finer-than-turn injection |

**Risk R01: Addressing churn** {#r01-addressing-churn}

- **Risk:** Re-basing addresses on `messageKey` and allowing >2 rows/turn breaks `userRowIndexForTurn`/`assistantRowIndexForTurn` callers, the `#t…m…`/`#u`/`#a` address, keyboard nav, and app-tests.
- **Mitigation:** Step 2 keeps output byte-identical for single-user turns; the only consumers of the row-index helpers are `dev-card-telemetry-popovers.tsx` and `dev-transcript-data-source.test.ts` (verified), migrated together with tests; derived labels preserve legibility.
- **Residual risk:** App-tests that hardcode flat row indices may need re-pinning.

**Risk R02: Mount/scroll stability** {#r02-mount-stability}

- **Risk:** Multiplying rows per turn could reintroduce the `turn_complete` scroll-jump if React keys change.
- **Mitigation:** Keys remain `${turnKey}-…` seeded plus per-Message `messageKey`; `[L26]`/`[L23]` invariants asserted in the data-source unit tests.
- **Residual risk:** New row kinds in future must follow the same keying discipline.

**Risk R03: Double-forward of a steered message** {#r03-double-send}

- **Risk:** The two forward paths — the mid-turn boundary forward (`tool_result`) and the end-of-turn fallback (`turn_complete` collapse) — both fire for one entry.
- **Mitigation:** The boundary pickup **removes the entry from `queuedSends`** as it sends (existence-guarded), so the `turn_complete` collapse only ever sees entries that were never picked up. `cancel`/`interrupt` clear entries before either path. No wall-clock timer, so no timer-vs-event races.
- **Residual risk:** None for send-duplication once pickup removes the entry.

**Risk R04: Mis-placing a steered message** {#r04-merge-invisible} 

- **Risk:** Placing a steered message in the wrong spot (phantom turn, orphaned row).
- **Status:** Largely dissolved by the Step 1 corpus finding (`[Q01]`): the merge is **real and observable** — the steered `user_message` lands threaded after a `tool_result` mid-turn. We place it where it actually appears, not by guessing, so there is no phantom/optimistic-mint hazard.
- **Mitigation:** Place on the merged-`user_message` signature (after a `tool_result`, turn still in flight); fall back to JSONL-authoritative placement only if the live wire doesn't surface it (`[Q02]`).
- **Residual risk:** The live row position is *approximate* (placed at the next live `tool_result`, since claude emits no live echo — `[Q02]`); reload from JSONL tightens it to the exact merge point. Never lost, only briefly imprecise.

---

### Design Decisions {#design-decisions}

#### [P01] Rows derive from the message stream, not a turn template (DECIDED) {#p01-message-derived-rows}

**Decision:** The row projection walks each turn's `messages` and emits one row per logical group — every `user_message` opens a `user` row; each maximal run of non-user Messages forms one `assistant` row — instead of the fixed "≤1 user + ≤1 assistant, gated on `origin`" template.

**Rationale:**
- The data layer is already a flat `messages` list; only the projection assumed pairs (`dev-transcript-data-source.ts`, `[D07]`).
- A merged mid-turn user message must render as its own row between assistant content — impossible under the 2-row cap.
- Generalizes to future kinds without another reckoning (`[P04]`).

**Implications:**
- `buildRowLayout`, `locateCommittedRow`, `userRowIndexForTurn`, `assistantRowIndexForTurn`, `idForIndex`, `kindForIndex`, `rowAt` all switch from per-turn arithmetic to a per-Message walk.
- `RowLayout` records per-row → (turnIndex, message-group) mapping, not just `turnHasUserPerTurn`.

#### [P02] The turn survives as a metadata bracket only (DECIDED) {#p02-turn-as-metadata}

**Decision:** `TurnEntry` / the `result` bracket remains the unit for cost, timing, telemetry, and rewind *grouping*, but no longer gates how many rows render.

**Rationale:**
- The wire's `result` is a real boundary where usage/cost/`ttftMs` aggregate — we keep it.
- Rendering and bracketing are orthogonal; conflating them is what blocks steering.

**Implications:**
- A bracket may contain >1 `user_message` (merge). Per-turn token/cost stays per-bracket; `deriveContextWindows` is unaffected.
- `origin` stays as the bracket's *opener* attribution but is no longer the row-count authority.
- Per-turn telemetry (the `perTurnTokens` badge + popover) is a *bracket* quantity, so with multiple assistant rows it anchors to the **bracket's last assistant row** (`[P04]`, Step 3).

#### [P03] Recency-implied response; no stored user↔assistant binding (DECIDED) {#p03-recency-binding}

**Decision:** "This assistant block answers that user message" is derived by adjacency, not stored.

**Rationale:** Matches the desired UX (a queued message lands as a standalone user message) and claude's flat JSONL; dissolves merge-vs-buffer at the *render* layer (both are just rows in arrival order).

**Implications:** Recency is presentational only. Anything load-bearing (rewind) uses the explicit turn-opener `promptUuid` (`[P05]`), never position.

#### [P04] `messageKey` is the row address; `#uN`/`#aN` are derived labels; the row layer is kind-open; absorbed messages keep their key (DECIDED) {#p04-addressing}

**Decision:** Row identity/addressing keys on the Message's stable `messageKey`; labels (`#u1`, `#a1`, `#u2`, future `#sN`) are per-kind ordinals in stream order. The row layer discriminates on `Message.kind` and never hardcodes a closed `user|assistant` set. A merged message **retains its original `messageKey`** when placed into a host turn — never re-derived under the host `turnKey`. Per-turn telemetry anchors to the bracket's last assistant row (`[P02]`).

**Rationale:**
- `messageKey` already exists and is stable across streaming (`MessageBase`); positional numbers are fragile under append.
- Keeps `#u`/`#a` legibility while making new kinds additive (a renderer case, not a refactor).
- `userMessageKey(turnKey)` = `${turnKey}-user` and `[D07]`'s "one `user_message` per turn at most" assume single-user turns. A merged message carries its own queue-time `turnKey`, so its key is distinct — **only if placement preserves it**. Re-deriving under the host `turnKey` collides with the host opener's key.

**Implications:**
- Addressing consumers migrate from `#u`/`#a`-per-turn helpers to a `messageKey`-based scheme.
- A `switch (message.kind)` (exhaustive-but-extensible) replaces the boolean `isAssistantRow`.
- The `[D07]` "one per turn at most" note on `MessageBase` is revised; `idForIndex` uses the message's own `messageKey` for any user row beyond the head.
- `dev-card-telemetry-popovers.tsx` anchors per-turn telemetry to the bracket's last assistant row.

#### [P05] `/rewind` anchors on turn openers; merged messages are not rewind-targetable in v1 (DECIDED) {#p05-rewind-on-openers}

**Decision:** The `/rewind` anchor (`promptUuid`) stays on `TurnEntry`, captured from the **first** `prompt_anchor` of the turn (the opener), as today. A merged mid-turn user message renders as a row but is not an independent rewind target in v1.

**Rationale:**
- The reducer already latches the first `prompt_anchor` per turn and ignores the rest (pinned by `reducer.rewind.test.ts` "first wins"); for a merged turn this keeps the turn opener's uuid — the correct rewind target.
- `truncateAtAnchor` and the rewind picker (`rewind-turn-source.ts`, `rewind-sheet.tsx`) are turn-based; a message-based picker is marginal value.
- Rewinding *into* a mid-turn merge point is semantically murky.

**Implications:**
- No change to `promptUuid` storage, `prompt_anchor` handling, `truncateAtAnchor`, or the rewind picker — `reducer.rewind.test.ts` stays green.
- A merged turn's second user message is correctly absent from the picker.
- Per-message rewind is a documented follow-on (`#roadmap`).

#### [P06] Steering queue: held client-side (retractable), forwarded + placed at the agent-loop boundary (DECIDED) {#p06-steer-window}

**Decision:** A mid-turn submit is held in `queuedSends` — surfaced as the **existing `×`-retractable dimmed foot ghost** (`[P07]`) — and is **not put on the wire while parked**. At the **next agent-loop boundary** (a mid-turn `tool_result` while the queue is non-empty, or `turn_complete` if the turn has no further tool step) the head entry is **picked up atomically**: emit its `send-frame`, **remove it from `queuedSends`**, and place it as a real mid-turn user row (`[P07]`). Holding it off the wire until then is what keeps it retractable: `cancel_queued_send` (`×`) removes a parked entry with no frame, any time before pickup; `interrupt` clears the queue.

**Rationale:**
- Faithful to the TUI (`[Q01]`, session 17ed0b90): the message is held client-side and editable until injected at the boundary — there is no "sent" state because forward and pickup are the same instant.
- The boundary is a **stream event the reducer already sees**, so no wall-clock timer is needed (this *retires* the earlier `QUEUE_STEER_WINDOW_MS` / `schedule_timer` design — `[Q03]`).
- Reducer stays pure; the trigger is an event in the existing reduce path.

**Implications:**
- **No `forwarded`/"sent" flag, no timer.** A parked entry is simply retractable until picked up; pickup removes it from `queuedSends`.
- New flush path: on a mid-turn `tool_result` with a non-empty queue, forward + remove + place the head entry. The `turn_complete` collapse is the fallback for turns with no mid-turn tool step. Removal-on-pickup means the collapse only ever sees never-picked-up entries (no double-forward — `Risk R03`).
- Multiple queued entries pick up in order at successive boundaries (one per boundary), matching the TUI draining its queue across iterations.
- `[Q03]` (cancel-window duration) is **moot/retired** — retraction is bounded by the next boundary, not a timer.

#### [P07] Queued messages = the existing retractable dimmed-foot ghost; becomes a real mid-turn row at the boundary (DECIDED) {#p07-reconciliation}

**Decision:** Reuse the Dev card's **existing dimmed ghost row at the foot of the transcript**, unchanged — `×`-retractable, **one state**, the whole time it is parked. There is **no "sent" state** (`[Q01]` / session 17ed0b90): the message is **not on the wire while parked** (`[P06]` holds it client-side), so it stays retractable until pickup. At the agent-loop boundary it is **picked up atomically** — removed from the queue, forwarded to claude, and placed as a **real mid-turn user row** in the in-flight turn (after the tool block) via the flat row model (`Spec S01`). Forward and placement are the same instant; before it, fully retractable; after it, a real message.

**Rationale:**
- Matches the TUI exactly (`[Q01]`): held client-side and editable until injected at the boundary — that hold is *why* it's retractable, and why there is no "sent" limbo.
- Reuses the existing ghost with **no visual tuning** — the earlier two-state (retractable/sent) idea is dropped; there is no distinction.
- The flat message-row architecture (Steps 2–4) renders the placed mid-turn `user_message` directly; no phantom-turn hazard (the turn continues).
- Holding until the boundary (not forwarding early) is what preserves retraction; no echo/correlation machinery (`[Q02]`) — tugdeck owns the text and does the placement.

**Implications:**
- **No `forwarded`/"sent" flag**, no second ghost state. `queuedSends` entries are simply parked-and-retractable until picked up.
- At the boundary: remove the entry from `queuedSends` **and** append a `user_message` to the in-flight turn's `messages` (own `messageKey`, `[P04]`) → the foot ghost becomes a real mid-turn row. Live position is where tugdeck places it (the boundary it acts on); reload from JSONL tightens it to claude's exact merge point.
- **Reducer requirement (reload path):** `handleAddUserMessage` for a *mid-turn* row must **append to the in-flight turn**, not open a new turn (the fork). Live placement and reload converge on one helper: "append a `user_message` to the active turn's `messages`."
- **Scope of delivery:** retractable foot ghost while parked → real mid-turn row at the boundary (forwarded + placed together); reload exact.

#### [P08] Revise the legacy `D-T3-07` queue-until-complete behavior (DECIDED) {#p08-revise-dt307}

**Decision:** `D-T3-07` ("mid-stream submit queues, flushes only on idle/`turn_complete`") is superseded by `[P06]`/`[P07]`: queue-for-window-then-steer.

**Rationale:** `D-T3-07` predates steering support and lives only in archived plans + reducer comments, not the live global decisions.

**Implications:** Update the reducer `handleSend`/`handleTurnComplete` docstrings and the `dev-transcript-data-source` module doc; a one-line pointer in `tuglaws/design-decisions.md` may be added if the team wants it durable.

#### [P09] Transcript badge = session-true turn + within-turn per-kind ordinal (DECIDED) {#p09-per-message-address}

**Decision:** The transcript address badge is a **two-component, durable address**: the **session-true turn number** plus a **per-kind ordinal *within* that turn**. Rendered with **significant digits only (no zero-padding)**: `#u17` / `#a17` for the sole user/assistant row of turn 17, and `#u17.2`, `#u17.3` (and `#a17.2`, …) for the 2nd/3rd same-kind row when steering merges several into one turn. Found wrong in real session `3ac9f413`: the old turn-keyed badge (`#u{turn}`) collided to `#u0001` for every user row of a merged turn.

**Durability is the bar:** close a session, reopen days later, page older turns — every message keeps its number. Both components are pure, deterministic functions of the JSONL: the turn number is session-true (`base = firstLoadedTurnIndex + local turn index`, already window-independent — turn 17 is always 17), and the within-turn ordinal counts same-kind rows in *that turn's own fixed message order* (opener, then steers in send-order; assistant runs between). Neither depends on how much is loaded.

**Rejected — global per-message count (`#u1, #u2, …` across the whole session):** not durable under the recency-windowing architecture. It needs counting from message #1, but the client pages turns and has no per-message base (only a per-turn base), so the first loaded message would mis-number and paging would renumber everything. Turn-anchored composes without any global count.

**Rationale:**
- Durable across close/reopen/paging (the stated bar) — turn-anchored, no global state.
- Backward-compatible: a normal 1-user-1-assistant turn has within-turn ordinal 0 → renders `#u17` exactly as before. Only merged turns grow a `.k` suffix.
- The data source already tracks `assistantRunOrdinal` (within-turn) for run keying — the user side is the symmetric addition.

**Implications:**
- `RowSlot` gains `userRowOrdinal` (0-based within-turn, mirrors `assistantRunOrdinal`); a `withinTurnOrdinalForRow(index)` exposes the per-kind ordinal.
- The badge cells keep the existing session-true turn number (`useTurnNumberBase + localTurnIndexForRow`) and append the within-turn ordinal. `TurnAddress` gains a `sub` component; `formatTurnAddress` drops zero-padding and appends `.{sub+1}` when `sub > 0`; aria-label updated.
- Turn-based scroll/telemetry-popover anchoring is unchanged — only the badge format changes.
- The live-vs-reload position caveat doesn't break durability: every reopen reads the same JSONL, and the within-turn ordinal keys on user send-order, not exact tool-interleaving.

---

### Deep Dives (Optional) {#deep-dives}

#### Steering reconciliation branches {#steering-reconciliation-branches}

The Step 1 spike answers one question — *is a merged mid-turn message placeable on the live wire?* — and that picks the branch. Forwarding mechanics (`[P06]`) are identical in all three.

**Branch A — Optimistic absorption** (adopt iff a placeable pre-`result` merge signal exists):
- Merge: the signal arrives before the turn's `result`; reconciliation removes the forwarded entry and appends its `UserMessage` into the **live** turn (keeping its `messageKey`), forking the opener handler to append-not-open.
- Buffer: the entry is still present at `turn_complete` (it wasn't merged); the collapse mints its user row **without re-sending**.
- Discriminant: "still present at collapse ⇒ buffered." Sound *only* because a merge is removed pre-collapse.
- Residual: a late merge signal (after the collapse minted) → `[Q02]` late-echo collapse.

**Branch B — Best-effort ghost + JSONL-authoritative** (DEFAULT; correct with no merge signal):
- Forward leaves a persistent "sent" ghost row; nothing is optimistically minted at the collapse.
- Buffer: detected by its **follow-on turn opening** on the live wire (after the prior `result`) — known-observable; tugdeck mints a user-origin turn from the matching ghost and clears it.
- Merge: not observed live; the ghost persists until the next turn-boundary reconciliation against committed data, or a Developer▸Reload re-resume from JSONL re-places it inside its turn. No phantom, ever.
- Residual: a merged message shows as a foot ghost rather than interleaved-in-turn until the next authoritative reconciliation (`Risk R04`).

**Branch C — Partial** (e.g. a signal exists but after `result`, or only sometimes): pick the closest of A/B per the spike and document the deviation. Most likely collapses to B.

**Status: superseded by the Step 1 corpus finding** (`[Q01]`, `queued-command-mechanism.md`). The A/B/C framing was built on a false premise (that a merge is invisible / non-existent). The corpus (470 injections) shows steering **is** a real mid-turn merge at the agent-loop iteration boundary (after a `tool_result`), and the flat row model renders it directly. The live design is in `[P07]`; this branch analysis is kept only for history.

---

### Specification {#specification}

#### Spec S01: Message-derived row projection {#s01-row-projection}

Given a turn with `messages = [m0, m1, …]`:

- Emit a `user` row at each `mi` where `mi.kind === "user_message"`.
- Emit one `assistant` row per maximal contiguous run of non-`user_message` Messages (rendered inline as today).
- A wake/continuation/orphan turn (`origin === "assistant"`) yields a single leading `assistant` row, exactly as today.
- Row order is strictly `messages` arrival order.
- Each `user` row's key is the Message's own `messageKey` (`${turnKey}-user` for the opener; the placed message's original key for a merged/buffered-from-ghost row — `[P04]`).
- The per-turn-token badge / telemetry popover renders only on the bracket's **last** assistant row.
- For today's data (one head `user_message`, then assistant content), this yields the identical `[user, assistant]` pair — Step 2 is behavior-preserving.

`RowLayout` records, per flat row index, the owning turn index and message-group (start index + kind), replacing `turnHasUserPerTurn` + `isAssistantRow`.

#### Spec S02: Steering lifecycle {#s02-steer-lifecycle}

**Parked — retractable dimmed foot ghost (`[P06]`/`[P07]`):**

1. **queued** — `phase !== idle` at submit. Entry added to `queuedSends`; rendered as the existing **`×`-retractable dimmed ghost row at the foot**. Not on the wire.
2. **retracted** — `×` (or edit) any time before pickup: `cancel_queued_send` removes the entry, restores the draft. No frame ever sent.
3. **interrupted** — `interrupt()` clears `queuedSends`.

**Picked up at the boundary — forward + place atomically (`[P06]`/`[P07]`/`[Q01]`):**

4. **picked up** — the reducer observes a mid-turn `tool_result` with a non-empty queue: for the head entry, emit the `send-frame`, **remove it from `queuedSends`**, and append it as a `user_message` to the in-flight turn's `messages` (own `messageKey`) → the foot ghost becomes a real mid-turn user row after the tool block. One entry per boundary; the rest stay parked (still retractable).
5. **end-of-turn fallback (<1%)** — a turn that reaches `turn_complete` with the queue still non-empty (no mid-turn tool step) flushes the head via the existing single-tick collapse → next turn (final phase `submitting`, no transient `idle`).
6. **reload tightens** — Developer▸Reload re-resumes from JSONL; the reducer's `handleAddUserMessage` appends the mid-turn row at claude's exact merge point (the fork). Authoritative; never lost.

Invariant: at most one `send-frame` per entry — at its boundary pickup XOR the end-of-turn fallback; never both (pickup removes the entry, so the collapse only sees parked entries).

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `queuedSends` (parked, retractable) | structure (local-data) | store reducer state + `useSyncExternalStore` | `[L02]` |
| Dimmed foot ghost rows (existing, `×`-retractable) | structure (derived) + appearance | rendered by the data source from `queuedSends`; dim via CSS | `[L02]`, `[L06]` |
| Boundary pickup (on mid-turn `tool_result`) | structure (side-effect) | `send-frame` + remove-from-queue + append-to-turn, from the reduce path — a stream event, not a timer | `[L02]` |
| Placed mid-turn user row | structure (derived) | `user_message` in the turn's `messages`; rendered by the flat row model | `[L02]` |
| Row layout (message-derived) | structure (derived) | pure `buildRowLayout` memoized per snapshot identity | `[L02]` |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| Unit | `buildRowLayout`/`rowAt`/addressing over synthetic snapshots; reducer transitions | Row projection, steering state machine, dedupe |
| Integration (app-test) | Drive the real Dev card: type mid-turn, observe steer | End-to-end forwarding + scroll stability |
| Drift Prevention | Existing data-source/queue/rewind tests stay green after Step 2 | Behavior-preservation gate |

#### What stays out of tests {#test-non-goals}

- No jsdom render-tree assertions or mock-store tests — banned (`feedback_real_not_fake`); steering is proven by reducer/effect unit tests over the real reducer + a real app-test.
- No test of claude's internal merge-vs-defer choice. Placement is proven by injecting the **real merged-`user_message`-after-`tool_result` shape** (from the Step 1 / Step 6 captures) into the real reducer — not by mocking or guessing frame shapes.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Per CLAUDE.md git policy, this plan's steps commit on the `tugutil dash` worktree via `tugutil dash commit` when run under `/tugplug:implement`; `main` is only updated by the user via `tugutil dash join`.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Wire-behavior spike: characterize the steering mechanism | done (uncommitted) — merge@iteration-boundary | — |
| #step-2 | Behavior-preserving message-derived row projection | done | b51b9b23 |
| #step-3 | Re-base addressing on `messageKey` + derived labels | done | ea6916c3 |
| #step-4 | Render multiple user rows per turn (merge-visible) | done | d81241d8 |
| #step-5 | Steering forward: hold client-side, pick up at the boundary | done | 5c3295c0 |
| #step-6 | Place the merged message as a mid-turn user row | done (reopen verify on-demand) | live: 7d939e16 |
| #step-7 | Per-message address fix + integration + docstring/D-T3-07 revision | done (app-test on-demand) | (this commit) |

#### Step 1: Characterize the steering mechanism from real sessions {#step-1}

<!-- Root step: no dependencies. Read-only investigation + plan finalization. -->

**Commit:** `docs(roadmap): characterize mid-turn steering (merge at iteration boundary)`

**References:** [Q01] mechanism, [Q02] no-live-echo, [P07] placement, Risk R04, (#q01-merge-wire)

**Artifacts:**
- Corpus analysis under `stream-json-catalog/v2.1.181-steering-spike/` (`queued-command-mechanism.md`: 470 injections, 93% after `tool_result`, turn continues; plus the worked 5eefeaec example and the labelled raw-probe false start).
- `[Q01]` resolved (merge at iteration boundary), `[P07]` + `Spec S02` placement rewritten, `[Q02]` resolved (no live echo → optimistic-live + reload-exact).

**Tasks:**
- [x] Characterize the steering mechanism from real session JSONL. **Corpus survey: 470 `queued_command` injections across 42 sessions (claude 2.1.133–2.1.177)** — 93% thread after a `tool_result` (mid-loop), majority followed by `stop=tool_use` (turn continues). **The queue drains at the agent-loop iteration boundary and merges into the running turn**; turn-boundary landing is the <1% exception. Worked example: session 5eefeaec ("Tide is retired…" steer injected after a `tool_result`, turn continued). Full analysis: `stream-json-catalog/v2.1.181-steering-spike/queued-command-mechanism.md`.
- [x] Decide placement in `[P07]` (merge mid-turn as a `user_message` after the `tool_result`, rendered via the flat row model) and rewrite `Spec S02` placement + `[Q02]` (resolved: no live echo → optimistic-live insert + reload-exact).
- [x] Note the layer difference: the Dev card holds `queuedSends` and flushes at `turn_complete` today — *why* cued messages feel "end-of-turn" — and the fix is to forward mid-turn (`[P06]`) so claude merges at its iteration boundary like the TUI.

**Tests:**
- [x] N/A (investigation) — corpus-level evidence (n=470) + the 5eefeaec worked example; the raw-probe false start is retained, labelled, in the spike dir.

**Checkpoint:**
- [x] Mechanism characterized from real sessions; `[P07]`/`Spec S02`/`[Q01]`/`[Q02]` rewritten around merge-at-iteration-boundary (signature: `queued_command` / `user_message` after a `tool_result`). `[Q02]` resolved (no live echo); Step 6 implements optimistic-live insert + reload-exact placement.

#### Step 2: Behavior-preserving message-derived row projection {#step-2}

**Commit:** `refactor(tugdeck): derive transcript rows from message stream`

**References:** [P01] message-derived rows, [P02] turn-as-metadata, [P04] addressing/keying, Spec S01, [D07], [L26], [L23], (#s01-row-projection, #r02-mount-stability)

**Artifacts:**
- `dev-transcript-data-source.ts`: `RowLayout` reshaped to a per-row → (turnIndex, group) map; the layout/addressing/`rowAt` family rewritten as a per-Message walk.

**Tasks:**
- [ ] Replace `turnHasUserPerTurn`/`isAssistantRow` with a message-group walk per Spec S01.
- [ ] Preserve `${turnKey}-user`/`${turnKey}-assistant` keys for single-user turns; key additional user rows by the Message's own `messageKey`.
- [ ] Keep the unified `"assistant"` cell kind and the no-remount invariant.

**Tests:**
- [ ] New unit: layout over a synthetic merged turn (`[user, assistant, user, assistant]`) yields 4 rows in order, each user row keyed by its own `messageKey`.
- [ ] Existing `dev-transcript-data-source` tests pass unchanged (drift gate).

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/dev-transcript-data-source.test.ts`
- [ ] `cd tugdeck && bun test src/lib/code-session-store`

#### Step 3: Re-base addressing on `messageKey` + derived labels {#step-3}

**Depends on:** #step-2

**Commit:** `refactor(tugdeck): address transcript rows by messageKey with derived #uN/#aN labels`

**References:** [P04] addressing, [P02] per-turn-telemetry anchoring, Risk R01, (#p04-addressing, #r01-addressing-churn)

**Artifacts:**
- `messageKey`-based addressing; per-kind ordinal label derivation.
- Updated consumers: `dev-card-telemetry-popovers.tsx` and `dev-transcript-data-source.test.ts` (the only callers of the row-index helpers).

**Tasks:**
- [ ] Introduce a kind-open label/address helper; remove the closed `user|assistant` boolean assumption.
- [ ] Migrate the telemetry popover's row-index usage; anchor per-turn telemetry to the bracket's **last** assistant row.

**Tests:**
- [ ] Unit: labels give `#u1,#a1,#u2,#a2` for a merged turn; `#a1` only for a wake.
- [ ] Unit: per-turn telemetry anchors to the last assistant row of a merged turn.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit`

#### Step 4: Render multiple user rows per turn (merge-visible) {#step-4}

**Depends on:** #step-3

**Commit:** `feat(tugdeck): render mid-turn user messages as standalone rows`

**References:** [P01] message-derived rows, [P03] recency binding, [P04] keying + telemetry placement, Spec S01, (#s01-row-projection)

**Artifacts:**
- `dev-card-transcript.tsx` rendering for >1 user row per turn; assistant runs split around mid-turn user rows; per-turn badge only on the bracket's last assistant row.

**Tasks:**
- [ ] Render a `user` cell for any `user_message` Message (head or mid-list).
- [ ] Split assistant runs before/after a mid-list user message into separate assistant rows.
- [ ] Render the `perTurnTokens` badge only on the bracket's last assistant row.

**Tests:**
- [ ] Unit/app-test: a synthetic merged turn shows `user, assistant, user, assistant` with correct labels, stable keys, and a single per-turn badge.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `just app-test` (merged turn renders without scroll jump — Risk R02)

#### Step 5: Steering forward — hold client-side, pick up at the boundary {#step-5}

**Depends on:** #step-1, #step-4

**Commit:** `feat(tugdeck): forward queued messages at the agent-loop boundary`

**References:** [P06] queue/forward, [P08] revise D-T3-07, Spec S02, Risk R03, (#s02-steer-lifecycle, #r03-double-send)

**Artifacts:**
- Boundary pickup: on a mid-turn `tool_result` with a non-empty `queuedSends`, emit the head entry's `send-frame` and **remove it from `queuedSends`** (existence-guarded). No `schedule_timer`/`QUEUE_STEER_WINDOW_MS`, no `forwarded` flag.
- The `turn_complete` collapse remains the fallback for a turn with no mid-turn tool step (head entry → next turn); it only sees never-picked-up entries (removal-on-pickup).
- The queued message is **not on the wire while parked** — `cancel_queued_send` (`×`) / `interrupt` clear it with no frame, any time before pickup. The existing dimmed foot ghost renders from `queuedSends`, unchanged (single retractable state).

**Tasks:**
- [ ] Add the boundary-pickup path (mid-turn `tool_result` + non-empty queue → forward head entry, remove it from `queuedSends`).
- [ ] Keep the `turn_complete` fallback; ensure cancel/interrupt clear parked entries (no frame).
- [ ] Confirm the existing foot ghost still renders parked entries with `×` (no visual change needed).

**Tests:**
- [ ] Reducer: mid-turn `tool_result` with a queued entry → one `send-frame`, entry removed, emitted before `turn_complete`.
- [ ] Reducer: no double-forward — a picked-up entry is gone, so the `turn_complete` collapse never re-sends it (Risk R03).
- [ ] Reducer: `×`/`interrupt` on a parked entry → removed, no frame (retractable until pickup).
- [ ] Reducer: a turn with no mid-turn tool step → queued entry flushes at `turn_complete` as the next turn (single-tick, no transient `idle`).
- [ ] Reducer: `×`/`interrupt` clear without a frame; multiple entries flush one-per-boundary in order.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/code-session-store`
- [ ] `cd tugdeck && bunx tsc --noEmit`

#### Step 6: Place the merged message as a mid-turn user row {#step-6}

**Depends on:** #step-1, #step-5

**Commit:** `feat(tugdeck): place steered messages mid-turn after the tool_result`

**References:** [P07] placement, [P04] keying, [Q01] mechanism, [Q02] no-live-echo, Spec S02 (placement), Risk R04

**REOPENED — reload half was missed (found in session `3ac9f413` on reopen):** the live half works (the reducer appends the steered row at the `tool_result` boundary), and the reducer's reload fork in `handleAddUserMessage` is correct — but it was never fed. A steered message persists in claude's JSONL **only** as a `queue-operation` + an `attachment: queued_command` (never a `type: user` row), and `tugcode/src/replay.ts` lists **both `"attachment"` and `"queue-operation"` in `SKIPPED_TOP_LEVEL_TYPES`**, so replay drops them. On reopen the steered rows vanish (the durability bar fails). The on-demand `just app-test` reopen check that would have caught this was never run.

**Artifacts:**
- **Placement at pickup:** the same mid-turn `tool_result` that picks up the entry (Step 5) also appends it as a `user_message` to the in-flight turn's `messages` (own `messageKey`) → the foot ghost is removed and a real mid-turn user row appears after the tool block (flat row model, Step 4). tugdeck does forward + remove + place atomically; no live echo to wait for (`[Q02]`). Live position is where tugdeck places it; reload tightens to claude's exact merge point.
- **Reload-authoritative:** the `handleAddUserMessage` fork — a *mid-turn* `add_user_message` from JSONL replay **appends to the in-flight turn** rather than opening a new turn. Live pickup and reload converge on one helper: "append a `user_message` to the active turn's `messages`."
- The `end_turn` minority (<1%, `[Q01]`) falls through to the existing next-turn collapse unchanged.

**Tasks:**
- [x] Live: at the boundary pickup (Step 5), append the message → mid-turn user row (`handleToolResult`). Done.
- [x] Reducer reload fork: `handleAddUserMessage` appends a mid-turn replay user row to the in-flight turn (not opens one). Done — but unfed (see below).
- [x] **tugcode `replay.ts`: translate `queued_command` attachments into `add_user_message` frames** (`handleQueuedCommandEntry`, intercepted before the blanket `attachment` skip; `commandMode: "prompt"` only; emits content at the JSONL position, no orphan-close / no opener mint, so the reducer's reload fork appends it mid-turn). `queue-operation` stays skipped.
- [x] Rebuilt tugcode (`bun build --compile … target/debug/tugcode`; `~/.local/bin/tugcode` symlink already points at it).
- [x] Confirmed on real data: replaying `3ac9f413` now emits 3 `add_user_message` (opener + "what's 3+3" + "what's 1+1") in one turn, zero unknown_shape.

**Tests:**
- [x] Reducer (live): a mid-turn `tool_result` with a queued entry forwards, removes the entry, **and** appends it → mid-turn user row.
- [x] Reducer (reload): a replay `add_user_message` threaded after a mid-turn `tool_result` appends to the in-flight turn (does not open a new turn).
- [x] tugcode replay (`replay-queued-command.test.ts`): a `queued_command` mid-bracket emits a mid-turn `add_user_message` (one turn); a non-`prompt` commandMode is skipped.
- [ ] **Durability (the bar) — user verify:** reopen `3ac9f413` in a freshly-spawned session → `#u1`, `#u1.2`, `#u1.3` reappear and persist across reopen.

**Checkpoint:**
- [x] tugcode `bun test` green (648 pass); tsc clean; binary rebuilt.
- [ ] Reopen `3ac9f413` in the Dev card: steered rows reconstructed and stable (on-demand).

#### Step 7: Per-message address numbering fix + integration + docstring/D-T3-07 revision {#step-7}

**Depends on:** #step-4, #step-5, #step-6

**Commit:** `fix(tugdeck): per-message transcript addresses + D-T3-07 docstrings`

**References:** [P04] addressing, [P09] per-kind ordinal address, [P08] revise D-T3-07, [P01]–[P07], (#success-criteria, #exit-criteria)

**Numbering bug (found in real session `3ac9f413`):** the transcript badge addresses by **turn** — `dev-card-transcript.tsx` builds `{ speaker, turn }` from `useTurnNumberBase + localTurnIndexForRow(index) + 1`, rendered as `#u{turn}`/`#a{turn}` (`tug-transcript-entry.tsx` `formatTurnAddress`). That was fine when a turn held one user + one assistant row, but steering MERGES multiple user messages into one turn, so all of a merged turn's user rows collide on `#u0001` and all its assistant runs on `#a0001`. Per `[P04]`, the badge must be a **per-kind ordinal in stream order**, not the turn index.

**Tasks:**
- [x] Add `userRowOrdinal` (0-based within-turn, mirrors `assistantRunOrdinal`) to `RowSlot`, computed in `pushTurnSlots`; expose `withinTurnOrdinalForRow(index)` for the per-kind within-turn ordinal.
- [x] Badge = session-true turn (`useTurnNumberBase + localTurnIndexForRow`, unchanged) **+** the within-turn ordinal. Extended `TurnAddress` with a `sub` field; `formatTurnAddress` drops zero-padding (significant digits) and appends `.{sub+1}` when `sub > 0`; aria-label/doc updated. Both cells point at it. Turn-based scroll/telemetry anchoring untouched.
- [ ] (Follow-on, not this step) Image-atom caption `messageNumber` is a single int (`#{N}-image-k`, turn-based — durable but collides across a merged turn's user messages); threading the full turn+sub address through `TugAtomTextBody`/`TugAttachmentStrip` is a separate change. Left turn-based for now.
- [x] Revised the `[D07]` "one user_message per turn" note on `MessageBase` (retired); steering pickup/placement inline docstrings already landed in Steps 5/6.
- [x] Added the `D-T3-07` supersession note (in `tug-prompt-entry.tsx` where it's cited).
- [x] Verified success criteria (full unit suite + tsc).

**Tests:**
- [x] Unit (durability): a synthetic merged turn yields within-turn ordinals `[0,0,1,1]` → `#u1, #a1, #u1.2, #a1.2`; a normal turn's ordinal is 0 (no suffix); `formatTurnAddress` has no leading zeros and renders `.2`/`.3` for `sub` 1/2.
- [x] Full `cd tugdeck && bun test` green (3837 pass).
- [ ] `just app-test` end-to-end steering passes (on-demand real-claude path — run before relying on the live render).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test`
- [ ] `just app-test`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A flat, message-derived transcript model in which a user message is a first-class standalone row, with mid-turn message steering whose reconciliation design is chosen from real captured wire behavior — defaulting to a robust best-effort placement that never manufactures a phantom turn.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] Step 1: steering mechanism characterized from real sessions (merge at the iteration boundary) and `[P07]` records the placement design. (`#step-1`)
- [ ] A message queued mid-turn forwards at the next `tool_result` boundary and is picked up by claude (on-demand app-test). (`#s02-steer-lifecycle`)
- [ ] No double/spurious send across all three Risk R03 races; exactly one `send-frame` per `turnKey`. (`Risk R03`)
- [ ] No phantom turn for a merged message; no row hangs in `submitting`. (`[P07]`, `Risk R04`)
- [ ] Merged mid-turn user message renders as its own row in arrival order, keyed by its own `messageKey`, badge on the bracket's last assistant row. (`Spec S01`, `[P04]`)
- [ ] `/rewind` anchors on turn openers; `reducer.rewind.test.ts` green; merged messages absent from the picker. (`[P05]`)
- [ ] No scroll-jump/remount regression at `turn_complete`. (`[L26]`, `[L23]`, `Risk R02`)
- [ ] `bun test`, `bunx tsc --noEmit`, and `just app-test` all green; builds warning-clean.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] If the spike chose branch B: a backend change to make merges live-observable, unlocking branch-A optimistic interleaving (separate plan).
- [ ] Per-message `/rewind` (anchor on each user Message; message-based picker) — the deferred half of `[P05]`.
- [ ] Shell interactions as a new `Message.kind` interleaved in the same stream (the flexibility this architecture unlocks).
- [ ] "Thinking" as standalone phase chrome.
- [ ] Optional minimum-debounce before a boundary forward, if instant forwards feel too eager (`[Q03]` retired the wall-clock window).

| Checkpoint | Verification |
|------------|--------------|
| Steering mechanism known | Step 1 corpus analysis (merge@iteration-boundary) |
| Behavior-preserving refactor | Step 2 existing tests green |
| Rendering correctness | Step 4 merged-turn render test |
| Steering correctness | Step 5/6 reducer tests (merged-`user_message`-after-`tool_result`) + app-test |
| Rewind integrity | `reducer.rewind.test.ts` unchanged/green |
