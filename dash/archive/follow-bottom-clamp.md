## Give the user back control of the scroller {#follow-bottom-clamp}

**Purpose:** Stop the machine from taking the user's scroll position. Make transcript window swaps geometrically atomic so the browser never clamps `scrollTop` against a half-built layout, repair any displacement the machine still causes inside its own commit, and make follow-bottom a state that only the user can end — so "scroll to the bottom and stay there" works for the whole life of a session.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | dash worktree off `main` |
| Last updated | 2026-08-02 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Follow-bottom worked before the memory/perf work of 2026-07-30 → 2026-08-02. It does not work now. Two sessions left running unattended were both found parked thousands of pixels above the live edge with the jump-to-bottom affordance showing; a durable commit message arriving in a third session did not scroll into view; and a plain downward scroll-wheel gesture cannot reach the bottom — it gets snapped back partway.

The regression window contains three landings, all in `tugdeck/src/components/tugways/tug-list-view.tsx` and `tugdeck/src/lib/smart-scroll.ts`:

| Commit | Date | What landed |
|---|---|---|
| `650da0c23` | 08-01 17:23 | Transcript DOM eviction E1 — measured-height windowing in `TugListView` |
| `746de7137` | 08-01 19:50 | Eviction follow-ups — `display:none` tabs, gap drift, turn stepping |
| `d945bca09` | 08-02 14:11 | Scroll fixups — attribution-complete follow-bottom, supersedable corrections |

Eviction is on by default for every session transcript (`session-card-transcript.tsx` passes `evictOffscreen={!transcriptEvictionDisabled}`, and `labFlags` defaults `transcriptEvictionDisabled` to `false`).

**Live field evidence, captured from the running release instance through `POST /api/eval`.** On a transcript with eviction active (a 39,409px top spacer over a 5,487px rendered window), `scrollTop` jumped **upward by 2,660px in a single scroll event with `scrollHeight` identical (44,262) before and after**, with zero user input. During a downward wheel gesture the same signature appeared twice at larger scale (−8,019px and −8,131px mid-burst). Every JavaScript channel that can move a scroller was instrumented and stayed **silent** for these events: the `scrollTop` setter, `scrollTo`, `Element.prototype.scrollIntoView`, the `tug-region-scroll-set` restore dispatch, and `focusin`. No JS moved the scroller.

Only one actor can move `scrollTop` upward with no JS involvement and no net height change: **the browser clamping `scrollTop` to `scrollHeight - clientHeight` while the document is transiently short.** Clamping is destructive — when the height comes back a moment later, the browser does not restore the position.

`SmartScroll` then misreads the clamp as a person. In `idle` it matches the `'unattributed-scroll-up'` rule added by `d945bca09` and disengages follow-bottom; during a wheel burst it matches the older `'drag-up'` rule and disengages even though the user is scrolling *down*. And because the only ways back are the user scrolling into the 60px `AT_BOTTOM_PX` band or clicking the affordance, **one clamp anywhere in a session ends follow-bottom permanently.** That is why a single transient defect presents as "the feature is fundamentally broken": what the user sees is not the event, it is the permanent aftermath.

The scroll-fixups doctrine in [`tuglaws/scroll-intent.md`](../tuglaws/scroll-intent.md) got the premise right — a scroll the machine cannot attribute belongs to someone — but its inventory treats the browser clamp as self-evidently benign ("lands where `isAtBottom` holds"). Under eviction churn that is false. The browser is a first-class unattributed writer whose output is shaped exactly like a user scrubbing up.

#### Strategy {#strategy}

- **Remove the cause before compensating for it.** The window swap must never present a short document to layout. That is a structural fix in one place, not a heuristic.
- **Then repair what is left, but only where repair is provably safe** — inside the synchronous commit phase, where a human physically cannot have scrolled.
- **Then fix attribution**: a displacement the list view has already identified as machine-caused must never reach `SmartScroll`'s user-intent rules.
- **Then make the state recoverable**: follow-bottom must not be a one-way door, so that even an unforeseen clamp costs a moment rather than the session.
- **Instrument first, and durably.** The taps that solved this were hand-built through `/api/eval` and vanish on relaunch. The same diagnosis must take minutes next time, from a release build, without a reproduction.
- **Prove the regression with the control arm we already have.** `setTranscriptEvictionDisabled(true)` renders the same transcript with eviction withheld; displacement must vanish in that arm and return when it is re-enabled.
- **Every behavioral claim gets an app-test against the real app.** The doctrine suite `at0333` and the eviction suite `at0330` are the models.

#### Success Criteria (Measurable) {#success-criteria}

- **No displacement across a window swap.** Driving an evicting transcript through repeated re-window swaps (scroll down, stream growth, scroll up) records **zero** unexplained displacement events: `data-scroll-displacements` on the list view stays `"0"`. Verified in `at0335`.
- **The wheel reaches the bottom.** A sustained downward wheel gesture over an evicting transcript with a ≥30,000px top spacer lands at `scrollHeight - clientHeight` with no intervening upward jump greater than `AT_BOTTOM_PX`, and follow-bottom ends engaged. Verified in `at0335`.
- **Machine displacement never flips follow-bottom.** With follow-bottom engaged, a simulated commit-scoped clamp — driven through the `forceCommitClamp()` test seam ([S04]) — leaves `.session-jump-to-bottom-button[data-visible]` at `"false"` and `isFollowingBottom` true. Verified in `at0335`.
- **Follow-bottom is recoverable.** After any disengage, scrolling to within `AT_BOTTOM_PX` of the bottom re-engages, and a turn streamed afterwards pins. Verified by extending `at0333`.
- **Arrivals scroll into view.** With follow-bottom engaged and the card idle, a turn appended after ≥10 minutes of quiet pins the new content into view. Verified in `at0335`.
- **An idle user at the bottom is never stranded.** With follow-bottom forced off through `setTranscriptFollowBottom(false)` while the transcript sits inside the `AT_BOTTOM_PX` band, appending a row with no user input pins it into view and logs a growth-time re-engagement. This is the app-test form of the two field reports — the `/commit` receipt row and the `Session compacted` note both failing to scroll in from a bottom-parked card. Verified in `at0335`.
- **The regression is attributed.** The manual A/B checkpoints in [#step-1] and [#step-2] record displacement events > 0 before the atomic-spacer fix and 0 after, and 0 in the eviction-disabled control arm both times. This measurement spans revisions, so it is manual by nature — do not try to build it as an app-test.
- **Diagnosis is durable.** `window.__deckTrace.dump()` and the dev-panel log both carry every follow-bottom transition and every displacement with its geometry, in a release build, with no opt-in. Verified in `at0335`.

#### Scope {#scope}

1. Durable displacement + follow-bottom instrumentation (`deck-trace.ts`, `tug-dev-log-store`, a `data-scroll-displacements` attribute, a scroller registry giving the test surface its first route to a live `SmartScroll`, a test-surface reader, and the `forceCommitClamp()` test seam).
2. Atomic window geometry in `TugListView` — spacer heights applied in the render pass, not a post-commit layout effect.
3. Commit-scoped displacement detection and repair in `TugListView`.
4. `SmartScroll` attribution: a user-activity sequence, a programmatic-write sequence, and a repair notification that suppresses intent rules.
5. Follow-bottom recoverability: no terminal disengage from a machine cause, plus two forgiving re-engagement rules — at gesture end, and at growth time for an idle user sitting inside the band.
6. Doctrine updates: the clamp row in `tuglaws/scroll-intent.md` and the `[D93]` idle clause in `tuglaws/design-decisions.md`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Turning eviction off.** The memory work it delivers is wanted; `labFlags.transcriptEvictionDisabled` stays a lab control arm, not a shipped remedy.
- **Extracting a geometry core from `tug-list-view.tsx`.** Still deferred; this plan adds the battery that would protect that refactor.
- **`TugMarkdownView`'s windowing.** Its `applySpacers` runs synchronously in the same task as `removeBlockNode` (see [#markdown-view-parity]), so it has no commit-phase tear. Audited, not changed.
- **The `at0330` expand/collapse failure** (disclosure clears `data-collapsed` but the cell height does not move). Pre-existing at `HEAD` and at the E1 landing commit; a tool-block body-mount defect, not scroll geometry.
- **Out-of-commit clamps** — a height shrink that lands between commits (a late image, a font swap). Attribution and recoverability cover them; positional repair does not. See [Q01].
- **Reworking the `AT_BOTTOM_PX` band size** beyond the re-engagement rule in [#step-5].

#### Dependencies / Prerequisites {#dependencies}

- The `d945bca09` scroll-fixups landing is on `main` (attribution rules, `at0333`, `tuglaws/scroll-intent.md`).
- Eviction E1 (`650da0c23`) and its follow-ups (`746de7137`) are on `main`.
- `POST /api/eval` is reachable on the instance under test — it needs dev mode or the `diag/eval` opt-in (`PUT /api/defaults/diag/eval {"kind":"bool","value":true}`), loopback only. Used by the manual verification in [#step-1] and [#step-7].
- `just app-test <file>` for behavior, `cd tugdeck && bun test` for pure logic, `bunx tsc --noEmit` and `bunx vite build` before any step is called done.

#### Constraints {#constraints}

- **Warnings are errors.** Never commit red; never commit with new warnings.
- **No fake-DOM tests.** `happy-dom`, `jsdom` render, `@testing-library/react`, and mock-store assertion tests are banned. Real-app behavior goes to `tests/app-test/`; pure logic goes to `bun:test`.
- **Never run `just app-test-all`.** Use `just app-test-changed`; the answer to an unscopeable change is the core tier `just app-test`.
- Every new app-test needs a `@covers` header, and `tests/app-test/scripts/select-tests.ts` holds an `ACCEPTED_FANOUT` entry for `tugdeck/src/components/tugways/tug-list-view.tsx` currently set to **23** — adding a test that covers it means bumping that number with a comment.
- The transcript's scroller must not gain a per-commit forced layout in the streaming hot path — the cold-load `clientHeight` read was already singled out as a load-time cost in `tug-list-view.tsx`. New geometry reads must sit where layout is already clean (see [P03]).
- **[L06]** — appearance changes go through CSS and DOM, never React state. **[L03]** — registrations that events depend on go in `useLayoutEffect`. **[L22]/[L24]** — derived structure is derived, not stored. [P02] argues an explicit, bounded exception; read it before writing the spacer change.

#### Assumptions {#assumptions}

- React's commit phase mutates the entire tree's DOM **before** any `useLayoutEffect` runs, and child layout effects run before parent ones. The tear in [#the-tear] depends on exactly this ordering.
- A user cannot scroll during synchronous JavaScript execution, so any `scrollTop` change observed between two points *inside one commit phase* is machine-caused. This is what makes [P03]'s repair safe where a general heuristic would not be.
- The browser clamps `scrollTop` to `max(0, scrollHeight - clientHeight)` at layout time when the scroll maximum shrinks, and does not restore it when the maximum grows back.
- `heightIndex` entries are outer extents (measured height + row gap, per `746de7137`), so spacer sums and real row extents are in the same units.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings and rich `References:` lines. Plan-local decisions are `[P01]`…; global decisions in [`tuglaws/design-decisions.md`](../tuglaws/design-decisions.md) are cited as `[D93]`, `[D07]`. Never cite line numbers — cite an anchor.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Out-of-commit clamps (DEFERRED) {#q01-out-of-commit-clamps}

**Question:** A height shrink that lands *between* commits — a late-decoding image, a font swap, a CSS transition settling — clamps `scrollTop` outside any commit bracket. Should the machine try to restore position for those too?

**Why it matters:** Positional repair outside the synchronous commit window cannot distinguish a clamp from a native scrollbar drag (which emits no events — the premise of the whole doctrine). Guessing wrong means reverting a real user drag, which is a worse failure than the one being fixed.

**Options:**
- Repair only inside commits (this plan).
- Add a `ResizeObserver` on the content wrapper and repair on any observed shrink — risks fighting scrollbar drags.
- Sample `scrollHeight` every frame while following bottom — a permanent forced layout in the hot path; rejected on perf grounds.

**Plan to resolve:** Ship [#step-1]'s instrumentation, then read the field records after a week of real use. If out-of-commit displacement is rare (the expectation, since [#step-2] removes the churn source), leave it to attribution and recoverability alone.

**Resolution:** DEFERRED — attribution ([#step-4]) and recoverability ([#step-5]) already make these harmless to follow-bottom; only the position is not restored. Revisit if the field records show a material rate.

#### [Q02] Should the repair fire when follow-bottom is disengaged? (DECIDED) {#q02-repair-when-disengaged}

**Question:** When the user has parked mid-history and a commit-scoped clamp moves them, do we put them back?

**Why it matters:** This is the difference between "the machine owns the scroller" and "the user does".

**Resolution:** DECIDED — yes. See [P01] and [P03]. The parked position is the user's most recent expressed intent; a clamp inside our own commit has no claim on it. The repair is bounded to the commit phase, so it cannot revert a gesture.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Repair reverts a genuine user scroll | high | low | The baseline is the last scroll-event-observed position, so a silent scrollbar drag refreshes it before any commit can bracket it; the bracket itself is confined to the synchronous commit phase ([P03], [S02]) | Any field report of a "sticky" scroller |
| Render-phase spacer style read as an [L06] violation | med | med | [P02] states the exception and its bounds; no new renders are introduced | A reviewer flags it, or a new spacer writer appears |
| New geometry reads cost layout in the streaming hot path | med | med | Reads sit after the spacer write where layout is already clean; one read per commit, both values from the same read ([P03]) | Typing-lag q99 regresses in the perf probes |
| Eviction ledger shortfall mistaken for a transient dip | med | med | The instrumentation reports each repair's outcome forward as `priorRepairHeld`; a repair that immediately re-clamps means a shortfall, not a dip ([S01]) | Displacement records whose successor carries `priorRepairHeld: false` |
| A clamp's transient at-bottom triggers a spurious *re-engage* | med | low | The bracket repairs before the pin effect reads geometry; the ordering is pinned as an invariant with comments at both sites ([R04], [P05]) | A `growth-at-bottom-reengage` record in the dev log for a card parked mid-history |

**Risk R01: The repair fights a native scrollbar drag** {#r01-repair-fights-scrollbar}

- **Risk:** The one actor the doctrine cannot see is the native scrollbar thumb. If displacement detection compared against a baseline that spans real wall time — such as the previous commit's bracket, seconds earlier — a thumb drag in the gap would look identical to a clamp and the repair would yank the user back — the exact "drag, snap back, repeat" trap `RESTORE_SUPERSEDE_DRIFT_PX` was introduced to avoid.
- **Mitigation:**
  - The baseline is **`SmartScroll.lastScrollEventTop`** — the position as of the most recent `scroll` event ([S02]). A thumb drag is silent in *pointer* events but not in *scroll* events, so the drag refreshes the baseline before any commit can bracket it. A commit-scoped clamp moves `scrollTop` synchronously at forced layout, and its `scroll` event does not dispatch until after the layout phase — so at bracket time the baseline is still pre-clamp. The baseline discriminates by event timing, not by guesswork.
  - Skip the repair whenever `SmartScroll`'s phase is `dragging`, `settling`, or `decelerating`.
  - Skip when `SmartScroll`'s programmatic-write sequence advanced during the bracket (a deliberate machine move: restore heartbeat, correction, growth pin, `scrollToIndex`).
  - Skip when the position has not moved since the previous bracket ([S02] step 5). This closes the same-task commit cascade, where `scrollTick()` re-renders synchronously and a second bracket sees a pin whose counter advance the first bracket already consumed. It is a suppressor, never a target, so it does not reopen the drag hazard this risk is about.
- **Residual risk:** A drag's final scroll event still queued when a commit lands would be misread — a frame-scale window, not a seconds-scale one. WebKit dispatches scroll events from the event loop, not from inside a synchronous script, so the event cannot land *during* the bracket itself; the instrumentation will show it if this model is wrong.

**Risk R02: Spacer heights rendered inline conflict with the DOM-writes convention** {#r02-spacer-render-vs-l06}

- **Risk:** [L06] says appearance changes go through CSS and DOM, never React state, and today the spacer heights are written in a `useLayoutEffect` for exactly that reason.
- **Mitigation:**
  - The spacer height is not appearance — it is the geometry of the derived window slice ([L24]), the other half of the row set React is already rendering in the same pass.
  - No new renders are introduced: `windowResult` is already computed in the render body and already drives which rows are rendered.
  - The layout effect must be **deleted**, not kept alongside — mixing a React `style` prop with a direct `style.height` write is a stale-value hazard (React will skip re-applying a value it believes unchanged).
- **Residual risk:** A future contributor adds a DOM-side spacer writer and re-opens the tear. [#step-6] records the invariant in the doctrine doc.

**Risk R03: The regression is not (only) the tear** {#r03-not-only-the-tear}

- **Risk:** The captured evidence proves a transient dip clamped `scrollTop`, but the exact forced-layout reader that made the intermediate state visible has not been named. There may also be a persistent ledger shortfall (spacer sums under-reporting real extents).
- **Mitigation:** [#step-1] lands before any fix and distinguishes the two: a transient dip repairs and holds; a shortfall repairs and immediately re-clamps. [#step-2]'s checkpoint requires the A/B arm to show displacement going to zero — if it does not, the diagnosis is wrong and the plan stops there rather than layering compensation on a bad model.
- **Residual risk:** Both could be true at once. The instrumentation reports each separately.

**Risk R04: The growth-time re-engage fires on a clamp's transient at-bottom** {#r04-spurious-reengage}

- **Risk:** [P05](c) inverts the failure mode this plan was written to fix. During a clamp the document is transiently short, so `scrollTop == scrollHeight - clientHeight` and `isAtBottom` reads **true** even for a user parked deep in history. A `maybePinToBottom` call in that window would re-engage follow-bottom and pin them to the live edge — the same class of user-fighting behavior as the original disengage, in the opposite direction.
- **Mitigation:**
  - Ordering. React runs child layout effects before any of `TugListView`'s own, so a clamp fired by a child's forced layout has already happened when the displacement bracket runs; the bracket repairs, and only then does the auto-pin effect (declared later in the same component) read geometry. [#step-5] promotes that from accident to invariant with a comment at both sites.
  - [#step-2] removes the tear that produces commit-scoped clamps in the first place, so this is a guard on a path that should no longer fire.
  - The source string is distinct (`growth-at-bottom-reengage`), so a spurious engagement is visible in the dev log rather than silent — the failure mode that made the original bug so expensive to diagnose.
- **Residual risk:** A clamp forced by a **parent's** layout effect runs *after* every effect in `TugListView` (parents run after children), and out-of-commit clamps remain out of scope per [Q01]. Either can leave a spurious at-bottom for the next `ResizeObserver` fire to convert into a re-engage. Bounded, logged, and strictly better than the status quo — where the same clamp silently disengages instead and never heals.

---

### Design Decisions {#design-decisions}

#### [P01] The user's position is authoritative; the machine may only borrow it (DECIDED) {#p01-user-position-authority}

**Decision:** The scroll position is the user's state. The machine may move it only for a reason it can name — a growth pin while following bottom, an explicit restore, a correction, a reveal — and any movement it *cannot* name is a defect to be repaired, not evidence about what the user wants.

**Rationale:**
- The shipped doctrine ("every scroll the machine cannot attribute belongs to the user") is right about ownership but wrong about inference: it converts *machine* noise into *user* intent, and intent is sticky.
- Inverting the default for movements the machine can prove it caused costs nothing in scrollbar fidelity — a scrollbar drag is still unattributed and still wins.

**Implications:**
- `TugListView` must be able to prove "I caused this" for its own commits — hence [P03].
- `SmartScroll` must accept a "this was mine, ignore it" signal — hence [P04].
- Where the machine cannot prove authorship, the old rule stands unchanged: the user wins.

#### [P02] Window geometry is atomic: spacer heights render with the rows they complement (DECIDED) {#p02-atomic-window-geometry}

**Decision:** `windowResult.topSpacerHeight` / `bottomSpacerHeight` are applied as inline `style` on the spacer elements **in the render pass**, and the post-commit `useLayoutEffect` that currently writes `topSpacerRef.current.style.height` is deleted.

**Rationale:**
- The heights are already computed in the render body (the `computeWindow` / widening block that produces `windowResult`), so nothing new is calculated and no new render is scheduled.
- React mutates the whole tree's DOM before any layout effect runs. Applying the heights during render puts the spacer growth and the row removal in the **same mutation batch**, so a short document never exists for anything to lay out. Applying them in a layout effect leaves a window in which every child layout effect — and every earlier-declared parent one — sees a document short by the evicted rows' full extent.
- `TugMarkdownView` already does the atomic version imperatively (`removeBlockNode` … `applySpacers` in one synchronous task); this brings the list view to parity by the React-native route.

**Implications:**
- The spacer `<div>`s gain `style={{ height: … }}`; `topSpacerRef` / `bottomSpacerRef` remain (other code reads them) but are no longer written by an effect.
- The layout effect keyed on `[windowResult.topSpacerHeight, windowResult.bottomSpacerHeight]` is removed outright — keeping both writers is a stale-value hazard (see [R02]).
- Any future spacer height change must go through render; the doctrine doc records this ([#step-6]).

#### [P03] Displacement is detected and repaired inside the commit phase, and nowhere else (DECIDED) {#p03-commit-scoped-repair}

**Decision:** `TugListView` brackets each commit: it reads `scrollTop`/`scrollHeight` once in a layout effect that runs **after** the spacers are correct, and compares against **`SmartScroll.lastScrollEventTop`** — the position as of the most recent `scroll` event, which `_handleScroll` already maintains as `_lastScrollTop`. A difference that is not explained by a gesture in flight, user activity, or a programmatic write is recorded as displacement and repaired by writing the baseline back (clamped to the current maximum).

**Rationale:**
- With [P02] in place the DOM is already consistent when the bracket reads it, so the read itself cannot trigger the clamp it is looking for. Ordering matters: the bracket is worthless — actively harmful — without atomic spacers first.
- The baseline choice is what makes the bracket safe against the native scrollbar. Comparing against the *previous bracket's* snapshot would span the whole inter-commit interval — seconds of real time in which a thumb drag (silent in pointer events, per the doctrine) is indistinguishable from a clamp. That design is rejected. The last-scroll-event position closes the gap by event timing: a drag delivers scroll events that refresh the baseline before any commit; a commit-scoped clamp moves `scrollTop` synchronously at forced layout and its scroll event does not dispatch until after the layout phase, so it cannot. See [S02] and [R01].
- The mixed case comes out right: a drag followed by a clamp in the same interval repairs to the *post-drag* position — the user's most recent expressed intent ([P01]).
- The exemptions are precise and cheap: `SmartScroll`'s phase (a gesture in flight), its programmatic-write sequence (a deliberate move whose scroll event may not have delivered yet), and its user-activity sequence (a belt — the baseline already absorbs any event-delivering activity).

**Implications:**
- The prepend compensation writes `el.scrollTop` **directly** (not through `SmartScroll`) in the front-insert layout effect; it must call `SmartScroll.noteExternalWrite()` after its write ([L01]) or the next bracket will misread it as displacement.
- A repair that does not hold (the very next bracket shows the same displacement) means the document genuinely got shorter — a ledger shortfall, not a dip. It is recorded as such and not retried ([S01]).
- The repair writes through `SmartScroll` so the write is attributed, suppression is armed, and follow-bottom is untouched ([P04]).

#### [P04] A displacement the machine authored never reaches the intent rules (DECIDED) {#p04-machine-displacement-not-intent}

**Decision:** `SmartScroll` gains an explicit "the next scroll event is a machine repair" suppression, and both intent rules — the `idle` `'unattributed-scroll-up'` disengage and the `dragging` `'drag-up'` disengage — skip events covered by it. Additionally, `'drag-up'` requires the gesture's net direction to be upward, measured from the **accumulated wheel deltas**: an upward jump inside a net-downward wheel burst is not a user scrolling up.

**Rationale:**
- The field capture shows both rules firing on clamps — `'unattributed-scroll-up'` when idle, `'drag-up'` mid-wheel. Fixing only the idle rule would leave the wheel case, which is the one the user hit first.
- The net-direction test is cheap and exactly discriminating: the wheel deltas are the user's stated direction, and a clamp is upward regardless.
- The deltas must be the measure, **not** position-vs-`_gestureStartScrollTop`. The gesture start is frozen at gesture entry while growth pins and scrollHeight jitter move the position independently of the user's hand during a streaming burst (the `_enterDragging` comment in `smart-scroll.ts` documents exactly this jitter), and a large clamp (the field capture's −8,000px class) can land the position *above* any position baseline — position-vs-start would disengage on precisely the field case this rule exists to fix.

**Implications:**
- `SmartScroll` exposes `userActivitySeq` and `programmaticWriteSeq` (monotonic counters) so the list view's bracket can reason about the interval.
- A new public method, `notifyRepair(source, top)`, performs the write and arms the suppression in one call.
- `_handleWheel` accumulates signed `deltaY` into a new `_gestureWheelDeltaAccum`, reset when a gesture begins; the `'drag-up'` rule consults the accumulator. A `dragging` gesture with no wheel deltas (pointer or key drags) keeps the existing per-event rule — those gestures have no machine co-author moving the position.

#### [P05] Follow-bottom is recoverable, never terminal (DECIDED) {#p05-recoverable-follow-bottom}

**Decision:** Disengagement stops being a one-way door. Three changes: (a) re-engagement no longer requires the scroll to be net-downward when the position is already inside the `AT_BOTTOM_PX` band at gesture end; (b) a disengage caused by a source later proven to be machine-authored within the same commit is reverted along with the position; (c) a growth signal that arrives while the scroller is idle and inside the band re-engages before pinning.

**Rationale:**
- The user's actual complaint is not one bad flip, it is that the bad flip is permanent. Even a perfect attribution scheme will misfire eventually; a state that cannot heal turns every miss into a session-long outage.
- The current `_checkReEngageFollowBottom` requires `scrollTop > _gestureStartScrollTop`, so a user who wheels down *past* the bottom and rubber-bands, or who ends a gesture exactly at the bottom having started there, does not re-engage.
- Every existing way back requires the **user to move**. A user parked at the live edge, touching nothing, has no route back: `'idle-reengage'` needs a `scroll` event and `'gesture-end-reengage'` needs a gesture. This is the shape of the two field reports that motivated (c) — sitting at the bottom, the durable `/commit` receipt row (appended by `useLandingReceipts` via `ingestShellExchange`) and the `Session compacted` `system_note` (`code-session-store/compaction.ts`) both failed to scroll into view. Both are ordinary appends: they grow `itemCount`, trip the growth-detect layout effect, set `pinRequestedRef`, and reach `maybePinToBottom`, whose `shouldAutoPin` gate then drops the pin because follow-bottom was already off. Position said "at the live edge"; intent said "not following"; the row never arrived.
- (c) is not a new principle — it is the one `shouldAutoPin` already encodes for the *engaged* case, where the `isAtBottom` clause keeps pinning through a downward gesture on the grounds that content must not open a gap beneath a user sitting at the edge. The same reasoning applies when the flag is off and the position is inside the band.
- Unlike (b), (c) does not depend on knowing *why* the disengage happened, so it also bounds the cost of the out-of-commit clamps [Q01] defers. That is what makes it worth its own task rather than a follow-up.

**Implications:**
- `_checkReEngageFollowBottom` gains the `isAtBottom`-only path.
- The repair path in [P03] restores the follow-bottom flag it observed before the displacement.
- `maybePinToBottom` re-engages before consulting `shouldAutoPin` when the machine is idle and the position is inside the band. Two carve-outs: never mid-gesture (`isUserScrolling` — an in-flight gesture's re-engagement is `_checkReEngageFollowBottom`'s to decide at gesture end, and re-engaging mid-drag would pin under the user's own thumb), and never while a restore target is pending (`setRestoreTarget` disengaged deliberately; `applyRestoreTarget` owns the position until it clears).
- **The accepted narrowing:** taken together, (a) and (c) mean a user can no longer hold a *disengaged* position inside the 60px band while content arrives. That state is easy to reach today — `_handleWheel` carries no `isAtBottom` guard, so a 10px wheel nudge at the live edge disengages and leaves the user in the band — and after this step, (a) re-engages them at gesture end and (c) re-engages them even if they never gesture again. This is deliberate and follows from the band being *the definition* of "at the bottom" throughout `SmartScroll`: a peek that stays within 60px of the live edge is not leaving it, and a user who genuinely wants to hold a position moves further than that. It is recorded here because it is a real reduction in what the user can hold, not a free win.
- Because the rule lives in `maybePinToBottom` rather than at the growth call site, it fires on cell and container `ResizeObserver` flushes too, and `TugMarkdownView` inherits it. Intended: the policy is about *position*, not about which signal happened to ask.

#### [P06] Diagnosis is a shipped feature, not a hand-built tap (DECIDED) {#p06-durable-instrumentation}

**Decision:** Follow-bottom transitions and displacement events are recorded in release builds with no opt-in: transitions to the dev log via `tugDevLogStore.debug`, displacements to both the dev log and the `deckTrace` ring under a new `scroll-displacement` event kind, plus a `data-scroll-displacements` counter attribute on the list view.

**Rationale:**
- `deckTrace` recording defaults to **off** (`let enabled = false` in `deck-trace.ts`) and `window.__deckTrace` binds in dev builds only, so the two stranded sessions that started this investigation held no evidence at all. The entire diagnosis had to be rebuilt live through `/api/eval`.
- The dev log is release-visible through the dev panel (Opt-Cmd-/) and readable from app-tests via `window.tugDevLog.getSnapshot()`, which is how `at0330`'s hidden-settle assertion already works.
- A counter attribute gives app-tests a cheap, exact assertion (`"0"`), the same shape as the existing `data-evict-fallbacks`.

**Implications:**
- A new `deckTrace` event kind means edits in three places in `deck-trace.ts`: the `DeckTraceEvent` union, the `DeckTraceEventInput` union, and the `dumpTable` column handling if it special-cases kinds.
- The "release, no opt-in" promise requires two changes in `deck-trace.ts` that no existing behavior provides: `record` currently drops everything while `enabled === false` (the default), and the `window.__deckTrace` binding sits inside a dev-only guard. Add an `ALWAYS_RECORDED_KINDS` set (`"scroll-displacement"`, `"follow-bottom"`) checked **before** the `enabled` gate, and move the `__deckTrace` binding out of the dev-only guard so release builds carry the handle. Without both, the two stranded sessions that started this investigation would still have held zero evidence.
- Recording must stay cheap enough for the streaming hot path — one record per *displacement*, not per commit. `follow-bottom` transitions are already rare by nature.

---

### Deep Dives {#deep-dives}

#### The tear: how a window swap presents a short document {#the-tear}

React's commit runs in two phases. The **mutation phase** applies every DOM change for the whole tree; the **layout phase** then runs `useLayoutEffect` bodies, children before parents, in declaration order within a component.

Today `TugListView` splits its geometry across that boundary:

- **Mutation phase** — the rendered row set changes. On a re-window that moves the window down, rows leave the DOM. Their combined extent (thousands of pixels on a transcript) leaves with them.
- **Layout phase** — the spacer heights are written by a `useLayoutEffect` keyed on `[windowResult.topSpacerHeight, windowResult.bottomSpacerHeight]`, restoring that extent.

Between those two points the document is short by exactly the evicted rows' height. Layout is lazy, so if nothing forces it in that window, the browser coalesces and lays out once with correct geometry — no harm. But **anything that reads geometry in the layout phase forces it**, and at that instant the browser clamps `scrollTop` to the short maximum. The clamp is not undone when the spacer grows back microseconds later; the position is simply gone.

Readers that sit in that window, all confirmed present in `tug-list-view.tsx` and its children:

- The **front-insert scroll-hold** effect (the one that calls `heightIndexRef.current.shift` and `prependScrollAdjustment`) reads `el.scrollHeight`, and is declared **before** the spacer effect. It fires on any commit with a pending prepend.
- The **scrollport ring-height** effect writes `RING_HEIGHT_PROPERTY` from `scroller.clientHeight`; it is deps-gated on `ringPlacement`, and its `ResizeObserver` re-publishes.
- **Child layout effects**, which all run before the parent's spacer effect — every newly-mounted row in the swap, including `TugMarkdownView` instances whose streaming path performs a measurement pass over `el.offsetHeight` for every rendered block.

This is why the failure is intermittent per commit but relentless over a session: it needs a geometry read to coincide with a window swap, which on a streaming transcript happens constantly.

The field capture matches the model exactly: `scrollTop` moved up 2,660px with `scrollHeight` **identical** on both sides. A persistent shrink would show a smaller `scrollHeight` afterwards; a JS write would have tripped one of the five instrumented channels. Only a transient dip fits.

[P02] closes the window by construction rather than by hunting readers: if the spacer height lands in the same mutation batch as the row removal, there is no intermediate state for any reader to observe, now or after some future contributor adds a sixth geometry read.

#### Why the repair is safe only inside the commit {#repair-safety}

The doctrine's hardest constraint is the native scrollbar: a thumb drag delivers **no** pointer, wheel, or key events, so the phase machine sits in `idle` while the user scrubs. Any across-frames "the position moved and I don't know why, put it back" rule would fight that drag on every heartbeat.

The commit phase is the one interval where that ambiguity does not exist. It is synchronous JavaScript; the event loop is not turning; no input can be processed. A `scrollTop` difference observed across it is machine-caused with certainty, not with confidence. That is the whole reason the repair is scoped there and [Q01] is deferred rather than guessed.

But the bracket cannot literally capture its own "before" point: the clamp fires at the first forced layout in the commit — typically a *child's* layout effect, which runs before any effect the list view declares. The baseline therefore comes from the one channel the scrollbar is **not** silent on: `scroll` events. A thumb drag delivers no pointer, wheel, or key events, but it does deliver scroll events, and `_handleScroll` records each into `_lastScrollTop`. A clamp's own scroll event, by contrast, cannot dispatch until the synchronous layout phase has ended — WebKit fires scroll events from the event loop. So at bracket time, `lastScrollEventTop` reflects every drag and no clamp, and the comparison inherits the commit phase's certainty even though the baseline was captured outside it. See [S02] and [R01].

#### Markdown-view parity {#markdown-view-parity}

`TugMarkdownView` windows its own blocks and has spacers of its own, so it is a natural second suspect. It is not affected: its `applySpacers(top, bottom)` is called synchronously in the same task as the `removeBlockNode` / `addBlockNode` loops that change the block set. No layout can be forced between them because no other code runs between them. It is, in effect, already doing what [P02] makes the list view do — and it is a useful precedent to cite if the render-phase change is questioned.

#### The permanence trap {#permanence-trap}

Follow-bottom has exactly three ways back on today's code: the user scrolls into the `AT_BOTTOM_PX` band while `idle` (`'idle-reengage'`), a gesture ends net-downward inside the band (`'gesture-end-reengage'`), or the jump-to-bottom affordance is clicked. All three require the user to act. Nothing re-engages on its own, and nothing reconsiders a disengage that turned out to be spurious.

The sharpest form of the trap is the *idle* user. Someone parked at the live edge who touches nothing generates no scroll event and no gesture, so two of the three routes cannot fire and the third is a deliberate act they have no reason to perform — from where they sit, the card already looks pinned. The flag stays off indefinitely and every subsequent append silently fails to arrive. [P05](c) adds the fourth route: the growth signal itself. Content arriving while the position is inside the band re-engages before pinning, so the trap closes on its own the moment the card has something to show.

That asymmetry is what converts a rare transient into a constant complaint, and it is why [P05] is part of this plan rather than a follow-up: the cause fix and the attribution fix both reduce the *rate* of bad flips, but only recoverability bounds their *cost*.

---

### Specification {#specification}

**Spec S01: Displacement record** {#s01-displacement-record}

Recorded when a commit bracket finds an unexplained `scrollTop` difference.

| Field | Type | Meaning |
|---|---|---|
| `kind` | `"scroll-displacement"` | deck-trace event kind |
| `from` | `number` | the baseline — `SmartScroll.lastScrollEventTop` at bracket time ([S02]) |
| `to` | `number` | `scrollTop` observed at this bracket |
| `scrollHeight` | `number` | `scrollHeight` at this bracket |
| `clientHeight` | `number` | `clientHeight` at this bracket |
| `following` | `boolean` | follow-bottom state observed before the repair |
| `repaired` | `boolean` | whether a corrective write was issued |
| `priorRepairHeld` | `boolean \| null` | whether the *previous* record's repair was still in place at this bracket; `null` when the previous bracket issued no repair |
| `evicting` | `boolean` | whether this commit evicted (mirrors `data-evict-active`) |

Deck-trace entries are immutable once recorded (`appendEvent` stamps and appends to a fixed ring), so the outcome of a repair is reported **forward** on the next record rather than by mutating the earlier one. Carry the pending answer in `commitGeometryRef` and stamp it as `priorRepairHeld` on the following record. A record whose successor reports `priorRepairHeld: false` is the signature of a genuine document shrink (a ledger shortfall), not a transient dip — see [R03].

**Spec S02: Displacement classification** {#s02-classification}

**The baseline is `SmartScroll.lastScrollEventTop`** — the container position as of the most recent `scroll` event, i.e. the `_lastScrollTop` field `_handleScroll` already maintains, exposed through a new public getter. It is **not** the previous bracket's `scrollTop`: the inter-commit interval spans real wall time in which a native scrollbar drag (silent in pointer events) would be indistinguishable from a clamp, and comparing across it would make the repair fight the drag — see [R01] and [#repair-safety] for why the scroll-event timing discriminates exactly.

At a bracket, with `prev` = the previous bracket's snapshot (the counters **and** the `scrollTop` that bracket observed) and `baseline` = `SmartScroll.lastScrollEventTop`:

1. If `prev` is null (first bracket since mount) → record the snapshot, no classification.
2. If `SmartScroll.phase` is `dragging`, `settling`, or `decelerating` → user owns the position; refresh the snapshot, no displacement.
3. If `SmartScroll.userActivitySeq !== prev.userActivitySeq` → input arrived since the last bracket; refresh, no displacement. (A belt — event-delivering activity already refreshed the baseline.)
4. If `SmartScroll.programmaticWriteSeq !== prev.programmaticWriteSeq` → a deliberate machine move whose scroll event may not have delivered yet (restore heartbeat, correction, reveal, growth pin); refresh, no displacement.
5. If `|scrollTop - prev.scrollTop| <= DISPLACEMENT_EPSILON_PX` → the position has not moved since the last bracket already classified it; refresh, no displacement. See **the same-task cascade** below for why this suppressor is required and why it is safe.
6. Otherwise, if `|scrollTop - baseline| > DISPLACEMENT_EPSILON_PX` → **displacement**. Record per [S01], and repair per [S03].

**The same-task cascade — why step 5 exists.** `TugListView` dispatches `scrollTick()` (a `useReducer` bump) from inside layout effects, so React re-renders **synchronously, before paint**: two or three commits, each running this bracket, can land in one task with no `scroll` event delivered between them. Walk a growth pin through that without step 5: commit A's pin effect writes to the bottom and advances `programmaticWriteSeq`; cascade commit B's bracket sees the advance, takes exemption 4, and **consumes it** by refreshing the snapshot; cascade commit C's bracket now sees unchanged counters, phase `idle`, and a `baseline` still holding the *pre-pin* position (the pin's `scroll` event is queued, not delivered) — so it classifies the pin as displacement and [S03] repairs the scroller back **up**, un-pinning follow-bottom in the act of protecting it. Exemption 4 is one-shot per counter advance, not per event delivery; step 5 covers the rest of the window.

**Why step 5 is not [R01]'s rejected design.** [R01] rejects the previous bracket's `scrollTop` as the repair *baseline* — as the position to restore *to* — because that baseline spans real wall time in which a silent scrollbar drag is indistinguishable from a clamp. Step 5 uses it only as a *suppressor*. It can prevent a repair; it can never cause one, and it never supplies a target. The drag-fighting hazard [R01] guards against is a property of the baseline, not of the suppressor, so none of it is inherited.

After classification — and after any repair — the bracket refreshes its snapshot: both counters **and** the observed `scrollTop` (post-repair, so the next bracket's step 5 sees the repaired position). It does not need to write the baseline: a repair advances `programmaticWriteSeq`, and direct writers outside `SmartScroll` are required to call `noteExternalWrite()` per [L01].

**Spec S03: Repair** {#s03-repair}

- Target is `min(baseline, max(0, scrollHeight - clientHeight))`, with `baseline` per [S02].
- The write goes through `SmartScroll.notifyRepair("list-view-commit", target)`, which writes, arms the one-shot idle-re-engagement suppression, increments `programmaticWriteSeq`, and marks the next scroll event exempt from both intent rules ([P04]).
- If `prev.following` was true and follow-bottom is now false, re-engage with source `"repair-restore"` ([P05]).
- Increment the displacement counter published as `data-scroll-displacements`.

**Spec S04: The clamp-simulation seam** {#s04-clamp-seam}

After [#step-2] a commit-scoped clamp is impossible by construction — which is the plan's headline claim, but it leaves the detection/repair path with no natural trigger to test against. App-test `evalJS` runs outside any React commit, so it cannot reproduce the tear from outside. The seam reproduces it from inside:

- `forceCommitClamp()` is added to the test surface (`tugdeck/src/test-surface.ts`, `SURFACE_VERSION` bump `1.19.0` → `1.20.0`, alongside the existing `setTranscriptEvictionDisabled`). It arms a one-shot flag read by the list view's bracket effect.
- On the next bracket, **before classification**, the effect: records the live `scrollTop`, writes the top spacer's `style.height` short by 2,000px, reads `el.scrollHeight` (forcing layout — the browser clamps `scrollTop` exactly as the real tear did), then restores the height — all synchronously inside the same layout effect, i.e. inside the commit.
- Classification then runs against the genuine article: a real browser clamp, commit-scoped, machine-caused.
- The test drives it from a position where a clamp is geometrically possible (near the bottom of an evicting transcript with a large top spacer, so the shrink actually lowers the scroll maximum below `scrollTop`).

This is both the test vehicle for [#step-3]/[#step-4] and the permanent guard that repair stays live once the natural trigger is extinct.

**List L01: Writers exempt from displacement detection** {#l01-exempt-writers}

Each of these legitimately moves `scrollTop`; each must be visible to [S02] so the bracket does not misread it.

- `SmartScroll.scrollTo` / `scrollToElement` / `scrollToBottom` — route through `_writeScrollTop`, which advances the programmatic-write counter.
- **`pinToBottom` does NOT route through `_writeScrollTop`.** It writes `this._container.scrollTop` directly and deliberately stays in `idle` phase ([D93] — pins must not enter `programmatic`). Verified against the code: it is a second, independent write site. The counter must be advanced there too. This is the hottest write in the system — every growth pin while following bottom — and missing it would make the bracket classify each pin as displacement and repair *upward against the stream*, un-fixing follow-bottom in the act of fixing it.
- The **front-insert prepend compensation**, which writes `el.scrollTop` directly in the front-insert layout effect — it must call `SmartScroll.noteExternalWrite()` after its write ([P03]).
- The **raw upward reveal writers** — `revealWithin` in `tugdeck/src/components/tugways/focus-reveal.ts` and `settleFindReveal` in `tugdeck/src/components/tugways/cards/session-card-transcript.tsx` — write `scrollTop` outside `SmartScroll` (they disengage follow-bottom first, but that is invisible to the bracket). A commit landing between their write and its scroll event would misread them; each must call `noteExternalWrite()` after its write.
- The restore heartbeat (`applyRestoreTarget`) and the two-pass scroll correction — both already go through `SmartScroll` writes.
- `usePositionStableClick`'s compensation — writes on the user's own click call-stack; the accompanying `pointerdown` advances the user-activity counter, and its scroll event refreshes the baseline.
- Wheel / pointer / key gestures — covered by the phase test, the user-activity counter, and the baseline itself (every gesture scroll event refreshes it).

`noteExternalWrite()` is a new `SmartScroll` method: it sets `_lastScrollTop` from the live `container.scrollTop` and advances `_programmaticWriteSeq`, making a direct external write indistinguishable from a routed one as far as [S02] is concerned.

**The counter counts writes that moved the scroller, not calls.** `pinToBottom` early-returns when `scrollTop` is already at or past the maximum — the common case on a transcript that is already pinned, which is to say most streaming commits. `_programmaticWriteSeq` must therefore be advanced **after** that guard, only on the branch that actually assigns `scrollTop`; the same rule applies to `_writeScrollTop` and to `noteExternalWrite()` (which is called after a write that already happened). Advancing per *call* instead would leave [S02]'s exemption 4 live on nearly every commit while following bottom, blinding the bracket exactly when the transcript is most active.

**Table T01: Attribution inventory — the amended clamp row** {#t01-clamp-row}

The row to replace in [`tuglaws/scroll-intent.md`](../tuglaws/scroll-intent.md)'s inventory:

| Actor | Events delivered | Attribution |
|---|---|---|
| Browser clamp (scroll maximum shrank) | one `scroll`, indistinguishable from a user scroll-up | **Machine.** Not self-evidently at-bottom: under window churn the height recovers before the event is delivered, so the position looks arbitrary. Commit-scoped clamps are detected and repaired by the list view ([P03]); clamps outside a commit are never allowed to change follow-bottom ([P04]) |

#### State Zone Mapping {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Spacer heights (`topSpacerHeight` / `bottomSpacerHeight`) | structure (derived window geometry) | render-phase inline `style` on the spacer elements — moved out of `useLayoutEffect` | [L24], [P02], [R02] |
| Bracket snapshot (`scrollTop`, `scrollHeight`, counters, `following`) | local-data | `useRef`, written in `useLayoutEffect` | [L03], [L22] |
| Displacement counter | appearance/instrumentation | `data-scroll-displacements` attribute written directly to the DOM | [L06] |
| `userActivitySeq` / `programmaticWriteSeq` | external (non-React) | plain fields on the `SmartScroll` instance | [D07], [D93] |
| Follow-bottom engaged/disengaged | external (non-React) | `SmartScroll._isFollowingBottom` → `onFollowBottomChanged` → `data-visible` on the affordance | [L06], [D93] |
| Displacement records | external (non-React) | `deckTrace` ring + `tugDevLogStore` | [P06] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tests/app-test/at0335-scroll-displacement.test.ts` | Behavioral pins: no displacement across window swaps, wheel reaches bottom, clamp does not disengage, quiet-then-arrival pins |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `scroll-displacement` | deck-trace event kind | `tugdeck/src/deck-trace.ts` | Add to `DeckTraceEvent` union **and** `DeckTraceEventInput` union; fields per [S01] |
| `ALWAYS_RECORDED_KINDS` | const | `tugdeck/src/deck-trace.ts` | `Set` of kinds (`"scroll-displacement"`, `"follow-bottom"`) checked in `record` **before** the `enabled` gate ([P06]) |
| `window.__deckTrace` binding | move | `tugdeck/src/deck-trace.ts` | Currently inside a dev-only guard; move out so release builds carry the handle ([P06]) |
| `_userActivitySeq` / `userActivitySeq` | field + getter | `tugdeck/src/lib/smart-scroll.ts` | Incremented in the wheel, pointerdown, and keydown handlers |
| `_programmaticWriteSeq` / `programmaticWriteSeq` | field + getter | `tugdeck/src/lib/smart-scroll.ts` | Incremented at **both** container write sites: `_writeScrollTop` **and** `pinToBottom` — `pinToBottom` writes directly and stays idle per [D93]; it does not route through `_writeScrollTop` ([L01]) |
| `lastScrollEventTop` | getter | `tugdeck/src/lib/smart-scroll.ts` | Exposes the existing `_lastScrollTop` — the [S02] baseline |
| `noteExternalWrite()` | method | `tugdeck/src/lib/smart-scroll.ts` | Sets `_lastScrollTop` from the live position and advances `_programmaticWriteSeq`; called by the direct writers in [L01] |
| `_gestureWheelDeltaAccum` | field | `tugdeck/src/lib/smart-scroll.ts` | Signed `deltaY` accumulated per gesture in `_handleWheel`, reset at gesture entry; drives the `'drag-up'` net-direction test ([P04]) |
| `notifyRepair(source, top)` | method | `tugdeck/src/lib/smart-scroll.ts` | Writes, arms suppression, marks the next scroll event exempt from intent rules |
| `forceCommitClamp()` | test-surface method | `tugdeck/src/test-surface.ts` + `tug-list-view.tsx` | Arms the one-shot clamp simulation per [S04]; `SURFACE_VERSION` `1.19.0` → `1.20.0` |
| `_repairSuppressionArmed` | field | `tugdeck/src/lib/smart-scroll.ts` | One-shot, consumed in `_handleScroll` alongside `_suppressIdleReengagementOnNextScroll` |
| `_setFollowingBottom` | method (modify) | `tugdeck/src/lib/smart-scroll.ts` | Also log every transition to `tugDevLogStore.debug("smart-scroll", "follow-bottom", …)` ([P06]) |
| `_checkReEngageFollowBottom` | method (modify) | `tugdeck/src/lib/smart-scroll.ts` | Add the `isAtBottom`-only re-engagement path ([P05]) |
| `maybePinToBottom` | method (modify) | `tugdeck/src/lib/smart-scroll.ts` | Re-engage before the `shouldAutoPin` gate when idle inside the band, no restore pending ([P05](c)) |
| `setTranscriptFollowBottom(selector, engaged)` | test-surface method | `tugdeck/src/test-surface.ts` | Forces the flag so `at0335` can reach the disengaged-at-the-bottom state; resolves through the scroller registry; `SURFACE_VERSION` `1.20.0` → `1.21.0` |
| scroller registry + `smartScrollForElement` | module map + export | `tugdeck/src/lib/smart-scroll.ts` | `Map<Element, SmartScroll>` keyed by the container; populated in the constructor, deleted in `dispose()`. The test surface's only route to a live scroller ([#step-1]) |
| `_handleScroll` | method (modify) | `tugdeck/src/lib/smart-scroll.ts` | Both disengage rules honor repair suppression; `drag-up` gains the net-direction test ([P04]) |
| `DISPLACEMENT_EPSILON_PX` | const | `tugdeck/src/components/tugways/tug-list-view.tsx` | Suggested `2` — below the sub-pixel noise threshold already used by the ledger's `0.5` comparisons but above rounding |
| `commitGeometryRef` | ref | `tugdeck/src/components/tugways/tug-list-view.tsx` | The bracket snapshot per [S02] — both counters, the observed `scrollTop` (read by step 5's cascade suppressor), `following`, and the pending `priorRepairHeld` answer |
| `displacementCountRef` | ref | `tugdeck/src/components/tugways/tug-list-view.tsx` | Published as `data-scroll-displacements` |
| spacer `style` props | JSX (modify) | `tugdeck/src/components/tugways/tug-list-view.tsx` | On the `tug-list-view-spacer--top` / `--bottom` elements |
| the spacer `useLayoutEffect` | delete | `tugdeck/src/components/tugways/tug-list-view.tsx` | The effect keyed on `[windowResult.topSpacerHeight, windowResult.bottomSpacerHeight]` ([R02]) |
| `ACCEPTED_FANOUT` entry | const (modify) | `tests/app-test/scripts/select-tests.ts` | `tug-list-view.tsx` 23 → 24, with a comment naming `at0335` |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/scroll-intent.md` — replace the clamp row per [T01]; add the atomic-geometry invariant from [P02] and the commit-scoped-repair rule from [P03]; add a "how to diagnose" pointer to the dev log and `window.__deckTrace`.
- [ ] `tuglaws/design-decisions.md` — amend `[D93]`'s idle clause so "unattributed ⇒ user" excludes machine-authored displacement ([P04]).
- [ ] `dash/follow-bottom-clamp.md` — keep the Step Status Ledger current as steps land.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **App-test** (`tests/app-test/`) | Real app, real transcript, real gestures | Every behavioral claim in [#success-criteria] |
| **Unit** (`bun:test`) | `SmartScroll` classification in isolation against a real element | The intent rules, the counters, the re-engagement path |
| **Drift prevention** | `data-scroll-displacements` stays `"0"` | Guarding the fix against future geometry writers |

The `SmartScroll` unit tests run against a real DOM element in the bun environment as the existing `smart-scroll` tests do — no fake-DOM render library, no mock store.

#### What stays out of tests {#test-non-goals}

- **Rendered-output snapshots of the transcript** — banned pattern (fake-DOM render), and the assertion that matters is geometric, not structural.
- **Mock-store assertions about follow-bottom** — the observable is `.session-jump-to-bottom-button[data-visible]`, driven through the real `onFollowBottomChanged` path.
- **rAF-dependent timing assertions** — background app-test windows suspend rAF and throttle timers; assertions hang off `TugAnimator`-free observables and explicit settle waits, per the harness notes.
- **The `at0330` expand/collapse case** — a known, pre-existing, unrelated red.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Every step runs `bunx tsc --noEmit`, `cd tugdeck && bun test`, and `bunx vite build` before commit; app-test selection comes from `just app-test-changed`.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Durable displacement + follow-bottom instrumentation | done | `66d41a610` |
| #step-2 | Atomic window geometry (render-phase spacers) | done | `70a621534` |
| #step-3 | Commit-scoped displacement repair | done | `b6beb6552` |
| #step-4 | SmartScroll: machine displacement is never intent | done | `9bb0fc509` |
| #step-5 | Follow-bottom is recoverable | done | `139b3be25` |
| #step-6 | Doctrine: clamp row and the D93 amendment | done | `1c2326136` |
| #step-7 | Final integration checkpoint | **blocked** | `bc1708315` (fixups) |

**Verification findings (2026-08-02).** Steps 1–6 are committed, but app-test verification against the real app falsified two of this plan's claims and found three defects in the implementation. They are recorded here rather than in the step bodies because they change the plan, not just the code.

**F1 — the zero-displacement criterion is unachievable, and [P02] does not fully close the tear.** [#success-criteria] requires `data-scroll-displacements` to stay `"0"`. It does not. Two distinct populations show up:

- *Benign, ~24px.* Seeding 60 turns produces a dozen-odd records, every one an exactly-24px pull on a growing document with eviction active. Eviction's height ledger settles **across** commits — a cell measures at its new height in one commit, the spacer compensates in the next — so the document dips briefly between them and the browser clamps. This is [Q01]'s out-of-commit case, which the plan deferred as expected-to-be-rare; it is not rare, it is continuous. The repair undoes each one.
- *Field-scale, ~2,368px.* Driving an evicting transcript through repeated re-window swaps (the [#step-2] test) still records a **2,368px** displacement. This is the magnitude class of the original failures, so **the render-phase spacer fix reduces but does not eliminate large displacement.** [#step-2]'s checkpoint asked for exactly this measurement and treated a non-zero result as "stop and re-diagnose". That is the open question.

`at0335` now pins displacement **magnitude** against `AT_BOTTOM_PX` rather than a count of zero, since magnitude is what separates the benign population from the defect.

**F2 — the [S02] classifier needs a baseline-freshness gate.** `lastScrollEventTop` describes the present only until the next write moves the scroller, and scroll events dispatch from the event loop. On a streaming transcript, which pins continuously, the baseline is stale nearly always. [S02]'s exemption 4 is one-shot per counter advance and its step 5 does not apply when growth genuinely moved the position, so pins slipped through both: **37 spurious displacements per 60-turn seed, each provoking a repair that dragged the scroller backwards against the stream.** Fixed by `SmartScroll.isScrollBaselineFresh`, which the bracket now requires before classifying. This should be folded into [S02].

**F3 — [S03]'s repair target baked in the clamp it was meant to undo.** The specified target, `min(baseline, max(0, scrollHeight - clientHeight))`, writes the *shortened* position when the bracket runs while the document is still short — and once the position matches the short maximum, no later bracket notices. The target is now the unclamped baseline: when the document really is short the browser re-clamps to the same result, and when it is not, the user gets their position back.

**F4 — a browser-authored move is not automatically a clamp.** [P03] reasons that only a clamp moves `scrollTop` without JS. Scroll anchoring also does, when content above the viewport resizes, and the transcript opts into it (`overflow-anchor: auto` in `tug-markdown-block.css`; `render-incremental.ts` is built around it). The classifier now requires the move to be upward **and** unexplained by the height delta. Honest note: this accounts for very few of the observed records — it is correct, but it was not the cause of the spurious repairs (F2 was).

**Open `at0335` failures (5/9 passing).**

| Case | Result | Read |
|---|---|---|
| repeated window swaps | worst displacement **2,368px** | **F1** — a real gap in the geometry fix, not a test artifact |
| idle user never stranded | pins to **326px** short of the edge | follow-bottom re-engages (`growth-at-bottom-reengage` fires) but the position does not reach the bottom; needs investigation |
| clamp repaired, repair holds | `priorRepairHeld` is `null` | the second forced clamp produced no record to carry the answer forward; test or `commitGeometryRef` chain |
| wheel reaches the bottom | ends disengaged | harness limit: a synthetic `WheelEvent` + manual `scrollTop` does not reproduce a real gesture's `scrollend`-driven termination, so gesture-end re-engagement never runs |

**Coverage gap accepted.** `at0333` is reverted to its `main` state — its wheel re-engage case is not faithfully drivable for the reason in the last row above. [#step-5]'s recoverability stays covered by `at0335`'s idle-recovery case, which reaches the disengaged-at-the-bottom state deterministically through `setTranscriptFollowBottom`. The **gesture-end** `isAtBottom`-only path is implemented but unpinned.

**Not done.** The manual A/B regression attribution in [#step-1] and [#step-2] (displacement before/after the geometry fix, and in the eviction-disabled control arm) was never performed — it spans revisions and needs a person driving a real streaming session. [R03] is still unfilled, and F1 makes it the highest-value thing to run next.

**F1 diagnosed (2026-08-03).** The conservation probe (`at0336-conservation-probe.test.ts`, `getListConservation`) measured the eviction ledger directly and exonerated it: across 109 eviction events including the full swap cycle, the worst ledger-vs-live accounting error is **1.5px across 15 rows** — the spacers charge exactly what departing rows occupied. The displacements have a different mechanism entirely, established by elimination and then caught red-handed:

- The geometry ring shows the 2,368px event occurring in a commit whose **post-layout height and spacers are exactly right** — no inter-commit shrink exists for the browser to clamp against.
- The event survives with scroll anchoring disabled (`overflow-anchor: none` on the scroller and every descendant), pixel-identical.
- Wrapping every scroll mover (the `scrollTop` setter, `scrollIntoView`, `focus`) and every layout-forcing getter with stack capture shows **no JavaScript writes or reads in the gap** — the position is already moved when the first post-mutation read looks.

Conclusion: **WebKit clamps the scroll offset synchronously at renderer removal, inside React's mutation phase.** React processes deletions before sibling style updates, so for one unobservable instant the old window's cells are gone while the spacers still hold their old heights; WebKit's removal path clamps the offset against that transient extent and nothing un-clamps it when the spacers grow microseconds later. No forced layout is required and no scroll API can see it happen — which is why [P02]'s render-phase atomicity (correct, and kept) reduced but could not eliminate the displacement, and why [Q01]'s "out-of-commit dip" reading of the ~24px population was wrong: both populations are removal-time clamps, differing only in how much renderer extent the mutation removes (one turn-boundary element vs. fifteen window cells).

Countermeasure proven: pinning the scrollable extent with an absolutely-positioned one-pixel **height post** (so the content height cannot dip mid-mutation regardless of mutation order) drives the same swap sequence to **zero** displacements (`at0336` "height post prevents the mid-swap displacement"). The productization direction is a render-phase ratcheting height floor owned by the list view — the document's scrollable extent becomes monotone by construction, lowered only through an explicit, attributed rebase (user collapse, width reflow, clear) — after which the [S02]/[S03] repair machinery demotes to an assertion layer and the original zero-displacement success criterion is restorable.

---

#### Step 1: Durable displacement + follow-bottom instrumentation {#step-1}

**Commit:** `tugdeck(scroll-diag): record follow-bottom transitions and commit displacement in release builds`

**References:** [P06] Durable instrumentation, [P01] User position authority, Spec S01, (#context, #the-tear, #r03-not-only-the-tear)

**Artifacts:**
- New `scroll-displacement` deck-trace event kind.
- Release-visible dev-log records for every follow-bottom transition.
- `data-scroll-displacements` attribute on the list view.
- The bracket that *detects* (does not yet repair) displacement.

**Tasks:**
- [ ] In `tugdeck/src/deck-trace.ts`, add the `scroll-displacement` variant to the `DeckTraceEvent` union and to `DeckTraceEventInput`, with the fields in [S01]. Both unions must be edited — a variant added to only one will not type-check at the `record` call site.
- [ ] In `tugdeck/src/deck-trace.ts`, add `ALWAYS_RECORDED_KINDS` (`"scroll-displacement"`, `"follow-bottom"`) checked in `record` before the `enabled` gate, and move the `window.__deckTrace` binding out of the dev-only guard ([P06]). Without both, release builds still hold zero evidence — the exact failure this step exists to end.
- [ ] In `tugdeck/src/lib/smart-scroll.ts`, have `_setFollowingBottom` also call `tugDevLogStore.debug("smart-scroll", "follow-bottom", { following, source, scrollTop, scrollHeight, clientHeight, phase })`. Keep the existing `deckTrace.record` call. This is the chokepoint every engage/disengage path already routes through.
- [ ] Add `_userActivitySeq` (incremented in the wheel, pointerdown, and keydown handlers) and `_programmaticWriteSeq` with public getters. **`_programmaticWriteSeq` increments at both container write sites: `_writeScrollTop` and `pinToBottom`.** Verified against the code: `pinToBottom` writes `this._container.scrollTop` directly and deliberately stays in `idle` ([D93]) — it does **not** route through `_writeScrollTop`, and a counter that misses it would classify every growth pin as displacement ([L01]). Increment **after** `pinToBottom`'s already-at-max early return, not on entry: the counter means "a write moved the scroller", and advancing it on every no-op call would hold [S02]'s exemption 4 open across most streaming commits ([L01]).
- [ ] Add the `lastScrollEventTop` getter (exposing the existing `_lastScrollTop`) and `noteExternalWrite()` (sets `_lastScrollTop` from the live position, advances `_programmaticWriteSeq`) per [S02]/[L01].
- [ ] In `tugdeck/src/components/tugways/tug-list-view.tsx`, add `commitGeometryRef` and a `useLayoutEffect` declared **after** the existing spacer-height effect (and after every direct `scrollTop` writer in the component, notably the front-insert prepend effect) that implements [S02] steps 1–6 in *detect-only* mode: classify against `SmartScroll.lastScrollEventTop`, record per [S01] with `repaired: false`, bump `displacementCountRef`, and publish `data-scroll-displacements`. Carry the previous bracket's pending outcome in `commitGeometryRef` and stamp it as `priorRepairHeld` on this record ([S01]). `commitGeometryRef` must hold the observed `scrollTop` as well as the counters — [S02] step 5 reads it, and without that suppressor a same-task commit cascade misclassifies growth pins as displacement.
- [ ] Have the front-insert prepend effect call `SmartScroll.noteExternalWrite()` after its direct `el.scrollTop` write, and have `revealWithin` (`tugdeck/src/components/tugways/focus-reveal.ts`) and `settleFindReveal` (`tugdeck/src/components/tugways/cards/session-card-transcript.tsx`) do the same after theirs ([L01]).
- [ ] Add a **scroller registry** to `tugdeck/src/lib/smart-scroll.ts`: a module-level `Map<Element, SmartScroll>` that the constructor populates keyed by `this._container` and `dispose()` deletes, plus an exported `smartScrollForElement(el)` lookup. The test surface has **no** scroll methods today and no route to a card's `TugListView` handle — the `Scroller` façade in `tug-list-view.tsx` (`engage` / `disengage`) is a context value published to descendants, not reachable from `test-surface.ts`, and `labFlags` is a standing-flag store, not a command channel. The registry is that route, and it serves all three seams this plan adds (the displacement reader, `forceCommitClamp()`, and [#step-5]'s `setTranscriptFollowBottom`) instead of three ad-hoc plumbings. Tests name a scroller by the `data-tug-scroll-key` selector they already use — `[data-tug-scroll-key="session-card-transcript"]` in `at0333`.
- [ ] Add a test-surface reader for the displacement count so app-tests can assert without DOM scraping, and the `forceCommitClamp()` seam per [S04], alongside the existing `setTranscriptEvictionDisabled` in `tugdeck/src/test-surface.ts` (`SURFACE_VERSION` `1.19.0` → `1.20.0`, with the version's own doc paragraph — the file documents every bump in a running block, the `1.19.0` entry being the current last).
- [ ] Note for the implementer: bumping tugdeck's `SURFACE_VERSION` needs **no** harness or Swift change. It is independent of the bridge's `surfaceVersion` (`tugapp/Sources/TestHarness/TestHarnessConnection.swift`), which is what `EXPECTED_SURFACE_VERSION` in `tests/app-test/_harness/index.ts` asserts exact equality against; that constant tracks native RPC verbs, and tugdeck's tracks page-side `__tug` methods separately. Nothing asserts tugdeck's value, so neither bump in this plan touches `_harness/` and neither trips a CORE TIER advisory.

**Tests:**
- [ ] `bun test` — `SmartScroll` unit: `userActivitySeq` advances on wheel/pointerdown/keydown and not on programmatic writes; `programmaticWriteSeq` advances on `scrollTo` **and on `pinToBottom`** and not on user events; `noteExternalWrite()` advances the counter and syncs `lastScrollEventTop`.
- [ ] `tests/app-test/at0335-scroll-displacement.test.ts` (new, `@covers` `tugdeck/src/components/tugways/tug-list-view.tsx`, `tugdeck/src/lib/smart-scroll.ts`, `tugdeck/src/deck-trace.ts`): open a fixture session, confirm `data-scroll-displacements` exists and the dev log carries `follow-bottom` records after a scroll gesture; then `forceCommitClamp()` ([S04]) with the card parked mid-history and assert `data-scroll-displacements` increments — detection is live before any repair exists.
- [ ] Bump `ACCEPTED_FANOUT` for `tug-list-view.tsx` from 23 to 24 in `tests/app-test/scripts/select-tests.ts` with a comment naming `at0335`.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test-covers-check`
- [ ] `just app-test tests/app-test/at0335-scroll-displacement.test.ts` → `VERDICT: PASS`
- [ ] **Regression attribution (manual, records the finding in this plan):** with a real streaming session in a debug instance, drive a long downward wheel gesture over an evicting transcript and read `window.__deckTrace.dump()`. Displacement records must be **non-zero**. Then `window.__tug.setTranscriptEvictionDisabled(true)`, repeat, and confirm they are **zero**. Record both numbers under [R03] in this document. If displacement is zero in *both* arms, the model in [#the-tear] is wrong — stop and re-diagnose rather than proceeding to [#step-2].

---

#### Step 2: Atomic window geometry {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(list-view): apply window spacer heights in the render pass, not after commit`

**References:** [P02] Atomic window geometry, Risk R02, (#the-tear, #markdown-view-parity, #state-zone-mapping)

**Artifacts:**
- Spacer heights rendered inline; the post-commit spacer effect deleted.

**Tasks:**
- [ ] In `tug-list-view.tsx`, give the `tug-list-view-spacer--top` element a `style` prop whose `height` is `windowResult.topSpacerHeight` in `px`, and the same for `--bottom` with `windowResult.bottomSpacerHeight`:

```tsx
<div
  ref={topSpacerRef}
  className="tug-list-view-spacer tug-list-view-spacer--top"
  style={{ height: `${windowResult.topSpacerHeight}px` }}
  aria-hidden="true"
/>
```

  `windowResult` is already computed in the render body — do not recompute or memoize it separately.
- [ ] **Delete** the `useLayoutEffect` keyed on `[windowResult.topSpacerHeight, windowResult.bottomSpacerHeight]`. Do not leave both writers in place ([R02]).
- [ ] Keep `topSpacerRef` / `bottomSpacerRef` (other code reads them); confirm by grep that nothing else *writes* `.style.height` on the spacers. The [S04] seam is the one sanctioned exception — it deliberately re-creates the tear inside the bracket effect and restores the height in the same task.
- [ ] The bracket effect from [#step-1] was anchored "after the spacer-height effect", which this step deletes. Its correctness no longer depends on that effect's position (render-phase spacers are in place before any layout effect runs), but it must remain declared **after** the front-insert prepend effect, which still writes `scrollTop` directly.
- [ ] Add a comment on the spacer elements recording the invariant: spacer height must land in the same mutation batch as the row set it complements, and why (cite the tear).

**Tests:**
- [ ] Extend `at0335`: drive an evicting transcript through repeated re-window swaps (scroll down through a ≥30,000px top spacer, stream growth, scroll back up) and assert `data-scroll-displacements` is `"0"` throughout. This assertion **fails before this step and passes after** — note that in the commit body.
- [ ] `just app-test tests/app-test/at0330-transcript-eviction.test.ts` — the eviction suite must not regress (it carries one known pre-existing red, the expand/collapse case; 6/7 is the expected baseline).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test tests/app-test/at0335-scroll-displacement.test.ts tests/app-test/at0330-transcript-eviction.test.ts`
- [ ] Manual: repeat [#step-1]'s wheel drive on a debug build — displacement records must now be **zero** with eviction **on**. This is the falsifiable claim of the whole plan; if they are not zero, the remaining readers are outside the commit ([Q01]) and [#step-3] is where they get handled.

---

#### Step 3: Commit-scoped displacement repair {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(list-view): restore the scroll position a commit displaced`

**References:** [P01] User position authority, [P03] Commit-scoped repair, [Q02] Repair when disengaged, Spec S03, List L01, Risk R01, (#repair-safety)

**Artifacts:**
- The bracket from [#step-1] promoted from detect-only to detect-and-repair.

**Tasks:**
- [ ] Add `notifyRepair(source: string, top: number)` to `SmartScroll` in its minimal form: write through `_writeScrollTop` (which already arms `_suppressIdleReengagementOnNextScroll` and, per [#step-1], advances `programmaticWriteSeq`) and record to the dev log. [#step-4] extends this same method with the intent-rule suppression — do not defer the method itself to that step, the bracket needs it here.
- [ ] Implement [S03] in the bracket effect: compute the clamped target and write it through `notifyRepair("list-view-commit", target)`.
- [ ] Restore the pre-displacement follow-bottom state when it changed ([P05] path, source `"repair-restore"`).
- [ ] Set `repaired: true` on the record; leave the outcome to the following bracket's `priorRepairHeld` ([S01]).
- [ ] Guard: never repair when `SmartScroll.phase` is `dragging`, `settling`, or `decelerating`, never when either counter advanced, and never when the position is unchanged since the previous bracket ([S02] steps 2–5). These guards are what make the repair safe ([R01]); step 5 in particular is what keeps a same-task commit cascade from repairing a growth pin back upward.
- [ ] Do **not** retry a repair that did not hold — a following record carrying `priorRepairHeld: false` means the document genuinely shrank ([R03]).

**Tests:**
- [ ] `bun test` — classification unit tests for [S02]: each of the five exemption paths suppresses displacement, and only the unexplained case reports it. Include the same-task cascade explicitly: a pin write followed by **two** bracket runs with no scroll event in between reports displacement on neither.
- [ ] Extend `at0335`: with follow-bottom **disengaged** and the user parked mid-history, force a commit-scoped clamp through `forceCommitClamp()` ([S04]) and assert the position is restored within `DISPLACEMENT_EPSILON_PX`, and that the record carries `repaired: true` with the next record's `priorRepairHeld: true`.
- [ ] Extend `at0335`: assert a native-gesture scroll is **never** reverted — a wheel-up that parks mid-history stays parked across subsequent streamed turns.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test tests/app-test/at0335-scroll-displacement.test.ts tests/app-test/at0333-follow-bottom-unattributed.test.ts`

---

#### Step 4: SmartScroll — machine displacement is never intent {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(smart-scroll): stop reading browser clamps as user intent`

**References:** [P04] Machine displacement not intent, [D93] phase-guard clause, Table T01, (#permanence-trap, #context)

**Artifacts:**
- `notifyRepair`, repair suppression, and the net-direction test on `drag-up`.

**Tasks:**
- [ ] Add `notifyRepair(source: string, top: number)`: writes through `_writeScrollTop`, arms `_repairSuppressionArmed` and the existing `_suppressIdleReengagementOnNextScroll`, and records to the dev log.
- [ ] In `_handleScroll`, consume `_repairSuppressionArmed` the same way the existing one-shot suppression flag is consumed (unconditionally, on the first scroll event after the write), and skip **both** the `idle` `'unattributed-scroll-up'` disengage and the `dragging` `'drag-up'` disengage while it is set.
- [ ] Add the net-direction test to `'drag-up'`: accumulate signed `deltaY` into `_gestureWheelDeltaAccum` in `_handleWheel` (reset when a gesture begins) and disengage only when the accumulated wheel direction is upward (net-negative) — an upward jump inside a net-downward burst is a clamp, not a user scrolling up. Do **not** use position-vs-`_gestureStartScrollTop`: the gesture start is frozen while growth pins and scrollHeight jitter move the position (the `_enterDragging` comment documents the jitter), and a large clamp can land above any position baseline — position-vs-start disengages on exactly the field case. A `dragging` gesture with no wheel deltas (pointer/key) keeps the existing per-event rule ([P04]). This is the rule that broke the wheel case in the field report.
- [ ] Update the doc comments on both disengage sites to name the clamp case; they currently assert that clamps "land where `isAtBottom` holds", which the field capture falsifies.

**Tests:**
- [ ] `bun test` — a scroll event following `notifyRepair` does not flip follow-bottom in either phase; a genuine wheel-up still disengages; an upward scroll jump during a gesture whose accumulated `deltaY` is net-downward does not disengage while a net-upward accumulation does; a pointer-drag gesture (no wheel deltas) keeps the per-event rule.
- [ ] Extend `at0335`: with follow-bottom engaged, a commit-scoped clamp via `forceCommitClamp()` ([S04]) leaves `.session-jump-to-bottom-button[data-visible]` at `"false"`.
- [ ] `at0333` must stay green — its three doctrine pins (unattributed disengage, correction supersede, band re-engage) are the contract this step must not break.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test tests/app-test/at0333-follow-bottom-unattributed.test.ts tests/app-test/at0335-scroll-displacement.test.ts`

---

#### Step 5: Follow-bottom is recoverable {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(smart-scroll): re-engage follow-bottom at the bottom, at gesture end and on growth`

**References:** [P05] Recoverable follow-bottom, Risk R04, (#permanence-trap, #success-criteria)

**Artifacts:**
- The `isAtBottom`-only re-engagement path at gesture end.
- The growth-time re-engagement path in `maybePinToBottom`.

**Tasks:**
- [ ] In `_checkReEngageFollowBottom`, re-engage when `isAtBottom` holds at gesture end even if the gesture was not net-downward (today it requires `scrollTop > _gestureStartScrollTop`). Keep the existing net-downward path for the case where the gesture ends *near* but not inside the band. Tag the new path with its own source string so the trace distinguishes them.
- [ ] Confirm the `idle` `'idle-reengage'` rule still requires `scrollTop >= _lastScrollTop` — a user scrolling *up* into the band from below must not be yanked into following. Add a comment recording why the two rules differ.
- [ ] In `maybePinToBottom`, before consulting `shouldAutoPin`, re-engage follow-bottom when it is off, `isAtBottom` holds, `isUserScrolling` is false, and no restore target is pending ([P05](c)). Use a distinct source string (`'growth-at-bottom-reengage'` or equivalent) so the dev log distinguishes it from the gesture and idle paths. Keep the policy inside `maybePinToBottom` rather than at the call sites — that method's doc comment already names it the single home of the auto-pin gate. Extend that doc comment to cover the new clause.
- [ ] Know the blast radius before writing it. `maybePinToBottom` has exactly **five** call sites, and the new rule reaches all five: `tug-list-view.tsx:2537` (the per-cell `ResizeObserver` flush — fires continuously during streaming as cells re-wrap), `:3063` (the container `ResizeObserver` — pane/window resize), `:3218` (the growth pin, the signal the field cases actually need), and `tug-markdown-view.tsx:481` and `:534`. So the rule is **not** growth-only: a cell resize or a container resize while the user sits idle inside the band also re-engages. That is intended — the trigger is irrelevant, the position is what the policy is about — but it is wider than "growth-time" suggests, and `TugMarkdownView` inherits it. Note both facts in the doc comment. (The three body-kind files that mention `shouldAutoPin` — `block-header.tsx`, `file-block.tsx`, `block-fold-cue.tsx` — only reference it in explanatory comments; they call nothing and need no change.)
- [ ] Record in the same comment why the two carve-outs exist: mid-gesture re-engagement belongs to `_checkReEngageFollowBottom` at gesture end (re-engaging mid-drag would pin under the user's own thumb), and a pending restore target owns the position until `applyRestoreTarget` clears it. The restore carve-out is load-bearing, not defensive: `_setFollowingBottom(true, …)` calls `clearRestoreTarget()`, so a growth pin arriving mid-restore would otherwise destroy the cold-boot restore target.
- [ ] **Pin the effect-ordering invariant** ([R04]). [P05](c) makes a spurious `isAtBottom` produce a spurious *engage* — the mirror of the bug this plan fixes — because during a clamp the document is transiently short and `scrollTop == scrollHeight - clientHeight` reads at-bottom. The displacement bracket must therefore remain declared **before** the auto-pin effect in `tug-list-view.tsx`, so any commit-scoped clamp is repaired before `maybePinToBottom` reads geometry. That ordering is true today only by accident (the bracket sits after the front-insert prepend effect, the pin effect much later); this step makes it a requirement. Add a comment at **both** sites naming the other and stating the dependency, so a future reordering fails review rather than silently re-engaging follow-bottom for a user parked mid-history.
- [ ] Verify the affordance's `data-visible` follows every new transition ([L06] — the observer path, not React state).
- [ ] Add `setTranscriptFollowBottom(selector: string, engaged: boolean)` to `tugdeck/src/test-surface.ts` (declaration + implementation + its own `SURFACE_VERSION` doc paragraph, following the file's running per-version convention), resolving the `SmartScroll` instance through the registry from [#step-1] and calling `engage` / `disengage` with an explicit test source string. Bump `SURFACE_VERSION` `1.20.0` → `1.21.0` (Step 1 took it from `1.19.0` to `1.20.0`). Do **not** route this through `labFlags` — that store is the right shape for a standing lab flag like `setTranscriptEvictionDisabled` and the wrong shape for a one-shot imperative command.
- [ ] The seam is required, not a convenience, and for a specific reason worth recording in its doc comment: `at0333`'s established technique for reaching these states is direct `scrollTop` assignment (attribution-identical to the scrollbar's pointer silence). But a *downward* direct assignment into the band emits a `scroll` event that satisfies `idle-reengage`'s `scrollTop >= _lastScrollTop && isAtBottom`, so follow-bottom re-engages before the test can assert on it. The disengaged-at-the-bottom state therefore heals itself out from under any test that tries to construct it by assignment.

**Tests:**
- [ ] `bun test` — a gesture that starts and ends inside the band re-engages; a gesture that ends above the band does not; an upward gesture never re-engages mid-flight, and at gesture end it re-engages if and only if the position is inside the band (`isAtBottom`, the 60px `AT_BOTTOM_PX` band — "at the bottom" and "inside the band" mean the same thing throughout this plan).
- [ ] `bun test` — growth-time re-engagement: with follow-bottom disengaged and the element scrolled inside the band, `maybePinToBottom` re-engages and pins; outside the band it does neither; mid-gesture (`isUserScrolling`) it does neither; with a restore target installed it does neither.
- [ ] Extend `at0333`: after a disengage, wheeling to the bottom re-engages and a subsequently streamed turn pins.
- [ ] Extend `at0335`: the quiet-then-arrival criterion — with follow-bottom engaged and the card idle, a turn appended later pins into view.
- [ ] Extend `at0335`: the idle-user recovery criterion — disengage follow-bottom through the test surface while the transcript is scrolled to the bottom, touch nothing, then append a row; it pins into view and the dev log carries the growth-time re-engagement source. This is the app-test standing in for the two field reports (`/commit` receipt, `Session compacted` note), which are both plain appends onto a live transcript.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test tests/app-test/at0333-follow-bottom-unattributed.test.ts tests/app-test/at0335-scroll-displacement.test.ts`

---

#### Step 6: Doctrine — the clamp row and the D93 amendment {#step-6}

**Depends on:** #step-5

**Commit:** `tuglaws(scroll-intent): name the browser clamp as a machine writer, record the atomic-geometry invariant`

**References:** [P01], [P02], [P03], [P04], Table T01, [D93], (#the-tear, #repair-safety)

**Artifacts:**
- Updated `tuglaws/scroll-intent.md` and `tuglaws/design-decisions.md`.

**Tasks:**
- [ ] Replace the browser-clamp row in `tuglaws/scroll-intent.md`'s attribution inventory with [T01]. The current row's claim that a clamp "lands where `isAtBottom` holds" is the specific sentence this plan falsifies — quote the field evidence briefly so the correction is not re-reverted.
- [ ] The same falsified premise has a **second home** in the same document: the "defensible raw write" list offers "it lands where `isAtBottom` holds (clamp-shaped)" as a sanctioned category a new raw `scrollTop` writer may justify itself under. Amend that clause too — clamp-shaped is no longer a defense, because a clamp under window churn does not land at the bottom. This is the more dangerous of the two, since the inventory row only *describes* the clamp while this clause *licenses* future writers on the same bad model. Both must go or [#step-6]'s checkpoint cannot pass.
- [ ] The same comment in `tugdeck/src/lib/smart-scroll.ts`'s `unattributed-scroll-up` rule asserts the falsified claim as one of its safety arguments; [#step-4] rewrites it. Confirm here that it did.
- [ ] Add an **atomic geometry** section: any windowing surface must apply spacer/placeholder geometry in the same mutation batch as the row set it complements ([P02]), with the tear explained and `TugMarkdownView` cited as the imperative precedent.
- [ ] Add a **commit-scoped repair** section stating the rule and, importantly, its bound — why repair outside the commit phase is not safe ([#repair-safety], [Q01]).
- [ ] Add a short **how to diagnose** section: the dev panel log, `window.__deckTrace.dump()`, `data-scroll-displacements`, and the `setTranscriptEvictionDisabled` A/B arm.
- [ ] Record the **four** routes back to follow-bottom in the same document — idle scroll into the band, gesture end inside the band, the jump-to-bottom affordance, and the growth-time re-engagement added by [P05](c) — with the reason the fourth exists: an idle user parked at the live edge generates neither a scroll event nor a gesture, so the first three cannot fire and the state was terminal for them.
- [ ] Amend `[D93]` in `tuglaws/design-decisions.md`: the idle clause currently says any non-programmatic idle scroll belongs to the user. Qualify it — machine-authored displacement identified by the owning component is excluded, and point at `scroll-intent.md`. Note explicitly that growth pins remain *phase*-invisible (they stay in `idle`, the original [D93] design) but are now *counter*-visible: `programmaticWriteSeq` advances in `pinToBottom`, which is what lets the displacement bracket exempt them.
- [ ] No hard-wrapped prose; one logical line per paragraph or bullet.

**Tests:**
- [ ] N/A (documentation). The behavior is pinned by `at0333` and `at0335`.

**Checkpoint:**
- [ ] Both documents read correctly and the `[D93]` amendment does not contradict the shipped code.
- [ ] `rg -n "isAtBottom holds" tuglaws/ tugdeck/src/` returns nothing — the falsified claim is gone from **all three** of its homes: the inventory row, the defensible-raw-write clause, and the `unattributed-scroll-up` comment.

---

#### Step 7: Final integration checkpoint {#step-7}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6

**Commit:** N/A (verification only)

**References:** (#success-criteria, #r03-not-only-the-tear)

**Tasks:**
- [ ] `just app-test-changed` over the full dash diff; record which files ran and their verdicts in the ledger below.
- [ ] Foreground-tier tests that cannot run unattended are recorded as a re-run list rather than treated as failures — confirm any failure reproduces at unmodified `main` before calling it environmental.
- [ ] Build and launch a debug instance (`just app-debug`), then verify each [#success-criteria] item by hand on a real streaming session, including the long-quiet arrival case.
- [ ] Record the before/after displacement counts from [#step-1] and [#step-2] in [R03] so the regression attribution is durable.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build` all clean.
- [ ] `just app-test-changed` green except for documented pre-existing reds (`at0330` expand/collapse) and documented foreground-tier deferrals.
- [ ] Manual: a downward wheel gesture over an evicting transcript reaches the bottom and stays; a session left streaming unattended for ≥10 minutes is still at the live edge.

---

### Deliverables {#deliverables}

- Transcript window swaps that never present a short document to layout ([#step-2]).
- A commit-scoped repair that gives the user their position back when the machine takes it ([#step-3]).
- Attribution that never converts a browser clamp into user intent ([#step-4]).
- Follow-bottom that heals instead of latching off ([#step-5]).
- Release-visible diagnosis for the next scroll defect: dev-log records, a deck-trace event kind, and a displacement counter ([#step-1]).
- `tests/app-test/at0335-scroll-displacement.test.ts` plus extensions to `at0333`, and doctrine updated to match the code ([#step-6]).
