/**
 * `dictationStore` — which composer holds the microphone, and every way it
 * can lose it.
 *
 * **One composer at a time, and the deck is where that is decided.** The host
 * enforces one live session too, but it knows nothing about composers: a
 * second `start` supersedes the first and the deck would be left with two
 * composers each believing they were dictating, one of them into a span
 * nothing will ever feed again. So the claim lives here, and a claim by B ends
 * A's before it asks the host for anything.
 *
 * **Most of this file is about giving the mic up.** Taking it is one gesture;
 * losing it has ten triggers (Table T03), and the two that nothing else could
 * notice are the store's own: the app resigning active, and a modal run taking
 * a hold on the owning card. A mic left live behind a sheet, or live while the
 * user is in another app, is a microphone recording someone who has forgotten
 * it is on — which is the reason those two subscriptions exist and the reason
 * they are registered on the first claim rather than at module load. A store
 * with no claim subscribes to nothing.
 *
 * Release is keyed on the claim record, the way `cardModalHoldStore`'s is: a
 * stale release from a composer that lost the mic to another cannot drop the
 * claim the new owner is holding.
 *
 * Module-level singleton, matching the other composer-scoped helper stores
 * ([L02] external state reaches React through `useSyncExternalStore`), and
 * wired to the bridge at module load so the host has somewhere to report to
 * before any composer mounts.
 *
 * References: [B07], [B08], [B09], [P04], [P07], Spec S05, Table T01,
 * Table T03, Risk R02.
 *
 * @module lib/dictation-store
 */

import { useCallback, useSyncExternalStore } from "react";

import {
  mintDictationId,
  setDictationListener,
  startDictation,
  stopDictation,
  type DictationEvent,
  type DictationRefusalReason,
} from "@/lib/dictation-bridge";
import { getAppLifecycle } from "@/lib/app-lifecycle";
import { cardModalHoldStore, isCardHeld } from "@/lib/card-modal-hold-store";
import type { DictationHandle } from "@/lib/prompt-insert-target";

/**
 * What a refusal reads as, in the wording the button speaks (Table T01).
 *
 * Each one names the thing the user would have to go and do. A refusal whose
 * text is "dictation failed" is a dead button with an explanation; these are
 * dead buttons with a next step.
 */
export const REFUSAL_TEXT: Readonly<Record<DictationRefusalReason, string>> = {
  "microphone-permission":
    "Microphone access is off for Tug in System Settings › Privacy & Security",
  "speech-permission":
    "Speech Recognition is off for Tug in System Settings › Privacy & Security",
  "no-input-device": "No microphone is connected",
  "no-model": "Speech recognition isn't available for this language on this Mac",
  unavailable: "Dictation isn't available on this Mac",
  error: "Dictation stopped",
};

/** How far along a claim is. The button's face follows this. */
export type DictationPhase = "starting" | "preparing" | "live";

/** What the button draws. `idle` and `refused` belong to no claim. */
export type DictationMode = "idle" | "starting" | "preparing" | "live" | "refused";

/** The live claim, or the shape of one. */
export interface DictationClaim {
  readonly composerId: string;
  readonly cardId: string;
  readonly handle: DictationHandle;
  readonly sessionId: string;
  readonly phase: DictationPhase;
}

export interface DictationRefusal {
  readonly reason: DictationRefusalReason;
  readonly message?: string;
}

export interface DictationState {
  readonly claim: DictationClaim | null;
  readonly refusal: DictationRefusal | null;
}

/**
 * What one composer's button needs, and nothing else.
 *
 * Handed out as a frozen object cached per `(mode, refusalReason, sessionId)`
 * so `useSyncExternalStore` sees identity equality: every composer's button
 * subscribes to one store, and a claim moving on card A must not re-render the
 * button on card B.
 */
export interface DictationFace {
  readonly mode: DictationMode;
  readonly sessionId: string | null;
  readonly refusalText: string | null;
}

const IDLE_FACE: DictationFace = Object.freeze({
  mode: "idle" as DictationMode,
  sessionId: null,
  refusalText: null,
});

const EMPTY_STATE: DictationState = Object.freeze({ claim: null, refusal: null });

/**
 * Matching `app-lifecycle.ts`'s `LIFECYCLE_LOG`, and for the same reason: a
 * release the user did not ask for is the hardest thing here to reason about
 * after the fact, and the host already writes a `dictation <id> <kind>` line
 * per event. This is the deck's half of that pairing — which of Table T03's
 * triggers fired, on which session.
 */
const DICTATION_LOG: boolean = Boolean(import.meta.env?.DEV);

/** The transport the store talks to the host over. Replaced in tests. */
export interface DictationTransport {
  start(id: string): void;
  stop(id: string): void;
}

const HOST_TRANSPORT: DictationTransport = {
  start: startDictation,
  stop: stopDictation,
};

export class DictationStore {
  private state: DictationState = EMPTY_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly faces = new Map<string, DictationFace>();

  /** Torn down with the claim, so an idle store observes nothing. */
  private unobserve: Array<() => void> = [];

  private readonly transport: DictationTransport;
  private readonly mintId: () => string;

  constructor(
    options: { transport?: DictationTransport; mintId?: () => string } = {},
  ) {
    this.transport = options.transport ?? HOST_TRANSPORT;
    this.mintId = options.mintId ?? mintDictationId;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Stable between notifications — safe for `useSyncExternalStore`. */
  getSnapshot = (): DictationState => this.state;

  /**
   * Take the mic for `composerId`, ending any other composer's claim first.
   *
   * The handle is opened **before** the host is asked to start, so the span is
   * already parked at the caret when the first `volatile` arrives — the user
   * has pressed a button and the composer should look like it is listening
   * before the recogniser is.
   */
  claim(composerId: string, cardId: string, handle: DictationHandle): DictationClaim {
    if (this.state.claim !== null) this.end("superseded");

    const sessionId = this.mintId();
    const claim: DictationClaim = { composerId, cardId, handle, sessionId, phase: "starting" };
    this.state = { claim, refusal: null };

    this.observe(claim);
    handle.begin();
    this.transport.start(sessionId);
    this.emit();
    return claim;
  }

  /**
   * The button's one gesture. A refusal does not block it: the user may well
   * have just granted the permission that was missing, and a button that
   * refuses to be pressed again makes them reload the deck to try ([P07]).
   */
  toggle(composerId: string, cardId: string, handle: DictationHandle): void {
    if (this.state.claim?.composerId === composerId) {
      this.end("stopped");
      return;
    }
    this.claim(composerId, cardId, handle);
  }

  /**
   * One event from the host. Dropped unless it names the live claim's session
   * — a superseded session's late callbacks, and anything arriving after a
   * voluntary release, land nowhere.
   */
  onEvent(event: DictationEvent): void {
    const claim = this.state.claim;
    if (claim === null || event.id !== claim.sessionId) return;

    switch (event.kind) {
      case "preparing":
        this.setPhase(claim, "preparing");
        return;
      case "ready":
        this.setPhase(claim, "live");
        return;
      case "volatile":
        // No notify. A recogniser revises several times a second and the text
        // goes straight into the editor; a render per revision would repaint
        // the composer under the user's hands ([L06], [P05]).
        claim.handle.volatile(event.text);
        return;
      case "final":
        claim.handle.final(event.text);
        return;
      case "ended":
        this.end(event.reason, true);
        return;
      case "refused":
        this.end("refused", true, { reason: event.reason, message: event.message });
        return;
      case "level":
        // Reserved and never sent ([P03]). Ignored rather than treated as an
        // unknown kind, because the protocol does declare it.
        return;
    }
  }

  /**
   * Give the mic up. Every release runs through here (Table T03).
   *
   * `hostAlreadyEnded` is what keeps the deck from posting a `stop` for a
   * session the host has already closed. The host ignores a stop for a session
   * that is not live, so the post would be harmless — but the flag says which
   * side ended it, and a `stop` in the log for a session that ended itself is
   * a line that reads as a second event on a closed id.
   */
  end(reason: string, hostAlreadyEnded = false, refusal: DictationRefusal | null = null): void {
    const claim = this.state.claim;
    // Nothing to release. Every caller that could pass a refusal reaches here
    // from `onEvent`, which has already checked there is a claim to refuse.
    if (claim === null) return;

    this.release();
    claim.handle.end();
    if (!hostAlreadyEnded) this.transport.stop(claim.sessionId);
    this.state = { claim: null, refusal };
    this.emit();
    if (DICTATION_LOG) {
      console.log(`[dictation] ${claim.sessionId} released: ${reason}`);
    }
  }

  /**
   * End only if `composerId` is the owner — what every composer-side trigger
   * calls, so a composer tearing down after losing the mic to another cannot
   * end the new owner's session.
   */
  endIfOwnedBy(composerId: string, reason: string): void {
    if (this.state.claim?.composerId !== composerId) return;
    this.end(reason);
  }

  /** This composer's face, stable across updates that do not change it. */
  faceFor = (composerId: string): DictationFace => {
    const { claim, refusal } = this.state;

    if (claim !== null && claim.composerId === composerId) {
      return this.cachedFace(claim.phase, null, claim.sessionId);
    }
    if (claim === null && refusal !== null) {
      return this.cachedFace("refused", refusal, null);
    }
    return IDLE_FACE;
  };

  private cachedFace(
    mode: DictationMode,
    refusal: DictationRefusal | null,
    sessionId: string | null,
  ): DictationFace {
    const text = refusal === null ? null : refusalText(refusal);
    const key = `${mode} ${text ?? ""} ${sessionId ?? ""}`;
    const cached = this.faces.get(key);
    if (cached !== undefined) return cached;
    const face: DictationFace = Object.freeze({ mode, sessionId, refusalText: text });
    this.faces.set(key, face);
    return face;
  }

  private setPhase(claim: DictationClaim, phase: DictationPhase): void {
    if (claim.phase === phase) return;
    this.state = { claim: { ...claim, phase }, refusal: null };
    this.emit();
  }

  /**
   * The two releases nothing else can see, registered for the length of one
   * claim. The hold subscription reads the card by id rather than closing over
   * a boolean, so a hold taken on the owning card after the claim began is the
   * thing that fires it.
   */
  private observe(claim: DictationClaim): void {
    this.release();

    const lifecycle = getAppLifecycle();
    if (lifecycle !== null) {
      this.unobserve.push(
        lifecycle.observeApplicationDidResignActive(() => {
          this.endIfOwnedBy(claim.composerId, "resigned");
        }),
      );
    }

    this.unobserve.push(
      cardModalHoldStore.subscribe(() => {
        if (!isCardHeld(cardModalHoldStore.getSnapshot(), claim.cardId)) return;
        this.endIfOwnedBy(claim.composerId, "held");
      }),
    );
  }

  private release(): void {
    for (const off of this.unobserve) off();
    this.unobserve = [];
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** What the button says about a refusal, with the host's own words appended. */
export function refusalText(refusal: DictationRefusal): string {
  const base = REFUSAL_TEXT[refusal.reason];
  if (refusal.reason === "error" && refusal.message !== undefined && refusal.message !== "") {
    return `${base}: ${refusal.message}`;
  }
  return base;
}

export const dictationStore = new DictationStore();

// Wired here rather than in `main.tsx` so the host has somewhere to report to
// the moment anything imports the store. The closure is not decoration: an
// unbound `dictationStore.onEvent` passed as a value loses its receiver and
// throws on the first event.
setDictationListener((event) => {
  dictationStore.onEvent(event);
});

/** Stable idle face for the server snapshot, which has no host to ask. */
const SERVER_FACE = (): DictationFace => IDLE_FACE;

/**
 * This composer's dictation face — the one door a rendering surface should
 * use. The snapshot is the composer's own face rather than the state, so a
 * claim moving on another card compares equal here and React bails out.
 */
export function useDictationFace(composerId: string): DictationFace {
  return useSyncExternalStore(
    dictationStore.subscribe,
    useCallback(() => dictationStore.faceFor(composerId), [composerId]),
    SERVER_FACE,
  );
}
