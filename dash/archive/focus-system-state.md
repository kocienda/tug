# State of the Focus System

> **SUPERSEDED.** This audit describes the focus system as it stood before the by-construction redesign. The redesign it motivated is specified in [focus-by-construction.md](focus-by-construction.md) and shipped on the `focus-by-construction` dash: one `place()` primitive, a DOM-focus-derived ring projection, key-card-gated claims, a declarative late-mount realization, and a permanent runtime tripwire. The hand-reconciliation machinery mapped below (`seedKeyViewFromChain`, `suppressChainSeed`, `pointerPromotionActive`, `armKeyboardRestore`/`pendingKeyboardRestore`) no longer exists; `reconcileFirstResponder` survives as `settleFirstResponderForActivation`, the first-responder axis of the one activation pass. The durable contract now lives in `tuglaws/focus-language.md` § One writer. This document is kept as the historical map of the problem.

*A current-state audit of every "who is active" register in tugdeck, how each is stored, projected, written, and read, and — the point of the document — every place two of them must be reconciled **by hand**. The recurring class of bug (the Lens ring paints but the keyboard is dead; an accelerator drops on a just-activated card; a dialog silently loses its ring) is always the same shape: two independent registers drifted out of sync because a code path updated one and not the other. This is the map we redesign against.*

*Grounded in: `focus-manager.ts`, `focus-transfer.ts`, `responder-chain-provider.tsx`, `use-focusable.tsx`, `use-responder.tsx`, `deck-manager.ts`, `tug-list-view.tsx`. Intended design lives in `tuglaws/focus-language.md`, `tuglaws/responder-chain.md`, `tuglaws/pane-model.md` — this doc is the *implementation reality* and where it diverges.*

---

## The one-sentence problem

There is no single source of truth for "where is the keyboard." There are **seven** registers that each answer a slice of that question, stored in three different systems (the FocusManager, the ResponderChain, and the browser's DOM), and they are kept consistent by **explicit reconciliation calls at activation/mount/restore time**. Every reconciliation call is a hand-written sync point. Every sync point is a place one register can be updated while another is not. When that happens the user sees a *lie*: a focus ring (a promise that keystrokes land here) with nothing behind it.

The redesign goal is to make "where is the keyboard" a **single value that projects to all its representations by construction**, so no code path can update one representation without the others.

---

## The seven registers

Each is a distinct piece of state with its own storage, its own DOM projection (or none), its own writers, and its own readers.

### 1. Chain first responder — *who gets dispatched actions*

- **Stores:** `ResponderChainManager.firstResponderId: string | null` (one global register).
- **DOM projection:** `data-first-responder="<id>"` on exactly one element; `data-responder-id="<id>"` on every registered responder.
- **Written by:** capture-phase `pointerdown` and `focusin` DOM-walks (`findResponderForTarget`), root auto-promotion, `makeFirstResponder`, `focusResponder`, and `FocusManager.reconcileFirstResponder` at activation.
- **Read by:** `sendToFirstResponder` (Cmd-W, cut/copy/paste, select-all, undo/redo, find, …) — the action-routing walk.
- **Purpose:** "the innermost thing the user is working with," for accelerator routing.

### 2. DOM active element — *where keystrokes and the caret actually go*

- **Stores:** the browser's `document.activeElement`.
- **DOM projection:** *is* the DOM; `:focus`.
- **Written by:** native focus (click/Tab), `el.focus()`, substrate `view.focus()` (CM6), `focusResponder`'s DOM-walk fallback / substrate `focus` callback.
- **Read by:** the browser (keydown target), CM6 (caret), the list arrow listener's own capture keydown.
- **Purpose:** the real keyboard sink. **This is the only register the OS/browser actually honors.**

### 3. Visual key view — *where the ring is painted*

- **Stores:** `FocusManager` (per-card context) `keyViewId: string | null` + `keyViewKeyboard: boolean`.
- **DOM projection:** `data-key-view` / `data-key-view-kbd` on the key-view element; `data-key-within` on containers; `data-default-ring` on the scope's Return-home button. Painted by `syncKeyViewDomAttribute`, **gated on `isActive()`** (only the key card's context projects).
- **Written by:** `setKeyView`, `refreshKeyViewProjection`, `armKeyboardRestore`, the Tab walk, item-group seed effects.
- **Read by:** CSS only ([L06]) — the ring/tint. Also read by component logic that gates on `data-key-view-kbd` (e.g. the list arrow listener only moves the cursor while the container holds it).
- **Purpose:** the *visual* answer to "where am I." A **promise** that keystrokes land here — but it does not itself route keystrokes; registers #1 and #2 do.

### 4. Key card — *which per-card focus context is live*

- **Stores:** `FocusManager.keyCardId: string | null`; per-card `FocusContext` objects keyed by card id.
- **DOM projection:** indirect — only the active context's `projectAll()` writes #3/#5/#7 to the DOM; all other contexts are dark.
- **Written by:** `setKeyCard` (the "universal activation signal": click, tab switch, pane frontmost change, cross-pane move, pane cycle, cold boot).
- **Read by:** `isActive()`, which gates every projection and the Escape ladder.
- **Purpose:** windowing — each card has its own key view / cursor / scope stack / first responder, like windows; only the frontmost is live.

### 5. Per-card scope / focus-mode stack — *descend/ascend within a card*

- **Stores:** per-card `FocusContext` mode stack; `FocusModeContext` React context threading the current mode id.
- **DOM projection:** `data-focus-mode` / mode attributes; the Tab walk is contained to the top mode (`walkModeSet`).
- **Written by:** `pushFocusMode` / `ascend` (Enter descends into a row scope / dialog trap; Escape ascends).
- **Read by:** the Tab walk (containment), the list Left/Right descend/ascend, dialog traps.
- **Purpose:** nested navigation (a list row's inner focusables, a modal trap) without losing the restore target above.

### 6. Item-group cursor — *the roving position inside one focused list/group*

- **Stores:** `TugListView` `cursorIndexRef` (a ref, not React state — moving it must not re-render, [L06]).
- **DOM projection:** `data-key-cursor` on the cursor cell.
- **Written by:** the arrow-key capture listener, the key-view-gain seed effect, `moveCursorTo`.
- **Read by:** CSS (the cursor bar), the section verbs (create-below / delete act on the cursor row).
- **Purpose:** the spatial-plane position within an item-group. **Sub-axis of #3** — only meaningful while the container holds the key view.

### 7. Persisted focus bag — *the saved destination restored on activation/boot*

- **Stores:** per-card `bag.focus` (persisted via tugbank); resolved by `resolveBagFocus` / applied by `applyBagFocus`.
- **DOM projection:** none directly — it is the *input* that drives #1–#3 on restore.
- **Written by:** the save side of `transferFocusForActivation` (captures the outgoing card's focus on deactivation).
- **Read by:** `applyBagFocus` (on activation and cold-boot restore), `armKeyboardRestore` (late-mount).
- **Purpose:** restore "where the keyboard was in this card" across activation, tab switch, and relaunch.

---

## The reconciliation points (where sync is done by hand)

None of the seven update each other automatically. Consistency is produced by these explicit calls — each is a hand-written "now also update the other registers" step:

| Sync point | File / symbol | Reconciles | Trigger |
|---|---|---|---|
| **Activation reconcile** | `FocusManager.setKeyCard` → `reconcileFirstResponder` + `adoptKeyCard` | #4 key card → #1 chain FR + #3 key view + #2 DOM focus | any activation |
| **Bag restore** | `focus-transfer.ts` `applyBagFocus` / `resolveBagFocus` | #7 bag → #1/#2/#3 | activation, cold boot, `CardHost` retry |
| **Late-mount ring resume** | `FocusManager.armKeyboardRestore` + `registerFocusable` pending-completion | #7/#3 → #3 + #2 once the element mounts | async content (snippet hydration) |
| **Chain→DOM focus** | `ResponderChainManager.focusResponder` | #1 → #2 (via substrate `focus` callback or DOM-walk) | popup close, chain-driven focus |
| **em-card engine hook** | `store.registerEngineHooks` → `paintMirrorAsActive` → `view.focus()` → `focusin` → #1 | content-half of activation: #2 → #1 | editor mount/bind |
| **Pointer/focus promotion** | capture-phase `pointerdown`/`focusin` in `ResponderChainProvider` | #2 → #1 | user click / native focus |
| **Item-group seed** | `TugListView` key-view-gain effect | #3 → #6 cursor | container gains the ring |

Every row is a place the code must remember to touch more than one register. The [D-notes] in the laws (`focus-language.md` "the first responder must NOT be left to ride DOM focusin"; "a raw 'focus the editor' claim is a bug even when it looks harmless") are all warnings about *specific missed reconciliations* — patched one at a time.

---

## The failure modes (registers drifted apart)

Each observed bug is a specific pair of registers out of sync:

- **The ring lies / keyboard dead (#57).** #3 (visual key view / ring) is on the Lens snippets list, but #2 (DOM focus) is in the Session card's prompt editor (`activeElement === cm-content`). Reproduced this session: with a focus-claiming card present, on restore the Lens paints the ring (#3) while the prompt card's mount steals DOM focus (#2). Keystrokes go to the prompt; the ring is a promise with nothing behind it. The `claimKeyboardFocusIfAdrift` band-aid (now removed) was an attempt to hand-reconcile #3→#2 at `setKeyCard` time; it only covered the "activeElement is nothing" case, not "activeElement is a *different real element*."
- **Accelerator dropped on a just-activated card.** #4 (key card) moved but #1 (chain FR) wasn't reconciled — Cmd-W / cancel-dialog walk a chain that doesn't serve the active card. This is exactly what `reconcileFirstResponder` exists to prevent; it is a reconciliation that was *added* because the axes are separate.
- **Dialog silently loses its ring.** A lifecycle "focus the resting editor" claim fired under a modal scrim: #2 stayed on the dialog (entry stood down) but the responder promotion re-seeded #3 onto the editor. `focus-language.md` calls this out as "symptomless in the DOM, dead to the keyboard."
- **Split on cold boot.** #7 (bag) restore races async content: `armKeyboardRestore` pends until the element mounts, and whichever of the competing restores (Session card engine hook vs. Lens bag) wins #2 vs. #3 is timing-dependent.

The common denominator: **#3 (the ring, what the user sees) and #2 (DOM focus, where keys go) are updated by different code on different schedules, and nothing structurally forces them to agree.** #1 (chain FR) is a third wheel that must also be dragged along.

---

## Why it's structurally fragile

1. **Three storage systems, no owner.** #1 lives in the ResponderChain, #2 in the browser, #3–#6 in the FocusManager, #7 in tugbank. No single object holds "the keyboard is here"; it is spread across three subsystems that observe each other imperfectly.
2. **The ring is not derived from DOM focus.** #3 is set independently of #2. Nothing says "the ring may only paint where DOM focus is (or its declared descendant)." So a painted ring can point at an element that isn't focused — the definition of the lie.
3. **Reconciliation is imperative and scattered.** Seven+ sync points, each hand-maintained, each a missable step. New activation routes (a new card kind, a new restore path) must re-implement the reconciliation or inherit a divergence.
4. **Async widens every gap.** `armKeyboardRestore` / the engine-hook retry exist because content mounts *after* the focus decision. During that window the registers are provisional and the "winner" is a race.

---

## The by-construction target

The redesign should collapse the answer to "where is the keyboard" to **one authoritative value** from which every representation is *derived*, not separately maintained:

- **One focus target per active card**, expressed as a stable, serializable descriptor (a responder id + optional in-responder path — the union of today's #1/#3/#6/#7). DOM focus (#2), the ring (#3), the chain FR (#1), and the cursor (#6) are all **projections** of that one value, recomputed whenever it changes — never written independently.
- **The ring is defined as "the projection of the focus target," and DOM focus is defined as "the projection of the focus target."** They cannot disagree because they read the same source. A ring with no DOM focus behind it becomes unrepresentable.
- **Activation = swap the active card's focus target in, project once.** No `reconcileFirstResponder` + `adoptKeyCard` + `applyBagFocus` + `claimKeyboardFocusIfAdrift` sequence — one projection pass.
- **Async content = the target is declarative; projection retries idempotently until the element exists.** `armKeyboardRestore`'s pending set becomes "the target names an element not yet mounted; project when it mounts" — one rule, not a special case per call site.
- **The bag (#7) is just the serialized focus target**, so restore is "set the target, project," identical to activation.

The test of the redesign: it must be **impossible to paint a ring without DOM focus landing on the same element (or a declared descendant)**, because both are the same projection of the same value. Every failure mode above is then unrepresentable rather than guarded.

---

## Open questions for the redesign

- Can the ResponderChain's first responder (#1) *be* the focus target's responder id, eliminating #1 as a separate register — or does action-routing genuinely need a different granularity than the focus point?
- Item-group cursor (#6): is it part of the focus target descriptor (`responderId + cursorIndex`) or a separate concern the responder owns internally?
- The per-card windowing (#4/#5): keep the per-card context objects, but make each hold *one* focus target instead of separate key-view/cursor/FR fields?
- Migration: the seven registers are load-bearing across ~dozen app-tests (at0148/at0201/at0203 pin activation focus; at0240–at0243 pin Lens focus). The redesign must keep those green while unifying underneath.
