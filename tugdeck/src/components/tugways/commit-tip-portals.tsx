/**
 * `useCommitTipPortals` — a confirmed sha in prose gets the app's commit
 * hover, not the OS's.
 *
 * The annotator is a DOM pass: it can mark a run as a commit, and it cannot
 * mount a React component into it. That constraint is why the commit hover
 * was a `title` attribute for as long as it was — a plain string is the only
 * thing you can hand an element you did not render. The cost was that the
 * richest tooltip in the app was the one surface we could not theme, could
 * not delay, could not dismiss with the responder chain, and could not lay
 * out: an OS-drawn box in the system font, light in a dark theme.
 *
 * Portals bridge the two, exactly as {@link useSessionCitationPortals} does
 * for citation chips. The portal renders the commit's **mention label** —
 * `commit:<8ch>`, the same spelling every atom surface shows — wrapped in a
 * {@link TugTooltip} carrying {@link commitTip}. The spelling the prose used
 * is machine output, not authorship (git's short form lengthens with the
 * repository, so raw shas drift between 7 and 12 characters post to post);
 * it is preserved on {@link COMMIT_TEXT_ATTRIBUTE} for re-scan and unwrap,
 * and the reader sees one uniform, worded form. See
 * `tuglaws/entity-presentation.md`.
 *
 * **Emptying the host is safe here.** `dropStaleWraps` re-checks only the
 * kinds whose truth can change; a commit that resolved once stays resolved,
 * so a commit wrap is never unwrapped underneath us. The recorded text on
 * {@link COMMIT_TEXT_ATTRIBUTE} is therefore for idempotence across passes
 * (a re-walk finds an emptied span and must still know its words), not for
 * the restore path sessions need.
 *
 * Laws:
 *  - [L03] collection runs in the block's layout effect, before paint.
 *  - [L06] nothing here is appearance state — the hosts are IDENTITY (which
 *    element, which sha); how the bubble looks is the tooltip's business.
 *  - [L27] `onAnnotated` is a registration and hands back its release.
 *
 * @module components/tugways/commit-tip-portals
 */

import React from "react";
import { createPortal } from "react-dom";

import { SHA_DISPLAY_LEN } from "@/components/tugways/commit-sha-text";
import { commitTip } from "@/components/tugways/entity-tips";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import type { CommitFacts } from "@/lib/annotator/commit-resolution";
import type { AnnotationContext } from "@/lib/annotator/types";

/** Every confirmed commit span the annotator has marked in a container. */
const COMMIT_SPANS = '[data-tug-annotation="commit-sha"]';

/**
 * The run's own words, saved before the span is emptied to host the portal.
 * A later pass finds an empty span and would otherwise render nothing.
 */
export const COMMIT_TEXT_ATTRIBUTE = "data-tugx-commit-text";

/** One mounted tip: the emptied span, the sha it names, and its words. */
interface CommitTipMount {
  host: HTMLElement;
  /** The sha as the payload recorded it — what the tip describes. */
  sha: string;
  /** The spelling the prose used — preserved for re-scan, not displayed. */
  text: string;
  /**
   * The prose immediately before the run already says "commit", so the
   * label's word would double it: `Commit commit:86af912c`. The sentence
   * supplied the word; the label yields it and shows the hash alone.
   */
  worded: boolean;
}

/**
 * Prose that ends by saying the word itself — `Commit `, `commit: `,
 * `Commit #` — right where the run begins.
 */
const WORDED_BEFORE = /commit[:#]?\s*$/i;

/**
 * Whether the text just before `host` already supplies the word.
 *
 * The word and the sha are routinely split by markup — the agents write
 * ``commit `6077d7d6` `` and the sha's wrapper lands *inside* the `<code>`
 * element while the word sits outside it — so the check climbs out of any
 * element the host opens (a couple of hops covers code-in-paragraph) and
 * reads back through whitespace-only siblings until it finds prose.
 */
function wordedByProse(host: HTMLElement): boolean {
  let node: Node = host;
  for (let hops = 0; node.previousSibling === null && hops < 3; hops += 1) {
    const parent = node.parentNode;
    if (parent === null) return false;
    node = parent;
  }
  let before = "";
  let prev = node.previousSibling;
  while (prev !== null && before.trim() === "") {
    before = (prev.textContent ?? "") + before;
    prev = prev.previousSibling;
  }
  return WORDED_BEFORE.test(before);
}

/**
 * Collect the confirmed commit spans in `container` and portal the commit
 * tip onto each.
 *
 * Returns the callback to hand `TugMarkdownBlock` as `onAnnotated`, and the
 * portals to render. The portals are React nodes with no layout of their
 * own — render them anywhere in the consumer's tree; they mount into the
 * spans.
 */
export function useCommitTipPortals(
  /** Undefined on a surface with no annotation context — the spans are then
   *  never marked in the first place, and the hook stands down. */
  resolveCommit: AnnotationContext["resolveCommit"] | undefined,
): {
  onAnnotated: (container: HTMLElement) => void;
  portals: React.ReactNode;
} {
  const [mounts, setMounts] = React.useState<readonly CommitTipMount[]>([]);

  const onAnnotated = React.useCallback((container: HTMLElement): void => {
    const spans = Array.from(
      container.querySelectorAll<HTMLElement>(COMMIT_SPANS),
    );
    const next: CommitTipMount[] = [];
    for (const host of spans) {
      const sha = host.getAttribute("data-sha");
      if (sha === null || sha === "") continue;
      let text = host.getAttribute(COMMIT_TEXT_ATTRIBUTE);
      if (text === null) {
        text = host.textContent ?? "";
        host.setAttribute(COMMIT_TEXT_ATTRIBUTE, text);
        host.textContent = "";
      }
      next.push({ host, sha, text, worded: wordedByProse(host) });
    }
    // Rebuild rather than merge, and only publish a change: a pass that finds
    // the same spans it found last time must not re-render every tip, and a
    // span that has left the DOM must not survive in the list.
    setMounts((prev) => (sameMounts(prev, next) ? prev : next));
  }, []);

  const portals = mounts.map(({ host, sha, worded }, index) => {
    const verdict = resolveCommit?.(sha) ?? { state: "unknown" as const };
    const facts: CommitFacts | null =
      verdict.state === "confirmed" ? verdict.facts : null;
    // The mention label, not the prose spelling: `commit:<8ch>`, the same
    // worded form every atom surface shows — unless the sentence already
    // said the word, in which case the hash alone completes it. The
    // as-written characters stay on the host attribute; what the reader
    // sees is uniform.
    // A plain span, because the tooltip's trigger has to be an element and
    // the mark's own appearance is already on the host it portals into.
    const short = sha.slice(0, SHA_DISPLAY_LEN);
    const run = <span>{worded ? short : `commit:${short}`}</span>;
    return createPortal(
      facts === null ? (
        run
      ) : (
        <TugTooltip
          variant="entity"
          align="start"
          content={commitTip({
            sha,
            subject: facts.subject,
            author: facts.author,
            date: facts.date,
            files: facts.files,
          })}
        >
          {run}
        </TugTooltip>
      ),
      host,
      // Indexed, because one post can cite the same sha twice — two hosts,
      // one sha, and a sha-only key would collide.
      `commit-tip:${index}:${sha}`,
    );
  });

  return { onAnnotated, portals };
}

/** Whether two collections name the same hosts, in the same order. */
function sameMounts(
  a: readonly CommitTipMount[],
  b: readonly CommitTipMount[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (mount, i) =>
      mount.host === b[i]!.host &&
      mount.sha === b[i]!.sha &&
      mount.worded === b[i]!.worded,
  );
}
