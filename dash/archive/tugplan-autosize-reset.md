# TugSplitPane auto-size + persistence reset

**Status:** Post-mortem and plan, pre-implementation. The current implementation on main has accumulated complexity from a dozen iterations, each chasing a specific bug without revisiting root assumptions. Two symptoms are still broken (live-drag direction inversion; post-reload 1–2px hop). Rather than patch again, this plan catalogs what we learned, strips everything back to primitives, and specifies a cleaner API layer.

---

## What we were trying to do

Three user-visible behaviors:

1. **Manual sash resize persists.** Drag sash → size saved → reload restores exactly.
2. **Content-driven grow.** Typing into a panel's content (editor) grows the panel toward `maxSize` without saving anything.
3. **Snap back on empty.** When content clears (submit), panel snaps instantly to the user's last manually-dragged position.

Plus a non-negotiable: the auto-size path must not contaminate the saved size.

---

## Lessons from the failed iterations

### L1. react-resizable-panels' callbacks fire on two different clocks

- `onLayoutChanged` fires **synchronously** from the library's store subscription, which is triggered synchronously by both `panel.resize()` and pointerup-after-drag.
- `onResize` fires **asynchronously** from the library's own `ResizeObserver` on each panel element (post-DOM-commit, at the next RO delivery tick).

Every echo-detection scheme we built (counter, expected-size match, timestamp) was fragile because we were asking the library to tell us "was this from me or from the user" across the async boundary. The library doesn't expose a clean signal for this.

**Consequence:** any bookkeeping that depends on matching our own writes against incoming notifications is doomed to corner-case leaks.

### L2. `panel.getSize()` mixes store values with DOM values

- `asPercentage` comes from the library's store (updated synchronously by `panel.resize()`).
- `inPixels` comes from `element.offsetHeight` (updated asynchronously by React commit).

Mid-commit, these disagree. Any math that combines them (we had `userSetPx = (userSetPct / currentPct) * currentPx`) produces wrong answers. That caused the "pane jumps while typing" bug.

**Consequence:** never mix `asPercentage` with `inPixels` in the same calculation. Use DOM reads only, from a single snapshot, or library-store reads only — never both.

### L3. DOM-target hit detection doesn't match the library's coordinate hit detection

- Library: coordinate-based, expands hit region to a 10px minimum (`resizeTargetMinimumSize`).
- Our pointer tracking: `target.closest('.tug-split-sash')`.

When we collapsed the sash hit area to 3px (for visual reasons), the library still caught drags (via the 10px expansion) but our target check missed. Drags visibly worked but `userDragActive` never flipped → no persistence.

**Consequence:** if we attempt our own pointer-based drag tracking, it must use the same coordinate-based detection as the library or use a wider hit target. There's no "in-between" state that's correct.

### L4. Library's `preventDefault` on sash pointerdown

At capture phase, the library's own handler calls `preventDefault()` on sash clicks. A document-level listener that bails on `defaultPrevented` is neutered.

### L5. CSS transition on `flex-grow` fights the library's RO sampling

The library's RO samples `offsetHeight` every frame while a CSS transition is interpolating. `onResize` fires continuously with intermediate values. Echo detection gets confused; drag responsiveness suffers because the transition applies to user drags too.

**Consequence:** no CSS animation on the panel's size property. If we want motion on snap-back, we'd have to do it via an imperative frame loop driven by `panel.resize()` calls — but that couples us to the library's async RO sampling in the same way. The simplest answer is no animation.

### L6. Tugbank is always warm by the time React mounts

`main.tsx` line 63–66:
```ts
await Promise.all([
  tugbankClient.ready(),
  initTugmark({ module_or_path: wasmUrl }),
]);
```

The entire "cold cache race" scenario — where `storedLayout` transitions from `null` to a real layout post-mount, and the library's mount-time `defaultLayout` prop can't be re-applied — **does not occur in this codebase**. The imperative `setLayout` + `reseedEpoch` machinery I built is solving a phantom problem. Worse, it's what causes the mid-drag inversion (cache updates from our own PUT echo back post-mount, `useEffect` fires `setLayout`, snap visible) and the post-reload 1–2px hop (DOM-measured percentage differs from stored percentage by rounding, `setLayout` re-applies exact stored, library writes, visible shift).

**This is the biggest single lesson.** Every time I added complexity "to handle the mount race," I was adding a bug surface to handle a case that main.tsx already guarantees doesn't happen.

### L7. Flex chains don't automatically propagate `scrollHeight`

The editor's `flex: 1; overflow-y: auto` means its ancestors' `scrollHeight` equals `clientHeight`. Content doesn't "push up" through the chain. To observe content-driven height, the observer must read the overflow-auto element's `scrollHeight` directly — or the flex chain must be restructured (which we tried once and reverted because it broke styling).

### L8. `data-empty` is the only reliable "content cleared" signal

The editor's `overflow-y: auto` clamps `scrollHeight` to `clientHeight` when content fits. We can't distinguish "content shrunk to fit allocation" from "content exactly fills allocation" via `scrollHeight` alone. We CAN detect "content fully cleared" via `data-empty="true"` on the editor (the engine maintains this). So snap-back is triggered only by the explicit empty signal, not by content reduction generally.

### L9. React strict effect ordering matters for observer installation

`useLayoutEffect` runs child-first. The library's `useEffect` (where it registers its own RO / pointer listeners) runs on a separate pass. We can't reliably assume the library's ref handles are populated at the moment our `useLayoutEffect` runs; we can assume it for `useEffect`.

### L10. The gallery card's `showHandle={false}` sash-collapse was a bad trade-off

Collapsing the sash to 3px to hide a visual stripe broke graspability and caused the DOM-target-vs-coordinate-hit mismatch. The visual stripe can be addressed separately (theme-matched sash background); shrinking the hit target cannot.

---

## Root insight

The complexity spiral came from treating the problem as "synchronize two sources of truth" (ours and the library's). Given L6, we don't have to:

- Tugbank is warm before mount → `defaultLayout` handles all restore.
- Library's `onLayoutChanged` fires synchronously from its store → sync flag reliably distinguishes our writes.
- Drag direction, constraints, and the user-drag-release event are all fully owned by the library.

We only need to add two things:

1. **Prevent our imperative writes from being saved.** One sync flag around `panel.resize()`. `onLayoutChanged` checks it.
2. **Let consumers drive content-based sizing.** An imperative handle on the panel with `requestSize(px)` and `getUserSize(): number`.

That's it. No MO/RO installed at the pane level. No context refs. No counter. No epoch. No pointer event tracking. No percentage math.

---

## Redesigned API

### `TugSplitPane` (container)

No change to external API. Internally simplified:

- `storageKey` persistence: wire `onLayoutChanged` to `putSplitPaneLayout`, gated by a single sync flag.
- Expose a React context with just that flag (so panels can set it around their imperative writes).
- Everything else (orientation, sashes, showHandle, disabled, stored-layout read via useSyncExternalStore) stays as-is.
- Drop: imperative `setLayout` post-mount useEffect, `reseedEpoch`, `prevStoredLayoutRef`, `initialApplyDoneRef`, document-level pointerdown/up listeners, `UserDragContext.activeRef`.

### `TugSplitPanel` (individual panel)

No `autoSize` prop. No scroll-source query. No MO/RO.

Exposes an imperative handle via `ref`:

```tsx
interface TugSplitPanelHandle {
  /**
   * Current panel size in pixels (reads element.offsetHeight; always
   * consistent with other DOM reads in the same synchronous tick).
   */
  getCurrentSize(): number;

  /**
   * The user's last-dragged (or defaultSize-resolved) size in pixels.
   * Returns the size as a fraction of the group's current offsetHeight,
   * resolved fresh from the library's stored layout at call time.
   * Callers use this for snap-back-to-anchor in auto-size flows.
   */
  getUserSize(): number;

  /**
   * Imperatively request a new size in pixels. Goes through the
   * library's `panel.resize()`. The surrounding TugSplitPane's
   * persistence is suppressed for this write via a sync flag.
   * Returns the clamped size the library actually applied.
   */
  requestSize(px: number): number;
}
```

Key properties:

- `requestSize` internally: set sync flag → `panel.resize(px)` → clear flag. Library's `onLayoutChanged` fires synchronously during the call, sees the flag, skips persistence.
- `getUserSize` reads the library's current layout via `groupRef.getLayout()` and converts to px. This is the library's store value — stable across React commits (store is synchronous). Callers should NOT mix this with DOM reads.
- The library's own drag handling is untouched. No pointer tracking on our side.

### Auto-size as a consumer concern

Content-driven sizing moves OUT of TugSplitPane entirely. The consumer (e.g., gallery card, or a hook) wires up its own observers and calls `panelRef.current.requestSize(px)` when needed.

We provide a single optional hook for the common case:

```tsx
/**
 * Grows the panel to fit `source.scrollHeight + chrome` when the
 * source overflows its box; snaps to the user-anchor when the source
 * is empty (`data-empty="true"`). No mid-edit shrinking (scrollHeight
 * clamping makes that ambiguous — see L8).
 *
 * Installs MO on the source's subtree (for typing / paste / data-empty
 * flips) and RO on the panel element (for container rewraps, filtered
 * to inline-size changes only to avoid echo from our own block-size
 * writes).
 */
function useContentDrivenPanelSize(opts: {
  panelRef: RefObject<TugSplitPanelHandle | null>;
  sourceRef: RefObject<HTMLElement | null>;
}): void;
```

The hook is optional. Consumers can roll their own observers + call `requestSize` directly.

**Gallery card usage:**

```tsx
const panelRef = useRef<TugSplitPanelHandle>(null);
const entryDelegateRef = useRef<TugPromptEntryDelegate>(null);

useContentDrivenPanelSize({
  panelRef,
  sourceRef: {
    get current() { return entryDelegateRef.current?.getEditorElement() ?? null; },
  },
});

<TugSplitPanel ref={panelRef} autoSize={false} ...>
  <TugPromptEntry delegateRef={entryDelegateRef} ... />
</TugSplitPanel>
```

The scroll-source DOM attribute (`data-tug-auto-size-scroll-source`) goes away. `TugPromptEntry` exposes a delegate method `getEditorElement()` — that's a clean TypeScript contract, not a cross-component DOM convention.

---

## Why this is simpler

| Concern | Current | Proposed |
|---|---|---|
| Mount-time cache race | 50 lines of setLayout + epoch + guards | doesn't exist (L6) |
| User drag detection | document pointer listeners + sash hit check + preventDefault bypass | library handles it |
| Echo detection | counter OR size-match with async/sync mismatch | one sync flag (onLayoutChanged is sync) |
| Anchor tracking | userSetPctRef + userSetSeededRef + reseedEpochRef + handleResize gating | `groupRef.getLayout()` at call time |
| Shared state | `UserDragContext` with 2 refs | single flag via context, set/cleared by `requestSize` |
| Auto-size logic | inside TugSplitPanel, always on | consumer opts in via hook or direct calls |
| CSS transitions | removed (fought library's RO sampling) | still removed |
| DOM attribute conventions | `data-tug-auto-size-scroll-source` | none |

Line count: current tug-split-pane.tsx is ~800 lines. Proposed version should be under 400.

---

## What we strip

From `tug-split-pane.tsx`:

- `UserDragContext` (replace with single-flag `TugSplitPaneWriteContext`).
- `userDragActiveRef`, `reseedEpochRef` in context.
- Document-level `pointerdown`/`pointerup`/`pointercancel` listeners.
- `groupRef`-based persistence in `onPointerEnd`.
- `prevStoredLayoutRef`, `initialApplyDoneRef`, `useEffect` that applies `setLayout`.
- `handleResize`'s seeding + reseed + drag-gate logic (delete the whole block).
- `userSetPctRef`, `userSetSeededRef`, `lastSeenReseedEpochRef`, `lastWidthRef`.
- `autoSize` prop on `TugSplitPanel`.
- MO + RO install in `useLayoutEffect` inside `TugSplitPanel`.
- `recompute` function (moves to hook).
- Scroll-source `querySelector` logic.
- All the inline comment essays explaining the above (most of them are apologies for the complexity).

From `tug-prompt-input.tsx`:

- `data-tug-auto-size-scroll-source` attribute on the editor.
- Module-docstring paragraph about the scroll-source contract.

Add to `tug-prompt-entry.tsx` (or `tug-prompt-input.tsx` — whichever owns the editor delegate):

- `getEditorElement(): HTMLElement | null` on the existing delegate interface.

From `gallery-prompt-entry.tsx`:

- Revert `autoSize` prop passing (no longer exists).
- Add `useContentDrivenPanelSize` hook call with the delegate's editor element as source.

New file: `tug-content-driven-panel.ts` (or similar) — the hook.

---

## Implementation plan

1. **Write this plan doc** (this file). ← current step
2. **Strip tug-split-pane.tsx to the minimal primitive.** Revert to pre-Track-E shape, plus just the sync-flag context + `TugSplitPanelHandle` imperative API. Verify drag + persistence work. Verify no auto-size anywhere.
3. **Add the content-driven hook** in a new file. Unit-test its formula against a mock panel handle.
4. **Add `getEditorElement()` to the prompt-entry/input delegate** (if not already present).
5. **Wire the gallery card** to use the hook.
6. **Remove** `data-tug-auto-size-scroll-source` from TugPromptInput.
7. **Validate the five user scenarios end to end** (drag saves, reload restores, typing grows, submit snaps, no mid-typing jumps, no drag direction inversion).
8. **Update the roadmap Track E section** to point at this plan's approach.

Each step is a small commit. Total estimated diff: ~400 lines removed, ~150 lines added.

---

## Risks / unresolved questions

- **React StrictMode double-mount**: if the library's internal state is fragile under double-invocation, imperative calls via `requestSize` may behave oddly in dev. Mitigate by making `requestSize` idempotent (checking current size vs target before calling `panel.resize`).
- **HMR state preservation**: in dev, Vite can preserve the library's `mutableState` across hot reloads. A value set by a previous session persists even after code changes. Not a correctness issue in production; it's a dev-experience quirk. Full Cmd-R reload clears.
- **What if a future consumer needs a DIFFERENT kind of auto-size** (e.g., fixed-ratio scaling, not scroll-source driven)? The imperative handle supports it — any consumer hook can drive `requestSize` from any signal. The one hook we ship covers the scroll-source case.
- **Does `groupRef.getLayout()` return percentages or pixels?** Percentages. `getUserSize()` needs to convert to px using the group element's offsetHeight. That's one DOM read at call time; internally consistent.

---

## Decision log

- **Keep no CSS animation on panel sizing.** Already validated as the right call (L5).
- **Don't try to support mount-race.** main.tsx awaits tugbank.ready(); no reason to handle a non-existent case.
- **Push auto-size logic to consumers.** Primitives stay thin, consumers compose. Matches the spirit of the design system.
- **Keep the existing `storageKey` persistence flow.** It works once we stop feeding it imperative writes.
- **Drop the scroll-source DOM attribute.** Use a typed ref via the existing delegate pattern instead.
