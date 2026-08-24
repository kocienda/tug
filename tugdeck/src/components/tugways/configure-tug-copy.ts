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
 * the user is logged out on an app that already has its default project
 * directory. That is the Log Out gesture (and any relaunch with the login
 * revoked), where the directory and session steps are already answered — the
 * wizard then shows only the install and login rows rather than two settled
 * rows the user cannot act on while logged out. A genuine first run (nothing
 * stored) still gets the whole checklist.
 */
export function isLoginOnlyWizard(
  loggedIn: boolean,
  storedProjectPath: string,
): boolean {
  return !loggedIn && storedProjectPath.trim() !== "";
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
