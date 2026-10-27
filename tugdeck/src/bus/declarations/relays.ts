/**
 * What the shell holds for a body beyond the body's own life, and the Layout
 * miniature's seams with the shell's canvas.
 *
 * - **A card's session binding** (`card.binding`). A body binds, resumes and
 *   rebinds in its own page, and the shell reads the binding all the same —
 *   for the Cards card's rows, `cardLineFacts`, the identity a copy from the
 *   shell writes, every other body's `deck.cardBindings`. So the shell owns
 *   it, and the body proposes each change of its own card's binding: a page
 *   that reloads, or a rebind that takes the masthead down for a beat, says
 *   nothing, and the shell's binding stands.
 * - **The Overview's draft** (`overview.draft`). Hiding the Overview rail
 *   destroys the card, and its page with it, so the draft the user left in
 *   its composer is held by the shell: the body proposes each change, and the
 *   next Overview body seeds its composer from the replica.
 * - **The miniature** (`miniature.*`). The Layout card's miniature is drawn
 *   in its body, and what it mirrors and drives is the shell's: the gauge
 *   channel (the deck's flow offset, the canvas's column slides, drag frame
 *   and drop zone) and the canvas's drop-zone host. A body with any gauge
 *   registration says so (`miniature.demand`); while any does, the shell
 *   publishes every standing gauge at most once per task
 *   (`miniature.gauges`), and the body applies each signal that moved into
 *   its own channel ([L06]). A drag on the picture asks the shell for the
 *   zones it would offer (`miniature.zones`) and hands it the outline, the
 *   carrying stamp and the commit, whose refusal the shell flashes on the
 *   dragged card's pane.
 * - **The arc transport presses** (`arc.presses`). Start, Resume and Stop are
 *   pressed on whichever page holds the button and answered at the shell,
 *   and a refusal is spoken on the page of the card the press acted as. So
 *   the shell holds every press and refusal, each body reads them, and a
 *   body's press is proposed whole for the shell to make and send
 *   (`lib/arc-press-store.ts`, which says why).
 *
 * @module bus/declarations/relays
 */

import { isArrangementKind } from "./arrangement";
import { sessionBinding } from "./deck";
import type { CardSessionBinding } from "../../lib/card-session-binding-store";
import { isEditingState, type RestoredAttachmentEntry } from "../../lib/composer-draft-payload";
import type { DropZone, DropZoneSet } from "../../lib/drop-zones";
import { OVERVIEW_CARD_ID } from "../../lib/overview-card-id";
import type { HistoryWalkState, TugTextEditingState } from "../../lib/tug-text-types";
import type { OverviewComposerDraftState } from "../../lib/overview-composer-draft";
import { bool, literal, nullable, obj, opaque, str } from "../codec";
import { defineRequest } from "../request";
import { defineAction } from "../routed-action";
import { defineSharedStore } from "../shared-store";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---- A card's session binding ----

export const cardBinding = defineSharedStore<CardSessionBinding | null, CardSessionBinding | null>({
  key: "card.binding",
  owner: "shell",
  scope: { card: true },
  codec: nullable(sessionBinding),
  initial: null,
  proposals: nullable(sessionBinding),
});

// ---- The Overview's draft ----

/**
 * A change of the composer's draft: the words, the pictures when they moved,
 * and the history walk when one is in progress — absent means none, so a
 * walk ends with the first patch that carries none ([L23]).
 */
export interface OverviewDraftPatch {
  draft: TugTextEditingState | null;
  attachmentBytes?: Record<string, RestoredAttachmentEntry>;
  historyWalk?: HistoryWalkState;
}

function isAttachmentBytes(value: unknown): value is Record<string, RestoredAttachmentEntry> {
  return isRecord(value) && Object.values(value).every(isRecord);
}

const EMPTY_EDIT: TugTextEditingState = { text: "", atoms: [], selection: null };

const draftPatch = opaque(
  (v: unknown): v is OverviewDraftPatch =>
    isRecord(v) &&
    (v.draft === null || isEditingState(v.draft)) &&
    (v.attachmentBytes === undefined || isAttachmentBytes(v.attachmentBytes)) &&
    (v.historyWalk === undefined || isRecord(v.historyWalk)),
  { draft: EMPTY_EDIT },
);

/**
 * The held draft after `patch`. The words replace the last; the pictures
 * replace theirs when they came, and stand otherwise. A draft with nothing in
 * it lets the hold go — unless a history walk is in progress, because then
 * the field is showing a recalled entry and the words typed before walking
 * are in the walk ([L23]).
 */
export function holdOverviewDraft(
  prev: OverviewComposerDraftState | null,
  patch: OverviewDraftPatch,
): OverviewComposerDraftState | null {
  const empty = patch.draft === null
    || (patch.draft.text.length === 0 && patch.draft.atoms.length === 0);
  if (empty && patch.historyWalk === undefined) return null;
  const draft = empty ? null : patch.draft;
  const attachmentBytes = patch.attachmentBytes ?? prev?.attachmentBytes;
  return {
    draft,
    ...(attachmentBytes !== undefined && Object.keys(attachmentBytes).length > 0 ? { attachmentBytes } : {}),
    ...(patch.historyWalk !== undefined ? { historyWalk: patch.historyWalk } : {}),
  };
}

export const overviewDraft = defineSharedStore<OverviewComposerDraftState | null, OverviewDraftPatch>({
  key: "overview.draft",
  owner: "shell",
  scope: { kinds: (componentId) => componentId === OVERVIEW_CARD_ID },
  codec: nullable(
    opaque(
      (v: unknown): v is OverviewComposerDraftState =>
        isRecord(v) &&
        (v.draft === null || isEditingState(v.draft)) &&
        (v.attachmentBytes === undefined || isAttachmentBytes(v.attachmentBytes)) &&
        (v.historyWalk === undefined || isRecord(v.historyWalk)),
      { draft: EMPTY_EDIT },
    ),
  ),
  initial: null,
  proposals: draftPatch,
  applyProposal: holdOverviewDraft,
});

// ---- The arc transport presses ----

/**
 * The three transport verbs, which are the three acts a press can be.
 *
 * They are not three states of one thing: `start` opens an arc that may never
 * have run, `resume` clears a stop, and `stop` ends what is running. One
 * store holds all three because the *press* is the same shape in each case —
 * one button, one frame, one answer — not because the acts are.
 */
export type ArcTransportVerb = "start" | "resume" | "stop";

/** A refused press: the arc, the verb, the reason the server gave, and when. */
export interface ArcPressRefusal {
  readonly arc: string;
  readonly verb: ArcTransportVerb;
  readonly reason: string;
  /** Bumped on every refusal so two identical reasons in a row still notify. */
  readonly seq: number;
}

/** Who a press acts as: the session the frame names, in its project. */
export interface ArcPressActor {
  readonly tugSessionId: string;
  readonly projectDir: string;
}

/** What the shell holds and every body replicates. */
export interface ArcPressState {
  /** The presses still waiting for an answer, by {@link arcPressKey}. */
  readonly pending: readonly string[];
  /** The last refusal for each session. */
  readonly refusals: Readonly<Record<string, ArcPressRefusal>>;
}

/** What a body asks of the shell's store. */
export type ArcPressPatch =
  | { op: "press"; arc: string; verb: ArcTransportVerb; actor: ArcPressActor }
  | { op: "refuse"; voice: string; arc: string; verb: ArcTransportVerb; reason: string }
  | { op: "clear"; sessionId: string; seq: number | null };

/** One pending press, keyed so two verbs on one arc are two presses. */
export function arcPressKey(arc: string, verb: ArcTransportVerb): string {
  return `${verb}:${arc}`;
}

/**
 * How a replica shows its own patch before the shell answers: a press greys
 * the button on the click, and a seen refusal goes at once. A proposed refusal
 * waits for the shell, which numbers it — a sequence the replica made up
 * would be spoken twice when the shell's arrived.
 */
export function applyArcPressPatch(prev: ArcPressState, patch: ArcPressPatch): ArcPressState {
  switch (patch.op) {
    case "press": {
      const key = arcPressKey(patch.arc, patch.verb);
      return prev.pending.includes(key) ? prev : { ...prev, pending: [...prev.pending, key] };
    }
    case "clear": {
      const refusal = prev.refusals[patch.sessionId];
      if (refusal === undefined || (patch.seq !== null && refusal.seq !== patch.seq)) return prev;
      const { [patch.sessionId]: _gone, ...rest } = prev.refusals;
      return { ...prev, refusals: rest };
    }
    case "refuse":
      return prev;
  }
}

function isTransportVerb(value: unknown): value is ArcTransportVerb {
  return value === "start" || value === "resume" || value === "stop";
}

function isPressRefusal(value: unknown): value is ArcPressRefusal {
  return (
    isRecord(value) &&
    typeof value.arc === "string" &&
    isTransportVerb(value.verb) &&
    typeof value.reason === "string" &&
    typeof value.seq === "number"
  );
}

function isArcPressState(value: unknown): value is ArcPressState {
  return (
    isRecord(value) &&
    Array.isArray(value.pending) &&
    value.pending.every((key) => typeof key === "string") &&
    isRecord(value.refusals) &&
    Object.values(value.refusals).every(isPressRefusal)
  );
}

function isArcPressPatch(value: unknown): value is ArcPressPatch {
  if (!isRecord(value)) return false;
  switch (value.op) {
    case "press":
      return (
        typeof value.arc === "string" &&
        isTransportVerb(value.verb) &&
        isRecord(value.actor) &&
        typeof value.actor.tugSessionId === "string" &&
        typeof value.actor.projectDir === "string"
      );
    case "refuse":
      return (
        typeof value.arc === "string" &&
        typeof value.voice === "string" &&
        isTransportVerb(value.verb) &&
        typeof value.reason === "string"
      );
    case "clear":
      return typeof value.sessionId === "string" && (value.seq === null || typeof value.seq === "number");
    default:
      return false;
  }
}

export const arcPresses = defineSharedStore<ArcPressState, ArcPressPatch>({
  key: "arc.presses",
  owner: "shell",
  scope: { deck: true },
  codec: opaque(isArcPressState, {
    pending: ["resume:demo"],
    refusals: { s1: { arc: "demo", verb: "resume", reason: "no answer", seq: 1 } },
  }),
  initial: { pending: [], refusals: {} },
  proposals: opaque(isArcPressPatch, {
    op: "press",
    arc: "demo",
    verb: "resume",
    actor: { tugSessionId: "s1", projectDir: "/p" },
  }),
  applyProposal: applyArcPressPatch,
});

// ---- The miniature ----

/** One gauge signal's standing values, a retired one as `null`. */
export type GaugeEntry = [string, Record<string, string> | null];

function isGaugeEntry(value: unknown): value is GaugeEntry {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    (value[1] === null || (isRecord(value[1]) && Object.values(value[1]).every((v) => typeof v === "string")))
  );
}

/** Whether a body page has a gauge registration: what the shell publishes gauges for. */
export const miniatureDemand = defineSharedStore<boolean>({
  key: "miniature.demand",
  owner: "card",
  scope: { card: true },
  codec: bool,
  initial: false,
  clearOnDetach: true,
});

/** Every standing gauge signal, set at most once per task while a body wants them. */
export const miniatureGauges = defineSharedStore<GaugeEntry[]>({
  key: "miniature.gauges",
  owner: "shell",
  scope: { kinds: isArrangementKind },
  codec: opaque((v: unknown): v is GaugeEntry[] => Array.isArray(v) && v.every(isGaugeEntry), [["flow-offset", null]]),
  initial: [],
});

function isZone(value: unknown): value is DropZone {
  if (!isRecord(value)) return false;
  const kind = value.kind;
  return kind === "slot" || kind === "column-index" || kind === "rail-index" || kind === "tab-bar";
}

const SAMPLE_ZONE: DropZone = { kind: "slot", slot: 0, rect: { x: 0, y: 0, width: 0, height: 0 } };

const dropZone = opaque(isZone, SAMPLE_ZONE);

/** The zone a miniature drag stands over, outlined on the shell's canvas. */
export const miniatureOutline = defineAction({
  id: "miniature.outline",
  owner: "shell",
  codec: obj({ zone: nullable(dropZone) }),
});

/** The stamp the shell's canvas wears while a miniature drag carries a card or a rail. */
export const miniatureCarry = defineAction({
  id: "miniature.carry",
  owner: "shell",
  codec: obj({ kind: nullable(literal("rail", "card")) }),
});

/** A miniature drag's release over `zone`, carrying `cardId`. A refusal flashes the card's pane. */
export const miniatureCommit = defineAction({
  id: "miniature.commit",
  owner: "shell",
  codec: obj({ zone: dropZone, cardId: str }),
});

/** How long a miniature drag waits on the shell's zones before it stays inert. */
export const MINIATURE_ZONES_MS = 1000;

/** The zones the shell's canvas would offer `cardId`, null when it offers none. */
export const miniatureZones = defineRequest({
  id: "miniature.zones",
  owner: "shell",
  codec: obj({ cardId: str }),
  replyCodec: nullable(
    opaque(
      (v: unknown): v is DropZoneSet =>
        isRecord(v) && Array.isArray(v.zones) && v.zones.every(isZone) && (v.origin === null || isZone(v.origin)),
      { zones: [SAMPLE_ZONE], origin: null } as DropZoneSet,
    ),
  ),
  onDetach: "fail",
});
