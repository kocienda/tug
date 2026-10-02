/**
 * useCycleMode — the keyboard-focus-cycling mode primitive a text-first card
 * opts into ([P09]/[P10] of the focus-language rollout).
 *
 * A text-first card's resting key view is its editor, which owns Tab
 * (completion / indent). Cycling mode frees Tab to circulate the card's chrome
 * zones instead: it pushes a **trapped** engine focus mode whose members are the
 * card's cycle stops, seeds the key view on the first stop (the commit-home, by
 * authored order), and — on toggle again or an explicit exit — pops the mode,
 * restoring the key view the engine captured when the mode was pushed (the
 * editor caret). Tab walks only the cycle stops while the mode is current and
 * wraps within them ([#cfrunloop-model] trapped mode + `advance`'s modular
 * wrap); the editor is in the base mode and is untouched until restore.
 *
 * This is the general mechanism (the session card is the first consumer). It adds no
 * new engine projection — it drives the existing focus-mode stack
 * (`pushFocusMode` / `popFocusMode` / `focusFirstInMode` / `focusKeyView`), so
 * it is the [P04] behavior carve-out via [P09], appearance untouched.
 *
 * Wiring (the consumer's responsibilities):
 *   - register the toggle on a key-card responder for `CYCLE_FOCUS_MODE`
 *     (`{ [TUG_ACTIONS.CYCLE_FOCUS_MODE]: () => toggle() }`), so ⌥⇥ reaches it;
 *   - wrap the cycle-able zones in the returned `CycleScope` so their
 *     `useFocusable` callers register into this mode (they must also set a
 *     `focusGroup` to register at all);
 *   - order the stops so the **commit-home is the lowest `focusOrder`** — it is
 *     what `focusFirstInMode` seeds on entry ([P10]).
 *
 * Laws: [L02] `cycling` is derived from the engine via `useSyncExternalStore`
 *       (the focus-mode stack is the single source of truth — no parallel React
 *       state to desync); [L22] the mode is mutated imperatively on the manager;
 *       [L03] mount cleanup pops the mode in a layout effect; [L26] `CycleScope`
 *       holds a constant function identity so children never remount.
 *
 * @module components/tugways/use-cycle-mode
 */

import React, {
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import {
  BASE_FOCUS_MODE,
  FocusManagerContext,
  FocusModeContext,
} from "./focus-manager";
import type { CycleDisposition, FocusCommit } from "./focus-manager";
import type { SpatialDirection } from "./spatial-order";
import { CardIdContext } from "@/lib/card-id-context";

/**
 * The toggleable-cycling default disposition ([P15]): a keyboard value commit at
 * a stop (`select` / `act` on an item-group) returns the keyboard to the editor
 * (relinquish); `descend` keeps cycling (you went deeper, not done). Leaf acts
 * (chips / Z2 cells that open a popover) go native and never reach this path, so
 * they retain by construction. A persistent context (`useFocusTrap`) injects no
 * disposition at all, so it retains — the derivation from the [P13] type.
 */
function toggleableCommitDisposition(commit: FocusCommit): CycleDisposition {
  return commit.kind === "select" || commit.kind === "act"
    ? "relinquish"
    : "retain";
}

export interface UseCycleModeOptions {
  /**
   * Whether the card is eligible to cycle right now (e.g. a session card only when
   * connected, not while the picker is up). When `false`, `toggle` is inert and
   * the mode is never pushed. Defaults to `true`.
   */
  enabled?: boolean;
  /**
   * Optional per-context override for the cycle commit disposition ([P15]).
   * Omit to inherit the toggleable default (a `select`/`act` value-commit
   * relinquishes the cycle back to the editor; `descend` retains). Provide a
   * function to decide per-stop / per-commit — e.g. keep cycling after a
   * particular stop commits. Returns `"retain"` or `"relinquish"`.
   */
  dispositionAfterCommit?: (commit: FocusCommit) => CycleDisposition;
  /**
   * Land the resting caret when the cycle is relinquished — the card's resting
   * focus destination (a session card's prompt entry). Called when `cycling` flips
   * false by any non-pointer path: ⌥⇥ toggle-off, the editor text-stop's
   * Return-descend, or a sub-surface commit that relinquishes the cycle ([P15] —
   * {@link FocusContext.relinquishFocusMode}). Skipped on a mouse exit (the click
   * places focus itself). This makes the relinquish landing a first-class part of
   * the cycle, not bespoke per-card glue. Runs in a layout effect after the
   * cycle's zones reactivate ([L04]).
   */
  restingFocus?: () => void;
}

export interface UseCycleModeResult {
  /** Whether cycling mode is currently active (this card's scope is on top). */
  cycling: boolean;
  /** Toggle cycling on/off — wire to the `CYCLE_FOCUS_MODE` (⌥⇥) action. */
  toggle: () => void;
  /**
   * Exit cycling if active (caret returns to the editor). Reached programmatically
   * via the editor text-stop's Return-descend. A bare Escape while a cycle stop
   * holds the ring also exits cycling, through the engine rather than this
   * function — at a NON-text stop the `escapeExits` disposition pops the cycle
   * and the resting caret lands off the `cycling` flip (`restingFocus`); at a
   * PARKED TEXT stop the Escape is a caret GRANT at that stop ([P12]), and
   * every landing here yields to it. The other exits are the ⌥⇥ `toggle` and
   * the mouse-exit rule below.
   */
  exit: () => void;
  /** Wrap the card's cycle-able zones so they register into this mode. */
  CycleScope: React.FC<{ children: React.ReactNode }>;
  /** This card's stable cycle-scope id (for diagnostics / advanced wiring). */
  scopeId: string;
}

export function useCycleMode({
  enabled = true,
  dispositionAfterCommit,
  restingFocus,
}: UseCycleModeOptions = {}): UseCycleModeResult {
  const manager = useContext(FocusManagerContext);
  // The owning card ([P21]): the cycle mode is pushed onto, and read back from,
  // THIS card's focus context — so the `cycling` snapshot stays correct even
  // after the card is switched to the background (its cycle is preserved in its
  // own universe; the active card's mode never bleeds in). `null` outside a card
  // host routes to the default / active context.
  const cardId = useContext(CardIdContext);
  const ctx = useMemo(
    () => (manager === null ? null : manager.contextFor(cardId)),
    [manager, cardId],
  );
  // Stable per-card scope id. The cycle stops (rendered under `CycleScope`) and
  // the push/pop here agree on this one id.
  const scopeId = useId();

  // Latest commit-disposition override, read at commit time via a stable wrapper
  // so an inline `dispositionAfterCommit` never re-installs the pushed mode or
  // churns the `toggle`/`enter` identities ([L24] structure-zone ref).
  const dispositionRef = useRef(dispositionAfterCommit);
  dispositionRef.current = dispositionAfterCommit;
  const commitDispositionRef = useRef<(commit: FocusCommit) => CycleDisposition>(
    (commit) => (dispositionRef.current ?? toggleableCommitDisposition)(commit),
  );

  // Latest resting-focus reclaim, read live by the relinquish effect ([L07]).
  const restingFocusRef = useRef(restingFocus);
  restingFocusRef.current = restingFocus;

  // `cycling` is the engine's own state, read through `useSyncExternalStore`
  // ([L02]): the mode is "on" exactly when this card's scope is **on the mode
  // stack** — current, OR merely covered by a transient mode pushed on top of
  // it (a popover / sheet opened from within the cycle). Using stack-membership
  // (not top-of-stack) is deliberate: opening a nested surface from a cycle stop
  // must NOT read as "exited cycling" — otherwise the consumer would tear down
  // its cycling treatment (and, e.g., yank the caret back to its editor) the
  // instant a status-cell popover opens, then be stranded when it closes. The
  // toggle/exit guards below still use top-of-stack (`currentFocusMode`); only
  // this "am I still cycling?" snapshot is stack-membership. No parallel React
  // boolean — so a pop from any path (toggle, exit, unmount, a covering surface
  // closing) is reflected without a chance to desync.
  const subscribe = useCallback(
    (onChange: () => void) => (manager === null ? () => {} : manager.subscribe(onChange)),
    [manager],
  );
  const getSnapshot = useCallback(
    () => (ctx === null ? false : ctx.isFocusModePushed(scopeId)),
    [ctx, scopeId],
  );
  const cycling = useSyncExternalStore(subscribe, getSnapshot);
  // The deck-global manual KBF bit ([P05]) — the source of truth for "the user
  // asked for keyboard focus". This card's trapped cycle scope is its per-card
  // realization, mirrored from the bit rather than held as a second boolean, so
  // the two cannot desync.
  const kbfManual = useSyncExternalStore(
    subscribe,
    useCallback(() => manager?.kbfManual() ?? false, [manager]),
  );
  // Whether this card is the key card — only the key card's cycle may be
  // entered. A background card's already-entered cycle is left standing: its
  // focus universe is preserved by construction, which is what makes returning
  // to a mid-cycle card land where it left off.
  const isKeyCard = useSyncExternalStore(
    subscribe,
    useCallback(() => (manager?.keyCard() ?? null) === cardId, [manager, cardId]),
  );

  // Land the resting caret when the cycle is relinquished. This fires off the
  // engine-owned `cycling` transition (true → false) by ANY non-pointer path —
  // ⌥⇥ toggle-off, the editor text-stop's Return-descend, or a sub-surface commit
  // that relinquished the cycle ([P15]). Because it rides the engine's own state
  // flip, the cycle owns its resting landing as one transition (no card-side
  // race); running in a layout effect, it fires after the cycle's zones (the
  // prompt editor) reactivate, so the caret lands ([L03]/[L04]). Skipped on a
  // mouse exit — the click that ended the cycle places focus itself.
  //
  // The same edge drops the deck-global bit: every path out of the cycle
  // (Escape's `escapeExits` pop, a relinquishing commit, the pointer) is a
  // request to leave keyboard focus, and without this the mirror below would
  // read a stale `true` and re-enter the cycle the engine just popped.
  const prevCyclingRef = useRef(false);
  useLayoutEffect(() => {
    if (prevCyclingRef.current && !cycling) {
      const byPointer = manager?.kbfClearedByPointer() ?? false;
      manager?.setKbfManual(false);
      // A dom-granted route at this point means the exit already landed a
      // caret — a grant at a parked text stop (Escape / a printable at the
      // find bar's query field), or `exit()`'s own realization of the restored
      // editor. Either way the keyboard is home; `restingFocus` would move a
      // caret somebody just placed.
      if (!byPointer && manager?.keyboardRoute() !== "dom-granted") {
        restingFocusRef.current?.();
      }
    }
    prevCyclingRef.current = cycling;
  }, [cycling, manager]);

  // Push captures the current key view (the editor caret) for restore on pop.
  // The mode carries the toggleable commit disposition ([P15]) — a stable
  // wrapper reading the latest override (or the toggleable default) — and opts
  // into Escape-exit: a bare Escape while a cycle stop holds the ring pops the
  // cycle back to rest (the engine's `escapeExits`), since a focus-cycle, unlike
  // a modal surface, has no surface that owns Escape.
  const pushMode = useCallback(() => {
    // Entering the cycle IS engaging keyboard focus, whichever door was used —
    // ⌥⇥, or a text stop spending its Tab on movement. The bit and the scope
    // go up together, or the mirror below would read an un-engaged deck and pop
    // the cycle the caller just entered.
    manager?.setKbfManual(true);
    ctx?.pushFocusMode(scopeId, {
      trapped: true,
      commitDisposition: (commit) => commitDispositionRef.current(commit),
      escapeExits: true,
      // NOT a KBF auto-engager ([P03]). `trapped` here buys Escape semantics,
      // not a surface: this scope is the manual mode's own realization on this
      // card, created BY engagement. Letting it count as Class A would make the
      // mode its own cause — clearing the manual bit would leave it engaged by
      // the very cycle the clear is supposed to end, so nothing could ever
      // leave the mode from inside a cycle.
      kbf: false,
    });
  }, [ctx, scopeId, manager]);

  const enter = useCallback(() => {
    if (ctx === null || !enabled) return;
    pushMode();
    // Ring where the keyboard already is. Only a card entered from nowhere —
    // no key view to keep — seeds the commit-home ([P10]); with the caret in
    // the composer the editor's own stop takes the ring and parks.
    ctx.enterModeAtKeyView();
  }, [ctx, enabled, pushMode]);

  const exit = useCallback(() => {
    if (ctx === null) return;
    if (ctx.currentFocusMode() !== scopeId) return;
    // A caret GRANTED at a cycle stop survives the exit ([P12]) — Escape or a
    // printable at a parked text stop (the find bar's query field) grants the
    // caret there, and that grant IS the exit's landing. The pop restores the
    // pre-cycle key view (the editor), so re-assert the granted stop after it
    // rather than focusing the restored one — otherwise the exit machinery
    // yanks the caret the user just asked for back to the resting editor.
    const grantedKeyView =
      manager !== null && manager.keyboardRoute() === "dom-granted"
        ? manager.keyView()
        : null;
    ctx.popFocusMode(scopeId);
    if (grantedKeyView !== null && manager !== null) {
      manager.place(
        cardId,
        { kind: "focusable", id: grantedKeyView },
        { modality: "keyboard" },
      );
    } else {
      // Pop restored the captured prior key view (the editor); land DOM focus
      // on it so the caret returns.
      ctx.focusKeyView();
    }
  }, [ctx, scopeId, manager, cardId]);

  // ⌥⇥ no longer flips a card-local notion of cycling: it sets the deck-global
  // manual bit, and the mirror effect below turns that into this card's
  // push/pop. One bit, one realization — they cannot disagree. The engine owns
  // the gesture's semantics (a live caret returns to the ring rather than
  // toggling off, [P09]); the card owns only where the ring lands.
  const toggle = useCallback(() => {
    manager?.toggleKbfManual();
  }, [manager]);

  // Mirror the deck-global bit onto this card's cycle scope ([P05]).
  //
  // The manager is read LIVE here rather than from the `kbfManual` snapshot:
  // the clear-on-exit effect above runs earlier in the same commit, and a
  // snapshot captured before it would re-enter the cycle that just ended. The
  // snapshot is in the deps to schedule this effect, not to answer it.
  //
  // The mouse-exit rule that used to live here as a capture `pointerdown`
  // listener is now one provider-level listener clearing the bit — see
  // {@link FocusManager.clearKbfManualForPointer}, which also pops the cycle
  // synchronously inside the pointerdown so the ring never outlives the click.
  // The bit goes up for reasons that have nothing to do with this card. While a
  // floating surface holds a mode above it — Open Quickly, a sheet, a menu —
  // entering here would push the card's cycle ON TOP of that surface's trap,
  // and the walk would then service a mode whose stops are all behind a modal
  // overlay (`pointer-events: none`, so the walk order comes back empty and Tab
  // moves nothing). It is the same wrong target the ⌥⇥ action already refuses
  // to hand the gesture to while a non-base mode is up (`action-dispatch.ts`);
  // this is the other door into the same room, since ANY engagement — a Tab
  // spent on movement inside the surface, not just ⌥⇥ — sets the bit.
  useLayoutEffect(() => {
    if (ctx === null || manager === null) return;
    const manual = manager.kbfManual();
    const atRestingMode = ctx.currentFocusMode() === BASE_FOCUS_MODE;
    if (manual && !cycling && enabled && isKeyCard && atRestingMode) enter();
    else if (!manual && cycling) exit();
  }, [ctx, manager, kbfManual, cycling, enabled, isKeyCard, enter, exit]);

  // Safety: a card unmounting (or its eligibility dropping) while cycling must
  // not leave its scope stranded on its context's mode stack. Pop on unmount
  // ([L03]) — routed to the card's own context so it pops the right stack even
  // if the card is no longer the key card.
  useLayoutEffect(() => {
    return () => {
      ctx?.popFocusMode(scopeId);
    };
  }, [ctx, scopeId]);

  // Stable scope component (constant identity across renders so children never
  // remount, [L26]). It always provides the scope id; the cycle stops register
  // into this mode via their `useFocusable` reading `FocusModeContext`.
  const scopeRef = useRef<React.FC<{ children: React.ReactNode }> | null>(null);
  if (scopeRef.current === null) {
    const id = scopeId;
    scopeRef.current = function CycleScope({
      children,
    }: {
      children: React.ReactNode;
    }) {
      return (
        <FocusModeContext.Provider value={id}>
          {children}
        </FocusModeContext.Provider>
      );
    };
  }

  return useMemo(
    () => ({
      cycling,
      toggle,
      exit,
      CycleScope: scopeRef.current!,
      scopeId,
    }),
    [cycling, toggle, exit, scopeId],
  );
}
