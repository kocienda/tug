# Targeted Dispatch for Controls

## Problem

Controls (buttons, checkboxes, switches, sliders, choice groups, etc.) currently dispatch actions using `manager.sendToFirstResponder()`, which walks the responder chain starting from the **first responder**. This creates two problems:

### Problem 1: Dispatches miss their handler

`sendToFirstResponder()` walks from the first responder **upward** through `parentId` links. The handler for a control's action is typically on the control's **parent responder** — which may be a sibling or descendant of the first responder, not an ancestor.

Example: the gallery-prompt-input card has this responder tree:

```
DeckCanvas
└── TugCard (card-level responder)
    └── useResponderForm (handles selectValue, setValue)
        ├── TugPromptInput (handles cut/copy/paste/selectAll)
        └── TugChoiceGroup (dispatches selectValue)
```

On fresh launch, DeckCanvas sets the first responder to the card. When the choice group dispatches `selectValue`, the walk goes: card → DeckCanvas → root. It **misses** the `useResponderForm` node because it's below the card in the chain. The control's click silently fails.

### Problem 2: Focus refusal conflicts with dispatch routing

Focus-refusing controls (`data-tug-focus="refuse"`) should not steal keyboard focus from an active editor. We implemented this via `mousedown.preventDefault()`. But the responder chain's `promoteOnPointerDown` handler also runs on click, and its behavior interacts with dispatch:

- If we **skip** promotion for focus-refusing controls: the first responder stays on the editor, but the dispatch walk may not reach the control's handler (same problem as #1 — the handler might not be an ancestor of the editor).
- If we **don't skip** promotion: the first responder changes to the control's parent responder, which fixes dispatch but breaks keyboard shortcuts (⌘C/⌘V no longer route to the editor).

There is no correct behavior for `promoteOnPointerDown` that solves both problems simultaneously, because `sendToFirstResponder()` is the wrong dispatch method for controls.

## Root Cause

All controls use `manager.sendToFirstResponder()` — the nil-targeted form that walks from the first responder. But controls are not menu items or keyboard shortcuts. They have a specific parent responder that handles their action. They should use **targeted dispatch**.

## The Cocoa Model

Cocoa's NSResponder chain has two dispatch forms:

1. **Targeted actions** — `[NSApp sendAction:action to:target from:sender]` where `target` is non-nil. The action goes directly to the target object. Used by controls: `button.target = viewController`. The first responder is irrelevant.

2. **Nil-targeted actions** — `target` is nil. The action walks the responder chain from the first responder upward. Used by menu items and keyboard shortcuts — actions that should go to "whatever the user is working with."

Controls use targeted actions because they have a specific receiver. The receiver is typically the view controller that manages the form the control is in. The control knows its target because it's wired explicitly (in Interface Builder or in code).

Keyboard shortcuts use nil-targeted actions because they should reach the focused component. ⌘C goes to the text editor when the editor is focused, and to the card when the card is focused. The first responder determines the routing.

**Our system already has both forms:**

| Cocoa | Our system | Walks from |
|-------|-----------|-----------|
| Targeted action (`target != nil`) | `manager.sendToTarget(targetId, event)` | The named target node |
| Nil-targeted action (`target == nil`) | `manager.sendToFirstResponder(event)` | The first responder |

The bug: our controls use `sendToFirstResponder` when they should use `sendToTarget`.

## Solution

### Controls discover their parent responder from context

`ResponderParentContext` already provides the nearest ancestor responder ID to every component in the tree. Controls read it via `useContext(ResponderParentContext)` and use it as their dispatch target.

```ts
const parentResponderId = useContext(ResponderParentContext);

// Control dispatches to its parent — targeted, not nil-targeted
manager.sendToTarget(parentResponderId, { action: TUG_ACTIONS.SELECT_VALUE, ... });
```

This is the exact equivalent of Cocoa's `button.target = self` pattern. The parent responder is the target. The first responder is irrelevant.

### Focus refusal becomes simple

With targeted dispatch, focus refusal is purely about **browser focus** — preventing the browser from moving keyboard focus to the control on mousedown. The responder chain's first-responder promotion can happen normally (or not — it doesn't matter, because controls don't use `sendToFirstResponder()`).

The `promoteOnPointerDown` handler goes back to the simple, unconditional version:

```ts
function promoteOnPointerDown(event: PointerEvent): void {
  promoteFromTarget(event.target as Node | null);
}
```

No `isFocusRefusing` check needed for promotion. Focus refusal only affects browser focus (mousedown prevention).

But wait — if promotion happens normally when a button is clicked, the first responder changes from the editor to the button's parent responder. Keyboard shortcuts (⌘C etc.) would then walk from the parent responder, not the editor. Does this break keyboard shortcuts?

Yes — and this is the remaining piece. The solution: **focus-refusing controls should not promote their parent as first responder either.** If the user hasn't clicked inside a new responder that accepts focus, the first responder should stay where it is.

The correct `promoteOnPointerDown`:

```ts
function promoteOnPointerDown(event: PointerEvent): void {
  if (isFocusRefusing(event.target)) return;  // don't change first responder
  promoteFromTarget(event.target as Node | null);
}
```

This is safe because:
- Controls use `sendToTarget` — they don't need the first responder to be set correctly for their dispatches.
- Keyboard shortcuts use `sendToFirstResponder` — they need the first responder to stay on the editor.
- Both are correct when we skip promotion for focus-refusing controls.

### What about the "fresh launch" problem?

On fresh launch, DeckCanvas sets the first responder to the card via `makeFirstResponder`. Controls that use `sendToTarget(parentResponderId)` bypass the first responder entirely — they always reach their parent handler. The "fresh launch" problem disappears because controls never depended on the first responder in the first place.

### Summary of the two dispatch modes

| Dispatch mode | Used by | Method | Walks from | First responder matters? |
|--------------|---------|--------|-----------|------------------------|
| **Targeted** | Controls (buttons, checkboxes, sliders, etc.) | `sendToTarget(parentId, event)` | The parent responder | No |
| **Nil-targeted** | Keyboard shortcuts, menu items | `dispatch(event)` | The first responder | Yes |

## Implementation Plan

### Step 1: Add `useControlDispatch` hook

Create a small hook that controls use instead of calling `manager.sendToFirstResponder()` directly:

```ts
function useControlDispatch(): (event: ActionEvent) => boolean {
  const manager = useResponderChain();
  const parentId = useContext(ResponderParentContext);
  return useCallback((event: ActionEvent) => {
    if (!manager || !parentId) return false;
    return manager.sendToTarget(parentId, event);
  }, [manager, parentId]);
}
```

This encapsulates the "targeted dispatch to parent" pattern. Controls call `sendToTarget(parentId, ...)` instead of `dispatch(...)`. The hook reads the parent responder ID from context — no prop drilling needed.

### Step 2: Migrate controls to `useControlDispatch`

Every control that currently calls `manager.sendToFirstResponder()` switches to the hook. The change per control is mechanical: replace `manager.sendToFirstResponder(event)` with `controlDispatch(event)`.

Controls to migrate:

| Control | File | Current dispatch |
|---------|------|-----------------|
| TugButton (no `target` prop) | `internal/tug-button.tsx` | `manager.sendToFirstResponder(event)` |
| TugCheckbox | `tug-checkbox.tsx` | `manager.sendToFirstResponder(event)` |
| TugSwitch | `tug-switch.tsx` | `manager.sendToFirstResponder(event)` |
| TugSlider | `tug-slider.tsx` | `manager.sendToFirstResponder(event)` |
| TugChoiceGroup | `tug-choice-group.tsx` | `manager.sendToFirstResponder(event)` |
| TugOptionGroup | `tug-option-group.tsx` | `manager.sendToFirstResponder(event)` |
| TugRadioGroup | `tug-radio-group.tsx` | `manager.sendToFirstResponder(event)` |
| TugAccordion | `tug-accordion.tsx` | `manager.sendToFirstResponder(event)` |
| TugTabBar | `tug-tab-bar.tsx` | `manager.sendToFirstResponder(event)` |
| TugValueInput | `tug-value-input.tsx` | `manager.sendToFirstResponder(event)` |

**Note:** TugButton already supports `sendToTarget(target, ...)` when its `target` prop is set. The migration adds the `parentId` fallback when no explicit `target` is provided.

**Note:** TugCard dispatches (`previousTab`, `nextTab`, `jumpToTab`) stay as `manager.sendToFirstResponder()` — the card is a responder dispatching to itself or its ancestors, not a control dispatching to a parent.

**Note:** TugSheet, TugAlert, TugConfirmPopover, TugPopover dispatch for their own internal state management. These are responders, not controls — they stay as `manager.sendToFirstResponder()`.

### Step 3: Simplify `promoteOnPointerDown`

With controls using targeted dispatch, the focus-refusal check for promotion is clean:

```ts
function promoteOnPointerDown(event: PointerEvent): void {
  if (isFocusRefusing(event.target)) return;
  promoteFromTarget(event.target as Node | null);
}
```

This is correct because:
- Controls use `sendToTarget` — first responder is irrelevant for their dispatches
- Keyboard shortcuts use `sendToFirstResponder` — first responder stays on the editor
- Browser focus stays on the editor — `mousedown.preventDefault()` handles that

### Step 4: Verify `canHandle` and `validateAction` for targeted controls

TugButton's enabled/disabled state uses `manager.canHandle(action)` and `manager.validateAction(action)`, which walk from the first responder. For a targeted button, this should walk from the target instead — using `manager.nodeCanHandle(target, action)`.

TugButton already does this when `target` is set. After migration, buttons without an explicit `target` will use the parent responder ID from context. The `canHandle`/`validateAction` calls should also use the parent:

```ts
// Before: walks from first responder
const canHandle = manager.canHandle(action);

// After: walks from parent responder (the actual target)
const canHandle = parentId ? manager.nodeCanHandle(parentId, action) : false;
```

This ensures the button's visual enabled/disabled state reflects whether its **target** (parent responder) can handle the action, not whether the first responder can.

### Step 5: Update docs

Update `tuglaws/responder-chain.md`:
- Document the two dispatch modes (targeted vs nil-targeted)
- Add guidance: "Controls use targeted dispatch. Keyboard shortcuts use nil-targeted dispatch."
- Document the `useControlDispatch` hook

Update `tuglaws/component-authoring.md`:
- In the "Controls dispatch, responders handle" section, show `useControlDispatch` as the standard pattern
- Explain why controls should never use `manager.sendToFirstResponder()` directly

## Files

| File | Change |
|------|--------|
| `use-control-dispatch.ts` | New hook |
| `internal/tug-button.tsx` | Use `parentId` as default target |
| `tug-checkbox.tsx` | Switch to `useControlDispatch` |
| `tug-switch.tsx` | Switch to `useControlDispatch` |
| `tug-slider.tsx` | Switch to `useControlDispatch` |
| `tug-choice-group.tsx` | Switch to `useControlDispatch` |
| `tug-option-group.tsx` | Switch to `useControlDispatch` |
| `tug-radio-group.tsx` | Switch to `useControlDispatch` |
| `tug-accordion.tsx` | Switch to `useControlDispatch` |
| `tug-tab-bar.tsx` | Switch to `useControlDispatch` |
| `tug-value-input.tsx` | Switch to `useControlDispatch` |
| `responder-chain-provider.tsx` | Simplify `promoteOnPointerDown` |
| `tuglaws/responder-chain.md` | Document targeted vs nil-targeted |
| `tuglaws/component-authoring.md` | Update dispatch guidance |
