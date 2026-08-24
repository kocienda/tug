<!-- devise-skeleton v4 -->

## Dash Integration — Visibility {#dash-visibility}

**Purpose:** Make dashes visible everywhere they should be, with zero landing-path stakes: the Changes shade grows a dash lane rendered in dash grammar, the Session card's chrome wears the bound dash's name, the Lens gains a "Dashes" section with jump-to-session affordances, and `/dash <name>` becomes the card gesture that creates and/or binds. Everything in this phase is read-only over data Phase 1 already ships on the wire — no landing verbs, no new Rust, no schema changes.

This is Phase 2 of the program plan [dash/dash-integration-plan.md](dash-integration-plan.md). The program plan's ratified decisions ([P01] overlay binding, [P02] many-cards-one-dash, [P05] naming/`/dash` gesture, [P06] derive-don't-record) are inherited and cited as `program-[P##]` — settled, not reopened. Phase 1 is complete and merged as commit `a4477d50b` (recipe: [dash-integration-1-foundation.md](dash-integration-1-foundation.md)); its contract — `CardSessionBinding.dash`, `DashChangesetEntry` with `branch`/`stage`/`bound_sessions`, the `bind_dash` CONTROL verb, `bind_dash_ok`/`unbind_dash_ok` broadcasts, and `tugutil dash create`'s auto-bind — is the substrate this phase renders.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | complete |
| Target branch | main (run as a dash) |
| Program plan | [dash-integration-plan.md](dash-integration-plan.md) |
| Last updated | 2026-08-13 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-14, opus (post-implementation audit).** Reviewed after the merge, for the same reason Phase 1's record gives: the review gesture postdates the plan. The assessment is of the shipped tree (`b53bdd718`) against the plan. Lint: 0 errors, 1 warning.

Applied: nothing. The phase held its own "zero landing-path stakes" promise literally — view-layer only, over stores Phase 1 already filled, with no schema or wire change to re-destabilize the shipped Changes surface. The one choice worth recording under the technical-choices axis is the Lens row's liveness mark: `DashPhaseDot` mounts the phase subscription at the glyph rather than reading phase in the row projection, so a transcript event repaints one dot instead of waking the section. The parked mark being a *glyph* and not a resting dot is the right call for the same reason — "nobody is working this" is not a state of work — and `rowFromEntry` treats an absent `bound_sessions` as parked rather than as a live claim, which is the honest reading of an older sender.

Deferred: the PL011 warning on [#step-5](#step-5) stands unfixed and should. That step is a verification pass whose gates live in its Tasks block; a Tests block there would be ceremony. It is exactly the calibration case that keeps PL011 a warning rather than an error.

---

### Phase Overview {#phase-overview}

#### Context {#context}

All the data already flows; nothing renders it. Specifically, as of `a4477d50b`:

- `ChangesRouteController` (`tugdeck/src/lib/changes-route-controller.ts`) already derives `snapshot.dashes: DashChangesetEntry[]` — the per-card Changes slice separates `entry` / `dashes` / `unattributed` / `orphaned`, and `SessionChangesView` (`tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx`) renders every part of it **except** `dashes`. `TugChangesList`'s entry model (`tugdeck/src/components/tugways/tug-changes-list.tsx`, `TugChangesListEntry`) deliberately excludes dashes: "The dash lane lives in the Changes shade, not here ([P01])" — a comment pointing at exactly the component this phase builds.
- `CardSessionBinding.dash?: { id, name }` is populated on the `spawn_session_ok` ack and merged live by the `bind_dash_ok` / `unbind_dash_ok` handlers in `tugdeck/src/action-dispatch.ts` (via `cardSessionBindingStore.setDashBinding`). No component reads it.
- `DashChangesetEntry` (`tugdeck/src/lib/changeset-types.ts`) carries `owner_id` (the opaque owner key — never displayed, never a ref), `display_name`, `branch?`, `stage?` (`created|working|draft-ready|landing`, program-[P06] derived-only in this era), `bound_sessions?` (live sessions only; **empty is how *parked* reads**), `base`, `rounds`, `worktree`, `worktree_dirty`, `round_subjects?`, `files`, `draft?`. `step_current`/`step_total` are declared but not emitted until Phase 3.
- The dash range diff is already served end-to-end: `DiffDescriptor` (`tugdeck/src/lib/git-diff-store.ts`) has the `{ kind: "range", root?, worktree, base, branch }` flavor, resolved server-side by `feeds/git.rs::fetch_dash_diff` (worktree working tree vs `merge-base(base, branch)`).
- `tugutil dash create <name>` auto-binds the calling session (`TUG_SESSION_ID` → `POST /api/dash`) on **both** the fresh and the already-exists paths (`tugutil/src/dash.rs::run_create` calls `run_bind` unconditionally after `ops::create`), and the resulting `bind_dash_ok` broadcast reaches every deck. The Session card's shell route has `TUG_SESSION_ID` env parity (shipped `dc9263805`), so a shell-route `tugutil dash create` binds the card that ran it.

The rendering doctrine comes from the consolidation plan's Zone-2 ruling (archived, `dash/archive/changes-commit-dash-consolidation.md` [P06]): the **perky-frog rule** — a dash branch rendered in session-file grammar reads as a claim; dashes get their own grammar (name · base · rounds · dirty), their own fold, their own species of row. Every surface must declare whose question it's answering.

#### Strategy {#strategy}

- **View-layer only.** No new feeds, no new stores of record, no Rust. The dash lane and the Lens section are projections of `ChangesetAllStore` (CHANGESET_ALL, 0x24); the chrome chip is a projection of `cardSessionBindingStore`. The one new wire *send* is the deck finally using the `bind_dash` CONTROL verb Phase 1 shipped.
- **Dash grammar, never claim grammar.** The lane renders its own row species (Spec S01), not `TugChangesList` entries — file lists are display-only name-status rows with no claim/disclaim/hunk affordances, and the lane's diff affordance is the whole-range pop-out (the server's range diff takes no pathspec; see (#range-diff-no-pathspec)).
- **Bound fronts, unbound folds.** A card whose session is mated to a dash renders that dash's lane expanded and first; other dashes (and all dashes on an unbound card) fold to one summary line, the Zone-2 "Also on this project" shape.
- **Churny state stays in leaves.** The Lens row's live indicator is a leaf subscription (the `SessionPhaseDot` pattern — `tugdeck/src/components/tugways/session-phase-dot.tsx`): phase reads never enter the row projection or the section's data pass.
- **One gesture, existing machinery.** `/dash <name>` resolves the name client-side against the snapshot; an existing dash binds via a `bind_dash` CONTROL frame (no shell noise), a new name runs `tugutil dash create <name>` through the card's shell route (visible receipt, auto-bind does the rest), and an unanswered snapshot resolves nothing at all — it cautions and waits, because bind mints and create mutates, and neither is a thing to do on a guess ([P06]). All resolved paths converge on the same `bind_dash_ok` broadcast the deck already handles.

#### Success Criteria (Measurable) {#success-criteria}

- With a dash inflight in the card's project, the Changes shade shows a dash lane row carrying name, base, rounds, dirty state, stage, and the maintained join draft read-only; its pop-out opens a range diff. (App-test.)
- A dash-bound card renders its dash's lane expanded and first; an unbound card folds all dashes to the one-line summary; expanding reveals the rows. (App-test.)
- The bound dash's name appears in the Session card chrome while bound and disappears on unbind — live, mid-session, driven by the `bind_dash_ok`/`unbind_dash_ok` broadcasts. (App-test.)
- The Lens shows a "Dashes" section: one row per inflight dash across all open projects with name, stage, and mated-session jump; a parked dash (zero bound sessions) wears the parked mark; the collapsed band summarizes (`N dashes · M parked`). Clicking a mated session's jump fronts that card. (App-test.)
- `/dash <existing-name>` binds the card (chip appears, lane fronts) without a shell row; `/dash <new-name>` creates via the shell route and the card ends bound; bare `/dash` with dashes inflight opens the Changes shade; bare `/dash` with none raises a caution bulletin. (App-test + bun tests for the registry.)
- `bun test`, `bunx vite build`, `cargo nextest run` (untouched but the gate stands), and `just app-test-changed` all green at phase end.

#### Scope {#scope}

1. **Changes dash lane** in `SessionChangesView`: dash-grammar rows over `snapshot.dashes`, bound-dash fronting, folded summary, range-diff pop-out, read-only draft (Spec S01, [P01], [P02]).
2. **Chrome chip**: the bound dash's name in the Session card masthead ([P03]).
3. **Lens "Dashes" section**: registered section, rows across all projects, stage + parked mark, mated-session jump, leaf live-indicator, collapsed summary (Spec S02, [P04], [P05]).
4. **`/dash` gesture**: registry entry, session-card surface handler, `bind_dash` CONTROL sender, shell-route create path ([P06], Spec S03).

#### Non-goals (Explicitly out of scope) {#non-goals}

- Any landing affordance — no Join, no Release, no join mode, no `changeset_join`/`changeset_release` deck senders (Phase 4). The lane's draft is read-**only**; there is no draft editor for dashes here.
- No unbind gesture in the UI. `tugutil dash unbind` covers the rare need; a card-side affordance is Phase 5 polish (parked-dash adopt/release/leave).
- Step tracking display beyond "render `step_current`/`step_total` when present" — the fields stay absent until Phase 3 mints them; nothing here waits on them.
- Multi-dash picker / Lens ordering refinements (Phase 5).
- No changes to `DashChangesetEntry`, the snapshot composition, or any Rust surface. If a rendering need seems to demand a wire change, that is a phase-boundary violation to raise, not a field to add.

#### Dependencies / Prerequisites {#dependencies}

- Phase 1 merged (`a4477d50b`) — all wire fields, verbs, and broadcasts named in (#context).
- Existing deck machinery, all shipped: `ChangesetAllStore` + `useChangesetAll` (`tugdeck/src/lib/changeset-all-store.ts`), `ChangesRouteController`, `cardSessionBindingStore` + `cardIdForSession` + `useCardIdForSession`, the Lens section registry (`tugdeck/src/components/lens/lens-section-registry.ts`, `lens-section-content.ts`), `SessionPhaseDot` / `useSessionPhase`, `PopOutDiffButton` + `DiffDescriptor` range flavor, `TugBadge`, `TugListView`/`TugListRow`, `BlockFoldCue`, the local-slash registry (`tugdeck/src/lib/slash-commands.ts`) and the session card's `slashCommandSurfaces` map, `getConnection()` (`tugdeck/src/lib/connection-singleton.ts`), `shellSessionStore` (the `$` shell route).

#### Constraints {#constraints}

- Tuglaws: [L01] no second `root.render()`; [L02] every store enters React through `useSyncExternalStore`; [L03] `useLayoutEffect` for registrations events depend on (`setSectionContent`, `setSectionAttachedList`); [L06] appearance via CSS/DOM attributes, never React state; [L11] controls emit actions, responders own the state they operate on — the Lens jump dispatches `focus-session-card` rather than reaching into a card; [L13] motion belongs to the animation engine — the live indicator is `TugProgressIndicator`'s; [L19] every component follows the component-authoring guide, whose reuse rule is why the lane and the chip compose `TugBadge` / `TugListRow` / `BlockFoldCue` / `BlockStrip` rather than hand-rolling chrome (borrowing a component's CSS is still hand-rolling); [L20] each component owns tokens scoped to its own slot — the chip keeps `TugBadge`'s tokens and the masthead restyles none of its internals; [L30] every user-invocable command is a registry entry reached through the two funnels — `/dash`'s registry is `LOCAL_SLASH_COMMANDS`, and its (deliberate) absence from the command table is stated in [P06].
- No `localStorage`; any persisted preference goes through tugbank defaults. (This phase persists nothing new: the lane's fold is view-scope ephemeral state, deliberately — see [P02].)
- bun, never npm; `bunx vite build` must pass before the phase is called done (the debug app loads the prod rollup bundle).
- App-tests: selective runs via `just app-test-changed`; every new test carries `@covers` lines; never pipe app-test output.
- The deck treats `owner_id` as opaque ([P09] of the Phase 1 recipe): display uses `display_name`, refs use `branch ?? "tugdash/" + display_name` (the older-sender fallback documented on the type).

#### Assumptions {#assumptions}

- `stage` arrives on every entry from a current server; the lane and the Lens tolerate its absence (an older sender) by omitting the stage ink rather than guessing.
- Per-instance `bound_sessions` visibility is correct for these surfaces (Phase 1 [Q02] DEFERRED): a deck shows its own cards, and `cardIdForSession` only resolves local cards anyway.
- The Session card's shell route is available whenever `/dash <new-name>` can be typed (the composer and the shell store live on every session card), and its env carries `TUG_SESSION_ID` (shipped `dc9263805`).
- Dash entries appear in `snapshot.dashes` only for projects that actually have `tugdash/*` refs; an empty lane is the common case and must cost nothing visually.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows devise-skeleton v4: explicit `{#anchor}` headings, `[P##]` plan-local decisions, `[Q##]` open questions, `Spec S##`, `Risk R##`, `**Depends on:**` step anchors, `**References:**` on every step, no line-number citations. Program-plan decisions are cited as `program-[P##]`; Phase 1 recipe decisions as `phase1-[P##]`; global decisions as `[D##]`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does the masthead chip collide with the pane control cluster? (RESOLVED — placement chosen, verified by test) {#q01-chip-collision}

**Question:** The masthead's title line is overlapped by the pane's control cluster (stack badge, `…` menu, width control, close X, telemetry widget), and `SessionMasthead` mounts `SessionIdentityRow` with each line "told what to stop short of". Does a trailing chip on the title line fit?

**Resolution:** RESOLVED by placement: the chip rides `TugSessionRow`'s `slots` slot (the same title-line trailing slot the Lens uses for `SlotPicker`), which sits **inside** the row's content box — i.e. inside the width the masthead already reserves against the cluster — so it cannot collide with pane chrome by construction. The chip elides its own text (`TugBadge` does) when the title line is tight. The app-test takes a screenshot for visual confirmation ([R01] names the residual).

#### [Q02] Where does bare `/dash` land — shade lane or Lens section? (DECIDED — see [P06]) {#q02-bare-dash}

**Resolution:** DECIDED — the Changes shade (card-local; the gesture was typed in a card, discovery lands where the card's own dash facts live). See [P06].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Dash lane destabilizes the shipped Changes surface | med | low | view-layer only over an unchanged controller; the lane is a sibling block below `TugChangesList`, touching none of its props; dash grammar visually distinct; app-test per surface | any regression in at0332-class Changes tests |
| Masthead chip crowds the title line on narrow panes | low | med | `slots` placement inside the reserved content box; `TugBadge` self-elides; screenshot assertion in the app-test | chip ink clipped or overlapping in the screenshot |
| Same dash name in two open projects confuses the Lens | low | low | rows key by `owner_id` (unique per incarnation); when more than one open project has dashes, rows carry the project's `display_name` as a muted suffix (the Cards section's disambiguator pattern) | user reports ambiguous rows |
| `/dash` create path stalls behind a busy shell | low | med | the surface refuses with a caution when `shellSessionStore` has an exchange inflight (the `/shell` handler's exact guard) — never queued silently | — |
| Phase churn wakes the Lens on every transcript event | med | low without the fix | the live indicator is a leaf (`DashPhaseDot`), mounted per row; the section body and data projection never read phase ([P05]) | Lens re-render storms in the dev panel |

**Risk R01: the chip placement reads wrong even without overlap** {#r01-chip-visual}

- **Risk:** even inside the content box, a badge on the masthead title line might out-shout the identity it sits beside or read as part of the callsign.
- **Mitigation:** `TugBadge` at the quiet end (`tinted`/`sm`-adjacent sizing, `data` role — a category label, not a status shout); the app-test screenshot is reviewed at implementation time; the chip's look is CSS-only, so tuning it never touches React ([L06]).
- **Residual risk:** aesthetic judgment deferred to the screenshot review; a follow-up CSS tweak is cheap.

---

### Design Decisions {#design-decisions}

#### [P01] The dash lane is its own component in dash grammar — never `TugChangesList` entries (DECIDED) {#p01-dash-lane-species}

**Decision:** A new `SessionChangesDashLane` component (`tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx` + paired `.css`) renders `snapshot.dashes` below the head entries inside `SessionChangesView`'s body. Each dash renders as a **dash-grammar row**: `[name badge] <base> · <N rounds> · <dirty|clean> · <stage>`, expandable to reveal round subjects (newest first, from `round_subjects`), the file list as plain name-status rows (path + `git_status` letter, display only — no claim, no disclaim, no hunk election, no per-file diff), and the maintained draft message read-only when `draft` is present. The row's one diff affordance is a `PopOutDiffButton` with `{ kind: "range", root: project.project_dir, worktree, base, branch }`. `TugChangesListEntry` is not extended.

**Rationale:**
- The perky-frog rule (consolidation-plan [P06], carried into the program plan): a dash rendered in session-file grammar reads as a claim. Different species, different grammar, different fold.
- `TugChangesList`'s entry model already refuses this by comment; extending it would push claim affordances into rows that must never have them.
- Per-file inline diffs are impossible honestly: the server's range diff (`feeds/git.rs::fetch_dash_diff`) takes no pathspec — see (#range-diff-no-pathspec). One whole-range pop-out is what the wire supports, and it is the right unit anyway (the dash IS the unit).

**Implications:** the fold-all cue and combined pop-out in the shade header keep acting on head entries only — the dash lane has its own fold, per species. The lane renders nothing (not even a header) when `snapshot.dashes` is empty.

#### [P02] Bound fronts expanded; everything else folds to one line; the fold is ephemeral (DECIDED) {#p02-fronting}

**Decision:** When the card's `CardSessionBinding.dash` matches a dash entry (by `dash.id === entry.owner_id`), that dash's row renders **first and expanded** under a "This card's dash" treatment. All other dashes (and all dashes on an unbound card) render under one collapsed summary line — `Also on this project: 2 dashes` / `Dashes: 1 (snippets · 6 rounds · dirty)` — expandable via the standard `BlockFoldCue`. The expanded/collapsed state is view-scope React `useState`, exactly like `SessionChangesView`'s `expandedKeys`; it resets when the shade remounts and is deliberately not persisted.

**Rationale:** program-plan Phase 2 item 1 verbatim ("A dash-bound card fronts its dash's lane; unbound cards fold dashes under the project"). Ephemeral fold state matches the shade's existing per-file collapse precedent — the shade is a glance surface, dismiss-and-forget; persisting its folds would be state nobody asked to keep. The binding match keys on the **owner key**, not the name, so a stale binding to a dead incarnation of a reused name never fronts the wrong dash (the haunting class program-[P03] retired).

**One expected mismatch window, by design.** For a dash created before ids existed, the feed's read path never mints (`dash_owner_key`) and emits `owner_id = tugdash/<name>`, while a bind *does* mint (`ensure_dash_id`) and returns `tugdash/<name>#<id>`. Between the `bind_dash_ok` ack and the next CHANGESET_ALL recompose the two disagree: the chip appears and the lane does not front. `do_bind_dash` fires the aggregate bump on success, so the window is one recompose wide. The lane needs no special case for it — an unmatched binding is the ordinary unbound rendering (everything folded), which is exactly what should be on screen for that instant.

#### [P03] The chrome chip is a `TugBadge` in the masthead's title-line slot, read from the binding store (DECIDED) {#p03-chrome-chip}

**Decision:** `SessionMasthead` (`tugdeck/src/components/tugways/session-masthead.tsx`) reads the card's dash binding from `cardSessionBindingStore` (it already subscribes to that store for `projectDir`) and, when `dash` is present, passes `slots={<TugBadge …>{dash.name}</TugBadge>}` into its `SessionIdentityRow` — the same title-line trailing slot the Lens's Cards section fills with `SlotPicker`. The badge is display-only (`TugBadge` is a label by contract; its intrinsic right-click-copy copies the dash name), `emphasis="tinted"`, `role="data"`, with a `data-slot="session-masthead-dash-chip"` hook and a hover title `Working on dash <name>`.

**Rationale:** the masthead is the Session card's chrome tier and already the answer to "what is this card?"; the binding store is already wired there with the correct update path (spawn ack seeds it, `bind_dash_ok`/`unbind_dash_ok` merge live). `TugBadge` is the published component for exactly this (never hand-roll; borrowing its CSS is still hand-rolling). Display-only is honest for a read-only phase — the chip gains gestures when there are verbs to offer (Phase 4/5).

**Implications:** no new store, no new props threaded from the pane; the chip appears/disappears with zero session-card involvement. [Q01] resolves the geometry.

#### [P04] The Lens "Dashes" section projects `ChangesetAllStore` across all projects, keyed by `owner_id` (DECIDED) {#p04-lens-section}

**Decision:** New section `tugdeck/src/components/lens/sections/dashes-section.tsx` (+ `.css`), registered from `main.tsx` beside `registerCardsSection()`/`registerLayoutsSection()`. `kind: "dashes"`, title "Dashes", glyph `GitBranch` (lucide — a dash IS a branch + worktree). The body reads `useChangesetAll()` and flattens every project's `changesets` to its dash entries. One row per dash, keyed `owner_id`: a live-indicator leaf ([P05]), the `display_name`, the stage word, `step i/N` **only when both fields are present** (Phase 3 turns them on; nothing renders meanwhile), a parked mark when `bound_sessions` is empty (`bound_sessions === undefined` from an older sender also reads parked — absence of evidence renders the quiet mark, never a live claim), and — when the dash has bound sessions — one jump chip per session that resolves to an open card (`cardIdForSession`), dispatching `focus-session-card` with that card id on activation, exactly the Cards section's gesture. A bound session with no open card renders as inert muted text (the consolidation plan's unlinked ruling). When more than one open project has dashes, each row carries the project `display_name` as a muted trailing disambiguator. Rows compose `TugListView` + `TugListRow` with the Lens presentation (`LENS_LIST_PRESENTATION`), `collapsedSummary` reports `N dashes · M parked` (or "No dashes"), and the body publishes `setSectionContent(host.focusGroup, { navigable, populated })` in a `useLayoutEffect` ([L03]) exactly as `cards-section.tsx` does. `filterable` stays off — a handful of dashes is a fixed-size section.

**Rationale:** the Lens is the account-global surface and `ChangesetAllStore` is the account-global snapshot it already reads; no new feed, no new store. Keying by `owner_id` makes reused names distinct across incarnations for free. Composing `TugListView` is the law for list focus (never hand-roll list focus).

**Implications:** the persisted `sectionOrder` tolerates the new kind (unknown kinds ignored, unordered kinds appended in registration order — `resolveSectionRenderOrder`), so no migration; existing decks see "Dashes" appended after their current sections.

#### [P05] The live indicator is a leaf subscription — phase never enters the row projection (DECIDED) {#p05-leaf-dot}

**Decision:** A `DashPhaseDot` leaf component (living in `dashes-section.tsx`) takes the entry's `bound_sessions` and renders the session-phase pulsing dot for the **first bound session that resolves to an open card** (via `useCardIdForSession` for offer-freshness, then `useSessionPhase(sessionId)` for the phase — both already-published hooks); with no resolvable session it renders the quiet idle dot, and a parked dash renders the parked mark instead of a dot. The section body and its data pass never read phase.

**Rationale:** the `SessionPhaseDot` doctrine verbatim (its module comment is the spec): phase lives on per-card `codeSessionStore` snapshots that change on every transcript event; a row projection subscribed to that would wake the whole section per event. Liveness is not identity; the leaf is where they meet. First-resolvable-session is enough — the dot answers "is someone working this dash right now", not "who".

**Implications:** `SessionPhaseDot` itself is nearly reusable but keys on one session id; `DashPhaseDot` is the thin wrapper that picks the session and delegates. No new subscription machinery.

#### [P06] `/dash` — bind via CONTROL for an existing name, create via the shell route for a new one, shade for bare (DECIDED) {#p06-dash-gesture}

**Decision:** `/dash` joins `LOCAL_SLASH_COMMANDS` (`tugdeck/src/lib/slash-commands.ts`) with `takesArgs: true`, description "Work on a dash — bind this card to it, creating it if needed". The session card's `slashCommandSurfaces` map gains the `dash` handler:

- **`/dash <name>`, name matches an entry in this card's `changesController.getSnapshot().dashes`** (exact match on `display_name`): send `getConnection()?.sendControlFrame("bind_dash", { tug_session_id, project_dir, dash: name })` — the Phase 1 CONTROL verb (its payload shape is phase1-Spec S03). The `bind_dash_ok` broadcast updates the chip and the lane; `bind_dash_err` is surfaced by a new small handler in `action-dispatch.ts` routing to nothing card-specific — the surface raises no optimistic state, so the only UX need is a caution, delivered via the existing pane bulletin from the handler's card resolution (`cardIdForSession`); when no card resolves, `console.warn` suffices.
- **`/dash <name>`, no matching entry**: run the create through the card's shell route — `shellSessionStore.exec("tugutil dash create <name>")` — guarded exactly like `/shell` (inflight exchange → caution "A shell command is already running"). The shell row is the visible receipt; `run_create`'s unconditional auto-bind (via `TUG_SESSION_ID` → `POST /api/dash`) produces the `bind_dash_ok` that binds the card. The name is passed through unquoted after a conservative client-side check (`/^[A-Za-z0-9][A-Za-z0-9._-]*$/`); anything else gets a caution naming the constraint rather than a shell-quoting adventure — `tugutil` remains the real validator.
- **`/dash <name>` on an uncomposed snapshot** (`snap.composed === false`): caution `Still scanning this project — try again in a moment`, and do nothing else. Before the first aggregate emit the snapshot's project is the placeholder and `dashes` is empty, so *every* name misses the match and would fall to the create path — firing a git mutation on the strength of a snapshot that has not answered yet. The guard is one condition and it is the difference between "the name isn't a dash" and "we don't know yet".
- **Bare `/dash`, `snapshot.dashes` non-empty**: `shadeViewController.show("changes")` — the shade opens with the dash lane in view ([Q02]).
- **Bare `/dash`, no dashes**: caution bulletin `No dashes in this project — /dash <name> starts one`.
- Already bound to the named dash → re-binding is harmless (idempotent server-side); no special case.

**Rationale:** program-[P05] makes `/dash <name>` "create (if needed) + bind *this card*". The two paths use each thing for what it is: bind is a pure UI-concept write with a dedicated CONTROL verb — silent, no transcript ink; create is a git mutation — the shell route gives it a durable, visible receipt ([D111] shell rows), and reuses the auto-bind rather than duplicating it. Client-side resolution against the snapshot is exact and cheap (the same snapshot the lane renders).

**Why the match must happen client-side.** `bind_dash` **mints**: `dash_api::bind` calls `ensure_dash_id`, which writes `branch.tugdash/<name>.tugid` without ever checking that the branch exists — bind is a write-path verb by construction (phase1-[P02]). A CONTROL bind for a name that names no dash therefore *succeeds*, leaving the card wearing a chip for a dash that is not there. The snapshot match is what keeps that frame from ever being sent, which is why the uncomposed-snapshot guard above is part of the verb rather than a nicety.

**A mistyped name creates a dash.** That is `tugutil dash create`'s semantics and this gesture inherits it deliberately: `/dash` means "work on this dash, making it if needed", so there is no name it can refuse on the grounds of being unfamiliar. The shell receipt is what makes the outcome legible — the row says `Created dash '<name>'` in the transcript, where a surprised user can see it and `tugutil dash release` it.

**Implications:** the exhaustive `Record<LocalCommandName, …>` in `session-card.tsx` makes a missing surface a compile error, which is the wiring guarantee. Nothing else enumerates commands by hand: `slash-supported.ts` derives its supported-local set from `LOCAL_SLASH_COMMANDS`, and `help-content.ts` builds the `/help` Commands tab from the same array — the registry entry is the whole edit (see (#slash-surfaces)).

**[L30]: no command-table entry, on purpose.** `components/tugways/command-registry.ts` carries one `SLASH_BRIDGES` row per slash command that has a **native door** — a menu item, sometimes a chord. `/dash` gets none, following `/shell` and `/btw`, the two other arg-taking locals: a menu item cannot supply the `<name>` the verb exists to take, and a door that always fires the bare form would be a different command wearing this one's title. Bare `/dash` is reachable by typing it, which is the funnel local slash commands go through. If `/dash` later earns a picker (Phase 5), the picker is the thing that gets the table row.

#### [P07] `POST /api/dash` must broadcast too — the one Rust change this phase makes (DECIDED at implementation) {#p07-api-dash-broadcast}

**What was found:** (#context) asserts that `tugutil dash create`'s auto-bind produces a `bind_dash_ok` broadcast that "reaches every deck". It did not. Only the `bind_dash` CONTROL arm (`agent_supervisor.rs::do_bind_dash`) broadcast; the HTTP door (`server.rs::dash_handler`, which is what the CLI — and therefore `dash create`'s auto-bind — posts to) fired the aggregate bump and returned `200` without announcing anything. The two halves shared their ledger write (`dash_api::bind`) and nothing else, which is exactly how they came to disagree.

**Why it could not be deferred:** the chip, the fronted lane, and `/dash <new-name>`'s create path all read `CardSessionBinding.dash`, and that field moves on the broadcast alone — no bump, no snapshot, and no poll refreshes it. A CLI bind therefore left the card wearing nothing until a reload. Three of this phase's success criteria are unreachable without the announcement, and no view-layer arrangement can synthesize it.

**Decision:** the announcement is factored into two `pub(crate)` functions, `broadcast_bind_dash_ok` / `broadcast_unbind_dash_ok`, and **both** doors call them. No new frame, no new field, no schema change — the frames are Phase 1's, sent from one more place. It is a deviation from (#non-goals)'s "no Rust", recorded here rather than done quietly: the non-goal exists to stop the phase from *growing* a wire surface, and this makes an already-shipped one true.

**Pinned by:** `at0406-masthead-dash-chip.test.ts`, which binds and unbinds through the real CLI over the card's shell route and watches the chip appear and vanish — the exact loop that was broken.

---

### Deep Dives {#deep-dives}

#### Where each datum already lives (read this before writing any component) {#data-map}

- **Per-card dash slice:** `ChangesRouteController.getSnapshot().dashes` — already derived, reference-stable, subscribed via the controller's own `subscribe`/`getSnapshot` pair which `SessionChangesView` already uses. The controller subscribes to the `ChangesetAllStore` singleton; there is no per-workspace CHANGESET feed anymore.
- **Account-global dash set:** `useChangesetAll()` (`changeset-all-store.ts`) → `WorkspacesChangesetSnapshot.projects[].changesets` filtered on `kind === "dash"`. Project identity for disambiguation: `ProjectChangeset.display_name` / `project_dir` / `workspace_key`.
- **The card's own binding:** `cardSessionBindingStore.getBinding(cardId)?.dash` — `{ id, name }`, where `id` is the owner key that equals a lane entry's `owner_id` when they are the same incarnation.
- **Session → card:** `cardIdForSession(sessionId)` (one-shot) and `useCardIdForSession(sessionId)` (subscribed — required for offering a jump, per its own doc comment).
- **Session phase:** `useSessionPhase(sessionId)` (`lib/code-session-store/use-session-phase.ts`) — answers `idle` for unreachable sessions; safe for closed/external rows.
- **Golden fixture:** `tugdeck/src/__tests__/fixtures/workspaces-changeset-snapshot.golden.json` already carries a full dash entry (`owner_id: "tugdash/fix-join#1723500000000-a1b2c3"`, `stage: "draft-ready"`, `bound_sessions: [...]`, `round_subjects`, `draft`) — bun tests for projections deserialize this, not hand-built objects.

#### The range diff takes no pathspec {#range-diff-no-pathspec}

`fetch_dash_diff(repo_dir, worktree_rel, base, branch)` in `tugrust/crates/tugcast/src/feeds/git.rs` resolves the whole range (working tree vs `merge-base(base, branch)`) with no path narrowing, and the `range` `DiffDescriptor` flavor correspondingly has no `paths` field. Per-file diff expansion inside the dash lane is therefore not buildable without a server change — which this phase forbids. The lane's diff affordance is the one whole-range `PopOutDiffButton` (`descriptor-keyed Text-card reuse means re-clicks refresh the open card, [P20] of its home plan`).

#### How the shade opens programmatically {#shade-open}

`SessionChangesView` rides a passive TugSheet shade owned by the Session card; `shadeViewController.show("changes")` opens it, and opening fires `changesController.refresh()` for a fresh scan. The `/dash` bare-form handler calls exactly this — no new plumbing.

Two distinct entrances share that call, and bare `/dash` takes the second. `/commit` and ⌃⌘C reach it *indirectly*, through `commitModeController.enter()` and the card's effect on the mode's active flag — the shade comes up **in commit mode**, composer and Z5 swapped. The Z4A changes chip calls `show("changes")` **directly**, with no mode: the shade as a glance surface, which is what discovery wants and what [Q02] decided. The chip is the precedent to copy; note it also toggles (`getSnapshot() === "changes"` → `hide()`) where `/dash` only shows, because a typed verb asking to see something should not be the thing that hides it.

#### The masthead's geometry contract {#masthead-geometry}

`SessionMasthead` mounts `SessionIdentityRow` with list-row padding zeroed and each line told what to stop short of, because the pane's control cluster occupies the first band of the 72px tier. `TugSessionRow` renders a `slots` node inside the title line's content run (`.tug-session-row-slots`), i.e. within the width already reserved against the cluster — the reason [Q01] resolves by placement. The masthead never reflows: the chip must not change the tier's height (TugBadge at small size fits the line box; the app-test asserts the tier height is unchanged).

#### Lens section mechanics to copy, not re-derive {#lens-mechanics}

From `cards-section.tsx` (the model): register at boot from `main.tsx` (`registerCardsSection()` / `registerLayoutsSection()` calls, ~line 339 — add `registerDashesSection()` beside them, import at the top with its siblings); the body publishes `setSectionContent(host.focusGroup, { navigable, populated })` in `useLayoutEffect` with a cleanup that zeroes both; a list body publishes itself as the attached list via `setSectionAttachedList` only when filterable (Dashes is not — skip it); empty state is a `lens-section-empty` div reading "None"; `collapsedSummary` is a separate component sharing the body's data hook so the two cannot disagree. Registration order is the default section order; persisted orders tolerate new kinds (`resolveSectionRenderOrder`).

#### `bind_dash` from the deck {#bind-dash-send}

Phase 1 shipped the CONTROL arm (`agent_supervisor.rs::handle_control`, payload `{ tug_session_id, project_dir, dash }` where `dash` is the **name**; the server resolves the owner key via `ensure_dash_id` — bind is a write path) and the deck-side `bind_dash_ok`/`unbind_dash_ok` handlers in `action-dispatch.ts`. What is missing is only the send. Deck CONTROL sends go through `getConnection()?.sendControlFrame(action, payload)` (`connection-singleton.ts`; the pattern of `changeset-draft-store.ts`). The `tug_session_id` and `project_dir` come from `cardSessionBindingStore.getBinding(cardId)` — the same source the `/diff` surface uses. A `bind_dash_err { reason }` broadcast currently has no deck handler; step 4 adds a minimal one (see [P06]).

#### The `/dash` completion + help surfaces {#slash-surfaces}

**One edit, three surfaces.** Adding to `LOCAL_SLASH_COMMANDS` lists `/dash` in the composer's slash popup (`completion-providers/local-commands.ts` reads the registry), classifies it `supported-local` for [D14] (`lib/slash-supported.ts` builds its `SUPPORTED_LOCAL` set by mapping `LOCAL_SLASH_COMMANDS`), and gives it a row in the `/help` Commands tab (`lib/help-content.ts` seeds its built-in map from the same array, where the registry description outranks any catalog one). Do **not** hand-add `/dash` to either of those two files — they derive, and a second spelling is a second thing to drift.

The only place the description text is authored is the registry entry itself, which is why it should read as help copy. `src/__tests__/slash-commands.test.ts` and `lib/__tests__/slash-supported.test.ts` pin the derived lists; extend them rather than rewriting.

---

### Specification {#specification}

**Spec S01: Dash lane presentation** {#s01-dash-lane}

- Mount point: inside `session-changes-view-body`, after the `TugChangesList` block, before nothing (the lane is last). Rendered only when `snap.dashes.length > 0`.
- Fronted row (bound match, [P02]): section-line label `This card's dash`, then the dash row expanded.
- Folded group: one line `Dashes: <n>` (or `Also on this project: <n> dashes` when a fronted row exists above) with a `BlockFoldCue`; expanding reveals the remaining dash rows collapsed.
- Dash row, collapsed face: `TugBadge` name (`tinted`/`data`) · `base` · `<rounds> round(s)` · dirty mark (`· dirty` in caution tone when `worktree_dirty`) · stage word (muted; omitted when `stage` absent) · trailing `PopOutDiffButton` (range descriptor) when `rounds > 0 || worktree_dirty`.
- Dash row, expanded: `round_subjects` as a quiet list (newest first, as delivered); the `files` as `path — <git_status>` rows (display-only); the draft, when present, as a read-only block labeled `Join draft` rendering `draft.message` (pre-line whitespace, no editor, no Regenerate).
- `step_current`/`step_total`: when both present, ` · step i/N` after the stage word. Absent this era; the rendering ships dark.
- The lane's ref for the descriptor: `branch ?? "tugdash/" + display_name` (the documented older-sender fallback); `root` is `project.project_dir`; `worktree` and `base` from the entry verbatim.

**Spec S02: Lens Dashes section** {#s02-lens-dashes}

- Registry: `kind "dashes"`, title `Dashes`, glyph `GitBranch` (lucide, size 14 in the band like its siblings), `filterable` absent.
- Row (one per dash entry across all projects, ordered by project enumeration then entry order): `[DashPhaseDot | parked mark] <display_name> <stage> [· step i/N] [project disambiguator] [session jump chip(s)]`.
- Parked mark: a distinct quiet glyph (CSS-toned, not a pulsing dot) with hover title `Parked — no live session is working this dash`; used when `bound_sessions` is empty or absent.
- Session jump: for each `bound_sessions` id resolving through `useCardIdForSession` to an open card, a compact affordance activating `dispatchCommand("focus-session-card", { cardId })`; non-resolving ids render as muted inert text (count only if crowded: `+2 more`).
- Row activation (Enter/click on the row itself): when the dash has a resolvable mated card, front it (same as the jump); otherwise no-op.
- `collapsedSummary`: `"No dashes"` when zero; else `N dash(es)` + ` · M parked` when M > 0.
- Empty body: `lens-section-empty` "None".
- Keyboard: rows compose `TugListView` with `LENS_LIST_PRESENTATION`; the band publishes `navigable`/`populated` per (#lens-mechanics).

**Spec S03: `/dash` behavior table** {#s03-dash-verb}

| Invocation | Dash state | Behavior |
|---|---|---|
| `/dash <name>` | entry with `display_name === name` in this card's `snapshot.dashes` | CONTROL `bind_dash { tug_session_id, project_dir, dash: name }`; chip + lane update on `bind_dash_ok` |
| `/dash <name>` | no matching entry, snapshot composed | validate name shape; `shellSessionStore.exec("tugutil dash create <name>")`; auto-bind lands as `bind_dash_ok`. A name that is nobody's dash creates one — inherited from the CLI verb, receipt in the shell row |
| `/dash <name>` | snapshot not composed yet (`composed === false`) | caution `Still scanning this project — try again in a moment`; no CONTROL frame, no shell exec |
| `/dash <name>` | shell exchange inflight (create path only) | caution `A shell command is already running` |
| `/dash` | `snapshot.dashes.length > 0` | `shadeViewController.show("changes")` |
| `/dash` | no dashes | caution `No dashes in this project — /dash <name> starts one` |
| any | card not bound to a session/project (no binding record) | no-op (the `/diff` precedent: surfaces that need a binding return silently when the store has none) |

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Dash entries (lane + Lens) | server | `ChangesetAllStore` via existing controller / `useChangesetAll`; no new store | [L02] |
| Card's dash binding (chip, fronting, `/dash` payloads) | external | existing `cardSessionBindingStore` + `useSyncExternalStore` | [L02] |
| Lane fold / row expansion | view | React `useState` in `SessionChangesView`/lane, the `expandedKeys` precedent; ephemeral by design ([P02]) | — |
| Live indicator phase | external, leaf | `useSessionPhase` inside `DashPhaseDot` only ([P05]) | [L02], [L13] |
| Lens section fold/order | external (existing) | `lensStore` section machinery, untouched | [L02] |
| Chip / parked-mark appearance | DOM/CSS | data attributes + component CSS, never React state | [L06] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx` (+ `.css`) | the dash lane, Spec S01 |
| `tugdeck/src/components/lens/sections/dashes-section.tsx` (+ `.css`) | the Lens section, Spec S02, incl. `DashPhaseDot` |
| `tests/app-test/at04xx-changes-dash-lane.test.ts` | lane + fronting + chip app coverage |
| `tests/app-test/at04xx-lens-dashes-section.test.ts` | Lens section + jump app coverage |
| `tests/app-test/at04xx-dash-gesture.test.ts` | `/dash` bind/create/bare app coverage |

(`at04xx` = next free ids at authoring time; at0405+ as of this writing.)

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `SessionChangesDashLane` | component | new file above | props: `dashes`, `boundDashId: string \| null`, `project`; Spec S01 |
| dash-lane mount + `boundDashId` read | modify | `session-changes/session-changes-view.tsx` | reads `cardSessionBindingStore` via `useSyncExternalStore`; needs the `cardId` prop threaded (the view currently gets `projectDir`/controller/store only) |
| `SessionChangesViewProps.cardId` | prop | `session-changes-view.tsx` + its mount in `session-card.tsx` | for the binding read |
| dash chip (`slots`) | modify | `session-masthead.tsx` | [P03]; `data-slot="session-masthead-dash-chip"` |
| `registerDashesSection` | fn | `sections/dashes-section.tsx` | registered in `main.tsx` beside its siblings |
| `DashPhaseDot` | component | `sections/dashes-section.tsx` | [P05] leaf |
| `{ name: "dash", takesArgs: true }` | registry entry | `lib/slash-commands.ts` | [P06] |
| `dash:` surface handler | map entry | `cards/session-card.tsx` `slashCommandSurfaces` | Spec S03; compile-forced by the exhaustive `Record` |
| `bind_dash` send | glue | inside the `dash:` handler | `getConnection()?.sendControlFrame(...)` (#bind-dash-send) |
| `bind_dash_err` handler | registerAction | `src/action-dispatch.ts` | caution via resolved card / `console.warn` fallback |
| projection helpers (`dashRowsFromSnapshot`, summary counts) | pure fns | `sections/dashes-section.tsx` (exported) | bun-testable against the golden fixture |

---

### Documentation Plan {#documentation-plan}

- [ ] Module doc comments on the two new components state the perky-frog rule and the read-only phase boundary (no landing affordances until Phase 4).
- [ ] `slash-commands.ts` entry description for `/dash` — authored once, and the `/help` sheet's row derives from it ((#slash-surfaces)).
- [ ] The tuglaws doc (`dash-lifecycle.md`) remains **Phase 5**; no laws edits here. Design-decision entries, if any earn global status, wait for Phase 5's sweep.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (bun)** | lane ordering/fronting derivation; Lens projection + summary counts against the golden fixture; `/dash` registry match; name-shape validation | steps 1, 3, 4 |
| **App-test** | the real surfaces on a real repo: create a dash via `tugutil dash create` in the test project, then assert lane / chip / Lens / gesture behavior end-to-end | steps 1–4 |
| **Existing-suite guard** | `slash-commands.test.ts`, `slash-supported.test.ts`, `changes-route-controller.test.ts` keep passing (extended, not rewritten) | step 4 |

App-tests drive the real app on a real scratch repo (the "real, not fake" doctrine): the dash is created by shelling `tugutil dash create` inside the test project before/while the app runs, so the CHANGESET_ALL snapshot carries a genuine entry — no fixtures injected into stores. Every new test file carries `@covers` lines naming the source it exercises (`just app-test-covers-check` gates); note the changeset workspace is transient (~2s entries) only for *session* claim rows — dash entries derive from git refs and persist, so no timing dance is needed.

**Which `tugutil`, and from where — the two facts every dash app-test turns on.**

- **Creating** a dash is pure git and needs no session: any shell can run `tugutil dash create <name>` in the scratch repo. Invoke it by an **absolute path** to the built binary — `~/.local/bin/tugutil` is a symlink to main's build, which is the right code here (this phase ships no Rust and Phase 1 is merged to main) but is the wrong habit to write into a test.
- **Binding** is not. `tugutil dash bind|unbind` resolves the calling session from `TUG_SESSION_ID` and POSTs `/api/dash` to the live instance whose ledger **owns that session** — a harness-side Bash has neither the env nor an owned session, and the command exits with `no session — dash binding names the calling session`. Every in-app bind in these tests therefore goes through the **card's `$` shell route**, which is what stamps `TUG_SESSION_ID` on the child (shipped `dc9263805`), or through `/dash` once #step-4 lands. The instance loop is ownership-checked, so a release Tug running alongside the test instance cannot swallow the bind.

#### What stays out of tests {#test-non-goals}

- Fake-DOM/RTL render tests and mock-store assertions — banned project-wide.
- Landing flows (join/release) — Phase 4 owns them; nothing here may touch them even "just to check".
- Screenshot pixel-diffing beyond the [Q01]/[R01] visual confirmation — the chip's aesthetics are reviewed once at implementation, pinned structurally (slot presence, tier height) not pictorially.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Applies to every step.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Changes dash lane | done | `95effa736` |
| #step-2 | Masthead dash chip | done | `2c32b01c7` |
| #step-3 | Lens Dashes section | done | `4834722d3` |
| #step-4 | `/dash` gesture | done | `df9132bdb` |
| #step-5 | Integration checkpoint | done | `6f2bb686f` |

#### Step 1: Changes dash lane {#step-1}

**Commit:** `session-changes(dash-lane): render the dash lane in dash grammar — bound fronts, others fold [L02][L06][L19]`

**References:** [P01], [P02], Spec S01, (#data-map), (#range-diff-no-pathspec), (#shade-open)

**Tasks:**
- [ ] Create `session-changes-dash-lane.tsx` + `.css` per Spec S01, composing `BlockStrip`/`TugBadge`/`BlockFoldCue`/`PopOutDiffButton` — no hand-rolled chrome.
- [ ] Thread `cardId` into `SessionChangesViewProps` from its mount in `session-card.tsx`; read the binding's `dash?.id` via `useSyncExternalStore` on `cardSessionBindingStore`; pass `boundDashId` + `snap.dashes` + `snap.project` to the lane.
- [ ] Export the pure fronting/ordering helper (bound entry first by `owner_id` match, rest in snapshot order) for the bun test.
- [ ] Keep the shade header's fold-all/pop-out acting on head entries only; the lane owns its own fold.

**Tests:**
- [ ] bun: fronting helper against the golden fixture (bound id fronts; unknown id folds all; empty dashes renders nothing).
- [ ] App-test (`at04xx-changes-dash-lane.test.ts`, `@covers` the lane + view): create a dash with a round in the scratch repo; open the shade; assert the dash row's name/base/rounds ink, the read-only draft block when a draft row exists, the range pop-out button presence, and that no claim/disclaim affordances exist inside the lane.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] `just app-test tests/app-test/at04xx-changes-dash-lane.test.ts`

---

#### Step 2: Masthead dash chip {#step-2}

**Depends on:** (none for the code — parallel to #step-1. The *test* needs a way to bind from inside the app, which the card's `$` shell route already provides; it does not wait on #step-4's `/dash`.)

**Commit:** `session-masthead(dash-chip): the bound dash's name as a TugBadge on the title line [L02][L06][L19][L20]`

**References:** [P03], [Q01], Risk R01, (#masthead-geometry)

**Tasks:**
- [ ] In `session-masthead.tsx`, widen the existing `cardSessionBindingStore` subscription to also select the `dash` binding (one selector returning both facts, or a second `useSyncExternalStore` — keep the snapshot reference-stable).
- [ ] Pass `slots={<TugBadge emphasis="tinted" role="data" data-slot="session-masthead-dash-chip" title={...}>{dash.name}</TugBadge>}` when bound; nothing when not.
- [ ] CSS: cap the chip's width so a long name elides inside its own border; assert no tier-height change.

**Tests:**
- [ ] App-test (rides `at04xx-changes-dash-lane.test.ts` or its own file, `@covers session-masthead.tsx`): with the dash already created, type `$ tugutil dash bind <name>` into the card's **shell route** — the route stamps `TUG_SESSION_ID`, which is what makes the bind resolvable at all (see (#test-categories)) — and the chip appears with the dash name; `$ tugutil dash unbind` and it is gone. Both without reload: the `bind_dash_ok` / `unbind_dash_ok` broadcasts drive it. Masthead tier height unchanged; screenshot captured for the [R01] review.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] the step's app-test file green

---

#### Step 3: Lens Dashes section {#step-3}

**Commit:** `lens(dashes-section): one row per inflight dash — stage, parked mark, mated-session jump [L02][L03][L06][L13]`

**References:** [P04], [P05], Spec S02, (#lens-mechanics), (#data-map)

**Tasks:**
- [ ] Create `sections/dashes-section.tsx` + `.css`: exported pure projection (`dashRowsFromSnapshot(snapshot): DashRow[]` + summary counts), the `TugListView` body, `DashPhaseDot`, the parked mark, the project disambiguator, `collapsedSummary`, `registerDashesSection`.
- [ ] Register in `main.tsx` beside `registerCardsSection()` / `registerLayoutsSection()`.
- [ ] Publish `setSectionContent` navigable/populated in `useLayoutEffect` with cleanup ([L03]).
- [ ] Jump affordance dispatches `focus-session-card` with the resolved card id; unresolvable sessions render inert.

**Tests:**
- [ ] bun: projection + summary against the golden fixture (one row, `draft-ready` stage, one bound session; a synthesized parked entry counts into `· 1 parked`); extend `lens-section-registry.test.ts` if it enumerates kinds.
- [ ] App-test (`at04xx-lens-dashes-section.test.ts`, `@covers dashes-section.tsx`): with a real dash + bound session card, the section shows the row with name and stage; activating the jump fronts the session card (the `focus-session-card` flash/raise observable); with the binding removed, the parked mark appears.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] the step's app-test file green

---

#### Step 4: `/dash` gesture {#step-4}

**Depends on:** #step-1 (bare `/dash` opens the shade whose lane must exist; bind feedback is the chip/lane)

**Commit:** `session-card(/dash): bind an existing dash over CONTROL, create a new one over the shell route [L11][L30][D111]`

**References:** [P06], Spec S03, (#bind-dash-send), (#slash-surfaces), (#shade-open), program-[P05]

**Tasks:**
- [ ] Registry entry in `lib/slash-commands.ts` — the only enumeration edit; `slash-supported.ts` and `help-content.ts` derive from it ((#slash-surfaces)). No `command-registry.ts` row, per [P06]'s [L30] note.
- [ ] `dash:` handler in `slashCommandSurfaces` per Spec S03, including the name-shape validation and all three guards (missing binding → silent no-op; uncomposed snapshot → caution, no mutation; busy shell on the create path → caution).
- [ ] `bind_dash_err` handler in `action-dispatch.ts` (caution on the resolved card; warn otherwise).

**Tests:**
- [ ] bun: `matchLocalSlashCommand("/dash x")` and bare `/dash` resolve; `slashSupport("dash") === "supported-local"` falls out of the registry entry with no second edit; name validation accepts `fix-join`/`a.b_c`, rejects spaces/leading `-`; existing enumeration tests updated.
- [ ] App-test (`at04xx-dash-gesture.test.ts`, `@covers slash-commands.ts + the session-card handler`): `/dash <existing>` typed into the composer binds (chip appears, no shell row); `/dash <new>` produces the shell receipt row and ends bound; bare `/dash` opens the Changes shade; bare `/dash` in a dash-less project raises the caution bulletin.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] the step's app-test file green

---

#### Step 5: Integration checkpoint {#step-5}

**Depends on:** #step-1, #step-2, #step-3, #step-4

**Commit:** none (verification only; record results in this ledger)

**References:** (#success-criteria), the program plan's phase bar

**Tasks:**
- [ ] Full gates: `cd tugrust && cargo nextest run` (nothing should have moved; the gate stands), `cd tugdeck && bun test && bunx vite build`, `just app-test-changed`.
- [ ] Walk the lifecycle visually on a scratch project: create → lane appears folded → `/dash` binds → chip + fronted lane → Lens row live-dot while the session works → close the card → parked mark. Note the walk's outcome in this file the way Phase 1's (#lifecycle-walk-result) did.

**Checkpoint:**
- [x] every gate green; walk recorded; Step Status Ledger fully `done` with commit hashes.

##### Lifecycle walk — result {#lifecycle-walk-result}

The walk is **driven**, not eyeballed: every leg of it is an assertion in one of the four new app-tests, against a dash the real CLI made in a real repo. Each leg, and what drives it:

| Leg | Driven by |
|---|---|
| create → the lane exists and everything is folded away | at0405 — the lane mounts, zero rows visible, the fold cue offers `Dashes: N` |
| expand → the row reads in dash grammar | at0405 — `at0405-lane · main · 1 round · working`, one range pop-out, and **zero** claim/disclaim/hunk affordances anywhere in the lane |
| expand the row → rounds, files, and the maintained draft as read-only ink | at0405 — the round subject, the range-diff file, `Join draft` with its message, and no editor element in the row |
| bind → the dash fronts, expanded, under "This card's dash" | at0405 — the fronted label appears and the bound dash is row 0 with `data-expanded="true"` |
| bind → the chip appears in the masthead, live | at0406 — `tugutil dash bind` through the card's `$` shell route; the chip arrives on the broadcast with no reload, inside the title line's slot, tier height unchanged |
| unbind → the chip goes away | at0406 — same route, chip gone, tier height still unchanged |
| the Lens row while nobody is working it | at0407 — the parked mark, `data-parked="true"`, no jump |
| the Lens row while a session works it | at0407 — the mark becomes a phase dot and a jump chip appears |
| the jump fronts the mated card | at0407 — the Lens is the active card, the click makes it `A` |
| the last worker walks away → parked again | at0407 — `dash unbind`, the mark returns and the jump goes |
| `/dash <existing>` binds with no shell noise | at0408 — the chip arrives and the transcript holds **zero** shell rows |
| `/dash <new>` creates, with a receipt, and ends bound | at0408 — the shell row shows `tugutil dash create at0408-made`, and the chip follows from `dash create`'s own auto-bind |
| a name that could not survive a shell is refused | at0408 — the caution names the constraint and no command runs |
| bare `/dash` opens the Changes shade | at0408 |

**The one visual review** ([Q01] / [R01]) was done from at0406's screenshot: the chip sits at the trailing end of the title line, inside the reserved content box, clear of the pane's control cluster. It reads as a trailing category label rather than as part of the callsign. Note for a future pass, not a defect: `role="data"` paints it in the data hue, which is the loudest the chip could reasonably be — if it ever wants to be quieter, that is a one-token CSS change and touches no React ([L06]).

**Gates at phase end.** `cargo nextest run` 2396 pass · `bun test` 6561 pass · `bunx tsc --noEmit` clean · `bunx vite build` clean · the whole derived app-test selection for this branch (41 files) green · the ~20-file core tier green (`main.tsx` moved, so the advisory applied).

Two things the run turned up that are worth carrying forward:

- **at0209 and the core tier.** `at0209-text-card-live-autosave` timed out waiting for `window.__tug` under the 16-way parallel core-tier run and passed on its own in 12s. Launch contention, the known class — not a regression, and nothing this phase touched.
- **The dash fixtures had to become lock-tolerant.** All four new tests drive the same git repository and the harness runs them in parallel, so two `tugutil dash create`s in flight collide on `index.lock`. `tests/app-test/dash-fixture.ts` is the shared fixture, and every git-touching verb in it retries through a held lock; the four files then run green together.

---

### Deliverables and Checkpoints {#deliverables}

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- All five ledger rows `done`; the success criteria in (#success-criteria) each demonstrably true.
- Zero landing-path changes: `changeset_join` / `changeset_release` senders still absent from the deck; the lane offers no mutating dash verb.
- The Phase 2 contract to Phase 4 is in place: the dash lane exists for join mode to build its presentation on, and the `/dash`→bind→chip loop is the binding UX join mode assumes.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- Phase 3 (step verbs) lights up the ` · step i/N` ink this phase ships dark.
- Phase 4 (join mode) adds the landing affordances to the lane and the `/join` composer mode.
- Phase 5 adds the multi-dash picker, parked-dash adopt/release, and the `tuglaws/dash-lifecycle.md` doctrine document.
