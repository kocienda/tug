<!-- devise-skeleton v4 -->

## Changes · Commit · Dash · Join Consolidation {#changes-commit-dash-consolidation}

**Purpose:** Unify Tug's change-tracking, committing, and dash-joining into one opinionated workflow — every change lands through an editable, durable **Draft** in the Changes shade, and lands via a native **`/commit`** / **`/join`** gesture from the prompt entry — so the user never drops to terminal git, bbedit, or raw `tugutil dash` again.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-18 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The attribution layer is sound (tuglaws/tracking-changes.md — proof-only ownership, per-file repo roots, machine-global ledger, [D112]) and most of the *plumbing* for this plan already exists, but there is no *workflow*: commit and join today are spread across Claude's built-in `/commit` (commits sight-unseen, ignores our buckets), `tugplug:commit` (same fire-and-forget contract), the awkward `!changes commit <message>` prompt idiom, terminal `git` + bbedit (the only place with full message authorship), and terminal `tugutil dash join` (no preview visible, feels unsafe). The Changes shade shows truth but is not the place work lands; drafts are generated blurbs, not editable documents; dash entries render in the same visual grammar as session files, causing "why is this branch in my session's changes?" confusion.

Investigation found the parts largely built: tugcast already handles `changeset_commit`, `changeset_draft_request`, `changeset_join` (with in-memory `git merge-tree` preview), and `changeset_join_resolve` (streamed AI conflict resolution) as CONTROL verbs in `agent_supervisor.rs::handle_control`; drafts persist in `changeset_drafts` (`session_ledger.rs::ChangesetDraftRow`) and stream live deltas (`changeset_draft_state`/`changeset_draft_delta`, deck store `lib/changeset-draft-store.ts`); `TugMessageEditor` (`components/tugways/tug-message-editor.tsx`) is a finished commit-message composer over the `TugTextEditor` CM6 substrate with the [P28]-style "pin only on human edit" contract, and now has a **live reference consumer** in `lens/sections/snippets-section.tsx` (the snippet in-place editor: `editorRef` + `restoreState` + `onChange` + `onSubmit`/⌘Return — the exact composition Step 4 needs), which de-risks the composer mount. This plan is consolidation: wire what exists into one lifecycle, add the few genuinely missing pieces (draft editability + persistence of edits, machine-global draft storage, the `/commit`//`/join` verbs, zone scoping, receipts), and retire the fragments.

#### Strategy {#strategy}

- One lifecycle — **Gather → Draft → Land** — two lanes (main-lane commit, dash-lane join), one room (the Changes shade), one landing gesture (prompt-entry `/commit` and `/join`).
- Promote the draft from generated blurb to the **unit of work**: message + selection dispositions + edited-provenance, durable, machine-global, editable in a `TugMessageEditor` mounted in the shade.
- Build bottom-up: draft storage/verbs first, then the composer, then the zone split, then the prompt gestures, then receipts, then skills/docs — each step independently shippable.
- Skills draft, humans land: `tugplug:commit` renames to `tugplug:draft` and never commits; Claude's built-in `/commit` is shadowed dead by the local verb.
- Reuse over invention: `TugMessageEditor`, the existing CONTROL verbs, `JoinOptions::preview`, the Lens jump affordance (`focus-session-card`), and the established landing gates from the `!changes commit` handler.
- Squash is the only join strategy in the workflow ( `JoinStrategy::Merge` stays a CLI-only expert path).

#### Success Criteria (Measurable) {#success-criteria}

- A full main-lane landing — edits → `/commit` (beat 1: draft appears in shade) → edit message in shade → `/commit` (beat 2: lands) — completes with zero terminal use; receipt visible in the transcript and History. (Manual walkthrough + app-test.)
- A full dash-lane landing — `implement` finishes → `/join <name>` previews clean → lands squash with the join draft as message — completes with zero terminal use. (Manual walkthrough; Rust integration tests for preview/execute.)
- A user-edited draft survives app restart and Maker ▸ Reload, and is never overwritten by the draft engine. (Rust test on the `edited` gate + manual reload check.)
- Typing `/commit` never reaches Claude's built-in skill. (bun test on the matcher; manual check.)
- The Changes shade's Zone 2 renders collapsed to one line by default, and an expanded session row jump-links to that session's card. (app-test where feasible; bun test on the summarizer.)
- `cargo nextest run`, `bun test`, `bunx vite build`, and `just app-test` all green at phase end.

#### Scope {#scope}

1. Machine-global, edit-aware draft storage + `changeset_draft_set` verb + `tugutil draft` CLI.
2. The Zone 1 draft composer (`TugMessageEditor` in the Changes shade) with persisted selection dispositions.
3. Zone split: "This session" / collapsed "Also on this project" with session jump-links and dash lanes.
4. Unattributed bracket hints surfaced in compose and the shade.
5. Native `/commit` (double-duty) and `/join` local slash verbs; retirement of `!changes commit|describe` sub-verbs, Claude's built-in `/commit`, and the Z5 "Generate a commit message" prompt-row button.
6. Landing receipts as transcript ink; History join badges; release receipts.
6a. Release hardening: shade-only gesture with a discard preflight, draft cleanup on release/join, and the empty-dash join→release handoff ([P14]).
6b. `tugutil context` → `tugutil preflight` rename ([P16]) — "context" is AI-reserved vocabulary.
6c. The shade becomes a presentation style of `TugSheet` — card-modal over the transcript, prompt entry live ([P17]); `TugShade` retires.
7. `tugplug:commit` → `tugplug:draft` rename; `implement` skill ending hands off to `/join`.
8. Laws/docs updates.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Changing attribution/capture semantics (tracking-changes.md is settled by the prior phase).
- The `JoinStrategy::Merge`/`Rebase` paths in the UI — squash only ([P05]).
- Committing the unattributed pool from Zone 2 without a session adopting it ([Q01], deferred).
- Reworking the Lens changeset sections or the all-projects aggregate card beyond what the shared types force.
- Dash *creation* UX — `implement`/`dash` skills keep auto-creating worktrees exactly as today.
- Multi-repo sessions in one card, message templates, commit signing.

#### Dependencies / Prerequisites {#dependencies}

- The proof-only attribution phase (landed: `ef35b6449`, `7109533ed`, `b191647ce`) — bucket semantics this plan renders.
- `git ≥ 2.38` for join preview (`git merge-tree --write-tree`) — already gated by `tugdash-core::ops::git_supports_merge_tree`.
- tugcast/tugdeck CONTROL frame plumbing (`TugConnection.sendControlFrame`, supervisor `handle_control`) — exists.

#### Constraints {#constraints}

- **All text editing/entry uses the `TugTextEditor` substrate** — the draft composer is `TugMessageEditor`; no browser-native `<textarea>`/`<input>` anywhere in these surfaces (project law [L20]-style composition; the user's explicit mandate).
- Rust workspace `-D warnings`; deck changes must pass `bunx vite build` (dev-esbuild-only imports hang the release app at splash).
- No localStorage/sessionStorage/IndexedDB — durable client state goes through tugbank or rides tugcast feeds.
- HMR must never reload data; Maker ▸ Reload re-resumes from JSONL — draft durability must hold across both.
- tugdeck work honors the tuglaws (L01/L02/L03/L06 especially); see the State Zone Mapping.
- Skills remain agentless and main-loop-driven (tugplug/CLAUDE.md).

#### Assumptions {#assumptions}

- One dash at a time is the common case (the summary line and `/join` bare-form optimize for it), but nothing breaks with several.
- The draft engine's headless scribe stays on-demand (no background maintenance loop added by this plan; [Q03] defers it).
- WAL co-writing `changes.db` from `tugutil` is safe — the same contract multiple tugcast instances already rely on ([D112]).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton v4 conventions: explicit `{#anchor}` on every cited heading, `[P##]` plan-local decisions, `[Q##]` open questions, `Spec S##`, `Table T##`, `Risk R##`, `**Depends on:** #step-N` lines, and `**References:**` on every step. Global decisions are cited as `[D##]` (tuglaws/design-decisions.md).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Committing the ownerless unattributed pool (DEFERRED) {#q01-unattributed-adoption}

**Question:** Should Zone 2's unattributed files (no owner anywhere) be committable directly from the shade, or only by a session adopting them into its own draft?

**Why it matters:** "Every landing has an author" is the doctrine; a shade-level ownerless commit would be the one landing without one.

**Resolution:** DEFERRED — this plan keeps the existing behavior (a session's Zone 1 selection can elect project unattributed files, mirroring `--include-unattributed`); a dedicated adoption gesture is a follow-on. Rationale: the current election path already covers the practical case.

#### [Q02] Zone 2 jump-link when the owner session has no open card (DECIDED — render unlinked) {#q02-jump-no-card}

**Question:** A Zone 2 session row's owner may have no live card (closed session with live ledger rows). What does the link do?

**Resolution:** DECIDED — see [P06]: rows with a resolvable open card get the `focus-session-card` jump; rows without render the session name unlinked (no resume affordance in this phase).

#### [Q03] Background draft maintenance (DEFERRED) {#q03-draft-maintenance}

**Question:** Should the draft engine keep drafts continuously current (regenerate on fingerprint drift) rather than on-demand?

**Resolution:** DEFERRED — on-demand only ([P03] makes auto-regeneration dangerous for edited drafts anyway). Revisit after the workflow ships and staleness is felt in practice.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| WAL co-writer contention on `changes.db` (tugutil + N tugcast) | med | low | busy_timeout + WAL on every open (already the [D112] pattern); writes are single-row upserts | SQLITE_BUSY in logs |
| Draft staleness vs a moved diff | med | med | fingerprint mismatch renders a "changes moved since this draft" marker, never blocks ([P02]) | user reports stale landings |
| `/commit` matcher shadowing fails and the line reaches Claude | high | low | local-match-before-send is the existing `matchLocalSlashCommand` contract; pinned bun test | any transcript showing built-in /commit output |
| Zone rework destabilizes the shipped Changes shade | med | med | steps 5–6 are view-layer only over unchanged stores; app-test + vite build per step | visual regressions |
| Join lands with a stale/foreign-authored draft message | low | low | `/join` beat-1 always shows the preview + draft in the shade first; landing is beat 2 | — |

**Risk R01: Aggregate feed poll violates its event-driven doctrine** {#r01-aggregate-poll}

- **Risk:** `ChangesetAllFeed` recomputes strictly on a `Notify` bump ("every recompute is driven by a real event", `feeds/changeset_all.rs`); out-of-process `tugutil draft set` writes are invisible to it.
- **Mitigation:** a 2 s drafts-version probe (`SELECT MAX(updated_at) FROM changeset_drafts`) that fires the existing bump only on change — the event is real (a draft write), only its observation is polled, same as `git_watch`'s relationship to git state. Document in the module header.
- **Residual risk:** ≤2 s latency between a skill's `draft set` and the card showing it. Acceptable.

---

### Design Decisions {#design-decisions}

#### [P01] One lifecycle, one room, one gesture (DECIDED) {#p01-lifecycle}

**Decision:** Every change lands through **Gather → Draft → Land**: buckets/rounds gather truth, an editable durable Draft proposes the landing, and the prompt-entry verbs `/commit` (main lane) and `/join` (dash lane) land it. The Changes shade is where drafts are reviewed and edited; the prompt entry is where landings execute.

**Rationale:**
- Landing is an act of the session — it belongs where session acts happen, and its receipt belongs in the transcript (user ruling).
- The shade is already the truth surface; making it also the *edit* surface completes it without inventing a modal.

**Implications:** the shade's commit button paths and `!changes commit` idiom retire in favor of the verbs; every landing produces transcript ink ([P09]).

#### [P02] The Draft is the unit of work: message + selection + provenance, machine-global (DECIDED) {#p02-draft-unit}

**Decision:** `changeset_drafts` moves from the per-instance `sessions.db` to the machine-global `changes.db` (alongside `file_events`), and grows `edited INTEGER` (human-touched flag) and `selection TEXT` (JSON array of repo-relative path overrides against the default selection rule). The draft is keyed as today by `(owner_kind, owner_id, project_dir)`.

**Rationale:**
- Same scope axiom as [D112]: the working tree is machine-global, so the truth about its proposed landing must be too — two app instances on one checkout must see one draft.
- Selection dispositions (include a hinted file, exclude a shared one) are part of the proposal, so they persist with it — today they are an ephemeral deck-side override map that dies with the view.
- `fingerprint` (already stored) detects drift: on mismatch the shade shows a "changes moved since this draft" marker; landing still allowed (the human is looking right at it).

**Implications:** ledger DDL/queries move schema (`changes.changeset_drafts`); a one-time migration copies per-instance rows in (same shape as `migrate_instance_file_events_to_changes` in `session_ledger.rs`); `tugchanges-core` gains read access; `tugutil draft` gains write access ([P11]).

#### [P03] Edited drafts are never machine-clobbered (DECIDED) {#p03-edited-pin}

**Decision:** Once `edited=1`, the draft engine and `changeset_draft_request` never overwrite the message; **Regenerate** in the shade is the only path, it is explicit, and it resets `edited=0` after an inline confirm (`TugConfirmPopover`).

**Rationale:** the whole point of the workflow is the user's byline; a background regeneration eating a hand-tuned message would be the worst possible bug. `TugMessageEditor`'s user-edit-only `onChange` contract makes the flag trivially accurate.

**Implications:** `do_changeset_draft_request` and `draft_engine::spawn_on_demand_draft` check `edited` before writing (a `force` payload field carries the confirmed regenerate).

#### [P04] `/commit` is a double-duty local slash verb (DECIDED) {#p04-commit-verb}

**Decision:** `/commit` joins `LOCAL_SLASH_COMMANDS` (`lib/slash-commands.ts`), dispatched by the session card exactly like the other local verbs ([D23]), with the two-beat contract of **Table T01**. Claude's built-in `/commit` is thereby shadowed dead — a matched local command never reaches `codeSessionStore.send`.

**Rationale:** slash = verb, bang = routing (the settled taxonomy in `lib/bang-commands.ts`); landing is a verb. The built-in can never play along with buckets, drafts, or gates. Double-duty (draft-then-land) is the user's explicit choice; the two-beat rhythm is self-teaching — beat 1 always leaves you looking at exactly what beat 2 will do.

**Implications:** `!changes commit <msg>` / `!changes describe` sub-verbs retire (bare `!changes` remains the routing to the shade); the gates from the retired handler (`session-card.tsx`: turn-inflight via `codeSessionStore.getSnapshot().canInterrupt`, pending-commit via `getChangesetVerbStore().commitState(entryKey).phase`, non-empty selection, non-empty message) move into the `/commit` dispatch verbatim.

**Table T01: `/commit` semantics** {#t01-commit-semantics}

| Invocation | No ready draft | Ready draft |
|---|---|---|
| `/commit` | beat 1: open Changes shade, fire `requestDraft()` (headless generation into the draft) | beat 2: apply gates, land with the draft message + persisted selection |
| `/commit <message>` | land immediately with `<message>` + current selection (gates apply) — the explicit-message fast path | same (the argument wins over the draft message; draft is consumed/cleared on success) |
| `/commit now` | generate the draft, then land it in one beat (gates apply) | land (identical to bare beat 2) |

#### [P05] `/join` mirrors `/commit`; squash only (DECIDED) {#p05-join-verb}

**Decision:** `/join` is the dash-lane local slash verb: bare `/join` opens the shade's dash lane (and, with exactly one dash, runs the preview); `/join <name>` runs preview → if clean and a join draft exists, lands via the existing `changeset_join` CONTROL verb with `JoinStrategy::Squash` and the join draft as the squash message; conflicts route into the existing `changeset_join_resolve` flow in the shade. The UI never offers merge/rebase (CLI-only expert paths).

**Rationale:** "it must feel like a commit — same part of the zoo" (user ruling); squash is settled by a few hundred real dashes. All execution machinery exists (`agent_supervisor.rs::do_changeset_join`, `tugdash-core::ops::join_in` with `JoinOptions::preview`, `merge_tree_conflicts`); the verb is a gesture over it.

**Implications:** the same landing gates apply, plus join-specific preflight surfaced from the preview (base-dirt overlap, conflicts).

#### [P06] Zone split: "This session" / "Also on this project" (DECIDED) {#p06-zones}

**Decision:** The Changes shade renders two zones. **Zone 1 — This session:** the card session's buckets, disposition checkboxes, hinted files, per-file diffs, the draft composer, and the receipt. **Zone 2 — Also on this project:** collapsed by default to one summary line (`Also on this project: 2 sessions · 5 files · 1 dash (snippets · 6 rounds · dirty)`); expanding shows one row per owner — session rows named by display name with a jump-link (`dispatchAction({action: "focus-session-card", cardId})`, the exact affordance the Lens Sessions section uses; unlinked when no open card resolves, per [Q02]) and dash rows carrying name/base/rounds/dirt with the Join entry point.

**Rationale:** the perky-frog incident — a dash branch rendered in session-file grammar reads as a claim. Different species, different grammar, different fold. "Every surface must declare whose question it's answering."

**Implications:** `session-changes-view.tsx` restructures; no store changes (the controller snapshot already separates `entry` / `dashes` / `unattributed`); the session→card mapping reuses the same binding source the Lens does — `cardSessionBindingStore` (`@/lib/card-session-binding-store`), whose snapshot is a `ReadonlyMap<cardId, CardSessionBinding{tugSessionId, projectDir}>`, and the exported `buildSessionRows(bindings)` helper in `lens/sections/sessions-data-source.ts`.

#### [P07] Skills draft; humans land (DECIDED) {#p07-skills-draft}

**Decision:** `tugplug/skills/commit` renames to `tugplug/skills/draft`: it gathers via plain `tugutil preflight` ([P16]), decides dispositions (hint doctrine), authors the message, writes it with `tugutil draft set`, and reports — it **never commits**. The `implement` skill's ending changes from "run `tugutil dash join` in a terminal" to writing the dash's join draft (`tugutil draft set --owner dash:<name>`) and pointing at `/join <name>`.

**Rationale:** the misnomer resolves by renaming to what it does; fire-and-forget was about never blocking in conversation — a draft in an editor is not a confirmation prompt, it's a document awaiting a byline.

**Implications:** SKILL.md rewrite; tugplug/CLAUDE.md skill roster update; the git-policy exception list in the repo CLAUDE.md updates (the draft skill no longer commits).

#### [P08] Landing gates: idle-only, enforced at the affordance (DECIDED) {#p08-gates}

**Decision:** Every landing (commit or join) requires: the session lifecycle **idle** (one exported predicate over `codeSessionStore`'s lifecycle state — not the `canInterrupt` proxy), no pending landing for the same key (verb/join store phase), non-empty selection (commit) or clean-or-resolved preview (join), and a non-empty message. The idle gate is enforced at **two levels**: dispatch (`/commit`/`/join` beat 2 refuses with a pane bulletin, `notify?.caution`, never silent) **and** affordance — while non-idle, every mutating control in the shade renders disabled with a reason (Regenerate, dash Join, dash Release; the release path already does this via `turnInProgress`, the doctrine makes it uniform). **Drafting stays live mid-turn**: reading diffs, flipping dispositions, and editing the message while a turn runs is the workflow's promise — only the mutating verbs idle-gate.

**Rationale:** these are the proven gates of the existing `!changes commit` handler, strengthened per user ruling — a turn in flight means files may still be moving under the selection, so the *feature* must read as unavailable, not merely bounce at dispatch.

#### [P09] Receipts are transcript ink; History badges joins (DECIDED) {#p09-receipts}

**Decision:** A successful landing appends a non-context system row to the transcript (the `session-command-block-registry.ts` local-block mechanism — the same vehicle local slash verbs use for transcript-visible results), rendering sha, subject, file count, and any `left_behind`. The History shade badges join commits by the `Tug-Dash: <name>` trailer `tugdash-core` already appends to squash messages, with rounds count in the badge.

**Rationale:** landing is a session event; its record belongs in the session's stream (user ruling: receipts as ink). The trailer is already on disk — History just learns to read it.

#### [P10] All text entry on the TugTextEditor substrate (DECIDED) {#p10-substrate}

**Decision:** The draft composer is `TugMessageEditor` (which composes `TugTextEditor`); any future text input this plan adds does the same. No browser-native text inputs. This covers **display** as well as editing: the draft message is never rendered as read-only text outside the composer — the composer *is* the display (streamed generation lands in it via `restoreState`; edits happen in place).

**Rationale:** user mandate; the substrate carries the responder registrations (CUT/COPY/PASTE/SELECT_ALL/UNDO/REDO) that native inputs go dead without, and `TugMessageEditor`'s user-edit-only `onChange` is precisely the [P03] signal.

#### [P11] One verb owner; the CLI is the API (DECIDED) {#p11-verb-owner}

**Decision:** Every button and every skill path resolves to a `tugutil` verb or an existing tugcast CONTROL verb backed by the same core: `tugutil draft set|show|clear` (new, writes `changes.changeset_drafts` as a WAL co-writer), `tugutil commit` (exists), `tugutil dash join --preview|--continue` (exists in `tugdash-core::ops`). Raw git remains read-only spelunking by written policy.

**Rationale:** consolidation means one owner per operation; the WAL co-writer contract is already load-bearing across tugcast instances ([D112]).

#### [P12] Drafts-version probe in the aggregate feed (DECIDED) {#p12-drafts-probe}

**Decision:** `ChangesetAllFeed`'s select loop gains a 2 s interval arm probing `MAX(updated_at)` over `changes.changeset_drafts`, firing the existing global bump only when the value moves (see Risk R01).

#### [P13] Bracket hints surface in compose and the shade (DECIDED) {#p13-compose-hints}

**Decision:** `UnattributedFile` (tugcast-core `types.rs` + tugdeck `changeset-types.ts`) gains optional `hinted_by: string[]` — the sessions whose live bracket rows saw the path (compose currently strips these silently in `feeds/changeset.rs`). Zone 1 renders the card session's own hint as `likely this session's (bash)` beside the file (still default-unselected); Zone 2's pool shows others' hints as provenance only.

**Rationale:** parity with the CLI's `likely this session's (bash bracket)` tag — the hint is what makes the disposition decision one glance instead of one investigation.

#### [P14] Release is shade-only, previewed, receipted, and cleans up its draft (DECIDED) {#p14-release}

**Decision:** Releasing a dash never gets a prompt-entry verb — destruction requires walking to the room and looking at the thing. The Zone 2 dash row's **Release** affordance is the only gesture, and it gains a **discard preflight**: when the dash has work on it (commits past base or a dirty tree), confirming expands the row into `discards <k> rounds · <n> dirty files` with the round subjects listed (from the existing dash log/rounds data) before the destructive confirm; a clean dash (nothing past base, no dirt) keeps today's light confirm. Release success (a) appends a release receipt to the transcript (Spec S04 `release` variant), and (b) fires `changeset_draft_set {clear: true}` for `dash:<name>` — join drafts are keyed by reusable dash names, so an uncleaned draft would haunt the *next* dash of the same name as an `edited=1`, clobber-protected message describing destroyed work. Join success clears the dash draft the same way. The nothing-to-join refusal (`ops.rs::join_in`: "Use 'tugdash release <name>'") stops pointing at the terminal: `/join <name>` on an empty dash routes to the shade's dash lane with the release affordance fronted ("nothing to join — release this dash?"), and the CLI message drops the raw-command instruction in favor of naming the release verb generically.

**Rationale:**
- Release is the one irreversible act in the workflow ([P08]'s gates protect *landings*; this protects the *discard*) — the commit/join two-beat doctrine ("beat 1 shows exactly what beat 2 will do") applies with more force, not less, to the gesture that destroys rounds.
- A typed one-liner that discards work would be the asymmetric outlier: `/commit` and `/join` land work into permanence; a `/release` would vaporize it with the same keystroke weight. User ruling: shade-only.
- The draft-cleanup clause closes a hole this plan itself opens — durable machine-global drafts ([P02]) make orphaned `dash:<name>` rows a real hazard that the ephemeral per-instance storage never was.

**Implications:** release joins the [P08] gate doctrine formally (turn-inflight, pending-release phase); Spec S04 grows the `release` variant; `do_changeset_release` and the join-success path both clear the dash draft row; Step 5 builds the preflight, Step 8 the handoff, Step 9 the receipt.

#### [P15] The Z5 Generate button retires (DECIDED) {#p15-z5-generate}

**Decision:** The Z5-shaped "Generate a commit message" button in the prompt row (`tug-prompt-entry.tsx`, shown only while the Changes shade is up) is removed in Step 7, with the `!changes describe` idiom it fronts.

**Rationale:** its job is fully absorbed — `/commit` beat 1 *is* generation (Table T01), and the shade's **Regenerate** button is the explicit in-room path. A second casual generation trigger in chrome is exactly the class of accident [P03]'s edited-pin exists to prevent; leaving it would keep two generation affordances with different confirm semantics.

#### [P16] `tugutil context` renames to `tugutil preflight` (DECIDED) {#p16-preflight-rename}

**Decision:** "context" is AI-reserved vocabulary in Tug — it never names changes/commit machinery. The gathering verb renames `tugutil context` → `tugutil preflight`, through the whole stack: the clap verb (`cli.rs`, `changes.rs::run_context` → `run_preflight`), the core symbols (`tugchanges_core::{context, ContextOptions, ContextReport}` → `{preflight, PreflightOptions, PreflightReport}`), and the `--json` envelope label. `context` remains a **hidden clap alias** for one release — shipped Tug.app bundles carry skill text that says `tugutil context`, and a hard cut would strand them; the alias drops in a follow-on.

**Rationale:** the word already means the AI's working set everywhere else in the suite; overloading it for git gathering misleads. And `preflight` is this plan's own vocabulary — the join preflight and release discard preflight ([P14]) are the same act: the readout you take before a landing. The CLI now says what the workflow says: **Preflight → Draft → Land.**

**Implications:** rename lands in #step-3 (the CLI step) so #step-10's skill rewrite is born saying `tugutil preflight`; the doc sweep (`tuglaws/tracking-changes.md`, `tuglaws/INDEX.md`, `tugplug/skills/history/SKILL.md`; archives untouched) threads into #step-11.

#### [P17] The shade is a presentation style of TugSheet (DECIDED) {#p17-shade-as-sheet}

**Decision:** `TugSheet` gains `presentation="shade"`: full card width, top-anchored, bottom-resizable via the grabber (height fraction persisted through the existing tugbank `SHADE_HEIGHT_DOMAIN`), with TugSheet's modal machinery — scrim, focus trap, `inert` scope, chain-native `cancelDialog` close (Escape / Cmd-.). The standalone `TugShade` component retires; **both** the Changes and History views migrate onto the new presentation (History becomes modal too — read-mostly, modality costs nothing, and one substrate beats two). **Carve-out:** the shade presentation's modal scope covers the **transcript region only** — the prompt entry strip stays **outside** the inert scope, live beneath the sheet's bottom edge. This is a deliberate exception to TugSheet's whole-pane-body-inert contract, unique to this presentation.

**Rationale:** TugShade was designed as an inspection layer ("no scrim, no focus trap, no modality" — its own header) and this plan turns the shade into the room where landings are reviewed and armed; an action surface wants modal scope. Mechanically it's a merge, not an invention: TugSheet already owns pane-modal stacking/scrim/inert/close; TugShade contributes exactly what it lacks (full-width top-anchored geometry, persisted-frac grabber). The carve-out resolves the collision with [P01]/[P04]: beat 2 of `/commit` (and `/join`) is *typed* — an inert prompt entry would kill the landing gesture. Modality over the content, liveness where landings execute (user ruling).

**Implications:** new #step-3a builds the presentation and migrates Changes/History **before** the composer/zone work (#step-4–#step-6 build inside the shade and should build on the final substrate); the State Zone Mapping gains the sheet's height/modality rows; Escape leaves the shade via the chain ([L11]).

---

### Deep Dives {#deep-dives}

#### Existing machinery inventory (what this plan wires, not builds) {#machinery-inventory}

| Piece | Where | State |
|---|---|---|
| Commit execution | `agent_supervisor.rs::do_changeset_commit` → `feeds/changeset.rs::run_changeset_commit` → `tugchanges_core::commit` (explicit `paths`, bypasses refusal); broadcasts `changeset_commit_ok {sha, receipt}` / `changeset_commit_err` | shipped |
| Join execution + preview + AI conflict resolve | `do_changeset_join` / `do_changeset_join_resolve`; `tugdash-core::ops::{join_in, JoinOptions{preview}, JoinStrategy::Squash, merge_tree_conflicts, git_supports_merge_tree}`; join journal + `--continue` | shipped |
| Draft generation | `draft_engine.rs::spawn_on_demand_draft` (headless scribe; `DraftTarget::{Head, Dash}`); persisted `ChangesetDraftRow`; live `changeset_draft_state`/`changeset_draft_delta` CONTROL stream | shipped |
| Deck stores | `changes-route-controller.ts` (binding, snapshot `{entry, dashes, unattributed, project, selectedPaths}`, `entryKey`, `commit()`, `requestDraft()`), `changeset-draft-store.ts` (overlay phases), `changeset-verb-store.ts` (commit round-trip), `changeset-join-store.ts` (+ `useChangesetJoinResolve`) | shipped |
| Composer component | `tug-message-editor.tsx` — borderless CM6 field, `restoreState`/`clear` seams, user-edit-only `onChange`, Cmd-Enter `onSubmit` | shipped; **live reference consumer** in `lens/sections/snippets-section.tsx` (~lines 401–410) |
| Prompt commit path | session-card bang dispatch: `!changes describe` → show shade + `requestDraft()`; `!changes commit <msg>` → four gates → `changesController.commit(message)` | shipped, retiring |
| Jump affordance | `lens/sections/sessions-section.tsx`: `dispatchAction({action: "focus-session-card", cardId: row.cardId})` | shipped |
| Local slash pipeline | `lib/slash-commands.ts` (`LOCAL_SLASH_COMMANDS`, `matchLocalSlashCommand`) → `RUN_SLASH_COMMAND` → session-card card-content responder ([D23]) | shipped |
| Transcript local blocks | `cards/session-command-block-registry.ts` | shipped |

#### The two-beat `/commit` flow, end to end {#commit-flow}

Beat 1 (`/commit`, no ready draft): dispatch opens the shade (`shadeViewController.show("changes")`) and calls `changesController.requestDraft()` → `changeset_draft_request` CONTROL → `spawn_on_demand_draft` streams deltas into the shade's composer (via the draft overlay store feeding `TugMessageEditor.restoreState`, which does **not** set `edited`). The user reads, optionally edits (each user edit debounce-persists via `changeset_draft_set` with `edited=1`), optionally flips dispositions (persisted in the draft's `selection`). Beat 2 (`/commit`): gates ([P08]) → `changesController.commit(draft.message)` → `changeset_commit` CONTROL → `changeset_commit_ok` → verb store resolves → receipt block appended to the transcript ([P09]) → draft cleared → aggregate recompute drops the landed files.

#### Draft storage migration {#draft-migration}

`changeset_drafts` DDL currently lives in `session_ledger.rs` (per-instance `sessions.db`; DDL near the schema block, upsert `upsert_changeset_draft`, readers `get_changeset_draft` / `changeset_drafts_for_project`). The move mirrors the `file_events` precedent exactly: DDL moves to the ATTACHed `changes` schema (`attach_changes` already exists), a `migrate_instance_changeset_drafts_to_changes` copies legacy rows then drops the local table, all DML re-qualifies `changes.changeset_drafts`, and `tugchanges-core`/`tugutil` resolve the same path via `tugcore::instance::changes_db_path()` (honoring `TUG_CHANGES_DB` for test isolation — the CLI test suites and the app-test harness already scrub/point it).

---

### Specification {#specification}

**Spec S01: `changeset_draft_set` CONTROL verb** {#s01-draft-set}

Payload: `{project_dir, owner_kind, owner_id, message?, selection?, edited, clear?}` — partial upsert; `clear: true` deletes the row (post-landing). Handled in `agent_supervisor.rs::handle_control` beside `changeset_draft_request`; writes via the ledger; fires the global changeset bump. The deck composer debounces (300 ms) user edits into it; selection toggles write through immediately.

**Spec S02: `tugutil draft` CLI** {#s02-draft-cli}

`tugutil draft set --project <dir> --owner <session:<id>|dash:<name>|unattributed> --message <m> [--include <p>…] [--exclude <p>…]`, `draft show`, `draft clear` — same row semantics as S01, direct WAL write to `changes.changeset_drafts`, `edited=1` always (a skill-authored draft is an authored draft). Plain output human-readable per the no-CLI-glue doctrine; `--json` envelope for parity.

**Spec S03: Draft row (extended)** {#s03-draft-row}

`ChangesetDraftRow` + `edited: bool` + `selection: Option<String>` (JSON `{"include": [paths], "exclude": [paths]}` deltas against the default rule: session files `!shared` on, unattributed off). Wire: `ChangesetDraft` on the snapshot gains the same fields (additive).

**Spec S05: Draft `project_dir` spelling contract** {#s05-draft-project-dir}

> **Superseded.** Drafts are keyed by the canonical `workspace_key`, not by any spelling of `project_dir`, and the union-on-read below is gone with the raw spelling that required it. See "A draft is addressed by its workspace key" in [tracking-changes.md](../../tuglaws/tracking-changes.md#the-landing-workflow). The text below is kept as the record of what was built.

Writers store `project_dir` **canonical**: tugcast through the `CanonicalPath` gateway (as the draft engine's `EntryKey` already carries), `tugutil draft` via `std::fs::canonicalize` on `--project`. Readers query **canonical with raw union** — exactly the legacy-tolerant pattern compose already uses for `file_events` in `feeds/changeset.rs` (query the canonical spelling; union the raw spelling when it differs). This applies to `changeset_drafts_for_project` (compose), `get_changeset_draft`, and `tugdash-core::ops::dash_draft_message`. Without this contract, a skill-written draft with a differently-spelled path (firmlink/symlink split) silently fails to attach to its entry — the same canonicalization split that bit `file_events` before [P05] of the changesets plan.

**Spec S04: Receipt block** {#s04-receipt-block}

A local transcript block (registered in `session-command-block-registry.ts`) rendering: verb (`commit`/`join`/`release`), short sha, subject line, `N file(s) +A −D`, `left behind: …` when non-empty, and for joins `from dash <name> · <k> rounds`. The `release` variant has no sha: `released dash <name> · discarded <k> rounds, <n> dirty files` (or `clean release` when nothing was lost) per [P14]. Not session context — never sent to Claude.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Draft message text | editor-owned | CM6 document inside `TugMessageEditor` (never React state); mirrored out via update listener | [L02], [L11] |
| Draft overlay (phase, streamed text) | external | existing `changeset-draft-store` + `useSyncExternalStore` | [L02] |
| Persisted draft/selection | server | rides the CHANGESET_ALL snapshot (`entry.draft`); mutations via CONTROL (S01) | [L02] |
| Zone 2 collapsed/expanded | local UI | `useState` in the view (per-card, non-durable by design) | [L19] |
| Landing phases (commit/join round-trips) | external | existing `changeset-verb-store` / `changeset-join-store` | [L02] |
| Receipt block presence | external | session command block registry entries | [L02] |
| Composer focus/responders | responder chain | `TugTextEditor`'s own registrations | [L11], [L03] |
| Shade height fraction | server (tugbank) | sheet `shade` presentation grabber → `SHADE_HEIGHT_DOMAIN`; drag via custom property, no per-move re-render | [L02], [L06] |
| Shade open/close + modality | external + chain | `shadeViewController` drives the sheet; `cancelDialog` chain close; inert scope excludes the prompt entry ([P17]) | [L02], [L11] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugutil/src/draft.rs` | `tugutil draft set/show/clear` (Spec S02) |
| `tugplug/skills/draft/SKILL.md` | renamed drafting skill ([P07]) — replaces `tugplug/skills/commit/SKILL.md` |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `ChangesetDraftRow.{edited, selection}` | fields | `tugcast/src/session_ledger.rs` | Spec S03; DDL moves to `changes.` schema |
| `migrate_instance_changeset_drafts_to_changes` | fn | `tugcast/src/session_ledger.rs` | mirrors the `file_events` migration |
| `parse_changeset_draft_set_payload` / `do_changeset_draft_set` | fn | `tugcast/src/feeds/agent_supervisor.rs` | Spec S01; `edited` gate per [P03] |
| drafts-version probe arm | select arm | `tugcast/src/feeds/changeset_all.rs` | [P12], Risk R01 |
| `UnattributedFile.hinted_by` | field | `tugcast-core/src/types.rs`, `tugdeck/src/lib/changeset-types.ts` | [P13]; populated in `feeds/changeset.rs` compose |
| `commit`, `join` entries | data | `tugdeck/src/lib/slash-commands.ts` | [P04]/[P05], `takesArgs: true` |
| `/commit`, `/join` dispatch handlers | fn | `tugdeck/src/components/tugways/cards/session-card.tsx` | Table T01; gates [P08]; replaces `!changes commit/describe` sub-verbs |
| Zone 1 composer mount | component | `session-changes/session-changes-view.tsx` | `TugMessageEditor` ([P10]), regenerate confirm ([P03]) |
| `AlsoOnProjectLine` (+ expansion) | component | `session-changes/session-changes-view.tsx` | [P06]; jump via `dispatchAction` |
| receipt block renderer | component | `cards/session-command-block-registry.ts` (+ block component) | Spec S04 |
| join badge | render | `session-history/session-history-view.tsx` | `Tug-Dash:` trailer parse ([P09]) |
| `draft` verbs | CLI | `tugutil/src/cli.rs`, `tugutil/src/draft.rs` | Spec S02, Spec S05 (canonical `--project`) |
| `preflight` verb (rename) | CLI + core | `tugutil/src/cli.rs`, `tugutil/src/changes.rs`, `tugchanges-core` | [P16]; hidden `context` alias, one release |
| `presentation="shade"` | prop + styles | `tugways/tug-sheet.tsx`, `tug-sheet.css` | [P17]; ports TugShade grabber + persistence; `tug-shade.tsx`/`.css` deleted |
| `dash_draft_message` | fn (modify) | `tugdash-core/src/ops.rs` | repoint to `changes.changeset_drafts` via `changes_db_path()`; Spec S05 read |
| local-name collision filter | fn | `tugdeck/src/lib/session-metadata-store.ts` (or the popup merge site) | suppresses Claude-advertised commands shadowed by `LOCAL_SLASH_COMMANDS` |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/tracking-changes.md`: add "The landing workflow" section (lifecycle, draft doctrine, gates, receipts) — the workflow layer over the existing soundness axioms.
- [ ] `tuglaws/design-decisions.md`: one new global decision recording the lifecycle/verb consolidation (cites [D112]/[D113]).
- [ ] `tugplug/CLAUDE.md` skill roster: `commit` → `draft`; `implement` ending change.
- [ ] Repo `CLAUDE.md` git-policy exception list update (draft skill never commits; `/commit`+`/join` are the user's landing gestures).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | draft row round-trip, `edited` gate, migration, probe, compose hints | steps 1–3, 6 |
| **Unit (bun)** | slash matcher shadowing, Table T01 state logic, zone summarizer, selection-persistence mapping | steps 4–5, 7–8 |
| **Integration (Rust)** | `tugutil draft` CLI round-trip; supervisor verb handling; join preview/execute against a real repo fixture | steps 2–3, 8 |
| **Golden/Contract** | snapshot fixtures gain `draft.edited/selection`, `hinted_by` (additive) | steps 1, 6 |
| **App-test** | shade zone rendering, `/commit` beat-1 opens shade, receipt block presence | step 12 (within the harness's transient-workspace limits) |

#### What stays out of tests {#test-non-goals}

- Long real-scribe draft-generation flows in app-tests — changeset entries live ~2 s in the replay-session workspace; covered at the Rust round-trip layer instead (established harness limitation).
- Fake-DOM/RTL render tests and mock-store assertions — banned project-wide; view behavior is covered by app-tests on the real app.
- Editor-leaf ⌘-chord dispatch in headless app-tests (chain-leaf first-responder limitation) — composer editing semantics are `TugTextEditor` substrate contracts already covered by its own suites.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Applies to every step.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Draft rows: machine-global, edited, selection | done | 45ae095d1 |
| #step-2 | `changeset_draft_set` verb + edited gate | done | 3463eda82 |
| #step-3 | `tugutil draft` CLI + aggregate probe + preflight rename | done | 785248d60 |
| #step-3a | TugSheet shade presentation; retire TugShade | done | 3bc3f16e3 |
| #step-4 | Zone 1 composer (TugMessageEditor) | done | 12b717b7a |
| #step-5 | Zone split + Also-line + jump links | done | 75399bde6 |
| #step-6 | Bracket hints through compose to the shade | done | c3bbd2ff7 |
| #step-7 | `/commit` double-duty verb; retire `!changes` sub-verbs | done | e89e66d18 |
| #step-8 | `/join` verb over preview/execute | done | 7510a3427 |
| #step-9 | Receipt ink + History join badges | done | ace163f5c |
| #step-10 | Skill rename commit→draft; implement ending | done | a41d0f0e9 |
| #step-11 | Laws + docs | done | 03995e940 |
| #step-12 | Integration checkpoint | done | — (verification only; manual walkthroughs in the vetting phase) |

#### Step 1: Draft rows — machine-global, edited, selection {#step-1}

**Commit:** `Move changeset drafts to changes.db; add edited + selection`

**References:** [P02], Spec S03, Spec S05, (#draft-migration, #machinery-inventory)

**Artifacts:** `changes.changeset_drafts` DDL + migration; extended `ChangesetDraftRow`; wire `ChangesetDraft` fields; repointed `dash_draft_message`; fixture updates.

**Tasks:**
- [ ] In `tugcast/src/session_ledger.rs`: move the `changeset_drafts` DDL into the ATTACHed `changes` schema; add `edited INTEGER NOT NULL DEFAULT 0`, `selection TEXT`; re-qualify `upsert_changeset_draft` / `get_changeset_draft` / `changeset_drafts_for_project` DML.
- [ ] Add `migrate_instance_changeset_drafts_to_changes` on open, modeled on the `file_events` migration in the same file.
- [ ] **Repoint `tugdash-core/src/ops.rs::dash_draft_message`** — it reads `changeset_drafts` by raw SQL directly from the per-instance `sessions.db` path today ("read-only from `sessions.db`" per its doc) and would silently fall back to the dash description after the move, losing every join's draft message. Point it at `changes.changeset_drafts` via `tugcore::instance::changes_db_path()` (honoring `TUG_CHANGES_DB`), reading per Spec S05.
- [ ] Apply the Spec S05 spelling contract to all draft readers (`changeset_drafts_for_project` in compose, `get_changeset_draft`, `dash_draft_message`): canonical query, raw-spelling union when it differs.
- [ ] Extend `tugcast-core/src/types.rs::ChangesetDraft` and `tugdeck/src/lib/changeset-types.ts` (+ guard) additively; update golden snapshot fixtures.

**Tests:**
- [ ] Rust: legacy per-instance drafts migrate in and the local table drops; round-trip preserves `edited`/`selection`.
- [ ] Rust (tugdash-core): a join whose dash has a migrated draft in `changes.changeset_drafts` uses the draft as its squash message — pins the `dash_draft_message` repoint.
- [ ] bun: type guard accepts old and new draft shapes.

**Checkpoint:**
- [ ] `cargo nextest run -p tugcast` green; `bun test` green.

---

#### Step 2: `changeset_draft_set` verb + edited gate {#step-2}

**Depends on:** #step-1

**Commit:** `Add changeset_draft_set control verb; edited drafts never clobbered`

**References:** [P03], Spec S01, (#commit-flow)

**Tasks:**
- [ ] In `agent_supervisor.rs`: add `parse_changeset_draft_set_payload` + `do_changeset_draft_set` beside the existing draft-request pair; partial upsert; `clear` deletes; fire the global bump.
- [ ] Gate `do_changeset_draft_request` / `draft_engine::spawn_on_demand_draft` on `edited==0` unless the request carries `force: true` ([P03]).
- [ ] Release/join draft cleanup ([P14]): `do_changeset_release` success and `do_changeset_join` success both delete the `dash:<name>` draft row (same ledger path as `clear`), so reused dash names never inherit a dead dash's clobber-protected join draft.

**Tests:**
- [ ] Rust: set→snapshot round-trip; an edited draft survives a non-forced request untouched; `force` regenerates and resets `edited`.
- [ ] Rust: releasing (and joining) a dash with a persisted `dash:<name>` draft deletes the row; a subsequent draft lookup for a same-named dash comes up empty ([P14]).

**Checkpoint:**
- [ ] `cargo nextest run -p tugcast` green.

---

#### Step 3: `tugutil draft` CLI + aggregate probe + preflight rename {#step-3}

**Depends on:** #step-1

**Commit:** `tugutil draft set/show/clear; drafts probe; context renames to preflight`

**References:** [P11], [P12], [P16], Spec S02, Spec S05, Risk R01, (#r01-aggregate-poll)

**Tasks:**
- [ ] New `tugutil/src/draft.rs` + `cli.rs` wiring per Spec S02; WAL write to `changes.changeset_drafts` via `tugcore::instance::changes_db_path()`; `--project` canonicalized on write per Spec S05; plain + `--json` output.
- [ ] Add the 2 s `MAX(updated_at)` probe arm to `ChangesetAllFeed`'s select loop in `changeset_all.rs`; bump only on change; update the module-header doctrine comment.
- [ ] Preflight rename ([P16]): clap verb `context` → `preflight` with hidden `context` alias; `changes.rs::run_context` → `run_preflight`; `tugchanges_core::{context, ContextOptions, ContextReport}` → `{preflight, PreflightOptions, PreflightReport}`; `--json` envelope label; `cli.rs` long_about wording.

**Tests:**
- [ ] Rust integration (`tugutil/tests/`): `draft set` → `draft show` round-trip under `TUG_CHANGES_DB` isolation; include/exclude serialization.
- [ ] Rust integration (cross-process spelling, Spec S05): `tugutil draft set` with a symlinked/raw `--project` spelling → tugcast-side compose (`compose_snapshot` with the same `TUG_CHANGES_DB`) finds and attaches the draft to the entry.
- [ ] Rust: probe fires the bump exactly once per external write.
- [ ] Rust integration: `tugutil preflight` produces the readout; `tugutil context` (hidden alias) still resolves.

**Checkpoint:**
- [ ] `cargo nextest run` green.

---

#### Step 3A: TugSheet shade presentation; retire TugShade {#step-3a}

**Depends on:** #step-1

**Commit:** `Shade becomes a TugSheet presentation; TugShade retires`

**References:** [P17], (#p17-shade-as-sheet, #state-zone-mapping)

**Artifacts:** `presentation="shade"` on `TugSheetContent`; migrated Changes + History mounts in `session-card.tsx`; deleted `tug-shade.tsx`/`tug-shade.css`.

**Tasks:**
- [ ] Add the `shade` presentation to `tug-sheet.tsx`/`tug-sheet.css`: full pane width, top-anchored, bottom grabber porting TugShade's drag mechanics and tugbank persistence (`SHADE_HEIGHT_DOMAIN`, `persistKey`, `--tug-shade-frac`-style custom-property drag — no React state per pointer move, [L06]).
- [ ] Modal scope per [P17]: scrim + `inert` + focus trap cover the **transcript region only**; the prompt entry strip stays outside the inert scope and live. Escape / Cmd-. leave via the chain-native `cancelDialog` path ([L11]).
- [ ] Migrate the Changes and History mounts in `session-card.tsx` (`shadeViewController` show/hide/toggle drives sheet open/close); delete `tug-shade.tsx` + `tug-shade.css`.

**Tests:**
- [ ] bun: height-fraction persistence round-trip through the sheet presentation (same `persistKey` semantics as before).

**Checkpoint:**
- [ ] `bun test` + `bunx vite build` green; manual: shade opens modal over the transcript, transcript inert, prompt entry types, grabber resizes and persists, Escape closes; Maker ▸ Reload clean.

---

#### Step 4: Zone 1 composer {#step-4}

**Depends on:** #step-2, #step-3a

**Commit:** `Mount the draft composer in the Changes shade`

**References:** [P02], [P03], [P10], Spec S01, (#commit-flow, #state-zone-mapping)

**Tasks:**
- [ ] Mount `TugMessageEditor` in `session-changes-view.tsx` Zone-1 position, seeded via `restoreState` from `entry.draft.message` + the draft overlay stream (existing `changeset-draft-store` phases).
- [ ] Debounce (300 ms) user edits into `changeset_draft_set` (`edited: 1`) through a small addition to `changeset-draft-store.ts`; selection checkbox toggles persist into `selection` immediately via `changes-route-controller.ts` (which also seeds its override map from the persisted `selection` on snapshot).
- [ ] **Regenerate** button (replacing the current Generate semantics) with `TugConfirmPopover` when `edited==1`; sends `force: true`.
- [ ] Fingerprint-drift marker ("changes moved since this draft") when `entry.draft.fingerprint` no longer matches (comparison value already computed engine-side; surface a boolean on the wire draft if needed — additive).

**Tests:**
- [ ] bun: controller maps persisted `selection` ⇄ override map both directions; drift boolean plumbs through.

**Checkpoint:**
- [ ] `bun test` green; `bunx vite build` green; manual: type in composer, Maker ▸ Reload, text survives.

---

#### Step 5: Zone split + Also-line + jump links {#step-5}

**Depends on:** #step-4

**Commit:** `Split the Changes shade: This session / Also on this project`

**References:** [P06], [Q02], (#p06-zones, #machinery-inventory)

**Tasks:**
- [ ] Restructure `session-changes-view.tsx` into the two zones; Zone 2 collapsed one-line summary (pure summarizer over `dashes` + `unattributed` + other-session entries), `useState` expansion. **Zone 2's session rows come from `snapshot.project.changesets`** — `ChangesRouteSnapshot.project` is a `ProjectChangeset extends ChangesetSnapshot` carrying every entry; filter out the card's own `owner_id`. No controller/store change is needed.
- [ ] Expanded session rows: display name + `focus-session-card` jump (port the exported `buildSessionRows(bindings)` helper from `lens/sections/sessions-data-source.ts` — it walks a `bindings: ReadonlyMap<cardId, CardSessionBinding{tugSessionId, projectDir}>` sourced from `cardSessionBindingStore` (`@/lib/card-session-binding-store`, subscribe/getSnapshot, as the Lens's `useOpenBindings()` does); map Zone 2 owner ids through the same binding source; unlinked when no open card resolves, per [Q02]).
- [ ] Dash rows: name · base · rounds · dirty, with the existing `DashActions` (Join/Release/resolve) relocated under this zone in dash grammar (no per-file checkboxes on dash files).
- [ ] Release discard preflight ([P14]): when the dash has commits past base or a dirty tree, the Release confirm expands into `discards <k> rounds · <n> dirty files` with round subjects listed before the destructive confirm; a clean dash keeps the light confirm. Release stays gated on turn-inflight and pending-release phase ([P08] doctrine).
- [ ] CSS: distinct section grammar for Zone 2 (`session-changes-view.css`).

**Tests:**
- [ ] bun: summarizer string cases (0/1/n sessions, dashes, dirty flags).
- [ ] bun: release-preflight selector — clean dash → light confirm, rounds/dirt → preflight with counts ([P14]).

**Checkpoint:**
- [ ] `bun test` + `bunx vite build` green; manual: snippets-style dash renders collapsed, expands, jump-link fronts the owning card.

---

#### Step 6: Bracket hints through compose to the shade {#step-6}

**Depends on:** #step-5

**Commit:** `Carry bracket hints into the changeset snapshot and shade`

**References:** [P13], (#p13-compose-hints)

**Tasks:**
- [ ] In `feeds/changeset.rs` compose: when stripping correlation-only holders, record them into `UnattributedFile.hinted_by` instead of dropping silently.
- [ ] `tugcast-core/types.rs` + `changeset-types.ts` + guards + fixtures (additive field).
- [ ] Zone 1 renders the card session's own hint inline (`likely this session's (bash)`, default-unselected); Zone 2 pool shows foreign hints as provenance text.

**Tests:**
- [ ] Rust: compose emits `hinted_by` for a bracket-only path; exact-owned paths emit none.

**Checkpoint:**
- [ ] `cargo nextest run -p tugcast` + `bun test` + `bunx vite build` green.

---

#### Step 7: `/commit` double-duty verb; retire `!changes` sub-verbs {#step-7}

**Depends on:** #step-4

**Commit:** `Native /commit verb: draft on first beat, land on second`

**References:** [P01], [P04], [P08], Table T01, (#commit-flow, #t01-commit-semantics)

**Tasks:**
- [ ] Add `commit` (`takesArgs: true`) to `LOCAL_SLASH_COMMANDS` in `lib/slash-commands.ts`.
- [ ] Implement the Table T01 dispatch in `session-card.tsx`'s local-command handling, reusing the four gates and `changesController.commit(...)` verbatim from the current `!changes commit` branch; ready-draft = overlay phase `ready` or persisted non-empty `entry.draft.message`.
- [ ] On successful landing, `changeset_draft_set {clear: true}` for the entry key.
- [ ] Reduce the `!changes` bang handler to the bare routing (show shade); delete the `describe`/`commit` sub-verbs and their usage strings.
- [ ] Remove the Z5 "Generate a commit message" button from `tug-prompt-entry.tsx` (and its shade-visibility gating props/CSS) — generation is `/commit` beat 1 and the shade's Regenerate ([P15]).
- [ ] **Suppress popup duplicates:** the slash completion popup merges Claude's advertised commands (`session-metadata-store.ts`, `slash_commands ∪ skills ∪ agents` — which includes the built-in `commit`) alongside the `completion-providers/local-commands.ts` provider. Add a general suppression — filter any metadata-derived entry whose name collides with a `LOCAL_SLASH_COMMANDS` name (not a `commit` special case) — so exactly one `/commit` appears, described as Tug's landing verb.
- [ ] Verify the [D14] allowlist path picks up the new local command.

**Tests:**
- [ ] bun: matcher — `/commit`, `/commit now`, `/commit <msg>` all match locally and never fall through to send; Table T01 branch logic as a pure function.
- [ ] bun: metadata-store merge drops entries colliding with local slash names (`commit` disappears from the Claude-derived list; a non-colliding skill survives).

**Checkpoint:**
- [ ] `bun test` + `bunx vite build` green; manual two-beat walkthrough per (#commit-flow).

---

#### Step 8: `/join` verb over preview/execute {#step-8}

**Depends on:** #step-5, #step-7

**Commit:** `Native /join verb: preview, then squash-land the dash`

**References:** [P05], [P08], (#p05-join-verb, #machinery-inventory)

**Tasks:**
- [ ] Add `join` (`takesArgs: true`) to `LOCAL_SLASH_COMMANDS`; dispatch in `session-card.tsx`: bare → shade dash lane (single dash: also fire preview); `/join <name>` → preview via `changeset-join-store` → clean + join-draft-ready → execute (`JoinStrategy::Squash`, message = dash draft) → conflicts → shade resolve flow.
- [ ] Ensure `do_changeset_join` uses the dash's draft message when present (confirm existing behavior — `ops.rs::join_in` documents "squash/merge message is the maintained dash draft, else the description"; wire the payload if the verb path doesn't already).
- [ ] Join gates per [P08] (turn-inflight, pending-join).
- [ ] Empty-dash handoff ([P14]): `/join <name>` on a dash with nothing past base routes to the shade's dash lane with the release affordance fronted ("nothing to join — release this dash?") instead of surfacing the refusal text; reword the `ops.rs::join_in` nothing-to-join message to drop the raw `tugdash release` terminal instruction.

**Tests:**
- [ ] bun: `/join` matcher + dispatch branch logic.
- [ ] Rust integration: `join_in` with `preview` then execute against a fixture repo lands squash with the draft message and the `Tug-Dash` trailer.

**Checkpoint:**
- [ ] `cargo nextest run` + `bun test` + `bunx vite build` green.

---

#### Step 9: Receipt ink + History join badges {#step-9}

**Depends on:** #step-7, #step-8

**Commit:** `Landing receipts as transcript ink; History badges joins`

**References:** [P09], Spec S04, (#s04-receipt-block)

**Tasks:**
- [ ] Receipt block per Spec S04 registered in `session-command-block-registry.ts`; appended on `changeset_commit_ok` / join success / release success by the session card's verb-store subscriptions; non-context (never sent to Claude); release variant per [P14].
- [ ] `session-history-view.tsx`: parse the `Tug-Dash: <name>` trailer from commit messages already in the history data; render the join badge (`from dash <name>`).

**Tests:**
- [ ] bun: trailer parser cases; receipt block formatting from a receipt payload.

**Checkpoint:**
- [ ] `bun test` + `bunx vite build` green; manual: land a commit, see the ink; a joined dash shows its badge in History.

---

#### Step 10: Skill rename commit→draft; implement ending {#step-10}

**Depends on:** #step-3, #step-7, #step-8

**Commit:** `tugplug: commit skill becomes draft; implement hands off to /join`

**References:** [P07], [P11], Spec S02, (#p07-skills-draft)

**Tasks:**
- [ ] Move `tugplug/skills/commit/` → `tugplug/skills/draft/`; rewrite SKILL.md: gather (`tugutil preflight`, plain, no glue — [P16] name from birth), decide dispositions (hint doctrine), author message, `tugutil draft set --owner session:$TUG_SESSION_ID …`, report selections + rationale; never commit; explicit note that `/commit` is the user's landing gesture.
- [ ] `tugplug/skills/implement/SKILL.md` ending: write the join draft (`tugutil draft set --owner dash:<name>` with a rounds digest) and point the user at `/join <name>`; drop the terminal-join instruction.
- [ ] `tugplug/CLAUDE.md` roster + repo `CLAUDE.md` git-policy exception list updates.

**Tests:**
- [ ] Manual skill invocation: `/tugplug:draft` produces a draft visible in the shade within the probe window ([P12]).

**Checkpoint:**
- [ ] Skill runs clean end-to-end in a live session; no commit is made by it.

---

#### Step 11: Laws + docs {#step-11}

**Depends on:** #step-9, #step-10

**Commit:** `Laws: the landing workflow (Gather → Draft → Land)`

**References:** [P01]–[P13], (#documentation-plan)

**Tasks:**
- [ ] `tuglaws/tracking-changes.md`: "The landing workflow" section — lifecycle, draft doctrine ([P02]/[P03]), gates ([P08]), receipts ([P09]), verb ownership ([P11]), git-is-read-only policy.
- [ ] `tuglaws/design-decisions.md`: new global decision for the consolidation.
- [ ] Preflight rename doc sweep ([P16]): `tuglaws/tracking-changes.md`, `tuglaws/INDEX.md`, `tugplug/skills/history/SKILL.md` say `tugutil preflight`; roadmap archives untouched.

**Checkpoint:**
- [ ] Docs cross-references resolve (anchors, [D##] cites); no hard-wrapped prose.

---

#### Step 12: Integration checkpoint {#step-12}

**Depends on:** #step-6, #step-9, #step-10, #step-11

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), Table T01

**Tasks:**
- [ ] Walk both success-criteria landings end-to-end in the real app (main-lane two-beat; dash-lane `/join`).
- [ ] Verify draft durability across restart + Maker ▸ Reload; verify edited-draft protection against Regenerate-without-confirm.

**Tests:**
- [ ] App-test additions where the harness allows (shade zones render; `/commit` beat-1 opens the shade; receipt block appears) — respecting the transient-workspace limits in (#test-non-goals).

**Checkpoint:**
- [ ] `cargo nextest run` green · `bun test` green · `bunx vite build` green · `just app-test` green.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** One opinionated landing workflow in Tug — durable editable drafts in a two-zone Changes shade, native `/commit` and `/join` landing gestures with receipts in the transcript, skills that draft instead of commit, and no remaining reason to touch terminal git, bbedit, or raw `tugutil dash join`.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Both success-criteria walkthroughs pass with zero terminal use (manual, on the release build).
- [ ] `/commit` is fully local; `tugplug:draft` exists and never commits; `!changes commit` is gone.
- [ ] Drafts are machine-global, survive restart/reload, and edited drafts are clobber-proof (tests green).
- [ ] Zone 2 collapses to one line and jump-links to owner sessions.
- [ ] Releasing a dash with work shows the discard preflight, leaves a receipt, and clears its join draft; the Z5 Generate button is gone ([P14]/[P15]).
- [ ] `tugutil preflight` is the gathering verb everywhere (skills, laws, help text); `context` survives only as the hidden alias ([P16]).
- [ ] The shade is a `TugSheet` presentation: modal over the transcript, prompt entry live beneath it, `TugShade` deleted ([P17]).
- [ ] Landing affordances render disabled while the session is non-idle; drafting stays live mid-turn ([P08]).
- [ ] Full suite green: `cargo nextest run`, `bun test`, `bunx vite build`, `just app-test`.

**Acceptance tests:** the Step 3/8 Rust integration tests and Step 7 matcher tests are the anchors.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Unattributed-pool adoption gesture ([Q01]).
- [ ] Background draft maintenance ([Q03]).
- [ ] Resume affordance on unlinked Zone 2 session rows ([Q02] residue).
- [ ] Dash-lane rounds browser (History-grade list per dash) beyond the summary row.

| Checkpoint | Verification |
|------------|--------------|
| Rust suite | `cd tugrust && cargo nextest run` |
| Deck suite + bundle | `bun test` · `bunx vite build` |
| Real app | `just app-test` + the two manual walkthroughs |
