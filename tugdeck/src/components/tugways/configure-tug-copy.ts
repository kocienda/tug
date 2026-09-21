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

// ── The offline readings ─────────────────────────────────────────────────
//
// Everything below is about one sentence: the wizard must never hold the app
// over a question it cannot answer. Its two required actions both need the
// network — `install` shells out to `curl … | bash`, `log in` opens a browser
// OAuth round-trip to Anthropic — so on a machine that cannot reach either,
// the checklist is a door with no handle. The answer is not to hide the
// buttons but to stop *requiring* them: say plainly why they will not work,
// leave them where they are for the moment the network returns, and let go of
// the app so the user can read what is already on disk.

/**
 * How long the wizard holds a first run on "checking" before it stops waiting
 * for the probe.
 *
 * The hold exists so a first launch shows the checklist rather than flashing a
 * blank deck, and it was unbounded: `loggedIn === null` held `required` true
 * for as long as no answer came. With the probe itself now bounded, the only
 * way to stay `null` is a backend that never answered at all — a tugcast that
 * did not come up, a frame lost on a transport that reconnected. Twelve
 * seconds is past the probe's own five-second deadline with room for the
 * round-trip, so this fires only when the probe's answer never arrived rather
 * than racing it.
 */
export const CONFIGURE_TUG_PROBE_DEADLINE_MS = 12_000;

/**
 * Whether the wizard should still be holding for the first probe.
 *
 * The bounded form of `!forced && inFirstRun && loggedIn === null`. Past the
 * deadline this is false whatever the store says, which is the whole point:
 * `probing` is a term of `required`, so an unbounded hold is a wait with no
 * exit wearing a wizard's clothes.
 *
 * `loggedIn === null` is not on its own a reason to hold, and that
 * distinction is load-bearing: a `probe_failed` result carries `null` too,
 * and it is an *answer* — "we asked and could not tell". Holding on it sent
 * the wizard back to "Looking for Claude Code…" for the whole deadline after
 * the news had already arrived, which is both false on its face and the exact
 * hold this step exists to remove. So the hold is for silence only.
 */
export function deriveProbingHold(signals: {
  forced: boolean;
  inFirstRun: boolean;
  loggedIn: boolean | null;
  /** The `reason` beside `loggedIn`, which is what tells silence from news. */
  reason: string | null;
  deadlinePassed: boolean;
}): boolean {
  if (signals.forced) return false;
  if (signals.deadlinePassed) return false;
  if (signals.reason === "probe_failed") return false;
  return signals.inFirstRun && signals.loggedIn === null;
}

/**
 * Whether the wizard has a claim on the whole app.
 *
 * `required` is what makes the wizard app-modal with no way out, so what is
 * *not* in it matters as much as what is. A probe that could not tell is
 * absent by construction: `notReady` is `loggedIn === false`, and a
 * `probe_failed` result carries `loggedIn: null`, so an unanswered probe
 * asserts nothing here. That, plus a bounded `probing`, is what lets the
 * offline case fall through to a reachable deck ([L31]: a gesture produces
 * the act or a visible reason — and "the app is held" is neither).
 *
 * The second relaxation is the harder one, and it is the only place in Tug
 * that acts on the host's network-path hint. A **definite** `logged_out`
 * answered while the host reports the path `unsatisfied` also drops the
 * claim: Tug knows the user is signed out, and it knows the one fix — a
 * browser round-trip to Anthropic — cannot possibly work right now. Holding
 * the whole app behind a button that cannot succeed is the "unable to do its
 * main job, still responsive and truthful" line failed at its clearest case.
 *
 * **It reads only the believed negative.** `unsatisfied` means there is no
 * route, which is true; `satisfied` means a route exists, which captive wifi
 * reports while nothing gets through. So `satisfied` relaxes nothing, and a
 * `null` — the host has not reported yet, or there is no host — relaxes
 * nothing either. An absent hint is not an offline hint, and this function is
 * the one place that distinction has to be right ([P10]).
 *
 * Nothing else changes for such a user: `setup-seen` is still gated on a
 * definite login (see {@link deriveFirstRunComplete}), so getting out of the
 * way does not record a setup that never happened.
 */
export function deriveConfigureTugRequired(signals: {
  suppressed: boolean;
  forced: boolean;
  notReady: boolean;
  needsFirstSession: boolean;
  probing: boolean;
  /** The `reason` beside `loggedIn` — `"logged_out"` is the arm below. */
  reason: string | null;
  /** The host's last path report, or `null` for "nothing was reported". */
  pathStatus: string | null;
}): boolean {
  if (signals.suppressed) return false;
  if (signals.forced) return true;
  // Signed out, and the network the fix needs is not there. Only the
  // negative; `satisfied` and `null` both leave the claim standing.
  const loggedOutOffline =
    signals.reason === "logged_out" && signals.pathStatus === "unsatisfied";
  return (
    (signals.notReady && !loggedOutOffline) ||
    signals.needsFirstSession ||
    signals.probing
  );
}

/**
 * Whether this launch's first run may be recorded as finished.
 *
 * Deliberately **not** `!required`. Dropping `required` is how the offline
 * case gets out of the user's way, and reading that as "setup finished" would
 * permanently record a first run that never happened — the next launch would
 * give them a two-row login wizard for a setup they never completed, which is
 * the exact outcome the write exists to prevent. So the write needs a definite
 * positive answer: logged in, for real, with the checklist actually let go.
 * A `probe_failed` result is not that answer, and neither is silence.
 */
export function deriveFirstRunComplete(signals: {
  inFirstRun: boolean;
  suppressed: boolean;
  required: boolean;
  effectiveLoggedIn: boolean;
}): boolean {
  return (
    signals.inFirstRun &&
    !signals.suppressed &&
    !signals.required &&
    signals.effectiveLoggedIn
  );
}

/**
 * Which offline sentence the login row is saying.
 *
 * `probe_failed` — Tug asked and got no answer, so it does not know whether
 * the user is logged in. `logged_out_offline` — Tug knows they are logged out
 * *and* knows the network is why the fix cannot work. The second reading
 * needs a way to know the network is the reason, which is the host path hint
 * — so it was written before its producer existed and acquired one when the
 * hint landed. Its condition is exactly the relaxation in
 * {@link deriveConfigureTugRequired}: a definite `logged_out` over an
 * `unsatisfied` path.
 */
export type AuthOfflineReading = "probe_failed" | "logged_out_offline";

/** What the login row says when the network is what is missing. */
export interface AuthOfflineCopy {
  label: string;
  detail: string;
  /** The button stays — it is what the user presses when the network is back. */
  cta: string;
}

/**
 * The login row's offline copy.
 *
 * Both readings keep the button. Removing it would be the tidier-looking
 * choice and the wrong one: the user has no other way to retry, and a row
 * that explains a failure while withdrawing its only affordance is a dead
 * end. The detail line carries the reason instead, so pressing it and getting
 * nowhere is at least an informed press.
 */
export function authOfflineCopy(reading: AuthOfflineReading): AuthOfflineCopy {
  if (reading === "probe_failed") {
    return {
      label: "Can't check your login right now",
      detail:
        "Tug asked Claude Code whether you're logged in and got no answer. You can keep reading your existing sessions; starting a turn needs Claude Code.",
      cta: "Try Again",
    };
  }
  return {
    label: "Can't log in right now",
    detail:
      "Tug needs a network connection to reach Anthropic. Logging in opens your browser, which can't finish while you're offline.",
    cta: "Log In",
  };
}
