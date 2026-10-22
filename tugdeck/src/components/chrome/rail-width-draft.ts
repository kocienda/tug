/**
 * rail-width-draft.ts — the rail width drag's draft, owned by `DeckCanvas`.
 *
 * Dragging a sidebar rail's deck-facing edge is a mutation transaction whose
 * draft is one side's width ([L08]): the hand moves the rail live, and only
 * the release crosses into state, as one `setRailWidth` for every member of
 * the side. A drag the system takes away — a lost pointer capture, a
 * `pointercancel`, Escape — commits nothing and puts the deck back where the
 * record says it stands.
 *
 * **The host carries the views; this previews the shell at the host's aim.**
 * Every card's view is the host's, so the host moves the rail's members and
 * the content cards beside it from the pointer, and reports with each step
 * the aim it drew them at (`lib/host-card-gesture.ts`): the width the
 * release commits, the width the edge is drawn at, and the limit it presses
 * past. Each `change` and the `commit` hand that aim in, and everything here
 * is drawn at it — so the shell computes no width and no snap of its own,
 * and the stand-ins stand under the views. While the drag holds, the placer
 * posts the cards the host is moving as they stood at the press
 * (`holdCardsForHost`); the hold is released before the commit, so the
 * commit's placement names every card where it now stands.
 *
 * **Two layers, one writer each.** The pane whose edge was grabbed translates
 * pointer input into four calls — `begin`, `change`, `commit`, `cancel` — and
 * does nothing else: it writes no arrangement property, finds no canvas, and
 * clamps nothing. Everything the drag does to the deck is done here, by the
 * party that maps the deck's state to its panes and owns the arrangement's
 * custom properties ([L10]), because only that party knows where they live: a
 * pane's own write once landed on an element the frames no longer read, and
 * the drag went dead without an error.
 *
 * **The preview is graded by what actually moves** — and the rail's width
 * property is NOT what it writes. That property is inherited, so a write of
 * it on the canvas or a layer restyles every card in the deck, transcripts
 * included, every frame. Instead each element is moved by the cheapest write
 * that puts it where the committed width will:
 *
 *  - the rail's own frames, and the seams of a split rail, are pinned inline
 *    to a px `width` (and, on a right rail, the `left` its pinned edge implies),
 *    with `contain: layout` keeping each frame's reflow inside it — the
 *    pattern a seam drag pins its members by;
 *  - the rail's shadow strip moves by `translate`, compositor only;
 *  - every imposed element — the content frames, the held-open vacancies, a
 *    split column's seams — moves by `translate`, by exactly the distance its
 *    own `left` expression would move (`railTravelShift`, over the travel
 *    each one carries stamped beside its style). A fit card's width is its
 *    own and does not change, so nothing about it reflows at all.
 *
 * **Content that cannot reflow in a frame waits for the hand to rest**
 * ([B11]). A member whose registration says `railReflow: "pause"` — stamped
 * on its frame as `data-rail-reflow` — has its body held at the width it last
 * laid out at while the frame tracks the hand: anchored to the rail's outer
 * edge (`align-self`) and clipped by the frame's own chrome. Once the hand
 * has rested `RAIL_REFLOW_PAUSE_MS`, the hold moves to the width the frame
 * now stands at — one reflow, while nothing else is moving — and the release
 * lets it go with the rest of the preview. A member whose reflow is cheap is
 * never held and reflows every frame.
 *
 * **The drag says what it is doing** ([B09], [B12]). At the press every member
 * is marked `data-rail-held`, which lights the rail's whole edge and gives its
 * border the accent; once the press is a drag a readout pill rides beside the
 * pointer showing the width the release would commit. Past a limit the edge
 * keeps following with diminishing returns (`aimRailWidth`), the members are
 * marked `data-rail-limit` and the readout reads the limit, and the release
 * springs the edge back to it — the one motion a release makes, a TugAnimator
 * tween of the same elements the preview moves, ending on the pose the commit
 * stands them at, so it still lands with nothing left to move. Its commit
 * carries a deadline, so a window whose frames have stopped still lands it.
 * There are no catches between the limits ([B13]). The readout fades once the
 * hand lets go, and is removed by this owner however the drag ended.
 *
 * **The release has nothing left to move** ([B08]). At the commit the width
 * property goes onto the canvas and the shown layer, and every pin and
 * translate comes off, in one task: the geometry the properties now resolve
 * to is the geometry the preview was showing, so no frame paints a jump. Only
 * then does `setRailWidth` commit, so whatever the settle measures as its
 * first rect is already the last. The member frames' `data-pointer-owned`
 * comes off BEFORE the commit, as a seam drag's does: the settle looks for it
 * twice — at the arm, inside the commit, and in the layout effect of the
 * render the commit causes, which the gesture scope holds past the next
 * paint — and a frame the arm skipped but the later look does not is read as
 * an ARRIVAL, held invisible and faded back up. Cleared first, every member
 * gets a First rect equal to its Last, and the settle carries it nowhere.
 *
 * **The rollback belongs to whoever wrote the draft** ([L32]). Every inline
 * style this writes is saved first and given back on cancel; every
 * acquisition it makes — the members' marks, the
 * scroll-preservation episodes, the placer's hold — is released by one
 * idempotent path that runs on commit, cancel and unmount alike ([L27]).
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
import { getTugTiming, isTugMotionEnabled } from "@/lib/scale-timing";
import { pageZoomFactor } from "@/lib/page-zoom-store";
import { sidebarWidthProperty, type SidebarSide } from "@/lib/layout-imposer";
import { holdCardsForHost, releaseCardsHeldForHost } from "@/lib/card-placement";
import {
  LIMIT_SPRING_EASING,
  LIMIT_SPRING_MS,
  RAIL_REFLOW_ATTR,
  RAIL_REFLOW_PAUSE_MS,
  RAIL_TRAVEL_ATTR,
  parseRailTravel,
  railTravelShift,
  type RailTravel,
  type RailTravelBand,
  type RailWidthAim,
  type ReadFlowTerms,
} from "@/lib/rail-width";
import {
  GESTURE_EPISODE_WINDOW_MS,
  beginResizeEpisode,
  type ResizeEpisodeHandle,
} from "@/lib/resize-episode";
import { group } from "@/components/tugways/tug-animator";
import { landByDeadline } from "@/lib/land-by-deadline";
import { cardRailHold } from "@/bus/declarations/card";
import {
  SHOWN_PANE_FRAMES,
  SPACE_LAYER_CLASS,
  SPACE_SHOWN_ATTRIBUTE,
} from "@/components/chrome/space-layer";

/** What the pane hands over at pointer-down. */
export interface RailWidthGestureBegin {
  readonly side: SidebarSide;
  /** The frame whose edge was grabbed — the rail's measured width and its
   *  pinned edge are read off it. */
  readonly frame: HTMLElement;
  /** Where the press landed; every later width is the start width plus the
   *  pointer's travel from here. */
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
 * `commit` carry the aim the host drew the rail at, which is what the preview
 * draws and the commit commits.
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

export type { ReadFlowTerms } from "@/lib/rail-width";

/** Every element of the shown deck, and none under a hidden layer. */
const SHOWN = `:not(.${SPACE_LAYER_CLASS}:not([${SPACE_SHOWN_ATTRIBUTE}]) *)`;

/** A rail's members while a hand holds its edge: lights the edge and the
 *  rail's border. */
const HELD_ATTR = "data-rail-held";
/** A rail's members while the hand presses past a limit: the caution tint. */
const LIMIT_ATTR = "data-rail-limit";
/** The readout pill beside the pointer. */
const READOUT_CLASS = "tug-rail-readout";
/** How long the readout takes to fade once the hand lets go, at a timing of
 *  1. Stated here only: the readout carries it as `--tugx-rail-readout-fade`,
 *  which the stylesheet's transition reads and scales by `--tug-timing`. */
const READOUT_FADE_MS = 400;
/** How far past the spring's scaled duration its commit waits before landing
 *  anyway, for a window whose frames have stopped. */
const LIMIT_SPRING_DEADLINE_SLACK_MS = 100;
/** How many steps a carried element's spring is sampled in. Its travel is
 *  piecewise linear in the rail's width, so a two-keyframe tween would cut
 *  across the kinks a clamp puts in it. */
const LIMIT_SPRING_SAMPLES = 8;

/** The inline properties the preview writes, saved as it found them. */
const PINNED_PROPERTIES = ["width", "left", "contain"] as const;

/** An element pinned to the rail: a member frame or a split rail's seam. */
interface Pinned {
  readonly el: HTMLElement;
  readonly left0: number;
  readonly saved: Readonly<Record<(typeof PINNED_PROPERTIES)[number], string>>;
  /** A member frame takes `contain: layout`; a seam has no interior. */
  readonly contain: boolean;
}

/** An element moved by `translate`: an imposed one, or the rail's shadow. */
interface Carried {
  readonly el: HTMLElement;
  /** Its travel, or `null` for the shadow, which moves with the rail edge. */
  readonly travel: RailTravel | null;
  readonly savedTranslate: string;
}

/** A member whose content waits for the hand to rest. */
interface Held {
  /** The press has become a drag: hold the content at the width it stands at, anchored to the rail's outer edge. */
  latch(side: SidebarSide): void;
  /** Lay the content out for a frame `width` layout px wide. */
  hold(width: number): void;
  /** Give the content back to its frame. */
  restore(): void;
}

/**
 * A member's card draws its chrome in its own page: the frame here is a
 * stand-in, and the content is the card's page's. The hold is said to the
 * card (`card.railHold`), whose page lays its content out at it.
 */
function heldCard(cardId: string, frame: HTMLElement): Held {
  const width0 = frame.offsetWidth;
  let side: SidebarSide = "left";
  return {
    latch(s) {
      side = s;
      cardRailHold.setFor(cardId, { side, width: width0 });
    },
    hold(width) {
      cardRailHold.setFor(cardId, { side, width });
    },
    restore() {
      cardRailHold.setFor(cardId, null);
    },
  };
}

interface Draft {
  readonly side: SidebarSide;
  readonly container: HTMLElement;
  readonly zoom: number;
  readonly growSign: 1 | -1;
  readonly startWidth: number;
  readonly canvasBounds: DOMRect;
  readonly band: RailTravelBand;
  readonly members: readonly HTMLElement[];
  readonly pinned: readonly Pinned[];
  readonly carried: readonly Carried[];
  readonly held: readonly Held[];
  /** Where the arrangement's width property lives for the shown deck. */
  readonly propertyTargets: readonly HTMLElement[];
  readonly episodes: readonly ResizeEpisodeHandle[];
  latched: boolean;
  latestX: number;
  latestY: number;
  /** The aim the host last reported: what the preview draws and the release commits. */
  aim: RailWidthAim;
  rafId: number | null;
  /** The rest that reflows the held members, re-armed by every move. */
  pauseTimer: ReturnType<typeof setTimeout> | null;
  /** The width the edge was last drawn at, and the limit it was past. */
  shown: number;
  limit: RailWidthAim["limit"];
  /** A release past a limit springing back, and the width it lands. */
  spring: { width: number; landNow: () => void } | null;
  readout: HTMLElement | null;
}

/**
 * The draft owner for one deck canvas. One instance per canvas, kept for the
 * store's life; at most one draft is open at a time, and a `begin` over an
 * open one cancels it first.
 */
class RailWidthDraft implements RailWidthGesture {
  private draft: Draft | null = null;
  /** Readouts fading after their drag ended, removed when the fade is done
   *  or the canvas unmounts. */
  private readonly leaving = new Map<HTMLElement, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly canvasRef: RefObject<HTMLElement | null>,
    private readonly store: IDeckManagerStore,
    private readonly readFlow: ReadFlowTerms,
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

    const zoom = pageZoomFactor();
    const canvasBounds = container.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const members = [
      ...container.querySelectorAll<HTMLElement>(
        `${SHOWN_PANE_FRAMES}[data-rail-side="${side}"]`,
      ),
    ];
    const seams = [
      ...container.querySelectorAll<HTMLElement>(
        `.tug-place-seam[data-rail-seam^="${side}:"]`,
      ),
    ];
    // `offsetLeft` is layout px in the frames' own containing block, which is
    // the unit and the origin an inline `left` is written in, at every zoom.
    const pin = (el: HTMLElement, contain: boolean): Pinned => ({
      el,
      left0: el.offsetLeft,
      saved: {
        width: el.style.width,
        left: el.style.left,
        contain: el.style.contain,
      },
      contain,
    });
    const carry = (el: HTMLElement, travel: RailTravel | null): Carried => ({
      el,
      travel,
      savedTranslate: el.style.translate,
    });
    const carried: Carried[] = [];
    for (const el of container.querySelectorAll<HTMLElement>(
      `[${RAIL_TRAVEL_ATTR}]${SHOWN}`,
    )) {
      const travel = parseRailTravel(el.getAttribute(RAIL_TRAVEL_ATTR));
      if (travel !== null) carried.push(carry(el, travel));
    }
    const held: Held[] = [];
    for (const el of members) {
      if (!el.hasAttribute(RAIL_REFLOW_ATTR)) continue;
      const paneId = el.dataset.paneId;
      const cardId = this.store.getSnapshot().panes.find((p) => p.id === paneId)?.activeCardId;
      if (cardId !== undefined) held.push(heldCard(cardId, el));
    }

    // The width the RAIL stands at — its widest member's — measured, since
    // the grabbed member's stored width may be narrower than the rail.
    const startWidth = frameRect.width / zoom;
    this.draft = {
      side,
      container,
      zoom,
      // A left rail's deck edge faces right: rightward motion grows it. A
      // right rail's faces left: leftward motion grows it.
      growSign: side === "left" ? 1 : -1,
      startWidth,
      canvasBounds,
      // Signed: a rail widened until the rails cover the canvas leaves a band
      // of no width, and that rail must still narrow back. The travel terms
      // clamp a band below zero exactly as the `left` expressions do.
      band: { band: this.store.getBandSpan(), flow: this.readFlow() },
      members,
      pinned: [
        ...members.map((el) => pin(el, true)),
        ...seams.map((el) => pin(el, false)),
      ],
      carried,
      held,
      // The canvas, for the seams, caps and shadows outside every layer, and
      // the shown layer's wrapper, whose own copy its frames inherit.
      propertyTargets: [
        container,
        ...container.querySelectorAll<HTMLElement>(
          `.${SPACE_LAYER_CLASS}[${SPACE_SHOWN_ATTRIBUTE}]`,
        ),
      ],
      episodes,
      latched: false,
      latestX: clientX,
      latestY: clientY,
      aim: { width: startWidth, shown: startWidth, limit: null },
      rafId: null,
      pauseTimer: null,
      shown: startWidth,
      limit: null,
      spring: null,
      readout: null,
    };
    // Grabbed: the rail reads as held from the press, before it moves.
    for (const el of members) el.setAttribute(HELD_ATTR, "");
  }

  change(clientX: number, clientY: number, _altKey: boolean, aim: RailWidthAim): void {
    const draft = this.draft;
    if (draft === null || draft.spring !== null) return;
    draft.latestX = clientX;
    draft.latestY = clientY;
    draft.aim = aim;
    this.latch(draft);
    // [L13]: a gesture frame loop is what rAF is for; the pointer may report
    // several times a frame, and the preview is written once per frame.
    if (draft.rafId === null) {
      draft.rafId = requestAnimationFrame(() => {
        draft.rafId = null;
        if (this.draft !== draft) return;
        this.preview(draft, draft.aim);
      });
    }
    // The held members reflow once the hand has rested; every move puts
    // that off again.
    if (draft.held.length > 0) {
      if (draft.pauseTimer !== null) clearTimeout(draft.pauseTimer);
      draft.pauseTimer = setTimeout(() => {
        draft.pauseTimer = null;
        if (this.draft !== draft) return;
        this.hold(draft, draft.aim.shown);
      }, RAIL_REFLOW_PAUSE_MS);
    }
  }

  commit(clientX: number, _altKey: boolean, aim: RailWidthAim): void {
    const draft = this.draft;
    if (draft === null || draft.spring !== null) return;
    draft.latestX = clientX;
    draft.aim = aim;
    // The emitter calls `commit` only for a press that travelled, and it
    // judges that from the release's own position — so a release can arrive
    // with no move before it, when the event merger folded every move into
    // it. That is still a drag, and it latches here.
    this.latch(draft);
    this.fadeReadout(draft, aim);
    if (draft.rafId !== null) {
      cancelAnimationFrame(draft.rafId);
      draft.rafId = null;
    }
    if (draft.pauseTimer !== null) {
      clearTimeout(draft.pauseTimer);
      draft.pauseTimer = null;
    }
    // Released past a limit: the edge springs back to it through the same
    // preview, and the commit lands when it arrives — so the release still
    // has nothing left to move. Under reduced motion, or a timing scale of
    // zero, there is no spring: the edge lands on the limit at once. The host
    // springs the views over the same span, from the `springMs` the body
    // page posted at the press.
    if (
      aim.limit !== null &&
      Math.abs(draft.shown - aim.width) > 0.5 &&
      isTugMotionEnabled() &&
      getTugTiming() > 0
    ) {
      this.springTo(draft, aim.width);
      return;
    }
    this.land(draft, aim.width);
  }

  cancel(): void {
    const draft = this.draft;
    if (draft === null) return;
    // The hand already let go of a springing edge: what it released is owed
    // its commit, whatever interrupts the spring.
    if (draft.spring !== null) {
      draft.spring.landNow();
      return;
    }
    this.fadeReadout(draft, null);
    // The host has put every view back where the press found it: the
    // placement after the restore says so of every card.
    releaseCardsHeldForHost();
    this.restore(draft);
    this.release(draft);
  }

  /** The canvas is going: any open draft is cancelled and every readout,
   *  fading or not, is removed now. */
  dispose(): void {
    this.cancel();
    for (const [el, timer] of this.leaving) {
      clearTimeout(timer);
      el.remove();
    }
    this.leaving.clear();
  }

  /** The commit proper: the width property takes `width`, the preview comes
   *  off, and the store commits — in one task. */
  private land(draft: Draft, width: number): void {
    try {
      // The hand-over: the property the arrangement resolves against takes
      // the width the preview was showing, and the preview comes off, in one
      // task — so the frames stand on the record before anything paints, and
      // before the commit's settle takes its first measurement.
      const property = sidebarWidthProperty(draft.side);
      for (const el of draft.propertyTargets) {
        el.style.setProperty(property, `${width}px`);
      }
      this.restore(draft);
      // Off before the commit, so the settle's arm measures the members where
      // they now stand rather than skipping them (see the module docblock).
      for (const el of draft.members) el.removeAttribute("data-pointer-owned");
      // And the host's hold, so the commit's placement names every card
      // where it now stands, and is posted though the preview read the same.
      releaseCardsHeldForHost();
      this.store.setRailWidth(draft.side, width);
    } finally {
      this.release(draft);
    }
  }

  /**
   * The edge sprung back from where it was drawn to `width`, then landed.
   *
   * Programmatic motion with a completion, so it is TugAnimator's ([L13]):
   * every pinned and carried element is tweened from the pose the preview
   * left it in to the pose `width` gives it. The commit lands on whichever
   * comes first of the spring finishing, the spring being cancelled, a
   * deadline just past its duration, or `cancel()` — so the store write, the
   * lifted marks and the closed brackets never wait on a frame that does not
   * come ([L31], [L32]). On every path but a natural finish the tweens are
   * stopped where they stand before the commit takes the preview off.
   */
  private springTo(draft: Draft, width: number): void {
    const from = draft.shown;
    // The limit's caution comes off as the edge starts back.
    this.preview(draft, { width, shown: from, limit: null });
    const motion = group({ duration: LIMIT_SPRING_MS, easing: LIMIT_SPRING_EASING });
    for (const p of draft.pinned) {
      motion.animate(
        p.el,
        [from, width].map((w): Keyframe =>
          draft.side === "right"
            ? { width: `${w}px`, left: `${p.left0 - (w - draft.startWidth)}px` }
            : { width: `${w}px` },
        ),
      );
    }
    for (const c of draft.carried) {
      const frames: Keyframe[] = [];
      for (let i = 0; i <= LIMIT_SPRING_SAMPLES; i++) {
        const w = from + ((width - from) * i) / LIMIT_SPRING_SAMPLES;
        frames.push({ translate: `${carriedShift(draft, c, w - draft.startWidth)}px 0px` });
      }
      motion.animate(c.el, frames);
    }
    const landNow = landByDeadline(
      motion.finished,
      LIMIT_SPRING_MS * getTugTiming() + LIMIT_SPRING_DEADLINE_SLACK_MS,
      (cause) => {
        if (this.draft !== draft) return;
        if (cause !== "finished") motion.cancel("hold-at-current");
        draft.spring = null;
        this.land(draft, width);
      },
    );
    draft.spring = { width, landNow };
  }

  /** The press has become a drag: the acquisitions a drag makes beyond a
   *  press, once. */
  private latch(draft: Draft): void {
    if (draft.latched) return;
    draft.latched = true;
    // The rail's frames are the hand's from here: a settle landing mid-drag
    // skips them, as it skips any frame a pointer is positioning.
    for (const el of draft.members) el.setAttribute("data-pointer-owned", "true");
    // The content that cannot follow the hand is held where it stands,
    // anchored to the edge the rail does not move.
    for (const h of draft.held) h.latch(draft.side);
    // The host is moving every card of the rail's panes and of the panes
    // beside it, inactive siblings included: the placer posts them as they
    // stood at the press until the release.
    holdCardsForHost(cardsMovedBy(draft));
    // The readout rides beside the pointer for as long as the hand drags.
    const readout = document.createElement("div");
    readout.className = READOUT_CLASS;
    readout.style.setProperty("--tugx-rail-readout-fade", `${READOUT_FADE_MS}ms`);
    readout.setAttribute("aria-hidden", "true");
    draft.container.appendChild(readout);
    draft.readout = readout;
  }

  /** Every inline style the preview wrote, given back as it was found. */
  private restore(draft: Draft): void {
    for (const p of draft.pinned) {
      for (const property of PINNED_PROPERTIES) {
        p.el.style.setProperty(property, p.saved[property]);
      }
    }
    for (const c of draft.carried) c.el.style.translate = c.savedTranslate;
    for (const h of draft.held) h.restore();
    for (const el of draft.members) el.removeAttribute(LIMIT_ATTR);
  }

  /** The held members laid out at the width the rail now stands at: the
   *  one reflow they take, made while the hand rests. */
  private hold(draft: Draft, width: number): void {
    for (const h of draft.held) h.hold(width);
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
    if (draft.pauseTimer !== null) {
      clearTimeout(draft.pauseTimer);
      draft.pauseTimer = null;
    }
    for (const el of draft.members) {
      el.removeAttribute(HELD_ATTR);
      el.removeAttribute(LIMIT_ATTR);
    }
    releaseCardsHeldForHost();
    if (draft.readout !== null) this.fadeReadout(draft, null);
    if (draft.latched) {
      for (const el of draft.members) el.removeAttribute("data-pointer-owned");
    }
    for (const episode of draft.episodes) episode.end();
  }

  /** The deck as it will stand at the aim's drawn width, written by the
   *  cheapest means each element allows — and the feedback that says where
   *  the release would land. */
  private preview(draft: Draft, aim: RailWidthAim): void {
    const width = aim.shown;
    const growth = width - draft.startWidth;
    draft.shown = width;
    if (aim.limit !== draft.limit) {
      for (const el of draft.members) {
        if (aim.limit === null) el.removeAttribute(LIMIT_ATTR);
        else el.setAttribute(LIMIT_ATTR, aim.limit);
      }
      draft.limit = aim.limit;
    }
    this.writeReadout(draft, aim);
    for (const p of draft.pinned) {
      p.el.style.width = `${width}px`;
      // A right rail is pinned by its right edge, so its left edge is what
      // moves as it grows.
      if (draft.side === "right") p.el.style.left = `${p.left0 - growth}px`;
      if (p.contain) p.el.style.contain = "layout";
    }
    for (const c of draft.carried) {
      c.el.style.translate = `${carriedShift(draft, c, growth)}px 0px`;
    }
  }

  /** The readout's text and place: the width the release would commit, a
   *  little above and beside the pointer. */
  private writeReadout(draft: Draft, aim: RailWidthAim): void {
    const readout = draft.readout;
    if (readout === null) return;
    readout.textContent = `${Math.round(aim.width)} px`;
    if (aim.limit === null) readout.removeAttribute("data-limit");
    else readout.setAttribute("data-limit", aim.limit);
    const x = (draft.latestX - draft.canvasBounds.left) / draft.zoom;
    const y = (draft.latestY - draft.canvasBounds.top) / draft.zoom;
    readout.style.left = `${x + 14}px`;
    readout.style.top = `${y - 34}px`;
  }

  /** The readout let go: it shows `aim` (or what it last showed), fades, and
   *  is removed once the fade is done. */
  private fadeReadout(draft: Draft, aim: RailWidthAim | null): void {
    const readout = draft.readout;
    if (readout === null) return;
    draft.readout = null;
    if (aim !== null) {
      readout.textContent = `${Math.round(aim.width)} px`;
      readout.removeAttribute("data-limit");
    }
    readout.setAttribute("data-leaving", "");
    const timer = setTimeout(
      () => {
        this.leaving.delete(readout);
        readout.remove();
      },
      READOUT_FADE_MS * getTugTiming() + 50,
    );
    this.leaving.set(readout, timer);
  }
}

/** Every card whose view the host moves in `draft`'s drag: each card of a
 *  member's pane and of each carried element's pane, siblings included. */
function cardsMovedBy(draft: Draft): Set<string> {
  const panes = new Set<Element>(draft.members);
  for (const c of draft.carried) {
    const pane = c.el.closest(".tug-pane");
    if (pane !== null) panes.add(pane);
  }
  const ids = new Set<string>();
  for (const pane of panes) {
    for (const el of pane.querySelectorAll<HTMLElement>("[data-body-placeholder][data-card-id]")) {
      if (el.dataset.cardId !== undefined) ids.add(el.dataset.cardId);
    }
  }
  return ids;
}

/** How far a carried element stands from its own place when the rail has
 *  grown by `growth`: a shadow strip moves with the edge, an imposed element
 *  by what its own `left` expression gives. */
function carriedShift(draft: Draft, c: Carried, growth: number): number {
  return c.travel === null
    ? draft.growSign * growth
    : railTravelShift(c.travel, draft.side, draft.band, growth);
}

/**
 * The rail width draft for the deck canvas at `canvasRef`, stable for the
 * store's life. A draft open when the canvas unmounts is cancelled.
 */
export function useRailWidthDraft(
  canvasRef: RefObject<HTMLElement | null>,
  store: IDeckManagerStore,
  readFlow: ReadFlowTerms,
): RailWidthGesture {
  const draft = useMemo(
    () => new RailWidthDraft(canvasRef, store, readFlow),
    [canvasRef, store, readFlow],
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
 * every member of the side moves with the hand and the release commits one
 * width. The host owns the press and its Escape; this owns only the frame's
 * `data-gesture` mark, and gives the draft back if the frame leaves the
 * document mid-drag.
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
