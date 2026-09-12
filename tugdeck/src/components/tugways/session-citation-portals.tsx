/**
 * `useSessionCitationPortals` — a confirmed session run in prose becomes the
 * live citation chip.
 *
 * The annotator is a DOM pass: it can mark a run as a session, and it cannot
 * mount a React component into it. `TugSessionCitation` is a React component
 * with its own subscription, its own hover, its own gesture and its own
 * resolution states, and "exactly as the transcript does it" means that
 * component and not a drawing of it. Portals bridge the two, which is the
 * technique `tug-atom-markdown-body` already uses for atom chips.
 *
 * **One component, two registers.** `mark` says which — the pill, or the same
 * citation with no enclosure — and it is the only thing a surface gets to say
 * about how the mark is drawn. See {@link SessionMark} for the surface that
 * asks for the second one and the arithmetic that makes it ask.
 *
 * **Driven by the pass, not beside it.** Collection runs from
 * `TugMarkdownBlock`'s `onAnnotated` callback rather than from a second
 * `VerdictBatcher` subscription. A second subscription would appear to work —
 * child effects subscribe before parent effects, so the block's own re-mark
 * happens to run first — but that is an accident of tree shape. One refactor
 * moving this hook up a level would start collecting spans before the pass
 * that creates them.
 *
 * **The host list is a function of the live DOM, never an accumulation.**
 * `dropStaleWraps` may unwrap a session mark whose target stopped resolving,
 * which detaches a node React is portaling into; every pass therefore rebuilds
 * the list from what is in the container now, and an element that has left is
 * gone from it.
 *
 * Laws:
 *  - [L03] the walk runs in the block's layout effect, before paint.
 *  - [L06] nothing here is appearance state — the hosts are IDENTITY (which
 *    element, which session), and how the chip looks is the chip's business.
 *  - [L27] `onAnnotated` is a registration and hands back its release.
 *
 * @module components/tugways/session-citation-portals
 */

import React from "react";
import { createPortal } from "react-dom";

import { TugSessionCitation } from "@/components/tugways/tug-session-identity";
import { SESSION_TEXT_ATTRIBUTE } from "@/lib/annotator/annotate-content";

/** Every confirmed session span the annotator has marked in a container. */
const SESSION_SPANS = '[data-tug-annotation="session"]';

/**
 * Which register a confirmed run is drawn at.
 *
 * `"atom"` is the pill, and is the default everywhere a citation is read at
 * reading size. `"mention"` draws the same live citation with no enclosure —
 * the presence register — for the one surface whose band the pill does not fit
 * in: the session row's description line is chrome at 13px in a 1.2 band, and
 * a 22px box in a 15.6px one stands proud of its own line and into the one
 * above, where it met the resting underline of the path in the sentence
 * before. That is the same arithmetic `useCommitTipPortals`' `mention` answers
 * on the same line, and this is the same answer.
 *
 * It is the register that changes and nothing else: the component is the same
 * component, with its subscription, its resolution states and its raise
 * intact, so a citation in chrome is still the live thing a click can follow.
 */
export type SessionMark = "atom" | "mention";

/** One mounted chip: the emptied span, and the session it stands for. */
interface CitationMount {
  host: HTMLElement;
  /** The FULL session id the verdict resolved — what the chip cites. */
  citedId: string;
  /** The spelling the prose used, which is what the chip shows when the
   *  ledger cannot answer for it later. */
  recordedTag: string;
}

/**
 * Collect the confirmed session spans in `container` and portal a live
 * citation into each.
 *
 * Returns the callback to hand `TugMarkdownBlock` as `onAnnotated`, and the
 * portals to render. The portals are React nodes with no layout of their own —
 * render them anywhere in the consumer's tree; they mount into the spans.
 */
export function useSessionCitationPortals(
  /** Which register a confirmed run is drawn at. See {@link SessionMark}. */
  mark: SessionMark = "atom",
): {
  onAnnotated: (container: HTMLElement) => void;
  portals: React.ReactNode;
} {
  const [mounts, setMounts] = React.useState<readonly CitationMount[]>([]);

  const onAnnotated = React.useCallback((container: HTMLElement): void => {
    const spans = Array.from(
      container.querySelectorAll<HTMLElement>(SESSION_SPANS),
    );
    const next: CitationMount[] = [];
    for (const host of spans) {
      const citedId = host.getAttribute("data-target");
      if (citedId === null || citedId === "") continue;
      // First time this span is hosted: keep the words it shows, then empty
      // it so the chip is the only thing in it. The saved text is what
      // `dropStaleWraps` re-asks about and restores if the mark is dropped —
      // without it an unwrap would fold a hole into the sentence.
      let recordedTag = host.getAttribute(SESSION_TEXT_ATTRIBUTE);
      if (recordedTag === null) {
        recordedTag = host.textContent ?? "";
        host.setAttribute(SESSION_TEXT_ATTRIBUTE, recordedTag);
        host.textContent = "";
      }
      next.push({ host, citedId, recordedTag });
    }
    // Rebuild rather than merge, and only publish a change: a pass that finds
    // the same spans it found last time must not re-render every chip, and a
    // span that has left the DOM must not survive in the list.
    setMounts((prev) => (sameMounts(prev, next) ? prev : next));
  }, []);

  const portals = mounts.map(({ host, citedId, recordedTag }) =>
    createPortal(
      <TugSessionCitation
        citedId={citedId}
        recordedTag={recordedTag}
        context={{ recordedProject: projectOf(recordedTag) }}
        tier={mark === "mention" ? "line" : "chip"}
      />,
      host,
      `session-citation:${citedId}:${recordedTag}`,
    ),
  );

  return { onAnnotated, portals };
}

/** Whether two collections name the same hosts, in the same order. */
function sameMounts(
  a: readonly CitationMount[],
  b: readonly CitationMount[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (mount, i) => mount.host === b[i]!.host && mount.citedId === b[i]!.citedId,
  );
}

/**
 * The project half of a `project/callsign` spelling, or null for a uuid.
 *
 * An unresolvable citation still shows the project its prose named, which is
 * the same courtesy a session atom's chip extends.
 */
function projectOf(spelling: string): string | null {
  const slash = spelling.lastIndexOf("/");
  return slash <= 0 ? null : spelling.slice(0, slash);
}
