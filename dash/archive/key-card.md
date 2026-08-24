# Key Card

*Adding a stable "active card" concept alongside the first responder. Modeled on AppKit's distinction between the first responder and the key window.*

*Cross-references: [responder-chain.md](../tuglaws/responder-chain.md), [tuglaws.md](../tuglaws/tuglaws.md).*

---

## Background

The responder chain answers "where do typed actions go?" via the first responder — the innermost component the user is currently working with. Walk up `parentId` from there and the first `TugCard` you encounter is the de facto active card.

This implicit derivation works for the common case: an editor inside a card has focus, the chain walks up, the card handles its actions, the card chrome can render "active" by checking whether first responder is one of its descendants.

It breaks down in three concrete cases:

1. **First responder lands above any card.** After a sheet closes, on initial mount, or when the user clicks the canvas background, first responder may sit on `DeckCanvas`. No card is active. A menu item like "close active card" has no target. Nothing in the UI reflects which card the user was last working in.

2. **Inspector outside the card subtree.** The property inspector dispatches via `sendToTarget(cardId, …)` to a card it is not a descendant of. Dispatch works, but the card has no signal that it is the subject of the inspector — its chrome cannot reflect "I am being inspected."

3. **Focus restoration after modal dismissal.** When a sheet closes, the chain promotes the nearest still-registered ancestor of whatever unmounted. There is no deliberate "return focus to the card the user was working in" path.

AppKit solves the analogous problem with the **key window** concept: a stable "this window is the user's active subject" signal that is decoupled from which inner control has focus. We adopt the same pattern, scoped narrowly to cards.

---

## Goals

- A stable, queryable "active card" identity that survives transient focus changes (button clicks, inspector interactions, modal dismissals).
- Visual chrome on cards that reflects key state independent of inner focus.
- Menu items and global shortcuts targeting "the active card" have a stable answer.
- Zero impact on the existing first-responder mechanism for components that don't care.

## Non-goals

- A general "key responder" addressable to any node. Key is a property of one specific tier (cards), mirroring AppKit's restriction to windows. Generalizing recreates the first responder concept with a second name.
- Replacing or restructuring the existing first-responder promotion path.
- Persistence across page reloads.

---

## Phase 1 — Derived selector (no stored state)

Add a kind tag to responder registration and a derived query on the manager. No new state machine, no second axis to keep in sync.

### Changes

1. **Extend `useResponder` options** with an optional `kind?: ResponderKind` field, where `ResponderKind` is a typed enum (string union) defined alongside the manager. Initial members: `"card"`. Cards pass `kind: "card"`. The manager indexes nodes by kind. Using an enum from day one catches typos at compile time and gives a single point to add future tiers (e.g., `"panel"`) under review.

2. **Add `manager.getKeyResponderOfKind(kind) → string | null`.** Walks up `parentId` from the current first responder and returns the id of the nearest registered node matching `kind`. Returns null if none found.

3. **Add `manager.getKeyCard()` as a thin wrapper** over `getKeyResponderOfKind("card")`. Most consumers use this; `getKeyResponderOfKind` is the escape hatch if a future tier (e.g., a "panel" kind) needs the same mechanism.

4. **Subscription support.** Add `manager.observeKeyResponder(kind, callback)` so chrome can re-render when key card changes. Implementation is trivial: it fires whenever first responder changes and the derived value changes.

5. **Card chrome consumes the derived value** via a small hook `useIsKeyCard(cardId)` that subscribes to changes and returns a boolean. Cards render their active chrome based on this boolean instead of (or in addition to) "is first responder my descendant?"

### What this gives us

- Case 1 is partially addressed: when first responder is on the canvas, `getKeyCard()` returns null. Menu items can disable themselves cleanly. Card chrome shows no card as active, which is honest — no card *is* active.
- Case 2 is unaddressed by phase 1 alone (the inspector cannot make a card "key" without first responder being inside it). Phase 2 picks this up.
- Case 3 is unaddressed by phase 1.

### What it does not change

- First responder promotion is untouched.
- No new attributes on the DOM.
- No new dispatch paths.
- Components that don't care about key state see no change.

---

## Phase 2 — Stored key card and main card (only if a concrete case demands it)

If and when the inspector or a sheet-restoration flow makes the derived-value model insufficient, promote both **key card** and **main card** to stored state on the manager. **Do not build this preemptively.** The trigger should be a real feature that the derived selector cannot serve.

### The key/main split

We mirror AppKit's distinction between key window and main window:

- **Key card** is where input (keyboard shortcuts, inspector edits, focused interaction) is currently directed. It can shift transiently as floating surfaces open and close.
- **Main card** is the card the user is fundamentally working on. It retains its active chrome even when a sheet, inspector panel, or other floating surface is currently key. When the floating surface dismisses, key snaps back to main.

In the simple case — a single card with focus inside it and no floating surfaces — key and main are the same card. The split only becomes visible when a transient surface takes key without displacing the user's attention from the underlying subject.

### Changes (sketch — defer detailed design until triggered)

1. **`manager.keyCardId: string | null`** and **`manager.mainCardId: string | null`** as stored state, set independently of `firstResponderId`.

2. **Promotion rules, narrow by construction.** Only responders registered with `kind: "card"` are eligible for either role. Promotion happens via:
   - Pointerdown/focusin promotion of first responder into a card subtree → the ancestor card becomes both key and main.
   - A floating surface (sheet, inspector) opens and claims input → it becomes key; main stays where it was.
   - The floating surface dismisses → key reverts to main.
   - `sendToTarget(cardId, …)` from outside the card's subtree → does NOT promote either by default. Promotion is a deliberate act, not a dispatch side effect.
   - Explicit `manager.makeKeyCard(cardId)` and `manager.makeMainCard(cardId)` for sheet-restoration and similar flows. Used sparingly, like `makeFirstResponder` today.

3. **`data-key-card="<id>"`** and **`data-main-card="<id>"`** debug attributes on the respective cards' root elements, mirroring `data-first-responder`. When key and main are the same card, both attributes appear on the same element.

4. **Console logging** of key and main card transitions, gated behind the same `[responder-chain]` filter prefix.

5. **The derived `getKeyCard()` from phase 1 returns the stored key value when present**, falling back to the ancestor walk when the stored value is null. A new `getMainCard()` returns the stored main value (or null). Consumers built against phase 1 keep working without changes.

### Risks to watch

- Three state machines drifting (first responder, key card, main card). Mitigation: each stored value always reflects a real registered node; when a node unregisters, the affected role falls back to derived or null.
- Promotion-rule sprawl. Mitigation: the rules above are the entire surface; new rules require the same scrutiny as `makeFirstResponder` calls.
- Key/main confusion in card chrome. Mitigation: cards render their active chrome based on `mainCardId` (the durable subject), not `keyCardId` (the transient input target). A card that is key but not main — i.e., a sheet briefly stealing input — should not steal chrome from the underlying main card.
- Inspector ergonomics. The inspector should not silently shift the key card on every interaction. Promote on inspector open, not on every dispatch.

---

## Anti-patterns (preemptive)

- **A general `keyResponderId` settable on any node.** This is a second first-responder mechanism. Resist.
- **Promoting key card on every `sendToTarget` automatically.** Makes key card a side effect of dispatch, which surprises both the inspector and the card. Promotion should be a deliberate act.
- **Reading key card in handler bodies via closure.** Same [L07] rule as first responder — refs only.

---

## Cross-references

**Documents:**
- [responder-chain.md](../tuglaws/responder-chain.md) — the responder chain mechanics this layers on
- [tuglaws.md](../tuglaws/tuglaws.md) — [L11] (controls emit, responders own state), [L07] (refs not closures)

**External precedent:**
- [Apple — Using responders and the responder chain](https://developer.apple.com/documentation/uikit/using-responders-and-the-responder-chain-to-handle-events)
- [Apple — NSResponder](https://developer.apple.com/documentation/appkit/nsresponder)

**Source files (phase 1 touchpoints):**
- `tugdeck/src/components/tugways/responder-chain.ts` — add `getKeyResponderOfKind`, `observeKeyResponder`, kind index
- `tugdeck/src/components/tugways/use-responder.tsx` — accept `kind` option, pass through to registration
- `tugdeck/src/components/tugways/use-key-card.tsx` (new) — `useIsKeyCard`, `useKeyCardId` hooks
- `tugdeck/src/components/tug-card/tug-card.tsx` — pass `kind: "card"`, consume `useIsKeyCard` for chrome
