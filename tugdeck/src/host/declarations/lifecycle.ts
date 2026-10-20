/**
 * Page lifecycle: a page saying it is connected, ready, painted or faulted,
 * and the shell making, focusing and destroying bodies.
 *
 * The messages a body's life is told in are typed field by field ([B02]),
 * as the placement messages are; the launch's own (`frontendLaunchStalled`,
 * `pageFault`, `hmrUpdate`) and the calls into `window.tugdeck` are loose.
 *
 * @module host/declarations/lifecycle
 */

import { bool, empty, literal, nullable, num, obj, opaque, optional, str, type Codec } from "../../bus/codec";
import { defineToHost, definePageCall, defineToPage, looseObject, looseReply } from "../declare";

/** A JSON object carried as is: a body's intent, which `parseBodyIntent` reads in the body. */
const jsonObject: Codec<Record<string, unknown>> = opaque(
  (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value),
  {},
);

/** A page's surface as sRGB bytes: four numbers, 0–255. */
const rgbaBytes: Codec<number[]> = opaque(
  (value: unknown): value is number[] =>
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 255),
  [0, 0, 0, 255],
);

export const bodyHelloToHost = defineToHost({
  name: "bodyHello",
  from: "body",
  typed: true,
  codec: empty,
  samples: [{}],
  refused: [true],
});

export const paintedToHost = defineToHost({
  name: "painted",
  from: "body",
  typed: true,
  codec: empty,
  samples: [{}],
  refused: [true],
});

/** The shell's ready reveals the window; a body's says it has painted its card. */
export const frontendReadyToHost = defineToHost({
  name: "frontendReady",
  from: "any",
  typed: true,
  codec: empty,
  samples: [{}],
  refused: [true],
});

export const frontendLaunchStalledToHost = defineToHost({
  name: "frontendLaunchStalled",
  from: "shell",
  codec: looseObject({ waitingOn: "wasm" }),
  samples: [{ waitingOn: "wasm" }],
  refused: ["wasm"],
});

/** Posted only by `PageFaultScript`'s injected script, which no TypeScript module writes. */
export const pageFaultToHost = defineToHost({
  name: "pageFault",
  from: "any",
  codec: looseObject({ kind: "error", message: "", source: "" }),
  samples: [{ kind: "error", message: "TypeError: x is undefined", source: "main.tsx:12" }],
  refused: ["fault"],
});

/** The page's own surface as sRGB bytes, or null when it paints none. */
export interface BodySurface {
  readonly surface: number[] | null;
}

const bodySurfaceCodec: Codec<BodySurface> = obj({ surface: nullable(rgbaBytes) });

export const crossingReadyToHost = defineToHost<BodySurface>({
  name: "crossingReady",
  from: "body",
  typed: true,
  codec: bodySurfaceCodec,
  samples: [{ surface: [28, 30, 34, 255] }, { surface: null }],
  refused: [[28, 30, 34, 255], {}, { surface: [28, 30, 34] }],
});

export const bodySurfaceToHost = defineToHost<BodySurface>({
  name: "bodySurface",
  from: "body",
  typed: true,
  codec: bodySurfaceCodec,
  samples: [{ surface: [28, 30, 34, 255] }, { surface: null }],
  refused: [[28, 30, 34, 255], { surface: [28, 30, 34, 256] }],
});

/** The shell asks for a card's body: which card, which kind, and what the body is to do with it. */
export interface BodyCreate {
  readonly cardId: string;
  readonly componentId: string;
  readonly intent: Record<string, unknown>;
}

export const bodyCreateToHost = defineToHost<BodyCreate>({
  name: "bodyCreate",
  from: "shell",
  typed: true,
  codec: obj({ cardId: str, componentId: str, intent: jsonObject }),
  samples: [{ cardId: "c1", componentId: "text", intent: { kind: "mount" } }],
  refused: ["c1", { cardId: "c1", intent: { kind: "mount" } }, { cardId: "c1", componentId: "text", intent: "mount" }],
});

/** The shell is done with a card's body; with `save`, the body writes its card's state first. */
export interface BodyDestroy {
  readonly cardId: string;
  readonly save: boolean;
}

export const bodyDestroyToHost = defineToHost<BodyDestroy>({
  name: "bodyDestroy",
  from: "shell",
  typed: true,
  codec: obj({ cardId: str, save: bool }),
  samples: [{ cardId: "c1", save: false }],
  refused: ["c1", { cardId: "c1" }],
});

/** The card whose body takes the keyboard, or null for the shell. */
export interface BodyFocus {
  readonly cardId: string | null;
}

export const bodyFocusToHost = defineToHost<BodyFocus>({
  name: "bodyFocus",
  from: "shell",
  typed: true,
  codec: obj({ cardId: nullable(str) }),
  samples: [{ cardId: "c1" }, { cardId: null }],
  refused: [null, { cardId: 7 }],
});

export const hmrUpdateToHost = defineToHost({
  name: "hmrUpdate",
  from: "shell",
  codec: looseObject({}),
  samples: [{}],
  refused: [true],
});

// Host → page.

/** What the host knows of the window when it binds a body, before the shell's own facts reach it over the bus. */
export interface BindFacts {
  readonly theme: string;
  readonly zoom: number;
  readonly keyboardAccess: boolean;
  readonly appActive: boolean;
}

/** A body is told its card. */
export interface BodyBind {
  readonly cardId: string;
  /** The kind of card this body holds: the shell's deck's `componentId`. */
  readonly componentId: string;
  readonly intent: Record<string, unknown>;
  readonly facts: BindFacts;
}

const bind: BodyBind = {
  cardId: "c1",
  componentId: "text",
  intent: { kind: "mount" },
  facts: { theme: "ironclad", zoom: 1, keyboardAccess: false, appActive: true },
};

/** A body is told its card: which card, what to do with it, and the window's facts. */
export const bodyBindToPage = defineToPage<BodyBind>({
  member: "onBodyBind",
  to: "body",
  typed: true,
  codec: obj({
    cardId: str,
    componentId: str,
    intent: jsonObject,
    facts: obj({ theme: str, zoom: num, keyboardAccess: bool, appActive: bool }),
  }),
  samples: [bind, { ...bind, intent: { kind: "restore" }, facts: { ...bind.facts, theme: "", zoom: 1.25 } }],
  refused: ["c1", { ...bind, facts: undefined }, { ...bind, intent: null }],
});

/** What the host reports of a body, or of its floor, to the shell. */
export interface BodyStateReport {
  /** Absent only for `floorShown`, which names no card. */
  readonly cardId?: string;
  readonly state: "ready" | "painted" | "shown" | "landed" | "beatsCancelled" | "failed" | "terminated" | "floorShown";
  /** `ready`: bind → ready, ms. */
  readonly readyMs?: number;
  /** `ready`: whether the body began as the spare. */
  readonly start?: "warm" | "cold";
  /** `landed` / `beatsCancelled`: the beat plan the report is about. */
  readonly planId?: number;
  /** `landed`: how far past its start the plan reached the host, ms. */
  readonly lateMs?: number;
  /** `failed`: why the host gave the body up. */
  readonly cause?: string;
  /** `floorShown`: how long after the window's reveal began the floor showed. */
  readonly sinceRevealMs?: number;
}

/** Where a body stands, told to the shell. */
export const bodyStateToPage = defineToPage<BodyStateReport>({
  member: "onBodyState",
  to: "shell",
  typed: true,
  codec: obj({
    cardId: optional(str),
    state: literal("ready", "painted", "shown", "landed", "beatsCancelled", "failed", "terminated", "floorShown"),
    readyMs: optional(num),
    start: optional(literal("warm", "cold")),
    planId: optional(num),
    lateMs: optional(num),
    cause: optional(str),
    sinceRevealMs: optional(num),
  }),
  samples: [
    { cardId: "c1", state: "ready", readyMs: 412, start: "warm" },
    { cardId: "c1", state: "painted" },
    { cardId: "c1", state: "landed", planId: 7, lateMs: 3.5 },
    { cardId: "c1", state: "beatsCancelled", planId: 7 },
    { cardId: "c1", state: "failed", cause: "deadline" },
    { state: "floorShown", sinceRevealMs: 140 },
    { state: "floorShown" },
  ],
  refused: ["ready", { cardId: "c1", state: "asleep" }, { cardId: "c1", state: "landed", planId: "7" }],
});

// The host's calls into `window.tugdeck`.

/** Write every card's state now, synchronously: the degraded save and the reload's. */
export const saveStateCall = definePageCall({
  receiver: "tugdeck",
  member: "saveState",
  codec: empty,
  replyCodec: looseReply(null),
  samples: [{}],
});

/** The page's half of a quit; its reply is the verdict the host logs. */
export const prepareForTerminationCall = definePageCall({
  receiver: "tugdeck",
  member: "prepareForTermination",
  codec: empty,
  replyCodec: looseReply({ ok: true }),
  samples: [{}],
});

/** Tugcast restarted: take its new session cookie and reconnect. */
export const reauthenticateCall = definePageCall({
  receiver: "tugdeck",
  member: "reauthenticate",
  codec: looseObject({ token: "t0k3n" }),
  replyCodec: looseReply(null),
  samples: [{ token: "t0k3n" }],
});
