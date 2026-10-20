/**
 * The overlay's view: the shell asks for it, and the overlay says where it
 * takes the pointer.
 *
 * The overlay is a web view the host keeps above every card ([B07]). It is
 * made by its own message rather than `bodyCreate`, because it is no card's
 * body: it loads `/?overlay=deck-overlay`, it has no bind, no placement and
 * no plan, and the host never carries it. It hit-tests nil everywhere but
 * inside the claim it posts, so a click on a card beneath it reaches the
 * card.
 *
 * @module host/declarations/overlay
 */

import { arr, empty, num, obj, type Codec } from "../../bus/codec";
import { defineToHost } from "../declare";

/** A rect in the overlay's viewport points. */
export interface ClaimRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where the overlay takes the pointer: the whole window, or these rects. */
export type OverlayClaim = { readonly all: true } | { readonly rects: readonly ClaimRect[] };

/** `{all: true}`, or the rects the overlay's surfaces cover. */
const overlayClaimCodec: Codec<OverlayClaim> = {
  decode: (value) => {
    if (typeof value === "object" && value !== null && (value as { all?: unknown }).all === true) return { all: true };
    return obj({ rects: arr(obj({ x: num, y: num, width: num, height: num })) }).decode(value);
  },
  sample: { all: true },
};

/** The shell's ask for the overlay's view, once, at its boot. Idempotent on the host. */
export const overlayCreateToHost = defineToHost<Record<string, never>>({
  name: "overlayCreate",
  from: "shell",
  codec: empty,
  samples: [{}],
  refused: ["now", []],
});

/**
 * Where the overlay takes the pointer: `{all: true}` while an app-modal or an
 * alert stands, which also makes the overlay's view the key one, or the
 * rects of the surfaces it shows, empty when it shows none.
 */
export const overlayClaimToHost = defineToHost<OverlayClaim>({
  name: "overlayClaim",
  from: "overlay",
  codec: overlayClaimCodec,
  samples: [{ all: true }, { rects: [] }, { rects: [{ x: 1, y: 2, width: 3, height: 4 }] }],
  refused: [[], {}, { all: false }, { rects: [{ x: "bad", y: 2, width: 3, height: 4 }] }],
});
