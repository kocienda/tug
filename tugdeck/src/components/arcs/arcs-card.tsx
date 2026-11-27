/**
 * arcs-card.tsx — the **Cycles & Arcs** card: every cycle and every arc in
 * every open project, in every state, always on.
 *
 * Cycles come first. A cycle of two or more entries is a pin — its fold cue,
 * its name, how much has landed, and its map — over one row per asset; a
 * cycle of one entry is that entry's row. An arc a cycle's entry names is
 * drawn there and nowhere else. The arcs no cycle names follow, drawn as they
 * always were, and the rest of this comment is about them.
 *
 * The card is a fixed address. It used to show only unbound arcs and to
 * vanish entirely at zero — and the coming and going was the wart: a surface
 * with no fixed place cannot be glanced at. Now the card is always there, every
 * arc is a row, and the empty state is one quiet line that costs ~24px and
 * buys the card its address.
 *
 * Each arc is a two-line block in one grammar, the same grammar the Changes
 * shade's collapsed arc row wears:
 *
 *   [^arc-atom] ───────────────────────── [worker atom]
 *     track · glyph · fraction · note · divergence
 *
 * Every row is one `ArcLifecycleBlock`, the grammar every arc surface wears.
 * Its EYEBROW holds the identities and nothing else: the arc atom at the
 * left, the hairline, the "who" at the right — each bound worker as a mini
 * atom (no callsign, no arc run: the row already names both). The arc pill
 * wears no review tint here: that yellow is the WAITING color, and an arc is
 * not waiting for anyone. Beneath it, the lifecycle line carries everything
 * the arc is DOING, phase glyph included, and at ITS trailing edge stand the
 * row's controls — the transport, then the fold cue — in the block's
 * `lineTrailing` slot. They rode the eyebrow's end for a while, and at the
 * sidebar's width the two names paid for them in characters: every row
 * elided both pills. The eyebrow is the names' now, and the arc pill has
 * priority over the worker's when the two still cannot fit ([D200]).
 *
 * **And the row FOLDS to the arc's ledger.** An arc whose entry carries steps
 * wears the tool-call header's own `BlockFoldCue` at the line's end, and
 * opens over the plan's step rows — `ArcStepItems`, the very component the
 * `ARC` placard mounts, so the row and the placard cannot disagree about one
 * arc's steps ([D176]). The bit is held HERE, in `ArcsBody`, keyed by the arc's
 * owner key: a bit inside a cell would be lost the moment virtualization
 * recycled it or a changeset beat replaced the row, which on a card that
 * re-projects on every beat is a row folding itself shut while you read it.
 * The fold opens over the ledger AND over what is in the arc's way — the
 * warning and error sentences the line used to paint, which took their width
 * from the phase word beside them. The line carries a tone mark in their slot
 * now, and the sentences get a row each below the steps. A row with neither
 * a ledger nor a message draws the cue disabled — present, never absent, so
 * every row's chevron sits at the same edge — but a message alone is enough
 * to make a row expandable, because a mark whose text nobody can reach is
 * half a reading.
 *
 * An arc with no branch yet — a brief being written, a plan being devised or
 * reviewed — is the SAME block, over the arc's own shape, with its track
 * model from `documentArcTrackModel` so a plan already under way reads
 * `implement` with the ledger's own counts. It carries neither the menu, which
 * is a live arc's, nor the fold, which reads a ledger a waiting document's
 * entry does not carry — only the transport, which is how paperwork becomes an
 * arc.
 *
 * `ChangesetAllStore` is the account-global snapshot, so this card is a
 * projection of it and nothing more. Rows key on the arc's **owner key**, which makes two
 * incarnations of a reused name distinct for free.
 *
 * The verbs stand under the block, in the one {@link ArcVerbRow} every arc
 * surface wears ([B01]): the arc's next step, then Changes — the row
 * activation's own destination, drawn as a button — then Bind or Unbind,
 * Replay and Discard. Bind mates an unbound arc to the card's followed card, or
 * carries its refusal on the hover ([L31]); Unbind releases the bound card's
 * hold, so the binding verb reads the same here as on every other surface
 * ([B09]); Discard destroys the arc behind a confirm anchored to the row
 * element; Replay moves the arc's rounds onto a base that has advanced, on the
 * same terms for every row. The row's right-click stays as a second door onto
 * the same housekeeping verbs ([B08]), composed from the Changes shade's own
 * {@link useArcRowMenu} — never the only door.
 *
 * Both destructive verbs destroy the surface they are pressed on — the success
 * path, not an edge case — so Bind reports nothing locally: a refusal arrives on
 * the card-level bind-error surface, which outlives the row, and a replay's
 * outcome on its sibling.
 *
 * Rows are totally ordered: nearest-to-done first, then freshest first, then
 * by name. Stage leads because a `draft-ready` arc is one gesture from
 * landing; freshness is the tiebreak a person actually wants; name is the
 * final tiebreak rather than snapshot order, which is git-enumeration order.
 *
 * Beneath the arcs the card lists the **waiting paperwork**: plan
 * documents sitting in each project's configured docs directory, which the
 * aggregate now carries. The back half of the arc was already machine-visible —
 * an arc reads `implementing (i/N)`, the join arms itself, the shade summons —
 * while the front half was a file only `ls` could find. A plan row is the same
 * two-line block one tone quieter, and that is the whole of it.
 *
 * **A plan row wears the same verb row.** Its next step is the transport — a
 * server verb, never a composed `/tugplug:…` line — and a Start that has
 * nowhere to land wears its reason and speaks it ([D178], [L31]). Its Discard is
 * the documents' delete, the same act on an arc that has nothing else to lose
 * ([B07]), and a bound plan row offers Unbind as a live one does.
 *
 * Live work outranks waiting paperwork, so arcs come first and plans follow;
 * plans are listed for every open project, exactly as arcs are.
 *
 * Laws: [L02] the aggregate enters React through `useSyncExternalStore`;
 * [L03] the scroll listener that releases a pin registers in a layout effect;
 * [L06] tones are CSS on DOM attributes, never React state, and a pin's
 * release and the room under the list are written to the DOM; [L19] rows compose
 * `TugListView` / `TugListRow` rather than hand-rolling list focus; [L20] the
 * blocks compose `ArcLifecycleBlock`, which owns the atom, the bound worker as
 * a mini atom when there is one, and the line.
 *
 * @module components/arcs/arcs-card
 */

import {
  RAIL_CARD_CLASS,
  RAIL_CARD_CONTENT_CLASS,
} from "@/components/tugways/cards/rail-card-shell";
import { TugEmptyLine } from "@/components/tugways/tug-empty-line";
import "./arcs-card.css";

import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import { RAIL_LIST_PRESENTATION } from "@/components/tugways/rail-list-presentation";
import {
  ArcLifecycleBlock,
  ArcWorkerAtom,
} from "@/components/tugways/arc-lifecycle-block";
import { CycleEntryMark } from "@/components/tugways/cycle-entry-mark";
import { CycleMap } from "@/components/tugways/cycle-map";
import { CycleOnlyBar } from "@/components/tugways/cycle-only-bar";
import { CycleSeal } from "@/components/tugways/cycle-seal";
import { CycleWaits } from "@/components/tugways/cycle-waits";
import { TugArcAtom } from "@/components/tugways/tug-arc-atom";
import { TugAtomRef } from "@/components/tugways/tug-atom-ref";
import { TugLabel } from "@/components/tugways/tug-label";
import { openCitedSession } from "@/lib/session-open";
import { ArcStepItems } from "@/components/tugways/arc-step-list";
import {
  arcTrackModelFromEntry,
  type ArcTrackModel,
} from "@/components/tugways/tug-arc-track";
import { arcBranchFacts } from "@/lib/arc-meta-facts";
import { parseArcRecord } from "@/lib/arc-record-text";
import { documentArcTrackModel } from "@/lib/document-arc-entry";
import { ArcJoinRegisterView } from "@/components/tugways/arc-join-register";
import {
  ArcVerbRow,
  type ArcSurfaceVerbKind,
} from "@/components/tugways/arc-verb-row";
import {
  arcVerbs,
  discardConfirm,
  NO_JOIN_GATE,
  type ArcVerbSet,
} from "@/lib/arc-verbs";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { arcJoinRegister, staleAuditFacts } from "@/lib/arc-join-register";
import { useChangesetJoinLand } from "@/lib/changeset-join-store";
import { toolCallPhaseVisual } from "@/lib/code-session-store/tool-call-phase-visual";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugListView } from "@/components/tugways/tug-list-view";
import type {
  TugListViewCellProps,
  TugListViewCellRenderer,
  TugListViewDataSource,
  TugListViewDelegate,
} from "@/components/tugways/tug-list-view";
import { TugConfirmPopover } from "@/components/tugways/tug-confirm-popover";
import {
  FollowedCardContext,
  useFollowedCard,
  useTrackFollowedCard,
} from "@/components/tugways/followed-card";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import { dispatchCommand } from "@/command-dispatch";
import {
  cardIdForSession,
  cardSessionBindingStore,
  useCardIdForSession,
} from "@/lib/card-session-binding-store";
import { getConnection } from "@/lib/connection-singleton";
import { useChangesetAll } from "@/lib/changeset-all-store";
import type { FollowedCardFacts } from "@/lib/arc-transport";
import { useCardTransportFacts } from "@/components/tugways/use-card-transport-facts";
import { pressArcJoin, sessionEntryKey } from "@/lib/arc-join-press";
import {
  useChangesetDeleteDocuments,
  useChangesetDiscard,
  useChangesetJoin,
  useChangesetReplay,
} from "@/lib/changeset-verb-store";
import {
  replayDisabledReason,
  useArcRowMenu,
} from "@/components/tugways/cards/session-changes/arc-row-menu";
import type { ArcRunState } from "@/lib/changeset-types";
import {
  cycleChosen,
  documentArcIsBegun,
  foldCycle,
  listArcsCard,
  NO_CYCLE_VIEW,
  pressCycleMap,
  pressCycleRow,
  projectArcsCard,
  type ArcRow,
  type ArcsCardItem,
  type CycleEntryRow,
  type CycleSection,
  type CycleSketchRow,
  type CycleViewState,
  type DocumentArcRow,
} from "./arcs-projection";

/** The card's focus group — every stop it offers lives here. */
const ARCS_FOCUS_GROUP = "arcs-card";

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

// The rows themselves are projected in `arcs-projection`, which holds no
// React; they are re-exported so the card's tests keep their address.
export {
  arcRowsFromSnapshot,
  compareArcRows,
  compareDocumentArcRows,
  documentArcIsBegun,
  documentArcRowsFromSnapshot,
  type ArcRow,
  type DocumentArcRow,
} from "./arcs-projection";

/** The stage table the order reads ([P02], Table T01) — re-exported so the
 *  card's table test keeps its address. The table lives in `lib/arc-order`. */
export { ARC_STAGE_RANK } from "@/lib/arc-order";

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/** What a cycle's pin may ask of the body, which holds every cycle's view. */
interface CycleActions {
  /** Flip one cycle's fold. */
  fold: (section: CycleSection) => void;
  /** A press on the map: an asset's key, or null for the map's ground. */
  pressMap: (section: CycleSection, key: string | null, shift: boolean) => void;
}

/**
 * A flat, immutable list over one projection pass and one view of it: each
 * cycle's pin and the assets showing under it, each cycle of one, then the
 * arcs no cycle names, then the waiting paperwork. A new projection or a new
 * view makes a new source; there is no mutation to subscribe to.
 *
 * One list rather than one per cycle, because the arrows walk rows inside a
 * list: every row the card draws is a stop on one walk, in card order.
 *
 * The view rides here because it is the host's: which arcs show their steps,
 * which cycles are folded and which assets are selected are `ArcsBody`'s, and
 * this source is how a cell reaches them. A bit inside a cell would be lost
 * the moment a changeset beat replaced the row.
 */
class CockpitRowsDataSource implements TugListViewDataSource {
  constructor(
    readonly items: readonly ArcsCardItem[],
    /** The owner keys of the loose arcs whose steps are showing. */
    readonly expanded: ReadonlySet<string>,
    /** Flip one arc's bit, by the same owner key the rows are identified by. */
    readonly toggle: (ownerId: string) => void,
    readonly cycles: CycleActions,
  ) {}
  numberOfItems(): number {
    return this.items.length;
  }
  idForIndex(index: number): string {
    return this.items[index]!.id;
  }
  kindForIndex(index: number): string {
    return this.items[index]!.kind;
  }
  subscribe(): () => void {
    return () => {};
  }
  getVersion(): unknown {
    // The source itself: one instance per projection pass, so identity is
    // exactly the version the list needs.
    return this;
  }
}

/**
 * What the wheel is waiting for on this arc, or `null`.
 *
 * Pure, and shared by both row kinds on purpose: a branch row and a
 * paperwork row read the same field off the same record, and a helper that
 * served one of them would be the second face this line exists to avoid. A
 * planned arc has no branch for the whole of devise and review, so a wait
 * read there lands on the paperwork row and nowhere else.
 *
 * An empty sentence reads as no wait: the server sends the field only when it
 * has something to say, and a blank line of row height says nothing.
 */
export function arcRowWaiting(arc: ArcRunState | null | undefined): string | null {
  const waiting = arc?.waiting;
  return waiting !== undefined && waiting.trim() !== "" ? waiting : null;
}

// ---------------------------------------------------------------------------
// The verbs
// ---------------------------------------------------------------------------

/** Where a Bind press would send this arc, or why it cannot. Exactly one of
 *  the two is non-null. */
export interface BindTarget {
  tugSessionId: string | null;
  reason: string | null;
}

/**
 * Resolve Bind's target from the Arcs card's followed card (Table T01) — pure, so
 * its whole truth table is a unit test rather than a DOM one.
 *
 * The ladder stops at the followed card deliberately. Reaching past it to some
 * other open card would make Bind succeed more often at the cost of making its
 * destination invisible: a press could bind an arc into a card the reader was
 * not looking at. Every refusal names what is missing, because a control that
 * declines without saying why is the failure this section already had.
 */
export function resolveBindTarget(input: {
  followedCardId: string | null;
  binding: { tugSessionId: string; projectDir: string } | undefined;
  projectDir: string;
  projectLabel: string;
}): BindTarget {
  if (input.followedCardId === null) {
    return { tugSessionId: null, reason: "Focus a session card to bind this arc" };
  }
  if (input.binding === undefined) {
    return { tugSessionId: null, reason: "The focused card has no session" };
  }
  // An arc can only be bound by a session in its own project — the bind names a
  // project dir, and the server resolves the arc within it.
  if (input.binding.projectDir !== input.projectDir) {
    return {
      tugSessionId: null,
      reason: `This arc belongs to ${input.projectLabel}`,
    };
  }
  return { tugSessionId: input.binding.tugSessionId, reason: null };
}

/**
 * The open card working this arc, or null — the destination a row activation
 * routes to.
 *
 * `bound_session` is the one live session mated to the arc — an arc is bound
 * to at most one live card — and the card bound to it is the card whose
 * Changes shade shows this arc's lane.
 *
 * The lookup is the deck's own `cardIdForSession` and nothing narrower, which
 * is the whole of this hook. A private walk over `binding.tugSessionId` lived
 * here and compared the arc's segment against each card's *spawn address* —
 * two ids that are the same string only until the card's first rotation
 * ([P01]). The Wheel moves `bound_session` forward on every rotation, so a
 * card that had rotated even once stopped matching: the row lost
 * `data-activatable`, presented as inert, and the click did nothing at all.
 * `cardIdForSession` answers for the LINE, which a rotation does not move.
 *
 * Null is the common case, not an error: the Arcs card lists every arc in every
 * open project, so an arc nobody holds — or one whose worker's card is closed —
 * simply has no room to open. That is what makes the row inert, and what the
 * row's own affordance has to advertise.
 */
function useWorkerCard(entry: { bound_session?: string }): string | null {
  const boundSession = entry.bound_session ?? null;
  // Called unconditionally on every row, bound or not — hooks have no branch.
  // The empty string is never any card's session, so an unbound arc's answer
  // is null by both paths; the explicit guard is what says so.
  const cardId = useCardIdForSession(boundSession ?? "");
  return boundSession === null ? null : cardId;
}

/**
 * The tug session of the card the Arcs card is following, or null.
 *
 * Where this section's answers go. Bind's target is narrower — it refuses a
 * card in another project — but a replay's outcome has to reach a reader even
 * when a bind from the same row would be refused, so the notice is aimed at the
 * followed card itself rather than at Bind's resolved target.
 */
function useFollowedSessionId(): string | null {
  const followedCardId = useFollowedCard();
  const bindings = useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    cardSessionBindingStore.getSnapshot,
  );
  if (followedCardId === null) return null;
  return bindings.get(followedCardId)?.tugSessionId ?? null;
}

/** {@link resolveBindTarget} against the live followed card and its binding. */
function useBindTarget(row: ArcRow): BindTarget {
  const followedCardId = useFollowedCard();
  const bindings = useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    cardSessionBindingStore.getSnapshot,
  );
  const binding =
    followedCardId !== null ? bindings.get(followedCardId) : undefined;
  return resolveBindTarget({
    followedCardId,
    binding,
    projectDir: row.projectDir,
    projectLabel: row.projectLabel,
  });
}

/**
 * The card the Arcs card is following, as the transport verbs read it — or
 * null when there is no followed card, or it holds no session
 * ({@link useCardTransportFacts}).
 */
function useFollowedCardFacts(): FollowedCardFacts | null {
  return useCardTransportFacts(useFollowedCard());
}

/** What a row may ask of the section around it. */
interface ArcVerbs {
  requestDiscard: (row: ArcRow, anchor: HTMLElement | null) => void;
  /**
   * Arm the delete of a paperwork row's documents — the verb `discard` refuses
   * outright, because a branchless arc has no git state for it to end ([B05]).
   */
  requestDeleteDocuments: (
    row: DocumentArcRow,
    anchor: HTMLElement | null,
  ) => void;
  /** Send `changeset_replay`; the outcome speaks on the followed card. */
  requestReplay: (row: ArcRow, tugSessionId: string | null) => void;
  /** Why every Replay in this section is unavailable right now, or null. */
  replayDisabledReason: string | null;
}

const ArcVerbsContext = React.createContext<ArcVerbs | null>(null);

/**
 * Open an arc's room: front the card working it and reveal that card's Changes
 * shade, which is where every decision about an arc already lives ([D152]).
 * The row's activation and its Changes verb are one act, so both call this.
 *
 * The raise comes FIRST and unconditionally, exactly as a click on this
 * session's Cards row would: front the pane, promote the chain, flash the
 * header once. It is not the reveal's tail — a card whose content responder is
 * momentarily absent (mid-mount, mid-rotation) used to swallow the whole
 * gesture, which is a dead click on a control that advertised itself as a
 * door.
 */
function openArcRoom(boundSession: string | null): void {
  if (boundSession === null) return;
  // `cardIdForSession`, which answers for the line rather than for a spawn
  // address a rotation has left behind. Read live here rather than through
  // the hook, because a press is an event and the binding may have moved
  // since render.
  const cardId = cardIdForSession(boundSession);
  if (cardId === null) return;
  // The shell raises the card and sends the reveal to its content, in
  // whichever page that card's content lives — never this card's own.
  dispatchCommand("reveal-session-changes", { cardId });
}

/**
 * The list cell an element sits in — the anchor every confirm on this card
 * hangs off. Never the pressed control: the confirm outlives the press, and a
 * recycled cell would strand a popover hung off a control inside it.
 */
function cellOf(element: HTMLElement | null): HTMLElement | null {
  return (element?.closest(".tug-list-view-cell") as HTMLElement | null) ?? null;
}

/**
 * Release the hold a card has on an arc. Unbinding names no arc: the frame
 * carries the holding session, and the server drops whatever it holds — the
 * same frame the Changes shade's lane sends for its own card.
 */
function sendUnbind(boundSession: string | null): void {
  if (boundSession === null) return;
  getConnection()?.sendControlFrame("unbind_arc", {
    tug_session_id: boundSession,
  });
}

/**
 * An arc row's verbs — the {@link ArcVerbRow} under its block, and the
 * right-click menu that is a second door onto the same housekeeping verbs
 * ([B08]), composed from the Changes shade's own {@link useArcRowMenu}.
 *
 * Both doors perform through the same callbacks, so they cannot drift. Bind's
 * refusals arrive verbatim from {@link resolveBindTarget} ([L31]); a bound row
 * offers Unbind instead, the binding verb in the word the arc's state reads
 * ([B09]).
 *
 * The press reports **nothing locally** for a bind: on success the worker's atom
 * arrives on the eyebrow, so a pending state would be reporting into a control
 * that is about to change. A server-side refusal arrives on the card-level
 * `arc-bind-error-store` surface, which outlives the row — and a replay's
 * outcome on its sibling, for the same reason.
 */
function useArcRowVerbs(
  row: ArcRow,
  workerCardOpen: boolean,
): {
  set: ArcVerbSet;
  voice: string | null;
  onVerb: (kind: ArcSurfaceVerbKind, anchor: HTMLElement | null) => void;
  onContextMenu: (event: React.MouseEvent) => void;
  menu: React.ReactNode;
} {
  const verbs = React.useContext(ArcVerbsContext);
  const target = useBindTarget(row);
  const followedSessionId = useFollowedSessionId();
  const followed = useFollowedCardFacts();
  const entry = row.entry;
  const name = entry.display_name;
  const bound = entry.bound_session ?? null;
  const rowRef = React.useRef<HTMLElement | null>(null);
  // The bound card's join round trip, which a Join from this row rides.
  const joinVerb = useChangesetJoin(sessionEntryKey(bound ?? ""));

  const bind = (): void => {
    if (target.tugSessionId === null) return;
    // The same frame the Changes shade's lane sends, so there is one binding
    // path. `bind_arc_ok` stays the only mover of `cardSessionBindingStore`:
    // a refused bind leaves the card bound to whatever it was.
    getConnection()?.sendControlFrame("bind_arc", {
      tug_session_id: target.tugSessionId,
      project_dir: row.projectDir,
      arc: name,
    });
  };
  const unbind = (): void => sendUnbind(bound);
  const bindingRefusal = bound !== null ? null : target.reason;
  const replayRefusal = verbs?.replayDisabledReason ?? null;
  // The outcome reports on the followed card — the same card a Bind from this
  // row aims at, so the section's verbs answer in one place rather than
  // sending the reader hunting.
  const replay = (): void => verbs?.requestReplay(row, followedSessionId);

  const rowMenu = useArcRowMenu({
    binding: {
      bound: bound !== null,
      disabledReason: bindingRefusal,
      perform: bound !== null ? unbind : bind,
    },
    discard:
      verbs === null
        ? null
        : {
            disabledReason: null,
            // The menu unmounts on selection, so the anchor is the row's cell.
            perform: () => verbs.requestDiscard(row, cellOf(rowRef.current)),
          },
    replay:
      verbs === null
        ? null
        : {
            label: `Replay onto ${entry.base}`,
            disabledReason: replayRefusal ?? replayDisabledReason(entry),
            perform: replay,
          },
  });

  const set = arcVerbs({
    surface: "arcs",
    arc: name,
    projectDir: row.projectDir,
    run: entry.arc ?? null,
    documents: entry.documents,
    boundSession: bound,
    boundCardOpen: workerCardOpen,
    stage: entry.stage,
    restamp: entry.restamp ?? null,
    draft: entry.draft?.message ?? null,
    joinGate: {
      state: entry.join ?? null,
      holderBusy: entry.holders_busy === true,
      // The bound card's turn is not visible from here; its holder's busy
      // bit, which a turn sets, is.
      turnInProgress: false,
      pending: joinVerb.phase === "pending",
    },
    branch: arcBranchFacts(entry),
    followed,
    reach: {
      binding: { bound: bound !== null, refusal: bindingRefusal },
      replay: verbs === null ? null : { refusal: replayRefusal },
      discard: verbs === null ? null : { refusal: null },
    },
  });

  const onVerb = (kind: ArcSurfaceVerbKind, anchor: HTMLElement | null): void => {
    switch (kind) {
      case "changes":
        openArcRoom(bound);
        return;
      case "bind":
        bind();
        return;
      case "unbind":
        unbind();
        return;
      case "replay":
        replay();
        return;
      case "discard":
        verbs?.requestDiscard(row, cellOf(anchor));
        return;
      case "join":
        // Offered unrefused only with a bound card open and a draft to land
        // ([B05]); the guard restates that for the type.
        if (bound !== null && entry.draft !== undefined) {
          pressArcJoin({
            workspaceKey: row.workspaceKey,
            arc: name,
            boundSession: bound,
            message: entry.draft.message,
            voice: followed?.tugSessionId ?? bound,
          });
        }
        return;
      default:
        // Diff is the lane's view, never offered here.
        return;
    }
  };

  const onContextMenu = (event: React.MouseEvent): void => {
    if (rowMenu.menu === null) return;
    event.preventDefault();
    event.stopPropagation();
    rowRef.current = event.currentTarget as HTMLElement;
    rowMenu.openMenuAt(event.clientX, event.clientY);
  };

  return {
    set,
    // The bulletin a refused transport press speaks on — the followed card,
    // or the card working the arc when this card follows none.
    voice: followed?.tugSessionId ?? bound,
    onVerb,
    onContextMenu,
    menu:
      rowMenu.menu === null ? null : (
        <span
          className="arcs-verbs"
          data-slot="arcs-verbs"
          aria-label={`Actions for arc ${name}`}
        >
          {rowMenu.menu}
        </span>
      ),
  };
}

/**
 * A plan row's verb row: the transport, Changes, Unbind on a bound row, and
 * Discard — the documents' delete ([B07]).
 *
 * Discard arms the card's one {@link TugConfirmPopover} rather than acting: the
 * delete removes the working documents, and `.tug/` is excluded from git, so
 * the archive the engine copies them into first is the only way back to them.
 * A branchless arc offers no Bind: Start is what seats it on a card.
 */
function PlanVerbRow({ row }: { row: DocumentArcRow }): React.ReactElement {
  const verbs = React.useContext(ArcVerbsContext);
  const followed = useFollowedCardFacts();
  const entry = row.entry;
  const bound = entry.bound_session ?? null;
  const workerCardOpen = useWorkerCard(entry) !== null;
  const set = arcVerbs({
    surface: "arcs",
    arc: entry.display_name,
    projectDir: row.projectDir,
    run: entry.arc ?? null,
    documents: entry.documents,
    boundSession: bound,
    boundCardOpen: workerCardOpen,
    stage: undefined,
    draft: null,
    joinGate: NO_JOIN_GATE,
    branch: null,
    followed,
    reach: {
      binding: bound === null ? null : { bound: true, refusal: null },
      replay: null,
      discard: verbs === null ? null : { refusal: null },
    },
  });
  const onVerb = (kind: ArcSurfaceVerbKind, anchor: HTMLElement | null): void => {
    switch (kind) {
      case "changes":
        openArcRoom(bound);
        return;
      case "unbind":
        sendUnbind(bound);
        return;
      case "discard":
        verbs?.requestDeleteDocuments(row, cellOf(anchor));
        return;
      default:
        return;
    }
  };
  return (
    <span className="arcs-verb-row">
      <ArcVerbRow
        arc={entry.display_name}
        verbs={set}
        voice={followed?.tugSessionId ?? bound}
        onVerb={onVerb}
        labels="on-hover"
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// The block
// ---------------------------------------------------------------------------

/**
 * What an arc's JOIN is doing, in the one shared sentence — the same
 * derivation the shade and the composer call. A hook of the row rather than
 * of a child because the row needs the reading to decide its own shape, and
 * per row so a beat of one arc's join re-renders that row and no other.
 */
function useArcJoinReading(row: ArcRow): ReturnType<typeof arcJoinRegister> {
  const entry = row.entry;
  const landBeat = useChangesetJoinLand(row.workspaceKey, entry.display_name);
  return arcJoinRegister({
    arc: entry.display_name,
    base: entry.base ?? "main",
    stage: entry.stage,
    join: entry.join,
    holdersBusy: entry.holders_busy === true,
    landBeat,
    // The Arcs card is the one surface that renders arcs nobody is holding,
    // so it is the one that has to hand the register that fact ([D147]).
    bound: entry.bound_session !== undefined,
    ...staleAuditFacts(entry),
    // A live wheel outranks the offer: the section shows the stage that is
    // running rather than a readiness the audit has not signed off on.
    run: entry.arc ?? null,
    // …and whether that wheel's walk is over, which is what tells a stop
    // mid-walk from a stop at the seam before the audit.
    runComplete: entry.run_complete === true,
  });
}

const ArcCell: TugListViewCellRenderer<CockpitRowsDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<CockpitRowsDataSource>) => {
  const item = dataSource.items[index];
  if (item?.kind !== "arc") return null;
  return <ArcRowCell row={item.row} dataSource={dataSource} />;
};

/**
 * One arc's row, for a row that exists. The guard above stays in `ArcCell`
 * so every hook below runs on every render of this component: a hook after
 * an early return changes the hook order the render that flips it sees.
 */
function ArcRowCell({
  row,
  dataSource,
}: {
  row: ArcRow;
  dataSource: CockpitRowsDataSource;
}): React.ReactElement {
  const entry = row.entry;
  const worker = entry.bound_session ?? null;
  // What a click on this row would do — and therefore what the row is allowed
  // to look like. A row with no open worker card has no room to open, and a
  // dead click on something that presented as live is the failure this
  // attribute exists to prevent ([L06]: the pointer and hover treatment are
  // CSS on this bit, never React state). An inert row never invited the press,
  // so it owes no refusal.
  const activatable = useWorkerCard(entry) !== null;
  const model = arcTrackModelFromEntry(entry);
  // The ledger the row can fold open to, and whether it is open. An arc with a
  // brief alone — or one still being devised — carries no steps. The cue is
  // drawn either way and disabled when there is nothing to fold, so every row
  // in the list ends at the same edge and the column never goes ragged.
  const steps = entry.steps ?? [];
  // The fold's hover, in the plural the count takes.
  const foldWord = `${steps.length} step${steps.length === 1 ? "" : "s"}`;
  const expanded = dataSource.expanded.has(row.ownerId);
  // Every verb the arc offers, in the row under the block — and the same
  // housekeeping verbs again on the row's second button ([B08]).
  const verbs = useArcRowVerbs(row, activatable);
  // What this arc's JOIN is doing. Read here, on the row: do not re-split it
  // into a child — the row needs the reading to decide its own shape.
  const register = useArcJoinReading(row);
  // A READY arc says so in the lifecycle line's own words, and draws no band
  // ([P08]). The register's third line was chrome restating a settled fact one
  // line below the line that could have carried it — and only for this one
  // reading, which is why the override is scoped to `ready` and every other
  // reading keeps its band untouched ([Q01]).
  const ready = register?.word === "ready";
  // What the wheel is waiting for on this arc's seat, if anything.
  const waiting = arcRowWaiting(entry.arc);
  return (
    <TugListRow
      className="arcs-row"
      variant="flush"
      density="compact"
      data-slot="arcs-row"
      data-arc={entry.display_name}
      // What this arc's join reads as, on the row itself. The register band
      // below carries the same word in its own `data-word`, but a READY row
      // draws no band at all — so the row is the one element that states the
      // reading whichever shape it takes.
      data-join-word={register?.word}
      data-bound={worker !== null ? "true" : undefined}
      data-activatable={activatable ? "true" : undefined}
      onContextMenu={verbs.onContextMenu}
    >
      <span className="arcs-block">
        {/* The arc's whole life in the one block: line one the identities,
            line two the track, the phase glyph, the fraction, and the word.
            The pill wears no review tint — that yellow
            means WAITING, and an arc is not waiting for anyone.

            Every row answers the same menu, held or not: Replay reaches a
            bound arc on the same terms as an unbound one, and a menu that
            came and went with the binding would be the section's old wart in
            miniature. */}
        <ArcLifecycleBlock
          name={entry.display_name}
          worker={worker}
          model={model}
          stepTitle={entry.step_title ?? null}
          {...(ready && register !== null
            ? {
                note: register.line,
                // The settled green dot the transcript already means `done`
                // by, standing where the phase glyph stands. A ready arc is
                // waiting on a person rather than on work, which no phase of
                // the model says — so the host says it ([P06]).
                mark: (
                  <TugProgressIndicator
                    variant="pulsing-dot"
                    size={11}
                    phase="success"
                    phaseVisual={toolCallPhaseVisual}
                    aria-label="Ready"
                  />
                ),
              }
            : {})}
          // The cue rides the LINE's trailing slot rather than the eyebrow's:
          // at the sidebar's width the eyebrow could not hold two names and a
          // control, and the names were what elided. The verbs stand in their
          // own row under the block.
          lineTrailing={
            <>
              {/* The tool-call header's own cue, in the slot the block
                  reserved for it: same icon pair, same `xs` icon-only shape,
                  and the default scroll stabilization, because this list
                  scrolls exactly as the transcript does. No `stopPropagation`
                  and no selection guard — the list excuses any descendant that
                  refuses focus, so a press here never picks the row.

                  The hover names the fold in the count's own terms, because
                  `subtype="icon"` means the chevron carries no label of its
                  own and its direction is the only thing saying which way the
                  press goes. An arc with no steps draws the cue DOM-disabled,
                  which takes no pointer events — so that one row is the one
                  with no bubble, and it is also the row with nothing to say
                  beyond the emptiness the lifecycle line already states. */}
              <BlockFoldCue
                collapsed={!expanded}
                onToggle={() => dataSource.toggle(row.ownerId)}
                collapsedLabel="Expand"
                expandedLabel="Collapse"
                ariaLabelExpand={`Expand steps for arc ${entry.display_name}`}
                ariaLabelCollapse={`Collapse steps for arc ${entry.display_name}`}
                tooltip={expanded ? `Hide ${foldWord}` : `Show ${foldWord}`}
                size="xs"
                subtype="icon"
                // Disabled when the fold would open over nothing at all.
                disabled={steps.length === 0}
                data-slot="arcs-steps-fold"
              />
            </>
          }
        />
        {/* The verbs, under the block ([B01]): the next step, Changes, then
            the housekeeping verbs at the trailing edge. */}
        <span className="arcs-verb-row">
          <ArcVerbRow
            arc={entry.display_name}
            verbs={verbs.set}
            voice={verbs.voice}
            onVerb={verbs.onVerb}
            labels="on-hover"
          />
        </span>
        {verbs.menu}
        {/* And what its JOIN is doing, in the one shared register — the same
            sentence the shade and the composer show, because all three call
            one derivation. Renders nothing until there is a join, and nothing
            for a ready arc, which said it one line up. */}
        {ready ? null : (
          <span className="arcs-register">
            <ArcJoinRegisterView register={register} altitude="section" />
          </span>
        )}
        {/* And what the wheel is waiting for, beneath the register: the one
            sentence the runner composed, which no face can derive — the line
            above says `implementing (i/N)` whether the boundary is moving or
            held on a job launched two steps ago. */}
        {waiting !== null ? (
          <span className="arcs-waiting" data-slot="arcs-row-waiting">
            {waiting}
          </span>
        ) : null}
        {/* And, folded open, the plan's own ledger — the same component the
            `ARC` placard mounts, so the row and the placard cannot disagree
            about one arc's steps. Structure rather than appearance: the rows
            mount while open and unmount when folded, so an arc nobody has
            opened costs no ledger DOM at all. */}
        {expanded && steps.length > 0 ? (
          <span className="arcs-steps" data-slot="arcs-steps">
            <ArcStepItems steps={steps} live={model.live} />
          </span>
        ) : null}
      </span>
    </TugListRow>
  );
}

/**
 * A waiting plan document, in the section's own two-line grammar: an eyebrow
 * naming the document and carrying its affordances, over a meta line saying
 * what it is and how far it goes.
 *
 * The affordances are the verb row under the block ({@link PlanVerbRow}),
 * never row activation ([D142]): a plan row has no room to open, and pressing
 * anywhere on it must not start anything. Its first verb is the transport, and
 * pressing Start opens the arc on the followed card through the server's own
 * `arc_run`. The press names no kind: the server derives that from the arc's
 * documents at the opening ([D178] as amended, [P03]). A press that cannot land
 * is not disabled: it stays pressable and speaks its reason ([L31], [P07]).
 *
 * No fold cue beside either: [D176] left the plan rows out of the fold,
 * because the ledger a fold opens is one a waiting document's entry does not
 * carry.
 */
const PlanCell: TugListViewCellRenderer<CockpitRowsDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<CockpitRowsDataSource>) => {
  const item = dataSource.items[index];
  if (item?.kind !== "plan") return null;
  const row = item.row;
  const entry = row.entry;
  const begun = documentArcIsBegun(entry);
  // The counted steps, never the composed ones: `arcTrackModelFromEntry` over
  // the adapted entry would find no `steps` at all and read `review` for a
  // plan already half walked.
  const model = documentArcTrackModel(entry);
  // The same wait, on the row a planned arc wears for the whole of devise and
  // review — the stages where a seated tick most often decides nothing.
  const waiting = arcRowWaiting(entry.arc);
  return (
    <TugListRow
      className="arcs-row"
      variant="flush"
      density="compact"
      data-slot="arc-document-row"
      data-arc={entry.display_name}
      data-review={entry.review}
      data-begun={begun ? "true" : "false"}
    >
      <span className="arcs-block">
        <ArcLifecycleBlock
          name={entry.display_name}
          worker={entry.bound_session ?? null}
          model={model}
        />
        <PlanVerbRow row={row} />
        {waiting !== null ? (
          <span className="arcs-waiting" data-slot="arcs-row-waiting">
            {waiting}
          </span>
        ) : null}
      </span>
    </TugListRow>
  );
};


// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

/**
 * A cycle's pin: the fold cue, the name and how much has landed, over the
 * map, or over the strip when the cycle is folded. It holds the top of the
 * card while the cycle's assets are in view.
 *
 * The row is the fold's keyboard stop, so a press on its head folds as the
 * cue does. The well under the head refuses focus: a press on the map selects
 * an asset and must never also pick the row, which would fold the map out
 * from under the pointer.
 */
function CyclePin({
  item,
  actions,
}: {
  item: Extract<ArcsCardItem, { kind: "cycle-pin" }>;
  actions: CycleActions;
}): React.ReactElement {
  const { section, folded, chosen } = item;
  return (
    <div
      className="arcs-cycle-pin"
      data-slot="arcs-cycle-pin"
      data-cycle={section.id}
      data-folded={folded ? "true" : undefined}
    >
      <div className="arcs-cycle-head">
        <BlockFoldCue
          collapsed={folded}
          onToggle={() => actions.fold(section)}
          collapsedLabel="Open"
          expandedLabel="Fold"
          ariaLabelExpand={`Open cycle ${section.name}`}
          ariaLabelCollapse={`Fold cycle ${section.name}`}
          tooltip={folded ? "Show the map" : "Hide the map"}
          size="xs"
          subtype="icon"
          data-slot="arcs-cycle-fold"
        />
        <span className="arcs-cycle-name" data-slot="arcs-cycle-name">
          {section.name}
        </span>
        <TugLabel size="2xs" emphasis="calm">
          {section.landedText}
        </TugLabel>
      </div>
      <div className="arcs-cycle-well" data-tug-focus="refuse">
        {folded ? (
          // One segment per entry, in the tone of how it stands. The head
          // says the same in words, so the strip is not read aloud.
          <span className="arcs-cycle-strip" data-slot="arcs-cycle-strip" aria-hidden="true">
            {section.strip.map((state, index) => (
              // The strip is positional: a segment is its entry's place.
              <span key={index} data-state={state} />
            ))}
          </span>
        ) : (
          <CycleMap
            className="arcs-cycle-map"
            tiles={section.tiles}
            sketches={section.sketches}
            size="compact"
            chosen={chosen}
            onPress={(key, shift) => actions.pressMap(section, key, shift)}
            onClear={() => actions.pressMap(section, null, false)}
          />
        )}
        {!folded && chosen.size > 1 ? (
          <CycleOnlyBar
            className="arcs-cycle-only"
            count={chosen.size}
            onBack={() => actions.pressMap(section, null, false)}
          />
        ) : null}
      </div>
    </div>
  );
}

const CyclePinCell: TugListViewCellRenderer<CockpitRowsDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<CockpitRowsDataSource>) => {
  const item = dataSource.items[index];
  if (item?.kind !== "cycle-pin") return null;
  return <CyclePin item={item} actions={dataSource.cycles} />;
};

/** What every cycle entry row is handed, whichever of its shapes draws it. */
interface CycleEntryProps {
  /** The cycle the entry belongs to: the row's address for a map press. */
  cycleId: string;
  row: CycleEntryRow;
  open: boolean;
}

/**
 * One entry of a cycle: one row, and the only drawing of the entry on the
 * card. Closed, it is the arc and one line of where it stands. Open, the same
 * row holds its steps or the sentence saying where it stands, its session and
 * its brief, then whatever its host hands it to stand under those.
 *
 * The session chip is the link to the session; a press anywhere else on the
 * row opens the row. Nothing here starts an entry.
 */
function CycleEntryView({
  cycleId,
  row,
  open,
  model,
  under,
  onContextMenu,
}: CycleEntryProps & {
  /** The running arc's track model, for the state mark; null when not running. */
  model: ArcTrackModel | null;
  /** What stands under the open row's own lines: the arc's verbs. */
  under?: React.ReactNode;
  onContextMenu?: (event: React.MouseEvent) => void;
}): React.ReactElement {
  const entry = row.entry;
  const state = entry.state;
  const bound = entry.bound_session ?? null;
  const steps = row.arc?.entry.steps ?? [];
  const worker =
    state === "running" && bound !== null ? (
      <span className="arcs-cycle-line">
        <span>in</span>
        <button
          type="button"
          className="arcs-cycle-session"
          data-slot="arcs-cycle-session"
          data-tug-focus="refuse"
          aria-label={`Go to the session running ${row.title}`}
          onClick={() => openCitedSession(bound)}
        >
          <ArcWorkerAtom sessionId={bound} />
        </button>
      </span>
    ) : null;
  const waits =
    state === "waiting" || (state === "ready" && entry.note !== undefined) ? (
      <span className="arcs-cycle-line">
        <CycleWaits
          label="Waits on"
          items={entry.waits.map((n) => ({ n, met: !row.openWaits.includes(n) }))}
        />
        {entry.note !== undefined ? (
          <span className="arcs-cycle-note">{entry.note}</span>
        ) : null}
      </span>
    ) : null;
  return (
    <TugListRow
      className="arcs-cycle-row"
      variant="flush"
      density="compact"
      selected={open}
      data-slot="arcs-cycle-entry"
      data-cycle={cycleId}
      data-asset={row.key}
      data-state={state}
      data-open={open ? "true" : undefined}
      onContextMenu={onContextMenu}
      leading={
        <span className="arcs-cycle-number" data-slot="arcs-cycle-number">
          {entry.n}
        </span>
      }
      trailing={
        <CycleEntryMark
          state={state}
          model={model}
          name={entry.arc?.name ?? row.title}
        />
      }
      trailingReveal="always"
    >
      <span className="arcs-cycle-content">
        {entry.arc !== undefined ? (
          <TugArcAtom name={entry.arc.name} />
        ) : (
          <span className="arcs-cycle-title">{row.title}</span>
        )}
        {open ? null : worker}
        {waits}
        {open ? (
          <>
            {state === "running" && steps.length > 0 ? (
              // The arc's own ledger, from the arc's own row in the same
              // frame, so the entry and the arc cannot disagree.
              <span className="arcs-steps" data-slot="arcs-cycle-steps">
                <ArcStepItems steps={steps} live={model?.live ?? true} />
              </span>
            ) : state === "joined" ? (
              // The badge already says Joined; the open row says what that
              // left behind, in the shade's words.
              <span className="arcs-cycle-line" data-slot="arcs-cycle-landed">
                Landed. Its rounds and commit stay on record.
              </span>
            ) : (
              <span className="arcs-cycle-line" data-slot="arcs-cycle-sentence">
                {row.sentence}
              </span>
            )}
            {worker}
            {entry.brief_path !== undefined ? (
              <span className="arcs-cycle-line">
                <TugAtomRef entity={{ kind: "file", path: entry.brief_path }} />
              </span>
            ) : null}
          </>
        ) : null}
        {under}
      </span>
    </TugListRow>
  );
}

/**
 * An entry whose arc is live: the entry's row, carrying the verbs, the join
 * register and the right-click menu the arc had as a loose row. An arc that
 * moves into a cycle must not lose them, so they are the same hooks and the
 * same components, standing under the open row's steps.
 *
 * The menu's portal host mounts whether the row is open or not: the
 * right-click is a door onto the verbs, and a closed row answers it too.
 */
function LiveCycleEntry({
  arc,
  ...props
}: CycleEntryProps & { arc: ArcRow }): React.ReactElement {
  const activatable = useWorkerCard(arc.entry) !== null;
  const verbs = useArcRowVerbs(arc, activatable);
  const register = useArcJoinReading(arc);
  const waiting = arcRowWaiting(arc.entry.arc);
  return (
    <CycleEntryView
      {...props}
      model={arcTrackModelFromEntry(arc.entry)}
      onContextMenu={verbs.onContextMenu}
      under={
        <>
          {props.open ? (
            <span className="arcs-verb-row">
              <ArcVerbRow
                arc={arc.entry.display_name}
                verbs={verbs.set}
                voice={verbs.voice}
                onVerb={verbs.onVerb}
                labels="on-hover"
              />
            </span>
          ) : null}
          {verbs.menu}
          {props.open ? (
            <span className="arcs-register">
              <ArcJoinRegisterView register={register} altitude="section" />
            </span>
          ) : null}
          {props.open && waiting !== null ? (
            <span className="arcs-waiting" data-slot="arcs-row-waiting">
              {waiting}
            </span>
          ) : null}
        </>
      }
    />
  );
}

/**
 * A cycle entry's row, in the shape its arc calls for: live, with the arc's
 * verbs; running on paperwork alone, with the paperwork's; or neither.
 */
function CycleEntry(props: CycleEntryProps): React.ReactElement {
  const { row, open } = props;
  if (row.arc !== null) return <LiveCycleEntry {...props} arc={row.arc} />;
  return (
    <CycleEntryView
      {...props}
      model={row.plan !== null ? documentArcTrackModel(row.plan.entry) : null}
      under={open && row.plan !== null ? <PlanVerbRow row={row.plan} /> : null}
    />
  );
}

/** A sketch of a cycle: one row, its want closed and the whole of it open. */
function CycleSketchRowView({
  cycleId,
  sketch,
  open,
}: {
  cycleId: string;
  sketch: CycleSketchRow;
  open: boolean;
}): React.ReactElement {
  const text = sketch.text !== "" ? sketch.text : sketch.want;
  return (
    <TugListRow
      className="arcs-cycle-row"
      variant="flush"
      density="compact"
      selected={open}
      data-slot="arcs-cycle-sketch"
      data-cycle={cycleId}
      data-asset={sketch.key}
      data-open={open ? "true" : undefined}
      leading={<CycleSeal letter={sketch.letter} />}
      trailing={
        <CycleWaits
          label="Heads"
          items={sketch.entries.map((n) => ({ n, met: true }))}
          checks={false}
        />
      }
      trailingReveal="always"
    >
      <span className="arcs-cycle-content">
        <span className="arcs-cycle-title">{`Sketch ${sketch.letter}`}</span>
        {open ? (
          <span className="arcs-cycle-sketch-text" data-slot="arcs-cycle-sketch-text">
            {text.trim() !== ""
              ? parseArcRecord(text).map((block, index) =>
                  block.kind === "paragraph" ? (
                    <p key={index}>{block.text}</p>
                  ) : (
                    <ul key={index}>
                      {block.items.map((item, at) => (
                        <li key={at}>{item}</li>
                      ))}
                    </ul>
                  ),
                )
              : "No text on record."}
          </span>
        ) : sketch.want !== "" ? (
          <span className="arcs-cycle-want">{sketch.want}</span>
        ) : null}
      </span>
    </TugListRow>
  );
}

const CycleAssetCell: TugListViewCellRenderer<CockpitRowsDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<CockpitRowsDataSource>) => {
  const item = dataSource.items[index];
  if (item?.kind !== "cycle-asset") return null;
  return item.asset.kind === "sketch" ? (
    <CycleSketchRowView
      cycleId={item.section.id}
      sketch={item.asset.sketch}
      open={item.open}
    />
  ) : (
    <CycleEntry cycleId={item.section.id} row={item.asset.row} open={item.open} />
  );
};

const ARC_CELL_RENDERERS = {
  "cycle-pin": CyclePinCell,
  "cycle-asset": CycleAssetCell,
  arc: ArcCell,
  plan: PlanCell,
};

/** The list cell of each cycle's pin, in card order. */
function cyclePinCells(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      '.tug-list-view-cell[data-tug-list-cell-kind="cycle-pin"]',
    ),
  );
}

/**
 * Let each pin go as its cycle's last asset leaves the top of the card.
 *
 * A pin's cell is sticky inside a flat list, so nothing in CSS ends its hold
 * where its cycle ends. This writes the release: once the last asset's foot
 * rises above the pin's own, the pin is carried up by the difference, so the
 * asset pushes it off the top. Appearance only, written to the DOM ([L06]);
 * it reads geometry a scroll does not dirty, and writes a transform, which
 * dirties none.
 */
function settleCyclePins(root: HTMLElement): void {
  const top = root.getBoundingClientRect().top;
  for (const pin of cyclePinCells(root)) {
    let last: HTMLElement = pin;
    for (
      let next = pin.nextElementSibling;
      next instanceof HTMLElement && next.dataset.tugListCellKind === "cycle-asset";
      next = next.nextElementSibling
    ) {
      last = next;
    }
    const shift =
      last === pin
        ? 0
        : Math.min(0, last.getBoundingClientRect().bottom - top - pin.offsetHeight);
    const transform = shift < 0 ? `translateY(${shift}px)` : "";
    if (pin.style.transform !== transform) pin.style.transform = transform;
  }
}

/** Give the room under the list a height, or take it back at zero. */
function sizeCycleTail(root: HTMLElement, height: number): void {
  const tail = root.querySelector<HTMLElement>('[data-slot="arcs-cycle-tail"]');
  if (tail === null) return;
  const value = height > 0 ? `${Math.ceil(height)}px` : "";
  if (tail.style.height !== value) tail.style.height = value;
}

/**
 * Bring one asset's row up under its cycle's pin, after a press on the map.
 *
 * The room under the list is sized first, from the pin's measured height and
 * the card's own: just enough that the row can reach the pin's foot, and none
 * when the rows below it already allow that. It is sized at the press and not
 * kept current, so a card that sizes itself to its content cannot chase it.
 */
function bringAssetUnderPin(root: HTMLElement, cycle: string, key: string): void {
  let pin: HTMLElement | null = null;
  let asset: HTMLElement | null = null;
  for (const el of root.querySelectorAll<HTMLElement>("[data-cycle]")) {
    if (el.dataset.cycle !== cycle) continue;
    if (el.dataset.slot === "arcs-cycle-pin") pin = cellOf(el);
    else if (el.dataset.asset === key) asset = cellOf(el);
  }
  if (pin === null || asset === null) return;
  const rootTop = root.getBoundingClientRect().top;
  const top =
    asset.getBoundingClientRect().top - rootTop + root.scrollTop - pin.offsetHeight;
  // Where the card's content ends, in the scroller's own coordinates. Read
  // from the content element and never from `scrollHeight`, which is the
  // card's own height whenever the rows do not fill it.
  const content = root.querySelector<HTMLElement>("[data-card-content]");
  const contentEnd =
    (content?.getBoundingClientRect().bottom ?? rootTop) -
    rootTop +
    root.scrollTop +
    (parseFloat(getComputedStyle(root).paddingBottom) || 0);
  sizeCycleTail(root, top + root.clientHeight - contentEnd);
  root.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

/**
 * The card's verb round trips, keyed by the card rather than by row: one
 * discard and one replay at a time is the right number, and the state lives in
 * a module store that outlives this body.
 */
const ARCS_VERB_KEY = "arcs-card";

export interface ArcsContentProps {
  /** The Arcs card's id. */
  cardId: string;
}

export function ArcsContent({ cardId }: ArcsContentProps): React.ReactElement {
  // The card this one is contextually about — tracked once here, mounted the
  // whole time the pane is open, and published so every reader inside agrees
  // ([P11]).
  const followedCardId = useTrackFollowedCard(cardId);
  return (
    <FollowedCardContext value={followedCardId}>
      <ArcsBody />
    </FollowedCardContext>
  );
}

function ArcsBody(): React.ReactElement {
  const snapshot = useChangesetAll();
  // The session of the card this one follows decides which running entries
  // read as elsewhere, and nothing else.
  const followedSession = useFollowedSessionId();
  const projection = useMemo(
    () => projectArcsCard(snapshot, followedSession),
    [snapshot, followedSession],
  );
  // Which arcs are showing their steps. Card-local view scope: closing the
  // card forgets every fold, which is the right lifetime for a reading. The
  // set is keyed by the arc's owner key — the same key the list identifies its
  // cells by — and it lives up here rather than in the cell because a cell
  // recycled by virtualization, or replaced when a changeset beat recomputes
  // the snapshot, would drop a bit held inside it, and a rail card that
  // re-projects on every beat would be a row folding itself shut while you
  // read it.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback((ownerId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(ownerId)) next.add(ownerId);
      return next;
    });
  }, []);
  // Which cycles are folded and which assets are selected in each. The same
  // lifetime and the same home as the fold bits above, for the same reason:
  // closing the card forgets it, and a beat that replaces a row does not.
  const [view, setView] = useState<CycleViewState>(NO_CYCLE_VIEW);
  // The last press on a map, counted so the same asset pressed twice is two
  // presses. Only a map press scrolls; a press on a row leaves the row under
  // the pointer.
  const [mapPress, setMapPress] = useState<{
    cycle: string;
    key: string;
    n: number;
  } | null>(null);
  const cycleActions = useMemo<CycleActions>(
    () => ({
      fold: (section) => setView((was) => foldCycle(was, section)),
      pressMap: (section, key, shift) => {
        setView((was) => pressCycleMap(was, section.id, key, shift));
        if (key !== null) {
          setMapPress((was) => ({ cycle: section.id, key, n: (was?.n ?? 0) + 1 }));
        }
      },
    }),
    [],
  );
  const items = useMemo(() => listArcsCard(projection, view), [projection, view]);
  const dataSource = useMemo(
    () => new CockpitRowsDataSource(items, expanded, toggle, cycleActions),
    [items, expanded, toggle, cycleActions],
  );
  // Every kind of row, not the arc count. This one value decides two things —
  // whether the keyboard has anything to walk onto, and whether the body is
  // the empty state — so a project with plans and no arcs would otherwise
  // render "None" over rows that never mounted.
  const populated = items.length > 0;
  const pinned = items.some((item) => item.kind === "cycle-pin");

  // The card's one scroller ([B15]): the pins stick inside it, and a map
  // press scrolls it.
  const rootRef = useRef<HTMLDivElement | null>(null);

  // A pin lets go when its last asset leaves. The list is flat, so a pin's
  // sticky box is bounded by the whole list rather than by its cycle; the
  // release is written to the pin's cell as the scroller moves ([L06]). The
  // listener is registered in a layout effect because the first scroll may
  // arrive before a passive effect has run ([L03]).
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null || !pinned) return;
    const settle = (): void => settleCyclePins(root);
    settle();
    root.addEventListener("scroll", settle, { passive: true });
    // The card's width decides where rows wrap, and so where a cycle ends.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(settle);
    observer?.observe(root);
    return () => {
      root.removeEventListener("scroll", settle);
      observer?.disconnect();
    };
  }, [items, pinned]);

  // A press on the map opens the asset, then brings its row up under the
  // pin. It waits for the commit, since opening one asset closes another and
  // that moves every row below it.
  const handledPress = useRef(0);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    if (mapPress !== null && mapPress.n !== handledPress.current) {
      handledPress.current = mapPress.n;
      if (cycleChosen(view, mapPress.cycle).size === 1) {
        bringAssetUnderPin(root, mapPress.cycle, mapPress.key);
        return;
      }
    }
    // With nothing selected anywhere, the room a press made is given back.
    if (view.chosen.size === 0) sizeCycleTail(root, 0);
  }, [mapPress, view]);

  const discardVerb = useChangesetDiscard(ARCS_VERB_KEY);
  // And one documents-delete, for the reason the discard has one.
  const deleteVerb = useChangesetDeleteDocuments(ARCS_VERB_KEY);
  // One replay round trip for the section, for the reason the discard has one:
  // the state is a slot per key, and a second press would render the first's
  // phase.
  const replayVerb = useChangesetReplay(ARCS_VERB_KEY);
  // Which row armed the card's one confirm, which act it armed, and the
  // element the popover hangs off. View scope ([L24]): a half-armed confirm is
  // not worth remembering, and closing the card forgets it.
  //
  // One slot for two acts rather than two slots, because there is one popover
  // ([B04]) and a second armed confirm would have nowhere to draw. The kind
  // rides the slot so the message, the label and the frame all read the same
  // press — a discard ends an arc's git state, a delete destroys a brief, and
  // nothing here may ever confuse the two ([B05]).
  const [pendingConfirm, setPendingConfirm] = useState<
    | { kind: "discard"; row: ArcRow; anchor: HTMLElement | null }
    | { kind: "delete"; row: DocumentArcRow; anchor: HTMLElement | null }
    | null
  >(null);
  const verbs = useMemo<ArcVerbs>(
    () => ({
      requestDiscard: (row, anchor) =>
        setPendingConfirm({ kind: "discard", row, anchor }),
      requestDeleteDocuments: (row, anchor) =>
        setPendingConfirm({ kind: "delete", row, anchor }),
      // No confirm: a replay destroys nothing, and its every refusal path
      // leaves the repository exactly as it found it. What it needs instead is
      // a voice, which is the session id — the outcome posts on that card's
      // pane bulletin, and nothing else on any surface reports a replay at
      // all. The card the user is working in is the first choice; a card that
      // is following nothing falls back to the session working the arc,
      // which is the other card this outcome is about.
      requestReplay: (row, tugSessionId) => {
        const voice = tugSessionId ?? row.entry.bound_session ?? null;
        replayVerb.replay(
          row.workspaceKey,
          row.entry.display_name,
          voice ?? undefined,
        );
      },
      replayDisabledReason:
        replayVerb.phase === "pending" ? "A replay is in flight" : null,
    }),
    [replayVerb],
  );

  // What the armed confirm says — the sentence every surface's Discard shares.
  const confirm =
    pendingConfirm === null
      ? null
      : discardConfirm(pendingConfirm.kind === "delete");

  // The opening key view lands on a real row, never on emptiness: an empty list
  // is not a focus stop, and `useSeedKeyView` re-arms while the key is null, so
  // the first arc to arrive takes the cursor ([P02]).
  useSeedKeyView(populated ? `${ARCS_FOCUS_GROUP}:0` : null);

  // Activation opens the arc's ROOM: it fronts the card working the arc and
  // reveals that card's Changes shade, which is where every decision about a
  // arc already lives ([D152]). Navigation, never a verb — the mutating acts
  // stay on the row's own buttons, because status is not a control ([D142]).
  //
  // Click and Enter are the same act here, unlike the Cards card's split:
  // there, a click both selects and fronts, so the two doors differ. An arc row
  // has one destination and no second meaning to give the keyboard.
  //
  // A row with no open worker card does nothing — and says so before the press
  // rather than after, through the row's own activatable attribute.
  const delegate = useMemo<TugListViewDelegate>(() => {
    const activate = (index: number): void => {
      const item = items[index];
      if (item === undefined) return;
      switch (item.kind) {
        case "arc":
          openArcRoom(item.row.entry.bound_session ?? null);
          return;
        // A cycle's pin is its fold's keyboard stop: Return or Space on it
        // does what the cue does.
        case "cycle-pin":
          cycleActions.fold(item.section);
          return;
        // A press on an asset's row opens the row; the session chip inside
        // it is the link to the session.
        case "cycle-asset":
          setView((was) => pressCycleRow(was, item.section.id, item.asset.key));
          return;
        default:
          // A plan row has no room to open.
          return;
      }
    };
    return { onSelect: activate, onActivate: activate };
  }, [items, cycleActions]);

  // The empty state keeps the card, reading exactly as every other rail card's
  // does: the shared word, centered, on one row's worth of height.
  // An arc starts in a session card, so there is nothing to press here and no
  // way in to name — the card is a fixed address to glance at, not a door.
  if (!populated) {
    return (
      <div className={`${RAIL_CARD_CLASS} arcs-section`} data-slot="arcs-section">
        <div
          className={`${RAIL_CARD_CONTENT_CLASS} arcs-card-content`}
          data-testid="arcs-card-content"
          data-card-content=""
        >
          <TugEmptyLine className="arcs-empty" data-slot="arcs-empty">
            None
          </TugEmptyLine>
        </div>
      </div>
    );
  }

  return (
    <ArcVerbsContext value={verbs}>
      <div
        ref={rootRef}
        className={`${RAIL_CARD_CLASS} arcs-section`}
        data-slot="arcs-section"
      >
        {/* The content element ([B01]): everything the card draws, as one
            in-flow column inside the scroller ([B02]). */}
        <div
          className={`${RAIL_CARD_CONTENT_CLASS} arcs-card-content`}
          data-testid="arcs-card-content"
          data-card-content=""
        >
        <TugListView<CockpitRowsDataSource>
          dataSource={dataSource}
          delegate={delegate}
          cellRenderers={ARC_CELL_RENDERERS}
          scrollKey="dashes"
          inline
          rowLayout="flush"
          focusGroup={ARCS_FOCUS_GROUP}
          {...RAIL_LIST_PRESENTATION}
          className="arcs-list"
        />
        </div>
        {/* The room a map press may need under the last row, so that row can
            come up under its pin. No height until a press asks for one. It
            stands after the content element, not in it: the card's height is
            measured from that element, and room measured as content would
            grow the card instead of giving it something to scroll. */}
        {pinned ? (
          <div className="arcs-cycle-tail" data-slot="arcs-cycle-tail" aria-hidden="true" />
        ) : null}
        {/* One controlled confirm for the whole card, anchored to whichever
            row armed it. `confirm={{ role: "danger" }}` puts default focus on Cancel,
            so a reflexive Return can never destroy an arc or a brief. */}
        <TugConfirmPopover
          open={pendingConfirm !== null}
          anchorEl={pendingConfirm?.anchor ?? null}
          message={confirm?.message ?? ""}
          confirmLabel={confirm?.confirmLabel ?? "Discard"}
          confirm={{ role: "danger" }}
          side="top"
          onConfirm={() => {
            const armed = pendingConfirm;
            setPendingConfirm(null);
            if (armed === null) return;
            if (armed.kind === "discard") {
              discardVerb.discard(
                armed.row.projectDir,
                armed.row.entry.display_name,
              );
            } else {
              deleteVerb.deleteDocuments(
                armed.row.projectDir,
                armed.row.entry.display_name,
              );
            }
          }}
          onCancel={() => setPendingConfirm(null)}
        />
      </div>
    </ArcVerbsContext>
  );
}
