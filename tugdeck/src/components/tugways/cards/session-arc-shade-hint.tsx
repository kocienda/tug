/**
 * SessionArcShadeHint — what the arc shade says in its short form, for a
 * session with no arc.
 *
 * It leads with the one word the ARC cell reads, says in a sentence what an
 * arc is and names the command that starts one, and links to the feature
 * guide's section on arcs. It holds no control that starts an arc: the door
 * is `/arc`, typed. The link is a help link in the guide's own spelling
 * (`features.md#arcs`), opened through the `OPEN_HELP` command beside the
 * card this stands in.
 *
 * It holds no control at all beyond the link: nothing here starts an arc or
 * binds the session to one.
 *
 * Composes `TugLink`, which keeps its own tokens.
 *
 * Laws: [L06] no state, [L16] pairings declared, [L19] component authoring
 *       guide, [L20] the composed link keeps its tokens, [L30] opening help
 *       is the `OPEN_HELP` command
 */

import "./session-arc-shade-hint.css";

import React from "react";

import { dispatchCommand } from "@/command-dispatch";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { TugLink } from "@/components/tugways/tug-link";
import { useCardId } from "@/components/tugways/use-card-state-preservation";

/** The help document and the heading in it that says what an arc is. */
export const ARC_HELP = { doc: "features", anchor: "arcs" } as const;

export function SessionArcShadeHint(): React.ReactElement {
  // The card this stands in, which the help card opens beside.
  const hostCardId = useCardId();
  return (
    <div className="session-arc-shade-hint" data-slot="session-arc-shade-hint">
      <p className="session-arc-shade-hint-text">
        <span className="session-arc-shade-hint-none" data-slot="session-arc-shade-hint-none">
          None
        </span>
        {" "}
        An arc is a substantial change made on its own branch and worktree, walked through its
        stages by the app and joined back to your main branch as one commit. To start one,
        describe the change in this session and type <code>/arc</code>.
      </p>
      <div className="session-arc-shade-hint-actions">
        <TugLink
          href={`${ARC_HELP.doc}.md#${ARC_HELP.anchor}`}
          data-slot="session-arc-shade-hint-help"
          onClick={(event) => {
            // A help link opens its document in a help card and navigates nowhere.
            event.preventDefault();
            dispatchCommand(TUG_ACTIONS.OPEN_HELP, {
              ...ARC_HELP,
              ...(hostCardId !== null ? { originCardId: hostCardId } : {}),
            });
          }}
        >
          What an arc is
        </TugLink>
      </div>
    </div>
  );
}
