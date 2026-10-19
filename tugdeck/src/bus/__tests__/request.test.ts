/**
 * Requests between pages: an answer, a refusal, a timeout armed at the ask
 * (so time held for an unattached card counts), `fail` and `redeliver` on
 * detach, and a withdrawal the owner's handler sees.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { num, obj, str } from "../codec";
import { defineRequest } from "../request";
import { createTestBus, type TestBus } from "../test-bus";

let bus: TestBus;
afterEach(() => bus?.dispose());

const ask = defineRequest({
  id: "test.request.ask",
  owner: "card",
  codec: obj({ q: str }),
  replyCodec: obj({ a: str }),
  onDetach: "redeliver",
});
const decide = defineRequest({
  id: "test.request.decide",
  owner: "card",
  codec: obj({ q: str }),
  replyCodec: obj({ a: str }),
  onDetach: "fail",
});
const zones = defineRequest({ id: "test.request.zones", owner: "shell", codec: num, replyCodec: num, onDetach: "fail" });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("requests", () => {
  test("a request answers", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const b1 = bus.body("c1");
    await bus.flush();
    decide.on(b1.bus).handle((p) => ({ a: `answer to ${p.q}` }));

    const pending = decide.on(shell.bus).ask({ q: "close?" }, { card: "c1", horizon: { ms: 1000 } });
    await bus.flush();

    expect(await pending).toEqual({ ok: true, value: { a: "answer to close?" } });
    expect(typeof pending.requestId).toBe("string");
  });

  test("a body asks the shell, and a handler that throws refuses", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const b1 = bus.body("c1");
    await bus.flush();
    zones.on(shell.bus).handle((n) => {
      if (n < 0) throw new Error("no");
      return n * 2;
    });

    const good = zones.on(b1.bus).ask(21, { horizon: { ms: 1000 } });
    const bad = zones.on(b1.bus).ask(-1, { horizon: { ms: 1000 } });
    await bus.flush();

    expect(await good).toEqual({ ok: true, value: 42 });
    expect(await bad).toEqual({ ok: false, reason: "refused" });
  });

  test("an unanswered request times out at its ms", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const b1 = bus.body("c1");
    await bus.flush();
    decide.on(b1.bus).handle(() => new Promise<never>(() => {}));

    const pending = decide.on(shell.bus).ask({ q: "?" }, { card: "c1", horizon: { ms: 20 } });
    await bus.flush();

    expect(await pending).toEqual({ ok: false, reason: "timeout" });
  });

  test("a request held for a card that never attaches times out at its ms", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    await bus.flush();

    const pending = decide.on(shell.bus).ask({ q: "?" }, { card: "never", horizon: { ms: 20 } });
    await sleep(30);

    expect(await pending).toEqual({ ok: false, reason: "timeout" });
    expect(shell.bus.census().queued).toEqual({}); // taken back out of the hold
  });

  test("a fail request resolves detached when its card detaches", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const b1 = bus.body("c1");
    await bus.flush();
    decide.on(b1.bus).handle(() => new Promise<never>(() => {}));

    const pending = decide.on(shell.bus).ask({ q: "?" }, { card: "c1", horizon: { person: "the close sheet in the card" } });
    await bus.flush();
    bus.detach("c1");

    expect(await pending).toEqual({ ok: false, reason: "detached" });
  });

  test("a redeliver request goes again to the card's next page, which answers it", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const first = bus.body("c1");
    await bus.flush();
    ask.on(first.bus).handle(() => new Promise<never>(() => {}));

    const pending = ask.on(shell.bus).ask({ q: "which?" }, { card: "c1", horizon: { person: "the ask dialog in the Session card" } });
    await bus.flush();
    bus.detach("c1");
    bus.leave(first);
    const reloaded = bus.body("c1");
    ask.on(reloaded.bus).handle((p) => ({ a: `again: ${p.q}` }));
    await bus.flush();

    expect(await pending).toEqual({ ok: true, value: { a: "again: which?" } });
  });

  test("a withdrawn request resolves withdrawn, and the owner's signal aborts", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const b1 = bus.body("c1");
    await bus.flush();
    let aborted = false;
    ask.on(b1.bus).handle((_p, _from, signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise<never>(() => {});
    });

    const pending = ask.on(shell.bus).ask({ q: "?" }, { card: "c1", horizon: { person: "the ask dialog" } });
    await bus.flush();
    ask.on(shell.bus).withdraw(pending.requestId);
    await bus.flush();

    expect(await pending).toEqual({ ok: false, reason: "withdrawn" });
    expect(aborted).toBe(true);
  });

  test("a reply to a request no longer pending is logged and dropped", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const b1 = bus.body("c1");
    await bus.flush();

    b1.bus.post({ to: "shell", kind: "reply", key: "test.request.decide", requestId: "gone", payload: { ok: true, value: { a: "late" } } });
    await bus.flush();

    expect(shell.log.some((l) => l.message.includes("no longer pending"))).toBe(true);
  });
});
