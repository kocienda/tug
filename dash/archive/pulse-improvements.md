<!-- devise-skeleton v4 -->

## PULSE Two-Level Display {#pulse-improvements}

**Purpose:** Join the two ends of the PULSE work that already exist — a local model that writes a standing session overview, and a design spike that decided how intent and activity should read — into one shipped two-level grammar: a headline-register INTENT over a muted ACTIVITY, rendered S1 (one line, headline first) on the session card and L1 (stacked) in the Lens.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | dash worktree |
| Last updated | 2026-07-27 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Two halves of this feature landed separately and have never met. The **backend half** shipped with `dash/local-model-bringup.md`: `tugrust/crates/tugcast/src/feeds/session_overview.rs` watches the CODE_OUTPUT broadcast, composes a digest from the session's own prompts (via `crate::scribe::session_prompts_since`) plus the shape of its recent tool use, sends that digest to the on-device model as a `summarize` task, and broadcasts the sentence that comes back as a PULSE frame with `kind: "overview"`. The deck folds it in `tugdeck/src/lib/pulse-store.ts` as a `PulseOverviewEntry` (latest-per-scope, never entering the rolling log or the history popover) and `SessionPulseStrip` renders it as a small muted second row *above* the live beat. The **design half** shipped as a gallery spike, `tugdeck/src/components/tugways/cards/gallery-pulse-display.tsx`, which locked three directions: intent written in headline register (newspaper rules — no articles, no needless words), **S1** for the session card (one line, headline bright and layout-pinned, `›` separator, activity trailing in muted small mono and ellipsizing first), and **L1** for the Lens (intent on its own line under the session name, activity + sparkline on a third).

Nothing connects them. The model still writes prose sentences, because `LocalModelPrompts.summarize` in `tugapp/Sources/LocalModelService.swift` asks for "ONE short line of at most 12 words… describe what the session is working on overall" — a description, not a headline — and the emitter's `MAX_HEADLINE_CHARS` budget is 110, which is prose length, not headline length. The card still renders the overview as a quiet row above the beat instead of as the bright leading run of one line. The Lens (`tugdeck/src/components/lens/sections/sessions-section.tsx`) never sees the overview at all — its `SessionRowContent` reads `latestLineForScope` only, so the Lens shows the beat and nothing above it. This plan closes all three gaps, in that order: contract, card, Lens.

#### Strategy {#strategy}

- **Fix the string before fixing the pixels.** Headline register is a property of what the model writes and what the emitter allows through; both are upstream of every renderer. The Rust normalizer and the Swift prompt land first so the card and Lens work is judged against real headlines rather than prose that happens to be short.
- **Belt before braces.** The deterministic normalizer lands *before* the prompt change, so the moment the model starts producing headlines there is already a pure function guaranteeing the register — and a weak local model that ignores the instruction still cannot put an article or a trailing period on the strip.
- **One headline slot, one source.** The strip stops rendering two different "intents". Per [P01] the headline is the session overview and nothing else; the commentator's per-line `intent` survives only as the history popover's grouping heading.
- **Ship the card, then the Lens.** S1 establishes the classes, the selection rule, and the copy format; L1 reuses all three. Doing them in one step would make the diff unreadable and the checkpoints unfalsifiable.
- **Every level stays optional.** No surface reserves a row or a run for a level that is absent. A deck with no local model must render exactly what it renders today minus nothing it had — this is [P12] of the bring-up plan restated, and `at0280-local-model-absent.test.ts` is its pin.
- **The live matrix resolves the numbers.** The headline character budget and the emitter cadence are tuning values, not design values. They ship at a defensible default and get their final answer from a real session in the integration checkpoint.

#### Success Criteria (Measurable) {#success-criteria}

- Every overview reaching the wire satisfies the register: no leading definite/indefinite article, no trailing period, no wrapping quotes, no leading "Working on"/"Trying to"-class filler, and length ≤ the budget in [P04]. Verified by `headline_register` unit tests in `session_overview.rs` over a fixture corpus that includes each violation.
- The session card renders one PULSE row, not two, whenever an overview exists: `[data-slot="session-pulse-overview"]` never resolves, and the strip's measured `getBoundingClientRect().height` is 34 both with an overview and without one. (Note the strip's root element *is* the beat row after [P02], so a child count says nothing — height is the falsifiable form.) Verified by the app-test in [#step-5](#step-5).
- With a long activity string and a short headline, the headline is never the truncated run: its rendered `scrollWidth` equals its `clientWidth` while the activity's does not. Verified by the app-test in [#step-5](#step-5).
- With the declined selection written to tugbank (`dev.tugtool.local-model/model = ""`), no headline element exists in the card **or** the Lens row — not empty, absent. Verified by the updated `at0280-local-model-absent.test.ts`, which gains a Lens half in [#step-4](#step-4) (today it has none — it never opens the Lens).
- A Lens session row with an overview renders three lines; the same row without one renders two. Verified by the app-test in [#step-5](#step-5).
- On a live session with a downloaded model, ten consecutive observed headlines are all in register and all recognizably about the session's actual work. Verified by the owner in [#step-6](#step-6).

#### Scope {#scope}

1. Rewrite the `summarize` task prompt in `tugapp/Sources/LocalModelService.swift` to specify headline register, and retune `summarizeMaxTokens` to the new length.
2. Add a deterministic `headline_register` normalizer in `tugrust/crates/tugcast/src/feeds/session_overview.rs`, applied to every model answer before `overview_frame`, and lower `MAX_HEADLINE_CHARS`.
3. Re-shape `SessionPulseStrip` to S1: one row, the overview as the bright pinned headline, the beat as the muted mono activity past a `›`, and the separate overview row removed.
4. Add L1 to the Lens `SessionRowContent`: the overview as a third line, collapsing when absent, with the phase-dot rise retuned for the taller row.
5. Extend the app-test surface with a PULSE frame delivery hook, and pin S1 + L1 presence and overflow behavior with an app-test.
6. Reconcile the gallery spike's docblock with what shipped, so the card stays the doctrine reference rather than a stale proposal.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Changing what goes *into* the digest. `compose_digest`, `MAX_PROMPTS`, `MAX_PROMPT_CHARS`, `MAX_TOOL_LINES`, and `tool_line` stay exactly as they are — this plan changes the shape of the answer, not the shape of the question.
- Changing the pulse commentator itself (`tugrust/crates/tugcast/src/feeds/pulse.rs` and its `intent`/beat production). The beat stream and the per-line intent are untouched on the wire; only what the strip *renders* changes.
- A model-management surface. Still deferred — see [Q03] of `dash/local-model-bringup.md`.
- Any new local-model task verb. The overview keeps riding the existing `summarize` task ([P06] of the bring-up plan).
- Re-scoring the `classify` prompt or any other frozen prompt. Only `summarize` moves here.
- Windowing or virtualizing the Lens list. The row grows a line; the list keeps rendering inline at real measured heights.

#### Dependencies / Prerequisites {#dependencies}

- The local-model infrastructure from `dash/local-model-bringup.md`, landed on `main` (`9b67b446c`). Specifically: the `summarize` task path (`LocalModelRequester::summarize` in `tugrust/crates/tugcast/src/local_model.rs`), the overview emitter, the `pulse-overview` tenant switch (`PULSE_OVERVIEW_KEY`), and the deck's `usePulseOverview` selector.
- A downloaded on-device model for the live half of the integration checkpoint. The Tug ▸ **Set Up Tug…** menu item opens the wizard on demand, which is the fastest path to installing or re-installing one.
- ~~The bake-off harness at `~/bonsai-eval/pulse_8b.py`~~ — no longer a dependency; [P05] is withdrawn and re-validation there is retired. See [`local-model-liveness-brief.md`](local-model-liveness-brief.md#retiring-the-re-score).

#### Constraints {#constraints}

- **Warnings are errors.** `tugrust/.cargo/config.toml` enforces `-D warnings`; a removed helper left behind is a build failure, not a lint note.
- **`LocalModelPrompts` strings are documented as frozen** — the file's own docblock states they are the exact text the catalog's models were scored against, and that changing one invalidates those scores for every entry at once. This plan changes one deliberately; [P05] says what that obliges.
- **The strip is a fixed-height band.** `--session-pulse-strip-height: 34px` with `line-height` equal to it is what makes the PULSE pill and the line share one optical baseline. S1 must not disturb that; the spike's `.gpd-band` reproduces the trick exactly and is the reference.
- **No reserved empty rows.** Established by the shipped overview row and pinned by `at0280`; carried forward to both surfaces here.
- **No fake-DOM tests.** Rendering claims go to `tests/app-test/`; string claims go to `bun:test` / `cargo nextest`.
- **`@covers` is mandatory** on any new app-test, and `just app-test-covers-check` must resolve every path.

#### Assumptions {#assumptions}

- The on-device model can be steered into headline register by instruction alone for the common case, with the normalizer catching the tail. If the live matrix shows it cannot, the normalizer's scope grows rather than the design changing — the register is a property of the surface, not a request to the model.
- Removing the per-line `intent` from the strip is acceptable to model-less users, because for them the strip returns to exactly the single bright activity line it had before the two-level line shipped. This is the deliberate reading of [P01]; [R04] records what it costs.
- The Lens list renders rows at real measured heights, so a third line grows the row without any estimate to update. Confirmed by `sessions-section.css`, which sizes rows from content and tunes only the phase dot's transform.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Headline character budget (OPEN — resolved by the live matrix) {#q01-headline-budget}

**Question:** What is the right value for `MAX_HEADLINE_CHARS`? It ships at 56 per [P04], down from 110.

**Why it matters:** Too high and the headline stops being a headline — it wraps back into prose and eats the activity's width, which is the exact failure S1 is designed to prevent. Too low and real work gets clipped mid-thought, and a clipped headline reads worse than a slightly long one because the `…` lands on the bright, pinned run.

**Options (if known):**
- 45 — aggressive; matches the spike's shortest fixtures (`Hunting ⌘L focus drift in Lens` is 30).
- 56 — the shipping default; fits the spike's longest fixture (`Fixing download resume restart-from-zero`, 41) with real slack.
- 64 — permissive; risks prose creeping back in.

**Plan to resolve:** [#step-6](#step-6) — run live sessions with a downloaded model, collect the observed headlines, and check what fraction the normalizer had to clip. If clipping is common at 56 the model is not in register and the prompt is the problem, not the budget.

**Resolution:** OPEN

#### [Q02] Overview cadence under a bright headline (OPEN — resolved by the live matrix) {#q02-cadence}

**Question:** Do `BURST_FRAMES` (8), `IDLE_PERIOD` (30s), and `EMIT_FLOOR` (15s) in `session_overview.rs` still read right once the headline is the brightest, most layout-pinned element on the strip?

**Why it matters:** A stale line is forgivable when it is small, grey, and secondary. Promoted to the headline it becomes the thing the eye lands on, so staleness is now conspicuous — and so is twitchiness, since inference is not free and a headline that rewrites itself every fifteen seconds is worse than one that holds.

**Options (if known):** leave as-is; shorten `EMIT_FLOOR` for responsiveness; lengthen it for calm; make the cadence depend on whether the digest actually changed shape rather than on frame counts.

**Plan to resolve:** [#step-6](#step-6) — observe on a real working session, not a synthetic one.

**Resolution:** OPEN

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Bright headline amplifies a wrong overview | med | med | Normalizer bounds the form, not the truth; the beat beneath it is always ground truth, and the whole tenant is behind the `pulse-overview` switch | Owner reports a headline that misdescribes the session |
| ~~Frozen-prompt doctrine broken without a re-score~~ (retired) | — | — | The re-score is withdrawn ([P05]); the freeze rule stays, and liveness + turnaround replace scoring | Any further edit to `LocalModelPrompts` |
| Lens row grows and crowds the phase dot | low | high | The dot rise knob is retuned in the same step that adds the line | Row divider crowding at the shipped dot size |
| Model-less users lose the retained goal | low | high | Documented in [P01]; the goal survives in the history popover, and `at0280` pins that the model-less strip is clean rather than degraded | Owner or a user asks where the goal went |

**Risk R01: A bright wrong headline** {#r01-wrong-headline}

- **Risk:** Promoting a model-written sentence to the brightest run on the card makes a hallucinated or stale summary the most confident thing on screen.
- **Mitigation:**
  - The normalizer constrains form only; nothing here asserts the sentence is true.
  - The activity beneath it is produced from real tool frames and never passes through a model, so the row always carries one grounded reading.
  - The `pulse-overview` tenant switch turns the whole level off without touching the beat.
- **Residual risk:** A confident wrong headline still reads as fact for as long as it stands. This is inherent to the feature, not to this plan.

**Risk R02: Invalidated model scores (RETIRED 2026-07-28)** {#r02-score-invalidation}

- **Risk:** `LocalModelPrompts.summarize` is documented as frozen precisely so catalog entries are comparable; rewriting it silently makes every recorded score stale.
- **Why it is retired:** the risk assumed the scores were load-bearing. They are not — a fixed-corpus score does not tell us whether this feature works, and there is no ground truth for a session summary to score against. Only one catalog entry is offered today, so `recommended` is not currently choosing between anything either.
- **What stands in its place:**
  - [#step-2](#step-2)'s docblock edit stays, so the next reader knows which wording is live.
  - The freeze rule stays: a prompt change remains a deliberate act.
  - Liveness and turnaround ([`local-model-liveness-brief.md`](local-model-liveness-brief.md)) are the real checks, and a narrow old-vs-new comparison is available by hand if a model choice ever needs defending.

---

### Design Decisions {#design-decisions}

#### [P01] INTENT is the session overview; the line-level intent leaves the strip (DECIDED) {#p01-intent-source}

**Decision:** The bright headline run is fed exclusively by the local model's session overview (`usePulseOverview`). `PulseLineEntry.intent` — the commentator's retained per-line goal — stops rendering on the strip entirely and survives only as the grouping heading in the recent-pulses popover.

**Rationale:**
- The spike's own state fixtures name the level: "No intent yet — turn just started, **first overview pending**". The headline it designed is the overview.
- Two different strings competing for one bright slot is a precedence rule nobody can see. One source is legible; a fallback chain is not.
- The history popover is the right home for the commentator's goal: history is where structure belongs, and `groupPulseHistory` already renders it once per run of beats rather than repeating it.

**Implications:**
- `DisplayEntry.intent`, the two-level branch of `PulseLineText`, and `composeLineCopy`'s line-intent argument all change or go.
- A deck with no local model sees the strip it had before the two-level line existed: PULSE pill, one bright activity run, sparkline.
- `groupPulseHistory`, `PulseLineEntry.intent`, and every wire field stay exactly as they are. This is a rendering decision, not a protocol one.

#### [P02] S1 is one row; the separate overview row is removed (DECIDED) {#p02-s1-one-row}

**Decision:** `.session-pulse-strip` stops being a column of up to two rows. The overview row (`.session-pulse-strip-overview`, `data-slot="session-pulse-overview"`) is deleted and its text becomes the leading run of the beat row: headline (bright, medium weight, **pinned** — `flex: 0 0 auto`), `›` separator, activity (muted, mono, `0.6875rem`, **shrinks and ellipsizes first**).

**Rationale:**
- The spike locked S1 and it is the whole point of the exercise: one line, headline first.
- The existing two-level line already solved the hard layout problem in the opposite direction — the pinned/shrinking split, the `›` divider, the baseline row. S1 is that machinery with the roles swapped, not new machinery.
- Deleting the second row returns the strip to a fixed 34px whatever the state, which removes a class of layout motion rather than adding one.

**Implications:**
- The `.session-pulse-line--twolevel` / `.session-pulse-intent` / `.session-pulse-beat` CSS block is rewritten and renamed (`.session-pulse-headline` / `.session-pulse-activity`) — keeping the old names with inverted meanings would be a trap for the next reader.
- `at0280-local-model-absent.test.ts` changes its absence selector from the row to the headline run; its claim is unchanged.
- `--session-pulse-strip-overview-height` and `--session-pulse-strip-overview-font-size` are deleted.

#### [P03] Headline register is enforced twice — prompt and normalizer (DECIDED) {#p03-double-enforcement}

**Decision:** The register is requested of the model (instruction wording) *and* imposed by a pure Rust function `headline_register` applied to every answer before it becomes a frame.

**Rationale:**
- A 2-bit ternary 8B model asked for a specific prose register will obey most of the time and not all of the time. "Most of the time" is not a design.
- The normalizer is a pure function over a string: unit-testable at zero cost, no inference, no latency, and it runs identically for every backend in the availability matrix (MLX today, FoundationModels where the OS has it).
- Enforcement in Rust means the guarantee holds for any future producer of overviews, not just the current Swift prompt.

**Implications:**
- `headline_register` is `pub` in `session_overview.rs` alongside `clip` and `compose_digest`, with its own test module coverage.
- The function must be conservative: it strips known-mechanical violations (wrapping quotes, leading articles, filler openers, trailing sentence punctuation, collapsed whitespace) and clips. It never rewrites content — a normalizer that paraphrases would be a second, worse model.

#### [P04] Headline budget: 56 characters, 24 max tokens (DECIDED — value open) {#p04-budget}

**Decision:** `MAX_HEADLINE_CHARS` drops from 110 to 56, and `LocalModelPrompts.summarizeMaxTokens` drops from 48 to 24.

**Rationale:**
- 110 characters is a sentence budget. The spike's fixtures run 30–41 characters; 56 fits the longest with slack and refuses prose.
- 48 tokens is roughly 190 characters of generation headroom — it permits the model to write far past what will ever be shown, which costs latency for text that is immediately clipped. 24 tokens comfortably covers 56 characters and makes the ceiling meaningful.
- Clipping is the last resort, not the mechanism: the prompt and the token ceiling should mean the normalizer rarely has to cut.

**Implications:**
- The exact number is [Q01] and is expected to move once the live matrix runs.
- Clipping frequency becomes a diagnostic: if headlines are regularly clipped, the prompt is failing, not the budget.

#### [P05] Changing a frozen prompt obliges a re-score (WITHDRAWN 2026-07-28) {#p05-rescore-obligation}

> **Withdrawn.** The re-score obligation below is retired — see [`local-model-liveness-brief.md`](local-model-liveness-brief.md#retiring-the-re-score). Scoring a generative model against a fixed corpus carries no information about whether this feature works, and there is no ground truth for "what is this session working on" to score against. What survives: the `LocalModelPrompts` freeze rule stays (it keeps catalog entries comparable on identical wording, and makes a prompt change deliberate), the docblock edit stays, and a narrow old-prompt-vs-new comparison remains available by hand when there is a reason to doubt a model choice. The rest of this decision is kept as written for the record.

**Decision:** The `summarize` prompt changes, and the change carries an explicit obligation: re-validate against `~/bonsai-eval/pulse_8b.py`, and update the `LocalModelPrompts` docblock so it names the wording the current catalog scores refer to.

**Rationale:**
- The docblock's freeze rule exists so catalog entries are comparable on identical wording. Silently editing the text would leave a rule in the code that the code no longer obeys.
- The re-score is not a blocker for shipping the display work: a headline-register prompt cannot make the model *worse* at the task the strip actually needs, and the normalizer bounds the downside.
- The harness lives outside the repo, so this cannot be a CI gate. Making it a stated obligation with a named file is the honest form.

**Implications:**
- [#step-2](#step-2) edits the docblock in the same commit as the prompt.
- The catalog's `recommended` flag is provisional until the harness re-runs; [R02] records the residual.

#### [P06] The headline renders as plain text; the activity keeps markdown (DECIDED) {#p06-headline-plain}

**Decision:** The headline run renders the overview string directly. The activity run keeps `renderPulseLine` (sanitized markdown, KaTeX, the total-function fallback).

**Rationale:**
- The overview is one model-written sentence about a session. It has no markdown to render, and the pipeline's cost is real (a lazy KaTeX load, a re-render on resolve).
- The old overview row already rendered plain text, and the old *intent* run needed a CSS emphasis-flattening block precisely because rendering markdown there produced bold/mono flicker. Plain text deletes that whole problem instead of re-solving it.
- The activity is a tool call — backticked paths and commands are exactly what `renderPulseLine` is for.

**Implications:**
- The `.session-pulse-intent :is(strong, b, em, i)` / `code` flattening rules are deleted rather than renamed.
- `PulseLineText` simplifies to a single rendered run plus a plain headline sibling.

#### [P07] Neither surface reserves space for an absent level (DECIDED) {#p07-no-reserved-space}

**Decision:** S1 drops the missing run (and its separator) from the line; L1 collapses the missing line entirely. No placeholder, no reserved height, on either surface.

**Rationale:**
- Restates [P12] of the bring-up plan (strict enhancement) at the display layer: a deck with no local model must be indistinguishable from today's, not "today's plus an empty row".
- The spike states the same rule for both grammars, and `at0280` already pins the card half of it.

**Implications:**
- The Lens row is genuinely two heights, and `at0280` grows a Lens half in [#step-4](#step-4) — it opens no Lens today, so the model-less claim currently covers the card only.
- The existing `None` placeholder for a session with no beat is unchanged — that is an *activity* placeholder and predates this work.

#### [P08] The app-test surface gains a PULSE frame hook (DECIDED) {#p08-test-surface-hook}

**Decision:** `tugdeck/src/lib/pulse-store.ts` gains `_ingestPulseFrameForTest(body: unknown)` beside `_resetPulseStoreForTest`, and `tugdeck/src/test-surface.ts` gains `publishPulseFrame(payloadJson)` which calls it. `SURFACE_VERSION` takes a minor bump.

**Rationale:**
- Presence claims — the headline exists, the activity ellipsizes and the headline does not, the Lens grows a third line — can only be checked in a real browser against real layout. There is currently no way to make an overview appear under the harness.
- The store-level ingest is an **existing convention**, not a new one: `changeset-draft-store.ts` has `_ingestDraftFrameForTest`, which encodes a JSON body to bytes and hands it to the private handler, commented "Reach the private handler through the same path `onFrame` would." Following it keeps the two stores' test seams identical.
- This is not a mock: the bytes go through the production `parsePulseFrame` into the production `fold` / `foldOverview` and out through the production components. The hook supplies bytes the wire would otherwise have supplied.
- The surface is DEV-gated and `__tugTestMode`-gated; release builds strip the attach path.

**Implications:**
- The hook is additive, so the bump is minor per the surface's own versioning rule.
- A follow-up test wanting beat frames gets them from the same hook for free, and `pulse-store.test.ts` can use the store-level helper directly without going through the surface.

#### [P09] The history popover keeps grouping by line intent (DECIDED) {#p09-history-grouping}

**Decision:** `SessionPulseHistory`, `groupPulseHistory`, and `SessionPulseHistoryIntent` are untouched.

**Rationale:**
- With [P01] removing the line intent from the strip, the popover becomes its only surface — which is where it always read best anyway, shown once per run of beats.
- The popover is a deliberate second altitude: the strip is a glance, the history is a read.

**Implications:**
- `PulseLineEntry.intent` stays in the store, the protocol, and the ledger tail. Nothing about the wire narrows.

---

### Deep Dives {#deep-dives}

#### What the strip renders today, precisely {#strip-today}

`SessionPulseStrip` (`tugdeck/src/components/tugways/cards/session-pulse-strip.tsx`) returns a flex **column**:

1. `.session-pulse-strip-overview` (`data-slot="session-pulse-overview"`) — rendered only when `usePulseOverview(tugSessionId)` is non-null. 22px, `0.6875rem`, muted, `opacity: 0.85`, `padding-inline-start` computed to line up with the beat text.
2. `.session-pulse-strip-beat` — 34px with a matching `line-height`, holding the `PULSE` popover-trigger pill, `.session-pulse-strip-stage` (the flexing text area), and the sparkline popover trigger.

Inside the stage, `PulseLineText` branches on `entry.intent`: with an intent it emits `.session-pulse-line--twolevel` containing `.session-pulse-intent` (muted, `flex: 0 1 auto`, ellipsizes first, markdown emphasis flattened), `.session-pulse-intent-sep` (the `›`), and `.session-pulse-beat` (bright, medium weight, `flex: 0 0 auto`). Without an intent it emits a single `.session-pulse-strip-text` run.

S1 is that inner structure with the flex roles and the tones swapped, fed from the overview instead of `entry.intent`, and the outer column flattened back to one row. The pinned/shrinking mechanism, the separator, and the baseline trick are all already correct — this is why [P02] treats S1 as a role swap rather than a rewrite.

#### The dwell queue does not apply to the headline {#dwell-and-headline}

`useDwellDisplay` paces the **beat**: every line holds `MIN_DWELL_MS` (1800ms) before the next replaces it, so rapid commentary coalesces. The overview deliberately never enters that queue — the store comment says it plainly ("it is not news, so it has nothing to pace against"), and the emitter's own `EMIT_FLOOR` of 15s already makes it slow. S1 must preserve this: the headline is read straight from `usePulseOverview` on every render, and only the activity run goes through `useDwellDisplay`. Routing the headline through the dwell would add a second, redundant pacer and delay the first headline of a session by up to 1.8s for no reason.

#### The compaction pin and the placeholder {#compaction-and-placeholder}

Two entries bypass the normal path and both are **activity**, not intent: `COMPACTING_ENTRY` (pinned for the length of a `/compact` run started from this card, because the wire streams nothing during it) and `NONE_ENTRY` (the dimmed `None` before a session's first line). Under S1 both keep occupying the activity run exactly as they do now. A session that is compacting with a standing overview therefore reads `Wiring overview cadence gate › Compacting context…`, which is the correct reading — the headline is still true while the compaction runs.

#### The Lens row today {#lens-row-today}

`SessionRowContent` in `tugdeck/src/components/lens/sections/sessions-section.tsx` hand-authors a two-line content column inside `TugListRow` — the shared `title`/`subtitle` path could not be used because a row-level `trailing` accessory spans both lines, and the slot picker and the sparkline each need to ride their own line. Line 1 is `.session-row-headline` (the session label plus `SlotPicker`); line 2 is `.session-row-pulse-line` (`.sessions-monitor-pulse` text plus `RowSparkline`). The pulse text comes from `latestLineForScope(pulse.lines, row.tugSessionId)` — note there is no cleared-watermark argument here, unlike the card — with the compaction pin applied the same way the card applies it.

L1 inserts a new line *between* those two, fed by `usePulseOverview(row.tugSessionId)`, and moves nothing else. The one geometric consequence is the phase dot: `ROW_PHASE_DOT_SIZE` is 28 and `--tugx-lens-sessions-dot-rise` is 9px, both tuned against a 38px two-line column (19 + 19). A third line takes the column to roughly 55px, so the rise must come back toward zero or the dot climbs into the block padding and crowds the divider above. The CSS file documents this headroom math at the rise knob; the step that adds the line updates that comment along with the value.

#### Why the normalizer is conservative {#normalizer-scope}

`headline_register` handles exactly the mechanical failures a model in the wrong register produces, in this order: trim; strip matched wrapping quotes (`"…"`, `'…'`, `“…”`); strip a leading filler opener from a closed list (`Working on `, `Trying to `, `Currently `, `The user is `, `This session is `, `It looks like `); strip a leading article (`The `, `A `, `An `); collapse internal whitespace runs to single spaces; strip trailing `.` (but never `…`, `?`, or `!` — a genuine question or exclamation is content, and `…` is `clip`'s own marker); re-trim; `clip` to `MAX_HEADLINE_CHARS`.

Everything else is left alone. It does not lowercase, retitle, drop other stop words, or shorten by paraphrase — those are judgments, and a normalizer making judgments is a second model with none of the first one's context. Order matters: filler openers are stripped before articles, so `The user is working on the pulse strip` reduces cleanly; and clipping is last, so a stripped prefix buys back budget instead of wasting it.

---

### Specification {#specification}

**Spec S01: The S1 line contract** {#s01-s1-line}

The strip's stage renders, in order, only the runs that exist:

| Run | Class | Source | Flex | Tone | Ellipsizes |
|-----|-------|--------|------|------|------------|
| headline | `.session-pulse-headline` | `usePulseOverview(tugSessionId)?.text` | `0 0 auto` + `max-width: 100%` (pinned) | default tone, `--tug-font-weight-medium`, `0.75rem`, sans | last resort only |
| separator | `.session-pulse-sep` | literal `›`, only when both runs exist | `0 0 auto` | muted-disabled | n/a |
| activity | `.session-pulse-activity` | the dwell-paced beat (`renderPulseLine`) | `0 1 auto` (shrinks) | muted, `0.6875rem`, mono | first |

"Pinned" means the headline never yields width **to the activity** — it does not shrink to make room, so the activity is always the run that truncates first. It is *not* `overflow: visible`: a headline that alone exceeds the line still ellipsizes, because the strip's root carries `overflow: hidden` and an unclipped run would punch through the 34px band and get cut mid-glyph with no `…` to say so. Both runs therefore carry `overflow: hidden` + `text-overflow: ellipsis` + `min-width: 0`; the difference is entirely in the flex basis. The spike's `.gpd-s1-line .gpd-intent-text { flex: 0 0 auto; max-width: 100% }` over `.gpd-intent-text` is the exact reference.

The placeholder case (`None`, or a card with no session) keeps its muted tone on the activity run. The whole strip is a single 34px row, always.

**Spec S02: `headline_register` behavior** {#s02-normalizer}

```rust
pub fn headline_register(raw: &str) -> String
```

Total function; never panics; returns `""` for input that normalizes to nothing (the emitter already skips empty headlines). Applies the ordered rules in [#normalizer-scope](#normalizer-scope) and clips to `MAX_HEADLINE_CHARS`. Called in the emit path in place of the current bare `clip(text.trim(), MAX_HEADLINE_CHARS)`.

**Spec S03: PULSE frame ingest for tests** {#s03-test-hook}

```ts
// tugdeck/src/lib/pulse-store.ts — mirrors _ingestDraftFrameForTest
export function _ingestPulseFrameForTest(body: unknown): void

// tugdeck/src/test-surface.ts
publishPulseFrame(payloadJson: string): boolean
```

`_ingestPulseFrameForTest` encodes `body` with `TextEncoder` and hands the bytes to the attached store's private PULSE handler — the same bytes, parser, and fold the wire path uses. No-op when no store is attached. `publishPulseFrame` parses its JSON string, forwards it, and returns `false` when there was no store to feed.

The payload shape is the emitter's own: `{"type":"pulse","kind":"overview","text":…,"scopes":[…],"beat":N,"at":ms}` for an overview, the same without `kind` for a beat. Note `parsePulseFrame` rejects any payload whose `type` is not `"pulse"` or whose `text` is empty, so a malformed fixture fails as a silent no-op rather than an error — assert on the rendered result, never on the hook's return alone.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| headline text (card + Lens) | external state | existing `usePulseOverview(scope)` selector over `PulseStore` — no new store, no new snapshot field | [L02], [L24] |
| activity text + dwell queue | local-data (presentation) | unchanged `useDwellDisplay` (`useState`/`useRef`) — changes *what* text exists, not how it looks | [L06] |
| pinned-vs-shrinking run behavior, tones, mono face | appearance | CSS only, in `session-pulse-strip.css` / `sessions-section.css` | [L06], [L16] |
| Lens third line presence | structure (derived) | conditional render from the same selector; no reserved height | [L02], [L26] |
| phase-dot rise for the taller row | appearance | `--tugx-lens-sessions-dot-rise` transform — never touches layout | [L06] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tests/app-test/at0282-pulse-two-level.test.ts` | Pins S1 on the card and L1 in the Lens: headline present, headline never the truncated run, Lens third line appears and collapses |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `headline_register` | fn (pub) | `tugrust/crates/tugcast/src/feeds/session_overview.rs` | New; Spec S02 |
| `MAX_HEADLINE_CHARS` | const | `tugrust/crates/tugcast/src/feeds/session_overview.rs` | 110 → 56 ([P04], [Q01]) |
| `LocalModelPrompts.summarize` | static let | `tugapp/Sources/LocalModelService.swift` | Rewritten to headline register ([P05]) |
| `LocalModelPrompts.summarizeMaxTokens` | static let | `tugapp/Sources/LocalModelService.swift` | 48 → 24 |
| `DisplayEntry.intent` | field | `tugdeck/src/components/tugways/cards/session-pulse-strip.tsx` | Removed ([P01]) |
| `PulseLineText` | component | `tugdeck/src/components/tugways/cards/session-pulse-strip.tsx` | Single-run; two-level branch removed ([P06]) |
| `composeLineCopy` | fn | `tugdeck/src/components/tugways/cards/session-pulse-strip.tsx` | Strip callsite passes the overview; history callsite keeps the line intent |
| `.session-pulse-headline` / `.session-pulse-sep` / `.session-pulse-activity` | CSS | `tugdeck/src/components/tugways/cards/session-pulse-strip.css` | Replace `.session-pulse-intent` / `-sep` / `.session-pulse-beat` / `.session-pulse-line` / `--twolevel`; each color-setting rule carries its own `@tug-renders-on` comment ([L16]) |
| `.session-pulse-strip-overview*` | CSS + DOM | `tugdeck/src/components/tugways/cards/session-pulse-strip.{tsx,css}` | Deleted ([P02]) |
| `SessionRowContent` | component | `tugdeck/src/components/lens/sections/sessions-section.tsx` | Gains the L1 intent line |
| `.session-row-intent-line` | CSS | `tugdeck/src/components/lens/sections/sessions-section.css` | New; the L1 middle line |
| `--tugx-lens-sessions-dot-rise` | CSS var | `tugdeck/src/components/lens/sections/sessions-section.css` | Retuned for a three-line row |
| `_ingestPulseFrameForTest` | fn (exported) | `tugdeck/src/lib/pulse-store.ts` | New; Spec S03, [P08] — mirrors `_ingestDraftFrameForTest` |
| `publishPulseFrame` | method | `tugdeck/src/test-surface.ts` | New; Spec S03, [P08] — thin wrapper over the store helper |
| `SURFACE_VERSION` | const | `tugdeck/src/test-surface.ts` | Minor bump |

---

### Documentation Plan {#documentation-plan}

- [ ] `session-pulse-strip.tsx` docblock: describe S1 and the single-row shape; delete the "second, quieter line above the beat" paragraph.
- [ ] `sessions-section.tsx` docblock: the row is three lines when an overview exists, two when it does not.
- [ ] `gallery-pulse-display.tsx` docblock: the spike's "The shipped strip renders the pair inverted" sentence is stale the moment [#step-3](#step-3) lands — replace it with a note that S1/L1 shipped and the card is now the doctrine reference for the copy register.
- [ ] `LocalModelService.swift` docblock: name the wording the catalog scores were taken against ([P05]).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | `headline_register` over a violation corpus | Every rule in Spec S02, plus idempotence and empty/whitespace input |
| **Unit (bun:test)** | `latestOverviewForScope` scope precedence | Already covered in `pulse-store.test.ts`; extend only if the selector changes |
| **App-test** | S1 / L1 rendering, overflow direction, absence | `at0282` (new) and `at0280` (updated) |

#### What stays out of tests {#test-non-goals}

- Whether a headline is *true*. No test can assert a model's summary is correct; the tests bound its form.
- Any fake-DOM render of the strip. Banned in this codebase and unable to answer the only interesting question here (which run gets truncated), which is a layout fact.
- Mock-store assertions against `PulseStore`. The app-test drives the real store through the real decode path per [P08].
- The Swift prompt's effect on model output. That is the bake-off harness's job ([P05]), not CI's.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** The contract steps ([#step-1](#step-1), [#step-2](#step-2)) land before any renderer changes, so the display work is judged against real headlines.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Headline register normalizer + budget (tugcast) | done | `c468e2f1e` |
| #step-2 | Headline-register prompt (tugapp) | done | `2a1258e19` |
| #step-3 | S1 on the session card strip | done | `8c615a0d1` |
| #step-4 | L1 in the Lens session row | done | `27ed1d8b5` |
| #step-5 | Test-surface frame hook + two-level app-test | done | `764ec66ac` |
| #step-6 | Integration checkpoint — live headlines | automated half done; live half is the owner's | — |

#### Step 1: Headline register normalizer + budget (tugcast) {#step-1}

**Commit:** `tugcast(pulse-overview): enforce headline register on every emitted overview`

**References:** [P03] Double enforcement, [P04] Budget, [Q01] Headline budget, Spec S02, (#normalizer-scope, #strip-today)

**Artifacts:**
- `headline_register` in `tugrust/crates/tugcast/src/feeds/session_overview.rs`, applied in the emit path
- `MAX_HEADLINE_CHARS` lowered to 56

**Tasks:**
- [ ] Add `pub fn headline_register(raw: &str) -> String` implementing the ordered rules in [#normalizer-scope](#normalizer-scope). Keep the filler-opener list a `const` slice next to the function so it reads as data, and match it case-insensitively on the prefix only.
- [ ] Replace the emit path's `clip(text.trim(), MAX_HEADLINE_CHARS)` with `headline_register(&text)`; `clip` stays and is called *from inside* the normalizer (it is also used elsewhere and keeps its own tests).
- [ ] Lower `MAX_HEADLINE_CHARS` from 110 to 56 and update its doc comment to say what the number is for (a headline, not a sentence) and that [Q01] may move it.
- [ ] Leave `compose_digest`, the cadence constants, and the gate truth table untouched.

**Tests:**
- [ ] `headline_register` strips wrapping straight and curly quotes.
- [ ] It strips each filler opener in the list, case-insensitively, and strips a leading article after one (`The user is working on the pulse strip`).
- [ ] It strips a trailing `.` but preserves a trailing `?`, `!`, and the `…` that `clip` itself adds.
- [ ] It collapses internal whitespace runs and trims.
- [ ] It clips to `MAX_HEADLINE_CHARS` on a multi-byte string without panicking (mirrors `clip_respects_character_boundaries`).
- [ ] It is idempotent: `headline_register(&headline_register(x)) == headline_register(x)` over the whole corpus.
- [ ] Empty and whitespace-only input return `""`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugrust && cargo build` (warnings are errors — no unused import left by the emit-path edit)

---

#### Step 2: Headline-register prompt (tugapp) {#step-2}

**Depends on:** #step-1

**Commit:** `tugapp(local-model): ask the summarize task for a headline, not a sentence`

**References:** [P04] Budget, [P05] Re-score obligation, Risk R02, (#task-prompts of `dash/local-model-bringup.md`)

**Artifacts:**
- Rewritten `LocalModelPrompts.summarize` and `summarizeMaxTokens` in `tugapp/Sources/LocalModelService.swift`
- Updated `LocalModelPrompts` docblock

**Tasks:**
- [ ] Rewrite `summarize` to specify headline register explicitly: one line, newspaper headline style, no definite or indefinite articles, no filler openers, no trailing period, no quotes, under ~8 words, naming the work rather than describing the act of working. Use the gallery spike's `DOCTRINE` table (`gallery-pulse-display.tsx`) as the source of the rewrite rule — its before/after pairs are the intended behavior stated as examples.
- [ ] Lower `summarizeMaxTokens` from 48 to 24.
- [ ] Update the `LocalModelPrompts` docblock: keep the freeze rule, and state that the `summarize` wording changed here and that the catalog's overview scores refer to the previous wording until `~/bonsai-eval/pulse_8b.py` re-runs.
- [ ] Leave `classify`, `generate`, and `firstLine` untouched.
- [ ] Note in the commit body that the CONTROL `local_model_summarize` proof-of-life action in `tugrust/crates/tugcast/src/local_model.rs` shares this prompt, so its broadcast answer changes shape too (headline, not sentence). That is expected, not a regression.

**Tests:**
- [ ] None automatable in-repo — the prompt's effect is a model-behavior question, resolved by the harness ([P05]) and by [#step-6](#step-6). This is a deliberate gap, recorded in [#test-non-goals](#test-non-goals).

**Checkpoint:**
- [ ] `just app-debug` builds, signs, and launches clean.
- [ ] The `LocalModelPrompts` docblock states which wording the catalog's overview scores were taken against, and the freeze rule still reads true against the file's contents.
- [ ] `summarizeMaxTokens` comfortably exceeds `MAX_HEADLINE_CHARS` from [#step-1](#step-1) in tokens (24 tokens ≈ 90+ characters against a 56-character budget) — the ceiling must bound waste, never truncate a legal headline mid-word.

> Live model behavior is deliberately NOT a checkpoint here: it depends on a downloaded pack and a real working session, neither of which an implementer necessarily has, and gating this commit on hardware state would stall the run. [#step-6](#step-6) owns that verification.

---

#### Step 3: S1 on the session card strip {#step-3}

**Depends on:** #step-1

**Commit:** `tugways(pulse-display): S1 — headline over activity on one strip line`

**References:** [P01] Intent source, [P02] One row, [P06] Plain headline, [P07] No reserved space, [P09] History unchanged, Spec S01, (#strip-today, #dwell-and-headline, #compaction-and-placeholder)

**Artifacts:**
- `session-pulse-strip.tsx` / `.css` reshaped to S1
- `at0280-local-model-absent.test.ts` selector updated
- `gallery-pulse-display.tsx` docblock reconciled

**Tasks:**
- [ ] Remove the `.session-pulse-strip-overview` row and its `data-slot`; the component returns the beat row as its root (keeping `data-slot="session-pulse-strip"` on it).
- [ ] Render the headline as a plain `<span className="session-pulse-headline" data-slot="session-pulse-headline">` inside the stage, before the separator and the activity, sourced from `usePulseOverview(tugSessionId)` — **not** through `useDwellDisplay` ([#dwell-and-headline](#dwell-and-headline)).
- [ ] Drop `intent` from `DisplayEntry` and from the `target` construction; simplify `PulseLineText` to one rendered run ([P06]).
- [ ] Update the strip's right-click copy to `composeLineCopy(overview?.text, current.text)` so the clipboard carries the same two-level reading the eye does; leave the history beat's callsite passing the line intent ([P09]).
- [ ] Rewrite the CSS block: `.session-pulse-headline` (pinned, default tone, medium weight, `0.75rem`), `.session-pulse-sep`, `.session-pulse-activity` (mono, `0.6875rem`, muted, shrinks and ellipsizes). Delete `--twolevel`, `.session-pulse-line`, `.session-pulse-intent*`, `.session-pulse-beat`, the emphasis-flattening rules, and the two `--session-pulse-strip-overview-*` tokens. The spike's `.gpd-s1-*` rules are the reference values.
- [ ] Both runs keep `overflow: hidden` + `text-overflow: ellipsis` + `min-width: 0`; only the flex basis differs (Spec S01). Do not reach for `overflow: visible` on the headline — the strip root clips, so an unbounded run gets cut mid-glyph with no `…`.
- [ ] Carry an `@tug-renders-on var(--tug7-surface-card-primary-normal-status-rest)` comment onto every new color-setting rule, as the block being replaced does ([L16]).
- [ ] Keep the stage's `translate(-2px, 1px)` offsets and the 34px `line-height` baseline trick intact.
- [ ] Update `at0280-local-model-absent.test.ts`: its `OVERVIEW` selector becomes `[data-slot="session-pulse-headline"]`, and the docblock claim is reworded from "no overview row" to "no headline run". The claim itself does not change.
- [ ] Update the `session-pulse-strip.tsx` and `gallery-pulse-display.tsx` docblocks per [#documentation-plan](#documentation-plan).

**Tests:**
- [ ] `just app-test tests/app-test/at0280-local-model-absent.test.ts` — the model-less posture still holds against the new selector.
- [ ] Rendering presence is pinned in [#step-5](#step-5), which needs the frame hook.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bunx vite build` (an import that survives dev esbuild can still fail the rollup build)
- [ ] `cd tugdeck && bun test`
- [ ] `just app-test tests/app-test/at0280-local-model-absent.test.ts` → `VERDICT: PASS`
- [ ] The **Pulse Display** gallery card (`gallery-pulse-display`, Maker ▸ feedback) and a live session card read the same: one line, headline leading.

---

#### Step 4: L1 in the Lens session row {#step-4}

**Depends on:** #step-3

**Commit:** `tugways(pulse-display): L1 — stacked intent and activity in the Lens row`

**References:** [P01] Intent source, [P07] No reserved space, Spec S01, (#lens-row-today)

**Artifacts:**
- `SessionRowContent` gains the intent line
- `sessions-section.css` gains `.session-row-intent-line` and a retuned dot rise

**Tasks:**
- [ ] In `SessionRowContent`, read `usePulseOverview(row.tugSessionId)` and render a `.session-row-intent-line` between `.session-row-headline` and `.session-row-pulse-line`, only when an overview exists ([P07]).
- [ ] Style the intent line to match S1's headline tone and the spike's `.gpd-lens-intent-line` geometry (`line-height: 1.2`, `--tug-space-xs` gap); the activity line keeps its existing treatment and its sparkline.
- [ ] Retune `--tugx-lens-sessions-dot-rise` for a three-line row and update the headroom comment above it with the new arithmetic ([#lens-row-today](#lens-row-today)). The dot must stay clear of the divider above at `ROW_PHASE_DOT_SIZE`.
- [ ] Verify the row still truncates per line — each of the three lines keeps its own single-line run; none of them wraps.
- [ ] Carry `@tug-renders-on` comments onto any new color-setting rule, matching the file's existing convention ([L16]).
- [ ] Extend `at0280-local-model-absent.test.ts` with its missing Lens half: it opens no Lens today, so its "absent means absent" claim covers the card only. Add `dispatchControlAction("toggle-lens")` after the existing bind, then assert no intent line exists on `.session-row-content[data-session-id]`. `at0257-lens-session-reorder.test.ts` is the working precedent for seeding and addressing Lens rows; add `@covers tugdeck/src/components/lens/sections/sessions-section.tsx` to at0280's header.
- [ ] Update the `sessions-section.tsx` docblock's two-line description.

**Tests:**
- [ ] `at0280-local-model-absent.test.ts` — the model-less Lens row shows two lines, with no intent line and no reserved gap ([P07]).
- [ ] Presence and collapse with an overview present are pinned in [#step-5](#step-5), which needs the frame hook.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test tests/app-test/at0280-local-model-absent.test.ts` → `VERDICT: PASS`
- [ ] `just app-test-changed` → `VERDICT: PASS`
- [ ] In the running debug app with a model installed: a session with an overview shows three lines and one without shows two, with no gap where the missing line would be.

---

#### Step 5: Test-surface frame hook + two-level app-test {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `tugways(pulse-display): pin the two-level PULSE grammar with a real frame hook`

**References:** [P08] Test-surface hook, [P07] No reserved space, Spec S01, Spec S03, (#success-criteria)

**Artifacts:**
- `publishPulseFrame` on the test surface, `SURFACE_VERSION` minor bump
- `tests/app-test/at0282-pulse-two-level.test.ts`

**Tasks:**
- [ ] Add `_ingestPulseFrameForTest(body: unknown)` to `tugdeck/src/lib/pulse-store.ts`, beside `_resetPulseStoreForTest`, following `_ingestDraftFrameForTest` in `tugdeck/src/lib/changeset-draft-store.ts` line for line: `TextEncoder`-encode the JSON body and hand the bytes to the store's private PULSE handler, so `parsePulseFrame` and the real `fold` / `foldOverview` both run.
- [ ] Add `publishPulseFrame(payloadJson: string): boolean` to `TugTestSurface` and `createTugTestSurface` as a thin wrapper over that helper. Return `false` when no store is attached.
- [ ] Bump `SURFACE_VERSION`'s minor (additive change, per the file's own versioning rule) and confirm the harness handshake still matches on major.
- [ ] Write `at0282-pulse-two-level.test.ts` with `@covers` for `session-pulse-strip.tsx`, `sessions-section.tsx`, `pulse-store.ts`, and `test-surface.ts`. Seed one session card and the Lens; publish a beat frame and an overview frame scoped to the bound session. (Fan-out is not a concern here: those files carry 1–2 covering tests each against a 20-file budget.)
- [ ] Assert the card: the headline element exists with the published text; `[data-slot="session-pulse-overview"]` does not resolve; the strip's measured height is 34 with and without an overview; and with a long activity and a short headline the activity's `scrollWidth > clientWidth` while the headline's does not.
- [ ] Assert the Lens (`toggle-lens`, then `.session-row-content[data-session-id]` per `at0257-lens-session-reorder.test.ts`): the row grows an intent line carrying the same text, and a second session with no overview published shows only two lines.
- [ ] Assert on rendered output, never on `publishPulseFrame`'s return value alone — a malformed payload is a silent no-op by `parsePulseFrame`'s design (Spec S03).
- [ ] Run `just app-test-covers-check` and make sure every declared path resolves.

**Tests:**
- [ ] `at0282-pulse-two-level.test.ts` (new).
- [ ] `at0280-local-model-absent.test.ts` still passes — absence and presence are pinned by different tests and must not disagree.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0282-pulse-two-level.test.ts` → `VERDICT: PASS`
- [ ] `just app-test tests/app-test/at0280-local-model-absent.test.ts` → `VERDICT: PASS`
- [ ] `just app-test-covers-check` reports no missing or unresolvable `@covers` (it is green on the pre-change tree, so any failure here is this step's doing).
- [ ] Deliberately reverting the headline's `flex: 0 0 auto` makes `at0282` fail on the overflow assertion — the pin bites.

---

#### Step 6: Integration checkpoint — live headlines {#step-6}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5

**Commit:** `N/A (verification only)`

**References:** [Q01] Headline budget, [Q02] Cadence, [P05] Re-score obligation, Risk R01, (#success-criteria)

**Tasks:**
- [ ] With a model installed (Tug ▸ **Set Up Tug…** if one is not), work a real session and collect ten consecutive headlines from the strip.
- [ ] Judge each against the register and against the session's actual work; note how many arrived already in register versus how many the normalizer had to fix (a trailing `…` marks a clip).
- [ ] Resolve [Q01] from the clip rate: frequent clipping means the prompt is failing, not the budget.
- [ ] Resolve [Q02] from how the headline reads over time: stale, twitchy, or right.
- [ ] Confirm both surfaces agree — the Lens row's intent line and the card's headline show the same string for the same session.
- [x] ~~Re-run `~/bonsai-eval/pulse_8b.py` against the new wording~~ — **withdrawn**, see [P05] and [`local-model-liveness-brief.md`](local-model-liveness-brief.md#retiring-the-re-score). Liveness and turnaround replace it; that brief carries the follow-on work.
- [ ] Flip the `pulse-overview` tenant switch off and confirm both surfaces fall back cleanly to activity-only, with no reserved space ([P07]).

**Tests:**
- [x] `cd tugrust && cargo nextest run` — 1582 passed, 4 skipped.
- [x] `cd tugdeck && bun test` — 5007 passed. (`just test-ts` does not exist; the justfile's Rust recipe is `just test`, and the TS suite runs from `tugdeck/`.)
- [x] `just app-test-changed --allow-large <branch diff>` — 23/23 files green, 34/34 tests.

> The derived selection is 23 files, over the 20-file scoped budget, so it was opted into explicitly rather than narrowed. The selector also prints **SWEEP ADVISED** because `LocalModelService.swift` is app-shell source that no `@covers` line can scope; the change there is a prompt string, and no app-test drives a local model (`at0280` pins the model-*absent* posture), so a full corpus run would cost minutes to tell us nothing. Not swept, deliberately.

**Checkpoint:**
- [ ] Ten observed headlines, all in register and all recognizably about the work.
- [ ] [Q01] and [Q02] carry recorded resolutions in this document.
- [ ] Tenant switch off → the app renders exactly as it does with no model at all.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The PULSE reads as one two-level grammar everywhere it appears — a headline-register intent written by the on-device model over the muted activity beneath it, S1 on the session card and L1 in the Lens, with the register guaranteed in Rust rather than requested of the model.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `headline_register` enforces every rule in Spec S02 and is idempotent (`cargo nextest run -p tugcast`).
- [ ] The session card renders one PULSE row in every state — 34px measured, with no `session-pulse-overview` element (`at0282`).
- [ ] The activity is always the run that truncates first; the headline yields no width to it (`at0282`).
- [ ] The Lens row is three lines with an overview and two without (`at0282`).
- [ ] With the declined selection, no headline exists on the card **or** in the Lens row (`at0280`, whose Lens half lands in [#step-4](#step-4)).
- [ ] The gallery spike's docblock describes what shipped, not what was proposed (read it).
- [ ] Ten live headlines in register ([#step-6](#step-6)).

**Acceptance tests:**
- [ ] `tests/app-test/at0282-pulse-two-level.test.ts`
- [ ] `tests/app-test/at0280-local-model-absent.test.ts`
- [ ] `session_overview.rs` normalizer unit tests

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Cadence rework if [Q02] says the frame-count trigger is the wrong shape — a digest-shape-change trigger instead of `BURST_FRAMES`.
- [ ] A headline for shell-route sessions, which have no Claude JSONL for `session_prompts_since` to read.
- [ ] The model-management surface ([Q03] of `dash/local-model-bringup.md`).
- [ ] Re-scoring the whole catalog against the new wording and updating `recommended` ([P05], [R02]).

| Checkpoint | Verification |
|------------|--------------|
| Register enforced upstream of every renderer | `cargo nextest run -p tugcast` |
| S1 on the card | `just app-test tests/app-test/at0282-pulse-two-level.test.ts` |
| L1 in the Lens | `just app-test tests/app-test/at0282-pulse-two-level.test.ts` |
| Strict enhancement preserved | `just app-test tests/app-test/at0280-local-model-absent.test.ts` |
| Live headlines in register | Owner observation, [#step-6](#step-6) |
