<!-- devise-skeleton v4 -->

## Session Activity API — a trait-mediated tugcast feed driving compact and expanded data displays {#data-display-buildout}

**Purpose:** Land a properly-abstracted `SessionScopedFeed` in tugcast (fixing the dead-trait / per-session-duplication debt for good), then build a single unified `ACTIVITY` feed on it — derived by the **one** authoritative stream interpreter (tugcode), routed by tugcast, consumed by a pure-consumer deck — carrying every dimension of per-session work (text, tokens, tools, subagents, CPU, memory, disk) to drive the compact pulse sparkline today and an expanded Activity card tomorrow.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-02 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The pulse sparkline plots "characters the foreground model streamed," derived **in the browser** off `CODE_OUTPUT`, so it flatlines for everything that isn't a Write/Edit (skills, `AskUserQuestion` resumes, thinking, subagents). Two structural problems sit underneath: (1) the activity model is deck-only — recomputed per card, invisible to any non-deck consumer; and (2) tugcast, the facility *designed* to be the conduit for channels from disparate sources, is under-used and carries real design debt — its `StreamFeed`/`SnapshotFeed` traits are vestigial (the big feeds bypass them and push raw channels), and every per-session feed reinvents `tug_session_id` splicing on the cast plus a hand-authored filter on the deck.

This plan fixes both. First it makes tugcast's feed registration **trait-mediated** and introduces a real, router-integrated **`SessionScopedFeed`** abstraction, converting *every* server→client feed through it so nothing bypasses the trait layer. Then it builds one unified **`ACTIVITY`** feed on that foundation. Crucially, derivation lives at the **single authoritative interpreter** — tugcode's `dispatchEventToTurn`, the one place claude's stream is already parsed — which emits `activity_delta` frames; tugcast diverts them onto `ACTIVITY` (exactly as it already rewraps `SESSION_SIDEBAND`); the deck records them. There is no second interpreter, so the two-parsers drift risk does not exist. OS signals (CPU/memory/disk) are sampled cast-side over the session's process **subtree** (never the working directory) and ride the same feed.

#### Strategy {#strategy}

- **Part A — pay down the tugcast debt first.** Make feed registration trait-mediated and introduce `SessionScopedFeed` ([P14], [P19]); convert feeds safest-first — the already-trait feeds (TERMINAL/FS/GIT) + FileTree reconciliation, then `SESSION_STATE`, then `SESSION_SIDEBAND` (rewrap invariant), then `CODE_OUTPUT` (replay buffer + input-ownership) — each behind its own parity/isolation checkpoint so no regression escapes ([R04], [R05]). This is required work, not a follow-on.
- **Part B — build `ACTIVITY` on the clean foundation.** Allocate `FeedId::ACTIVITY = 0x42` ([P16]); the feed is a native `SessionScopedFeed` client.
- **Derive once, at the origin.** tugcode accumulates per-turn activity in `ActiveTurn` and flushes `activity_delta` frames on a 250 ms bin behind `!suppressEmit` ([P13], [P21]); tugcast diverts them to `ACTIVITY`; the deck's `recordThroughput` is deleted.
- **Deck is a pure consumer** ([P01]–[P04]) — the wire frame maps 1:1 to `store.record(session, channel, units, at)`.
- **Enrich compact** ([P05]) then **add the OS instrument** ([P08]–[P11], [P20]) folded into the same feed, then the **expanded Activity card** ([P12]).
- Keep high-churn series **out of React state** ([P03]); only `enabled`/channel-membership pass through the snapshot ([L02], [L06]).

#### Success Criteria (Measurable) {#success-criteria}

> Make these falsifiable.

- **Trait layer is live, not vestigial:** every server→client feed (TERMINAL, FILESYSTEM, FILETREE, GIT, SESSION_STATE, SESSION_SIDEBAND, CODE_OUTPUT, PULSE, ACTIVITY) registers through the trait-mediated API; grep confirms no feed pushes onto a raw `broadcast::Sender` outside the abstraction, modulo the two named exemptions in [P19] (CONTROL; the FILETREE/GIT_DIFF response fan-in senders).
- **Exactly one interpreter:** the deck contains zero `CODE_OUTPUT`-derived activity math (`recordThroughput`, `throughputMeter`, its constants/maps gone); tugcode is the sole producer of activity counts, pinned by a fixture unit test.
- **Model on the wire:** a raw `ACTIVITY` dump (Dev panel / frame capture) shows per-session channel samples independent of the deck.
- **Flatlines fixed:** a `tugplug` skill and a post-`AskUserQuestion` resume each drive the sparkline off baseline (`verify`).
- **Session isolation:** a Bash `cargo build` produces a CPU hump absent from a second idle session in the same directory; a PID reused after a session closes is **not** attributed (start-time guard) — provable by a Rust unit test.
- **No refactor regression:** `CODE_OUTPUT` after conversion still isolates two concurrent sessions and still recovers a lagging client via replay — driven by an integration checkpoint.
- `SessionScopedFeed` round-trip routing unit test passes; `cargo nextest run`, `bunx vite build`, `bun test`, `bun run audit:theme-contrast` all pass (warnings are errors).

#### Scope {#scope}

1. Trait-mediated feed registration; `SessionScopedFeed` (cast) + `subscribeSessionFeed` (deck); convert **all** server→client feeds through it.
2. `FeedId::ACTIVITY = 0x42`; the feed as a native `SessionScopedFeed`.
3. tugcode `activity_delta`: `ActiveTurn` accumulator + 250 ms flush; the single authoritative counter.
4. tugcast divert of `activity_delta` → `ACTIVITY`.
5. Deck `SessionActivityStore` + `ActivityMeter` (rate/gauge), pure consumer; delete deck derivation.
6. Compact view: dominant color + composite intensity.
7. OS subtree sampler (CPU/memory/disk) with `(pid, start_time)` reuse-guard, folded into `ACTIVITY`.
8. Pulse **label** coverage (skills / AskUserQuestion / generic tool).
9. Expanded **Activity card**.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Unifying `StatCollector` into `SnapshotFeed`** — `StatCollector` (timer-polled process-global stats) is a legitimate distinct model; its *registration surface* is routed through the unified path, but the two trait models are not merged ([P19]).
- **Input feeds (client→server) trait-mediation** — `register_input` is already uniform; the abstraction targets server→client feeds.
- **Deck-side activity derivation / a separate `SESSION_RESOURCE` feed** — removed / folded into `ACTIVITY`.
- **Ledger/history/hydration for activity** — ephemeral, rolling; no SQLite table, no `list_*` CONTROL verb ([P15]).
- Overlaid stacked-band card rendering; app-wide overview; Linux disk I/O — follow-ons ([Q03], [Q04], [P12]).

#### Dependencies / Prerequisites {#dependencies}

- The `SESSION_SIDEBAND` rewrap in `merger_task` (`agent_supervisor.rs`) as the precedent for diverting a frame type onto another feed.
- `ActiveTurn` (`session.ts`) + `suppressEmit` as the accumulator and replay gate; `writeLine`/`OutboundMessage` (`ipc.ts`/`types.ts`) as the (unguarded) outbound path.
- `splice_tug_session_id` (`feeds/code.rs`) to generalize into `SessionScopedFeed`; `FeedStore`'s filter for `subscribeSessionFeed`.
- `sysinfo 0.34` (`Process::start_time()`, `parent()`, `cpu_usage()`, `memory()` confirmed) and `libc` (`proc_pid_rusage`).

#### Constraints {#constraints}

- **WARNINGS ARE ERRORS** across the workspace.
- tugdeck laws: [L01] one render; [L02] external state via `useSyncExternalStore`; [L06] appearance via CSS/DOM; [L13] WAAPI motion.
- `FeedId` is hand-mirrored (Rust `protocol.rs` ↔ TS `protocol.ts`) with byte-assertion tests; a new byte touches both + `name()`.
- CPU accuracy needs **two** `sysinfo` refreshes; enumerate a subtree by refreshing all processes and walking `parent()` links.
- Platform: macOS for OS sampling.
- Verify deck changes with `bunx vite build`; rebuild the tugcode binary after tugcode changes.

#### Assumptions {#assumptions}

- Every activity signal already passes through `dispatchEventToTurn` with the turn in scope, so counting can be added there without a second parse.
- Replayed frames never generate activity (the JSONL translator emits no `streaming_usage`/`tool_input_progress`/`task_progress`; replayed text is `is_partial:false`), and `suppressEmit` gates any concurrent live delta — so activity is replay-safe with zero cast-side work.
- The tugcode subtree (claude + Bash subprocesses) equals "what this session did"; attribution is a PID-parentage walk validated by process start time, not cwd or pgid.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit, kebab-case; plan-local decisions use `[P01]`; steps cite decisions/specs/anchors, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Token-velocity source field (DECIDED) {#q01-token-source}

**Resolution:** DECIDED ([P06]). `usage.output_tokens` is cumulative within a `msg_id`; tugcode tracks last per `msg_id`, records `max(0, cur − last)`, seeds on new id.

#### [Q05] Interpreter drift between deck and cast (DECIDED — eliminated) {#q05-interpreter-drift}

**Question:** How do we stop a cast-side re-interpreter of `CODE_OUTPUT` from drifting against the deck's?

**Resolution:** DECIDED — there is **no second interpreter**. Derivation lives only in tugcode's `dispatchEventToTurn` ([P13]); tugcast routes opaquely; the deck records. Parity is by construction ([P21]) and pinned by a fixture unit test in tugcode.

#### [Q06] tugcode activity flush mechanism (DECIDED) {#q06-flush-timer}

**Question:** How does tugcode bin/flush `activity_delta` (no periodic tick exists in the stream path today)?

**Resolution:** DECIDED — a dedicated 250 ms `setInterval` on `SessionManager`, **active only during a live turn**, flushing the `ActiveTurn` accumulator and emitting `activity_delta` behind `!suppressEmit`, with a trailing flush + clear on turn end so the final decaying bin is emitted. 250 ms matches the meter bin so the deck math is unchanged.

#### [Q02] Sampler cadence and subtree-walk cost (OPEN) {#q02-sampler-cadence}

**Question:** OS sample interval and the cost of a full-process `sysinfo` refresh (needed to build the parent map) with several sessions.

**Plan to resolve:** Step 12 spike — 3 concurrent `cargo build` sessions; measure the sampler's own CPU against a **hard budget of ≤2% of one core**; pick the coarsest cadence (default 1 Hz) that still shows a legible hump; gate refresh to when ≥1 session has a live PID.

**Resolution:** OPEN — resolved by the Step 12 budget checkpoint.

#### [Q03] Cross-platform disk I/O (DEFERRED) {#q03-disk-crossplat}

**Resolution:** DEFERRED — `proc_pid_rusage` is macOS-only; the disk channel is absent elsewhere (store/card tolerate absent channels).

#### [Q04] Activity card scope (DEFERRED) {#q04-card-scope}

**Resolution:** DEFERRED — first card is session-bound; the app-scoped store supports an all-sessions view later.

---

### Risks and Mitigations {#risks}

> Each risk is driven to its floor at the source; residuals are stated honestly.

| Risk | Impact | Likelihood | Mitigation → floor | Residual |
|------|--------|------------|--------------------|----------|
| Interpreter drift | med | **none** | Single interpreter in tugcode ([P13], [Q05]); fixture test ([P21]) | A new tugcode frame type needs a counting rule in one place |
| Cutover regresses sparkline | med | **low→none** | Verify on the wire before deleting deck path; counting moved whole, not rewritten | Mechanical deletion caught by parity checkpoint |
| Replay double-counts | med | **none** | Emit behind `!suppressEmit`; translator emits no activity frames | None |
| PID reuse misattributes | med | **none** | `(pid, start_time)` capture + `start_time()` validation ([P20]) | One-tick window only if a PID is reused *and* start times collide (implausible) |
| `CODE_OUTPUT` conversion regresses | high | low | Convert last, behind isolation + lag/replay-recovery checkpoint ([R04]) | Bounded to the conversion step; caught by tests |
| Sampler CPU cost | med | low | One shared `System`, 1 Hz, gated to live PIDs, hard ≤2%/core budget ([Q02]) | Proportional to subtree size (honest floor) |

**Risk R04: `CODE_OUTPUT` trait conversion** {#r04-code-output-conversion}

- **Risk:** `CODE_OUTPUT` bundles the shared `ReplayBuffer`, cross-session broadcast (deck-filtered, [D06]/[D11]), the merger fan-in, and `CODE_INPUT` `InputOwnership` keyed by `Some(tug_session_id)`. A botched conversion could leak frames across sessions or break lag recovery.
- **Mitigation:** It is the **last** conversion (Step 4), after `SessionScopedFeed` is proven on `SESSION_STATE`/`SESSION_SIDEBAND`; `SessionScopedFeed` preserves splice + replay-buffer + input-ownership semantics exactly; the Step-4 checkpoint drives two concurrent sessions plus a forced lag and asserts isolation + replay recovery.
- **Residual:** Bounded to Step 4; any regression fails the checkpoint before commit.

**Risk R05: Refactor blast radius** {#r05-refactor-blast-radius}

- **Risk:** Trait-mediating every feed touches terminal/fs/ft/git/session/code producers.
- **Mitigation:** Safest-first sequence (already-trait feeds → `SESSION_STATE` → `SESSION_SIDEBAND` → `CODE_OUTPUT`); each conversion is behavior-neutral with its own parity checkpoint; Step 5 asserts no raw bypass remains.
- **Residual:** Schedule cost — the feature (Part B) does not start until the foundation lands.

---

### Design Decisions {#design-decisions}

#### [P01] App-scoped `SessionActivityStore` keyed by session id (DECIDED) {#p01-app-scoped-store}

**Decision:** One app-scoped store keyed by `tug_session_id` (mirroring `PulseStore`), holding per-channel meters; fed by one `ACTIVITY` subscription.

**Rationale:** The compact strip, the Activity card, and the Dev panel read a session's activity without holding its router.

#### [P02] Channels + rate/gauge aggregation (DECIDED) {#p02-channels}

**Decision:** `text | tokens | tools | subagents` (rate) and `cpu | memory | disk` (gauge). Each has an `ActivityMeter` + descriptor `{unit, hue, fullScale, curve, kind}`. `rate` channels sum the rolling window to a per-second rate. `gauge` channels use **sample-and-hold**: the meter holds the last observed value for a TTL (~2× the gauge sample interval) and returns it for empty bins within the TTL, decaying to zero only when samples stop — never the zero-filled empty bin. Channels may be absent.

**Rationale:** CPU%/bytes-per-sec are already rates/levels — summing them over the window would over-count. And gauges arrive at 1 Hz into 250 ms bins, so three of every four bins are empty; "latest bin value" with zero-fill would strobe the CPU line between its real value and zero. Sample-and-hold reads the true level between samples and still decays to baseline when a session goes quiet or closes.

#### [P03] High-churn series out of React state (DECIDED) {#p03-out-of-react}

**Decision:** Series read imperatively on the consumer's timer, painted to SVG; only `enabled`/membership go through `useSyncExternalStore` ([L02], [L06]).

#### [P04] Composite for compact, per-channel for expanded (DECIDED) {#p04-composite-vs-channels}

**Decision:** Store exposes `compositeSeries`/`intensity`/`dominant` (compact) and `series`/`raw` per channel (expanded).

#### [P05] Color by dominant channel via CSS data-attribute (DECIDED) {#p05-color-by-dominant}

**Decision:** `TugSparkline` stamps `data-activity-channel` from `getColorChannel(nowMs)` in its sample loop; theme CSS maps to a hue; dominant uses hysteresis.

#### [P06] Token velocity from `output_tokens` delta per `msg_id` (DECIDED) {#p06-token-velocity}

**Decision:** `tokens` records `max(0, output_tokens − last[msg_id])`, computed **in tugcode** ([P13]).

#### [P07] Tool/subagent cadence as decaying bursts (DECIDED) {#p07-cadence}

**Decision:** Each `tool_use`/`tool_result`/`task_progress` records a fixed unit burst into `tools` (foreground) or `subagents` (`parent_tool_use_id`), computed in tugcode; the rolling window decays it.

#### [P08] OS attribution roots at the tugcode child PID subtree (DECIDED) {#p08-pid-subtree}

**Decision:** Sample the PID subtree rooted at the session's tugcode child (claude + Bash subprocesses), enumerated by `sysinfo` `parent()` links.

**Rationale:** Session-scoped by parentage, not cwd; pgid can't distinguish sessions; tugcast spawns that child.

#### [P09] OS signals ride the unified `ACTIVITY` feed (DECIDED) {#p09-unified-feed}

**Decision:** CPU/memory/disk are additional producers onto `ACTIVITY` (no separate resource feed).

#### [P10] Sampler is a dedicated task feeding `ACTIVITY`, not a `StatCollector` (DECIDED) {#p10-sampler-task}

**Decision:** A task with a handle to the session registry iterates live sessions; its gauge samples are published on `ACTIVITY` via `SessionScopedFeed`.

#### [P11] Disk I/O via `libc::proc_pid_rusage(RUSAGE_INFO_V2)` (DECIDED) {#p11-disk-rusage}

**Decision:** macOS per-PID disk bytes summed over the subtree, differenced across ticks to bytes/sec; zero elsewhere.

#### [P12] First expanded rep is small-multiples (DECIDED) {#p12-activity-card}

**Decision:** The Activity card renders one labeled `TugSparkline` + raw readout per live channel; stacked bands are a follow-on.

**Surface (DECIDED 2026-07-06):** the expanded card lives as a **popover off the Z2 PULSE strip** — the same pattern the TIME/TOKENS/CONTEXT telemetry cells use (`dev-card-telemetry-popovers.tsx`, `PerAreaPopoverFrame`). Session-bound by construction (no card-registry / sheet plumbing); the compact strip is the entry point, the popover is its expansion. A standalone, movable deck card (via `registerCard`) is the eventual home for the app-wide **all-sessions** view — that is the deferred [Q04] follow-on, not Step 15.

#### [P13] Single authoritative interpreter: tugcode emits `activity_delta` (DECIDED) {#p13-single-interpreter}

**Decision:** All stream-derived channels are counted **only** in tugcode's `dispatchEventToTurn` (the one existing parser), accumulated in `ActiveTurn`, and emitted as `activity_delta` frames; tugcast diverts them onto `ACTIVITY` (as it rewraps `SESSION_SIDEBAND`); the deck records. The deck's `recordThroughput` is deleted.

**Rationale:** Eliminates the two-interpreters drift risk at the source ([Q05]); makes the activity model a wire contract any consumer can tap; kills per-card recompute. tugcode already owns the frame semantics, so the counting has one home.

**Implications:** New `activity_delta` `OutboundMessage` (no outbound allowlist to satisfy); tugcast gains a divert branch in `merger_task`; the deck reducer is untouched (it keeps full semantic reduction; it just stops counting).

#### [P14] `SessionScopedFeed` — a real, router-integrated abstraction (DECIDED) {#p14-session-scoped-feed}

**Decision:** Introduce `SessionScopedFeed` as a first-class, router-integrated trait/registration (not just helper fns): it owns splice-on-emit (generalizing `splice_tug_session_id`), the merger fan-in registration, and the per-feed lag policy / replay buffer; the deck counterpart is `subscribeSessionFeed` (a `FeedStore` wrapper carrying the `d.tug_session_id === session` predicate). `ACTIVITY` is a native client; `SESSION_STATE`/`SESSION_SIDEBAND`/`CODE_OUTPUT` are converted onto it.

**Rationale:** The existing `StreamFeed`/`SnapshotFeed` traits have no room for session tagging, fan-in, or replay — which is exactly why the big feeds bypass them. This is the shape that lets the trait layer actually mediate per-session feeds.

#### [P15] `ACTIVITY` frame = binned per-session channel-sample; no ledger (DECIDED) {#p15-frame-shape}

**Decision:** tugcode emits one `activity_delta` per active turn per 250 ms bin: `{ type, channels: { <channel>: units } }`; tugcast splices `tug_session_id` and re-tags it `ACTIVITY`; the deck maps it 1:1 to `store.record`. Ephemeral — no SQLite ledger, no `list_*` CONTROL verb; a reconnecting deck starts fresh (the sparkline seeds a flat baseline).

#### [P16] Fresh `FeedId::ACTIVITY = 0x42` (DECIDED) {#p16-feed-byte}

**Decision:** Allocate `0x42` (adjacent to `CODE_OUTPUT 0x40`/`CODE_INPUT 0x41`, apt for a code-derived feed); Rust const + `name()` + byte test, TS mirror. Reserved `SHELL`/`TUG_FEED` bytes untouched.

#### [P17] Transport: session-tagged broadcast, `LagPolicy::Warn`, self-healing (DECIDED) {#p17-transport}

**Decision:** `ACTIVITY` is a broadcast `SessionScopedFeed` with `LagPolicy::Warn`. The deck needs the sample *stream* (not a latest-only watch). Volume is low (≤4 Hz/session + 1 Hz OS); a dropped rate-bin is a negligible gap and a dropped gauge self-heals on the next tick.

#### [P19] Trait-mediated registration; no feed bypasses the abstraction (DECIDED) {#p19-trait-mediated}

**Decision:** Every server→client feed registers through a trait-mediated API — `StreamFeed` (app/workspace broadcast, including PULSE), `SnapshotFeed` (watch), or `SessionScopedFeed` (per-session) — reconciling `FileTree`'s signature and routing `StatCollector`'s registration through the same surface. No feed pushes onto a raw `broadcast::Sender` outside the abstraction, with exactly two **named exemptions**: CONTROL (router-internal, bidirectional, carries router-emitted error frames) and the multi-producer snapshot-broadcast response senders (FILETREE/GIT_DIFF request→response fan-in — a distinct transport by design).

**Rationale:** The user-visible debt is a dead trait layer bypassed by the real feeds; the fix is to make the layer actually carry every feed. The two exemptions are structural (router plumbing and response fan-in), not feeds dodging the abstraction — naming them makes the no-bypass assertion precise and checkable.

**Implications:** `LagPolicy` and any replay buffer become feed-owned; the router holds/spawns feeds through the registration; conversions are sequenced safest-first ([R05]).

#### [P20] PID-reuse elimination via `(pid, start_time)` (DECIDED) {#p20-pid-start-time}

**Decision:** Capture the tugcode child's `(pid, start_time)` at spawn; the sampler validates the live process's `start_time()` equals the captured value before attributing any subtree, and treats a mismatch/missing process as zero.

**Rationale:** A reused PID has a different start time, so this reduces misattribution to nil rather than tracking it as a risk.

#### [P21] Cutover parity + enumerated enhancements (DECIDED) {#p21-parity}

**Decision:** The counting logic is relocated from the deck's `recordThroughput` into tugcode with **parity for every existing signal** (text/thinking deltas, `tool_input_progress` byte deltas, subagent bursts and results, foreground results, `task_progress`) plus exactly **two enumerated enhancements** (token deltas replace the flat `streaming_usage` pip; a foreground `tool_use` burst is added) — all itemized per-row in Spec S04. A tugcode fixture unit test replays captured claude stream-json events through `dispatchEventToTurn` and asserts the S04 per-channel units — so the test pins the *spec*, not a false byte-identical-parity claim — before the deck path is deleted. The producer is verified on the wire (Step 8) before the consumer cutover (Step 9).

---

### Deep Dives (Optional) {#deep-dives}

#### tugcast usage, debt, and remedies {#tugcast-usage}

- **Debt remedied:** the dead `StreamFeed`/`SnapshotFeed` traits and the per-session splice+filter duplication. Part A makes registration trait-mediated ([P19]) and adds `SessionScopedFeed` ([P14]) so per-session feeds stop reinventing tagging; `ACTIVITY` is the first native client and `SESSION_STATE`/`SESSION_SIDEBAND`/`CODE_OUTPUT` are converted onto it.
- **Used well:** the open `u8` namespace ([P16]); the `merger_task` type-divert precedent ([P13]); broadcast transport for a sample stream ([P17]).
- **Deliberately not merged:** `StatCollector` stays a distinct model (its registration surface is unified, its trait is not) — merging it into `SnapshotFeed` is over-reach ([P19] non-goal).
- **Deliberately skipped:** ledger + CONTROL hydration — activity is ephemeral ([P15]).

#### End-to-end data flow {#data-flow}

```
tugcode (SINGLE interpreter [P13])          tugcast (routes)              deck (pure consumer)
─────────────────────────────────          ───────────────              ────────────────────
dispatchEventToTurn → ActiveTurn bin        merger_task diverts          subscribeSessionFeed [P14]
  text/tokens/tools/subagents               activity_delta → ACTIVITY     → store.record(session,
  → activity_delta (250ms) [Q06,P15]        (splice tug_session_id)          channel, units, at) [P15]
                                     ┌─ FeedId::ACTIVITY 0x42 ─┐          descriptors/composite/dominant
OS subtree sampler [P08,P10,P11,P20] ┘  (SessionScopedFeed [P14])         → DevPulseStrip (compact)
  cpu/memory/disk (gauge [P02])                                          → Activity card (expanded [P12])
```

#### Process tree and attribution {#process-tree}

```
tugexec → tugcast → tugcode (per session; tugcast spawns) → claude → bash subprocesses
```

Root at the tugcode child `(pid, start_time)` ([P08], [P20]); enumerate the subtree via `sysinfo` `parent()`; sum cpu/memory/disk. Two same-directory sessions are distinct subtrees.

---

### Specification {#specification}

#### Spec S01: SessionActivityStore (deck) {#s01-store-api}

```ts
type ActivityChannel = "text"|"tokens"|"tools"|"subagents"|"cpu"|"memory"|"disk";
interface ActivityChannelDescriptor { unit: string; hue: string; fullScale: number; curve: SparklineCurve; kind: "rate"|"gauge"; }
class SessionActivityStore {
  record(session, channel, units, atMs): void;         // 1:1 with ACTIVITY frame [P15]
  series(session, channel, nowMs): number[];           // rate: window-summed; gauge: sample-and-hold w/ TTL [P02]
  raw(session, channel): { value; unit } | null;
  compositeSeries(session, nowMs): number[]; intensity(session, nowMs): number; dominant(session, nowMs): ActivityChannel|null;
  channels(session): ActivityChannel[]; clearSession(session): void;
  subscribe(cb): () => void; getSnapshot(): { enabled; sessions };  // membership/enabled only [P03]
}
```

#### Spec S02: ACTIVITY wire frame {#s02-activity-payload}

```jsonc
// from tugcode as activity_delta; tugcast splices tug_session_id + re-tags FeedId::ACTIVITY
{ "tug_session_id": "c745a4d7…", "at": "…", "channels": {
  "text": 312, "tokens": 47, "tools": 1,               // rate: accumulated this bin
  "cpu_pct": 143.2, "rss_bytes": 512000000,            // gauge (from cast sampler)
  "disk_read_bps": 10485760, "disk_write_bps": 2097152 } }
```

`FeedId::ACTIVITY = 0x42` (Rust + TS mirror). Parsed by `parseActivityFrame`; routed by `subscribeSessionFeed`.

#### Spec S03: SessionScopedFeed {#s03-session-scoped-feed}

- **Cast:** a router-integrated abstraction owning splice-on-emit (generalizing `splice_tug_session_id`), merger fan-in registration, and per-feed lag policy / replay buffer. `SESSION_STATE`/`SESSION_SIDEBAND`/`CODE_OUTPUT`/`ACTIVITY` are clients.
- **Deck:** `subscribeSessionFeed(conn, feedId, sessionId, onSample)` — a `FeedStore` wrapper with the `d.tug_session_id === sessionId` predicate.
- **Test:** producers for sessions A/B; two consumers each receive only their own frames.

#### Spec S04: tugcode `activity_delta` counting {#s04-counting}

Relocated from the deck's `recordThroughput`, computed in `dispatchEventToTurn`, accumulated in `ActiveTurn`. Rows marked **(parity)** replicate the deck's exact field reads and units; rows marked **(enhancement)** are deliberate changes pinned by the same fixture test ([P21]):

| Frame | Read | Units → channel | |
|---|---|---|---|
| `assistant_text`/`thinking_text` (partial) | `text.length` | → `text` | (parity) |
| `tool_input_progress` | `bytes` Δ per `tool_use_id` (a forming Write/Edit — the richest signal) | → `text` | (parity) |
| `streaming_usage` | `output_tokens` Δ per `msg_id` | → `tokens` | (enhancement — replaces the flat 60-unit pip) |
| `tool_use` (has `parent_tool_use_id`) | fixed burst, dedupe by `tool_use_id` | → `subagents` | (parity) |
| `tool_result` (has `parent_tool_use_id`) | capped `output.length` | → `subagents` | (parity) |
| `tool_result` (foreground) | capped `output.length` | → `tools` | (parity) |
| `tool_use` (foreground) | fixed burst | → `tools` | (enhancement — deck never counted it) |
| `task_progress` | fixed burst | → `tools` | (parity) |

Emitted per 250 ms bin behind `!turn.suppressEmit` ([Q06]); pinned by a fixture test ([P21]).

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Per-channel series / composite / intensity | local-data (high-churn) | imperative store methods; read on timer; painted to SVG | [L02], [L06], [P03] |
| Dominant-channel fill color | appearance | `data-activity-channel` stamped in sample loop; theme CSS | [L06], [P05] |
| `enabled` + channel membership | local-data (low-churn) | store snapshot via `useSyncExternalStore` | [L02] |
| Activity card rows | structure | React render from `channels()` | [L02] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugcast/src/feeds/session_scoped.rs` | `SessionScopedFeed` abstraction + producer ([P14], Spec S03) |
| `tugcast/src/feeds/activity/mod.rs` | `ACTIVITY` feed producer + OS-sampler integration ([P09]) |
| `tugcast/src/feeds/activity/resource.rs` | OS subtree sampler, `(pid,start_time)` guard ([P10], [P11], [P20]) |
| `tugdeck/src/lib/session-feed.ts` | `subscribeSessionFeed` consumer helper ([P14]) |
| `tugdeck/src/lib/activity-meter.ts` | Rate/gauge rolling-bin meter ([P02]) |
| `tugdeck/src/lib/session-activity-store.ts` | App-scoped store ([P01], Spec S01) |
| `tugdeck/src/components/tugways/cards/activity-card.tsx` (+ `.css`) | Expanded consumer ([P12]) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `SessionScopedFeed` + registration | trait/API | `feeds/session_scoped.rs`, `router.rs` | [P14], [P19] |
| feed registrations | wiring | `main.rs`, `workspace_registry.rs`, `agent_supervisor.rs` | Convert TERMINAL/FS/FT/GIT/SESSION_STATE/SESSION_SIDEBAND/CODE_OUTPUT ([P19]) |
| `FeedId::ACTIVITY` | const `0x42` | `tugcast-core/protocol.rs` + `name()` + test; `tugdeck/protocol.ts` | [P16] |
| `ActivityDelta` | interface + union member | `tugcode/types.ts` | [P13], no outbound guard |
| `ActiveTurn` activity bin + flush | fields/method + `setInterval` | `tugcode/session.ts` (`dispatchEventToTurn`, `SessionManager`) | Spec S04, [Q06] |
| `activity_delta` divert | branch | `agent_supervisor.rs` `merger_task` | [P13] |
| `(pid, start_time)` capture | field | `agent_bridge.rs`/`agent_supervisor.rs` `SessionEntry` | [P20] |
| `proc_pid_rusage` binding | fn `#[cfg(macos)]` | `feeds/activity/resource.rs` | [P11] |
| `SessionActivityStore`/`ActivityMeter`/`ActivityChannel` | class/type | deck `lib/*` | Spec S01, [P02] |
| `parseActivityFrame` | fn | `tugdeck/protocol.ts` | Spec S02 |
| `recordThroughput`, `throughputMeter`, unit consts, `_toolInputBytes`, `_subagentToolSeen`, `ThroughputMeter` | **delete** | `code-session-store.ts`, `throughput-meter.ts` | [P13] |
| `DevPulseStrip` / `TugSparkline` | component | deck | composite + `getColorChannel` ([P04], [P05]) |
| activity-channel hue tokens | CSS | `styles/themes/*.css` | [P05] |
| Voice tool cases | fn | `tugcode/src/pulse/voice.ts` | skills/AskUserQuestion/generic |

---

### Test Plan Concepts {#test-plan-concepts}

| Category | Purpose | When |
|----------|---------|------|
| **Unit (Rust)** | `SessionScopedFeed` round-trip routing; per-feed conversion parity; subtree sum; `(pid,start_time)` reuse rejection; `proc_pid_rusage` | Foundation + OS |
| **Unit (tugcode)** | `activity_delta` counting vs fixtures ([P21], Spec S04); flush/bin behavior; `suppressEmit` gating | Single-interpreter |
| **Unit (deck)** | `ActivityMeter` rate vs gauge; store record/series/composite/dominant/hysteresis | Presentation |
| **Contract** | `ACTIVITY` round-trips `parseActivityFrame` (Spec S02) | Wire |
| **Real-app (verify)** | Flatlines fixed; two-session CPU + PID-reuse isolation; color; `CODE_OUTPUT` isolation + replay recovery after conversion | End-to-end |

**Out of tests:** jsdom render tests; mock-store assertions; Linux disk ([Q03]).

---

### Execution Steps {#execution-steps}

> Commit after checkpoints pass. Deck: `bunx vite build`. Rust: `cargo nextest run`. tugcode: rebuild the binary.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Trait-mediated registration; convert TERMINAL/FS/FT/GIT/PULSE | done | d3bb15ac6 |
| #step-2 | `SessionScopedFeed` + convert SESSION_STATE | done | 64f20f0e1 |
| #step-3 | Convert SESSION_SIDEBAND (rewrap-preserving) | done | bdd42a10e |
| #step-4 | Convert CODE_OUTPUT (replay + input-ownership) | done | 02af5ed93 |
| #step-5 | Route STATS registration; foundation checkpoint | done | 023f9cdeb |
| #step-6 | `FeedId::ACTIVITY` as a native SessionScopedFeed | done | (folded w/ #step-7) |
| #step-7 | tugcast divert `activity_delta` → ACTIVITY | done | see dash log |
| #step-8 | tugcode `activity_delta` (single interpreter) | done | see dash log |
| #step-9 | Deck store consumes ACTIVITY; delete deck derivation | done | see dash log |
| #step-10 | Compact: dominant color + composite intensity | done | see dash log |
| #step-11 | Retain `(pid, start_time)` per session | done | see dash log |
| #step-12 | OS subtree sampler → CPU/memory into ACTIVITY | done | see dash log |
| #step-13 | Disk I/O via `proc_pid_rusage` | done | see dash log |
| #step-14 | Pulse labels: skills, AskUserQuestion, generic | done | see dash log |
| #step-15 | Expanded Activity card | done | see dash log |
| #step-16 | Integration checkpoint | done | verification-only |

#### Step 1: Trait-mediated registration; convert TERMINAL/FS/FT/GIT/PULSE {#step-1}

**Commit:** `tugcast(feeds): trait-mediated feed registration; convert terminal/fs/filetree/git/pulse`

**References:** [P19] trait-mediated, Risk R05, (#tugcast-usage)

**Artifacts:** a registration API where feeds self-register (lag policy feed-owned); `StreamFeed`/`SnapshotFeed` reconciled to carry the already-trait feeds through the router; `FileTree` signature reconciled (widen or a `WorkspaceScopedFeed` variant); the PULSE bridge converted (app-scoped broadcast — exactly `StreamFeed`-shaped, the cheapest conversion in the set).

**Tasks:**
- [ ] Introduce the registration surface; move `LagPolicy` to feed-owned.
- [ ] Convert TERMINAL (Bootstrap), FILESYSTEM, GIT; reconcile FILETREE (watch + response broadcast).
- [ ] Convert PULSE (the pulse bridge publishes through the abstraction instead of a raw `pulse_tx`).

**Tests:**
- [ ] Unit: each converted feed still produces its frames through the API.

**Checkpoint:**
- [ ] `cargo nextest run` passes; terminal/fs/filetree/git/pulse behave identically in the real app (`verify`).

---

#### Step 2: `SessionScopedFeed` + convert SESSION_STATE {#step-2}

**Depends on:** #step-1

**Commit:** `tugcast(feeds): SessionScopedFeed abstraction; convert SESSION_STATE`

**References:** [P14] abstraction, [P19], Spec S03, (#session-scoped-feed)

**Artifacts:** `feeds/session_scoped.rs` (splice-on-emit + fan-in + lag policy); deck `subscribeSessionFeed`; SESSION_STATE converted (lowest-risk per-session feed).

**Tasks:**
- [ ] Implement `SessionScopedFeed` generalizing `splice_tug_session_id`; integrate with router registration + merger fan-in.
- [ ] Implement `subscribeSessionFeed` generalizing `acceptFrame`.
- [ ] Convert SESSION_STATE onto it.

**Tests:**
- [ ] Unit (Rust): producers A/B; consumers each receive only their session (Spec S03).
- [ ] Unit (deck): `subscribeSessionFeed` filters by session.

**Checkpoint:**
- [ ] `cargo nextest run` + `bunx vite build` pass; session state parity in the real app.

---

#### Step 3: Convert SESSION_SIDEBAND (rewrap-preserving) {#step-3}

**Depends on:** #step-2

**Commit:** `tugcast(feeds): convert SESSION_SIDEBAND onto SessionScopedFeed`

**References:** [P14], [P19], Risk R05

**Artifacts:** SESSION_SIDEBAND on `SessionScopedFeed`, preserving the `system_metadata`/`session_capabilities`/`rate_limit` rewrap **and** the retained-slot replay on reconnect.

**Tasks:**
- [ ] Move the merger rewrap + `latest_metadata` retention behind the abstraction without changing wire behavior.

**Tests:**
- [ ] Unit: the three sideband types still publish; retained slot replays on a fresh subscribe.

**Checkpoint:**
- [ ] `cargo nextest run` passes; metadata/capabilities/rate-limit still arrive and replay-on-reconnect intact (`verify`).

---

#### Step 4: Convert CODE_OUTPUT (replay + input-ownership) {#step-4}

**Depends on:** #step-3

**Commit:** `tugcast(feeds): convert CODE_OUTPUT onto SessionScopedFeed`

**References:** [P14], [P19], Risk R04, (#r04-code-output-conversion)

**Artifacts:** CODE_OUTPUT on `SessionScopedFeed`, preserving the shared `ReplayBuffer`, cross-session broadcast, merger fan-in, and `CODE_INPUT` `InputOwnership`.

**Tasks:**
- [ ] Move splice + replay buffer + fan-in behind the abstraction; keep input-ownership keying intact.

**Tests:**
- [ ] Unit: two sessions' frames stay isolated; a lagging client gets a replay bracket.

**Checkpoint:**
- [ ] `cargo nextest run` passes.
- [ ] Real app: two concurrent sessions stay isolated; a forced lag recovers via replay ([R04]).

---

#### Step 5: Route STATS registration; foundation checkpoint {#step-5}

**Depends on:** #step-1, #step-2, #step-3, #step-4

**Commit:** `tugcast(feeds): route STATS through unified registration; assert no raw bypass`

**References:** [P19] (StatCollector kept distinct), (#success-criteria)

**Tasks:**
- [ ] Route the STATS aggregate + individual feeds through the unified snapshot registration (StatCollector model unchanged).
- [ ] Grep-assert no server→client feed pushes a raw `broadcast::Sender` outside the abstraction, modulo the two named [P19] exemptions (CONTROL; the FILETREE/GIT_DIFF response fan-in senders).

**Tests:**
- [ ] Aggregate: all pre-existing feeds behave identically (Part A is behavior-neutral).

**Checkpoint:**
- [ ] `cargo nextest run` + `bunx vite build`; full app smoke (`just app-test`) — no feed regressions.

---

#### Step 6: `FeedId::ACTIVITY` as a native SessionScopedFeed {#step-6}

**Depends on:** #step-2

**Commit:** `tugcast(data-display): ACTIVITY feed (0x42) as a native SessionScopedFeed`

**References:** [P16] byte, [P14], [P17] transport, Spec S02

**Artifacts:** `FeedId::ACTIVITY = 0x42` (Rust + `name()` + test; TS mirror); `feeds/activity/mod.rs` producer registered as a `SessionScopedFeed` (empty until Steps 8/12 feed it).

**Tasks:**
- [ ] Add the byte both sides; register the feed with `Warn` lag policy.

**Tests:**
- [ ] Rust byte-assertion test passes (mirror in sync).

**Checkpoint:**
- [ ] `cargo nextest run` + `bunx vite build` pass.

---

#### Step 7: tugcast divert `activity_delta` → ACTIVITY {#step-7}

**Depends on:** #step-6

**Commit:** `tugcast(data-display): divert activity_delta onto the ACTIVITY feed`

**References:** [P13], [P15], Spec S02, (#data-flow)

**Artifacts:** a `merger_task` branch that recognizes `type=="activity_delta"`, splices `tug_session_id`, re-tags `FeedId::ACTIVITY`, and diverts (not copies) it off CODE_OUTPUT. Ordered **before** the tugcode emitter (#step-8) deliberately: the divert is a harmless no-op until the producer exists, whereas the reverse order would leak transitional `activity_delta` frames onto CODE_OUTPUT and into the shared ReplayBuffer.

**Tasks:**
- [ ] Add the divert branch using the payload inspector, mirroring the sideband rewrap.

**Tests:**
- [ ] Unit: an `activity_delta` line lands on ACTIVITY, session-tagged, and never on CODE_OUTPUT (fed a synthetic line — the live producer arrives in #step-8).

**Checkpoint:**
- [ ] `cargo nextest run` passes.

---

#### Step 8: tugcode `activity_delta` (single interpreter) {#step-8}

**Depends on:** #step-7

**Commit:** `tugcode(data-display): emit activity_delta from dispatchEventToTurn`

**References:** [P13] single interpreter, [P06], [P07], [P21] parity, [Q06] flush, Spec S04

**Artifacts:** `ActivityDelta` interface + `OutboundMessage` member; per-turn activity bins on `ActiveTurn`; a 250 ms `SessionManager` flush (turn-scoped, trailing flush on turn end) emitting behind `!turn.suppressEmit`. With the divert (#step-7) already live, no `activity_delta` ever rides CODE_OUTPUT.

**Precondition (landed):** the lane-partition fix (`ade430a1f`) keys `ActiveTurn` stream state by `parent_tool_use_id ?? null`, so `msg_id` stamping is lane-correct — build the accumulator on the lane structure (channel split from the lane key; token deltas per lane-correct `msg_id`), and base the counting fixtures on `lane-partition-interleave.test.ts`'s interleaved sequences.

**Tasks:**
- [ ] Relocate the counting (Spec S04) into `dispatchEventToTurn`; accumulate in `ActiveTurn`.
- [ ] Add the flush timer ([Q06]); emit `activity_delta`.

**Tests:**
- [ ] Unit (tugcode): captured claude stream-json fixtures (Write / skill / AskUserQuestion turns) fed through `dispatchEventToTurn` → expected per-channel units ([P21], Spec S04).
- [ ] Unit: no `activity_delta` emitted while `suppressEmit` (replay-safe).

**Checkpoint:**
- [ ] tugcode rebuilt; `bun test` passes.
- [ ] Real app: a raw `ACTIVITY` dump shows per-session samples during a live turn (model-on-the-wire criterion).

---

#### Step 9: Deck store consumes ACTIVITY; delete deck derivation {#step-9}

**Depends on:** #step-8

**Commit:** `tugdeck(data-display): SessionActivityStore consumes ACTIVITY; remove throughput derivation`

**References:** [P01], [P02], [P13], [P21], Spec S01, Spec S02

**Artifacts:** `activity-meter.ts` (rate/gauge), `session-activity-store.ts`, `parseActivityFrame`; app-scoped `subscribeSessionFeed(ACTIVITY)` → `store.record`; `DevPulseStrip` reads `compositeSeries`. **Delete** `recordThroughput`/`throughputMeter`/constants/maps/`ThroughputMeter`.

**Tasks:**
- [ ] Build the meter + store; subscribe; `clearSession` on close.
- [ ] Point the strip at the store; delete deck derivation entirely.

**Tests:**
- [ ] Unit: meter rate sums the window; gauge sample-and-holds across empty bins within its TTL and decays to zero after it; store record/series/composite.

**Checkpoint:**
- [ ] `bunx vite build` + `bun test`; grep confirms no `throughputMeter`/`recordThroughput`.
- [ ] Real app: Write-turn parity **and** `/tugplug:vet` + a post-`AskUserQuestion` resume drive the line (`verify`).

---

#### Step 10: Compact: dominant color + composite intensity {#step-10}

**Depends on:** #step-9

**Commit:** `tugdeck(data-display): dominant-hued fill + composite intensity`

**References:** [P04], [P05], (#state-zone-mapping)

**Artifacts:** `TugSparkline.getColorChannel` stamps `data-activity-channel`; strip passes `dominant`; hue tokens in all themes.

**Tasks:**
- [ ] Color hook + `dominant()` hysteresis; hue tokens; `audit:theme-contrast`.

**Tests:**
- [ ] Unit: hysteresis holds through a single-sample challenger.

**Checkpoint:**
- [ ] `bunx vite build` + `audit:theme-contrast`; color differs across thinking vs writing, no strobing (`verify`).

---

#### Step 11: Retain `(pid, start_time)` per session {#step-11}

<!-- No dependencies: PID capture touches agent_bridge/agent_supervisor, not the
     registration API — it can proceed in parallel with Part A. -->

**Commit:** `tugcast(data-display): retain tugcode child (pid, start_time) per session`

**References:** [P08], [P20] reuse-guard, Risk R02

**Artifacts:** capture `child.id()` + start time at spawn into `SessionEntry`; clear on close; accessor for the sampler.

**Tasks:**
- [ ] Capture and store `(pid, start_time)`; expose the accessor; clear on teardown.

**Tests:**
- [ ] Unit: a reused PID with a different start time is rejected (not attributed).

**Checkpoint:**
- [ ] `cargo nextest run` passes.

---

#### Step 12: OS subtree sampler → CPU/memory into ACTIVITY {#step-12}

**Depends on:** #step-9, #step-11

**Commit:** `tugcast(data-display): per-session subtree CPU/memory into ACTIVITY`

**References:** [P08], [P09], [P10], [P20], [Q02] budget, Risk R01, Spec S02

**Artifacts:** `feeds/activity/resource.rs` — one shared `System`, refresh-all + `parent()` subtree walk gated to sessions with a validated live PID; sum `cpu_usage()`/`memory()`; emit gauges on ACTIVITY via the activity producer.

**Tasks:**
- [ ] Subtree walk with `(pid,start_time)` validation ([P20]); emit `cpu_pct`/`rss_bytes` gauges.
- [ ] Spike [Q02]: 3 concurrent builds; enforce ≤2%/core budget; lock cadence.

**Tests:**
- [ ] Unit: subtree sum over a constructed parent map; dead/mismatched root ⇒ zero.

**Checkpoint:**
- [ ] `cargo nextest run` + `bunx vite build`; sampler self-CPU within budget.
- [ ] Real app: a `cargo build` session shows a CPU hump absent from a second idle same-dir session (`verify`).

---

#### Step 13: Disk I/O via `proc_pid_rusage` {#step-13}

**Depends on:** #step-12

**Commit:** `tugcast(data-display): session disk-I/O via proc_pid_rusage`

**References:** [P11], [P02] gauge, [Q03], Spec S02

**Artifacts:** `#[cfg(macos)]` `proc_pid_rusage(RUSAGE_INFO_V2)` binding; subtree disk bytes differenced to bytes/sec gauges; deck `disk` descriptor.

**Tasks:**
- [ ] Add the binding + per-tick differencing; emit disk gauges; deck records `disk`.

**Tests:**
- [ ] Unit (macos): monotonic counters; non-negative differencing.

**Checkpoint:**
- [ ] `cargo nextest run` + `bunx vite build`; a large-write Bash step shows a disk hump (`verify`).

---

#### Step 14: Pulse labels: skills, AskUserQuestion, generic {#step-14}

**Commit:** `tugcode(data-display): pulse labels for skills, AskUserQuestion, generic tools`

**References:** [P07], (#context)

**Artifacts:** `voice.ts` cases for `AskUserQuestion`, `<plugin>:<skill>`, and a generic non-file tool fallback.

**Tasks:**
- [ ] Map the labels; confirm/extend `PULSE_FORWARD_ALLOWLIST`.

**Tests:**
- [ ] Unit (tugcode): non-empty `PulseLine` for a skill, an AskUserQuestion, and an arbitrary tool.

**Checkpoint:**
- [ ] tugcode rebuilt; `/tugplug:vet` shows a label other than "None".

---

#### Step 15: Expanded Activity card {#step-15}

**Depends on:** #step-9, #step-12

**Commit:** `tugdeck(data-display): expanded Activity card over the activity API`

**References:** [P12], [P04], Spec S01

**Artifacts:** `activity-card.tsx` — per-channel labeled `TugSparkline` + `raw` readout, hued per descriptor, bound to the dev card's session. Surface: a **popover off the Z2 PULSE strip** ([P12] Surface), reusing the `PerAreaPopoverFrame` vocabulary of the TIME/TOKENS/CONTEXT telemetry popovers — NOT a registered deck card or a sheet.

**Tasks:**
- [ ] Small-multiples popover content; hang it off the PULSE strip's popover (a second surface/trigger); reuse Tug components + `PerAreaPopoverFrame`; membership via `useSyncExternalStore` on the activity store's snapshot; rows from `channels(session)`, lines from `series`/`compositeSeries`, readout from `raw`.

**Tests:**
- [ ] Unit: `channels(session)` drives the row set.

**Checkpoint:**
- [ ] `bunx vite build`; live per-channel lines during a mixed turn (`verify`).

---

#### Step 16: Integration checkpoint {#step-16}

**Depends on:** #step-5, #step-10, #step-13, #step-14, #step-15

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #data-flow, #tugcast-usage)

**Tasks:**
- [ ] Confirm every feed registers through the abstraction (no raw bypass).
- [ ] Confirm one interpreter (no deck activity math), model-on-wire, two-session + PID-reuse isolation, CODE_OUTPUT replay recovery.

**Tests:**
- [ ] Aggregate real-app run: skill, AskUserQuestion, Bash build, Write — compact strip + Activity card + raw ACTIVITY dump.

**Checkpoint:**
- [ ] `cargo nextest run` + `bunx vite build && bun test`; all #success-criteria verified (`just app-test` / `verify`).

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A trait-mediated tugcast feed layer (dead-trait debt paid, `SessionScopedFeed` carrying every per-session feed) hosting a unified `ACTIVITY` feed — derived by tugcode alone, routed by tugcast, consumed by a pure-consumer deck — that drives a lively, color-coded compact sparkline and an expanded Activity card with session-scoped, PID-reuse-safe CPU/memory/disk.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] No server→client feed bypasses the trait abstraction (grep-clean; activity producers publish only through `SessionScopedFeed`).
- [x] Exactly one activity interpreter (tugcode); deck derivation deleted (grep-clean of `throughputMeter`/`recordThroughput`).
- [ ] Activity model visible on the `ACTIVITY` wire feed. *(interactive: raw ACTIVITY dump during a live turn — user vet on the debug build.)*
- [ ] Skills / AskUserQuestion / thinking / subagents move the sparkline; dominant color shifts without strobing. *(interactive/visual — user vet; hysteresis unit-tested.)*
- [~] Bash build shows CPU (+ macOS disk) humps isolated to the session; reused PIDs rejected. *(PID-reuse guard + subtree isolation unit-tested; the visible hump is a user vet.)*
- [x] `CODE_OUTPUT` post-conversion isolates sessions and recovers a lagging client (Step 4 checkpoint, still green in the workspace suite).
- [ ] Activity card renders live per-channel over the same store. *(interactive/visual — user vet; `channels()` row-set unit-tested.)*
- [x] `cargo nextest run` (1084), `bunx vite build`, `bun test` (deck 3884 + tugcode 719), `audit:theme-contrast` pass.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Overlaid stacked-band Activity card rendering ([P12]).
- [ ] App-wide "all sessions" overview ([Q04]).
- [ ] Linux per-process disk I/O ([Q03]).
- [ ] Root the subtree at the claude PID if bridge overhead proves material ([P08]).
- [ ] Optional capped in-memory `ACTIVITY` tail for reconnect hydration if fresh-start proves jarring ([P15]).

| Checkpoint | Verification |
|------------|--------------|
| Debt paid | Step 5: no raw feed bypass; behavior-neutral |
| One interpreter | Step 9: no deck activity math; parity + flatlines fixed |
| Model on the wire | Step 8: raw ACTIVITY dump |
| Isolation safe | Step 12: two same-dir sessions; PID-reuse rejected |
| Refactor safe | Step 4: CODE_OUTPUT isolation + replay recovery |
