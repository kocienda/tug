/**
 * `SessionNoticeLine` — how a notice from Tug looks, wherever it is seated.
 *
 * A notice has two seats and one appearance ([P08]). Mid-turn it is a
 * `source: "notice"` system_note the transcript renders in place; between
 * turns it is an ink turn of its own that {@link SessionNoticeBlock} claims.
 * Both mount this, so the row cannot drift into two looks for one kind of
 * thing — which is what a second inline copy would have been free to do.
 *
 * The megaphone is the mark: Tug announcing something, rather than the model
 * speaking. The origin rides as the line's label, so the row says which
 * subsystem spoke without the sentence having to spend words on it — and it is
 * why the text itself carries no `[base-motion replay]`-style prefix.
 *
 * The body is markdown because a notice names paths, branches and shas, and a
 * sentence that says `` `0123456` `` should read as one.
 */
import type React from "react";
import { Megaphone } from "lucide-react";

import { TugQuietLine } from "@/components/tugways/tug-quiet-line";
import { TugMarkdownBlock } from "@/components/tugways/tug-markdown-block";

export function SessionNoticeLine({
  origin,
  text,
  title,
}: {
  origin: string;
  text: string;
  /** Hover title, when the seat has a wall-clock worth showing. */
  title?: string;
}): React.ReactElement {
  return (
    <div
      className="session-card-transcript-notice"
      data-slot="tug-notice"
      data-notice-origin={origin}
      {...(title !== undefined && title !== "" ? { title } : {})}
    >
      <TugQuietLine
        icon={<Megaphone size={16} aria-hidden="true" />}
        label={origin}
        subject={
          <TugMarkdownBlock
            key={`md-${text.length}`}
            initialText={text}
            className="session-card-transcript-notice-md"
            findable
          />
        }
        tone="quiet"
      />
    </div>
  );
}
