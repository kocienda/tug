/**
 * spike-share-shade-cta.tsx — which of the app's existing header grammars
 * should the Share shade wear, and how should everything beneath the header
 * be laid out, so its top bar is never smaller than the call to action?
 *
 * The Share shade first shipped with an instruction style of its own: a 14px
 * semibold lead line over a 12px label-coloured follow-on, under a section
 * strip whose name is 13px. Two faults in one: the type belonged to no family
 * the app already has, and the call to action outranked the bar that titles
 * the shade.
 *
 * **The working design** is drawn first. It is the sheet header (candidate A
 * below) taken as a start, with four notes applied:
 *
 *  1. Mark All and Clear All sit at the right of the title row, which is as
 *     tall as they are, the count before them so the buttons hold still.
 *  2. Tools and Format share one line. Tools' label fills the header's icon
 *     column, so its choices start on the same left edge as the title and
 *     the description. When the shade is too narrow for the
 *     line, Format stacks under Tools, its choices on Tools' left edge
 *     (`useShareFormFit`, the real sheet's own).
 *  3. The action chooser — a label and a popup menu of Preview…, Copy,
 *     Save…, Share… — sits at the left of the bottom row.
 *  4. Two buttons only, at the bottom row's right: Cancel, and one button
 *     that wears whatever action the menu names.
 *
 * It is live: the menu's choice renames the action button, so the pairing can
 * be judged by using it. This is the surface to keep iterating on.
 *
 * **The candidates it was chosen from** follow, for reference. Each is the
 * Share shade in one of the app's settled grammars for "a title and what to
 * do about it", drawn from the shipping components and classes:
 *
 *  - **A — the sheet header.** `styles/tugx-header.css`: icon, title,
 *    description — what TugSheet, TugAlert, ConfigureTug and VersionGate all
 *    draw.
 *  - **B — the section strip with a description.** The `BlockStrip` at
 *    `section` altitude that History and Changes head their shades with.
 *  - **C — the inline dialog as the bar.** `TugInlineDialog`, the primitive
 *    the Changes shade's notice band and the permission and question dialogs
 *    wear.
 *
 * The first-shipped treatment is drawn last, for the comparison it lost.
 */

import "./spike.css";
import "./spike-share-shade-cta.css";

import React, { useId, useRef, useState } from "react";
import { Share } from "lucide-react";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { BlockStrip } from "@/components/tugways/blocks/block-strip";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import { TugChoiceGroup, type TugChoiceItem } from "@/components/tugways/tug-choice-group";
import { useShareFormFit } from "@/components/tugways/cards/session-share-view";
import { TugInlineDialog } from "@/components/tugways/tug-inline-dialog";
import { TugPopupButton, type TugPopupButtonItem } from "@/components/tugways/tug-popup-button";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { useResponder } from "@/components/tugways/use-responder";

import type { SpikeDef } from "./spike-registry";

const LEAD = "Check the box at the right of each turn you want to share.";
const MORE =
  "Shift-click a box to select every turn between it and the last one you clicked, or use the buttons above to select turns.";
const COUNT = "3 turns";

const TOOL_MODE_ITEMS: TugChoiceItem[] = [
  { value: "summaries", label: "Summaries" },
  { value: "full", label: "Full" },
  { value: "none", label: "None" },
];

const FORMAT_ITEMS: TugChoiceItem[] = [
  { value: "pdf", label: "PDF" },
  { value: "png", label: "Image" },
  { value: "markdown", label: "Markdown" },
];

const ACTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "preview", label: "Preview…" },
  { value: "copy", label: "Copy" },
  { value: "save", label: "Save…" },
  { value: "share", label: "Share…" },
];

const ACTION_ITEMS: TugPopupButtonItem<string>[] = ACTIONS.map((action) => ({
  action: TUG_ACTIONS.SELECT_VALUE,
  value: action.value,
  label: action.label,
}));

// ---------------------------------------------------------------------------
// The working design
// ---------------------------------------------------------------------------

/**
 * The sheet header with the four notes applied. Live: the three controls
 * report through the chain to this view's responder, as the shipping view's
 * do ([L11]), and the choices are local data of the spike ([L24]).
 */
function WorkingDesign(): React.ReactElement {
  const [toolMode, setToolMode] = useState("summaries");
  const [format, setFormat] = useState("pdf");
  const [action, setAction] = useState("preview");
  const toolSenderId = useId();
  const formatSenderId = useId();
  const actionSenderId = useId();
  const responderId = useId();
  const { ResponderScope, responderRef } = useResponder({
    id: responderId,
    actions: {
      [TUG_ACTIONS.SELECT_VALUE]: (event: ActionEvent) => {
        if (typeof event.value !== "string") return;
        if (event.sender === toolSenderId) setToolMode(event.value);
        else if (event.sender === formatSenderId) setFormat(event.value);
        else if (event.sender === actionSenderId) setAction(event.value);
      },
    },
  });
  const actionLabel = ACTIONS.find((entry) => entry.value === action)?.label ?? "";
  const formRef = useRef<HTMLDivElement | null>(null);
  useShareFormFit(formRef);
  return (
    <ResponderScope>
      <div className="sp-ssc-working" ref={responderRef as (el: HTMLDivElement | null) => void}>
        <div className="sp-ssc-working-header tug-sheet-header" data-has-description="true" data-icon-tone="active">
          <div className="tug-sheet-icon" aria-hidden="true">
            <Share />
          </div>
          <div className="tug-sheet-heading">
            {/* Note 1: the title row, tall enough for the buttons — the
                title at its left; the count, Mark All and Clear All at its
                right, the buttons flush right so they never move. */}
            <div className="sp-ssc-title-row">
              <div className="tug-sheet-title">Share Turns</div>
              <div className="sp-ssc-marks">
                <span className="sp-ssc-count">3 turns selected</span>
                <TugPushButton size="sm" emphasis="outlined" role="action">
                  Select All
                </TugPushButton>
                <TugPushButton size="sm" emphasis="outlined" role="action">
                  Clear All
                </TugPushButton>
              </div>
            </div>
            <p className="tug-sheet-description">
              {LEAD} {MORE}
            </p>
          </div>
        </div>
        {/* Note 2: Tools and Format on one line when they fit, stacked when
            not; Tools' label in the icon column either way. */}
        <div className="sp-ssc-form" ref={formRef}>
          <span className="sp-ssc-field-label sp-ssc-field-label--lead">Tools</span>
          <span className="sp-ssc-control">
            <TugChoiceGroup
              items={TOOL_MODE_ITEMS}
              value={toolMode}
              senderId={toolSenderId}
              size="sm"
              commit="live"
              aria-label="Tools"
            />
          </span>
          <span className="sp-ssc-field-label sp-ssc-field-label--format">Format</span>
          <span className="sp-ssc-control">
            <TugChoiceGroup
              items={FORMAT_ITEMS}
              value={format}
              senderId={formatSenderId}
              size="sm"
              commit="live"
              aria-label="Format"
            />
          </span>
        </div>
        {/* Notes 3 and 4: Action at the bottom row's left, the two buttons at
            its right. */}
        <div className="sp-ssc-working-actions tug-sheet-actions">
          <span className="sp-ssc-field-label">Action</span>
          <span className="sp-ssc-control">
            <TugPopupButton label={actionLabel} items={ACTION_ITEMS} senderId={actionSenderId} size="sm" aria-label="Action" />
          </span>
          <span className="sp-ssc-spacer" />
          <TugPushButton size="sm" emphasis="outlined" role="action">
            Cancel
          </TugPushButton>
          <TugPushButton size="sm" emphasis="primary" role="action" persistentDefaultRing>
            {actionLabel}
          </TugPushButton>
        </div>
      </div>
    </ResponderScope>
  );
}

// ---------------------------------------------------------------------------
// The candidates, for reference
// ---------------------------------------------------------------------------

/** Mark All and Clear, as the candidates' headers carry them. */
function MarkButtons(): React.ReactElement {
  return (
    <>
      <TugPushButton size="sm" emphasis="ghost" role="action">
        Mark All
      </TugPushButton>
      <TugPushButton size="sm" emphasis="ghost" role="action">
        Clear
      </TugPushButton>
    </>
  );
}

/** The two choices, identical in every candidate. */
function Fields(): React.ReactElement {
  return (
    <div className="sp-ssc-fields">
      <span className="sp-ssc-field">
        <span className="sp-ssc-field-label">Tool calls</span>
        <TugChoiceGroup items={TOOL_MODE_ITEMS} value="summaries" size="sm" aria-label="Tool calls" />
      </span>
      <span className="sp-ssc-field">
        <span className="sp-ssc-field-label">Format</span>
        <TugChoiceGroup items={FORMAT_ITEMS} value="pdf" size="sm" aria-label="Format" />
      </span>
    </div>
  );
}

/** The five-button actions row, identical in every candidate. */
function Actions({ leading }: { leading?: React.ReactNode }): React.ReactElement {
  return (
    <div className="sp-ssc-actions tug-sheet-actions">
      {leading}
      <span className="sp-ssc-spacer" />
      <TugPushButton size="sm" emphasis="outlined" role="action">
        Preview…
      </TugPushButton>
      <TugPushButton size="sm" emphasis="outlined" role="action">
        Copy
      </TugPushButton>
      <TugPushButton size="sm" emphasis="outlined" role="action">
        Save…
      </TugPushButton>
      <TugPushButton size="sm" emphasis="outlined" role="action">
        Share…
      </TugPushButton>
      <TugPushButton size="sm" emphasis="primary" role="action">
        Done
      </TugPushButton>
    </div>
  );
}

interface CandidateProps {
  letter: string;
  name: string;
  /** Where this grammar already ships, or what this drawing is. */
  precedent: string;
  /** The top bar's type against the instruction's. */
  scale: string;
  children: React.ReactNode;
}

/** One drawing: its name, where the grammar ships, its scale, and the mock shade. */
function Candidate({ letter, name, precedent, scale, children }: CandidateProps): React.ReactElement {
  return (
    <section className="sp-section">
      <h2 className="sp-section-title">
        {letter} — {name}
      </h2>
      <p className="sp-ssc-note">{precedent}</p>
      <p className="sp-ssc-scale">{scale}</p>
      {/* The shade's own surface and edges (`--tugx-shade-*`), at a Session
          card's working width, with the Z2 line it rests on drawn beneath. */}
      <div className="sp-ssc-stage">
        <div className="sp-ssc-shade">{children}</div>
        <div className="sp-ssc-z2">Z2 status bar</div>
      </div>
    </section>
  );
}

/** A — the sheet header: the modal header convention, in the shade. */
function SheetHeaderCandidate(): React.ReactElement {
  return (
    <>
      <div className="sp-ssc-pad">
        <div className="tug-sheet-header" data-has-description="true" data-icon-tone="active">
          <div className="tug-sheet-icon" aria-hidden="true">
            <Share />
          </div>
          <div className="tug-sheet-heading">
            <div className="tug-sheet-title">Share Turns</div>
            <p className="tug-sheet-description">
              {LEAD} {MORE}
            </p>
          </div>
        </div>
        <Fields />
      </div>
      <Actions
        leading={
          <>
            <span className="sp-ssc-count">{COUNT}</span>
            <MarkButtons />
          </>
        }
      />
    </>
  );
}

/** B — the section strip History and Changes wear, with a description under it. */
function SectionStripCandidate(): React.ReactElement {
  return (
    <>
      <div className="tug-sheet-shade-header">
        <BlockStrip
          altitude="section"
          className="tool-call-header"
          leading={
            <span className="tool-call-header-leading tug-line-box" aria-hidden="true">
              <Share size={14} />
            </span>
          }
          name="Share Turns"
          detail={COUNT}
          actions={<MarkButtons />}
        />
      </div>
      <p className="sp-ssc-strip-description">
        {LEAD} {MORE}
      </p>
      <Fields />
      <Actions />
    </>
  );
}

/** C — the inline dialog as the bar: the app's inline-CTA primitive. */
function InlineDialogCandidate(): React.ReactElement {
  return (
    <>
      <div className="sp-ssc-idialog">
        <TugInlineDialog
          icon={<Share />}
          iconTone="info"
          title="Share Turns"
          description={
            <>
              {LEAD} {MORE}
            </>
          }
          actions={<MarkButtons />}
        />
      </div>
      <Fields />
      <Actions leading={<span className="sp-ssc-count">{COUNT}</span>} />
    </>
  );
}

/** As first shipped: the section strip over an instruction style of its own. */
function ShippedCandidate(): React.ReactElement {
  return (
    <>
      <div className="tug-sheet-shade-header">
        <BlockStrip
          altitude="section"
          className="tool-call-header"
          leading={
            <span className="tool-call-header-leading tug-line-box" aria-hidden="true">
              <Share size={14} />
            </span>
          }
          name="Share Turns"
          detail={COUNT}
          actions={<MarkButtons />}
        />
      </div>
      <div className="sp-ssc-shipped-instruction">
        <strong className="sp-ssc-shipped-lead">{LEAD}</strong>
        <span className="sp-ssc-shipped-more">{MORE}</span>
      </div>
      <Fields />
      <Actions />
    </>
  );
}

function SpikeShareShadeCta(): React.ReactElement {
  return (
    <div className="sp-content">
      <Candidate
        letter="Working design"
        name="Sheet header, with the four notes"
        precedent="The sheet header (A, below) as a start: Mark All and Clear All in their own row under the description; Tools and Format on one line when they fit (stacked, aligned, when they do not), Tools on the title's own left edge; and a bottom row with Action — a popup menu of Preview…, Copy, Save…, Share… — at its left and two buttons at its right: Cancel, and one that wears the menu's choice. This is what the real sheet wears. Live: change the menu and the button follows."
        scale="Top bar 15.2px semibold · instruction 12.8px regular at 80% · labels and count 12.8px · two-line header, 36px icon"
      >
        <WorkingDesign />
      </Candidate>
      <Candidate
        letter="A"
        name="Sheet header"
        precedent="The modal header convention (styles/tugx-header.css): what TugSheet, TugAlert, ConfigureTug and VersionGate draw. The title is the top bar; the instruction is its description. The count, Mark All and Clear move to the actions row's leading edge."
        scale="Top bar 15.2px semibold · instruction 12.8px regular at 80% · two-line header, 36px icon"
      >
        <SheetHeaderCandidate />
      </Candidate>
      <Candidate
        letter="B"
        name="Section strip + description"
        precedent="The BlockStrip at section altitude that heads the History and Changes shades, unchanged, with the instruction beneath it in the header family's description scale. The shade looks like its siblings; the instruction is quiet."
        scale="Top bar 13px semibold · instruction 12.8px regular at 80%"
      >
        <SectionStripCandidate />
      </Candidate>
      <Candidate
        letter="C"
        name="Inline dialog as the bar"
        precedent="TugInlineDialog: the Changes shade's notice band, the permission dialog and the question dialog, and the primitive its docstring reserves for inline calls to action. Icon, title, description, and Mark All / Clear as its trailing actions."
        scale="Top bar 14px semibold · instruction 13px regular at 80% · 20px icon, on the raised surface"
      >
        <InlineDialogCandidate />
      </Candidate>
      <Candidate
        letter="—"
        name="As first shipped"
        precedent="The section strip over an instruction style that exists nowhere else: a 14px semibold lead in full-strength text and a 12px label-coloured follow-on. Kept here only to be compared against."
        scale="Top bar 13px semibold · instruction lead 14px semibold — the call to action outranks the bar"
      >
        <ShippedCandidate />
      </Candidate>
    </div>
  );
}

export const spike: SpikeDef = {
  name: "share-shade-cta",
  title: "Share Shade CTA",
  blurb:
    "The Share shade in the sheet header grammar — Mark All / Clear All under the description, Tools and Format on one line, and Action beside the two buttons — with the candidates it was chosen from.",
  icon: "Share",
  component: () => <SpikeShareShadeCta />,
};
