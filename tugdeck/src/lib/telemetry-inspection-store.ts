/**
 * telemetry-inspection-store.ts — the one source the telemetry inspector
 * reads, whichever page holds the card it inspects.
 *
 * The inspector shows a session's fields and the live-clock anchors of its
 * reducer state. In the document those live in the card's own services
 * (`cardServicesStore`), and the store reads them there. In a devtools body
 * the followed card is another page: the shell asks that card's body to
 * publish its inspection (`inspect`), the body sends it as `inspection`
 * advice on every change, and the shell relays it to the devtools body as an
 * `inspection` command, which lands here through {@link relay}. The
 * inspector reads one store either way, and cannot tell which path fed it.
 *
 * `read(cardId)` answers from the page's own services when it holds them, so
 * a card in this page is never shown through a relay; the relayed inspection
 * answers only for the card it names, so a devtools body that moved on never
 * shows the card it left.
 *
 * Laws: [L02] — read through `useSyncExternalStore`; the snapshot keeps its
 * identity while nothing it draws has moved.
 *
 * @module lib/telemetry-inspection-store
 */

import type { CodeSessionSnapshot, CodeSessionStore } from "./code-session-store";
import type { CodeSessionState } from "./code-session-store/reducer";
import type { TurnEntry } from "./code-session-store/types";
import { selectSessionFields } from "./code-session-store/hooks/use-session-fields";
import { cardServicesStore } from "./card-services-store";
import { createSubscribable } from "./subscribable";

/** The session snapshot fields the inspector shows. */
export const INSPECTION_FIELDS = [
  "phase",
  "transcript",
  "tugSessionId",
  "displayLabel",
  "transportState",
] as const;

export type InspectionField = (typeof INSPECTION_FIELDS)[number];

/** The reducer-state fields the inspector's projection and its copy read. */
export const INSPECTION_STATE_KEYS = [
  "phase",
  "transportState",
  "tugSessionId",
  "displayLabel",
  "sessionMode",
  "pendingTurn",
  "interruptInFlight",
  "awaitingApprovalSince",
  "awaitingApprovalAccumulatedMs",
  "transportNonOnlineSince",
  "transportDowntimeAccumulatedMs",
  "transportReconnectCount",
  "lastStreamEventAt",
  "maxStreamGapMs",
  "firstAssistantDeltaAt",
  "firstToolUseAt",
  "costAtSubmit",
  "lastCost",
  "sessionInitTokens",
] as const;

/** What of the reducer state an inspection carries: plain data, relayable as JSON. */
export type InspectionState = Pick<CodeSessionState, (typeof INSPECTION_STATE_KEYS)[number]>;

/** A card's inspection: the fields and the state the inspector draws. */
export interface TelemetryInspection {
  cardId: string;
  fields: Pick<CodeSessionSnapshot, InspectionField>;
  state: InspectionState;
}

/** The inspector's slice of a reducer state. */
export function pickInspectionState(state: CodeSessionState): InspectionState {
  const picked = {} as Record<string, unknown>;
  for (const key of INSPECTION_STATE_KEYS) picked[key] = state[key];
  return picked as InspectionState;
}

/**
 * A turn as the relay carries it: its telemetry without its messages, which
 * the inspector never reads and which are the bulk of a transcript.
 */
function relayableTurn(turn: TurnEntry): TurnEntry {
  return { ...turn, messages: [] };
}

/**
 * The inspection of `cardId` as `store` holds it now, shaped for the bus:
 * the inspector's fields, the transcript without its messages, and the
 * state slice.
 */
export function relayableInspection(cardId: string, store: CodeSessionStore): TelemetryInspection {
  const snapshot = store.getSnapshot();
  const fields = selectSessionFields(snapshot, INSPECTION_FIELDS, undefined);
  return {
    cardId,
    fields: { ...fields, transcript: fields.transcript.map(relayableTurn) },
    state: pickInspectionState(store._getInternalStateForDevPanel()),
  };
}

/** Whether `value` is an inspection as the relay carries one. */
export function isTelemetryInspection(value: unknown): value is TelemetryInspection {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TelemetryInspection>;
  return (
    typeof candidate.cardId === "string" &&
    typeof candidate.fields === "object" &&
    candidate.fields !== null &&
    typeof candidate.state === "object" &&
    candidate.state !== null
  );
}

interface LocalReading {
  cardId: string;
  store: CodeSessionStore;
  fields: Pick<CodeSessionSnapshot, InspectionField>;
  state: CodeSessionState;
  value: TelemetryInspection;
}

class TelemetryInspectionStore {
  private relayedInspection: TelemetryInspection | null = null;
  private readonly listeners = createSubscribable();
  private last: LocalReading | null = null;

  /** Take a relayed inspection, replacing the last; `null` empties it. */
  relay = (inspection: TelemetryInspection | null): void => {
    this.relayedInspection = inspection;
    this.listeners.notify();
  };

  /** The last relayed inspection, or null. */
  relayed = (): TelemetryInspection | null => this.relayedInspection;

  /**
   * Hear every change to `cardId`'s inspection: its services appearing or
   * going, its session store publishing, and a relay landing.
   */
  subscribe = (cardId: string, onChange: () => void): (() => void) => {
    let releaseSession: (() => void) | null = null;
    let watched: CodeSessionStore | null = null;
    const follow = (): void => {
      const store = cardServicesStore.getServices(cardId)?.codeSessionStore ?? null;
      if (store === watched) return;
      releaseSession?.();
      watched = store;
      releaseSession = store === null ? null : store.subscribe(onChange);
    };
    const releaseServices = cardServicesStore.subscribe(() => {
      follow();
      onChange();
    });
    const releaseRelay = this.listeners.subscribe(onChange);
    follow();
    return () => {
      releaseServices();
      releaseRelay();
      releaseSession?.();
    };
  };

  /**
   * `cardId`'s inspection: from this page's own services when it holds the
   * card, otherwise the relayed one when it names the card, otherwise null.
   */
  read = (cardId: string): TelemetryInspection | null => {
    const store = cardServicesStore.getServices(cardId)?.codeSessionStore ?? null;
    if (store === null) {
      return this.relayedInspection?.cardId === cardId ? this.relayedInspection : null;
    }
    const last = this.last;
    const previous = last !== null && last.cardId === cardId && last.store === store ? last : null;
    const fields = selectSessionFields(store.getSnapshot(), INSPECTION_FIELDS, previous?.fields);
    const state = store._getInternalStateForDevPanel();
    if (previous !== null && previous.fields === fields && previous.state === state) return previous.value;
    const value: TelemetryInspection = { cardId, fields, state: pickInspectionState(state) };
    this.last = { cardId, store, fields, state, value };
    return value;
  };

  /** Test-only reset. */
  _resetForTest(): void {
    this.relayedInspection = null;
    this.last = null;
    this.listeners.clearListeners();
  }
}

export const telemetryInspectionStore = new TelemetryInspectionStore();
