<!-- devise-skeleton v4 -->

## PULSE — App-Wide Color Commentary {#pulse}

**Purpose:** Ship PULSE as a *general* facility: a route-agnostic fact stream carried
by tugcast, narrated by one persistent Haiku commentator process, displayed as a
one-line strip in the Z2 status area — with tugcode (the Claude Code route) as the
first fact producer and every future route (shell, other AI assistants) integrating
by emitting facts alone.

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

The Z2 STATE cell shows lifecycle ("Running tools") — the play-by-play. What's
missing is the **color commentator**: a brief, cheap, on-point side channel saying
what is *actually going on* ("Background tests came back green — popover wiring is
next"). The design was settled in discussion and prototyped visually in the
`gallery-z2-workshop` spike card (PULSE strip / lane / row item, scripted).

Three architectural facts shape the build:

1. **tugcast is the only component that sees every route and session.** It already
   spawns and supervises per-session tugcode subprocesses via `run_session_bridge` +
   the `ChildSpawner` abstraction (`feeds/agent_bridge.rs`), ferries their stdio to
   feeds, and persists session ledgers in SQLite (`feeds/agent_supervisor.rs`). The
   commentator must live *behind* tugcast, not inside any one route's bridge —
   otherwise PULSE is forever a Claude Code feature instead of an app feature.
2. **tugcode already owns the claude-subprocess machinery** (spawn args, stream-json
   driving, control handshake, drain loops). The commentator is a claude subprocess
   pinned to Haiku; a sibling entrypoint compiled from the tugcode codebase gets all
   of that for free.
3. **The deck's feed protocol is an open u8 namespace** (`tugdeck/src/protocol.ts`)
   with `0x80+` unallocated — room for `PULSE` / `PULSE_FACT` feeds.

The auth constraint is decisive for the engine choice: Tide users authenticate
through the claude CLI (often OAuth subscription, no API key), so the commentator
must be a claude CLI subprocess riding existing auth — not a direct API client.

#### Strategy {#strategy}

- **Contract first, producers forever.** One tiny route-agnostic `pulse_fact` frame;
  each route describes its own events in prose. Adding a route = emitting facts.
  Nothing downstream changes.
- **One commentator for the whole app.** A single Haiku session narrates all facts
  from all sources — which is also the cost story and what makes cross-source lines
  ("shell build green while Claude edits") possible at all.
- **Spike the voice before the plumbing.** The commentator's quality lives in its
  system prompt and beat discipline; pin those against a live Haiku session (latency,
  PASS behavior, multi-scope interleaving) before any wiring.
- **Build inside-out, each layer testable standalone:** daemon (pure stdio — pipe
  facts in, read lines out), then tugcast bridge + ledger, then tugcode facts, then
  the deck strip.
- **One-way isolation as an invariant:** commentator output flows deck-ward only;
  nothing it produces ever enters any work session's context.

#### Success Criteria (Measurable) {#success-criteria}

- In a live session, a turn produces PULSE lines within ~2–5s of notable events; the
  Z2 strip updates with specific, non-repeating commentary; idle is silent. (Live
  walk.)
- The daemon, fed a scripted fact file over stdin, emits well-formed pulse lines and
  `PASS`es uneventful beats — deterministically testable assertions on shape, length
  cap, and beat discipline (not on prose content). (bun tests + fixture.)
- A second concurrent session's facts interleave into the same narration with scope
  tags intact. (Fixture-driven daemon test + live walk with two cards.)
- Disabling via the tugbank default stops the daemon and hides the strip; enabling
  restores both without a tugcast restart being required for the *next* session.
  (Live walk.)
- A reconnecting deck fetches the recent pulse tail via the `list_pulse_lines`
  CONTROL round-trip and then stays live off the PULSE feed. (Rust test + live
  reload.)
- `cargo nextest run`, `bun test` (tugcode + tugdeck), and both typechecks green at
  every step boundary.

#### Scope {#scope}

1. The `pulse_fact` / `pulse` frame contract + `PULSE` (0x80) / `PULSE_FACT` (0x81)
   feed ids.
2. `tugpulse` — the commentator daemon (tugcode-codebase sibling binary): stdin
   facts → beats → Haiku → stdout pulse lines.
3. tugcast: app-scoped pulse bridge (spawn/supervise/restart the daemon), fact
   routing, SQLite pulse ledger (capped) with a `list_pulse_lines` CONTROL read,
   enable/disable via tugbank default.
4. tugcode as first producer: facts at turn boundaries, tool bursts, long-running
   thresholds, task/job transitions, errors.
5. tugdeck: a `pulse-store` + production Z2 **PULSE strip** under the status row;
   the gallery workshop card's strip flips from scripted to live.
6. `tuglaws/design-decisions.md` entry.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Shelf/Rack productionization (pinned lanes, configurable row) — separate plan; the
  strip is deliberately the only production surface here.
- tugexec/shell facts, Cursor/Gemini bridges — the contract is built for them; no
  producer beyond tugcode ships now.
- Per-card scope filtering UI — v1 strip shows the app-wide feed; pulse lines carry
  `scope` so filtering is a later display knob, not an architecture change.
- Commentator tone configuration UI — the prompt supports it; only the default tone
  ships.
- Direct Anthropic API engine (for API-key users) — config option later; CLI
  subprocess only now.

#### Dependencies / Prerequisites {#dependencies}

- claude CLI ≥ 2.1.173 installed and authenticated (the daemon rides its auth).
- tugcast's `ChildSpawner` / `run_session_bridge` pattern and SQLite ledger
  machinery (`session_ledger.rs`, `feeds/agent_supervisor.rs`).
- tugcode's claude-driving modules (spawn args, `control.ts`, drain).
- tugbank defaults (`/api/defaults/<domain>/<key>`) for the enable toggle.
- The `gallery-z2-workshop` card (visual target for the strip).

#### Constraints {#constraints}

- bun only; tugcode/tugpulse are compiled binaries (no HMR — rebuild via `just`);
  tugdeck is HMR. Rust: warnings are errors (`cargo nextest run`).
- No localStorage-family storage; the toggle lives in tugbank.
- Tuglaws for the deck slice: [L02], [L06], [L19], [L20], [L26]; no fake-DOM or
  mock-store tests.
- Haiku prompt-cache minimum prefix is 4096 tokens — caching engages only once the
  commentator's history passes it; below that, raw input on ~1–2K-token requests is
  still negligible ($1/MTok in, $5/MTok out).

#### Assumptions {#assumptions}

- A Haiku one-liner (~30 output tokens) generates in well under the stale-drop
  window (~4s) under normal conditions; the Step 1 spike measures it.
- ~~`--permission-mode plan` keeps the commentator text-only~~ — OVERTURNED by
  the Step 1 spike: plan mode permits read-only tools and the model used them.
  The pinned no-tools posture is default mode + full `--disallowedTools` +
  `--setting-sources ""` + `MAX_THINKING_TOKENS=0` (see [Q02] resolution).
- One app-scoped daemon is sufficient; per-session commentators are never needed
  (cross-source narration is the point).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Multi-scope beat handling (OPEN) {#q01-multi-scope}

**Question:** When one beat's digest carries facts from two scopes (two cards, or a
session + a future shell), does Haiku interleave them coherently in one line, or does
the digest need explicit scope grouping / per-scope beats?

**Why it matters:** Cross-source narration is the facility's distinguishing value;
if the model muddles scopes, the digest format (not the architecture) must change,
and that's cheapest to learn before the daemon is built.

**Plan to resolve:** Step 1 spike feeds scripted two-scope digests to a live Haiku
session and judges the lines (#step-1).

**Resolution:** RESOLVED by the #step-1 spike (`v2.1.173-pulse-spike/README.md`):
one digest with scope-tag grouping (`[a1b2]` headers, fact bullets) — Haiku weaves
two scopes coherently and unprompted; no per-scope beats needed.

#### [Q02] Minimal claude driving for the daemon (OPEN) {#q02-minimal-driving}

**Question:** Exactly which slice of tugcode's session machinery does the daemon
need — is `initialize` handshake + user-message send + assistant-text read
sufficient under plan mode, with no permission/control traffic ever arriving?

**Why it matters:** Decides whether `tugpulse` is a thin new driver reusing
`control.ts`/spawn-args modules or needs a trimmed `session.ts`. Affects step 2's
size.

**Plan to resolve:** The Step 1 probe IS this driver in miniature — whatever it
needed is what the daemon needs (#step-1). The monitor/jobs probes already
demonstrated init + send + read with zero control traffic under bypassPermissions.

**Resolution:** RESOLVED by the #step-1 spike (`v2.1.173-pulse-spike/README.md`):
a thin new driver — spawn args + auth scrub + newline-split stdout JSON + user
sends + **sequence-paired** result reads; zero control traffic observed. None of
`control.ts`/`session.ts` is needed. Posture correction: `--permission-mode plan`
was REJECTED (it permits read-only tools; the model ran Bash/Agent
"investigations") — the daemon uses default mode + full `--disallowedTools`,
`--setting-sources ""`, `MAX_THINKING_TOKENS=0`, and the exact model id
`claude-haiku-4-5` (the `haiku` alias silently fell back to sonnet).

#### [Q03] Per-card scope filtering and shelf integration (DEFERRED) {#q03-scope-filtering}

**Question:** Should a card's strip filter to its own scope, and how do pulse lines
land in the future shelf's PULSE lane?

**Resolution:** DEFERRED — display knobs on data this plan already provides
(`scope` rides every line). Belongs to the shelf/rack productionization plan.

#### [Q04] Non-tugcode producers (DEFERRED) {#q04-producers}

**Question:** What facts should tugexec and external-assistant bridges emit?

**Resolution:** DEFERRED by design — the contract ([P01]) is the integration
surface; each producer is its own small follow-on.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Commentary is bland or repetitive (the "Prestidigitating" trap) | high (kills the feature) | med | Step 1 prompt iteration against live output; PASS escape; persistent session sees its own prior lines; "never repeat" + specificity rules | Live-walk lines that a template could have produced |
| Stale lines describing a previous state | med | med | Single in-flight beat; ~4s stale-drop; coalesce-don't-queue | Lines landing after the state they describe has changed |
| Daemon lifecycle leaks (orphaned claude subprocess) | med | low | tugcast supervises like session bridges; kill-on-shutdown; the repo's zombie-sweep already hunts reparented claude processes | Orphans in `just instances` zombie sweep |
| Runaway cost on a chatty session | low | low | Debounce + per-turn beat cap + Haiku pricing (~$0.10–0.15/heavy hour); kill switch | User-visible usage complaints |
| Commentator context growth | low | med | Restart every ~100 beats with one-line carryover; re-seed from ledger tail | Beat latency creeping up |

**Risk R01: The voice fails** {#r01-voice}

- **Risk:** The lines read as filler — information-free, hype, or echoing the STATE
  cell — and PULSE becomes noise users disable.
- **Mitigation:**
  - Step 1 is *dedicated* to the voice: real Haiku, scripted realistic digests,
    iterate the system prompt until lines are specific and non-repeating.
  - The PASS contract lets the model decline a beat instead of manufacturing one.
  - Facts are producer-written prose with specifics (files, commands, counts) — the
    model can only be as concrete as its input, so the contract enforces concreteness
    upstream.
- **Residual risk:** Taste; the strip's kill switch and the deferred tone config are
  the safety valves.

---

### Design Decisions {#design-decisions}

#### [P01] The pulse fact contract — prose facts in a tiny envelope (DECIDED) {#p01-fact-contract}

**Decision:** Producers emit `pulse_fact` frames:
`{ source, scope, kind, fact, at }` where `fact` is **one plain-language sentence
written by the producer** and the envelope exists for routing/filtering/weighting.
The commentator consumes facts only — never raw transcripts, file contents, or any
route's native protocol.

**Rationale:**
- Each route knows best how to describe its own events; the narrator stays dumb and
  route-agnostic. Integrating a new tool or assistant = implementing exactly one
  thing.
- Digest-only input is simultaneously the cost control (~100–200 tokens/beat) and
  the altitude control: a commentator that can't see keystrokes can't narrate them.

**Implications:**
- TS types in tugcode (producer + daemon) and a Rust-side recognizer in tugcast;
  `kind` vocabulary starts small (`turn`, `tool`, `task`, `job`, `error`, `note`)
  and is open.

#### [P02] tugcast is the bus, the ledger, and the supervisor (DECIDED) {#p02-tugcast-bus}

**Decision:** tugcast routes `pulse_fact` frames from all producers to the daemon's
stdin and broadcasts the daemon's `pulse` lines on a new `PULSE` feed (`0x80`;
`PULSE_FACT` = `0x81`); persists a capped pulse ledger in its SQLite and replays the
tail on deck bind; spawns/supervises the daemon app-scoped via the existing
`ChildSpawner`/bridge pattern, lazily on first fact when enabled.

**Rationale:**
- tugcast is the only all-routes, all-sessions vantage point; it already does each
  of these three jobs in another form (bridges, ledgers, supervision).
- The rejected alternative — the daemon subscribing to raw feeds and understanding
  every route — couples the narrator to every protocol forever.

**Implications:**
- tugcode's stdout `pulse_fact` lines arrive inside its session bridge; the divert
  rides the existing payload-inspection mechanism — `payload_inspector.rs` already
  single-pass-parses CODE_OUTPUT payloads' `msg_type` for the supervisor's
  dispatcher and merger intercepts, so recognizing `"pulse_fact"` and routing to
  the pulse bridge instead of deck broadcast extends a live code path, not a
  pattern.
- Enable/disable: tugcast serves `/api/defaults` itself (via `TugbankClient`), so
  consulting `pulse/enabled` at daemon spawn is a direct read; flipping it takes
  effect at the next spawn opportunity.
- The ledger tail is served by a `list_pulse_lines` CONTROL verb ([P09]), not feed
  replay.

#### [P03] The daemon is a tugcode-codebase sibling pinned to Haiku (DECIDED) {#p03-daemon}

**Decision:** `tugpulse` — a thin entrypoint in the tugcode codebase, bun-compiled
like tugcode — drives one persistent `claude --model haiku` stream-json subprocess
(`claude-haiku-4-5`), text-only (`--permission-mode plan`, no tool use), reusing
tugcode's spawn-args/control/drain modules per [Q02]'s resolution.

**Rationale:**
- Rides the user's existing CLI auth — the decisive constraint (OAuth subscription
  users have no API key for a direct client).
- Persistence buys a warm prompt cache, conversation continuity (the model sees its
  own prior lines — the anti-repetition mechanism), and no per-beat spawn cost.
- One app-scoped commentator: one Haiku session total, and the only design that can
  narrate across sources.

**Implications:**
- Stdio contract with tugcast: `pulse_fact` JSON lines in; `pulse` JSON lines out —
  which makes the daemon fully testable by piping a fact file through it.
- Context bound: self-restart of the *inner* claude session every ~100 beats with a
  one-line carryover.

#### [P04] Beat discipline: event-driven, coalescing, stale-dropping, PASS (DECIDED) {#p04-beats}

**Decision:** The daemon coalesces incoming facts and fires a beat at most every
~5–8s while facts are flowing, one beat in flight at a time; a beat whose reply
hasn't arrived within ~4s is dropped, not queued; a hard per-burst cap bounds chatty
periods; the system prompt's `PASS` escape lets the model decline uneventful beats
(a `PASS` emits nothing). Idle is silent.

**Rationale:**
- A late line describing a previous state is worse than no line; queued beats
  guarantee staleness.
- PASS is the antidote to manufactured content — the failure mode of every status
  line.

**Implications:**
- The daemon's scheduler is pure logic — unit-testable with a fake clock and
  scripted fact streams, no model in the loop.

#### [P05] One-way isolation (DECIDED) {#p05-isolation}

**Decision:** Commentator output flows only deck-ward (daemon → tugcast → ledger +
PULSE feed). No pulse line, digest, or daemon artifact ever enters any work
session's context.

**Rationale:** The narrator must not bias the game it narrates; structurally
enforced is better than promised.

**Implications:** No code path from the pulse bridge into any session bridge's
stdin; nothing to test beyond its absence — upheld by review.

#### [P06] On by default, tugbank kill switch (DECIDED) {#p06-default-on}

**Decision:** PULSE is enabled by default; `pulse/enabled` in tugbank defaults turns
it off. (User decision, this session: signature ambient feature, negligible cost.)

**Implications:** tugcast consults the default before spawning the daemon and the
deck hides the strip when disabled (the PULSE feed simply carries nothing).

#### [P07] tugcode is the first producer; the contract is the integration surface (DECIDED) {#p07-first-producer}

**Decision:** V1 ships facts from tugcode only — turn start (request preview), first
tool burst, long-running tool crossing ~10s, task-list and jobs-ledger transitions,
errors/retries, turn end — but through the general pipe end to end. tugexec and
external-assistant bridges integrate later by emitting facts; nothing downstream
changes.

**Implications:** tugcode hooks the same routing spots the jobs/wake forwarding
already uses; a `pulse-facts.ts` module owns phrasing so fact prose is testable.

#### [P08] V1 surface: the production Z2 strip (plus the live workshop card) (DECIDED) {#p08-strip-surface}

**Decision:** One production surface ships: a height-stable one-line PULSE strip
rendered beneath the Z2 status row in the dev card (the workshop spike's strip
design: `PULSE` endcap legend, italic line, fade-in on update), fed by an app-scoped
`pulse-store`. The gallery workshop card's strip flips from scripted to live data.
Shelf/Rack remain the configurability plan.

**Rationale:** The strip is the highest value-per-line surface in the whole design
(user-stated), and shipping it alone keeps this plan's deck slice small.

**Implications:** New `pulse-store.ts` (app-scoped external store, [L02]); strip
component + CSS pair ([L19]/[L20]); always-mounted once enabled ([L26]); fade
animation in CSS ([L06]).

#### [P09] Persistence: capped ledger, CONTROL-read tail (DECIDED) {#p09-ledger}

**Decision:** tugcast persists pulse lines in a capped SQLite table (~200 rows). The
deck reads the recent tail (~20) via a **CONTROL request/response pair** —
`list_pulse_lines` → `list_pulse_lines_ok` — sent by the pulse-store on mount, then
folds live `PULSE` frames thereafter. The daemon re-seeds its inner session from the
same tail (via `--seed`) after restarts.

**Rationale:** A reloaded deck shouldn't lose the narrative thread, and the
commentator shouldn't lose its memory across restarts — both are the same ledger.
Request/response over CONTROL is the codebase's established ledger-read shape — the
session-state-changes ledger works exactly this way (`list_session_state_changes` →
`_ok`, consumed by the deck's reader on mount). Feed-replay-on-bind would invent new
semantics (which client, rebind dedupe, ordering vs live frames) that the precedent
already answers.

---

### Specification {#specification}

**Spec S01: Wire shapes** {#s01-wire-shapes}

```jsonc
// PULSE_FACT (0x81): producer → tugcast → daemon stdin
{ "type": "pulse_fact",
  "source": "claude-code",          // open vocabulary: "shell", "cursor", …
  "scope": "<tug_session_id|app>",
  "kind": "turn|tool|task|job|error|note",
  "fact": "Edit reducer.ts (2nd edit this turn)",
  "at": 1781240000000 }

// PULSE (0x80): daemon stdout → tugcast → ledger + all decks
{ "type": "pulse",
  "text": "Tests went to a background shell; the reducer edit continues.",
  "scopes": ["<id>", ...],          // scopes the source beat covered
  "beat": 14,
  "at": 1781240003200 }
```

Both small enough to keep verbatim across layers; the daemon's digest format
(facts grouped per beat, scope-tagged per [Q01]) is internal to `tugpulse` and
pinned by the Step 1 spike.

**Spec S02: The commentator prompt contract** {#s02-prompt}

System prompt rules (exact text iterated in Step 1, properties fixed here): one
line ≤ ~110 chars; present tense; plain text only; name specifics (files, commands,
counts, durations); meaning over event-restatement; never repeat the previous
line's information; no filler/cheerleading; reply `PASS` when nothing is
noteworthy. Tone is a swappable preamble (only the default ships).

**Spec S03: Strip behavior** {#s03-strip}

Renders beneath the Z2 status row when PULSE is enabled; fixed single-line height
(reserved once shown — no layout shift per line); shows the newest line with the
fade-in treatment from the workshop card; empty state before the first line is a
dimmed placeholder, not collapsed chrome. AMENDED during integration: the strip
filters the app-wide log to the card's own session (`latestLineForScope` — own
scope, woven multi-scope, or `"app"` ambience); the original no-filter v1 put
another session's line on a brand-new card, rejected on the live walk. The
shelf-lane/row-item filtering knobs remain with [Q03].

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| pulse line log | external app state | new `pulse-store` fed by PULSE frames; read via `useSyncExternalStore` | [L02] |
| strip fade-in per line | appearance | CSS animation keyed on line identity | [L06] |
| strip visibility (enabled) | external config | tugbank-backed default surfaced through the store | [L02] |
| strip mount | structure | always mounted while enabled; only text changes | [L26] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.173-pulse-spike/` | Step 1 capture: probe + raw session + prompt/latency notes |
| `tugcode/src/pulse/main-pulse.ts` (+ supporting `tugcode/src/pulse/*.ts`) | the `tugpulse` daemon: fact intake, beat scheduler, Haiku driver, line emitter |
| `tugcode/src/pulse/__tests__/*.test.ts` | scheduler + digest + line-shape pure-logic tests |
| `tugcode/src/pulse-facts.ts` | tugcode producer: fact phrasing + emission hooks |
| `tugrust/crates/tugcast/src/feeds/pulse.rs` | pulse bridge: daemon spawn/supervise, fact routing, ledger, `list_pulse_lines` CONTROL verb |
| `tugdeck/src/lib/pulse-store.ts` (+ tests) | app-scoped pulse store ([L02]) |
| `tugdeck/src/components/tugways/cards/tide-pulse-strip.tsx/.css` | the production Z2 strip |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `FeedId.PULSE = 0x80`, `FeedId.PULSE_FACT = 0x81` | const | `tugdeck/src/protocol.ts` + tugcast feed constants | Spec S01 |
| `PulseFact`, `PulseLine` | type | tugcode types + deck decode | Spec S01 |
| fact-type divert in session bridge routing | edit | `tugrust/crates/tugcast/src/router.rs` / `feeds/agent_bridge.rs` | `pulse_fact` → pulse bridge, not deck broadcast ([P02]) |
| pulse ledger table + replay | edit | `tugrust/crates/tugcast/src/session_ledger.rs` or `feeds/pulse.rs` | capped ~200, tail replay ~20 ([P09]) |
| `just` build targets | edit | `justfile` | compile `tugpulse` alongside tugcode |
| dev-card status bar | edit | `tugdeck/src/components/tugways/cards/dev-card.tsx` (+ css) | strip mounts under the status row ([P08]) |
| workshop card strip | edit | `gallery-z2-workshop.tsx` | scripted strip can read live store when present (small, optional wiring) |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/design-decisions.md`: new decision entry for PULSE (contract, bus,
      daemon, isolation, default-on) + Z2 zone-table note for the strip row.
- [ ] Spike README in `v2.1.173-pulse-spike/` recording prompt iterations, measured
      latency, and the [Q01]/[Q02] resolutions.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (pure-logic bun:test)** | Beat scheduler (fake clock: debounce, coalesce, single-in-flight, stale-drop, caps), digest formatting, fact phrasing, line-shape validation (length cap, PASS suppression), pulse-store fold | daemon + tugcode + deck modules |
| **Stdio integration (bun:test)** | The daemon driven end-to-end with a scripted fact file and a **fake claude child** (a stub subprocess speaking stream-json) — asserts wiring without model nondeterminism | `tugpulse` |
| **Rust (cargo nextest)** | Pulse bridge routing, ledger cap + `list_pulse_lines` round-trip, enable-toggle gating | tugcast |
| **Live spike (not CI)** | Voice quality, real latency, multi-scope coherence against real Haiku | Step 1 + integration walk |

#### What stays out of tests {#test-non-goals}

- Prose quality of model output — judged in the spike and live walks, never asserted
  in CI (nondeterministic).
- Fake-DOM/RTL and mock-store assertion tests — banned, as always; strip visuals are
  verified in the running app.
- The claude CLI's own behavior — pinned by spike capture, not re-tested.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step below.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Voice spike: prompt, latency, multi-scope | done | 2f87460b |
| #step-2 | tugpulse daemon | done | b6918f5f |
| #step-3 | tugcast pulse bridge + ledger + feeds | done | 84ade96a |
| #step-4 | tugcode fact producer | done | 72872b40 |
| #step-5 | Deck: pulse store + Z2 strip | done | 90014325 |
| #step-6 | Document PULSE | done | cf71ec8f |
| #step-7 | Integration checkpoint | pending | — |

#### Step 1: Voice spike — prompt, latency, multi-scope {#step-1}

**Commit:** `Capture pulse commentator voice spike`

**References:** [Q01], [Q02], [P04], Spec S02, Risk R01, (#q01-multi-scope)

**Artifacts:**
- `v2.1.173-pulse-spike/` with: `probes/probe-pulse-voice.mjs` (persistent Haiku
  session driven with scripted digest beats — single-scope arc, a two-scope
  interleaved arc, and uneventful beats expecting PASS), the raw capture, and a
  README recording the final system prompt, per-beat latency measurements, and the
  [Q01]/[Q02] resolutions.

**Tasks:**
- [ ] Adapt the jobs/monitor probe harness: spawn `claude --model haiku
      --permission-mode plan` with the stream-json args; send the candidate system
      prompt (`--append-system-prompt`) and scripted digests as user messages.
- [ ] Iterate the prompt until lines are specific, ≤110 chars, non-repeating, and
      PASS fires on uneventful beats; record iterations in the README.
- [ ] Measure wall-clock per beat across ~20 beats; confirm the ~4s stale-drop
      window is comfortable.
- [ ] Two-scope arc: judge interleaving; pin the digest's scope-grouping format.
- [ ] Resolve [Q01]/[Q02] in this plan.

**Tests:**
- [ ] N/A — live spike; outputs become the daemon's prompt + digest constants and
      the fake-claude stub's reply shapes.

**Checkpoint:**
- [ ] Capture + README committed; README states the final prompt verbatim, the
      measured latency distribution, and both Q resolutions

---

#### Step 2: tugpulse daemon {#step-2}

**Depends on:** #step-1

**Commit:** `Add tugpulse commentator daemon`

**References:** [P03], [P04], [P05], Spec S01, Spec S02, (#p03-daemon, #p04-beats)

**Artifacts:**
- `tugcode/src/pulse/` — fact intake (stdin JSON lines), beat scheduler, digest
  builder, Haiku session driver (reusing spawn-args/control modules per [Q02]),
  line emitter (stdout `pulse` frames), inner-session restart with carryover;
  `main-pulse.ts` entry; `justfile` target compiling `tugpulse` beside tugcode.
- Pure-logic tests (scheduler with fake clock; digest format; line validation) +
  one stdio integration test with a fake claude child.

**Tasks:**
- [ ] Implement per [P04]'s discipline exactly: debounce window, coalescing,
      single in-flight, stale-drop, per-burst cap, PASS suppression, idle silence.
- [ ] Seed support: accept a `--seed` tail of prior lines (for [P09] re-seeding).
- [ ] Length-cap enforcement on output (clip defensively even if the model
      overruns).

**Tests:**
- [ ] Scheduler: fact bursts coalesce to one beat; second beat waits the window;
      stale reply dropped; cap respected; no beat while idle.
- [ ] Stdio: scripted facts in → well-formed `pulse` lines out (fake child);
      PASS beats emit nothing.

**Checkpoint:**
- [ ] `cd tugcode && bun test && bunx tsc --noEmit`
- [ ] `just <tugpulse build target>` produces the binary; piping a fact fixture
      through it with the fake child emits expected lines

---

#### Step 3: tugcast pulse bridge + ledger + feeds {#step-3}

**Depends on:** #step-2

**Commit:** `Route and persist pulse through tugcast`

**References:** [P02], [P06], [P09], Spec S01, (#p02-tugcast-bus)

**Artifacts:**
- `feeds/pulse.rs`: app-scoped daemon spawn/supervise (ChildSpawner pattern; lazy
  on first fact; respects the `pulse/enabled` tugbank default), fact routing into
  daemon stdin, `pulse` stdout lines → ledger + PULSE feed broadcast;
  restart-on-crash; kill-on-shutdown.
- `list_pulse_lines` → `list_pulse_lines_ok` CONTROL verb pair serving the ledger
  tail (the `list_session_state_changes` shape).
- `PULSE`/`PULSE_FACT` feed constants (Rust + `tugdeck/src/protocol.ts`).
- Session-bridge routing divert: a producer's `pulse_fact` stdout line routes to
  the pulse bridge, not deck broadcast (extends the `payload_inspector.rs`
  msg_type path).

**Tasks:**
- [ ] Ledger: capped table (~200), tail query (~20), `list_pulse_lines` CONTROL
      handler.
- [ ] Daemon seeding: pass the ledger tail via `--seed` at spawn.
- [ ] Toggle: consult the default at spawn opportunity; disabled → facts dropped,
      no daemon.

**Tests:**
- [ ] `cargo nextest run`: fact divert (pulse_fact never reaches deck feeds),
      ledger cap + tail query, `list_pulse_lines` round-trip, disabled-toggle
      gating (fake spawner — no child spawned).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] Manual: on a `just app-debug` instance, drive the bridge's spawn path with
      the daemon in its fake-child mode (from #step-2) fed by a fact fixture, and
      confirm a `pulse` frame reaches a connected deck's wire log and a
      `list_pulse_lines` request returns the same line from the ledger

---

#### Step 4: tugcode fact producer {#step-4}

**Depends on:** #step-3

**Commit:** `Emit pulse facts from the Claude Code route`

**References:** [P01], [P07], Spec S01, (#p07-first-producer)

**Artifacts:**
- `tugcode/src/pulse-facts.ts`: phrasing functions (pure, tested) + emission hooks
  at: turn start (request preview), first tool burst, long-running tool ≥ ~10s,
  task-list transitions, jobs-ledger transitions (launch/terminal), errors/retries,
  turn end (result summary). Emitted as `pulse_fact` lines on stdout.

**Tasks:**
- [ ] Hook the existing routing spots (the jobs/wake forwarding precedents);
      throttle at the source only where an event class is unbounded (tool calls);
      everything else is naturally sparse.
- [ ] Keep facts specific: file names from Edit/Write inputs, command text
      (truncated) from Bash, counts from task/jobs transitions.

**Tests:**
- [ ] Pure-logic: each phrasing function against representative event shapes
      (fixture-derived where available); emission gating (no facts when pulse
      stream absent — cheap no-op).

**Checkpoint:**
- [ ] `cd tugcode && bun test && bunx tsc --noEmit`; tugcode binary compiles

---

#### Step 5: Deck — pulse store + Z2 strip {#step-5}

**Depends on:** #step-3

**Commit:** `Show live PULSE strip under the Z2 status row`

**References:** [P08], Spec S03, (#state-zone-mapping, #s03-strip)

**Artifacts:**
- `pulse-store.ts`: app-scoped store that fetches the ledger tail on mount via
  the `list_pulse_lines` CONTROL round-trip (the `session-state-changes-reader`
  pattern), then folds live PULSE frames (rolling log, capped ~20;
  reference-stable snapshot; [L02]).
- `tide-pulse-strip.tsx/.css`: the workshop strip productionized — PULSE endcap
  legend, italic one-liner, fade-in keyed on line identity, fixed height,
  dimmed placeholder before the first line; mounted beneath the status row in the
  dev card; hidden entirely when the toggle is off.
- Workshop card: optional small wiring to render live lines when available.

**Tasks:**
- [ ] Read the `pulse/enabled` toggle deck-side through the existing tugbank
      defaults mechanism and surface it on the pulse-store snapshot — the strip's
      hidden-when-disabled state comes from the store, not an ad-hoc fetch.
- [ ] Cross-check tuglaws before the tugways edits; name the laws touched in the
      commit body.

**Tests:**
- [ ] Pure-logic: store fold (cap, ordering, identity stability); strip-side
      derivations if any.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bun run check`
- [ ] Visual: HMR/debug instance shows the strip updating during a live session

---

#### Step 6: Document PULSE {#step-6}

**Depends on:** #step-5

**Commit:** `Document the PULSE facility in design-decisions`

**References:** [P01]–[P09], (#documentation-plan)

**Tasks:**
- [ ] New global decision entry (contract, bus, daemon, beat discipline, isolation,
      default-on, ledger) citing this plan and the spike; Z2 zone-table note for
      the strip row.

**Tests:**
- [ ] N/A — documentation only.

**Checkpoint:**
- [ ] Entry renders, cites `dash/pulse.md` and the spike directory

---

#### Step 7: Integration checkpoint {#step-7}

**Depends on:** #step-4, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** (#success-criteria)

**Tasks:**
- [ ] Live walk on a debug build: run a real session; verify lines are timely,
      specific, non-repeating; idle silence; two concurrent cards interleave with
      scopes intact; toggle off stops daemon + hides strip; deck reload replays
      the tail.
- [ ] Verify no orphan claude processes after instance shutdown.

**Tests:**
- [ ] Full suites: `cargo nextest run`, `bun test` (tugcode + tugdeck), both
      typechecks.

**Checkpoint:**
- [ ] All suites green; live walk per Tasks

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** PULSE running end to end as a general facility — facts from the
Claude Code route flow through tugcast to one Haiku commentator whose lines land in
a persisted ledger and a live Z2 strip — with every future route one fact-emitter
away from joining the narration.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every #success-criteria item verified.
- [ ] [Q01]/[Q02] resolved by the committed spike; [Q03]/[Q04] explicitly deferred.
- [ ] Design-decisions entry landed.

**Acceptance tests:**
- [ ] Daemon scheduler + stdio suites (the beat discipline, deterministically).
- [ ] tugcast nextest suite (divert, ledger, replay, toggle).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] tugexec shell facts; external-assistant bridge facts ([Q04]).
- [ ] Shelf/Rack productionization consuming the pulse log as a lane ([Q03]).
- [ ] Tone configuration; per-card scope filtering; direct-API engine option.

| Checkpoint | Verification |
|------------|--------------|
| Voice pinned | Step 1 spike README (prompt + latency + PASS behavior) |
| Beat discipline pinned | daemon pure-logic + stdio suites |
| Bus + persistence pinned | `cargo nextest run` |
| Real-app behavior | Step 7 live walk |
