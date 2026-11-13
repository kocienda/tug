/**
 * `commitSessionRename` — the one way a session's name is changed from a card.
 *
 * Every rename door funnels here — `/rename <text>`, `/unname`, and the
 * masthead's inline name editor: optimistically update the name via
 * {@link sessionNameStore}, then send the `rename_session` CONTROL frame.
 * tugcast writes the ledger and broadcasts `session_updated`, which makes the
 * name authoritative for the title and the session chooser.
 *
 * The optimistic write is paired with a settle waiter holding the name it
 * replaced, so a refused rename puts the old name back instead of leaving the
 * title showing a name the ledger never took. The outcome is reported in the
 * card's bulletin when the ack lands, rather than claimed on the gesture.
 *
 * A module of its own, with no component and no stylesheet behind it, so a
 * surface that only needs to commit a name does not import a dialog to do it.
 *
 * Laws: [L07] the binding and the connection are read fresh at each call, and
 *       the bulletin through a live getter.
 *
 * @module lib/session-rename-commit
 */

import type { TugPaneBulletinApi } from "@/components/tugways/tug-pane-bulletin";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { getConnection } from "@/lib/connection-singleton";
import {
  renameRefusalDetail,
  sessionNameStore,
} from "@/lib/session-name-store";
import { encodeRenameSession } from "@/protocol";

/**
 * Rename the session bound to `cardId`: the optimistic name update and the
 * `rename_session` frame, with the replaced name held for the refusal path.
 * A no-op when the card isn't bound. A blank name clears the name. `notify`
 * is the card's live bulletin getter, read once here and spoken through when
 * the ack lands.
 */
export function commitSessionRename(
  cardId: string,
  name: string,
  notify: () => TugPaneBulletinApi | null,
): void {
  const binding = cardSessionBindingStore.getBinding(cardId);
  const connection = getConnection();
  if (binding === undefined || connection === null) return;
  const trimmed = name.trim();
  const previous = sessionNameStore.getName(binding.lineId);
  const bulletin = notify();
  sessionNameStore.setName(binding.lineId, trimmed);
  sessionNameStore.awaitSettle(binding.lineId, trimmed, previous, (settle) => {
    if (settle.ok) {
      // A name another line wore is taken by the newest gesture ([P11]),
      // and the bulletin says whom it was taken from — a name that
      // vanished off another card unannounced would be a change at a
      // distance.
      const takenFrom = (settle.displaced ?? [])
        .map((holder) => holder.tag)
        .filter((tag) => tag.length > 0);
      bulletin?.success(
        trimmed.length === 0
          ? "Session name cleared"
          : `Session renamed to “${trimmed}”`,
        takenFrom.length === 0
          ? undefined
          : {
              description: `The name was taken from ${takenFrom.join(", ")}.`,
            },
      );
      return;
    }
    bulletin?.danger(
      previous === null
        ? "The session was not renamed"
        : `The session is still named “${previous}”`,
      {
        description: renameRefusalDetail(settle.reason),
        sticky: true,
      },
    );
  });
  const frame = encodeRenameSession(binding.lineId, trimmed);
  connection.send(frame.feedId, frame.payload);
}
