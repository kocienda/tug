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
import type { CardIdentityFacts } from "@/card-registry";
import { parkedCardBag, parkedBagPath } from "@/lib/card-identity";
import { basename } from "@/lib/display-path";
import { getOpenTextCard } from "@/lib/text-card-open-registry";
import { formatUntitledName } from "@/lib/untitled-naming";
import {
  CONTENT_WIDTH_COMFY_PX,
  CONTENT_WIDTH_SLIM_PX,
} from "@/lib/layout-imposer";
import { TextCardContent } from "./text-card";

/**
 * What a mounted Text card holds. The open registry is the live truth while
 * the card is standing: the bound path when it has one, the buffer's own
 * display name (`Untitled-2`) when it does not.
 */
function liveTextIdentity(cardId: string): CardIdentityFacts | null {
  const entry = getOpenTextCard(cardId);
  if (entry === null) return null;
  const path = entry.getPath();
  const name = path !== null ? basename(path) : entry.getDisplayName();
  if (name === null) return null;
  return { title: name, path, unsaved: entry.hasUnsavedMark() };
}

/**
 * What a parked Text card's bag remembers ([P08]).
 *
 * Dragging a file card onto a workspace nobody is looking at unregisters it,
 * and every surface naming the card then fell back to `defaultMeta.title` —
 * so the file the user had just moved was thereafter called "File". The bag
 * is where the path already lives. An untitled buffer has no path to take a
 * name from and the number it was allocated rides the bag beside one; this is
 * the same call the card itself makes, so a parked `Untitled-2` is still
 * called that.
 */
function parkedTextIdentity(cardId: string): CardIdentityFacts | null {
  const bag = parkedCardBag(cardId);
  if (bag === null) return null;
  const path = parkedBagPath(cardId);
  if (path !== null) return { title: basename(path), path };
  if (bag.untitled !== true) return null;
  const number = typeof bag.untitledNumber === "number" ? bag.untitledNumber : null;
  return { title: formatUntitledName(number), path: null };
}

export function registerTextCard(): void {
  registerCard({
    componentId: "text",
    contentFactory: (cardId) => <TextCardContent cardId={cardId} />,
    defaultMeta: { title: "File", icon: "FileText", closable: true },
    engineKind: "em",
    category: { label: "Files", icon: "FileText" },
    cardsGroup: "files",
    identity: { live: liveTextIdentity, parked: parkedTextIdentity },
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
