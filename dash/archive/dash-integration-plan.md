# Dash Integration — program plan {#dash-integration-plan}

**Purpose:** Make dashes a first-class concept in Tug's UI — a session card can bind to a dash, the Changes/Commit surface shows dash progress and lands joins, the Lens shows inflight dashes, and the workflow the skills currently improvise in prose is codified into `tugutil dash` verbs — so the dash lane reaches parity with the main-lane Changes/Commit flow.

This is a **program plan**: numbered phases (including the inserted 2.1 and 3.1), each of which gets its own devise-skeleton recipe before implementation. This document fixes the decisions, the state model, the phase boundaries, and the contracts between phases; it deliberately does not enumerate per-file tasks.

*Reading convention: a shipped phase's prose keeps the names that were current when it shipped — phase 2.1 says `devise`, phase 3 says `dash-run`. The [P05] amendment table is the live roster; the phase text is the record of what was built and when.*

---

## Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (phases run as dashes) |
| Brief | [dash-integration-brief.md](dash-integration-brief.md) |
| Last updated | 2026-08-14 |

---

## Ratified Decisions {#ratified-decisions}

These were decided in conversation on 2026-08-13 ([P01]–[P07]) and 2026-08-14 ([P08]–[P09]) and are not open for relitigating inside phase recipes.

### [P01] Binding is an overlay, not a relocation {#p01-overlay}

A session card binds **secondarily** to a dash while staying spawned in the base checkout. The binding redirects *surfaces*, not the process: the Changes lane fronts the dash's range and worktree dirt, diffs and pop-outs read range descriptors, card chrome wears a dash chip, and bare `/join` operates on the bound dash. The shell route, claude's cwd, and the primary `workspace_key` binding are untouched. Rationale: `join_in` refuses from inside the worktree and off the base branch — the card must never be put somewhere it cannot land from; and this matches how the skills already work (in-thread from base, worktree addressed by absolute path). Relocation ("this card's shell lives in the worktree") remains severable future work on the dash-instance machinery, not a mutation of this binding.

### [P02] Many cards, one dash; a dash outlives its sessions {#p02-cardinality}

The binding is many-to-one: several session cards may bind to the same dash; a dash with zero bound sessions is **parked**, not broken. Binding state lives with the session (sessions ledger), never with the dash — the dash remains pure git plus its state-dir artifacts.

### [P03] Dashes get a creation identity; drafts and bindings key by it {#p03-dash-id}

`tugutil dash create` mints a **dash id** (creation timestamp + nonce) stored in git config beside `tugbase`. Drafts (`owner_kind='dash'`) and session bindings key by the dash id, not the reusable name. This retires the draft-haunting class of bug (a reused name inheriting a dead dash's clobber-protected join draft) as mechanism instead of the `draft clear` prose rule the join skill carries today. The name stays the human handle everywhere in UI and CLI arguments; the id is resolution plumbing.

### [P04] `tugutil dash step` edits the plan's Step Status Ledger {#p04-step-verbs}

The markdown ledger table in the plan document stays the single durable record of step state. `tugutil dash step start <n>` / `dash step done <n> --commit <sha>` edit that table **and** append structured dash-log lines, so ledger, log, and rounds cannot drift — "task, ledger, and commit move together" becomes a verb, not a rule the model must remember. The triple bookkeeping (markdown table + Task items + rounds) collapses to one gesture per transition.

### [P05] Naming: a skill's prefix is the `tugutil` namespace it rides {#p05-naming}

**Planning and dashing are two different things, and the names say so.** A skill's prefix names the `tugutil` namespace it drives — and therefore the artifact it acts on.

| Skill | Rides | Acts on |
|---|---|---|
| `plan-devise` | `tugutil plan` | a plan document |
| `plan-review` | `tugutil plan` | a plan document |
| `dash-implement` | `tugutil dash` | a dash, walking a plan |
| `dash-on` | `tugutil dash` | a dash, from a typed instruction |
| `dash-audit` | `tugutil dash` | a dash's built code |
| `dash-join` | `tugutil dash` | a dash, landing it |
| `draft` | `tugutil draft` | the main-lane landing draft — the namespace is the name |

The rule is **checkable rather than remembered**: a skill's own commands say which namespace it rides, so a user who learns `tugutil plan lint` can guess `plan-review`, and the next skill anyone writes has an obvious correct name. The flow reads `plan-devise → plan-review → dash-implement → dash-audit → dash-join`, with the artifact hand-off visible at exactly the point `dash create` happens.

Card gestures take the leaf, unprefixed: `/dash <name>` (create-if-needed + bind *this card*), `/join` (landing), `/commit` (main lane), and `/plan-review` ([P08]) — never `/review`, which is Claude Code's built-in PR review and is not shadowed.

*Amendment history. The original 2026-08-13 ruling prefixed dash-lane-only skills and left `devise` (and then-still-extant `vet`) unprefixed; [P07] retired `vet`. The 2026-08-14 amendment replaces "dash-lane-only" with the namespace rule, because the resulting roster proved unreadable in practice: `review-plan` suffixed its noun while everything else prefixed, and no user could reconstruct the rule from the names — it lived only in this document. `dash-run` becomes `dash-on` in the same pass: "run" named only the fact of execution, and collided with the built-in `run` skill (launch the app), which is a step **inside** the skill rather than the skill.*

### [P06] Derive, don't record {#p06-derive}

A dash is git. Lifecycle stage is **derived** wherever git can answer (branch existence, rounds, journal phase, draft row, worktree dirt) and **declared** only for transitions git cannot see (step start, built, audited), recorded as structured dash-log lines by the verbs that cause them. No dash database is introduced by any phase.

### [P07] A plan is devised *and* vetted in one gesture; `/vet` is retired {#p07-devise-absorbs-vet}

`/tugplug:vet` is read-only by construction, so its verdict can only ever be handed back to the user, and in practice the user's answer is invariably "do the fixups" — a hand-off round that exists only because the skill was forbidden to act on what it found. That is a workflow seam, not a safety property: nothing was protected by making the author and the reviewer two separate invocations, because it was the same conversation both times.

The `devise` gesture therefore absorbs the assessment. One invocation produces a plan that has been **written, adversarially reviewed against the real code and the tuglaws, and revised** — with the fixups already applied and recorded in the document. The `vet` skill is deleted; its rubric survives as durable doctrine (`tuglaws/plan-review-rubric.md`), which is where the judgment actually lived.

Two requirements decide the mechanism. The review must run on **Opus regardless of the model that devised the plan** — and so must the fixups, since that is where judgment lands. And it must be **visible while it happens**: a review is minutes of reading and editing, and work that disappears for minutes is what this product exists to prevent. A headless subprocess satisfies the first and fails the second (`tool_progress` is swallowed in `tugcode/src/session.ts`, and carries no output regardless), so the review is instead **a second turn in the same session, on a borrowed model**: after `devise` writes the plan, the card sets the session's model, submits `/tugplug:review-plan <path>` as a turn, and gives the user's model back when it settles. Both halves are shipped machinery — `set_model` is a live control request with no respawn, and the card already submits skill turns for `/join`. The borrow is live-only and never writes the card's persisted selector, which is what makes a process death mid-review self-repairing.

`review-plan` is a real skill, not a hidden mode: the card invokes it automatically after devise, and it is also the by-hand path for a plan `devise` did not write (hand-authored, stale, or edited after devising). `/vet` goes away in the sense that matters — the user never types it, and what replaces it is not read-only.

Two halves, split by what each is good for: the **mechanical** half of vetting (skeleton conformance, anchor uniqueness, `Depends on:` resolution, ledger seeding, banned test frameworks) becomes a verb — `tugutil plan lint` — because a checker that always runs beats a rule the model must remember, the same reasoning as [P04]. The **judgment** half (design soundness, sequencing, tuglaws adherence, "does the codebase want this") stays with the model, which is the only thing that can do it.

The stage vocabulary loses the `vetted ⊙` declaration: after phase 2.1 there is no devised-but-unvetted plan to distinguish. `devised` means reviewed.

### [P08] A plan is reviewed *as of its content*; re-review is additive {#p08-review-stamp}

A plan is a **living artifact between devise and implement** — the user edits it interactively, and the system must know whether the review on record covers the bytes now on disk. The mechanism is the ledger mechanism applied to review:

- **The document carries the record.** Each Review Record round line carries a **content stamp** — a hash of the document *excluding the Review Record section* (the record is metadata about the review, not plan content). No sidecar, no database ([P06] applied to the plan lane).
- **A verb derives the answer.** `tugutil plan status <path> [--json]` recomputes the hash and compares it to the last round's stamp: `reviewed` / `stale` / `never reviewed`, plus round count, last round's date and model, lint verdict, and ledger progress. Every consumer reads the verb; none re-derives.
- **Re-review is additive and edit-respecting.** Rounds append, never rewrite. A user edit since the last round is a **decision to carry forward** — fix what it broke, name a consequence it missed, never revert its intent. A `done` ledger row is **frozen**: rewriting a step whose work already landed produces a document that lies about the tree; raise an Open Question or add a new step instead. A re-review orients on what moved (the git diff when the plan is tracked and dirty; the Review Record otherwise) and says which it used.

Consumers: `dash-implement`'s setup gate (see [P09] for its presentation), the review verb's bare-form resolution, and — as phase 5 polish only — a stale mark on the Lens/chrome surfaces.

### [P09] Decision points raise dialogs; documents record only what dialogs deferred {#p09-dialogs}

**A dialog belongs exactly where different answers produce materially different work, and nowhere else.** The skills in this lane are ours; every one that hits a genuine fork gets `AskUserQuestion` and puts the call to the user at the moment it arises, instead of stopping with prose or guessing. A `[Q##]` in a finished plan means **asked and deferred** — never never-asked.

The forks, which are the complete set:

- **Devise** — an Open Question the author cannot settle is asked before the plan is declared ready.
- **Review** — a judgment call (scope, product trade-off, no technically correct answer) is a dialog first; the answer lands in the plan as a decided item, and only a deferral becomes `[Q##]`.
- **Implement** — three: the **stale-plan gate** (plan changed since its last review → "Review now (Recommended) / Proceed as-is"; never a hard refusal — the plan is the user's); a **`dash step` refusal** (→ "Fix the plan and retry / Hand-edit the ledger this run" — the wrong guess corrupts the durable record); a **batch boundary** on a long plan (only when the run is long enough that eyes on the middle are plausible; never per-step).
- **Audit** — the verdict's disposition: "Carry the fixups now as rounds on this dash / Leave the list with you." The verdict itself stays read-only.
- **Join** — the empty-dash outcome asks "Release it / Leave it" (release is the user's gesture, and a dialog *is* the user gesturing). Join's other stops — conflicts, draftless, blockers — remain stops: they are correct refusals, not unasked questions.

**The never-ask list** (recorded in `tuglaws/dash-work-doctrine.md` so it holds): never ask to commit a round, never ask before running a checkpoint, never ask permission to write the join draft, never ask "should I continue?" between ordinary steps, never ask anything with a conventional default.

---

## The dash lifecycle state model {#state-model}

This is the shared vocabulary for `dash status`, the feed, the Lens section, and the join-mode presentation. States marked ⊕ are derived; ⊙ are declared via dash-log lines.

**Shaping** (no worktree yet): idea → brief → devised ⊕(plan file exists — and, per [P07], reviewed: the devise gesture does not emit an unvetted plan) → **stale-reviewed** ⊕([P08] — the plan's content moved past its last Review Record stamp; a re-review returns it to `devised`, and this is the only Shaping state a user can re-enter by editing).

**Working:** created ⊕(branch + worktree) → implementing ⊙(step *i* of *N*; rounds accrete ⊕) → built ⊙(`just app-debug` reported) → audited ⊙ → draft-ready ⊕(non-empty `dash:<id>` draft).

**Landing** — the join preflight fans into the four outcomes `join_in` already distinguishes, each with its own presentation:

| Outcome | Meaning | Surface |
|---|---|---|
| clean | preview merges without conflict | "sign here" — message + land |
| conflicted | conflicted path list from `merge-tree` | resolve lane (existing ladder + overlay store), then candidate-awaiting-land |
| blocked | inside worktree / repo root off base branch / intersecting base dirt / stale journal | named blocker + the unblocking act |
| empty | no commits past base | release handoff ("nothing to join — release this dash?") |

Then: landing → **interrupted teardown** ⊕(join journal `Integrated`/`WorktreeRemoved`/`BranchDeleted`; resumed by `--continue` — a real state users hit, with its own presentation) → joined ⊕(branch gone, `Tug-Dash` trailer on main).

**Discard:** releasing → released ⊕ (worktree and branch gone, nothing merged).

**Orthogonal:** parked ⊕(zero bound sessions, rounds exist) — visible in the Lens, never auto-cleaned.

---

## Phases {#phases}

Each phase is independently shippable and ends with the standard bar: `cargo nextest run`, `bun test`, `bunx vite build`, `just app-test-changed` green.

### Phase 1 — Foundation (Rust/CLI; nothing visible) {#phase-1}

The identity and binding substrate everything else stands on.

1. **Dash id** ([P03]): minted at `create`, stored `branch.tugdash/<name>.tugid`; surfaced in `dash list/show` JSON; `tugdash-core` gains id resolution (name→id, id→name). Draft rows for dashes move to `owner_id = <dash-id>` with a compat read window for existing `tugdash/<name>` rows (the same tolerant-read-then-cut pattern used for the worktree home migration).
2. **Session↔dash binding** ([P01], [P02]): `dash_id` column on the sessions ledger `sessions` table (schema-versioned migration); CONTROL verbs `bind_dash` / `unbind_dash`; `tugutil dash bind|unbind` for the skill path; binding echoed through `spawn_session_ok` and `list_card_bindings` into `CardSessionBinding`; restored by the existing restore pass. `dash create` auto-binds when `TUG_SESSION_ID` is present; join and release clear **all** bindings for the dash id.
3. **`tugutil dash status <name> --json`**: the one machine-readable readout — id, stage (per the state model), base, rounds, dirt, plan path, step *i*/*N*, draft presence, join-journal phase, bound sessions.
4. **Extract `dash_entries`** out of `tugcast/src/feeds/changeset.rs` into tugdash-core (the flagged duplication with the CLI), and extend `DashChangesetEntry` additively: `id`, `stage`, `step_current`/`step_total`, `bound_sessions`. The CHANGESET_ALL feed carries it to every deck for free.

**Contract to later phases:** `CardSessionBinding.dash` (id + name), `DashChangesetEntry` with stage/progress, `dash status` JSON shape.

### Phase 2 — Visibility (read-only UI) {#phase-2}

Dashes become visible everywhere they should be, with zero landing-path stakes.

1. **Changes dash lane**: `SessionChangesView` renders `snapshot.dashes` in dash grammar (name · base · rounds · dirty — never session-file grammar; the perky-frog rule), with range diffs via the already-built `{kind: "range"}` descriptor and the maintained join draft shown read-only. A dash-bound card fronts its dash's lane; unbound cards fold dashes under the project.
2. **Card chrome chip**: the bound dash's name in the Session card chrome; the visible answer to "where am I working?"
3. **Lens "Dashes" section**: new registered section (registry entry + `main.tsx` + `setSectionContent`/`collapsedSummary`), one row per inflight dash: name, stage, step *i*/*N*, mated session(s) with the `focus-session-card` jump, and a live in-progress indicator as a leaf subscription (the `SessionPhaseDot` pattern — never a high-churn field in the row projection). Parked dashes render with their own mark.
4. **`/dash <name>` gesture** ([P05]): local slash verb — resolve name; existing dash → bind this card; new name → `dash create` (which auto-binds). Bare `/dash` with dashes inflight opens the lane/section for discovery.

### Phase 2.1 — One-gesture planning: `devise` absorbs `vet` {#phase-2-1}

**Status: built on the `one-gesture` dash, awaiting the user's join.** The parser landed where the plan predicted, in `tugutil-core::plan` — so phase 3's `dash step` verbs reach the ledger grammar with no new crate and no dependency inversion. Two details differ from the sketch below and are worth carrying forward: plan **detection** keys on `{#execution-steps}` alone (this document has `{#plan-metadata}` and no steps, and is correctly not a plan), and the frame type lives beside `DashApiRequest` in `tugcast/src/server.rs` rather than in `tugcast-core::types` — nothing in the `bind_dash` family lives there.

Implements [P07]; devised in full at [dash-integration-2.1-one-gesture.md](dash-integration-2.1-one-gesture.md). Sequenced here deliberately: it must land **before** phase 3's skill renames and rewrites, so phase 3 rewrites one merged plan skill rather than rewriting `vet` and then deleting it. It is otherwise independent of phases 1, 2, and 4 — it touches the plan skills, a new `tugutil plan` namespace, and one card controller, none of which the binding or landing work reads — and could run as a parallel dash alongside phase 2.

1. **`tuglaws/plan-review-rubric.md`** — the vet skill's substance, promoted to doctrine: the five assessment axes (quality/coherence, technical choices, sequencing, holes and failure modes, test-plan sanity), the tuglaws cross-check obligation including the State Zone Mapping for tugdeck work, the "does this leave the architecture better" test, and the banned-test-shapes list (fake-DOM/RTL, mock-store assertions). Written as a rubric a reviewer applies, not as skill prose. `devise`, `audit`, and any future review surface cite it instead of each carrying a private copy — the same de-duplication phase 3 does for the `dash-run`/`dash-implement` doctrine text.

2. **`tugutil plan lint <path> [--json]`** — the mechanical conformance checker, in `tugutil` over a `tugutil-core::plan` parse of the devise skeleton (that crate already owns plan resolution, and `tugdash-core` already depends on it — so phase 3's step verbs reach the ledger grammar with no new crate and no dependency inversion). Checks: required sections present and in skeleton order; `{#anchor}` uniqueness and kebab-case; label discipline (`[P##]` two-digit and never reused, `[D##]` only as a citation into `tuglaws/design-decisions.md`, `[Q##]`/`S##`/`T##`/`L##`/`R##`/`M##`); every `**Depends on:**` resolving to a real step anchor; every Execution Step carrying a `**Commit:**`, `**References:**`, Tasks, Tests, and a Checkpoint; the Step Status Ledger present, seeded, and listing exactly the steps that exist; no banned test framework named in any Test Plan. Exit non-zero with a located diagnostic per violation. This is the same parse `dash step` ([P04]) needs for its strict ledger edit — one grammar, two consumers, so a plan that lints is a plan the step verbs can drive.

3. **The review runs as its own turn, on a borrowed model.** `devise` ends by signalling readiness through the running tugcast (`tugutil plan review-request`, the `POST /api/draft` shape), which broadcasts to the card — a signal from the skill, not the composer, so it cannot be defeated by how the user spelled the invocation. A `plan-review-controller` (the `commit-mode-controller` sibling) then captures the session's current selector, borrows the review model, and submits `/tugplug:review-plan <path>`. The turn reads the plan from disk, applies the rubric against the real code, **applies fixups rather than reporting them**, and appends the Review Record — all as visible transcript ink. The model is restored when the turn settles: completed, errored, interrupted, or unmounted.

   The borrow **never writes the card's persisted selector** (`dev.model/<cardId>`). That is not a detail: it means a crash mid-review leaves the persisted value correct, and the existing mount-restore in `use-model.ts` repairs the live session on the next mount — recovery for free, and no durable lie about what the card is running.

4. **The plan records its own review.** The skeleton gains a **Review Record** section: the round count, the fixups applied (one line each, citing the axis or law that motivated them), the lint result, and anything deferred. This is what makes the merge safe to trust — the assessment does not evaporate just because no human read it in a verdict message, and a later reader can see what was already considered.

5. **`review-plan` is a skill, with two entrances.** The card invokes it after devise; the user invokes it by hand — `/tugplug:review-plan <path>` — on a hand-written plan, a plan edited after devising, or one devised before this phase. One rubric, one code path. It is also the fallback when no tugcast is reachable to carry the signal: `devise` prints the command rather than declaring an unreviewed plan ready.

6. **Delete `vet`; rewire the hand-offs.** Remove `tugplug/skills/vet/`, with a one-release stub that prints the `review-plan` command and exits (matching the alias window phase 3 uses for the renamed dash skills). `devise`'s hand-off no longer forks — the review comes to it, and the only command it offers afterwards is `` `/tugplug:implement <path>` ``. Update `tugplug/CLAUDE.md`'s lifecycle listing and its `devise → vet → implement` flow line, and the repo `CLAUDE.md` where the skill roster is named. `audit` is untouched: it is the *post*-implementation pass over real code, a genuinely different artifact at a genuinely different time, and it retains its verdict because its findings become a build's fixup round, not a document edit.

**Contract to phase 3:** `tugutil-core::plan`'s skeleton parse and ledger grammar (shared with `dash step`), `tuglaws/plan-review-rubric.md` as the citable review doctrine, and one plan skill plus `review-plan` for phase 3's rename pass to consider. The borrow/release pair is also a general primitive: any later gesture that wants one turn on a specific model reuses it rather than growing its own.

### Phase 3 — Lifecycle codification (CLI + skills) {#phase-3}

The improvised workflow becomes verbs; the skills shrink to policy.

1. **Step verbs** ([P04]): `dash step start|done` editing the plan ledger table + structured dash-log lines; `status`/feed derive `implementing (i/N)` from them.
2. **Stage declarations** ([P06]): `built` and `audited` markers recorded by the verbs/skills that reach them.
3. **Draft symmetry**: the plain-dash lane maintains the join draft the same way `implement` phase 3 does (via `dash-run` skill text or a `dash draft` convenience), retiring `dash-join`'s compose-fallback branch.
4. **Skill renames + rewrites** ([P05]): `dash-implement`, `dash-run`, `dash-join`, `dash-audit` with one-release aliases; rewrite onto the new verbs (bind, status, step); factor the ~70% duplicated doctrine text between `dash-run` and `dash-implement` into one shared reference both cite; update `tugplug/CLAUDE.md`, repo `CLAUDE.md` git-policy exceptions, and the memory-relevant naming.

### Phase 3.1 — The plan lane becomes a workflow {#phase-3-1}

Implements [P08] and [P09]. The gap this closes was hit in practice immediately after phase 3 landed: a plan devised, then edited interactively, has **no sanctioned path to a final cleanup review** — the obvious gesture (`/tugplug:review-plan`, the very chip `review-plan` prints) silently runs on the card's current model, the strong path is a CLI verb named after its mechanism (`plan review-request`), nothing records *what* was reviewed, and a second review can quietly revert the user's hand edits back to what Round 1 wrote. Ad-hoc, wrong-suggesting, and confusing — this phase replaces it with an actual workflow.

Sequenced after phase 3 (it edits the skills phase 3 rewrote, and `plan status` lands beside `plan lint` in the `tugutil plan` namespace) and **before phase 4's implementation**, so phase 4's own recipe is devised, edited, and re-reviewed under the workflow it defines. Independent of the landing surface; runs as its own dash with its own devise recipe.

The program plan itself is deliberately **out of scope for this machinery**: it declares no `{#execution-steps}`, so `plan lint` exits 2 on it and `plan-review` stops rather than reviewing a brief as a plan. Program-plan edits are conversation edits; the workflow below governs phase recipes.

1. **The staleness primitive** ([P08]): the content-stamp grammar in Review Record round lines (`Reviewed `` `plan:<hash>` ``…`), hashed over the document minus the Review Record section; `tugutil plan status <path> [--json]` derives `reviewed`/`stale`/`never reviewed` plus rounds, last round's date/model, lint verdict, and ledger progress. Lives in `tugutil-core::plan` beside the parse, the linter, and the ledger edit; the review skill writes the stamp *via the verb*, so there is exactly one hash implementation.

2. **`/plan-review` as a local card verb** — the sibling of `/commit`, `/join`, `/dash`. Always routes through `plan-review-controller`, so the obvious gesture **always** gets the borrowed review model. Bare-form resolution, three steps and never a search: the bound dash's recorded plan (`branch.tugdash/<name>.tugplan`, already reported as `plan_path`) → the card's last-reviewed plan → refuse, printing the explicit form. `tugutil plan review-request` demotes to plumbing — still the devise signal path, no longer anything a user types.

3. **Re-review semantics in `plan-review`** ([P08]): edits-are-decisions, done-rows-frozen, orient-on-what-moved — and each round line stamps the content it covered and names its orientation (diff vs. record).

4. **Dialog discipline across the lane** ([P09]): grant `plan-review` the `AskUserQuestion` tool it never had; the ask-first-then-`[Q##]` rule; the enumerated forks added to `plan-devise`, `dash-implement` (stale gate, step-refusal, batch boundary), `dash-audit` (disposition), and `dash-join` (empty dash); the never-ask list appended to `tuglaws/dash-work-doctrine.md`.

5. **The stale gate in `dash-implement`**: setup runs `tugutil plan status` before walking; `stale` raises the [P09] dialog rather than silently implementing a plan whose review predates the user's edits — and never hard-refuses.

6. **The roster rename** ([P05] as amended): `devise`→`plan-devise`, `review-plan`→`plan-review`, `dash-run`→`dash-on`, each leaving a vet-precedent redirect stub. `dash-on`'s input grammar **trims to `<name> <instruction…>`** — the vestigial `status` / `join` / `release` sub-verbs go, since `dash-join` and `/join` own landing, `tugutil dash status|list` own the readouts, and release is a bare CLI call; one skill, one job, one argument shape. Hand-off strings, `tugplug/CLAUDE.md`, and the repo `CLAUDE.md` roster follow. All stubs — these three, phase 3's four, and `vet` — are deleted together in phase 5. **Renames land last within the phase**, after the machinery above is real, on phase 3's precedent: the rewritten skill text then quotes invocations that already work.

**Contract to later phases:** the `plan status` JSON shape and stamp grammar (phase 5's Lens/chrome stale mark reads it), the never-ask doctrine as the boundary any future dialog must respect, and the final skill roster under [P05]'s namespace rule.

### Phase 4 — Join mode (the landing surface) {#phase-4}

The twin of commit mode, over server machinery that already exists. No new Rust beyond receipts.

1. **Deck senders**: `changeset_join` / `changeset_release` join `changeset-verb-store` (the missing half the brief names).
2. **`join-mode-controller`** mirroring `commit-mode-controller`: `/join` (bare = bound dash; `/join <name>` = explicit) enters the mode; composer becomes the join-message editor seeded from the dash draft; Z5 swaps to cancel / auto-message / join; `evaluateJoinLandGate` as the exported pure gate (idle, no pending landing, preview clean-or-resolved, non-empty message), enforced at dispatch and affordance per the [P08] doctrine of the consolidation plan.
3. **Four-outcome presentation** per the state model: clean → land; conflicted → the resolve lane wired to the existing `changeset-join-store` overlay, then candidate-land; blocked → named blocker; empty → release handoff. Interrupted teardown gets a "resume teardown" affordance over `--continue`.
4. **Receipts**: join and release receipts as server-formatted shell-ledger ink (the commit-receipt [P07] pattern from the inline-dialog plan — one Rust formatter, durable, restored on reload); History badges keep reading the `Tug-Dash` trailer.
5. **Release's new home**: the dash lane row, shade/lane-only with the discard preflight (`discards k rounds · n dirty files`), honoring the consolidation plan's [P14] ruling.
6. **Land side-effects**: server clears the dash draft and all bindings for the id; the card exits join mode with the receipt in the transcript. The `tugplug:dash-join` skill survives unchanged as the headless/agentic path over the same verbs.

### Phase 5 — Polish + doctrine {#phase-5}

1. Multi-dash discovery and switching refinements (`/dash` picker when several exist; Lens ordering).
2. Parked-dash affordances: adopt (bind), release, or leave.
3. **`tuglaws/dash-lifecycle.md`**: the state model, the binding concept, the derive-vs-declare rule, and the landing doctrine — plus updates to `tracking-changes.md` (including its stale two-beat `/commit` description) and `design-decisions.md`.
4. Drop the one-release aliases (skill names, draft-row compat reads) once shipped bundles have turned over.
5. Stale-review mark on the Lens Dashes section and the dash chrome — the cosmetic remainder of [P08], reading `plan status` (or its feed projection); no new derivation.

---

## Risks {#risks}

| Risk | Impact | Mitigation |
|---|---|---|
| Draft-key migration (name→id) strands an inflight draft | med | compat read window; migration copies live `tugdash/<name>` rows to id keys on first resolution |
| Sessions-table migration collides with restore pass | med | additive column, schema-versioned; restore tolerates NULL dash_id |
| Ledger-table editing by `dash step` mangles a hand-edited plan | med | strict parse of the skeleton's ledger grammar; refuse (exit 1) rather than fuzzy-match; the skill falls back to hand-editing on refusal |
| Dash lane re-destabilizes the shipped Changes surface | med | phase 2 is view-layer only over unchanged stores; dash grammar kept visually distinct; app-test coverage per surface |
| Join mode diverges from commit mode conventions | low | mirror `commit-mode-controller` structurally; shared gate-evaluation shape; name the tuglaws in each dash commit |
| Self-review is weaker than a separate `/vet` invocation — the author grades its own paper | med | the review is a *separate turn* on Opus that re-reads the plan from disk and re-reads the code it claims, so it judges the artifact rather than the intent; `tugutil plan lint` moves the mechanical half out of model attention entirely; the Review Record makes a weak round visible instead of invisible; and every reviewer action is on-transcript, so a shallow pass is watchable in real time. The user retains a strictly stronger move than old `/vet` — `review-plan` by hand from a fresh session |
| The borrowed model outlives the borrow (crash, close, error, interrupt) | med | release is driven by turn **settle**, not success, and also fires on unmount; the borrow never writes `dev.model/<cardId>`, so a process death leaves the persisted selector correct and the existing mount-restore repairs the live session |
| Losing `vet` loses the deliberate pause before a build | low | the pause was never load-bearing — the answer was always "do the fixups". The review turn is interruptible, and `devise` still ends by handing off rather than implementing |

---

## Sequencing note {#sequencing}

Phases 2 and 3 are independent of each other (both depend only on phase 1) and could run as parallel dashes. Phase 4 depends on 1 and benefits from 2's lane rendering. Visibility-first is deliberate: it de-risks the binding concept with zero landing-path stakes before the landing surface is built on it.

Phase 2.1 depends on **nothing in this program** — it touches the plan skills, a new `tugutil plan` namespace, and one card controller, none of which the binding or landing work reads — so it can run as a parallel dash at any time. Its one ordering constraint is that it must precede phase 3, which rewrites the skill roster and would otherwise rewrite a skill 2.1 deletes; phase 3 also inherits 2.1's skeleton parse for its `dash step` ledger edits ([P04]) rather than growing a second one.

Phase 3.1 depends on 2.1 (the review machinery it puts a gesture on) and 3 (the skill roster and `tugutil plan` namespace it extends) — both shipped — and on nothing in phase 4. It runs **before phase 4's implementation** by design: phase 4's recipe is the first plan devised, edited, and re-reviewed under the workflow 3.1 codifies, which is the same eat-its-own-cooking sequencing phase 3 used for the step verbs.
