<!-- tugplan-skeleton v2 -->

## Lifecycle Delegates — App and Card {#lifecycle-delegates}

**Purpose:** Replace the current ad-hoc `CardLifecycle` four-event pipe (construction / activation / deactivation / destruction) with a proper Apple-style delegate protocol that covers both the card lifecycle *and* the app lifecycle. Rename the card events to the macOS `will`/`did` convention, expand to include will-variants for activate/deactivate, and add eight new app-level events driven from `NSApplicationDelegate`. Route app events through the existing control-frame plumbing (no new `window.__*` globals). Collapse the four `useOnCard*` hooks into one `useCardDelegate(cardId, delegate)` hook that accepts a protocol-shaped object. Expose app events through a parallel `useAppDelegate(delegate)` hook. Wire the tide card's prompt-editor focus behavior as the canonical test effect. Cascade app background/hide into card deactivation and app foreground/unhide into card reactivation, idempotently. Add structured `[CardLifecycle]` / `[AppLifecycle]` logging throughout. Treat the reliability of delegate-method delivery (currently a setState+useEffect deferral that escapes WebKit's gesture focus-lock) as a *separate design study* that follows the API rename and lands its own mechanism — retiring `lib/defer.ts` once a principled answer exists.

The work is staged rename-first, then API-shape, then app-lifecycle wiring, then cascade, then the reliability study. Every commit keeps the build green.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | complete |
| Target branch | main |
| Last updated | 2026-04-20 |
| Predecessor | [tugplan-tide-card-polish.md §Step 5.5](./tugplan-tide-card-polish.md) (unified card-activation lifecycle) |
| Related | `tugdeck/src/lib/card-lifecycle.ts`, `tugapp/Sources/AppDelegate.swift`, `tugdeck/src/main.tsx`, `tugdeck/src/components/tugways/selection-guard.ts` |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The [T3.4.d tide-card-polish Step 5.5](./tugplan-tide-card-polish.md) work landed a unified `CardLifecycle` in `tugdeck/src/lib/card-lifecycle.ts` with four events: **Construction**, **Activation**, **Deactivation**, **Destruction**. Subscribers register via `observeCard{Construction,Activation,Deactivation,Destruction}`; React components use four parallel hooks (`useOnCardConstruction`, `useOnCardActivation`, `useOnCardDeactivation`, `useOnCardDestruction`). Notifications fire synchronously at the lifecycle layer; the React hooks defer the user callback via a `setState → useEffect` pipeline so focus-side-effects run post-paint, outside WebKit's pointer-gesture focus-lock.

Parallel to that, the app side of lifecycle exists in `tugapp/Sources/AppDelegate.swift` only for **two** events — `applicationDidResignActive` (lines 181–184) and `applicationDidBecomeActive` (lines 186–189) — each doing exactly one thing: calling a `window.__tugdeckAppDeactivated()` / `__tugdeckAppActivated()` global function defined in `tugdeck/src/main.tsx:172–184`. Those globals directly call `selectionGuard.(de)activateApp()` and, on deactivate, `deck.saveAndFlush()`. There is no general app-delegate surface on the tugdeck side; there are no `will` variants; there is no `applicationDid{Hide,Unhide}` coverage; and card-lifecycle and app-lifecycle are entirely disjoint — app backgrounding does *not* fire `cardDidDeactivate` on the active card, and app foregrounding does *not* re-fire `cardDidActivate`.

Three specific problems motivate this plan:

1. **Naming.** The current method names (`observeCardActivation`, `useOnCardActivation`) read as event stream names, not as delegate-protocol members. Decades of Apple-platform experience say the `will`/`did` pair is the right vocabulary for lifecycle transitions: it makes the *timing* (before vs. after the state change) and the *intent* (prepare vs. react) unambiguous.
2. **Shape.** Registering four hooks per card body to express "I am a delegate of this card's lifecycle" obscures the pattern. A single `useCardDelegate(cardId, delegate)` hook accepting an object with optional methods matches `NSWindowDelegate` / `UIApplicationDelegate` / `UITableViewDelegate` and scales as we add methods (e.g., `cardWillResize`, `cardDidResize` later).
3. **Reliability.** The currently-shipped `setState → useEffect` deferral is a Rube Goldberg machine: it works today because `useEffect` happens to run post-paint outside the gesture, but the mechanism leaks implementation details of React's commit scheduling into a piece of the system that should be bedrock-stable. The user is *greatly dissatisfied* with this. The `lib/defer.ts` helper (`deferToNextMacrotask` via `setTimeout(fn, 0)`) is dead code carrying a tuglaws-non-compliant shape; it must be retired, but only once a principled replacement lands.

Three additional needs fold in:

4. **App lifecycle coverage.** macOS emits eight lifecycle notifications any serious app attends to: `applicationWillBecomeActive` / `applicationDidBecomeActive` / `applicationWillResignActive` / `applicationDidResignActive` / `applicationWillHide` / `applicationDidHide` / `applicationWillUnhide` / `applicationDidUnhide`. Tugdeck needs all eight as first-class delegate methods so downstream surfaces can respond — most immediately, the active card must deactivate on background/hide and reactivate on foreground/unhide, idempotently.
5. **App → card cascade.** When the app resigns active or hides, the active card (if any) should fire `cardWillDeactivate` → `cardDidDeactivate` so its prompt-entry loses focus (and any visible caret blink stops). On `applicationDidBecomeActive` or `applicationDidUnhide`, the previously-active card should re-fire activation so the prompt-entry regains focus. Deactivation is idempotent: it's safe to fire on both `willResignActive` and `willHide` back-to-back without double-side-effects.
6. **Wire format hygiene.** `window.__tugdeckAppActivated` and friends are the last double-underscore global JS functions the Swift side calls. We can fold the eight app-lifecycle events into the existing control-frame plumbing (`processManager.sendControl(action, params)` on the Swift side; `action-dispatch.ts` on the JS side) with a single `app-lifecycle` action and an `event` param. That leaves only the two synchronous Swift-initiated calls (`__tugdeckSaveState`, `__tugdeckReconnect`) as `evaluateJavaScript` entry points, and those should be renamed onto a single `window.tugdeck` namespace object — no double-underscores anywhere.

This plan unifies (1) through (6) into a coherent delegate surface.

#### Strategy {#strategy}

- **Rename first, then reshape.** Step 1 is a pure rename of the existing `CardLifecycle` method and hook names to `will`/`did` form (keeping the four-hook shape). That commit has no behavioral change and can be cherry-picked cleanly. Step 2 then collapses the hooks into one `useCardDelegate`.
- **Expand the card protocol before the app protocol.** Add `cardWillActivate` / `cardWillDeactivate` to the card lifecycle (Step 3) before wiring anything on the app side. That exercises the will/did pattern inside existing code paths first.
- **App lifecycle lands after card lifecycle stabilizes.** Step 4 introduces the `AppLifecycle` class and `useAppDelegate` hook with no wiring to Swift yet — purely the shape. Step 5 replaces the two existing window globals with control-frame dispatch. Step 6 adds the six new NSApplicationDelegate methods on the Swift side (will/did hide + unhide, plus will variants for active/resign). Step 7 cascades app → card.
- **Test effect is the tide card's prompt editor.** Every step that changes lifecycle delivery must be verified by the tide card behavior: opening a card focuses the prompt; switching cards deactivates the leaving card and activates the entering card's prompt; backgrounding the app removes focus; foregrounding restores it; Cmd-H hides and removes focus; app unhide restores it.
- **Reliability is its own step.** Step 10 is a *design study*, not a code step — research on the web (WebKit focus-lock semantics, React scheduler guarantees, MessageChannel microtask ordering, scheduler.yield, modern event-loop primitives), a written analysis in-tree, and a concrete proposal. Step 11 implements the chosen mechanism and retires `lib/defer.ts`.
- **Logging throughout.** Every delegate-method delivery prints a structured line: `[CardLifecycle] cardDidActivate id=abc123` / `[AppLifecycle] applicationWillResignActive`. Cascade events log at both layers (app event first, then the card event triggered by the cascade). This is cheap, greppable, and can be deleted wholesale with one regex once the system is trusted.
- **Idempotent deactivation.** Because both `applicationWillResignActive` and `applicationWillHide` can fire in sequence (app loses focus, then is hidden via Cmd-H), `cardWillDeactivate`/`cardDidDeactivate` must be safe to call twice in a row with no double-side-effect. The cascade layer tracks a "currently deactivated by app" flag; the second fire is a no-op.
- **Tuglaws apply at every step.** Subscriptions install in `useLayoutEffect` (L03). The delegate dispatcher owns direct DOM observation, not React state (L22). Appearance of focus rings / caret blink is CSS-driven (L06). Hooks read current callback via refs (L07).
- **One commit per step.** `bun run check`, `bun test`, `bun run audit:tokens lint`, and `cargo nextest run` pass at every commit. `-D warnings` enforced.

#### Success Criteria (Measurable) {#success-criteria}

**API shape:**
- `CardLifecycle` exposes `notifyCardWillActivate`, `notifyCardDidActivate`, `notifyCardWillDeactivate`, `notifyCardDidDeactivate`, `notifyCardDidFinishConstruction`, `notifyCardWillBeginDestruction`. Matching `observeCard*` methods exist. (verification: `rg "notifyCard(Did|Will)" tugdeck/src/lib/card-lifecycle.ts` lists all six; no `notifyActivation` / `notifyDeactivation` / `notifyConstruction` / `notifyDestruction` remain.)
- `AppLifecycle` exposes eight `notifyApplication*` methods and eight matching `observe*` methods. (verification: `rg "notifyApplication" tugdeck/src/lib/app-lifecycle.ts` lists eight.)
- React integration exposes exactly two delegate hooks: `useCardDelegate(cardId, delegate)` and `useAppDelegate(delegate)`. (verification: `rg "export function useOn(Card|App)" tugdeck/src/lib` returns zero matches; the four `useOnCard*` hooks are gone.)

**Naming:**
- No `window.__tugdeckAppActivated` / `__tugdeckAppDeactivated`. (verification: `rg "__tugdeckApp" tugdeck/src tugapp/Sources` returns zero matches.)
- `window.__tugdeckSaveState` and `window.__tugdeckReconnect` are renamed to `window.tugdeck.saveState` and `window.tugdeck.reconnect`. (verification: `rg "__tugdeck" tugdeck/src tugapp/Sources` returns zero matches.)
- `lib/defer.ts` is deleted. (verification: the file does not exist; `rg "deferToNextMacrotask" tugdeck/src` returns zero matches.)

**Behavior — card transitions:**
- Clicking a card's title bar fires, in order: `cardAWillDeactivate` → `cardBWillActivate` → (store + responder updates) → `cardADidDeactivate` → `cardBDidActivate`. (verification: test in `card-lifecycle.test.tsx` that records a call log and asserts the exact sequence.)
- `cardDidFinishConstruction` fires exactly once per card, after the card is present in the deck store. (verification: existing test, renamed.)
- `cardWillBeginDestruction` fires exactly once per card, while the card is still present in the deck store. (verification: existing test, renamed.)

**Behavior — app transitions:**
- Each of the eight `NSApplicationDelegate` notifications produces the corresponding `[AppLifecycle]` log line. (verification: manual with Tug.app running — trigger Cmd-Tab, Cmd-H, unhide; read console.)
- `applicationWillResignActive` → cascades to `cardWillDeactivate` / `cardDidDeactivate` on the active card, if any. (verification: test against a mock NSApp notification path; manual with tide card.)
- `applicationDidBecomeActive` → cascades to `cardWillActivate` / `cardDidActivate` on the last-active card, if any. (verification: as above.)
- `applicationWillHide` — same deactivation cascade; idempotent with a preceding `applicationWillResignActive`. (verification: a test that fires both in sequence and asserts `cardWillDeactivate` / `cardDidDeactivate` run exactly once.)
- `applicationDidUnhide` — same reactivation cascade. (verification: test.)

**Test effect — tide card prompt focus:**
- Opening a tide card focuses the prompt editor (`cardDidFinishConstruction` → focus). (manual.)
- Clicking another card's title bar blurs the prompt editor of the leaving card and focuses the prompt editor of the entering card. (manual + test.)
- Ctrl-` cycling produces the same focus movement deterministically across 50 cycles. (manual.)
- Cmd-Tabbing away from Tug.app removes the caret blink on the prompt editor; Cmd-Tabbing back restores it without clicking. (manual.)
- Cmd-H hiding Tug.app and unhiding produces the same removal/restoration as Cmd-Tab. (manual.)
- The **random intermittent focus failure** the user reported on card creation does not recur across 50 consecutive new-card opens. (manual stress test.)

**Logging:**
- Every lifecycle-method delivery prints a single structured line prefixed `[CardLifecycle]` or `[AppLifecycle]`, with the method name and card id where applicable. (verification: manual grep of console during a scripted tide-card session.)

**Compliance:**
- `bun run check`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run` all green at every step.
- Tuglaws walkthrough (Step 12) records L02 / L03 / L06 / L07 / L22 conformance.

#### Scope {#scope}

**In scope:**
- Rename of `CardLifecycle` internal methods, observe APIs, and React hooks to `will`/`did` form.
- Collapse of the four `useOnCard*` hooks into `useCardDelegate`.
- Addition of `cardWillActivate` / `cardWillDeactivate` (construction and destruction keep single-phase names per the user's spec).
- New `AppLifecycle` class paralleling `CardLifecycle` with eight events.
- New `useAppDelegate(delegate)` hook.
- Swift `AppDelegate`: wire all eight `NSApplicationDelegate` methods (two exist, six are new).
- Bridge migration: replace `window.__tugdeckApp*` with a single `app-lifecycle` control frame and an action-dispatch handler.
- Rename `window.__tugdeckSaveState` / `__tugdeckReconnect` to `window.tugdeck.saveState` / `reconnect`.
- App → card cascade: resignActive/hide → deactivate; becomeActive/unhide → reactivate. Idempotent.
- Structured `[CardLifecycle]` / `[AppLifecycle]` console logging at every delivery.
- Tide-card integration: migrate `TideCardBody` from the two separate hooks to a single `useCardDelegate` call with `cardDidFinishConstruction` / `cardDidActivate` / `cardWillDeactivate` (to blur the prompt explicitly) implemented.
- Reliability design study (written analysis).
- Reliability mechanism implementation + deletion of `lib/defer.ts`.
- Tuglaws walkthrough.

**Out of scope (deferred):**
- Changing the `NSWindowDelegate` surface (window becomeKey / resignKey / miniaturize / deminiaturize). These are useful but orthogonal; they can land in a follow-up that uses the same delegate-object shape.
- ~~Card *resize* and *move* delegate methods.~~ **Pulled in as [Step 11.5](#step-11-5)** once the delegate model had proven out. `cardWillMove` / `cardDidMove` / `cardWillResize` / `cardDidResize` now ship as part of this plan.
- Routing keyboard events through delegate methods. Keybinding stays in the responder chain.
- Removing the synchronous `saveState` / `reconnect` paths themselves. Only their *names* change.
- Multi-window support. Current app has a single `MainWindow`; delegate methods are singular.

#### Resolved Decisions {#resolved-decisions}

- **D1 — Delegate-object form.** `useCardDelegate(cardId, delegate)` with an optional-methods protocol object. Rationale: decades of Apple-platform experience say this scales for sophisticated app development in ways per-event hooks do not. Confirmed by the user in plan-authoring conversation (2026-04-20).
- **D2 — Will/did coverage.** Construction gets one event (`cardDidFinishConstruction`). Destruction gets one event (`cardWillBeginDestruction`). Activation and deactivation get will/did pairs. Rationale: birth/death transitions don't usefully split into "will" and "did" in this system — the store is the single source of truth and the transition to/from existence is atomic. Activate/deactivate benefit from the split because delegates may want to prepare state (will) separately from reacting to the fact (did).
- **D3 — Ordering on card switch.** `cardAWillDeactivate → cardBWillActivate → (state transitions) → cardADidDeactivate → cardBDidActivate`. Rationale: fires all preparation callbacks before *any* state change, then the state change atomically, then all reaction callbacks. Confirmed by the user.
- **D4 — App → card cascade.** `applicationWillResignActive` and `applicationWillHide` each trigger `cardWillDeactivate`/`cardDidDeactivate` on the active card. `applicationDidBecomeActive` and `applicationDidUnhide` each trigger `cardWillActivate`/`cardDidActivate` on the last-active card. The cascade is idempotent — a second trigger (e.g., hide after resign) is a no-op because the active card is already in the deactivated-by-app state. Confirmed by the user.
- **D5 — Wire format.** App lifecycle events ride on the existing control-frame plumbing as `app-lifecycle` with an `event` param. Rationale: no new double-underscore globals, unified logging, reconnect-robust, single handler in `action-dispatch.ts`. `saveState` / `reconnect` stay as `evaluateJavaScript` entry points (they are Swift-initiated synchronous round-trips where the control-frame path is wrong), but rename under a `window.tugdeck` namespace. Proposed by Claude in plan-authoring; the user requested a proposal to evaluate.
- **D6 — Logging format.** `console.log("[CardLifecycle] cardDidActivate id=" + cardId)` / `console.log("[AppLifecycle] applicationWillResignActive")`. No ring buffer, no structured logger, no Swift coupling. Plain console prefix so it's greppable and cheap to delete in bulk. Confirmed by the user.
- **D7 — Reliability mechanism: study first, implement later.** The current `setState → useEffect` deferral pattern is accepted as a *holding* mechanism for Steps 1–9 but is not the final answer. Step 10 researches and proposes a replacement; Step 11 implements it and deletes `lib/defer.ts`. The user is "greatly dissatisfied" with the current options and wants "big-time research on the web to find the best means to achieve the reliability I'm looking for." Confirmed by the user.
- **D8 — Cascade lives in `lib/lifecycle-cascade.ts`.** Rather than nesting cascade logic inside `DeckManager`, a tiny dedicated module imports both `CardLifecycle` and `AppLifecycle` and wires observer callbacks between them. The module is constructed and installed from `DeckManager` once both lifecycles exist. Rationale: one true place to read the cascade rules, no circular-import risk because the cascade module imports both (not the reverse), and room for the logic to grow without reshuffling `DeckManager`. Confirmed by the user.
- **D9 — `selectionGuard` migrates to the delegate protocol; the `deactivateApp` / `activateApp` imperative entry points are retired.** Rationale: the delegate is the one true path for these lifecycle events. No alternative invocation routes. Confirmed by the user.
- **D10 — Trust AppKit's will/did pairing.** `applicationWillResignActive` is always followed by `applicationDidResignActive`; `applicationWillHide` is always followed by `applicationDidHide`; etc. No cancel path, no undo logic in the cascade. Confirmed by the user.

---

### Steps {#steps}

Each step is its own commit. `bun run check`, `bun test`, `bun run audit:tokens lint`, and `cargo nextest run` pass at the end of every step. Step 10 is the deliberate exception — it is a design-study commit that produces an in-tree document, no runtime code changes.

#### Step 1 — Rename `CardLifecycle` methods and hooks to will/did form {#step-1}

**Files:**
- `tugdeck/src/lib/card-lifecycle.ts`
- `tugdeck/src/deck-manager.ts`
- `tugdeck/src/deck-manager-store.ts`
- `tugdeck/src/components/tugways/cards/tide-card.tsx`
- `tugdeck/src/components/tugways/selection-guard.ts`
- `tugdeck/src/components/tugways/responder-chain-provider.tsx`
- `tugdeck/src/components/chrome/deck-canvas.tsx`
- `tugdeck/src/__tests__/card-lifecycle.test.tsx`
- `tugdeck/src/__tests__/mock-deck-manager-store.ts`
- Any other test referring to the old names.

**Work:**
- Rename the `CardLifecycle` class's internal `notify*` methods and public `observeCard*` methods:
  - `notifyConstruction` → `notifyCardDidFinishConstruction`
  - `notifyDestruction` → `notifyCardWillBeginDestruction`
  - `notifyDeactivation` → `notifyCardDidDeactivate`
  - `notifyActivation` → `notifyCardDidActivate`
  - `observeCardConstruction` → `observeCardDidFinishConstruction`
  - `observeCardActivation` → `observeCardDidActivate`
  - `observeCardDeactivation` → `observeCardDidDeactivate`
  - `observeCardDestruction` → `observeCardWillBeginDestruction`
- Rename the four React hooks:
  - `useOnCardConstruction` → `useOnCardDidFinishConstruction`
  - `useOnCardActivation` → `useOnCardDidActivate`
  - `useOnCardDeactivation` → `useOnCardDidDeactivate`
  - `useOnCardDestruction` → `useOnCardWillBeginDestruction`
- Update `DeckManager` pass-throughs and `IDeckManagerStore` interface method names to match.
- Update every call site in production code and tests.
- No behavior changes. No new events. The will/did variants for activate/deactivate come in Step 3.

**Verification:**
- `bun x tsc --noEmit` clean.
- `bun test` green — test names may change but assertions stay equivalent.
- `rg "observeCardActivation|observeCardDeactivation|observeCardConstruction|observeCardDestruction" tugdeck/src` returns zero matches.
- `rg "useOnCardActivation|useOnCardDeactivation|useOnCardConstruction|useOnCardDestruction" tugdeck/src` returns zero matches.
- Manual: tide card still focuses prompt on open; still activates on click; still deactivates on close.

#### Step 2 — Collapse four hooks into one `useCardDelegate` {#step-2}

**Files:**
- `tugdeck/src/lib/card-lifecycle.ts`
- `tugdeck/src/components/tugways/cards/tide-card.tsx`
- Every other card body using a lifecycle hook (currently only tide card, per `rg "useOnCard" tugdeck/src/components`).
- `tugdeck/src/__tests__/card-lifecycle.test.tsx`

**Work:**
- Define and export:
  ```ts
  export interface TugCardDelegate {
    cardDidFinishConstruction?(cardId: string): void;
    cardWillActivate?(cardId: string): void;       // added in Step 3
    cardDidActivate?(cardId: string): void;
    cardWillDeactivate?(cardId: string): void;     // added in Step 3
    cardDidDeactivate?(cardId: string): void;
    cardWillBeginDestruction?(cardId: string): void;
  }
  ```
  The two `will` variants land as fields on the interface now but are not wired to any notify source yet — Step 3 wires them.
- Export a single hook:
  ```ts
  export function useCardDelegate(cardId: string, delegate: TugCardDelegate): void;
  ```
  Implementation: internally, the hook installs one subscription per provided method against the appropriate observer, using the same `setState → useEffect` deferral pattern currently used by the four `useOnCard*` hooks. A `delegateRef` holds the delegate object so inline literals don't re-install subscriptions on every render. Only the methods defined on the delegate subscribe; missing methods are no-ops.
- Delete the four `useOnCard*` hooks. There are no stragglers.
- Migrate `TideCardBody`:
  ```tsx
  useCardDelegate(cardId, {
    cardDidFinishConstruction: () => entryDelegateRef.current?.focus(),
    cardDidActivate: () => entryDelegateRef.current?.focus(),
  });
  ```

**Verification:**
- `rg "export function useOnCard" tugdeck/src` returns zero matches.
- `rg "useCardDelegate" tugdeck/src` shows the new hook and its callers.
- `bun test` green.
- Manual: unchanged tide card behavior.

#### Step 3 — Add `cardWillActivate` and `cardWillDeactivate` and wire the ordered cascade {#step-3}

**Files:**
- `tugdeck/src/lib/card-lifecycle.ts`
- `tugdeck/src/__tests__/card-lifecycle.test.tsx`

**Work:**
- Add two new notify methods on `CardLifecycle`: `notifyCardWillActivate(cardId)` and `notifyCardWillDeactivate(cardId)`, each with a matching `observeCardWillActivate` / `observeCardWillDeactivate` API and a corresponding subscriber set.
- Reshape `activateCard(cardId)` to fire the four methods in D3 order:
  ```
  (a) notifyCardWillDeactivate(wasActive)    // if any
  (b) notifyCardWillActivate(cardId)          // always (no-op if same card)
  (c) store.focusCard(cardId); manager.makeFirstResponder(cardId) if differs
  (d) notifyCardDidDeactivate(wasActive)     // if any
  (e) notifyCardDidActivate(cardId)           // always
  ```
  Same-card re-activation: skip all will/did fires (silent no-op).
- `removeCard` / destruction path: fire `cardWillDeactivate` / `cardDidDeactivate` before `cardWillBeginDestruction` when the card was active. Order on destroy-of-active:
  ```
  notifyCardWillDeactivate(cardId)
  notifyCardDidDeactivate(cardId)
  notifyCardWillBeginDestruction(cardId)
  store removes card
  ```
- Extend the `TugCardDelegate` interface wiring: the two new methods subscribe via `useCardDelegate`.

**Verification:**
- `bun test` includes a new test that records a call log across two cards A, B and asserts the exact sequence on click-switch.
- Manual: tide card still focuses on activate; clicking another card still moves focus; the call log prefixed `[CardLifecycle]` (once Step 9 adds logs) shows the 4-phase sequence.

#### Step 4 — Introduce `AppLifecycle` class and `useAppDelegate` hook (no wiring yet) {#step-4}

**Files (new):**
- `tugdeck/src/lib/app-lifecycle.ts`
- `tugdeck/src/__tests__/app-lifecycle.test.tsx`

**Files (edited):**
- `tugdeck/src/deck-manager.ts` (construct and expose the `AppLifecycle` instance alongside `CardLifecycle`)

**Work:**
- Author `AppLifecycle` in the same shape as `CardLifecycle`: eight `notifyApplication*` methods, eight `observe*` methods, singleton-register pattern (`registerAppLifecycle` / `getAppLifecycle`) paralleling the card counterpart, and a React context (`AppLifecycleContext`).
- Define and export:
  ```ts
  export interface TugAppDelegate {
    applicationWillBecomeActive?(): void;
    applicationDidBecomeActive?(): void;
    applicationWillResignActive?(): void;
    applicationDidResignActive?(): void;
    applicationWillHide?(): void;
    applicationDidHide?(): void;
    applicationWillUnhide?(): void;
    applicationDidUnhide?(): void;
  }

  export function useAppDelegate(delegate: TugAppDelegate): void;
  ```
- `useAppDelegate` uses the same `setState → useEffect` deferral pattern as `useCardDelegate` for consistency (Step 10/11 replaces both mechanisms at once).
- `DeckManager` constructs both lifecycles, wraps the tree with both context providers, and registers both singletons.
- No Swift wiring yet. No cascade yet. This step is pure shape.

**Verification:**
- `bun test` includes a unit test: `notifyApplicationDidBecomeActive()` drives registered observers, `useAppDelegate({ applicationDidBecomeActive })` fires its method.
- `rg "notifyApplication" tugdeck/src/lib/app-lifecycle.ts` lists all eight.
- No behavior change in running app.

#### Step 5 — Replace `window.__tugdeckAppActivated` / `__tugdeckAppDeactivated` with control-frame `app-lifecycle` {#step-5}

**Files:**
- `tugapp/Sources/AppDelegate.swift` (the two existing delegate methods)
- `tugdeck/src/action-dispatch.ts` (add `app-lifecycle` control action)
- `tugdeck/src/main.tsx` (delete the two `window.__tugdeckApp*` globals; leave `__tugdeckSaveState` and `__tugdeckReconnect` alone for now — Step 8 handles them)
- `tugdeck/src/components/tugways/selection-guard.ts` (replace direct calls from window globals with a delegate registration on `AppLifecycle`)

**Work:**
- Swift: change `applicationDidResignActive` to call `processManager.sendControl("app-lifecycle", ["event": "didResignActive"])`. Same for `applicationDidBecomeActive` with `"didBecomeActive"`.
- JS: `action-dispatch.ts` handles `app-lifecycle` frames by reading `params.event` and calling the appropriate `notifyApplication*` method on the registered `AppLifecycle` singleton.
- Delete `(window as ...).__tugdeckAppDeactivated` and `.__tugdeckAppActivated` from `main.tsx`.
- `selectionGuard` migrates fully to the delegate (per D9): remove the imperative `deactivateApp()` / `activateApp()` public methods. The logic that lived in those methods moves inline into `applicationDidResignActive` / `applicationDidBecomeActive` handlers that `selectionGuard.attach(appLifecycle)` registers via `observeApplicationDidResignActive` / `observeApplicationDidBecomeActive` in its setup path. The guard holds its subscription-disposers and releases them on teardown.

**Verification:**
- `rg "__tugdeckApp" tugdeck/src tugapp/Sources` returns zero matches.
- Manual: Cmd-Tab away and back; selection dims and restores (existing behavior unchanged); console logs the control-frame round-trip.
- `bun test` + existing selection-guard tests green.

#### Step 6 — Add the six new `NSApplicationDelegate` methods and wire all eight to control frames {#step-6}

**Files:**
- `tugapp/Sources/AppDelegate.swift`

**Work:**
- Implement:
  ```swift
  func applicationWillBecomeActive(_ notification: Notification)
  func applicationWillResignActive(_ notification: Notification)   // already ? no — only Did today
  func applicationWillHide(_ notification: Notification)
  func applicationDidHide(_ notification: Notification)
  func applicationWillUnhide(_ notification: Notification)
  func applicationDidUnhide(_ notification: Notification)
  ```
  — each sends `processManager.sendControl("app-lifecycle", ["event": "<name>"])` with the appropriate event string.
- Ensure `applicationWillResignActive` is added (AppKit calls it even though we didn't have an impl; we need it to send the will frame before the did frame).
- Keep existing `applicationDidBecomeActive` and `applicationDidResignActive` sending their respective did frames.
- No JS changes — the `action-dispatch.ts` handler from Step 5 already routes by event name; the `AppLifecycle` already exposes all eight notify methods from Step 4.
- Add an NSLog at the top of each delegate method: `NSLog("AppDelegate: <name>")`. Matches the existing NSLog style in that file.

**Verification:**
- Launch Tug.app. Cmd-Tab away; Cmd-H; unhide via menu/Dock; Cmd-Tab back. Console shows eight distinct `[AppLifecycle]` lines (once Step 9 adds JS-side logs) and eight NSLog lines.
- Manual: app still backgrounds/foregrounds/hides/unhides normally; selection still dims and restores (existing behavior preserved via the `didResignActive` / `didBecomeActive` path).

#### Step 7 — App → card cascade, idempotent (new `lib/lifecycle-cascade.ts`) {#step-7}

**Files (new):**
- `tugdeck/src/lib/lifecycle-cascade.ts`
- `tugdeck/src/__tests__/lifecycle-cascade.test.ts`

**Files (edited):**
- `tugdeck/src/deck-manager.ts` (construct and install the cascade once both lifecycles exist)

**Work:**
- New module `lib/lifecycle-cascade.ts`:
  ```ts
  export interface LifecycleCascadeHandle {
    dispose(): void;
  }

  export function installLifecycleCascade(
    cardLifecycle: CardLifecycle,
    appLifecycle: AppLifecycle,
  ): LifecycleCascadeHandle;
  ```
  The module imports both lifecycle classes (one-way; neither lifecycle imports this module — no circular risk).
- Cascade rules the module wires:
  - On `applicationWillResignActive` or `applicationWillHide`: if an active card exists and is not already in the deactivated-by-app state, call `cardLifecycle.notifyCardWillDeactivate(activeId)` followed by `cardLifecycle.notifyCardDidDeactivate(activeId)`. Set an internal `deactivatedByAppCardId` field.
  - On `applicationDidBecomeActive` or `applicationDidUnhide`: if `deactivatedByAppCardId` is set, call `notifyCardWillActivate(id)` then `notifyCardDidActivate(id)`. Clear the field.
- Idempotency: the `deactivatedByAppCardId` field is the guard. `applicationWillResignActive` sets it; a subsequent `applicationWillHide` sees it already set and skips. Restoration on `DidBecomeActive`/`DidUnhide` is symmetric — first restore wins, subsequent is no-op. Per D10, no undo logic is needed on the `will` side — AppKit always pairs will/did.
- `DeckManager` calls `installLifecycleCascade(this.cardLifecycle, this.appLifecycle)` right after constructing both, stores the handle, and calls `handle.dispose()` in its own `destroy()` method.

**Verification:**
- New test: fire `notifyApplicationWillResignActive` then `notifyApplicationWillHide` in sequence; assert `cardWillDeactivate` and `cardDidDeactivate` fired exactly once each on the active card.
- New test: fire deactivate cascade then `notifyApplicationDidBecomeActive`; assert `cardWillActivate` / `cardDidActivate` fired on the right card.
- Manual with tide card: Cmd-Tab away blurs the prompt caret; Cmd-Tab back restores it without a click. Cmd-H hides the app; unhide restores focus. Cmd-H after Cmd-Tab produces no double-fire (verified via log).

#### Step 8 — Rename `window.__tugdeck{SaveState,Reconnect}` onto `window.tugdeck` namespace {#step-8}

**Files:**
- `tugapp/Sources/AppDelegate.swift` (the two `evaluateJavaScript` sites in `applicationShouldTerminate` and the tugcast-restart branch)
- `tugapp/Sources/MainWindow.swift` (any additional call sites — grep)
- `tugdeck/src/main.tsx`
- `tugdeck/src/deck-manager.ts` (comment references)

**Work:**
- Replace the two window-global assignments in `main.tsx`:
  ```ts
  const tugdeckNamespace = { saveState: () => deck.saveAndFlushSync(), reconnect: () => connection.forceReconnect() };
  (window as unknown as Record<string, unknown>).tugdeck = tugdeckNamespace;
  ```
- Delete the two old `__tugdeckSaveState` / `__tugdeckReconnect` assignments.
- Update Swift `evaluateJavaScript` strings: `window.tugdeck?.saveState?.()` / `window.tugdeck?.reconnect?.()`.
- Update docstrings and code comments that reference the old names.

**Verification:**
- `rg "__tugdeck" tugdeck/src tugapp/Sources` returns zero matches.
- Manual: quit the app — state saves cleanly (the existing behavior was visible; no regression). Restart tugcast manually via the dev menu path; reconnect fires.

#### Step 9 — `[CardLifecycle]` / `[AppLifecycle]` structured console logging {#step-9}

**Files:**
- `tugdeck/src/lib/card-lifecycle.ts`
- `tugdeck/src/lib/app-lifecycle.ts`

**Work:**
- At the top of every `notify*` method in both lifecycles, emit one `console.log` line:
  ```ts
  // card side
  console.log(`[CardLifecycle] ${methodName} id=${cardId}`);
  // app side
  console.log(`[AppLifecycle] ${methodName}`);
  ```
- Also log at the cascade layer when a cascade fires: `console.log("[CardLifecycle] cascade from " + appEvent + " → cardWillDeactivate id=" + cardId)` etc.
- No throttling, no gating. Pure greppable console output.

**Verification:**
- Manual: open three cards, switch between them, Cmd-Tab away and back — console shows a full trace:
  ```
  [AppLifecycle] applicationWillResignActive
  [CardLifecycle] cascade → cardWillDeactivate id=abc
  [CardLifecycle] cardWillDeactivate id=abc
  [CardLifecycle] cardDidDeactivate id=abc
  [AppLifecycle] applicationDidResignActive
  ...
  ```
- Deleting the logs is `rg "\[CardLifecycle\]|\[AppLifecycle\]" tugdeck/src/lib` + a one-line regex delete when trust is established.

#### Step 10 — Reliability design study (no runtime code) {#step-10}

**Files (new):**
- `dash/lifecycle-delegate-reliability.md` (a standalone study document, paralleling the `transport-exploration.md` pattern)

**Work:**
- Written study investigating how to deliver delegate-method calls reliably and deterministically, escaping WebKit's gesture focus-lock without leaning on React's useEffect timing as a load-bearing mechanism. Topics to cover:
  - **The problem statement in full.** WebKit reverts programmatic focus moved during a pointer gesture if the gesture target used `preventDefault()` on `mousedown`. Microtasks don't help (same gesture context). `setTimeout(fn, 0)` works but is timing-based and non-deterministic. `useEffect` works because it runs post-paint, but that makes our lifecycle dependent on React's commit scheduling.
  - **Candidate mechanisms to investigate.**
    - `scheduler.yield()` (new primitive in Chromium-based browsers; check WebKit status)
    - `MessageChannel` + `postMessage(0)` (historically reliable macrotask boundary)
    - `queueMicrotask` (known to fail here; document why)
    - `requestAnimationFrame` then `queueMicrotask` (double-step)
    - A dedicated microtask-or-macrotask queue that the `CardLifecycle` drains explicitly off a well-defined boundary
    - Not deferring at all: deliver synchronously and have consumers handle the focus-refuse case themselves (shift the burden of gesture-awareness out of the lifecycle)
    - Bypassing `preventDefault` on the title bar so WebKit's focus lock never activates
  - **Web research.** WebKit bug tracker, HTML spec (the "update the rendering" event-loop step), browser-vendor docs on focus handling during pointer events, tuglaws compliance for each candidate.
  - **Tuglaws cross-check** for each candidate: L02 (useSyncExternalStore only for external state), L03 (useLayoutEffect for event-dependent registrations), L06 (appearance via CSS/DOM), L22 (store observers drive DOM).
  - **Known holes in the Step 1–3 `useCardDelegate` deferral** (carried into the study so the replacement mechanism is evaluated against them, not just the focus-lock problem). The study MUST either resolve each or document why each is acceptable under the chosen mechanism:
    - **H1 — Destruction never fires for the dying card's own delegate.** `notifyCardWillBeginDestruction` fires sync, but the React drain path (setState → useEffect) requires the component to remain mounted until the post-paint effect runs. The deck's `removeCard` fires destruction → updates `deckState` → React unmounts the card component → the queued `setSeq` is dropped before `useEffect` drains. Any delegate `cardWillBeginDestruction: () => { save state }` silently never runs on the dying card itself. Non-React wildcard subscribers (e.g., `selectionGuard`) still receive the event synchronously and are unaffected. The Step 1–3 docstring for `notifyCardWillBeginDestruction` says "subscribers can read state" — true for sync subscribers, partial lie for React delegates under the current mechanism.
    - **H2 — "Subscribers can read state" is conditional on the mechanism.** Any deferred delegate callback reads whatever state exists at drain time, not at fire time. For construction this is fine (store already updated). For destruction this fails (store has removed the card). The replacement mechanism should either deliver deferred callbacks while the card is still in the store, or explicitly commit to a semantics where destruction delegates run *synchronously* at fire time (different mechanism per event type, or a uniform sync-with-gesture-escape strategy).
    - **H3 — Delegate-method latency relative to DOM paint and user-visible effects.** Current pattern delays the delegate call until after paint. For focus-on-activate that's required (escape the gesture lock). For other delegate methods, post-paint timing may be unnecessary and may introduce a one-frame delay the user perceives. The study should decide whether the mechanism is uniform across all six events or event-specific.
  - **Adjacent coherence issue (not a reliability problem, but surfaced during the Step 3 audit and worth noting in the study's conclusions so it's not lost).**
    - **H4 — No next-card activation after `removeCard` of the active card.** The deck's `removeCard` fires `will-deactivate` / `did-deactivate` / `will-begin-destruction` for the closing card and filters the deck state, but does not call `activateCard` on whichever card is now top of the stack. The store's `getFocusedCardId()` returns the new top, but no `cardWillActivate` / `cardDidActivate` fires for it, and the responder chain is not promoted. Pre-existing behavior; becomes more visible under the delegate model. The study should note this as a **separate follow-up item** the reliability mechanism does not itself resolve — the fix is a deck-orchestration change (call `activateCard(nextId)` after the filter) rather than a scheduling change. A candidate step: a pre-Step 12 "deck orchestration follow-up" step that closes this.
    - **H5 — No `DeckManager.removeCard` → lifecycle-order test exists.** Step 3 tests the ordering at the `CardLifecycle` unit level; the orchestration at the `DeckManager` layer (will-deactivate → did-deactivate → will-begin-destruction → filter) is not directly pinned. Low priority; the study's verification section should either recommend adding this test or explicitly accept its absence.
  - **Additional holes surfaced during the Steps 4–9 audit** (not reliability problems, but adjacent coherence / hygiene items the study should mention so nothing is lost):
    - **H6 — `initActionDispatch`'s `applicationDidResignActive` subscription has no dispose counterpart.** The `observeApplicationDidResignActive(() => deckManager.saveAndFlush())` wire registered in `action-dispatch.ts` is install-only — no unsubscribe. Fine in production (init runs once per page load; process exit disposes everything), but uneven against the cascade pattern which *does* return a dispose handle. If HMR or tests ever drive init multiple times, the old subscription lives on an orphaned `AppLifecycle` instance. Garbage-collected, not leaked. Hygiene item — the study should either recommend returning a disposer + storing it for teardown, or explicitly accept the install-once model.
    - **H7 — No test for `DeckManager` → `installLifecycleCascade` → `dispose` path.** The cascade module is tested in isolation (10 tests in `lifecycle-cascade.test.ts`); the `DeckManager` install and destroy-time dispose is implicit. Similar class of gap to H5. Low priority; study should recommend a direct test or explicitly accept the gap.
    - **H8 — Reactivation of a card destroyed mid-cycle.** If the user closes the active card while the app is in background, then brings the app back, the cascade fires `notifyCardWillActivate(id)` / `notifyCardDidActivate(id)` for a card that no longer exists. No crash — specific-id subscribers are gone, wildcard subscribers get a dead id — but the `[CardLifecycle]` log shows an activation of a phantom card. A `cardLifecycle.hasConstructed(id)` guard before firing would close this. Study should note the rare path and decide whether to add the guard (cheap) or accept the phantom log lines (simpler).
    - **H9 — `applicationWillBecomeActive` may fire before tugcast/JS is up.** AppKit can dispatch this during initial launch before `applicationDidFinishLaunching` completes, and `sendControl` may drop frames when tugcast isn't listening. The JS never sees the early will-event. The first user-triggered `applicationDidBecomeActive` recovers state, so this is acceptable — but if a downstream use case ever depends on a reliable "fire once at app start" signal, this path isn't the way. Study should document the constraint so future callers don't build assumptions on top of it.
    - **H10 — Step 9 logs are always-on.** Every card switch, every app transition, and every cascade emits a `[CardLifecycle]` / `[AppLifecycle]` line to console. Acceptable during Steps 4–9 (explicit request for extensive logging during wiring). Study should decide: gate behind a dev flag, delete wholesale once trust is established, or leave them. Step 11 is the natural landing point for the decision.
    - **H11 — `window.tugdeck` is a cast, not a typed global.** `(window as unknown as Record<string, unknown>).tugdeck = {...}` works but means TypeScript can't catch typos if JS-side code ever reads from it. Only Swift reads today, so this is invisible. Tighten with a `declare global { interface Window { tugdeck?: {...} } }` block or accept the cast. Study should note the hygiene item.
  - **Proposal.** Pick one mechanism. Justify it in-document. Commit to it in Step 11. For H1–H3, state plainly how the mechanism handles each. For H4–H11, state the follow-up work (if any) plainly so nothing is lost.
- The study document is self-contained and readable without this plan's context — it captures the failure modes, the experiments considered, and the verdict.

**Verification:**
- `dash/lifecycle-delegate-reliability.md` exists.
- The proposal at the end of the document names a specific mechanism with a specific implementation sketch.
- Every hole H1–H11 is addressed in-document: either resolved by the chosen mechanism, documented as accepted, or flagged as a follow-up with a named next step.
- No runtime code changes in this step.

#### Step 11 — Adopt chosen reliability mechanism; delete `lib/defer.ts` {#step-11}

**Files:**
- `tugdeck/src/lib/card-lifecycle.ts` (replace the `setState → useEffect` deferral in `useCardDelegate`)
- `tugdeck/src/lib/app-lifecycle.ts` (same replacement in `useAppDelegate`)
- `tugdeck/src/lib/defer.ts` (delete)
- Any test fixture that imports `deferToNextMacrotask`.

**Work:**
- Implement the mechanism chosen in Step 10.
- Replace the internal deferral in `useCardDelegate` and `useAppDelegate` so both delegate hooks use the new mechanism.
- Delete `lib/defer.ts`.
- Re-run the stress tests from Step 3 and Step 7 (card-switch 50×, Cmd-Tab 50×, Cmd-H 10×) and record the observed failure rate (expect 0%).

**Verification:**
- `rg "deferToNextMacrotask|defer\.ts" tugdeck/src` returns zero matches.
- `bun test` green.
- Manual stress test (50 consecutive new-card opens) shows zero focus failures.

#### Step 11.5 — Add `cardWill/DidMove` and `cardWill/DidResize` delegate methods {#step-11-5}

**Motivation:** A reproducible focus bug surfaced after Step 11 shipped: dragging an already-active tide card's title bar to *move* it leaves the prompt editor de-focused, and resizing the card does the same. The underlying cause is some interaction between WebKit's pointer-capture-during-gesture behavior and the prompt's contenteditable focus — diagnosable but not worth chasing when the lifecycle protocol already has a clean place to land a fix: make move and resize first-class delegate events so the tide card's `entryDelegate.focus()` re-asserts deterministically on gesture completion.

This also closes out the "Out of scope" note in [§Scope](#scope) that deferred card-resize / card-move delegates to "a later unification" — this plan has proven the delegate model works; pulling the deferred pair in now is the right time to unify.

**Files:**
- `tugdeck/src/lib/card-lifecycle.ts`
- `tugdeck/src/deck-manager.ts`
- `tugdeck/src/components/tugways/cards/tide-card.tsx`
- `tugdeck/src/__tests__/card-lifecycle.test.tsx`

**Work:**

*CardLifecycle:*
- Add four subscriber sets: `willMoveSubs`, `didMoveSubs`, `willResizeSubs`, `didResizeSubs`.
- Add four public notify methods: `notifyCardWillMove`, `notifyCardDidMove`, `notifyCardWillResize`, `notifyCardDidResize`. Each logs `[CardLifecycle] cardWill/DidMove id=...` / `cardWill/DidResize id=...`.
- Add four public observe methods: `observeCardWillMove`, `observeCardDidMove`, `observeCardWillResize`, `observeCardDidResize`. No initial-sync — both are strictly transitional events, like deactivation.

*TugCardDelegate:*
- Add four optional methods:
  ```ts
  cardWillMove?(cardId: string): void;
  cardDidMove?(cardId: string): void;
  cardWillResize?(cardId: string): void;
  cardDidResize?(cardId: string): void;
  ```
- Signature choice: **cardId-only**, matching every other delegate method. Consumers that need the new position/size read from the deck store via `deckState.cards.find(c => c.id === cardId)`. (An args-carrying variant can land later if a consumer needs it; keeping the uniform shape now avoids per-event signature drift.)

*useCardDelegate:*
- Extend `CardDelegateMethodName` union with the four new names.
- Install four more observer subscriptions in the `useLayoutEffect`, routed through the existing `scheduleDelegateCall` drain.

*DeckManager.moveCard:*
- `moveCard(id, position, size)` is the single commit point for both drag and resize (corner handles change both position and size; edge handles change one or the other; drag changes only position). Detect which components changed by comparing against the pre-mutation card state, and fire only the matching event pair:
  ```ts
  moveCard(id, position, size) {
    const existing = this.deckState.cards.find(c => c.id === id);
    const positionChanged = existing
      ? existing.position.x !== position.x || existing.position.y !== position.y
      : false;
    const sizeChanged = existing
      ? existing.size.width !== size.width || existing.size.height !== size.height
      : false;
    if (positionChanged) this.cardLifecycle.notifyCardWillMove(id);
    if (sizeChanged) this.cardLifecycle.notifyCardWillResize(id);
    // ... existing store mutation + notify() ...
    if (positionChanged) this.cardLifecycle.notifyCardDidMove(id);
    if (sizeChanged) this.cardLifecycle.notifyCardDidResize(id);
    this.scheduleSave();
  }
  ```
  A pure drag fires only the move pair. A pure edge resize fires only the resize pair. A corner-handle resize (which moves the origin AND changes size) fires both pairs. A no-op `moveCard` with identical values fires neither.

*Tide card:*
- Extend `useCardDelegate` call to react to both new events:
  ```tsx
  useCardDelegate(cardId, {
    cardDidFinishConstruction: () => entryDelegateRef.current?.focus(),
    cardDidActivate: () => entryDelegateRef.current?.focus(),
    cardDidMove: () => entryDelegateRef.current?.focus(),
    cardDidResize: () => entryDelegateRef.current?.focus(),
  });
  ```

**Tests:**
- Direct API: two tests per event (matching + wildcard fires; no-op when no actual change). Six total (will+did for move, will+did for resize, plus "no-op on identity moveCard").
- Hook: one test that a delegate with `cardDidMove`/`cardDidResize` receives the event via the MessageChannel drain — asserts the closure survives the notification.

**Verification:**
- `bun test` green (2209 + ~6 new).
- `bun x tsc --noEmit` clean.
- Manual: move an already-active tide card by its title bar — prompt stays focused throughout and resumes caret blink after drag-end.
- Manual: resize an already-active tide card by any handle — prompt stays focused and caret blink resumes after resize-end.
- The test effect named in §Success Criteria for activation now extends to cover move/resize: "Any gesture that commits a card's geometry leaves the prompt editor focused afterward."

**Note on scope:** Does not change `activateCard`'s semantics (same-card re-activation remains silent per D3 / T-CL-03). Does not introduce a click-affirmation event. Solves the focus-loss bug by adding two specific lifecycle transitions that the bug maps to — nothing more.

#### Step 11.6 — Lifecycle routing audit fix (H-A1 … H-A6) {#step-11-6}

**Motivation:** A 360° audit after Step 11.5 surfaced six critical and moderate holes where `deckState` mutates without routing through the lifecycle delegate machinery. The user's rule: *every* code path that affects foreground/background/hide/unhide or construction/destruction/activation/deactivation/move/resize MUST go through the delegates. This step closes every live path that violates that rule.

**Files:**
- `tugdeck/src/action-dispatch.ts`
- `tugdeck/src/deck-manager.ts`
- `tugdeck/src/components/chrome/deck-canvas.tsx`
- `tugdeck/src/__tests__/deck-manager.test.ts`
- `tugdeck/src/__tests__/action-dispatch.test.ts` (if touched)

**Work:**

*H-A1 — `focus-card` menu action bypasses lifecycle.*
- `action-dispatch.ts`: change `deckManager.focusCard(cardId)` to `deckManager.activateCard(cardId)` in the `focus-card` handler. `activateCard` internally calls `focusCard` for z-order but ALSO fires will/did events and promotes the responder chain. The View menu card-list selection becomes a first-class activation path.

*H-A2 — `arrangeCards` silently moves/resizes every card.*
- `DeckManager.arrangeCards(mode)`: diff the arranged cards against the pre-arrange state. For each card whose position changed, fire `notifyCardWillMove` / `notifyCardDidMove`. For each card whose size changed (tile mode), fire `notifyCardWillResize` / `notifyCardDidResize`. Same change-detection pattern as `moveCard`.
- Ordering: fire all `will` events first across all cards, then commit `deckState`, then fire all `did` events.

*H-A3 — `_detachTab` creates a new card without firing construction or activation.*
- `_detachTab`: capture `previouslyActive = this.cardLifecycle.getActiveCardId()` before the splice+append mutation. After the mutation + `notify()`, fire `notifyCardDidFinishConstruction(newCardId)` then `activateCard(newCardId, previouslyActive)`. Mirrors the `addCard` pattern exactly.
- Test: detach a tab → assert construction fires, source card's `cardDidDeactivate` fires, new card's `cardDidActivate` fires.

*H-A4 — `_mergeTab` silently destroys the source card when merging its last tab.*
- `_mergeTab`: detect the source-card-will-be-destroyed case (source has exactly 1 tab, matching the splice's last-tab branch). If source was active, fire `notifyCardWillDeactivate(sourceId)` + `notifyCardDidDeactivate(sourceId)` before the mutation. Fire `notifyCardWillBeginDestruction(sourceId)` before the mutation. After the mutation + `notify()`, if the source was active, activate the target card (via `activateCard(targetCardId, null)` since deactivation already fired).
- If source is NOT the active card but IS destroyed, fire destruction only.
- Test: single-tab source card → merge its tab → assert destruction fires and target activation fires (if source was active).

*H-A5 — `loadLayout` creates cards without firing construction.*
- `DeckManager` constructor: after `this.deckState = this.loadLayout()`, iterate `this.deckState.cards` and call `this.cardLifecycle.notifyCardDidFinishConstruction(card.id)` for each. This populates `constructedCards` so later-subscribing delegates receive initial-sync correctly for loaded cards.
- Must fire BEFORE `reactRoot.render()` so React subscribers don't miss the initial-sync.
- Note: no activation events fire here — the `initialFocusedCardId` restoration in DeckCanvas (fixed by H-A6 below) handles activation.

*H-A6 — `initialFocusedCardId` restoration same-card-bails.*
- `deck-canvas.tsx`: change `store.activateCard(focusedCardId)` → `store.activateCard(focusedCardId, null)`. Passing `null` as the known-previous forces the full activation transition (no prior to deactivate; fires `will/didActivate` for the restored card).
- `IDeckManagerStore.activateCard` signature needs extending: `activateCard: (cardId: string, knownPreviousActive?: string | null) => void`. The DeckManager implementation already accepts the 2-arg form post-Step-11.5-fix; this just makes the interface match.

**Tests:**
- H-A1: mock control frame `focus-card` → assert `activateCard` called, not `focusCard`.
- H-A2: `arrangeCards("cascade")` with 3 cards → assert 3 `cardDidMove` events; `arrangeCards("tile")` → assert 3 move + 3 resize.
- H-A3: detach tab from multi-tab card → assert `construct:new, willDeact:old, willAct:new, didDeact:old, didAct:new` in order.
- H-A4: merge tab from single-tab source (active) → assert `willDeact:src, didDeact:src, willDestroy:src, willAct:tgt, didAct:tgt`.
- H-A4 alt: merge tab from single-tab source (non-active) → assert `willDestroy:src` only, no activation events.
- H-A5: construct a DeckManager with a pre-populated layout → observe `cardDidFinishConstruction` wildcard → assert fires for each loaded card.
- H-A6: simulate reload with a focused card id → assert `cardWillActivate` + `cardDidActivate` fire for the restored card.

**Verification:**
- `bun x tsc --noEmit` clean.
- `bun test` green (2224 + ~8 new).
- Manual test matrix:
  - Select a card from the View menu → card comes to top AND prompt of new top gains focus (H-A1).
  - Pick View > Cascade (or Tile) while a tide card is active → all cards rearrange; tide prompt regains focus after arrangement (H-A2).
  - Drag a tab off a multi-tab card → new card appears with its prompt focused; old card's prompt blurs (H-A3).
  - Drag the last tab off a single-tab tide card onto another card → source disappears; if source was active, target's prompt gains focus (H-A4).
  - Reload Tug.app with a tide card focused → after reload, that card's prompt is auto-focused (H-A5 + H-A6).

**Note on scope:** This step fixes routing only. It does not introduce new events or change existing event semantics. Every fix follows the patterns already established in Steps 3, 7, 11, and 11.5.

#### Step 11.6.1a — Split the data model into `Card` + `CardStack` and mount card content via portals {#step-11-6-1a}

**Motivation:** A second-order bug from Step 11.6 manifests as follows:

1. Open a tide card pointed at `/u/src/tugtool`.
2. Use Developer > Add Tab to Active Card to add a Hello World tab.
3. Drag the Hello World tab out into its own card.
4. Hello World becomes active, but the deactivated tide card's prompt entry still has a blinking caret.

Tracing the events shows they all fire in the expected order. But the bug persists because **tab content components unmount and remount when a tab moves between cards.** React preserves component identity only within the same parent subtree; moving a tab from card A's children to card B's children is functionally unmount + remount no matter how the keys line up. That teardown also discards the mounted content's internal state — and for tide cards, that includes the live session WebSocket to tugcast and the text engine's input delegate. Re-mounting reconstructs the DOM but leaves the old focus state stale.

The fix is to **stop treating tabs as a parallel concept.** In the unified model, every content surface is a **Card**. A card is constructed once when it enters the deck and destroyed once when it truly leaves. The fact that multiple cards can be visually grouped under a single frame with a tab bar is a **layout feature** of the deck, not a property of the cards. We call that visual container a **CardStack**. A standalone card is a stack of one. Detaching a "tab" is just moving a card between stacks; the card's React subtree never unmounts, so its session survives intact.

To make identity-preservation work, card content is mounted as a **flat children array at the deck root**, keyed by cardId, and each card renders into a **portal** whose target is the content `<div>` of its current host stack. When a card moves between stacks, only the portal container changes; the component subtree stays mounted, effects do not tear down, WebSocket connections continue uninterrupted.

This step (11.6.1a) is the mechanical refactor: split the data model, rewrite DeckCanvas to render via portals, rename the tab-facing store APIs to their card-facing equivalents. **No new lifecycle events; no delegate-semantic changes.** Step 11.6.1b layers the focus-bug-fix semantics on top.

**Files:**
- `tugdeck/src/layout-tree.ts` (data model rename: `CardState` → `CardStackState`; new `CardState`; `DeckState` gets `stacks` + `cards` arrays)
- `tugdeck/src/deck-manager.ts` (store mutations operate on `cards` + `stacks`; internal helpers updated)
- `tugdeck/src/deck-manager-store.ts` (`IDeckManagerStore` API: add `addCardToStack` / `detachCard` / `moveCardToStack`; deprecate or delete `addTab` / `detachTab` / `mergeTab`)
- `tugdeck/src/components/chrome/deck-canvas.tsx` (render `stacks` as chrome; render `cards` flat with portals)
- `tugdeck/src/components/chrome/card-frame.tsx` (becomes "stack frame"; exposes content ref for portal mounting)
- `tugdeck/src/action-dispatch.ts` (menu actions: `new-tab-on-active-card` → `addCardToStack(activeStackId, componentId)`)
- `tugdeck/src/__tests__/deck-manager.test.ts` (migrate to new API names; add identity-preservation tests)
- `tugdeck/src/__tests__/deck-canvas.test.tsx` (portal rendering)
- `tugdeck/src/card-registry.ts` (no change expected; `componentId` semantics unchanged)
- Persistence migration path for the tugbank layout blob (see *Persistence* below).

**Work:**

*Data model:*
```ts
// New:
export interface CardState {
  id: string;                     // stable card identity (former tabId)
  componentId: string;            // "tide" | "hello" | "gallery" | ...
  title: string;
  closable: boolean;
  state?: TabStateBag;            // per-card state bag (renamed TabStateBag later, or leave as-is)
}

export interface CardStackState {
  id: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  cardIds: string[];              // ordered; order drives tab-bar order
  activeCardId: string;           // must be in cardIds
  collapsed?: boolean;
  acceptsFamilies: readonly string[];
}

export interface DeckState {
  cards: CardState[];             // flat table of all cards in the deck
  stacks: CardStackState[];       // flat table of all stacks
  activeStackId?: string;         // the focused stack (which stack the user is in)
  focusedCardId?: string;         // reload-restoration only (unchanged role)
}
```

Invariants:
- Every card in `cards` is referenced by exactly one stack's `cardIds`.
- Every `activeCardId` is present in its stack's `cardIds`.
- A stack with an empty `cardIds` is not allowed; remove the stack when its last card is removed.
- `activeStackId`, if set, references an existing stack.

*Store API rename (`IDeckManagerStore`):*
- `addCard(componentId): string | null` — unchanged shape; creates a Card, wraps it in a new single-card Stack at the default position, makes the new Stack active.
- `addCardToStack(stackId: string, componentId: string): string | null` — replaces `addTab`. Creates a Card, appends to `stacks[stackId].cardIds`, sets `activeCardId` to the new card, no stack movement. Returns the new cardId.
- `detachCard(cardId: string, position: { x: number; y: number }): string | null` — replaces `detachTab`. Removes the card from its current stack; creates a new Stack at `position` containing only this card; returns the new stackId. No-op if the card is already the only card in its stack. **Does not unmount the card's content component.**
- `moveCardToStack(cardId: string, targetStackId: string, insertAtIndex: number): void` — replaces `mergeTab`. Moves the card from its current stack to `targetStackId` at `insertAtIndex`. The moved card becomes the target's active card. If the source stack becomes empty, remove it. **Does not unmount the card's content component.**
- `handleCardClosed(cardId: string)` — unchanged name, semantics shifted: removes a single Card. If the card was its stack's sole card, the stack is also removed.
- `activateCard(cardId, knownPreviousActive?)` — unchanged signature; semantics extended in 11.6.1b.
- `reorderTab` / `setActiveTab` — rename to `reorderCardInStack` / `setActiveCardInStack` for consistency. Keep argument order `(stackId, ...)` for call-site clarity.

*DeckCanvas render shape:*
```tsx
<DeckCanvasRoot>
  {stacks.map(stack => (
    <StackFrame
      key={stack.id}
      stack={stack}
      // StackFrame renders: title bar + tab bar (if cardIds.length > 1) + empty content div with ref
    />
  ))}
  {cards.map(card => (
    <CardPortal key={card.id} card={card} hostStackId={lookupHostStackId(card.id)}>
      <CardRegistry.Component componentId={card.componentId} cardId={card.id} />
    </CardPortal>
  ))}
</DeckCanvasRoot>
```

`CardPortal`:
- Resolves the host stack's content-div ref from a registry populated by `StackFrame` on mount.
- Calls `createPortal(children, contentDiv)`; when `hostStackId` changes, rebinds to the new stack's content-div.
- Never unmounts its children on host change.

`StackFrame`:
- Renders only chrome: title bar, tab bar (if `cardIds.length > 1`), an empty content `<div>` with a ref it registers into the content-ref registry keyed by its stack id.
- Handles drag/resize at the stack level; delegates to `store.moveStack(stackId, position, size)` (renamed from `handleCardMoved`).
- Tab-bar click routes to `store.setActiveCardInStack(stackId, cardId)`.
- Tab-bar drag-out routes to `store.detachCard(cardId, position)`.

*Action-dispatch:*
- `new-tab-on-active-card` → `store.addCardToStack(activeStackId, componentId)` (was `store.addTab(activeCardId, componentId)`).
- `focus-card` handler accepts either a stackId or a cardId; if cardId, look up its stack and activate that stack with that card active. (Card-only semantics at the View menu level arrive in 11.6.1b.)

*Persistence migration:*
- The tugbank layout blob today stores `{ cards: [{ id, position, size, tabs: [...], activeTabId }] }`. The new shape is `{ cards: [...], stacks: [...], activeStackId, focusedCardId }`.
- Add a schema version field to the blob (`version: 1` legacy, `version: 2` new).
- On load: if `version !== 2`, run an in-place migration (each legacy card becomes a stack of 1..N cards; tabs become cards; `activeTabId` becomes `activeCardId`; `id`s preserved for tabs-as-cards so tugbank tabstate rows match).
- Write `version: 2` on save.

**Tests:**
- Data model invariants (orphan cards, stack with empty cardIds, dangling activeCardId, etc.) — assertion-style tests that mutations preserve them.
- API rename round-trip: `addCard` → `addCardToStack` → `detachCard` → `moveCardToStack` produces the same final state as the pre-refactor `addCard` / `addTab` / `detachTab` / `mergeTab` sequence did.
- **Identity preservation (the core test):** mount a `<Deck>` with a tide card; assert the tide card's component `mount` effect fires exactly once; perform `addCardToStack(...)`, then `detachCard(...)`, then `moveCardToStack(...)`, then `setActiveCardInStack(...)`; assert the mount effect still has fired exactly once (never re-mounted). Use a `useEffect(() => { mountCount++; return () => unmountCount++; }, [])` probe in a mock card component.
- Portal rendering: a card's DOM node lives inside its host stack's content-div before and after `moveCardToStack`, verified via `contains()` on the rendered DOM.
- Persistence migration: load a `version: 1` blob, assert the resulting `DeckState` matches a hand-written `version: 2` equivalent, save it back, assert `version: 2`.
- Existing test suite continues to pass with the API-name updates (mechanical find-and-replace in `deck-manager.test.ts`).

**Verification:**
- `bun x tsc --noEmit` clean.
- `bun test` green (existing count + ~8 new).
- Manual smoke:
  - Open a tide card → connects to tugcast.
  - Developer > Add Tab → Hello World appears in tide's stack; tide's connection survives (check network panel: no WS reconnect).
  - Drag Hello out → Hello appears in a new stack; tide's connection still live (no reconnect).
  - Drag Hello back onto tide → Hello merges into tide's stack; tide's connection still live.
  - Close the tide card → tide disconnects once (construction-destruction pair fires exactly once per card per session).

**Note on scope:** This step is mechanical. No new lifecycle events. No delegate-semantic changes. The focus bug reproduction from the motivation STILL manifests at the end of 11.6.1a (because card-level activate/deactivate still fires only on stack-level activation) — that's fixed in 11.6.1b. Verification criterion for "this step is done" is: identity-preservation tests pass, tide's WebSocket survives every card-movement operation, and all pre-existing tests pass under the new API names.

**Execution plan (incremental commits):**

A single-shot rewrite of this step failed once already (dropped ~95 tests and silently deferred the portal split). To land 11.6.1a reliably, break the work into five commits in the order below. Each commit builds a green tree and a green test suite. Each is independently reviewable.

*Piece 1 — Portal-based identity preservation (split into three sub-commits).*

The original single-commit framing of Piece 1 under-scoped the work. `Tugcard` wires several per-content concerns that today happen to be card-scoped but are semantically tab-scoped (property store, persistence callbacks, dirty state, selection-boundary registration, tab-state save callback). For tab content to live at the deck level (the prerequisite for identity preservation across detach/merge AND in-card tab switches), those concerns must move to a per-tab host at deck level. Splitting into three commits keeps each change independently reviewable and green at every HEAD.

*Piece 1.i — Content registry + `CardPortal` component (no behavior change).*
- New file `tugdeck/src/components/chrome/card-content-registry.ts`: module-level registry mapping `cardId → HTMLDivElement`. Exports `register(cardId, el)`, `unregister(cardId)`, `getElement(cardId)`, `subscribe(cardId, callback)`. Subscribe-on-change semantics so portals re-root when their host card's content div mounts/unmounts/re-registers.
- New file `tugdeck/src/components/chrome/card-portal.tsx`: a `<CardPortal hostCardId>` component that uses `useSyncExternalStore` against the registry (keyed by `hostCardId`) to look up the current host element, and returns `createPortal(children, hostEl)` when the element is available. When `hostCardId` changes, the component re-roots the portal to the new host without unmounting its children.
- Modify `tugdeck/src/components/tugways/tug-card.tsx`: register the `contentRef` div with the content registry on mount (keyed by `cardId`), unregister on unmount. No other changes; `children` still render inside the content div as today.
- Unit tests: `__tests__/card-content-registry.test.ts` (register/unregister/subscribe basic behavior); `__tests__/card-portal.test.tsx` (portal renders into registered element; re-roots on hostCardId change; no mount/unmount of children across re-root; handles mid-mount registration).
- Verification: `bun x tsc --noEmit` clean; `bun test` green (existing + ~6 new); no existing test should change behavior because Tugcard's children still render normally.

*Piece 1.ii — Lift per-content scope from `Tugcard` to a new `TabContentHost` at deck level (no portal yet).*
- New file `tugdeck/src/components/chrome/tab-content-host.tsx`: a `<TabContentHost tabId cardId componentId>` component that owns the per-tab concerns that currently live inside Tugcard:
  - `PropertyStore` registration (receives the card content's store and forwards it to setProperty responder — needs the tabId-keyed store map).
  - `TugcardPersistenceCallbacks` registration.
  - `TugcardDirtyContext` markDirty + debounced auto-save timer keyed by `tabId`.
  - SelectionGuard boundary registration keyed by `tabId` (currently keyed by `cardId`).
  - `registerSaveCallback` on the deck manager keyed by `tabId` (currently keyed by `cardId`).
  - Renders `registration.contentFactory(tabId)` wrapped in the four per-content context providers.
- Modify `tugdeck/src/deck-manager.ts` / `tugdeck/src/deck-manager-store.ts`:
  - `registerSaveCallback(id, callback)` / `unregisterSaveCallback(id)` — the `id` can be either a cardId or a tabId. Today it's cardId; after this piece, content callers pass tabId. Keep the signature `(id: string, cb)` and clarify in JSDoc that any unique key works; SaveCallback map semantics unchanged.
  - Selection guard boundary registration path: audit `selection-guard.ts` — current API takes `cardId`; change consumers in Tugcard/TabContentHost to pass `tabId` instead, verify selection restore still works per-tab.
- Modify `tugdeck/src/components/tugways/tug-card.tsx`:
  - Remove the four context providers from the content div render path.
  - Remove `useSelectionBoundary(cardId, contentRef)`.
  - Remove `registerSaveCallback` / `unregisterSaveCallback` from Tugcard's useLayoutEffect.
  - Remove `saveCurrentTabStateRef` ownership from Tugcard; move it to TabContentHost (keyed by tabId).
  - Tugcard's `children` prop is now the already-wrapped TabContentHost for the active tab (passed from DeckCanvas).
- Modify `tugdeck/src/components/chrome/deck-canvas.tsx`:
  - Where `renderContent` constructs `<Tugcard>...{registration.contentFactory(cardState.id)}</Tugcard>`, change children to `<TabContentHost tabId={activeTab.id} cardId={cardState.id} componentId={componentId} />`.
  - TabContentHost internally renders the content factory wrapped in per-tab contexts.
  - No portals yet — TabContentHost's output still renders as a child of Tugcard in the usual React tree.
- Existing test migration: any test that asserts against `registerSaveCallback(cardId, ...)` must be updated to accept the new key (tabId). Any test that asserts against selection-guard boundary keying moves to tabId.
- New tests: `tab-content-host.test.tsx` — verify context providers wrap the content factory; verify save callback registers under tabId; verify selection boundary registers under tabId; verify cleanup on unmount.
- Verification: `bun x tsc --noEmit` clean; `bun test` green; no identity preservation benefit yet (TabContentHost still unmounts/remounts on parent change because it's still a child of Tugcard in the React tree).

*Piece 1.iii — Flip `TabContentHost` to render via portal (identity preservation delivered).*
- Modify `tugdeck/src/components/chrome/tab-content-host.tsx`:
  - Instead of rendering its children as a normal React child, wrap them in `<CardPortal hostCardId={hostCardId}>` so the DOM output lands in the host card's content div.
  - Hoist TabContentHost's React-tree mount location to be a flat sibling list at the top of DeckCanvas, keyed by `tabId`. This is the position that survives cross-card moves — React reconciles key matches even as the data (which card hosts which tab) changes.
- Modify `tugdeck/src/components/chrome/deck-canvas.tsx`:
  - Render two flat lists as siblings: (a) `cards.map(c => <CardFrame />)` for chrome; (b) `cards.flatMap(c => c.tabs).map(tab => <TabContentHost key={tab.id} tabId={tab.id} hostCardId={lookupHostCardId(tab.id)} componentId={tab.componentId} />)` for content.
  - Remove the pass-through of TabContentHost as Tugcard's children. Tugcard's content div now receives content only via the portal landing.
  - Hide inactive tabs with CSS `display: none` (determined at TabContentHost from `activeTabId === tabId` passed from DeckCanvas or looked up via store).
- Modify `tugdeck/src/components/tugways/tug-card.tsx`: content div is empty (portals land there). Remove `children` prop entirely, or keep it for back-compat and document it's unused in this shape.
- New identity-preservation tests: mount-probe card component (`useEffect(() => { mountCount++; return () => unmountCount++; }, [])`); perform `addTab` (switching active tab), `setActiveTab`, `detachTab`, `mergeTab`; assert `mountCount === 1` and `unmountCount === 0` on the probed card across every operation.
- Verification: `bun x tsc --noEmit` clean; `bun test` green; new identity-preservation tests pass. **Effect: the detach focus bug's root cause (content unmount) is resolved; tide's WebSocket survives every card operation. In-card tab switches also preserve identity.**
- Data model unchanged throughout Pieces 1.i–1.iii. No API rename. Commit boundary is additive + targeted render refactor.

*Piece 2 — Full Card / CardStack rename: data model + store API + chrome (single atomic commit).*

The original plan split the chrome rename (`CardFrame` → `StackFrame`) into its own subsequent piece. Piece 1.iii pulled some of the terminology forward (contentFactory now receives a stable card-identity value, gallery dispatches target it, TugcardPortalContext is bridged per card root), which left the codebase in a half-renamed state. Keeping the chrome in its own commit would prolong that limbo. Piece 2 below folds the chrome rename in — one atomic commit takes the repo from "tab/card" mixed vocabulary to the final "card/stack" vocabulary.

**Data model (`tugdeck/src/layout-tree.ts`):**
- Rename existing `CardState` (frame+tabs+position+size) → `CardStackState`. Change field `tabs: TabItem[]` → `cardIds: string[]`; `activeTabId` → `activeCardId`. Keep `position`, `size`, `collapsed`, `acceptsFamilies`, `title`.
- Introduce a new `CardState { id, componentId, title, closable, state?: TabStateBag }`. This is the former `TabItem` with the per-content persistence bag folded in (optional).
- Update `DeckState` to `{ cards: CardState[]; stacks: CardStackState[]; activeStackId?: string; focusedCardId?: string }`. Document invariants in JSDoc (no orphan cards, no empty stacks, `activeCardId ∈ cardIds`, `activeStackId` references a real stack).
- `TabItem` is removed. No deprecation shim — callers are updated in the same commit.

**Store API (`tugdeck/src/deck-manager.ts`, `tugdeck/src/deck-manager-store.ts`):**
- Rewrite `DeckManager` internals against the two-table model (`this.deckState.cards` + `this.deckState.stacks`).
- Rename public mutators:
  - `addTab(cardId, componentId)` → `addCardToStack(stackId, componentId)` — creates a new `Card`, appends its id to the stack's `cardIds`, sets it as `activeCardId`. No stack created. Returns the new cardId.
  - `detachTab(cardId, tabId, position)` → `detachCard(cardId, position)` — removes the card from its current stack, creates a new single-card stack at `position`, makes it active. Returns the new stackId. No card construction/destruction — identity is preserved.
  - `mergeTab(srcCard, tabId, tgtCard, idx)` → `moveCardToStack(cardId, targetStackId, insertAtIndex)` — moves a card between stacks. If the source stack becomes empty, remove it.
  - `setActiveTab(cardId, tabId)` → `setActiveCardInStack(stackId, cardId)`.
  - `reorderTab(cardId, fromIdx, toIdx)` → `reorderCardInStack(stackId, fromIdx, toIdx)`.
  - `toggleCardCollapse(cardId)` → `toggleStackCollapse(stackId)`.
  - `getTabState(tabId)` / `setTabState(tabId, bag)` → `getCardState(cardId)` / `setCardState(cardId, bag)`. **The key (`cardId`) IS the former `tabId`**, so tugbank's existing `tabstate/{id}` rows remain readable without data migration. (We may rename the tugbank row prefix in a separate cleanup; out of scope here.)
  - `addCard(componentId)` keeps its signature — creates a new `Card`, wraps in a new `CardStack` of 1, makes it the active stack. Returns the new cardId.
  - `handleCardClosed(cardId)` keeps its signature — removes the card from its stack; if the stack becomes empty, removes the stack.
  - `handleCardMoved(id, position, size)` keeps its signature, but the `id` is now a `stackId` (stacks own position/size). Rename parameter in the interface for clarity.
  - `activateCard(cardId, knownPreviousActive?)` signature unchanged. Implementation looks up the host stack and makes that stack active with the card as its active card. (11.6.1b removes `knownPreviousActive`.)
  - `invokeSaveCallback(id)` unchanged — `id` is now always a cardId.

**Chrome + portals (`tugdeck/src/components/chrome/`):**
- `card-frame.tsx` → `stack-frame.tsx`. `CardFrame` export → `StackFrame`. Prop `cardState: CardState` → `stackState: CardStackState`. `CardFrameProps` → `StackFrameProps`. `CardFrameInjectedProps` stays (still injected into `Tugcard`'s render via `renderContent`). Update every import site.
- `tab-content-host.tsx` → `card-content-host.tsx`. `TabContentHost` → `CardContentHost`. Props: `tabId` → `cardId`; `hostCardId` → `hostStackId`; `componentId` unchanged; `isActive` unchanged. All internal references renamed (`tabId` identifiers become `cardId`; `hostCardId` becomes `hostStackId`).
- `card-content-registry.ts` — the element this registers IS the stack's content `<div>`. Rename keys/docs from `cardId` to `stackId`. File name stays (registry is about card CONTENT divs — i.e., where cards land inside a stack; the "card-content" in the file name is accurate even in the new vocabulary).
- `tab-card-root-registry.ts` → `stack-root-registry.ts`. Keys renamed `cardId` → `stackId`.
- `tab-property-store-registry.ts` — **delete**. Piece 1.iii's refactor made it unreachable (the card-level `setProperty` responder was superseded by the tab-level responder inside `TabContentHost`, now `CardContentHost`). Remove all references.
- `card-portal.tsx` — rename prop `hostCardId` → `hostStackId`. Variables and docs updated.
- `deck-canvas.tsx` — iterate `deckState.stacks` for chrome (`<StackFrame stackState={stack} ...>`); iterate `deckState.cards` for content (`<CardContentHost cardId={card.id} hostStackId={lookupHostStackId(card.id)} componentId={card.componentId} isActive={stack.activeCardId === card.id} />`). Sort render-order by stackId (stable DOM order).

**Action dispatch & coordinators (`tugdeck/src/`):**
- `action-dispatch.ts`: `new-tab-on-active-card` → dispatches `addCardToStack(activeStackId, componentId)`. `focus-card` continues to accept a cardId publicly; internally looks up the host stack and activates. Comments updated to drop "tab" vocabulary.
- `tab-drag-coordinator.ts` → `card-drag-coordinator.ts`. Routes reorder/detach/merge to the new store methods. Internal identifiers (`tabId`, `fromTabId`, etc.) become `cardId` / `fromCardId`. Drop-zone queries still use DOM-level attributes like `data-tab-bar` (these are visual affordances of multi-card stacks; rename to `data-stack-tab-bar` or leave as-is if it would cascade too far — judgment call at edit time, note it in the commit message).
- `main.tsx`: propagate any rename (imports, card-registry access).
- `card-session-binding-store.ts`, `card-services-store.ts`: unchanged API. The key was always "cardId" semantically; now that `cardId` is the stable card identity, the existing keying is correct.

**Tide card (`tugdeck/src/components/tugways/cards/tide-card.tsx`):**
- Rename `useTideCardServices(cardId)` — unchanged name and signature; the `cardId` argument is now the stable card identity (what we've been passing since Piece 1.iii). Consumers unchanged.
- Clean up any lingering `tabId` references in comments.

**Persistence migration (`tugdeck/src/serialization.ts`):**
- Emit `version: 2` blobs with shape `{ version: 2, cards: [...], stacks: [...], activeStackId, focusedCardId }`.
- Load path: detect missing `version` or `version !== 2` → run v1→v2 migration. Legacy shape:
  ```
  { cards: [{ id, position, size, tabs: [{ id, componentId, ... }], activeTabId, collapsed, acceptsFamilies, title }] }
  ```
  Migration: each legacy card becomes a stack (keep stack id === legacy card id); each legacy tab becomes a card (keep card id === legacy tab id). Stack's `cardIds` = ordered legacy tab ids; `activeCardId` = legacy `activeTabId`. `focusedCardId` in the legacy blob is already the card identity (= former tabId), so it carries across unchanged.
- The tugbank `tabstate/{id}` rows reference former `tabId` values, which are now `cardId` values. Keying is preserved.

**Tests (`tugdeck/src/__tests__/*`):**
- Mechanical rename across every call site: `addTab` → `addCardToStack`, `detachTab` → `detachCard`, `mergeTab` → `moveCardToStack`, `setActiveTab` → `setActiveCardInStack`, `reorderTab` → `reorderCardInStack`, `toggleCardCollapse` → `toggleStackCollapse`, `getTabState`/`setTabState` → `getCardState`/`setCardState`.
- Mock stores (`mock-deck-manager-store.ts`, inline mocks in deck-canvas / e2e / card-header / tab-drag-coordinator tests) updated to expose the new API.
- File renames: `tab-content-host.test.tsx` → `card-content-host.test.tsx`. `tab-identity-preservation.test.tsx` → `card-identity-preservation.test.tsx`.
- `serialization.test.ts`: add a v1→v2 migration round-trip test (hand-authored v1 blob loads into an expected v2 `DeckState`; save writes `version: 2`).
- **Do NOT delete existing tests.** If a test becomes meaningless under the new model, migrate its assertion to the equivalent new semantics with a short comment; do not remove the coverage.

**Verification:**
- `bun x tsc --noEmit` clean.
- `bun test` green with a test count ≥ the pre-Piece-2 baseline. No regressions.
- Grep sweep: no occurrence of `addTab`, `detachTab`, `mergeTab`, `setActiveTab`, `reorderTab`, `TabItem`, `TabContentHost`, `CardFrame` (as a component) in `tugdeck/src/`. `tabId` may still appear as a variable name in legacy comments or in `tugbank` row prefixes; surface any remaining occurrences in the commit message.

*Piece 2.5 — Audit and regression cleanup.*

Piece 2 landed in four commits (`4d1191f0`, `8f63ef3a`, `a629f490`, `64ee223d`). Post-merge audit surfaced one critical runtime regression and a set of design smells and code-quality defects that must be fixed before Piece 3. **Every item below is in-scope; none is acceptable to carry forward into Piece 3's invariant tests.**

**P0 — Critical regression: click-to-activate is broken.**

`StackFrame.handleFramePointerDown` fires `onCardFocused(id)` with `stackState.id`. `deck-canvas.tsx` wires that to `handleCardActivate`, which calls `store.activateCard(id)`. In the pre-split model the id was both the frame id and the card id — same value — so the call worked by accident. After the two-table split the id is a **stackId**, but `activateCard` expects a **cardId**. No card in the lifecycle's `constructedCards` set matches, so no will/didActivate fires and the responder chain never promotes. z-order also stays stale because the click path no longer calls `store.focusCard(cardId)`.

Fix:
- In `deck-canvas.tsx`, resolve the clicked stack's `activeCardId` and pass it to both `store.activateCard(cardId)` and `store.focusCard(cardId)`. The cleanest shape is a single handler like:
  ```ts
  const handleStackActivate = useCallback(
    (stackId: string) => {
      const stack = store.getSnapshot().stacks.find((s) => s.id === stackId);
      if (!stack) return;
      store.focusCard(stack.activeCardId);
      store.activateCard(stack.activeCardId);
    },
    [store],
  );
  ```
- Rename `StackFrame.onCardFocused` → `onStackActivated` (the prop receives a stackId, not a cardId — the current name is leftover from the pre-split vocabulary).
- Adjust the resize-start and frame-pointer-down callers inside `StackFrame` to pass `id` (the stackId) unchanged; the resolution to `activeCardId` happens in `deck-canvas.tsx`.
- Add a regression test in `deck-canvas.test.tsx`: render a deck with two stacks, fire a pointer-down on the non-focused stack, assert (a) `store.activateCard` was called with the stack's `activeCardId` (not the stack id), and (b) `store.focusCard` was called with the same cardId. If there is an existing test for click-to-focus, extend it; do not duplicate.
- Manual smoke after the fix: open two cards, click the non-active card, verify its title bar takes the focused style and a `cardDidActivate` observer fires.

**P1 — Lifecycle API abuse: `notifyCardWillBeginDestruction(stackId)` in `_moveCardToStack`.**

When a single-card source stack is merged away, `_moveCardToStack` fires `cardLifecycle.notifyCardWillBeginDestruction(sourceStackId)`. No card is actually destroyed (identity is preserved across the move), and the payload is a **stackId** being smuggled through a card-level event. A wildcard observer that does `lookupCard(id)` on the payload sees nothing. The test at `deck-manager.test.ts:~1671` codifies the misuse.

**Decision: option (a). Drop the event entirely.** Nothing dies when a stack is emptied-by-merge; the destruction event is a false positive. Update the test to assert the event does *not* fire in the merge-destroy path. No stack-lifecycle event subsystem is added.

Re-audit `_closeStack` too: every card in the closed stack genuinely dies, so firing `notifyCardWillBeginDestruction(cid)` per card is correct there and stays. Only the merge path is wrong.

**P1 — Rename `handleCardClosed` → `handleStackClosed`.**

`handleCardClosed` is bound to `_closeStack` and is called with a stackId. The matching `StackFrame.onCardClosed` prop is likewise a stack-close callback. These are the last vocabulary holdovers in the public store API surface. Rename:
- `DeckManager.handleCardClosed` → `handleStackClosed` (and `IDeckManagerStore` too).
- `StackFrame.onCardClosed` → `onStackClosed`.
- Any test spies / mock stores that reference the old name.
- Production call sites: `deck-canvas.tsx` binds `store.handleStackClosed` in the `handleClose` wrapper; the gallery-ref bookkeeping stays unchanged.

The companion `removeCard(stackId, cardId)` (close a single card in a stack) keeps its name — it's correct.

**P1 — Invariants: enforce, don't document.**

`layout-tree.ts` lists five invariants. Nothing validates them at the code level.

Add a `validateDeckState(state): void` helper that throws in dev/test builds when any invariant is violated:
1. every `stack.cardIds` entry references a real `state.cards[].id`;
2. every card appears in exactly one stack's `cardIds` (no orphans, no duplicates);
3. no stack has `cardIds.length === 0`;
4. every `stack.activeCardId` is a member of that stack's `cardIds`;
5. when `state.activeStackId` is set, it references a real stack.

Call it from `applyLayout` (always) and from a dev-only check inside `notify()` (behind an `import.meta.env.DEV` guard or equivalent — do NOT run in production). Piece 3's invariant tests will drive this helper directly instead of re-implementing the check.

**P2 — Deduplicate the splice-active-card pattern.**

`_removeCard`, `_detachCard`, and `_moveCardToStack` each compute "remove cardId from stack, fall back `activeCardId` to previous index if the removed card was active." Three copies of the same 6–10 line pattern. Extract:
```ts
function spliceCardFromStack(stack, cardId): {
  cardIds: readonly string[];
  activeCardId: string | null;  // null when the stack has become empty
}
```
Consume from all three mutators. If the resulting `cardIds` is empty, the caller decides what to do (close the stack, or let it be merged-away).

**P2 — Hoist `cardsById` map in `deck-canvas.tsx`.**

Currently rebuilt inside `sortedStacks.map((stackState) => { const cardsById = new Map(...); ... })`. Move it one scope out so it's built once per render.

**P2 — `focusedCardId` persistence clarification.**

`focusedCardId` lives on `DeckState` but is persisted separately from the layout blob (via `putFocusedCardId`). Two persistence paths for one field. Options:
- Keep it on DeckState (runtime access via `getSnapshot`) but drop it from the serialized layout blob — `serialize()` already emits it; `deserialize()` already reads it. Pick one persistence path, not both. If `putFocusedCardId` is the canonical one, strip it from the v2 blob. If the v2 blob is canonical, delete `putFocusedCardId` and read from the layout on reload.
- Document explicitly in the layout-tree JSDoc which persistence path wins on reload when they disagree.

Pick the simpler path: `putFocusedCardId` stays, `focusedCardId` is removed from the serialized v2 shape. Update `parseV2`, `serialize`, and the migration accordingly.

**P2 — Dead code cleanup.**

- `DeckManager.handleResize = (): void => {}` plus its matching `window.addEventListener("resize", this.handleResize)` and `removeEventListener`: delete both together. The no-op arrow has no callers that need it.
- `buildDefaultLayout(_canvasWidth, _canvasHeight)` takes two unused parameters. Change to `buildDefaultLayout(): DeckState { return { cards: [], stacks: [] }; }` and update call sites in `deck-manager.ts`.
- Rename the Swift wire field `tabCount` → `cardCount` in lockstep: update `pushCardListToHost` in `deck-manager.ts` to emit `cardCount`, and update `AppDelegate.swift` in `tugapp/` to read `cardCount`. The Swift menu title strings ("Close Tab" / "Close Card") are user-facing UX and stay unchanged.

**P2 — `galleryStackIdRef` robustness.**

If a user detaches the gallery card into its own stack, `galleryStackIdRef.current` still points at the old (now-gone) stackId. The next `show-component-gallery` dispatch cannot find the tracked stack and creates a new one — producing two gallery stacks. Fix: on every render, verify the ref against the live snapshot and clear it if the stack no longer exists. Simplest shape is a `useLayoutEffect` guarded on `stacks` identity that runs `if (galleryStackIdRef.current && !stacks.find(...)) galleryStackIdRef.current = null;`.

Alternatively, look up the gallery stack by walking `deckState.cards` for a card whose `componentId === "gallery-buttons"` and returning its host stack id. The ref becomes pure derived state and can be removed. Prefer this if it doesn't duplicate work on hot paths; it's more honest.

**P2 — Test fixture helper refactor in `deck-canvas.test.tsx`.**

`makeCardState(id, componentId)` is a surviving piece of the old pre-split naming — it produces a single-card StackSpec, not a CardState. Rename to `makeSingleCardStack(stackId, componentId)` and `makeMultiCardStack(stackId, cards)`. Update call sites. The `StackSpec.cards` interior list uses field names `id/componentId/title/closable` — those are Card fields and stay as-is.

**Sequencing within Piece 2.5:**

Land each subsection as a separate commit in roughly this order:
1. **P0 click-to-activate fix** (blocks user interaction).
2. **P1 `notifyCardWillBeginDestruction(stackId)` decision and fix.**
3. **P1 `handleCardClosed` → `handleStackClosed` rename** (public API change).
4. **P1 `validateDeckState` helper + applyLayout/notify hook.**
5. **P2 nits bundle**: splice helper extraction, `cardsById` hoist, dead code deletion, `focusedCardId` dedup, `galleryStackIdRef` robustness, test helper rename, Swift wire comment.

Each commit: `bun x tsc --noEmit` clean, `bun test` green with test count ≥ post-Piece-2 baseline (2257). P0 adds one regression test; P1 invariants commit does not add tests (Piece 3 does that); P2 bundles may add small helper tests.

**Verification (Piece 2.5 as a whole):**
- `bun x tsc --noEmit` clean.
- `bun test` ≥ 2258 pass.
- Manual smoke: two-card deck, click the non-active card, verify title-bar focus style flips and `cardDidActivate` fires. Drag a card out of a two-card stack, verify the detached stack activates without a spurious destruction event.
- Grep sweep: no `handleCardClosed` in `tugdeck/src/`; no `onCardFocused` prop on `StackFrame`; no `onCardClosed` prop on `StackFrame`.

**Explicitly out of scope for 2.5 (defer to 11.6.1b or later):**
- Broader store-API decomposition (the `IDeckManagerStore` surface is still wide — that's a Phase 12+ concern).
- Stack-lifecycle events as a first-class subsystem (only add if option (b) is picked under P1, which is unlikely).

*Piece 3 — Portal DOM containment test + additional identity-preservation coverage.*
- Add a test that asserts, after `moveCardToStack`, the moved card's rendered root element is contained within the destination stack's content div (via `document.getElementById` or a ref-based query; use whichever pattern the existing tests use).
- Add tests covering the invariants listed in the Data model section above: no orphan cards, no stacks with empty `cardIds`, every `activeCardId ∈ cardIds`, `activeStackId` references a real stack. One test per invariant, exercised through a mutation that would break the invariant if the implementation is wrong.
- Verification: `bun x tsc --noEmit` clean; `bun test` green with at least 4 new tests (1 containment + 3 invariant).

*Piece 4 — Manual smoke and step close.*
- Run tugdeck in dev (HMR). Execute the manual smoke checklist from the main Verification block. If any step fails, identify which of Pieces 1–3 regressed and fix before declaring done.
- Update this step's section header in the plan to reflect completion (status note at the end of the Work block).
- No code change in this piece.

**Rules for executing each piece:**
- Each piece lands as exactly one commit with a clear commit message.
- `bun x tsc --noEmit` and `bun test` must pass at HEAD of every piece before moving to the next.
- Do not edit files outside the piece's stated file list. If an unexpected file needs a change, pause and surface it before editing.
- Do not delete tests. If a test is meaningless under the new model, migrate it rather than remove it.
- If a piece grows substantially beyond its stated scope, STOP and re-scope; don't pile unrelated work into one commit.

**Status: complete (2026-04-20).** Manual smoke passed. Commit trail:
- Piece 1 — portal identity preservation: `0c01760f`, `f4d3ae7c`, `45029359`, `cf936610`
- Piece 2 — Card/CardStack rename + data-model split: `4fb3695e`, `4d1191f0`, `8f63ef3a`, `a629f490`, `64ee223d`
- Piece 2.5 — audit & regression cleanup: `2d9f2590`, `821c96d1`, `35cdaada`, `193599d2`, `abebba83`
- Piece 3 — portal containment + invariant tests: `f922022c`

#### Step 11.6.1b — First-responder `cardDidActivate` semantics + remove card-level focus duplication {#step-11-6-1b}

**Motivation:** With 11.6.1a in place, card identity is preserved across all movement operations. The last piece is making `cardDidActivate` / `cardWillDeactivate` fire on the right transitions: not just when a stack becomes the active stack, but whenever **the composite bit "this card is the first responder"** changes.

Defining the bit: a card is the first responder iff (a) it is the `activeCardId` of its stack, AND (b) its stack is the deck's `activeStackId`. At any moment, exactly zero or one card is first responder.

Events:
- `cardDidActivate(cardId)` fires when `cardId` becomes first responder (from being non-first-responder).
- `cardWillDeactivate(cardId)` fires when `cardId` is about to stop being first responder.
- `cardDidDeactivate(cardId)` fires after the store mutation that took first-responder status away.
- `cardWillActivate(cardId)` fires before the store mutation that gives first-responder status.

Transitions that flip the bit (all flow through `activateCard` or internal equivalents):
1. User clicks a card in an inactive stack → activate that stack, set that card's active-in-stack, first responder flips from old-active to new.
2. User clicks a tab bar entry in the active stack → set that card's active-in-stack in the (already-active) stack; first responder flips.
3. User clicks a tab bar entry in an inactive stack → both effects above at once.
4. `addCard(componentId)` → new stack becomes active, new card is its active card → first responder flips from old to new.
5. `addCardToStack(stackId, componentId)` → new card becomes `stackId`'s active card. If `stackId` was already the deck's active stack, first responder flips from the previous active-card-in-stack to the new one. If not, no flip (new card is active-in-its-stack but its stack is not active in the deck).
6. `detachCard(cardId, position)` → new stack is created and becomes the deck's active stack, containing only `cardId`. If `cardId` was already first responder, no flip (still first responder). If not, flip to `cardId`. Source stack may also change its active-in-stack card; if source stack is not the deck's active stack after detach, that change does not flip first responder.
7. `moveCardToStack(cardId, targetStackId, insertAtIndex)` → moved card becomes `targetStackId`'s active card. If `targetStackId` is or becomes the deck's active stack, first responder flips to the moved card. Source stack's active-in-stack change is evaluated the same way.
8. `removeCard(stackId, cardId)` → if the card was first responder, its stack picks a new active card (and if `cardId` was the sole card, the stack is removed via `handleStackClosed(stackId)`); first responder flips (or is cleared if no stack remains). Also applies to `handleStackClosed(stackId)` called directly on the active stack.
9. App background / hide (cascade from Step 7) → first responder is cleared temporarily; flip event fires.
10. App foreground / unhide → first responder is restored; flip event fires.

**Files:**
- `tugdeck/src/deck-manager.ts` (activateCard logic; all mutators that can flip first responder)
- `tugdeck/src/lib/card-lifecycle.ts` (no API change; documentation of first-responder semantics)
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (consolidated delegate: `cardDidActivate` / `cardWillDeactivate` become the sole focus-management path; `cardDidFinishConstruction` focus call removed — construction never coincides with first-responder-gained in isolation; `cardDidMove` / `cardDidResize` focus re-assert retained)
- `tugdeck/src/action-dispatch.ts` (`focus-card` handler works at the card level: activates `cardId`'s host stack AND sets `cardId` as its stack's active card)
- `tugdeck/src/components/chrome/deck-canvas.tsx` (`initialFocusedCardId` restoration path flows through `activateCard(cardId, null)`; unchanged signature)
- `tugdeck/src/__tests__/deck-manager.test.ts` (new tests for transitions 1–10)
- `tugdeck/src/__tests__/card-lifecycle.test.tsx` (first-responder sequencing tests)

**Work:**

*DeckManager — introduce a single `_setFirstResponder(newFirstResponderCardId: string | null)` internal method:*
- Computes old first responder = `(activeStack?.activeCardId) ?? null`.
- If `old === new`, no-op.
- Otherwise: fire `cardWillDeactivate(old)` (if `old`), fire `cardWillActivate(new)` (if `new`), commit the store mutation that changes `activeStackId` and/or the target stack's `activeCardId`, `notify()`, fire `cardDidDeactivate(old)` (if `old`), fire `cardDidActivate(new)` (if `new`).
- Every public mutator that can flip first responder routes through `_setFirstResponder`.

*activateCard(cardId, knownPreviousActive?):*
- Look up `cardId`'s host stack.
- Compute the desired new state: `activeStackId = hostStack.id`; `hostStack.activeCardId = cardId`.
- Call `_setFirstResponder(cardId)` (it reads old from current state; `knownPreviousActive` becomes redundant and can be removed — note follow-up in the **Note on scope** below).

*addCardToStack(stackId, componentId):*
- Create card; append to stack's `cardIds`; compute whether first responder flips; call `_setFirstResponder(newCardId)` if the stack is the deck's active stack, else just `notify()` (the new card is active-in-its-stack but not first responder). Construction event fires in between (before `notify()`).

*detachCard(cardId, position):*
- Mutate: remove from source stack, create new target stack at `position`, `activeStackId = newStackId`, new stack's `activeCardId = cardId`. Source stack may need a new active card (pick neighbor).
- First responder flips iff the old first responder was NOT `cardId`. Route through `_setFirstResponder` regardless (no-op if same).
- No construction or destruction events — card identity is preserved.

*moveCardToStack(cardId, targetStackId, insertAtIndex):*
- Mutate: remove from source, insert in target, target's `activeCardId = cardId`, source's `activeCardId` may change (pick neighbor) or source may be removed. `activeStackId` may or may not change depending on call-site (if the user dragged the card, activeStackId typically follows to the target).
- `_setFirstResponder` reconciles.

*setActiveCardInStack(stackId, cardId) — the tab-bar click path:*
- Today (HEAD after 11.6.1a) this is a raw mutator with no lifecycle events. Under 11.6.1b it MUST route through `_setFirstResponder` when `stackId` is the deck's active stack (transition 2 from the Motivation list — tab-bar click in the active stack flips first responder). When `stackId` is NOT the deck's active stack, mutate `stack.activeCardId` and `notify()` only — no first-responder flip (transition 5b's sibling case).
- **Plan decision:** keep `setActiveCardInStack` as a distinct store method (not folded into `activateCard`). The two paths have different semantics — `activateCard` always makes `cardId` first responder (promotes its stack too); `setActiveCardInStack` does NOT promote the stack. The tab-bar click in an inactive stack's tab bar is a rare but real call site that must preserve this distinction.

*removeCard(stackId, cardId) / handleStackClosed(stackId):*
- If the removed card (or any card in the closed stack) is first responder, pick a new first responder (next card in the same stack, or first card in another stack, or null) and route through `_setFirstResponder(newFR)` BEFORE firing `cardWillBeginDestruction(cardId)`.
- Then: fire `cardWillBeginDestruction` on each card being destroyed, mutate state, `notify()`.
- `handleStackClosed` closes the entire stack (every card in it gets `cardWillBeginDestruction`); `removeCard` handles the per-card case and delegates to `handleStackClosed` when removing the last card would leave an empty stack.

*Cascade (Step 7) reconciliation:*
- App-resign/hide: cascade already deactivates the first responder. In the new model, it still works unchanged — it calls `cardWillDeactivate` / `cardDidDeactivate` on whatever card is currently first responder.
- App-foreground/unhide: reactivate the previously deactivated card via `_setFirstResponder(sameCardId)` — already idempotent per existing cascade logic.

*Tide card — consolidated delegate:*
```tsx
useCardDelegate(cardId, {
  cardDidActivate: () => entryDelegateRef.current?.focus(),
  cardWillDeactivate: () => entryDelegateRef.current?.blur(),
  cardDidMove: () => {
    if (!isFirstResponder(cardId)) return;
    entryDelegateRef.current?.focus();
  },
  cardDidResize: () => {
    if (!isFirstResponder(cardId)) return;
    entryDelegateRef.current?.focus();
  },
});
```
- `cardDidFinishConstruction` focus call is removed. Construction alone does not make a card first responder (the activate call that follows does). For the addCard-then-activate path, `cardDidActivate` fires after construction and drives focus.
- The `isFirstResponder(cardId)` check in `cardDidMove` / `cardDidResize` is `deckManagerStore.getFirstResponderCardId() === cardId` — new store method exposing the composite bit.

**Tests:**

*Transition coverage (one test per numbered transition from the Motivation list):*
- T-11-6-1b-01 — Click a card in an inactive stack → `willDeact(old)`, `willAct(new)`, `didDeact(old)`, `didAct(new)`.
- T-11-6-1b-02 — Click a tab in the active stack → same sequence, both cards in the same stack.
- T-11-6-1b-03 — Click a tab in an inactive stack → same sequence, stack switches AND tab switches.
- T-11-6-1b-04 — `addCard` → construction fires for new card, then full flip sequence.
- T-11-6-1b-05a — `addCardToStack` when stack IS active → construction fires, then first-responder flip from old-in-stack to new-in-stack.
- T-11-6-1b-05b — `addCardToStack` when stack is NOT active → construction fires, NO activate/deactivate events (new card is active-in-its-stack but not first responder).
- T-11-6-1b-06 — `detachCard` when moved card is already first responder → no activate/deactivate events.
- T-11-6-1b-06b — `detachCard` when moved card is NOT first responder → flip sequence to moved card.
- T-11-6-1b-07 — `moveCardToStack` to the active stack → flip sequence.
- T-11-6-1b-07b — `moveCardToStack` to an inactive stack → no flip.
- T-11-6-1b-08a — `removeCard` on the first responder when its stack has other cards → flip to a neighbor, then destruction fires.
- T-11-6-1b-08b — `removeCard` on the first responder when it is the sole card in the sole stack (triggers `handleStackClosed` internally) → flip to null, then destruction fires.
- T-11-6-1b-08c — `handleStackClosed` on the active stack with multiple cards → flip to the new top-of-deck stack's active card (or null), then destruction fires for every card in the closed stack.
- T-11-6-1b-09 — App resigns active → `cardWillDeactivate` / `cardDidDeactivate` on first responder; app becomes active → `cardWillActivate` / `cardDidActivate` on the same card.

*Regression test for the detach focus bug:*
- T-11-6-1b-detach-focus — construct a deck with tide (stack S1) and add Hello via `addCardToStack(S1, "hello")`. Assert `cardWillDeactivate(tide)` + `cardDidDeactivate(tide)` fired (prompt gets blurred). Call `detachCard(hello, { x: 200, y: 200 })`. Assert Hello's new stack is active, Hello is first responder; assert NO `cardDidActivate(tide)` fires (tide's stack is no longer the active stack). End state: tide's blur call stands; no re-focus side effect was issued.

**Verification:**
- `bun x tsc --noEmit` clean.
- `bun test` green (existing count from 11.6.1a + ~14 new).
- Manual verification for the detach focus bug (the motivating reproducer from 11.6.1a's Motivation):
  1. Open a tide card pointed at `/u/src/tugtool`.
  2. Developer > Add Tab to Active Card. → prompt caret stops blinking on tide (blur fired on add).
  3. Drag the Hello World tab out. → Hello is active with focused prompt area; tide's prompt is NOT blinking.
- Manual smoke for every transition from the Motivation list.
- Manual: app-hide (Cmd-H) / app-unhide — prompt blurs on hide, refocuses on unhide. (Regression check on Step 7 cascade.)
- Manual: app-background (click Finder) / app-foreground — same blur/refocus cycle.

**Note on scope:**
- This step removes the need for `knownPreviousActive` parameter on `activateCard` (the internal `_setFirstResponder` computes old first responder from current state). The parameter can be dropped from `IDeckManagerStore.activateCard` signature in this step, with the caller in `deck-canvas.tsx` (H-A6 fix) updated accordingly.
- This step does NOT introduce `cardDidBecomeVisible` / `cardDidBecomeHidden` events for cards that change active-in-stack status without first-responder flipping (transitions 05b, 07b, the source-stack side of 06 and 07). Those transitions are genuinely silent at the delegate layer. If a future card type (e.g., a chart) needs "I just became visible in my stack" as a hook, add a dedicated event then — do not speculate now.
- The construction focus call in tide-card.tsx is removed. The sequence for `addCard` (standalone) is: construction fires (TideCardBody mounts), then first-responder flips to the new card, then `cardDidActivate` fires (TideCardBody focuses). Construction-with-focus is no longer a coupled pair — two independent events, ordered by the store logic.
- Session restoration across reload — landed post-11.6.1b. `tugdeck/src/lib/tide-session-restore.ts` reads tugcast's persisted `{ tug_session_id, project_dir }` records from tugbank at startup and emits `spawn_session(mode=resume)` for each tide card in the layout. The existing `spawn_session_ok` handler populates `cardSessionBindingStore`, which flips the card from picker to bound body before the user sees it. Failure path (session genuinely gone) is handled by the pre-existing `useTideCardObserver` resume-failed path.
- **`focus-card` wire semantics** — landed post-11.6.1b (commit below). Swift now sends `focus-card` with `stackId: string` (previously `cardId` carrying a stack id, a naming holdover). TS handler reads `stackId`, looks up the stack, and activates its `activeCardId` through `_setFirstResponder` for the full flip sequence. The back-compat card-id fallback is dropped.

**Piece decomposition (four commits):**

*Piece 1 — Introduce `_setFirstResponder` and simplify `activateCard`.*
- Add private `_setFirstResponder(newFirstResponderCardId: string | null)` on `DeckManager`. Computes old from `(activeStack?.activeCardId) ?? null`; no-op if unchanged; otherwise fires `cardWillDeactivate(old)` → `cardWillActivate(new)` → commits the `activeStackId` / `activeCardId` mutation → `notify()` → `cardDidDeactivate(old)` → `cardDidActivate(new)`.
- Expose `getFirstResponderCardId(): string | null` on `IDeckManagerStore` (returns the composite bit).
- Route `activateCard` and `_closeStack` through `_setFirstResponder`. Drop `knownPreviousActive` parameter from `IDeckManagerStore.activateCard` and its caller at `deck-canvas.tsx:357` (restoration path becomes `activateCard(focusedCardId)`).
- Files: `tugdeck/src/deck-manager.ts`, `tugdeck/src/deck-manager-store.ts`, `tugdeck/src/components/chrome/deck-canvas.tsx`, mock stores in `__tests__/`.
- Verification: `bun x tsc --noEmit` clean; `bun test` green at existing count. No new behavior on other mutators yet — they still use the pre-11.6.1b paths.

*Piece 2 — Route every first-responder-flipping mutator through `_setFirstResponder`.*
- `addCardToStack`: after construction, call `_setFirstResponder(newCardId)` iff `stackId === activeStackId` (transition 5a). Else `notify()` only (transition 5b).
- `setActiveCardInStack(stackId, cardId)`: route through `_setFirstResponder(cardId)` iff `stackId === activeStackId` (transition 2). Else raw mutate + `notify()` (inactive-stack tab switch does not flip).
- `detachCard`: after the mutation that makes the new stack active, call `_setFirstResponder(cardId)` (no-op if `cardId` was already first responder — transition 6; fires otherwise — transition 6b).
- `moveCardToStack`: after the mutation, call `_setFirstResponder(cardId)` iff the target stack is/becomes the deck's active stack (transition 7). Else `notify()` only (transition 7b).
- `removeCard` / `handleStackClosed`: if any destroyed card is first responder, call `_setFirstResponder(newFR)` BEFORE firing `cardWillBeginDestruction`. Picks new FR: next card in same stack, else first card in the new top-of-deck stack, else `null`.
- Add transition tests T-11-6-1b-01 through T-11-6-1b-08c (covering every transition 1–8 and sub-case).
- Files: `tugdeck/src/deck-manager.ts`, `tugdeck/src/__tests__/deck-manager.test.ts`.
- Verification: `bun x tsc --noEmit` clean; `bun test` green with +12 new tests.

*Piece 3 — Consolidate tide-card delegate + cascade reconciliation + T-09.*
- `tide-card.tsx`: drop `cardDidFinishConstruction: () => focus()`. Keep `cardDidActivate: () => focus()` and `cardWillDeactivate: () => blur()` as the sole focus-management path. Replace the current `cardLifecycle?.getActiveCardId() !== cardId` guard in `cardDidMove` / `cardDidResize` with `store.getFirstResponderCardId() !== cardId` (the composite bit, not the per-stack active card).
- Cascade (Step 7) reconciliation: verify app-resign and app-foreground paths drive `_setFirstResponder` correctly (they already deactivate/reactivate the current first responder; verify idempotence under the new plumbing).
- Add T-11-6-1b-09 (app-resign/foreground fires will/did{de,}activate on first responder).
- Files: `tugdeck/src/components/tugways/cards/tide-card.tsx`, `tugdeck/src/lib/lifecycle-cascade.ts` (if any change needed; likely none), `tugdeck/src/__tests__/card-lifecycle.test.tsx`.
- Verification: `bun x tsc --noEmit` clean; `bun test` green with +1 new test. Manual: prompt focuses on activation, blurs on deactivation, stays put on same-stack neighbor tab-switches, refocuses on move/resize only when tide is first responder.

*Piece 4 — Detach-focus regression test + manual smoke + plan close.*
- Add T-11-6-1b-detach-focus (the motivating reproducer from 11.6.1a's Motivation): construct deck with tide, `addCardToStack` a Hello card, assert tide blurred; `detachCard(hello)`, assert Hello is first responder and tide did NOT re-focus.
- Execute manual verification checklist (prompt blur/focus behavior across all transitions from the Motivation list + app hide/background).
- Update step header status note with commit trail.
- Files: `tugdeck/src/__tests__/card-lifecycle.test.tsx`, `dash/tugplan-lifecycle-delegates.md`.
- Verification: `bun x tsc --noEmit` clean; `bun test` green with +1 new test. All manual smoke items pass.

**Rules for executing each piece:**
- Each piece lands as exactly one commit with a clear commit message.
- `bun x tsc --noEmit` and `bun test` must pass at HEAD of every piece before moving to the next.
- Do not edit files outside the piece's stated file list. If an unexpected file needs a change, pause and surface it before editing.
- Do not delete tests. If a test is meaningless under the new model, migrate it rather than remove it.
- If a piece grows substantially beyond its stated scope, STOP and re-scope; don't pile unrelated work into one commit.

**Status: complete (2026-04-20).** Manual smoke passed after the Piece 3 click-to-activate fix. Commit trail:
- Piece 1 — `_setFirstResponder` + `getFirstResponderCardId`: `ebe67dde`
- Piece 2 — route FR-flipping mutators through the flip helper: `1735adc8`
- Piece 3 — tide delegate consolidation + cascade retargeting: `e8968e33`
- Piece 3 fix-up — drop `focusCard` pre-call in `handleStackActivate` / gallery path (the pre-call pre-mutated `activeStackId`, causing `_setFirstResponder` to short-circuit on click-back-to-stack): `980b4945`

#### Step 11.6.5 — Close out H6–H11 + H-A7/A8/A9 residuals {#step-11-6-5}

**Motivation:** The reliability study's H1–H3 are resolved by Step 11. H4–H5 were resolved incidentally in the 2cdc5fa5 commit (Route addCard/removeCard through activation lifecycle). The remaining holes (H6, H7, H8/H-A9, H9, H10, H11) and three residuals from the 11.6 audit (H-A7, H-A8, H-A9) land in one coordinated cleanup step.

**Files:**
- `tugdeck/src/lib/card-lifecycle.ts`
- `tugdeck/src/lib/app-lifecycle.ts`
- `tugdeck/src/lib/lifecycle-cascade.ts`
- `tugdeck/src/action-dispatch.ts`
- `tugdeck/src/main.tsx` (or a new `globals.d.ts`)
- `tugdeck/src/deck-manager.ts` (applyLayout; possibly collapse docstring)
- `tugdeck/src/__tests__/deck-manager.test.ts`
- `tugdeck/src/__tests__/lifecycle-cascade.test.ts`

**Work:**

*H6 — `initActionDispatch`'s save-on-resign subscription has no dispose.*
- Change `initActionDispatch(connection, deck)` return type from `void` to `() => void`. The returned function disposes the `observeApplicationDidResignActive` subscription (and any other lifecycle subscriptions added later).
- `main.tsx` captures the returned disposer if a tear-down path ever needs it. Production doesn't call it; tests that reinitialize action-dispatch can.

*H7 — No test for DeckManager → cascade install/dispose.*
- Add a `deck-manager.test.ts` test: construct a DeckManager, fire `deck.appLifecycle.notifyApplicationWillResignActive()`, assert the cascade fires `cardWillDeactivate`/`cardDidDeactivate` on the active card. Call `deck.destroy()`. Fire the app event again, assert no cascade fires (subscriptions disposed).

*H8 / H-A9 — Cascade reactivation on destroyed card logs a phantom activation.*
- Add `hasConstructed(cardId: string): boolean` to `CardLifecycle` (delegates to the existing `constructedCards` Set).
- In `lifecycle-cascade.ts` `reactivateIfNeeded`: before firing `notifyCardWillActivate(cardId)`, check `cardLifecycle.hasConstructed(cardId)`. If false, clear `deactivatedByAppCardId` silently and log `[CardLifecycle] cascade from <trigger> → card <id> destroyed between deactivate and reactivate; skipping reactivation`.
- Test: cascade deactivates card A, then A is destroyed, then app foregrounds → cascade logs skip and does not fire activation.

*H9 — Early-launch will-events may be dropped.*
- Documentation-only. Add a banner comment at the top of `AppLifecycle` explaining: "App lifecycle events during startup (before the JS side has registered the `AppLifecycle` singleton via `DeckManager` construction) are best-effort; control frames dispatched before registration are dropped. Consumers should not rely on receiving every app event in the pre-mount window; the first post-mount `applicationDidBecomeActive` on user interaction recovers state."
- No code change.

*H10 — Step 9 logs are always-on.*
- Add a module-level `const LIFECYCLE_LOG: boolean` at the top of `card-lifecycle.ts`, `app-lifecycle.ts`, and `lifecycle-cascade.ts`. Default to `import.meta.env.DEV ?? false` (or an equivalent dev-mode check consistent with how tugdeck gates dev-only behavior elsewhere).
- Wrap every `console.log("[CardLifecycle] ...")` / `console.log("[AppLifecycle] ...")` call with `if (LIFECYCLE_LOG) ...`.
- Production builds default-off; dev builds default-on. Toggleable via a single boolean for manual investigation.

*H11 — `window.tugdeck` is a cast, not a typed global.*
- Add a `declare global { interface Window { tugdeck?: { saveState(): void; reconnect(): void }; } }` block in `main.tsx` (or extract to a new `tugdeck/src/globals.d.ts`).
- Replace the cast `(window as unknown as Record<string, unknown>).tugdeck = ...` with `window.tugdeck = { saveState: ..., reconnect: ... }`.

*H-A7 — `applyLayout` has zero lifecycle events.*
- `applyLayout` is test-only today. Decision: mark as **deprecated** with a JSDoc `@deprecated` tag and a comment pointing to a future diff-based replacement if a production need arises. No diff-based implementation for now — adding one risks introducing a parallel-to-`addCard`-and-`removeCard` event pipeline that could drift.

*H-A8 — Is collapse a resize?*
- Documentation-only. Add a JSDoc note on `_toggleCardCollapse` explaining: "Collapse/expand changes rendered geometry (via CardFrame's height override) but NOT the stored `CardState.size`. Per L06 (appearance via CSS/DOM), this is an appearance-zone transition, not a data-zone event. No `cardWillResize` / `cardDidResize` fires; consumers that want to react to collapse specifically should subscribe to the deck-manager store directly (collapse flips `CardState.collapsed`, which the store-subscriber sees)."
- No code change.

**Tests:**
- H6: `initActionDispatch` returns a disposer; calling it removes the subscription (manual: `deck.appLifecycle.notifyApplicationDidResignActive()` after dispose → `saveAndFlush` not called).
- H7: DeckManager → cascade install + destroy dispose test.
- H8: cascade reactivate of destroyed card → log + skip.
- H10: flip LIFECYCLE_LOG false → no console.log fires during lifecycle events.
- H11: TypeScript picks up `window.tugdeck.saveState()` as a known method.

**Verification:**
- `bun x tsc --noEmit` clean.
- `bun test` green (2232 + new).
- Manual: run the full card-switch / app-transition trace with `LIFECYCLE_LOG = false` — console is quiet.
- Manual: run with `LIFECYCLE_LOG = true` — console shows the full trace as before Step 9.

**Piece decomposition (four commits):**

*Piece 1 — Cascade subscription hygiene (H6 + H7 + H8/H-A9).*
- H6: change `initActionDispatch(connection, deck)` signature from `void` to `() => void`. The returned disposer unsubscribes the `observeApplicationDidResignActive` subscription. Production doesn't call it; tests that reinitialize can.
- H7: add a `deck-manager.test.ts` test covering DeckManager → cascade install/dispose: construct a DeckManager, fire `deck.appLifecycle.notifyApplicationWillResignActive()`, assert cascade fires; `deck.destroy()`, fire again, assert no cascade.
- H8 / H-A9: add `hasConstructed(cardId: string): boolean` to `CardLifecycle` (delegates to the existing `constructedCards` Set). In `lifecycle-cascade.ts` `reactivateIfNeeded`, check `cardLifecycle.hasConstructed(cardId)` before firing `notifyCardWillActivate`; if false, clear `deactivatedByAppCardId` silently and log `[CardLifecycle] cascade from <trigger> → card <id> destroyed between deactivate and reactivate; skipping reactivation`. Add a cascade test: deactivate A, destroy A, foreground → cascade logs skip, no activation.
- Files: `tugdeck/src/action-dispatch.ts`, `tugdeck/src/main.tsx`, `tugdeck/src/lib/card-lifecycle.ts`, `tugdeck/src/lib/lifecycle-cascade.ts`, `tugdeck/src/__tests__/deck-manager.test.ts`, `tugdeck/src/__tests__/lifecycle-cascade.test.ts`.
- Verification: `bun x tsc --noEmit` clean; `bun test` green with +2 new tests.

*Piece 2 — Dev-mode log gating (H10).*
- Add a module-level `const LIFECYCLE_LOG` constant at the top of `card-lifecycle.ts`, `app-lifecycle.ts`, and `lifecycle-cascade.ts`. Default to `import.meta.env.DEV ?? false` (or whatever dev-mode gate tugdeck uses elsewhere).
- Wrap every `console.log("[CardLifecycle] ...")` / `console.log("[AppLifecycle] ...")` call with `if (LIFECYCLE_LOG) ...`.
- Add a test that flips the gate to `false` and asserts no `console.log` fires during a lifecycle event sequence.
- Files: `tugdeck/src/lib/card-lifecycle.ts`, `tugdeck/src/lib/app-lifecycle.ts`, `tugdeck/src/lib/lifecycle-cascade.ts`, one test file.
- Verification: `bun x tsc --noEmit` clean; `bun test` green with +1 new test. Manual: dev build shows the full trace; prod build is quiet.

*Piece 3 — Typed `window.tugdeck` global (H11).*
- Add a `declare global { interface Window { tugdeck?: { saveState(): void; reconnect(): void }; } }` block — in `main.tsx` directly, or extract to a new `tugdeck/src/globals.d.ts`.
- Replace the cast `(window as unknown as Record<string, unknown>).tugdeck = ...` in `main.tsx:184` with `window.tugdeck = { saveState: ..., reconnect: ... }`.
- Files: `tugdeck/src/main.tsx` (and optionally `tugdeck/src/globals.d.ts`).
- Verification: `bun x tsc --noEmit` clean (the typed assignment compiles without `as unknown`).

*Piece 4 — Documentation bundle (H9 + H-A7 + H-A8).*
- H9: add a banner comment at the top of `AppLifecycle` explaining: "App lifecycle events during startup (before the JS side has registered the `AppLifecycle` singleton via `DeckManager` construction) are best-effort; control frames dispatched before registration are dropped. Consumers should not rely on receiving every app event in the pre-mount window; the first post-mount `applicationDidBecomeActive` on user interaction recovers state." No code change.
- H-A7: add a JSDoc `@deprecated` tag on `applyLayout` (deck-manager.ts:1498) pointing to a future diff-based replacement if a production need arises. No diff-based implementation for now.
- H-A8: add a JSDoc note on `_toggleStackCollapse` (deck-manager.ts:1344) explaining: "Collapse/expand changes rendered geometry (via CardFrame's height override) but NOT the stored `CardState.size`. Per L06 (appearance via CSS/DOM), this is an appearance-zone transition, not a data-zone event. No `cardWillResize` / `cardDidResize` fires; consumers that want to react to collapse specifically should subscribe to the deck-manager store directly (collapse flips `CardState.collapsed`, which the store-subscriber sees)."
- Files: `tugdeck/src/lib/app-lifecycle.ts`, `tugdeck/src/deck-manager.ts`.
- Verification: `bun x tsc --noEmit` clean; `bun test` green (no new tests — documentation only).

**Rules for executing each piece:**
- Each piece lands as exactly one commit with a clear commit message.
- `bun x tsc --noEmit` and `bun test` must pass at HEAD of every piece before moving to the next.
- Do not edit files outside the piece's stated file list. If an unexpected file needs a change, pause and surface it before editing.
- If a piece grows substantially beyond its stated scope, STOP and re-scope; don't pile unrelated work into one commit.

**Status: complete (2026-04-20).** Commit trail:
- Piece 1 — cascade subscription hygiene (H6 + H7 + H8/H-A9): `08c4bc95`
- Piece 2 — dev-mode log gating (H10): `2e56bc24`
- Piece 3 — typed `window.tugdeck` (H11): `f32ef81a`
- Piece 4 — documentation bundle (H9 + H-A7 + H-A8): [this commit]

**Note on scope:** This is a hygiene / polish / documentation sweep. No behavior changes on the happy path. Closes out every hole flagged by the reliability study except H1–H5 (already closed) and the standing behavior of H-A7 (deprecated, not deleted).

#### Step 12 — Tuglaws walkthrough and plan close {#step-12}

**Files:**
- `dash/tugplan-lifecycle-delegates.md` (add a Tuglaws Walkthrough section at the end; flip status to `complete`)

**Work:**
- Verify every delegate subscription installs in `useLayoutEffect` (L03).
- Verify no external-state value re-enters React via `useState` + manual sync (L02) — the delegate hooks use `setState` for scheduling, not for state representation.
- Verify focus ring / caret blink is CSS/DOM-driven, not React state (L06).
- Verify delegate callbacks read current state via refs, not closures (L07).
- Verify store observers drive DOM writes directly, not through React's render cycle (L22).
- Record the walkthrough in this plan file.

**Verification:**
- Walkthrough section in the plan file names each law and the code location that satisfies it.
- Full build matrix green: `bun run check`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run`.

**Status: complete (2026-04-20).** See the Tuglaws Walkthrough below. Build matrix green at HEAD: `bun run check` (tsc) clean, `bun test` 2292/2292 pass, `bun run audit:tokens lint` zero violations, `cargo nextest run` 1146/1146 pass.

---

### Tuglaws Walkthrough {#tuglaws-walkthrough}

Post-implementation conformance check against the Tuglaws this plan explicitly targets. Each law names the code location that satisfies it and the behavior being anchored.

**L02 — External state enters React through `useSyncExternalStore` only.**

The lifecycle delegate hooks do NOT mirror lifecycle events into React state. `useCardDelegate` (`tugdeck/src/lib/card-lifecycle.ts:683`) and `useAppDelegate` (`tugdeck/src/lib/app-lifecycle.ts:320`) subscribe via `cardLifecycle.observe*` / `appLifecycle.observe*` and enqueue user callbacks through a module-level `MessageChannel` drain queue (`tugdeck/src/lib/card-lifecycle.ts:616–650`). No `setState` is called to represent "did this event fire yet" — delegate invocation is a side effect, not a rendered value. The decision to use `MessageChannel` over `setState → useEffect` is documented at `card-lifecycle.ts:616`.

Deck store consumers (`useDeckManager` + `useSyncExternalStore` on `IDeckManagerStore.subscribe` / `getSnapshot`) remain the sole route for external deck state into React — unchanged from pre-plan.

**L03 — Use `useLayoutEffect` for registrations that events depend on.**

Every delegate subscription installs in `useLayoutEffect`:
- `useCardDelegate` subscription: `tugdeck/src/lib/card-lifecycle.ts:693`.
- `useCardDelegate` delegate-ref sync (for L07 below): `tugdeck/src/lib/card-lifecycle.ts:689`.
- `useAppDelegate` subscription: `tugdeck/src/lib/app-lifecycle.ts:326`.
- `useAppDelegate` delegate-ref sync: `tugdeck/src/lib/app-lifecycle.ts:330`.
- `CardPortal` slot attachment (content registry subscription): `tugdeck/src/components/chrome/card-portal.tsx:59`.

Each of these runs before the browser paints the commit so that event handlers exist before any dispatched event can observe them.

**L06 — Appearance changes go through CSS and DOM, never React state.**

- Tide prompt focus/blur (`tugdeck/src/components/tugways/cards/tide-card.tsx:842–843`): `cardDidActivate` calls `entryDelegateRef.current?.focus()`, `cardWillDeactivate` calls `entryDelegateRef.current?.blur()`. Direct DOM invocation on the editor ref — no `setState`, no `useState`.
- Selection guard inactive-card highlights (`tugdeck/src/components/tugways/selection-guard.ts:187–221`): CSS Custom Highlight API. The store observation drives `Highlight.add/delete` calls directly, not React state.
- Stack collapse (`tugdeck/src/deck-manager.ts:_toggleStackCollapse`): flips `CardState.collapsed` in the store; `CardFrame` reads the flag and overrides rendered height via CSS. No React state mirrors the collapse bit; the JSDoc at the method explicitly pins this as an appearance-zone transition and notes that no `cardWillResize` / `cardDidResize` fires.

**L07 — Delegate callbacks read current state via refs, not closures.**

Both lifecycle hooks keep the user-provided delegate object in a ref and re-read at fire time:
- `useCardDelegate`: `delegateRef = useRef(delegate)` at `card-lifecycle.ts:688` plus a `useLayoutEffect` at `:689` that keeps the ref current. The enqueue closure at `:700` dispatches with `delegateRef.current[method]`, so a caller passing an inline object on every render gets the latest handler without re-subscribing.
- `useAppDelegate`: same pattern at `app-lifecycle.ts:325–331`.

This also means the delegate-ref sync fires before subscribers re-run, guaranteeing observers see the newest handlers (L03 + L07 pair).

**L22 — Store observers drive DOM writes directly, not through React's render cycle.**

- Card content registry (`tugdeck/src/components/chrome/card-content-registry.ts:22`) self-documents as appearance-zone infrastructure outside the React render tree. It's a module-level `Map<stackId, HTMLDivElement>` with a subscriber set.
- `CardPortal` (`tugdeck/src/components/chrome/card-portal.tsx`) subscribes to registry changes and re-parents its slot with `host.appendChild(slot)` on every host change. Identity-preserving DOM move, no React re-render.
- Lifecycle-cascade (`tugdeck/src/lib/lifecycle-cascade.ts`) fires `cardLifecycle.notifyCard*` on app hide/unhide; tide-card's delegate (L06 above) resolves this to direct `focus()`/`blur()` DOM calls. Zero React state mutations participate in the cascade-to-focus path.

---

### Open Questions {#open-questions}

*(All plan-authoring open questions have been resolved — see D1–D10. This section is preserved for questions that surface during implementation.)*

---
