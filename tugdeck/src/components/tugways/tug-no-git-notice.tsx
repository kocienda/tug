/**
 * `TugNoGitNotice` — the shared "this machine has no git Tug can use"
 * affordance. The sibling of {@link TugNonRepoNotice}, on the same
 * ConfigureTug step-plinth shape ([D106]), rendered in both the Changes shade
 * and the History shade so the state reads identically on either route.
 *
 * **It takes precedence over `TugNonRepoNotice`**, and that ordering is the
 * point rather than a detail: a machine with no git cannot `git init` anything,
 * so offering Initialize there would be a button that cannot work. A missing
 * git is the more fundamental fact, and it is stated first.
 *
 * The CTA sends the same `offer_host_tools` action ConfigureTug's git row
 * sends. Tug ships no git of its own — git is GPLv2-only and Tug takes on no
 * GPL obligations ([D171]) — so the offer points at Apple's Command Line Tools
 * and the user installs them from Apple. This is also what makes the wizard's
 * remembered **Skip for now** honest: the offer comes back where the need is
 * real, so deferring it is a deferral rather than a dead end.
 *
 * Laws: [L02] the host-tools state enters React through `useSyncExternalStore`
 * (inside `useHostTools`); [L06] no appearance state in React.
 *
 * @module components/tugways/tug-no-git-notice
 */

import "./tug-no-git-notice.css";

import type { ReactElement } from "react";

import { TugPushButton } from "./tug-push-button";
import { getConnection } from "@/lib/connection-singleton";
import { hostToolsStore, useHostTools } from "@/lib/host-tools-store";
import { noGitNoticeCopy } from "./tug-no-git-notice-copy";

export function TugNoGitNotice(): ReactElement {
  const tools = useHostTools();
  const copy = noGitNoticeCopy(tools);
  const offer = (): void => {
    hostToolsStore.setOffering(true);
    getConnection()?.sendControlFrame("offer_host_tools");
  };
  return (
    <div className="tug-no-git-notice" role="group" data-testid="tug-no-git-notice">
      <div className="tug-no-git-notice-block">
        <div className="tug-no-git-notice-main">
          <span className="tug-no-git-notice-title">{copy.title}</span>
          <span className="tug-no-git-notice-detail">{copy.detail}</span>
        </div>
        {copy.action !== undefined ? (
          <div className="tug-no-git-notice-action">
            <TugPushButton
              size="sm"
              emphasis="filled"
              role="action"
              onClick={offer}
              data-testid="tug-no-git-notice-install"
            >
              {copy.action}
            </TugPushButton>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Whether the shades should show this notice instead of anything else they
 * would otherwise render. False until the probe has answered: a shade that
 * flashed "no git" during the round trip would be wrong on every machine that
 * has one, which is nearly all of them.
 */
export function shouldShowNoGitNotice(tools: {
  probed: boolean;
  usable: boolean;
}): boolean {
  return tools.probed && !tools.usable;
}
