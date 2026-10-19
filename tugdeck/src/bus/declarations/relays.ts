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
 *
 * @module bus/declarations/relays
 */

import { isArrangementKind } from "./arrangement";
import { sessionBinding } from "./deck";
import type { CardSessionBinding } from "../../lib/card-session-binding-store";
import { isEditingState, type RestoredAttachmentEntry } from "../../lib/composer-draft-payload";
import type { DropZone, DropZoneSet } from "../../lib/drop-zones";
import { OVERVIEW_CARD_ID } from "../../lib/overview-card-id";
import type { TugTextEditingState } from "../../lib/tug-text-types";
import type { OverviewComposerDraftState } from "../../components/overview/overview-composer-draft";
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

/** A change of the composer's draft: the words, and the pictures when they moved. */
export interface OverviewDraftPatch {
  draft: TugTextEditingState | null;
  attachmentBytes?: Record<string, RestoredAttachmentEntry>;
}

function isAttachmentBytes(value: unknown): value is Record<string, RestoredAttachmentEntry> {
  return isRecord(value) && Object.values(value).every(isRecord);
}

const EMPTY_EDIT: TugTextEditingState = { text: "", atoms: [], selection: null };

const draftPatch = opaque(
  (v: unknown): v is OverviewDraftPatch =>
    isRecord(v) &&
    (v.draft === null || isEditingState(v.draft)) &&
    (v.attachmentBytes === undefined || isAttachmentBytes(v.attachmentBytes)),
  { draft: EMPTY_EDIT },
);

/**
 * The held draft after `patch`. The words replace the last; the pictures
 * replace theirs when they came, and stand otherwise. A draft with nothing in
 * it lets the hold go.
 */
export function holdOverviewDraft(
  prev: OverviewComposerDraftState | null,
  patch: OverviewDraftPatch,
): OverviewComposerDraftState | null {
  const draft = patch.draft;
  if (draft === null || (draft.text.length === 0 && draft.atoms.length === 0)) return null;
  const attachmentBytes = patch.attachmentBytes ?? prev?.attachmentBytes;
  return {
    draft,
    ...(attachmentBytes !== undefined && Object.keys(attachmentBytes).length > 0 ? { attachmentBytes } : {}),
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
        (v.attachmentBytes === undefined || isAttachmentBytes(v.attachmentBytes)),
      { draft: EMPTY_EDIT },
    ),
  ),
  initial: null,
  proposals: draftPatch,
  applyProposal: holdOverviewDraft,
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
