/**
 * settings-text-card-body.tsx — the Text Card settings panel.
 *
 * The deck-wide defaults a newly opened Text card adopts on first open.
 * The Editing + Display view settings are the shared `TextCardControls`
 * (the same component the per-card gear popover renders), bound here to
 * the deck-wide defaults store.
 *
 * Self-contained: constructs its own `DefaultTextCardStore` at mount
 * and disposes it on unmount. The store reads/writes the **deck-wide**
 * `dev.tugapp.text-card` domain and observes `onDomainChanged`, so
 * edits here propagate live to every open Text card that has not yet
 * pinned its own per-card values.
 *
 * Laws: store snapshot enters via `useSyncExternalStore` [L02]; layout
 * lives in settings-text-card-body.css [L06].
 *
 * @module components/tugways/cards/settings-text-card-body
 */

import React, { useEffect, useState, useSyncExternalStore } from "react";
import { TextCardControls } from "./text-card-controls";
import { DefaultTextCardStore } from "@/lib/default-text-card-store";
import type { TextCardSettings } from "@/lib/text-card-settings";
import "./settings-text-card-body.css";

export function SettingsTextCardBody() {
  const [defaultsStore] = useState(() => new DefaultTextCardStore());
  useEffect(() => () => defaultsStore.dispose(), [defaultsStore]);

  const defaults = useSyncExternalStore(
    defaultsStore.subscribe,
    defaultsStore.getSnapshot,
  );

  const onChange = (partial: Partial<TextCardSettings>) =>
    defaultsStore.set(partial);

  return (
    <div
      className="settings-text-card"
      data-slot="settings-text-card"
      data-testid="settings-text-card"
    >
      <TextCardControls settings={defaults} onChange={onChange} />
    </div>
  );
}
