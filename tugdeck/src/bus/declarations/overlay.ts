/**
 * What crosses between the shell and the overlay page.
 *
 * The overlay is the transparent page above every card (`overlay/`), a page
 * on the bus under the reserved card id {@link OVERLAY_CARD_ID}. Every store
 * the shell owns for it is `kinds`-scoped to that id, so no card's page ever
 * replicates one ([B07]). What the overlay hosts on its own connection — the
 * version gate, the setup wizard — crosses nothing here; what it shows for
 * the shell crosses as these stores, and what it asks of the shell as these
 * actions (`overlay/overlay-census.ts` says which surface is which).
 *
 * No store here carries a card's geometry while the card moves: the one that
 * names a card at all, {@link overlaySurfaces}, holds a card's entry only at
 * rest, and the shell withdraws it for the length of any motion
 * (`lib/overlay-surfaces.ts`).
 *
 * @module bus/declarations/overlay
 */

import { arr, bool, empty, literal, nullable, num, obj, opaque, optional, rec, str } from "../codec";
import { defineAction } from "../routed-action";
import { defineRequest } from "../request";
import { defineSharedStore } from "../shared-store";
import { cardSurfaceCodec, type CardSurface } from "./card";
import { OVERLAY_CARD_ID } from "../../lib/overlay-card";
import type { UpdateSnapshot } from "../../lib/update-store";

const overlayOnly = { kinds: (componentId: string) => componentId === OVERLAY_CARD_ID };

/** The restore gate's fold, as the shell computes it from every card's restore. */
export const overlayRestoreGate = defineSharedStore({
  key: "overlay.restoreGate",
  owner: "shell",
  scope: overlayOnly,
  codec: obj({ open: bool, cards: num, turnsLoaded: num, turnsTarget: num }),
  initial: { open: false, cards: 0, turnsLoaded: 0, turnsTarget: 0 },
});

const updateSnapshot = opaque(
  (value: unknown): value is UpdateSnapshot =>
    typeof value === "object" && value !== null && typeof (value as { stage?: unknown }).stage === "string",
  { stage: "idle" } as unknown as UpdateSnapshot,
);

/**
 * One update snapshot from the host, as the shell's update bridge applied it:
 * every one, in order, never only the latest. The wizard reads transitions,
 * not a state — a reveal count it has not seen, a stage passing through
 * `idle` on the way to a check — so a store, which delivers its latest value,
 * would collapse two snapshots into one jump. Held for an overlay not yet
 * attached, and the standing one is sent again at its hello, which a count
 * it has seen makes inert.
 */
export const overlayUpdateState = defineAction({
  id: "overlay.updateState",
  owner: "card",
  codec: updateSnapshot,
});

/** Which cards have a turn in flight, as the shell's live-turns store folds it. */
export const overlayLiveTurns = defineSharedStore({
  key: "overlay.liveTurns",
  owner: "shell",
  scope: overlayOnly,
  codec: obj({ count: num, titles: arr(str) }),
  initial: { count: 0, titles: [] as string[] },
});

/** The host's network-path hint, which the host reports to the shell alone (`network-path-store.ts`). */
export const overlayNetworkPath = defineSharedStore({
  key: "overlay.networkPath",
  owner: "shell",
  scope: overlayOnly,
  codec: obj({
    status: nullable(literal("satisfied", "unsatisfied", "requiresConnection")),
    isExpensive: bool,
    isConstrained: bool,
  }),
  initial: { status: null, isExpensive: false, isConstrained: false } as {
    status: "satisfied" | "unsatisfied" | "requiresConnection" | null;
    isExpensive: boolean;
    isConstrained: boolean;
  },
});

/** A rect in the shell's viewport points, which are the overlay's: the two views share one frame. */
export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const rect = obj({ x: num, y: num, width: num, height: num });

/**
 * One card's surface at rest: the surface as its body rendered it, and where
 * the card rests — its content box (the body's viewport, which the surface's
 * coordinates are in), the pane it is kept inside, and the visible canvas it
 * may not grow past.
 */
export interface OverlaySurfaceEntry {
  surface: CardSurface;
  body: OverlayRect;
  pane: OverlayRect | null;
  bound: OverlayRect | null;
}

/**
 * The surfaces anchored to cards, by card id, each at its card's rest rect. A
 * card in a gesture or named by a settle's plan has no entry until it rests
 * again (`lib/overlay-surfaces.ts`), so nothing the overlay draws from this
 * follows a card frame by frame.
 */
export const overlaySurfaces = defineSharedStore<Record<string, OverlaySurfaceEntry>>({
  key: "overlay.surfaces",
  owner: "shell",
  scope: overlayOnly,
  codec: rec(obj({ surface: cardSurfaceCodec, body: rect, pane: nullable(rect), bound: nullable(rect) })),
  initial: {},
});

/** A press in the drawn copy of `cardId`'s surface, at `path` from its content root: the shell sends it on to the card. */
export const overlaySurfaceActivate = defineAction({
  id: "overlay.surfaceActivate",
  owner: "shell",
  codec: obj({ cardId: str, path: arr(num) }),
});

/** The drawn copy of `cardId`'s surface was dismissed in the overlay — a press beside it, Escape. */
export const overlaySurfaceDismissed = defineAction({
  id: "overlay.surfaceDismissed",
  owner: "shell",
  codec: obj({ cardId: str }),
});

/** The ghost of a tab dragged past its own bar: its box at the pointer, and its label. */
export interface OverlayGhost extends OverlayRect {
  label: string;
}

/**
 * A zone's outline, and what stands over it: the rails and margin caps that
 * outrank the outline of a card carried under them, so the reader sees their
 * panel where the outline runs on behind it — painted over, not cut away.
 * A rail in the air rides above them, and its outline has nothing over it.
 */
export interface OverlayZone extends OverlayRect {
  under: OverlayRect[];
}

/**
 * The width a rail width drag's release would commit, beside the pointer:
 * its text, the limit the hand presses past (`"floor"`, `"ceiling"`) or
 * null, and the pointer, in viewport points. The overlay draws the pill a
 * little above and beside the point, and fades it when the readout goes.
 */
export interface OverlayReadout {
  x: number;
  y: number;
  text: string;
  limit: string | null;
}

/**
 * What a drag indicates, drawn in the overlay against stationary zones and
 * the pointer, never against a moving card ([B08]): the zone a release would
 * land in, the title band a tab or a card would merge onto, the guides the
 * host snapped the step to, the ghost of a tab dragged past its bar, and the
 * width a rail's release would commit. The shell computes each from the zones
 * it enumerated at the drag's start and the pointer the host or the card's
 * page reported; the overlay only draws.
 */
export interface OverlayIndication {
  zone: OverlayZone | null;
  band: OverlayRect | null;
  guides: { x: number | null; y: number | null };
  ghost: OverlayGhost | null;
  readout: OverlayReadout | null;
}

/** Nothing indicated. */
export const NO_INDICATION: OverlayIndication = {
  zone: null,
  band: null,
  guides: { x: null, y: null },
  ghost: null,
  readout: null,
};

export const overlayIndication = defineSharedStore<OverlayIndication>({
  key: "overlay.indication",
  owner: "shell",
  scope: overlayOnly,
  codec: obj({
    zone: nullable(obj({ x: num, y: num, width: num, height: num, under: arr(rect) })),
    band: nullable(rect),
    guides: obj({ x: nullable(num), y: nullable(num) }),
    ghost: nullable(obj({ x: num, y: num, width: num, height: num, label: str })),
    readout: nullable(obj({ x: num, y: num, text: str, limit: nullable(str) })),
  }),
  initial: NO_INDICATION,
});

/**
 * How wide each side's margin cap is, layout px, or 0 for none: the strip at
 * the window's edge a rail leaves bare, which paints the canvas over any
 * card standing in it (`margin-cap.css`). The cards stand over the shell, so
 * the overlay draws the caps above them; the shell computes the widths from
 * the rails it lays out and changes them only at a commit.
 */
export interface OverlayMarginCaps {
  left: number;
  right: number;
}

export const overlayMarginCaps = defineSharedStore<OverlayMarginCaps>({
  key: "overlay.marginCaps",
  owner: "shell",
  scope: overlayOnly,
  codec: obj({ left: num, right: num }),
  initial: { left: 0, right: 0 },
});

/**
 * Whether Open Quickly is open, and the number of the latest open request
 * (`open-quickly-store.ts`): the shell's `open-quickly` action opens it, and
 * the overlay draws it.
 */
export const overlayOpenQuickly = defineSharedStore({
  key: "overlay.openQuickly",
  owner: "shell",
  scope: overlayOnly,
  codec: obj({ open: bool, seq: num }),
  initial: { open: false, seq: 0 },
});

/** Open Quickly closed in the overlay — a commit, a dismissal — naming the open request it closed. */
export const overlayCloseOpenQuickly = defineAction({
  id: "overlay.closeOpenQuickly",
  owner: "shell",
  codec: obj({ seq: num }),
});

/** Open Quickly's choice: open `path` in a card, at `line` when the query named one. */
export const overlayOpenFile = defineAction({
  id: "overlay.openFile",
  owner: "shell",
  codec: obj({ path: str, line: nullable(num) }),
});

/** The app-modals the overlay has on screen, which the shell's menu reads (`app-modal-store.ts`). */
export const overlayAppModal = defineSharedStore({
  key: "overlay.appModal",
  owner: "card",
  scope: { card: true },
  codec: arr(literal("configure-tug", "update-tug", "version-gate")),
  initial: [] as Array<"configure-tug" | "update-tug" | "version-gate">,
});

/** The update wizard's or the pill's ask of the host, which the shell posts (`updateAction`). */
export const overlayUpdateAction = defineAction({
  id: "overlay.updateAction",
  owner: "shell",
  codec: obj({ action: str }),
});

/** The setup wizard's Open Session: a Session card spawned in `projectDir`, or a picker when it is empty. */
export const overlayOpenFirstSession = defineAction({
  id: "overlay.openFirstSession",
  owner: "shell",
  codec: obj({ projectDir: str }),
});

/** Open the setup wizard on demand: the Tug menu's Configure Tug…, once the shell has stopped the turns it covers. */
export const overlayOpenConfigure = defineAction({
  id: "overlay.openConfigure",
  owner: "card",
  codec: empty,
});

/**
 * A deck bulletin the shell raised, shown in the overlay's stack above every
 * card (`tug-bulletin.tsx`). Text only: a callback cannot cross. Held for an
 * overlay not yet attached, so a bulletin raised during boot is still seen.
 */
export const overlayBulletin = defineAction({
  id: "overlay.bulletin",
  owner: "card",
  codec: obj({
    tone: literal("default", "success", "danger", "caution"),
    message: str,
    description: optional(str),
    duration: optional(num),
    sticky: optional(bool),
    okLabel: optional(str),
  }),
});

/**
 * How far each side's sidebar rail reaches in from the window edge, layout
 * px, or 0 where none stands, so the overlay's bulletin stack stands clear
 * of the rails. The shell computes it from the rails it lays out and
 * changes it only at a commit.
 */
export const overlayBulletinInsets = defineSharedStore<{ left: number; right: number }>({
  key: "overlay.bulletinInsets",
  owner: "shell",
  scope: overlayOnly,
  codec: obj({ left: num, right: num }),
  initial: { left: 0, right: 0 },
});

/** An alert the shell raises, shown in the overlay; the reply is whether it was confirmed. */
export const overlayAlert = defineRequest({
  id: "overlay.alert",
  owner: "card",
  codec: obj({
    title: optional(str),
    message: optional(str),
    confirmLabel: optional(str),
    cancelLabel: optional(nullable(str)),
    confirmRole: optional(literal("accent", "action", "agent", "data", "danger", "option")),
    icon: optional(str),
  }),
  replyCodec: obj({ confirmed: bool }),
  onDetach: "redeliver",
});
