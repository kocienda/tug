<!-- devise-skeleton v4 -->

## Lens Route Rework — Changes & History become Session-card view-routes {#lens-route-rework}

**Purpose:** Slim the Lens *Sessions* section to a read-only session monitor and delete the Lens *Git History* section, moving both working surfaces into the Session card as two new **view-routes** — `Changes` (changed files + commit composer + AI draft + dash join) and `History` (per-commit blocks + on-record AI questions about prior work) — plus commit-message trailers that make history questions answerable.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-16 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Today the Lens *Sessions* section (`tugdeck/src/components/lens/sections/sessions-section.tsx`, ~1,900 lines) is a full working surface: per-session file rows, inline diffs, per-file commit-selection checkboxes, a CM6 commit composer with a maintained AI draft, and dash join/release actions. The Lens *Git History* section (`tugdeck/src/components/lens/sections/git-history-section.tsx`) shows a followed card's `git log` as one read-only text view. Both surfaces are workspace-scoped work that properly belongs *on the Session card* — the card already knows its own session, project, and binding, while the Lens has to reconstruct that context through the follow machinery.

This phase makes the Lens a monitor (glance state, click to go) and the Session card the workspace (commit, join, interrogate history). The prompt-entry stays exactly where it is on the card; two new routes in the existing route selector retarget what a submission does *and* swap the transcript slot for a purpose-built view.

#### Strategy {#strategy}

- **Extend the route mechanism, not the pane model.** The `RouteLifecycle` scalar already keeps one composer mounted and switches the submit target per route (`❯ $ ? ⌕`). Two new *view-routes* (`Changes`, `History`) additionally swap the transcript-slot content. Pane tab machinery is explicitly NOT used — a pane-card swap would swap the composer too, violating "prompt-entry stays right where it is."
- **Keep all slot views mounted; hide inactive ones with CSS.** Scroll position, in-progress selection, and streaming state survive route switches; the transcript's mount identity stays stable ([L26]).
- **Reuse the shipping plumbing wholesale.** Changed files: the account-global `CHANGESET_ALL` aggregate (0x24) filtered to the card's workspace — the per-workspace `CHANGESET` feed (0x23) is **retired** (`tugcast-core/src/protocol.rs`, "never reuse 0x23") and must not be revived. Commit: `changeset_commit` CONTROL verb → `tugmark_core::commit`. AI draft: `changeset_draft_request` → draft engine → streamed `changeset_draft_delta` frames. Join: `changeset_join` → `tugdash_core::ops::join_in`. History: `GIT_LOG`/`GIT_LOG_QUERY`/`GIT_HEAD` feeds (0x25/0x26/0x27). Nothing new on the wire except optional trailer fields on `changeset_commit`.
- **Build the card surfaces first, slim the Lens after** — no window where the commit flow exists nowhere.
- **History questions ride the record.** The History route's submit is a normal `codeSessionStore.send()` invoking a new `/tugplug:history` skill that searches git context (tugmark, `git log --grep`) and answers. Claude sees everything.
- **Commit trailers are the retrieval substrate.** `Tug-Session:` and `Tug-Dash:` trailers on every tugutil commit path make `git log --grep` session-scoped questions answerable. `Tug-Plan:` is deferred.

#### Success Criteria (Measurable) {#success-criteria}

- The Lens Sessions section renders one read-only row per open session (dot + name + pulse text + sparkline); no file rows, checkboxes, composer, or dash actions remain in the Lens (verify: `grep -c "useChangesetCommit" tugdeck/src/components/lens/sections/sessions-section.tsx` → 0).
- Clicking a Lens session row activates the bound card's pane (it becomes active/front) and its title bar flashes once (verify in running app).
- The Lens Git History section is gone: `git-history-section.tsx` deleted, no registration in `main.tsx` (verify: file absent, `bunx vite build` passes).
- The Session card's route selector offers six routes; picking `Changes` or `History` swaps the transcript slot; picking `❯`/`$`/`?`/`⌕` restores the transcript with its prior scroll position (verify in running app).
- On the Changes route: file selection + typed message + submit produces a real git commit of exactly the selected files (verify: `git log --stat` in a scratch repo); the Generate button streams an AI draft into the composer editor; a dash-bound entry shows Join.
- On the History route: each commit renders as its own block; submitting a question sends an on-record turn invoking `/tugplug:history` (visible in the transcript).
- Every commit made through `changeset_commit` (Changes route), `tugdash commit`, and `tugdash join` carries a `Tug-Session:` and/or `Tug-Dash:` trailer (verify: `git log -1 --format=%B` after each path; `cargo nextest run` tests assert trailer presence).
- `bunx vite build` passes; `cd tugrust && cargo nextest run` passes.

#### Scope {#scope}

1. Hoist `RouteLifecycle` ownership to the Session card; add `Changes`/`History` view-routes to the selector, keybindings, and route chrome.
2. Route-driven transcript slot on the Session card (transcript / ChangesView / HistoryView, all mounted, CSS-hidden).
3. ChangesView + changes-route composer semantics (commit, AI generate, dash join), backed by a per-card `ChangesRouteController`.
4. HistoryView (per-commit blocks over GIT_LOG) + history-route submit → `/tugplug:history` skill (new).
5. Slim Lens Sessions section to a read-only monitor; delete Lens Git History section.
6. Commit trailers (`Tug-Session:`, `Tug-Dash:`) on all three tugutil commit paths.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **`Tug-Plan:` trailer** (plan files used by a session) — explicitly DEFERRED per the phase brief; do not design it here.
- Removing the `CHANGESET_ALL` (0x24) aggregate feed or the Changeset card — untouched.
- Per-commit AI summarization in the HistoryView (the skill answers questions; the view just lists commits).
- Any change to the pane/tab model or `tuglaws/pane-model.md`.
- SC/TC font work, IndexedDB removal, or other adjacent cleanups.

#### Dependencies / Prerequisites {#dependencies}

- tugmark + tugmark-core shipped (`7de502c1f`) — `tugmark_core::commit`, `log`, `context` available and linked in-process by tugcast.
- BlockStrip unification shipped (`c63a88de8`) — `BlockChrome`/`BlockHeader`/`BlockStrip` altitudes available for HistoryView commit blocks.
- Draft engine (`tugrust/crates/tugcast/src/feeds/draft_engine.rs`, `scribe.rs`) and `ChangesetDraftStore` shipped.

#### Constraints {#constraints}

- Verify against tuglaws before tugdeck work: `tuglaws/tuglaws.md`, `tuglaws/pane-model.md`, `tuglaws/route-lifecycle.md`, `tuglaws/component-authoring.md`. Name touched laws in commits.
- Compose existing Tug* components; never hand-roll UI that exists as a component.
- No localStorage/sessionStorage/IndexedDB — persistence via tugbank `/api/defaults/<domain>/<key>`.
- No estimated cell heights — real measured heights only.
- Any new editing surface must register substrate responders (CUT/COPY/PASTE/SELECT_ALL/UNDO/REDO).
- Rust workspace: warnings are errors (`-D warnings`).
- `bunx vite build` must pass before any tugdeck step is declared done (dev esbuild is not sufficient).

#### Assumptions {#assumptions}

- The `GIT_DIFF` range descriptor (`{root, worktree, base, branch}` → `git diff base..branch`) accepts raw shas (`<sha>~1`..`<sha>`) as well as branch names, enabling per-commit diff expansion without a wire change. Verify at implementation; if not, per-commit diff expansion falls to the roadmap section.
- `claude` skill invocation `/tugplug:history <args>` reaches the session as a normal slash-command turn via `codeSessionStore.send()` (same as any typed `/tugplug:commit`).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows `tuglaws/devise-skeleton.md` v4: explicit `{#anchor}` headings, `[P##]` plan-local decisions, `[Q##]` open questions, `Spec S##`, `Table T##`, `Risk R##`, `Milestone M##`, `**Depends on:** #step-N` lines, and `**References:**` lines citing labels/anchors (never line numbers).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does the GIT_DIFF range descriptor accept raw shas? (OPEN → resolve in Step 8) {#q01-range-descriptor-shas}

**Question:** `DiffDescriptor` kind `"range"` (`tugdeck/src/lib/git-diff-store.ts`, key format `range:<root>:<worktree>:<base>:<branch>`) drives `git diff base..branch` server-side. Does the backend accept `base="<sha>~1"`, `branch="<sha>"`?

**Why it matters:** Per-commit expand-to-diff in the HistoryView reuses this path with zero wire changes if shas work.

**Plan to resolve:** Read the tugcast GIT_DIFF handler during Step 8; test with a sha pair in the running app. If refs-only, ship the HistoryView without inline diff bodies (subject/author/date/sha still render) and add sha support as a follow-on.

**Resolution:** RESOLVED (refs-only) in #step-8. The `range` descriptor's
server path (`build_dash_diff_snapshot` → `fetch_dash_diff`,
`tugcast/src/feeds/git.rs`) is **dash-shaped**: it resolves the diff through a
worktree + `merge-base(base, branch)`, not a two-dot `<sha>~1..<sha>` commit
diff. Feeding raw shas would only work via a fragile "pass a non-existent
worktree so it falls to the three-dot branch" hack. So per the resolution plan
the HistoryView ships **metadata-only** commit blocks (subject · author · date ·
full sha); inline per-commit diff bodies move to (#roadmap), which needs a
dedicated backend descriptor that runs `git diff <sha>~1..<sha>` directly.

#### [Q02] Where does `tugdash commit` learn the session display name? (DECIDED — see [P09]) {#q02-dash-session-name}

**Question:** The `Tug-Session:` trailer needs a display name + session id inside `tugdash-core`, which runs as a CLI in a Claude session.

**Resolution:** DECIDED (see [P09]) — resolve `TUG_SESSION_ID` from the environment and look up the display name read-only in `sessions.db`, the same pattern `dash_draft_message()` already uses (`tugdash-core/src/ops.rs`). Absent env/db → omit the trailer, never fail the commit.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Hoisting `RouteLifecycle` breaks route persistence/restore | med | low | Lifecycle object identity is all that moves; restore path (`setRoute` inside entry) unchanged | Route not restored after relaunch |
| Keeping three slot views mounted regresses perf | low | low | Changes/History views are small lists; transcript already always-mounted | Jank on route switch |
| Trailer append breaks existing commit-message tests/consumers | med | med | Trailers appended as a distinct `\n\n`-separated block; update fixtures in the same step | `cargo nextest` failures |
| Lens slimming orphans shared helpers still used by Changeset card | med | med | Port (don't move) shared pieces into `cards/session-changes/`; delete Lens copies only after ChangesView ships | vite build / tsc errors |

**Risk R01: Route restore vs. hoisted lifecycle** {#r01-route-restore}

- **Risk:** The prompt entry restores a persisted route via `routeLifecycle.setRoute(...)` during its restore pass; constructing the lifecycle in the card could race that.
- **Mitigation:** The card constructs the lifecycle with `DEFAULT_ROUTE` exactly as the entry does today and passes it down; the entry's restore pass is untouched and still the only writer at restore time.
- **Residual risk:** None identified — same object, same writers, different owner.

**Risk R02: One composer, several committable entries** {#r02-one-composer}

- **Risk:** The Lens gave each entry (session / dash / unattributed) its own composer; the card has ONE composer, so commit semantics must be unambiguous.
- **Mitigation:** [P05] — the composer commits the head selection (session + unattributed files, one selection set, one `changeset_commit`); dash entries carry their own inline Join affordance, never the composer.
- **Residual risk:** A project with several *open sessions* still shows only this card's session entry — cross-session files appear under other cards' Changes routes, which is the intended per-card scoping.

---

### Design Decisions {#design-decisions}

#### [P01] View-routes extend RouteLifecycle; pane tabs are not used (DECIDED) {#p01-view-routes}

**Decision:** `Changes` and `History` are two new entries in the existing route selector (`ROUTE_ITEMS` in `tugdeck/src/components/tugways/tug-prompt-entry.tsx`), driven by the same per-entry `RouteLifecycle` (`tugdeck/src/lib/route-lifecycle.ts`). They are *view-routes*: in addition to retargeting `performSubmit`, they swap the transcript slot's visible view.

**Rationale:**
- The route pipe already solves the hard part: one composer, one scalar, will/did observers, `useSyncExternalStore` reads ([D01]–[D03] in `route-lifecycle.ts`).
- A pane holds cards and each card owns its own composer (`tuglaws/pane-model.md`); pane tabs would swap the composer, violating the requirement that the prompt-entry stay in place.

**Implications:**
- Route values are single characters (persisted). New values: `±` (Changes), `↺` (History) — see Table T01.
- The route selector, keybinding map, route chrome manifest, submit-button mode, and Return semantics all gain entries.

#### [P02] The Session card owns the RouteLifecycle (DECIDED) {#p02-card-owns-lifecycle}

**Decision:** `RouteLifecycle` construction moves from inside `TugPromptEntry` (today: a lazy `useRef` around `new RouteLifecycle(DEFAULT_ROUTE)`) to `SessionCardBody`, passed down via a new optional prop `routeLifecycle?: RouteLifecycle`. When absent, `TugPromptEntry` constructs its own exactly as today (gallery unaffected).

**Rationale:**
- The transcript slot lives *outside* the prompt entry's subtree, but must react to the route. `RouteLifecycleContext` is provided inside `TugPromptEntry`; the card can't consume it.
- Hoisting the object (not the behavior) lets `SessionCardBody` read the route via `useSyncExternalStore(routeLifecycle.subscribe, routeLifecycle.getRoute)` with zero changes to switching, persistence, or restore (all still funnel through `setRoute` inside the entry).

**Implications:**
- `TugPromptEntryProps` gains `routeLifecycle?: RouteLifecycle`; the internal lazy `useRef` becomes "use prop if provided, else construct".
- Route restore/persist code inside the entry is untouched (see Risk R01).

#### [P03] View-route availability is host-gated (DECIDED) {#p03-host-gated-routes}

**Decision:** The base `ROUTE_ITEMS` stays the four target-routes. `TugPromptEntry` appends the two view-route items only when the host passes the view-route capabilities (the `changesController` prop for Changes; History requires only `codeSessionStore`, so it is gated on the same prop bundle for symmetry — a new `viewRoutes?: boolean` derived from the session card passing `changesController`).

**Rationale:** The gallery prompt entry and any future non-session host have no changeset plumbing; offering a route whose submit would dead-end is worse than not offering it.

**Implications:** Route menu length varies by host; `WIDEST_ROUTE_LABEL` derivation must include the conditional items when present.

#### [P04] Lens row click = activate + flash, via a registered action (DECIDED) {#p04-focus-session-card}

**Decision:** Add a registered action `focus-session-card` (in `tugdeck/src/action-dispatch.ts`, alongside `focus-pane`) taking `{ cardId }`. It runs `transferFocusForActivation({ …, commitMutation: () => deckManager.activateCard(cardId) })` (the same discipline as `focus-pane` / `new-text-card`), then triggers a one-shot title-bar flash by toggling a CSS class on the pane header DOM node (removed on `animationend`). The Lens row dispatches this action on click.

**Rationale:**
- `activateCard` alone reorders z-order but skips the responder-chain promotion; the `transferFocusForActivation` wrapper is the established pattern (see `focus-pane` in `action-dispatch.ts`).
- The flash is pure appearance → CSS + DOM, never React state ([L06]).

**Implications:** New `TUG_ACTIONS` entry; a keyframe animation in the pane chrome CSS; the action handler locates the pane header element from the deck DOM (pane roots carry identifying data attributes — reuse whatever `tug-pane.tsx` renders; add a `data-pane-id` if none exists).

#### [P05] One composer, head-selection commit; dash join is inline (DECIDED) {#p05-composer-semantics}

**Decision:** On the Changes route the composer is the commit-message editor for the **head selection**: the card session's changed files plus the project's unattributed files, one selection set, one `changeset_commit`. Dash entries render in the ChangesView with their own inline **Join** affordance (`changeset_join` verb, preview → execute, same ladder as the Lens today) and never the composer. The Lens's per-entry commit composer (`EntryBody`'s `commitComposer` block in `sessions-section.tsx`) is not ported — its pin/draft/receipt semantics move into the prompt-entry integration (see [P06]).

**Rationale:**
- `changeset_commit { project_dir, files, message }` commits repo-relative paths regardless of attribution, so one selection spanning session + unattributed files is one wire call.
- A join is a distinct verb with its own preview/conflict ladder — bolting it onto the submit button would overload one gesture with two irreversible operations.

**Implications:** `ChangesRouteController` (see [P07]) owns the selection set and the entry identity; the submit branch reads it. Dash join UI is a straight port of `DashActions` from `sessions-section.tsx` into the ChangesView.

#### [P06] AI draft streams into the composer editor with pin semantics (DECIDED) {#p06-draft-into-composer}

**Decision:** A **Generate** button renders to the LEFT of the Z5 submit button (inside `TugPromptEntry`, route-conditional on Changes). It calls `ChangesetDraftStore.requestDraft(projectDir, "session", tugSessionId)` (the existing on-demand engine); the streamed `changeset_draft_delta` text flows into the prompt-entry editor **while the editor is pristine** — a user edit pins the field (drafts stop flowing); Generate explicitly unpins first. A landed commit clears + unpins. This ports the exact pin semantics from the Lens `EntryBody` (`pinned` state, `restoreState` programmatic seeding that doesn't read as a user edit).

**Rationale:**
- The draft engine, wire frames, overlay store (`tugdeck/src/lib/changeset-draft-store.ts`), and persistence (`changeset_drafts` table) all ship today — this is presentation-only reuse.
- "User can read, approve, edit, or replace" falls directly out of pin semantics.

**Implications:**
- `TugPromptEntry` needs a programmatic text-seed path that does not disturb history/draft persistence semantics — the substrate editor already has a programmatic restore (used by the entry's own draft-restore pass); expose it internally to the changes-route effect.
- The Generate button is width-stabilized and disabled while drafting; drafting state renders via the existing overlay phases.
- Submit-button label on the Changes route reads **Commit** (width-stabilized against "Committing…").

#### [P07] ChangesRouteController lives in the per-card services bag (DECIDED) {#p07-changes-controller}

**Decision:** Add a `ChangesRouteController` (new file `tugdeck/src/lib/changes-route-controller.ts`) to `CardServices` (`tugdeck/src/lib/card-services-store.ts`). It is a plain subscribable store ([L02]) constructed with the binding's `{ tugSessionId, workspaceKey, projectDir }`. It does **not** open a feed of its own: the per-workspace `CHANGESET` feed (0x23) is retired (`tugcast-core/src/protocol.rs` — "never reuse 0x23"); the controller subscribes to the existing app-level `ChangesetAllStore` singleton (`tugdeck/src/lib/changeset-all-store.ts`, `CHANGESET_ALL` 0x24 — the same store the Lens reads via `useChangesetAll`) and derives its slice as a filtered projection. It exposes:
- `getSnapshot()` → `{ entry, dashes, unattributed, project }` derived from the `CHANGESET_ALL` snapshot by `project.workspace_key === workspaceKey`, session entry by `owner_id === tugSessionId` (placeholder-project fallback exactly as the Lens's `buildItems` does when the feed hasn't emitted the project yet);
- selection state: `selectedPaths()`, `setSelected(path, on)`, with the Lens default rule (selected unless `ambiguous || shared`);
- `commit(message)` → `getChangesetVerbStore().commit(entryKey, projectDir, selectedPaths, message)` with `entryKey = "session:" + tugSessionId`, plus the commit trailer fields ([P08]);
- `requestDraft()` → `getChangesetDraftStore().requestDraft(projectDir, "session", tugSessionId)`;
- pass-throughs for commit phase (`useChangesetCommit`) and draft overlay (`useChangesetDraft`) keys so the view and the entry read one identity.

**Rationale:**
- `performSubmit` (inside `TugPromptEntry`) needs the selection at submit time; the ChangesView needs it for checkboxes. A shared per-card store is the [L02]-conformant meeting point.
- The services bag already constructs per-card stores and owns dispose (`FILETREE`, `GIT_DIFF` — same lifecycle pattern); riding the existing `CHANGESET_ALL` singleton means zero new wire subscriptions and the controller updates on every changeset recompute for free.

**Implications:** `TugPromptEntryProps` gains `changesController?: ChangesRouteController`; `CardServices` gains the field; dispose unsubscribes the controller from `ChangesetAllStore` and tears it down. No new `FeedStore`.

#### [P08] Trailers are appended server-side / library-side, never client-side (DECIDED) {#p08-trailers-serverside}

**Decision:** Machine-parseable git trailers ride every tugutil commit path, appended where the commit is made:
- **Deck commits:** the `changeset_commit` CONTROL payload gains optional `session_name` and `session_id` fields (sent by `ChangesRouteController.commit`, from the CHANGESET entry's `display_name` + `owner_id`; the Changeset card may adopt them later). `do_changeset_commit` (`tugrust/crates/tugcast/src/feeds/agent_supervisor.rs`) appends `Tug-Session: <name> (<id>)` to the message before `run_changeset_commit`.
- **Dash round commits:** `tugdash_core::ops::commit()` appends `Tug-Session:` (from `TUG_SESSION_ID` env + a read-only `sessions.db` name lookup, per [P09]) and `Tug-Dash: <branch> onto <base>`.
- **Dash join/squash:** `integrate_message()` output gains a body block with `Tug-Dash: <branch> onto <base>` (and `Tug-Session:` when resolvable).

Trailer format follows git's trailer convention: a final paragraph (blank-line separated) of `Key: value` lines, so `git log --format=%(trailers:key=Tug-Session)` and `--grep` both work. Appending is idempotent — skip a key already present in the message.

**Rationale:**
- Client-side appending would put trailer text in the user-editable composer (deletable, duplicable); the commit sites are the single choke points.
- Trailers, not prose, so the `/tugplug:history` skill can filter mechanically.

**Implications:** Wire-payload parser (`parse_changeset_commit_payload`) gains two optional fields; `tugmark_core::commit` is untouched (the enriched message arrives as `message`); Rust tests assert trailer presence and idempotence.

#### [P09] Dash-side session identity comes from env + sessions.db (DECIDED) {#p09-dash-session-identity}

**Decision:** In `tugdash-core`, resolve the committing session as: `TUG_SESSION_ID` env var → session display name via a read-only `sessions.db` query (same connection pattern as `dash_draft_message()` in `ops.rs`). Any absence (no env, no db, no row) omits the `Tug-Session:` trailer silently; the commit never fails on trailer resolution.

**Rationale:** `tugdash commit` runs inside a Claude session where tugcast exports `TUG_SESSION_ID` (the same env parity the Shell route fix established); `dash_draft_message()` proves the read-only db pattern.

**Implications:** A small `session_trailer()` helper in `ops.rs`; tests cover present/absent env.

#### [P10] History submit sends `/tugplug:history` on the record (DECIDED) {#p10-history-on-record}

**Decision:** On the History route, `performSubmit` sends `codeSessionStore.send("/tugplug:history " + submitText, [])` — a normal on-record turn. A new agentless skill `tugplug/skills/history/SKILL.md` instructs Claude to (1) gather git context first — `tugmark log --json`, `tugmark context --json`, targeted `git log --grep="Tug-Session" / --grep=<term>`, `git show <sha>` against the project path — then (2) answer the user's question about commits, file history, and prior work, citing shas.

**Rationale:** User decision: history answers must be on the record; Claude sees everything. A skill that searches-then-answers keeps the git plumbing in real commands rather than pre-baked context.

**Implications:** New skill directory modeled on `tugplug/skills/commit/`; the transcript shows the turn normally (the HistoryView is hidden only while the History route is active — the user can flip to `❯` to watch the turn, or we rely on the route staying put and the answer being read later; see [P11]).

#### [P11] Submitting a History question flips the card to the Code route (DECIDED) {#p11-history-submit-flips}

**Decision:** After a successful History-route submit, the entry calls `routeLifecycle.setRoute(DEFAULT_ROUTE)` so the transcript (where the answer streams) is visible.

**Rationale:** The question/answer live in the transcript; leaving the HistoryView up would hide the very answer the user asked for. The route selector makes returning to History one gesture.

**Implications:** One `setRoute` call in the history submit branch; the "route is a sticky preference, don't reset on submit" comment gains an explicit view-route exception.

#### [P12] The Lens phase dot reads per-card stores through cardServicesStore (DECIDED) {#p12-lens-phase-source}

**Decision:** No new phase registry. The slim Lens row resolves its session's `cardId` from `cardSessionBindingStore`, then reads `cardServicesStore.getServices(cardId)?.codeSessionStore` (`tugdeck/src/lib/card-services-store.ts`, module-scope singleton `cardServicesStore`) and subscribes per-row via `useSyncExternalStore` to derive `SessionPhaseInput = { phase, transportState, interruptInFlight }` → `sessionSessionPhaseKey` / `sessionSessionPhaseVisual` (`tugdeck/src/lib/code-session-store/session-phase-visual.ts`).

**Rationale:** `CardServicesStore` already *is* the app-level registry of per-card session stores, constructed/disposed on binding changes; inventing a parallel phase registry would duplicate it.

**Implications:** A row whose services bag is not yet constructed renders the dot in the `offline`/quiet visual; pulse text (`pulse-store.ts`) and sparkline (`session-activity-store.ts`) are already app-level singletons keyed by `tugSessionId` — read directly.

---

### Deep Dives {#deep-dives}

#### Route table {#route-table}

**Table T01: Session-card routes after this phase** {#t01-routes}

| value | label | kind | shortcut | Return | submit target | slot view |
|---|---|---|---|---|---|---|
| `❯` | Code | target | ⇧⌘C | newline | `codeSessionStore.send` | transcript |
| `$` | Shell | target | ⇧⌘S | submit | `shellSessionStore.exec` | transcript |
| `?` | btw | target | ⇧⌘B | submit | `/btw` RUN_SLASH_COMMAND | transcript |
| `⌕` | Find | target | ⇧⌘F | newline | `findSession.next()` | transcript |
| `±` | Changes | view | ⇧⌘E | newline | `changesController.commit(message)` | ChangesView |
| `↺` | History | view | ⇧⌘Y | newline | `codeSessionStore.send("/tugplug:history …")` | HistoryView |

Notes: shortcuts extend `keybinding-map.ts` (`tugdeck/src/components/tugways/keybinding-map.ts`, the SELECT_ROUTE block); `±`/`↺` are the stored/persisted route characters; both new routes use `newline` Return semantics (multi-line commit bodies; long-form questions) so Shift+Return / the Z5 button submits, matching `❯`. Icons: lucide `GitCommitHorizontal` (Changes), `History` (History) — or the nearest existing choices in the codebase's icon set.

#### Submit dispatch order in performSubmit {#submit-dispatch-order}

`performSubmit` (`tugdeck/src/components/tugways/tug-prompt-entry.tsx`) currently branches: accept-completion → Find → clear one-shot finds → btw → local slash-commands → gates → Shell → default `send()`. The two view-route branches slot in **after the btw branch and before the local slash-command interception** (a Changes-route submit is a commit message — `/foo` in a commit message must not run a slash command; same for History questions, which are wrapped in the skill invocation anyway):

- **Changes branch:** route `±` and `changesController` present → validate (non-empty trimmed message, ≥1 selected path, commit phase not pending) → `changesController.commit(message)` → push history (route `±`, raw message) → clear editor → return. An invalid state is a no-op (the Z5 button is disabled in those states anyway; the Return path needs the same gate).
- **History branch:** route `↺` → **send-readiness gates first**, mirroring the default `send()` path: bail if `resolveSubmitButtonView(submitButtonModeRef.current).disabled`; apply the blocked-submit logic (`!snap.canSubmit && !snap.canInterrupt` → drop on `replaying`, defer via `pendingSubmitRef` otherwise — `classifyBlockedSubmit`, exactly as the default path). A turn in flight is NOT blocked (`send()` queues mid-turn). Passing the gates → wrap: `codeSessionStore.send("/tugplug:history " + submitText, [])` → push history (route `↺`, raw question) → clear → `routeLifecycle.setRoute(DEFAULT_ROUTE)` ([P11]) → return. Without these gates a submit during replay or transport-settling would leak a turn.

**No slash interception on view-routes (requirement, not an accident of ordering):** on `±` a commit message beginning with `/` must never run a local slash command, and on `↺` the question is always wrapped in the skill invocation — both branches consume the draft and `return` before the local-command interception block, and the interception's route guard (`routeAllowsLocal`) must additionally exclude `ROUTE_CHANGES`/`ROUTE_HISTORY` so the invariant survives future reordering of `performSubmit`.

The route-aware Z5 mode (`routeAwareSubmitButtonMode`) gains cases: Changes → `{ kind: "submit" }` disabled while commit `pending` / empty selection (label "Commit"/"Committing…"); History → follows the Claude mode (a question is a turn).

#### Transcript slot mechanics {#transcript-slot}

`SessionCardBody` render (`tugdeck/src/components/tugways/cards/session-card.tsx`) currently mounts `<SessionTranscriptHost ref={transcriptRef} …/>` directly in `.session-card-top-column`. It becomes a slot wrapper:

```tsx
<div className="session-view-slot" data-active-view={activeView /* "transcript" | "changes" | "history" */}>
  <div className="session-view-pane" data-view="transcript"><SessionTranscriptHost …/></div>
  <div className="session-view-pane" data-view="changes"><SessionChangesView …/></div>
  <div className="session-view-pane" data-view="history"><SessionHistoryView …/></div>
</div>
```

- `activeView` derives from `useSyncExternalStore(routeLifecycle.subscribe, routeLifecycle.getRoute)` in `SessionCardBody` ([P02]): `±` → changes, `↺` → history, else transcript.
- CSS hides inactive panes (`.session-view-pane:not([data-view=<active>]) { display:none }` expressed via the `data-active-view` attribute selector). All three stay mounted — scroll, selection, and streaming state survive; transcript mount identity is stable ([L26]).
- `transcriptRef` calls (`scrollToBottom` etc.) already null-check; they keep targeting the transcript regardless of the active view.
- The find overlay, Z2 status bar, and PULSE strip stay outside the slot (unchanged); `FindWrapOverlay` only matters on the transcript view, which is fine — Find is a target-route.
- Lazy-mount option (render Changes/History panes only after first activation, then keep mounted) is acceptable if measured mount cost warrants; default is mount-all for simplicity.

#### What moves out of sessions-section.tsx {#sessions-section-inventory}

The Lens section's parts and their destinations:

| Piece (in `sessions-section.tsx`) | Destination |
|---|---|
| `SessionsFileBlock`, `FilePathLink`, `FileSelectCheckbox`, `PopOutDiffButton`, status glyph/tone helpers | ported to `tugdeck/src/components/tugways/cards/session-changes/` (new dir), consumed by ChangesView |
| `EntryBody` file list + expand/collapse + `useEntryDiff`/`getEntryDiffStore` eager-fetch | ported into ChangesView (per-file diff expansion identical) |
| `EntryBody` commit composer (`BlockChrome` "Commit message", pin semantics, receipt) | replaced by the prompt-entry integration ([P05]/[P06]); receipt renders in ChangesView |
| `DashActions` (join preview/execute/release + resolution ladder hooks) | ported into ChangesView for dash entries |
| `SessionsEntryBlock`, `EntryIdentity`, `ItemGlyph`, `itemStatusHint`, collapse store, header actions | deleted with the slimming; the new monitor row is written fresh (small) |
| `buildItems` (CHANGESET_ALL + bindings join) | Lens keeps a slimmed variant (rows only, no files); ChangesView uses `ChangesRouteController`'s single-workspace derivation instead |
| `NonRepoBody` (git init affordance) | ported to ChangesView (the `changeset_git_init` verb store is app-level) |

Port = copy into the new home, adapt, and delete the Lens original in the slimming step — never leave two live copies.

#### HistoryView shape {#historyview-shape}

- Data: the shared `gitLogStore()` (`tugdeck/src/lib/git-log-store.ts`) — `requestLog(projectDir)` (idempotent), `GIT_HEAD` signal → `refresh()`. The card knows its own `projectDir` from the binding; the Lens-follow indirection (`useFollowedProject` in `git-history-section.tsx`) dies with the section.
- Render: one `BlockChrome`/`BlockHeader` (BlockStrip family, `leaf` altitude) per `GitLogCommit { sha, subject, author, date }`: name = subject, detail = `sha.slice(0,10) · author · date`. Blocks render **expanded by default** per the phase brief ("display each commit as an expanded tool call block") — body shows the full sha + (pending [Q01]) the commit's diff via a range descriptor `{root: projectDir, worktree: projectDir, base: "<sha>~1", branch: "<sha>"}` fetched on expand, with the same `PopOutDiffButton` pop-out affordance.
- Branch/no-repo/loading/error states: port the empty-state notices from `git-history-section.tsx`.
- The list is a plain scroll (real heights, no windowing).

#### Slim Lens Sessions row {#slim-lens-row}

One row per open session binding (dedupe by `tugSessionId`, exactly `buildItems`' binding walk):

`[phase dot] [display_name] [project · branch] ..... [pulse text] [sparkline]`

- Dot: `TugProgressIndicator variant="pulsing-dot" size={12} phase={sessionSessionPhaseKey(input)} phaseVisual={sessionSessionPhaseVisual}` with input per [P12].
- Name/context: the CHANGESET_ALL feed still decorates `display_name` + branch (the Lens keeps its `useChangesetAll()` read for labels only), falling back to the binding placeholder exactly as today.
- Pulse text: latest `pulse-store` line for the `tugSessionId` (reuse `renderPulseLine`; a static latest-line read is enough — no dwell queue needed in the Lens).
- Sparkline: `TugSparkline` over `getSessionActivityStore().compositeSeries(tugSessionId, nowMs)` with the same constants as `session-pulse-strip.tsx` (`ACTIVITY_BIN_MS`, full-scale 1200, gamma 0.6 curve), width ~64.
- Row is read-only (`data-tug-focus="refuse"` like today's rows); click anywhere dispatches `focus-session-card { cardId }` ([P04]).
- Dash and unattributed pseudo-entries disappear from the Lens (they live on the card now). Collapsed summary becomes "N sessions".

---

### Specification {#specification}

#### Wire contract deltas {#wire-deltas}

**Spec S01: `changeset_commit` payload extension** {#s01-changeset-commit-payload}

```
{ action: "changeset_commit", project_dir, files: [..], message,
  session_name?: string, session_id?: string }        // NEW, optional
```

`do_changeset_commit` appends, when `session_name`/`session_id` present and the message lacks a `Tug-Session:` trailer:

```
<message>

Tug-Session: <session_name> (<session_id>)
```

Replies (`changeset_commit_ok`/`_err`) unchanged. Absent fields → today's behavior byte-for-byte.

**Spec S02: Trailer block format** {#s02-trailer-format}

- Trailers form the final paragraph (preceded by a blank line), one `Key: value` per line, keys `Tug-Session`, `Tug-Dash`.
- `Tug-Session: <display_name> (<session-id>)`
- `Tug-Dash: <branch> onto <base>` (e.g. `Tug-Dash: tugdash/fix-thing onto main`)
- Idempotent append: a message already containing `^Tug-Session:` (multiline regex) does not get a second one; same per-key.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| active route (`±`/`↺`/…) | local-data (per-entry) | existing `RouteLifecycle` store + `useSyncExternalStore` | [L02] |
| active slot view visibility | appearance | `data-active-view` attribute + CSS display rules | [L06] |
| changes selection set | local-data (per-card) | `ChangesRouteController` store + `useSyncExternalStore` | [L02] |
| changeset snapshot (files/dashes/unattributed) | external | existing `ChangesetAllStore` (0x24), projected by `ChangesRouteController` | [L02] |
| commit round-trip phase | external | existing `ChangesetVerbStore` (CONTROL frames) | [L02] |
| draft overlay (streaming text) | external | existing `ChangesetDraftStore` | [L02] |
| composer pin state | local-data (per-entry) | `useState` inside the changes-route effect | [L24] |
| git log snapshot | external | existing `GitLogStore` (GIT_LOG feed) | [L02] |
| per-commit diff bodies | external | existing `GitDiffStore` request/response | [L02] |
| Lens row phase dot | external | `cardServicesStore.getServices(cardId).codeSessionStore` via `useSyncExternalStore` | [L02] |
| title-bar flash | appearance | CSS class toggle on pane header DOM, removed on `animationend` | [L06] |
| per-file expand/collapse in ChangesView | local-data | `useState` set (ported from `EntryBody`) | [L24] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/changes-route-controller.ts` | Per-card Changes-route store ([P07]): CHANGESET-scoped snapshot, selection, commit/draft triggers |
| `tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx` | ChangesView (file rows, diffs, selection, dash join, receipt, git-init) |
| `tugdeck/src/components/tugways/cards/session-changes/` (supporting files) | Ported `SessionsFileBlock`, `FilePathLink`, checkbox, dash actions, helpers |
| `tugdeck/src/components/tugways/cards/session-history/session-history-view.tsx` | HistoryView (per-commit BlockChrome blocks over GitLogStore) |
| `tugplug/skills/history/SKILL.md` | `/tugplug:history` — search git context (tugmark, git log/show), then answer |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `ROUTE_CHANGES = "±"`, `ROUTE_HISTORY = "↺"` | const | `tug-prompt-entry.tsx` | + conditional `ROUTE_ITEMS` entries ([P03]), `RETURN_ACTION_BY_ROUTE` entries |
| `TugPromptEntryProps.routeLifecycle?` | prop | `tug-prompt-entry.tsx` | [P02] hoist |
| `TugPromptEntryProps.changesController?` | prop | `tug-prompt-entry.tsx` | [P07]; also gates view-routes ([P03]) |
| `performSubmit` changes/history branches | fn edit | `tug-prompt-entry.tsx` | see (#submit-dispatch-order) |
| `routeAwareSubmitButtonMode` | fn edit | `tug-prompt-entry.tsx` | Commit / question modes |
| Generate button (Z5-left, route-conditional) | JSX | `tug-prompt-entry.tsx` | [P06] |
| SELECT_ROUTE bindings ⇧⌘E / ⇧⌘Y | entries | `components/tugways/keybinding-map.ts` | Table T01 |
| `SessionRouteChromeManifest` route cases | edit | `components/tugways/cards/chrome/session-route-chrome-manifest.tsx` | chips + placeholder text per new route |
| `ChangesRouteController` | class | `lib/changes-route-controller.ts` | [P07] — filtered projection over `ChangesetAllStore` (0x24); no new feed |
| `CardServices.changesController` | field | `lib/card-services-store.ts` | construct/dispose (unsubscribe from `ChangesetAllStore`) |
| `SessionChangesView`, `SessionHistoryView` | components | `cards/session-changes/`, `cards/session-history/` | slot views |
| session-view-slot wrapper + CSS | JSX/CSS | `session-card.tsx` + card CSS | (#transcript-slot) |
| `focus-session-card` action + flash CSS | action | `action-dispatch.ts`, pane chrome CSS | [P04] |
| Slim `SessionsSectionBody` rows | rewrite | `lens/sections/sessions-section.tsx` | (#slim-lens-row) |
| delete `registerGitHistorySection` | removal | `lens/sections/git-history-section.tsx`, `main.tsx` | keep `git-log-store.ts` |
| `parse_changeset_commit_payload` + `do_changeset_commit` | fn edit | `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` | Spec S01 |
| `append_trailers(message, &[(key, value)])` | fn | shared: `tugmark-core/src/git.rs` (or a small `trailer.rs`) | Spec S02, idempotent; used by tugcast + tugdash-core |
| `ops::commit` trailer append, `session_trailer()` | fn edit/new | `tugrust/crates/tugdash-core/src/ops.rs` | [P08]/[P09] |
| `integrate_message` trailer append | fn edit | `tugrust/crates/tugdash-core/src/ops.rs` | [P08] |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | Trailer append/idempotence; payload parsing; `integrate_message`/`ops::commit` message composition against real scratch repos | Steps 10–11 |
| **Unit (TS, bun test)** | `ChangesRouteController` derivations (selection defaults, entry filtering) against golden CHANGESET fixtures; route-table helpers (`routeAwareSubmitButtonMode` cases) | Steps 2, 4 |
| **Integration (Rust)** | `run_changeset_commit` with trailer-enriched message commits + trailer visible in `git log` (extends existing tests in `feeds/changeset.rs`) | Step 10 |
| **App-test** | Route switch swaps slot views; Changes-route commit round-trip against a scratch repo; Lens row click activates the card | Step 12 |

#### What stays out of tests {#test-non-goals}

- jsdom render tests / mock-store assertions — banned pattern; view behavior is covered by app-tests driving the real app.
- The scribe/draft engine itself — already covered; we only reuse its request/overlay surface.
- Real-Claude `/tugplug:history` answers — on-demand only; the skill file is reviewed, not app-tested.
- Long-lived changeset UI flows in app-tests — changeset entries in the replay workspace live ~2s; cover commit round-trips at the Rust layer and use scratch repos for the app-test commit.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Frontend steps must pass `bunx vite build`; Rust steps must pass `cd tugrust && cargo nextest run`.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Hoist RouteLifecycle to the Session card | done | 00bb31e1a |
| #step-2 | Define the two view-routes (selector, keys, chrome, submit modes) | done | b44a3cff9 |
| #step-3 | Route-driven transcript slot (empty views) | done | f0134d2a7 |
| #step-4 | ChangesRouteController + services wiring | done | 526d909bb |
| #step-5 | ChangesView (files, diffs, selection, dash join, git-init) | done | 78ca8efc9 |
| #step-6 | Changes composer: commit submit + Generate draft | done | 61192ebfb |
| #step-7 | Integration checkpoint: Changes route end-to-end | deferred | live verify at phase-3 build |
| #step-8 | HistoryView (per-commit blocks) | done | e8b0b5438 |
| #step-9 | History submit + /tugplug:history skill | done | 65afeeaa4 |
| #step-10 | Trailers: changeset_commit path | done | 71d1fc528 |
| #step-11 | Trailers: tugdash commit + join paths | done | 238b941cd |
| #step-12 | Slim the Lens: monitor rows + delete Git History section | done | 7aeae7e22 |
| #step-13 | Integration checkpoint: full phase | done | N/A (verify-only) |

#### Step 1: Hoist RouteLifecycle to the Session card {#step-1}

**Commit:** `tugdeck(routes): SessionCardBody owns the prompt entry's RouteLifecycle [L02]`

**References:** [P02] Card owns lifecycle, Risk R01, (#transcript-slot, #route-table)

**Artifacts:**
- `TugPromptEntryProps.routeLifecycle?: RouteLifecycle`; internal construction becomes prop-or-own.
- `SessionCardBody` constructs the lifecycle (lazy ref, `DEFAULT_ROUTE`) and passes it to `TugPromptEntry`; exports nothing else yet.

**Tasks:**
- [ ] Add the optional prop; keep the entry's lazy `useRef` fallback for hosts that don't pass one (gallery `gallery-prompt-entry.tsx` unchanged).
- [ ] In `SessionCardBody` (`session-card.tsx`), create the lifecycle and pass it down. Export `DEFAULT_ROUTE` (or a shared route-constants module) if needed to avoid a magic string.
- [ ] Confirm route persistence/restore still works (restore pass calls `setRoute` inside the entry; the object identity is the only change).

**Tests:**
- [ ] Existing prompt-entry route tests still pass (bun test).

**Checkpoint:**
- [ ] `bunx vite build`
- [ ] In the app: route selector still switches `❯/$/?/⌕`; route survives relaunch.

---

#### Step 2: Define the two view-routes {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(routes): add Changes (±) and History (↺) view-routes to the selector, keys, and chrome`

**References:** [P01] View-routes, [P03] Host-gated, Table T01, (#submit-dispatch-order)

**Artifacts:**
- `ROUTE_CHANGES`/`ROUTE_HISTORY` constants; conditional `ROUTE_ITEMS` entries (gated on the host passing `changesController` — stub-accept the prop now, wired in #step-4); `RETURN_ACTION_BY_ROUTE` entries (`newline` both).
- Keybindings ⇧⌘E / ⇧⌘Y in `keybinding-map.ts` (SELECT_ROUTE block).
- `SessionRouteChromeManifest` + `SessionRouteIndicatorBadge` cases; per-route placeholder text (`placeholderByRoute`): Changes → "Commit message", History → "Ask about commits, files, prior work".
- `routeAwareSubmitButtonMode` cases (Changes → Commit label semantics; History → follows Claude mode). Submit branches land in #step-6/#step-9; until then the new routes' submit is a guarded no-op.

**Tasks:**
- [ ] Extend `ROUTE_ITEMS` construction to append view-route items when gated in; recompute `WIDEST_ROUTE_LABEL` over the effective list.
- [ ] Keybindings + `preventDefaultOnMatch`, mirroring the existing four.
- [ ] Route chrome: pick the Z4B chip set per new route (project/cwd chips make sense for both; model/mode/effort chips only for History since it sends a turn).
- [ ] Unit-test `routeAwareSubmitButtonMode` new cases.

**Tests:**
- [ ] bun test: route-mode unit tests.

**Checkpoint:**
- [ ] `bunx vite build`
- [ ] In the app: selector shows 6 routes on a session card, 4 in the gallery; ⇧⌘E/⇧⌘Y switch; Z4B chips change per route.

---

#### Step 3: Route-driven transcript slot (empty views) {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(session-card): route-driven view slot swaps transcript/changes/history, all kept mounted [L26][L06]`

**References:** [P01], [P02], (#transcript-slot), State Zone Mapping

**Artifacts:**
- `session-view-slot` wrapper in `session-card.tsx` around `SessionTranscriptHost` plus two placeholder views (`SessionChangesView`, `SessionHistoryView` rendering a stub); `data-active-view` CSS in the session-card stylesheet.

**Tasks:**
- [ ] `SessionCardBody` reads the route via `useSyncExternalStore` on the hoisted lifecycle; derive `activeView`.
- [ ] All three panes mounted; CSS-only hiding; verify transcript scroll position survives a `±` → `❯` round trip.
- [ ] `transcriptRef` calls unchanged (already null-safe); find overlay / Z2 / PULSE remain outside the slot.

**Tests:**
- [ ] None beyond build (placeholder views).

**Checkpoint:**
- [ ] `bunx vite build`
- [ ] In the app: switching routes swaps the slot; scroll position and in-progress composer text survive round trips.

---

#### Step 4: ChangesRouteController + services wiring {#step-4}

**Depends on:** #step-1

**Commit:** `tugdeck(changes): per-card ChangesRouteController as a filtered projection over ChangesetAllStore [L02]`

**References:** [P05], [P07], Spec S01 (fields sent in #step-10), (#sessions-section-inventory)

**Artifacts:**
- `lib/changes-route-controller.ts`; `CardServices.changesController` in `card-services-store.ts` (construct with the binding, subscribe to the app-level `ChangesetAllStore` singleton — NO new `FeedStore`; `CHANGESET` 0x23 is retired); dispose unsubscribes.
- `SessionCardBody` passes `changesController` into `TugPromptEntry` (un-gating the view-routes from #step-2) and into the slot views.

**Tasks:**
- [ ] Derivation: from the `CHANGESET_ALL` (`WorkspacesChangesetSnapshot`) singleton, select this card's project by `workspace_key === binding.workspaceKey`, the session entry by `owner_id === tugSessionId`, dash entries, unattributed files, project header — mirroring `buildItems` scoped to one workspace, including its placeholder-project fallback (cite `tugdeck/src/lib/changeset-types.ts` for the wire types).
- [ ] Selection: default rule `!ambiguous && !shared` for session files, `true` for unattributed; overrides map; `selectedPaths()`.
- [ ] Triggers: `commit(message)` → `ChangesetVerbStore.commit("session:"+tugSessionId, projectDir, selectedPaths, message)`; `requestDraft()` → `ChangesetDraftStore.requestDraft(projectDir, "session", tugSessionId)`.
- [ ] Unit tests against golden CHANGESET fixtures (reuse the fixture corpus guarding `changeset-types.ts`).

**Tests:**
- [ ] bun test: derivation + selection defaults + entry filtering.

**Checkpoint:**
- [ ] `bunx vite build`
- [ ] bun test passes.

---

#### Step 5: ChangesView {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `tugdeck(changes): ChangesView — file rows, inline diffs, selection, dash join, git-init ported from the Lens`

**References:** [P05], Risk R02, (#sessions-section-inventory), State Zone Mapping

**Artifacts:**
- `cards/session-changes/session-changes-view.tsx` + ported supporting components (file block, path link, checkbox, pop-out diff, dash actions, non-repo body).

**Tasks:**
- [ ] Port the pieces named in (#sessions-section-inventory) from `lens/sections/sessions-section.tsx` into `cards/session-changes/` (copy + adapt; Lens originals stay live until #step-12).
- [ ] Wire to `changesController`: file rows with selection checkboxes (session + unattributed), per-file diff expansion via `getEntryDiffStore` exactly as `EntryBody` does today, Expand/Collapse All, whole-entry pop-out.
- [ ] Dash entries: rounds/worktree header + `DashActions` port (join preview/execute via `useChangesetJoin`, release via `useChangesetRelease`, the AI-resolution ladder entry point unchanged).
- [ ] Commit receipt panel (sha + numstat + dismiss) rendered in the view, reading `useChangesetCommit("session:"+tugSessionId)`.
- [ ] Non-repo project → git-init affordance (`useChangesetGitInit`).
- [ ] Focus discipline: rows `data-tug-focus="refuse"`; any editing surface registers substrate responders.

**Tests:**
- [ ] bun test where logic is extracted (status tone/glyph helpers ride along with their existing tests if any).

**Checkpoint:**
- [ ] `bunx vite build`
- [ ] In the app (this repo as the project): `±` route lists this session's changed files with checkboxes; diffs expand; pop-out opens a Diff card.

---

#### Step 6: Changes composer — commit submit + Generate draft {#step-6}

**Depends on:** #step-5

**Commit:** `tugdeck(changes): composer commits the selection; Generate streams the AI draft into the editor [P06]`

**References:** [P05], [P06], (#submit-dispatch-order), Table T01

**Artifacts:**
- `performSubmit` Changes branch; Generate button left of Z5 (route-conditional); pin-semantics effect streaming the draft overlay into the editor; Z5 "Commit"/"Committing…" width-stabilized labels.

**Tasks:**
- [ ] Submit branch per (#submit-dispatch-order): gate (message non-empty, ≥1 selected, not pending) → `changesController.commit(trimmed)` → history push (route `±`) → clear. The branch runs BEFORE the local slash-command interception, and `routeAllowsLocal` excludes `ROUTE_CHANGES` explicitly — a commit message starting with `/` must never run a slash command.
- [ ] Generate button: disabled while drafting; click = unpin + `changesController.requestDraft()`. Reuse `TugPushButton` with `widthStabilize`.
- [ ] Pin semantics ported from `EntryBody`: pristine follows `useChangesetDraft(projectDir,"session",tugSessionId)` streamed text via the editor's programmatic restore (must not fire onChange/pin); user edit pins; landed commit clears + unpins; "Use latest draft" affordance when pinned and a newer draft exists.
- [ ] Draft/commit errors surface via the pane bulletin (calm, dismissible), not the session-lost banner.
- [ ] Confirm the changes-route editor draft does NOT leak into the `❯` route's persisted draft (route-keyed history/draft separation already exists via `HISTORY_KEY_SEP`; verify).

**Tests:**
- [ ] bun test: submit-gate logic if extracted; otherwise covered by #step-7.

**Checkpoint:**
- [ ] `bunx vite build`

---

#### Step 7: Integration checkpoint — Changes route end-to-end {#step-7}

**Depends on:** #step-6

**Commit:** `N/A (verification only)`

**References:** [P05], [P06], (#success-criteria)

**Tasks:**
- [ ] In a scratch git repo project: open a session card, edit files via the session, flip to `±`, deselect one file, Generate a draft, edit it, submit → verify `git log -1 --stat` shows exactly the selected files and the edited message.
- [ ] Dash-bound project: join preview + execute round-trip from the ChangesView.

**Tests:**
- [ ] App-test (if the scratch-repo flow is stable within the transient-workspace constraint; else record a manual verification in the commit that closes #step-6 and cover the round-trip at the Rust layer in #step-10).

**Checkpoint:**
- [ ] `bunx vite build`; manual end-to-end pass recorded.

---

#### Step 8: HistoryView {#step-8}

**Depends on:** #step-3

**Commit:** `tugdeck(history): HistoryView — per-commit BlockStrip blocks over GIT_LOG for the card's own project`

**References:** [Q01], (#historyview-shape), State Zone Mapping

**Artifacts:**
- `cards/session-history/session-history-view.tsx`; per-commit expand-to-diff (contingent on [Q01]).

**Tasks:**
- [ ] `requestLog(projectDir)` on mount + on `GIT_HEAD` signal (`useGitHeadRefresh` pattern from `git-history-section.tsx`); render `GitLogCommit` rows as `BlockChrome` leaf blocks, expanded by default.
- [ ] Resolve [Q01]: try a range descriptor with `<sha>~1`/`<sha>`; wire expand-to-diff + pop-out if it works, else ship metadata-only bodies and add the diff to (#roadmap).
- [ ] Empty/no-repo/error states ported from the Lens section.

**Tests:**
- [ ] bun test for any extracted formatting helpers.

**Checkpoint:**
- [ ] `bunx vite build`
- [ ] In the app: `↺` route lists this project's commits as blocks; log refreshes after a commit made on the `±` route.

---

#### Step 9: History submit + /tugplug:history skill {#step-9}

**Depends on:** #step-8

**Commit:** `tugdeck(history)+tugplug: History-route submit sends /tugplug:history on the record; ship the skill`

**References:** [P10], [P11], (#submit-dispatch-order)

**Artifacts:**
- `performSubmit` History branch (wrap + send + flip to `❯`); `tugplug/skills/history/SKILL.md`.

**Tasks:**
- [ ] Submit branch per (#submit-dispatch-order): send-readiness gates first (`resolveSubmitButtonView(...).disabled` bail; `classifyBlockedSubmit` drop/defer on `!canSubmit && !canInterrupt` — a replay/transport-settling submit must never leak a turn; mid-turn falls through, `send()` queues) → `codeSessionStore.send("/tugplug:history " + submitText, [])`, history push (route `↺`, raw question), clear, `setRoute(DEFAULT_ROUTE)`. `routeAllowsLocal` excludes `ROUTE_HISTORY` so a `/`-leading question is never intercepted as a local command.
- [ ] Author the skill (model on `tugplug/skills/commit/`): gather-first discipline — `tugmark log --json` / `tugmark context --json` for the project, `git log --grep` over `Tug-Session:`/`Tug-Dash:` trailers and free terms, `git show <sha>` / `git log --follow -- <path>` for file history — then answer citing shas. Read-only: the skill never commits or mutates.
- [ ] Verify the skill registers (appears in the session's slash-command catalog) in a real session.

**Tests:**
- [ ] Skill file review; catalog presence check in the app.

**Checkpoint:**
- [ ] `bunx vite build`
- [ ] In the app: submit a question on `↺` → card flips to `❯`, the turn runs `/tugplug:history`, the answer cites real commits.

---

#### Step 10: Trailers — changeset_commit path {#step-10}

**Depends on:** #step-4

**Commit:** `tugcast(changeset): Tug-Session trailer on deck commits — optional session fields on changeset_commit [Spec S01]`

**References:** [P08], Spec S01, Spec S02

**Artifacts:**
- `append_trailers` helper (in `tugmark-core`, exported; or a tugcast-local module if tugmark-core is the wrong home — implementer's call, but ONE shared implementation for tugcast + tugdash-core); `parse_changeset_commit_payload` + `do_changeset_commit` edits; `ChangesRouteController.commit` sends `session_name`/`session_id` (frontend: extend `ChangesetVerbStore.commit` signature with optional fields).

**Tasks:**
- [ ] Implement Spec S02 append (idempotent, final-paragraph, per-key skip) with unit tests.
- [ ] Extend the payload struct/parser (optional fields, back-compatible); enrich the message in `do_changeset_commit` before `run_changeset_commit`.
- [ ] Frontend: `ChangesRouteController.commit` passes the entry's `display_name` + `owner_id`; Lens/Changeset-card callers unchanged (fields optional).
- [ ] Extend the existing `run_changeset_commit` integration tests: commit lands with the trailer; `git log --format=%(trailers:key=Tug-Session)` returns it; double-append is a no-op.

**Tests:**
- [ ] `cargo nextest run` — new unit + integration tests.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `bunx vite build`

---

#### Step 11: Trailers — tugdash commit + join paths {#step-11}

**Depends on:** #step-10

**Commit:** `tugdash(trailers): Tug-Session + Tug-Dash trailers on dash round commits and join messages [P08][P09]`

**References:** [P08], [P09], [Q02], Spec S02

**Artifacts:**
- `session_trailer()` in `tugdash-core/src/ops.rs` (env `TUG_SESSION_ID` + read-only `sessions.db` display-name lookup, `dash_draft_message` connection pattern); trailer append in `ops::commit` (round commits) and `integrate_message` (join/squash, including the resolution-ladder candidate path that shares it).

**Tasks:**
- [ ] `ops::commit`: after composing `message`/`summary`, append `Tug-Session:` (when resolvable) + `Tug-Dash: <branch> onto <base>` (base from the dash's recorded base branch — the same source `show()`/join use).
- [ ] `integrate_message`: append the trailer block to the returned message (subject stays `tugdash(<name>): …`; trailers ride the body).
- [ ] Tests in scratch repos: trailer present on a round commit; join squash commit carries `Tug-Dash`; absent env omits `Tug-Session` without error; idempotence when a draft already contains a trailer.

**Tests:**
- [ ] `cargo nextest run` — ops tests extended.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`

---

#### Step 12: Slim the Lens — monitor rows + delete Git History section {#step-12}

**Depends on:** #step-7, #step-8

**Commit:** `tugdeck(lens): Sessions section becomes a read-only monitor; Git History section removed [L02][L06]`

**References:** [P04], [P12], (#slim-lens-row, #sessions-section-inventory), Risk R02

**Artifacts:**
- Rewritten `SessionsSectionBody` (monitor rows only); deleted `git-history-section.tsx` + its `main.tsx` registration; `focus-session-card` action + pane title-bar flash CSS; deletion of the now-orphaned Lens-only pieces (entry blocks, collapse store, per-entry composer, dash actions — per the inventory table; `git-log-store.ts` stays).

**Tasks:**
- [ ] Monitor row per (#slim-lens-row): dot ([P12] source), name + `project · branch` context (labels still from `useChangesetAll`), latest pulse line, compact sparkline; `data-tug-focus="refuse"`; click → `focus-session-card { cardId }`.
- [ ] Register the action in `action-dispatch.ts` with `transferFocusForActivation` + flash-class toggle on the pane header node (animationend cleanup); keyframe in the pane chrome CSS.
- [ ] Delete: `EntryBody`, `SessionsFileBlock`, `SessionsEntryBlock`, `DashActions`, commit composer, `sessions-entry-collapse-store` usage, git-history section + registration. Sweep imports; fix anything else the deletion surfaces (fix pre-existing issues, don't defer).
- [ ] Collapsed summary → "N sessions"; header expand/collapse actions removed with the entry collapse store.
- [ ] Confirm `useLensFollowedCard` has remaining consumers before touching it; if git-history was the last, remove the follow plumbing too, else leave it.

**Tests:**
- [ ] bun test sweep; remove tests that covered deleted Lens pieces (their behavior now lives in `cards/session-changes/` — ensure equivalents exist there from #step-5).

**Checkpoint:**
- [ ] `bunx vite build`
- [ ] In the app: Lens shows slim rows; clicking one fronts + flashes the card; no Git History section.

---

#### Step 13: Integration checkpoint — full phase {#step-13}

**Depends on:** #step-9, #step-11, #step-12

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Walk every success criterion in (#success-criteria) in the running app.
- [ ] History round-trip proves the trailer payoff: commit via `±` (trailer lands), ask on `↺` "what did this session commit?" → the skill greps the trailer and answers with the sha.

**Tests:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `just app-test`

**Checkpoint:**
- [ ] `bunx vite build` && `cd tugrust && cargo nextest run` && `just app-test`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The Lens is a read-only session monitor; the Session card gains working Changes and History view-routes (commit with AI-drafted messages, dash joins, per-commit history blocks, on-record history Q&A); every tugutil commit path emits `Tug-Session:`/`Tug-Dash:` trailers.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All (#success-criteria) verified in the running app.
- [ ] `bunx vite build` clean; `cargo nextest run` clean; `just app-test` clean.
- [ ] No dead Lens code: deleted pieces have no remaining imports.

**Acceptance tests:**
- [ ] Rust: trailer unit + integration tests (Steps 10–11).
- [ ] TS: controller derivation + route-mode unit tests (Steps 2, 4).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] `Tug-Plan:` trailer (deferred by decision — needs a source for "plan files used").
- [ ] Per-commit diff bodies in HistoryView if [Q01] resolves refs-only (backend sha support).
- [ ] Changeset card adopting the `session_name`/`session_id` commit fields.
- [ ] History-route niceties: `--grep` quick filters, author/date facets, load-more beyond the 20-commit default.

| Checkpoint | Verification |
|------------|--------------|
| Frontend builds | `bunx vite build` |
| Rust suite | `cd tugrust && cargo nextest run` |
| App drives | `just app-test` |
| Commit trailer live | `git log -1 --format=%B` after a `±`-route commit |
