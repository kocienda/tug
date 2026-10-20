/**
 * Placement and gestures: the messages that say where every card's view is
 * and what the host carries in its hand.
 *
 * Every message here is typed field by field ([B02]): its codec names each
 * field the writer writes and the reader reads, a field the writer always
 * writes is required, and a payload that does not decode is refused whole —
 * by the page that wrote it in a dev or test build (`postToHost`), and by
 * the host's `Decodable` twin in `HostMessages.swift`, never defaulted field
 * by field.
 *
 * @module host/declarations/geometry
 */

import { INVALID, arr, bool, literal, nullable, num, obj, opaque, optional, str, type Codec } from "../../bus/codec";
import type { ResizeEdge } from "../../bus/declarations/pane";
import type { CardPlan } from "../../lib/card-plan";
import type { CardInsets, PlaceCards } from "../../lib/card-placement";
import type { CardGestureReport } from "../../lib/host-card-gesture";
import { defineToHost, defineToPage } from "../declare";

const rect = obj({ x: num, y: num, width: num, height: num });
const point = obj({ x: num, y: num });

/** A flag the writer sets only when it is true: `true`, or absent. */
const trueFlag: Codec<true | undefined> = optional(opaque((value: unknown): value is true => value === true, true));

const edge: Codec<ResizeEdge> = literal("n", "s", "e", "w", "nw", "ne", "sw", "se");

/** Exactly two numbers: a beat's start and end opacity. */
const pair: Codec<readonly [number, number]> = {
  decode: (value) => {
    if (!Array.isArray(value) || value.length !== 2) return INVALID;
    const [a, b] = value as unknown[];
    const da = num.decode(a);
    const db = num.decode(b);
    return da === INVALID || db === INVALID ? INVALID : [da, db];
  },
  sample: [0, 1],
};

const cardInsets: Codec<CardInsets> = obj({ top: num, right: num, bottom: num, left: num });

const cardPlanCodec: Codec<CardPlan> = obj({
  planId: num,
  startWallMs: num,
  cards: arr(
    obj({
      cardId: str,
      landing: rect,
      crossing: optional(obj({ width: num, height: num })),
      arrives: trueFlag,
      beats: arr(
        obj({
          kind: literal("depart", "room", "shrink", "move", "grow", "arrive"),
          delayMs: num,
          durationMs: num,
          from: rect,
          to: rect,
          opacity: optional(pair),
          progress: arr(num),
          easing: optional(literal("linear", "ease", "ease-in", "ease-out", "ease-in-out")),
        }),
      ),
    }),
  ),
});

const placeCardsCodec: Codec<PlaceCards> = obj({
  apron: num,
  canvas: nullable(rect),
  zoom: num,
  cards: arr(
    obj({
      cardId: str,
      x: num,
      y: num,
      width: num,
      height: num,
      view: rect,
      insets: cardInsets,
      shell: arr(rect),
      visible: bool,
      sibling: trueFlag,
      z: num,
      grips: arr(edge),
      free: bool,
      min: obj({ width: num, height: num }),
      maxHeight: optional(num),
      planId: optional(num),
    }),
  ),
});

/** A card's page has taken a title-bar or grip press for the host to carry (`body-chrome.ts`). */
export interface CardGestureBegin {
  readonly phase: "begin";
  readonly kind: "move" | "resize" | "rail";
  /** The edge or corner a resize is from; a resize without one is refused by the host. */
  readonly edge?: ResizeEdge;
  /** Where the press landed, in the page's viewport. */
  readonly x: number;
  readonly y: number;
  readonly meta: boolean;
  readonly alt: boolean;
}

const cardGestureBeginCodec: Codec<CardGestureBegin> = obj({
  phase: literal("begin"),
  kind: literal("move", "resize", "rail"),
  edge: optional(edge),
  x: num,
  y: num,
  meta: bool,
  alt: bool,
});

const SAMPLE_RECT = { x: 121, y: 96, width: 398, height: 483 };

export const placeCardsToHost = defineToHost<PlaceCards>({
  name: "placeCards",
  from: "shell",
  typed: true,
  codec: placeCardsCodec,
  samples: [
    {
      apron: 10,
      canvas: { x: 0, y: 28, width: 1440, height: 872 },
      zoom: 1,
      cards: [
        {
          cardId: "c1",
          ...SAMPLE_RECT,
          view: { x: 111, y: 86, width: 418, height: 503 },
          insets: { top: 10, right: 10, bottom: 10, left: 10 },
          shell: [{ x: 117, y: 96, width: 8, height: 483 }],
          visible: true,
          z: 1,
          grips: ["e", "s", "se"],
          free: true,
          min: { width: 240, height: 160 },
        },
        {
          cardId: "c3",
          ...SAMPLE_RECT,
          view: { x: 111, y: 86, width: 419, height: 503 },
          insets: { top: 10, right: 10.5, bottom: 10, left: 10 },
          shell: [],
          visible: true,
          z: 2,
          grips: ["s", "e"],
          free: false,
          min: { width: 400, height: 145 },
          maxHeight: 820,
          planId: 12,
        },
        {
          cardId: "c2",
          ...SAMPLE_RECT,
          view: { x: 111, y: 86, width: 418, height: 503 },
          insets: { top: 10, right: 10, bottom: 10, left: 10 },
          shell: [],
          visible: false,
          sibling: true,
          z: 1,
          grips: [],
          free: false,
          min: { width: 0, height: 0 },
        },
      ],
    },
    { apron: 10, canvas: null, zoom: 1.25, cards: [] },
  ],
  refused: [
    [{ cardId: "c1" }],
    { apron: 10, canvas: null, zoom: 1 },
    {
      apron: 10,
      canvas: null,
      zoom: 1,
      cards: [
        {
          cardId: "c1",
          ...SAMPLE_RECT,
          view: SAMPLE_RECT,
          insets: { top: 0, right: 0, bottom: 0, left: 0 },
          shell: [],
          visible: true,
          z: 1,
          grips: ["middle"],
          free: true,
          min: { width: 0, height: 0 },
        },
      ],
    },
  ],
});

export const cardGestureToHost = defineToHost<CardGestureBegin>({
  name: "cardGesture",
  from: "body",
  typed: true,
  codec: cardGestureBeginCodec,
  samples: [
    { phase: "begin", kind: "move", x: 140, y: 12, meta: false, alt: false },
    { phase: "begin", kind: "resize", edge: "e", x: 518, y: 300, meta: false, alt: true },
    { phase: "begin", kind: "rail", edge: "e", x: 300, y: 400, meta: false, alt: false },
  ],
  refused: [
    null,
    { phase: "begin", kind: "move", meta: false, alt: false },
    { phase: "begin", kind: "fling", x: 1, y: 2, meta: false, alt: false },
  ],
});

/**
 * A settle's whole-card plan: each carried card's view, beat by beat, on
 * the clock both sides share (`lib/card-plan.ts`, the one producer).
 */
export const cardPlanToHost = defineToHost<CardPlan>({
  name: "cardPlan",
  from: "shell",
  typed: true,
  codec: cardPlanCodec,
  samples: [
    {
      planId: 1,
      startWallMs: 1760000000000.5,
      cards: [
        {
          cardId: "c1",
          landing: SAMPLE_RECT,
          beats: [
            {
              kind: "move",
              delayMs: 0,
              durationMs: 300,
              from: { ...SAMPLE_RECT, x: 421 },
              to: SAMPLE_RECT,
              progress: [0, 0.32, 0.71, 0.93, 1.03, 1.01, 1],
            },
          ],
        },
        {
          cardId: "c2",
          landing: SAMPLE_RECT,
          crossing: { width: 398, height: 483 },
          arrives: true,
          beats: [
            {
              kind: "arrive",
              delayMs: 0,
              durationMs: 120,
              from: SAMPLE_RECT,
              to: SAMPLE_RECT,
              opacity: [0, 1],
              progress: [0, 1],
              easing: "ease-out",
            },
          ],
        },
      ],
    },
  ],
  refused: [
    { planId: "x", startWallMs: 0, cards: [] },
    { startWallMs: 0, cards: [] },
    { planId: 1, startWallMs: 0, bodies: [] },
    { planId: 1, startWallMs: 0, cards: [{ cardId: "c1", landing: SAMPLE_RECT }] },
  ],
});

// Host → page.

const gestureReportCodec: Codec<CardGestureReport> = obj({
  cardId: str,
  kind: literal("move", "resize", "rail"),
  phase: literal("move", "end", "cancel"),
  rect,
  pointer: point,
  start: point,
  moved: bool,
  meta: bool,
  alt: bool,
  edge: optional(edge),
  snap: optional(obj({ x: nullable(num), y: nullable(num) })),
});

const gestureReport: CardGestureReport = {
  cardId: "c1",
  kind: "move",
  phase: "move",
  rect: { x: 40, y: 60, width: 480, height: 320 },
  pointer: { x: 200, y: 80 },
  start: { x: 180, y: 70 },
  moved: true,
  meta: false,
  alt: false,
};

/** Where a gesture the host carries stands, told to the shell. */
export const cardGestureToPage = defineToPage<CardGestureReport>({
  member: "onCardGesture",
  to: "shell",
  typed: true,
  codec: gestureReportCodec,
  samples: [
    gestureReport,
    { ...gestureReport, kind: "resize", phase: "end", edge: "se", snap: { x: 40, y: null } },
    { ...gestureReport, phase: "cancel", moved: false },
  ],
  refused: ["move", { ...gestureReport, phase: "begin" }, { ...gestureReport, start: undefined }],
});

/** Where a whole card's pane stands in its body's view. */
export const cardInsetsToPage = defineToPage<CardInsets>({
  member: "onCardInsets",
  to: "body",
  typed: true,
  codec: cardInsets,
  samples: [{ top: 6, right: 6.5, bottom: 6, left: 6 }],
  refused: [28, { top: 6, right: 6, bottom: 6 }],
});

/**
 * A crossing's beats begin over the body — the size its box is carried to
 * and the plan's span — or have landed.
 */
export interface BodyCrossing {
  readonly phase: "begin" | "land";
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
}

export const bodyCrossingToPage = defineToPage<BodyCrossing>({
  member: "onBodyCrossing",
  to: "body",
  typed: true,
  codec: obj({
    phase: literal("begin", "land"),
    width: optional(num),
    height: optional(num),
    durationMs: optional(num),
  }),
  samples: [{ phase: "begin", width: 480, height: 320, durationMs: 240 }, { phase: "land" }],
  refused: ["land", { phase: "pause" }, { phase: "begin", width: "wide" }],
});
