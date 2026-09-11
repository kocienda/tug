/**
 * BeatText — one beat, with its file target worn as a file
 * reference rather than spelled as a path.
 *
 * The voice narrates file tools as `Editing <path> — 37 lines`, and the path
 * arrives whole — absolute when the session root could not account for it.
 * Spelling that path out is an ineffective use of a one-line strip: the head
 * of the string is all separators and the file name the reader wants is the
 * part a truncation eats. So every surface that shows a beat renders the
 * target as the transcript's file reference — the read-only atom skin,
 * full path as the hover tooltip, the same click-to-open annotation a path in
 * assistant prose gets — and the beat's verb and line count stay plain text
 * around it.
 *
 * A beat with no file target renders verbatim as a plain span. The masthead's
 * markdown/KaTeX pipeline is NOT re-implemented here; its mount tries this
 * component's grammar first and falls back to that pipeline, so a monologue
 * line with math still typesets and a tool beat never pays for a parse.
 *
 * Laws: [L06] appearance via CSS; [L19] file pair, `data-slot`;
 *       [L20] the file reference is `TugAtomRef`'s own, tokens and all.
 *
 * @module components/tugways/beat-text
 */

import "./beat-text.css";

import React from "react";

import { TugAtomRef } from "@/components/tugways/tug-atom-ref";
import { parseBeatFileTarget } from "@/lib/beat-line/beat-file-target";

export interface BeatTextProps {
  /** The beat, exactly as the digest feed carries it. */
  text: string;
  className?: string;
}

/**
 * A beat's display form: verb + file reference + suffix when the beat names a
 * file, the verbatim text otherwise.
 */
export function BeatText({
  text,
  className,
}: BeatTextProps): React.ReactElement {
  const target = React.useMemo(() => parseBeatFileTarget(text), [text]);
  if (target === null) {
    return <span className={className}>{text}</span>;
  }
  return (
    <span className={className} data-slot="beat-text">
      {target.head}
      <TugAtomRef
        entity={{ kind: "file", path: target.path }}
        className="beat-file-ref"
      />
      {target.tail}
    </span>
  );
}
