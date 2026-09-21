/**
 * `useFileTipPortals` — a confirmed path in prose gets the app's file hover.
 *
 * The last of the three entity kinds to be answered in the app's own bubble.
 * A commit run got {@link useCommitTipPortals}, a session run got the live
 * citation chip, and a path run got nothing at all: an underline saying it
 * could be opened, and no way to see the whole of what would open. A path in
 * prose is nearly always partial — the agents write a basename, or a repo
 * path with the root implied — so the one fact the ink cannot carry is the
 * one the hover exists to state.
 *
 * The technique is {@link useCommitTipPortals}'s, and so is its cost: the
 * annotator is a DOM pass, so the only way to mount a React component into a
 * run it marked is to empty the host and portal into it. **What goes back is
 * the run's own characters**, unchanged — a path is what the writer wrote,
 * and unlike a sha it has no uniform spelling to normalize toward. The tip
 * carries the resolved absolute path instead, which is the fact the prose
 * elided rather than a second version of what it said.
 *
 * **Emptying the host is not free here, and `dropStaleWraps` is why.** A path
 * wrap is re-checked every pass — a file can be deleted, and a link whose
 * file has stopped resolving should stop being a link — and that check reads
 * the element's own text. An emptied host would read as `""`, resolve to
 * nothing, and unwrap every path mark on the next verdict batch. So the words
 * are preserved on {@link FILE_TEXT_ATTRIBUTE} before the host is emptied,
 * and the re-check reads them from there, exactly as the session arm already
 * does with {@link SESSION_TEXT_ATTRIBUTE}.
 *
 * **Annotator wraps only.** The selector is scoped to
 * {@link WRAPPED_ATTRIBUTE}, because a self-stamping {@link TugAtomRef}
 * carries the same `file-path` annotation and is not a run of prose: it owns
 * its own tip already, and emptying it would throw away its glyph and label.
 *
 * Laws:
 *  - [L03] collection runs in the block's layout effect, before paint.
 *  - [L06] nothing here is appearance state — the hosts are IDENTITY (which
 *    element, which path); how the bubble looks is the tooltip's business.
 *  - [L27] `onAnnotated` is a registration and hands back its release.
 *
 * @module components/tugways/file-tip-portals
 */

import React from "react";
import { createPortal } from "react-dom";

import { breadcrumb } from "@/lib/dom-forensics";
import { fileTip } from "@/components/tugways/entity-tips";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { FILE_TEXT_ATTRIBUTE } from "@/lib/annotator/annotate-content";
import { WRAPPED_ATTRIBUTE } from "@/lib/annotator/wrap-matches";

/**
 * Every confirmed path run the annotator has marked in a container — files
 * and directories alike, since both name something on disk the ink elides.
 */
const PATH_SPANS = [
  `[${WRAPPED_ATTRIBUTE}][data-tug-annotation="file-path"]`,
  `[${WRAPPED_ATTRIBUTE}][data-tug-annotation="directory"]`,
].join(", ");

/** One mounted tip: the emptied span, the path it names, and its words. */
interface FileTipMount {
  host: HTMLElement;
  /** The resolved absolute path — what the tip states. */
  path: string;
  /** The spelling the prose used, which is what goes back into the run. */
  text: string;
}

/**
 * Collect the confirmed path runs in `container` and portal the file tip
 * onto each.
 *
 * Returns the callback to hand `TugMarkdownBlock` as `onAnnotated`, and the
 * portals to render. The portals are React nodes with no layout of their
 * own — render them anywhere in the consumer's tree; they mount into the
 * spans.
 */
export function useFileTipPortals(): {
  onAnnotated: (container: HTMLElement) => void;
  portals: React.ReactNode;
} {
  const [mounts, setMounts] = React.useState<readonly FileTipMount[]>([]);

  const onAnnotated = React.useCallback((container: HTMLElement): void => {
    const spans = Array.from(
      container.querySelectorAll<HTMLElement>(PATH_SPANS),
    );
    const next: FileTipMount[] = [];
    for (const host of spans) {
      const path = host.getAttribute("data-path");
      if (path === null || path === "") continue;
      let text = host.getAttribute(FILE_TEXT_ATTRIBUTE);
      if (text === null) {
        text = host.textContent ?? "";
        host.setAttribute(FILE_TEXT_ATTRIBUTE, text);
        host.textContent = "";
      }
      next.push({ host, path, text });
    }
    // Rebuild rather than merge, and only publish a change: a pass that finds
    // the same spans it found last time must not re-render every tip, and a
    // span that has left the DOM must not survive in the list.
    breadcrumb("portal.hosts", { hook: "file-tip", hosts: next.length });
    setMounts((prev) => (sameMounts(prev, next) ? prev : next));
  }, []);

  const portals = mounts.map(({ host, path, text }, index) => {
    // A plain span, because the tooltip's trigger has to be an element and
    // the mark's own appearance is already on the host it portals into.
    const run = <span>{text}</span>;
    return createPortal(
      <TugTooltip variant="entity" align="start" content={fileTip({ path })}>
        {run}
      </TugTooltip>,
      host,
      // Indexed, because one post can name the same path twice — two hosts,
      // one path, and a path-only key would collide.
      `file-tip:${index}:${path}`,
    );
  });

  return { onAnnotated, portals };
}

/** Whether two collections name the same hosts, in the same order. */
function sameMounts(
  a: readonly FileTipMount[],
  b: readonly FileTipMount[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (mount, i) =>
      mount.host === b[i]!.host &&
      mount.path === b[i]!.path &&
      mount.text === b[i]!.text,
  );
}
