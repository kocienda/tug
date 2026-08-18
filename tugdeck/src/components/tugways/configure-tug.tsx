/**
 * ConfigureTug — the app-wide, blocking setup wizard. A sub-component of TugAlert:
 * it reuses TugAlert's app-modal chrome (Radix AlertDialog portalled into the
 * canvas overlay, the `tug-alert-overlay`/`tug-alert-content` classes at
 * z-index 99990/99991 that actually block the deck) and adds a multi-step
 * checklist body. Mounted once at the deck root; while open, nothing behind it
 * is reachable — setup is strictly required for an AI IDE.
 *
 * The steps, driven by the app-level {@link authStore} (one `claude auth
 * status` probe surfaced via `check_auth`), the {@link claudeVersionStore}
 * version pair, and the deck's card count:
 *   1. Claude Code — Tug-managed install + recheck, then the version it landed
 *      against the newest stable release, with an Update offer when it's
 *      behind. The updater IS the installer (the official installer always
 *      lands the newest stable build), so both live on one row.
 *   2. Logged in to Claude — browser OAuth shell-out.
 *   3. Choose a default project directory — a path chooser prefilled with
 *      `~/tug`. Confirming creates the directory and writes it to tugbank as
 *      the app-wide default project directory.
 *   4. Start a session — pops the first Session card. First-run only:
 *      a set-up user whose deck goes empty mid-life is left alone with it.
 *
 * A logged-out revisit of an app that is already configured (the Log Out
 * gesture, or a relaunch with the login revoked) shows only steps 1 and 2:
 * the directory is already chosen and the session step is answered by the deck
 * being returned to, so re-presenting them would be two settled rows the user
 * cannot act on. A genuine first run still gets the whole checklist.
 *
 * The projects-folder step gates the one below it: where projects live decides
 * what Open Quickly and the session picker reach for, so that answer is settled
 * before the wizard hands over a session. Nothing here asks about models — Tug
 * runs its aux model work on the user's Claude subscription, so signing in is
 * the only answer that question ever needed.
 *
 * Two ways in. The wizard opens itself when setup isn't done (the steps above),
 * and the Tug-menu "Configure Tug…" item opens it on demand on an app that is
 * already set up — `ConfigureTugRequest` stops any live turns first, then flips
 * `configure-tug-request-store`. The on-demand wizard differs in two ways: it is
 * dismissible (a Done button, and Escape), and it drops the "open your first
 * session" step. When setup is genuinely incomplete the required claim wins and
 * no exit is offered.
 *
 * ("Installed" and "reachable" collapse into one step: Tug resolves `claude`
 * via PATH then `~/.local/bin` — see `resolveClaudePath`/`claude_executable` —
 * so a binary the installer drops in `~/.local/bin` is reachable without any
 * shell-PATH edit. There is no realistic "installed but unreachable" state.)
 *
 * Each step is a bespoke pulsing-dot row ([D106]): the dot encodes lifecycle,
 * a CTA (or a success check) hangs on the right. The unhappy paths are
 * first-class designed states, not fallthroughs ([P10], roadmap/archive/onboarding-and-install.md#tugsetup-states):
 *   - install failed → `authStore.installError` → an error row + Retry;
 *   - sign-in cancelled / browser never returned → `authStore.signInFailed`
 *     (set when an attempt resolves still-logged-out, or by the local timeout)
 *     → an error row + Try Again;
 *   - transport down mid-setup → `transportStateStore` → a calm "Reconnecting…"
 *     body (only swaps an already-open wizard; never pops setup on a set-up
 *     user — the app-wide reconnect banner owns that);
 *   - version too old → `TugVersionGate`, a sibling app-modal that takes
 *     precedence (Spec S02); logged-out mid-session → the per-card session-card
 *     auth banner safety net.
 *
 * Pure read of the stores ([L02]/[L24]) — `authStore`, `claudeVersionStore`,
 * the deck, the transport and version-gate stores; the `check_auth` and
 * `check_claude_version` probes are fired imperatively from `main.tsx`. The sign-in timeout is the one imperative effect (it schedules a
 * store call, it does not mirror state).
 */

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { CircleCheck, Rocket } from "lucide-react";
import { type ReactElement, useEffect, useState, useSyncExternalStore } from "react";
import { useCanvasOverlay } from "@/lib/use-canvas-overlay";
import { authStore, useAuth } from "@/lib/auth-store";
import { useVersionGateOpen, deriveConfigureTugOpen } from "@/lib/macos-support";
import { useAppTransportState } from "@/lib/transport-state-store";
import { getConnection } from "@/lib/connection-singleton";
import { fireFreshSpawn } from "@/lib/session-restore";
import { getTugbankClient } from "@/lib/tugbank-singleton";
import {
  readSetupSeen,
  readSetupSuppressed,
  putSetupSeen,
  putDefaultProjectPath,
  DEFAULT_PROJECT_PATH_DOMAIN,
  DEFAULT_PROJECT_PATH_KEY,
  DEFAULT_PROJECT_DIR_LEAF,
} from "@/settings-api";
import { useTugbankValue } from "@/lib/use-tugbank-value";
import { useHostFacts } from "@/lib/host-facts-store";
import { makeDirectory } from "@/lib/fs-mkdir";
import type { TaggedValue } from "@/lib/tugbank-client";
import {
  useConfigureTugOnDemand,
  closeConfigureTugOnDemand,
} from "@/lib/configure-tug-request-store";
import { useDeckManager } from "@/deck-manager-context";
import { countWorkCards } from "@/deck-store-selectors";
import {
  claudeVersionStore,
  useClaudeVersion,
} from "@/lib/claude-version-store";
import {
  subscriptionLabel,
  pendingOpenStepCopy,
  claudeInstalledCopy,
  isLoginOnlyWizard,
} from "./configure-tug-copy";
import { TugPushButton } from "./tug-push-button";
import { TugFileChooser } from "./tug-file-chooser";
import {
  TugProgressIndicator,
  type TugProgressIndicatorRole,
  type TugProgressIndicatorState,
} from "./tug-progress-indicator";
import "./tug-alert.css";
import "./configure-tug.css";

// TEMP dev affordance (dev builds only): flip to a state to force the wizard
// while signed in, so it can be iterated under HMR. Leave `false`; the
// `import.meta.env.DEV` guard folds it out of production.
const SESSION_FORCE_SETUP: "claude_missing" | "logged_out" | "open_session" | false =
  false;

/**
 * A step's lifecycle status, encoded by the left-hand pulsing dot ([D106]):
 * `pending` (dimmed), `active` (the user's turn — a CTA shows), `busy` (an
 * async action in flight), `error` (failed — a retry CTA shows), `done`.
 */
type StepStatus = "pending" | "active" | "busy" | "error" | "done";

const DOT_SIZE = 14;

/**
 * How long to wait on a browser sign-in before offering a re-try (ms). Generous
 * — the verification email can be slow and the user may step away — so we only
 * give up after 10 minutes (a late `claude_auth_result` still wins).
 */
const SIGN_IN_TIMEOUT_MS = 600_000;

/** Read the explicit default project path out of a tugbank entry. */
function parseProjectPath(entry: TaggedValue | undefined): string {
  if (entry && entry.kind === "string" && typeof entry.value === "string") {
    return entry.value;
  }
  return "";
}

/** Map a step status onto the dot's role + state ([D02]/[D106]). */
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

function StepRow({
  stepKey,
  status,
  label,
  detail,
  body,
  cta,
  secondaryCta,
}: {
  stepKey: string;
  status: StepStatus;
  label: string;
  detail?: string;
  body?: ReactElement;
  cta?: { label: string; onClick: () => void };
  secondaryCta?: { label: string; onClick: () => void };
}): ReactElement {
  const { role, state } = dotVisual(status);
  return (
    <li className="configure-tug-step" data-step={stepKey} data-status={status}>
      <div className="configure-tug-step-main">
        <div className="configure-tug-step-headline">
          <TugProgressIndicator
            variant="pulsing-dot"
            size={DOT_SIZE}
            role={role}
            state={state}
            className="configure-tug-step-dot"
            aria-hidden
          />
          <span className="configure-tug-step-label">{label}</span>
        </div>
        {detail && <span className="configure-tug-step-detail">{detail}</span>}
        {body && <div className="configure-tug-step-body">{body}</div>}
      </div>
      {/* A settled step normally shows the green check. When it carries a CTA
          anyway — the installed-but-updatable row — the offer takes the slot:
          the dot already says "done", and a check next to an Update button
          would be two answers to the same question. */}
      {status === "done" && !cta ? (
        <div className="configure-tug-step-action">
          <CircleCheck className="configure-tug-step-check" size={28} aria-hidden="true" />
        </div>
      ) : cta || secondaryCta ? (
        <div className="configure-tug-step-action">
          {secondaryCta && (
            <TugPushButton size="sm" emphasis="ghost" onClick={secondaryCta.onClick}>
              {secondaryCta.label}
            </TugPushButton>
          )}
          {cta && (
            <TugPushButton
              size="sm"
              // A settled row's offer is optional, so it stays quieter than the
              // filled CTA of the step the user is actually on.
              emphasis={status === "error" || status === "done" ? "outlined" : "filled"}
              role={status === "error" ? "danger" : "action"}
              disabled={status === "busy"}
              onClick={cta.onClick}
            >
              {cta.label}
            </TugPushButton>
          )}
        </div>
      ) : null}
    </li>
  );
}

export function ConfigureTug(): ReactElement {
  const { loggedIn, reason, account, signingIn, signInFailed, installing, verifyingInstall, installError } =
    useAuth();
  const {
    installed,
    latest,
    updating,
    updateError,
  } = useClaudeVersion();
  const transport = useAppTransportState();
  const deck = useDeckManager();
  const deckState = useSyncExternalStore(deck.subscribe, deck.getSnapshot);
  // The Lens stands at its pin on any restored deck, so it must not read as
  // "this deck already holds work" — count everything but the Lens.
  const cardCount = countWorkCards(deckState);
  const [openedFirstSession, setOpenedFirstSession] = useState(false);
  // The Tug-menu "Configure Tug…" route: the wizard opened by request on an app that
  // is already set up. ConfigureTugRequest has already stopped any live turns by
  // the time this flips.
  const onDemand = useConfigureTugOnDemand();
  // The projects-folder step. The stored path is external state [L02]; the
  // chooser's in-flight text is a draft that exists only until the user
  // confirms, and `null` means "showing the resolved default".
  const storedProjectPath = useTugbankValue(
    DEFAULT_PROJECT_PATH_DOMAIN,
    DEFAULT_PROJECT_PATH_KEY,
    parseProjectPath,
    "",
  );
  const hostFacts = useHostFacts();
  const resolvedProjectPath =
    storedProjectPath !== ""
      ? storedProjectPath
      : hostFacts?.home
        ? `${hostFacts.home.replace(/\/+$/, "")}/${DEFAULT_PROJECT_DIR_LEAF}`
        : "";
  const [projectPathDraft, setProjectPathDraft] = useState<string | null>(null);
  const projectPathValue = projectPathDraft ?? resolvedProjectPath;
  // Confirmed during this wizard's lifetime — the same latch shape the
  // local-AI skip uses, so an on-demand revisit can change the answer and
  // still see the row settle.
  const [projectDirConfirmed, setProjectDirConfirmed] = useState(false);
  const [projectDirBusy, setProjectDirBusy] = useState(false);
  const [projectDirError, setProjectDirError] = useState<string | null>(null);

  const forced = import.meta.env.DEV ? SESSION_FORCE_SETUP : false;
  const forcedLoggedIn = forced === "open_session";
  const forcedReason =
    forced === "claude_missing"
      ? "claude_missing"
      : forced === "logged_out"
        ? "logged_out"
        : reason;

  const effectiveLoggedIn = forced ? forcedLoggedIn : loggedIn === true;
  const claudeMissing = forced
    ? forcedReason === "claude_missing"
    : reason === "claude_missing";

  const notReady = forced ? !forcedLoggedIn : loggedIn === false;

  // First launch: show the wizard up front and immediately, even before the
  // auth probe answers, rather than flashing a blank deck. The flag is read
  // once at mount (tugbank is ready before React mounts) and persisted on the
  // first run so later launches fall through to the normal probe-driven path.
  const [firstRun] = useState(() => {
    const client = getTugbankClient();
    return client ? !readSetupSeen(client) : false;
  });

  // The "open your first session" step claims the empty deck only on a
  // genuine first run. A set-up user whose deck goes empty mid-life (last card
  // closed, or a relaunch with an empty layout) is left alone with it.
  const needsFirstSession =
    firstRun && effectiveLoggedIn && cardCount === 0 && !openedFirstSession;

  // App-test suppression, read once at mount like `firstRun`: tugcast seeds
  // the flag when the app-test harness launched this instance, so the
  // blocking wizard never opens under a focus/selection-driven test. A
  // ConfigureTug-specific test opts back in via the harness (flag seeded false).
  const [suppressed] = useState(() => {
    const client = getTugbankClient();
    return client ? readSetupSuppressed(client) : false;
  });
  useEffect(() => {
    if (firstRun) putSetupSeen(true);
  }, [firstRun]);

  // Each on-demand visit starts fresh: the wizard is the gesture for changing
  // an answer, so nothing latched in a previous visit outlives it.
  useEffect(() => {
    if (onDemand) {
      setProjectDirConfirmed(false);
      setProjectDirError(null);
      setProjectPathDraft(null);
    }
  }, [onDemand]);

  // Sign-in safety net: the CLI's `claude auth login` blocks on its own browser
  // OAuth callback with no backend timeout, so a user who abandons the browser
  // would otherwise leave the wizard stuck on "Waiting…" forever. Bound the
  // wait; on expiry, surface the recoverable failure (a late success still
  // wins — `applyResult` clears the flag).
  useEffect(() => {
    if (!signingIn) return;
    const timer = window.setTimeout(
      () => authStore.markSignInTimedOut(),
      SIGN_IN_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [signingIn]);

  // While the probe is still in flight on a first launch, the login state is
  // unknown — render a "checking" body instead of guessing step statuses.
  const probing = !forced && firstRun && loggedIn === null;

  // The version gate takes precedence: while it is open, ConfigureTug suppresses
  // itself so the two app-modals never stack (Spec S02).
  const gateOpen = useVersionGateOpen();
  // Two ways in, with different exits. `required` is the wizard's own claim on
  // the app — setup isn't done, so there is nothing to dismiss to. On demand
  // the app IS set up and the user asked to look, so the wizard is theirs to
  // close. When both are true the required claim wins and Done stays hidden.
  const required =
    !suppressed && (forced !== false || notReady || needsFirstSession || probing);
  const open = deriveConfigureTugOpen(gateOpen, required || onDemand);

  // Which wizard the user is looking at, latched for as long as the panel is on
  // screen. Radix keeps the content mounted through its close animation, so
  // reading `onDemand` live would re-shape the steps under the fade: Done
  // clears the flag, and the dismissible layout would visibly turn back into
  // the required one on the way out. Latching while closed holds the picture
  // still. The adjust-during-render form (not an effect) means the shape is
  // right on the first painted frame of an open, with no flash either.
  const [showingOnDemand, setShowingOnDemand] = useState(false);
  if (open && showingOnDemand !== onDemand) setShowingOnDemand(onDemand);
  const dismissible = showingOnDemand && !required;

  const handleInstall = (): void => {
    authStore.setInstalling(true);
    getConnection()?.sendControlFrame("install_claude");
  };
  // The installer is the updater: it always lands the newest stable build, so
  // the same shell-out serves both rows. tugcast re-probes the version pair
  // afterward, and that re-probe is what settles the row.
  const handleUpdate = (): void => {
    claudeVersionStore.setUpdating(true);
    getConnection()?.sendControlFrame("update_claude");
  };
  const handleSignIn = (): void => {
    authStore.setSigningIn(true);
    getConnection()?.sendControlFrame("claude_sign_in");
  };
  const handleConfirmProjectDir = (): void => {
    const path = projectPathValue.trim();
    if (path === "") return;
    setProjectDirBusy(true);
    setProjectDirError(null);
    void makeDirectory(path)
      .then((created) => (created ? putDefaultProjectPath(path) : null))
      .then((storedPath) => {
        setProjectDirBusy(false);
        // Confirmed means tugbank holds it. A directory we made but couldn't
        // record is not a setting, and the step must not tick over as if the
        // choice took.
        if (storedPath === null) {
          setProjectDirError(path);
          return;
        }
        setProjectPathDraft(null);
        setProjectDirConfirmed(true);
      });
  };
  // The wizard already has the answer the picker would ask for — the projects
  // folder confirmed one row above — so the session starts here rather than in
  // a "Choose Session" sheet that would make the user say it a second time.
  // `fireFreshSpawn` sends the `new`-mode frame and holds the card on the quiet
  // restoring backdrop for the bind round-trip, so the picker never flashes.
  // Without a path or a connection there is nothing to spawn with; the card
  // still opens and presents its picker, which is the honest fallback.
  const handleOpenSession = (): void => {
    const cardId = deck.addCard("session");
    const projectDir = projectPathValue.trim();
    const connection = getConnection();
    if (cardId !== null && connection !== null && projectDir !== "") {
      fireFreshSpawn(cardId, crypto.randomUUID(), projectDir, connection);
    }
    setOpenedFirstSession(true);
  };

  const overlayRoot = useCanvasOverlay();

  // The ordered steps, each a pulsing-dot row ([D106]). During the first-run
  // probe the login state is unknown, so we render a "checking" body rather
  // than guess statuses.
  type Step = {
    key: string;
    status: StepStatus;
    label: string;
    detail?: string;
    /** Extra content under the detail line — the download's progress bar. */
    body?: ReactElement;
    cta?: { label: string; onClick: () => void };
    /** A quieter alternative to the primary CTA, e.g. declining an offer. */
    secondaryCta?: { label: string; onClick: () => void };
  };

  // Row one carries the whole life of the Claude Code install: getting it,
  // knowing which version is here, and keeping it current. The update path
  // shares the installer with the first install (the official installer always
  // lands the newest stable build), so the two differ only in what the row says.
  const claudeStep: Step = (() => {
    const key = "install";
    if (installing || verifyingInstall) {
      return {
        key,
        status: "busy",
        label: "Install Claude Code",
        detail: "This can take a moment.",
        cta: { label: "Installing…", onClick: handleInstall },
      };
    }
    if (installError) {
      return {
        key,
        status: "error",
        label: "Install Claude Code",
        detail: `Install failed: ${installError}`,
        cta: { label: "Retry", onClick: handleInstall },
      };
    }
    if (claudeMissing) {
      return {
        key,
        status: "active",
        label: "Install Claude Code",
        detail: "Tug will install it for you.",
        cta: { label: "Install", onClick: handleInstall },
      };
    }
    if (updating) {
      return {
        key,
        status: "busy",
        label: "Update Claude Code",
        detail: latest !== null ? `Installing ${latest}…` : "Installing the update…",
        cta: { label: "Updating…", onClick: handleUpdate },
      };
    }
    if (updateError !== null) {
      return {
        key,
        status: "error",
        label: "Update Claude Code",
        detail: `Update failed: ${updateError}`,
        cta: { label: "Retry", onClick: handleUpdate },
      };
    }
    // Installed and working. The row stays `done` even with an update on offer
    // — nothing is blocked by being a version behind — so the dot reads settled
    // and the Update button rides beside it in place of the success check.
    const { detail, updatable } = claudeInstalledCopy(installed, latest);
    return {
      key,
      status: "done",
      label: "Claude Code installed",
      detail,
      ...(updatable ? { cta: { label: "Update", onClick: handleUpdate } } : {}),
    };
  })();

  const signInStep: Step = claudeMissing
    ? { key: "signin", status: "pending", label: "Log in to Claude" }
    : signingIn
      ? {
          key: "signin",
          status: "busy",
          label: "Log in to Claude",
          detail: "Use your browser to log in…",
          cta: { label: "Logging in…", onClick: handleSignIn },
        }
      : effectiveLoggedIn
        ? {
            key: "signin",
            status: "done",
            label: account?.email ? `Logged in as ${account.email}` : "Logged in to Claude",
            detail: subscriptionLabel(account?.subscriptionType),
          }
        : signInFailed
          ? {
              key: "signin",
              status: "error",
              label: "Log in to Claude",
              detail: "Log-in didn't finish. The browser may have been closed.",
              cta: { label: "Try Again", onClick: handleSignIn },
            }
          : {
              key: "signin",
              status: "active",
              label: "Log in to Claude",
              detail: "Tug runs sessions with your Claude subscription.",
              cta: { label: "Log In", onClick: handleSignIn },
            };

  // Where the user's projects live. Always ends up persisted explicitly: the
  // session picker's seed chain reads the explicit value, so a post-setup user
  // who never touches Settings still gets their folder rather than falling
  // through to the launch hint.
  const projectDirStep: Step = (() => {
    const key = "project-dir";
    if (!effectiveLoggedIn) {
      return { key, status: "pending", label: "Choose a default project directory" };
    }
    // Settled: confirmed just now, or already chosen on a previous run. An
    // on-demand visit is the gesture for changing it, so it re-opens there.
    if (projectDirConfirmed || (storedProjectPath !== "" && !showingOnDemand)) {
      return {
        key,
        status: "done",
        label: "Default project directory",
        detail: projectDirConfirmed ? projectPathValue : storedProjectPath,
      };
    }
    // The chooser and its confirm button ride the body together on one
    // full-width line, rather than the button hanging in the row's action
    // slot. The action slot would take a fixed column out of the row's width,
    // and the field — the thing this step is actually about — would get what
    // was left. On its own line it gets the whole row.
    const chooser = (label: string): ReactElement => (
      <>
        <TugFileChooser
          value={projectPathValue}
          onChange={setProjectPathDraft}
          base={projectPathValue !== "" ? projectPathValue : (hostFacts?.home ?? "/")}
          kind="directory"
          size="md"
          onSubmit={handleConfirmProjectDir}
          disabled={projectDirBusy}
          aria-label="Default project directory"
        />
        <TugPushButton
          size="sm"
          emphasis={projectDirError !== null ? "outlined" : "filled"}
          role={projectDirError !== null ? "danger" : "action"}
          disabled={projectDirBusy}
          onClick={handleConfirmProjectDir}
        >
          {label}
        </TugPushButton>
      </>
    );
    if (projectDirBusy) {
      return {
        key,
        status: "busy",
        label: "Choose a default project directory",
        detail: "Creating the folder…",
        body: chooser("Creating…"),
      };
    }
    if (projectDirError !== null) {
      return {
        key,
        status: "error",
        label: "Choose a default project directory",
        detail: `Couldn't create ${projectDirError}.`,
        body: chooser("Retry"),
      };
    }
    return {
      key,
      status: "active",
      label: "Choose a default project directory",
      detail: "Tug opens new sessions in this directory by default.",
      body: chooser("Choose"),
    };
  })();

  const projectDirSettled = projectDirStep.status === "done";

  const openStep: Step = !effectiveLoggedIn
    ? // Pending (logged-out) preview: with cards already open — the
      // logout-with-work case — this reads "Continue working" and re-login
      // auto-closes the wizard back to them, rather than nudging a new card.
      { key: "open", status: "pending", ...pendingOpenStepCopy(cardCount) }
      : !projectDirSettled
        ? {
            key: "open",
            status: "pending",
            label: "Start a session",
            detail: "Waiting for a default project directory.",
          }
        : {
          key: "open",
          status: "active",
          label: "Start a session",
          detail: "Start working in a new session.",
          cta: { label: "Open a Session", onClick: handleOpenSession },
        };

  const probingSteps: Step[] = [
    { key: "install", status: "busy", label: "Install Claude Code", detail: "Looking for Claude Code…" },
    { key: "signin", status: "pending", label: "Log in to Claude" },
    { key: "open", status: "pending", label: "Start a session" },
  ];

  // Transport down mid-setup: replace the body with a calm "Reconnecting…" row
  // rather than a dead wizard (roadmap/archive/onboarding-and-install.md#tugsetup-states). This only changes the body of
  // an already-open wizard — it is deliberately NOT part of the `open`
  // derivation, so a transport blip never pops setup on an already-set-up user
  // (the app-wide reconnect banner covers that case).
  const transportDown = transport !== "online";
  const reconnectingSteps: Step[] = [
    {
      key: "reconnect",
      status: "busy",
      label: "Reconnecting…",
      detail: "Lost the connection to Tug. Setup will resume automatically.",
    },
  ];

  // Logging out of a configured app is a login question, not a setup question:
  // the project directory is already chosen and the session step is answered by
  // the deck the user is returning to. So the wizard shows only what it is
  // actually asking about — install and login — rather than re-presenting two
  // settled rows the user cannot act on while logged out. A first run (nothing
  // stored yet) still gets the whole checklist.
  const loginOnly = isLoginOnlyWizard(effectiveLoggedIn, storedProjectPath);

  const steps: Step[] = transportDown
    ? reconnectingSteps
    : probing
      ? probingSteps
      : loginOnly
        ? [claudeStep, signInStep]
        : [
            claudeStep,
            signInStep,
            projectDirStep,
            // …and the "open your first session" row is dead weight on a deck
            // that already has work in it; Done takes its place.
            ...(dismissible ? [] : [openStep]),
          ];

  return (
    <AlertDialog.Root open={open}>
      <AlertDialog.Portal container={overlayRoot}>
        <AlertDialog.Overlay className="tug-alert-overlay" />
        <AlertDialog.Content
          className="tug-alert-content configure-tug"
          data-slot="configure-tug"
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            // Required setup has no exit. A wizard the user opened themselves
            // does — Escape is the same act as Done.
            e.preventDefault();
            if (dismissible) closeConfigureTugOnDemand();
          }}
        >
          {/* In-jail key sink ([P13]): AlertDialog.Content's FocusScope is
              always trapped — it yanks focus back from anywhere outside the
              jail. The engine's park must land INSIDE it (the engine parks
              at the innermost mounted sink), or every park while the wizard
              is up is answered by a Radix refocus and the two systems
              fight. */}
          <div
            data-tug-key-sink=""
            tabIndex={-1}
            className="tug-key-sink"
            aria-label="Keyboard"
          />
          {/* Shared one-line modal header (tugx-header.css) — the alert
              header classes with no message: icon centered on the title. */}
          <div className="tug-alert-body" data-icon-role="action">
            <div className="tug-alert-icon" aria-hidden="true">
              <Rocket />
            </div>
            <div className="tug-alert-text">
              <AlertDialog.Title className="tug-alert-title">
                Configure Tug
              </AlertDialog.Title>
            </div>
          </div>

          <ol className="configure-tug-steps">
            {steps.map((step) => (
              <StepRow
                key={step.key}
                stepKey={step.key}
                status={step.status}
                label={step.label}
                detail={step.detail}
                body={step.body}
                cta={step.cta}
                secondaryCta={step.secondaryCta}
              />
            ))}
          </ol>

          {dismissible && (
            <div className="tug-alert-actions">
              <TugPushButton
                size="sm"
                emphasis="primary"
                role="action"
                persistentDefaultRing
                onClick={closeConfigureTugOnDemand}
              >
                Done
              </TugPushButton>
            </div>
          )}
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
