# Dash landing loud failures — no silent refusals {#dash-landing-loud-failures}

**Purpose:** Make every dash-landing gesture — join, commit, release — produce either the act or a visible reason, never silence: a refusal contract in the landing controllers, one notice surface for all three verbs, a staged landing that cannot be lost, a durable receipt for every land press, and a corpus that finally presses the button.

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

**Round 1 — 2026-08-17, fable.** Reviewed `plan:58edbefa6df4c7ca`. Lint: 1 error, 1 warning (error fixed; the warning was this section's absence).
Oriented on: first review — the whole document, against the real code (`landing-mode.ts`, both landing controllers, `tug-prompt-entry.tsx`'s `performSubmit` and Z5 rail, `session-card.tsx`'s staging and notice mounts, `commit-error-notice-controller.tsx`, `changeset-verb-store.ts`, `agent_supervisor.rs`'s `handle_control`, `tug-pane-bulletin.tsx`, and the existing test tree).
Applied: test-plan layer — the notice-surface step proposed pure tests of React notice controllers, which cannot run (bun has no DOM substrate; no existing notice controller has a pure test); the posting decision is now a pure `landingNoticeDecision` function in `tugdeck/src/lib/landing-notice.ts`, pure-tested against the real controllers, with the on-screen posting pinned by the app-test. Law [L27] — the watchdog helper acquired two timers with no release; Spec S04 and the staged-landing step now carry `dispose()` called from the effect cleanup. Checkpoint precision — a `grep -c … returns 0` checkpoint (which exits non-zero on zero matches) rewritten as `! grep -q …`. Verified single-caller claim for `land()` (only `performSubmit`), the `releaseState(entryKey)` accessor, the `cards/__tests__/` location, and the `handle_control` arm shape against the tree.
Deferred: [Q01] (which gate condition refused on 2026-08-17) — deferred by the incident brief's own guardrail and the owner's standing instruction; the plan's receipts are its resolution path.

---

### Phase Overview {#phase-overview}

#### Context {#context}

On 2026-08-17 the Changes shade's Join button reproduced its "does nothing" failure on the `observer-rename` dash and, for the first time, left evidence. The full diagnosis is in [continuing-dash-join-failures.md](continuing-dash-join-failures.md): the release instance's `tugcast.log` shows three `dash-join: completed … previewed=true` receipts and no `preview: false` request ever — the preview path is healthy end to end, and the land never reached the wire. The proximate mechanism is a family of silent early returns: `performSubmit` in `tugdeck/src/components/tugways/tug-prompt-entry.tsx` calls `land()` without consulting the button's disabled state; `JoinModeController.land()` and `CommitModeController.land()` both `return` on a refused gate saying nothing; the staged re-checks in `performJoin`/`performCommit` refuse a beat later, also silently; a `verbStore === null` guard swallows an internal fault; and the staged landing parks the user's landing in `stagedCommitRef` awaiting a `sheetDidHide` that is not guaranteed to fire. The refusal sentence already exists (`joinDisabledReason` / `commitDisabledReason`) and reaches only a tooltip. Join has no error notice controller at all, so `JoinModeSnapshot.landError` is dead state; release errors (`changeset_release_err`) likewise settle into the verb store with no notice surface.

This is not one bug but a permission structure — `void` return types, bare `return`s, and a code comment blessing the no-op — and the brief's own ordering says the first fix is the diagnostic: once every refusal speaks, the next occurrence names its own gate condition in one press. Which condition refused on 2026-08-17 is deliberately **not** fixed here ([Q01]).

#### Strategy {#strategy}

- Write the doctrine down first as a numbered law, so every later step has something to cite and every future quiet early return has something to violate.
- Remove the *permission* for silence structurally: a single `refuse()` funnel inside each landing controller that records, logs, and publishes every refusal, plus a `LandOutcome` return type on `LandingMode.land()` so no caller can ignore the verdict by type.
- Give the refusal one surface: generalize the existing `CommitErrorNoticeController` over the `LandingMode` interface so commit and join share it, and give release its own equivalent — reuse the pane-bulletin channel, never invent a new one.
- Bound the staged landing with a watchdog so a missed `sheetDidHide` delays a landing by at most a second instead of losing it forever.
- Make the evidence durable: every land press sends a small receipt frame that tugcast writes to its log beside the join receipts, because the deck reload at 13:11:54 on 2026-08-17 would have destroyed any deck-side record.
- Only then let the corpus press the button — one end-to-end land through the real gesture, and one refused land asserting the sentence appears. The second test fails against today's code and is the regression pin for the whole family.
- Everything in this phase is behavior-preserving in the success case; the actual gate-condition fix waits for the evidence these changes produce ([Q01], [P06]).

#### Success Criteria (Measurable) {#success-criteria}

- Pressing a landing's land control while its gate refuses produces a visible bulletin carrying the gate's own sentence, in both commit and join modes (app-test asserts the bulletin text; pure tests assert the snapshot's refusal record).
- `LandingMode.land()` returns `LandOutcome`; `bunx tsc --noEmit` fails on any caller that discards silence-relevant refusal handling only if it type-errors — concretely: the composer compiles against the new signature and the blessing comment is gone (grep for "no-ops here" in `tug-prompt-entry.tsx` returns nothing).
- A join failure reported by the server (`changeset_join_err`) posts a sticky danger bulletin — `JoinModeSnapshot.landError` has a reader (pure test drives the verb store error and asserts the notice controller's post).
- A release failure (`changeset_release_err`) posts a sticky danger bulletin (pure test at the controller layer).
- A staged landing whose `sheetDidHide` never fires still lands within ~1 s and logs a fault line (pure test with a fake timer at the session-card helper layer; the corpus's end-to-end test passes regardless of which beat fires).
- Every land press — accepted or refused — writes one `landing-receipt` line into the instance's tugcast log with the gate inputs (Rust test drives `handle_control("landing_receipt", …)` and asserts the log call path; manual verification greps the live log after one press).
- `just app-test-changed` selects and passes the new at0433/at0434 tests; `cd tugrust && cargo nextest run` and `bun test` (tugdeck) stay green; `bunx vite build` clean.

#### Scope {#scope}

1. A new law in `tuglaws/tuglaws.md` (L31) stating the no-silent-refusals doctrine.
2. The refusal contract in `tugdeck/src/lib/landing-mode.ts`, `join-mode-controller.ts`, `commit-mode-controller.ts`, and the composer's submit path in `tug-prompt-entry.tsx`.
3. A generalized landing notice controller replacing `commit-error-notice-controller.tsx`, mounted for both landing modes, plus a release error notice controller; both mounted in `session-card.tsx`.
4. A watchdog on the staged landing in `session-card.tsx`.
5. A `landing_receipt` control frame: deck sender + tugcast `handle_control` arm that logs it.
6. Two new app-tests (at0433, at0434) and pure-logic tests in the controllers' existing test files.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Fixing whichever gate condition actually refused on 2026-08-17 — forbidden until the receipts name it ([Q01]).
- Changing the turn gate's policy (whether `turnInProgress` should block a landing at all) — the refusal now speaks and the button already live-re-enables when the turn ends; policy changes wait for evidence ([P06]).
- Any visual redesign of the landing surfaces, the shade, or the Z5 rail — only what happens on failure changes.
- The `dash-implement` skill's closing instruction ("run `/join`") — the product-side collision with the turn gate is recorded as a follow-on, not built here.

#### Dependencies / Prerequisites {#dependencies}

- The pane bulletin channel (`tugdeck/src/components/tugways/tug-pane-bulletin.tsx`) — `danger` / `warning` / `dismiss`, already mounted in the session card via `TugPaneBulletinProvider`.
- The dev log store (`tugdeck/src/lib/tug-dev-log-store/tug-dev-log-store.ts`, `tugDevLogStore.warn(topic, message, data)`).
- tugcast's control dispatch (`handle_control` match in `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs`) and the deck's `sendControlFrame` (on the connection from `@/lib/connection-singleton`).
- The dash lane app-test fixtures (at0418 already creates fixture dashes and drives real `changeset_join --preview` round trips; the recipe's stranded-fixture sweep cleans up).

#### Constraints {#constraints}

- WARNINGS ARE ERRORS in the Rust workspace (`tugrust/.cargo/config.toml`, `-D warnings`).
- Tugdeck laws: [L02] external state through `useSyncExternalStore` only (for rendered state), [L22] store-driven direct DOM (bulletins) must not round-trip through React render, [L03] `useLayoutEffect` for registrations events depend on, [L24] three state zones, [L06] appearance via CSS/DOM.
- App-tests never run from a dash worktree; the corpus refuses. Rust changes need `just build-app` before any app-test can see them.
- New app-tests must carry `@covers` headers; `just app-test-covers-check` enforces.
- No plan-step numbers in code, comments, test names, or commit messages.
- Background app-test windows run no rAF, so the shade's exit animation may never complete there; tests must not hang assertions off the animation beat (see Risk R03).

#### Assumptions {#assumptions}

- The pane bulletin's `warning` variant auto-dismisses and `danger` with `sticky: true` persists — matching the existing `CommitErrorNoticeController` usage.
- `handle_control` in `agent_supervisor.rs` is reachable from any deck control frame without an allowlist (the tugcode inbound allowlist governs deck→tugcode messages, not deck→tugcast control frames).
- at0433/at0434 are the next free app-test numbers (at0432 is the current highest).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Which gate condition refused the 2026-08-17 landing (OPEN → DEFERRED) {#q01-which-condition}

**Question:** Which of the join gate's five conditions (`turn`, `pending`, `outcome`, `unreviewed`, `empty-message`) returned `ok: false` when the Join press did nothing?

**Why it matters:** It is the actual defect the user hit. Evidence rules out `outcome`, `unreviewed`, and `empty-message`; `turnInProgress` leads (a possible stale `canInterrupt` across the 13:11:54 deck reload) but is unconfirmed — no tugcode traffic ran 13:05–13:14, so no turn was actually in flight.

**Plan to resolve:** Not guessed at. Once this plan lands, the next dead press posts the sentence *and* writes a `landing-receipt` log line carrying the full gate input; the condition names itself in one press. Fixing it is the follow-on ([P06], #roadmap).

**Resolution:** DEFERRED — by the incident brief's own guardrail ([continuing-dash-join-failures.md](continuing-dash-join-failures.md#which-condition), "Do not fix on this hypothesis"), reaffirmed by the owner's instruction to fix the family, not the guess.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Refusal notices read as noise on repeated presses | low | med | warnings auto-dismiss; one notice id per kind so re-posts replace, never stack | user reports notice fatigue |
| Watchdog double-fires the landing | high | low | one `runStaged()` null-swaps the ref; both beats call it; the second finds null | any double-landed receipt |
| Staged-path app-test flakes on animation timing | med | med | assertions wait on outcomes (wire receipt, mode exit), never on the animation beat; the watchdog guarantees the landing fires even with rAF suspended | red at0434 in CI |
| `landing_receipt` frame drifts from the gate's real inputs | low | low | the sender serializes the same `JoinLandGateInput`/`CommitLandGateInput` object passed to the gate — one value, two consumers | a receipt that disagrees with a refusal sentence |

**Risk R01: Double-surfacing the same refusal** {#r01-double-surfacing}

- **Risk:** The sentence now appears in the tooltip, the bulletin, and (for a staged re-check) alongside a re-entered mode — three voices for one refusal.
- **Mitigation:** The tooltip stays (it is the *before* affordance); the bulletin is the *after* affordance and auto-dismisses; notice ids are stable per kind so repeats replace in place.
- **Residual risk:** A user who hovers and presses sees the sentence twice. Acceptable — twice is not silence.

**Risk R02: The watchdog lands something the user thought was cancelled** {#r02-watchdog-lands}

- **Risk:** If the sheet is wedged and the user walks away, the landing fires ~1 s later anyway.
- **Mitigation:** The watchdog window is short (1 s); the gate was already checked at press time and is re-checked in `performJoin`/`performCommit` before the wire; the fault line is logged either way.
- **Residual risk:** A landing the user pressed for lands. That is the gesture honored, which is the intended behavior.

**Risk R03: Background app-test windows never fire `sheetDidHide`** {#r03-background-sheethide}

- **Risk:** With rAF suspended in background windows, the shade's exit animation may never complete, so the corpus would exercise the watchdog path rather than the `sheetDidHide` path.
- **Mitigation:** at0434 asserts outcomes (request on the wire, landed state, mode exit), not which beat ran them; the `sheetDidHide` beat itself is pinned by a pure test on the staging helper with fake timers.
- **Residual risk:** The real foreground `sheetDidHide` beat is exercised only by humans and the watchdog's disarm test. Accepted; the watchdog makes the distinction non-fatal by construction.

---

### Design Decisions {#design-decisions}

#### [P01] Refusals are surfaced by the controller, and `land()` reports by type (DECIDED) {#p01-refusal-contract}

**Decision:** Every refusing path in both landing controllers funnels through one private `refuse(...)` method that (1) writes a `landRefusal: { sentence, kind, seq }` record into the published snapshot, (2) logs the full gate input via `tugDevLogStore.warn("landing", …)`, (3) sends the durable receipt ([P05]), and (4) fires subscribers. Independently, `LandingMode.land(message)` changes from `void` to `LandOutcome` (`{ kind: "staged" | "fired" } | { kind: "refused"; sentence: string }`).

**Rationale:**
- Belt and suspenders: the controller surfacing its own refusals means no caller can *forget*; the return type means no caller can *ignore* without the compiler seeing it. Either alone leaves a door open — the composer's blessing comment proved callers will lean on the controller, and a controller-only fix leaves the next caller free to repeat it.
- `seq` (a monotonic counter, incremented per refusal) is what makes pressing twice speak twice: the notice controller re-posts on `seq` change, not on sentence change.
- The sentence comes from the existing `joinDisabledReason` / `commitDisabledReason` — one refusal, one wording, everywhere ([D123] one name, one producer, by analogy).

**Implications:**
- `LandingSnapshot` grows `landRefusal`; both controllers' `snapshotsEqual` compare it by `seq` and `sentence`.
- `joinDisabledReason` gains an `empty-message` sentence ("Write a join message") — today that reason falls through to the outcome switch and, on a clean outcome, reads the generic "This join cannot land yet".
- The composer's `performSubmit` compiles against `LandOutcome`; the "no-ops here" comment is deleted. The composer takes no UI action of its own on refusal (the controller already surfaced it) — receiving the verdict is the contract.

#### [P02] One notice surface, generalized over `LandingMode`; release joins it (DECIDED) {#p02-one-notice-surface}

**Decision:** `commit-error-notice-controller.tsx` becomes `landing-notice-controller.tsx`, parameterized by a `LandingMode`, mounted once per controller inside the session card's `TugPaneBulletinProvider`. It posts `landError` as a sticky danger notice (as today) and `landRefusal` as an auto-dismissing warning. A new `release-error-notice-controller.tsx` subscribes to the changeset verb store and posts `changeset_release_err` details the same way.

**Rationale:**
- Join finally gets what commit has had since `CommitErrorNoticeController` was written to kill exactly this bug shape ("the sheet flashing and returning with no word of why").
- Generalizing over the interface rather than copying the file means the next landing kind (if any) is covered at mount time, not at incident time.
- Release errors currently reach only the verb store; `use-landing-receipts.ts` reads release state for transcript receipts but surfaces no error. A dead press on Release today would be the same investigation all over again.

**Implications:**
- `session-card.tsx` mounts `<LandingNoticeController controller={commitModeController} />`, `<LandingNoticeController controller={joinModeController} />`, and `<ReleaseErrorNoticeController entryKey={changesController.entryKey} />` where `CommitErrorNoticeController` mounts today.
- Notice ids are per kind (`commit-error`, `join-error`, `commit-refusal`, `join-refusal`, `release-error`) so surfaces never fight over one toast.
- [L22]/[L03]/[L02] as in the existing controller: direct store subscription in `useLayoutEffect`, zero render.
- The posting *decision* is a pure function (`landingNoticeDecision(prev, snapshot)` in `tugdeck/src/lib/landing-notice.ts`, returning post/dismiss/none instructions the component applies to the bulletin api). This is what makes the layer testable: bun tests have no DOM substrate, so a React notice controller cannot be pure-tested — no existing notice controller has one. The pure tests drive the real landing controllers and the real decision function; the on-screen posting is pinned by the app-test that presses the button.

#### [P03] The staged landing carries a deadline — late beats lost (DECIDED) {#p03-staged-deadline}

**Decision:** `stage()` in `session-card.tsx` keeps its shape (park the callback, exit the mode, fire on `sheetDidHide` + 150 ms) but arms a ~1000 ms watchdog when it parks. `sheetDidHide` disarms the watchdog and runs the landing; watchdog expiry runs the landing anyway and logs a fault (`tugDevLogStore.warn("landing", "sheetDidHide never fired — watchdog landed the staged callback")`). Both beats call one `runStaged()` that null-swaps `stagedCommitRef` for exactly-once.

**Rationale:**
- The parked-forever hazard is real: the hide rides an effect keyed on `anyLandingActive`, and any state where that expression fails to transition strands the landing in a ref with no error, no timeout, no trace ([continuing-dash-join-failures.md](continuing-dash-join-failures.md#inventory)).
- Running the landing late honors the gesture; surfacing a fault instead would make the user press again. The gate is re-checked inside `performJoin`/`performCommit` before the wire, so a stale press cannot land something newly refusable.

**Implications:**
- The watchdog timer id lives in a ref (local data, [L24]) beside `stagedCommitRef`.
- A pure test pins both beats (fake timers): `sheetDidHide` before expiry → one run, disarmed; no `sheetDidHide` → one run at expiry plus the fault log.

#### [P04] A null store is a fault that speaks (DECIDED) {#p04-null-store-fault}

**Decision:** `verbStore === null` (or any missing dependency) on a land path routes through the same `refuse()` funnel with a fault sentence — "The changes service isn't connected — reload the card" — posted as a sticky danger notice, and is never a bare `return`.

**Rationale:**
- A missing store means the app is broken, not that the user did something wrong; the user must learn they are stranded by a fault, with a remediation, rather than wonder what they mistyped.

**Implications:**
- The `refuse()` record carries `kind: "gate" | "fault"`; the notice controller maps `fault` to sticky danger, `gate` to auto-dismissing warning.

#### [P05] Every land press leaves a durable receipt in tugcast's log (DECIDED) {#p05-durable-receipt}

**Decision:** On every `land()` press — accepted or refused — the deck sends a `landing_receipt` control frame (`getConnection()?.sendControlFrame("landing_receipt", payload)`) whose payload names the kind (`commit`/`join`), the verdict (`ok` or the gate reason), and the gate inputs. tugcast's `handle_control` gains a `"landing_receipt"` arm that writes one `tracing::info!` line and returns `Ok(())` — no reply frame, no state.

**Rationale:**
- The whole hunt turned on one backend log line; the deck-side record (dev log) dies with a reload, and the 2026-08-17 incident *contained* a deck reload. The only durable log an instance has is tugcast's.
- One line per press makes the next incident a read: the log shows the press, the verdict, the inputs, and whether a `changeset_join` with `preview: false` followed.

**Implications:**
- A small sender helper (`tugdeck/src/lib/landing-receipt.ts`) serializes the same gate-input object the gate evaluated — one value, two consumers, no drift.
- The Rust arm parses defensively (missing fields log as `-`) — a receipt must never itself be refusable.
- The send is fire-and-forget; a null connection degrades to the dev-log line alone (and that degradation is itself logged).

#### [P06] The gate-condition fix and turn-gate policy wait for evidence (DECIDED) {#p06-evidence-first}

**Decision:** This plan changes nothing about *when* a landing is refused — only that refusals speak, land, or leave receipts. The `turnInProgress` gate stays; its refusal now speaks and the button already re-enables live when the turn ends (the snapshot recomputes on `codeSessionStore` changes). Fixing the actual 2026-08-17 condition, and any policy change (queueing a landing to fire on turn end, narrowing the gate, reconciling `dash-implement`'s closing "run `/join`" instruction with the gate), happens in a follow-on once a receipt names the condition.

**Rationale:**
- The brief's guardrail: making the refusal visible is both the fix and the diagnostic, which is the right order. A speculative gate fix is the forbidden third path.

**Implications:**
- #roadmap carries the follow-on explicitly.

#### [P07] The doctrine becomes law L31 (DECIDED) {#p07-law-l31}

**Decision:** `tuglaws/tuglaws.md` gains a new section (`## Refusals and Failure Surfaces`) with `### L31. A user gesture produces either the act or a visible reason — never silence. {#l31}`: a control that can refuse must route its refusal to a surface the user is looking at; a bare `return` on a user gesture, a swallowed internal fault, and a callback parked on an event that may never fire are all violations; a comment blessing any of them is a defect in the comment as much as the code.

**Rationale:**
- The doctrine already exists in scattered artifacts (`CommitErrorNoticeController`'s docblock, the lane's refusal sentences, the landing receipts); the landing controllers are where it was written as prose and not applied. A numbered law gives the next quiet early return something to violate and reviews something to cite.

**Implications:**
- Later commits in this plan cite [L31]; the incident brief is referenced from the law's paragraph as its grounding.

---

### Deep Dives {#deep-dives}

#### The land gesture's path, before and after {#land-path}

Today: `performSubmit` (`tug-prompt-entry.tsx`) → `landingModeRef.current?.land(doc)` → gate check (`liveGate` in `join-mode-controller.ts`; inline `evaluateCommitLandGate` in `commit-mode-controller.ts`) → on refusal, bare `return` → on pass, `landHook(runLand)` parks the callback in `stagedCommitRef` (`session-card.tsx`), exits the mode, waits for `sheetDidHide`, then `window.setTimeout(staged, 150)` → `performJoin`/`performCommit` re-check the gate (bare `return` again, with a mode re-enter) → `verbStore.join(...)` / `changesController.commit(...)` → wire.

After this plan: the same path, with every refusal branch calling `refuse()` (snapshot record + dev log + receipt frame + notice), `land()` returning `LandOutcome`, the parked callback under a watchdog, and the null-store branch a spoken fault. The success path is byte-for-byte the same behavior.

#### Where the sentence lives {#sentence-sources}

`joinDisabledReason(reason, outcome)` (`join-mode-controller.ts`) and `commitDisabledReason(reason)` (`commit-mode-controller.ts`) are the only producers of refusal prose, by their own docblocks ("a refusal that reads differently in two places is worse than one that reads tersely in both"). `refuse()` calls them with the gate's reason; the notice controller renders the string verbatim. The one gap: `joinDisabledReason` has no `empty-message` arm (falls to the outcome switch), fixed in [P01].

#### The receipt payload {#receipt-payload}

```json
{
  "kind": "join",
  "verdict": "refused",
  "reason": "turn",
  "sentence": "Wait for the turn to finish",
  "gate": {
    "turnInProgress": true,
    "joinPhase": "idle",
    "outcome": "clean",
    "candidateCommit": null,
    "unreviewedResolution": false,
    "messageLen": 214
  }
}
```

`verdict: "ok"` carries `gate` with `reason`/`sentence` omitted. Commit's `gate` object carries `commitPhase` and `fileCount` instead of the join fields. The Rust arm logs one line: `landing-receipt: kind=join verdict=refused reason=turn gate={…}`. Message *length*, never message text — the draft's words do not belong in a log.

---

### Specification {#specification}

**Spec S01: `LandOutcome` and `LandingRefusal`** {#s01-land-outcome}

In `tugdeck/src/lib/landing-mode.ts`:

```ts
export type LandOutcome =
  | { kind: "staged" }   // handed to the host's land hook
  | { kind: "fired" }    // ran inline (no hook installed)
  | { kind: "refused"; sentence: string };

export interface LandingRefusal {
  /** The human sentence, from the mode's own *DisabledReason producer. */
  sentence: string;
  /** "gate" = the mode's land gate refused; "fault" = a broken dependency. */
  kind: "gate" | "fault";
  /** Monotonic per-controller counter — a repeat press must speak again. */
  seq: number;
}
```

`LandingSnapshot` gains `landRefusal: LandingRefusal | null` (null until the first refusal; cleared on mode exit and on an accepted land). `LandingMode.land` becomes `land: (message: string) => LandOutcome`.

**Spec S02: the `refuse()` funnel** {#s02-refuse-funnel}

Each controller implements `private refuse(kind: "gate" | "fault", sentence: string, gateInput: object): void` — increments the seq counter, writes `landRefusal` into the snapshot, fires subscribers, calls `tugDevLogStore.warn("landing", sentence, gateInput)`, and calls the receipt sender ([P05], Spec S03). Call sites: `land()`'s gate check, `performJoin`/`performCommit`'s staged re-check (which also keeps its existing mode re-enter), and the `verbStore === null` guards. Accepted lands call the receipt sender with `verdict: "ok"` from `land()` after the gate passes.

**Spec S03: the `landing_receipt` frame** {#s03-receipt-frame}

Deck: `sendLandingReceipt(payload)` in `tugdeck/src/lib/landing-receipt.ts` — `getConnection()?.sendControlFrame("landing_receipt", payload)`; on a null connection, `tugDevLogStore.warn("landing", "receipt not sent — no connection", payload)`. tugcast: a `"landing_receipt"` arm in the `handle_control` match (`tugrust/crates/tugcast/src/feeds/agent_supervisor.rs`, beside `"changeset_join"`), logging one `tracing::info!` line with defensively-parsed fields and returning `Ok(())`. Payload shape per (#receipt-payload).

**Spec S04: the staged-landing watchdog** {#s04-watchdog}

Extract the staging into a small testable helper (`tugdeck/src/components/tugways/cards/staged-landing.ts`): `createStagedLanding({ onFault })` returning `{ stage(run), sheetDidHide(), dispose() }` with the ref, the 150 ms post-hide delay, the 1000 ms watchdog, and the exactly-once null-swap inside. `session-card.tsx`'s land-hook effect and `useSheetDelegate` call into it; the effect's cleanup calls `dispose()`, which clears both timers and drops any parked callback ([L27] — every acquisition returns its release). `onFault` logs via `tugDevLogStore`.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `landRefusal` on the landing snapshots | structure | controller store + subscribers; notice controller subscribes directly | [L02], [L22] |
| bulletin posts (refusal warning, error danger) | appearance | direct DOM via the pane bulletin (Sonner), registered in `useLayoutEffect` | [L22], [L03], [L06] |
| staged callback + watchdog timer | local data | refs inside the staged-landing helper | [L24] |
| receipt frames / dev-log lines | (not UI state) | fire-and-forget side effects from the controller | — |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/cards/landing-notice-controller.tsx` | Generalized notice controller over `LandingMode` (replaces `commit-error-notice-controller.tsx`) |
| `tugdeck/src/components/tugways/cards/release-error-notice-controller.tsx` | Posts `changeset_release_err` details as a sticky danger bulletin |
| `tugdeck/src/components/tugways/cards/staged-landing.ts` | The staged-landing helper: park, `sheetDidHide` beat, watchdog, exactly-once, `dispose()` |
| `tugdeck/src/lib/landing-notice.ts` | `landingNoticeDecision` — the pure posting decision the notice component applies |
| `tugdeck/src/lib/landing-receipt.ts` | `sendLandingReceipt` — the durable receipt sender |
| `tests/app-test/at0433-landing-refusal-speaks.test.ts` | Refused land press → bulletin sentence, mode intact |
| `tests/app-test/at0434-join-land-press.test.ts` | End-to-end join land through the real button |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `LandOutcome`, `LandingRefusal` | type | `tugdeck/src/lib/landing-mode.ts` | Spec S01 |
| `LandingSnapshot.landRefusal` | field | `tugdeck/src/lib/landing-mode.ts` | published refusal record |
| `LandingMode.land` | signature | `tugdeck/src/lib/landing-mode.ts` | `void` → `LandOutcome` |
| `JoinModeController.refuse`, `.land`, `.performJoin` | method | `tugdeck/src/lib/join-mode-controller.ts` | Spec S02; `snapshotsEqual` compares `landRefusal` |
| `joinDisabledReason` | fn | `tugdeck/src/lib/join-mode-controller.ts` | gains `empty-message` → "Write a join message" |
| `CommitModeController.refuse`, `.land`, `.performCommit` | method | `tugdeck/src/lib/commit-mode-controller.ts` | Spec S02 |
| `performSubmit` landing branch | fn | `tugdeck/src/components/tugways/tug-prompt-entry.tsx` | receives `LandOutcome`; blessing comment deleted |
| `LandingNoticeController` | component | new file above | mounts replace `CommitErrorNoticeController` in `session-card.tsx` |
| `ReleaseErrorNoticeController` | component | new file above | subscribes to `getChangesetVerbStore()` release state |
| `createStagedLanding` | fn | new file above | Spec S04; `session-card.tsx` land-hook effect + `useSheetDelegate` rewire onto it |
| `"landing_receipt"` arm | match arm | `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` | Spec S03; one `tracing::info!`, no reply |
| `L31` | law | `tuglaws/tuglaws.md` | [P07]; new `## Refusals and Failure Surfaces` section |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/tuglaws.md` — L31, grounded in the incident brief ([P07]).
- [ ] `roadmap/continuing-dash-join-failures.md` — no edits; it remains the incident record this plan cites.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Pure-logic (bun)** | The refusal contract, seq semantics, watchdog beats, notice posting | `tugdeck/src/lib/__tests__/{join,commit}-mode-controller.test.ts`, new helper tests |
| **App-test (real app)** | The gesture chain the corpus has never pressed: submit → gate → stage → wire | at0433, at0434 |
| **Rust integration** | The `landing_receipt` arm parses and logs without error | `agent_supervisor.rs` tests beside the existing `handle_control` tests |

#### What stays out of tests {#test-non-goals}

- No fake-DOM/RTL/jsdom render tests and no mock-store assertion tests — banned shapes; the pure tests drive the real controllers over the real stores, and the gesture is covered in the real app.
- No test of the tooltip (it is unchanged existing behavior, pinned elsewhere by at0417's button-word assertion).
- No per-mutator pin tests on the snapshot fields — `snapshotsEqual` changes are covered by the behavior tests that depend on refire.
- The real foreground `sheetDidHide` beat end-to-end — Risk R03; the pure helper test pins both beats with fake timers instead.
- The notice controllers' React component layer — bun tests have no DOM substrate (no existing notice controller has a pure test); the pure decision function carries the logic coverage and the app-test carries the on-screen coverage.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The law: no silent refusals | done | `4b3006435` |
| #step-2 | The refusal contract in the landing controllers | done | `eb3020824` |
| #step-3 | One notice surface for commit, join, and release | done | `1df4819d6` |
| #step-4 | The staged landing cannot be lost | done | `fc446746d` |
| #step-5 | Every land press leaves a durable receipt | done | `563c055b2` |
| #step-6 | The corpus presses the button | done | `5842bb127` |
| #step-7 | Integration checkpoint | done | `5842bb127` |

#### Step 1: The law: no silent refusals {#step-1}

**Commit:** `tuglaws(l31): a user gesture produces the act or a visible reason`

**References:** [P07] The doctrine becomes law L31, (#context, #sentence-sources)

**Artifacts:**
- `tuglaws/tuglaws.md`: new `## Refusals and Failure Surfaces` section with `### L31. A user gesture produces either the act or a visible reason — never silence. {#l31}` and a grounding paragraph naming the three violation shapes (bare `return` on a gesture, swallowed internal fault, callback parked on an event that may never fire) and citing `roadmap/continuing-dash-join-failures.md` as the incident that established it.

**Tasks:**
- [ ] Write the law text following the file's existing entry format (short imperative heading, one grounding paragraph, cross-references in brackets).

**Tests:**
- [ ] None — a doc-only step.

**Checkpoint:**
- [ ] `grep -n "L31" tuglaws/tuglaws.md` shows the heading and anchor.

---

#### Step 2: The refusal contract in the landing controllers {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(landing): every landing refusal speaks — the refuse() funnel and the LandOutcome contract [L31]`

**References:** [P01] Refusal contract, [P04] Null store is a fault, Spec S01, Spec S02, (#land-path, #sentence-sources, #state-zone-mapping)

**Artifacts:**
- `tugdeck/src/lib/landing-mode.ts`: `LandOutcome`, `LandingRefusal`, `landRefusal` on `LandingSnapshot`, `land` returns `LandOutcome`.
- `tugdeck/src/lib/join-mode-controller.ts` and `commit-mode-controller.ts`: the `refuse()` funnel wired into every refusing path (`land()` gate, staged re-check, null-store guards); `landRefusal` in `derive()`/`snapshotsEqual`; refusal cleared on `exit()` and on an accepted `land()`; `joinDisabledReason` gains the `empty-message` sentence.
- `tugdeck/src/components/tugways/tug-prompt-entry.tsx`: the landing branch of `performSubmit` compiles against `LandOutcome`; the "no-ops here" blessing comment is deleted.

**Tasks:**
- [ ] Add the types and the snapshot field (Spec S01); thread `landRefusal: null` through both `derive()` implementations and both `snapshotsEqual`.
- [ ] Implement `refuse()` in both controllers (Spec S02) — snapshot record + `tugDevLogStore.warn("landing", …)`; leave the receipt-sender call as a stub hook to be filled by the receipt step (a local no-op function, not a silent omission — the dev-log line fires from this step on).
- [ ] Convert every refusing path: `JoinModeController.land`/`performJoin`, `CommitModeController.land`/`performCommit`, both `verbStore === null` guards ([P04], fault sentence "The changes service isn't connected — reload the card").
- [ ] Give `joinDisabledReason` its `empty-message` arm ("Write a join message").
- [ ] Update `performSubmit` and any other `land()` caller to the new signature.

**Tests:**
- [ ] `tugdeck/src/lib/__tests__/join-mode-controller.test.ts`: a refused `land()` returns `{ kind: "refused" }` with the gate's sentence and publishes `landRefusal` with `seq` 1; a second refused press publishes `seq` 2; an accepted land clears `landRefusal`; the staged re-check refusal publishes and still re-enters the mode; the null-verb-store path publishes a `fault` refusal.
- [ ] `tugdeck/src/lib/__tests__/commit-mode-controller.test.ts`: the same shapes on the commit side.
- [ ] A pure test that `joinDisabledReason("empty-message", "clean")` reads "Write a join message".

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/join-mode-controller.test.ts src/lib/__tests__/commit-mode-controller.test.ts`
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `! grep -q "no-ops here" tugdeck/src/components/tugways/tug-prompt-entry.tsx` (the blessing comment is gone).

---

#### Step 3: One notice surface for commit, join, and release {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(landing): one notice surface — refusals and land errors speak for commit, join, and release [L31]`

**References:** [P02] One notice surface, [P04] Null store is a fault, Spec S01, (#state-zone-mapping, #sentence-sources)

**Artifacts:**
- `tugdeck/src/components/tugways/cards/landing-notice-controller.tsx` (new): generalized over `LandingMode`; posts `landError` as sticky danger (id `<kind>-error`), `landRefusal` as auto-dismissing warning for `kind: "gate"` and sticky danger for `kind: "fault"` (id `<kind>-refusal`), re-posting on `seq` change.
- `tugdeck/src/components/tugways/cards/release-error-notice-controller.tsx` (new): subscribes to `getChangesetVerbStore()`, posts the release error detail for the card's entry key as sticky danger (id `release-error`), dismissing when the error clears.
- `tugdeck/src/components/tugways/cards/commit-error-notice-controller.tsx` deleted; `session-card.tsx` mounts the three controllers inside the existing `TugPaneBulletinProvider`.

**Tasks:**
- [ ] Extract the posting decision into `landingNoticeDecision` (`tugdeck/src/lib/landing-notice.ts`) — inputs: the previous posted state and the current `LandingSnapshot`; outputs: post-danger / post-warning / dismiss / none instructions with notice id and text ([P02]).
- [ ] Write `LandingNoticeController` from `CommitErrorNoticeController`'s shape ([L22] direct subscription, [L03] `useLayoutEffect`, zero render), applying the decision function's instructions to the bulletin api.
- [ ] Write `ReleaseErrorNoticeController` over the verb store's `releaseState(entryKey)`.
- [ ] Rewire the mounts in `session-card.tsx`; delete the old file.

**Tests:**
- [ ] Pure tests driving the real stores and the real decision function: feed the real changeset verb store a `changeset_join_err` frame through its message handler → the join controller's snapshot carries `landError`, and `landingNoticeDecision` says post-danger, then dismiss when a later `pending` clears it; a refusal `seq` bump on the real controller → the decision says post-warning again; a `changeset_release_err` frame → the release state carries the error detail. The on-screen posting itself is pinned by the app-test that presses the button (#step-6) — bun tests have no DOM substrate, so the component layer is deliberately not pure-tested (#test-non-goals).

**Checkpoint:**
- [ ] `cd tugdeck && bun test` (the tugdeck suite)
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`

---

#### Step 4: The staged landing cannot be lost {#step-4}

**Depends on:** #step-2

**Commit:** `tugdeck(landing): the staged landing carries a watchdog — late beats lost [L31]`

**References:** [P03] Staged deadline, Spec S04, Risk R02, Risk R03, (#land-path, #state-zone-mapping)

**Artifacts:**
- `tugdeck/src/components/tugways/cards/staged-landing.ts` (new): `createStagedLanding` per Spec S04.
- `session-card.tsx`: the land-hook effect and the `sheetDidHide` delegate rewired onto the helper; the raw `stagedCommitRef` + `window.setTimeout(staged, 150)` pair moves inside it.

**Tasks:**
- [ ] Implement the helper: park, 150 ms post-hide delay, 1000 ms watchdog, exactly-once null-swap, `dispose()` clearing both timers ([L27]), `onFault` callback logging via `tugDevLogStore.warn("landing", …)`.
- [ ] Rewire `session-card.tsx`'s `stage()` closure and `useSheetDelegate` onto it, preserving the existing "exit the mode if active, else hide the shade" dismissal choice; the effect cleanup calls `dispose()`.

**Tests:**
- [ ] Pure tests with fake timers on `createStagedLanding`: hide before expiry → one run, no fault; no hide → one run at expiry plus the fault callback; hide after expiry → no second run; a second `stage()` after a run parks fresh.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/components/tugways/cards/__tests__/staged-landing.test.ts` (create the test beside the corpus's existing card-layer pure tests)
- [ ] `cd tugdeck && bunx tsc --noEmit`

---

#### Step 5: Every land press leaves a durable receipt {#step-5}

**Depends on:** #step-2

**Commit:** `tugcast+tugdeck(landing): every land press leaves a landing-receipt line in the instance log [L31]`

**References:** [P05] Durable receipt, Spec S02, Spec S03, (#receipt-payload)

**Artifacts:**
- `tugdeck/src/lib/landing-receipt.ts` (new): `sendLandingReceipt(payload)` per Spec S03; both controllers' `refuse()` and accepted-land paths call it (replacing the stub hook from the contract step).
- `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs`: the `"landing_receipt"` match arm — defensive parse, one `tracing::info!` line (`landing-receipt: kind=… verdict=… reason=… gate=…`), `Ok(())`, no reply frame.

**Tasks:**
- [ ] Implement the sender; serialize the exact gate-input object the gate evaluated, with `messageLen` in place of message text.
- [ ] Add the tugcast arm beside `"changeset_join"` in `handle_control`.
- [ ] `just build-app` so the running instances carry the arm.

**Tests:**
- [ ] Rust: a `handle_control("landing_receipt", …)` test beside the existing control tests — a well-formed payload returns `Ok`, a payload with missing fields returns `Ok` (defensive parse, logged with `-` placeholders), and neither produces a reply frame.
- [ ] Pure (tugdeck): a refused land with a live connection sends one frame with `verdict: "refused"` and the gate's reason; an accepted land sends `verdict: "ok"`; a null connection logs the degradation line.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit`

---

#### Step 6: The corpus presses the button {#step-6}

**Depends on:** #step-3, #step-4, #step-5

**Commit:** `app-test(landing): the corpus presses the land button — one landing, one spoken refusal`

**References:** [P01] Refusal contract, [P02] One notice surface, [P03] Staged deadline, Risk R03, (#success-criteria, #test-non-goals)

**Artifacts:**
- `tests/app-test/at0433-landing-refusal-speaks.test.ts`: drives a refused land and asserts the sentence appears. Fixture: a dash whose preview yields the `empty` outcome (a fixture dash with no commits past base, per the at0418 fixture pattern) → enter join mode via the lane's Join affordance → type a message → press the land button → assert an on-screen bulletin containing "Nothing to join", the mode still active, and the typed text intact. `@covers` lines: `tugdeck/src/lib/join-mode-controller.ts`, `tugdeck/src/components/tugways/cards/landing-notice-controller.tsx`, `tugdeck/src/components/tugways/tug-prompt-entry.tsx`.
- `tests/app-test/at0434-join-land-press.test.ts`: the end-to-end landing. Fixture: a dash with one committed round → aim, enter join mode, type a message, press the land button → assert the join lands (the dash leaves the lane / the landed receipt row appears) and the mode exits. Assertions wait on outcomes, never the animation beat (Risk R03). `@covers` lines: `tugdeck/src/lib/join-mode-controller.ts`, `tugdeck/src/components/tugways/cards/staged-landing.ts`, `tugdeck/src/components/tugways/cards/session-card.tsx`.

**Tasks:**
- [ ] Build both tests on the at0418 fixture machinery (fixture dashes against the app-test instance's own workspace; the recipe's stranded-fixture sweep already covers cleanup).
- [ ] Verify at0433 fails against pre-plan code (checkout sanity: without the notice surface the bulletin assertion cannot pass) — this is the family's regression pin.

**Tests:**
- [ ] The two files above are the tests.

**Checkpoint:**
- [ ] `just app-test-covers-check`
- [ ] `just app-test tests/app-test/at0433-landing-refusal-speaks.test.ts tests/app-test/at0434-join-land-press.test.ts`

---

#### Step 7: Integration checkpoint {#step-7}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** [P01]–[P07], (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Run the full derived selection and the workspace suites; confirm the success path is behaviorally unchanged (an ordinary commit and an ordinary join land exactly as before, with receipts).
- [ ] Manual receipt check: one land press in a debug instance, then grep the instance's tugcast log for `landing-receipt:`.

**Tests:**
- [ ] The aggregate suites below.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`
- [ ] `cd tugrust && cargo nextest run`
- [ ] `just app-test-changed`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A dash landing surface on which no gesture can fail silently — every refusal speaks its gate's sentence, every server failure posts a notice, a staged landing lands late rather than never, every press leaves a durable log receipt, and the corpus presses the real button both ways.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] L31 exists in `tuglaws/tuglaws.md` and the plan's commits cite it (`git log --grep=L31`).
- [ ] `LandingMode.land` returns `LandOutcome`; no bare-`return` refusal remains in either landing controller (`grep -n "return;" tugdeck/src/lib/{join,commit}-mode-controller.ts` shows only benign non-gesture guards).
- [ ] A refused land press shows the gate's sentence on screen (at0433 green).
- [ ] A real join lands through the button (at0434 green).
- [ ] A land press writes a `landing-receipt:` line into the instance's tugcast log (manual grep, per the integration checkpoint).
- [ ] All suites green: tugdeck `bun test` + `tsc` + `vite build`, `cargo nextest run`, `just app-test-changed`.

**Acceptance tests:**
- [ ] at0433-landing-refusal-speaks
- [ ] at0434-join-land-press

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Read the next occurrence's `landing-receipt` line and fix the actual gate condition ([Q01], [P06]) — the only sanctioned path to that fix.
- [ ] The turn-gate design collision: `dash-implement` ends by instructing `/join` while the turn gate refuses landings mid-turn; decide whether the landing queues on turn end or the instruction moves ([P06]).
- [ ] If receipts show a stale `canInterrupt` across deck reloads, fix its rehydration in `CodeSessionStore`.
- [ ] Consider a Session-card surface for the receipt history (a "last refused because…" line in the lane), if refusal bulletins prove too transient.

| Checkpoint | Verification |
|------------|--------------|
| Refusals speak | at0433; pure controller tests |
| Landing lands through the button | at0434 |
| Receipts durable | tugcast log grep after one press |
| Success path unchanged | integration checkpoint's ordinary commit + join |
