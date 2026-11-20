/**
 * brief-headings.ts — the findings and decisions a brief marks.
 *
 * A brief states each finding and each decision as a paragraph that opens
 * with a bold, tagged heading: `**[F03] An arc already records its brief.**`
 * or `**[B10] The Brief card shows the arc's brief** and offers…`. This reads
 * those headings out of a brief's text, in the order they are written. Pure:
 * no IO and no DOM.
 *
 * @module lib/brief-headings
 */

/** One tagged heading of a brief. */
export interface BriefHeading {
  /** The tag as written, without its brackets: `F03`, `B10`. */
  tag: string;
  /** What the tag's letter says the paragraph is. */
  kind: "finding" | "decision";
  /** The heading's words, without the tag and without a closing full stop. */
  title: string;
}

const HEADING = /^\*\*\[([FB])(\d+)\]\s+(.+?)\*\*/;
const FENCE = /^\s*(```|~~~)/;

/**
 * The tagged headings of a brief, in document order. A tag written twice
 * keeps its first heading, since a later mention is a reference to it. A
 * heading inside a fenced block is an example and is not read.
 */
export function extractBriefHeadings(text: string): BriefHeading[] {
  const headings: BriefHeading[] = [];
  const seen = new Set<string>();
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = HEADING.exec(line);
    if (match === null) continue;
    const tag = `${match[1]}${match[2]}`;
    if (seen.has(tag)) continue;
    const title = match[3].trim().replace(/[.:]$/, "").trim();
    if (title === "") continue;
    seen.add(tag);
    headings.push({ tag, kind: match[1] === "F" ? "finding" : "decision", title });
  }
  return headings;
}
