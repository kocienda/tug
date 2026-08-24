<!-- tugplan-format: v1 -->

## Dash Entry Points {#dash-entry-points}

**Purpose:** Every surface that shows a dash should let you act on one — by routing to the room where the act already lives, never by growing a new one. The Lens Dashes row gains a click-through to its worker card's Changes shade, both dash-row surfaces gain a replay verb for any diverged dash — one that speaks its outcome even when it moves nothing — and the Lens row's verbs adopt the shade's one menu grammar. Creation stays a composer act; the masthead stays a face.

### Plan Metadata {#plan-metadata}

- **Owner:** Ken Kocienda
- **Status:** Draft
- **Created:** 2026-08-22
- **Last updated:** 2026-08-22
- **Target branch:** `tugdash/dash-entry-points` (dash worktree)
- **Primary areas:** `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs`, `tugdeck/src/lib/changeset-verb-store.ts`, `tugdeck/src/components/tugways/cards/session-changes/dash-row-menu.tsx`, `tugdeck/src/components/lens/sections/dashes-section.tsx`, `tugdeck/src/components/tugways/cards/session-card.tsx`

### Review Record {#review-record}

**Round 1 — 2026-08-22, opus.** Reviewed `plan:a9024e9e090da6da`. Lint: 0 errors, 0 warnings.
Oriented on: the whole document (first review), read against `base_motion.rs`, `join_pilot.rs`, `changeset.rs`, `session_ledger.rs`, `tugdash-core/src/replay.rs`, `agent_supervisor.rs`, `responder-chain.ts`, `card-host.tsx`, `session-card.tsx`, `cards-section.tsx`, `dashes-section.tsx`, `dash-row-menu.tsx`, `dash-bind-error-notice-controller.tsx`, `changeset-verb-store.ts`, `dash-fixture.ts`, and the at0407 / at0438 / at0445 app-tests.
Applied: **[P03]'s premise was factually wrong** — `decide_for_dash` (`base_motion.rs`) gates auto-replay on the two autoreplay flags, in-flight, `base_ahead == 0`, the join journal and **worktree dirt**, and never on boundness; `bound_sessions` is read in `evaluate_workspace` only to decide *who to notify*. The unbound-only predicate would therefore have shown a dead button on unbound dirty dashes (`replay_onto` returns `Deferred{dirty-worktree}` for those) while hiding the verb from bound diverged dashes with autoreplay off, the one population with no other recourse. Asked, and the user chose the divergence-based predicate; [P03] rewritten, R01 and the Non-goal re-grounded. **Spec S02's dispatch target could not have worked** — `sendToTarget` walks `parentId` *up* from its target (responder-chain.ts invariant I3), the bare `cardId` responder is `card-host.tsx`'s and answers only `SET_PROPERTY`, and the session card's handlers live on the `${cardId}-card-content` scope *beneath* it; retargeted onto the established per-card command scope. **A replay that moves nothing had no voice** — `Current`, `Deferred` and `Conflicted` all leave the row's facts identical, which is the dead-button failure class this arc has already paid for; asked, and the user chose the pane-bulletin precedent, now [P06]. Also: Spec S01 no longer hand-rolls an outcome word (`ReplayOutcome` already derives `Serialize` with `#[serde(tag = "outcome", rename_all = "snake_case")]`) and now carries the `Deferred` reason/detail the bulletin needs; the store sender was reshaped to the discard's real house signature (`entryKey` first, `project_dir: workspaceKey`, no separate `projectDir`); Step 3 gained the `REQUEST_REPLAY_DASH` action the menu item cannot dispatch without, the at0407 / at0438 updates its button removal forces, and an app-test in its own checkpoint rather than discovering the breakage two steps later; [P02] gained the inert-row affordance rule so a row that cannot be activated never looks like it can.
Deferred: nothing — both design forks were asked and settled during this round.

**Round 2 — 2026-08-22, opus.** Reviewed `plan:3d13b36e209025a1`. Lint: 0 errors, 0 warnings.
Oriented on: round 1's own edits, re-read whole after stamping.
Applied: two places still carried the premises round 1 corrected elsewhere, and a plan whose Strategy contradicts its Specification is worse than one that never mentioned the point. Context said the missing trigger was for "a dash the machine is not tending" and framed the population as unbound; it now states `decide_for_dash`'s real gates and names the three populations that actually go untouched (autoreplay off, dirty worktree, already-conflicted), while keeping the closure brief's original wording as a quotation and flagging that [P03] deliberately widens past it. Strategy still named `chain.sendToTarget(cardId, …)` — the exact target round 1 proved unreachable — and now names the card-content scope with a pointer to the deep dive; it also picks up [P06]'s precedent, which round 1 added to the decisions but never to the strategy paragraph that motivates the step order.
Deferred: nothing.

### Phase Overview {#phase-overview}

#### Context {#context}

The unified Changes pass landed (`51bb1eaae`, [D152]): the Changes shade is the join arc's one decision surface, revealed quiet-moment-gated on the bound card, with an accent dot on the Z4A Changes segment holding the signal while the room is closed. There is no join dialog, and this plan must not reinvent one.

Three surfaces show dashes today, and what each already offers was read from the code on 2026-08-22:

- **The Changes shade's dash lanes** (`session-changes-dash-lane.tsx`): every dash in the project is a row; the fronted row carries the join face and lands-as fold; every row carries a `⋯` menu (`dash-row-menu.tsx`) holding Bind/Unbind and Discard, with disabled items carrying their reason in the label ([L31]).
- **The Lens Dashes section** (`dashes-section.tsx`): always-on, every dash in every open project; unbound rows carry standing Bind and Discard text buttons in the eyebrow (Bind targets the Lens's followed card via `resolveBindTarget`); bound rows carry the worker atom and no verbs; rows have **no activation act** — clicking a row does nothing.
- **The session masthead / title grammar** (`session-identity-row.tsx`): the bound dash rides the title's own grammar — step ring, progress cluster — display only.

So bind/unbind and discard are solved. What no surface offers: a way *from a dash row* to the room where the join decision lives; any manual trigger for `dash replay` (the closure brief's deferred lane-click item — `dash/archive/dash-closure-brief.md` names it *"a lane click affordance for `dash replay` on a deferred/conflicted dash with no bound session"*, though [P03] widens the population past the brief's "no bound session" framing, for reasons the code settles); and a ruling on what a click on a dash row means anywhere ([D142]: status is never a control).

The wire today carries `bind_dash` / `unbind_dash` / `changeset_discard` — there is **no** replay verb and **no** create verb. The base-motion engine (`tugcast/src/feeds/base_motion.rs`) auto-replays dashes when the base moves, gated by `decide_for_dash` on the two autoreplay flags, an in-flight replay, `base_ahead == 0`, the join journal, and worktree dirt — **not** on boundness ([P03]). So the dash that falls behind and stays behind is any dash those gates skip: autoreplay off, a dirty worktree, or a replay that already stopped conflicted. Its divergence facts sit on every row (`base_ahead`, `replay_conflict_paths` on `DashChangesetEntry`) with no gesture anywhere to act on them.

The four design forks were asked and settled with the user on 2026-08-22, during devise:

1. A Lens row on a joinable bound dash: **click-through to the shade** — activation fronts the worker card and reveals its Changes shade.
2. Starting a dash: **composer act only** — no create affordance on any display surface.
3. The replay trigger: **a `⋯` menu item** on both shade lanes and Lens rows, backed by a new `changeset_replay` control frame.
4. The masthead dash cluster: **display-only** — it gains no act.

#### Strategy {#strategy}

Wire verb first, then the store, then the two surface grammars, then the pin. The replay verb is modeled line-for-line on `do_changeset_discard` (same guards, same `_ok`/`_err` broadcast shape, same aggregate bump), because that handler is the house pattern for a dash verb the card fires; its outcome's voice is modeled just as closely on `dashBindErrorStore` + `DashBindErrorNoticeController` ([P06]), the shipping answer to "a dash verb pressed elsewhere refused". The click-through composes three mechanisms that already exist — `dispatchCommand("focus-session-card", …)` (how a Lens Cards row fronts a card), `chain.sendToTarget(`${cardId}-card-content`, …)` (how a surface aims a typed action at a specific card's command scope — the card-content scope, *not* the bare card id; see [#click-through-mechanisms]), and the card-local `shadeViewController.show("changes")` ([D152]'s one reveal path) — so no new reveal machinery is built. The Lens row's verbs move behind the shade's existing `⋯` menu module rather than growing a third grammar.

#### Success Criteria (Measurable) {#success-criteria}

- Activating a Lens Dashes row whose dash has a worker card open in this instance fronts that card and reveals its Changes shade; a row with no open worker card does nothing **and does not present as activatable**. Pinned by an app-test.
- A diverged dash — bound or not — offers **Replay onto \<base\>** behind its `⋯` on both the shade lane and the Lens row; pressing it runs the replay server-side and the row's divergence facts settle on the next aggregate recompute. Pinned by an app-test.
- A non-diverged or dirty-worktree dash shows the replay item disabled with its reason in the label, never absent-vs-present flicker ([L31]).
- **No press is ever silent.** A replay returning `current`, `deferred`, or `conflicted` — none of which move the row's facts — posts its reason to the target card's pane bulletin. Pinned by an app-test over the dirty-worktree case.
- The Lens row's Bind and Discard live behind the same `⋯` the shade uses; the standing text buttons are gone; `resolveBindTarget`'s refusal sentences survive as disabled-item reasons.
- No new transient surface exists; `rg "join-dialog|JoinDialog"` stays empty; the quiet-moment auto-reveal in `session-card.tsx` is byte-unchanged except for the shared handler it gains.
- `cd tugrust && cargo nextest run` green; `cd tugdeck && bunx tsc --noEmit && bunx vite build` clean; `bun test` green; selected app-tests green.

#### Scope {#scope}

- `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` — the `changeset_replay` CONTROL verb.
- `tugdeck/src/lib/changeset-verb-store.ts` — the replay send + receipt fold.
- `tugdeck/src/components/tugways/cards/session-changes/dash-row-menu.tsx` — a third verb slot.
- `tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx` — offering it.
- `tugdeck/src/components/lens/sections/dashes-section.tsx` — menu adoption + activation delegate.
- `tugdeck/src/components/tugways/action-vocabulary.ts` — `REVEAL_CHANGES` and `REQUEST_REPLAY_DASH`.
- `tugdeck/src/components/tugways/cards/session-card.tsx` — the reveal handler on the card-content scope, and the notice controller's mount.
- `tugdeck/src/lib/dash-replay-outcome-store.ts` and `cards/dash-replay-notice-controller.tsx` — new, the outcome's voice ([P06], Spec S04).
- `tests/app-test/` — one new test file, plus the at0407 / at0438 updates Step 3's button removal forces.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **No creation UI anywhere.** Starting a dash stays with the skills and the composer; no `dash_create` wire verb, no form, no section-header affordance. (A first-class create composer route was raised and declined for this round.)
- **No masthead acts.** The title grammar's dash cluster stays pure status.
- **No join dialog, sheet, or prompt** — [D152] deleted that shape; nothing here recreates it.
- **No unbind on the Lens.** Unbind stays the fronted shade row's verb; the click-through *routes* you there.
- **No client-side prediction of the auto-replay engine.** Neither autoreplay flag is on the wire and neither is put there. The verb is offered on divergence and the server's outcome speaks ([P03], [P06]) — a client that tried to guess whether the engine was about to act would be re-implementing `decide_for_dash` behind glass, which is the four-places-copied-the-gate mistake [D147] names.
- **No changes to the quiet-moment gate or the once-per-head memory** beyond stamping the set from the explicit path.

#### Dependencies / Prerequisites {#dependencies}

- `dash/unified-changes.md` landed as `51bb1eaae` ([D152]) — verified in `git log` on 2026-08-22.
- [D147]'s derivation (`join_ready`, pilot bound-only) and [D149]'s replay compare-and-swap, both live.

#### Constraints {#constraints}

- Only the user lands; `tugutil dash join <name> --resolve` **lands** and is never a probe. Nothing here fires a join.
- [D142]: status is never a control. Activation is navigation; verbs live behind the `⋯` or in Z5.
- [L02] external state through `useSyncExternalStore`; [L06] appearance via CSS/DOM; [L11] controls emit typed actions; [L19]/[L20] compose `Tug*` components; [L22] menu open points stay view-local; [L31] a refusal must be readable.
- Warnings are errors; never commit red.

#### Assumptions {#assumptions}

- `tugdash_core::replay_onto(repo_root, name)` (`tugdash-core/src/replay.rs`) is safe to call from a `spawn_blocking` in tugcast, as `discard_in` is — its `ReplayOutcome` enum (`Current` / `Replayed` / `Recorded` / `Deferred` / `Conflicted`) is the outcome vocabulary the wire word reuses.
- `tokio::task::spawn_blocking` is the right hop for `replay_onto` — it is synchronous git throughout, and `evaluate_workspace` already calls the same library that way.

Two assumptions the first draft made were **checked and found false**, and are recorded here so they are not re-made: that a session card answers actions sent to its bare `cardId` (it does not — `card-host.tsx` owns that id and answers only `SET_PROPERTY`), and that an unbound dash is one the machine is not tending (boundness has no part in `decide_for_dash`). Both are corrected in [#click-through-mechanisms] and [P03].

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None open. The four design forks (join entry form, creation's home, replay's form, the masthead) were asked and settled with the user on 2026-08-22 during devise; they land as [P01]–[P05].

### Risks and Mitigations {#risks}

- **R01 — A manual replay races the base-motion engine or a second instance.** The engine polls every open workspace and is not scoped by boundness, so this race is ordinary rather than exotic. Mitigation: `replay_onto` is a compare-and-swap — the worktree must still be clean and its HEAD must still be the tip the replay was computed from, or nothing happens and the outcome says why. The loser reports `Deferred` or `Current`, both of which [P06] speaks, so a lost race is legible rather than silent. No lock is added: the CAS is the existing contract and `tugutil dash replay` already relies on it.
- **R02 — `sendToTarget` reaches nothing and the click dies silently.** Two ways: the card unmounted a frame after the row was built, or the target id is wrong. Mitigation: guard with `chain.hasResponder(`${cardId}-card-content`)` exactly as `cards-section.tsx`'s `onClose` guards its own send; and the target spelling is pinned by the app-test rather than by inspection, because an upward-walking dispatch that finds no handler fails **silently** — there is no error to observe, which is why this defect survived the plan's first draft.
- **R03 — Regrouping the Lens verbs behind `⋯` regresses Bind's discoverability.** The standing buttons were deliberate. Mitigation: the shade's own doctrine (rare verbs behind `⋯`, rows exist to be read) already argued this for the identical row; the refusal sentences survive verbatim as disabled reasons; the change is one commit and trivially revertible if review disagrees.
- **R04 — The explicit reveal and the passive reveal double-fire.** Mitigation: one handler owns the reveal on the card side and stamps `revealedOffersRef` with the standing offer's `dash_head` on either path ([P02]), so whichever fires first spends the head.

### Design Decisions {#design-decisions}

#### [P01] Entry points route; they never originate and never land (DECIDED) {#p01-route-never-originate}

A display surface's act is to take you to the room where the act already lives — the shade for the decision, the composer for intent. Creation therefore stays a composer/skill act with no display affordance, the masthead stays display-only, and no affordance in this plan fires a join or a landing. Settled with the user 2026-08-22.

#### [P02] Lens row activation opens the dash's room, through the one reveal path (DECIDED) {#p02-activation-opens-room}

Activating a Lens Dashes row whose dash has a worker card open in this instance does two things: `dispatchCommand("focus-session-card", { cardId })` to front the card, then `chain.sendToTarget(`${cardId}-card-content`, { action: TUG_ACTIONS.REVEAL_CHANGES, phase: "discrete" })` (Spec S02 — the target is the card-content scope, not the bare card id, for the reason [#click-through-mechanisms] states). The card-side handler calls its own `shadeViewController.show("changes")` — the same controller call [D152]'s passive reveal makes — and, when a join offer stands, adds the offer's `dash_head` to `revealedOffersRef`, so the passive reveal never re-fires for work the user has now been shown. The quiet-moment gate is deliberately **not** consulted: it exists to keep an *unbidden* reveal from covering what the user is reading, and an explicit click is its own license — the same reasoning that lets the Z4A Changes segment open the shade at any moment. Uniform for every bound row, joinable or not — the shade shows the dash lane in every state, so "open the dash's room" is a meaningful act throughout, and a rule that only worked for joinable rows would make activation a state-conditional surprise ([D142]).

**A row that cannot be activated must not look as though it can.** The Lens Dashes section lists every dash in every open project, so rows with no open worker card — every unbound dash, and any bound one whose card is closed — are ordinary, not exceptional. Those rows stay inert, and the inertness is *visible*: the row advertises its own actionability through a data attribute painted by CSS ([L06]) — the activatable row takes the pointer affordance and hover treatment the Cards section's rows already use, the inert row takes neither. A silent dead click on a row that looked live is the failure this rule exists to prevent; an inert row that never invited the click is not a refusal and needs no message.

#### [P03] Replay is a `⋯` verb on any diverged dash (DECIDED) {#p03-replay-menu-verb}

**Replay onto \<base\>** appears in the dash row's `⋯` menu on both surfaces. It is **enabled whenever the dash is diverged** — `base_ahead > 0` or `replay_conflict_paths` non-empty — bound or not, and disabled with its reason in the label ([L31]) for the two no-ops the client can prove from the wire entry alone: `Replay — already current with <base>` when neither divergence fact stands, and `Replay — its worktree has uncommitted changes` when `worktree_dirty` is true.

Boundness is deliberately **not** in the predicate, and the first draft of this plan had that wrong. `decide_for_dash` (`tugcast/src/feeds/base_motion.rs`) gates the automatic replay on: the repository's `autoreplay` flag, the per-dash `dash_autoreplay` flag, an in-flight replay, `base_ahead == 0`, the join journal, and worktree dirt. Boundness appears nowhere in it — `evaluate_workspace` reads `bound_sessions` only to decide **who to notify**. So "unbound" never meant "untended", and the two errors ran opposite ways: an unbound *dirty* dash would have offered a button whose replay returns `Deferred { reason: "dirty-worktree" }` every time, while a *bound* diverged dash with autoreplay off — the one population the engine will never touch and where a hand is the only recourse — would have had the verb hidden from it. The dirt case is now a readable disabled reason rather than a dead press, and the autoreplay-off case is exactly what the verb is for.

The client cannot read either autoreplay flag (neither is on the wire), so it never tries to predict whether the engine is about to act; it offers the verb on divergence and lets the server's outcome speak ([P06]). A press that races the engine is safe: `replay_onto` is a compare-and-swap over the worktree's cleanliness and HEAD, so the loser touches nothing and says so.

It sends a new `changeset_replay` CONTROL frame; the server runs `tugdash_core::replay_onto` and broadcasts the serialized outcome (Spec S01). Settled with the user 2026-08-22: menu item, both surfaces, divergence-based reach.

#### [P06] A replay that moves nothing still speaks, through the pane bulletin (DECIDED) {#p06-replay-speaks}

Three of `ReplayOutcome`'s five variants leave the row's facts **identical** to before the press: `Current` (nothing to do), `Deferred` (a precondition failed — `dirty-worktree`, `join-journal`, `git-too-old`, `no-worktree`), and `Conflicted` (a round conflicts; nothing was touched). Only `Replayed` and `Recorded` move anything a row can show. A verb whose common outcomes are invisible is a dead button, which is the exact failure this arc has already paid for once ([D152]'s Escape lockout, and the "join dead button" that turned out to be mode entry).

So the outcome reports on the **pane bulletin of the card the press was aimed at**, modeled on the shipping precedent for this exact problem: `dashBindErrorStore` + `DashBindErrorNoticeController`, the zero-render controller that projects a refused `bind_dash` onto a caution. A `dashReplayOutcomeStore` keyed by tug session id, and a sibling controller mounted in the same `TugPaneBulletinProvider`, subscribing in `useLayoutEffect` ([L03]), posting through the bulletin's direct DOM path rather than `useSyncExternalStore` ([L22], as that controller's docstring requires), with no notice state in React ([L02]) and appearance from the bulletin's own CSS ([L06]).

Which card: the shade's press reports on its own card; a Lens row's press reports on the **Lens's followed card** — the same card `resolveBindTarget` already aims a Bind at, so the two Lens verbs speak to one destination and the reader is never hunting for where an answer went. The frame therefore carries a session id, exactly as `changeset_discard` already does for its receipt. `Replayed` and `Recorded` post nothing: they show themselves in the row's facts on the next recompute, and a caution for a success is noise. Settled with the user 2026-08-22.

#### [P04] The Lens row adopts the shade's menu grammar whole (DECIDED) {#p04-one-menu-grammar}

`useDashRowMenu` grows a third optional verb slot (`replay`), and the Lens row composes the same hook with Bind, Discard, and Replay — replacing its standing Bind/Discard text buttons. One module, one grammar, one [L31] discipline on both surfaces; the eyebrow goes back to being read. `resolveBindTarget`'s refusal sentences ("Focus a session card to bind this dash", the cross-project refusal) become the Bind item's `disabledReason` verbatim.

#### [P05] Status is never a control, restated for rows (DECIDED) {#p05-status-not-control}

No state-conditional button materializes on any row. Activation is navigation only ([P02]); every mutating verb lives behind the `⋯`; the divergence facts on `DashMetaLine` remain facts — the replay verb sits in the menu, never on the fact that motivates it. The masthead cluster gains nothing. Settled with the user 2026-08-22.

### Deep Dives {#deep-dives}

#### The wire and handler pattern, as read on 2026-08-22 {#wire-pattern}

`do_changeset_discard` (`agent_supervisor.rs` ~line 5719) is the template: parse a `{project_dir, dash}` payload (`parse_changeset_discard_payload`, ~2046, dispatched at ~3006), guard on `registry.find_entry_by_path` ("not an open project") and `is_within_git_worktree` ("not a git repository"), do the work in `tokio::task::spawn_blocking` calling a `tugdash_core` op, then `changeset_all_bump().notify_one()` and broadcast `_ok` / `_err`. The replay handler follows it exactly, with `replay_onto(&dir, &dash)` as the op and no ledger writes — a replay destroys nothing and owns no draft, so the discard's draft/binding cleanup has no analogue here.

**Do not hand-roll the outcome word.** `ReplayOutcome` (`tugdash-core/src/replay.rs`) already derives `Serialize` with `#[serde(tag = "outcome", rename_all = "snake_case")]`, so serializing the value produces the tag *and* the variant's own fields in one step — `Deferred { reason, detail }`, `Conflicted { base_head, round, round_subject, paths }`, `Replayed { base_head, mapping, bookkeeping_commit }`. Those fields are not incidental: `reason`/`detail` is precisely what [P06]'s bulletin says out loud, and a hand-written `match` down to a bare word would throw away the only text that makes a refusal readable. `Conflicted` is still an `_ok` (the replay ran and reported; the conflict is the dash's state, not the verb's failure) — `_err` is reserved for the two guards and an `Err` from the op itself, which `replay_onto` returns only for a missing dash.

#### The click-through's four existing mechanisms {#click-through-mechanisms}

- **Fronting:** `cards-section.tsx`'s activation delegate (~line 954) is the precedent: `dispatchCommand("focus-session-card", { cardId })`, a registered action in `action-dispatch.ts` (~840) that fronts the card's pane and promotes it.
- **Aiming at a card — and the trap.** `sendToTarget(id, …)` **walks `parentId` upward from `id`** (`responder-chain.ts`, invariant I3). The bare `cardId` responder belongs to `card-host.tsx` (~1545) and answers only `SET_PROPERTY`; the session card's own handlers register one scope *beneath* it, at `${cardId}-card-content` (`session-card.tsx` ~4420). An upward walk from `card-host` therefore never reaches them, so a `REVEAL_CHANGES` sent to the bare `cardId` would be silently swallowed. The target is `${cardId}-card-content` — the established per-card command scope, used identically by `text-card.tsx`, `file-view-card.tsx`, `overview-card.tsx`, and documented as such in `tug-prompt-entry.tsx` (~750, "the card's command-handling scope"). Guard with `chain.hasResponder(`${cardId}-card-content`)`, which doubles as the liveness check: only a mounted session card registers it.
- **Revealing:** `session-card.tsx`'s passive reveal effect (~3495) owns `revealedOffersRef` and calls `shadeViewController.show("changes")`. The REVEAL_CHANGES handler must live in this file, next to that effect, so both paths share the ref and the controller — a handler anywhere else would be [D152]'s "second reveal path".
- **Resolving the worker card:** `cardSessionBindingStore` maps `cardId → { tugSessionId, workspaceKey, projectDir }`; the dash entry carries `bound_sessions?: string[]`, which `changeset.rs` (~1262) fills from `session_ledger.rs`'s `bound_sessions_by_dash()` — `SELECT dash_id, session_id … WHERE state = 'live'`, so the members are live tug session ids in the same space as `CardSessionBinding.tugSessionId`. The resolution — first open card whose bound `tugSessionId` appears in `bound_sessions` — is a pure function over the two snapshots, exported for unit testing exactly as `resolveBindTarget` is.

#### What the Lens section already has, and what it costs to change {#lens-section-today}

- `dashes-section.tsx` line ~545 declares `const delegate = useMemo<TugListViewDelegate>(() => ({}), []);` — an **empty** delegate. Adding `onSelect`/`onActivate` is an addition, not a rework, and `cards-section.tsx` (~944–966) is the shape to copy, including its comment on why click and Enter are the same act here.
- The section already owns a discard confirm: `DashVerbsContext.requestDiscard(row, anchor)`, with the anchor deliberately the row's `.tug-list-view-cell` rather than the pressing control, "because the confirm outlives the press and a control in a trailing cluster can unmount under its own popover". Moving Discard behind the `⋯` **must keep that anchor on the row cell** — the menu unmounts on selection, so anchoring to the menu item would destroy the popover as it opens. The menu opener can reach the cell with the same `.closest(".tug-list-view-cell")` the button uses today.
- `useDashRowMenu` dispatches each item as a typed action into its own scoped responder ([L11]) — `BIND_DASH`, `UNBIND_DASH`, `REQUEST_DISCARD_DASH`. A replay item therefore needs a **new** `TUG_ACTIONS.REQUEST_REPLAY_DASH`; without it the item has nothing to dispatch.

#### What "deferred" means here {#deferred-meaning}

`base_motion.rs` skips replay when autoreplay is off globally or per-dash (`Decision::Skip("autoreplay-off")`), and `replay_onto` itself returns `Deferred` for its own preconditions (`replay.rs` ~115–121). The join pilot never touches an unbound dash ([D147]). So an unbound dash behind a moved base shows `base_ahead` climbing and nothing acting — that standing state, plus a conflicted last replay (`replay_conflict_paths`), is the verb's whole population.

### Specification {#specification}

**S01 — `changeset_replay` wire contract.** Request: `changeset_replay { project_dir: string, dash: string, session_id?: string }` — `session_id` names the card whose bulletin reports the outcome ([P06]), optional exactly as `changeset_discard`'s is, and absent the replay still runs and simply says nothing. Success: `changeset_replay_ok { project_dir, dash, ...serialized ReplayOutcome }` — the outcome is `serde_json::to_value(&outcome)` flattened in, so the frame carries `outcome: "current" | "replayed" | "recorded" | "deferred" | "conflicted"` from the enum's own `#[serde(tag = "outcome", rename_all = "snake_case")]` **plus** that variant's fields (`reason`/`detail` on `deferred`, `round_subject`/`paths` on `conflicted`). Failure: `changeset_replay_err { project_dir, dash, message }`. The handler bumps the aggregate feed after the op regardless of outcome, so the row's divergence facts recompute.

Client: `ChangesetVerbStore` gains a `replay(entryKey, workspaceKey, dash, sessionId?)` sender in the **discard's own shape** — `entryKey` first for the per-row verb-state keying, `project_dir: workspaceKey` on the frame (the discard sends the workspace key under that name; there is no separate `projectDir` argument) — and a `ReplayState { phase: "idle" | "pending" | "done" | "error"; outcome: string | null; detail: string | null; error: string | null }` with its frozen `REPLAY_IDLE`, folded from the `_ok`/`_err` arms and read through the store's existing `useSyncExternalStore` hooks ([L02]).

**S02 — `REVEAL_CHANGES` action.** `TUG_ACTIONS.REVEAL_CHANGES: "reveal-changes"` in `action-vocabulary.ts`, payload-free, discrete-phase. Registered in the session card's **`${cardId}-card-content`** responder (`session-card.tsx` ~4420, beside `FOCUS_PROMPT` / `FIND` / `FIND_SELECTION`) — **not** the bare `cardId` responder, which is `card-host.tsx`'s and which an upward `sendToTarget` walk can never descend from ([#click-through-mechanisms]). The handler is defined beside the passive reveal effect and does exactly: stamp `revealedOffersRef` with the standing offer's `dash_head` if one stands, then `shadeViewController.show("changes")`.

**S03 — Lens activation resolution.** Pure exported function `resolveWorkerCard(boundSessions: readonly string[], bindings: ReadonlyMap<string, { tugSessionId: string }>): string | null` in `dashes-section.tsx` — first `cardId` whose binding's `tugSessionId` is in `boundSessions`, else null. The section's `TugListViewDelegate` (today the empty `{}` at ~line 545) gains `onSelect`/`onActivate` mirroring `cards-section.tsx`'s shape: resolve → `hasResponder` guard → front → `sendToTarget`. The same resolution feeds the row's activatable data attribute ([P02]), so what the row advertises and what a click does are computed from one value.

**S04 — the replay outcome notice.** `dashReplayOutcomeStore` in `tugdeck/src/lib/`, keyed by tug session id with a monotonic `seq` so two identical outcomes in a row still notify — `dashBindErrorStore`'s shape exactly, and for its stated reason. A `DashReplayNoticeController({ tugSessionId }): null` mounts in the session card's `TugPaneBulletinProvider` beside `DashBindErrorNoticeController`, subscribes in `useLayoutEffect` ([L03]), and posts one `api.caution("Couldn't replay that dash", { id, description })` for `deferred` (description = the outcome's `detail`) and `conflicted` (description names the round and its conflicting paths). `current` posts an `api.info`-class note that the dash is already current; `replayed` and `recorded` post nothing.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| New state | Zone | Law |
|---|---|---|
| Replay verb phase + outcome + detail | `ChangesetVerbStore` (external store), read via `useSyncExternalStore` | [L02] |
| Replay outcome notice (`dashReplayOutcomeStore`) | External store read by a **zero-render controller**, subscribed directly — deliberately *not* through `useSyncExternalStore`, because a bulletin is a direct DOM update | [L22], [L03] |
| Notice controller's last-posted `seq` | Local data in a ref, never React state | [L24] |
| Lens row `⋯` open point | View-scope local state (inside `useDashRowMenu`, unchanged) | [L22] |
| Reveal memory (`revealedOffersRef`) | Existing mount-local ref, gains one writer | [L22] |
| Menu item disabled tone; row activatable affordance | CSS on data attributes, never React state | [L06] |

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

- **Rust (`cargo nextest run -p tugcast`):** payload parse (well-formed, missing fields), outcome-word mapping from every `ReplayOutcome` variant, guard refusals.
- **Unit (`bun test`):** `resolveWorkerCard` over empty/miss/hit/multi-hit snapshots; the store's `changeset_replay_ok`/`_err` fold; the menu's third-slot label/disabled composition (extending `__tests__/dash-row-menu-label.test.ts`).
- **App-test (real app, selective):** one new file — a Lens dash row click-through fronts the worker card and the shade stands; a fixture dash with a moved base and no binding offers Replay in the `⋯` and pressing it settles the divergence facts. `@covers` lines for every touched source file.

#### What stays out of tests {#test-non-goals}

No jsdom/RTL render tests (banned); no fake stores — the unit layer tests exported pure functions and the real store class. The quiet-moment auto-reveal is already pinned by at0445 and is not re-tested here; the shade's visual anatomy is not asserted beyond presence.

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The server learns to replay on request | done | `043861f9f` |
| #step-2 | The store carries the verb and its receipt | done | `1f5bb013f` |
| #step-3 | One menu grammar on both surfaces | done | `a0e4adcb1` |
| #step-4 | The Lens row opens the dash's room | done | `d6e96777e` |
| #step-5 | Pin the gestures and record the decision | done | `8e366c0e3` |

#### Step 1: The server learns to replay on request {#step-1}

**Commit:** `tugdash(dash-entry-points): teach the server to replay a dash on request`

**References:** [P03] Replay is a `⋯` verb, Spec S01, (#wire-pattern, #deferred-meaning)

**Tasks:**
- [ ] Add `parse_changeset_replay_payload` (`project_dir`, `dash`, optional `session_id`) and the `"changeset_replay"` dispatch arm in `agent_supervisor.rs`, beside the discard's.
- [ ] Add `do_changeset_replay`: the discard's two guards verbatim ("not an open project" / "not a git repository"), `spawn_blocking(move || tugdash_core::replay_onto(&dir, &dash))`, `changeset_all_bump().notify_one()`, and `send_changeset_replay_ok` / `send_changeset_replay_err`.
- [ ] Serialize the outcome with serde rather than a hand-written `match` — `ReplayOutcome` already carries `#[serde(tag = "outcome", rename_all = "snake_case")]`, and the variant fields (`Deferred`'s `reason`/`detail`, `Conflicted`'s `round_subject`/`paths`) are what [P06]'s notice reads. A bare word would discard them.
- [ ] No ledger writes and no draft/binding cleanup — state why in the handler doc (a replay destroys nothing and owns no draft).

**Tests:**
- [ ] nextest cases for the payload parse (well-formed, missing `session_id`, missing required fields).
- [ ] A serialization case per `ReplayOutcome` variant asserting the `outcome` tag *and* that `Deferred` keeps `reason`/`detail` and `Conflicted` keeps `paths` — the fields the notice depends on.
- [ ] The two guard refusals produce `_err`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` — green, including the new cases.
- [ ] `rg "changeset_replay" tugrust` — shows parse, dispatch arm, handler, and both senders.

---

#### Step 2: The store carries the verb and its receipt {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash(dash-entry-points): carry the replay verb in the changeset store`

**References:** [P03] Replay is a `⋯` verb, Spec S01

**Tasks:**
- [ ] `ReplayState` in `changeset-verb-store.ts` (`phase`, `outcome`, `detail`, `error`), its frozen `REPLAY_IDLE`, a `replay(entryKey, workspaceKey, dash, sessionId?)` sender, and the `changeset_replay_ok` / `changeset_replay_err` fold arms — modeled on the discard's, including its `entryKey`-first signature and its `project_dir: workspaceKey` frame field (Spec S01). Do **not** add a separate `projectDir` argument; the discard has none.
- [ ] `useChangesetReplay` hook beside the existing verb hooks ([L02]).
- [ ] `dashReplayOutcomeStore` (Spec S04) fed from the same fold — keyed by tug session id with a monotonic `seq`, mirroring `dashBindErrorStore`.

**Tests:**
- [ ] `bun test` fold cases — pending on send; done carrying the outcome word and, for `deferred`, its `detail`; error carrying the message.
- [ ] The outcome store notifies twice for two identical consecutive outcomes (the `seq` discipline `dashBindErrorStore` exists to hold).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit` — clean.
- [ ] `bun test` — green.

---

#### Step 3: One menu grammar on both surfaces {#step-3}

**Depends on:** #step-2

**Commit:** `tugdash(dash-entry-points): put replay behind the row menu, on both surfaces`

**References:** [P03] Replay is a `⋯` verb, [P04] One menu grammar, [P05] Status is never a control, [P06] Replay speaks, Spec S04, (#lens-section-today)

**Tasks:**
- [ ] Add `TUG_ACTIONS.REQUEST_REPLAY_DASH` to `action-vocabulary.ts` beside `REQUEST_DISCARD_DASH` — the menu dispatches typed actions into its own scoped responder ([L11]), so without this the item has nothing to fire.
- [ ] `DashRowMenuOptions` gains `replay: DashRowMenuVerb | null`; the menu renders it after Discard and handles the new action; the module doc's verb census is updated (the join is still not among them, and says so).
- [ ] Export the enablement predicate as a pure function over the wire entry: enabled when `base_ahead > 0` or `replay_conflict_paths` is non-empty; disabled with `already current with <base>` when neither, and with `its worktree has uncommitted changes` when `worktree_dirty` ([P03]). **Boundness is not consulted** — both surfaces offer it on the same terms, fronted row included.
- [ ] `session-changes-dash-lane.tsx`: every row composes the replay verb from that predicate.
- [ ] `dashes-section.tsx`: replace the standing Bind/Discard text buttons with `useDashRowMenu` composing Bind (from `resolveBindTarget`, its refusal sentences as `disabledReason` verbatim), Discard, and Replay. Keep `DashVerbsContext.requestDiscard`'s anchor on the row's `.tug-list-view-cell` — the menu unmounts on selection, so anchoring the confirm to the item would destroy the popover as it opens ([#lens-section-today]).
- [ ] Mount `DashReplayNoticeController` (Spec S04) beside `DashBindErrorNoticeController` in the session card's `TugPaneBulletinProvider`, and post from it per [P06].
- [ ] **Update the app-tests this removal breaks**, in this step rather than later: `at0407-lens-dashes-section.test.ts` (~172) counts `lens-bind` / `lens-discard` per row, and `at0438-lens-unbound-dashes.test.ts` (~70) selects `lens-bind` directly. Rewrite both against the `⋯` menu. Note also that `at0445-join-reveal.test.ts` (~326) asserts `lens-bind` is *absent* on a bound row — that assertion keeps passing but becomes vacuous, so re-point it at the menu's Bind item or its intent is silently lost.

**Tests:**
- [ ] Extend `__tests__/dash-row-menu-label.test.ts` for the third slot's label/disabled composition.
- [ ] Unit-test the enablement predicate: diverged → enabled; current → disabled with its reason; dirty → disabled with its reason; bound-and-diverged → **enabled** (the regression [P03] corrects).
- [ ] The rewritten at0407 and at0438.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build` — clean.
- [ ] `bun test` — green.
- [ ] `rg 'data-slot="lens-bind"|data-slot="lens-discard"' tugdeck/src tests/app-test` — no standing verb buttons and no test still reaching for one.
- [ ] `just app-test tests/app-test/at0407-lens-dashes-section.test.ts tests/app-test/at0438-lens-unbound-dashes.test.ts` — `VERDICT: PASS`. This step changes a shipping surface, so it verifies that surface rather than deferring the discovery to Step 5.

---

#### Step 4: The Lens row opens the dash's room {#step-4}

**Depends on:** #step-3

**Commit:** `tugdash(dash-entry-points): a Lens dash row routes to its worker's shade`

**References:** [P02] Activation opens the room, Spec S02, Spec S03, (#click-through-mechanisms)

**Tasks:**
- [ ] `TUG_ACTIONS.REVEAL_CHANGES` in `action-vocabulary.ts`, payload-free, discrete-phase.
- [ ] Register the handler on the session card's **`${cardId}-card-content`** responder (`session-card.tsx` ~4420, beside `FOCUS_PROMPT`/`FIND`), defined next to the passive reveal effect so both share `revealedOffersRef` and `shadeViewController` (Spec S02): stamp the standing offer's `dash_head` if one stands, then `show("changes")`. **Not** the bare `cardId` responder — that one is `card-host.tsx`'s, `sendToTarget` walks upward from its target, and a miss here fails silently ([#click-through-mechanisms], R02).
- [ ] `resolveWorkerCard` (Spec S03) exported from `dashes-section.tsx`, and the section's activation delegate — today an empty `{}` at ~line 545 — filled in the shape of `cards-section.tsx`'s (~944–966): resolve → `chain.hasResponder(`${cardId}-card-content`)` guard → `dispatchCommand("focus-session-card", { cardId })` → `sendToTarget`. No match → inert.
- [ ] Paint the row's activatable affordance from the same resolution ([P02]): a data attribute on the row, pointer/hover treatment in `dashes-section.css` ([L06]), nothing in React state. A row with no worker card must not present as clickable.

**Tests:**
- [ ] `bun test` for `resolveWorkerCard` — empty, miss, hit, multi-hit snapshots.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build` — clean.
- [ ] `bun test` — green.

---

#### Step 5: Pin the gestures and record the decision {#step-5}

**Depends on:** #step-4

**Commit:** `tugdash(dash-entry-points): pin the entry points end to end`

**References:** [P01] Route never originate, [P02] Activation opens the room, [P03] Replay is a `⋯` verb, [P04] One menu grammar, [P05] Status is never a control, Spec S01, Spec S02, Spec S03

**Tasks:**
- [ ] `just build-app` first — Step 1 changed Rust, and app-tests never rebuild the binary.
- [ ] New app-test with `@covers` lines for every touched source file, built on `tests/app-test/dash-fixture.ts` (`makeDashScratchRepo` + `seedScratchSession` + `createDash` + `commitRound` + `bindDash`, and `gitRetry` to move the base branch in the scratch repo — `at0427-dash-divergence-marks.test.ts` is the working precedent for producing `base_ahead > 0`). Never cut a dash in the developer's checkout; `createDash` refuses it anyway.
- [ ] Assert three things: a Lens row for a bound dash fronts its worker card and leaves the Changes shade standing; a row with no worker card is inert **and does not advertise itself as activatable** ([P02]); a diverged dash's `⋯` offers Replay enabled, and pressing it settles the divergence facts on the next recompute.
- [ ] Assert the dead-button guard directly ([P06]): press Replay on a dash whose worktree is dirty and confirm the pane bulletin carries the deferred reason — the outcome the row's facts cannot show. This is the assertion that would have caught the first draft's silent-press design.
- [ ] Append the entry-points decision to `tuglaws/design-decisions.md` as the next free `[D##]`, citing [D142] / [D147] / [D152] and recording that boundness does not gate auto-replay.

**Tests:**
- [ ] The new app-test file.
- [ ] `just app-test-covers-check`.

**Checkpoint:**
- [ ] `just app-test tests/app-test/<new-file>.test.ts` — `VERDICT: PASS`.
- [ ] `just app-test-covers-check` — green.
- [ ] `just app-test tests/app-test/at0445-join-reveal.test.ts tests/app-test/at0436-join-press.test.ts tests/app-test/at0405-changes-dash-lane.test.ts` — the arc's existing pins and the shade lane still pass untouched.

### Deliverables and Checkpoints {#deliverables}

The `changeset_replay` verb live end to end, its non-moving outcomes speaking through the pane bulletin ([P06]); one `⋯` grammar carrying Bind/Unbind, Discard, and Replay on both dash-row surfaces; Lens row activation routing to the worker card's Changes shade through [D152]'s one reveal path, with inert rows visibly inert; the masthead untouched; creation untouched; a design-decisions entry recording the shape.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

Every Success Criterion above holds; all five ledger rows read `done`; the join arc's existing pins (at0445, at0436) still pass untouched.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

A create composer route (`/dash <name> [plan]`) was raised during devise and declined for this round; if creation ever wants a door outside the skills, it is a composer route, not a display-surface affordance ([P01]).
