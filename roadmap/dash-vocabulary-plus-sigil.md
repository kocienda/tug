## Dash Vocabulary and the Dash Sigil {#dash-vocabulary-plus-sigil}

**Purpose:** Give the dash system one vocabulary — **bind / unbind** for the reversible session↔dash relationship, **discard** for the irreversible teardown, **unbound** for the state — spelled identically from the dash-log on disk up to the button face, and replace the dash sigil `#` with `◊` so it stops colliding with the transcript's message numbers.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-17 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-17, opus.** Reviewed `plan:3892005db1b03859`. Lint: 0 errors, 1 warning (fixed — this section).
Oriented on: the plan as authored this turn, read against `tugdash-core/src/{dash,ops}.rs`, `tugcast/src/feeds/{draft_engine,agent_supervisor,base_motion}.rs`, `tugcast/src/session_ledger.rs`, `tugdeck/src/lib/changeset-verb-store.ts`, `tugdeck/src/components/tugways/cards/session-join-receipt-block.{tsx,css}`, `tugdeck/src/components/lens/sections/dashes-section.{tsx,css}`, and the app-test corpus.
Applied: **[P07]'s rationale was factually wrong and is rewritten.** The plan claimed the compatibility clause would otherwise be duplicated across two dash-log parsers. Reading `read_dash_log` in `draft_engine.rs` shows it splits its four fields by hand, discards the marker into `_marker`, and **never calls `is_terminal` at all** — it has no generation reset, so a reused dash name feeds the previous incarnation's round notes into draft authoring. The fold is still right, but for a different and better reason, and it now fixes that defect explicitly, with a test and an acknowledged exception in the non-goals. **Sequencing — the plan contradicted itself.** [#strategy](#strategy) states that wire frames move on both sides in one commit; the steps split `changeset_release` across a tugcast step and a deck step. Steps 3–5 are restructured: Step 3 is now the whole Rust vocabulary (discard + unbound + CLI + the justfile sweep), Step 4 moves the frame *and* the receipt on both sides together, Step 5 is faces and slots only. **`parked` has a near-homonym inside the dash system.** `base_motion.rs` (3 sites) and `agent_supervisor.rs` (2 of its 4) say a dash is *parked behind* a busy session — replay-queue sense, and true of bound dashes too. The original Step 4 would have renamed them. Table T03 now enumerates both senses per file and Step 3 checkpoints on the exact surviving count. **Two coverage holes.** `at0419-join-receipt.test.ts` selects `release-receipt-block` and `release-receipt-detail` but its name says "join", so it was missing from every list; added to Table T02, Step 4, and Step 9. And the receipt block's real symbol surface (`RELEASE_HEAD_RE`, `ParsedReleaseReceipt`, `parseReleaseReceipt`, `matchesReleaseReceipt`, `SessionReleaseReceiptBlock`, two DOM slots, one CSS class, plus `session-join-receipt-block.css`) was summarized as "claims() and the parser"; Spec S03 now carries both head regexes literally and the inventory names each symbol. **Test-plan sanity.** Step 7's Tests block said the app-tests would run "or be deferred to Step 9 if this step runs on the worktree" — a checkpoint that cannot fail. Steps 2–8 *always* run on the worktree, so the running is unambiguously Step 9's; Step 7 keeps a deterministic `cmap` coverage check it can actually perform, and R04's pixel verification is now an explicit Step 9 task.
Laws cross-checked: **[L02]** honored — `changeset-verb-store` and the section-presence store stay module stores read through `useSyncExternalStore`; the rename moves no state into React. **[L06]** honored — `data-parked` → `data-unbound` stays a DOM attribute selected from CSS, not React state. **[L24]** honored — the State Zone Mapping now exists precisely to show that no renamed state changes zone; `pendingDiscard` stays view-scope. **[L31]** honored — `resolveBindTarget`'s refusal sentences are preserved in meaning and the tooltip stays anchored to a span rather than the disabled button, so the reason remains reachable. **[L19]** honored — no component is hand-rolled; the row keeps `TugListView`/`TugListRow`. **[L16]** not engaged — verified that `.lens-dashes-adopt`/`.lens-dashes-release` and `.join-receipt-header-release` set no color, so no `@tug-renders-on` annotation travels with the renames. **[L30]** deliberately not engaged — `/dash-discard` is a receipt string, not a user-invocable command, so no registry entry is added; the non-goals say so.
Deferred: **[Q01]** stays open by construction — whether `at0407-lens-dashes-section.test.ts` is repaired or retired is an empirical question that Step 1's baseline run answers, not a judgment call to put to the user. Its evidence (last touched at `5964a0a19`, predating the parked-dashes arc; docblock still describing the pre-projection roster) is recorded in the question so the implementer knows what to expect. The two naming forks that *were* judgment calls — the section title and the CLI hard break — were put to the user during authoring and landed as [P05] and [P04].

---

### Phase Overview {#phase-overview}

#### Context {#context}

The dash system speaks two vocabularies for the same operations, and the split runs along the UI/machine seam rather than along any conceptual one.

The machine already says **bind** and **unbind**. `tugutil dash bind` and `tugutil dash unbind` are real CLI subcommands (`DashCommands::Bind` / `DashCommands::Unbind` in `tugrust/crates/tugutil/src/cli.rs`). The CONTROL verbs are `bind_dash` and `unbind_dash`, parsed and handled in `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` (`parse_bind_dash_payload`, `do_bind_dash`, `do_unbind_dash`). The broadcasts are `bind_dash_ok` and `unbind_dash_ok`, and they are the *only* movers of the deck's `cardSessionBindingStore` — which is what leaves a card correctly bound to whatever it was when a bind is refused. The HTTP dash API takes `"bind"` / `"unbind"` actions (`tugrust/crates/tugcast/src/server.rs`, `tugrust/crates/tugcast/src/dash_api.rs`). The typed card verb is `/dash-bind`, registered in `tugdeck/src/lib/slash-commands.ts`. And the membership predicate for the Lens's own section is literally `bound_sessions.length === 0`.

The buttons say something else. The Changes card's dash lane offers **Adopt** and **Leave** (`tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx`); the Lens's section offers **Adopt** and **Release** (`tugdeck/src/components/lens/sections/dashes-section.tsx`); the section is titled **Parked Dashes** and its collapsed summary reads `2 parked`. Every one of those Adopt presses sends `bind_dash`. So today the UI maintains a translation layer over a vocabulary it did not need to translate, and a reader who moves between the CLI, the logs, and the buttons has to hold two dictionaries.

Three further facts make this more than a preference:

1. **`adopt` is already taken, in the same crate.** A *dash* adopts a *plan* — `tugutil dash adopt-plan`, `AdoptOutcome`, `adopt_plan_in`, `adopt_plan` in `tugrust/crates/tugdash-core/src/ops.rs`, with a whole "Plan adoption" section of doctrine in `tuglaws/dash-lifecycle.md`. A *card* adopting a *dash* is an unrelated homonym sitting beside it.

2. **`release` is the most overloaded word in the tree, and it connotes backwards.** It already means RAII teardown (`release_inputs` in `tugcast/src/router.rs`, `painter.release()` in `tugdeck/src/components/tugways/tug-sparkline.tsx`, `WorkspaceRegistry::release`) and build channel (`--release`, `target/release`, `Release/Tug.app`, the `release-main` instance). Worse, in plain English "release" sounds like *letting go* — which is precisely what `unbind` does — while `ops::release_in` deletes the branch and the worktree. It is the one irreversible act in the system wearing the gentler of the two available words. The confirm popover already knows this: its button says **Discard**, and `tuglaws/dash-lifecycle.md` already writes "the discard receipt".

3. **`#` collides.** The transcript numbers messages `#0001` and marks turns `#u12` (`tugdeck/src/components/tugways/tug-transcript-entry.tsx`), and markdown headings are hashes. The dash sigil competes with both.

#### Strategy {#strategy}

- **Baseline before renaming.** The app-tests that pin the current names have to be green *first*, or a red test afterward cannot distinguish "the rename broke it" from "it never worked". This matters concretely: `tests/app-test/at0438-lens-parked-dashes.test.ts` has **never been executed** (it was authored on a dash worktree, and the harness refuses app-tests there), and `tests/app-test/at0407-lens-dashes-section.test.ts` is very likely already stale.
- **Move the persisted grammars first, and make them dual-accepting.** Two things on disk carry the old spelling — the `released` terminal marker in `dash-log.md` and the `/dash-release` receipt command in session JSONL. Neither can be rewritten, so both readers accept the old spelling forever while the writers move to the new one. This lands ahead of everything else, so no later step can strand data.
- **One parser before one marker.** The dash-log grammar currently has two independent parsers. Fold them into one *before* the marker changes, so the compat clause is written once rather than duplicated.
- **Rust up, then the deck, then the docs.** Each layer's rename is its own commit with its own checkpoint. The wire frames (`changeset_release*`) change on both sides in one step, because the deck and tugcast ship in one app bundle and a split commit would be transiently broken.
- **The sigil is last and independent.** It touches one JSX text node and seven app-test string assertions; it depends on nothing else here and nothing else here depends on it.
- **Homonyms are excluded by hand, not by regex.** `release` and `parked` both have large innocent populations in this tree. Every step names its sites.

#### Success Criteria (Measurable) {#success-criteria}

- `rg -n '\bparked\b' tugrust/crates tugdeck/src tests/app-test` returns **only** the scroll/layout/pointer senses enumerated in **Table T03** — no dash-state use survives. (verify: run the command, diff against T03)
- No production symbol, wire frame, CSS class, `data-slot`, or user-visible string in the dash system contains `release`, `Adopt`, `Leave`, or `parked` in the dash sense. The only surviving `released` / `/dash-release` tokens are inside the two documented backward-compatibility reads and their tests. (verify: `just ci` plus the greps in **Step 9**)
- A `dash-log.md` containing a historical `released` line still resets the generation: `read_declarations` returns defaults for lines before it. (verify: unit test in `tugdash-core/src/dash.rs`)
- A session transcript containing a historical `/dash-release` receipt still renders as a receipt block rather than as a raw shell row. (verify: unit test over `session-join-receipt-block.tsx`'s `claims()` and parser)
- `tugutil dash release <name>` exits non-zero with clap's unrecognized-subcommand error; `tugutil dash discard <name>` does what `release` did. (verify: both invocations by hand)
- The app-test preamble still sweeps stranded `tugdash/at04??-*` fixture dashes. (verify: create a dash named `at0499-sweep-probe`, run any app-test, confirm the branch is gone and the sweep line printed)
- Every surface that names a dash renders `◊<name>`, with no tofu and no baseline shift. (verify: at0406/at0408/at0417/at0421/at0423/at0424/at0438 green, plus a screenshot read on the masthead run)
- `just ci` is green; `cargo nextest run` and `bun test` are green; `bunx vite build` and `tsc --noEmit` are clean.

#### Scope {#scope}

1. The reversible verb, everywhere it faces a person: **Adopt** → **Bind**, **Leave** → **Unbind**, in the Lens section and the Changes card's dash lane.
2. The irreversible verb, top to tail: **Release** → **Discard** — `ops::release`/`release_in`, `ReleaseOutcome`, `DashCommands::Release`, `run_release`, the `changeset_release{,_ok,_err}` frame trio, `useChangesetRelease`, the deck's release stores and notice controller, every `data-slot` and CSS class.
3. The state word: **parked** → **unbound**, in Rust prose and `dash status` output, in the Lens section's title and summary strings, and in every dash-sense identifier and `data-slot`.
4. The two persisted grammars: the `dash-log.md` terminal marker (`released` → `discarded`, both accepted on read) and the receipt command (`/dash-release` → `/dash-discard`, both claimed on read).
5. The dash sigil: `#` → `◊` (U+25CA LOZENGE).
6. The doctrine and tooling that name these verbs: `tuglaws/dash-lifecycle.md`, `tuglaws/dash-work-doctrine.md`, `tugplug/skills/dash-on/SKILL.md`, `tugplug/skills/dash-join/SKILL.md`, and the `justfile` fixture sweep.
7. Reconciling `tests/app-test/at0407-lens-dashes-section.test.ts` with the parked-only projection that landed in `54efc9ff4`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Renaming plan adoption.** `dash adopt-plan`, `AdoptOutcome`, `adopt_plan_in`, and the "Plan adoption" doctrine keep the word. Freeing it from the card verb is the *reason* it can stay unambiguous ([P02]).
- **Rewriting history.** No `dash-log.md` on disk is edited, and no session JSONL is rewritten. Compatibility is read-side only ([P03]).
- **Adding a typed `/dash-discard` verb.** Discard is shade-and-Lens-only by an existing ruling — there is deliberately no prompt-entry verb for it. `/dash-discard` appears **only** as a receipt command string, exactly as `/dash-release` does today.
- **Changing what any verb does.** This is a naming change end to end. No gate, refusal, confirm shape, hand-back, or partition rule moves. **One exception, taken deliberately:** folding the two dash-log parsers ([P07]) applies the generation reset that `read_dash_log` currently lacks, which changes draft-authoring input for a reused dash name. It is a defect found while reading the code this plan touches, it is a one-line consequence of the fold, and it carries its own test.
- **Renaming the innocent `release`s** — `release_inputs`, `painter.release()`, `WorkspaceRegistry::release`, `--release` / `target/release` / `release-main`.
- **Renaming the innocent `parked`s** — scroll position, pointer rings, sticky chrome, deferred activation (**Table T03**).
- **Renaming `bound_sessions`, `bind_dash`, `unbind_dash`, `/dash-bind`, or `cardSessionBindingStore`.** These are already correct; the UI moves to meet them.
- **Retiring old roadmap documents.** `roadmap/archive/**` and superseded briefs are history and are left alone.

#### Dependencies / Prerequisites {#dependencies}

- Work happens on a dash worktree created by `/tugplug:dash-implement`. **Step 1's app-test baseline cannot run there** — `just app-test` refuses from a linked worktree because `tugutil`'s dash verbs resolve the main repo root, so a fixture dash would be cut against the base checkout while the app under test has the worktree open. Step 1 is therefore run from the **main checkout, before the dash is created**. See [Q01] and **Risk R03**.
- The `parked-dashes` arc must be landed on `main` (it is, at `54efc9ff4`).
- `tugrust/target/debug/tugutil` must be built for the `justfile` app-test preamble sweep to work at all.
- `tugplug/` skills and hooks execute from **the built app bundle**, not the repo. Editing `tugplug/skills/*/SKILL.md` changes nothing until `just build-app`; verifying a skill edit live means copying it into `Tug.app/Contents/Resources/tugplug/`.

#### Constraints {#constraints}

- **Warnings are errors.** The Rust workspace enforces `-D warnings` via `tugrust/.cargo/config.toml`; `cargo build` and `cargo nextest run` fail on any warning.
- **App-tests are selective, never a sweep.** `just app-test-changed` derives the run from `@covers` declarations. The full corpus runs only on explicit request. Never pipe app-test output — the gate hook rewrites or denies it, and a filtered passing run exits 1.
- **Never open live ledger databases with the `sqlite3` CLI.** Use `just db-inspect`.
- **Only the user commits to `main`.** Dash worktree commits go through `tugutil dash commit`.
- **`tugutil dash join --resolve` lands.** Only `--preview` is a safe probe.
- Deck work obeys the tuglaws: [L02] external state through `useSyncExternalStore` only, [L06] appearance through CSS/DOM, [L19] compose `TugListView`/`TugListRow`, [L24] view-scope state, [L31] no gesture fails silently.
- Banned test shapes: no `happy-dom`, no `jsdom` render tests, no `@testing-library/react`, no mock-store assertion tests.

#### Assumptions {#assumptions}

- `dash-log.md` files are append-only and are never rewritten in place, so a read-side compatibility clause is sufficient and permanent. (Grounded: `append_dash_log` in `tugdash-core/src/ops.rs` only appends.)
- Session JSONL transcripts are replayed on every card reload, so historical `/dash-release` receipt rows will re-render indefinitely and their parser must keep claiming them.
- `changeset_release{,_ok,_err}` are live CONTROL frames with no persisted representation, so they can be renamed without a compatibility clause — the deck and tugcast ship together in one app bundle.
- IBM Plex Sans and IBM Plex Mono are the only faces that render the sigil. Verified: `Datatype-Variable.woff2` lacks U+25CA, but it is bound to `--tug-font-family-chart` and used only by `TugChartGlyph`.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings and rich `**References:**` lines. Plan-local decisions are `[P01]`–`[P07]`; the global set in `tuglaws/design-decisions.md` is cited as `[D##]` and the laws in `tuglaws/tuglaws.md` as `[L##]`. Steps cite anchors, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Is at0407 stale, and is it repaired or retired? (OPEN) {#q01-at0407-stale}

**Question:** `tests/app-test/at0407-lens-dashes-section.test.ts` asserts a round trip that the parked-only projection appears to have made impossible: that binding a real session to a dash *keeps the row in the Dashes section* and turns its parked mark into a phase dot, and that `dash unbind` returns it to the parked mark. Under the projection that landed in `54efc9ff4`, binding removes the row from the section entirely — that is the partition law. Is at0407 red today, and if so is it superseded by `at0438-lens-parked-dashes.test.ts` or does it hold assertions at0438 does not?

**Why it matters:** If at0407 is already red, and Step 1 does not establish that, then every later step in this plan inherits a red test it did not cause. The whole point of a baseline is to make the rename's failures legible.

**Evidence gathered:** `git log -- tests/app-test/at0407-lens-dashes-section.test.ts` shows its most recent touch is `5964a0a19`, which **predates** the parked-dashes arc; the arc's landing commit `54efc9ff4` did not touch it. Its docblock still describes the section as "the roster" carrying "the parked → worked transition and out to the card". That is the pre-projection design.

**Options:**
- Retire at0407 — at0438 covers the partition law, the section's absence when empty, and the bind round trip, which is the intersection of what at0407 was pinning.
- Repair at0407 — keep whatever it pins that at0438 does not (the review-mark staleness transition over a real `plan stamp` looks unique to it) and drop the transition assertions the projection invalidated.

**Plan to resolve:** [#step-1](#step-1) runs both files from the main checkout and reads the result. This is an empirical question, not a judgment call — the run answers it.

**Resolution:** OPEN — resolved by Step 1's baseline run, whose outcome dictates which of the two options Step 1 executes.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Historical `released` lines stop terminating the dash-log generation | high | high (certain, if unmitigated) | [P03] dual-accept; one parser first ([P07]); a unit test over a synthetic historical log | any change to `is_terminal` |
| The `justfile` fixture sweep silently stops sweeping | med | high (certain, if unmitigated) | Fix the invocation in the same step as the CLI rename; verify with a probe dash | any edit to the app-test preamble |
| at0407 is already red and reads as a rename regression | med | high | [#step-1](#step-1) baselines before any rename lands | — |
| Historical `/dash-release` receipts stop rendering as receipts | med | high (certain, if unmitigated) | `claims()` matches both spellings; unit test | any change to the receipt matcher |
| `◊` fails to paint in a baked atom chip | low | low | Pixel verification, not DOM text | any change to `tug-atom-img.ts`'s font stack |
| A regex-driven rename eats an innocent `release`/`parked` | high | med | Table T02 and Table T03 enumerate every site by hand; `just ci` catches the rest | — |

**Risk R01: The terminal-marker regression** {#r01-terminal-marker}

- **Risk:** `is_terminal` in `tugrust/crates/tugdash-core/src/dash.rs` matches `marker == "released"`. That is what resets a dash's declaration generation when a name is reused. Every `dash-log.md` in `~/Library/Application Support/Tug/projects/<slug>/` already contains `released` lines. If the writer emits `discarded` and the reader only matches `discarded`, those historical lines stop terminating — and stale declarations from a previous incarnation of a reused dash name bleed forward into the current one's stage, step, and `last_activity`.
- **Mitigation:**
  - `is_terminal` accepts `discarded` **or** `released`, permanently, with a comment that says the second spelling is history on disk and is not scheduled for removal.
  - The clause is written once, because [P07] folds the second parser into the first before the marker moves.
  - A unit test constructs a log whose terminal line is the *historical* `released` spelling and asserts the generation reset.
- **Residual risk:** A future reader written from scratch could match only `discarded`. The comment and the test are the guard; there is no type-level way to force it.

**Risk R02: The silent sweep** {#r02-silent-sweep}

- **Risk:** The `just app-test` preamble sweeps stranded fixture dashes with `tugrust/target/debug/tugutil dash release "$DASH_NAME" --json >/dev/null 2>&1 || true`. Both the error stream and the exit status are discarded — deliberately, because a legitimate refusal must never fail the run it is cleaning up for. Under a hard CLI break ([P04]) that line silently stops sweeping, and `tugdash/at04??-*` branches and worktrees accumulate with no signal at all.
- **Mitigation:**
  - Fix the invocation in the same step that removes the subcommand ([#step-3](#step-3)), so the two can never be separated by a commit.
  - Verify empirically: create `at0499-sweep-probe`, run one app-test, confirm the branch is gone and the `swept stranded fixture dash:` line printed.
- **Residual risk:** Any *other* `|| true` invocation of `dash release` outside the repo — a personal script — breaks silently. Unfindable from here and accepted; this is the cost the user chose with [P04].

**Risk R03: The baseline cannot run where the work happens** {#r03-baseline-worktree}

- **Risk:** `/tugplug:dash-implement` runs on a dash worktree, and `just app-test` refuses to run from one: `tugutil`'s dash verbs resolve the main repo root, so a fixture dash is created against the base checkout while the app under test has the worktree open — the dash could never appear, and the run dirties the base. `TUG_APPTEST_ALLOW_WORKTREE=1` bypasses the refusal but does exactly the damage the refusal describes. This is why at0438 was authored but never executed.
- **Mitigation:**
  - Run [#step-1](#step-1) from the **main checkout**, before the dash worktree exists. Its outcome (and any at0407 repair) is committed on `main` by the user, or carried into the dash with `--carry`.
  - Steps 2–8 verify with `cargo nextest run`, `bun test`, `tsc --noEmit`, and `bunx vite build`, all of which run fine from a worktree.
  - [#step-9](#step-9) is the app-test integration checkpoint and is likewise a main-checkout act, after the dash lands.
- **Residual risk:** The rename's app-test coverage is confirmed only at the end of the arc rather than continuously. Unavoidable given the harness constraint, and stated so nobody reads Step 9's position as an oversight.

**Risk R04: The baked atom chip** {#r04-baked-atom-chip}

- **Risk:** `tugdeck/src/lib/tug-atom-img.ts` paints atom chips with Canvas 2D and bakes them to a PNG data URL. A glyph missing from the Canvas font stack bakes as tofu or as nothing, and a DOM-text assertion cannot see it — this is the same class of failure as the italic-face-missing bug, where text was simply invisible.
- **Mitigation:**
  - `tug-atom-img.ts` documents that the Canvas shares the document's font set, and IBM Plex is `@font-face`'d, so U+25CA resolves — but verify with **pixels**, not with `textContent`.
  - [#step-7](#step-7) takes a screenshot of a bound session's atom and reads it.
- **Residual risk:** None material; `◊` is present in every Plex face the app bundles (**Table T04**).

**Risk R05: Homonym collateral** {#r05-homonym-collateral}

- **Risk:** `release` has ~270 occurrences in `tugrust/crates` and only about a third are the dash sense; `parked` is used throughout the deck for scroll offsets, pointer rings, deferred activation, and sticky chrome. A `sed`-style sweep would corrupt unrelated subsystems.
- **Mitigation:** **Table T02** enumerates every dash-sense `release` site and **Table T03** enumerates the innocent `parked` populations that must survive. Renames are per-site.
- **Residual risk:** A missed dash-sense site reads as an inconsistency rather than a break. Step 9's greps are the net.

---

### Design Decisions {#design-decisions}

#### [P01] Bind and unbind are the vocabulary, because the machine already speaks them (DECIDED) {#p01-bind-unbind}

**Decision:** The reversible session↔dash relationship is called **bind** / **unbind** on every surface. The Lens section's **Adopt** becomes **Bind**; the Changes lane's **Adopt** / **Leave** become **Bind** / **Unbind**.

**Rationale:**
- The rename removes a translation layer rather than adding one. `tugutil dash bind|unbind`, the `bind_dash`/`unbind_dash` CONTROL verbs, the `bind_dash_ok`/`unbind_dash_ok` broadcasts, the `"bind"`/`"unbind"` HTTP actions, `cardSessionBindingStore`, and the typed `/dash-bind` verb all predate this plan. Only the button faces disagreed.
- It frees `adopt` for its other, established meaning in the same crate — plan adoption ([P02]).
- `tuglaws/dash-lifecycle.md` already frames the concept this way: "A **bind** mates a live session to a dash… `bound_sessions` is a list… A bind is **never a landing authority**."

**Implications:**
- The Lens row's two controls are no longer symmetrical in kind — one binds, one destroys — which is exactly what [P02] exists to keep legible.
- No wire frame, store, or CLI verb changes for this half. It is a label change in two `.tsx` files plus their `data-slot`s and tests.

#### [P02] Release becomes discard, top to tail; plan adoption keeps the word "adopt" (DECIDED) {#p02-release-discard}

**Decision:** The irreversible teardown is called **discard** at every level — Rust symbol, CLI subcommand, wire frame, deck store, CSS class, `data-slot`, button face, receipt string, and dash-log marker. Separately, plan adoption (`dash adopt-plan`, `AdoptOutcome`, `adopt_plan_in`) keeps "adopt", which is unambiguous once the card verb gives it up under [P01].

**Rationale:**
- **Release is not unbind and must never read as its complement.** `ops::release_in` deletes the branch and the worktree. Once the button beside it says **Bind**, a button saying **Release** reads as the reversible complement, and a reflexive click destroys a worktree. `Discard` cannot be misread.
- **"Release" connotes exactly backwards.** In plain English it means letting go — which is `unbind`'s job. The system's one irreversible act was wearing the gentler of the two available words.
- **It is the most overloaded word in the tree.** RAII teardown (`release_inputs`, `painter.release()`, `WorkspaceRegistry::release`) and build channel (`--release`, `target/release`, `release-main`) are both live meanings. Retiring the dash sense removes a genuine homonym.
- **The code already leans this way.** The confirm button says `Discard`; `do_changeset_release`'s own doc comment reads "discard a dash (worktree + branch)"; `tuglaws/dash-lifecycle.md` writes "the discard receipt"; the lane's own slot is already `session-changes-dash-landing-discard`.
- `changeset_release` is verified dash-only — its payload is `(project_dir, dash)` — so renaming it drags no non-dash meaning along.

**Implications:**
- The receipt's first line, currently `released <dash> · discarded <N> round(s)`, must be reworded to avoid saying "discarded" twice.
- The dash-log terminal marker and the receipt command are persisted, so both get [P03] treatment.
- `release` stays a reserved dash name and `discard` joins it (**Spec S02**).

#### [P03] Persisted grammars accept both spellings forever; live wire frames do not (DECIDED) {#p03-dual-accept}

**Decision:** The two spellings that exist as history on disk — the `released` terminal marker in `dash-log.md` and the `/dash-release` receipt command in session JSONL — are **read** under both spellings permanently, while writers emit only the new one. Live CONTROL frames (`changeset_release{,_ok,_err}`) are renamed outright with no compatibility clause.

**Rationale:**
- The distinction is whether a message can be *re-read*. A dash-log is append-only and never rewritten; a session transcript is replayed from JSONL on every card reload. Both will surface pre-rename bytes indefinitely, and neither can be migrated without rewriting the user's history — which this plan does not do ([#non-goals](#non-goals)).
- A CONTROL frame is live: the deck and tugcast ship in one app bundle and are always the same build. There is no window in which one speaks the old name and the other the new.
- This is compatibility for *data you cannot rewrite*, which is a different thing from compatibility for a command you can simply fix — the distinction that makes [P04]'s hard break consistent rather than contradictory.

**Implications:**
- `is_terminal` matches `discarded || released`, with a comment stating the second spelling is history and is not scheduled for removal.
- `session-join-receipt-block.tsx`'s `claims()` matches `/dash-discard` and `/dash-release`.
- Each clause carries a test that feeds it the *historical* spelling.

#### [P04] The CLI breaks hard — no alias (DECIDED) {#p04-cli-hard-break}

**Decision:** `tugutil dash release` ceases to exist. `DashCommands::Release` becomes `DashCommands::Discard`, with no clap alias, hidden or visible. Every in-repo caller is fixed in the same step.

**Rationale:**
- The point of the change is that nothing named `release` lingers. An alias is precisely a lingering old name.
- The failure mode is loud: clap prints an unrecognized-subcommand error and exits non-zero. That is a good failure — unlike a `/verb` that stops matching the deck's registry, which gets submitted to Claude as a prompt and burns a turn. That asymmetry is why `slash-commands.ts` keeps retired spellings via `deprecatedFor` for `/dash` and `/join` while the CLI does not need to.
- There is no `/dash-release` typed verb to retire — discard is shade-and-Lens-only by an existing ruling, and `/dash-release` exists solely as a receipt command string.
- The user chose this explicitly over both a hidden and a visible alias.

**Implications:**
- **The `justfile` fixture sweep must be fixed in the same commit** — its `>/dev/null 2>&1 || true` would otherwise swallow the break ([R02](#r02-silent-sweep)).
- `tugplug/skills/dash-on/SKILL.md` and `tugplug/skills/dash-join/SKILL.md` name `tugutil dash release` in the rules that forbid running it on the agent's own initiative. Those rules break if their verb does not exist.
- Any personal script outside the repo breaks. Accepted.

#### [P05] The section is "Unbound Dashes" and its summary is "N unbound" (DECIDED) {#p05-unbound-dashes}

**Decision:** The Lens section titled `Parked Dashes` becomes `Unbound Dashes`. `dashesCollapsedSummary` returns `N unbound` and `No unbound dashes`. `tugutil dash status` prints `Sessions: none (unbound)`. Every dash-sense use of "parked" in prose, identifiers, `data-slot`s, and CSS class names becomes "unbound".

**Rationale:**
- One word for one state, and it is the word the predicate already uses: membership is `bound_sessions.length === 0`.
- "Parked" was a second name for the same fact, invented at the UI layer, with no counterpart anywhere below it.
- Chosen by the user over keeping a softer summary string; consistency beat the inbox connotation, and the section's docblock can carry the inbox framing in prose.

**Implications:**
- `SECTION_KIND` stays `"dashes"` — it is the registry key and the `sectionOrder` persistence key. Renaming it would orphan every saved Lens order in tugbank for no user-visible gain. This is deliberate and belongs in the section's docblock.
- `data-parked`, `lens-parked-*` slots, `.lens-dashes-*` classes, and `PARKED_RELEASE_KEY` all move, which moves at0438's and at0407's selectors with them.

#### [P06] The sigil is `◊` (U+25CA LOZENGE), chosen on metrics (DECIDED) {#p06-lozenge-sigil}

**Decision:** The dash sigil becomes `◊` (U+25CA). The rejected alternative was `∫` (U+222B INTEGRAL).

**Rationale (measured against the bundled `.woff2` faces — **Table T04**):**
- Coverage: IBM Plex Sans and IBM Plex Mono carry both candidates at Regular, Medium, and SemiBold. No fallback, no tofu.
- `◊` is metrically a drop-in for `#`: both sit at y=0 and reach y=698 in a 1000-unit em. Identical baseline, identical cap height. Advance 600 against `#`'s 713 — marginally narrower, no layout consequence.
- `∫` spans y=−200 to y=740: it descends a fifth of an em *below the baseline* and overshoots the cap. The identity run is `display: inline-flex; align-items: baseline` inside a title box that clamps and ellipsizes under `overflow: hidden` — a descender that deep is what gets clipped, or forces the line box open in the masthead.
- `∫` is 426 units wide against `#`'s 713: at rail sizes a thin vertical stroke reads as a stray italic *f* or a bracket, and it carries a loud "integral" meaning unrelated to dashes. `◊` means nothing yet, which is what a sigil wants.
- `#` had to go because the transcript already numbers messages `#0001` and marks turns `#u12`, and markdown headings are hashes.

**Implications:**
- One JSX text node in `tugdeck/src/components/tugways/dash-sigil.tsx`. The sigil is `aria-hidden`, display-only, never typed, never parsed.
- The `#` in `dash_owner_key` (`tugdash/<name>#<tugid>`) is an opaque ID grammar, not the sigil, and does **not** change.
- Seven app-tests assert the run's text as `` `#${DASH_NAME}` `` and move with it.

#### [P07] One dash-log parser before the marker moves — and the second one is missing the generation reset (DECIDED) {#p07-one-parser}

**Decision:** `read_dash_log` in `tugrust/crates/tugcast/src/feeds/draft_engine.rs` is folded onto the field-splitting and terminal-line logic in `tugrust/crates/tugdash-core/src/dash.rs`, and that consolidation lands **before** the terminal marker changes spelling. The fold **also applies the generation reset that `read_dash_log` currently lacks**, which is a behavior change and is called out as one.

**Rationale:**
- Two independent parsers of one file's grammar means [P03]'s compatibility clause has nothing forcing the two to agree. That duplication is exactly how the `created` marker's empty-note requirement became load-bearing-but-invisible in the previous arc.
- **Reading the second parser turned up a real defect.** `read_dash_log` splits the four fields by hand (`line.splitn(4, "  ")`), discards the marker into `_marker`, and collects **every** non-empty `<note>` in the whole file for the named dash. It never calls `is_terminal` and has no concept of a generation at all. So a dash name that was discarded and created again feeds the *previous incarnation's* round notes into the current one's draft-authoring instructions. `read_declarations` resets correctly; the draft engine does not.
- Folding is therefore not merely tidy: it is how that defect gets fixed, in one line, at the moment the two parsers become one.

**Implications:**
- `draft_engine.rs` keeps its own *policy* — it retains every non-empty `<note>` as a per-round draft-authoring instruction, which `read_declarations` does not do. Only the **grammar** (field splitting, terminal-line detection) is shared, and the generation reset is applied on top of the shared terminal check.
- **This changes draft-authoring behavior** for the specific case of a reused dash name: instructions from before the terminal line stop being collected. That is the correct behavior and the reason the defect is worth fixing here rather than filing, but it is a behavior change inside a plan whose non-goals otherwise forbid them ([#non-goals](#non-goals) exempts it explicitly), so it carries its own test.
- `tugdash-core` must expose the shared helpers publicly; `tugcast` already depends on it.

---

### Deep Dives {#deep-dives}

#### The vocabulary, before and after {#vocabulary-map}

**Table T01: The verb map** {#t01-verb-map}

| Surface | Today | Frame / call it makes | Becomes | Reversible |
|---|---|---|---|---|
| Changes card dash lane | `Adopt` | `bind_dash` | **Bind** | yes |
| Changes card dash lane | `Leave` | `unbind_dash` | **Unbind** | yes |
| Changes card dash lane | `Release` | `changeset_release` | **Discard** | **no** |
| Lens section row | `Adopt` | `bind_dash` | **Bind** | yes |
| Lens section row | `Release` | `changeset_release` | **Discard** | **no** |
| Lens section title | `Parked Dashes` | — | **Unbound Dashes** | — |
| Lens collapsed summary | `2 parked` / `No parked dashes` | — | **`2 unbound`** / **`No unbound dashes`** | — |
| CLI | `tugutil dash release` | `ops::release` | **`tugutil dash discard`** | **no** |
| CLI | `tugutil dash status` → `Sessions: none (parked)` | — | **`Sessions: none (unbound)`** | — |
| dash-log marker | `released` | — | **`discarded`** (both read) | — |
| Receipt command | `/dash-release` | — | **`/dash-discard`** (both claimed) | — |
| Every dash name | `#<name>` | — | **`◊<name>`** | — |

Unchanged, and named here so no step touches them: `bound_sessions`, `bind_dash`, `unbind_dash`, `bind_dash_ok`, `unbind_dash_ok`, `/dash-bind`, `/dash-join`, `cardSessionBindingStore`, `dash_owner_key`'s `#`, `dash adopt-plan` and all plan adoption, and `SECTION_KIND = "dashes"`.

#### Every dash-sense `release`, by file {#release-inventory}

**Table T02: The discard rename's sites** {#t02-release-sites}

| File | Symbols / strings | Note |
|---|---|---|
| `tugrust/crates/tugdash-core/src/ops.rs` | `ReleaseOutcome`, `release`, `release_in`, the `"released"` marker write, ~10 `release_*` test fn names | The teardown itself; `release_in` also does the plan hand-back and the working-set hand-back |
| `tugrust/crates/tugdash-core/src/dash.rs` | `is_terminal`'s `"released"` arm, the `"release"` reserved word in `validate_dash_name`, log-line test fixtures | Persisted grammar — [P03] |
| `tugrust/crates/tugdash-core/src/lib.rs` | `ReleaseOutcome`, `release`, `release_in` re-exports | |
| `tugrust/crates/tugutil/src/cli.rs` | `DashCommands::Release` and its doc comment | [P04] hard break |
| `tugrust/crates/tugutil/src/dash.rs` | `run_release`, the `DashCommands::Release` arm | |
| `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` | `changeset_release`, `parse_changeset_release_payload`, `do_changeset_release`, the `tugdash_core::release_in` call, the `"/dash-release"` receipt command write | Frame + receipt |
| `tugdeck/src/lib/changeset-verb-store.ts` | `changeset_release`, `changeset_release_ok`, `changeset_release_err`, `ReleaseState`, `useChangesetRelease`, the send method | |
| `tugdeck/src/components/tugways/cards/release-error-notice-controller.tsx` | whole module, incl. filename | |
| `tugdeck/src/components/tugways/cards/session-join-receipt-block.tsx` | `RELEASE_HEAD_RE`, `ParsedReleaseReceipt`, `parseReleaseReceipt`, `matchesReleaseReceipt`, `SessionReleaseReceiptBlock`, the `dash-release-receipt` registration id, `rootSlot="release-receipt-block"`, `dataSlot="release-receipt-detail"`, `.join-receipt-header-release` | Persisted grammar — [P03], Spec S03 |
| `tugdeck/src/components/tugways/cards/session-join-receipt-block.css` | `[data-slot="release-receipt-detail"]` | follows the slot rename |
| `tugdeck/src/components/tugways/cards/use-landing-receipts.ts` | the `append("/dash-release", …)` arm | |
| `tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx` | `requestRelease`, `Release` face, `session-changes-dash-release` slot | |
| `tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-landing.tsx` | `releaseAvailable`, `releaseDisabledReason`, `releaseConfirmMessage` | |
| `tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx` | `useChangesetRelease` call site | |
| `tugdeck/src/components/lens/sections/dashes-section.tsx` | `ReleaseControl`, `requestRelease`, `pendingRelease`, `PARKED_RELEASE_KEY`, `lens-parked-release` slot, `.lens-dashes-release` | |
| `tugdeck/src/components/lens/sections/dashes-section.css` | `.lens-dashes-release` | |
| `tests/app-test/at0418-join-outcomes.test.ts`, `at0425-dash-conflicted-landing.test.ts`, `at0405-changes-dash-lane.test.ts`, `at0438-lens-parked-dashes.test.ts` | `session-changes-dash-release`, `lens-parked-release` selectors | |
| `tests/app-test/at0419-join-receipt.test.ts` | `release-receipt-block`, `release-receipt-detail` selectors | **Easy to miss** — it `@covers` the receipt block but its name says "join" |
| `justfile` | the fixture-sweep invocation and its comment block | [R02](#r02-silent-sweep) |
| `tuglaws/dash-lifecycle.md`, `tuglaws/dash-work-doctrine.md` | prose | |
| `tugplug/skills/dash-on/SKILL.md`, `tugplug/skills/dash-join/SKILL.md` | the never-on-your-own-initiative rules | Bundle, not repo — see [#dependencies](#dependencies) |

**Explicitly NOT renamed:** `release_inputs` (`tugcast/src/router.rs`), `WorkspaceRegistry::release` (`tugcast/src/feeds/workspace_registry.rs`), `painter.release()` (`tugdeck/src/components/tugways/tug-sparkline.tsx`), the keymap `release()` in `settings-keymap-body.tsx`, `changeset_claim`'s "release affordance" prose in `tug-changes-list.tsx`, and all build-channel `release` (`--release`, `target/release`, `Release/Tug.app`, `release-main`, `just app-release`).

#### Every `parked`, and which ones survive {#parked-inventory}

Dash-sense `parked` is small and concentrated, and it has a **near-homonym inside the dash system itself** that must not be renamed. `parked` is used in two unrelated dash senses:

- **The binding sense** — "no live session is bound to this dash". This is the one that becomes **unbound**.
- **The queue sense** — "this dash's base-motion replay is waiting behind a busy session". `base_motion.rs` and two sites in `agent_supervisor.rs` say "a dash **parked behind** it", which means queued, not unbound. A dash can be bound and parked-behind at the same time. **These stay.**

Enumerated, so no site is judged twice:

| File | Binding sense (rename) | Queue / unrelated sense (keep) |
|---|---|---|
| `tugutil/src/dash.rs` | the `Sessions: none (parked)` output line | — |
| `tugcast-core/src/types.rs` | the `bound_sessions` doc | — |
| `tugdash-core/src/ops.rs` | 8, incl. the `parked-dash` test fixture name | — |
| `tugcast/src/session_ledger.rs` | all 3 | — |
| `tugcast/src/feeds/agent_supervisor.rs` | 2 — the `reads as *parked*` doc and the `with every card closed the dash is parked, not still mated` assertion message | 2 — both `parked dash catch up` / `parked behind it` |
| `tugcast/src/feeds/base_motion.rs` | **none** | all 3 — `a dash parked behind it replays seconds later`, `a busy session is parked`, `a dash parked behind it may now be actionable` |
| `tugcast/src/feeds/shell.rs` | none | 2 — wait-queue sense |

In the deck: `components/lens/sections/dashes-section.tsx` (42), `dashes-section.css` (4), `dash-facts.tsx` (2), `dash-sigil.tsx` (4), `lib/changeset-types.ts` (1), and the section's unit test (23) — all binding sense. In app-tests: `at0438` (28), `at0407` (21), `at0405` (3).

**Table T03: The innocent `parked` populations — these must survive** {#t03-innocent-parked}

| Sense | Representative sites |
|---|---|
| Scroll position / follow-bottom | `lib/smart-scroll.ts`, `tug-text-editor.tsx`, `at0335`, `at0370`, `at0387`, `at0333` |
| Deferred activation / pointer rings | `gesture-interpreter.ts`, `at0267`, `at0021`, `at0006`, `at0007` |
| Focus and cycle-mode rings | `focus-manager.ts` (26), `responder-chain-provider.tsx` (22), `use-cycle-mode.tsx`, `focus-reveal.ts`, `at0345`, `at0402`, `at0140`, `at0141` |
| Sticky chrome / layout | `layout-tree.ts`, `overview-card.css`, `tug-entry-shell.css`, `tug-modal-input-dialog.css` |
| Pending asks, shell classification, steering | `lib/pending-ask-store.ts` (21 in test), `lib/shell-classify-store.ts`, `code-session-store/reducer.ts` |
| App info, staged landing, prompt entry | `action-dispatch.ts`, `cards/staged-landing.ts` (11), `tug-prompt-entry.tsx` (10) |
| Shell feed waits | `tugcast/src/feeds/shell.rs` (2) |
| **Base-motion replay queue** — a dash *parked behind* a busy session | `tugcast/src/feeds/base_motion.rs` (3), `tugcast/src/feeds/agent_supervisor.rs` (2) |

The rule: rename a `parked` only where it describes **a dash with no bound session**. Everything above stays — including the last row, which is about dashes and is still not the binding sense.

#### Sigil metrics {#sigil-metrics}

**Table T04: Glyph coverage and metrics, IBM Plex Sans Regular, 1000-unit em** {#t04-sigil-metrics}

| Glyph | Codepoint | Advance | Bounds (x0, y0, x1, y1) | In Plex Sans/Mono R+M+SB | In Datatype |
|---|---|---|---|---|---|
| `#` | U+0023 | 713 | 60, **0**, 647, **698** | yes | yes |
| `◊` | U+25CA | 600 | 47, **0**, 554, **698** | yes | **no** |
| `∫` | U+222B | 426 | 50, **−200**, 376, **740** | yes | **no** |

Datatype's gap is immaterial: it is bound to `--tug-font-family-chart` in all six theme files and consumed only by `TugChartGlyph` / `tug-chart-glyph.css`, which render chart marks, never identity runs.

The sigil is rendered by exactly one component, `DashSigil` in `tugdeck/src/components/tugways/dash-sigil.tsx`, which both surfaces compose: `SessionDashMarker` in `tug-session-identity.tsx` (masthead, Lens Cards rows, the composer's session atom) and the Lens section's row. It is one `aria-hidden` `<span>` containing a literal `#`.

---

### Specification {#specification}

**Spec S01: The dash-log terminal line, after this plan** {#s01-terminal-line}

The grammar is unchanged: `<iso8601>  <dash>  <marker>  <note>`, four fields separated by two spaces, append-only, with the generation reset at each terminal line.

A line is terminal when:

```
marker == "discarded"                  // written from this plan forward
  || marker == "released"              // history on disk; read forever, never written
  || note == "joined"
  || note.starts_with("joined ")
```

`dash discard` writes `discarded` with an empty note. Nothing rewrites an existing `released` line.

**Spec S02: Reserved dash names** {#s02-reserved-names}

`validate_dash_name` rejects `join`, `status`, `release`, and **`discard`**. `release` stays reserved even though the subcommand is gone: freeing it would let a dash be named `release` and collide with the historical marker and with muscle memory, for no benefit.

**Spec S03: The discard receipt** {#s03-discard-receipt}

`do_changeset_discard` writes a `NewShellExchange` with `command: "/dash-discard"`. The first line today is `released <dash> · discarded <N> round(s)[, <M> file(s)]` — renaming only the leading verb would say "discarded" twice, so the redundant second verb goes and the count stands alone:

```
discarded <dash> · <N> round(s)[, <M> file(s)]
```

`session-join-receipt-block.tsx` therefore matches **two** head shapes, not one. The `·` is U+00B7 and is matched exactly, which is what keeps a hand-typed line from false-parsing into a receipt:

```js
// Written from this plan forward.
const DISCARD_HEAD_RE = /^discarded (\S+) · (\d+) round\(s\)(?:, (\d+) file\(s\))?$/;
// History in session JSONL. Read forever, never written. ([P03])
const RELEASE_HEAD_RE = /^released (\S+) · discarded (\d+) round\(s\)(?:, (\d+) file\(s\))?$/;
```

`parseDiscardReceipt` (today `parseReleaseReceipt`) tries the new shape first, then the historical one, and returns the same `ParsedDiscardReceipt` from either. The command matcher claims `/dash-discard` and `/dash-release`, each with and without the trailing-argument form.

Note the capture-group indices differ between the two patterns — the historical form's rounds are group 2 and the new form's are group 2 as well, but only because the dropped verb was not a group. Write the two branches separately rather than sharing an index.

#### State Zone Mapping {#state-zone-mapping}

This plan introduces **no new state**. Every renamed piece keeps its existing zone and mechanism; the table records that explicitly so a reviewer can confirm nothing migrated zones under cover of a rename.

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `pendingRelease` → `pendingDiscard` (which row's confirm is armed) | view-scope | `useState` in the section body | [L24] |
| `ReleaseState` → `DiscardState` in `changeset-verb-store` | local-data | module store + `useSyncExternalStore` | [L02] |
| `PARKED_RELEASE_KEY` → `UNBOUND_DISCARD_KEY` (the section's verb-store key) | local-data | module store key, section-scoped | [L02] |
| `data-parked` → `data-unbound` on the row | appearance | DOM attribute, CSS-selected | [L06] |
| Section presence (`sectionIsPresent`) | local-data | module store + `useSyncExternalStore` | [L02] |
| Sigil glyph | appearance | static JSX text in `DashSigil` | [L06] |

---

### Compatibility / Migration / Rollout {#rollout}

- **Compatibility policy:** Read-side dual-accept, permanent, for the two persisted grammars ([P03]). Hard break for the CLI ([P04]). Straight rename for live wire frames.
- **What is not migrated:** No `dash-log.md` and no session JSONL is edited, ever.
- **How breakage is detected:** [#step-9](#step-9)'s greps for surviving dash-sense `release`/`parked`/`Adopt`/`Leave`, plus a unit test per compatibility clause fed the *historical* spelling.
- **Rollback:** Every step is one commit on a dash worktree. Nothing is written to a user ledger that a revert could not undo, because nothing is written to a user ledger at all.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/cards/discard-error-notice-controller.tsx` | The renamed `release-error-notice-controller.tsx` (rename via `git mv`, keep history) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `is_terminal` | fn | `tugdash-core/src/dash.rs` | accepts `discarded` \|\| `released` ([P03], Spec S01) |
| `split_log_line` | fn | `tugdash-core/src/dash.rs` | made `pub(crate)`→`pub` so `draft_engine` shares it ([P07]) |
| `validate_dash_name` | fn | `tugdash-core/src/dash.rs` | `discard` joins the reserved set (Spec S02) |
| `read_dash_log` | fn | `tugcast/src/feeds/draft_engine.rs` | folded onto the shared grammar helpers ([P07]) |
| `ReleaseOutcome` → `DiscardOutcome` | struct | `tugdash-core/src/ops.rs` | |
| `release` / `release_in` → `discard` / `discard_in` | fn | `tugdash-core/src/ops.rs` | |
| `DashCommands::Release` → `DashCommands::Discard` | enum variant | `tugutil/src/cli.rs` | no alias ([P04]) |
| `run_release` → `run_discard` | fn | `tugutil/src/dash.rs` | |
| `run_status` | fn | `tugutil/src/dash.rs` | prints `Sessions: none (unbound)` ([P05]) |
| `changeset_release{,_ok,_err}` → `changeset_discard{,_ok,_err}` | CONTROL frames | `tugcast/src/feeds/agent_supervisor.rs`, `tugdeck/src/lib/changeset-verb-store.ts` | both sides, one commit |
| `parse_changeset_release_payload` → `parse_changeset_discard_payload` | fn | `tugcast/src/feeds/agent_supervisor.rs` | |
| `do_changeset_release` → `do_changeset_discard` | fn | `tugcast/src/feeds/agent_supervisor.rs` | writes `/dash-discard` (Spec S03) |
| `ReleaseState` → `DiscardState`, `useChangesetRelease` → `useChangesetDiscard` | type / hook | `tugdeck/src/lib/changeset-verb-store.ts` | |
| `DISCARD_HEAD_RE` | const | `tugdeck/src/components/tugways/cards/session-join-receipt-block.tsx` | **new**; `RELEASE_HEAD_RE` stays beside it as the historical read (Spec S03) |
| `ParsedReleaseReceipt` → `ParsedDiscardReceipt` | interface | same | |
| `parseReleaseReceipt` → `parseDiscardReceipt` | fn | same | tries the new head, then the historical one ([P03]) |
| `matchesReleaseReceipt` → `matchesDiscardReceipt` | fn | same | claims `/dash-discard` **and** `/dash-release`, each ± trailing argument |
| `SessionReleaseReceiptBlock` → `SessionDiscardReceiptBlock` | component | same | registration id `dash-release-receipt` → `dash-discard-receipt` |
| `AdoptControl` → `BindControl`, `ReleaseControl` → `DiscardControl` | component | `tugdeck/src/components/lens/sections/dashes-section.tsx` | |
| `resolveAdoptTarget` → `resolveBindTarget`, `AdoptTarget` → `BindTarget`, `useAdoptTarget` → `useBindTarget` | fn / type / hook | `tugdeck/src/components/lens/sections/dashes-section.tsx` | |
| `ParkedVerbs` / `ParkedVerbsContext` → `UnboundVerbs` / `UnboundVerbsContext` | type / context | `tugdeck/src/components/lens/sections/dashes-section.tsx` | |
| `PARKED_RELEASE_KEY` → `UNBOUND_DISCARD_KEY` | const | `tugdeck/src/components/lens/sections/dashes-section.tsx` | |
| `dashesCollapsedSummary` | fn | `tugdeck/src/components/lens/sections/dashes-section.tsx` | returns `N unbound` / `No unbound dashes` ([P05]) |
| `DashParkedMark` → `DashUnboundMark` | component | `tugdeck/src/components/lens/sections/dashes-section.tsx` | |
| `DashSigil` | component | `tugdeck/src/components/tugways/dash-sigil.tsx` | the literal becomes `◊` ([P06]) |

**`data-slot` and CSS renames:** `lens-parked-adopt` → `lens-bind`; `lens-parked-release` → `lens-discard`; `lens-parked-verbs` → `lens-unbound-verbs`; `lens-parked-name` → `lens-unbound-name`; `lens-parked-meta` → `lens-unbound-meta`; `lens-parked-age` → `lens-unbound-age`; `data-parked` → `data-unbound`; `.lens-dashes-adopt` → `.lens-dashes-bind`; `.lens-dashes-release` → `.lens-dashes-discard`; `session-changes-dash-release` → `session-changes-dash-discard`; `release-receipt-block` → `discard-receipt-block`; `release-receipt-detail` → `discard-receipt-detail`; `.join-receipt-header-release` → `.join-receipt-header-discard`. `lens-dashes-section`, `lens-dashes-row`, `.lens-dashes-*` fact classes, `session-changes-dash-landing-discard` (already correct), and `SECTION_KIND = "dashes"` are unchanged ([P05]).

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/dash-lifecycle.md` — the binding section, the "Plan adoption" section's release paragraph, and the reused-name example that says "release `fix-join`".
- [ ] `tuglaws/dash-work-doctrine.md` — the `dash release` inverse-of-`--carry` paragraph.
- [ ] `tugplug/skills/dash-on/SKILL.md` — the `tugutil dash release <name>` rule.
- [ ] `tugplug/skills/dash-join/SKILL.md` — both never-on-your-own-initiative rules and the empty-dash dialog's `Release it` / `Leave it` answers.
- [ ] `justfile` — the fixture-sweep invocation and its comment block.
- [ ] `tests/app-test/README.md` — the one `parked` reference, if dash-sense.
- [ ] Docblocks: `dashes-section.tsx`, `dash-facts.tsx`, `dash-sigil.tsx`, `session-changes-dash-lane.tsx`, `changeset-verb-store.ts`.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | The dash-log grammar's dual-accept, the reserved-name set, the discard outcome | `cargo nextest run` |
| **Unit (deck)** | The receipt matcher's dual-claim, the section's projection and summary strings, the bind-target refusals | `bun test` |
| **App-test** | The vocabulary and the sigil as a person meets them, over a real dash | `just app-test <files>` |
| **Drift prevention** | Greps asserting no dash-sense old spelling survives | [#step-9](#step-9) |

Every compatibility clause gets a test that feeds it the **historical** spelling. A dual-accept branch with no test for its old arm is the branch that gets deleted by a future tidy-up.

#### What stays out of tests {#test-non-goals}

- **No new app-test file.** The rename moves selectors in tests that already exist; a new file would duplicate at0438's coverage under new names.
- **No test that the CLI rejects `dash release`.** It is clap's own unrecognized-subcommand behavior, asserted by hand once in [#step-3](#step-3)'s checkpoint. A test would pin clap, not us.
- **No render tests.** `happy-dom`, `jsdom`, and `@testing-library/react` are banned here; deck logic is tested as pure functions and behavior is tested in the real app.
- **No mock-store assertion tests** for the renamed stores — the rename is verified by `tsc --noEmit` plus the app-tests that drive the real frames.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.**
>
> Steps 2–8 run on the dash worktree. **Steps 1 and 9 run from the main checkout** ([R03](#r03-baseline-worktree)) — Step 1 before the dash is created, Step 9 after it lands.
>
> Never pipe app-test output. Run the recipe bare; its printed report is the report.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Baseline the names that are about to change | done | `b1421f08b` |
| #step-2 | One dash-log parser, accepting both terminal spellings | done | `000a109fd` |
| #step-3 | The Rust vocabulary: discard and unbound | done | `4b8a0e9ca` |
| #step-4 | The discard frame and the discard receipt, both sides at once | done | `021d1432f` |
| #step-5 | The deck's verbs: Bind, Unbind, Discard | done | `c7ffee0c3` |
| #step-6 | The deck's section: Unbound Dashes | done | `2d0b11a3b` |
| #step-7 | The sigil becomes `◊` | done | `a349bedbf` |
| #step-8 | The doctrine, the skills, and the sweep | done | `87dc84e29` |
| #step-9 | Integration checkpoint | in progress | — |

---

#### Step 1: Baseline the names that are about to change {#step-1}

**Commit:** `app-test(at0407): reconcile the Lens dashes suite with the unbound-only projection` — **only if the baseline is red.** If everything is green, this step is verification-only and commits nothing.

**References:** [Q01] at0407 staleness, Risk R03, (#strategy, #dependencies)

**Artifacts:**
- A recorded verdict for at0438 (never before executed) and at0407 (likely stale).
- Either a repaired or a retired `at0407-lens-dashes-section.test.ts`.

**Tasks:**
- [ ] **Run from the main checkout, not a dash worktree.** Confirm with `git rev-parse --git-dir` — a linked worktree prints a path under `.git/worktrees/`.
- [ ] Run the four files that pin the vocabulary and the sigil over a real dash, bare and unpiped: `just app-test at0438-lens-parked-dashes.test.ts at0407-lens-dashes-section.test.ts at0405-changes-dash-lane.test.ts at0424-lens-dash-line.test.ts`
- [ ] Record each file's verdict. This is the only chance to learn what was already broken.
- [ ] Resolve [Q01] from the result. If at0407 is red because binding now removes the row from the section: keep whatever it uniquely pins (its review-mark staleness transition, driven by a real `dash step start --plan` and a real `plan stamp`, appears to have no counterpart in at0438) and drop the transition assertions the projection invalidated. If everything it pins is covered by at0438, retire the file — and note the retirement in at0438's docblock so the coverage lineage is legible.
- [ ] If at0438 is red for a reason unrelated to at0407, fix it here. It has never run; a first-run failure is this plan's inheritance, not its product.
- [ ] Re-run until all four are green.

**Tests:**
- [ ] The four files above, green, from the main checkout.
- [ ] `just app-test-covers-check` clean (a retired file must not leave a dangling `@covers`).

**Checkpoint:**
- [ ] `just app-test at0438-lens-parked-dashes.test.ts at0407-lens-dashes-section.test.ts at0405-changes-dash-lane.test.ts at0424-lens-dash-line.test.ts` — VERDICT green
- [ ] `just app-test-covers-check`

---

#### Step 2: One dash-log parser, accepting both terminal spellings {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash(dash-log): one parser for the log grammar, and a terminal line may say discarded or released`

**References:** [P03] dual-accept, [P07] one parser, Spec S01, Risk R01, (#s01-terminal-line, #r01-terminal-marker)

**Artifacts:**
- `tugdash-core/src/dash.rs` exports the shared grammar helpers; `is_terminal` accepts both spellings.
- `tugcast/src/feeds/draft_engine.rs`'s `read_dash_log` uses them instead of its own splitting.

**Tasks:**
- [ ] In `tugrust/crates/tugdash-core/src/dash.rs`, make the field splitter (`split_log_line`, which returns `(timestamp, dash, marker, note)`) and `is_terminal` public, and re-export them from `lib.rs`.
- [ ] Widen `is_terminal` to `marker == "discarded" || marker == "released" || note == "joined" || note.starts_with("joined ")`. Comment that `released` is history on disk, is never written from here forward, and is not scheduled for removal ([P03]).
- [ ] Rewrite `read_dash_log` in `tugrust/crates/tugcast/src/feeds/draft_engine.rs` to call the shared helpers. Keep its own **policy** unchanged: it retains every **non-empty** `<note>` as a per-round draft-authoring instruction, which is why the `created` marker's note must stay empty. Move only the grammar.
- [ ] Do **not** change any writer yet. This step is grammar-only; `ops::release` still writes `released`.

**Tests:**
- [ ] Rust: a log whose terminal line uses the historical `released` spelling resets the generation — declarations before it do not survive.
- [ ] Rust: a log whose terminal line uses `discarded` resets the generation identically.
- [ ] Rust: `joined` / `joined <sha>` notes still terminate (regression guard on the fold).
- [ ] Rust: `draft_engine`'s round-instruction extraction is unchanged over a fixture log with empty and non-empty notes — including that a `created` line contributes no instruction.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugrust && cargo build` (warnings are errors)

---

#### Step 3: The Rust vocabulary: discard and unbound {#step-3}

**Depends on:** #step-2

**Commit:** `tugdash(discard): release becomes discard, and a dash with no session is unbound`

**References:** [P02] release→discard, [P04] CLI hard break, [P05] unbound, Spec S01, Spec S02, Table T02, Table T03, Risk R02, (#t02-release-sites, #t03-innocent-parked, #r02-silent-sweep)

**Artifacts:**
- `DiscardOutcome`, `discard`, `discard_in` in `tugdash-core`.
- `tugutil dash discard`; `tugutil dash release` gone.
- The dash-log writer emits `discarded`.
- No binding-sense `parked` left in Rust.
- A `justfile` fixture sweep that still sweeps.

**Tasks:**
- [ ] Rename in `tugrust/crates/tugdash-core/src/ops.rs`: `ReleaseOutcome` → `DiscardOutcome`, `release` → `discard`, `release_in` → `discard_in`, and every `release_*` test fn name. Update `lib.rs`'s re-exports.
- [ ] Change the terminal marker the teardown writes from `"released"` to `"discarded"`. The reader already takes both from [#step-2](#step-2).
- [ ] Add `discard` to `validate_dash_name`'s reserved set, keeping `release` reserved, and update its doc comment (Spec S02).
- [ ] Rename `DashCommands::Release` → `DashCommands::Discard` in `tugrust/crates/tugutil/src/cli.rs`. **No clap alias** ([P04]). Update the variant's doc comment — it is the `--help` text.
- [ ] Rename `run_release` → `run_discard` and its dispatch arm in `tugrust/crates/tugutil/src/dash.rs`.
- [ ] Update `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs`'s call site (`tugdash_core::release_in` → `discard_in`) and the comment above it. **The `changeset_release` frame is NOT renamed here** — it moves in [#step-4](#step-4), with its deck half, in one commit.
- [ ] Rename the **binding-sense** `parked` → `unbound` in Rust prose, identifiers, and output, exactly as enumerated in **Table T03**: `tugutil/src/dash.rs` (`Sessions: none (parked)` → `Sessions: none (unbound)`), `tugcast-core/src/types.rs`, `tugdash-core/src/ops.rs` (incl. the `parked-dash` test fixture name → `unbound-dash`), `tugcast/src/session_ledger.rs` (3), and **exactly two** of `agent_supervisor.rs`'s four.
- [ ] **Leave the queue sense alone.** `base_motion.rs`'s three and `agent_supervisor.rs`'s other two say a dash is *parked behind* a busy session — queued for replay, which a **bound** dash can also be. `shell.rs`'s two are wait-queue sense. Renaming any of these would be a false statement (Table T03).
- [ ] **Fix the `justfile` fixture sweep in this commit** ([R02](#r02-silent-sweep)): change `tugutil dash release` to `tugutil dash discard` in the `tugdash/at04??-*` sweep loop, and update the surrounding comment block (it explains the hand-back and the reset, both still true).
- [ ] Grep for any other in-repo `tugutil dash release` invocation and fix it.

**Tests:**
- [ ] Rust: the existing teardown lifecycle tests pass under the new names.
- [ ] Rust: a discard writes a `discarded` marker, and `read_declarations` treats it as terminal.
- [ ] Rust: `validate_dash_name("discard")` and `validate_dash_name("release")` both refuse.
- [ ] Rust: `dash status` on a dash with no live binding prints `Sessions: none (unbound)`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugrust && cargo build`
- [ ] `tugrust/target/debug/tugutil dash discard --help` prints the subcommand
- [ ] `tugrust/target/debug/tugutil dash release` exits non-zero with an unrecognized-subcommand error
- [ ] `rg -n '\bparked\b' tugrust/crates --glob '!target'` returns only the queue-sense sites Table T03 names — `base_motion.rs` (3), `agent_supervisor.rs` (2), `shell.rs` (2)
- [ ] Sweep probe: `tugutil dash create at0499-sweep-probe`, then any single app-test run, then confirm `git branch --list 'tugdash/at0499-*'` is empty and the run printed `swept stranded fixture dash: at0499-sweep-probe`

---

#### Step 4: The discard frame and the discard receipt, both sides at once {#step-4}

**Depends on:** #step-3

**Commit:** `tugdash(discard-frame): the changeset verb is discard end to end, and old receipts still read`

**References:** [P02] release→discard, [P03] dual-accept, Spec S03, Table T01, Table T02, [L02], (#s03-discard-receipt, #strategy)

**Artifacts:**
- `changeset_discard{,_ok,_err}` on **both** the tugcast and deck sides.
- A `/dash-discard` receipt in the Spec S03 format, with the historical `/dash-release` shape still claimed and parsed.

**Tasks:**

> **Both halves of the frame land in this one commit.** A CONTROL frame has no persisted representation and the deck and tugcast ship in one app bundle, so there is no version skew to manage — but a commit that renamed only one side would leave the tree transiently unable to discard anything. That is the rule stated in [#strategy](#strategy), and this step is where it is honored.

- [ ] **tugcast** (`tugrust/crates/tugcast/src/feeds/agent_supervisor.rs`): rename the `changeset_release` CONTROL arm and its `_ok` / `_err` broadcasts to `changeset_discard*`, `parse_changeset_release_payload` → `parse_changeset_discard_payload`, `do_changeset_release` → `do_changeset_discard`.
- [ ] **tugcast**: change the receipt write to `command: "/dash-discard"` and its first line to `discarded <dash> · <N> round(s)[, <M> file(s)]` (Spec S03). Note the round subjects are still captured from the dash detail read *before* the teardown runs — that ordering is load-bearing and does not move.
- [ ] **deck** (`tugdeck/src/lib/changeset-verb-store.ts`): rename the sent frame to `changeset_discard` and the two inbound actions to `changeset_discard_ok` / `changeset_discard_err`; `ReleaseState` → `DiscardState`; `useChangesetRelease` → `useChangesetDiscard`; the send method likewise. It stays a module store read through `useSyncExternalStore` ([L02]) — no zone moves ([#state-zone-mapping](#state-zone-mapping)).
- [ ] **deck** (`session-join-receipt-block.tsx`): add `DISCARD_HEAD_RE` and keep `RELEASE_HEAD_RE`, both per Spec S03, with the historical one commented as history in session JSONL that replays on every card reload. Rename `ParsedReleaseReceipt` → `ParsedDiscardReceipt`, `parseReleaseReceipt` → `parseDiscardReceipt` (trying the new shape then the historical), `matchesReleaseReceipt` → `matchesDiscardReceipt` (claiming `/dash-discard` **and** `/dash-release`, each with and without a trailing argument), `SessionReleaseReceiptBlock` → `SessionDiscardReceiptBlock`, and the `registerCommandBlock` id `dash-release-receipt` → `dash-discard-receipt`.
- [ ] **deck**: rename the DOM slots `release-receipt-block` → `discard-receipt-block` and `release-receipt-detail` → `discard-receipt-detail`, plus `.join-receipt-header-release` → `.join-receipt-header-discard`, and follow them into `session-join-receipt-block.css`.
- [ ] **deck** (`use-landing-receipts.ts`): the append arm emits `/dash-discard`.
- [ ] Update the app-tests that select those slots: `at0418-join-outcomes.test.ts` **and `at0419-join-receipt.test.ts`** — the latter is easy to miss, because its name says "join" while it `@covers` the receipt block and selects both release slots.
- [ ] `git mv` `release-error-notice-controller.tsx` → `discard-error-notice-controller.tsx` and rename its symbols and importers — it settles `changeset_discard_err` and belongs with the frame.

**Tests:**
- [ ] Rust: the changeset-verb tests pass under the renamed frame.
- [ ] Rust: a discard through the frame writes a receipt whose first line matches the Spec S03 `discarded …` shape.
- [ ] Deck unit: `parseDiscardReceipt` reads a **historical** `released <dash> · discarded <N> round(s), <M> file(s)` line and returns the same parse as the new shape ([P03]).
- [ ] Deck unit: `matchesDiscardReceipt` claims `/dash-release`, `/dash-release <arg>`, `/dash-discard`, and `/dash-discard <arg>`, and claims neither `/dash-join` nor an unrelated command.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run && cargo build`
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `cd tests/app-test && bunx tsc --noEmit`
- [ ] `rg -n 'changeset_release|dash-release|ReleaseState|release-receipt' tugrust/crates tugdeck/src --glob '!target'` returns only the documented historical-read sites and their tests

---

#### Step 5: The deck's verbs: Bind, Unbind, Discard {#step-5}

**Depends on:** #step-4

**Commit:** `tugways(dash-verbs): the buttons say Bind, Unbind, and Discard — the words the wire already used`

**References:** [P01] bind/unbind, [P02] release→discard, [P03] dual-accept, Spec S03, Table T01, Table T02, [L02], [L31], (#t01-verb-map, #state-zone-mapping)

**Artifacts:**
- Changes lane: `Bind` / `Unbind` / `Discard`.
- Lens row: `Bind` / `Discard`.

**Tasks:**

> Frames, stores, and the receipt block moved in [#step-4](#step-4). This step is the **faces and their slots** — what a person reads and what a test selects.

- [ ] `session-changes-dash-lane.tsx`: the `bound ? "Leave" : "Adopt"` faces become `bound ? "Unbind" : "Bind"` (two sites — the button and the disabled-reason tooltip descriptor); `Release` → `Discard`; `requestRelease` → `requestDiscard`; `data-slot="session-changes-dash-release"` → `session-changes-dash-discard`. Update the docblock's "two **binding** gestures" paragraph and the `fronted`/`bound` comments that say "Leave-vs-Adopt".
- [ ] `session-changes-dash-landing.tsx`: `releaseAvailable` → `discardAvailable`, `releaseDisabledReason` → `discardDisabledReason`, `releaseConfirmMessage` → `discardConfirmMessage`, and the comment that says "the row calls it Adopt or Leave by binding".
- [ ] `session-changes-view.tsx`: the hook call site and its `Adopt and Leave` comment.
- [ ] `dashes-section.tsx`: `AdoptControl` → `BindControl` (face `Adopt` → `Bind`), `ReleaseControl` → `DiscardControl` (face `Release` → `Discard`), `AdoptTarget` → `BindTarget`, `resolveAdoptTarget` → `resolveBindTarget`, `useAdoptTarget` → `useBindTarget`, `requestRelease` → `requestDiscard`, `pendingRelease` → `pendingDiscard`. Slots `lens-parked-adopt` → `lens-bind` and `lens-parked-release` → `lens-discard`; CSS `.lens-dashes-adopt` → `.lens-dashes-bind`, `.lens-dashes-release` → `.lens-dashes-discard` in `dashes-section.css`.
- [ ] Keep the refusal sentence in `resolveBindTarget` reading naturally: "Focus a session card to bind this dash" ([L31] — the reason must stay reachable and true).
- [ ] Update the app-test selectors that name these slots: `at0418-join-outcomes.test.ts`, `at0425-dash-conflicted-landing.test.ts`, `at0405-changes-dash-lane.test.ts`, `at0438-lens-parked-dashes.test.ts`.

**Tests:**
- [ ] Deck unit: `session-changes-dash-lane.test.ts` — the lane offers Unbind on a bound row and Bind otherwise (the existing complement assertion, renamed).
- [ ] Deck unit: `dashes-section.test.ts` — `resolveBindTarget`'s three refusal sentences, unchanged in meaning.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tests/app-test && bunx tsc --noEmit`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 6: The deck's section: Unbound Dashes {#step-6}

**Depends on:** #step-5

**Commit:** `tugways(unbound-dashes): the Lens section is Unbound Dashes — one word for one state`

**References:** [P05] unbound, Table T01, Table T03, [L06], [L24], (#t03-innocent-parked, #state-zone-mapping)

**Artifacts:**
- Section title `Unbound Dashes`; summary `N unbound` / `No unbound dashes`.
- No dash-sense `parked` left in the deck or the app-tests.

**Tasks:**
- [ ] `dashes-section.tsx`: `title: "Parked Dashes"` → `"Unbound Dashes"`; `dashesCollapsedSummary` returns `` `${n} unbound` `` and `"No unbound dashes"`; `DashParkedMark` → `DashUnboundMark`; `ParkedVerbs`/`ParkedVerbsContext` → `UnboundVerbs`/`UnboundVerbsContext`; `PARKED_RELEASE_KEY` → `UNBOUND_DISCARD_KEY`; `data-parked="true"` → `data-unbound="true"`; slots `lens-parked-verbs`/`-name`/`-meta`/`-age` → `lens-unbound-*`.
- [ ] Rewrite the module docblock in the new vocabulary. Keep the inbox framing as prose — it is the section's *purpose*, and it survives the state word changing. State explicitly that `SECTION_KIND` stays `"dashes"` because it is the registry key and the persisted `sectionOrder` key, and renaming it would orphan every saved Lens order in tugbank ([P05]).
- [ ] `dashes-section.css`: the four dash-sense `parked` comments; any `data-parked` selector → `data-unbound` ([L06]).
- [ ] `dash-facts.tsx` (2), `dash-sigil.tsx` (4, prose only), `lib/changeset-types.ts` (1) — prose and the `bound_sessions` guard's comment.
- [ ] `dashes-section.test.ts` (23): the `PARKED` fixture constant → `UNBOUND`, the summary assertions, and the docblock. Keep the test that asserts the singular still reads `1 unbound` — the word is the state, not a plural.
- [ ] App-tests: rename `at0438-lens-parked-dashes.test.ts` → `at0438-lens-unbound-dashes.test.ts` with `git mv`, update its 28 `parked` references and its selectors, and keep its `@covers` block accurate. Update `at0405-changes-dash-lane.test.ts` (3) and, if it survived Step 1, `at0407`.
- [ ] Leave every population in **Table T03** alone.

**Tests:**
- [ ] Deck unit: `dashesCollapsedSummary` returns `1 unbound`, `2 unbound`, `No unbound dashes`.
- [ ] Deck unit: the projection's partition assertions, unchanged in meaning under the new fixture name.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `cd tests/app-test && bunx tsc --noEmit`
- [ ] `just app-test-covers-check`
- [ ] `rg -n '\bparked\b' tugdeck/src tests/app-test` returns only Table T03's populations

---

#### Step 7: The sigil becomes `◊` {#step-7}

**Depends on:** #step-6

**Commit:** `tugways(dash-sigil): a dash wears ◊, so # can go back to numbering messages`

**References:** [P06] lozenge sigil, Table T04, Risk R04, (#t04-sigil-metrics, #r04-baked-atom-chip)

**Artifacts:**
- `DashSigil` renders `◊`.
- Seven app-tests assert `` `◊${DASH_NAME}` ``.

**Tasks:**
- [ ] `tugdeck/src/components/tugways/dash-sigil.tsx`: the `aria-hidden` span's text `#` → `◊`. Update the module docblock, which currently says "wearing its `#`".
- [ ] `tug-session-identity.tsx`: the comment that reads "The `#` is the grammar's dash sigil".
- [ ] `tug-session-identity.css`: the `#<dash-name>` comment on `.tug-session-identity-dash`.
- [ ] Update the seven text assertions: `at0406-masthead-dash-run.test.ts` (the `run.text` assertion and the two punctuation comments), `at0408-dash-gesture.test.ts` (`chipText`), `at0417-join-mode.test.ts` (`chipText`), `at0421-dash-picker.test.ts` (`chipText`), `at0423-session-atom-dash-mark.test.ts` (`mark.text` and its two docblock references), `at0424-lens-dash-line.test.ts` (the `not.toContain` assertion), `at0438` (the `parked.name` assertion, under its new filename from Step 6).
- [ ] Do **not** touch `dash_owner_key`'s `#` (`tugdash/<name>#<tugid>`) — an opaque ID grammar, never displayed ([P06]).
- [ ] Verify no CSS reserves width for a `#`-shaped glyph: `.tug-session-identity-dash-sigil` is `flex: none` with no authored width, so `◊`'s narrower advance is absorbed.

**Tests:**
- [ ] The seven app-tests' assertions are **updated** here and **run** in [#step-9](#step-9). This step runs on the dash worktree, where `just app-test` refuses ([R03](#r03-baseline-worktree)); saying "run them if you can" would be a checkpoint that cannot fail, so the running belongs to the one step that can do it. The pixel check for [R04](#r04-baked-atom-chip) is likewise a Step 9 task.
- [ ] Deterministic coverage proof, runnable from the worktree without the app: assert that every bundled face the identity run can resolve to carries U+25CA. Read the `cmap` of `tugdeck/public/fonts/IBMPlexSans-{Regular,Medium,SemiBold}.woff2` and `IBMPlexMono-{Regular,Medium,SemiBold}.woff2` and confirm the codepoint is present in each. This is the claim in **Table T04**, re-checked against the bytes actually in the tree rather than trusted from the plan.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `cd tests/app-test && bunx tsc --noEmit`
- [ ] `rg -n '`#`|wearing its|dash sigil' tugdeck/src` shows no stale `#` prose
- [ ] `rg -n '#\$\{' tests/app-test/at04*.test.ts` returns no dash-name interpolation still carrying a `#`

---

#### Step 8: The doctrine, the skills, and the sweep {#step-8}

**Depends on:** #step-7

**Commit:** `tuglaws(dash-vocabulary): the doctrine says bind, unbind, and discard`

**References:** [P01] bind/unbind, [P02] release→discard, [P04] CLI hard break, [P05] unbound, [P06] lozenge sigil, (#documentation-plan, #dependencies)

**Artifacts:**
- `tuglaws/dash-lifecycle.md` and `tuglaws/dash-work-doctrine.md` in the new vocabulary.
- Both tugplug skills naming `tugutil dash discard`.

**Tasks:**
- [ ] `tuglaws/dash-lifecycle.md`: the binding section (already correct — verify), the reused-name example that says "release `fix-join` and create it again", the "Plan adoption" section's paragraph that begins "**Release hands the plan back**", and the parked→unbound sentence "which is exactly why a dash whose cards have all closed reads as *parked* — parked is not a stage, it is the absence of workers." Record the sigil as `◊`.
- [ ] `tuglaws/dash-work-doctrine.md`: the paragraph describing `dash release` as `--carry`'s inverse.
- [ ] `tugplug/skills/dash-on/SKILL.md`: the rule naming `tugutil dash release <name>` as the one irreversible act.
- [ ] `tugplug/skills/dash-join/SKILL.md`: both never-on-your-own-initiative rules, and the empty-dash dialog's answers. **Note the "Leave it" answer there means "leave the dash standing" — ordinary English, not the retired button face.** Reword it to avoid the collision now that Leave is a retired verb name.
- [ ] `tests/app-test/README.md`: its one `parked` reference, if dash-sense.
- [ ] Verify the `justfile` sweep comment block reads correctly after [#step-3](#step-3).
- [ ] **Skills execute from the app bundle, not the repo** ([#dependencies](#dependencies)). To confirm an edit live, `just build-app` or copy the file into `Tug.app/Contents/Resources/tugplug/`. Note in the step's report which was done.
- [ ] Leave `roadmap/archive/**` and superseded briefs alone — they are history ([#non-goals](#non-goals)).

**Tests:**
- [ ] None — documentation. The greps in [#step-9](#step-9) are the check.

**Checkpoint:**
- [ ] `rg -n 'dash release|Adopt|\bLeave\b' tuglaws/ tugplug/ justfile` returns nothing in the dash sense
- [ ] `just hooks-test`

---

#### Step 9: Integration checkpoint {#step-9}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7, #step-8

**Commit:** `N/A (verification only)`

**References:** [P01]–[P07], Spec S01, Spec S03, Tables T01–T04, Risks R01–R05, (#success-criteria)

**Tasks:**
- [ ] **Run from the main checkout, after the dash lands** ([R03](#r03-baseline-worktree)).
- [ ] `just build-app` first — app-tests refresh `dist` but never rebuild the app bundle, so the Rust changes in Steps 2–4 are absent from the harness until a build.
- [ ] Verify the vocabulary holds end to end over a real dash: bind a session from the Lens row, watch the row leave the Unbound section and appear under Cards, unbind from the Changes lane, watch it return.
- [ ] Verify the compatibility clauses against **real history**: find a `dash-log.md` under `~/Library/Application Support/Tug/projects/<slug>/` containing a `released` line (inspect the file directly — it is markdown, not a database) and confirm `tugutil dash status` on that dash reports a stage consistent with the *current* generation, not a bled-forward one. Find a session transcript containing a `/dash-release` receipt and confirm it still renders as a receipt block rather than a raw shell row.
- [ ] **The pixel check deferred from [#step-7](#step-7)** ([R04](#r04-baked-atom-chip)): screenshot a bound session's masthead identity run and its composer session atom, and read the glyph out of the image. A face missing the codepoint paints nothing rather than failing an assertion — the same class of bug as the missing italic face, where text was simply invisible and every DOM assertion still passed.
- [ ] Run the drift greps in the checkpoint below and reconcile every hit against Table T02 and Table T03.

**Tests:**
- [ ] `just app-test at0438-lens-unbound-dashes.test.ts at0405-changes-dash-lane.test.ts at0424-lens-dash-line.test.ts at0406-masthead-dash-run.test.ts at0408-dash-gesture.test.ts at0417-join-mode.test.ts at0421-dash-picker.test.ts at0423-session-atom-dash-mark.test.ts at0418-join-outcomes.test.ts at0419-join-receipt.test.ts at0425-dash-conflicted-landing.test.ts` (plus `at0407` if it survived Step 1) — bare, unpiped.
- [ ] `just app-test-changed` to catch anything the `@covers` graph reaches that this list misses.

**Checkpoint:**
- [ ] `just ci`
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test-covers-check`
- [ ] `rg -n '\brelease' tugrust/crates/tugdash-core tugrust/crates/tugutil/src/dash.rs --glob '!target'` — only the two documented compat reads and their tests
- [ ] `rg -n '\bparked\b' tugrust/crates tugdeck/src tests/app-test --glob '!target'` — only Table T03's populations
- [ ] `rg -n '"Adopt"|"Leave"|Parked Dashes|changeset_release' tugdeck/src tugrust/crates --glob '!target'` — no hits
- [ ] The sweep probe from [#step-3](#step-3), re-run against the built binary

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** One vocabulary for the dash system — **bind** / **unbind** for the reversible relationship, **discard** for the irreversible teardown, **unbound** for the state — spelled identically from `dash-log.md` to the button face, with `◊` as the dash sigil, and with both persisted grammars still reading the history they already wrote.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] No dash-sense `release`, `Adopt`, `Leave`, or `parked` survives in a production symbol, wire frame, CSS class, `data-slot`, or user-visible string (Step 9 greps)
- [ ] A historical `released` dash-log line still resets the generation (Rust unit test + the real-history check in Step 9)
- [ ] A historical `/dash-release` receipt still renders as a receipt block (deck unit test + the real-history check in Step 9)
- [ ] `tugutil dash discard` works; `tugutil dash release` fails loudly (both by hand)
- [ ] The app-test fixture sweep still sweeps (the `at0499-sweep-probe` probe)
- [ ] Every dash name renders `◊<name>`, verified in pixels as well as in DOM text
- [ ] [Q01] is resolved: at0407 is green, or retired with its unique coverage accounted for
- [ ] `just ci` green; `cargo nextest run` and `bun test` green; `tsc --noEmit` and `bunx vite build` clean

**Acceptance tests:**
- [ ] `just app-test` over the ten-file dash selection in [#step-9](#step-9), from the main checkout
- [ ] `just app-test-changed`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Reconcile the two deviations the previous arc recorded: `DashSigil` living in `tugways/` rather than beside the Lens section, and Discard being a text button with a row-anchored confirm rather than a row context menu.
- [ ] Resolve the previous arc's `[Q01]`: whether Bind should open a new session on the dash's project when no card is eligible, rather than refusing.
- [ ] A Lens-wide review of which other sections should opt into the `presence` capability now that it exists.
- [ ] The verb-misassignment round: `LANDING_WORDS` on the composer's land button, and the row JOIN either landing or visibly handing off.
- [ ] The structural [L31] bypass in `tug-prompt-entry.tsx`, where the land button is natively `disabled` on gate refusal so a press can never reach `refuse()`.

| Checkpoint | Verification |
|------------|--------------|
| Baseline established | Step 1's four files green from the main checkout |
| Log grammar is one parser, dual-accepting | `cargo nextest run`, incl. the historical-spelling test |
| Discard is the CLI verb | `tugutil dash discard --help` succeeds; `dash release` fails |
| The sweep survives the break | `at0499-sweep-probe` swept |
| Frame + receipt renamed, history still read | `cargo nextest run`, `bun test`, Step 9's real-history check |
| Deck verbs renamed | `bun test`, `tsc --noEmit`, `vite build` |
| Section renamed | `rg '\bparked\b'` returns only Table T03 |
| Sigil replaced | Seven app-tests green + a pixel read |
| Doctrine updated | `rg 'dash release\|Adopt\|\bLeave\b' tuglaws/ tugplug/` clean |
| Phase closed | `just ci` + the ten-file app-test selection |
