/**
 * `useDashRowMenu` — the two rare verbs a dash row offers, behind one opener.
 *
 * Bind/Unbind and Discard used to stand on the row as text buttons, beside the
 * pop-out and the fold cue. Standing there they read as peers of the acts a
 * reader performs constantly, which they are not: a card binds a dash once and
 * discards one almost never, and the row's whole job in between is to be read.
 * So they move behind a `⋯`, which is where a suite puts a verb that is real,
 * reachable, and rare.
 *
 * The join is not among them, and that is the point of the arc: joining is a
 * decision made in the composer, on Z5, so a menu here offering it would be a
 * second door to a gesture that has one. What is left is exactly the pair that
 * has nowhere else to live — neither is a chord, because neither names a
 * target a chord could reach ("the dash this row is").
 *
 * **A disabled item still says why.** A disabled item takes no pointer events,
 * so a `title` on one can never be read, and a tooltip on one never fires
 * ([L31] — a refusal that cannot be read is a silent one). The reason
 * therefore rides the item's own label: `Unbind — a turn is running`. The item
 * stays present rather than vanishing, so the menu's height does not change
 * with the dash's state and the reader is told what is blocked rather than
 * left to notice an absence.
 *
 * `TugEditorContextMenu` rather than the Radix-backed `TugContextMenu`, for the
 * same reason {@link useSessionIdentityMenu} takes it: it moves no focus, and a
 * shade row is chrome — opening a menu on one must not take the key view away
 * from the card the reader is working in.
 *
 * Laws: [L11] the items are typed actions dispatched to this hook's own
 *       responder, never callbacks reaching around the chain;
 *       [L19] the menu is composed from `TugEditorContextMenu`, never from the
 *       internal popup machinery it is built on;
 *       [L22] the open point is view-scope local state.
 *
 * @module components/tugways/cards/session-changes/dash-row-menu
 */

import React from "react";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import {
  TugEditorContextMenu,
  type TugEditorContextMenuEntry,
} from "@/components/tugways/tug-editor-context-menu";
import { useOptionalResponder } from "@/components/tugways/use-responder";

/**
 * One verb the menu offers.
 *
 * `disabledReason` non-null both disables the item and supplies the clause
 * appended to its label. Nothing else may disable an item: an item disabled
 * with no reason is a refusal nobody can read.
 */
export interface DashRowMenuVerb {
  /** Why the verb is unavailable right now, or null when it is available. */
  disabledReason: string | null;
  /** Perform it. Called inside the item's activation. */
  perform: () => void;
}

export interface DashRowMenuOptions {
  /**
   * Bind or Unbind, whichever this row carries. `bound` picks the word: the
   * two are complements and never appear together. Null leaves the item out
   * entirely — a lane rendered read-only offers no binding at all, which is an
   * absence rather than a refusal.
   */
  binding: (DashRowMenuVerb & { bound: boolean }) | null;
  /**
   * Discard, on the rows the reach rule allows. Null renders no item: a shade
   * with no business discarding this dash will never have one, and a
   * permanently dead row is not information.
   */
  discard: DashRowMenuVerb | null;
}

export interface DashRowMenuResult {
  /** Render beside the row; holds the menu portal. Null with no chain. */
  menu: React.ReactNode;
  /** Open the menu under `anchor` — the opener button. */
  openMenu: (anchor: HTMLElement | null) => void;
}

/** The item's label, carrying its own refusal when it has one. */
export function dashRowMenuLabel(verb: string, disabledReason: string | null): string {
  return disabledReason === null ? verb : `${verb} — ${disabledReason}`;
}

export function useDashRowMenu({
  binding,
  discard,
}: DashRowMenuOptions): DashRowMenuResult {
  const manager = useResponderChain();
  const [openAt, setOpenAt] = React.useState<{ x: number; y: number } | null>(null);
  const closeMenu = React.useCallback(() => setOpenAt(null), []);

  const bind = binding?.perform;
  const discardPerform = discard?.perform;
  const responderId = React.useId();
  const { responderRef, ResponderScope } = useOptionalResponder({
    id: responderId,
    actions: {
      // Bind and Unbind are one verb wearing two words, so both names reach
      // the same callback — the row already decided which word it carries.
      [TUG_ACTIONS.BIND_DASH]: () => bind?.(),
      [TUG_ACTIONS.UNBIND_DASH]: () => bind?.(),
      [TUG_ACTIONS.REQUEST_DISCARD_DASH]: () => discardPerform?.(),
    },
  });

  const openMenu = React.useCallback(
    (anchor: HTMLElement | null): void => {
      if (manager === null || anchor === null) return;
      // Under the opener's bottom-left corner, in viewport coordinates — the
      // menu flips itself against the viewport edges from there.
      const rect = anchor.getBoundingClientRect();
      setOpenAt({ x: rect.left, y: rect.bottom });
    },
    [manager],
  );

  const items = React.useMemo<TugEditorContextMenuEntry[]>(() => {
    const entries: TugEditorContextMenuEntry[] = [];
    if (binding !== null) {
      entries.push({
        action: binding.bound ? TUG_ACTIONS.UNBIND_DASH : TUG_ACTIONS.BIND_DASH,
        label: dashRowMenuLabel(
          binding.bound ? "Unbind" : "Bind",
          binding.disabledReason,
        ),
        disabled: binding.disabledReason !== null,
      });
    }
    if (discard !== null) {
      entries.push({
        action: TUG_ACTIONS.REQUEST_DISCARD_DASH,
        label: dashRowMenuLabel("Discard", discard.disabledReason),
        disabled: discard.disabledReason !== null,
      });
    }
    return entries;
  }, [binding, discard]);

  // Inside this hook's own scope, so the menu's targeted dispatch lands on the
  // responder above rather than on whatever surrounds the row. The responder's
  // element is the menu's own host: the row's element belongs to the row.
  const menu =
    manager !== null && items.length > 0 ? (
      <ResponderScope>
        <span ref={responderRef} data-slot="session-changes-dash-row-menu">
          <TugEditorContextMenu
            open={openAt !== null}
            x={openAt?.x ?? 0}
            y={openAt?.y ?? 0}
            items={items}
            onClose={closeMenu}
          />
        </span>
      </ResponderScope>
    ) : null;

  return { menu, openMenu };
}
