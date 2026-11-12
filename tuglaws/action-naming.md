# Action Naming

*Every action that flows through the responder chain, the keybinding map, or the Swift↔JS Control-frame protocol has exactly one canonical name, written as `kebab-case-with-dashes`, exported as a `TUG_ACTIONS.*` constant, and referenced by constant — never by raw string literal — at every call site.*

*Cross-references: `[D##]` → [design-decisions.md](design-decisions.md). `[L##]` → [tuglaws.md](tuglaws.md).*

---

## Why

Action names are API. They sit at three protocol boundaries:

1. **Chain dispatch** — `manager.sendToFirstResponder({ action, ... })` ↔ `useResponder({ actions: { [name]: handler } })`. The name is how a control communicates intent to its responder.
2. **Keybinding map** — `{ key: "KeyZ", meta: true, action: ... }`. The name is how the keyboard reaches the chain.
3. **Control-frame RPC** — `sendControl("name")` on the Swift side ↔ `registerAction("name", handler)` on the JS side. The name is a wire-format symbol carried across a process boundary.

When the same concept is spelled differently in each boundary, grep stops working, cross-references rot, and reviewers have to remember whether "add a card" is `addCardToActivePane` or `add-card-to-active-pane` depending on which file they're reading. The point of this document is to make **the same concept always look the same**, and **different concepts always look different**, wherever the name appears.

The design-system CSS custom properties get this treatment via [token-naming.md](token-naming.md) — a fixed shape, a fixed prefix, a fixed source of truth. Action names earn the same rigor for the same reasons.

[L11] controls emit actions; responders handle actions. Action-naming is L11's vocabulary made canonical.

---

## The Registry Layer

Above the three-way classification sits the **command registry** (`components/tugways/command-registry.ts`): one entry per user-invocable command, carrying its title, its `routing`, the menu item it drives, and its default chords. Every emitter — a Swift menu item's control frame, the key pipeline, a button, a slash bridge — resolves through that table and calls `dispatchCommand(id)`. That routing is not optional: [L30] requires it, and [commands.md](commands.md) is its authoring contract. This document governs what a command is *called*; that one governs how it is *defined and reached*.

This changes what the classification below *is*. A name's category used to be a fact about which tables it appeared in, maintained by hand in two places. It is now a **consequence of its entry's `routing`**:

| `routing` | The old category | What dispatches it |
|---|---|---|
| `first-responder` / `key-card` / `target` | Chain action, or Both | `dispatchCommand` walks the chain the routing names |
| `registry` | Control-frame-only | `dispatchCommand` calls the handler `registerAction` registered |
| `native` | — | Nothing in JS. Represented so the keymap UI can show it; AppKit performs it |

So "Both" is no longer a shape anyone authors. A menu item and a chord are two doors on one row, and the row says once how to open it. The thirty-odd one-line re-dispatch handlers that used to be the Both category are gone; what remains in `action-dispatch.ts` is the tugcast data frames, the `registry`-routed bodies, and one fork.

**What is deliberately outside the table:** tugcast data frames (`spawn_session_ok`, `session_updated`, and the ~20 siblings — protocol, not commands), form-control currency (`set-value`, `toggle`, `select-value`, `set-property` — traffic between a control and its responder, not user intents), and the substrate text-editing bindings (⌃U / ⌃W / ⌥F / ⌥B and the CM6 keymaps — movement and deletion that only ever target the focused input). Each of those keeps the raw path, and the exclusions are checked in as a set so "absent from the table" is never a silent omission.

---

## Three-Way Classification

Every action name belongs to exactly one of three categories. The category determines where the name is defined, who dispatches it, and who receives it.

| Category | Defined in | Dispatched by | Handled by | Example |
|----------|------------|---------------|------------|---------|
| **Chain action** | `TUG_ACTIONS` in `action-vocabulary.ts` | `manager.dispatch` (chain walk), `manager.sendToFirstResponderForContinuation`, the key pipeline resolving through `keymap-registry.ts` | Responders via `useResponder`'s `actions` map | `cut`, `close`, `move-to-slot` |
| **Control frame** | `registerAction` calls in `action-dispatch.ts` | Swift `sendControl(...)` → `dispatchAction` on the JS side | Handler body inside `registerAction`; may side-effect directly, may dispatch a chain action | `reload`, `set-theme`, `eval` |
| **Both** (identity) | Historically the same string in both tables — no longer authored; a registry entry's `routing` names both doors | Swift `sendControl(...)` *and* `manager.dispatch` | Control-frame handler was a one-liner that re-dispatched the chain action; responders handled it | `close`, `add-card-to-active-pane`, `show-component-gallery` |

**Rules:**

- A **chain action** name must NOT be used for an unrelated Control-frame purpose. If a Control-frame RPC happens to carry the same name as a chain action, it MUST be an identity-mapping "Both" entry that re-dispatches to the chain. The two layers do not compete for the same name with different meanings.
- A **Control-frame-only** name names an operation that crosses the process boundary but never walks the responder chain — theme switches, page reloads, script eval. These actions stay in `action-dispatch.ts` only and are NOT added to `TUG_ACTIONS`.
- A **Both** entry is the preferred shape for any RPC whose job is to inject a chain dispatch on behalf of a Swift menu item or bridge call. The Control-frame handler becomes a one-liner:

  ```ts
  registerAction(TUG_ACTIONS.ADD_CARD_TO_ACTIVE_PANE, () => {
    responderChainManagerRef?.sendToFirstResponder({
      action: TUG_ACTIONS.ADD_CARD_TO_ACTIVE_PANE,
      phase: "discrete",
    });
  });
  ```

  No name translation. The Swift `sendControl("add-card-to-active-pane")` and the `manager.sendToFirstResponder({ action: "add-card-to-active-pane" })` carry the same string; the responder chain takes over from there.

  The menu bar is the main producer of Both entries: every keyboard chord promoted to a menu item needs one, because AppKit swallows the chord before the WKWebView sees it. The full menu-driven catalog — including the key-card-scoped variants (`focus-prompt`, `set-permission-mode`, `interrupt-session`) and the generic `run-card-command` — lives in [menus.md](menus.md).

---

## The Shape of a Name

```
<verb>-<object>[-<modifier>]
```

- **All lowercase letters.** No uppercase, ever.
- **Words separated by single dashes.** No underscores. No double-dashes.
- **Verb first.** `close`, `cut`, `select`, `move`, `toggle`, `show`, `add`, `remove`, `reset`, `set`, `dismiss`, `confirm`, `cancel`, `open`, `focus`, `cycle`, `increment`, `decrement`, `preview`, `find`.
- **Object second** (when the verb needs a direct object). `close-tab`, `select-all`, `move-to-slot`, `set-value`, `set-property`, `toggle-section`, `show-settings`, `add-tab`, `reset-layout`, `focus-next`, `cycle-card`, `preview-color`.
- **Modifier third** (when the object needs disambiguation). `add-card-to-active-pane` — the object is the card, but the modifier pins down *which* pane receives it. `show-component-gallery` — the object is the gallery, the modifier narrows *which* gallery.
- **Single-word names are valid** when the verb alone is unambiguous in the chain's context. `close`, `cut`, `copy`, `paste`, `undo`, `redo`, `delete`, `duplicate`, `toggle`, `find`, `minimize`, `maximize`, `reload`. These are dispatched without an object because the first responder supplies it — `close` closes whatever responds to `close`; `undo` undoes whatever owns the history at the focus point.

**No compound words inside a single slot.** The verb, object, and modifier are each a single English word. `showGallery` or `previousTab` are camelCase and forbidden; `show-gallery` and `previous-tab` are the canonical forms. If you find yourself wanting to write `showcomponentgallery` (three words, no dashes) because the concept feels atomic, split it at the natural word boundaries instead.

### Ambiguity avoidance

Different concepts must get visually distinct names. A few guardrails:

- **Same verb, different object = different name.** `close-tab` (closes a single tab) vs. `close` (closes the whole card responder). These are siblings, not synonyms.
- **Same verb, different modifier = different name.** `add-tab` (dispatched by a card-internal control; the responder supplies the card id) vs. `add-card-to-active-pane` (dispatched by the global menu; the responder walks to find the active pane). These are peers at different scopes.
- **No synonyms.** Pick `delete` or `remove`, not both. Pick `show` or `open`, not both. The vocabulary is small; precedent wins.

The current vocabulary prefers:
- `show-*` for UI that becomes visible (menus, galleries, settings panels)
- `dismiss-*` for closing a popover
- `cancel-*` / `confirm-*` for dialogs
- `close-*` for cards and tabs
- `set-*` for value writes
- `select-*` for selection changes
- `toggle-*` for boolean flips
- `jump-to-*` for direct navigation to an indexed target
- `cycle-*` for round-robin rotation
- `focus-*` for focus movement

---

## The Constants Module

All action names live as constants in `tugdeck/src/components/tugways/action-vocabulary.ts`, in a single `as const` object. The `TugAction` type is **derived** from that object, not declared separately.

```ts
// action-vocabulary.ts

export const TUG_ACTIONS = {
  // Clipboard
  CUT:         "cut",
  COPY:        "copy",
  PASTE:       "paste",
  SELECT_ALL:  "select-all",
  SELECT_NONE: "select-none",

  // Editing
  UNDO:        "undo",
  REDO:        "redo",
  DELETE:      "delete",
  DUPLICATE:   "duplicate",

  // ...

  CLOSE:                  "close",
  ADD_CARD_TO_ACTIVE_PANE: "add-card-to-active-pane",
  SHOW_COMPONENT_GALLERY: "show-component-gallery",
  MOVE_TO_SLOT:           "move-to-slot",
  // ...
} as const;

/**
 * The complete typed action vocabulary. Derived from TUG_ACTIONS so
 * adding a new action is one line — the key becomes the constant's
 * exported name, the value becomes the wire-format string, and the
 * union type picks it up automatically.
 */
export type TugAction<Extra extends string = never> =
  | typeof TUG_ACTIONS[keyof typeof TUG_ACTIONS]
  | Extra;
```

**Constant naming:**

- The object is **`TUG_ACTIONS`** (plural, uppercase with underscore).
- Each key is the name of the action, in **`SCREAMING_SNAKE_CASE`**, derived mechanically from the kebab-case wire value:
  - `"select-all"` → `SELECT_ALL`
  - `"add-card-to-active-pane"` → `ADD_CARD_TO_ACTIVE_PANE`
  - `"move-to-slot"` → `MOVE_TO_SLOT`
- No prefix on the key. `TUG_ACTIONS.CUT`, not `TUG_ACTIONS.TUG_CUT`. The object name carries the namespace.

**Call sites always use the constant, never the raw string:**

```ts
// ✅ correct
manager.sendToFirstResponder({ action: TUG_ACTIONS.CUT, phase: "discrete" });

const { ResponderScope, responderRef } = useResponder({
  id: cardId,
  actions: {
    [TUG_ACTIONS.CLOSE]: (_e: ActionEvent) => handleClose(),
    [TUG_ACTIONS.SELECT_ALL]: (_e: ActionEvent) => handleSelectAll(),
  },
});

// command-registry.ts — the chord is a default binding on the command's entry
{
  id: TUG_ACTIONS.UNDO,
  title: "Undo",
  routing: "first-responder",
  menuItemId: "edit.undo",
  bindings: [chord({ key: "KeyZ", meta: true, label: "z" })],
}
```

```ts
// ❌ forbidden — raw string literal
manager.sendToFirstResponder({ action: "cut", phase: "discrete" });
```

The type system won't catch this (the literal `"cut"` is still a valid `TugAction` member), so it's a review-time convention. The constant reference is what makes grep, find-references, and future renames work.

**Gallery / test-only actions** live in a sibling constants object (e.g. `TUG_GALLERY_ACTIONS`) and are opted in via the `TugAction<Extra>` type parameter, same as the current `GalleryAction` escape hatch. Gallery actions follow the same kebab-case wire format and the same `SCREAMING_SNAKE_CASE` key convention.

---

## Adding a New Action

1. **Pick a name** following the `<verb>-<object>[-<modifier>]` rule. Verify it doesn't collide with an existing entry and isn't a synonym for something already in `TUG_ACTIONS`.
2. **Give it a registry entry** in `command-registry.ts` if a user can invoke it: a title, a `routing`, a `menuItemId` if it has a menu door, and its default `bindings`. The classification below then follows from `routing` rather than being chosen. The full procedure — doors, validity, mirroring, the chord decisions — is in [commands.md](commands.md#adding-a-command).
3. **Add an entry to `TUG_ACTIONS`** in `action-vocabulary.ts` if it's a chain action or a Both. Skip this step for Control-frame-only actions — they live in `action-dispatch.ts`.
4. **Document the payload convention** in the same file, near the constant, using the existing in-line comment pattern (`// set-value: payload — shape depends on control: ...`). Every action whose handler reads `event.value` needs this so handler authors know what to narrow to.
5. **Register a handler somewhere.** A responder via `useResponder` (chain), or a `registerAction` call (control frame), or both.
6. **If it's keyboard-bindable,** put the chord in the entry's `bindings` — a list, always, and marked `menuEligible` if the menu item should carry it. The key pipeline and the host's menu bar are both derived from there, so there is no second place to add it.
7. **Write tests** that dispatch the constant, not the raw string.

---

## Canonical Renames (camelCase → kebab-case)

The table below is the one-shot rename mapping applied during the A3 → action-naming transition. It is the canonical answer to "what is the new name for X?" Every call site in the codebase is updated to reference the new constant; any remaining camelCase literal is a bug.

**Chain actions**

| Old (camelCase)         | New (kebab-case)              | Constant                              |
|-------------------------|-------------------------------|---------------------------------------|
| `cut`                   | `cut`                         | `TUG_ACTIONS.CUT`                     |
| `copy`                  | `copy`                        | `TUG_ACTIONS.COPY`                    |
| `paste`                 | `paste`                       | `TUG_ACTIONS.PASTE`                   |
| `selectAll`             | `select-all`                  | `TUG_ACTIONS.SELECT_ALL`              |
| `selectNone`            | `select-none`                 | `TUG_ACTIONS.SELECT_NONE`             |
| `undo`                  | `undo`                        | `TUG_ACTIONS.UNDO`                    |
| `redo`                  | `redo`                        | `TUG_ACTIONS.REDO`                    |
| `delete`                | `delete`                      | `TUG_ACTIONS.DELETE`                  |
| `duplicate`             | `duplicate`                   | `TUG_ACTIONS.DUPLICATE`               |
| `cycleCard`             | `cycle-card`                  | `TUG_ACTIONS.CYCLE_CARD`              |
| `previousTab`           | `previous-tab`                | `TUG_ACTIONS.PREVIOUS_TAB`            |
| `nextTab`               | `next-tab`                    | `TUG_ACTIONS.NEXT_TAB`                |
| `focusNext`             | `focus-next`                  | `TUG_ACTIONS.FOCUS_NEXT`              |
| `focusPrevious`         | `focus-previous`              | `TUG_ACTIONS.FOCUS_PREVIOUS`          |
| `moveToSlot`            | `move-to-slot`                | `TUG_ACTIONS.MOVE_TO_SLOT`            |
| `confirmDialog`         | `confirm-dialog`              | `TUG_ACTIONS.CONFIRM_DIALOG`          |
| `cancelDialog`          | `cancel-dialog`               | `TUG_ACTIONS.CANCEL_DIALOG`           |
| `dismissPopover`        | `dismiss-popover`             | `TUG_ACTIONS.DISMISS_POPOVER`         |
| `setValue`              | `set-value`                   | `TUG_ACTIONS.SET_VALUE`               |
| `toggle`                | `toggle`                      | `TUG_ACTIONS.TOGGLE`                  |
| `selectValue`           | `select-value`                | `TUG_ACTIONS.SELECT_VALUE`            |
| `incrementValue`        | `increment-value`             | `TUG_ACTIONS.INCREMENT_VALUE`         |
| `decrementValue`        | `decrement-value`             | `TUG_ACTIONS.DECREMENT_VALUE`         |
| `selectTab`             | `select-tab`                  | `TUG_ACTIONS.SELECT_TAB`              |
| `closeTab`              | `close-tab`                   | `TUG_ACTIONS.CLOSE_TAB`               |
| `addTab`                | `add-tab`                     | `TUG_ACTIONS.ADD_TAB`                 |
| `reopenTab`             | `reopen-tab`                  | `TUG_ACTIONS.REOPEN_TAB`              |
| `toggleSection`         | `toggle-section`              | `TUG_ACTIONS.TOGGLE_SECTION`          |
| `close`                 | `close`                       | `TUG_ACTIONS.CLOSE`                   |
| `minimize`              | `minimize`                    | `TUG_ACTIONS.MINIMIZE`                |
| `maximize`              | `maximize`                    | `TUG_ACTIONS.MAXIMIZE`                |
| `showComponentGallery`  | `show-component-gallery`      | `TUG_ACTIONS.SHOW_COMPONENT_GALLERY`  |
| `showSettings`          | `show-settings`               | `TUG_ACTIONS.SHOW_SETTINGS`           |
| `resetLayout`           | `reset-layout`                | `TUG_ACTIONS.RESET_LAYOUT`            |
| `addCardToActivePane` | `add-card-to-active-pane`   | `TUG_ACTIONS.ADD_CARD_TO_ACTIVE_PANE` |
| `find`                  | `find`                        | `TUG_ACTIONS.FIND`                    |
| `setProperty`           | `set-property`                | `TUG_ACTIONS.SET_PROPERTY`            |

**Gallery / test-only actions** (opt-in via `TugAction<GalleryAction>`)

| Old          | New              | Constant                            |
|--------------|------------------|-------------------------------------|
| `demoAction` | `demo-action`    | `TUG_GALLERY_ACTIONS.DEMO_ACTION`   |
| `previewColor`    | `preview-color`    | `TUG_GALLERY_ACTIONS.PREVIEW_COLOR`    |
| `previewHue`      | `preview-hue`      | `TUG_GALLERY_ACTIONS.PREVIEW_HUE`      |
| `previewPosition` | `preview-position` | `TUG_GALLERY_ACTIONS.PREVIEW_POSITION` |

**Control-frame-only actions** (no chain-action counterpart — these stay in `action-dispatch.ts` and do NOT belong in `TUG_ACTIONS`)

| Name (unchanged) | Purpose |
|------------------|---------|
| `reload`         | Page reload with dedup guard. |
| `set-dev-mode`   | Toggle maker menu visibility via WKScriptMessageHandler. |
| `set-theme`      | Switch the active CSS theme. |
| `next-theme`     | Advance to the next shipped theme. |
| `show-card`      | Add a card by component id. |
| `focus-pane`     | Activate a deck pane by id (`paneId` in payload). Swift View menu → `sendControl`; handler in `action-dispatch.ts` activates the pane's active card. |
| `source-tree`    | Open the source-tree picker in Swift. |
| `eval`           | JavaScript eval with response Control frame. |

**Control-frame ↔ chain identity renames** (the Both category — Control-frame handlers that previously translated to a different chain-action name must converge)

| Old control-frame name     | Old chain action       | New (identity) name            |
|----------------------------|------------------------|--------------------------------|
| `add-card-to-active-window` (superseded wire) | `addCardToActiveWindow` | `add-card-to-active-pane` (both) |
| `close-active-card`        | `close`                | `close` (both) — Control frame renamed from `close-active-card` to `close` |
| `show-component-gallery`   | `showComponentGallery` | `show-component-gallery` (both) |

The `close-active-card` Control-frame name (introduced in A3.3) is renamed to `close` during this migration so it matches the chain-action name. The Swift `@objc closeActiveCard(_:)` selector stays (Swift method names follow Swift conventions; only the `sendControl("close")` string changes).

Pane vocabulary: the **`focus-pane`** wire and **`paneId`** payload key name the in-canvas container. The names are Pane-specific so canvas containers are not confused with `NSWindow` or the browser `window` global. See [pane-model.md](pane-model.md) for the full Deck → Pane → Card model.

---

## Action Names vs. Browser Command Names

Two naming systems coexist in editing code:

| Namespace | Casing | Examples | Where it flows |
|-----------|--------|----------|----------------|
| **Action names** (ours) | `kebab-case` | `"select-all"`, `"cut"`, `"paste"` | Responder chain dispatch, keybinding map, Control-frame RPC |
| **`document.execCommand` names** (the browser's) | `camelCase` | `"selectAll"`, `"insertText"`, `"forwardDelete"` | Browser editing API calls |

These describe overlapping concepts — the chain action `"select-all"` and the browser command `"selectAll"` both mean "select everything" — but they are **separate vocabularies with different casing rules**. One flows through `manager.dispatch`; the other flows to `document.execCommand`. They must never be mixed.

**The rule:** When calling `document.execCommand(...)`, use the browser's camelCase command name — never a `TUG_ACTIONS.*` constant, never a kebab-case string. The browser API does not recognize kebab-case variants; WebKit silently ignores them with no error.

**The canonical `execCommand` names used in the codebase:**

```
selectAll    insertText    insertHTML    insertLineBreak
delete       forwardDelete undo          redo
```

These are string literals at the call site — not constants, not derived from action names. They are a browser API vocabulary that we consume, not one we define.

**Why this matters:** The action-naming migration (A3) converted all chain-action strings to kebab-case. A `document.execCommand` call that happened to contain the same concept (`"select-all"` instead of the correct `"selectAll"`) broke silently — the browser ignored the unrecognized command, the handler appeared to succeed, and the bug only surfaced because the Swift Edit menu (which bypasses JavaScript entirely via `NSText.selectAll(_:)`) still worked, creating a visible discrepancy.

---

## Out of Scope

- **Swift method names, selectors, and variable names.** Swift follows Swift conventions. Only the `sendControl("<wire-name>")` string argument is constrained by this document.
- **CSS custom properties and class names.** Those are governed by [token-naming.md](token-naming.md). Action names never appear in CSS.
- **JavaScript identifier names.** Handler functions (`handleCut`, `handleSelectAll`) and callback props follow JS camelCase; only the action *string* is constrained.
- **Browser API command names.** `document.execCommand` uses its own camelCase vocabulary (`"selectAll"`, `"insertText"`, etc.). These are not action names and are not governed by this document's kebab-case rule. See [Action Names vs. Browser Command Names](#action-names-vs-browser-command-names) above.
- **Feed ids, store method names, and other non-action strings.** If it isn't dispatched through `manager.dispatch`, bound on a registry entry's `bindings` in `command-registry.ts`, or sent as a `sendControl(...)` RPC name, this document does not apply.

---

## Enforcement

For now: **convention and code review.** The type system already catches typos in action names via the `TugAction` union, so the risk of a wrong name reaching runtime is low. The remaining risk is *inconsistent reference style* — some call sites typing `"cut"` and others typing `TUG_ACTIONS.CUT`. Reviewers flag raw string literals in action positions and ask for the constant.

If drift becomes measurable, a follow-up can add a `no-restricted-syntax` ESLint rule that bans string literals in `action:` property positions outside of `action-vocabulary.ts` itself. The rule is cheap to write and costs about fifteen lines of config, but is not worth adding preemptively — it's the enforcement mechanism for a problem we haven't proven we have.

---

## Cross-References

- [L11] controls emit actions; responders handle actions — the law this document codifies a vocabulary for
- [L30] every user-invocable command is a registry entry reached through the two funnels — see [commands.md](commands.md)
- [token-naming.md](token-naming.md) — sibling document for CSS tokens; same principle, different domain
- [component-authoring.md](component-authoring.md) — the checklist for new components, which references `TUG_ACTIONS` constants at the dispatch-site and registration-site steps
- `tugdeck/src/components/tugways/action-vocabulary.ts` — canonical `TUG_ACTIONS` constants, `TugAction` type, and payload conventions
- `tugdeck/src/components/tugways/command-registry.ts` — the command table: one entry per user-invocable command, with its routing, its menu item, and its default chords
- `tugdeck/src/components/tugways/keymap-registry.ts` — chord resolution and shadowing over that table
- `tugdeck/src/components/tugways/keybinding-map.ts` — the `KeyBinding` shape that scoped registrations still use
- `tugdeck/src/action-dispatch.ts` — the tugcast data-frame handlers, the `registry`-routed command bodies, and the one fork into `dispatchCommand`
