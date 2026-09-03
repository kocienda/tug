/**
 * slot-window-pref.ts — how many places a card's row shows around its own.
 *
 * A row in the Cards card states where its card stands by drawing the deck's
 * slot run with one chip lit. Drawn in full that run costs a chip per place on
 * every row, so the row's width tracks the deck's slot count and the count is
 * what has to stay small — six was already crowding the rail, and the design
 * could not answer what eight would look like. The row draws a WINDOW instead:
 * the held slot with its neighbours either side, at a fixed width, so what the
 * rail spends is the same at three places and at ten.
 *
 * Which leaves one genuine question of taste, and it is the reader's: three
 * chips is the diet, five is the context. Both are legible, neither is more
 * correct, so it is a preference rather than a constant.
 *
 * Deck-wide rather than per card ([D07], `feedback_no_localstorage`): how much
 * of an arrangement a reader wants to see at a glance is about the reader, and
 * a preference that answered differently on two rows of one list would read as
 * a rendering fault.
 *
 * Deck-wide is also why it has a domain of its own rather than a card's. The
 * preference belongs to no card, so it could not move onto one when the rail
 * was retired — it only ever squatted on the rail's domain, which it had no
 * more claim to than any other.
 *
 * Tugbank coordinates:
 *  - domain: `dev.tugapp.slot-window`
 *  - key:    `slotWindow`
 *  - value:  `{ kind: "i64", value: 3 | 5 }`
 *
 * Legacy address (read-only): `dev.tugapp.lens` / `slotWindow`, where the
 * preference lived before it had a domain. See {@link LEGACY_SLOT_WINDOW_DOMAIN}.
 *
 * Laws: [L02] the tugbank cache enters React through `useTugbankValue`.
 *
 * @module lib/slot-window-pref
 */

import { getTugbankClient } from "@/lib/tugbank-singleton";
import { useTugbankValue } from "@/lib/use-tugbank-value";
import type { TaggedValue } from "@/lib/tugbank-client";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";

export const SLOT_WINDOW_DOMAIN = "dev.tugapp.slot-window";
export const SLOT_WINDOW_KEY = "slotWindow";

/**
 * Where the preference was stored before it had a domain of its own — the
 * retired rail card's, which it shared for no better reason than that the
 * slot picker was first drawn on a rail row.
 *
 * Read, never written. A reader who chose a width before the move keeps it:
 * the new address answers when it holds anything, this one answers when it
 * does not, and the first ordinary write lands on the new address and settles
 * the question for good. No row is deleted, so a downgrade still reads its
 * own value.
 */
export const LEGACY_SLOT_WINDOW_DOMAIN = "dev.tugapp.lens";

/** The widths a window may take. Odd, because the held slot is the middle. */
export const SLOT_WINDOW_SIZES = [3, 5] as const;

export type SlotWindowSize = (typeof SLOT_WINDOW_SIZES)[number];

/** What a reader who has never chosen gets. */
export const DEFAULT_SLOT_WINDOW: SlotWindowSize = 5;

/** Narrow an unknown — a parsed blob field, an action payload — to a size. */
export function isSlotWindowSize(value: unknown): value is SlotWindowSize {
  return SLOT_WINDOW_SIZES.some((size) => size === value);
}

/**
 * The stored size, or `null` when nothing is stored and when what is stored is
 * not one of the two. A width retired by a later build therefore stops
 * steering the rows rather than drawing a run nobody can choose again.
 */
export function parseSlotWindow(
  entry: TaggedValue | undefined,
): SlotWindowSize | null {
  if (entry === undefined) return null;
  return isSlotWindowSize(entry.value) ? entry.value : null;
}

/**
 * Resolve a width from the two addresses, newest first. Pure, so the
 * precedence is testable without a renderer.
 */
export function resolveSlotWindow(
  stored: SlotWindowSize | null,
  legacy: SlotWindowSize | null,
): SlotWindowSize {
  return stored ?? legacy ?? DEFAULT_SLOT_WINDOW;
}

/**
 * The reader's window width. [L02]
 *
 * Two subscriptions rather than one read and one imperative `get`:
 * `useTugbankValue` subscribes to a single `(domain, key)` pair, and an
 * imperative read beside it would be state entering React outside
 * `useSyncExternalStore` — and would not redraw when the legacy row arrives in
 * the boot frame.
 */
export function useSlotWindow(): SlotWindowSize {
  const stored = useTugbankValue<SlotWindowSize | null>(
    SLOT_WINDOW_DOMAIN,
    SLOT_WINDOW_KEY,
    parseSlotWindow,
    null,
  );
  const legacy = useTugbankValue<SlotWindowSize | null>(
    LEGACY_SLOT_WINDOW_DOMAIN,
    SLOT_WINDOW_KEY,
    parseSlotWindow,
    null,
  );
  return resolveSlotWindow(stored, legacy);
}

/**
 * Persist `size`. Writes the local cache first so every row redraws in the
 * same frame as the press, then PUTs fire-and-forget.
 */
export function writeSlotWindow(size: SlotWindowSize): void {
  const body: TaggedValue = { kind: "i64", value: size };
  const client = getTugbankClient();
  if (client !== null) {
    client.setLocalValue(SLOT_WINDOW_DOMAIN, SLOT_WINDOW_KEY, body);
  }
  fetch(
    `/api/defaults/${SLOT_WINDOW_DOMAIN}/${encodeURIComponent(SLOT_WINDOW_KEY)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    },
  ).catch((err) => {
    tugDevLogStore.warn(
      "slot-window",
      `PUT failed for ${SLOT_WINDOW_KEY}: ${String(err)}`,
    );
  });
}
