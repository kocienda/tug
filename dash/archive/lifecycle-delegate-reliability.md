# Lifecycle Delegate Reliability — Design Study

**Status:** Draft proposal (2026-04-20).
**Plan:** [tugplan-lifecycle-delegates.md §Step 10](./tugplan-lifecycle-delegates.md#step-10).
**Decision:** Adopt **MessageChannel-based macrotask scheduling** with a dedicated drain queue owned by each lifecycle module. Retire `lib/defer.ts`. Implement in Step 11.

---

## 1. Problem statement

### 1.1 What must be true for the delegate protocol to be bedrock

`useCardDelegate` and `useAppDelegate` promise that a delegate method fires once per lifecycle event on the matching channel, reliably, in a way callers can trust for `focus()`, `save()`, `blur()`, and other side-effects. Today the hooks deliver the callback via a `setState → useEffect` pipeline so the call runs after React's post-commit paint — specifically to escape **WebKit's gesture focus-lock**, which is the thing the mechanism was built to defeat.

### 1.2 WebKit's gesture focus-lock

When a pointer event handler calls `preventDefault()` on `mousedown`, WebKit treats any programmatic focus change that happens *during the same gesture* as a spurious mutation and **reverts** it when the gesture completes. This is the WebKit equivalent of the `preventDefault()`-suppresses-focus-move pattern observed by ProseMirror, react-select, and every other library that implements focus-refuse title-bar regions.

In tugdeck, card title bars mark themselves `data-tug-focus="refuse"` and `preventDefault()` on mousedown so the user's active editor keeps focus when the user clicks chrome. This is exactly the gesture that then tries to `entryDelegate.focus()` via a lifecycle callback. Catch-22.

### 1.3 Why microtasks don't help

`queueMicrotask` drains its queue between events *within the same task*, not after the gesture completes. Per the HTML spec's event-loop step, the sequence is:

```
run one macrotask → run ALL queued microtasks → render/paint → next macrotask
```

A `preventDefault()`-ed mousedown runs as a single macrotask. Any microtask queued inside it runs before the next macrotask — still inside the gesture context from WebKit's perspective. The focus-lock applies.

This is directly observable: we tried `queueMicrotask` before committing to `setTimeout(0)` / `useEffect` and it reverted every focus change.

### 1.4 Why `setTimeout(0)` is unreliable

Timer-based scheduling works in principle (it's a macrotask, past the gesture), but:
- Browsers clamp `setTimeout(0)` to a 4 ms minimum on nested calls.
- Background tabs and low-power states throttle timers to 1000 ms or more.
- The actual firing order relative to other timers, rAF, and idle callbacks is implementation-defined.
- Our symptom ("works sometimes, randomly fails on new card creation") is consistent with timer scheduling drifting under load.

### 1.5 Why `useEffect` is fragile as the load-bearing mechanism

The current `setState → useEffect` pipe happens to work because `useEffect` runs post-commit, post-paint, outside the gesture. But:
- It couples delegate-call timing to React's commit scheduling, a private implementation detail that shifts across React versions.
- Concurrent rendering may split a commit across multiple tasks; the effect can batch with unrelated updates.
- During card destruction the dying component unmounts before its effects drain, losing the `cardWillBeginDestruction` callback entirely (hole H1).
- The queued `setSeq` may be dropped if the component unmounts before the effect fires.
- It violates tuglaws in spirit: L06 says appearance belongs in DOM/CSS, not React state; we're using React state purely as a scheduling signal.

We need a mechanism that does not depend on React's scheduler and does not drop events during component unmount.

---

## 2. Candidate mechanisms

### A. `scheduler.yield()` — NOT VIABLE

The Prioritized Task Scheduling API (`scheduler.postTask`, `scheduler.yield`) is implemented in Chromium (2024) and Firefox (August 2025). **Safari/WebKit has not shipped it as of April 2026.** WKWebView uses Safari's engine, so this is unavailable to tugdeck.

Even if WebKit ships it tomorrow, we'd still need a fallback for current Safari releases. Disqualified.

### B. `MessageChannel` + `postMessage(0)` — STRONG CANDIDATE

React's own scheduler uses this pattern and has since 2019 ([PR #14234](https://github.com/facebook/react/pull/14234)). The rationale React gives in that PR applies to us almost verbatim:

- **No 4 ms clamp.** `MessageChannel.postMessage` queues a macrotask directly, skipping timer infrastructure.
- **No background throttling.** Timer throttling targets `setTimeout`/`setInterval`; channel messages aren't classified as timers.
- **Deterministic ordering.** Messages deliver in post order on the task queue; no cross-interaction with timers or animation frames.
- **Baseline support.** Shipped in every browser we care about since ~2015, including WebKit on iOS and macOS.
- **Escapes the gesture.** The `onmessage` callback runs as a macrotask after the current task completes — past the gesture boundary, same class of escape as `setTimeout(0)` but faster and cleaner.

We inherit React's field validation for free: if `MessageChannel` were unreliable in WebKit, React would be visibly broken on Safari. It isn't.

### C. `queueMicrotask` — PARTIAL

Cannot escape the gesture (§1.3). Rejected for focus-critical delegate methods.

Could be used for non-focus methods (e.g., `cardDidFinishConstruction` if we knew no consumer does focus work in it — but we can't promise that, since `tide-card.tsx` already does). Rejected as a per-event mechanism for API uniformity.

### D. `requestAnimationFrame` then `queueMicrotask` — NOT PREFERRED

Double-step pattern: rAF gives a paint-aligned macrotask, microtask after flushes any remaining scheduling. Works, but:

- Latency up to 16 ms per rAF. For `cardDidActivate` this adds a perceptible delay between click and focus.
- More complex than needed when `MessageChannel` gives us the same escape with lower latency.
- rAF in background tabs pauses entirely (0 fps), so the mechanism *stops working* when the tab is hidden — and app-lifecycle events fire precisely when the app is transitioning visibility. Fatal.

Rejected.

### E. Dedicated drain queue owned by the lifecycle — PROMOTED VARIANT OF B

Instead of scattering `MessageChannel` instances across hooks, each lifecycle module (`CardLifecycle`, `AppLifecycle`) owns one channel and one in-memory queue. Observer callbacks enqueue `{ method, args }` tuples; the channel's `onmessage` drains the queue and invokes each. Hooks don't manage scheduling at all — they hand the callback to the lifecycle's `scheduleDelegateCall(fn)` and move on.

Benefits over raw B:

- **Single ordering authority.** The lifecycle's queue is the one source of truth for event order. No cross-hook interleaving surprises.
- **Error-boundary clarity.** One `try/catch` per drain; errors in one delegate don't stop the others, and they log with a known event name.
- **Easier to retire.** Replacing the mechanism later (e.g., if `scheduler.yield` ships) is a one-file change inside each lifecycle module rather than N hook-level rewrites.
- **Dispose-friendly.** The drain queue can be cleared on lifecycle shutdown.

**This is the proposal.** Option B is the primitive; Option E is the packaging.

### F. Deliver synchronously; consumers handle focus-lock themselves — REJECTED

Shifts the burden of gesture-awareness into every delegate. Each card would need to know about WebKit's focus-lock, detect it, and defer its own focus calls. This is what the hook was invented to hide. Violates the abstraction hard.

Also fails H1 worse: a synchronous destruction call would run fine, but every delegate that wants to save state would need a timing opinion. No.

### G. Bypass `preventDefault` on title bar — RISKY, REJECTED

If the title bar doesn't `preventDefault()` on mousedown, the focus-lock doesn't arm. But then the native browser may try to focus the title bar div (stealing focus from the user's editor), which is exactly what `preventDefault()` was guarding against. Workarounds (tabindex=-1, outline:none, `user-select: none`, etc.) have edge cases per-browser and per-element-type.

Even if it worked, it would only address the click-activation path. Ctrl+` cycling, programmatic `activateCard`, and future activation paths don't go through the title bar gesture. We'd still need a general mechanism for them.

Rejected as a primary mechanism; kept on file as a possible belt-and-suspenders refinement if we want to lower latency on the click path specifically.

---

## 3. Decision: MessageChannel drain queue owned by each lifecycle (B + E)

### 3.1 Shape

Add to both `card-lifecycle.ts` and `app-lifecycle.ts`:

```ts
// Module-scope in each lifecycle file.
const delegateQueue: Array<() => void> = [];
const delegateChannel = new MessageChannel();
delegateChannel.port1.onmessage = () => {
  // Snapshot + clear so fns that enqueue during drain run next tick.
  const pending = delegateQueue.splice(0);
  for (const fn of pending) {
    try {
      fn();
    } catch (err) {
      console.error("delegate callback threw:", err);
    }
  }
};

function scheduleDelegateCall(fn: () => void): void {
  delegateQueue.push(fn);
  delegateChannel.port2.postMessage(null);
}
```

Hooks replace their current `setState → useEffect` drain with a call:

```ts
// Inside the observer callback in useLayoutEffect:
scheduleDelegateCall(() => {
  const d = delegateRef.current;
  const fn = d[methodName];
  fn?.(cardId);
});
```

No React state for scheduling. `useLayoutEffect` still owns the subscription install and the delegate ref — L03 unchanged.

### 3.2 Why this is different from `setTimeout(0)`

- `MessageChannel` skips the timer stack: no 4 ms clamp, no throttling.
- The drain is keyed to messages we queued, not to a shared timer wheel that timers, rAF, and `setInterval` all fight over.
- It's what React's own scheduler runs on, so by construction it gets first-class treatment in every browser that cares about React performance — including WebKit.

### 3.3 Why this is different from `setState → useEffect`

- No dependence on React's commit lifecycle.
- No dropping of events when a component unmounts mid-sequence. The closure queued in the message channel holds references (delegate ref, cardId) directly; it survives until gc.
- The drain always runs as the next macrotask, regardless of whether React rendered in between.

### 3.4 Tuglaws cross-check

| Law | Check | Status |
|---|---|---|
| L02 | External state enters React only through `useSyncExternalStore`. | ✅ No change. Lifecycle observer API is not React state. |
| L03 | Registrations events depend on use `useLayoutEffect`. | ✅ Subscription still in `useLayoutEffect`; new mechanism only changes the *delivery* timing, not install timing. |
| L06 | Appearance state goes through CSS/DOM, not React. | ✅ Better than before. The current mechanism abuses React state purely for scheduling — an L06 smell the replacement eliminates. |
| L07 | Action handlers read current state via refs. | ✅ `delegateRef` pattern preserved. |
| L22 | Store observers drive DOM writes directly, not through render cycle. | ✅ This is the law the new mechanism most clearly aligns with. The delegate queue is a store-observer → DOM-write path that bypasses React scheduling entirely. |

Net: the replacement is *more* tuglaws-compliant than the current implementation, not less.

---

## 4. Holes — resolution

### 4.1 Reliability-mechanism holes (H1–H3)

**H1 — Destruction never fires for the dying card's own delegate.** **Resolved.**

Current: setState on unmount is dropped; useEffect never drains.

Replacement: observer fires sync, closure enqueues to `delegateQueue`, component unmounts, task ends. Next macrotask drains the queue. The closure holds the delegate ref directly; ref survives unmount (plain object, not cleared by React). The delegate's `cardWillBeginDestruction` method invokes normally.

Verified by design; Step 11 will add a test that pins this: mount a card, capture a delegate callback, trigger destruction, assert the callback fired.

**H2 — "Subscribers can read state" is conditional on the mechanism.** **Partially resolved; residual documented.**

For a deferred delegate callback, the store state at drain time reflects what happened between fire and drain:

| Event | State at drain time |
|---|---|
| `cardDidFinishConstruction` | Card is in store. ✅ |
| `cardWillActivate` | Transition has **not yet** committed (fires before store update). Reading store returns old active. |
| `cardDidActivate` | Transition committed. Store shows new active. ✅ |
| `cardWillDeactivate` | Transition has not yet committed. Reading store returns still-active old card. |
| `cardDidDeactivate` | Transition committed. Store shows new state. ✅ |
| `cardWillBeginDestruction` | Card has been removed from store between fire and drain. ⚠️ |

For `cardWillBeginDestruction`: subscribers that need the card's data must capture it in the *observer* (fires synchronously, before removal), not in the delegate callback (fires deferred). The delegate receives only the cardId — consumers relying on their own refs (like the tide card's `entryDelegateRef`) are unaffected because the refs are theirs to own.

Step 11 will update the `notifyCardWillBeginDestruction` docstring to say plainly: *"Delegate callbacks may run after the card has been removed from the store. Subscribers that need the card's pre-destruction data must capture it synchronously in an observer, not from within the deferred delegate method."*

For the will-variants: delegates that want to read state mid-transition should use the `did`-variant. If both behaviors are needed, a future refinement could pass the pre-transition snapshot as an extra argument.

**H3 — Per-event latency variation.** **Resolved with a uniform answer.**

`MessageChannel` drain latency is ~0–1 ms on typical hardware — well below one frame. The same mechanism serves every delegate method. No per-event branching. Simpler than the current mechanism and faster.

### 4.2 Adjacent coherence / hygiene holes (H4–H11)

None of these are scheduling problems; the reliability mechanism does not directly resolve them. The study documents each so they aren't lost.

**H4 — `removeCard` doesn't activate the next card.** **Follow-up step.**

After the active card closes, `getFocusedCardId()` returns whatever is top-of-stack, but no `cardWillActivate`/`cardDidActivate` fires for that card and the responder chain isn't promoted to it. The fix is a deck-orchestration change: `removeCard` should call `activateCard(nextId)` after the filter, or `null` it out if no cards remain.

**Candidate step:** after Step 11, before Step 12 — a "removeCard next-activation" step. Small scope, one commit, with a test asserting the new activation fires on close-of-active.

**H5 — No `DeckManager.removeCard` → lifecycle-order test.** **Recommendation: add test.**

Add to `deck-manager.test.ts`: a test that close-of-active-card produces exactly `[cardWillDeactivate, cardDidDeactivate, cardWillBeginDestruction]` in that order. 15 lines of test; no production code change. Can land in the same step as H4's fix.

**H6 — `initActionDispatch`'s save-on-resign subscription has no dispose.** **Recommendation: return a disposer.**

Change `initActionDispatch(connection, deck)` to return a teardown function that releases the `observeApplicationDidResignActive` subscription. Align with the cascade's `dispose()` pattern. Low-urgency hygiene; can pair with H11's typing cleanup.

**H7 — No test for `DeckManager` → cascade install/dispose path.** **Recommendation: add test.**

A `deck-manager.test.ts` test that constructs a DeckManager, fires an app event on `deck.appLifecycle`, asserts the cascade fired the right card events; then `deck.destroy()`, fire again, asserts the cascade no longer fires. Same class of test as H5.

**H8 — Reactivation of a destroyed card logs a phantom activation.** **Recommendation: guard with a constructed-check.**

In `lifecycle-cascade.ts`'s `reactivateIfNeeded`, before firing `notifyCardWillActivate(cardId)`, check `cardLifecycle.hasConstructed(cardId)`. If false, clear the guard silently without firing. Requires a small addition to `CardLifecycle`: expose `hasConstructed(cardId: string): boolean` delegating to the `constructedCards` set.

Cheap, safe, closes a rare but real edge case. Add to the same follow-up step as H4.

**H9 — `applicationWillBecomeActive` may fire before tugcast is up.** **Accepted.**

Early-launch will-event frames are dropped because tugcast isn't listening. No user-visible impact: the first real `applicationDidBecomeActive` on user interaction recovers state. Document in the `AppLifecycle` header that app-lifecycle events during startup (before the JS is ready) are best-effort and consumers should not rely on receiving every event.

If a future consumer needs a guaranteed "fire once at app start" signal, it's a separate design problem (persist pending control frames in tugcast, or add a replay query after JS bootstrap). Not in scope.

**H10 — Step 9 logs are always-on.** **Decision: gate behind a dev flag in Step 11.**

Add a module-level `const LIFECYCLE_LOG = /* dev flag */` to `card-lifecycle.ts`, `app-lifecycle.ts`, `lifecycle-cascade.ts`. Default on for Steps 4–9 validation; switch off before Step 12 close-out. A single boolean at the top of each file is easier to toggle than wholesale deletion and preserves the logging for future debugging.

**H11 — `window.tugdeck` is a cast.** **Recommendation: typed global.**

Add to `main.tsx` (or a new `globals.d.ts`):

```ts
declare global {
  interface Window {
    tugdeck?: {
      saveState(): void;
      reconnect(): void;
    };
  }
}
```

Pair with H6's disposer return to land cleanup in one commit.

### 4.3 Follow-up step sketch

A single "orchestration + hygiene follow-up" step, landing after Step 11 and before Step 12, closes H4, H5, H7, H8, H10 (the toggle), and H11 together. Small scope, well-tested. Does not block the main plan.

---

## 5. Implementation sketch for Step 11

```ts
// card-lifecycle.ts — add at module scope

const LIFECYCLE_LOG = true; // gated in H10 follow-up

type DelegateCall = () => void;
const delegateQueue: DelegateCall[] = [];
const delegateChannel = new MessageChannel();
delegateChannel.port1.onmessage = () => {
  const pending = delegateQueue.splice(0);
  for (const fn of pending) {
    try {
      fn();
    } catch (err) {
      console.error("[CardLifecycle] delegate callback threw:", err);
    }
  }
};

function scheduleDelegateCall(fn: DelegateCall): void {
  delegateQueue.push(fn);
  delegateChannel.port2.postMessage(null);
}
```

```ts
// useCardDelegate — replace setState+useEffect body with:

useLayoutEffect(() => {
  if (lifecycle === null) return;
  const enqueue = (method: CardDelegateMethodName, eventCardId: string) => {
    scheduleDelegateCall(() => {
      const d = delegateRef.current;
      const fn = d[method];
      if (fn !== undefined) {
        try {
          fn(eventCardId);
        } catch (err) {
          console.error(`useCardDelegate ${method} threw:`, err);
        }
      }
    });
  };
  const unsubs = [
    lifecycle.observeCardDidFinishConstruction(cardId, (id) =>
      enqueue("cardDidFinishConstruction", id),
    ),
    // ... (six total) ...
  ];
  return () => {
    for (const unsub of unsubs) unsub();
  };
}, [lifecycle, cardId]);

// No setSeq state, no useEffect drain. Delete both.
```

Mirror the same pattern in `useAppDelegate`. Delete `tugdeck/src/lib/defer.ts`.

---

## 6. Verification plan

Step 11 will include:

1. **Unit test: destruction delegate fires for the dying card.** Mount a card with `useCardDelegate({ cardWillBeginDestruction })`, remove the card via `deck.removeCard()`, drain the message channel, assert the callback ran with the correct cardId.
2. **Unit test: no message-channel leak across tests.** After each test, queue must be empty; no dangling timers.
3. **Live stress test: 50 consecutive new-card opens.** Manual. Focus lands in the prompt editor every time. Zero failures.
4. **Live stress test: 50 Cmd-Tab cycles.** Manual. Prompt caret blink disappears on Cmd-Tab-away, reappears on Cmd-Tab-back, without clicking.
5. **Live stress test: 10 Cmd-H + unhide cycles.** Manual. Same behavior.
6. **Idempotency stress: Cmd-Tab-away then Cmd-H before returning.** Manual. The cascade fires deactivation exactly once; reactivation exactly once on return.
7. **Existing 2208 tests pass.** No regression.

---

## 7. Sources

- [React PR #14234 — Post to MessageChannel instead of window](https://github.com/facebook/react/pull/14234) — the original React scheduler decision.
- [Understanding MessageChannel Scheduling in React: A Deep Dive](https://www.oreateai.com/blog/understanding-messagechannel-scheduling-in-react-a-deep-dive/ffc72cb4baee435b40588fa2b7397312) — walkthrough of why React chose this primitive.
- [Tasks, microtasks, queues and schedules — Jake Archibald](https://jakearchibald.com/2015/tasks-microtasks-queues-and-schedules/) — definitive explanation of the event loop step ordering.
- [MDN — Using microtasks in JavaScript with queueMicrotask()](https://developer.mozilla.org/en-US/docs/Web/API/HTML_DOM_API/Microtask_guide) — microtask-vs-macrotask reference.
- [Picking the Right Tool for Maneuvering JavaScript's Event Loop — Alex MacArthur](https://macarthur.me/posts/navigating-the-event-loop/) — hands-on comparison of deferral mechanisms.
- [2025 In Review: What's New In Web Performance? — DebugBear](https://www.debugbear.com/blog/2025-in-web-performance) — confirmation of `scheduler.yield` browser support as of 2025.
- [WebKit Feature Status](https://webkit.org/status/) — current (as of April 2026) confirmation that the Scheduler API is not yet shipped in Safari.
- [CSS :active and JS mousedown preventDefault complication — csswg-drafts #2262](https://github.com/w3c/csswg-drafts/issues/2262) — spec-level discussion of the preventDefault-on-mousedown semantics.
- [Prevent focus when clicking on a button — ProseMirror discuss](https://discuss.prosemirror.net/t/prevent-focus-when-clicking-on-a-button/5108) — field confirmation of the focus-refuse pattern and its interaction with preventDefault.
