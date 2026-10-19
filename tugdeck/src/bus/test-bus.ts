/**
 * An in-memory deck bus: a shell page and any number of body pages, each
 * with the real page bus over a fake transport, and a fake router between
 * them that resolves targets the way tugcast's `PageRegistry::resolve`
 * (`tugrust/crates/tugcast/src/pages.rs`) does.
 *
 * - `"shell"` is the newest connected shell; `"body"` is every connected
 *   body, spares included; `{card}` is the newest connected page showing
 *   that card; `{page}` is that page. A spare is registered as
 *   `spare:<pageId>`, as tugcast registers it, until it binds — and again
 *   when its connection reopens, until it binds again (`page_bind`).
 * - The router stamps `from` and answers `bus_undeliverable` to the sender
 *   when nobody answers a target.
 * - Every frame is serialized on send and parsed once per receiving page, so
 *   a payload that does not survive JSON does not survive here either, and
 *   {@link TestPage.parses} counts the parses.
 * - Delivery is in send order, on a queue the test drains with
 *   `await bus.flush()`.
 *
 * A store, action or request is tested here as an exchange between pages,
 * never against a `send` callback.
 *
 * @module bus/test-bus
 */

import type { BusFrom, BusTarget, EnvelopeIn, EnvelopeOut } from "./envelope";
import { _resetPageBusForTest, createPageBus, installPageBus, type BusLog, type PageBus } from "./page-bus";
import type { PageIdentity } from "./page";
import type { BusTransport } from "./transport";

export interface LogLine {
  level: "debug" | "warn";
  source: string;
  message: string;
  data?: unknown;
}

export interface TestPage {
  readonly pageId: string;
  readonly bus: PageBus;
  /** The page's identity, as its bus reads it. A spare's card arrives through {@link TestBus.bind}. */
  readonly identity: PageIdentity;
  /** Frames this page has parsed. */
  readonly parses: number;
  /** What this page's bus logged. */
  readonly log: readonly LogLine[];
  /** Whether this page is connected to the router. */
  readonly connected: boolean;
}

export interface DeliveredFrame {
  /** The sender's page id. */
  from: string;
  /** The page ids that received it; empty when it was undeliverable. */
  to: string[];
  envelope: EnvelopeOut;
}

export interface TestBus {
  /** A new shell page. It announces itself, as a booting shell does. */
  shell(): TestPage;
  /** A new body page: bound to `cardId` and announced, or a spare when `cardId` is null. */
  body(cardId: string | null, componentId?: string | null): TestPage;
  /** A spare learns its card, as `bindBody` does: bound at the router (`page_bind`) and announced. */
  bind(page: TestPage, cardId: string, componentId: string): void;
  /** The host says `cardId`'s page is gone: its pages leave and the newest shell detaches it. */
  detach(cardId: string): void;
  /** A page's connection drops; it stays away until {@link reconnect}. */
  disconnect(page: TestPage): void;
  /** A page's connection comes back (dropping first if it is up), and it says hello again. */
  reconnect(page: TestPage): void;
  /** A page unloads for good. */
  leave(page: TestPage): void;
  /** The targets tugcast would have answered `bus_undeliverable` for, to this page. */
  undeliverable(on: TestPage): BusTarget[];
  /** Every frame the router has carried, in order. */
  frames(): readonly DeliveredFrame[];
  /** Deliver everything queued, and whatever that delivery sends, until the queue is empty. */
  flush(): Promise<void>;
  /**
   * Make `page`'s bus the installed page bus (`installPageBus`), as `main.tsx`
   * or `body-main.ts` does, so a module that reads this page's bus reads it.
   * Undone by {@link dispose}.
   */
  install(page: TestPage): void;
  dispose(): void;
}

interface PageRecord {
  pageId: string;
  role: "shell" | "body";
  identity: { role: "shell" | "body"; cardId: string | null; componentId: string | null };
  /** A body: the card the router knows it by, or null for a spare it has not bound. */
  registered: string | null;
  /** A body that loaded as a spare: its connection's own hello names no card. */
  bornSpare: boolean;
  connected: boolean;
  parses: number;
  log: LogLine[];
  undeliverable: BusTarget[];
  frameListeners: Set<(d: EnvelopeIn) => void>;
  undeliverableListeners: Set<(to: BusTarget) => void>;
  disconnectListeners: Set<() => void>;
  openListeners: Set<() => void>;
  bus: PageBus;
}

type Queued = { kind: "frame"; sender: PageRecord; text: string } | { kind: "undeliverable"; on: PageRecord; to: BusTarget };

function add<T>(set: Set<T>, item: T): () => void {
  set.add(item);
  return () => {
    set.delete(item);
  };
}

export function createTestBus(): TestBus {
  const pages: PageRecord[] = [];
  const queue: Queued[] = [];
  const carried: DeliveredFrame[] = [];
  let nextPage = 1;
  let installed = false;

  /** The card id the router knows a page by: a spare is `spare:<pageId>`. */
  const routerCard = (p: PageRecord): string | null =>
    p.role === "shell" ? null : (p.registered ?? `spare:${p.pageId}`);

  const resolve = (to: BusTarget): PageRecord[] => {
    const live = pages.filter((p) => p.connected);
    const newest = (pred: (p: PageRecord) => boolean): PageRecord[] => {
      for (let i = live.length - 1; i >= 0; i--) if (pred(live[i])) return [live[i]];
      return [];
    };
    if (to === "shell") return newest((p) => p.role === "shell");
    if (to === "body") return live.filter((p) => p.role === "body");
    if ("card" in to) return newest((p) => routerCard(p) === to.card);
    return newest((p) => p.pageId === to.page);
  };

  const makePage = (role: "shell" | "body", cardId: string | null, componentId: string | null): PageRecord => {
    const record = {
      pageId: `${role}-${nextPage++}`,
      role,
      identity: { role, cardId, componentId },
      registered: cardId,
      bornSpare: role === "body" && cardId === null,
      connected: true,
      parses: 0,
      log: [] as LogLine[],
      undeliverable: [] as BusTarget[],
      frameListeners: new Set<(d: EnvelopeIn) => void>(),
      undeliverableListeners: new Set<(to: BusTarget) => void>(),
      disconnectListeners: new Set<() => void>(),
      openListeners: new Set<() => void>(),
    } as Omit<PageRecord, "bus"> as PageRecord;
    const transport: BusTransport = {
      pageId: record.pageId,
      send(envelope) {
        const text = JSON.stringify(envelope);
        // A closed wire drops the frame, as a real one does.
        if (record.connected) queue.push({ kind: "frame", sender: record, text });
        return text.length;
      },
      onFrame: (l) => add(record.frameListeners, l),
      onUndeliverable: (l) => add(record.undeliverableListeners, l),
      onDisconnect: (l) => add(record.disconnectListeners, l),
      onOpen: (l) => add(record.openListeners, l),
    };
    const log: BusLog = {
      debug: (source, message, data) => record.log.push({ level: "debug", source, message, data }),
      warn: (source, message, data) => record.log.push({ level: "warn", source, message, data }),
    };
    record.bus = createPageBus(transport, record.identity, { log });
    pages.push(record);
    return record;
  };

  const view = (p: PageRecord): TestPage => ({
    pageId: p.pageId,
    bus: p.bus,
    identity: p.identity,
    get parses() {
      return p.parses;
    },
    get log() {
      return p.log;
    },
    get connected() {
      return p.connected;
    },
  });

  const records = new WeakMap<object, PageRecord>();
  const handle = (p: PageRecord): TestPage => {
    const v = view(p);
    records.set(v, p);
    return v;
  };
  const recordOf = (v: TestPage): PageRecord => {
    const p = records.get(v);
    if (p === undefined) throw new Error("test bus: not a page of this bus");
    return p;
  };

  const deliverOne = (item: Queued): void => {
    if (item.kind === "undeliverable") {
      item.on.undeliverable.push(item.to);
      for (const l of [...item.on.undeliverableListeners]) l(item.to);
      return;
    }
    const out = JSON.parse(item.text) as EnvelopeOut & { from?: unknown };
    delete out.from; // a page cannot speak as another
    const recipients = resolve(out.to);
    carried.push({ from: item.sender.pageId, to: recipients.map((r) => r.pageId), envelope: out });
    if (recipients.length === 0) {
      queue.push({ kind: "undeliverable", on: item.sender, to: out.to });
      return;
    }
    const from: BusFrom = { pageId: item.sender.pageId, role: item.sender.role, cardId: routerCard(item.sender) };
    const text = JSON.stringify({ from, ...out });
    for (const r of recipients) {
      r.parses += 1;
      const delivered = JSON.parse(text) as EnvelopeIn;
      for (const l of [...r.frameListeners]) l(delivered);
    }
  };

  const drop = (p: PageRecord): void => {
    if (!p.connected) return;
    p.connected = false;
    for (const l of [...p.disconnectListeners]) l();
  };

  return {
    shell() {
      const p = makePage("shell", null, null);
      p.bus.announce();
      return handle(p);
    },
    body(cardId, componentId = null) {
      const p = makePage("body", cardId, cardId === null ? null : (componentId ?? "test"));
      p.bus.announce();
      return handle(p);
    },
    bind(v, cardId, componentId) {
      const p = recordOf(v);
      if (p.role !== "body") throw new Error("test bus: only a body binds a card");
      p.identity.cardId = cardId;
      p.identity.componentId = componentId;
      p.registered = cardId;
      p.bus.announce();
    },
    detach(cardId) {
      for (const p of pages) if (p.role === "body" && p.identity.cardId === cardId) drop(p);
      const shell = resolve("shell")[0];
      shell?.bus.detach(cardId);
    },
    disconnect(v) {
      drop(recordOf(v));
    },
    reconnect(v) {
      const p = recordOf(v);
      drop(p);
      p.connected = true;
      // A new connection's hello names what the page loaded as.
      if (p.bornSpare) p.registered = null;
      for (const l of [...p.openListeners]) l();
    },
    leave(v) {
      const p = recordOf(v);
      drop(p);
      p.bus.dispose();
      pages.splice(pages.indexOf(p), 1);
    },
    undeliverable: (v) => [...recordOf(v).undeliverable],
    frames: () => carried,
    async flush() {
      for (;;) {
        while (queue.length > 0) deliverOne(queue.shift() as Queued);
        await Promise.resolve();
        if (queue.length === 0) return;
      }
    },
    install(page) {
      installPageBus(page.bus);
      installed = true;
    },
    dispose() {
      if (installed) _resetPageBusForTest();
      installed = false;
      for (const p of pages) p.bus.dispose();
      pages.length = 0;
      queue.length = 0;
    },
  };
}
