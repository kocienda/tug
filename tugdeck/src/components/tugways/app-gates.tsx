/**
 * AppGates — the app-modals and the update notice, in the one page that
 * shows them.
 *
 * Where the host keeps an overlay above the cards ([B07]) these mount in the
 * overlay page (`overlay/overlay-root.tsx`), the one page nothing covers; in
 * a page the host serves no overlay — a plain browser — the shell mounts them
 * itself (`deck-manager.ts`). Either way it is this one tree, reading the
 * deck through {@link GateDeckContext} rather than the card deck, so neither
 * page has a second copy of what they show.
 *
 * - `TugVersionGate` — app-wide blocking "update macOS" gate. Opens only when
 *   the host version is known-below its line's floor; takes precedence over
 *   ConfigureTug (which suppresses itself while the gate is open) so the two
 *   app-modals never stack (Spec S02).
 * - `TugRestoreGate` — app-wide blocking restore gate. A cold restore's
 *   reveal is one uninterruptible task on the thread every card shares, so
 *   the app answers nothing while it runs; the gate says so for exactly that
 *   long. Suppresses itself under the version gate.
 * - `ConfigureTug` — app-wide blocking setup wizard. Covers the deck until
 *   Claude Code is installed, signed in, and the first session is opened.
 * - `UpdateTug` and `UpdatePill` — the update wizard and its modeless pill,
 *   which hand one zoom rect between them and so share a page.
 *
 * @module components/tugways/app-gates
 */

import React from "react";

import { UpdatePill } from "@/components/chrome/update-pill";
import { ConfigureTug } from "./configure-tug";
import { TugRestoreGate } from "./tug-restore-gate";
import { TugVersionGate } from "./tug-version-gate";
import { UpdateTug } from "./update-tug";

export function AppGates(): React.ReactElement {
  return (
    <>
      <TugVersionGate />
      <TugRestoreGate />
      <ConfigureTug />
      <UpdateTug />
      <UpdatePill />
    </>
  );
}
