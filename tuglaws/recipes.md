# Recipes

*Named patterns that the laws imply but don't spell out. Each recipe has a single canonical shape, a reference implementation in the codebase, and the laws it satisfies. When a plan author or implementer needs the right pattern for a situation, they reach for the recipe by name rather than re-deriving it from the laws.*

*Cross-references: `[L##]` → [tuglaws.md](tuglaws.md). `[D##]` → [design-decisions.md](design-decisions.md).*

---

## How to use this document

Recipes are not laws. They are the *consequence* of laws applied to a recurring situation. A law forbids; a recipe prescribes. [L02] forbids `useState` + manual sync; it does not say what shape an externally-owned store should take when it is constructed per component instance — that is what [R1](#r1) is for.

When writing or reviewing code that touches external state, find the situation below and follow the named recipe. Reference implementations are stable — if a recipe's reference moves, update this document rather than letting the recipe drift.

| Situation | Recipe |
| --- | --- |
| The component owns a store *instance* whose lifetime matches the component, and a prop drives a runtime setting on that store. | [R1. Ref-init stateful store with reactive knob](#r1) |
| The component reads from a store that lives outside it (module singleton, context-provided, or constructed by R1) and the value drives React render output. | [R2. External store consumed via `useSyncExternalStore`](#r2) |
| The component reads from a store whose changes drive direct DOM mutation, not React render. | [R3. Store observer driving DOM mutation in `useLayoutEffect`](#r3) |

---

## R1. Ref-init stateful store with reactive knob {#r1}

### When to use

The component owns a store instance whose lifetime matches the component (per-instance, not module-singleton), and one or more *runtime knobs* on that store — filters, predicates, target ids, callbacks — change with props over the component's lifetime.

This is the situation that misled the gallery-prompt-entry implementation: a per-instance `FeedStore` whose workspace filter changes when the workspace changes. The wrong instinct is to put `new FeedStore(...)` inside `useMemo` keyed on the filter — but construction is a side effect, not a pure computation, and `useMemo` is allowed to re-run its callback. The right pattern separates construction (do it once) from configuration (push the new value into the existing instance).

### Pattern

```tsx
const storeRef = useRef<MyStore | null>(null);
if (storeRef.current === null) {
  storeRef.current = new MyStore(/* dependencies that don't change */);
}

useEffect(() => {
  storeRef.current?.setKnob(currentKnobValue);
}, [currentKnobValue]);

useEffect(() => {
  return () => {
    storeRef.current?.dispose();
    storeRef.current = null;
  };
}, []);
```

Three things are doing work:

1. **Ref-init at first render** (`if (ref.current === null) ref.current = new Store(...)`). The store is constructed exactly once per component instance, before any effect or render output depends on it. Survives StrictMode's double-invoke because the assignment is idempotent on the same render cycle and the second mount sees a fresh ref.
2. **Effect-applied knob** (`useEffect(() => storeRef.current?.setKnob(value), [value])`). The store *exists*; the knob is a setter on the existing instance. The effect re-runs only when the knob changes — no reconstruction, no instance churn, no subscriber re-attach.
3. **Cleanup on unmount**. The ref-init bypasses React's lifecycle for construction, so cleanup must be wired explicitly via the return of a `useEffect(() => ..., [])`.

### Anti-patterns

- **`useMemo(() => new Store(...), [knob])`** — `useMemo` is a pure-computation cache, not a lifecycle hook. React is allowed to re-run the callback (StrictMode, future scheduling features) and discard the result. The old store is never disposed; the new one's subscribers are never re-attached. *[L02 violation in spirit: `useMemo` is being used as if it were a lifecycle primitive.]*
- **`useState(() => new Store(...))`** — converts the store handle into React state, which then needs to be threaded through render. Adds a re-render every time the state setter is called and exposes the handle to React's reconciliation, which has nothing useful to do with it.
- **Reconstructing the store inside an effect**: `useEffect(() => { storeRef.current = new Store(knob); ... }, [knob])` — every knob change destroys and rebuilds the store, dropping all subscriptions.

### Reference implementation

`tugdeck/src/components/tugways/cards/gallery-prompt-entry.tsx:169-202` — `fileTreeStackRef` is ref-initialized once; the workspace filter is pushed in via `feedStore.setFilter(workspaceFilter)` in a `useEffect`; cleanup disposes the store on unmount.

`tugdeck/src/components/tugways/hooks/use-card-feed-store.ts:41-67` — same pattern, factored into a hook. Notable: the hook also exports the store's `subscribe`/`getSnapshot` to a `useSyncExternalStore` (this is [R2](#r2) on top of R1).

### Laws satisfied

[L02] — the store stays out of React state; reads happen via `useSyncExternalStore` (when there is a render-time consumer) or via direct observer subscription (when there is not, see [R3](#r3)).
[L01] — no path to a stray `root.render()`; the store is plain TypeScript, components consume it via the standard hooks.

---

## R2. External store consumed via `useSyncExternalStore` {#r2}

### When to use

A store exists outside the component (module singleton, context-provided, or constructed by [R1](#r1)) and the component's render output depends on the store's current value.

### Pattern

```tsx
const store = useStoreFromSomewhere();
const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

return <div>{snapshot.someField}</div>;
```

`subscribe` and `getSnapshot` must be **stable references** — define them as arrow properties on the store class (auto-bound `this`), not as methods that need `.bind()` per render. If their identity changes between renders, React tears down and re-attaches the subscription on every render, which both wastes work and risks missing updates.

When deriving a *projection* of the store's state (selecting a field, mapping a list), the derivation should be cheap and referentially stable for unchanged inputs. If the store does not provide a per-field selector, wrap the projection in `useSyncExternalStoreWithSelector` from `use-sync-external-store/with-selector`, or compute the projection in the parent and pass it as a prop.

### Anti-patterns

- **`useState` + `useEffect(() => store.subscribe(setState))`** — duplicates the store's value into React state and introduces a tearing window where the React state is one tick behind the store. *[L02 violation, explicit.]*
- **`useEffect(() => { setReact(store.get()) }, [externalThing])`** — copies external state into React state via an effect; same tearing problem, plus stale-closure risk if `externalThing` is itself a ref. *[L02 violation, explicit.]*
- **Calling `store.getSnapshot()` directly during render without subscribing** — the component will not re-render when the store changes; the displayed value will go stale and only update on the next unrelated render.
- **Inline `() => store.getSnapshot().field` as the snapshot function** — creates a new function identity every render and (worse) returns a new object literal each call if the projection is `() => ({a: store.x})`. React's snapshot equality check fires repeatedly. Hoist the snapshot function to module scope or use a selector helper.

### Reference implementation

`tugdeck/src/components/chrome/deck-canvas.tsx:65-72` — `DeckCanvas` reads the entire `DeckState` via `useSyncExternalStore(store.subscribe, store.getSnapshot)` from the `IDeckManagerStore` provided by `useDeckManager()` context.

`tugdeck/src/deck-manager-store.ts:24-42` — the store interface itself: `subscribe`, `getSnapshot`, and `getVersion` are all *arrow properties* (not methods), guaranteeing stable identity across reads. The interface comment makes this contract explicit. [D40, D68]

### Laws satisfied

[L02] — reads flow through `useSyncExternalStore`, not `useState` + sync effects.
[L01] — `notify()` from the store fans out to all subscribers without any code re-calling `root.render()`.

---

## R3. Store observer driving DOM mutation in `useLayoutEffect` {#r3}

### When to use

A store value changes; the change should produce *direct DOM writes*, not React state changes. Streaming text into a markdown view, applying selection paint, animating a value across a DOM element — these are appearance-zone changes that React has no business reconciling.

The naive instinct is to bridge through React anyway: `useSyncExternalStore` to pull the value in, then `useEffect` to write it to a ref'd DOM node. This injects React's full schedule (re-render → commit → effect) between the data change and the DOM write. The result is frame delays, stale-closure bugs, and unnecessary reconciliation. [L22] forbids this round-trip.

### Pattern

```tsx
useLayoutEffect(() => {
  if (!store) return;
  const unsubscribe = store.observe(path, () => {
    const value = store.get(path);
    domWriteFunction(value);
  });
  return unsubscribe;
}, [store, path]);
```

Three things are doing work:

1. **`useLayoutEffect`, not `useEffect`** — the subscription must be installed before the first paint so initial values are not missed and registrations needed by event handlers are in place. [L03]
2. **The subscription is the only consumer.** No `useSyncExternalStore` for the same value. The store change does not pass through React's render cycle; it goes directly from store callback to DOM mutation.
3. **Cleanup returns the unsubscribe function** — store subscriptions outlive component lifecycle if not torn down on unmount.

### Anti-patterns

- **`useSyncExternalStore` + `useEffect(() => writeToDOM(value), [value])`** — the round-trip [L22] forbids. The store value is pulled into React state, triggers a re-render, the re-render commits, then the effect fires and writes to the DOM. By the time the DOM updates, two frames have passed and the closure may already be stale.
- **`useEffect(() => store.observe(...))`** instead of `useLayoutEffect` — fires after paint, so the first frame of the component renders without the subscription attached. Race condition: store updates emitted between mount and the effect are missed.
- **Subscribing in render** — re-subscribes every render, leaks listeners, fires synchronously during reconciliation.

### Reference implementation

`tugdeck/src/components/tugways/tug-markdown-block.tsx`, the streaming-mode `useLayoutEffect` — streaming markdown rendering. `streamingStore.observe(streamingPath, ...)` is wired in a `useLayoutEffect`; the callback requests a frame flush (`tugdeck/src/lib/markdown/streaming-flush.ts`) that reads the latest text and reconciles the DOM through `renderIncremental`. The component does not pull `streamingPath`'s value through `useSyncExternalStore` at all — it never enters React state.

### Laws satisfied

[L22] — the store value drives DOM writes via direct observer subscription, not via React's render cycle.
[L06] — the rendered output of the streamed text is appearance-zone state; the DOM is its home.
[L03] — the subscription is installed in `useLayoutEffect`, before any event handler that depends on the store could fire.

---

## Choosing between R2 and R3

The deciding question is *who reads this value?*

- If a React component renders the value (or a derivative of it) into JSX, the value flows through React. Use [R2](#r2).
- If only the DOM consumes the value — a class toggle, an inline style, a text-content write to a ref'd node — keep React out of it. Use [R3](#r3).

A single store can be the source for both, in different components or different code paths. `DeckManager` is read via [R2] by `DeckCanvas` (which renders panes from the state) and via direct observer subscription by chrome code that mutates `data-*` attributes. The recipe choice is per-consumer, not per-store.

If a value's only consumer is rendering and its only purpose is to look a certain way (hover state, focus ring, transient visual flag), it should not be in a store at all — see [L06]: appearance-zone state belongs in the DOM directly, not behind a subscription.
