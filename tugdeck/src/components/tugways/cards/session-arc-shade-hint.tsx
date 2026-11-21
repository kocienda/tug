/**
 * SessionArcShadeHint — what the arc shade says in its short form, for a
 * session with no arc.
 *
 * It leads with the one word the ARC cell reads, says in a sentence what an
 * arc is, offers New Arc, and links to the feature guide's section on arcs.
 * New Arc is the card's `new-arc` command, the one Session ▸ New Arc runs:
 * it sends `/arc` as a turn in this session. The button is dimmed while the
 * session cannot take a turn, since the door is a conversation and is not
 * queued behind work in flight. The link is a help link in the guide's own
 * spelling (`features.md#arcs`), opened through the `OPEN_HELP` command
 * beside the card this stands in.
 *
 * Under them, when the project has any, are its unbound arcs, the ones no
 * session is working, in the one order arcs are listed in: each its arc atom,
 * its stage, and Bind, which binds this session to it. Bind is the caller's;
 * it is never dimmed, since binding takes no turn.
 *
 * Composes `TugPushButton`, `TugLink` and `TugArcAtom`, which keep their own
 * tokens.
 *
 * Laws: [L06] no state, the dimming is the button's `disabled`, [L11] the
 *       button emits and the card performs, [L16] pairings declared, [L19]
 *       component authoring guide, [L20] the composed controls keep their
 *       tokens, [L30] opening help is the `OPEN_HELP` command
 */

import "./session-arc-shade-hint.css";

import React from "react";

import { dispatchCommand } from "@/command-dispatch";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { TugArcAtom } from "@/components/tugways/tug-arc-atom";
import { TugLink } from "@/components/tugways/tug-link";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import { useCardId } from "@/components/tugways/use-card-state-preservation";
import type { ArcChangesetEntry } from "@/lib/changeset-types";

/** The help document and the heading in it that says what an arc is. */
export const ARC_HELP = { doc: "features", anchor: "arcs" } as const;

/** The card command New Arc runs, the one Session ▸ New Arc names. */
export const NEW_ARC_COMMAND = "new-arc";

export interface SessionArcShadeHintProps {
  /** The session can take a turn now; New Arc is dimmed while it cannot. */
  canStart: boolean;
  /**
   * The project's arcs no session is working, in the order to list them.
   * @default []
   */
  unboundArcs?: readonly ArcChangesetEntry[];
  /** Bind this session to one of `unboundArcs`. */
  onBind?: (entry: ArcChangesetEntry) => void;
}

export function SessionArcShadeHint({
  canStart,
  unboundArcs = [],
  onBind,
}: SessionArcShadeHintProps): React.ReactElement {
  // The card this stands in, which the help card opens beside.
  const hostCardId = useCardId();
  const chain = useResponderChain();
  const startArc = (): void => {
    const target = hostCardId !== null ? `${hostCardId}-card-content` : null;
    if (chain === null || target === null || !chain.hasResponder(target)) return;
    chain.sendToTarget(target, {
      action: TUG_ACTIONS.RUN_SLASH_COMMAND,
      value: { name: NEW_ARC_COMMAND, args: "" },
      phase: "discrete",
    });
  };
  return (
    <div className="session-arc-shade-hint" data-slot="session-arc-shade-hint">
      <p className="session-arc-shade-hint-text">
        <span className="session-arc-shade-hint-none" data-slot="session-arc-shade-hint-none">
          None
        </span>
        {" "}
        An arc is a substantial change made on its own branch and worktree, walked through its
        stages by the app and joined back to your main branch as one commit. To start one,
        describe the change in this session and press New Arc.
      </p>
      <div className="session-arc-shade-hint-actions">
        <TugPushButton
          size="sm"
          emphasis="outlined"
          disabled={!canStart}
          onClick={startArc}
          data-slot="session-arc-shade-hint-new-arc"
        >
          New Arc
        </TugPushButton>
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
      {unboundArcs.length > 0 ? (
        <div className="session-arc-shade-hint-unbound" data-slot="session-arc-shade-hint-unbound">
          <p className="session-arc-shade-hint-text">
            Or bind this session to an arc no session is working:
          </p>
          <ul className="session-arc-shade-hint-arcs">
            {unboundArcs.map((entry) => (
              <li
                key={entry.owner_id}
                className="session-arc-shade-hint-arc"
                data-slot="session-arc-shade-hint-arc"
                data-arc={entry.display_name}
              >
                <TugArcAtom name={entry.display_name} />
                {entry.stage !== undefined ? (
                  <span className="session-arc-shade-hint-stage">{entry.stage}</span>
                ) : null}
                <TugPushButton
                  size="sm"
                  emphasis="outlined"
                  onClick={() => onBind?.(entry)}
                  data-slot="session-arc-shade-hint-bind"
                >
                  Bind
                </TugPushButton>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
