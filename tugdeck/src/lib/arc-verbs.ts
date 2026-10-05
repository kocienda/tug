/**
 * arc-verbs.ts — the one verb set every arc surface offers, as a pure function.
 *
 * Three surfaces show an arc — the Arcs card's row, a Session card's `ARC`
 * popover, and the Changes shade's arc lane — and each used to assemble its own
 * controls around the same lifecycle block: an icon here, a word there, the
 * rare verbs behind a right-click on one and a `⋮` on another. That drift was
 * possible because nothing said what the set *was*. This module says it once:
 * given the arc, the surface, and what the surface may reach, it returns the
 * verbs in their one order ([B02]) — the arc's next step, the view, then the
 * housekeeping verbs — each with its word, its sentence, and its refusal.
 *
 * **Reach and refusal are two different answers, and the shape keeps them
 * apart** ([B09]). A verb the surface has no business performing is *absent*:
 * the caller passes null for it, and nothing the reader does here will ever
 * make it appear. A verb the arc's state refuses is *present* with a reason,
 * because the reader can do something about it — and a refusal nobody can read
 * is the failure [L31] names.
 *
 * Every rule here is one that already shipped somewhere: the transport face and
 * its actor are {@link transportFace} and {@link resolveTransportActor}, Replay's
 * terms are {@link replayDisabledReason}, Discard's reach is the lane's
 * `canDiscardFromHere`. What is new is only that one function now hands all of
 * them to every surface, plus Join in the first slot for an arc that is ready
 * ([B04], [B05]).
 *
 * @module lib/arc-verbs
 */

import {
  hasAnyDocument,
  resolveTransportActor,
  transportFace,
  type FollowedCardFacts,
  type TransportActor,
} from "@/lib/arc-transport";
import type { ArcTransportVerb } from "@/lib/arc-press-store";
import type {
  ArcDocuments,
  ArcJoinStateWire,
  ArcRunState,
} from "@/lib/changeset-types";
import { JOINABLE_STAGES } from "@/lib/arc-join-register";
import {
  deriveJoinOutcome,
  evaluateJoinGate,
  joinDisabledReason,
} from "@/lib/join-mode-controller";
import type { ArcBranchFacts } from "@/lib/arc-meta-facts";
import { replayDisabledReason } from "@/components/tugways/cards/session-changes/arc-row-menu";

/** Every verb an arc row can carry. */
export type ArcVerbKind =
  | ArcTransportVerb
  | "join"
  | "changes"
  | "diff"
  | "bind"
  | "unbind"
  | "replay"
  | "discard";

/** Which surface is asking. */
export type ArcVerbSurface = "arcs" | "popover" | "changes";

/** One verb as a surface draws it. */
export interface ArcVerb<K extends ArcVerbKind = ArcVerbKind> {
  kind: K;
  /** The button's word. */
  word: string;
  /** The sentence the hover and the screen reader both read, refusal and all. */
  label: string;
  /** Why the arc's state refuses it right now, or null when it is available. */
  refusal: string | null;
}

/** The first slot's verb when it is a transport act, which needs a destination. */
export interface ArcTransportVerbEntry extends ArcVerb<ArcTransportVerb> {
  /** Which card the press acts as ({@link resolveTransportActor}). */
  actor: TransportActor;
}

/** The row, in its one order. */
export interface ArcVerbSet {
  /** The arc's next step, or null when its state names none ([B04]). */
  next: ArcTransportVerbEntry | ArcVerb<"join"> | null;
  /** The view, or null when there is nothing to open ([B06]). */
  view: ArcVerb<"changes" | "diff"> | null;
  /** Bind or Unbind, Replay, Discard — whichever the surface may reach. */
  housekeeping: ArcVerb<"bind" | "unbind" | "replay" | "discard">[];
}

/** A housekeeping verb the surface may reach, with its surface-level refusal. */
export interface ArcVerbReach {
  /** Why the surface refuses it right now (a turn running, a round trip in
   *  flight, no card to aim at), or null. */
  refusal: string | null;
}

/** The live facts the join gate judges, beyond the arc's stage and draft. */
export interface ArcVerbJoinGate {
  /** The arc's server-owned join state, or null when the feed sends none. */
  state: ArcJoinStateWire | null;
  /** Whether any session holding the arc is still working (`holders_busy`). */
  holderBusy: boolean;
  /** Whether the bound card is mid-turn, where the surface can see it. */
  turnInProgress: boolean;
  /** Whether a join round trip is already out for the bound card. */
  pending: boolean;
}

/** The gate's facts for an arc that cannot be joined at all — one that is
 *  documents alone, whose first slot is never Join. */
export const NO_JOIN_GATE: ArcVerbJoinGate = {
  state: null,
  holderBusy: false,
  turnInProgress: false,
  pending: false,
};

/** What {@link arcVerbs} reads. */
export interface ArcVerbInput {
  surface: ArcVerbSurface;
  /** The arc's display name. */
  arc: string;
  /** The project the arc belongs to. */
  projectDir: string;
  /** The run driving the arc, or null when none is. */
  run: ArcRunState | null;
  /** Which of the arc's documents exist. */
  documents: ArcDocuments | undefined;
  /** The one live session holding the arc, or null. */
  boundSession: string | null;
  /** Whether a card bound to {@link boundSession} is open in the deck. */
  boundCardOpen: boolean;
  /** The arc's derived stage word (`ready`, `built`, `audited`, …). */
  stage: string | undefined;
  /** The join message drafted for the arc — what a Join would land — or null. */
  draft: string | null;
  /**
   * What the composer's join gate reads besides the message
   * ({@link evaluateJoinGate}). A row's Join is the composer's join through a
   * second door, so it refuses exactly what the composer refuses ([B05],
   * [B09]).
   */
  joinGate: ArcVerbJoinGate;
  /**
   * The arc's branch facts, or null for an arc that is documents alone. A
   * branchless arc has nothing to replay and no range to diff, and its
   * Discard is the documents' delete ([B07]).
   */
  branch: ArcBranchFacts | null;
  /** The card a Start or a Resume falls through to — the Arcs card's followed
   *  card, the lane's own card — or null. */
  followed: FollowedCardFacts | null;
  /** The housekeeping verbs this surface may reach; null is absent. */
  reach: {
    /** Bind or Unbind; `bound` picks the word ([B09]: every surface carries
     *  the binding verb in whichever word the arc's state reads). */
    binding: (ArcVerbReach & { bound: boolean }) | null;
    replay: ArcVerbReach | null;
    discard: ArcVerbReach | null;
  };
}

const TRANSPORT_WORD: Record<ArcTransportVerb, string> = {
  start: "Start",
  resume: "Resume",
  stop: "Stop",
};

/** The sentence a verb labels itself with, its refusal appended when it has one. */
function withRefusal(sentence: string, refusal: string | null): string {
  return refusal === null ? sentence : `${sentence} — ${refusal}`;
}

/**
 * Why Join is refused, or null ([B05]).
 *
 * A join runs in a session and lands that session's draft, and a row has no
 * composer — so the session it acts for is the arc's bound one, and the press
 * needs that card open and a message to land. Past those, it is the
 * composer's own gate over the same facts, in the same sentences: a conflict,
 * a blocker, a stale resolution, a holder still working, or a join already
 * out refuses a row's Join exactly as it refuses a typed one.
 */
function joinRefusal(input: ArcVerbInput): string | null {
  if (input.boundSession === null) return "no card holds it";
  if (!input.boundCardOpen) return "its card is closed";
  if (input.draft === null || input.draft.trim() === "") {
    return "it has no join message yet";
  }
  const { state, holderBusy, turnInProgress, pending } = input.joinGate;
  const outcome = deriveJoinOutcome(state);
  const gate = evaluateJoinGate({
    turnInProgress,
    holderBusy,
    joinPhase: pending ? "pending" : "idle",
    outcome,
    candidateCommit:
      typeof state?.candidate === "string" && state.candidate !== ""
        ? state.candidate
        : null,
    message: input.draft,
  });
  if (gate.ok) return null;
  return joinDisabledReason(gate.reason, outcome, state?.stale_note ?? null);
}

/** The first slot ([B04]). */
function nextVerb(input: ArcVerbInput): ArcVerbSet["next"] {
  const face = transportFace({
    arc: input.run,
    boundSession: input.boundSession,
    hasDocument: hasAnyDocument(input.documents),
  });
  // A live wheel outranks the offer, as it does in the join register: the
  // arc's next act while it runs is ending the run, whatever its stage word
  // says. Past that, a joinable arc's next act is the join — over a Resume
  // too, because an arc already ready is not waiting on its walk.
  if (face !== "stop" && JOINABLE_STAGES.has(input.stage ?? "")) {
    const refusal = joinRefusal(input);
    const base = input.branch?.base ?? "main";
    return {
      kind: "join",
      word: "Join",
      label: withRefusal(`Join arc ${input.arc} onto ${base}`, refusal),
      refusal,
    };
  }
  if (face === "none") return null;
  const actor = resolveTransportActor({
    face,
    boundSession: input.boundSession,
    surface: input.surface,
    followed: input.followed,
    projectDir: input.projectDir,
    arc: input.arc,
  });
  const word = TRANSPORT_WORD[face];
  return {
    kind: face,
    word,
    label: withRefusal(`${word} arc ${input.arc}`, actor.reason),
    refusal: actor.reason,
    actor,
  };
}

/** The view slot ([B06]): Changes on the Arcs card and the popover, Diff in
 *  the lane. */
function viewVerb(input: ArcVerbInput): ArcVerbSet["view"] {
  if (input.surface === "changes") {
    // Absent rather than refused with nothing past the base: an empty range
    // would open an empty card, and no gesture here changes that.
    if (input.branch === null || !input.branch.hasRange) return null;
    return {
      kind: "diff",
      word: "Diff",
      label: `Open the ${input.arc} arc diff in a card`,
      refusal: null,
    };
  }
  // The popover is the bound card's own, so its Changes shade is always there.
  // The Arcs card reveals the bound card's shade, which needs that card.
  const refusal =
    input.surface === "popover"
      ? null
      : input.boundSession === null
        ? "no card holds it"
        : !input.boundCardOpen
          ? "its card is closed"
          : null;
  return {
    kind: "changes",
    word: "Changes",
    label: withRefusal(`Show arc ${input.arc} in Changes`, refusal),
    refusal,
  };
}

/** Bind or Unbind, Replay, Discard — in that order ([B02]). */
function housekeepingVerbs(input: ArcVerbInput): ArcVerbSet["housekeeping"] {
  const verbs: ArcVerbSet["housekeeping"] = [];
  const { binding, replay, discard } = input.reach;
  if (binding !== null) {
    const word = binding.bound ? "Unbind" : "Bind";
    verbs.push({
      kind: binding.bound ? "unbind" : "bind",
      word,
      label: withRefusal(`${word} arc ${input.arc}`, binding.refusal),
      refusal: binding.refusal,
    });
  }
  // A branchless arc has no rounds to replay, so Replay is absent there.
  if (replay !== null && input.branch !== null) {
    const refusal = replay.refusal ?? replayDisabledReason(input.branch);
    verbs.push({
      kind: "replay",
      // The bare word on the button; the destination rides the label, which
      // is the tooltip. "Replay onto main" was the widest verb in the row and
      // broke the housekeeping group at the sidebar's width.
      word: "Replay",
      label: withRefusal(
        `Replay arc ${input.arc} onto ${input.branch.base}`,
        refusal,
      ),
      refusal,
    });
  }
  if (discard !== null) {
    verbs.push({
      kind: "discard",
      word: "Discard",
      label: withRefusal(`Discard arc ${input.arc}`, discard.refusal),
      refusal: discard.refusal,
    });
  }
  return verbs;
}

/** The row's whole verb set, in its one order ([B10]). */
export function arcVerbs(input: ArcVerbInput): ArcVerbSet {
  return {
    next: nextVerb(input),
    view: viewVerb(input),
    housekeeping: housekeepingVerbs(input),
  };
}

/**
 * What Discard's confirm says, and the word on its button.
 *
 * A fact sheet, never "are you sure": a branched arc's discard ends its branch
 * and worktree and hands uncommitted work back to the base checkout; a
 * branchless arc's discard is the documents' delete ([B07]), and the clause
 * that earns its confirm is that `.tug/` is untracked, so nothing restores it.
 */
export function discardConfirm(
  arc: string,
  branchless: boolean,
): { message: string; confirmLabel: string } {
  return branchless
    ? {
        message: `Delete the documents for ${arc}? They are untracked — git will not give them back.`,
        confirmLabel: "Delete",
      }
    : {
        message: `Discard ${arc}? Its branch and worktree go; uncommitted work returns to the base checkout.`,
        confirmLabel: "Discard",
      };
}
