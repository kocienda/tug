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
import {
  CONTENT_WIDTH_COMFY_PX,
  CONTENT_WIDTH_SLIM_PX,
} from "@/lib/layout-imposer";
import { FileViewCardContent } from "./file-view-card";

export function registerFileViewCard(): void {
  registerCard({
    componentId: "file-view",
    contentFactory: (cardId) => <FileViewCardContent cardId={cardId} />,
    defaultMeta: { title: "File", icon: "FileText", closable: true },
    category: { label: "Files", icon: "FileText" },
    cardsGroup: "files",
    sizePolicy: {
      // Sized like the Text card so a viewer opens at the same stature next
      // to one — see `text-card-registration.tsx` for the shared rationale.
      min: { width: CONTENT_WIDTH_SLIM_PX, height: 400 },
      preferred: { width: CONTENT_WIDTH_COMFY_PX, height: 1200 },
    },
    takesContentWidth: true,
  });
}
