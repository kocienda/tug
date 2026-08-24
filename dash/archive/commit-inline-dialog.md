<!-- devise-skeleton v4 -->

## Commit Inline Dialog {#commit-inline-dialog}

**Purpose:** Replace the confusing commit-in-the-shade scheme with three clean pieces: a reusable read-only `TugChangesList` component, a greatly simplified read-only Changes shade, and a new `TugCommitDialog` inline dialog in the transcript that owns message authoring (with a streamed Auto-Message affordance) and landing — leaving behind a durable, restorable commit record in the transcript.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-20 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The changes/commit/dash consolidation that landed on `c12e84fe47` (session `pretty-earth/294d2086`) put viewing, commit-message authoring, landing, and dash join/release all inside one Changes shade, with `/commit` split across two beats that route through the shade as a side effect. It remains confusing — the third or fourth attempt at this surface that hasn't stuck. The root cause is that the shade is three things at once: a viewer, an editor, and a landing surface.

This plan separates them. The shade answers "what's changed?" — glanceable, read-only, dismiss-and-forget. The transcript hosts "commit this" — an intentional act, presented as an inline dialog modeled on the existing `PermissionDialog`/`QuestionDialog`, leaving a durable record where the session's narrative already lives. The full originating prompt is preserved in [Originating Prompt](#originating-prompt); the follow-up discussion settled three open points, recorded in [P10], [P11], and [P02].

#### Strategy {#strategy}

- Extract the file-rows-with-diffs guts of `session-changes-view.tsx` into a reusable `TugChangesList` component first — both the simplified shade and the new dialog compose it.
- Simplify the shade to a read-only modal presentation (Done button, Return/Escape dismiss) by deletion, not redesign: the composer, receipt, dash actions, and Zone 2 all leave.
- Build `TugCommitDialog` on the proven inline-dialog stack (`TugInlineDialog` + `useFocusTrap` + `useInlineDialogScope` + `useSpatialOrder` + foot-height reservation), driven by a per-card controller since it is user-initiated rather than turn-driven.
- Keep the commit message flowing through the existing changeset draft store (debounced persist, `edited` pin, streamed generation via `restoreState`) — the machinery is good; only its housing was wrong.
- Make the post-commit record durable by writing it into the existing `shell_ledger` at commit time server-side, with the server as the single formatter — restore comes free via the `list_shell_exchanges` path.
- Sequence server work (durable record) independently of frontend work (extraction, shade, dialog) so the steps can interleave.

#### Success Criteria (Measurable) {#success-criteria}

- Typing `/commit` (or choosing Session ▸ Commit…) opens `TugCommitDialog` inline in the transcript with the message editor focused; Escape cancels; Cmd-Return with a non-empty message lands the commit. (Manual drive + app-test open/dismiss.)
- Auto-Message streams the generated draft into the editor with the Bot avatar + wave indicator visible while drafting; the editor is non-editable during the stream and editable after. (Manual drive.)
- After a commit, the transcript shows the standard commit summary row, and the same row reappears after Maker ▸ Reload and after a cold app relaunch. (Manual drive; Rust test on the ledger write.)
- The `±` Changes shade is read-only: no Commit button, no message editor, no dash actions; Done (double-ring), Return, and Escape all dismiss it. (Manual drive.)
- `cd tugrust && cargo nextest run`, `cd tugdeck && bun test`, and `bunx vite build` all pass at every step boundary.

#### Scope {#scope}

1. `TugChangesList` — new reusable tugways component extracted from `session-changes-view.tsx`.
2. Read-only simplification of the Changes shade (and removal of the dash lane / Zone 2 from it).
3. `TugCommitDialog` + `CommitDialogController`, `/commit` rewiring, Session ▸ Commit… menu item.
4. Auto-Message streaming affordance (Bot avatar + wave) in the dialog.
5. Durable post-commit record: server-side ledger write + server-formatted summary + bespoke commit-receipt command-block renderer.

#### Non-goals (Explicitly out of scope) {#non-goals}

- `TugJoinDialog` — explicitly deferred; `/join` degrades to a caution bulletin for the interim ([P10]).
- Join/release receipts and any dash UI relocation — the verb-store and tugcast join/release machinery stays intact but unreferenced by UI.
- Per-file commit election — the session commits its full attributed set (unchanged since `749172c01`).
- Changes to the scribe/draft engine prompt or model — Auto-Message reuses the existing generation path unchanged.
- The Lens Sessions section — its original file rows stay live until the Lens is slimmed (separate effort).

#### Dependencies / Prerequisites {#dependencies}

- Commit `c12e84fe47` (changes-landing consolidation) is on `main` — this plan modifies the surfaces it created.
- tugdeck HMR is live for iteration; tugcast must be rebuilt (`just build`) for the Rust steps; Tug.app rebuild for the Swift step (building the app is cheap).

#### Constraints {#constraints}

- Tuglaws apply throughout: [L01] one render, [L02] external state via `useSyncExternalStore`, [L03] `useLayoutEffect` registrations, [L06] appearance via CSS/DOM, [L11] responder-chain editing actions, [L24] state zoning, [L26] collapse-by-unmount. Cross-check `tuglaws/tuglaws.md`, `tuglaws/pane-model.md`, `tuglaws/component-authoring.md` before each tugdeck step and name the laws touched in the commit.
- Rust workspace enforces `-D warnings`; warnings are errors.
- Never hand-roll UI that exists as a Tug* component — compose `TugInlineDialog`, `TugMessageEditor`, `TugPushButton`, `TugProgressIndicator`, `TugConfirmPopover`, `TugChangesList`.
- No localStorage/IndexedDB; persistent state rides tugbank or tugcast ledgers.
- No jsdom render tests or mock-store assertion tests; pure-helper `bun test` + Rust round-trip tests + real app drives only.
- `bunx vite build` must pass before any tugdeck step is declared done (dev esbuild can mask rollup failures).

#### Assumptions {#assumptions}

- The `changeset_commit` CONTROL round-trip and the scribe draft streaming path (`changeset_draft_request` → `changeset_draft_delta`/`changeset_draft_state`) keep their current wire shapes except for the additive `summary` field ([S02]).
- One live deck per tugcast (the existing single-user model): the client that initiated the commit is the client that appends the live ink row; other decks pick the row up on their next restore.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise skeleton's anchor and label conventions: explicit `{#anchor}` on every cited heading, `[P##]` plan-local decisions, `[Q##]` questions, `S##` specs, `T##` tables, `R##` risks, `#step-N` execution anchors, `**Depends on:**`/`**References:**` lines on every step, and no line-number citations.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] How does Auto-Message integrate with the text editor? (DECIDED) {#q01-auto-message-integration}

**Question:** When the user asks for an Auto-Message, where does the streamed text render — a separate mini-transcript zone, or the editor itself?

**Why it matters:** A separate streaming zone that then teleports its text into the editor reads as a visual double-take; streaming into an editable field risks interleaving user keystrokes with deltas.

**Resolution:** DECIDED (see [P06]) — stream into the `TugMessageEditor` itself via the existing programmatic `restoreState` seam, with the editor `disabled` (read-only) for the duration and a Bot-avatar + wave status row borrowed from the `/btw` grammar.

#### [Q02] Where exactly does the dialog mount in the transcript? (DECIDED) {#q02-dialog-mount}

**Question:** `PermissionDialog` hangs off the last assistant cell's foot slot, keyed by a turn-driven `pendingApproval`. `/commit` is user-driven with no pending request — what hosts the dialog?

**Why it matters:** Bolting a user-driven dialog onto turn-driven reducer state would contort `CodeSessionStore`; mounting outside the scroller would break the "resides in the transcript" requirement.

**Resolution:** DECIDED (see [P03]) — a dedicated slot at the tail of the transcript scroller (after the last entry, inside the scrolling content), driven by a per-card `CommitDialogController` store. It scrolls with the transcript, is revealed on open, and reserves its height on close via the existing foot-reservation pattern.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Live-edge dialog vs. streaming turn scroll fights | med | med | SmartScroll release before reveal (the QuestionWizard pattern); foot reservation on dismiss | visible jumpiness while a turn streams under the open dialog |
| Summary format drift between server and client | med | low | server is the single formatter; client ingests the `summary` string verbatim ([P07], S02) | any second formatter appears |
| Draft-store echo eats mid-stream or mid-edit text | med | low | reuse the `DraftComposer` doc/lastSeeded ref discipline verbatim (documented in [#draft-sync-discipline]) | lost keystrokes or doubled text in the dialog editor |

**Risk R01: Dialog at the live edge during a streaming turn** {#r01-live-edge}

- **Risk:** With allow-open mid-turn ([P11]), transcript rows keep appending beneath an open, focus-trapped dialog; scroll anchoring could yank the dialog out of view or fight the user's reading position.
- **Mitigation:** The dialog slot renders after the last entry so appended rows push it down with the live edge; on open, release follow-bottom via `useScroller()` before the reveal scroll (the exact `QuestionWizard` move in `chrome/session-question-dialog.tsx`); reveal scrolls must clear the stuck `.tool-call-header` bottom (the sticky-header gotcha).
- **Residual risk:** Long streams make the dialog drift down; acceptable — the user opened it deliberately and the trap keeps keyboard focus inside it.

**Risk R02: `session_id` absent on the commit payload** {#r02-session-id-absent}

- **Risk:** `ChangesetCommitPayload.session_id` is `Option`; without it the server cannot key the ledger row and the commit leaves no durable record.
- **Mitigation:** The deck always passes `{name, id}` from the Session card today; the server skips the ledger write (with a `warn!`) only when `session_id` is `None`. The live client-side ink still appears either way.
- **Residual risk:** A hypothetical non-deck caller gets an ephemeral-only receipt. Fine.

---

### Design Decisions {#design-decisions}

#### [P01] TugChangesList is file rows with diffs, period (DECIDED) {#p01-changes-list-scope}

**Decision:** Extract the file-row/diff cluster of `session-changes-view.tsx` into a new `tugdeck/src/components/tugways/tug-changes-list.tsx` (+`.css`) component: the `ChangesItem` model (`session`/`unattributed` entries), `statusToneClass`/`StatusIcon`, `FilePathLink` (open/reveal context menu), `ChangesFileBlock` (`BlockChrome` + inline `DiffBlock` + `+N −M` badges + pop-out), `ChangesEntryFiles`, and the `useEntryDiff` sourcing from `changeset-diff-store`. No dash entries, no dash actions, no Zone 2, no checkboxes, no commit affordances.

**Rationale:**
- Both the read-only shade and `TugCommitDialog` need exactly this cluster and nothing more.
- Dash rendering and actions are lane machinery that dies with the shade simplification ([P02], [P10]).

**Implications:**
- Collapse state is controlled (`expandedKeys` + `onToggleFile`), so each host can put fold-all / whole-diff controls in its own chrome — the shade header keeps its `BlockFoldCue` + `PopOutDiffButton`; the dialog gets its own.
- The component follows [L19]/[L20] authoring: file pair, module docstring, exported `TugChangesListProps` ([S01]), `data-slot="tug-changes-list"`, its own `--tugx-changeslist-*` tokens only if it needs any beyond the migrated `session-changes-*` classes (renaming the CSS classes to `tug-changes-list-*` as part of the move).

#### [P02] The Changes shade becomes a read-only modal viewer (DECIDED) {#p02-read-only-shade}

**Decision:** `SessionChangesView` keeps its `TugSheet presentation="shade"` housing but becomes read-only: header strip, `TugChangesList` (session files + the unattributed-awareness section), the non-repo git-init affordance, and a lower-right `Done` button (`TugPushButton emphasis="primary"` with `persistentDefaultRing`) so Return and Escape both dismiss. Removed: `DraftComposer`, the Commit button, `CommitReceipt`, `DashActions`, `ChangesDashEntry`, `AlsoOnProject`, and the release-preflight confirm.

**Rationale:**
- The shade's confusion came from being viewer + editor + landing surface at once; the viewer is the only role it keeps.
- The shade is standalone UI (not a shareable component) — it shares only `TugChangesList` with the dialog.
- Git-init stays because it is the honest answer to "why is this empty" and is a viewer-appropriate one-shot.

**Implications:**
- `changes-zones.ts` (`alsoSessionRows`, `alsoOnProjectSummary`, `releasePreflight`) and its tests are deleted; `join-verb-plan.ts` and its tests are deleted ([P10]).
- Escape already dismisses via the `TugSheet` cancelDialog chain; the Done button calls the same `onClose` the header's X uses today. Return-dismiss follows the effort-picker convention (`effort-picker-sheet.tsx`): the Done button sits in a `tug-sheet-actions` row with `focusGroup`/`focusOrder` inside the sheet's trapped focus mode, and `persistentDefaultRing` makes it the sole Return consumer — Return falls through to the ringed default.
- `SessionChangesView` keeps its `codeSessionStore` prop solely for `NonRepoBody`: Initialize git is a durable verb and keeps its mid-turn disable (`TURN_GATE_HINT`) — the gate does not leave with the commit/join verbs.
- `use-landing-receipts.ts` shrinks to commit-only ([P07]) since join/release have no UI initiators left.

#### [P03] TugCommitDialog is a user-driven inline dialog at the transcript tail (DECIDED) {#p03-commit-dialog-shape}

**Decision:** New `tugdeck/src/components/tugways/cards/session-commit-dialog.tsx` (+`.css`) composing `TugInlineDialog` (icon `GitCommitHorizontal`, `iconRole="default"`): header actions Cancel / Auto-Message / Commit (trailing cluster, in that visual order), a `TugMessageEditor` in the body, a `TugChangesList` below it. It mounts in a dedicated slot at the tail of the transcript scroller in `session-card-transcript.tsx` (after the last entry, inside the scrolling content), driven by a new per-card `CommitDialogController` ([S03]) — the `ShadeViewController` pattern, exposed through the card services alongside `changesController`.

**Rationale:**
- `PermissionDialog`/`QuestionDialog` prove the inline-dialog stack; the only structural difference is user-driven vs. turn-driven, which the controller absorbs without touching `CodeSessionStore`'s reducer ([Q02]).
- In-scroller mounting keeps "resides in the transcript" true: the dialog scrolls with content and sits at the live edge.

**Implications:**
- Card-modal like its siblings (inline display + trapped focus, the PermissionDialog/QuestionDialog convention): `useFocusTrap({ active, onEscapeDismiss })`, `useInlineDialogScope` (CANCEL_DIALOG responder + key-view seeding + opener restore), `useSpatialOrder` rings/seams over Cancel/Auto-Message/Commit with a seam down into the editor.
- Dismissal must not jump the scroll, but `useFootHeightReservation` in `session-card-transcript-foot-reservation.ts` CANNOT be reused as-is: its presence predicate is hard-wired to `CodeSessionStore` (`pendingApproval !== null || pendingQuestion !== null`) and it is gated to the in-flight assistant cell. Generalize it — parameterize the observed store + presence predicate (`subscribe`/`isDialogPresent`), keeping the [L22] synchronous-notify floor write, the up-only ratchet, and the exported `shouldReserveOnDismiss` pure edge — and have the commit dialog observe `CommitDialogController` with the tail-slot wrapper as the floor element. The existing permission/question call site becomes one parameterization of the generalized hook.
- Only one of dialog-open / shade-open at a time: `CommitDialogController.show()` hides the shade (`shadeViewController.hide()`) and vice versa.

#### [P04] Cmd-Return commits; Return newlines; Escape cancels (DECIDED) {#p04-keyboard-contract}

**Decision:** The editor keeps multi-line Return; `TugMessageEditor`'s `onSubmit` (fired on Cmd-Enter regardless of `returnAction`) triggers Commit; Commit wears `persistentDefaultRing`; Escape / Cmd-. cancels via the inline-dialog scope.

**Rationale:**
- Commit messages are multi-line prose; bare-Return-commits would eat the body.
- This is a deliberate divergence from PermissionDialog (where bare Return answers) — the ring signals "the default action", which here is Cmd-Return.

**Implications:**
- Commit is disabled until the trimmed message is non-empty (the `hasText` mirror-state pattern from `DraftComposer`) and while a commit is pending or a turn is in flight ([P11]); `onSubmit` must consult the same gate before landing.

#### [P05] The message flows through the existing changeset draft store (DECIDED) {#p05-draft-store-flow}

**Decision:** The dialog's editor binds to the persisted per-entry draft exactly as `DraftComposer` does today: seed from `entry.draft.message`, debounce-persist user edits (300 ms) via `getChangesetDraftStore().setDraft(projectDir, "session", ownerId, { message, edited: true })`, sync server echoes only when the doc holds no unsynced edits, and consume (clear) the draft on successful commit.

**Rationale:**
- A half-written message must survive Cancel, reload, and reopen — the draft store already provides exactly this, server-side, with the `edited` pin protecting human text from machine overwrite.

**Implications:**
- Port `DraftComposer`'s `docRef`/`lastSeededRef`/`debounceRef` discipline verbatim (see [#draft-sync-discipline]); flush the debounce on unmount.
- Dialog-open state itself is ephemeral (not preserved across reload) — the draft text is the durable part.

#### [P06] Auto-Message streams into the editor with a Bot + wave affordance (DECIDED) {#p06-auto-message}

**Decision:** The Auto-Message button calls `changesController.requestDraft(force)` (the existing `changeset_draft_request` path). While the draft overlay phase is `drafting`, the dialog shows a status row above the editor with the `lucide-react` `Bot` avatar and `<TugProgressIndicator variant="wave" state="running" size={12} />` (the `/btw` grammar from `side-question-overlay.tsx`), sets the editor `disabled`, and streams overlay text in via `editorRef.current.restoreState(overlay.text)`. On `ready`/`error` the row clears and the editor re-enables. An `edited` draft interposes the existing `TugConfirmPopover` ("Replace your edited message with a regenerated draft?") before forcing.

**Rationale:**
- Composer-is-the-display avoids the teleport double-take ([Q01]); the wave + avatar make generation read like the transcript's own thinking affordance.
- Locking the editor during the stream removes the keystroke/delta interleave hazard.

**Implications:**
- The generation is the scribe sidecar (`draft_engine.rs` → `scribe::summarize_with`, headless `claude -p`, model from tugbank `dev.tugtool.changeset`/`scribe_model`) — untouched by this plan.
- Auto-Message is available mid-turn (drafting mutates nothing), matching today's shade behavior.

#### [P07] The durable commit record rides the shell ledger, server-formatted (DECIDED) {#p07-durable-record}

**Decision:** On `changeset_commit` success, `do_changeset_commit` in `agent_supervisor.rs` (which already holds the `ShellLedger` via `set_shell_ledger`) formats the standard commit summary ([S02]) in Rust, writes a `NewShellExchange { tug_session_id: session_id, command: "/commit", output: summary, exit_code: Some(0), … }` to the ledger, and adds the `summary` string to the `changeset_commit_ok` frame. The client stores `summary` on `CommitState` and, on the `done` transition, appends the live ink row via `codeSessionStore.ingestShellExchange` with that exact string (a slimmed, commit-only `use-landing-receipts.ts`). Restore is free: `list_shell_exchanges` replays the row on Maker ▸ Reload and cold boot, interleaved one-directionally per [D111].

**Rationale:**
- Today's receipt is client-side fiction — `ingestShellExchange` with a synthetic id, bypassing the ledger; it vanishes on reload. Persisting through the existing ledger is the smallest honest lift and inherits the shell route's restore machinery unchanged.
- One formatter (Rust) eliminates drift between the live row and the restored row.
- Shell-ledger rows are non-context ([D111]) — correct: a commit shouldn't enter Claude's context unless shared.

**Implications:**
- The user's `/commit` gesture and the summary become one durable row (`command: "/commit"`, `output: summary`) — the durable record of commits in the transcript and restorable history.
- `formatCommitReceiptInk`/`formatJoinReceiptInk`/`formatReleaseReceiptInk` in `lib/landing-receipt.ts` are deleted along with their tests; `dashNameFromTrailer` (used by the History badge) survives — keep it, relocating only if the module would otherwise be empty (it won't be).
- No live SHELL frame is emitted by the supervisor — the initiating client paints the live row; other decks converge on restore (see [#assumptions]).

#### [P08] A bespoke commit-receipt renderer joins the command-block registry (DECIDED) {#p08-commit-renderer}

**Decision:** New `session-commit-receipt-block.tsx` registered via `registerCommandBlock("commit-receipt", matcher, renderer)` in `session-command-block-registry.ts`, where the matcher claims trimmed commands that are `/commit` or start with `"/commit "`. The renderer presents the standard summary (sha badge, subject line, file/± counts) instead of the generic fenced `ShellExchangeBlock`.

**Rationale:**
- The registry exists precisely for this accretion pattern (first-claim matcher walk, total default underneath); the same row then renders identically live and restored.

**Implications:**
- Registration happens at renderer-module import time. There is no block barrel: the registry's only consumer is `session-card-transcript.tsx` (which imports `resolveCommandBlock` and calls it at the shell row), so that file takes a side-effect `import "./session-commit-receipt-block"` — guaranteeing registration is loaded before the first resolve.
- The renderer parses display facts from the `output` string only (no side-band data), so live and restored rows are pixel-identical.

#### [P09] `/commit` always opens the dialog; the two-beat verb dies (DECIDED) {#p09-commit-verb}

**Decision:** `slashCommandSurfaces.commit` becomes: `commitDialogController.show()`, seeding the editor with the args text when `/commit <message>` carries one (written into the draft store as an edited draft so [P05] semantics apply). `planCommitVerb`, `lib/commit-verb-plan.ts`, and its tests are deleted. The `now` keyword loses its special meaning — args are just the message. Opening with nothing to commit shows the dialog with an empty `TugChangesList` and a disabled Commit button, replacing today's caution-bulletin dance. Update the `commit` entry's `description` in `lib/slash-commands.ts` accordingly.

**Rationale:**
- One gesture, one surface, review-before-landing always — the dialog with Auto-Message + Cmd-Return replaces `/commit now` in two gestures.

**Implications:**
- The four commit gates in `landSessionCommit` (`session-card.tsx`) collapse: turn-in-flight and commit-pending become button-disable states in the dialog; empty-changeset becomes the empty-list presentation; empty-message keeps Commit disabled. The draft-consume-on-success subscription moves into the dialog/controller land path.
- Claude's built-in `/commit` remains shadowed dead by the local match (unchanged).

#### [P10] `/join` degrades to a bulletin for the interim (DECIDED) {#p10-join-interim}

**Decision:** `slashCommandSurfaces.join` becomes a single caution bulletin ("Joins land via the shell for now — TugJoinDialog is coming"); the shade's dash lane, `join-verb-plan.ts`, and the join/resolve/release UI are removed. The `changeset-verb-store` join/release state, `changeset-join-store`, and tugcast's `do_changeset_join`/release handlers stay intact for `TugJoinDialog`.

**Rationale:**
- User decision: a short gap beats carrying the old lane forward, which would preserve exactly the confusion being cut; shell joins suffice meanwhile.

**Implications:**
- `TugJoinDialog` is the named follow-on ([#roadmap]); if `TugCommitDialog` works, it is modeled directly on it.

#### [P11] Allow-open mid-turn; only Commit turn-gates (DECIDED) {#p11-turn-gating}

**Decision:** `/commit` opens the dialog regardless of turn state. The Commit button alone is disabled while `codeSessionStore.getSnapshot().canInterrupt === true` (the turn-in-progress signal), with the existing `TURN_GATE_HINT` title ("Unavailable while a turn is running"). Viewing, editing, and Auto-Message stay live mid-turn.

**Rationale:**
- User decision: the existing inline dialogs carry no such gates and have caused no conflicts — keep the convention until a specific breakage proves otherwise. Durable mutations idle-gate; everything else is free (the landed [P08] gate philosophy, kept).

#### [P12] Session ▸ Commit… menu item (DECIDED) {#p12-menu-item}

**Decision:** In `tugapp/Sources/AppDelegate.swift`, add `sessionMenu.addItem(sessionCommandItem("Commit…", "commit", "session.commit"))` immediately after the `"Rename Session…"` line inside the Session-menu builder. It rides the existing `runCardCommand` → `sendControl("run-card-command", params: ["name": "commit"])` path into the frontmost card's `slashCommandSurfaces.commit` — identical to a typed `/commit`.

**Rationale:**
- The `sessionCommandItem` helper and dispatch plumbing already exist; this is a one-line addition plus menu-state validation parity with its siblings.

---

### Deep Dives {#deep-dives}

#### Originating Prompt {#originating-prompt}

> OK. Consider the work we did in `Session: pretty-earth/294d2086` to implement and landed on commit `c12e84fe47`. This is our third or fourth attempt at a workable design for looking at changes/commits and dashes. Unfortunately, we're not there yet. The sheet/shade scheme we planned for and then implemented this morning remains a confusing mess. We need to untangle this with some new design ideas and how we present them to the user. Here are my ideas.
>
> - We need a *new component* called `TugChangesList`. We basically have the guts of this now in the changes sheet/shade. I want to extract out this list and make it a reusable component we can include in multiple locations in the UI.
> - One place is the current changes shade/sheet, but I want to *greatly simplify* this shade/sheet to be a regular modal presentation (still with the shade style), with a `Done` button in the lower right (that gets a double-ring) and dismisses with return or escape just like any other card modal sheet. The *guts* of this sheet is a read-only list of changes, i.e. the `TugChangesList`. No editing, committing, commit message authoring, or join support should be in the view. It becomes a simple and quick read-only means for the user to see the inflight changes for the current session.
> - The actual commit machinery should move to a new `InlineDialog` called `TugCommitDialog` that resides *in the transcript*. We can model this on the `QuestionDialog` and `PermissionDialog` we already have in terms of how to present such UI in the transcript. This dialog for commits should have:
>   - a `Commit` button in the top right (which is disabled until there's a commit message)
>   - an `Auto-Message` button next to the left of that (which is the new way I'm suggesting for how to describe the request for the AI to generate a commit message for review)
>   - a `Cancel` button to the left to that
>   - a `TugTextEditor` under these top-row buttons for a commit message
>   - a `TugChangesList` below that for reviewing the file changes in the session
> - This new `TugCommitDialog` is shown when the user types `/commit`. We should also add a `Commit...` menu command to the Swift app `Session` menu, placing it under the `Rename Session...` item.
> - When the user asks for an `Auto-Message`, we should borrow some UI affordances so that it feels similar to what we do for the transcript and for the `/btw` mini-transcript, in that the assistant icon should be visible with a *wave* progress indicator, and the text should stream in. It's an open design question about how we'll integrate this with `TugTextEditor`, but we need to do this to make the experience come out right.
> - When the user commits, we need a *standard* post-commit summary, rather than the ad-hoc styles we present now. Obviously, the `TugCommitDialog` is not a durable item in the transcript, but the user's `/commit` message should be, as well as this summary I'm now proposing. They become the curable record of commits in the transcript and restorable history.
> - I'm skipping the `/join` operation for now, but I think that if this idea for an inline `TugCommitDialog` works right (finally), then adding a `TugJoinDialog` as a follow-up project will be reasonably easy to undertake.
>
> I honestly think that this is the way to cut through this multi-session effort to bring a decent and usable commit experience to Tug.

Follow-up decisions from the same conversation: a short `/join` gap (shell joins meanwhile) rather than a shade appendix; allow-open/gate-commit for turn interplay, matching existing inline-dialog conventions; the shade survives as standalone UI sharing only `TugChangesList` with the dialog.

#### Current-state map (what the implementer inherits) {#current-state-map}

- **The shade**: `tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx` (`SessionChangesView`) rides `TugSheetContent presentation="shade"` mounted by the Session card; `ShadeViewController` (`lib/shade-view-controller.ts`) arbitrates `"none" | "changes" | "history"`, with `changesSheetRef`/`historySheetRef` open/close effects in `session-card.tsx`. The view contains the extraction target ([P01]) plus `DraftComposer` (the `TugMessageEditor` commit composer), `CommitReceipt`, `DashActions`/`ChangesDashEntry` (join/resolve/release), `AlsoOnProject` (Zone 2), and `NonRepoBody` (git-init).
- **`/commit` today**: `lib/slash-commands.ts` registers `commit`/`join` in `LOCAL_SLASH_COMMANDS` (shadowing Claude's built-ins); `session-card.tsx`'s `slashCommandSurfaces.commit` runs `planCommitVerb` (`lib/commit-verb-plan.ts`) → beat 1 opens the shade + `changesController.requestDraft()`; beat 2 runs `landSessionCommit(message)` → `changesController.commit(text)` → `ChangesetVerbStore.commit(entryKey, projectDir, files, message, {name, id})` → CONTROL `changeset_commit`.
- **Server commit**: `agent_supervisor.rs` `do_changeset_commit` guards (open project, git worktree), appends the `Tug-Session:` trailer (`changeset_commit_message` via `tugchanges_core::append_trailers`), runs `feeds/changeset.rs::run_changeset_commit` (stages exactly the listed files; returns full HEAD `sha` + `git show --numstat --format= HEAD` text), bumps the aggregate, and broadcasts `changeset_commit_ok { project_dir, sha, receipt }` / `_err { project_dir, detail }`.
- **Receipt today**: `cards/use-landing-receipts.ts` observes the verb store and calls `codeSessionStore.ingestShellExchange` with a synthetic `landing-…` id and `lib/landing-receipt.ts` formatting — client-only, unpersisted, gone on reload.
- **Drafts**: `lib/changeset-draft-store.ts` (`ChangesetDraftStore`, `useChangesetDraft`, overlay phases `idle|drafting|ready|error`); `changesController.requestDraft(force)` sends `changeset_draft_request`; deltas stream as `changeset_draft_delta`/`changeset_draft_state`; generation is the scribe sidecar in `tugrust/crates/tugcast/src/feeds/draft_engine.rs`.
- **Inline dialogs**: primitive `tugways/tug-inline-dialog.tsx` (stateless; `icon`/`iconRole`/`title`/`description`/`leadingActions`/`actions`/`children`/options radio group); consumers `chrome/session-permission-dialog.tsx` and `chrome/session-question-dialog.tsx` own focus (`use-focus-trap.tsx`, `use-inline-dialog-scope.ts`, `use-spatial-order.ts` + `spatial-order.ts`), state preservation (`useSavedComponentState`), and the `persistentDefaultRing` default-button affordance; `session-card-transcript-foot-reservation.ts` prevents dismiss-jump.
- **Shell ledger**: `tugrust/crates/tugcast/src/shell_ledger.rs` (`NewShellExchange`, `ShellExchangeRow`, `record_exchange`, `list_exchanges`); rows restore through the `list_shell_exchanges` CONTROL read → `lib/shell-session-store.ts` `applyListShellExchangesOk` → `ingestShellExchange`; the supervisor already holds the ledger (`main.rs` calls `supervisor.set_shell_ledger(Arc::clone(sl))`).
- **Command-block registry**: `cards/session-command-block-registry.ts` — `registerCommandBlock(name, matcher, renderer)`, first-claim matcher walk over the trimmed command, total default `ShellExchangeBlock`; renderer props are `CommandBlockProps { message: ShellExchangeMessage, onShare?, onToggleContext?, onSendToClaude?, staged? }`.
- **Wave + Bot**: `cards/side-question-overlay.tsx` renders the `/btw` answer slot with `Bot` (lucide) + `<TugProgressIndicator variant="wave" state="running" size={12} />` (`tugways/tug-progress-indicator.tsx`, glyph in `tugways/internal/tug-progress-wave.tsx`).
- **Swift menu**: `tugapp/Sources/AppDelegate.swift` Session-menu builder defines `sessionCommandItem(_ title:_ command:_ id:)` → `runCardCommand` → `sendControl("run-card-command", ["name": command])`; "Rename Session…" is `sessionCommandItem("Rename Session…", "rename", "session.rename")`.

#### Draft sync discipline (port verbatim into the dialog) {#draft-sync-discipline}

`DraftComposer` in `session-changes-view.tsx` established the editor-owned-document contract the dialog must keep: `docRef` mirrors the current doc (user edits + programmatic seeds), `lastSeededRef` the last programmatic seed; a persisted-message echo from the server only lands via `restoreState` when `docRef.current === lastSeededRef.current` (no unsynced user edits), so a server echo can never eat local typing; streamed generation always lands via `restoreState` (never fires `onChange` — the programmatic seam), updating both refs; user edits update `docRef`, set the `hasText` mirror state, and debounce-persist (300 ms) with a flush-on-unmount. `TugMessageEditor.value` seeds once at mount only — later pushes go through `restoreState`.

---

### Specification {#specification}

**Spec S01: TugChangesListProps** {#s01-changes-list-props}

```ts
export interface TugChangesListProps {
  /** Head entries to render, in order: the session entry, then unattributed. */
  entries: ReadonlyArray<TugChangesListEntry>;   // { kind: "session" | "unattributed", id, project, files… } — the ChangesFileEntry shape minus dash
  /** The card session's id — distinguishes own vs foreign bracket hints on unattributed rows. */
  ownSessionId?: string;
  /** Controlled per-file expansion, keyed `${entryId}|${path}` (fileExpandKey). */
  expandedKeys: ReadonlySet<string>;
  onToggleFile: (entryId: string, path: string, collapsed: boolean) => void;
  /** Optional label rendered above the unattributed entry (the shade keeps "unattributed — no session claims these"). */
  unattributedLabel?: string;
  className?: string;
}
```

Also exported for hosts: `fileExpandKey(entryId, path)`, `diffablePathsOf(entry)`, and `entryDiffDescriptor(entry)` (pure), so hosts can build fold-all key sets and whole-diff pop-out descriptors. The component owns diff fetching (`useEntryDiff` + `releaseEntryDiffStore` on unmount) exactly as today.

**Spec S02: The standard commit summary + wire additions** {#s02-commit-summary}

Server-side (Rust, the single formatter), given the full `sha`, the trailer-appended message, and the numstat text from `run_changeset_commit`:

```
committed <sha[0..10]> — <subject>
<N> file(s) · +<added> −<removed>
```

where `<subject>` is the message's first line, `<N>` the count of numstat lines, and `added`/`removed` the summed numstat columns (binary `-` columns count 0). Additions to the wire and stores, all additive:

- `changeset_commit_ok` gains `"summary": <string>`.
- `CommitState` in `lib/changeset-verb-store.ts` gains `summary: string | null`.
- Ledger row: `NewShellExchange { tug_session_id: payload.session_id, command: "/commit", output: summary, exit_code: Some(0), cwd: project_dir, cwd_after: None, started_at_ms/settled_at_ms: now }`, written only on success and only when `session_id` is `Some` (R02). The live client row ingests `{ command: "/commit", output: summary, exitCode: 0 }` verbatim.

**Spec S03: CommitDialogController** {#s03-commit-dialog-controller}

New `tugdeck/src/lib/commit-dialog-controller.ts`, the `ShadeViewController` pattern: `subscribe`/`getSnapshot` over `{ open: boolean, seedMessage: string | null }`; `show(seedMessage?: string)` (hides the shade via the injected `ShadeViewController`, stores the seed), `hide()`. Constructed per card in the card-services wiring next to `changesController`, handed to both the transcript (mount) and the slash surface (show). The land path (gates → `changesController.commit` → draft-consume on `done` → `hide()`) lives here, moved out of `session-card.tsx`'s `landSessionCommit`.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Dialog open/closed + seed | structure (per-card, cross-component) | `CommitDialogController` store + `useSyncExternalStore` | [L02] |
| Commit message document | editor-owned | CM6 doc via `TugMessageEditor`; programmatic pushes via `restoreState`; persisted via draft store | [L02], [#draft-sync-discipline] |
| `hasText` commit gate | local-data | `useState` mirror updated in `onChange`/seed paths | [L24] |
| Draft overlay phase (`drafting` etc.) | external | `useChangesetDraft` (`useSyncExternalStore`) | [L02] |
| Commit round-trip phase/summary | external | `useChangesetCommit` over `changeset-verb-store` | [L02] |
| Turn-in-progress gate | external | `codeSessionStore` `canInterrupt` via `useSyncExternalStore` | [L02] |
| Per-file expansion (dialog + shade) | local-data | `useState<ReadonlySet<string>>` in each host | [L24], [L26] |
| Button poses, wave animation, disabled looks | appearance | CSS + DOM attributes (`data-state`, `disabled`) | [L06] |
| Focus trap / key-view / responder registrations | structure | `useFocusTrap` + `useInlineDialogScope` + `useSpatialOrder` (`useLayoutEffect`-based) | [L03], [L11] |
| Foot-height reservation on dismiss | structure | `useFootHeightReservation` set synchronously in store-notify | [L22] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/tug-changes-list.tsx` (+`.css`) | `TugChangesList` reusable component ([P01], S01) |
| `tugdeck/src/lib/commit-dialog-controller.ts` | `CommitDialogController` ([P03], S03) |
| `tugdeck/src/components/tugways/cards/session-commit-dialog.tsx` (+`.css`) | `TugCommitDialog` ([P03]–[P06]) |
| `tugdeck/src/components/tugways/cards/session-commit-receipt-block.tsx` (+`.css`) | Bespoke `/commit` command-block renderer ([P08]) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `TugChangesList`, `TugChangesListProps`, `fileExpandKey`, `diffablePathsOf`, `entryDiffDescriptor` | component + pure fns | `tug-changes-list.tsx` | moved out of `session-changes-view.tsx` |
| `SessionChangesView` | component | `session-changes/session-changes-view.tsx` | shrinks to read-only viewer + Done ([P02]) |
| `CommitDialogController` | class | `lib/commit-dialog-controller.ts` | S03 |
| `TugCommitDialog` | component | `cards/session-commit-dialog.tsx` | composes `TugInlineDialog` |
| `format_commit_summary` | fn | `tugrust/crates/tugcast/src/feeds/changeset.rs` | S02 formatter, unit-tested |
| `do_changeset_commit` | fn (modify) | `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` | ledger write + `summary` on `_ok` |
| `CommitState.summary` | field | `lib/changeset-verb-store.ts` | additive |
| `useLandingReceipts` | hook (shrink) | `cards/use-landing-receipts.ts` | commit-only, ingests server `summary` |
| `useFootHeightReservation` | hook (generalize) | `cards/session-card-transcript-foot-reservation.ts` | parameterized store + presence predicate ([P03]); permission/question site re-parameterized |
| `slashCommandSurfaces.commit` / `.join` | handlers (rewrite) | `cards/session-card.tsx` | [P09], [P10]; delete `landSessionCommit` |
| deleted: `lib/commit-verb-plan.ts`, `lib/join-verb-plan.ts`, `session-changes/changes-zones.ts`, `formatCommitReceiptInk`/`formatJoinReceiptInk`/`formatReleaseReceiptInk` | — | — | with their tests; `dashNameFromTrailer` survives in `lib/landing-receipt.ts` |
| `sessionCommandItem("Commit…", "commit", "session.commit")` | menu item | `tugapp/Sources/AppDelegate.swift` | under Rename Session… ([P12]) |

---

### Documentation Plan {#documentation-plan}

- [ ] Update `tuglaws/tracking-changes.md` where it describes the shade's commit composer and the `/commit` two-beat verb (both change here).
- [ ] Add a design-decision entry to `tuglaws/design-decisions.md` only if review deems the durable-receipt-via-shell-ledger choice globally citable; otherwise [P07] suffices.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | `format_commit_summary` shape; ledger write on commit success; `summary` field on `_ok`; skip-on-absent-session-id | Steps 3 |
| **Unit (bun)** | matcher claims for the commit renderer; `CommitDialogController` transitions; `TugChangesList` pure exports; slash-surface seeding | Steps 1, 4, 5 |
| **Integration (Rust round-trip)** | commit → ledger row → `list_exchanges` returns it | Step 3 |
| **App-test** | `/commit` opens the dialog; Escape dismisses; shade opens read-only and Done/Escape dismiss | Step 8 (cheap drives only — changeset entries are transient ~2s in the app-test workspace, so full commit flows are covered at the Rust layer) |

#### What stays out of tests {#test-non-goals}

- jsdom render tests and mock-store assertions — banned patterns; behavior is proven by pure-helper tests plus real app drives.
- Full commit-through-dialog app-test flows — the app-test replay workspace's changeset entries live ~2 seconds; the commit round-trip is covered at the Rust layer instead.
- Scribe generation quality — out of scope; the generation path is untouched.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Commits land per the repo's landing flow (the implement skill's dash-worktree commits; `main` only via the user's landing gestures). Cross-check tuglaws before each tugdeck step and name the laws touched in the commit message.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Extract TugChangesList | done | 9b361db36 |
| #step-2 | Read-only shade + /join interim | done | aeed8d02a |
| #step-3 | Durable commit record (tugcast) | done | 6ae99e08d |
| #step-4 | Commit-receipt renderer + slimmed receipts | done | 9b6db2b85 |
| #step-5 | CommitDialogController + TugCommitDialog + /commit rewire | done | 8e7d5cdb7 |
| #step-6 | Auto-Message affordance | done | c6567647a |
| #step-7 | Session ▸ Commit… menu item | done | 6f259c837 |
| #step-8 | Integration checkpoint | done | 7d2dfc7a3 |

#### Step 1: Extract TugChangesList {#step-1}

**Commit:** `tugways(changes-list): extract TugChangesList from the changes shade`

**References:** [P01] TugChangesList scope, Spec S01, (#current-state-map, #state-zone-mapping)

**Artifacts:**
- `tugdeck/src/components/tugways/tug-changes-list.tsx` + `.css` (classes renamed `session-changes-*` → `tug-changes-list-*` for the moved pieces).
- `session-changes-view.tsx` consuming the new component with behavior unchanged (this step is a pure extraction — the shade still has its composer, dash lane, etc.).

**Tasks:**
- [ ] Move the `ChangesFileEntry` item model (session/unattributed only), `statusToneClass`, `StatusIcon`, `isDeleted`, `hasHeadDiff`, `FilePathLink`, `PopOutDiffButton` (file-level), diff-descriptor helpers, `useEntryDiff`, `fileBlockBody`, `ChangesFileBlock`, `ChangesEntryFiles`, `fileExpandKey`, `diffablePathsOf` into `tug-changes-list.tsx`; export per S01. The dash variants (`ChangesDashItem`, range descriptors) stay behind in `session-changes-view.tsx` for now (they die in #step-2).
- [ ] Author the module docstring per [L19] (laws: [L02] diff stores via `useSyncExternalStore`, [L06] status tones via CSS, [L26] collapse-by-unmount under `ToolBlockCollapseContext`).
- [ ] Rewire `SessionChangesView` to render `TugChangesList` for the session + unattributed entries, keeping its banner fold-all/whole-diff controls fed by the exported pure helpers.

**Tests:**
- [ ] `bun test` — existing `session-changes` suites still pass; add/adjust a pure test for `fileExpandKey`/`diffablePathsOf` at their new home.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] Manual: open the `±` shade on a session with changes — identical rendering (rows, diffs, badges, pop-outs) to before.

---

#### Step 2: Read-only shade + /join interim {#step-2}

**Depends on:** #step-1

**Commit:** `tugways(changes): read-only Changes shade with Done; retire the dash lane and /join beats`

**References:** [P02] read-only shade, [P10] join interim, (#current-state-map, #originating-prompt)

**Artifacts:**
- Slimmed `session-changes-view.tsx`: header, `TugChangesList`, unattributed label, `NonRepoBody` (git-init), Done button footer.
- Deleted: `DraftComposer`, `CommitReceipt`, `DashActions`, `ChangesDashEntry`, `AlsoOnProject`, `changes-zones.ts` (+tests), `join-verb-plan.ts` (+tests), the dash item model remnants.
- `slashCommandSurfaces.join` reduced to a caution bulletin; `join` description updated in `lib/slash-commands.ts`.

**Tasks:**
- [ ] Remove the editing/landing/dash pieces from `SessionChangesView` and its CSS; add the lower-right `Done` footer per [P02]: a `tug-sheet-actions` row below the scroll region holding `TugPushButton emphasis="primary"` with `persistentDefaultRing` + `focusGroup`/`focusOrder` (the effort-picker mechanism), calling the existing `onClose` (the shade's Escape path via `TugSheet` cancelDialog is already in place — verify Return activates the ringed default).
- [ ] `SessionChangesViewProps` loses `onCommit` but KEEPS `codeSessionStore` for `NonRepoBody`'s git-init turn gate ([P02]); update the `session-card.tsx` mount.
- [ ] Rewrite `slashCommandSurfaces.join` per [P10]; delete `planJoinVerb` import and `lib/join-verb-plan.ts`; leave `changeset-verb-store`/`changeset-join-store`/tugcast join handlers untouched.
- [ ] Do NOT yet touch `slashCommandSurfaces.commit`/`landSessionCommit` — the shade keeps no Commit button but `/commit` beat 2 still lands headlessly until #step-5 replaces it (interim: `plan.kind === "draft"` still opens the shade; acceptable mid-plan state).

**Tests:**
- [ ] `bun test` — remove the deleted modules' suites; `slash-commands` suite still passes.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] Manual: `±` shade shows read-only list; Done, Return, and Escape each dismiss; no commit/dash affordances anywhere in it; `/join` shows the bulletin.

---

#### Step 3: Durable commit record (tugcast) {#step-3}

**Commit:** `tugcast(changeset): persist the /commit landing to the shell ledger; server-formatted summary on changeset_commit_ok`

**References:** [P07] durable record, Spec S02, Risk R02, (#current-state-map)

**Artifacts:**
- `format_commit_summary(sha, message, numstat) -> String` in `feeds/changeset.rs`.
- `do_changeset_commit` writes the `NewShellExchange` ledger row and adds `summary` to `changeset_commit_ok`.

**Tasks:**
- [ ] Implement `format_commit_summary` per S02 (first-line subject; numstat line count; summed ± with binary `-` as 0).
- [ ] In `do_changeset_commit`: on `Ok(receipt)`, build the summary, include `"summary"` in the `_ok` body, and — when `request.session_id` is `Some` and the supervisor's shell ledger is set — `record_exchange` the row per S02 (`warn!` on ledger error, never fail the commit).
- [ ] Confirm the ledger handle threading (`set_shell_ledger` in `main.rs`) reaches the commit path; store it where `do_changeset_commit` can read it if it currently lives elsewhere on the supervisor.

**Tests:**
- [ ] Rust unit: `format_commit_summary` shapes (multi-line message, binary files, single file).
- [ ] Rust round-trip: a `changeset_commit` with `session_id` writes exactly one ledger row retrievable via `list_exchanges` with `command == "/commit"` and `output == summary`; with `session_id: None`, no row.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`

---

#### Step 4: Commit-receipt renderer + slimmed receipts {#step-4}

**Depends on:** #step-3

**Commit:** `tugways(commit-receipt): bespoke /commit command block; live ink from the server summary`

**References:** [P07] durable record, [P08] commit renderer, Spec S02, (#current-state-map)

**Artifacts:**
- `cards/session-commit-receipt-block.tsx` + registry registration (`"commit-receipt"`).
- `CommitState.summary` in `lib/changeset-verb-store.ts` (parsed from `_ok`).
- `use-landing-receipts.ts` shrunk to commit-only, ingesting the server `summary` verbatim; `formatCommitReceiptInk`/`formatJoinReceiptInk`/`formatReleaseReceiptInk` deleted from `lib/landing-receipt.ts` (+their tests), `dashNameFromTrailer` kept.

**Tasks:**
- [ ] Renderer: parse sha/subject/counts from `message.output` (S02 shape) and present the standard summary (sha badge + subject + counts) with graceful fallback to raw output on parse miss; register with a matcher claiming trimmed `"/commit"` or `"/commit "`-prefixed commands; add the side-effect `import "./session-commit-receipt-block"` to `session-card-transcript.tsx` per [P08] so registration precedes the first resolve.
- [ ] Verb store: carry `summary` through `changeset_commit_ok` parsing into `CommitState`.
- [ ] `useLandingReceipts`: drop the join/release tracking and the client-side formatting; on commit `pending → done`, `ingestShellExchange({ command: "/commit", output: commit.summary, exitCode: 0, … })`.

**Tests:**
- [ ] bun: matcher claims (`/commit`, `/commit msg`, not `/commitx`); renderer parse helper on S02 strings (pure fn, exported).

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] Manual (rebuilt tugcast + app): land a commit via `/commit <msg>` (interim beat-2 path) — the standard summary row appears live, and reappears after Maker ▸ Reload and app relaunch.

---

#### Step 5: CommitDialogController + TugCommitDialog + /commit rewire {#step-5}

**Depends on:** #step-1, #step-4

**Commit:** `tugways(commit-dialog): TugCommitDialog inline in the transcript; /commit opens it; commit-verb-plan retired`

**References:** [P03] dialog shape, [P04] keyboard contract, [P05] draft-store flow, [P09] commit verb, [P11] turn gating, [Q02], Specs S01/S03, Risk R01, (#draft-sync-discipline, #state-zone-mapping)

**Artifacts:**
- `lib/commit-dialog-controller.ts`, `cards/session-commit-dialog.tsx` + `.css`.
- Dialog mount slot at the transcript scroller tail in `session-card-transcript.tsx`.
- Rewired `slashCommandSurfaces.commit`; deleted `lib/commit-verb-plan.ts` (+tests) and `landSessionCommit`.

**Tasks:**
- [ ] Controller per S03, constructed in the card-services wiring next to `changesController`; `show()` hides the shade and vice versa.
- [ ] Dialog per [P03]: `TugInlineDialog` with trailing actions Cancel (`emphasis="ghost"`), Auto-Message (disabled placeholder this step; wired in #step-6), Commit (`emphasis="primary"`, `persistentDefaultRing`, disabled unless `hasText && !turnInProgress && commit.phase !== "pending"`, `widthStabilize` for "Committing…"); body = `TugMessageEditor` (`lineWrap`, placeholder, `onSubmit` → the same gated land path per [P04]) then `TugChangesList` with dialog-owned `expandedKeys`; empty changeset renders the empty list + disabled Commit ([P09]).
- [ ] Focus/modality: `useFocusTrap` + `useInlineDialogScope` (Escape → cancel) + `useSpatialOrder` (Cancel/Auto-Message/Commit ring, seam into the editor); microtask-deferred focus claim onto the editor on open; release follow-bottom via `useScroller()` (the `lib/smart-scroll.ts` façade) before the reveal scroll and clear the stuck header bottom (R01).
- [ ] Generalize `useFootHeightReservation` per [P03]: parameterize the observed store + presence predicate, keep the [L22] synchronous-notify ratchet and the `shouldReserveOnDismiss` pure edge, re-parameterize the existing permission/question call site, and wire the commit dialog's tail-slot wrapper as its floor element observing `CommitDialogController`.
- [ ] Land path in the controller: gates (turn idle, no pending commit, non-empty trimmed message, non-empty changeset) → `changesController.commit(text)` → on verb-store `done`, clear the draft (`setDraft(…, { clear: true })`) and `hide()`; on `error`, surface the detail inline in the dialog (not a bulletin).
- [ ] Editor ↔ draft store binding per [#draft-sync-discipline]; `show(seedMessage)` writes the seed as an edited draft before opening.
- [ ] `slashCommandSurfaces.commit` → `commitDialogController.show(argsOrUndefined)`; update the `commit` description in `lib/slash-commands.ts`; delete `commit-verb-plan.ts`.

**Tests:**
- [ ] bun: controller transitions (show hides shade, seed handling, hide); the land-gate pure predicate (exported) over `{turnInProgress, commitPhase, message, fileCount}`.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] Manual: `/commit` opens the dialog at the transcript tail with the editor focused; typing persists across Cancel/reopen; Cmd-Return lands; the summary row appears; Escape cancels without scroll jump; `/commit some message` seeds the editor; mid-turn the dialog opens with Commit disabled + hint.

---

#### Step 6: Auto-Message affordance {#step-6}

**Depends on:** #step-5

**Commit:** `tugways(commit-dialog): Auto-Message streams the scribe draft with the Bot + wave affordance`

**References:** [P06] auto-message, [Q01], (#draft-sync-discipline, #current-state-map)

**Artifacts:**
- Wired Auto-Message button; drafting status row (Bot + wave); disabled-while-streaming editor; `TugConfirmPopover` guard.

**Tasks:**
- [ ] Auto-Message → `changesController.requestDraft(force)`; `edited` draft interposes the confirm popover anchored to the button (the `DraftComposer` pattern).
- [ ] While `overlay.phase === "drafting"`: render the status row (`Bot` avatar + `TugProgressIndicator variant="wave" state="running" size={12}` + "Drafting…" label) above the editor, set the editor `disabled`, stream `overlay.text` via `restoreState` updating both refs; on `ready` re-enable and focus the editor; on `error` show `overlay.detail` inline and re-enable.
- [ ] Auto-Message disabled while already `drafting`; stays enabled mid-turn ([P06] implications).

**Tests:**
- [ ] bun: pure phase→pose helper (exported) mapping overlay phase to `{editorDisabled, waveVisible, autoMessageDisabled}`.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] Manual: Auto-Message streams a real scribe draft into the editor under the wave; edits after completion persist; regenerate-over-edited asks first.

---

#### Step 7: Session ▸ Commit… menu item {#step-7}

**Depends on:** #step-5

**Commit:** `tugapp(menu): Session ▸ Commit… opens the commit dialog`

**References:** [P12] menu item, (#current-state-map)

**Artifacts:**
- `sessionCommandItem("Commit…", "commit", "session.commit")` under "Rename Session…" in `AppDelegate.swift`, with menu validation matching its siblings.

**Tasks:**
- [ ] Add the item; mirror the enablement treatment of `session.rename` in `validateMenuItem` (bound-session gating).

**Tests:**
- [ ] Covered by the manual checkpoint (no Swift unit harness for menu wiring).

**Checkpoint:**
- [ ] Rebuild Tug.app; Session ▸ Commit… opens the dialog on the frontmost session card, identically to typed `/commit`.

---

#### Step 8: Integration checkpoint {#step-8}

**Depends on:** #step-2, #step-4, #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** [P02], [P07], [P09], (#success-criteria, #test-plan-concepts)

**Tasks:**
- [ ] Full pass over the success criteria on a real session with real changes: shade read-only round-trip; `/commit` → Auto-Message → edit → Cmd-Return → summary row; Maker ▸ Reload and cold relaunch restore the row; `/join` bulletin; menu item.
- [ ] Add an app-test covering the cheap drives: typed `/commit` opens the dialog (assert its `data-slot` presence), Escape dismisses; `±` opens the shade, Escape dismisses. Respect the transient-workspace and settle-delay constraints.

**Tests:**
- [ ] `just app-test`

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run && cd ../tugdeck && bun test && bunx vite build && just app-test`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A usable commit experience: a read-only Changes shade for glancing, a transcript-resident `TugCommitDialog` for authoring (with streamed Auto-Message) and landing, and a durable, restorable standard commit record in the transcript.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All #success-criteria hold on a real session (manual drive per #step-8).
- [ ] `cargo nextest run`, `bun test`, `bunx vite build`, `just app-test` all green.
- [ ] `commit-verb-plan.ts`, `join-verb-plan.ts`, `changes-zones.ts`, and the client receipt formatters are gone; no dangling imports (`bunx vite build` proves it).

**Acceptance tests:**
- [ ] Rust round-trip: commit → ledger row → `list_exchanges`.
- [ ] App-test: dialog open/dismiss, shade open/dismiss.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] `TugJoinDialog` — modeled on `TugCommitDialog`; restores `/join` and the dash join/resolve/release UI ([P10]).
- [ ] Join/release durable receipts via the same ledger pattern once `TugJoinDialog` lands.
- [ ] Slim the Lens Sessions section's duplicated file rows onto `TugChangesList`.

| Checkpoint | Verification |
|------------|--------------|
| Extraction is behavior-neutral | #step-1 manual + `bun test` |
| Durable record survives restarts | #step-4 manual reload/relaunch drive |
| Dialog keyboard contract | #step-5 manual (Cmd-Return, Escape, ring) |
| Whole-phase | #step-8 aggregate command |
