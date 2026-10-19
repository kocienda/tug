/**
 * A shared store: one value, owned by one page, replicated to the pages its
 * scope names.
 *
 * - **Owner by lifetime.** A `shell` store's value lives in the shell and is
 *   replicated to bodies; a `card` store's value lives in its card's body
 *   and is replicated to the shell.
 * - **Scope** says who replicates it: every body (`deck`), one card's page
 *   (`card` — keyed by card, read in the shell with `getFor`), or the cards
 *   whose component a predicate admits (`kinds`).
 * - **Versions and epochs.** The owner bumps a version on every changed
 *   `set` (`equals`, default structural, decides "changed"). A replica takes
 *   a snapshot with a newer version, or any version from a new epoch — the
 *   sender's page id, which a reload changes. A repeated snapshot never
 *   re-notifies, so snapshots stay reference-stable for
 *   `useSyncExternalStore`.
 * - **Snapshot on attach.** When a peer says hello the owner sends it the
 *   current value before anything held for it, and after the snapshots of
 *   the stores the declaration names in `after`.
 * - **Only the owner speaks for the value.** A replica takes a snapshot only
 *   from the owner's role, and the shell takes a card's value only from that
 *   card's own page, so no body writes a sibling's replica ([L38]).
 * - **Write-back.** A store declared with `proposals` lets a replica
 *   `propose(patch)`: the replica shows the patch at once, the owner's
 *   `onProposal` applies or refuses it, and the owner republishes after every
 *   proposal it handles, acknowledging it. The replica keeps its optimistic
 *   view until its latest proposal is acknowledged, then takes the owner's
 *   value whatever it is. A new owner epoch drops pending proposals.
 *
 * A declaration answers on every page bus (`bindEveryPageBus`), so import
 * order does not matter; `store.on(bus)` reads it on one page of a test bus,
 * and the store's own methods read it on this page's installed bus.
 *
 * @module bus/shared-store
 */

import type { BusFrom, EnvelopeIn, EnvelopeOut } from "./envelope";
import { INVALID, type Codec } from "./codec";
import { recordDeclaration } from "./declared";
import { jsonEqual } from "./equal";
import { bindEveryPageBus, pageBus, thrownText, type PageBus, type PeerTarget } from "./page-bus";

export type StoreOwner = "shell" | "card";
export type StoreScope = { deck: true } | { card: true } | { kinds: (componentId: string) => boolean };

export interface SharedStoreDeclaration<T, P = never> {
  key: string;
  owner: StoreOwner;
  scope: StoreScope;
  codec: Codec<T>;
  initial: T;
  equals?: (a: T, b: T) => boolean;
  /** Replicas drop the card's value when the shell detaches the card. */
  clearOnDetach?: boolean;
  /** Replicas may propose patches of this type to the owner. */
  proposals?: Codec<P>;
  /** How a replica shows its own patch before the owner answers. Default: the patch is the new value. */
  applyProposal?: (prev: T, patch: P) => T;
  /**
   * Stores whose snapshot a peer that attaches is sent before this one's.
   * Declare the order a reader relies on here, rather than leave it to the
   * order the declaration modules happen to be imported in.
   */
  after?: readonly { readonly kind: "store"; readonly key: string }[];
}

/** A store as one page reads and writes it. */
export interface StoreView<T, P = never> {
  subscribe(listener: () => void): () => void;
  /** Deck or kinds scope; for card scope, this body's own card. */
  getSnapshot(): T;
  /** Card scope, read in the shell. */
  getFor(cardId: string): T;
  /** Whether a value has arrived (a replica) or been set (the owner). */
  arrived(cardId?: string): boolean;
  /** The owner page: deck or kinds scope, or a body setting its own card. */
  set(value: T): void;
  /** The shell, owning a card-scope store. */
  setFor(cardId: string, value: T): void;
  update(fn: (prev: T) => T): void;
  /** A replica page, when the store declares `proposals`. */
  propose(patch: P): void;
  /** The owner page: apply or refuse each proposal. One handler per page. */
  onProposal(handler: (patch: P, from: BusFrom) => void): () => void;
}

export interface SharedStore<T, P = never> extends StoreView<T, P> {
  readonly kind: "store";
  readonly key: string;
  readonly declaration: SharedStoreDeclaration<T, P>;
  /** The store on one page bus. */
  on(bus: PageBus): StoreView<T, P>;
}

interface Entry<T> {
  value: T;
  version: number;
  /** A replica: the owner page the version belongs to. */
  epoch: string | null;
  arrived: boolean;
  /** The owner: the latest proposal handled, by replica page id. */
  acks: Record<string, number>;
  /** A replica: its latest proposal not yet acknowledged, or 0. */
  pending: number;
}

const DECK = "";

function bindStore<T, P>(d: SharedStoreDeclaration<T, P>, bus: PageBus): StoreView<T, P> {
  const equals = d.equals ?? jsonEqual;
  const apply = d.applyProposal ?? ((_prev: T, patch: P) => patch as unknown as T);
  const cardScoped = "card" in d.scope;
  const kinds = "kinds" in d.scope ? d.scope.kinds : null;
  const ownerRole = d.owner === "shell" ? "shell" : "body";
  const isOwner = (): boolean => bus.page.role === ownerRole;
  const entries = new Map<string, Entry<T>>();
  const listeners = new Set<() => void>();
  let proposalHandler: ((patch: P, from: BusFrom) => void) | null = null;
  let nextProposal = 0;
  /** While an owner handles a proposal: the entry keys its handler already published. */
  const publishedDuringProposal = new Set<string>();
  /** The owner: the card each proposing replica page shows, so its ack goes when the card does. */
  const proposerCard = new Map<string, string>();

  // Each subscriber fails alone: one React subscriber that throws must not starve the next.
  const notify = (): void => {
    for (const l of [...listeners]) {
      try {
        l();
      } catch (error) {
        bus.log.warn("bus", `${d.key}: a subscriber threw; the others still run`, { error: thrownText(error) });
      }
    }
  };

  const entry = (key: string): Entry<T> => {
    let e = entries.get(key);
    if (e === undefined) {
      e = { value: d.initial, version: 0, epoch: null, arrived: false, acks: {}, pending: 0 };
      entries.set(key, e);
    }
    return e;
  };

  const ownCard = (what: string): string => {
    const cardId = bus.page.cardId;
    if (bus.page.role !== "body" || cardId === null) {
      throw new Error(`${d.key}: ${what} needs a body bound to a card`);
    }
    return cardId;
  };

  const snapshot = (to: EnvelopeOut["to"], key: string, e: Entry<T>): EnvelopeOut => {
    const envelope: EnvelopeOut = { to, kind: "state", key: d.key, version: e.version, payload: e.value };
    if (cardScoped) envelope.card = key;
    if (Object.keys(e.acks).length > 0) envelope.ack = { ...e.acks };
    return envelope;
  };

  const admits = (cardId: string): boolean => {
    const component = bus.componentOf(cardId);
    return kinds !== null && component !== null && kinds(component);
  };

  const publish = (key: string, e: Entry<T>): void => {
    publishedDuringProposal.add(key);
    if (cardScoped) {
      const to: PeerTarget = d.owner === "shell" ? { card: key } : "shell";
      bus.post(snapshot(to, key, e), { coalesce: `${d.key}:${key}` });
    } else if (kinds !== null) {
      for (const cardId of bus.attachedCards()) {
        if (admits(cardId)) bus.post(snapshot({ card: cardId }, key, e), { coalesce: `${d.key}:${key}` });
      }
    } else {
      bus.post(snapshot("body", key, e));
    }
  };

  const write = (key: string, value: T): void => {
    const e = entry(key);
    if (e.version > 0 && equals(e.value, value)) return;
    e.value = value;
    e.version += 1;
    e.arrived = true;
    notify();
    publish(key, e);
  };

  const view: StoreView<T, P> = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      const key = cardScoped ? bus.page.cardId : DECK;
      if (key === null) return d.initial;
      return entries.get(key)?.value ?? d.initial;
    },
    getFor(cardId) {
      return entries.get(cardId)?.value ?? d.initial;
    },
    arrived(cardId) {
      const key = cardScoped ? (cardId ?? bus.page.cardId) : DECK;
      return key !== null && (entries.get(key)?.arrived ?? false);
    },
    set(value) {
      if (!isOwner()) throw new Error(`${d.key}: set on a page that does not own it (owner ${d.owner})`);
      if (cardScoped && d.owner === "shell") throw new Error(`${d.key}: the shell sets a card's value with setFor`);
      write(cardScoped ? ownCard("set") : DECK, value);
    },
    setFor(cardId, value) {
      if (!cardScoped || d.owner !== "shell" || !isOwner()) {
        throw new Error(`${d.key}: setFor is the shell's, on a shell-owned card store`);
      }
      write(cardId, value);
    },
    update(fn) {
      view.set(fn(view.getSnapshot()));
    },
    propose(patch) {
      if (d.proposals === undefined) throw new Error(`${d.key}: declares no proposals`);
      const key = cardScoped ? ownCard("propose") : DECK;
      if (isOwner()) {
        write(key, apply(entry(key).value, patch));
        return;
      }
      if (bus.page.role !== "body") throw new Error(`${d.key}: only a body proposes to the shell`);
      const e = entry(key);
      e.value = apply(e.value, patch);
      nextProposal += 1;
      e.pending = nextProposal;
      notify();
      const envelope: EnvelopeOut = { to: "shell", kind: "action", key: d.key, proposal: nextProposal, payload: patch };
      if (cardScoped) envelope.card = key;
      bus.post(envelope);
    },
    onProposal(handler) {
      if (d.proposals === undefined) throw new Error(`${d.key}: declares no proposals`);
      if (!isOwner()) throw new Error(`${d.key}: onProposal on a page that does not own it`);
      if (proposalHandler !== null) throw new Error(`${d.key}: already has a proposal handler on this page`);
      proposalHandler = handler;
      return () => {
        if (proposalHandler === handler) proposalHandler = null;
      };
    },
  };

  const receiveSnapshot = (delivered: EnvelopeIn): void => {
    if (isOwner()) return;
    if (delivered.from.role !== ownerRole) {
      bus.log.warn("bus", `${d.key}: a snapshot from a page that does not own it; refused`, { from: delivered.from });
      return;
    }
    const value = d.codec.decode(delivered.payload);
    if (value === INVALID) {
      bus.log.warn("bus", `${d.key}: a snapshot its codec refuses; dropped`, { from: delivered.from });
      return;
    }
    let key = DECK;
    if (cardScoped) {
      if (typeof delivered.card !== "string") {
        bus.log.warn("bus", `${d.key}: a card snapshot that names no card; dropped`, { from: delivered.from });
        return;
      }
      if (bus.page.role === "body" && delivered.card !== bus.page.cardId) return;
      // The shell takes a card's value only from that card's own page.
      if (bus.page.role === "shell" && delivered.card !== delivered.from.cardId) {
        bus.log.warn("bus", `${d.key}: a snapshot for a card its sender does not show; refused`, {
          from: delivered.from,
          card: delivered.card,
        });
        return;
      }
      key = delivered.card;
    }
    const version = typeof delivered.version === "number" ? delivered.version : 0;
    const epoch = delivered.from.pageId;
    const e = entry(key);
    const newEpoch = e.epoch !== epoch;
    if (!newEpoch && version <= e.version) return;
    const acked = delivered.ack?.[bus.pageId] ?? 0;
    // An owner that reloaded cannot acknowledge what the old page was sent.
    // The first owner a replica hears is no reload: a proposal held for it
    // reaches it behind this snapshot, and is acknowledged in turn.
    const reloaded = newEpoch && e.epoch !== null;
    if (reloaded || acked >= e.pending) e.pending = 0;
    e.version = version;
    e.epoch = epoch;
    let changed = !e.arrived;
    e.arrived = true;
    if (e.pending === 0 && !equals(e.value, value)) {
      e.value = value;
      changed = true;
    }
    if (changed) notify();
  };

  const receiveProposal = (delivered: EnvelopeIn): void => {
    if (!isOwner() || d.proposals === undefined) return;
    let key = DECK;
    if (cardScoped) {
      const cardId = d.owner === "shell" ? delivered.from.cardId : bus.page.cardId;
      if (cardId === null || (typeof delivered.card === "string" && delivered.card !== cardId)) {
        bus.log.warn("bus", `${d.key}: a proposal for a card its sender does not show; dropped`, { from: delivered.from });
        return;
      }
      key = cardId;
    }
    const e = entry(key);
    if (typeof delivered.proposal === "number") e.acks[delivered.from.pageId] = delivered.proposal;
    if (delivered.from.cardId !== null) proposerCard.set(delivered.from.pageId, delivered.from.cardId);
    publishedDuringProposal.clear();
    const patch = d.proposals.decode(delivered.payload);
    if (patch === INVALID) {
      bus.log.warn("bus", `${d.key}: a proposal its codec refuses; refused`, { from: delivered.from });
    } else if (proposalHandler !== null) {
      proposalHandler(patch, delivered.from);
    }
    // Every handled proposal is answered, applied or not, so the replica's ack arrives.
    // A handler that published only other entries has not answered this one.
    if (!publishedDuringProposal.has(key)) {
      e.version += 1;
      e.arrived = true;
      publish(key, e);
    }
  };

  bus.route("state", d.key, receiveSnapshot);
  bus.route("action", d.key, receiveProposal);

  bus.onPeerHello(
    (peer) => {
      if (!isOwner()) return;
      if (peer === "shell") {
        // A body's own card value, to the shell.
        if (!cardScoped || d.owner !== "card" || bus.page.cardId === null) return;
        const e = entries.get(bus.page.cardId);
        if (e !== undefined && e.version > 0) bus.post(snapshot("shell", bus.page.cardId, e));
        return;
      }
      const key = cardScoped ? peer.card : DECK;
      const e = entries.get(key);
      if (e === undefined || e.version === 0) return;
      if (kinds !== null && !admits(peer.card)) return;
      bus.post(snapshot({ card: peer.card }, key, e));
    },
    { name: `store:${d.key}`, after: d.after?.map((s) => `store:${s.key}`) },
  );

  bus.onCardGone((cardId, forgotten) => {
    // A replica page that is gone acknowledges nothing more: its acks leave every snapshot.
    for (const [pageId, card] of [...proposerCard]) {
      if (card !== cardId) continue;
      proposerCard.delete(pageId);
      for (const e of entries.values()) delete e.acks[pageId];
    }
    if (!cardScoped || !entries.has(cardId)) return;
    if (forgotten || (!isOwner() && d.clearOnDetach === true)) {
      entries.delete(cardId);
      notify();
    }
  });

  bus.addCensus(`store:${d.key}`, () => ({
    owner: isOwner(),
    entries: Object.fromEntries(
      [...entries].map(([k, e]) => [k === DECK ? "deck" : k, { version: e.version, arrived: e.arrived, pending: e.pending }]),
    ),
  }));

  return view;
}

export function defineSharedStore<T, P = never>(d: SharedStoreDeclaration<T, P>): SharedStore<T, P> {
  if (d.owner === "card" && !("card" in d.scope)) {
    throw new Error(`${d.key}: a card-owned store is card-scoped`);
  }
  const views = new WeakMap<PageBus, StoreView<T, P>>();
  const on = (bus: PageBus): StoreView<T, P> => {
    const view = views.get(bus);
    if (view === undefined) throw new Error(`${d.key}: not bound to this page bus`);
    return view;
  };
  const here = (): StoreView<T, P> => on(pageBus());
  const store: SharedStore<T, P> = {
    kind: "store",
    key: d.key,
    declaration: d,
    on,
    subscribe: (l) => here().subscribe(l),
    getSnapshot: () => here().getSnapshot(),
    getFor: (cardId) => here().getFor(cardId),
    arrived: (cardId) => here().arrived(cardId),
    set: (v) => here().set(v),
    setFor: (cardId, v) => here().setFor(cardId, v),
    update: (fn) => here().update(fn),
    propose: (patch) => here().propose(patch),
    onProposal: (h) => here().onProposal(h),
  };
  recordDeclaration(store);
  bindEveryPageBus((bus) => {
    views.set(bus, bindStore(d, bus));
  });
  return store;
}
