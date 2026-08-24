## App-test approval dialog — informed consent before a disruptive run {#app-test-dialog}

**Purpose:** Make an app-test invocation that will seize the screen ask first, through a session-inline `TugInlineDialog` offering *run all* / *run background-only* / *cancel*, so the session enters Awaiting and the developer decides; runs that stay in the background continue to need no attention at all.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-01 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

App-tests now run in the background by default. `TUGAPP_NATIVE_EVENT_MODE=pid` makes the in-app harness address keyboard events to its own process (`CGEvent.postToPid`) and dispatch mouse events straight into the window as synthesized `NSEvent`s (`window.sendEvent`), the app boots as an accessory (`NSApp.setActivationPolicy(.accessory)`) so it never self-activates, and the harness launches it with `open -g`. A run no longer takes the developer's focus, cursor, or key window. That work is landed-but-uncommitted in the working tree across `tugapp/Sources/TestHarness/NativeEventHandlers.swift`, `tugapp/Sources/AppDelegate.swift`, `tugapp/Sources/MainWindow.swift`, `tests/app-test/_harness/index.ts`, and `tests/app-test/_harness/types.ts`.

A minority of tests cannot work that way. Their subject *is* activation — app resign / become-active cycles, key-window-gated responder routing, `document.hasFocus()` (which WebKit ties to application activation, not key-window status; an experiment that made the window key without activating did not restore it and broke `at0201`'s activation-click semantics). Those tests opt back in with `launchTugApp({ foreground: true })`, which sets `TUGAPP_NATIVE_EVENT_MODE=session` and drops the `-g` flag. They still take the screen, and today they do it without warning: a run that happens to include one interrupts whatever the developer is doing, mid-thought, with no signal beforehand. This plan puts a decision point in front of exactly those runs and leaves every other run untouched.

#### Strategy {#strategy}

- Make "this test steals focus" a **declared, checkable fact** (`@foreground` in the header docblock) rather than something inferred by grepping for a launch option, so the gate has a cheap and reliable input and the declaration cannot silently drift from behavior.
- Reuse the existing blocking CLI→deck→CLI round trip. `POST /api/eval` already does exactly this shape; `/api/ask` copies its machinery rather than inventing a second one.
- Reuse the existing inline-dialog primitive. `TugInlineDialog` already carries icon + title + description + a mandatory-single-select `options` radio group — the three-way choice is a natural fit, so **no new primitive is authored**.
- Ask **before** taking the machine-wide app-test gate, never while holding it, so a run waiting on a human does not block another worktree's run.
- Fail **open** where blocking would be worse than proceeding (no deck reachable, no session) and **closed** where ambiguity is dangerous (timeout, deck disconnect → treat as cancel).
- Land in dependency order — declaration, transport, CLI, deck store, component, wiring, recipe — with each step independently checkpointable.

#### Success Criteria (Measurable) {#success-criteria}

- Running a selection containing **no** `@foreground` test never contacts the deck and never prompts (verify: `just app-test at0001-tab-switch-fc.test.ts` completes with no dialog; `grep` the tugcast log for `/api/ask` shows no request).
- Running a selection containing **at least one** `@foreground` test raises the dialog and blocks until answered (verify: `just app-test at0145-permission-dialog-keyboard.test.ts` stalls before the first app launch; the Session card shows the dialog).
- While the dialog is pending the session reports the Awaiting phase (verify: `codeSessionStore.getSnapshot().phase === "awaiting_approval"` via the dev panel or `app.evalJS`).
- Choosing **Run background-only** runs the selection minus the `@foreground` files, and names the skipped files on stderr (verify: run a mixed selection; summary file count equals selection minus skipped; stderr lists them).
- Choosing **Cancel** exits non-zero without launching any app (verify: exit code is non-zero; no `Tug-apptest` process was spawned; `VERDICT:` line absent).
- The declaration cannot drift: a test with `foreground: true` at a launch site but no `@foreground` tag (or the reverse) fails the checker (verify: `just app-test-foreground-check` exits non-zero on a deliberately-desynced fixture, then passes once fixed).
- `just app-test` with no deck running still works (verify: proceeds with a stderr notice, does not hang).

#### Scope {#scope}

1. `@foreground` docblock declaration, parsed by `tests/app-test/scripts/select-tests.ts`, with a drift check against launch-site `foreground: true`.
2. A blocking ask channel: `POST /api/ask` on tugcast plus the `ask` / `ask-response` CONTROL action pair.
3. `tugutil host ask` — a CLI verb that raises the dialog and prints the chosen option id.
4. A deck-side pending-ask store participating in the session phase machine so the session enters Awaiting.
5. `AppTestAskDialog`, a new composition of `TugInlineDialog` (not a new primitive).
6. Gate logic in the `app-test` recipe: resolve selection → detect `@foreground` → ask → branch.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Reducing the foreground tier itself. The 18 corpus tests that call `simulateAppResign` / `simulateAppBecomeActive` / `simulateAppHide` / `simulateAppUnhide` genuinely need activation; synthesizing those notifications instead of calling `NSApp.activate` would make them stop testing AppKit's real behavior.
- Concurrency. The machine-wide `apptest` gate stays one-at-a-time; this plan does not attempt parallel runs.
- A general-purpose "ask the user anything from a shell script" product surface. `/api/ask` is built generically enough to serve one, but only the app-test caller ships here.
- Persisting the answer across invocations (no "don't ask again" memory). Every invocation that contains a foreground test asks.
- Changing what `foreground: true` does at runtime — that behavior is already landed.

#### Dependencies / Prerequisites {#dependencies}

- The uncommitted background-mode work must be in the tree (see [#context] for the file list). This plan assumes `foreground: true` already exists in `LaunchTugAppOptions` (`tests/app-test/_harness/types.ts`) and already drives `TUGAPP_NATIVE_EVENT_MODE` in `resolveLaunchOptions` (`tests/app-test/_harness/index.ts`).
- A running tugcast to talk to, discovered via `resolve_port` in `tugrust/crates/tugutil/src/commands/tell.rs`.
- `TUG_SESSION_ID` exported into the shell environment (already true on both the Claude and Shell routes).

#### Constraints {#constraints}

- **Warnings are errors.** The Rust workspace enforces `-D warnings` via `tugrust/.cargo/config.toml`.
- Loopback-only for the new route, matching `eval_handler`'s `addr.ip().is_loopback()` guard.
- `/api/ask` must NOT inherit `eval_handler`'s dev-mode gate. Eval is an arbitrary-code door; ask is a user-consent prompt and must work on a release instance.
- The deck must satisfy [L02]: pending-ask state enters React through `useSyncExternalStore` only.
- Dialog elements must be built every render, not cached in `useMemo` — `session-card-transcript.tsx` documents that caching a React element freezes the `Component` reference and breaks Fast Refresh for `PermissionDialog` / `QuestionDialog`.
- No `localStorage` / `sessionStorage` / IndexedDB anywhere in this work.

#### Assumptions {#assumptions}

- A developer running app-tests has the Session card visible; the dialog is worthless if unseen, but that is the normal working state.
- Answering is fast relative to a run, so a 10-minute ask timeout is generous rather than tight.
- The set of `@foreground` tests stays small (22 files today — see [#foreground-inventory]).

**The prompt is not occasional.** The core tier (`just app-test` with no arguments) contains four foreground files — `at0014-scroll-persistence`, `at0126-keyboard-ring-cold-boot`, `at0145-permission-dialog-keyboard`, `at0165-activation-first-responder` — so **every core-tier run prompts**. That is the most common invocation in daily use. The gate is therefore a routine interaction, not a rare one, and [R01] is the expected case rather than a tail risk. Two things follow: the dialog must be fast to answer (default selection on the safe option, confirm on Return), and [Q03] moves from "wait and see" to "watch closely from day one".

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Where does the dialog mount when there is no live assistant turn? (DECIDED — see [P05]) {#q01-mount-point}

**Question:** `PermissionDialog` mounts at the foot of the last assistant turn cell, gated on `isLastAssistant && !isCommitted` in `session-card-transcript.tsx`. An app-test ask raised by the agent's Bash tool call does have a live turn — but one raised from a plain terminal does not. Where does it render then?

**Why it matters:** If the ask is modeled as turn-scoped chrome and no turn exists, the dialog silently never appears while the CLI blocks for ten minutes — the worst possible failure.

**Options:**
- Mount inside the turn cell like `PermissionDialog`, and refuse to ask when no turn is live.
- Mount at the session level, below `SessionTranscriptHost` inside `.session-view-pane[data-view="transcript"]`, independent of turn state.

**Resolution:** DECIDED (see [P05]) — session-level mount. The ask is not turn-scoped; it is a property of the session's environment.

#### [Q02] Should "Run background-only" be offered when the selection is *entirely* foreground tests? (DECIDED — see [P08]) {#q02-empty-background-set}

**Question:** If every file in the selection is `@foreground`, "run background-only" would run nothing.

**Why it matters:** An option that silently does nothing is a trap.

**Resolution:** DECIDED (see [P08]) — the option is omitted from `options` when the background subset is empty, leaving a two-way choice. The CLI computes both subsets and only offers what is non-empty.

#### [Q03] Should the answer be remembered for a session or a time window? (DEFERRED) {#q03-remember-answer}

**Question:** A developer iterating on a foreground test will be asked on every run.

**Why it matters:** Repetition trains reflexive approval, which defeats the gate.

**Plan to resolve:** Live with per-invocation asking first and see whether it actually chafes. If it does, the natural shape is an `--assume` flag the developer passes deliberately (already present per [P10] for non-interactive use) rather than implicit memory, which would risk a surprise seizure long after the decision.

**Resolution:** DEFERRED, but on a short leash. The core tier prompts on *every* run (four of its twenty files are foreground — see [#assumptions]), so "see whether it chafes" has a predictable answer. Ship without memory, keep the safest option preselected so the routine case is one keystroke, and revisit as soon as the gate has real daily use.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Ask blocks forever, wedging a run | high | low | 10-minute timeout → treated as cancel ([P07]) | Any report of a hung `just app-test` |
| Dialog raised but never visible | high | low | Session-level mount ([P05]); fail-open when no session ([P03]) | A blocked CLI with no dialog on screen |
| Holding the apptest gate while awaiting a human | med | med | Ask before acquiring the gate ([P09]) | Another worktree reports "held by" for minutes |
| Declaration drifts from behavior | med | med | `foreground-check` fails the build on mismatch ([P04]) | A foreground test runs unprompted |
| New route becomes an unauthenticated control surface | high | low | Loopback-only; no code execution; caller text is confined below fixed provenance chrome ([P11]) | Any change that lets the payload style or replace the chrome |
| Ask silently skipped while another run is live | med | high | Port resolution prefers `TUG_INSTANCE` / cwd and never treats multi-instance as fatal ([P03]) | A foreground run starts unprompted while a second worktree is testing |

**Risk R01: The ask becomes noise and gets reflexively approved** {#r01-approval-fatigue}

- **Risk:** The prompt fires often enough that the developer stops reading it, and the gate stops informing anything. This is the **expected** case, not a tail one: four of the twenty core-tier files are foreground, so bare `just app-test` prompts every time (see [#assumptions]).
- **Mitigation:**
  - Keep the tier small — it is a declared, checked set, so growth is visible in review.
  - The dialog names the specific files, so the content differs run to run rather than being a uniform "are you sure".
  - `just app-test-foreground-check` makes the tier's size a queryable number, worth watching.
  - Make answering cheap: the safe option is preselected and Return confirms, so the routine case costs one keystroke and the developer still sees which files are involved.
- **Residual risk:** High and accepted for now. Nothing prevents a burst of new foreground tests, and a one-keystroke confirm is exactly the shape that trains reflexive approval. If the core tier keeps prompting on every run, the answer is [Q03] (remembered answers) or shrinking the tier — not a louder dialog.

**Risk R02: Fail-open hides the gate exactly when it is wanted** {#r02-fail-open}

- **Risk:** [P03] proceeds without asking when no deck or session is reachable. A developer whose deck crashed mid-work would get an unannounced screen seizure.
- **Mitigation:**
  - Print a clear stderr line naming the foreground files that are about to run and why no prompt was raised.
  - Fail-open only on *transport* failure (no port, connection refused), never on a delivered-but-unanswered ask.
- **Residual risk:** The stderr notice can scroll past unread in a busy terminal.

---

### Design Decisions {#design-decisions}

#### [P01] Compose `TugInlineDialog`; author no new primitive (DECIDED) {#p01-compose-not-author}

**Decision:** The app-test dialog is a new *composition* of the existing `TugInlineDialog` (`tugdeck/src/components/tugways/tug-inline-dialog.tsx`), alongside `PermissionDialog` and `QuestionDialog` — not a new reusable component.

**Rationale:**
- The primitive already provides everything the design needs: `icon`, `iconRole`, `title`, `description`, `actions`, and an `options` mandatory-single-select radio group of `TugDialogButton`s (`TugInlineDialogOption` = `{ value, label, description? }`).
- `session-permission-dialog.tsx` is a working reference composition with the same header-bar + options shape.
- Hand-rolling UI that exists as a `Tug*` component is a standing project anti-pattern; borrowing its CSS classes instead of composing it counts as hand-rolling.

**Implications:**
- No changes to `tug-inline-dialog.tsx` itself, so `tug-inline-dialog.test.ts` and `gallery-tug-inline-dialog.tsx` are untouched.
- The three choices map onto `options` values, not onto three buttons in `actions`. `actions` carries a single confirm button; `Cancel` is an option like the others so the choice stays a single mandatory selection.

#### [P02] `/api/ask` mirrors `/api/eval`'s round-trip machinery (DECIDED) {#p02-mirror-eval}

**Decision:** Add `POST /api/ask` to tugcast modeled directly on `eval_handler` in `tugrust/crates/tugcast/src/server.rs`: mint a `requestId`, register a `oneshot::Sender` in a new `pending_asks` map on `FeedRouter`, broadcast an `ask` action on `FeedId::CONTROL`, await the oneshot with a timeout.

**Rationale:**
- The exact request/response shape already exists and is proven: `PendingEvals` in `tugrust/crates/tugcast/src/router.rs`, the broadcast in `eval_handler`, and the `"eval-response"` arm of `dispatch_action` in `tugrust/crates/tugcast/src/actions.rs` that removes the entry and sends on the oneshot.
- Threading a second map alongside the first is mechanical: `pending_evals` is already passed through `control.rs` and `main.rs` into `dispatch_action`, so `pending_asks` follows the same path.

**Implications:**
- `dispatch_action`'s signature grows a `pending_asks` parameter, touching its call sites in `control.rs` and `main.rs` and its unit-test setup in `actions.rs`.
- The deck answers with `connection.sendControlFrame("ask-response", { requestId, choice })`, mirroring `"eval-response"`.
- **`/api/ask` must not copy eval's dev-mode/diag gate.** Eval is gated because it executes arbitrary code; ask only displays text and returns an opaque option id, and must work on a release instance. Loopback-only is retained.

#### [P03] The ask is session-scoped, and fails open when there is no session (DECIDED) {#p03-session-scoped}

**Decision:** The CLI sends `TUG_SESSION_ID` as `sessionId`. The deck routes the ask to that session's card. If `TUG_SESSION_ID` is unset, the deck routes to the active session card. If tugcast is unreachable, or the deck reports no session at all, the CLI prints a stderr notice naming the foreground files and **proceeds without asking**.

**Rationale:**
- Awaiting is a *session* phase; an ask that is not attached to a session has nothing to put into Awaiting.
- Blocking a terminal-only run that cannot possibly show a dialog would make app-tests unusable outside the app, which is a worse failure than an unannounced foreground run the developer started by hand at that terminal.
- Fail-open is limited to transport/absence failures; a delivered ask that is never answered is a cancel per [P07].

**Implications:**
- The wire payload carries an optional `sessionId`.
- The CLI distinguishes "no route to a dialog" (exit 0, proceed, notice) from "asked and not answered" (exit non-zero, cancel).
- **Port resolution must not treat "multiple live instances" as fatal.** `resolve_port` in `tugrust/crates/tugutil/src/commands/tell.rs` falls back: explicit `--port` → `TUG_INSTANCE` → `find_for_cwd` → the single live instance → **`Err("multiple instances running")`**. During any app-test run the harness registers `apptest-<wtslug>-<uuid>` instances, so a second worktree's pre-gate ask would hit the multi-instance error, exit 3, and fail open — losing the prompt in precisely the situation where two runs are competing for the screen. The recipe therefore passes `--instance "$TUG_INSTANCE"` when it is set, and `ask.rs` treats a multi-instance registry as "pick the one matching cwd, else no route" rather than an error, filtering out instance ids beginning with `apptest-`.

#### [P04] `@foreground` is a declared docblock tag, checked against behavior (DECIDED) {#p04-foreground-declaration}

**Decision:** Every test that launches with `foreground: true` declares `@foreground` in its header docblock, exactly as `@covers` is declared. `tests/app-test/scripts/select-tests.ts` gains a `--foreground` mode that prints the foreground subset of a selection, and a check that fails when the tag and the launch-site option disagree in either direction.

**Rationale:**
- Following the established `@covers` convention means one parser, one mental model, and an existing enforcement habit (`just app-test-covers-check`).
- A docblock tag is greppable in a fraction of the time it takes to parse TypeScript for a call-site option, and the recipe gate runs on every invocation.
- The bidirectional check is what makes the declaration trustworthy: a tag without the option would prompt for a test that does not steal focus (noise), and an option without the tag would run a screen-seizing test unprompted (the actual harm).

**Implications:**
- Files to tag initially: `at0014-scroll-persistence.test.ts`, `at0126-keyboard-ring-cold-boot.test.ts`, `at0145-permission-dialog-keyboard.test.ts`, `at0165-activation-first-responder.test.ts`, `at0209-picker-field-click-single-focus.test.ts`, `at0306-open-quickly-default-dir.test.ts`, plus every file using a lifecycle verb (see [#foreground-inventory]).
- The check is per-file, not per-launch-site: `at0165` marks only its Bug D launch `foreground: true`, and the file still carries one `@foreground` tag. The tag means "this file contains at least one foreground launch".

#### [P05] The dialog mounts at session level, not inside a turn cell (DECIDED) {#p05-session-level-mount}

**Decision:** `AppTestAskDialog` renders as a sibling of `SessionTranscriptHost` inside `.session-view-pane[data-view="transcript"]` in `tugdeck/src/components/tugways/cards/session-card.tsx`, gated only on the pending-ask store — never on `isLastAssistant` or `isCommitted`.

**Rationale:**
- Resolves [Q01]. An ask can arrive with no live assistant turn (terminal invocation, or an agent turn that has already committed), and the turn-cell gating in `session-card-transcript.tsx` would render nothing in that case while the CLI blocks.
- The ask describes the session's *environment* (a run is about to seize the screen), not the content of any one turn, so turn-scoped chrome is the wrong model.
- Keeps `session-card-transcript.tsx`'s `pendingApproval` / `pendingQuestion` logic untouched, which is delicate — it is `useSyncExternalStore`-gated on `isCommitted` specifically so committed cells return stable `null` and skip re-renders.

**Implications:**
- The dialog does not participate in the `dispatchRenderInput` registry in `session-assistant-renderer-dispatch.ts` — that registry's `RenderInput` union is for turn content (`assistant_text`, `thinking`, `tool_call`, `user_text`, `permission`, `cost`), and the ask is not turn content.
- The element must still be constructed inline every render (no `useMemo` over the element) so Fast Refresh swaps the component cleanly.

#### [P06] Awaiting comes from a lifecycle **overlay**, never from the turn phase (DECIDED) {#p06-pending-ask-phase}

**Decision:** `pendingAsk` becomes a snapshot field on `CodeSessionStore`, and `deriveLifecycleSnapshot` (`tugdeck/src/lib/code-session-store/lifecycle-state.ts`) reports it as a new `SessionLifecycleOverlay`. The store's `state.phase` is **not** touched, and `canSubmit` / `canInterrupt` are **not** affected.

**Rationale:**

An earlier draft of this decision said "extend the existing `phase === "awaiting_approval"` branch". Reading the code shows that would be both ineffective and actively harmful, so it is recorded here as a rejected option rather than silently dropped:

- **Ineffective as stated.** `deriveLifecycleState` reads only `LifecycleStoreSignals` = `{ phase, transportState, interruptInFlight, transcript }`. It never reads `pendingApproval`. Adding a `pendingAsk` snapshot field alone changes nothing in the matrix — the AWAITING_USER row is keyed on `phase === "awaiting_approval"`, which the *reducer* sets (with a `prevPhase` save/restore) when a permission or question arrives.
- **Harmful if actually wired.** An app-test ask normally lands on an **idle session with no live turn**. Forcing `phase = "awaiting_approval"` then makes `canSubmit` false (it requires `phase === "idle" || "errored"`) — **the composer goes dead while the dialog is up** — and makes `canInterrupt` true, lighting the Stop button on a session with no turn to stop.
- **It inverts the law.** `tuglaws.md` [#l24] states the source→delegate rule for the turn lifecycle: `canSubmit` is the single published projection every submit affordance obeys. An app-test ask is a fact about the session's *environment*, not about a turn. Making it masquerade as a turn phase is exactly the source→delegate inversion [D01]/[D13] exist to prevent.

An overlay is the mechanism the matrix already provides for "something is true about this session that is not its turn state". `SessionLifecycleSnapshot` is `{ state, overlays: ReadonlySet<SessionLifecycleOverlay>, submitButtonMode }` — the overlay set rides alongside the state rather than replacing it.

**Implications:**
- Add a `pendingAsk: boolean` (or the request object) to `LifecycleStoreSignals` and a new member to `SessionLifecycleOverlay`; `deriveLifecycleState` is untouched.
- The Z2 STATE cell shows Awaiting from the overlay. The composer stays live and the submit button keeps whatever `submitButtonMode` the real turn state dictates.
- The matrix's own test is the pure-logic `tugdeck/src/lib/code-session-store/__tests__/lifecycle-state.test.ts`, **not** `at0084` — that is where the new overlay row is pinned. `at0084` is re-run as a regression check only.
- `CodeSessionStore.getSnapshot` memoizes into `_cachedSnapshot`; every mutation of `pendingAsk` must null that cache or `useSyncExternalStore` will never observe the change ([L02]).
- Because the phase is untouched, ask-Awaiting time does **not** land in `awaitingApprovalMs` and friends. The telemetry stays honest about what it counts, and the follow-on in [#roadmap] to distinguish them is no longer needed.

#### [P07] Timeout and disconnect are cancels, not proceeds (DECIDED) {#p07-timeout-is-cancel}

**Decision:** `/api/ask` uses a 600-second timeout (versus eval's 30). Timeout, deck disconnect (oneshot sender dropped), or any non-`ok` response causes the CLI to exit non-zero and the recipe to abort the run.

**Rationale:**
- A delivered-but-unanswered ask means the developer is away or did not see it; seizing the screen then is precisely the harm this plan exists to prevent.
- 30 seconds is far too short for a human decision; ten minutes is long enough that a timeout genuinely means "nobody is there".
- This is the closed half of the fail-open/fail-closed split in [P03]: absence of a channel proceeds, presence of an unanswered question does not.

**Implications:**
- The recipe must distinguish CLI exit codes: `0` + choice on stdout = answered; non-zero = abort; a distinct code for "no route, proceed" per [P03].

#### [P08] Options are computed from the selection, and empty branches are omitted (DECIDED) {#p08-computed-options}

**Decision:** The CLI computes the foreground and background subsets of the resolved selection and offers only the options that would do something: `run-all` always; `run-background-only` only when the background subset is non-empty; `cancel` always.

**Rationale:**
- Resolves [Q02]. Offering an option that runs zero tests is a trap.
- The dialog's description can then state exact counts ("3 of 12 tests will take the screen"), which is what makes the prompt informative rather than a generic warning.

**Implications:**
- Option ids are a closed set — `run-all`, `run-background-only`, `cancel` — so the recipe can branch on them without parsing prose.
- The CLI, not the deck, owns option construction; the deck renders whatever `options` array it receives.

#### [P12] The question never blocks a test that did not need it (DECIDED, supersedes the gating half of [P08]) {#p12-non-blocking-ask}

**Decision:** The run is **partitioned, not gated**. Background tests start immediately and are never held up by the question. Screen-taking tests are ordered last, and the answer is collected just before the first of them. The ask itself is raised up front, in parallel with the background run, so the developer gets the question while they are still at the keyboard.

**Rationale:**
- The original design asked once per *invocation* — "does this run contain a screen-taker? then ask before anything starts". That is the wrong scope. It blocks tests that had permission by default: a bare `just app-test` held all sixteen background files behind a prompt none of them needed. The requirement was that background tests "run at will without requiring attention or approval", and invocation-scoped gating contradicts it.
- The symptom was visible before it shipped — the [#assumptions] note that every core-tier run prompts, and the re-weighting of [R01] — and was rationalized as a UX cost rather than recognized as the wrong scope. Recorded here so the reasoning error is legible, not just the fix.
- Asking *when reached* rather than up front was the simpler option and was rejected: the dialog would appear minutes in, after the developer had moved on, and a timeout would quietly mean "skipped". Raising it immediately keeps the question where attention is.

**Implications:**
- The asker is a detached process; the answer reaches the post-gate child through a file named in `TUG_APPTEST_ASK_OUT`, written to `<file>.part` and renamed to `<file>.done` so a reader never sees a half-written answer.
- Declining no longer means "cancel the run" — the background half has already happened — so the dialog offers two choices, *run them* / *skip them*. `TUG_APPTEST_ASSUME=cancel` keeps its stronger meaning of "run nothing", checked before any work starts.
- Skipped files appear as `SKIP` rows in the run summary, so a declined ask is visible in the result rather than silently narrowing coverage.
- A selection that is *entirely* foreground degenerates correctly: there is nothing to run in parallel, so the run simply waits on the answer.

#### [P09] Ask before acquiring the machine-wide gate (DECIDED) {#p09-ask-before-gate}

**Decision:** The `app-test` recipe resolves its selection and runs the ask **before** the `tugutil host gate run --name apptest` re-exec, not inside it.

**Rationale:**
- The gate serializes whole invocations machine-wide. Holding it while a human decides would block every other worktree's run for as long as the dialog sits unanswered — up to the ten-minute timeout.
- The selection is knowable without the gate; nothing about resolving files or asking a question needs exclusivity.

**Implications:**
- The recipe's existing early-exit re-exec block (`if [ "${TUG_APPTEST_GATED:-}" != "1" ]; then … exec tugutil host gate run …`) is where the ask goes — before the `exec`.
- The chosen outcome must survive the re-exec. It is passed forward in the environment (`TUG_APPTEST_ASSUME`), which also makes the gated child skip re-asking.
- **The selection must be resolvable pre-gate, and today it is not.** The `app-test` recipe resolves its file list *after* the gate: the gate re-exec sits near the top of the recipe, while the core-tier list is built ~150 lines further down, after `cd tests/app-test`, in the `if [ -z "$FILES_INPUT" ]` branch. So for bare `just app-test` — the most common invocation — there is no file list at the point the ask belongs. **Fix: hoist core-tier selection into `select-tests.ts` as a `--core` mode**, so both sides resolve the same list from one place and the pre-gate shell can ask about it. The recipe's `FILES` branch then calls `select-tests.ts --core` instead of carrying an inline array.
- **The re-exec cannot rewrite the file list.** The exec line is `exec … just app-test {{FILES}}` — a *just* template variable, not a shell variable, so the pre-gate shell cannot substitute a filtered list into it. "Run background-only" therefore cannot work by editing `FILES` before the exec. The choice rides across as `TUG_APPTEST_ASSUME=background` and the **post-gate child** re-derives the filtered list by dropping its own `@foreground` files. Pre-gate asks; post-gate filters.

#### [P10] A non-interactive escape hatch exists and is explicit (DECIDED) {#p10-assume-flag}

**Decision:** `TUG_APPTEST_ASSUME=all|background|cancel` short-circuits the ask. It is also the mechanism by which the pre-gate answer reaches the post-gate child ([P09]).

**Rationale:**
- Automation and scripted runs must not block on a dialog.
- Making it an explicit environment variable rather than implicit memory keeps the decision visible at the call site, which is the objection to remembering answers in [Q03].

**Implications:**
- Documented in the `app-test` recipe's comment block alongside the existing usage lines.
- The gated child always sees it set, so the ask happens exactly once per invocation.

#### [P11] Caller text is confined below fixed provenance chrome (DECIDED) {#p11-provenance-chrome}

**Decision:** `AppTestAskDialog` owns its icon and a fixed leading label identifying the request as coming from outside the app. The caller supplies only `title`, `description`, and option labels, and none of them can style, replace, or occupy the provenance row.

**Rationale:**
- [P02] deliberately declines eval's dev-mode gate so the ask works on a release instance. That is right for a consent prompt, but it means **any loopback process can raise a dialog inside the user's Session card**, and the payload is display text — which is precisely the impersonation vector. Without fixed chrome, a caller could render text that reads like a Claude permission prompt.
- The risk table originally described the payload as "display text plus opaque option ids", as though text were inert. It is not: the whole point of the surface is that the user reads it and acts on it.
- The mitigation is cheap and entirely presentational, so there is no reason to defer it.

**Implications:**
- The dialog is visually distinguishable from `PermissionDialog` at a glance — different `iconRole`, and a provenance line the caller cannot reach.
- `title` and `description` render as plain strings, never as rich/HTML content, so no markup rides in from the wire.
- This is chrome, not authentication. It raises the cost of impersonation; it does not authenticate the caller. Loopback remains the actual trust boundary.

---

### Deep Dives {#deep-dives}

#### End-to-end flow {#end-to-end-flow}

**Spec S01: The ask round trip** {#s01-ask-round-trip}

1. `just app-test <files…>` runs `bun scripts/select-tests.ts` to resolve the concrete file list (for `app-test-changed`) or normalizes the explicit list (for `app-test <files>` / the core tier).
2. The recipe asks `select-tests.ts --foreground <files…>` which files carry `@foreground`. Empty result → proceed directly to the gate, no network, no prompt.
3. Non-empty → `tugutil host ask` POSTs to `http://127.0.0.1:<port>/api/ask` with `{ sessionId, title, description, options[] }`. Port comes from `resolve_port(port, instance)` in `tugrust/crates/tugutil/src/commands/tell.rs`.
4. `ask_handler` in `tugrust/crates/tugcast/src/server.rs` checks loopback, mints a `requestId`, inserts a `oneshot::Sender` into `router.pending_asks`, and broadcasts `Frame::new(FeedId::CONTROL, {"action":"ask", requestId, sessionId, title, description, options})` on `router.stream_outputs`.
5. The deck's `registerAction("ask", …)` in `tugdeck/src/action-dispatch.ts` hands the payload to the pending-ask store, which routes it to the target session's `codeSessionStore` as `pendingAsk`.
6. `pendingAsk` non-null → session phase reports `awaiting_approval` ([P06]) and `AppTestAskDialog` mounts at session level ([P05]).
7. The developer picks an option and confirms. The store clears `pendingAsk` and calls `connection.sendControlFrame("ask-response", { requestId, choice })`.
8. `dispatch_action`'s `"ask-response"` arm removes the entry from `pending_asks` and sends the choice on the oneshot.
9. `ask_handler` returns `{"status":"ok","choice":"<id>"}`; `tugutil host ask` prints the id and exits 0.
10. The recipe exports `TUG_APPTEST_ASSUME=<choice>` and re-execs under the gate ([P09]). The gated child sees the variable and skips the ask.

#### The foreground inventory {#foreground-inventory}

These are the files that launch with `foreground: true` today, established by cross-referencing lifecycle-verb usage against launch sites. All 18 lifecycle-verb users were already marked; the remaining entries were marked while landing background mode.

**List L01: Files requiring `@foreground`** {#l01-foreground-files}

Lifecycle-verb users (`simulateAppResign` / `simulateAppBecomeActive` / `simulateAppHide` / `simulateAppUnhide`): `at0004-app-resign-return`, `at0005-app-hide-unhide`, `at0010-markdown-selection`, `at0014-cold-boot-scroll`, `at0014-scroll-persistence`, `at0017-savestate-rpc-parity`, `at0018-async-content-race`, `at0022-caret-visibility`, `at0027-layout-state-persistence`, `at0030-virtual-focus`, `at0035-dev-app-switch-selection`, `at0035-em-app-switch-selection`, `at0039-title-bar-return-focus-restore`, `at0078-dev-engine-focus-survives`, `at0136-stale-reapply-clobber`, `at0148-dialog-survives-reactivation`, `at0295-background-activation-click`, `at0306-open-quickly-default-dir`.

Non-lifecycle foreground cases: `at0126-keyboard-ring-cold-boot` (ring is captured on resign), `at0145-permission-dialog-keyboard` (gates on `document.hasFocus()`), `at0165-activation-first-responder` (Bug D only — Cmd-W responder routing needs a real key window), `at0209-picker-field-click-single-focus`.

The authoritative list is whatever the drift check derives; this snapshot exists so the implementer can sanity-check the checker's first run rather than trusting it blindly.

#### Why the declaration is a docblock tag and not a runtime signal {#why-declaration}

The gate must decide *before* launching anything — that is the entire point. A runtime signal (the harness reporting its mode after boot) arrives far too late: the app has already taken the screen. Static declaration is therefore forced, and the only question is what to parse. The launch-site option `foreground: true` is the ground truth but sits inside a TypeScript call expression, sometimes with other options interleaved (`at0126` passes it alongside `env`, `skipAccessibilityPreflight`, and `persistInTestMode`). The docblock tag is a stable, line-oriented, already-conventional surface, and the drift check is what keeps it honest.

---

### Specification {#specification}

#### Wire contract {#wire-contract}

**Spec S02: `POST /api/ask`** {#s02-api-ask}

Request:

```json
{
  "sessionId": "3f3f0119-…",
  "title": "3 of 12 app-tests will take the screen",
  "description": "at0145-permission-dialog-keyboard, at0165-activation-first-responder, at0014-scroll-persistence",
  "options": [
    { "value": "run-all", "label": "Run all", "description": "Includes the 3 that take the screen" },
    { "value": "run-background-only", "label": "Run background-only", "description": "Skips the 3 that take the screen" },
    { "value": "cancel", "label": "Cancel", "description": "Run nothing" }
  ]
}
```

Responses: `200 {"status":"ok","choice":"run-all"}`; `403 {"status":"error","message":"forbidden"}` (non-loopback); `400` (malformed); `500 {"status":"error","message":"deck disconnected"}`; `504 {"status":"error","message":"timeout waiting for answer"}`.

**Spec S03: CONTROL action pair** {#s03-control-actions}

Outbound (tugcast → deck), on `FeedId::CONTROL`: `{"action":"ask","requestId":"<uuid>","sessionId":"…"|null,"title":"…","description":"…","options":[…]}`.

Inbound (deck → tugcast), via `connection.sendControlFrame`: `{"action":"ask-response","requestId":"<uuid>","choice":"<option value>"}`.

#### CLI contract {#cli-contract}

**Spec S04: `tugutil host ask`** {#s04-cli-ask}

```
tugutil host ask --title <str> [--description <str>] --option <value>:<label>[:<description>] … [--timeout-secs <n>] [--port <n>] [--instance <id>]
```

Prints the chosen option's `value` to stdout on success. Exit codes: `0` answered (choice on stdout); `2` cancelled / timed out / deck disconnected; `3` no route to a dialog (no tugcast reachable) — callers treat this as "proceed without asking" per [P03].

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

Zone assignment is governed by [L24] (state is partitioned into appearance / local data / structure); [L02] is the delivery mechanism for the local-data rows, and [L06] for the appearance row.

| State | Zone (appearance / local-data / structure) | Mechanism | Laws |
|-------|--------------------------------------------|-----------|-----|
| `pendingAsk` (the live request) | local-data | store field on `codeSessionStore`, read via `useSyncExternalStore`; mutation nulls `_cachedSnapshot` | [L24], [L02] |
| `selectedOption` (radio selection before confirm) | local-data | `useState` in `AppTestAskDialog` — pre-commit draft, never leaves the component. `TugInlineDialog` is stateless by [L24] and assigns `selectedOption` to the consumer. | [L24] |
| Ask → Awaiting | local-data | a `SessionLifecycleOverlay` from `deriveLifecycleSnapshot`; the turn phase, `canSubmit`, and `canInterrupt` are untouched ([P06]) | [L24], [D01] |
| Dialog visibility / mount | structure | conditional render gated on the store snapshot | [L24], [L02] |
| Dialog styling, icon tint, provenance chrome | appearance | CSS in `session-app-test-ask-dialog.css`; `iconRole` prop; no React state ([P11]) | [L24], [L06] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugutil/src/commands/ask.rs` | `tugutil host ask` implementation ([S04](#s04-cli-ask)) |
| `tugdeck/src/lib/pending-ask-store.ts` | Receives `ask` actions, routes to the target session, sends `ask-response` |
| `tugdeck/src/components/tugways/chrome/session-app-test-ask-dialog.tsx` | `AppTestAskDialog`, composing `TugInlineDialog` ([P01]) |
| `tugdeck/src/components/tugways/chrome/session-app-test-ask-dialog.css` | Dialog styling ([L06]) |
| `tests/app-test/at0320-app-test-ask-dialog.test.ts` | End-to-end dialog + Awaiting coverage |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `PendingAsks` | type alias | `tugrust/crates/tugcast/src/router.rs` | Mirrors `PendingEvals`; new `pending_asks` field on `FeedRouter` + its initializer |
| `ask_handler` | async fn | `tugrust/crates/tugcast/src/server.rs` | Modeled on `eval_handler`; registered as `.route("/api/ask", post(ask_handler))`; loopback-only, **no** dev gate ([P02]) |
| `dispatch_action` | fn (modify) | `tugrust/crates/tugcast/src/actions.rs` | New `pending_asks` param; new `"ask-response"` arm; update call sites in `control.rs`, `main.rs`, and the in-file test setup |
| `HostCommands::Ask` | enum variant | `tugrust/crates/tugutil/src/cli.rs` | New subcommand under `pub enum HostCommands` |
| `registerAction("ask", …)` | call | `tugdeck/src/action-dispatch.ts` | Alongside the existing `"eval"` registration |
| `getByTugSessionId` | existing fn (use) | `tugdeck/src/lib/card-services-store.ts` | **Already exists** — the lookup from wire `sessionId` to the owning card's `codeSessionStore`. Do not write a new registry. |
| `pendingAsk` | store field | `tugdeck/src/lib/code-session-store.ts` | Added to the snapshot; must null `_cachedSnapshot` on mutation ([P06]) |
| `SessionLifecycleOverlay` member + `LifecycleStoreSignals.pendingAsk` | type + fn (modify) | `tugdeck/src/lib/code-session-store/lifecycle-state.ts` | The Awaiting overlay ([P06]); `deriveLifecycleState` stays untouched |
| `@foreground` parsing + `--foreground` / `--core` modes | fn | `tests/app-test/scripts/select-tests.ts` | Alongside `@covers`; plus bidirectional drift check ([P04]). `--core` hoists the core-tier list out of the `justfile` so it is resolvable pre-gate ([P09]) |
| `app-test-foreground-check` | recipe | `justfile` | Sibling of `app-test-covers-check` |
| `app-test` | recipe (modify) | `justfile` | Ask before the gate re-exec ([P09]); branch on `TUG_APPTEST_ASSUME` |

---

### Documentation Plan {#documentation-plan}

- [ ] `tests/app-test/README.md` — document `@foreground`, what marks a test foreground, and the approval prompt.
- [ ] `tuglaws/app-test-harness.md` — record that background is the default and the foreground tier is a declared, checked set.
- [ ] `justfile` — `app-test` comment block gains the `TUG_APPTEST_ASSUME` escape hatch and the ask behavior.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | `pending_asks` insert/remove/resolve; `"ask-response"` arm; option parsing in `ask.rs` | `cargo nextest run` |
| **Unit (TS)** | `@foreground` parsing and drift detection in `select-tests.ts` | `bun test` under `tests/app-test/scripts/` |
| **Integration (Rust)** | `/api/ask` end to end against a test router: loopback rejection, timeout, disconnect | `cargo nextest run` in `tugcast` |
| **App-test** | Real dialog in the real app: raise an ask, assert the dialog renders, assert phase is Awaiting, answer it, assert the response | `just app-test at0320-app-test-ask-dialog.test.ts` |
| **Contract** | The recipe branches correctly on each of the three choices | Shell-level checkpoint in [#step-7](#step-7) |

#### What stays out of tests {#test-non-goals}

- **A jsdom render test for `AppTestAskDialog`.** Fake-DOM render tests are banned in this project; the dialog is covered by a real app-test driving the real component.
- **Mock-store assertions for `pendingAsk`.** The store is exercised through the real round trip in the app-test, not by poking a fake store and asserting it changed.
- **`TugInlineDialog` itself.** Untouched by this plan ([P01]); its existing `tug-inline-dialog.test.ts` remains the coverage.
- **The foreground tests' own behavior.** Already covered; this plan only gates when they run.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | `@foreground` declaration and drift check | done | `29d51b9ba` |
| #step-2 | tugcast `/api/ask` route and `pending_asks` | done | `8e9d8d1bc` |
| #step-3 | `tugutil host ask` CLI verb | done | `f3df1550a` |
| #step-4 | Deck pending-ask store and action registration | done | `a1597b685` |
| #step-5 | `AppTestAskDialog` component | done | `3af10e343` |
| #step-6 | Session mount and Awaiting phase | done | `3af10e343` |
| #step-7 | Recipe gate | done | `d910e4e5a` |
| #step-8 | Integration checkpoint | done | `e415bad5b` |

---

#### Step 1: `@foreground` declaration and drift check {#step-1}

**Commit:** `apptest(foreground-tag): declare screen-taking tests with @foreground and check for drift`

**References:** [P04] Foreground declaration, [P09] Ask before the gate, List L01, (#why-declaration, #foreground-inventory)

**Artifacts:**
- `@foreground` tags in every file from List L01.
- `--foreground` and drift-check modes in `tests/app-test/scripts/select-tests.ts`.
- `app-test-foreground-check` recipe.

**Tasks:**
- [ ] Extend the docblock parser in `select-tests.ts` to read `@foreground` alongside `@covers`.
- [ ] Add `--foreground <files…>`: print the subset of the given files carrying the tag, one per line, stdout only. Match on **full filenames**, never test-id prefixes — `at0209-picker-field-click-single-focus` (foreground) and `at0209-text-card-live-autosave` (background, core tier) share the `at0209` prefix and must not be confused.
- [ ] Add `--core`: print the core-tier file list, one per line. Move the list verbatim out of the `justfile`'s `if [ -z "$FILES_INPUT" ]` branch (comments included) so there is exactly one definition ([P09]).
- [ ] Point the `justfile`'s core-tier branch at `select-tests.ts --core`.
- [ ] Add a drift check: a file whose source contains `foreground: true` must carry `@foreground`, and vice versa. Report both directions with the offending path. Exclude `_harness/index.ts`, which contains the option's *definition*, not a launch site.
- [ ] Add `app-test-foreground-check` to the `justfile`, mirroring `app-test-covers-check`.
- [ ] Tag every file in List L01.

**Tests:**
- [ ] Unit: a fixture with the tag and no `foreground: true` is reported as drift.
- [ ] Unit: a fixture with `foreground: true` and no tag is reported as drift.
- [ ] Unit: `--foreground` on a mixed list returns only the tagged files.
- [ ] Unit: `--foreground` given `at0209-text-card-live-autosave.test.ts` returns nothing (prefix-collision guard).

**Checkpoint:**
- [ ] `just app-test-foreground-check` exits 0 on the real corpus.
- [ ] `bun scripts/select-tests.ts --foreground at0001-tab-switch-fc.test.ts at0145-permission-dialog-keyboard.test.ts` prints only `at0145-permission-dialog-keyboard.test.ts`.
- [ ] `bun scripts/select-tests.ts --core` prints the same 20 files the `justfile` listed before the hoist (diff against the pre-change recipe).
- [ ] Temporarily delete one tag → the check exits non-zero naming that file; restore it.

---

#### Step 2: tugcast `/api/ask` route and `pending_asks` {#step-2}

**Commit:** `tugcast(ask): add POST /api/ask with a blocking deck round trip`

**References:** [P02] Mirror eval, [P07] Timeout is cancel, Spec S02, Spec S03, (#end-to-end-flow)

**Artifacts:**
- `PendingAsks` type and `pending_asks` field on `FeedRouter` in `router.rs`.
- `ask_handler` in `server.rs`, routed at `/api/ask`.
- `"ask-response"` arm in `dispatch_action`.

**Tasks:**
- [ ] Add `PendingAsks` alongside `PendingEvals` in `tugrust/crates/tugcast/src/router.rs`, plus the `pending_asks` field and its initializer.
- [ ] Write `ask_handler` in `server.rs` following `eval_handler`: loopback guard, JSON parse, `requestId`, oneshot registration, CONTROL broadcast, `timeout(600s)`. **Do not** copy the dev-mode/diag gate ([P02]).
- [ ] Register `.route("/api/ask", post(ask_handler))` in the router builder.
- [ ] Add the `"ask-response"` arm to `dispatch_action` in `actions.rs`, and thread `pending_asks` through its signature and its call sites in `control.rs` and `main.rs`.

**Tests:**
- [ ] Integration: a request from a non-loopback address gets 403.
- [ ] Integration: an `ask-response` with a matching `requestId` resolves the pending request with its `choice`.
- [ ] Integration: an unanswered request returns 504 after the timeout (use an injected short timeout, not a 600s test).
- [ ] Integration: a dropped sender yields 500.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` passes with no warnings.
- [ ] `cd tugrust && cargo build` clean under `-D warnings`.

---

#### Step 3: `tugutil host ask` CLI verb {#step-3}

**Depends on:** #step-2

**Commit:** `tugutil(ask): add host ask — raise a session dialog and print the choice`

**References:** [P03] Session-scoped and fail-open, [P07] Timeout is cancel, [P08] Computed options, Spec S04, (#cli-contract)

**Artifacts:**
- `tugrust/crates/tugutil/src/commands/ask.rs`.
- `HostCommands::Ask` in `cli.rs`.

**Tasks:**
- [ ] Add the `Ask` variant to `pub enum HostCommands` in `tugrust/crates/tugutil/src/cli.rs` with `--title`, `--description`, repeatable `--option`, `--timeout-secs`, `--port`, `--instance`.
- [ ] Implement `ask.rs`: parse `value:label[:description]` options, read `TUG_SESSION_ID` from the environment, resolve the port, POST to `/api/ask` following the pattern in `commands/draft.rs`.
- [ ] **Port resolution must tolerate a busy registry** ([P03]). `resolve_port` errors when more than one instance is live, which is the normal state during any app-test run. Prefer `--port` → `TUG_INSTANCE` → `find_for_cwd`, and when several remain, ignore ids beginning with `apptest-` before deciding; if still ambiguous, report "no route" (exit 3) rather than an error.
- [ ] Map outcomes to exit codes per Spec S04 — notably exit `3` (proceed, no route) when no port can be resolved or the connection is refused ([P03]).
- [ ] Print only the chosen `value` on stdout; all diagnostics to stderr.

**Tests:**
- [ ] Unit: option-spec parsing, including a description containing a colon.
- [ ] Unit: an option spec with no `:` separator is a usage error.
- [ ] Unit: a registry holding one real instance plus two `apptest-*` instances resolves to the real one.
- [ ] Integration: against a stub server returning a choice, stdout is exactly that value and exit is 0.
- [ ] Integration: connection refused → exit 3, nothing on stdout.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil` passes.
- [ ] `tugutil host ask --help` shows the documented flags.

---

#### Step 4: Deck pending-ask store and action registration {#step-4}

**Depends on:** #step-2

**Commit:** `tugdeck(ask): route ask actions to a session-scoped pending-ask store`

**References:** [P03] Session-scoped, [P06] Pending-ask phase, Spec S03, (#end-to-end-flow, #state-zone-mapping)

**Artifacts:**
- `tugdeck/src/lib/pending-ask-store.ts`.
- `registerAction("ask", …)` in `action-dispatch.ts`.
- `pendingAsk` on the `code-session-store` snapshot.

**Tasks:**
- [ ] Write `pending-ask-store.ts`: hold the live request, expose `subscribe` / `getSnapshot` ([L02]), and a `respond(choice)` that clears state and calls `connection.sendControlFrame("ask-response", { requestId, choice })`.
- [ ] Register the `"ask"` action in `tugdeck/src/action-dispatch.ts` next to the existing `"eval"` registration; validate `requestId` is a string and ignore the frame otherwise, matching eval's defensive shape.
- [ ] Route by `sessionId` using the **existing** `cardServicesStore.getByTugSessionId` in `tugdeck/src/lib/card-services-store.ts` — do not build a second registry. Fall back to the active session when `sessionId` is null ([P03]).
- [ ] Add `pendingAsk` to the `code-session-store` snapshot, nulling `_cachedSnapshot` on every mutation so `useSyncExternalStore` observes it ([L02]).
- [ ] Add the overlay in `code-session-store/lifecycle-state.ts`: extend `LifecycleStoreSignals` and `SessionLifecycleOverlay`, leaving `deriveLifecycleState`, `canSubmit`, and `canInterrupt` untouched ([P06]).
- [ ] Respond `cancel` automatically if the session is torn down while an ask is live, so the CLI is never left hanging.

**Tests:**
- [ ] Unit: an `ask` frame with a non-string `requestId` is ignored.
- [ ] Unit: `respond` sends `ask-response` with the matching `requestId` and clears the snapshot.
- [ ] Unit (in `code-session-store/__tests__/lifecycle-state.test.ts`): with `pendingAsk` set on an **idle** session, the lifecycle snapshot carries the ask overlay, `state` stays the idle row, and `submitButtonMode` is unchanged.
- [ ] Unit: `canSubmit` stays true and `canInterrupt` stays false while an ask is pending on an idle session — the regression [P06] exists to prevent.

These exercise the **real** `CodeSessionStore`, matching the existing precedent in `tugdeck/src/__tests__/` — not a hand-rolled mock store.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/` passes.
- [ ] `cd tugdeck && bunx tsc --noEmit` clean.

---

#### Step 5: `AppTestAskDialog` component {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(ask): add AppTestAskDialog composing TugInlineDialog`

**References:** [P01] Compose not author, [P08] Computed options, [P11] Provenance chrome, Risk R01, (#state-zone-mapping)

**Artifacts:**
- `tugdeck/src/components/tugways/chrome/session-app-test-ask-dialog.tsx` and its `.css`.

**Tasks:**
- [ ] Compose `TugInlineDialog` with `iconRole="caution"`, the request's `title`, its `description`, and its `options` mapped to `TugInlineDialogOption` (`{ value, label, description }`).
- [ ] Add the fixed provenance chrome ([P11]): an app-owned leading label marking the request as external, which the caller's `title` / `description` cannot style or displace. Render `title` and `description` as plain strings — no rich/HTML content from the wire.
- [ ] Hold the radio selection in `useState`, defaulting to the **safest** option (`run-background-only` when offered, else `cancel`) so the routine core-tier case is one keystroke and a mis-fire never seizes the screen ([R01]); render a single confirm button in the primitive's `actions` slot; own focus-on-mount on that button, as `PermissionDialog` does.
- [ ] Call `respond(selectedOption)` on confirm.
- [ ] Follow `session-permission-dialog.tsx` for structure, class naming, and the `data-slot` convention.
- [ ] Register the component in the gallery so it is inspectable, following `gallery-tug-inline-dialog.tsx`.

**Tests:**
- [ ] Covered end-to-end in [#step-8](#step-8); no jsdom render test ([#test-non-goals](#test-non-goals)).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build` succeeds (an import that works under dev esbuild can still fail the production rollup build).
- [ ] The gallery card renders the dialog with three options.

---

#### Step 6: Session mount and Awaiting phase {#step-6}

**Depends on:** #step-5

**Commit:** `tugdeck(ask): mount the app-test ask dialog at session level`

**References:** [P05] Session-level mount, [P06] Pending-ask phase, [Q01] Mount point, (#q01-mount-point)

**Artifacts:**
- `AppTestAskDialog` mounted in `session-card.tsx`.

**Tasks:**
- [ ] Mount `AppTestAskDialog` as a sibling of `SessionTranscriptHost` inside `.session-view-pane[data-view="transcript"]` in `tugdeck/src/components/tugways/cards/session-card.tsx`.
- [ ] Subscribe via `useSyncExternalStore` ([L02]); gate only on the pending-ask snapshot, never on `isLastAssistant` / `isCommitted` ([P05]).
- [ ] Build the element inline every render — no `useMemo` over the element — so Fast Refresh swaps the component (the same constraint `session-card-transcript.tsx` documents for `PermissionDialog`).
- [ ] Verify the Z2 STATE cell reads Awaiting from the overlay while an ask is pending, **and** that the composer stays live and the submit button keeps its idle mode ([P06]).

**Tests:**
- [ ] The matrix assertion lives in the pure-logic `code-session-store/__tests__/lifecycle-state.test.ts` (Step 4), not here.
- [ ] Re-run `at0084-session-lifecycle-coordination.test.ts` as a regression check — its Awaiting assertions are about the permission path and should be unaffected, which is the point.

**Checkpoint:**
- [ ] `just app-test at0084-session-lifecycle-coordination.test.ts` passes **unchanged** — if it needed edits, the overlay leaked into the turn phase and [P06] was violated.
- [ ] `cd tugdeck && bunx vite build` succeeds.

---

#### Step 7: Recipe gate {#step-7}

**Depends on:** #step-1, #step-3, #step-6

**Commit:** `apptest(gate): ask before running screen-taking tests`

**References:** [P08] Computed options, [P09] Ask before the gate, [P10] Assume flag, Spec S01, Spec S04, (#end-to-end-flow)

**Artifacts:**
- Ask logic in the `app-test` recipe in `justfile`.

**Tasks:**
The step has two halves on opposite sides of the re-exec; keep them straight ([P09]).

**Pre-gate (asks, never filters):**
- [ ] Resolve the selection before the `exec tugutil host gate run …` re-exec: normalize the given files the same way the recipe already does (strip `./` and `tests/app-test/`), or call `select-tests.ts --core` when `{{FILES}}` is empty (Step 1 hoisted that list).
- [ ] Query `select-tests.ts --foreground` on the resolved list.
- [ ] Skip everything when the foreground subset is empty, or when `TUG_APPTEST_ASSUME` is already set ([P10]).
- [ ] Build the option list per [P08] — omit `run-background-only` when the background subset is empty — and invoke `tugutil host ask`, passing `--instance "$TUG_INSTANCE"` when it is set ([P03]).
- [ ] `cancel` exits non-zero **here**, before any launch. Exit code 3 from the CLI proceeds with a stderr notice naming the foreground files ([P03], [R02]).
- [ ] Export the answer as `TUG_APPTEST_ASSUME` so it survives the re-exec. Do **not** try to rewrite the exec's `{{FILES}}` — it is a just template variable, not a shell one.

**Post-gate (filters, never asks):**
- [ ] When `TUG_APPTEST_ASSUME=background`, drop this invocation's own `@foreground` files from `FILES` after the list is resolved, and echo the skipped names to stderr.
- [ ] `all` proceeds unchanged.
- [ ] Document `TUG_APPTEST_ASSUME` in the recipe's comment block.

**Tests:**
- [ ] Contract: `TUG_APPTEST_ASSUME=cancel just app-test at0145-…` exits non-zero and launches nothing.
- [ ] Contract: `TUG_APPTEST_ASSUME=background just app-test at0001-… at0145-…` runs only `at0001` and names `at0145` on stderr.
- [ ] Contract: `TUG_APPTEST_ASSUME=all just app-test at0001-… at0145-…` runs both.

**Checkpoint:**
- [ ] `just app-test at0001-tab-switch-fc.test.ts` completes with no prompt and no `/api/ask` request.
- [ ] `just app-test at0145-permission-dialog-keyboard.test.ts` raises the dialog and blocks until answered.
- [ ] With tugcast stopped, the same command proceeds with the stderr notice rather than hanging.

---

#### Step 8: Integration checkpoint {#step-8}

**Depends on:** #step-2, #step-3, #step-4, #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** [P01]–[P10], Spec S01, (#success-criteria)

**Artifacts:**
- `tests/app-test/at0320-app-test-ask-dialog.test.ts`.

**Tasks:**
- [ ] Write the app-test: drive a real `/api/ask` against the running instance, assert the dialog renders with the expected options, assert the session phase is `awaiting_approval`, answer it natively, assert the HTTP response carries the chosen value and the dialog unmounts.
- [ ] Declare `@covers` for `tugdeck/src/lib/pending-ask-store.ts`, `tugdeck/src/components/tugways/chrome/session-app-test-ask-dialog.tsx`, and `tugrust/crates/tugcast/src/server.rs`.
- [ ] Confirm the new test does not itself need `@foreground` — it must run in the background like everything else.
- [ ] Walk each criterion in [#success-criteria](#success-criteria) and record the observed result.

**Tests:**
- [ ] `just app-test at0320-app-test-ask-dialog.test.ts`.
- [ ] `just app-test` (core tier) still 20/20.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` passes.
- [ ] `just app-test-covers-check && just app-test-foreground-check` both pass.
- [ ] `cd tugdeck && bunx vite build && bunx tsc --noEmit` clean.
- [ ] Every criterion in [#success-criteria](#success-criteria) verified.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** An app-test run that would seize the screen raises a session-inline dialog offering run-all / run-background-only / cancel, putting the session in Awaiting until answered; a run that stays in the background is never interrupted.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Background-only selections never prompt and never contact the deck (no `/api/ask` in the tugcast log).
- [ ] Mixed selections prompt, and each of the three choices behaves as specified (verified by the [#step-7](#step-7) contract checks).
- [ ] The session reports Awaiting while an ask is pending.
- [ ] `just app-test-foreground-check` passes and fails correctly on induced drift.
- [ ] `just app-test` core tier is 20/20 with the gate in place.
- [ ] No deck running → runs proceed with a notice rather than hanging.

**Acceptance tests:**
- [ ] `just app-test at0320-app-test-ask-dialog.test.ts`
- [ ] `cd tugrust && cargo nextest run`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] [Q03] Remembering an answer for a window of time. Promoted from "wait and see" to **watch from day one**: the core tier prompts on every run (see [#assumptions]), so this is likely to be needed sooner than the original draft assumed.
- [ ] Shrinking the foreground tier by re-examining whether individual lifecycle tests truly need real activation — the other lever on [R01].
- [ ] Authenticating `/api/ask` callers. [P11] is chrome, not authentication; loopback is the only real boundary today.

| Checkpoint | Verification |
|------------|--------------|
| Declaration is trustworthy | `just app-test-foreground-check` passes; induced drift fails it |
| Transport round trip works | `cargo nextest run -p tugcast` integration tests |
| Dialog renders and answers | `just app-test at0320-app-test-ask-dialog.test.ts` |
| Gate branches correctly | The three `TUG_APPTEST_ASSUME` contract checks in [#step-7](#step-7) |
| No regression | `just app-test` core tier 20/20 |
