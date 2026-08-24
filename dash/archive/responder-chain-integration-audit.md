# Responder Chain Integration Audit

**Status:** Drafted during the tug-prompt-input context menu work, when clipboard shortcuts broke because of a first-responder race between the editor and its enclosing card. The immediate bug was patched with a tactical `stopPropagation` in `tug-prompt-input.tsx`, but the root causes are architectural and affect nearly every interactive component in the suite.

**Scope:** `tugdeck/src/components/tugways/tug-*.tsx` and the responder chain plumbing they sit on top of (`responder-chain.ts`, `responder-chain-provider.tsx`, `use-responder.tsx`, `keybinding-map.ts`, `action-dispatch.ts`).

**Governing laws:**
- [L11] *Controls emit actions; responders handle actions.* Controls (buttons, sliders, pickers) are not responder nodes. They dispatch ActionEvents into the chain. Responders receive and handle them.
- [L07] *Every action handler must access current state through refs or stable singletons, never stale closures.*
- [L03] *Use `useLayoutEffect` for registrations that events depend on.*
- [L02] *External state enters React through `useSyncExternalStore` only.*

---

## TL;DR

We have a responder chain infrastructure (`ResponderChainManager`, `useResponder`, `dispatch` / `dispatchForContinuation` / `observeDispatch`, keybinding map), and exactly **two** tug-* components register as responders: `tug-card` and `tug-prompt-input` (the latter only after this audit's work started). Every other interactive control — `tug-button` aside — uses **ad-hoc React callback props** (`onValueChange`, `onCheckedChange`, `onSelect`, `onTabSelect`, `onConfirm`, etc.) and does not participate in the chain at all.

This is a direct L11 violation across ~17 components. It's also the root cause of the stuck-menu, stale-focus, and "keyboard shortcut doesn't reach the editor" bugs we've spent the last several rounds patching — all of which become trivial or disappear entirely once the chain is the single source of truth.

The secondary issue is that the first-responder model, as currently implemented, is fragile: a parent responder (tug-card) overrides any nested responder unconditionally on every `pointerdown`, breaking clipboard shortcuts dispatched through the chain. The current workaround is a `stopPropagation` hack in `tug-prompt-input`. This needs a principled fix: nested responders should win over their ancestors on pointer and keyboard focus events without per-component escape hatches.

---

## Part 1 — Current state of responder-chain integration

### 1.1 Components that use the chain (6 total, 3 tug-*)

| File | How | Notes |
|---|---|---|
| `tug-card.tsx` | `useResponder({ id: cardId, actions: { close, selectAll, previousTab, nextTab, minimize, toggleMenu, find, setProperty } })`. Attaches `handleCardPointerDown` → `manager.makeFirstResponder(cardId)` on every card pointerdown. | The only "complete" responder registration in the tug-* set. Also the source of the override bug — see Part 2.1. |
| `tug-prompt-input.tsx` | Added in this audit's work. Registers `cut`, `copy`, `paste` with a `useId()`-derived responder id. Promotes first responder on editor focus (and defensively in the contextmenu handler and in `handlePointerDown` via `stopPropagation`). | Tactical fix only — see Part 2.1 for why the `stopPropagation` is a workaround. |
| `tug-editor-context-menu.tsx` | Consumer of `useRequiredResponderChain` and `observeDispatch`. Does not register a responder (it's a control, not a handler). Dispatches `{action, phase: "discrete"}` via `dispatchForContinuation`. | Added in this audit's work. Correct by construction after the refactor. |
| `internal/tug-button.tsx` | `useResponderChain()` + `dispatch` or `dispatchTo` when the button is clicked and an `action` prop is set. | The existing "control emits action" pattern. Copy this for other controls. |
| `cards/gallery-*.tsx` | Several gallery cards use `useResponder` to register demo responders for their gallery content. Good reference implementations. | Not user-facing components. |
| `deck-canvas.tsx` | Canvas-level actions: `cycleCard`, `resetLayout`, `showComponentGallery`, `addTabToActiveCard`. Registers as a root responder. | Correct. |

### 1.2 Components that *should* use the chain but don't (17 tug-* controls)

Every one of these is an interactive control. Each currently exposes one or more React callback props (`onValueChange`, `onCheckedChange`, `onSelect`, `onConfirm`, `onOpenChange`, etc.) and fires them directly from within its own event handlers. None dispatch actions through the responder chain. None integrate with `keybinding-map.ts`. None can be driven by ⌘-shortcuts without bespoke per-control keyboard handling.

| Component | Callback props (current) | Actions it should dispatch |
|---|---|---|
| `tug-push-button.tsx` | (inherits from internal/tug-button — already chain-aware via `action` prop) | ✅ already handled |
| `tug-checkbox.tsx` | `onCheckedChange` | `toggle` (with bound value in the ActionEvent) |
| `tug-switch.tsx` | `onCheckedChange` | `toggle` |
| `tug-radio-group.tsx` | `onValueChange` | `selectValue` or similar |
| `tug-choice-group.tsx` | `onValueChange`, `onFocusChange` | `selectValue`, arrow-key navigation dispatches |
| `tug-tab-bar.tsx` | `onTabSelect`, `onTabClose` | `selectTab`, `closeTab` |
| `tug-slider.tsx` | `onValueChange` | `setValue` with `begin`/`change`/`commit` phases |
| `tug-value-input.tsx` | `onValueCommit` | `setValue` with `commit` phase |
| `tug-popup-button.tsx` | `onSelect` | `selectMenuItem` — or, like TugEditorContextMenu, the item `id` is the action name |
| `tug-accordion.tsx` | `onValueChange` | `toggleSection` or `expandSection` |
| `tug-input.tsx` | (has no explicit callback props in its own file — wraps Radix/native input) | `cut`, `copy`, `paste`, `selectAll`, `undo`, `redo` — same contract as `tug-prompt-input` |
| `tug-textarea.tsx` | (same as tug-input) | same as above |
| `tug-option-group.tsx` | (has `onKeyDown` implying custom keyboard handling) | `selectValue`, arrow navigation dispatches |
| `tug-confirm-popover.tsx` | `onConfirm`, `onCancel` | `confirmDialog`, `cancelDialog` |
| `tug-alert.tsx` | `onConfirm`, `onOpenChange` | `confirmDialog`, `dismissDialog` |
| `tug-sheet.tsx` | `onOpenChange` | `dismissDialog` (bound to the sheet id) |
| `tug-popover.tsx` | `onOpenChange` | `dismissPopover` |

#### Why callback props are a problem (L11 violation)

Callback props tightly couple the control to its parent. The parent must wire up the callback, handle the value, and potentially do the work of dispatching or storing it. Every usage site duplicates glue code. Keyboard shortcuts are impossible to bind globally because the callback isn't reachable from the keybinding pipeline. Multi-surface interactions (keyboard + menu + gesture) require multiple code paths to produce the same outcome. This is exactly what the responder chain exists to prevent.

#### The ripple effect: the context-menu work

The last several conversation rounds on this menu have all been downstream of this one issue. Three specific pain points we hit:

- **"Menu doesn't dismiss on ⌘A."** The selectAll action was dispatched through the responder chain (via `tug-card`), but the menu couldn't observe it because it had no chain integration. We added `observeDispatch` to the manager as part of this audit's work — that primitive is now the general mechanism, but only because the chain actually carries the traffic.
- **"Cut/Copy/Paste from the menu doesn't run."** The menu was calling its own `onSelect` callback and wiring clipboard work through the prop. The parent had to deal with WebKit's synchronous-user-gesture restrictions, menu blink timing, and clipboard APIs. The correct path — and the one we ended up with — is that the menu dispatches `{action: "cut", phase: "discrete"}` and the first responder's handler does the work. One code path, works for both keyboard and menu.
- **"Clipboard shortcuts don't reach the editor."** First-responder override by the enclosing card (Part 2.1 below). The editor registers its cut/copy/paste handlers, but the card keeps stealing first-responder status on every pointerdown.

---

## Part 2 — Architectural issues

### 2.1 First-responder override by parent responders

**Symptom:** `tug-prompt-input`'s cut/copy/paste handlers are never reached when the user presses ⌘X/C/V, because `tug-card.tsx:484-486` unconditionally overrides the first responder to the card on every pointerdown bubbled up from any descendant.

**Root cause:** `tug-card`'s pointerdown handler was designed under the assumption that cards are the leaf-most responders. When the `tug-prompt-input` responder was added as a descendant, the card kept winning the race because:

1. The editor is inside the card.
2. `pointerdown` fires on the editor; React's synthetic event bubbles through the tree.
3. The card's `onPointerDown` listener runs in the bubble phase, calling `manager.makeFirstResponder(cardId)`.
4. The editor's `focus` event fires on the first click only (subsequent clicks on an already-focused editor don't re-fire focus).
5. After the first click, every subsequent pointerdown re-promotes the card. The editor never becomes first responder again until focus moves away and back.

**Current workaround:** `tug-prompt-input.tsx`'s `handlePointerDown` now calls `managerRef.current?.makeFirstResponder(responderIdRef.current)` and then `e.stopPropagation()` so the card's handler never fires. This is a tactical escape hatch.

**Why the workaround is wrong long-term:**
- Every nested responder (tug-prompt-input, tug-input, tug-textarea, tug-value-input, any future editor-like control) will need the same `stopPropagation` dance.
- `stopPropagation` silently prevents any other legitimate pointer-related behavior the card might add (drag, selection, analytics, hover highlighting, etc.) from running when the click lands inside the nested responder.
- It violates the principle that components should compose cleanly without knowing about their ancestors' internals.

**Fix (committed — Option (a) from original proposal):** The chain's first-responder walk runs *innermost* first. When `pointerdown` fires, the nearest registered responder up the DOM tree from the event target becomes first responder. Implementation: `useResponder` writes a `data-responder-id` attribute on the registered component's root DOM element via a ref callback; `ResponderChainManager.findResponderForTarget(node)` walks up from the node looking for the nearest ancestor with that attribute; `ResponderChainProvider` installs one document-level capture-phase `pointerdown` listener that promotes the innermost responder under the event target. Per-component `makeFirstResponder` calls and per-component focus listeners are deleted. This is what every desktop UI toolkit has done since NeXT.

### 2.2 Ad-hoc first-responder promotion

Right now, responder promotion happens in at least three places, each with different semantics:

- **Auto-promotion on register** (`responder-chain.ts:114-120`): the first root node to register becomes first responder. Great for app startup, useless for subsequent focus changes.
- **`tug-card` pointerdown** (`tug-card.tsx:484`): sets first responder to card id on every pointerdown.
- **`deck-canvas` pointerdown** (`deck-canvas.tsx:200`): sets first responder to `"deck-canvas"` if the click lands on the canvas background.
- **`tug-prompt-input` focus listener** (added in this audit): sets first responder to the editor on contentEditable `focus` event.
- **`tug-prompt-input` contextmenu + pointerdown** (added in this audit): defensive promotion to work around the tug-card override.
- **`deck-canvas` showComponentGallery action handler** (`deck-canvas.tsx:270-277`): promotes the gallery card after opening it.

Six different mechanisms, no unified contract. What happens if two fire on the same event with different ids? Last-write-wins — the order depends on event registration order, React delegation timing, and whether the listener is capture or bubble.

**Proposal:** consolidate into a single rule enforced by the chain. When a pointerdown fires, the chain resolves the innermost responder from the event target (walking the DOM) and makes it first responder. When keyboard focus moves (via Tab, programmatic `.focus()`, etc.), the chain promotes the nearest enclosing responder to the focused element. Callers no longer call `makeFirstResponder` at all for the normal case; the mechanism is needed only for programmatic promotion (e.g., `deck-canvas.showComponentGallery` opening a new gallery card and wanting it active).

### 2.3 Action vocabulary is untyped string soup

Actions are free-form strings. `"cut"`, `"selectAll"`, `"cycleCard"` — there's no type, no central list, no discoverability. Misspelling an action silently returns `handled: false`. Documentation is scattered across whichever component happens to register a handler or dispatch the action.

This is fine for a ten-action prototype, bad at the scale we're growing into. When `tug-accordion` dispatches `toggleSection`, is that a new action or should it be `toggle` with a payload? When a test uses `"showComponentGallery"`, is that the exact string or is it `"show-component-gallery"`? No compiler help.

**Proposal:** A typed action vocabulary. A `TugAction` union type defined centrally (probably `action-vocabulary.ts`), updated as actions are added. `dispatch`, `useResponder`'s `actions` map, and `keybinding-map.ts` all reference the union so typos become compile errors. Organize actions by category:

- **Clipboard:** `cut`, `copy`, `paste`, `selectAll`, `selectNone`
- **Editing:** `undo`, `redo`, `delete`, `duplicate`
- **Navigation:** `cycleCard`, `previousTab`, `nextTab`, `focusNext`, `focusPrevious`
- **Dialog/menu:** `confirmDialog`, `cancelDialog`, `dismissPopover`, `openMenu`
- **Control value:** `setValue`, `toggle`, `selectValue`, `incrementValue`, `decrementValue`
- **Window/card:** `close`, `minimize`, `maximize`, `showComponentGallery`, `resetLayout`, `addTabToActiveCard`
- **Meta:** `setProperty` (for the PropertyStore bridge)

An `ActionEvent` with a typed `action` field still carries its generic `value` payload, so `setValue` can carry a number and `selectValue` can carry a string — the type union gives us the *names*, not the payloads.

### 2.4 Keybinding map is sparse

Current state — `keybinding-map.ts`:

```ts
export const KEYBINDINGS: KeyBinding[] = [
  { key: "Backquote", ctrl: true, action: "cycleCard" },
  { key: "KeyA", meta: true, action: "selectAll", preventDefaultOnMatch: true },
  { key: "KeyX", meta: true, action: "cut", preventDefaultOnMatch: true },
  { key: "KeyC", meta: true, action: "copy", preventDefaultOnMatch: true },
  { key: "KeyV", meta: true, action: "paste", preventDefaultOnMatch: true },
];
```

Missing from a pile of macOS standards: ⌘Z (undo), ⇧⌘Z (redo), ⌘W (close card), ⌘T (new tab), ⌘⇧T (reopen tab), ⌘1..9 (jump to tab), ⌘F (find), ⌘, (preferences), ⌘Q (quit — probably host-app, but needs coverage), ⌘. (cancel), Escape (cancel), ⇥/⇧⇥ (focus next/prev), arrow keys inside list-like containers.

**Proposal:** complete the keybinding map against the macOS HIG standard set. Every standard shortcut becomes an action dispatch. Components that handle the corresponding action register via `useResponder`. The glue between "user pressed a key" and "component does the thing" becomes zero lines of ad-hoc component code.

### 2.5 `useResponder` does not reactively update handlers

`use-responder.tsx:101-107` registers the node once on mount with a snapshot of `options.actions`. Subsequent renders update `optionsRef.current`, but the object stored in the manager is the initial reference. In practice, this works by accident because most callers wrap their handlers in `useCallback(() => ..., [])` so the function identities are stable — the initial object has the same references as any later one.

But this is fragile. If a caller forgets `useCallback`, the actions map becomes stale the moment state changes. Silent bug, no warning.

**Proposal:** have `useResponder` register a proxy that looks up actions via `optionsRef.current` on every call, not a snapshot. Alternative: have `useResponder` re-register the node on every render where the actions map identity changes (this would require `register` to replace existing entries by id, which it already does via `Map.set`). Either fix would make the behavior contract match the docstring.

### 2.6 No "active first responder" indicator in the DOM

There is no visual or `data-`attribute representation of which responder is first. This makes debugging "why isn't my action firing?" hard — you can't inspect the DOM to see what the chain considers active, and there's no store subscription pattern that cheaply exposes it.

**Proposal:** `useResponder` writes a `data-responder-id="<id>"` attribute on the registered element, and the manager writes `data-first-responder="true"` on the current first-responder element (via a subscription that fires on validation version change). Trivially inspectable in devtools; enables ancestor-walk lookups (see 2.1 option b) without React tree traversal.

---

## Part 3 — Migration plan

This is ordered so each step is shippable on its own and unblocks the next. Each step has a rough size indicator and the laws it restores.

### Phase R1 — Unify first-responder promotion *(M, restores L11, eliminates per-component hacks)*

1. **Add DOM anchor attributes** in `useResponder`: write `data-responder-id` on the registered component's root element via a ref callback. Requires `useResponder` to accept a ref or return one.
2. **Implement `ResponderChainManager.findResponderForTarget(Node): string | null`**: walks up from the given DOM node looking for the nearest ancestor with `data-responder-id`, returns the id or null.
3. **Single document-level capture pointerdown listener in `ResponderChainProvider`**: on every pointerdown, call `findResponderForTarget(e.target)` and if the result is not the current first responder, promote it. Runs in capture phase so it completes before any descendant React handlers.
4. **Delete the per-component `makeFirstResponder` calls** in `tug-card`, `tug-prompt-input`, `deck-canvas` (the pointerdown ones — keyboard-navigation ones for `cycleCard` etc. stay).
5. **Delete the `stopPropagation` hack** in `tug-prompt-input.handlePointerDown`.

Exit criteria: clicking inside a nested responder (editor inside a card) naturally makes the editor first responder without any component-level wiring. ⌘X/C/V work after any click into the editor. `tug-prompt-input` no longer needs its focus listener or contextmenu-defensive promotion.

### Phase R2 — Migrate interactive controls off callback props *(L, restores L11 across the suite)*

One component at a time, in rough risk order (simplest first):

1. **`tug-checkbox`, `tug-switch`**: dispatch `toggle` with a `value: boolean` payload. Deprecate `onCheckedChange` but keep it working as a thin adapter that dispatches into the chain (so existing callers don't break during migration).
2. **`tug-radio-group`, `tug-choice-group`, `tug-option-group`**: dispatch `selectValue` with `value: string`.
3. **`tug-tab-bar`**: dispatch `selectTab` and `closeTab` with `value: string`.
4. **`tug-accordion`**: dispatch `toggleSection` with `value: string | string[]`.
5. **`tug-popup-button`**: dispatch its items' ids as action names (same pattern as `TugEditorContextMenu`).
6. **`tug-slider`, `tug-value-input`**: dispatch `setValue` with `value: number` and `phase: "begin" | "change" | "commit"` — this is where `ActionPhase` beyond `discrete` starts earning its keep.
7. **`tug-input`, `tug-textarea`**: register as responders for `cut`, `copy`, `paste`, `selectAll`, `undo`, `redo` — same contract as `tug-prompt-input`.
8. **`tug-confirm-popover`, `tug-alert`, `tug-sheet`, `tug-popover`**: dispatch `confirmDialog` / `cancelDialog` / `dismissDialog` / `dismissPopover`.

Each migration is mechanical: introduce the action dispatch inside the component's existing event handler, keep the callback prop alive as a compat shim that the chain invokes. Consumers can drop the callback prop when they want to go through the chain; eventually the shims delete.

Exit criteria: every tug-* interactive control dispatches its semantic actions through the chain. The keybinding map can bind any macOS-standard shortcut to any of them without per-component glue.

### Phase R3 — Type the action vocabulary *(S, restores compile-time safety)*

1. Create `tugdeck/src/components/tugways/action-vocabulary.ts` exporting a `TugAction` union type.
2. Narrow `ActionEvent.action` from `string` to `TugAction`.
3. Narrow `ResponderNode.actions` from `Record<string, ActionHandler>` to `Partial<Record<TugAction, ActionHandler>>`.
4. Narrow `KeyBinding.action` from `string` to `TugAction`.
5. Update call sites; fix any mismatches exposed by the compiler.

Exit criteria: `manager.dispatch({ action: "cutt", phase: "discrete" })` fails at compile time.

### Phase R4 — Complete the macOS standard keybinding map *(S, restores L11 for keyboard)*

Add entries to `keybinding-map.ts` for the full set listed in 2.4. Each entry routes to a typed action. Components that handle the action are already registered (after R2). Consumers get standard keyboard shortcuts for free.

Exit criteria: pressing ⌘Z anywhere in the app runs the `undo` action on the first responder; pressing ⌘W closes the active card; etc. No component has its own keybinding wiring.

### Phase R5 — Reactive action maps in `useResponder` *(S, fixes a latent class of stale-closure bugs)*

Change `use-responder.tsx` to register a proxy actions map that reads from `optionsRef.current` on every access. Or: detect identity changes in the actions map and re-register the node via `manager.register` (idempotent via `Map.set`). Either fix closes the loophole where a forgotten `useCallback` silently produces stale handler references.

### Phase R6 — Retrofit `tug-editor-context-menu` dispatch-observer pattern to the other floating surfaces *(S)*

Now that `observeDispatch` exists, every transient/modal surface that wants to dismiss on external action traffic (menus, popovers, tooltips, sheets, alerts) can subscribe to it with the same three-line `useLayoutEffect`. Retrofit `tug-context-menu`, `tug-popover`, `tug-popup-button`, `tug-tooltip`, `tug-alert`, `tug-sheet`, `tug-confirm-popover`. Each migration is a few lines and eliminates bespoke outside-click / escape-key wiring.

---

## Part 4 — Decisions (locked in before R1)

1. **Action vocabulary granularity: middle ground.** One action per semantic (`setValue`, `toggle`, `selectValue`, etc.) with rich payloads carried on `ActionEvent.value`. Document expected payload shapes in `action-vocabulary.ts` alongside the `TugAction` union. This keeps the name-level type union tight without exploding it into per-control variants.

2. **`undo`/`redo` follow macOS semantics.** Chain walks from innermost. If an editor-like responder has focus, it handles `undo`/`redo` against its own history. If not, the nearest ancestor that registered for those actions gets them (a card undoing tab-close, a canvas undoing layout changes, etc.). Decades of macOS precedent: rarely confusing in practice. No special-casing needed in the chain — the existing walk-from-first-responder logic does the right thing once the responders are registered in the right places.

3. **Preserve direct dispatch.** `dispatchTo` stays as a first-class primitive. It is the right tool when the developer explicitly says "I know which target should receive this event" — programmatic remote control, tests, unusual integration points. The chain-walking `dispatch` (and `dispatchForContinuation`) is the default path; `dispatchTo` is the explicit escape hatch. No fighting developers who opt into it.

4. **Clean break on the callback-prop migration.** No deprecation cycle. No compatibility shims. No TODO comments referencing future work. R2 removes the callback props and updates every consumer in the same commit. There are no external clients of this component library — it's the tugtool repo and Tug.app — so coordinating a break is trivial.

5. **Component authoring guide updates follow R2, not precede it.** Once the callback-prop migration has actually landed, rewrite the `component-authoring.md` checklist to require `useResponder` for any control that emits actions. At that point L11 compliance becomes enforceable at review time with the docs matching reality. Updating the doc before R2 would make it aspirational and drift-prone — wait for the code to match.

---

## Part 5 — What's "already done" from this audit's conversation

For the record, the following pieces have already landed and do not need to be redone in R1–R6:

- `ResponderChainManager.dispatchForContinuation` — two-phase dispatch with continuation callbacks.
- `ResponderChainManager.observeDispatch` — global dispatch observer pattern.
- `ActionHandler = (event: ActionEvent) => void | (() => void)` — widened handler return type.
- `keybinding-map.ts` entries for `cut`, `copy`, `paste`.
- `tug-prompt-input.tsx` registers as a responder with `cut`/`copy`/`paste` handlers.
- `tug-editor-context-menu.tsx` dispatches through the chain (not via `onSelect` prop) and subscribes to `observeDispatch` for external-dismiss.
- `responder-chain-provider.tsx` uses `dispatchForContinuation` and invokes the returned continuation so keyboard shortcuts get two-phase handlers.
- Tactical `stopPropagation` workaround in `tug-prompt-input.handlePointerDown` — **explicitly marked to be removed in R1**.

These are fine foundations. The audit work is about extending them to the rest of the suite and removing the architectural cliff in 2.1 so nested responders compose correctly.

---

## Part 6 — References

- `tuglaws/tuglaws.md` — L11, L07, L03, L02.
- `tuglaws/component-authoring.md` — the checklist that will need updating post-R2.
- `tugdeck/src/components/tugways/responder-chain.ts` — the chain primitives.
- `tugdeck/src/components/tugways/responder-chain-provider.tsx` — the keyboard pipeline.
- `tugdeck/src/components/tugways/use-responder.tsx` — the registration hook.
- `tugdeck/src/components/tugways/keybinding-map.ts` — the current keybinding table.
- `tugdeck/src/components/tugways/tug-card.tsx:484-486` — the first-responder override bug (Part 2.1).
- `tugdeck/src/components/tugways/tug-prompt-input.tsx` — the tactical `stopPropagation` workaround; removed by R1.

---

## Part 7 — Quality Audit Report

*First snapshot taken after R1, R3, and R5 landed.*

### 7.1 What landed

**Completed:**

- **R1: Unified first-responder promotion via innermost-from-target DOM walk.** `useResponder` writes `data-responder-id` via a stable ref callback; `ResponderChainManager.findResponderForTarget` walks the DOM; `ResponderChainProvider` installs one document-level capture-phase `pointerdown` listener. Per-component pointerdown overrides deleted from `tug-card`, `tug-prompt-input`, `deck-canvas`. Tactical `stopPropagation` workaround removed.
- **R3: Typed action vocabulary.** `TugAction` union in `action-vocabulary.ts`, narrowed `ActionEvent.action`, `ResponderNode.actions` (now `Partial<Record<TugAction, ActionHandler>>`), `KeyBinding.action`, `TugButtonProps.action`. ~25 typecheck errors fixed across the codebase.
- **R5: Reactive action maps in `useResponder`.** The actions map is now a live `Proxy` that reads from `optionsRef.current` on every access — closes the stale-closure loophole where a forgotten `useCallback` silently produced wrong handlers.
- **Audit doc updates.** Locked-in decisions in Part 4, marked Option (a) as committed in 2.1.
- **Earlier in the same session:** `dispatchForContinuation`, `observeDispatch`, two-phase action handlers, context-menu responder dispatch, clipboard keybindings.

**Still pending:** R2 (migrate 17 interactive controls), R4 (macOS standard keybinding map), R6 (retrofit `observeDispatch` to floating surfaces), post-R2 `component-authoring.md` update.

### 7.2 Quality assessment by area

#### Architecture — A-

**Strengths.** The innermost-from-target DOM walk is the right mechanism. It is what NeXT's responder chain, Cocoa, and every serious desktop toolkit has done for decades. Composition is automatic: nested responders naturally win over ancestors without any per-component wiring. The old model's central pain point — "parent responder overrides nested on every click" — is structurally impossible now, not just papered over. One document-level capture listener replaces what was six scattered `makeFirstResponder` call sites with divergent semantics. Single mechanism, one place to debug. Live proxy for action handlers removes an entire class of silent-bug failure modes; the contract documented in the `useResponder` docstring now matches the implementation. Two-phase dispatch (`dispatchForContinuation` + continuation callbacks) cleanly handles the WebKit sync-gesture-for-clipboard requirement without leaking it into every component. `observeDispatch` gives transient UIs (menus, popovers, tooltips) a single signal for "something else happened, close yourself" — no more per-surface keyboard/click-outside wiring to maintain.

**Caveats.** The DOM walk is O(depth) per pointerdown. For a typical card-inside-canvas-inside-root tree that's ~5–10 ancestors; negligible. But it's worth noting as a budget item if we ever get to deeply nested scenarios. `data-responder-id` is a single-attribute write-behind: if two responders try to write to the same DOM element (bad practice, but possible), the ref callback's "remove from previous" logic handles it but it's a footgun. R2 is the elephant in the room: R1+R3+R5 give us the *substrate* for chain-first-everywhere, but until the 17 interactive controls migrate, we still have the mixed world. The architecture is correct but the suite isn't yet consistent.

#### Type safety — B+

**Strengths.** `ActionEvent.action` is now `TugAction`, not `string`. Dispatch typos are compile errors at the call site — a real improvement from "string soup" to "a typed vocabulary with autocomplete". `ResponderNode.actions` is `Partial<Record<TugAction, ActionHandler>>` — it is structurally impossible to register a handler for a nonexistent action name. `KeyBinding.action` is typed. You cannot bind a key to a nonexistent action. `canHandle`, `validateAction`, `nodeCanHandle` all take `TugAction`. The whole chain API is type-coherent.

**Caveats.** The `ActionEvent.value` payload is still `unknown`. Per action name is typed, per payload is not. The vocabulary file documents expected payload shapes in prose, but handlers must defensively narrow `event.value`. This is a conscious tradeoff (see Part 4 decision 1 — "middle ground"). The alternative would be a discriminated union like `type CutActionEvent = { action: "cut"; value: undefined }` etc. forcing every dispatch site to construct the right shape. The middle-ground choice means R3 gives us name-safety, not shape-safety. Separately, `tug-editor-context-menu` casts `id as TugAction` — menu items carry their action names in the generic `id: string` field of `TugContextMenuEntry`, and the dispatch cast bypasses compile-time checking for typos in item definitions. Finally, `TugAction` includes `GalleryAction`: demo/test actions (`previewColor`, `demoAction`, etc.) are in the same union as production actions, cluttering autocomplete.

#### Consistency — C+

This is the biggest honest weakness. The suite is currently in a mixed state:

- **Chain-native (L11-compliant):** `tug-card`, `tug-prompt-input`, `deck-canvas`, `tug-editor-context-menu`, `tug-button` (internal).
- **Callback-prop (L11-non-compliant):** `tug-checkbox`, `tug-switch`, `tug-radio-group`, `tug-choice-group`, `tug-option-group`, `tug-tab-bar`, `tug-slider`, `tug-value-input`, `tug-popup-button`, `tug-accordion`, `tug-input`, `tug-textarea`, `tug-confirm-popover`, `tug-alert`, `tug-sheet`, `tug-popover`, `tug-tooltip`. 17 components.

Consumers today see an inconsistent API: "some tug-* components dispatch actions, others take callbacks, and I have to remember which is which." That's the hallmark of an incomplete migration. Until R2 lands, we have a two-track component library. Nothing is *broken* — callback-prop components continue to work because nothing in R1/R3/R5 required them to migrate. But the mental model is not clean yet.

#### Coherence — A

The story the chain now tells is internally consistent and learnable:

1. Components register as responders via `useResponder`, attaching `responderRef` to their root element.
2. Clicking a component makes it first responder automatically (innermost DOM walk).
3. Actions dispatched via `dispatch` walk from first responder upward until a handler is found.
4. Actions dispatched via `dispatchTo` go directly to a named node.
5. Handlers return either `void` or a continuation callback for two-phase work.
6. Dispatch observers see every action for "close on external action" patterns.
7. Keyboard shortcuts are one-liners in `keybinding-map.ts` that dispatch typed actions.

This is teachable in five minutes. A big improvement over "you have to know about `makeFirstResponder`, pointerdown bubble order, card pointerdown override semantics, React delegation timing, and `stopPropagation` escape hatches". The mental model was badly fragmented before; now it's coherent.

#### Technical choices

**Good choices.** The Proxy for live handler lookup (R5) — alternative would have been re-registering the node on every render, but the Proxy is one-time cost at registration and amortizes to constant reads. Capture phase at the document level for the pointerdown listener — runs before any React-delegated bubble handler, so even if an old component still has a `makeFirstResponder` in `onPointerDown` during migration, our promotion wins. Future-proof against half-migrated intermediate states. `Partial<Record>` for the actions map — gives per-key autocomplete and refuses unknown keys without forcing responders to implement every action. Cast-through-unknown for menu item id → `TugAction` — ugly but honest; the alternative is a separate typed entry shape, which was deferred. The cast is at one spot, not scattered. Preserving `dispatchTo` as first-class per the Q3 directive.

**Choices worth revisiting.** The DeckCanvas wrapper div: a wrapper added around deck-canvas's children solely to have an ancestor for `data-responder-id`. This adds one DOM level. Alternative: extend `ResponderScope` to render a real DOM element with the attribute. Not done because it would change `ResponderScope`'s API contract for every caller, which is a bigger ripple. The wrapper div is localized. The `canHandle` wrapper in `useResponder`: the wrapper is always installed as a permanent closure, even when the caller doesn't provide one. The chain's `canHandle` method checks the actions map first, then this function. The wrapper returns `false` when the caller doesn't provide one, so behavior is unchanged — but it's a small runtime cost for chain queries. `GalleryAction` in the production union: prioritized "galleries keep working without refactor" over "production autocomplete is pristine". Reversible via a generic type parameter.

#### Implementation strategy

**Strengths.** Each phase is shippable standalone. R1 works without R2. R3 works without R4. R5 is independent. No implicit dependencies that fail at runtime if you only do part of it. Tests pass throughout: 165 responder-chain-touching tests pass on every sub-step; the tree was not left broken between phases. Documented in code, not just in chat. Every non-obvious decision has an inline comment or docstring pointing at the reason. Future-me (or future-you) can reconstruct the *why* from the code alone.

**Weaknesses.** R5 was split into R1's commit instead of handled as its own phase. The audit document lists them separately, but in the code the Proxy landed in the same edit as the `responderRef` change. Fine as an end state, but someone reading the git history would see "R1" doing "R1 + R5". The full test suite was not run after each phase — only the responder-chain subset (which passes). The full `bun test` has unrelated flakes from `tugcard.test.tsx` (a mock-setup issue with `connection.onFrame` that predates this work) and `do-set-region-wiring.test.ts` (a timing flake). Without running the full suite there's no way to rule out collateral damage elsewhere. Not verified in-browser: the build is clean and the unit tests pass, but clipboard cut/copy/paste has not been eye-tested end-to-end in a live editor after R1 removed the workarounds. (Confirmed working by the user in the subsequent message — see Part 8 next-steps context.)

### 7.3 Holes, pitfalls, weaknesses, limitations (ordered by severity)

**1. The partial-migration state is the biggest risk.** Until R2 lands, 17 components use callback props and are outside the chain. Any pattern that tries to build on "all tug-* controls dispatch actions" (e.g. a form that registers one `setValue` handler and wires up 5 inputs through it) will not work consistently until every control migrates. R2 is not optional; it is the completion of R1–R6's premise. Recommended next step: start R2 with the simplest components (tug-checkbox, tug-switch) to establish the pattern.

**2. `ActionEvent.value` is untyped.** Documented in the vocabulary file as prose, enforced nowhere. A `setValue` handler that expects `number` but receives `string` will silently misbehave. Defensive handlers guard with `typeof`; non-defensive ones get runtime type errors. Recommended mitigation: add a `narrowValue<T>(event, guard)` utility that handlers call, e.g. `const n = narrowValue(e, (v): v is number => typeof v === "number"); if (n === null) return;`. Convention over enforcement.

**3. Menu `id as TugAction` cast bypasses type checking.** `TugEditorContextMenu` items are typed with `TugContextMenuEntry.id: string`, and the dispatch site casts. A typo in an item definition (`id: "cutt"`) compiles silently and dies at runtime with `handled: false`. Recommended fix: introduce `TugEditorContextMenuItem` as a distinct type with `action: TugAction`. Update `tug-prompt-input` to use it. ~20 lines.

**4. `dispatchTo` is not updated to work with the new target resolution.** Still takes a string `targetId` and throws on unregistered. With R1's `findResponderForTarget`, a `dispatchToTarget(element: Node, event)` convenience could wrap `findResponderForTarget + dispatchTo`. Nice-to-have, not critical. Punt until a real need appears.

**5. No visual debugger for the chain.** The `data-first-responder="true"` attribute mentioned in audit section 2.6 was not added. You can inspect the DOM to see *which nodes are registered* (via `data-responder-id`), but not *which is currently first*. "Why isn't my action firing?" debugging is still somewhat opaque. Recommended fix: add the attribute. Three lines in the manager's first-responder promotion path plus a subscription to update it on change.

**6. Focus-based first-responder promotion is gone.** R1 deletes tug-prompt-input's focus listener. Keyboard-only users who Tab into an editor (without clicking) won't get first-responder promotion on Tab. For pointer users this isn't an issue; for keyboard users it *might* be — depends on whether Tab focusing a contentEditable fires a `pointerdown` (it doesn't). Recommended fix: add a document-level `focusin` listener alongside the `pointerdown` listener in the provider. Walks from `event.target` up the DOM the same way. Covers keyboard-driven focus changes for free.

**7. No test coverage for the new R1 mechanism specifically.** The existing 165 responder-chain-touching tests pass, but there is no new test that exercises `findResponderForTarget` + the provider's pointerdown listener as a unit. The existing tests cover the *old* mechanisms and incidentally survive the migration. Recommended fix: add at least one test that mounts a nested responder inside a parent responder, fires a pointerdown on the inner element, and asserts the inner became first responder. ~20 lines, covers R1's invariant directly.

**8. `action-vocabulary.ts` documents payloads in prose, not types.** Accurate today; will drift the first time someone changes a payload shape without updating the comment. No enforcement. Tolerable for now. If drift happens, revisit (payload discriminated unions or helper type utilities).

**9. R1 removed the contextmenu defensive `makeFirstResponder` but kept the contextmenu handler.** The comment says "pointerdown listener has already promoted this node via data-responder-id lookup, and a right-click issues pointerdown before contextmenu." This is *mostly* true. Edge case: a right-click with a pointerdown handler that calls `stopPropagation` could prevent the provider's document-level listener from firing. Mitigation: capture-phase listener at document level cannot be stopped by a descendant's `stopPropagation` call (capture runs before the target). We're safe. Worth a confirmatory comment in the provider.

**10. `undo`/`redo` are declared in the vocabulary but nothing handles them yet.** The audit decision was "macOS semantics — chain walks from innermost". That's already how the chain works, so no code change was needed. But nothing *handles* `undo`/`redo` anywhere today. It's a no-op until R2 brings in editor responders that register for them. Recommended fix: when R2 migrates `tug-input` / `tug-textarea` / `tug-prompt-input`'s editor-level `undo`/`redo`, include tests that verify the walk works correctly.

### 7.4 Overall grade: B+

| Area | Grade | Why |
|---|---|---|
| Architecture | A- | The mechanism is right, the story is coherent, the substrate is sound. |
| Type safety | B+ | Meaningfully stronger than before, with one cast and an untyped payload field. |
| Consistency | C+ | Partial migration state; R2 is required for the benefit to land at suite level. |
| Coherence | A | The mental model is finally one story, not six. |
| Implementation strategy | B+ | Phases shipped cleanly with tests passing, but the full suite wasn't run and the work wasn't eye-tested in browser (at the time of the snapshot). |
| Documentation | A- | Inline comments, vocabulary file, audit doc all match the code. |

The work landed is solid and in the right direction. What's missing is mostly "R2 and polish", not "architectural backsliding" — the new mechanisms *prevent* the classes of bugs we fought in the last several rounds of menu work. The substrate is the hard part, and it's done.

---

## Part 8 — Path to straight A's

The Part 7 report card identified four laggards: **Type safety (B+), Consistency (C+), Implementation strategy (B+), Documentation (A-)**. This section plans the specific work required to move every grade to A, ordered so each phase's exit criteria can be independently verified and landed.

The phases are grouped by the grade they're primarily moving. Every grade has multiple inputs; Part 8's ordering prioritizes the ones that unblock the most downstream work first.

### Phase A1 — Cheap wins that move the needle (1–2 short sessions)

Ship these before starting the bigger R2 migration so R2 can assume they're in place.

1. **Focus-based first-responder promotion** *(fixes Hole 6)*
   - Add a document-level capture-phase `focusin` listener in `ResponderChainProvider` that calls `findResponderForTarget(event.target)` and promotes the result, mirroring the `pointerdown` listener.
   - One function, ~10 lines, alongside the existing promoter.
   - Exit criteria: Tab-focusing a contentEditable inside a card promotes the editor responder, not the card. Keyboard-only users get parity with mouse users.

2. **`TugEditorContextMenuItem` with typed `action`** *(fixes Hole 3)*
   - Introduce a distinct item type in `tug-editor-context-menu.tsx` with `action: TugAction` instead of `id: string`.
   - Update `tug-prompt-input.tsx`'s `menuItems` definitions to use the new type.
   - Drop the `id as TugAction` cast at the dispatch site.
   - Exit criteria: a typo like `action: "cutt"` in a menu item definition fails at compile time.

3. **R1 invariant test** *(fixes Hole 7)*
   - Add one test that mounts a parent responder containing a child responder, fires a pointerdown on the child's DOM element, and asserts `manager.getFirstResponder() === childId`.
   - Second test that asserts `findResponderForTarget` returns the innermost match for a deeply nested structure.
   - Exit criteria: direct coverage of the invariant that makes R1 correct.

4. **`data-first-responder` DOM debugger** *(fixes Hole 5)*
   - `ResponderChainManager` subscribes internally: on every first-responder change, clear `data-first-responder` from any element that has it and set it on the element with `data-responder-id === firstResponderId`.
   - Three lines in the manager's promotion path plus a tiny DOM query.
   - Exit criteria: devtools shows exactly one `[data-first-responder]` at any time, matching the chain's current state.

5. **`narrowValue<T>` utility** *(fixes Hole 2)*
   - Add `narrowValue` helper function in `responder-chain.ts` or `action-vocabulary.ts`: `narrowValue<T>(event: ActionEvent, guard: (v: unknown) => v is T): T | null`.
   - Document the convention in `action-vocabulary.ts`: handlers that read `event.value` should use `narrowValue` instead of casting.
   - Add the utility without forcing existing code to adopt it immediately — R2 migration pass will use it naturally.
   - Exit criteria: utility exists and is documented; first use lands in R2.

6. **Confirmatory comment in the capture-phase listener** *(fixes Hole 9)*
   - Add a one-paragraph comment in `ResponderChainProvider` explaining why a descendant's `stopPropagation` cannot interfere with the document-level capture listener.
   - Exit criteria: a future contributor reading the code cannot accidentally introduce the regression described in Hole 9 without confronting the comment.

**Grade impact after A1:** Type safety → A-, Implementation strategy → A-, Documentation → A.

### Phase A2 — R2: Migrate interactive controls off callback props (multi-session, largest phase)

This is the main consistency lift. Order below is chosen to establish the pattern on simple components before attempting complex ones. Each substep has its own exit criteria; the phase as a whole is complete when every tug-* interactive control dispatches through the chain and no callback props remain.

Per the Part 4 decision: **clean break, no compat shims, no deprecation cycle.** Every migration updates the component *and* all its consumers in the same commit.

#### A2.1 — Pattern establishment: `tug-checkbox`, `tug-switch`

Two smallest components. Migrate both to establish the template.

- Each accepts `senderId?: string` (auto-derived via `useId` if omitted) so parent responders can disambiguate multi-control forms.
- Dispatch `toggle` with `{ value: newCheckedState, sender: senderId, phase: "discrete" }`.
- Remove `onCheckedChange` prop entirely.
- Update every gallery/card consumer to register a `toggle` handler via `useResponder` that switches on `event.sender`.
- Exit criteria: both components compile without `onCheckedChange`; gallery demos work; tests pass.

After A2.1, extract the pattern into a brief "migration template" file that subsequent sub-phases can follow mechanically.

#### A2.2 — Selection controls: `tug-radio-group`, `tug-choice-group`, `tug-option-group`

Dispatch `selectValue` with `{ value: selectedId, sender: senderId, phase: "discrete" }`. Remove `onValueChange`, `onFocusChange`. Arrow-key navigation in `tug-choice-group` and `tug-option-group` dispatches `focusNext` / `focusPrevious` through the chain instead of calling the current `onFocusChange` callback.

#### A2.3 — Tabs: `tug-tab-bar`

Dispatch `selectTab` and `closeTab` with `{ value: tabId, sender: senderId, phase: "discrete" }`. Remove `onTabSelect` and `onTabClose`. The enclosing card's `previousTab` / `nextTab` action handlers stay where they are — they're card-level navigation, not tab-bar-level.

**Responder ownership.** `Tugcard` already registers a responder with `id: cardId` and already has direct store access via `useDeckManager()`. A2.3 adds two entries to that existing actions map: `selectTab: (event) => { saveCurrentTabState(); store.setActiveTab(cardId, event.value as string); }` and `closeTab: (event) => store.removeTab(cardId, event.value as string)`. No new responder node, no callback prop forwarding through `deck-canvas`. The inline arrows currently in `deck-canvas.tsx` (`onTabSelect={(tabId) => store.setActiveTab(cardState.id, tabId)}` and the `onTabClose` peer) disappear in the same commit.

**Side-effect deduplication bonus.** The `saveCurrentTabState` call is currently duplicated three times in `tug-card.tsx` — once in the `handleTabSelect` wrapper and once each in `handlePreviousTab` / `handleNextTab`. After A2.3, `previousTab` / `nextTab` handlers compute the target tabId and dispatch `selectTab` through the chain (which routes back to the same Tugcard responder, no infinite loop, single handler call), so the save-state side effect runs once in the `selectTab` handler instead of three places.

**`onTabAdd` is deferred to A2.5**, not handled here. The tab bar's `+` button is a `tug-popup-button` consumer; its migration belongs in the popup-button substep where every popup-button consumer migrates together. Until then, `onTabAdd` remains a callback prop on Tugcard — the only residual tab-related callback. A2 exit criteria are evaluated at the end of A2, not between substeps, so this is permitted.

**As-shipped (commit `fe332454` + Punch #1 fix):** landed as planned with two post-substep corrections worth noting here:

- The initial A2.3 implementation took a shortcut: `handlePreviousTab` / `handleNextTab` called a local `performSelectTab` helper directly rather than dispatching `selectTab` through the chain. This meant keyboard-driven tab switches were invisible to `observeDispatch` subscribers and the dispatch log, breaking the "every interaction is observable" invariant A2 is supposed to deliver. **Fixed in the Pre-A2.6 cleanup (Punch #1)**: both keyboard handlers now dispatch `selectTab` through the chain with a gensym'd `keyboardTabNavSenderId` distinct from the tab bar's own sender id, so observers can tell keyboard switches apart from click-driven ones. The chain walks to the same Tugcard responder, runs `performSelectTab` there, and the save-state side effect still fires exactly once.
- The initial tests rewrote three `nextTab`/`previousTab` instrumentation tests to assert on `store.setActiveTab` capture via a `storeOverrides` parameter added to `renderWithManagerAndStore`, using a mock store. Those tests are unit-level; no integration test fires a real DOM click on a rendered `TugTabBar` and verifies the event → focusin → chain dispatch → handler → store path end-to-end. Gap noted; see the Pre-A2.6 cleanup commit for the rewritten test patterns. A TugTabBar end-to-end test remains future work.

#### A2.4 — Accordions: `tug-accordion`

Dispatch `toggleSection` with `{ value: sectionId | sectionIds, sender, phase }`. Remove `onValueChange`. Both single-expand and multi-expand modes dispatch the same action; the payload's shape (string vs array) distinguishes.

**As-shipped (commit `857045c4` + Punch #2 + Punch #4):**

- Gallery scope expanded from pure migration to migration + demo addition. The original gallery had 8 uncontrolled accordions; a "Chain-Controlled (A2.4)" section was added with two controlled demos exercising `useResponderForm`'s `toggleSectionSingle` and `toggleSectionMulti` slots. This gave those slots their first runtime exercise anywhere in the codebase (they'd existed since the Pre-A2.3 cleanup but had no consumers).
- **Single-mode collapse-all sentinel**: when a `type="single" collapsible` accordion user collapses the currently-open item, Radix reports the new value as an empty string `""`. TugAccordion forwards that sentinel verbatim. Any consumer binding via `toggleSectionSingle` must treat `""` as "no open section." Documented in the `useResponderForm` slot JSDoc and in the TugAccordion module docstring (Punch #4).
- **Unit test coverage added** in Pre-A2.6 cleanup (Punch #2): `src/__tests__/tug-accordion.test.tsx` covers single-mode dispatch, the empty-string collapse sentinel, multi-mode dispatch with string[] payload, multi-mode incremental open/close, explicit `senderId` prop, useId fallback stability, and multi-accordion sender id disambiguation. Tests drive a real `ResponderChainManager` with `observeDispatch` — not by stubbing the dispatch layer.
- The discriminated union branching on `props.type` in TugAccordion still uses a local type assertion (`as React.ComponentPropsWithoutRef<typeof Accordion.Root>`) because the discriminated union doesn't narrow cleanly through the onValueChange parameter. Works at runtime, type-safe at the use site, acceptable trade-off.

#### A2.5 — Popup menus: `tug-popup-button`

Follow the `TugEditorContextMenu` precedent: the menu item's `action` field *is* the action name (use the typed item type from A1 step 2). Dispatch via `dispatchForContinuation` to pick up any continuation returned by the handler. Remove `onSelect`.

**Includes the tab bar's `+` button (deferred from A2.3).** The tab bar's add-tab affordance is a `tug-popup-button` whose menu lists registered card types; selecting one currently fires `onSelect → onTabAdd → store.addTab(cardId, componentId)` via callback props. A2.5 migrates this consumer alongside every other popup-button consumer:

- **New action `addTab` in the vocabulary** — payload `{ value: componentId, sender: cardId }`. Distinct from the existing `addTabToActiveCard` action (which adds a hardcoded `"hello"` tab to the topmost card from the menu/keystroke path); `addTab` carries both the target card and the user-chosen componentId.
- **Tugcard handler** — `addTab: (event) => store.addTab(cardId, event.value as string)`. Drops in alongside the `selectTab` / `closeTab` handlers added in A2.3. The `cardId` is in scope because Tugcard owns the chain node.
- **Prop removals** — `onTabAdd` comes off Tugcard's props, off TugTabBar's props, and the inline arrow `(cId) => store.addTab(cardState.id, cId)` disappears from `deck-canvas.tsx`.
- **Test churn** — same shape as A2.3's test updates: `onTabAdd={() => {}}` stub usages get deleted; any instrumentation tests that captured `addedComponentIds` get rewritten to assert against the store snapshot.

After A2.5, Tugcard has zero callback props for tab interactions. All three actions (`selectTab`, `closeTab`, `addTab`) plus the existing menu/keystroke `addTabToActiveCard` flow through the chain.

**As-shipped (commit `29f46fda` + Punch #3, #5, #7):**

- **Item shape is a deliberate extension of the precedent**, not a literal copy. `TugPopupButtonItem<V>` carries both `action: TugAction` and optional `value?: V` where `V extends TugPopupButtonPayload` (`boolean | number | string | string[]`). The precedent's `TugEditorContextMenuItem` has no `value` field because context menus dispatch semantic actions (cut/copy/paste) without payloads. Popup buttons are value pickers that need a payload; the `value` field is the additive delta.
- **Generic parameter defaults to `never` (Punch #7)**, not to the wide payload union. This forces consumers to annotate their item arrays (`TugPopupButtonItem<number>[]` for font-size pickers, etc.) — without annotation, the default `never` only accepts items with `value: undefined` (the semantic-action shape). Mixed-type arrays fail typecheck because inference can't find a single `V` that satisfies both a number and a string. This closes a gap from the initial A2.5 implementation where `value: unknown` allowed silent payload-type mismatches.
- **Continuation ordering limitation documented (Punch #5)**: TugPopupButton's blink-then-dispatch sequence differs from the `TugEditorContextMenu` precedent's dispatch-then-blink-then-continuation sequence. Acceptable for current value-picker use cases (handlers don't use continuations) but noted in the module docstring as a constraint — future semantic-action popup-button consumers that need the precedent's exact timing should use `TugPopupMenu` directly.
- **Pre-existing demo bug fixed (Punch #3)**: gallery-tab-bar's `handleTabAdd` previously ignored the incoming componentId and hardcoded `"hello"` for every tab regardless of what the user picked from the `+` menu. After A2.5 the chain carries the real componentId explicitly, so the demo was surfacing a long-standing bug that was previously invisible. Fixed: the demo now looks up the registration and builds a real tab of the chosen type.
- **`gallery-observable-props` pedagogical adjustment**: the inspector popup previously demonstrated `dispatchTo` directly via callback (`onSelect` → `manager.dispatchTo(cardId, ...)`). After A2.5 it routes through a local `useResponderForm` binding that re-dispatches `setProperty` via `dispatchTo`. Adds one hop but preserves the type-safe item shape. The pedagogical demo still works; the flow is slightly less direct.
- **Rules of Hooks near-miss caught**: initial gallery-popup-button migration called `useId()` inside `.map()` over `ALL_SIZES`, violating the Rules of Hooks. Fixed before commit by calling `useId()` three times at the top level (sm/md/lg) and keying a static `Record<TugButtonSize, string>`.

**As-shipped caveat about `onTabAdd` test stubs**: the initial A2.5 verification step only ran `bun run check` and `bun test`, both of which ignored test files (`tsconfig.json` excluded `src/__tests__/**/*`, and `bun test` doesn't typecheck). This missed 22 orphaned `onTabAdd={() => {}}` stub props in `tugcard.test.tsx` — React passes them through at runtime, so the tests still passed. The stubs were caught and deleted in the same session as A2.5 via explicit grep. The permanent fix came in the Pre-A2.6 cleanup (Punch #6): test files are now included in typecheck, so orphaned prop references surface as errors at the next `bun run check`.

#### A2.6 — Value-editing controls: `tug-slider`, `tug-value-input`

This is where `ActionPhase` beyond `discrete` starts earning its keep. Dispatch `setValue` with `{ value: numericValue, sender, phase }` where phase is `"begin"` on drag start, `"change"` during drag, `"commit"` on release, and `"cancel"` on Escape-mid-drag. Non-dragging changes (keyboard arrows, Home/End, PageUp/PageDown) dispatch `phase: "discrete"`. Remove `onValueChange` and `onValueCommit`. (Note: Radix slider does not bind wheel events, so there is no wheel-scrub dispatch path.)

Parents registering a `setValue` handler can branch on `event.phase` to distinguish live preview from committed value.

**As-shipped — A2.6**

- **Phase propagation through `useResponderForm`.** The `setValueNumber`, `setValueString`, and `setValueStringArray` slots now carry a second `phase: ActionPhase` argument on the setter signature (previously unary). Existing A2.5-era consumers of `setValueNumber` in `gallery-prompt-input` (font size, letter spacing TugPopupButtons) continue to compile unchanged because a unary `(v: number) => void` is assignable to the wider `(v: number, phase: ActionPhase) => void` slot type — TypeScript's function-parameter contravariance does the work. Handlers that care about phase can opt in per-binding; handlers that don't pay zero cognitive cost.
- **TugSlider phase sequence.** `TugSlider` dispatches `"begin"` on `onPointerDown` with the current (pre-change) value, then `"change"` on Radix `onValueChange` while a `draggingRef` flag is set, then `"commit"` on Radix `onValueCommit`. For keyboard interactions the ref stays false, so `onValueChange` dispatches `"discrete"` and the follow-up `onValueCommit` no-ops to avoid double-dispatch. The disambiguation lives entirely in `TugSlider` — parents only see a clean four-phase lifecycle.
- **Nested `TugValueInput` inherits the slider's sender id.** When `showValue` is true, `TugSlider` renders an internal `TugValueInput` and passes its own `effectiveSenderId` down via the new `senderId` prop. The parent sees both the drag phases and the text-field `"discrete"` commits through a single binding — no need to declare the nested input separately.
- **`TugValueInput` always dispatches `"discrete"`.** A text input has no scrub semantics: blur, Enter, and arrow-key commits all dispatch `setValue` with `phase: "discrete"` directly. Escape reverts without dispatching (same precedent as before). When used standalone (e.g. in `gallery-value-input`) the parent's `setValueNumber` binding handles it just like any other discrete control.
- **Gallery migration.** `gallery-slider.tsx` and `gallery-value-input.tsx` were ported to `useResponderForm` with gensym'd sender ids for every control (11 sliders in `gallery-slider`, 6 value inputs in `gallery-value-input`). The demo setters are unary `setXxx` functions — they ignore phase entirely, which is the intended "opt-out" default for simple consumers. No other files touched: `TugSlider` / `TugValueInput` have no consumers outside the gallery today.

**Post-A2.6 hardening — 6 punch items addressed in a follow-up pass**

The initial A2.6 commit shipped a B+ implementation with several holes that surfaced in a self-audit. A second pass drove it to A grade:

- **P1. `getBoundingClientRect` stub for slider tests.** happy-dom returns `0×0` for every element, which collapsed Radix's slider hit-testing to `value=0` and forced the A2.6 tests to weaken numeric-payload assertions to `typeof === "number"`. The stub installs a `200×20` rect on `Element.prototype.getBoundingClientRect` for the duration of `tug-slider.test.tsx` only (not `setup-rtl`, to avoid side-effecting the other 71 test files). With realistic geometry, drag tests now assert concrete numeric payloads: `clientX=150` maps to value `75`, a subsequent keyboard step to `76`, and the full sequence `[begin@50, change@75, commit@76, discrete@76]` is verified exactly.
- **P1b. Keyboard-during-drag Radix quirk discovered and documented.** While strengthening the drag test, we found that Radix fires `onValueCommit` **before** `onValueChange` on keyboard steps — because the commit call is synchronous inside the `setValues` updater (`updateValues(next, atIndex, { commit: true })` → `setValues(prev => { if (hasChanged && commit) onValueCommit(nextValues); return nextValues; })`), so the commit runs before React flushes the state change and fires `onValueChange`. A mid-drag keyboard step therefore produces `[commit@next, discrete@next]` in that order. This is load-bearing for anyone reading the test: the "discrete after commit" tail is an artifact of Radix's order, not a bug in TugSlider. Documented in the test-file comments.
- **P2. `draggingRef` leak-recovery safety net.** If the user pointerdowns on the slider and releases outside the browser window (pointer capture lost, Radix `onValueCommit` never fires), `draggingRef` would previously stay stuck at `true` and every subsequent keyboard step would incorrectly dispatch `change + commit` instead of `discrete`. Fix: `useEffect` installs always-on window-level `pointerup` + `pointercancel` listeners that unconditionally clear `draggingRef`. They're trivially cheap (one ref write) and don't dispatch anything — "commit" semantics remain Radix's responsibility via the normal path; the safety net only closes the leak window. Tested via `window.dispatchEvent(new Event("pointerup"))` followed by a keyboard step, which must produce exactly one `discrete` (not `change + commit`).
- **P3. Escape-mid-drag `cancel` phase.** Previously claimed "impossible" because Radix has no mid-drag cancel hook. Fix: `handleThumbKeyDown` now intercepts `Escape` during an active drag (`draggingRef.current === true`), dispatches `phase: "cancel"` with the pre-drag value from a new `beginValueRef` snapshot (so parents can roll back a live preview without buffering begin themselves), clears `draggingRef`, and sets `cancelledRef` to suppress any follow-up Radix `onValueCommit`. Two new tests verify: (a) `[begin@40, change@50, cancel@40]` exact sequence on Escape-mid-drag, (b) a post-cancel keyboard step dispatches exactly one `discrete` (no stale drag state). Pointer-cancel for drag-outside-window is still not distinguished from release — documented in the module docstring as a known limitation requiring consumer-level handling.
- **P4. `TugValueInput` spurious-dispatch guard.** Previously, tabbing through a form of untouched inputs fired one `setValue` dispatch per blur even when `parsed === value`. Each walked the responder chain. Fix: `onBlur` and the `ArrowUp`/`ArrowDown` handlers all now guard with `parsed !== value` / `next !== value` before calling `dispatchCommit`. React setState already bails on identical values, but the chain walk still happened — guarding at dispatch time saves every responder in the path. Test: focus + blur without edits produces zero dispatches.
- **P5. Wheel-event claim removed from docs.** The original plan text and my propagated docstrings claimed "keyboard/wheel" discrete dispatches, but Radix slider does not bind wheel events at all — `onValueChange` never fires from a wheel scroll. Fixed in `tug-slider.tsx`, `use-responder-form.tsx`, `gallery-slider.tsx`, and the roadmap audit text. Also expanded the keyboard enumeration to include Home/End/PageUp/PageDown (which Radix does bind via `onHomeKeyDown`/`onEndKeyDown`/step handlers).
- **P6. `effectiveDisabled` defence-in-depth guard.** Radix refuses to fire `onValueChange` when `disabled` is true (verified in `react-slider/dist/index.mjs`), but `handleSliderChange`, `handleSliderCommit`, and `handleThumbKeyDown` now each short-circuit on `effectiveDisabled` as a second safety net. If Radix ever regresses or a synthesized dispatch bypasses the disabled gate, the TugSlider layer still refuses to emit. Test: disabled slider + keyboard arrow + Escape produces zero dispatches.
- **Unit test coverage — 13 tests total** in `src/__tests__/tug-slider.test.tsx` after the hardening pass. Scenarios: keyboard-only → single `"discrete"`, pointerdown begin@current, pointerdown hit-test producing `begin + change`, full pointerdown+keyboard sequence producing `begin + change + commit + discrete` with exact numeric values, window-pointerup leak recovery, Escape-mid-drag `cancel` with pre-drag value, post-cancel keyboard dispatches `discrete` cleanly, disabled swallows pointerdown, disabled swallows keyboard (second safety net), auto-derived sender id stability across a drag, two-slider sender disambiguation, nested `TugValueInput` inherits slider sender id, nested `TugValueInput` no-op blur produces zero dispatches. All driven through a real `ResponderChainManager` + `observeDispatch` observer — no dispatch layer stubs.
- **Verification (post-hardening).** `bun run check` clean, `bun test` → **1865 pass / 0 fail** (1852 baseline + 13 new TugSlider tests).

**Tuglaws conformance — post-A2.6/A2.7 audit**

A read-through of `tuglaws/tuglaws.md` after A2.7 shipped surfaced two real issues in the A2.6/A2.7 code, plus one apparent issue that turned out to be a misinterpretation. Fixes applied:

- **L03 compliance — useLayoutEffect for event-dependent setup.** The P2 leak-recovery listener in `tug-slider.tsx` was installed via plain `useEffect`. L03 requires "setup that keyboard/pointer handlers require" to run before paint. Although `useEffect` runs before user interaction can reasonably occur in practice, the safer pattern for an invariant-level law is `useLayoutEffect` — it runs synchronously after DOM mutations and before paint, eliminating the timing window entirely. Fix: one-word swap + import change + an explanatory comment pointing at L03.

- **L11 clarification — text editors as responders.** `tuglaws.md` L11 previously read "controls (buttons, sliders, pickers) are not responder nodes." A strict reading contradicts the A2.7 migration (and the `tug-prompt-input` precedent) where text editors register for `cut`/`copy`/`paste`/`selectAll`/`undo`/`redo`. Fix: updated L11 to carve out text editors explicitly — components that own internal editing state (caret, selection, undo stack, content document) *are* responder nodes, because they own the state the actions operate on. Non-editing controls (buttons, sliders, checkboxes, tabs, accordions, popup menus) are still dispatch-only, per the original intent.

- **L06 / L08 not applicable to slider values — initially misread as a violation.** The A2.6 gallery-slider pattern — `setState` on every `"change"` dispatch during a drag — was initially flagged as an L06 violation ("appearance changes go through CSS and DOM, never React state") and an L08 violation ("live preview is appearance-zone only"). A first attempt at a fix introduced `useSliderValuePreview` in the gallery, added an imperative `valueInputDomRef` path in `TugSlider`, and rewrote the test fixture to skip `setState` on change. The result was a broken slider: Radix's thumb position is driven by the controlled `value` prop through `useControllableState`, and `useControllableState` always reads from the prop when one is provided — so a parent that skips setState on change leaves Radix's internal state frozen, the thumb stuck, and the drag nonfunctional. There is no "DOM-only" path for Radix thumb positioning without replacing Radix wholesale.

  On reconsideration, neither L06 nor L08 actually applies to a value-picker slider:

  - **L06** is about ephemeral visual effects — hover highlights, focus rings, `data-state` toggles, active-press animations. State whose only purpose is appearance. A slider value is semantic data: it represents a setting the user is choosing, and the thumb position is derived from that data. Data flowing through React to drive a visual is the normal React contract.
  - **L08** is explicitly scoped to *mutation transactions* — the "preview → commit" UX pattern where a draft mutation is visualized before being persisted (see `gallery-mutation-tx.tsx`). A volume or font-size slider is not a mutation transaction: there is no "uncommitted preview" state. Every intermediate value IS a committed value. Phases still carry useful semantics (`begin` snapshots for cancel, `cancel` rolls back, `commit` marks the final value) but the consumer is free to treat every phase as a state update.

  The failed fix was fully reverted:
  - `gallery-slider.tsx` restored to unary setters bound into `setValueNumber`.
  - `tug-slider.tsx` — removed `valueInputDomRef` and the imperative nested-input update; dropped the L06/L08 section of the module docstring; added a new section explaining why slider values are semantic data and why L08 is mutation-tx-scoped.
  - Tests: removed the L08-specific tests (imperative display, commit sync, L08 drag sequence) and renamed `L08Slider` back to `StatefulSlider`. Restored the "keyboard step during in-progress drag" test with the `[begin@50, change@75, commit@76, discrete@76]` sequence — those are the values that actually flow when the wrapper setState on every change (Radix reads the updated prop and steps from 75 → 76, not from the stale 50).

  Net effect of the L06/L08 investigation: docstring and audit-doc clarifications explaining the scope of L06/L08 and why sliders don't fall under them. Code back to where it was after A2.6 hardening, plus the L03 fix and L11 clarification that were real.

- **Verification (tuglaws pass).** `bun run check` clean, `bun test` → **1886 pass / 0 fail** (1865 pre-A2.7 baseline + 21 A2.7 tests; slider test count stays at the 13 from post-hardening).

#### A2.7 — Text editors: `tug-input`, `tug-textarea`

Register as responders (like `tug-prompt-input` already does) for `cut`, `copy`, `paste`, `selectAll`, `undo`, `redo`. Each of these editor variants has its own undo stack; the chain's innermost-first walk automatically sends undo/redo to the focused editor per the Part 4 macOS decision.

No callback props to remove on these — they inherit from Radix/native input. The change is purely additive: they become responders that handle editing actions.

After A2.7, the keybinding map's ⌘Z, ⌘X, ⌘C, ⌘V, ⌘A all route to the focused editor without per-component keyboard wiring.

**As-shipped — A2.7**

- **Two-path rendering to preserve no-provider ergonomics.** `useResponder` deliberately throws when called outside a `ResponderChainProvider` (this is the contract for components like `tug-prompt-input` / `tug-card` where chain participation is load-bearing). But `TugInput` and `TugTextarea` are leaf form controls that must still work in standalone previews, tests that don't set up the chain, and any consumer who renders them outside the canvas. Rather than weaken `useResponder`'s strict invariant, both components branch at render time on `useResponderChain()`: `null` → render a `TugInputPlain` / `TugTextareaPlain` variant (pre-A2.7 behavior, no chain registration); non-null → render the `WithResponder` variant that registers and wires the six handlers. React sees two different component types, so the branch is decided at mount and stays stable across renders — provider identity is stable in real apps, so the switch never fires in practice.
- **Six editing actions via native APIs.** Each handler delegates to the native DOM API on the underlying element:
  - `cut` → `document.execCommand("cut")`
  - `copy` → `document.execCommand("copy")`
  - `paste` → two-phase: sync `navigator.clipboard.readText()` kick-off inside the user gesture, then a continuation that inserts via `setRangeText` + synthetic `input` event dispatch so controlled React inputs stay in sync
  - `selectAll` → `input.select()` / `textarea.select()` (native method, no execCommand needed)
  - `undo` → `document.execCommand("undo")`
  - `redo` → `document.execCommand("redo")`
- **Why `execCommand` for cut/copy/undo/redo.** `document.execCommand` is formally deprecated but still works in every major browser for native input elements, and it is the *only* API that integrates with the input's built-in undo stack. A cut via `navigator.clipboard.writeText` + manual deletion does not push the deletion onto the undo stack, so ⌘Z cannot reverse it. Using execCommand routes cut/copy/undo/redo through the browser's legacy editing infrastructure and preserves the native undo behavior that users expect. The TugInput docstring documents this rationale for future maintainers who might be tempted to "modernize" away from execCommand.
- **Why Clipboard API for paste (with a documented limitation).** `document.execCommand("paste")` is blocked in Chrome for web pages on security grounds, so there's no universal execCommand path for paste. TugInput uses `navigator.clipboard.readText()` followed by `input.setRangeText()` to insert at the current caret position. **Limitation**: paste via `setRangeText` does *not* push the paste onto the native undo stack, so ⌘Z after a paste will undo the previous edit, not the paste itself. This is a browser-level constraint; flagged in the docstring so consumers aren't surprised. The two-phase handler pattern (synchronous clipboard read, continuation for insertion) matches the `tug-prompt-input` precedent and lets menu activation blinks precede the DOM mutation.
- **Defence-in-depth disabled guards.** Every handler short-circuits on `effectiveDisabled`. Under normal focus flow a disabled input never becomes first responder (browser blocks focus) and so never receives dispatches, but the guard defends against consumers who call `manager.dispatchTo(id, ...)` directly. Verified by test: disabled TugInput + `cut`/`copy`/`paste`/`selectAll`/`undo`/`redo` dispatches all produce zero effects on the DOM.
- **Ref composition.** The responder variants compose three refs onto one DOM element: the consumer's forwarded ref, an internal ref used by the action handlers (to reach `selectionStart`, `select()`, `setRangeText()`), and the `responderRef` from `useResponder` (which writes `data-responder-id` for `findResponderForTarget`). For TugTextarea, which has a more elaborate body (auto-resize effect, character counter, conditional wrapper `<div>` for `maxLength`), the ref composition is factored into a shared `TugTextareaBody` helper that both variants render through via an `extraRef` prop, so the body logic stays in one place.
- **Data-responder-id placement on TugTextarea.** The `data-responder-id` attribute lives on the `<textarea>` element itself, *not* on the `maxLength` wrapper `<div>`. `findResponderForTarget` walks from the event target (always the focused element inside the textarea) up the DOM, so placing the attribute on the textarea is what makes focusin promotion work. A test verifies this placement explicitly: the wrapper div must not carry the attribute.
- **Keybinding map untouched.** A2.7 is purely additive — the existing `⌘A`/`⌘X`/`⌘C`/`⌘V` bindings in `keybinding-map.ts` already dispatch `selectAll`/`cut`/`copy`/`paste` through the chain (with `preventDefaultOnMatch: true`). Before A2.7 those dispatches found no handler when the focused element was a plain TugInput, so the capture listener preventDefaulted the keystroke and the native clipboard operation never ran — a silent bug. After A2.7, the focused TugInput is first responder and handles the action, and the native behavior is replaced by our execCommand-routed equivalent. `⌘Z`/`⌘⇧Z` are not yet in the keybinding map — those land in A3 (R4 phase) as planned.
- **Unit test coverage.** Two new test files, 21 tests total:
  - `src/__tests__/tug-input.test.tsx` — 11 tests: two-path rendering (plain + responder variants), focusin promotion (single input + two-input disambiguation), all six action handlers verified via a `document.execCommand` spy (happy-dom doesn't implement execCommand, so the stub is deterministic), disabled guard for all actions including `selectAll`.
  - `src/__tests__/tug-textarea.test.tsx` — 10 tests: same coverage as TugInput plus a test that `data-responder-id` lives on the textarea element rather than the `maxLength` wrapper div.
- **Verification.** `bun run check` clean, `bun test` → **1886 pass / 0 fail** (1865 baseline + 21 new A2.7 tests).

**Post-A2.7 follow-up — critical fixes for selection, context menus, and gaps**

An honest audit of A2.6 + A2.7 in production surfaced a fundamental bug and several real gaps. All fixed in a dedicated pass before A2.8:

- **P0 — selection and caret were broken on TugInput / TugTextarea / TugValueInput.** `body { user-select: none }` in `globals.css` is the baseline for the whole app (so selection can't start in card chrome), and card content areas opt back in with `user-select: text`. But none of the input CSS files opted back in, so focused inputs inherited `user-select: none` — users could type but the caret never appeared and ranged selection was impossible. `tug-prompt-input` worked because it always lives inside a card content area that had already opted in. Fix: add `user-select: text` and `-webkit-user-select: text` to `.tug-input`, `.tug-textarea`, and `.tug-value-input` base class rules. One-line fixes per file; explanatory comment points at globals.css so nobody reintroduces the gap.

- **P0 — right-click context menus missing on TugInput / TugTextarea / TugValueInput.** `tug-prompt-input` has a full `TugEditorContextMenu` wired since A1 (cut/copy/paste items that dispatch through the chain), but A2.7 didn't carry the pattern to the other editors. Fix: added portaled `TugEditorContextMenu` to all three responder variants with identical shape — cut / copy / paste / separator / selectAll items, `hasSelection` sampled from the input's `selectionStart !== selectionEnd` at menu open time to gate Cut/Copy enablement, action dispatches routed through the chain and back to the focused input via innermost-first walk. Native input right-click does NOT auto-select a word (match that behavior).

- **Tier 1 — TugValueInput migrated to A2.7 two-path responder pattern.** Before the fix, focusing a TugValueInput and pressing `⌘A` silently did nothing — the keybinding map's `preventDefaultOnMatch: true` killed the keystroke, no handler was registered on the input, native `⌘A` was already suppressed. Same dormant break for `⌘X` / `⌘C` / `⌘V`. Fix: full migration to the A2.7 pattern. Two-path rendering via `useResponderChain() === null` → plain variant (pre-A2.7 behavior); non-null → responder variant with six handlers (cut/copy/paste/selectAll/undo/redo) and a right-click context menu. The imperative display/edit cycle (editing ref, justFocused ref, display-value sync via `useLayoutEffect`, formatter-aware focus/blur, Enter/Escape/arrow handling) was extracted into a `useValueInputEditing` hook so both variants share it without duplication. 500 lines of component, ~200 lines of shared hook — every path documented.

- **Tier 1 — `src/__tests__/tug-value-input.test.tsx` added, 16 tests.** Three suites: (1) `setValue` dispatches from the editing cycle — blur with edit, blur without edit (no-op guard), Escape reverts, ArrowUp / ArrowDown dispatch, ArrowUp at max + ArrowDown at min clamp without dispatching; (2) two-path rendering — no `data-responder-id` standalone, present inside provider; (3) editing action handlers — cut / copy / undo / redo via execCommand spy, selectAll via `input.selectionStart/End` assertions, focusin promotion, disabled guard eats all five dispatches. This closes the gap called out in the previous audit: `TugValueInput`'s standalone dispatch paths were previously tested only indirectly via `tug-slider.test.tsx`.

- **Tier 2 — TugPromptInput gained selectAll / undo / redo handlers.** The A1 chain-native migration only covered cut/copy/paste. The plan text for A2.7 said "register as responders (like `tug-prompt-input` already does) for cut, copy, paste, selectAll, undo, redo" — but the precedent was incomplete. The engine already had `selectAll()` / `undo()` / `redo()` methods (verified via grep); the fix was wiring three new `useCallback` handlers into the `useResponder` actions map and adding a `Select All` item to the context menu (after a separator). No test additions — these delegate to engine methods that already have coverage in the tug-text-engine tests.

- **Tier 2 — `mountedRef` guard in paste continuation.** `TugInput`, `TugTextarea`, and `TugValueInput` all start an async `navigator.clipboard.readText()` in their paste handler and return a continuation that writes into the input via `setRangeText`. If the component unmounts between dispatch and continuation resolution, the continuation would write to a detached element — a silent no-op in the browser but a footgun if the handler ever grows side effects beyond the DOM write. Fix: `useRef(true)` flipped to `false` in a `useEffect` cleanup, checked in the continuation before the `setRangeText` call.

- **Tier 3 — TugSlider pointercancel → cancel phase dispatch.** Previously the window-level `pointerup` / `pointercancel` listener was a combined leak-recovery no-op. Now the two events are split: `pointerup` still just clears `draggingRef` (normal release; Radix's `onValueCommit` handles the commit dispatch), but `pointercancel` — which fires when the OS aborts a gesture (iOS native scroll takes over, system modal steals input, pointer capture released) — dispatches `phase: "cancel"` with the pre-drag value snapshot and sets `cancelledRef` to suppress any follow-up spurious `onValueCommit` from Radix. The listener uses the live-ref lookup pattern (`dispatchSetValueRef.current`) so the single mount-time registration can see the current-render closure without re-registering. Two new tests verify both paths: pointercancel dispatches cancel@pre-drag; pointerup dispatches nothing from the safety net.

- **Verification (post-fixes).** `bun run check` clean, `bun test` → **1904 pass / 0 fail** (1886 post-A2.7 baseline + 16 TugValueInput tests + 2 pointercancel tests). Total tests across the A2.6/A2.7 surface: 15 TugSlider + 16 TugValueInput + 11 TugInput + 10 TugTextarea = 52 unit tests covering the value-editing and text-editing components end-to-end.

**Post-A2.7 follow-up II — factor-out and Safari paste fix**

Two bugs surfaced immediately after the first post-A2.7 pass landed:

1. **Paste handlers were copy-pasted across three components.** `tug-input.tsx`, `tug-textarea.tsx`, and `tug-value-input.tsx` each had their own near-identical copies of the six editing-action handlers (cut / copy / paste / selectAll / undo / redo), the context-menu state + open handler + close + `menuItems`, and the `mountedRef` paste guard — ~180 lines triplicated. Any future edit to paste, cut, or the menu items would have to land in three files in lock-step.
2. **Safari's "Paste" permission UI still fired from the context menu, and paste was broken from the context menu entirely on WebKit.** The root cause was an architectural mistake in the previous pass: the paste handler had an empty sync body and called `execCommand("paste")` inside its continuation. Safari's `execCommand("paste")` requires the call to happen inside the currently-dispatching user gesture — not merely under transient activation — so when the context menu ran the continuation 120ms later from `playMenuItemBlink(...).finally()`, `execCommand` returned `false` on Safari and the handler fell through to `navigator.clipboard.readText()`, which triggers Safari's floating permission UI on every invocation. The prior pass's unit test only validated the spy's `true` path, never the "execCommand is outside the gesture → falls through to readText" path that's always taken on real Safari from the menu.

Fix — one new file plus one pattern change:

- **New `tugdeck/src/components/tugways/use-text-input-responder.tsx`** — a shared `useTextInputResponder<T extends HTMLInputElement | HTMLTextAreaElement>` hook that owns the six editing-action handlers, the right-click context menu state, and the responder-node registration. Accepts `{ inputRef, disabled }`, returns `{ responderRef, menuState, handleContextMenu, closeMenu, menuItems }`. The module docstring is the single source of truth for the execCommand-vs-Clipboard-API rationale, the two-phase dispatch pattern, and the paste-sync invariant. All three input components now consume this hook and have zero editing-action code of their own — just the ref-composition boilerplate and the context-menu JSX.

- **Paste now runs `execCommand("paste")` in the sync phase, not the continuation.** On Safari it succeeds inside the currently-dispatching gesture: inserts from the clipboard natively with native undo-stack integration, no permission prompt. On Chrome/Firefox it returns `false`, and the hook then kicks off `navigator.clipboard.readText()` — still in the sync phase, still inside the gesture — and returns a continuation that awaits the promise and inserts via `setRangeText`. Trade-off: on Safari the text appears before the menu item's activation blink rather than after, because Safari simply does not allow the opposite ordering; the alternative is a broken paste UI. Keyboard ⌘V is indistinguishable from a native paste on every browser.

- **Refactor impact.** `tug-input.tsx`: 417 → 252 lines (−165). `tug-textarea.tsx`: 519 → 420 lines (−99). `tug-value-input.tsx`: 623 → 534 lines (−89). `use-text-input-responder.tsx`: 335 lines new (heavily commented — the hook body is ~180 lines). Net: single source of truth for every native text input in the suite, and every future paste / context-menu change lands in exactly one file.

- **Test updates.** The three paste unit tests (`tug-input.test.tsx`, `tug-textarea.test.tsx`, `tug-value-input.test.tsx`) previously asserted "sync phase does nothing, continuation calls `execCommand("paste")`" — the inverted invariant that masked the Safari bug in the first place. Rewrote them to assert "sync phase calls `execCommand("paste")`, spy returns true (Safari path), no continuation, `clipboard.readText` never called." The test comments now point at `use-text-input-responder.tsx` and explain why the sync phase is load-bearing, so the next person who touches this doesn't accidentally move the call back into the continuation.

- **Verification.** `bun run check` clean, `bun test` → **1907 pass / 0 fail** (1904 baseline + 3 paste tests unchanged in count, updated in assertions).

#### A2.8 — Floating surfaces: `tug-confirm-popover`, `tug-alert`, `tug-sheet`, `tug-popover`

Dispatch `confirmDialog` / `cancelDialog` / `dismissPopover`. Remove `onConfirm`, `onCancel`, `onOpenChange`. Per decision below, `dismissDialog` is **not** added — every dismissal (Escape, click-outside, Cmd+., Cancel button) routes through `cancelDialog`, matching the Part 4 "cancel is the dismissal semantic" convention. The four surfaces also absorb the `observeDispatch` retrofit that Phase R6 originally deferred to A4 — folded into A2.8 so each surface becomes fully chain-native in one pass instead of being revisited.

**Lay of the land — prep audit before implementation**

*Scope — four files, three distinct migration shapes*

| File | Lines | Callback props to remove | Imperative API to preserve |
|---|---:|---|---|
| `tugdeck/src/components/tugways/tug-confirm-popover.tsx` | 177 | `onConfirm`, `onCancel`, `onOpenChange` | `TugConfirmPopoverHandle.confirm()` → `Promise<boolean>` |
| `tugdeck/src/components/tugways/tug-alert.tsx` | 360 | `onConfirm`, `onCancel`, `onOpenChange` | `TugAlertHandle.alert(opts)` + `TugAlertProvider` + `useTugAlert()` |
| `tugdeck/src/components/tugways/tug-sheet.tsx` | 499 | `onOpenChange` | `TugSheetHandle.open/close` + `useTugSheet()` → `{showSheet, renderSheet}` |
| `tugdeck/src/components/tugways/tug-popover.tsx` | 157 | `onOpenChange` (thin Radix wrapper) | — |

The imperative Promise APIs (`confirm()`, `alert()`, `useTugSheet()`) are **not** the L11 violation the audit is pointing at — they are a legitimate Promise adapter over chain dispatch and stay intact. Only the `onConfirm` / `onCancel` / `onOpenChange` React callback props leave. Internally, the resolver pairs that currently fire from inline button `onClick` handlers will be rewired to fire from `confirmDialog` / `cancelDialog` action handlers registered via `useOptionalResponder`.

*Vocabulary status*

`action-vocabulary.ts` already has `confirmDialog`, `cancelDialog`, `dismissPopover`, `openMenu` (lines 104–108). **No new actions are added in A2.8.** `dismissDialog` was floated in earlier plan text but is rejected in favor of reusing `cancelDialog`, matching the documented convention that "cancel" is the dismissal semantic for dialog-like responders. Escape, Cmd+., click-outside, and explicit Cancel buttons all dispatch `cancelDialog` with the same resolver behavior.

`TugAction` is now generic (`TugAction<Extra extends string = never>`, post-`38918b16`), so gallery cards that need demo-only actions opt in via `TugAction<GalleryAction>` without polluting the production union. A2.8 does not need any extra action names — the existing dialog vocabulary is sufficient.

*Consumers that will need updating*

- `tugdeck/src/components/tugways/cards/gallery-confirm-popover.tsx` — 6 `onConfirm`/`onCancel` call sites (lines 60–61, 84–85, 108–109, 132–133, 145–146).
- `tugdeck/src/components/tugways/cards/gallery-alert.tsx` — audit during implementation.
- `tugdeck/src/components/tugways/cards/gallery-sheet.tsx` — audit during implementation.
- `tugdeck/src/components/tugways/cards/gallery-popover.tsx` — audit during implementation.
- `tugdeck/src/deck-manager.ts:310` mounts `TugAlertProvider`. Stays the same — the singleton instance is wired internally, not via callback prop.
- Any production `TugConfirmPopover` / `TugAlert` call sites outside galleries (to be enumerated during sub-step 1).

Gallery consumers register a responder (`useResponder`, or `useResponderForm` if slot-based setters are cleaner) with `confirmDialog` / `cancelDialog` / `dismissPopover` handlers that drive their local result display.

*Architectural wrinkles*

1. **`useOptionalResponder` replaces two-path forking.** A2.6/A2.7 initially used `useResponderChain() === null` to branch into plain vs. responder component types for leaf inputs that had to render outside a provider — that pattern was retired in `0a416494`. A2.8 uses `useOptionalResponder` from day one: one component, tolerant of null manager, preserves DOM element identity across provider transitions so tests that mount a surface standalone and wrap it mid-run don't flip React's component identity. The strict `useResponder` stays reserved for load-bearing chain participants (`tug-card`, `tug-prompt-input`, `deck-canvas`).

2. **Promise resolvers move behind the action handler.** Today `handleConfirm` / `handleCancel` are inline functions that (a) set `open=false`, (b) resolve the pending promise via `resolverRef.current`, and (c) call `onConfirm` / `onCancel`. Post-migration: the action handlers registered via `useOptionalResponder`'s actions map do (a) and (b); (c) is deleted. Internal button `onClick` handlers dispatch `confirmDialog` / `cancelDialog` through the chain, which walks back to the same component's handler — a short loop, but architecturally consistent with A2.1–A2.7.

3. **`tug-popover.tsx` has no intrinsic confirm/cancel buttons.** It's a compound-API wrapper (`TugPopover` / `TugPopoverTrigger` / `TugPopoverContent` / `TugPopoverClose`) over Radix. The only user-interaction callback prop is `onOpenChange`. Migration: the popover becomes a responder that **handles** `dismissPopover` and `cancelDialog` by calling its internal `setOpen(false)`. It does **not** emit actions — dismissal from inside the popover's content is the consumer's responsibility (a `TugConfirmPopover` built on top, a menu item dispatching `dismissPopover`, or the `observeDispatch` path from sub-step 0).

4. **`dismissPopover` innermost-first walk.** `tug-editor-context-menu` already owns `dismissPopover` via `observeDispatch`. If a context menu is nested inside a `TugPopover` (plausible in gallery demos), the chain walks innermost-first and the editor context menu wins — the outer popover only closes if the menu's handler chose not to consume the action. This is correct semantically (close the innermost floating surface first) but deserves a sanity check during sub-step 4.

5. **`tug-sheet.tsx` is the largest file and has the most moving parts.** 499 lines covering: compound API (`TugSheet` / `TugSheetTrigger` / `TugSheetContent`), Radix `FocusScope` focus trapping, `tug-animator` `group()` entry/exit animations, `TugcardPortalContext` portaling into the card element, `inert` attribute management on `.tugcard-body` for card-scoped modality, trigger-element focus restoration, and the `useTugSheet()` Promise hook. The A2.8 change is surgical: register as a responder, add a `cancelDialog` handler that calls `onOpenChange(false)` internally, and drop the `onOpenChange` **prop** (keeping the internal wiring). Everything else stays.

6. **`tug-alert` override-ref pattern stays.** The imperative `alert(options)` call writes into `overrideRef` before flipping `open` true, and the override values are deliberately **not** cleared during close so the exit animation doesn't revert to singleton defaults. This behavior survives A2.8 unchanged — only the `onConfirm` / `onCancel` / `onOpenChange` prop boundaries are touched.

7. **`TugAlertProvider` singleton pattern stays.** `deck-manager.ts` mounts one `TugAlert` instance; `useTugAlert()` returns a `showAlert` function routed through a context. The provider doesn't change — the singleton's internal buttons switch from `onClick={handleConfirm}` to `onClick={dispatch("confirmDialog")}`, and `handleConfirm` is wired as the `confirmDialog` action handler instead of a button prop.

*Pre-step 0 — retrofit `observeDispatch` to `tug-popup-button`*

Before A2.8 sub-step 1, establish a second `observeDispatch` precedent beyond `tug-editor-context-menu`. Today `tug-popup-button.tsx:226` uses `useResponderChain` but does not subscribe to `observeDispatch` — its dismiss path is still Radix-owned. Retrofitting this one surface before A2.8 accomplishes two things: (a) proves the pattern generalizes beyond the editor context menu to a plain popup; (b) gives A2.8 sub-steps 1–4 a concrete, recent template to copy from instead of reaching back to `tug-editor-context-menu.tsx:355`.

Scope of pre-step 0: add a single `useLayoutEffect` to `tug-popup-button.tsx` that subscribes to `manager.observeDispatch` while the popup is open, dismissing on any dispatch (with a blink guard equivalent to the editor context menu's). New tests verify the subscribe/unsubscribe lifecycle and the blink-guard behavior. `tug-context-menu` and `tug-tooltip` are **not** yet chain-native and stay out of scope — they are separate chain-onboarding work for Phase A4, not pre-A2.8.

*Proposed implementation order — seven sub-steps*

Each sub-step is its own commit. Sub-steps run sequentially, not bundled; this matches user preference ("go sub-step by sub-step"). The A2.6/A2.7 pattern of landing a core step and then running factor-out follow-ups (factor-out, Safari paste fix, observeDispatch retrofit) is expected for A2.8 too, landed as additional commits after the initial sub-step completes.

0. ✅ **Pre-step — retrofit `observeDispatch` to `tug-popup-button`.** Landed in `ce0f8ad5`. Established the second precedent beyond `tug-editor-context-menu` and gave sub-steps 1–4 a concrete template.

1. ✅ **`tug-confirm-popover.tsx` — smallest migration, cleanest shape.** Landed in `b8edbc55`. Registered responder via `useOptionalResponder`, added `confirmDialog`/`cancelDialog` handlers owning the resolver pair, removed `onConfirm`/`onCancel`/`onOpenChange` props, buttons dispatch via `manager.dispatch`, `observeDispatch` subscription for external dismissal, `confirm()` imperative Promise API preserved.

2. ✅ **`tug-alert.tsx` — largest API surface, architecturally identical.** Landed in `051846c5`. Same treatment as confirm-popover. **Exception**: `tug-alert` intentionally does NOT subscribe to `observeDispatch` — alerts are app-modal and must stay open until the user explicitly confirms or cancels. `TugAlertProvider` and `useTugAlert` singleton preserved unchanged externally. Cmd+. routes through the chain via cancel.

3. ✅ **`tug-sheet.tsx` — largest file, smallest migration surface.** Landed in `42391384`. Registered responder, `cancelDialog` handler closes the sheet, dropped `onOpenChange` prop, Escape + Cmd+. route through chain. **Decision**: sheets opt OUT of `observeDispatch` — they are card-modal with opaque scrim that swallows pointer events, so chain-reactive dismissal would surprise users. `useTugSheet` Promise hook preserved (now keys via `callId` for key-based remount and dispatches `cancelDialog` on close for exit animation). Also shipped: Safari two-click fix (`handleContentMouseDown`) and `useOptionalResponder` stale-focus re-promotion for the `autoFocus` timing hole (commits `42391384` + follow-ups). Migrated `gallery-sheet.tsx` consumer.

4. ✅ **`tug-popover.tsx` — thin Radix wrapper, handler-only.** Landed in `7cdf3e2b`. TugPopover rewritten as `forwardRef<TugPopoverHandle>` with internal state and imperative `open/close/isOpen`; dropped `open`/`onOpenChange` props. **Architectural wrinkle discovered**: responder registration had to move into a nested `TugPopoverContentShell` rendered inside `Popover.Content`, because hooks called at the outer `TugPopoverContent` level run even when `open=false` (component function still evaluates to produce JSX for Radix's Presence system) and auto-promote themselves as first responder, blocking inner composites (`TugConfirmPopover`) from ever receiving chain dispatches. Moving the hook inside the nested shell ties the responder lifecycle to Radix's actual mount lifecycle. Shell handles `cancelDialog`/`dismissPopover` and subscribes to `observeDispatch`. **Additional filter on observeDispatch**: dispatches originating inside the popover (detected by `document.activeElement` being contained in the content element) are skipped so form controls (TugSwitch, TugInput, etc.) don't self-dismiss their own container. New `useTugPopoverClose()` hook lets nested buttons (e.g. a "Save Changes" button) explicitly dismiss the enclosing popover through a chain dispatch. `TugConfirmPopover` migrated to use `TugPopoverHandle` ref. Migrated `gallery-popover.tsx` consumer.

5. ✅ **Test coverage for the four surfaces.** Four dedicated test files, 33 tests total:
   - `tug-confirm-popover.test.tsx` (6 tests) — chain confirm/cancel, observeDispatch dismissal, Radix Escape, no-provider fallback.
   - `tug-alert.test.tsx` (8 tests) — chain confirm/cancel, Escape, Cmd+., modal semantics (no auto-dismiss), no-provider fallback, `TugAlertProvider`+`useTugAlert` singleton.
   - `tug-sheet.test.tsx` (10 tests) — `defaultOpen`, chain cancel, Escape, Cmd+., modal semantics, imperative ref handle, `useTugSheet` Promise API (explicit close + chain dismiss), uncontrolled trigger path.
   - `tug-popover.test.tsx` (9 tests) — imperative handle, chain cancel/dismiss, observeDispatch external dismissal + focus-inside filter, responder lifecycle (open/close/reopen), `useTugPopoverClose`, no-provider fallback.

   Every A2.8 invariant is exercised: chain-native buttons, chain-native cancellation, observeDispatch behavior (positive for popover+confirm-popover, negative for alert+sheet modals), Radix-level dismissal re-emitting `cancelDialog`, no-provider fallbacks, imperative Promise APIs.

6. ✅ **Factor-out pass — Safari focus-shift suppression.** Landed as the A2.8 wrap-up commit. Extracted the identical `handleContentMouseDown` function (plus ~20 lines of rationale comment) from all four surfaces into `internal/safari-focus-shift.ts` as a plain `suppressButtonFocusShift` function. Other duplication (button dispatch-or-fallback, `useId`-based sender derivation, promise-resolver-and-close) was considered and rejected as not warranting a shared hook — each pattern was either too small, too specific, or structurally divergent between the two surfaces that shared it. The resolver-pair "shared hook" speculated in the original plan text was specifically rejected: `tug-alert`'s `overrideRef` pattern and `tug-confirm-popover`'s resolver pattern have different structures, and a shared hook would fight both.

*A2.8 exit criteria (specializes the A2 exit criteria below)*

- Zero `onConfirm` / `onCancel` / `onOpenChange` props remain on the four floating-surface components' public interfaces.
- Each surface registers via `useOptionalResponder` and handles `confirmDialog` / `cancelDialog` / `dismissPopover` as appropriate.
- Each surface subscribes to `observeDispatch` while open (folding A4/R6 into A2.8).
- All four galleries demo the chain-native pattern via registered responders, no callback props at the consumer layer either.
- `bun run check` and `bun test` clean with added test coverage for all four surfaces.
- Sub-step 0 (`tug-popup-button` `observeDispatch` retrofit) lands before sub-step 1.

**Decisions locked in before implementation**

1. **`dismissDialog` vs `cancelDialog`.** Reuse `cancelDialog` for every dismissal path — no new action name. Part 4 convention is that "cancel is the dismissal semantic for dialog-like responders," and `cancelDialog` already exists in `action-vocabulary.ts`.
2. **Sub-step discipline.** One commit per sub-step. No bundling. Factor-out follow-ups land as additional commits after the initial sub-step completes, matching the A2.6/A2.7 rhythm.
3. **`observeDispatch` scope.** Folded into A2.8 (not deferred to A4), with a pre-A2.8 sub-step 0 that retrofits `tug-popup-button` first to establish the pattern. This leaves Phase A4 reduced to onboarding `tug-context-menu` and `tug-tooltip` to the chain (separate concern — those aren't chain-native yet).
4. **Imperative Promise APIs preserved.** `TugConfirmPopoverHandle.confirm()`, `TugAlertHandle.alert()`, `useTugAlert()`, `useTugSheet()` are not L11 violations — they are Promise adapters over chain dispatch and survive A2.8 unchanged. Only React callback props for user interactions (`onConfirm` / `onCancel` / `onOpenChange`) leave.

#### A2 exit criteria

- Zero tug-* interactive controls use React callback props for user interactions.
- Every control dispatches a typed action via the chain.
- Every gallery and card consumer registers responders with typed handlers.
- `bun run check` and `bun test` both clean.

**Grade impact after A2:** Consistency → A. The component library is now uniformly chain-native.

### Phase A3 — R4: Complete the macOS standard keybinding map (1 session) ✅

After A2, every component that needs to respond to a standard shortcut has a registered handler. Now add the bindings.

**Landed bindings (three sub-steps):**

| Shortcut | Action | Handler | Commit |
|---|---|---|---|
| ⌘Z | `undo` | `tug-prompt-input` / `use-text-input-responder` (editor continuation) | A3.1 `7c97e271` |
| ⇧⌘Z | `redo` | Same | A3.1 `7c97e271` |
| ⌘W | `close` | `tug-card` (via Tug.app File > Close Card Control frame, **A3.3**) | A3.1 + A3.3 |
| ⌘T | `addTabToActiveCard` | `deck-canvas` | A3.1 `7c97e271` |
| ⌘, | `showSettings` | `deck-canvas` (stub) | A3.1 `7c97e271` |
| ⌘. | `cancelDialog` | Four A2.8 floating surfaces | A3.1 `7c97e271` |
| ⌘F | `find` | `tug-card` (stub) | A3.1 `7c97e271` |
| ⇧⌘[ | `previousTab` | `tug-card` (wraps via `(idx-1+n)%n`) | A3.1 `7c97e271` |
| ⇧⌘] | `nextTab` | `tug-card` (wraps via `(idx+1)%n`) | A3.1 `7c97e271` |
| ⌘1..⌘9 | `jumpToTab` | `tug-card` (new handler, narrows `event.value: number`) | A3.2 `b0e08a8b` |

**Roadmap divergence: additions from the original table.**

- **⇧⌘[ / ⇧⌘]** were added during implementation. The handlers (`previousTab`, `nextTab`) already existed on `tug-card` with wrap-around arithmetic and were previously reachable only programmatically; the keybinding exposes them. macOS convention (Safari, Terminal) uses ⇧⌘[ / ⇧⌘] for tab navigation, not arrow keys.

**`KeyBinding` extension: static payloads.**

`KeyBinding` gained an optional `value?: unknown` field for the ⌘1..⌘9 → `jumpToTab` family, where the binding carries the 1-based tab index into the dispatch. The capture-phase pipeline spreads `value` into `dispatchForContinuation` only when defined, so payload-less bindings still dispatch events with `value` undefined (regression-guarded in `key-pipeline.test.tsx`). This is the first and only payload-carrying binding in the map; making it the precedent is cheaper than nine per-digit action names in `action-vocabulary.ts`.

**Tug.app menu side (A3.3).**

`File > Close Window` (bound to `NSWindow.performClose(_:)`) was swallowing ⌘W at the menubar before the WKWebView could see it. Renamed to `File > Close Card` with a custom `closeActiveCard(_:)` selector that sends a `close-active-card` Control frame. `action-dispatch.ts` registers the action to dispatch `close` through the responder chain, landing on `tug-card`'s existing handler. The tugdeck-side ⌘W entry in the keybinding map still exists for browser-only dev where no Swift menu is present — both paths converge on the same chain dispatch.

**Deferred to later phases:**

The original A3 table listed four more bindings that did not land this phase. Each has an explicit reason:

- **⌘⇧T `reopenTab`** — deferred. Requires a closed-tab history in `deck-manager.ts`, which is a new feature (closed-tab stack + bounded size + serialization to tugbank), not a keybinding map task. The action name exists in the vocabulary; a future phase can add the handler and a single map entry without reopening anything in A3.

- **⇥ / ⇧⇥ `focusNext` / `focusPrevious`** — deferred. The roadmap already marked this "sketch, not yet committed". Native Tab focus already works inside text inputs, and no user has reported a gap in tab-order handling across cards. A chain-wide `focusNext` would need a document-level handler that reads DOM-ordered `data-responder-id` attributes, and the design decision (keep in the chain vs. delegate to native focus) is a distinct architectural change that should stand on its own merits, not ride along with R4.

- **Escape → `cancelDialog`** — skipped. Radix `DismissableLayer` already closes each floating surface on Escape within its own scope, and every A2.8 surface routes that dismissal through `cancelDialog`. A global binding would risk double-dispatch (Radix + chain) and steal Escape from text-input editing modes where Escape has other intended meanings. ⌘. is sufficient for the "keyboard shortcut" requirement, and Escape behavior is working everywhere it is today.

**Exit criteria (revised):** every standard macOS shortcut whose action has a registered handler has exactly one entry in `keybinding-map.ts`, dispatches a typed action, and works end-to-end. Three shortcuts (⌘⇧T, ⇥/⇧⇥, Escape) are tracked as follow-ups with written rationale above.

### Phase A4 — R6: Retrofit `observeDispatch` to floating surfaces (1 session) ✅

Most of the surfaces originally scoped to A4 were folded forward into A2.8 (and its pre-step 0), which made them chain-native and attached `observeDispatch` at the same time. The invariants table in `tugdeck/src/components/tugways/internal/floating-surface-notes.ts` is the canonical summary of what each of the four A2.8 surfaces does and why.

**Already landed — inherited from A2.8 / pre-A2.8:**

| Surface | Chain-native | `observeDispatch` | Where |
|---|---|---|---|
| `tug-editor-context-menu` | ✓ | ✓ | predates A2.8 — original template |
| `tug-popup-button` (via `internal/tug-popup-menu`) | ✓ | ✓ | pre-A2.8 step 0 (`ce0f8ad5`) |
| `tug-confirm-popover` | ✓ | ✓ | A2.8 sub-step 1 (`b8edbc55`) |
| `tug-alert` | ✓ | ✗ deliberate (app-modal) | A2.8 sub-step 2 (`051846c5`) |
| `tug-sheet` | ✓ | ✗ deliberate (card-modal) | A2.8 sub-step 3 (`42391384`) |
| `tug-popover` | ✓ | ✓ with focus-inside filter | A2.8 sub-step 4 (`7cdf3e2b`) |

The modal opt-outs for `tug-alert` / `tug-sheet` are intentional: "close on any chain activity" would surprise users whose modal disappears because an unrelated shortcut fired. See `floating-surface-notes.ts:41`.

**What A4 actually touched:** the two surfaces explicitly parked during A2.8 planning — neither was chain-native yet, so this was onboarding work first, `observeDispatch` retrofit second. Same shape as pre-A2.8 step 0 for `tug-popup-button`.

- ✅ **A4.1 — `tug-context-menu`.** Landed in `236e3f63`. Items migrated to the `TugPopupButtonItem` shape (`action: TugAction`, optional `value`); `onSelect` / `onOpenChange` props dropped; activation dispatches via `manager.dispatchForContinuation`; local `open` state mirrors Radix via `onOpenChange`; `observeDispatch` subscription while open with `blinkingRef` self-dispatch guard. Chain-reactive dismiss and post-blink close both synthesize a document-level Escape keydown because Radix ContextMenu is uncontrolled (no `open` / `defaultOpen` props). Extracted `synthesizeEscapeDismiss()` helper. Only consumer was `gallery-context-menu.tsx`, migrated mechanically. New `tug-context-menu.test.tsx` (7 tests) covers no-provider ergonomics, contextmenu-event open, external-dispatch dismiss, and subscription lifecycle. Added minimal `DOMRect` polyfill to `setup-rtl.ts` because Radix ContextMenu's virtual-anchor path calls `DOMRect.fromRect()` and happy-dom does not ship it.

- ✅ **A4.2 — `tug-tooltip`.** Tooltips have no user-interaction action semantics (display-only), so L11 does not apply directly. The novel behavior is chain-reactive dismissal: a deliberate action elsewhere in the app is a strong signal the user has moved on from the hovered content. Always tracks a local `openMirror` state synced via `onOpenChange` (previously tracked only in `truncated` mode) so the effect has a stable gate and a programmatic close path. `useResponderChain()` is nullable — standalone renders without a provider still work and Radix's own hover/focus dismissal is untouched. No `blinkingRef` needed (tooltips never self-dispatch). `truncated` mode interaction: none — the suppress flag only gates open transitions. Exposed a `defaultOpen` prop (Radix-style) primarily for tests; seeds the initial state of `openMirror`. New `tug-tooltip.test.tsx` (7 tests) covers no-provider ergonomics, external-dispatch dismiss, subscription lifecycle, and controlled-mode `onOpenChange(false)` forwarding.

Template (from `tug-editor-context-menu.tsx:353`):

```tsx
useLayoutEffect(() => {
  if (!open || !manager) return;
  return manager.observeDispatch(() => {
    if (blinkingRef.current) return;
    setOpen(false);
  });
}, [open, manager]);
```

**Exit criteria (all met):**
- ✅ `tug-context-menu` items carry `action: TugAction` / optional `value`; `onSelect` / `onOpenChange` props removed; activation dispatches through the chain; subscribes to `observeDispatch` while open with a blink guard.
- ✅ `tug-tooltip` subscribes to `observeDispatch` while open and dismisses on external chain traffic.
- ✅ `gallery-context-menu.tsx` migrated to the new item shape.
- ✅ New dedicated test files for both surfaces (7 tests each) covering subscribe/unsubscribe lifecycle, blink guard (context menu), chain-native dispatch (context menu), controlled-mode forwarding (tooltip), and no-provider fallback.
- ✅ `bun run check` and `bun test` clean (2000 passing at A4.2 close).

### Phase A5 — Update `component-authoring.md` (1 short session, post-A2) ✅

Per Part 4 decision 5, this happened *after* A2 landed so the doc reflects reality, not aspiration. Scope expanded during the session: A5 also spun up a new sibling tuglaws document (`responder-chain.md`) that holds the mental-model foundation — the dispatch walk, first-responder promotion, the four dispatch shapes, `observeDispatch`, the keyboard pipeline, the registration hooks. The existing docs (`tuglaws.md` L11, `component-authoring.md`, `action-naming.md`) referenced "the responder chain" everywhere but nothing explained it; reconstructing the model required reading four implementation files plus scattered design decisions. The new doc is ~530 lines and is now the first thing a new contributor reads before touching chain-participant code.

**Landed:**

- ✅ **New: `tuglaws/responder-chain.md`** — the mental-model foundation. Covers why a chain exists (Cocoa lineage, the problem it solves), the three principals (control / responder / both), the `ActionEvent` shape and phase system, the dispatch walk with an ASCII diagram, first-responder promotion (pointerdown / focusin / auto-promotion / programmatic), the four dispatch shapes (`dispatch` / `dispatchForContinuation` / `dispatchTo` / `observeDispatch`), two-phase execution via continuations, the registration hooks (`useResponder` vs `useOptionalResponder` decision rule), dispatching from a control, the four-stage keyboard pipeline with an ASCII diagram, `observeDispatch` patterns with the `blinkingRef` guard, the default button stack, and six concrete anti-patterns with the right answer for each. Cross-links to [L11], [L03], [L07], [L08], [L20], `action-naming.md`, `component-authoring.md`, and every relevant source file.

- ✅ **`tuglaws.md`** — L11 gains a single trailing sentence pointing at `responder-chain.md` for the full mechanism. The law text stays untouched; only the pointer is added.

- ✅ **`component-authoring.md`** — three structural updates:
  1. New top-level "Chain Integration" section inserted between "CSS Structure" and "Component Patterns". Scopes the *how-to* for component authors (which hooks to call, which props to refuse to add, which attributes to write) and defers the *why* to `responder-chain.md`. Contains the L11 "control vs responder vs both" test, the canonical emit snippet, the canonical register snippet, the strict-vs-tolerant decision rule, the `observeDispatch` pattern with the modal opt-out pointer, the no-`makeFirstResponder` rule, and a worked "callback prop → chain dispatch" migration example (before/after code).
  2. "Standardized citation set" table gains [L11] as a required citation for any component that dispatches or handles an action.
  3. Checklist gains five new items matching the A5 roadmap spec: controls emit via chain, responders register via `useResponder`, `data-slot` + `data-responder-id` both present, no `makeFirstResponder`, transient UIs subscribe to `observeDispatch`. Plus an [L07] refs-not-closures item. "Laws That Govern Components" reference table gains [L07], [L11], [L19] and a trailing pointer to `responder-chain.md`.

**Exit criteria (all met):**
- ✅ A new contributor writing a fresh interactive component has exactly one path to follow — `responder-chain.md` for the model, `component-authoring.md` § Chain Integration for the how-to, `action-naming.md` for the vocabulary — and cannot accidentally fall back to the callback-prop anti-pattern.
- ✅ Every "the chain does X" reference across the tuglaws corpus now resolves to a paragraph in `responder-chain.md` instead of requiring a source-file dive.
- ✅ L11 migration pattern documented as a worked before/after example in `component-authoring.md`.

**Grade impact after A5:** Documentation → A.

### Phase A6 — Clean up the small remaining footguns (cleanup, 1 short session) ✅

The four roadmap items went in quickly because three of them had already landed in passing during earlier phases and the fourth was a verification step. The only substantive work in A6 was an unplanned addition — `dispatchTo` learned to walk up the chain on miss — which turned out to be the right moment for the fix because the new `tuglaws/responder-chain.md` doc was already describing dispatch semantics and the old deliver-only behavior was an unprincipled exception.

**Landed / resolved:**

1. ✅ **Remove `GalleryAction` from the top-level `TugAction` union.** Already done during the action-naming rollout (`5802bc26`). `action-vocabulary.ts` exports `TugAction<Extra extends string = never>` with `GalleryAction` as a sibling type opted in via `TugAction<GalleryAction>` at gallery call sites; production code sees bare `TugAction` and none of the gallery extras in autocomplete. No further action needed.

2. ✅ **Optimize the `canHandle` wrapper in `useResponder`.** Already done. `use-responder.tsx:244-245` captures `hasCanHandleAtMount` / `hasValidateActionAtMount` refs at mount, and the registration block only installs the wrapper closures when the caller actually supplied the corresponding function. Responders that omit both get `undefined` on the node and the chain's dispatch/query code fast-paths past the advisory branch.

3. ✅ **`ResponderScope` host element — closed in favor of the status quo.** Surveyed every `<ResponderScope>` consumer. All of them (`tug-card`, `tug-sheet`, `tug-prompt-input`, every `useResponderForm` client) wrap their own root element manually and the pattern is readable and consistent. No component is awkward under the current shape. The roadmap's own decision rule was "if more than two components end up needing a wrapper div, promote it; otherwise leave it." Leave it.

4. ✅ **Full `bun test` suite.** 2003/2003 passing at A6 close (2000 from A4.2 + 6 new dispatchTo tests − 3 updated existing tests; net +3). Docs-only A5 had zero test impact.

**Unplanned addition:**

5. ✅ **`dispatchTo` walks up the chain on miss.** `ResponderChainManager.dispatchTo` previously delivered the event to the named node and returned `false` if that node did not handle it, ignoring the chain entirely. This forced the emitter to know the target's exact registered action set — leaky and brittle. The new behavior starts the walk at the target and continues upward via `parentId` until some node handles the action or the walk falls off the root, matching `dispatch`'s semantics for the non-first-responder-starting case. `dispatchToForContinuation` gets the same treatment.

   The refactor extracted a shared `private walkFromNode(startId, event)` helper that all four dispatch entry points (`dispatch`, `dispatchForContinuation`, `dispatchTo`, `dispatchToForContinuation`) now call. Each entry point handles its own error cases (throw on unregistered target for the `dispatchTo*` pair) and its own observer/logging calls. Drive-by fix: `dispatchTo` and `dispatchToForContinuation` now call `logDispatch` for consistency with the walking path, so targeted dispatches show up in the `[responder-chain] dispatch` console trace.

   Throw-on-unregistered behavior is unchanged — still a programming error. Callers that genuinely want "deliver to this node only, no walk" check `nodeCanHandle(targetId, action)` first; no such consumer currently exists. Tests updated: one rewrite of the "bypasses chain walk" test (now "starts the walk at the target, not at the current first responder"), one rewrite of the "returns false when target exists but does not handle" test (now "returns false when neither target nor any ancestor handles"), and three new tests covering walk-up on miss, `dispatchToForContinuation` continuation flow from an ancestor, and observer notification after a walk that falls off the root. `responder-chain.md` updated in three places: § "Anatomy of a dispatch" (the ASCII diagram now shows `dispatchTo` examples alongside `dispatch` examples), § "The four dispatch shapes" (the `dispatchTo` subsection is fully rewritten with the new walk semantics and the "no downward walk" clause), and a note that consumers wanting "deliver-only" behavior should gate on `nodeCanHandle`.

**Exit criteria (all met):**
- ✅ Roadmap items 1–4 resolved (three already done, one verified).
- ✅ `dispatchTo` walks up the chain, matching `dispatch` semantics.
- ✅ All four dispatch methods share a single walk implementation.
- ✅ Targeted dispatches appear in the console dispatch log.
- ✅ `bun test` clean at 2003 passing.
- ✅ `responder-chain.md` describes the new behavior accurately and flags the anti-pattern of relying on the old deliver-only semantics.

**Grade impact after A6:** Type safety → A, Implementation strategy → A.

### A-phases summary

| Phase | Duration | Primary grade impact |
|---|---|---|
| A1 | 1–2 short sessions | Type safety, Implementation strategy, Documentation |
| A2 | Multi-session | Consistency (C+ → A) |
| A3 | 1 session | L11-for-keyboard completeness |
| A4 | 1 session | Floating-surface consistency |
| A5 | 1 short session | Documentation (A- → A) |
| A6 | 1 short session | Type safety polish, footgun removal |

**Projected post-A6 grades:** all A (or better). The remaining soft spot is payload type safety — deferred as a conscious tradeoff per Part 4 decision 1. If the `narrowValue` utility convention doesn't hold up under R2 pressure, Phase A7 (deferred, not committed) would introduce per-action discriminated unions.

---
