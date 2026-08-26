# The Responder Chain

*The tree of components that own semantic state, the walk that routes typed actions through them, and the single model every interactive surface in the app obeys. Read this before writing a component that emits an action, handles an action, or reacts to chain traffic.*

*Cross-references: `[D##]` → [design-decisions.md](design-decisions.md). `[L##]` → [tuglaws.md](tuglaws.md). This document is the chain's mechanism; [commands.md](commands.md) is how a user-invocable command is defined and reaches it ([L30]) — a command is dispatched through `dispatchCommand`, never by hand-calling the chain from an emitter.*

---

## Why a chain

Every interactive app needs an answer to the same question: "when the user presses ⌘A, which component handles it?" The easy answers — attach a keydown listener to every component, route everything through a global store, pass callbacks down through props — each break down the moment the app has nested surfaces that all want a share of the same keystroke: a text editor inside a card inside a canvas, each of which reasonably owns a different meaning for `select-all`.

Cocoa solved this in 1988 with the *responder chain*: a tree of objects addressable by walking from a "first responder" up through its parents, routing a typed *action* until some node handles it. The object that owns the relevant state is the one that handles the action; every other node just lets it walk past. The same ⌘A reaches a different responder depending on what the user is currently working with — no per-component wiring, no global dispatcher table, no prop drilling.

We brought that model into React because it is the right answer to the question, and because the same question appears every few weeks in tugdeck. Every keyboard shortcut, every context menu, every "dismiss on outside click," every clipboard flow, every Swift-menu-item-to-web-view RPC routes through the chain. Understanding the chain is the prerequisite for writing a component that behaves correctly alongside the other twenty.

[L11] is the law this document explains. Everything else here is the mechanism that makes L11 work.

---

## The three principals

The chain has exactly three kinds of participants, and the distinction between them is conceptual, not categorical. The test is one question.

- **A *control* translates a user gesture into a typed intent.** It dispatches an action into the chain. It does not own the state the action will mutate. Most interactive widgets are controls: buttons, sliders, checkboxes, switches, radios, choice groups, tab bars, accordions, popup menus. Their "state" — the current slider value, the checked boolean, the selected tab — lives in a parent or a store, flows back in via props, and is rendered by the control. The control is a passthrough for the user's intent, not the home of the thing the intent modifies.

- **A *responder* owns semantic state that actions mutate and registers handlers for the actions that mutate it.** Responders have a stable identity in the chain — a registered node with an id — so the first-responder promotion mechanism can address them. A text editor owns its document, caret, and undo stack, and is therefore the responder for `cut`, `copy`, `paste`, `select-all`, `undo`, `redo`. A card owns a **pane** (title bar, tabs, close state), so it is the responder for `close`, `select-tab`, `close-tab`, `find`. A canvas owns the layout tree — including the cross-pane card ring — so it is the responder for `previous-tab`, `next-tab`, `reset-layout`, `add-card-to-active-pane`, `move-to-slot`, `show-settings`, `show-component-gallery`.

- **A single component can be both.** A text editor with a built-in context menu is the emitter of `cut` when the user clicks the menu item, and the responder for `cut` because its selection is what gets cut. The walk starts at the first responder (the editor itself), finds the handler on the editor, and the emit-then-walk loop closes on the same component. That is the most common pattern in this codebase for self-contained widgets with their own action surfaces.

**The test.** Does this component own the state that this action is going to mutate? If yes, it is the responder for that action and must register a handler. If no, it is an emitter — it can dispatch, but somebody else owns the state, so somebody else is the responder. If the answer changes per action (a card emits `add-tab` to itself and also owns the tab list), the component registers the actions it owns and emits the ones it doesn't.

The distinction is not about widget *kind*. A push button that "closes the card" is dispatching `close` because the card owns the close state, not because buttons are always controls. A push button that implements its own press animation is a responder for `press` (if such an action existed) because the state that action mutates lives inside the button. Category-based reasoning breaks on the edges; the ownership test does not.

---

## `ActionEvent` — the sole dispatch currency

Every action flowing through the chain is represented by a single typed event shape. There is no second path, no "raw" keydown variant, no custom payload envelope. This uniformity is load-bearing: the manager, the handlers, the observers, and the debug logger all speak one language.

```ts
interface ActionEvent<Extra extends string = never> {
  action: TugAction<Extra>;     // e.g. TUG_ACTIONS.CUT — kebab-case wire name
  sender?: unknown;              // the originating control, if meaningful
  value?: unknown;               // typed payload; see action-vocabulary.ts
  phase: ActionPhase;            // "discrete" | "begin" | "change" | "commit" | "cancel"
}
```

**`action`** is the semantic name. It is typed against the `TugAction` union, derived from `TUG_ACTIONS` in `action-vocabulary.ts`; misspellings are compile errors. See [action-naming.md](action-naming.md) for the kebab-case shape and the canonical constants. Call sites reference the constant (`TUG_ACTIONS.CUT`), never the raw string.

**`sender`** identifies the originating control when multiple controls can emit the same action and handlers need to tell them apart. A form with a dozen text inputs all dispatching `set-value` disambiguates by `sender` — each input passes its `useId()` result, and the parent's handler routes each update to the right field. Controls that don't need disambiguation omit it.

**`value`** is the typed payload. Its shape is action-specific and documented inline in `action-vocabulary.ts` alongside the constant. `set-value` carries a `number` (for numeric inputs) or a `string` (for text inputs); `move-to-slot` carries a 1-based `number`; `set-property` carries a structured `{path, value, source?}`. Handlers narrow defensively with `typeof` or `Array.isArray` because the field is typed `unknown` — see the payload-narrowing commentary at the end of `action-vocabulary.ts` for the rationale and the two patterns (form-slot narrowing via `useResponderForm` vs. inline `typeof` gates).

**`phase`** distinguishes one-shot actions from continuous interactions. The phase model follows the same conceptual design as Apple's `UIGestureRecognizer.State`, adapted for a web responder chain.

### Phase definitions [D-PH1]

Five phases. No more, no fewer.

| Phase | Meaning | Apple equivalent |
|---|---|---|
| `discrete` | Atomic action — completed in a single gesture. No lifecycle. | `UIGestureRecognizer.State.recognized` / `UIControl.Event.primaryActionTriggered` |
| `begin` | Continuous gesture started. Value is the initial value at gesture start. | `UIGestureRecognizer.State.began` |
| `change` | Continuous gesture updating. Value is the current intermediate value. May fire many times. | `UIGestureRecognizer.State.changed` / `UIControl.Event.valueChanged` |
| `commit` | Continuous gesture completed successfully. Value is the final committed value. | `UIGestureRecognizer.State.ended` |
| `cancel` | Continuous gesture aborted. Handler should revert to pre-begin state. | `UIGestureRecognizer.State.cancelled` |

In Apple's UIKit, `recognized` and `ended` share the same raw value — they are the same concept (successful completion), named differently for discrete vs. continuous gestures. Our `discrete` and `commit` are the analogous pair: both mean "the action completed successfully", but `discrete` signals there was no gesture lifecycle, while `commit` signals the end of a `begin`/`change` sequence.

We omit Apple's `possible` (no speculative recognition — controls know what they are) and `failed` (no recognition ambiguity in a typed action system).

### Control-phase contract [D-PH2]

A control's interaction model determines which phases it dispatches. There are exactly two models:

**Discrete controls** — dispatch `discrete` only. One action event per user action. No gesture lifecycle.
- TugButton, TugPushButton: `discrete` on click
- TugCheckbox, TugSwitch: `discrete` on toggle
- TugPopupButton, TugContextMenu: `discrete` on menu item selection
- TugValueInput: `discrete` on blur-commit, Enter-commit, arrow-key step
- TugTabBar: `discrete` on tab selection
- Keyboard shortcuts: `discrete` always

**Continuous controls** — dispatch the full lifecycle: `begin` → `change`* → (`commit` | `cancel`).
- TugSlider (pointer drag): `begin` on pointer-down, `change` on drag, `commit` on pointer-up, `cancel` on Escape/pointer-cancel
- TugSlider (keyboard arrow): `discrete` — arrow-key steps are atomic, not gestures
- Custom scrub surfaces (hue swatch, position drag): same `begin`/`change`/`commit`/`cancel` lifecycle

A control is discrete or continuous based on the *interaction*, not the control type. A slider dispatches `discrete` for keyboard steps and the full lifecycle for pointer drags. The phase is determined by how the user is interacting, not by what the control is.

### Handler phase patterns [D-PH3]

`useResponderForm` setters receive `(value: T, phase: ActionPhase) => void`. Handlers that don't care about phase declare `(v: number) => void` — TypeScript's function assignability makes this work; the phase argument is passed but ignored.

Handlers that need phase-aware behavior branch on it:

```ts
// Scale slider: update readout on every change, apply CSS zoom only on commit
const handleScale = (v: number, phase: ActionPhase) => {
  setScaleState(v);                                  // always — readout updates instantly
  if (phase === "commit" || phase === "discrete") {
    document.documentElement.style.setProperty("--tug-zoom", String(v));
  }
};
```

The phase is data on the event, not a separate dispatch path. There are no per-phase slots in `useResponderForm`. This matches Apple's pattern: `UIGestureRecognizer` fires its action at every state transition; the target checks `recognizer.state` and branches.

The `commit || discrete` guard is the standard pattern for "do this when the value is finalized". Both phases mean "the user is done" — `commit` after a drag, `discrete` after a keyboard step. If a handler treats all phases the same (just updating local state), it doesn't need to check at all.

---

## The walk

Dispatch walks from the first responder upward through `parentId` links until a node's `actions` map contains a matching key. The first match wins. The walk is *innermost-first*: the deepest responder that registered a handler runs it, and ancestors only see actions their descendants ignored.

```
                    ┌─────────────────────────┐
                    │  DeckCanvas             │  ← registered handlers:
                    │   actions: {            │       next-tab / previous-tab
                    │     next-tab: ...       │       reset-layout
                    │     reset-layout: ...   │       show-settings
                    │   }                     │
                    └───────────▲─────────────┘
                                │ parentId
                    ┌───────────┴─────────────┐
                    │  TugCard                │  ← registered handlers:
                    │   actions: {            │       close
                    │     close: ...          │       select-tab
                    │     select-tab: ...     │       close-tab
                    │     close-tab: ...      │
                    │   }                     │
                    └───────────▲─────────────┘
                                │ parentId
                    ┌───────────┴─────────────┐
                    │  TugPromptInput         │  ← first responder (caret here)
                    │   actions: {            │       cut / copy / paste
                    │     cut: ...            │       select-all (its own selection)
                    │     copy: ...           │       undo / redo
                    │     paste: ...          │
                    │     select-all: ...     │
                    │     undo: ...           │
                    │     redo: ...           │
                    │   }                     │
                    └─────────────────────────┘

       dispatch({action: "cut"})    → walk starts at TugPromptInput, matches immediately
       dispatch({action: "close"})  → walks past TugPromptInput, matches on TugCard
       dispatch({action: "next-tab"}) → walks past both, matches on DeckCanvas
       dispatch({action: "select-all"}) → matches on TugPromptInput (innermost wins)
       dispatch({action: "select-all"}) with no editor focused → unhandled (no-op)

       sendToTarget(cardId, {action: "close"})  → walk starts at TugCard (not at first responder),
                                                 matches on TugCard
       sendToTarget(cardId, {action: "next-tab"}) → walks up from TugCard, matches on DeckCanvas
```

`sendToFirstResponder` and `sendToTarget` share the same walk loop. The difference is only which node the walk starts at: `sendToFirstResponder` starts at the current first responder (usually the innermost leaf the user is working with); `sendToTarget` starts at an explicit registered node supplied by the caller. Both walk upward through `parentId` links until a handler matches, and both fall off the root with `handled: false` if no node handles the action. The walk is never downward.

Two more points worth noticing on the diagram:

- `select-all` is registered only on content components (`TugPromptInput`, `TugInput`, `TugTextarea`, `TugValueInput`, `TugMarkdownView`) — NOT on `TugCard`. When an editor is focused, ⌘A selects within that editor. When no editor is focused, the action is unhandled — it walks all the way to the root and falls off. There is no "select everything in the card" behavior.

- An action that no node handles walks all the way to the root and falls off. `sendToFirstResponder` returns `false`. That is the correct outcome for unhandled shortcuts: the browser's native handling (or nothing at all) runs. The chain does not need an "unhandled" sink.

After the walk — handled or not — every registered dispatch observer fires. Observers run after the walk, see the final `handled` boolean, and can do whatever they want (typically: dismiss a transient UI because unrelated chain traffic flowed past). Observers do not intercept the walk or change its outcome. See [observeDispatch patterns](#observedispatch-patterns) below.

---

## First responder

The *first responder* is the node the walk starts from. Exactly one node (or none) holds the title at any instant. It is how "the innermost thing the user is working with" gets routed its shortcuts, and it is the reason `select-all` selects the editor's content when the caret is in an editor and does nothing when no editor is focused.

The first responder is promoted in five ways, in rough order of how often you'll see each:

1. **Pointer down.** A document-level capture-phase `pointerdown` listener installed by `ResponderChainProvider` walks from `event.target` up through DOM ancestors, looking for an element with `data-responder-id` whose value is a registered node. The innermost match becomes first responder. Click inside the editor → editor promotes. Click on the pane chrome → pane promotes.

   The listener does not classify the gesture — it **consumes** the classification. The gesture interpreter (`gesture-interpreter.ts`, the deck's one pointer-stream owner) has already decided, at the same pointerdown, whether promotion takes the target, a redirect, or nothing at all, and whether the paired mousedown's browser focus default is prevented; see [focus-language.md](focus-language.md) § One writer, one interpreter, one truth. The exceptions below are that record's `promotion: "skip"` and `"redirect"` cases, described here in the terms an author authors them in. **Two exceptions:** controls marked with `data-tug-focus="refuse"` (buttons, checkboxes, switches, sliders, etc.) are skipped — the first responder does not change when a focus-refusing control is clicked (see [Focus acceptance](#focus-acceptance) below) — and structural gesture surfaces marked `data-tug-fr-preserve` (the pane **title bar**) are skipped too, with the same mousedown `preventDefault` so browser focus stays put. A title-bar click is an activation/drag gesture, never a responder target: promoting the coarse pane container there would strand every accelerator registered on the card's *content* (route switching on the prompt entry, find on the editors, clipboard) behind the upward-only walk, exactly like clicking a Cocoa window's title bar must not change the window's first responder. `data-tug-fr-preserve` is the structural-marker sibling of the button-class-only `data-tug-focus="refuse"` (see [that section's](#data-tug-focusrefuse-is-button-class-only) separation rule).

   **A third exception — draggable content in a non-key card — *defers* rather than skips.** A pointerdown inside a `[draggable="true"]` element whose card is not the key card promotes nothing at pointerdown, because the interpreter has deferred that gesture's activation too: the gesture is not yet known to be a click or a drag. If it turns out to be a click, the pointerup activation commit settles the chain register through the framework half of [P21] below; if it turns out to be a drag, no register moves at all. Promoting eagerly here would strand the chain first responder on the drag source while the deck first responder stayed on the key card — a split register that mis-routes the next Cmd-W. The same carve-out governs the paired activation `mousedown` `preventDefault`, which must be skipped for these gestures or the browser never begins the native drag. The full doctrine (and why a drag touches neither activation nor focus on either end) is [focus-language.md](focus-language.md) § Drag and the keyboard.

2. **Focus in.** The same walk on a document-level capture-phase `focusin` listener. Needed because keyboard-only users reach responders via Tab, programmatic `.focus()`, or the browser's initial focus restoration on page load — none of which fire a pointerdown. `focusin` bubbles (unlike `focus`), so one listener catches every descendant.

3. **Auto-promotion of roots.** When a responder registers with `parentId === null` and no first responder is currently set, it becomes first responder automatically. This is how the canvas becomes the starting point on first mount.

4. **Programmatic `makeFirstResponder(id)`.** Rare. The only sanctioned use is the chain's own unregister path (when the current first responder unmounts, the manager promotes the nearest still-registered ancestor) and `DeckCanvas` promoting a freshly-opened card. Component code should not call `makeFirstResponder` as a substitute for the pointer/focus promotion path — if you find yourself wanting to, you are papering over a layering bug.

5. **Card activation ([P21]) — two halves.** The first responder is the chain's *single* register, but focus is *per card* (see [focus-language.md](focus-language.md), the per-card key-window model). [P21] therefore has a framework half and a content half:

   **Framework half — the activation-moment settlement.** `FocusManager.settleFirstResponderForActivation`, run from `setKeyCard` (the universal activation signal: click, tab switch, pane activation / frontmost change, pane cycle, cross-pane move, cold boot), settles the first responder on a responder that serves the key card — the key view's responder; for a never-focused card, the responder owning its **default-focus target** (the card-author-tagged priority chain `traceApplyDefaultFocus` walks — `data-tug-focus-key="primary"` first, generic focusable last); as a last resort, the card's own container responder (Cmd-W must still land). Its yield rules use *registry* containment (`nodeIsWithin`, the `parentId` walk), never DOM containment, so a pane-modal sheet portaled outside the card's DOM but chain-parented into it keeps first responder; a finer or sibling in-card promotion (a clicked editor) is never clobbered; only a coarse chain-*ancestor* container (the pane/card responder a chrome click or a pre-mount `addCard` promotion left) is overridden — a coarse container must not mask the card's content accelerators behind the upward-only walk.

   **Content half — the em-card engine-hook contract.** An engine-managed card's content owns its focus lifecycle ([lifecycle-delegates.md](lifecycle-delegates.md)) by registering an **engine hook** (`store.registerEngineHooks`) whose `paintMirrorAsActive` focuses its own text surface (`view.focus()` on the CM6 editor). The framework's single focus channel — `applyBagFocus`, invoked from `transferFocusForActivation` on every activation route and from `CardHost`'s cold-boot restore — resolves an em card to `engine` and calls `invokeEnginePaintMirrorAsActive`; the hook focuses the view and the resulting `focusin` promotes the editor's responder, so the chain register lands with no per-card promotion code. A card created-and-activated before it mounts (Open Quickly, File ▸ Open) and an async editor bind are covered by the *same* channel: registering the hook bumps the engine-hooks version, and `CardHost`'s `subscribeEngineHooksChange` retry re-runs `applyBagFocus` against the now-mounted view. The Dev and Text cards are the reference implementations; **every new em card must register this hook** — it is what makes accelerator routing uniform across card types with no engine-side special cases. A card must **not** reclaim focus from `cardDidActivate`: that drains after the framework's claim and would duplicate it (both cards make `cardDidActivate` a no-op — see [lifecycle-delegates.md](lifecycle-delegates.md)).

   This is the one engine-owned promotion path; component code still must not call `makeFirstResponder`. The framework half's `settleFirstResponderForActivation` settles the chain register at the *activation moment*; the content half's engine hook settles it at the *mount/bind moment* through the same `applyBagFocus` channel (which realizes the engine claim via the focus engine's single write primitive, `place` — see [focus-language.md](focus-language.md) § One writer) — two moments, one channel, no delegate reclaim between them.

   **The key-delivery inversion.** Keys no longer arrive at a responder because DOM focus sits inside it — the engine's `FocusTarget` is the router, and `document.activeElement` is parked on the key sink for every non-text target (see [focus-language.md](focus-language.md) § One writer, the two routes). The **focus contract** ([D03]) is therefore now the *dom-granted declaration*: a responder that registers a `focus` contract is telling the engine "I am a text surface — grant me real DOM focus and stand back"; a responder without one is engine-routed, receives keys through the key-view delegation channel (`KeyViewBehavior.onKey`), and never holds DOM focus in standard mode. `focusin` promotion still settles the chain register, but for engine-routed key views the engine settles it explicitly (the park moves no useful `focusin`) — the chain's *routing* role (accelerators, cut/copy/paste, cancel) is unchanged; only the *delivery* of ordinary keys moved from DOM focus to the engine.

### Why the DOM is the truth source

The promotion walk reads `data-responder-id` attributes from the DOM, not React component identities. This is deliberate and load-bearing.

- **Capture-phase, document-level listeners** fire *before* the event reaches the target, so nothing a descendant does can suppress them. A component that calls `event.stopPropagation()` in its own pointerdown handler cannot prevent first-responder promotion — capture-phase ancestors already ran. The only way to break it would be another document/window capture-phase listener that called `stopImmediatePropagation` *and* was registered before ours; no code in the suite does that.

- **DOM-walk beats React-tree walk during unmount.** React's `useLayoutEffect` cleanup order during a multi-level unmount is not strictly child-to-parent. A wrapping responder can run its cleanup *before* a responder it nests — concretely, a form responder wrapping a prompt input may unmount the form's node before the prompt input's. By the time the prompt input's cleanup fires, its captured `parentId` is no longer in the manager's node map, and a naive one-level promotion would set `firstResponderId = null`. The unregister path instead walks DOM ancestors via `findResponderForTarget`, naturally skipping nodes that already unregistered in the same cleanup pass and stopping at the nearest one that's still alive.

The two debug attributes this writes to the DOM are worth knowing about:

- **`data-responder-id="<id>"`** on every registered responder's root element. Written by `useResponder`'s `responderRef` callback. Devtools query: `document.querySelectorAll('[data-responder-id]')` lists every responder currently registered.

- **`data-first-responder="<id>"`** on exactly one element at a time — the current first responder. The value is the id itself (not `"true"`), so devtools search for `[data-first-responder]` shows the attribute inline with its id and you can tell immediately who the chain considers active. The chain logs every change to the console with a gray `[responder-chain] first responder → <id>` marker; filter the console for `[responder-chain]` to see the full first-responder history.

---

## Focus acceptance

Controls and responders differ in whether they accept keyboard focus on click. This mirrors Cocoa's `acceptsFirstResponder` concept.

**Focus-accepting components** need keyboard input to function. Clicking them moves both browser focus and first-responder status to them. Examples: `TugInput`, `TugTextarea`, `TugValueInput`, `TugPromptInput`, `TugMarkdownView`.

**Focus-refusing components** are controls that dispatch actions but don't need keyboard focus. Clicking them fires their action but does NOT steal focus from the active editor. The first responder stays wherever it was. Examples: `TugButton` (and `TugPushButton`, `TugPopupButton`), `TugCheckbox`, `TugSwitch`, `TugSlider`, `TugChoiceGroup`, `TugOptionGroup`, `TugTabBar`.

### Mechanism

Focus-refusing controls add `data-tug-focus="refuse"` to their root element. Two document-level listeners in `ResponderChainProvider` handle both concerns centrally:

1. **`pointerdown` (capture):** if the click target is inside a `[data-tug-focus="refuse"]` element, skip first-responder promotion.
2. **`mousedown` (capture):** if the click target is inside a `[data-tug-focus="refuse"]` element, call `preventDefault()` to prevent the browser from moving focus.

Controls add ONE attribute — both behaviors are handled centrally. The `click` event is unaffected: mousedown+mouseup on the same element still fires `click` normally. Keyboard Tab navigation is preserved: controls keep their default `tabindex`, so keyboard users can reach them via Tab and activate with Enter/Space.

The bundle is intentional. Both behaviors serve one user goal: *"clicking a chrome control must not steal focus from where the user is typing."* Authoring an attribute that turns on only one half is incoherent — a button that takes browser focus but not chain promotion (or vice versa) is a bug, not a feature. The two layers operate at different levels (chain registry vs. browser focus) but address one concept; the attribute is the pinhole through which both are turned on atomically.

### `data-tug-focus="refuse"` is button-class-only

The attribute's semantics are narrow: button-class controls only. Structural markers like `data-slot="tug-canvas-overlay-root"` (which the gesture interpreter reads to classify overlay-tier clicks as `site: "overlay"`, so they drive no pane activation) are deliberately separate attributes for separate concerns. The interpreter's "is this click inside the overlay tier?" check uses `closest('[data-slot="tug-canvas-overlay-root"]')` directly — it does NOT read `data-tug-focus="refuse"`. Adding refuse-attribute semantics to a non-control element would be a mis-match between the attribute name and its actual concern; if you have an element that wants pane-activation-skip behavior, give it a structural marker.

### Why this matters

Without focus refusal, clicking a toolbar button while a text editor has focus causes a visual flash — the editor briefly loses focus (and its selection dims), then the button's action refocuses the editor. The user sees a flicker. With focus refusal, focus never leaves the editor — the button activates on the first click with no flash.

This also resolves the WebKit double-click issue in sheets: previously, clicking a button inside a sheet while a text input had an active selection would consume the first click as a selection-clear action, requiring the user to click twice.

---

## The four dispatch shapes

The manager exposes four methods for sending an action into the chain. Three are walks; one is a targeted delivery. All of them notify observers afterward.

### `manager.sendToFirstResponder(event) → boolean`

The standard walk. Returns `true` if some responder handled the action, `false` otherwise. This is the method most control code uses.

```ts
manager.sendToFirstResponder({
  action: TUG_ACTIONS.SELECT_TAB,
  value: tabId,
  sender: myTabBarSenderId,
  phase: "discrete",
});
```

If you don't care whether anyone handled it (most button clicks don't — the card is registered, the handler runs), `sendToFirstResponder` is what you want. It is a thin wrapper over `sendToFirstResponderForContinuation` that discards the continuation slot.

### `manager.sendToFirstResponderForContinuation(event) → {handled, continuation}`

Same walk, but returns both the handled flag and any continuation callback the handler returned. Use this when you need either signal.

The continuation is the second phase of two-phase execution. A handler may return a `() => void` from its synchronous body; `sendToFirstResponderForContinuation` returns that function to the caller, which invokes it at its own commit point. The canonical example is the clipboard cut flow: the synchronous portion of the handler must run inside the user-gesture frame (because that's when `navigator.clipboard.writeText` is permitted to fire), and the delete-selection portion should run *after* a menu activation blink completes. The handler writes to the clipboard inline and returns `() => deleteSelection()`; the menu's activation logic plays the blink, then invokes the continuation.

```ts
const { handled, continuation } = manager.sendToFirstResponderForContinuation({
  action: TUG_ACTIONS.CUT,
  phase: "discrete",
});
if (handled) {
  playActivationBlink(menuItem).then(() => continuation?.());
}
```

The capture-phase keyboard pipeline also uses `sendToFirstResponderForContinuation`: for ⌘X on a text input the sync clipboard write must happen during the keydown, and the continuation (delete the selection) runs immediately after because there's no blink to wait for. The same handler works for both paths.

### `manager.sendToTarget(targetId, event) → boolean`

Targeted walk. Starts the walk at the named node instead of at the current first responder; otherwise behaves identically to `sendToFirstResponder` — the event walks up through `parentId` links until some node handles it, or falls off the root with `handled: false`. Throws if `targetId` isn't registered.

```ts
manager.sendToTarget(cardId, {
  action: TUG_ACTIONS.SET_PROPERTY,
  phase: "discrete",
  value: { path: "style.backgroundColor", value: "#4f8ef7", source: "inspector" },
});
```

`sendToTarget` is for flows where the emitter knows the approximate scope the event should reach but doesn't need to know exactly which node in that scope handles it. The gallery's property-inspector demo is the canonical case: the inspector's UI is not inside the card whose PropertyStore it drives, so a chain walk from the inspector's first-responder position would never reach the target card. The inspector has the card id, so it addresses the card directly. If the card itself owns the PropertyStore, its handler runs. If a future card shape delegates the store to a wrapper above it in the chain, the walk continues upward and finds the handler there — the inspector does not need to know which of those shapes the target uses. There is also a `sendToTargetForContinuation` sibling for the same reason `sendToFirstResponderForContinuation` exists on the walking path, with the same walk-up-on-miss semantics.

The walk from `sendToTarget` is still upward-only: it starts at the target, follows `parentId` toward the root, and stops at the first handler. It does *not* walk *down* into the target's children, because state owners are ancestors of the controls that mutate them — walking down would invert the chain's directionality and is not a supported operation.

Throwing on an unregistered target is deliberate: dispatching to a node that does not exist is a programming error, and silently no-oping would hide bugs. If the target might not be registered (e.g., it's optional), the caller should check with `nodeCanHandle(targetId, action)` before dispatching — but in practice that condition means the emitter has a stale reference and should be fixed upstream.

If you specifically want "deliver to this one node only, do not walk to ancestors if the node doesn't handle it," there is no single method for that. Check `nodeCanHandle(targetId, action)` first and only call `sendToTarget` if it returns true. In the current codebase no consumer needs that shape; every targeted dispatch has the "start walk here and let it bubble" semantic that the new behavior provides.

**Cascade-target pattern: capture-at-open, dispatch-at-close.** Modal surfaces (sheets, alerts, confirmation popovers) often want a follow-up dispatch when the user closes them — e.g. a card's picker sheet closes and the card itself should close as a result. The fragility is that "first responder at close time" is not a value the consumer can predict: focus restore through Radix's `FocusScope.onUnmountAutoFocus`, the unregister fallback's parentId-promotion, and the focusin-driven first-responder update each move first responder, and the settled value at `onClosed` time is *whatever those mechanisms produced* — usually correct, sometimes not.

The right pattern is to **capture the cascade target id at OPEN time** (when the consumer knows exactly which responder should handle the follow-up dispatch) and **dispatch via `sendToTarget` at CLOSE time** (which walks `parentId` from the captured target, not from the current first responder). The dispatch then reaches the right handler regardless of whatever first-responder state the close cascade settled on.

```ts
function presentSheet() {
  void showSheet({
    title: "Open Project",
    content: ...,
    cascadeTargetId: cardId,   // captured at OPEN — the card's responder id
    onClosed: (result) => {
      if (result === "open" || result === "retry") return;
      manager?.sendToTarget(cardId, {
        action: TUG_ACTIONS.CLOSE,
        sender: senderId,
        phase: "discrete",
      });  // walks via parentId from cardId — reaches the pane's CLOSE handler
    },
  });
}
```

The general rule: **pick the cascade target id whose registration outlives the dispatch window, not the closest one to the handler.** A card id (stable across cross-pane moves) is preferable to a pane id (changes on cross-pane moves) when both reach the same handler via the chain walk. The walk handles the upward traversal; the consumer's only job is to start it from a node that's still registered when the close fires.

Modal surfaces that expose this pattern attach a `cascadeTargetId` option to their open-time API (`useTugSheet().showSheet({ cascadeTargetId })`). The hook does not consume the value itself — it just stores it on the active state so the option's contract is documented and consumers reference the captured id from their own `onClosed` closure.

### `manager.sendToTargetForContinuation(targetId, event) → { handled, continuation }`

The targeted sibling of `sendToFirstResponderForContinuation`. Same walk semantics as `sendToTarget` (starts at the named node and walks upward via `parentId`), same error handling (throws if `targetId` is not registered), but returns the full `{ handled, continuation }` result instead of discarding the continuation. Callers that need two-phase execution against a specific target use this method and invoke the returned continuation at their commit point.

### `manager.nodeCanHandle(nodeId, action) → boolean`

Query whether a specific registered node can handle the given action. Checks the node's `actions` map first, then the optional `canHandle` function. Returns `false` if the node is not registered.

This is the per-node counterpart to `canHandle(action)` (which walks from the first responder). Used by `TugButton` to determine its enabled/disabled state when dispatching to a specific target — the button's visual state should reflect whether its *dispatch target* can handle the action, not whether the first responder can.

```ts
// Button validates against its effective dispatch target
const canHandle = manager.nodeCanHandle(effectiveTarget, action);
```

### `manager.observeDispatch(callback) → unsubscribe`

Subscribe to every action flowing through the chain, regardless of which node handled it or whether any node did. The callback runs after the walk with `(event, handled)`. This is the mechanism for "close on unrelated chain traffic" — a context menu, a tooltip, a transient popover can subscribe while open and dismiss itself whenever anything flows past it.

```ts
useLayoutEffect(() => {
  if (!open || !manager) return;
  return manager.observeDispatch(() => {
    if (blinkingRef.current) return;  // skip self-dispatches
    setOpen(false);
  });
}, [open, manager]);
```

Observers run in insertion order and cannot intercept or modify the walk. They are fire-and-forget. An observer that unsubscribes itself during notification is safe — the manager snapshots the observer set to a local array before iterating.

See [observeDispatch patterns](#observedispatch-patterns) below for the canonical precedents and the `blinkingRef` self-dispatch guard.

---

## Bringing DOM focus in sync with chain state — `focusResponder(id)`

The chain's first responder and the browser's `document.activeElement` are conceptually different things. First responder is who the chain dispatches actions to; `activeElement` is who keyboard events go to and where the caret blinks. They usually agree because pointerdown/focusin promotion drives both off the same DOM-walk source — but a popup that takes DOM focus while a service binding's restore predicate keeps chain first responder pinned shows that the two axes are independent.

`manager.focusResponder(id)` is the single primitive that closes the gap: it both promotes `id` to first responder AND restores DOM focus to the responder's element. Use it whenever code needs to land both at the same target (a popup-class primitive's close handler restoring focus to the responder that owned it before open; a chain-driven workflow that needs the keyboard caret to land on the newly-promoted responder).

```ts
manager.focusResponder(editorId);
// Equivalent to:
//   1. If id is not registered → no-op (and dev-mode warn).
//   2. Else: this.makeFirstResponder(id).
//   3. Then: invoke node.focus?.() if defined (substrate-supplied).
//   4. Otherwise: DOM-walk fallback —
//      document.querySelector(`[data-responder-id="${id}"]`)?.focus()
//      (or its first tabbable descendant if the element itself is non-focusable).
```

**Substrate-supplied focus callback.** Responders whose focus surface is non-trivial supply a `focus?: () => void` callback at registration time (see the `focus` subsection in "Registering a responder" below). The callback is invoked AFTER `makeFirstResponder(id)` runs, so subscribers see the chain promotion before the DOM focus event fires. CodeMirror text editors, contentEditable hosts, shadow-DOM-rooted custom editors all benefit from supplying their own callback because the substrate knows how to focus itself correctly (e.g. `view.focus()` on a CM6 EditorView lands on `view.contentDOM`, which is what a generic `el.focus()` walk wouldn't necessarily find).

**DOM-walk fallback.** When no `focus` callback is registered, `focusResponder` queries the DOM for `[data-responder-id="<id>"]` and focuses either the responder's own element (if intrinsically focusable: `<button>`, `<input>`, `<textarea>`, `<select>`, `<a>`, or `tabindex>=0`) or its first tabbable descendant. The element-first check matters for wrappers that declare `tabindex="0"` on themselves to claim keyboard focus — focusing a descendant first would drop focus inside the wrapper instead of on it. Detached elements and DOM-free environments (server-side rendering) are handled gracefully — the chain record still updates, only the DOM focus side-effect is unavailable.

**Tolerant of races.** If `id` was unregistered between the moment a caller captured it and the moment `focusResponder` ran, the method no-ops with a dev-mode warn. This is the right shape for popup close-focus restoration where the captured responder may have unmounted while the popup was open.

State-zone classification: `focusResponder` mutates structure-zone state (chain identity) and appearance-zone state (DOM focus). It does not touch React state and does not participate in `useSyncExternalStore` consumption.

---

## Two walks, two questions: DOM walk vs. registry walk

The chain's promotion path and dispatch path use *different* walks for *different* questions. This is not a bug or a redundancy — it is structural, and understanding it is the prerequisite for reasoning about portaled responders.

| Walk | API | Starts from | Traverses | Used for |
|------|-----|-------------|-----------|----------|
| **DOM walk** | `findResponderForTarget(node)` | An arbitrary DOM node (event target) | DOM `parentElement` chain | Pointerdown / focusin promotion: "given the user's click target, which responder is rendered above it in the *DOM*?" |
| **Registry walk** | `walkFromNode(id)` (private), used by `sendToFirstResponder` / `sendToTarget` | A registered responder id | `parentId` chain (set at registration via `ResponderParentContext`) | Dispatch: "given a starting responder, which ancestor handles this action via the *chain*?" |

The two walks can produce **different answers for the same starting position** — by design. A `TugSheet` portaled into the canvas overlay root has:

- **DOM ancestors:** clip → canvas-overlay-root → body. *None* are registered responders.
- **Registry ancestors (via `parentId`):** card-host → pane → root. All registered.

`findResponderForTarget(sheetContent)` returns the sheet's own id (the sheet's registered DOM element is the deepest DOM-walk match), or null when walking from a non-responder descendant of the overlay root. `walkFromNode(sheetId)` walks card-host → pane → root via `parentId`. Both are correct — they answer different questions.

**The decision rule for new dispatch sites:** ask whether you want *"closest registered responder by physical position"* (DOM walk — used by promotion) or *"closest registered handler in the chain hierarchy"* (registry walk — used by dispatch). Promotion is always DOM-walk; dispatch is always registry-walk. The two are not interchangeable, and unifying them would lose information that the codebase quietly relies on.

---

## Two-phase execution via continuations

Some handlers need to do work in two phases: a synchronous phase that must run inside the user's gesture frame (clipboard writes, input-field focus moves, event.preventDefault before the browser reacts) and a deferred phase that runs after a visible side effect (a menu blink, a press animation, a transition).

The chain's handler return-type — `void | (() => void)` — is exactly that two-phase shape. The sync body of the handler runs as part of `sendToFirstResponder`; if it returns a function, the caller of `sendToFirstResponderForContinuation` gets that function back and invokes it later. There is no scheduling; the caller decides when "later" is.

```ts
// Responder side (a text editor registered on the card):
actions: {
  [TUG_ACTIONS.CUT]: (event: ActionEvent): ActionHandlerResult => {
    const text = editor.getSelectionText();
    navigator.clipboard.writeText(text);              // must run synchronously
    return () => editor.deleteSelection();             // runs after menu blink
  },
}

// Emitter side (the context menu):
const { handled, continuation } = manager.sendToFirstResponderForContinuation({
  action: TUG_ACTIONS.CUT,
  phase: "discrete",
});
if (handled) {
  playBlink(menuItem).then(() => continuation?.());
}
```

The keyboard pipeline does the same thing without a blink — it invokes the continuation immediately after the sync phase returns, which is what you want for ⌘X. Handlers do not have to know which emitter path is calling them; they return a continuation if they have one, and the caller runs it at whatever point in the user's attention cycle is correct for that emitter.

A handler that returns `void` is the standard case. Most handlers do. Continuations are an opt-in affordance for the handful of actions where "do everything now" and "split across a blink" are both legitimate, and the responder is the only code that knows which slice goes where.

**Namespace boundary — action names vs. `document.execCommand`.** Continuations in editing handlers often call `document.execCommand` to perform the actual mutation (`"insertText"`, `"delete"`, `"selectAll"`, etc.). The `execCommand` API has its own camelCase command vocabulary that is separate from the chain's kebab-case action names. The chain action `"select-all"` dispatches to the handler; the handler's continuation calls `document.execCommand("selectAll")`. These are two different strings in two different namespaces — the action name routes to the right responder, the execCommand name tells the browser what to do. See [action-naming.md § Action Names vs. Browser Command Names](action-naming.md#action-names-vs-browser-command-names) for the full rule.

---

## Registering a responder

A component becomes a responder by calling one of two hooks during its render. Both are thin wrappers over the same implementation; the difference is what they do when no `ResponderChainProvider` is in scope.

### `useResponder` (strict) vs `useOptionalResponder` (tolerant)

- **`useResponder` throws** if called outside a provider. Use it for components where chain participation is load-bearing — `TugCard`, `DeckCanvas`, `TugPromptInput`, anything whose actions must be routable from the chain for the app to function correctly. The throw catches "I forgot the provider" as a mount-time error rather than letting it silently degrade into a no-op at runtime.

- **`useOptionalResponder` silently no-ops** outside a provider. The hook still runs (returns a stable `ResponderScope` and a `responderRef`), but the layout effect skips the register/unregister calls, the ref callback skips writing `data-responder-id`, and the component falls through to its standalone behavior. Use it for leaf controls that must render in both contexts: inside the app (chain-connected) and standalone in previews, unit tests, or Storybook-style mounts (chain-disconnected).

The critical property `useOptionalResponder` preserves is **state survival across provider transitions**. A test that mounts `TugInput` standalone, wraps it in a provider mid-run, then unwraps the provider, does *not* trigger a component-type flip at the input's position in the tree. React reconciles the same `<input>` element across the transition, so caret position, focus, uncontrolled text state, and any in-progress IME composition all survive. The old pattern of splitting a leaf control into `TugXxxPlain` and `TugXxxWithResponder` component types created exactly this footgun: switching between them on provider presence unmounted the subtree and destroyed user-visible input state. The tolerant hook exists specifically to make standalone-capable leaves work without the split.

**Decision rule.** Ask: "if this component renders without a provider, is that a programming error or a supported configuration?" If programming error, use `useResponder`. If supported (tests, previews, or pre-provider mounts), use `useOptionalResponder`. Never use both in the same component.

### The canonical shape

```tsx
import { useResponder } from "@/components/tugways/use-responder";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";

export function TugCard({ cardId, ... }) {
  // Handlers — reads of current state must go through refs, not closures. [L07]
  const handleClose = useCallback(() => { /* ... */ }, [/* ... */]);
  const handleSelectAll = useCallback(() => { /* ... */ }, [/* ... */]);

  const { ResponderScope, responderRef } = useResponder({
    id: cardId,
    actions: {
      [TUG_ACTIONS.CLOSE]:      (_e: ActionEvent) => handleClose(),
      [TUG_ACTIONS.SELECT_ALL]: (_e: ActionEvent) => handleSelectAll(),
      [TUG_ACTIONS.CLOSE_TAB]: (event: ActionEvent) => {
        if (typeof event.value !== "string") return;     // narrow defensively
        handleCloseTab(event.value);
      },
    },
  });

  return (
    <ResponderScope>
      <div
        data-slot="tug-card"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        {/* card content — children of <ResponderScope> see this card as their parent responder */}
      </div>
    </ResponderScope>
  );
}
```

Four things that must be true for this to work:

1. **`id` is stable.** A responder's id is the handle the chain uses to route events to it. The id typically comes from the component's own identity — `cardId` from the layout store, `useId()` for a standalone leaf, an explicit prop for a test harness. What it must NOT be is a value that changes between renders; that would re-register on every render and churn the chain's node map.

2. **`responderRef` attaches to the root DOM element.** The hook writes `data-responder-id` on that element, which is what the pointerdown/focusin DOM walk reads. If you forget to attach it, the manager will warn at the console: `first responder "<id>" has no matching [data-responder-id] element — did the caller attach responderRef?`. Fix the warning by wiring the ref; don't silence it.

3. **`<ResponderScope>` wraps the subtree whose descendants should treat this node as their parent responder.** The scope provides this node's id as the `ResponderParentContext` value, which `useResponder` calls reading in nested components consume as their `parentId`. Without the wrapper, descendants register with a `parentId` that skips over this node, and the walk collapses their ancestor chain.

4. **Handlers read current state through refs, not closures.** `useResponder` registers once at mount and uses a live proxy over `optionsRef.current.actions` to pick up handler identity changes on re-render, so stale-closure bugs in the handler *function identity* are handled by the hook. But if the handler body closes over a stale React state snapshot (`const [tabs] = useState(...)`; `handler uses tabs`), the bug is yours. Use a ref (`tabsRef.current`) for any state the handler reads at dispatch time. This is [L07] and it is the most common chain bug in PRs.

### `canHandle`, `validateAction`, and `queryActionState`

All three are optional advisory callbacks on the responder node. None is consulted during dispatch — only during capability queries.

- **`canHandle(action)`** lets a responder claim it can handle actions outside its static `actions` map. Used by `DeckCanvas` as a last-resort responder that advertises a broader capability surface than its literal handler set. If omitted, the chain treats the `actions` map as authoritative and skips the advisory branch entirely (which is the path most responders want).

  As the root, `DeckCanvas` is also where a **card/pane-scoped accelerator that fell all the way up gets re-routed to the active surface**. `close` is normally handled by the active *pane* (an innermost-first walk from a card reaches the pane before the canvas), but if the first responder has fallen up to `deck-canvas` — a card or pane closed and no card reclaimed the first responder (no `focusin` on a static card) — `close` reaches the canvas. Its handler `sendToTarget`s the topmost pane's responder, so Cmd-W is never dropped on the frontmost card regardless of first-responder-restoration state. `close-all` (File ▸ Close All Card Tabs, ⌥⌘W) carries a symmetric backstop for the same reason. This is the responder-chain backstop to the engine's per-card first-responder restoration ([focus-language.md](focus-language.md)): the engine keeps the first responder on the active card; the canvas guarantees the accelerator lands even if it didn't.

  **Close-confirm is per-card on the keyboard paths, per-gesture on the X button.** `close` and `close-all` both consult the *card's own* `confirmClose` policy: Cmd-W on a multi-tab pane removes the active card and pops the single-card "Close Card?" guard only when that card opts in; Close All Card Tabs closes the whole pane and pops "Close N Tabs?" only when *any* hosted card opts in. The title-bar X button is the exception — its multi-tab close *always* confirms ("Close N Tabs?"), because the X is a stray-click target where discarding several tabs on one misclick is the failure to guard against. A deliberate keyboard/menu gesture needs no such blanket guard; a stray pointer click does. Same destination (the pane's `requestCloseWith` on `CardTitleBar`), different confirm predicate per gesture.

- **`validateAction(action)`** answers "is this action currently enabled?" for UI that wants to gray out a menu item. Defaults to `true` if omitted. Called by the chain's `validateAction` query, which is what `TugEditorContextMenu` uses to dim its own items based on current selection state.

- **`queryActionState(action)`** answers "what does this action currently show?" — `true`/`false` for a checkmark or toggle, a string for a radio family's current value (the permission mode, the composer route), `undefined` for "nothing to show". It walks exactly like `validateAction`: the first node that handles the action terminates the walk and answers, so a responder that handles the action and registers no state hook answers `undefined` rather than deferring to an ancestor's opinion.

  Validity and state are different questions and neither substitutes for the other: **validity is enablement, state is display.** A menu item can be enabled and unchecked, disabled and checked, or both. Neither is consulted during dispatch — a disabled action that is dispatched anyway still runs; the gate is the UI's, not the chain's.

Leave all three out unless you know you need them. The audit recommendation in A6 is that the overwhelming majority of responders provide none of them; the chain's dispatch/query code has a fast path that skips the advisory branches entirely when they're absent.

#### Asking from the key card instead of the first responder

`validateAction` and `queryActionState` walk from the first responder, which is the right question for a command that dispatches there. A **key-card-routed** command does not: it dispatches to the key card's `card-content` responder, so validating it from the first responder would let whatever holds focus answer for a card it isn't in.

`validateActionInKeyCard(action)` and `queryActionStateInKeyCard(action)` walk from that same content node — the one `sendToKeyCard` would reach — and answer `false` / `undefined` when there is no key card or no content-scope responder inside it. Match the query to the command's routing; a mismatch is how a menu item ends up enabled by a responder that will never receive the dispatch.

`validateActionAtNode(nodeId, action)` is the third variant, for a control that dispatches to an explicit target (`TugButton`'s `sendToTarget`): it asks exactly that node, and answers `false` when the node does not handle the action at all.

### `focus` — substrate-supplied focus callback

An optional `focus?: () => void` callback may be registered alongside the responder. When `manager.focusResponder(id)` runs, it calls this callback (after the chain promotion) instead of the DOM-walk fallback. Substrates with non-trivial focus surfaces — CodeMirror text editors (`view.focus()`), future custom editors with shadow-DOM hosts or contenteditable invariants — supply the callback so chain-driven focus restoration lands DOM focus on the correct element.

```tsx
const editorViewRef = useRef<EditorView | null>(null);

const { responderRef, ResponderScope } = useOptionalResponder({
  id: editorId,
  actions: { /* ... */ },
  focus: () => editorViewRef.current?.focus(),
});
```

Generic responders (text inputs, buttons, generic containers) omit the callback and the DOM-walk fallback Just Works.

The callback is **structural**: like `kind`, `canHandle`, and `validateAction`, it is captured at registration (via a `focusAtMount` ref in `useResponder` / `useOptionalResponder`) and not live-proxied through `optionsRef`. The substrate is responsible for capturing whatever inner ref it needs in the closure (per [L07]). Reading a ref's `.current` from inside the callback (rather than closing over the value directly) means the callback always invokes `focus()` on the live view — covering Fast Refresh re-mount and StrictMode double-mount where the substrate identity may have been swapped between registration and invocation.

### Registration timing — [L03]

`useResponder` uses `useLayoutEffect` for its register/unregister calls, not `useEffect`. This is a hard requirement ([L03]) because keyboard events can fire on the very next tick after a responder mounts. If registration ran in a microtask queue'd for after paint, a shortcut fired between commit and paint would walk a chain that didn't yet contain the freshly-mounted responder. `useLayoutEffect` runs synchronously after commit and before the browser paints, so by the time any user input can arrive, the node is in the manager's map.

---

## Dispatching from a control

Controls use **targeted dispatch** — the action goes directly to the control's parent responder, not the first responder. The `useControlDispatch` hook encapsulates this:

```tsx
import { useControlDispatch } from "@/components/tugways/use-control-dispatch";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";

export function TugCloseButton({ ariaLabel }: TugCloseButtonProps) {
  const controlDispatch = useControlDispatch(); // null-safe — no-op outside a provider

  const handleClick = () => {
    controlDispatch({
      action: TUG_ACTIONS.CLOSE,
      phase: "discrete",
    });
  };

  return <button type="button" aria-label={ariaLabel} onClick={handleClick}>×</button>;
}
```

`useControlDispatch` reads the parent responder ID from `ResponderParentContext` and calls `manager.sendToTarget(parentId, event)`. The first responder is irrelevant — the action always reaches the parent handler. This is the web equivalent of Cocoa's targeted action pattern (`[NSApp sendAction:action to:target from:sender]` where `target` is non-nil).

**Why not `manager.sendToFirstResponder()`?** The nil-targeted form walks from the first responder. A control's handler is typically on the control's parent responder — which may not be an ancestor of the first responder. Keyboard shortcuts use `sendToFirstResponder()` because they should go to "whatever the user is working with." Controls use `useControlDispatch()` because they have a specific receiver.

| Dispatch mode | Used by | Method | Walks from |
|--------------|---------|--------|-----------|
| **Targeted** | Controls | `useControlDispatch()` → `sendToTarget(parentId)` | Parent responder |
| **Nil-targeted** | Keyboard shortcuts, menu items | `sendToFirstResponder()` | First responder |

Three conventions enforced across every control:

1. **Callback props for user interactions are prohibited.** [L11] is a one-way door: once a control exists in the chain's vocabulary, it dispatches through the chain instead of calling a callback. `onClick` on the HTML element is fine (that's how the button receives the browser event), but an `onClose` prop at the TugCloseButton level is not — it would let a consumer bypass the chain and route the close through a direct callback, which means the walk never happens and shortcuts, validation, and the logging all break. If a control today exposes an interaction callback prop, it has not finished migrating to L11 and the callback must be removed.

2. **Sender id convention.** Controls that might coexist with siblings in the same form supply a stable opaque sender id so handlers can tell them apart. The default is `useId()`; callers can override via a `senderId` prop for tests that want determinism. See `tug-popup-button.tsx:223-229` for the canonical pattern.

3. **Controls never call `manager.sendToFirstResponder()`.** Controls always use `useControlDispatch()`. The nil-targeted `sendToFirstResponder()` is reserved for keyboard shortcuts and menu items — code paths where the action should route to the first responder.

### The `useResponderForm` shortcut

Form-shaped components (inputs, toggles, sliders, radio groups, tab bars, accordions, popup buttons) share a narrowing/registration pattern that `useResponderForm` captures. Instead of hand-writing a `useResponder` call with an actions map and defensive `typeof` narrowing, you supply typed slot callbacks:

```ts
const { ResponderScope, responderRef } = useResponderForm({
  toggle: { [switchId]: (checked: boolean) => setChecked(checked) },
  setValueNumber: { [sliderId]: (value: number) => setValue(value) },
  selectValue: { [radioGroupId]: (value: string) => setSelected(value) },
});
```

The hook wires the corresponding chain actions (`toggle`, `set-value`, `select-value`), narrows `event.value` at the slot boundary, and invokes the typed setter only on a match. Consumers never touch `event.value` directly and cannot smuggle an untyped value through. This is the dominant pattern for form controls; use it in preference to hand-rolling `useResponder` for anything that fits one of the existing slot shapes. See `use-responder-form.tsx` for the slot catalog and the narrowing rules.

---

## The keyboard pipeline

`ResponderChainProvider` installs a four-stage keyboard event pipeline on the document. Stages 1 and 2 are bubble-phase listeners except for stage 1's capture; stages 3 and 4 are intentionally thin.

```
browser keydown
      │
      ▼
┌──────────────────────────────────────────────────────────────┐
│ Stage 1 (capture)  resolve the chord to a COMMAND             │
│                                                                │
│   scoped:  manager.resolveKeybinding(event, [focusMode])       │
│            — the focus mode, then the responder walk           │
│   global:  keymapRegistry.matchChord(event)                    │
│                                                                │
│ Either way the answer is a command id, and the dispatch is     │
│ read from its registry entry — routing, payload, validity:     │
│   - binding.preventDefault? → event.preventDefault()           │
│   - dispatchCommand(commandId)                                 │
│   - If handled:                                                │
│       event.preventDefault()                                   │
│       event.stopImmediatePropagation()                         │
│                                                                │
│ Otherwise: fall through to stage 2.                            │
└──────────────────────────┬───────────────────────────────────┘
                           │ (unhandled or no binding)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│ Stage 2 (bubble)   Enter-key default-button activation        │
│                                                                │
│ If key === "Enter" and target is not an input/textarea/editor:│
│   - defaultButton = manager.peekDefaultButton()                 │
│   - defaultButton?.click()                                     │
│   - preventDefault + stopPropagation                           │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│ Stage 3 (bubble)   chain action dispatch for non-input targets│
│                                                                │
│ If event.target is an input/textarea/select/contenteditable:  │
│   - Stage 4 passthrough: browser handles the key natively.    │
│ Otherwise: stage 3 stub (no additional mappings yet).          │
└──────────────────────────────────────────────────────────────┘
```

All the interesting work is in stage 1, and what it resolves to is a **command**, not an action. Chords live as `bindings` on their command's entry in `command-registry.ts`; `keymapRegistry.matchChord` answers the global layer and `manager.resolveKeybinding` answers the scoped ones; `dispatchCommand` then reads routing, payload, and validity from the entry. That is what makes a chord and a menu item two doors on one row instead of two implementations to keep in step — and adding a shortcut is one `bindings` entry plus (if needed) one handler on the responder that owns the semantic.

There is a layer **above** stage 1 that no amount of JS can reach: AppKit resolves a menu item's key equivalent before the web view sees a `keydown` at all. A chord on a menu item therefore preempts every scoped binding regardless of focus. `keymapRegistry.resolveChord` models all four layers and is what the Keyboard Shortcuts card renders from; the doctrine is in [menus.md](menus.md).

A few load-bearing details:

- **`preventDefaultOnMatch`** exists for bindings whose browser default must be suppressed regardless of whether a responder handled the action. ⌘A is the canonical example: the browser's native "select all the page" is a scoping violation inside a card, so ⌘A sets `preventDefaultOnMatch: true` and the pipeline calls `preventDefault()` before dispatching. If no responder handles `select-all`, the dispatch returns `false`, but the browser default is already suppressed. Most bindings do NOT set this flag — they just dispatch, and if nothing handles it the browser runs its own default.

- **Stage 3's "text input escape hatch"** skips chain dispatch when the event target is an `<input>`, `<textarea>`, `<select>`, or a `contentEditable` element. This is what lets a focused text input receive raw typing without the chain stealing keys. The input still participates in stage 1 (⌘X, ⌘V, ⌘A all dispatch even when focus is inside an input, because stage 1 runs in capture phase before the input sees the key), but plain typing passes through unmolested.

- **Continuation runs after `stopImmediatePropagation`.** If a responder handled the action and returned a continuation, the pipeline invokes it after suppressing the browser's propagation. That ordering matters for clipboard flows where the sync body writes to `navigator.clipboard` (legal only inside the user-gesture handler) and the continuation mutates the document (fine after the clipboard write completes). See [Two-phase execution](#two-phase-execution-via-continuations) above.

See [action-naming.md](action-naming.md) for the full vocabulary and `keybinding-map.ts` for the current bindings.

---

## `observeDispatch` patterns

`observeDispatch` exists for one purpose: to let a transient UI dismiss itself whenever unrelated chain traffic flows past. Context menus, popup menus, tooltips, non-modal popovers, and confirm popovers all use it. The pattern is small and repeats.

```tsx
useLayoutEffect(() => {
  if (!open || !manager) return;
  return manager.observeDispatch(() => {
    if (blinkingRef.current) return;  // skip self-dispatches
    setOpen(false);                    // or dispatch cancel, or synthesize Escape
  });
}, [open, manager]);
```

Four invariants every consumer obeys:

1. **Subscribe only while open.** The effect is gated on the component's open state so the observer is installed exactly when the UI is visible and removed the moment it closes. Leaving an observer installed after close wastes work and can fire spuriously into a component that no longer cares.

2. **The blink guard (`blinkingRef`).** A menu that dispatches its own item activation triggers a chain walk that fires every observer — including its own. Without a guard, the menu would dismiss itself mid-animation. The solution is a ref set to `true` during the activation blink and the subsequent dispatch, and checked at the top of the observer callback. When `blinkingRef.current` is true, the observer skips its close path. The guard is specifically for self-dispatches; it does not suppress unrelated traffic.

3. **The close mechanism depends on the underlying primitive.** Radix primitives that expose a controlled `open` prop (Tooltip, Popover, DropdownMenu) close by calling `setOpen(false)`. Radix ContextMenu is uncontrolled by design (no `open` prop) and closes only via a native Escape keydown, so `TugContextMenu` synthesizes `document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}))` from the observer. Same observeDispatch pattern, different close invocation.

4. **Modal surfaces opt out.** Alerts and sheets are app-modal or card-modal — they intentionally block interaction with surrounding content until the user explicitly confirms or cancels. "Close on any chain activity" would surprise a user whose modal disappeared because an unrelated shortcut fired somewhere else. `TugAlert` and `TugSheet` therefore do NOT install `observeDispatch` observers at all. The canonical invariants table for all four A2.8 floating surfaces is in `internal/floating-surface-notes.ts`; consult it before adding or removing an observer on a floating surface.

One subtler filter worth knowing: `TugPopover` installs an `observeDispatch` subscription *with a focus-inside filter*. Dispatches that originate while `document.activeElement` is contained in the popover's content element are skipped, so form controls (switches, inputs, radios) nested inside the popover can emit their own setValue actions without self-dismissing the container they live in. The trade-off is that a button inside the popover that moves focus away before dispatching would not trigger the filter; in practice this has not been a problem because the form controls that matter hold their focus through the dispatch.

---

## The default button stack

Separate from the main chain but registered on the same `ResponderChainManager`: a stack of HTML button elements that can be "default activated" by pressing Enter outside a text input.

```ts
manager.pushDefaultButton(element);          // push
manager.popDefaultButton(element);           // pop (by reference)
manager.peekDefaultButton();                 // peek at the global top
manager.peekDefaultButtonInScope(paneEl);    // peek the top button WITHIN a scope
```

Stage 2 of the keyboard pipeline queries the default button on Enter, and — provided the current target is not a text input, textarea, or button — calls `.click()` on the element. This is how the Return key "presses" the default button in a dialog. Nested modal scoping works because the stack is LIFO: an inner dialog pushes its button on open, Enter activates the inner button, and close pops it, restoring the outer dialog's default button automatically.

**The stack is process-global; activation must be pane-scoped ([D15]).** A `Return` belongs to exactly one pane — the one the user is working in. With panes side by side, a sheet in pane B (e.g. an unbound session card's session picker) pushes its primary button onto the *same* global stack, so a naive `peekDefaultButton().click()` on a `Return` typed in pane A would press pane B's button and dismiss its sheet. Every default-button activation site therefore scopes to the originating pane via `peekDefaultButtonInScope(scope)` — which walks the stack top-down and returns the first button contained in `scope` — passing the **first responder's `.tug-pane`** (document Stage 2) or the **editor's own `.tug-pane`** (the text-editor keymap's submit-Enter defer). A default button in another pane is then unreachable by construction. The two activation sites are `responder-chain-provider.tsx` (Stage 2) and `tug-text-editor.tsx` (the keymap's `peekDefaultButton` closure); both fall back to the global `peekDefaultButton()` only when there is no pane context (gallery / standalone). This was a real cross-pane bug: a `/rewind` submitted in one pane pressed another pane's picker Open.

You almost certainly do not write code that touches this directly. `TugButton` pushes/pops via a `defaultButton` prop when its parent dialog asks; the dialog components (`TugConfirmPopover`, `TugAlert`) wire that prop on their primary-action button. If you are writing a new modal-shaped component, the convention is to pass `defaultButton` to the confirm button; if you are writing a plain button, leave the default-button machinery alone.

---

## Action vocabulary and naming

Action names are API. Every action has exactly one canonical kebab-case wire string, exported as a `TUG_ACTIONS.*` constant in `action-vocabulary.ts`, and referenced by constant at every call site. The naming shape is `<verb>-<object>[-<modifier>]`; single-word names are valid when the verb is unambiguous in context. See [action-naming.md](action-naming.md) for the full convention, the three-way classification (chain action / control frame / both), the payload shapes per action, and the enforcement policy.

Two practical reminders for chain code:

- Adding a new action is: pick a name, add a constant to `TUG_ACTIONS`, document the payload inline, wire a handler, write a test. The derived `TugAction` union picks up the new member automatically.
- A raw string literal in an `action:` position is a code-review smell. The type system accepts it (the literal is still a valid union member), but it breaks grep, find-references, and future renames. Always `TUG_ACTIONS.X`.

---

## Anti-patterns

Each of these used to exist in the codebase before L11 and the A-phases landed, and each has exactly one right answer.

- **Callback props for user interactions.** An interactive component that exposes an `onClose`, `onConfirm`, `onCancel`, `onSelect`, or equivalent prop for a user-triggered action. The callback bypasses the chain: no walk, no first-responder promotion, no observer notification, no keyboard shortcut route. Use `manager.dispatch` and make the consumer register a responder handler. Non-user-interaction callbacks (`onOpenChange` for mirroring Radix state upward, lifecycle observers) are fine.

- **Per-component keyboard listeners.** A component that installs its own `keydown` listener to catch ⌘X or ⌘A. It duplicates what the funnel already does, it does not respect first-responder priority, it races other listeners, and — the part that costs most — it is invisible to `resolveChord`, to the keymap pane, and to the collision lint, so nothing can tell you the chord is taken until you press it. Put the chord in the command's `bindings`, or register a scoped one with `useKeybindings`; the responder handles the dispatched action. A listener whose claim lasts only as long as a pointer gesture (a drag's Escape) is the sanctioned exception, and it says so in a comment. The text editor's own `keydown` for plain typing is not a shortcut listener — plain typing goes through stage 4's passthrough, not the chain.

- **Global window/document listeners for chain work.** A component that attaches `window.addEventListener("pointerdown", ...)` to dismiss itself on outside click, or `document.addEventListener("keydown", ...)` to listen for Escape. The chain already provides the signal via `observeDispatch` or stage 1 bindings; parallel event listeners create ordering bugs with the chain's capture-phase listeners. Use `observeDispatch` for chain-reactive dismissal and the keybinding map for shortcuts.

- **`makeFirstResponder` from component code.** Calling `manager.makeFirstResponder(id)` from a component in response to a user gesture. The pointerdown/focusin promotion path already does this — the component is fighting the chain for control of its own first-responder state. The only sanctioned programmatic promotion is `DeckCanvas` promoting a freshly-opened card, where no pointer or focus event has fired yet. If you think you need it elsewhere, ask first.

- **Stale closures in handlers.** A handler body that reads a React state value captured at render time, then is called by the chain later when that value has changed. The handler runs with the stale snapshot. Symptom: "the close button closed the wrong card after I switched tabs." Fix: put the state in a ref (`cardsRef.current`) and read the ref from the handler body. [L07] is the law; the `useResponder` hook's live proxy handles *handler identity* changes, but the *body* of your handler is your responsibility.

- **Two-path render forking inside/outside provider.** Splitting a leaf control into `TugInputPlain` and `TugInputWithResponder` with a `useResponderChain() === null` check picking between them. The check flips React's component identity on provider transitions and destroys caret position, focus, and any uncontrolled input state the user had mid-keystroke. Use `useOptionalResponder` — one component, one path, the hook silently no-ops when the manager is absent. See the long comment at `use-responder.tsx:187-211` for the exact scenario this hook was added to fix.

- **Per-cell floating surfaces.** A `TugListView` cell renderer that mounts its own popover, alert, sheet, context menu, or any other transient floating surface. The N parallel responder lifetimes interact unpredictably with virtualization, data updates, and Radix portal cleanup — when a row unmounts on a confirm-action, the popover's cleanup cascade collides with the cell's React-tree teardown, and listeners leak / focus restoration runs against detached triggers / subsequent clicks find the chain in an inconsistent state. Hoist the surface to the responder above the list (typically the form), keep one floating-surface instance, and address the right anchor at request time via a `data-id` lookup or a callback ref. The session picker's session-forget flow is the canonical case study. Cell renderers themselves should be pure functions — see the cell-renderer rule in [component-authoring.md](component-authoring.md).

- **Raw `<button>` for in-list trailing actions.** A cell renderer (or any in-list trailing affordance) that drops a raw `<button>` for a trash / more / remove icon. Without `data-tug-focus="refuse"` the button accepts browser focus on click in Chrome and promotes the chain via the document-level pointerdown walk; the consumer then patches around those behaviors with hand-rolled `e.preventDefault()` and `e.stopPropagation()` calls that fight Radix triggers, click bubbling, and focus restoration in subtle ways. Use `TugIconButton` (in `tug-icon-button.tsx`) — it bakes in focus refusal, targeted dispatch via `useControlDispatch`, and the standard hover/focus token treatment.

- **Key-card dispatch from a component / control origin.** A component dispatching an action it originated — a button click, an editor recognizing a typed command — via the *key card* (`sendToKeyCard` / the former `useKeyCardDispatch`). The key card is derived from the **global** first responder, so when a pane-modal surface holds first responder in *another* pane, the dispatch lands on that pane's card and hijacks it. A control/editor emission has a specific receiver: its **parent responder**. Use `useControlDispatch()` (targeted, `sendToTarget(parentId)`) — the walk reaches the owning card by structural identity, independent of focus. Key-card scope is for **keyboard shortcuts only** (`scope: "key-card"` in the keybinding map), where "whichever card the user is in" is genuinely the intended target. Routing a typed `/command` from a prompt entry through the key card was exactly this bug: a `/rewind` typed in one pane dismissed a sheet open in another.

- **Modal surfaces portaling to canvas overlay.** A pane-modal surface (sheet, future modal-class surface) that portals into the canvas-overlay root and tries to confine itself to the host pane via `getBoundingClientRect()` + `MutationObserver` choreography. The canvas-overlay tier is a single global stacking context — anything portaled there sits above ALL panes, so any pixel of bleed (subpixel rounding, drop-shadow extension, animation overshoot, miscalculated bounds) paints over peer panes. The right answer is to portal pane-modal surfaces into the host pane's frame (`TugPaneFrameContext`) so they live inside the pane's stacking context — peer panes z-stacked above paint above the panel automatically, and bleed is structurally impossible. Anchor-relative transient surfaces (popovers, tooltips, the alert) are NOT pane-modal and continue to portal to canvas-overlay. See [pane-model.md §Pane-modal vs canvas-overlay surfaces](pane-model.md#pane-modal-vs-canvas-overlay-surfaces).

---

## Cross-references

**Laws:**
- [L11] controls emit actions; responders own state that actions operate on — the law this document codifies
- [L03] `useLayoutEffect` for registrations events depend on — why `useResponder` uses layout effects
- [L07] handlers read current state through refs, not stale closures — the most common chain bug
- [L08] mutation-transaction semantics — the reason action phases (begin/change/commit/cancel) exist
- [L20] token sovereignty — the composition rule compound components obey alongside chain participation

**Sibling documents:**
- [action-naming.md](action-naming.md) — the kebab-case name convention, the `TUG_ACTIONS` constants, the three-way classification
- [component-authoring.md](component-authoring.md) — the component author's checklist, which defers the chain mechanics to this document
- [card-state-model.md](card-state-model.md) — for the focus-refusal mechanism, see `card-state-model.md`

**Source files:**
- `tugdeck/src/components/tugways/responder-chain.ts` — `ResponderChainManager`, `ActionEvent`, `ActionHandler`, `ResponderNode`, the dispatch methods, the observer API, the first-responder sync
- `tugdeck/src/components/tugways/responder-chain-provider.tsx` — the provider, the four-stage keyboard pipeline, the pointerdown/focusin promotion listeners, the `useResponderChain` / `useRequiredResponderChain` hooks
- `tugdeck/src/components/tugways/use-responder.tsx` — `useResponder` / `useOptionalResponder`, `ResponderScope`, `ResponderParentContext`, the live-proxy action map, the stale-focus re-promotion path
- `tugdeck/src/components/tugways/use-responder-form.tsx` — the slot-typed form-shaped shortcut over `useResponder`
- `tugdeck/src/components/tugways/action-vocabulary.ts` — the `TUG_ACTIONS` constants, the `TugAction` union, per-action payload conventions
- `tugdeck/src/components/tugways/command-registry.ts` — the command table, and every default chord
- `tugdeck/src/components/tugways/keymap-registry.ts` — `matchChord`, `resolveChord`, `menuChords`
- `tugdeck/src/components/tugways/keybinding-map.ts` — the `KeyBinding` shape scoped registrations use
- `tugdeck/src/components/tugways/internal/floating-surface-notes.ts` — the canonical invariants table for the four A2.8 floating surfaces (popover, confirm-popover, alert, sheet)
