# Lifecycle Delegates

*Card lifecycle: the deck-level event pipe for construction, activation, deactivation, geometry changes (move/resize), and destruction. How `TugCardDelegate` is registered, drained, and surfaced to observers.*

*Cross-references: `[D##]` → [design-decisions.md](design-decisions.md). `[L##]` → [tuglaws.md](tuglaws.md).*

---

## Why a delegate model

Cards are constructed by a content factory the deck owns. The factory returns React subtrees; the framework owns the timing of every transition those subtrees go through — when the card becomes active, when it loses active status, when it moves between panes, when it resizes inside its pane, when it is finally torn down. Content code rarely owns any of that timing directly; it owns only the *semantics* of what should happen at each moment.

The delegate model is the channel through which the deck announces those framework-driven moments to observers and to content code that needs to react. A delegate is a single object with optional methods, supplied to a registration hook; missing methods are no-ops. This mirrors the Apple-style delegate pattern. The framework fires every moment unconditionally; consumers opt in to the moments they care about by implementing the matching method.

This document is strictly about the deck-level `TugCardDelegate` event pipe. The preservation-layer callbacks (`onCardActivated`, `onSave`, `onRestore`) are a separate protocol that rides atop this pipe and lives in [state-preservation.md](state-preservation.md), not here. The route-scoped sibling pipe — one `RouteLifecycle` per prompt entry, surfacing route changes rather than card moments — is [route-lifecycle.md](route-lifecycle.md).

---

## The lifecycle moments the pipe surfaces

Six framework-driven moments, surfaced to delegates as eleven optional methods:

| Moment | Methods |
|--------|---------|
| Construction | `cardDidFinishConstruction` |
| Activation | `cardWillActivate` / `cardDidActivate` |
| Deactivation | `cardWillDeactivate` / `cardDidDeactivate` |
| Move | `cardWillMove` / `cardDidMove` |
| Resize | `cardWillResize` / `cardDidResize` |
| Destruction | `cardWillBeginDestruction` |

Construction and destruction are one-shot events bracketing the card's lifetime. Activation and deactivation are paired transitions that fire whenever the deck-level focus moves between cards. Move and resize are paired transitions that fire whenever the pane geometry changes for a card.

### The strict cross-card ordering invariant

When the active card transitions A → B, the will/did pairs interleave across the outgoing and incoming cards rather than running A's pair to completion before B's. The order is:

1. `cardWillDeactivate(A)` — preparation: A can stash state before the transition commits.
2. `cardWillActivate(B)` — preparation: B can arm itself.
3. *Store + responder-chain update* — `store.focusCard(B)` and, if needed, `manager.makeFirstResponder(B)`.
4. `cardDidDeactivate(A)` — reaction: A reacts to the fact.
5. `cardDidActivate(B)` — reaction: B reacts to the fact.

All five phases are synchronous at the lifecycle layer. Subscribers that need pre-mutation state (read A's `getFocusedCardId()` while it is still the active card) must observe in the will-phase; subscribers that need post-mutation state observe in the did-phase. The interleave matters: A's `cardDidDeactivate` runs *after* B has already become the active card, not before. Source: `activateCard` in [`card-lifecycle.ts`](../tugdeck/src/lib/card-lifecycle.ts).

Same-card re-activation is silent on all four channels — no will/did fires, the store re-confirms z-order and the responder chain is reconciled if it has drifted.

---

## The `TugCardDelegate` interface

Defined in [`tugdeck/src/lib/card-lifecycle.ts`](../tugdeck/src/lib/card-lifecycle.ts). All eleven methods are optional and each receives a single `cardId: string` argument. Move and resize do not carry geometry payloads on the delegate method itself — the new position or size is read off the store after the did-phase commits, or via `observeCardWillMove` / `observeCardWillResize` for the pre-mutation values.

```ts
export interface TugCardDelegate {
  cardDidFinishConstruction?(cardId: string): void;
  cardWillActivate?(cardId: string): void;
  cardDidActivate?(cardId: string): void;
  cardWillDeactivate?(cardId: string): void;
  cardDidDeactivate?(cardId: string): void;
  cardWillMove?(cardId: string): void;
  cardDidMove?(cardId: string): void;
  cardWillResize?(cardId: string): void;
  cardDidResize?(cardId: string): void;
  cardWillBeginDestruction?(cardId: string): void;
}
```

<!-- TODO: candidate law? plan doc disagrees on X — `dash/tugplan-lifecycle-delegates.md` shows older method signatures with geometry payloads on `cardWillMove` / `cardDidMove` / `cardWillResize` / `cardDidResize`. The current source ([D07]) carries only `cardId`; pre-mutation geometry comes from the observer pre-phase, post-mutation geometry from the store. -->

### Observer vs. delegate

The pipe exposes two surfaces to consumers:

- **Observer primitive — `lifecycle.observeCard*(cardId | null, cb)`** — Returns an unsubscribe function. Callbacks run **synchronously** in the notify call stack, before any downstream commit. Use this when you need pre-mutation state (a `will*` event in a world where the transition has not yet committed), when you need ordering with other synchronous observers, or when you are not React-bound (e.g., `selectionGuard`).
- **Delegate hook — `useCardDelegate(cardId, delegate)`** — Defers the user callback onto the `MessageChannel` drain queue. Each `useCardDelegate` call subscribes to all ten observer channels at mount via `useLayoutEffect` ([L03]); the observer callbacks enqueue closures, and the closures invoke the matching method on the delegate when the queue drains. The callback runs **after** the commit, past WebKit's gesture focus-lock, and independent of React's commit scheduling. Use this for React-context-bound focus / DOM work that must survive a gesture (`entryDelegate.focus()` on `cardDidActivate`, `blur()` on `cardWillDeactivate`).

The `will*` method names describe observer ordering, not delegate timing. The delegate hook's `cardWillDeactivate` runs *after* the state commit because of the deferred drain — consumers that need pre-mutation semantics must subscribe via `observeCard*` directly. This caveat is documented inline on the `TugCardDelegate` interface in `card-lifecycle.ts`.

A delegate is a single active responder; observers are passive watchers. The two surfaces share the same fire path.

---

## The drain queue

The delegate hook does not invoke callbacks synchronously. Instead, observer callbacks enqueue closures onto a module-scope `MessageChannel`-backed queue, and a single `onmessage` handler drains the queue.

The mechanism, implemented in [`card-lifecycle.ts`](../tugdeck/src/lib/card-lifecycle.ts) (the section starting at the `// MessageChannel-based delegate drain queue` comment, immediately above the `TugCardDelegate` definition):

```ts
const delegateQueue: DelegateCall[] = [];
const delegateChannel: MessageChannel = new MessageChannel();
delegateChannel.port1.onmessage = (): void => {
  const pending = delegateQueue.splice(0);
  for (const fn of pending) {
    try { fn(); } catch (err) { console.error(...); }
  }
};
function scheduleDelegateCall(fn: DelegateCall): void {
  delegateQueue.push(fn);
  delegateChannel.port2.postMessage(null);
}
```

Why a `MessageChannel` rather than React's `setState → useEffect` pipeline or a microtask:

- **Macrotask, not microtask.** `MessageChannel.postMessage` queues a macrotask that runs after the current task completes — past WebKit's gesture focus-lock, which fires on `pointerdown`/`mousedown` and reverts focus changes that land within the same task as a `preventDefault()`-ed pointer event.
- **No `setTimeout(0)` 4 ms clamp.** `MessageChannel` queues a macrotask directly, skipping the timer subsystem and its throttling in background tabs.
- **Independent of React commits.** Closures queued here survive component unmount between fire and drain — the dying card's own `cardWillBeginDestruction` delegate fires reliably even though its component has already unmounted (this was hole H1 in the reliability study; see [`dash/lifecycle-delegate-reliability.md`](../dash/lifecycle-delegate-reliability.md)).

The queue is snapshot-and-cleared on each drain (`delegateQueue.splice(0)`) so callbacks that enqueue further work run on the next drain, preserving order within a tick and preventing runaway reentrant drains.

### `LIFECYCLE_LOG`

A module-level boolean, defaulted to `import.meta.env?.DEV`. When true, every notify entry point logs a one-line trace of the form `[CardLifecycle] cardWillActivate id=<cardId>`. Production builds are silent. Flip the constant in source to capture a one-off trace from a release build.

---

## Per-moment delegate detail

### `cardDidFinishConstruction(cardId)`

Fired by the deck after a card has been added to the store (`notifyCardDidFinishConstruction` in `card-lifecycle.ts`). The first moment a delegate or observer can react to the existence of the card. Construction subscribers receive an **initial-sync** fire on subscription: a hook that subscribes after the card was already constructed still fires once, so a card body can register a delegate from a `useLayoutEffect` and receive its own construction event.

### `cardWillActivate(cardId)` / `cardDidActivate(cardId)`

Pre- and post-activation hooks for the inactive-to-active transition. Activation is the sole sanctioned way to change which card is active; consumers must call `lifecycle.activateCard(cardId)` rather than mutating the store directly. Initial-sync fires for `cardDidActivate` only — a hook subscribing while a card is already active receives the event immediately, so mount-time subscribers do not need a separate "read current state" branch. [AT0008] is the infrastructure gate for this surface; the EM-half of [AT0002] / [AT0004] / [AT0005] / [AT0006] / [AT0007] / [AT0009] are the regression tests covering the focus-restore implementations that ride atop it.

### `cardWillDeactivate(cardId)` / `cardDidDeactivate(cardId)`

Pre- and post-deactivation hooks. The will-phase is the standard moment to stash state before the active-to-inactive transition; the did-phase is the moment to react to the fact (a card that lost focus may want to dismiss a transient UI). `cardWillDeactivate` is also fired from the deck's `removeCard` path before a close on an active card, so a card closing while active sees `cardWillDeactivate` → `cardDidDeactivate` → `cardWillBeginDestruction`. None of the deactivation channels has initial-sync — deactivation is strictly transitional, not a state to replay.

### `cardWillMove(cardId)` / `cardDidMove(cardId)`

Pre- and post-move hooks. Fired by the deck's `moveCard` when the new position differs from the existing one. The will-phase is the canonical place to stash any DOM-level positional state before the commit; the did-phase reads the new position off the store and is the canonical place to re-assert focus that a drag gesture may have disturbed. As noted on the interface, the methods themselves do not carry geometry payloads — read the store after the did-phase or use the observer pre-phase for the pre-mutation values.

### `cardWillResize(cardId)` / `cardDidResize(cardId)`

Pre- and post-resize hooks for size changes. Same shape as move — fired by `moveCard` when the new size differs from the existing one. The store now reflects the new size at did-phase time.

### `cardWillBeginDestruction(cardId)`

Final flush before the card is removed from the store. Fired *before* the deck removes the card so synchronous observers can read state. Important caveat for `useCardDelegate` consumers: the delegate hook defers callbacks through the drain queue, which runs as the next macrotask. Between the synchronous fire and the deferred drain, the deck removes the card from its store — so a delegate's `cardWillBeginDestruction` runs after the card is gone from the store. Delegates that need the card's pre-destruction state must capture it synchronously in an observer (`observeCardWillBeginDestruction`), not from within the deferred delegate method. Refs owned by the card's own components are unaffected; they are held by the consumer, not looked up through the store. [AT0019] is the regression gate for the flush path.

---

## Portal-refactoring relationship

The lifecycle is observable in the first place because [`CardHost`](../tugdeck/src/components/chrome/card-host.tsx) portals into the host pane's content `<div>` via `CardPortal` rather than re-mounting on cross-pane move. Every `CardHost` lives at a stable position in the deck's React tree; only its DOM output relocates when the pane assignment changes.

Without the portal, every cross-pane move would unmount the source `CardHost` and mount a fresh one at the destination — which would fire `cardWillBeginDestruction` + `cardDidFinishConstruction` instead of `cardWillMove` + `cardDidMove`. [L23] (state preservation across bookkeeping operations) is the law that makes the portal architecture necessary; the lifecycle pipe is the surface that law expresses for cross-pane moves.

[L09] (TugPane composes chrome and owns geometry) and [L10] (one responsibility per layer) are the laws that draw the boundary the portal walks across: TugPane owns geometry and chrome, CardHost portals content into TugPane's content region, the card content owns domain logic. Move and resize fire on the card identity even though the pane chrome is the thing that physically moved.

---

## When delegates fire vs. when React effects fire

The drain queue runs as a macrotask, so the relative ordering with React's commit cycle is:

1. The deck calls a notify entry point (e.g. `notifyCardDidActivate`).
2. Synchronous observers fire in subscription order, in the same call stack.
3. `useCardDelegate`-style observers enqueue a closure and post a `MessageChannel` message.
4. The current task completes — React schedulers, `useLayoutEffect`, paint all run as part of the task's commit phase if they were triggered.
5. The macrotask boundary is crossed; the `MessageChannel` `onmessage` handler drains the queue and invokes each delegate method.

This places delegate callbacks AFTER paint, after WebKit's gesture focus-lock has cleared, and outside React's commit scheduler — which is exactly what was needed for `entryDelegate.focus()` on `cardDidActivate` to land reliably.

Subscriptions install in `useLayoutEffect` ([L03] — registrations that events depend on must be complete before events fire). The delegate object is held in a `useRef` and synced from a `useLayoutEffect`, so inline literals do not re-install the underlying observer subscriptions on every render.

---

## Authoring rules

**Every engine-managed (`engineKind: "em"`) card MUST register an engine hook (`store.registerEngineHooks`) whose `paintMirrorAsActive` claims focus on its own text surface** — the CM6 `view.focus()` for the Session card's `TugTextEditor` and the Text card's `TugTextCardEditor`. This is the content half of [P21] — see [responder-chain.md § First responder](responder-chain.md) — and it is what keeps first-responder-routed accelerators (⌘F, ⌘S, clipboard, route chords) working on the card no matter how it became active. The framework's single focus channel (`applyBagFocus`) resolves an em card to `engine` and invokes that hook on **every** activation route (click, tab switch, pane activation / frontmost change, pane cycle, cross-pane move, cold boot); the resulting `focusin` promotes the card's content responder, closing the loop. A **late editor bind** (Open Quickly's create-before-mount, an async file load) is covered by the same channel: registering the hook bumps the engine-hooks version, and `CardHost`'s `subscribeEngineHooksChange` retry re-runs `applyBagFocus` against the now-mounted view.

Do **not** reclaim focus from `cardDidActivate` — that path drains *after* the framework's single-channel claim and would duplicate it, risking a clobber of a framework-axis target ([L05] timing-derived ordering; [L23] single-channel). Both the Dev and Text cards make `cardDidActivate` a deliberate no-op for exactly this reason. (`cardDidMove` / `cardDidResize` are a separate matter: those gestures move the card's DOM identity or pull first responder onto the pane via a title-bar interaction, and re-asserting the editor destination there is the sanctioned recovery — both cards do it.)

**Register a `TugCardDelegate` when:** the consumer is React-context-bound (needs to call back into a hook surface) and the work needs to survive a gesture or a React commit-cycle race. The canonical example is the `cardDidMove` / `cardDidResize` focus reclaim — a title-bar drag pulls first responder onto the pane, and the card re-asserts its editor destination from the delegate after the gesture settles.

**Use `observeCard*` directly when:** the consumer is non-React (`selectionGuard`), needs synchronous pre-mutation state, or needs ordering with other synchronous observers. The store is in its pre-mutation state inside `observeCardWillDeactivate`; the delegate's `cardWillDeactivate` runs after the commit.

**Skip the delegate model entirely when:** the work is chrome-only and does not depend on lifecycle moments (a static decoration, a label, a control whose state is fully derived from props).

**For preservation needs (`onSave` / `onRestore` / `onCardActivated`),** use the preservation hook and read [state-preservation.md](state-preservation.md). The preservation callbacks ride atop this pipe but are a separate, higher-level protocol — `onCardActivated` is a no-arg signal dispatched through the deck store's activation-callback channel, fired after `cardDidActivate` has landed.

---

## Files

Primary canonical authority — [D07] tie-breaker. When a plan doc and the source disagree, the source wins.

- [`tugdeck/src/lib/card-lifecycle.ts`](../tugdeck/src/lib/card-lifecycle.ts) — `TugCardDelegate` interface; eleven lifecycle method names; `CardLifecycle` class with the ten observer channels and ten notify entry points; `useCardDelegate` hook; the `MessageChannel` drain queue (`delegateQueue`, `delegateChannel`, `scheduleDelegateCall`); `LIFECYCLE_LOG`; `CardLifecycleContext` / `useCardLifecycle`; module-level `registerCardLifecycle` / `getCardLifecycle` for cross-provider bootstrapping.

Secondary implementation source — where the lifecycle is wired up in practice.

- [`tugdeck/src/components/chrome/card-host.tsx`](../tugdeck/src/components/chrome/card-host.tsx) — `CardHost` lives at the deck level in the React tree; its DOM output portals into the host pane's content `<div>` via `CardPortal`. The portal is what makes cross-pane moves observable as `cardWillMove` / `cardDidMove` instead of destruction + construction.
- [`tugdeck/src/deck-manager.ts`](../tugdeck/src/deck-manager.ts) — Constructs the per-deck `CardLifecycle` instance; calls `registerCardLifecycle` so providers outside the React tree (notably `ResponderChainProvider`) can attach the responder chain manager via `setManager` from a mount effect.

Historical / secondary planning — kept for context, not authoritative.

- [`dash/tugplan-lifecycle-delegates.md`](../dash/tugplan-lifecycle-delegates.md) — Original lifecycle-delegates plan. Some method signatures in older sections do not match the current `TugCardDelegate` interface; follow the source per [D07].
- [`dash/lifecycle-delegate-reliability.md`](../dash/lifecycle-delegate-reliability.md) — The reliability study that motivated the `MessageChannel` drain queue. Background on WebKit's gesture focus-lock, the microtask vs. macrotask distinction, and hole H1 (dying-card delegate loss) which the queue closes.

---

## Cross-Links

- [route-lifecycle.md](route-lifecycle.md) — The route-scoped sibling pipe. `RouteLifecycle` surfaces one moment — a prompt-entry route change — as a synchronous `(prev, next)` will/did pair, with no `MessageChannel` drain. Per-prompt-entry scope rather than deck-level; finer-grained than this pipe, and modeled on the same observer-vs-delegate split.
- [turn-lifecycle.md](turn-lifecycle.md) — The Dev-session sibling. The assistant-turn state machine projected purely into `submitButtonMode` / `canSubmit`, read through `useSyncExternalStore` rather than a delegate drain; controls that change a turn's settings subscribe to it and decline while a turn is live ([L28]) rather than reaching into the running turn.
- [state-preservation.md](state-preservation.md) — The preservation-layer protocol that rides atop this pipe. `onCardActivated`, `onSave`, `onRestore` are not delegate methods; they are preservation callbacks. When `cardDidActivate` fires, the preservation layer dispatches `onCardActivated` on the corresponding card's preservation record; when `cardWillDeactivate` fires, the preservation layer captures the bag.
- [card-state-model.md](card-state-model.md) — The per-axis contract for selection, focus, scroll, and form-control values across the transitions this pipe surfaces.
- [pane-model.md](pane-model.md) — The Deck → Pane → Card hierarchy. Move and resize fire on the card identity; the pane chrome is what physically moves. Cards never set their own position, size, or z-order ([L09]).
- [responder-chain.md](responder-chain.md) — The activation phase calls `manager.makeFirstResponder(cardId)` as part of step 3 of the strict ordering. The lifecycle and the responder chain are kept in sync via `setManager`.
- App-tests gating this surface: [`at0019-pane-teardown-flush`](../tests/app-test/at0019-pane-teardown-flush.test.ts) (every card's save callback flushes before pane destruction), plus the activation round-trips in [`at0004-app-resign-return`](../tests/app-test/at0004-app-resign-return.test.ts), [`at0006-cross-pane-drag`](../tests/app-test/at0006-cross-pane-drag.test.ts), and [`at0007-card-detach`](../tests/app-test/at0007-card-detach.test.ts). Their EM-flavored halves were retired on 2026-08-11 as duplicates of the same contract.
- [tuglaws.md](tuglaws.md) — [L23] (state preservation across bookkeeping; what makes the portal necessary), [L09] / [L10] (Pane vs. Card responsibilities; geometry vs. content identity), [L03] (`useLayoutEffect` for registrations that events depend on; how `useCardDelegate` installs).
- [design-decisions.md](design-decisions.md) — [D49] (per-tab state bag), [D50] (`useCardStatePreservation` hook), [D51] (focused card ID persistence), [D52] (collapsed state persistence). The lifecycle pipe is the trigger surface that drives [D49]–[D52]'s capture and restore moments.
