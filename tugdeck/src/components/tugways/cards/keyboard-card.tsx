/**
 * keyboard-card.tsx — Keyboard Shortcuts card (app-level singleton).
 *
 * The keymap configurator: every command Tug can perform, what it is bound to,
 * and a way to change the ones that are the user's to change. The surface
 * itself is {@link SettingsKeymapBody}; this card is its host.
 *
 * It is a card rather than a section of Settings because of what it is made
 * of. The configurator is a `TugListView`, which unmounts rows outside its
 * scrollport and drives `SmartScroll` — it needs a container whose height is
 * definite, and it gets that only from a pane. The Settings card grows to its
 * content and lets the pane scroll it, which is the opposite shape. So the
 * card root fills the pane (`height: 100%; min-height: 0`) and
 * `.settings-keymap`'s existing chain resolves against it unchanged.
 *
 * Shown via the app menu's Keyboard Shortcuts… item, which routes through
 * `DeckManager.showSingletonCard("keyboard")` — at most one exists at a time.
 *
 * Laws: layout lives in keyboard-card.css [L06].
 *
 * @module components/tugways/cards/keyboard-card
 */

import React from "react";
import { registerCard } from "@/card-registry";
import { CONTENT_WIDTH_SLIM_PX } from "@/lib/layout-imposer";
import { SettingsKeymapBody } from "./settings-keymap-body";
import "./keyboard-card.css";

export function KeyboardCardContent() {
  return (
    <div className="keyboard-card" data-testid="keyboard-card">
      <SettingsKeymapBody />
    </div>
  );
}

/**
 * Register the Keyboard Shortcuts card. `hidden` keeps it out of the
 * type-picker `[+]` menu — it is an app-level configurator, not pane content —
 * while the Cards card still lists it. The envelope matches the session and Settings
 * cards: a list this long wants the room.
 *
 * Placement is the deck's to decide. This card is a working surface the user
 * keeps open beside other cards, not a dialog to be dismissed, so it cascades
 * and takes a slot under an imposition like everything else.
 */
export function registerKeyboardCard(): void {
  registerCard({
    componentId: "keyboard",
    contentFactory: () => <KeyboardCardContent />,
    defaultMeta: { title: "Keyboard Shortcuts", icon: "Keyboard", closable: true },
    hidden: true,
    // A list of bindings, read by keyboard ([P10]).
    kbfAtRest: true,
    sizePolicy: {
      // The floor is the slim preset, so every content width is reachable here.
      min: { width: CONTENT_WIDTH_SLIM_PX, height: 600 },
      preferred: { width: 800, height: 1200 },
    },
    takesContentWidth: true,
  });
}
