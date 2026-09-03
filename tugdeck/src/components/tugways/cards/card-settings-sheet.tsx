/**
 * card-settings-sheet.tsx — a card's own view settings, as a pane-modal
 * sheet.
 *
 * One sheet, three bodies, one per kind of document a card can be showing.
 * The gear in the pane's title bar is a single command ([L30] —
 * `SHOW_CARD_SETTINGS`), and the card that handles it is the only thing that
 * knows what kind it is, so the kind arrives here as an argument rather than
 * being sniffed.
 *
 * A sheet rather than a popover because the trigger is a title-bar button
 * whose command is dispatched through the chain: the press is a command, not
 * an anchor, and the card already presents its save, conflict, and revert
 * decisions as sheets — this joins that family.
 *
 * The controls components are the same ones the Settings card's deck-wide
 * defaults panels render, so a card's own settings and the defaults they came
 * from cannot look like two different instruments.
 *
 * Laws: [L02] every body holds a live subscription through its
 * `useCardSettings` hook, so a change repaints the open sheet;
 * [L19]/[use-tug-components] composes `TugSheet`'s presenter and the real
 * shared controls rather than restating either.
 *
 * @module components/tugways/cards/card-settings-sheet
 */

import React from "react";

import type { ShowSheetOptions } from "@/components/tugways/tug-sheet";
import { TugPushButton } from "../tug-push-button";
import { useTextCardSettings } from "@/lib/use-text-card-settings";
import { useImageCardSettings } from "@/lib/use-image-card-settings";
import { usePdfCardSettings } from "@/lib/use-pdf-card-settings";
import { TextCardControls } from "./text-card-controls";
import { ImageCardControls } from "./image-card-controls";
import { PdfCardControls } from "./pdf-card-controls";
import { MODAL_REST_LINE } from "./modal-rest-line";

type ShowSheet = (options: ShowSheetOptions) => Promise<string | undefined>;

/** Which document a card is showing — the one thing the sheet must be told. */
export type CardSettingsKind = "text" | "image" | "pdf";

/**
 * Each body is a component rather than inline markup because it holds a live
 * subscription: the sheet's `content` render function runs once, so a setting
 * changed inside the sheet has to repaint from the store rather than from a
 * value captured at present time.
 */
function TextCardSettingsBody({ cardId }: { cardId: string }): React.ReactElement {
  const { settings, setSetting } = useTextCardSettings(cardId);
  return (
    <div
      className="text-card-options"
      data-slot="text-card-options"
      data-testid="text-card-options"
    >
      <TextCardControls settings={settings} onChange={setSetting} />
    </div>
  );
}

function ImageCardSettingsBody({ cardId }: { cardId: string }): React.ReactElement {
  const { settings, setSetting } = useImageCardSettings(cardId);
  return (
    <div
      className="card-settings-body"
      data-slot="image-card-settings"
      data-testid="image-card-settings"
    >
      <ImageCardControls settings={settings} onChange={setSetting} />
    </div>
  );
}

function PdfCardSettingsBody({ cardId }: { cardId: string }): React.ReactElement {
  const { settings, setSetting } = usePdfCardSettings(cardId);
  return (
    <div
      className="card-settings-body"
      data-slot="pdf-card-settings"
      data-testid="pdf-card-settings"
    >
      <PdfCardControls settings={settings} onChange={setSetting} />
    </div>
  );
}

/** The sheet's title and body for each kind, in one place. */
const KINDS: Record<
  CardSettingsKind,
  { title: string; Body: React.ComponentType<{ cardId: string }> }
> = {
  text: { title: "Text Card Settings", Body: TextCardSettingsBody },
  image: { title: "Image Settings", Body: ImageCardSettingsBody },
  pdf: { title: "PDF Settings", Body: PdfCardSettingsBody },
};

/**
 * Present the view settings for `cardId`. Resolves when the sheet closes.
 *
 * Every control writes as it is touched — there is nothing to confirm and no
 * Cancel to offer — so the one button is Done, and it says the only thing
 * left to say: this is finished, put it away. Escape and the backdrop close
 * the sheet too; the button is what makes that obvious without trying either.
 */
export function presentCardSettingsSheet(
  showSheet: ShowSheet,
  kind: CardSettingsKind,
  cardId: string,
): Promise<string | undefined> {
  const { title, Body } = KINDS[kind];
  return showSheet({
    title,
    displayWidth: "md",
    presentation: "rise",
    bottomAnchorSelector: MODAL_REST_LINE,
    content: (close) => (
      <>
        <Body cardId={cardId} />
        <div className="tug-sheet-actions">
          <TugPushButton
            size="sm"
            emphasis="primary"
            onClick={() => close("done")}
            data-testid="card-settings-done"
          >
            Done
          </TugPushButton>
        </div>
      </>
    ),
  });
}
