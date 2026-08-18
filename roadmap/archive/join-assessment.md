# Joining a dash: what the first real landing showed

The dash-UI work landed on `main` as `5964a0a19` — by CLI, from the terminal, with the conflict resolved by hand. The Changes shade was open the whole time, was invoked deliberately, and did not respond. This began as the post-mortem of that, written while it was fresh.

## What this document is

It is now the **working brief for landing dashes**, and it is meant to be picked up cold. It carries three things, in this order: what the incident was and what investigating it proved or overturned; what has since been fixed and how that is pinned by tests; and — at [The doctrine this is all heading toward](#the-doctrine-this-is-all-heading-toward) — the program that is actually left. A reader who only wants the work should start there and use [Starting again from cold](#starting-again-from-cold) for paths and [Working on this — the landmines](#working-on-this--the-landmines) before running anything.

The vocabulary, since it is Tug's own:

- A **dash** is a unit of work on its own git worktree and branch (`tugdash/<name>`), cut from a **base** branch (normally `main`) and recorded in git config as `branch.<name>.tugbase`. A dash accumulates **rounds** — ordinary commits on its branch.
- A **join** is landing a dash back: by default a squash of its rounds onto the base, performed by `tugutil dash join` or by the Session card's `/join <name>`.
- The **ladder** is the five-rung conflict resolver in `tugdash-core::resolve` that a conflicted join can run: replay probe → rerere → `merge-file` → structured-merge driver → AI. It never touches a checkout; it builds a **candidate commit** off to the side for the join to land.
- The **shade** is the Changes surface in the Session card; the **dash lane** is the strip inside it that lists dashes and carries the landing face (`Resolve` / `Join` / `Release`, plus `Adopt` / `Leave`).

The problem the whole document is circling: **landing a dash whose base has moved since the dash was cut.** Everything else is a symptom of that.

## What actually happened

The dash was built over six steps and arrived at the shade in the state the shade is for: six rounds, a written join draft, a clean build. Then:

1. `main` had moved. `3de067513 tugways(file-tip)` rewrote `identityTooltip` onto the shared `entity-tips` skeleton and deleted the local `.tug-session-identity-tip*` rules; the dash had added a live dash row to the same function. One file, twelve lines, both sides.
2. The shade said `conflicted` and named the file. Correct, and where its help ended.
3. Every control in the lane was a dead click. `Resolve`, `Join`, `Adopt` — no response, no explanation. `Release` was the only one not tried, and only because it does the opposite of what was wanted.
4. The landing happened in the terminal: `git merge main`, a hand resolution, `tugutil dash join`.

## The reproduction, and what it overturned (2026-08-15)

`tests/app-test/at0425-dash-conflicted-landing.test.ts` now reconstructs the incident's exact state for real: an unbound card, a join aimed by name, a preview that comes back `conflicted` over a genuine delete/modify conflict (the fixture rewinds the dash branch to the base tip's parent and deletes a file the tip modified — no commit on the base, no dirt in the developer's checkout). It settled three things:

- **The "impossible state" section this brief used to carry was a misreading.** The lane fronts by `frontedDashId ?? boundDashId`, and join mode's active target supplies `frontedDashId` (`session-card.tsx`, `dashId: joinSnapshot.active ? …`). `/dash-join <name>` deliberately fronts a dash the card never adopted, and that row correctly offers **Adopt** — fronting is about what is being landed, the binding about what the card works. ADOPT under "This card's dash" is the designed rendering of what happened, not a corruption.
- **The lane's wiring works end to end in a clean instance.** Join refuses on the conflicted outcome and carries its reason ("Resolve the conflicts first"); Resolve's click registers instantly (the offer face leaves on the store's synchronous flip) and the ladder round-trips to a terminal frame in seconds; Adopt sends a real `bind_dash` and flips to Leave on the `bind_dash_ok` that comes back. The incident's dead clicks do not reproduce structurally. What remains for the incident itself is environmental to that release instance — plus the presentation failures below, which make a correctly-refusing lane indistinguishable from a dead one.
- **The first explanation (`turnInProgress`) stays recorded as wrong.** The agent's turn had ended before the hand-off, so `canInterrupt` was false and that gate was open. A plausible mechanism found by reading is not a diagnosis — and neither was the fronting "contradiction" that replaced it.

## The ladder's false resolution — the worst finding, proven live

Driving the reproduction exposed a correctness bug that outranks everything else in this brief. `rerere_rung` (`tugrust/crates/tugdash-core/src/resolve.rs`) merges the branch in a scratch worktree and then harvests **any conflicted path whose working-tree file is non-empty and marker-free** as "resolved by rerere". A delete/modify conflict is marker-free by construction — git leaves the modify side's content in the tree — so the rung claims the path with the **base side's content** even though rerere did nothing. Binary conflicts should false-positive the same way. The per-file walk downstream has the correct guard ("non-content conflicts short-circuit to unresolved"), but rung 2 runs first and steals those paths.

Consequence, demonstrated on a probe dash: the "resolution" kept the base's file, the candidate equaled the base tree, and `dash join --resolve` **landed an empty squash** — the dash's entire change silently discarded under a green verdict (`ebee1d49f`, since removed). On the UI path the same false positive flips the outcome to `clean` and arms Join. Combined with the incident's other rerere lesson — the cache replayed a *wrong* recorded resolution during the hand merge — the rule is: **no rerere product may land without being shown.**

### Why the existing test does not catch it

`resolve.rs`'s inline test module already carries `delete_modify_short_circuits_to_unresolved`, and it passes. It passes because its `init()` helper builds a fresh temp repo with **rerere off and no `rr-cache`**, and `rerere_rung` early-returns on `!has_rr_cache(repo)` before it can steal the path — so the delete/modify falls through to the per-file walk and short-circuits correctly, exactly as the test asserts.

The bug is therefore invisible to the whole suite and appears only in a repo that has a populated `rr-cache`. This one does (`rerere.enabled=true`, many entries under `.git/rr-cache`), which is why it surfaced against real work and not in CI.

### The fix, in two halves

**Half one — stop fabricating. Done.** The predicate the rung was missing already existed: `RawStages::load()` returns `None` for exactly the non-content conflicts (a missing ours-or-theirs stage ⇒ delete/modify, differing modes ⇒ mode conflict, a NUL byte ⇒ binary). `rerere_rung` iterated `stages.keys()` and never consulted the value; it now iterates the pairs and skips any path whose `RawStages` is non-content, so those reach the per-file short-circuit that already handled them. Gating inside the rung rather than at the call site keeps the rung's returned map meaning "rerere really resolved this", which is what the `ResolvedBy::Rerere` label claims downstream. It also now consults `git rerere remaining` in the scratch worktree and skips anything rerere itself still lists — a direct answer alongside the inference from "the file has no conflict markers". An unreadable answer restricts nothing, so the cross-check can only tighten the harvest, never widen it.

**Half two — show the product. Done.** Even a correct rerere resolution is a *replayed* one, and the incident's hand merge proved a cached resolution can be stale and wrong. What shipped generalises that past rerere, because the argument does: every rung above the replay probe decides a file by machine, and rung 4 and rung 5 are outright guesses. So the gate is *any candidate built out of per-file resolutions*.

- **The server sends what it decided.** `FileResolution` carries `diff` — the unified diff from the base head to the candidate for that path alone, capped at 400 lines. It is read off the built candidate rather than the blobs, so an add, a delete and a mode change all arrive in the form git already renders. A partial outcome has no candidate and therefore no diffs: there is nothing to review when nothing can land.
- **The review is a state of the resolve round, not of a component.** `ResolveState.reviewed` lives in `changeset-join-store` keyed by dash, because both landing routes have to honour it — the lane's Join button and the composer's `/join <name>`. A review held in the landing face would gate one and not the other. Every fresh ladder run resets it; a new resolution is a new decision.
- **The gate is the shared one.** `evaluateJoinLandGate` grew a required `unreviewedResolution` input and an `unreviewed` reason, placed immediately after `outcome` — the same question one level finer: not *is* there something to land, but *has anyone looked at what the machine decided to land*. Making the field required rather than optional is what proved every call site had been updated; the compiler found all three.
- **The face shows the diffs and asks for a beat.** The resolved face renders the resolutions through the shared `TugDiffDocument` — the same surface the Changes shade and the Diff card use — and Join stays refused, reading *"Review what the ladder resolved first"*, until `Reviewed` is pressed. The document is passed a new `openAllByDefault` prop: its default expansion is line-budgeted, and a 100-line resolution would have arrived folded shut, which would have made the acknowledgement a checkbox over hidden content — the exact thing this replaces.

What this deliberately does **not** gate: a rung-1 replay and a clean one-shot squash, whose `resolved` list is empty. No file was decided by machine, so they land as they always did.

**The regression test.** `delete_modify_is_not_claimed_by_rerere`, alongside the older `delete_modify_short_circuits_to_unresolved`. Same conflict, but it seeds an `rr-cache` first — a real recorded resolution over an unrelated file on a throwaway branch, then `reset --hard` back to the base (`rr-cache` survives a reset) — so rung 2 actually runs. It asserts `resolved.is_empty()`, `unresolved == ["f.txt"]`, and `candidate_commit.is_none()`. Before the fix it failed exactly as predicted: `[("f.txt", Rerere)]`, with a candidate equal to the base tree.

**⚠️ Never probe this with `tugutil dash join <name> --resolve`.** That verb does not stop at the candidate — it lands. That is how the empty `ebee1d49f` reached `main` while this was being diagnosed. `--preview` is the safe CLI probe (it touches nothing and is what at0425 drives); everything else belongs in the Rust tests above, which build their own scratch repos in tempdirs.

### What the tests assert now

`tests/app-test/at0425-dash-conflicted-landing.test.ts` used to accept **any** terminal face — `resolved`, `partial`, or `error` — because the false positive made a delete/modify report `resolved`. It now pins the face to `partial` and requires it to name the conflicting file, and it passes: *"Still conflicting — resolve by hand: roadmap/join-assessment.md"*. It also declares `@covers … resolve.rs`, so a future edit to the ladder selects this test through `just app-test-changed` — nothing did before, which is part of why the ladder's behavior went unwatched at the UI layer.

`tests/app-test/at0426-dash-resolution-review.test.ts` is the review gate's, and it drives the *other* half of the ladder: a genuine content conflict (the dash rewrites a base-modified file wholesale), resolved by rung 4 via a stub `tugdash.mergedriver`, so a candidate arrives deterministically without the AI rung or this repo's `rr-cache`. It asserts the shape the incident lacked — the outcome reads `clean`, and Join is *still* refused with *"Review what the ladder resolved first"*; the diff of what the driver chose is on screen; `Reviewed` is what arms Join. The join itself is never fired: landing would rewrite the developer's `main`.

Both fixtures run against the live repository, so two things are deliberate in them. The raw-`git` helper retries past an `index.lock`, because test files run in parallel and both fixtures build dashes in the same repo. And at0426 records the `rr-cache` entries it found and removes any the run added — rung 4 teaches rerere what it resolved, and while a fixture conflict's preimage can never match real work, the run still leaves the developer's repo as it found it.

One fragility worth knowing before it bites again: the dash lane renders *below* the changed-file list, so on a busy working tree the row starts under the composer and a bare `nativeClickAtElement` lands on the editor. Both tests now `scrollIntoView({ block: "center" })` before pressing a row control. The symptom is a "dead click" that is nothing of the kind — `elementFromPoint` at the button's centre returns `DIV.cm-line`.

## Two defects the landing did establish

Both are read off the landed commit, not inferred. Both are still open; what to do about them is in [The two message defects](#the-two-message-defects) below.

- **The subject line is doubled** — `tugdash(dash-ui): tugdash(dash-ui): identity carries the dash run…`. The join prefixes `tugdash(<name>): ` onto the draft unconditionally, including when the draft already opens with a conventional subject.
- **The draft that landed was not the draft that was written.** `tugutil draft set --owner dash:dash-ui` wrote one message; the commit carries a different, auto-generated summary — accurate, but including a bullet nobody wrote. Something regenerated the maintained draft between the write and the join. If the draft is the thing a landing commits, a scribe silently replacing it is the more serious of the two.

## One hazard the resolution exposed

`git rerere` auto-staged a cached resolution for the conflicted file, silently, and it was wrong: it kept one side wholesale and discarded the other. Left alone it would have landed a tooltip styled by CSS that no longer exists — green build, green tests, broken hover.

This is the observation that became the review gate: any surface offering `Resolve` has to say **which rung resolved each file** and show what it produced, or it will land silent breakage on exactly the conflicts that recur. **Addressed** — see [half two](#the-fix-in-two-halves), which generalises it past rerere to every rung that decides a file by machine.

## What the dash-UI work did and did not do for this

Honestly: **almost nothing for joining.** It improved where a dash is *legible* — the masthead title run, the atom glyph, the Lens sub-row, the roster. The join surface is the Changes shade, which that work did not touch. Two indirect benefits only: the `TugBadge` elision fix applies to the lane's own dash-name badge, and the Lens sub-row makes the dash easier to *find* before you fail to act on it.

That is the chicken-and-egg named at the time, and it is worth stating plainly: legibility work does not move a landing that has no working controls.

## The doctrine this is all heading toward

Everything above is work on **the landing moment**, and the landing moment is the wrong place to fix landings. Two sessions of it bought correctness — the ladder no longer fabricates resolutions, and no machine-made merge lands unread — but neither made a landing *rarer* or *easier*. The conflict still ambushes you at the end of a run, when you want to be done, holding the least context you will ever have about why the two sides disagree.

The rule worth building to, and the one that makes a landing boring:

> **A landing problem should surface the moment it becomes true, not the moment you try to land.**

There are exactly three ways a landing problem becomes true, and each one has a moment long before the join where it could have been said out loud:

1. **The base gains commits.** True the moment someone lands on `main`. Today nothing notices until the join previews.
2. **The base checkout holds uncommitted work that the dash also touches.** True the moment the overlap appears — which is usually the moment the dash's round touches that file, hours before the join. Today the preflight computes exactly this intersection, but only when you try to land.
3. **The dash starts from a base that was already unclean.** True at `dash create`, the earliest moment there is. Today create says nothing about it.

Each of the three has its own item below. What makes them one program rather than three chores: they all need a **watcher on the base** — its ref for (1), its working tree for (2) — and they all move a discovery earlier. Design them together or the watcher gets built three times.

### Start from a base you can hope to land on

This is the cheapest of the three and it is worth doing first, because it removes a whole class of landing failure at the one moment when it costs nothing.

**What `dash create` does today.** It runs `git worktree add <path> -b tugdash/<name> <base_branch>`, cutting the worktree from the **base branch tip** — a commit. So the good news is already true: uncommitted changes in the developer's checkout are *not* carried into the dash. The dash worktree starts clean.

**What it does not do is anything about the dirt it left behind.** The uncommitted work stays in the base checkout for the whole life of the dash, where it does three kinds of harm:

- It is invisible to the dash's agent, which reads the base branch's *committed* state. The agent is reasoning about a `main` that does not match the one on screen.
- If it is later committed, it becomes base motion — problem (1), now with the dash's rounds already written against the older tree.
- If it is not committed, it becomes the `base-dirt` blocker at the join: `blocking_base_dirt` intersects the base's dirty tracked paths with the dash's changed files, and refuses the landing over the overlap. That refusal fires at the last possible moment over state that existed *before the dash had done anything*.

**The invariant to add:** `dash create` ends with a base checkout that holds nothing uncommitted, one way or the other. Three ways to satisfy it, and the third is the whole point:

- The base was already clean — the common case, and nothing happens.
- The dirt *is this dash's work*. Transplant it into the worktree and remove it from the base. This is the "I was editing `main`, and half-way through I realised this should be a dash" gesture, which is a real and desirable way to start, and today it has no support at all.
- The dirt is unrelated. Say so, name the paths, and offer commit-or-stash as an act rather than leaving it to be discovered at the join.

**The precedent is already built and shipped.** `adopt_plan_in` does exactly this for one file: it moves the plan into the worktree and then calls `clean_base_plan_copy` to remove the base copy, restoring a tracked path with `git checkout HEAD --` (naming `HEAD` explicitly, because a bare `git checkout --` restores from the index and a *staged* edit would survive). `BasePlanState` already classifies a path as `Clean` / `TrackedDirty` / `Untracked` / `Absent`, and `is_dirt()` already draws the line between "a second live copy" and "ordinary branch divergence". The rollback ordering is worked out too: the transplant runs last in `create`, so a failure tears the dash down the same way a failed `post_create` hook does, and the base copy is still intact when it does. Generalising one-file transplant to *the working set* is an extension of a tested engine, not a new one.

**The honest counter-argument, recorded so it is not re-discovered:** most dashes get created on a tree with *some* unrelated dirt, and a create that refuses every time would be intolerable. So the default cannot be a refusal. The shape that survives that objection is a **decision, not a veto**: create proceeds, but it states what it left on the base and offers the two acts, and it defaults to taking nothing. The refusal only belongs where the harm is certain — and the one place it is certain is a path the dash is about to work on, which at create time is knowable only when a plan was adopted (the plan names its files). That is worth a design pass rather than a guess.

**One asymmetry to fix while in here:** `create` does not care which branch the developer's checkout is on — it cuts from the base *ref*. But the join's preflight has an `off-base` blocker that refuses to land unless the checkout *is* on the base branch. Creation is commit-based and landing is checkout-based, and nothing warns you at the start that the end will demand something the start did not.

### Replay the rounds when the base moves

The big one, and the item that changes the dash lifecycle rather than the dash UI. When `main` moves under a live dash, replay the dash's rounds onto the new tip *then and there*: a clean replay just happens and nobody is told; a conflicted one becomes an ordinary agent turn in the dash's own session, with the stages and the dash's intent in hand, reviewed like any other round. By the time you land, the dash is already sitting on current `main` and any disagreement was settled hours earlier by the agent that wrote the code, with you present.

**The engine already exists.** `replay_probe` — rung 1 of the ladder — replays a dash's rounds one at a time onto the current base with `merge-tree --merge-base=<round^>` + `commit-tree`, and returns the replayed head when every round comes out clean. That is base-motion replay, complete and unit-tested (`replay_probe_resolves_base_already_advanced_and_lands_replay_shape`). It simply runs at the wrong time: once, in memory, on the `Resolve` click, and its result is thrown away unless the *whole* replay is clean.

So the distance here is not merge machinery. It is lifecycle and bookkeeping, and that is what the design brief has to answer:

- **What watches the base ref, and when is acting safe?** Not mid-turn, and not over a dirty dash worktree. Shares its watcher with the overlap warning above.
- **The dash worktree is checked out at the old base.** Moving the branch under a live checkout is the genuinely hard part, and it is where this can make things worse rather than better if it fires at a bad moment.
- **Replayed rounds get new SHAs.** The dash-log, the plan's Step Status Ledger commit cells, and anything else holding a commit id all reference the old ones.
- **How does the conflicted case become a turn?** It needs a way to inject a turn into the dash's bound session carrying the stages plus the dash's intent, and to mark the resulting round as a rebase resolution rather than ordinary work.
- **What happens when no agent is bound**, or the session is gone? The fallback is today's landing-time ladder, which is exactly why the ladder stays.
- **Does the user ever see it?** "Clean replays are silent" is the goal, but silence about history rewriting itself is its own hazard. Probably a settled, glanceable mark rather than an interruption.

### The tactical layer

Still owed, none of it paid down by the review gate. Worth doing, but it is polish on a surface the two items above may make rare, so it should not go first.

- **Decide what a turn should legitimately block.** The blanket `turnInProgress` gate sits on every control — `Join`, `Resolve`, `Release`, `Adopt`/`Leave`. It was not what broke the incident, but it is wrong on its own terms: a landing mutates the base while an agent may be mid-edit, so *some* gate is right, but `Resolve` touches only the dash and blocking it locks the one escape hatch a conflicted dash has.
- **A refused control must state its reason without a hover.** Each button carries its reason as a native `title`, and `.tug-button:disabled` sets `pointer-events: none` — an element with no pointer events never hovers, so that reason can never render. This is dead code wherever it appears. It includes the review gate's own refusal, which reaches the user only because the review block underneath says the same thing in prose.
- **Make disabled look disabled.** `--tugx-control-disabled-opacity` is `0.65` dark, `0.7` light. A filled action button at that strength reads as live, and when a whole cluster is disabled at once there is no full-strength control adjacent to calibrate against.
- **Give a conflict somewhere to go.** The shade named the file and stopped. The diagnosis that made the hand resolution possible — *which commit on the base touched this file, and when* — is `git log --name-only` archaeology the UI had every fact needed to do.

### The two message defects

The doubled subject prefix is understood and mechanical: `integrate_message` prepends `tugdash(<name>): ` unconditionally, including when the draft already opens with a conventional subject.

**The other one is not understood, and that makes it the most urgent single item in this brief.** `tugutil draft set --owner dash:dash-ui` wrote one message; the commit carries a different, auto-generated summary. Something regenerated a maintained draft between the write and the join. If the draft is the thing a landing commits, a scribe silently replacing it is a correctness bug, not a polish item — and it is the only defect here whose *mechanism* is still unknown. Reproduce it before building anything on top of the draft.

**Both addressed, and the name above was wrong.** Nothing regenerated the draft — the join never read it. `tugutil draft set` keyed the row by its **cwd**, which for a planned run is the dash worktree, while the join's reader probes only base-repository-root spellings; the row could never match, so `integrate_message` fell through to a different body. The authored draft survived untouched in the ledger, which is how it was proved. The write now keys by the base root through a single resolver, legacy worktree-keyed rows are read through a bounded probe that one authored write retires, the wrap is idempotent, and a string-equality test at the `join_in` layer pins the landed message to the authored draft byte for byte. See `roadmap/draft-contract-plan.md` for the full reconstruction.

### Suggested order

1. ~~**The draft regeneration bug**~~ — **addressed**; it was a keying defect, not regeneration. See above.
2. ~~**Clean base at creation**~~ — **addressed**. `dash create` reports the base's uncommitted working set and warns when the checkout is off the base branch; `--carry` moves that work into the dash, and `dash release` returns uncommitted worktree work to the base rather than destroying it. The doctrine is in [`tuglaws/dash-work-doctrine.md`](../tuglaws/dash-work-doctrine.md#starting-from-a-dirty-base).
3. ~~**Base-motion replay**~~ — **addressed**. A dash whose base moves is replayed onto the new tip the moment it is safe: quietly when clean, leaving a settled mark and a `replayed` dash-log line; as an ordinary reviewed turn in the dash's bound session when a round conflicts. The landing-time ladder is untouched and remains the fallback. Plan: [`roadmap/base-motion-replay-plan.md`](base-motion-replay-plan.md); doctrine: [`tuglaws/dash-work-doctrine.md`](../tuglaws/dash-work-doctrine.md#when-the-base-moves).
4. **The tactical layer** — after the surfaces have settled.

## Starting again from cold

Everything named above, by path:

| What | Where |
|---|---|
| The lane, `orderDashLane`, `DashRow`, the "This card's dash" label | `tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx` |
| The `Resolve` / `Join` / `Release` face | `.../session-changes/session-changes-dash-landing.tsx` |
| `boundDashId`, `turnInProgress`, `laneBinding`, the adopt/leave frames | `.../session-changes/session-changes-view.tsx` |
| `evaluateJoinLandGate`, `joinDisabledReason`, `resolutionAwaitsReview` | `tugdeck/src/lib/join-mode-controller.ts` |
| The shared diff surface the review renders through (`openAllByDefault`) | `tugdeck/src/components/tugways/tug-diff-document.tsx` |
| `.tug-button:disabled` (`pointer-events: none`, the opacity) | `tugdeck/src/components/tugways/internal/tug-button.css` |
| `--tugx-control-disabled-opacity` | `tugdeck/styles/themes/*.css` |
| The dash entry's shape (`bound_sessions`, `stage`, `review`) | `tugdeck/src/lib/changeset-types.ts` |
| App-tests over this lane | `tests/app-test/at0405-changes-dash-lane.test.ts`, `at0417-join-mode.test.ts`, `at0418-join-outcomes.test.ts`, `at0425-dash-conflicted-landing.test.ts`, `at0426-dash-resolution-review.test.ts` |
| Dash fixtures for tests (`createDash`, `releaseDash`, `commitRound`) | `tests/app-test/dash-fixture.ts` |
| **The resolution ladder** — `resolve_conflicts`, `rerere_rung`, `RawStages::load`, `has_rr_cache`, and the inline `mod tests` | `tugrust/crates/tugdash-core/src/resolve.rs` |
| `integrate_message` (the unconditional `tugdash(<name>): ` prefix), `join_in` | `tugrust/crates/tugdash-core/src/ops.rs` |
| **`create`** — `git worktree add -b <branch> <base_branch>`, the post-create hook, the rollback ordering | `.../ops.rs` (`pub fn create`) |
| **The transplant** — `adopt_plan_in`, `clean_base_plan_copy`, `BasePlanState` / `is_dirt`, `base_plan_dirt`. The working precedent for a clean base at creation | `.../ops.rs` |
| **The join preflight** — `blocking_base_dirt` (intersects base dirt with the dash's changed files), `base_dirt_detail`, the `off-base` / `base-dirt` / `stale-journal` / `empty` blockers | `.../ops.rs` |
| **`replay_probe`** — rung 1, which *is* base-motion replay, running at the wrong time | `.../resolve.rs` |
| The server's resolve handler (`do_changeset_join_resolve`) and the control dispatch | `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` |
| The AI rung's scribe seam and the progress deltas | `tugrust/crates/tugcast/src/feeds/join_resolve.rs` |
| The client's resolve overlay store (`ResolveState`, the delta/ok/err frames) | `tugdeck/src/lib/changeset-join-store.ts` |

State of the world at the last update (2026-08-15): `main` is at `a36ec60f6`, which carries everything described above — the reproduction (`at0425`), the `rerere_rung` fix and its regression test, and the review gate with `at0426`. The three commits of this line of work are `e98683647` (the reproduction and the diagnosis), `25567b165` (half one), `a36ec60f6` (half two). Nothing of it is uncommitted except later edits to this brief.

No dashes exist and no debug instances are running; the fixtures leave no `tugdash.mergedriver` config, `rr-cache` entry, worktree, or `tugdash/*` branch behind. Green at that commit: `cargo nextest run` (2621 tests), `bunx tsc --noEmit`, `bunx vite build`, `just app-test-changed` (20 files, 32 tests). `bun test` is 6759/1, the one red being the pre-existing `layout-imposer-solutions` golden table — red on `main`, not ours. The empty probe commit `ebee1d49f` described above was reset off `main` and is gone.

Next piece of work: the **tactical layer** — item 4 of the suggested order, and the only one still open. The first three are addressed; the base-motion program was designed, implemented, and written down in [`roadmap/base-motion-replay-plan.md`](base-motion-replay-plan.md).

## Working on this — the landmines

Read these before touching anything; each one cost something to learn.

- **`tugutil dash join <name> --resolve` LANDS.** It runs the ladder and then *completes the join*, squashing onto the base. It is not a dry run. Using it to probe the ladder is how an empty `ebee1d49f` reached `main` while this was being diagnosed. The safe CLI probe is `--preview`, which reports conflicts through in-memory `merge-tree` and touches nothing. To exercise the ladder itself, use the inline `mod tests` in `resolve.rs` — its `init()` helper builds a scratch repo in a tempdir.
- **Only the user commits.** Every fix in this line of work has been handed over uncommitted. Never run `git commit`, `git push`, or a history-rewriting command; and never hand over a `git reset` command without re-reading `HEAD` first, because the working tree may have been committed since you last looked. That mistake destroyed a commit here once, recovered only through the reflog.
- **A Rust change needs `just build-app` before any app-test can see it.** `just app-test` refreshes `dist`, not the app bundle.
- **Verify tugdeck with `bunx vite build`** — the debug app loads the prod rollup bundle, so a change that only works under HMR is not done.
- **The app-tests here run against the live repository.** They build real dashes on real conflicts. Keep them putting the repo back: no leftover `tugdash.mergedriver` config, no `rr-cache` entries the run added, no stray worktrees or `tugdash/*` branches. `git worktree list` and `git branch --list 'tugdash/*'` are the check.
- **`bun test` has one pre-existing red** — the `layout-imposer-solutions` golden table. It is red on `main` and is not yours. Do not regenerate it to get a green run; that would mask whatever actually moved it.

## Open questions

- Is the composer's join route (`/join <name>`) reachable in the state the shade was in? It shares `evaluateJoinLandGate`, but the fronting inconsistency above is the lane's, and whether the composer route sees the same broken state is unknown. Neither route was tried before falling back to the CLI.
- Should a landing be reachable at all from a session mid-turn, or should the shade offer to queue it for the turn's end?
