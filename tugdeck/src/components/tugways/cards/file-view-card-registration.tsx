/**
 * File-view card registration — split from `file-view-card.tsx` so the card
 * body stays a component-only Fast-Refresh boundary (mirrors the
 * `text-card.tsx` / `text-card-registration.tsx` split).
 *
 * No `engineKind: "em"`: a viewer has no editing surface to claim focus, so
 * the generic default-focus walk is the right activation behavior.
 *
 * No `confirmClose`: the card is read-only, so closing one can never lose
 * work.
 *
 * @module components/tugways/cards/file-view-card-registration
 */

import React from "react";
import { registerCard } from "@/card-registry";
import type { CardIdentityFacts } from "@/card-registry";
import { parkedBagPath } from "@/lib/card-identity";
import { basename } from "@/lib/display-path";
import { getOpenFileViewCard } from "@/lib/file-view-open-registry";
import {
  CONTENT_WIDTH_COMFY_PX,
  CONTENT_WIDTH_SLIM_PX,
} from "@/lib/layout-imposer";
import { FileViewCardContent } from "./file-view-card";

/** What a mounted viewer holds — the open registry's bound path. */
function liveFileViewIdentity(cardId: string): CardIdentityFacts | null {
  const path = getOpenFileViewCard(cardId)?.getPath() ?? null;
  if (path === null) return null;
  return { title: basename(path), path };
}

/**
 * What a parked viewer's bag remembers ([P08]) — the same durable door the
 * Text card reads, and for the same reason: a viewer in a workspace nobody
 * has stood up was called "File".
 */
function parkedFileViewIdentity(cardId: string): CardIdentityFacts | null {
  const path = parkedBagPath(cardId);
  if (path === null) return null;
  return { title: basename(path), path };
}

export function registerFileViewCard(): void {
  registerCard({
    componentId: "file-view",
    contentFactory: (cardId) => <FileViewCardContent cardId={cardId} />,
    defaultMeta: { title: "File", icon: "FileText", closable: true },
    category: { label: "Files", icon: "FileText" },
    cardsGroup: "files",
    identity: { live: liveFileViewIdentity, parked: parkedFileViewIdentity },
    sizePolicy: {
      // Sized like the Text card so a viewer opens at the same stature next
      // to one — see `text-card-registration.tsx` for the shared rationale.
      min: { width: CONTENT_WIDTH_SLIM_PX, height: 400 },
      preferred: { width: CONTENT_WIDTH_COMFY_PX, height: 1200 },
    },
    takesContentWidth: true,
  });
}
