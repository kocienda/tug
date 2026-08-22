<!-- devise-skeleton v5 -->

## Join Landing Parity {#join-landing-parity}

**Purpose:** The dash join lands a commit whose message reads like every other commit in the repository — a durable description of the change, not a narration of the run that produced it — and the `/dash-join` receipt row's first paint is its final form.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | kocienda |
| Status | draft |
| Target branch | main (via dash worktree) |
| Last updated | 2026-08-22 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-22, opus.** Reviewed `plan:3d31f36a3e72f15d`. Lint: 0 errors, 0 warnings.
Oriented on: the whole document — a first pass.
Applied: **root cause** — the plan's four flash candidates all missed the mechanism the code actually documents. `CommitMessage` → `TugMarkdownText` → `useAnnotatedElement` paints twice by design: a pass meeting a `pending` resolver verdict leaves the text plain and stamps `data-tugx-awaiting`, and a verdict batch (`annotate-content.ts` says ~100ms) re-runs the pass over awaiting containers. The reported body is full of verdict-dependent tokens (`[D152]`, `verify.rs`, `at0445`), so it paints plain and then re-marks. Added as the leading candidate in a new [#annotator-two-phase] deep dive, with the `/commit`-receipt discriminator (`session-commit-receipt-block.tsx` uses the same hook) as the cheap test that decides whether the cause is shared or join-specific. **Candidate demoted** — the plan ranked live/restored duplication first; `_restoreFetch.refresh()` fires only when the replay window's floor moves older or from the load-control bar, so a join never triggers it on its own, and it is now candidate (d) with the trigger stated. **New defect, confirmed from the code** — `buildShellTurnEntry` keys turns `` `shell-${exchangeId}` `` while the live append mints `landing-<ts>-<rand>` and the restore mints `restored-<sqlite id>`, so a load-previous after a join seats a duplicate receipt; folded in as [P06] with [L26] named as its constraint, and it now carries the step's failing-today unit pin. **Spec S01 regrounded** — the plan told the implementer to follow the `/tugplug:draft` standard, but that skill's literal template is a ≤50-char subject plus terse bullets, materially thinner than the house style it points at; an implementer following the template would have made dash messages worse than `a18557090`. S01 now states the rule in full and names `a18557090` as the in-tree exemplar against `51bb1eaae` as the counter-example ([P07]), and reconciles "and why" against `/draft`'s explicit ban on invented benefit claims. **Success criteria** — the `rg "rounds digest"` check would have passed while the doctrine still blessed the habit, since the doctrine never uses that literal phrase; widened to `digest` with a read of all four hits. Also added the `cd tugrust` the nextest checkpoint needed (verified: the filter lists exactly five tests), the State Zone Mapping's missing turn-identity row plus a per-law cross-check ([L02], [L03], [L06], [L26], [L22], [D111]), and a risk covering skills running from the app bundle.
Deferred: nothing was deferred to an Open Question. Two scope calls were raised as dialogs during the round and both were settled: the flash's reach is bounded to a join-specific cause ([P05], the owner declining a general annotator change), and the duplicate-row defect was folded in rather than cut to the closure sweep ([P06]).

---

### Phase Overview {#phase-overview}

#### Context {#context}

Both defects were observed live on the 2026-08-22 `unified-changes` join. First: the landed commit's body is a rounds digest — "DashJoinPrompt becomes DashJoinOffer…", "at0445 is rewritten…" — process narration a reader six months from now cannot use, while every `/commit` landing carries a durable message authored to the `/tugplug:draft` standard. This is not an authoring accident; "subject + rounds digest" is the **prescribed** style, verbatim, in `tugplug/skills/dash-implement/SKILL.md` (the write-the-draft instruction in its implement phase and again in its verify-the-fit phase), in `tugplug/skills/dash-on/SKILL.md` (two `tugutil draft set` templates plus its composition-rules paragraph), and in `tugplug/skills/dash-join/SKILL.md` (the no-draft chip's placeholder), and `tuglaws/dash-work-doctrine.md`'s "Stop before the join" section blesses composing "from what the rounds actually did." A join squashes to **one commit** and the draft is its only durable prose ([D144]) — which is exactly why that prose must describe the change, not the run.

Second: on a live join the `/dash-join` receipt row visibly presents one way and then transforms — a FOUC on the one row that records a landing. The pipeline is mapped in [#receipt-pipeline], and the reading moved the suspect list twice. The originally-suspected in-flight generic render is **disproven**: both the live append and the ledger restore ingest fully-settled rows, so `parseJoinReceipt` never sees a partial summary. The likeliest cause is instead the **content annotator's deliberate two-phase paint** ([#annotator-two-phase]) — which is shared machinery, not join-specific, and therefore bounded by [P05] rather than fixed here on sight.

A third defect surfaced during that reading and is in scope by decision ([P06]): the live receipt append and the ledger restore mint **different `turnKey`s for the same landing** (`shell-landing-<ts>-<rand>` vs `shell-restored-<sqlite id>`), so a load-previous page after a join seats a duplicate receipt row rather than upserting the one that exists.

#### Strategy {#strategy}

- Fix the words at their source: rewrite the digest prescription in the doctrine and all three dash skills to the standard in [Spec S01](#s01-message-standard), stated once as a compact rule each skill carries whole (skills must stand alone on projects without `tuglaws/`), grounded in an in-tree exemplar rather than in a cross-document pointer.
- Do not touch the Rust composition path — `integrate_message` / `compose_landing_subject` / `strip_dash_scope` in `tugrust/crates/tugdash-core/src/ops.rs` are correct and covered by the `integrate_message_*` test block; verify by running that block, change nothing.
- Root-cause the receipt flash by reproduction against the mapped pipeline, working the ranked candidates in [#receipt-pipeline]. The fix is bounded by [P05]: a join-specific cause is fixed here; a shared-machinery cause is named, recorded, and handed on.
- Fix the duplicate-receipt defect ([P06]) regardless of what the flash turns out to be — it is confirmed from the code, lives on the same row, and is small.
- Keep it small: one prose step, one deck step, one integration checkpoint.

#### Success Criteria (Measurable) {#success-criteria}

- `rg -n "digest" tugplug tuglaws` returns no match that prescribes a run narration — the four occurrences today are the three skills' `<subject + rounds digest>` placeholders plus the doctrine's [D144] paragraph, and each reads as Spec S01 afterwards (grep + prose read, Step 1). Note the doctrine never uses the literal phrase "rounds digest", so a grep for that string alone would pass while the doctrine still blessed the habit — grep on `digest` and read the four hits.
- `cd tugrust && cargo nextest run -p tugdash-core -E 'test(integrate_message)'` green (the five `integrate_message_*` tests) with zero source changes under `tugrust/` (Step 1).
- The receipt flash has a named root cause recorded in Step 2's commit message, and the disposition [P05] prescribes for that cause was taken (Step 2).
- A live join driven by at0436's machinery leaves exactly one `/dash-join` receipt row, rendered by `SessionJoinReceiptBlock` (not the generic fallback), with the landed sha and message — and still exactly one after a restore refresh, which is false today ([P06]) (Step 2).

#### Scope {#scope}

1. The landing-message standard: `tuglaws/dash-work-doctrine.md`, `tugplug/skills/dash-implement/SKILL.md`, `tugplug/skills/dash-on/SKILL.md`, `tugplug/skills/dash-join/SKILL.md`.
2. The `/dash-join` receipt row's first-paint stability in tugdeck, to the boundary [P05] draws.
3. One landing, one transcript turn — the live-append / ledger-restore `turnKey` collision ([P06]).

#### Non-goals (Explicitly out of scope) {#non-goals}

- Rewording any landed commit message — history is history.
- Changing the server's join-summary wire format (`format_join_summary` in `tugrust/crates/tugcast/src/feeds/changeset.rs`) or the receipt row's parsed anatomy.
- Changing the landing-message precedence (draft → description → `Dash work`) or the lands-as provenance UI in the Changes shade.
- Any change to `integrate_message` / `compose_landing_subject` / `strip_dash_scope` — verify only ([P04]).
- The `/tugplug:draft` skill's own text: it is the main lane's authority and is read for reference, not edited. (Spec S01 does not simply cite it — see [P07] for why.)
- Changing the content annotator's two-phase paint, if that is what the flash turns out to be — [P05] draws that boundary and hands it on rather than absorbing it.
- The `/commit` receipt block (`session-commit-receipt-block.tsx`), except as the comparison surface Step 2's reproduction uses to tell a shared cause from a join-specific one.

#### Dependencies / Prerequisites {#dependencies}

- `roadmap/unified-changes.md` landed (the shade-as-decision-surface join arc, [D152]) — the join flow this plan's receipt work observes.
- at0436-join-press's scratch-repo join machinery (`tests/app-test/at0436-join-press.test.ts`), which drives a real land and asserts a commit on the base.

#### Constraints {#constraints}

- tugplug skills and hooks run **from the app bundle**, not the repo — repo edits to `tugplug/` are inert until an app rebuild; to exercise an edited skill live, copy it into the bundle or rebuild.
- Skills must remain standalone: on a project without `tuglaws/`, a skill cannot cite the doctrine for its rules, so each skill carries the whole rule inline ([P01]).
- Warnings are errors; app-tests selective via `just app-test-changed`; app-tests that mutate a checkout own a scratch repo, never the developer's.

#### Assumptions {#assumptions}

- The flash reproduces on a driven join (it was observed on a real one on 2026-08-22). If Step 2's reproduction cannot surface it, the step says so and records the non-reproduction; [P06]'s fix and its tests land regardless, because that defect is confirmed from the code rather than from the report.
- The flash's cause is one of the five ranked candidates in [#receipt-pipeline]. If it is none of them, the reading in that section is wrong, and the step corrects it there rather than working around it.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None — the invocation settled the design (the `/draft` standard is the target, the Rust path is out of scope), and the remaining unknown (the flash's mechanism) is a root-cause task, not a design question.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| The flash does not reproduce under the app-test harness | med | med | Reproduce on a debug build by hand first; the `/commit` discriminator needs no harness | Step 2 reproduction fails |
| Four inline copies of the message rule drift over time | low | med | One canonical statement in the doctrine; skills carry the same compact wording; doctrine is tiebreaker | A future skill edit reopens the wording |
| [P06]'s re-key remounts existing restored rows | low | med | Prefer a derivation that leaves `restored-<id>` rows keyed as they are today and moves only the live append onto the shared identity | The chosen identity would change already-mounted rows |
| Step 1's rewrite lands but the running app keeps the old prose | low | high | Skills execute from the app bundle; the next `just app-debug` / release build picks them up. Say so in the round; do not test skill text by running a skill from the repo | A run after Step 1 still writes a digest |

**Risk R01: The transform may be invisible to a background app-test** {#r01-background-observability}

- **Risk:** Background app-test windows run no rAF and suppress animation, so a transient one-or-two-frame presentation may be unobservable in the harness even when real.
- **Mitigation:** Root-cause by hand on a debug instance; once the mechanism is known, pin it at the layer where it is deterministic (store/unit test on the ingest or render gate), and let the app-test assert the durable outcome (one bespoke receipt row, correct content).
- **Residual risk:** The pixel-level transient itself is pinned indirectly, via its mechanism — stated honestly in the test's docblock rather than faked.

---

### Design Decisions {#design-decisions}

#### [P01] One landing-message standard, stated per-skill, arbitrated by the doctrine (DECIDED) {#p01-one-standard}

**Decision:** The join draft is authored to the same standard as the main lane's `/tugplug:draft` output: an imperative subject in the repository's recent-commit style, then a body that describes what the landed change does to the tree and why — never a narration of the run, never a round-by-round digest. The canonical statement lives in `tuglaws/dash-work-doctrine.md`'s "Stop before the join" section; each dash skill carries the same compact rule inline, whole.

**Rationale:**
- A join lands one commit and the draft is its only durable prose ([D144]); prose about the process documents nothing the tree's reader can use.
- Skills run on projects with no `tuglaws/` (the dash-generality degrade-by-name discipline), so a skill that pointed at the doctrine instead of carrying the rule would go mute exactly where it is needed.
- The doctrine as tiebreaker bounds the drift risk of inline copies (Risk in [#risks]).

**Implications:**
- Every `tugutil draft set --owner dash:<name>` template in the skills drops the `<subject + rounds digest>` placeholder for a `<subject + durable body>` one, with the rule beside it.
- The bare-subject rule (no `tugdash(<name>): ` prefix — the join adds the scope via `compose_landing_subject`) survives unchanged.

#### [P02] The round count is the receipt's fact, not the message's (DECIDED) {#p02-rounds-are-receipt-facts}

**Decision:** The landed message carries no round inventory. The count already rides the receipt row's badge (`resultSummary` count in `SessionJoinReceiptBlock`), the `Tug-Dash:` trailer names the branch and base, and the dash branch's own log holds the rounds until the join sweeps it.

**Rationale:**
- Duplicating a derivable fact into permanent prose is the digest habit in miniature.

**Implications:**
- The rewritten skill prose says this explicitly, so a future author does not reinvent the digest to be "thorough."

#### [P03] The receipt's first paint is its final form (DECIDED) {#p03-first-paint-final}

**Decision:** The initiating client's `/dash-join` row mounts in its settled, bespoke form and never re-presents. The fix is whatever the root cause demands, within [P05]'s boundary — but it must not add client state ([#state-zone-mapping]), and a settled row that fails to parse as a receipt still falls back to the generic block (old and truncated rows keep rendering).

**Rationale:**
- The receipt is the durable record of a landing; a row that visibly changes shape teaches the user its first form was a lie.

**Implications:**
- Root-cause precedes fix; the commit message names the mechanism.
- The parse-miss fallback in `session-join-receipt-block.tsx` survives — it exists for rows written before the format, and [D111] demands raw output always render.

#### [P05] The flash is fixed here only if its cause is join-specific (DECIDED) {#p05-flash-boundary}

**Decision:** Step 2 reproduces the flash and names its mechanism unconditionally. If the mechanism is **join-specific**, it is fixed in this plan. If the mechanism is **shared machinery** — the content annotator's verdict round-trip ([#annotator-two-phase]) being the leading candidate — this plan records the finding, changes nothing there, and hands it on to a follow-on; the flash may survive this plan, and that is the accepted outcome.

**Rationale:**
- Decided by the owner during review, 2026-08-22, against the alternatives of a general annotator fix and a receipts-only special case.
- The annotator's two-phase paint is a documented, deliberate trade-off ("holding the run for one verdict batch costs a moment of plain text and buys a right answer" — `tugdeck/src/lib/annotator/annotate-content.ts`). Changing it is a transcript-wide behavior change that has to argue for itself in its own plan, not ride in on a join fix.
- A receipts-only gate would grow a special case beside shared machinery — the shape the rubric's does-this-leave-the-architecture-better test rejects.

**Implications:**
- Step 2's outcome is honest either way: "named and fixed" or "named and handed on". Neither is a failed step.
- The discriminator is cheap and mandatory: the `/commit` receipt (`session-commit-receipt-block.tsx`) uses the same `useAnnotatedElement` hook, so if it flashes identically, the cause is shared.
- [P06] is unconditional and does not wait on this — it is a separately confirmed defect.

#### [P06] One landing, one transcript turn (DECIDED) {#p06-one-landing-one-turn}

**Decision:** A landing's receipt occupies exactly one `TurnEntry` no matter which path delivered it. The live append (`use-landing-receipts.ts`, `exchangeId: "landing-<ts>-<rand>"`) and the ledger restore (`applyRestoredShellExchanges`, `exchangeId: "restored-<sqlite id>"`) must resolve to the **same** `turnKey` for the same ledger row, so `upsertInkTurn` settles in place instead of inserting a second copy.

**Rationale:**
- Confirmed from the code during review: `buildShellTurnEntry` derives `turnKey` as `` `shell-${msg.exchangeId}` ``, and the two paths mint unrelated `exchangeId`s for one landing. A load-previous page after a join (which moves the replay-window floor older and calls `_restoreFetch.refresh()` in `shell-session-store.ts`) therefore seats a duplicate receipt.
- Folded into this plan by the owner during review, 2026-08-22, rather than deferred to the closure sweep: it is the same row, and small.

**Implications:**
- The identity has to come from something both paths know. The ledger row's own identity is the obvious carrier and the server already holds it — a live append that learns its ledger row id, or a derivation both sides can compute from the summary + session, are both admissible; the step picks one and says why.
- [L26] governs: `TurnEntry` identity must stay stable across the change, so restored rows already in a transcript must not all re-key and remount. A migration-free derivation is preferred; if existing rows would re-key, the step says so and confines it to rows for landings.
- The app-test's restore-refresh assertion is the pin, and it fails today.

#### [P07] Spec S01 is grounded in an in-tree exemplar, not in a cross-document pointer (DECIDED) {#p07-exemplar-not-pointer}

**Decision:** The rewritten skill and doctrine prose states the standard in its own words and names `a18557090` as the in-tree exemplar of a good join message. It does **not** instruct the author to "follow `/tugplug:draft`'s format".

**Rationale:**
- Read during review: `tugplug/skills/draft/SKILL.md`'s literal template is a ≤50-char subject plus terse bullets ("what was done", "key files changed"), while the repository's actual recent-commit style — which that same skill names as the style reference — is considerably richer (`06933d51e`, `a18557090`: a prose argument, then what landed, then how it was proven). An implementer told to "follow the `/draft` format" would read the template and make dash messages *worse* than `a18557090` already is.
- A pointer across documents also breaks on projects without tugplug's draft skill, which the skills must survive.

**Implications:**
- Spec S01 carries the rule in full, plus the exemplar's sha and what makes it good.
- `draft/SKILL.md` stays unedited ([#non-goals]); the two lanes agree in substance without either citing the other.

#### [P04] The Rust composition path is verified, not rebuilt (DECIDED) {#p04-rust-verify-only}

**Decision:** `integrate_message`, `compose_landing_subject`, `landing_message_preview`, and `strip_dash_scope` in `tugrust/crates/tugdash-core/src/ops.rs` change by zero bytes. Step 1 runs their existing test block (`integrate_message_*`: own-prefix no-doubling, foreign-scope strip, inner-mention untouched, malformed-scope whole, bare-fallback wrap) as its verification that the composition already does the right thing to a `/draft`-standard body.

**Rationale:**
- The subject-side behavior (scope strip + re-wear, trailer append) is correct today; the defect is entirely in what prose the skills put into the draft.

**Implications:**
- If Step 1's run of that block is red, the plan stops — that is a pre-existing defect outside this plan's scope, reported rather than absorbed.

---

### Deep Dives {#deep-dives}

#### The receipt pipeline, as read on 2026-08-22 {#receipt-pipeline}

The full path of a `/dash-join` receipt row, with file:symbol names, so Step 2's root-cause starts from facts rather than re-discovery:

1. **Server, land:** `AgentSupervisor` (`tugrust/crates/tugcast/src/feeds/agent_supervisor.rs`) completes the join, formats the summary once via `format_join_summary` (`feeds/changeset.rs` — header `joined <sha> · <dash> → <base> · <N> round(s)`, then the landed message), persists it to the shell ledger via `record_landing_receipt` → `ShellLedger::record_exchange` with `started_at_ms == settled_at_ms` and `exit_code 0` (**settled at birth** — the ledger write broadcasts nothing), and sends `changeset_join_ok { summary, … }` on CONTROL.
2. **Client, live append:** `changeset-verb-store.ts` folds `changeset_join_ok` into `joinState(key)` with `phase: "done"` and the `summary`. `use-landing-receipts.ts` (mounted per Session card, [L22] store→store subscription) observes the `done` edge and calls `codeSessionStore.ingestShellExchange({ phase: "complete", exchangeId: "landing-…", output: summary, … })` — a **bare-complete**: `shellMessage` in `code-session-store/reducer.ts` builds the message with `output`, `exitCode`, and `settledAtMs` all populated, and `upsertInkTurn` inserts the turn at its timestamp. There is no in-flight frame on this path.
3. **Client, restore:** `applyRestoredShellExchanges` (`shell-session-store.ts`) mints ledger rows as bare-completes keyed `restored-<sqlite id>` — also settled at first paint. The live copy and the restored copy of the *same* landing have **different `turnKey`s** (`shell-landing-…` vs `shell-restored-<id>`); on a reload only the restored copy exists, but a `refreshRestore()` while the live copy is mounted could seat a second copy of the same fact.
4. **Render:** `session-card-transcript.tsx` resolves the row through `resolveCommandBlock` (`session-command-block-registry.ts`, first-match in registration order); `SessionJoinReceiptBlock` (`session-join-receipt-block.tsx`) parses the summary with `JOIN_HEAD_RE` (exact `·` U+00B7 and `→` U+2192) and renders `BlockChrome variant="receipt"` — or returns the generic `ShellExchangeBlock` on a parse miss. Registration is an import side effect beside the commit block's import in `session-card-transcript.tsx`.
5. **Adjacent narration:** the composer's join register (`join-mode-controller.ts` `narration`, retiring after `SETTLED_REST_MS`) and the shade's inline join surface both present the terminal "joined" beat, whose `detail` is the **same summary string** (`changeset-join-store.ts`, `changeset_join_ok` arm) — so the message text legitimately appears on an ephemeral surface moments before/while the durable row exists.

**What this disproves:** the "generic block while output settles" theory. Both ingest paths deliver settled rows; `parseJoinReceipt` never sees a partial summary on either.

The candidate mechanisms Step 2 checks, in order of plausibility as established by the review's reading:

- **(a) The annotator's two-phase paint** — leading candidate, code-confirmed as a real mechanism (though not yet as *the* cause). Detailed in [#annotator-two-phase]. This is shared machinery, so [P05] bounds what happens if it wins.
- **(b) Adjacent-surface handoff:** the composer's join register and the shade's inline join surface present the terminal beat whose `detail` **is the same summary string** (item 5), then retire after `SETTLED_REST_MS`, while the durable receipt row appears in the transcript. A perceived transform across two surfaces rather than one row repainting — and it matches the reported symptom's wording closely.
- **(c) Insertion motion:** `upsertInkTurn` seats the live row at `Date.now()` while surrounding turns settle around it — a reflow or reorder reading as a flash rather than a chrome swap.
- **(d) Two copies of one fact:** the `[P06]` duplication. **Demoted during review**: it is a genuine defect (and is fixed in this plan), but it is *not* triggered by a join on its own. `_restoreFetch.refresh()` fires only when the replay window's floor moves **older** — the first `replay_complete`, or a "load previous" page — or from the load-control bar's explicit refresh (`session-load-control-bar.tsx`). A landing does not move the floor older, so on a plain join no second copy appears. It surfaces after a subsequent load-previous or reload+page.
- **(e) A genuinely unsettled first frame** — believed impossible by the reading above; check last, and if found, this section's reading is wrong and gets corrected in the step.

#### The annotator's two-phase paint {#annotator-two-phase}

The receipt body renders through `CommitMessage` → `TugMarkdownText` → `useAnnotatedElement` (`tugdeck/src/components/tugways/annotation-scope.tsx`), and the session transcript mounts the `AnnotationScope` provider that makes the hook live. The annotator is **designed** to paint twice, and its own module docstring says so:

- The first pass runs in `useLayoutEffect` ([L03]). Marks that need a resolver — `resolvePath` for file paths, `resolveCommit` for shas, `resolveSession` for callsigns — can come back `pending`, and a `pending` verdict produces **no mark and byte-identical text**, deliberately: *"Every refusal is silent"*, and the hold *"costs a moment of plain text and buys a right answer."*
- A pass that met a pending verdict stamps its container `data-tugx-awaiting`. When a verdict batch arrives — the docstring puts it at *about 100ms* — `containerAwaitsVerdicts` re-runs `annotateElement` over just those containers.

So a receipt body containing verdict-dependent tokens paints plain, then re-marks ~100ms later. The 2026-08-22 `unified-changes` landing body is full of them — `[D152]`, `verify.rs`, `join-prompt-inline.tsx`, `join_pilot.rs`, `at0445` — which is exactly the "transforms into the durable commit message" the report describes, and it arrives all at once as a large block rather than streaming in.

**The discriminator, and it is cheap:** `session-commit-receipt-block.tsx` calls the same `useAnnotatedElement` hook. If a `/commit` receipt with a comparable body flashes the same way, the cause is the shared annotator and [P05]'s hand-on arm applies. If only `/dash-join` flashes, the cause is join-specific and is fixed here. Run this comparison **before** reaching for any fix.

#### Where the digest prescription lives, verbatim {#digest-sites}

The exact prose Step 1 rewrites — found by `rg -n "rounds digest" tugplug tuglaws` plus a read of the surrounding paragraphs:

- `tugplug/skills/dash-implement/SKILL.md` — the implement-phase instruction ("Compose it from the run's rounds per phase 3's rules (bare subject, rounds digest)") with its `tugutil draft set … "<subject + rounds digest>"` template, and the verify-the-fit paragraph ("a subject line naming the plan's deliverable, then a terse digest of what the rounds landed") with the same template.
- `tugplug/skills/dash-on/SKILL.md` — two `"<subject + rounds digest>"` templates and the composition-rules paragraph ("an imperative subject under 50 chars naming the deliverable, then a terse factual digest"). The bare-subject, no-hard-wrap, and no-attribution rules in that paragraph are kept.
- `tugplug/skills/dash-join/SKILL.md` — the no-draft chip: `` `tugutil draft set --owner dash:<name> --message "<subject + rounds digest>"` ``. The surrounding refusal ("do not compose the message yourself") is kept — it is authorship discipline, not digest style.
- `tuglaws/dash-work-doctrine.md`, "Stop before the join" — "compose the squash message from what the rounds actually did" and the [D144] paragraph. Note the [D144] paragraph already argues *against* leaning on round commits; the rewrite completes that argument by dropping the digest as the recommended form.

---

### Specification {#specification}

**Spec S01: The landing-message standard** {#s01-message-standard}

The rule each skill carries, and the doctrine states canonically (wording may be tuned to each document's voice; the content is fixed). Per [P07] it is stated in full rather than delegated to `/tugplug:draft`:

> The draft is a durable commit message, held to the same standard as the main lane's: an **imperative subject** in the repository's recent-commit style, then a **body describing the change the base branch is about to carry** — what it does, and the argument behind it — written for a reader who never saw the run. Never a narration of the run: no round-by-round digest, no step numbers, no "the run did X then Y", and no archaeology about defects the run found and fixed along the way. The round count is the receipt's fact, not the message's ([P02]). The subject is **bare** — no `tugdash(<name>): ` prefix; the join wears the scope itself. No hard-wrapped lines, no AI or agent attribution, ever.

**The "why" that belongs, and the one that does not.** The design argument a change embodies is part of what the change *is*, and the house style carries it. What is banned is the invented benefit claim — `/tugplug:draft` names `"… to improve accessibility"` as a bad message precisely because it tacks an inferred take onto a diff. State the argument the work actually rests on; do not append a rationale to make a change sound worthier.

**The exemplar is in the tree.** `a18557090` (`tugdash(dash-generality): Make the dash/join workflow project-general`) is a dash join whose message is right: four short paragraphs that say what a project can now declare, what routes through it, which boundary was held, and how it was proven — no round list, no test-file archaeology, nothing that requires having watched the run. Contrast `51bb1eaae`, the message this plan is a response to: same shape, but its bullets narrate the run's artifacts and its own debugging history. Both were written by dash runs under the same instruction, which is the evidence that the instruction is what needs changing.

Also part of the contract: `dash-implement`'s two draft moments (before closing the final declared step; re-opened at verify-the-fit only when the ending added rounds or no draft exists) keep their timing rules — only the composition prose changes.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Receipt row presentation — derived from `ShellExchangeMessage` fields already in the store (`output`, `settledAtMs`); [P03] forbids new client state | appearance | render-time derivation over the existing snapshot; no React state for how a row looks | [L02], [L06] |
| A landing's turn identity ([P06]) — the `turnKey` both delivery paths must agree on | structure | derived inside the reducer's `buildShellTurnEntry` / the ingest callers; `upsertInkTurn` settles by key | [L26], [L02] |
| Annotation marks on the receipt body (existing, untouched) | appearance | DOM attributes written in `useLayoutEffect` by the annotator | [L03], [L06] |

**Law cross-check.** [L02] — nothing here reads external state outside `useSyncExternalStore`; `use-landing-receipts.ts` is a store→store subscription, which is [L22]'s sanctioned shape and stays one. [L06] — the receipt's appearance stays CSS+DOM; any first-paint fix must not become a React state flag for "settled". [L26] — [P06] changes turn identity and is the law's direct subject: existing mounted rows must not all re-key. [L03] — the annotator's `useLayoutEffect` timing is load-bearing for the transcript's delegated listeners and is not to be moved. [D111] — the receipt row records the user's act and is not session context; the parse-miss fallback keeps raw output always rendering.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | One landing yields one turn ([P06]) — the identity both delivery paths must agree on | Step 2; fails today, which is what makes it worth writing |
| **Integration (app-test)** | A driven join leaves exactly one bespoke receipt row with the landed content, stable across a restore refresh | Step 2, on at0436's scratch-repo machinery |
| **Existing Rust** | `integrate_message_*` block proves the composition path over Spec S01 bodies | Step 1, run-only |
| **Manual comparison** | The `/commit`-vs-`/dash-join` discriminator that decides [P05]'s arm | Step 2, before any fix; recorded in the round, not automated |

#### What stays out of tests {#test-non-goals}

- Pixel-level observation of the transient flash — background app-test windows run no rAF, so a one-or-two-frame presentation is not reliably observable there; the app-test asserts the durable outcome and the docblock says why. Stated honestly rather than faked.
- The annotator's two-phase paint itself — out of scope by [P05] unless the cause proves join-specific; a test written for it here would pin behavior this plan is not allowed to change.
- Prose assertions on skill wording beyond the `rg` read — skill text is judged by reading, not by string pins that rot on every edit.
- jsdom / RTL render tests — banned shape; the renderer's logic, if the fix lands there, is tested through exported pure functions (`parseJoinReceipt` already is).
- Reflexive per-mutator pins — the one new unit test exists because it fails today against a confirmed defect, which is the bar.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The landing message becomes durable prose | pending | — |
| #step-2 | One landing, one settled receipt row | pending | — |
| #step-3 | Integration Checkpoint | pending | — |

#### Step 1: The landing message becomes durable prose {#step-1}

**Commit:** `tugdash(join-landing-parity): the join draft speaks the /draft standard`

**References:** [P01] One landing-message standard, [P02] Rounds are receipt facts, [P04] Rust verify-only, Spec S01, (#digest-sites, #s01-message-standard)

**Artifacts:**
- Rewritten draft-composition prose in `tuglaws/dash-work-doctrine.md` and the three dash skills; no code changes.

**Tasks:**
- [ ] Rewrite `tuglaws/dash-work-doctrine.md`'s "Stop before the join" draft paragraphs to state Spec S01 canonically, folding it into the existing [D144] argument (the draft is the only durable prose the base carries — therefore it describes the change, never the run).
- [ ] Rewrite both draft moments in `tugplug/skills/dash-implement/SKILL.md` (the pre-close-of-final-step instruction and the verify-the-fit re-check) to Spec S01; replace both `"<subject + rounds digest>"` template placeholders with a durable-body placeholder; keep the timing rules and the bare-subject rule intact.
- [ ] Rewrite `tugplug/skills/dash-on/SKILL.md`'s two templates and its composition-rules paragraph to Spec S01, preserving the bare-subject / no-hard-wrap / no-attribution sentences.
- [ ] Update `tugplug/skills/dash-join/SKILL.md`'s no-draft chip placeholder; leave the whoever-worked-it-writes-it refusal intact.
- [ ] Read `tugplug/skills/draft/SKILL.md` once and confirm the two lanes now state the same standard; touch it only if it contradicts Spec S01 (not expected — it is the reference).
- [ ] Verify, not rebuild, the Rust composition ([P04]): run the `integrate_message` test block and confirm zero diffs under `tugrust/`.

**Tests:**
- [ ] Existing: `cargo nextest run -p tugdash-core -E 'test(integrate_message)'` — green, proving scope strip/re-wear and trailers over the bodies Spec S01 produces.

**Checkpoint:**
- [ ] `rg -n "digest" tugplug tuglaws` — every remaining hit reads as Spec S01, and none prescribes a run narration (the literal string "rounds digest" is gone; the doctrine's [D144] paragraph is rewritten rather than merely grepped past).
- [ ] `git diff --stat -- tugrust/` — empty ([P04]).
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -E 'test(integrate_message)'` — green; five tests run.

---

#### Step 2: One landing, one settled receipt row {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(join-landing-parity): one landing, one settled receipt row` (final wording names the flash's root cause)

**References:** [P03] First paint is final, [P05] Flash boundary, [P06] One landing one turn, Risk R01, (#receipt-pipeline, #annotator-two-phase, #state-zone-mapping)

**Artifacts:**
- The named root cause of the flash, and its fix if [P05] admits one; the `turnKey` collision fixed; a unit pin on the identity; an app-test assertion that a driven join leaves exactly one bespoke receipt row, stable across a restore refresh.

**Tasks:**
- [ ] **Run the discriminator first, before any fix.** Land a `/commit` with a body carrying verdict-dependent tokens (a file path, a `[D…]` ref) and watch its receipt; then watch a `/dash-join` receipt. Identical flash ⇒ shared annotator cause ([#annotator-two-phase]); only join flashes ⇒ join-specific. This one comparison decides which arm of [P05] the step takes, and it needs no harness.
- [ ] Reproduce and name the mechanism: drive a real join (at0436's scratch-repo machinery, or by hand on a debug instance) and observe the `/dash-join` row from land-press to rest, working the ranked candidates in [#receipt-pipeline] — (a) annotator two-phase, (b) adjacent-surface handoff, (c) insertion motion, (d) the [P06] duplicate, (e) unsettled first frame.
- [ ] Take [P05]'s prescribed arm. **Join-specific cause** → fix it per [P03]: the row mounts settled, bespoke, once, with no new client state and the parse-miss fallback preserved. **Shared-machinery cause** → change nothing there; record the mechanism and the evidence in the commit message, and add a follow-on line to [#roadmap]. Either way the mechanism is named — a step that ends "could not tell" has not finished.
- [ ] Fix [P06] unconditionally: make the live append and the ledger restore agree on one `turnKey` per landing, so `upsertInkTurn` settles in place. Name the identity chosen and why; honor [L26] by preferring a derivation that leaves already-restored rows keyed as they are.
- [ ] If the flash reproduces under neither the harness nor hand-driving, say so plainly and record the non-reproduction in the commit message. [P06] still lands; it is confirmed from the code, not from the report.

**Tests:**
- [ ] Unit (bun test): one landing yields one turn — feed the live-append shape and the restored-row shape for the same ledger row through the ingest path and assert a single `TurnEntry` survives. Fails today.
- [ ] App-test on at0436's fixture (or a sibling carrying `@covers` for every touched source): after the land settles, exactly one row matches the `/dash-join` receipt slot, it carries the landed sha and message, and it is not the generic fallback; then trigger a restore refresh (`refreshRestore()` via the load-control path or the test surface) and assert the count is still one.
- [ ] No pixel-level assertion on the transient — see [#test-non-goals]; the app-test asserts the durable outcome and the docblock says why.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build` — clean (the app-test serves the prod bundle).
- [ ] `bun test` (tugdeck) — green, including the new unit pin.
- [ ] `just app-test tests/app-test/at0436-join-press.test.ts` (plus the sibling if one was created) — VERDICT PASS.

---

#### Step 3: Integration Checkpoint {#step-3}

**Depends on:** #step-1, #step-2

**Commit:** `N/A (verification only)`

**References:** [P01], [P03], (#success-criteria)

**Tasks:**
- [ ] `tugutil dash replay <name>` — put the rounds on the live base, so what gets verified is what would land.
- [ ] `Replayed` / `Recorded`: verify the replayed tree with the project's declared verify command (`tugutil dash config --json`), substituting `{base}`/`{head}` with the replayed range — in this repo, `sh scripts/verify-fit.sh {base} {head}`.
- [ ] `Current`: the base never moved, so the last step's checkpoint already verified these exact bytes — re-run nothing and say so.
- [ ] `Conflicted`: resolve the named round in the worktree, then verify as above.

**Tests:**
- [ ] None of its own. This step re-proves nothing the steps proved; it establishes that their work still holds on the base as it stands now.

**Checkpoint:**
- [ ] The replay reports its outcome, and the scoped verification is green **or** was correctly skipped as `Current`.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Dash joins land commits whose messages meet the repository's durable standard, the landing leaves exactly one receipt row however it was delivered, and the row's flash has a named mechanism — fixed here if it is the join's, handed on if it is the transcript's.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] No skill or doctrine text prescribes a run narration; all four documents state Spec S01 and name the in-tree exemplar (grep + read, Step 1).
- [ ] The Rust composition path is proven over the new bodies with zero source changes (existing test block, Step 1).
- [ ] The flash's mechanism is named in Step 2's commit message, and [P05]'s prescribed arm was taken — fixed, or recorded with a follow-on line in [#roadmap] (Step 2).
- [ ] A driven join leaves one settled bespoke receipt row, stable across restore refresh (unit pin + app-test, Step 2).

**Acceptance tests:**
- [ ] `integrate_message_*` block (Step 1); the one-landing-one-turn unit pin + the at0436 extension (Step 2).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] The annotator's two-phase paint, if Step 2 finds it is the flash's cause — a transcript-wide first-paint question ([P05] hands it here rather than absorbing it).
- [ ] Entry points into dash workflows (`roadmap/dash-entry-points.md`, next in the queue).
- [ ] The dash/join closure sweep (`roadmap/dash-join-tail.md`).

| Checkpoint | Verification |
|------------|--------------|
| Message standard everywhere | Step 1 checkpoint (grep + read, zero Rust diff, test block) |
| One landing, one receipt row | Step 2 (unit pin, then app-test across a restore refresh) |
| Flash mechanism named, [P05] arm taken | Step 2 (the `/commit` discriminator, recorded in the round) |
| Fit on the live base | Step 3 procedure |
