/**
 * arc-transport.ts — the transport control's three questions, answered as pure
 * functions over data.
 *
 * A row showing an arc has to decide three things before it can draw a button:
 * **which act** the arc is asking for, **which card** the press would act as,
 * and — when the act is Start — **which kind** to open the arc with. All three
 * are functions of the entry and the surface, with no store read and no DOM,
 * so the whole truth table is a unit test rather than a rendered one.
 *
 * The face and the actor are separate on purpose. The face is a property of
 * the *arc*: an arc that is running wants Stop wherever it is shown. The actor
 * is a property of the *surface*: the Arcs card acts as the card it follows,
 * the Z2 popover acts as its own card, and the same arc therefore offers the
 * same verb with two different destinations.
 *
 * **The refusal sentences here deliberately do not match Bind's** ([P06]).
 * `resolveBindTarget` in `arcs-card.tsx` answers three of the same facts in a
 * different voice, and both ladders are reachable from one row. Harmonizing
 * them would overturn a decided sentence rather than tidy a duplication; that
 * is a separate decision about Bind's voice.
 *
 * @module lib/arc-transport
 */

import type { ArcDocuments, ArcRunState } from "@/lib/changeset-types";

import type { ArcTransportVerb } from "@/lib/arc-press-store";

/**
 * What the control draws, or nothing at all.
 *
 * `none` is a real answer rather than an error: an arc that is done has no
 * transport left, and an arc with no documents has nothing to start from.
 */
export type ArcTransportFace = ArcTransportVerb | "none";

/** What {@link transportFace} reads — the entry, flattened to what it decides on. */
export interface TransportFaceInput {
  /** The run driving this arc, or null when none is. */
  arc: ArcRunState | null;
  /** The one live session holding the arc, or null when none does. */
  boundSession: string | null;
  /** Whether any of the arc's three documents exists. */
  hasDocument: boolean;
}

/**
 * Which act the arc is asking for (Table T01).
 *
 * The ladder is short because the questions nest: a *done* arc is finished
 * whatever else is true; an arc with a *stop* on it wants Resume, whether or
 * not a card still holds it (a stop keeps the binding); an arc that is running
 * wants Stop; and an arc with no run at all wants Start, if there is anything
 * to start from.
 *
 * **A running arc with no holder still reads Stop**, refused. It is a state
 * the server should not produce and the honest face for it is the verb that
 * would end it, with the reason on the hover — not a blank cell that says the
 * arc is fine.
 */
export function transportFace(input: TransportFaceInput): ArcTransportFace {
  const { arc } = input;
  if (arc === null) return input.hasDocument ? "start" : "none";
  if (arc.done === true) return "none";
  if (arc.stopped !== undefined) return "resume";
  return "stop";
}

/** The Arcs card's followed card, and what it is already running. */
export interface FollowedCardFacts {
  readonly cardId: string;
  readonly tugSessionId: string;
  readonly projectDir: string;
  /** What the reader would call this card. */
  readonly cardName: string;
  /** The arc this card is *live* on, or null — a stopped one does not count. */
  readonly runningArc: string | null;
}

/** What {@link resolveTransportActor} reads. */
export interface TransportActorInput {
  face: ArcTransportFace;
  /** The one live session holding the arc, or null. */
  boundSession: string | null;
  /** Which surface is asking — the Arcs card's row, or a card's own popover. */
  surface: "arcs" | "popover";
  /** The Arcs card's followed card, or null when it follows none. */
  followed: FollowedCardFacts | null;
  /** The project this arc belongs to. */
  projectDir: string;
  /** The arc's name, for the refusals that name it. */
  arc: string;
}

/**
 * Which card the press acts as, or why none can (Table T02).
 *
 * Exactly one of the two fields is non-null. A refusal is a sentence rather
 * than a boolean because the control speaks it: [P07] keeps the button
 * pressable and answers the press with the reason, since an `xs` icon has no
 * label to carry one and a DOM-disabled button takes no pointer events.
 */
export type TransportActor =
  | { tugSessionId: string; projectDir: string; reason: null }
  | { tugSessionId: null; projectDir: null; reason: string };

/** The one shape a refusal takes, so every arm below reads the same. */
function refuse(reason: string): TransportActor {
  return { tugSessionId: null, projectDir: null, reason };
}

export function resolveTransportActor(
  input: TransportActorInput,
): TransportActor {
  // Stop acts as the card that is running it, and only that card. There is no
  // fallback: stopping an arc from a card that is not holding it is a gesture
  // the server refuses anyway, and offering it here would put the refusal a
  // round trip away from the press.
  if (input.face === "stop") {
    if (input.boundSession === null) return refuse("no card is running it");
    return {
      tugSessionId: input.boundSession,
      projectDir: input.projectDir,
      reason: null,
    };
  }

  // Resume prefers the card that already holds the arc ([F10]: a stop keeps
  // the binding), and falls through to Start's ladder when nothing does.
  if (input.face === "resume" && input.boundSession !== null) {
    return {
      tugSessionId: input.boundSession,
      projectDir: input.projectDir,
      reason: null,
    };
  }

  const { followed } = input;
  if (followed === null) return refuse("no Session card to run it on");
  // A card already live on some other arc cannot take a second. A *stopped*
  // arc on that card does not refuse: the server binds over one, exactly as
  // `bind` already does.
  if (followed.runningArc !== null && followed.runningArc !== input.arc) {
    return refuse(`${followed.cardName} is running ${followed.runningArc}`);
  }
  if (followed.projectDir !== input.projectDir) {
    return refuse(`${followed.cardName} works another project`);
  }
  return {
    tugSessionId: followed.tugSessionId,
    projectDir: followed.projectDir,
    reason: null,
  };
}

/**
 * The kind a Start would open this arc with (Spec S01), or null when there is
 * nothing to open.
 *
 * Read off the documents rather than off the record, because an arc with no
 * record is exactly the one this answers for. A task list with no plan beside
 * it is what the `/arc` door leaves, and it is the only shape that opens
 * plain; everything else with a document is planned.
 */
export function startKind(
  documents: ArcDocuments | undefined,
): "plain" | "planned" | null {
  if (documents === undefined) return null;
  const hasPlan = documents.plan !== undefined;
  const hasTasks = documents.tasks !== undefined;
  const hasBrief = documents.brief !== undefined;
  if (hasTasks && !hasPlan) return "plain";
  if (hasBrief || hasPlan) return "planned";
  return null;
}

/** Whether an arc has any document at all — {@link transportFace}'s third input. */
export function hasAnyDocument(documents: ArcDocuments | undefined): boolean {
  if (documents === undefined) return false;
  return (
    documents.brief !== undefined ||
    documents.plan !== undefined ||
    documents.tasks !== undefined
  );
}

/**
 * Whether a session's arc fact is a *live* run — the reading
 * {@link FollowedCardFacts.runningArc} is built from.
 *
 * A bound-but-stopped arc is not running: the card is free to take another,
 * and refusing a Start over one would refuse a gesture the server allows.
 */
export function isLiveRun(arc: ArcRunState | null): boolean {
  if (arc === null) return false;
  return arc.done !== true && arc.stopped === undefined;
}
