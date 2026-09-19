/**
 * configure-tug-copy — pure copy helpers for ConfigureTug, split out from the component
 * so the wording rules are unit-testable without importing the CSS-bearing
 * `.tsx` (mirrors the `session-card-banner-spec` pattern). [D106]
 *
 * @module components/tugways/configure-tug-copy
 */

/**
 * Formal label for a Claude subscription tier (from `claude auth status`'s
 * `subscriptionType`), for the signed-in step's detail. Returns `undefined`
 * when unknown so the row simply omits the line — never a bare "subscription."
 * Unrecognized tiers are title-cased rather than leaked raw, so a future tier
 * still reads as a clean "Claude <Tier> plan".
 */
export function subscriptionLabel(
  type: string | null | undefined,
): string | undefined {
  const normalized = (type ?? "").trim().toLowerCase();
  switch (normalized) {
    case "":
      return undefined;
    case "max":
      return "Claude Max plan";
    case "pro":
      return "Claude Pro plan";
    case "team":
      return "Claude Team plan";
    case "enterprise":
      return "Claude Enterprise plan";
    case "free":
      return "Claude Free plan";
    default:
      return `Claude ${(type ?? "").trim().replace(/^\w/, (c) => c.toUpperCase())} plan`;
  }
}

/**
 * Compare two `MAJOR.MINOR.PATCH[-pre]` versions numerically: negative when
 * `a` is older than `b`, positive when newer, zero when the same. Numeric
 * segments compare as numbers (so 2.1.9 is older than 2.1.10); a pre-release
 * suffix sorts before the release it leads to, matching semver.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { nums: number[]; pre: string } => {
    const [core, ...rest] = v.trim().split("-");
    return {
      nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0),
      pre: rest.join("-"),
    };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < Math.max(left.nums.length, right.nums.length); i++) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  // A pre-release precedes its own release: 2.2.0-rc.1 < 2.2.0.
  if (left.pre === "") return 1;
  if (right.pre === "") return -1;
  return left.pre < right.pre ? -1 : 1;
}

/**
 * The install row's copy once Claude Code is present: what version is here,
 * and whether the stable channel has a newer one. Every field is optional on
 * the wire — a machine with no network knows its own version but not the
 * channel's, and a version lookup that has not answered yet knows neither — so
 * the row says only what it actually knows rather than guessing.
 *
 * `updatable` is what drives the Update CTA: it is true only when both versions
 * are known AND the installed one is genuinely older. A locally built or
 * ahead-of-channel `claude` therefore reads as current, never as behind.
 */
export function claudeInstalledCopy(
  installed: string | null,
  latest: string | null,
): { detail: string; updatable: boolean } {
  if (installed === null) {
    return { detail: "Claude Code is ready.", updatable: false };
  }
  if (latest === null) {
    return { detail: `Version ${installed}`, updatable: false };
  }
  if (compareVersions(installed, latest) < 0) {
    return { detail: `Version ${installed} — ${latest} is available.`, updatable: true };
  }
  return { detail: `Version ${installed} — up to date.`, updatable: false };
}

/**
 * Whether the wizard is asking a login question rather than a setup question:
 * the user is logged out on an app that is past its first run. That is the Log
 * Out gesture (and any relaunch with the login revoked), where the directory
 * and session rows belong to a first run that already happened — the wizard
 * then shows only the install and login rows rather than two rows the user
 * cannot act on while logged out. A genuine first run still gets the whole
 * checklist.
 *
 * The signal is the first run itself, not the stored project directory: the
 * directory is an optional answer — the resolved `~/tug` default stands in
 * when it was never chosen — so keying on it left the common re-login staring
 * at the whole checklist.
 */
export function isLoginOnlyWizard(
  loggedIn: boolean,
  firstRun: boolean,
): boolean {
  return !loggedIn && !firstRun;
}

/**
 * The key of the row whose button is Return's home, or `null` when Done is.
 *
 * The wizard names one Return home per render, and that button wears the
 * double ring — the ring is a promise about Return, and only one button can
 * keep it. A row wants the user when it is `active` (their turn) or `error`
 * (its retry is its only forward move), and only if it has a button to press;
 * the first such row wins. With no row wanting anything, Done keeps the ring.
 * A settled row's optional offer (Update) is never the home.
 */
export function returnHomeStepKey(
  steps: ReadonlyArray<{ key: string; status: string; hasAction: boolean }>,
): string | null {
  const home = steps.find(
    (step) => (step.status === "active" || step.status === "error") && step.hasAction,
  );
  return home?.key ?? null;
}

/**
 * Copy for the third setup step while it is still *pending* (the user isn't
 * logged in yet). When the deck already has open cards — the logout-with-work
 * case — the step previews the return to that work ("Continue working") rather
 * than nudging a brand-new session; on re-login the wizard auto-closes back to
 * those cards. A zero-card deck keeps the first-run wording. [P04]/[D106]
 *
 * Pure so the branch is unit-testable without the CSS-bearing `.tsx`. Only the
 * pending (logged-out) copy varies here; the logged-in "Start" active
 * step is owned by the component.
 */
export function pendingOpenStepCopy(cardCount: number): {
  label: string;
  detail?: string;
} {
  if (cardCount > 0) {
    const plural = cardCount === 1 ? "card" : "cards";
    return {
      label: "Continue working",
      detail: `You'll return to your ${cardCount} open ${plural}.`,
    };
  }
  return { label: "Start a session" };
}

/**
 * The size of Apple's Command Line Tools, said out loud. An Install button that
 * does not say what it costs is an ambush: a user on a metered connection or a
 * nearly-full disk deserves the number before they press it, not after.
 */
export const COMMAND_LINE_TOOLS_SIZE = "about 3 GB";

/** The lifecycle a ConfigureTug row's dot encodes ([D106]). */
export type HostToolsStepStatus = "active" | "busy" | "error" | "done";

/** What the git row says and offers, in whichever state the probe left it. */
export interface HostToolsCopy {
  status: HostToolsStepStatus;
  label: string;
  detail: string;
  /** Primary CTA label, or `undefined` when the row asks for nothing. */
  cta?: string;
  /** Quieter alternative — declining the offer, or re-checking. */
  secondaryCta?: string;
}

/**
 * The git row's copy, from the probe's answer and the offer's state.
 *
 * The six readings, in the order they are decided:
 *
 *   - **probing** — the frame has not landed. The row says so rather than
 *     guessing, because the guess it would otherwise make ("no git") is the one
 *     that puts a 3 GB ask in front of a machine that already has git.
 *   - **offer failed** — `xcode-select --install` genuinely could not run, and
 *     the row offers a retry. Note that "already installed" is *not* a failure:
 *     tugcast folds that exit into success, since it is the normal answer on a
 *     configured machine.
 *   - **present** — a git at or above the floor. Settled, and asks nothing.
 *   - **offer accepted, waiting** — Apple's installer is running in its own UI,
 *     which the backend cannot await. The row waits with it and carries
 *     **Recheck** for the user whose install finished without the watch seeing
 *     it, or who took the manual route.
 *   - **below the floor** — a git that answered but is too old. Where that git
 *     is Apple's, the same Command Line Tools install is the fix and the row
 *     offers it. Where it is a third-party git the user installed themselves,
 *     it is not: installing Apple's tools would leave the older git first on
 *     `PATH` and change nothing, so the row names the path and lets its owner
 *     deal with it rather than offering a button that cannot work.
 *   - **absent** — no git at all, and the offer proper, with the size said out
 *     loud and a skip beside it.
 *
 * Pure, so every branch is pinned without launching the app — which matters
 * more here than usual, because the machine running the tests always has git
 * and could otherwise only ever reach one of the six.
 */
export function hostToolsCopy(tools: {
  gitVersion: string | null;
  gitPath: string | null;
  developerDir: string | null;
  gitFloor: string | null;
  usable: boolean;
  probed: boolean;
  offering: boolean;
  offerError: string | null;
}): HostToolsCopy {
  const floor = tools.gitFloor ?? "2.23";

  if (!tools.probed) {
    return {
      status: "busy",
      label: "Check for git",
      detail: "Looking for git on this machine…",
    };
  }

  if (tools.offerError !== null) {
    return {
      status: "error",
      label: "Install git",
      detail: `Install failed: ${tools.offerError}`,
      cta: "Retry",
    };
  }

  if (tools.usable) {
    return {
      status: "done",
      label: "git installed",
      detail:
        tools.gitVersion !== null ? `Version ${tools.gitVersion}` : "git is ready.",
    };
  }

  if (tools.offering) {
    return {
      status: "busy",
      label: "Install git",
      detail: `Apple's installer is running — ${COMMAND_LINE_TOOLS_SIZE} to download.`,
      cta: "Installing…",
      secondaryCta: "Recheck",
    };
  }

  if (tools.gitVersion !== null) {
    // A git that answered, and is too old. `developerDir` is set only when the
    // probe had to ask about it, which is exactly the Apple-git case.
    const applesGit = tools.developerDir !== null;
    return {
      status: "error",
      label: "Update git",
      detail: applesGit
        ? `Version ${tools.gitVersion} — Tug needs git ${floor} or newer.`
        : `Version ${tools.gitVersion} at ${tools.gitPath ?? "an unknown path"} — Tug needs git ${floor} or newer.`,
      ...(applesGit ? { cta: "Install" } : {}),
    };
  }

  return {
    status: "active",
    label: "Install git",
    detail: `Tug uses git for changes, commits, and arcs. Apple's Command Line Tools carry it — ${COMMAND_LINE_TOOLS_SIZE}.`,
    cta: "Install",
    secondaryCta: "Skip for now",
  };
}
