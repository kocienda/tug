/**
 * SmartScroll — scroll state machine and auto-scroll manager.
 *
 * Models UIScrollView/UIScrollViewDelegate for the web. Manages a scroll
 * container element, tracks scroll phases (idle, tracking, dragging,
 * decelerating, programmatic), provides programmatic scroll methods, fires
 * lifecycle callbacks, and owns two built-in scroll-position policies:
 * auto-follow-bottom (pin to the live edge as content grows) and
 * cold-boot scroll restore (re-place the scroller at a saved
 * mid-content position via a consumer-supplied resolver). The two are
 * mutually exclusive — engaging the live edge clears a pending restore.
 *
 * Architecture [D93]:
 *   The state machine is the guard for distinguishing user scrolls from
 *   programmatic or DOM-manipulation-caused scrolls. No timing hacks, no
 *   rAF+setTimeout, no flags cleared after arbitrary delays.
 *
 *   Six listeners:
 *   1. scroll on container (passive) — onScroll callback, lastScrollTop update,
 *      phase transitions, follow-bottom re-engagement, and the idle-phase
 *      unattributed disengage (native scrollbar drags emit no pointer or
 *      wheel events; an idle upward scroll we did not cause is the user).
 *   2. scrollend on container — terminal signal for deceleration and programmatic
 *      animation. Feature-detected at construction; 150ms timer fallback for
 *      browsers without it.
 *   3. pointerdown on container (passive, capture) — enters TRACKING phase.
 *   4. pointerup/pointercancel on document (passive) — exits DRAGGING; 50ms check
 *      determines whether DECELERATING follows (via SETTLING phase).
 *   5. wheel on container (passive, capture) — skips TRACKING, enters DRAGGING
 *      immediately; disengages follow-bottom on deltaY < 0.
 *   6. keydown on container — scroll keys skip TRACKING, enter DRAGGING immediately.
 *      Only scroll-up keys disengage follow-bottom.
 *
 *   The intent listeners (3, 5) run in the CAPTURE phase. A user disengage
 *   must land synchronously ahead of anything else the same event can set
 *   in motion — a descendant handler that stops propagation (the
 *   Cmd-wheel inner-scroller route) or one that flushes a commit whose
 *   layout effects pin to the bottom. Ancestor capture runs before every
 *   descendant listener of any phase, so the wheel-up disengage is
 *   recorded before a same-frame pin can consult the flag it flips.
 *   keydown deliberately stays at the bubble phase: a key consumed by a
 *   descendant control (a dialog's arrows, an editor's PageUp) is that
 *   control's key, not scroll intent, and bubble semantics are exactly
 *   that filter. A wheel has no such ambiguity — wheeling over an inner
 *   scroller is still the user scrolling.
 *
 * Not a React hook — a plain class that manages DOM listeners directly.
 * Callers create an instance and call dispose() when done.
 *
 * Modeled after UIScrollView/UIScrollViewDelegate.
 * Studied from use-stick-to-bottom (StackBlitz Labs, MIT license).
 * See THIRD_PARTY_NOTICES.md.
 *
 * @module lib/smart-scroll
 */

import { deckTrace } from "../deck-trace";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Scroll phase — mutually exclusive states. */
export type ScrollPhase = 'idle' | 'tracking' | 'dragging' | 'settling' | 'decelerating' | 'programmatic';

/** Lifecycle callbacks — modeled after UIScrollViewDelegate. */
export interface SmartScrollCallbacks {
  /** Fires for ALL scroll sources. Like scrollViewDidScroll. */
  onScroll?: (scroll: SmartScroll) => void;

  /** User drag started (pointer/wheel/keyboard). Like scrollViewWillBeginDragging. */
  onWillBeginDragging?: (scroll: SmartScroll) => void;
  /** User drag ended. Like scrollViewDidEndDragging(willDecelerate:). */
  onDidEndDragging?: (scroll: SmartScroll, willDecelerate: boolean) => void;

  /** Momentum coast started. Like scrollViewWillBeginDecelerating. */
  onWillBeginDecelerating?: (scroll: SmartScroll) => void;
  /** Momentum coast ended. Like scrollViewDidEndDecelerating. */
  onDidEndDecelerating?: (scroll: SmartScroll) => void;

  /** Programmatic animated scroll completed. Like scrollViewDidEndScrollingAnimation. */
  onDidEndScrollingAnimation?: (scroll: SmartScroll) => void;

  /** Any scroll sequence completed (user or programmatic). */
  onDidEndScrolling?: (scroll: SmartScroll) => void;

  /** Auto-follow-bottom state changed. */
  onFollowBottomChanged?: (scroll: SmartScroll, following: boolean) => void;
}

/** Constructor options. */
export interface SmartScrollOptions {
  scrollContainer: HTMLElement;
  callbacks?: SmartScrollCallbacks;
  /**
   * Whether this scroller follows its bottom edge at all. Default: true.
   *
   * `false` is a standing policy, not a starting position: a scroller that
   * says it does not follow the bottom is never auto-engaged afterwards, by
   * any route. The distinction is the difference between a transcript whose
   * user has scrolled up — off now, and rightly re-engaged the moment they
   * park back at the edge — and a settings list, which has no live edge to
   * return to. Without it, `maybePinToBottom`'s re-engage route reads an
   * idle-at-bottom list as a reader waiting for the next append, and any
   * content growth (a row opening an editor under itself) yanks everything
   * above it upward.
   */
  followBottom?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fixed pixel threshold for the "at bottom" check. Used for disengagement
 *  jitter guard and conservative auto-re-engagement at idle. Small and fixed. */
const AT_BOTTOM_PX = 60;

/**
 * All scroll key codes that initiate user scroll without pointer input.
 * The scroll container needs tabindex="0" for keydown to fire on it.
 */
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'Space']);

/**
 * Scroll-up key codes that should disengage follow-bottom.
 */
const SCROLL_UP_KEYS = new Set(['PageUp', 'Home', 'ArrowUp']);

/**
 * True when the keydown event's target is an editable element —
 * `<input>`, `<textarea>`, `<select>`, or any element with
 * `contenteditable`. SmartScroll skips its keydown handling for
 * these so cursor-movement keys typed into a cell's input do not
 * register as scroll intent.
 *
 * Module-private; not part of the public surface.
 */
function _isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === 'INPUT') return true;
  if (target.tagName === 'TEXTAREA') return true;
  if (target.tagName === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * After pointerup, wait this long for continued scroll events before deciding
 * that no momentum deceleration is happening. This is a state machine
 * transition guard — not a timing hack for filtering scroll events.
 */
const DECELERATION_DETECTION_MS = 50;

/**
 * Timer fallback for browsers that don't support the scrollend event.
 * Only used when 'onscrollend' in element returns false at construction.
 * Restarted on every scroll event so it fires 150ms after the last scroll.
 */
const SCROLLEND_FALLBACK_MS = 150;

/**
 * Drift beyond which a pending cold-boot restore concedes the scroll
 * position to whoever moved it. The restore heartbeat records the
 * post-write `scrollTop` (clamping folded in); if the next heartbeat
 * finds the scroller more than this far from that baseline, some
 * actor SmartScroll cannot see moved it — above all the native
 * scrollbar, whose drag produces no pointer or wheel events on the
 * container, so the phase machine never leaves `idle` and the
 * `isUserScrolling` supersede can't fire. Without this, a scrollbar
 * scrub fights the restore write on every layout heartbeat: the user
 * drags toward the bottom, the restore yanks `scrollTop` back to the
 * anchor, repeatedly, with no gesture that ends it. Matches
 * CardHost's `REGION_SCROLL_TOLERANCE_PX`.
 *
 * Follow-bottom applies the same attribution rule from the other
 * side: an idle upward scroll SmartScroll did not cause (the
 * scrollbar again) disengages follow-bottom, so growth pins stop
 * fighting the drag. See `_handleScroll`'s idle case.
 */
const RESTORE_SUPERSEDE_DRIFT_PX = 8;

/** What `restoreSupersede` needs to know to decide who owns the position. */
export interface RestoreSupersedeInput {
  /** A gesture SmartScroll can see is in progress. */
  readonly isUserScrolling: boolean;
  /** `scrollTop` as the last heartbeat left it, or `null` before the first. */
  readonly baselineTop: number | null;
  /** `scrollTop` right now. */
  readonly currentTop: number;
  /** Whether the installed target waives the drift rule (a width change). */
  readonly suspendDriftSupersede: boolean;
}

/**
 * Decide whether a pending restore has been superseded, and by what.
 *
 * `'gesture'` is a scroll SmartScroll saw. `'drift'` is the scroller
 * found away from where the last heartbeat left it with no gesture to
 * explain it — a native scrollbar drag delivers no events, so the phase
 * machine sits in `idle` while the user scrubs, and the displacement is
 * the only evidence there is. `null` means the restore still owns the
 * position.
 *
 * A target that suspends the drift rule owns a reflow that moves
 * `scrollTop` on its own — content re-wrapping *above* the viewport when
 * a card changes width. There the displacement is the restore's own
 * work, carries no information about who caused it, and reading it as a
 * scrollbar drag would cancel the restore on its first delivery.
 */
export function restoreSupersede(
  input: RestoreSupersedeInput,
): 'gesture' | 'drift' | null {
  if (input.isUserScrolling) return 'gesture';
  if (input.suspendDriftSupersede) return null;
  if (input.baselineTop === null) return null;
  return Math.abs(input.currentTop - input.baselineTop) >
    RESTORE_SUPERSEDE_DRIFT_PX
    ? 'drift'
    : null;
}

/**
 * One delivered `scroll` event, kept for the follow-bottom flip
 * record's ring. See {@link SmartScroll._scrollRing}.
 */
interface ScrollSample {
  t: number;
  top: number;
  sh: number;
  ch: number;
}

/**
 * How many recent `scroll` events a flip record carries.
 *
 * Sixteen spans a wheel burst's opening ticks at 60Hz — enough to see
 * whether a move arrived as a stream (a hand) or alone (a clamp) — and
 * costs one small object per scroll event, allocated whether or not
 * anyone is watching. That is the point: the sessions holding the
 * evidence for a follow-bottom defect are the ones nobody instrumented,
 * so the ring cannot be opt-in.
 */
const SCROLL_RING_CAPACITY = 16;

// ---------------------------------------------------------------------------
// Scroller registry
// ---------------------------------------------------------------------------

/**
 * Every live `SmartScroll`, keyed by the element it manages.
 *
 * A `SmartScroll` is otherwise reachable only by the component that
 * constructed it — the list view holds it in a ref and publishes a
 * narrow `Scroller` façade to its React descendants through context.
 * Neither route exists for code outside the tree: the test surface and
 * `/api/eval` can find the scroll *element* by its
 * `data-tug-scroll-key` selector but have nothing to hand it to.
 *
 * The registry closes that gap with the mapping the DOM already
 * implies. Entries are added in the constructor and removed in
 * `dispose()`, so a stale scroller is never handed out.
 */
const scrollerRegistry = new Map<Element, SmartScroll>();

/**
 * The `SmartScroll` managing `el`, or `null` when `el` is not a
 * scroll container (or its scroller has been disposed).
 *
 * Intended for out-of-tree callers — the test surface, console
 * diagnosis — that resolve an element by selector first. In-tree
 * consumers should use the `useScroller()` façade, which carries the
 * source-tagging discipline the raw instance does not enforce.
 */
export function smartScrollForElement(el: Element | null): SmartScroll | null {
  if (el === null) return null;
  return scrollerRegistry.get(el) ?? null;
}

// ---------------------------------------------------------------------------
// SmartScroll
// ---------------------------------------------------------------------------

export class SmartScroll {
  private readonly _container: HTMLElement;
  private readonly _callbacks: SmartScrollCallbacks;
  private readonly _supportsScrollEnd: boolean;

  private _phase: ScrollPhase = 'idle';
  private _isFollowingBottom: boolean;
  /** Whether follow-bottom may ever be engaged. See `SmartScrollOptions`. */
  private readonly _followBottomAllowed: boolean;
  private _lastScrollTop: number;
  // The constructor deliberately does NOT read `scrollContainer.scrollTop` to
  // seed `_lastScrollTop`: that read forces a synchronous layout, and the
  // constructor runs inside the list view's mount `useLayoutEffect`, so on a
  // cold transcript load it reflows a freshly-built (huge) container before
  // paint. `_lastScrollTop` is only consumed by the scroll/pointer handlers,
  // which can't fire before the first scroll — so the baseline is seeded lazily
  // on that first event instead. Until then it holds 0.
  private _scrollTopSeeded = false;
  private _disposed = false;

  // One-shot guard: the next scroll event won't fire idle-phase
  // auto-re-engagement of follow-bottom. Set by `scrollTo` so that
  // the deferred scroll event emitted by a programmatic write
  // doesn't flip follow-bottom back on. Without this, a state-
  // restore path that explicitly disengages follow-bottom and writes
  // a saved scrollTop has its disengage immediately undone by the
  // deferred event's auto-re-engagement check — which fires whenever
  // `isAtBottom` is satisfied while content is still settling.
  //
  // Consumed on the FIRST `_handleScroll` invocation after the
  // programmatic write — regardless of phase — and immediately
  // cleared so a subsequent genuine user scroll re-engages
  // normally.
  private _suppressIdleReengagementOnNextScroll = false;

  // Signed `deltaY` accumulated over the current wheel gesture, reset
  // when a gesture begins. The user's stated direction.
  //
  // The `drag-up` rule needs a direction, and position is the wrong
  // measure for one during a streaming burst: growth pins and
  // scrollHeight jitter move `scrollTop` independently of the user's
  // hand, and a large clamp can land the position ABOVE any position
  // baseline — so position-vs-gesture-start disengages on exactly the
  // case the rule needs to tolerate. The wheel deltas are the hand.
  private _gestureWheelDeltaAccum = 0;

  // Monotonic counter of user input events that carry scroll intent —
  // wheel, pointerdown, and scroll-key keydown. A consumer that wants
  // to reason about an interval ("did the user touch this scroller
  // between these two points?") samples the counter at each end and
  // compares. It counts input, not scroll events, so it answers even
  // for a gesture whose scroll events have not been dispatched yet.
  private _userActivitySeq = 0;

  // Monotonic counter of writes that MOVED the scroller. Advanced at
  // every site that assigns `container.scrollTop` — `_writeScrollTop`,
  // `pinToBottom`, and `noteExternalWrite` on behalf of a direct
  // writer outside this class.
  //
  // "Moved", not "was called": `pinToBottom` early-returns when the
  // scroller is already at the maximum, which is the common case on a
  // transcript that is already pinned — most streaming commits. A
  // counter that advanced on every call would look permanently busy
  // to a consumer using it to exempt machine writes, blinding it
  // exactly when the transcript is most active.
  private _programmaticWriteSeq = 0;

  // Writes that have moved the scroller since the last `scroll` event
  // was delivered. Incremented alongside `_programmaticWriteSeq`,
  // zeroed in `_handleScroll`.
  //
  // This is the freshness of `_lastScrollTop`. Scroll events are
  // dispatched from the event loop, so between a write and its event
  // the recorded position is a lie — it describes where the scroller
  // was, not where it is. A consumer comparing the live position
  // against a stale baseline sees a difference nobody caused and, if
  // it acts on one, fights the very writes that created it. Streaming
  // growth is a continuous stream of such writes, so this is the
  // common case, not an edge one.
  private _writesSinceScrollEvent = 0;

  // `scrollHeight` as of the same `scroll` event that set
  // `_lastScrollTop`. The two are read together so they describe one
  // moment — a consumer asking "did the document explain this move?"
  // needs both halves from the same instant or the arithmetic is
  // meaningless.
  //
  // Costs no extra layout: `_handleScroll` already reads `scrollTop`,
  // which flushes layout, so the height comes from the same
  // computation.
  private _lastScrollEventHeight = 0;

  // The last `SCROLL_RING_CAPACITY` delivered `scroll` events, oldest
  // first. Filled from `_handleScroll`, which has already flushed
  // layout for its own rules, so the samples cost no extra reads.
  //
  // Read only when a follow-bottom flip is recorded. A flip's `source`
  // names the rule that fired; the ring is the evidence the rule acted
  // on, and for `unattributed-scroll-up` it is the whole diagnosis: one
  // isolated upward sample with `sh` unchanged on both sides is a
  // browser clamp, a stream of them is a hand on the scrollbar. Nothing
  // else in the system can tell those apart after the fact.
  private readonly _scrollRing: ScrollSample[] = [];

  // `performance.now()` of the last user input carrying scroll intent,
  // or `null` before the first. Recorded alongside `_userActivitySeq`
  // — the counter answers "did the user touch this?", this answers
  // "how long ago?", and a disengage attributed to the user minutes
  // after their last input is a contradiction the record should show.
  private _lastUserInputAt: number | null = null;

  // Timer handles
  private _decelerationTimer: ReturnType<typeof setTimeout> | null = null;
  private _scrollEndTimer: ReturnType<typeof setTimeout> | null = null;

  // Deceleration detection: did scroll events arrive during the 50ms window?
  private _scrolledAfterPointerUp = false;

  // Gesture direction tracking: scrollTop at the start of the current gesture.
  // Used to determine net direction (up vs down) when the gesture ends.
  // Re-engagement at idle only fires if the gesture was net-downward.
  private _gestureStartScrollTop: number = 0;

  // Pending cold-boot scroll-restore resolver, or `null` when no
  // restore is in flight. A consumer that mounts into a saved
  // mid-content scroll position installs a resolver via
  // `setRestoreTarget`; it returns the desired `scrollTop` (or `null`
  // while the target is not yet resolvable — e.g. the anchor cell is
  // not in range, or content has not laid out). `applyRestoreTarget`
  // re-resolves and writes the target on each layout signal the
  // consumer forwards, until the user gestures or follow-bottom
  // engages — at which point the restore is superseded and cleared.
  // The resolver, not a stored pixel value, is the contract: as
  // virtualized content settles its heights the resolved offset
  // drifts, and the restore tracks it.
  private _restoreTarget: (() => number | null) | null = null;

  // `scrollTop` as it stood at the end of the last restore heartbeat
  // (read back after the write, so browser clamping is folded in), or
  // `null` before the first heartbeat resolves the target. The next
  // heartbeat compares the live `scrollTop` against this: drift beyond
  // `RESTORE_SUPERSEDE_DRIFT_PX` means an actor SmartScroll cannot
  // attribute — a scrollbar drag, chiefly — moved the scroller, and
  // the restore is superseded. See `applyRestoreTarget`.
  private _restoreBaselineTop: number | null = null;

  // Whether the installed target waives the baseline-drift supersede
  // above. The supersede's premise is that content changes do not move
  // `scrollTop`, which holds for growth BELOW the viewport and fails for
  // a re-wrap ABOVE it — exactly what a card width change produces. A
  // restore installed to survive a width change would therefore read its
  // own reflow as a scrollbar drag and cancel itself on the first
  // delivery. `isUserScrolling` still supersedes, so a real gesture
  // during the resize still takes the position.
  private _restoreSuspendsDriftSupersede = false;

  // Listener function references stored for removeEventListener
  private readonly _onScroll: () => void;
  private readonly _onScrollEnd: () => void;
  private readonly _onPointerDown: (e: PointerEvent) => void;
  private readonly _onPointerUp: (e: PointerEvent) => void;
  private readonly _onWheel: (e: WheelEvent) => void;
  private readonly _onKeyDown: (e: KeyboardEvent) => void;

  constructor(options: SmartScrollOptions) {
    const {
      scrollContainer,
      callbacks = {},
      followBottom = true,
    } = options;

    this._container = scrollContainer;
    this._callbacks = callbacks;
    this._isFollowingBottom = followBottom;
    this._followBottomAllowed = followBottom;
    // Seeded lazily on the first scroll event — see `_scrollTopSeeded`.
    this._lastScrollTop = 0;

    // Feature-detect scrollend support.
    this._supportsScrollEnd = 'onscrollend' in scrollContainer;

    // Bind listeners.
    this._onScroll = this._handleScroll.bind(this);
    this._onScrollEnd = this._handleScrollEnd.bind(this);
    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerUp = this._handlePointerUp.bind(this);
    this._onWheel = this._handleWheel.bind(this);
    this._onKeyDown = this._handleKeyDown.bind(this);

    // Register listeners. pointerdown and wheel use the capture phase —
    // see the header's ordering note: the disengage must be recorded
    // before any descendant handler (including one that stops
    // propagation or synchronously flushes a pinning commit) can run.
    scrollContainer.addEventListener('scroll', this._onScroll, { passive: true });
    if (this._supportsScrollEnd) {
      scrollContainer.addEventListener('scrollend', this._onScrollEnd, { passive: true });
    }
    scrollContainer.addEventListener('pointerdown', this._onPointerDown, { passive: true, capture: true });
    document.addEventListener('pointerup', this._onPointerUp, { passive: true });
    document.addEventListener('pointercancel', this._onPointerUp, { passive: true });
    scrollContainer.addEventListener('wheel', this._onWheel, { passive: true, capture: true });
    // keydown does not use passive:true here — that option is not universally
    // accepted for keydown and we don't call preventDefault in this handler.
    // And it is bubble-phase on purpose: a key a descendant control consumes
    // is not scroll intent (header ordering note).
    scrollContainer.addEventListener('keydown', this._onKeyDown);

    scrollerRegistry.set(scrollContainer, this);
    this._applyAnchoringGate();
  }

  // -------------------------------------------------------------------------
  // Public state (read-only)
  // -------------------------------------------------------------------------

  get phase(): ScrollPhase { return this._phase; }

  get scrollTop(): number { return this._container.scrollTop; }
  get scrollHeight(): number { return this._container.scrollHeight; }
  get clientHeight(): number { return this._container.clientHeight; }

  get isAtBottom(): boolean {
    const { scrollTop, scrollHeight, clientHeight } = this._container;
    return scrollHeight - clientHeight - Math.max(0, scrollTop) <= AT_BOTTOM_PX;
  }

  get isAtTop(): boolean {
    return this._container.scrollTop <= 0;
  }

  /** At the bottom, judged against the live geometry OR the resting
   *  geometry (the position and height as of the last delivered scroll
   *  event).
   *
   *  The live reading alone has a hole exactly the size of the growth
   *  that asks the question: a whole turn landing in one commit grows
   *  the extent by hundreds of pixels before any consumer reads it, so
   *  an idle user parked at the old bottom measures hundreds of pixels
   *  "away" from a bottom they never left. The resting reading asks
   *  the right question — was the user at the bottom of everything
   *  they had been shown? — because an idle user's distance from the
   *  bottom only changes when THEY move, and their moves deliver
   *  scroll events that refresh both resting figures. Unseeded resting
   *  geometry (height 0, no scroll event yet) is no evidence and does
   *  not vote.
   *
   *  This is the judgment behind `maybePinToBottom`'s recovery route
   *  and the one a deliberate machine disengage (an inline dialog's
   *  scope) consults at its close: "still settled at the bottom" is
   *  the attributed arrival that licenses re-engaging follow-bottom. */
  get isSettledAtBottom(): boolean {
    const restingAtBottom =
      this._lastScrollEventHeight > 0 &&
      this._lastScrollEventHeight -
        this._container.clientHeight -
        Math.max(0, this._lastScrollTop) <=
        AT_BOTTOM_PX;
    return this.isAtBottom || restingAtBottom;
  }

  /** True when the container has scroll room — its content overflows the
   *  viewport. When false (content fits entirely), there is no bottom to
   *  follow or scroll away from, so the intent-based disengage paths
   *  (wheel-up, scroll-up keys) must not flip follow-bottom off: a trackpad
   *  gesture fires `deltaY < 0` even with no scroll room, which would
   *  otherwise summon the jump-to-bottom affordance on a card that doesn't
   *  scroll at all. The position-based disengage (`dragging` scroll handler)
   *  is already immune via its `!isAtBottom` guard. */
  get isScrollable(): boolean {
    return this._container.scrollHeight > this._container.clientHeight;
  }

  /** True while the user is actively interacting (tracking, dragging, settling, or decelerating). */
  get isUserScrolling(): boolean {
    const p = this._phase;
    return p === 'tracking' || p === 'dragging' || p === 'settling' || p === 'decelerating';
  }

  get isFollowingBottom(): boolean { return this._isFollowingBottom; }

  /** Monotonic count of user input events carrying scroll intent
   *  (wheel, pointerdown, scroll-key keydown). See
   *  `_userActivitySeq`. */
  get userActivitySeq(): number { return this._userActivitySeq; }

  /** Monotonic count of writes that moved `scrollTop`. See
   *  `_programmaticWriteSeq` — it counts writes, not calls. */
  get programmaticWriteSeq(): number { return this._programmaticWriteSeq; }

  /**
   * `scrollTop` as of the most recent `scroll` event.
   *
   * This is the one position reading that a native scrollbar drag
   * refreshes. The scrollbar thumb delivers no pointer or wheel
   * events, so the phase machine cannot see it — but it does deliver
   * scroll events, and `_handleScroll` records each one here. A
   * browser clamp, by contrast, moves `scrollTop` synchronously at
   * forced layout and its scroll event does not dispatch until the
   * layout phase has ended, so this value is still pre-clamp when a
   * synchronous observer reads it.
   *
   * That timing difference is what lets a consumer inside a
   * synchronous commit tell "the user dragged" from "the browser
   * clamped" without guessing. Before the first scroll event since
   * construction, this reads 0 (the baseline is seeded lazily to
   * avoid a layout-forcing read in the constructor).
   */
  get lastScrollEventTop(): number { return this._lastScrollTop; }

  /**
   * True when {@link lastScrollEventTop} reflects the scroller's
   * current position — no write has moved it since the last `scroll`
   * event was delivered.
   *
   * Anything comparing the live position against that baseline must
   * check this first. Scroll events dispatch from the event loop, so
   * a write and its event are separated by at least a task, and in
   * that gap the baseline describes the past. Streaming growth pins
   * the scroller continuously, so on a live transcript the baseline
   * is stale most of the time — a consumer that skips this check
   * reads its own writes as movement nobody authored and reports
   * phantom displacements against the stream.
   */
  get isScrollBaselineFresh(): boolean {
    return this._writesSinceScrollEvent === 0;
  }

  /** `scrollHeight` as of the same `scroll` event as
   *  {@link lastScrollEventTop}. Pair them to ask whether a change in
   *  the document explains a change in the position. */
  get lastScrollEventHeight(): number { return this._lastScrollEventHeight; }

  // -------------------------------------------------------------------------
  // Public API — programmatic scroll
  // -------------------------------------------------------------------------

  scrollTo(options: { top?: number; left?: number; animated?: boolean }): void {
    if (this._disposed) return;
    const { top, animated = false } = options;
    if (top === undefined) return;
    // An explicit programmatic scroll supersedes a pending cold-boot
    // restore — the consumer has named a position, so a restore that
    // would pull `scrollTop` back to the saved anchor must be
    // dropped. The restore heartbeat (`applyRestoreTarget`) writes
    // through the private `_writeScrollTop` directly, NOT this
    // method, so it does not clear its own target.
    this.clearRestoreTarget();
    this._writeScrollTop(top, animated);
  }

  /**
   * Programmatic `scrollTop` write — the shared mechanism behind the
   * public `scrollTo` and the cold-boot restore heartbeat. Enters the
   * programmatic phase and arms the one-shot idle-re-engagement
   * suppression so the deferred scroll event this write emits cannot
   * flip follow-bottom back on: without it, a restore path that
   * disengages follow-bottom before writing would have its disengage
   * undone by the deferred event's `isAtBottom`-driven re-engagement.
   * The flag is consumed by the FIRST `_handleScroll` invocation.
   *
   * Does NOT touch the restore target — the caller owns that policy:
   * the public `scrollTo` clears it (an explicit scroll supersedes a
   * restore); `applyRestoreTarget` preserves it (the restore must
   * re-apply across the content-settle window).
   */
  private _writeScrollTop(top: number, animated: boolean): void {
    this._enterProgrammatic();
    this._suppressIdleReengagementOnNextScroll = true;
    this._programmaticWriteSeq += 1;
    this._writesSinceScrollEvent += 1;
    if (animated) {
      this._container.scrollTo({ top, behavior: 'smooth' });
      // scrollend event (or 150ms fallback) will return us to idle.
    } else {
      this._container.scrollTop = top;
      // Non-animated: target is reached immediately.
      this._exitProgrammaticImmediate();
    }
  }

  scrollToTop(animated = false): void {
    this.scrollTo({ top: 0, animated });
  }

  scrollToBottom(animated = false): void {
    if (this._disposed) return;
    this._setFollowingBottom(true, 'scroll-to-bottom');
    // 2^30 sentinel: large enough to exceed any real document height,
    // small enough to avoid WebKit's 32-bit int overflow. The browser
    // clamps to `scrollHeight - clientHeight` for us.
    this.scrollTo({ top: 0x40000000, animated });
  }

  /** Slam scrollTop to bottom without entering programmatic phase.
   *  Used for content growth while following bottom. Stays in idle. [D93]
   *
   *  Idempotent: reads the live scroll geometry and skips the write when
   *  scrollTop is already at (or past) the maximum. Setting scrollTop to a
   *  clamped value is *logically* a no-op, but on WebKit the assignment can
   *  still fire a scroll event regardless, which feeds back into a caller
   *  that re-runs after every commit (see TugListView's post-commit pin
   *  effect) and produces a 60Hz scrollTop-write loop on relaunch. The
   *  callers have just committed, so the layout read here is fresh and
   *  cheap.
   *
   *  This is a SECOND, independent `scrollTop` write site: it does not
   *  route through `_writeScrollTop`, because a pin must stay in the
   *  `idle` phase [D93]. It therefore advances the programmatic-write
   *  counter itself — after the already-at-max early return, so the
   *  counter keeps meaning "a write moved the scroller". Missing it
   *  would let a consumer that exempts machine writes read the hottest
   *  write in the system (every growth pin while following bottom) as
   *  something it did not cause. */
  pinToBottom(): void {
    if (this._disposed) return;
    const max = this._container.scrollHeight - this._container.clientHeight;
    if (this._container.scrollTop >= max) return;
    this._container.scrollTop = Math.max(0, max);
    this._programmaticWriteSeq += 1;
    this._writesSinceScrollEvent += 1;
  }

  /**
   * Declare that the caller just wrote `container.scrollTop` directly,
   * outside this class.
   *
   * A handful of writers legitimately bypass SmartScroll — the list
   * view's front-insert prepend compensation, `focus-reveal`'s
   * `revealWithin`, the transcript's `settleFindReveal`. Their write
   * lands synchronously but its `scroll` event does not dispatch until
   * the current task ends, so anything reading `lastScrollEventTop` in
   * between sees a stale position and can mistake the write for a
   * displacement nobody authored.
   *
   * Calling this immediately after the write closes that window: it
   * syncs the baseline from the live position and advances the
   * programmatic-write counter, making a direct write indistinguishable
   * from a routed one to any consumer reasoning about the interval.
   */
  noteExternalWrite(): void {
    if (this._disposed) return;
    this._lastScrollTop = this._container.scrollTop;
    this._scrollTopSeeded = true;
    this._programmaticWriteSeq += 1;
    this._writesSinceScrollEvent += 1;
  }

  /** True when a content-growth signal should auto-pin the scroller to the
   *  bottom: the scroller is following the bottom (intent) AND the user is
   *  either idle OR still sitting at the live edge.
   *
   *  This is the single home of the auto-pin gate. Auto-pin callers
   *  previously re-derived it inline at many sites — the list view's three
   *  growth-pin paths, the markdown view's two raw `scrollTop` slams (which
   *  omitted the user-gesture half entirely and so fought an in-flight user
   *  gesture), and the markdown view's predicted-bottom render decision.
   *  Reading the gate from one place keeps the policy consistent.
   *
   *  The `isAtBottom` clause is what keeps a *downward* gesture pinned. A
   *  downward wheel enters the `dragging` phase (so `isUserScrolling` is
   *  true) but does NOT disengage follow-bottom — only an upward/away
   *  gesture does (wheel-up, key-up, drag-up all call
   *  `_setFollowingBottom(false)`). So a gesture that leaves
   *  `_isFollowingBottom` engaged is, by construction, one heading to or
   *  sitting at the live edge — and while the scroller is still at the
   *  bottom, freshly streamed content must keep pinning rather than open a
   *  gap beneath a user parked at the edge. Without this clause, a user who
   *  wheels down mid-stream falls behind the growing bottom while the card
   *  still reports itself "pinned." Once the user scrolls away past the
   *  at-bottom band the disengage paths flip `_isFollowingBottom` off, so
   *  this never yanks a user who has genuinely left the bottom.
   *
   *  Exposed as a getter (not just folded into `maybePinToBottom`) because
   *  some callers need the gate as a *value* — e.g. choosing whether to
   *  render the virtualized window at the predicted bottom or at the
   *  user's live scroll position. */
  get shouldAutoPin(): boolean {
    return this._isFollowingBottom && (!this.isUserScrolling || this.isAtBottom);
  }

  /** Pin to bottom when `shouldAutoPin` — the convenience wrapper for the
   *  pure-pin case (a ResizeObserver fire, a spacer reflow, a post-commit
   *  re-window). The underlying `pinToBottom` is idempotent, so a call
   *  that passes the gate but finds scrollTop already at the bottom is a
   *  cheap no-op.
   *
   *  **Also the last route back to follow-bottom.** Every other route
   *  requires the user to move: `idle-reengage` needs a scroll event,
   *  the gesture-end paths need a gesture, and the jump-to-bottom
   *  affordance needs a click. A user parked at the live edge who
   *  touches nothing can fire none of them — and from where they sit
   *  the card already looks pinned, so they have no reason to try. If
   *  follow-bottom is off for them, it is off forever, and every
   *  append silently fails to arrive. That is the shape of two field
   *  reports: a `/commit` receipt row and a `Session compacted` note,
   *  both ordinary appends onto a bottom-parked transcript, both
   *  failing to scroll in.
   *
   *  So content arriving while the scroller sits inside the band
   *  re-engages before pinning. This is not a new principle — it is
   *  the one `shouldAutoPin`'s `isAtBottom` clause already encodes for
   *  the engaged case, where content must not open a gap beneath a
   *  user at the edge. The same reasoning applies when the flag is off
   *  and the position is in the band. It does not depend on knowing
   *  WHY the disengage happened, so it also bounds the cost of any
   *  displacement that lands outside a commit.
   *
   *  Two carve-outs. Never mid-gesture: an in-flight gesture's
   *  re-engagement belongs to `_checkReEngageFollowBottom` at gesture
   *  end, and re-engaging mid-drag would pin under the user's own
   *  thumb. Never while a restore is pending: `setRestoreTarget`
   *  disengaged deliberately and `applyRestoreTarget` owns the
   *  position until it clears — and since engaging calls
   *  `clearRestoreTarget()`, a pin arriving mid-restore would destroy
   *  the cold-boot target outright.
   *
   *  The policy lives here rather than at the call sites because this
   *  method is the single home of the auto-pin gate — which means it
   *  is wider than "growth time" suggests. All five call sites reach
   *  it: the list view's per-cell `ResizeObserver` flush (continuous
   *  during streaming as cells re-wrap), its container `ResizeObserver`
   *  (pane and window resize), its growth pin (the signal the field
   *  cases need), and `TugMarkdownView`'s two. A cell or container
   *  resize while the user sits idle in the band re-engages too. That
   *  is intended: the policy is about the position, not about which
   *  signal happened to ask.
   *
   *  At-bottom is judged by {@link isSettledAtBottom} — the live
   *  geometry OR the resting geometry as of the last delivered scroll
   *  event. See that getter for why the live reading alone strands an
   *  idle user behind a whole turn landing in one commit. */
  maybePinToBottom(): void {
    if (this._disposed) return;
    if (
      !this._isFollowingBottom &&
      !this.isUserScrolling &&
      this._restoreTarget === null &&
      this.isSettledAtBottom
    ) {
      this._setFollowingBottom(true, 'growth-at-bottom-reengage');
    }
    if (this.shouldAutoPin) this.pinToBottom();
  }

  /**
   * Place `element` in this scrollport per `block`, writing only this
   * scroller's `scrollTop`.
   *
   * Deliberately NOT `Element.scrollIntoView`. That walks EVERY scrollable
   * ancestor of the target and scrolls each one to satisfy `block` — the card
   * body, the deck's containing block, the document itself. A deck whose panes
   * reach past the window bottom leaves the document a few pixels of scroll
   * range, and then one turn-step chord (⌃⌘[ → `pageByEntry`) scrolls the whole
   * deck: every card's title bar parks above the window top, with no gesture
   * that brings it back. A scroller owns its own scrollport and nothing else,
   * so the delta is computed here and written to `_container` alone.
   *
   * The write routes through `scrollTo`, so it clears a pending cold-boot
   * restore and enters the programmatic phase like any other explicit scroll.
   */
  scrollToElement(
    element: HTMLElement,
    options: { animated?: boolean; block?: ScrollLogicalPosition } = {},
  ): void {
    if (this._disposed) return;
    const { animated = false, block = 'nearest' } = options;
    const el = this._container;
    // `clientTop` is the border width: the scrollport's content box starts
    // inside it, and `clientHeight` already excludes the borders.
    const portTop = el.getBoundingClientRect().top + el.clientTop;
    const portHeight = el.clientHeight;
    const rect = element.getBoundingClientRect();
    // Target position expressed in scrollport-relative coordinates.
    const top = rect.top - portTop;
    const bottom = top + rect.height;
    let delta: number;
    switch (block) {
      case 'start':
        delta = top;
        break;
      case 'end':
        delta = bottom - portHeight;
        break;
      case 'center':
        delta = top - (portHeight - rect.height) / 2;
        break;
      default:
        // `nearest`: the minimum delta that brings the target inside, and
        // nothing at all when it already is. A target taller than the port
        // aligns to the leading edge rather than pushing it out of view.
        delta =
          top < 0 ? top : bottom > portHeight ? Math.min(bottom - portHeight, top) : 0;
        break;
    }
    const max = Math.max(0, el.scrollHeight - portHeight);
    this.scrollTo({
      top: Math.max(0, Math.min(max, el.scrollTop + delta)),
      animated,
    });
  }

  // -------------------------------------------------------------------------
  // Public API — cold-boot scroll restore
  //
  // A consumer that mounts into a saved mid-content scroll position
  // (a virtualized list / markdown view restoring `bag.regionScroll`)
  // installs a `resolver` here. SmartScroll owns the restore policy:
  //   - a pending restore means the scroller is being placed, not
  //     tracking the live edge — `setRestoreTarget` disengages
  //     follow-bottom;
  //   - the user engaging the live edge (`scrollToBottom`, keyboard
  //     End / Cmd+ArrowDown, idle re-engagement, gesture-end
  //     re-engage) supersedes the restore — `_setFollowingBottom(true)`
  //     clears it;
  //   - a user scroll gesture supersedes the restore — `applyRestore
  //     Target` clears it when `isUserScrolling`;
  //   - a scroll SmartScroll cannot attribute (a native scrollbar
  //     drag emits no pointer/wheel events) supersedes the restore —
  //     `applyRestoreTarget` clears it when `scrollTop` has drifted
  //     from the last heartbeat's post-write baseline;
  //   - an explicit programmatic scroll (`scrollTo`, `scrollToTop`,
  //     `scrollToElement`) supersedes the restore — the consumer
  //     named a position, so those methods clear the target.
  // Follow-bottom obeys the same attribution rules from the other
  // side: an idle upward scroll SmartScroll cannot attribute to its
  // own writes disengages it (`_handleScroll`, idle case).
  // The consumer's only job is to forward layout signals by calling
  // `applyRestoreTarget` (its post-commit / ResizeObserver heartbeat);
  // it holds no restore state of its own.
  // -------------------------------------------------------------------------

  /**
   * Install a cold-boot scroll-restore `resolver`. The resolver
   * returns the desired `scrollTop`, or `null` while the target is
   * not yet resolvable (anchor cell out of range, content not laid
   * out). It is re-invoked on every `applyRestoreTarget` call so the
   * restore tracks a target that drifts as virtualized content
   * settles its heights.
   *
   * A pending restore is incompatible with following the live edge,
   * so this disengages follow-bottom — the auto-pin must not fight
   * the restore write.
   *
   * `suspendDriftSupersede` is for a restore installed across a
   * reflow the restore itself is meant to absorb — a card width
   * change, where content re-wrapping above the viewport moves
   * `scrollTop` on its own. Without it such a restore reads that
   * motion as an unattributable actor and cancels itself; with it the
   * only remaining supersede is a real user gesture.
   */
  setRestoreTarget(
    resolver: () => number | null,
    opts?: { suspendDriftSupersede?: boolean },
  ): void {
    if (this._disposed) return;
    this._restoreTarget = resolver;
    this._restoreBaselineTop = null;
    this._restoreSuspendsDriftSupersede =
      opts?.suspendDriftSupersede === true;
    this._setFollowingBottom(false, 'restore-target');
  }

  /** Drop the pending restore target, if any. */
  clearRestoreTarget(): void {
    this._restoreTarget = null;
    this._restoreBaselineTop = null;
    this._restoreSuspendsDriftSupersede = false;
  }

  /**
   * Re-resolve the installed restore target and write `scrollTop` to
   * it when it has drifted. No-op when no target is installed. A user
   * scroll gesture supersedes the restore: when `isUserScrolling`,
   * the target is cleared and nothing is written — the user owns the
   * position from that point on.
   *
   * Consumers call this from their layout heartbeat (a post-commit
   * `useLayoutEffect`, a `ResizeObserver` flush) so the restore
   * tracks the resolved offset as content settles. The write goes
   * through the private `_writeScrollTop` — NOT the public
   * `scrollTo` — so the restore does not clear its own target;
   * `_writeScrollTop` still arms the one-shot idle-re-engagement
   * suppression so the deferred scroll event cannot flip follow-bottom
   * back on mid-restore.
   */
  applyRestoreTarget(): void {
    if (this._disposed) return;
    const resolver = this._restoreTarget;
    if (resolver === null) return;
    // Who owns the position? A gesture SmartScroll saw, or a
    // displacement it cannot attribute (a native scrollbar drag
    // delivers no events, so the phase machine sits in `idle` while
    // the user scrubs) means the user does — clear, so a later commit
    // does not fight them. The whole rule, and why a width-change
    // target waives half of it, is in `restoreSupersede`.
    if (
      restoreSupersede({
        isUserScrolling: this.isUserScrolling,
        baselineTop: this._restoreBaselineTop,
        currentTop: this._container.scrollTop,
        suspendDriftSupersede: this._restoreSuspendsDriftSupersede,
      }) !== null
    ) {
      this.clearRestoreTarget();
      return;
    }
    const desired = resolver();
    if (desired === null) return;
    if (Math.abs(this._container.scrollTop - desired) > 0.5) {
      this._writeScrollTop(desired, false);
    }
    this._restoreBaselineTop = this._container.scrollTop;
  }

  // -------------------------------------------------------------------------
  // Public API — follow-bottom control
  // -------------------------------------------------------------------------

  /** Engage auto-follow-bottom. `source` tags the trigger for the
   *  deck trace — see {@link _setFollowingBottom}. */
  engageFollowBottom(source: string): void {
    this._setFollowingBottom(true, source);
  }

  /** Disengage auto-follow-bottom. `source` tags the trigger for the
   *  deck trace — see {@link _setFollowingBottom}. */
  disengageFollowBottom(source: string): void {
    this._setFollowingBottom(false, source);
  }

  /**
   * Engage follow-bottom on behalf of a named `source` — the typed
   * funnel for follow-bottom intent crossing a component boundary, to
   * which the `useScroller()` façade delegates. A thin wrapper over
   * `engageFollowBottom`; the `source` reaches the deck trace via
   * `_setFollowingBottom`, the chokepoint every transition routes
   * through. `source` is a short, stable trigger tag so a follow-bottom
   * regression in the trace can be attributed to who flipped it.
   */
  engage(source: string): void {
    if (this._disposed) return;
    this.engageFollowBottom(source);
  }

  /**
   * Disengage follow-bottom on behalf of a named `source`. Counterpart
   * to {@link engage}; see its doc for the funnel rationale. The
   * bubbling descendant-to-host signalling this replaces had no record
   * of who fired it — `source` closes that gap.
   */
  disengage(source: string): void {
    if (this._disposed) return;
    this.disengageFollowBottom(source);
  }

  // -------------------------------------------------------------------------
  // Dispose
  // -------------------------------------------------------------------------

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    // Only drop the registry entry if it still points at this
    // instance. A remount can construct the replacement scroller for
    // the same element before the outgoing one disposes, and deleting
    // unconditionally would unregister the live scroller. The same
    // ownership rule guards the anchoring gate: the replacement
    // scroller applied its own gate at construction, and an outgoing
    // instance clearing it unconditionally would wipe the live one's.
    if (scrollerRegistry.get(this._container) === this) {
      scrollerRegistry.delete(this._container);
      this._container.style.overflowAnchor = '';
    }

    this._clearDecelerationTimer();
    this._clearScrollEndTimer();

    this._container.removeEventListener('scroll', this._onScroll);
    if (this._supportsScrollEnd) {
      this._container.removeEventListener('scrollend', this._onScrollEnd);
    }
    // Capture-phase registrations need capture-phase removals — an
    // options mismatch leaves the listener attached.
    this._container.removeEventListener('pointerdown', this._onPointerDown, { capture: true });
    document.removeEventListener('pointerup', this._onPointerUp);
    document.removeEventListener('pointercancel', this._onPointerUp);
    this._container.removeEventListener('wheel', this._onWheel, { capture: true });
    this._container.removeEventListener('keydown', this._onKeyDown);
  }

  // -------------------------------------------------------------------------
  // Private — scroll event handler
  // -------------------------------------------------------------------------

  private _handleScroll(): void {
    if (this._disposed) return;

    const scrollTop = this._container.scrollTop;

    // Lazy baseline seed: the first scroll event since construction
    // establishes `_lastScrollTop` (the constructor skips the layout-forcing
    // read). With the baseline equal to the current position, no direction is
    // inferred from a phantom prior value on this first event; line 602 then
    // carries it forward as usual.
    if (!this._scrollTopSeeded) {
      this._lastScrollTop = scrollTop;
      this._scrollTopSeeded = true;
    }

    // The document height as of the PREVIOUS scroll event, captured
    // before the line below overwrites it. This is the extent the user
    // had actually been shown when they last moved; the intent rules
    // below judge their new position against it, because content that
    // arrived since is not something they did. See
    // `_isAwayFromShownBottom`.
    const shownHeight = this._lastScrollEventHeight;

    // The baseline is now current again — every write up to this
    // point has been accounted for by an event.
    this._writesSinceScrollEvent = 0;
    this._lastScrollEventHeight = this._container.scrollHeight;

    // Sample into the flip ring. `clientHeight` rides on the layout the
    // reads above already flushed.
    this._scrollRing.push({
      t: performance.now(),
      top: scrollTop,
      sh: this._lastScrollEventHeight,
      ch: this._container.clientHeight,
    });
    if (this._scrollRing.length > SCROLL_RING_CAPACITY) {
      this._scrollRing.splice(0, this._scrollRing.length - SCROLL_RING_CAPACITY);
    }

    // Fire onScroll for every scroll event regardless of phase.
    this._callbacks.onScroll?.(this);

    // Consume the one-shot post-`scrollTo` suppression flag. We clear
    // unconditionally on the FIRST scroll event after a programmatic
    // write — regardless of phase — so a subsequent genuine user
    // gesture re-engages normally. Without unconditional clear, a
    // browser that fires the scroll synchronously inside the write
    // (still in 'programmatic' phase) would never enter the idle
    // case, and the flag would carry over to a real user scroll.
    const suppressIdleReengage = this._suppressIdleReengagementOnNextScroll;
    this._suppressIdleReengagementOnNextScroll = false;

    switch (this._phase) {
      case 'idle':
        // Conservative auto-re-engagement: only if scrolled down to within
        // 60px of the absolute bottom while idle. This handles the non-streaming
        // case (user manually scrolls to bottom). During streaming, the bottom
        // moves too fast for this to reliably trigger — the user should use
        // End/Cmd+Down for explicit re-engagement.
        //
        // The suppression flag rides on top: a deferred scroll event
        // from a programmatic `scrollTo` skips re-engagement so a
        // state-restore path's disengage isn't undone by the very
        // write it set up. See `_suppressIdleReengagementOnNextScroll`
        // for the full rationale.
        //
        // This rule keeps its `scrollTop >= _lastScrollTop` direction
        // requirement even though `_checkReEngageFollowBottom` dropped
        // its equivalent for the in-band case. They are not the same
        // situation: this fires DURING movement, so a user scrolling
        // up into the band from below is still in motion and heading
        // away — re-engaging under them would pin against the
        // direction they are travelling. Gesture end has no motion
        // left to contradict; the position is the whole statement.
        if (
          !suppressIdleReengage &&
          !this._isFollowingBottom &&
          scrollTop >= this._lastScrollTop &&
          this.isAtBottom
        ) {
          this._setFollowingBottom(true, 'idle-reengage');
        }
        // Unattributed disengage — the mirror of the re-engagement above.
        // A native scrollbar drag delivers no pointer or wheel events to
        // the container, so the phase machine sits in `idle` while the
        // user scrubs; without this, follow-bottom stays engaged and
        // every growth pin slams the scroller back to the bottom against
        // the drag. An idle upward scroll that SmartScroll did not cause
        // is therefore the user and disengages. Safe against our own
        // writes: explicit programmatic scrolls arm the one-shot
        // suppression flag (captured above), pins and prepend
        // compensation only ever move `scrollTop` down, and the raw
        // upward writers (`focus-reveal`'s `revealWithin`, the
        // transcript's `settleFindReveal`) call `disengage(...)`
        // themselves before writing. `usePositionStableClick`'s
        // compensation writes on the user's click call-stack to hold
        // the click point under the cursor — attributing that scroll
        // to the user is correct, and disengaging keeps growth pins
        // from yanking the preserved point away. The `!isAtBottom`
        // guard reuses the same 60px jitter band as the
        // `dragging`-phase disengage.
        //
        // **The browser clamp is the exception this rule used to get
        // wrong.** It was once argued safe here on the grounds that a
        // `scrollHeight`-shrink clamp lands where `isAtBottom` holds.
        // Under window churn that is false: the height recovers before
        // the clamp's scroll event is delivered, so by the time this
        // handler runs the position looks arbitrary and the geometry
        // looks fine. A field capture recorded `scrollTop` moving up
        // 2,660px with `scrollHeight` identical on both sides and every
        // JavaScript write channel silent. The extent floor makes that
        // clamp impossible by construction; a residual one is witnessed
        // by the owning component's commit bracket, which attributes it
        // via `noteExternalWrite` — syncing `_lastScrollTop` to the
        // clamped position — so its deferred scroll event arrives with
        // no upward delta and never reaches this rule.
        //
        // **Growth is the other exception, and it is the common one.**
        // The `isAtBottom` guard alone asks "how far is the user from
        // the bottom NOW" — a question whose answer changes when the
        // bottom moves, which during streaming it does constantly. A
        // field capture caught the whole failure in three scroll
        // events: pinned at the edge (`dist` 0) twice while the
        // document grew, then a `scrollTop` of 20492 → 20491 in the
        // same frame that `scrollHeight` went 21712 → 21778. One pixel
        // of sub-pixel rounding satisfied "scrolled up", and 66 pixels
        // of arriving content put `dist` at 67, over the band — so a
        // transcript the user was reading at the live edge released it
        // and stranded them behind the jump-to-bottom button. That is
        // this rule mistaking *the bottom moving away from the user*
        // for *the user moving away from the bottom*.
        //
        // Hence both readings must agree: away from the live bottom AND
        // away from the bottom of what the user had actually been
        // shown. Growth fails the second — the position is unchanged
        // against the extent it was measured in — while every real
        // upward gesture passes both, since a drag moves the position
        // against a height that is not moving. See
        // `_isAwayFromShownBottom`.
        if (
          !suppressIdleReengage &&
          this._isFollowingBottom &&
          scrollTop < this._lastScrollTop &&
          !this.isAtBottom &&
          this._isAwayFromShownBottom(scrollTop, shownHeight)
        ) {
          this._setFollowingBottom(false, 'unattributed-scroll-up');
        }
        break;

      case 'settling':
        // During settling, a scroll event means momentum deceleration is arriving.
        this._scrolledAfterPointerUp = true;
        break;

      case 'dragging':
        // During active dragging, the user is in deliberate control — no
        // re-engagement. Only DISENGAGE if they scroll up past the jitter guard.
        //
        // An upward jump inside a net-DOWNWARD wheel burst is not a
        // user scrolling up. This is the case the field report hit
        // first: wheeling down over an evicting transcript, a clamp
        // threw the position up by 8,000px mid-burst and this rule
        // disengaged follow-bottom while the user was actively
        // scrolling toward the live edge — so the gesture could never
        // reach the bottom.
        //
        // The direction test reads the accumulated wheel deltas, not
        // the position: during a streaming burst growth pins and
        // `scrollHeight` jitter move `scrollTop` independently of the
        // user's hand (see `_enterDragging`), and a large clamp can
        // land the position above any position baseline. The deltas
        // are what the user actually did.
        //
        // An accumulator of exactly 0 means no wheel deltas have
        // arrived — a scroll-key gesture, which enters this phase
        // through `_enterDragging` too. Those keep the plain
        // per-event rule, hence `<= 0`: only a net-POSITIVE (downward)
        // wheel accumulation suppresses the disengage.
        if (
          scrollTop < this._lastScrollTop &&
          this._isFollowingBottom &&
          !this.isAtBottom &&
          this._gestureWheelDeltaAccum <= 0
        ) {
          this._setFollowingBottom(false, 'drag-up');
        }
        if (!this._supportsScrollEnd) {
          this._restartScrollEndTimer();
        }
        break;

      case 'decelerating':
      case 'programmatic':
        // Restart scrollend fallback timer on every scroll event.
        if (!this._supportsScrollEnd) {
          this._restartScrollEndTimer();
        }
        break;

      default:
        break;
    }

    this._lastScrollTop = scrollTop;
  }

  // -------------------------------------------------------------------------
  // Private — scrollend event handler
  // -------------------------------------------------------------------------

  private _handleScrollEnd(): void {
    if (this._disposed) return;
    this._clearScrollEndTimer();
    this._onScrollTerminal();
  }

  // -------------------------------------------------------------------------
  // Private — pointer event handlers
  // -------------------------------------------------------------------------

  private _handlePointerDown(_e: PointerEvent): void {
    if (this._disposed) return;
    this._userActivitySeq += 1;
    this._lastUserInputAt = performance.now();
    if (this._phase === 'idle') {
      this._gestureStartScrollTop = this._container.scrollTop;
      this._phase = 'tracking';
    }
    // If decelerating or settling, a new pointerdown interrupts; enter tracking
    // to capture the new gesture.
    else if (this._phase === 'decelerating' || this._phase === 'settling') {
      this._clearScrollEndTimer();
      this._clearDecelerationTimer();
      this._phase = 'tracking';
    }
  }

  private _handlePointerUp(_e: PointerEvent): void {
    if (this._disposed) return;

    if (this._phase === 'tracking') {
      // Pointerup with no scroll — tap without scroll, return to idle.
      this._phase = 'idle';
      return;
    }

    if (this._phase === 'dragging') {
      // Enter SETTLING phase: wait 50ms to see if momentum scroll events arrive.
      this._scrolledAfterPointerUp = false;
      this._phase = 'settling';

      this._decelerationTimer = setTimeout(() => {
        this._decelerationTimer = null;
        if (this._disposed) return;

        if (this._scrolledAfterPointerUp) {
          // Momentum is happening — transition settling → decelerating.
          this._phase = 'decelerating';
          this._callbacks.onDidEndDragging?.(this, true);
          this._callbacks.onWillBeginDecelerating?.(this);
          if (!this._supportsScrollEnd) {
            this._restartScrollEndTimer();
          }
        } else {
          // No momentum — drag ended cleanly, transition settling → idle.
          this._phase = 'idle';
          this._callbacks.onDidEndDragging?.(this, false);
          this._callbacks.onDidEndScrolling?.(this);
          this._checkReEngageFollowBottom();
        }
      }, DECELERATION_DETECTION_MS);
    }
  }

  // -------------------------------------------------------------------------
  // Private — wheel event handler
  // -------------------------------------------------------------------------

  private _handleWheel(e: WheelEvent): void {
    if (this._disposed) return;

    this._userActivitySeq += 1;
    this._lastUserInputAt = performance.now();

    // wheel always enters DRAGGING directly (no pointer down involved).
    // `_enterDragging` resets the accumulator when a NEW gesture
    // begins, so accumulate after it — this tick belongs to the
    // gesture it just started.
    if (this._phase !== 'dragging') {
      this._enterDragging();
    }
    this._gestureWheelDeltaAccum += e.deltaY;

    // Start/restart scrollend fallback timer (Issue 3).
    if (!this._supportsScrollEnd) {
      this._restartScrollEndTimer();
    }

    // Disengage follow-bottom on scroll-up — but only when the container can
    // actually scroll. A non-scrollable container still emits `deltaY < 0`
    // wheel events (trackpad), and disengaging there would summon the
    // jump-to-bottom affordance with nowhere to jump.
    if (e.deltaY < 0 && this._isFollowingBottom && this.isScrollable) {
      this._setFollowingBottom(false, 'wheel-up');
    }
  }

  // -------------------------------------------------------------------------
  // Private — keydown event handler
  // -------------------------------------------------------------------------

  private _handleKeyDown(e: KeyboardEvent): void {
    if (this._disposed) return;
    if (!SCROLL_KEYS.has(e.code)) return;

    // Skip when the keydown originates inside an editable descendant
    // — typing in an `<input>` / `<textarea>` / `[contenteditable]`
    // shouldn't be interpreted as scroll intent. Without this guard,
    // arrow-key cursor movement inside a cell's input would
    // disengage `_isFollowingBottom` and enter the dragging phase
    // even though the user never gestured at the scroll container.
    // The keydown still bubbles to any other listener; this only
    // affects SmartScroll's intent tracking.
    if (_isEditableEventTarget(e.target)) return;

    this._userActivitySeq += 1;
    this._lastUserInputAt = performance.now();

    // All scroll keys enter DRAGGING directly (keyboard has no pointer).
    if (this._phase !== 'dragging') {
      this._enterDragging();
    }

    // Start/restart scrollend fallback timer.
    if (!this._supportsScrollEnd) {
      this._restartScrollEndTimer();
    }

    // Disengage follow-bottom for scroll-up keys.
    const isScrollUpKey = SCROLL_UP_KEYS.has(e.code) || (e.code === 'Space' && e.shiftKey);
    if (isScrollUpKey && this._isFollowingBottom && this.isScrollable) {
      this._setFollowingBottom(false, 'key-up');
    }

    // Explicit re-engagement: End and Cmd+Down are definite "go to bottom"
    // actions. Re-engage follow-bottom and scroll to bottom immediately.
    // These work regardless of content size or streaming state — the user
    // declared their intent explicitly.
    const isJumpToBottom = e.code === 'End'
      || (e.code === 'ArrowDown' && e.metaKey);
    if (isJumpToBottom) {
      e.preventDefault(); // prevent native scroll — we handle it
      this.scrollToBottom();
    }
  }

  // -------------------------------------------------------------------------
  // Private — phase transitions
  // -------------------------------------------------------------------------

  private _enterDragging(): void {
    const wasIdle = this._phase === 'idle';
    const wasAlreadyDragging = this._phase === 'dragging';
    if (wasIdle) {
      // Use `_lastScrollTop` rather than `_container.scrollTop` for the
      // pre-gesture snapshot. With `passive: true` wheel listeners on
      // macOS WKWebView the browser pre-applies the deltaY *before*
      // dispatching the wheel JS event, so by the time `_handleWheel`
      // calls `_enterDragging` the live `scrollTop` already reflects
      // the first wheel tick. Reading it would treat that initial pull
      // as the gesture's starting position, and the post-gesture
      // re-engage check (`scrollTop > gestureStart`) would later
      // misread a return to bottom (driven by layout's natural
      // scrollHeight jitter while the user wheels up) as a net-down
      // gesture and re-engage follow-bottom against the user's intent.
      // `_lastScrollTop` is the value `_handleScroll` saw on the
      // previous scroll event, which has not yet been updated for the
      // new gesture — the true pre-gesture position.
      this._gestureStartScrollTop = this._lastScrollTop;
      // A new gesture states its own direction from scratch.
      this._gestureWheelDeltaAccum = 0;
    }
    this._phase = 'dragging';
    if (!wasAlreadyDragging) {
      this._callbacks.onWillBeginDragging?.(this);
    }
  }

  private _enterProgrammatic(): void {
    this._clearDecelerationTimer();
    this._clearScrollEndTimer();
    this._phase = 'programmatic';
  }

  private _exitProgrammaticImmediate(): void {
    if (this._phase !== 'programmatic') return;
    this._phase = 'idle';
    // Non-animated programmatic scroll fires end-of-scroll but not animation callback.
    this._callbacks.onDidEndScrolling?.(this);
    this._checkReEngageFollowBottom();
  }

  /** Terminal signal — called by scrollend event or timer fallback. */
  private _onScrollTerminal(): void {
    if (this._disposed) return;

    const previousPhase = this._phase;

    if (previousPhase === 'decelerating') {
      this._phase = 'idle';
      this._callbacks.onDidEndDecelerating?.(this);
      this._callbacks.onDidEndScrolling?.(this);
      this._checkReEngageFollowBottom();
    } else if (previousPhase === 'programmatic') {
      this._phase = 'idle';
      this._callbacks.onDidEndScrollingAnimation?.(this);
      this._callbacks.onDidEndScrolling?.(this);
      this._checkReEngageFollowBottom();
    } else if (previousPhase === 'dragging') {
      // scrollend fired while still in DRAGGING (e.g., wheel/keyboard scroll ended
      // without a pointerup). Treat as terminal — transition to idle.
      this._phase = 'idle';
      this._callbacks.onDidEndDragging?.(this, false);
      this._callbacks.onDidEndScrolling?.(this);
      this._checkReEngageFollowBottom();
    }
    // Other phases: ignore (scrollend can fire spuriously).
  }

  // -------------------------------------------------------------------------
  // Private — follow-bottom helpers
  // -------------------------------------------------------------------------

  /**
   * Scroll anchoring is gated off while following the bottom.
   *
   * Anchoring holds mid-viewport content still when heights change
   * above it — which is definitionally opposed to the pin: while
   * following, the live edge is the position, and the only writer that
   * may hold the viewport anywhere is the pin itself. `overflow-anchor`
   * on the scroll container disables anchoring for the whole scroller,
   * so descendants' opt-in (`tug-markdown-block.css`) goes quiet while
   * the flag is engaged and resumes the moment the user parks to read —
   * a disengaged reader is exactly who the reading-position hold
   * (`render-incremental.ts`) exists for.
   *
   * An inline style rather than a class/attribute because the gate is a
   * property of following-the-bottom itself, not of any one surface:
   * every SmartScroll consumer gets it without per-surface CSS. [L06]
   */
  private _applyAnchoringGate(): void {
    this._container.style.overflowAnchor = this._isFollowingBottom ? 'none' : '';
  }

  /**
   * True when `scrollTop` sits outside the at-bottom band measured
   * against `shownHeight` — the document extent as of the PREVIOUS
   * scroll event, which is the last extent the user was actually shown.
   *
   * This is the direction-of-blame test for an upward move at idle.
   * Distance from the live bottom cannot answer it during streaming:
   * the live bottom is a moving target, and a user who has not moved at
   * all measures further from it after every append. Distance from the
   * bottom they were last shown holds still unless THEY move, which is
   * exactly the question the intent rule is asking.
   *
   * An unseeded height (0, before the first scroll event) is no
   * evidence and does not block — the same convention
   * {@link isSettledAtBottom} uses for its resting reading. It cannot
   * matter in practice: the first scroll event seeds `_lastScrollTop`
   * to the current position, so no upward delta is inferred on it.
   */
  private _isAwayFromShownBottom(scrollTop: number, shownHeight: number): boolean {
    if (shownHeight <= 0) return true;
    const shownDistance =
      shownHeight - this._container.clientHeight - Math.max(0, scrollTop);
    return shownDistance > AT_BOTTOM_PX;
  }

  /**
   * The circumstances of a follow-bottom flip: which scroller, what the
   * page was doing, where the position sat, and the `scroll` events that
   * led there.
   *
   * Assembled once per real transition (the no-op early-return in
   * `_setFollowingBottom` guards the call), so the geometry reads here
   * cost no more than the dev-log payload already did.
   *
   * The ring is stringified rather than passed as an array so
   * `deckTrace.dumpTable()` keeps one row per event — the table is the
   * surface a person reads first, and a nested array in a cell makes it
   * unreadable.
   */
  private _flipContext(): {
    scrollKey: string;
    cardId: string;
    visibility: string;
    windowFocused: boolean;
    top: number;
    dist: number;
    sinceInputMs: number | null;
    ring: string;
  } {
    const el = this._container;
    const now = performance.now();
    const top = el.scrollTop;
    const scrollHeight = el.scrollHeight;
    const clientHeight = el.clientHeight;
    const card = el.closest('[data-card-id]');
    return {
      scrollKey: el.getAttribute('data-tug-scroll-key') ?? '',
      cardId: card === null ? '' : (card.getAttribute('data-card-id') ?? ''),
      visibility: document.visibilityState,
      windowFocused: document.hasFocus(),
      top: Math.round(top),
      dist: Math.round(scrollHeight - clientHeight - top),
      sinceInputMs:
        this._lastUserInputAt === null
          ? null
          : Math.round(now - this._lastUserInputAt),
      ring: this._scrollRing
        .map(
          (s) =>
            `${Math.round(s.t - now)},${Math.round(s.top)},${s.sh},${s.ch}`,
        )
        .join('|'),
    };
  }

  private _setFollowingBottom(following: boolean, source: string): void {
    // A scroller constructed with `followBottom: false` has no live edge to
    // follow. Every engage route — the idle re-engage, the gesture-end
    // re-engage, `maybePinToBottom`'s growth-at-bottom recovery, the public
    // `engageFollowBottom` — arrives here, so refusing once here is the whole
    // policy. Disengaging is always permitted; it is already the state.
    if (following && !this._followBottomAllowed) return;
    if (this._isFollowingBottom === following) return;
    this._isFollowingBottom = following;
    this._applyAnchoringGate();
    // Record every follow-bottom transition to the deck trace.
    // `_setFollowingBottom` is the one chokepoint all engage /
    // disengage paths route through, so recording here — rather than
    // in the public `engage` / `disengage` wrappers — captures the
    // heuristic internal flips too: wheel-up, keyboard scroll-up,
    // idle re-engagement, gesture-end re-engage. Those are the paths
    // a follow-bottom regression most often hides in. `source` names
    // the trigger; the early-return above means only real transitions
    // are logged, never no-op calls.
    const context = this._flipContext();
    deckTrace.record({ kind: 'follow-bottom', following, source, ...context });
    // Also to the dev log, which is visible in a release build through
    // the dev panel and readable from app-tests via
    // `window.tugDevLog.getSnapshot()`. The deck-trace ring is a
    // fixed 512 entries and holds the geometry; the dev log holds the
    // narrative, survives longer, and is the surface a person actually
    // opens when a card stops tracking the live edge. Transitions are
    // rare by nature — the early return above means no-op calls never
    // reach here — so logging every one costs nothing.
    tugDevLogStore.debug('smart-scroll', 'follow-bottom', {
      following,
      source,
      scrollTop: this._container.scrollTop,
      scrollHeight: this._container.scrollHeight,
      clientHeight: this._container.clientHeight,
      phase: this._phase,
      ...context,
    });
    // Engaging the live edge supersedes any pending cold-boot
    // restore: the user (or an explicit jump-to-latest) has declared
    // the bottom is where they want to be, so a restore target that
    // would pull them back to a saved mid-content position must be
    // dropped.
    if (following) this.clearRestoreTarget();
    this._callbacks.onFollowBottomChanged?.(this, following);
  }

  private _checkReEngageFollowBottom(): void {
    if (this._isFollowingBottom) return;

    // Re-engagement at gesture end, in two flavors.
    //
    // The original: the gesture was net-downward AND landed within the
    // at-bottom band. That still stands for a gesture ending NEAR the
    // bottom, where direction is the only evidence of intent.
    if (
      this.isAtBottom &&
      this._container.scrollTop > this._gestureStartScrollTop
    ) {
      this._setFollowingBottom(true, 'gesture-end-reengage');
      return;
    }

    // The addition: inside the band, direction no longer matters.
    //
    // Requiring net-downward strands two ordinary gestures. A user who
    // wheels down past the bottom and rubber-bands back can end above
    // where they started. A user who starts at the live edge, nudges,
    // and ends at the live edge never moved net-downward at all — and
    // `_handleWheel` carries no at-bottom guard, so a 10px nudge is
    // enough to disengage them in the first place.
    //
    // Inside the band is the definition of "at the bottom" everywhere
    // else in this class, so honoring it here costs the ability to
    // hold a *disengaged* position within 60px of the live edge. That
    // is deliberate: a peek that stays within 60px is not leaving, and
    // a user who wants to hold a position moves further than that.
    if (this.isAtBottom) {
      this._setFollowingBottom(true, 'gesture-end-at-bottom-reengage');
    }
  }

  // -------------------------------------------------------------------------
  // Private — timer helpers
  // -------------------------------------------------------------------------

  private _clearDecelerationTimer(): void {
    if (this._decelerationTimer !== null) {
      clearTimeout(this._decelerationTimer);
      this._decelerationTimer = null;
    }
  }

  private _clearScrollEndTimer(): void {
    if (this._scrollEndTimer !== null) {
      clearTimeout(this._scrollEndTimer);
      this._scrollEndTimer = null;
    }
  }

  private _restartScrollEndTimer(): void {
    this._clearScrollEndTimer();
    this._scrollEndTimer = setTimeout(() => {
      this._scrollEndTimer = null;
      this._onScrollTerminal();
    }, SCROLLEND_FALLBACK_MS);
  }
}
