# Route Lifecycle

> **HISTORICAL — this describes a mechanism that no longer ships.** `RouteLifecycle` and `TugRouteDelegate` are absent from `tugdeck/src`; they went with the sticky `❯` / `$` / `?` recipient routes. The composer's routes today are the two of [D122] — Prompt and Changes — and their selection lives in `CommitModeController`, read through `useSyncExternalStore` with no lifecycle pipe. Kept for the observer-vs-delegate reasoning, which is still the shape `CardLifecycle` uses.

*Route lifecycle: the per-prompt-entry event pipe for the command route. How `RouteLifecycle` holds the authoritative route, how `TugRouteDelegate` observers are registered and fired, and why dispatch is synchronous.*

*Cross-references: `[D##]` → [design-decisions.md](design-decisions.md). `[L##]` → [tuglaws.md](tuglaws.md).*

---

## Why a route pipe

A Dev prompt entry has a *command route* — the *recipient* a submission is sent to: `❯` Code (Claude on the record), `$` Shell (the machine), or `?` btw (Claude off the record — a native side question, [D108]/[D110]). The route is a single scalar of state, but it is read in several places and changed from several triggers, and a slice of chrome wants to *react* when it changes. Holding it in `TugPromptEntry`'s `useState` worked while that component was its only reader; it stopped working the moment the route gained a consumer *outside* the component — the route-indicator badge, which names what the active route targets.

`RouteLifecycle` is the pipe that resolves this. It owns the authoritative route, exposes it as external state so any descendant can subscribe, and announces every change as a will/did pair so imperative reactors can prepare and respond. It is the route-scoped sibling of the deck's `CardLifecycle` ([lifecycle-delegates.md](lifecycle-delegates.md)) — the same observer-vs-delegate shape, a far smaller surface, a finer scope.

---

## Scope: one pipe per prompt entry

`RouteLifecycle` is **not** deck-level. One instance is constructed per `TugPromptEntry` and provided to that entry's subtree through `RouteLifecycleContext`. A route is a property of a single prompt entry; each Session card has its own, and a multi-card deck has independent routes with no cross-talk. The context naturally bounds who can observe — only descendants of the entry's provider, which is exactly where the toolbar's indicator slot renders.

The instance is constructed once and stays stable for the component's lifetime — a `useRef` lazy-init inside `TugPromptEntry`, never a module singleton. There is, deliberately, no module-level registry the way `CardLifecycle` has one (`registerCardLifecycle` / `getCardLifecycle`): nothing outside the React tree needs to reach a `RouteLifecycle`, so the context provider is the whole story.

---

## The moment the pipe surfaces

Where `CardLifecycle` surfaces six framework-driven card moments, `RouteLifecycle` surfaces exactly one — the route change — as a will/did pair, and holds the current route as queryable state.

### The change sequence

`setRoute(next)` runs the sequence when `next` differs from the current route:

1. `routeWillChange(prev, next)` observers fire — preparation; the route is still `prev`, so `getRoute()` returns `prev`.
2. The lifecycle commits `route = next` and notifies store-surface listeners.
3. `routeDidChange(prev, next)` observers fire — reaction; the route is now `next`, so `getRoute()` returns `next`.

Setting the route to its current value is a no-op on every channel — no will, no store notification, no did. The whole sequence is synchronous: when `setRoute` returns, the route has committed and every observer has run.

---

## Two surfaces, one fire path

The pipe exposes two surfaces to consumers, both fed by the single `setRoute` path:

- **Store surface — `subscribe(listener)` + `getRoute()`.** `subscribe` returns an unsubscribe function; `getRoute` returns the current, authoritative route. The pair is shaped for `useSyncExternalStore`, and a `string` snapshot is referentially stable by value. This is how renderers read the route ([L02]). `useRoute()` is the React wrapper.
- **Delegate / observer surface — `observeRouteWillChange(cb)` / `observeRouteDidChange(cb)`.** Each returns an unsubscribe function; callbacks fire **synchronously** in the `setRoute` call stack. `useRouteDelegate(delegate)` is the React hook wrapper. For imperative reactors.

The store surface answers "what is the route now"; the delegate surface answers "the route just changed." A clean [L02]-vs-imperative split — the same one [lifecycle-delegates.md](lifecycle-delegates.md) draws for cards.

---

## The `TugRouteDelegate` interface

Defined in [`route-lifecycle.ts`](../tugdeck/src/lib/route-lifecycle.ts). Both methods are optional; a missing method is a no-op.

```ts
export interface TugRouteDelegate {
  routeWillChange?(prev: string, next: string): void;
  routeDidChange?(prev: string, next: string): void;
}
```

Unlike `TugCardDelegate`, whose methods carry only a `cardId` and leave the consumer to read geometry or state off a store, `TugRouteDelegate`'s methods carry the `(prev, next)` pair directly. The route value *is* the event's information — there is no separate store to read the old value from after the fact, so the pair travels on the call.

### Observer vs. delegate

The pipe exposes two ways to consume the change moment, sharing one fire path:

- **Observer primitive — `lifecycle.observeRoute{Will,Did}Change(cb)`** — returns an unsubscribe function. Callbacks run synchronously in the `setRoute` call stack. Use this when you are not React-bound, or need ordering with other synchronous observers.
- **Delegate hook — `useRouteDelegate(delegate)`** — subscribes both channels at mount via `useLayoutEffect` ([L03]) so the registration is ready before any `setRoute` can fire. The delegate object is held in a `useRef` and synced from a `useLayoutEffect`, so an inline literal does not re-install the subscriptions on every render.

Because dispatch is synchronous (below), the `will*` / `did*` names describe delegate timing *accurately* — a delegate's `routeWillChange` really does run before the commit. This is the one place `RouteLifecycle` is simpler than `CardLifecycle`, whose delegate `will*` methods run *after* the commit because of its drain queue.

---

## No drain queue — synchronous dispatch

`CardLifecycle` defers delegate callbacks through a module-scope `MessageChannel` drain queue: a macrotask that runs past WebKit's gesture focus-lock, so post-activation `entryDelegate.focus()` lands reliably. `RouteLifecycle` has **no** such queue. `setRoute` fires its observers synchronously and returns.

The drain queue exists for one reason: focus work that must survive a pointer gesture. Route-change consumers do not do focus work — they re-render content (a badge's label, the editor's placeholder and Return-key binding). They have no gesture focus-lock to escape and no React commit-cycle race to clear, so synchronous dispatch is both correct and simpler. A drain queue here would buy nothing and cost a tick of latency on every route flip.

One consequence: there is **no initial-sync replay** on the delegate surface. `CardLifecycle` re-fires `cardDidFinishConstruction` / `cardDidActivate` to a hook that subscribes late, so a mount-time subscriber sees current state without a separate read. `RouteLifecycle` does not — a `useRouteDelegate` that mounts after a change is not handed a synthetic fire. The delegate surface is purely transitional; read the *current* route through the store surface (`useRoute`), which has no such gap.

Observers are error-isolated: a throwing observer is caught and logged, and the dispatch set is snapshotted before iteration, so an observer that subscribes or unsubscribes mid-fire does not perturb the run in progress.

---

## Ownership, provision, and the route triggers

`TugPromptEntry` is the single owner and provider:

- It constructs one `RouteLifecycle`, seeded with the default route (`❯`) or, on restore, the persisted route.
- It reads the route via `useSyncExternalStore(routeLifecycle.subscribe, routeLifecycle.getRoute)` — directly off the instance it owns. There is no mirrored `useState` and no `routeRef`; the stable instance plus a live `getRoute()` replace them ([D99]).
- It wraps its subtree in `RouteLifecycleContext.Provider`, so descendants reach the pipe through `useRoute()` / `useRouteDelegate()` / `useRouteLifecycle()`.

Every route trigger funnels through `routeLifecycle.setRoute` — there is exactly one mutation path:

| Trigger | Path |
|---------|------|
| Route choice-group click | `SELECT_VALUE` action handler → `setRoute` |
| `SELECT_ROUTE` keybinding (⌃⌘C) | `SELECT_ROUTE` action handler → `setRoute` |
| State restore (close → reopen) | `onRestore` → `setRoute(restored.route)` |

(Typing a route character — `$`, `?`, `>` — at editor offset 0 is deliberately NOT a trigger: first-character route switching was removed; those characters are ordinary text.)

Persistence reads and writes through the pipe too: `onSave` snapshots `routeLifecycle.getRoute()`, and `onRestore` applies the persisted route via `setRoute` before first paint. The route has a single source of truth, so save and restore cannot desync from what the UI shows.

Handlers registered once at mount — the action handlers — read the live route via `routeLifecycle.getRoute()` rather than closing over a render-time value; the stable instance makes that read safe ([L07]).

---

## Consumers today

`TugPromptEntry` drives the route choice-group's `value`, the editor's per-route placeholder, the per-route Return-key action, and the per-route submit dispatch ([D110]: `❯` → send; `?` → `/btw` local dispatch; `$` → `shellSessionStore.exec` — the block-oriented shell backend, [D111]) off the subscribed route. On the `$` route the Z5 submit button is route-aware (`routeAwareSubmitButtonMode`): a `stop` pose while an exchange is in flight (reaping the shell process group) and a plain submit otherwise, disjoint from the Claude turn lifecycle. Descendant consumers now read the route too via `useRoute`: the route-indicator badge (`SessionRouteIndicatorBadge`) names the active route's target, and `SessionRouteChromeManifest` selects the per-route Z4B chip set (Table T01) — including the live `Cwd` chip bound to `shellSessionStore.cwd`. A shell exchange reaches Claude by staging, not by seeding the editor: the exchange row's **Add to context** toggle parks the composed text on the pending-context queue to ride the next `❯` submission ([D111] [P08]), so no route change is produced. The earlier Share affordance — which seeded the composer directly — is retired; one gesture, one glyph (`cloud-upload`). The delegate/observer surface (`useRouteDelegate`) still has no consumer; it ships for future imperative reactors, matching the observer-vs-delegate completeness of `CardLifecycle`.

---

## Authoring rules

**Read the route with `useRoute()`** when a component inside the prompt entry needs to render against the current route. It is the [L02] store subscription; it returns `null` outside a provider, so a component used both inside and outside an entry degrades cleanly.

**Register a `TugRouteDelegate` with `useRouteDelegate()`** when a component needs to *act* on a route change — run an imperative side effect at the will or did moment — rather than only render the current value. If all you do is render, use `useRoute()`.

**Reach the instance with `useRouteLifecycle()`** only when you need to *call* `setRoute` (wire a new route trigger) or attach a non-hook observer. Most code wants `useRoute` or `useRouteDelegate` instead.

**Never mirror the route into `useState`.** The pipe is the single source of truth ([D99]); a second copy is the desync [L02] exists to prevent.

---

## Files

Primary canonical authority — the source is the tie-breaker.

- [`tugdeck/src/lib/route-lifecycle.ts`](../tugdeck/src/lib/route-lifecycle.ts) — the `RouteLifecycle` class (store surface, observer surface, `setRoute`); the `TugRouteDelegate` and `RouteChangeObserver` types; `RouteLifecycleContext`; the `useRoute`, `useRouteDelegate`, and `useRouteLifecycle` hooks.

Secondary implementation source — where the pipe is wired up.

- [`tugdeck/src/components/tugways/tug-prompt-entry.tsx`](../tugdeck/src/components/tugways/tug-prompt-entry.tsx) — constructs the per-entry `RouteLifecycle`, provides `RouteLifecycleContext`, funnels every route trigger through `setRoute`, and reads / writes the route through the pipe on save and restore.

Planning history — kept for context, not authoritative.


---

## Cross-Links

- [lifecycle-delegates.md](lifecycle-delegates.md) — The deck-level `TugCardDelegate` pipe that `RouteLifecycle` is modeled on. Same observer-vs-delegate split; `CardLifecycle` is deck-scoped, surfaces six moments, carries a payload-less `cardId`, and defers delegates through a `MessageChannel` drain. `RouteLifecycle` is per-prompt-entry, surfaces one moment, carries `(prev, next)`, and dispatches synchronously.
- [turn-lifecycle.md](turn-lifecycle.md) — The Dev-session turn state machine. `routeAwareSubmitButtonMode` (above) governs the `$` shell route's Z5 button, disjoint from the Claude turn lifecycle documented there; the two share the Z5 button by route.
- [design-decisions.md](design-decisions.md) — [D99] (`RouteLifecycle` owns the authoritative route), [D97] (the Session card's `Z0`–`Z5` placement zones), [D98] (host facts — the route-indicator badge names a route's target from them).
- [responder-chain.md](responder-chain.md) — the `SELECT_VALUE` and `SELECT_ROUTE` actions that reach `TugPromptEntry`'s responder and call `setRoute`.
- [state-preservation.md](state-preservation.md) — the `onSave` / `onRestore` protocol the route rides; the persisted route is applied through `setRoute` before first paint.
- [tuglaws.md](tuglaws.md) — [L02] (external state enters React through `useSyncExternalStore`; why the route left `useState`), [L03] (`useLayoutEffect` for registrations that events depend on; how `useRouteDelegate` installs), [L07] (handlers read live state — `getRoute()` off the stable instance).
