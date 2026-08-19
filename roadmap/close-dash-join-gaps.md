# Closing the Dash/Join Gaps: Two Rounds {#close-dash-join-gaps}

**Purpose:** Carry the dash/join lane the rest of the way toward the statement that framed this whole arc — *git versions the repository; it doesn't version the project* — with two rounds: one that makes the dash machinery itself a citizen of the instance model so app-tests run from any worktree (done — see Round 1's status note), and one that makes a conflicted join an **agent's job to finish**: the agent reconciles the divergence from intent, verifies the joined project (build + derived test selection), and escalates to the user only when intent itself is in question — never by presenting diffs for hunk-level adjudication.

This is a brief, not a plan. Each round gets its own `/tugplug:plan-devise` pass when picked up; the open questions below are the ones devise must ask before writing steps.

**Terminology, binding on everything below and on all work under it:** dashes are **joined**. There is no "landing" process separate from joining, and the words *land / landed / landing* are retired from this lane's vocabulary (decision 2026-08-19). Where this brief quotes current code or UI that still says "land," the quote is a rename target, not an endorsement.

---

## Where the arc stands {#where-the-arc-stands}

The join-truth round (`roadmap/join-pipeline-truth.md`, joined 2026-08-18) closed the *epistemic* half of the integration gap: join state is now one server-owned fact on the changesets feed, keyed by the [L29] `workspace_key`, with candidates anchored to git ancestry and every refusal required to name a mounted control or a reason in time. The deadlock class (two client stores keyed by two spellings of one path) is unrepresentable, and silence is structurally excluded.

The universe-scope round (`roadmap/dash-universe-scope.md`, joined 2026-08-19) closed the first of the remaining gaps: `TUG_REPO_UNIVERSE` gives repo-root resolution an explicit boundary, the `justfile` refusal and its `TUG_APPTEST_ALLOW_WORKTREE` escape are deleted, app-tests run green from any dash worktree, and at0441 presses the join control against a scratch repo through a completed join.

Two gaps remain, and both are really one gap seen from two sides — **the join treats the human as the machine's reviewer**:

1. **The join gate trusts git's answer, not the project's.** `tugdash-core/src/ops.rs` (the join path) runs no build and no test. A merge that is textually clean but semantically broken — the renamed symbol on one side, the new call site on the other — sails through `deriveJoinOutcome` as `clean` and joins behind a green readiness line.
2. **The resolution machinery is framed for a human diff-review workflow.** The ladder in `tugdash-core/src/resolve.rs` resolves what it can and then hands the human two jobs a machine should be doing: *reviewing* the machine's per-file decisions (each `FileResolution` carries "the reviewable diff," and the join gate reads the `tugjoinreviewed` mark that `write_reviewed` records against the candidate) and *finishing* whatever the ladder could not (an unresolved file is simply handed back). Tug presents an AI workflow; a surface that asks the developer to reconcile diverging diffs — any approve/reject interface over hunks — is a rejected design (2026-08-19). Divergence is reconciled from **intent**, by an agent, and the human is consulted only in intent terms, only when intent is genuinely in question.

On undecidability: it is conceded that no tool can guarantee two clean-merging changes remained *true* about each other in the general, adversarially constructed case. That is not the target. The target is the everyday case — the merge that compiles or doesn't, the semantic drift the project's own tests already know how to catch, the conflict whose right resolution is evident from what each side was trying to do. The success statement is precise: **no breakage that the project's own checks would have caught may join silently, and no divergence the dash's own record can adjudicate may be pushed back onto the human.** What remains beyond that — merges that pass every check and are still wrong in an intent no document recorded — is the residue human judgment was always for, and it is asked for as a question about intent, not as a diff.

---

## Round 1 — the dash machinery joins the instance model {#round-1}

> **Status: done.** Planned as `roadmap/dash-universe-scope.md`, implemented on the `universe-scope` dash, joined to `main` 2026-08-19. The section is kept as the record of the round's reasoning; its details are current as shipped (the scope variable shipped as `TUG_REPO_UNIVERSE`, and the scratch base shipped as a scratch *repo* under `TUG_DATA_DIR` redirect, which at0441 proved out).

### The actual blocker, precisely {#round-1-blocker}

The `justfile`'s `app-test` recipe refused to run from a linked worktree or a `tugdash/*` branch. The harness itself was **not** the problem — it already derives per-worktree identity end to end: `WTSLUG` from the branch, `TUG_APPTEST_ID_PREFIX="apptest-<wtslug>"` scoping instance ids, every destructive sweep scoped to this worktree's instances, and the bundle id `dev.tugtool.app.apptest` baked so build and run cannot disagree.

The problem was one function: `tugdash-core::ops::main_repo_root` (via `tugutil_core::find_repo_root_from`). **Every dash verb hops to the main checkout before doing anything.** So a fixture dash created by a test running from a worktree was created against the base checkout — while the app under test had the *worktree* open as its project. The refusal was a confession, not a fix.

The hop exists for a good reason in the developer flow: a human running `tugutil dash create` from inside a dash worktree means "against base" — nested dashes were never a designed thing, and dash state (registry, log, worktree homes) lives at the base root. The hop is right for that flow and wrong exactly when the "worktree" is itself the project an app instance has open.

### Design direction {#round-1-direction}

**The dash universe is a property of the project, not of the process.** Dash verbs resolve their repo universe from an explicit boundary, never a heuristic: `TUG_REPO_UNIVERSE` names the checkout that owns this process's universe, consulted before any `.git` inspection; unset preserves the hop byte-for-byte. The refusal block and its override were **deleted**, not widened — the recipe pins the universe and runs. Registry, dash-log, and worktree homes follow the scoped root, so a fixture dash is born, listed, joined, and torn down entirely inside the universe the app under test can see.

**Scratch-base fixtures.** at0441 had stopped one beat short of pressing the join control, because a fixture dash's base was whatever branch the checkout had out — the join would have squashed a fixture commit onto the developer's live branch. With the universe scopeable, at0441 runs its whole arc on a scratch repo with a `TUG_DATA_DIR` redirect: the join squashes onto the fixture's own base and teardown leaves nothing.

### What Round 1 delivered {#round-1-deliverables}

- `just app-test <file>` and `just app-test-changed` run green from a dash worktree; the refusal and its override are gone from the `justfile`.
- Every future `dash-implement` run executes its app-test checkpoints in place. The "statically adapted, never executed" gap cannot recur.
- at0441's final beat: the join control is pressed, the squash joins a scratch base, the feed reports the join, teardown leaves nothing.
- The dash verbs' repo resolution has exactly two behaviors — hop (default, developer flow) and scoped (explicit) — both stated where `find_repo_root_from` lives, neither inferred.

---

## Round 2 — the agent-finished join {#round-2}

### The gap, precisely {#round-2-gap}

`Ready to land — ⌃⌘C, or /dash-join` (the readiness line in `tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-landing.tsx` — filename included, a rename target) means today: *git found no overlapping hunks, or every conflict has a machine resolution the human has reviewed*. Two things are wrong with that sentence, and they are this round's whole subject.

**First, nothing asks the project.** No build, no test. The `@covers` selection derivation already answers the question git cannot pose — "which project-level truths does this change bear on?" — and pointed at a candidate merge's combined diff (`base_head..candidate`) instead of a working diff, it is precisely the scoped verification a project-level join needs: derived, not guessed. The Round 1 harness can now run that selection from any worktree, including a scratch one holding a materialized candidate.

**Second, the human is the machine's finisher and reviewer.** The ladder's last rung is already an AI — but the smallest possible one. `ScribeFileMerger` (`tugcast/src/feeds/join_resolve.rs`) hands a headless `claude -p` three blobs and one intent string (`resolve_intent`: the maintained draft + round subjects) and takes back bytes: **no tools, no worktree, no sight of the rest of the project, no way to run anything, no feedback loop, and no escalation** — a hard file returns `None` and lands in the human's lap as an unresolved conflict, and every file the machine *did* resolve waits on the human's diff review (`tugjoinreviewed`) before the join gate opens. The doctrine comment in `resolve.rs` — *every rung above the replay probe is a machine decision the user never saw* — was written as a reason to show the human the diff. This round takes it to its actual conclusion: the machine's decisions are the machine's to verify, and the human's attention is spent on intent, not on text.

### Design direction {#round-2-direction}

**Tier zero — the rename.** *Land → join*, everywhere, before anything else is built, so all new work is born with the right vocabulary. The sweep is wide but mechanical: `ops.rs` join-path identifiers and receipts, `deriveJoinOutcome` readiness strings, `session-changes-dash-landing.tsx` and its kin, test names (`at0436-join-land-press`), `tuglaws/design-decisions.md` and `tuglaws/app-test-harness.md` prose, the tugplug skill texts (`dash-implement` says "landing gesture" throughout), and the roadmap docs. One verb, one concept: dashes are joined.

**The join agent.** A conflicted join stops being a ladder that gives up into a review queue and becomes **one agent's job to finish**. The algorithmic rungs stay — replay, rerere, merge-file, structured driver are cheap, deterministic, and teach rerere — but everything past them changes owner. The agent:

- works in the **materialized candidate worktree** (the scratch-worktree precedent the rerere rung already set), confined to it;
- is **prepared, not prompted ad hoc**: it receives the dash's intent corpus — the adopted plan document in the dash worktree, the maintained join draft, the round subjects (`resolve_intent` composes the last two today and grows to carry the plan and the base side's own motion since the fork), and both sides' diffs;
- **does the fixups itself** — reads the surrounding project, edits the files, reconciles renamed-symbol-vs-new-call-site by making the project true again, not by picking a hunk;
- **verifies its own work** (below) and iterates until green or genuinely stuck;
- **reports** in prose a human wants: which files diverged, what each side was doing, what reconciliation was chosen and why, and the verification verdict — streamed as progress the way the S12 `changeset_join_resolve_delta` frames already stream per-file rung status.

**Verification is the agent's feedback loop first, the face's fact second.** Two tiers, both computed against the materialized candidate:

- **Tier 0 — the joined tree builds.** `cargo check` scoped to touched crates, `bunx tsc --noEmit` / `bunx vite build` when the merge touches tugdeck. Cheap; always run.
- **Tier 1 — the derived selection passes.** The `@covers` selection over `base_head..candidate`, run via the Round 1 worktree-capable harness. Expensive (app-tests serialize machine-wide), so scheduled deliberately — but its *audience* is the agent: a red result sends the agent back to repair its own reconciliation, and only a red the agent cannot repair reaches the human, named. (This also defuses the known low quality of parts of the test corpus: a flaky or vacuous test going red costs an agent iteration, not the developer's attention. Culling the non-falsifiable and pixel-measuring tests is a separate, acknowledged roadmap item — deliberately not part of this round.)

The verification result still lands on the feed's join block as a server-owned `verification` fact, cached by `(base_head, candidate_sha)` per the join-truth cacheability split — SHA-anchored facts cache; dirt-answering facts never do. The epistemic layer is unchanged; what changes is who consumes the fact first.

**Escalation is rare, and it is about intent.** The agent asks the human only when the dash's own record cannot adjudicate — two sides that changed the same behavior with conflicting purposes, or a red verification it cannot repair. The ask is phrased in intent terms with concrete resolutions as options (*"the dash renamed the setting per its plan; base meanwhile made it per-instance — keep the rename and carry it into the per-instance form, or hold the dash's flat form?"*), rendered in the Session card's `QuestionDialog`, honoring its 2–4 option shape. Never a diff with approve/reject. The precedent for a question that arrives outside the conversational turn is the `side_question` control-request (`tugproto/src/inbound.ts`) — that one rides Claude's stdin via tugcode, which is exactly the transport question devise must settle (below).

**The agent runs under a charter, the SharedAgent way.** [D127]'s discipline — a named, reviewed job contract rather than an ad-hoc prompt — applies in full: the resolver's charter states what it may touch (the candidate worktree, nothing else), what it must read, when it must escalate, and what its report contains; changing the charter is a reviewed contract change. What does *not* transfer is the pooled worker shape: `shared_agent.rs` workers are deliberately tool-less turn machines with 2–6 s ceilings and no filesystem, and the resolver needs tools, a worktree, and minutes. So the resolver is either a new tool-capable worker class on the SharedAgent machinery or a per-join spawn (the `ScribeSpawner` seam is the precedent) operated under a SharedAgent-style charter — devise's central design question.

**What the human sees.** The join face's states become: *resolving* (agent working, progress streaming), *verified — ready to join*, *question pending* (the escalation, with the QuestionDialog as the named control), and *stuck, with the reason named* (a verification failure the agent could not repair, or an agent error) — each in the reachability discipline join-truth established: every state names a mounted control or a reason in time. The human's gestures are: join, answer the question, or take over — never "review these diffs."

### What Round 2 delivers {#round-2-deliverables}

- A conflicted join completes without the human reading a diff: the agent reconciles from intent, verification comes back green, the join proceeds, and the report says what was done and why.
- A textually clean, semantically broken merge cannot join silently: verification catches it, the agent repairs it or escalates with the failure named.
- Escalations are intent-phrased `QuestionDialog` asks; the diff-review gate (`tugjoinreviewed` as a human mark) is retired, with the per-file resolution receipts kept as the record the agent's report cites.
- The word "land" no longer names the join act anywhere — code, UI, tests, tuglaws, tugplug, roadmap.
- The at0441 arc becomes: conflicted → agent-resolved → verified → joined, with the escalation path pinned by its own fixture (a conflict constructed so intent genuinely cannot adjudicate).

### Open questions for devise {#round-2-questions}

- **Worker substrate:** a tool-capable worker class on the SharedAgent machinery, or a per-join headless spawn under a SharedAgent-style charter? (Lean: the spawn — the `ScribeSpawner` seam exists, and pool warmth buys little for a minutes-long job — but the charter/JobSpec review discipline comes along either way.)
- **Escalation transport:** a server-initiated question path from tugcast to the card's `QuestionDialog` (a new control frame + answer round-trip), or running the resolver through a session via tugcode so `AskUserQuestion` works natively? The first is new plumbing; the second entangles the resolver with a conversational session it doesn't otherwise need.
- **Verification scheduling:** Tier 0 always; when does Tier 1 run, given machine-wide app-test serialization — every agent iteration, only on the agent's claimed-done candidate, or policy-per-project? What does the face show while iterations run?
- **Takeover shape:** when the human answers "let me" instead of picking an option, what do they get — the candidate worktree opened as a project, or the conflict handed to the session's own conversation?
- **Receipts:** which of `FileResolution` / `resolved_rungs` survives as the report's citation layer, and what replaces `write_reviewed` as the gate fact (the agent's verified-green claim, presumably, anchored to `(base_head, candidate_sha)`).

---

## Sequencing and dependencies {#sequencing}

Round 1 preceded Round 2 by necessity: running the derived selection against a materialized merge worktree **is** running app-tests from a worktree, and at0441's completed-join beat is the fixture spine Round 2 extends. Within Round 2, the rename tier goes first; the verification tiers and the agent can then build in either order, but the agent without verification has no feedback loop, so verification-first is the natural walk.

Round 2 extends, and must not fork, the doctrines join-truth established: server-owned facts on the feed, [L29] keys everywhere a path is compared or persisted, the cacheability split (SHA-anchored facts cache, dirt-answering facts never do), and refusals that name a mounted control or a reason in time. The agent adds one more to that list, inherited from [D127]: **model work runs under a named, reviewed charter — no API anywhere accepts an arbitrary prompt.**

## Success criteria for the arc {#success-criteria}

- A full `dash-implement` run — plan through build — executes every checkpoint, app-tests included, from its own worktree, with zero residue in the developer's checkout afterward. *(Met, Round 1.)*
- `TUG_APPTEST_ALLOW_WORKTREE` no longer exists in the tree. *(Met, Round 1.)*
- at0441 covers the entire poster-child arc through a pressed join. *(Met, Round 1; Round 2 extends the arc with agent resolution and verification.)*
- A textually clean, semantically broken merge cannot join silently: it either joins verified-green or stops with the failure named — never behind a face that said nothing.
- The standard path through a conflicted join involves no human diff adjudication: the human's decisions, when asked for at all, are intent decisions posed as questions.
- The verb is **join**, everywhere.
