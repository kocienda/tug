/**
 * useSessionIdentityMenu — the right-click menu a session row offers, for the
 * whole row.
 *
 * A session row shows four facts and, until this hook, offered copies of them
 * through three unrelated claimants over two dead zones. The title span claimed
 * a single-item Copy that wrote the atom; the title's `TugLabel` claimed the
 * blank space beside it with the generic label menu, which copied the name; the
 * pulse stage claimed the activity line with a Copy of the beat. The
 * description line and the row's own background claimed nothing at all and fell
 * through to the app's "No Actions" fallback — and the description is the run a
 * reader is most likely to want out of the row, because it is the only one they
 * cannot read anywhere else.
 *
 * So: ONE menu, claimed by the row, listing every copy the row can offer.
 * Which pixel the press landed on no longer decides which menu opens, only
 * whether the two run-specific items at the bottom have anything to give.
 *
 *   Show Session / Resume Session   go to the session, however it must be reached
 *   ─────
 *   Copy as Atom                the citation + the atom sidecar — pastes as the chip
 *   Copy as Citation            the flat string, for outside Tug
 *   Copy Session ID             the full UUID, which nothing on screen shows
 *   ─────
 *   Copy Description            the whole synopsis, past the row's elision
 *   Copy Activity Line          the newest beat, when the session is running one
 *
 * **The first item is one item, not two.** A reader right-clicking a session
 * wants to GET to it; whether that costs a raise or a resume is the app's
 * problem, not theirs. So the item says which of the two it will be and does
 * it — `Show Session` when a card already holds the session, `Resume Session`
 * when none does. It is absent only where it could say nothing useful: on the
 * session's own card (the masthead), where the card to raise is the one the
 * pointer is in, and on a citation the ledger cannot resolve, which names no
 * session to go to. A session another process holds is shown DISABLED rather
 * than dropped — it is a real session, and it is unresumable for a reason a
 * reader can act on.
 *
 * The two lower items are DISABLED rather than absent when they have nothing:
 * a menu whose height changes with the session's state is a menu whose items
 * move under the pointer between one right-click and the next. A surface that
 * carries no such fact AT ALL — a citation chip has no activity feed behind it
 * — omits the item instead, which is a different thing: what is constant per
 * surface is the menu, and a permanently dead row is not information.
 *
 * `TugEditorContextMenu` rather than the Radix-backed `TugContextMenu`, for the
 * reason `useCopyableText` uses it: its items write to the clipboard inside the
 * mousedown, and it moves no focus — a row is chrome, and a copy from it must
 * not take the key view away from the card the reader is working in.
 *
 * Laws: [L11] controls emit actions, responders handle them — every item is a
 *       typed action dispatched to this hook's own responder;
 *       [L06] no appearance passes through React state.
 *
 * @module components/tugways/session-identity-menu
 */

import React from "react";

import { getRegistryHandler } from "@/action-dispatch";
import { dispatchCommand } from "@/command-dispatch";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";

import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import {
  TugEditorContextMenu,
  type TugEditorContextMenuEntry,
} from "@/components/tugways/tug-editor-context-menu";
import { useOptionalResponder } from "@/components/tugways/use-responder";
import { entityMenuItems } from "@/components/tugways/entity-menu-items";
import { annotationEntryFor } from "@/lib/annotator/registry";
import { useWholeEntityPress } from "@/lib/whole-entity-press";
import { CardIdContext } from "@/lib/card-id-context";
import { useCardIdForSession } from "@/lib/card-session-binding-store";
import { writeSessionAtomToClipboard } from "@/lib/session-atom";
import { useCitedSession } from "@/lib/session-citation-store";
import { useSessionLedgerRow } from "@/lib/session-ledger-store";
import { sessionCitation, type SessionIdentity } from "@/lib/session-identity";

/** What the menu is offered for, and what each item has to write. */
export interface SessionIdentityMenuOptions {
  /** The session. Every identity item is derived from this record. */
  identity: SessionIdentity;
  /**
   * The description IN FULL — what the row would show under no width budget.
   * The item is disabled when there is none, which is a session whose
   * description is still the date it was created; omit the option entirely on
   * a surface that carries no description at all, and the item is absent.
   */
  description?: string | null;
  /**
   * The newest live beat, or null. Only a beat: the rest sentence and the
   * compaction pin are text the row composed rather than news the session
   * sent, and neither is something a paste wants. Omitted on a surface with no
   * activity feed behind it (a citation chip), where the item is absent rather
   * than permanently dead.
   */
  activity?: string | null;
  /**
   * The card this menu is MOUNTED IN, when the surface knows it and the
   * context cannot say.
   *
   * The go-to item asks whether the session's card is the card the pointer is
   * already in, and {@link CardIdContext} answers that everywhere inside a card
   * host. A card's own chrome is the exception: the masthead renders in the
   * pane's title bar, which is above the host and therefore outside the
   * context, so without this it would offer to raise the card it is the title
   * of.
   */
  hostCardId?: string | null;
  /**
   * Off, the hook is inert — no responder is registered, the handler does
   * nothing, and `contextMenu` is null, so the press falls through to whatever
   * claimed it before. A knob rather than a second component because hooks
   * cannot be called conditionally, and because the surfaces that do not want
   * the menu (the picker's cells) render this component anyway.
   * @default true
   */
  enabled?: boolean;
}

/** Wiring for the row: attach both, render the menu beside it. */
export interface SessionIdentityMenuResult {
  /**
   * Attach to the row's `ref` — the responder's element, and the host the
   * whole-entity press is bound to.
   */
  ref: (el: HTMLElement | null) => void;
  /** Attach to the row's `onContextMenu`. */
  onContextMenu: (e: React.MouseEvent) => void;
  /** Render alongside the row; holds the menu portal. Null when disabled. */
  contextMenu: React.ReactNode;
}

/** Plain text to the clipboard, when there is any. */
function writeText(text: string): void {
  if (text.length > 0) void navigator.clipboard.writeText(text);
}

/**
 * The entity a press on the claim is about: the session identity. On a chip
 * the claim IS the identity, so it names itself; on a row, which claims the
 * whole row, it is the identity runs the row leads with — the session's
 * visible name, which is what every item acts on.
 */
function sessionIdentityIn(host: HTMLElement): HTMLElement | null {
  if (host.classList.contains("tug-session-identity")) return host;
  return host.querySelector<HTMLElement>(".tug-session-identity");
}

export function useSessionIdentityMenu({
  identity,
  description,
  activity,
  hostCardId,
  enabled = true,
}: SessionIdentityMenuOptions): SessionIdentityMenuResult {
  const manager = useResponderChain();
  const [menuState, setMenuState] = React.useState<{ x: number; y: number } | null>(
    null,
  );
  const closeMenu = React.useCallback(() => setMenuState(null), []);

  const citation = sessionCitation(identity, { project: true });
  const descriptionText = description?.trim() ?? "";
  const activityText = activity?.trim() ?? "";

  // Where the session is, and whether it is here. The host card is the one
  // this menu is mounted in; it and the session's card being the same is the
  // masthead case, where a Show would raise the pointer's own card.
  const contextCardId = React.useContext(CardIdContext);
  const hostCard = hostCardId ?? contextCardId;
  const openCardId = useCardIdForSession(identity.id);
  const isOwnCard = openCardId !== null && openCardId === hostCard;
  // The ledger's word about a session no card holds — its project dir, which a
  // resume needs and no identity record carries, and its state, which says
  // whether another process is holding it. Asked only when it is needed: a
  // session with a card open answers both questions already, and the empty id
  // is how {@link useCitedSession} is told not to ask ([L02] — the ask lives in
  // that hook's effect, never in this render).
  const wantsLedger = enabled && identity.resolved && openCardId === null;
  const cited = useCitedSession(wantsLedger ? identity.id : "");
  // The listing's row for the same session, as its own subscription — the
  // resolver's answer is a SNAPSHOT taken when the chip first asked, and a
  // session that was live then is exactly the one that stops being live while
  // its menu is being read. Liveness therefore comes from the row, which every
  // `session_updated` push patches, and the resolver answers only for what it
  // cannot go stale about: where the session's project is.
  const row = useSessionLedgerRow(identity.id, "");
  const projectDir =
    row?.project_dir ?? (cited.status === "found" ? cited.projectDir : "");
  const state = row?.state ?? (cited.status === "found" ? cited.state : null);
  // Held by another process — the same rule the `/resume` overlay's rows
  // enforce, since a second claim on a live session is not a resume.
  const heldElsewhere = state === "live";

  const showSession = React.useCallback((): void => {
    if (openCardId === null) return;
    // The registry's own raise — the same funnel a Cards card row's click and a
    // chip's click go through, so three gestures cannot drift into three
    // raises ([L30]).
    dispatchCommand("focus-session-card", { cardId: openCardId });
  }, [openCardId]);

  const resumeSession = React.useCallback((): void => {
    if (projectDir.length === 0 || heldElsewhere) return;
    const sessionId = cited.status === "found" ? cited.sessionId : identity.id;
    // The registry handler directly, not `dispatchCommand`: this verb is a
    // menu-only action over a sampled target and so has no command-registry
    // row for a command id to name ([ACTIONS_OUTSIDE_THE_TABLE]). The deck
    // work lives in `action-dispatch.ts`, which is the only place that holds
    // the DeckManager and the connection.
    //
    // The host card goes along as the origin the resumed card is placed
    // beside — the same "left if it can, right if it must" rule a file link
    // opens under. It is the card being pointed at, which a right-click need
    // not have made first responder.
    getRegistryHandler(TUG_ACTIONS.RESUME_SESSION)?.({
      sessionId,
      projectDir,
      originCardId: hostCard ?? undefined,
    });
  }, [cited, identity.id, projectDir, heldElsewhere, hostCard]);

  // The atom, with the flat citation as its fallback. `writeSessionAtomToClipboard`
  // answers false in a browser-mode run, where the native pasteboard bridge that
  // carries the private sidecar is not installed — there the citation IS the
  // whole of what can be written.
  // An unresolvable citation has no session to mint an atom for, so it writes
  // what it can say honestly: its own text.
  const copyAtom = React.useCallback((): void => {
    if (identity.resolved && writeSessionAtomToClipboard(identity)) return;
    writeText(citation);
  }, [identity, citation]);

  const responderId = React.useId();
  const { responderRef, ResponderScope } = useOptionalResponder({
    id: responderId,
    actions: {
      // No bare COPY. ⌘C is the app's Copy, and what it copies is what the
      // reader SELECTED — a row that redefines it because the pointer is
      // resting on one takes a core chord away from the surface underneath
      // and gives back something nobody asked for. The atom stays available
      // where it was always unambiguous: the row's own menu item.
      [TUG_ACTIONS.SHOW_SESSION]: showSession,
      [TUG_ACTIONS.RESUME_SESSION]: resumeSession,
      [TUG_ACTIONS.COPY_SESSION_ATOM]: copyAtom,
      [TUG_ACTIONS.COPY_SESSION_CITATION]: () => writeText(citation),
      [TUG_ACTIONS.COPY_SESSION_ID]: () => writeText(identity.id),
      [TUG_ACTIONS.COPY_SESSION_DESCRIPTION]: () => writeText(descriptionText),
      [TUG_ACTIONS.COPY_SESSION_ACTIVITY]: () => writeText(activityText),
    },
  });

  // The press that opens this menu selects the identity whole and paints it —
  // the one rule every menu about an entity is under
  // (`lib/whole-entity-press`). Bound on the same element the responder is,
  // and named only where the menu will actually open: while enabled, and
  // under a responder chain. A press that settled the selection under no menu
  // would be the rule's own inverse — a highlight with nothing about it.
  const { attach: attachPress } = useWholeEntityPress((event) =>
    enabled && manager !== null && event.currentTarget instanceof HTMLElement
      ? sessionIdentityIn(event.currentTarget)
      : null,
  );
  const ref = React.useCallback(
    (el: HTMLElement | null): void => {
      responderRef(enabled ? el : null);
      attachPress(enabled ? el : null);
    },
    [responderRef, attachPress, enabled],
  );

  const onContextMenu = React.useCallback(
    (e: React.MouseEvent): void => {
      if (!enabled || manager === null) return;
      e.preventDefault();
      // Claimed, not merely handled — the same rule `useCopyableText` follows.
      // The runs inside this row are copyables of their own and every one of
      // them is on this row's path, so a press that only suppressed the native
      // menu would open a stack of them over one point.
      e.stopPropagation();
      setMenuState({ x: e.clientX, y: e.clientY });
    },
    [enabled, manager],
  );

  const items = React.useMemo<TugEditorContextMenuEntry[]>(() => {
    // The list and its order are the registry's, for every surface a session
    // appears on; this row's contribution is the live facts an id cannot
    // carry — which card holds it, whether another process does, and which
    // of the two runs this surface has behind it at all.
    //
    // A citation the ledger cannot resolve names no session to go to, so it
    // is given the facts of a session that is already here: no go-to row.
    const entries =
      annotationEntryFor("session")?.menuEntries(
        { kind: "session", target: identity.id },
        {
          kind: "session",
          openCardId,
          isOwnCard: isOwnCard || !identity.resolved,
          heldElsewhere,
          projectDir,
          ...(description !== undefined ? { description } : {}),
          ...(activity !== undefined ? { activity } : {}),
        },
      ) ?? [];
    // No prompt is in reach from a row's menu, and an unresolved citation has
    // no session to mint an atom for.
    return entityMenuItems(entries, (e) =>
      e.action === TUG_ACTIONS.INSERT_INTO_PROMPT ||
      (e.action === TUG_ACTIONS.COPY_SESSION_ATOM && !identity.resolved),
    );
  }, [
    identity.id,
    identity.resolved,
    isOwnCard,
    openCardId,
    heldElsewhere,
    projectDir,
    description,
    activity,
  ]);

  // Inside this hook's own ResponderScope, so the menu's targeted dispatch
  // lands on the responder above rather than on whatever surrounds the row.
  const contextMenu =
    enabled && manager !== null ? (
      <ResponderScope>
        <TugEditorContextMenu
          open={menuState !== null}
          x={menuState?.x ?? 0}
          y={menuState?.y ?? 0}
          items={items}
          onClose={closeMenu}
        />
      </ResponderScope>
    ) : null;

  return { ref, onContextMenu, contextMenu };
}

