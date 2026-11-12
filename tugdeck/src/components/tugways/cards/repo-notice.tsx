/**
 * `RepoNotice` — what the Changes and History shades say when there is no git
 * repository to show: either this machine has no git Tug can use
 * (`kind="no-git"`), or this directory is not a repository yet
 * (`kind="non-repo"`). Both are one plinth, modeled on ConfigureTug's step
 * row ([D106]): a rounded block on the transcript block surface with a
 * left-aligned title and detail and a right-aligned button. It is not a
 * `TugStepRow`: a step row leads with a status dot, and a notice has no status
 * to show. Rendered in both shades so the state reads identically on either
 * route.
 *
 * **No git takes precedence over non-repo**, and that ordering is the point
 * rather than a detail: a machine with no git cannot `git init` anything, so
 * offering Initialize there would be a button that cannot work. A missing git
 * is the more fundamental fact, and it is stated first —
 * {@link shouldShowNoGitNotice} is decided ahead of the non-repo reading.
 *
 * - **no-git** sends the same `offer_host_tools` action ConfigureTug's git row
 *   sends. Tug ships no git of its own — git is GPLv2-only and Tug takes on no
 *   GPL obligations ([D171]) — so the offer points at Apple's Command Line
 *   Tools and the user installs them from Apple. This is also what makes the
 *   wizard's remembered **Skip for now** honest: the offer comes back where
 *   the need is real, so deferring it is a deferral rather than a dead end.
 * - **non-repo** owns the git-init round trip via {@link useChangesetGitInit}
 *   (keyed by `projectDir`): the button sends the CONTROL request; on success
 *   the server recomputes the aggregate and the project self-heals to a clean
 *   repo, dropping this affordance. An in-flight request disables the button;
 *   an error surfaces below the block.
 *
 * Laws: [L02] the host-tools state and the git-init verb store enter React
 * through `useSyncExternalStore` (inside their hooks); [L06] no appearance
 * state in React.
 *
 * @module components/tugways/cards/repo-notice
 */

import "./repo-notice.css";

import type { ReactElement, ReactNode } from "react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import { useChangesetGitInit } from "@/lib/changeset-verb-store";
import { getConnection } from "@/lib/connection-singleton";
import { hostToolsStore, useHostTools } from "@/lib/host-tools-store";
import { NON_REPO_NOTICE_COPY, noGitNoticeCopy } from "./repo-notice-copy";

/** Props for {@link RepoNotice}: which state, and what the non-repo kind needs. */
export type RepoNoticeProps =
  | { kind: "no-git" }
  | {
      kind: "non-repo";
      /** Repo-relative project directory to initialize. */
      projectDir: string;
      /** Gate the durable git-init verb while a turn runs (Changes shade only). */
      turnInProgress?: boolean;
    };

/** The shades' no-repository notice. */
export function RepoNotice(props: RepoNoticeProps): ReactElement {
  return props.kind === "no-git" ? (
    <NoGitNotice />
  ) : (
    <NonRepoNotice projectDir={props.projectDir} turnInProgress={props.turnInProgress ?? false} />
  );
}

function NoGitNotice(): ReactElement {
  const tools = useHostTools();
  const copy = noGitNoticeCopy(tools);
  const offer = (): void => {
    hostToolsStore.setOffering(true);
    getConnection()?.sendControlFrame("offer_host_tools");
  };
  return (
    <RepoNoticePlinth
      kind="no-git"
      title={copy.title}
      detail={copy.detail}
      action={
        copy.action !== undefined ? (
          <TugPushButton
            size="sm"
            emphasis="filled"
            role="action"
            onClick={offer}
            data-testid="tug-no-git-notice-install"
          >
            {copy.action}
          </TugPushButton>
        ) : null
      }
    />
  );
}

function NonRepoNotice({
  projectDir,
  turnInProgress,
}: {
  projectDir: string;
  turnInProgress: boolean;
}): ReactElement {
  const { phase, error, init } = useChangesetGitInit(projectDir);
  return (
    <RepoNoticePlinth
      kind="non-repo"
      title={NON_REPO_NOTICE_COPY.title}
      detail={NON_REPO_NOTICE_COPY.detail}
      action={
        <TugPushButton
          size="sm"
          emphasis="filled"
          role="action"
          onClick={init}
          disabled={phase === "pending" || turnInProgress}
          title={turnInProgress ? NON_REPO_NOTICE_COPY.turnGateHint : undefined}
          data-testid="tug-non-repo-notice-init"
        >
          {NON_REPO_NOTICE_COPY.action}
        </TugPushButton>
      }
      error={phase === "error" ? error : null}
    />
  );
}

/** The plinth both kinds stand on. */
function RepoNoticePlinth({
  kind,
  title,
  detail,
  action,
  error = null,
}: {
  kind: RepoNoticeProps["kind"];
  title: string;
  detail: string;
  action: ReactNode;
  error?: string | null;
}): ReactElement {
  return (
    <div
      className="tug-repo-notice"
      data-kind={kind}
      role="group"
      data-testid={`tug-${kind}-notice`}
    >
      <div className="tug-repo-notice-block">
        <div className="tug-repo-notice-main">
          <span className="tug-repo-notice-title">{title}</span>
          <span className="tug-repo-notice-detail">{detail}</span>
        </div>
        {action !== null ? <div className="tug-repo-notice-action">{action}</div> : null}
      </div>
      {error !== null ? <div className="tug-repo-notice-error">{error}</div> : null}
    </div>
  );
}

/**
 * Whether the shades should show the no-git notice instead of anything else
 * they would otherwise render. False until the probe has answered: a shade
 * that flashed "no git" during the round trip would be wrong on every machine
 * that has one, which is nearly all of them.
 */
export function shouldShowNoGitNotice(tools: {
  probed: boolean;
  usable: boolean;
}): boolean {
  return tools.probed && !tools.usable;
}
