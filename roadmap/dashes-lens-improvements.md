<!-- devise-skeleton v5 -->

## Parked Dashes — the Lens section becomes the inbox of unattended work {#parked-dashes}

**Purpose:** Turn the Lens's `Dashes` section from a roster that duplicates what the Cards section already says into **Parked Dashes** — a section that holds only dashes no live session is working, disappears entirely when there are none, and carries the two verbs (Adopt, Release) that let a reader act on what it shows.

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

**Round 1 — 2026-08-17, Opus 5.** Reviewed `plan:d9e027d206fea191`. Reviewed `plan:<hash>`. Lint: 1 error, 1 warning (both fixed — PL020 fired on a Tests block that named a banned fake-DOM shape even while disclaiming it; the test was replaced with one that can actually fail, and PL023 is this record).
Oriented on: the codebase, since this is the plan's first round and there is no prior document to diff.

Applied, on the **holes and pitfalls** axis: the plan's largest omission was that *both* new verbs destroy the surface hosting them — Adopt and Release each remove their row, and on the last parked dash they remove the whole section, which is the **success** path rather than an edge case. Any local pending or error state would have reported into an unmounted component. Recorded as Risk R03 with two mitigations grounded in shipping code: Adopt reports nothing locally and lets the card-level `dash-bind-error-store` carry a refusal, and Release's confirm anchors to the row element — the construction `session-changes-dash-lane.tsx` already documents for exactly this hazard. Risk R04 covers the sibling case, the keyboard cursor resting inside a section that vanishes, and Step 7 gained an assertion for it.

Applied, on **technical choices**: reading `draft_engine.rs` turned up a *second, independent* parser of `dash-log.md` that keeps every non-empty `<note>` as a draft-authoring instruction. The new `created` marker would have entered that corpus as an instruction the user never gave. [P06] and Step 1 now state that the empty note is load-bearing rather than incidental, Step 1 gained a survey task naming every known reader of the file (including the `base_motion.rs` assertion, which is a substring check and therefore safe), and consolidating the two parsers is recorded as a follow-on.

Applied, on **sequencing**: Step 4 created `formatDashAge` and never called it — the ordering sorts on raw ISO-8601 UTC strings ([P07]) and has no use for a formatted age. Moved to Step 5, where it is first rendered, with the reason stated in the task.

**Tuglaws cross-check.** [L02] — honored: presence is a module store read through `useSyncExternalStore`, and the row set is a `useMemo` over the existing aggregate rather than a new store. [L03] — honored: the probe publishes in a `useLayoutEffect`, which is required because `LensContent`'s group order and spatial order are computed from presence and must be right before the first key event. [L06] — honored: the parked mark, review tint, and stage tone are CSS over `data-*` attributes; nothing about appearance enters React state. [L19] — honored: the row stays `TugListRow` inside `TugListView`. [L31] — this is the law the plan exists to repay: the current `onActivate` is a guaranteed silent no-op on parked rows, and [P09]/[P10] replace it with a named press that either binds or states its reason. [L11] — the previous `focus-session-card` dispatch is deleted along with the dead card-walk, so the section no longer reaches at cards at all. The State Zone Mapping covers every piece of state introduced, and no zone is carried by the wrong mechanism.

Not changed, deliberately: [P03] overturns a documented invariant ("every registered section always renders"). That is the point of the plan rather than an oversight, it is opt-in per section, and the Documentation Plan requires the contradicting docblocks be rewritten rather than left lying.

Deferred: [Q01], which session Adopt targets when the followed card is not eligible but another open card is. Shipping the followed-card-only rule makes the refusal self-reporting, and the follow-on that opens a session on the dash's project is where both belong.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Lens has two surfaces that talk about dashes, and today they say the same thing. The **Cards** section is keyed by open card: a session row carries `#<dash>` in its identity run and, beneath, a dash line reading `<stage> · step i/N · <step title> · [review mark]`. The **Dashes** section is keyed by dash owner key and renders — through the *same* component, `DashFactsRun` in `tugdeck/src/components/lens/sections/dash-facts.tsx` — name, stage, steps, step title, review mark. For any dash somebody is working, those two rows are the same facts projected from the same snapshot (`ChangesetAllStore`, feed `0x24`). That is not near-duplication; it is one component rendered twice.

The duplication got worse, not better, with commit `dd12c93cf`. Before it, the Dashes section was the only place a dash's name reliably appeared; now `TugSessionIdentity` carries `#<dash>` unconditionally (the `dashRun` prop was deleted outright so no surface can suppress it), and the roster lost its last exclusive fact.

Meanwhile the section is weak exactly where it is unique. Its own docblock argues it "cannot be dropped" because "a **parked** dash has no session to nest under" — and that is true and load-bearing: `bound_sessions` is read live-sessions-only (`bound_sessions_for` in `tugrust/crates/tugdash-core/src/ops.rs`), so a dash whose cards have all closed has no row in Cards and no row anywhere else. But the section serves that case badly. It is read-only by design, so it can tell you a dash needs attention and offers no way to act on it. Its `onActivate` walks `row.boundSessions` looking for a card via `cardIdForSession` — which for a parked dash is an empty array, so activation is a **guaranteed silent no-op on precisely the rows that justify the section**, a standing [L31] violation. And because every registered section always renders, the everyday reading is a permanent two-band `Dashes / None` occupying rail height that says nothing.

This plan resolves both halves with one rule: **a dash appears in the Lens exactly once.** Worked ⇒ its session's row in Cards. Unworked ⇒ Parked Dashes. The two surfaces partition the dash universe, and the section earns its band by holding only what no session row can hold.

#### Strategy {#strategy}

- **Backend first, UI second.** The age fact the inbox turns on (`last_activity`) does not exist yet; it is a small read off a timestamp `split_log_line` currently discards. Land it through Rust → wire → TypeScript types before any component changes, so the UI steps never block on a missing field.
- **Generalize the registry minimally.** Hiding a section is a new capability that contradicts a documented invariant ("Every registered section renders — the Lens has no hidden sections"). Introduce it as one opt-in hook plus one small store, and fix the reorder bug it would otherwise create ([P04], [P05]).
- **Reuse the verb contracts that already work.** Adopt is the `bind_dash` CONTROL frame the Changes shade's lane already sends; Release is `useChangesetRelease`. No new wire messages, no second binding path.
- **Delete more than is added.** The phase dot branch, the worked/parked ordering clause, the project-label disambiguation conditional, the dead card-walk activation, and the docblock essay explaining why the duplication is not duplication all come out.
- **Pin the partition law with one app-test round trip.** Bind ⇒ the section is gone; unbind ⇒ it is back with the row. That single assertion falsifies the whole premise if it breaks.

#### Success Criteria (Measurable) {#success-criteria}

- With every dash in the repository bound to a live session, the Lens renders **no** `[data-lens-section="dashes"]` element at all — band included (app-test asserts `querySelector` is `null`, not merely that the body is empty).
- With a dash bound to no session, the section renders exactly one row for it, and that row's text contains `#<name>` (app-test).
- No dash is ever in both sections at once: for every dash in the aggregate, `boundSessions.length === 0` XOR a Cards row carries its dash line (unit test over `dashRowsFromSnapshot` plus the app-test round trip).
- Pressing Adopt on a Parked row with an eligible session card binds it, and within one aggregate beat the row leaves the section and the session's Cards row grows the dash line (app-test).
- Pressing Adopt with no eligible card produces a *stated reason* and never a silent no-op — the control is disabled with a reachable tooltip ([L31]).
- `tugutil dash status <name>` prints a `Last activity:` line for a dash with any dash-log record (CLI integration test).
- `cd tugrust && cargo nextest run` passes; `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build` all clean.

#### Scope {#scope}

1. A `last_activity` fact carried from the dash-log through `DashDetail` / `DashStatus` / the CHANGESET wire into `DashChangesetEntry`, plus a `created` dash-log marker so every new dash has a birth timestamp.
2. A `presence` capability on the Lens section registry, with the store and the reorder-order merge that make a hidden section safe.
3. The Dashes section's projection narrowed to parked-only, re-ordered, re-summarized, and re-titled **Parked Dashes**.
4. A new row anatomy: sigil'd name, step counters + title, and a trailing metadata run of stage · age · project · review.
5. Adopt and Release verbs on the row, both refusing with reachable reasons.
6. Unit tests for every pure function introduced, and one app-test pinning the partition law and the Adopt round trip.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Creating a session card from the Parked section.** When Adopt has no eligible target it refuses with a reason ([P09]); wiring session creation into the Lens is a follow-on.
- **Changing the Cards section's dash line.** It ships as commit `dd12c93cf` left it.
- **A ticking clock for the age chip.** Ages re-read at render only ([P08]).
- **Reordering or restyling any other Lens section**, beyond the flex share they inherit when Parked Dashes is absent.
- **Landing/join gestures from the Lens.** Join stays the Session card composer's; this section never lands anything.
- **The `landing`-stage parked dash getting special chrome.** It sorts to the top ([P07]) and is otherwise an ordinary row.

#### Dependencies / Prerequisites {#dependencies}

- Commit `dd12c93cf` (identity always carries `#dash`; `step_title` pipe from dash-log to wire) — already on `main`.
- `tugutil dash bind` / `unbind` and the `bind_dash` / `unbind_dash` CONTROL frames, as used by `session-changes-view.tsx`.
- The `ChangesetAllStore` account-global aggregate (feed `0x24`) and `dash-session-index.ts`.
- App-test fixture helpers `createDash` / `releaseDash` / `tugutilPath` in `tests/app-test/dash-fixture.ts`.

#### Constraints {#constraints}

- **Warnings are errors** in the Rust workspace (`tugrust/.cargo/config.toml` sets `-D warnings`).
- **`[L02]`** — every store reaches React through `useSyncExternalStore`; the presence store is no exception.
- **`[L06]`** — the row's appearance (parked mark, review tint, stage tone) is CSS on DOM attributes, never React state.
- **`[L03]`** — anything the keyboard walk depends on registers in a `useLayoutEffect`, before the first key event.
- **`[L19]`** — rows compose `TugListView` / `TugListRow`; no hand-rolled list focus.
- **`[L31]`** — a refused gesture produces the act or a visible reason; never a quiet early return.
- The `kind` string `"dashes"` is persisted in `lensStore`'s `sectionOrder` / `collapsedSections` and is the `data-lens-section` test hook — it must not change ([P02]).
- `dash_detail_entries_in` is a **pure read path** ([P02] of the dash ops module): it resolves owner keys and must never mint or write git config. New reads added there must stay reads.

#### Assumptions {#assumptions}

- Dash-log timestamps are ISO-8601 **UTC** (`now_iso8601` in `tugrust/crates/tugutil-core/src/session.rs` renders `SystemTime::now()` as UTC), so they are both lexically sortable and `Date.parse`-able without timezone handling.
- A parked dash is rare enough that the section is usually absent, which is what makes hide-when-empty the dominant everyday win.
- Dashes created before this plan lands have no `created` marker; their `last_activity` is absent and the row simply omits the age chip ([P06]).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings and rich `**References:**` lines. Plan-local decisions are `[P01]`…; `[D##]` is reserved for the global `tuglaws/design-decisions.md`. Laws are cited as `[L02]` etc. from `tuglaws/tuglaws.md`. No step cites a line number.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Which session a Parked row's Adopt targets when several are eligible (DEFERRED) {#q01-adopt-target-ambiguity}

**Question:** The Adopt ladder targets the Lens's *followed card* — the last non-Lens key card ([P09]). If that card's project does not own the dash, but some other open card's project does, should Adopt reach past the followed card to that one?

**Why it matters:** Reaching past it makes Adopt succeed more often; it also makes the destination invisible, so a press could bind a dash into a card the reader was not looking at. Refusing is safe but occasionally annoying.

**Options (if known):**
- Followed card only, refuse otherwise (this plan's behavior).
- Followed card, then the single other eligible card if there is exactly one.
- Followed card, then a disambiguating menu.

**Plan to resolve:** Ship the followed-card-only rule and see whether the refusal actually fires in practice. The refusal sentence names the project, so a real occurrence is self-reporting.

**Resolution:** DEFERRED — revisited after the section has been lived with; the follow-on that opens a session on the dash's project (#roadmap) is the natural place to settle it, since both concern "there is no card for this."

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| A hidden section desynchronizes drag-reorder indices | med | high without fix | `mergeHiddenIntoOrder` + unit table ([P05]) | any reorder bug report |
| Presence latch: a hidden body can never re-publish | high | certain if naive | presence is published by an always-mounted probe, never by the body ([P04]) | section stuck hidden |
| The section vanishes under the keyboard cursor | med | med | seed/group-order recompute on the presence key; focus falls to the previous section | ring lands on nothing |
| `created` marker changes stage derivation | high | low | `read_declarations` matches markers explicitly and ignores unknown ones via `_ => {}` ([P06]) | any stage test flips |
| A verb destroys the surface hosting it | high | certain on the last row | verbs report through card-level surfaces, never row-level ones (Risk R03) | any silent Adopt/Release |
| Age reads stale without a ticker | low | med | day/hour granularity; aggregate recompute re-renders ([P08]) | users ask for live ages |

**Risk R01: The presence latch** {#r01-presence-latch}

- **Risk:** If hiding were driven off `sectionIsPopulated` — the fact the section *body* publishes in `lens-section-content.ts` — then hiding the section would unmount the body, whose cleanup publishes `populated: false`, and nothing would ever publish `true` again. The section would hide once and stay hidden forever.
- **Mitigation:**
  - Presence is a **separate** fact in a **separate** store, published by a probe component that renders `null` and is mounted for every registered kind regardless of visibility ([P04]).
  - `sectionIsPresent` defaults to `true` for an unknown kind, so a section is never hidden by absence of information.
- **Residual risk:** The probe subscribes to the aggregate even while the section is hidden — one extra `useChangesetAll` consumer. That is the cost of the fact being knowable at all, and it is memoized on snapshot identity.

**Risk R02: Reorder indices over a hidden section** {#r02-reorder-indices}

- **Risk:** `useBlockReorder` in `lens-content.tsx` takes `getVisibleOrder` from `resolveSectionRenderOrder` over the whole registry. With a section hidden, the visible DOM bands and that array disagree, so a drag computes the wrong drop index and `commit` would also silently drop the hidden kind out of the persisted order.
- **Mitigation:**
  - `getVisibleOrder` filters by presence, so indices match the DOM.
  - `commit` runs the new visible order back through `mergeHiddenIntoOrder`, which re-inserts each absent kind at the index it held in the full resolved order ([P05]).
- **Residual risk:** A hidden section's persisted position is preserved but not *meaningful* — if it reappears it sits where it was, which is the least surprising answer available.

**Risk R03: A verb that destroys its own surface** {#r03-verb-destroys-surface}

- **Risk:** Both verbs remove the row they are pressed on, and on the last parked dash they remove the whole section ([P03]). A control that reports its outcome *in the row* — a pending spinner, an error state, a confirm popover anchored to the row — therefore reports it into a component that has already unmounted. `session-changes-dash-lane.tsx`'s docblock records the same hazard from the other direction: it anchors its confirm popover to the **row element and never the button**, because "a button inside a hover-revealed cluster can unmount under its own popover."
  This is not the ordinary case; it is the *success* case. Success is exactly when the row goes away.
- **Mitigation:**
  - **Adopt reports nothing locally.** It fires `bind_dash` and returns. Success is legible as the row leaving; failure arrives on the existing `dash-bind-error-store` → `dash-bind-error-notice-controller` surface, which is card-level and outlives the row. No pending state, no local error slot ([P09]).
  - **Release's confirm anchors to the row element**, matching the lane's documented construction, and its outcome is read from `useChangesetRelease`'s store — which is keyed by entry and lives above this section, so a resolved release has somewhere to land even with the section gone.
  - Neither verb is on row activation ([P10]), so neither can fire from a cursor move as the list recomposes underneath it.
- **Residual risk:** A release that fails *after* the aggregate already dropped the dash would have no row to explain itself on. That ordering is not reachable today — the aggregate only drops a dash once the release succeeded — but it is the shape to watch if release ever becomes optimistic.

**Risk R04: The keyboard cursor when the section vanishes** {#r04-cursor-on-vanish}

- **Risk:** Adopting or releasing the last parked dash unmounts the section while the movement cursor is inside it. A placement on a focus key that no longer mounts arms a late-mount resume, which could yank focus back minutes later when an unrelated dash goes parked.
- **Mitigation:** The section's body already publishes `{navigable: false}` on unmount, and `LensContent` recomputes `shapeKey` / `setGroupOrder` / the seed from the visible order in the same commit ([P05]). Step 6 verifies the cursor lands on the preceding section rather than arming a resume.
- **Residual risk:** With Parked Dashes as the *first* section and every other section empty, there is nowhere for the cursor to go; it rests on the Lens root, which is the existing behavior for an empty Lens.

---

### Design Decisions {#design-decisions}

#### [P01] A dash appears in the Lens exactly once (DECIDED) {#p01-partition-law}

**Decision:** Membership in the Parked Dashes section is exactly `bound_sessions.length === 0`. A dash any live session is working is never in this section; a dash no live session is working is never anywhere else in the Lens.

**Rationale:**
- The Cards section is authoritative for worked dashes: it shows the same `DashFactsRun`, under a phase dot that says someone is on it, inside the row of the session doing the work. A second copy adds no fact.
- The parked case is the one Cards structurally cannot represent, because Cards is keyed by open card and a parked dash has none.
- Stated as a partition, the rule is falsifiable in a test rather than a matter of taste.

**Implications:**
- Membership is *not* a curated set of "interesting" stages. A parked `landing` dash is in because it is parked, not because `landing` is dramatic; a worked `landing` dash is out for the same reason.
- `DashRow.parked` and the worked-before-parked clause of `compareDashRows` both become dead and are deleted.
- The section can be empty in the common case, which is what forces [P03].

#### [P02] The section keeps `kind: "dashes"` and changes only its title (DECIDED) {#p02-kind-stays}

**Decision:** The registered `kind` stays the string `"dashes"`. The band `title` becomes `"Parked Dashes"`.

**Rationale:**
- `kind` is persisted: `lensStore` stores it in `sectionOrder` and `collapsedSections`. Changing it would silently reset every user's section order and re-expand a section they had collapsed.
- `kind` is also the test hook — `data-lens-section="dashes"`, and the `lens-dashes-*` class prefix and `data-slot` names throughout `dashes-section.css` / `dash-facts.tsx`.
- Nothing user-facing reads `kind`; the title is what a person sees.

**Implications:**
- Existing selectors in `tests/app-test/at0424-lens-dash-line.test.ts` and the section's unit tests keep working.
- The filter placeholder derives from `def.title`, so it becomes "Filter Parked Dashes" for free.

#### [P03] An empty Parked Dashes section renders nothing at all (DECIDED) {#p03-hide-when-empty}

**Decision:** When the section holds no rows, the Lens renders no band, no body, and no DOM for it. This intentionally overturns the invariant documented in `lens-content.tsx` and `lens-section-registry.ts` that "every registered section always renders".

**Rationale:**
- Under [P01] the everyday state is zero parked dashes. A permanent `Dashes / None` band is rail height spent on the absence of work.
- An inbox at zero should cost zero. Every row that *is* there is implicitly a to-do, which is what lets an always-mounted section earn its band when it has content.
- The invariant it overturns was written when no section could be empty in the normal case; it was a description of the section set, not a principle.

**Implications:**
- The old invariant's sentences in both docblocks must be rewritten, not left contradicting the code.
- Only sections that opt in via `presence` can vanish; every other section's behavior is unchanged, so the change is additive.
- The keyboard walk, the group order, the spatial order, the ⌘L seed, and the drag-reorder all read the *visible* order ([P05]).

#### [P04] Presence is published by an always-mounted probe, in its own store (DECIDED) {#p04-presence-probe}

**Decision:** `LensSectionDefinition` gains an optional `presence?: (host: LensSectionHost) => boolean` hook. `LensContent` mounts one `LensSectionPresenceProbe` per **registered** kind — unconditionally, whether or not that section is visible — which calls the hook and publishes into a new module store `lens-section-presence.ts`. The probe renders `null`.

**Rationale:**
- Presence cannot be read off `sectionIsPopulated`: that fact is published by the section *body*, and a hidden section has no body, so hiding would latch permanently (Risk R01).
- A probe is the smallest thing that can hold a subscription independent of what it makes visible, and it follows the precedent already in the file — `LensSectionSlot` exists so that a section factory "may use hooks" inside its own component boundary.
- A separate store keeps the two facts honest: `populated` gates the band's filter field, `present` gates the band's existence. Merging them would give one value two owners.

**Implications:**
- `sectionIsPresent(kind)` returns `true` for any kind that has never published — a section is never hidden by missing information.
- The probe for Parked Dashes calls the same projection the body does; both go through `useChangesetAll`, which is `WeakMap`-memoized on snapshot identity, so the second consumer costs a map lookup.
- Rules of hooks hold: each probe is keyed by `kind`, and `def.presence` for a given kind is fixed at registration, so a probe instance's hook sequence never varies.

#### [P05] The visible order drives the walk; hidden kinds are merged back on commit (DECIDED) {#p05-visible-order}

**Decision:** `LensContent` derives `visibleOrder = resolveSectionRenderOrder(...).filter(sectionIsPresent)` and uses it for the rendered map, `shapeKey`, `setGroupOrder`, `registerSpatialOrder`, the ⌘L seed search, and `useBlockReorder`'s `getVisibleOrder`. On drop, `commit` runs the new visible order through a new pure function `mergeHiddenIntoOrder(fullOrder, newVisibleOrder)` before writing `lensStore.setSectionOrder`.

**Rationale:**
- The reorder computes a drop index by comparing pointer position against the rendered bands, so its order array must be the rendered one or every drop lands wrong (Risk R02).
- The persisted order must keep hidden kinds, or a section would lose its place the first time someone dragged another one while it was empty.
- Extracting the merge as a pure exported function makes it a unit table rather than a DOM test.

**Implications:**
- `mergeHiddenIntoOrder` re-inserts each hidden kind at the index it held in `fullOrder`, processing hidden kinds in ascending original index. Deterministic, and idempotent when nothing is hidden.
- `resolveSectionRenderOrder` is unchanged — it still answers "all registered kinds in order"; filtering is the caller's.

#### [P06] Every dash gets a birth record; `last_activity` is the dash-log's newest line (DECIDED) {#p06-last-activity}

**Decision:** `ops::create` appends a `created` line to the dash-log on the path that actually creates a dash. `DashDeclarations` gains `last_activity: Option<String>`, set to the timestamp of the newest surviving line for the dash's current generation, and carried onto `DashDetail`, `DashStatus`, the CHANGESET wire, and `DashChangesetEntry`.

**Rationale:**
- The timestamp already exists on every line — `split_log_line` currently discards it as `let _timestamp`. Returning it is the whole read.
- Without a `created` marker, a dash created bare (no `--plan`, no rounds) has no log line at all and no age to show; `create` with `--plan` already writes an `Adopt plan` line, so the gap is arbitrary.
- The branch tip's committer date is *not* a safe fallback: for a zero-round dash the tip is the base commit it branched from, so a recent commit on `main` would make an untouched dash look freshly worked.
- Generation reset comes free: `read_declarations` already discards everything at or before the last terminal line, so a reused dash name reports its *new* generation's age.

**Implications:**
- `read_declarations`'s `match marker` arm list is untouched — `created` falls into the existing `_ => {}`, so stage derivation is provably unaffected. `last_activity` is assigned before the match, from every non-terminal line.
- **The `created` line's note must be empty, and that is load-bearing.** `read_dash_log` in `tugrust/crates/tugcast/src/feeds/draft_engine.rs` is a *second, independent* parser of the same file: it filters lines to the dash and keeps every non-empty `<note>` as a per-round **instruction** feeding draft authorship. A `created` line carrying any note at all would enter that corpus and appear as an instruction the user never gave. The empty note is what keeps the new record invisible to it.
- Dashes created before this lands have no birth record; their `last_activity` is `None` unless something else has been logged, and the row omits the age chip.
- `create` is idempotent and returns early for a fully-present dash; the append goes only on the genuinely-created path so a revisit does not forge activity.
- `tugutil dash status` gains a `Last activity:` line, following the `Step:` line added in `dd12c93cf`.

#### [P07] Parked rows sort by stage descending, then age ascending, then name (DECIDED) {#p07-ordering}

**Decision:** `compareDashRows` becomes: `DASH_STAGE_RANK` descending, then `last_activity` descending (newest first — i.e. smallest age first), then `name.localeCompare`. The worked-before-parked clause is deleted. A row with no `last_activity` sorts after rows that have one, within its stage.

**Rationale:**
- Nearest-to-done first is already the table's premise, and it is even more right for an inbox: a parked `draft-ready` dash is one gesture from landing.
- Freshness is the tiebreak a person actually wants — the dash parked an hour ago is the one they were just in.
- Absent-age-last keeps pre-existing dashes from claiming the top of every stage band.

**Implications:**
- `last_activity` is ISO-8601 UTC, so the comparison is a plain string comparison; no `Date` parsing in the sort.
- `DASH_STAGE_RANK` keeps its `working` entry even though a parked dash can hold that stage (a dirty worktree with no session on it), so no table entry is removed.

#### [P08] The age chip is formatted at render, with no ticker (DECIDED) {#p08-age-no-ticker}

**Decision:** `formatDashAge(iso, nowMs)` renders coarse units — `now` under a minute, `<n>m`, `<n>h`, `<n>d` — and is called with `Date.now()` during render. No interval, no timer, no store.

**Rationale:**
- Day and hour granularity does not benefit from second-by-second refresh; the visible value changes at most hourly.
- The CHANGESET aggregate recomputes on its own schedule and re-renders the row, which is more than enough resolution for the unit displayed.
- A ticking clock in a rail component is a per-second wake for a rarely-visible section — exactly the shape the perf campaign has been removing.

**Implications:**
- `formatDashAge` takes `nowMs` as a parameter, so its unit test is a table with no clock mocking.
- A row can display a slightly stale age between recomputes. Bounded by the aggregate's cadence and invisible at these units.

#### [P09] Adopt targets the Lens's followed card and refuses out loud (DECIDED) {#p09-adopt-ladder}

**Decision:** Adopt reads the Lens's followed card (`useLensFollowedCard`), resolves its session binding through `cardSessionBindingStore`, and sends the existing `bind_dash` CONTROL frame with that session id, the dash's project dir, and the dash name. When there is no followed card, no session bound to it, or its project does not own the dash, the control is **disabled with a reachable tooltip naming the reason**.

**Rationale:**
- `bind_dash` is exactly what `session-changes-view.tsx`'s lane `adopt` sends. Reusing it means one binding path, and the existing `bind_dash_ok` broadcast remains the only mover of `cardSessionBindingStore` — a refused bind leaves the card bound to what it was.
- The followed card is already tracked once by `LensContent` and published through `LensFollowedCardContext` precisely because focusing the Lens makes the Lens the key card; sections are meant to read it from there.
- A disabled control with a tooltip is the pattern the lane already uses for its own `disabledReason`, and its docblock records why the tooltip wraps a span: a disabled button takes no pointer events, so its own tooltip would never fire, "and the reason has to be reachable or it is not a reason".

**Implications:**
- The Parked row must carry its owning `project_dir`, which `dashRowsFromSnapshot` can take from the enclosing `ProjectChangeset` it is already iterating.
- Adopt is an explicit named press in the row's trailing cluster. Row activation does **not** bind ([P10]).
- The existing `dash-bind-error-store` / `dash-bind-error-notice-controller` surface handles a server-side refusal, unchanged.

#### [P10] Row activation never mutates a binding (DECIDED) {#p10-activation-is-not-a-verb}

**Decision:** `onSelect` / `onActivate` on a Parked row move the cursor and nothing else. Adopt is a button; Release is behind the row's context menu.

**Rationale:**
- Everywhere else in the Lens, activating a row *fronts* something. Making one row type mutate state on the same key would mean the reader has to remember which list they are in before pressing Enter.
- The current `onActivate` is a dead card-walk for parked rows; replacing "silently does nothing" with "silently rebinds" trades one [L31] problem for a worse one.
- Release ends a dash. It belongs behind a deliberate gesture, and `useChangesetRelease` already carries the confirm/pending machinery.

**Implications:**
- The dead `boundSessions`/`cardIdForSession` walk in the delegate is deleted rather than repaired.
- The section's `delegate` becomes cursor-only, so `TugListView`'s `commitOnEnter="act"` no longer has an act to commit; it is dropped.

#### [P11] The `#<name>` sigil is spelled in one shared component (DECIDED) {#p11-shared-sigil}

**Decision:** Extract the sigil+name presentation currently inlined in `SessionDashMarker` (`tug-session-identity.tsx`) into a shared `DashSigil({ name, review })`, and have both `SessionDashMarker` and the Parked row compose it.

**Rationale:**
- The standing rule is that a bound dash always shows with its `#` sigil, in all places, no exceptions. Two hand-rolled spellings is how that drifts.
- The Parked row cannot reuse `SessionDashMarker` directly: that component is keyed by `sessionId` and resolves the dash *through* a session, which a parked dash by definition does not have.
- The review tint already rides the same element (`data-review`), so extracting keeps that coupling intact in one place.

**Implications:**
- `SessionDashMarker` keeps its session lookup, its tooltip sentence, and its `data-slot="session-identity-dash"`; only the inner markup moves.
- The Parked row gets its own `data-slot` so a test can tell the two apart.
- The shared class names stay `tug-session-identity-dash*` so no CSS moves in this plan.

---

### Deep Dives {#deep-dives}

#### Why the Cards section cannot cover a parked dash {#why-cards-cannot-cover-parked}

`bound_sessions` is computed by `bound_sessions_for` in `tugrust/crates/tugdash-core/src/ops.rs`, reading the per-instance `sessions.db` **live-sessions-only**. `tuglaws/dash-lifecycle.md` states the consequence directly: "a dash whose cards have all closed reads as *parked* — parked is not a stage, it is the absence of workers."

The Lens's Cards section is built from open cards. Its `CardsSessionRow` calls `useDashForSession(tugSessionId)`, so a dash line exists only where a session exists. Therefore, for a dash with zero bound sessions there is no session, no card, no row, and no line — and no amount of improving the Cards section can produce one, because the thing it is keyed by is absent. This is the whole justification for the section's continued existence and it is why membership is defined as the complement ([P01]).

#### The presence chicken-and-egg, concretely {#presence-chicken-and-egg}

Today `lens-section-content.ts` holds two facts per focus group, both published from the section body's `useLayoutEffect`:

- `navigable` — cursorable rows after the filter; gates the list's focus group and the ⌘L seed.
- `populated` — items before the filter; gates the band's filter field. Its docstring is explicit that it "must never be read off the filtered count".

Neither can drive hiding. Both are body-published, and `LensSection` renders no body when the section is not rendered — so the sequence is: hide ⇒ body unmounts ⇒ cleanup publishes `{navigable: false, populated: false}` ⇒ presence recomputes as false ⇒ stays hidden forever. This is not a bug to be careful about; it is the structure. Hence a store whose writer is mounted independently of what it hides ([P04]).

#### The Adopt path, end to end {#adopt-path}

1. The row holds `ownerId`, `name`, and `projectDir` (from the enclosing `ProjectChangeset`).
2. `useLensFollowedCard()` gives the last non-Lens key card id, published by `LensContent` through `LensFollowedCardContext`.
3. `cardSessionBindingStore.getBinding(cardId)` gives `{ tugSessionId }`, or `undefined`.
4. The card's project is compared against the row's `projectDir`. A dash can only be bound by a session in its own project.
5. On press: `getConnection()?.sendControlFrame("bind_dash", { tug_session_id, project_dir, dash })` — byte-for-byte the frame `session-changes-view.tsx` sends.
6. The server's `bind_dash_ok` broadcast moves `cardSessionBindingStore`; the aggregate's next beat moves `bound_sessions`; the row's membership test flips and it leaves the section. If it was the last row, the section unmounts.

Each failure at steps 2–4 has its own sentence, and they are the tooltip:

| Condition | Reason shown |
|---|---|
| No followed card | `Focus a session card to adopt this dash` |
| Followed card has no session | `The focused card has no session` |
| Project mismatch | `This dash belongs to <project>` |

**Table T01: Adopt refusal sentences** {#t01-adopt-refusals}

---

### Specification {#specification}

**Spec S01: `last_activity` derivation** {#s01-last-activity}

For a dash `d` in repository `R`:

1. Read `R/<state>/dash-log.md`, filter to lines whose dash field is `d`.
2. On each terminal line (`released`, or a note equal to or starting with `joined`), reset all accumulated declarations *including* `last_activity` — the generation restarts.
3. For every surviving non-terminal line, set `last_activity` to that line's timestamp field. Lines are appended in time order, so the last assignment wins; no comparison is needed.
4. `last_activity` is `None` when the current generation has no lines.

The timestamp is field 1 of the four `  `-separated fields `split_log_line` parses; it is currently bound to `_timestamp` and discarded.

**Spec S02: Parked membership and order** {#s02-membership-order}

```
rows = snapshot.projects
  .flatMap(p => p.changesets.filter(kind === "dash").map(e => row(e, p)))
  .filter(r => r.boundSessions.length === 0)
  .sort(compare)

compare(a, b):
  byStage = stageRank(b.stage) - stageRank(a.stage);   if != 0 -> byStage
  byAge   = compareIsoDesc(a.lastActivity, b.lastActivity); if != 0 -> byAge
  return a.name.localeCompare(b.name)

compareIsoDesc(a, b):
  a === null && b === null -> 0
  a === null -> 1        // absent sorts last
  b === null -> -1
  b.localeCompare(a)     // ISO-8601 UTC: newest first
```

**Spec S03: `formatDashAge(iso, nowMs)`** {#s03-format-age}

| Elapsed | Output |
|---|---|
| `iso` is `null`, unparseable, or in the future | `null` (the chip is omitted) |
| `< 60s` | `now` |
| `< 60m` | `<n>m` |
| `< 24h` | `<n>h` |
| otherwise | `<n>d` |

**Table T02: Age formatting** {#t02-age-format}

A future timestamp yields `null` rather than a negative or a clamped `now`: a clock skew should show nothing, not a confident lie.

**Spec S04: `mergeHiddenIntoOrder(fullOrder, visibleOrder)`** {#s04-merge-hidden}

`hidden = fullOrder.filter(k => !visibleOrder.includes(k))`, each paired with its index in `fullOrder`. Starting from `visibleOrder`, splice each hidden kind back in at its recorded index, in ascending index order, clamped to the array's current length. With nothing hidden the function is the identity.

**Spec S05: Parked row anatomy** {#s05-row-anatomy}

```
[◌] #dash-name    step 4/9 — Wire the responder    built · 3d · tugtool [!]   [Adopt]
```

- Leading: the parked mark (`CircleDashed`), unconditional — every row in this section is parked ([P01]).
- `#dash-name` via the shared `DashSigil` ([P11]).
- Step counters and title, when the dash declared them; both omitted otherwise.
- Trailing metadata run: stage word, age chip ([P08]), project label **always** (a parked dash may belong to a project with nothing else on screen, so the label is orientation, not disambiguation), and the review mark when `dashReviewPaints` says it paints.
- Trailing control: `Adopt`, disabled with a reason per Table T01.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Section presence per kind | structure | `lens-section-presence.ts` module store + `useSyncExternalStore` in `LensContent` | [L02] |
| Presence publication timing | structure | probe's `useLayoutEffect` — the walk's group order depends on it before the first key event | [L03] |
| Parked row set | local-data (derived) | `useMemo` over the `useChangesetAll` snapshot; no new store | [L02] |
| Adopt target + refusal reason | local-data (derived) | `useLensFollowedCard()` + `cardSessionBindingStore`, computed at render | [L02] |
| Parked mark, review tint, stage tone | appearance | CSS on `data-*` attributes | [L06] |
| Release confirm/pending | local-data | existing `useChangesetRelease` store | [L02] |
| Section order after a drag | structure | `lensStore.setSectionOrder` via `mergeHiddenIntoOrder` | [L02] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/lens/lens-section-presence.ts` | Presence store: `setSectionPresent`, `sectionIsPresent`, `subscribeSectionPresence`, `getSectionPresenceVersion` |
| `tugdeck/src/components/lens/lens-section-presence-probe.tsx` | `LensSectionPresenceProbe` — calls `def.presence`, publishes, renders `null` |
| `tugdeck/src/components/lens/sections/dash-sigil.tsx` | Shared `DashSigil({ name, review })` ([P11]) |
| `tugdeck/src/components/lens/sections/dash-age.ts` | `formatDashAge` ([P08], Spec S03) |
| `tests/app-test/at0438-lens-parked-dashes.test.ts` | The partition law + Adopt round trip |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `split_log_line` | fn | `tugrust/crates/tugdash-core/src/dash.rs` | return the timestamp instead of discarding it |
| `DashDeclarations::last_activity` | field | `tugrust/crates/tugdash-core/src/dash.rs` | `Option<String>` ([P06]) |
| `ops::create` | fn | `tugrust/crates/tugdash-core/src/ops.rs` | append a `created` dash-log line on the created path |
| `DashDetail::last_activity` | field | `tugrust/crates/tugdash-core/src/ops.rs` | populated in `dash_detail_entries_in` |
| `DashStatus::last_activity` | field | `tugrust/crates/tugdash-core/src/ops.rs` | populated in `status_in` |
| `ChangesetEntry::Dash::last_activity` | field | `tugrust/crates/tugcast-core/src/types.rs` | `#[serde(default, skip_serializing_if = "Option::is_none")]` |
| `dash_entries` | fn | `tugrust/crates/tugcast/src/feeds/changeset.rs` | map `detail.last_activity` |
| `run_status` | fn | `tugrust/crates/tugutil/src/dash.rs` | print `Last activity:` |
| `DashChangesetEntry.last_activity` | field | `tugdeck/src/lib/changeset-types.ts` | `?: string` + guard clause |
| `LensSectionDefinition.presence` | field | `tugdeck/src/components/lens/lens-section-registry.ts` | optional hook ([P04]) |
| `mergeHiddenIntoOrder` | fn | `tugdeck/src/components/lens/lens-section-registry.ts` | pure, exported ([P05], Spec S04) |
| `LensContent` | component | `tugdeck/src/components/lens/lens-content.tsx` | probes + visible order |
| `DashRow` | interface | `tugdeck/src/components/lens/sections/dashes-section.tsx` | `+projectDir`, `+lastActivity`; `-parked`, `-boundSessions` |
| `compareDashRows` | fn | `tugdeck/src/components/lens/sections/dashes-section.tsx` | ([P07], Spec S02) |
| `dashRowsFromSnapshot` | fn | `tugdeck/src/components/lens/sections/dashes-section.tsx` | parked-only filter |
| `dashesCollapsedSummary` | fn | `tugdeck/src/components/lens/sections/dashes-section.tsx` | "N parked" |
| `DashPhaseDot` | component | `tugdeck/src/components/lens/sections/dashes-section.tsx` | **deleted** |
| `SessionDashMarker` | component | `tugdeck/src/components/tugways/tug-session-identity.tsx` | composes `DashSigil` |

---

### Documentation Plan {#documentation-plan}

- [ ] Rewrite the `dashes-section.tsx` module docblock: the partition law ([P01]), not the roster-vs-workbench apologia.
- [ ] Correct the "every registered section always renders" sentences in `lens-content.tsx` and `lens-section-registry.ts` ([P03]).
- [ ] Update `dash-facts.tsx`'s docblock — it currently says two Lens surfaces render the same run, which stops being true.
- [ ] Note the `created` marker in `tuglaws/dash-lifecycle.md` beside the existing parked paragraph, and state that `created` is a record, not a stage.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Rust unit** | dash-log parsing, generation reset, `created` marker inertness | `dash.rs` / `ops.rs` tests |
| **TS unit** | Pure projections: membership, order, age, merge | `dashes-section` / registry tests |
| **App-test** | The partition law and the Adopt round trip against the real app | `at0438` |

#### What stays out of tests {#test-non-goals}

- **The tooltip text of each refusal** — asserting sentences pins prose, not behavior; the app-test asserts the control is disabled and that no bind occurred.
- **Release from the Parked row, end to end** — `tugutil dash release` is destructive and the app-test corpus already has a stranded-fixture sweep; the wiring is covered by reusing `useChangesetRelease`, whose own store is tested.
- **A fake-DOM render assertion over the row** — banned pattern; the row's shape is pinned by `at0438` against the real app.
- **Age chip refresh over time** — there is deliberately no ticker ([P08]); `formatDashAge` is a pure table.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | `last_activity` from the dash-log, and a birth record | pending | — |
| #step-2 | Carry `last_activity` to the deck | pending | — |
| #step-3 | Section presence: the registry can hide a section | pending | — |
| #step-4 | The projection becomes parked-only | pending | — |
| #step-5 | The Parked row's anatomy | pending | — |
| #step-6 | Adopt and Release | pending | — |
| #step-7 | Integration checkpoint: the partition law, in the app | pending | — |

---

#### Step 1: `last_activity` from the dash-log, and a birth record {#step-1}

**Commit:** `tugdash(last-activity): the dash-log's newest line dates a dash, and creation writes one`

**References:** [P06] Every dash gets a birth record, Spec S01, (#s01-last-activity, #context)

**Artifacts:**
- `DashDeclarations::last_activity` and a timestamp-returning `split_log_line`
- A `created` dash-log marker written by `ops::create`
- `last_activity` on `DashDetail` and `DashStatus`
- A `Last activity:` line in `tugutil dash status`

**Tasks:**
- [ ] In `tugrust/crates/tugdash-core/src/dash.rs`, change `split_log_line` to return the timestamp as a fourth tuple element rather than binding it to `_timestamp`, and update its callers.
- [ ] Add `pub last_activity: Option<String>` to `DashDeclarations`, documented as the newest surviving line's timestamp for the current generation.
- [ ] In `read_declarations`, assign `found.last_activity = Some(timestamp.to_owned())` for every non-terminal line for this dash, **before** the `match marker`, and clear it on the terminal reset (it is cleared already by `DashDeclarations::default()`).
- [ ] Confirm by inspection that the `match marker` arms are unchanged, so `created` falls into `_ => {}` and no stage derivation moves.
- [ ] In `tugrust/crates/tugdash-core/src/ops.rs`, in `create`, append `append_dash_log(&repo_root, name, "created", "")` on the genuinely-created path only — after the branch and worktree exist, and never on the early idempotent return for a fully-present dash. **The note must be the empty string** ([P06]): `draft_engine.rs`'s `read_dash_log` keeps every non-empty note as a draft-authoring instruction, and skips empty ones.
- [ ] Survey the other readers of `dash-log.md` for anything that would break on an extra line. Known readers: `read_declarations` (this file), `read_dash_log` (`draft_engine.rs`, guarded by the empty note above), the `replayed` assertion in `base_motion.rs` (a `log.contains("replayed")` substring check, so unaffected), and the log-shape tests in `ops.rs`. None assert exact file contents; confirm that is still true before landing.
- [ ] Add `pub last_activity: Option<String>` to `DashDetail`, populated from `declarations.last_activity.clone()` in `dash_detail_entries_in`.
- [ ] Add the same field to `DashStatus`, populated in `status_in`.
- [ ] In `tugrust/crates/tugutil/src/dash.rs`, have `run_status` print `Last activity: {}` when present, after the existing `Step:` line.

**Tests:**
- [ ] `a_logs_newest_line_dates_the_dash` — a log with three lines for one dash reports the third line's timestamp.
- [ ] `a_terminal_line_resets_the_date` — lines, then `released`, then one more line: `last_activity` is the last line's, not the pre-release one's.
- [ ] `a_dash_with_no_surviving_lines_has_no_date` — only pre-terminal lines ⇒ `None`.
- [ ] `a_created_marker_does_not_move_the_stage` — a log of exactly one `created` line leaves `latest` at `None` and dates the dash.
- [ ] Extend the existing `create` test coverage to assert the dash-log gains exactly one `created` line, and that a second `create` of the same dash adds none.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugdash-core`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo build`

---

#### Step 2: Carry `last_activity` to the deck {#step-2}

**Depends on:** #step-1

**Commit:** `tugcast(changeset): a dash entry carries when it was last touched`

**References:** [P06] Every dash gets a birth record, Spec S01, (#s01-last-activity)

**Artifacts:**
- `last_activity` on the CHANGESET wire type and its mapping
- `last_activity` on `DashChangesetEntry` with a type guard clause

**Tasks:**
- [ ] Add `last_activity: Option<String>` to `ChangesetEntry::Dash` in `tugrust/crates/tugcast-core/src/types.rs`, with `#[serde(default, skip_serializing_if = "Option::is_none")]` matching the neighbouring optional fields.
- [ ] Map `last_activity: detail.last_activity` in `dash_entries` in `tugrust/crates/tugcast/src/feeds/changeset.rs`.
- [ ] Update every `ChangesetEntry::Dash { … }` construction in that crate's tests to carry the new field.
- [ ] Add `last_activity?: string` to `DashChangesetEntry` in `tugdeck/src/lib/changeset-types.ts`, documented as an ISO-8601 UTC instant that is absent for a dash with no dash-log record.
- [ ] Add `(value.last_activity === undefined || typeof value.last_activity === "string")` to the dash entry guard.

**Tests:**
- [ ] Extend the existing dash-entry serialization test in `types.rs` to assert `last_activity` is omitted from the JSON when `None` and present when `Some`.
- [ ] A guard test rejecting a dash entry whose `last_activity` is a number.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bunx tsc --noEmit`

---

#### Step 3: Section presence — the registry can hide a section {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(lens): a section may declare itself absent, and the walk follows`

**References:** [P03] An empty section renders nothing, [P04] Presence is published by a probe, [P05] The visible order drives the walk, Spec S04, Risk R01, Risk R02, (#presence-chicken-and-egg, #r01-presence-latch, #r02-reorder-indices)

**Artifacts:**
- `lens-section-presence.ts` and `lens-section-presence-probe.tsx`
- `presence` on `LensSectionDefinition`; `mergeHiddenIntoOrder`
- `LensContent` driving everything off the visible order

**Tasks:**
- [ ] Create `tugdeck/src/components/lens/lens-section-presence.ts` mirroring `lens-section-content.ts`'s shape: a `Map<string, boolean>`, a listener set, a version counter, `setSectionPresent`, `sectionIsPresent` (**defaulting to `true`** for an unknown kind), `subscribeSectionPresence`, `getSectionPresenceVersion`. Document in the module docstring why this cannot live in `lens-section-content` (Risk R01).
- [ ] Add `presence?: (host: LensSectionHost) => boolean` to `LensSectionDefinition`, documented as evaluated by an always-mounted probe and as the only way a section may be absent.
- [ ] Create `lens-section-presence-probe.tsx`: `LensSectionPresenceProbe({ def, host })` calls `def.presence?.(host) ?? true`, publishes it in a `useLayoutEffect` ([L03]), clears to `true` on unmount, and returns `null`.
- [ ] Add `mergeHiddenIntoOrder(fullOrder, visibleOrder)` to `lens-section-registry.ts` per Spec S04, beside `moveInArray`.
- [ ] In `lens-content.tsx`: render one probe per **registered** kind (outside `.lens-sections`, keyed by kind); subscribe to the presence store; derive `visibleOrder`; use it for the rendered map, `orderKey`, `shapeKey`, `setGroupOrder`, `registerSpatialOrder`, the ⌘L seed search, and `useBlockReorder`'s `getVisibleOrder`; and run `commit` through `mergeHiddenIntoOrder` against the full resolved order.
- [ ] Rewrite the "every registered section always renders" sentences in `lens-content.tsx` and `lens-section-registry.ts` to state the new rule ([P03]).

**Tests:**
- [ ] `mergeHiddenIntoOrder` table: nothing hidden is the identity; one hidden at the head, middle, and tail returns to its index; two hidden preserve relative order; a hidden kind whose index exceeds the merged length clamps to the end.
- [ ] `sectionIsPresent` returns `true` for a kind that has never published.
- [ ] A registry test that a definition with no `presence` hook is present.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bun test src/components/lens`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bunx tsc --noEmit`

---

#### Step 4: The projection becomes parked-only {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(lens): the Dashes section holds only what nobody is working`

**References:** [P01] A dash appears exactly once, [P02] The kind stays `dashes`, [P03] An empty section renders nothing, [P07] Ordering, [P08] The age chip, Spec S02, Spec S03, (#why-cards-cannot-cover-parked, #s02-membership-order, #t02-age-format)

**Artifacts:**
- `dashRowsFromSnapshot` filtered to parked; `compareDashRows` re-ordered
- The section's `presence` hook, band title, and collapsed summary
- `DashPhaseDot` deleted

**Tasks:**
- [ ] In `dashes-section.tsx`: add `projectDir: string` and `lastActivity: string | null` to `DashRow`; remove `parked` and `boundSessions`.
- [ ] `rowFromEntry` takes the enclosing `ProjectChangeset` so it can carry `projectDir`, and reads `entry.last_activity ?? null`.
- [ ] `dashRowsFromSnapshot` filters `(entry.bound_sessions ?? []).length === 0` **before** building rows, and always sets the project label (dropping the `disambiguate` conditional, per Spec S05).
- [ ] Rewrite `compareDashRows` per Spec S02; delete the worked-before-parked clause.
- [ ] `dashesCollapsedSummary` becomes `"<n> parked"` / `"1 parked"`; the zero case can no longer render but returns `"No parked dashes"` defensively.
- [ ] Delete `DashPhaseDot` and its `SessionPhaseDot` import; the leading mark is unconditionally `DashParkedMark`.
- [ ] Register `presence: () => useDashRows().length > 0`, `title: "Parked Dashes"`, `kind` unchanged ([P02]).
- [ ] Replace the "roster, not the workbench" module docblock with the partition law and the reason Cards cannot cover a parked dash.
- [ ] Update `dash-facts.tsx`'s docblock — it no longer describes two surfaces rendering the same run.

**Tests:**
- [ ] `dashRowsFromSnapshot` drops every dash with a non-empty `bound_sessions`, and keeps one with `[]` and one with the field absent entirely.
- [ ] `compareDashRows` table: stage rank dominates age; newer sorts before older within a stage; a `null` age sorts last within its stage; name is the final tiebreak. Note the sort compares raw ISO-8601 UTC strings and never parses a `Date` ([P07]).
- [ ] `dashesCollapsedSummary` singular/plural.
- [ ] Update the existing `dashes-section` unit tests for the changed `DashRow` shape.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bun test src/components/lens`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bunx tsc --noEmit`

---

#### Step 5: The Parked row's anatomy {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(lens): a parked row says what it is, how far it got, and how stale`

**References:** [P11] One shared sigil, Spec S05, [L06] appearance via CSS, (#s05-row-anatomy)

**Artifacts:**
- `dash-sigil.tsx` with `DashSigil`, composed by `SessionDashMarker` and the Parked row
- `dash-age.ts` with `formatDashAge`
- The rebuilt `DashCell`, and the CSS for the trailing metadata run

**Tasks:**
- [ ] Create `tugdeck/src/components/lens/sections/dash-age.ts` with `formatDashAge(iso: string | null, nowMs: number): string | null` per Spec S03. It lands here rather than in #step-4 because the ordering sorts on raw ISO strings and has no use for a formatted age — a step should not create a symbol it does not call.
- [ ] Create `dash-sigil.tsx` exporting `DashSigil({ name, review })` rendering the `#` sigil span and the name span with `data-review` when `dashReviewPaints(review)`, reusing the existing `tug-session-identity-dash*` class names.
- [ ] Refactor `SessionDashMarker` in `tug-session-identity.tsx` to compose `DashSigil`, keeping its own session lookup, tooltip sentence, `aria-label`, and `data-slot="session-identity-dash"`.
- [ ] Rebuild `DashCell` per Spec S05: parked mark leading; `DashSigil` with `data-slot="lens-parked-name"`; step counters and title; a trailing metadata run of stage, age chip, project label, and review mark.
- [ ] Stop routing the Parked row through `DashFactsRun` — the two surfaces no longer say the same sentence, so the shared run's remaining consumer is the Cards dash line. Leave `DashFactsRun` and `DashReviewMark` in place; the row composes `DashReviewMark` directly.
- [ ] Add the metadata-run and age-chip rules to `dashes-section.css`; the age chip is muted 2xs, matching `.lens-dashes-step-title`.
- [ ] Give the row `data-parked="true"` unconditionally so existing CSS keyed on it still applies, and add `data-age` for test reach.

**Tests:**
- [ ] `formatDashAge` table per Spec S03, including a future timestamp ⇒ `null` and an unparseable string ⇒ `null`.
- [ ] `at0424-lens-dash-line.test.ts` still passes unchanged — it asserts `[data-slot="session-identity-dash"]` appears exactly once on a bound session's row, which is the falsifiable check that extracting `DashSigil` out of `SessionDashMarker` changed no identity surface.
- [ ] Update any existing unit test that asserted the Dashes row composed `DashFactsRun`.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bun test && bunx tsc --noEmit`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bunx vite build`

---

#### Step 6: Adopt and Release {#step-6}

**Depends on:** #step-5

**Commit:** `tugdeck(lens): a parked dash can be taken on, or let go, from the row`

**References:** [P09] Adopt targets the followed card, [P10] Activation never mutates a binding, Table T01, Risk R03, Risk R04, [L31] no gesture fails silently, (#adopt-path, #t01-adopt-refusals, #r03-verb-destroys-surface)

**Artifacts:**
- An Adopt control on every Parked row, with a reachable refusal
- Release behind the row's context menu
- The dead card-walk delegate deleted

**Tasks:**
- [ ] Add a `useAdoptTarget(projectDir)` hook in `dashes-section.tsx` returning `{ tugSessionId: string | null, reason: string | null }`, resolving the ladder in #adopt-path and producing the sentences in Table T01.
- [ ] Render a `TugPushButton` labelled `Adopt` in the row's trailing cluster, `disabled` when `reason !== null`, wrapped in a `TugTooltip` **on a span** so the reason is reachable while the button is disabled — the same construction `session-changes-dash-lane.tsx` uses and documents for its Release control.
- [ ] On press, send `bind_dash` with `{ tug_session_id, project_dir: row.projectDir, dash: row.name }` through `getConnection()?.sendControlFrame` (`lib/connection-singleton.ts`), touching no store directly — `bind_dash_ok` remains the only mover of `cardSessionBindingStore`.
- [ ] Give Adopt **no local pending or error state** (Risk R03): success is the row leaving, and a server-side refusal surfaces on the existing card-level `dash-bind-error-store` / `dash-bind-error-notice-controller`, which outlives the row and the section.
- [ ] Add a row context menu offering `Release dash`, calling `useChangesetRelease(...).release(row.projectDir, row.name)`, with the confirm anchored to the **row element and not the menu item** — the construction `session-changes-dash-lane.tsx` documents, and the one that survives the row unmounting on success (Risk R03).
- [ ] Delete the delegate's `boundSessions` / `cardIdForSession` walk and the now-unused imports; `onSelect` and `onActivate` become cursor-only, and `commitOnEnter="act"` is dropped from the `TugListView` ([P10]).
- [ ] Update the section docblock: it is no longer read-only, and the reason is that a parked dash's verbs have nowhere else to live.

**Tests:**
- [ ] `useAdoptTarget`'s pure resolution helper as a table: no followed card, card with no session, project mismatch, and the eligible case — each producing the expected reason or session id.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bun test && bunx tsc --noEmit`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bunx vite build`

---

#### Step 7: Integration checkpoint — the partition law, in the app {#step-7}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6

**Commit:** `app-test(at0438): a dash is in the Lens exactly once`

**References:** [P01] A dash appears exactly once, [P03] An empty section renders nothing, [P09] Adopt targets the followed card, (#success-criteria, #why-cards-cannot-cover-parked)

**Artifacts:**
- `tests/app-test/at0438-lens-parked-dashes.test.ts`

**Tasks:**
- [ ] Build the app first — an app-test never rebuilds the binary, and Steps 1–2 changed Rust: `just build-app`.
- [ ] Author `at0438` with `@covers` lines for `dashes-section.tsx`, `lens-content.tsx`, `lens-section-presence.ts`, `lens-section-presence-probe.tsx`, `dash-sigil.tsx`, and `dash-age.ts`.
- [ ] Use `createDash` / `releaseDash` from `dash-fixture.ts` and drive `tugutil dash bind` / `unbind` through the card's `$` shell route (the route that stamps `TUG_SESSION_ID`), following `at0424`'s `shellAndSettle` helper.
- [ ] Route every click through a retry helper in the shape `at0405`'s `clickUntil` takes, including its `want: "present" | "absent"` direction — the Lens list recomposes on its own aggregate schedule, so a coordinate read can go stale between aiming and pressing.

**Tests:**
- [ ] With the fixture dash bound to the card's session, `document.querySelector('[data-lens-section="dashes"]')` is `null` — the band, not merely the body.
- [ ] After `dash unbind`, the section exists and holds exactly one row, whose text contains `#<name>`.
- [ ] The session's Cards row loses its dash line across the same transition, and regains it after Adopt — the two halves of the partition asserted in one round trip.
- [ ] Pressing Adopt on the row binds the dash: the row leaves, the section unmounts, and the session's dash line returns.
- [ ] Adopting the last parked dash with the movement cursor inside the section leaves the cursor on a mounted focusable — read `window.tugDevLog.getSnapshot()` for the `keyView()` after the unmount, and assert it is not a key belonging to the vanished group (Risk R04).
- [ ] `just app-test-covers-check` passes for the new file.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool && just build-app`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool && just app-test at0438-lens-parked-dashes.test.ts`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool && just app-test at0424-lens-dash-line.test.ts at0405-changes-dash-lane.test.ts`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A Lens section that holds only dashes nobody is working, disappears when there are none, dates each row, and lets a reader adopt or release from the row it is reading.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every dash in the aggregate is in exactly one Lens surface (at0438 round trip)
- [ ] The section renders no DOM when empty (at0438 asserts `null` for the band)
- [ ] The band reads **Parked Dashes** and its `kind` is still `"dashes"` (existing selectors unchanged)
- [ ] Adopt binds, or refuses with a reachable reason — never silently (at0438 + the `useAdoptTarget` table)
- [ ] `tugutil dash status` reports `Last activity:` (Rust integration test)
- [ ] `cargo nextest run` clean, `bun test` clean, `tsc --noEmit` clean, `bunx vite build` succeeds
- [ ] No `console.warn` from a duplicate section registration, and drag-reorder is correct with the section absent (`mergeHiddenIntoOrder` table)

**Acceptance tests:**
- [ ] `at0438-lens-parked-dashes.test.ts`
- [ ] `at0424-lens-dash-line.test.ts` (unchanged contract — the Cards dash line is untouched)
- [ ] `mergeHiddenIntoOrder`, `compareDashRows`, `formatDashAge`, `dashRowsFromSnapshot` unit tables

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Adopt with no eligible card opens a new session on the dash's project, resolving [Q01]
- [ ] A Lens-wide review of which other sections should opt into `presence`
- [ ] The verb-misassignment round: `LANDING_WORDS` on the composer's land button, and the row JOIN either landing or visibly handing off
- [ ] The structural [L31] bypass in `tug-prompt-entry.tsx`, where the land button is natively `disabled` on gate refusal so a press can never reach `refuse()`
- [ ] Fold `read_dash_log` (`tugcast/src/feeds/draft_engine.rs`) onto `split_log_line` (`tugdash-core/src/dash.rs`) — two independent parsers of one file's grammar, which is how the `created` note's emptiness became load-bearing rather than obvious ([P06])

| Checkpoint | Verification |
|------------|--------------|
| `last_activity` reaches the deck | `just db-inspect` not needed — `tugutil dash status <name>` prints it |
| The section vanishes when empty | at0438 asserts the band selector is `null` |
| Reorder survives a hidden section | `mergeHiddenIntoOrder` unit table |
| Adopt never fails silently | at0438 + `useAdoptTarget` table ([L31]) |
| No regression in the Cards dash line | at0424 passes unchanged |
