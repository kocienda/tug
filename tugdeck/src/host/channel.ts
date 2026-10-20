/**
 * The one place a page reaches the Swift host.
 *
 * A post is `JSON.stringify` of the payload, handed to the declaration's
 * `WKScriptMessageHandler`; the host decodes the string's bytes with
 * `JSONDecoder` (`HostChannel.swift`). In a dev or test build the payload is
 * first run through the declaration's own codec, so a writer that posts a
 * shape its codec refuses is caught in the page that wrote it rather than as
 * a refusal on the host.
 *
 * The host's half comes back the same way. `installHostChannel` defines one
 * `window.__tugBridge` member per host→page declaration; the host calls the
 * member with one payload (`HostChannel.send` in Swift), the member decodes
 * it with the declaration's codec, and hands it to the one handler a module
 * registered with `onHostMessage`. A call the host awaits (`window.tugdeck`'s
 * `saveState`, `prepareForTermination` and `reauthenticate`, and the bridge's
 * `onPageZoomApply`) is answered the same way through `answerPageCall`, and
 * its handler's reply is what the host receives.
 *
 * Nothing else under `tugdeck/src` names `webkit.messageHandlers`, assigns a
 * `__tugBridge` member, or installs a `__tug…Callback` global
 * (`__tests__/no-hand-channel.test.ts`).
 *
 * @module host/channel
 */

import { INVALID } from "../bus/codec";
import { tugDevLogStore } from "../lib/tug-dev-log-store/tug-dev-log-store";
import type { PageCall, ToHost, ToPage } from "./declare";
import { prepareForTerminationCall, reauthenticateCall, saveStateCall } from "./declarations/lifecycle";
import { PAGE_CALLS, TO_PAGE } from "./registry";

interface HostHandler {
  postMessage(value: unknown): void;
}

function handlers(): Record<string, HostHandler | undefined> | undefined {
  return (globalThis as { webkit?: { messageHandlers?: Record<string, HostHandler | undefined> } }).webkit
    ?.messageHandlers;
}

function handlerOf(name: string): HostHandler | undefined {
  const handler = handlers()?.[name];
  return typeof handler?.postMessage === "function" ? handler : undefined;
}

/** Whether a writer's payload is checked against its codec before it is posted. */
function writerChecked(): boolean {
  return import.meta.env.DEV === true || (globalThis as { __tugTestMode?: boolean }).__tugTestMode === true;
}

/** Post `payload` to the host as `decl`; nothing outside the host. */
export function postToHost<T>(decl: ToHost<T>, payload: T): void {
  const handler = handlerOf(decl.name);
  if (handler === undefined) return;
  if (writerChecked() && decl.codec.decode(payload) === INVALID) {
    tugDevLogStore.warn("host", `refused to post "${decl.name}": its codec does not admit the payload`);
    return;
  }
  handler.postMessage(JSON.stringify(payload));
}

/** Whether the host answers `decl` — false in a browser tab or a page with no bridge. */
export function hostAvailable(decl: ToHost<unknown>): boolean {
  return handlerOf(decl.name) !== undefined;
}

/** Whether this page runs inside the host's web view at all. */
export function inHost(): boolean {
  return handlers() !== undefined;
}

// Host → page.

type Handler = (payload: unknown) => unknown;

/** The one handler per member, keyed as the declaration records itself. */
const receivers = new Map<string, Handler>();
/** Members that arrived with no handler, said once each. */
const unanswered = new Set<string>();

function toPageKey(decl: ToPage<unknown>): string {
  return `toPage:${decl.member}`;
}

function pageCallKey(decl: PageCall<unknown, unknown>): string {
  return `pageCall:${decl.receiver}.${decl.member}`;
}

/**
 * The payload decoded and handed to its handler, with the handler's reply; or
 * nothing, logged, when there is no handler or the codec refuses it.
 */
function deliver(key: string, name: string, decode: (value: unknown) => unknown, payload: unknown): unknown {
  const handler = receivers.get(key);
  if (handler === undefined) {
    if (!unanswered.has(key)) {
      unanswered.add(key);
      tugDevLogStore.warn("host", `"${name}" arrived and nothing in this page handles it`);
    }
    return undefined;
  }
  const value = decode(payload);
  if (value === INVALID) {
    tugDevLogStore.warn("host", `refused "${name}": its codec does not admit the payload`);
    return undefined;
  }
  return handler(value);
}

function memberOf(decl: ToPage<unknown>): (payload: unknown) => void {
  const key = toPageKey(decl);
  return (payload) => {
    deliver(key, decl.member, (value) => decl.codec.decode(value), payload);
  };
}

function checkReply(decl: PageCall<unknown, unknown>, reply: unknown): void {
  if (decl.replyCodec.decode(reply) === INVALID) {
    tugDevLogStore.warn("host", `"${decl.member}" answered with a reply its codec does not admit`);
  }
}

function callMemberOf(decl: PageCall<unknown, unknown>): (payload?: unknown) => unknown {
  const key = pageCallKey(decl);
  return (payload) => {
    const reply = deliver(key, decl.member, (value) => decl.codec.decode(value), payload);
    if (writerChecked()) {
      if (reply instanceof Promise) void reply.then((settled) => checkReply(decl, settled), () => {});
      else checkReply(decl, reply);
    }
    return reply;
  };
}

interface BridgeScope {
  __tugBridge?: Record<string, unknown>;
}

/**
 * Define every declared `window.__tugBridge` member, once per page: first
 * thing at boot, and again by each `onHostMessage`, so a page that registers
 * a handler always has its member. A member already there is left alone —
 * a test wraps a member to watch it, and its wrapper calls through.
 */
export function installHostChannel(): void {
  const scope = globalThis as BridgeScope;
  const bridge = (scope.__tugBridge ??= {});
  for (const decl of TO_PAGE) {
    if (bridge[decl.member] === undefined) bridge[decl.member] = memberOf(decl);
  }
  for (const decl of PAGE_CALLS) {
    if (decl.receiver === "bridge" && bridge[decl.member] === undefined) bridge[decl.member] = callMemberOf(decl);
  }
}

function claim(key: string, handler: Handler): () => void {
  if (receivers.has(key)) throw new Error(`host: "${key}" already has a handler`);
  receivers.set(key, handler);
  unanswered.delete(key);
  return () => {
    if (receivers.get(key) === handler) receivers.delete(key);
  };
}

/** Handle `decl` in this page; the one handler it has. Returns its release. */
export function onHostMessage<T>(decl: ToPage<T>, handler: (payload: T) => unknown): () => void {
  installHostChannel();
  return claim(toPageKey(decl as ToPage<unknown>), handler as Handler);
}

/** Answer a call the host awaits; the handler's reply is the host's. Returns its release. */
export function answerPageCall<T, R>(decl: PageCall<T, R>, handler: (payload: T) => R | Promise<R>): () => void {
  installHostChannel();
  return claim(pageCallKey(decl as PageCall<unknown, unknown>), handler as Handler);
}

/** The calls the host makes on `window.tugdeck`, which each page spreads into it. */
export interface TugdeckPageCalls {
  saveState(payload?: unknown): unknown;
  prepareForTermination(payload?: unknown): unknown;
  reauthenticate(payload?: unknown): unknown;
}

/** The `window.tugdeck` members the host calls, each answered through `answerPageCall`. */
export function tugdeckPageCalls(): TugdeckPageCalls {
  return {
    saveState: callMemberOf(saveStateCall as PageCall<unknown, unknown>),
    prepareForTermination: callMemberOf(prepareForTerminationCall as PageCall<unknown, unknown>),
    reauthenticate: callMemberOf(reauthenticateCall as PageCall<unknown, unknown>),
  };
}
