/**
 * focus-transfer.ts — the single seam through which the framework
 * transfers keyboard focus and caret state between cards on an
 * activation-driven trigger.
 *
 * ## Why this exists
 *
 * Before this module, every activation path (intra-pane tab click, pane
 * activation, tab-close handoff, cross-pane drag / detach, cold-boot
 * restore) maintained its own "save outgoing, flip bit, restore
 * incoming" dance. Each one diverged on ordering, on which axis it
 * touched, and on whether it gated via the focus-theft rules. The
 * reactive `[A3]` effect subsumed three of those paths into a single
 * `useLayoutEffect`, which closed the divergence but introduced a
 * rapid-cadence race: when a store mutation and the prior effect's
 * commit landed in the same React tick, React's batching delivered the
 * activation body one frame late — the user saw focus dwell on the
 * outgoing card while the incoming card's commit flashed without its
 * caret, then the incoming card caught up.
 *
 * The fix is to decouple focus transfer from React's render cycle.
 * Every activation trigger is either:
 *
 *   - synchronous user gesture (tab click, pane activation, close
 *     handoff) — drives focus transfer in the same call stack as the
 *     store mutation, never round-tripping through React,
 *
 *   - drag-driven gesture — snapshots focus at drag start, lets the
 *     re-parent commit, then re-applies focus on pointerup in the same
 *     gesture's event handler,
 *
 *   - app-lifecycle / deferred trigger (resign, resume, cold boot) —
 *     resolves targets against the post-commit DOM.
 *
 * This module is the one place in the codebase that walks the decision
 * tree from "which card is the caller activating?" to "what, if
 * anything, do I call `.focus()` on?". Callers hand in the card ids
 * and the commit closure; the module saves the outgoing bag,
 * synchronously drives the mutation to commit (so the incoming card's
 * DOM subtree is visible and mounted before a focus attempt), resolves
 * the target, gates through the focus-theft rules, and executes the
 * transfer. There is no RAF, no microtask hop, no React effect.
 *
 * ## What ships in this module
 *
 * - Single-channel dispatcher: pure `resolveBagFocus` + impure
 *   `applyBagFocus`. Every focus-claim path reads `bag.focus`
 *   through these primitives; the engine is a callable invoked
 *   from the dispatcher's `engine` branch. The `framework` branch
 *   carries an idempotency guard: when the resolved element is
 *   already `document.activeElement`, the dispatcher yields
 *   rather than re-calling `.focus()` (WebKit can drop focus to
 *   body on a redundant mount-time `.focus()`).
 * - `transferFocusForActivation` and gesture hooks from
 *   `pane-focus-controller`, `tug-pane`, and `deck-manager`
 *   (`_removeCard` / `_closePane`); the legacy `[A3]`
 *   `useLayoutEffect` in `CardHost` retires in favor of this
 *   path. `default-focus` covers cards with no saved `bag.focus`.
 * - Drag: `captureFocusForDragStart` / `transferFocusAfterMove`
 *   from pane/tab drag handlers and `deck-manager` after
 *   cross-pane moves; cancel path refocuses the pre-drag target.
 * - App focus: `reactivateCurrentFocusDestination` on window
 *   `focus` after `setHasFocus(true)`; `blur` flushes save
 *   before `hasFocus` clears.
 *
 * ## The dispatch model
 *
 * `resolveBagFocus(cardId, store)` returns a `BagFocusResolution`
 * six-variant union (`framework` / `engine` / `default-focus` /
 * `deferred-dom` / `deferred-engine` / `none`). `applyBagFocus`
 * consumes that resolution and performs the corresponding side
 * effect:
 *
 *   - `framework` → `el.focus()`, unless the element is already
 *     `document.activeElement` — then the dispatcher yields and
 *     returns `"applied"` without re-calling (idempotency guard).
 *   - `engine` → `store.invokeEnginePaintMirrorAsActive(cardId)`.
 *     The engine hook is internally idempotent.
 *   - `default-focus` → walk the `DEFAULT_FOCUS_SELECTORS` chain.
 *   - `deferred-dom` / `deferred-engine` → return `"deferred"`.
 *     `deferred-engine` is retried by `CardHost`'s
 *     `subscribeEngineHooksChange` channel when the engine
 *     registers. `deferred-dom` is a best-effort resolution: if
 *     the saved framework-axis target is not in the DOM at
 *     dispatch time, focus does not land — the one-shot callers
 *     accept `"deferred"` as a graceful no-focus outcome.
 *   - `none` → idempotent no-op.
 *
 * `resolveBagFocus` is side-effect-free: it reads DOM via
 * `querySelector`, reads the store's bag, host-root registry, and
 * engine-hook registry, and returns. It is idempotent — calling
 * it twice with the same inputs and the same DOM yields the same
 * result — but it is NOT pure over the store value alone. Between
 * two calls the DOM may have changed: a content factory may have
 * swapped the element that `data-tug-focus-key="save"` identifies;
 * a previously-hidden subtree may have mounted; the registered
 * host root may have detached. The resolver always reads DOM live
 * rather than caching a stale handle.
 *
 * ## Framework-local, no React
 *
 * Nothing in this module imports from React. It is called from
 * synchronous event handlers (`performSelectCard`,
 * `handleTitleBarPointerDown`, the drag coordinator's `pointerup`
 * callback, a deferred app-lifecycle listener). Callers that need to
 * sandwich a React state commit pass a `commitMutation` closure; the
 * transfer function uses `react-dom`'s `flushSync` to force the
 * mutation's commit before resolving against post-commit DOM.
 *
 * ## Tuglaws
 *
 *   - **L10** — this module owns exactly one responsibility (focus
 *     and caret transfer between cards on activation).
 *   - **L22** — the synchronous entries drive DOM writes from
 *     external state without round-tripping through a React effect.
 *   - **L23** — outgoing state is saved before any mutation; the
 *     transfer is atomic save → commit → resolve → gate → focus.
 *   - **L07** — the resolver reads current store state at call time;
 *     it does not capture a stale snapshot.
 *
 * @module focus-transfer
 */

import { flushSync } from "react-dom";

import { getResponderChainManager } from "./action-dispatch";
import { isEngineManagedCard } from "./card-registry";
import { getFocusManager } from "./components/tugways/focus-manager";
import { selectionGuard } from "./components/tugways/selection-guard";
import { deckTrace, formatElement } from "./deck-trace";
import { traceApplyDefaultFocus } from "./default-focus";
import { mayClaimActivationFocus } from "./components/tugways/focus-manager";

import type { FocusModality, FocusTarget } from "./components/tugways/focus-manager";
import type { IDeckManagerStore } from "./deck-manager-store";
import type { CardStateBag, FocusSnapshot } from "./layout-tree";

/**
 * Pure mapping from a persisted `bag.focus` snapshot to the engine's
 * unified {@link FocusTarget} descriptor + the modality the placement
 * should assert. The four legacy shapes map 1:1 — no tugbank migration:
 *
 *   - `{ kind: "dom", focusKey, keyboard }` → `focus-key` (keyboard ring
 *     resumes iff the snapshot recorded it)
 *   - `{ kind: "form-control", componentStatePreservationKey }` →
 *     `state-key` (focus identity implicit in the preservation key, [D10])
 *   - `{ kind: "engine" }` → `engine`
 *   - `{ kind: "none" }` / absent → `none`
 *
 * Shape-only: the store-aware refinements ("no saved focus on an
 * engine-bearing card still resolves to the engine") stay in
 * {@link resolveBagFocus}, which owns the store and DOM reads.
 */
export function focusSnapshotToTarget(
  focus: FocusSnapshot | null | undefined,
): { target: FocusTarget; modality: FocusModality } {
  if (focus === undefined || focus === null || focus.kind === "none") {
    return { target: { kind: "none" }, modality: "pointer" };
  }
  if (focus.kind === "engine") {
    return { target: { kind: "engine" }, modality: "pointer" };
  }
  if (focus.kind === "form-control") {
    return {
      target: { kind: "state-key", key: focus.componentStatePreservationKey },
      modality: "pointer",
    };
  }
  return {
    target: { kind: "focus-key", focusKey: focus.focusKey },
    modality: focus.keyboard === true ? "keyboard" : "pointer",
  };
}

/**
 * Local replica of `card-host.tsx`'s `isElementHidden`. Detects
 * elements that are visually absent because some ancestor (or the
 * element itself) is `display: none`. `offsetParent` is null in
 * that case for non-`position: fixed` elements; we accept fixed-
 * positioned elements as "not hidden" because they intentionally
 * have no offsetParent but remain visible.
 *
 * Replicated rather than imported so this module stays free of
 * dependencies on React component files (per the module header's
 * "framework-local, no React" contract). Two ~12-line copies is
 * cheaper than the alternative — promoting the helper into a
 * shared utility module — at this scope.
 */
function isElementHidden(el: HTMLElement | null): boolean {
  if (el === null) return false;
  if (el.offsetParent === null) {
    const style =
      typeof window !== "undefined" &&
      typeof window.getComputedStyle === "function"
        ? window.getComputedStyle(el)
        : null;
    if (style !== null && style.position === "fixed") return false;
    return true;
  }
  return false;
}

/**
 * Diagnostic helper — emits the `pre-sync` and `post-sync` halves
 * of a `focus-measurement` triple around a framework focus-claim
 * site, then schedules the `post-gesture` tail on a macrotask so it
 * lands after the same-tick gesture default actions (e.g. WebKit's
 * mousedown focus default) have settled. The triple records, for
 * each activation source, whether sync `.focus()` survives the
 * gesture or is swallowed by gesture focus-lock.
 *
 * The `claim` closure runs between `pre-sync` and `post-sync`. The
 * caller is responsible for the real focus call inside `claim`;
 * this helper only observes.
 *
 * Observation-only — call sites that wrap their existing `.focus()`
 * in `measureFocusClaim` execute the same focus call in the same
 * tick. The three observations record into the deck-trace ring only
 * when `deckTrace.enable(true)` is in effect.
 */
function measureFocusClaim(
  site: string,
  cardId: string | null,
  doc: Document,
  claim: () => void,
): void {
  deckTrace.record({
    kind: "focus-measurement",
    phase: "pre-sync",
    site,
    cardId,
    activeElement: formatElement(doc.activeElement),
  });
  claim();
  deckTrace.record({
    kind: "focus-measurement",
    phase: "post-sync",
    site,
    cardId,
    activeElement: formatElement(doc.activeElement),
  });
  // Defer the post-gesture observation onto a macrotask so any
  // same-tick browser default action (mousedown focus, click focus)
  // has settled before we read `activeElement`. setTimeout(0) is
  // the simplest macrotask boundary; the investigation does not
  // need the MessageChannel-precise scheduling that the lifecycle
  // delegate uses.
  if (typeof setTimeout === "function") {
    setTimeout(() => {
      deckTrace.record({
        kind: "focus-measurement",
        phase: "post-gesture",
        site,
        cardId,
        activeElement: formatElement(doc.activeElement),
      });
    }, 0);
  }
}

/**
 * Narrow subset of `IDeckManagerStore` that this module reads. Kept
 * narrow so tests (and future refactors) do not need to hand in the
 * full deck store — a handful of methods is enough. Downstream
 * side-effecting entries will expand this list
 * as they wire in the mutation and dispatch paths.
 */
export type FocusTransferStore = Pick<
  IDeckManagerStore,
  | "getCardState"
  | "peekCardHostRoot"
  | "getSnapshot"
  // `applyBagFocus` reads these to resolve `engine` vs
  // `deferred-engine` and to invoke the registered engine hook.
  | "hasEngineHooks"
  | "invokeEnginePaintMirrorAsActive"
>;

// ---------------------------------------------------------------------------
// Single-channel focus dispatcher
//
// `resolveBagFocus` (pure) + `applyBagFocus` (impure). Every
// activation-focus path reads `bag.focus` through these primitives:
// `transferFocusForActivation`, `transferFocusAfterMove`,
// `reactivateCurrentFocusDestination`, and `CardHost`'s cold-boot
// RESTORE effect all dispatch through `applyBagFocus`.
// ---------------------------------------------------------------------------

/**
 * Resolved destination of a `bag.focus` lookup — the single-channel
 * dispatcher's return type.
 *
 * `resolveBagFocus` is pure (reads bag + DOM, no side effects);
 * `applyBagFocus` is the impure dispatcher that calls into this and
 * performs the corresponding side effect. The six-variant union
 * names every outcome the dispatcher can encounter:
 *
 *   - `framework` — concrete focusable element resolved from
 *     `bag.focus.kind === "dom" | "form-control"`. The dispatcher
 *     calls `el.focus()`, unless the element is already
 *     `document.activeElement` — then it yields (idempotency
 *     guard).
 *   - `engine` — the card's bag names engine-owned focus and the
 *     engine has registered hooks. The dispatcher invokes
 *     `store.invokeEnginePaintMirrorAsActive(cardId)`.
 *   - `default-focus` — DOM-authority card with no usable saved
 *     focus snapshot; the dispatcher walks
 *     {@link DEFAULT_FOCUS_SELECTORS} via
 *     {@link traceApplyDefaultFocus}.
 *   - `deferred-dom` — bag names a framework-axis target whose
 *     element is not in the DOM at dispatch time. The dispatcher
 *     returns `"deferred"`; the one-shot callers accept that as a
 *     graceful no-focus outcome. Reachable only by non-engine
 *     framework-axis cards — a content-owning + engine card
 *     resolves to `engine` / `deferred-engine`, never here.
 *   - `deferred-engine` — bag names engine focus but no engine
 *     hooks are registered yet (engine mounts late, e.g. dev's
 *     editor after `feedsReady`). The dispatcher returns
 *     `"deferred"`; CardHost's `subscribeEngineHooksChange`
 *     listener re-fires `applyBagFocus` when the engine registers.
 *   - `none` — nothing to focus. Bag is absent, host root is
 *     unregistered, or `bag.focus.kind === "none"`. The dispatcher
 *     returns `"applied"` (idempotent no-op) so callers can stop
 *     retrying.
 */
export type BagFocusResolution =
  | { kind: "framework"; el: HTMLElement; sourceKind: "dom" | "form-control"; keyboard?: boolean }
  | { kind: "engine"; cardId: string }
  | { kind: "default-focus"; cardRoot: HTMLElement }
  | { kind: "deferred-dom"; cardId: string; focusKind: "dom" | "form-control"; key: string; keyboard?: boolean }
  | { kind: "deferred-engine"; cardId: string }
  | { kind: "none" };

/**
 * Pure resolver — the single-channel dispatcher's read half.
 *
 * Consults `bag.focus` and resolves it to a {@link BagFocusResolution}
 * suitable for {@link applyBagFocus}. Side-effect free: reads the
 * bag, the host root, the engine-hook registration via
 * `store.hasEngineHooks`, the focus engine's live key card / key
 * view, and the live DOM via `querySelector`. Does not mutate
 * focus, selection, or any DOM state.
 *
 * Single source of truth for "where does focus go on this
 * activation?" — the [L23] single-channel contract.
 */
export function resolveBagFocus(
  cardId: string,
  store: FocusTransferStore,
): BagFocusResolution {
  const bag = store.getCardState(cardId);
  const hostRoot = store.peekCardHostRoot(cardId);

  const focus = bag?.focus;
  if (focus === undefined || focus === null || focus.kind === "none") {
    // No saved focus. Default-focus walk inside the card root for
    // DOM-authority cards; engine resolution for engine-bearing
    // cards — a content-owning + engine card (a session card) has one
    // text-entry surface, so "no saved focus" still resolves to the
    // engine.
    const card = store.getSnapshot().cards.find((c) => c.id === cardId);
    const isEngineManaged =
      card !== undefined && isEngineManagedCard(card.componentId);
    const isContentOwning = bag !== undefined && bag.content !== undefined;
    if (isEngineManaged || isContentOwning) {
      if (store.hasEngineHooks(cardId)) {
        return { kind: "engine", cardId };
      }
      return { kind: "deferred-engine", cardId };
    }
    // The focus engine already holds this card's keyboard — a live key view
    // recorded/projected for exactly this card (the ring a Cmd-L or a
    // background-card placement just put on a list). The activation realizes
    // THAT target ([P20]); the generic default-focus walk below must not
    // displace it (it would land on the first tabbable — a section's filter
    // input — and yank the ring off the just-placed list).
    //
    // This is the downstream half of the activation permission ([P04]), not a
    // leftover. `mayClaimActivationFocus` answers "may this claim happen at
    // all"; it deliberately permits a claim on a card the engine already
    // serves, because a card's own keyboard is not something to be stolen
    // from. What must not happen is the RESOLUTION overwriting a live ring —
    // a question about which target to realize, which belongs here.
    const manager = getFocusManager();
    if (
      manager !== null &&
      manager.keyCard() === cardId &&
      manager.keyView() !== null
    ) {
      return { kind: "none" };
    }
    if (hostRoot === null || !hostRoot.isConnected) {
      return { kind: "none" };
    }
    return { kind: "default-focus", cardRoot: hostRoot };
  }

  if (focus.kind === "engine") {
    if (store.hasEngineHooks(cardId)) {
      return { kind: "engine", cardId };
    }
    return { kind: "deferred-engine", cardId };
  }

  // Framework-axis kinds: `dom` / `form-control`. Resolve the
  // concrete element via the host-root-scoped selector. Reachable
  // only by non-engine cards — a content-owning + engine card never
  // carries a `dom` / `form-control` `bag.focus`.
  const deferredKeyboard = focus.kind === "dom" ? focus.keyboard === true : false;
  if (hostRoot === null || !hostRoot.isConnected) {
    // No host root yet. `deferred-dom` is a graceful no-focus outcome for the
    // one-shot callers; the `keyboard` flag arms a late-mount ring resume in
    // `applyBagFocus` (an item-group focusable in a Radix/portal subtree can
    // mount after this dispatch).
    const key =
      focus.kind === "dom" ? focus.focusKey : focus.componentStatePreservationKey;
    return { kind: "deferred-dom", cardId, focusKind: focus.kind, key, keyboard: deferredKeyboard };
  }
  const selector =
    focus.kind === "dom"
      ? `[data-tug-focus-key="${CSS.escape(focus.focusKey)}"]`
      : `[data-tug-state-key="${CSS.escape(focus.componentStatePreservationKey)}"]`;
  const el = hostRoot.querySelector<HTMLElement>(selector);
  if (el === null || !el.isConnected) {
    const key =
      focus.kind === "dom" ? focus.focusKey : focus.componentStatePreservationKey;
    return { kind: "deferred-dom", cardId, focusKind: focus.kind, key, keyboard: deferredKeyboard };
  }
  return {
    kind: "framework",
    el,
    sourceKind: focus.kind,
    keyboard: focus.kind === "dom" ? focus.keyboard === true : false,
  };
}

/**
 * Options for {@link applyBagFocus}.
 */
export interface ApplyBagFocusOptions {
  /**
   * Site tag for `focus-call` / `focus-measurement` trace events.
   * Defaults to `"apply-bag-focus"`. Callers that want to preserve
   * legacy site tags (e.g. `"focus-transfer"`) pass their own.
   */
  site?: string;
  /**
   * When true, framework `el.focus()` is called with
   * `{ preventScroll: true }`. Used by
   * `reactivateCurrentFocusDestination` so window-focus
   * reactivation does not scroll the focused element back into
   * view ([L23] — preserve user-visible scroll).
   */
  preventScroll?: boolean;
  /**
   * The input modality of the activation gesture itself. `"keyboard"`
   * declares a keyboard-driven activation (Cmd-L, pane cycling): the
   * adopted card's retained key view is re-asserted as a keyboard
   * destination (ring + reveal + keyboard landing), and any placement
   * this dispatch performs asserts keyboard modality — a keyboard
   * gesture must SHOW where the keyboard landed. Omitted, every branch
   * keeps its historical modality (pointer restores never ring).
   */
  modality?: FocusModality;
}

/**
 * Single-channel focus dispatcher — the [L05] / [L23] gate.
 *
 * Reads `bag.focus` via {@link resolveBagFocus}, then performs the
 * resolved side effect:
 *
 *   - `framework` → `el.focus()`, unless the element is already
 *     `document.activeElement` — then yield (idempotency guard)
 *     and return `"applied"` without re-calling. Emit a
 *     `focus-call` trace event either way.
 *   - `engine` → `store.invokeEnginePaintMirrorAsActive(cardId)`.
 *     The engine hook is internally idempotent — the guard above
 *     applies only to the framework branch.
 *   - `default-focus` → `traceApplyDefaultFocus`.
 *   - `deferred-dom` / `deferred-engine` → return `"deferred"`.
 *     `deferred-engine` is retried by CardHost's
 *     `subscribeEngineHooksChange` channel; `deferred-dom` is a
 *     graceful no-focus outcome for the one-shot callers.
 *   - `none` → return `"applied"` (idempotent no-op).
 *
 * Returns `"applied"` for any resolution that committed (or that
 * was a definitive no-op) and `"deferred"` only when the caller
 * should retry. This function does not install observers.
 */
export function applyBagFocus(
  cardId: string,
  store: FocusTransferStore,
  options?: ApplyBagFocusOptions,
): "applied" | "deferred" {
  const site = options?.site ?? "apply-bag-focus";
  const keyboardGesture = options?.modality === "keyboard";

  // [P21] activation drives the key card. This is THE focus-activation channel
  // (click / tab switch / pane activation / cross-pane move / window blur→focus /
  // cold boot all dispatch here), so it is the single seam that names the key
  // card: adopt this card and project its focus context. [P20] then falls out —
  // if the card's context already owns a pushed key destination (a pending
  // card-modal dialog's trap, a mid-flow focus-cycle, a descended scope), THAT is
  // the card's focus destination, not the resting editor: `adoptKeyCard` lands
  // focus on it and reports `true`, and we skip the framework/engine claim below.
  // A resting card (base mode) reports `false` and falls through unchanged. A
  // keyboard-modality activation additionally re-asserts the adopted card's
  // retained key view as a keyboard destination (ring + reveal), so a `true`
  // also means "the keyboard landed somewhere visible".
  if (
    getFocusManager()?.adoptKeyCard(
      cardId,
      keyboardGesture ? { modality: "keyboard" } : undefined,
    ) === true
  ) {
    return "applied";
  }

  let resolution = resolveBagFocus(cardId, store);

  if (resolution.kind === "none") return "applied";
  if (
    resolution.kind === "deferred-dom" ||
    resolution.kind === "deferred-engine"
  ) {
    // The saved focusable isn't in the DOM yet (an item-group stop inside a
    // Radix/portal subtree that late-mounts). Record the target through the
    // one primitive: an unrealized keyboard `focus-key` placement arms the
    // engine's declarative late-mount realization — the placement re-runs
    // when a matching focusable registers. Focus itself is not retried for
    // pointer restores (the one-shot contract).
    if (
      resolution.kind === "deferred-dom" &&
      (resolution.keyboard === true || keyboardGesture)
    ) {
      getFocusManager()?.place(
        cardId,
        resolution.focusKind === "dom"
          ? { kind: "focus-key", focusKey: resolution.key }
          : { kind: "state-key", key: resolution.key },
        { modality: "keyboard" },
      );
    }
    // A keyboard activation must not end with the keyboard nowhere: when the
    // named target is simply GONE (the card's content changed while it was in
    // the background — a slotted row whose card closed), the armed placement
    // is a ghost that may never realize. Fall through to the default walk so
    // the keyboard lands a live, ringed destination now; the walk's placement
    // supersedes the ghost through the same primitive. Pointer restores keep
    // the one-shot "deferred is a graceful no-focus outcome" contract.
    const fm = getFocusManager();
    const cardRoot = store.peekCardHostRoot(cardId);
    if (
      keyboardGesture &&
      resolution.kind === "deferred-dom" &&
      cardRoot !== null &&
      cardRoot.isConnected &&
      fm !== null &&
      fm.keyCard() === cardId &&
      fm.keyView() === null
    ) {
      resolution = { kind: "default-focus", cardRoot };
    } else {
      return "deferred";
    }
  }

  if (resolution.kind === "framework") {
    // One placement, one primitive: the paint half (`data-key-view-kbd`) and
    // the focus half (`el.focus()`) land in the same atomic pass — the
    // historical two-write shape here (focus, then a separate `setKeyView`
    // fixup) was the drift bug in miniature. `place` carries the
    // idempotency guard (a redundant mount-time re-`focus()` can drop focus
    // to body in WebKit) and `preventScroll` on every engine focus write.
    const fm = getFocusManager();
    const el = resolution.el;
    const doc = el.ownerDocument;
    const activeBefore = formatElement(doc.activeElement);
    const targetSelector =
      resolution.sourceKind === "dom"
        ? `[data-tug-focus-key=...]`
        : `[data-tug-state-key=...]`;
    const target: FocusTarget | null =
      resolution.sourceKind === "dom"
        ? (() => {
            const focusKey = el.getAttribute("data-tug-focus-key");
            return focusKey !== null
              ? { kind: "focus-key", focusKey }
              : null;
          })()
        : (() => {
            const key = el.getAttribute("data-tug-state-key");
            return key !== null ? { kind: "state-key", key } : null;
          })();
    if (fm !== null && target !== null) {
      measureFocusClaim(`${site}:framework`, cardId, doc, () => {
        fm.place(cardId, target, {
          modality:
            resolution.keyboard === true || keyboardGesture
              ? "keyboard"
              : "pointer",
          preventScroll: options?.preventScroll,
        });
      });
    } else if (fm === null && doc.activeElement !== el) {
      // No engine mounted (headless bootstrap): the direct claim, with the
      // same idempotency guard. With an engine MOUNTED, an element the
      // target union cannot name (a plain default-focus button with no
      // focus-key / state-key) gets NO DOM focus claim: engine-routed
      // stops no longer hold DOM focus ([P08] of keyboard-as-engine-state
      // — a raw claim here was the boot-time steal the watchdog ledgered
      // on every card activation), and the keyboard rests at the engine
      // until the user walks or clicks to a stop.
      measureFocusClaim(`${site}:framework`, cardId, doc, () => {
        el.focus(
          options?.preventScroll === true ? { preventScroll: true } : undefined,
        );
      });
    }
    deckTrace.record({
      kind: "focus-call",
      site,
      cardId,
      targetSelector,
      activeBefore,
      activeAfter: formatElement(doc.activeElement),
      hidden: isElementHidden(el),
    });
    return "applied";
  }

  if (resolution.kind === "engine") {
    // Engine claim: recorded as the card's focus target and realized
    // through the engine's single write primitive — `place` gates on
    // key-card authority (this caller adopted the key card above) and
    // invokes the registered hook, which records its own
    // `engine-paint-mirror-active` event tagged `caller: "via-engine-hook"`.
    // `pointer` modality: the caret is the focus mark; engine restores
    // never ring.
    const fm = getFocusManager();
    const doc =
      store.peekCardHostRoot(cardId)?.ownerDocument ??
      (typeof document !== "undefined" ? document : null);
    const invoke = (): void => {
      if (fm !== null) {
        fm.place(cardId, { kind: "engine" }, { modality: "pointer" });
      } else {
        store.invokeEnginePaintMirrorAsActive(cardId);
      }
    };
    if (doc !== null) {
      measureFocusClaim(`${site}:engine`, cardId, doc, invoke);
    } else {
      invoke();
    }
    return "applied";
  }

  // default-focus. Engine-first: a nameable default target places through
  // the one primitive; an unnameable one (the plain first-tabbable
  // catch-all) gets NO DOM focus claim while an engine is mounted ([P08]
  // — engine-routed stops no longer hold DOM focus, and the raw claim was
  // a per-activation steal in the watchdog's ledger). The keyboard rests
  // at the engine; Tab and clicks reach the stops. The raw `.focus()`
  // inside `traceApplyDefaultFocus` survives only for engine-less
  // bootstraps (gallery previews, headless).
  // A keyboard-driven activation asserts its own modality on the default
  // placement — the walk's landing must wear the ring and be revealed, or the
  // gesture ends with the keyboard somewhere invisible. Pointer/lifecycle
  // activations keep the historical quiet restore (`pointer`, no scroll).
  const walkOpts = keyboardGesture
    ? ({ modality: "keyboard" } as const)
    : ({ modality: "pointer", preventScroll: true } as const);
  traceApplyDefaultFocus(`${site}-default`, cardId, resolution.cardRoot, {
    ...(options?.preventScroll === true ? { preventScroll: true } : {}),
    placeViaEngine: (target) => {
      const fm = getFocusManager();
      if (fm === null) return false;
      const focusKey = target.getAttribute("data-tug-focus-key");
      if (focusKey !== null && focusKey !== "") {
        fm.place(cardId, { kind: "focus-key", focusKey }, walkOpts);
        return true;
      }
      const stateKey = target.getAttribute("data-tug-state-key");
      if (stateKey !== null && stateKey !== "") {
        fm.place(cardId, { kind: "state-key", key: stateKey }, walkOpts);
        return true;
      }
      const responderId = target
        .closest("[data-responder-id]")
        ?.getAttribute("data-responder-id");
      if (
        responderId !== undefined &&
        responderId !== null &&
        fm.responderHasFocusContract(responderId)
      ) {
        fm.place(cardId, { kind: "responder", responderId }, walkOpts);
        return true;
      }
      // Unnameable engine-routed stop: no DOM focus claim — but the raw
      // claim used to do a SECOND job through its focusin (chain
      // promotion), and that half must survive: settle the first
      // responder on the target's nearest responder so accelerators and
      // the cancel ladder route into the card's content (the Lens's
      // Escape focus-out lives on a content-local responder the upward
      // walk can only reach when FR starts at or below it).
      const chain = getResponderChainManager();
      if (chain !== null) {
        const responder = chain.findResponderForTarget(target);
        if (responder !== null && chain.getFirstResponder() !== responder) {
          chain.makeFirstResponder(responder);
        }
      }
      return true;
    },
  });
  return "applied";
}

/**
 * Options for {@link transferFocusForActivation}.
 *
 * Stabilized once `transferFocusForActivation` shipped. Summarized so
 * early wire-in stays typed.
 */
export interface TransferFocusForActivationOptions {
  /**
   * The card losing first-responder status. `null` when the new
   * activation has no prior active card (cold-boot or first
   * activation after an empty-canvas deselect). When non-null and
   * `outgoingWillBeDestroyed !== true`, the caller's save callback
   * for the outgoing card is invoked before the mutation runs.
   */
  outgoingCardId: string | null;
  /** The card becoming first responder. */
  incomingCardId: string;
  /** The deck store used for bag reads, host-root lookup, and dispatch. */
  store: IDeckManagerStore;
  /**
   * Closure the helper invokes (inside `flushSync`) to commit the
   * React-visible state change that drives the activation (e.g.
   * `setActiveCardInPane`, `activateCard`). The helper must control
   * commit timing so the incoming card's `display: none` style
   * flips to `display: contents` before the resolver reads the DOM.
   *
   * Optional only in contexts where the commit happened elsewhere
   * and the helper is purely restoring focus to an already-visible
   * card (rare; the drag path is the primary caller there).
   */
  commitMutation?: () => void;
  /**
   * When `true`, skip the outgoing-save step because the outgoing
   * card is being destroyed by the same mutation (e.g. close
   * handoff). Saving into a card that's about to be removed is
   * wasted work at best and may write through to the persistence
   * layer after the id is gone.
   */
  outgoingWillBeDestroyed?: boolean;
  /**
   * The input modality of the activation gesture. `"keyboard"` marks a
   * keyboard-driven activation (Cmd-L): the incoming card's restored
   * key view is asserted as a keyboard destination — ring visible,
   * revealed — instead of replaying whatever modality it was left
   * with. See {@link ApplyBagFocusOptions.modality}.
   */
  modality?: FocusModality;
}

/**
 * Save the outgoing card's bag, commit the activation mutation,
 * resolve the incoming card's target, gate through the focus-theft
 * rules, and transfer focus / DOM selection.
 *
 * The single emitter of `focus-call` events for click / tab /
 * close-handoff activations; wired into `pane-focus-controller`,
 * `tug-pane#performSelectCard`, and `deck-manager#_removeCard` /
 * `_closePane`.
 */
export function transferFocusForActivation(
  options: TransferFocusForActivationOptions,
): void {
  const {
    outgoingCardId,
    incomingCardId,
    store,
    commitMutation,
    outgoingWillBeDestroyed,
    modality,
  } = options;

  // Step 1 — Save outgoing + hand its selection over to the
  // inactive-paint channel.
  //
  // Skipped when there is no outgoing (`null`), when the same card
  // is "transitioning" to itself (no-op activation), or when the
  // outgoing card is being destroyed by the same mutation
  // (`_removeCard` / `_closePane` already runs
  // `flushSaveCallbackBeforeDestruction` in its phase 2).
  //
  // The deactivation callback fires before the activation mutation
  // commits, so the outgoing card's editor routes its selection into
  // `selectionGuard.cardRanges` (via `paintMirrorAsInactive(publish)`)
  // before the incoming card's activation hook runs
  // `setSelectedRange` — which would otherwise call
  // `removeAllRanges()` on the global Selection and destroy the
  // outgoing card's selection. [L23] enforcement.
  if (
    outgoingCardId !== null &&
    outgoingCardId !== incomingCardId &&
    outgoingWillBeDestroyed !== true
  ) {
    store.invokeSaveCallback(outgoingCardId);
    store.invokeDeactivationCallback(outgoingCardId, "transfer-for-activation");
  }

  // Step 2 — Commit the mutation.
  //
  // `flushSync` forces React to apply the store-driven render
  // synchronously inside this call, so by the time the resolver
  // runs in step 3 the incoming card's subtree has already
  // transitioned from `display: none` to `display: contents`
  // (intra-pane tab switch in `tug-pane.tsx#performSelectCard`)
  // and the host root is mounted (close-handoff in `_removeCard`).
  // For callers that are outside React's event system already
  // (document-level pointerdown listeners), `useSyncExternalStore`
  // would force the same synchronous re-render even without
  // `flushSync` — but wrapping unconditionally is harmless and
  // keeps the contract uniform.
  if (commitMutation !== undefined) {
    flushSync(() => {
      commitMutation();
    });
  }

  // Step 3 — Ask the engine whether this claim is permitted (Spec S03).
  //
  // Post-commit, so the DOM is consistent with the store snapshot handed to
  // the query.
  if (
    !mayClaimActivationFocus(incomingCardId, store.getSnapshot(), {
      reason: "focus-transfer",
    })
  ) {
    return;
  }

  // Step 4 — Single-channel dispatch via `applyBagFocus`.
  //
  // `applyBagFocus` reads `bag.focus`, resolves to one of
  // `framework` / `engine` / `default-focus` / `deferred-*` /
  // `none`, and performs the resolved side effect. For a
  // content-owning + engine card it routes to
  // `store.invokeEnginePaintMirrorAsActive(cardId)` — the engine's
  // own activation paint, invoked through the framework's single
  // channel.
  const result = applyBagFocus(incomingCardId, store, {
    site: "focus-transfer",
    ...(modality !== undefined ? { modality } : {}),
  });

  // Step 5 — Post-dispatch follow-ups (selection / form-control).
  //
  // `applyBagFocus` owns the focus claim only. Adjacent axes
  // (`bag.domSelection`, `bag.formControls`) ride separate channels;
  // restore them post-dispatch.
  if (result === "applied") {
    const bag = store.getCardState(incomingCardId);
    const cardRoot = store.peekCardHostRoot(incomingCardId);
    if (
      bag?.domSelection !== undefined &&
      bag.domSelection !== null &&
      cardRoot !== null
    ) {
      selectionGuard.restoreCardDomSelection(
        incomingCardId,
        bag.domSelection,
        cardRoot,
      );
      deckTrace.record({
        kind: "selection-restore",
        cardId: incomingCardId,
        via: "restoreCardDomSelection",
      });
    }
  }

  // Step 6 — Outgoing-card blur safety net.
  //
  // When the dispatcher resolved to `engine` (no DOM mutation on
  // OUTGOING) or to an engine whose `paintMirrorAsActive` didn't
  // claim focus (no engine hooks registered yet), the prior
  // `document.activeElement` may still be inside the outgoing
  // card. The blur safety net deterministically removes it so the
  // user cannot keep typing into a card they just deactivated.
  blurFocusInOutgoingCard(store, outgoingCardId, incomingCardId);

  // Step 7 — Activation callback (mirror image of the Step 1
  // deactivation callback).
  //
  // Fires after focus has landed on the incoming card, so consumers
  // run with the card interactive again. The text card uses this to
  // recheck its file against disk (files outside the FILESYSTEM
  // watcher's workspace roots get no change events, so a click into
  // the card is the moment an external edit is caught); the editor
  // engines use it to drop their inactive scroll/draft snapshots.
  // Idempotent for every registered consumer.
  store.invokeActivationCallback(incomingCardId, "transfer-for-activation");
}

/**
 * If `document.activeElement` is still inside the OUTGOING card root
 * after an activation transition, blur it. Used as a safety net at the
 * end of `transferFocusForActivation` where the incoming card's
 * dispatch may not focus anything (gallery cards, content shells with
 * no engine, an engine whose hooks aren't registered yet) — without
 * the blur, the prior focus persists in the now-inactive card and the
 * user can keep typing into a card they just deactivated.
 *
 * Idempotent and tightly scoped:
 *   - No-op when there is no outgoing card.
 *   - No-op when outgoing === incoming (same-card activation).
 *   - No-op when current focus is already outside the outgoing card
 *     (the transition's focus side-effects already moved it).
 *   - Reads `document.activeElement` directly — post-commit DOM is
 *     consistent with the store snapshot at this point.
 *
 * Does not call `.focus()` on anything — that would risk picking the
 * wrong target. Blurring to body is the conservative move; the next
 * gesture (click, keystroke) drives the next focus.
 */
function blurFocusInOutgoingCard(
  store: FocusTransferStore,
  outgoingCardId: string | null,
  incomingCardId: string,
): void {
  if (outgoingCardId === null) return;
  if (outgoingCardId === incomingCardId) return;
  const outgoingRoot = store.peekCardHostRoot(outgoingCardId);
  if (outgoingRoot === null) return;
  const doc = outgoingRoot.ownerDocument;
  const active = doc.activeElement;
  if (!(active instanceof HTMLElement)) return;
  if (!outgoingRoot.contains(active)) return;
  active.blur();
}


/**
 * Options for {@link captureFocusForDragStart}.
 */
export interface CaptureFocusForDragStartOptions {
  /** The card whose drag gesture is starting. */
  sourceCardId: string;
  /** The deck store used for bag reads and save invocation. */
  store: IDeckManagerStore;
}

/**
 * Snapshot focus and DOM selection for a card whose pane / tab is
 * being dragged. Called unconditionally on the gesture-start
 * pointerdown — even if the click never crosses the drag threshold,
 * a save is cheap and idempotent with the subsequent debounced
 * save. Capturing on pointerdown (before the browser's mousedown
 * default has a chance to blur the focused element inside the
 * card) is the only place that can preserve `bag.focus` and
 * `bag.domSelection` across a drag gesture.
 *
 * The save is delegated to the store's per-card save callback so
 * the captured bag picks up everything (focus, scroll, selection,
 * form-controls, region-scrolls, opt-in components) in one pass —
 * the same surface the close-handoff and debounced saves use.
 *
 * Idempotent on no-op: if the card has no registered save callback
 * (orchestrator hasn't seen a `registerSaveCallback` for this id
 * yet — possible if the gesture starts pre-mount on an unloaded
 * deck), `invokeSaveCallback` no-ops silently.
 */
export function captureFocusForDragStart(
  options: CaptureFocusForDragStartOptions,
): void {
  options.store.invokeSaveCallback(options.sourceCardId, "manual");
}

/**
 * Options for {@link transferFocusAfterMove}.
 */
export interface TransferFocusAfterMoveOptions {
  /** The card whose drag gesture just committed. */
  sourceCardId: string;
  /** The deck store used for bag reads and host-root lookup. */
  store: IDeckManagerStore;
}

/**
 * Restore focus and DOM selection to `sourceCardId` after a drop /
 * re-parent commits, or after a drag is cancelled (Escape /
 * pointercancel). Three-step body — no save here; drag-start
 * already captured the bag.
 *
 *   1. Ask the engine for permission (`mayClaimActivationFocus`).
 *   2. Single-channel dispatch via {@link applyBagFocus}.
 *   3. Post-dispatch DOM-selection restore.
 *
 * Called by `deck-manager#_detachCard` / `_moveCardToPane` after
 * their `notify()` (so the moved card's DOM is in its post-commit
 * location), and by the drag coordinator's onDragCancel hook
 * (Escape / pointercancel — no commit ran, focus restores into the
 * card's original DOM location). React reconciliation has already
 * landed at the moment the helper runs in both cases, so no
 * `flushSync` is needed (the helper does no `commitMutation` of its
 * own).
 */
export function transferFocusAfterMove(
  options: TransferFocusAfterMoveOptions,
): void {
  const { sourceCardId, store } = options;

  // Step 1 — Permission (Spec S03).
  if (
    !mayClaimActivationFocus(sourceCardId, store.getSnapshot(), {
      reason: "focus-transfer-after-move",
    })
  ) {
    return;
  }

  // Step 2 — Single-channel dispatch.
  const result = applyBagFocus(sourceCardId, store, {
    site: "focus-transfer-after-move",
  });

  // Step 3 — Post-dispatch DOM-selection restore.
  if (result === "applied") {
    const bag = store.getCardState(sourceCardId);
    const cardRoot = store.peekCardHostRoot(sourceCardId);
    if (
      bag?.domSelection !== undefined &&
      bag.domSelection !== null &&
      cardRoot !== null
    ) {
      selectionGuard.restoreCardDomSelection(
        sourceCardId,
        bag.domSelection,
        cardRoot,
      );
      deckTrace.record({
        kind: "selection-restore",
        cardId: sourceCardId,
        via: "restoreCardDomSelection",
      });
    }
  }
}

/**
 * Re-focus the current first responder after the tugdeck window
 * regains OS focus (cmd-tab return, click-back-from-Finder, etc.).
 *
 * Called from `installDeckStoreFocusListeners`'s window-`focus`
 * handler, AFTER `setHasFocus(true)` has flipped the gate axis.
 * Three-step body — no save here; the companion window-`blur`
 * handler already flushed the bag synchronously before the
 * `hasFocus` axis went false:
 *
 *   1. Resolve `cardId` from `store.getFirstResponderCardId()`. If
 *      `null` (canvas-background deselect, or boot before the first
 *      activation), return — there is no destination to reactivate.
 *   2. Ask the engine for permission (`mayClaimActivationFocus`).
 *      Its `state.hasFocus` rule is correctly `true` at this point
 *      because the listener flipped it to `true` immediately before
 *      this call.
 *   3. Single-channel dispatch via {@link applyBagFocus} with
 *      `preventScroll: true` ([L23] — preserve user-visible scroll
 *      across cmd-tab return; the default `focus()` semantics scroll
 *      the focused element into view, which in a session-card
 *      (transcript above + editor below) drags the transcript
 *      downward whenever the editor re-claims focus on cmd-tab
 *      return).
 *   4. Post-dispatch DOM-selection restore for `applied` results
 *      that carry a saved `bag.domSelection`.
 *
 * No `commitMutation`. The window-`focus` event arrives outside any
 * pending React commit; React reconciliation has already drained
 * by the time the helper runs, so `flushSync` would be redundant.
 */
export function reactivateCurrentFocusDestination(
  store: IDeckManagerStore,
): void {
  const cardId = store.getFirstResponderCardId();
  if (cardId === null) return;

  // Step 1 — Permission (Spec S03).
  if (
    !mayClaimActivationFocus(cardId, store.getSnapshot(), {
      reason: "focus-transfer-reactivate",
    })
  ) {
    return;
  }

  // Step 2 — Single-channel dispatch via `applyBagFocus`.
  const result = applyBagFocus(cardId, store, {
    site: "focus-transfer-reactivate",
    preventScroll: true,
  });

  // Step 3 — Post-dispatch DOM-selection restore.
  if (result === "applied") {
    const bag = store.getCardState(cardId);
    const cardRoot = store.peekCardHostRoot(cardId);
    if (
      bag?.domSelection !== undefined &&
      bag.domSelection !== null &&
      cardRoot !== null
    ) {
      selectionGuard.restoreCardDomSelection(
        cardId,
        bag.domSelection,
        cardRoot,
      );
      deckTrace.record({
        kind: "selection-restore",
        cardId,
        via: "restoreCardDomSelection",
      });
    }
  }
}

/**
 * Raise a card: front it in its pane, reorder the panes so it comes forward,
 * and hand it the responder chain — the whole of what a click on a card does,
 * for a caller that has only the card's id.
 *
 * `store.activateCard` alone flips the responder and leaves the pane buried;
 * the raise is the mutation committed INSIDE `transferFocusForActivation`, so
 * the will/didDeactivate + will/didActivate transition fires and the incoming
 * card is visible before the resolver reads its DOM. Every caller that means
 * "go to this card" comes here rather than assembling that pair again.
 */
export function raiseCard(
  store: IDeckManagerStore,
  cardId: string,
  modality?: FocusModality,
): void {
  transferFocusForActivation({
    outgoingCardId: store.getFirstResponderCardId(),
    incomingCardId: cardId,
    store,
    commitMutation: () => {
      store.activateCard(cardId);
    },
    modality,
  });
}
