/**
 * session-picker-quiet — when the Choose Session picker's content has stopped
 * moving, for a card that arrived hidden ([B03]).
 *
 * The picker is one list of sessions grouped by project, and each group is
 * fed by its own CONTROL request answered in two frames that do not carry the
 * same data ([F01]): phase one is the ledger's rows with `scanning: true`,
 * phase two the union with the on-disk scan and `scanning: false`. Rows can
 * arrive, and grow a synopsis, between the two — which is exactly what moved
 * the card under the old off-screen measure. So an arriving Session card is
 * held hidden until this module says the picker is quiet, or the deck's bound
 * expires, whichever is first.
 *
 * Only the UNFOLDED groups can move the list: a folded group is its band
 * alone, and a band is the same height whether it says "checking…" or a
 * count. Quiet is defined by their DATA, not by a timer ([B03]):
 *
 * - every open group's listing has settled (`scanning: false`), or
 * - the rows already on screen are numerous enough to fill the list's cap
 *   ([F03]): the list is `max-height: 34rem` over a `3.5rem` row floor, so
 *   once ten rows stand in it no later frame can change its height;
 *
 * and, while a listing is still scanning, every session row on screen has its
 * synopsis — the description line is what a synopsis fills, and a row whose
 * description lands with the union is a row that changes height. A settled
 * listing is quiet whatever its synopses say: they ride the rows, so a row the
 * settled frame delivered without one is not getting one during this arrival,
 * and holding the card for it only spends the bound.
 *
 * The rule is pure over the groups' snapshots and a synopsis lookup so it can
 * be tested without a deck; {@link sessionPickerQuiet} is the same rule bound
 * to the live stores, in the shape the registration declares.
 *
 * WHEN the deck is told to re-ask is the other half, and it is the picker's
 * draw rather than the stores' tick ([L04]): `SessionProjectPickerForm`
 * calls {@link notifyPickerDrawn} from a layout effect after rendering a
 * listing frame, having first had its sheet re-measure. A source that fired
 * on the store's tick would fire BEFORE the rows it announces are in the
 * DOM, and a reveal decided then would commit the placeholder's height.
 *
 * @module components/tugways/cards/session-picker-quiet
 */

import { createSubscribable } from "@/lib/subscribable";
import type { ArrivalQuiet } from "@/lib/arrival-reveal";
import {
  getSessionLedgerStore,
  type WorkspaceSnapshot,
} from "@/lib/session-ledger-store";
import { sessionSynopsisStore } from "@/lib/session-synopsis-store";
import type { SessionRow } from "@/protocol";
import {
  defaultOpenDirs,
  hasResumableContent,
  readPickerGroupSpecs,
} from "./session-picker-groups";

/**
 * How many rows fill the picker's list to its cap ([F03]): `34rem` of list
 * over a `3.5rem` row floor is nine rows and a fraction, so the tenth row is
 * the one past which the list's height is fixed. Bands and New session rows
 * count: they stand in the list like any other row.
 */
export const PICKER_ROWS_TO_FILL_CAP = 10;

/** One group as the rule reads it: unfolded or not, and its listing when it is. */
export interface QuietGroup {
  open: boolean;
  /** The group's listing; read only for an open group. */
  snapshot: WorkspaceSnapshot | null;
}

/**
 * Whether the picker's content over `groups` (in list order) is quiet — see
 * the module note for the rule.
 *
 * `hasSynopsis` answers for a row's `line_id`, off whatever store holds
 * synopses; the rows consulted are the ones ON SCREEN — the first
 * {@link PICKER_ROWS_TO_FILL_CAP} rows of the list — because a row below the
 * fold changing height moves nothing the eye sees.
 *
 * An open group whose listing is not `ready` is never quiet: `pending` is the
 * placeholder the rows will replace, and `idle` is a path nobody has asked
 * about. An `error` listing IS quiet — the band's note is the group's settled
 * form, and nothing further is coming.
 */
export function pickerContentQuiet(
  groups: readonly QuietGroup[],
  hasSynopsis: (lineId: string) => boolean,
): boolean {
  const open = groups.filter((g) => g.open);
  const statusOf = (g: QuietGroup) => g.snapshot?.status ?? "idle";
  if (open.some((g) => statusOf(g) === "pending" || statusOf(g) === "idle")) {
    return false;
  }
  const settled = open.every(
    (g) => statusOf(g) === "error" || g.snapshot?.scanning !== true,
  );
  if (settled) return true;
  // Still scanning: quiet only once the rows on screen fill the cap and each
  // session among them has the synopsis its description line waits on. A band
  // or a New session row is `null` here — it has no synopsis to wait for.
  const slots: (SessionRow | null)[] = [];
  for (const g of groups) {
    slots.push(null);
    const snapshot = g.snapshot;
    if (!g.open || snapshot === null || snapshot.status !== "ready") continue;
    if (snapshot.dirExists !== false) slots.push(null);
    for (const row of snapshot.rows) {
      if (hasResumableContent(row)) slots.push(row);
    }
  }
  if (slots.length < PICKER_ROWS_TO_FILL_CAP) return false;
  return slots
    .slice(0, PICKER_ROWS_TO_FILL_CAP)
    .every((row) => row === null || hasSynopsis(row.line_id));
}

/**
 * The picker's quiet source for an arriving Session card, in the shape the
 * deck reads ({@link ArrivalQuiet}): {@link pickerContentQuiet} over the
 * groups the picker opens on — the same group set and the same unfolded
 * groups its own render derives — and the synopsis store's answer for each
 * row.
 *
 * `subscribe` fires on {@link notifyPickerDrawn} — the picker's own word
 * that a frame is in the DOM — and on nothing else. A synopsis that lands on
 * its own, outside a listing frame, is not waited for here: synopses ride
 * the rows, so that is a Summarize lane writing mid-arrival, which the
 * bound covers and a later reservation corrects.
 *
 * The group set is read once, at the arrival, because a hidden picker takes no
 * input and nothing it shows can be unfolded under it. The ledger store
 * fetches a path it has never seen the first time it is asked, so the
 * `getSnapshot` here is also what starts an open group's listing.
 *
 * `null` when there is no ledger store — a gallery, a fixture — in which case
 * the deck treats the content as quiet from the first ask.
 */
export function sessionPickerQuiet(): ArrivalQuiet | null {
  const ledger = getSessionLedgerStore();
  if (ledger === null) return null;
  const specs = readPickerGroupSpecs();
  const open = new Set(defaultOpenDirs(specs));
  return {
    subscribe: (listener) => drawnListeners.subscribe(listener),
    isQuiet: () =>
      pickerContentQuiet(
        specs.map((spec) => {
          const isOpen = open.has(spec.projectDir);
          return {
            open: isOpen,
            snapshot: isOpen ? ledger.getSnapshot(spec.projectDir) : null,
          };
        }),
        (lineId) => sessionSynopsisStore.getSynopsis(lineId) !== null,
      ),
  };
}

const drawnListeners = createSubscribable();

/**
 * The picker has DRAWN a listing frame — called by `SessionProjectPickerForm`
 * from a layout effect keyed on the rows it rendered, after it has asked its
 * sheet to re-measure. Every arriving card's quiet source re-asks its rule
 * now, over a DOM that matches the store ([L04]).
 */
export function notifyPickerDrawn(): void {
  drawnListeners.notify();
}
