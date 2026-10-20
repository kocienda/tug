/**
 * The host vocabulary: how a message between a page and the Swift host is
 * declared.
 *
 * A page posts to the host through a `WKScriptMessageHandler` name and the
 * host calls back into a page through a `window.__tugBridge` member. Each of
 * those is declared once, here, with the page that may send or receive it, a
 * `bus/codec.ts` codec, and samples — the bus's discipline carried to the
 * host channel. `host/registry.ts` lists the declarations; its conformance
 * test holds every codec to its samples, and the parity fixture written from
 * it is what `HostMessages.swift`'s twin is checked against.
 *
 * Page→host and host→page are separate namespaces, keyed by what is on the
 * wire: the handler name (`cardGesture`) and the bridge member
 * (`onCardGesture`). A second declaration of either throws.
 *
 * @module host/declare
 */

import { opaque, type Codec } from "../bus/codec";

/** The reply of a call that answers nothing: `null`. */
export const noReply: Codec<null> = opaque((value: unknown): value is null => value === null, null);

/**
 * Which page may post a message, or receive one: the shell, a card's body,
 * the overlay above every card (`overlay/`), or any of them.
 */
export type HostPage = "shell" | "body" | "overlay" | "any";

/** A message a page posts to the host. */
export interface ToHost<T> {
  readonly kind: "toHost";
  /** The `WKScriptMessageHandler` name. */
  readonly name: string;
  /** The page that may post it; the host refuses a `shell` message from any other page, and an `overlay` one from any but the overlay. */
  readonly from: HostPage;
  readonly codec: Codec<T>;
  readonly samples: readonly T[];
  /** Payloads the codec refuses, which the Swift decode must refuse too. */
  readonly refused: readonly unknown[];
}

/** A message the host sends a page, through one `window.__tugBridge` member. */
export interface ToPage<T> {
  readonly kind: "toPage";
  readonly member: `on${string}`;
  readonly to: HostPage;
  readonly codec: Codec<T>;
  readonly samples: readonly T[];
  readonly refused: readonly unknown[];
}

/** A call the host makes into a page and awaits a reply from. */
export interface PageCall<T, R> {
  readonly kind: "pageCall";
  readonly receiver: "tugdeck" | "bridge";
  readonly member: string;
  readonly codec: Codec<T>;
  readonly replyCodec: Codec<R>;
  readonly samples: readonly T[];
  readonly refused: readonly unknown[];
  /** Replies the page answers with, which the Swift decode must read. */
  readonly replies: readonly R[];
  /** Replies the reply codec refuses, which the Swift decode must refuse too. */
  readonly refusedReplies: readonly unknown[];
}

export type HostDeclaration = ToHost<unknown> | ToPage<unknown> | PageCall<unknown, unknown>;

const defined = new Map<string, HostDeclaration>();

function record(key: string, declaration: HostDeclaration): void {
  if (defined.has(key)) throw new Error(`host: "${key}" is already declared`);
  defined.set(key, declaration);
}

// A declaration's type is its codec's: `samples` is `NoInfer`, so a sample's
// plain string never widens a codec's literal to `string`.

export function defineToHost<T>(
  d: Omit<ToHost<T>, "kind" | "samples" | "refused"> & {
    samples: readonly NoInfer<T>[];
    refused: unknown[];
  },
): ToHost<T> {
  const declaration: ToHost<T> = { kind: "toHost", ...d };
  record(`toHost:${d.name}`, declaration as ToHost<unknown>);
  return declaration;
}

export function defineToPage<T>(
  d: Omit<ToPage<T>, "kind" | "samples" | "refused"> & {
    samples: readonly NoInfer<T>[];
    refused: unknown[];
  },
): ToPage<T> {
  const declaration: ToPage<T> = { kind: "toPage", ...d };
  record(`toPage:${d.member}`, declaration as ToPage<unknown>);
  return declaration;
}

export function definePageCall<T, R>(
  d: Omit<PageCall<T, R>, "kind" | "samples" | "replies"> & {
    samples: readonly NoInfer<T>[];
    replies: readonly NoInfer<R>[];
  },
): PageCall<T, R> {
  const declaration: PageCall<T, R> = { kind: "pageCall", ...d };
  record(`pageCall:${d.receiver}.${d.member}`, declaration as PageCall<unknown, unknown>);
  return declaration;
}

/** Every host declaration this realm has defined, for the registry's conformance test. */
export function definedHostDeclarations(): readonly HostDeclaration[] {
  return [...defined.values()];
}
