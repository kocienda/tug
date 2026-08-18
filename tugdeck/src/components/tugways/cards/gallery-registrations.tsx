/**
 * Gallery card registrations.
 *
 * Registers all gallery card types in the global card registry.
 * Also exports GALLERY_DEFAULT_CARDS and small adapter components.
 *
 * **Authoritative references:**
 * - [D01] Seven separate componentIds for gallery sections
 * - [D08] Normal tabs: each section is a distinct componentId
 * - [D09] Every registration has a contentFactory
 * - [D06] Gallery palette tab follows existing gallery card pattern
 * -: Gallery registrations
 * -: Gallery default tabs
 * - (#s03-gallery-registrations, #s04-gallery-default-tabs, #symbol-inventory)
 *
 * @module components/tugways/cards/gallery-registrations
 */

import React, { useId, useState } from "react";
import { Star, ShieldCheck, Bot, Gauge, Hash } from "lucide-react";
import { registerCard, type CardSizePolicy } from "@/card-registry";
import { TugBadge } from "@/components/tugways/tug-badge";
import type { TugBadgeEmphasis, TugBadgeRole, TugBadgeSize } from "@/components/tugways/tug-badge";
import { TugPopupButton } from "@/components/tugways/tug-popup-button";
import type { TugPopupButtonItem } from "@/components/tugways/tug-popup-button";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import type { CardState } from "@/layout-tree";
import { GalleryPushButton } from "./gallery-push-button";
import { GalleryChainActions } from "./gallery-chain-actions";
import { GalleryMutation } from "./gallery-mutation";
import { GalleryTabBar } from "./gallery-tab-bar";
import { GalleryDefaultButton } from "./gallery-default-button";
import { GalleryTitleBar } from "./gallery-title-bar";
import { GalleryCardChrome } from "./gallery-card-chrome";
import { GalleryChangesHeaders } from "./gallery-changes-headers";
import { GalleryMutationTx } from "./gallery-mutation-tx";
import { GalleryObservableProps } from "./gallery-observable-props";
import { GalleryThemeEditor } from "./gallery-theme-editor";
import { GalleryColorWells, GalleryColorPicker } from "./gallery-color-picker";
import { GalleryScaleTiming } from "./gallery-scale-timing";
import { GalleryAnimator } from "./gallery-animator";
import { GallerySkeleton } from "./gallery-skeleton";
import { GalleryInput } from "./gallery-input";
import { GalleryFileChooser } from "./gallery-file-chooser";
import { GalleryLabel } from "./gallery-label";
import { GalleryMarquee } from "./gallery-marquee";
import { GalleryCheckbox } from "./gallery-checkbox";
import { GallerySwitch } from "./gallery-switch";
import { GalleryThemeAccessibility } from "./gallery-theme-accessibility";
import { GalleryPopupButton } from "./gallery-popup-button";
import { GalleryIconButton } from "./gallery-icon-button";
import { GallerySlider } from "./gallery-slider";
import { GalleryValueInput } from "./gallery-value-input";
import { GalleryRadioGroup } from "./gallery-radio-group";
import { GalleryChoiceGroup } from "./gallery-choice-group";
import { GalleryConfirmPopover } from "./gallery-confirm-popover";
import { GalleryContextMenu } from "./gallery-context-menu";
import { GalleryOptionGroup } from "./gallery-option-group";
import { GalleryPopover } from "./gallery-popover";
import { GalleryBox } from "./gallery-box";
import { GalleryTextarea } from "./gallery-textarea";
import { GallerySeparator } from "./gallery-separator";
import { GallerySlotLayout } from "./gallery-slot-layout";
import { GalleryTugClamp } from "./gallery-tug-clamp";
import { GalleryAccordion } from "./gallery-accordion";
import { GalleryTooltip } from "./gallery-tooltip";
import { GalleryBanner } from "./gallery-banner";
import { GalleryCardBanner } from "./gallery-card-banner";
import { GalleryAlert } from "./gallery-alert";
import { GalleryModalInputDialog } from "./gallery-modal-input-dialog";
import { GalleryTugInlineDialog } from "./gallery-tug-inline-dialog";
import { GalleryTugDialogButton } from "./gallery-tug-dialog-button";
import { GallerySheet } from "./gallery-sheet";
import { GalleryBulletin } from "./gallery-bulletin";
import { GalleryPaneBulletin } from "./gallery-pane-bulletin";
import { GalleryMarkdownView } from "./gallery-markdown-view";
import { GalleryTranscriptCopy } from "./gallery-transcript-copy";
import { GalleryListView } from "./gallery-list-view";
import { GalleryListViewFilter } from "./gallery-list-view-filter";
import { GalleryListViewFocus } from "./gallery-list-view-focus";
import { GalleryFocusLanguage } from "./gallery-focus-language";
import { GalleryCycleDemo } from "./gallery-cycle-demo";
import { GalleryListViewHeaders } from "./gallery-list-view-headers";
import { GalleryTugListRow } from "./gallery-tug-list-row";
import { GalleryTranscriptEntry } from "./gallery-transcript-entry";
import { GalleryAtom } from "./gallery-atom";
import { GalleryAttachmentStrip } from "./gallery-attachment-strip";
import { GalleryPromptEntry } from "./gallery-prompt-entry";
import { GalleryTextEditor } from "./gallery-text-editor";
import { GallerySplitPane } from "./gallery-split-pane";
import { GalleryStatePreservation } from "./gallery-state-preservation";
import { GalleryTugCue } from "./gallery-tug-cue";
import { GalleryBashToolBlock } from "./gallery-bash-tool-block";
import { GalleryTranscriptRegisters } from "./gallery-transcript-registers";
import { GalleryCommitSurfaces } from "./gallery-commit-surfaces";
import { GalleryPinnedHeaders } from "./gallery-pinned-headers";
import { GallerySessionThinking } from "./gallery-session-thinking";
import { GalleryJsonTreeBlock } from "./gallery-json-tree-block";
import { GalleryToolBlockFile } from "./gallery-tool-block-file";
import { GalleryToolBlockDefault } from "./gallery-tool-block-default";
import { GalleryImageBlock } from "./gallery-image-block";
import { GalleryDevChrome } from "./gallery-dev-chrome";
import { GalleryTugLinearGauge } from "./gallery-tug-linear-gauge";
import { GalleryTugArcGauge } from "./gallery-tug-arc-gauge";
import { GalleryTugProgressIndicator } from "./gallery-tug-progress-indicator";
import { GalleryMotionBench } from "./gallery-motion-bench";
import { GalleryPulseDisplay } from "./gallery-pulse-display";
import { GallerySessionIdentity } from "./gallery-session-identity";
import { GalleryConfigureTug } from "./gallery-configure-tug";
import { GalleryModalHeaders } from "./gallery-modal-headers";
import { GalleryBlockHeader } from "./gallery-tool-call-header";
import "./gallery.css";
import { TUG_ACTIONS } from "../action-vocabulary";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

// ---------------------------------------------------------------------------
// GALLERY_DEFAULT_CARDS
// ---------------------------------------------------------------------------

/**
 * Default card templates for the gallery host stack.
 *
 * Only `gallery-buttons` uses these — passed as `defaultCards` so that
 * `addCard("gallery-buttons")` creates a starter stack with one card from
 * each of the first four `+` menu groups (Buttons, Text Input & Display,
 * Selection, Overlays). The remaining component demos are still discoverable
 * via the `+` type picker. Template `id` values are placeholders:
 * `DeckManager.addCard` replaces them with fresh UUIDs.
 */
export const GALLERY_DEFAULT_CARDS: readonly CardState[] = [
  { id: "template", componentId: "gallery-buttons",  title: "TugPushButton", closable: true },
  { id: "template", componentId: "gallery-input",    title: "TugInput",      closable: true },
  { id: "template", componentId: "gallery-checkbox", title: "TugCheckbox",   closable: true },
  { id: "template", componentId: "gallery-popover",  title: "TugPopover",    closable: true },
];

// ---------------------------------------------------------------------------
// TugPopupButtonDemo
// ---------------------------------------------------------------------------

/** Sample items for the TugPopupButton gallery demo. Module-scope to avoid recreation. */
const DEMO_POPUP_BUTTON_ITEMS: TugPopupButtonItem<string>[] = [
  { action: TUG_ACTIONS.SET_VALUE, value: "option-alpha", label: "Alpha",            icon: <Star size={12} /> },
  { action: TUG_ACTIONS.SET_VALUE, value: "option-beta",  label: "Beta",             icon: <Star size={12} /> },
  { action: TUG_ACTIONS.SET_VALUE, value: "option-gamma", label: "Gamma (disabled)", disabled: true },
];

/**
 * TugPopupButtonDemo -- standalone TugPopupButton demo.
 *
 * Renders a TugPopupButton with sample items. Selecting an item updates status text.
 */
export function TugPopupButtonDemo() {
  const [lastSelected, setLastSelected] = useState<string | null>(null);
  const popupId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    setValueString: {
      [popupId]: setLastSelected,
    },
  });

  return (
    <ResponderScope>
    <div
      className="cg-popup-button-demo"
      ref={responderRef as (el: HTMLDivElement | null) => void}
    >
      <TugPopupButton
        label="Open Menu"
        size="sm"
        senderId={popupId}
        items={DEMO_POPUP_BUTTON_ITEMS}
      />
      {lastSelected !== null && (
        <TugLabel size="2xs" emphasis="calm">{`Selected: ${lastSelected}`}</TugLabel>
      )}
    </div>
    </ResponderScope>
  );
}

// ---------------------------------------------------------------------------
// GalleryBadge
// ---------------------------------------------------------------------------

/**
 * All role combinations for the TugBadge showcase matrix. Includes
 * the `inherit` role — paints text / icon / border in
 * `currentColor` so the badge blends into the surrounding text
 * rather than reading as a separate colour signal. See the
 * `TugBadgeRole` docstring in `tug-badge.tsx` for the full
 * contract.
 */
const ALL_BADGE_ROLES: TugBadgeRole[] = ["accent", "action", "agent", "data", "danger", "success", "caution", "inherit"];
const ALL_BADGE_SIZES: TugBadgeSize[] = ["2xs", "xs", "sm", "md", "lg", "xl", "2xl"];
const ALL_BADGE_EMPHASES: TugBadgeEmphasis[] = ["filled", "outlined", "tinted", "ghost"];

/**
 * Per-emphasis role list. All four emphases carry the seven semantic
 * roles; only the `inherit` role differs — `filled-inherit` is
 * intentionally not provided (its `currentColor` background would equal
 * the surrounding text colour, collapsing its own contrast — see the
 * inherit-role docstring in `tug-badge.tsx`), so it is skipped under the
 * `filled` emphasis and shown under the other three.
 */
function badgeRolesFor(emphasis: TugBadgeEmphasis): TugBadgeRole[] {
  return emphasis === "filled"
    ? ALL_BADGE_ROLES.filter((role) => role !== "inherit")
    : ALL_BADGE_ROLES;
}

/**
 * Realistic session-card Z4B chrome faces for the two-line layout demos —
 * the permission-mode / model / rate-limit / session indicators that
 * later steps mount into the prompt-entry band. Each pairs a
 * letter-spaced caption with the value the chip displays, plus the
 * leading icon the icon variants show.
 */
const TWO_LINE_BADGE_CHIPS: { label: string; content: string; role: TugBadgeRole; icon: React.ReactNode }[] = [
  { label: "MODE", content: "accept", role: "action", icon: <ShieldCheck /> },
  { label: "MODEL", content: "Opus 4.8 · 1M", role: "agent", icon: <Bot /> },
  { label: "LIMIT", content: "5h 23m", role: "data", icon: <Gauge /> },
  { label: "SESSION", content: "6d77f06e", role: "accent", icon: <Hash /> },
];

/** The two rate-limit faces the width-stabilized slot cycles between. */
const RATE_LIMIT_NARROW = "5h 23m";
const RATE_LIMIT_WIDE = "rate-limited";

/**
 * GalleryBadge -- TugBadge showcase gallery tab.
 *
 * A leading Sizes section ramps the full size scale at a single
 * role; the matrices below show every emphasis (filled / outlined /
 * tinted / ghost) across all 8 roles at all sizes, in both text-only
 * and icon + text form. Two-line layouts (`label-top` / `content-top`)
 * follow, ramped across the size scale and shown across all four
 * emphases, capped by a width-stabilized slot.
 *
 * The eighth role (`inherit`) paints text / icon / border in
 * `currentColor` so the badge blends into the surrounding text —
 * primary callsite is the Z1B end-state "OK" tone in the transcript.
 * It is shown under outlined / tinted / ghost; `filled-inherit` is
 * intentionally not provided — its bg would equal the surrounding
 * text colour, collapsing its own contrast — so the filled matrix
 * skips it (see `badgeRolesFor` and the inherit-role docstring in
 * `tug-badge.tsx`).
 */
export function GalleryBadge() {
  // The width-stabilized slot cycles the rate-limit value between a
  // narrow and a wide face. Cycling the *content* is data, not
  // appearance — the chip's painted geometry is owned entirely by CSS
  // ([L06]); this state only chooses which string the chip renders.
  const [rateLimit, setRateLimit] = useState<string>(RATE_LIMIT_NARROW);
  const rateLimitAlternate =
    rateLimit === RATE_LIMIT_NARROW ? RATE_LIMIT_WIDE : RATE_LIMIT_NARROW;

  return (
    <div className="cg-content" data-testid="gallery-badge">

      {/* ---- Sizes ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">TugBadge — Sizes</TugLabel>
        <div className="cg-matrix">
          <div className="cg-subtype-block">
            <TugLabel size="2xs" emphasis="calm">text only</TugLabel>
            <div className="cg-variant-row">
              <div className="cg-size-group">
                {ALL_BADGE_SIZES.map((size) => (
                  <TugBadge key={size} emphasis="tinted" role="action" size={size}>
                    {size}
                  </TugBadge>
                ))}
              </div>
            </div>
          </div>
          <div className="cg-subtype-block">
            <TugLabel size="2xs" emphasis="calm">icon + text</TugLabel>
            <div className="cg-variant-row">
              <div className="cg-size-group">
                {ALL_BADGE_SIZES.map((size) => (
                  <TugBadge key={size} emphasis="tinted" role="action" size={size} icon={<Star />}>
                    {size}
                  </TugBadge>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <TugSeparator />

      {ALL_BADGE_EMPHASES.map((emphasis) => (
        <React.Fragment key={emphasis}>
          <div className="cg-section">
            <TugLabel className="cg-section-title">{`TugBadge — ${emphasis}`}</TugLabel>
            <div className="cg-matrix">
              <div className="cg-subtype-block">
                <TugLabel size="2xs" emphasis="calm">text only</TugLabel>
                {badgeRolesFor(emphasis).map((role) => (
                  <div key={role} className="cg-variant-row">
                    <TugLabel size="2xs" emphasis="calm">{role}</TugLabel>
                    <div className="cg-size-group">
                      {ALL_BADGE_SIZES.map((size) => (
                        <TugBadge key={size} emphasis={emphasis} role={role} size={size}>
                          {role}
                        </TugBadge>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="cg-subtype-block">
                <TugLabel size="2xs" emphasis="calm">icon + text</TugLabel>
                {badgeRolesFor(emphasis).map((role) => (
                  <div key={role} className="cg-variant-row">
                    <TugLabel size="2xs" emphasis="calm">{role}</TugLabel>
                    <div className="cg-size-group">
                      {ALL_BADGE_SIZES.map((size) => (
                        <TugBadge key={size} emphasis={emphasis} role={role} size={size} icon={<Star />}>
                          {role}
                        </TugBadge>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          {emphasis !== ALL_BADGE_EMPHASES[ALL_BADGE_EMPHASES.length - 1] && <TugSeparator />}
        </React.Fragment>
      ))}

      <TugSeparator />

      {/* ---- Two-line layouts ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">TugBadge — Two-line layouts</TugLabel>
        <div className="cg-matrix">
          <div className="cg-subtype-block">
            <TugLabel size="2xs" emphasis="calm">label-top — caption above value, with leading icon (status-bar parity)</TugLabel>
            <div className="cg-variant-row" data-testid="badge-label-top-row">
              {TWO_LINE_BADGE_CHIPS.map((chip) => (
                <TugBadge
                  key={chip.label}
                  layout="label-top"
                  label={chip.label}
                  icon={chip.icon}
                  emphasis="tinted"
                  role={chip.role}
                  size="lg"
                >
                  {chip.content}
                </TugBadge>
              ))}
            </div>
          </div>
          <div className="cg-subtype-block">
            <TugLabel size="2xs" emphasis="calm">content-top — value above caption</TugLabel>
            <div className="cg-variant-row" data-testid="badge-content-top-row">
              {TWO_LINE_BADGE_CHIPS.map((chip) => (
                <TugBadge
                  key={chip.label}
                  layout="content-top"
                  label={chip.label}
                  icon={chip.icon}
                  emphasis="tinted"
                  role={chip.role}
                  size="lg"
                >
                  {chip.content}
                </TugBadge>
              ))}
            </div>
          </div>
          <div className="cg-subtype-block">
            <TugLabel size="2xs" emphasis="calm">label-top — size ramp (two-line height scale, 2xs → 2xl)</TugLabel>
            <div className="cg-variant-row" data-testid="badge-two-line-size-ramp">
              <div className="cg-size-group">
                {ALL_BADGE_SIZES.map((size) => (
                  <TugBadge
                    key={size}
                    layout="label-top"
                    label="MODEL"
                    icon={<Bot />}
                    emphasis="tinted"
                    role="agent"
                    size={size}
                  >
                    {size}
                  </TugBadge>
                ))}
              </div>
            </div>
          </div>
          <div className="cg-subtype-block">
            <TugLabel size="2xs" emphasis="calm">label-top — across emphases</TugLabel>
            <div className="cg-variant-row" data-testid="badge-two-line-emphases">
              {ALL_BADGE_EMPHASES.map((emphasis) => (
                <TugBadge
                  key={emphasis}
                  layout="label-top"
                  label="MODE"
                  icon={<ShieldCheck />}
                  emphasis={emphasis}
                  role="action"
                  size="lg"
                >
                  accept
                </TugBadge>
              ))}
            </div>
          </div>
          <div className="cg-subtype-block">
            <TugLabel size="2xs" emphasis="calm">single — the one-row pill, unchanged</TugLabel>
            <div className="cg-variant-row" data-testid="badge-single-row">
              {TWO_LINE_BADGE_CHIPS.map((chip) => (
                <TugBadge key={chip.label} emphasis="tinted" role={chip.role} size="md" icon={chip.icon}>
                  {`${chip.label} ${chip.content}`}
                </TugBadge>
              ))}
            </div>
          </div>
        </div>
      </div>

      <TugSeparator />

      {/* ---- Width-stabilized slot ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">TugBadge — Width-stabilized slot</TugLabel>
        <TugLabel size="2xs" emphasis="calm">
          A rate-limit chip reserves the wider of its two faces so cycling the value never shifts Z4B layout ([R01]).
        </TugLabel>
        <div className="cg-variant-row">
          {/* The active chip and a hidden alternate stack in one grid cell, so
              the slot is always as wide as the wider face. Toggling the value
              swaps which face is visible; the reserved width never moves. */}
          <span className="cg-badge-stable-slot" data-testid="badge-stable-slot">
            <TugBadge
              layout="label-top"
              label="LIMIT"
              emphasis="tinted"
              role="data"
              size="lg"
              data-testid="badge-stable-active"
            >
              {rateLimit}
            </TugBadge>
            <TugBadge
              layout="label-top"
              label="LIMIT"
              emphasis="tinted"
              role="data"
              size="lg"
              className="cg-badge-stable-ghost"
              aria-hidden
            >
              {rateLimitAlternate}
            </TugBadge>
          </span>
          <button
            type="button"
            className="cg-demo-button"
            data-testid="badge-stable-toggle"
            onClick={() =>
              setRateLimit((value) =>
                value === RATE_LIMIT_NARROW ? RATE_LIMIT_WIDE : RATE_LIMIT_NARROW,
              )
            }
          >
            toggle value
          </button>
        </div>
      </div>

    </div>
  );
}

// ---------------------------------------------------------------------------
// registerGalleryCards
// ---------------------------------------------------------------------------

/**
 * Register all gallery card types in the global card registry.
 *
// ---------------------------------------------------------------------------
// Gallery size policies
// ---------------------------------------------------------------------------

/** Component Gallery (multi-tab entry point): large enough to show content. */
const GALLERY_ENTRY_SIZE: CardSizePolicy = {
  min: { width: 450, height: 350 },
  preferred: { width: 900, height: 1000 },
};

/** Standard gallery component card (most variant grids, form demos). */
const GALLERY_COMPONENT_SIZE: CardSizePolicy = {
  min: { width: 300, height: 250 },
  preferred: { width: 500, height: 400 },
};

/** Complex gallery cards (palette, theme generator, animator, markdown, sheet). */
const GALLERY_COMPLEX_SIZE: CardSizePolicy = {
  min: { width: 400, height: 350 },
  preferred: { width: 640, height: 520 },
};

/** The color picker's fixed size — wide enough for the hue grid, tall enough
 * that nothing ever scrolls. */
const COLOR_PICKER_SIZE = { width: 452, height: 540 } as const;

/**
 * Must be called before `DeckManager.addCard("gallery-buttons")` is invoked.
 * In `main.tsx`, call this before constructing the DeckManager.
 *
 * Each gallery card type:
 * - `family: "maker"` -- appears only in maker-family type pickers
 * - `acceptsFamilies: ["maker"]` -- type picker shows only maker cards
 * - `closable: true` -- gallery cards can be closed and re-added via [+]
 *
 * Only `gallery-buttons` has `defaultCards` and `defaultTitle`:
 * - `defaultCards: GALLERY_DEFAULT_CARDS` -- seeds the gallery stack with one
 *    card from each of the first four `+` menu groups
 * - `defaultTitle: "Component Gallery"` -- card header prefix
 *
 * **Authoritative reference:** (#s03-gallery-registrations), [D06]
 */
/**
 * Category declarations for the [+] type picker. Each gallery card
 * registration passes one of these as its `category` field. `TugTabBar`
 * sorts sections by label and items within each section by label, so
 * declaration order here has no effect on menu placement.
 */
const CATEGORIES = {
  animation: { label: "Animation & Theming", icon: "Play" },
  architecture: { label: "Framework & Patterns", icon: "GitBranch" },
  blockRenderers: { label: "Transcript Blocks", icon: "Blocks" },
  buttons: { label: "Buttons", icon: "MousePointerClick" },
  dataViews: { label: "Data Views", icon: "List" },
  feedback: { label: "Feedback & Status", icon: "Activity" },
  layout: { label: "Layout & Structure", icon: "Box" },
  overlays: { label: "Overlays", icon: "MessageSquareMore" },
  selection: { label: "Selection", icon: "CheckSquare" },
  textInput: { label: "Text Input", icon: "TextCursorInput" },
} as const;

export function registerGalleryCards(): void {

  // ===========================================================================
  // Animation & Theming
  // ===========================================================================

  registerCard({
    componentId: "gallery-theme-editor",
    contentFactory: (_cardId) => <GalleryThemeEditor />,
    defaultMeta: { title: "Theme Deriver", icon: "Palette", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.animation,
  });

  registerCard({
    componentId: "gallery-color-wells",
    contentFactory: (_cardId) => <GalleryColorWells />,
    defaultMeta: { title: "Color Wells", icon: "Palette", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.animation,
  });

  registerCard({
    componentId: "gallery-color-picker",
    contentFactory: (_cardId) => <GalleryColorPicker />,
    defaultMeta: { title: "Color Picker", icon: "Palette", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    // Fixed size — the picker is sized to show everything, so it never scrolls.
    sizePolicy: { min: COLOR_PICKER_SIZE, max: COLOR_PICKER_SIZE, preferred: COLOR_PICKER_SIZE },
    category: CATEGORIES.animation,
  });

  registerCard({
    componentId: "gallery-scale-timing",
    contentFactory: (_cardId) => <GalleryScaleTiming />,
    defaultMeta: { title: "Scale & Timing", icon: "SlidersHorizontal", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.animation,
  });

  registerCard({
    componentId: "gallery-theme-accessibility",
    contentFactory: (_cardId) => <GalleryThemeAccessibility />,
    defaultMeta: { title: "Theme Accessibility", icon: "Paintbrush", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.animation,
  });

  registerCard({
    componentId: "gallery-animator",
    contentFactory: (_cardId) => <GalleryAnimator />,
    defaultMeta: { title: "TugAnimator", icon: "Play", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.animation,
  });

  // ===========================================================================
  // Architecture
  // ===========================================================================

  registerCard({
    componentId: "gallery-chain-actions",
    contentFactory: (_cardId) => <GalleryChainActions />,
    defaultMeta: { title: "Chain Actions", icon: "Zap", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.architecture,
  });

  registerCard({
    componentId: "gallery-mutation",
    contentFactory: (_cardId) => <GalleryMutation />,
    defaultMeta: { title: "Mutation Model", icon: "GitBranch", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.architecture,
  });

  registerCard({
    componentId: "gallery-mutation-tx",
    contentFactory: (_cardId) => <GalleryMutationTx />,
    defaultMeta: { title: "Mutation Transactions", icon: "Layers", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.architecture,
  });

  // The cardId is passed through to GalleryObservableProps so inspector
  // controls can direct setProperty actions to the correct TugPane responder
  // node via sendToTarget. [D04] (#s07-gallery-demo)
  registerCard({
    componentId: "gallery-observable-props",
    contentFactory: (cardId) => <GalleryObservableProps cardId={cardId} />,
    defaultMeta: { title: "Observable Props", icon: "SlidersHorizontal", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.architecture,
  });

  // Canonical manual-verification card for the Component State
  // Preservation Protocol ([D13], [A9]). Every component that opts in
  // should land a new section here so reload / tab-switch / cmd-tab
  // survival is easy to sanity-check by hand.
  registerCard({
    componentId: "gallery-state-preservation",
    contentFactory: (_cardId) => <GalleryStatePreservation />,
    defaultMeta: { title: "State Preservation", icon: "Save", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.architecture,
  });

  // ===========================================================================
  // Block Renderers
  //
  // Dev assistant-rendering surfaces: the body kinds, tool blocks,
  // and chrome that render a transcript's tool calls and reasoning.
  // ===========================================================================

  // Visual fixture for the smart-pick routing inside BashToolBlock:
  // echo (TerminalBlock) vs git show / git diff (DiffBlock) vs git status
  // (TerminalBlock again, must not false-positive).
  registerCard({
    componentId: "gallery-bash-tool-block",
    contentFactory: (_cardId) => <GalleryBashToolBlock />,
    defaultMeta: { title: "BashToolBlock", icon: "Terminal", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.blockRenderers,
  });

  // Transcript registers — design spike gathering the Code-route
  // transcript's content kinds (prose, tool block, dialog, task updates,
  // background notices) with three candidate treatments for the two
  // problem children: task updates + background/system notices.
  registerCard({
    componentId: "gallery-transcript-registers",
    contentFactory: (_cardId) => <GalleryTranscriptRegisters />,
    defaultMeta: { title: "Transcript Registers", icon: "AlignLeft", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.blockRenderers,
  });

  // Commit surfaces — the single card for every surface that shows a commit:
  // the History shade's rows on the shared `.tugx-commit` scale, the `/commit`
  // durable receipt ([P08], the fixtures at0264 measures), and the `git commit`
  // bash receipt (`CommitBlock`, the BashToolBlock routing target).
  registerCard({
    componentId: "gallery-commit-surfaces",
    contentFactory: (_cardId) => <GalleryCommitSurfaces />,
    defaultMeta: { title: "Commit Surfaces", icon: "GitCommitVertical", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.blockRenderers,
  });

  // History-collapsed tool blocks — replayed history mounts
  // header-only; the body materializes on expand. Collapsed +
  // expanded readings across representative tool families.

  // DefaultToolBlock — the [D11] fallback for tool calls with no
  // bespoke wrapper: unknown tools (with a caution badge) and
  // policy default-intent tools awaiting their bespoke wrapper.
  registerCard({
    componentId: "gallery-tool-block-default",
    contentFactory: (_cardId) => <GalleryToolBlockDefault />,
    defaultMeta: { title: "DefaultToolBlock", icon: "Wrench", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.blockRenderers,
  });

  // Operational trio ([#step-24-3-2]) — bespoke wrappers for low-volume
  // user-meaningful tools that were previously default-routed.
  // TaskMgmtToolBlock ([#step-24-3-3]) — single wrapper covering the
  // background-task family (TaskList / TaskGet / TaskOutput / TaskStop).
  // Management trio ([#step-24-3-4]) — CronToolBlock (3 aliases) +
  // ShareOnboardingGuideToolBlock + RemoteTriggerToolBlock.
  // TaskInlineToolBlock ([#step-24-3-5]) — the [D100] second surface
  // (inline marker; the TASKS status-bar cell is the first surface).

  // File tool blocks — Read + Edit + Write + NotebookEdit side by
  // side. Extended in [#step-29-5] with Write + NotebookEdit
  // (from [#step-26]).
  registerCard({
    componentId: "gallery-tool-block-file",
    contentFactory: (_cardId) => <GalleryToolBlockFile />,
    defaultMeta: { title: "File Tool Blocks", icon: "Files", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.blockRenderers,
  });

  // Network tool block — WebFetch (cache hit / miss / streaming /
  // error). Shipped in [#step-25].

  // Search tool block — WebSearch (parsed / fallback / domain-filtered
  // / empty). Shipped in [#step-25].

  // Collapsed tool-block header design spike — candidate collapsed-header
  // layouts (Quiet Line / Category Tile / Status Rail) across the full
  // supported tool range, for vetting [P09]/[#step-10].

  // ImageBlock body kind — lazy-load placeholder, EXIF orientation,
  // click-to-fullscreen. Shipped in [#step-27].
  registerCard({
    componentId: "gallery-image-block",
    contentFactory: (_cardId) => <GalleryImageBlock />,
    defaultMeta: { title: "ImageBlock", icon: "Image", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.blockRenderers,
  });

  // Dev chrome — SessionInitBanner ([#step-29]) + ErrorBlock
  // ([#step-29]) + CautionBadge (pre-existing). One card hosts all
  // three so the per-card chrome surfaces co-locate visually.
  registerCard({
    componentId: "gallery-dev-chrome",
    contentFactory: (_cardId) => <GalleryDevChrome />,
    defaultMeta: { title: "Session Chrome (banner / error / caution)", icon: "Layers", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.blockRenderers,
  });

  // JsonTreeBlock — the collapsible JSON body kind, standalone.
  registerCard({
    componentId: "gallery-json-tree-block",
    contentFactory: (_cardId) => <GalleryJsonTreeBlock />,
    defaultMeta: { title: "JsonTreeBlock", icon: "Braces", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.blockRenderers,
  });

  // Diagnostic fixture for the body-kind pinned-header behavior:
  // three standalone body kinds (FileBlock / DiffBlock / TerminalBlock)
  // inside their own fixed-height scroll wrappers, deliberately
  // detached from the transcript chain so the binding scrollport is
  // unambiguous.
  registerCard({
    componentId: "gallery-pinned-headers",
    contentFactory: (_cardId) => <GalleryPinnedHeaders />,
    defaultMeta: { title: "Pinned Headers (diagnostic)", icon: "Pin", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.blockRenderers,
  });

  // SessionThinkingBlock — the inline collapsible reasoning chrome.
  registerCard({
    componentId: "gallery-session-thinking",
    contentFactory: (_cardId) => <GallerySessionThinking />,
    defaultMeta: { title: "SessionThinkingBlock", icon: "Brain", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.blockRenderers,
  });

  // ===========================================================================
  // Buttons
  // ===========================================================================

  // Design exploration for `TugCue` — the upcoming public component for
  // "soft inline banner that's also a click target." Six prototype
  // variants; user vets before the production component ships.
  registerCard({
    componentId: "gallery-tug-cue",
    contentFactory: (_cardId) => <GalleryTugCue />,
    defaultMeta: { title: "TugCue", icon: "Lightbulb", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.buttons,
  });

  registerCard({
    componentId: "gallery-default-button",
    contentFactory: (_cardId) => <GalleryDefaultButton />,
    defaultMeta: { title: "TugDefaultButton", icon: "CornerDownLeft", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.buttons,
  });

  registerCard({
    componentId: "gallery-icon-button",
    contentFactory: (_cardId) => <GalleryIconButton />,
    defaultMeta: { title: "TugIconButton", icon: "MousePointer2", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.buttons,
  });

  registerCard({
    componentId: "gallery-popup-button",
    contentFactory: (_cardId) => <GalleryPopupButton />,
    defaultMeta: { title: "TugPopupButton", icon: "ChevronDown", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.buttons,
  });

  // gallery-buttons is the multi-tab entry point: it carries
  // `defaultCards` and `defaultTitle` so `addCard("gallery-buttons")`
  // seeds a starter stack. Display title is "TugPushButton".
  registerCard({
    componentId: "gallery-buttons",
    contentFactory: (_cardId) => <GalleryPushButton />,
    defaultMeta: { title: "TugPushButton", icon: "MousePointerClick", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    defaultCards: GALLERY_DEFAULT_CARDS,
    defaultTitle: "Component Gallery",
    sizePolicy: GALLERY_ENTRY_SIZE,
    category: CATEGORIES.buttons,
  });

  // ===========================================================================
  // Data Views
  // ===========================================================================

  registerCard({
    componentId: "gallery-list-view",
    contentFactory: (_cardId) => <GalleryListView />,
    defaultMeta: { title: "TugListView", icon: "List", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.dataViews,
  });

  // Visual smoke for `useFilteredDataSource` — the Phase 1
  // UISearchController-style decorator hook. A `TugInput` above the
  // list view drives a substring predicate; the host owns the input
  // and the primitive consumes the derived data source.
  registerCard({
    componentId: "gallery-list-view-filter",
    hidden: true,
    contentFactory: (_cardId) => <GalleryListViewFilter />,
    defaultMeta: { title: "TugListView (filter)", icon: "Search", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.dataViews,
  });

  // Focus-engine proof for `TugListView` — the container-stop (`focusGroup`,
  // ring on the list) and input-subordinate (`keyboardSubordinate`, list adds
  // no Tab stop) shapes of the "ring on the component, selection on the row"
  // model.
  registerCard({
    componentId: "gallery-list-view-focus",
    contentFactory: (_cardId) => <GalleryListViewFocus />,
    defaultMeta: { title: "TugListView (focus)", icon: "List", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.dataViews,
  });

  // Focus-language reference — the canonical overview of the keyboard-focus
  // treatment across the archetype taxonomy (ring + behind-tint on focus, native
  // fill for selection, one role axis default action), judged by eye in both
  // themes. A permanent gallery card.
  registerCard({
    componentId: "gallery-focus-language",
    contentFactory: (_cardId) => <GalleryFocusLanguage />,
    defaultMeta: { title: "Focus Language", icon: "List", closable: true },
    // A gallery card follows its subject ([P10]), and this card's subject IS
    // the engine's focus stops — it must be readable with rings on, at rest.
    kbfAtRest: true,
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.architecture,
  });

  // The `Focus Wash` and `Selection Wash` spike cards stood here. Both landed:
  // the container wash is a theme-authored step in `focus-ring.css` + the theme
  // files, the committed selection is an opaque ground plus a wash in
  // `tug-list-row.css`. A spike card is scaffolding for a decision, and the
  // decisions are made — the shipped surfaces are where these are judged now.

  // Keyboard-focus-cycling app-test fixture for the `useCycleMode` primitive
  // (⌥⇥ toggles a trapped cycle scope; Tab wraps the stops; toggle off restores
  // the resting key view). The real consumer is the session card; this card exercises
  // the mechanism in isolation for `at0139`. Hidden from the `+` picker — a
  // mechanism proof, not a component demo — but kept as a driven test surface.
  registerCard({
    componentId: "gallery-cycle-demo",
    hidden: true,
    contentFactory: (cardId) => <GalleryCycleDemo cardId={cardId} />,
    defaultMeta: { title: "Cycle Mode", icon: "List", closable: true },
    // Follows its subject ([P10]): this card exists to exercise engaged-mode
    // mechanics, so it is engaged at rest.
    kbfAtRest: true,
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.dataViews,
  });

  // Visual smoke for `TugListView`'s row-role feature
  // (`roleForIndex` → `data-list-cell-role` + `tabIndex={-1}` +
  // `onSelect` gating). Companion to `gallery-list-view` above:
  // that card exercises mutation, streaming, and windowing; this
  // one scopes to the role contract introduced by Phase 0 of
  // `tugplan-session-picker-redesign`.
  registerCard({
    componentId: "gallery-list-view-headers",
    hidden: true,
    contentFactory: (_cardId) => <GalleryListViewHeaders />,
    defaultMeta: { title: "TugListView (headers)", icon: "List", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.dataViews,
  });

  // Companion to `gallery-list-view`: same dataset, but the inner
  // `TugListView` carries `scrollKey="gallery-list-view-scroll"` so
  // the [A9] region-scroll axis captures the list's position into
  // `bag.regionScroll`, AND mounts in `inline` mode (every cell in
  // the DOM, no windowing) to mirror the session-card transcript
  // configuration. The region-scroll-anchor app-tests
  // (`at0059-region-scroll-anchor-save.test.ts`,
  // `at0060-session-card-content-settled.test.ts`,
  // `at0061-region-scroll-anchor-apply.test.ts`) drive this card.
  registerCard({
    componentId: "gallery-list-view-scroll-keyed",
    hidden: true,
    contentFactory: (_cardId) => (
      <GalleryListView
        scrollKey="gallery-list-view-scroll"
        inline
        disableStreaming
      />
    ),
    defaultMeta: {
      title: "TugListView (scroll-keyed)",
      icon: "List",
      closable: true,
    },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.dataViews,
  });

  // `TugListRow` — the presentational row-chrome primitive composed by
  // `TugListView` cell renderers (and usable standalone). The card
  // catalogs both variants, the accessory slots, the trailing-reveal
  // policy, the state inputs, and the consumer-owned-selection
  // contract.
  registerCard({
    componentId: "gallery-tug-list-row",
    contentFactory: (_cardId) => <GalleryTugListRow />,
    defaultMeta: { title: "TugListRow", icon: "List", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.dataViews,
  });

  registerCard({
    componentId: "gallery-markdown-view",
    contentFactory: (_cardId) => <GalleryMarkdownView />,
    defaultMeta: { title: "TugMarkdownView", icon: "FileText", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.dataViews,
  });

  // Transcript COPY wiring fixture ([Q03]) — mounts the real
  // `useTranscriptCellMenu` handler over a static body (markdown + tool +
  // thinking) so `at0188` can drive real ⌘C / menu-Copy and assert the
  // clipboard. Exercises the end-to-end reconstruction the probe can't.
  registerCard({
    componentId: "gallery-transcript-copy",
    contentFactory: (_cardId) => <GalleryTranscriptCopy />,
    defaultMeta: { title: "Transcript Copy", icon: "Clipboard", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.dataViews,
  });

  // Pre-baked variant: mounts with 1KB of static markdown — small
  // enough that all blocks fit in one viewport, so block-container
  // children render fully and are stable across re-mount. Used by
  // the cold-boot selection harness test where deterministic
  // anchor paths matter; the 50KB variant exercises the
  // virtualization-aware path separately.
  registerCard({
    componentId: "gallery-markdown-1kb",
    hidden: true,
    contentFactory: (_cardId) => <GalleryMarkdownView staticContentSize="1kb" />,
    defaultMeta: { title: "TugMarkdownView (1KB)", icon: "FileText", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.dataViews,
  });

  // Pre-baked variant: mounts with 50KB of static markdown loaded
  // immediately. Used by [AT0014] / [AT0023] harness tests
  // for predictable scrollable content; useful as a manual
  // theme-debug fixture too. Same component code, distinct id.
  registerCard({
    componentId: "gallery-markdown-50kb",
    hidden: true,
    contentFactory: (_cardId) => <GalleryMarkdownView staticContentSize="50kb" />,
    defaultMeta: { title: "TugMarkdownView (50KB)", icon: "FileText", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.dataViews,
  });

  // ===========================================================================
  // Feedback & Status
  // ===========================================================================

  registerCard({
    componentId: "gallery-tug-arc-gauge",
    contentFactory: (_cardId) => <GalleryTugArcGauge />,
    defaultMeta: { title: "TugArcGauge", icon: "Gauge", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.feedback,
  });

  registerCard({
    componentId: "gallery-tug-progress-indicator",
    contentFactory: (_cardId) => <GalleryTugProgressIndicator />,
    defaultMeta: { title: "TugProgressIndicator", icon: "Activity", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.feedback,
  });

  // An instrument rather than a showcase — a pinned population of one glyph so
  // a profile can be compared to the one before it. See the file header.
  registerCard({
    componentId: "gallery-motion-bench",
    contentFactory: (_cardId) => <GalleryMotionBench />,
    defaultMeta: { title: "Motion bench", icon: "Activity", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.feedback,
  });

  // Pulse display — design spike for the PULSE's two-level grammar
  // (intent headline over live activity), on the session-card strip and
  // the Lens Sessions row (including the new two-line budget).
  registerCard({
    componentId: "gallery-pulse-display",
    contentFactory: (_cardId) => <GalleryPulseDisplay />,
    defaultMeta: { title: "Pulse Display", icon: "Activity", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.feedback,
  });

  // Session identity — design spike for the session-reference brief
  // (roadmap/session-reference-brief.md): the callsign chip and its tint,
  // the four density tiers (chip / line / row / masthead), the citation,
  // and the fork-lineage grammar, each auditioned in its real context.
  registerCard({
    componentId: "gallery-session-identity",
    contentFactory: (_cardId) => <GallerySessionIdentity />,
    defaultMeta: { title: "Session Identity", icon: "Fingerprint", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.feedback,
  });

  registerCard({
    componentId: "gallery-tool-call-header",
    contentFactory: (_cardId) => <GalleryBlockHeader />,
    defaultMeta: { title: "BlockHeader", icon: "Wrench", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.blockRenderers,
  });

  registerCard({
    componentId: "gallery-badge",
    contentFactory: (_cardId) => <GalleryBadge />,
    defaultMeta: { title: "TugBadge", icon: "Tag", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.feedback,
  });

  registerCard({
    componentId: "gallery-banner",
    contentFactory: (_cardId) => <GalleryBanner />,
    defaultMeta: { title: "TugBanner", icon: "TriangleAlert", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.feedback,
  });

  registerCard({
    componentId: "gallery-bulletin",
    contentFactory: (_cardId) => <GalleryBulletin />,
    defaultMeta: { title: "TugBulletin", icon: "Bell", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.feedback,
  });

  registerCard({
    componentId: "gallery-pane-bulletin",
    contentFactory: (_cardId) => <GalleryPaneBulletin />,
    defaultMeta: { title: "TugPaneBulletin", icon: "Bell", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.feedback,
  });

  registerCard({
    componentId: "gallery-tug-linear-gauge",
    contentFactory: (_cardId) => <GalleryTugLinearGauge />,
    defaultMeta: { title: "TugLinearGauge", icon: "Gauge", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.feedback,
  });

  registerCard({
    componentId: "gallery-marquee",
    contentFactory: (_cardId) => <GalleryMarquee />,
    defaultMeta: { title: "TugMarquee", icon: "MoveHorizontal", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.feedback,
  });

  registerCard({
    componentId: "gallery-card-banner",
    contentFactory: (_cardId) => <GalleryCardBanner />,
    defaultMeta: { title: "TugPaneBanner", icon: "CircleAlert", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.feedback,
  });

  registerCard({
    componentId: "gallery-skeleton",
    contentFactory: (_cardId) => <GallerySkeleton />,
    defaultMeta: { title: "TugSkeleton", icon: "Loader", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.feedback,
  });

  // ===========================================================================
  // Layout & Structure
  // ===========================================================================

  registerCard({
    componentId: "gallery-accordion",
    contentFactory: (_cardId) => <GalleryAccordion />,
    defaultMeta: { title: "TugAccordion", icon: "ChevronDown", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.layout,
  });

  registerCard({
    componentId: "gallery-atom",
    contentFactory: (_cardId) => <GalleryAtom />,
    defaultMeta: { title: "TugAtom", icon: "AtSign", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.layout,
  });

  registerCard({
    componentId: "gallery-attachment-strip",
    contentFactory: (_cardId) => <GalleryAttachmentStrip />,
    defaultMeta: { title: "TugAttachmentPreview", icon: "Image", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.layout,
  });

  registerCard({
    componentId: "gallery-box",
    contentFactory: (_cardId) => <GalleryBox />,
    defaultMeta: { title: "TugBox", icon: "Box", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.layout,
  });

  registerCard({
    componentId: "gallery-slot-layout",
    contentFactory: (_cardId) => <GallerySlotLayout />,
    defaultMeta: { title: "Layouts Picker", icon: "Columns3", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.layout,
  });

  registerCard({
    componentId: "gallery-separator",
    contentFactory: (_cardId) => <GallerySeparator />,
    defaultMeta: { title: "TugSeparator", icon: "Minus", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.layout,
  });

  registerCard({
    componentId: "gallery-tug-clamp",
    contentFactory: (_cardId) => <GalleryTugClamp />,
    defaultMeta: { title: "TugClamp", icon: "ChevronsDownUp", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.layout,
  });

  registerCard({
    componentId: "gallery-split-pane",
    contentFactory: (_cardId) => <GallerySplitPane />,
    defaultMeta: { title: "TugSplitPane", icon: "Rows2", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.layout,
  });

  registerCard({
    componentId: "gallery-tabbar",
    contentFactory: (_cardId) => <GalleryTabBar />,
    defaultMeta: { title: "TugTabBar", icon: "PanelTop", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.layout,
  });

  registerCard({
    componentId: "gallery-title-bar",
    contentFactory: (_cardId) => <GalleryTitleBar />,
    defaultMeta: { title: "TugTitleBar", icon: "PanelTop", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.layout,
  });

  registerCard({
    componentId: "gallery-card-chrome",
    contentFactory: (_cardId) => <GalleryCardChrome />,
    defaultMeta: { title: "Card Chrome Tiers", icon: "PanelsTopLeft", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.layout,
  });

  registerCard({
    componentId: "gallery-changes-headers",
    contentFactory: (_cardId) => <GalleryChangesHeaders />,
    defaultMeta: { title: "Changes Headers", icon: "Rows3", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.layout,
  });


  // ===========================================================================
  // Overlays
  // ===========================================================================

  registerCard({
    componentId: "gallery-alert",
    contentFactory: (_cardId) => <GalleryAlert />,
    defaultMeta: { title: "TugAlert", icon: "CircleAlert", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.overlays,
  });

  registerCard({
    componentId: "gallery-modal-input-dialog",
    contentFactory: (_cardId) => <GalleryModalInputDialog />,
    defaultMeta: {
      title: "TugModalInputDialog",
      icon: "SearchCode",
      closable: true,
    },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.overlays,
  });

  // ConfigureTug happy-path design spike ([#step-9] onboarding-and-install.md):
  // simulates the whole setup flow from local state so the wizard's copy,
  // rhythm, and pulsing-dot step rows can be designed without a clean guest.
  registerCard({
    componentId: "gallery-configure-tug",
    contentFactory: (_cardId) => <GalleryConfigureTug />,
    defaultMeta: { title: "ConfigureTug", icon: "ListChecks", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.overlays,
  });

  // Reference card for the unified modal-header convention
  // (styles/tugx-header.css): the three header cases (one-line / two-line /
  // alert) as static shipped/spec parity pairs, judged without live overlays.
  registerCard({
    componentId: "gallery-modal-headers",
    contentFactory: (_cardId) => <GalleryModalHeaders />,
    defaultMeta: { title: "Modal Headers", icon: "PanelTop", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: {
      min: { width: 480, height: 400 },
      preferred: { width: 800, height: 940 },
    },
    category: CATEGORIES.overlays,
  });

  registerCard({
    componentId: "gallery-confirm-popover",
    contentFactory: (_cardId) => <GalleryConfirmPopover />,
    defaultMeta: { title: "TugConfirmPopover", icon: "ShieldAlert", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.overlays,
  });

  registerCard({
    componentId: "gallery-context-menu",
    contentFactory: (_cardId) => <GalleryContextMenu />,
    defaultMeta: { title: "TugContextMenu", icon: "MousePointer2", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.overlays,
  });

  registerCard({
    componentId: "gallery-tug-dialog-button",
    contentFactory: (_cardId) => <GalleryTugDialogButton />,
    defaultMeta: {
      title: "TugDialogButton",
      icon: "MousePointerClick",
      closable: true,
    },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.overlays,
  });

  registerCard({
    componentId: "gallery-tug-inline-dialog",
    contentFactory: (_cardId) => <GalleryTugInlineDialog />,
    defaultMeta: {
      title: "TugInlineDialog",
      icon: "ShieldAlert",
      closable: true,
    },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.overlays,
  });


  registerCard({
    componentId: "gallery-popover",
    contentFactory: (_cardId) => <GalleryPopover />,
    defaultMeta: { title: "TugPopover", icon: "MessageSquareMore", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.overlays,
  });

  registerCard({
    componentId: "gallery-sheet",
    contentFactory: (_cardId) => <GallerySheet />,
    defaultMeta: { title: "TugSheet", icon: "PanelTopOpen", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.overlays,
  });

  registerCard({
    componentId: "gallery-tooltip",
    contentFactory: (_cardId) => <GalleryTooltip />,
    defaultMeta: { title: "TugTooltip", icon: "MessageSquare", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.overlays,
  });

  // ===========================================================================
  // Selection
  // ===========================================================================

  registerCard({
    componentId: "gallery-checkbox",
    contentFactory: (_cardId) => <GalleryCheckbox />,
    defaultMeta: { title: "TugCheckbox", icon: "SquareCheck", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.selection,
  });

  registerCard({
    componentId: "gallery-choice-group",
    contentFactory: (_cardId) => <GalleryChoiceGroup />,
    defaultMeta: { title: "TugChoiceGroup", icon: "ToggleLeft", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.selection,
  });

  registerCard({
    componentId: "gallery-option-group",
    contentFactory: (_cardId) => <GalleryOptionGroup />,
    defaultMeta: { title: "TugOptionGroup", icon: "ToggleLeft", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.selection,
  });

  registerCard({
    componentId: "gallery-radio-group",
    contentFactory: (_cardId) => <GalleryRadioGroup />,
    defaultMeta: { title: "TugRadioGroup", icon: "CircleCheck", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.selection,
  });

  registerCard({
    componentId: "gallery-slider",
    contentFactory: (_cardId) => <GallerySlider />,
    defaultMeta: { title: "TugSlider", icon: "SlidersHorizontal", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.selection,
  });

  registerCard({
    componentId: "gallery-switch",
    contentFactory: (_cardId) => <GallerySwitch />,
    defaultMeta: { title: "TugSwitch", icon: "ToggleRight", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.selection,
  });

  // ===========================================================================
  // Text Input
  // ===========================================================================

  registerCard({
    componentId: "gallery-input",
    contentFactory: (_cardId) => <GalleryInput />,
    defaultMeta: { title: "TugInput", icon: "TextCursorInput", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.textInput,
  });

  registerCard({
    componentId: "gallery-file-chooser",
    contentFactory: (_cardId) => <GalleryFileChooser />,
    defaultMeta: { title: "TugFileChooser", icon: "FolderOpen", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.textInput,
  });

  registerCard({
    componentId: "gallery-label",
    contentFactory: (_cardId) => <GalleryLabel />,
    defaultMeta: { title: "TugLabel", icon: "Type", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.textInput,
  });

  registerCard({
    componentId: "gallery-prompt-entry",
    contentFactory: (cardId) => <GalleryPromptEntry cardId={cardId} />,
    defaultMeta: { title: "TugPromptEntry", icon: "MessageSquareText", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.textInput,
    engineKind: "em",
  });

  registerCard({
    componentId: "gallery-textarea",
    contentFactory: (_cardId) => <GalleryTextarea />,
    defaultMeta: { title: "TugTextarea", icon: "TextAlignStart", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.textInput,
  });

  registerCard({
    componentId: "gallery-text-editor",
    contentFactory: (cardId) => <GalleryTextEditor cardId={cardId} />,
    defaultMeta: { title: "TugTextEditor", icon: "TextCursorInput", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPLEX_SIZE,
    category: CATEGORIES.textInput,
    engineKind: "em",
  });

  registerCard({
    componentId: "gallery-transcript-entry",
    contentFactory: (_cardId) => <GalleryTranscriptEntry />,
    defaultMeta: { title: "TugTranscriptEntry", icon: "MessagesSquare", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.textInput,
  });

  registerCard({
    componentId: "gallery-value-input",
    contentFactory: (_cardId) => <GalleryValueInput />,
    defaultMeta: { title: "TugValueInput", icon: "Hash", closable: true },
    family: "maker",
    acceptsFamilies: ["maker"],
    sizePolicy: GALLERY_COMPONENT_SIZE,
    category: CATEGORIES.textInput,
  });

}

// Re-export GalleryMutationTx so tests can import it from either location.
export { GalleryMutationTx };
