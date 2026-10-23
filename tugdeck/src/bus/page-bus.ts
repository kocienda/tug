/**
 * The page bus: one per page, the page's only `DECK_BUS` listener, and the
 * owner of liveness between the shell and its bodies.
 *
 * **Attach is a hello.** Every page says `hello` once its bus is up
 * ({@link PageBus.announce}) and again every time its connection opens after
 * that. A body says it to the shell, naming its card and component; the shell broadcasts its own
 * to every body. A page marks a peer attached on the peer's hello, and every
 * hello that is not itself an answer is answered once — so a shell that
 * reloads hears every bound body again, and the exchange stops after one
 * round. A warm spare (a body with no card yet) hears the shell's broadcast,
 * marks the shell attached, and stays silent: it announces itself when it
 * learns its card. The shell detaches a card when the host says its page is
 * gone ({@link PageBus.detach}); a page treats every peer as away while its
 * own connection is closed.
 *
 * **Nothing waits by hand.** An envelope sent to a specific target that is
 * not attached is held, per target, in send order, and delivered on attach —
 * after the stores scoped to that peer have gone out as snapshots. A held
 * store snapshot is coalesced: only the latest per key and card is kept.
 * Detach drops held snapshots (attach re-sends them) and keeps everything
 * else.
 *
 * **One parse.** Each frame is parsed once by the transport and dispatched
 * here by kind and key. A store, action, request or reply whose key no
 * route names is logged once per key and dropped, and so is a kind the
 * envelope does not name.
 *
 * **One throw fails alone.** The bus is the page's one `DECK_BUS` listener,
 * so it is where a frame fans out into app code: each route, and each
 * listener the bus calls, runs fenced, and a throw is logged against what
 * it was answering and goes no further.
 *
 * @module bus/page-bus
 */

import { tugDevLogStore } from "../lib/tug-dev-log-store/tug-dev-log-store";
import {
  describeTarget,
  isEnvelopeKind,
  type BusFrom,
  type BusTarget,
  type EnvelopeIn,
  type EnvelopeKind,
  type EnvelopeOut,
  type HelloPayload,
} from "./envelope";
import type { PageIdentity } from "./page";
import type { BusTransport } from "./transport";

/** A target an envelope can be held for: the shell, or one card's page. */
export type PeerTarget = "shell" | { card: string };

/** The kinds a route answers: everything but `hello`, which the page bus answers itself. */
export type RoutedKind = Exclude<EnvelopeKind, "hello">;

export interface BusLog {
  debug(source: string, message: string, data?: unknown): void;
  warn(source: string, message: string, data?: unknown): void;
}

export interface PageBusOptions {
  /** Where the page bus writes what it refused. Defaults to the dev log. */
  log?: BusLog;
}

export interface PostOptions {
  /**
   * Hold at most one envelope with this key per target: a newer one replaces
   * the older. Set for store snapshots, whose latest value is the only one
   * worth delivering, and which detach drops.
   */
  coalesce?: string;
}

export interface AttachedCard {
  cardId: string;
  componentId: string;
  pageId: string;
}

export interface BusCensus {
  page: { role: "shell" | "body"; cardId: string | null; componentId: string | null };
  /** A body: whether the shell is attached. The shell: always false. */
  shellAttached: boolean;
  /** The shell: the cards attached, with the page and component each hello named. */
  attached: AttachedCard[];
  /** Envelopes held, by target. */
  queued: Record<string, number>;
  /** Frames and bytes sent, by `kind:key` (or `kind` for an envelope with no key). */
  sent: Record<string, { frames: number; bytes: number }>;
  /** Targets tugcast answered `bus_undeliverable` for, and how often. */
  undeliverable: Record<string, number>;
  /** Keys received that no route names. */
  unknownKeys: string[];
  /** What the primitives built on this bus report about themselves. */
  extensions: Record<string, unknown>;
}

export interface PageBus {
  readonly page: PageIdentity;
  /** This page's id, as tugcast registered it. */
  readonly pageId: string;
  /** Where this page's bus, and the primitives on it, write what they refuse. */
  readonly log: BusLog;
  isAttached(target: PeerTarget): boolean;
  /** The shell: the cards whose bodies are attached. */
  attachedCards(): ReadonlySet<string>;
  /** The shell: the component a card's body named in its hello. */
  componentOf(cardId: string): string | null;
  /** The shell: a card's body said hello — every hello, a reconnect's included. Runs after the held envelopes are delivered. */
  onAttach(listener: (cardId: string, componentId: string) => void): () => void;
  /** The shell: a card was detached or forgotten. */
  onDetach(listener: (cardId: string) => void): () => void;
  /** The shell: the host says this card's page is gone. */
  detach(cardId: string): void;
  /** The shell: the card is destroyed; drop everything held for it. */
  forgetCard(cardId: string): void;
  /**
   * The shell: the card's page is gone for good and the card stays, as when
   * the host reports its body failed. Everything held for the page goes, and
   * every value it told this side, as at {@link forgetCard}; the values this
   * side owns for the card stay, for the card's next page to be sent at hello.
   */
  forgetPage(cardId: string): void;
  /** Say hello: the shell to every body, a bound body to the shell. A spare says nothing. */
  announce(): void;
  census(): BusCensus;
  dispose(): void;

  // The primitives' side (`shared-store.ts`, `routed-action.ts`, `request.ts`).

  /**
   * Send an envelope. To `"shell"` or `{card}` it is held until that peer is
   * attached. To `"body"` it goes as one broadcast while any body is
   * attached, and is dropped otherwise — only a deck-scope snapshot goes
   * there, and attach re-sends it. To `{page}` it goes at once.
   */
  post(envelope: EnvelopeOut, options?: PostOptions): void;
  /** Take back held envelopes for `target` that `match` names. Returns how many. */
  withdrawHeld(target: PeerTarget, match: (envelope: EnvelopeOut) => boolean): number;
  /** Answer every received envelope of `kind` with `key`. One route per kind and key. */
  route(kind: RoutedKind, key: string, handler: (delivered: EnvelopeIn) => void): () => void;
  /**
   * A peer said hello: send it what it is owed. Runs after the answer and
   * before the held envelopes drain, so a snapshot precedes everything held.
   * A listener that names itself in `order` runs after every listener its
   * `after` names; the rest run in the order they were added.
   */
  onPeerHello(listener: (peer: PeerTarget, from: BusFrom) => void, order?: HelloOrder): () => void;
  /**
   * A card detached (`forgotten` false) or was forgotten (`forgotten` true);
   * `cardStays` unless the card itself was forgotten ({@link forgetCard}).
   * Runs before {@link onDetach} listeners.
   */
  onCardGone(listener: (cardId: string, forgotten: boolean, cardStays: boolean) => void): () => void;
  /** Add a section to {@link census}. */
  addCensus(name: string, read: () => unknown): () => void;
}

interface Held {
  envelope: EnvelopeOut;
  coalesce: string | null;
}

/** Where a hello listener runs: after the listeners named in `after`. */
export interface HelloOrder {
  name: string;
  after?: readonly string[];
}

interface HelloListener {
  listener: (peer: PeerTarget, from: BusFrom) => void;
  order: HelloOrder | null;
}

/**
 * Hello listeners in the order they run: as added, except that a listener
 * runs only after every listener its `after` names. A cycle runs in the
 * order added past the point it closes.
 */
function helloRunOrder(entries: readonly HelloListener[]): HelloListener[] {
  const named = new Map<string, HelloListener>();
  for (const e of entries) if (e.order !== null) named.set(e.order.name, e);
  const ran = new Set<HelloListener>();
  const visiting = new Set<HelloListener>();
  const out: HelloListener[] = [];
  const visit = (e: HelloListener): void => {
    if (ran.has(e) || visiting.has(e)) return;
    visiting.add(e);
    for (const name of e.order?.after ?? []) {
      const before = named.get(name);
      if (before !== undefined) visit(before);
    }
    visiting.delete(e);
    ran.add(e);
    out.push(e);
  };
  for (const e of entries) visit(e);
  return out;
}

function peerKey(target: PeerTarget): string {
  return target === "shell" ? "shell" : `card:${target.card}`;
}

function sentKey(envelope: EnvelopeOut): string {
  return envelope.key === undefined ? envelope.kind : `${envelope.kind}:${envelope.key}`;
}

function readHello(payload: unknown): HelloPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p.role !== "shell" && p.role !== "body") return null;
  if (p.cardId !== undefined && typeof p.cardId !== "string") return null;
  if (p.componentId !== undefined && typeof p.componentId !== "string") return null;
  if (p.answer !== undefined && p.answer !== true) return null;
  return p as unknown as HelloPayload;
}

/** What a throw says, for the log: an `Error`'s stack (or message), anything else as a string. */
export function thrownText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function listeners<T>(): { add(l: T): () => void; each(f: (l: T) => void): void } {
  const set = new Set<T>();
  return {
    add(l) {
      set.add(l);
      return () => {
        set.delete(l);
      };
    },
    each(f) {
      for (const l of [...set]) f(l);
    },
  };
}

export function createPageBus(transport: BusTransport, page: PageIdentity, options: PageBusOptions = {}): PageBus {
  const log: BusLog = options.log ?? tugDevLogStore;

  /** A body: whether the shell is attached. */
  let shellAttached = false;
  /** The shell: the cards whose bodies are attached. */
  const attached = new Map<string, AttachedCard>();
  /** The shell: every card that ever said hello, until forgotten — what `componentOf` answers. */
  const components = new Map<string, string>();
  const held = new Map<string, Held[]>();
  const sent: Record<string, { frames: number; bytes: number }> = {};
  const undeliverable: Record<string, number> = {};
  const unknownKeys = new Set<string>();
  const routes = new Map<string, (delivered: EnvelopeIn) => void>();
  const censusSections = new Map<string, () => unknown>();
  const attachListeners = listeners<(cardId: string, componentId: string) => void>();
  const detachListeners = listeners<(cardId: string) => void>();
  const helloListeners: HelloListener[] = [];
  const eachHello = (what: string, peer: PeerTarget, from: BusFrom): void => {
    for (const { listener } of helloRunOrder(helloListeners)) fenced(what, from, () => listener(peer, from));
  };
  const goneListeners = listeners<(cardId: string, forgotten: boolean, cardStays: boolean) => void>();
  let disposed = false;
  /** Whether this page has announced itself, so every later open announces it again. */
  let announced = false;

  /** Run `f` so a throw is logged against `what` and goes no further. */
  const fenced = (what: string, from: BusFrom | null, f: () => void): void => {
    try {
      f();
    } catch (error) {
      log.warn("bus", `${what} threw; the bus goes on`, { from, error: thrownText(error) });
    }
  };

  const isAttached = (target: PeerTarget): boolean =>
    target === "shell" ? shellAttached : attached.has(target.card);

  const transmit = (envelope: EnvelopeOut): void => {
    const bytes = transport.send(envelope);
    const key = sentKey(envelope);
    const tally = (sent[key] ??= { frames: 0, bytes: 0 });
    tally.frames += 1;
    tally.bytes += bytes;
  };

  const hold = (target: PeerTarget, envelope: EnvelopeOut, coalesce: string | null): void => {
    const key = peerKey(target);
    let queue = held.get(key);
    if (queue === undefined) {
      queue = [];
      held.set(key, queue);
    }
    if (coalesce !== null) {
      const at = queue.findIndex((h) => h.coalesce === coalesce);
      if (at >= 0) queue.splice(at, 1);
    }
    queue.push({ envelope, coalesce });
  };

  const drain = (target: PeerTarget): void => {
    const key = peerKey(target);
    const queue = held.get(key);
    if (queue === undefined) return;
    held.delete(key);
    for (const h of queue) transmit(h.envelope);
  };

  const post = (envelope: EnvelopeOut, postOptions: PostOptions = {}): void => {
    if (disposed) return;
    const to = envelope.to;
    if (to === "body") {
      if (attached.size > 0) transmit(envelope);
      return;
    }
    if (typeof to === "object" && "page" in to) {
      transmit(envelope);
      return;
    }
    const target: PeerTarget = to === "shell" ? "shell" : { card: to.card };
    if (isAttached(target)) transmit(envelope);
    else hold(target, envelope, postOptions.coalesce ?? null);
  };

  const hello = (to: BusTarget, answer: boolean): void => {
    const payload: HelloPayload =
      page.role === "shell"
        ? { role: "shell" }
        : { role: "body", cardId: page.cardId ?? undefined, componentId: page.componentId ?? undefined };
    if (answer) payload.answer = true;
    transmit({ to, kind: "hello", payload });
  };

  const receiveHello = (delivered: EnvelopeIn): void => {
    const payload = readHello(delivered.payload);
    if (payload === null || payload.role !== delivered.from.role) {
      log.warn("bus", "a hello that names no page; dropped", { from: delivered.from });
      return;
    }
    if (page.role === "shell") {
      // A body's hello: the card is the one tugcast registered the sender as.
      const cardId = delivered.from.cardId;
      if (payload.role !== "body" || cardId === null || payload.componentId === undefined) {
        log.warn("bus", "a hello the shell cannot attach; dropped", { from: delivered.from });
        return;
      }
      // A spare whose connection reopened says hello before it takes its
      // card again, and tugcast still stamps it as the spare: it says hello
      // again once it has.
      if (payload.cardId !== cardId) {
        log.debug("bus", "a hello from a page not yet bound to the card it names; dropped", {
          from: delivered.from,
          names: payload.cardId,
        });
        return;
      }
      const target: PeerTarget = { card: cardId };
      attached.set(cardId, { cardId, componentId: payload.componentId, pageId: delivered.from.pageId });
      components.set(cardId, payload.componentId);
      if (payload.answer !== true) hello(target, true);
      eachHello(`hello from card ${cardId}`, target, delivered.from);
      drain(target);
      attachListeners.each((l) =>
        fenced(`attach of card ${cardId}`, delivered.from, () => l(cardId, payload.componentId as string)),
      );
      return;
    }
    // A body hears the shell.
    if (payload.role !== "shell") return;
    shellAttached = true;
    if (page.cardId === null) return; // a spare: silent until it is bound
    if (payload.answer !== true) hello("shell", true);
    eachHello("hello from the shell", "shell", delivered.from);
    drain("shell");
  };

  const logUnknown = (kind: string, key: string | undefined, from: BusFrom): void => {
    const name = key === undefined ? kind : `${kind}:${key}`;
    if (unknownKeys.has(name)) return;
    unknownKeys.add(name);
    log.warn("bus", `no declaration answers ${name}; dropped`, { from });
  };

  const receive = (delivered: EnvelopeIn): void => {
    if (disposed) return;
    const kind = (delivered as { kind?: unknown }).kind;
    if (!isEnvelopeKind(kind)) {
      logUnknown(String(kind), undefined, delivered.from);
      return;
    }
    const envelope = delivered;
    if (kind === "hello") {
      receiveHello(envelope);
      return;
    }
    const route = typeof envelope.key === "string" ? routes.get(`${kind}:${envelope.key}`) : undefined;
    if (route === undefined) {
      logUnknown(kind, envelope.key, envelope.from);
      return;
    }
    fenced(`${kind}:${envelope.key}`, envelope.from, () => route(envelope));
  };

  const believedAttached = (to: BusTarget): boolean => {
    if (to === "body") return attached.size > 0;
    if (to === "shell") return shellAttached;
    if ("card" in to) return attached.has(to.card);
    return false;
  };

  const goneCard = (cardId: string, forgotten: boolean, cardStays: boolean): void => {
    attached.delete(cardId);
    const key = peerKey({ card: cardId });
    const queue = held.get(key);
    if (forgotten) {
      // A forgotten card's page will never attach: what was held for it is
      // gone, and each verb dropped says so ([L31]). Snapshots are not news.
      for (const h of queue ?? []) {
        if (h.coalesce !== null) continue;
        log.warn("bus", `held ${sentKey(h.envelope)} for card ${cardId} dropped: the card was forgotten`, {
          to: h.envelope.to,
        });
      }
      held.delete(key);
      components.delete(cardId);
    } else if (queue !== undefined) {
      const kept = queue.filter((h) => h.coalesce === null);
      if (kept.length > 0) held.set(key, kept);
      else held.delete(key);
    }
    goneListeners.each((l) => fenced(`card ${cardId} gone`, null, () => l(cardId, forgotten, cardStays)));
    detachListeners.each((l) => fenced(`detach of card ${cardId}`, null, () => l(cardId)));
  };

  const releases: Array<() => void> = [
    transport.onFrame(receive),
    transport.onUndeliverable((to) => {
      const name = describeTarget(to);
      undeliverable[name] = (undeliverable[name] ?? 0) + 1;
      const believed = believedAttached(to);
      // The shell's boot hello reaches no body when none exists yet; that is not news.
      const data = { to, believedAttached: believed };
      if (believed) log.warn("bus", `bus_undeliverable to ${name}`, data);
      else log.debug("bus", `bus_undeliverable to ${name}`, data);
    }),
    transport.onDisconnect(() => {
      // Every peer is away while this page's wire is down; their hellos bring them back.
      shellAttached = false;
      attached.clear();
    }),
    // A page that has announced announces again on every open: a hello sent
    // before the socket was up went nowhere, and one after a close is how
    // the peers hear it is back.
    transport.onOpen(() => {
      if (announced) bus.announce();
    }),
  ];

  const bus: PageBus = {
    page,
    pageId: transport.pageId,
    log,
    isAttached,
    attachedCards: () => new Set(attached.keys()),
    componentOf: (cardId) => components.get(cardId) ?? null,
    onAttach: (l) => attachListeners.add(l),
    onDetach: (l) => detachListeners.add(l),
    detach: (cardId) => goneCard(cardId, false, true),
    forgetCard: (cardId) => goneCard(cardId, true, false),
    forgetPage: (cardId) => goneCard(cardId, true, true),
    announce() {
      if (disposed) return;
      announced = true;
      if (page.role === "shell") hello("body", false);
      else if (page.cardId !== null) hello("shell", false);
    },
    census() {
      const queued: Record<string, number> = {};
      for (const [key, queue] of held) queued[key] = queue.length;
      const extensions: Record<string, unknown> = {};
      for (const [name, read] of censusSections) extensions[name] = read();
      return {
        page: { role: page.role, cardId: page.cardId, componentId: page.componentId },
        shellAttached,
        attached: [...attached.values()].map((a) => ({ ...a })),
        queued,
        sent: Object.fromEntries(Object.entries(sent).map(([k, v]) => [k, { ...v }])),
        undeliverable: { ...undeliverable },
        unknownKeys: [...unknownKeys],
        extensions,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      liveBuses.delete(bus);
      for (const entry of binders) entry.bound.delete(bus);
      for (const release of releases) release();
      held.clear();
      attached.clear();
      shellAttached = false;
    },
    post,
    withdrawHeld(target, match) {
      const key = peerKey(target);
      const queue = held.get(key);
      if (queue === undefined) return 0;
      const kept = queue.filter((h) => !match(h.envelope));
      if (kept.length > 0) held.set(key, kept);
      else held.delete(key);
      return queue.length - kept.length;
    },
    route(kind, key, handler) {
      const name = `${kind}:${key}`;
      if (routes.has(name)) throw new Error(`page bus: ${name} already has a route`);
      routes.set(name, handler);
      return () => {
        if (routes.get(name) === handler) routes.delete(name);
      };
    },
    onPeerHello(listener, order) {
      const entry: HelloListener = { listener, order: order ?? null };
      helloListeners.push(entry);
      return () => {
        const at = helloListeners.indexOf(entry);
        if (at >= 0) helloListeners.splice(at, 1);
      };
    },
    onCardGone: (l) => goneListeners.add(l),
    addCensus(name, read) {
      censusSections.set(name, read);
      return () => {
        if (censusSections.get(name) === read) censusSections.delete(name);
      };
    },
  };
  liveBuses.add(bus);
  for (const entry of binders) bindOne(entry, bus);
  return bus;
}

/** A page's sender identity, as tugcast would stamp it: for a primitive answering its own page. */
export function selfFrom(bus: PageBus): BusFrom {
  return { pageId: bus.pageId, role: bus.page.role, cardId: bus.page.cardId };
}

/** Bind to one page bus; return what releases the binding, or nothing to release. */
type Binder = (bus: PageBus) => void | (() => void);
interface BinderEntry {
  binder: Binder;
  /** What the binder took on each live bus, to release on unbind. */
  bound: Map<PageBus, () => void>;
}
const binders: BinderEntry[] = [];
const liveBuses = new Set<PageBus>();

const bindOne = (entry: BinderEntry, bus: PageBus): void => {
  const release = entry.binder(bus);
  if (typeof release === "function") entry.bound.set(bus, release);
};

/**
 * Bind a declaration to every page bus: those alive now and every one
 * created after. This is how a declaration answers on its page whatever
 * order the modules were imported in — and on each page of a test bus.
 * Returns the unbind: no bus created after it is bound, and what the binder
 * returned on each live bus is released ([L27]).
 */
export function bindEveryPageBus(binder: Binder): () => void {
  const entry: BinderEntry = { binder, bound: new Map() };
  binders.push(entry);
  for (const bus of liveBuses) bindOne(entry, bus);
  return () => {
    const at = binders.indexOf(entry);
    if (at < 0) return;
    binders.splice(at, 1);
    for (const release of entry.bound.values()) release();
    entry.bound.clear();
  };
}

/** How many binders answer every new page bus: for a test that a release left none behind. */
export function _pageBusBinderCountForTest(): number {
  return binders.length;
}

declare global {
  interface Window {
    /** Dev and test builds: the page bus's census, read through the eval door. */
    __tugBus?: { census(): BusCensus };
  }
}

let installedBus: PageBus | null = null;

/** Make `bus` this page's bus. Once per page; the declarations bind to it lazily. */
export function installPageBus(bus: PageBus): void {
  if (installedBus !== null) throw new Error("installPageBus: this page already has a bus");
  installedBus = bus;
  if (typeof window !== "undefined" && (import.meta.env?.DEV === true || window.__tugTestMode === true)) {
    window.__tugBus = { census: () => bus.census() };
  }
}

/** This page's bus. Throws before {@link installPageBus}. */
export function pageBus(): PageBus {
  if (installedBus === null) throw new Error("pageBus: no page bus is installed on this page");
  return installedBus;
}

/** This page's bus, or null before {@link installPageBus}: for a reader that answers on a page with none. */
export function installedPageBus(): PageBus | null {
  return installedBus;
}

export function _resetPageBusForTest(): void {
  installedBus?.dispose();
  installedBus = null;
}
