/**
 * session-picker-quiet — when the Choose Session picker's content has stopped
 * moving, for a card that arrived hidden ([B03]).
 *
 * The picker is fed by one CONTROL request answered in two frames that do not
 * carry the same data ([F01]): phase one is the ledger's rows with
 * `scanning: true`, phase two the union with the on-disk scan and
 * `scanning: false`. Rows can arrive, and grow a synopsis, between the two —
 * which is exactly what moved the card under the old off-screen measure. So
 * an arriving Session card is held hidden until this module says the picker
 * is quiet, or the deck's bound expires, whichever is first.
 *
 * Quiet is defined by the DATA, not by a timer ([B03]):
 *
 * - the listing has settled (`scanning: false`), or
 * - the rows already on screen are numerous enough to fill the list cap
 *   ([F03]): the list is `max-height: 14.5rem` over a `3.5rem` row floor, so
 *   once five rows stand in it no later frame can change its height;
 *
 * and, in either case, every row on screen has its synopsis — the description
 * line is what a synopsis fills, and a row whose description lands late is a
 * row that changes height. A row that never gets one waits out the bound,
 * which is short.
 *
 * The rule is pure over a {@link WorkspaceSnapshot} and a synopsis lookup so
 * it can be tested without a deck; {@link sessionPickerQuiet} is the same rule
 * bound to the live stores, in the shape the registration declares.
 *
 * @module components/tugways/cards/session-picker-quiet
 */

import type { ArrivalQuiet } from "@/lib/arrival-reveal";
import {
  getSessionLedgerStore,
  type WorkspaceSnapshot,
} from "@/lib/session-ledger-store";
import { sessionSynopsisStore } from "@/lib/session-synopsis-store";
import type { SessionRow } from "@/protocol";
import { readSeedPath } from "./session-picker-seed";

/**
 * How many rows fill the picker's list to its cap ([F03]): `14.5rem` of list
 * over a `3.5rem` row floor is four rows and a fraction, so the fifth row is
 * the one past which the list's height is fixed. The count includes the
 * "New session" row the list always leads with.
 */
export const PICKER_ROWS_TO_FILL_CAP = 5;

/**
 * The rows the picker will actually show for `snapshot`, in the order it
 * shows them — the same visibility rule `session-picker-data-source` applies:
 * a row with resumable content by any signal (on-disk bytes, a canonical
 * turn, or a live process), in the ledger's newest-first order.
 */
function shownRows(snapshot: WorkspaceSnapshot): readonly SessionRow[] {
  return snapshot.rows.filter(
    (row) =>
      (row.file_size ?? 0) > 0 || row.turn_count > 0 || row.state === "live",
  );
}

/**
 * Whether the picker's content over `snapshot` is quiet — see the module note
 * for the rule.
 *
 * `hasSynopsis` answers for a row's `line_id`, off whatever store holds
 * synopses; the rows consulted are the ones ON SCREEN — the first
 * {@link PICKER_ROWS_TO_FILL_CAP} less one for the "New session" row, or all
 * of them when there are fewer — because a row below the fold changing height
 * moves nothing the eye sees.
 *
 * A snapshot that is not `ready` is never quiet: `pending` is the placeholder
 * the rows will replace, and `idle` is a path nobody has asked about. An
 * `error` snapshot IS quiet — the notice it shows is the picker's settled
 * form for that path, and nothing further is coming.
 */
export function pickerContentQuiet(
  snapshot: WorkspaceSnapshot,
  hasSynopsis: (lineId: string) => boolean,
): boolean {
  if (snapshot.status === "error") return true;
  if (snapshot.status !== "ready") return false;
  const rows = shownRows(snapshot);
  // One row of the cap is the "New session" affordance the list leads with.
  const onScreen = rows.slice(0, PICKER_ROWS_TO_FILL_CAP - 1);
  const filled = rows.length + 1 >= PICKER_ROWS_TO_FILL_CAP;
  const settled = snapshot.scanning !== true;
  if (!filled && !settled) return false;
  return onScreen.every((row) => hasSynopsis(row.line_id));
}

/**
 * The picker's quiet source for an arriving Session card, in the shape the
 * deck reads ({@link ArrivalQuiet}): {@link pickerContentQuiet} over the
 * ledger store's snapshot for the seed path the picker opens on, and the
 * synopsis store's answer for each row.
 *
 * The seed path is read once, at the arrival — the same path the picker's
 * own render reads through its hooks, by the same precedence — because a
 * hidden picker takes no input and the path cannot change under it. The
 * ledger store fetches a path it has never seen the first time it is asked,
 * so the `getSnapshot` here is also what starts the listing.
 *
 * `null` when there is no ledger store — a gallery, a fixture — in which case
 * the deck treats the content as quiet from the first ask.
 */
export function sessionPickerQuiet(): ArrivalQuiet | null {
  const ledger = getSessionLedgerStore();
  if (ledger === null) return null;
  const projectDir = readSeedPath();
  return {
    subscribe: (listener) => {
      const unsubscribeLedger = ledger.subscribe(listener);
      const unsubscribeSynopses = sessionSynopsisStore.subscribe(listener);
      return () => {
        unsubscribeLedger();
        unsubscribeSynopses();
      };
    },
    isQuiet: () =>
      pickerContentQuiet(
        ledger.getSnapshot(projectDir),
        (lineId) => sessionSynopsisStore.getSynopsis(lineId) !== null,
      ),
  };
}
