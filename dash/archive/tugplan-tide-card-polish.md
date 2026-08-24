<!-- tugplan-skeleton v2 -->

## T3.4.d — Tide Card Polish & Exit Criteria {#tide-card-polish}

**Purpose:** Close out Phase T3 by working through the polish, ergonomics, and exit-criteria items folded into [tide.md §T3.4.d](./tide.md#t3-4-d-polish-exit). The Tide card landed in [T3.4.c](./archive/tugplan-tide-card.md) as a registered, functional surface that round-trips a single turn against real Claude. This plan picks that surface up and finishes it: the small-but-irritating ergonomic gaps (focus, labels, keyboard jumps), the layout bugs that show up the first time you open completions inside a small card, the session ledger + full resume UX deferred from T3.4.c, the participant-aware multi-turn transcript that the Step 5 wire-up deferred, and the larger feature-coverage / quality / a11y bars that gate Phase T3 exit.

The work is staged smallest-blast-radius first: each step is one commit, the build stays green at every commit, and the early steps are deliberately scoped so any of them could be cherry-picked without taking the rest. The big-ticket items (session ledger, participant model, transcript rendering, permission/question UI) come later in the sequence, with the small ergonomic wins paying down user pain immediately.

This plan supersedes the bullet list under [tide.md §T3.4.d](./tide.md#t3-4-d-polish-exit) — same items (plus the participant model, explicit user-submission rendering, and the carried-forward session ledger placeholder added during plan authoring), ordered for execution and broken into commit-sized steps.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-04-29 |
| Roadmap anchor | [tide.md §T3.4.d](./tide.md#t3-4-d-polish-exit) |
| Predecessor | [tugplan-tide-card.md](./archive/tugplan-tide-card.md) (T3.4.c) |

---

### Phase Overview {#phase-overview}

#### Context {#context}

[T3.4.c](./archive/tugplan-tide-card.md) shipped the Tide card as a registered surface with a real `CodeSessionStore`, project picker, `spawn_session` / `close_session` lifecycle, per-workspace session-id ledger, resume-vs-new picker, fresh-spawn default, and a single-turn `TugMarkdownView` wire-up. Step 5 of that plan deliberately wired *only* `inflight.assistant` — multi-turn accumulation, thinking blocks, and tool surfaces were called out as T3.4.d follow-ups. [Step 4.6 of T3.4.c](./archive/tugplan-tide-card.md#step-4-6) was authored as a design sketch for a tugcast-side session ledger + full resume UX but deliberately deferred to T3.4.d — this plan carries that placeholder forward. The status badge in `tide-card.tsx:828` still hard-codes `"Project path /gallery/demo"` as a gallery-copy artifact. The card body inherits the polished ergonomics of `gallery-prompt-entry.tsx` but, when used as a *real* Claude surface (rather than a gallery demo), several small interaction gaps became obvious immediately:

- The prompt input does not get focus when a card is opened. Every interaction starts with a click-to-focus.
- After submitting a turn, focus is lost. Typing the next prompt requires another click.
- There is no global "focus the prompt" key. Cmd+K does nothing; Tab does not enter the entry from card chrome.
- The route gutter labels the Claude route as "Prompt", which describes the *input control*, not what the route *is*. The user-facing concept is closer to "Code" (the assistant talking through code-aware tooling).
- Completion popups (`/` slash, `@` file) can render past the card's bottom edge in small-card layouts, breaking the pinned prompt-entry's bottom alignment.
- Atoms only render cleanly at line-height ≥ 1.7. Tighter leading values jump the line when an atom is inserted.
- The transcript is missing. The top pane shows the in-flight assistant turn and the (sticky) last completed turn; prior turns and the user's own submissions never appear.
- There is no "speaker" model to distinguish *who* produced an entry in the transcript. Tide will mix at least four participants — the user, Claude Code, shell output (post-T4), and `:` surface command output (post-T10) — and there is currently no shared component vocabulary for rendering them so a reader can tell at a glance who said what.
- There is no way to navigate the transcript with the keyboard — no jump-to-history-entry, no jump-to-bottom.
- The status badge that should display the bound `projectDir` (or a cwd glyph) still shows the gallery string.
- Session bookkeeping still lives in the tugbank map landed by [Step 4i of T3.4.c](./archive/tugplan-tide-card.md#step-4i): one id per workspace, no metadata, no branching, no "forget one specific session." The resume-vs-new picker landed in [Step 4.5 of T3.4.c](./archive/tugplan-tide-card.md#step-4-5) is honest but minimal — users will hit its limits the moment they have more than one session per workspace they care about.

The bigger items deferred from T3.4.c — session ledger + full resume UX, multi-turn transcript rendering, thinking + tool surfaces, markdown styling pass, mid-stream behaviors E2E, `control_request_forward` UI — are all in scope here too. They land later in the sequence after the small ergonomic wins.

#### Strategy {#strategy}

- **Easy first.** The first eight steps are scoped so that a single commit per step is realistic: a string rename, a focus call, a key handler, a label swap. Each lands user-visible improvement immediately and does not need follow-on work to be useful. The deeper items (participant primitive, session ledger, transcript, permission UI) come later.
- **Design before wire-up.** The participant model (Step 9) lands as a designed primitive in a gallery card *before* the transcript rendering step (Step 11) wires it into the live `CodeSessionStore`. That keeps the visual design tunable in isolation and the wiring step focused on data binding.
- **Placeholders carry forward explicitly.** The session ledger + full resume UX (Step 10) arrives as a *design placeholder only*, carried over from [Step 4.6 of T3.4.c](./archive/tugplan-tide-card.md#step-4-6). Before implementation, the sketch is promoted into its own concrete plan (`dash/tugplan-tide-session-ledger.md` or equivalent) that enumerates files, sub-steps, verifications, and exit criteria. The placeholder in this plan documents intent, non-goals, and open questions — not a landable commit sequence.
- **One commit per step.** Where a step might want to grow (transcript, atom line-heights, participant primitive), the step's Work section calls out the minimal viable shape and defers richer treatment to a noted follow-up rather than expanding the commit. The session ledger step is the deliberate exception — it is a "stop and design" marker, not a commit.
- **Build stays green at every commit.** `bun run check`, `bun test`, `bun run audit:tokens lint`, and `cargo nextest run` pass on every step. `-D warnings` enforced.
- **No new IndexedDB.** Per [D-T3-10](./tide.md#decisions-t3). Any persistence goes through tugbank or, in the session ledger case, the purpose-built sqlite store that replaces it.
- **Tuglaws apply.** Every step that touches `tide-card.tsx`, `tug-prompt-entry.tsx`, the new transcript primitive, or new helpers re-checks against [tuglaws.md](../tuglaws/tuglaws.md). The closing step records a walkthrough.
- **Reuse the existing surfaces.** Focus / keybinding work threads through the existing `TugPromptEntryDelegate` handle and `ResponderScope`. Transcript rendering uses `TugMarkdownView`'s imperative `setRegion` handle (already in use for the streaming region), now plugged into the new `TugTranscriptEntry` body slot. Permission / question UI uses the existing CONTROL frame plumbing — no new transport.
- **Defer P2-gated multi-session work to its own step.** Two concurrent Tide cards already work post-[4k](./archive/tugplan-tide-card.md#step-4k); the multi-session *exit criterion* in tide.md §T3.4.d is about formalizing the verification, not building new infrastructure. It rides as a late step.
- **Manual smoke at every behaviorally-visible step.** Where a step ships a new interaction (focus, keybinding, transcript rendering, participant rendering), the verification includes a manual scenario the user can walk through in the running tugdeck.

#### Success Criteria (Measurable) {#success-criteria}

**Ergonomics:**
- Opening a Tide card focuses the prompt input directly; the user can type immediately. (verification: manual + test)
- After submitting a turn, focus returns to the prompt input. (verification: manual + test)
- With a Tide card active, pressing Cmd+K places a blinking caret in the prompt input regardless of where focus sits inside the card. (verification: manual + test)
- Cmd+J jumps the transcript view to the currently-selected history entry; with no history selection, Cmd+J scrolls the transcript to the bottom. (verification: manual + test)
- The status row shows the card's bound `projectDir` (or a shortened form), not the gallery placeholder. (verification: `rg 'Project path /gallery/demo' tugdeck/src/components/tugways/cards/tide-card.tsx` returns zero matches)

**Labeling:**
- The route gutter labels the Claude route as `Code`, not `Prompt`. The `>`/`❯` keystrokes still flip to the same route. (verification: `rg '"Prompt"|'Prompt'' tugdeck/src/components/tugways/tug-prompt-entry.tsx` returns zero matches; manual)

**Layout:**
- Slash and file completion popups never render outside the card's bottom edge or push the prompt-entry above the card's bottom pane bound. The prompt-entry's pinned-bottom layout survives all completion states. (verification: manual at small card sizes)
- Atom insertion preserves baseline at line-height values below 1.7 (down to a documented minimum, e.g., 1.2). The line does not jump when an atom is added or removed. (verification: manual; integration test if feasible)

**Participant model + transcript:**
- A `TugTranscriptEntry` primitive exists, with a Slack-like layout: left-aligned participant icon column, header row with bold identifier + timestamp, content body, optional controls/badges row beneath. **No chat bubbles** — no rounded per-row container, no left-vs-right alignment by speaker. (verification: gallery card + manual visual review against [D6](#resolved-decisions))
- The primitive supports the four initial participants (`user`, `code`, `shell`, `command`), each with its own icon and identifier styling. Adding a participant variant is a token + a registration, not a code rewrite. (verification: gallery demo renders all four)
- User-submitted prompts/commands appear in the transcript flow as `participant: "user"` rows, in line with the assistant responses they precede. The user sees their own submission appear the moment they hit Enter. (verification: test + manual)
- Multi-turn conversations accumulate in the top pane: pairs of `user` + `code` rows for each turn render as the conversation grows. The in-flight turn streams into the `code` row's body region; completed turns occupy permanent rows. (verification: manual; test against a recorded session fixture)
- The "sticky last turn" Step 5 fallback is removed once transcript rendering lands. (verification: code review; `rg` for the relevant comment)

**Session ledger + resume UX:**
- A concrete plan for the session ledger + full resume UX exists at `dash/tugplan-tide-session-ledger.md` (or equivalent), promoted from the design sketch in [Step 10](#step-10). The concrete plan's own exit criteria replace this line once it lands. (verification: the file exists; this plan's Step 10 references it as promoted.)
- Until the concrete plan lands, this plan's Step 10 is a placeholder — it does not commit code, and downstream steps do not depend on ledger-backed behavior.

**End-to-end coverage:**
- Type `> hello` → `user_message` on `CODE_INPUT` → `assistant_text` deltas on `CODE_OUTPUT` → streaming render → `turn_complete(success)` → entry returns to idle.
- Mid-stream Stop → `interrupt` → `turn_complete(error)` → `interrupted → idle`, accumulated text preserved.
- Mid-stream `user_message` sends → queued → auto-flush on idle.
- `tool_use` and `tool_use_structured` drive `tool_work` sub-state; submit button stays in Stop mode throughout.
- `control_request_forward { is_question: false }` surfaces a permission block; allow/deny writes a `tool_approval` frame.
- `control_request_forward { is_question: true }` surfaces a question block; answer writes a `question_answer` frame.

**Feature coverage:**
- `>`, `$`, `:` route prefixes dispatch correctly. (`>` is live; `$` is inert pre-tugshell; `:` routes through the local surface registry.)
- Route indicator and route atom remain bidirectionally synced.
- `@` file completion returns FILETREE-backed results and inserts file atoms.
- `/` slash command completion merges `SessionMetadataStore.slashCommands` and skills.
- History navigation (Cmd+Up/Down) works per-route from `PromptHistoryStore`.

**Quality:**
- CJK end-to-end (Japanese, Chinese) verified — IME compose → submit → streamed response.
- VoiceOver announces atoms, route indicator, submit/stop button, and transcript participant rows correctly.
- Atom drag-and-drop from Finder produces file atoms.
- No jank during typeahead over full-project file listings.

**Multi-session (gated on P2):**
- Two Tide cards open simultaneously run two independent `CodeSessionStore` instances, each keyed by its own `tugSessionId`. Submitting in one does not affect the other. (Already true post-[4k](./archive/tugplan-tide-card.md#step-4k); this step adds the formal verification + a regression test.)

**Compliance:**
- All new/changed components pass the component authoring guide checklist.
- All new tokens conform to the seven-slot naming convention.
- `bun run audit:tokens lint` exits 0.
- Vitest + Rust nextest suites pass with `-D warnings`.
- No new IndexedDB dependencies introduced (D-T3-10). Any new persistence goes through tugbank.

#### Scope {#scope}

**In scope:**
- Status badge `projectDir` wiring (replaces the `tide-card.tsx:830` gallery string).
- Route label rename: `Prompt` → `Code` in `tug-prompt-entry.tsx:85`.
- Auto-focus the prompt editor whenever the tide card becomes the key card (mount, click, Ctrl+` cycle); auto-refocus after submit.
- Card-level keybindings: Cmd+K → focus prompt; Cmd+J → jump transcript.
- Canvas-level overlay tier; migrate the completion popup off card-clipping (popups belong to the canvas, not the card).
- Atom rendering at tighter line-heights.
- Participant model + `TugTranscriptEntry` primitive (Slack-like layout, no chat bubbles), with gallery demo.
- **Session ledger + full resume UX as a design placeholder** — a carry-forward of [Step 4.6 of T3.4.c](./archive/tugplan-tide-card.md#step-4-6). Implementation is gated on a promoted plan; the placeholder here captures intent, schema sketch, CONTROL protocol additions, migration notes, lifecycle policies, non-goals, and open questions.
- Multi-turn transcript rendering using the participant primitive; user submissions visible in-flow; removal of the sticky-last-turn fallback.
- Markdown typography / spacing / chrome polish for Claude Code output.
- Thinking and tool-use surface wiring (placement TBD in the step).
- Mid-stream behaviors: Stop, queued sends, tool sub-state, permission/question dialogs.
- Feature-coverage hardening: `>`/`$`/`:` routing, indicator sync, `@` completion, `/` completion, history nav.
- CJK + VoiceOver quality passes.
- Atom drag-drop from Finder.
- Typeahead jank profiling.
- Concurrent Tide cards regression test.
- Compliance close-out (tokens lint, IndexedDB grep, full check matrix).
- Tuglaws walkthrough.

**Out of scope (deferred):**
- Implementation of the session ledger + full resume UX — lives in its own promoted plan (Step 10's promotion gate).
- Live `shell` and `command` participant rows in the transcript — the primitive supports them and the gallery demos them, but the live wires arrive with Phase T4 (tugshell) and Phase T10 (`:` surface built-ins) respectively. This plan only wires `user` and `code` rows to live data.
- `BuildStatusCollector` per-workspace ([tide.md line 2102](./tide.md#prefix-router-prompt-input)).
- Claude `--resume` (P14) and stream-json version gate (P15) — separate plans.
- P2 multi-session router work — landed independently; this plan's multi-session step exercises whatever the router state is at landing time.
- Image attachments (U15) — Phase T11.
- Subagent activity display (U8) — Phase T9.

#### Resolved Decisions {#resolved-decisions}

- **D1 — Route label.** `Code`. Decided by the user in this plan's authoring conversation. Rationale: "Prompt" describes the input control, not what the route *is*; "Code" reflects the assistant's purpose and keeps "Claude" out of the chrome. `>` and `❯` continue to route to it.
- **D2 — Cwd presentation.** Replace the gallery string with the bound `projectDir` rendered into the existing `TugBadge`. Shortening / icon variants are a follow-up (Step 1 ships the literal string; later cosmetic refinement is not blocked here).
- **D3 — Cmd+K only; Tab dropped.** Cmd+K is the canonical "focus the prompt" gesture and the only card-level focus chord. Tab was considered as a second gesture (hop from chrome into the editor) but dropped during Step 5 implementation: Tab has too much established meaning in card chrome (focus-ring movement, tab stops in popovers, accepting a completion) for a card-level claim to be unambiguous.
- **D4 — Cmd+J semantics.** With a history entry navigated to in the prompt-entry, Cmd+J scrolls the transcript to that entry's location. With no history selection, Cmd+J behaves like End / Cmd+Down: scroll to bottom.
- **D5 — Atom line-height target.** Tighter than 1.7 must work without baseline jump. Concrete minimum decided in [Step 7](#step-7) once the engine work surfaces the constraint.
- **D6 — Participant model is Slack-like, *not* chat bubbles.** Decided by the user during plan authoring. Rationale: chat bubbles are wrong for a developer surface that mixes human, AI, shell, and command output — alternating sides and rounded backgrounds make a transcript hard to scan. Layout: left-aligned icon column (~32–40px), then a content column with a header row (bold identifier + small timestamp), then the body, then an optional controls/badges/icons strip beneath the body. Initial participants: `user`, `code` (Claude Code), `shell` (post-T4), `command` (post-T10). The model is open for extension via a token registration, not a code rewrite. No avatar photos; participant icons are glyphs/marks.
- **D7 — Session ledger starts as a design placeholder.** Carried forward from [Step 4.6 of T3.4.c](./archive/tugplan-tide-card.md#step-4-6). Rationale: the sketch is rich enough that treating it as a single commit would under-specify the sqlite schema, CONTROL protocol additions, migration, and picker reshape. Starting preferences captured in [Step 10](#step-10)'s open-questions list (sqlite over JSONL; tugcast CLI flag over CONTROL round-trip; `resume_failed` → `"failed"` state rather than delete). Promotion to a concrete plan happens before implementation, in its own document.

---

### Plan Status (2026-04-29 rejoin) {#plan-status}

Roughly half the steps shipped between the original 2026-04-19 draft and the 2026-04-29 rejoin. The list below is the at-a-glance map; the per-step sections retain their full content for reference, with a `**Status:**` line at the top of each step indicating its standing.

**Resume point: [Step 7.5](#step-7-5).** Steps 7.5 and 8 onward are the active work queue. Before resuming Step 8, read each "Existing and remaining" step and confirm it still describes reality — several months of unrelated work landed on top of the original drafts.

| Step | Title | Status |
|-|-|-|
| 1 | Status row shows the bound `projectDir` | shipped |
| 2 | Rename Claude route label `Prompt` → `Code` | shipped |
| 3 | Auto-focus the prompt input whenever the tide card becomes key | shipped |
| 4 | Re-focus the prompt input after submit | shipped |
| 5 | Cmd+K focuses the prompt input from card chrome | shipped |
| 5.5 | Unified card-activation lifecycle | shipped |
| 5.5.a | Lifecycle & DeckManager tightening (audit follow-ups) | shipped |
| 5.5.b | Decompose `CardHost` into per-concern hooks | shipped |
| 5.5.c | Invariants and safety-net tests | shipped |
| 6 | Cmd+J scrolls to the selected history entry (or bottom) | **merged into [Step 11](#step-11)** |
| 7 | Atoms render cleanly at tighter line-heights | **done** |
| **7.5** | **Connection health checking and reconnect-aware tide cards** | **next — new in this rejoin** |
| 8 | Canvas-level overlays: popups escape the card, constrained only by the canvas | **done** — split into three subordinate plans (overlay-tier, popup-bindings, overlay-framework); see [step](#step-8) |
| 9 | Participant model + `TugTranscriptEntry` primitive | pending — refresh before starting |
| 10 | Tugcast-side session ledger + full resume UX | **shipped** — see [tugplan-tide-session-ledger.md](./tugplan-tide-session-ledger.md) |
| 11 | Multi-turn transcript rendering with `TugTranscriptEntry` | **shipped** — see [tugplan-tug-list-view.md](./tugplan-tug-list-view.md); Cmd+J deferred to its own follow-up plan |
| 12 | Markdown styling pass for assistant output | pending |
| 13 | Wire thinking + tool surfaces | pending |
| 14 | Mid-stream behaviors end-to-end (Stop, queued sends, tool sub-state) | pending |
| 15 | `control_request_forward` UI (permission + question) | pending |
| 16 | Feature coverage: route prefixes, indicator sync, completions, history | **done** |
| 17 | CJK end-to-end | **done** |
| 18 | VoiceOver / a11y pass | **deferred** |
| 19 | Atom drag-and-drop from Finder | **done** |
| 20 | Typeahead jank profiling | **deferred** |
| 21 | Concurrent Tide cards regression test | pending |
| 22 | Compliance close-out | pending |
| 23 | Tuglaws walkthrough | pending |

**Refresh-before-resume note.** Steps 9, 12, 13, 14, 15, 21, 22, 23 were authored 2026-04-19. Before resuming each, re-read its Files and Work sections against the current code — `tug-prompt-entry`'s migration to `tug-text-editor` (Step 15 of `dash/text-editing-base.md`), the editor-settings sheet, and the tide card's panel-growth wiring all landed in the interim and may have moved file paths, renamed delegates, or changed seams the original step text assumed.

---

### Steps {#steps}

Each step is its own commit. `bun run check`, `bun test`, `bun run audit:tokens lint`, and `cargo nextest run` pass at the end of every step. [Step 10](#step-10) is the deliberate exception — it is a design placeholder that promotes to its own plan before any code lands.

#### Step 1 — Status row shows the bound `projectDir` {#step-1}

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (`statusContent` near line 828).

**Work:**
- Replace the hard-coded `Project path /gallery/demo` string in the `TugBadge` with the bound `projectDir` from the card's `CardSessionBinding` (already available via the `useTideCardServices` binding subscription per [4b](./archive/tugplan-tide-card.md#step-4b)).
- Render the literal path for now. Shortening (e.g., `~/...`, basename-only, or a cwd icon) is a deliberate later refinement so this commit stays a one-line swap. Note the follow-up in a code comment if appropriate.
- The badge still uses `size="sm"`, `emphasis="tinted"`, `role="data"` — no token changes.

**Verification:**
- `bun x tsc --noEmit` + `bun test` green.
- `rg 'Project path /gallery/demo' tugdeck/src/components/tugways/cards/tide-card.tsx` returns zero matches.
- Manual: open a Tide card on `/u/src/tugtool`; the status badge reads `/u/src/tugtool` (or your chosen path). Open another Tide card on `/tmp`; badge reads `/tmp`.

#### Step 2 — Rename the Claude route label `Prompt` → `Code` {#step-2}

**Files:**
- `tugdeck/src/components/tugways/tug-prompt-entry.tsx` (`ROUTE_ITEMS` at line 85).
- `tugdeck/src/components/tugways/__tests__/tug-prompt-entry.test.tsx` (any test asserting the label string).
- Any other production reference to the literal route label `"Prompt"` in this file or its callers.

**Work:**
- Change the label in the `ROUTE_ITEMS` entry: `{ value: "❯", label: "Code", icon: "❯" }`.
- Search for any other production reference to the literal string `"Prompt"` as a route label and update consistently. Comments referring to "the Prompt route" can stay or be edited at discretion — the plan does not require a mass rename of internal terminology, only the user-visible label.
- Tests asserting the rendered label update accordingly.
- VoiceOver / aria-label fields tied to the route choice update to read "Code".

**Verification:**
- `bun x tsc --noEmit` + `bun test` green.
- `rg '"Prompt"' tugdeck/src/components/tugways/tug-prompt-entry.tsx` returns zero matches.
- Manual: open a Tide card; the route indicator reads `Code`; typing `>` at position zero still flips to it; typing `❯` still flips to it; `$` and `:` still flip to Shell / Command.

#### Step 3 — Auto-focus the prompt input whenever the tide card becomes key {#step-3}

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (key-card observer).
- `tugdeck/src/components/tugways/tug-prompt-entry.tsx` (confirm `TugPromptEntryDelegate` exposes a `focus()` method; add if missing).

**Work:**
- Confirm `TugPromptEntryDelegate` has a `focus(): void` method that places the caret in the editor. If absent, add it — its body delegates to the underlying `TugPromptInput`'s focus path.
- In `TideCardBody`, add a `useLayoutEffect` that subscribes to `manager.observeKeyResponder("card", ...)`:
  - On subscribe, synchronously check `manager.getKeyCard() === cardId`; if so, call `entryDelegateRef.current?.focus()` (covers the "body first mounts and was already the key card" case — observer callbacks don't fire on subscribe).
  - On each observed transition, if the next key card id is this card's id, focus the editor.
  - Return the observer's unsubscribe for cleanup.
- This unified mechanism handles every path that makes the tide card active: initial bind / picker-dismiss, click on any card element (pointerdown promotion flips the key card), Ctrl+` cycle, and any future programmatic key-card change. No bespoke mount-only effect.
- [L07]: handler reads the delegate via the ref, never a closed-over value.

**Verification:**
- `bun x tsc --noEmit` + `bun test` green.
- Manual: open a tide card — caret blinks in the editor without a click. Click a sibling card, then click back — caret returns to the editor. Ctrl+` cycles through cards; when the tide card rotates to the front, caret is in the editor immediately.
- **No in-process focus assertion.** Focus is verified manually and by the lower-level tests that target the delegate directly; trusted-event focus behavior belongs in app-test against the real Tug.app.

#### Step 4 — Re-focus the prompt input after submit {#step-4}

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (or wherever `handleBeforeSubmit` / submit completion runs).

**Work:**
- After a successful submit, call `entryDelegateRef.current?.focus()`. Tie it to the submit completion path (whether that's `onBeforeSubmit` returning, the `CodeSessionStore` snapshot transitioning to `submitted`, or the `TugPromptEntry`'s `onSubmit` callback — whichever fires last and is the natural seam in the existing code).
- Do not refocus on submit *failure*; the user may want to inspect an error inline before typing again. (If the post-failure UX warrants refocus too, decide here.)

**Verification:**
- `bun x tsc --noEmit` + `bun test` green.
- New test: simulate submit of `> hi` → on completion, assert the prompt input regains focus.
- Manual: open a Tide card, submit a prompt, watch focus return to the input as the assistant streams; start typing the follow-up immediately without clicking.

#### Step 5 — Cmd+K focuses the prompt input from card chrome {#step-5}

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (card-level key handler).

**Work:**
- Add a card-level `keydown` handler on the `tide-card` root that intercepts Cmd+K (or Ctrl+K on non-Mac), calls `entryDelegateRef.current?.focus()`, and `event.preventDefault()`. Idempotent when the prompt is already focused. `event.defaultPrevented` short-circuits so any child (completion menu, dialog) that already consumed the key wins — the card is a fallback, not a top-level claim.
- `event.preventDefault()` is defensive against browser hotkeys that might otherwise claim the chord.
- Tab is NOT handled per [D3](#resolved-decisions) — the ambiguity with card-chrome focus-ring movement, popover tab stops, and completion acceptance makes a card-level claim unsafe.

**Verification:**
- `bun x tsc --noEmit` + `bun test` green.
- New test: render a Tide card → focus an arbitrary element in the card chrome (e.g., the maximize button) → simulate Cmd+K keydown → assert prompt input gains focus.
- Manual: open a Tide card, click into the maximize button (focus chrome), press Cmd+K → caret in prompt input.

#### Step 5.5 — Unified card-activation lifecycle {#step-5-5}

**Why this exists.** Step 3 landed an observer-based auto-focus that watches `manager.observeKeyResponder("card", ...)`, and Step 5 wired Cmd+K through the `scope: "key-card"` keybinding path. Both depend on the responder chain's key card transitioning when the user activates a card. During manual testing a class of activations was found to NOT transition the key card: clicks on `data-tug-focus="refuse"` elements (title bar, chrome buttons). `handleFramePointerDown` updates the deck store's focused card; the capture-phase `promoteOnPointerDown` skips focus-refuse targets and does not touch the responder chain. Result: the user activates a tide card by clicking its title bar, the store's focused card updates, z-order flips, `data-focused` flips — but `manager.getKeyCard()` still points at the previously-active card, no observer fires, the editor doesn't receive focus, the next keystroke beeps.

The underlying problem is architectural, not local to tide card: "activate a card" is three state updates (store z-order, responder chain first responder, selection guard) across three systems kept in sync by convention. Each trigger path (pointerdown non-refuse, pointerdown refuse, Ctrl+\`, initial load, show-component-gallery) touches a different subset. Consumers then subscribe to whichever subset they happen to need and silently miss activations on paths that skipped their system.

This step consolidates card activation into a single first-class lifecycle operation with a single event, so future cards and shortcuts can subscribe once and trust the signal.

**The investigation artifact.** Three independent notions of "active card" exist today:

| State system | What it is | Drives |
|---|---|---|
| `store.focusedCardId` | last entry in store.cards array | z-index, `card-frame[data-focused]` |
| `manager.firstResponderId` (+ `getKeyCard()`) | responder chain's first-responder, walked up to the nearest `kind: "card"` | keyboard shortcut routing, `scope: "key-card"` dispatch |
| `selectionGuard.activeCardId` | the card whose inactive-selection highlight is suppressed | inactive-card dimming |

Each activation path hits a different subset:

| Path | store | responder chain | selection guard |
|---|---|---|---|
| pointerdown on non-focus-refuse target | ✓ | ✓ (descendant) | effect |
| pointerdown on focus-refuse target (title bar, chrome) | ✓ | ✗ | effect |
| Ctrl+\` (CYCLE_CARD) | ✓ | ✓ (card) | effect |
| Initial load | ✓ | ✓ (card) | effect |
| SHOW_COMPONENT_GALLERY | ✓ | ✓ (card) | effect |

Consumers accordingly read from different sources: z-index watchers read `store.focusedCardId`; keyboard routing reads `getKeyCard()`; tide card's auto-focus observer reads key-card transitions. The focus-refuse path's divergence between store and responder chain is the root cause of the beep-on-title-bar-click.

**Proposed shape.**

1. A single activation function emits one signal, synchronously:
   ```ts
   deck.activateCard(cardId: string): void
   ```
   In order:
   a. `store.handleCardFocused(cardId)` — z-order update.
   b. If `manager.getKeyCard() !== cardId` → `manager.makeFirstResponder(cardId)`. (Preserves in-card descendant focus when the chain is already inside this card.)
   c. Notify `CardActivationObserver`s registered for this cardId and for the wildcard (`null`).

2. A subscription API:
   ```ts
   deck.observeCardActivation(
     cardId: string | null,   // null = any card
     callback: (cardId: string) => void,
   ): () => void
   ```
   Fires on transitions. Fires synchronously on subscribe for the currently-active card so mount-time activation isn't a special case.

3. A React convenience hook:
   ```ts
   useOnCardActivated(cardId: string, callback: () => void): void
   ```

4. Post-`activateCard(cardId)` invariant (synchronously observable):
   - `store.focusedCardId === cardId`
   - `manager.getKeyCard() === cardId`
   - `selectionGuard.activeCardId === cardId` (via subscription — see 5(d) below)
   - all observers for `cardId` have been notified

This invariant is the property the current system lacks and the reason consumers can't trust a single signal today.

**Resolved design decisions (user, 2026-04-19 plan-review):**

- **D7 — Placement.** New `card-lifecycle.ts` module that both `DeckManager` and `DeckCanvas` use. Keeps the activation vocabulary separable from either consumer.
- **D8 — `handleCardFocused` visibility.** Delete. After migration, no external caller remains; the store-internal z-order method stays under a different name or stays private to the store.
- **D9 — Observer model.** Plain pub/sub on the deck lifecycle, not an extension of `observeKeyResponder`. Responder-chain concerns stay separate.
- **D10 — Selection guard integration.** `selectionGuard` subscribes to `observeCardActivation(null, ...)`. No direct call from inside `activateCard`. Keeps activation's side-effect surface at one call.
- **D11 — Descendant promotion on pointerdown.** Keep `promoteOnPointerDown` exactly as-is. It promotes responders *below* the card (editor, popover, inner button), never the card itself. Card-level promotion lives solely in `activateCard`.

**Files:**
- `tugdeck/src/lib/card-lifecycle.ts` (new — exports `activateCard`, `observeCardActivation`, and the observer/store types).
- `tugdeck/src/lib/card-lifecycle.tsx` or equivalent (new — `useOnCardActivated` React hook; or colocate in the `.ts` if React dependencies are already there).
- `tugdeck/src/deck-manager.ts` (expose an `activateCard` entry that delegates to `card-lifecycle`; remove `handleCardFocused` public surface per [D8](#step-5-5)).
- `tugdeck/src/components/chrome/deck-canvas.tsx` (delete the local `handleCardFocused`; replace call sites in `CYCLE_CARD`, `SHOW_COMPONENT_GALLERY`, initial-load effect with `activateCard`).
- `tugdeck/src/components/chrome/card-frame.tsx` (`handleFramePointerDown` calls `activateCard` instead of `onCardFocused`; the `onCardFocused` prop becomes `onActivate` or is removed if the function can be imported directly).
- `tugdeck/src/components/tugways/selection-guard.ts` (subscribe to `observeCardActivation` on install; drop the `useLayoutEffect` wiring in `deck-canvas`).
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (replace the current `observeKeyResponder` effect in `TideCardBody` with `useOnCardActivated(cardId, () => entryDelegateRef.current?.focus())`).

**Work:**

a. **Create `card-lifecycle.ts`.** Export:
   - `CardActivationObserver = (cardId: string) => void`.
   - A `CardLifecycle` construct (plain class or module-scoped singleton accepting `store` + `manager` at construction / registration time) with:
     - `activateCard(cardId: string): void` — runs the four steps above, synchronously.
     - `observeCardActivation(cardId: string | null, cb): () => void` — stores the observer, fires initial-sync for the currently-active card if `cardId === null || cardId === store.focusedCardId`, returns unsubscribe.
     - `getActiveCardId(): string | null` — mirrors `store.focusedCardId` post-activation; reads directly from the store.
   - `useOnCardActivated` React hook that takes `cardId` + `callback`, resolves the lifecycle instance via existing context (likely a new `CardLifecycleContext` or export from `deck-manager`), and wires `observeCardActivation` through `useLayoutEffect` with stable deps.

b. **Wire activateCard into DeckManager.** `DeckManager` constructs / holds the lifecycle instance. `deck.activateCard` becomes a thin pass-through. `handleCardFocused`'s public export is removed (per [D8](#step-5-5)).

c. **Replace all call sites.**
   - `card-frame.handleFramePointerDown` → `deck.activateCard(id)` (or the imported `activateCard` directly; decision during step b).
   - `deck-canvas.CYCLE_CARD` — replace the three-line sequence (`handleCardFocused` + `setDeselected(false)` + `makeFirstResponder`) with `activateCard(nextId)`. `setDeselected(false)` either moves into `activateCard` or onto a separate observer.
   - `deck-canvas.SHOW_COMPONENT_GALLERY` — same three-line replacement.
   - `deck-canvas` initial-load effect — replace with `activateCard(focusedCardId)` when `initialFocusedCardId` is set.

d. **Migrate `selectionGuard`.** Replace its `useLayoutEffect`-driven activation (currently keyed on `focusedCardId` via `selectionGuard.activateCard`) with a subscription to `observeCardActivation(null, ...)`. Attach on `selectionGuard.attach()`, detach on cleanup.

e. **Replace tide card's observer effect.** In `TideCardBody`:
   ```tsx
   useOnCardActivated(cardId, () => {
     entryDelegateRef.current?.focus();
   });
   ```
   Delete the `observeKeyResponder` useLayoutEffect and the `useResponderChain()` call used solely for it.

f. **Test pass.** Units for `card-lifecycle` exercising the invariant (post-`activateCard`, all three state systems match), for `observeCardActivation` (fires on transition, initial-sync for current active card on subscribe, unsubscribe stops future calls), and for the wildcard form. Regression test that keyboard shortcut routing (existing Cmd+W, Ctrl+\`) still targets the active card post-migration.

**Verification:**
- `bun x tsc --noEmit` + `bun test` + `bun run audit:tokens lint` green.
- Unit test: after `activateCard("A")`, `store.focusedCardId === "A"`, `manager.getKeyCard() === "A"`, `selectionGuard.activeCardId === "A"`, observer registered for `"A"` has fired once with `"A"`, wildcard observer has fired with `"A"`.
- Unit test: subscribing after activation fires the callback synchronously on subscribe.
- Unit test: `activateCard("A")` twice in a row fires observers only on the first call (no-op on unchanged active card).
- Manual smoke: open tide card + gallery card. Click tide title bar → editor caret blinks. Click gallery title bar → focus leaves editor. Click tide title bar again → editor caret returns. Press Ctrl+\` to cycle → same behavior. Press Cmd+K from any chrome → caret lands in editor. Press Ctrl+K inside the editor → macOS deleteToEndOfLine runs (not swallowed).
- Manual smoke: typing into the editor works immediately after any activation path; no beeps.

**Risks:**
- **Subscription ordering.** If `selectionGuard` and `tide-card` both subscribe, their callbacks run in subscription order. If one throws, later subscribers may miss the event. Mitigation: wrap each callback dispatch in a try/catch that logs but keeps iterating.
- **Initial-sync firing for inactive cards.** `useOnCardActivated("card-A", ...)` on a card that isn't active at mount should NOT fire the callback. The `observeCardActivation` initial-sync rule: fire only if `cardId === null || cardId === store.focusedCardId`. Tests lock this.
- **Selection guard install timing.** `selectionGuard.attach()` runs inside `ResponderChainProvider`'s mount effect. If `card-lifecycle` is accessed there before its instance is constructed, we risk a null-ref. Mitigation: construct the lifecycle at the same time as the manager (or earlier), and document the install order.
- **Breadth of touch.** Six files change. No single file is large, but the cross-cutting nature raises review surface. Mitigation: land in a single atomic commit (or tight sequence) so no intermediate state has two call sites disagreeing on the activation contract.

---

> **Steps 5.5.a–5.5.c below absorb the follow-up work that grew out of Step 5.5 during implementation.** Step 5.5 unified card activation; the implementation pass produced a full App + Card lifecycle delegate subsystem (`card-lifecycle.ts`, `app-lifecycle.ts`, `lifecycle-cascade.ts`), a portal-based identity-preserving content pipeline (`CardHost` + `CardPortal` + `pane-content-registry` + `pane-root-registry`), and a two-table data model (`DeckState.cards` + `DeckState.panes`).
>
> Along the way four vocabulary / token / data-layer plans forked off and landed in `dash/archive/`: `tugplan-vocabulary-rename.md`, `tugplan-vocabulary-pane-rename.md`, `tugplan-tabstate-rename.md`, `tugplan-card-and-token-sweep.md`. The resulting vocabulary — `TugPane` (frame + chrome), `CardHost` (per-content bridge), `useCard*` hooks, `--tugx-pane-*` tokens, `.tug-pane-*` classes, `data-pane-id` / `data-card-id`, `cardstate/{cardId}` tugbank rows, v4 wire — is codified in `tuglaws/pane-model.md` (law **L25**).
>
> Steps 5.5.a–5.5.c tighten the seams that mid-implementation review surfaced but deferred: deprecated code that violates invariants, duplicated helpers, semantic inversions in the delegate layer, a god-component starting to form in `CardHost`, and missing safety-net tests. Landing these **before** Steps 6–23 keeps the tide-card feature work on a coherent foundation.

#### Step 5.5.a — Lifecycle & DeckManager tightening (audit follow-ups) {#step-5-5-a}

**Why this exists.** Step 5.5 shipped a working delegate layer; implementation review found a cluster of seams that are each small and each a future-bug attractor. This step bundles the high-urgency items: deprecated code that fires no lifecycle events, two helpers where one suffices, a semantic inversion the delegate layer doesn't document, and a handful of doc-only clarifications. None blocks the next tide-card step; any of them will quietly compound as more cards land on top of the same API.

**Files (high level):**
- `tugdeck/src/deck-manager.ts` — delete `applyLayout`; consolidate `_setFirstResponder` / `_flipFirstResponder`; evaluate `getActiveCardId` vs `getFirstResponderCardId`.
- `tugdeck/src/lib/card-lifecycle.ts`, `tugdeck/src/lib/app-lifecycle.ts` — JSDoc pass on `cardWill*` / `applicationWill*` methods describing the deferred-delivery semantic; add observer-vs-delegate guidance in the module header; document startup-drop behavior.
- `tugdeck/src/lib/delegate-drain.ts` (new) — shared `MessageChannel` drain queue consumed by both `useCardDelegate` and `useAppDelegate`; guarantees cross-module ordering.
- Call sites for `applyLayout`: currently `deck-manager.ts` (defn + 2 call sites), `layout-tree.ts`, `__tests__/deck-manager.test.ts`. Update tests to use the mutator API (`addCard`, `removeCard`, `setActiveCardInPane`) or the new diff-based replacement.

**Work:**

a. **Delete `applyLayout`** (audit L7 / P13). Fires no lifecycle events, violates the invariants every other mutator enforces, deprecated in JSDoc but still present. Replace each call site with explicit mutator calls. If a test truly needs wholesale state replacement, implement a minimal `replaceLayout(next)` that diffs and routes through `addCard` / `removeCard` / `_setFirstResponder` — not the free-form assignment the current version permits.

b. **Consolidate `_setFirstResponder` and `_flipFirstResponder`** (audit L4). The latter exists because some mutators need caller-provided commit closures; the former reads `oldFR` from current state and commits internally. The division invites wrong-snapshot bugs. Produce one `_flipFirstResponder(newFR, commitClosure)` helper that snapshots `oldFR` itself and delegates the commit — the mechanism that would catch a mistake (read current state) stays inside the helper.

c. **Consolidate `getActiveCardId` vs `getFirstResponderCardId`** (audit L3). Both are public; they diverge after detach/move. Pick one as canonical (the composite-bit reader `getFirstResponderCardId`) and either delete the other or rename it to something unambiguous (`getTopOfPaneCardId`). Internal call sites that still use `getActiveCardId` get updated to whichever survives. Tests update with them.

d. ~~**Share one drain queue** across `useCardDelegate` and `useAppDelegate` (audit L2).~~ **Withdrawn.** The audit framing was wrong and this work item is not going to happen.

   Background: `dash/lifecycle-delegate-reliability.md` §2.E (April 2026) deliberately chose "dedicated drain queue owned by each lifecycle module" as a *promoted variant* of the MessageChannel design, with reasons including: single ordering authority per module (no cross-hook interleaving surprises), per-module `try/catch` with known-event-name logging, and one-file retirement when the underlying mechanism is later swapped. The audit entry reopened that decision by re-framing non-interleaving as a speculative race ("cross-module ordering is not guaranteed … before any future app/card delegate pair exhibits it") without addressing the study's reasoning.

   On review, the study's position stands: the one real cross-module ordering case (app → card on app-lifecycle transitions) is handled explicitly in `lib/lifecycle-cascade.ts`, not through drain ordering; no concrete code path needs interleaved drain. A shared-drain attempt (commit `bc80ab74`) was implemented and then reverted (commit `054e8197`) once the contradiction with the reliability study was caught. No further work under this item.

e. **Document will-delegate semantic inversion** (audit L1). `useCardDelegate` / `useAppDelegate` subscribers run on the next MessageChannel drain — *after* the transition commits. Methods named `cardWillDeactivate` / `applicationWillResignActive` therefore run in a world where the transition has already happened. Add one JSDoc line to each `will*` delegate method on the `TugCardDelegate` / `TugAppDelegate` interfaces: "Delegate runs after the transition commits. Subscribe via `observeCard*` directly for synchronous pre-mutation semantics." Also add a short observer-vs-delegate decision rule at the top of `card-lifecycle.ts` (audit L6): synchronous observer for pre-mutation state or ordering with other synchronous observers; delegate hook for React-context-bound focus/DOM work that must survive gesture.

f. ~~**Document startup-event drop** (audit L8).~~ **Already done.** `app-lifecycle.ts`'s "Startup note (H9)" banner (lines 42–51) already carries equivalent language from the lifecycle-delegate-reliability study: "Control frames dispatched by the Swift host before registration are dropped on the floor [...] If a future use case ever requires a reliable 'fire once at app start' signal, that signal needs its own out-of-band delivery path — do not bolt it onto the app-lifecycle channel." The audit item was written against an older state of the banner; no edit required.

g. **Pin lifecycle-silent paths in JSDoc** (audit P10, P11): `setActiveCardInPane` on an inactive pane fires no lifecycle events; `_closePane` fires destruction in `cardIds` order. Add one JSDoc sentence on each.

h. **Portal mount-ordering note** (audit P4): add a paragraph to `card-portal.tsx`'s header: "Children render into a null host until the content-registry subscriber fires on the next commit; do not assume children are in the DOM on first render."

**Verification:**
- `bun x tsc --noEmit` + `bun test` + `bun run audit:tokens lint` all green.
- `rg "applyLayout" tugdeck/src` returns zero matches (only test file may retain if `replaceLayout` wasn't built; note the exception).
- `rg "_setFirstResponder|_flipFirstResponder" tugdeck/src` returns one name (whichever survived).
- `rg "getActiveCardId" tugdeck/src` returns zero matches (if deleted) or only the new unambiguous name.

**Risks:**
- `applyLayout` deletion may surface test fixtures that rely on its "jump to arbitrary state" semantics. Resolution: convert to the mutator chain; the conversion itself documents the intended state transition.
- Consolidating the two FR helpers risks a mistranslated call site. Mitigation: cover every caller with a targeted unit test before the refactor.

---

#### Step 5.5.b — Decompose `CardHost` into per-concern hooks {#step-5-5-b}

**Why this exists.** `CardHost` (`tugdeck/src/components/chrome/card-host.tsx`, 384 lines as of Step 5.5.a close) accreted every per-card concern: PropertyStore registration, persistence-callback registration, the `saveCurrentCardState` closure, a keyed save-callback `useLayoutEffect` into `DeckManager`, the dirty-bit + debounced auto-save timer, scroll + `selectionchange` listeners, the mount-time content-restore effect, a FeedStore subscription pipeline, the card-level responder scope, and the `CardPortal` wrapper. Each concern is reasonable in isolation; the file is the wiring harness *and* each concern's implementation. The next per-card concern (session metadata, cross-turn state, whatever the next tide feature needs) would land here by default, pushing it past the 500-line threshold where nobody wants to touch it.

Decomposing into per-concern hooks now — while the vocabulary is stable and `Tugcard*` → `Card*` renames have landed — gives each concern a testable surface and leaves `CardHost` as the wiring harness it should be.

**Audit of the work.** A scan of the current `CardHost`, `CardPortal`, the `tugways/hooks/` barrel, and the portal-sensitive tests (`card-identity-preservation.test.tsx`, `card-portal.test.tsx`, `tide-card.test.tsx`) produced these adjustments to the original item list:

- **Item (a)** `useCardPropertyStore`: **advisable, smaller than advertised.** The actual seam is `propertyStoreRef` + `registerPropertyStore` (≈9 lines at `card-host.tsx:102-108`) plus the `CardPropertyContext` import. The plan originally said "~30 lines" — it is closer to 10. Still worth shipping first as a low-risk warmup that proves the extraction pattern and the barrel-export plumbing.
- **Item (b)** `useCardPersistence`: confirmed already shipped at `tugdeck/src/components/tugways/use-card-persistence.tsx` (unchanged since `c856b7c1`). Skip.
- **Item (c)** `useCardDirtyState`: **advisable.** `autoSaveTimerRef` + `markDirty` (`card-host.tsx:152-161`). Couples through `saveCurrentCardStateRef`, so the hook signature must accept a stable save callback (ref, not closure). Land last per the plan's existing risk note.
- **Item (d)** `useCardContentRestore`: **advisable; largest block.** The restore effect plus pending-scroll/pending-selection refs (`card-host.tsx:192-253`). The `persistenceCallbacksRef` + `registerPersistenceCallbacks` pair stays in the harness; the hook consumes the ref by reference so the `CardPersistenceContext` provider slot does not move.
- **Item (e)** `useCardFeedStore`: **advisable.** Self-contained registration-driven pipeline (`card-host.tsx:255-298`). Lowest coupling of the four hooks — can land before (c) or (d) without churn.
- **Item (f)** `useCardSelectionAndScroll`: **fold into (c), do not ship as its own hook.** The scroll + `selectionchange` listeners (`card-host.tsx:163-189`) exist only to call `markDirty`. Splitting them from the dirty-state hook creates an artificial two-hook seam around one debounce timer and one shared `hostContentEl` dependency. Plan already hedged ("may fold"); commit to folding.
- **Item (g)** wiring-harness reduction: **target revised.** Original target was 120–150 lines. Realistic post-extraction arithmetic: module docstring with ordering paragraph (~42 lines), imports (~20), props interface (~15), two registry-lookup helpers (~26), and legitimate wiring in the component body (~130) sum to ~230 lines. Further reduction would require extracting the `saveCurrentCardState` closure, the persistence-callback registrar, or the responder — none of which appear in the Work items below. Final target: **~230 lines**, down from 384.
- **Item (h)** `CardPortal` teardown contract (audit P5): **reframe to investigate-then-document.** A re-read of the unmount chain — `TugPane` unmounts → `paneContentRegistry.unregister(paneId)` in its cleanup → `useSyncExternalStore` in `useHostContentElement` fires → the card's scroll/selectionchange `useEffect` re-runs with `hostContentEl=null` and cleans up listeners → `CardPortal`'s `useLayoutEffect` cleanup removes the slot — suggests the "effects running against detached DOM" window P5 warns about may already be closed by the `useSyncExternalStore` chain. First commit for this item is a **teardown-order investigation with a JSDoc-pinned contract** on `card-portal.tsx` and `pane-content-registry.ts`. Only add an `onHostGone(cb)` subscription if the investigation surfaces a reproducible race; otherwise land the guarantee as documentation.
- **Item (i)** `waitForPortal(paneId)` helper (audit P12): ~~**conditional on demand.**~~ **Withdrawn.** A post-implementation check of the test suite confirmed no adoption candidates exist. Commits 1–4's new hook tests use `renderHook` in isolation with no `TugPane` / `CardPortal` stack, so the content registry is never touched. The pre-existing portal-sensitive tests (`card-portal.test.tsx`, `card-identity-preservation.test.tsx`, `tide-card.test.tsx`) use synchronous `paneContentRegistry.getElement()` assertions with no ad-hoc waits. The other `await waitFor` sites in the suite (`tug-pane-banner`, `tide-card-last-error`, `tug-sheet`) wait on WAAPI exit-animation DOM removal, not on registry readiness. Shipping a helper with zero call sites would be dead code, so the work item is struck in the spirit of Step 5.5.a item (d).

**Files:**
- `tugdeck/src/components/tugways/hooks/use-card-property-store.ts` (new).
- `tugdeck/src/components/tugways/hooks/use-card-feed-store.ts` (new).
- `tugdeck/src/components/tugways/hooks/use-card-content-restore.ts` (new).
- `tugdeck/src/components/tugways/hooks/use-card-dirty-state.ts` (new — also owns the scroll + `selectionchange` listeners formerly item (f)).
- `tugdeck/src/components/tugways/hooks/index.ts` — barrel-export each new hook as they land.
- `tugdeck/src/components/chrome/card-host.tsx` — reduced to wiring: hooks called in a pinned order, header paragraph documenting that order, portal wrapper + context providers + responder scope.
- `tugdeck/src/components/chrome/card-portal.tsx` — teardown-contract JSDoc (audit P5). `onHostGone(cb)` added only if the investigation finds a reproducible race.
- `tugdeck/src/components/chrome/pane-content-registry.ts` — pinned contract sentence describing the unregister-before-React-unmount guarantee the teardown chain relies on.
- `tugdeck/src/__tests__/` — one test file per new hook, each exercising the hook in isolation via a minimal host.
- ~~`tugdeck/src/__tests__/wait-for-portal.ts`~~ — struck; item (g) withdrawn post-implementation (no adoption candidates).

**Work:**

a. **Extract `useCardPropertyStore`.** Smallest seam, first up. Signature: `useCardPropertyStore(): { register: (ps: PropertyStore) => void; ref: React.RefObject<PropertyStore | null> }`. Hook owns the ref and the `useCallback`-stable `register` fn; the harness consumes `ref.current` from the responder's `SET_PROPERTY` handler. No state leaves the hook. Barrel export.

b. **Extract `useCardFeedStore`.** Signature: `useCardFeedStore(hostStackId: string, feedIds: readonly number[]): Map<number, unknown>`. Hook owns the `FeedStore` ref, the workspace-key lookup, the `FeedStoreFilter` memo, the `useSyncExternalStore` subscription, and the dispose cleanup. Returns the `feedData` map the harness hands to `CardDataProvider`. Independent of dirty / restore, lands without touching the save-callback loop.

c. **Extract `useCardContentRestore`.** Signature: `useCardContentRestore(args: { cardId: string; hostStackId: string; hostContentEl: HTMLDivElement | null; persistenceCallbacksRef: React.RefObject<CardPersistenceCallbacks | null> })`. Hook runs the mount-time restore effect, manages the `pendingScrollRef` / `pendingSelectionRef` refs, and stamps the `onContentReady` hook on the callbacks object. The `persistenceCallbacksRef` + `registerPersistenceCallbacks` stay in the harness so `CardPersistenceContext` still provides a stable registrar. No behavior change.

d. **Extract `useCardDirtyState` (absorbs former item f).** Signature: `useCardDirtyState(args: { hostContentEl: HTMLDivElement | null; saveRef: React.RefObject<() => void> }): () => void`. Hook owns the debounce timer, the `markDirty` callback, the scroll listener, and the `selectionchange` listener. Returns the stable `markDirty` the harness hands to `CardDirtyContext`. Signature takes `saveRef` (not a closure) to prevent stale captures.

e. **Wiring-harness reduction + ordering header.** Call hooks in the pinned effect-order: harness `useLayoutEffect` (`registerSaveCallback`) → `useCardDirtyState` → `useCardContentRestore` → `useCardFeedStore`. (`useCardPropertyStore` is call-order-irrelevant for effects — it returns a ref + a stable register fn only; constraint is that it runs before the responder factory reads its ref.) This order matches the effect-execution order that was stable before the extraction. Add a header paragraph to `card-host.tsx` documenting the order and the rule that future hooks insert after `useCardFeedStore` unless they must run before content-restore. Delete dead imports. Realistic target: ~230 lines.

f. **`CardPortal` teardown contract (audit P5, reframed).** Investigate the unmount chain end-to-end (TugPane cleanup → `paneContentRegistry.unregister` → `useHostContentElement` re-fire → card effect cleanup → slot removal). Capture the guarantee as a JSDoc paragraph on `card-portal.tsx` and a matching contract line on `pane-content-registry.ts`. If the investigation finds a real race (listener fires on a detached element between registry-unregister and effect-cleanup), add `onHostGone(cb)` to the registry and subscribe the card's cleanup to it. If not, ship documentation only — and note in the commit message that the `onHostGone` option was considered and rejected.

g. ~~**`waitForPortal(paneId)` helper (audit P12, conditional).**~~ **Withdrawn.** Post-implementation check confirmed zero adoption candidates — neither the new per-hook tests (which use `renderHook` in isolation) nor the pre-existing portal-sensitive tests (which use synchronous `paneContentRegistry.getElement()` assertions) have an ad-hoc wait that the helper would replace. See the audit verdict above for the full rationale.

**Execution plan — one commit at a time.** Each commit green on `bun x tsc --noEmit` + `bun test` + `bun run audit:tokens lint`. Order chosen for risk: smallest independent seam first, tightest coupling last.

1. **Commit 1 — `useCardPropertyStore`.** Covers work item (a). New hook file, barrel entry, unit test that registers a PropertyStore via a minimal host and asserts the ref is populated. Harness diff is a ~10-line swap.

2. **Commit 2 — `useCardFeedStore`.** Covers work item (b). New hook file, barrel entry, unit test that boots the hook with a stub `FeedStore` (or the real one against a fake connection) and asserts the returned map reflects subscription updates. Harness diff removes ~45 lines.

3. **Commit 3 — `useCardContentRestore`.** Covers work item (c). New hook file, barrel entry, unit test that seeds `DeckManager.getCardState(cardId)` with a scroll + selection + content bag and asserts `onRestore`, `onContentReady`, and the `hidden → visible` scroll-unhide dance all run. Harness diff removes ~60 lines; the `persistenceCallbacksRef` + `registerPersistenceCallbacks` stay.

4. **Commit 4 — `useCardDirtyState` (+ absorbed scroll/selection).** Covers work items (d) and (f). New hook file, barrel entry, unit test that simulates scroll + selectionchange events and asserts `saveRef.current` is invoked after `AUTO_SAVE_DEBOUNCE_MS`. Harness diff removes ~40 lines. If the wiring tidy from work item (e) is small enough, fold it in here and skip commit 5.

5. **Commit 5 — Wiring-harness tidy + ordering header.** Covers work item (e). Header paragraph documenting hook call order, dead-import removal, final line-count check. Roll into commit 4 if diff < ~30 lines.

6. **Commit 6 — `CardPortal` teardown contract.** Covers work item (h, reframed). Teardown-chain investigation notes captured as JSDoc on `card-portal.tsx` + `pane-content-registry.ts`. Adds `onHostGone(cb)` only if the investigation surfaces a reproducible race; commit message is explicit about the decision either way.

7. ~~**Commit 7 (conditional) — `waitForPortal` helper.**~~ **Withdrawn post-implementation.** Commits 1–4's new hook tests did not need the helper (all use `renderHook` in isolation with no `TugPane` / `CardPortal`), and the pre-existing portal-sensitive tests continue to use synchronous `paneContentRegistry.getElement()` assertions. Item (g) struck in the audit; this commit slot is intentionally empty.

**Verification:**
- `bun x tsc --noEmit` + `bun test` + `bun run audit:tokens lint` all green after every commit — no chain-of-commits detours.
- After commit 5: `wc -l card-host.tsx` reports ~230 lines (down from 384).
- Each new hook has an isolated unit test. Test count grows by at least four.
- Existing integration tests (`tide-card.test.tsx`, `card-identity-preservation.test.tsx`, `card-portal.test.tsx`) pass unchanged — the decomposition is internal to `CardHost`.
- Commit 6 either documents the teardown-order guarantee as already-true (no behavior change) or ships `onHostGone` with a regression test for the race it fixes. Both outcomes are green.

**Risks:**
- **Extraction order.** Dirty-state is the tightest coupling because `saveCurrentCardStateRef` is written every render. Commit order (Property → Feed → Restore → Dirty) keeps that closure in the harness until the last extraction, so earlier hooks do not have to model a moving save callback.
- **React effect ordering between sibling hooks.** Every hook registers in `useLayoutEffect`; the order they are called in the harness is the order effects fire. The pinned order (Property → Feed → Restore → Dirty) matches the current effect order in `card-host.tsx`, so no observed behavior shifts. Commit 5's header paragraph locks this down so future additions do not silently reorder.
- **Stale closures.** Hooks that accidentally drop a dependency on `cardId` / `hostStackId` / `componentId` produce stale captures. Each hook signature takes these as explicit arguments (or accepts a ref) rather than reaching through context. The `saveRef` pattern in (d) is the canonical form for the few places that genuinely need "read-latest-on-fire" semantics.
- **P5 investigation outcome.** If commit 6's investigation surfaces a race, the fix (`onHostGone` + subscriber wiring) may outgrow the single-commit budget. Mitigation: land the investigation + documentation as one commit; land the `onHostGone` API + regression test as a follow-up commit inside Step 5.5.b rather than forcing it into commit 6.

---

#### Step 5.5.c — Invariants and safety-net tests {#step-5-5-c}

**Why this exists.** `validateDeckState` is the model: encode invariants in executable form, run in dev on every mutation, give clear errors on violation. The same pattern would catch an entire class of drift bug in the lifecycle / selection / save-callback layers that are currently only covered by happy-path tests. The tests the audit calls out are the ones most likely to fail silently when the next layer lands.

But safety-net tests aren't enough on their own. The post-5.5.b audit surfaced a **product-level regression** (clicking card content doesn't activate the host pane), a set of **carry-forward items** deferred from 5.5.b that shouldn't be deferred further, and — on re-examination — a set of **half-measures in the original 5.5.c draft** (a per-component workaround instead of a document-level design, a prose-documented contract where a type-level one is straightforward, a "may be flaky" hedge on timing-sensitive tests that should be eliminated rather than mitigated, structural asymmetries in `CardHost` that should be closed).

Step 5.5.c is rewritten to absorb all of this: **invariants + tests + the refinements that make the code actually excellent, not just "good enough to ship."**

**Click-to-activate regression — root cause and excellent fix.** For portaled card content, React's synthetic `onPointerDown` on the pane frame never fires. React's event system follows the React tree, not the DOM tree; `CardHost` lives at deck level (inside `DeckCanvas`), so events bubble through `DeckCanvas` and skip `TugPane`. The title-bar handler works because the title bar is rendered inside the pane frame's own React subtree (not portaled). The document-level `pointerdown` capture listener installed by `ResponderChainProvider` promotes the **responder chain's** first responder (a parallel system), and `selectionGuard.handlePointerDown` activates the **selection guard's** tracked card — neither touches `DeckManager`'s composite first-responder bit. Net effect: content clicks promote the responder chain but leave the pane visually inactive.

A per-`CardHost` `onPointerDown` handler would fix the symptom, but it's a workaround that scatters activation logic across every card host and leaves `handleFramePointerDown` as redundant-but-not-harmful code. The **excellent** fix is architectural: a single document-level capture-phase `pointerdown` listener that walks up from `event.target` looking for `data-pane-id`, calls `store.activateCard(pane.activeCardId)`, and replaces `handleFramePointerDown` entirely. This is the same pattern `ResponderChainProvider` already uses for first-responder promotion. One listener, uniform behavior for chrome and content, zero per-component coupling. The call is safe against nested responders — `_flipFirstResponder → setResponderChainKey` is guarded by `getKeyCard() === cardId`, so clicks into an inner editor promote the editor (via the existing responder-chain listener), activate the host pane (via the new listener), and the card-level `setResponderChainKey` sees the chain already pointing at the editor's ancestor card and no-ops.

**Persistence regression (Commit 1A — shipped 2026-04-22).** A user-visible regression surfaced 2026-04-22: text content, scroll, and selections were not preserved across app reload / relaunch. [L23] violation. The investigation and fix shipped as a four-commit series; a follow-on selection subsystem is tracked as its own plan — see [`tugplan-selection.md`](./tugplan-selection.md).

*Root cause.* `useCardContentRestore`'s `useLayoutEffect` fired once at mount with `hostContentEl=null` (pane-content-registry not yet populated) and `persistenceCallbacksRef.current=null` (child content component not yet registered), took the no-persistence branch, and was never re-fired because its deps `[cardId, hostStackId]` never changed when the prerequisites arrived. Critical, one-shot data motion was gated on React's reconciler happening to fire an effect at the right time.

*Rejected approach (Path A).* A `persistenceVersion` state counter bumped on non-null registration, expanded deps, ref-gated against double-restore. Rejected as "still fundamentally dep-array gated, just more layered" — same failure class as the bug, one layer of indirection further out. Reverted.

*Shipped commits.*

- **`819357aa` — Instrumentation.** Nine `[probe:*]` log points spanning save triggers → callback registration → save closure → cache → tugbank write → cold-boot read → restore application. One repro run (type marker, quit, relaunch) isolated the failing stage without a bisect.
- **`d70ee0d8` — Path B.** Trigger-driven restore: content restore fires imperatively inside `registerPersistenceCallbacks` (the child's own `useLayoutEffect` is the deterministic hand-off moment); scroll/selection restore in a `hostContentEl`-keyed `useLayoutEffect`. Delete `useCardContentRestore`, its test file, and all `[probe:*]` instrumentation. −351 lines net.
- **`07ec7df9` — Selection-ownership.** Content-case cards restore selection only via `onContentReady` (after the child re-renders with restored content, when `pathToNode` can resolve against a stable DOM); no-content cards via the `hostContentEl` effect. Removes a two-path conflict where both the pre-commit effect *and* `onContentReady` fought for selection ownership.
- **`8de575c4` — DOM-authority input persistence.** `TugInput` / `TugTextarea` accept a `persistKey` prop; set renders `data-tug-persist-value={persistKey}`. `CardHost` scopes its save/restore query to the card's own `[data-card-host][data-card-id]` subtree — sibling cards in one pane cannot cross-contaminate. `MutationObserver` on the card root catches late-mounting inputs; `WeakSet` guards prevent re-apply over user typing. `action-dispatch` subscribes `didBecomeActive` / `didUnhide` and re-applies `selectionGuard` selection for the focused card. Gallery inputs wired with hierarchical `persistKey` values as worked examples.

*What's preserved after `8de575c4`.*

- Scroll position — across reload, relaunch, hide/unhide, resign/activate.
- Text content in `TugPromptEntry` / `TugPromptInput` — across all four transitions.
- Text content in `TugInput` / `TugTextarea` (when opted in with `persistKey`) — across all four transitions.
- DOM selection in `TugPromptEntry` — across reload, relaunch, *first* resign/activate cycle.

*What remains broken after `8de575c4`.*

- DOM selection — across hide/unhide, and across the *second* resign/activate cycle (first works, second degrades).
- Form-control selection (`TugInput` / `TugTextarea`) — across every transition: the `selectionGuard`-based save path can't see `<input>.selectionStart`, so `bag.selection` is null, so `didBecomeActive` restore is a no-op. Even under reload, `setSelectionRange` on an unfocused element stores the range but paints no highlight.
- Focus — not tracked or restored by any subsystem.

These four failures trace to one concept gap: the code conflated DOM selection, form-control selection, and focus as if they were one thing. Each is a distinct browser concept with distinct save/restore semantics. The complete redesign — a unified `SelectionKeeper` subsystem with trigger-driven save/restore, skip-if-already-correct semantics, and explicit focus tracking — is the subject of [`tugplan-selection.md`](./tugplan-selection.md). That plan absorbs and supersedes the selection concerns from Commit 1A; Commit 1A is otherwise closed.

*Principle this surfaced (candidate tuglaws addition).* Any hook or effect that moves **critical, one-shot, user-data** across a reload boundary must be **trigger-driven (imperative at the hand-off moment), not React-dep-driven**. The other hooks in `CardHost` (`useCardPropertyStore`, `useCardFeedStore`, `useCardDirtyState`, the save-callback registration itself) pass this test — respectively because they have no effect, they are canonical `useSyncExternalStore`, their missed events cost only the dirty bit rather than the data, and they read refs at fire time. `useCardContentRestore` was the single hook that failed this test, which is why it was the single load-bearing regression.

**Half-measures the original 5.5.c draft accepted — now rejected.** The original draft hedged on four items; each is re-examined and replaced with the excellent path:

1. **`_flipFirstResponder`'s informal commit-closure contract.** The original plan: add a JSDoc hardening note because a type-level wrapper would be "clumsy." Rejected. The excellent fix is a cleaner API: split the `commit: () => void` closure into a pure state transform (`mutate: (prev: DeckState) => DeckState`) plus an optional side-effect callback (`onCommit?: () => void` — e.g., `putFocusedCardId`). `_flipFirstResponder` owns `this.deckState = mutate(...)`, `this.notify()`, and `this.scheduleSave()` directly. Callers can't forget to notify because they no longer have the opportunity to. Eight call sites updated. This isn't a wrapper-type hack — it's a simpler surface than what exists today.

2. **`CardHost` asymmetry and write-during-render.** The 5.5.b audit named two legitimate decompositions and defended keeping them inline with weak arguments. Rejected. The excellent fix: extract both as hooks symmetric with `useCardPropertyStore`:
   - `useCardPersistencePlumbing()` owns the `persistenceCallbacksRef` + `registerPersistenceCallbacks` pair. Returns `{ register, ref }` — same signature as `useCardPropertyStore`. The harness body shrinks; `useCardContentRestore` still receives the ref explicitly as an arg.
   - `useCardSaveState({ cardId, hostStackId, hostContentEl, persistenceCallbacksRef })` encapsulates the `saveCurrentCardStateRef` write-during-render pattern. The hook's module JSDoc pins *why* it's write-during-render (not `useCallback`) with a pointer to the composition test. The pattern's subtlety no longer leaks into the harness.

3. **Timing-sensitive tests "may be flaky, mitigate with await sequencing."** Rejected. A test that races with a real 1000ms timeout is broken. The excellent fix: bun's `setSystemTime` for fake timers, plus a new `DeckManager.invokeSaveCallbacksSync(cardId)` (or equivalent) if tests need a deterministic per-card flush. Deterministic or rewrite — no accepted flakiness.

4. **`pane-content-registry.notify()` iterates subscribers without `try`/`catch`.** If any subscriber throws, subsequent subscribers never run — leaving the portal slot attached to a doomed content element. Dormant today (no subscriber throws) but a correctness liability. The excellent fix: wrap each subscriber call in `try`/`catch`, log and continue. Plus a test that registers a throwing subscriber and asserts downstream subscribers still run. Small diff, real correctness win. Not in the original 5.5.c draft — added here.

**Audit of the original work items.** A read of the plan-as-originally-drafted against the post-5.5.b codebase, after the excellent-refinement absorption above:

- **Work item (a) validator extension** is the structural groundwork. Land it after the regression fix but before the test wave, so subsequent tests get informative failure messages if they trigger a drift.
- **Work item (b) non-focused pane activation test (audit P8)** is the direct end-to-end sibling of the regression fix. The per-component-handler version passes on a thin wrapper-level test; the document-level version enables a richer assertion — the activation event fires *before* the click handler on the target element (capture-phase ordering), same synthetic event, no stale-synthetic-event bugs. This is the test that pins `sortedStacks`' sort; if someone removes the sort, this test fails.
- **Work items (c)–(f)** are four cross-cutting tests with independent setup. Risk-order by timing sensitivity, but with fake timers in place, the "timing-sensitive" qualifier shrinks: all four become deterministic.
- **Audit P7 `registerSaveCallback(cardId, callback)` signature tightening** rides alongside `validateSaveCallbackKeys` in the validator commit — both are about making the save-callback keyspace match `deckState.cards`.

**Carry-forward from post-5.5.b audit.** The audit flagged five weaknesses; item #1 (latent L23 on restore) was resolved by fixup D (`f0f12f96`). The remaining four:

- **Item #2** — `_flipFirstResponder`'s informal closure contract. **Absorbed** into the `(mutate, onCommit)` refactor above. Type-level enforcement now; no JSDoc-only hedge.
- **Item #3** — no regression test for `_detachCard`'s single-notify-on-detach collapse. **Absorbed** into the refactor commit as part of updating `_detachCard`; the test pins that the refactor preserves the single-notify semantic.
- **Item #4** — historical tuglaws discipline was uneven. **Skip** — past-tense; forward discipline is captured in memory.
- **Item #5** — `saveCurrentCardStateRef`'s write-during-render pattern lacks inline JSDoc. **Absorbed** into the `useCardSaveState` extraction; the hook's module JSDoc is the new home for the write-during-render rationale.

**Follow-up items not integrated here.** Two candidates worth naming but not folded into 5.5.c, with honest reasons:

- **Branded `CardId` / `PaneId` types.** Would prevent pass-the-wrong-string bugs across the codebase. Scope: the `IDeckManagerStore` interface, every call site of every method taking a card or pane id, all tests. Not a hedge — this is a distinct refactor that deserves its own plan step. Raising explicitly so it's on the record; will revisit before the next step.
- **Replacing `handleFramePointerDown`'s remaining responsibilities with the document-level activation listener.** After Commit 1 removes `handleFramePointerDown`'s activation call, the handler's remaining body is empty. Commit 1 deletes it. This is in scope — noted here so the scope is explicit.

**Files:**

*New source files:*
- `tugdeck/src/components/tugways/hooks/use-card-persistence-plumbing.ts` (new) — host-side hook owning `persistenceCallbacksRef` + `registerPersistenceCallbacks`. Returns `{ register, ref }` symmetric with `useCardPropertyStore`.
- `tugdeck/src/components/tugways/hooks/use-card-save-state.ts` (new) — host-side hook encapsulating the `saveCurrentCardStateRef` write-during-render pattern. Returns the stable save ref.

*Modified source files:*
- `tugdeck/src/components/chrome/deck-canvas.tsx` (or a new `pane-activation-listener.ts` module near `ResponderChainProvider`) — install the document-level capture-phase `pointerdown` listener that walks up from target looking for `data-pane-id`, calls `store.activateCard(pane.activeCardId)`. Meta-key skip preserved.
- `tugdeck/src/components/chrome/tug-pane.tsx` — delete `handleFramePointerDown` and the `onPointerDown={handleFramePointerDown}` prop. Delete the now-unused `onStackActivated` prop from `TugPane` (and from its callers in `DeckCanvas`).
- `tugdeck/src/components/chrome/card-host.tsx` — swap the inline `persistenceCallbacksRef` + `registerPersistenceCallbacks` pair for `useCardPersistencePlumbing()`. Swap the inline `saveCurrentCardStateRef` setup for `useCardSaveState({ ... })`. Update the module JSDoc's hook-call-order section to reflect the new hooks.
- `tugdeck/src/deck-manager.ts` — refactor `_flipFirstResponder` signature to `(newFR, mutate, onCommit?)`. Refactor `_commitStandardFirstResponderFlip` into a pure state-transform `_commitStandardFirstResponderState(state, newFR)` and a side-effect `putFocusedCardId(newFR)` callback. Update all eight call sites (`activateCard`, `addCard`, `_closePane`, `addCardToPane`, `_removeCard`, `_detachCard`, `_moveCardToPane`, `_setActiveCardInPane`). Rename `registerSaveCallback(id, callback)` → `registerSaveCallback(cardId, callback)` (audit P7). Wire the three validators into dev-mode `notify()`.
- `tugdeck/src/lib/card-lifecycle.ts` — export `validateCardLifecycleState(cardLifecycle, deckState)` dev-only validator.
- `tugdeck/src/components/tugways/selection-guard.ts` — export `validateSelectionBoundaryMap(selectionGuard, deckState)` dev-only validator.
- `tugdeck/src/components/chrome/pane-content-registry.ts` — wrap each subscriber call in `notify()` with `try`/`catch`. Log and continue on throw.

*New test files:*
- `tugdeck/src/__tests__/pane-activation-listener.test.tsx` (new) — document-level activation listener. Tests: clicks on content, nested responders, interactive elements, meta-key skip, no double-activate, activation fires before click handler runs.
- `tugdeck/src/__tests__/non-focused-pane-activation.test.tsx` (new — audit P8) — richer assertion: click interactive element in non-focused pane, verify activation fires before click handler on same synthetic event. This is the test that pins `sortedStacks`'s sort.
- `tugdeck/src/__tests__/hmr-lifecycle-registration.test.ts` (new — audit L5).
- `tugdeck/src/__tests__/concurrent-move-destruction.test.ts` (new — cross-cutting; fake timers).
- `tugdeck/src/__tests__/portal-orphan-recovery.test.ts` (new — cross-cutting; fake timers).
- `tugdeck/src/__tests__/construction-event-order.test.ts` (new — cross-cutting).
- `tugdeck/src/__tests__/pane-content-registry.test.ts` (new or extend existing) — throwing-subscriber test for notify hardening.

*Modified test files:*
- `tugdeck/src/__tests__/card-host-composition.test.tsx` — retarget the (future) click-activates-pane assertion to hit the document-level listener path. Add cases for nested responder + meta-skip.
- `tugdeck/src/__tests__/use-card-property-store.test.tsx` — template for `use-card-persistence-plumbing.test.tsx` and `use-card-save-state.test.tsx` (both new).
- `tugdeck/src/__tests__/deck-manager.test.ts` — update callers for the `_flipFirstResponder` signature refactor; add a targeted single-notify-on-detach test (carry-forward #3, now absorbed into the refactor commit).

**Work:**

a. **Document-level pane activation listener.** Install a capture-phase `pointerdown` listener that walks up from `event.target` looking for `data-pane-id`, resolves the pane's `activeCardId`, and calls `store.activateCard(activeCardId)`. Skips on `event.metaKey` (preserves existing Mac-modifier convention). Delete `handleFramePointerDown` and the `onStackActivated` prop from `TugPane`. Delete the `handleStackActivate` in `DeckCanvas` and the corresponding prop. Test: document-level listener covers content, nested responders, chrome, meta-skip, no double-activate.

b. **Non-focused pane activation test (audit P8).** Render two panes; click an interactive element (button, checkbox) in the non-focused pane. Assert: (i) activation fires on `pointerdown` (capture phase) before the click handler runs, (ii) click handler runs on the same event, (iii) after the click, the non-focused pane is now focused. This pins `sortedStacks`'s sort plus the capture-phase ordering invariant.

c. **Validator extension + audit P7 signature tightening.**
   - `validateCardLifecycleState`: set of ids in `CardLifecycle.constructedCards` must equal `deckState.cards` ids. Throw `CardLifecycleInvariantError` naming the drift on mismatch.
   - `validateSelectionBoundaryMap`: keys in `selectionGuard.boundaries` must be a subset of `deckState.cards.map(c => c.id)`.
   - `validateSaveCallbackKeys`: keys in `saveCallbacks` must be a subset of live `cardId`s.
   - All three wired into `DeckManager.notify()` inside the existing `isDevEnv()` guard, alongside `validateDeckState`.
   - Rename `registerSaveCallback(id, callback)` → `registerSaveCallback(cardId, callback)`; update JSDoc to state "must be a cardId".

d. **HMR re-registration test (audit L5).** Construct `DeckManager` → `destroy()` → construct again. Install cascade subscribers on gen 2. Fire a cascade event. Assert only gen-2 subscribers received it.

e. **Concurrent move + destruction test (fake-timer deterministic).** Drag card A from pane P1 to pane P2 while closing P2 mid-drag. Uses `setSystemTime` / equivalent for any timer-based assertions. Expected: graceful rejection of one operation, no invariant violation. Validators from commit (c) stay green through the race.

f. **Portal orphan recovery test (fake-timer deterministic).** Close the host pane while the card's dirty-bit debounce is armed. Fake-advance time past the debounce threshold. Assert no exception, no duplicate save, no stale listener. Exercises the `CardPortal` teardown contract.

g. **Construction event order on loaded layout.** Mount with a pre-populated 5-card / 3-pane layout via tugbank rows. Assert 5 `cardDidFinishConstruction` events fire in `deckState.cards` array order before the React root commits visible content.

h. **`_flipFirstResponder` refactor to pure-mutator + side-effect callback.** Signature change: `_flipFirstResponder(newFR, mutate: (prev: DeckState) => DeckState, onCommit?: () => void)`. Helper owns state assignment, `notify()`, `scheduleSave()`. Lifecycle events bracket the commit as today. Decompose `_commitStandardFirstResponderFlip` into `_commitStandardFirstResponderState(state, newFR)` (pure) + `putFocusedCardId(newFR)` (side effect). Update all eight call sites. Add a targeted single-notify-on-detach test (audit carry-forward #3) pinning the 5.5.a semantic through the refactor.

i. **Extract `useCardPersistencePlumbing`.** Host-side hook, symmetric with `useCardPropertyStore`. Returns `{ register, ref }`. Harness swaps the inline pair. Barrel export. Unit tests template from `use-card-property-store.test.tsx`.

j. **Extract `useCardSaveState`.** Host-side hook encapsulating the `saveCurrentCardStateRef` write-during-render. Signature: `useCardSaveState({ cardId, hostStackId, hostContentEl, persistenceCallbacksRef }): React.RefObject<() => void>`. Module JSDoc explains *why* write-during-render (not `useCallback`) with a pointer to `card-host-composition.test.tsx`'s every-render-rewrite test (absorbs audit carry-forward #5). Unit test pins the rewrite behavior in isolation.

k. **`pane-content-registry.notify()` hardening.** Wrap each subscriber call in `try`/`catch`; log and continue on throw. Test: register a throwing subscriber alongside a benign one; fire `notify()`; assert the benign subscriber still ran and the error was logged.

l. **Persistence regression — shipped.** See the "Persistence regression (Commit 1A — shipped 2026-04-22)" section above for the shipped commit series (`819357aa`, `d70ee0d8`, `07ec7df9`, `8de575c4`) and the selection follow-on plan in [`tugplan-selection.md`](./tugplan-selection.md).

**Execution plan — eleven commits.** Each commit green on `bun x tsc --noEmit` + `bun test` + `bun run audit:tokens lint`. Tuglaws cross-checked before each. Risk-ordered: regression fix and document-level architectural win first, structural groundwork second, deterministic tests middle, deep refactors later, polish last.

1. **Commit 1 — Document-level pane activation listener; delete `handleFramePointerDown`.** Covers work item (a). Install the capture-phase listener. Delete the now-redundant frame handler and `onStackActivated` prop. Test wave hits content, nested responders, chrome, meta-skip, no-double-activate. Upholds **L11** (pane activation is a chain-mediated dispatch; the listener is the emitter, DeckManager owns the state), **L23** (pane activation is user-observable state — preserving it across clicks is the contract). **Shipped `5c178f46`** — together with Commit 0 (`df004681`) and follow-up Commit 1b (`f2de80c6`, install `ResponderChainProvider` listeners in `useLayoutEffect`).

1A. **Commit 1A — Persistence regression. Shipped as four-commit series `819357aa` / `d70ee0d8` / `07ec7df9` / `8de575c4`.** See the "Persistence regression (Commit 1A — shipped 2026-04-22)" section above for details. Selection follow-on is its own plan: [`tugplan-selection.md`](./tugplan-selection.md).

2. **Commit 2 — Validator extension + audit P7 signature tightening.** Covers work item (c). Three validators exported; all three wired into `DeckManager.notify()` under `isDevEnv()`. Rename `registerSaveCallback` param. Unit tests drift-trigger each validator. Upholds **L03** (validators run at commit boundary — same point `validateDeckState` runs).

3. **Commit 3 — P8 stable-render-order / non-focused pane activation test.** Covers work item (b). Pins the end-to-end chain: click interactive element in non-focused pane → capture-phase activation → click handler runs on same synthetic event → pane is now focused. Test file: `non-focused-pane-activation.test.tsx`. Upholds **L11, L23**.

4. **Commit 4 — HMR re-registration test (audit L5).** Covers work item (d). Independent of the rest; lands here for bisect clarity. Upholds **L03**.

5. **Commit 5 — `pane-content-registry.notify()` hardening.** Covers work item (k). Per-subscriber `try`/`catch` + throwing-subscriber test. Small commit; lands before the portal-orphan test that relies on the teardown chain. Upholds **L23** (teardown invariants survive subscriber failures).

6. **Commit 6 — Concurrent move + destruction test (fake timers).** Covers work item (e). `setSystemTime`-driven determinism. Validators from commit 2 stay green through the race. Upholds **L23**.

7. **Commit 7 — Portal orphan recovery test (fake timers).** Covers work item (f). Fake-advance past debounce, assert no exception / duplicate save / stale listener. Exercises the hardened teardown chain (commits 5 and earlier `8ada5f36`). Upholds **L23**.

8. **Commit 8 — Construction event order on loaded layout.** Covers work item (g). Cold mount with pre-populated 5-card / 3-pane layout. Assert 5 events fire in array order before React root commits visible content. Upholds **L03**.

9. **Commit 9 — `_flipFirstResponder` refactor to `(mutate, onCommit?)`.** Covers work item (h). Signature change; eight call sites updated; `_commitStandardFirstResponderFlip` decomposed into pure state transform + side effect; single-notify-on-detach regression test (absorbs carry-forward #3). Biggest commit of the wave — deep refactor, type-level invariant win. Upholds **L23** (lifecycle + notify ordering preserved), and the refactor itself pins the invariant the commit-closure contract used to document informally.

10. **Commit 10 — Extract `useCardPersistencePlumbing`.** Covers work item (i). Host-side hook symmetric with `useCardPropertyStore`. Harness swap. Barrel export. Unit tests. Upholds **L07** (ref-at-read-time still honored by the hook's pattern).

11. **Commit 11 — Extract `useCardSaveState`.** Covers work item (j). Encapsulates write-during-render behind a named hook; module JSDoc hosts the why-not-useCallback rationale (absorbs carry-forward #5); unit test pins the rewrite behavior in isolation. Last commit — lands after the architectural refactor in commit 9 is stable so the save state's contract is crisp. Upholds **L07**.

**Verification:**
- `bun x tsc --noEmit` + `bun test` + `bun run audit:tokens lint` all green after every commit — no chain-of-commits detours.
- All new tests pass: pane-activation-listener (content / nested / chrome / meta-skip / no-double-activate), three validator-drift tests, P8 stable-render-order, HMR, pane-content-registry throwing-subscriber, concurrent move + destruction, portal-orphan-recovery, construction-event-order, single-notify-on-detach, use-card-persistence-plumbing, use-card-save-state.
- Dev-mode validators run on every `notify()` without noticeable slowdown on the test suite (if validators add > 100ms to test-run time, make them opt-in per test file via a flag).
- Production build does not include validator call sites — gate on `import.meta.env?.DEV`.
- After commit 1: manual verification in dev server that clicking card content in a non-active pane visibly activates the pane (title bar focus ring moves, z-order bumps).
- After commit 9: `git grep` confirms zero remaining callers pass a `commit: () => void` closure to `_flipFirstResponder`. All eight call sites use `(mutate, onCommit?)`.
- After commit 11: `wc -l card-host.tsx` reports a further reduction from the 5.5.b-close figure of 246 lines. Target: ≤ 200 lines after the two hook extractions.

**Risks:**
- **Commit 1 is a product behavior change with broad reach** — clicks on every interactive surface now route through `store.activateCard`. Components that assume content clicks don't activate could behave differently. Mitigation: test wave covers the click-target taxonomy (content, nested responders, interactive elements, chrome, meta-skip); manual dev-server verification across tide / gallery / debug cards; confirm every existing test passes without modification.
- **A validator that throws during a legitimate intermediate state** (mid-mutation invariants temporarily violated) would break more than it catches. Mitigation: validators run at the same point `validateDeckState` runs (inside `notify()` guard, after the commit). Same contract.
- **Commit 9's refactor touches eight `DeckManager` call sites.** A miscalibrated `mutate` or `onCommit` decomposition for any one caller could silently change observable semantics (e.g., `putFocusedCardId` ordering vs `notify`). Mitigation: preserve exact ordering — `onCommit` fires after `mutate` sets the new state but *before* `notify()`, matching the current `_commitStandardFirstResponderFlip` ordering where `putFocusedCardId` precedes `notify`. Every call site gets a targeted test; the single-notify-on-detach test is the clearest regression pin.
- **Commits 6 and 7 still require correct fake-timer setup.** `setSystemTime` doesn't advance pending `Promise` microtasks; explicit `await Promise.resolve()` pumps may be needed between timer advances. Mitigation: if the test needs any real-time behavior, it's rewritten — not accepted as flaky.
- **Commit 10 and 11's hook extractions could accidentally drop the closure dependencies they currently work through** (especially `useCardSaveState`'s five-argument shape). Mitigation: each extraction ships with its own isolated unit test; the `card-host-composition.test.tsx` invariant tests from 5.5.b continue to pass unchanged — that's the composition-level cross-check.

**What excellence does NOT look like here.**
- **Branded `CardId` / `PaneId` types** are a separate refactor worth doing; not integrated into 5.5.c because they touch the `IDeckManagerStore` interface and every call site in the codebase. Raising explicitly so it's on the record; will revisit before the next step lands.
- **Removing the layout-dependent `handleCanvasPointerDown` deselect logic** is out of scope — its purpose (background-click deselect visual feedback) is distinct from pane activation and remains valid.

---

#### Step 6 — Cmd+J scrolls to the selected history entry (or bottom) {#step-6}

**Status: Merged into [Step 11](#step-11) (2026-04-29 rejoin).** The original split — keybinding here, transcript rendering in Step 11 — left this step's "scroll to a transcript region" branch as a no-op until Step 11 landed, with no test the keybinding could meaningfully exercise on its own. Folding the Cmd+J handler into Step 11 lets the keybinding ship next to the transcript it scrolls. The Cmd+J behavior described below is preserved verbatim inside Step 11's Work section; the original text is retained here only as historical context.

**Original Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (Cmd+J handler).
- `tugdeck/src/components/tugways/tug-prompt-entry.tsx` (expose currently-selected history entry's index/key on the delegate, if not already exposed).
- `tugdeck/src/components/tugways/cards/tide-card.css` (scroll target styles if needed).

**Original Work:**
- Extend `TugPromptEntryDelegate` (now `TugTextEditorDelegate` post-Step-15-of-text-editing-base) to expose the currently-selected history entry's identifier (e.g., `getSelectedHistoryEntryId(): string | null`) — `null` when no history navigation is active.
- Add a card-level Cmd+J keydown handler:
  1. Read the entry id from the delegate.
  2. If non-null and a corresponding rendered region exists in the transcript view, scroll that region into view (`scrollIntoView({ block: "center" })` or the equivalent imperative on `TugMarkdownView` if exposed).
  3. If null or no matching region, scroll the transcript to the bottom (mirror End / Cmd+Down behavior — call the same scroll-to-bottom path the streaming view uses on `turn_complete`).
- Cmd+J fires regardless of which element holds focus inside the card (chrome, prompt input, transcript) — the card-level handler claims the chord.

See [Step 11](#step-11) for the consolidated work and verification.

#### Step 7 — Atoms render cleanly at tighter line-heights {#step-7}

**Status: Done.** The atom rendering pipeline (`tug-atom-img.ts` / `tug-atom-fonts.ts`) was reworked during the `tug-text-editor` migration so atoms size their bounding box to the editor's resolved leading. Tighter line-heights are exposed through the editor-settings sheet's Line popup (1.2 / 1.3 / 1.4 / 1.5 / 1.7 / 2.0 — see `EditorSettingsStore.LINE_HEIGHT_OPTIONS`), and the `Spacing` popup tunes letter-spacing on top of them without baseline jump. The original Files / Work / Verification block below is retained as historical context.

**Original Files:**
- `tugdeck/src/lib/tug-text-engine.ts` (atom layout constraints, if that's where the line-height baseline math lives).
- `tugdeck/src/components/tugways/tug-prompt-entry.css` (atom CSS — vertical-align / line-height interaction).
- `tugdeck/src/lib/tug-atom-img.ts` or `tugdeck/src/lib/tug-atom-fonts.ts` (atom rendering pipeline; whichever owns the metrics).

**Original Work:**
- Investigation first: bisect the 1.7 minimum. Identify whether the jump is caused by atom intrinsic height exceeding the line box at lower leading values, or by the SVG-rendered atom's vertical-align baseline computation, or by both.
- Fix the metrics so atoms participate correctly in the line box at the editor's actual `lineHeight`.
- Decide and document a minimum supported line-height (target: 1.2). Below that minimum, the editor still lays out correctly; the jump-on-insert must be gone for any value at or above the documented minimum.
- Update `EditorSettingsStore`'s `LINE_HEIGHT_OPTIONS` if the available choices need adjusting.

#### Step 7.5 — Connection health checking and reconnect-aware tide cards {#step-7-5}

**Status: Promoted to its own plan on 2026-04-30.** This step was extracted into [tugplan-tide-connection-health.md](./tugplan-tide-connection-health.md). Follow that plan; the original sketch below is preserved verbatim only as historical context for the extraction. The executable work — design decisions, execution steps, verification — lives in the new plan.

<details>
<summary>Original sketch (historical, superseded by tugplan-tide-connection-health.md)</summary>

**Why this exists.** Two coupled defects surfaced in real use:

1. **Tide cards have trouble reconnecting on relaunch.** When the WebSocket comes back up after a tugcast restart, tide cards stay unbound. Submitting a command spins forever, with no visible signal that anything is wrong.
2. **Connection failures are not always detected.** `pkill -x tugcast` does not reliably surface a banner. The app sometimes reconnects on its own, but every existing tide card is broken without showing it.

The investigation traced this to three coupled root causes:

- **`restoreTideSessions` runs once at startup, never on reconnect.** `tugdeck/src/main.tsx:228` calls it once after `tugbankClient.ready()`. There is no companion `connection.onOpen(...)` for subsequent opens. After a tugcast restart, the server's `rebind_from_tugbank` rebuilds ledger entries from `dev.tugtool.tide.session-keys`, but the client never re-asserts them with `spawn_session(mode=resume)`. The bindings the client holds in `cardSessionBindingStore` no longer correspond to anything live on the new server's side, and frame routing fails silently.

- **The client has no heartbeat watchdog.** The server has one (`tugcast/src/router.rs`, `HEARTBEAT_TIMEOUT = 45s`). The client only *sends* heartbeats; it never validates that the server's heartbeats are arriving. If TCP goes half-open (process hung, OS sleep, broken proxy), the WebSocket's `onclose` may not fire for hours — until OS-level keepalive expires.

- **The transport-state / per-card lifecycle is incomplete.** `code-session-store` subscribes to `connection.onClose` and dispatches `transport_close`, but the reducer drops it silently for `idle` cards (`reducer.ts:737`). There is no companion `transport_open` event to recover. The banner has its own 2 s show-debounce (`tug-banner-bridge.tsx:22`) that often elapses *after* a quick reconnect, so brief outages flash invisibly. `code-session-store.ts:155-158` already wires the `onClose` subscription, but no symmetric `onOpen` handler dispatches a recovery event.

**Design — a transport-state lifecycle.** Per-card stores need a transport-aware state distinct from the per-session phase machine. Today there is `idle` / `submitting` / `streaming` / `tool_work` / `awaiting_approval` / `errored` — all session-phase states. We add a complementary, orthogonal *transport state*: `online` / `offline` / `restoring`.

- A card in `idle / online` is ready to submit.
- A card in `idle / restoring` shows the `TideRestoring` placeholder; submits are gated.
- A card in `idle / offline` gates the submit button and the banner is visible.

This decoupling matters because phase is about *turn lifecycle* (interrupting, queuing, errored from the wire's perspective). Conflating "we lost the wire" with "your turn errored" produces bad UX during reconnects: cards say "errored" when nothing was submitted; cards refuse retry when the wire is back.

**Files (high level):**
- `tugdeck/src/connection.ts` — heartbeat watchdog; clear `lastPayload` cache on close; expose a stable `onOpen` registration that fires for *every* open (not just the first).
- `tugdeck/src/main.tsx` — register `connection.onOpen` to clear `cardSessionBindingStore` and re-run `restoreTideSessions` after the first open.
- `tugdeck/src/lib/tide-session-restore.ts` — make the restore path idempotent across multiple invocations; expose a `clearAllRestoreState()` helper (or fold the clear into `restoreTideSessions` itself with a `{ reason: "reconnect" }` flag).
- `tugdeck/src/lib/card-session-binding-store.ts` — add `clearAll()` that emits a single notify.
- `tugdeck/src/lib/code-session-store/events.ts` and `reducer.ts` — add a `transport_open` event; rework `transport_close` to set a transport-state field rather than (or in addition to) flipping the phase.
- `tugdeck/src/lib/code-session-store.ts` — subscribe to `connection.onOpen` alongside `onClose`; dispatch `transport_open` on the second-and-subsequent opens.
- `tugdeck/src/components/chrome/tug-banner-bridge.tsx` — drop or shorten `SHOW_DELAY_MS` for the connection-lost path; introduce a transient "Reconnected" affordance after a visible disconnect; surface "Restoring sessions…" while any card is `restoring`.
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (or `tide-card-content.tsx`) — read transport state from the per-card snapshot; render `TideRestoring` when `transportState === "restoring"`; gate `canSubmit` while `transportState !== "online"`.

**Work:**

a. **Make `restoreTideSessions` reconnect-aware.** Wrap the body in a function that can be called multiple times safely. In `main.tsx`, install `connection.onOpen(() => { … })` that, on every open *after* the first, clears `cardSessionBindingStore` and re-runs `restoreTideSessions`. Bindings without a live server peer are worse than no bindings — the clear-then-restore order is intentional. This single change resolves the "submit spins forever after tugcast restart" symptom on its own.

b. **Add a client-side heartbeat watchdog.** In `TugConnection`, track `lastFrameAt: number` and bump it on every `onmessage` (any frame, including the binary HEARTBEAT). Start a watchdog timer (every 5 s) that calls `ws.close()` if `Date.now() - lastFrameAt > HEARTBEAT_TIMEOUT_MS` (45 s, mirroring `HEARTBEAT_TIMEOUT` in `router.rs`). The close path already triggers reconnect with backoff. This catches the half-open TCP case where the WebSocket would otherwise sit silently.

c. **Clear `lastPayload` on close.** `TugConnection.lastPayload` is the "replay snapshot to late subscribers" cache. After a close, the next open's snapshot frames will repopulate it; the cached frames from before the close are no longer authoritative. Clear on `onclose` to prevent late subscribers from ever seeing a stale post-reconnect snapshot.

d. **Add transport-state to the per-card store.** New field on `CodeSessionState`:
   ```ts
   transportState: "online" | "offline" | "restoring";
   ```
   `transport_close` event sets `transportState = "offline"` regardless of phase (do not silently drop for `idle`). A new `transport_open` event sets `transportState = "restoring"` (we just opened, but the spawn_session(resume) ack hasn't arrived). When the binding for this card lands in `cardSessionBindingStore`, dispatch `transport_settled` (or piggyback on the existing binding-arrival path) which sets `transportState = "online"`.

e. **Wire `transport_open` from the connection.** In `code-session-store`'s constructor, subscribe to both `connection.onOpen` and `connection.onClose`. The first `onOpen` (initial connect) doesn't dispatch — that's the normal mount path. Subsequent opens dispatch `transport_open`, which moves the card to `restoring`. The follow-up binding-arrival path (already subscribed in `tide-session-restore`) flips it back to `online`.

f. **Surface transport state in the snapshot and gate the UI.**
   - Snapshot exposes `transportState`. `canSubmit` becomes `phase ∈ {idle, errored} && transportState === "online"`.
   - `TideCardContent` checks `transportState === "restoring"` (in addition to the existing `tideRestoreRegistry` check) and renders `TideRestoring`.
   - The submit button disables (with a tooltip / status-row note) while `transportState !== "online"`.

g. **Banner UX tightening.**
   - Drop or significantly shorten `SHOW_DELAY_MS` for the disconnect path so brief failures don't go invisible.
   - On reconnect, briefly (≤ 1.5 s) show a "Reconnected" affordance with a positive tone before fading.
   - When any card is in `transportState === "restoring"`, show a status-line "Restoring sessions…" until the spawn_session(resume) acks land.

**Verification:**
- `bun x tsc --noEmit` + `bun test` + `bun run audit:tokens lint` green.
- Unit test: simulate `connection.onOpen` after a close → assert `restoreTideSessions` is called again, with bindings cleared first.
- Unit test: simulate 50 s with no incoming frame → assert the watchdog calls `ws.close()`.
- Unit test: feed `transport_close` then `transport_open` to a `code-session-store`; assert `transportState` transitions through `online → offline → restoring`, and `canSubmit` follows.
- Unit test: `lastPayload` is empty after `onclose`; the next `onFrame` registration after a reconnect does not deliver pre-close frames.
- Manual: open a Tide card, submit `> hi` and let it stream. `pkill -x tugcast`. Wait. The banner appears within ~1 s; the card flips into the restoring state. When tugcast respawns and reconnects, the card flips back through `restoring` → `online` and submitting works again without a page reload.
- Manual: open a Tide card, sleep the laptop for ~2 minutes, wake. The watchdog detects the silent half-open path within ~45 s of wake, force-reconnects, and the card recovers.
- Manual: kill tugcast and immediately restart it (faster than the historical 2 s show-debounce). The banner still shows briefly; cards still flip through `restoring`; submit works again.

**Risks:**
- **Transport-state introduces a new dimension to test.** Every existing per-phase test now has an implicit `transportState === "online"` premise. Mitigation: the field's default is `online`; tests that don't dispatch transport events stay green; explicit `transport_close` / `transport_open` tests cover the new dimension.
- **The watchdog could mis-fire under legitimate idle wires.** If the server's heartbeat interval drifts past 45 s, the client closes the connection unnecessarily. Mitigation: the threshold is the same 45 s the server already uses to time *us* out, so any drift past 45 s is already a real problem. The watchdog is a defensive copy of the server's contract, not a new constraint.
- **Reconnect can stack restores.** If `connection.onOpen` fires twice quickly (flaky network), two `restoreTideSessions` runs could collide. Mitigation: `restoreTideSessions` is already idempotent (it clears any in-flight expectation and re-arms via `tideRestoreRegistry._clear` then `_register`); the binding-clear before each run keeps the picture clean; the per-card 10 s timeout protects against stuck restores.
- **`lastPayload` cache clear could lose a snapshot frame.** If a snapshot arrives just before the close, clearing on close discards it. Mitigation: the snapshot path is server-authoritative — the post-reconnect handshake replays whatever the server holds. There is no client-authoritative state here that needs preserving across the close.
- **Banner UX change is subjective.** "Reconnected" affordances can feel noisy. Mitigation: keep the affordance brief (≤ 1.5 s) and only on explicit recovery from a *visible* disconnect — not on the silent-watchdog path, because that recovers without ever having shown a banner.

**Open questions:**
- Should the watchdog timeout match the server's 45 s, or be slightly longer (e.g., 50 s) to absorb clock-skew between client and server tickers? Starting preference: 45 s with an explicit comment that the value mirrors `HEARTBEAT_TIMEOUT` in `router.rs`.
- Should the per-card `transportState` be folded into a single `phase` enum (adding `transport_lost` and `restoring` as phase values) or stay as a separate field? Starting preference: separate field. Phase is about turn lifecycle; transport is about wire health; they are orthogonal axes and conflating them will leak across tests.
- Should the server post-handshake actively push a `client_recognized { sessions: [...] }` frame so the client doesn't have to ask? Defense in depth. Starting preference: defer to a follow-up after Step 7.5 lands; the client-driven re-restore is sufficient on its own, and the server-push path is a larger architectural change.

**Tuglaws to cross-check:**
- **L02** — `transportState` enters React via the existing `code-session-store` `useSyncExternalStore` path; no parallel React state.
- **L03** — `connection.onOpen` / `connection.onClose` registrations live in `useLayoutEffect` (or in module scope before any React render, as today's connection wiring already does).
- **L11** — `transport_close` / `transport_open` are dispatched events on the per-card store; the connection layer is the emitter, the store reducer owns the state transitions.
- **L23** — Reconnect must not lose user-visible state. The transcript already accumulated in the store stays; only `transportState` flips. The submit button gating is purely additive — no in-flight content is discarded.

</details>

#### Step 8 — Canvas-level overlays: popups escape the card, constrained only by the canvas {#step-8}

**Status: Done.** The work originally sketched here grew into three subordinate plans, each replacing or extending the last as the design settled. Deep technical detail lives in those plans; this step is now a marker pointing to them:

1. [tugplan-tide-overlay-tier.md](./archive/tugplan-tide-overlay-tier.md) — landed 2026-04-30. Introduced `<CanvasOverlayRoot />`, the `useCanvasOverlay` portal hook, and the `--tug-z-overlay-*` token tier. Migrated the file-completion popup off the editor host onto the canvas overlay tier so it escapes the card frame.

2. [tugplan-tide-popup-bindings.md](./archive/tugplan-tide-popup-bindings.md) — generalized the canvas overlay tier to every popup-class primitive (Radix popovers, popup menus, context menus, tooltips, sheets) and closed the long-standing gap between `manager.makeFirstResponder(id)` (chain-state only) and DOM focus. Added `ResponderManager.focusResponder(id)` plus two binding hooks: `useCompanionPopupBinding` (popups that live only while their owner is first responder) and `useServicePopupBinding` (popups that take focus while open and restore the prior responder on close).

3. [tugplan-tide-overlay-framework.md](./archive/tugplan-tide-overlay-framework.md) — completed 2026-05-02. Disambiguated the overloaded `data-tug-focus="refuse"` attribute into per-concern markers, gave `useTugSheet` an explicit close-cascade target API, and documented the responder-chain / portal / focus / pane-controller mental model in one place. Resolved the picker cancel-cascade bug surfaced during popup-bindings Step 2.

The original 2026-04-19 sketch (cap popup height to card, open upward when tight) and the 2026-04-30 replan (single-plan canvas overlay tier) are both superseded by the trio above.

#### Step 9 — Participant model + `TugTranscriptEntry` primitive {#step-9}

**Status: Pending — refresh required.** Authored 2026-04-19. Re-check the participant list against post-T3.4.d wire shapes ([Step 7.5](#step-7-5)'s transport-state lifecycle is orthogonal; no participant changes), and confirm the `tug-text-editor` migration didn't move the gallery card pattern this step's gallery demo would mirror.

**Files:**
- `tugdeck/src/components/tugways/tug-transcript-entry.tsx` (new component).
- `tugdeck/src/components/tugways/tug-transcript-entry.css` (new styles).
- `tugdeck/src/components/tugways/cards/gallery-transcript-entry.tsx` (new — gallery card showcasing all four participant variants stacked).
- `tugdeck/styles/themes/brio.css` and `tugdeck/styles/themes/harmony.css` (new `--tugx-transcript-*` tokens; per-participant overrides via `[data-participant="..."]`).

**Work:**

*Participant model.* Define a `Participant` type covering the speakers Tide will mix in the transcript:

| Participant | Source | Identifier (default) | Body | Controls/badges (suggested) |
|-|-|-|-|-|
| `user` | the human's submitted text | "You" | the submission, rendered per its route (markdown for `>`, monospace for `$`/`:`) | route prefix glyph (`❯` / `$` / `:`) |
| `code` | Claude Code assistant turn | "Code" or active model | streamed/finalized markdown via `TugMarkdownView` | model name, token usage, duration, copy button |
| `shell` | tugshell command output (live wire post-Phase T4) | the command's first token (e.g., `git`, `cargo`) | adapter-rendered or monospace | exit code, duration |
| `command` | `:` surface built-in output (live wire post-Phase T10) | the command name (e.g., `:cost`, `:status`) | structured response | refresh / dismiss as appropriate |

The type is open for extension. Adding a participant variant means registering an icon, identifier styling, and (optionally) a controls-row template via `--tugx-transcript-*` tokens — no code change in the primitive.

*Visual structure (Slack-like, NOT chat bubbles per [D6](#resolved-decisions)).* Two-column layout per row:

- **Left column (~32–40px):** participant icon. Glyph or mark, never a photo. Per-participant via `[data-participant="..."]`.
- **Right column header row:** bold identifier (`<strong>`), then a small relative or absolute timestamp.
- **Right column body:** the actual content. Slot — `TugMarkdownView` plugs in for `code`; plain text for `user`; adapter components for `shell`; structured renderers for `command`.
- **Right column controls/badges row (beneath the body):** trailing affordances per participant (model name, exit code, copy, dismiss, etc.).

No rounded surrounding container per row. No left-vs-right alignment by speaker. Every row reads top-to-bottom in a single column. Vertical separation is whitespace + the bold identifier line — no horizontal rules between rows by default.

*`TugTranscriptEntry` component.* Composable, slot-based:

```ts
type Participant = "user" | "code" | "shell" | "command";

interface TugTranscriptEntryProps {
  participant: Participant;
  identifier: React.ReactNode;        // bold label
  timestamp?: React.ReactNode;        // relative or absolute
  body: React.ReactNode;              // markdown / monospace / structured
  controls?: React.ReactNode;         // trailing badge/icon row
  // accessibility:
  // - role="article" or "group" with aria-label = `${identifier} at ${timestamp}`
}
```

The component renders a `data-participant` attribute on its root for theme overrides and a `data-slot` attribute (`transcript-entry`) for stable querying / e2e tests.

*Tokens.* New `--tugx-transcript-*` token set (icon size, identifier weight + color, body line-height, controls-row spacing, row vertical gap). Per-participant overrides keyed by `[data-participant="..."]`. All names conform to the seven-slot naming convention; `bun run audit:tokens lint` exits 0.

*Gallery card.* Build `gallery-transcript-entry` that stacks all four participant variants with realistic content: a `user` row reading "> tell me a haiku", a `code` row with a streaming-style markdown response and a copy button + model badge, a `shell` row with mock `git status` output and an exit-code badge, a `command` row with `:cost` output. Lets the design be tuned in isolation before [Step 11](#step-11) wires it into live data.

**Verification:**
- `bun x tsc --noEmit` + `bun test` green.
- New unit test: render `TugTranscriptEntry` with each participant variant; snapshot the DOM structure (icon column + content column with header / body / controls rows).
- `bun run audit:tokens lint` exits 0; new tokens conform to seven-slot naming.
- Visual review against [D6](#resolved-decisions): no rounded per-row container, no bubble background, no left-vs-right alignment by speaker, identifier + timestamp on top of body.
- Manual: open `gallery-transcript-entry` in tugdeck; all four variants render with distinct icons / identifiers; vertical rhythm reads cleanly top-to-bottom.

**Out of scope (deferred to [Step 11](#step-11) and later phases):**
- Wiring into the live `CodeSessionStore` transcript — that's [Step 11](#step-11).
- Live `shell` rows — needs Phase T4 (tugshell) data. Gallery uses mock data for now.
- Live `command` rows — needs Phase T10 (`:` surface built-ins) data. Gallery uses mock data for now.
- Per-row reactions, threading, or message editing — Slack borrowings stop at the visual structure.

#### Step 10 — Tugcast-side session ledger + full resume UX {#step-10}

**Status: Shipped via [tugplan-tide-session-ledger.md](./tugplan-tide-session-ledger.md).** The placeholder design sketch that originally lived here was promoted into a full plan in 2026-05; the promoted plan landed in nine commits (one per step), each gated on green tests for both the Rust supervisor and the tugdeck client. See the promoted plan's [Phase Exit Criteria](./tugplan-tide-session-ledger.md#exit-criteria) for the verification record.

#### Step 11 — Multi-turn transcript rendering with `TugTranscriptEntry` (absorbs Step 6's Cmd+J) {#step-11}

**Status: Shipped via [tugplan-tug-list-view.md](./tugplan-tug-list-view.md).** The transcript rendering work was promoted into a full plan that ships `TugListView` (a windowed list primitive modeled on `UITableView`) and consumes it via `TideTranscriptDataSource`; the Tide card's top pane now renders `(user, code)` row pairs through that adapter. Cmd+J is explicitly deferred to its own follow-up plan (tracked in the promoted plan's [#roadmap]). See the promoted plan's [Phase Exit Criteria](./tugplan-tug-list-view.md#exit-criteria) for the verification record.

#### Step 12 — Markdown styling pass for assistant output {#step-12}

**Status: Absorbed by [tugplan-tide-assistant-rendering.md §Step 2](./tide-assistant-rendering.md#step-2).** The typography pass — full `--tugx-md-*` token vocabulary in both `brio.css` and `harmony.css`, theme-as-sole-source rule (no fallback literals), comprehensive coverage of headings, lists, blockquotes, inline code, fenced code, tables, links, strong/em/strikethrough, footnotes, images, task-list checkboxes — landed via that plan's Step 2. See the plan file for design rationale, token surface, and the test suite (`tug-markdown-typography.test.ts` + `tide-md-token-coverage.test.ts`) that guards against future drift.

*Original (now-superseded) authoring notes follow for archival purposes:*

**Files:**
- `tugdeck/styles/themes/brio.css` and `tugdeck/styles/themes/harmony.css` (`--tugx-md-*` token tuning).
- `tugdeck/src/components/tugways/cards/tide-card.css` (Tide-specific overrides if any are needed).

**Work:**
- Tune typography (font-family, size, weight), spacing (paragraph margins, list indents, code-block padding), code-block chrome (border, background, copy affordance hover state), and overall vertical rhythm of the rendered markdown so Claude Code output reads cleanly inside a `TugTranscriptEntry` `code` row.
- Coordinate with [Phase T1](./tide.md#content-block-types)'s GFM / TugCodeBlock polish: avoid landing tokens here that T1 will relitigate. Where possible, the values chosen here are the values T1 inherits.
- Token-driven; no inline styles. Conform to the seven-slot naming convention. `bun run audit:tokens lint` exits 0.

**Verification:**
- `bun x tsc --noEmit` + `bun test` + `bun run audit:tokens lint` green.
- Manual: side-by-side comparison of Claude Code output in a Tide card before vs. after this commit. Headings, paragraphs, lists, blockquotes, inline code, fenced code blocks, tables — each looks polished. Both `brio` and `harmony` themes verified.

#### Step 13 — Wire thinking + tool surfaces {#step-13}

**Status: Absorbed by [tugplan-tide-assistant-rendering.md](./tide-assistant-rendering.md).** The thinking-block surface and the full tool-wrapper family (Bash, Read, Edit, Glob, Grep, WebFetch, WebSearch, Write, NotebookEdit, Task, plus DefaultToolWrapper for drift) all shipped via that plan's body-kind and tool-wrapper steps; dispatch, drift caution, and the permission/question dialogs landed alongside. See the absorbing plan's [Phase Exit Criteria](./tide-assistant-rendering.md#exit-criteria) for the verification record.

*Original (now-superseded) authoring notes follow for archival purposes:*

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (`streamingPaths.thinking` + `streamingPaths.tools` consumers).
- `tugdeck/src/components/tugways/cards/tide-card.css` (placement styling).

**Work:**
- Decide visual placement up front (and document the decision in the commit message + a code comment): inline within the `code` row's body, collapsible alongside assistant text, or as a sibling row in the transcript with its own participant variant. Default recommendation: inline + collapsible inside the `code` row, so the transcript reads top-to-bottom and the user can expand a thinking / tool block when curious.
- Wire `streamingPaths.thinking` and `streamingPaths.tools` to dedicated regions of `TugMarkdownView` (or a small companion component if the rendering needs differ enough from markdown to warrant it).
- Coordinate with [Phase T1](./tide.md#content-block-types)'s thinking-block (U6) and tool-use-display (U7): pick a surface T1 can extend, not one T1 will throw away.
- Streaming behavior: thinking blocks stream into their region during the turn and finalize on `turn_complete`. Tool-use blocks render in turn order alongside the assistant text.
- If "tool use" feels participant-flavored enough on review (e.g., a `Bash` tool feels like a transient `shell`-adjacent speaker), consider promoting it to its own participant in a follow-up. The default for this step is to keep tool blocks inside the `code` row.

**Verification:**
- `bun x tsc --noEmit` + `bun test` green.
- New test: render Tide card against a fixture turn that includes thinking + tool_use events → assert thinking region and tool region are both rendered, in correct order, with correct content, inside the `code` row.
- Manual: submit a prompt that elicits both thinking and tool use (e.g., `> use bash to list /tmp`); observe thinking block and tool_use / tool_result blocks rendering inline alongside the assistant response.

#### Step 14 — Mid-stream behaviors end-to-end (Stop, queued sends, tool sub-state) {#step-14}

**Status: Pending — refresh required.** Authored 2026-04-19. The phase machine has a new orthogonal `transportState` axis after [Step 7.5](#step-7-5); the four mid-stream scenarios all assume `transportState === "online"`. Add that premise to the test fixtures.

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (verify; behavior is mostly in `CodeSessionStore` already).
- `tugdeck/src/components/tugways/__tests__/tide-card.test.tsx` (E2E coverage tests).

**Work:**
- Walk the four mid-stream scenarios end-to-end against a real or recorded session and ensure each works correctly through the Tide card surface:
  1. **Stop:** click the Stop button mid-stream → `interrupt` frame on `CODE_INPUT` → `turn_complete(error)` → `interrupted → idle`, accumulated text preserved (in the active `code` row).
  2. **Queued sends:** type and submit a second `> ...` while a turn is in flight → the new `user` row appears in the transcript immediately, marked as queued; on idle it auto-flushes (per U19) and a new `code` row begins streaming.
  3. **Tool sub-state:** during `tool_use` / `tool_use_structured`, the submit button stays in Stop mode; the entry remains in `tool_work` sub-state.
  4. **No regressions:** the basic round-trip (`> hello` → response → idle) still works and is exercised by an existing test.
- Most of this logic lives in `CodeSessionStore`; this step is primarily about *coverage* — confirming the Tide card consumes the right snapshot fields and renders the right affordances. Bug fixes that fall out of the walkthrough land in this commit.

**Verification:**
- `bun x tsc --noEmit` + `bun test` green; new tests exercise each scenario.
- Manual smoke against live Claude: each of the four scenarios behaves as described.

#### Step 15 — `control_request_forward` UI (permission + question) {#step-15}

**Status: Pending — refresh required.** Authored 2026-04-19. Re-check the `CodeSessionStore` snapshot field carrying `control_request_forward` events and confirm the inline-block placement still aligns with the transcript layout from [Step 11](#step-11).

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (mount the dialog component when a snapshot field carries a `control_request_forward`).
- A new component (e.g., `tugdeck/src/components/tugways/tide-control-request.tsx`) for the dialog body.
- Tests.

**Work:**
- Surface `control_request_forward` events as inline blocks inside the in-flight `code` row (consistent with the transcript style from Step 11; not a modal). Two variants:
  - `is_question: false` — permission block. Displays tool name, input, reason. Allow / deny buttons. Approving writes a `tool_approval` frame; denying does the same with the inverse decision. The turn resumes from the decision.
  - `is_question: true` — question block. Renders the question + options (single-select or multi-select per the payload). Submitting writes a `question_answer` frame.
- Keyboard: arrow keys move selection within the block; Enter submits; Esc cancels (cancel = deny / dismiss).
- Snapshot wiring: `CodeSessionStore` already exposes the inflight `control_request_forward` state; Tide card consumes it from the snapshot and renders the block in the `code` row's body for the in-flight turn.
- Phase T9 (Conversation Wiring) will iterate on the richer permission / question UX (suggestions for "always allow," etc.); this step ships the minimum that closes the T3.4.d exit criterion.

**Verification:**
- `bun x tsc --noEmit` + `bun test` green.
- New tests: render Tide card with a fixture `control_request_forward` (both variants); assert the block renders with correct fields; simulate Allow → assert `tool_approval` frame sent; simulate Deny → frame sent; simulate question Answer → `question_answer` frame sent.
- Manual smoke against live Claude: prompt that requires permission (e.g., a Bash invocation in plan mode) → permission block appears; allow → tool runs. Use `AskUserQuestion` similarly.

#### Step 16 — Feature coverage: route prefixes, indicator sync, completions, history {#step-16}

**Status: Done.** Route prefix routing, indicator/atom sync, `@` and `/` completions, and per-route history all shipped during the broader text-editing work; coverage tests for these behaviors live alongside `tug-text-editor` and `tug-prompt-entry`. The original Files / Work / Verification block below is retained as historical context.

**Original Files:**
- `tugdeck/src/components/tugways/__tests__/tug-prompt-entry.test.tsx` and/or `tide-card.test.tsx` (new coverage tests).
- Bug-fix touches as needed.

**Original Work:**
- Add tests that assert the T3.4.d "Feature coverage" criteria from tide.md (route prefixes, indicator sync, `@`/`/` completion, history nav). Where a test exposes a real bug, fix it in the same commit.

#### Step 17 — CJK end-to-end {#step-17}

**Status: Done.** IME composition through the `tug-text-editor` migration was exercised with Japanese and Chinese fixtures; submission and streaming paths handle CJK without segmentation issues. The original block is retained as historical context.

**Original Files:**
- Test fixtures (Japanese, Chinese strings).
- Possibly `tug-text-engine.ts` if IME composition exposes a bug.

**Original Work:**
- Verify IME composition end-to-end; add a fixture that exercises CJK strings through the engine + render path; fix any rendering, segmentation, or composition bugs that surface.

#### Step 18 — VoiceOver / a11y pass {#step-18}

**Status: Deferred.** Not blocking T3.4.d exit; revisit after the participant primitive ([Step 9](#step-9)) and transcript rendering ([Step 11](#step-11)) ship — those are the surfaces an a11y pass needs to evaluate. Reopen as its own plan when the upstream surfaces stabilize.

**Original Files:**
- `tugdeck/src/components/tugways/tug-prompt-entry.tsx` (aria-label / role attributes on atoms, route indicator, submit/stop button).
- `tugdeck/src/components/tugways/tug-transcript-entry.tsx` (aria-label per row; landmark roles).
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (transcript region landmarks).
- Tests.

**Original Work:**
- Walk the Tide card with VoiceOver active. Verify atom announcements, route indicator, submit/stop, per-row participant identifier + timestamp, and transcript navigability.

#### Step 19 — Atom drag-and-drop from Finder {#step-19}

**Status: Done.** Finder drop target shipped on `tug-text-editor`'s drop adapter; multi-file drops produce multiple file atoms in order, with caret-aware drop position. The original block is retained as historical context.

**Original Files:**
- `tugdeck/src/components/tugways/tug-prompt-entry.tsx` (drop target wiring).
- `tugdeck/src/lib/tug-text-engine.ts` (insert-atom path for dropped paths).

**Original Work:**
- Wire a drop target accepting `text/uri-list` / `text/plain` with `file://` URLs; normalize and insert as file atoms; respect caret on in-editor drops; multi-file drops insert in order.

#### Step 20 — Typeahead jank profiling {#step-20}

**Status: Deferred.** Reopen if/when `@`-prefixed completion shows visible jank on a full repo. Today's perf bar is acceptable; profiling can wait until a real complaint surfaces or a measurable regression lands.

**Original Files:**
- `tugdeck/src/lib/filetree-store.ts` and/or completion provider for `@`.
- Tests.

**Original Work:**
- Profile typeahead latency on full-project file listings; apply the smallest fix the profile points at (debounce, memoization, virtualized result list, incremental filtering).

#### Step 21 — Concurrent Tide cards regression test {#step-21}

**Status: Pending — refresh required.** Authored 2026-04-19. Confirm the test file path is still right after the post-T3.4.c reorganizations, and add a transport-state premise to the fixture (per [Step 7.5](#step-7-5)).

**Files:**
- `tugdeck/src/components/tugways/cards/__tests__/tide-card.test.tsx` (new test).

**Work:**
- Two Tide cards open simultaneously already work post-[4k](./archive/tugplan-tide-card.md#step-4k) — each gets its own fresh session, its own tugcode subprocess, its own JSONL. This step *formalizes* that with a regression test:
  - Mount two `<TideCardContent cardId="t1" />` and `<TideCardContent cardId="t2" />` against a fake connection.
  - Submit picker for each with distinct project paths.
  - Simulate `spawn_session_ok` for both, with distinct `tug_session_id` values.
  - Submit `> hi` from card t1.
  - Assert: `user_message` frame is sent on `CODE_INPUT` filtered to t1's session; t2's snapshot is unaffected; t1's transcript has a new `user` row, t2's does not.
  - Submit from t2; assert the inverse.
- This step is *not* gated on P2 router work — the test exercises whatever the router state is at this commit. If P2 has not landed yet, the test still passes (sessions are routed by the existing per-binding feed filtering).
- When P2 lands, this test stays meaningful and may grow to assert the additional router-level isolation.

**Verification:**
- `bun x tsc --noEmit` + `bun test` green; new test exercises the two-card scenario.
- Manual smoke: open two Tide cards on different projects, submit in each, verify no cross-talk.

#### Step 22 — Compliance close-out {#step-22}

**Status: Pending.** This is the final close-out step; nothing to refresh until the steps above land.

**Files:**
- Whatever last-mile cleanup the audit surfaces; ideally none.

**Work:**
- Run the full check matrix:
  - `bun x tsc --noEmit` clean.
  - `bun run check` clean.
  - `bun test` green.
  - `bun run audit:tokens lint` exits 0.
  - `cargo nextest run` green across the workspace.
- Grep for IndexedDB references introduced anywhere by this plan: `rg -i 'indexeddb' tugdeck/src/components/tugways/cards/tide-card.* tugdeck/src/components/tugways/tug-prompt-entry.* tugdeck/src/components/tugways/tug-transcript-entry.*` returns zero matches.
- Grep for any leftover gallery / mock / fixture references that may have crept into the production Tide path: `rg -i 'gallery|mock|fixture' tugdeck/src/components/tugways/cards/tide-card.* tugdeck/src/components/tugways/tug-transcript-entry.*` — review every match; remove if production, ignore if comment-as-history.
- All new components pass the component authoring guide checklist.
- All new tokens conform to the seven-slot naming convention.

**Verification:**
- The full check matrix above passes.
- The audit greps return clean results.

#### Step 23 — Tuglaws walkthrough {#step-23}

**Status: Pending.** Final walkthrough; lands after Step 22. The cross-check list will need to absorb [Step 7.5](#step-7-5)'s `transportState` lifecycle (L02 / L03 / L11 / L23).

**Files:**
- `dash/tugplan-tide-card-polish.md` (this file — append the walkthrough to this section).
- Bug-fix touches as needed.

**Work:**
- Re-read [tuglaws.md](../tuglaws/tuglaws.md). Walk the Tide card surface law-by-law, focusing on:
  - **L01** — One `root.render()` at mount, ever.
  - **L02** — External state via `useSyncExternalStore` only.
  - **L03** — Registrations in `useLayoutEffect` for events that depend on them (e.g., the new focus / keybinding handlers from Steps 3–6).
  - **L06** — Appearance changes via CSS/DOM, not React state (relevant for the popup-overflow fix in Step 8 and the per-participant theming in Step 9).
  - **L07** — Action handlers access state via refs or stable singletons.
  - **L19** — Component authoring guide (relevant for `TugTranscriptEntry`).
  - **L22** — Store observers drive DOM writes directly (relevant for the transcript `code` rows in Step 11).
  - **L23** — User-visible state preserved across internal ops.
  - **L24** — State partitioned into appearance / local-data / structure zones.
- For each law: applies-and-satisfied, or does-not-apply (and why). Record the walkthrough below this section as a closing artifact (the same pattern as [Step 8 of T3.4.c](./archive/tugplan-tide-card.md#step-8)).
- Fix anything the walkthrough surfaces.

**Verification:**
- The walkthrough is recorded in this file, law-by-law.
- All earlier-step verifications still pass after any fixes from this step.

---

### Risks {#risks}

> Risks for steps marked `done` or `deferred` in [Plan Status](#plan-status) have been removed. The Risks list below covers active and pending steps only.

- **Step 7.5 (transport-state lifecycle) introduces a new dimension to test.** Every existing per-phase test now has an implicit `transportState === "online"` premise. Mitigation: the field's default is `online`; tests that don't dispatch transport events stay green; explicit `transport_close` / `transport_open` tests cover the new dimension. See Step 7.5's own Risks section for the watchdog mis-fire, reconnect-stack, `lastPayload`-cache, and banner-UX subsidiary risks.
- **Step 8 (popup overflow) may need new primitives.** If `tug-popup-*` does not already support upward-opening + capped-height, the primitive extension lives in this step's commit. That can grow the commit; if the primitive change is itself non-trivial, split into "extend primitive" + "consume in completions" — two commits.
- **Step 9 (participant primitive) ships tokens for two participants we don't wire live in this plan.** `shell` and `command` rows exist in the gallery but do not appear in the live Tide transcript until Phases T4 and T10 respectively. Mitigation: gallery uses realistic mock data; the token slots are meant to be tunable; nothing about Step 9 prevents Phase T4 / T10 from refining the participant's icon, identifier, or controls when the live wire arrives.
- **Step 9 design risk: bubble drift.** Even with [D6](#resolved-decisions) explicit, it is easy to slip toward a bubble-ish look (subtle backgrounds, rounded corners, alternating tinting). Mitigation: Step 9's verification includes an explicit visual review against D6, and the gallery card is the durable artifact future contributors can compare against.
- **Step 10 (session ledger placeholder) reads as done when it is merely designed.** The placeholder captures intent but ships no code. Mitigation: the Status and Promotion Gate paragraphs are explicit; the "Session ledger + resume UX" section of Success Criteria names the promoted plan as the exit criterion. The plan is *not* fully closed until the promoted plan has shipped its own exit criteria.
- **Step 10's open design questions may not all resolve in one promotion pass.** Sqlite-vs-JSONL, CLI-flag-vs-CONTROL-round-trip, and `resume_failed` semantics are each load-bearing. Mitigation: promotion-pass plan enumerates each question and picks an answer; if a question cannot be resolved cheaply, the promoted plan's Strategy names the deferred sub-question and the step that revisits it.
- **Step 11 (transcript + Cmd+J) interacts with `SmartScroll`.** The "scroll to bottom on new content unless the user has scrolled away" behavior should already be implemented by `SmartScroll`. Cmd+J's explicit scroll-into-view path must not fight SmartScroll's auto-scroll opt-out. Mitigation: Step 11's verification includes a manual scroll-away scenario plus a Cmd+J jump from inside it.
- **Step 13 (thinking + tool surfaces) commits to a placement that Phase T1 must accept.** Choosing a placement T1 will replace defeats the point. Mitigation: Step 13's Work section names the chosen placement (default: inside the `code` row) and the rationale; T1 inherits or revises.
- **Step 15 (control_request_forward UI) is the largest feature commit in the plan (after the ledger's promoted plan).** It introduces a new component, a new snapshot field, and new frame-write paths. Mitigation: scope is "the minimum that closes the T3.4.d exit criterion" — Phase T9 picks up richer treatment.
- **Refresh-before-resume risk.** Steps 8, 9, 11, 12, 13, 14, 15, 21, 22, 23 were authored before the `tug-text-editor` migration, the editor-settings sheet, and the panel-growth wiring. Each step's `**Status:**` line names a refresh-required premise; skipping that re-read produces work against stale file paths or removed delegate methods. Mitigation: open each step's Files list against the current repo before drafting the commit.

---

### References {#references}

- [tide.md §T3.4.d — Polish & exit criteria](./tide.md#t3-4-d-polish-exit) — the source of the original work list.
- [tide.md §T3.4.c — Tide card](./tide.md#t3-4-c-tide-card) — the predecessor surface.
- [tugplan-tide-card.md](./archive/tugplan-tide-card.md) — the implementation that landed T3.4.c, including the deferrals this plan picks up (Step 5 transcript, Step 6 lastError, Step 8 tuglaws walkthrough pattern, Step 4.6 session ledger design sketch).
- [Step 4.6 of T3.4.c](./archive/tugplan-tide-card.md#step-4-6) — the session ledger design sketch carried forward into [Step 10](#step-10) of this plan.
- [Step 4.5 of T3.4.c](./archive/tugplan-tide-card.md#step-4-5) — the resume-vs-new picker whose storage Step 10 replaces.
- [Step 4.5.5 of T3.4.c](./archive/tugplan-tide-card.md#step-4-5-5) — the post-implementation audit whose findings Step 10 builds on.
- [Step 4m of T3.4.c](./archive/tugplan-tide-card.md#step-4m) — the recent-projects plumbing Step 10 must stay coherent with.
- [tide.md §T3.4.a — CodeSessionStore](./tide.md#code-session-store) — for snapshot fields, `streamingPaths`, `transcript`, `lastError`.
- [tide.md §Phase T1 — Content Block Types](./tide.md#content-block-types) — for the markdown / thinking / tool-use treatment that Step 12 and Step 13 coordinate with.
- [tide.md §Phase T4 — Shell Bridge (Tugshell)](./tide.md#shell-bridge) — provides the live data for `shell` participant rows whose primitive lands in Step 9.
- [tide.md §Phase T9 — Conversation Wiring](./tide.md#conversation-wiring) — for the richer permission / question UX that Step 15's minimum will be extended into.
- [tide.md §Phase T10 — Surface Built-Ins](./tide.md#surface-built-ins) — provides the live data for `command` participant rows whose primitive lands in Step 9.
- [tuglaws.md](../tuglaws/tuglaws.md) — the laws walked in Step 23.
- [Design Decisions](../tuglaws/design-decisions.md) — context for L02, L06, L22, L23, L24.
