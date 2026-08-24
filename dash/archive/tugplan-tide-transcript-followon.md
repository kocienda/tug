<!-- tugplan-skeleton v2 -->

## Tide Transcript — Interrupt, Atoms, Prefetching, Close-out {#tide-transcript-followon}

**Purpose:** Four small follow-ons to the [Tide transcript resume work](./tugplan-tide-transcript-resume.md). Three were absorbed from the parent [tugplan-tug-list-view.md](./tugplan-tug-list-view.md) roadmap during planning but didn't ship in the resume plan's recovery saga; the fourth (banner mount-time gate) surfaced from dogfooding the loading strip on fast replays. This is the cleanup pass:

1. **Phase-aware interrupt** — split cancellation into the pre-first-delta case (CASE A — `phase === "submitting"`, the wire is silent, no `activeMsgId` exists) and the post-first-delta cases (CASE B — `phase ∈ {awaiting_first_token, streaming, tool_work, awaiting_approval}`, claude has produced content under an `activeMsgId`). CASE A returns the user's prompt text + atoms to the editor for re-edit and emits no transcript entry; CASE B keeps the existing committed-interrupted-turn path unchanged.
2. **Atom-aware user rows** — `UserRowCell` switches from a plain `<span>` body to a body that renders `userMessage.attachments` as inline atoms when present, falling back to plain text for legacy or attachment-empty turns.
3. **Banner minimum-mount-time gate** — `TugBanner` and `TugPaneBanner` gain a `minMountedMs` prop (default 500) that holds the visible state for at least that long after first appearing, so a fast order-in / order-out cycle can't produce a sub-perceptual flash. Adopted for the "Loading session" pane banner in tide cards.
4. **`TugListView` prefetching protocol** — `delegate.prefetchForIndices(indices)` / `delegate.cancelPrefetchForIndices(indices)` plus a viewport-prediction window. Delegate-only; consumers decide what to prefetch.

Concludes with a tuglaws cross-check pass and updates the parent roadmap rows to "shipped."

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | tugplan-tide-transcript-followon |
| Last updated | 2026-05-07 |
| Roadmap anchor | [tugplan-tug-list-view.md #roadmap](./tugplan-tug-list-view.md#roadmap) — atom-aware user rows + prefetching protocol were absorbed from this anchor; the sticky-seed item shipped via other means and a phase-aware interrupt step joined the plan in its place |
| Predecessors | [tugplan-tide-transcript-resume.md](./tugplan-tide-transcript-resume.md) (closed 2026-05-04 — resume from JSONL ships, mid-turn deferred to its own investigation). The work here builds on the surfaces that plan put in place: `TideTranscriptDataSource`, `UserRowCell`, `TugListView` |
| Successors | parent [tugplan-tide-card-polish.md](./tugplan-tide-card-polish.md) §step-12 (markdown styling) and §step-13 (thinking + tool surfaces); an eventual `tugplan-tug-list-view-v2-imperative-pool.md` resolves live-turn flicker via imperative DOM pooling |
| Related | [tugplan-tide-mid-turn-replay.md](./tugplan-tide-mid-turn-replay.md) — the mid-turn investigation that was extracted from the resume plan rather than completed in line; outcomes there are independent of this plan and don't gate it |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The resume work landed in [tugplan-tide-transcript-resume.md](./tugplan-tide-transcript-resume.md): JSONL replay translates per-session JSONLs into `CODE_OUTPUT` events, the reducer handles the bracket, the request_replay verb supports HMR / Reload / cold-boot recovery. Smokes A, B, C verified end-to-end.

What didn't ship in the resume plan: three small absorbed polish items the parent `tugplan-tug-list-view.md` flagged as "right away" follow-ons. They share a theme — they polish the data-source / cell-renderer / list-view surface — but they're not part of the resume gap proper. Pulling them into the resume plan made it sprawl; closing the resume plan separately and shipping these as their own focused phase keeps the work units sized for clean review.

The mid-turn case (Smoke D) is *not* in this plan. It's its own investigation in [tugplan-tide-mid-turn-replay.md](./tugplan-tide-mid-turn-replay.md) because it requires architectural changes (msg_id canonicalization, durability guarantees) that the resume plan's design space couldn't accommodate.

#### Strategy {#strategy}

- **Land each item in its own commit** — one commit per step, no bundling.
- **Reuse existing tests as much as possible** — the resume plan put down adapter, cell-renderer, and list-view test infrastructure. Each step extends one of those test files.
- **Tuglaws cross-check at every step.** Each touches a different zone (data source = structure, cell renderer = data + tokens, list-view = structure-zone primitive). Confirm zone discipline holds.
- **Build stays green at every commit.** `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run` pass on every step. Warnings are errors.

#### Success Criteria (Measurable) {#success-criteria}

- An interrupt fired while `phase === "submitting"` (CASE A — no `activeMsgId`, scratch empty) restores the user's prompt text + atoms back into the editor surface, leaves the transcript untouched, and lands the snapshot at `phase: "idle"` after the wire's `turn_complete(error)` rolls in. (Verified: reducer tests for the submitting-phase interrupt path; integration assertion that the editor reflects the restored draft.)
- An interrupt fired while `phase ∈ {awaiting_first_token, streaming, tool_work, awaiting_approval}` (CASE B) preserves today's behavior — partial scratch commits as a `TurnEntry` with `result: "interrupted"`. (Verified: existing `code-session-store.interrupt.test.ts` regression coverage continues to pass; one additional case for the `awaiting_first_token` boundary.)
- The `user` cell renderer accepts `AtomSegment[]` content and renders atoms inline alongside text once `userMessage.attachments` carries the typed shape. (Verified: cell-renderer unit test against a fixture turn whose `attachments` is `AtomSegment[]`.)
- A banner with `minMountedMs={500}` that flips `visible: true → false` within ~50ms of mount stays on screen for at least 500ms before its exit animation begins; once committed to exit, a re-asserted `visible: true` is ignored until the banner has fully unmounted. The replay-loading pane banner in tide cards exhibits this behavior on fast resumes. (Verified: `TugPaneBanner` and `TugBanner` unit tests for fast-unmount, slow-unmount, re-entry-rejection, and `minMountedMs={0}` opt-out.)
- The `TugListView` prefetching protocol exposes `delegate.prefetchForIndices` and `delegate.cancelPrefetchForIndices` and dispatches them based on a viewport-prediction window; a delegate that opts in observes prefetch / cancel calls in correct order on scroll. (Verified: `TugListView` unit tests.)
- Tuglaws cross-check passes per-step.
- `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run` green at every step.

#### Scope {#scope}

1. **Phase-aware interrupt path** in `CodeSessionStore`'s reducer + `TugPromptEntry`'s submit/interrupt handler. The reducer's `handleInterrupt` branches on phase: when `state.phase === "submitting"` (CASE A — wire was silent, no `activeMsgId`, scratch empty), it captures `pendingUserMessage` into a one-shot snapshot slot for the editor to consume, marks the in-flight cycle so the eventual `turn_complete(error)` does not append a phantom transcript entry, and clears `pendingUserMessage` immediately so the in-flight pair stops rendering. CASE B (post-first-delta) is unchanged from today.
2. **Atom-aware user rows.** `UserRowCell` switches from a plain `<span>` body to a body that renders `userMessage.attachments` as inline atoms when present, falling back to plain text for legacy or attachment-empty turns.
3. **Banner minimum-mount-time gate.** `TugPaneBanner` and `TugBanner` (status variant) accept a `minMountedMs` prop (default 500). When a parent flips `visible: true → false` before the floor has elapsed, the exit animation is deferred until the floor is reached; the banner then runs its existing exit and unmount path. Once committed to exit, the gate ignores any subsequent `visible: true` until the unmount completes — matching the user-stated rule that an ordered-out banner "can't be revived/canceled/restored." Adopted for the `replay-loading` branch of `renderTideCardBanner` in `tide-card.tsx`.
4. **`TugListView` prefetching protocol.** `delegate.prefetchForIndices(indices)` / `delegate.cancelPrefetchForIndices(indices)` plus a viewport-prediction window. Delegate-only — `TugListView` does not assume any specific prefetch behavior; consumers decide.
5. **Tuglaws walkthrough + plan close-out**, mirroring the parent plan's pattern.

Out of scope:

- Mid-turn reload (Smoke D) — its own investigation in [tugplan-tide-mid-turn-replay.md](./tugplan-tide-mid-turn-replay.md).
- Imperative DOM cell pooling (its own plan, see [#roadmap]).
- Markdown styling pass for assistant output (parent §step-12).
- Thinking + tool surfaces inside `code` rows (parent §step-13).

---

### Phases and Steps {#phases-and-steps}

#### Phase A — Transcript surfaces (interrupt, atom rendering, banner gate) {#phase-a}

#### Step 1.1: Phase-aware interrupt — restore prompt for CASE A, commit-interrupted for CASE B {#step-1-1}

**Commit:** `tide(interrupt): split CASE A (submitting) from CASE B (post-first-delta)`

**Background:** The dividing line is the first content frame from claude carrying an `msg_id` — verified by walking the wire types (`tugcode/src/types.ts` has no per-turn ack frames preceding content), the tugcode session loop (`tugcode/src/session.ts:2755`'s `handleUserMessage` writes the `user_message` to claude's stdin and waits on the active turn whose `currentMessageId` slot stays null until the first stream event), and the v2.1.105 `test-06-interrupt-mid-stream` fixture's recorded ordering (no intermediate frames between `system_metadata` and the first `assistant_text` partial). In reducer terms that's the `submitting → awaiting_first_token` transition (text/thinking partial) or the `submitting → tool_work` transition (tool_use first). Equivalently: `state.activeMsgId === null` ⇔ CASE A; `state.activeMsgId !== null` ⇔ CASE B.

CASE A — `state.phase === "submitting"`. The wire received the `user_message` frame but claude has not produced anything keyed to a `msg_id` yet. `pendingUserMessage` carries exactly what the user just sent. The user's intent ("I clicked stop because claude hadn't picked it up") wants the editor seeded with that text + atoms so they can edit and resubmit. No transcript entry should appear.

CASE B — `state.phase ∈ {awaiting_first_token, streaming, tool_work, awaiting_approval}`. `activeMsgId` is set, `scratch[activeMsgId]` may have partial text/thinking/tool-use content. The existing committed-interrupted path applies (per `code-session-store.interrupt.test.ts`); the wire's eventual `turn_complete(error)` commits a `TurnEntry` with `result: "interrupted"`. No change.

**Artifacts:**

- `tugdeck/src/lib/code-session-store/types.ts`:
  - Add a `pendingDraftRestore: { text: string; atoms: ReadonlyArray<AtomSegment> } | null` slot to the snapshot (and the underlying state). Set by the reducer when CASE A fires; cleared by the prompt entry once the editor has consumed the restore (one-shot read, dispatched back through a public `consumePendingDraftRestore()` method, mirroring how live state is mutated through reducer events rather than fields).
  - Document the `interruptOrigin: "submitting" | null` reducer-internal state field used to route the eventual `turn_complete(error)` to the right branch (suppress-transcript for CASE A, append-interrupted for CASE B).
- `tugdeck/src/lib/code-session-store/reducer.ts`:
  - `handleInterrupt` branches on `state.phase`. For `submitting`: capture `state.pendingUserMessage` into `pendingDraftRestore`, set `interruptOrigin = "submitting"`, clear `pendingUserMessage` immediately so the in-flight pair stops rendering, clear `queuedSends` (current behavior), emit the `interrupt` send-frame effect (current behavior). For all other interruptible phases: behave exactly as today (clear `pendingApproval` / `pendingQuestion`, restore `prevPhase` from `awaiting_approval`, send the interrupt frame). Continue to no-op for `idle` / `errored` / `replaying`.
  - `handleTurnComplete` for `result: "error"`: when `interruptOrigin === "submitting"`, do NOT append a `TurnEntry`; clear the origin flag, clear `pendingUserMessage` / scratch / activeMsgId / toolCallMap as the existing path does, and return to `idle`. CASE B falls through unchanged and commits the interrupted entry.
  - Add a `consume_draft_restore` reducer event that clears `pendingDraftRestore` to `null`.
- `tugdeck/src/lib/code-session-store.ts`:
  - Surface `pendingDraftRestore` on the snapshot.
  - Expose `consumePendingDraftRestore(): void` as a public method that dispatches `consume_draft_restore`.
- `tugdeck/src/components/tugways/tug-prompt-entry.tsx`:
  - Read `snap.pendingDraftRestore` from the existing `useSyncExternalStore` snap. In a `useLayoutEffect` keyed on the slot's identity, replace the editor's doc with `restore.text` and re-emit atoms via `regenerateAtomsEffect` (the same pathway the editor uses for state preservation), then call `codeSessionStore.consumePendingDraftRestore()` so the slot clears in the next snapshot.
  - Restore happens regardless of focus state — the user just clicked the Stop button, so the editor should already be the natural focus target; if not, focus follows via the existing post-action focus restore.
- Test extensions in `tugdeck/src/lib/code-session-store/__tests__/code-session-store.interrupt.test.ts`:
  - CASE A: `send` → assert `phase === "submitting"` → `interrupt()` → snapshot has `pendingDraftRestore` set with the original text/atoms, `pendingUserMessage` cleared, `queuedSends` cleared, transcript empty, `interrupt` frame written. Then dispatch `turn_complete(result: "error")` from the wire; transcript stays empty, snapshot lands at `phase: "idle"`.
  - CASE A consumption: after the snapshot has `pendingDraftRestore` set, call `consumePendingDraftRestore()` and assert the slot clears to `null`.
  - `awaiting_first_token` boundary: drive in exactly one `assistant_text` partial → assert `phase === "awaiting_first_token"` → `interrupt()` → wire `turn_complete(error)` → transcript has one entry with `result: "interrupted"` carrying that single partial's text. (Pins the "first delta is the boundary" invariant.)

**Tasks:**

- [x] Add `pendingDraftRestore` + `pendingCaseAEchoes` to `CodeSessionState` and surface `pendingDraftRestore` on the snapshot. (Design E — counter, not boolean. The original task description called it `interruptOrigin: "submitting" | null`; in-flight investigation showed a single boolean can't represent multiple in-flight aborted cycles, so the field shipped as `pendingCaseAEchoes: number`. See the in-tree wire probes `tugcode/probe-case-a.ts` and `tugcode/probe-case-a-race.ts` for the empirical grounding.)
- [x] Branch `handleInterrupt` on `state.phase === "submitting"` (CASE A increments the counter; CASE B path unchanged).
- [x] Add the suppression gate at the top of `handleTurnComplete` (`pendingCaseAEchoes > 0 && activeMsgId === null && result === "error"` → decrement and drop). Reset the counter on `transport_close` so stranded echoes don't survive a reconnect.
- [x] Add `consume_draft_restore` reducer event + `consumePendingDraftRestore()` public method.
- [x] Wire the editor restore path inside `TugPromptEntry` via `useLayoutEffect`.
- [x] Author tests for both paths.

**Tests:**

- [x] CASE A: `submitting` → `interrupt()` populates `pendingDraftRestore`, clears `pendingUserMessage`, suppresses the transcript entry on the wire's `turn_complete(error)`, lands snapshot at `idle`.
- [x] CASE A queued sends: any prior queued sends are wiped (current behavior preserved — the user re-edits one prompt; queue is not restored).
- [x] CASE A consumption: `consumePendingDraftRestore()` clears the slot to `null`.
- [x] CASE A re-submit-before-echo race (Design E): wire FIFO ordering means the aborted echo arrives before any frame from the new turn, the counter survives `handleSend`, and the gate suppresses the echo cleanly.
- [x] CASE A back-to-back cancels: two pending suppressions drained in FIFO order; a subsequent fresh-turn pre-content error commits an interrupted entry as expected.
- [x] CASE A transport reset: `transport_close` resets `pendingCaseAEchoes` to 0 so a stranded echo can't carry across a reconnect.
- [x] CASE B `awaiting_first_token` boundary: one partial in, then `interrupt()` → `turn_complete(error)` commits a `TurnEntry` with `result: "interrupted"` carrying that partial's text.
- [x] CASE B regressions: existing mid-stream + awaiting_approval interrupt cases pass unchanged.

**Tuglaws cross-check:**

- **L02** — `pendingDraftRestore` lives on the snapshot; the prompt entry consumes it via `useSyncExternalStore`, not by ref-reading the store directly.
- **L03** — the editor restore runs in `useLayoutEffect` so the doc replacement is visible in the same paint as the snapshot transition (no flash of an empty editor).
- **L07** — the prompt entry's restore handler reads the snapshot slot at dispatch / effect time; no captured-at-mount stale closure.
- **L11** — interrupt is already a `TUG_ACTIONS.SUBMIT` action; no new actions introduced.
- **L24** — phase-branching logic stays in the reducer (data zone); the prompt entry zone only consumes the resulting snapshot slot.

**Open questions / decisions:**

- *Submitting timeout.* There is no client-side timeout on the `submitting` phase today, so a card can sit indefinitely if the wire stalls. Tabled by the user; tracked separately for a follow-on step.
- *Queued sends on CASE A.* Current `handleInterrupt` clears `queuedSends` unconditionally; this step preserves that. If a future case wants to re-enqueue them as drafts, it's a separate step.

**Checkpoint:**

- [x] `bun x tsc --noEmit` — exit 0.
- [x] `bun test` — green (3004 tugdeck + 339 tugcode).
- [x] `cargo nextest run` — green (1256 tests).
- [x] `bun run audit:tokens lint` — zero violations.

---

#### Step 2: Atom-aware `user` row body {#step-2}

**Depends on:** [Step 1.1](#step-1-1)

**Commit:** `tide(transcript): atom-aware user-row body`

**References:** parent plan [§step-11's D11](./tugplan-tug-list-view.md#d11-atom-aware-row)

**Artifacts:**

- `tugdeck/src/lib/code-session-store/types.ts` — narrow `userMessage.attachments` from `ReadonlyArray<unknown>` to `ReadonlyArray<AtomSegment>` once the prompt entry's atom flow reaches transcript form. (Gating note: if the prompt entry hasn't shipped that change, this step ships a `userMessage.attachments?: ReadonlyArray<AtomSegment>` opt-in instead.)
- `tugdeck/src/components/tugways/cards/tide-card-transcript.tsx` — `UserRowCell` renders `attachments` as inline atoms alongside `text` when present. Falls back to plain text when `attachments` is empty.
- Test extensions in `tugdeck/src/__tests__/tide-card-transcript.test.tsx` — fixture turn whose `attachments` carries one or two `AtomSegment`s; assert the rendered DOM has the atom elements inline.

**Tasks:**

- [ ] Verify whether the prompt entry's atom flow exposes `AtomSegment[]` on submission today; gate the type change accordingly.
- [ ] Update `UserRowCell` to render atoms inline.
- [ ] Add the test fixture and assertions.

**Tests:**

- [ ] Atom-bearing user message: rendered DOM contains the atom elements with their atom-specific attributes.
- [ ] Atom-empty user message (regression): renders plain text; no atom elements.

**Tuglaws cross-check:**

- **L19** (component authoring guide) — `UserRowCell`'s `data-slot` and `@tug-renders-on` annotations stay accurate when the body grows.
- **L15 / L16 / L18** — atom rendering uses element/surface tokens consistent with the parent atom-img pattern; no new tokens introduced here.

**Checkpoint:**

- [ ] `bun x tsc --noEmit` — exit 0.
- [ ] `bun test` — green.
- [ ] `bun run audit:tokens lint` — zero violations.
- [ ] `cargo nextest run` — green.

---

#### Step 3: Banner minimum-mount-time gate {#step-3}

**Depends on:** [Step 2](#step-2)

**Commit:** `tugways(banners): minMountedMs gate to suppress flash-and-vanish`

**Background:** Card-level surfaces driven by short-lived state can mount and unmount inside a single perceptual frame. Concretely: when `deriveTideCardBannerSpec` flips from `replay-loading` to `none` within ~50–200ms (a JSONL replay that resolves before the soft-budget ever fires), the loading strip gets just enough screen time for the user to see motion but not enough to read it — the visual reads as "something flashed and broke." The same pattern applies to any of `TugPaneBanner`'s transient kinds (transport blip during reconnect, `replay-timeout` dwell collapsing under a fast retry).

`TugPaneBanner` already owns a presence-across-exit-animation hold via its internal `mounted` state and `lastVisiblePropsRef`. The gate is a small extension: don't let the *exit animation* start until the banner has been visible for at least `minMountedMs` since first becoming visible. The hold reuses the existing `mounted` machinery so the parent's reconciliation contract doesn't change.

`renderTideCardBanner` in `tide-card.tsx` already returns a single `<TugPaneBanner>` from each spec branch — React reconciles those JSX returns as the same instance, so adopting the gate is a one-prop change on the active branch; no parent restructuring required.

**Semantics:**

- `minMountedMs` is the floor on visibility duration, measured from the first paint where `visible: true`. Default `500`.
- When `visible` flips false: if `now - shownAt >= minMountedMs`, the exit animation runs immediately (today's behavior). Otherwise the exit is deferred by `minMountedMs - (now - shownAt)` ms; after the deferral, the existing exit animation starts and the existing `g.finished → setMounted(false)` chain unmounts the portal.
- During the deferral, the banner keeps showing the *held* props (today's `lastVisiblePropsRef` value), exactly as it would during a normal exit-in-flight.
- Once an exit is committed (deferral pending or animation in flight), subsequent `visible: true` from the parent is **ignored** until `mounted` flips back to false. After that, a fresh `visible: true` starts a normal enter cycle and resets `shownAt`. ("It can't be revived/canceled/restored" — the user's rule.)
- `minMountedMs={0}` opts out — the gate is a no-op and today's behavior is preserved exactly.
- Timing uses `performance.now()` (monotonic; survives wall-clock skew) and a single `setTimeout` for the deferral. The cleanup function clears the timer; there is no in-flight animation to cancel during the deferral window because we haven't started one yet. Once the timeout fires and the existing exit animation begins, today's `g.finished.then(setMounted(false)).catch(setMounted(false))` chain runs unchanged — including the case where the parent unmounts the banner mid-animation (React swallows the late `setMounted` on an unmounted component, same as today).

**Lifecycle event behavior under the gate:**

The existing `useBannerLifecycle` events (`bannerWillShow` / `bannerDidShow` / `bannerWillHide` / `bannerDidHide`) keep their meanings; the gate changes their *timing* in two ways:

- **`bannerWillHide` fires on the parent's `visible: true → false` transition (today's contract), even when the actual unmount is deferred.** A subscriber that uses `willHide` to start prefetching focus restoration will start that work `dwell + exit-anim` ms before `didHide`, instead of just `exit-anim` ms before. Acceptable; the contract is still "the parent intends the banner to leave."
- **`bannerDidShow` is *more* reliable under the gate.** Today, a fast `visible: true → false` interrupts the enter animation and `g.finished` rejects, so `didShow` is swallowed by the `.catch` on its emission. With the gate, the enter animation has time to complete (because the floor is at least 500ms and a typical enter is 200–300ms), so `didShow` fires reliably for short-lived banners. Subscribers that depend on `didShow` to land focus or finalize layout get a more deterministic signal.
- **Late `visible: true → false → true → false` flips during the deferral do not emit additional `willHide` or `willShow` events.** Once `committedToExitRef` is true, the gate ignores both directions until `mounted` returns to false. The next *clean-cycle* `visible: true` (after a real unmount) re-arms `prevVisibleForLifecycleRef` and emits a fresh `willShow`.
- **`bannerDidHide` fires once, at the moment `mounted` flips false** (after the deferred exit completes). Unchanged from today's contract; the gate just pushes the moment later.

**Artifacts:**

- `tugdeck/src/components/tugways/tug-pane-banner.tsx`:
  - Add `minMountedMs?: number` to `TugPaneBannerProps`. Default `500`.
  - Add `shownAtRef: React.MutableRefObject<number | null>` initialised null. **Record it in the enter-animation effect** (the `(visible && mounted)` `useLayoutEffect` that calls `g.animate(...)` for the slide-in), guarded by `if (shownAtRef.current === null) shownAtRef.current = performance.now();`. This keeps the timestamp ~one frame closer to actual paint than recording it in the presence effect — the presence effect runs *before* `mounted` flips, so its `setMounted(true)` is followed by a re-render and a second `useLayoutEffect` cycle before paint. Recording in the enter-animation effect (which runs in the post-`setMounted` render, just before paint) gives a more honest "first visible on screen" floor.
  - Add `committedToExitRef: React.MutableRefObject<boolean>` initialised false. Add `deferredExitTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>` initialised null so cleanup paths can find the pending timer.
  - Modify the existing exit-animation effect so that on `(!visible && mounted)`: set `committedToExitRef.current = true`; compute `remaining = max(0, minMountedMs - (performance.now() - (shownAtRef.current ?? performance.now())))`; if `remaining > 0`, schedule the existing exit-animation body via `setTimeout(remaining)`, store the handle in `deferredExitTimerRef`, and return a cleanup that clears the timer; otherwise run today's body directly.
  - Modify the presence effect so it short-circuits when `committedToExitRef.current === true` and `visible: true` arrives — i.e., do not flip `mounted: false → true`, do not call `bannerWillShow`, and (by extension) do not affect `prevVisibleForLifecycleRef` so a later real-cycle `false → true` flip is still detected. The gate owns presence until `mounted` returns to false.
  - When the existing `g.finished` → `setMounted(false)` runs, also reset `shownAtRef.current = null`, `committedToExitRef.current = false`, and `deferredExitTimerRef.current = null` so the next `visible: true` starts cleanly.
- `tugdeck/src/components/tugways/tug-banner.tsx`:
  - Add `minMountedMs?: number` to `TugBannerProps`. Default `500`. Apply the gate to the **status variant only** — that's the variant with the slide-in / slide-out pair the gate makes sense for. The error variant is conditionally rendered by `ErrorBoundary` as terminal fallback UI (it never toggles), so passing `minMountedMs` is silently ignored there.
  - The status variant's animation logic lives inside one `useLayoutEffect`; track `shownAtRef` and `committedToExitRef` analogously, and defer the slide-out branch by `remaining` ms when needed. The inert-removal `.finished` chain naturally follows the deferred exit.
- `tugdeck/src/components/tugways/cards/tide-card.tsx`:
  - In `renderTideCardBanner`'s `replay-loading` branch, pass `minMountedMs={500}` explicitly (the default would suffice, but the explicit prop reads as intent at the motivating call site).
  - In `renderTideCardBanner`'s `error` branch, pass `minMountedMs={0}` — user-visible failures should exit on dismiss without a 500ms hold (see Tasks).
  - Add a docstring note to `renderTideCardBanner`: *"All branches return `<TugPaneBanner>` at the same JSX position with no `key` — this is intentional. React reconciles them as a single instance so the banner can hold props and gate min-mount-time across kind transitions. Do not key these branches by `spec.kind`; doing so would unmount-then-mount on every kind change and silently disable the gate."*
- Test extensions in `tugdeck/src/__tests__/tug-pane-banner.test.tsx`:
  - **Fast unmount**: render `<TugPaneBanner visible={true} minMountedMs={500} … />`, advance fake timers to `t = 50ms`, re-render with `visible={false}`. Assert the banner DOM is still in the document at `t = 200ms` and at `t = 499ms`; assert it is gone by `t = 500ms + exit-anim-duration + 1`.
  - **Slow unmount**: render visible, advance to `t = 600ms`, re-render visible=false. Assert the exit animation starts immediately (no deferral observed — the banner DOM begins unmounting on the same tick the exit animation finishes).
  - **Re-entry rejection**: render visible at `t = 0`, re-render visible=false at `t = 100ms`, re-render visible=true at `t = 200ms`. Assert the banner still unmounts at `~t = 500ms + exit-anim-duration` (the late `visible: true` was ignored). After unmount, a subsequent re-render with `visible=true` starts a fresh enter cycle (`shownAt` resets).
  - **Opt-out**: `minMountedMs={0}` — fast unmount path matches today's behavior exactly (exit animation starts on the same tick `visible` flips false).
  - **Test-harness setup caveat**: the gate compares `performance.now()` to `shownAt`. happy-dom's `performance.now()` reads the real clock by default, so `vi.useFakeTimers()` alone will *not* fake the gate's clock — the test will appear green while actually racing the wall clock, and a slow CI runner can flip the result. Configure the test with `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })`, *or* expose a `nowMs?: () => number` prop on the banner (default `performance.now`) and inject a fake clock from tests. Pick one approach and use it consistently across both banner test files.
- Test extensions in `tugdeck/src/__tests__/tug-banner.test.tsx` (or create the file if it doesn't exist) — the same four cases for the status variant, with the same fake-clock setup.

**Tasks:**

- [x] Add `minMountedMs` prop + gate to `TugPaneBanner` (record `shownAt` in the enter-animation effect; track `committedToExitRef` and `deferredExitTimerRef`; reset all four — including `prevVisibleForLifecycleRef` — when `mounted` flips false).
- [x] Add `minMountedMs` prop + gate to `TugBanner` (status variant only). Inert tracking moved to a dedicated `inertOwnerRef` + unmount-only `useEffect` so the deferral can survive effect re-runs without stripping inert mid-flight.
- [x] Adopt `minMountedMs={500}` for the `replay-loading` branch in `renderTideCardBanner`.
- [x] Adopt `minMountedMs={0}` for the `error` branch in `renderTideCardBanner` (opt-out — user-visible failures should not be held).
- [x] Add the reconciliation-invariant docstring note to `renderTideCardBanner`.
- [x] Auto-restart on commit-window re-entry: when the parent re-asserted `visible: true` while the gate was committed, `finishExit` resets `prevVisibleForLifecycleRef` and the presence effect's `mounted` dep makes it re-run — emitting a fresh `willShow` and calling `setMounted(true)` so the banner re-enters cleanly. The didHide effect is registered before the presence effect so the lifecycle order is `didHide → willShow` during the auto-restart commit.
- [x] Update pre-existing `T-CARDBANNER-02` and `T-CARDBANNER-04` to pass `minMountedMs={0}` since they verify baseline animation, not gate behavior.

**Tests:**

Per the user-stated constraint that happy-dom must not host cross-render React lifecycle tests (memory: `feedback_no_happy_dom_tests.md`), the gate's behavior is **not** verified by automated tests. The implementation is constrained instead by:

- TypeScript types (the prop signature is enforced at every call site).
- The existing `tug-pane-banner.test.tsx` baseline tests, updated to opt out of the gate via `minMountedMs={0}`. These verify that the gate doesn't break the legacy animation/inert paths when disabled.
- The existing `tide-card-banner-spec.test.ts` precedence-chain tests (unchanged — the spec helper is pure).
- Manual HMR verification of the loading banner under fast-replay conditions.

- [x] Pre-existing `tug-pane-banner.test.tsx` continues to pass with `minMountedMs={0}` opt-outs on the two animation-path tests.
- [x] Pre-existing `tide-card-banner-spec.test.ts` continues to pass unchanged.
- [ ] Manual HMR verification: trigger a fast replay (a session whose JSONL replay completes in < 100ms) and confirm the "Loading session…" strip remains visible for ~500ms before sliding out, instead of flashing and vanishing. (Pending dogfood; not a blocker for landing the gate.)

**Tuglaws cross-check:**

- **L06** — gate state lives in refs + the existing `setMounted` flow, not in additional React state for appearance. The visual hold rides the existing `mounted` + `lastVisiblePropsRef` machinery; no new appearance-routed state.
- **L13** — the deferral is a `setTimeout` around the existing `TugAnimator` group call; we don't switch motion regimes. Cleanup clears the pending timer (no animation has started during the deferral, so there is nothing to cancel; once the timer fires, today's `g.finished` chain runs unchanged).
- **L14** — no CSS keyframes added; the gate works by deferring the imperative animation start, which TugAnimator owns.
- **L19** — `data-slot`, `data-visible`, and `data-variant` on the root continue to reflect the *visible-on-screen* state, not the parent's last-asked `visible` prop, for selectors that query "is the banner up right now."
- **L24** — the gate is a structural concern owned by the structure-zone primitive (the banner). Consumers configure with one number; they don't reach into the gate's internals.

**Open questions / decisions:**

- *Default value.* `500ms` matches the user's spec. Worth revisiting after first dogfood — if the loading strip still feels stuttery on a fast resume, bump to 750–1000ms.
- *Cross-kind transitions are intentionally not gated.* When the spec moves from one kind to another (e.g. `replay-loading` → `transport`), `visible` stays true across the transition; the gate doesn't fire. Today's `lastVisiblePropsRef` handles the prop swap. The user sees one banner the whole time, with content that updates — which is the desired behavior. Documented here so a future implementer doesn't try to "fix" what isn't broken.
- *Other consumers of `TugPaneBanner` / `TugBanner` (status variant) inherit the 500ms default.* Audit at adoption time: if any existing call site renders a banner whose visibility is driven by short-lived state similar to `replay-loading`, the gate helps it for free. If any call site renders a banner that should dismiss instantly (e.g., a user-acknowledged confirmation), pass `minMountedMs={0}`. Recommended sweep: grep for `TugPaneBanner` and `TugBanner` call sites at adoption time and tag each with the chosen value, even if it's the default.
- *Auto-restart on commit-window re-entry.* The original spec said "an ordered-out banner cannot be revived." The shipped implementation honors that for the *same* logical banner cycle (the gate's commit-window suppression is binding), but if the parent's last-asserted `visible` is still `true` after the gate resets, the component re-enters via the natural `mounted` dep on the presence effect. This treats the post-reset `visible: true` as a fresh banner request rather than a revival of the prior cycle. Without this, fast `loading → none → loading` transitions in `deriveTideCardBannerSpec` would leave the banner stuck unmounted while the parent's intent is "still loading" — bad UX. The lifecycle order during the auto-restart commit is `didHide → willShow` (didHide effect registered before the presence effect).

**Checkpoint:**

- [x] `bun x tsc --noEmit` — exit 0.
- [x] `bun test src/__tests__/tug-pane-banner.test.tsx` — 9 pass, 0 fail (existing baseline tests, updated for the gate-default opt-out).
- [x] `bun test src/components/tugways/cards/__tests__/tide-card-banner-spec.test.ts` — 12 pass, 0 fail (unchanged precedence-chain tests).
- [x] `bun run audit:tokens lint` — zero violations.
- [ ] Full `bun test` and `cargo nextest run` — deferred to the close-out step (Step 5). The gate is purely additive at the component level; impact on other tugdeck tests is bounded by `minMountedMs` defaulting to 500 (which other call sites either tolerate or opt out of via `={0}`). No Rust changes in this step.

---

#### Phase B — TugListView prefetching {#phase-b}

#### Step 4: `TugListView` prefetching protocol {#step-4}

**Depends on:** [Step 3](#step-3)

**Commit:** `tug-list-view: delegate.prefetchForIndices + cancelPrefetchForIndices`

**References:** parent plan [#prefetch-delegate](./tugplan-tug-list-view.md#prefetch-delegate)

**Artifacts:**

- `tugdeck/src/components/tugways/tug-list-view.tsx`:
  - `TugListViewDelegate` gains optional `prefetchForIndices(indices)` and `cancelPrefetchForIndices(indices)`.
  - The list view computes a prefetch window — a small band ahead of and behind the rendered window (e.g. 5 indices on each side, configurable via a delegate option in a future step).
  - On windowing pass, the list view diffs the previous prefetch set against the new one and dispatches `prefetchForIndices(added)` / `cancelPrefetchForIndices(removed)` accordingly.
  - The list view does NOT call `cellRenderers[kind]` for prefetched-only indices — they are informational.
- `tugdeck/src/components/tugways/__tests__/tug-list-view.test.tsx` — new tests covering the prefetch dispatch.

**Tasks:**

- [ ] Compute the prefetch window in the windowing pass.
- [ ] Diff against previous and dispatch.
- [ ] Author tests.

**Tests:**

- [ ] On scroll forward: indices ahead of the rendered window enter via `prefetchForIndices`; previously-prefetched indices behind the rendered window enter via `cancelPrefetchForIndices`.
- [ ] On scroll reversal: prefetched-but-not-rendered indices flip via `cancelPrefetchForIndices`.
- [ ] No prefetch dispatch when neither method is provided on the delegate (default v1 behavior).
- [ ] Cell renderers are NOT invoked for prefetched indices.

**Tuglaws cross-check:**

- **L09 / L10 / L25** — `TugListView` stays a structure-zone primitive. Prefetch dispatch is delegate-driven; no consumer-domain knowledge leaks into the list view.

**Checkpoint:**

- [ ] `bun x tsc --noEmit` — exit 0.
- [ ] `bun test` — green.
- [ ] `bun run audit:tokens lint` — zero violations.
- [ ] `cargo nextest run` — green.

---

#### Phase C — Tuglaws walkthrough + close-out {#phase-c}

#### Step 5: Tuglaws walkthrough + plan close-out {#step-5}

**Depends on:** [Step 4](#step-4)

**Commit:** `tide(transcript): tuglaws walkthrough; close out follow-on plan`

**References:** [tuglaws.md](../tuglaws/tuglaws.md), [pane-model.md](../tuglaws/pane-model.md), [component-authoring.md](../tuglaws/component-authoring.md), [responder-chain.md](../tuglaws/responder-chain.md), [state-preservation.md](../tuglaws/state-preservation.md), [token-naming.md](../tuglaws/token-naming.md)

**Artifacts:**

- Per-step compliance review against each tuglaws document. Findings either land as small fixes in this commit or are explicitly logged.
- `tugplan-tug-list-view.md #roadmap` updated: `Atom-aware rendering for user rows`, `Prefetching protocol` rows flipped to "shipped — see [tugplan-tide-transcript-followon.md]". (`Stable in-flight ↔ committed id` was completed by other means and is reflected on the parent roadmap independently of this plan.)
- `tide.md §T3.4.a` (or successor anchor) updated to reflect that JSONL replay on resume + phase-aware interrupt + atom-aware user rows + banner min-mount-time gate + prefetching are all shipped.
- Plan Metadata `Status` flips to `shipped`.

**Tasks:**

- [ ] Walk each tuglaw against this plan's diff (Steps 1.1–4).
- [ ] Update parent roadmap rows in `tugplan-tug-list-view.md`.
- [ ] Update `tide.md` reference if needed.

**Tests:**

- [ ] Full-suite green: `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run`.

**Checkpoint:**

- [ ] All commands above exit clean.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Four small transcript / list-view / banner polish items: a phase-aware interrupt path that distinguishes CASE A (`submitting`, restore prompt to editor) from CASE B (post-first-delta, commit interrupted turn), atom-aware user rows, a banner minimum-mount-time gate (adopted for the "Loading session" pane banner), and the `TugListView` prefetching protocol. Plus a tuglaws walkthrough that closes out this plan and updates the parent roadmap rows.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] CASE A interrupt restores the user's prompt (text + atoms) to the editor and emits no transcript entry; CASE B continues to commit an interrupted `TurnEntry` with the partial scratch content.
- [ ] `UserRowCell` renders inline atoms when `attachments` is non-empty.
- [ ] `TugPaneBanner` and `TugBanner` (status variant) honor `minMountedMs` (default 500): a fast `visible: true → false` cycle holds the banner on screen for at least the floor before the exit animation starts; once committed to exit, re-asserted `visible: true` is ignored. The replay-loading pane banner adopts the gate.
- [ ] `TugListView` dispatches `prefetchForIndices` / `cancelPrefetchForIndices` on a working window.
- [ ] Tuglaws cross-check passes per-step.
- [ ] `tugplan-tug-list-view.md #roadmap` rows for absorbed items flipped to "shipped".
- [ ] All check commands green: `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run`.

**Acceptance tests:**

- [ ] Phase-aware interrupt tests (Step 1.1).
- [ ] Atom-aware user-row tests (Step 2).
- [ ] Banner min-mount-time gate tests (Step 3).
- [ ] `TugListView` prefetch tests (Step 4).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **Imperative DOM cell pooling** — the v2 of `TugListView` that swaps React item-keyed mount/unmount for an imperative DOM pool keyed by cell kind. Public API unchanged; lifecycle semantics shift for stateful cell renderers (per the v1 → v2 caveat in [tugplan-tug-list-view.md §[D04]](./tugplan-tug-list-view.md#d04-cell-reuse)). Promoted from `tugplan-tug-list-view.md #roadmap` to its own plan because the structural shift earns dedicated decision-making (pool sizing, eviction policy, the [D13] native-text-selection-survival side-effect win, the per-kind reuse-token contract). Plan name TBD: `tugplan-tug-list-view-v2-imperative-pool.md` is a placeholder.
- [ ] **Native-text-selection survival across scroll-out** — explicitly resolved as a side effect of the imperative-DOM-pool plan above. v1 documented limitation per [tugplan-tug-list-view.md §[D13]](./tugplan-tug-list-view.md#d13-selection-scroll-out).
- [ ] **Live-turn flicker at the awaiting-first-token transition** — the seed-rewrite remount that the (separately-shipped) sticky-seed work *cannot* eliminate (only replay-committed turns avoid the rewrite, since their msg_id is known up front). The imperative-DOM-pool plan resolves this naturally because cell DOM survives wrapper-key changes.

| Checkpoint | Verification |
|-|-|
| Tokens lint clean | `bun run audit:tokens lint` |
| Phase-aware interrupt tests | `bun test src/lib/code-session-store/__tests__/code-session-store.interrupt.test.ts` |
| Atom-aware user-row tests | `bun test src/__tests__/tide-card-transcript.test.tsx` |
| Banner min-mount-time gate tests | `bun test src/__tests__/tug-pane-banner.test.tsx src/__tests__/tug-banner.test.tsx` |
| List-view prefetch tests | `bun test src/components/tugways/__tests__/tug-list-view.test.tsx` |
| TS clean | `bun x tsc --noEmit` |
| Rust clean | `cargo nextest run` |
