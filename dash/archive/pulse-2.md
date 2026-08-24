<!-- devise-skeleton v4 -->

## PULSE 2 — Watch the Wire {#pulse-2}

**Purpose:** Rebuild PULSE's data path so the commentator sees the real game: the
daemon consumes session-tagged CODE_OUTPUT frames directly — typed shapes, real
excerpts, true outcomes — instead of hand-phrased note-card facts, with per-session
beats and a deterministic substance gate so the model is never asked to narrate
thin air.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-12 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

PULSE shipped end to end (`dash/pulse.md`, joined at `0e878632`) and the live
walk condemned its data path. The commentator fabricated twice ("tokei unavailable"
while tokei visibly succeeded) because the producer layer — a `writeLine` observer
pattern-matching outbound IPC shapes into one-line note-card facts — silently
delivered starved beats. The forensic root cause is now pinned: the producer read
`message.name` where the wire carries `tool_name`, so **no ordinary tool call ever
produced a fact**, and its tests passed because they fed the same imagined shape
(fixed on main at `cd9a21df`, but the bug *class* survives as long as an untyped
observer hand-rolls the wire). Two structural flaws compounded it: speak-pressure
was applied blindly to starved beats, and the global beat scheduler stamped
mixed-session beats with the scope union, so one card could wear another session's
line.

The lesson, user-confirmed: **every lossy hand-off invites fiction**. The fix is to
delete the hand-offs. tugcast already broadcasts every session's full output on one
channel (`code_tx`, the CODE_OUTPUT broadcast every per-session frame flows through
at the supervisor's merger), and `splice_tug_session_id` stamps every line with its
session id before the merger — so a session-tagged, complete, *typed* view of the
game already exists one `subscribe()` away from where the pulse bridge sits in
`main.rs`. The daemon is a tugcode-codebase sibling: it can import the
`OutboundMessage` types and parse the frames natively, turning shape drift into a
compile error.

One enrichment was validated against real session JSONLs: `assistant_text` frames
carry the assistant's own interstitial narration (median ~96 chars — "Checking
it", "adding it for conformance", stated intent and reversals), the best
commentary signal on the whole wire. `thinking_text` was measured worthless on the
same corpus: 8,911 thinking blocks across 8 recent sessions, zero non-empty
(protected thinking never reaches the wire).

#### Strategy {#strategy}

- **Delete the producer layer, tap the canonical wire.** `pulse-facts.ts`, the
  `ipc.setOutboundObserver` tap, and the relay's `pulse_fact` divert all go; the
  pulse bridge subscribes to the CODE_OUTPUT broadcast and forwards an allowlisted,
  already-session-tagged subset to the daemon. No second protocol to drift.
- **Typed frames in the daemon.** The daemon narrows `msg.type` against the real
  tugcode interfaces; the `tool_name`-vs-`name` bug class becomes a compile error.
- **Per-scope beats.** One pending queue per session; every ask covers exactly one
  session; attribution is by construction, not by stamping.
- **Deterministic substance gate.** A beat reaches the model only if it holds at
  least one trigger event (tool outcome, task, job, error, turn boundary).
  Assistant text enriches a beat; it never triggers one.
- **Voice before plumbing, again.** The digest format and prompt change shape
  (single-scope beats, real excerpts, "assistant says" line) — re-spike them
  against live Haiku with the existing probe harness before rewiring anything.
- **Keep everything that worked.** Daemon posture, sequence-paired driver, ledger +
  CONTROL tail + PULSE feed, deck store/strip/per-card filter, tugbank toggle,
  one-way isolation: all unchanged.

#### Success Criteria (Measurable) {#success-criteria}

- Live walk: PULSE lines narrate real tool activity with real specifics (file
  names, commands, outcomes from the frames), and every claim in every line is
  traceable to digest content — zero fabricated availability/outcome claims across
  the walk. (Live walk + per-beat stderr digest logging.)
- Two concurrent session cards each show only their own lines (or none) — no line
  about session A ever appears on session B's strip. (Live walk with two cards;
  `latestLineForScope` unchanged.)
- Starved input never reaches the model: beats without a trigger event are gated
  deterministically, visible in stderr diagnostics as `gated` (never `PASS`-by-
  model on empty substance). (Stdio test + live stderr.)
- A deck reload / session reconnect re-narrates nothing — replayed history is muted
  bridge-side before the daemon ever sees it. (Rust bridge test + live reload.)
- The daemon, fed a scripted wire-frame fixture over stdin with the fake claude
  child, emits well-formed single-scope pulse lines and emits nothing for gated
  beats — deterministic shape/discipline assertions. (bun stdio test.)
- `cargo nextest run`, `bun test` (tugcode + tugdeck), and both typechecks green at
  every step boundary.

#### Scope {#scope}

1. tugcast pulse bridge rework: CODE_OUTPUT tap (subscribe + allowlist +
   per-session replay mute + lag drop) replacing the `pulse_fact` divert.
2. `tugpulse` daemon rework: typed wire-frame intake, per-scope digest state with
   real excerpts, per-scope scheduler with substance gate and round-robin, digest
   v6 + prompt v6.
3. Deletions: `pulse-facts.ts` + tests, the outbound observer, the relay divert and
   its plumbing, the `PULSE_FACT` feed id (Rust + deck).
4. Voice re-spike pinning digest v6 / prompt v6 (recorded in the spike README).
5. `tuglaws/design-decisions.md` D103 amendment.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Cross-session "ambience" lines (`app`-scoped weaving) — per-scope beats make
  every v2 line single-session; app-scoped commentary can return later as an
  explicit feature on the same wire.
- Non-Claude-Code producers (tugexec shell, external assistants) — see [P05]: the
  route-agnostic `pulse_fact` contract retires with this plan; future routes get
  their own tap + digester when they're real.
- Deck changes beyond the `PULSE_FACT` constant removal — the store, strip,
  per-card filter, and toggle ship as-is from pulse v1.
- Tone configuration, direct-API engine, Shelf/Rack productionization (unchanged
  deferrals from `dash/pulse.md`).

#### Dependencies / Prerequisites {#dependencies}

- PULSE v1 on main (`0e878632` + `cd9a21df`): bridge, ledger, CONTROL tail, feed,
  daemon shell, deck store/strip, D103.
- The CODE_OUTPUT broadcast (`code_tx` in `main.rs`; merger forward in
  `agent_supervisor.rs`) and `splice_tug_session_id` (`feeds/code.rs`) stamping
  `tug_session_id` as the first field of every line.
- `payload_inspector.rs` single-pass `msg_type` extraction (the bridge's allowlist
  check).
- The voice-spike harness (`v2.1.173-pulse-spike/probes/probe-pulse-voice.mjs`) for
  the digest/prompt re-spike.
- claude CLI ≥ 2.1.173 authenticated (daemon posture unchanged).

#### Constraints {#constraints}

- bun only; tugcode/tugpulse are compiled binaries (no HMR; rebuild via `just`);
  tugdeck is HMR. Rust warnings are errors (`cargo nextest run`).
- Commentary never backpressures work: the tap drops on broadcast `Lagged`, the
  bridge keeps `try_send`-style non-blocking semantics toward the daemon, and the
  one-way isolation invariant ([D103]) holds — nothing the daemon produces enters
  any work session's context.
- No fake-DOM or mock-store tests; daemon fixtures must use the **real** wire
  shapes from `tugcode/src/types.ts` (the v1 tests passed on imagined shapes —
  never again).

#### Assumptions {#assumptions}

- The CODE_OUTPUT broadcast carries every frame the daemon needs, already
  session-spliced; subscribing adds one receiver to an existing channel and no
  load to the relay path. (Verified by reading `merger_task` and
  `splice_tug_session_id`.)
- `assistant_text` volume is digestible: deltas are small and per-turn text totals
  a few KB; with per-block clipping and a per-digest budget it cannot crowd out
  events. (Measured on real session JSONLs; budgets pinned in [P04]/Spec S03.)
- Haiku can keep interleaved single-scope beats straight when each digest is
  tagged with its scope — the Step 1 spike's two-scope arc verifies under the v6
  format.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings (kebab-case, no phase numbers), stable
two-digit labels (`[P01]` plan-local decisions — never `[D##]`, which cites the
global `tuglaws/design-decisions.md`; `[Q01]` questions; `Spec S01`; `List L01`;
`Risk R01`), `**Depends on:**` lines holding `#step-N` anchor refs, and rich
`**References:**` lines on every execution step. Never cite line numbers.

---

### Amendment: the deterministic ticker {#amendment-ticker}

The live walks falsified the commentator concept itself, not just its data
path: spoken often it restated the visible transcript; spoken rarely it was
unpredictable. After eight voices (history: spike README v6–v8 entries) the
user chose the **deterministic ticker**: `pulse/ticker.ts` replaces
intake/scheduler/digest/driver/posture — pure rules over the same typed wire
frames (current call, elapsed refreshes, failures/recoveries always, jobs,
API-retry stride, per-turn summary; ~1.5s routine throttle, priority bypass).
Everything else in this plan ships as built: the CODE_OUTPUT tap + allowlist
+ replay mute (Spec S01) feeds the ticker unchanged; ledger, PULSE feed,
CONTROL tail, deck store/strip/per-card filter/clear-on-submit are
untouched. [P03]'s substance gate and [P02]'s per-scope beats survive in
spirit — the ticker is per-scope and silent without events — and the
fabrication risk class is gone entirely (no model in the loop). D103
re-amended accordingly.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Digest v6 rendering + prompt v6 voice quality (OPEN) {#q01-digest-v6}

**Question:** With single-scope beats, real event excerpts, and an "assistant
says" line, what exact rendering (ordering, excerpt budgets, error-output
inclusion) and prompt revision produce specific, truthful, non-repeating lines —
and does Haiku keep two interleaved sessions' narrative threads straight across
its conversation memory?

**Why it matters:** The digest format and prompt are the voice; v1 burned five
prompt iterations learning that these can only be judged against live Haiku.
Per-session thread separation is new: the model's anti-repetition memory now spans
scopes, and a line for session B must not be suppressed because a similar line ran
for session A.

**Plan to resolve:** Step 1 re-spike with the existing probe harness: scripted v6
digests (single-scope arc, two interleaved scopes, error/recovery arc,
assistant-text-rich beats), iterate, record as v6 in the spike README (#step-1).

**Resolution:** RESOLVED by the #step-1 re-spike (`v2.1.173-pulse-spike/README.md`
§ v6): three iterations (v6.0 → v6.2 → v6.4) pinned the format and prompt.
Thread separation holds (the trap beat speaks); character limits had to be
reframed as a word limit ("at most SIXTEEN WORDS" — Haiku cannot count
characters; over-length went 7/18 → 0–1/18 with the daemon's 110 clip covering
the marginal case); session tags had to be banned twice (plus "say what landed,
not who finished" for turn-complete beats); the API-retry event needed
self-disambiguating phrasing ("the assistant's connection to its AI model is
retrying" — the terse form was misattributed to the session's own subject).
`assistant says` clip budget pinned at **240 chars**. Latency under the
unchanged posture: p50 ~830–920ms, max 2.3s across three 18-beat runs, zero
beats over the 4s stale window.

#### [Q02] Assistant-text harvest discipline (DECIDED) {#q02-text-harvest}

**Question:** When and how does accumulated `assistant_text` enter a digest
without repeating across beats or drowning the events?

**Resolution:** DECIDED in-plan, see [P04]: beat-time harvest with a per-scope
high-water mark — each dispatched beat carries only text accumulated since that
scope's previous dispatched beat, whitespace-collapsed and clipped to the digest
budget. No block-end detection needed; deltas accumulate keyed on
`(msg_id, block_index)` exactly like the deck reducer. Exact clip budget pinned by
the #step-1 spike within the [P04] bounds.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Prompt/digest v6 regresses the voice (bland, repetitive, or confused) | high | med | Step 1 live spike before plumbing; PASS escape retained; per-scope thread tagging | Live-walk lines a template could produce, or cross-thread confusion |
| Assistant text drowns events or invites echoing | med | med | Harvest high-water mark + hard clip ([P04]); prompt rule: text is context for *why*, events are the *what*; spike iteration | Lines quoting the assistant verbatim instead of narrating |
| Replay floods reach the daemon on reconnect | med | low | Bridge-side mute set keyed on spliced `tug_session_id` between `replay_started`/`replay_complete`; Rust test | Re-narrated history on deck reload |
| Multiple `tool_result` frames per call (`tool_progress` maps to the same type) skew outcomes/durations | low | med | First-result-wins rule in the digest state (Spec S02) | Phantom repeat ordinals or wrong durations in digests |
| Broadcast lag under heavy multi-session load drops frames mid-turn | low | low | `Lagged` → log + continue (commentary, never backpressure); digest state tolerates orphan `tool_result` (no matching open call → ignore) | stderr lag warnings during normal use |

**Risk R01: The truth guarantee leaks at the dispatcher** {#r01-truth-leak}

- **Risk:** Some execution-relevant frame type is missing from the allowlist (or a
  shape narrows wrong), and starved digests return — the exact v1 failure in a new
  coat.
- **Mitigation:**
  - The allowlist (List L01) was derived from the full `OutboundMessage` union
    read against real session content, not imagined.
  - Typed narrowing: the daemon imports the real interfaces; a field mismatch is a
    compile error, not a silent early-return.
  - The substance gate fails *closed*: a starved beat is gated, never asked — the
    model cannot fabricate from a vacuum because it is never handed one.
  - Per-beat stderr diagnostics name the event counts per digest; a starved-but-
    active session is visible in one log read.
- **Residual risk:** New tugcode frame types added later won't auto-join the
  allowlist; the List L01 doc comment tells future editors where to look.

---

### Design Decisions {#design-decisions}

#### [P01] Watch the wire: the daemon consumes spliced CODE_OUTPUT frames (DECIDED) {#p01-watch-the-wire}

**Decision:** The pulse bridge subscribes to the existing CODE_OUTPUT broadcast
(`code_tx`) and forwards allowlisted frames — raw spliced JSON lines, already
carrying `tug_session_id` as their first field — to the daemon's stdin. The
producer layer (`pulse-facts.ts`, the `ipc.setOutboundObserver` tap, the
`pulse_fact` relay divert and all its plumbing) is deleted. The daemon parses the
frames with the real `OutboundMessage` types (it lives in the tugcode codebase and
imports them directly).

**Rationale:**
- The v1 fabrications were manufactured by lossy hand-offs: an untyped observer
  pattern-matched an imagined shape (`name` vs the wire's `tool_name`), silently
  starved the model, and speak-pressure filled the vacuum with fiction. The wire
  view is complete, session-tagged, and *typed* — shape drift becomes `tsc`'s
  problem, not a live-walk forensic hunt.
- The tap is one `subscribe()` on a channel the bridge construction site in
  `main.rs` already holds; per-session relays and tugcode are untouched on the hot
  path (the flip *removes* relay code).
- One protocol. `pulse_fact` was a second wire dialect that had to mirror the
  first; mirrors drift.

**Implications:**
- The bridge gains a select arm (broadcast recv → allowlist check via
  `payload_inspector` `msg_type` → mute check → forward); `PulseFactSender`, the
  relay divert, `is_pulse_fact_line`, `set_pulse_fact_tx`, and the `PULSE_FACT`
  feed id all go.
- Replay muting moves bridge-side (Spec S01) so reconnect floods never cross the
  pipe.
- The daemon's stdin contract changes from `pulse_fact` lines to spliced wire
  frames (Spec S02); the fake-claude stdio test feeds real frame shapes.

#### [P02] Per-scope beats; one ask covers exactly one session (DECIDED) {#p02-per-scope-beats}

**Decision:** The scheduler keeps one pending queue per scope (`tug_session_id`).
Coalescing and the substance gate apply per scope; the minimum beat interval and
the single-in-flight bound stay **global** (one model, one conversation).
Eligible scopes are served round-robin. Every emitted `PulseLine` carries
`scopes: [<the one scope>]`.

**Rationale:**
- v1 stamped mixed beats with the scope union, so card B could wear a line about
  A — the live walk caught it immediately. Attribution by construction beats
  attribution by stamping.
- Single-scope digests are also simpler for Haiku: no weaving instruction, just
  "this beat is session [a1b2]".

**Implications:**
- `BeatScheduler` reworks into a multi-scope structure (Spec S04); the digest
  drops scope-grouping; the prompt drops the weave rule and gains per-thread
  separation rules ([Q01]).
- The wire `PulseLine.scopes` stays an array (deck contract unchanged); v2 always
  emits one element. `latestLineForScope` works as-is.

#### [P03] Deterministic substance gate before the model (DECIDED) {#p03-substance-gate}

**Decision:** A scope's pending beat is ask-eligible only if it contains at least
one **trigger event**: a completed tool call, a task transition, a background-job
transition, an error/retry, or a turn boundary (`turn_complete`/`turn_cancelled`).
Accumulated assistant text never triggers and never counts; idle or text-only
accumulation is silently held for the next triggered beat.

**Rationale:**
- "Is there anything to say?" is a deterministic question and belongs before the
  model — v1 delegated it to a speak-pressured Haiku staring at starved digests,
  and got fiction.
- Turn boundaries guarantee a prose-only turn still narrates once, carrying its
  text.

**Implications:**
- The gate is pure logic in the scheduler — fake-clock testable. stderr
  diagnostics distinguish `gated` (never sent) from `PASS` (model declined) from
  `line`.

#### [P04] assistant_text enriches digests; thinking_text is excluded (DECIDED) {#p04-assistant-text}

**Decision:** The daemon accumulates `assistant_text` deltas per scope keyed on
`(msg_id, block_index)` (the deck reducer's exact rule), and each dispatched beat
harvests only the text accumulated since that scope's previous dispatched beat
(high-water mark), whitespace-collapsed and clipped to a per-digest budget (spike
pins the exact figure; hard bounds: ≥120, ≤500 chars). `thinking_text` is not
forwarded at all.

**Rationale:**
- Measured on real session JSONLs: interstitial assistant texts (median ~96 chars)
  are self-narrated intent, approach, and reversals — written by the strongest
  model in the loop. With them, Haiku compresses stated intent instead of
  inferring it from bare tool lists, and *cannot* fabricate intent because intent
  arrives as text. This also replaces v1's `context:` line: the commentator infers
  the goal from the work (user decision).
- Measured on the same corpus: 8,911 thinking blocks across 8 recent sessions,
  zero non-empty — protected thinking never reaches the wire. Nothing to include.

**Implications:**
- The high-water mark prevents cross-beat repetition; the clip prevents the final
  long summary (observed max ~7K chars) from drowning a digest.
- `assistant_text` is on the forward allowlist (high-frequency small deltas; a few
  KB per turn over a local pipe — negligible).

#### [P05] PULSE narrows to the Claude Code route; the pulse_fact contract retires (DECIDED) {#p05-route-narrowing}

**Decision:** The route-agnostic `pulse_fact` contract ([P01] of
`dash/pulse.md`) is retired. PULSE v2 is coupled to tugcode's wire format by
design. Future routes (tugexec shell, external assistants) integrate, when real,
via their own tap + digester — not by reviving the note-card envelope.

**Rationale:**
- Generality was the *cause* of the lossy hand-off: a narrator that must stay dumb
  about every route can only eat pre-chewed prose, and pre-chewing is where the
  truth thinned out. A truthful Claude-Code-only PULSE beats a general one that
  lies.
- The expensive assets — daemon posture, beat discipline, ledger/feed/strip — are
  route-independent and survive for any future producer.

**Implications:**
- `PULSE_FACT` (0x81) is removed from both protocol constant sets; tugcode's
  `PulseFactEvent` type and union entry go.
- The D103 entry is amended to describe the wire-tap architecture (#step-5).

#### [P06] Everything that worked ships unchanged (DECIDED) {#p06-keep-what-works}

**Decision:** No changes to: the daemon posture (exact `claude-haiku-4-5`, default
permission mode + full `--disallowedTools`, `--setting-sources ""`,
`MAX_THINKING_TOKENS=0`, auth-env scrub), the sequence-paired `HaikuDriver` and its
~100-beat restart/seed mechanism, the ledger cap + `list_pulse_lines` CONTROL tail,
the PULSE feed (0x80), the deck `pulse-store` + strip + `latestLineForScope`
per-card filter, the tugbank `dev.tugtool.pulse/enabled` toggle semantics (lazy
spawn, teardown on disable, respawn throttle), and one-way isolation.

**Rationale:** Each was pinned by spike measurement or survived the live walk; the
rethink is the data path, not the engine or the surface.

**Implications:** The deck slice of this plan is one constant removal; `tugdeck`
tests should pass untouched except `protocol.ts` references.

---

### Specification {#specification}

**Spec S01: Bridge tap contract** {#s01-bridge-tap}

```text
PulseBridgeConfig gains: code_tx: broadcast::Sender<Frame>   // subscribed inside the task
The bridge task adds one select arm:

  frame = code_rx.recv():
    Err(Lagged(n))  -> warn!(skipped = n); continue          // drop, never backpressure
    Err(Closed)     -> disable the arm (daemon idles; facts can no longer arrive)
    Ok(frame)       ->
      inspected = InspectedPayload::from_slice(&frame.payload)
      msg_type  = inspected.msg_type
      session   = inspected.tug_session_id          // new additive field, see below
      if msg_type == "replay_started":  mute.insert(session); continue
      if msg_type == "replay_complete": mute.remove(session); continue
      if msg_type not in ALLOWLIST (List L01): continue
      if mute.contains(session): continue
      <existing lazy-spawn path: enabled() check, throttle, seed, spawn>
      write frame.payload + '\n' to daemon stdin (write failure -> daemon marked dead)
```

The `fact_rx` mpsc channel, `PulseFactSender`, and `is_pulse_fact_line` are
deleted; enabled/teardown/respawn/seed semantics transfer verbatim to the new arm.
The daemon receives the spliced payload **unmodified** — its first field is
`tug_session_id`.

`InspectedPayload` does not currently capture the spliced session id; it gains an
**additive** field — `#[serde(default)] pub tug_session_id: Option<String>` — which
is zero-risk for the existing dispatcher/merger callers (the deserializer already
ignores unknown top-level fields, and `None` on un-spliced payloads is handled by
the bridge as "no session → not mutable, forward if allowlisted").

**List L01: The forward allowlist** {#l01-allowlist}

Forwarded to the daemon: `tool_use`, `tool_result`, `assistant_text`,
`turn_complete`, `turn_cancelled`, `task_started`, `task_updated`, `api_retry`,
`error`. Consumed bridge-side as mute brackets, never forwarded:
`replay_started`, `replay_complete`. Everything else (streaming deltas other than
assistant text, `thinking_text` per [P04], metadata/cost/usage frames,
capabilities, inventories) is dropped at the bridge. The list lives as one Rust
const with a doc comment pointing at `tugcode/src/types.ts`'s `OutboundMessage`
union as the upstream vocabulary.

**Spec S02: Daemon intake and per-scope digest state** {#s02-intake}

Stdin lines parse as `{ tug_session_id: string } & OutboundMessage` using the real
types from `tugcode/src/types.ts` (the daemon is a tugcode sibling — direct
import, typed narrowing on `msg.type`; unknown/malformed lines are dropped with a
stderr note). Per scope, a `ScopeDigestState` accumulates between dispatched
beats:

- `tool_use` → open-call map `tool_use_id → { tool_name, input, openedAt }`
  (`openedAt` = daemon arrival clock).
- `tool_result` → **first result wins** per `tool_use_id` (later
  `tool_progress`-sourced duplicates ignored); closes the open call into a
  completed event `{ tool_name, input, is_error, output, elapsedMs }`. Orphan
  results (no open call — daemon started mid-turn) are ignored.
- `assistant_text` → accumulation keyed `(msg_id, block_index)` under the deck
  reducer's full rule: `is_partial: true` **appends** the delta, `is_partial:
  false` **replaces** the block (the synthetic / slash-command paths emit complete
  blocks); harvest per [P04]'s high-water rule at beat build.
- `task_started` / `task_updated` → job events (description retained for the
  terminal flip, as v1 did).
- `api_retry` → retry events, source-throttled (attempt 1, then every 5th — v1's
  stride rule, now daemon-side).
- `error` → error events (`message`, `recoverable`).
- `turn_complete` / `turn_cancelled` → turn-boundary events (`result` excerpt).

Trigger counting per [P03] rides the same accumulation. Event lists are bounded
(newest kept) by the scheduler caps in Spec S04. Scope state is swept on
inactivity: a scope with no frames and no pending beat for ~30 minutes is dropped
(checked at the beat-poll cadence) — session count is bounded in practice, but the
sweep makes the bound explicit rather than accidental.

**Spec S03: Digest v6 rendering** {#s03-digest-v6}

Single scope per digest. Shape (exact wording pinned by the #step-1 spike):

```text
BEAT <n> [a1b2]
assistant says: "<harvested text, clipped per [P04]>"        (omitted when empty)
- <tool_name><hint> — ok|failed (<Ns>) (<k>th time this turn)
- <tool_name><hint> — failed: <output excerpt ≤120ch>        (errors carry output)
- background job <status>: <description>
- task added/marked: <subject/status>
- API retry <n>/<max>: <error excerpt>
- turn complete: <result excerpt> | turn cancelled
```

Hints come from the real `input` (file basename, clipped command/pattern — v1's
`toolHint` logic survives, now fed by typed frames). Repeat ordinals count
completed same-shape calls per turn (v1 rule). Error events always include a
clipped real output excerpt — outcomes must be quotable, not summarized.

**Spec S04: Scheduler v2 discipline** {#s04-scheduler-v2}

Per scope: coalesce window (anchor = first trigger event's arrival), pending event
bound (oldest dropped, drop count surfaced), substance gate ([P03]). Global:
minimum interval between dispatches, single in-flight ask, stale-drop on replies
(all v1 constants and env overrides — `TUGPULSE_COALESCE_MS` etc. — carry over).
Selection: among gate-passing scopes whose coalesce window has closed, round-robin
from a rotating cursor. Every method takes explicit wall-clock ms (fake-clock
testable, as v1). The dispatched beat is `{ id, scope, events, harvestedText }`.

**Spec S05: Deletions inventory** {#s05-deletions}

| Delete | Where |
|--------|-------|
| `pulse-facts.ts` + `__tests__/pulse-facts.test.ts` | tugcode |
| `setOutboundObserver` + observer slot + `writeLine` hook | `tugcode/src/ipc.ts` |
| `pulseFacts` field, constructor wiring, `onTurnStart` hook | `tugcode/src/session.ts` |
| `PulseFactEvent` interface + `OutboundMessage` union entry | `tugcode/src/types.ts` |
| `pulse_fact` divert block + `pulse_fact_tx` params (both fns) | `tugcast feeds/agent_bridge.rs` |
| `pulse_fact_tx` field + `set_pulse_fact_tx` + test call-site args | `tugcast feeds/agent_supervisor.rs` |
| `is_pulse_fact_line` + its test; `PulseFactSender`; `fact_rx` channel | `tugcast feeds/pulse.rs` |
| `PULSE_FACT = 0x81` const + name | `tugcast-core protocol.rs`, `tugdeck/src/protocol.ts` |

(`PulseFact`/`isPulseFact` and the v1 scheduler/digest API are deleted earlier, in
#step-3's swap — see that step; this table is #step-4's flip inventory.)

**Spec S06: Prompt v6 contract** {#s06-prompt-v6}

Properties fixed here, exact text iterated in #step-1: subject is the execution
(v4's re-aim, unchanged); the digest is the only source of truth (v5's rule,
unchanged); **new** — each beat concerns exactly one session named by its tag;
treat sessions as separate narrative threads (never-repeat applies within a
thread; a line is not redundant because a *different* session's line said
something similar); the `assistant says` text explains *why*, the event lines are
the *what* — never quote or echo the assistant's text verbatim; speak-by-default
with PASS escape; one plain line, ≤110 chars; present tense; specifics over
restatement. The weave-two-scopes rule from v5 is removed.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

No new deck state. The pulse-store ([L02]), strip fade ([L06]), and mount
discipline ([L26]) ship unchanged from `dash/pulse.md`'s mapping; this plan's
only deck edit is removing the `PULSE_FACT` constant from `protocol.ts`.

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| (none added) | — | deck unchanged except a protocol constant removal | [L02]/[L06]/[L26] upheld as shipped |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugcode/src/pulse/intake.ts` | typed wire-frame parse + `ScopeDigestState` (open calls, completed events, text accumulation/harvest) per Spec S02 |
| `tugcode/src/pulse/__tests__/intake.test.ts` | typed-fixture tests for Spec S02 (real frame shapes) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `PULSE_FORWARD_ALLOWLIST` | const | `tugcast feeds/pulse.rs` | List L01; doc comment names the upstream union |
| `PulseBridgeConfig.code_tx` | field | `tugcast feeds/pulse.rs` | replaces the fact mpsc; subscribed in-task (Spec S01) |
| replay mute set | local | `tugcast feeds/pulse.rs` | `HashSet<String>` keyed on spliced `tug_session_id` |
| `InspectedPayload.tug_session_id` | field | `tugcast feeds/payload_inspector.rs` | additive `#[serde(default)]` capture of the spliced id (Spec S01) |
| `MultiScopeScheduler` | class | `tugcode/src/pulse/scheduler.ts` | Spec S04; **added beside** `BeatScheduler` in #step-2, swap + old-API deletion in #step-3 |
| `buildScopeDigest` | fn | `tugcode/src/pulse/digest.ts` | Spec S03 single-scope rendering; added beside v1's `buildDigest`/`beatScopes` in #step-2, which die in #step-3 |
| `PULSE_SYSTEM_PROMPT` (v6) | const | `tugcode/src/pulse/posture.ts` | Spec S06; pinned by #step-1 |
| stdin intake (rework) | fn | `tugcode/src/pulse/main-pulse.ts` | wire frames → intake → scheduler; `gated` stderr diagnostic added |
| stdio/scheduler/digest tests (rework) | tests | `tugcode/src/pulse/__tests__/` | wire-frame fixtures; gated-beat assertions |
| deletions | — | per Spec S05 | exhaustive table above |

---

### Documentation Plan {#documentation-plan}

- [ ] Spike README (`v2.1.173-pulse-spike/README.md`): v6 entry — digest format,
      prompt text verbatim, two-scope thread-separation findings (#step-1).
- [ ] `tuglaws/design-decisions.md`: amend D103 — wire-tap architecture, per-scope
      beats, substance gate, assistant-text enrichment, `pulse_fact` retirement
      ([P05]) (#step-5).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (pure-logic bun:test)** | intake state machine (typed fixtures: open/close calls, first-result-wins, orphan results, text high-water harvest), scheduler v2 (fake clock: per-scope coalesce, global interval, gate, round-robin, stale-drop, caps), digest v6 rendering, line shaping (unchanged) | daemon modules |
| **Stdio integration (bun:test)** | daemon fed scripted **wire-frame** lines (spliced shapes from `types.ts`) + fake-claude child: single-scope lines out, gated beats emit nothing, two scopes round-robin | `tugpulse` |
| **Rust (cargo nextest)** | bridge tap: allowlisted frame → daemon stdin; non-allowlisted dropped; replay-bracket mute; `Lagged` tolerated; disabled-toggle gating (existing tests adapted to the new arm) | tugcast |
| **Live spike (not CI)** | digest v6 / prompt v6 voice quality, per-thread separation, real latency under the unchanged posture | Step 1 + final walk |

#### What stays out of tests {#test-non-goals}

- Prose quality of model output — spike- and live-walk-judged, never CI-asserted.
- Fake-DOM/RTL and mock-store tests — banned; the deck is untouched anyway.
- Imagined wire shapes — the v1 producer's tests passed on a fabricated field;
  every daemon fixture in this plan is written against the `types.ts` interfaces
  (and spot-checked against the spike's captured raw session where applicable).

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step below.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Voice re-spike: digest v6 + prompt v6 | done | 05c062db |
| #step-2 | Daemon core: intake, scheduler v2, digest v6 | done | bd06756b |
| #step-3 | Daemon wiring: wire-frame stdin + stdio tests | done | 57b9e98e |
| #step-4 | The wire flip: tugcast tap + producer deletion | done | 482e1148 |
| #step-5 | Amend D103 | done | 0c7d9809 |
| #step-6 | Integration checkpoint | in progress | iterate rounds: v7 voice 1dc2a949+2d912c89, v8 voice 163c42a9, then the commentator was RETIRED for a deterministic ticker (user decision on the walk) — see #amendment-ticker |

#### Step 1: Voice re-spike — digest v6 + prompt v6 {#step-1}

**Commit:** `Pin pulse digest v6 and prompt v6 in the voice spike`

**References:** [Q01], [P02], [P03], [P04], Spec S03, Spec S06, Risk R01,
(#q01-digest-v6, #s03-digest-v6, #s06-prompt-v6)

**Artifacts:**
- `v2.1.173-pulse-spike/probes/probe-pulse-voice.mjs` updated: v6 prompt, scripted
  v6 digests (single-scope arc with real-shaped excerpts; two interleaved scopes
  alternating beats; an error/recovery arc with quoted output excerpts; beats rich
  in `assistant says` text; a thread-separation trap — similar events in both
  scopes, judging whether scope B still gets its line).
- Spike README v6 entry: final digest rendering, prompt verbatim, harvest clip
  budget chosen within [P04]'s bounds, thread-separation findings, latency
  spot-check under the unchanged posture.

**Tasks:**
- [ ] Write the v6 digest fixtures by hand from real frame shapes (`types.ts` +
      the captured raw session), not imagination.
- [ ] Iterate prompt v6 until lines are specific, truthful, ≤110 chars,
      non-repeating *within* a thread, and not cross-thread-suppressed.
- [ ] Pin the `assistant says` clip budget and the digest's exact wording.
- [ ] Record everything in the README; mark [Q01] resolved in this plan.

**Tests:**
- [ ] N/A — live spike; outputs become Spec S03/S06 constants and the stdio
      test's fake-claude reply shapes.

**Checkpoint:**
- [ ] README v6 entry committed with verbatim prompt + digest format + clip
      budget; [Q01] resolution recorded in this plan

---

#### Step 2: Daemon core — intake, scheduler v2, digest v6 {#step-2}

**Depends on:** #step-1

**Commit:** `Rework tugpulse core for typed wire-frame digests`

**References:** [P02], [P03], [P04], Spec S02, Spec S03, Spec S04, Spec S06,
(#s02-intake, #s04-scheduler-v2, #symbol-inventory)

**Artifacts:**
- `pulse/intake.ts`: typed parse of `{tug_session_id} & OutboundMessage` lines +
  `ScopeDigestState` per Spec S02 (open calls, first-result-wins, orphan-result
  tolerance, text accumulation with append/replace + high-water harvest, retry
  stride, trigger counting, inactivity sweep).
- `pulse/scheduler.ts`: `MultiScopeScheduler` per Spec S04, **added beside**
  `BeatScheduler`.
- `pulse/digest.ts`: `buildScopeDigest`, the v6 single-scope renderer per Spec
  S03, **added beside** v1's `buildDigest`/`beatScopes` (absorbing the
  `toolHint`/`clip`/`ordinal` phrasing helpers from the doomed producer where
  they fit).
- `pulse/posture.ts`: `PULSE_SYSTEM_PROMPT` v6 from the spike (safe in place — no
  test pins the prompt text).
- Unit tests for all of the above (typed fixtures, fake clock).

**Tasks:**
- [ ] **Strictly additive**: `BeatScheduler`, `buildDigest`/`beatScopes`,
      `PulseFact`/`isPulseFact`, and their tests remain untouched so
      `main-pulse.ts` (reworked in #step-3) still compiles and this commit's
      checkpoint stays green.
- [ ] Import frame types from `../types.ts`; no hand-rolled shapes anywhere.
- [ ] Keep all v1 timing constants and `TUGPULSE_*` env overrides.
- [ ] Surface drop/gate counts for the stderr diagnostics (#step-3).

**Tests:**
- [ ] Intake: open→close with duration; first-result-wins under a duplicate;
      orphan result ignored; text append on `is_partial: true` and replace on
      `is_partial: false`; harvest yields only since-last-beat text, clipped;
      trigger counts per [P03]; inactive scope swept, active scope retained.
- [ ] Scheduler: per-scope coalesce; global min-interval across scopes; gate holds
      text-only accumulation; round-robin alternates two eligible scopes; stale
      reply dropped; caps respected; idle silent.
- [ ] Digest: renders the Spec S03 shape from a populated state; error events
      carry output excerpts; `assistant says` omitted when empty.

**Checkpoint:**
- [ ] `cd tugcode && bun test src/pulse && bunx tsc --noEmit`

---

#### Step 3: Daemon wiring — wire-frame stdin + stdio tests {#step-3}

**Depends on:** #step-2

**Commit:** `Drive tugpulse from spliced wire frames end to end`

**References:** [P01], [P02], [P03], Spec S02, Spec S04, (#s02-intake,
#success-criteria)

**Artifacts:**
- `pulse/main-pulse.ts`: stdin → typed intake → per-scope scheduler → digest v6 →
  driver → shaped line → stdout, with `scopes: [beat.scope]`; per-beat stderr
  diagnostic now distinguishes `gated` / `PASS` / `timeout` / `line Nch` and names
  the event count; `--seed`/`--claude-path`/env handling unchanged.
- **The v1 API dies here**: `BeatScheduler`, `buildDigest`/`beatScopes`,
  `PulseFact`/`isPulseFact` (`pulse/types.ts` keeps `PulseLine` only), and their
  tests are deleted in the same commit as the swap — nothing imports them after
  `main-pulse.ts` moves over.
- Reworked `__tests__/stdio.test.ts` + fixture: scripted spliced wire-frame lines
  (two sessions interleaved, an error arc, a text-only stretch) against
  `fake-claude.mjs`.

**Tasks:**
- [ ] Keep shutdown/SIGTERM/stdin-EOF semantics and `driver.ts` untouched.
- [ ] Verify the fake-claude fixture still exercises sequence pairing (a timeout
      slot mid-run).
- [ ] After the swap, `grep -rn "BeatScheduler\|isPulseFact" tugcode/src` finds
      nothing.

**Tests:**
- [ ] Stdio: wire frames in → well-formed single-scope `pulse` lines out; a
      text-only stretch emits nothing (`gated` on stderr); two scopes produce
      alternating single-scope lines; PASS beats emit nothing.

**Checkpoint:**
- [ ] `cd tugcode && bun test && bunx tsc --noEmit`
- [ ] `just` tugpulse target builds; piping the wire-frame fixture through the
      binary with the fake child emits the expected lines

---

#### Step 4: The wire flip — tugcast tap + producer deletion {#step-4}

**Depends on:** #step-3

**Commit:** `Tap CODE_OUTPUT for pulse; retire the pulse_fact producer`

**References:** [P01], [P05], [P06], Spec S01, List L01, Spec S05, Risk R01,
(#s01-bridge-tap, #l01-allowlist, #s05-deletions)

**Artifacts:**
- `feeds/pulse.rs`: the Spec S01 tap arm (subscribe `code_tx`, List L01 allowlist
  via `payload_inspector`, replay mute set, `Lagged` drop), replacing the fact
  channel; lazy-spawn/enabled/teardown/throttle/seed semantics transferred
  verbatim; tests adapted (tap routing, allowlist filtering, mute brackets,
  disabled gating) on the existing duplex-pipe fake-spawner pattern.
- `main.rs`: pass `code_tx.clone()` into `PulseBridgeConfig`; `set_pulse_fact_tx`
  call removed.
- Every deletion in Spec S05, in the same commit — tugcode producer/observer/type,
  relay divert and plumbing, supervisor field/setter and test call sites,
  `PULSE_FACT` constants (Rust + deck `protocol.ts`).

**Tasks:**
- [ ] Single atomic flip: after this commit no `pulse_fact` is emitted, diverted,
      or typed anywhere in the tree (`grep -r pulse_fact` finds only the spike
      capture and plan/docs history).
- [ ] Confirm the deck builds with only the constant removal (store/strip
      untouched per [P06]).

**Tests:**
- [ ] Rust: allowlisted frame on the broadcast reaches daemon stdin; excluded
      types and muted-session frames do not; `replay_started`/`replay_complete`
      maintain the mute set; disabled toggle still drops + tears down; existing
      ledger/CONTROL tests untouched and green.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugcode && bun test && bunx tsc --noEmit`
- [ ] `cd tugdeck && bun test && bun run check`

---

#### Step 5: Amend D103 {#step-5}

**Depends on:** #step-4

**Commit:** `Amend D103 for the pulse wire-tap architecture`

**References:** [P01]–[P06], (#documentation-plan)

**Tasks:**
- [ ] Rewrite the D103 data-path paragraphs: CODE_OUTPUT tap + allowlist +
      bridge-side replay mute; typed daemon intake with real excerpts; per-scope
      beats + substance gate; assistant-text enrichment (and the measured
      thinking-text exclusion); `pulse_fact` contract retired per [P05]; cite
      `dash/pulse-2.md` alongside `dash/pulse.md`.

**Tests:**
- [ ] N/A — documentation only.

**Checkpoint:**
- [ ] Entry renders; cites both plans and the spike's v6 record

---

#### Step 6: Integration checkpoint {#step-6}

**Depends on:** #step-4, #step-5

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), [P02], [P03], Risk R01

**Tasks:**
- [ ] Live walk on a debug build: a real working session produces truthful,
      specific lines naming actual tools/files/outcomes; an induced tool failure
      is narrated with its real error; idle is silent; a prose-only turn narrates
      once at its boundary.
- [ ] Two concurrent cards: each strip shows only its own session's lines; the
      thread-separation trap from the spike holds live.
- [ ] Deck reload + session reconnect: nothing re-narrated (bridge mute);
      `list_pulse_lines` tail restores the strip.
- [ ] Toggle off: daemon torn down, strip hidden; toggle on: next activity
      respawns.
- [ ] stderr shows `gated` beats during text-only stretches; no orphan claude
      processes after instance shutdown.

**Tests:**
- [ ] Full suites: `cargo nextest run`, `bun test` (tugcode + tugdeck), both
      typechecks.

**Checkpoint:**
- [ ] All suites green; every live-walk task above verified

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** PULSE narrating from the real wire — session-tagged typed frames
in, per-session truthful one-liners out — with the fabrication-prone producer
layer deleted and every v1 asset that worked (posture, beat engine, ledger, feed,
strip) carried forward unchanged.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every #success-criteria item verified (live walk + suites).
- [ ] [Q01] resolved by the committed v6 spike; [Q02] decided in-plan and
      implemented per [P04].
- [ ] `pulse_fact` absent from the live tree (Spec S05 complete).
- [ ] D103 amendment landed.

**Acceptance tests:**
- [ ] Daemon intake/scheduler/digest/stdio suites (typed fixtures, gate, per-scope
      discipline — deterministic).
- [ ] tugcast bridge tap suite (allowlist, mute, lag, toggle).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] App-scoped ambience lines (cross-session weaving, explicit `app` scope).
- [ ] tugexec / external-route taps + digesters ([P05]'s future shape).
- [ ] Shelf/Rack productionization consuming the pulse log
      (`dash/z2-status-redesign.md`).
- [ ] Tone configuration; direct-API engine option.

| Checkpoint | Verification |
|------------|--------------|
| Voice v6 pinned | Step 1 spike README entry |
| Daemon discipline pinned | intake/scheduler/digest/stdio suites |
| Wire flip clean | `cargo nextest run` + grep shows no live `pulse_fact` |
| Real-app behavior | Step 6 live walk |
