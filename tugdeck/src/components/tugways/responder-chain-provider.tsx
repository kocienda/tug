/**
 * ResponderChainProvider -- React context provider for the responder chain.
 *
 * Creates a singleton ResponderChainManager, provides it via
 * ResponderChainContext, and installs the four-stage keyboard pipeline:
 *
 *   Stage 1 (capture): global shortcuts via keybinding map
 *   Stage 2 (bubble):  keyboard navigation -- deferred to browser in Phase 3
 *   Stage 3 (bubble):  chain action dispatch for non-input targets (stub Phase 3)
 *   Stage 4 (bubble):  text input passthrough (implicit)
 *
 * Also exports convenience hooks:
 *   useResponderChain()         -- returns manager | null (safe outside provider)
 *   useRequiredResponderChain() -- returns manager, throws outside provider
 *
 * [D02] SelectionGuard event listeners attached here; CSS Highlights created
 *       eagerly in SelectionGuard constructor (before React mounts)
 * [D03] Four-stage key pipeline with global keydown listener
 * [D07] ResponderChainProvider wraps DeckCanvas only
 *,
 */

import React, { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DEFAULT_BUTTON_PRESS_MS,
  ResponderChainContext,
  ResponderChainManager,
  defaultButtonAnswersChord,
} from "./responder-chain";
import { FocusManager, FocusManagerContext, TAB_CONSUME_ATTRIBUTE, TAB_RELEASE_ATTRIBUTE, ATTACHED_LIST_ATTRIBUTE, KEY_SINK_ATTRIBUTE, BASE_FOCUS_MODE, registerFocusManager, advanceKeyViewFocus } from "./focus-manager";
import { resolveFocusAct } from "./focus-act";
import { arrowDirection, type SpatialDirection } from "./spatial-order";
import { keyboardAccessStore } from "../../keyboard-access-store";
import { focusRingModalityStore } from "../../focus-ring-modality-store";
import { keymapRegistry, type ScopedBinding } from "./keymap-registry";
import { chordCaptureState } from "./chord-capture-state";
import { COMMANDS_BY_ID } from "./command-registry";
import { dispatchCommand } from "../../command-dispatch";
import { TUG_ACTIONS } from "./action-vocabulary";
import { selectionGuard } from "./selection-guard";
import { installModifierLatch } from "./modifier-latch";
import { registerResponderChainManager } from "../../action-dispatch";
import { getCardLifecycle } from "../../lib/card-lifecycle";
import { getAppLifecycle } from "../../lib/app-lifecycle";
import { getDeckStore } from "../../lib/deck-store-registry";
import {
  computeEditCapabilities,
  editUndoLabelsWithin,
  publishEditMenuState,
  registerMenuCapsRefresher,
  registerMenuValidationChain,
} from "../../lib/host-menu-state";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";
import { currentGesture, targetRefusesFocus } from "@/gesture-interpreter";
import { isSyntheticEscape } from "./internal/synthetic-escape";
import { useOpenMenuClaim } from "./use-open-menu-claim";

// ---- Fallback context menu ----

import "./tug-menu.css";
import "./tug-key-sink.css";

/**
 * Minimal "No Actions" context menu shown when a right-click lands on an
 * area with no component-specific context menu. Prevents the browser's
 * native context menu from appearing anywhere in the app.
 *
 * Uses tug-menu CSS classes for visual consistency with TugContextMenu and
 * TugEditorContextMenu. Dismisses on click-away, Escape, or any keypress.
 */
function FallbackContextMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  // Mounted only while showing, so the claim is unconditional: no tooltip
  // opens over even the empty menu. [see lib/open-menu-registry]
  useOpenMenuClaim(true);

  const menuRef = useRef<HTMLDivElement>(null);

  // Position and dismiss listeners.
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    // Position: same two-pass approach as TugEditorContextMenu.
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8);
    if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = "visible";

    // Dismiss on click-away or keypress. Both press events, for the reason
    // TugEditorContextMenu listens for both: `mousedown` is a compatibility
    // event, and a surface that calls `preventDefault` on its `pointerdown`
    // (the rail's reorder-armed rows do) suppresses it — leaving a menu with
    // nothing to hear and no way to close.
    const dismiss = () => onClose();
    const onPress = (e: Event) => {
      if (menu.contains(e.target as Node)) return;
      dismiss();
    };
    const onKeyDown = () => dismiss();

    window.addEventListener("pointerdown", onPress, true);
    window.addEventListener("mousedown", onPress, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPress, true);
      window.removeEventListener("mousedown", onPress, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [x, y, onClose]);

  return (
    <div
      ref={menuRef}
      className="tug-menu-content"
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      style={{ position: "fixed", left: -9999, top: -9999, visibility: "hidden" }}
    >
      <div className="tug-menu-label" role="presentation">
        No Actions
      </div>
    </div>
  );
}

/**
 * Whether DOM focus currently sits on an interactive control — a button, link,
 * form field, or ARIA widget. The Space-dismiss path for `spaceDismisses` info
 * popovers consults this so a Space on a control INSIDE the popover (a JOBS
 * stop button) still presses it; only a Space on the popover's own
 * non-interactive chrome closes it.
 */
function activeElementIsInteractive(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return el.matches(
    [
      "button",
      "a[href]",
      "input",
      "select",
      "textarea",
      "summary",
      '[role="button"]',
      '[role="menuitem"]',
      '[role="menuitemcheckbox"]',
      '[role="menuitemradio"]',
      '[role="option"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[role="tab"]',
      '[role="link"]',
      '[contenteditable="true"]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(","),
  );
}

// ---- ResponderChainProvider ----

/**
 * Provides a ResponderChainManager to its subtree and installs the key pipeline.
 *
 * Placement: inside ErrorBoundary, wrapping DeckCanvas (D07).
 * Tree: TugThemeProvider > ErrorBoundary > ResponderChainProvider > DeckCanvas
 */
export function ResponderChainProvider({ children }: { children: React.ReactNode }) {
  // Create the manager once and hold it in a ref so it is never replaced.
  const managerRef = useRef<ResponderChainManager | null>(null);
  if (managerRef.current === null) {
    managerRef.current = new ResponderChainManager();
  }
  const manager = managerRef.current;

  // The focus engine rides this same provider ([P01]): one manager, created
  // once, exposed as a sibling context. In this inert cut it only seeds its
  // key view from the chain's first responder (via `attach` below) and stamps
  // `data-key-view` — no Tab interception yet.
  const focusManagerRef = useRef<FocusManager | null>(null);
  if (focusManagerRef.current === null) {
    focusManagerRef.current = new FocusManager();
  }
  const focusManager = focusManagerRef.current;

  // L03: install registrations that events depend on in
  // `useLayoutEffect`, not `useEffect`. This effect installs six
  // document-level listeners (keydown capture + bubble, pointerdown,
  // mousedown, focusin, contextmenu) plus three cross-module
  // registrations (action-dispatch, card-lifecycle manager,
  // selection-guard attach). `useEffect` runs after paint, leaving
  // a window between React commit and the first flush where user
  // input can arrive without handlers — a missed first click, a
  // missed first keydown, or the browser's initial focus restore
  // landing before responder promotion is live. `useLayoutEffect`
  // runs synchronously before paint, closing the race. Same
  // rationale as `pane-focus-controller.ts`.
  useLayoutEffect(() => {
    // ---- ResponderChainManager registration with action-dispatch ----
    // Register the manager so the add-card-to-active-pane Control-frame action handler can
    // dispatch "add-card-to-active-pane" through the chain without importing React context.
    // ([D06], [D09])
    registerResponderChainManager(manager);

    // ---- The keymap registry's view of the scoped layers ----
    // The registry holds the global layer itself, but the mode and responder
    // layers are the chain's to know, and they change with every focus move —
    // so it reads them through this rather than caching a copy. The native
    // layer is the menu mirror's and arrives with the chord sweep; until then
    // `resolveChord` answers over the three JS layers, which is the whole
    // answer in browser dev and the JS half of it in the app.
    keymapRegistry.setEnvironment({
      scopedBindings: (): readonly ScopedBinding[] => {
        const mode = focusManager.currentFocusMode();
        return manager
          .liveKeybindings(mode === BASE_FOCUS_MODE ? [] : [mode])
          .map((live) => ({
            // A scoped binding may name a command, or a substrate verb that
            // is outside the table by declaration ([#non-goals]) — the
            // shadowing view wants both, because either one takes the chord.
            // When it names a command, that name is the attribution; the
            // action is the fallback spelling for the substrate verbs.
            commandId: live.binding.commandId ?? live.binding.action,
            chord: live.binding,
            scope:
              live.kind === "mode"
                ? { kind: "mode" as const, modeId: live.scopeId }
                : { kind: "responder" as const, responderId: live.scopeId },
            depth: live.depth,
          }));
      },
    });

    // ---- Edit-menu capability mirror ----
    // Mirror the focused responder's edit-action capabilities outward to
    // the native menu bar so the host validates Cut/Copy/Paste/Delete/
    // Select All/Undo/Redo and the Find items against real focus, not
    // WebKit's "the page is selectable" guess. `validateAction` is the
    // single source of truth (D05). Outward mirror only — no React
    // consumer reads it, so no `useSyncExternalStore` (same shape as
    // host-menu-state's deck/dev publishers). Seed now, then republish on
    // every validation change (focus / register / unregister).
    // Focused-native-control tracker for the host's NSUndoManager undo
    // path. The token changes whenever the focused native text control
    // changes (and reads 0 when none is focused); the Swift side clears
    // the web view's undo stack on every token change, so the
    // per-web-view native stack never outlives focus in one control.
    // Closure state, not React state — nothing renders from it.
    let nativeUndoCounter = 0;
    let lastNativeUndoEl: Element | null = null;

    // The registry's per-item gates are computed by the publisher itself,
    // which is the one place that holds both halves of what a predicate
    // asks — the chain and the merged menu blocks. Handing it the chain is
    // the whole wiring; every republish path below reaches the gates
    // through the same flush.
    registerMenuValidationChain(manager);

    const publishMenuCaps = (): void => {
      const caps = computeEditCapabilities(manager);
      // The chain first responder owns the edit menu. A deactivated card now
      // resigns first responder (a canvas-background click clears the active
      // card, and the chain promotes the deck-canvas root), so a deactivated
      // card's caps drop out on their own — no `document.activeElement`
      // liveness gate is needed. Undo/Redo labels read from the FR element.
      const frId = manager.getFirstResponder();
      const frEl =
        frId !== null
          ? document.querySelector(`[data-responder-id="${CSS.escape(frId)}"]`)
          : null;
      const active = document.activeElement;

      // Native text control focused? Then the host validates Undo/Redo
      // from the web view's NSUndoManager instead of the chain caps.
      const isNativeText =
        active instanceof HTMLTextAreaElement
          ? !active.readOnly && !active.disabled
          : active instanceof HTMLInputElement
            ? !active.readOnly && !active.disabled
            : false;
      if (isNativeText) {
        if (active !== lastNativeUndoEl) {
          nativeUndoCounter += 1;
          lastNativeUndoEl = active;
        }
      } else {
        lastNativeUndoEl = null;
      }

      const labels =
        frEl !== null ? editUndoLabelsWithin(frEl) : { undo: "", redo: "" };

      publishEditMenuState({
        ...caps,
        undoLabel: labels.undo,
        redoLabel: labels.redo,
        nativeUndoToken: isNativeText ? nativeUndoCounter : 0,
      });
    };
    publishMenuCaps();
    const unsubscribeEditCaps = manager.subscribe(publishMenuCaps);
    // Substrates request a recompute when a capability flips *within* the
    // focused responder (e.g. an editor's undo depth changing as the user
    // types) — those flips don't bump the validation version by design.
    registerMenuCapsRefresher(publishMenuCaps);
    // The native-undo token reads `document.activeElement`, which doesn't
    // always bump the validation version — so focus moves trigger their own
    // republish. Microtask defer lets the focus transition settle first; the
    // publisher's diff suppresses no-op posts.
    const onFocusChange = (): void => {
      queueMicrotask(publishMenuCaps);
      // Every settled focus change is a chance for the keyboard ring to have
      // drifted from the real keyboard sink; the guard verifies agreement
      // (microtask-coalesced inside the manager).
      focusManager.scheduleFocusInvariantCheck("focus-change");
    };
    document.addEventListener("focusin", onFocusChange, { capture: true });
    document.addEventListener("focusout", onFocusChange, { capture: true });

    // ---- Keyboard-route enforcement (the watchdog, Spec S03) ----
    // Every settled focus change triggers an enforcement pass: the engine
    // computes the one legal `activeElement` from its own state (sink /
    // granted surface / key-view element) and reasserts it when reality
    // differs — it never derives state FROM the register. Microtask-
    // coalesced inside the manager, so a focusout's transient `<body>`
    // active element is only ever observed settled.
    const enforceOnFocusIn = (): void => {
      focusManager.enforceKeyboardRoute("focusin");
    };
    const enforceOnFocusOut = (): void => {
      focusManager.enforceKeyboardRoute("focusout");
    };
    document.addEventListener("focusin", enforceOnFocusIn, { capture: true });
    document.addEventListener("focusout", enforceOnFocusOut, { capture: true });

    // Late-bind the responder chain manager to the CardLifecycle so
    // activations can promote the key responder. DeckManager
    // constructed the lifecycle in its own constructor and
    // registered it via `registerCardLifecycle`; we resolve it
    // here and hand over the manager instance. Safe when no
    // lifecycle is registered (test contexts that bootstrap only
    // the responder chain) — setManager is a no-op on null.
    const lifecycle = getCardLifecycle();
    lifecycle?.setManager(manager);

    // ---- FocusManager key card ([P21]) ----
    // The key card is **activation-driven**, and the deck store's focused card is
    // its single structural authority: it is set for EVERY way a card becomes
    // active — a click / tab switch / pane activation / cross-pane move (the
    // `_flipFirstResponder` path) AND the initial seed / cold boot (where the
    // store already holds the active card, so the lifecycle's same-bit guard
    // skips a `cardDidActivate` notify). Tracking the store directly avoids that
    // gap. The focus coordinator's active context follows it; projection is
    // downstream, so `getKeyCard`'s focus-derivation stays a consequence, never a
    // competing truth. Only fire on an actual change of the focused card — the
    // focus *claim* (landing DOM focus on the card's destination, incl. a pending
    // card-modal dialog [P20], and the re-projection on window blur→focus) stays
    // with `applyBagFocus`'s `adoptKeyCard`; this seam only names the key card.
    const deckStore = getDeckStore();
    let lastKeyCard: string | null | undefined;
    const syncKeyCard = (): void => {
      const next = deckStore?.getFirstResponderCardId() ?? null;
      if (next === lastKeyCard) return;
      lastKeyCard = next;
      focusManager.setKeyCard(next);
    };
    syncKeyCard();
    const unsubscribeKeyCard = deckStore?.subscribe(syncKeyCard) ?? (() => {});

    // ---- SelectionGuard lifecycle ----
    // Install SelectionGuard event listeners alongside the key pipeline.
    // Both are document-level event systems that live for the duration of
    // the provider. CSS Highlight objects are created eagerly in the
    // SelectionGuard constructor (not here) so they exist before any React
    // effects fire. attach() installs pointer / selection / keyboard
    // listeners, subscribes to the app lifecycle for resign/become-active
    // dim transitions, and subscribes to the deck store (via the
    // `deck-store-registry` singleton) so paint tracks `activePaneId` /
    // `activeCardId` transitions. ([D02])
    const appLifecycle = getAppLifecycle();
    selectionGuard.attach(appLifecycle);

    // ---- FocusManager lifecycle ----
    // Bind the focus engine to the chain so the key view tracks the first
    // responder. Installed here (not useEffect) for the same reason as the
    // listeners below — registrations events depend on must be live before
    // paint ([L03]). Detached in cleanup.
    focusManager.attach(manager);

    // Expose the engine to the single-channel focus dispatcher (`applyBagFocus`)
    // so a focus-axis restore can re-light the keyboard ring. Cleared on unmount.
    registerFocusManager(focusManager);

    // Keep the focus walk's keyboard-access mode in sync with the store. The
    // store is the source of truth (structure zone, [L02]); the manager holds
    // a mirror its pure walk reads. Seed now, then track changes.
    focusManager.setKeyboardAccessMode(keyboardAccessStore.getMode());
    const unsubscribeKeyboardAccess = keyboardAccessStore.subscribe(() => {
      focusManager.setKeyboardAccessMode(keyboardAccessStore.getMode());
    });

    // Ring modality: the store owns the policy ([L02]); the manager mirrors it
    // and repaints the ring on change. Seed now, then track changes.
    focusManager.setRingFollowsPointer(focusRingModalityStore.ringFollowsPointer());
    const unsubscribeRingModality = focusRingModalityStore.subscribe(() => {
      focusManager.setRingFollowsPointer(focusRingModalityStore.ringFollowsPointer());
    });

    // ---- Focus walk: Tab / Shift-Tab ([P04]) ----
    // Tab owns app-authored focus movement and is handled here, ahead of the
    // static keybinding map, so one code path resolves the precedence:
    //   1. A focused text surface that is consuming Tab right now (an editor
    //      with an open completion advertises `data-tug-tab-consume`): leave
    //      the event untouched so the surface's own keymap accepts the
    //      completion ([Q02] flag resolution).
    //   2. The focus walk advances the key view and lands DOM focus on it.
    // While no component has registered as a focusable yet, an empty walk
    // yields to the browser's native Tab so focus is never dead mid-migration.
    //
    // Tab and Shift-Tab are symmetric here: forward and reverse focus
    // navigation, the universal GUI convention. Tug deliberately departs from
    // the Claude Code TUI, where Shift-Tab cycles the permission mode — in a
    // GUI, Shift-Tab must move focus to the previous control. Permission-mode
    // cycling lives on ⌃⌥⌘P (key-card scope, in the keybinding map) plus the
    // session card's Mode chip / sheet and the /permissions command.
    function focusWalkListener(event: KeyboardEvent): void {
      if (event.key !== "Tab" || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      // (1) A surface that owns Tab keeps it — resolved by the KIND of surface,
      // never by its content ([P07]).
      //
      // A MULTI-LINE text surface (contentEditable / TEXTAREA) has a real Tab
      // meaning of its own: indent. So does anything advertising
      // `data-tug-tab-consume` right now — an editor with an open completion,
      // which accepts on Tab.
      //
      // A single-line `INPUT` does NOT. A plain field has no indent and no Tab
      // behavior to belong to it, so a Tab there is a request to LEAVE, and it
      // engages KBF and takes one step exactly like the nowhere case below.
      // Without that split, "a caret owns Tab" plus never-falling-through makes
      // Tab a dead key in every mode-OFF field — and takes Open Quickly's own
      // directory switcher and the find bar's controls out of keyboard reach.
      // The single-line/multi-line test is structural (tag kind), not a content
      // test, so it is not the emptiness rule this mode exists to delete.
      //
      // A multi-line surface can OPT OUT of that structural default with
      // `data-tug-tab-release` — the dialog answer field, which is multi-line
      // for wrapping rather than for indenting and whose Tab has to reach the
      // dialog's buttons. Checked first, because it is the surface overruling
      // the default drawn from its own kind.
      const active = document.activeElement;
      const releasesTab =
        active instanceof Element &&
        active.closest(`[${TAB_RELEASE_ATTRIBUTE}="true"]`) !== null;
      const surfaceConsumes =
        !releasesTab &&
        ((active instanceof Element &&
          active.closest(`[${TAB_CONSUME_ATTRIBUTE}="true"]`) !== null) ||
          (active instanceof HTMLElement &&
            (active.isContentEditable || active.tagName === "TEXTAREA")) ||
          focusManager.keyViewConsumesTab());
      if (surfaceConsumes) return;
      // (2) Everything else walks — a single-line field, the nowhere state (an
      // active card with no caret), an engine-routed stop. In mode OFF the walk
      // ENGAGES first, so the step the user just asked for is visible: Tab is
      // the most-tried key in any interface and it must always produce a
      // landing you can see ([P07]).
      if (advanceKeyViewFocus(focusManager, event.shiftKey ? -1 : 1)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      // (3) Nothing to move to. The engine consumes the Tab anyway rather than
      // yielding to WebKit ([P07] never-fall-through): a native Tab would land
      // DOM focus somewhere the engine does not know about, which is the state
      // the whole model exists to prevent. An empty walk is a guard tripping,
      // not a user-facing event — some subtree was never authored as engine
      // stops.
      tugDevLogStore.warn(
        "responder-chain-provider",
        "Tab consumed with an empty focus walk; a subtree here registers no engine stops",
        { mode: focusManager.currentFocusMode() },
      );
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    // ---- Spatial arrow navigation ([P22]/[P23]) ----
    // The parallel plane: bare arrows move the ring "in the direction you see",
    // bounded to the card / dialog, in author-declared order. A sibling of the focus
    // walk, registered ahead of the keybinding map so a bare arrow is resolved as
    // ring movement before a global binding can claim it (mirroring how the walk
    // owns Tab). Modified arrows (⌘/⌃/⌥/⇧) are left alone — they belong to editors,
    // sliders, and shortcuts. A component that captures arrows (an editor caret, a
    // slider value axis — [P25]) keeps them: the navigator yields when the key view
    // captures the key. When the ring rests on a selection group, an in-group arrow
    // delegates to its cursor; only an edge arrow crosses a seam ([P24] / [Q12]).
    // ---- Engine-synthesized acts on a leaf key view ----
    //
    // A leaf control (button, checkbox, switch, slider) operates natively: the
    // browser turns Space into a press, and Radix reads arrows off its own
    // keydown handler. Native handling needs the control to hold DOM focus —
    // but an engine-routed key view parks `document.activeElement` on the key
    // sink, so the control never sees the key and the stop is dead to the
    // keyboard.
    //
    // The engine closes that gap by synthesizing the act rather than by
    // surrendering the keyboard: the key view stays the router ([P01]) and the
    // sink stays parked, and the engine hands the named element the key it
    // would have received. DOM focus never becomes the truth for a leaf. This
    // is the standard-mode sibling of what accessibility mode does through
    // `mirrorKeyViewFocus`, minus the focus move.
    //
    // The re-entrancy latch is load-bearing: the forwarded event must bubble
    // (React attaches its handlers at the root container, so a non-bubbling
    // dispatch would never reach the component), which means it re-enters
    // these same document-level listeners.
    let deliveringToLeaf = false;
    function deliverToEngineLeaf(event: KeyboardEvent): boolean {
      if (deliveringToLeaf) return false;
      if (focusManager.keyboardRoute() !== "engine-routed") return false;
      const leaf = document.querySelector<HTMLElement>("[data-key-view]");
      if (leaf === null) return false;
      // Already holding real focus: the native pipeline is live, leave it be.
      const active = document.activeElement;
      if (active !== null && leaf.contains(active)) return false;
      // Same rule, for a surface that is PORTALLED rather than nested. A
      // trapped surface on top of the stack owns the keyboard; when the key
      // view is not a member of that mode it belongs to a mode below — a
      // popup button whose own menu is now open. Its menu holds real DOM
      // focus somewhere else in the tree, so the containment check above
      // cannot see it, and synthesizing the act here would deliver Return to
      // the trigger (re-toggling it) instead of to the highlighted item. The
      // surface on top gets the key; the leaf underneath does not.
      if (
        focusManager.currentFocusModeTrapped() &&
        !focusManager.currentModeMember(focusManager.keyView())
      ) {
        return false;
      }
      const forwarded = new KeyboardEvent("keydown", {
        key: event.key,
        code: event.code,
        bubbles: true,
        cancelable: true,
        composed: true,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      });
      deliveringToLeaf = true;
      try {
        leaf.dispatchEvent(forwarded);
      } finally {
        deliveringToLeaf = false;
      }
      // A synthetic keydown carries no default action, so Space/Enter on a
      // button-class control has to be completed as a press. Skipped when the
      // component consumed the key itself (a slider stepping its value).
      const isPress =
        event.key === " " || event.key === "Spacebar" || event.key === "Enter";
      if (isPress && !forwarded.defaultPrevented) leaf.click();
      return true;
    }

    /**
     * The attached-list yield ([P08], Spec S02): a field that declares
     * `data-tug-attached-list` owns ↑/↓ while its caret is live, in both KBF
     * modes and whatever its query says. Horizontal arrows are untouched —
     * they are caret keys, and a list has no left or right.
     *
     * Tested from `document.activeElement` by containment because the focused
     * element is the inner `<input>` while the marker rides its wrapper.
     */
    function insideAttachedList(direction: SpatialDirection): boolean {
      if (direction !== "up" && direction !== "down") return false;
      const active = document.activeElement;
      return (
        active instanceof Element &&
        active.closest(`[${ATTACHED_LIST_ATTRIBUTE}]`) !== null
      );
    }

    /**
     * A LIVE caret owns its caret keys, in either mode — [P07]'s structural
     * split applied to the arrow plane.
     *
     * The mode gate below answers "does a ring exist", which is not the same
     * question as "is the engine steering". They come apart in exactly the
     * state {@link FocusManager.kbfPainting} was written for: the mode is
     * engaged (a trapped sheet, a Class-B card) and a caret is nonetheless
     * granted, so the paint stands down and the keyboard belongs to the text
     * surface. Without this test the engine kept steering through that state —
     * a ↓ in the question dialog's answer field carried the ring off to a
     * button and took the caret with it, and the ↑ back left the stop PARKED,
     * so a user mid-sentence could not type. Nothing painted at the moment of
     * the theft, which is what made it invisible.
     *
     * Structural, by the KIND of surface — never by its content, and never by
     * the mode:
     *
     *  - **Horizontal** arrows belong to any caret. A text surface has a left
     *    and a right; that is what a caret moves along. (The same sentence the
     *    attached-list contract already makes for its own reason.)
     *  - **Vertical** arrows belong to a MULTI-LINE surface (contentEditable /
     *    `TEXTAREA`), which has lines to move between — including a surface
     *    that is multi-line for wrapping rather than for indenting, since a
     *    wrapped line is still a line. A single-line `INPUT` has no second
     *    line, so its ↑/↓ stay with the plane, exactly as its `Tab` does.
     *
     * `data-tug-tab-release` has no counterpart here on purpose: it exists
     * because `Tab` is ambiguous on a multi-line surface (indent, or leave?).
     * A vertical arrow is not — it is the caret's own key.
     */
    function caretOwnsArrow(direction: SpatialDirection): boolean {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return false;
      const multiLine = active.isContentEditable || active.tagName === "TEXTAREA";
      if (!multiLine && active.tagName !== "INPUT") return false;
      if (direction === "left" || direction === "right") return true;
      return multiLine;
    }

    function arrowNavListener(event: KeyboardEvent): void {
      const direction = arrowDirection(event.key);
      if (direction === null) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      // The mode gate ([P04]/[P07]). In mode OFF the ring does not exist, so
      // nothing moves it: arrows are caret keys, unconditionally, and a text
      // surface owns all four of them whatever its content. This lands in the
      // same commit as the paint gate deliberately — gating the rings while the
      // movement stages still walked would ship an app where focus moves
      // invisibly, which is worse than either endpoint.
      if (!focusManager.kbfEngaged()) return;
      if (insideAttachedList(direction)) return;
      const focusKey = {
        key: event.key,
        altKey: event.altKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
      };
      // A component that captures this arrow (a slider's value axis — [P25]) keeps
      // it; the spatial plane yields. Yielding is not enough on its own when the
      // route is engine-routed: nothing downstream holds DOM focus, so the
      // engine delivers the arrow to the capturing leaf itself.
      if (focusManager.keyViewCaptures(focusKey)) {
        if (deliverToEngineLeaf(event)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      // Sited after the capture branch so a control that declares an arrow its
      // own (a value input stepping on ←/→) keeps it, and before the plane so a
      // granted caret is never steered out from under.
      if (caretOwnsArrow(direction)) return;
      if (focusManager.moveKeyViewSpatial(direction)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }

    /**
     * Should this Escape be left to the act-dispatch stage — the engine's single
     * Escape arbiter — instead of being dispatched into the responder chain
     * here as a `CANCEL_DIALOG`?
     *
     * Outside `BASE_FOCUS_MODE` the answer has always been yes: every
     * dismissable surface pushes a mode the ladder knows how to unwind.
     *
     * At BASE the answer used to be an unconditional no, and that is the seam
     * this closes. A key view that declares Escape its own (`captures`) is
     * bypassed in the most common state there is — no dialog, no descend scope
     * — so who arbitrated the press depended on invisible mode state: the rail
     * list's "while there is a set, Escape is the list's" contract held inside a
     * popover and not on the plain deck. Consulting the same predicate
     * `actDispatchListener` consults makes one arbitration story for all modes.
     */
    function escapeBelongsToLadder(event: KeyboardEvent): boolean {
      if (event.key !== "Escape") return false;
      if (focusManager.currentFocusMode() !== BASE_FOCUS_MODE) return true;
      return focusManager.keyViewCaptures({
        key: event.key,
        altKey: event.altKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
      });
    }

    // ---- Stage 1: capture-phase listener (global shortcuts) ----
    function captureListener(event: KeyboardEvent): void {
      // [P03] An engine-synthesized Escape (the context-menu close lever) is the
      // engine's own close mechanism, not a user Escape — never re-arbitrate it;
      // let it pass through to the target surface's Radix layer.
      if (isSyntheticEscape(event)) return;
      // An armed chord capture owns every key: the press is an answer to
      // "what should this command be bound to", and matching it here would
      // fire the chord's *old* meaning on its way to being recorded. The
      // capture surface's own listener reads it instead.
      if (chordCaptureState.isArmed()) return;
      // Resolve dynamic, context-scoped bindings first ([P11],
      // #keybinding-registry): the active focus mode (innermost — a floating
      // surface's accelerators, reachable even when focus is elsewhere, e.g. an
      // inline dialog while the prompt holds focus) then the first-responder
      // walk, innermost-first. Fall back to the static global map. Both layers
      // share one match rule and one dispatch path below.
      const mode = focusManager.currentFocusMode();
      const binding = manager.resolveKeybinding(
        event,
        mode === BASE_FOCUS_MODE ? [] : [mode],
      );

      // No scoped claim: the global layer answers, and it answers with a
      // COMMAND. Everything past this point — routing, payload, the
      // continuation — is read from the registry entry rather than from the
      // binding, which is what makes a chord and a menu item two doors on one
      // row instead of two implementations that have to be kept in step.
      if (binding === null) {
        const match = keymapRegistry.matchChord(event);
        if (match === null) return;
        // ⌘Q, ⌘H, ⌘M, ⌃⌘F: named in the table so the keymap UI can show
        // them, performed by AppKit, never routed through JS. The chord
        // passes through untouched.
        if (COMMANDS_BY_ID.get(match.commandId)?.routing === "native") return;
        if (
          match.commandId === TUG_ACTIONS.CANCEL_DIALOG &&
          escapeBelongsToLadder(event)
        ) {
          return;
        }
        if (match.binding.preventDefault === true) event.preventDefault();
        if (dispatchCommand(match.commandId)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      // A scoped binding on a real command names the command, and everything
      // past the match — routing, payload, validity — is read from its
      // registry entry, exactly as the global layer's is. Only the verbs
      // deliberately outside the table (the PDF card's scroll keys, the
      // gallery's demo chord) dispatch an action of their own below.
      if (binding.commandId !== undefined) {
        if (binding.preventDefaultOnMatch) event.preventDefault();
        if (dispatchCommand(binding.commandId)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      // Escape yields to the engine's Escape ladder (the act-dispatch listener
      // below), which is the single arbiter ([P02] final form) — on any non-base
      // focus mode, and at BASE whenever the key view captures the press
      // (`escapeBelongsToLadder`). Every dismissable surface now pushes a mode with an
      // `onEscapeDismiss` callback (branch (2)), every descend scope is
      // non-trapped (branch (4)), and a focus-cycle is `escapeExits` (branch (5)) —
      // so the ladder always knows what to do, and the old per-surface special
      // cases (the trapped-no-callback CANCEL_DIALOG dispatch and the DOM probe)
      // are gone. ⌘. (key `.`) never enters this guard (the `event.key` condition),
      // so it stays chain-routed for every surface (#non-goals).
      if (
        binding.action === TUG_ACTIONS.CANCEL_DIALOG &&
        escapeBelongsToLadder(event)
      ) {
        return;
      }
      // [D06] preventDefaultOnMatch: suppress browser default on match (e.g.
      // Cmd+A native select-all) before dispatching to the responder chain.
      if (binding.preventDefaultOnMatch) {
        event.preventDefault();
      }
      // Use sendToFirstResponderForContinuation so two-phase action handlers (those
      // that return a continuation callback from their sync body — e.g.
      // cut: synchronously write clipboard, continuation deletes selection)
      // run to completion under keyboard shortcuts. The context menu
      // defers continuations until after its activation blink; the
      // keyboard path has no blink, so the continuation fires immediately
      // after the sync phase.
      //
      // `binding.value` is copied onto the dispatched event only when
      // present. ⌘1..⌘9 use this to carry the 1-based tab index for
      // `jumpToTab`; every other binding leaves `value` undefined and
      // the handler sees the same shape it always did. [A3 / R4]
      //
      // `binding.scope` picks the routing. `"first-responder"` (default)
      // walks up from the current first responder. `"key-card"`
      // dispatches to the active card's `card-content` responder,
      // independent of which element is currently focused — the
      // mechanism that lets ⌘K work when the user clicks the card's
      // title bar before pressing the chord.
      const actionEvent = {
        action: binding.action,
        phase: "discrete" as const,
        ...(binding.value !== undefined ? { value: binding.value } : {}),
      };
      const { handled, continuation } =
        binding.scope === "key-card"
          ? manager.sendToKeyCardForContinuation(actionEvent)
          : manager.sendToFirstResponderForContinuation(actionEvent);
      if (handled) {
        event.preventDefault();
        event.stopImmediatePropagation();
        continuation?.();
        return;
      }
    }

    // ---- Act dispatch: Space / Enter / Escape ([P01]) ----
    // The model's act tier, resolved against the focused component's declared
    // behavior. Capture phase, sited AFTER the keybinding listener (a matched
    // binding wins and stops propagation before this runs) and AFTER a key-capture
    // leaf (an editor keeps its keys), but ahead of the bubble default-button
    // stage. Every branch is GUARDED so it is non-interfering: Space/Enter act
    // only when the key view declares an item/component behavior (a leaf falls
    // through to native / the default-button stage), and Escape ascends only when
    // an engine scope is descended — otherwise it falls through to the cancel
    // ladder ([R04]).
    function actDispatchListener(event: KeyboardEvent): void {
      // [P03] never re-arbitrate an engine-synthesized Escape (see captureListener).
      if (isSyntheticEscape(event)) return;
      if (event.metaKey || event.ctrlKey) return;
      const key = event.key;
      if (key !== " " && key !== "Spacebar" && key !== "Enter" && key !== "Escape") {
        return;
      }
      const focusKey = {
        key,
        altKey: event.altKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
      };
      // An editor leaf owns its keys ([P04]) — never act on a captured key.
      if (focusManager.keyViewCaptures(focusKey)) return;
      // A text surface really holding DOM focus owns Space/Enter for typing
      // — a granted editor, a state-keyed field, or a bare native control
      // the target union cannot name. (The settled-focus derivation used to
      // coarsen the key view away from behaviors here; with the keyboard
      // engine-routed, the guard is structural instead.) Escape stays with
      // the ladder below.
      if (key !== "Escape") {
        const typing = document.activeElement;
        if (
          typing instanceof HTMLElement &&
          (typing.isContentEditable ||
            typing.tagName === "INPUT" ||
            typing.tagName === "TEXTAREA" ||
            typing.tagName === "SELECT")
        ) {
          return;
        }
      }
      // An editor advertising it owns keys *right now* (an open completion sets
      // `data-tug-tab-consume`) keeps Escape too — [P04]'s "Tab/Escape are
      // captured only transiently by an open completion": Escape closes the
      // completion first rather than ascending a scope. (Tab is already deferred
      // by the focus-walk listener via the same marker.)
      if (key === "Escape") {
        const active = document.activeElement;
        if (
          active instanceof Element &&
          active.closest(`[${TAB_CONSUME_ATTRIBUTE}="true"]`) !== null
        ) {
          return;
        }
      }

      // Return at a PARKED text stop grants the caret without typing ([P12]) —
      // the "you are here, now type" half of the parked state, opposite the
      // printable branch's "type and I'll assume you meant to". Sited ahead of
      // the act resolution because a parked stop has no act to resolve: it is a
      // text surface the engine is holding the keyboard away from.
      if (key === "Enter" && focusManager.hasParkedTextStop()) {
        focusManager.grantParkedTextStop();
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const behavior = focusManager.keyViewBehavior();
      const act = resolveFocusAct(focusKey, behavior ?? { container: "none" });
      switch (act) {
        case "select":
          behavior?.onSelect?.();
          // [P15] a keyboard value-commit may relinquish a toggleable cycle
          // (the mode's own disposition decides; no-op otherwise).
          focusManager.applyCommitDisposition("select");
          event.preventDefault();
          event.stopImmediatePropagation();
          break;
        case "descend":
          behavior?.onDescend?.();
          focusManager.applyCommitDisposition("descend");
          event.preventDefault();
          event.stopImmediatePropagation();
          break;
        case "act":
          // Intercept only for a container that declares an act; a leaf's
          // Space/Enter stays with the existing pipeline (native button press,
          // bubble default-button), so leaf act-consistency is unchanged.
          if (behavior && behavior.container !== "none" && behavior.onAct) {
            behavior.onAct();
            // [P15] an item-group value commit may relinquish a toggleable cycle.
            focusManager.applyCommitDisposition("act");
            event.preventDefault();
            event.stopImmediatePropagation();
            break;
          }
          // A leaf key view under the engine route: no native press can reach
          // it, so the engine synthesizes the act on the named element.
          // Ordered ahead of the space-dismiss branch below, which is for a
          // Space that lands on a popover's own non-interactive chrome — that
          // branch requires an empty / non-interactive key view, which is
          // exactly the case this one declines to handle.
          if (deliverToEngineLeaf(event)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            break;
          }
          // [P02] generalized: a second Space closes an info popover that opted
          // into space-dismiss — the symmetric partner to the Space that opened
          // it from its trigger leaf. Gated to a Space landing on the popover's
          // own non-interactive chrome (the key view is empty / a tabindex=-1
          // content wrapper); a Space on a control inside keeps its native press.
          if (
            (key === " " || key === "Spacebar") &&
            focusManager.currentFocusModeSpaceDismisses() &&
            !activeElementIsInteractive()
          ) {
            const dismiss = focusManager.currentFocusModeOnEscapeDismiss();
            if (dismiss !== null) {
              dismiss();
              event.preventDefault();
              event.stopImmediatePropagation();
            }
          }
          break;
        case "ascend":
        case "cancel":
          // The single Escape ladder ([P02], Spec #escape-ladder). `keyViewCaptures`
          // and the synthetic-marker / tab-consume early-returns above are the
          // ladder's first rungs; the rest resolves against the top focus mode:
          //  (2a) a parked TEXT stop on a stack with no Class A trap → the
          //      grant ([P12]) — Escape asks for the caret, sited ahead of the
          //      surface's dismiss so it takes a second Escape to close;
          //  (2) top mode registered `onEscapeDismiss` → the surface owns its close;
          //      call it and consume — the engine decides WHEN, the surface HOW;
          //  (4) a NON-trapped descended scope (accordion section, list row): ascend
          //      one level;
          //  (5) a trapped focus-cycle that opted into Escape-exit (`escapeExits`):
          //      pop the cycle back to its resting key view. No DOM probe: an open
          //      surface over the cycle is its OWN top mode with a callback (branch
          //      (2)), which consumes the Escape, so the cycle's mode is only ever
          //      top — and this branch only ever reached — with no surface open;
          //  (3) a trapped surface with no callback and no `escapeExits`: dev-warn
          //      guard and yield (today's Stage-1 `CANCEL_DIALOG` + Radix
          //      fallthrough still closes it during migration);
          //  base mode: nothing — falls through to the cancel ladder ([R04]).
          if (focusManager.currentFocusMode() !== BASE_FOCUS_MODE) {
            const onEscapeDismiss = focusManager.currentFocusModeOnEscapeDismiss();
            // Escape at a PARKED text stop asks for the caret, not the close
            // — the same grant rungs (5) and (6) run, sited ahead of the
            // surface's own dismiss so "stop steering" and "close the
            // surface" stay two gestures ([P12] #printable-grant: "a
            // printable character — or Escape — at a parked text stop").
            // Without this rung, ⌥⇥ inside a typing-first dialog ringed the
            // query field and the Escape meant to hand the caret back closed
            // the whole surface instead. Gated to a stack with NO Class A
            // trap: a kbf:false surface (the modal input dialog, a cycle) is
            // where a park is the manual mode's doing and Escape's first
            // meaning is to undo it; an auto-engaging sheet keeps its
            // Escape-closes contract, parked stop or not.
            //
            // And gated on the mode PAINTING, which is the rung's whole
            // licence: Escape cancels a mode the user can SEE. Engagement and
            // paint come apart — a bit the deck set before a launcher opened
            // keeps the mode engaged inside it while a live caret stands the
            // marks down — and in that state this rung spent the press
            // un-parking a stop nothing marked: a modal surface that did not
            // close, for a mode that was not showing. In a modal state Escape
            // exits the modal state; the only thing that outranks that is a
            // ring on screen saying the keyboard is somewhere else. The manual
            // bit is
            // cleared before the grant (the printable branch's sequence) so
            // the re-landing grants rather than re-parks; a second Escape
            // then falls through here — no parked stop — and closes.
            if (
              focusManager.kbfPainting() &&
              !focusManager.hasEngagingTrap() &&
              focusManager.hasParkedTextStop()
            ) {
              focusManager.setKbfManual(false);
              focusManager.grantParkedTextStop();
              event.preventDefault();
              event.stopImmediatePropagation();
            } else if (onEscapeDismiss !== null) {
              onEscapeDismiss();
              event.preventDefault();
              event.stopImmediatePropagation();
            } else if (!focusManager.currentFocusModeTrapped()) {
              focusManager.ascend();
              behavior?.onAscend?.();
              event.preventDefault();
              event.stopImmediatePropagation();
            } else if (focusManager.currentFocusModeEscapeExits()) {
              // Escape while the cycle's ring PARKS a text stop grants the
              // caret right there ([P12]) — the ring says "you are here" and
              // Escape says "stop steering": together, type here, mode off.
              // The same clear-then-grant sequence the printable branch runs:
              // clearing the bit first makes the settle's re-landing a GRANT
              // (mode off ⇒ nothing parks), so caret and ring never coexist.
              // Without this rung the Escape fell through to the cycle pop,
              // which landed the caret at the card's RESTING editor — the
              // composer / the file body — instead of the ringed find field.
              // Non-text stops keep the pop: they have no caret to grant.
              if (focusManager.hasParkedTextStop()) {
                focusManager.setKbfManual(false);
                focusManager.grantParkedTextStop();
              } else {
                focusManager.escapeCurrentMode();
              }
              event.preventDefault();
              event.stopImmediatePropagation();
            } else {
              // A trapped surface that did not register a dismiss callback. During
              // migration its Escape still rides Stage-1's CANCEL_DIALOG dispatch;
              // this is a guard for a future surface that forgets to register.
              tugDevLogStore.warn(
                "responder-chain-provider",
                "Escape reached a trapped focus mode with no onEscapeDismiss; yielding to the surface's own close path",
                { mode: focusManager.currentFocusMode() },
              );
            }
          } else if (focusManager.kbfManual()) {
            //  (6) the last rung, structurally below every one above: at the
            //      BASE mode with KBF manually engaged, Escape leaves the mode.
            //      This is the rail / diff-card case — a card engaged by ⌥⇥
            //      with no cycle scope of its own, so there is no `escapeExits`
            //      mode for rung (5) to pop. Sited under the "not base mode"
            //      branch precisely so it can never pre-empt a dismissable
            //      surface: while any surface is open its mode is current, and
            //      Escape belongs to it (R02).
            //
            //      Clear-then-grant, the printable branch's sequence: with the
            //      bit cleared the settle re-lands the key view, and a text
            //      stop's landing is a caret grant (mode off ⇒ nothing parks),
            //      so Escape with the ring on a text stop leaves the caret
            //      blinking right there. The grant self-guards, so a non-text
            //      stop simply leaves the mode.
            focusManager.setKbfManual(false);
            focusManager.grantParkedTextStop();
            event.preventDefault();
            event.stopImmediatePropagation();
          }
          break;
        default:
          break; // move / passthrough / capture — leave to the component / browser
      }
    }

    // ---- Key-view delegation ([P05] / Spec S04) ----
    // The engine's key-delivery channel to components: after the walk /
    // spatial / bindings / act stages decline a key, the current key view's
    // behavior `onKey` gets it — the replacement for element-attached keydown
    // listeners, which die structurally once keys route from the engine's
    // target (keydown lands on the sink, never in a component subtree).
    // Registered after `actDispatchListener`, occupying the same precedence
    // slot element-capture handlers had (document capture runs before element
    // capture on the way down). The manager gates dom-granted mode and ⌘/⌃
    // chords structurally; the editable-active guard here is the migration
    // belt while DOM focus still lands on granted surfaces via the settled
    // derivation (it becomes redundant once the route is enforced).
    function keyViewDelegateListener(event: KeyboardEvent): void {
      if (event.defaultPrevented) return;
      // ---- The printable grant on a parked text stop ([P12], #printable-grant) ----
      //
      // Typing at a parked stop is a request for the caret: clear the manual
      // bit, grant DOM focus, and let the browser type the character into the
      // just-focused editor. The grant is SYNCHRONOUS inside this capture
      // keydown and the event is deliberately NOT prevented — that is what
      // makes the browser's own beforeinput → input pipeline land the character
      // in the newly focused surface, with no synthetic re-dispatch and no
      // clipboard trick.
      //
      // Gates: a single character (`length === 1`, so it excludes every named
      // key), no ⌘/⌃ (those are bindings), and not mid-composition — an IME
      // sequence must never be interrupted by a focus move ([R01]). Space is a
      // printable here, which is what makes it type a space rather than commit;
      // Space keeps its commit meaning on every NON-text stop, which this
      // branch does not touch.
      if (
        event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.isComposing &&
        focusManager.hasParkedTextStop()
      ) {
        focusManager.setKbfManual(false);
        focusManager.grantParkedTextStop();
        return;
      }
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.isContentEditable ||
          active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA")
      ) {
        return;
      }
      if (focusManager.dispatchKeyToKeyView(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }

    // ---- The arrow liveliness net ([P01], Spec S01) ----
    // The floor under the spatial plane: a bare arrow that nothing has claimed
    // moves the ring one step along the mode's linear walk order, wrapping. This
    // is what carries the key view across surfaces that declare no spatial order
    // — the rail's sections, any list whose edge the navigator declined.
    //
    // It runs AFTER the key-view delegate on purpose: a descended row scope's
    // in-row arrow walks and any `KeyViewBehavior.onKey` consumer own their keys,
    // and the net catches only what is genuinely unclaimed. Any element really
    // holding DOM focus owns its own arrows; the net never walks focus out from
    // under one.
    function arrowFallbackListener(event: KeyboardEvent): void {
      if (event.defaultPrevented) return;
      const direction = arrowDirection(event.key);
      if (direction === null) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      // The mode gate, as in `arrowNavListener` — the net catches nothing when
      // there is no ring to catch it for ([P04]/[P07]).
      if (!focusManager.kbfEngaged()) return;
      if (insideAttachedList(direction)) return;
      const active = document.activeElement;
      if (
        active !== null &&
        active !== document.body &&
        !(active instanceof HTMLElement && active.closest(`[${KEY_SINK_ATTRIBUTE}]`) !== null)
      ) {
        // Some element holds real DOM focus — a Radix menu item, a native
        // control, a granted editor. It owns its arrows; the net never walks
        // focus out from under it. With the release policy gone this is the
        // whole text-surface rule here: a caret keeps its arrows because it
        // holds focus, not because a policy handed them back.
        return;
      }
      const focusKey = {
        key: event.key,
        altKey: event.altKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
      };
      // Defensive parity with the earlier stage: a capturing key view (a slider's
      // value axis) keeps its arrow even here.
      if (focusManager.keyViewCaptures(focusKey)) return;
      const moved = focusManager.moveKeyViewLinear(direction);
      // Nothing registered to move to — decline rather than swallow the key. A
      // so this branch is defensive, not a beep path.
      if (moved === null) return;
      focusManager.place(null, { kind: "focusable", id: moved }, { modality: "keyboard" });
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    // ---- Engine scroll-key route ([Q02]) ----
    // Bare PageUp / PageDown / Home / End in engine-routed mode, after every
    // earlier stage (including the key-view delegate — a ringed list owns its
    // own Page keys) declined them. Element-attached scroll handling and the
    // browser's native focus-driven key scrolling both require DOM focus
    // inside the scroll container, which engine-routed mode never grants — so
    // the engine routes the intent itself: first through the responder chain's
    // established transcript paging actions (the same handlers the ⌃⌘[/] and
    // ⌃⇧⌘[/] chords drive, [D07]-coherent), then a generic region scroll via
    // the `tug-region-scroll-set` channel every scroll region listens on.
    function engineScrollKeyListener(event: KeyboardEvent): void {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const k = event.key;
      if (k !== "PageUp" && k !== "PageDown" && k !== "Home" && k !== "End") return;
      if (focusManager.keyboardRoute() === "dom-granted") return;
      // Migration belt (like the delegate listener above): an editable active
      // element owns its Page/Home/End keys for the caret.
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.isContentEditable ||
          active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA")
      ) {
        return;
      }
      // (1) The key card's own paging actions — the transcript's entry-aligned
      // steps, follow-bottom coherent.
      const action =
        k === "PageUp"
          ? TUG_ACTIONS.PREVIOUS_TURN
          : k === "PageDown"
            ? TUG_ACTIONS.NEXT_TURN
            : k === "Home"
              ? TUG_ACTIONS.FIRST_TURN
              : TUG_ACTIONS.LAST_TURN;
      const { handled, continuation } = manager.sendToKeyCardForContinuation({
        action,
        phase: "discrete",
      });
      if (handled) {
        event.preventDefault();
        event.stopImmediatePropagation();
        continuation?.();
        return;
      }
      // (2) Generic fallback: page the key card's first live scroll region
      // through the `tug-region-scroll-set` channel (SmartScroll-coherent —
      // the same event CardHost's cold-boot restore uses).
      const cardId = focusManager.keyCard();
      if (cardId === null) return;
      const scope = document.querySelector(
        `[data-card-id="${CSS.escape(cardId)}"]`,
      );
      if (scope === null) return;
      const region = Array.from(
        scope.querySelectorAll<HTMLElement>("[data-tug-scroll-key]"),
      ).find(
        (el) => el.offsetParent !== null && el.scrollHeight > el.clientHeight,
      );
      if (region === undefined) return;
      const page = Math.max(40, region.clientHeight - 48);
      const max = region.scrollHeight - region.clientHeight;
      const top =
        k === "Home"
          ? 0
          : k === "End"
            ? max
            : k === "PageUp"
              ? Math.max(0, region.scrollTop - page)
              : Math.min(max, region.scrollTop + page);
      region.dispatchEvent(
        new CustomEvent("tug-region-scroll-set", {
          detail: { top, left: region.scrollLeft },
          bubbles: false,
          cancelable: true,
        }),
      );
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    // ---- Stages 2-4: bubble-phase listener ----
    function bubbleListener(event: KeyboardEvent): void {
      // Stage 2: keyboard navigation -- Enter-key default-button activation.
      // [D02] Enter-key check lives in stage-2 of the bubble pipeline.
      // [D04] Activation via synthetic click (element.click()).
      if (event.key === "Enter") {
        const active = document.activeElement as HTMLElement | null;
        // A focus-refusing button (`data-tug-focus="refuse"`) that holds DOM
        // focus is the engine's *ringed* control — e.g. a card-modal dialog's
        // Allow / Deny ([P17]): they ride the engine key-view ring and refuse to
        // own DOM focus, so the browser's native focused-button Enter never fires
        // for them. Such a button must be activated through this engine path, not
        // skipped as "native handles it" — otherwise Enter on the ringed Allow
        // (after a Tab tour lands DOM focus on it) does nothing. A NON-refusing
        // focused button still keeps native Enter (it activates itself).
        const activeIsRefusingButton =
          active !== null &&
          active.tagName === "BUTTON" &&
          active.getAttribute("data-tug-focus") === "refuse";
        // A focused button owns the key that activates it natively — the
        // PLAIN Return — and nothing else. A Return carrying a modifier is a
        // DECLARED CHORD ([#chord-ring]): the entry's Shift+Return submit,
        // whose wearer is the Z5 wearing the dashed ring. A neighbouring
        // button must not swallow it by standing where the keyboard happens
        // to rest. The 2026-09-12 failure is exactly that: the keyboard on
        // the composer's Auto-Message ✨, the Z5 one gutter away ringed and
        // promising ⇧⏎, and the join it offered unreachable from the key —
        // silently, because a skipped activation leaves nothing behind. The
        // chord match below is exclusive, so letting a modifier-bearing
        // Return through here can only ever reach a button that asked for it.
        const plainReturn =
          !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
        const skipActivation =
          active !== null &&
          (active.tagName === "INPUT" ||
            active.tagName === "TEXTAREA" ||
            active.tagName === "SELECT" ||
            active.isContentEditable ||
            (active.tagName === "BUTTON" && !activeIsRefusingButton && plainReturn));
        if (!skipActivation) {
          // The Enter target is the ringed control. In engine-routed mode no
          // control holds native focus (the keyboard is parked on the sink),
          // so the ringed KEY VIEW is the control Enter presses — activated
          // through the engine ([P08]: the old focus-refusing-button special
          // case is now the universal case; a refusing button that still
          // holds DOM focus keeps the direct path). When the ring is on a
          // non-control stop (a list / field / item-group), Enter falls to
          // the pane's default button ([P14] "Return's home").
          //
          // Scope the default-button fallback to the surface the user is
          // working in — the first responder's card, else its pane. A default
          // button registered elsewhere (a sheet in ANOTHER pane, an inactive
          // card still mounted in this pane's tab stack) must NOT be pressed
          // by it ([D15] pane modality). With no context (gallery /
          // standalone) fall back to the global top.
          let defaultButton: HTMLElement | null = null;
          if (activeIsRefusingButton) {
            defaultButton = active;
          } else if (focusManager.keyboardRoute() === "engine-routed") {
            const ringed = document.querySelector<HTMLElement>(
              "[data-key-view-kbd]",
            );
            if (
              ringed !== null &&
              (ringed.tagName === "BUTTON" ||
                ringed.getAttribute("role") === "button")
            ) {
              defaultButton = ringed;
            }
          }
          // A ringed control answers for the key it declares, and YIELDS the
          // rest ([#chord-ring]). The ring is on the ✨ beside the composer's
          // Z5; the Z5 is the one wearing `⇧⏎` in its own dashed ring. Taking
          // the ringed control as the Enter target and only then discarding it
          // on the chord — with the fallback already behind us — dropped that
          // chord on the floor: the 2026-09-12 join that could be clicked and
          // could not be typed, silently, because a swallowed key leaves
          // nothing behind. So the candidate is tested BEFORE the fallback,
          // and a candidate that does not answer to this chord stands down to
          // the one that does.
          if (defaultButton !== null && !defaultButtonAnswersChord(defaultButton, event)) {
            defaultButton = null;
          }
          if (defaultButton === null) {
            const frId = manager.getFirstResponder();
            const frEl =
              frId !== null && typeof document !== "undefined"
                ? document.querySelector(`[data-responder-id="${CSS.escape(frId)}"]`)
                : null;
            defaultButton = manager.peekDefaultButtonForOrigin(frEl);
          }
          if (defaultButton !== null && !defaultButtonAnswersChord(defaultButton, event)) {
            defaultButton = null;
          }
          if (defaultButton !== null) {
            // Press visual ([L06] — appearance via DOM). The button's
            // CSS variants treat `[data-pressing="true"]` the same as
            // `:active` (`:is(:active, [data-pressing="true"])`
            // selectors in `tug-button.css`), so a Return-activation
            // paints identically to a real mouse click. Native
            // `:active` doesn't fire for a synthetic `.click()`, so
            // we toggle the attribute by hand.
            defaultButton.setAttribute("data-pressing", "true");
            window.setTimeout(() => {
              defaultButton.removeAttribute("data-pressing");
            }, DEFAULT_BUTTON_PRESS_MS);
            defaultButton.click();
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }
        // No default button registered or guard triggered -- fall through to stage 3/4.
      }

      // Stage 3: chain action dispatch.
      // Skip if the event target is a native text input or contenteditable.
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          // Stage 4: passthrough -- let browser handle text input.
          return;
        }
      }
      // Stage 3 stub: Phase 3 does not map additional keys through the chain
      // here; that is handled entirely by the keybinding map in stage 1.
      // Future phases extend this branch.

      // Stage 4: implicit passthrough.
    }

    // ---- Target-based first-responder promotion ----
    //
    // Two document-level capture-phase listeners (pointerdown and
    // focusin) resolve the innermost registered responder under the
    // event target — via `data-responder-id` attributes written by
    // `useResponder` — and promote it to first responder. This is the
    // single mechanism for "click-to-focus" and "Tab-to-focus" in the
    // chain. No per-component `makeFirstResponder` calls, no focus
    // listeners on individual editors, no pointerdown handlers in
    // tug-pane or tug-prompt-input. Nested responders compose
    // naturally: clicking or tabbing into an editor inside a card
    // makes the editor first responder without any per-component
    // wiring.
    //
    // Why capture phase on document (vs. bubble, vs. a deeper element):
    //
    // 1. Running in capture phase at the document level means these
    //    listeners fire *before* the event reaches the target, and
    //    therefore before any React-delegated onPointerDown/onFocus
    //    handler in the tree. During a mixed-state migration, if an
    //    old component still has an unconditional `makeFirstResponder`
    //    call in its own pointerdown handler, our promotion runs first
    //    and the old handler becomes redundant but not harmful.
    //
    // 2. Descendant elements cannot suppress us with
    //    `event.stopPropagation()`. Capture-phase listeners on an
    //    ancestor run *before* the event reaches the stopping element
    //    — stopPropagation at a descendant only affects the remaining
    //    propagation path (remaining capture to target, then bubble
    //    back), not listeners that already ran. So even a component
    //    that calls `e.stopPropagation()` in its own pointerdown
    //    handler cannot prevent first-responder promotion here.
    //    `stopImmediatePropagation` likewise only affects listeners
    //    on the *same* element, so a descendant's version can't touch
    //    a document-level listener. The only way to break this
    //    invariant would be another capture-phase listener at
    //    document or window that called `stopImmediatePropagation`
    //    *and* was registered before ours — which no other code in
    //    the suite does.
    //
    // Focus-based promotion is needed alongside pointer-based because
    // keyboard-only users reach responders via Tab, programmatic
    // `.focus()`, or the browser's initial focus restoration on
    // page load — none of which fire a pointerdown. `focusin` bubbles
    // (unlike `focus`), so a single document-level listener catches
    // it for every descendant.
    function promoteFromTarget(target: Node | null): void {
      const id = manager.findResponderForTarget(target);
      if (id !== null && id !== manager.getFirstResponder()) {
        manager.makeFirstResponder(id);
      }
    }

    // ---- Focus refusal for chrome controls ----
    //
    // Controls marked with data-tug-focus="refuse" (buttons, checkboxes,
    // switches, sliders, etc.) should not steal keyboard focus or
    // first-responder status from the active editor. This is the web
    // equivalent of Cocoa's acceptsFirstResponder = false.
    //
    // The refusal is one of the facts the gesture interpreter classifies, so
    // for pointer gestures it arrives here as `promotion: "skip"` /
    // `placement: "skip"` on the record, and the interpreter's own mousedown
    // handler is what prevents the browser focus default. Controls only need
    // the attribute; nothing here re-derives it from the event.
    //
    // Bounded semantics. Per `tugplan-dev-overlay-framework.md` [D01]
    // (#mental-model), `data-tug-focus="refuse"` controls exactly three
    // keyboard-ownership behaviors and nothing else: chain-promotion-skip,
    // key-view-placement-skip, and browser-focus-prevention. The three are one
    // idea — the control is outside the key loop, so no pointer gesture on it
    // moves any keyboard register. It does NOT gate pane activation or
    // deselect. See [D01] for the disambiguation rationale and
    // (#mental-model) for the five-subsystem model.

    // ---- Pointer-driven placement (Risk R01's mitigation) ----
    // Click transitions are ENGINE-FIRST: a pointerdown that resolves to an
    // engine-addressable target places it (pointer modality) at capture
    // phase, BEFORE the browser's mousedown focus default — so the settled
    // state after any click is already legal, or one watchdog pass from it.
    // Resolution is structural: a `data-tug-state-key` control places as
    // state-key; a registered focusable places by id; a responder places
    // only when it declared a focus contract (a real text surface). A click
    // that resolves to nothing engine-addressable while a text surface holds
    // the grant places `none` — the keyboard leaves the surface (matching
    // the pre-inversion blur) and parks at the engine.
    //
    // Whether the gesture may place at all is the interpreter's call
    // (`placement: "place"`): it is what knows that a focus-refusing control is
    // outside the key loop, that a cross-card activation click realizes the
    // card's RECORDED destination rather than whatever sat under the pointer,
    // and that a surface may have declared its chrome placement-suppressing.
    // This body is only the resolution — which engine target the click names.
    function placeFromPointer(target: EventTarget | null, cardId: string): void {
      const el =
        target instanceof Element
          ? target
          : target instanceof Node
            ? target.parentElement
            : null;
      if (el === null) return;
      const marker = el.closest<HTMLElement>(
        "[data-tug-state-key], [data-tug-focusable], [data-responder-id]",
      );
      if (marker !== null) {
        const stateKey = marker.getAttribute("data-tug-state-key");
        if (stateKey !== null) {
          focusManager.place(cardId, { kind: "state-key", key: stateKey }, {
            modality: "pointer",
            preventScroll: true,
          });
          return;
        }
        const focusableId = marker.getAttribute("data-tug-focusable");
        if (focusableId !== null) {
          focusManager.place(cardId, { kind: "focusable", id: focusableId }, {
            modality: "pointer",
          });
          return;
        }
        const responderId = marker.getAttribute("data-responder-id");
        if (
          responderId !== null &&
          focusManager.responderHasFocusContract(responderId)
        ) {
          focusManager.place(cardId, { kind: "responder", responderId }, {
            modality: "pointer",
          });
          return;
        }
      }
      // Nothing engine-addressable under the click (transcript prose, a
      // contract-less container). If a text surface currently holds the
      // grant, the keyboard leaves it — place `none` so the route flips to
      // engine-routed and the sink parks (a park provably preserves the
      // text selection a drag is creating). Otherwise leave everything: the
      // key view survives (Tab resumes from it) and the watchdog re-parks
      // the browser's transient mousedown focus.
      if (focusManager.keyboardRoute() === "dom-granted") {
        focusManager.place(cardId, { kind: "none" }, { modality: "pointer" });
      }
    }

    // The chain's half of a classified pointer gesture. Every decision here is
    // read from the interpreter's record:
    //
    //   - `skip` — a focus-refusing control (targeted dispatch makes the first
    //     responder irrelevant to its action, and accelerators need the
    //     responder left on the editor), first-responder-preserving chrome (an
    //     activation/drag surface, not a responder target), or draggable
    //     content in a background card, whose promotion defers with its
    //     activation so the chain and deck registers cannot split.
    //   - `redirect` — a stray click on a modal scrim promotes the dialog
    //     island instead of the click target, so first responder lands on (and
    //     activates) the dialog's card rather than the scrimmed surround.
    //   - `target` — promote from the click target, then place, so the click's
    //     focus transition is driven by the engine at pointerdown, ahead of the
    //     browser's mousedown focus default, never derived after the fact.
    function promoteOnPointerDown(event: PointerEvent): void {
      const gesture = currentGesture();
      if (gesture === null) {
        // No interpreter installed (a bare provider outside the deck): promote
        // from the target and leave the engine placement alone.
        promoteFromTarget(event.target as Node | null);
        return;
      }
      if (gesture.promotion.kind === "skip") return;
      if (gesture.promotion.kind === "redirect") {
        promoteFromTarget(gesture.promotion.to);
        return;
      }
      promoteFromTarget(event.target as Node | null);
      if (gesture.placement === "place" && gesture.cardId !== null) {
        placeFromPointer(event.target, gesture.cardId);
      }
    }

    function promoteOnFocusIn(event: FocusEvent): void {
      if (targetRefusesFocus(event.target)) return;
      promoteFromTarget(event.target as Node | null);
      // Granted-surface legalization: a text surface that claims DOM focus
      // through its own channel becomes the engine's dom-granted target —
      // structurally scoped so the grant can never launder a cross-card
      // steal:
      //  - a `data-tug-state-key` native control anywhere (form controls
      //    are the state-key class of [P02]; sheet autofocus and label
      //    clicks are their normal claim channels);
      //  - a contract responder ONLY when its card is the key card (a
      //    card's own content claiming focus while its card is active is
      //    the activation-consistent grant — `cardDidActivate` /
      //    `sheetDidHide` reclaims; a NON-key-card editor claiming focus
      //    is exactly the steal class the watchdog corrects).
      const el =
        event.target instanceof HTMLElement ? event.target : null;
      if (el === null) return;
      const stateKeyEl = el.closest<HTMLElement>("[data-tug-state-key]");
      if (stateKeyEl !== null) {
        const key = stateKeyEl.getAttribute("data-tug-state-key");
        const cardId = stateKeyEl
          .closest<HTMLElement>("[data-card-id]")
          ?.getAttribute("data-card-id");
        if (key !== null && cardId !== undefined && cardId !== null) {
          focusManager.place(cardId, { kind: "state-key", key }, {
            modality: focusManager.inputSource(),
            preventScroll: true,
          });
        }
        return;
      }
      const responderEl = el.closest<HTMLElement>("[data-responder-id]");
      if (responderEl === null) return;
      const responderId = responderEl.getAttribute("data-responder-id");
      if (
        responderId === null ||
        !focusManager.responderHasFocusContract(responderId)
      ) {
        return;
      }
      const cardId = responderEl
        .closest<HTMLElement>("[data-card-id]")
        ?.getAttribute("data-card-id");
      if (cardId == null || focusManager.keyCard() !== cardId) return;
      focusManager.place(cardId, { kind: "responder", responderId }, {
        modality: focusManager.inputSource(),
        preventScroll: true,
      });
    }

    // ---- Fallback context menu ----
    //
    // Suppress the browser's native context menu everywhere in the app.
    // Components that have their own menus (text inputs, markdown view,
    // copyable labels) call preventDefault in their own handlers — those
    // fire before this document-level handler. This catches everything
    // else and shows a "No Actions" fallback menu.
    function fallbackContextMenu(event: MouseEvent): void {
      if (event.defaultPrevented) return;
      event.preventDefault();
      fallbackMenuRef.current?.({ x: event.clientX, y: event.clientY });
    }

    // focusWalkListener is registered before captureListener so it owns Tab
    // in the capture phase ahead of the global-shortcut dispatch. arrowNavListener
    // sits between them: it owns bare arrows for the spatial plane ahead of the
    // keybinding map, the same precedence the walk has for Tab ([P22]).
    // arrowFallbackListener is the far end of that same arrow story — the
    // liveliness net ([P01]) — and so registers AFTER keyViewDelegateListener:
    // descended row scopes and `onKey` consumers get their arrows first, and the
    // net picks up only what nothing claimed.
    // ---- Input-source latch ----
    // The engine's modality latch: the last REAL user input source. The ring
    // projection reads it for native focus changes; a placement overrides it
    // per call. Pure-modifier keydowns don't count as keyboard navigation.
    const noteKeyboardInput = (event: KeyboardEvent): void => {
      const k = event.key;
      if (k === "Shift" || k === "Meta" || k === "Alt" || k === "Control") return;
      focusManager.noteInputSource("keyboard");
    };
    const notePointerInput = (): void => {
      focusManager.noteInputSource("pointer");
      // **Using the mouse leaves KBF mode** ([P05]). Keyboard focus is a
      // keyboard mode; the moment the user reaches for the pointer they have
      // left keyboard navigation, so the manual bit drops and the click's own
      // placement proceeds. One listener for the whole deck — this rule used to
      // be per-cycle-consumer, which meant a card without a cycle scope never
      // got it. The engine pops a live cycle synchronously in here, ahead of
      // the click's focus placement, so no ring outlives the click.
      focusManager.clearKbfManualForPointer();
    };
    document.addEventListener("keydown", noteKeyboardInput, { capture: true });
    document.addEventListener("pointerdown", notePointerInput, { capture: true });

    // ---- Held-modifier latch ----
    // `data-mods` on <html>, read by the chord ring (a Shift+Return default
    // paints dashed until Shift is actually down, alone). Installed here because this
    // is where the deck's key pipeline lives; the projection itself is
    // appearance-only ([L06]) and belongs to no context.
    const uninstallModifierLatch = installModifierLatch();

    document.addEventListener("keydown", focusWalkListener, { capture: true });
    document.addEventListener("keydown", arrowNavListener, { capture: true });
    document.addEventListener("keydown", captureListener, { capture: true });
    document.addEventListener("keydown", actDispatchListener, { capture: true });
    document.addEventListener("keydown", keyViewDelegateListener, { capture: true });
    document.addEventListener("keydown", arrowFallbackListener, { capture: true });
    document.addEventListener("keydown", engineScrollKeyListener, { capture: true });
    document.addEventListener("keydown", bubbleListener);
    document.addEventListener("pointerdown", promoteOnPointerDown, { capture: true });
    document.addEventListener("focusin", promoteOnFocusIn, { capture: true });
    document.addEventListener("contextmenu", fallbackContextMenu);

    // **Creating a card leaves KBF mode.** A new card arrives with its own
    // resting focus and its own idea of where the keyboard belongs, so a ring
    // left over from the gesture that opened it is pointing at the deck the
    // user just replaced. Hung off CONSTRUCTION rather than off each of the
    // deck's several add paths (`addCard`, `addCardToPane`,
    // `showSingletonCard`, the sidebar rail) so no path can be added later
    // that misses it — the same reason the pointer rule above is one document
    // listener instead of a per-cycle-consumer hook.
    //
    // The wildcard subscription initial-syncs for every already-constructed
    // card, synchronously inside `observeCardDidFinishConstruction`; `settled`
    // gates that replay out, so restoring a deck at launch is not read as
    // creating one card per restored card.
    let settled = false;
    const unsubscribeCardConstruction =
      getCardLifecycle()?.observeCardDidFinishConstruction(null, () => {
        if (!settled) return;
        focusManager.setKbfManual(false);
      }) ?? null;
    settled = true;

    return () => {
      unsubscribeCardConstruction?.();
      uninstallModifierLatch();
      document.removeEventListener("keydown", noteKeyboardInput, { capture: true });
      document.removeEventListener("pointerdown", notePointerInput, { capture: true });
      document.removeEventListener("keydown", focusWalkListener, { capture: true });
      document.removeEventListener("keydown", arrowNavListener, { capture: true });
      document.removeEventListener("keydown", captureListener, { capture: true });
      document.removeEventListener("keydown", actDispatchListener, { capture: true });
      document.removeEventListener("keydown", keyViewDelegateListener, { capture: true });
      document.removeEventListener("keydown", arrowFallbackListener, { capture: true });
      document.removeEventListener("keydown", engineScrollKeyListener, { capture: true });
      document.removeEventListener("keydown", bubbleListener);
      document.removeEventListener("pointerdown", promoteOnPointerDown, { capture: true });
      document.removeEventListener("focusin", promoteOnFocusIn, { capture: true });
      document.removeEventListener("contextmenu", fallbackContextMenu);
      selectionGuard.detach();
      document.removeEventListener("focusin", onFocusChange, { capture: true });
      document.removeEventListener("focusout", onFocusChange, { capture: true });
      document.removeEventListener("focusin", enforceOnFocusIn, { capture: true });
      document.removeEventListener("focusout", enforceOnFocusOut, { capture: true });
      registerMenuCapsRefresher(null);
      registerMenuValidationChain(null);
      // The scoped-binding view installed above captures this manager; an
      // unmounted provider's chain must not keep answering resolveChord.
      keymapRegistry.setEnvironment({ scopedBindings: () => [] });
      unsubscribeEditCaps();
      unsubscribeKeyboardAccess();
      unsubscribeRingModality();
      unsubscribeKeyCard();
      registerFocusManager(null);
      focusManager.detach();
    };
  }, [manager, focusManager]);

  // Fallback "No Actions" context menu state. The document-level
  // contextmenu handler calls the ref'd setter to open it.
  const [fallbackMenu, setFallbackMenu] = useState<{ x: number; y: number } | null>(null);
  const fallbackMenuRef = useRef(setFallbackMenu);
  fallbackMenuRef.current = setFallbackMenu;
  const closeFallbackMenu = useCallback(() => setFallbackMenu(null), []);

  return (
    <ResponderChainContext.Provider value={manager}>
      <FocusManagerContext.Provider value={focusManager}>
        {children}
        {/* The engine-owned key sink (Spec S01): the one legal
            `document.activeElement` while the keyboard route is
            engine-routed. Rendered by the provider so it exists exactly
            as long as the engine does. A parking register, not an ARIA
            composite — no `aria-activedescendant` (invalid from a
            sibling); the screen-reader story is the accessibility-mode
            focus-follows mirror, under which the sink is never focused.
            Quiet `aria-label` rather than `aria-hidden` (a focusable
            element must not be aria-hidden). Excluded from the walk and
            the focusable registry by construction (it registers
            nothing). */}
        <div
          data-tug-key-sink=""
          tabIndex={-1}
          className="tug-key-sink"
          aria-label="Keyboard"
        />
      </FocusManagerContext.Provider>
      {fallbackMenu && createPortal(
        <FallbackContextMenu
          x={fallbackMenu.x}
          y={fallbackMenu.y}
          onClose={closeFallbackMenu}
        />,
        document.body,
      )}
    </ResponderChainContext.Provider>
  );
}

// ---- Convenience hooks ----

/**
 * Returns the nearest ResponderChainManager, or null if called outside a
 * ResponderChainProvider.
 *
 * Safe for components (like TugButton) that may render both inside and outside
 * the chain scope. When null, the component should fall through to its default
 * (direct-action) behavior.
 */
export function useResponderChain(): ResponderChainManager | null {
  return useContext(ResponderChainContext);
}

/**
 * Returns the nearest ResponderChainManager.
 *
 * Throws if called outside a ResponderChainProvider. Use this hook for
 * components that must always be inside the chain scope (programming error
 * if they are not).
 */
export function useRequiredResponderChain(): ResponderChainManager {
  const manager = useContext(ResponderChainContext);
  if (manager === null) {
    throw new Error(
      "useRequiredResponderChain must be used inside a <ResponderChainProvider>"
    );
  }
  return manager;
}
