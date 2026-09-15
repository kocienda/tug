# State Preservation

*The component- and card-level state preservation protocol — capture, persist, restore. The mechanism that makes [card-state-model.md](card-state-model.md)'s per-axis contracts (focus, scroll, form-control value) hold across tab switches, pane activation, app hide/unhide, and cold-boot reload.*

*Cross-references: `[D##]` → [design-decisions.md](design-decisions.md). `[L##]` → [tuglaws.md](tuglaws.md).*

---

## Why

[L23] — *internal implementation operations must never lose, destroy, or cease to apply user-visible state* — is the law this document implements. Scroll position, form-control value, selection, and focus are user data. The user put them there. A re-lex, a tab switch, a pane teardown, a cold-boot reload, or any other framework-driven bookkeeping operation must not be observable in any of those axes.

The naïve interpretation of L23 is "save and restore." That interpretation is wrong: save-and-restore is destruction with attempted recovery, and recovery is fallible. A capture that misses an axis loses the user's data. A restore that fires before the DOM is ready paints the user's selection on the wrong element. A `requestAnimationFrame` that races React's commit cycle drops focus.

The correct interpretation is **preserve where you can, capture-and-replay only when you must**. In-app transitions (intra-pane tab switch, pane activation change, drag aborted) preserve by leaving the DOM mounted; the user's state stays alive in the live tree without any save call ever firing. Cold-boot restore, cross-pane move, and tab-close-then-reopen genuinely have nothing to preserve — the DOM is gone — so the protocol captures the user's state into a serialized `CardStateBag` at the moment of teardown and replays it on reconstruction.

This document describes that capture-and-replay machinery: the two layers of opt-in, the deterministic save/restore lifecycle, the DOM attributes that drive it, the type shapes, and the per-axis tests that gate it ([A9]).

> **Aside — preservation can happen below the bag layer too.** [L23] applies to every internal transition, not just the ones the [A9] capture pipeline covers, and its React-reconciliation complement [L26] is what makes minimal-mutation preservation work inside lists. The session-card transcript's per-turn-key architecture is the canonical example. Turning a streaming row into a committed row used to swap React component types (a `code-streaming` → `code-committed` kind transition) AND swap the renderer lambda picked out of the `cellRenderers` map AND change the React key (the `kind` was baked into `id`) — three simultaneous L26 violations on a row the user perceives as the same thing. React reconciled it as a different element and unmounted the cell wrapper; the browser then silently clamped the scrollport's `scrollTop` to 0 mid-paint, an L23 violation cascading from the L26 one. The fix wasn't capture-and-replay; it was eliminating the transition class entirely. A single `turnKey` minted at `handleSend` is preserved through `handleTurnComplete` onto `TurnEntry.turnKey`, so the cell's React key + component type + renderer reference are byte-identical on either side of the boundary, the wrapper survives unchanged, and streaming children continue to observe their per-turn PropertyStore paths (`turn.${turnKey}.assistant` etc.) without prop change or remount. The chain runs reducer → snapshot → `SessionTranscriptDataSource.rowAt` → `AssistantTurnCell`; breaking [L26] at any link in that chain reintroduces the regression. When you can preserve mount identity through a transition, do so — capture-and-replay is the last resort, not the first.
>
> **Sub-aside — the write side has to keep up with the read side.** L26's "the cell stays mounted and keeps observing one path" promise only delivers if every transition that should populate that path actually populates it. The post-L26 unification once shipped with the renderer correctly reading per-turn paths AND the reducer correctly writing them on live events AND the reducer DELIBERATELY suppressing those writes during replay (a pre-L26 holdover, where committed cells used to render from `TurnEntry.assistant` directly and the suppression saved redundant work). The combination silently lost 100% of committed assistant text, thinking, and tool output across cold-boot rehydration — a textbook L23 violation that the in-session L26 work had no way to detect. The remedy was symmetry: the reducer now emits the same write-inflight effect for replay-accepted text/tool events that it emits for live ones, so the single render path has data to surface on the first frame after restore. The lesson generalizes: any post-L26 architecture that consolidates renderer reads onto a single store path *also* consolidates the contract on the write side. Every transition that should produce the path's value must produce it; a write surface gated on `state.phase` (or any other condition that excludes one ingestion mode) silently breaks the consolidation across whichever boundary that mode covers.

---

## Two layers of opt-in

The protocol has two layers because the question "what is the unit of preserved state?" has two answers in tugdeck.

### Component-level — `useComponentStatePreservation`

An individual stateful control opts in by passing a `componentStatePreservationKey` to its hook call. The framework treats the control as a leaf: at capture time it reads the control's current state via the registered `captureState` closure. The restore half is mount-time: the consumer reads its saved value through `useSavedComponentState<T>` (or `useSavedRegionScroll` for inner-scroll state) and seeds its `useState` initializer with it, so the first paint after restore already reflects the user's last-saved value. The component owns the meaning of the payload (a boolean for a checkbox, a number for a slider, the open accordion section index for an accordion) and the framework treats it as opaque JSON.

The hooks are implemented in [`use-component-state-preservation.tsx`](../tugdeck/src/components/tugways/use-component-state-preservation.tsx). Usage:

```tsx
function TugCheckbox({ componentStatePreservationKey, ...props }: Props) {
  const saved = useSavedComponentState<{ checked: boolean }>(
    componentStatePreservationKey,
  );
  const [checked, setChecked] = useState(() => saved?.checked ?? false);
  useComponentStatePreservation({
    componentStatePreservationKey,
    captureState: () => ({ checked }),
  });
  // ...
}
```

This layer is the right tool when the unit of state is a single control's intrinsic value (slider position, accordion expanded section, switch on/off). Composite controls compose by wrapping their subtree in `<ComponentStatePreservationScope prefix="...">`, which prepends `prefix + "/"` to every nested key — composite components can embed other opt-in components without knowing their inner keys.

Captured payloads land in `bag.components`, keyed by the (scoped) `componentStatePreservationKey`. Every entry is JSON-serializable; the framework persists the bag through tugbank.

### Card-level — `useCardStatePreservation`

A card's content factory (the React component rendered inside `CardHost`) opts in by registering an `onSave` / `onRestore` callback pair. This is the right tool when the unit of state is a richer payload that the card-content component itself manages — the document of a dev engine, the route + tools-open chrome of a `tug-prompt-entry`, the cursor + decoration state of a code editor.

The hook is implemented in [`use-card-state-preservation.tsx`](../tugdeck/src/components/tugways/use-card-state-preservation.tsx). Usage:

```tsx
function SessionCardContent() {
  useCardStatePreservation<SessionContentBag>({
    onSave: () => engine.snapshot(),
    onRestore: (state, { isActive }) => {
      engine.applySnapshot(state);
      if (isActive) engine.paintMirrorAsActive();
      else engine.paintMirrorAsInactive(publish);
    },
    onCardActivated: () => engine.paintMirrorAsActive(),
    onCardWillDeactivate: () => engine.paintMirrorAsInactive(publish),
  });
  // ...
}
```

`onSave` is called by `CardHost` on tab deactivation and on `saveState` RPC; `onRestore` is called on cold-boot mount and after cross-pane move. Both layers can coexist within the same card — a session-card content uses `useCardStatePreservation` for its engine document, and the chrome around it (a `TugCheckbox` in a sidebar, a `TugAccordion` in a settings drawer) opts into `useComponentStatePreservation` independently. Their captures land in different axes of the bag (`bag.content` vs. `bag.components`) and never collide.

---

## Public identifiers

Everything below is grep-stable. Searching this document for a name listed here finds the canonical one-line purpose. Defining files are linked at the head of each cluster.

### Hooks

Defined in [`use-component-state-preservation.tsx`](../tugdeck/src/components/tugways/use-component-state-preservation.tsx) and [`use-card-state-preservation.tsx`](../tugdeck/src/components/tugways/use-card-state-preservation.tsx).

- **`useComponentStatePreservation`** — Component-level opt-in (capture side). Takes `{ componentStatePreservationKey, captureState }`; registers the closure (held in a ref synced every render) with the nearest `ComponentStatePreservationRegistry` inside `useLayoutEffect` ([L03]). No-op when `componentStatePreservationKey` is `undefined` or when rendered outside any card. ([D13], [A9])
- **`useSavedComponentState<T>(componentStatePreservationKey)`** — Component-level opt-in (restore side). Reads `bag.components[scopedKey]` synchronously in render via `useSyncExternalStore` against the deck manager's notify channel. Returns `undefined` outside a card or when no value is saved. Consumed inside a `useState` initializer so the first paint reflects the saved value.
- **`useSavedRegionScroll(scrollKey)`** — Region-scroll-axis read companion. Returns `bag.regionScroll[scrollKey]` (`{ x: number; y: number; meta?: unknown } | undefined`) synchronously in render. Consumed by imperative renderers that accept an `initialScrollTop` parameter; the scroller is created at the saved position so its first observable `scrollTop` already matches the bag.
- **`useCardStatePreservation`** — Card-level opt-in. Takes `{ onSave, onRestore, onCardActivated?, onCardWillDeactivate? }`; registers a `CardStatePreservationCallbacks` record with the enclosing `CardHost` via `CardStatePreservationContext`. Stable wrappers that read from refs at call time — option changes do not re-register ([D02]).

### Registry

Defined in [`component-state-preservation-registry.ts`](../tugdeck/src/components/tugways/component-state-preservation-registry.ts).

- **`ComponentStatePreservationRegistry`** — Per-card registry of opt-in component state preservation entries. One instance per card. Exposes parent-first iteration (lexicographic on `treePath`) so the framework can harvest the full component tree into `bag.components` in a single deterministic order. Owns only the data structure and iteration semantics; the framework orchestration (`captureCardState` / `restoreCardState`) lives elsewhere and consumes the registry.

### Card-level context and callback record

Defined in [`use-card-state-preservation.tsx`](../tugdeck/src/components/tugways/use-card-state-preservation.tsx).

- **`CardStatePreservationContext`** — React context provided by `CardHost` to its children. Carries `{ cardId, register }` so descendants can both register save/restore callbacks and learn the id of the card they render inside without prop-drilling. `null` when rendered outside `CardHost` (the hook then no-ops).
- **`CardStatePreservationContextValue`** — The shape of the context's value. Members: `cardId: string` (stable identity of the enclosing card — survives cross-pane moves), `register: (callbacks: CardStatePreservationCallbacks) => void` (the stable registration entry point; called once per mount).
- **`CardStatePreservationCallbacks`** — The save/restore record handed to `register`. Members: `onSave`, `onRestore`, optional `onContentReady`, optional `restorePendingRef`, optional `onCardActivated`, optional `onCardWillDeactivate`. `CardHost` writes `onContentReady` and sets `restorePendingRef` before calling `onRestore`; the hook's no-deps `useLayoutEffect` reads them after the child commits.
- **`onCardActivated`** — Optional callback on `CardStatePreservationCallbacks`. Fires when this card transitions to being the deck-level focus destination (`isFocusDestination` flips `false` → `true`). Production routing dispatches through the deck store's `invokeActivationCallback` channel; the record field is retained for tests and compatibility. Typical implementation in EM (engine-managed) cards: `engine.paintMirrorAsActive()`. FC (DOM-authority) cards leave it unset — `CardHost` re-applies `bag.focus` + `bag.domSelection` directly for them.
- **`onSave`** — Required callback on `CardStatePreservationCallbacks`. Returns the card's serialized `bag.content` payload. Called synchronously by `CardHost` on tab deactivation and on `saveState` RPC. Must not return a Promise.
- **`onRestore`** — Required callback on `CardStatePreservationCallbacks`. Receives `(state, { isActive })`. `state` is the previously-captured `bag.content`; `isActive` is `true` iff this card is the deck-level first responder at the moment of restore. The consumer routes selection paint through `paintMirrorAsActive` (active) or `paintMirrorAsInactive(publish)` (inactive) accordingly ([L23]).

### Type shapes

Defined in [`layout-tree.ts`](../tugdeck/src/layout-tree.ts).

- **`CardStateBag`** — The flat per-card preservation envelope. Optional members compose by axis: `scroll` (outer host-content scroll), `content` (the `useCardStatePreservation` payload), `formControls` (record of `FormControlSnapshot` keyed by `data-tug-state-key`), `regionScroll` (record keyed by `data-tug-scroll-key`), `domSelection` (the card-boundary selection range), `focus` (the `FocusSnapshot`), `components` (the `useComponentStatePreservation` axis, keyed by scoped `componentStatePreservationKey`). Stored in DeckManager's in-memory cache and durably under tugbank's `dev.tugapp.deck.cardstate/{cardId}`. ([D49], [D50])
- **`FocusSnapshot`** — Discriminated-union shape recording which descendant of the card root held focus at save time. Four kinds: `{ kind: "none" }` (nothing focused inside the card), `{ kind: "form-control", componentStatePreservationKey }` (a native `<input>`/`<textarea>` carrying `data-tug-state-key`), `{ kind: "dom", focusKey }` (a non-form-control focusable element carrying `data-tug-focus-key`), `{ kind: "engine" }` (an engine that manages its own focus + selection together — e.g. `TugPromptEntry`'s contentEditable; the engine registers `paintMirrorAsActive` / `paintMirrorAsInactive` hooks via `store.registerEngineHooks` and the framework invokes them through `applyBagFocus`'s engine resolution). Captured by `captureFocus` in [`card-host.tsx`](../tugdeck/src/components/chrome/card-host.tsx); dispatched through `applyBagFocus` in [`focus-transfer.ts`](../tugdeck/src/focus-transfer.ts) at all focus-claim sites (Phase E.11 single-channel model). Pre-E.11 bags carrying `{ kind: "component-owned" }` are coerced to `"engine"` on read at the deserialization boundary.

### DOM attributes

The protocol's surface area in HTML. Authors add these attributes to opt their elements into the corresponding axis of the bag.

- **`data-tug-state-key`** — On a native `<input>` or `<textarea>` (or the `tug-input` / `tug-textarea` / `tug-value-input` widgets that wrap them). Captures `.value`, selection range, and scroll position into `bag.formControls[key]`. The same key doubles as the focus key — `FocusSnapshot` kind `form-control` reads it so authors do not add a second `data-tug-focus-key` attribute. Key must be unique within the card subtree. (See [card-state-model.md](card-state-model.md) → Form-control Value Preservation.)
- **`data-tug-focus-key`** — On any non-form-control focusable element (button, tab, custom focusable `tabindex=0` widget) that wants its focus restored. Captured into `FocusSnapshot` kind `dom`. Key must be unique within the card subtree.
- **`data-tug-scroll-key`** — On an inner scrollable region (most notably `tug-markdown-view`'s virtual-list container). Captures `{ x, y }` into `bag.regionScroll[key]`. Applied on mount and re-applied for late-mounting regions via the same `MutationObserver` that restores form controls.
- **`data-tug-scroll-state`** — Optional companion to `data-tug-scroll-key`. JSON-serialized opaque metadata captured into `bag.regionScroll[key].meta` alongside `{ x, y }` and forwarded on restore through the `tug-region-scroll-set` event's `detail.meta`. The framework treats the payload as opaque storage; the region's listener owns its semantics. Used by variable-height virtualized lists (`TugListView` driving the session-card transcript) to carry an `{ anchor: { index, offset } }` payload that survives cell-height drift between save and restore — see [`RegionScrollSnapshot` in depth](#cardstatebag-in-depth) below.
- **`data-tug-preserve-scroll`** — Marker on a scroller that should keep its place across a card width change but carries no cross-mount region identity. See [Resize preservation](#resize-preservation).
- **`data-tug-preserve="fraction"`** — On a scroller whose content scales rather than re-wraps (an image, a scaled page). It holds its fractional position across a width change instead of an element's top edge.
- **`data-tug-prompt-input-root`** — Marker attribute on the outer container of an engine that owns its own focus + selection state together (e.g. `TugPromptEntry`). Causes `captureFocus` to serialize the focus as `FocusSnapshot` kind `engine`. The owning engine's `bag.content` carries the actual detail; the engine also registers `paintMirrorAsActive` / `paintMirrorAsInactive` hooks via `store.registerEngineHooks` so the framework's `applyBagFocus` dispatcher can drive the activation-time focus claim through the engine's own state-preservation order.

---

## Save / restore lifecycle

The framework drives both layers from a small set of well-defined moments. Outside these moments, no capture or restore is happening — the protocol does nothing per-keystroke and reads no React state.

### Capture moments

`CardHost` calls registered `onSave` callbacks (and the framework iterates `ComponentStatePreservationRegistry` for `bag.components`) at exactly these moments:

1. **Tab deactivation.** The user switches away from this card to a sibling within the same pane. The card stays mounted; the captured bag is held in DeckManager's in-memory cache and debounced to tugbank.
2. **`saveState` RPC.** Triggered by Swift on app-level events (resign-active, hide). The framework captures every active card's bag in one pass. This is the "before backgrounding" capture.
3. **`beforeunload`.** Browser-level page reload or navigation. DeckManager listens once at construction and iterates every active card's `onSave` synchronously before the page tears down. Idempotent against `reloadPending` / `stateFlushed` so a manual `prepareForReload` followed by a real `beforeunload` doesn't double-save.
4. **Close-before-destroy.** A flush path. Before a card is torn down (close or move to a different pane), the framework captures one last bag so reopen / drop can replay it.
5. **HMR module replacement (dev-only).** `tugdeck/src/hmr-bridge.ts` listens for Vite's `vite:beforeUpdate` event — fired synchronously before any module replacement applies — and triggers `deck.captureAllForTeardown("hmr")`, which is the same iterate-and-save body that `beforeunload` runs. The bag lands in DeckManager's in-memory cache before React Fast Refresh starts remounting components. `import.meta.hot` is `undefined` in production builds, so the entire bridge is dead code in shipped bundles. See [The HMR bridge](#the-hmr-bridge) below.
6. **HMR full reload (dev-only).** Sibling of `beforeunload`. The bridge listens for Vite's `vite:beforeFullReload` and triggers `deck.captureAllForTeardown("hmr-full-reload")`. Defensive — if Vite escalates from incremental HMR to a full page reload, both `vite:beforeFullReload` and `beforeunload` may fire; the second is a no-op via the `reloadPending` / `stateFlushed` guard.
7. **Workspace switch.** The deck is one workspace's arrangement and a switch renders another, so every card in the outgoing workspace is about to unmount. `DeckManager.activateSpace` runs the same iterate-and-save body under the source tag `"space-switch"`, before it parks the outgoing deck and commits the incoming one. **It is not a close**: nothing fires `cardWillBeginDestruction`, so no binding is dropped and no session is signalled — the bags are captured precisely so the cards can come back. [L26] is on point here rather than bypassed: a parked workspace's cards *are* logically continuous, and the answer is that holding every workspace's panes mounted-but-hidden is the cost the design rejects, which makes this the genuinely-unavoidable teardown [L23] exists for.

The capture-phase invariant ([A9], gated by [`smoke-capture-phase-save.test.ts`](../tests/app-test/harness-smoke/smoke-capture-phase-save.test.ts)) is that capture runs **before any DOM mutation** in the same React commit. If a tab switch tears down the outgoing card's DOM and then runs capture, the captured value is empty. The protocol guarantees the inverse: capture runs in `useLayoutEffect` (Rule 3 / [L03]) before the commit phase that would unmount, so the live DOM is always observable when `captureState` / `onSave` fire. The smoke test asserts this at the architecture level so the invariant can never silently regress.

### Restore moments

The framework has two restore mechanisms; each handles a different transition class.

**Content-axis restore** runs through `CardHost`'s registered `onRestore` callback. It fires at exactly these moments:

1. **Cold-boot mount.** First mount of `CardHost` after a process boot, when a previously-saved bag exists for this `cardId`.
2. **Cross-pane move replay.** A card moved between panes is unmounted at the source and re-mounted at the destination; the bag captured at close-before-destroy is replayed on the new `CardHost`.
3. **Tab-close-then-reopen.** Same shape as cross-pane move — a fresh `CardHost` mount with a previously-saved bag.
   A **workspace returning** is this same shape and not moment 1: the card's second mount inside one process run, replaying the bag capture moment 7 wrote. The one-shot `hasAppliedContentRestoreRef` guard is per-`CardHost`-instance, which is what lets the replay fire again.
4. **HMR content-factory remount (dev-only).** When Vite hot-replaces a module that React Fast Refresh handles by remounting just the content factory (CardHost itself stays up), `useCardStatePreservation`'s cleanup-then-mount cycle drives a second `register` call on the same CardHost. CardHost's `registerStatePreservationCallbacks` counts real registrations; the second-or-later real call (carrying `restorePendingRef`) is treated as a remount. The one-shot guard `hasAppliedContentRestoreRef` resets, the `callbacksVersion` bump re-fires the existing restore effects, and `bag.content` replays onto the new tree. The framework-axes restore effect (`bag.scroll`, `bag.formControls`, `bag.regionScroll`, `bag.domSelection`, `bag.focus`) also re-fires on the same version bump. See [The HMR bridge](#the-hmr-bridge) and the corresponding `card-host-hmr-remount.test.tsx` test for end-to-end coverage of this transition.

**Component-axis restore** does not run as an effect. Components read their saved value at render time via the dedicated accessor hooks — see [Restoring saved state at mount](#restoring-saved-state-at-mount) below.

A width change is not on this list, and cannot be: nothing is destroyed, so there is nothing to restore. It gets its own mechanism — see [Resize preservation](#resize-preservation).

Restore does **not** fire on intra-pane tab switch. Tab switches are pure visibility transitions: the inactive card's DOM stays mounted, the user's state stays alive in the live tree, and there is nothing to restore because nothing was destroyed. This is L23 in its strongest form.

### Restoring saved state at mount

The component-axis (`bag.components`) and the inner-scroll axis (`bag.regionScroll`) do not need a post-mount restore effect. Components read their saved value at render time and seed their initial state with it — first paint after restore is already in the saved state.

The contract is one sentence: **user-visible state at first paint after restore equals user-visible state at last save before destruction.** No intermediate frame painted with the `useState` default. No jump from a 0 scrollTop to the saved scrollTop.

Two accessor hooks deliver saved state into the React tree at render time:

- `useSavedComponentState<T>(componentStatePreservationKey)` — returns `bag.components[scopedKey]` or `undefined`. Consumed inside a `useState` initializer.
- `useSavedRegionScroll(scrollKey)` — returns `bag.regionScroll[scrollKey]` or `undefined`. Consumed by imperative renderers (TerminalBlock's virtualized scrollport, FileBlock's CM6 mount) that accept an `initialScrollTop` parameter and write it into the scroller at creation time.

Both hooks subscribe to the deck manager's notify channel via `useSyncExternalStore` per `[L02]`. Today the typical consumption pattern (read inside a `useState` initializer) only consults the value once, so reactivity is a free correctness property — the wiring stays `[L02]`-correct if a future consumer reads outside an initializer.

The canonical pattern for fold-style state (the body-kind fold flag, a popover open state, a toggle):

```tsx
const saved = useSavedComponentState<{ collapsed: boolean }>(
  componentStatePreservationKey,
);
const [collapsed, setCollapsed] = useState(
  () => saved?.collapsed ?? overThreshold,
);

useComponentStatePreservation({
  componentStatePreservationKey,
  captureState: () => ({ collapsed }),
});
```

The canonical pattern for scroll-style state (an inner scrollport whose scrollTop is preserved on the region-scroll axis) is built on the same primitive plus an imperative-renderer parameter:

```tsx
const savedScroll = useSavedRegionScroll(scrollKey);
const initialScrollTopRef = useRef<number | undefined>(savedScroll?.y);
const firstRenderConsumedRef = useRef(false);
const consumeInitialScrollTop = useCallback((): number | undefined => {
  if (firstRenderConsumedRef.current) return undefined;
  firstRenderConsumedRef.current = true;
  return initialScrollTopRef.current;
}, []);

// ...later, at the imperative-renderer call site:
renderTerminal(outer, body, data, getOuter, collapsed, "top", scrollKey,
  consumeInitialScrollTop());
```

The `consumeInitialScrollTop` one-shot keeps the saved value tied to the FIRST creation of the inner scroller. Subsequent rebuilds (collapse-toggle, streaming re-render) pass `undefined` and rely on the anchor-based default. The element-identity-gated `MutationObserver` pass in `card-host.tsx` re-applies the saved bag value to a rebuilt scroller when its element identity changes mid-card-lifetime, so the inner scroll restore stays robust without putting React's render cycle in the loop.

**Why no fallback to a post-mount apply.** The Phase E.7 path attempted to apply saved component state via a registry-observer callback that fired after mount. The fix worked at the data layer but cost the user three-to-five intermediate paints per body kind on cold boot — the default-collapsed state painted, then the saved-expanded state painted, then the inner scroller was recreated at scrollTop=0, then the MutationObserver-driven apply wrote the saved scrollTop. Maker > Reload looked like wild scrolling. The post-mount mechanism cannot coexist with the contract, so it was removed entirely (not retained as a fallback). Every consumer migrates to the synchronous-initializer pattern, or it doesn't use this axis at all.

**Authoring note.** Capture closures (`captureState` / `onSave`) must read from the live source of truth (React state / refs / DOM) at the moment they're called, not from a stale closure captured at hook-defining time — `[L07]`. The hook stores the closure in a ref and re-syncs it on every render so the framework always sees the latest render's state.

### Saving geometry for first-paint accuracy

Phase E.6's anchor-metadata channel gave variable-height virtualized scrollers a content-relative restore target (`meta.anchor = { index, offset }`). Phase E.8 made restore happen at mount time via `useSavedComponentState` / `useSavedRegionScroll`. Phase E.9 closes the gap that remained: the OUTER transcript scrollport still hopped because `TugListView` mounted with an empty `heightIndex`, so the anchor-resolve math on commit 1 returned an estimate, then refined as cells were measured.

The fix: **save the geometry that drives layout, hydrate it before first paint.** The "settle window" Phase E.7's MutationObserver-driven retry loop patched over is fiction — we measured the geometry at save time; we just threw it away. With saved geometry, the first commit's anchor-resolve math is exact, not estimated. No refinement loop in the happy path; the loop stays only as the fallback when saved geometry is absent (pre-E.9 bags, brand-new content).

**Meta schema families.** The `data-tug-scroll-state` JSON channel is opaque on the framework side — `captureRegionScrolls` reads the attribute verbatim into `entry.meta`; `applyRegionScrolls` forwards via `tug-region-scroll-set`. Per-region writers extend the JSON payload; per-region listeners decode. Three families ship today:

```ts
interface RegionScrollMeta {
  // Phase E.6 — cell-relative anchor for variable-height virtualized lists.
  anchor?: { index: number; offset: number };

  // Phase E.9 — per-cell measured heights from heightIndex.snapshot().
  // Hydrated into the live HeightIndex at restore so the anchor-resolve
  // math reads exact heights instead of estimates. Cells render with
  // inline `min-height` from this array; async sub-content fills its
  // destined slot without shifting siblings.
  cellHeights?: number[];

  // Phase E.9 — content-anchored scroll position for code editors (CM6).
  // `number` is the 1-based line number; `offsetPx` is the intra-line
  // pixel offset of the viewport top from the line's top. The substrate
  // dispatches its own scrollIntoView so the saved LINE lands at the
  // viewport top regardless of how the font metric resolves on the
  // new page.
  line?: { number: number; offsetPx: number };

  // Phase E.9 — validation field. Total content height at save time;
  // not consumed at restore today, kept for symmetry and forward-compat
  // cross-version layout checks.
  scrollHeight?: number;
}
```

A writer may carry any combination of the families; listeners ignore keys they don't recognize. Future substrates that need richer meta extend the same way.

**Authoring a new geometry-saving substrate.**

1. On every commit, write `data-tug-scroll-state` with the substrate's geometry payload (in a `useLayoutEffect` or scroll-event listener, depending on the substrate's update granularity).
2. Read `useSavedRegionScroll(scrollKey)` at render time. In a mount `useLayoutEffect`, decode `meta` and hydrate the substrate's internal layout primitives BEFORE the substrate's first-paint-driving effects run.
3. If the substrate has hot fallbacks (anchor-based, line-relative, pixel raw), prefer the richer geometry when present; fall back to pixel `y` for older bags / unrecognized meta.

**Contract.** The first paint after restore reproduces the user-visible state at last save, INCLUDING the layout that made it user-visible. No timer. No opacity mask. No estimated-then-refined hops. `[L23]`.

### What's in `bag` at save time vs. restore time

Both ends see the same shape: a `CardStateBag`. At save time, every axis is populated from the live DOM and the live React tree (`captureFocus(cardRoot)`, walking `data-tug-state-key` for `bag.formControls`, walking `data-tug-scroll-key` for `bag.regionScroll`, calling each registered `captureState()` for `bag.components`, calling the card's `onSave()` for `bag.content`). At restore time, the same bag is replayed onto a freshly-mounted DOM: form controls re-set their `.value` (with a `MutationObserver` re-applying for late mounts), regions re-scroll, the focus snapshot is dispatched through `applyBagFocus` (the single-channel dispatcher) on the active card of the active pane, and the components-axis is replayed in parent-first order via the registry.

---

## Resize preservation

Everything above is keyed to a card being **destroyed and rebuilt** — a cold boot, a cross-pane move, a tab reopen. A width change is neither. The scroller survives it intact and carries its `scrollTop` across untouched, which is exactly the problem: the content that pixel named has re-wrapped out from under it, so a faithfully preserved number now points somewhere else in the document. WebKit implements no CSS scroll anchoring (`overflow-anchor` is unimplemented), so nothing catches this for us.

**The invariant.** *A width change never moves what the reader is looking at.* Concretely:

- Whatever sits at a scroller's **top edge** holds its offset from that top edge, through every intermediate frame of the change — not just at the end. The top edge is the anchor for every card, always; a visible caret does not claim it.
- A scroller **following the bottom** stays following the bottom. It installs no anchor at all — an anchor would disengage the follow to chase a near-bottom position that lands short.
- Content that **scales rather than re-wraps** — an image, a PDF page — holds its fraction, because a fraction is what means the same thing at two scales.
- When there is nothing to anchor to, nothing is written. "We could not find your place" answered by scrolling to the top is worse than the drift the mechanism exists to prevent.

### The episode

A **resize episode** brackets a width gesture. `beginResizeEpisode(frame, durationMs)` walks the pane frame for preservable scrollers and dispatches a cancelable `tug-scroll-preserve-begin` on each; `handle.end()` dispatches `tug-scroll-preserve-end` — to every scroller, claimed ones included. The shape deliberately mirrors the `tug-region-scroll-set` protocol above: a cancelable event first, a framework fallback second.

- **`preventDefault()` claims the scroller.** A surface with real anchor semantics of its own — a virtualized list keyed on cell index, a CodeMirror view keyed on document position, a PDF keyed on page — captures its own anchor and takes responsibility for re-landing it.
- **Everything else is anchored by the module.** The generic anchor finds the deepest box meeting the scroller's top edge that is still *part* of the content, and holds its top. Three kinds of box are skipped, and each of them would otherwise fail silently by resolving to a zero correction on every frame: a wrapper as tall as the whole scroll extent (its top is `-scrollTop` by construction), a `position: sticky` header (glued to the viewport edge by definition), and an `aria-hidden` spacer (a virtualized list's stand-in for rows it is not rendering, whose height changes as those rows are measured).
- **Re-anchored every frame, not frozen and snapped.** A `ResizeObserver` on both the scroller and its content re-lands the anchor on every delivery, so the content is visually still while the frame tweens rather than jumping once at the end.
- **The safety net closes an episode nobody closed.** Background windows suspend `requestAnimationFrame` entirely, so an episode whose end hangs off an animation callback would stall — the wall-clock timer fires `durationMs + RESIZE_EPISODE_SLACK_MS` past the start regardless. Every observer and timer the episode takes it releases ([L27]).
- **The gesture and the reflow do not end together.** A surface whose content settles on its own schedule — a virtualized list re-measuring rows, a document re-laying out — keeps re-landing its anchor for `RESIZE_SETTLE_TAIL_MS` past the episode's end, then lets go. Releasing at `end()` would land the anchor against half-measured geometry and walk away from the rest.

### Raise sites

Every path that changes a card's width opens an episode. There is no fourth path.

| Site | When | Window |
|------|------|--------|
| `deck-canvas.tsx`'s FLIP settle (`arm()`, pre-commit) | Width chords (⌃⌘1/2/3), bullseye in and out, the deck-wide Card Width, any imposition change | The settle duration, scaled by `getTugTiming()` |
| `tug-pane.tsx` — `handleResizeStart` | A drag on any of the eight edge handles, opened at **pointer-down** | Bounded by the user's hand; closed on pointer-up |
| `tug-pane.tsx` — `handleSidebarResizeStart` | A rail drag, which re-widths the band every card rides | Same |

The drag sites open at pointer-down rather than at the move latch because that is the last moment the pre-gesture layout is on screen. A gesture that turns out to be a click closes its episode having changed nothing.

Under reduced motion (`isTugMotionEnabled()` false) no tween runs and the layout snap *is* the settle — episodes still open, and closing them is the whole of the preservation on that path.

### Opting a new scroller in

Two attributes, and they answer different questions:

- **`data-tug-scroll-key`** already puts a scroller on the region-preservation seam for cross-mount restore. It doubles as episode discovery, so a scroller that opted into one is preserved across the other for free.
- **`data-tug-preserve-scroll`** is for a scroller that holds a place worth keeping but owns no cross-mount identity — a CodeMirror view inside a Text card, say, whose save-bag key belongs to whoever mounted it and who may have none to give. Marker only, no value.
- **`data-tug-preserve="fraction"`** marks content that scales rather than re-wraps. Such a scroller holds `scrollTop / maxScrollTop` instead of an element's top edge.

A card that never took over its own scrolling needs no attribute at all: the pane's own content box is discovered whenever it is the thing doing the scrolling.

To claim instead of falling back, listen for `tug-scroll-preserve-begin` on the scroller, `preventDefault()` it *only once you have an anchor* (declining leaves the better of the two available answers in charge), re-land on your own layout signal while it is open, and land once more on `tug-scroll-preserve-end`.

### Files

- [`tugdeck/src/lib/resize-episode.ts`](../tugdeck/src/lib/resize-episode.ts) — the episode, the generic anchor, the anchor arithmetic as pure functions, and `trackElementAnchor` for claimants that want the element anchor as a fallback.
- [`tugdeck/src/lib/cm6-scroll-anchor.ts`](../tugdeck/src/lib/cm6-scroll-anchor.ts) — the CodeMirror plugin: publishes `data-tug-scroll-state` for the save path in line coordinates, and claims the episode on the document *position* under the top edge. A line is right for a reload and too coarse for a re-wrap, since soft wrapping makes a long line's block taller.
- [`tugdeck/src/lib/pdf-layout.ts`](../tugdeck/src/lib/pdf-layout.ts) — `pageAnchorAt` / `scrollTopForPageAnchor`, the page-and-fraction anchor.
- [`tests/app-test/at0430-resize-scroll-preservation.test.ts`](../tests/app-test/at0430-resize-scroll-preservation.test.ts) — the invariant end to end: every raise site, the follow-bottom case, the generic fallback, the document substrate, the PDF, and the `data-scroll-displacements` guard.

---

## The HMR bridge

Vite's HMR is the protocol's fifth and sixth capture moment, scoped to dev-mode only. Three pieces work together; each handles a transition the others can't observe.

### Bridge module — `tugdeck/src/hmr-bridge.ts`

A single named export, `installHmrBridge(deck)`, called once from `main.tsx` after `new DeckManager(...)`. Inside, an early-return guard on `import.meta.hot` (which Vite strips to `undefined` in production) wraps two listener registrations:

- `vite:beforeUpdate` → `deck.captureAllForTeardown("hmr")`
- `vite:beforeFullReload` → `deck.captureAllForTeardown("hmr-full-reload")`

`captureAllForTeardown(reason)` is the same iterate-and-save body that `handleBeforeUnload` calls — `handleBeforeUnload` itself collapses to a one-line delegate. The `reason` parameter only affects the `save-callback` deck-trace tag.

The bridge also calls `import.meta.hot.accept(() => import.meta.hot.invalidate())` so a self-edit forces a full page reload rather than re-running the body, which would accumulate duplicate listeners on each subsequent HMR cycle.

### Framework remount detection — `card-host.tsx`

When React Fast Refresh remounts a content factory whose tree lives inside a CardHost that itself stays mounted, `useCardStatePreservation`'s cleanup-then-mount cycle drives a second `register` call. CardHost's `registerStatePreservationCallbacks` counts real registrations (those carrying `restorePendingRef`) per CardHost instance. The second-or-later real call resets `hasAppliedContentRestoreRef`; the `callbacksVersion` bump re-fires the existing restore effects, replaying `bag.content` and the framework-axis restore (scroll, formControls, regionScroll, domSelection, focus) onto the new tree for non-content cards. `bag.components` doesn't need a re-fire pass — the remounted descendants read their saved values synchronously through `useSavedComponentState` on first render and seed their `useState` initializers with the saved value.

### Substrate-local snapshot — `tugdeck/src/components/tugways/tug-edit.tsx`

The framework path covers true content-factory remounts. It does **not** cover Fast Refresh's "soft refresh" pattern: when Vite hot-replaces a module, Fast Refresh re-runs `useLayoutEffect` cleanups + bodies *for hooks defined in that module's source*, while preserving the React component instance and its `useState` / `useRef` values. `useCardStatePreservation` lives in a different source module than `tug-edit.tsx`, so its effect doesn't re-run, no `register` call lands, and the framework's remount detector sees nothing — yet `tug-edit.tsx`'s mount effect *does* re-run, destroying and recreating the CM6 view.

`TugEdit` covers this gap with a single `useRef<TugTextEditingState | null>` per instance:

```ts
const fastRefreshSnapshotRef = useRef<TugTextEditingState | null>(null);

useLayoutEffect(() => {
  // …construct view…

  if (pendingRestoreRef.current !== null) {
    // framework path (cold-boot, cross-pane move, etc.)
  } else if (fastRefreshSnapshotRef.current !== null) {
    restoreEditState(view, fastRefreshSnapshotRef.current);
    fastRefreshSnapshotRef.current = null;
  }

  return () => {
    if (view.contentDOM.isConnected) {
      try {
        fastRefreshSnapshotRef.current = captureEditState(view);
      } catch {
        fastRefreshSnapshotRef.current = null;
      }
    }
    // …destroy view…
  };
}, []);
```

The framework-driven `pendingRestoreRef` path takes precedence; the snapshot ref is checked only when no framework restore is pending — exactly the case Fast Refresh's soft refresh produces. On a true remount the component instance is gone and so is the ref; the framework bag becomes the source of truth on those paths.

This is **not** a sidecar cache. The earlier prototype was a module-scoped `Map<cardId, …>` that competed with the framework bag; it was rejected for four reasons (two sources of truth, doesn't generalize, hides the contract, fights Fast Refresh's React-state-preservation). The substrate-local `useRef` is fundamentally different: scoped to one component instance, only fires when the framework can't observe the transition, generalizes nothing because nothing else needs it.

Other components with non-React state that can be lost across same-instance effect re-run (a future canvas, video player, WebGL surface, etc.) can adopt the same one-line `useRef` pattern; nothing about it leaks across components.

### Three layers, each handling its own case

| Layer | Mechanism | Triggered by |
|---|---|---|
| Framework bag pipeline | `useCardStatePreservation` ↔ CardHost ↔ deck-manager → tugbank | Cold-boot, cross-pane move, `beforeunload`, `saveState` RPC |
| Framework remount detection | Count-based `register` detector + reset of one-shot guards | True content-factory remount with CardHost staying up |
| Substrate-local snapshot ref | `fastRefreshSnapshotRef` in `TugEdit` (one-line pattern, adoptable by analogous substrates) | React Fast Refresh same-instance effect re-run |

End-to-end manual gating: edit any substrate file in dev, save, watch the editor's typed text + selection survive across Vite's HMR cycle. Automated coverage: `tugdeck/src/__tests__/card-host-hmr-remount.test.tsx` pins the framework remount-detection logic; AT0042 pins the cold-boot end-to-end path; the manual walk on the `tug-edit` gallery card pins the live Fast Refresh round-trip that test infrastructure can't produce faithfully.

---

## Restore ordering and `onContentReady`

A subtle constraint: when a card's `onRestore(bag.content)` mutates React state, the resulting DOM does not exist yet at the moment `onRestore` returns. The hook bridges this with `onContentReady` and `restorePendingRef`:

1. `CardHost` sets `callbacks.restorePendingRef.current = true`.
2. `CardHost` calls `callbacks.onRestore(bag.content, { isActive })`.
3. The card's `onRestore` calls (e.g.) `engine.applySnapshot(state)` — a React state setter.
4. React commits; the child's DOM lands.
5. The hook's no-deps `useLayoutEffect` fires (it runs on every commit), reads `restorePendingRef`, fires `onContentReady` if set, resets the flag.
6. `CardHost`'s post-attach effect, gated on `onContentReady`, applies `bag.scroll`, `bag.formControls`, `bag.regionScroll`, `bag.domSelection`, `bag.focus` — the DOM-authority axes — only after the content has committed.

This is the deterministic alternative to `requestAnimationFrame` (Rule 12, [D78], [D79]). RAF timing relative to React's commit cycle is not a contract; a child-driven `useLayoutEffect` is.

---

## DOM attributes — quick table

For the per-axis contract these attributes participate in, see [card-state-model.md](card-state-model.md). For the protocol behind them — when capture runs, how late-mounting controls are restored, what `bag.formControls` looks like — this section is canonical.

| Attribute | Saved into | Saved fields | Notes |
|-----------|-----------|--------------|-------|
| `data-tug-state-key="<key>"` | `bag.formControls[key]` | `value`, `selectionStart`, `selectionEnd`, `selectionDirection`, `scrollTop`, `scrollLeft` | Native `<input>` / `<textarea>` value preservation. Doubles as the focus key — `FocusSnapshot` kind `form-control` references it. |
| `data-tug-focus-key="<key>"` | (not stored in bag axis) | — | Drives `FocusSnapshot` kind `dom`. Resolved on restore by keyed lookup inside the card root. |
| `data-tug-scroll-key="<key>"` | `bag.regionScroll[key]` | `x`, `y` | Inner scrollable region. Re-applied for late mounts via the same `MutationObserver` as form controls. |
| `data-tug-scroll-state` | `bag.regionScroll[key].meta` | opaque JSON | Optional companion to `data-tug-scroll-key`. Region-defined payload (e.g. `{anchor: {index, offset}}` for `TugListView`) forwarded through the `tug-region-scroll-set` event's `detail.meta`. Framework treats as opaque storage. |
| `data-tug-preserve-scroll` | (not stored in bag axis) | — | Marker only. Opts a scroller into [resize preservation](#resize-preservation) without claiming a cross-mount region identity. |
| `data-tug-preserve="fraction"` | (not stored in bag axis) | — | Marks content that scales rather than re-wraps; such a scroller holds its fractional position across a width change. |
| `data-tug-prompt-input-root` | (engine-owned) | — | Marker attribute. `captureFocus` serializes focus on any descendant as `FocusSnapshot` kind `engine`; the owning engine's `bag.content` carries the real detail and the engine registers `paintMirrorAsActive` hooks via `store.registerEngineHooks` for dispatcher invocation. |

Authors add these attributes; the framework owns capture and replay. There is no second mechanism for any of these axes; if a control wants its state preserved across cold boot, it opts in via one of these attributes (or via `useComponentStatePreservation` for non-DOM-authority state).

---

## `FocusSnapshot` in depth

`FocusSnapshot` is the discriminated-union output of `captureFocus(cardRoot)`. The four kinds correspond to the four classes of focusable element the framework recognizes:

- **`{ kind: "none" }`** — `document.activeElement` is `null`, on `document.body`, on a descendant outside the card root, or on an element that matches none of the opt-in markers. The bag stores no focus (or stores `{ kind: "none" }` explicitly); restore is a no-op.
- **`{ kind: "form-control", componentStatePreservationKey }`** — Focus is on a native form control with `data-tug-state-key`. The same key is the focus key. Restore re-focuses after `bag.formControls[key].value` has been re-applied so the caret lands on the restored content.
- **`{ kind: "dom", focusKey }`** — Focus is on a non-form-control focusable element with `data-tug-focus-key`. Restore looks up the element by attribute value and calls `.focus()`.
- **`{ kind: "engine" }`** — Focus is on a descendant of an element marked with `data-tug-prompt-input-root` or `data-slot="tug-text-editor"`. The owning engine (TugPromptEntry's compound, TugTextEditor's CodeMirror view) manages selection and scroll axes through its own state-preservation channels; the framework's job at restore time is to invoke the engine's registered `paintMirrorAsActive` hook so it can claim focus + global Selection in the engine's correct order.

**Migration.** Pre-Phase-E.11 bags carry `{ kind: "component-owned" }` for what is now `engine`. The deserialization boundary in `settings-api.ts#readCardStates` coerces `"component-owned"` → `"engine"` on read (`coerceFocusSnapshotOnRead`); the two variants are information-preserving — the rename names the semantic relationship to the engine-hook channel introduced in Phase E.11. Bags written post-E.11 only use `"engine"`.

### Capture — what each save site writes

`captureFocus(cardRoot)` runs from the CardHost framework-axis assembler (`card-host.tsx`, the `assembleFrameworkBagRef.current` closure) on every save trigger ([A9c]). The classifier reads `document.activeElement`, walks the marker-attribute precedence (`data-tug-state-key` → `data-tug-focus-key` → engine-owned selectors → `none`), and returns one of the four variants above.

Whether the assembler accepts that snapshot depends on the card's content-ownership:

- **Non-content-owning cards** (`bag.content === undefined` — form-control cards, markdown-view cards, etc.) accept every variant. `captureFocus` is the sole focus authority for these cards.
- **Content-owning + engine cards** (`bag.content !== undefined` — every session card is one) have **one text-entry surface**: the engine's editor (`tug-prompt-entry` for a session card). A session card carries no `data-tug-focus-key` / `data-tug-state-key` element of its own, so `captureFocus` only ever returns `engine` or `none` for it — and the assembler leaves `bag.focus` absent in both cases. On restore, `applyBagFocus`'s resolver finds no framework-axis snapshot but an engine-managed card, and routes to the engine resolution. The resolver covers the engine case from the registry tag rather than from the bag; there are no transient in-card framework-axis targets to preserve.

When the save fires for an INACTIVE card (focus has moved to a sibling card or off-document — common during `visibilitychange`, `beforeunload`, or a debounced save while the user edits elsewhere), `captureFocus` would return `{ kind: "none" }`. The assembler forwards the previously-saved focus instead, subject to the same kind restriction for content-owning cards. The rule is "an internal save must not destroy a user-visible axis just because focus is momentarily elsewhere" ([L23]).

---

## Focus dispatch model

Phase E.11 retired the four-claimant focus model (`transferFocusForActivation` focus-element, engine `onCardActivated`, macrotask `cardDidActivate` delegate, CardHost cold-boot `applyFocusSnapshot`) and replaced it with a single-channel dispatcher. All focus-claim paths read `bag.focus` through one resolver and dispatch through one writer.

### The dispatcher: `resolveBagFocus` + `applyBagFocus`

`resolveBagFocus(cardId, store): BagFocusResolution` is the pure read half. It consults the bag, the registered card-host root, the engine-hook registry, and the live DOM, and returns one of six variants:

- **`framework`** — concrete focusable element resolved from `bag.focus.kind === "dom" | "form-control"`. The dispatcher calls `el.focus()`, unless the element is already `document.activeElement` — see the idempotency guard below. Reachable only by non-engine framework-axis cards (form-control cards, etc.) — a content-owning + engine card has one text-entry surface and resolves to `engine` / `deferred-engine`, never here.
- **`engine`** — the card is engine-managed and the engine has registered hooks. The dispatcher will invoke `store.invokeEnginePaintMirrorAsActive(cardId)`.
- **`default-focus`** — DOM-authority card with no usable saved focus snapshot. The dispatcher walks `DEFAULT_FOCUS_SELECTORS` via `traceApplyDefaultFocus`.
- **`deferred-dom`** — the bag names a framework-axis target whose element is not in the DOM at dispatch time. The dispatcher returns `"deferred"`. Nothing retries it: the one-shot callers accept `"deferred"` as a graceful no-focus outcome, and CardHost's cold-boot RESTORE does not retry focus. Reachable only by non-engine framework-axis cards.
- **`deferred-engine`** — engine-managed card whose engine has not yet registered hooks (dev's editor mounts late after `feedsReady`). The dispatcher returns `"deferred"`; CardHost's `subscribeEngineHooksChange` listener re-fires `applyBagFocus` when the engine registers. This is the **one** late-mount focus retry path.
- **`none`** — nothing to focus. Bag absent, no host root, or `kind: "none"`. The dispatcher returns `"applied"` (idempotent no-op).

`applyBagFocus(cardId, store, options?): "applied" | "deferred"` is the impure writer. It calls `resolveBagFocus`, performs the resolved side effect, and returns the result. Callers that need retry orchestration (CardHost, for the `deferred-engine` path) act on `"deferred"`; one-shot callers (transferFocusForActivation, transferFocusAfterMove, reactivateCurrentFocusDestination) accept whichever result the dispatcher returns and continue.

### The idempotency guard

`applyBagFocus`'s `framework` branch yields when the resolved element is already `document.activeElement` — it records the trace event and returns `"applied"` without re-calling `.focus()`. Re-calling `.focus()` on the already-focused element is not a no-op in WebKit during a mount commit: it can interfere with React reconciliation's focus-restoration heuristics and drop focus to body. The guard is cheap defensive insurance; it has no special "precedence" semantics. The guard does not apply to `engine` resolutions — engine hooks (`paintMirrorAsActive`) are internally idempotent against an already-painted active state.

### Activation dispatch sites

Four production sites drive `applyBagFocus`:

- **`transferFocusForActivation`** in `focus-transfer.ts` — intra-pane tab switches (`tug-pane#performSelectCard`), cross-pane activations (the gesture interpreter, via `pane-focus-controller`), tab-close handoffs (`deck-manager#_removeCard` / `_closePane`), runtime chain actions wrapping `activateCard` (action-dispatch.ts `focus-pane`, deck-canvas.tsx `show-component-gallery`). Save outgoing, commit mutation via `flushSync`, gate via `FocusManager.mayClaimActivationFocus`, dispatch.
- **`transferFocusAfterMove`** in `focus-transfer.ts` — cross-pane drag drops (`deck-manager#_detachCard` / `_moveCardToPane`) after the React-visible re-parent has committed.
- **`reactivateCurrentFocusDestination`** in `focus-transfer.ts` — installed as a `window.focus` listener in `deck-manager.ts`. Fires on cmd-tab return / app become-active. Calls `applyBagFocus` with `preventScroll: true` ([L23] — preserve user-visible scroll).
- **CardHost cold-boot RESTORE** in `card-host.tsx` — `useLayoutEffect` at mount. Calls `applyBagFocus` (one-shot) against the active card of the active pane ([D10] Option B gate). Owns the late-mount retry for `deferred-engine` via the `subscribeEngineHooksChange` listener — the one late-mount focus path.

Boot sites (`_seedDeckState`, initial-focused-card restore) stay raw — `applyBagFocus` would resolve `none` at boot (no host root yet); CardHost's cold-boot RESTORE is the real claim path. See D9b for the runtime-vs-boot site split.

### Engine hook channel

Engines register `paintMirrorAsActive` / `paintMirrorAsInactive` hooks via `store.registerEngineHooks(cardId, hooks)`. The framework invokes them through `store.invokeEnginePaintMirrorAsActive(cardId)` / `store.invokeEnginePaintMirrorAsInactive(cardId)` — Phase E.11 D1: the engine is a callable, not an autonomous claimant.

Engines that register hooks:

- **TugTextEditor** (used by gallery-text-editor) — registers in its `useLayoutEffect` keyed on `[cardId]`. The hook calls `paintMirrorAsActiveImpl(view)`.
- **TugPromptEntry** (used by session-card, gallery-prompt-entry) — registers in its `useLayoutEffect` keyed on `[cardIdForTrace]`. The hook reads `pendingActivationDraftRef.current` (set by `onRestore` during cold-boot for the inactive-mount case so the engine's scroll-axes write lands against the live post-activation viewport) and calls `editor.paintMirrorAsActive(pending ?? undefined)`.

Engines no longer call `paintMirrorAsActive` autonomously from `useCardStatePreservation.onCardActivated` or the `isActive` branch of `onRestore`. Those callbacks are retained for non-focus axes (deactivation-time scroll snapshot, engine-internal state restore via `restoreEditState`).

### Late-mount settle

The user's saved focus target may not be in the DOM at the moment of activation. There is exactly **one** late-mount focus retry path: `deferred-engine`.

- **`deferred-engine`**: the engine hasn't registered its hooks yet. dev's editor gates on `feedsReady`, and on the very first commit the editor's `useLayoutEffect` runs after CardHost's RESTORE `useLayoutEffect`. CardHost's `subscribeEngineHooksChange` listener bumps a local `engineHooksVersion` state; the RESTORE effect's dep array includes it, so a late-mounting engine's `registerEngineHooks` re-fires the effect — `applyBagFocus` now resolves `engine` (vs. the prior `deferred-engine`) and invokes the hook. Event-driven (store-channel listener), not timer-driven — [L05] compliance.
- **`deferred-dom`**: a framework-axis target that is not in the DOM at dispatch time. This is **not** retried for focus. The one-shot callers treat `"deferred"` as a graceful no-focus outcome, and CardHost's cold-boot RESTORE makes a single `applyBagFocus` call with no focus retry. (Phase E.12 retired the `deferred-dom` MutationObserver focus-retry branch when per-block Find was removed — a content-owning + engine card has one text-entry surface, so no framework-axis target inside it late-mounts.)

CardHost's RESTORE-effect MutationObserver still exists, but its duties are **region-scroll** (`data-tug-scroll-key` regions) and **DOM-selection** late-mount restore — not focus.

### Cross-references

The four activation sites all converge on `applyBagFocus`; the dispatcher's `bag.focus` precondition serves them uniformly. The cold-boot RESTORE adds the retry mechanism on top of the same dispatcher.

---

## `CardStateBag` in depth

`CardStateBag` is a flat object: every member is optional and every member is independent. Adding a new axis is additive — a new `bag.X` field, a new capture step, a new restore step — and never disturbs existing axes.

| Axis | Field | Source at capture |
|------|-------|-------------------|
| Outer scroll | `scroll` | `hostContentEl.scrollLeft` / `scrollTop` |
| Card content | `content` | `useCardStatePreservation` callbacks' `onSave()` |
| Form controls | `formControls` | Walk `data-tug-state-key` inside the card root |
| Region scroll | `regionScroll` | Walk `data-tug-scroll-key` inside the card root. Each entry is `{ x, y, meta? }` — `meta` carries an optional opaque JSON payload from a `data-tug-scroll-state` attribute, used by variable-height virtualized lists to anchor on a cell index + offset rather than raw pixels. |
| DOM selection | `domSelection` | `selectionGuard.getCardRange(cardId)` |
| Focus | `focus` | `captureFocus(cardRoot)` |
| Components | `components` | Iterate `ComponentStatePreservationRegistry` parent-first |

Axes compose: a card with a `useCardStatePreservation` engine, three opt-in `useComponentStatePreservation` controls, two `data-tug-state-key` form controls, one `data-tug-scroll-key` region, and an active selection produces a bag with all seven axes populated. None of them know about the others; the framework writes each axis from a distinct source.

---

## Authoring rules

**Opt in for uncontrolled state.** Native form controls, `tug-markdown-view`'s scroll position, an accordion's open-section index — any state where the source of truth is the DOM or a `useState` inside the component itself. Use `data-tug-state-key` for the form-control case; use `useComponentStatePreservation` otherwise.

**Do not opt in for controlled state.** When a parent component re-renders on every keystroke and passes `value` down as a prop, the parent's state pipeline is already preserving the value — opting into the protocol would be a second source of truth and would race the prop. The same applies to any state that lives in tugbank-backed app-wide stores (theme, layout) — those are preserved by their own persistence path and have no place in the per-card bag.

**Pick keys for uniqueness within the card subtree.** `componentStatePreservationKey`, `data-tug-state-key`, `data-tug-focus-key`, `data-tug-scroll-key` all share the same uniqueness contract: unique within the card. The card is the natural scope because every preservation axis is per-card. Composite components that embed other opt-in components should wrap their subtree in `<ComponentStatePreservationScope prefix="...">`; the prefix is automatically prepended to nested keys, so a checkbox at `theme/dark-mode` inside a `theme`-prefixed scope inside a `settings`-prefixed scope ends up at `settings/theme/dark-mode` in `bag.components` and cannot collide with another card's `dark-mode` checkbox.

**Capture must be synchronous and serializable.** `captureState` and `onSave` are called inside `useLayoutEffect` cleanup or inside a synchronous teardown path; they must return a JSON-serializable value and must not return a Promise. The framework reads `captureRef.current()` at harvest time. If a component's true state is async (e.g. an in-flight network response), capture only what's already settled.

**Restore must tolerate unknown payload shapes.** Card-content code evolves; an old bag pulled out of tugbank may carry a payload shape the current code doesn't recognize. The mount-time consumer of `useSavedComponentState` should narrow defensively (`typeof saved === "boolean"`, `Array.isArray(saved)`) inside its `useState` initializer and fall back to the default. The card-level `onRestore` callback should narrow the same way. Orphan keys in `bag.components` whose components no longer exist in the card are dropped by the framework ([D13] / Q5).

---

## The app-tests that gate this protocol

Each of these pins one transition or one component-roster axis of [A9]. They are listed here by file, because the file is the durable reference — there is no AT-tag catalog (see [app-test-harness.md](app-test-harness.md#atnnnn-slugtestts--at-numbered-scenarios)).

| Test | Gate |
|------|------|
| [`at0001-tab-switch-fc`](../tests/app-test/at0001-tab-switch-fc.test.ts) | Intra-pane tab switch — FC caret round-trip |
| [`at0004-app-resign-return`](../tests/app-test/at0004-app-resign-return.test.ts) | App resign → become-active focus restore |
| [`at0006-cross-pane-drag`](../tests/app-test/at0006-cross-pane-drag.test.ts) | Cross-pane move — focus restore |
| [`at0010-markdown-selection`](../tests/app-test/at0010-markdown-selection.test.ts) | Markdown-view copy-selection persistence |
| [`at0010-cold-boot-selection`](../tests/app-test/at0010-cold-boot-selection.test.ts) | The same selection across a full process restart |
| [`at0014-scroll-persistence`](../tests/app-test/at0014-scroll-persistence.test.ts) | Scroll persistence across activation paths |
| [`at0014-cold-boot-scroll`](../tests/app-test/at0014-cold-boot-scroll.test.ts) | Region-scroll restore across a full process restart |
| [`at0017-savestate-rpc-parity`](../tests/app-test/at0017-savestate-rpc-parity.test.ts) | `saveState` RPC captures the same axes as the will-phase save |
| [`at0024-prompt-state-roundtrip`](../tests/app-test/at0024-prompt-state-roundtrip.test.ts) | The foundational round-trip matrix, reload + relaunch |
| [`at0027-layout-state-persistence`](../tests/app-test/at0027-layout-state-persistence.test.ts) | Layout state — accordion expansion, split-pane divider |
| [`at0037-deck-wide-restore-consistency`](../tests/app-test/at0037-deck-wide-restore-consistency.test.ts) | Multi-card restore preserves the active/inactive invariants |
| [`at0430-resize-scroll-preservation`](../tests/app-test/at0430-resize-scroll-preservation.test.ts) | A width change never moves what the reader is looking at |

The EM-flavored halves of several of these (tab switch, cross-pane move, inactive mount) were retired on 2026-08-11 — they asserted the same orchestrator contract as their FC counterparts, differing only in which component reacquired focus. [`at0032-em-cold-boot-selection`](../tests/app-test/at0032-em-cold-boot-selection.test.ts) is kept as the EM representative, on the restore path where a break would be silent.

The capture-phase invariant itself is gated by [`smoke-capture-phase-save.test.ts`](../tests/app-test/harness-smoke/smoke-capture-phase-save.test.ts) — the architecture-level smoke test that asserts capture runs before any DOM mutation in the same commit.

---

## Files

Primary sources — the files that define the protocol's exported identifiers. Look here when you need to see the actual implementation.

- [`tugdeck/src/components/tugways/use-card-state-preservation.tsx`](../tugdeck/src/components/tugways/use-card-state-preservation.tsx) — `useCardStatePreservation` hook; `CardStatePreservationContext`, `CardStatePreservationContextValue`, `CardStatePreservationCallbacks` types; the `onCardActivated` / `onSave` / `onRestore` callback shapes.
- [`tugdeck/src/components/tugways/use-component-state-preservation.tsx`](../tugdeck/src/components/tugways/use-component-state-preservation.tsx) — `useComponentStatePreservation` hook; `ComponentStatePreservationScope` provider; `useComponentStatePreservationScopePrefix` accessor.
- [`tugdeck/src/components/tugways/component-state-preservation-registry.ts`](../tugdeck/src/components/tugways/component-state-preservation-registry.ts) — `ComponentStatePreservationRegistry` class; parent-first iteration semantics; per-card lifecycle.
- [`tugdeck/src/layout-tree.ts`](../tugdeck/src/layout-tree.ts) — `CardStateBag`, `FocusSnapshot`, `FormControlSnapshot`, `RegionScrollSnapshot`, `DomSelectionSnapshot` type definitions.

Secondary sources — where the protocol is wired up in practice.

- [`tugdeck/src/components/chrome/card-host.tsx`](../tugdeck/src/components/chrome/card-host.tsx) — `captureFocus`, the `registerStatePreservationCallbacks` plumbing (including the count-based remount detector), the post-attach effect that orders DOM-authority restore after `onContentReady`, the one-shot cold-boot RESTORE call to `applyBagFocus`, the RESTORE-effect MutationObserver (region-scroll + DOM-selection late-mount restore), and the `callbacksVersion` + `engineHooksVersion` deps across the framework-axes / content-axis / components-axis / engine-hook-change restore effects.
- [`tugdeck/src/focus-transfer.ts`](../tugdeck/src/focus-transfer.ts) — the single-channel dispatcher: `resolveBagFocus` (pure) + `applyBagFocus` (impure, with the framework-branch idempotency guard), `transferFocusForActivation` / `transferFocusAfterMove` / `reactivateCurrentFocusDestination` entry points.
- [`tugdeck/src/deck-manager.ts`](../tugdeck/src/deck-manager.ts) — Per-card `CardStateBag` cache; activation and deactivation callback channels (`registerActivationCallback`, `invokeActivationCallback`, `registerDeactivationCallback`); `saveState` RPC entry point; the public `captureAllForTeardown(reason)` entry point shared by `beforeunload` and the HMR bridge.
- [`tugdeck/src/hmr-bridge.ts`](../tugdeck/src/hmr-bridge.ts) — Dev-only `installHmrBridge(deck)`; routes Vite's `vite:beforeUpdate` and `vite:beforeFullReload` events into `deck.captureAllForTeardown(reason)`.
- [`tugdeck/src/components/tugways/tug-edit.tsx`](../tugdeck/src/components/tugways/tug-edit.tsx) — Per-instance `fastRefreshSnapshotRef` mount-effect snapshot/replay, covering Fast Refresh's same-instance effect re-run case the framework signal can't observe.
- [`tugdeck/src/__tests__/card-host-hmr-remount.test.tsx`](../tugdeck/src/__tests__/card-host-hmr-remount.test.tsx) — CardHost integration test pinning the count-based remount detector (content + components axes round-trip across simulated remount, cold-boot guard preserved, multi-cycle stability).
- [`tests/app-test/harness-smoke/smoke-capture-phase-save.test.ts`](../tests/app-test/harness-smoke/smoke-capture-phase-save.test.ts) — Architecture-level smoke test gating the capture-phase invariant.

---

## Cross-Links

- [card-state-model.md](card-state-model.md) — The per-axis contract (focus, scroll, form-control value, selection). This doc describes the mechanism; that doc describes what each axis means to authors.
- [lifecycle-delegates.md](lifecycle-delegates.md) — The deck-level `TugCardDelegate` event pipe (`cardWillActivate` / `cardDidActivate` / etc.). The preservation-layer callbacks (`onCardActivated`, `onSave`, `onRestore`) ride atop this pipe — when a `cardWillDeactivate` lifecycle moment fires for card A and `cardWillActivate` fires for card B, the framework dispatches `onCardWillDeactivate` on A's preservation record and (after restore) `onCardActivated` on B's.
- [pane-model.md](pane-model.md) — Deck → Pane → Card hierarchy; cards are the unit of preservation, panes own geometry, the deck owns the per-card bag cache.
- [responder-chain.md](responder-chain.md) — First-responder promotion drives the `isActive` flag in `onRestore`; `applyBagFocus` (Phase E.11) interacts with the responder chain on cold-boot restore.
- [app-test-harness.md](app-test-harness.md) — The harness that runs the tests listed above, and the naming rule for `at{NNNN}` files.
- [Vite HMR API](https://vitejs.dev/guide/api-hmr.html) — `import.meta.hot.on` events, including `vite:beforeUpdate` and `vite:beforeFullReload`, which the bridge module subscribes to.
- [tuglaws.md](tuglaws.md) — [L23] (state preservation across bookkeeping operations); [L09] / [L10] (Pane vs. Card responsibilities); [L03] (`useLayoutEffect` for registrations).
- [design-decisions.md](design-decisions.md) — [D13] (Component State Preservation Protocol), [D49] (per-tab state bag), [D50] (`useCardStatePreservation` hook), [D78] (child-driven ready callback), [D79] (no `requestAnimationFrame` for state-commit-dependent ops).
