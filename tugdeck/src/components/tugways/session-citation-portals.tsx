/**
 * `useSessionCitationPortals` — a confirmed session run in prose becomes the
 * live citation chip.
 *
 * The annotator is a DOM pass: it can mark a run as a session, and it cannot
 * mount a React component into it. `SessionCitation` is a React component
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

import { SessionCitation } from "@/components/tugways/cards/session-identity";
import { SESSION_TEXT_ATTRIBUTE } from "@/lib/annotator/annotate-content";
import { useSpanPortals } from "@/components/tugways/use-span-portals";

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
  // The saved words are what `dropStaleWraps` re-asks about and restores if
  // the mark is dropped — without them an unwrap would fold a hole into the
  // sentence.
  return useSpanPortals<CitationMount>({
    name: "session-citation",
    selector: SESSION_SPANS,
    targetAttribute: "data-target",
    textAttribute: SESSION_TEXT_ATTRIBUTE,
    mountFor: (host, citedId, recordedTag) => ({ host, citedId, recordedTag }),
    render: ({ citedId, recordedTag }) => (
      <SessionCitation
        citedId={citedId}
        recordedTag={recordedTag}
        context={{ recordedProject: projectOf(recordedTag) }}
        tier={mark === "mention" ? "line" : "chip"}
      />
    ),
    keyFor: ({ citedId, recordedTag }) =>
      `session-citation:${citedId}:${recordedTag}`,
  });
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
