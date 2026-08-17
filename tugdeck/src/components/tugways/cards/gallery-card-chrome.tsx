/**
 * gallery-card-chrome.tsx — the deck's three chrome tiers, side by side.
 *
 * This began as a proposal and is now the reference: all three tiers ship.
 * The tiers are
 *
 *   72px masthead, tinted band  → a DOCUMENT card saying its own name
 *   36px title bar, tinted band → a UTILITY card wearing its type's name
 *   32px flush ground           → a RAIL, which is a tool and not a document
 *
 * Everything here is the real chrome: a real `CardTitleBar` inside a real
 * `.tug-pane` wrapper, driven by real `CardMastheadPayload`s, so the reserve
 * arithmetic under the control cluster and the focused/unfocused token pairs
 * are the shipping ones and not a mock's approximation.
 *
 * What this fixture is FOR, now that the tiers are adopted: seeing all three
 * next to each other, and seeing each one's states — focused and receded,
 * dirty and clean, two lines and three, stacked and alone — without having to
 * arrange a deck that produces them. A real Text card shows you one tier in
 * one state; this shows the vocabulary.
 *
 * The Text, File viewer, and Diff cards publish document mastheads of their
 * own, and `TugPane` derives the rail role from the active card's
 * `layoutRole`, so a row here that named a shipping card's chrome would be a
 * second authoring of it. Do not add one — and in particular, do not
 * resurrect `TextCardTopBar`, whose row lived here and which no longer
 * exists: the Text card's actions are rows in its pane's `…` menu now.
 *
 * @module components/tugways/cards/gallery-card-chrome
 */

import React, { useId, useState } from "react";

import { CardTitleBar } from "@/components/chrome/tug-pane";
import type { CardMastheadPayload } from "@/lib/card-title-store";
import type { SlotStackEntry } from "@/deck-store-selectors";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { TugBox } from "@/components/tugways/tug-box";
import { TugCheckbox } from "@/components/tugways/tug-checkbox";
import { useResponderForm } from "@/components/tugways/use-responder-form";

import "./gallery-card-chrome.css";

// ---------------------------------------------------------------------------
// Fixture content
// ---------------------------------------------------------------------------

const NOTES_PATH = "/Users/kocienda/Desktop/session-naming-notes.md";
const SHOT_PATH = "/Users/kocienda/Mounts/u/src/tugtool/docs/shots/masthead-2026-08-10.png";

/**
 * A two-pane stack, so the stack badge renders and the control cluster gets
 * wider — which is the interesting case for the reserve, since every line's
 * stop is measured from `--tugx-pane-controls-width` at runtime.
 */
const STACK: readonly SlotStackEntry[] = [
  {
    paneId: "spike-a",
    cardId: "spike-a",
    title: "session-naming-notes.md",
    icon: "FileText",
    selected: true,
  },
  {
    paneId: "spike-b",
    cardId: "spike-b",
    title: "Project Diff",
    icon: "GitCompareArrows",
    selected: false,
  },
];

function textMasthead(dirty: boolean, detail: boolean): CardMastheadPayload {
  return {
    kind: "card-masthead",
    icon: "FileText",
    title: dirty ? "session-naming-notes.md •" : "session-naming-notes.md",
    description: NOTES_PATH,
    descriptionKind: "path",
    detail: detail ? "Markdown · manual save · UTF-8 · 1,284 words" : null,
  };
}

function fileMasthead(detail: boolean): CardMastheadPayload {
  return {
    kind: "card-masthead",
    icon: "Image",
    title: "masthead-2026-08-10.png",
    description: SHOT_PATH,
    descriptionKind: "path",
    detail: detail ? "PNG · 2560 × 812 · 341 KB" : null,
  };
}

function diffMasthead(detail: boolean): CardMastheadPayload {
  return {
    kind: "card-masthead",
    icon: "GitCompareArrows",
    title: "Project Diff",
    description: "12 files changed  ·  +348 −91",
    detail: detail ? "main ← avid-rope · 3 commits ahead" : null,
  };
}

// ---------------------------------------------------------------------------
// Mock pane frame
// ---------------------------------------------------------------------------

/**
 * The chrome's own wrapper, not a stand-in for it: `.tug-pane` is where the
 * chrome-height property is published and where `data-focused` selects the
 * active token pair, so a demo that skipped it would show the inactive
 * palette for everything and no reserve at all.
 */
function SpikePane({
  focused,
  masthead = false,
  children,
  body,
}: {
  focused: boolean;
  /**
   * Mirrors what `TugPane` stamps on the pane element when its active card
   * publishes a masthead. It has to live HERE and not on the bar: the tier is
   * published as `--tugx-pane-chrome-height` from the pane, so that the scrim
   * and the banner seat below whatever the chrome wears.
   */
  masthead?: boolean;
  children: React.ReactNode;
  body: string;
}) {
  return (
    <div
      className="tug-pane cg-spike-pane"
      data-focused={focused ? "true" : undefined}
      data-masthead={masthead ? "true" : undefined}
    >
      {/* The REAL chrome wrapper, not a stand-in. The deck's inactive recede is
          two blend layers on `.tug-pane-chrome::before/::after`, and it
          establishes the stacking context that confines them — so a fixture
          that skipped it showed every unfocused frame at full strength and
          could not answer what a rail looks like on a card you are not using. */}
      <div className="tug-pane-chrome">
        {children}
        <div className="cg-spike-pane-body">{body}</div>
      </div>
    </div>
  );
}

function SpikeRow({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <div className="cg-spike-row">
      <TugLabel size="2xs" emphasis="calm">
        {caption}
      </TugLabel>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GalleryCardChrome
// ---------------------------------------------------------------------------

export function GalleryCardChrome(): React.ReactElement {
  const [focused, setFocused] = useState(true);
  const [dirty, setDirty] = useState(true);
  const [detail, setDetail] = useState(true);
  const [stacked, setStacked] = useState(false);

  const focusedId = useId();
  const dirtyId = useId();
  const detailId = useId();
  const stackedId = useId();

  const { ResponderScope, responderRef } = useResponderForm({
    toggle: {
      [focusedId]: setFocused,
      [dirtyId]: setDirty,
      [detailId]: setDetail,
      [stackedId]: setStacked,
    },
  });

  const slotStack = stacked ? STACK : undefined;
  const noop = () => {
    /* spike: the chrome is the subject, its actions are not */
  };

  return (
    <ResponderScope>
      <div
        className="cg-content"
        data-testid="gallery-card-chrome"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        <div className="cg-section">
          <TugLabel className="cg-section-title">Card Chrome — three tiers</TugLabel>
          <TugLabel size="2xs" emphasis="calm">
            All three ship: the masthead generalizes from the Session card to every
            document card, and a rail no longer borrows a content card's title bar. Real
            CardTitleBar throughout — nothing here is drawn by hand.
          </TugLabel>
        </div>

        <TugSeparator />

        {/* ---- Controls ---- */}
        <div className="cg-section">
          <TugLabel className="cg-section-title">Preview Controls</TugLabel>
          <TugBox
            variant="bordered"
            rounded="sm"
            style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}
          >
            <TugCheckbox checked={focused} senderId={focusedId} label="Pane focused" size="sm" />
            <TugCheckbox checked={dirty} senderId={dirtyId} label="Unsaved changes" size="sm" />
            <TugCheckbox checked={detail} senderId={detailId} label="Third line" size="sm" />
            <TugCheckbox checked={stacked} senderId={stackedId} label="Stacked (badge)" size="sm" />
          </TugBox>
          <TugLabel size="2xs" emphasis="calm">
            Stacking widens the control cluster. Every masthead line stops short of the
            measured width, so the reserve should visibly follow the badge in and out.
          </TugLabel>
        </div>

        <TugSeparator />

        {/* ---- Tier 1: the document masthead ---- */}
        <div className="cg-section">
          <TugLabel className="cg-section-title">Tier 1 — document card (72px masthead)</TugLabel>
          <TugLabel size="2xs" emphasis="calm">
            A card that holds a named thing says its name, then where it lives. The path is
            the line the Text card currently spends a whole second row on.
          </TugLabel>

          <SpikeRow caption="Text card — name, path, and (optionally) what the status bar knows">
            <SpikePane focused={focused} masthead body="1  Notes:">
              <CardTitleBar
                title="session-naming-notes.md"
                masthead={textMasthead(dirty, detail)}
                widthPreset="comfy"
                onSetWidth={noop}
                slotStack={slotStack}
                onClose={noop}
              />
            </SpikePane>
          </SpikeRow>

          <SpikeRow caption="File viewer — gains a path it does not show anywhere today">
            <SpikePane focused={focused} masthead body="(image)">
              <CardTitleBar
                title="masthead-2026-08-10.png"
                masthead={fileMasthead(detail)}
                widthPreset="wide"
                onSetWidth={noop}
                slotStack={slotStack}
                onClose={noop}
              />
            </SpikePane>
          </SpikeRow>

          <SpikeRow caption="Diff — label and stats move up; the toggles stay on the document header">
            <SpikePane focused={focused} masthead body="tugdeck/src/components/chrome/tug-pane.tsx">
              <CardTitleBar
                title="Project Diff"
                masthead={diffMasthead(detail)}
                widthPreset="comfy"
                onSetWidth={noop}
                slotStack={slotStack}
                onClose={noop}
              />
            </SpikePane>
          </SpikeRow>
        </div>

        <TugSeparator />

        {/* ---- Tier 2: the utility card ---- */}
        <div className="cg-section">
          <TugLabel className="cg-section-title">Tier 2 — utility card (36px, unchanged)</TugLabel>
          <TugLabel size="2xs" emphasis="calm">
            Settings, Keyboard Shortcuts, DevTools, the gallery. These have no document
            identity — a second line under "Settings" would have to be invented — so they
            keep the bar they have.
          </TugLabel>

          <SpikeRow caption="Settings — the tier that already exists">
            <SpikePane focused={focused} body="Appearance · Editor · Sessions">
              <CardTitleBar
                title="Settings"
                icon="Settings"
                widthPreset="comfy"
                onSetWidth={noop}
                slotStack={slotStack}
                onClose={noop}
              />
            </SpikePane>
          </SpikeRow>
        </div>

        <TugSeparator />

        {/* ---- Tier 3: the rail ---- */}
        <div className="cg-section">
          <TugLabel className="cg-section-title">Tier 3 — rail (32px, flush)</TugLabel>
          <TugLabel size="2xs" emphasis="calm">
            A rail pins to a deck edge, takes its width from the allocator rather than a
            preset, and insets the band the content cards live in. So it says so: a flush
            ground instead of the tinted title band, and racing stripes flanking a centered
            glyph and tracked label. The ground never lights up with focus — that is what
            flush means — and the stripes carry the state instead.
          </TugLabel>

          {/* Lens, Jots and Overview register no icon today — adopting this
              means adding one to those three registrations. */}
          <SpikeRow caption="Focused and unfocused, together — the pair is the point, not either alone">
            <SpikePane focused body="Cards · Layouts · Sessions">
              <CardTitleBar title="Lens" icon="Microscope" sidebar onClose={noop} />
            </SpikePane>
            <SpikePane focused={false} body="Filter · New jot">
              <CardTitleBar title="Jots" icon="NotebookPen" sidebar onClose={noop} />
            </SpikePane>
          </SpikeRow>

          <TugLabel size="2xs" emphasis="calm">
            The rail&apos;s own focus step is one notch of the global ladder per element —
            hairline ink to strong for the stripes, muted to default for the label and
            glyph. It is deliberately small: an unfocused pane is already dimmed deck-wide
            by the two blend layers on <code>.tug-pane-chrome</code>, and a rail that also
            dimmed itself hard would compound with that wash and vanish. A 1px stripe has
            no contrast to give away twice.
          </TugLabel>

          <SpikeRow caption="Follows the checkbox, for stepping between the two">
            <SpikePane focused={focused} body="Cards · Layouts · Sessions">
              <CardTitleBar title="Lens" icon="Microscope" sidebar onClose={noop} />
            </SpikePane>
          </SpikeRow>

          <SpikeRow caption="Before — the content card's bar a rail used to wear">
            <SpikePane focused={focused} body="Cards · Layouts · Sessions">
              <CardTitleBar title="Lens" onClose={noop} />
            </SpikePane>
          </SpikeRow>
        </div>
      </div>
    </ResponderScope>
  );
}
