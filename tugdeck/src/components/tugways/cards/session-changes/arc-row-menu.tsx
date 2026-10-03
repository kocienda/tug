/**
 * `useArcRowMenu` — an Arcs card row's housekeeping verbs, as a right-click
 * menu.
 *
 * Bind/Unbind, Discard, and Replay. Every one of them stands on the row's verb
 * row, on every arc surface; this menu is a second door to the same verbs on
 * the Arcs card, never the only one — a shortcut over buttons already visible.
 * The Changes lane, which once hid them behind a `⋯`, has no menu at all.
 *
 * The join is not among them: on a ready arc it leads the verb row as the
 * arc's next step, not a housekeeping verb. None of these is a chord, because
 * none names a target a chord could reach ("the arc this row is").
 *
 * Replay joined them last, and it is the one verb here the machine usually
 * performs by itself: the base-motion engine replays an arc whenever the base
 * moves and its gates allow. The item is for the arcs those gates skip —
 * autoreplay turned off, or a replay that already stopped conflicted — which
 * have divergence facts on the row and, without this, no gesture anywhere that
 * acts on them.
 *
 * **A disabled item still says why.** A disabled item takes no pointer events,
 * so a `title` on one can never be read, and a tooltip on one never fires
 * ([L31] — a refusal that cannot be read is a silent one). The reason
 * therefore rides the item's own label: `Unbind — a turn is running`. The item
 * stays present rather than vanishing, so the menu's height does not change
 * with the arc's state and the reader is told what is blocked rather than
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
 * @module components/tugways/cards/session-changes/arc-row-menu
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
export interface ArcRowMenuVerb {
  /** Why the verb is unavailable right now, or null when it is available. */
  disabledReason: string | null;
  /**
   * The verb's word, when it is not the item's default. Replay names its
   * destination — `Replay onto main` — because which base the rounds land on is
   * the whole question the reader is answering.
   */
  label?: string;
  /** Perform it. Called inside the item's activation. */
  perform: () => void;
}

export interface ArcRowMenuOptions {
  /**
   * Bind or Unbind, whichever this row carries. `bound` picks the word: the
   * two are complements and never appear together. Null leaves the item out
   * entirely — a lane rendered read-only offers no binding at all, which is an
   * absence rather than a refusal.
   */
  binding: (ArcRowMenuVerb & { bound: boolean }) | null;
  /**
   * Discard, on the rows the reach rule allows. Null renders no item: a shade
   * with no business discarding this arc will never have one, and a
   * permanently dead row is not information.
   */
  discard: ArcRowMenuVerb | null;
  /**
   * Replay the arc's rounds onto its base's current tip. Present on both
   * arc-row surfaces on the same terms — see {@link replayDisabledReason} for
   * what those terms are and why boundness is not among them.
   */
  replay: ArcRowMenuVerb | null;
}

export interface ArcRowMenuResult {
  /** Render beside the row; holds the menu portal. Null with no chain. */
  menu: React.ReactNode;
  /**
   * Open the menu at a viewport point — the right-click path. The verbs are
   * the row's own, reached by the gesture every other list row in the app
   * answers.
   */
  openMenuAt: (x: number, y: number) => void;
}

/** The item's label, carrying its own refusal when it has one. */
export function arcRowMenuLabel(verb: string, disabledReason: string | null): string {
  return disabledReason === null ? verb : `${verb} — ${disabledReason}`;
}

/**
 * Why Replay is unavailable for this arc, or null when it is available.
 *
 * Available whenever the arc is **diverged** — the base has moved past it, or
 * a previous replay stopped conflicted. Two no-ops the row's own facts prove
 * are disabled with their reason rather than hidden ([L31]): an arc already
 * current with its base has nothing to replay, and an arc with a dirty worktree
 * would have its replay declined server-side, since the move is a
 * `git reset --keep` that refuses over uncommitted work.
 *
 * **Boundness is not consulted.** `decide_for_arc` in the base-motion engine
 * gates the automatic replay on the autoreplay flags, an in-flight replay, the
 * join journal, and worktree dirt — never on whether a session holds the arc.
 * So "unbound" never meant "untended", and a bound diverged arc whose
 * repository has autoreplay off is precisely the population with no other
 * recourse. Neither autoreplay flag is on the wire and neither is put there:
 * a client predicting whether the engine is about to act would be
 * re-implementing that gate behind glass.
 */
export function replayDisabledReason(entry: {
  base: string;
  base_ahead?: number;
  worktree_dirty: boolean;
  replay_conflict_paths?: string[];
}): string | null {
  const diverged =
    (entry.base_ahead ?? 0) > 0 || (entry.replay_conflict_paths ?? []).length > 0;
  if (!diverged) return `already current with ${entry.base}`;
  if (entry.worktree_dirty) return "its worktree has uncommitted changes";
  return null;
}

export function useArcRowMenu({
  binding,
  discard,
  replay,
}: ArcRowMenuOptions): ArcRowMenuResult {
  const manager = useResponderChain();
  const [openAt, setOpenAt] = React.useState<{ x: number; y: number } | null>(null);
  const closeMenu = React.useCallback(() => setOpenAt(null), []);

  const bind = binding?.perform;
  const discardPerform = discard?.perform;
  const replayPerform = replay?.perform;
  const responderId = React.useId();
  const { responderRef, ResponderScope } = useOptionalResponder({
    id: responderId,
    actions: {
      // Bind and Unbind are one verb wearing two words, so both names reach
      // the same callback — the row already decided which word it carries.
      [TUG_ACTIONS.BIND_ARC]: () => bind?.(),
      [TUG_ACTIONS.UNBIND_ARC]: () => bind?.(),
      [TUG_ACTIONS.REQUEST_DISCARD_ARC]: () => discardPerform?.(),
      [TUG_ACTIONS.REQUEST_REPLAY_ARC]: () => replayPerform?.(),
    },
  });

  const openMenuAt = React.useCallback(
    (x: number, y: number): void => {
      if (manager === null) return;
      setOpenAt({ x, y });
    },
    [manager],
  );

  const items = React.useMemo<TugEditorContextMenuEntry[]>(() => {
    const entries: TugEditorContextMenuEntry[] = [];
    if (binding !== null) {
      entries.push({
        action: binding.bound ? TUG_ACTIONS.UNBIND_ARC : TUG_ACTIONS.BIND_ARC,
        label: arcRowMenuLabel(
          binding.bound ? "Unbind" : "Bind",
          binding.disabledReason,
        ),
        disabled: binding.disabledReason !== null,
      });
    }
    if (discard !== null) {
      entries.push({
        action: TUG_ACTIONS.REQUEST_DISCARD_ARC,
        label: arcRowMenuLabel("Discard", discard.disabledReason),
        disabled: discard.disabledReason !== null,
      });
    }
    if (replay !== null) {
      entries.push({
        action: TUG_ACTIONS.REQUEST_REPLAY_ARC,
        label: arcRowMenuLabel(replay.label ?? "Replay", replay.disabledReason),
        disabled: replay.disabledReason !== null,
      });
    }
    return entries;
  }, [binding, discard, replay]);

  // Inside this hook's own scope, so the menu's targeted dispatch lands on the
  // responder above rather than on whatever surrounds the row. The responder's
  // element is the menu's own host: the row's element belongs to the row.
  const menu =
    manager !== null && items.length > 0 ? (
      <ResponderScope>
        <span ref={responderRef} data-slot="session-changes-arc-row-menu">
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

  return { menu, openMenuAt };
}
