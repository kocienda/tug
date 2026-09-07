/**
 * ArcTransportControl — Start, Resume and Stop as one button on an arc.
 *
 * Every surface that shows a whole arc shows the same control: the Arcs card's
 * row wears it in the eyebrow's trailing slot, and a Session card's `ARC`
 * popover wears it in the footer. The button's face is a pure function of the
 * entry ({@link transportFace}) and its destination is a pure function of the
 * surface ({@link resolveTransportActor}), so what this component adds is
 * exactly one thing the derivations cannot hold: the pending bit of a press
 * that has been sent and not yet answered.
 *
 * **The three acts, and why a row may perform them.** [D153] holds that a list
 * row's controls are navigation and the work belongs to the room the row opens
 * — with Replay named as the exception, because an arc that cannot be replayed
 * has no room to open. Start and Stop are the same exception for the same
 * reason, from the other end: an arc that is not running has no card to route
 * to, and an arc that *is* running is precisely the one whose room the user
 * cannot reach to stop it. Activation itself is unchanged and still opens the
 * worker's card ([D142]); this control sits beside that, in the trailing slot,
 * and stops the click from reaching the row.
 *
 * **A refused control is never DOM-disabled** ([P07]). A `disabled` button
 * takes no pointer events, so the `title` carrying the reason could never be
 * read, and an `xs` icon has no label to put it in. So a refusal renders
 * `aria-disabled` with `data-refused`, keeps its pointer events, and answers a
 * press by posting the reason to the pane bulletin of the card the press would
 * have acted as — the same voice the server's own refusals arrive in, through
 * the same store ([L31]: a gesture yields the act or a visible reason).
 *
 * A *pending* press is `aria-disabled` too, and for the opposite reason: the
 * frame is out and a second one would be a second act.
 *
 * Laws: [L02] the pending bit enters React through `useSyncExternalStore`;
 * [L06] refused and pending appearance ride `aria-disabled` and `data-*` with
 * CSS, never React state; [L19] `.tsx`/`.css` pair with `data-slot`; [L20] it
 * composes {@link TugPushButton} rather than restating a button's tokens.
 *
 * @module components/tugways/arc-transport-control
 */

import "./arc-transport-control.css";

import React, { useCallback, useSyncExternalStore } from "react";
import { Play, Square } from "lucide-react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import { arcPressStore, type ArcTransportVerb } from "@/lib/arc-press-store";
import {
  hasAnyDocument,
  resolveTransportActor,
  transportFace,
  type FollowedCardFacts,
} from "@/lib/arc-transport";
import type { ArcDocuments, ArcRunState } from "@/lib/changeset-types";
import { getConnection } from "@/lib/connection-singleton";

/** The CONTROL action each verb sends. */
const ACTION_FOR: Record<ArcTransportVerb, string> = {
  start: "arc_run",
  resume: "arc_resume",
  stop: "arc_stop",
};

/** The word each verb wears, and the sentence it labels itself with. */
const WORD_FOR: Record<ArcTransportVerb, string> = {
  start: "Start",
  resume: "Resume",
  stop: "Stop",
};

export interface ArcTransportControlProps {
  /** The arc's display name — what the frame names and the label reads. */
  arc: string;
  /** The project the arc belongs to. */
  projectDir: string;
  /** The arc's run, or null when none is driving it. */
  run: ArcRunState | null;
  /** Which of the arc's documents exist. */
  documents: ArcDocuments | undefined;
  /** The one live session holding the arc, or null. */
  boundSession: string | null;
  /** Which surface is asking. */
  surface: "arcs" | "popover";
  /** The Arcs card's followed card, or null. The popover passes its own card. */
  followed: FollowedCardFacts | null;
  /** The button's size, matching whatever cluster it sits in. */
  size: "xs" | "2xs";
  /** An icon in a row's trailing column, or a word in a footer. */
  form: "icon" | "word";
}

export function ArcTransportControl({
  arc,
  projectDir,
  run,
  documents,
  boundSession,
  surface,
  followed,
  size,
  form,
}: ArcTransportControlProps): React.ReactElement | null {
  const face = transportFace({
    arc: run,
    boundSession,
    hasDocument: hasAnyDocument(documents),
  });
  const actor = resolveTransportActor({
    face,
    boundSession,
    surface,
    followed,
    projectDir,
    arc,
  });
  // Subscribed unconditionally: a hook may not be skipped, and the face is
  // `none` on rows that draw nothing at all, which return below.
  const verb: ArcTransportVerb = face === "none" ? "start" : face;
  const pending = useSyncExternalStore(
    arcPressStore.subscribe,
    () => arcPressStore.isPending(arc, verb),
    () => false,
  );

  const press = useCallback(
    (event?: React.MouseEvent<HTMLButtonElement>): void => {
      // The row underneath opens the worker's card ([D142]). This control is
      // its own gesture, so the activation stops here.
      event?.stopPropagation();
      event?.preventDefault();
      if (pending) return;
      if (actor.reason !== null) {
        // The bulletin is the card the press would have acted as — the
        // followed card on the Arcs surface, this card in a popover. With
        // neither there is nowhere to speak, and the hover is the surface.
        const voice = followed?.tugSessionId ?? boundSession;
        if (voice !== null) {
          arcPressStore.refuse(voice, arc, verb, actor.reason);
        }
        return;
      }
      const connection = getConnection();
      if (connection === null) {
        // Not silent, and not greyed either: the button stays pressable so a
        // reconnect makes the same press work ([L31]).
        console.warn(`arc ${verb} not sent: no connection`, { arc });
        return;
      }
      arcPressStore.press(arc, verb);
      // The same three fields for every verb. A Start names no kind: the
      // opening reads that off the arc's documents ([P03]), and a row that
      // should not have offered Start is answered by the server's own refusal
      // naming the address to write to.
      connection.sendControlFrame(ACTION_FOR[verb], {
        tug_session_id: actor.tugSessionId,
        project_dir: actor.projectDir,
        arc,
      });
    },
    [actor, arc, boundSession, followed, pending, verb],
  );

  if (face === "none") return null;

  const word = WORD_FOR[verb];
  const refused = actor.reason !== null;
  const label = refused
    ? `${word} arc ${arc} — ${actor.reason}`
    : `${word} arc ${arc}`;

  return (
    <TugPushButton
      data-slot="arc-transport"
      data-verb={verb}
      data-form={form}
      data-pending={pending ? "true" : undefined}
      data-refused={refused ? "true" : undefined}
      className="tug-arc-transport"
      size={size}
      emphasis={form === "icon" ? "ghost" : "outlined"}
      subtype={form === "icon" ? "icon" : "text"}
      {...(form === "icon"
        ? { icon: verb === "stop" ? <Square /> : <Play /> }
        : {})}
      aria-disabled={refused || pending ? true : undefined}
      aria-label={label}
      {...(refused ? { title: actor.reason } : {})}
      onClick={press}
    >
      {form === "word" ? word : null}
    </TugPushButton>
  );
}
