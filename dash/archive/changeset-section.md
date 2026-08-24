<!-- devise-skeleton v4 -->

## The Changeset section — on-demand drafts, a soft-wrapped composer, and the card's retirement into the Lens {#changeset-section}

**Purpose:** Turn the changeset commit-message draft from a background auto-generated stream into an **on-demand** one (a "Generate message" button backed by a new CONTROL verb + a rewritten draft engine), soft-wrap the commit-message field at a smaller font, then **lift the entire Changeset card into a Lens section** (`kind: "changeset"`) and delete the standalone card. This is **M3b** of the Lens direction; **M3a** (the Lens frame, `1057596df`) and **M3c** (a Git History section) bracket it. M3b adds one Lens **registrant** plus the backend/composer changes the lift depends on.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-15 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The **Changeset card** (`tugdeck/src/components/tugways/cards/changeset-card.tsx`) renders the account-global `CHANGESET_ALL` aggregate joined against the open dev cards: one entry per session, plus per-project dash and unattributed pseudo-entries, each a `BlockChrome` section in one plain scroll (`ChangesetCardContent` → `.changeset-scroll` → `ChangesetEntryBlock` → `ChangesetFileBlock` → embedded `DiffBlock`). Session/unattributed entries host a commit composer (`EntryBody`'s `commitComposer`, one `BlockChrome` titled "Commit message" with a `TugMessageEditor` body and a width-stabilized Commit button); dash entries host `DashActions` (Join/Release); a non-repo session hosts `NonRepoBody` ("Initialize git").

Today the commit-message draft is **maintained automatically**. The backend `DraftEngine` (`tugrust/crates/tugcast/src/feeds/draft_engine.rs`) taps a clone of the `CHANGESET_ALL` watch receiver, and for every eligible entry debounces `QUIET_PERIOD = 10s` after its content changes, gates on a content **fingerprint**, and regenerates through the headless scribe — streaming `changeset_draft_state` / `changeset_draft_delta` over CONTROL (consumed by `changeset-draft-store.ts`) and persisting a `ChangesetDraftRow` that rides the next aggregate frame as `entry.draft`. On the card, `EntryBody` runs a **pin/pristine-follow** contract: while the field is unpinned, an effect re-seeds it from `draftText` (live overlay text, else the persisted snapshot draft) via the CM6 field's programmatic `restoreState` (which does not fire `onChange`); a user edit pins; a landed commit clears + unpins; a "Use latest draft" header action re-unpins.

Two forces reshape this. **(1)** The auto-engine spends a scribe call on every 10s-quiet entry whether or not anyone will commit it — the user wants generation to be an explicit, on-demand act. **(2)** M3a shipped the Lens: an anchored pane hosting the `"lens"` card whose content (`lens-content.tsx`) renders a reorderable, collapsible stack of **sections** from a registry (`lens-section-registry.ts`), each a `LensSectionDefinition` with a **required** `collapsedSummary` and a host-agnostic `body`, wrapped in a sticky `LensSection` band (`lens-section-band.tsx`) that models `TugTranscriptEntry` and writes `--tugx-pin-stack-top` so a section's own `BlockChrome` telescopes beneath it. The changeset content — already converted to top-level `BlockChrome` sections in `f6904982b` — is meant to become one such section. Log and Telemetry are the two existing registrants (`lens/sections/`, registered from `main.tsx`).

A third, quieter force: the **canonical-path-identity** work (`c6d7b806`) made `file_events.file_path` **repo-relative** at capture time. `draft_engine.rs`'s `session_user_prompts` still lexically strips `project_dir` off `file_path` to find "prompts since the changeset began" — a strip that now always fails on an already-relative path, silently degrading the draft prompt (it over-includes prompts from time 0). This plan rewrites that file and fixes the strip in passing.

#### Strategy {#strategy}

- **On-demand first, on the card.** Land the backend verb + engine rewrite ([#step-1], [#step-2]) and the composer changes ([#step-3], [#step-4]) while the standalone card still exists, so the lift moves already-final behavior. This honors the independence of the backend and the editor changes.
- **Rewrite the engine to a callable, delete the loop.** Replace `DraftEngine::run`/`reconcile`/`EntryHandle`/`QUIET_PERIOD` (the watch-tap debounce machinery) with a public `spawn_on_demand_draft(...)` that reuses `eligible_entries` to derive one entry's `DraftTarget` from the latest aggregate snapshot and **spawns** a detached task calling the retained `generate_for_entry` — **without** the fingerprint early-return (an explicit request always regenerates). It returns immediately with a matched/no-match bool; it does **not** await the scribe run ([P03] — the caller is the router's per-client loop). Keep `generate_for_entry`, `gather_head`/`gather_dash`, `send_state`/`send_delta`, and the target types.
- **New CONTROL verb, house pattern.** `changeset_draft_request { project_dir, owner_kind, owner_id }` dispatches in `agent_supervisor::handle_control` alongside `changeset_commit`/`changeset_git_init`; a new `do_changeset_draft_request` borrows the latest aggregate frame (a stored clone of `changeset_all_rx`), decodes it, and calls `spawn_on_demand_draft` (which returns at once — generation runs on a detached task, so `handle_control` never parks the socket loop). Client side: `sendControlFrame("changeset_draft_request", …)` from a new "Generate message" affordance.
- **Keep the streaming contract untouched.** `changeset_draft_state`/`changeset_draft_delta` and `changeset-draft-store.ts` are unchanged; the field still fills live. The frontend keeps the pristine-follow effect (so a persisted draft seeds the field and a live stream flows in), and the Generate button unpins the field so a fresh draft replaces stale text.
- **Editor pass-throughs, not a rewrite.** `TugTextEditor` already exposes `lineWrap`/`fontSize`; `TugMessageEditor` does not forward them — add the two props and set them in the composer.
- **Lift, then delete, atomically.** One commit moves `EntryBody` + the entry/file blocks + `DashActions` + `NonRepoBody` + the composer into `lens/sections/changeset-section.tsx` (a registrant), deletes `registerChangesetCard` + its `main.tsx` call, and retargets `at0228`/`at0229` at the Lens section — so the app-test suite stays green across the boundary.
- **Reuse M3a's sticky machinery.** The section body renders the entry blocks inline (no inner `overflow` — the Lens content scroll owns scrolling); the band's `--tugx-pin-stack-top` offsets the entry headers, whose own pin-clearance pair (in `changeset-card.css`, now `changeset-section.css`) offsets the file headers.

#### Success Criteria (Measurable) {#success-criteria}

- Clicking "Generate message" on a session/unattributed changeset entry sends `changeset_draft_request`, the composer's lifecycle dot enters `in_flight`, streamed deltas fill the field live, and the dot lands `success` when the draft is ready — verified end-to-end by a real-scribe app-test ([#step-6]) and, deterministically, by a `draft_engine` Rust unit test that `spawn_on_demand_draft` regenerates **even when the fingerprint is unchanged** ([#step-1]).
- No draft is generated without an explicit request: after content changes with no click, no scribe call fires and `entry.draft` does not appear — asserted by a `draft_engine` unit test that the removed watch loop is gone (no `DraftEngine::run`) and by the absence of the auto path in code review ([#step-1]).
- The commit-message field soft-wraps long lines at the reduced font size — asserted by an app-test reading the CM6 field's `data-wrap`/computed font ([#step-3]).
- The Changeset card is gone: `registerChangesetCard` and its `main.tsx` call are deleted, no `addCard("changeset")` remains, and a persisted deck blob naming a `"changeset"` card degrades gracefully (dropped by `filterRegisteredCards` with a warn, no crash) — grep + a `bun test` over `filterRegisteredCards`/`loadLayout` (not an app-test — test-mode `DeckManager` ignores the persisted layout, per at0230) ([#step-5]).
- The Changeset **section** renders under the Lens with a live collapsed-summary ("N sessions · M dirty files"), and `at0228`/`at0229`'s assertions pass against `.lens-section[data-lens-section="changeset"]` ([#step-5]).
- `bunx tsc --noEmit && bunx vite build && bun test` green at every tugdeck step; `cd tugrust && cargo nextest run` green + `cargo build` warning-clean at every Rust step.

#### Scope {#scope}

1. `draft_engine.rs`: delete the watch-tap/debounce loop; add `spawn_on_demand_draft` (spawns generation, never awaits it); drop the fingerprint early-return (keep computing + persisting the fingerprint); fix the now-broken repo-relative strip in `session_user_prompts`.
2. `agent_supervisor.rs` + `main.rs`: the `changeset_draft_request` verb + `do_changeset_draft_request`; store the aggregate watch receiver; retire `start_draft_engine`'s engine spawn.
3. `changeset-draft-store.ts`: a `requestDraft` trigger (`sendControlFrame`).
4. `tug-message-editor.tsx`: `lineWrap` + `fontSize` pass-throughs; the composer sets soft-wrap + a smaller font.
5. The changeset card's composer: a "Generate message" button + the revised seed/pin contract.
6. `lens/sections/changeset-section.tsx`: the registrant (band descriptor + host-agnostic body + collapsed-summary) lifting `EntryBody` and its subtree; `main.tsx` registration; `changeset-section.css`.
7. Delete `registerChangesetCard` + card scaffolding that does not move; graceful-degrade check for persisted `"changeset"` cards.
8. Tests: retarget `at0228`/`at0229` at the section; add `at0237` (on-demand draft, real-scribe-gated) + `draft_engine` unit coverage.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Any change to the Lens frame itself (anchored pane, registry, band, reorder/visibility/collapse persistence) — M3a is done; M3b only adds a registrant. If a frame change proves necessary, stop and record it in [Open Questions](#open-questions).
- **M3c** — the Git History section (its own plan).
- Rendering the Changeset section as its own deck card (the M3a contract already permits it; not built here).
- Adopting the `CanonicalPath` gateway for `gather_dash`'s worktree path handling — an explicit follow-on ([#p09-dash-strip-followon], echoing `dash/canonical-path-identity.md` `[#canonicalize-audit]`). Only the `session_user_prompts` strip (broken by the repo-relative switch) is fixed here.
- Changing the commit / join / release / git-init verbs or the diff feed.
- Restoring background/automatic draft generation in any form.

#### Dependencies / Prerequisites {#dependencies}

- **M3a Lens frame** (`1057596df`): `lens-section-registry.ts` (`LensSectionDefinition`, `LensSectionHost`, `registerLensSection`, `resolveSectionRenderOrder`, `sectionFocusGroup`), `lens-content.tsx`, `lens-section-band.tsx`, `dev.tugtool.lens` store, `main.tsx` section registration (`registerLogSection`/`registerTelemetrySection`).
- **Entry blocks** (`f6904982b`): the changeset content is already `BlockChrome` sections with the `.changeset-entry-block` pin-clearance pair in `changeset-card.css`.
- **Canonical path identity** (`c6d7b806`): `file_events.file_path` is repo-relative — the reason `session_user_prompts`'s strip is now wrong.
- Existing changeset stores: `changeset-all-store.ts` (`useChangesetAll`), `changeset-verb-store.ts`, `changeset-draft-store.ts`, `changeset-join-store.ts`, `changeset-diff-store.ts`, `card-session-binding-store.ts`.
- Backend: `draft_engine.rs` (`eligible_entries`, `generate_for_entry`, `gather_head`/`gather_dash`, `send_state`/`send_delta`, `DraftTarget`, `EntryKey`, `ChangesetDraftRow`), `agent_supervisor.rs` (`handle_control`, `ScribeContext`, `set_scribe`, `start_draft_engine`, `control_tx`, `registry`, `session_ledger`, in-memory `ledger` resolver), `main.rs` `changeset_all_tx/rx` (`FeedId::CHANGESET_ALL`).

#### Constraints {#constraints}

- **Tuglaws cross-check before tugdeck work.** Read `tuglaws/tuglaws.md`, `tuglaws/pane-model.md`, `tuglaws/component-authoring.md`, `tuglaws/focus-language.md`. Touched laws: **[L02]** (external state via `useSyncExternalStore`), **[L06]** (appearance via CSS/DOM), **[L11]** (controls emit actions), **[L20]** (composed children own tokens), **[L22]** (structure owned by managers), **[L24]** (component-local data). Name touched laws in each commit. If any instruction conflicts with a law, the law wins — surface it in [Open Questions](#open-questions).
- **Real Tug components only.** The Generate button is a `TugPushButton`; the composer stays a `BlockChrome` + `TugMessageEditor`. Never hand-roll.
- **No localStorage.** No new persisted state; section order/visibility/collapse already live in `dev.tugtool.lens`.
- **No height estimates / no windowing.** The section renders inline at real measured heights.
- **Rust: warnings are errors** (`tugrust/.cargo/config.toml`). `cargo build` warning-clean and `cargo nextest run` green per Rust step. Deleting the engine loop must leave **no** dead code (unused `QUIET_PERIOD`, `change_key`, etc.).
- **App-tests are real** (`tests/app-test/`, `just app-test`) — no jsdom, no mocks, no synthetic fixtures. Real-scribe (real-claude) app-tests are **on-demand only**, gated behind the suite's real-claude env flag so the default run skips them.
- **Tooling.** bun, never npm. Every tugdeck step passes `bunx tsc --noEmit && bunx vite build && bun test`; run `bunx vite build` before declaring a tugdeck change done (the debug app loads the rollup bundle). App-test steps additionally run `just app-test`.
- **Artifact hygiene.** No plan-step numbers in code; no rationale/backstory comments; no freestanding `docs/*.md`.

#### Assumptions {#assumptions}

- The `changeset_all_rx` watch (`main.rs`) always holds the latest aggregate frame — `ChangesetAllFeed` pushes into `changeset_all_tx` on every recompute (`spawn_snapshot_feed`), so `borrow()` at request time yields a current snapshot for `eligible_entries`. **Verified** in `main.rs` (the same receiver the engine tapped).
- `eligible_entries` derives the exact `DraftTarget` (head files / dash range / unattributed files) from a snapshot for a `(project_dir, owner_kind, owner_id)` — the on-demand path reuses it rather than re-deriving targets. **Verified** in `draft_engine.rs`.
- The `TugMessageEditor` `restoreState` seam does not fire `onChange` (the `[P28]` pinning contract), so seeding a streamed draft into a pristine field never reads as a user edit. **Verified** in `tug-message-editor.tsx` (`delete.tug-clear` / non-user transactions filtered).
- `filterRegisteredCards` (`deck-manager.ts`) already drops a persisted card whose `componentId` is unregistered (with a warn), and drops a stack whose cards are all unregistered — so deleting `registerChangesetCard` degrades an old blob gracefully. **Verified** by the method's existing warn strings. Re-verify at implementation time.
- The Lens sections default to shown + expanded (`hiddenSections`/`collapsedSections` empty in a fresh `dev.tugtool.lens`), so a newly registered changeset section is visible without extra wiring.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Explicit `{#anchor}` headings; plan-local decisions `[P01]`… (never `[D01]`); steps cite decisions/specs/anchors, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does the fingerprint survive at all once the gate is gone? (DECIDED — keep it stored, drop the gate) {#q01-fingerprint}

**Question:** With generation on-demand, the fingerprint's early-return in `generate_for_entry` must go (an explicit request must always regenerate). Do we also stop computing/persisting the fingerprint on `ChangesetDraftRow`?

**Why it matters:** Dropping the column-shaped field could disturb `ChangesetDraftRow`/`changeset_drafts` persistence; keeping a now-unused value is dead weight.

**Resolution:** DECIDED — **keep computing and persisting the fingerprint; remove only the early-return.** `fingerprint_head_entry`/`fingerprint_dash_entry` stay in `gather_head`/`gather_dash`, and `ChangesetDraftRow.fingerprint` keeps its slot (no row-shape change, no migration). Only the `if existing.fingerprint == fingerprint { return; }` block in `generate_for_entry` is deleted. This preserves the row shape and leaves the door open to a future opt-in auto-mode without a schema change. See [P02].

#### [Q02] What does the engine reply when there is nothing to draft? (DECIDED — error state "nothing to generate") {#q02-nothing-to-draft}

**Question:** If a `changeset_draft_request` arrives for an entry that `eligible_entries` does not surface (it went clean between render and click, or a fileless session), what does the server send back?

**Why it matters:** The client overlay store (`changeset-draft-store.ts`) understands only `drafting`/`ready`/`error`; a silent no-op would leave the dot spinning.

**Resolution:** DECIDED — `do_changeset_draft_request` sends `changeset_draft_state` with `state: "error"`, `detail: "nothing to generate"` when `spawn_on_demand_draft` finds no eligible entry (a synchronous `false` return, before any task is spawned). The overlay renders it in the composer's notice band (`draftError`) without blanking the field. Because the Generate button only shows for a draftable entry ([P04]), this is an edge case, not the common path. See [P03].

#### [Q03] Does the Generate button clobber a user's typed text? (DECIDED — Generate unpins and replaces) {#q03-generate-clobber}

**Question:** If the user has typed into the composer (pinned) and clicks Generate, does the streamed draft replace their text?

**Why it matters:** The pin contract exists precisely to protect user edits from an incoming draft.

**Resolution:** DECIDED — **Generate is an explicit "replace with a fresh draft" act: it calls `setPinned(false)` before dispatching**, so the pristine-follow effect lets the streamed deltas flow into the field. The pin still protects against *involuntary* clobbering (there is no longer any automatic draft to clobber). The existing "Use latest draft" header action is retained for the narrower case of snapping a pinned field back to the last-generated persisted draft without regenerating. See [P04].

#### [Q04] Where does the section's toolbar (session count, Expand/Collapse all) go? (DECIDED — first row of the section body) {#q04-toolbar}

**Question:** `ChangesetCardContent` renders a `.changeset-head` toolbar (session count + Expand all / Collapse all) above its scroll. In a Lens section, the band supplies the title/summary/chevron — where does the toolbar live?

**Why it matters:** Duplicating a title in both band and toolbar is noise; losing Expand/Collapse-all removes a real affordance.

**Resolution:** DECIDED — **keep Expand all / Collapse all as the first (non-band) row of the section body; drop the "N sessions" label from the toolbar** (the band's `collapsedSummary` now carries the count). The band renders the section title "Changeset" + the live summary + chevron; the body opens with the two bulk-collapse buttons, then the entry stack. See [P07].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Awaiting the scribe run inside `handle_control` parks the router's per-client socket loop → the requesting client can't receive the live deltas until generation ends, and its other CONTROL messages queue behind it | high | high | `spawn_on_demand_draft` does the cheap eligibility work synchronously and `tokio::spawn`s the generation, returning at once ([P03], R02); `do_changeset_draft_request` never awaits `generate_for_entry` | any inline `.await` of generation in `handle_control` |
| Deleting the engine loop leaves dead code → `-D warnings` build break | med | high | Delete `run`/`reconcile`/`EntryHandle`/`QUIET_PERIOD`/`change_key` fns + `PendingEntry.change_key` together; `cargo build` per step ([#step-1]) | any `unused` warning |
| The lift changes sticky behavior: entry headers stop pinning under the band | high | med | Section body has no inner `overflow`; verify band `--tugx-pin-stack-top` offsets the entry header and the entry's own pin-clearance pair offsets the file header ([P08]); app-test scrolls and asserts a pinned entry header clears the band ([#step-5]) | entry header hides under the band on scroll |
| Retiring the card breaks a persisted deck blob that names a `"changeset"` card | med | med | `filterRegisteredCards` already drops unregistered cards + drops a stack whose cards all dropped; a `bun test` over `filterRegisteredCards`/`loadLayout` asserts a `componentId:"changeset"` card is dropped once the registrant is gone ([#step-5]). Not app-testable — test-mode `DeckManager` ignores the persisted layout and starts empty (per at0230's docstring) | boot crash / blank pane on a stale layout |
| On-demand snapshot is stale (borrowed frame predates the click) | low | med | The aggregate feed bumps on every recompute, so the borrowed frame is current to the last compose; `eligible_entries` tolerates a just-cleaned entry via the [Q02] reply | draft targets the wrong file set |
| `session_user_prompts` strip fix changes prompt content unexpectedly | low | low | Compare `dirty` (repo-relative `f.path`) against the now-repo-relative `e.file_path` directly; a `draft_engine` unit test asserts `since_ms` is the min touch time, not 0 ([#step-1]) | draft prompts regress in a real session |

**Risk R01: The lift silently loses commit-flow responder wiring** {#r01-responder}

- **Risk:** `EntryBody` wraps its file list in `useResponderForm`'s `CommitScope` (the per-file checkbox `toggle` senders, [L11]). Moving the subtree into a Lens section could drop the responder registration if the section body does not carry the scope.
- **Mitigation:** Move `EntryBody` **verbatim** (scope + `commitRef` intact); the section body renders `EntryBody` per entry exactly as `ChangesetEntryBlock` does today. The `at0228` commit assertion (select file → type → Commit) exercises the responder path end-to-end.
- **Residual risk:** None beyond the app-test's coverage.

**Risk R02: Inline `.await` of generation stalls the client's socket loop** {#r02-socket-stall}

- **Risk:** `router.rs`'s `handle_client` awaits `intercept_session_control(...) → handle_control(...)` **inside** its per-client `select!` read arm (the `socket.recv()` branch). While that await is in flight, no other arm of that client's select runs — including outbound frame delivery. `generate_for_entry` runs the scribe for seconds and streams `changeset_draft_delta` frames the whole time. Awaiting it inline (the shape `do_changeset_join_resolve` uses) would delay every streamed delta to the requesting client until generation *finishes* — defeating "the field fills live" — and would queue that client's other CONTROL messages behind the draft. The old `DraftEngine` never had this problem because generation always ran on a spawned task.
- **Mitigation:** `spawn_on_demand_draft` resolves eligibility synchronously (decode already done by the caller, `eligible_entries`, match), sends the [Q02] `"nothing to generate"` reply and returns `false` on no match, otherwise `tokio::spawn`s the `generate_for_entry` future (owning a cloned `EngineDeps`) and returns `true` — **without awaiting generation**. `do_changeset_draft_request` therefore returns to the router loop immediately; the deltas the spawned task broadcasts reach the now-unblocked client live.
- **Residual risk:** None — the spawned task streams over the same `control_tx` broadcast every client already reads; ordering of `drafting`→deltas→`ready` is preserved because a single task emits them in sequence.

---

### Design Decisions {#design-decisions}

#### [P01] On-demand replaces the watch-tap engine; `spawn_on_demand_draft` reuses `eligible_entries` and detaches generation (DECIDED) {#p01-on-demand}

**Decision:** Delete the debounce/watch machinery in `draft_engine.rs` — `DraftEngine::run`, `reconcile`, `EntryHandle` (+ its `Drop`), `QUIET_PERIOD`, `PendingEntry.change_key`, and the `head_change_key`/`unattributed_change_key`/dash-change-key computations. Simplify `PendingEntry` to `{ key, target }`. Keep `eligible_entries` (now returning `{ key, target }`), `generate_for_entry`, `gather_head`, `gather_dash`, `send_state`, `send_delta`, `git_output`, `read_dash_log`, `session_user_prompts`, and the `DraftTarget`/`EntryKey`/`FileMeta` types. Add:

```rust
/// Resolve a draft request against the latest aggregate snapshot and, if an
/// eligible entry matches, spawn its generation on a detached task
/// (regenerating unconditionally — no fingerprint gate). Returns IMMEDIATELY:
/// `true` when a generation was spawned, `false` when no eligible entry matched
/// (nothing to draft). Does NOT await the scribe run — the caller is the
/// router's per-client socket loop, which must not park (R02, [P03]).
pub fn spawn_on_demand_draft(
    control_tx: broadcast::Sender<Frame>,
    ledger: Arc<SessionLedger>,
    registry: Arc<WorkspaceRegistry>,
    scribe: ScribeContext,
    resolver: SessionResolver,
    snapshot: WorkspacesChangesetSnapshot,
    project_dir: &str,
    owner_kind: &str,
    owner_id: &str,
) -> bool
```

It builds an owned private `EngineDeps` (as `DraftEngine::new` does), runs `eligible_entries(snapshot)` synchronously, finds the `PendingEntry` whose `key` matches `(project_dir, owner_kind, owner_id)`; on no match returns `false`. On a match it moves the owned `deps`/`key`/`target` into `tokio::spawn(async move { generate_for_entry(&deps, &key, &target).await })` and returns `true` at once — the detached task streams and persists exactly as before. It is a **synchronous** fn (all its own work — decode is the caller's, `eligible_entries` and the match are sync) that spawns; being called from within `handle_control`'s runtime context, `tokio::spawn` is available.

**Rationale:** Target derivation (head files / dash range / unattributed set + the change-excluding identity) already lives in `eligible_entries`; reusing it keeps one source of truth and avoids re-deriving `DraftTarget` in the supervisor. Keeping `generate_for_entry` and the `gather_*`/`send_*` helpers means the streaming + persistence contract is byte-identical to today. Detaching the generation (rather than awaiting it) is mandatory — the router awaits `handle_control` inside the per-client read loop (R02).

**Implications:** `EngineDeps` stays private (constructed inside `spawn_on_demand_draft`) and must be `Clone`/owned so the spawned task can take it; `SessionResolver` and `ScribeContext` stay `pub`. `DraftEngine` the struct is deleted (or reduced to nothing) — remove `use` of `watch`, `CancellationToken`, `JoinHandle`, `HashMap` if they fall unused (audit for `-D warnings`); `mpsc` **stays** (`generate_for_entry`'s delta forwarder uses it). The `#[cfg(test)]` module's `persists_a_draft_then_gates_on_fingerprint` / `a_superseding_change_coalesces_to_one_generation` tests (which drive `engine.run`) are replaced by on-demand tests that poll the ledger for the spawned task's result via the existing `wait_for_draft` helper ([#step-1] Tests).

#### [P02] Drop the fingerprint early-return; keep the fingerprint stored (DECIDED) {#p02-fingerprint-gate}

**Decision:** Remove the `if let Ok(Some(existing)) = … { if existing.fingerprint == fingerprint { return; } }` block from `generate_for_entry`. Keep computing the fingerprint in `gather_head`/`gather_dash` and persisting it on `ChangesetDraftRow`.

**Rationale:** An explicit request must always regenerate; the gate's purpose (don't burn a scribe call on an unchanged entry the user isn't watching) is moot when the user just asked. Keeping the stored fingerprint preserves the row shape (no migration, [Q01]) and a future auto-mode.

**Implications:** `generate_for_entry`'s signature is unchanged; only the body loses the early-return. The `draft_engine` unit test asserts a matching-fingerprint request still calls the scribe.

#### [P03] The `changeset_draft_request` verb (DECIDED) {#p03-verb}

**Decision:** A new client→tugcast CONTROL verb `changeset_draft_request { project_dir, owner_kind, owner_id }`, dispatched in `agent_supervisor::handle_control` beside the other `changeset_*` arms, calling `do_changeset_draft_request(&parsed)`. That method: clones the stored aggregate watch receiver, `borrow()`s the latest `Frame`, decodes `WorkspacesChangesetSnapshot`, and — when the scribe + read-side ledger are wired (the `start_draft_engine` guard) — calls `draft_engine::spawn_on_demand_draft(self.control_tx.clone(), ledger, Arc::clone(&self.registry), scribe, resolver, snapshot, …)`, which **returns immediately** (generation runs on a detached task, R02). When `spawn_on_demand_draft` returns `false`, send `changeset_draft_state { state: "error", detail: "nothing to generate" }` ([Q02]). `handle_control` then returns `Ok(())` at once — it never awaits the scribe. Add `parse_changeset_draft_request_payload` mirroring `parse_changeset_commit_payload`.

**Why detached (R02):** `router.rs`'s `handle_client` awaits `intercept_session_control → handle_control` inside its per-client `select!` `socket.recv()` arm. Any inline `.await` of `generate_for_entry` there would freeze that client's frame delivery for the whole scribe run — the streamed `changeset_draft_delta`s could not reach the requesting client until generation finished, and the client's other CONTROL messages would queue behind it. Spawning is the only correct shape; do **not** copy `do_changeset_join_resolve`'s inline-await pattern here.

**Rationale:** Matches the established changeset-verb round-trip shape (parse → `do_*` → broadcast on `control_tx`). Reusing the stored watch receiver gives a current snapshot with no recompute.

**Implications:** The supervisor gains a stored `changeset_watch: Option<watch::Receiver<Frame>>` (or reuses a clone captured where `start_draft_engine` is called). `start_draft_engine` (`main.rs:1081`) no longer spawns an engine loop; it becomes a setter that stores `changeset_all_rx.clone()` for on-demand use (rename to `set_changeset_watch` or keep the name with a new body — decide at implementation, cite the rename in the commit). The `resolver` closure (`tug_session_id → claude_session_id` over the in-memory `ledger`) moves from `start_draft_engine` into `do_changeset_draft_request` (or a shared helper), unchanged.

#### [P04] The on-demand seed/pin contract (DECIDED) {#p04-seed-contract}

**Decision:** Keep the pristine-follow effect in `EntryBody` (while `!pinned`, `restoreState(draftText)` + `setMessage(draftText)`), a user edit pins, a landed commit clears + unpins. Add a **"Generate message"** `TugPushButton` to the composer header actions that calls `setPinned(false)` then `requestDraft()` ([P05]). Retain the "Use latest draft" action. The composer renders whenever the entry is **draftable** — broaden `commitComposer`'s guard from `hasCommit || draftText !== null || drafting` to also include a `isDraftable` predicate (session/unattributed with ≥1 file, or a dash with rounds/dirty), so the Generate affordance is reachable for a fresh entry with no persisted draft yet.

**Rationale:** With no automatic generation, the field-follows-draft effect is still the mechanism that streams a live draft in and seeds a persisted one; only the *trigger* changes from background to a click. Generate unpinning ([Q03]) makes "regenerate" replace stale text as expected.

**Implications:** `EntryBody`'s draft block gains one button and one `isDraftable` computation; the retired auto-comment ("the draft is maintained automatically, [P21]") in `entryDiffActionsRow`'s note is corrected. Dash entries get a "Generate join message" affordance via the same path (the composer already titles itself "Join message" for dashes).

#### [P05] Client `requestDraft` on the draft store (DECIDED) {#p05-request-draft}

**Decision:** `ChangesetDraftStore` stores its `TugConnection` and gains `requestDraft(projectDir, ownerKind, ownerId)` → `sendControlFrame("changeset_draft_request", { project_dir, owner_kind, owner_id })`. `useChangesetDraft` returns `DraftOverlay & { requestDraft: () => void }` (the overlay plus a bound trigger for its `(projectRoot, ownerKind, ownerId)`), mirroring how `useChangesetGitInit` returns `{ …state, init }`.

**Rationale:** The draft store already owns the `(project_dir, owner_kind, owner_id)` identity and the CONTROL subscription; the trigger belongs there, next to the overlay it drives. `useChangesetGitInit` is the exact house precedent.

**Implications:** `ChangesetDraftStore` constructor keeps the connection (today it discards it after `onFrame`). The no-store fallback returns a no-op `requestDraft` (gallery/fixtures), like the other hooks.

#### [P06] `TugMessageEditor` gains `lineWrap` + `fontSize` pass-throughs (DECIDED) {#p06-editor-props}

**Decision:** Add `lineWrap?: boolean` and `fontSize?: string` to `TugMessageEditorProps` and forward them to `TugTextEditor` (which already implements `lineWrap` via `EditorView.lineWrapping` + `data-wrap`, and `fontSize` via the `--tug-font-size-editor` CSS var). The changeset composer passes `lineWrap` and a smaller `fontSize` (a theme token, e.g. the editor's small-size var — pick the concrete token at implementation and keep it a token, not a magic px).

**Rationale:** The substrate already supports both; the message editor simply does not forward them. Two prop lines, no new behavior.

**Implications:** `TugMessageEditorProps` grows two optional fields; the render forwards them. No change to the `restoreState`/`clear` seams or the `onChange` filter.

#### [P07] The Changeset section: host-agnostic body + live collapsed-summary (DECIDED) {#p07-section}

**Decision:** `lens/sections/changeset-section.tsx` exports `registerChangesetSection()` calling `registerLensSection({ kind: "changeset", title: "Changeset", glyph: <GitBranch size={14}/>, collapsedSummary: () => <ChangesetCollapsedSummary/>, body: () => <ChangesetSectionBody/> })`, registered from `main.tsx` beside `registerLogSection`/`registerTelemetrySection`. `ChangesetSectionBody` is the lifted `ChangesetCardContent` inner render minus the pane/card chrome: it reads `useChangesetAll()` + `useOpenBindings()`, builds items, renders the Expand/Collapse-all row ([Q04]) then the `ChangesetEntryBlock` stack with `EntryBody`, and hosts the `useTugSheet` alert host. `ChangesetCollapsedSummary` subscribes to the same stores and returns `N session{s} · M dirty file{s}` (M = summed dirty files across the shown entries). The body imports only changeset stores + tugways blocks — nothing from `lens/` ([P07] of `lens-frame.md`: host-agnostic).

**Rationale:** The M3a section contract wants a required live `collapsedSummary` (the hallmark) and a host-agnostic body; the changeset content already reads app-level singletons, so it moves with no lens coupling. `EntryBody` and its subtree move verbatim (R01).

**Implications:** `changeset-card.tsx` → `lens/sections/changeset-section.tsx` (`git mv` the `.tsx`/`.css`, renaming the CSS classes' file home; keep class names to avoid churn). The `useTugSheet` host lives inside the section body. `TugAlert`/`presentAlertSheet` usage is unchanged.

#### [P08] Nested sticky under the band; no inner scroll (DECIDED) {#p08-sticky}

**Decision:** The section body renders the entry stack **inline** — remove `.changeset-scroll`'s `overflow` (the Lens content's `.lens-content` scroll owns scrolling). The `LensSection` band writes `--tugx-pin-stack-top`; the `ChangesetEntryBlock` header pins at that offset, and the entry's existing pin-clearance pair (the `.changeset-entry-block` rule in the relocated CSS) offsets the `ChangesetFileBlock` header beneath it — the same two-tier telescope the transcript uses. No third sticky level is introduced (the band is a participant band, not a `BlockChrome`, per `lens-frame.md` [P06]).

**Rationale:** A section must not create a competing scroll container inside the Lens scroll (sticky offsets would resolve against the wrong ancestor). The band + entry + file tiers match the intended M3a stack.

**Implications:** The relocated CSS drops the scroll's `overflow`/`height`; an app-test scrolls the Lens with the changeset section expanded and asserts a pinned entry header's top clears the band bottom (the sticky-header-reveal discipline).

#### [P09] The dash-worktree lexical strip stays a follow-on; only `session_user_prompts` is fixed here (DECIDED) {#p09-dash-strip-followon}

**Decision:** Fix the `session_user_prompts` strip that `c6d7b806` broke — compare the now-repo-relative `e.file_path` against the repo-relative `dirty` set directly (drop the `strip_prefix(&key.project_dir)`), so `since_ms` is again the earliest touch time of the entry's dirty paths. Leave `gather_dash`'s worktree path handling and the broader `CanonicalPath` gateway adoption as an explicit follow-on (`dash/canonical-path-identity.md` `[#canonicalize-audit]`).

**Rationale:** The `session_user_prompts` strip is silently wrong *now* (relative path never strips → `since_ms = 0` → over-broad prompt window) and this plan is already rewriting the file; fixing it is a cheap correctness win. The dash strip is orthogonal to the on-demand change and better handled with the rest of the gateway adoption.

**Implications:** One `draft_engine` unit test asserts `session_user_prompts` (or the `since_ms` fold it feeds) selects the min touch time for a repo-relative `file_events` row, not 0.

---

### Deep Dives {#deep-dives}

#### The draft engine, before and after {#draft-engine-before-after}

**Before:** `main.rs` creates `changeset_all_tx/rx` and calls `supervisor.start_draft_engine(changeset_all_rx.clone(), cancel)`, which spawns `DraftEngine::run`. `run` selects on the watch; each frame → `reconcile` → `eligible_entries` → per-entry: if the change key moved, spawn a task that sleeps `QUIET_PERIOD` then `generate_for_entry`, whose first act is the fingerprint gate.

**After:** `main.rs` still creates `changeset_all_tx/rx`; `start_draft_engine` (or its renamed successor) stores `changeset_all_rx.clone()` on the supervisor and spawns no loop. A `changeset_draft_request` verb → `do_changeset_draft_request` borrows the latest frame → `spawn_on_demand_draft` → `eligible_entries` (target derivation only, synchronous) → `tokio::spawn(generate_for_entry)` (no gate, detached — R02) → returns to the router loop at once. The streaming (`send_state`/`send_delta`) and persistence (`upsert_changeset_draft` + `changeset_all_bump`) are unchanged and run on the detached task, so the client overlay and the `entry.draft` snapshot field behave exactly as before — just triggered by a click, and delivered while the socket loop stays live.

#### The composer, before and after {#composer-before-after}

The `commitComposer` `BlockChrome` is unchanged in shape (lifecycle dot = drafting indicator, copy-draft + "Use latest draft" header actions, width-stabilized Commit footer, `TugMessageEditor` body or numstat receipt). M3b adds a **"Generate message"** header action (`TugPushButton`, `data-testid="changeset-generate-draft"`) that unpins + `requestDraft()`s, passes `lineWrap` + a smaller `fontSize` to the editor, and broadens the render guard to `isDraftable`. The pristine-follow / pin / clear-on-commit effects stay.

---

### Specification {#specification}

**Spec S01: `changeset_draft_request` wire shape** {#s01-verb}

Client → tugcast, `FeedId::CONTROL`:
```json
{ "action": "changeset_draft_request",
  "project_dir": "<abs project dir>",
  "owner_kind": "session" | "unattributed" | "dash",
  "owner_id": "<session id | '' | dash branch>" }
```
Server replies ride the **existing** `changeset_draft_state` / `changeset_draft_delta` stream (`send_state`/`send_delta`), emitted from the detached generation task (R02). The `"nothing to generate"` error reply is sent synchronously by `do_changeset_draft_request` before it returns; the `drafting`/deltas/`ready` sequence arrives asynchronously as the spawned task runs. The only new reply is the [Q02] `changeset_draft_state { state: "error", detail: "nothing to generate" }` when no eligible entry matches. `owner_kind`/`owner_id` match the card's `EntryBody` derivation: session → `item.entry.owner_id`; unattributed → `""`; dash → the entry's branch (`owner_id`).

**Spec S02: `TugMessageEditor` new props** {#s02-editor}

```ts
lineWrap?: boolean;   // → TugTextEditor.lineWrap (EditorView.lineWrapping + data-wrap)
fontSize?: string;    // → TugTextEditor.fontSize (--tug-font-size-editor)
```
Both optional, forwarded verbatim; defaults preserve current behavior (no wrap, editor default font).

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Draft overlay (drafting/ready/error + streamed text) | data | `changeset-draft-store` via `useChangesetDraft` (`useSyncExternalStore`) | [L02] |
| Generate request | action | `requestDraft` → `sendControlFrame("changeset_draft_request")` | [L11] |
| Commit-message text | component data | CM6 doc mirrored out; `message` `useState` | [L02], [L24] |
| `pinned` | component data | `useState`; Generate/commit reset it | [L24] |
| Commit-message soft-wrap + font | appearance | `TugTextEditor` `lineWrap`/`fontSize` → CSS/DOM | [L06] |
| Section collapsed-summary counts | data (derived) | `useChangesetAll` + bindings | [L02] |
| Section order / visibility / collapse | data | `dev.tugtool.lens` (M3a, unchanged) | [L02] |
| Entry / file collapse (within the section) | component data | `useState` + `ToolBlockCollapseContext` (unchanged) | [L24] |
| Band sticky offset for entry headers | appearance | `--tugx-pin-stack-top` (M3a band) + `.changeset-entry-block` clearance | [L06] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/lens/sections/changeset-section.tsx` | the `kind: "changeset"` registrant: band descriptor + host-agnostic body (lifted `EntryBody` subtree) + `collapsedSummary` |
| `tugdeck/src/components/lens/sections/changeset-section.css` | relocated changeset styles (from `changeset-card.css`), scroll `overflow` removed ([P08]) |
| `tests/app-test/at0237-changeset-draft.test.ts` | on-demand draft round trip (real-scribe-gated) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `spawn_on_demand_draft` | pub fn (spawns) | `feeds/draft_engine.rs` | sync eligibility; `tokio::spawn`s `generate_for_entry`; no gate; returns at once ([P01], R02) |
| `DraftEngine`/`run`/`reconcile`/`EntryHandle`/`QUIET_PERIOD` | delete | `feeds/draft_engine.rs` | watch-tap machinery removed ([P01]) |
| `PendingEntry` | struct (shrink) | `feeds/draft_engine.rs` | `{ key, target }` — drop `change_key` + its computations |
| fingerprint early-return | delete | `feeds/draft_engine.rs` `generate_for_entry` | keep fingerprint compute/persist ([P02]) |
| `session_user_prompts` strip | fix | `feeds/draft_engine.rs` | compare repo-relative `file_path` to `dirty` directly ([P09]) |
| `changeset_draft_request` arm | match arm | `feeds/agent_supervisor.rs` `handle_control` | beside `changeset_commit` ([P03]) |
| `do_changeset_draft_request` | async fn | `feeds/agent_supervisor.rs` | borrow watch frame → `spawn_on_demand_draft` (returns at once); nothing-to-draft reply; never awaits generation ([P03], [Q02], R02) |
| `parse_changeset_draft_request_payload` | fn | `feeds/agent_supervisor.rs` | mirror `parse_changeset_commit_payload` |
| stored aggregate watch receiver | field + setter | `feeds/agent_supervisor.rs` | `changeset_watch: Option<watch::Receiver<Frame>>` |
| `start_draft_engine` | fn (rewrite) | `feeds/agent_supervisor.rs` + `main.rs` call | store the watch rx; spawn no loop ([P03]) |
| `requestDraft` | method + hook return | `lib/changeset-draft-store.ts` | `sendControlFrame` trigger ([P05]) |
| `lineWrap` / `fontSize` | props | `tug-message-editor.tsx` | pass-through ([P06], Spec S02) |
| "Generate message" button + `isDraftable` guard | UI + logic | changeset composer (moves to `changeset-section.tsx`) | [P04] |
| `registerChangesetSection` | fn | `lens/sections/changeset-section.tsx` | `registerLensSection`, called from `main.tsx` ([P07]) |
| `registerChangesetCard` + `main.tsx` call | delete | `changeset-card.tsx`, `main.tsx` | card retired ([#step-5]) |

#### Files deleted {#files-deleted}

`tugdeck/src/components/tugways/cards/changeset-card.tsx` and `changeset-card.css` — content moves (`git mv`) to `lens/sections/changeset-section.tsx` / `.css`; the `registerChangesetCard` export and its `main.tsx` import/call are removed, not moved.

---

### Test Plan Concepts {#test-plan-concepts}

Real tests only. New at-number: **at0237** (max used is `at0236`; `at0229` is an existing two-file collision — do not extend it; `at0232` is free but claim sequentially from at0237).

| Category | Purpose |
|----------|---------|
| Unit (`cargo nextest`) | `spawn_on_demand_draft` regenerates ignoring the fingerprint; nothing-to-draft returns false; `session_user_prompts`/`since_ms` picks the min touch time for a repo-relative row; no `DraftEngine::run` remains |
| Unit (`bun test`) | `filterRegisteredCards`/`loadLayout` drops a `componentId:"changeset"` card once the registrant is gone, keeping the stack (the graceful-degrade path — not app-testable, per at0230) |
| Integration (`just app-test`, default) | `at0228`/`at0229` retargeted at `.lens-section[data-lens-section="changeset"]`; a pinned entry header clears the band on scroll ([P08]); the composer field soft-wraps at the reduced font |
| Integration (`just app-test`, real-claude gated) | `at0237`: Generate → `in_flight` dot → streamed delta fills the field → `success` |

#### What stays out of tests {#test-non-goals}

- No jsdom/RTL, no mock stores, no synthetic fixtures — drive the real app + real git (+ real scribe behind the gate).
- No pixel snapshots — assert structure/attributes and store/deck/overlay state.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Rust steps run `cd tugrust && cargo nextest run` + `cargo build` (warning-clean). tugdeck steps run `bunx tsc --noEmit && bunx vite build && bun test`; app-test steps add `just app-test`. Name touched laws in each commit.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Draft engine → on-demand `spawn_on_demand_draft` | done | 5cdf1198b |
| #step-2 | `changeset_draft_request` verb + supervisor/main wiring | done | 5cdf1198b |
| #step-3 | `TugMessageEditor` soft-wrap + font pass-throughs | done | 8120dcdbe |
| #step-4 | "Generate message" button + on-demand seed contract (on the card) | done | 6118aacf0 |
| #step-5 | Lift `EntryBody` into the Changeset section; retire the card; migrate at0228/at0229 | done | 963c3a4b4 |
| #step-6 | at0237 on-demand draft app-test (real-scribe gated) | dropped | — |

> **Step 6 dropped.** The on-demand draft is a long-running, real-scribe (real
> `claude -p`) UI flow. In the app-test harness the changeset entry only exists
> while its replay session's workspace is registered (`registry.project_dirs()`),
> and that workspace releases seconds after the replay tugcode exits — far
> shorter than a real scribe round trip. The feature was observed working
> end-to-end (Generate → `in_flight` dot → streamed text into the CM6 field)
> before the transient workspace dropped, but a stable green app-test would need
> a persistent-workspace harness affordance that doesn't exist. The on-demand
> round trip is instead covered deterministically by the Rust
> `changeset_draft_request_spawns_generation_over_snapshot` supervisor test and
> the `draft_engine` unit tests ([#step-1]/[#step-2]). Product validation of the
> UI flow is by hand.

---

#### Step 1: Draft engine → on-demand `spawn_on_demand_draft` {#step-1}

**Commit:** `tugcast(draft-engine): on-demand spawn_on_demand_draft; drop the watch-tap debounce loop [P01][P02]`

**References:** [P01] ([#p01-on-demand]), [P02] ([#p02-fingerprint-gate]), [P09] ([#p09-dash-strip-followon]), [Q01] ([#q01-fingerprint]), R02 ([#r02-socket-stall]), (#draft-engine-before-after)

**Artifacts:** `feeds/draft_engine.rs`.

**Tasks:**
- [ ] Delete `DraftEngine::run`, `reconcile`, `EntryHandle` (+ `Drop`), `QUIET_PERIOD`, `PendingEntry.change_key`, `head_change_key`, `unattributed_change_key`, and the dash change-key format. Shrink `PendingEntry` to `{ key, target }`; update `eligible_entries` accordingly.
- [ ] Add `pub fn spawn_on_demand_draft(...) -> bool` per [P01]: build an owned `EngineDeps`, run `eligible_entries(snapshot)`, match `(project_dir, owner_kind, owner_id)`; on no match return `false`; on a match `tokio::spawn(async move { generate_for_entry(&deps, &key, &target).await })` (owned deps/key/target moved in) and return `true`. It does **not** await generation (R02).
- [ ] Remove the fingerprint early-return in `generate_for_entry`; keep `fingerprint_*` compute + `ChangesetDraftRow.fingerprint` persist ([P02]).
- [ ] Fix `session_user_prompts`: compare the repo-relative `e.file_path` to the repo-relative `dirty` set directly (drop `strip_prefix(&key.project_dir)`), so `since_ms` is the min touch time ([P09]).
- [ ] Audit unused `use`s (`watch`, `CancellationToken`, `JoinHandle`, `HashMap`) and remove any that fall dead (`-D warnings`). `mpsc` **stays** — `generate_for_entry`'s delta forwarder uses it.

**Tests (`cargo nextest`):**
- [ ] `on_demand_regenerates_ignoring_fingerprint` — seed a persisted draft with the matching fingerprint (via the existing `init_repo` + `FakeScribe`), call `spawn_on_demand_draft`, poll with the existing `wait_for_draft` helper (the generation is on a spawned task), assert `FakeScribe.calls == 1` and the row is re-persisted.
- [ ] `on_demand_no_entry_returns_false` — a snapshot with a clean/fileless entry returns `false` synchronously and makes no scribe call.
- [ ] `session_prompts_since_uses_repo_relative_paths` — a `file_events` row with a repo-relative `file_path` folds into `since_ms` as its touch time, not 0.
- [ ] Replace the two `engine.run`-driven tests.

**Checkpoint:** `cd tugrust && cargo nextest run -p tugcast draft_engine` + `cargo build` warning-clean.

---

#### Step 2: `changeset_draft_request` verb + supervisor/main wiring {#step-2}

**Depends on:** #step-1

**Commit:** `tugcast(changeset): changeset_draft_request CONTROL verb over the aggregate snapshot [P03]`

**References:** [P03] ([#p03-verb]), Spec S01 ([#s01-verb]), [Q02] ([#q02-nothing-to-draft]), R02 ([#r02-socket-stall]), (#draft-engine-before-after)

**Artifacts:** `feeds/agent_supervisor.rs`, `main.rs`.

**Tasks:**
- [ ] Store the aggregate watch receiver on the supervisor (`changeset_watch: Option<watch::Receiver<Frame>>`); rewrite `start_draft_engine` to store `changeset_all_rx.clone()` and spawn no loop (rename to `set_changeset_watch` if clearer — cite it in the commit). Update the `main.rs:1081` call site.
- [ ] Add `parse_changeset_draft_request_payload` (mirror `parse_changeset_commit_payload`): `{ project_dir, owner_kind, owner_id }`.
- [ ] Add the `"changeset_draft_request"` arm in `handle_control` → `do_changeset_draft_request(&parsed)`.
- [ ] `do_changeset_draft_request`: guard on scribe + `session_ledger` (as `start_draft_engine` did); rebuild the `resolver` closure; `borrow()` the stored watch frame → decode `WorkspacesChangesetSnapshot`; call `spawn_on_demand_draft(...)` (returns at once — do **not** await generation, R02); on `false`, `control_tx.send` a `changeset_draft_state { state:"error", detail:"nothing to generate" }` ([Q02]). `handle_control` returns `Ok(())` immediately.

**Tests (`cargo nextest`):**
- [ ] A supervisor test seeded like the `changeset_git_init` test (`agent_supervisor.rs` ~5873) — `ScribeContext` (`FakeScribe`) + in-memory + read-side ledger + an aggregate watch frame with one dirty session entry. Call `handle_control("changeset_draft_request", …)`; because generation is detached, **poll the CONTROL broadcast receiver in a bounded loop** (the pattern the `changeset_join_resolve` test at `agent_supervisor.rs` ~6156 already uses) for `changeset_draft_state "drafting"` then `"ready"`, and assert the draft row is persisted — do NOT assert on `handle_control`'s return, which precedes generation.
- [ ] Nothing-to-draft: a clean snapshot yields a synchronous `changeset_draft_state "error"` detail "nothing to generate" (readable on the receiver right after the call).

**Checkpoint:** `cd tugrust && cargo nextest run -p tugcast agent_supervisor draft_engine` + `cargo build` warning-clean.

---

#### Step 3: `TugMessageEditor` soft-wrap + font pass-throughs {#step-3}

**Depends on:** (none — independent)

**Commit:** `tugdeck(message-editor): forward lineWrap + fontSize to the substrate [L06][L20]`

**References:** [P06] ([#p06-editor-props]), Spec S02 ([#s02-editor])

**Artifacts:** `tugdeck/src/components/tugways/tug-message-editor.tsx`.

**Tasks:**
- [ ] Add `lineWrap?: boolean` and `fontSize?: string` to `TugMessageEditorProps`; forward both to `TugTextEditor` in the render. Preserve current defaults (no wrap, default font).

**Tests (`bun test`):**
- [ ] Extend/keep the message-editor unit coverage if present; the visible behavior is asserted in the app-test at [#step-5] (the composer wires the props there). If no unit test exists, this step's proof is tsc + the [#step-5] app-test.

**Checkpoint:** `bunx tsc --noEmit && bunx vite build && bun test`.

---

#### Step 4: "Generate message" button + on-demand seed contract (on the card) {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tugdeck(changeset): on-demand "Generate message" + soft-wrapped composer [L02][L11]`

**References:** [P04] ([#p04-seed-contract]), [P05] ([#p05-request-draft]), [P06] ([#p06-editor-props]), (#composer-before-after)

**Artifacts:** `lib/changeset-draft-store.ts`, `changeset-card.tsx` (still the card at this step).

**Tasks:**
- [ ] `changeset-draft-store.ts`: store the `TugConnection`; add `requestDraft(projectDir, ownerKind, ownerId)` → `sendControlFrame("changeset_draft_request", …)`; make `useChangesetDraft` return `DraftOverlay & { requestDraft: () => void }` bound to its `(projectRoot, ownerKind, ownerId)`; no-op fallback when unattached.
- [ ] Composer: add a "Generate message" `TugPushButton` (`data-testid="changeset-generate-draft"`) to `headerActions` that calls `setPinned(false)` then `requestDraft()`. Broaden the `commitComposer` render guard to include `isDraftable` ([P04]) so a fresh entry shows the affordance.
- [ ] Pass `lineWrap` + a smaller `fontSize` token to the composer's `TugMessageEditor`.
- [ ] Correct the stale "draft is maintained automatically" note in `entryDiffActionsRow`.

**Tests (`bun test` + app-test at [#step-5]/[#step-6]):**
- [ ] tsc + build green; the round-trip is asserted by at0237 ([#step-6]); the soft-wrap by the [#step-5] app-test.

**Checkpoint:** `bunx tsc --noEmit && bunx vite build && bun test`.

---

#### Step 5: Lift `EntryBody` into the Changeset section; retire the card; migrate at0228/at0229 {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(lens): Changeset section supersedes the changeset card [L02][L06][L22]`

**References:** [P07] ([#p07-section]), [P08] ([#p08-sticky]), [Q04] ([#q04-toolbar]), R01 ([#r01-responder]), (#files-deleted)

**Artifacts:** `lens/sections/changeset-section.tsx` (+ `.css`), `main.tsx`, `tests/app-test/at0228-*.test.ts`, `tests/app-test/at0229-changeset-dash-join.test.ts`, a `bun test` over `filterRegisteredCards`/`loadLayout` (deck-manager or serialization test module).

**Tasks:**
- [ ] `git mv` `changeset-card.tsx` → `lens/sections/changeset-section.tsx` and `changeset-card.css` → `changeset-section.css` (keep CSS class names). Move `EntryBody` + `ChangesetEntryBlock` + `ChangesetFileBlock` + `DashActions` + `NonRepoBody` + the composer **verbatim** (responder scope intact, R01).
- [ ] Replace the exported `ChangesetCardContent` + `registerChangesetCard` with `ChangesetSectionBody` + `ChangesetCollapsedSummary` + `registerChangesetSection()` ([P07]). Keep Expand/Collapse-all as the body's first row; drop the "N sessions" toolbar label ([Q04]). Host `useTugSheet` inside the body.
- [ ] `changeset-section.css`: remove the scroll container's `overflow`/`height` so the Lens content scroll owns scrolling; keep the `.changeset-entry-block` pin-clearance pair ([P08]).
- [ ] `main.tsx`: remove the `registerChangesetCard` import + call; add `registerChangesetSection()` beside `registerLogSection`/`registerTelemetrySection`.
- [ ] Grep for `addCard("changeset")` / any menu/action opening the changeset card; remove or repoint to the Lens.
- [ ] Retarget `at0228` + `at0229`: **replace the `seedDeckState` of a `{ componentId: "changeset" }` card** (at0228 seeds one at `id: "A"`, scoping selectors under a `CARD` prefix; at0229 similarly) with `app.seedDeckState` of a Lens pane + `dispatchControlAction("toggle-lens")` (per at0235), then expand the changeset section. Rewrite the `CARD` selector prefix to `.lens-section[data-lens-section="changeset"]`. Keep every existing assertion (open-card filter, git-init self-heal, file click, diff scope, commit; dash conflict preview + clean squash-join). Add a scroll-and-assert that a pinned entry header clears the band ([P08]).
- [ ] Add a `bun test` (fixup for the graceful-degrade, which is NOT app-testable — test-mode `DeckManager` ignores the persisted layout, per at0230's docstring): feed `filterRegisteredCards` (via `loadLayout`'s parse path) a deck state carrying a `componentId: "changeset"` card after the registrant is removed; assert the card is dropped (and, if it was a stack's only card, the stack is dropped) with the rest of the layout intact.

**Tests:** `bun test` (incl. the `filterRegisteredCards` unit) + `just app-test` (at0228, at0229).

**Checkpoint:** `bunx tsc --noEmit && bunx vite build && bun test`; `just app-test`; `grep -rn "registerChangesetCard\|changeset-card\|addCard(\"changeset\")" tugdeck/src tests/app-test` → no matches.

---

#### Step 6: at0237 on-demand draft app-test (real-scribe gated) {#step-6}

**Depends on:** #step-5

**Commit:** `test(at0237): on-demand changeset draft — Generate → drafting → live delta → ready`

**References:** [P03] ([#p03-verb]), [P04] ([#p04-seed-contract]), Spec S01 ([#s01-verb])

**Artifacts:** `tests/app-test/at0237-changeset-draft.test.ts`.

**Tasks:**
- [ ] New app-test gated behind the suite's real-claude env flag (the same gate other scribe-exercising app-tests use — grep `tests/app-test/` for the real-claude gate name and match it; the default `just app-test` run must skip it). Open a real dev card on a scratch git repo with a dirty file, open the Lens, expand the changeset section, click `changeset-generate-draft`; assert the composer dot enters `in_flight`, the `changeset-commit-message` field receives streamed text, and the dot lands `success`.

**Tests:** `just app-test` (real-claude gate on); default `just app-test` skips at0237 but stays green.

**Checkpoint:** `bunx tsc --noEmit && bunx vite build && bun test`; `just app-test` (default: at0237 skipped; real-claude: at0237 green).

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The commit-message draft is generated **on demand** (a "Generate message" button → `changeset_draft_request` → a gate-free `spawn_on_demand_draft` whose detached task streams the draft in), the composer soft-wraps at a smaller font, and the whole changeset surface lives as a Lens **section** (`kind: "changeset"`, live collapsed-summary) — the standalone card is deleted, and `at0228`/`at0229` pass against the section.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Generate → `in_flight` → streamed delta → `success`, on a real session (at0237, real-claude); `spawn_on_demand_draft` regenerates ignoring the fingerprint (unit). ([#step-1], [#step-6])
- [ ] No draft without an explicit request; the watch-tap loop is gone (code review + unit). ([#step-1])
- [ ] The commit-message field soft-wraps at the reduced font. ([#step-3], [#step-5])
- [ ] The changeset card is deleted; a `filterRegisteredCards` `bun test` proves a persisted `"changeset"` card is dropped cleanly; no `addCard("changeset")` remains. ([#step-5])
- [ ] The Changeset section renders under the Lens with a live "N sessions · M dirty files" summary; at0228/at0229 pass against it. ([#step-5])
- [ ] `session_user_prompts` selects the min touch time on repo-relative rows (unit). ([#step-1])
- [ ] `bunx tsc --noEmit && bunx vite build && bun test && (cd tugrust && cargo nextest run)` green; `cargo build` warning-clean.

**Acceptance tests:** at0228 (retargeted), at0229 (retargeted), at0237 (new, real-claude), `draft_engine::on_demand_regenerates_ignoring_fingerprint`, the `agent_supervisor` draft-request round-trip test.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **M3c** — the Git History section (new `GIT_LOG` feed + read-only view).
- [ ] Adopt the `CanonicalPath` gateway for `gather_dash`'s worktree path handling ([#p09-dash-strip-followon]; `dash/canonical-path-identity.md` `[#canonicalize-audit]`).
- [ ] Optional opt-in auto-draft mode reusing the retained fingerprint (no schema change needed, [P02]).

| Checkpoint | Verification |
|------------|--------------|
| On-demand backend | `cargo nextest run -p tugcast draft_engine agent_supervisor` |
| Composer soft-wrap + Generate | at0237 + [#step-5] app-test |
| Card retired, section live | [#step-5] grep + at0228/at0229 |
