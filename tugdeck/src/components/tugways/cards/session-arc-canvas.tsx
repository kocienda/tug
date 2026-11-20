/**
 * SessionArcCanvas — the free canvas in the arc shade: an arc's four cards,
 * Idea, Sketch, Brief and Arc, and the connectors between them.
 *
 * The canvas scrolls inside the shade's body and is as large as it has to be
 * to hold wherever the cards have been put. Each card is placed by `left` and
 * `top`. A card can be dragged by pointer once the press has moved a few
 * pixels, comes to the front of the others when it is pressed, and opens
 * wider to show its body; an open card pushes the cards to its right along.
 * A card marked full is always open, and its body fills it edge to edge.
 * The three connectors are drawn in one SVG beneath every card, and each card
 * owns the ports the connectors meet, so a port stacks with its card.
 *
 * Where the cards stand and which are open is the arc's remembered canvas
 * (`use-arc-canvas-state`), kept per arc name. A drop, an open and a close
 * each write it; the header's Tidy writes it from outside. While a card is in
 * hand nothing is written and nothing re-renders: the positions, the
 * connector paths and the canvas's size go straight to the DOM.
 *
 * What each card says is the caller's: a title, a state, and optionally
 * detail that always shows and a body that shows when the card is open.
 * Composes `TugIconButton`, which keeps its own tokens.
 *
 * Laws: [L02] the remembered canvas enters through `useTugbankValue`,
 *       [L03] placement runs in layout effects, [L06] a drag writes geometry
 *       to the DOM and never to React state, [L16] pairings declared,
 *       [L19] component authoring guide, [L20] composed children keep their
 *       tokens, [L22] the cards are observed for size and re-placed directly
 */

import "./session-arc-canvas.css";

import React, { useCallback, useLayoutEffect, useRef } from "react";
import { Maximize2, Minimize2 } from "lucide-react";

import { TugIconButton } from "@/components/tugways/tug-icon-button";
import {
  ARC_CANVAS_RUNGS,
  arcCanvasExtent,
  arcConnectorPath,
  clampToArcCanvas,
  layoutArcCanvas,
  type ArcCanvasLinkState,
  type ArcCanvasPoint,
  type ArcCanvasRung,
} from "@/lib/arc-canvas-geometry";
import { pageZoomFactor } from "@/lib/page-zoom-store";
import { readArcCanvasState, useArcCanvasState, writeArcCanvasState } from "@/lib/use-arc-canvas-state";

/** How far, in viewport pixels, a press has to move before it is a drag. */
const DRAG_THRESHOLD_PX = 4;

/** What a press on a card must not start a drag from: the card's own controls. */
const CONTROL_SELECTOR = 'button, input, textarea, a, [role="button"], [contenteditable="true"]';

/** The name each card wears in its header. */
const RUNG_LABELS: Record<ArcCanvasRung, string> = {
  idea: "Idea",
  sketch: "Sketch",
  brief: "Brief",
  arc: "Arc",
};

/** What one card says. */
export interface SessionArcCanvasCard {
  /**
   * Where the rung is: `done` is settled, `active` is where the work is, and
   * `pending` is a seat nothing fills yet.
   * @selector [data-state]
   */
  state: "done" | "active" | "pending";
  /** The card's heading. */
  title: string;
  /** What the card says at rest, under its title. */
  detail?: React.ReactNode;
  /** What the card shows when it is open. With none, the card does not open. */
  body?: React.ReactNode;
  /**
   * The card is always at full size: it has no collapse, wears no title of
   * its own, and its body fills it edge to edge. For a body that is a whole
   * surface in its own right and says its own heading.
   * @selector [data-full="true"]
   */
  full?: boolean;
}

export interface SessionArcCanvasProps {
  /** The arc whose canvas this is; its remembered layout is kept under this name. */
  arcName: string;
  /** The four cards' content. */
  cards: Readonly<Record<ArcCanvasRung, SessionArcCanvasCard>>;
  /**
   * The three connectors' states, in order: Idea to Sketch, Sketch to Brief,
   * Brief to Arc. Each also colours the two ports it joins.
   * @selector [data-state="pending" | "linked" | "changed"]
   */
  links: readonly [ArcCanvasLinkState, ArcCanvasLinkState, ArcCanvasLinkState];
}

export function SessionArcCanvas({ arcName, cards, links }: SessionArcCanvasProps): React.ReactElement {
  const state = useArcCanvasState(arcName);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const cardEls = useRef<Partial<Record<ArcCanvasRung, HTMLElement | null>>>({});
  const pathEls = useRef<Array<SVGPathElement | null>>([]);
  // Where each card stands right now: the remembered positions, except for a
  // card in hand, which is wherever the pointer has taken it.
  const livePositions = useRef(state.positions);
  // Which cards are drawn open: a full card always, another when it is
  // remembered open and has a body to show.
  const isOpen = (rung: ArcCanvasRung): boolean =>
    cards[rung].body !== undefined && (cards[rung].full === true || state.expanded[rung]);
  const shownExpanded = {
    idea: isOpen("idea"),
    sketch: isOpen("sketch"),
    brief: isOpen("brief"),
    arc: isOpen("arc"),
  };
  const expandedRef = useRef(shownExpanded);
  expandedRef.current = shownExpanded;
  const dragRef = useRef<{
    rung: ArcCanvasRung;
    pointerId: number;
    from: ArcCanvasPoint;
    origin: ArcCanvasPoint;
    moved: boolean;
  } | null>(null);
  // Set by a press that ended as a drag, so the click it ends in is not also
  // a press on whatever the card was let go over.
  const suppressClick = useRef(false);
  // The cards stack in the order they were last touched.
  const topRef = useRef(1);

  /** Write every card's place, every connector's path and the canvas's size. */
  const place = useCallback((): void => {
    const shown = layoutArcCanvas({ positions: livePositions.current, expanded: expandedRef.current });
    const heights = {} as Record<ArcCanvasRung, number>;
    for (const rung of ARC_CANVAS_RUNGS) {
      const el = cardEls.current[rung] ?? null;
      heights[rung] = el?.offsetHeight ?? 0;
      if (el === null) continue;
      el.style.left = `${shown[rung].x}px`;
      el.style.top = `${shown[rung].y}px`;
    }
    for (let i = 0; i < ARC_CANVAS_RUNGS.length - 1; i += 1) {
      pathEls.current[i]?.setAttribute(
        "d",
        arcConnectorPath(shown[ARC_CANVAS_RUNGS[i]], shown[ARC_CANVAS_RUNGS[i + 1]]),
      );
    }
    const canvas = canvasRef.current;
    if (canvas !== null) {
      const extent = arcCanvasExtent(shown, heights);
      canvas.style.width = `${extent.width}px`;
      canvas.style.height = `${extent.height}px`;
    }
  }, []);

  // The remembered canvas is where the cards stand, unless one is in hand:
  // then the drop is what settles it. Any render can change a card's size,
  // so every render re-places.
  useLayoutEffect(() => {
    if (dragRef.current === null) livePositions.current = state.positions;
    place();
  });

  // A card's body can grow or shrink without this component rendering, when
  // what it composes updates itself. The canvas is sized to hold the cards,
  // so it is told.
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => place());
    for (const rung of ARC_CANVAS_RUNGS) {
      const el = cardEls.current[rung];
      if (el !== null && el !== undefined) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [place]);

  const raise = (rung: ArcCanvasRung): void => {
    const el = cardEls.current[rung];
    if (el === null || el === undefined) return;
    topRef.current += 1;
    el.style.zIndex = String(topRef.current);
  };

  const endDrag = (el: HTMLElement, pointerId: number): void => {
    dragRef.current = null;
    delete el.dataset.dragging;
    if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
  };

  const dragHandlers = (rung: ArcCanvasRung) => ({
    onPointerDown: (event: React.PointerEvent<HTMLElement>): void => {
      suppressClick.current = false;
      if (event.button !== 0) return;
      raise(rung);
      if ((event.target as HTMLElement).closest(CONTROL_SELECTOR) !== null) return;
      dragRef.current = {
        rung,
        pointerId: event.pointerId,
        from: { x: event.clientX, y: event.clientY },
        origin: livePositions.current[rung],
        moved: false,
      };
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>): void => {
      const drag = dragRef.current;
      if (drag === null || drag.rung !== rung || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.from.x;
      const dy = event.clientY - drag.from.y;
      if (!drag.moved) {
        // A press that barely moves is a press, not a drag.
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        drag.moved = true;
        // The card takes the pointer only now, so a plain press on something
        // inside it still reaches that thing.
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.dragging = "true";
      }
      // The pointer moves in viewport pixels; the card is placed in layout
      // pixels, which the deck's zoom scales.
      const zoom = pageZoomFactor();
      livePositions.current = {
        ...livePositions.current,
        [rung]: clampToArcCanvas({ x: drag.origin.x + dx / zoom, y: drag.origin.y + dy / zoom }),
      };
      place();
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>): void => {
      const drag = dragRef.current;
      if (drag === null || drag.rung !== rung) return;
      endDrag(event.currentTarget, event.pointerId);
      if (!drag.moved) return;
      suppressClick.current = true;
      writeArcCanvasState(arcName, {
        positions: livePositions.current,
        expanded: readArcCanvasState(arcName).expanded,
      });
    },
    onPointerCancel: (event: React.PointerEvent<HTMLElement>): void => {
      const drag = dragRef.current;
      if (drag === null || drag.rung !== rung) return;
      endDrag(event.currentTarget, event.pointerId);
      // A cancelled drag never happened: the card goes back where it stood.
      livePositions.current = { ...livePositions.current, [rung]: drag.origin };
      place();
    },
    onClickCapture: (event: React.MouseEvent<HTMLElement>): void => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  });

  const toggleExpanded = (rung: ArcCanvasRung): void => {
    const current = readArcCanvasState(arcName);
    const open = !current.expanded[rung];
    writeArcCanvasState(arcName, {
      positions: current.positions,
      expanded: { ...current.expanded, [rung]: open },
    });
    if (open) raise(rung);
  };

  return (
    <div className="session-arc-canvas" data-slot="session-arc-canvas" ref={canvasRef}>
      {/* One SVG beneath every card. A connector meets its two ports at the
          cards' edges, and passes behind any card that stands across it. */}
      <svg className="session-arc-canvas-links" aria-hidden="true">
        {links.map((link, i) => (
          <g
            key={ARC_CANVAS_RUNGS[i]}
            className="session-arc-canvas-link"
            data-slot="session-arc-canvas-link"
            data-from={ARC_CANVAS_RUNGS[i]}
            data-state={link}
          >
            <path
              className="session-arc-canvas-link-path"
              ref={(el) => {
                pathEls.current[i] = el;
              }}
            />
          </g>
        ))}
      </svg>
      {ARC_CANVAS_RUNGS.map((rung, i) => {
        const card = cards[rung];
        const open = shownExpanded[rung];
        const full = open && card.full === true;
        const inLink = i > 0 ? links[i - 1] : undefined;
        const outLink = i < links.length ? links[i] : undefined;
        return (
          <section
            key={rung}
            ref={(el) => {
              cardEls.current[rung] = el;
            }}
            className="session-arc-canvas-card"
            data-slot="session-arc-canvas-card"
            data-rung={rung}
            data-state={card.state}
            data-expanded={open ? "true" : undefined}
            data-full={full ? "true" : undefined}
            aria-label={RUNG_LABELS[rung]}
            {...dragHandlers(rung)}
          >
            {inLink !== undefined ? (
              <span className="session-arc-canvas-port" data-side="in" data-state={inLink} aria-hidden="true" />
            ) : null}
            {outLink !== undefined ? (
              <span className="session-arc-canvas-port" data-side="out" data-state={outLink} aria-hidden="true" />
            ) : null}
            <header className="session-arc-canvas-card-head">
              <span className="session-arc-canvas-card-name">{RUNG_LABELS[rung]}</span>
              <span className="session-arc-canvas-card-spacer" />
              {card.body !== undefined && !full ? (
                <TugIconButton
                  size="2xs"
                  emphasis="ghost"
                  icon={open ? <Minimize2 /> : <Maximize2 />}
                  aria-label={open ? `Collapse ${RUNG_LABELS[rung]}` : `Expand ${RUNG_LABELS[rung]}`}
                  onClick={() => toggleExpanded(rung)}
                />
              ) : null}
            </header>
            {full ? null : <h3 className="session-arc-canvas-card-title">{card.title}</h3>}
            {card.detail !== undefined && !full ? (
              <div className="session-arc-canvas-card-detail">{card.detail}</div>
            ) : null}
            {open ? <div className="session-arc-canvas-card-body">{card.body}</div> : null}
          </section>
        );
      })}
    </div>
  );
}
