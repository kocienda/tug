/**
 * A routed action: a verb with one owner. Any page may dispatch it; it runs
 * on the owner's page — the shell (`owner: "shell"`) or the named card's
 * body (`owner: "card"`).
 *
 * Dispatched where it is owned, it runs at once. Dispatched elsewhere, it
 * crosses the bus and is held by the page bus until its target is attached.
 * The shell is the hub: a body dispatches a card-owned action only to its
 * own card, never to another body. An action that reaches its owner before a
 * handler is registered there is held on that page and handed to the first
 * handler.
 *
 * @module bus/routed-action
 */

import type { BusFrom } from "./envelope";
import { INVALID, type Codec } from "./codec";
import { recordDeclaration } from "./declared";
import { bindEveryPageBus, pageBus, selfFrom, type PageBus } from "./page-bus";

export interface ActionDeclaration<P> {
  id: string;
  owner: "shell" | "card";
  codec: Codec<P>;
}

export interface ActionView<P> {
  /** Run the action where it is owned. `to` names the card when the owner is `"card"`. */
  dispatch(payload: P, to?: { card: string }): void;
  /** The owner page: run each dispatch. One handler per page. */
  handle(handler: (payload: P, from: BusFrom) => void): () => void;
}

export interface RoutedAction<P> extends ActionView<P> {
  readonly kind: "action";
  readonly key: string;
  readonly declaration: ActionDeclaration<P>;
  on(bus: PageBus): ActionView<P>;
}

function bindAction<P>(d: ActionDeclaration<P>, bus: PageBus): ActionView<P> {
  const ownerRole = d.owner === "shell" ? "shell" : "body";
  const isOwner = (): boolean => bus.page.role === ownerRole;
  let handler: ((payload: P, from: BusFrom) => void) | null = null;
  const early: Array<{ payload: P; from: BusFrom }> = [];

  const run = (payload: P, from: BusFrom): void => {
    if (handler === null) early.push({ payload, from });
    else handler(payload, from);
  };

  bus.route("action", d.id, (delivered) => {
    if (!isOwner()) return;
    if (d.owner === "card" && delivered.from.role === "body") {
      // The shell is the hub: tugcast would deliver a body's {card} to another body.
      bus.log.warn("bus", `${d.id}: dispatched by another body; dropped`, { from: delivered.from });
      return;
    }
    const payload = d.codec.decode(delivered.payload);
    if (payload === INVALID) {
      bus.log.warn("bus", `${d.id}: a payload its codec refuses; dropped`, { from: delivered.from });
      return;
    }
    run(payload, delivered.from);
  });

  bus.addCensus(`action:${d.id}`, () => ({ owner: isOwner(), handled: handler !== null, early: early.length }));

  return {
    dispatch(payload, to) {
      if (d.owner === "shell") {
        if (bus.page.role === "shell") run(payload, selfFrom(bus));
        else bus.post({ to: "shell", kind: "action", key: d.id, payload });
        return;
      }
      if (to === undefined) throw new Error(`${d.id}: a card-owned action names its card`);
      if (bus.page.role === "body") {
        if (to.card !== bus.page.cardId) throw new Error(`${d.id}: a body dispatches only to its own card`);
        run(payload, selfFrom(bus));
        return;
      }
      bus.post({ to: { card: to.card }, kind: "action", key: d.id, payload });
    },
    handle(h) {
      if (!isOwner()) throw new Error(`${d.id}: handled on a page that does not own it (owner ${d.owner})`);
      if (handler !== null) throw new Error(`${d.id}: already has a handler on this page`);
      handler = h;
      for (const { payload, from } of early.splice(0)) h(payload, from);
      return () => {
        if (handler === h) handler = null;
      };
    },
  };
}

export function defineAction<P>(d: ActionDeclaration<P>): RoutedAction<P> {
  const views = new WeakMap<PageBus, ActionView<P>>();
  const on = (bus: PageBus): ActionView<P> => {
    const view = views.get(bus);
    if (view === undefined) throw new Error(`${d.id}: not bound to this page bus`);
    return view;
  };
  const action: RoutedAction<P> = {
    kind: "action",
    key: d.id,
    declaration: d,
    on,
    dispatch: (payload, to) => on(pageBus()).dispatch(payload, to),
    handle: (h) => on(pageBus()).handle(h),
  };
  recordDeclaration(action);
  bindEveryPageBus((bus) => {
    views.set(bus, bindAction(d, bus));
  });
  return action;
}
