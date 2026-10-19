/**
 * A request: a routed action that answers, and whose wait has a horizon.
 *
 * `ask(payload, { card?, horizon })` resolves to the owner's reply or to why
 * there is none. A horizon is `{ms}` — a deadline armed at the `ask` call,
 * so time spent held for a target that has not attached counts against it
 * — or `{person}`, naming the user exit the wait ends at, which arms no
 * timer (`tuglaws/no-wait-without-a-horizon.md`).
 *
 * When the shell detaches the card a request was for, the declaration's
 * `onDetach` decides: `fail` resolves it `detached`; `redeliver` sends it
 * again when the card's page next says hello. A requester may `withdraw`
 * a request; the owner's handler sees its signal abort, and the requester
 * resolves `withdrawn`. The signal also aborts when the asker's page goes
 * away — its card detaches, or the shell says hello from a new page (a
 * reload) — since a reply would have nothing to go to. A reply to a
 * request no longer pending is logged and dropped.
 *
 * @module bus/request
 */

import type { BusFrom, EnvelopeIn, EnvelopeOut } from "./envelope";
import { INVALID, type Codec } from "./codec";
import { recordDeclaration } from "./declared";
import { bindEveryPageBus, pageBus, selfFrom, type PageBus, type PeerTarget } from "./page-bus";

/**
 * A request's horizon ([L33]). `{ms}` bounds a wait on another page: a
 * deadline, ending `timeout`. `{person}` is L33's person-exit: the wait is on
 * the person at the surface the request raised — a dialog, a sheet — which
 * the string names as the user exit, so it arms no deadline (the deadline
 * would be on the person); it still ends `withdrawn` or `detached`, and its
 * handler's signal aborts when the asking page goes away.
 */
export type Horizon = { ms: number } | { person: string };

export type RequestFailure = "timeout" | "detached" | "refused" | "withdrawn";

export type RequestResult<R> = { ok: true; value: R } | { ok: false; reason: RequestFailure };

export interface RequestDeclaration<Q, R> {
  id: string;
  owner: "shell" | "card";
  codec: Codec<Q>;
  replyCodec: Codec<R>;
  onDetach: "fail" | "redeliver";
}

/** A pending ask: the result, and the id {@link RequestView.withdraw} takes. */
export type PendingRequest<R> = Promise<RequestResult<R>> & { readonly requestId: string };

/**
 * The owner's answer. Return the reply (or a promise of it); throw to
 * refuse. `signal` aborts when the requester withdraws or goes away.
 */
export type RequestHandler<Q, R> = (payload: Q, from: BusFrom, signal: AbortSignal) => R | Promise<R>;

export interface RequestView<Q, R> {
  ask(payload: Q, options: { card?: string; horizon: Horizon }): PendingRequest<R>;
  withdraw(requestId: string): void;
  handle(handler: RequestHandler<Q, R>): () => void;
}

export interface Request<Q, R> extends RequestView<Q, R> {
  readonly kind: "request";
  readonly key: string;
  readonly declaration: RequestDeclaration<Q, R>;
  on(bus: PageBus): RequestView<Q, R>;
}

interface Outbound<R> {
  target: PeerTarget;
  envelope: EnvelopeOut;
  settle: (result: RequestResult<R>) => void;
  /** Detached under `redeliver`: send again on the target's next hello. */
  resend: boolean;
}

interface Inbound {
  controller: AbortController;
  fromCard: string | null;
  /** The page that asked: a shell hello from another page means it is gone. */
  fromPage: string;
}

function bindRequest<Q, R>(d: RequestDeclaration<Q, R>, bus: PageBus): RequestView<Q, R> {
  const ownerRole = d.owner === "shell" ? "shell" : "body";
  const isOwner = (): boolean => bus.page.role === ownerRole;
  const outbound = new Map<string, Outbound<R>>();
  const inbound = new Map<string, Inbound>();
  let handler: RequestHandler<Q, R> | null = null;
  const early: EnvelopeIn[] = [];

  const reply = (to: string, requestId: string, payload: unknown): void => {
    bus.post({ to: { page: to }, kind: "reply", key: d.id, requestId, payload });
  };

  const answer = (delivered: EnvelopeIn, h: RequestHandler<Q, R>): void => {
    const requestId = delivered.requestId as string;
    const payload = d.codec.decode(delivered.payload);
    if (payload === INVALID) {
      bus.log.warn("bus", `${d.id}: a payload its codec refuses; refused`, { from: delivered.from });
      reply(delivered.from.pageId, requestId, { ok: false });
      return;
    }
    const controller = new AbortController();
    inbound.set(requestId, { controller, fromCard: delivered.from.cardId, fromPage: delivered.from.pageId });
    const done = (result: { ok: true; value: R } | { ok: false }): void => {
      if (inbound.get(requestId)?.controller !== controller) return;
      inbound.delete(requestId);
      if (!controller.signal.aborted) reply(delivered.from.pageId, requestId, result);
    };
    try {
      Promise.resolve(h(payload, delivered.from, controller.signal)).then(
        (value) => done({ ok: true, value }),
        () => done({ ok: false }),
      );
    } catch {
      done({ ok: false });
    }
  };

  // The owner's side.
  bus.route("request", d.id, (delivered) => {
    if (!isOwner() || typeof delivered.requestId !== "string") return;
    if (d.owner === "card" && delivered.from.role === "body") {
      // The shell is the hub: a body never asks another body.
      bus.log.warn("bus", `${d.id}: asked by another body; dropped`, { from: delivered.from });
      return;
    }
    if (delivered.withdraw === true) {
      const pending = inbound.get(delivered.requestId);
      inbound.delete(delivered.requestId);
      pending?.controller.abort();
      const at = early.findIndex((e) => e.requestId === delivered.requestId);
      if (at >= 0) early.splice(at, 1);
      return;
    }
    if (handler === null) early.push(delivered);
    else answer(delivered, handler);
  });

  // The requester's side.
  bus.route("reply", d.id, (delivered) => {
    const pending = typeof delivered.requestId === "string" ? outbound.get(delivered.requestId) : undefined;
    if (pending === undefined) {
      bus.log.warn("bus", `${d.id}: a reply to a request no longer pending; dropped`, {
        from: delivered.from,
        requestId: delivered.requestId,
      });
      return;
    }
    const body = delivered.payload as { ok?: unknown; value?: unknown } | null;
    if (body === null || typeof body !== "object" || body.ok !== true) {
      pending.settle({ ok: false, reason: "refused" });
      return;
    }
    const value = d.replyCodec.decode(body.value);
    if (value === INVALID) {
      bus.log.warn("bus", `${d.id}: a reply its codec refuses; refused`, { from: delivered.from });
      pending.settle({ ok: false, reason: "refused" });
      return;
    }
    pending.settle({ ok: true, value });
  });

  bus.onPeerHello((peer, from) => {
    if (peer === "shell") {
      // A new shell epoch: whatever the old shell asked of this body has no one to answer.
      for (const [requestId, pending] of [...inbound]) {
        if (pending.fromCard !== null || pending.fromPage === from.pageId) continue;
        inbound.delete(requestId);
        pending.controller.abort();
      }
      for (let i = early.length - 1; i >= 0; i--) {
        const e = early[i];
        if (e.from.role === "shell" && e.from.pageId !== from.pageId) early.splice(i, 1);
      }
      return;
    }
    for (const pending of outbound.values()) {
      if (pending.resend && pending.target !== "shell" && pending.target.card === peer.card) {
        pending.resend = false;
        bus.post(pending.envelope);
      }
    }
  });

  bus.onCardGone((cardId, forgotten) => {
    for (const [requestId, pending] of [...outbound]) {
      if (pending.target === "shell" || pending.target.card !== cardId) continue;
      bus.withdrawHeld(pending.target, (e) => e.requestId === requestId);
      if (d.onDetach === "redeliver" && !forgotten) pending.resend = true;
      else pending.settle({ ok: false, reason: "detached" });
    }
    for (const [requestId, pending] of [...inbound]) {
      if (pending.fromCard !== cardId) continue;
      inbound.delete(requestId);
      pending.controller.abort();
    }
  });

  bus.addCensus(`request:${d.id}`, () => ({ pending: outbound.size, answering: inbound.size, early: early.length }));

  const askLocally = (payload: Q, settle: (result: RequestResult<R>) => void, signal: AbortSignal): void => {
    if (handler === null) {
      settle({ ok: false, reason: "refused" });
      return;
    }
    try {
      Promise.resolve(handler(payload, selfFrom(bus), signal)).then(
        (value) => settle({ ok: true, value }),
        () => settle({ ok: false, reason: "refused" }),
      );
    } catch {
      settle({ ok: false, reason: "refused" });
    }
  };

  const view: RequestView<Q, R> = {
    ask(payload, options) {
      const requestId = crypto.randomUUID();
      let target: PeerTarget;
      if (d.owner === "shell") target = "shell";
      else if (options.card !== undefined) target = { card: options.card };
      else throw new Error(`${d.id}: a card-owned request names its card`);
      if (bus.page.role === "body" && target !== "shell" && target.card !== bus.page.cardId) {
        throw new Error(`${d.id}: a body asks only its own card or the shell`);
      }

      let resolve!: (result: RequestResult<R>) => void;
      const promise = new Promise<RequestResult<R>>((r) => {
        resolve = r;
      });
      let timer: ReturnType<typeof setTimeout> | null = null;
      const local = isOwner();
      const controller = new AbortController();
      const settle = (result: RequestResult<R>): void => {
        if (local) {
          if (controller.signal.aborted) return;
          controller.abort();
        } else {
          if (!outbound.has(requestId)) return;
          outbound.delete(requestId);
        }
        if (timer !== null) clearTimeout(timer);
        resolve(result);
      };
      if ("ms" in options.horizon) {
        timer = setTimeout(() => {
          if (!local) takeDown(requestId);
          settle({ ok: false, reason: "timeout" });
        }, options.horizon.ms);
      }
      if (local) {
        localSettles.set(requestId, settle);
        void promise.then(() => localSettles.delete(requestId));
        askLocally(payload, settle, controller.signal);
      } else {
        const envelope: EnvelopeOut = { to: target, kind: "request", key: d.id, requestId, payload };
        outbound.set(requestId, { target, envelope, settle, resend: false });
        bus.post(envelope);
      }
      return Object.assign(promise, { requestId });
    },
    withdraw(requestId) {
      const settle = localSettles.get(requestId);
      if (settle !== undefined) {
        settle({ ok: false, reason: "withdrawn" });
        return;
      }
      const pending = outbound.get(requestId);
      if (pending === undefined) return;
      takeDown(requestId);
      pending.settle({ ok: false, reason: "withdrawn" });
    },
    handle(h) {
      if (!isOwner()) throw new Error(`${d.id}: handled on a page that does not own it (owner ${d.owner})`);
      if (handler !== null) throw new Error(`${d.id}: already has a handler on this page`);
      handler = h;
      for (const delivered of early.splice(0)) answer(delivered, h);
      return () => {
        if (handler === h) handler = null;
      };
    },
  };

  const localSettles = new Map<string, (result: RequestResult<R>) => void>();

  /** Take a request back from its owner: out of the hold if it is still there, else tell the owner. */
  function takeDown(requestId: string): void {
    const pending = outbound.get(requestId);
    if (pending === undefined) return;
    const unsent = bus.withdrawHeld(pending.target, (e) => e.kind === "request" && e.requestId === requestId);
    if (unsent === 0 && !pending.resend) {
      bus.post({ to: pending.target, kind: "request", key: d.id, requestId, withdraw: true });
    }
  }

  return view;
}

export function defineRequest<Q, R>(d: RequestDeclaration<Q, R>): Request<Q, R> {
  const views = new WeakMap<PageBus, RequestView<Q, R>>();
  const on = (bus: PageBus): RequestView<Q, R> => {
    const view = views.get(bus);
    if (view === undefined) throw new Error(`${d.id}: not bound to this page bus`);
    return view;
  };
  const request: Request<Q, R> = {
    kind: "request",
    key: d.id,
    declaration: d,
    on,
    ask: (payload, options) => on(pageBus()).ask(payload, options),
    withdraw: (requestId) => on(pageBus()).withdraw(requestId),
    handle: (h) => on(pageBus()).handle(h),
  };
  recordDeclaration(request);
  bindEveryPageBus((bus) => {
    views.set(bus, bindRequest(d, bus));
  });
  return request;
}
