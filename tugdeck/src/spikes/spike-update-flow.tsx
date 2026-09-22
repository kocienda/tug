/**
 * spike-update-flow.tsx — what should the app-update experience look like?
 *
 * The shipping pill and popover (`chrome/update-overlay.tsx`) are small,
 * neutral, and hand-rolled: a 1-line pill that reads as a chip, a popover that
 * is a title and three buttons in a row, a 2px underline for progress, and a
 * `readyToInstall` state that is easy to miss. This spike tries the
 * alternative the ConfigureTug wizard already proved: an update is a short
 * sequence of jobs — download, unpack, relaunch — and a sequence of jobs is a
 * step list with one pulsing dot per row, inside a standard dialog with an
 * icon, a title, a description, and its buttons along the bottom.
 *
 * The pill and the dialog are **one surface with two sizes**. The dialog's
 * upper right holds a collapse control; collapsing it makes a pill of it, so
 * a decision can be deferred to a convenient moment, and clicking the pill
 * expands it back to the dialog. Nothing else opens or closes it.
 *
 * Three surfaces, each simulated from local state so the real Sparkle flow
 * (two published releases and an installed copy) is not needed to look at it:
 *
 *   1. The pill — the shipping treatment beside three accent-coloured sizes,
 *      each shown in every stage that puts a pill on the canvas.
 *   2. The surface — a scenario picker drives the stage machine through the
 *      happy path and its branches, in the corner it would occupy, expanded
 *      or collapsed.
 *   3. The offer — the moment an update is found, with the release notes as
 *      the body.
 *
 * Nothing here touches `updateStore` or the host.
 *
 * @module spikes/spike-update-flow
 */

import "./spike.css";
import "./spike-update-flow.css";

import React, { useState } from "react";
import { ArrowDownToLine, ChevronsDownUp, CircleCheck, RefreshCw } from "lucide-react";

import { TugBadge } from "@/components/tugways/tug-badge";
import { TugIconButton } from "@/components/tugways/tug-icon-button";
import { TugInlineDialog } from "@/components/tugways/tug-inline-dialog";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugMarkdownBlock } from "@/components/tugways/tug-markdown-block";
import {
  TugProgressIndicator,
  type TugProgressIndicatorRole,
  type TugProgressIndicatorState,
} from "@/components/tugways/tug-progress-indicator";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugSeparator } from "@/components/tugways/tug-separator";

import type { SpikeDef } from "./spike-registry";

const VERSION = "0.8.2";

const NOTES = `A small release, mostly about getting releases to you faster.

- **Updates arrive sooner.** Tug now checks for a new version every two hours while it is running, instead of once a day.
- **New project commands show up right away.** A slash command added to a project's \`.claude/skills\` folder now appears in the \`/\` menu of a session you already had open.`;

// ---------------------------------------------------------------------------
// Section 1 — the pill
// ---------------------------------------------------------------------------

/** The stages that put a pill on the canvas, in the order a flow visits them. */
type PillStage =
  | "checking"
  | "available"
  | "downloading"
  | "readyToInstall"
  | "installing"
  | "upToDate"
  | "error";

const PILL_STAGES: { key: PillStage; label: string }[] = [
  { key: "checking", label: "Checking…" },
  { key: "available", label: VERSION },
  { key: "downloading", label: `Downloading ${VERSION}…` },
  { key: "readyToInstall", label: "Ready to install" },
  { key: "installing", label: "Installing…" },
  { key: "upToDate", label: "Up to date" },
  { key: "error", label: "Update failed" },
];

/** The glyph for a stage, or none for the stages that are only words. */
function pillGlyph(stage: PillStage): React.ReactNode {
  switch (stage) {
    case "available":
      return <ArrowDownToLine aria-hidden />;
    case "readyToInstall":
      return <RefreshCw aria-hidden />;
    case "checking":
    case "downloading":
    case "installing":
      return (
        <TugProgressIndicator
          variant="spinner"
          size={14}
          role="inherit"
          state="running"
          aria-hidden
        />
      );
    case "upToDate":
      return <CircleCheck aria-hidden />;
    case "error":
      return null;
  }
}

/** The badge role a stage wears: accent for the two that hold a decision. */
function pillRole(stage: PillStage): "accent" | "inherit" | "danger" | "success" {
  switch (stage) {
    case "available":
    case "readyToInstall":
      return "accent";
    case "error":
      return "danger";
    case "upToDate":
      return "success";
    default:
      return "inherit";
  }
}

/** The shipping pill, reproduced from `update-overlay.css`, for contrast. */
function ShippingPill({ stage, label }: { stage: PillStage; label: string }): React.ReactElement {
  return (
    <span className="sp-update-shipping-pill" data-stage={stage}>
      {stage === "available" ? <ArrowDownToLine className="sp-update-shipping-glyph" aria-hidden /> : null}
      {label}
    </span>
  );
}

function PillGallery(): React.ReactElement {
  return (
    <div className="sp-update-pill-grid">
      <div className="sp-update-pill-grid-head" />
      <TugLabel size="2xs" emphasis="calm">Shipping</TugLabel>
      <TugLabel size="2xs" emphasis="calm">Badge md</TugLabel>
      <TugLabel size="2xs" emphasis="calm">Badge lg</TugLabel>
      <TugLabel size="2xs" emphasis="calm">Badge xl</TugLabel>
      {PILL_STAGES.map(({ key, label }) => (
        <React.Fragment key={key}>
          <TugLabel size="2xs" emphasis="calm" className="sp-update-pill-grid-head">
            {key}
          </TugLabel>
          <div className="sp-update-pill-cell">
            <ShippingPill stage={key} label={label} />
          </div>
          {(["md", "lg", "xl"] as const).map((size) => (
            <div className="sp-update-pill-cell" key={size}>
              <TugBadge
                emphasis={pillRole(key) === "inherit" ? "outlined" : "filled"}
                role={pillRole(key)}
                size={size}
                icon={pillGlyph(key)}
              >
                {label}
              </TugBadge>
            </div>
          ))}
        </React.Fragment>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 2 — the surface: a step list in a dialog, collapsible to the pill
// ---------------------------------------------------------------------------

type StepStatus = "pending" | "active" | "busy" | "error" | "done";

interface StepModel {
  key: string;
  label: string;
  detail?: string;
  status: StepStatus;
}

function dotVisual(status: StepStatus): {
  role: TugProgressIndicatorRole;
  state: TugProgressIndicatorState;
} {
  switch (status) {
    case "pending":
      return { role: "inherit", state: "stopped" };
    case "active":
      return { role: "action", state: "paused" };
    case "busy":
      return { role: "agent", state: "running" };
    case "error":
      return { role: "danger", state: "aborted" };
    case "done":
      return { role: "success", state: "completed" };
  }
}

function UpdateStepRow({ step }: { step: StepModel }): React.ReactElement {
  const { role, state } = dotVisual(step.status);
  return (
    <li className="sp-update-step" data-status={step.status}>
      <div className="sp-update-step-main">
        <div className="sp-update-step-headline">
          <TugProgressIndicator
            variant="pulsing-dot"
            size={14}
            role={role}
            state={state}
            className="sp-update-step-dot"
            aria-hidden
          />
          <span className="sp-update-step-label">{step.label}</span>
        </div>
        {step.detail && <span className="sp-update-step-detail">{step.detail}</span>}
      </div>
      {step.status === "done" ? (
        <CircleCheck className="sp-update-step-check" size={24} aria-hidden />
      ) : null}
    </li>
  );
}

type Scenario =
  | "available"
  | "downloading_indeterminate"
  | "downloading"
  | "extracting"
  | "ready"
  | "installing"
  | "download_failed"
  | "up_to_date";

const SCENARIOS: { key: Scenario; label: string }[] = [
  { key: "available", label: "Available" },
  { key: "downloading_indeterminate", label: "Downloading (no total yet)" },
  { key: "downloading", label: "Downloading 62%" },
  { key: "extracting", label: "Unpacking" },
  { key: "ready", label: "Ready to install" },
  { key: "installing", label: "Installing" },
  { key: "download_failed", label: "Download failed" },
  { key: "up_to_date", label: "Up to date" },
];

interface ActionModel {
  label: string;
  primary?: boolean;
  to?: Scenario;
}

interface FlowModel {
  title: string;
  description: string;
  iconRole: "default" | "caution" | "danger" | "success" | "info";
  steps: StepModel[];
  /** The bottom row's right-hand group: the quiet one first, the primary last. */
  actions: ActionModel[];
  /** The bottom row's left-hand action — the rare one, apart from the decision. */
  leftAction?: ActionModel;
}

function buildFlow(scenario: Scenario): FlowModel {
  const download = (o: Partial<StepModel>): StepModel => ({
    key: "download",
    label: `Download Tug ${VERSION}`,
    status: "pending",
    ...o,
  });
  const unpack = (o: Partial<StepModel>): StepModel => ({
    key: "unpack",
    label: "Unpack the update",
    status: "pending",
    ...o,
  });
  const relaunch = (o: Partial<StepModel>): StepModel => ({
    key: "relaunch",
    label: "Install and relaunch",
    status: "pending",
    ...o,
  });
  switch (scenario) {
    case "available":
      return {
        title: `Tug ${VERSION} is available`,
        description: "You have 0.8.1. The update downloads in the background; Tug relaunches only when you say so.",
        iconRole: "info",
        steps: [
          download({ status: "active", detail: "About 70 MB." }),
          unpack({}),
          relaunch({ detail: "Sessions mid-turn are finished first." }),
        ],
        actions: [
          { label: "Later" },
          { label: "Download", primary: true, to: "downloading_indeterminate" },
        ],
        leftAction: { label: "Skip This Version" },
      };
    case "downloading_indeterminate":
      return {
        title: `Downloading Tug ${VERSION}`,
        description: "Keep working — nothing changes until you choose to relaunch.",
        iconRole: "info",
        steps: [
          download({ status: "busy", detail: "Starting…" }),
          unpack({}),
          relaunch({}),
        ],
        actions: [{ label: "Cancel", to: "available" }],
      };
    case "downloading":
      return {
        title: `Downloading Tug ${VERSION}`,
        description: "Keep working — nothing changes until you choose to relaunch.",
        iconRole: "info",
        steps: [
          download({ status: "busy", detail: "43 MB of 70 MB" }),
          unpack({}),
          relaunch({}),
        ],
        actions: [{ label: "Cancel", to: "available" }],
      };
    case "extracting":
      return {
        title: `Unpacking Tug ${VERSION}`,
        description: "Almost there.",
        iconRole: "info",
        steps: [
          download({ status: "done", detail: "70 MB" }),
          unpack({ status: "busy", detail: "Verifying the signature…" }),
          relaunch({}),
        ],
        actions: [],
      };
    case "ready":
      return {
        title: `Tug ${VERSION} is ready to install`,
        description: "Relaunch now, or leave it: the update installs itself the next time you quit Tug.",
        iconRole: "success",
        steps: [
          download({ status: "done", detail: "70 MB" }),
          unpack({ status: "done", detail: "Verified" }),
          relaunch({ status: "active", detail: "2 sessions are mid-turn: Fix the bless gate, Lens breakout." }),
        ],
        actions: [
          { label: "Later" },
          { label: "Install and Relaunch", primary: true, to: "installing" },
        ],
      };
    case "installing":
      return {
        title: `Installing Tug ${VERSION}`,
        description: "Tug is finishing its sessions and will relaunch on its own.",
        iconRole: "info",
        steps: [
          download({ status: "done", detail: "70 MB" }),
          unpack({ status: "done", detail: "Verified" }),
          relaunch({ status: "busy", detail: "Waiting for 1 session to finish its turn…" }),
        ],
        actions: [],
      };
    case "download_failed":
      return {
        title: "The update could not be downloaded",
        description: "The connection dropped. Nothing was changed.",
        iconRole: "danger",
        steps: [
          download({ status: "error", detail: "Network unreachable after 43 MB." }),
          unpack({}),
          relaunch({}),
        ],
        actions: [
          { label: "Dismiss" },
          { label: "Retry", primary: true, to: "downloading_indeterminate" },
        ],
      };
    case "up_to_date":
      return {
        title: "Tug is up to date",
        description: "0.8.1 is the newest version. Tug checks again every two hours.",
        iconRole: "success",
        steps: [],
        actions: [{ label: "OK", primary: true }],
      };
  }
}

/** The pill a scenario collapses to. */
function scenarioPill(scenario: Scenario): { stage: PillStage; label: string } {
  switch (scenario) {
    case "available":
      return { stage: "available", label: VERSION };
    case "downloading_indeterminate":
    case "downloading":
    case "extracting":
      return { stage: "downloading", label: `Downloading ${VERSION}…` };
    case "ready":
      return { stage: "readyToInstall", label: "Ready to install" };
    case "installing":
      return { stage: "installing", label: "Installing…" };
    case "download_failed":
      return { stage: "error", label: "Update failed" };
    case "up_to_date":
      return { stage: "upToDate", label: "Up to date" };
  }
}

function ScenarioPicker({
  scenario,
  onPick,
}: {
  scenario: Scenario;
  onPick: (next: Scenario) => void;
}): React.ReactElement {
  return (
    <div className="sp-update-scenarios">
      {SCENARIOS.map((s) => (
        <TugPushButton
          key={s.key}
          size="sm"
          emphasis={s.key === scenario ? "filled" : "ghost"}
          onClick={() => onPick(s.key)}
        >
          {s.label}
        </TugPushButton>
      ))}
    </div>
  );
}

function ActionButton({ action, go }: { action: ActionModel; go: (next: Scenario) => void }): React.ReactElement {
  return (
    <TugPushButton
      size="sm"
      emphasis={action.primary ? "filled" : "outlined"}
      role={action.primary ? "accent" : "action"}
      onClick={action.to ? () => go(action.to as Scenario) : undefined}
    >
      {action.label}
    </TugPushButton>
  );
}

/** The standard bottom row: the rare action on the left, the decision on the right. */
function DialogFooter({
  left,
  right,
  go,
}: {
  left?: ActionModel;
  right: ActionModel[];
  go: (next: Scenario) => void;
}): React.ReactElement | null {
  if (!left && right.length === 0) return null;
  return (
    <div className="sp-update-footer">
      <div className="sp-update-footer-left">
        {left ? <ActionButton action={left} go={go} /> : null}
      </div>
      <div className="sp-update-footer-right">
        {right.map((a) => (
          <ActionButton key={a.label} action={a} go={go} />
        ))}
      </div>
    </div>
  );
}

/** The one thing in the header's trailing slot: collapse to the pill. */
function CollapseControl({ onCollapse }: { onCollapse: () => void }): React.ReactElement {
  return (
    <TugIconButton
      icon={<ChevronsDownUp size={16} aria-hidden />}
      aria-label="Collapse to a pill"
      title="Collapse to a pill"
      onClick={onCollapse}
    />
  );
}

/** The dialog: icon, title, description, the step list, the bottom row. */
function FlowDialog({
  flow,
  go,
  onCollapse,
  children,
}: {
  flow: FlowModel;
  go: (next: Scenario) => void;
  onCollapse: () => void;
  children?: React.ReactNode;
}): React.ReactElement {
  const icon = flow.iconRole === "success" ? <CircleCheck /> : <ArrowDownToLine />;
  return (
    <div className="sp-update-panel">
      <TugInlineDialog
        icon={icon}
        iconRole={flow.iconRole}
        title={flow.title}
        description={flow.description}
        actions={<CollapseControl onCollapse={onCollapse} />}
      >
        {children}
        {flow.steps.length > 0 ? (
          <ol className="sp-update-steps">
            {flow.steps.map((s) => (
              <UpdateStepRow key={s.key} step={s} />
            ))}
          </ol>
        ) : null}
        <DialogFooter left={flow.leftAction} right={flow.actions} go={go} />
      </TugInlineDialog>
    </div>
  );
}

/** The collapsed form of the surface: the pill, which expands on click. */
function CollapsedPill({
  stage,
  label,
  title,
  onExpand,
}: {
  stage: PillStage;
  label: string;
  title: string;
  onExpand: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      className="sp-update-pill-button"
      aria-label={`${title} — expand`}
      onClick={onExpand}
    >
      <TugBadge
        emphasis={pillRole(stage) === "inherit" ? "outlined" : "filled"}
        role={pillRole(stage)}
        size="lg"
        icon={pillGlyph(stage)}
      >
        {label}
      </TugBadge>
    </button>
  );
}

/**
 * The surface in the corner it would occupy: the dialog when expanded, the
 * pill when collapsed. The collapse control and the pill are the only two
 * things that change it, and each is the other's inverse.
 */
function CornerSurface({
  scenario,
  flow,
  go,
}: {
  scenario: Scenario;
  flow: FlowModel;
  go: (next: Scenario) => void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(true);
  const pill = scenarioPill(scenario);
  return (
    <div className="sp-update-corner" data-expanded={expanded ? "true" : "false"}>
      {expanded ? (
        <FlowDialog flow={flow} go={go} onCollapse={() => setExpanded(false)} />
      ) : (
        <CollapsedPill
          stage={pill.stage}
          label={pill.label}
          title={flow.title}
          onExpand={() => setExpanded(true)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 3 — the offer, with the notes in it
// ---------------------------------------------------------------------------

const OFFER: FlowModel = {
  title: `Tug ${VERSION} is available`,
  description: "You have 0.8.1.",
  iconRole: "info",
  steps: [],
  actions: [{ label: "Later" }, { label: "Download", primary: true }],
  leftAction: { label: "Skip This Version" },
};

function OfferDialog(): React.ReactElement {
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="sp-update-corner" data-expanded={expanded ? "true" : "false"}>
      {expanded ? (
        <FlowDialog flow={OFFER} go={() => {}} onCollapse={() => setExpanded(false)}>
          <div className="sp-update-notes">
            <TugMarkdownBlock initialText={NOTES} />
          </div>
        </FlowDialog>
      ) : (
        <CollapsedPill
          stage="available"
          label={VERSION}
          title={OFFER.title}
          onExpand={() => setExpanded(true)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The spike
// ---------------------------------------------------------------------------

function SpikeUpdateFlow(): React.ReactElement {
  const [scenario, setScenario] = useState<Scenario>("available");
  const flow = buildFlow(scenario);
  return (
    <div className="sp-content">
      <section className="sp-section">
        <h2 className="sp-section-title">The pill</h2>
        <TugLabel size="2xs" emphasis="calm">
          Shipping treatment beside three sizes of a filled accent badge, per stage. The two stages that hold a decision are accent; transient ones are outlined.
        </TugLabel>
        <PillGallery />
      </section>

      <TugSeparator />

      <section className="sp-section">
        <h2 className="sp-section-title">The surface: dialog, or pill</h2>
        <TugLabel size="2xs" emphasis="calm">
          One surface with two sizes. Expanded, it is a standard dialog in the corner — ConfigureTug's step list, buttons along the bottom. The control in its upper right collapses it to the pill so a decision can wait; clicking the pill expands it back. Primary CTAs advance one hop.
        </TugLabel>
        <ScenarioPicker scenario={scenario} onPick={setScenario} />
        <CornerSurface scenario={scenario} flow={flow} go={setScenario} />
      </section>

      <TugSeparator />

      <section className="sp-section">
        <h2 className="sp-section-title">The offer, with the notes</h2>
        <TugLabel size="2xs" emphasis="calm">
          The moment an update is found: icon, title, the release notes as the body, the decision along the bottom. Collapses the same way.
        </TugLabel>
        <OfferDialog />
      </section>
    </div>
  );
}

export const spike: SpikeDef = {
  name: "update-flow",
  title: "Update Flow",
  blurb: "Should the app-update pill and dialog be one collapsible surface — an accent badge that expands into a ConfigureTug-style step list with a standard button row?",
  icon: "ArrowDownToLine",
  size: { min: { width: 480, height: 400 }, preferred: { width: 760, height: 760 } },
  component: () => <SpikeUpdateFlow />,
};
