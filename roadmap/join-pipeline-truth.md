<!-- devise-skeleton v5 -->

## Join Pipeline Truth — server-owned join state on the changesets feed {#join-pipeline-truth}

**Purpose:** Collapse the dash join pipeline's four client-side state fragments into one server-owned `join` block on the dash's changesets-feed entry, anchor the resolution ladder's candidate in git so it survives reloads and relaunches, sweep the pipeline's path keying onto `workspace_key` ([L29]), dissolve the JOIN mode-entry button into state-driven controls, and make every land refusal name a control that is actually on screen.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-18 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-18, opus.** Reviewed `plan:616ecfa15b7ba717`. Lint: 0 errors, 1 warning (the missing Review Record, closed by this round).
Oriented on: a first pass over the whole document, read against `tugdash-core/src/{resolve,ops}.rs`, `tugcast/src/feeds/{changeset,changeset_all,agent_supervisor,base_motion,workspace_registry}.rs`, `tugcast-core/src/types.rs`, and the tugdeck join surfaces (`join-mode-controller.ts`, `changeset-join-store.ts`, `changeset-verb-store.ts`, `session-changes-{view,dash-landing,dash-lane}.tsx`, `session-card.tsx`).
Applied: three correctness defects the draft would have shipped. **Candidate validity** — [P02]/Spec S01 tested the candidate's *parent* against the base head, which is true only for the squash shape; `replay_probe` returns the tip of an N-round replayed chain, so every multi-round replay candidate would have been called stale. Rewritten to ancestry (`merge-base --is-ancestor`), which is also exactly what `join_in`'s `merge --ff-only` already demands, so board and landing cannot disagree. **Cache key** — Spec S03 cached blockers by `(base_sha, dash_head_sha)`, but `join_preflight_in` derives them from working-tree dirt, the checked-out branch, and a journal file, none of which move a SHA; caching them would have manufactured the exact lying-face bug this plan exists to kill. Split the cache: probe cached, blockers recomputed every call and made cheap by composing from the `DashDetail` the same hop already holds. **Gate reason `pending`** — Step 6 deleted it along with the client preview, but `ChangesetVerbStore.join()` sets it for the *execute* round trip too, so removing it would have let a second press double-submit a landing; retained and retargeted to "Landing…". Also: recorded that `tugjoinsource` must be read *after* `resolve_conflicts`'s `commit_worktree_dirt` preamble, which moves the dash head as part of resolving and would otherwise mark every candidate stale at birth; added the persistence of per-path rungs (`tugjoinresolved`), since `ResolvedBy` cannot be recovered from git and its loss would quietly undo the 2026-08-15 review lesson; fixed sequencing so Steps 6–8 each adapt the app-tests they break rather than leaving the corpus red on `main` across four commits; added `session-changes-dash-lane.tsx` to Step 8's artifacts; named the golden fixture's real blast radius (one file, one Rust reader, six tugdeck importers); pinned the new test as `at0441` with at0426's stub-merge-driver technique so it never depends on the scribe; and added the #what-git-can-and-cannot-answer and #fronted-row-constraint deep dives.
Deferred: nothing. The one judgment call — what the row offers once a join is landable — was put to the owner during the round, who chose **no control at all**: the row states readiness and names its route, and the composer's ⬆ stays the single land control. [P07] and Table T01 were rewritten to that answer rather than left open.

---

### Phase Overview {#phase-overview}

#### Context {#context}

On 2026-08-18 a dash (`gallery-cleanup`) became unjoinable through the UI despite the resolution ladder succeeding **three times** and building three real candidate commits. Root cause, confirmed by reading the live release deck: `ChangesetJoinStore` — the client-side overlay holding the ladder's result — is keyed by raw path string, and it is written and gated with the card binding's spelling (`/Users/kocienda/Mounts/u/src/tugtool`, in `session-card.tsx`'s `dashLandingActions.resolve` and `join-mode-controller.ts`'s `derive()`) while the shade's view reads it with the feed's spelling (`/u/src/tugtool`, in `session-changes-view.tsx`). The land gate saw the candidate and refused on `unreviewed`; the only control that clears `unreviewed` (the **Reviewed** button) is rendered by the surface watching the dead key, so it never mounted. The refusal sentence — "Review what the ladder resolved first" — pointed at a ghost. This is a direct [L29] violation, and the structural condition behind it is worse than the one bug: the join arc's state is scattered across four client stores (`ChangesetVerbStore` join slot keyed by `entryKey`, `ChangesetJoinStore` keyed by `projectDir + dash`, `ChangesetDraftStore`, and the feed snapshot), stitched at render time by string equality, where every missed stitch renders as **nothing happened**.

The deeper defects this plan closes: the ladder's candidate exists only in a JS `Map`, so a reload, rebuild, or dropped socket abandons a commit that still exists in git (three were abandoned in one day); the preview that runs seconds after a resolve knows nothing about the candidate (`dash-join: completed … conflicts=1` five seconds after `ladder ran … candidate=76fa24e1`); and no invariant ties a gate refusal's sentence to a reachable affordance.

#### Strategy {#strategy}

- Move the join arc's truth to the server: a `join` block on `ChangesetEntry::Dash`, computed eagerly by a `JoinBoard` in tugcast (following `base_motion.rs`'s `ConflictBoard` pattern), delivered on the CHANGESET_ALL feed every card already subscribes to.
- Make the truth *verified*, not trusted: the candidate is a git ref (`refs/tug/join/<name>`) whose parents are checked against the current base head and dash head on every recompute; a stale candidate demotes itself with a sentence, never silently.
- Store the review acknowledgment server-side as a candidate SHA in branch config, so reviewing candidate A never blesses candidate B and a reload doesn't forget the review.
- Shrink the client: delete the durable halves of `ChangesetJoinStore` and the verb store's preview bookkeeping; what remains client-side is streaming resolve progress (ephemeral by nature) and the draft message (already `ChangesetDraftStore`'s job).
- Key every remaining client-side join address by `workspace_key` — the canonical spelling the feed already publishes — and sweep the pipeline for raw-path keying ([L29]).
- Rebuild the lane's landing face as a state machine renderer: one next-gesture control per state, no always-present JOIN button, and a checked table mapping every gate refusal to the mounted control that clears it.
- Bottom-up sequencing: tugdash-core git plumbing → tugcast board + wire → tugdeck types → controller/store rework → face rework → invariant tests.

#### Success Criteria (Measurable) {#success-criteria}

- A conflicted dash can be resolved, reviewed, and landed entirely through the Session card UI, with each stage's control visible at the moment its stage arrives (`at0441` walks the full arc against a real fixture repo).
- After a resolve completes, quitting and relaunching the app (or reloading the deck) shows the dash still in `resolved` state with its candidate, its per-file diffs, and the rung each came from — verified by `at0441`'s reload beat asserting the feed carries the join block after a fresh snapshot, with no CONTROL round trip.
- The base advancing past a resolved candidate flips the dash's face to a stale-candidate message naming the remedy — pinned by a tugcast unit test and the tugdash-core staleness test, for both the squash and multi-round replay shapes.
- Every `JoinLandGate` refusal reason maps to a `data-slot` that is mounted whenever that refusal is live (or, for a time-cleared reason, to a rendered sentence) — pinned by the reachability table check and `at0441`.
- No control on the dash row can be pressed into a refusal: in the landable state the row carries a readiness line naming its route and no button at all ([P07]), and `grep -n "session-changes-dash-join" tugdeck/src` returns nothing.
- No file in the dash/join pipeline keys or compares a raw `projectDir` — verified by the [L29] sweep step's grep checklist and by the two-spelling regression test.
- `cargo nextest run` green in `tugrust/`, `bun test` green in `tugdeck/`, `bunx vite build` clean, and the named app-test selection green.

#### Scope {#scope}

1. `tugdash-core`: candidate ref anchoring, parent verification, reviewed mark, teardown cleanup, and a pure eager join-facts function.
2. `tugcast`: the `JoinBoard`, the `join` block on the dash feed entry, the `changeset_join_review` CONTROL message, and resolve/land/discard integration.
3. `tugdeck`: wire-type mirror, `JoinModeController` reading the feed, `ChangesetJoinStore` reduced to streaming progress, landing-face rework, JOIN button removal.
4. [L29] sweep of client join addressing onto `workspace_key`.
5. Reachability invariant table and its tests; adaptation of the existing join app-tests.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Restoring an **in-flight** resolve's streaming progress across a reload — only terminal state survives (the feed's `resolved`/`error`); a reload during a run shows the run's terminal state when it lands in git.
- Any change to the `tugutil dash join` / `dash resolve` CLI surface beyond the ref/mark plumbing they inherit from tugdash-core.
- The fact-run overlap design decision (clip vs. wrap vs. thinning) — tabled separately; `fit="clip"` remains the floor.
- Widening the landing face beyond the fronted dash row. Per-dash feed state removes the data limitation that forced the constraint, but acting on it is a UI scope decision for a later plan (#fronted-row-constraint).
- Multi-candidate history or an undo window after landing — the landed commit is in git; post-hoc surgery is git's job (per the user's decision).
- Changes to commit mode (`CommitModeController`) beyond what the shared `LandingMode` seam forces.

#### Dependencies / Prerequisites {#dependencies}

- git ≥ 2.38 (`merge-tree --write-tree`) for eager conflict probes — already a hard requirement of the preview path (`tugrust/crates/tugdash-core/src/ops.rs`, `join --preview`).
- The CHANGESET_ALL recompute bump machinery (`feeds/changeset_all.rs`) and the GIT_HEAD signal channel (`feeds/git_watch.rs`) — both existing; this plan adds subscribers, not watchers.
- The golden fixtures `tugdeck/src/__tests__/fixtures/workspaces-changeset-snapshot.golden.json` and `changeset-snapshot.golden.json` guard the wire shape and must move in the same commit as the type. They are **one file each, read from both sides**: `tugrust/crates/tugcast-core/src/types.rs` reads the aggregate fixture through a relative path out of the crate, and six tugdeck tests import it (`changeset-types.test.ts`, `changes-route-controller.test.ts`, `dash-session-index.test.ts`, `dashes-section.test.ts`, `session-changes-dash-lane.test.ts`, plus the shade view's). Adding a `join` block to a dash entry in that fixture therefore touches all of them in one commit — expect the blast radius rather than discovering it.

#### Constraints {#constraints}

- **Warnings are errors** (`-D warnings` via `tugrust/.cargo/config.toml`).
- Wire changes must be additive (`#[serde(default, skip_serializing_if = …)]`) so an older deck against a newer tugcast (and vice versa during rollout) degrades to today's behavior rather than failing to parse.
- App-tests are selective (`@covers`), never a sweep; no piping of app-test output.
- No banned test shapes: no `happy-dom`/`jsdom` render tests, no `@testing-library/react`, no mock-store assertion tests. Client store tests drive the real store objects over a fake connection (the existing `changeset-join-store.test.ts` pattern); UI behavior is pinned by app-tests against the real app.
- tugdash-core is synchronous (git subprocesses); tugcast drives it via `spawn_blocking` — the JoinBoard's recompute must ride the existing `dash_entries` blocking hop, never add a second scheduling round trip per dash.

#### Assumptions {#assumptions}

- One `JoinBoard` per tugcast process is safe with multiple processes on one repo (release + app-test instances), because every fact it caches is derived from git state that all processes share; ref writes are atomic at the git layer.
- The per-file resolution diffs the ladder already computes (capped server-side, `ResolvedFile.diff` in today's `changeset_join_resolve_ok`) are small enough to ride the feed snapshot. Risk R02 tracks the fallback.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings, plan-local `[P##]` decisions, `S##` specs, `T##` tables, `R##` risks, and `**References:**`/`**Depends on:**` lines on every execution step, per `tuglaws/devise-skeleton.md`. Global laws are cited as `[L##]` / `[D##]` by reference to `tuglaws/tuglaws.md` and `tuglaws/design-decisions.md`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None. The three design questions raised during devise were put to the owner and decided before writing: previews are computed **eagerly** ([P04]), the review panel shows the candidate's **diff** ([P03], Spec S01's `resolved[].diff`), and landing **consumes the ref** ([P02]).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Eager merge-tree probes slow the changeset recompute | med | med | (base_sha, head_sha)-keyed cache; probe only on movement (Spec S03) | recompute log line exceeds ~150ms with dashes present |
| Resolution diffs bloat the feed frame | med | low | server-side per-file cap (reuse today's cap); R02 fallback | a snapshot frame exceeds ~256KB |
| Wire drift breaks older peers mid-rollout | high | low | additive serde fields; golden fixtures move with the type | golden fixture test failure |
| Two tugcast processes race on the candidate ref | low | low | `update-ref` is atomic; the board re-reads git each recompute, so a lost race self-corrects on the next bump | app-test instance flakes on join state |

**Risk R01: Eager probe cost on large repos** {#r01-eager-probe-cost}

- **Risk:** eager join facts per dash per recompute could make the 150ms-debounced changeset recompute noticeably slower — and the recompute fires on every attributed file write, not just on git movement.
- **Mitigation:** Two different mitigations for two different halves, because only one half is cacheable (Spec S03). The **conflict probe** is cached by `(base_sha, dash_head_sha)`, so an unchanged pair costs two `rev-parse` reads, and it is skipped entirely while blockers refuse the join. The **blockers** cannot be cached, so instead they are made cheap: composed from the `DashDetail` the same hop already computed, plus one repo-level current-branch read per recompute rather than one per dash. The probe already runs today on every lane expand (`aim()` fires a preview), so this moves an existing cost rather than adding a class of cost.
- **Residual risk:** The *first* recompute after a base or dash move pays the probe inline on the blocking hop, and the blocker composition is paid every recompute. Measure with the existing `aggregate changeset recomputed` debug line, which already reports `millis`; if it moves materially with dashes present, the next lever is debouncing the board behind git movement rather than behind the file-event bump.

**Risk R02: Feed payload growth from review diffs** {#r02-feed-diff-size}

- **Risk:** Carrying `resolved[].diff` in every snapshot frame (not just once on the resolve reply) multiplies the bytes by every recompute until the candidate lands.
- **Mitigation:** Keep the existing server-side per-file diff cap. If measurement shows frames growing past ~256KB, the fallback is an on-demand fetch (a `changeset_join_diff` request) while the feed carries only paths and counts — a follow-on, not a blocker, because the state machine's correctness never depends on the diff bytes.
- **Residual risk:** Diff-suppressed emission means an unchanged snapshot costs nothing on the wire; the growth only bites while a resolved candidate sits unlanded.

---

### Design Decisions {#design-decisions}

#### [P01] The dash feed entry is the join pipeline's single source of truth (DECIDED) {#p01-feed-is-truth}

**Decision:** A `join: Option<DashJoinState>` block on `ChangesetEntry::Dash` (Spec S01), computed server-side by tugcast's JoinBoard and delivered on CHANGESET_ALL, is the only durable join state any client reads. The client-side `ChangesetJoinStore`'s terminal fields (`resolved`, `unresolved`, `candidateCommit`, `shape`, `reviewed`) and the verb store's preview bookkeeping are deleted, not re-keyed.

**Rationale:**
- The 2026-08-18 deadlock was a client store read with two key spellings; deleting the durable client state makes the mismatch class unrepresentable, which is stronger than fixing the spellings ([L29]).
- The feed is already every card's one subscription; the dash entry is already the identity the lane, the controller, and the composer agree on (`owner_id`), so joining state to a dash needs no string stitching at all.
- The server already knows every fact (it logged the candidate SHA the client lost); publishing what it knows is cheaper than teaching four client stores to agree.

**Implications:**
- `deriveJoinOutcome` and `evaluateJoinLandGate` take their inputs from the feed entry; `JoinPhase`'s `preview`/`conflict` client phases collapse (the feed always has an answer).
- The `changeset_join {preview:true}` client-initiated preview is retired from the card path (the CLI keeps it); `JoinModeController.enter()`/`aim()` no longer fire previews.
- Two cards on one dash, a reloaded deck, and a relaunched app all read identical state by construction.

#### [P02] The candidate is a git ref, verified by parents, consumed on land (DECIDED) {#p02-candidate-ref}

**Decision:** `resolve_conflicts` anchors its candidate at `refs/tug/join/<name>` via `git update-ref`. The JoinBoard reports a candidate as valid only when the current base head is an **ancestor** of the candidate **and** the dash head recorded at build time still equals the current dash head (Spec S01); a mismatch reports `stale_note` and deletes the ref and its marks. `join_in` with a candidate deletes the ref after the fast-forward lands; `discard_in` and the join teardown delete it too.

**Rationale:**
- Three candidates were built and abandoned in one day because nothing durable held them; a ref survives process death and is visible to every tugcast process on the repo. `refs/tug/` is a fresh namespace (nothing in the tree uses it today), and a ref is a gc root, so the candidate cannot be collected while it stands.
- Ancestry, not parenthood, is the correct test, and the code says so twice. The **squash** shape builds `commit_tree(repo, &final_tree, &base_head, &msg)` — one parent, the base head. The **replay** shape returns `replay_probe`'s `replayed.head`, the tip of a chain of N replayed rounds whose parent is the previous round, not the base. A parent-equality rule would therefore call every multi-round replay candidate stale. Ancestry is also exactly what landing already requires: `join_in`'s candidate path runs `git merge --ff-only <candidate>` and reports "stale candidate: base advanced since the conflicts were resolved" when it fails.
- Verification makes the state self-invalidating — the stale-rerere lesson (the 2026-08-15 landing) enforced by construction instead of by a flag.
- Consuming the ref on land was decided by the owner: the result is in git if post-hoc surgery is wanted.

**Implications:**
- `resolve_conflicts` (both the tugcast path and the `tugutil dash resolve` CLI path — they share the core function) gains the ref write; no caller opts out.
- The recorded dash head must be read **after** the function's preamble, not before: `resolve_conflicts` opens with `commit_worktree_dirt(&worktree)?`, which commits the dash worktree's dirt and therefore *moves the dash head as part of resolving*. Recording the pre-preamble head would mark every candidate stale the instant it was built.
- Teardown code paths must delete `refs/tug/join/<name>` explicitly — branch config dies with `git branch -D`, loose refs do not.

#### [P03] Reviewed is a candidate SHA in branch config (DECIDED) {#p03-reviewed-sha}

**Decision:** The review acknowledgment is stored as `branch.tugdash/<name>.tugjoinreviewed = <candidate-sha>`, written server-side on a new `changeset_join_review` CONTROL message (Spec S02). The board reports `reviewed: true` only when the stored SHA equals the current valid candidate's SHA. The review panel shows the candidate's diff (owner-decided), which is `resolved[].diff` in Spec S01. The per-path **rung** each resolution came from is persisted beside the ref as a multi-valued `branch.tugdash/<name>.tugjoinresolved` key (one `<path>\t<rung>` value per resolved file), because it cannot be recovered from git (#what-git-can-and-cannot-answer).

**Rationale:**
- A boolean forgets *which* candidate was reviewed; a SHA pins the act to the artifact, so a re-resolve after base movement correctly demands a fresh review.
- Branch config is the established home for per-dash marks (`tugid`, `tugplan`, `tugautoreplay` — see `ops.rs` `plan_config_key` and `base_motion.rs`), and `git branch -D` at teardown sweeps the whole section for free.
- The rung is the *reason review exists*: `FileResolution::diff`'s own doc says every rung above the replay probe is "a machine decision the user never saw" — rerere replays a possibly-stale cache, the driver and the AI rung guess. A review panel that showed diffs but could not say "this one was the AI" would have dropped the signal it was built to carry.

**Implications:**
- `markReviewed` on the client becomes a CONTROL send, not a store mutation; the button's effect arrives back through the feed like every other fact.
- A reload cannot forget a review; a stale candidate cannot inherit one.
- The three `tugjoin*` config keys are written and cleared as one group with the ref, so a half-written set cannot outlive a candidate.

#### [P04] Join facts are computed eagerly, cached by SHA pair (DECIDED) {#p04-eager-join-facts}

**Decision:** The JoinBoard computes each dash's blockers and conflict set eagerly on every changeset recompute. **Blockers are computed fresh every time; only the conflict probe, archaeology, and candidate diffs are cached**, keyed by `(base_sha, dash_head_sha)` (Spec S03). There is no `unknown`/`not previewed yet` state on the wire.

**Rationale:**
- Owner-decided: the feed's join_state is always current; a dash entry never shows a stale or absent preview.
- The doctrine already exists in `base_motion.rs`: "a landing problem should surface when it becomes true, not when someone tries to land."
- The five-seconds-later preview that contradicted a fresh candidate (`conflicts=1` after `candidate=76fa24e1`) becomes impossible: one computation, one publisher.
- **Blockers are not a function of the two heads, so caching them by SHA pair would manufacture exactly the stale-face bug this plan exists to kill.** Read `join_preflight_in`: `stale-journal` comes from a journal *file*; `off-base` from `rev-parse --abbrev-ref HEAD`, i.e. which branch is checked out; `base-dirt` from `blocking_base_dirt`, which reads `dirty_tracked_paths` + `untracked_paths` in the **working tree**; and `empty` additionally consults the dash worktree's dirt. A user cleaning their base checkout, switching branches, or resuming a journal moves none of the SHAs — and a cached blocker set would keep refusing (or keep permitting) a landing whose real answer had already changed.

**Implications:**
- The lane's `offer`/`conflicted` face appears without any expand gesture; `aim()`'s preview side-effect is deleted.
- Conflict-probe cost is bounded by movement, not by render frequency; blocker cost is paid per recompute and must therefore be kept cheap by reusing what `dash_detail_entries_in` already computed (Spec S03, Risk R01).

#### [P05] Client join state shrinks to streaming progress plus the draft (DECIDED) {#p05-client-shrinks}

**Decision:** `ChangesetJoinStore` is reduced to an ephemeral progress overlay — `resolving` phase, per-file `FileProgress` from `changeset_join_resolve_delta` frames, the wire-drop failure, and the silence watchdog (`RESOLVE_IDLE_DEADLINE_MS`, 12s) — keyed by `(workspace_key, dash)`. Terminal truth (`resolved`, candidate, error) arrives via the feed; the store's terminal fields are deleted. The draft message stays in `ChangesetDraftStore` unchanged.

**Rationale:**
- Streaming progress is genuinely ephemeral (a reload during a run has nothing to restore — Non-goals) and high-frequency, so it belongs on CONTROL deltas, not in snapshot frames.
- A lost `_ok` frame today loses the result forever; under this design it costs only the spinner — the ref lands in git, the feed bumps, and the face flips to `resolved` anyway. The watchdog's error message becomes self-healing instead of a dead end.

**Implications:**
- `useChangesetJoinResolve` consumers read progress from the slim store and terminal state from the entry's `join` block.
- The store's `markReviewed`, `clear`, and terminal-state reducer paths are deleted; its tests shrink accordingly.

#### [P06] Every client join address routes through workspace_key (DECIDED) {#p06-workspace-key}

**Decision:** Every remaining client-side key, comparison, or CONTROL payload identity in the dash/join pipeline uses `changesController.workspaceKey` / the feed's `workspace_key` — never `projectDir`, which stays display-and-links-only per its own doc comment in `changes-route-controller.ts`. CONTROL payloads send the workspace key in the existing `project_dir` field (the server's `find_entry_by_path` canonicalizes any spelling, and the registry's key *is* a canonical absolute path), so no wire change is needed — but every client-side correlation (`verbKey`, in-flight maps, store keys) uses `workspaceKey` on both the send and the receive side.

**Rationale:**
- [L29] verbatim: every persisted or compared path routes through the canonicalization gateway. The registry's `workspace_key` is the gateway's product; `projectDir` is the raw binding path that caused the deadlock.
- Server echoes reflect what the client sent; sending the canonical spelling makes echo-correlation exact without touching the Rust parsers.

**Implications:**
- `changes-route-controller.ts` verb calls (`join`, `discard`, `claim`, `disclaim`, resolve, review) pass `workspaceKey`; `session-changes-view.tsx` reads `project.workspace_key` where it previously read `project.project_dir` for store keys.
- A regression test drives the store with two spellings of one directory and asserts a single state cell.

#### [P07] The lane renders one next-gesture per state; the JOIN button is removed (DECIDED) {#p07-no-join-button}

**Decision:** The landing face becomes a renderer of the feed's join state per **Table T01**: each state mounts exactly the control that advances it, and nothing else. The always-present `Join` button (`data-slot="session-changes-dash-join"`, which *enters a mode* while reading as an action) is deleted outright — not renamed, not relabelled. **In the landable state the row carries no control at all**: it states that the dash is ready and names where landing happens (owner-decided). Entering join mode keeps its two existing routes, both unchanged: `enterChanges` (⌃⌘C / the Session menu, which picks join mode when the card is bound to a dash — `session-card.tsx`) and the `/dash-join [name] [message…]` composer route.

**Rationale:**
- The owner's standing observation: "JOIN … doesn't seem like it's an operation we should even have." The button's label claimed a landing; its effect was mode entry — a resting lie whenever the join couldn't land.
- A readiness statement cannot lie the way a button can. There is no state in which the row offers a press that the gate then refuses, because the row offers no press on the landing path at all; the composer's ⬆ is the single land control, and it is the one place a refusal can be both computed and shown ([L31]).

**Implications:**
- `DashLandingActions.join` and `.preview` are both deleted (the first by this decision, the second by [P04] making it meaningless). `aim()` survives as pure targeting, with no preview side-effect.
- The readiness line must **name a route**, not merely assert readiness — "Ready to land — ⌃⌘C, or /dash-join" — because with no control on the row, the sentence is the only thing standing between the user and a dead end. This is [L31]'s obligation discharged by text rather than by a button, and Spec S04's table pins it.
- The disabled-button-with-tooltip pattern disappears from the lane entirely; every refusal renders as state text (Table T01's rightmost column).

#### [P08] Reachability invariant: every refusal names a mounted control (DECIDED) {#p08-reachability}

**Decision:** A checked table (Spec S04) maps every `JoinLandGate` refusal reason to the `data-slot` of the control that clears it, and to the state in which that slot mounts. A unit test asserts the table covers every reason in the gate's type; the full-arc app-test asserts, at each state, that the live refusal's mapped slot is present in the DOM.

**Rationale:**
- [L31] got refusals to *speak*; the 2026-08-18 deadlock proved a true sentence pointing at an unmounted control is still silence in the user's terms. The invariant closes that gap and converts the "silent failure" bug class into a shape tests reject.

**Implications:**
- Adding a gate reason without a table row is a compile-time/test-time failure, not a review nicety.

#### [P09] Resolve progress stays on CONTROL; terminal truth rides the feed (DECIDED) {#p09-progress-on-control}

**Decision:** `changeset_join_resolve_delta` frames are unchanged (per-file, per-rung, AI-rung accumulated text). `changeset_join_resolve_ok`/`_err` keep flowing for immediacy, but the client treats them as a fast-path hint only — the authoritative flip to `resolved`/`error` is the feed recompute the server fires after writing the ref (or failing). The 12s silence watchdog stays, and its error sentence changes to say the truth: the result will appear on the dash row when it lands, because it now does.

**Rationale:**
- CONTROL is `LagPolicy::Warn` — droppable by design. Building correctness on droppable frames was the original sin; building *liveness* on them while correctness rides the replayed snapshot feed uses each channel for what it is.

**Implications:**
- The resolve handler in `agent_supervisor.rs` fires the changeset bump after the ladder returns, win or lose.

---

### Deep Dives {#deep-dives}

#### The current pipeline, named {#current-pipeline}

Server: `agent_supervisor.rs` dispatches `changeset_join` → `do_changeset_join` (preview via `tugdash_core::join_in` with `preview: true`: `merge-tree --write-tree --name-only` + `join_preflight_in` blockers; execute lands or aborts) and `changeset_join_resolve` → `do_changeset_join_resolve` (runs `tugdash_core::resolve_conflicts` with the `ScribeFileMerger` AI rung from `feeds/join_resolve.rs`; replies `_ok {resolved, unresolved, candidate_commit, shape}` on CONTROL). The dash feed entry is composed in `feeds/changeset.rs::dash_entries` from `tugdash_core::dash_detail_entries_in`, plus `base_motion::conflict_paths_for` (the ConflictBoard precedent — a process-global `OnceLock<Arc<Mutex<…>>>` board the feed reads and an engine writes).

Client: `changeset-verb-store.ts` holds the join round trip keyed by `entryKey`, correlated by `verbKey(projectDir, dash)`; `changeset-join-store.ts` holds the ladder result keyed by `(projectDir, dash)`; `join-mode-controller.ts` derives outcome + gate from both plus the feed snapshot and the draft store; `session-changes-view.tsx` reads the resolve state with `project.project_dir` (the mismatch); `session-changes-dash-landing.tsx` renders faces from `deriveResolveFace` and mounts Resolve / Reviewed / Join / Discard; `session-card.tsx` wires `dashLandingActions` with `changesController.projectDir`.

#### Lifecycle of the new join state {#join-state-lifecycle}

```
                    base or dash head moves          resolve ladder succeeds
                    (git_watch bump)                 (ref written, bump fired)
  ┌─────────┐   ┌───────────┐   ┌────────────┐   ┌────────────┐   ┌────────┐
  │ blocked │◄──┤ previewed │──►│ conflicted │──►│  resolved   │──►│ landed │
  └─────────┘   │  (clean)  │   └────────────┘   │ ±reviewed  │   └────────┘
   blockers[]   └───────────┘    conflicts[]     │ candidate  │    ref deleted,
   from          no conflicts,                   └────────────┘    entry gone
   preflight     no blockers                      stale ⇒ note + demote to conflicted
```

The wire carries one struct (Spec S01) whose `phase` is derived, never stored: the board reads git (`rev-parse` the two heads, the ref, the config mark), consults the SHA-pair cache for the probe results, and assembles. `resolving` is deliberately **not** a wire phase — an in-flight ladder is client-local progress ([P09]); the feed shows the state the run started from until the run's terminal git effects land.

#### Why the deltas keep their shape {#deltas-keep-shape}

The AI rung streams accumulated text per file (`emit_delta` in `join_resolve.rs`); at scribe cadence that is far too chatty for a diff-suppressed snapshot feed. The delta path's only prior sin was that *terminal correctness* depended on it. With [P09], every delta consumer degrades gracefully: lost deltas cost progress fidelity, the watchdog covers total silence, and the feed delivers the ending regardless.

#### What git can and cannot answer about a candidate {#what-git-can-and-cannot-answer}

The board rebuilds the join state from git on every recompute, so exactly one question decides what has to be persisted alongside the ref: *can this fact be recomputed?*

**Recomputable, so never stored.** The conflict set (`merge-tree`), the archaeology (`git log` per path), the candidate's validity (ancestry against the base head), and the per-file diffs and counts — `resolution_report` already derives these from `(base_head, candidate, path)` via `resolution_diff`, so the board can recompute them identically. Storing them would create a second copy that could drift from the commit.

**Not recomputable, so persisted.** Two facts leave no trace in git:

- **Which rung resolved each path** (`ResolvedBy::Rerere | MergeFile | Driver | Ai`). The candidate commit records the resolved *bytes*, never the provenance of the decision. This is the fact the review panel exists to show, so it is persisted as `tugjoinresolved` ([P03]).
- **Which dash head the ladder ran against.** The candidate's own parentage cannot say it: the squash shape parents onto the base head, and the replay shape parents onto its previous round. Persisted as `tugjoinsource` ([P02]).

An implementer who skips this and tries to derive the rungs will find no way to do it, and the likely silent outcome is a review panel that shows diffs with no provenance — which is the 2026-08-15 lesson quietly undone.

#### One consequence worth naming: the fronted-row constraint loses its cause {#fronted-row-constraint}

Today the landing face belongs to the fronted row alone, and the reason is a data limitation, stated in `session-changes-dash-lane.tsx` and `session-changes-view.tsx`: `JoinState` is **one slot per card**, so two rows previewing would overwrite each other and "the loser would render the winner's blockers under its own name."

With join state arriving per dash on the feed, that collision is gone — every row could correctly show its own state. **This phase does not widen it**: the face stays on the fronted row, because widening it is a UI scope decision with its own design questions and this plan is already large. What changes is the *reason* for the constraint, and that must be written down where the code asserts it, or the next reader will preserve a limitation whose cause no longer exists. The landing **gesture** stays fronted regardless — it is a gesture on this card's own dash.

---

### Specification {#specification}

**Spec S01: `DashJoinState` wire shape** {#s01-dash-join-state}

New struct in `tugrust/crates/tugcast-core/src/types.rs`, carried as `join: Option<DashJoinState>` on `ChangesetEntry::Dash` with `#[serde(default, skip_serializing_if = "Option::is_none")]`; mirrored in `tugdeck/src/lib/changeset-types.ts` with a runtime guard alongside the existing entry guards.

```rust
pub struct DashJoinState {
    /// "blocked" | "previewed" | "conflicted" | "resolved". Derived, never stored.
    pub phase: String,
    /// join_preflight_in findings; non-empty ⇒ phase == "blocked".
    pub blockers: Vec<JoinBlocker>,          // reuse tugdash-core's shape via From
    /// merge-tree conflicted paths; non-empty (and no blockers, no candidate) ⇒ "conflicted".
    pub conflicts: Vec<String>,
    /// Per-path base history behind the conflicts (existing ConflictHistory, capped).
    pub archaeology: Vec<ConflictHistory>,
    /// Valid candidate: refs/tug/join/<name> exists AND base head is an
    /// ANCESTOR of it AND recorded dash head == current dash head.
    /// Present ⇒ phase == "resolved".
    pub candidate: Option<String>,
    /// Ladder result files for the review panel (path, resolved_by, capped diff, ±counts).
    pub resolved: Vec<ResolvedFileWire>,
    /// branch.tugdash/<name>.tugjoinreviewed == candidate.
    pub reviewed: bool,
    /// A candidate ref existed but failed verification: the sentence, e.g.
    /// "main moved since this was resolved — resolve again". The board deletes
    /// the stale ref and the config mark when it says this.
    pub stale_note: Option<String>,
}
```

**Candidate validity rule.** Two tests, both required:

1. `git merge-base --is-ancestor <base_head> <candidate>` succeeds. **Ancestry, not parenthood** — the squash shape builds `commit_tree(repo, tree, base_head, msg)` (one parent, the base head) but the replay shape returns `replay_probe`'s `replayed.head`, the tip of a chain of N replayed rounds whose parent is the previous round. A parent-equality test would call every multi-round replay candidate stale. Ancestry is also precisely what `join_in` already demands of a candidate — it lands with `git merge --ff-only` — so the board's verdict and the landing's verdict cannot disagree.
2. `branch.tugdash/<name>.tugjoinsource` equals the current dash branch head.

Either mismatch produces `stale_note` (naming which side moved) and deletion of the ref and all three `tugjoin*` marks.

**Where `resolved[]` comes from — half recomputed, half persisted** (#what-git-can-and-cannot-answer). `path`, `diff`, `added`, `removed` are recomputed by the board from `(base_head, candidate, path)` exactly as `resolve.rs::resolution_report` computes them via `resolution_diff`, so the feed's copy and the commit cannot drift; they ride the SHA-pair cache. `resolved_by` is **read from the persisted `tugjoinresolved` config** ([P03]) — nothing in the candidate commit records which rung decided a path. A path present in the diff but missing from the config renders with an unknown rung rather than being dropped: a resolution the user cannot attribute is still a resolution they must review.

**Spec S02: `changeset_join_review` CONTROL message** {#s02-review-message}

Request (client → tugcast, same envelope as `changeset_join_resolve`): `{"action": …handled by name…, "project_dir": <workspace key>, "dash": <name>, "candidate": <sha>}`. Handler: guard `find_entry_by_path` + git-worktree like `do_changeset_join_resolve`; verify `<sha>` equals the currently valid candidate (else reply `_err` with the stale sentence); write `branch.tugdash/<name>.tugjoinreviewed = <sha>`; fire the changeset bump; reply `changeset_join_review_ok {project_dir, dash, candidate}` / `_err {detail}`. The client treats the reply as a hint; the feed flip is the truth ([P09]).

**Spec S03: JoinBoard caching semantics** {#s03-join-board}

`tugrust/crates/tugcast/src/feeds/join_board.rs`, modeled on `base_motion.rs`'s `ConflictBoard`: a process-global `OnceLock` board holding `HashMap<owner_key, CachedProbe>` where `CachedProbe { base_sha, head_sha, conflicts, archaeology, resolved_diffs }`. `join_state_for(repo_root, &DashDetail, current_branch) -> DashJoinState` runs inside `dash_entries`' existing `spawn_blocking` hop.

**What is cached, and what is not, is the whole of this spec.**

- **Cached, keyed by `(base_sha, dash_head_sha)`:** the merge-tree conflict probe, the archaeology, and the candidate's per-file diffs. Each is a pure function of the two commits (plus the candidate, which cannot change without the pair changing), so a hit is sound and a miss costs one probe per actual movement.
- **Never cached — recomputed every call:** the blockers, and every ref/config read (`refs/tug/join/<name>`, the three `tugjoin*` marks). Blockers depend on working-tree dirt, on which branch is checked out, and on a journal file — none of which move a SHA ([P04]). Caching them by the pair is the one mistake that would reintroduce a lying face.

**Keeping the uncached half cheap.** Do not call `join_preflight_in` per dash per recompute; it re-derives facts `dash_detail_entries_in` has already computed in the same hop. Compose the blockers from the `DashDetail` the feed is holding — `base_ahead`, `base_overlap` (which *is* the tracked base-dirt intersection, per its own doc comment), `worktree_dirty`, `rounds`, and the journal phase — plus one **repo-level** `rev-parse --abbrev-ref HEAD` read once per recompute rather than once per dash, reusing the existing detail composers (`base_dirt_detail`, `off_base_detail`, `stale_journal_detail`, `empty_detail`) so the sentences stay identical to the CLI's. `join_preflight_in` remains the CLI's entry point and must be refactored to compose through the same function, so card and CLI cannot drift. The one input `DashDetail` lacks is the *untracked* half of the base-dirt intersection (`blocking_base_dirt(...).untracked`); add it to `DashDetail` rather than re-running the whole preflight.

**Skip the probe when the join is already refused.** When blockers are non-empty the state is `blocked` and Table T01 shows no conflict list, so the merge-tree probe is not run at all — the expensive half is skipped exactly when its answer would not be displayed. Clearing the blocker produces a cache miss on the next recompute and the probe runs then.

Entries for dashes that no longer exist are swept on each recompute.

**Spec S04: Refusal-reason reachability table** {#s04-reachability-table}

A `const` table exported from `join-mode-controller.ts` beside the gate, unit-checked for exhaustiveness over the gate's reason union:

| Gate reason | What clears it | Mounted / stated in state |
|---|---|---|
| `turn` | time — no control; the sentence names the wait | any |
| `pending` | time — a landing is in flight; the sentence names it | landing in flight |
| `outcome` + blocked | `session-changes-dash-landing-blockers` (each blocker's act) | blocked |
| `outcome` + conflicted | `session-changes-dash-resolve` | conflicted |
| `outcome` + stale candidate | `session-changes-dash-resolve` (the note is the sentence) | stale |
| `unreviewed` | `session-changes-dash-landing-reviewed` | resolved, unreviewed |
| `empty-message` | the composer editor (`tug-prompt-entry`) | landable, in join mode |

Two reasons are cleared by time rather than by a control, and both discharge [L31] by naming the wait: `turn` ("Wait for the turn to finish") and `pending`.

**`pending` stays, and its sentence changes.** It is tempting to delete it along with the client-side preview, since preview was what usually set it — but `ChangesetVerbStore.join()` sets `phase: "pending"` for the **execute** round trip too, and that is the case that matters: without this arm a second press during a landing double-submits it. Retarget the reason instead of removing it, and change `joinDisabledReason`'s text from `"Previewing…"` to `"Landing…"`, which is now the only thing it can mean.

The invariant is enforced two ways: a `satisfies Record<JoinLandGateReason, ReachabilityRow>` on the table, so a new gate reason without a row fails `tsc`; and the full-arc app-test asserting, at each refusing beat, that the named slot is in the DOM (or, for a time-cleared reason, that the sentence is rendered).

**Table T01: Landing face — one control per state** {#t01-face-states}

| Feed state | Face shows | The one control | Refusal text (inline, not tooltip) |
|---|---|---|---|
| blocked | each blocker's server detail + act | the act per blocker row (existing `blockerAct`) | — (the blockers are the text) |
| conflicted | conflicted paths + archaeology | `Resolve` (`session-changes-dash-resolve`) | — |
| resolving (client overlay) | spinner + per-file progress stream | none (watchdog error re-offers `Resolve again`) | watchdog sentence on silence |
| resolved, unreviewed | per-file diffs + rung per path (review panel) | `Reviewed` (`session-changes-dash-landing-reviewed`) | "Review what the ladder resolved first" |
| resolved+reviewed / clean | readiness line naming the route | **none** ([P07]) — "Ready to land — ⌃⌘C, or /dash-join" | "Write a join message" (in the composer, when empty) |
| landing in flight | outcome badge + "Landing…" | none | "Landing…" |
| stale candidate | `stale_note` sentence | `Resolve` | the note is the text |

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `DashJoinState` (feed) | structure | CHANGESET_ALL snapshot → existing changes-route store → `useSyncExternalStore` | [L02] |
| resolve progress overlay | structure | slim `ChangesetJoinStore` (CONTROL deltas) → `useSyncExternalStore` | [L02] |
| landing face state word | appearance | `data-outcome` / `data-join-phase` attributes + CSS | [L06] |
| review panel expand/collapse | local-data | `useState` in the landing component (exists today) | [L24] |
| join mode active/target | structure | `JoinModeController` store (exists) | [L02] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/feeds/join_board.rs` | Eager join-facts board + SHA-pair cache (Spec S03) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `candidate_ref_name`, `write_candidate_ref`, `read_candidate`, `delete_candidate_ref` | fn | `tugrust/crates/tugdash-core/src/resolve.rs` | `refs/tug/join/<name>` plumbing ([P02]); a fresh namespace — nothing in the tree uses `refs/tug/` today |
| `reviewed_config_key`, `join_source_config_key`, `join_resolved_config_key` | fn | `tugrust/crates/tugdash-core/src/resolve.rs` | `.tugjoinreviewed` / `.tugjoinsource` / `.tugjoinresolved` ([P02], [P03], S01) |
| `candidate_status` | fn | `tugrust/crates/tugdash-core/src/resolve.rs` | Valid(sha) / Stale(note) / None per S01's ancestry rule |
| `join_blockers_from_detail` | fn | `tugrust/crates/tugdash-core/src/ops.rs` | blockers composed from `DashDetail` + current branch, uncached (S03); `join_preflight_in` refactored to call it |
| `join_conflicts_in` | fn | `tugrust/crates/tugdash-core/src/ops.rs` | the cacheable half: merge-tree conflicts + archaeology ([P04], S03) |
| `DashDetail.base_overlap_untracked` | field | `tugrust/crates/tugdash-core/src/ops.rs` | the untracked half of `blocking_base_dirt`, so blockers compose without re-running the preflight (S03) |
| `resolve_conflicts` | fn (modify) | `tugrust/crates/tugdash-core/src/resolve.rs` | writes ref + source mark after building candidate |
| `join_in`, `discard_in`, teardown | fn (modify) | `tugrust/crates/tugdash-core/src/ops.rs` | delete candidate ref on land/discard ([P02]) |
| `DashJoinState`, `ResolvedFileWire` | struct | `tugrust/crates/tugcast-core/src/types.rs` | Spec S01; additive serde |
| `join_state_for` | fn | `tugrust/crates/tugcast/src/feeds/join_board.rs` | called from `dash_entries` |
| `dash_entries` | fn (modify) | `tugrust/crates/tugcast/src/feeds/changeset.rs` | attach `join` block |
| `do_changeset_join_review` | fn | `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` | Spec S02 handler + dispatch arm |
| `do_changeset_join_resolve` | fn (modify) | same | fire changeset bump after ladder returns ([P09]) |
| `DashJoinStateWire` + guard | type | `tugdeck/src/lib/changeset-types.ts` | mirror of S01 |
| `ChangesetJoinStore` | class (shrink) | `tugdeck/src/lib/changeset-join-store.ts` | progress-only, keyed `(workspaceKey, dash)` ([P05], [P06]) |
| `JoinModeController.derive` / `liveGateInput` / `deriveJoinOutcome` | fn (modify) | `tugdeck/src/lib/join-mode-controller.ts` | inputs from the feed entry ([P01]) |
| `REFUSAL_REACHABILITY` | const | `tugdeck/src/lib/join-mode-controller.ts` | Spec S04 table |
| `SessionChangesDashLanding` | component (rework) | `tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-landing.tsx` | Table T01 renderer; Join button removed ([P07]) |
| `DashLandingActions` | type (shrink) | same | `join` and `preview` deleted ([P07], [P04]); `resolve`, `markReviewed`, `resumeTeardown` remain |
| `DashLaneLanding` | type (modify) | `tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx` | carries the feed's join block instead of `JoinState` + `candidateCommit`; fronted-row doctrine comment updated (#fronted-row-constraint) |

---

### Documentation Plan {#documentation-plan}

- [ ] Update `tuglaws/design-decisions.md` candidates: propose (do not self-add) a global decision for "join truth is server-owned feed state" at review time — the plan itself records [P01]–[P09].
- [ ] Update the module docs touched by the rework (`changeset-join-store.ts` header, `join-mode-controller.ts` header, `join_resolve.rs` header) to describe the feed-authoritative flow — same commits as the code.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | ref/mark plumbing, staleness, board cache, handler replies | tugdash-core + tugcast, fixture repos via the existing test helpers |
| **Unit (TS)** | store keying, outcome/gate derivation from feed shapes, reachability exhaustiveness | real store objects over a fake connection (existing pattern) |
| **Golden / Contract** | the wire shape | the two changeset golden fixtures + type guards |
| **App-test** | the full arc and every face, against the real app | the join app-test family, selective |

#### What stays out of tests {#test-non-goals}

- No pixel measurements, no fake-DOM render tests, no mock-store assertion tests — banned shapes; face behavior is pinned by app-tests on the real app.
- The scribe AI rung's merge quality — exercised at the Rust layer already; this plan changes its plumbing, not its judgment.
- In-flight progress across reload — a non-goal by design.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Candidate ref + review mark plumbing in tugdash-core | pending | — |
| #step-2 | Join facts split by cacheability in tugdash-core | pending | — |
| #step-3 | JoinBoard + `join` block on the dash feed entry | pending | — |
| #step-4 | Resolve/review/land handlers speak feed truth | pending | — |
| #step-5 | Client wire mirror + fixtures | pending | — |
| #step-6 | Controller reads the feed; workspace_key keying | pending | — |
| #step-7 | Shrink the resolve store to progress-only | pending | — |
| #step-8 | Landing face rework — one control per state | pending | — |
| #step-9 | L29 sweep of the pipeline | pending | — |
| #step-10 | Reachability invariant + full-arc app-test | pending | — |
| #step-11 | Integration checkpoint | pending | — |

#### Step 1: Candidate ref + review mark plumbing in tugdash-core {#step-1}

**Commit:** `tugdash(join-truth): candidate anchors at refs/tug/join, review mark pins its sha`

**References:** [P02] candidate ref, [P03] reviewed sha, Spec S01, (#join-state-lifecycle)

**Artifacts:**
- `candidate_ref_name` / `write_candidate_ref` / `read_candidate` / `delete_candidate_ref`, the three `*_config_key` helpers, and `candidate_status` in `resolve.rs`.
- `resolve_conflicts` anchors the candidate on **every** outcome that carries one.
- `join_in` with `Some(candidate)`: after the ff-only merge succeeds, delete the ref (the config section dies with `git branch -D` in the teardown it already runs). `discard_in`: delete the ref before branch deletion.

**Tasks:**
- [ ] Implement the ref/config helpers; `update-ref` for write and `-d` for delete via the existing `git_output` helper. `tugjoinresolved` is multi-valued (`--add` per path, `--get-all` to read, `--unset-all` to clear).
- [ ] **Anchor at one site, not four.** `resolve_conflicts` has *four* `Ok(...)` exits — the replay-probe return, the clean-squash return, the unresolved-remainder return (candidate `None`), and the fully-resolved return. Do not sprinkle the write across them. Rename the existing body to a private inner function and let `resolve_conflicts` wrap it: on an outcome carrying `candidate_commit: Some(_)`, write the ref + `tugjoinsource` + `tugjoinresolved` and clear any prior `tugjoinreviewed`; on `None`, clear the ref and all three marks so a partial re-run cannot leave the previous candidate standing.
- [ ] Record `tugjoinsource` as the dash head read **after** the function's `commit_worktree_dirt(&worktree)?` preamble. That preamble commits the dash worktree's dirt and so moves the dash head as part of resolving; recording the pre-preamble head would mark every candidate stale the moment it was built ([P02]).
- [ ] `candidate_status(repo, name, base_branch)` per Spec S01: `git merge-base --is-ancestor <base_head> <candidate>` **plus** `tugjoinsource` equality — ancestry, never parent equality, because the replay shape's candidate is the tip of a replayed chain. Return a distinct stale sentence per mismatch side.
- [ ] Wire deletion into `join_in`'s candidate path and `discard_in`.

**Tests:**
- [ ] Ref exists and `candidate_status` is Valid immediately after `resolve_conflicts` on a conflicted fixture — asserted for **both shapes**: the squash shape, and the multi-round replay shape (the existing `replay_probe_resolves_base_already_advanced_and_lands_replay_shape` fixture already builds a two-round replay, and it is the case a parent-equality rule would wrongly reject).
- [ ] A dash with uncommitted worktree dirt resolves to a Valid candidate — the preamble-ordering pin.
- [ ] Base advances → Stale with the base-moved sentence; dash advances → Stale with the dash-moved sentence.
- [ ] A resolve that leaves files unresolved clears a previously written ref and marks.
- [ ] `tugjoinresolved` round-trips every resolved path's rung.
- [ ] `join_in` with the candidate deletes the ref; `discard_in` deletes it; existing `test_dash_join_lands_resolved_candidate` / `test_dash_join_stale_candidate_refused` still green.

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugrust && cargo nextest run -p tugdash-core`

---

#### Step 2: Join facts split by cacheability in tugdash-core {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash(join-truth): blockers compose from dash detail, conflicts probe separately`

**References:** [P04] eager facts, Spec S01, Spec S03, Risk R01, (#current-pipeline)

**Artifacts:**
- `join_blockers_from_detail(repo_root, &DashDetail, current_branch) -> Vec<JoinBlocker>` in `ops.rs`, composing the four blocker kinds from facts the detail walk already holds, via the existing detail composers (`stale_journal_detail`, `off_base_detail`, `base_dirt_detail`, `untracked_overwrite_detail`, `empty_detail`).
- `DashDetail.base_overlap_untracked`, populated by the same `blocking_base_dirt` call that already fills `base_overlap` — the one blocker input the detail was missing.
- `join_conflicts_in(repo_root, name) -> Result<JoinConflicts, String>`: the merge-tree probe + archaeology + the base/dash head SHAs, extracted from `join_in`'s preview arm.
- Capped candidate-diff extraction reusing `resolve.rs::resolution_diff`, so the board's diffs and the ladder's are one code path.

**Tasks:**
- [ ] Split by cacheability, not by convenience: blockers in one function (cheap, uncached), the probe in another (expensive, cached). Spec S03 explains why this split is the load-bearing one.
- [ ] Refactor `join_preflight_in` to compose through `join_blockers_from_detail` (it fetches its own `DashDetail` and current branch) so the CLI's blocker sentences and the card's are the same bytes by construction, not by parallel maintenance.
- [ ] Extract, don't duplicate: `join_in`'s `preview: true` arm calls `join_conflicts_in` and keeps its `JoinOutcome` envelope byte-identical (blockers/conflicts/archaeology ordering unchanged) so existing CLI output and app-tests don't move.

**Tests:**
- [ ] For each blocker kind (`stale-journal`, `off-base`, `base-dirt` tracked, `base-dirt` untracked, `empty`), a fixture asserting `join_blockers_from_detail` and `join_preflight_in` return the identical blocker list — the anti-drift pin between card and CLI.
- [ ] Blockers respond to changes that move **no** SHA: dirty the base checkout over a path the dash also changes → `base-dirt` appears with the same heads; clean it → it goes. This is the defect the SHA-pair cache would have hidden.
- [ ] `join_conflicts_in` on a conflicted fixture returns the same path list as `join_in --preview`, asserted by calling both.

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugrust && cargo nextest run -p tugdash-core`

---

#### Step 3: JoinBoard + `join` block on the dash feed entry {#step-3}

**Depends on:** #step-2

**Commit:** `tugcast(join-truth): dash feed entries carry server-owned join state`

**References:** [P01] feed is truth, [P04] eager facts, Spec S01, Spec S03, Risk R01, Risk R02, (#join-state-lifecycle)

**Artifacts:**
- `DashJoinState` / `ResolvedFileWire` in `tugcast-core/src/types.rs`, additive on `ChangesetEntry::Dash`.
- `feeds/join_board.rs` with `join_state_for` and the SHA-pair cache per Spec S03, following `base_motion.rs`'s `ConflictBoard` `OnceLock` shape.
- `dash_entries` in `feeds/changeset.rs` attaches `join: Some(join_state_for(...))` inside the existing `spawn_blocking` hop.
- Both golden fixtures updated with a `join` block on a dash entry.

**Tasks:**
- [ ] Implement the board per Spec S03's split: cache the probe by `(base_sha, dash_head_sha)`, recompute blockers and every ref/config read every call, and skip the probe entirely while blockers are non-empty. Sweep entries for dashes that vanished.
- [ ] Read the current branch **once per recompute** in `dash_entries` and pass it to each dash's `join_state_for`, rather than per dash.
- [ ] Derive `phase` per Spec S01; produce `stale_note` from `candidate_status` and delete the stale ref + all three marks when reporting it; read `resolved_by` from `tugjoinresolved` and recompute the diffs.
- [ ] Update the golden fixtures and every consumer named in #dependencies (one Rust reader, six tugdeck importers) in this commit.

**Tests:**
- [ ] tugcast unit test on a fixture repo: conflicted dash → `phase: "conflicted"` with paths; after `resolve_conflicts` → `phase: "resolved"` with candidate, per-file diffs, and the rung each came from; after base moves → `stale_note`, ref gone, marks gone on the next compose.
- [ ] Cache test, both halves: two composes with unmoved heads run the merge-tree probe **once**; two composes across a working-tree dirt change (no SHA movement) produce **different blockers** — the pin that the cache cannot mask a live refusal.
- [ ] A blocked dash composes without running the probe at all (counting seam), and clearing the blocker makes the conflicts appear on the next compose.
- [ ] Golden fixture round-trip green on both sides.

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugrust && cargo nextest run -p tugcast -p tugcast-core`

---

#### Step 4: Resolve/review/land handlers speak feed truth {#step-4}

**Depends on:** #step-3

**Commit:** `tugcast(join-truth): resolve bumps the feed, changeset_join_review lands the mark`

**References:** [P03] reviewed sha, [P09] progress on CONTROL, Spec S02, (#deltas-keep-shape)

**Artifacts:**
- `do_changeset_join_resolve` fires the changeset bump after the ladder returns (both arms), so the feed flips even when the `_ok`/`_err` CONTROL frame is lost.
- `changeset_join_review` parse + dispatch arm + `do_changeset_join_review` per Spec S02, writing `tugjoinreviewed` and bumping.
- `do_changeset_join` execute path already tears down the dash (entry disappears — that is the `landed` state); verify it fires the bump it already fires.

**Tasks:**
- [ ] Add the message following the `changeset_join_resolve` handler's structure (guards, err reply shape).
- [ ] Reject a review whose `candidate` is not the currently valid one, with the stale sentence.

**Tests:**
- [ ] Supervisor test (following `changeset_join_resolve_uses_scribe_and_reports_candidate` at `agent_supervisor.rs`): resolve → recomposed snapshot carries `resolved`; review with the right SHA → `reviewed: true` on the next snapshot; review with a wrong SHA → `_err` and no mark.
- [ ] Kill the CONTROL reply (drop the frame in the test harness) and assert the snapshot still flips — the [P09] liveness pin.

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugrust && cargo nextest run -p tugcast`

---

#### Step 5: Client wire mirror + fixtures {#step-5}

**Depends on:** #step-3

**Commit:** `tugdeck(join-truth): changeset types mirror the dash join block`

**References:** Spec S01, (#symbol-inventory)

**Artifacts:**
- `DashJoinStateWire` (+ `ResolvedFileWire`) and its runtime guard in `tugdeck/src/lib/changeset-types.ts`, optional field on `DashChangesetEntry`.
- `workspaces-changeset-snapshot.golden.json` / `changeset-snapshot.golden.json` carry the same fixture bytes Step 3 wrote (shared fixtures — confirm both repos read one file or copy in the same commit).

**Tasks:**
- [ ] Mirror field-for-field; absent block parses as `undefined` (older tugcast tolerated).

**Tests:**
- [ ] Existing changeset-types guard tests extended with a join-carrying dash entry and a join-less one.

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugdeck && bun test src/lib/__tests__/`

---

#### Step 6: Controller reads the feed; workspace_key keying {#step-6}

**Depends on:** #step-5

**Commit:** `tugdeck(join-truth): join mode derives from the feed entry, keyed by workspace_key`

**References:** [P01] feed is truth, [P06] workspace_key, Spec S04, (#current-pipeline)

**Artifacts:**
- `join-mode-controller.ts`: `derive()` and `liveGateInput()` read `candidateCommit`, `reviewed`, `blockers`, `conflicts`, `staleNote` from the fronted dash's feed entry (`this.entry()?.join`), not from the verb/join stores. `deriveJoinOutcome` takes the feed shape (`blocked`/`conflicted`/`resolved(+reviewed)`/`previewed` → `blocked`/`conflicted`/`clean`); the `pending`/`unknown`/`previewing` client phases and `enter()`/`aim()`'s `preview()` calls are deleted. `unreviewedResolution` = `join.candidate !== null && join.resolved.length > 0 && !join.reviewed` (same [P31]-derived rule, feed-sourced).
- The land send (`performJoin`) and every verb-store call site in `changes-route-controller.ts` pass `workspaceKey` as the `project_dir` payload value; `verbKey` correlation uses it symmetrically.
- The verb store's `JoinState` shrinks to the execute round trip (`idle`/`pending`/`done`/`conflict`/`error` — `preview` gone).

**Tasks:**
- [ ] Rework derivation + gate inputs. **Keep the `pending` reason** — it now means a landing execute is in flight, and dropping it would let a second press double-submit a landing (Spec S04); retarget its sentence from `"Previewing…"` to `"Landing…"`. The turn/pending/outcome/unreviewed/empty-message order is otherwise unchanged.
- [ ] Update `joinDisabledReason` for the stale-candidate note (the outcome text comes from `stale_note` when present).
- [ ] Sweep `changes-route-controller.ts` verb methods to send `workspaceKey`.
- [ ] Adapt the app-tests this step's behavior change breaks — the ones that assume a preview round trip fires on entry/expand: `at0417-join-mode`, `at0418-join-outcomes`, `at0425-dash-conflicted-landing`. Every commit leaves the corpus green; deferring these to #step-10 would leave the app-tests red on `main` across four commits.

**Tests:**
- [ ] `join-mode-controller.test.ts` rewritten to drive derive→gate from feed-entry shapes: blocked entry refuses `outcome`; conflicted refuses `outcome`; resolved-unreviewed refuses `unreviewed`; resolved-reviewed passes; stale note refuses with the note's sentence; a landing in flight refuses `pending` with "Landing…".
- [ ] Two-spelling regression: a feed entry under the canonical key and a controller bound with a different raw spelling still derive one state (the controller no longer touches path keys for join state at all — the test pins that by construction).
- [ ] `changeset-verb-store-join.test.ts` updated for the shrunk phase set and `workspaceKey` correlation.

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugdeck && bun test src/lib/__tests__/ && bunx tsc --noEmit`
- [ ] `cd /u/src/tugtool && just app-test tests/app-test/at0417-join-mode.test.ts tests/app-test/at0418-join-outcomes.test.ts tests/app-test/at0425-dash-conflicted-landing.test.ts`

---

#### Step 7: Shrink the resolve store to progress-only {#step-7}

**Depends on:** #step-6

**Commit:** `tugdeck(join-truth): resolve store carries progress only, review rides the wire`

**References:** [P05] client shrinks, [P09] progress on CONTROL, Spec S02, (#deltas-keep-shape)

**Artifacts:**
- `changeset-join-store.ts`: state = `{phase: "idle"|"resolving"|"error", progress, error}` keyed by `(workspaceKey, dash)`; `_ok`/`_err` handling reduced to clearing/erroring the progress phase (terminal facts ignored — the feed carries them); wire-drop fail and the 12s watchdog kept, watchdog sentence updated per [P09] ("…the result will appear on the dash row if the ladder finished").
- `markReviewed` becomes `review(workspaceKey, dash, candidate)` sending `changeset_join_review` (Spec S02).
- `session-changes-view.tsx` reads the store with `project.workspace_key`.

**Tasks:**
- [ ] Delete `resolved`/`unresolved`/`candidateCommit`/`shape`/`reviewed` fields and their reducer arms; delete `clear()`'s post-land role (the entry disappears with the dash).
- [ ] Keep the delta-driven deadline re-arm exactly as shipped in `034100bc3`.
- [ ] Adapt `at0426-dash-resolution-review`, whose review panel now reads the feed rather than the store; it stays the review gate's test and must remain green in this commit.

**Tests:**
- [ ] `changeset-join-store.test.ts` rewritten for the slim shape: delta stream → progress rows; silence → watchdog error; wire drop → error; `_ok` → back to idle.
- [ ] A `changeset_join_review` send test over the fake connection asserting payload shape.

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugdeck && bun test src/lib/__tests__/changeset-join-store.test.ts && bunx tsc --noEmit`
- [ ] `cd /u/src/tugtool && just app-test tests/app-test/at0426-dash-resolution-review.test.ts`

---

#### Step 8: Landing face rework — one control per state {#step-8}

**Depends on:** #step-7

**Commit:** `tugdeck(join-truth): landing face renders the feed state, JOIN button retired`

**References:** [P07] no join button, Table T01, Spec S01, (#t01-face-states)

**Artifacts:**
- `session-changes-dash-landing.tsx` rebuilt as the Table T01 renderer: `deriveResolveFace` replaced by a direct read of `entry.join` + the progress overlay; the always-mounted `Join` button (`data-slot="session-changes-dash-join"`) deleted; the landable state renders a **readiness line naming its route** and no control ([P07]); the review panel (per-file diffs via `TugDiffDocument`, each path's rung, the `Reviewed` button) mounts from `entry.join.resolved` in the resolved-unreviewed state; `stale_note` renders as the state text with `Resolve` beside it.
- `DashLandingActions` shrinks: `join` and `preview` both deleted, across the panel, `session-changes-view.tsx`, and `session-card.tsx`.
- `session-changes-dash-lane.tsx`: `DashLaneLanding` carries the feed's join block in place of `JoinState` + `candidateCommit`, and its fronted-row doctrine comment is corrected — the constraint survives as a scope choice, not as a data limitation (#fronted-row-constraint).
- State words paint via `data-` attributes + CSS ([L06]); no new React state beyond the existing local expand/collapse.

**Tasks:**
- [ ] Rework the component against Table T01; keep Discard and Resume-teardown placement unchanged.
- [ ] Verify against tuglaws before writing: [L02] props from store reads, [L06] appearance via CSS, [L19] Tug components only, [L31] the readiness line names a route — name the laws in the commit body.
- [ ] Adapt the app-tests whose assertions name the removed button or the moved faces: `at0418-join-outcomes`, `at0425-dash-conflicted-landing`, `at0426-dash-resolution-review`, `at0435-landing-refusal-speaks`, `at0436-join-land-press`, `at0340-composer-routes`. This is the step that changes what is on screen, so it is the step that owns their update.

**Tests:**
- [ ] `join-resolve-face.test.ts` rewritten as a pure table test over `(join block, progress phase) → mounted control set` (the derivation extracted as a pure function so it tests without a DOM).
- [ ] The adapted app-tests above, green.

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugdeck && bun test && bunx vite build`
- [ ] `cd /u/src/tugtool && just app-test tests/app-test/at0418-join-outcomes.test.ts tests/app-test/at0425-dash-conflicted-landing.test.ts tests/app-test/at0426-dash-resolution-review.test.ts tests/app-test/at0435-landing-refusal-speaks.test.ts tests/app-test/at0436-join-land-press.test.ts tests/app-test/at0340-composer-routes.test.ts`

---

#### Step 9: L29 sweep of the pipeline {#step-9}

**Depends on:** #step-6

**Commit:** `tugdeck(join-truth): dash pipeline addresses route through workspace_key only`

**References:** [P06] workspace_key, (#current-pipeline)

**Artifacts:**
- Every remaining `projectDir`-as-key/comparison in the dash/join pipeline moved to `workspaceKey`: the discard/claim/disclaim sends in `session-changes-view.tsx` and `changes-route-controller.ts`, any `_inflight` correlation maps in `changeset-verb-store.ts`, and the `ScribeFileMerger`/resolve-delta echo consumers. `projectDir` remains only where the doc comment permits it: display strings and file-link composition.
- A grep checklist recorded in the commit body: `grep -rn "projectDir" tugdeck/src/lib/changeset-* tugdeck/src/lib/join-mode-controller.ts tugdeck/src/components/tugways/cards/session-changes/` with every survivor justified as display/links.

**Tasks:**
- [ ] Sweep and fix; do not add canonicalize-both-sides shims — the key changes at the source, per the no-path-tolerance rule.

**Tests:**
- [ ] Existing verb-store tests updated where correlation keys changed; the Step 6 two-spelling regression covers the class.

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugdeck && bun test && bunx tsc --noEmit`

---

#### Step 10: Reachability invariant + full-arc app-test {#step-10}

**Depends on:** #step-8, #step-9, #step-4

**Commit:** `tugdeck(join-truth): every refusal names a mounted control, pinned end to end`

**References:** [P08] reachability, Spec S04, Table T01, (#success-criteria)

**Artifacts:**
- `REFUSAL_REACHABILITY` table in `join-mode-controller.ts` + exhaustiveness check (`satisfies Record<JoinLandGateReason, ReachabilityRow>`, so a new reason without a row fails `tsc`).
- New app-test `tests/app-test/at0441-join-arc-end-to-end.test.ts` (at0440 is the current highest; `@covers` the join pipeline files including the new Rust ones) driving the full arc on a fixture-conflicted dash: conflicted face shows Resolve → press → progress visible → resolved face shows the diff panel with each path's rung + Reviewed → press → the readiness line appears with no button → enter join mode by its named route, type, ⬆ → landed (entry gone). At each refusing beat, assert Spec S04's mapped slot is mounted, or for a time-cleared reason that its sentence is rendered.
- The persistence beat inside the same test: after Resolve, reload the deck (the harness's reload gesture) and assert the resolved face is still up *before* reviewing — the criterion three abandoned candidates paid for.

**Tasks:**
- [ ] Build the conflict deterministically the way `at0426-dash-resolution-review` already does — rewind the dash branch to the parent of a base commit that modified a file, rewrite that file wholesale in the dash worktree, and register a stub merge driver (`tugdash.mergedriver`, rung 4) so the ladder reaches a candidate without the AI rung or this repo's `rr-cache`. Do not let the new test depend on the scribe.
- [ ] Never fire a real join against the developer's `main`. at0426's rule holds: the fixture dash is the only thing that may land, and the test tears it down.
- [ ] Run the selection by name, bare, no pipes.

**Tests:**
- [ ] The new full-arc test, green, including the reload beat.
- [ ] The reachability exhaustiveness check fails when a reason is added without a row (verify by adding one locally with `tugutil file probe`, then reverting).

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugdeck && bunx tsc --noEmit && bun test`
- [ ] `cd /u/src/tugtool && just app-test tests/app-test/at0441-join-arc-end-to-end.test.ts tests/app-test/at0417-join-mode.test.ts tests/app-test/at0426-dash-resolution-review.test.ts tests/app-test/at0435-landing-refusal-speaks.test.ts`

---

#### Step 11: Integration Checkpoint {#step-11}

**Depends on:** #step-10

**Commit:** `N/A (verification only)`

**References:** [P01]–[P09], (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Verify the whole pipeline builds and the derived selection is green; rebuild the app so the live instance carries the change (`just build-app` — the app-test harness never rebuilds the binary).

**Tests:**
- [ ] `cd /u/src/tugtool/tugrust && cargo nextest run`
- [ ] `cd /u/src/tugtool/tugdeck && bun test && bunx vite build`

**Checkpoint:**
- [ ] `cd /u/src/tugtool && just app-test-changed` (or the named selection if the budget refuses)

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A dash join pipeline whose entire durable state lives in one server-owned `join` block on the dash's feed entry — candidate anchored and verified in git, review pinned to a SHA, every face and gate derived from that one truth, every refusal pointing at a control that is on screen, and no raw-path key anywhere in the arc.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] The poster child lands: a conflicted dash resolves, reviews, and lands through the Session card with no CLI intervention (`at0441`).
- [ ] A resolve survives a deck reload and an app relaunch (persistence beat in `at0441`; ref visible in `git for-each-ref refs/tug/join`).
- [ ] `ChangesetJoinStore` holds no terminal state; `grep -n "candidateCommit\|reviewed" tugdeck/src/lib/changeset-join-store.ts` returns nothing.
- [ ] The reachability table is exhaustive over the gate's reasons (`tsc` + unit check), and `pending` is still among them.
- [ ] The [L29] grep checklist in Step 9's commit body shows zero unjustified `projectDir` keys in the pipeline.
- [ ] Every commit in the sequence left the app-test corpus green — no step deferred a breakage it caused.

**Acceptance tests:**
- [ ] `at0441-join-arc-end-to-end`.
- [ ] The Step 4 lost-CONTROL-frame liveness test.
- [ ] The Step 2 no-SHA-movement blocker test (base dirt appears and clears with both heads unchanged).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] On-demand diff fetch if Risk R02's frame-size trigger fires.
- [ ] A global design-decisions entry canonizing server-owned join truth, at the owner's discretion.
- [ ] The fact-run overlap design decision (tabled separately).

| Checkpoint | Verification |
|------------|--------------|
| Rust workspace green | `cd /u/src/tugtool/tugrust && cargo nextest run` |
| Deck green + bundle builds | `cd /u/src/tugtool/tugdeck && bun test && bunx vite build` |
| Join surfaces green in the real app | the Step 10 named selection |
