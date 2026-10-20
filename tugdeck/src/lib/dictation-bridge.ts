/**
 * dictation-bridge.ts — the wire between the deck and the host's microphone.
 *
 * The Tug.app host exposes a `dictation` `WKScriptMessageHandler`. We post
 * `{ id, verb }` where `verb` is `"start"`, `"stop"` or `"finish"` and `id` is
 * a session id this module mints; the host calls back
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
 * The event type is the union `dictationToPage` declares, which the host's
 * `DictationState.swift` encodes as an enum keyed on the same tag — one
 * protocol ([P02]), held by the parity fixture.
 *
 * Graceful degradation: outside the host (dev browser, or before the app is
 * rebuilt with the handler) {@link isDictationAvailable} is `false`,
 * {@link startDictation}, {@link stopDictation} and {@link finishDictation}
 * are no-ops, and the button renders nothing, so nothing offers a microphone
 * that cannot exist.
 *
 * @module lib/dictation-bridge
 */

import { hostAvailable, installHostChannel, onHostMessage, postToHost } from "../host/channel";
import { dictationToHost, dictationToPage, type DictationEvent } from "../host/declarations/services";
import { INVALID } from "../bus/codec";

export type { DictationEndReason, DictationEvent, DictationRefusalReason } from "../host/declarations/services";

/**
 * This page's mark on the ids it mints. Every card body is its own page with
 * its own module state, so a bare counter would have two composers both
 * claim `dict-1`, and the host could not tell one claim from the other.
 */
const PAGE_MARK = crypto.randomUUID().slice(0, 8);

/** Monotonic session-id counter within this page. */
let nextId = 0;

/** The one listener, or `null`. The store registers it; nothing else may. */
let listener: ((event: DictationEvent) => void) | null = null;

/** Whether the host's microphone is reachable (running inside Tug.app). */
export function isDictationAvailable(): boolean {
  return hostAvailable(dictationToHost);
}

/**
 * A fresh session id. Unique per `start` across every page in the window,
 * which is what the host keys on.
 */
export function mintDictationId(): string {
  nextId += 1;
  return `dict-${PAGE_MARK}-${nextId}`;
}

/**
 * Parse a payload from the host into an event, or `null`.
 *
 * Strict on purpose: it is the declaration's own decode. The union is
 * discriminated, and a `volatile` without its text or an `ended` carrying a
 * reason this build does not know are both a host and a deck that disagree
 * about the protocol — which is a thing to drop and not a thing to guess at,
 * because the guess would put text in the user's document or leave a claim
 * nothing can release. A field a kind does not have is dropped.
 */
export function dictationEventFromPayload(payload: unknown): DictationEvent | null {
  const event = dictationToPage.codec.decode(payload);
  return event === INVALID ? null : event;
}

/** Ask the host to start listening for `id`. A no-op outside the host. */
export function startDictation(id: string): void {
  postToHost(dictationToHost, { id, verb: "start" });
}

/**
 * Ask the host to stop `id`. A no-op outside the host, and the host ignores
 * one naming a session that is not live — so a stale stop costs nothing.
 *
 * Stop **truncates**: whatever the recogniser had not yet settled is thrown
 * away on both sides. Escape and the involuntary ends are what this is for;
 * the user saying they are done talking is {@link finishDictation}.
 */
export function stopDictation(id: string): void {
  postToHost(dictationToHost, { id, verb: "stop" });
}

/**
 * Ask the host to *finish* `id`: stop listening, but ask the recogniser for
 * its settled reading of what it already heard and keep forwarding `final`
 * events until it answers.
 *
 * The session stays live until the host's `ended` arrives, which is what the
 * store's `finishing` phase waits on — so unlike {@link stopDictation} this
 * is not a synchronous end and cannot be used where the caller needs the
 * draft in the same tick. A no-op outside the host, and ignored by the host
 * for a session that is not live, on the same terms as a stale stop.
 */
export function finishDictation(id: string): void {
  postToHost(dictationToHost, { id, verb: "finish" });
}

/** Register the one listener, or clear it with `null`. */
export function setDictationListener(next: ((event: DictationEvent) => void) | null): void {
  listener = next;
}

let installed = false;

/**
 * Take `__tugBridge.onDictation` in this page. Safe to call again.
 *
 * Unlike the update bridge there is nothing to replay: what crosses here is an
 * event and not state, and a deck that reloads mid-session has thrown away the
 * claim those events were for. The next thing it does is claim the mic again
 * with a fresh id, so the host's in-flight session is simply superseded.
 */
export function installDictationBridge(): void {
  installHostChannel();
  if (installed) return;
  installed = true;
  onHostMessage(dictationToPage, (event) => {
    listener?.(event);
  });
}
