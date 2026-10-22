/**
 * rail-width-draft.ts — the rail width drag's draft, owned by `DeckCanvas`.
 *
 * Dragging a sidebar rail's deck-facing edge is a mutation transaction whose
 * draft is one side's width ([L08]): the hand aims a width, and only the
 * release crosses into state, as one `setRailWidth` for every member of the
 * side. A drag the system takes away — a lost pointer capture, a
 * `pointercancel`, Escape — commits nothing, and since nothing moved there is
 * nothing to put back.
 *
 * **Nothing on the deck moves while the hand is down.** Not a member, not
 * its page, not the content cards beside the rail, and not the stand-ins
 * here under them. The host tracks the pointer and reports with each step
 * the aim it reads from it (`lib/host-card-gesture.ts`): the width the
 * release commits, the width the edge is drawn at, and the limit it presses
 * past. Each `change` and the `commit` hand that aim in, so the shell
 * computes no width and no snap of its own. While the drag holds, the placer
 * posts the cards of the rail's panes and of the panes beside it as they
 * stood at the press (`holdCardsForHost`); the hold is released before the
 * commit, so the commit's placement names every card where it now stands.
 *
 * **Two layers, one writer each.** The pane whose edge was grabbed translates
 * pointer input into four calls — `begin`, `change`, `commit`, `cancel` — and
 * does nothing else: it writes no arrangement property, finds no canvas, and
 * clamps nothing. Everything the drag does to the deck is done here, by the
 * party that maps the deck's state to its panes ([L10]), because only that
 * party knows where they live: a pane's own write once landed on an element
 * the frames no longer read, and the drag went dead without an error.
 *
 * **The drag says what it is doing** ([B09], [B12]). At the press every member
 * is marked `data-rail-held`, which lights the rail's whole edge and gives its
 * border the accent; once the press is a drag a readout pill rides beside the
 * pointer showing the width the release would commit — composed here from the
 * host's aim and sent as the `readout` of `overlay.indication`, so the
 * overlay draws it above every card, the rail's own included ([B05]). Past a
 * limit the edge keeps following with diminishing returns (`aimRailWidth`),
 * the members are marked `data-rail-limit` and the readout reads the limit.
 * There are no catches between the limits ([B13]). The readout is taken down
 * however the drag ended, and the overlay fades it out.
 *
 * **The release commits, and the settle carries every card.** Nothing moved
 * while the hand was down, so at the commit the members and the content
 * cards beside the rail all stand at the press, and the settle the commit
 * runs is the one motion of the gesture: it plans each moved card's beats
 * from there to the committed width, and the host runs them with each page
 * that changes size pinned at its landing and clipped as it moves, so a
 * page's one repaint at its new width is hidden under the motion. For that
 * the member frames' `data-pointer-owned` comes off BEFORE the commit: the
 * settle skips a frame a pointer owns, at its arm inside the commit and
 * again in the layout effect after it, and a member skipped at the arm but
 * not after would be read as an arrival and faded in. The placer's hold
 * comes off with it; then `setRailWidth` commits the width the host aimed.
 * A release past a limit reaches here only when the host's spring of the
 * ghost lands, so the commit is the limit and nothing moves before it.
 *
 * **The rollback belongs to whoever wrote the draft** ([L32]). Every
 * acquisition the draft makes — the members' marks, the scroll-preservation
 * episodes, the placer's hold, the readout — is released by one idempotent
 * path that runs on commit, cancel and unmount alike ([L27]).
 *
 * The bounds are the rail's own, read from the deck (`railWidthLimits`): its
 * tightest member's floor and the allocator's slim ceiling, which the host
 * reads from the placement. The edge snaps to other panes' edges with Option
 * held, as every pane edge does, in the host's arithmetic, and the guides it
 * snapped to ride its report into the overlay. [D01, D03, D04]
 *
 * @module components/chrome/rail-width-draft
 */

import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  type RefObject,
} from "react";

import type { IDeckManagerStore } from "@/deck-manager-store";
import { railMembersOf } from "@/deck-store-selectors";
import type { RailEdgeDriver } from "@/lib/host-card-gesture";
import { pageZoomFactor } from "@/lib/page-zoom-store";
import type { SidebarSide } from "@/lib/layout-imposer";
import { holdCardsForHost, releaseCardsHeldForHost } from "@/lib/card-placement";
import { indicate } from "@/lib/drag-indication";
import { RAIL_TRAVEL_ATTR, type RailWidthAim } from "@/lib/rail-width";
import {
  GESTURE_EPISODE_WINDOW_MS,
  beginResizeEpisode,
  type ResizeEpisodeHandle,
} from "@/lib/resize-episode";
import {
  SHOWN_PANE_FRAMES,
  SPACE_LAYER_CLASS,
  SPACE_SHOWN_ATTRIBUTE,
} from "@/components/chrome/space-layer";

/** What the pane hands over at pointer-down. */
export interface RailWidthGestureBegin {
  readonly side: SidebarSide;
  /** The frame whose edge was grabbed — the rail's measured width is read
   *  off it. */
  readonly frame: HTMLElement;
  /** Where the press landed. */
  readonly clientX: number;
  readonly clientY: number;
}

/**
 * The four calls a rail width drag is made of. `begin` at pointer-down;
 * `change` for every pointer move once the press has travelled past the move
 * threshold; then exactly one of `commit` (the release of a press that
 * travelled) or `cancel` (a release that never travelled, a lost capture, a
 * `pointercancel`, Escape, a pane torn down mid-drag). A `cancel` with no draft
 * open is a no-op, so an emitter may call it on every path out. `change` and
 * `commit` carry the aim the host read from the hand, which is what the
 * readout shows and the commit commits.
 */
export interface RailWidthGesture {
  begin(start: RailWidthGestureBegin): void;
  change(clientX: number, clientY: number, altKey: boolean, aim: RailWidthAim): void;
  commit(clientX: number, altKey: boolean, aim: RailWidthAim): void;
  cancel(): void;
}

/** The draft owner, as `DeckCanvas` provides it to the panes it renders. */
export const RailWidthGestureContext = createContext<RailWidthGesture | null>(
  null,
);

/** The rail width gesture of the deck this pane stands in, or `null` outside
 *  one. */
export function useRailWidthGesture(): RailWidthGesture | null {
  return useContext(RailWidthGestureContext);
}

/** Every element of the shown deck, and none under a hidden layer. */
const SHOWN = `:not(.${SPACE_LAYER_CLASS}:not([${SPACE_SHOWN_ATTRIBUTE}]) *)`;

/** A rail's members while a hand holds its edge: lights the edge and the
 *  rail's border. */
const HELD_ATTR = "data-rail-held";
/** A rail's members while the hand presses past a limit: the caution tint. */
const LIMIT_ATTR = "data-rail-limit";

interface Draft {
  readonly side: SidebarSide;
  readonly members: readonly HTMLElement[];
  /** The panes beside the rail whose cards a width change moves: every one
   *  carrying a travel. */
  readonly carriedPanes: readonly Element[];
  readonly episodes: readonly ResizeEpisodeHandle[];
  latched: boolean;
  latestX: number;
  latestY: number;
  /** The aim the host last reported: what the readout shows and the release commits. */
  aim: RailWidthAim;
  rafId: number | null;
  /** The limit the members were last marked past. */
  limit: RailWidthAim["limit"];
  /** Whether the overlay is showing this drag's readout. */
  readout: boolean;
}

/**
 * The draft owner for one deck canvas. One instance per canvas, kept for the
 * store's life; at most one draft is open at a time, and a `begin` over an
 * open one cancels it first.
 */
class RailWidthDraft implements RailWidthGesture {
  private draft: Draft | null = null;

  constructor(
    private readonly canvasRef: RefObject<HTMLElement | null>,
    private readonly store: IDeckManagerStore,
  ) {}

  begin({ side, frame, clientX, clientY }: RailWidthGestureBegin): void {
    this.cancel();
    const container = this.canvasRef.current;
    const limits = this.store.railWidthLimits(side);
    // Neither can be missing while a hand presses a rail's edge: the canvas
    // renders every pane that has one, and a pane exposes the edge only while
    // the deck stands it on `side`. A press that finds either missing is a
    // broken deck, and says so rather than holding the pointer over nothing
    // ([L31]).
    if (container === null) {
      throw new Error("rail width drag: pressed a rail edge with no deck canvas mounted");
    }
    if (limits === null) {
      throw new Error(`rail width drag: pressed the ${side} rail's edge, but the deck stands no rail there`);
    }

    // Opened at pointer-down, while the pre-gesture layout is still on
    // screen: the band every card rides is inset by this width, so every
    // shown frame may move under the edge and every one gets an episode. A
    // press that never travels closes them having changed nothing.
    const episodes = [
      ...container.querySelectorAll<HTMLElement>(SHOWN_PANE_FRAMES),
    ].map((paneFrame) =>
      beginResizeEpisode(paneFrame, GESTURE_EPISODE_WINDOW_MS),
    );

    const members = [
      ...container.querySelectorAll<HTMLElement>(
        `${SHOWN_PANE_FRAMES}[data-rail-side="${side}"]`,
      ),
    ];
    const carriedPanes = new Set<Element>();
    for (const el of container.querySelectorAll<HTMLElement>(
      `[${RAIL_TRAVEL_ATTR}]${SHOWN}`,
    )) {
      const pane = el.closest(".tug-pane");
      if (pane !== null) carriedPanes.add(pane);
    }
    // The width the RAIL stands at — its widest member's — measured, since
    // the grabbed member's stored width may be narrower than the rail.
    const startWidth = frame.getBoundingClientRect().width / pageZoomFactor();
    this.draft = {
      side,
      members,
      carriedPanes: [...carriedPanes],
      episodes,
      latched: false,
      latestX: clientX,
      latestY: clientY,
      aim: { width: startWidth, shown: startWidth, limit: null },
      rafId: null,
      limit: null,
      readout: false,
    };
    // Grabbed: the rail reads as held from the press, before it moves.
    for (const el of members) el.setAttribute(HELD_ATTR, "");
  }

  change(clientX: number, clientY: number, _altKey: boolean, aim: RailWidthAim): void {
    const draft = this.draft;
    if (draft === null) return;
    draft.latestX = clientX;
    draft.latestY = clientY;
    draft.aim = aim;
    this.latch(draft);
    // [L13]: a gesture frame loop is what rAF is for; the pointer may report
    // several times a frame, and the feedback is written once per frame.
    if (draft.rafId === null) {
      draft.rafId = requestAnimationFrame(() => {
        draft.rafId = null;
        if (this.draft !== draft) return;
        this.show(draft, draft.aim);
      });
    }
  }

  commit(clientX: number, _altKey: boolean, aim: RailWidthAim): void {
    const draft = this.draft;
    if (draft === null) return;
    draft.latestX = clientX;
    draft.aim = aim;
    // The emitter calls `commit` only for a press that travelled, and it
    // judges that from the release's own position — so a release can arrive
    // with no move before it, when the event merger folded every move into
    // it. That is still a drag, and it latches here.
    this.latch(draft);
    // The readout's last word is the width the release commits.
    this.writeReadout(draft, { ...aim, limit: null });
    this.dropReadout(draft);
    this.land(draft, aim.width);
  }

  cancel(): void {
    const draft = this.draft;
    if (draft === null) return;
    this.release(draft);
  }

  /** The canvas is going: any open draft is cancelled, its readout with it. */
  dispose(): void {
    this.cancel();
  }

  /** The commit proper: the marks and the hold come off, and the store
   *  commits `width`. */
  private land(draft: Draft, width: number): void {
    try {
      // Off before the commit, so the settle's arm measures the members where
      // they stand rather than skipping them (see the module docblock).
      for (const el of draft.members) el.removeAttribute("data-pointer-owned");
      // And the host's hold, so the commit's placement names every card
      // where it now stands.
      releaseCardsHeldForHost();
      this.store.setRailWidth(draft.side, width);
    } finally {
      this.release(draft);
    }
  }

  /** The press has become a drag: the acquisitions a drag makes beyond a
   *  press, once. */
  private latch(draft: Draft): void {
    if (draft.latched) return;
    draft.latched = true;
    // The rail's frames are the hand's from here: a settle landing mid-drag
    // skips them, as it skips any frame a pointer is positioning.
    for (const el of draft.members) el.setAttribute("data-pointer-owned", "true");
    // Every card of the rail's panes and of the panes beside it, inactive
    // siblings included, is posted as it stood at the press until the release.
    holdCardsForHost(cardsMovedBy(draft));
    // The readout rides beside the pointer for as long as the hand drags.
    draft.readout = true;
  }

  /**
   * Every acquisition `begin` and the latch made, given back. Idempotent.
   */
  private release(draft: Draft): void {
    if (this.draft !== draft) return;
    this.draft = null;
    if (draft.rafId !== null) {
      cancelAnimationFrame(draft.rafId);
      draft.rafId = null;
    }
    for (const el of draft.members) {
      el.removeAttribute(HELD_ATTR);
      el.removeAttribute(LIMIT_ATTR);
    }
    releaseCardsHeldForHost();
    this.dropReadout(draft);
    if (draft.latched) {
      for (const el of draft.members) el.removeAttribute("data-pointer-owned");
    }
    for (const episode of draft.episodes) episode.end();
  }

  /** The feedback that says where the release would land: the limit marks
   *  and the readout. */
  private show(draft: Draft, aim: RailWidthAim): void {
    if (aim.limit !== draft.limit) {
      for (const el of draft.members) {
        if (aim.limit === null) el.removeAttribute(LIMIT_ATTR);
        else el.setAttribute(LIMIT_ATTR, aim.limit);
      }
      draft.limit = aim.limit;
    }
    this.writeReadout(draft, aim);
  }

  /** The readout's text and place: the width the release would commit, at
   *  the pointer, in the viewport points the host reported it in. */
  private writeReadout(draft: Draft, aim: RailWidthAim): void {
    if (!draft.readout) return;
    indicate({
      readout: { x: draft.latestX, y: draft.latestY, text: `${Math.round(aim.width)} px`, limit: aim.limit },
    });
  }

  /** The readout let go: the overlay fades what it last showed. */
  private dropReadout(draft: Draft): void {
    if (!draft.readout) return;
    draft.readout = false;
    indicate({ readout: null });
  }
}

/** Every card a width change of `draft`'s rail moves: each card of a
 *  member's pane and of each carried pane, siblings included. */
function cardsMovedBy(draft: Draft): Set<string> {
  const panes = new Set<Element>([...draft.members, ...draft.carriedPanes]);
  const ids = new Set<string>();
  for (const pane of panes) {
    for (const el of pane.querySelectorAll<HTMLElement>("[data-body-placeholder][data-card-id]")) {
      if (el.dataset.cardId !== undefined) ids.add(el.dataset.cardId);
    }
  }
  return ids;
}

/**
 * The rail width draft for the deck canvas at `canvasRef`, stable for the
 * store's life. A draft open when the canvas unmounts is cancelled.
 */
export function useRailWidthDraft(
  canvasRef: RefObject<HTMLElement | null>,
  store: IDeckManagerStore,
): RailWidthGesture {
  const draft = useMemo(
    () => new RailWidthDraft(canvasRef, store),
    [canvasRef, store],
  );
  useLayoutEffect(() => () => draft.dispose(), [draft]);
  return draft;
}

/**
 * The rail width drag a rail card's own page starts, for the pane `paneId`
 * of `deck`, or null when that pane is not a pinned rail's or its frame is
 * not in the document.
 *
 * The card takes the press on its edge grip in its own page and the host
 * tracks the pointer (`lib/host-card-gesture.ts`). The drag is still
 * `draft`'s, opened against the shell's frame for the pane (`frameOf`), so
 * the release commits one width for every member of the side. The host owns
 * the press and its Escape; this owns only the frame's `data-gesture` mark,
 * and gives the draft back if the frame leaves the document mid-drag.
 */
export function railEdgeDriverFor(
  deck: Pick<IDeckManagerStore, "getSnapshot">,
  draft: RailWidthGesture,
  paneId: string,
  frameOf: (paneId: string) => HTMLElement | null,
): RailEdgeDriver | null {
  const state = deck.getSnapshot();
  const side = (["left", "right"] as const).find((s) =>
    railMembersOf(state, s).some((m) => m.paneId === paneId),
  );
  if (side === undefined) return null;
  const frame = frameOf(paneId);
  if (frame === null) return null;
  const end = (): void => frame.removeAttribute("data-gesture");
  const gone = (): boolean => {
    if (frame.isConnected) return false;
    end();
    draft.cancel();
    return true;
  };
  return {
    begin: (clientX, clientY) => {
      draft.begin({ side, frame, clientX, clientY });
      frame.setAttribute("data-gesture", "resize");
    },
    change: (clientX, clientY, altKey, aim) => {
      if (!gone()) draft.change(clientX, clientY, altKey, aim);
    },
    commit: (clientX, altKey, aim) => {
      if (gone()) return;
      end();
      draft.commit(clientX, altKey, aim);
    },
    cancel: () => {
      end();
      draft.cancel();
    },
  };
}
