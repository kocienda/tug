/**
 * session-picker-panel — the one factory that builds the Choose Session panel.
 *
 * The picker is built in exactly one place because it is rendered in two: the
 * live sheet a Session card raises, and the OFF-SCREEN measuring render the
 * deck takes before it commits the card's pane, to know how tall the panel
 * will be while there is still a commit to write the number into ([P01],
 * [P02]). Two call sites building two trees would make the measured height and
 * the drawn height agree only by the care of whoever edited last; one factory
 * makes them the same tree.
 *
 * The factory lives apart from the form it builds because it is not a
 * component: a `.tsx` exporting both is mixed and non-accepting for Fast
 * Refresh, and the picker is a surface people edit. This file is the small
 * mixed one; `session-picker-form.tsx` is the clean boundary.
 *
 * @module components/tugways/cards/session-picker-panel
 */

import type { OpeningForm } from "@/card-registry";
import type { PickerNotice } from "@/lib/picker-notice-store";
import {
  SessionProjectPickerForm,
  type SessionProjectPickerFormProps,
} from "./session-picker-form";
/**
 * The picker's handlers. Every one is optional: the measuring render supplies
 * none, because a render taken to read a number has nothing to open or cancel,
 * and a panel whose height depended on its handlers would not be measurable at
 * all ([P09]).
 */
export interface SessionPickerHandlers {
  onOpen?: SessionProjectPickerFormProps["onOpen"];
  onCancel?: SessionProjectPickerFormProps["onCancel"];
  onRetryRestore?: SessionProjectPickerFormProps["onRetryRestore"];
  /** The notice the picker stands under when it is re-presented after a failure. */
  notice?: PickerNotice | null;
}

const NOOP = (): void => {};

/**
 * Build the Choose Session panel and the sheet facts that frame it.
 *
 * The return value is an {@link OpeningForm}: the live sheet spreads it into
 * `showSheet` and the registration hands it to the deck as the card's opening
 * form. Both get the same node from the same call, which is the whole of the
 * arrangement — the height the deck reads off a measuring render is the height
 * the user is about to see.
 */
export function sessionPickerPanel({
  cardId,
  handlers = {},
}: {
  cardId: string;
  handlers?: SessionPickerHandlers;
}): OpeningForm {
  return {
    title: "Choose Session",
    icon: "FolderOpen",
    // A path combo box, a filter field, and session rows that carry a
    // three-line summary plus two trailing controls — the decision width
    // truncates all three.
    displayWidth: "lg",
    panel: (
      <SessionProjectPickerForm
        key={cardId}
        notice={handlers.notice ?? null}
        onOpen={handlers.onOpen ?? NOOP}
        onCancel={handlers.onCancel ?? NOOP}
        onRetryRestore={handlers.onRetryRestore ?? null}
      />
    ),
  };
}
