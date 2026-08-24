# Scroll Intent — the attribution doctrine

*Who owns a scroll, and which writes yield to whom. The doctrine behind `SmartScroll` ([D93]), the extent floor, and every programmatic `scrollTop` writer in the transcript stack. Behavioral pins: `tests/app-test/at0333-follow-bottom-unattributed.test.ts` (polarity), `at0335-scroll-displacement.test.ts` (the zero criterion), `at0336-conservation-probe.test.ts` (conservation).*

## The doctrine

Two sentences govern every scroll write:

1. **Every scroll the machine cannot attribute to itself belongs to the user.**
2. **No deferred scroll write survives a user gesture.**

The first sentence closes the attribution model: `SmartScroll` knows which writes are its own (explicit programmatic scrolls, pins, restore heartbeats), so any movement it did not cause is user intent — even when no input event announces it. The second sentence is the supersede rule: a write that was armed *before* the user moved (a restore target, a two-pass correction) is describing a world the user has since rejected, and firing it late yanks them away from a position they chose. Both are instances of [L23] — internal implementation operations must never destroy user-visible state, and the scroll position the user is reading *is* user-visible state.

## The WKWebView attribution inventory

What each gesture actually delivers to the scroll container, and therefore what the machine can know:

| Gesture | Events delivered | Phase reached | Attribution |
|---|---|---|---|
| Wheel / trackpad scroll | `wheel`, then `scroll` | `dragging` (wheel skips `tracking`) | user, by event |
| Touch/pointer drag on content | `pointerdown` → `scroll`… → `pointerup` | `tracking` → `dragging` → `settling`/`decelerating` | user, by event |
| Scroll keys (PageUp/Down, Home, End, arrows, Space) | `keydown`, then `scroll` | `dragging` | user, by event |
| **Native scrollbar thumb drag** | **`scroll` only — no pointer, no wheel** | stays `idle` | **user, by doctrine sentence 1** |
| Explicit programmatic scroll (`scrollTo`, `scrollToBottom`, `scrollToElement`, restore heartbeat) | `scroll` (async, after the write) | `programmatic`; non-animated writes exit synchronously and arm the one-shot idle suppression for their deferred `scroll` event | ours |
| Pins and prepend compensation | `scroll` | stays `idle` (deliberate raw writes) | ours — distinguishable because they only ever move `scrollTop` **down** |
| Browser clamp on `scrollHeight` shrink | one `scroll`, indistinguishable from a user scroll-up | `idle` | **Machine.** Not self-evidently at-bottom: under window churn the height recovers before the event is delivered, so the position looks arbitrary. Made impossible by construction — the extent floor holds the scrollable extent across every mutation — and the commit bracket witnesses any that survives without ever counter-writing it |
| Declared extent rebase (the floor lowering to a genuinely shorter document) | `scroll`, if the shorter extent clamps | `idle` (a deliberate raw write) | ours — the lowering flushes layout so the clamp lands inside the declared write, pins it with `noteExternalWrite`, and records an `extent-rebase` trace event |
| Position-stable click compensation (`use-position-stable-click.ts`) | `scroll` on the click call-stack | `idle` | **user** — it holds the click point under the user's cursor, so the user owns the resulting position |

The scrollbar row is the load-bearing one. A native thumb drag is completely silent apart from the `scroll` events themselves, so any model of the form "idle ⇒ we caused it" is falsified the moment a user grabs the scrollbar — which is why [D93]'s phase guard reads the way it does: ours = `programmatic`, or `idle` with the post-programmatic suppression armed; everything else in `idle` is the user.

The clamp row used to read "unattributed, but lands where `isAtBottom` holds — the at-bottom band absorbs it", and that sentence was wrong in a way that cost a whole class of sessions. It is corrected above rather than deleted so the correction is not quietly re-reverted. The evidence: on a transcript with eviction active (a 39,409px top spacer over a 5,487px rendered window), `scrollTop` jumped **upward by 2,660px in a single scroll event with `scrollHeight` identical — 44,262 — before and after**, with no user input. During a downward wheel gesture the same signature appeared twice at larger scale (−8,019px and −8,131px mid-burst). Every JavaScript channel that can move a scroller was instrumented and stayed silent: the `scrollTop` setter, `scrollTo`, `Element.prototype.scrollIntoView`, the `tug-region-scroll-set` restore dispatch, and `focusin`. No JS moved the scroller, and the geometry afterwards was intact — the only actor that fits is the browser clamping against a document that was transiently short. The band absorbs nothing, because by the time the event is delivered the height is back and the position is thousands of pixels adrift.

That is why the clamp is classified as **machine** and not as unattributed: "unattributed ⇒ user" is right about ownership and wrong about inference when the machine can prove it caused the move. Where it cannot prove it, the old rule stands unchanged and the user wins.

The mechanism behind that evidence is named in **The clamp happens at removal time** below, and the defense is the **extent floor**. Both were established after this row was first written, and they change what the machine can promise: a clamp is no longer something to detect and undo, it is something the geometry does not permit.

Consequences of the inventory, as shipped in `smart-scroll.ts` and `tug-list-view.tsx`:

- An unattributed **upward** `idle` scroll outside the at-bottom band disengages follow-bottom (deck-trace source `unattributed-scroll-up`). Without this, every growth pin slams the scroller back to the bottom against a scrollbar drag.
- An unattributed scroll **into** the at-bottom band re-engages follow-bottom — the disengage's mirror, and the path a scrollbar drag to the bottom takes.
- Downward unattributed scrolls outside the band change nothing: pins only move down, so a downward move is ambiguous, and follow-bottom state is left as it stands.

## The supersede table

Deferred writes and the gestures that void them:

| Deferred write | Armed by | Voided when | Mechanism |
|---|---|---|---|
| Cold-boot restore target (`applyRestoreTarget` heartbeat) | `setRestoreTarget` before content settles | `scrollTop` drifts more than `RESTORE_SUPERSEDE_DRIFT_PX` (8px) from the restore's own last write | `_restoreBaselineTop` read-back compare in `smart-scroll.ts` |
| Two-pass scroll correction (pass 2 of the estimated-jump protocol) | an estimated jump to an unmounted row (`scrollToIndex`, `scrollIndexIntoView`, `pageByEntryStep`) | `scrollTop` drifts more than `SCROLL_CORRECTION_SUPERSEDE_DRIFT_PX` (8px) from the pass-1 write's read-back (`armedTop`) | drift check at the top of the correction effect in `tug-list-view.tsx` |
| Follow-bottom growth pins | streaming content growth while following | follow-bottom disengages (any user scroll away, attributed or not) | `maybePinToBottom`'s follow-bottom gate |
| Anchor-state attribute refresh | every commit while unfrozen | never — it *reads* the user's position rather than writing one; it stands down while the scroll battery is frozen or the scroller is boxless | freeze + zero-geometry guards in the anchor-writer effect |

The `armedTop` / baseline pattern is the canonical implementation: record the **read-back** of your own write (clamping folded in), and treat any later position that differs by more than the supersede band as someone else's — then stand down. The band exists because sub-pixel and clamp jitter make exact equality wrong; 8px is established by the restore supersede and reused by the correction supersede.

## The rule for new writers

A new piece of code that wants to write `scrollTop` in or under a `TugListView` surface must do one of:

1. **Route through SmartScroll's chokepoints** (`scrollTo` / `scrollToElement` / `scrollToBottom`, or `maybePinToBottom` for follow-bottom pins). These arm the programmatic phase and the idle suppression, so the write self-attributes and the doctrine holds by construction.
2. **Justify itself against the inventory above** — and then extend the inventory here. A defensible raw write is one the doctrine can classify without new machinery: it only moves `scrollTop` down (pin-shaped), it runs on the user's own gesture call-stack (position-stable-click-shaped), or it explicitly disengages/supersedes first (find-reveal-shaped). **"Clamp-shaped" is no longer a defense** — this list used to offer "it lands where `isAtBottom` holds" as a sanctioned category, which licensed new raw writers on the same falsified model the inventory row carried. A clamp under window churn does not land at the bottom.
3. **Declare the write** by calling `SmartScroll.noteExternalWrite()` immediately afterwards. A raw write's `scroll` event does not dispatch until the current task ends, so anything reading the last-scroll-event position in between sees a stale baseline and can classify a deliberate write as a displacement. Declaring it syncs the baseline and advances the programmatic-write counter, making a raw write indistinguishable from a routed one to the commit bracket. The shipped raw writers — the front-insert prepend compensation, `focus-reveal`'s `revealWithin`, the transcript's `settleFindReveal` — all do this.

A raw upward write that is none of these is a bug waiting for a scrollbar: it will read as user intent to the disengage, or fight a user gesture the supersede rules exist to protect. If a deferred write cannot name the gesture that voids it, it does not ship.

## The clamp happens at removal time

**WebKit clamps the scroll offset synchronously when renderers are removed, inside React's mutation phase. No reader is required and no scroll API can witness it.**

This supersedes the model this section used to state — "the document is transiently short, and the clamp fires when something forces layout in that interval" — which named a real interval but the wrong trigger, and therefore prescribed the wrong defense (hunt the readers). The correction is recorded rather than deleted so it is not quietly re-reverted.

React processes deletions before sibling style updates, so for one instant the removed cells are gone while the spacers still hold their old heights. The browser clamps against that transient extent then and there, and nothing restores the position when the spacers grow microseconds later. The evidence for the trigger: every scroll mover and every layout-forcing getter was wrapped with stack capture and **none ran in the gap**; the per-commit geometry ring showed **no inter-commit height dip**; an `overflow-anchor: none` A/B was pixel-identical, ruling anchoring out. Displacement happened anyway. A defense that depends on controlling who reads geometry cannot work against an actor that needs no reader.

The consequence for windowing surfaces is unchanged in spirit and stronger in practice: **apply spacer/placeholder geometry in the same mutation batch as the row set it complements.** The spacer stands in for the rows the window left out, so the two are one piece of geometry. Splitting them across React's commit boundary — rows removed in the mutation phase, spacer height restored by a `useLayoutEffect` — widens the short-document window from an instant to a whole commit gap, and hands the clamp a much larger dip to act on. Two implementations, both valid:

- **React-native** (`TugListView`): the spacer elements carry `style={{ height }}` from the render body. The post-commit writer must be **deleted**, not kept alongside — React skips re-applying a `style` value it believes unchanged, so two writers go stale against each other.
- **Imperative** (`TugMarkdownView`): `applySpacers` is called in the same synchronous task as the block add/remove loops, so no other code runs between them.

## The extent floor is the defense

**The transcript's scrollable extent is non-decreasing at every instant, including mid-mutation, and every shrink is a declared write.**

A clamp that fires with no reader cannot be prevented by controlling readers, so it is prevented by removing its premise: if the extent never dips, there is nothing to clamp against. `.tug-list-view-floor` is an absolutely-positioned, one-pixel-wide, `pointer-events: none` element whose height the commit bracket writes to the settled extent minus one, every bracket. Between brackets that standing value spans the mutation gap — cells can be removed and spacers can lag, and the document is still as tall as it was.

The rules that make it hold:

- **Set-to-extent, not ratchet.** The bracket writes the settled extent every commit, up *or* down. A strict ratchet with enumerated shrink paths is a list somebody eventually forgets to extend; set-to-extent is self-healing, because a shrink nobody anticipated lowers the floor one commit later instead of leaving permanent phantom scroll space. Slack is bounded at one commit by construction.
- **Lowering is the declared rebase.** The extent shrinks only for attributable reasons — a collapsed block, a pane re-wrap, a density or theme reflow, a cleared session, a data-source swap — each arriving as a commit whose settled extent is smaller. The write flushes layout so any resulting clamp lands *inside* the declared write, pins it with `noteExternalWrite()`, and records an always-recorded `extent-rebase` trace event. That record is Case A's attribution pin: every shrink of the transcript's extent names itself.
- **The `− 1` keeps `scrollHeight` truthful.** The floor never defines the document height, so `scrollHeight` stays a content measurement rather than an echo of the floor's own last write. The residual it accepts is one pixel, and only for a scroller parked at its absolute maximum.

## The commit bracket is a witness, never a repairer

**A displacement the machine cannot account for is recorded loudly and left exactly where the browser put it.**

The bracket used to detect and repair, on the reasoning that a person cannot scroll during synchronous JavaScript, so a cross-commit `scrollTop` difference is machine-caused with certainty. The reasoning was sound and the remedy was still wrong: repairing a displacement means the defect ships, hidden behind a counter-write, and the counter-write is a fight with the browser that the browser is entitled to win. The floor makes the displacement impossible; a record therefore means the floor has a hole, and a hole is a bug to fix, not a symptom to suppress. `notifyRepair`, the repair-suppression flag, the pending-repair carry-forward, and the `repaired` / `priorRepairHeld` record fields are all deleted.

What the bracket still does, and why each part earns its place:

- **The baseline is the last scroll-event position** (`SmartScroll.lastScrollEventTop`), not the previous commit's reading. The previous reading spans real wall time in which a thumb drag and a clamp are indistinguishable. Scroll-event timing discriminates them exactly: a drag delivers scroll events that refresh the baseline before any commit can bracket it, while a clamp's scroll event cannot dispatch until the mutation and layout work has ended.
- **Detection attributes the move.** On a record the bracket calls `noteExternalWrite()`, syncing SmartScroll's baseline to the displaced position and advancing the write counter, so the displacement's still-undelivered `scroll` event arrives with no unexplained delta. The `unattributed-scroll-up` and `drag-up` rules never mistake the browser's move for the user, with no one-shot exemption flag — which is what keeps Case B's "an unattributed upward scroll *is* the user" sound.
- **The record is loud and unconditional.** `scroll-displacement` bypasses the deck-trace enable gate, the dev log takes it at **warn**, and `data-scroll-displacements` counts it on the container. Zero is the invariant, and the tests assert zero rather than a magnitude band — a band is only somewhere for a regression to hide.
- **Whether a displacement persisted is read from consecutive records**, the next record's `from` baseline sitting at the previous record's `to`. No field needs to carry it forward.

Clamps that land **outside** a commit — a late-decoding image, a font swap, a CSS transition settling — are outside the bracket's window, and the floor covers them anyway: the extent does not dip between commits either. Should one occur, attribution and recoverability bound its cost — it never changes follow-bottom, and the growth-time re-engagement below returns the user to the live edge in a moment rather than a session.

## Follow-bottom's polarity

**Engaged is the resting state. Disengaging requires a direct attributed action. Re-engaging requires attributed arrival at the bottom.**

Every disengage in the tree is one of exactly two kinds, and a third kind is a defect:

- **A direct user action** — `wheel-up`, `key-up`, `drag-up`, `unattributed-scroll-up`, `page-up-key`, `scroll-home-key`.
- **A user-requested machine scroll declaring itself as part of its command** — `find-reveal`, `focus-reveal`, `block-fold`, `diff-view-toggle`, `question-review`, `inline-dialog`, and the restore paths `restore-target` / `region-scroll-restore`. The user asked to be taken somewhere; taking them there and leaving them there is the whole request.
- **Anything else is a bug.** A disengage nobody can name is follow-bottom failing silently for the rest of the session.

Three rules carry the polarity:

- **A machine scope that disengaged re-engages only on attributed arrival.** When a scope closes (an inline dialog's, say) it may not simply restore the flag it suspended: the user may have scrolled away to read history while it was open, and that released position is theirs. The scope consults `Scroller.isSettledAtBottom()` — the user's position judged against the live geometry *or* the geometry they were last shown — and engages only if the answer is yes. A user who left keeps what they chose; the four routes below cover their return.
- **User intent is recorded in the capture phase.** `wheel` and `pointerdown` are registered on the scroll container with `capture: true`, so a user disengage lands synchronously ahead of every descendant listener of any phase — including one that stops propagation (the Cmd-wheel inner-scroller route, [D94]) and one that synchronously flushes a commit whose layout effects pin to the bottom. This is Case C's residual obligation: a same-frame pin must not be able to consult a flag the user's gesture has not flipped yet. `keydown` deliberately stays at the **bubble** phase — a key a descendant control consumes (a dialog's arrows, an editor's PageUp) is that control's key, not scroll intent, and bubble semantics are exactly that filter. A wheel carries no such ambiguity: wheeling over an inner scroller is still the user scrolling.
- **Scroll anchoring is gated off while following.** Anchoring holds mid-viewport content still when heights change above it, which is definitionally opposed to the pin — while following, the live edge *is* the position, and the pin is the only writer entitled to hold the viewport anywhere. `SmartScroll` stamps `overflow-anchor: none` on the container at the follow-bottom transition chokepoint and clears it on disengage, so descendants' opt-in (`tug-markdown-block.css`) goes quiet while engaged and resumes the moment the user parks to read — a disengaged reader is exactly who the reading-position hold (`render-incremental.ts`) exists for. An inline style rather than a class, because the gate is a property of following-the-bottom itself and every `SmartScroll` consumer gets it without per-surface CSS ([L06]).

## The four routes back to follow-bottom

Follow-bottom is a state the user can end and the machine cannot. It must never be a one-way door — even perfect attribution misfires eventually, and a state that cannot heal turns every miss into a session-long outage.

1. **Idle scroll into the band** (`idle-reengage`) — an unattributed scroll that lands within `AT_BOTTOM_PX` of the live edge, moving downward. The direction requirement stays here: this fires *during* movement, and a user travelling upward into the band is still heading away.
2. **Gesture end inside the band** (`gesture-end-reengage`, `gesture-end-at-bottom-reengage`) — direction still counts for a gesture ending *near* the bottom, but not for one ending *inside* the band. Gesture end has no motion left to contradict the position.
3. **The jump-to-bottom affordance** — the explicit click.
4. **Growth time, for an idle user inside the band** (`growth-at-bottom-reengage`) — content arriving re-engages before pinning.

The fourth exists because the first three all require the user to *move*. Someone parked at the live edge who touches nothing generates neither a scroll event nor a gesture, and from where they sit the card already looks pinned, so the affordance is a gesture they have no reason to perform. For them the state was terminal, and every append silently failed to arrive. Two field reports have this exact shape: a `/commit` receipt row and a `Session compacted` note, both ordinary appends onto a bottom-parked transcript, both failing to scroll in.

The fourth route carries two carve-outs — never mid-gesture (that decision belongs to gesture end; re-engaging mid-drag pins under the user's own thumb) and never while a restore target is pending (engaging clears the restore target, so a pin mid-restore would destroy the cold-boot placement).

Its accepted cost: a user can no longer hold a *disengaged* position within 60px of the live edge. That follows from the band being the definition of "at the bottom" throughout `SmartScroll` — a peek that stays within 60px is not leaving — but it is a real reduction in what the user can hold, so it is recorded rather than assumed.

## How to diagnose a scroll defect

Every one of these is live in a **release** build with no opt-in, because the sessions that hold the evidence are the ones nobody was watching:

- **The dev panel log** (Opt-Cmd-/): every follow-bottom transition with its source and geometry, every extent rebase, every displacement (at **warn**). Readable from app-tests via `window.tugDevLog.getSnapshot()`.
- **`window.__deckTrace.dump()`**: the `scroll-displacement`, `extent-rebase`, and `follow-bottom` event kinds record through the disabled gate (`ALWAYS_RECORDED_KINDS`) and the window handle is bound in release builds. A displacement record carries the baseline, the observed position, both heights, the follow-bottom state, and whether the commit was evicting; a rebase record carries the floor's old and new heights, the resulting `scrollTop`, and whether the lowering clamped. Read the two together: an unexplained displacement immediately after a rebase is the floor lowering further than the content did.
- **`data-scroll-displacements`** on the scroll container: the count since mount. `"0"` is the invariant — not on a settled transcript, but on every drive, because the floor makes the clamp impossible rather than rare.
- **The eviction A/B arm**: `window.__tug.setTranscriptEvictionDisabled(true)` renders the same transcript with windowing withheld. Displacement that vanishes in that arm and returns when it is re-enabled is window-geometry-caused.
- **`window.__tug.getListConservation(selector)`**: per-eviction ledger-vs-live records, the mounted-cell audit, and the per-commit geometry ring — the instruments that proved the removal-time model. `forceCommitClamp` takes the floor down for one synchronous window, which is how the witness stays testable once the defect is impossible.

Scroll position is appearance-adjacent state that lives in the DOM and in `SmartScroll`'s internals — never in React state ([L06]); the writers read live elements and refs, never captured snapshots ([L07]).

## Cross-references

- [D93] in `design-decisions.md` — the six-phase machine, the six listeners, and the amended attribution guard this doc grounds.
- The two-pass estimated-jump/correction protocol is documented at `pendingScrollCorrectionRef` in `tug-list-view.tsx`; its pass 2 is the supersedable correction above.
- `card-state-model.md` / `state-preservation.md` — where the anchor the anchor-writer serializes is saved and restored.
- `tests/app-test/at0333-follow-bottom-unattributed.test.ts` — the polarity pins (scrollbar-silent disengage, correction supersede, re-engage, the gesture-end re-engage with the anchoring gate's two states, and the dialog-close attributed-arrival rule in both directions).
- `tests/app-test/at0335-scroll-displacement.test.ts` — the clamp pins (counter published, a simulated clamp witnessed and never counter-written, window swaps clean, wheel reaches the bottom, a clamp never flips follow-bottom, quiet arrival, idle-user recovery). Every real drive asserts **zero** on both surfaces — the attribute and the trace ring; only the `forceCommitClamp` tests see a nonzero count, because they take the floor down and manufacture the record deliberately.
- `tests/app-test/at0336-conservation-probe.test.ts` — the permanent conservation harness: the ledger-vs-live probe, the window-swap replica that once displaced 2,368px deterministically, the anchoring-off A/B, the mover-capture proof that no JavaScript runs in the gap, and the height-post countermeasure that became the floor.
- `dash/scroll-height-floor.md` — the brief that produced the floor, the witness, and this amendment, with the governing assertions (Cases A/B/C) stated in full.
