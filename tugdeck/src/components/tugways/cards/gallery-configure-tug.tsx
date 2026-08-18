/**
 * gallery-configure-tug.tsx — design spike for the ConfigureTug happy-path polish
 * ([#step-9] of roadmap/onboarding-and-install.md).
 *
 * ConfigureTug's real states only exist on a clean machine (Claude missing, signed
 * out, no cards) — states that are awkward to reach on a dev box. This card
 * simulates the whole setup flow from purely local state so the wizard's copy,
 * rhythm, and step-row visuals can be designed under HMR without standing up a
 * fresh guest.
 *
 * Two surfaces:
 *   1. Step-row states in isolation — one `SetupStepRow` per lifecycle status,
 *      so the row's pulsing-dot / label / detail / CTA can be tuned directly.
 *   2. Simulated flow — a scenario picker drives a full 3-step model through the
 *      happy path and the unhappy branches ([#step-10] preview), rendered inside
 *      a panel that mimics the real wizard body.
 *
 * The step row is a bespoke row: a `pulsing-dot` on the left, a requirement /
 * direction line, a detail message for state / progress / completion, and a CTA
 * (or a success check) on the right. Nothing here touches the real `authStore`.
 *
 * @module components/tugways/cards/gallery-configure-tug
 */

import React, { useState } from "react";
import { CircleCheck, Rocket } from "lucide-react";

import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugFileChooser } from "@/components/tugways/tug-file-chooser";
import {
  TugProgressIndicator,
  type TugProgressIndicatorRole,
  type TugProgressIndicatorState,
} from "@/components/tugways/tug-progress-indicator";
import { pendingOpenStepCopy } from "@/components/tugways/configure-tug-copy";


/** The prefill the projects-folder scenarios show. */
const PROJECT_DIR = "/Users/ken/tug";

/** The version pair the install row's version states report. */
const INSTALLED_VERSION = "2.1.222";
const LATEST_VERSION = "2.1.226";
import "./gallery.css";
import "./gallery-configure-tug.css";

// ---------------------------------------------------------------------------
// Step model
// ---------------------------------------------------------------------------

/**
 * A setup step's lifecycle status — the spike's design vocabulary:
 *   pending — not yet reached (dimmed, quiet dot)
 *   active  — the user's turn; a CTA is shown
 *   busy    — an async action is in flight (install / browser sign-in)
 *   error   — the action failed; a retry CTA is shown
 *   done    — satisfied
 */
type StepStatus = "pending" | "active" | "busy" | "error" | "done";

interface StepCta {
  label: string;
  onClick?: () => void;
}

interface SetupStepModel {
  key: string;
  /** Requirement / direction line — the step's heading. */
  label: string;
  /** State / progress / completion message under the label. */
  detail?: string;
  /** Extra content under the detail line — a download's progress bar. */
  body?: React.ReactElement;
  status: StepStatus;
  cta?: StepCta;
  /** A quieter alternative to the primary CTA, e.g. declining an offer. */
  secondaryCta?: StepCta;
}

/** Map a step status onto the left-hand `pulsing-dot`'s role + state. */
function dotVisual(status: StepStatus): {
  role: TugProgressIndicatorRole;
  state: TugProgressIndicatorState;
} {
  switch (status) {
    case "pending":
      return { role: "inherit", state: "stopped" };
    case "active":
      return { role: "action", state: "running" };
    case "busy":
      return { role: "agent", state: "running" };
    case "error":
      return { role: "danger", state: "aborted" };
    case "done":
      return { role: "success", state: "completed" };
  }
}

const DOT_SIZE = 14;

// ---------------------------------------------------------------------------
// SetupStepRow — the bespoke spike row
// ---------------------------------------------------------------------------

function SetupStepRow({ step }: { step: SetupStepModel }): React.ReactElement {
  const { role, state } = dotVisual(step.status);
  return (
    <li className="cg-configure-tug-step" data-step={step.key} data-status={step.status}>
      <div className="cg-configure-tug-step-main">
        <div className="cg-configure-tug-step-headline">
          <TugProgressIndicator
            variant="pulsing-dot"
            size={DOT_SIZE}
            role={role}
            state={state}
            className="cg-configure-tug-step-dot"
            aria-hidden
          />
          <span className="cg-configure-tug-step-label">{step.label}</span>
        </div>
        {step.detail && (
          <span className="cg-configure-tug-step-detail">{step.detail}</span>
        )}
        {step.body && <div className="cg-configure-tug-step-body">{step.body}</div>}
      </div>
      {/* A settled step shows the check — unless it carries a CTA anyway (the
          installed-but-updatable row), where the offer takes the slot. */}
      {step.status === "done" && !step.cta ? (
        <div className="cg-configure-tug-step-action">
          <CircleCheck className="cg-configure-tug-step-check" size={28} aria-hidden />
        </div>
      ) : step.cta || step.secondaryCta ? (
        <div className="cg-configure-tug-step-action">
          {step.secondaryCta && (
            <TugPushButton size="sm" emphasis="ghost" onClick={step.secondaryCta.onClick}>
              {step.secondaryCta.label}
            </TugPushButton>
          )}
          {step.cta && (
            <TugPushButton
              size="sm"
              emphasis={
                step.status === "error" || step.status === "done" ? "outlined" : "filled"
              }
              role={step.status === "error" ? "danger" : "action"}
              disabled={step.status === "busy"}
              onClick={step.cta.onClick}
            >
              {step.cta.label}
            </TugPushButton>
          )}
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Section 1 — step states in isolation
// ---------------------------------------------------------------------------

const ISOLATED_STEPS: SetupStepModel[] = [
  {
    key: "pending",
    label: "Start a session",
    detail: "Waiting on the steps above.",
    status: "pending",
  },
  {
    key: "active",
    label: "Log in to Claude",
    detail: "Tug runs sessions with your Claude subscription.",
    status: "active",
    cta: { label: "Log In" },
  },
  {
    key: "busy",
    label: "Log in to Claude",
    detail: "Use your browser to log in…",
    status: "busy",
    cta: { label: "Logging in…" },
  },
  {
    key: "error",
    label: "Install Claude Code",
    detail: "Install failed: network unreachable.",
    status: "error",
    cta: { label: "Retry" },
  },
  {
    key: "done",
    label: "Logged in as ken@example.com",
    detail: "Claude Max plan",
    status: "done",
  },
];

// ---------------------------------------------------------------------------
// Section 2 — simulated flow
// ---------------------------------------------------------------------------

type Scenario =
  | "probing"
  | "fresh"
  | "installing"
  | "install_failed"
  | "update_available"
  | "updating"
  | "update_failed"
  | "logged_out_configured"
  | "signed_out"
  | "signing_in"
  | "signin_failed"
  | "project_dir_choose"
  | "project_dir_creating"
  | "project_dir_failed"
  | "ready_to_open"
  | "continue_working"
  | "complete"
  | "transport_down";

const SCENARIOS: { key: Scenario; label: string }[] = [
  { key: "probing", label: "Probing" },
  { key: "fresh", label: "Fresh (install)" },
  { key: "installing", label: "Installing" },
  { key: "install_failed", label: "Install failed" },
  { key: "update_available", label: "Update available" },
  { key: "updating", label: "Updating" },
  { key: "update_failed", label: "Update failed" },
  { key: "logged_out_configured", label: "Logged out (configured)" },
  { key: "signed_out", label: "Signed out" },
  { key: "signing_in", label: "Logging in" },
  { key: "signin_failed", label: "Log-in failed" },
  { key: "project_dir_choose", label: "Projects folder" },
  { key: "project_dir_creating", label: "Projects folder creating" },
  { key: "project_dir_failed", label: "Projects folder failed" },
  { key: "ready_to_open", label: "Ready to open" },
  { key: "continue_working", label: "Continue working" },
  { key: "complete", label: "Complete" },
  { key: "transport_down", label: "Transport down" },
];

interface FlowModel {
  steps: SetupStepModel[];
}

function buildFlow(
  scenario: Scenario,
  go: (next: Scenario) => void,
): FlowModel {
  const install = (overrides: Partial<SetupStepModel>): SetupStepModel => ({
    key: "install",
    label: "Install Claude Code",
    status: "pending",
    ...overrides,
  });
  const signin = (overrides: Partial<SetupStepModel>): SetupStepModel => ({
    key: "signin",
    label: "Log in to Claude",
    status: "pending",
    ...overrides,
  });
  const open = (overrides: Partial<SetupStepModel>): SetupStepModel => ({
    key: "open",
    label: "Start a session",
    status: "pending",
    ...overrides,
  });
  const projectDir = (overrides: Partial<SetupStepModel>): SetupStepModel => ({
    key: "project-dir",
    label: "Choose a default project directory",
    status: "pending",
    ...overrides,
  });
  // The real step's body — a directory chooser prefilled with the resolved
  // default. Read-only here: the spike drives states from the picker, not from
  // what is typed.
  const projectDirChooser = (
    label: string,
    failed = false,
  ): React.ReactElement => (
    <>
      <TugFileChooser
        value={PROJECT_DIR}
        onChange={() => {}}
        base={PROJECT_DIR}
        kind="directory"
        size="md"
        aria-label="Default project directory"
      />
      <TugPushButton
        size="sm"
        emphasis={failed ? "outlined" : "filled"}
        role={failed ? "danger" : "action"}
      >
        {label}
      </TugPushButton>
    </>
  );
  const installed = install({
    status: "done",
    label: "Claude Code installed",
    detail: `Version ${INSTALLED_VERSION} — up to date.`,
  });
  const signedIn = signin({
    status: "done",
    label: "Logged in as ken@example.com",
    detail: "Claude Max plan",
  });
  switch (scenario) {
    case "probing":
      return {
        steps: [
          install({ status: "busy", detail: "Looking for Claude Code…" }),
          signin({}),
          open({}),
        ],
      };
    case "fresh":
      return {
        steps: [
          install({
            status: "active",
            detail: "Tug will install it for you.",
            cta: { label: "Install", onClick: () => go("installing") },
          }),
          signin({}),
          open({}),
        ],
      };
    case "installing":
      return {
        steps: [
          install({
            status: "busy",
            detail: "This can take a moment.",
            cta: { label: "Installing…", onClick: () => {} },
          }),
          signin({}),
          open({}),
        ],
      };
    case "install_failed":
      return {
        steps: [
          install({
            status: "error",
            detail: "Install failed: network unreachable.",
            cta: { label: "Retry", onClick: () => go("installing") },
          }),
          signin({}),
          open({}),
        ],
      };
    case "update_available":
      // Settled, but a version behind: the dot stays green (nothing is
      // blocked) and the Update offer takes the success check's slot.
      return {
        steps: [
          install({
            status: "done",
            label: "Claude Code installed",
            detail: `Version ${INSTALLED_VERSION} — ${LATEST_VERSION} is available.`,
            cta: { label: "Update", onClick: () => go("updating") },
          }),
          signedIn,
          projectDir({ status: "done", label: "Default project directory", detail: PROJECT_DIR }),
          open({
            status: "active",
            detail: "Start working in a new session.",
            cta: { label: "Open a Session", onClick: () => go("complete") },
          }),
        ],
      };
    case "updating":
      return {
        steps: [
          install({
            status: "busy",
            label: "Update Claude Code",
            detail: `Installing ${LATEST_VERSION}…`,
            cta: { label: "Updating…", onClick: () => {} },
          }),
          signedIn,
          projectDir({ status: "done", label: "Default project directory", detail: PROJECT_DIR }),
          open({ status: "pending", label: "Start a session" }),
        ],
      };
    case "update_failed":
      return {
        steps: [
          install({
            status: "error",
            label: "Update Claude Code",
            detail: "Update failed: network unreachable.",
            cta: { label: "Retry", onClick: () => go("updating") },
          }),
          signedIn,
          projectDir({ status: "done", label: "Default project directory", detail: PROJECT_DIR }),
          open({ status: "pending", label: "Start a session" }),
        ],
      };
    case "logged_out_configured":
      // The Log Out gesture on an app that is already set up: only the two
      // questions the wizard is actually asking survive.
      return {
        steps: [
          installed,
          signin({
            status: "active",
            detail: "Tug runs sessions with your Claude subscription.",
            cta: { label: "Log In", onClick: () => go("complete") },
          }),
        ],
      };
    case "signed_out":
      return {
        steps: [
          install({ status: "done", label: "Claude Code installed", detail: "Claude Code is ready." }),
          signin({
            status: "active",
            detail: "Tug runs sessions with your Claude subscription.",
            cta: { label: "Log In", onClick: () => go("signing_in") },
          }),
          open({}),
        ],
      };
    case "signing_in":
      return {
        steps: [
          install({ status: "done", label: "Claude Code installed", detail: "Claude Code is ready." }),
          signin({
            status: "busy",
            detail: "Use your browser to log in…",
            cta: { label: "Logging in…", onClick: () => {} },
          }),
          open({}),
        ],
      };
    case "signin_failed":
      return {
        steps: [
          install({ status: "done", label: "Claude Code installed", detail: "Claude Code is ready." }),
          signin({
            status: "error",
            detail: "Log-in didn't finish. The browser may have been closed.",
            cta: { label: "Try Again", onClick: () => go("signing_in") },
          }),
          open({}),
        ],
      };
    case "project_dir_choose":
      return {
        steps: [
          installed,
          signedIn,
          projectDir({
            status: "active",
            detail: "Tug opens new sessions in this directory by default.",
            body: projectDirChooser("Choose"),
          }),
          open({ status: "pending", detail: "Waiting for a default project directory." }),
        ],
      };
    case "project_dir_creating":
      return {
        steps: [
          installed,
          signedIn,
          projectDir({
            status: "busy",
            detail: "Creating the folder…",
            body: projectDirChooser("Creating…"),
          }),
          open({ status: "pending", detail: "Waiting for a default project directory." }),
        ],
      };
    case "project_dir_failed":
      return {
        steps: [
          installed,
          signedIn,
          projectDir({
            status: "error",
            detail: `Couldn't create ${PROJECT_DIR}.`,
            body: projectDirChooser("Retry", true),
          }),
          open({ status: "pending", detail: "Waiting for a default project directory." }),
        ],
      };
    case "ready_to_open":
      return {
        steps: [
          installed,
          signedIn,
          projectDir({ status: "done", label: "Default project directory", detail: PROJECT_DIR }),
          open({
            status: "active",
            detail: "Start working in a new session.",
            cta: { label: "Open a Session", onClick: () => go("complete") },
          }),
        ],
      };
    case "continue_working":
      // Logged out with cards still open (the logout-with-work case): the
      // third step previews the return to work via the real
      // `pendingOpenStepCopy` helper — re-login auto-closes the wizard back
      // to those cards, so there is no active CTA here. [P04]
      return {
        steps: [
          install({ status: "done", label: "Claude Code installed", detail: "Claude Code is ready." }),
          signin({
            status: "active",
            detail: "Tug runs sessions with your Claude subscription.",
            cta: { label: "Log In", onClick: () => go("complete") },
          }),
          open({ status: "pending", ...pendingOpenStepCopy(3) }),
        ],
      };
    case "complete":
      return {
        steps: [
          installed,
          signedIn,
          projectDir({ status: "done", label: "Default project directory", detail: PROJECT_DIR }),
          open({ status: "done", detail: "Opening Session card…" }),
        ],
      };
    case "transport_down":
      return {
        steps: [
          {
            key: "reconnect",
            label: "Reconnecting…",
            detail: "Lost the connection to Tug. Setup will resume automatically.",
            status: "busy",
          },
        ],
      };
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
    <div className="cg-configure-tug-scenarios">
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

function WizardPreview({
  flow,
}: {
  flow: FlowModel;
}): React.ReactElement {
  return (
    <div className="cg-configure-tug-preview-panel" data-slot="setup-preview">
      <div className="cg-configure-tug-header">
        <Rocket className="cg-configure-tug-icon" size={32} aria-hidden />
        <div className="cg-configure-tug-preview-title">Configure Tug</div>
      </div>
      <ol className="cg-configure-tug-steps">
        {flow.steps.map((step) => (
          <SetupStepRow key={step.key} step={step} />
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GalleryConfigureTug
// ---------------------------------------------------------------------------

export function GalleryConfigureTug(): React.ReactElement {
  const [scenario, setScenario] = useState<Scenario>("fresh");
  const flow = buildFlow(scenario, setScenario);

  return (
    <div className="cg-content" data-testid="gallery-configure-tug">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Simulated flow</TugLabel>
        <TugLabel size="2xs" emphasis="calm">
          Pick a scenario to drive the wizard body. CTAs advance one hop forward.
        </TugLabel>
        <ScenarioPicker scenario={scenario} onPick={setScenario} />
        <WizardPreview flow={flow} />
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">
          Step-row states (bespoke row)
        </TugLabel>
        <div className="cg-configure-tug-rows-frame">
          <ol className="cg-configure-tug-steps">
            {ISOLATED_STEPS.map((step) => (
              <SetupStepRow key={step.key} step={step} />
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
