/**
 * settings-card.tsx — Settings card (app-level singleton).
 *
 * A single card hosting the app's preference groups in a `TugTabView`: a
 * sidebar of sections on the left, the selected section's panel on the right
 * — the macOS System Settings shape. Shown via the app menu's Settings… item
 * (⌘,), which routes through `DeckManager.showSingletonCard("settings")` — at
 * most one Settings card exists at a time.
 *
 * Its pane is placed, sized, and imposed like any other card's: it cascades
 * on open and takes a slot under an imposition. Settings is a surface the
 * user arranges alongside the work it is about, not a modal to be dismissed.
 *
 * The card fills its pane and the tab view's detail area owns the scroller,
 * so the sidebar holds still while a long panel scrolls. What is persisted is
 * the **selected section** (see `lib/settings-sections-pref.ts`), so a
 * reopened Settings lands where the reader last was.
 *
 * **An unselected section's body does not exist.** `TugTabViewItem` renders
 * nothing while unselected, so a body's stores are constructed when its
 * section is chosen and torn down when the selection leaves — live
 * propagation holds only while that section is showing.
 *
 * The sidebar is the card's single focus stop and it is seeded on open
 * ([P12] via `useSeedKeyView`), so the section list wears the keyboard cursor
 * from the moment the card appears — the arrows work immediately, and the mark
 * says so.
 *
 * The keymap configurator is not here — it lives in the Keyboard Shortcuts
 * card (`keyboard-card.tsx`), reachable from the app menu and the Cards card.
 *
 * Laws: the selected section is external state read through `useTugbankValue`
 * ([L02] via `useSyncExternalStore`); the tab view dispatches `selectTab`
 * through the chain to this card's responder scope ([L11] via
 * `useResponderForm`); layout lives in settings-card.css [L06].
 *
 * @module components/tugways/cards/settings-card
 */

import React, { useCallback, useId, useLayoutEffect, useState } from "react";
import { FileText, Image, MessageSquareText, Settings2 } from "lucide-react";
import { registerCard } from "@/card-registry";
import { CONTENT_WIDTH_SLIM_PX } from "@/lib/layout-imposer";
import { TugTabView, TugTabViewItem } from "@/components/tugways/tug-tab-view";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import {
  SETTINGS_SECTION_IDS,
  useSettingsSelectedSection,
  type SettingsSectionId,
} from "@/lib/settings-sections-pref";
import { registerSettingsRevealConsumer } from "@/lib/settings-reveal";
import { SettingsSessionCardBody } from "./settings-session-card-body";
import { SettingsViewerCardBody } from "./settings-viewer-card-body";
import { SettingsTextCardBody } from "./settings-text-card-body";
import { SettingsGeneralBody } from "./settings-general-body";
import "./settings-card.css";

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface SettingsSectionSpec {
  readonly id: SettingsSectionId;
  readonly label: string;
  /** Distinct per-section lucide icon, rendered in the sidebar. */
  readonly Icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  readonly Body: React.ComponentType;
}

const SECTIONS: readonly SettingsSectionSpec[] = [
  // "General" wears a sliders icon for app-wide preferences; "Sessions"
  // wears the session card's own icon; "Text Files" a file icon.
  { id: "general", label: "General", Icon: Settings2, Body: SettingsGeneralBody },
  {
    id: "sessionCard",
    label: "Sessions",
    Icon: MessageSquareText,
    Body: SettingsSessionCardBody,
  },
  { id: "textCard", label: "Text Files", Icon: FileText, Body: SettingsTextCardBody },
  // One section for both viewer kinds — images and PDFs are one card, and a
  // reader should not have to learn that their preferences live in two places.
  {
    id: "viewerCard",
    label: "Viewer Cards",
    Icon: Image,
    Body: SettingsViewerCardBody,
  },
];

// ---------------------------------------------------------------------------
// SettingsCardContent
// ---------------------------------------------------------------------------

export function SettingsCardContent() {
  const { selected, setSelected } = useSettingsSelectedSection();

  // A section a reveal has steered to, held only for this card's lifetime —
  // the persisted selection is never written by a reveal, so the reader's own
  // place comes back on the next plain open ([L24] local-data). The reader's
  // own next pick clears it and persists.
  const [override, setOverride] = useState<SettingsSectionId | null>(null);
  const active = override ?? selected;

  const reveal = useCallback((section: SettingsSectionId) => {
    setOverride(section);
  }, []);

  // [L03]: register in a layout effect so a request parked before this card
  // mounted is flushed before paint; [L27] the registration returns its
  // unregister.
  useLayoutEffect(() => registerSettingsRevealConsumer(reveal), [reveal]);

  // The tab view dispatches `selectTab` through the chain to this responder.
  const tabViewSenderId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    selectTab: {
      [tabViewSenderId]: (next: string) => {
        if (!SETTINGS_SECTION_IDS.includes(next as SettingsSectionId)) return;
        setSelected(next as SettingsSectionId);
        setOverride(null);
      },
    },
  });

  // One item-container focus stop: Up/Down rove the sidebar and switch the
  // panel live.
  const focusGroup = useId();

  // Seed the key view onto that stop with KEYBOARD modality, so the cursor ring
  // is on the selected section the moment the card opens ([P12]). Without the
  // seed the sidebar still holds the key view and still answers the arrows —
  // it is the card's only stop — but at pointer modality, so it showed no mark
  // until the first arrow. A surface that is already listening has to look like
  // it is listening.
  useSeedKeyView(`${focusGroup}:0`);

  return (
    <ResponderScope>
      <div
        className="settings-card"
        data-testid="settings-card"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        <TugTabView
          value={active}
          senderId={tabViewSenderId}
          focusGroup={focusGroup}
          focusOrder={0}
          className="settings-card-sections"
        >
          {SECTIONS.map((spec) => (
            <TugTabViewItem
              key={spec.id}
              value={spec.id}
              label={spec.label}
              icon={<spec.Icon size={16} strokeWidth={2} />}
              data-testid={`settings-section-${spec.id}`}
            >
              <spec.Body />
            </TugTabViewItem>
          ))}
        </TugTabView>
      </div>
    </ResponderScope>
  );
}

// ---------------------------------------------------------------------------
// registerSettingsCard
// ---------------------------------------------------------------------------

/**
 * Register the Settings card. `hidden` keeps it out of the type-picker
 * `[+]` menu: it is reachable only through the app menu (⌘,).
 */
export function registerSettingsCard(): void {
  registerCard({
    componentId: "settings",
    contentFactory: () => <SettingsCardContent />,
    defaultMeta: { title: "Settings", icon: "Settings", closable: true },
    hidden: true,
    // A configurator: sidebar, tabs, and controls, all engine stops ([P10]).
    // The panel bodies are tabs of this one card rather than registrations of
    // their own, so this single declaration covers them.
    kbfAtRest: true,
    sizePolicy: {
      // Master/detail wants width more than height: room for the sidebar plus
      // a comfortable panel measure. A long panel scrolls in the detail area.
      // The floor is the slim preset, so every content width is reachable here.
      min: { width: CONTENT_WIDTH_SLIM_PX, height: 520 },
      preferred: { width: 900, height: 760 },
    },
    takesContentWidth: true,
  });
}
