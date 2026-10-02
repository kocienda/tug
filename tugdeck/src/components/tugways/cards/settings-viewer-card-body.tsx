/**
 * settings-viewer-card-body.tsx — the Viewer Cards settings panel.
 *
 * The deck-wide defaults a newly opened image or PDF adopts. One section for
 * both kinds because they are one card: the viewer renders whichever the file
 * turns out to be, and a reader who opens a screenshot and a spec sheet in
 * the same afternoon should not have to learn that their preferences live in
 * two different places.
 *
 * The controls are the same `ImageCardControls` / `PdfCardControls` each
 * card's own gear sheet renders, bound here to the deck-wide stores — the
 * `settings-text-card-body` arrangement exactly.
 *
 * Self-contained: constructs its own defaults stores at mount and disposes
 * them on unmount. They read/write the deck-wide domains and observe
 * `onDomainChanged`, so an edit here propagates live to every open viewer
 * card that has not yet pinned values of its own.
 *
 * Laws: store snapshots enter via `useSyncExternalStore` [L02]; layout lives
 * in the shared `card-view-controls.css` [L06].
 *
 * @module components/tugways/cards/settings-viewer-card-body
 */

import { useEffect, useState } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import { TugLabel } from "../tug-label";
import { ImageCardControls } from "./image-card-controls";
import { PdfCardControls } from "./pdf-card-controls";
import { DefaultCardSettingsStore } from "@/lib/default-card-settings-store";
import {
  DEFAULT_IMAGE_CARD_SETTINGS,
  IMAGE_CARD_DEFAULTS_DOMAIN,
  IMAGE_CARD_DEFAULTS_KEY,
  parseImageCardSettings,
  type ImageCardSettings,
} from "@/lib/image-card-settings";
import {
  DEFAULT_PDF_CARD_SETTINGS,
  PDF_CARD_DEFAULTS_DOMAIN,
  PDF_CARD_DEFAULTS_KEY,
  parsePdfCardSettings,
  type PdfCardSettings,
} from "@/lib/pdf-card-settings";
import "./settings-viewer-card-body.css";

export function SettingsViewerCardBody() {
  const [imageStore] = useState(
    () =>
      new DefaultCardSettingsStore<ImageCardSettings>({
        defaultsDomain: IMAGE_CARD_DEFAULTS_DOMAIN,
        defaultsKey: IMAGE_CARD_DEFAULTS_KEY,
        parse: parseImageCardSettings,
        builtIn: DEFAULT_IMAGE_CARD_SETTINGS,
      }),
  );
  const [pdfStore] = useState(
    () =>
      new DefaultCardSettingsStore<PdfCardSettings>({
        defaultsDomain: PDF_CARD_DEFAULTS_DOMAIN,
        defaultsKey: PDF_CARD_DEFAULTS_KEY,
        parse: parsePdfCardSettings,
        builtIn: DEFAULT_PDF_CARD_SETTINGS,
      }),
  );
  useEffect(
    () => () => {
      imageStore.dispose();
      pdfStore.dispose();
    },
    [imageStore, pdfStore],
  );

  const imageDefaults = useSyncExternalStore(
    imageStore.subscribe,
    imageStore.getSnapshot,
  );
  const pdfDefaults = useSyncExternalStore(pdfStore.subscribe, pdfStore.getSnapshot);

  return (
    <div
      className="settings-viewer-card"
      data-slot="settings-viewer-card"
      data-testid="settings-viewer-card"
    >
      <TugLabel size="md" className="settings-viewer-card-heading">
        Images
      </TugLabel>
      <ImageCardControls
        settings={imageDefaults}
        onChange={(partial) => imageStore.set(partial)}
      />
      <TugLabel size="md" className="settings-viewer-card-heading">
        PDFs
      </TugLabel>
      <PdfCardControls
        settings={pdfDefaults}
        onChange={(partial) => pdfStore.set(partial)}
      />
    </div>
  );
}
