/**
 * dashes-start-sheet.tsx — "Start a dash…", the cockpit's way in.
 *
 * The Dashes section's whole argument is that it is a fixed address a reader
 * can glance at. An address with nothing to press is a noticeboard, and the one
 * act the section could not offer was the first one: starting work. Before
 * this, a dash began by knowing the roster of slash commands and their order.
 *
 * **The button does not start a dash.** It submits `/tugplug:dash <idea>` into
 * the followed session and fronts that card, and the model runs the arc from
 * there — sizing the idea, deciding brief-or-not, devising, stopping at the
 * review gate so the review is its own turn on a model the user chose, then
 * carrying the reviewed plan into implementation. Nothing here calls
 * machinery: `tugutil` is the engine's tool and the models', and a graphical
 * control that ran one would be doing the machine's job out of the reader's
 * sight, with no transcript row to show for it.
 *
 * So the sheet is a *composer for one sentence*. The idea is required and is
 * the whole of the prompt; the name is optional and rides as prose, because
 * the receiver is a skill reading English rather than a CLI parsing argv.
 *
 * The sheet names where the prompt will land before it lands there, and a
 * target that cannot take it disables Start with the reason in the control's
 * own label ([L31]) — the refusal a press would otherwise meet silently.
 *
 * `TugSheet` is **pane-modal**: it portals into the host pane's frame and drops
 * as a shade over that pane alone, so the Lens's own rail is what has to hold
 * it. That rail rests at 420px and can be dragged to 320, which is why the two
 * fields stack full width rather than sitting side by side. Peer panes stay
 * interactive throughout, which is correct — the sheet blocks the Lens, not the
 * session card its prompt is aimed at.
 *
 * Laws: [L20] composes `TugSheet`, `TugInput`, `TugPushButton` rather than
 * hand-rolling a dialog; [L24] the field text and the open state are view
 * scope, deliberately not persisted — a half-typed idea is not worth
 * remembering; [L31] every refusal is a sentence on the control.
 *
 * @module components/lens/sections/dashes-start-sheet
 */

import "./dashes-start-sheet.css";

import React, { useId, useState } from "react";
import { Plus } from "lucide-react";

import {
  TugSheet,
  TugSheetContent,
  TugSheetTrigger,
  useTugSheetClose,
} from "@/components/tugways/tug-sheet";
import { TugInput } from "@/components/tugways/tug-input";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { rowGridOrder, type SpatialOrder } from "@/components/tugways/spatial-order";
import { useSpatialOrder } from "@/components/tugways/use-spatial-order";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import { startDashPrompt, submitPromptToCard } from "@/lib/dash-prompts";
import { usePromptTarget } from "./dash-prompt-target";

/** Which placement a start control is rendered in — appearance only ([L06]). */
export type StartControlPlacement = "band" | "empty";

/** The last path component of an absolute project dir. */
function projectName(dir: string | null): string | null {
  if (dir === null || dir.length === 0) return null;
  const parts = dir.split("/").filter((part) => part.length > 0);
  return parts.length === 0 ? null : parts[parts.length - 1]!;
}

/**
 * The sheet's body: two stacked fields over a Cancel / Start row.
 *
 * Start is refused for two different reasons and says which: an empty idea
 * (there is no sentence to send) or an unreachable target (there is nowhere to
 * send it). Neither is a silent disable.
 */
function StartDashSheetBody(): React.ReactElement {
  const close = useTugSheetClose();
  const target = usePromptTarget({});
  const [idea, setIdea] = useState("");
  const [name, setName] = useState("");
  const focusGroup = useId();
  const NAME_ORDER = 0;
  const IDEA_ORDER = 1;
  const CANCEL_ORDER = 2;
  const START_ORDER = 3;
  const spatialOrder = React.useMemo<SpatialOrder>(
    () =>
      rowGridOrder([
        [`${focusGroup}:${NAME_ORDER}`],
        [`${focusGroup}:${IDEA_ORDER}`],
        [`${focusGroup}:${CANCEL_ORDER}`, `${focusGroup}:${START_ORDER}`],
      ]),
    [focusGroup],
  );
  useSpatialOrder(spatialOrder);
  // The idea is the required field and the whole of the prompt, so the caret
  // opens there — the name is an afterthought a reader may never fill in.
  useSeedKeyView(`${focusGroup}:${IDEA_ORDER}`);

  const hasIdea = idea.trim().length > 0;
  const where = projectName(target.projectDir);
  const refusal =
    target.reason ?? (hasIdea ? null : "Describe the work to start a dash");

  const start = (): void => {
    if (target.cardId === null || !hasIdea) return;
    submitPromptToCard(target.cardId, startDashPrompt(idea, name));
    close();
  };

  return (
    <div className="lens-start-dash" data-slot="lens-start-dash">
      <label className="lens-start-dash-label" htmlFor={`${focusGroup}-name`}>
        Name <span className="lens-start-dash-optional">(optional)</span>
      </label>
      <TugInput
        id={`${focusGroup}-name`}
        size="sm"
        placeholder="Chosen for you if you leave it blank"
        value={name}
        data-slot="lens-start-dash-name"
        onChange={(event) => setName(event.currentTarget.value)}
        focusGroup={focusGroup}
        focusOrder={NAME_ORDER}
      />
      <label className="lens-start-dash-label" htmlFor={`${focusGroup}-idea`}>
        What is the work?
      </label>
      <TugInput
        id={`${focusGroup}-idea`}
        size="sm"
        placeholder="One sentence is enough"
        value={idea}
        data-slot="lens-start-dash-idea"
        onChange={(event) => setIdea(event.currentTarget.value)}
        focusGroup={focusGroup}
        focusOrder={IDEA_ORDER}
      />
      {/* Where the prompt lands, said before it lands there — a press must
          never submit into a card the reader was not looking at. */}
      <p className="lens-start-dash-where" data-slot="lens-start-dash-where">
        {target.cardId !== null && where !== null
          ? `Asks the focused session, in ${where}.`
          : (target.reason ?? "Focus a session card to send this")}
      </p>
      <div className="tug-sheet-actions">
        <TugPushButton
          size="sm"
          emphasis="outlined"
          data-slot="lens-start-dash-cancel"
          focusGroup={focusGroup}
          focusOrder={CANCEL_ORDER}
          onClick={() => close()}
        >
          Cancel
        </TugPushButton>
        <TugPushButton
          size="sm"
          emphasis="primary"
          persistentDefaultRing
          data-slot="lens-start-dash-submit"
          disabled={refusal !== null}
          title={refusal ?? undefined}
          aria-label={refusal ?? "Start a dash"}
          focusGroup={focusGroup}
          focusOrder={START_ORDER}
          onClick={start}
        >
          Start
        </TugPushButton>
      </div>
    </div>
  );
}

/**
 * The start affordance, in one of its two placements.
 *
 * It lives in the band *and* in the empty state, deliberately. An affordance
 * that existed only while the section was empty would vanish the moment the
 * first dash appeared — exactly when starting a second piece of work becomes
 * the likely next act. The band's copy is the durable one; the empty state's is
 * the one a reader with nothing to look at cannot miss.
 *
 * The band renders its `headerActions` only while the section is expanded, so a
 * folded Dashes section offers neither. That is correct and not worth working
 * around: a section put away is one the reader is not acting on.
 */
export function DashesStartControl({
  placement,
}: {
  placement: StartControlPlacement;
}): React.ReactElement {
  return (
    <TugSheet>
      <TugSheetTrigger asChild>
        {placement === "band" ? (
          <TugPushButton
            size="2xs"
            subtype="icon"
            emphasis="ghost"
            aria-label="Start a dash"
            data-slot="lens-dashes-start"
            data-placement="band"
            icon={<Plus size={14} />}
          />
        ) : (
          <TugPushButton
            size="xs"
            emphasis="outlined"
            data-slot="lens-dashes-start"
            data-placement="empty"
          >
            Start a dash…
          </TugPushButton>
        )}
      </TugSheetTrigger>
      <TugSheetContent title="Start a dash" icon="GitBranch">
        <StartDashSheetBody />
      </TugSheetContent>
    </TugSheet>
  );
}
