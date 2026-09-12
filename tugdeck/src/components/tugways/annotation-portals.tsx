/**
 * `useAnnotationPortals` — every React surface the annotator's marks earn,
 * collected in one pass.
 *
 * The annotator marks runs in DOM it walks; every entity kind it can mark
 * then wants a React component mounted into it — a session run wants the
 * live citation chip, a commit and a path run want the app's own hover.
 * They are portal hosts discovered by the same walk, so they are collected
 * together: a surface hands `onAnnotated` to its markdown block once, and
 * renders `portals` once, rather than knowing how many kinds currently earn
 * a component.
 *
 * @module components/tugways/annotation-portals
 */

import React from "react";

import { useAnnotationScope } from "@/components/tugways/annotation-scope";
import {
  useCommitTipPortals,
  type CommitMark,
} from "@/components/tugways/commit-tip-portals";
import { useFileTipPortals } from "@/components/tugways/file-tip-portals";
import { useSessionCitationPortals } from "@/components/tugways/session-citation-portals";
import type { AnnotationContext } from "@/lib/annotator/types";

/**
 * The `onAnnotated` callback to hand a markdown block, and the portals to
 * render.
 *
 * A commit tip has to ask what its sha resolved to, so the hook needs the
 * surface's {@link AnnotationContext}. Pass it when the surface threads one
 * as a prop (the Session transcript); omit it and the hook reads the
 * {@link AnnotationScope} the row already mounts, which is how the Overview
 * hands its context to the markdown block too.
 *
 * `commitMark` is the one thing a surface says about how a mark is DRAWN
 * rather than about which marks it has, and it exists because the session
 * description line cannot hold a pill: see {@link useCommitTipPortals}.
 */
export function useAnnotationPortals(
  annotation?: AnnotationContext | undefined,
  options?: { commitMark?: CommitMark },
): {
  onAnnotated: (container: HTMLElement) => void;
  portals: React.ReactNode;
} {
  const scoped = useAnnotationScope();
  const sessions = useSessionCitationPortals();
  const commits = useCommitTipPortals(
    (annotation ?? scoped)?.resolveCommit,
    options?.commitMark,
  );
  const files = useFileTipPortals();

  const sessionsAnnotated = sessions.onAnnotated;
  const commitsAnnotated = commits.onAnnotated;
  const filesAnnotated = files.onAnnotated;
  const onAnnotated = React.useCallback(
    (container: HTMLElement): void => {
      sessionsAnnotated(container);
      commitsAnnotated(container);
      filesAnnotated(container);
    },
    [sessionsAnnotated, commitsAnnotated, filesAnnotated],
  );

  return {
    onAnnotated,
    portals: (
      <>
        {sessions.portals}
        {commits.portals}
        {files.portals}
      </>
    ),
  };
}
