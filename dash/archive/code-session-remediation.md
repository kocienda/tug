# Assessment

I've done a deep pass through the Rust router and the tugdeck FeedStore. The short version: the outline in tide.md is partly stale and partly underspecified. We should not dive in — this wants a plan document. Here's what I found.

## What's already done (and the outline doesn't know it)

The "dynamic-map refactor" described in the Rust code block is already landed. FeedRouter in router.rs:157 uses HashMap<FeedId, (broadcast::Sender, LagPolicy)> for stream_outputs and HashMap<FeedId, mpsc::Sender> for input_sinks. There are no hardcoded terminal_tx / code_tx fields. handle_client already does a map lookup (router.rs:660: if let Some(tx) = router.input_sinks.get(&fid)). The server→client loop already uses tokio_stream::StreamMap for dynamic fan-in. main.rs:319–360 already uses register_stream / register_input / add_snapshot_watches.

Also notable: SessionMetadataFeed already subscribes to CODE_OUTPUT, filters for system_metadata, and republishes via a watch channel — so session_id already flows over the wire on FeedId 0x51, today. And agent_bridge.rs:261 already snapshots session_init frames to a watch receiver.

So the first plan edit is: update T0.5 P2 to strike the "replace named fields" text — it's describing work that's done. The remaining work is the multi-session half, which is the load-bearing piece.

## What the outline doesn't say, but has to

The approved approach ("keep 0x40/0x41, put session_id in payload, filter client-side") is correct but only describes the wire contract. It leaves four hard subsystems unspecified:

1. Multiple tugcode processes, and who owns them. Today there is exactly one spawn_agent_bridge call in main.rs:309. Multi-session means N tugcode subprocesses, which means a supervisor: spawn on demand, track by session key, reap on close. Neither main.rs nor router.rs has a home for this. New module: tugcast/src/feeds/agent_supervisor.rs (or similar).
➤ RESPONSE: APPROVED. New module: tugcast/src/feeds/agent_supervisor.rs.

2. session_id stamping on every outbound frame. Claude Code's stream-json only includes session_id in session_init. Every other event (assistant_text, tool_use, turn_complete, …) does not. For the client filter to work, the bridge must stamp session_id into every CODE_OUTPUT payload. Cheapest path: after the bridge learns session_id from session_init, it injects "session_id":"abc", as the first field of each subsequent JSON line via byte splice. Costs ~one allocation per frame. Alternative is an envelope wrapper, which breaks every consumer and the replay buffer. I'd pick the splice.
➤ RESPONSE: splice.

3. Input demux. Today code_input_tx is a single mpsc sender feeding the single tugcode. With N subprocesses there are N mpsc senders; the router has to peek at the CODE_INPUT payload, read session_id, and forward to the right one. This is a structural change to how input_sinks works — the current abstraction is "one sender per FeedId." Options: (a) keep input_sinks as-is but let CODE_INPUT map to a dispatcher task that owns the per-session senders; (b) generalize input_sinks to HashMap<FeedId, InputRoute> where a route is either a single sender or a session-keyed table. Option (a) is less invasive and my preference — the generalization is premature until a second backend needs the same behavior.
➤ RESPONSE: Option (a)

4. Output merge and replay. N tugcode bridges → one CODE_OUTPUT broadcast sender. StreamMap has one entry per FeedId, so we can't register N broadcast senders under the same key. Either: (a) a merger task that owns the real CODE_OUTPUT broadcast and pulls from N per-bridge mpscs, or (b) restructure stream_outputs to allow multiple senders per FeedId. (a) is much cleaner and lets the merger also own the replay buffer — critical, because right now there's one code_replay registered at main.rs:332 and we'd need either per-session replay buffers or a single buffer that the client filter prunes on reconnect.
➤ RESPONSE: (a)

## Other holes and pitfalls

- The session-id bootstrap race. Between card mount and the arrival of session_init, the card doesn't yet know its own session_id, so it can't filter inbound frames. It also can't tag outbound frames. We need a local per-card handle (call it session_key) that the card generates at mount time and sends on a "spawn session" control frame; the supervisor spawns a tugcode, associates the real session_id with the local handle once session_init arrives, and stamps outgoing frames with both during a handoff window. The client filter keys on the local handle until real session_id arrives, then switches. This is the trickiest bit of the design and tide.md P2 doesn't mention it at all.
➤ RESPONSE: do the "lazy" mapping/association. avoid races! avoid synchronous waiting!

- Single-writer enforcement (P5) in router.rs:663 currently locks CODE_INPUT to one client. Multi-session inside one client (same websocket) is fine — the lock is keyed per-client. But two browsers each with a Tide card for a different session will collide. P5's ownership needs to relax to (FeedId, session_key) or P2 needs to explicitly document "multi-session is intra-client only for now."

- tugbank persistence of session identity. D-T3-09 says the Tide card ↔ session is 1:1 and persists across reload. That means the card's stable id needs to map to a stable session_key in tugbank, and on reconnect the supervisor has to resume that session (or recognize it's gone and spawn a fresh one with the same key). Claude Code sessions don't survive process death, so reload-after-crash semantics need a decision: restart-with-same-key (fresh session, empty history) or reject-and-mark-orphaned?
➤ RESPONSE: restart-with-same-key (fresh session, empty history)

- Control-frame additions. We'll need spawn_session / close_session / possibly resume_session actions on FeedId::CONTROL (0xc0). These are not listed in the outline.
➤ RESPONSE: add the necessary support

- Tests. There's no obvious pattern for testing multi-session without real Claude Code. We either build a fake tugcode binary for tests or add a mode to the bridge that short-circuits the subprocess.
➤ RESPONSE: We should use real Claude Code! We have access to it... *obviously*. No mocks or modes for this. Seriously. Let's build against the real software. It's tricky enough as it is.

## Outline quality

### Coherence: the vision is right — session_id in payload, filter client-side, keep FeedIds clean. I agree with this approach without reservation.

### Completeness: about 30%. The wire contract is clear; the runtime architecture is missing. Specifically: no supervisor, no stamping strategy, no input demux design, no output merger, no lifecycle/persistence story, no control-frame surface, no bootstrap-race resolution, no test plan.

### Technical choices: the "no new FeedIds, session_id in payload" call is the right one — it matches how Claude Code already models things and keeps the FeedId namespace honest.

## Recommendation

Don't dive in. Author a plan. This is easily 6–10 steps across tugcast and tugdeck, touches a protocol contract, and has a non-trivial bootstrap-race design that wants to be argued on paper before it's written in Rust. I'd propose a /plan invocation titled something like tug-multi-session-router.md that covers:

1. Strike the stale dynamic-map section from tide.md T0.5 P2 (describe it as landed).
2. Define the wire contract: session_id: string in every CODE_OUTPUT payload, every CODE_INPUT payload, and new control actions.
3. Define the stamping strategy (byte-splice in the bridge).
4. Design agent_supervisor.rs: spawn, track, reap, persist keys.
5. Design the CODE_INPUT dispatcher (sub-option of input_sinks).
6. Design the CODE_OUTPUT merger (owns the broadcast, replay buffer, session-key stamping fallback).
7. Client: FeedStore filter API + CodeSessionStore bootstrap-race handling.
8. tugbank persistence of card ↔ session_key mapping.
9. P5 relaxation or intra-client-only scope decision.
10. Test strategy (fake tugcode binary or bridge test mode).

## Clarifying questions before I author the plan

1. Supervisor placement. Is the supervisor a new module inside tugcast, or a separate crate/binary? My lean: module inside tugcast/src/feeds/agent_supervisor.rs, same process, no new binary.
➤ RESPONSE: APPROVED. module inside tugcast/src/feeds/agent_supervisor.rs, same process, no new binary.

2. Reload semantics. When a Tide card with persisted session_key=X reloads and the prior tugcode process is gone, do we (a) spawn a fresh tugcode and reuse X as the new session_key (empty history, same slot), (b) mark the card as orphaned and prompt the user, or (c) try to resume via Claude Code's --resume flag? I'd pick (a) for now and revisit.
➤ RESPONSE: (a)

3. Intra-client vs cross-client multi-session. Is it acceptable for v1 to say "multiple Tide cards in one browser works; two browsers wanting two live sessions is future work"? That defers the P5 relaxation.
➤ RESPONSE: No, we're stopping to go back on this work after already passing through here once and moving on afterward. Let's do it completely and correctly this time now that we're circling back.

4. Stamping cost. OK with the per-frame JSON byte-splice, or want the envelope approach? Splice is faster and backwards-compatible; envelope is cleaner but breaks the single archived consumer and any future consumer that hasn't been updated.
➤ RESPONSE: I think we can splice. A tiny little wart we can live with.

5. session_init from Claude Code vs local session_key. Are you OK with the two-phase handle where the card generates a local key at mount and the bridge later associates the real Claude Code session_id with it? The alternative is a synchronous "spawn then wait for session_init" handshake that blocks card mount; I'd avoid that.
➤ RESPONSE: do the "lazy" mapping/association. avoid races! avoid synchronous waiting!

6. Plan scope. Should this plan land only the Rust + wire work, leaving the CodeSessionStore client implementation for T3.4.a as originally scheduled? Or should P2's plan also include the FeedStore filter API (small) so T3.4 can be pure store work? My lean: FeedStore filter API belongs in P2 because it's part of the wire/filter contract; CodeSessionStore belongs in T3.4.
➤ RESPONSE: ARROVED. FeedStore filter API belongs in P2 because it's part of the wire/filter contract; CodeSessionStore belongs in T3.4.

---

## Decisions locked (2026-04-12)

After a second pass that surfaced a set of secondary questions, the following are now settled and binding on the `tug-multi-session-router.md` plan. The authoritative expansion of P2 lives in `dash/tide.md` §T0.5 P2.

### Wire contract

- **Two distinct field names, to eliminate collision with Claude Code's own `session_id`:**
  - `tug_session_id` — the tugtool-generated UUID minted by the Tide card at mount, persisted in tugbank, authoritative on the wire, spliced into every CODE_OUTPUT payload, tagged on every CODE_INPUT payload, keyed on by the client filter and the supervisor dispatcher.
  - `claude_session_id` — the UUID Claude Code emits in its own `session_init` stream-json message. Supervisor-internal only. Populated in the supervisor ledger when `session_init` arrives. Never on the wire, never exposed to the client.
- Stamping is a byte-splice of `"tug_session_id":"<id>",` as the first field of every outbound JSON line in the bridge. Purely additive — Claude Code's `session_id` field inside `session_init` / `system_metadata` is left untouched. Existing `SessionMetadataFeed` / `SessionMetadataStore` continue to work.

### Bootstrap — no race, no synchronous wait

- The card knows its `tug_session_id` at mount time (freshly minted or loaded from tugbank). There is no handoff window. The card can tag CODE_INPUT frames and filter CODE_OUTPUT frames from frame zero.
- `spawn_session` on CONTROL is fire-and-forget — it registers an intent record in the supervisor ledger. The Claude Code subprocess is NOT spawned yet.
- **Lazy spawn-on-first-input.** The subprocess is spawned the first time a CODE_INPUT frame for that `tug_session_id` arrives. A freshly mounted card that the user never types into holds zero subprocess resources.
- Between first CODE_INPUT arrival and child stdin being writable, the dispatcher buffers per-session in a bounded queue (cap 256). Overflow emits a `session_backpressure` control frame.

### Supervisor and ledger

- New module: `tugcast/src/feeds/agent_supervisor.rs`. Same process, no new binary.
- The supervisor also owns the CODE_OUTPUT merger and the CODE_INPUT dispatcher. Consolidating these avoids scattering session state across three types.
- Per-session replay buffers (not one shared buffer) — reconnect traffic is scoped to the reconnecting session only.

### Session lifecycle feed — `SESSION_STATE = 0x52`

- New FeedId slot: `SESSION_STATE = 0x52` (broadcast, not watch — event stream of lifecycle transitions across all sessions).
- Payload shape: `{tug_session_id, state, detail?}` where state ∈ {`pending`, `spawning`, `live`, `errored`, `closed`}.
- `live` is published when the bridge sees `session_init` from Claude Code (at which point `claude_session_id` lands in the ledger).
- This is the ACK mechanism for `spawn_session`. Cards subscribe with the standard `FeedStore` filter keyed on their `tug_session_id`, and gate the submit button / show spawn errors based on the current state.

### Control-frame surface

New CONTROL (0xc0) actions, payload `{tug_session_id}`:
- `spawn_session` — register intent, no subprocess yet
- `close_session` — reap subprocess, drop ledger entry
- `reset_session` — kill and re-register (equivalent to close + spawn with the same key)

Errors surface through `SESSION_STATE`, not through control-frame replies. CONTROL stays fire-and-forget.

### Cross-client multi-session — in scope for v1

- P5's single-writer lock relaxes from `FeedId` to `(FeedId, tug_session_id)`. Two browsers each owning distinct `tug_session_id`s both succeed; a duplicate claim on the same id is still rejected.
- **We do not defer cross-client behind an "intra-client only" fallback.** Per the user: "we're stopping to go back on this work after already passing through here once and moving on afterward. Let's do it completely and correctly this time."

### Orphan CODE_INPUT — reject

- CODE_INPUT arriving for an unknown `tug_session_id` (no intent record in the ledger) is rejected with a `session_unknown` error control frame. No silent auto-spawn.

### Reload semantics

- Reload-with-same-key = fresh Claude Code subprocess, empty history. The prior `claude_session_id` is discarded. Claude Code's `--resume` flag is not used.
- The supervisor rebinds intent records from tugbank on startup — it does not eagerly spawn subprocesses.

### tugbank persistence

- New domain for the card ↔ `tug_session_id` map (proposed: `dev.tugtool.tide.session-keys`).
- Card id and `tug_session_id` have distinct lifecycles. "Reset this card's session" mints a new `tug_session_id` without disturbing the card id.

### Client filter API

- `FeedStore` constructor gains an optional fourth argument: `filter?: (feedId, decoded) => boolean`. Runs after decode, before snapshot update, on both live frames and the `TugConnection.lastPayload` replay cache. Lands in P2 (part of the wire contract); `CodeSessionStore` itself stays in T3.4.

### Tests — real Claude Code, no mocks

- Integration tests under `tugrust/crates/tugcast/tests/` spawn the real Claude Code binary.
- Tests are marked `#[ignore]` unless a feature flag / env var enables them, so non-Claude CI stays green.
- Deterministic-enough prompts (`> /status`, `> say exactly the word hello`) exercise the pipeline without depending on LLM output details.

### Naming / field-name collision — the secondary question this pass surfaced

- The original approved spec said "put `session_id` in the payload." That collided with Claude Code's own `session_id` field in two places: inside `session_init` and inside `system_metadata` (the latter is load-bearing for the existing `SessionMetadataStore`).
- Resolved by renaming: the wire field is `tug_session_id`; Claude Code's internal id is tracked as `claude_session_id` in the supervisor ledger. No overwrite, no collision, no semantic drift in the existing stores.
- This also dissolves the bootstrap race — because `tug_session_id` is client-authoritative and known at mount, there is never a moment when the card doesn't know its own key.

### Plan authorship — next step

Author `tug-multi-session-router.md` via `/plan`. The doc should be a direct expansion of the 12-item list in tide.md §T0.5 P2 into implementable steps, plus the integration-test strategy. Clarifying-question pass should be short — most of it is settled here.

**Status — 2026-04-12:** ✅ **Done.** Plan authored and landed as
`dash/tugplan-multi-session-router.md`. All 10 implementation steps
are committed; Step 11 integration checkpoint verified with
`cargo build` + `cargo nextest run` (1012 passed, 18 skipped) across
the full workspace and `bun test` (1924 passed) in tugdeck. Manual
real-Claude run via `TUG_REAL_CLAUDE=1` → 9/9 integration tests pass
against a live `claude` binary. Phase T0.5 P2 unblocks T3.4 Tide card
multi-session.
