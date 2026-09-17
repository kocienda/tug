/**
 * CardHost — wiring harness for a card's per-content state.
 *
 * CardHost lives at the deck level in the React tree; its DOM output
 * portals into the host pane's content `<div>` via `CardPortal`, so
 * React-tree position (and therefore identity) stays stable across
 * cross-pane moves — the mechanism that preserves session card sessions
 * across detach / merge / pane-to-pane moves.
 *
 * Per-concern state is delegated to hooks under `tugways/hooks/`:
 * `useCardPropertyStore`, `useCardDirtyState`, and `useCardFeedStore`.
 * The harness itself owns only the cross-cutting wiring:
 * `hostContentEl` / `hostCardRootEl` registry lookups, the per-card
 * `saveCurrentCardState` closure, state-preservation-callback registration,
 * the `registerSaveCallback(cardId, …)` binding into DeckManager, the
 * card-level responder that routes `SET_PROPERTY`, and the
 * context-provider tree wrapping the content factory.
 *
 * ## Restoration
 *
 * CardHost orchestrates restore for every axis of `CardStateBag`;
 * per-axis translation is delegated to the axis's owner (see [L10]).
 * Restoration is trigger-driven, not React-dep-gated:
 *
 *   1. **Content restore** fires from a CardHost-owned
 *      `useLayoutEffect` keyed on `[cardId, hostContentEl, store]`,
 *      after `registerStatePreservationCallbacks` has merely stored the
 *      child's callbacks. CardHost's effects fire AFTER CardPortal's
 *      own `useLayoutEffect` has appended the portal slot to the
 *      host pane's content element — so the engine root is
 *      connected to the document at the moment `onRestore(bag.content)`
 *      runs and any `engine.setSelectedRange` (`.focus()` + `addRange`)
 *      inside it lands on a live node. This is the L04 ready-callback
 *      pattern; doing the restore synchronously inside
 *      `registerStatePreservationCallbacks` (called from a CHILD's effect,
 *      before the parent CardPortal can attach the slot) was the
 *      cold-boot selection-paint bug ([AT0010]). A `hasAppliedContentRestoreRef` guard keeps the
 *      restore one-shot so cross-pane moves (which re-fire the
 *      effect via `hostContentEl` change) don't clobber engine
 *      state the user may have edited since first mount. The
 *      effect also installs `onContentReady` (scroll restore +
 *      opacity unmask) before invoking `onRestore`.
 *   2. **Mount restore effect** (a `useLayoutEffect` keyed on
 *      `[cardId, hostStackId, hostContentEl]`) applies `bag.scroll`
 *      to `hostContentEl`, publishes `bag.domSelection` to
 *      `selectionGuard` (translation via `restoreCardDomSelection`),
 *      dispatches `bag.focus` via `applyBagFocus` (one-shot) when
 *      this card is the active card of the active pane ([D10]), and
 *      replays `bag.formControls` + `bag.regionScroll`. The
 *      `MutationObserver` scoped to the card root retries the
 *      region-scroll and DOM-selection restores so late-mounting
 *      elements settle when they appear — it does NOT retry focus.
 *      The one late-mount FOCUS path is `deferred-engine`: a
 *      late-mounting engine bumps `engineHooksVersion` via the
 *      `subscribeEngineHooksChange` channel, which joins the
 *      effect's dep array and re-runs the one-shot `applyBagFocus`.
 * Cross-pane-move focus restore is no longer a CardHost concern —
 * it lives in `focus-transfer.ts#transferFocusAfterMove`, called
 * from `deck-manager.ts#_detachCard` / `_moveCardToPane` (the
 * `[hostStackId]`-keyed effect that
 * previously lived here was removed). CardHost's mount-time restore (the
 * primary effect above) remains the cold-boot focus authority.
 *
 * Paint of the restored DOM selection is not CardHost's job — that's
 * selection-guard's paint authority, driven by its deck-store
 * subscription. CardHost's responsibility is to hand the snapshot to
 * the axis's owner at the right moment; the owner paints.
 *
 * Neither path uses `cardStatePreservationCallbacksRef` as a dep — refs do not
 * trigger re-renders, and a dep array is not how we coordinate. The
 * trigger is the store callsite (register, or host-element change).
 *
 * @module components/chrome/card-host
 */

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { CardDataProvider } from "../tugways/hooks/use-card-data";
import { CardPropertyContext } from "../tugways/hooks/use-property-store";
import { useCardPropertyStore } from "../tugways/hooks/use-card-property-store";
import { useCardFeedStore } from "../tugways/hooks/use-card-feed-store";
import { useCardDirtyState } from "../tugways/hooks/use-card-dirty-state";
import {
  CardStatePreservationContext,
  type CardStatePreservationCallbacks,
  type CardStatePreservationContextValue,
} from "../tugways/use-card-state-preservation";
import {
  CardComponentStatePreservationContext,
  type CardComponentStatePreservationContextValue,
  type SavedRegionScroll,
} from "../tugways/use-component-state-preservation";
import { CardDirtyContext, TugPaneFrameContext, TugPanePortalContext } from "./tug-pane";
import { useResponder } from "../tugways/use-responder";
import type { ActionEvent } from "../tugways/responder-chain";
import { TUG_ACTIONS } from "../tugways/action-vocabulary";
import { useDeckManager } from "../../deck-manager-context";
import { getRegistration } from "../../card-registry";
import { useSelectionBoundary } from "../tugways/hooks/use-selection-boundary";
import { nodeToPath, selectionGuard } from "../tugways/selection-guard";
import type {
  CardStateBag,
  DeckState,
  DomSelectionSnapshot,
  FocusSnapshot,
  FormControlSnapshot,
  RegionScrollSnapshot,
} from "../../layout-tree";
import * as paneContentRegistry from "./pane-content-registry";
import * as paneFrameRegistry from "./pane-frame-registry";
import * as paneRootRegistry from "./pane-root-registry";
import { CardPortal } from "./card-portal";
import { deckTrace, type SaveCallbackSource } from "../../deck-trace";
import { applyBagFocus } from "../../focus-transfer";
import { CardIdContext } from "@/lib/card-id-context";

/**
 * How long the pre-restore opacity mask may wait for the child commit that
 * normally lifts it, before it lifts itself.
 *
 * A deferred reveal carries a deadline ([L31], [L32]): the mask is written by
 * `CardHost` and, without this, lifted only by a party that may never act. The
 * value matches `ARRIVAL_REVEAL_BOUND_MS` (`lib/arrival-reveal.ts`), the deck's
 * sibling bound on the same kind of wait — long enough that the ordinary commit
 * always wins the race and the deadline never fires, short enough that a card
 * which lost the race is not blank for a length of time a person would notice.
 */
export const CONTENT_READY_BOUND_MS = 250;

export interface CardHostProps {
  /** Stable identity of this card — survives cross-pane moves. */
  cardId: string;
  /** The pane currently hosting this card. Used to locate the content element and for the workspace binding. */
  hostStackId: string;
  /** The registry componentId that produces this card's content via `contentFactory`. */
  componentId: string;
  /**
   * Whether this card is the active card within its host pane. When false,
   * the content mounts and stays alive but is hidden via `display: none` so
   * that identity (React state, session connections, scroll position)
   * survives across card switches and cross-pane moves. Defaults to `true`.
   */
  isActive?: boolean;
}

/**
 * Input types that accept a text selection via
 * `selectionStart` / `selectionEnd` / `setSelectionRange`. Reading or
 * writing those properties on other types (e.g. `checkbox`, `radio`,
 * `number`, `email`, `range`) throws `InvalidStateError`. This set
 * matches the HTML spec's "input type with selection APIs" list.
 */
const SELECTION_CAPABLE_INPUT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "search",
  "tel",
  "url",
  "password",
]);

function supportsTextSelection(
  el: HTMLInputElement | HTMLTextAreaElement,
): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  return SELECTION_CAPABLE_INPUT_TYPES.has(el.type);
}

/**
 * DOM-authority state preservation for native `<input>` and `<textarea>` elements
 * carrying `data-tug-state-key="<key>"`. Walks the card's own subtree
 * and snapshots each element's value, scroll, and selection offsets keyed
 * by the attribute value.
 *
 * **Scope matters.** The `root` passed here must be the card-host div
 * (`[data-card-host][data-card-id]`) — not the pane's content element.
 * Multiple cards inside one pane (tab-group panes) all portal into the
 * same pane-content `<div>`, so a query rooted at the pane would
 * cross-pollinate between sibling cards that happen to share a
 * `componentStatePreservationKey`. Rooting at the card-host div keeps `componentStatePreservationKey`
 * uniqueness a per-card concern, which is what the caller already
 * assumes.
 *
 * Selection is captured *regardless of focus* so the user's range
 * survives app resign and cross-card saves. Restore pairs with focus
 * restore (see [D10]): an unfocused input with selection state holds
 * it internally, and `::selection` paints the moment focus arrives.
 *
 * Only reads from the DOM (uncontrolled-input assumption — controlled
 * React-owned `value` is the caller's concern via `useCardStatePreservation`).
 * Selection reads on types that don't support it (checkbox, radio,
 * number, etc.) are skipped via a capability check; residual errors
 * are swallowed so one misbehaving input never blocks save.
 */
export function captureFormControls(
  root: HTMLElement,
): Record<string, FormControlSnapshot> | undefined {
  const result: Record<string, FormControlSnapshot> = {};
  const els = root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "[data-tug-state-key]",
  );
  for (const el of els) {
    const key = el.getAttribute("data-tug-state-key");
    if (!key) continue;
    const snap: FormControlSnapshot = {
      value: el.value,
      scrollTop: el.scrollTop,
      scrollLeft: el.scrollLeft,
    };
    if (supportsTextSelection(el)) {
      try {
        const { selectionStart, selectionEnd, selectionDirection } = el;
        if (selectionStart !== null) snap.selectionStart = selectionStart;
        if (selectionEnd !== null) snap.selectionEnd = selectionEnd;
        if (
          selectionDirection === "forward" ||
          selectionDirection === "backward" ||
          selectionDirection === "none"
        ) {
          snap.selectionDirection = selectionDirection;
        }
      } catch {
        // Some inputs report as selection-capable via .type but still
        // throw on property access (custom element polyfills, JSDOM
        // edge cases). Drop silently — the other axes still survive.
      }
    }
    result[key] = snap;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Serialize the card's currently-published Range (if any) into a
 * `DomSelectionSnapshot` rooted at `cardRoot`.
 *
 * `selectionGuard` owns the live Range (published by the card's content
 * component — e.g. `TugTextEngine.onSelectionChanged`). CardHost owns
 * the serialization shape into the bag: indices walked from the
 * card-boundary root, so paths survive cross-pane moves where the
 * card's DOM subtree travels intact but its surrounding pane changes.
 *
 * Returns `null` when:
 *   - the card has no published Range;
 *   - either endpoint is not a descendant of `cardRoot` (stale Range
 *     whose owner failed to re-publish after a DOM mutation, or a
 *     selection that genuinely escaped the boundary — either way, not
 *     serializable against this root).
 *
 * Pure read. Does not mutate `selectionGuard` state or the DOM.
 */
export function captureDomSelection(
  cardId: string,
  cardRoot: HTMLElement,
): DomSelectionSnapshot | null {
  const range = selectionGuard.getCardRange(cardId);
  if (!range) return null;
  const anchorPath = nodeToPath(cardRoot, range.startContainer);
  const focusPath = nodeToPath(cardRoot, range.endContainer);
  if (anchorPath === null || focusPath === null) return null;
  return {
    anchorPath,
    anchorOffset: range.startOffset,
    focusPath,
    focusOffset: range.endOffset,
    direction: selectionGuard.getCardSelectionDirection(cardId) ?? "forward",
  };
}

/**
 * Selectors that identify a focus-bearing element belonging to an
 * engine that owns its own focus + selection state together. Focus
 * on any such element serializes as `{ kind: "engine" }` — the
 * engine's `bag.content` carries the detail; `CardHost`'s
 * responsibility is only to remember which engine had focus.
 *
 * New owning engines add their marker attribute here. Keep selectors
 * tag-agnostic (attribute-based) so authors cannot accidentally match
 * bystander DOM.
 */
const COMPONENT_OWNED_SELECTORS: readonly string[] = [
  '[data-slot="tug-text-editor"]',
  // The Text card's editor is its own substrate (not a `TugTextEditor`), and
  // its host carries a `data-tug-focus-key` (it is a cycle stop) — without
  // this entry a caret there captures as `{ kind: "dom" }`, and any restore
  // replay places that focus-key as a hard grant into the editor.
  '[data-slot="tug-text-card-editor"]',
  // Legacy marker kept so existing focus-classifier tests built around
  // synthetic DOM continue to exercise the lookup logic; nothing in the
  // production tree writes this attribute now that the legacy substrate
  // is gone, but the second-position selector is harmless and forward
  // compatible with any future host that adopts the same convention.
  "[data-tug-prompt-input-root]",
];

/**
 * For each engine-owned root, the inner focusable element that
 * `applyFocusSnapshot` focuses when restoring `{ kind: "engine" }`.
 * Kept parallel with {@link COMPONENT_OWNED_SELECTORS}: both arrays
 * describe the same engines but from opposite sides — `closest(...)`
 * on save, `querySelector(...)` on restore. Order must match.
 */
const COMPONENT_OWNED_FOCUS_TARGETS: readonly string[] = [
  '[data-slot="tug-text-editor"] .cm-content',
  "[data-tug-prompt-input-root] [contenteditable]",
];

/**
 * Classify `document.activeElement` relative to the card root into one
 * of the four `FocusSnapshot` variants.
 *
 *   - Focus outside the card root (including `document.body`) → `none`.
 *   - `[data-tug-state-key]` wins over the other markers because
 *     a keyed form-control's focus is implicit in its componentStatePreservationKey (see
 *     [D10]) — no separate focus key needed.
 *   - `[data-tug-focus-key]` → `dom`; keyed via the attribute value.
 *   - Matches an engine-owned selector → `engine`.
 *   - Anything else → `none`.
 *
 * Pure read; does not mutate focus, selection, or any DOM state.
 */
export function captureFocus(cardRoot: HTMLElement): FocusSnapshot {
  // Single-argument: callers must only invoke this when focus is
  // expected to be inside the card. For the inactive-card save case
  // (focus has moved to a sibling card by save time) the right
  // answer is "preserve the previous bag.focus", not "use a stale
  // fallback" — that policy lives in the CardHost assembler so the
  // capture function itself can stay a pure read of the current DOM
  // + engine state.
  const active = cardRoot.ownerDocument.activeElement;
  if (active instanceof HTMLElement && cardRoot.contains(active)) {
    const componentStatePreservationKey = active.getAttribute("data-tug-state-key");
    if (componentStatePreservationKey !== null && componentStatePreservationKey !== "") {
      return { kind: "form-control", componentStatePreservationKey };
    }

    const focusKey = active.getAttribute("data-tug-focus-key");
    if (focusKey !== null && focusKey !== "") {
      // Carry the engine's keyboard-ring modality so it resumes on restore
      // (`data-key-view-kbd` is projected onto the key-view focusable).
      return { kind: "dom", focusKey, keyboard: active.hasAttribute("data-key-view-kbd") };
    }

    for (const selector of COMPONENT_OWNED_SELECTORS) {
      if (active.closest(selector)) return { kind: "engine" };
    }
  }

  // DOM focus is not inside the card (or classifies as nothing) — the
  // keyboard-as-engine-state case: an engine-routed key view parks
  // `document.activeElement` on the key sink, so the card's focus truth
  // lives in the ENGINE, not the register. Serialize from the key view's
  // projected element when it belongs to this card: `data-key-view` is
  // stamped on exactly one element (the engine's projection), and its
  // `data-tug-focus-key` is the same stable identity the DOM branch above
  // reads. The kbd attribute carries the ring modality, exactly as above.
  const keyViewEl = cardRoot.querySelector<HTMLElement>("[data-key-view]");
  if (keyViewEl !== null) {
    const focusKey = keyViewEl.getAttribute("data-tug-focus-key");
    if (focusKey !== null && focusKey !== "") {
      return {
        kind: "dom",
        focusKey,
        keyboard: keyViewEl.hasAttribute("data-key-view-kbd"),
      };
    }
  }

  return { kind: "none" };
}

// Phase E.11 Step 4k — `applyFocusSnapshot` retired. The cold-boot
// RESTORE focus claim routes through `applyBagFocus` (the
// single-channel dispatcher in `focus-transfer.ts`). The legacy
// "bail if focus is already inside the card" pre-check is now
// the D11 yield rule inside `applyBagFocus`'s framework branch.
// `COMPONENT_OWNED_FOCUS_TARGETS` is no longer referenced; the
// dispatcher resolves engine kind via `store.invokeEnginePaintMirrorAsActive`
// (which calls the engine's registered hook from Step 2 /
// Step 4e), not via DOM querySelector.

/**
 * Find this card's own DOM subtree root inside a pane's content element.
 * The `[data-card-host][data-card-id]` div is rendered by `CardHost`
 * itself and travels with the card across cross-pane moves (via the
 * stable `CardPortal` slot), so it is the authoritative per-card
 * scoping anchor for any DOM walk done by the host.
 */
function findCardRoot(
  hostContentEl: HTMLElement,
  cardId: string,
): HTMLElement | null {
  return hostContentEl.querySelector<HTMLElement>(
    `[data-card-host][data-card-id="${CSS.escape(cardId)}"]`,
  );
}

/**
 * True when `cardId` is the active card of the deck's active pane per
 * the store's current snapshot.
 *
 * Used by focus restore to enforce [D10]'s "Option B" gate: only the
 * one card that the user is actually looking at may steal focus on
 * cold boot or after a cross-pane move. Every other card keeps its
 * `bag.focus` data but does not disturb whatever the user is doing
 * elsewhere. [R07].
 */
function isActiveCardOfActivePane(
  store: { getSnapshot: () => DeckState },
  cardId: string,
): boolean {
  const state = store.getSnapshot();
  if (state.activePaneId === undefined) return false;
  const pane = state.panes.find((p) => p.id === state.activePaneId);
  if (pane === undefined) return false;
  return pane.activeCardId === cardId;
}

// Phase E.11 Step 4k — `isElementHidden` retired from this module.
// The dispatcher in `focus-transfer.ts` carries its own copy for
// the `focus-call` trace event's `hidden` field.

// Phase E.11 Step 4k — `traceApplyFocusSnapshot` retired together
// with `applyFocusSnapshot`. The cold-boot RESTORE site calls
// `applyBagFocus` directly; the dispatcher emits its own
// `focus-call` and `focus-measurement` events through the
// `measureFocusClaim` helper in `focus-transfer.ts`. The
// `applyFocusSnapshot` site tag survives as a
// `SelectionRestoreVia` string in `deck-trace.ts` for trace-log
// continuity with pre-E.11 entries.

/**
 * Apply a saved `FormControlSnapshot` to an element. Idempotent guard at the
 * call site (via a `WeakSet`) keeps user typing from being overwritten on
 * subsequent mutation-observer fires.
 *
 * Order matters: value is restored first so `setSelectionRange` lands
 * against the correct string length; scroll is restored last so the
 * browser's own scroll-into-view side effect from `setSelectionRange`
 * does not override the saved scroll position.
 *
 * Selection restore is no-op when the element's type does not support
 * it, and any residual error from `setSelectionRange` is swallowed —
 * one misbehaving input must not abort the rest of the restore walk.
 */
export function applyFormControlSnapshot(
  el: HTMLInputElement | HTMLTextAreaElement,
  snap: FormControlSnapshot,
): void {
  if (el.value !== snap.value) el.value = snap.value;
  if (
    supportsTextSelection(el) &&
    snap.selectionStart !== undefined &&
    snap.selectionEnd !== undefined
  ) {
    try {
      el.setSelectionRange(
        snap.selectionStart,
        snap.selectionEnd,
        snap.selectionDirection,
      );
    } catch {
      // See captureFormControls for the matching symmetry.
    }
  }
  if (snap.scrollTop !== undefined) el.scrollTop = snap.scrollTop;
  if (snap.scrollLeft !== undefined) el.scrollLeft = snap.scrollLeft;
}

/**
 * DOM-authority state preservation for nested scrollable regions inside a card.
 *
 * Walks the card subtree for every element carrying
 * `data-tug-scroll-key="<key>"` and snapshots its `scrollLeft` /
 * `scrollTop`. Symmetric with {@link captureFormControls}: same
 * opt-in / keyed model, same scope rules — roots at the card-host
 * div so sibling cards in a tab-group pane cannot cross-pollinate.
 *
 * Returns `undefined` when no matching regions exist, so `saveCurrentCardStateRef`
 * can omit the axis from the bag entirely and keep empty-card bags
 * light.
 *
 * `bag.scroll` covers the outer `hostContentEl` scroll; this helper
 * handles the inner virtualized scrollers that the user scrolled
 * independently (e.g. `tug-markdown-view`).
 */
export function captureRegionScrolls(
  root: HTMLElement,
): RegionScrollSnapshot | undefined {
  const result: RegionScrollSnapshot = {};
  const els = root.querySelectorAll<HTMLElement>("[data-tug-scroll-key]");
  for (const el of els) {
    const key = el.getAttribute("data-tug-scroll-key");
    if (!key) continue;
    const entry: { x: number; y: number; meta?: unknown } = {
      x: el.scrollLeft,
      y: el.scrollTop,
    };
    // Optional per-region metadata. Regions that need richer
    // semantics than raw `{x, y}` (variable-height virtualized lists
    // anchoring on cell index + pixel-within-cell, etc.) write a
    // JSON-encoded payload to `data-tug-scroll-state`. The framework
    // captures it verbatim and forwards on restore via the
    // `tug-region-scroll-set` event detail; the region's listener
    // decodes its own semantics. Malformed JSON is logged in dev and
    // silently dropped — capture must not throw during teardown.
    const stateAttr = el.getAttribute("data-tug-scroll-state");
    if (stateAttr !== null && stateAttr.length > 0) {
      try {
        entry.meta = JSON.parse(stateAttr);
      } catch {
        // Drop malformed metadata. The `{x, y}` axis still rides.
      }
    }
    result[key] = entry;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Apply a saved {@link RegionScrollSnapshot} to every matching
 * `data-tug-scroll-key` element currently in the card subtree.
 * Unknown keys in the snapshot are skipped; extra regions in the DOM
 * without a saved entry are left alone.
 *
 * Called from the mount restore effect (after `hostContentEl` scroll)
 * and re-applied when the card's subtree grows via `MutationObserver`
 * so late-mounting scrollers (any that appear behind a content-factory
 * readiness gate) restore correctly.
 */
export function applyRegionScrolls(
  root: HTMLElement,
  snapshot: RegionScrollSnapshot,
): void {
  for (const [key, pos] of Object.entries(snapshot)) {
    const el = root.querySelector<HTMLElement>(
      `[data-tug-scroll-key="${CSS.escape(key)}"]`,
    );
    if (!el) continue;
    // Dispatch a cancelable `tug-region-scroll-set` event before
    // touching `scrollLeft` / `scrollTop` directly. Components like
    // `tug-markdown-view` that wrap their scroll container in a
    // SmartScroll instance listen for this event so they can
    // simultaneously (a) apply the requested scroll position and
    // (b) disengage SmartScroll's follow-bottom flag — without (b)
    // the next ResizeObserver-driven height refinement re-slams
    // `scrollTop` to the bottom, defeating cold-boot restore.
    // Generic scroll regions don't install a listener, so the
    // event is not preventDefaulted and we fall back to the direct
    // assignment.
    //
    // `meta` carries any opaque per-region payload captured from a
    // `data-tug-scroll-state` attribute at save time. Listeners that
    // understand richer semantics (variable-height virtualized
    // lists, etc.) decode it; legacy listeners that consume only
    // `{top, left}` ignore the field. See
    // `RegionScrollSnapshot` for the contract.
    const event = new CustomEvent<{
      top: number;
      left: number;
      meta?: unknown;
    }>("tug-region-scroll-set", {
      detail: { top: pos.y, left: pos.x, meta: pos.meta },
      cancelable: true,
      bubbles: false,
    });
    const wasHandled = !el.dispatchEvent(event);
    if (!wasHandled) {
      el.scrollLeft = pos.x;
      el.scrollTop = pos.y;
    }
  }
}

/**
 * Look up the host pane's content element from the registry, reactively:
 * re-fires when the element is registered, replaced, or unregistered.
 */
function useHostContentElement(hostStackId: string): HTMLDivElement | null {
  return useSyncExternalStore(
    (cb) => paneContentRegistry.subscribe(hostStackId, cb),
    () => paneContentRegistry.getElement(hostStackId),
    () => null,
  );
}

/**
 * Look up the host pane's root element from `pane-root-registry`,
 * reactively. Used to bridge `TugPanePortalContext` — card content needs
 * access to its host pane's root `<div>` for sheets and tooltips that
 * portal into it, and CardHost cannot consume the provider
 * directly because it lives outside the pane's React tree.
 */
function useHostStackRootElement(hostStackId: string): HTMLDivElement | null {
  return useSyncExternalStore(
    (cb) => paneRootRegistry.subscribe(hostStackId, cb),
    () => paneRootRegistry.getElement(hostStackId),
    () => null,
  );
}

/**
 * Look up the host pane's outer frame element from
 * `pane-frame-registry`, reactively. Used to bridge
 * `TugPaneFrameContext` — pane-modal surfaces (`TugSheet`) inside card
 * content need access to the `.tug-pane` frame as their portal target
 * so the panel paints inside the pane's stacking context [D19, D20].
 * Same parallel-registry pattern as `useHostStackRootElement` for
 * `TugPanePortalContext`.
 */
function useHostStackFrameElement(hostStackId: string): HTMLDivElement | null {
  return useSyncExternalStore(
    (cb) => paneFrameRegistry.subscribe(hostStackId, cb),
    () => paneFrameRegistry.getElement(hostStackId),
    () => null,
  );
}

export function CardHost({ cardId, hostStackId, componentId, isActive = true }: CardHostProps): React.ReactElement | null {
  const store = useDeckManager();
  const registration = getRegistration(componentId);
  const hostContentEl = useHostContentElement(hostStackId);
  const hostCardRootEl = useHostStackRootElement(hostStackId);
  const hostPaneFrameEl = useHostStackFrameElement(hostStackId);

  const { register: registerPropertyStore, ref: propertyStoreRef } = useCardPropertyStore();

  const cardStatePreservationCallbacksRef = useRef<CardStatePreservationCallbacks | null>(null);

  // Ref for the latest `hostContentEl` so closures installed in
  // `registerStatePreservationCallbacks` (onContentReady) read the current
  // element at fire time, not the mount-time capture. L07.
  const hostContentElRef = useRef<HTMLDivElement | null>(null);
  hostContentElRef.current = hostContentEl;
  // The pre-restore mask's deadline timer, or null when none is armed.
  const maskDeadlineRef = useRef<number | null>(null);

  // No `focusin` ref tracker here. The historical
  // `lastFocusedPersistKeyRef` fallback was retired in 8914b519 on
  // the strength of an audit that only covered activation-trigger
  // saves (all in capture phase, focus still in card). Inactive-
  // card saves (`visibilitychange`, `beforeunload`, debounced-while-
  // inactive) need protection too: the assembler now forwards the
  // previous bag's `focus` axis when `document.activeElement` is
  // outside this card root, which is the same outcome the focusin
  // tracker provided for the inactive-save case without the extra
  // listener. See the assembler body and the [at0039] gate.

  // Content restore is imperative and trigger-driven. The trigger is the
  // child calling `register(callbacks)` — its own `useLayoutEffect` is
  // the deterministic moment content restoration is safe. We do not gate
  // restore behind a React dep array because the prerequisites (host
  // element available, child registered) can arrive in any order and
  // React's reconciler is not the authority on "ready." This callback
  // owns only the content branch; scroll/selection live in the effect
  // below (keyed on host-element availability) and in the child-driven
  // `onContentReady` for the with-content case. L11, L22, L23.
  // Pure-storage registration. The actual restore (`callbacks.onRestore`,
  // `onContentReady` install, opacity mask, cold-boot trace) is driven by
  // the post-attach effect below — NOT here. registerStatePreservationCallbacks
  // fires from a child's `useLayoutEffect` (deepest first), which runs
  // BEFORE CardPortal's own layout effect that calls `host.appendChild(slot)`.
  // Doing the restore here would call `engine.restoreState` (and its
  // `setSelectedRange`) while the engine root sits in a detached portal
  // slot — `.focus()` silently no-ops on disconnected nodes and the
  // subsequent `addRange` doesn't stick, costing the user their selection
  // paint on cold-boot (inactive mirror path).
  //
  // L04 ready-callback pattern: defer the side-effecting restore to a
  // hook (CardHost's own layout effect) that fires AFTER all descendants'
  // effects AND AFTER CardPortal's slot attach. By the time the
  // `[cardId, hostContentEl, callbacksVersion, store]` effect below runs,
  // the engine root is connected to the document and
  // `engine.setSelectedRange` will land.
  //
  // `callbacksVersion` is the bridge from a child's late registration
  // back into the restore-effect's dep set. Cards whose content factory
  // mounts conditionally (e.g. session-card gates on `feedsReady` — its
  // editor doesn't render until `cardFeedIds` resolve from tugcast)
  // can have their state-preservation-callback registration arrive
  // several commits AFTER hostContentEl is non-null. Without this
  // counter, the restore effect would have already fired with
  // `callbacks=null` and returned early, never re-running when
  // callbacks finally appear.
  const [callbacksVersion, setCallbacksVersion] = useState(0);

  // Engine-hooks-change axis.
  //
  // Bumped each time `store.subscribeEngineHooksChange(cardId, …)`
  // fires (registration or unregistration of the engine's
  // `paintMirrorAsActive` / `paintMirrorAsInactive` hooks). Joins
  // the cold-boot RESTORE effect's dep array so a late-mounting
  // engine (dev's editor after `feedsReady`) re-fires
  // `applyBagFocus`, which now resolves `engine` (vs. the prior
  // `deferred-engine`) and invokes the hook. This is the one
  // late-mount FOCUS settle path that survives — there is no
  // `deferred-dom` focus retry.
  const [engineHooksVersion, setEngineHooksVersion] = useState(0);
  useLayoutEffect(() => {
    return store.subscribeEngineHooksChange(cardId, () => {
      setEngineHooksVersion((v) => v + 1);
    });
  }, [cardId, store]);


  // Counts how many "real" (carrying `restorePendingRef`)
  // registrations have landed on this CardHost since mount. The
  // first one is the content factory's initial registration; any
  // subsequent one is a remount of that factory while CardHost
  // itself stays mounted. Empirically the only producer of a
  // second+ real registration on the same CardHost is React Fast
  // Refresh (Vite HMR), but the detector is shape-agnostic — any
  // path that destroys and recreates the content factory subtree
  // produces the same signal.
  //
  // The earlier fingerprint approach watched for
  // `prev.restorePendingRef === undefined` — the no-op pair the
  // `useCardStatePreservation` cleanup registers. That fingerprint
  // works in unit-tested mount-then-unmount-then-mount cycles where
  // React fires effect cleanups in their canonical order, but in
  // practice Fast Refresh's lifecycle is murkier: it sometimes
  // re-renders the component without firing cleanup, and the
  // no-op-pair may never appear between two real registrations.
  // The count-based detector catches both shapes.
  const realCallbackRegistrationCountRef = useRef(0);
  const registerStatePreservationCallbacks = useCallback(
    (callbacks: CardStatePreservationCallbacks) => {
      // A "real" registration carries `restorePendingRef`. The
      // cleanup of `useCardStatePreservation` registers a no-op
      // pair without it; that no-op shape doesn't increment the
      // counter and therefore never trips the remount branch on
      // its own.
      const isRealRegistration = callbacks.restorePendingRef !== undefined;
      if (isRealRegistration) {
        realCallbackRegistrationCountRef.current += 1;
      }

      // Second+ real registration on the same CardHost = the
      // content factory just remounted. Reset the one-shot guards
      // so the existing restore effects re-fire on the
      // `callbacksVersion` bump below; they'll read the freshly-
      // captured bag (the HMR bridge's `vite:beforeUpdate` save
      // pass already ran) and replay both axes onto the new tree.
      //
      // First registration (count === 1) leaves the guards at
      // their `useRef(false)` initial values; the existing
      // cold-boot path applies the bag exactly once.
      const isRemount =
        isRealRegistration && realCallbackRegistrationCountRef.current >= 2;
      cardStatePreservationCallbacksRef.current = callbacks;
      if (isRemount) {
        hasAppliedContentRestoreRef.current = false;
      }
      setCallbacksVersion((v) => v + 1);
    },
    [],
  );

  // Apply `bag.content` restore exactly once per CardHost mount, AFTER
  // CardPortal's slot.appendChild has connected the engine root to the
  // document. CardPortal is a child of CardHost in the React tree, so its
  // `useLayoutEffect` fires before this one — `engine.root.isConnected`
  // is therefore guaranteed true here.
  //
  // The guard ref keeps this one-shot. Cross-pane moves swap
  // `hostStackId` and re-fire CardPortal's effect (re-attaching the slot
  // to the new host); they do NOT re-fire this restore — the engine has
  // its state from first mount, and a cross-pane move preserves DOM
  // identity for the engine root, so re-restoring would clobber any user
  // edits made between mount and the move.
  const hasAppliedContentRestoreRef = useRef(false);
  useLayoutEffect(() => {
    if (hasAppliedContentRestoreRef.current) return;
    if (!hostContentEl) return;
    const callbacks = cardStatePreservationCallbacksRef.current;
    if (!callbacks) return;
    // Cleanup-pair re-entries (no `restorePendingRef`) skip this branch
    // for the same reason as the original synchronous registration did.
    if (callbacks.restorePendingRef === undefined) return;
    const bag = store.getCardState(cardId);
    if (!bag || bag.content === undefined) return;

    // The one lifter, reached from both arms: the child's commit and the
    // deadline. One owner writes the mask and one owner clears it ([L32]).
    const liftMask = (): void => {
      if (maskDeadlineRef.current !== null) {
        window.clearTimeout(maskDeadlineRef.current);
        maskDeadlineRef.current = null;
      }
      const el = hostContentElRef.current;
      if (el && el.style.opacity === "0") {
        el.style.opacity = "";
      }
    };

    // Install onContentReady so scroll is applied after the child
    // commits restored content — at that point the content's
    // dimensions are valid and scroll clamps correctly. This is
    // also where the pre-restore opacity mask is lifted.
    //
    // DOM-selection and focus restore are NOT called here. This
    // branch runs only when `bag.content !== undefined` — i.e.
    // content-owning cards — and per [D95] those cards' content
    // factory owns selection and engine focus end-to-end. The engine's
    // `setSelectedRange` inside its own `restoreState` both
    // focuses the root and sets the selection; any second
    // `.focus()` or `setBaseAndExtent` call from CardHost would
    // race the engine and, under WebKit's focus-with-selection
    // quirk, collapse the just-restored selection. The save-side
    // gate also keeps `bag.domSelection` / `bag.focus` absent from
    // freshly-saved content-owning bags for symmetry.
    callbacks.onContentReady = () => {
      const el = hostContentElRef.current;
      if (el) {
        if (bag.scroll !== undefined) {
          el.scrollLeft = bag.scroll.x;
          el.scrollTop = bag.scroll.y;
        }
      }
      // Un-mask the host content now that scroll has been re-applied.
      // Outside the `el` guard: a mask with no element to lift is still
      // a deadline to disarm.
      liftMask();
    };
    // Pre-mask the host to hide the pre-restore scroll position
    // while the child re-renders with restored content. `opacity: 0`
    // (not `visibility: hidden`) keeps the engine root focusable
    // during the restore window.
    //
    // The mask lifts on the child's commit or on `CONTENT_READY_BOUND_MS`,
    // whichever comes first. The commit is not guaranteed: `onContentReady`
    // fires from a no-deps `useLayoutEffect` in `useCardStatePreservation`
    // on the CONTENT component's next commit, and a content component whose
    // `onRestore` causes no render of its own — `tug-markdown-view.tsx`
    // registers the literal `() => {}` — is waiting on a commit something
    // else has to cause. A card rebuilt inside a hidden workspace layer has
    // nothing to cause one. So the mask is a deferred reveal and carries a
    // deadline ([L31], [L32]): when it expires the card is shown with its
    // inner scroll un-replayed, which is the lesser harm — a reader who
    // lost their place can find it again, and a reader looking at a blank
    // pane has nothing to look for. The deadline path says so in the trace
    // rather than passing silently.
    if (hostContentElRef.current && bag.scroll !== undefined) {
      hostContentElRef.current.style.opacity = "0";
      maskDeadlineRef.current = window.setTimeout(() => {
        maskDeadlineRef.current = null;
        deckTrace.record({ kind: "card-host-mask-deadline", cardId });
        liftMask();
      }, CONTENT_READY_BOUND_MS);
    }

    // Diagnostic snapshot for the cold-boot / cross-pane-mount
    // restore path (ordering vs global Selection).
    let coldBootSelection: { start: number; end: number } | null = null;
    const content = bag.content as Record<string, unknown> | undefined;
    if (content !== undefined) {
      let engineState: Record<string, unknown> | undefined;
      if (
        typeof content.route === "string" &&
        "draft" in content
      ) {
        // Current TugPromptEntry shape: `{ route, draft }`.
        if (typeof content.draft === "object" && content.draft !== null) {
          engineState = content.draft as Record<string, unknown>;
        }
      } else if (
        typeof content.currentRoute === "string" &&
        typeof content.perRoute === "object" &&
        content.perRoute !== null
      ) {
        // Legacy TugPromptEntry shape: `{ currentRoute, perRoute }`.
        const perRoute = content.perRoute as Record<string, unknown>;
        const inner = perRoute[content.currentRoute as string];
        if (typeof inner === "object" && inner !== null) {
          engineState = inner as Record<string, unknown>;
        }
      } else {
        engineState = content;
      }
      const sel = engineState?.selection;
      if (
        typeof sel === "object" &&
        sel !== null &&
        typeof (sel as Record<string, unknown>).start === "number" &&
        typeof (sel as Record<string, unknown>).end === "number"
      ) {
        coldBootSelection = {
          start: (sel as { start: number }).start,
          end: (sel as { end: number }).end,
        };
      }
    }
    deckTrace.record({
      kind: "cold-boot-restore-snapshot",
      cardId,
      hasContent: bag.content !== undefined,
      engineSelection: coldBootSelection,
    });

    callbacks.restorePendingRef.current = true;
    // Compute `isActive` from the deck-level first responder snapshot
    // ([D10]). Per [L23], the consumer's onRestore branches
    // on this flag: active cards run `paintMirrorAsActive` (focus +
    // global Selection); inactive cards run
    // `paintMirrorAsInactive(publish)` (selectionGuard publish, no
    // focus claim, no global Selection mutation). The non-React read
    // on the deck-store singleton is L02-compliant — no useEffect
    // copying external state into React state.
    const isActive = store.getFirstResponderCardId() === cardId;
    callbacks.onRestore(bag.content, { isActive });
    hasAppliedContentRestoreRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId, hostContentEl, store, callbacksVersion]);

  // The mask's deadline never outlives the host ([L27]). Every acquisition
  // returns its release, and a timer that fires into an unmounted component
  // is an acquisition nobody released.
  // `useLayoutEffect` rather than `useEffect` only because it is this file's
  // one effect idiom; for a mount-empty cleanup the two are the same.
  useLayoutEffect(
    () => () => {
      if (maskDeadlineRef.current !== null) {
        window.clearTimeout(maskDeadlineRef.current);
        maskDeadlineRef.current = null;
      }
    },
    [],
  );

  // Scroll / DOM-selection / form-control / region-scroll restore:
  // triggered by `hostContentEl` becoming available. Fires idempotently
  // whenever the host element changes (mount, cross-pane move, pane
  // re-registration).
  //
  // **Outer scroll** applies regardless of content-case: for a no-content
  // bag this is the only restore path; for a with-content bag this is a
  // best-effort apply before the child commits, and `onContentReady`
  // re-applies the correct clamp after content renders.
  //
  // **DOM selection** is published to `selectionGuard` for every card
  // that carries a saved `bag.domSelection`, regardless of whether this
  // card is the active card of the active pane — the Step 5 paint
  // authority buckets each card's Range into either native `::selection`
  // or the `inactive-selection` custom highlight. For engine-managed
  // cards the engine's own restore (inside `onContentReady`) re-publishes
  // after innerHTML settles and wins by running after this call; for
  // engine-less cards this is the only publish and it seeds `cardRanges`.
  //
  // **Form controls** and **region scrolls** both replay via the same
  // MutationObserver so elements that mount late (behind feedsReady or
  // any content-factory readiness gate) restore when they appear.
  // The observer MUST be scoped to this card's root — not the whole
  // pane — so sibling cards in a tab-group pane cannot cross-notify.
  // Both branches guard against re-applying to elements they have
  // already touched: form controls via a `WeakSet`, region scrolls via
  // a `Set<key>` — so unrelated subtree mutations after the first
  // apply never clobber a scroll position the user has since changed.
  //
  // L22 (paint observes the store), L23 (preserve user-visible state).
  useLayoutEffect(() => {
    if (!hostContentEl) return;
    const bag = store.getCardState(cardId);
    if (!bag) return;
    // Content-owning cards manage DOM-selection through their own
    // restore path ([D95]) — the engine publishes via
    // `engine.onSelectionChanged` during its own `restoreState`.
    // Engine focus is similarly owned by `onCardActivated` /
    // `paintMirrorAsActive`. Non-engine focus targets inside the
    // same card (find-row input, future inline editors) still ride
    // the framework focus axis; the `bag.focus` restore below is
    // kind-gated rather than wholesale-skipped so those targets
    // survive cold-boot. See `saveCurrentCardStateRef.current` for
    // the matching save-side gate.
    const ownsSelectionAndFocus = bag.content !== undefined;
    if (bag.scroll !== undefined) {
      hostContentEl.scrollLeft = bag.scroll.x;
      hostContentEl.scrollTop = bag.scroll.y;
    }

    // DOM-selection restore — skipped for content-owning cards (the
    // content owner publishes via `engine.onSelectionChanged` during
    // its own `restoreState` and is the authoritative source). For
    // cards without `bag.content` (form-control cards, generic
    // contentEditable cards) CardHost's publish is the only
    // selection-guard seed. The `bag.domSelection` field is absent
    // from freshly-saved content-owning bags per the save-side gate;
    // this branch's extra `!ownsSelectionAndFocus` check covers
    // pre-fix bags still in tugbank.
    //
    // Path resolution depends on the saved anchor/focus nodes being
    // present in the DOM. For a virtualized renderer (tug-markdown-
    // view) the target text nodes may not exist at this moment —
    // blocks parse + render asynchronously after mount. A first
    // best-effort apply runs here; the MutationObserver-driven
    // `apply()` loop below re-tries on every subtree mutation until
    // the paths resolve and the Range is published into
    // `selectionGuard.cardRanges`. Once published we mark applied so
    // the observer stops fighting subsequent user selections.
    const cardRootForDomAxes = findCardRoot(hostContentEl, cardId);
    let domSelectionApplied = false;
    const tryRestoreDomSelection = (): boolean => {
      if (domSelectionApplied) return true;
      if (!bag.domSelection || ownsSelectionAndFocus) return true;
      if (!cardRootForDomAxes) return false;
      selectionGuard.restoreCardDomSelection(
        cardId,
        bag.domSelection,
        cardRootForDomAxes,
      );
      // Path resolution failure inside the guard is silent. Probe
      // the public per-card range accessor to detect a successful
      // publish.
      const published = selectionGuard.getCardRange(cardId);
      if (published !== undefined) {
        domSelectionApplied = true;
        deckTrace.record({
          kind: "selection-restore",
          cardId,
          via: "restoreCardDomSelection",
        });
      }
      return domSelectionApplied;
    };
    if (
      bag.domSelection &&
      !ownsSelectionAndFocus &&
      cardRootForDomAxes
    ) {
      tryRestoreDomSelection();
    }

    // Focus restore — cold-boot RESTORE focus claim routes through
    // the single-channel `applyBagFocus` dispatcher. The
    // active-card-of-active-pane gate ([D10] Option B) prevents
    // focus theft across panes ([R07]).
    //
    // Resolution paths handled by `applyBagFocus`:
    //   - `framework` (`dom` / `form-control`): `el.focus()`, unless
    //     the element is already `document.activeElement` — then the
    //     dispatcher yields (idempotency guard).
    //   - `engine` (engine hooks registered): invokes
    //     `store.invokeEnginePaintMirrorAsActive(cardId)`.
    //   - `deferred-engine` (engine mounts late, e.g. dev's
    //     editor after `feedsReady`): returns `"deferred"`. The
    //     `engineHooksVersion` axis (subscribed above) re-fires
    //     this effect when the engine registers; the re-run
    //     re-runs `applyBagFocus`, which now resolves `engine`.
    //     This is the one remaining late-mount FOCUS path.
    //   - `deferred-dom` (saved framework-axis target not mounted):
    //     returns `"deferred"`. This is a graceful no-focus
    //     outcome — the cold-boot claim is one-shot, not retried.
    //   - `default-focus` / `none`: idempotent.
    if (isActiveCardOfActivePane(store, cardId)) {
      const result = applyBagFocus(cardId, store, { site: "cold-boot" });
      if (result === "applied") {
        if (bag.focus?.kind === "form-control") {
          // Form-control apply triggers the browser's native
          // selection-on-focus behavior; record the cold-boot
          // entry via the `applyFocusSnapshot` site tag for log
          // continuity with pre-E.11 traces.
          deckTrace.record({
            kind: "selection-restore",
            cardId,
            via: "applyFocusSnapshot",
          });
        }
      }
    }

    // Form-control apply is a ONE-SHOT at mount — and the ONLY place
    // a saved value snapshot is written back into a live field. This
    // is what preserves uncontrolled input/textarea values across
    // remount: cold boot, reload/relaunch, HMR, and tab unmount/remount.
    // It runs once when the card subtree mounts; from then on the live
    // DOM is the sole authority — no observer loop, no activation-time
    // or click-time re-apply re-writes a field the user is editing.
    // Historically it lived inside a MutationObserver-driven `apply()`
    // loop gated by a `WeakSet` to keep observer fires from clobbering
    // user typing; that machinery is gone.
    const formSnapshots = bag.formControls;
    if (formSnapshots) {
      const cardRoot = findCardRoot(hostContentEl, cardId);
      if (cardRoot !== null) {
        for (const [key, snap] of Object.entries(formSnapshots)) {
          const el = cardRoot.querySelector<
            HTMLInputElement | HTMLTextAreaElement
          >(`[data-tug-state-key="${CSS.escape(key)}"]`);
          if (el !== null) {
            applyFormControlSnapshot(el, snap);
          }
        }
      }
    }

    const regionSnapshot = bag.regionScroll ?? undefined;
    // The observer below is installed when EITHER late-mount retry
    // is pending:
    //   - regionSnapshot (virtualized scroller `scrollHeight`
    //     catch-up).
    //   - unapplied `bag.domSelection` (target nodes mount later;
    //     tug-markdown-view).
    // Focus is NOT retried here — the cold-boot focus claim above
    // is one-shot. The only late-mount FOCUS path is `deferred-engine`,
    // which settles via the `engineHooksVersion`-keyed effect re-run,
    // not via this observer.
    // Skipping the observer when only one retry is pending would leave
    // that one's retry hook un-installed.
    const needsDomSelectionRetry =
      bag.domSelection !== null &&
      bag.domSelection !== undefined &&
      !ownsSelectionAndFocus &&
      !domSelectionApplied;
    if (!regionSnapshot && !needsDomSelectionRetry) {
      return;
    }

    // For region scrolls we can't mark "applied after one shot" — a
    // virtualized scroller (most notably `tug-markdown-view`) renders
    // estimated-height blocks first, so its `scrollHeight` is below
    // the saved `scrollTop` on the initial apply. The browser
    // clamps the assignment, then ResizeObserver-driven height
    // refinement grows the spacer divs (which mutates their `style`
    // attribute) and `scrollHeight` catches up. Track the settled
    // state instead: re-apply on every observed mutation until
    // `el.scrollTop` lands within tolerance of the saved value,
    // then mark settled and stop fighting any subsequent scroll.
    //
    // Settled state is keyed on the ELEMENT, not the scroll-key
    // string, because a body kind may unmount-and-remount within the
    // same card lifecycle (e.g., `TerminalBlock`'s collapse-then-
    // expand cycle imperatively rebuilds its inner scroller; the
    // setLocalCollapsed re-render triggers the same rebuild on first
    // mount). The new element gets the same
    // `data-tug-scroll-key` value but starts at scrollTop=0; if we
    // tracked settled-by-key only, the new element would be skipped
    // and the user's saved scroll would be lost the moment they
    // saved post-rebuild (see at0065-session-card-like-inner-scroll-
    // restore.test.ts Phase 4 for the regression).
    //
    // The matching MutationObserver below adds `attributes: true,
    // attributeFilter: ["style"]` so the spacer-height mutations
    // fire `apply()`; without that, only `childList` mutations
    // would trigger re-application and the bake-in race would
    // never resolve. See [AT0014] region-scroll persistence notes.
    const settledElByKey = new Map<string, HTMLElement>();
    const REGION_SCROLL_TOLERANCE_PX = 8;

    const apply = () => {
      const cardRoot = findCardRoot(hostContentEl, cardId);
      if (!cardRoot) return;
      // Form-controls were applied one-shot above; the observer-
      // driven path here handles region-scrolls (until the virtual-
      // ized layout's `scrollHeight` catches up) and the saved
      // DOM-selection restore for non-content-owning cards whose
      // target nodes mount later (the markdown view's blocks parse
      // and render asynchronously after the host mounts).
      if (!domSelectionApplied) tryRestoreDomSelection();
      if (regionSnapshot) {
        const pending: RegionScrollSnapshot = {};
        let hasPending = false;
        for (const [key, pos] of Object.entries(regionSnapshot)) {
          const el = cardRoot.querySelector<HTMLElement>(
            `[data-tug-scroll-key="${CSS.escape(key)}"]`,
          );
          if (!el) {
            // Element absent — body kind unmounted (e.g., user
            // collapsed the block). Drop the settled-element binding
            // so a future remount goes through the apply path again.
            settledElByKey.delete(key);
            continue;
          }
          // Element-identity gate. A new element with the same key
          // (post-rebuild) bypasses the settled check because
          // settledElByKey.get(key) !== el.
          if (settledElByKey.get(key) === el) continue;

          // `meta.atBottom` regions — a `TugListView` saved while
          // following the bottom — restore by re-engaging follow-bottom
          // and pinning to the LIVE bottom, which has grown since save.
          // The re-pinned `scrollTop` therefore converges to
          // `scrollHeight - clientHeight`, NOT the stale saved `pos.y`,
          // so the raw-`pos.y` tolerance gate below would never settle:
          // the retry would re-dispatch `tug-region-scroll-set` on every
          // cardRoot mutation, and the list view's at-bottom branch would
          // re-engage follow-bottom each time — slamming a user who has
          // since scrolled up. The at-bottom restore is a ONE-SHOT:
          // dispatch once to resume following, then settle immediately
          // and hand ongoing pin/disengage policy to SmartScroll (its own
          // follow-bottom + `maybePinToBottom`, which a user wheel-up
          // disengages and a restore never fights). See [AT0014] notes;
          // covers transcript ([P03]/[P04]) and any at-bottom region (R01).
          const metaAtBottom =
            typeof pos.meta === "object" &&
            pos.meta !== null &&
            (pos.meta as { atBottom?: unknown }).atBottom === true;
          if (metaAtBottom) {
            pending[key] = pos;
            hasPending = true;
            settledElByKey.set(key, el);
            continue;
          }

          // `meta.anchor` regions are ONE-SHOT for the same reason.
          // A `TugListView` restores an anchor by installing a resolver
          // in SmartScroll (`setRestoreTarget`), which re-resolves the
          // anchored row's live offset on every layout heartbeat and is
          // superseded the moment the user gestures or follow-bottom
          // engages. The resolved `scrollTop` is therefore NOT the stale
          // saved `pos.y` whenever the anchored row's offset has moved —
          // content paged in above it, heights re-measured at a new
          // width, an anchor written by an older height accounting. The
          // raw-`pos.y` tolerance gate below can never settle in that
          // case, so every cardRoot mutation re-dispatches, and the list
          // view's anchor branch disengages follow-bottom and re-installs
          // the restore each time: an actively streaming transcript loses
          // the live edge and snaps back to the anchor on every new turn.
          // Dispatch once to hand the anchor to SmartScroll, then settle
          // and let it own convergence and the supersede rules.
          //
          // Raw-pixel regions (`tug-markdown-view`, generic scrollers)
          // keep the retry loop below: they have no resolver of their
          // own, and their `scrollHeight` genuinely does grow past the
          // saved `scrollTop` as estimated blocks bake in.
          const metaAnchor =
            typeof pos.meta === "object" &&
            pos.meta !== null &&
            "anchor" in (pos.meta as Record<string, unknown>);
          if (metaAnchor) {
            pending[key] = pos;
            hasPending = true;
            settledElByKey.set(key, el);
            continue;
          }

          // If the element already sits within tolerance of the
          // saved position, mark THIS element settled and stop
          // fighting any subsequent user scroll on it. Covers
          // (a) the saved-position-is-zero no-op, and (b) the
          // post-bake-in pass where ResizeObserver has finished
          // growing the spacer and our previous `applyRegionScrolls`
          // has already landed the scrollTop on target.
          if (
            Math.abs(el.scrollTop - pos.y) <= REGION_SCROLL_TOLERANCE_PX &&
            Math.abs(el.scrollLeft - pos.x) <= REGION_SCROLL_TOLERANCE_PX
          ) {
            settledElByKey.set(key, el);
            continue;
          }
          pending[key] = pos;
          hasPending = true;
        }
        if (hasPending) applyRegionScrolls(cardRoot, pending);
      }
    };

    apply();
    const cardRoot = findCardRoot(hostContentEl, cardId);
    if (!cardRoot) return;
    const observer = new MutationObserver(apply);
    observer.observe(cardRoot, {
      childList: true,
      subtree: true,
      // `style` mutations catch the virtualization-driven spacer-
      // height growth that grows `scrollHeight` past the saved
      // `scrollTop`. Without this, the initial clamped assignment
      // never re-runs and the user lands at scrollTop=0.
      attributes: true,
      attributeFilter: ["style"],
    });
    return () => observer.disconnect();
    // `callbacksVersion` joins the dep set so this effect re-fires on
    // a content-factory remount (the no-op-pair → real-callbacks
    // transition that `registerStatePreservationCallbacks` watches
    // for). Without it, HMR remount of a non-content card (one whose
    // bag.focus axis is the only authoritative focus mechanism)
    // wouldn't re-apply `bag.focus` — `cardId` / `hostStackId` /
    // `hostContentEl` / `store` are all stable across the remount.
    // The body is idempotent: scroll / form-controls / region-scroll
    // / DOM-selection writes match what's already there for unchanged
    // axes, and focus re-application during cold-boot's first commit
    // is benign (the user hasn't moved focus yet).
  }, [cardId, hostStackId, hostContentEl, store, callbacksVersion, engineHooksVersion]);

  // Cross-pane-move focus restore is owned by
  // `transferFocusAfterMove` in `focus-transfer.ts`, called
  // synchronously from `deck-manager.ts#_detachCard` /
  // `_moveCardToPane` after their `notify()`. The legacy
  // `[hostStackId]`-keyed `useLayoutEffect` that lived here —
  // observing `hostStackId` transitions and re-applying
  // `bag.focus` via `applyFocusSnapshot` — was retired.
  // CardHost is no longer a focus
  // restorer for cross-pane moves; it remains the cold-boot
  // mount-restore path (the primary restore effect above) for
  // initial focus on first mount.

  // Activation-driven focus + selection transfer is owned by
  // `transferFocusForActivation` in `focus-transfer.ts`, called
  // synchronously from each gesture source (pane-focus-controller,
  // `tug-pane#performSelectCard`, `deck-manager#_removeCard` /
  // `_closePane`). The legacy `[A3]` `useLayoutEffect` that lived
  // here — subscribing to `useFocusDestination` and re-applying
  // focus/selection/default-focus on every reactivation — was
  // retired. CardHost
  // is now a registrar (it registers its root via
  // `store.registerCardHostRoot`) and a cold-boot/cross-pane
  // restorer; runtime activation transitions flow through the
  // helper, not through this component.
  //
  // `useFocusDestination` remains exported from `deck-store-hooks`
  // for any future React consumer that legitimately *renders* on
  // destination status. CardHost no longer subscribes to it.

  // Framework-axes assembler. Rewritten every render so closures read
  // the latest `hostContentEl` / `hostStackId` / `cardId` without stale
  // capture. This is the "assembler" the CardStateOrchestrator invokes
  // on every save trigger ([A9c]); the orchestrator layers
  // `bag.components` on top of whatever this returns.
  const assembleFrameworkBagRef = useRef<(source?: SaveCallbackSource) => CardStateBag>(
    () => ({}),
  );
  assembleFrameworkBagRef.current = (source?: SaveCallbackSource) => {
    // Content not mounted (the `feedsReady` gate below is still showing
    // "Loading..."): nothing user-visible can have changed, and a fresh
    // capture would assemble a bag with NO `content` axis — replacing the
    // cached bag (and, on the next flush, the durable one) with a version
    // that has lost the prompt draft, form controls, and region scrolls.
    // Per [L23], forward the previous bag unchanged instead.
    if (!feedsReady) {
      return store.getCardState(cardId) ?? {};
    }
    const contentEl = hostContentEl;
    const scroll = contentEl
      ? { x: contentEl.scrollLeft, y: contentEl.scrollTop }
      : undefined;
    // Content axis: live capture when the owning factory is mounted;
    // otherwise forward the cached bag's content unchanged. The
    // `feedsReady` guard above doesn't cover every owner-unmounted
    // window — a session card sitting in its pre-bind phase has
    // `feedIds.length === 0` (feedsReady true) yet no preservation
    // callbacks, and a save fired there (e.g. the dirty debounce
    // tripped by a sibling tab's selectionchange on the shared pane
    // content element) would otherwise assemble a content-less bag
    // and destroy the persisted prompt draft before the late-mounting
    // editor ever restores it. Per [L23], an internal save must not
    // drop an axis it cannot currently capture.
    const content =
      cardStatePreservationCallbacksRef.current?.onSave(source) ??
      store.getCardState(cardId)?.content;
    // Scope form-control capture to THIS card's subtree so sibling cards in
    // the same pane (tab-group) never contaminate each other's values.
    const cardRoot = contentEl ? findCardRoot(contentEl, cardId) : null;
    const formControls = cardRoot ? captureFormControls(cardRoot) : undefined;
    const regionScroll = cardRoot ? captureRegionScrolls(cardRoot) : undefined;
    // [D95] — content-owning cards (any card whose factory writes
    // `bag.content` via `useCardStatePreservation`) own their own DOM
    // selection AND their engine's caret. The content payload carries
    // whatever the owner needs (for session-card: `bag.content.selection`
    // flat offsets, and engine-driven focus via `setSelectedRange`).
    // CardHost must step out of selection: a second source of truth
    // would race the owner's restore on mount and clobber it. CardHost
    // still owns the framework focus axis for non-engine targets in
    // the same card (find-row input, future inline editors); the
    // focus capture below honours the engine carve-out by accepting
    // only `dom` / `form-control` kinds for content-owning cards.
    // For cards without
    // a content payload (form-control cards, markdown-view cards)
    // CardHost is the sole authority on these axes.
    const ownsSelectionAndFocus = content !== undefined;
    const domSelection =
      cardRoot && !ownsSelectionAndFocus
        ? captureDomSelection(cardId, cardRoot)
        : null;
    // Focus axis. Two branches matter for [L23]:
    //
    //   1. Focus is INSIDE this card root → `captureFocus` is
    //      authoritative. It picks up the user's currently-focused
    //      keyed input / focus-tagged element / component-owned
    //      region. Returning `{ kind: "none" }` from this branch is
    //      intentional (e.g. the user genuinely clicked away from
    //      every keyed element while still inside the card).
    //
    //   2. Focus is OUTSIDE this card root → `document.activeElement`
    //      is in a sibling card, the body, or off-document. This
    //      happens whenever a save fires for an INACTIVE card —
    //      `visibilitychange` (cmd-tab / app-hide), `beforeunload`
    //      (Maker > Reload), or a debounced save while the user
    //      is editing in another card. `captureFocus` would return
    //      `{ kind: "none" }` here too, but writing that into the
    //      bag would BLANK whatever focus was captured at the
    //      previous save (typically the deactivation-time capture
    //      that correctly named the input the user had focused).
    //      Per [L23], an internal save must not destroy a user-
    //      visible axis just because focus is momentarily elsewhere.
    //      Forward the previous bag's focus instead.
    //
    // The historical alternative was an [L03] focusin listener
    // (`lastFocusedPersistKeyRef`) feeding a fallback parameter to
    // `captureFocus`. The audit that retired it (commit 8914b519)
    // only checked activation-trigger save sources, all of which
    // fire in capture phase before focus moves; it missed the
    // inactive-card save sources covered by branch 2 above. The
    // assembler-local "preserve previous bag.focus" rule is
    // simpler — no listener, no ref, no extra capture pass — and
    // covers the same cases.
    //
    // Engine kind capture (content-owning cards). A content-owning
    // card whose focus rides in the engine's contenteditable
    // captures as `{ kind: "engine" }`. At this step the engine
    // still claims focus autonomously via `onCardActivated`, so the
    // capture rule remains: content-owning cards accept `bag.focus`
    // only when the kind is `dom` or `form-control` — i.e., a target
    // NOT owned by the engine — and otherwise leave `bag.focus`
    // absent so the engine's activation hook runs as the default.
    // Phase E.11 Step 3 expands this to also capture `engine` for
    // content-owning cards and route both kinds through the single
    // `applyBagFocus` dispatcher. See
    // `tuglaws/design-decisions.md` (engine-vs-framework focus
    // boundary) and `tuglaws/state-preservation.md`
    // (`FocusSnapshot in depth`).
    let focus: FocusSnapshot = { kind: "none" };
    if (cardRoot) {
      const active = cardRoot.ownerDocument.activeElement;
      const focusInsideCard =
        active instanceof HTMLElement && cardRoot.contains(active);
      // Keyboard-as-engine-state: an engine-routed key view parks DOM
      // focus on the key sink, which lives OUTSIDE every card — but the
      // keyboard truth is this card's key-view projection. When the sink
      // holds focus and this card carries the projected `[data-key-view]`,
      // the card IS the focused card and `captureFocus` serializes from
      // the projection; forwarding the previous bag here would blank the
      // user's live keyboard position on every save.
      const engineHoldsCard =
        !focusInsideCard &&
        active instanceof HTMLElement &&
        active.hasAttribute("data-tug-key-sink") &&
        cardRoot.querySelector("[data-key-view]") !== null;
      if (focusInsideCard || engineHoldsCard) {
        const captured = captureFocus(cardRoot);
        if (ownsSelectionAndFocus) {
          if (captured.kind === "dom" || captured.kind === "form-control") {
            focus = captured;
          }
          // else: engine-focused or none → leave the axis absent so
          // the engine's `onCardActivated` is authoritative.
        } else {
          focus = captured;
        }
      } else {
        // Forward the previous bag's focus when present. `bag.focus`
        // is `FocusSnapshot | null` — both the `undefined`
        // (never-saved) and `null` (explicitly cleared) cases keep
        // the local default `{ kind: "none" }`, which is filtered
        // out of the assembled bag below.
        const prev = store.getCardState(cardId);
        if (prev?.focus) {
          if (ownsSelectionAndFocus) {
            // Honour the same kind restriction on the forwarded
            // value so stale bags (saved before this commit, or
            // saved while the engine had focus) do not reintroduce
            // an `engine` value this step's autonomous claim path
            // would otherwise treat as authoritative.
            if (
              prev.focus.kind === "dom" ||
              prev.focus.kind === "form-control"
            ) {
              focus = prev.focus;
            }
          } else {
            focus = prev.focus;
          }
        }
      }
    }
    const bag: CardStateBag = {
      ...(scroll !== undefined ? { scroll } : {}),
      ...(content !== undefined ? { content } : {}),
      ...(formControls !== undefined ? { formControls } : {}),
      ...(regionScroll !== undefined ? { regionScroll } : {}),
      ...(domSelection !== null ? { domSelection } : {}),
      ...(focus.kind !== "none" ? { focus } : {}),
    };
    return bag;
  };

  // Canonical save closure consumed by `useCardDirtyState` (debounced
  // save path) and `registerSaveCallback` (close-before-destroy flush
  // and app will-phase triggers). Routes through `captureCardState` so
  // every save trigger picks up both framework axes and opt-in
  // component state in one call ([A9c] / [AT0017]).
  const saveCurrentCardStateRef = useRef<(source?: SaveCallbackSource) => void>(() => {});
  saveCurrentCardStateRef.current = (source?: SaveCallbackSource) => {
    store.setCardState(cardId, store.captureCardState(cardId, source));
  };

  useLayoutEffect(() => {
    // Register the framework-axes assembler with the orchestrator so
    // `store.captureCardState(cardId)` can invoke it from every save
    // trigger. Identity is stable across renders (the assembler object
    // is built once here); its underlying closure reads the latest
    // render's state via `assembleFrameworkBagRef.current`.
    const unregisterAssembler = store.registerCardAssembler(cardId, {
      capture: (source) => assembleFrameworkBagRef.current(source),
    });
    store.registerSaveCallback(cardId, (source) => saveCurrentCardStateRef.current(source));
    return () => {
      store.unregisterSaveCallback(cardId);
      unregisterAssembler();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId, store]);

  // Component-level restore is render-time, not effect-driven. Each
  // participating component reads its saved value via
  // `useSavedComponentState` (or `useSavedRegionScroll`) inside a
  // `useState` initializer / imperative-renderer creation site, so the
  // component mounts in its saved state on first paint. There is no
  // post-mount apply pass. See `tuglaws/state-preservation.md` →
  // "Restoring saved state at mount" for the full contract.

  const markDirty = useCardDirtyState({
    hostContentEl,
    saveRef: saveCurrentCardStateRef,
  });

  const feedIds = useMemo(() => registration?.cardFeedIds ?? [], [registration]);
  const feedData = useCardFeedStore(hostStackId, feedIds);
  // Test-mode override: bypass the feed-data gate so cards whose
  // `cardFeedIds` would otherwise wait on a live tugcast/tugcode
  // backend (notably session-card, which gates on `[CODE_INPUT,
  // CODE_OUTPUT, SESSION_SIDEBAND, FILETREE]`) can mount in the
  // in-app harness. Tests don't drive the AI side of those cards;
  // they exercise focus, selection, persistence, and other
  // framework concerns that don't depend on real feed data. The
  // production path is unchanged: `__tugTestMode` is set only when
  // launched via `TUGAPP_TEST_SOCKET`, in DEV builds.
  // The bypass is itself bypassed under `__tugRestoreInTestMode`:
  // quit-and-relaunch tests exist to drive the production cold-boot
  // path, and the late feeds-gated mount (a session card's editor
  // arriving only when its feeds land) is a load-bearing part of that
  // path — short-circuiting it would hide exactly the late-mount
  // races those tests pin.
  const isTestMode =
    typeof window !== "undefined" && window.__tugTestMode === true;
  const isRestoreTest =
    typeof window !== "undefined" && window.__tugRestoreInTestMode === true;
  const feedsReady =
    (isTestMode && !isRestoreTest) || feedIds.length === 0 || feedData.size > 0;

  // Stable context value carrying both the cardId and the register
  // callback. A memoized object is cheaper to stabilize than threading
  // both through the tree separately, and it lets descendants that only
  // need the id read it via `useCardId` without subscribing to register.
  const cardStatePreservationContextValue = useMemo<CardStatePreservationContextValue>(
    () => ({ cardId, register: registerStatePreservationCallbacks }),
    [cardId, registerStatePreservationCallbacks],
  );

  // Per-card Component State Preservation Protocol context ([D13],
  // [A9]). Provides four things to every descendant:
  //
  //   1. The lazily-materialized registry, into which participating
  //      components register their `captureState` closure via
  //      `useComponentStatePreservation`.
  //   2. The accumulated scope prefix and `treePath` (empty here at the
  //      card root; nested `<ComponentStatePreservationScope>` providers
  //      extend both).
  //   3. Synchronous saved-state accessors that read from this card's
  //      `CardStateBag` in the manager's cache. Components consume them
  //      via `useSavedComponentState` / `useSavedRegionScroll` inside a
  //      `useState` initializer (or imperative renderer) so they mount
  //      in their saved state on the very first paint.
  //   4. The deck manager's notify channel for [L02] compliance. The
  //      accessor hooks pass it to `useSyncExternalStore`; a future bag
  //      mutation that fires `notify()` re-reads the saved value. The
  //      cold-boot path doesn't need this — the cache is hydrated
  //      synchronously before any CardHost mounts — but the wiring stays
  //      [L02]-correct.
  const componentStatePreservationContextValue = useMemo<
    CardComponentStatePreservationContextValue
  >(
    () => ({
      registry: store.getComponentStatePreservationRegistry(cardId),
      prefix: "",
      treePath: [],
      getSavedComponentState: (scopedKey: string): unknown => {
        const bag = store.getCardState(cardId);
        return bag?.components?.[scopedKey];
      },
      getSavedRegionScroll: (scrollKey: string): SavedRegionScroll | undefined => {
        const bag = store.getCardState(cardId);
        const entry = bag?.regionScroll?.[scrollKey];
        if (!entry) return undefined;
        return entry;
      },
      subscribe: store.subscribe,
    }),
    [store, cardId],
  );

  // Card-level responder for `SET_PROPERTY` dispatched via
  // `manager.sendToTarget(cardId, …)`. `parentId: hostStackId` re-parents
  // the chain to the portaled DOM layout — without the override the
  // responder's parent would follow the React tree (pointing at
  // `deck-canvas`) and the chain walk from `firstResponderId = cardId`
  // would skip every pane-level handler.
  const { ResponderScope, responderRef } = useResponder({
    id: cardId,
    parentId: hostStackId,
    actions: {
      [TUG_ACTIONS.SET_PROPERTY]: (event: ActionEvent) => {
        const ps = propertyStoreRef.current;
        if (!ps) return;
        const payload = event.value as
          | { path: string; value: unknown; source?: string }
          | undefined;
        if (!payload || typeof payload.path !== "string") return;
        ps.set(payload.path, payload.value, payload.source ?? "inspector");
      },
    },
  });

  // Selection boundary is the card-host div itself. Registering here (not
  // on the pane's content div) gives `selectionGuard` one entry per card,
  // even when multiple cards share one pane's content element (tab-group
  // panes). [L12].
  const cardRootRef = useRef<HTMLDivElement | null>(null);
  useSelectionBoundary(cardId, cardRootRef);

  // Element-state for the registered card-host root. Captured via the
  // ref-callback on every mount, unmount, and element-identity change
  // (e.g. if React's portal reconciler swaps the subtree on a
  // cross-pane move rather than moving it in place). Tracking the
  // current element in state — not just a ref — means the effect
  // below re-runs when the DOM node identity changes, so
  // `registerCardHostRoot` re-registers the new node and unregisters
  // the old one in one commit. L07.
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);

  // Compose the card-root ref with `responderRef` (a callback ref the
  // responder chain uses for DOM anchoring) and the `rootEl` state
  // setter (driving the registration effect below). A stable
  // useCallback keeps React from firing the callback with `null` then
  // the element on every render. L07.
  const setCardRootEl = useCallback(
    (el: HTMLDivElement | null) => {
      cardRootRef.current = el;
      responderRef(el);
      setRootEl(el);
    },
    [responderRef],
  );

  // Register the live card-host root with the deck store so the
  // focus-transfer resolver can scope its DOM queries to this card's
  // subtree. Keyed on `[cardId, rootEl, store]`: mount registers the
  // initial element, unmount (cleanup) unregisters it, and an
  // element-identity change (cleanup → effect body in the same
  // commit) swaps registrations without leaving a stale entry.
  // L03 — registration runs in the same commit phase as any event
  // that could drive an activation, so the resolver never reads a
  // stale registry. L10 — the store owns the registry; CardHost is
  // only the caller that keeps it honest.
  useLayoutEffect(() => {
    if (rootEl === null) return;
    store.registerCardHostRoot(cardId, rootEl);
    deckTrace.record({
      kind: "card-host-mount",
      cardId,
      hostStackId,
    });
    return () => {
      store.registerCardHostRoot(cardId, null);
      deckTrace.record({
        kind: "card-host-unmount",
        cardId,
        hostStackId,
      });
    };
  }, [cardId, rootEl, store, hostStackId]);

  // No focusin listener here — the assembler preserves the previous
  // bag's `focus` axis when `document.activeElement` is outside this
  // card, which covers the inactive-card save paths
  // (`visibilitychange`, `beforeunload`, debounced) the original
  // `lastFocusedPersistKeyRef` listener was added to handle. See the
  // assembler body in this file and the [at0039] gate.

  // ---- Render ----
  if (!registration) {
    return null;
  }

  // `CardPortal` routes DOM output into the host pane's content div and
  // preserves identity across re-root. Non-active cards are hidden with
  // `display: none` so identity survives card switches without layout impact.
  return (
    <CardPortal hostStackId={hostStackId}>
      <div
        ref={setCardRootEl}
        data-card-host
        data-card-id={cardId}
        style={{
          display: isActive ? "contents" : "none",
        }}
      >
        <TugPaneFrameContext value={hostPaneFrameEl}>
        <TugPanePortalContext value={hostCardRootEl}>
          <CardIdContext value={cardId}>
            <ResponderScope>
              <CardDataProvider feedData={feedData}>
              <CardPropertyContext value={registerPropertyStore}>
                <CardStatePreservationContext value={cardStatePreservationContextValue}>
                  <CardComponentStatePreservationContext.Provider
                    value={componentStatePreservationContextValue}
                  >
                    <CardDirtyContext value={markDirty}>
                      {feedsReady ? (
                        // `cardId` is the stable identity content factories key
                        // their per-card state off; it survives detach/merge
                        // whereas `hostStackId` changes on cross-pane moves.
                        registration.contentFactory(cardId)
                      ) : (
                        <div className="tug-pane-loading" data-testid="tug-pane-loading">
                          Loading...
                        </div>
                      )}
                    </CardDirtyContext>
                  </CardComponentStatePreservationContext.Provider>
                </CardStatePreservationContext>
              </CardPropertyContext>
            </CardDataProvider>
            </ResponderScope>
          </CardIdContext>
        </TugPanePortalContext>
        </TugPaneFrameContext>
      </div>
    </CardPortal>
  );
}
