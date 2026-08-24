# Pane Activation Listener — Tactical Plan (Step 5.5.c, Commits 0 & 1)

**Scope:** A two-commit sequence that untangles pane focus attribution and
installs the document-level pane-activation listener.

- **Commit 0** — pure refactor. Migrates `data-focused` attribution from
  React rendering (`isFocused` prop + `deselected` state) to a dedicated
  DOM-authority controller module. Zero user-visible change.
- **Commit 1** — builds on the clean foundation. Adds the document-level
  capture-phase `pointerdown` listener that classifies clicks and
  drives pane activation / canvas deselect. Deletes
  `handleFramePointerDown`, `handleStackActivate`, and the dormant
  `handleCanvasPointerDown`. Preserves three nuanced behaviors
  (Cmd-click, close-box, Cmd-resize). Activates the previously-dormant
  canvas-deselect feature.

**Source plan:** [tugplan-tide-card-polish.md §Step 5.5.c](./tugplan-tide-card-polish.md#step-5-5-c),
Commit 1 of the eleven-commit execution plan (now split into 0 + 1 as
noted here).

---

## Why two commits

The pre-flight audit surfaced that the CSS keyed on `[data-focused]`
spans ~20 rules across `chrome.css` and `tug-pane.css` — chrome shadow,
title-bar background, title color, icon color, control-button color
states (rest/hover/active, focused/unfocused), collapsed-state chrome,
and two conditionally-rendered `::after`/`::before` pseudo-elements for
content dimming on unfocused panes.

The original plan's "mask via `data-deselected` attribute" approach
required either:

1. Mirroring every `[data-focused="true"]` rule with a parallel
   `[data-deselected="true"] .tug-pane[data-focused="true"]` override
   (~10 new rules, future-rule-author discipline tax forever), or
2. A token-flip at the deck root re-declaring `--tugx-pane-*-active`
   custom properties to their `-inactive` values (one block, but
   structurally can't handle the pseudo-element rendering difference
   between focused/unfocused — `::after` only renders when
   `[data-focused="false"]`).

Both are workarounds. They accept the category error — that `data-focused`
is the output of a three-input state machine (React state `deselected`,
store `panes` array, per-pane `isFocused` prop) — and paper over it with
CSS rule duplication or token gymnastics.

The untangled answer names the actual concern: **pane focus appearance is
one thing, owned by one authority, expressed in one DOM attribute.** The
authority is a dedicated controller module that reads the store via
`useLayoutEffect` and writes `data-focused` directly. React doesn't
render the attribute; TugPane doesn't have `isFocused`; there's no
separate deselect attribute or React state. The deselect concern
collapses into "set `data-focused="false"` on every pane."

The extensive CSS — all ~20 rules — stays **completely unchanged**. One
small adjustment: replace `[data-focused="false"]` selectors with
`:not([data-focused="true"])` so absent attribute is treated as
unfocused (safe default for the brief window between pane mount and the
controller's first apply).

Because this refactor has no user-visible effect (it eliminates a dead
feature's plumbing and moves a render path; no pixel changes), it's
isolated in Commit 0. Commit 1 then ships the gesture behavior on a
foundation that matches the architecture.

---

## Commit 0 — Migrate `data-focused` attribution to DOM-authority controller

### Scope

- Create `pane-focus-controller.ts` with `usePaneFocusController(deckRootRef)`
  hook: subscribes to the store via `useSyncExternalStore`, applies
  `data-focused` to every `.tug-pane[data-pane-id]` under `deckRootRef`
  via `useLayoutEffect`, writes `"true"` on the active pane and `"false"`
  on others.
- Delete `isFocused` prop from `TugPane`; remove the
  `data-focused={isFocused ? ...}` JSX.
- Delete `const [deselected, setDeselected] = useState(false)` from
  `DeckCanvas`.
- Delete the `focusedStackId` derivation.
- Delete the `useLayoutEffect` that observed `didActivate` to clear
  `deselected` (its responsibility moves into the controller as a
  no-op for now, since `deselected` no longer exists — the controller
  just re-applies on every snapshot change).
- Delete `handleCanvasPointerDown` and the `<div data-testid="deck-canvas-bg" />`
  — the handler is dead code (CSS stacking puts `containerRef` on top
  of the bg div; verified by grep: zero tests exercise `deselected`).
- Update three test fixtures that pass `isFocused` to `TugPane`.
- CSS: change `[data-focused="false"]` selectors to
  `:not([data-focused="true"])` so absent-attribute = unfocused. Five
  selectors across two files.

### Why this exists

`isFocused` + `data-focused={...}` + `deselected` React state combine to
render pane focus appearance via the React tree. L06's test: *does any
non-rendering consumer depend on this state?* Grep confirms: no. The
entire chain is appearance state. L06 says: belongs in DOM, written by
observers, not React.

Dropping the React plumbing has three payoffs:
1. Eliminates React re-renders on every focus change (click-through
   cost: a full DeckCanvas re-render → prop cascade to all TugPanes →
   shallow-prop diff for most → DOM update for the one that changed).
   Replaced by a single DOM attribute write per focus change.
2. Removes the architectural blocker for Commit 1's clean deselect —
   with `data-focused` as a DOM-only attribute, deselect is just
   "write `false` on all panes," no separate attribute needed.
3. Resolves the L06 violation structurally, not with a CSS-rule mirror.

### What this commit does NOT do

- **Does not install any pointerdown listener.** That's Commit 1.
- **Does not change user-visible behavior.** The deselect feature was
  dead before (CSS stacking issue — `deck-canvas-bg` never received
  events), and it's still dormant after. Commit 1 brings it alive.
- **Does not change CSS rule count or structure.** One selector
  tweak (`[data-focused="false"]` → `:not([data-focused="true"])`) is
  the only CSS change. No new rules.
- **Does not touch the activation path.** `store.activateCard` still
  does everything it does today.

### Controller implementation

```
// tugdeck/src/components/chrome/pane-focus-controller.ts

/**
 * usePaneFocusController
 *
 * Sole authority for the `data-focused` DOM attribute on every
 * `.tug-pane[data-pane-id]` element within the deck root.
 *
 * Reads: the store's `activePaneId` (snapshot-reactive via
 * `useSyncExternalStore`) and the deck root ref.
 * Writes: `data-focused="true"` on the active pane, `"false"` on
 * every other pane, in a `useLayoutEffect` that runs after each
 * React commit — so newly-mounted panes (pane add from a store
 * change) get their attribute set before paint.
 *
 * L06: pane focus is appearance state (only consumer is CSS);
 * lives in the DOM, not React.
 * L22: store observer drives direct DOM mutation; we use
 * `useSyncExternalStore` only to react to snapshot changes
 * (which also render the pane DOM nodes themselves via
 * DeckCanvas's useSyncExternalStore), then apply in
 * useLayoutEffect post-commit.
 * L10: controller module owns exactly one responsibility —
 * pane focus authority.
 *
 * Commit 1 extends this hook to install the document-level
 * pointerdown classification listener that drives activation
 * and canvas-deselect; that addition does not change the
 * attribute-authority contract established here.
 */
export function usePaneFocusController(
  deckRootRef: React.RefObject<HTMLDivElement | null>,
): void {
  const store = useDeckManager();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const activePaneId = snapshot.activePaneId ?? null;

  useLayoutEffect(() => {
    const root = deckRootRef.current;
    if (!root) return;
    const panes = root.querySelectorAll<HTMLElement>(
      ".tug-pane[data-pane-id]",
    );
    for (const pane of panes) {
      pane.dataset.focused =
        pane.dataset.paneId === activePaneId ? "true" : "false";
    }
  }, [activePaneId, snapshot, deckRootRef]);
}
```

Notes:

- `useSyncExternalStore` is used purely for reactivity — we need to
  re-apply when `panes` changes (add/remove) and when `activePaneId`
  changes. The snapshot object reference changes on every store
  notify, which makes it a reliable dep. We could narrow the dep to
  `[activePaneId]`, but then pane-add without activation change
  wouldn't retrigger. Including the snapshot ref is defensive and
  cheap.
- No React state is introduced by the controller. No `useState`. No
  `deselected` flag. The future Commit 1 deselect mechanism is a
  transient DOM write, not persistent state — see that commit's
  implementation.
- In Commit 0, the controller doesn't yet need to worry about
  "auto-clear deselect on activation" — because there's no deselect
  to clear. Commit 1 adds that logic, in the same module.

### Why `useSyncExternalStore` here (L22 nuance)

L22: *"`useSyncExternalStore` is for state that React components render.
Store observers are for state that drives direct DOM mutations."*

The snapshot this hook subscribes to **does drive rendering** — DeckCanvas
renders pane DOM nodes from the same snapshot via its own
`useSyncExternalStore` call. The controller's DOM application depends on
those pane nodes existing, so its reactivity must be tied to React's
commit cycle, not arbitrarily earlier. Using `useSyncExternalStore` +
`useLayoutEffect` is L22-compliant here because:
1. No React state is created for appearance purposes (the attribute
   write is a direct DOM mutation in `useLayoutEffect`, not a React
   state update that triggers a re-render).
2. The `useLayoutEffect` runs post-commit, so it sees the reconciled
   DOM (new/removed panes correctly reflected).
3. No round-trip through React's render cycle for the attribute value
   itself — the attribute never enters React's virtual DOM.

Alternative (direct `store.subscribe` in a `useLayoutEffect`) would
race React's commit: our callback could fire before the pane DOM nodes
are reconciled, leaving new panes without attribution until the next
notify. We could `queueMicrotask` our apply to defer after React's
reconciliation, but that's more fragile than letting React's commit
cycle drive us.

### CSS safety upgrade

Current: two mutually-exclusive selectors — `[data-focused="true"]`
and `[data-focused="false"]`. When the attribute is briefly absent
(between pane mount and the first controller apply on that pane —
extremely short window, but observable in theory), neither selector
matches, so no focused/unfocused styling applies; the pane uses base
declarations. For chrome styling this is benign; for the dim-overlay
`::after` that conditionally-renders on unfocused panes, it means the
overlay doesn't render during that window. Minor visual flicker
possible.

Upgrade: replace every `[data-focused="false"]` with
`:not([data-focused="true"])`. Now absent-attribute = unfocused by
default. Safer default state, eliminates the flicker, and expresses
the semantic more honestly ("the attribute is a positive marker; its
absence means the default").

Selectors to change (5 total):

- `chrome.css:43` — `.tug-pane[data-focused="false"]` →
  `.tug-pane:not([data-focused="true"])`
- `chrome.css:47` — `.tug-pane[data-focused="false"]::after` →
  `.tug-pane:not([data-focused="true"])::after`
- `tug-pane.css:260` — icon color (inactive)
- `tug-pane.css:302, 308, 314` — control-button colors (inactive
  rest/hover/active — three related rules)
- `tug-pane.css:367` — `::before` dim desaturation layer
- `tug-pane.css:379` — `::after` dim wash layer

(Actual count may be slightly different; the full list comes from
`rg 'data-focused="false"'` at implementation time.)

### Files to change

**New:**
- `tugdeck/src/components/chrome/pane-focus-controller.ts` (~60 lines
  including module docstring).
- `tugdeck/src/__tests__/pane-focus-controller.test.tsx` (6 tests;
  details below).

**`tugdeck/src/components/chrome/deck-canvas.tsx`:**
- Add `const deckRootRef = useRef<HTMLDivElement | null>(null);`.
- Call `usePaneFocusController(deckRootRef)`.
- Delete `const [deselected, setDeselected] = useState(false);`.
- Delete `const focusedStackId = deselected ? null : ...` (simplifies
  to nothing — `isFocused` prop is gone).
- Delete the `useLayoutEffect(() => store.observeCardDidActivate(null,
  () => setDeselected(false)))` at lines ≈198–206.
- Delete `handleCanvasPointerDown` at lines ≈212–224.
- Delete `isFocused={stackState.id === focusedStackId}` prop on the
  TugPane render at line ≈452.
- Delete the entire `<div data-testid="deck-canvas-bg"
  onPointerDown={handleCanvasPointerDown} style={{position:"absolute",
  inset:0, zIndex:0}} />` at lines ≈392–396.
- Attach `deckRootRef` to the same div currently carrying
  `responderRef` via a merged ref callback (ref identity stable;
  same pattern as `rootRefCallback` in `tug-pane.tsx:1160–1166`).
- Update docstrings that describe `deselected` / `focusedStackId` /
  `handleCanvasPointerDown`.

**`tugdeck/src/components/chrome/tug-pane.tsx`:**
- Delete `isFocused: boolean` from `TugPaneProps` (line 350).
- Delete `isFocused,` from the destructured args (line 394).
- Delete `data-focused={isFocused ? "true" : "false"}` from the
  pane frame's JSX (line 1174).
- Module docstring: remove the "tracks focused state via `isFocused`
  prop" language; reference `pane-focus-controller.ts` for where
  `data-focused` now comes from.

**Tests:**
- `__tests__/selection-model.test.tsx`: remove `isFocused: false,` at
  line 64.
- `__tests__/tug-pane.test.tsx`: remove `isFocused: false,` at line 52.
- `__tests__/observable-props-integration.test.tsx`: remove
  `isFocused={false}` at line 95.

**CSS:**
- Five selectors in `chrome.css` and `tug-pane.css` — change
  `[data-focused="false"]` to `:not([data-focused="true"])`. Full
  list retrieved via `rg 'data-focused="false"'` at implementation
  time.

### Tests for the controller

File: `tugdeck/src/__tests__/pane-focus-controller.test.tsx`.

Test host: a minimal component that renders a `deckRootRef` div
containing a few `.tug-pane[data-pane-id]` fixtures, calls the hook,
and exposes a store mock with `getSnapshot` / `subscribe` /
`activePaneId` control.

1. **T1 — Initial attribution with active pane.** Mount with
   snapshot `{activePaneId: "p1", panes:[p1, p2]}` → `p1`'s div has
   `data-focused="true"`; `p2`'s has `"false"`.
2. **T2 — No active pane.** Snapshot `activePaneId: undefined` → all
   panes have `data-focused="false"`.
3. **T3 — Activation change.** Start with `p1` active; store notify
   changes to `p2` active; both panes have correct attribute on the
   next React commit.
4. **T4 — Pane added.** Snapshot gains a new pane; after commit, the
   new pane has `data-focused="false"` (not undefined/absent).
5. **T5 — Pane removed.** Snapshot loses a pane; no throw, remaining
   panes retain correct attribution.
6. **T6 — Cleanup on unmount.** Unmount; no further store notifies
   cause DOM writes (mount a spy, assert no writes after unmount).

### Verification

- `bun x tsc --noEmit` green (the `TugPaneProps` `isFocused`
  deletion is the compile-time catch).
- `bun test` green — including the 6 new controller tests and all
  existing tests (which should pass unchanged since this commit is a
  pure refactor).
- `bun run audit:tokens lint` green.
- **Manual dev-server walk:**
  - Every pane shows its current focus styling identically to
    before the commit (title bar bg, title color, icon color,
    chrome shadow, dim overlay on unfocused). Pixel-identical is
    the acceptance criterion.
  - Click a pane → focus moves correctly (same behavior as before).
  - Cmd-click a pane → no activation (same as before — the
    `handleFramePointerDown` `metaKey` guard is still in place
    until Commit 1).
  - Scrub through all visual states across multiple themes (brio /
    harmony). Any pixel difference is a regression.

### Risks

- **CSS selector change regression.** Changing `[data-focused="false"]`
  to `:not([data-focused="true"])` is semantically broader — matches
  absent attribute too. All panes get attribution via the controller,
  so absent-attribute should be a non-event. Visually verified in the
  manual walk.
- **Initial-render window.** Between React committing pane DOM and
  the controller's `useLayoutEffect` running, the attribute is
  absent. `:not([data-focused="true"])` handles this. The window is
  sub-frame; no user-observable flicker.
- **React reconciliation clobber.** React doesn't render
  `data-focused` (deleted from JSX), so its reconciler never considers
  the attribute. Controller writes are permanent until the next
  controller write.
- **Strict-mode double-mount.** `useLayoutEffect` runs twice in dev.
  First run applies; cleanup; second run re-applies. Idempotent. No
  leak.

### Execution order (single commit)

1. Create `pane-focus-controller.ts` and `pane-focus-controller.test.tsx`;
   run tests in isolation (tests can run against the controller before
   DeckCanvas is edited).
2. Run `rg 'data-focused="false"'` to enumerate the full list of CSS
   selectors to update.
3. Update CSS: change each `[data-focused="false"]` to
   `:not([data-focused="true"])`.
4. Update `tug-pane.tsx`: remove `isFocused` from props interface,
   destructuring, JSX; update docstring.
5. Update `deck-canvas.tsx`: delete state / derivation / observer /
   handler / bg div / prop; add `deckRootRef`; call controller;
   attach merged ref.
6. Update the three test fixtures.
7. `bun x tsc --noEmit` + `bun test` + `bun run audit:tokens lint`.
8. Manual dev-server walk (pixel-parity check).
9. Commit message cites **L06** (appearance state moves to DOM),
   **L10** (controller owns one responsibility), **L22** (store
   observer drives DOM, not React state).

---

## Commit 1 — Document-level pane activation listener

### Scope

Extend `pane-focus-controller.ts` with a document-level capture-phase
`pointerdown` listener that classifies clicks, drives pane activation,
and activates the previously-dormant canvas-deselect feature. Delete
`handleFramePointerDown` on `.tug-pane` and the `onStackActivated` prop
plumbing. Preserve three nuanced behaviors (Cmd-click, close-box click,
Cmd-resize). Add a positive deck-container gate that prevents clicks in
portaled overlays (menus, sheets, tooltips) from triggering
classification.

Because Commit 0 established DOM-authority for `data-focused`, Commit 1
does NOT introduce any new DOM attributes (`data-deselected` is not
needed). Deselect is expressed as "write `data-focused="false"` on
every pane" — a direct call into a helper shared with Commit 0's
reactive apply.

### Nuanced behaviors that MUST be preserved

#### #1 — Cmd-key held: no activation

Click a pane with ⌘ held → pane does not come forward. Mac convention
for interacting with a background window.

**New implementation:** The listener's first guard after the portal
gate — `if (event.metaKey) return;` — covers every click target
uniformly (content, chrome, resize handles, title bar).

#### #2 — Background card's close-box click: no activation

Click the close box on a background pane → card closes without first
activating the pane.

**New implementation:** The listener checks
`startEl.closest("[data-no-activate]")` as an opt-out. The close
button already carries `data-no-activate` (`tug-pane.tsx:187`). Same
convention `selection-guard.ts:738` uses.

#### #3 — Cmd-held resize-handle click on a background pane: no activation

Resize a background pane with ⌘ held → gesture begins, pane does not
come forward.

**New implementation:** Automatically covered by preservation #1
(metaKey gate fires before classification of which pane is targeted).
The document-level listener runs in capture phase, before the resize
handle's React `onPointerDown`; the resize gesture proceeds normally
in React's bubble phase.

### Listener implementation (extension of the controller from Commit 0)

```
// tugdeck/src/components/chrome/pane-focus-controller.ts (Commit 1 additions)

export function usePaneFocusController(
  deckRootRef: React.RefObject<HTMLDivElement | null>,
): void {
  const store = useDeckManager();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const activePaneId = snapshot.activePaneId ?? null;

  // Commit 0: reactive apply on snapshot changes. Commit 1 adds the
  // deselectedRef read so the gesture layer can suppress
  // snapshot-driven attribution when the user has deselected.
  const deselectedRef = useRef(false);

  // Extract the apply logic so both the reactive path and the
  // imperative path (listener) can call it.
  const applyFocusRef = useRef(() => {});
  applyFocusRef.current = () => {
    const root = deckRootRef.current;
    if (!root) return;
    const focusedPaneId = deselectedRef.current ? null : activePaneId;
    for (const pane of root.querySelectorAll<HTMLElement>(
      ".tug-pane[data-pane-id]",
    )) {
      pane.dataset.focused =
        pane.dataset.paneId === focusedPaneId ? "true" : "false";
    }
  };

  // Reactive apply on every snapshot change.
  useLayoutEffect(() => {
    applyFocusRef.current();
  }, [activePaneId, snapshot]);

  // Auto-clear deselect when any card activates. Fires after the
  // snapshot-driven useLayoutEffect (because the observer callback
  // runs after _flipFirstResponder's commit → notify cycle), so we
  // must re-apply here — the useLayoutEffect above ran with
  // deselectedRef still true.
  useLayoutEffect(() => {
    return store.observeCardDidActivate(null, () => {
      if (deselectedRef.current) {
        deselectedRef.current = false;
        applyFocusRef.current();
      }
    });
  }, [store]);

  // Document-level classification listener.
  // L03: useLayoutEffect, not useEffect — this is a registration
  // pointerdown events depend on. Between paint commit and the
  // first useEffect flush, a click would miss the listener.
  useLayoutEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      const root = deckRootRef.current;
      if (!root) return;

      const target = event.target;
      const startEl =
        target instanceof Element
          ? target
          : target instanceof Node
            ? target.parentElement
            : null;
      if (!startEl) return;

      // Positive deck-container gate. Clicks in portaled overlays
      // (tug-menu, tug-sheet, tug-tooltip, fallback context menu,
      // anything rendered via createPortal to document.body) land
      // outside the deck root. They must not trigger classification.
      if (!root.contains(startEl)) return;

      const paneEl = startEl.closest("[data-pane-id]");

      if (paneEl === null) {
        // Branch B: click inside deck but outside every pane —
        // canvas background. Set the deselect flag and re-apply.
        // metaKey does NOT skip this branch (matches prior
        // handleCanvasPointerDown which had no metaKey check).
        if (!deselectedRef.current) {
          deselectedRef.current = true;
          applyFocusRef.current();
        }
        return;
      }

      // Branch A: click inside a pane — activation path.

      // Preserve #1 and #3: Cmd skips activation.
      if (event.metaKey) return;

      // Preserve #2: data-no-activate opt-out.
      if (startEl.closest("[data-no-activate]")) return;

      const paneId = paneEl.getAttribute("data-pane-id");
      if (paneId === null) return;

      const pane = store.getSnapshot().panes.find((p) => p.id === paneId);
      if (!pane) return;
      store.activateCard(pane.activeCardId);
      // didActivate observer (subscribed above) clears deselectedRef
      // and re-applies. No manual action needed here.
    }

    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, {
        capture: true,
      });
    };
  }, [store, deckRootRef]);
}
```

Notes:

- No `data-deselected` attribute. Deselect is expressed via
  `data-focused="false"` on every pane. This collapses the L06
  question Commit 0 opened.
- No `setDeselected` public API. Deselect is internal to the
  controller module; the only way to trigger it is the listener's
  own classification. Matches the "one module owns the concern"
  principle.
- `applyFocusRef` captures the latest `applyFocus` closure on every
  render (L07 ref-at-event-time). The listener's callback can call
  `applyFocusRef.current()` from any future event without stale
  closures.
- `activateCard` on the already-active card is idempotent via
  `_flipFirstResponder`'s same-bit branch (`deck-manager.ts:262–266`),
  and our didActivate observer's `if (deselectedRef.current)`
  short-circuit avoids redundant DOM writes on repeated same-pane
  clicks.

### Why `useLayoutEffect` for the listener registration

L03: registrations that events depend on run in `useLayoutEffect` so
they're installed before paint, closing the race where a user click
could land between paint and the first `useEffect` flush.

### Ordering with ResponderChainProvider's listener

Both install document-level `pointerdown` capture listeners.
Registration order determines firing order. Subsystems are
independent — chain first-responder bit vs. DeckManager composite
first-responder bit. Correctness is order-agnostic. Documented in
the module docstring; pinned by test case 16.

### Not defeated by `stopImmediatePropagation`

No code in this suite calls `stopImmediatePropagation` on
document-level `pointerdown`. A third-party or future listener
that did so, registered before this one, could suppress
classification. Flagged as known-but-absent adversary in the
docstring.

### Files to change

**Modified (Commit 1):**
- `tugdeck/src/components/chrome/pane-focus-controller.ts` — add the
  classification listener + deselectedRef + applyFocusRef as
  described above.
- `tugdeck/src/__tests__/pane-focus-controller.test.tsx` — add the
  17 new cases described below.
- `tugdeck/src/components/chrome/tug-pane.tsx`:
  - Delete `handleFramePointerDown` (lines 1136–1141).
  - Delete `onPointerDown={handleFramePointerDown}` on `.tug-pane`
    (line 1176).
  - Delete `onStackActivated: (paneId: string) => void` from
    `TugPaneProps` (line 335) and the destructured prop (line 390).
  - In `handleResizeStart` (line 981): delete the metaKey-guarded
    `onStackActivated(id)` block (lines 983–988). **Keep**
    `event.stopPropagation()` (line 990) — it still suppresses
    other React ancestors in the pane subtree. Audit separately
    if needed.
  - Remove `onStackActivated` from `useCallback` dep array (line 1129).
  - Update module docstring (line 10).
- `tugdeck/src/components/chrome/deck-canvas.tsx`:
  - Delete `handleStackActivate` (lines ≈189–196).
  - Delete `onStackActivated={handleStackActivate}` at the `TugPane`
    usage site (line ≈455).
  - Update docstrings at lines 22, 77, 118.
- Three test fixtures (as before for `onStackActivated`):
  - `__tests__/tug-pane.test.tsx`: delete the two T18 cases at
    L119–164 (`describe("TugPane – onStackActivated", ...)`). Also
    remove `onStackActivated: mock(() => {})` at L50.
  - `__tests__/selection-model.test.tsx`: remove
    `onStackActivated: mock(() => {})` at L62.
  - `__tests__/observable-props-integration.test.tsx`: remove
    `onStackActivated={() => {}}` at L93.

**Not touched in Commit 1** (because Commit 0 already handled them):
- `isFocused` / `data-focused` React plumbing — gone from Commit 0.
- `handleCanvasPointerDown` / `deck-canvas-bg` div — gone from
  Commit 0.
- `deselected` React state / `focusedStackId` derivation — gone
  from Commit 0.
- CSS selectors for `[data-focused]` — already upgraded in Commit 0.

### Test cases for Commit 1 (extending the controller test file)

Unit tests, real DOM `PointerEvent`s with `bubbles: true`. Minimal
host renders a `deckRootRef` div with two `[data-pane-id]` panes
and realistic descendants (content, title bar, resize handle, close
button with `data-no-activate`).

1. **Content click activates.** Click `paneB` content →
   `store.activateCard(paneB.activeCardId)` called.
2. **Nested responder still activates the host pane.** Click a
   descendant `data-responder-id="x"` inside `paneB` → pane
   activates.
3. **Title bar click activates.**
4. **Resize handle click activates.**
5. **Cmd-skip on content click (preserves #1).** `metaKey: true` on
   content → `activateCard` NOT called; no DOM write.
6. **Cmd-skip on resize-handle click (preserves #3).** `metaKey: true`
   on resize handle → `activateCard` NOT called.
7. **`data-no-activate` skip (preserves #2).** Click on descendant
   inside `[data-no-activate]` → `activateCard` NOT called.
8. **Empty-deck click activates deselect.** Click inside `deckRoot`
   but outside every `[data-pane-id]` → every pane's
   `data-focused` becomes `"false"`. `activateCard` NOT called.
9. **Deep nested empty-deck click.** Click a leaf several levels
   deep inside `deckRoot` but outside any pane →
   `data-focused="false"` on all panes.
10. **Cmd + empty-deck click still deselects** (metaKey gate is
    activation-only).
11. **Click outside the deck root entirely.** Target attached to
    `document.body` outside `deckRoot` → no `activateCard`, no
    DOM focus write.
12. **Click inside a portaled overlay.** Detached element in
    `document.body` simulating a menu portal with `role="menu"` →
    neither `activateCard` nor DOM focus writes fire. **Core
    regression pin against the portal/overlay bug class.**
13. **Activation clears deselect.** After deselect
    (`data-focused="false"` on all), activate a pane → that pane
    gets `data-focused="true"`, others `"false"` (auto-clear via
    the didActivate observer).
14. **Already-focused pane click is idempotent.** Click `paneA`
    (focused) → `activateCard(paneA.activeCardId)` called; no
    extra `didActivate` events observable via spy. Cites
    `deck-manager.ts:262–266` in a comment so Commit 9's
    refactor preserves the invariant.
15. **Early registration (L03 timing pin).** Mount; synchronously
    dispatch `pointerdown` on a pane → listener handles it.
    Proves `useLayoutEffect` registered before any click lands.
16. **Coexistence with responder chain promotion.** Mount inside a
    real `ResponderChainProvider`; click a nested
    `data-responder-id` inside a background pane → BOTH
    `activateCard` fires AND the responder chain promotes the
    nested responder. Independent subsystems, same pointerdown.
17. **Cleanup on unmount.** Unmount; dispatch pointerdown on a
    pane → `activateCard` not called (listener removed).

(Cases 1–6 of Commit 0's test file remain unchanged. Commit 1
extends the same file with cases 7–23 — a continuous numbering,
or renumber from 1 with "classification" subsection if clearer.)

### Verification

- `bun x tsc --noEmit` + `bun test` + `bun run audit:tokens lint`.
- **Manual dev-server walk (required before commit):**
  - Click background card content → pane activates (focus ring
    moves, z-order bumps).
  - Cmd-click background card content → no activation.
  - Click close box on background card → card closes, pane NOT
    activated first.
  - Click resize handle on background card → pane activates AND
    resize begins.
  - Cmd-click resize handle on background card → no activation,
    resize begins.
  - Click focused pane content → stays focused (idempotent).
  - **New user-visible behavior:** click empty deck canvas
    (between panes, canvas edges) → focused pane loses its focus
    ring. Dormant deselect feature is now live.
  - Cmd-click empty deck canvas → focused pane loses focus ring
    (metaKey gate is activation-only).
  - Click inside an open tug-menu / tug-sheet / tug-tooltip → the
    focused pane keeps its focus ring (portal gate).
  - Open a menu, dismiss it by clicking empty canvas → focus ring
    goes away after menu closes.

### Risks and mitigations

- **New user-visible behavior (empty-canvas deselect).** Previously
  dormant; now live. Named in the commit message as intentional.
  Covered by tests 8–10.
- **Listener registration order vs. ResponderChainProvider.**
  Independent subsystems; order-agnostic. Test 16 pins.
- **Portal-overlay regression** (the pre-audit concern). Closed by
  the positive deck-container gate and test 12.
- **Resize-handle `stopPropagation()`.** Kept as-is. Audit
  separately if needed.
- **Cmd-key click on deeply nested content.** Listener suppresses
  only pane activation. Nested responders' handlers still fire.
  Matches today.
- **`setDeckRef` ref-merge callback stability.** `useCallback` with
  `[responderRef]` deps; `responderRef` is stable; merged callback
  stable; no render thrash.
- **First-paint race.** Closed by `useLayoutEffect` + test 15.
- **Pointer→click z-index ordering invariant.** DeckCanvas's
  existing comment notes that synchronous z-index update on
  pointerdown preserves browser pointer→click sequence. The new
  listener runs synchronously in capture phase; `store.activateCard`
  mutates state synchronously; `useSyncExternalStore` forces sync
  re-render outside React event handlers. Invariant preserved.
  Flagged in the docstring.
- **Right/middle-click activation.** Listener doesn't filter on
  `event.button`; right/middle pointerdowns classify same as
  primary. Matches today's behavior (no `button` check in the old
  handler). Documented in the docstring so future readers don't
  wonder.

### Execution order (single commit)

1. Extend `pane-focus-controller.ts` with `deselectedRef`,
   `applyFocusRef`, didActivate observer subscription, and
   document-level pointerdown listener.
2. Add tests 7–17 (or relabel as 1–11 for classification if the
   plan prefers a fresh describe block) to
   `pane-focus-controller.test.tsx`.
3. In `tug-pane.tsx`: delete `handleFramePointerDown`, the
   `onPointerDown` prop, the `onStackActivated` prop (interface +
   destructuring), the metaKey `onStackActivated` block in
   `handleResizeStart`, the dep-array entry. Update module
   docstring.
4. In `deck-canvas.tsx`: delete `handleStackActivate` and the
   `onStackActivated={handleStackActivate}` prop. Update
   docstrings.
5. Update the three test fixture harnesses that reference
   `onStackActivated`.
6. `bun x tsc --noEmit` + `bun test` + `bun run audit:tokens lint`.
7. Manual dev-server walk through every scenario, including the
   new deselect behavior and the portal test.
8. Tuglaws cross-check, cite in commit message:
   - **L03** `useLayoutEffect` for event-dependent registration.
   - **L06** `data-focused` stays DOM-only; Commit 1 preserves
     the authority established by Commit 0.
   - **L07** ref-at-event-time (`applyFocusRef`, `deckRootRef`,
     `store.getSnapshot` read inside handler).
   - **L10** classification + attribute authority in one module,
     one responsibility.
   - **L11** pane activation as DeckManager-owned state mutation;
     listener is the emitter.
   - **L22** store observer drives direct DOM mutation; no
     round-trip through React state.
   - **L23** pane activation and deselect visual are
     user-observable state, preserved across the refactor.

---

## What this two-commit sequence is NOT

- **Not** a `ResponderChainProvider` listener refactor. Its own
  `useEffect`-vs-`useLayoutEffect` question is a separate concern;
  noted as a follow-up below.
- **Not** a branded-id-types refactor. `CardId` / `PaneId` branded
  types are a separate plan step.
- **Not** the validator extension (Commit 2 of Step 5.5.c).
- **Not** an audit of the resize-handle `stopPropagation()`. Keep
  as-is unless a concrete bug surfaces.

## Follow-ups these commits surface (not blocking)

- **Audit `ResponderChainProvider`'s listener for the same L03 race.**
  Currently uses `useEffect`. Same first-paint-race analysis may
  apply.
- **Consider extending `data-no-activate` semantics** to also
  suppress the deselect branch if a future use case requires a
  "neutral" in-deck element that should neither activate a pane
  nor deselect the active one. Not needed today.
