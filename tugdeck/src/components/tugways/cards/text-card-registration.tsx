/**
 * Text card registration — split from `text-card.tsx` so the card body
 * stays a component-only Fast-Refresh boundary (mirrors the
 * `session-card.tsx` / `session-card-registration.tsx` split).
 *
 * `engineKind: "em"` — the card content owns its own focus lifecycle:
 * activation routes to the body's `onCardActivated` (which lands focus
 * on the CM6 editing surface) instead of the generic default-focus
 * walk.
 *
 * No `confirmClose`: under live autosave there is nothing unsaved to
 * lose — closing a Text card is always safe.
 *
 * @module components/tugways/cards/text-card-registration
 */

import React from "react";
import { registerCard } from "@/card-registry";
import {
  CONTENT_WIDTH_COMFY_PX,
  CONTENT_WIDTH_SLIM_PX,
} from "@/lib/layout-imposer";
import { TextCardContent } from "./text-card";

export function registerTextCard(): void {
  registerCard({
    componentId: "text",
    contentFactory: (cardId) => <TextCardContent cardId={cardId} />,
    defaultMeta: { title: "File", icon: "FileText", closable: true },
    engineKind: "em",
    category: { label: "Files", icon: "FileText" },
    cardsGroup: "files",
    sizePolicy: {
      // Sized like the Session card so a Text card opens at the same stature
      // next to one: the same slim floor, and the same deck-content width at
      // creation (`takesContentWidth` below). The preferred height is
      // deliberately taller than most canvases and `addCard` clamps both
      // dimensions to 90% of the live canvas at creation. The only divergence is
      // the height floor: the Session card's 600 exists to fit its fixed 200px
      // prompt entry + toolbars + transcript minimum, which a Text card has none
      // of, so it can shrink to 400.
      min: { width: CONTENT_WIDTH_SLIM_PX, height: 400 },
      preferred: { width: CONTENT_WIDTH_COMFY_PX, height: 1200 },
    },
    takesContentWidth: true,
  });
}
