/**
 * ResponderChainManager -- tugways responder chain infrastructure.
 *
 * A plain TypeScript class (outside React state) that manages the responder
 * chain tree: registration, first-responder tracking, action dispatch, and
 * two-level action validation.
 *
 * Also exports ResponderChainContext so both use-responder.ts and
 * responder-chain-provider.tsx can import it without circular dependencies.
 *
 * [D01] Plain TypeScript class outside React state
 * [D05] Two-level action validation (canHandle + validateAction)
 *
 * ## INVARIANTS (per `tugplan-dev-overlay-framework.md` [D04])
 *
 * Six contracts the chain guarantees. Each is asserted by a test in
 * `tugdeck/src/__tests__/responder-chain-invariants.test.ts`. Reviewers
 * touching the chain should verify whether their change preserves
 * each invariant; tests are the load-bearing assertion.
 *
 *   I1. Every registered responder's `parentId` is either `null` or the
 *       id of another registered responder (at registration time). The
 *       chain does NOT enforce this — it is a caller contract. The walk
 *       semantics (#i1-test) tolerate a stale parentId by stopping at
 *       the dangling reference (no infinite loop, no crash).
 *
 *   I2. `firstResponderId` is `null` OR the id of a currently registered
 *       responder. Maintained by `unregister`'s DOM-walk fallback that
 *       promotes the nearest still-registered ancestor when the current
 *       first responder is removed; never leaves a dangling id.
 *
 *   I3. `sendToTarget(id, ...)` walks `parentId` from `id`, regardless
 *       of `firstResponderId` state. Never a no-op because the first
 *       responder is unexpected. (This is the contract that fixed the
 *       Step 3 cancel-cascade bug — see `tugplan-dev-overlay-framework.md`
 *       (#sheet-cascade-rationale).)
 *
 *   I4. `findResponderForTarget(node)` walks DOM `parentElement` from
 *       `node`, returning the id of the nearest *registered* responder
 *       along the rendered DOM path, or `null` if none exists. This is
 *       the DOM-walk axis of (#mental-model)'s [D03] dual-walk policy:
 *       different by design from `walkFromNode`, which walks `parentId`
 *       through the registry.
 *
 *   I5. A modal that captures a `cascadeTargetId` at open time can
 *       dispatch to that target on close even when there is no DOM-walk
 *       path between the modal's portaled DOM and the target. The two
 *       walks (DOM vs. parentId) serve different purposes per [D03];
 *       cascade dispatches must use the parentId-walking variant
 *       (`sendToTarget`) so they are independent of DOM ancestry.
 *
 *   I6. `data-tug-focus="refuse"` controls only chain-promotion-skip and
 *       browser-focus-prevention semantics (button-class behavior, in
 *       `responder-chain-provider.tsx`). It does NOT control
 *       pane-focus-controller activation/deselect — that subsystem keys
 *       on `[data-slot="tug-canvas-overlay-root"]` (per [D01]). One
 *       attribute, one semantic; do not overload.
 *
 * The mental model the framework operates within — five subsystems
 * (portals, responder chain, focus events, pane focus controller, focus-
 * discipline markers) and their interactions — is documented in
 * `tugplan-dev-overlay-framework.md` (#mental-model). Read it before
 * proposing chain-touching changes.
 */

import { createContext } from "react";
import type { TugAction } from "./action-vocabulary";
import type { KeyBinding } from "./keybinding-map";
import { chordMatchesEvent } from "./chord-format";

export type { TugAction, GalleryAction } from "./action-vocabulary";

// ---- ActionPhase and ActionEvent ----

/**
 * Five-phase action lifecycle.
 *
 * - `discrete`: one-shot action (button click, menu selection)
 * - `begin`:    start of a continuous interaction (scrub start, drag start)
 * - `change`:   intermediate update during a continuous interaction
 * - `commit`:   end of a continuous interaction with final value
 * - `cancel`:   continuous interaction cancelled (no value change committed)
 *
 * [D01] ActionEvent is the sole dispatch currency
 * (#s01-action-event-type)
 */
export type ActionPhase = "discrete" | "begin" | "change" | "commit" | "cancel";

/**
 * How long `data-pressing="true"` stays on a button activated by Return
 * through the default-button stack. Long enough to read as a "click" without
 * lingering; CSS treats `[data-pressing="true"]` as a stand-in for `:active`.
 *
 * It lives beside the stack rather than beside either presser because there
 * are two — the chain's own bubble-phase activation and the text substrate's
 * Return, which must look identical — and a press visual that differs by
 * which one fired is a difference the user can see.
 */
export const DEFAULT_BUTTON_PRESS_MS = 120;

// ---- ResponderKind ----

/**
 * Tier tag for responder nodes. A typed string-union enum so misspellings
 * are compile errors and adding a new tier (e.g. `"panel"`) is reviewed
 * at one location.
 *
 * Used by `getKeyResponderOfKind` to walk up the chain looking for the
 * nearest ancestor of a given tier — the mechanism that gives us a
 * stable "active card" identity without storing one. See
 * design doc for the design.
 *
 * Initial members:
 * - `"card"` — top-level card responders (TugCard).
 *
 * New members are added here and consumed by `useResponder` callers
 * that pass `kind`. The default `kind === undefined` is the "untagged"
 * case — most responders are untagged (text inputs, sliders, popups);
 * only tier-defining nodes opt in.
 */
export type ResponderKind = "card" | "card-content";

/**
 * Typed action event -- the sole dispatch currency.
 *
 * All dispatch call sites produce an ActionEvent. All action handlers receive
 * a full ActionEvent, even for discrete (button click) actions.
 *
 * [D01] ActionEvent is the sole dispatch currency
 * [D02] Handler signature is (event: ActionEvent) => void | (() => void)
 * (#s01-action-event-type)
 */
export interface ActionEvent<Extra extends string = never> {
  /**
   * Semantic action name from the TugAction vocabulary.
   * See action-vocabulary.ts for the complete list and payload
   * conventions. Misspellings are compile errors.
   *
   * The `Extra` type parameter lets non-production consumers
   * (galleries, demos) extend the vocabulary without polluting the
   * default. Defaults to `never` — bare `ActionEvent` is the
   * production form.
   */
  action: TugAction<Extra>;
  /** The control that initiated the event (ref or instance). Optional. */
  sender?: unknown;
  /** Typed payload (color, number, point, etc.). Optional for discrete actions. */
  value?: unknown;
  /** Lifecycle phase. Use "discrete" for one-shot actions (button clicks, menu selections). */
  phase: ActionPhase;
}

/**
 * Return type of an action handler.
 *
 * Handlers may return:
 * - `void` — the handler's work is complete. Standard case.
 * - `() => void` — a "continuation" callback that the caller may invoke
 *   at a later commit point (e.g., after a menu activation blink
 *   finishes). The sync portion of the handler (e.g., a user-gesture-bound
 *   clipboard write) runs inline; the deferred portion (e.g., mutating
 *   the document after visual feedback) runs from the continuation.
 *
 * Callers that need the continuation use the `ForContinuation` variants.
 * `sendToFirstResponder` / `sendToTarget` discard it and just report
 * handled/unhandled.
 *
 * [D02] Two-phase action handling via optional continuation
 */
export type ActionHandlerResult = void | (() => void);

/**
 * Action handler signature — receives the event, optionally returns a
 * continuation. Generic on the same `Extra` parameter as `ActionEvent`
 * so gallery consumers can type their handlers with opt-in extras.
 */
export type ActionHandler<Extra extends string = never> = (
  event: ActionEvent<Extra>,
) => ActionHandlerResult;

// ---- ResponderNode interface ----

/**
 * A node in the responder chain tree.
 *
 * Each node has a unique ID, an optional parent link, a map of action
 * handlers, and optional validation functions.
 *
 * The `actions` map is the primary mechanism for dispatch. Any action that
 * should be dispatchable MUST have an entry in the actions map. The optional
 * `canHandle` function is an advisory override for cases where the set of
 * handleable actions is not statically known (e.g., a card delegating to a
 * child). It is only consulted by the canHandle() validation query -- never
 * by dispatch().
 *
 * [D02] Handler signature is (event: ActionEvent) => void
 * (#s04-responder-node-actions)
 */
export interface ResponderNode<Extra extends string = never> {
  id: string;
  parentId: string | null;
  /**
   * Partial map of TugAction names to handlers. A responder registers
   * handlers for only the subset of actions it cares about; other
   * actions walk past it in the chain. Generic on `Extra` so galleries
   * can register handlers for opt-in action names.
   */
  actions: Partial<Record<TugAction<Extra>, ActionHandler<Extra>>>;
  /**
   * Advisory capability override for validation queries only.
   * dispatch() never consults this -- only canHandle() and validateAction()
   * queries do. Use for runtime-determined capabilities not in the actions map.
   */
  canHandle?: (action: TugAction<Extra>) => boolean;
  validateAction?: (action: TugAction<Extra>) => boolean;
  /**
   * Optional display-state hook, the sibling of `validateAction`. Answers
   * the action's current *state* rather than its availability: a boolean
   * for a checkmark or toggle, a string for a value a caller narrows
   * itself (the current permission mode, the current composer route).
   *
   * Walked exactly like `validateAction` — the first node that handles the
   * action terminates the walk and answers. `undefined` means "no state to
   * show". Never consulted during dispatch.
   */
  queryActionState?: (action: TugAction<Extra>) => boolean | string | undefined;
  /**
   * Optional tier tag. Consumed by `getKeyResponderOfKind` to find the
   * nearest ancestor of a given tier from the current first responder.
   * Untagged responders are skipped during the walk. Most responders
   * are untagged; only tier-defining nodes (cards) opt in.
   */
  kind?: ResponderKind;
  /**
   * Optional substrate-supplied focus callback.
   *
   * Invoked by `manager.focusResponder(id)` AFTER `makeFirstResponder(id)`
   * runs. Substrates with a non-trivial focus surface (CodeMirror's
   * `view.focus()`, future custom editors with shadow-DOM hosts or
   * contenteditable invariants) provide this callback so chain-driven
   * focus restoration lands DOM focus on the correct element without
   * the chain having to special-case those substrates.
   *
   * If absent, `focusResponder` falls back to a DOM walk: queries
   * `document.querySelector('[data-responder-id="<id>"]')` and focuses
   * either the responder's own element (if focusable) or the first
   * tabbable descendant. Generic responders (text inputs, buttons,
   * generic containers) omit the callback and the DOM walk Just Works.
   *
   * Per `tugplan-session-popup-bindings.md` [D03] (#focus-contract). The
   * callback is captured at registration; like `canHandle` /
   * `validateAction` / `kind`, it is a structural property of the
   * responder's identity. Changing it mid-life would require
   * re-registration.
   */
  focus?: () => void;
}

// ---- ResponderChainManager ----

/**
 * Manages the responder chain tree.
 *
 * Instantiated once per ResponderChainProvider and provided via
 * ResponderChainContext as a stable reference (never replaced).
 *
 * Maintains a validationVersion counter that increments on any structural
 * change so useSyncExternalStore subscribers know to re-check.
 */
/**
 * Result of the ForContinuation dispatch methods — whether the event was handled and,
 * if the handler returned a continuation callback, that callback.
 */
export interface DispatchResult {
  /** True if a responder's actions map contained a matching handler. */
  handled: boolean;
  /**
   * Optional continuation returned by the handler. Callers that need
   * two-phase execution (e.g., a menu that plays a blink after the sync
   * phase and wants the visible side effect to run after) invoke this
   * at their commit point.
   */
  continuation?: () => void;
}

/**
 * Signature of a dispatch observer. Fires after every call to dispatch,
 * sendToFirstResponder, sendToTarget, or their ForContinuation siblings — whether or not a handler
 * matched. `handled` reflects the final outcome. Use for components that
 * need to react to chain traffic (e.g. a context menu that closes on
 * any external action).
 */
export type DispatchObserver = (event: ActionEvent, handled: boolean) => void;

/**
 * Signature of a key-responder observer. Fires after any chain change
 * (register, unregister, first-responder change) when, *and only when*,
 * the derived `getKeyResponderOfKind(kind)` value differs from the
 * value seen at the previous notification. Initial subscription does
 * not fire — callers read the current value via
 * `getKeyResponderOfKind` synchronously after subscribing.
 */
export type KeyResponderObserver = (responderId: string | null) => void;

/**
 * A live source of dynamic keybindings for one scope, read at resolve time so a
 * component's current-render bindings are always seen without re-registering
 * (the same live-read pattern `useResponder` uses for its actions map). A scope
 * is an opaque id — a responder id (responder-scoped) or a focus-mode id
 * (mode-local); the registry never interprets it. See [P11] / [#keybinding-registry].
 */
export type KeybindingSource = () => readonly KeyBinding[];

/** Which kind of context a scoped binding was registered under. */
export type KeybindingScopeKind = "responder" | "mode";

/**
 * A registered binding paired with the scope it lives under — a responder
 * id, or a focus-mode id. What `activeKeybindings` answers, because a
 * binding without its scope cannot be placed in a resolution order.
 *
 * The `kind` is recorded at registration rather than inferred from the id:
 * a responder id and a mode id are both opaque strings, and guessing which
 * one a scope is would put the two resolution layers in the wrong order
 * exactly when a floating surface is open.
 */
export interface ScopedKeyBinding {
  readonly scopeId: string;
  readonly kind: KeybindingScopeKind;
  readonly binding: KeyBinding;
}

/**
 * A live scoped binding, with its distance from the innermost claimant.
 *
 * `depth` 0 is whatever `resolveKeybinding` would consult first — the
 * current focus mode when one is pushed, otherwise the first responder —
 * and each step outward adds one. It is the sort key a shadowing view
 * orders the JS layers by, and it is computed here because the chain is the
 * only thing that knows the walk.
 */
export interface LiveKeyBinding extends ScopedKeyBinding {
  readonly depth: number;
}

/**
 * Internal subscription record for `observeKeyResponder`. Stores the
 * tier the observer is interested in, the callback to invoke, and the
 * last value the observer was notified about so we can dedupe to
 * "fires only when the derived value changes."
 */
interface KeyResponderSubscription {
  kind: ResponderKind;
  callback: KeyResponderObserver;
  lastValue: string | null;
}

/**
 * Internal helper: look up an action handler on a stored responder
 * node. Accepts a `TugAction<Extra>` (widened by the caller) and
 * narrows to the stored node's key type via a single localized cast.
 *
 * Rationale: `ResponderNode.actions` is typed against `TugAction`
 * (the default `never` form), but the manager's public dispatch and
 * query methods accept `TugAction<Extra>` so gallery and test
 * consumers can register opt-in action names. At runtime every
 * action is just a string, and the stored function object only ever
 * receives events whose action matches the key it was registered
 * under — so the variance mismatch is soundness at runtime, and the
 * cast is the minimum amount of type-system escape needed to bridge
 * the generic public API to the non-generic internal storage.
 */
function lookupHandler(
  node: ResponderNode,
  action: string,
): ActionHandler | undefined {
  return node.actions[action as TugAction];
}

/**
 * Whether `candidate` is the control an Enter-family keystroke belongs to
 * ([#chord-ring]).
 *
 * A button that declares a chord is fired by that chord and by nothing else —
 * the declaration is what its dashed ring states. The converse is the half that
 * was missing and that the 2026-09-12 join report was made of: a button
 * declaring NO chord answers to the plain Return alone, and must not swallow
 * somebody else's. The Changes shade's `Resolve` — `xs`, `primary`, chordless —
 * registered above the composer's Z5, and a `⇧⏎` aimed at the Z5's own ring
 * pressed Resolve instead and returned. Silently: a press that went somewhere
 * leaves nothing behind to say it went to the wrong place.
 *
 * The match is EXCLUSIVE, the same rule `chordMatchesEvent` applies to every
 * other binding: `⇧⏎` fires a `shift` wearer, and plain `⏎` and `⌘⇧⏎` do not.
 * Shared so the pipeline's Stage 2 and the editor's own submit — the two places
 * a default button is ever activated — cannot disagree about whose key it is.
 */
export function defaultButtonAnswersChord(
  candidate: Element,
  event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean },
): boolean {
  const wantsShift = candidate.getAttribute("data-default-chord") === "shift";
  return (
    event.shiftKey === wantsShift &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  );
}

/**
 * The card a surface belongs to, or `null` for one that belongs to no card —
 * a pane-level sheet, which portals into the pane frame rather than into any
 * card's root, and whose default button every card in the pane may press.
 */
const CARD_HOST_SELECTOR = "[data-card-host]";

/**
 * Whether a stacked default button is actually on screen.
 *
 * Registration is a mount-time act ([L03]) and CSS can hide a mounted button
 * afterwards — the composer's `+` queue button is `display: none` until the
 * editor holds a draft, and an inactive card in a tab stack is `display: none`
 * whole. A hidden button that stays on the stack is the worst kind of Return
 * home: the ring paints somewhere else, the key goes here, and the press does
 * nothing anybody can see. So the peek skips what is not rendered, and the
 * button under it — the visible one — answers instead.
 *
 * `checkVisibility` is the exact question; jsdom-ish test DOMs may not have it,
 * and there a connected element counts as rendered.
 */
function isRenderedDefaultButton(button: HTMLButtonElement): boolean {
  if (!button.isConnected) return false;
  if (typeof button.checkVisibility !== "function") return true;
  return button.checkVisibility();
}

/**
 * Whether `button` is one that a `Return` originating at `origin` may press.
 *
 * Two surfaces can hold a default button at once and only one of them is the
 * user's: a pane's tab stack keeps EVERY card mounted, hiding the inactive
 * ones with `display: none` (`card-host.tsx`), and each Session card's Z5
 * re-registers whenever its submit mode flips — so the pane's topmost default
 * is routinely a button on a card that is not even on screen. The rule is
 * therefore about cards, not panes: a button inside a card answers only to
 * that card, while a button in no card (a pane-level sheet — a shade portals
 * into the pane frame, never into the card root) answers to the whole pane.
 */
function defaultButtonAnswersTo(
  button: HTMLButtonElement,
  originCard: Element | null,
): boolean {
  // Origin in no card — a pane-level sheet, the gallery. There is no card to
  // hold a button to, so the pane is the whole scope, exactly as it was.
  if (originCard === null) return true;
  const buttonCard = button.closest(CARD_HOST_SELECTOR);
  return buttonCard === null || buttonCard === originCard;
}

/**
 * Whether the chain debug logs are enabled. Reads
 * `window.__tugChainDebug` at call time so devtools toggles take
 * effect immediately without a reload. Default: off.
 *
 * ```
 * window.__tugChainDebug = true;   // enable
 * window.__tugChainDebug = false;  // silence
 * ```
 */
function isChainDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return (window as unknown as { __tugChainDebug?: boolean }).__tugChainDebug === true;
}

export class ResponderChainManager {
  // Internal storage uses the default `ResponderNode` (i.e.
  // `ResponderNode<never>`) — the narrowest, production-only form.
  // Gallery consumers that register with an `Extra` type parameter
  // widen at the `register` boundary via an `as unknown as` assertion.
  // The assertion is sound at runtime because the manager treats
  // action names as opaque strings: it only indexes `node.actions` by
  // `event.action` and passes the event back to the same function
  // object that was registered for that key, so the handler always
  // receives the exact event shape it was written against.
  //
  // TypeScript's variance rules forbid a direct structural widening
  // (ActionHandler is contravariant in its event parameter), hence
  // the one `as unknown as` cast inside `register`. The escape hatch
  // is confined to that single call site; every other method below
  // operates on `ResponderNode<never>` safely, because the extras
  // that gallery consumers add are only visible through their own
  // generic API — the manager never constructs new ActionEvents on
  // their behalf.
  private nodes: Map<string, ResponderNode> = new Map();
  private firstResponderId: string | null = null;
  private validationVersion = 0;
  private subscribers: Set<() => void> = new Set();
  private dispatchObservers: Set<DispatchObserver> = new Set();
  private keyResponderSubscriptions: Set<KeyResponderSubscription> = new Set();
  private defaultButtonStack: HTMLButtonElement[] = [];
  // Dynamic, context-scoped keybindings ([P11]): scope id → live sources. A
  // scope is a responder id or a focus-mode id; resolution checks the active
  // focus mode then the first-responder parentId walk, innermost-first.
  private keybindingSources: Map<string, Set<KeybindingSource>> = new Map();
  /** What each registered scope id is — a responder, or a focus mode. */
  private keybindingScopeKinds: Map<string, KeybindingScopeKind> = new Map();

  // ---- Registration ----

  /**
   * Register a responder node.
   *
   * Auto-first-responder for root nodes: if the node's parentId is null and
   * firstResponderId is currently null, this root node becomes the first
   * responder automatically. Increments validationVersion and notifies
   * subscribers in that case.
   */
  register<Extra extends string = never>(node: ResponderNode<Extra>): void {
    // Widen to `ResponderNode<never>` for internal storage. See the
    // comment on `private nodes` for why this cast is sound at runtime.
    this.nodes.set(node.id, node as unknown as ResponderNode);
    if (node.parentId === null && this.firstResponderId === null) {
      this.firstResponderId = node.id;
      this.syncFirstResponderDomAttribute();
      this.incrementAndNotify();
    }
  }

  /**
   * Unregister a responder node.
   *
   * If the removed node was the first responder, auto-promotes the
   * nearest still-registered ancestor to first responder. The lookup
   * walks the unregistering node's DOM ancestors via
   * `findResponderForTarget`, which is robust against the order in
   * which sibling effect cleanups run during a tree unmount.
   *
   * Why DOM walk instead of `node.parentId`:
   *
   * React useLayoutEffect cleanup order during a multi-level unmount is
   * not strictly child-to-parent. A wrapping responder's effect cleanup
   * can run BEFORE the cleanup of a responder it nests — concretely,
   * when a gallery card uses `useResponderForm` to wrap a
   * `tug-prompt-input`, switching tabs unmounts the form responder
   * before the prompt input. By the time the prompt input's cleanup
   * fires, its captured `parentId` (the form responder's id) is no
   * longer in `nodes`, so the previous one-level promotion would set
   * `firstResponderId = null`. Subsequent dispatches start from null
   * and walk nothing — every keyboard shortcut becomes a no-op until
   * the next click promotes a new first responder. (Symptom in the
   * field: ⇧⌘[ / ⇧⌘] tab navigation got "stuck" the first time the
   * user passed through a tab containing such a nested form responder.)
   *
   * The DOM is the truth source during cleanup: React runs effect
   * cleanups before removing DOM nodes, so the unregistering node's
   * element and its ancestors are all still in the document.
   * `findResponderForTarget` walks DOM parents looking for
   * `data-responder-id` whose value IS in `this.nodes` — it naturally
   * skips ancestors that have already unregistered in the same
   * cleanup pass and stops at the nearest one that's still alive.
   *
   * Falls back to the captured `parentId` when there is no document
   * (jsdom-less unit tests) or when the unregistering element is
   * already detached.
   */
  unregister(id: string): void {
    const node = this.nodes.get(id);
    this.nodes.delete(id);

    if (this.firstResponderId === id) {
      let nextFirst: string | null = null;

      if (typeof document !== "undefined") {
        const escapedId =
          typeof CSS !== "undefined" && typeof CSS.escape === "function"
            ? CSS.escape(id)
            : id;
        const el = document.querySelector(`[data-responder-id="${escapedId}"]`);
        if (el && el.parentElement) {
          nextFirst = this.findResponderForTarget(el.parentElement);
        }
      }

      if (
        nextFirst === null &&
        node &&
        node.parentId !== null &&
        this.nodes.has(node.parentId)
      ) {
        nextFirst = node.parentId;
      }

      // Last-resort fallback: if neither the DOM walk nor the
      // captured parentId yields a still-registered ancestor, but a
      // root responder (parentId === null) is registered, promote it.
      // This is the symmetric counterpart of `register()`'s "auto-
      // promote on first registration when firstResponder is null"
      // branch — same invariant, applied at unregister time:
      //
      //   *while at least one root responder is registered, the
      //   chain has a first responder.*
      //
      // Without this rule, a multi-step cascade (e.g. close a multi-
      // tab pane in one render — cards unregister, then pane
      // unregisters, then a portaled popover unmounts somewhere in
      // between) can land `firstResponderId` on `null` even though
      // the root (typically `deck-canvas`) is still alive. Subsequent
      // `sendToFirstResponder` walks from null and silently no-ops —
      // breaking menu items / keyboard shortcuts / control-frame
      // actions that rely on the root's last-resort handlers ([D08]).
      if (nextFirst === null) {
        nextFirst = this.findRootResponderId();
      }

      this.firstResponderId = nextFirst;
      this.syncFirstResponderDomAttribute();
      this.incrementAndNotify();
    }
  }

  /**
   * Whether `id`'s CHAIN ancestry (the `parentId` walk, `id` itself
   * included) passes through `ancestorId`. This is registry containment —
   * the dispatch-side notion of "within" — NOT DOM containment: a surface
   * portaled outside a card's DOM subtree but chain-parented into it (a
   * pane-modal sheet) is within by this test, which is what the
   * first-responder reconciler needs so it never steals from a modal
   * surface legitimately holding first responder.
   */
  nodeIsWithin(id: string, ancestorId: string): boolean {
    let cursor: string | null = id;
    const seen = new Set<string>();
    while (cursor !== null && !seen.has(cursor)) {
      if (cursor === ancestorId) return true;
      seen.add(cursor);
      cursor = this.nodes.get(cursor)?.parentId ?? null;
    }
    return false;
  }

  /**
   * Return the id of any registered root responder
   * (`parentId === null`), or `null` if none is registered.
   *
   * `Map` iteration order is insertion order, so this returns the
   * earliest-registered root — typically `deck-canvas`, which
   * mounts before any descendant. Multi-root scenarios are not
   * expected in production; this picks deterministically rather
   * than throwing.
   */
  private findRootResponderId(): string | null {
    for (const [rootId, rootNode] of this.nodes) {
      if (rootNode.parentId === null) return rootId;
    }
    return null;
  }

  // ---- First responder management ----

  /** Sets firstResponderId, increments validationVersion, notifies subscribers. */
  makeFirstResponder(id: string): void {
    this.firstResponderId = id;
    this.syncFirstResponderDomAttribute();
    this.incrementAndNotify();
  }

  /** Clears firstResponderId, increments validationVersion, notifies subscribers. */
  resignFirstResponder(): void {
    this.firstResponderId = null;
    this.syncFirstResponderDomAttribute();
    this.incrementAndNotify();
  }

  /**
   * Promote `id` to first responder AND restore DOM focus to its element.
   *
   * The single primitive that closes the gap between chain-state and DOM
   * focus. Use cases: a popup-class primitive's close handler restoring
   * focus to whichever responder was first responder when the popup
   * opened (the engine focus trap's close-focus writer); a chain-driven workflow that
   * needs the keyboard caret to land on the newly-promoted responder
   * (cross-card activation via Cmd-tab).
   *
   * Algorithm per `tugplan-session-popup-bindings.md` [D04] (#focus-contract):
   *
   *   1. If `id` is not registered → no-op (and dev-mode warn). Tolerant
   *      of races where the captured target was unregistered between
   *      open and close.
   *   2. Else: `makeFirstResponder(id)` so the chain's record is updated
   *      first (subscribers see the change before DOM focus moves).
   *   3. Then: invoke `node.focus?.()` if the substrate supplied one.
   *      Substrates with non-trivial focus surfaces (CodeMirror,
   *      contenteditable, shadow DOM) own the focus call here.
   *   4. Otherwise: DOM-walk fallback. Look up the responder's element
   *      by `[data-responder-id="<id>"]` and focus it (if focusable)
   *      or its first tabbable descendant.
   *
   * State-zone classification per [L24]: this method only mutates
   * structure-zone state (chain identity) and appearance-zone state
   * (DOM focus). It does not touch React state and does not participate
   * in `useSyncExternalStore` consumption.
   */
  /**
   * Whether `id` is a registered responder node. Lets the focus engine route a
   * key-view restore through {@link focusResponder} (honoring the responder's
   * focus contract) only when the key view is a responder — falling back to its
   * own DOM walk for focusable-only key views (chips, list rows).
   */
  hasResponder(id: string): boolean {
    return this.nodes.has(id);
  }

  /**
   * Whether `id` is a registered responder that supplied a substrate `focus`
   * callback (the [D03] focus contract). The focus engine's keyboard-route
   * classification reads this: a responder WITH a focus contract owns a real
   * text surface (caret / IME / selection — the dom-granted class), while a
   * responder without one is an ordinary engine-routed stop.
   */
  responderHasFocusContract(id: string): boolean {
    return this.nodes.get(id)?.focus !== undefined;
  }

  focusResponder(id: string): void {
    const node = this.nodes.get(id);
    if (!node) {
      if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn(
          `[ResponderManager] focusResponder("${id}") — node not registered.`,
        );
      }
      return;
    }

    // Step 2: chain record first, so subscribers can observe the
    // promotion before any DOM focus event fires from step 3 / 4.
    this.makeFirstResponder(id);

    // Step 3: substrate-supplied focus callback.
    if (node.focus) {
      node.focus();
      return;
    }

    // Step 4: DOM-walk fallback. Look up the responder's host element
    // by its `data-responder-id` attribute (written by `useResponder`'s
    // ref callback). DOM-free environments (server-side rendering) are
    // detected via `typeof document` and skipped — the chain record is
    // already updated, only the DOM focus side-effect is unavailable.
    if (typeof document === "undefined") return;
    const escapedId =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(id)
        : id;
    const el = document.querySelector<HTMLElement>(
      `[data-responder-id="${escapedId}"]`,
    );
    if (!el) return;

    // Focus the element itself if it is intrinsically focusable
    // (a button / input / textarea / select / link, or carries a
    // tabindex >= 0). Otherwise look for the first tabbable
    // descendant. The element-first check matters for wrappers that
    // declare `tabindex="0"` on themselves to claim keyboard focus
    // — focusing a descendant first would drop focus inside the
    // wrapper instead of on it.
    const tabIndexAttr = el.getAttribute("tabindex");
    const intrinsicallyFocusable =
      el instanceof HTMLButtonElement ||
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLAnchorElement;
    const hasFocusableTabIndex =
      tabIndexAttr !== null && parseInt(tabIndexAttr, 10) >= 0;
    // `preventScroll` on every engine focus write: scroll-position writes
    // belong to SmartScroll / the owning surface ([D07]) — a focus write must
    // never let the browser auto-scroll an off-viewport target into view.
    if (intrinsicallyFocusable || hasFocusableTabIndex) {
      el.focus({ preventScroll: true });
      return;
    }

    const tabbable = el.querySelector<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    tabbable?.focus({ preventScroll: true });
  }

  /** Returns the current firstResponderId (or null if none). */
  getFirstResponder(): string | null {
    return this.firstResponderId;
  }

  /**
   * True when `id` is the current first responder, or is reachable by
   * walking `parentId` up from the first responder. False when the
   * first responder is unset, when the walk falls off the root, or
   * when the walk encounters an unregistered ancestor before reaching
   * `id`.
   *
   * Use case: idempotency guards on "promote a container to first
   * responder" operations. When the first responder is already
   * somewhere inside the container's subtree, promoting the container
   * would demote the inner responder for no benefit — and would
   * silently steal keyboard commands the user expects to reach the
   * inner responder. `setResponderChainKey` (in `card-lifecycle.ts`)
   * is the canonical example: clicking inside an already-active card
   * must not demote the card's editor.
   */
  firstResponderIsAtOrBelow(id: string): boolean {
    let currentId: string | null = this.firstResponderId;
    while (currentId !== null) {
      if (currentId === id) return true;
      const node = this.nodes.get(currentId);
      if (!node) return false;
      currentId = node.parentId;
    }
    return false;
  }

  // ---- Key responder of kind (derived) ----

  /**
   * Walk up `parentId` from the current first responder and return the
   * id of the nearest registered node whose `kind` matches. Returns
   * null if the first responder is unset, no ancestor matches, or the
   * walk falls off the root.
   *
   * The walk is inclusive of the first responder: if the first
   * responder itself was registered with the requested kind, its id is
   * returned without further walking.
   *
   * Untagged ancestors (`kind === undefined`) are skipped — they do
   * not terminate the walk. This is the property that lets a tier tag
   * mean "I am the nearest of my kind to whatever the user is doing"
   * regardless of how many untagged responders sit between the first
   * responder and the next tagged ancestor.
   *
   * No state is stored — the value is recomputed on every call. See
   * design doc Phase 1 for the design and the rationale for
   * keeping this derived rather than stored.
   */
  getKeyResponderOfKind(kind: ResponderKind): string | null {
    let currentId: string | null = this.firstResponderId;
    while (currentId !== null) {
      const node = this.nodes.get(currentId);
      if (!node) break;
      if (node.kind === kind) return currentId;
      currentId = node.parentId;
    }
    return null;
  }

  /**
   * Convenience wrapper over `getKeyResponderOfKind("card")`. The vast
   * majority of consumers want the active card; the
   * `getKeyResponderOfKind` form is the escape hatch for future tiers.
   */
  getKeyCard(): string | null {
    const fromResponder = this.getKeyResponderOfKind("card");
    if (fromResponder !== null) return fromResponder;
    // Fallback: the card containing the current keyboard key view. The
    // keyboard-focused element may be focus-REFUSING (a focus-cycle stop such
    // as a Z2 status cell or a Z4B chip), so it is not a responder and the
    // chain walk above finds no card — yet key-card-scoped chords (⌥⇥, ⌃⌥⌘P, …)
    // should still resolve to the card the keyboard is in. Walk up from the
    // `[data-key-view-kbd]` element to the nearest `card`-kind responder.
    return this.findCardFromKeyboardFocus();
  }

  /**
   * The card responder enclosing the current keyboard key view
   * (`[data-key-view-kbd]`), or null — used by {@link getKeyCard} as a fallback
   * when the first responder is not inside a card (e.g. focus is on a
   * focus-refusing cycle stop).
   *
   * TWO axes, in that order, because the key view can be inside a PORTAL. The
   * DOM walk finds the nearest registered responder around the key view (the
   * engine projects the key view as that attribute); from there the walk
   * continues along `parentId`, which is the React-tree axis and therefore
   * crosses the portal — the same property that makes a portaled sheet's
   * `cancelDialog` route to its opener rather than to whatever the portal
   * happens to land in.
   *
   * A DOM-only walk could not answer for a pane-modal sheet at all: the
   * portal's host sits under the canvas, so a cover's Cancel holding the key
   * view resolved to no card, and every `key-card` command was then dropped on
   * the floor. That is not an abstention — ⌃⌘Y is a door a compaction's hold
   * ADMITS ([B02]), and the drop read exactly like the hold refusing it.
   */
  private findCardFromKeyboardFocus(): string | null {
    if (typeof document === "undefined") return null;
    const kv = document.querySelector("[data-key-view-kbd]");
    if (kv === null) return null;
    let el: Element | null = kv.closest("[data-responder-id]");
    while (el !== null) {
      const id = el.getAttribute("data-responder-id");
      const node = id !== null ? this.nodes.get(id) : undefined;
      if (node !== undefined) {
        // Registered, so the CHAIN knows where this node lives and the DOM
        // may not. Falls through to the next DOM ancestor only when the chain
        // walk finds no card — an unparented responder, or one whose scope
        // genuinely sits outside every card.
        let currentId: string | null = id;
        while (currentId !== null) {
          const current = this.nodes.get(currentId);
          if (current === undefined) break;
          if (current.kind === "card") return currentId;
          currentId = current.parentId;
        }
      }
      el = el.parentElement?.closest("[data-responder-id]") ?? null;
    }
    return null;
  }

  /**
   * Subscribe to changes in the derived key-responder-of-kind value.
   *
   * The callback fires *only when* the derived value differs from the
   * value seen at the previous notification — not on every chain
   * change. Initial subscription does not fire; callers read the
   * current value synchronously via `getKeyResponderOfKind(kind)` after
   * subscribing if they need it.
   *
   * Recomputation runs in `incrementAndNotify`, so the same code path
   * that drives `useSyncExternalStore` re-renders also drives this
   * observer. Returns an unsubscribe function.
   *
   * Most React consumers will use the higher-level
   * `useKeyCardId`/`useIsKeyCard` hooks (which use
   * `useSyncExternalStore` over the existing `subscribe` API). This
   * observer is for non-React consumers and for components that want
   * to react to transitions imperatively without re-rendering.
   */
  observeKeyResponder(
    kind: ResponderKind,
    callback: KeyResponderObserver,
  ): () => void {
    const subscription: KeyResponderSubscription = {
      kind,
      callback,
      lastValue: this.getKeyResponderOfKind(kind),
    };
    this.keyResponderSubscriptions.add(subscription);
    return () => {
      this.keyResponderSubscriptions.delete(subscription);
    };
  }

  // ---- Action dispatch ----

  /**
   * Walk the chain from a specified starting node upward via parentId,
   * invoking the first matching handler and capturing any continuation
   * it returns. This is the shared implementation for all four dispatch
   * entry points. The only thing those methods differ on is which node
   * the walk starts at and how they report the result.
   *
   * The four public methods form a 2x2 matrix:
   *
   *   |                    | boolean return         | DispatchResult return                    |
   *   |--------------------|------------------------|------------------------------------------|
   *   | **First responder**| sendToFirstResponder   | sendToFirstResponderForContinuation      |
   *   | **Named target**   | sendToTarget           | sendToTargetForContinuation              |
   *
   * Observer notification and console logging are NOT performed here —
   * the entry point methods call `notifyDispatchObservers` and
   * `logDispatch` after the walk so each method can arrange its own
   * error-handling without duplicating the walk itself.
   *
   * `startId` may be null, in which case the walk is vacuous and the
   * result is `handled: false`. This is the correct outcome when
   * `dispatch` is called with no first responder set.
   */
  private walkFromNode(
    startId: string | null,
    event: ActionEvent,
  ): { handled: boolean; continuation?: () => void; handledBy: string | null } {
    let currentId: string | null = startId;
    while (currentId !== null) {
      const node = this.nodes.get(currentId);
      if (!node) break;
      const handler = lookupHandler(node, event.action);
      if (handler !== undefined) {
        const result = handler(event);
        return {
          handled: true,
          continuation: typeof result === "function" ? result : undefined,
          handledBy: currentId,
        };
      }
      currentId = node.parentId;
    }
    return { handled: false, handledBy: null };
  }

  /**
   * Dispatch an action through the chain and return both whether it was
   * handled and any continuation callback returned by the handler.
   *
   * Walks from the first responder upward via parentId. For each node,
   * checks `event.action` in the actions map only (not the canHandle
   * function). If the action key exists, calls the handler with the
   * full ActionEvent and captures its return value; if the return value
   * is a function, it becomes the continuation. Continues to parent if
   * not found.
   *
   * After the walk (handled or not), every dispatch observer is
   * notified — enabling "close on any action" patterns for context
   * menus and similar transient UIs.
   *
   * Note: canHandle is advisory for validation queries only and is
   * never consulted during dispatch.
   *
   * [D01] ActionEvent is the sole dispatch currency
   * [D02] Handlers may return continuations for two-phase execution
   * (#s02-dispatch-method)
   */
  sendToFirstResponderForContinuation<Extra extends string = never>(
    event: ActionEvent<Extra>,
  ): DispatchResult {
    const { handled, continuation, handledBy } = this.walkFromNode(
      this.firstResponderId,
      event as ActionEvent,
    );
    this.notifyDispatchObservers(event as ActionEvent, handled);
    this.logDispatch(event as ActionEvent, handled, handledBy);
    return { handled, continuation };
  }

  /**
   * Dispatch an action to the first responder. Boolean-return wrapper around
   * sendToFirstResponderForContinuation for callers that don't need the continuation.
   *
   * [D01] ActionEvent is the sole dispatch currency
   * (#s02-dispatch-method)
   */
  sendToFirstResponder<Extra extends string = never>(event: ActionEvent<Extra>): boolean {
    return this.sendToFirstResponderForContinuation(event).handled;
  }

  // ---- Validation queries ----

  /**
   * Query whether any responder in the chain can handle the given action.
   *
   * Walks from the first responder upward. For each node:
   * 1. Check the actions map (primary path) -- if the key exists, return true.
   * 2. Check the node's optional canHandle function (dynamic override) -- if
   *    it returns true, return true.
   * Continues to parent if neither matches. Returns false if root reached.
   */
  canHandle<Extra extends string = never>(action: TugAction<Extra>): boolean {
    let currentId: string | null = this.firstResponderId;
    while (currentId !== null) {
      const node = this.nodes.get(currentId);
      if (!node) break;
      if (lookupHandler(node, action) !== undefined) return true;
      if (node.canHandle && node.canHandle(action as TugAction)) return true;
      currentId = node.parentId;
    }
    return false;
  }

  /**
   * Query whether the action is currently enabled.
   *
   * Walks the chain to find the responder via canHandle logic. Calls that
   * responder's validateAction function if present; defaults to true if not.
   * Returns false if no responder can handle the action.
   */
  validateAction<Extra extends string = never>(action: TugAction<Extra>): boolean {
    const node = this.findValidationResponder(this.firstResponderId, action);
    if (!node) return false;
    return node.validateAction ? node.validateAction(action as TugAction) : true;
  }

  /**
   * Query the action's current display state — checkmark, toggle, or a
   * value string ([P07] of the command-funnel plan). Walks from the first
   * responder exactly like {@link validateAction}: the first node that
   * handles the action terminates the walk and answers its
   * `queryActionState`.
   *
   * Answers `undefined` when no responder handles the action, and when the
   * handling responder registers no `queryActionState` — "nothing to show"
   * is one answer, not two.
   */
  queryActionState<Extra extends string = never>(
    action: TugAction<Extra>,
  ): boolean | string | undefined {
    const node = this.findValidationResponder(this.firstResponderId, action);
    return node?.queryActionState?.(action as TugAction);
  }

  /**
   * `validateAction` asked from the key card's content responder instead of
   * the first responder, so a key-card-routed command is validated by the
   * node the dispatch would actually reach.
   *
   * Answers `false` when there is no key card or no content-scope responder
   * inside it — the same "no one to ask" answer `validateAction` gives.
   */
  validateActionInKeyCard<Extra extends string = never>(
    action: TugAction<Extra>,
  ): boolean {
    const contentId = this.findKeyCardContentId();
    if (contentId === null) return false;
    const node = this.findValidationResponder(contentId, action);
    if (!node) return false;
    return node.validateAction ? node.validateAction(action as TugAction) : true;
  }

  /**
   * `queryActionState` asked from the key card's content responder — the
   * state sibling of {@link validateActionInKeyCard}. Answers `undefined`
   * with no key card.
   */
  queryActionStateInKeyCard<Extra extends string = never>(
    action: TugAction<Extra>,
  ): boolean | string | undefined {
    const contentId = this.findKeyCardContentId();
    if (contentId === null) return undefined;
    const node = this.findValidationResponder(contentId, action);
    return node?.queryActionState?.(action as TugAction);
  }

  /**
   * Walk upward from `startId` and return the first node that handles the
   * action by the validation-query rule (actions map, then the advisory
   * `canHandle`). Null when the walk falls off the root.
   *
   * The shared spine of `validateAction` / `queryActionState` and their
   * key-card variants, so validity and state can never disagree about
   * which responder is answering.
   */
  private findValidationResponder<Extra extends string = never>(
    startId: string | null,
    action: TugAction<Extra>,
  ): ResponderNode | null {
    let currentId: string | null = startId;
    while (currentId !== null) {
      const node = this.nodes.get(currentId);
      if (!node) break;
      const handles =
        lookupHandler(node, action) !== undefined ||
        (node.canHandle ? node.canHandle(action as TugAction) : false);
      if (handles) return node;
      currentId = node.parentId;
    }
    return null;
  }

  // ---- Explicit-target dispatch ----

  /**
   * Dispatch an action through the chain, starting the walk at a
   * specific registered node instead of at the current first responder.
   *
   * The walk otherwise behaves identically to `dispatch` — if the target
   * node itself handles the action, its handler runs and the walk stops
   * there; if not, the walk continues upward via `parentId` until some
   * ancestor handles it, or falls off the root with `handled: false`.
   *
   * Throws if `targetId` is not registered. That is a programming error:
   * the emitter has a stale reference and should be fixed upstream, not
   * silently no-oped. If you specifically want "deliver to this one
   * node and do nothing if it doesn't handle" behavior, check
   * `nodeCanHandle(targetId, action)` before calling.
   *
   * Why a walking target dispatch: the emitter knows the approximate
   * scope the event should reach (e.g. "this specific card") but
   * doesn't need to know exactly which node in that scope owns the
   * action's state. The gallery inspector dispatches `setProperty` "to
   * the card," and the walk starts at the card — whether the card
   * itself owns the PropertyStore or delegates to a wrapper above it,
   * the chain finds the handler without the inspector having to know
   * the target's internal shape.
   *
   * Note: canHandle is advisory for validation queries only and is never
   * consulted during sendToTarget.
   *
   * [D03] sendToTarget throws on unregistered target
   * (#s03-dispatch-to-method)
   */
  sendToTarget<Extra extends string = never>(
    targetId: string,
    event: ActionEvent<Extra>,
  ): boolean {
    return this.sendToTargetForContinuation(targetId, event).handled;
  }

  /**
   * Dispatch an ActionEvent through the chain starting at a named target
   * and return both the handled flag and the optional continuation
   * callback — the sibling to `sendToFirstResponderForContinuation` for
   * target-scoped dispatches.
   *
   * Same walk semantics as `sendToTarget` (starts at the named node and
   * walks upward via parentId until a handler matches or the walk falls
   * off the root) and same error handling (throws if `targetId` is not
   * registered). Callers that want two-phase execution use this method
   * and invoke the returned continuation at their commit point.
   */
  sendToTargetForContinuation<Extra extends string = never>(
    targetId: string,
    event: ActionEvent<Extra>,
  ): DispatchResult {
    if (!this.nodes.has(targetId)) {
      throw new Error(`sendToTargetForContinuation: target "${targetId}" is not registered`);
    }
    const { handled, continuation, handledBy } = this.walkFromNode(
      targetId,
      event as ActionEvent,
    );
    this.notifyDispatchObservers(event as ActionEvent, handled);
    this.logDispatch(event as ActionEvent, handled, handledBy);
    return { handled, continuation };
  }

  // ---- Key-card dispatch ----

  /**
   * Dispatch an action to the key card's content-scope responder — the
   * `kind: "card-content"` node that lives inside the key card's DOM
   * subtree. This is the routing used by keybindings with
   * `scope: "key-card"`: shortcuts scoped to "whichever card the user
   * is currently in" that each card type's body declares handlers for.
   *
   * The walk starts at the card-content responder and goes up via
   * parentId, so content-scope handlers win; unhandled actions fall
   * through to the card-level responder, the canvas, and up. Returns
   * `{ handled: false }` if there is no key card, or if the key card
   * has no descendant `card-content` responder.
   *
   * The card-content node is located by walking the DOM subtree under
   * the card's `data-responder-id` element; the first descendant whose
   * `data-responder-id` resolves to a node of `kind === "card-content"`
   * wins. Zero per-card registration is required — any `useResponder`
   * call that passes `kind: "card-content"` and whose element is
   * rendered inside the card's DOM makes this route work.
   */
  sendToKeyCardForContinuation<Extra extends string = never>(
    event: ActionEvent<Extra>,
  ): DispatchResult {
    const contentId = this.findKeyCardContentId();
    if (contentId === null) {
      this.notifyDispatchObservers(event as ActionEvent, false);
      this.logDispatch(event as ActionEvent, false, null);
      return { handled: false };
    }
    const { handled, continuation, handledBy } = this.walkFromNode(
      contentId,
      event as ActionEvent,
    );
    this.notifyDispatchObservers(event as ActionEvent, handled);
    this.logDispatch(event as ActionEvent, handled, handledBy);
    return { handled, continuation };
  }

  /**
   * Boolean-return wrapper over `sendToKeyCardForContinuation` for
   * callers that don't need the continuation.
   */
  sendToKeyCard<Extra extends string = never>(event: ActionEvent<Extra>): boolean {
    return this.sendToKeyCardForContinuation(event).handled;
  }

  /**
   * Locate the key card's `card-content` responder id, if any.
   * Algorithm:
   *   1. `getKeyCard()` to identify the active card.
   *   2. Look up the card's DOM element via its `data-responder-id`.
   *   3. Walk its descendants; for each `[data-responder-id]`, check
   *      whether the node's kind is `"card-content"`.
   *   4. Return the first match, or null.
   *
   * No document / no key card / no content-scope descendant → null.
   */
  private findKeyCardContentId(): string | null {
    const cardId = this.getKeyCard();
    if (cardId === null || typeof document === "undefined") return null;
    const escapedId =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(cardId)
        : cardId;
    const cardEl = document.querySelector(
      `[data-responder-id="${escapedId}"]`,
    );
    if (cardEl === null) return null;
    const descendants = cardEl.querySelectorAll<HTMLElement>(
      "[data-responder-id]",
    );
    for (const el of descendants) {
      const id = el.getAttribute("data-responder-id");
      if (id === null) continue;
      const node = this.nodes.get(id);
      if (node && node.kind === "card-content") return id;
    }
    return null;
  }

  // ---- Target-based first-responder resolution ----

  /**
   * Walk the DOM from `target` upward looking for the nearest ancestor
   * (inclusive of the target itself) that carries a `data-responder-id`
   * attribute whose value is a registered responder node. Returns the
   * id, or null if no registered responder is found along the path.
   *
   * Used by ResponderChainProvider's document-level pointerdown
   * listener to promote the "innermost responder under the event
   * target" to first responder. This is what makes nested responders
   * compose naturally: clicking inside an editor that lives inside a
   * card makes the editor the first responder, not the card, without
   * any per-component wiring.
   *
   * Registration of `data-responder-id` is done by `useResponder`'s
   * `responderRef` callback; callers must attach that ref to their
   * root DOM element for this lookup to find them.
   */
  findResponderForTarget(target: Node | null): string | null {
    let el: Element | null =
      target instanceof Element
        ? target
        : target instanceof Node
          ? target.parentElement
          : null;
    while (el) {
      const id = el.getAttribute("data-responder-id");
      if (id && this.nodes.has(id)) {
        return id;
      }
      el = el.parentElement;
    }
    return null;
  }

  // ---- Per-node capability query ----

  /**
   * Query whether a specific registered node can handle the given action.
   *
   * Checks the node's actions map first, then the optional canHandle function.
   * Returns false if the node is not registered.
   *
   * [D07] nodeCanHandle for per-node capability query
   * (#s07-node-can-handle)
   */
  nodeCanHandle<Extra extends string = never>(
    nodeId: string,
    action: TugAction<Extra>,
  ): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    if (lookupHandler(node, action) !== undefined) return true;
    if (node.canHandle && node.canHandle(action as TugAction)) return true;
    return false;
  }

  /**
   * Query whether the action is currently *enabled* at a named node — the
   * per-node analogue of {@link nodeCanHandle}, and the targeted-dispatch
   * counterpart to {@link validateAction}.
   *
   * `validateAction` asks the first responder's chain, which is the wrong
   * question for a control that dispatches to an explicit target: a button
   * inside a background card would be answered by whatever happens to hold
   * focus. This asks the node the dispatch would actually reach.
   *
   * Answers `false` when the node does not handle the action at all —
   * "can't" and "can, but not now" are both unavailable, matching
   * `validateAction`'s own convention. A node that handles the action but
   * registers no `validateAction` answers `true`.
   */
  validateActionAtNode<Extra extends string = never>(
    nodeId: string,
    action: TugAction<Extra>,
  ): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    if (!this.nodeCanHandle(nodeId, action)) return false;
    return node.validateAction ? node.validateAction(action as TugAction) : true;
  }

  // ---- Default button stack ----

  /**
   * Push a default button onto the stack.
   *
   * The most recently pushed button is the active default button. Supports
   * nested modal scoping: inner modals push their button on open and pop it
   * on close, restoring the outer button automatically.
   *
   * [D01] Stack semantics for nested modal scoping
   */
  pushDefaultButton(element: HTMLButtonElement): void {
    this.defaultButtonStack.push(element);
  }

  /**
   * Remove a specific button from the stack by reference.
   *
   * Uses strict reference equality (===) to find the last occurrence of the
   * element via lastIndexOf and removes exactly one instance. No-op if the
   * element is not found on the stack.
   *
   * [D01] Reference-based removal
   * [R02] Defensive: no-op if not found
   */
  popDefaultButton(element: HTMLButtonElement): void {
    const index = this.defaultButtonStack.lastIndexOf(element);
    if (index !== -1) {
      this.defaultButtonStack.splice(index, 1);
    }
  }

  /**
   * Return the topmost default button, or null if the stack is empty.
   *
   * [D01] Most recent registration wins
   */
  peekDefaultButton(): HTMLButtonElement | null {
    for (let i = this.defaultButtonStack.length - 1; i >= 0; i -= 1) {
      const button = this.defaultButtonStack[i];
      if (isRenderedDefaultButton(button)) return button;
    }
    return null;
  }

  /**
   * Return's home for a keystroke that originated at `origin` ([P14]).
   *
   * The pane is the outer bound — a `Return` typed in pane A must never press
   * a button registered by a sheet in pane B ([D15] pane modality) — and the
   * CARD is the one that decides: a button inside a card is that card's alone,
   * and only a button belonging to no card (a pane-level sheet: the History
   * shade's Done, an unbound card's picker) is the whole pane's to press. A
   * pane-wide peek could not say that, and said the wrong thing routinely,
   * because the tab stack keeps every card mounted behind `display: none` and
   * the Session Z5 re-registers on every submit-mode flip — so the topmost
   * default in the pane was regularly a button on a card nobody could see, and
   * a Shift+Return in the visible composer pressed *that*.
   *
   * Walks top-down so nested modals keep their LIFO semantics, and skips any
   * button that is not rendered ({@link isRenderedDefaultButton}).
   */
  peekDefaultButtonForOrigin(origin: Element | null): HTMLButtonElement | null {
    if (origin === null) return this.peekDefaultButton();
    const pane = origin.closest(".tug-pane");
    const originCard = origin.closest(CARD_HOST_SELECTOR);
    for (let i = this.defaultButtonStack.length - 1; i >= 0; i -= 1) {
      const button = this.defaultButtonStack[i];
      if (pane !== null && !pane.contains(button)) continue;
      if (!defaultButtonAnswersTo(button, originCard)) continue;
      if (!isRenderedDefaultButton(button)) continue;
      return button;
    }
    // No pane context at all (gallery / standalone) is the one case with
    // nothing to scope by: the global top is the whole answer there.
    return pane === null ? this.peekDefaultButton() : null;
  }

  // ---- Dynamic context-scoped keybindings ([P11], #keybinding-registry) ----

  /**
   * Register a live source of keybindings under `scopeId` (a responder id for
   * responder-scoped bindings, or a focus-mode id for mode-local ones).
   * Returns an unregister thunk for the caller's cleanup. Dev-warns if the
   * scope ends up with two bindings on the same chord (otherwise the first
   * found would silently shadow the other).
   */
  registerKeybinding(
    scopeId: string,
    source: KeybindingSource,
    kind: KeybindingScopeKind = "responder",
  ): () => void {
    let set = this.keybindingSources.get(scopeId);
    if (set === undefined) {
      set = new Set();
      this.keybindingSources.set(scopeId, set);
    }
    this.keybindingScopeKinds.set(scopeId, kind);
    set.add(source);
    this.warnDuplicateChords(scopeId);
    return () => {
      const current = this.keybindingSources.get(scopeId);
      if (current === undefined) return;
      current.delete(source);
      if (current.size === 0) {
        this.keybindingSources.delete(scopeId);
        this.keybindingScopeKinds.delete(scopeId);
      }
    };
  }

  /**
   * Resolve a keyboard event against the dynamic registry, innermost-first:
   * first the `extraScopes` (the active focus mode, passed by the provider —
   * the innermost context, reachable even when DOM focus is elsewhere, e.g. an
   * inline dialog's accelerators while the prompt holds focus), then the
   * first-responder `parentId` walk from innermost responder up to the root.
   * Returns the first matching binding, or `null` so the caller falls through
   * to the static global map. The matched binding is dispatched by the caller
   * exactly like a static one (its `scope` field still picks dispatch routing).
   */
  resolveKeybinding(
    event: KeyboardEvent,
    extraScopes: readonly string[] = [],
  ): KeyBinding | null {
    for (const scopeId of extraScopes) {
      const match = this.matchKeybindingInScope(event, scopeId);
      if (match !== null) return match;
    }
    let currentId: string | null = this.firstResponderId;
    while (currentId !== null) {
      const match = this.matchKeybindingInScope(event, currentId);
      if (match !== null) return match;
      const node = this.nodes.get(currentId);
      if (!node) break;
      currentId = node.parentId;
    }
    return null;
  }

  /**
   * The bindings registered at `scopeId` (or every registered binding when
   * omitted), each paired with the scope it was registered under.
   *
   * The scope is not decoration: a chord's resolution depends entirely on
   * *where* a binding lives, so a flat list of bindings cannot answer who
   * gets the chord — which is the question `resolveChord` exists to answer.
   * Callers that want "live right now" intersect with the current scope walk.
   */
  activeKeybindings(scopeId?: string): ScopedKeyBinding[] {
    if (scopeId !== undefined) return this.bindingsAtScope(scopeId);
    const all: ScopedKeyBinding[] = [];
    for (const id of this.keybindingSources.keys()) {
      all.push(...this.bindingsAtScope(id));
    }
    return all;
  }

  /**
   * Every scoped binding live right now, in the order
   * {@link resolveKeybinding} would consult them: the extra scopes first
   * (the current focus mode), then the first-responder walk outward.
   *
   * This is the enumeration a shadowing view needs and `activeKeybindings`
   * cannot give: the same set, but placed. Deriving it here rather than in
   * the reader is what keeps the displayed order and the fired order from
   * being two independent implementations of "innermost first".
   */
  liveKeybindings(extraScopes: readonly string[] = []): LiveKeyBinding[] {
    const live: LiveKeyBinding[] = [];
    let depth = 0;
    const take = (scopeId: string): void => {
      const found = this.bindingsAtScope(scopeId);
      if (found.length === 0) return;
      for (const entry of found) live.push({ ...entry, depth });
      depth += 1;
    };
    for (const scopeId of extraScopes) take(scopeId);
    let currentId: string | null = this.firstResponderId;
    while (currentId !== null) {
      take(currentId);
      const node: ResponderNode | undefined = this.nodes.get(currentId);
      if (node === undefined) break;
      currentId = node.parentId;
    }
    return live;
  }

  /** The registered bindings at one scope, tagged with what that scope is. */
  private bindingsAtScope(scopeId: string): ScopedKeyBinding[] {
    const set = this.keybindingSources.get(scopeId);
    if (set === undefined) return [];
    const kind = this.keybindingScopeKinds.get(scopeId) ?? "responder";
    return [...set].flatMap((source) =>
      [...source()].map((binding) => ({ scopeId, kind, binding })),
    );
  }

  /** First binding at `scopeId` matching the event, or null. */
  private matchKeybindingInScope(
    event: KeyboardEvent,
    scopeId: string,
  ): KeyBinding | null {
    const set = this.keybindingSources.get(scopeId);
    if (set === undefined) return null;
    for (const source of set) {
      for (const binding of source()) {
        if (chordMatchesEvent(event, binding)) return binding;
      }
    }
    return null;
  }

  /** Dev-only: warn when one scope has two bindings on the same chord. */
  private warnDuplicateChords(scopeId: string): void {
    if (typeof process !== "undefined" && process.env?.NODE_ENV === "production") return;
    const bindings = this.activeKeybindings(scopeId).map((entry) => entry.binding);
    const seen = new Set<string>();
    for (const b of bindings) {
      const chord = `${b.key}|${!!b.ctrl}|${!!b.meta}|${!!b.shift}|${!!b.alt}`;
      if (seen.has(chord)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[responder-chain] duplicate keybinding chord "${chord}" registered at scope "${scopeId}" — the first match shadows the rest.`,
        );
      }
      seen.add(chord);
    }
  }

  // ---- Subscription (for useSyncExternalStore) ----

  /**
   * Subscribe to chain state changes.
   *
   * The callback fires whenever validationVersion increments (focus change,
   * register, unregister). Returns an unsubscribe function.
   */
  subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /** Returns the current validationVersion for useSyncExternalStore snapshots. */
  getValidationVersion(): number {
    return this.validationVersion;
  }

  // ---- Dispatch observers ----

  /**
   * Subscribe to every action flowing through the chain.
   *
   * The callback fires after every `sendToFirstResponder`,
   * `sendToTarget`, and their ForContinuation siblings — whether the
   * event was handled or not. The
   * `handled` argument reports the final outcome. Returns an
   * unsubscribe function.
   *
   * Use case: a transient UI (e.g. a context menu) that needs to close
   * itself whenever unrelated action traffic flows through the chain.
   * The observer can filter by action name or sender.
   */
  observeDispatch(callback: DispatchObserver): () => void {
    this.dispatchObservers.add(callback);
    return () => {
      this.dispatchObservers.delete(callback);
    };
  }

  // ---- Private helpers ----

  private incrementAndNotify(): void {
    this.validationVersion += 1;
    for (const cb of this.subscribers) {
      cb();
    }
    this.notifyKeyResponderObservers();
  }

  /**
   * Recompute the derived key-responder-of-kind value for every
   * subscription and fire the callback only if it differs from the
   * value the subscription was last notified about.
   *
   * Snapshotted to a local array first so a callback that
   * unsubscribes itself during notification doesn't mutate the set
   * mid-iteration — same defensive pattern as
   * `notifyDispatchObservers`.
   */
  private notifyKeyResponderObservers(): void {
    if (this.keyResponderSubscriptions.size === 0) return;
    const subs = Array.from(this.keyResponderSubscriptions);
    for (const sub of subs) {
      const current = this.getKeyResponderOfKind(sub.kind);
      if (current !== sub.lastValue) {
        sub.lastValue = current;
        sub.callback(current);
      }
    }
  }

  private notifyDispatchObservers(event: ActionEvent, handled: boolean): void {
    // Snapshot to a local array so observers that unsubscribe themselves
    // during notification don't mutate the set mid-iteration.
    const observers = Array.from(this.dispatchObservers);
    for (const obs of observers) {
      obs(event, handled);
    }
  }

  /**
   * Log every dispatch to the console with a gray prefix so developers
   * can see what's flowing through the chain in real time. Includes
   * the action name, sender (if present), value (if present), whether
   * it was handled, and which responder handled it. Filter the console
   * for `[responder-chain] dispatch` to see only chain traffic.
   *
   * Gated on `window.__tugChainDebug === true`. Default: off. Toggle
   * from devtools at any time:
   *
   *     window.__tugChainDebug = true;   // enable chain logs
   *     window.__tugChainDebug = false;  // silence them again
   *
   * The opt-in default keeps the console clean when debugging things
   * outside the responder chain. One-line opt-in from devtools turns
   * the firehose back on whenever needed.
   */
  private logDispatch(event: ActionEvent, handled: boolean, handledBy: string | null): void {
    if (typeof console === "undefined") return;
    if (!isChainDebugEnabled()) return;
    const senderPart = event.sender !== undefined ? ` sender=${JSON.stringify(event.sender)}` : "";
    const valuePart = event.value !== undefined ? ` value=${JSON.stringify(event.value)}` : "";
    const outcomePart = handled
      ? `handled by ${handledBy}`
      : "unhandled";
    // eslint-disable-next-line no-console
    console.log(
      `%c[responder-chain] dispatch %c${event.action}%c${senderPart}${valuePart} %c(${outcomePart})`,
      "color:#888",
      "color:inherit;font-weight:600",
      "color:#888",
      handled ? "color:#4a7" : "color:#c55",
    );
  }

  /**
   * Sync the `data-first-responder` attribute on the DOM so exactly one
   * element in the document carries it at any instant — specifically,
   * the element whose `data-responder-id` matches the current
   * `firstResponderId`. Called from every method that changes
   * `firstResponderId`.
   *
   * The attribute's *value* is the responder id, not "true" — so the
   * DOM is self-describing. Searching devtools for
   * `[data-first-responder]` shows the attribute with its id
   * inline (e.g. `data-first-responder="editor-:r5:"`), and you can
   * immediately tell which responder the chain considers active
   * without having to cross-reference `data-responder-id`.
   *
   * A single `console.log` fires on every change with a gray-prefixed
   * marker and the DOM element as a second argument — devtools makes
   * the element clickable so you can jump to it in the Elements panel.
   * Filter the console for `[responder-chain]` to see the full
   * first-responder history, or mute it if it's too noisy for your
   * current workflow.
   *
   * Implementation: clear the attribute from any element that has it,
   * then find the element with the matching `data-responder-id` and
   * set it. DOM-free environments (server-side rendering, unit tests
   * without jsdom) are detected via `typeof document` and skipped
   * entirely — logging included.
   *
   * Cost: two `querySelector` calls per first-responder change,
   * bounded by document size. Negligible in practice.
   */
  private syncFirstResponderDomAttribute(): void {
    if (typeof document === "undefined") return;
    // Clear the previous marker. In normal operation there is at most
    // one, but we use querySelectorAll defensively in case something
    // external set the attribute.
    document.querySelectorAll<HTMLElement>("[data-first-responder]").forEach((el) => {
      el.removeAttribute("data-first-responder");
    });
    if (this.firstResponderId === null) {
      if (isChainDebugEnabled()) {
        // eslint-disable-next-line no-console
        console.log("%c[responder-chain] first responder cleared", "color:#888");
      }
      return;
    }
    const id = this.firstResponderId;
    const escapedId =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(id)
        : id;
    const el = document.querySelector<HTMLElement>(`[data-responder-id="${escapedId}"]`);
    if (el) {
      // Attribute value is the id itself, so searching devtools for
      // `[data-first-responder]` shows `data-first-responder="<id>"`
      // inline — no cross-referencing required.
      el.setAttribute("data-first-responder", id);
      if (isChainDebugEnabled()) {
        // eslint-disable-next-line no-console
        console.log(`%c[responder-chain] first responder → %c${id}`, "color:#888", "color:inherit;font-weight:600", el);
      }
    } else {
      // No DOM element matches the id. This can happen if the
      // responder registered via useResponder but forgot to attach
      // responderRef, or if the responder was registered during a
      // render that hadn't committed yet. Either way, log a warning
      // so it surfaces during development.
      // eslint-disable-next-line no-console
      console.warn(`[responder-chain] first responder "${id}" has no matching [data-responder-id] element — did the caller attach responderRef?`);
    }
  }
}

// ---- React Contexts ----

/**
 * React context holding the singleton ResponderChainManager for the canvas
 * subtree. Default value is null (outside any provider).
 *
 * Co-located here so use-responder.ts and responder-chain-provider.tsx can
 * both import it without circular dependencies.
 */
export const ResponderChainContext =
  createContext<ResponderChainManager | null>(null);

/**
 * React context holding the nearest ancestor responder ID.
 *
 * Default is null (no parent -- caller is a root node).
 * Each useResponder call provides its own ID as the new value for its subtree
 * via ResponderScope, enabling automatic parent discovery without prop drilling.
 *
 * Controls read this to discover their dispatch target (useControlDispatch).
 * useResponder reads this to register with the correct parentId.
 *
 * Co-located with ResponderChainContext so both contexts live in the same
 * infrastructure module.
 */
export const ResponderParentContext = createContext<string | null>(null);
