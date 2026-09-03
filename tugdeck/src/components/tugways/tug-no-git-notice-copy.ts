/**
 * tug-no-git-notice-copy — pure copy for {@link TugNoGitNotice}, split out from
 * the CSS-bearing `.tsx` so the wording is unit-testable ([D106], the same
 * split `configure-tug-copy` uses).
 *
 * @module components/tugways/tug-no-git-notice-copy
 */

import { COMMAND_LINE_TOOLS_SIZE } from "./configure-tug-copy";

// Both surfaces that offer the Command Line Tools say the size out loud
// ([D171]), and it is one number rather than two: a second declaration here
// would be a string that has to agree with the wizard's row and nothing to
// make it. Re-exported so this module is still the whole of the notice's copy
// for its reader and its tests.
export { COMMAND_LINE_TOOLS_SIZE };

export interface NoGitNoticeCopy {
  title: string;
  detail: string;
  /** The button's label, or `undefined` when there is no button to press. */
  action?: string;
}

/**
 * What the shades say on a machine whose git Tug cannot use.
 *
 * This is the same offer ConfigureTug's row makes, in the place the need is
 * actually felt — which is what makes a remembered skip in the wizard honest
 * rather than a dead end. Four readings:
 *
 *   - **installing** — the offer is in flight, so the block waits with Apple's
 *     installer rather than inviting a second press.
 *   - **failed** — the offer could not run, and the block offers a retry.
 *   - **too old** — a git that answered but is below the floor. Apple's git is
 *     fixed by the same install; a third-party git the user manages themselves
 *     is not, so that reading names the path and offers no button, because
 *     installing Apple's tools would leave the older git first on `PATH`.
 *   - **absent** — no git at all, and the offer proper.
 */
export function noGitNoticeCopy(tools: {
  gitVersion: string | null;
  gitPath: string | null;
  developerDir: string | null;
  gitFloor: string | null;
  offering: boolean;
  offerError: string | null;
}): NoGitNoticeCopy {
  const floor = tools.gitFloor ?? "2.23";

  if (tools.offering) {
    return {
      title: "Installing git…",
      detail: `Apple's installer is running — ${COMMAND_LINE_TOOLS_SIZE} to download`,
    };
  }

  if (tools.offerError !== null) {
    return {
      title: "Couldn't start the git install.",
      detail: tools.offerError,
      action: "Retry",
    };
  }

  if (tools.gitVersion !== null) {
    // `developerDir` is set only when the probe had to ask about it, which is
    // exactly the case where the git in question is Apple's.
    const applesGit = tools.developerDir !== null;
    return {
      title: `git ${tools.gitVersion} is too old.`,
      detail: applesGit
        ? `Tug needs git ${floor} or newer — Apple's Command Line Tools carry it, ${COMMAND_LINE_TOOLS_SIZE}`
        : `Tug needs git ${floor} or newer — update the git at ${tools.gitPath ?? "an unknown path"}`,
      ...(applesGit ? { action: "Install" } : {}),
    };
  }

  return {
    title: "git isn't installed.",
    detail: `Tug needs git to track changes and make commits — Apple's Command Line Tools carry it, ${COMMAND_LINE_TOOLS_SIZE}`,
    action: "Install",
  };
}
