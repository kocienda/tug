/**
 * dictation-bridge.ts — the wire between the deck and the host's microphone.
 *
 * The Tug.app host exposes a `dictation` `WKScriptMessageHandler`. We post
 * `{ id, verb }` where `verb` is `"start"` or `"stop"` and `id` is a session
 * id this module mints; the host calls back
 * `window.__tugBridge.onDictation(event)` with one of the events in
 * {@link DictationEvent}. One session is live at a time — a `start` for a
 * second id supersedes the first — and the host is where that is enforced, so
 * a deck that lost track cannot leave two taps on the input node.
 *
 * This module is **only** the wire: it parses, it posts, and it forwards to a
 * single listener. Which composer holds the mic, what a refusal reads as, and
 * when a session has to be given up are `dictation-store.ts`'s, and inserting
 * the text is the editor's.
 *
 * The event type is the same union the host's `DictationState.swift` encodes,
 * and the raw strings in both are the contract ([P02]) — one protocol, fixed
 * by this type.
 *
 * Graceful degradation: outside the host (dev browser, or before the app is
 * rebuilt with the handler) {@link isDictationAvailable} is `false`,
 * {@link startDictation} and {@link stopDictation} are no-ops, and the button
 * renders nothing, so nothing offers a microphone that cannot exist.
 *
 * @module lib/dictation-bridge
 */

/** Why a session never started. The button speaks each of these (Table T01). */
export type DictationRefusalReason =
  | "microphone-permission"
  | "speech-permission"
  | "no-model"
  | "no-input-device"
  | "unavailable"
  | "error";

/** Why a live session ended. */
export type DictationEndReason = "stopped" | "superseded" | "device-lost" | "error";

/**
 * One event from the host, per Spec S02.
 *
 * The ordering rules are the host's to keep (Spec S03): zero or more
 * `preparing`, then exactly one of `ready` or `refused`; after `ready`, any
 * interleaving of `volatile` and `final`, then exactly one `ended`, and
 * nothing after it.
 *
 * `volatile.text` is the whole provisional tail since the last `final` and
 * each one replaces the previous; the concatenation of every `final.text` is
 * the transcript.
 */
export type DictationEvent =
  | { id: string; kind: "preparing" }
  | { id: string; kind: "ready" }
  /** Reserved. The host never sends one ([P03]) — the live face is the wave. */
  | { id: string; kind: "level"; level: number }
  | { id: string; kind: "volatile"; text: string }
  | { id: string; kind: "final"; text: string }
  | { id: string; kind: "ended"; reason: DictationEndReason; message?: string }
  | { id: string; kind: "refused"; reason: DictationRefusalReason; message?: string };

/** The host→web bridge object; only the dictation callback concerns us here. */
interface TugBridge {
  onDictation?: (event: unknown) => void;
}

interface WebkitHandles {
  webkit?: {
    messageHandlers?: Record<string, { postMessage: (value: unknown) => void } | undefined>;
  };
  __tugBridge?: TugBridge;
}

const END_REASONS: readonly string[] = ["stopped", "superseded", "device-lost", "error"];

const REFUSAL_REASONS: readonly string[] = [
  "microphone-permission",
  "speech-permission",
  "no-model",
  "no-input-device",
  "unavailable",
  "error",
];

/** Monotonic session-id counter (no Date/random — resume-safe and unique enough). */
let nextId = 0;

/** The one listener, or `null`. The store registers it; nothing else may. */
let listener: ((event: DictationEvent) => void) | null = null;

/** The `dictation` message handler, or `undefined` outside the host. */
function dictationHandler(): { postMessage: (value: unknown) => void } | undefined {
  const w = globalThis as unknown as WebkitHandles;
  return w.webkit?.messageHandlers?.dictation ?? undefined;
}

/** Whether the host's microphone is reachable (running inside Tug.app). */
export function isDictationAvailable(): boolean {
  return dictationHandler() !== undefined;
}

/** A fresh session id. Unique per `start`, which is what the host keys on. */
export function mintDictationId(): string {
  nextId += 1;
  return `dict-${nextId}`;
}

/**
 * Parse a payload from the host into an event, or `null`.
 *
 * Strict on purpose. The union above is discriminated, and a `ready` carrying
 * a `text` or an `ended` carrying a reason this build does not know are both
 * a host and a deck that disagree about the protocol — which is a thing to
 * drop and not a thing to guess at, because the guess would put text in the
 * user's document or leave a claim nothing can release.
 */
export function dictationEventFromPayload(payload: unknown): DictationEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;

  const id = record.id;
  const kind = record.kind;
  if (typeof id !== "string" || typeof kind !== "string") return null;

  switch (kind) {
    case "preparing":
    case "ready":
      return { id, kind };
    case "level":
      return typeof record.level === "number" ? { id, kind, level: record.level } : null;
    case "volatile":
    case "final":
      return typeof record.text === "string" ? { id, kind, text: record.text } : null;
    case "ended": {
      const reason = record.reason;
      if (typeof reason !== "string" || !END_REASONS.includes(reason)) return null;
      const event: DictationEvent = { id, kind, reason: reason as DictationEndReason };
      if (typeof record.message === "string") event.message = record.message;
      return event;
    }
    case "refused": {
      const reason = record.reason;
      if (typeof reason !== "string" || !REFUSAL_REASONS.includes(reason)) return null;
      const event: DictationEvent = { id, kind, reason: reason as DictationRefusalReason };
      if (typeof record.message === "string") event.message = record.message;
      return event;
    }
    default:
      return null;
  }
}

/** Ask the host to start listening for `id`. A no-op outside the host. */
export function startDictation(id: string): void {
  dictationHandler()?.postMessage({ id, verb: "start" });
}

/**
 * Ask the host to stop `id`. A no-op outside the host, and the host ignores
 * one naming a session that is not live — so a stale stop costs nothing.
 */
export function stopDictation(id: string): void {
  dictationHandler()?.postMessage({ id, verb: "stop" });
}

/** Register the one listener, or clear it with `null`. */
export function setDictationListener(next: ((event: DictationEvent) => void) | null): void {
  listener = next;
}

/**
 * Install the `onDictation` receiver once, preserving any sibling bridge keys.
 *
 * Unlike the update bridge there is nothing to replay: what crosses here is an
 * event and not state, and a deck that reloads mid-session has thrown away the
 * claim those events were for. The next thing it does is claim the mic again
 * with a fresh id, so the host's in-flight session is simply superseded.
 */
export function installDictationBridge(): void {
  const w = globalThis as unknown as WebkitHandles;
  const bridge = (w.__tugBridge ??= {});
  if (bridge.onDictation !== undefined) return;
  bridge.onDictation = (payload) => {
    const event = dictationEventFromPayload(payload);
    if (event === null) return;
    listener?.(event);
  };
}
