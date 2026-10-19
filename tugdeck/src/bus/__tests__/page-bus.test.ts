/**
 * The page bus as an exchange between pages: hello and its answer, the
 * per-target hold, detach, reconnect, a reloaded shell, the one parse, and
 * the undeliverable reading, and a throwing handler failing alone — each on
 * `createTestBus()` with the real page bus on every page.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { EnvelopeIn, HelloPayload } from "../envelope";
import { deckFacts } from "../declarations/deck";
import { jotsNewJot } from "../declarations/verbs";
import { num, str } from "../codec";
import { defineAction } from "../routed-action";
import { defineSharedStore } from "../shared-store";
import { _pageBusBinderCountForTest, bindEveryPageBus } from "../page-bus";
import { createTestBus, type TestBus, type TestPage } from "../test-bus";

let bus: TestBus;

afterEach(() => bus?.dispose());

/** Record the payloads a page receives for `kind`/`key`. */
function receiveOn(page: TestPage, kind: "state" | "action", key: string): unknown[] {
  const got: unknown[] = [];
  page.bus.route(kind, key, (d: EnvelopeIn) => got.push(d.payload));
  return got;
}

const fencedTheme = defineSharedStore({ key: "test.fence.theme", owner: "shell", scope: { deck: true }, codec: str, initial: "" });
const fencedNudge = defineAction({ id: "test.fence.nudge", owner: "card", codec: num });

function hellos(): Array<{ from: string; to: string[]; payload: HelloPayload }> {
  return bus
    .frames()
    .filter((f) => f.envelope.kind === "hello")
    .map((f) => ({ from: f.from, to: f.to, payload: f.envelope.payload as HelloPayload }));
}

describe("attach", () => {
  test("a body's hello attaches it at the shell, and the shell's answer attaches the shell at the body", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    await bus.flush(); // the shell boots first: its broadcast finds no body
    const body = bus.body("c1", "session");
    expect(shell.bus.isAttached({ card: "c1" })).toBe(false);
    expect(body.bus.isAttached("shell")).toBe(false);

    await bus.flush();

    expect(shell.bus.isAttached({ card: "c1" })).toBe(true);
    expect([...shell.bus.attachedCards()]).toEqual(["c1"]);
    expect(shell.bus.componentOf("c1")).toBe("session");
    expect(body.bus.isAttached("shell")).toBe(true);
    // The shell's boot broadcast found no body; the body's hello and the shell's answer.
    expect(hellos().map((h) => h.payload)).toEqual([
      { role: "shell" },
      { role: "body", cardId: "c1", componentId: "session" },
      { role: "shell", answer: true },
    ]);
  });

  test("the shell's onAttach hears a card once its held envelopes have gone out", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    await bus.flush();
    const heard: Array<{ card: string; component: string; queued: Record<string, number> }> = [];
    shell.bus.post({ to: { card: "c1" }, kind: "action", key: "t.verb", payload: 1 });
    shell.bus.onAttach((card, component) => heard.push({ card, component, queued: shell.bus.census().queued }));
    const body = bus.body("c1", "text");
    const got = receiveOn(body, "action", "t.verb");

    await bus.flush();

    expect(heard).toEqual([{ card: "c1", component: "text", queued: {} }]);
    expect(got).toEqual([1]);
  });
});

describe("the hold", () => {
  test("an envelope sent to an unattached card is held and delivered after attach, in send order", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    await bus.flush();
    shell.bus.post({ to: { card: "c1" }, kind: "action", key: "t.verb", payload: "first" });
    shell.bus.post({ to: { card: "c1" }, kind: "action", key: "t.verb", payload: "second" });
    expect(shell.bus.census().queued).toEqual({ "card:c1": 2 });

    const body = bus.body("c1");
    const got = receiveOn(body, "action", "t.verb");
    await bus.flush();

    expect(got).toEqual(["first", "second"]);
    expect(shell.bus.census().queued).toEqual({});
  });

  test("two held snapshots of one key deliver only the latter", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    await bus.flush();
    for (const version of [1, 2]) {
      shell.bus.post(
        { to: { card: "c1" }, kind: "state", key: "t.store", card: "c1", version, payload: { v: version } },
        { coalesce: "t.store:c1" },
      );
    }
    expect(shell.bus.census().queued).toEqual({ "card:c1": 1 });

    const body = bus.body("c1");
    const got = receiveOn(body, "state", "t.store");
    await bus.flush();

    expect(got).toEqual([{ v: 2 }]);
  });

  test("a body holds for the shell until the shell's answer", async () => {
    bus = createTestBus();
    const body = bus.body("c1");
    body.bus.post({ to: "shell", kind: "action", key: "t.verb", payload: "early" });
    await bus.flush(); // no shell yet: the hello is undeliverable and the action stays held
    expect(body.bus.census().queued).toEqual({ shell: 1 });

    const shell = bus.shell();
    const got = receiveOn(shell, "action", "t.verb");
    await bus.flush();

    expect(got).toEqual(["early"]);
  });

  test("detach drops held snapshots and keeps held actions; re-attach delivers the actions", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const first = bus.body("c1");
    await bus.flush();

    bus.detach("c1");
    shell.bus.post({ to: { card: "c1" }, kind: "state", key: "t.store", card: "c1", version: 1, payload: "s" }, { coalesce: "t.store:c1" });
    shell.bus.post({ to: { card: "c1" }, kind: "action", key: "t.verb", payload: "a" });
    shell.bus.detach("c1");
    expect(shell.bus.isAttached({ card: "c1" })).toBe(false);
    expect(shell.bus.census().queued).toEqual({ "card:c1": 1 });

    bus.leave(first);
    const reloaded = bus.body("c1");
    const verbs = receiveOn(reloaded, "action", "t.verb");
    const states = receiveOn(reloaded, "state", "t.store");
    await bus.flush();

    expect(verbs).toEqual(["a"]);
    expect(states).toEqual([]);
  });

  test("detach and forget tell the shell's listeners; forget drops everything held", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    await bus.flush();
    const gone: string[] = [];
    shell.bus.onCardGone((cardId, forgotten) => gone.push(`${cardId} ${forgotten ? "forgotten" : "detached"}`));
    shell.bus.onDetach((cardId) => gone.push(`onDetach ${cardId}`));
    shell.bus.post({ to: { card: "c1" }, kind: "action", key: "t.verb", payload: "a" });

    shell.bus.detach("c1");
    shell.bus.forgetCard("c1");

    expect(gone).toEqual(["c1 detached", "onDetach c1", "c1 forgotten", "onDetach c1"]);
    expect(shell.bus.census().queued).toEqual({});
    expect(shell.bus.componentOf("c1")).toBeNull();
  });

  test("a deck broadcast goes only while a body is attached", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    await bus.flush();
    shell.bus.post({ to: "body", kind: "state", key: "t.deck", version: 1, payload: "lost" });
    await bus.flush();
    expect(bus.undeliverable(shell)).toEqual(["body"]); // the boot hello's, and nothing more

    const body = bus.body("c1");
    const got = receiveOn(body, "state", "t.deck");
    await bus.flush();
    shell.bus.post({ to: "body", kind: "state", key: "t.deck", version: 2, payload: "heard" });
    await bus.flush();

    expect(got).toEqual(["heard"]);
  });
});

describe("reconnect and reload", () => {
  test("a reconnect re-sends hello, and the peer answers again", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const body = bus.body("c1");
    await bus.flush();
    const before = hellos().length;

    bus.disconnect(body);
    expect(body.bus.isAttached("shell")).toBe(false);
    body.bus.post({ to: "shell", kind: "action", key: "t.verb", payload: "in the gap" });
    const got = receiveOn(shell, "action", "t.verb");
    bus.reconnect(body);
    await bus.flush();

    expect(hellos().slice(before).map((h) => h.payload)).toEqual([
      { role: "body", cardId: "c1", componentId: "test" },
      { role: "shell", answer: true },
    ]);
    expect(body.bus.isAttached("shell")).toBe(true);
    expect(got).toEqual(["in the gap"]);
  });

  test("a reloaded shell hears every bound body once, and a spare stays silent", async () => {
    bus = createTestBus();
    const old = bus.shell();
    bus.body("c1");
    bus.body("c2");
    const spare = bus.body(null);
    await bus.flush();
    bus.leave(old);
    const before = hellos().length;

    const shell = bus.shell();
    await bus.flush();

    const after = hellos().slice(before);
    expect(after.map((h) => h.payload)).toEqual([
      { role: "shell" },
      { role: "body", cardId: "c1", componentId: "test", answer: true },
      { role: "body", cardId: "c2", componentId: "test", answer: true },
    ]);
    expect(after[0].to).toHaveLength(3); // the broadcast reached the spare too
    expect([...shell.bus.attachedCards()].sort()).toEqual(["c1", "c2"]);
    expect(spare.bus.isAttached("shell")).toBe(true);
  });

  test("a spare announces itself when it learns its card", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const spare = bus.body(null);
    await bus.flush();
    expect(shell.bus.attachedCards().size).toBe(0);

    bus.bind(spare, "c9", "jots");
    await bus.flush();

    expect(shell.bus.isAttached({ card: "c9" })).toBe(true);
    expect(shell.bus.componentOf("c9")).toBe("jots");
  });

  test("a bound spare whose connection reopens is attached by nothing but its card", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const spare = bus.body(null);
    bus.bind(spare, "c9", "jots");
    await bus.flush();
    expect(shell.bus.isAttached({ card: "c9" })).toBe(true);

    // The reopened connection's hello goes out stamped as the spare it
    // loaded as: dropped, and never answered, so no card is attached as it.
    bus.reconnect(spare);
    await bus.flush();
    expect([...shell.bus.attachedCards()]).toEqual(["c9"]);
    expect(shell.log.some((l) => l.message.includes("not yet bound"))).toBe(true);
    const answers = (): number =>
      hellos().filter((h) => h.payload.answer === true && h.to.includes(spare.pageId)).length;
    const answered = answers();

    // Bound again, it says hello as the card, and the shell answers it.
    bus.bind(spare, "c9", "jots");
    await bus.flush();
    expect([...shell.bus.attachedCards()]).toEqual(["c9"]);
    expect(answers()).toBe(answered + 1);
  });
});

describe("one listener", () => {
  test("a frame is parsed once however many subscribers hear it", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const body = bus.body("c1");
    await bus.flush();
    const heard: string[] = [];
    for (const name of ["a", "b", "c"]) {
      const facts = deckFacts.on(body.bus);
      facts.subscribe(() => heard.push(`${name} ${facts.getSnapshot().theme}`));
    }
    const before = body.parses;

    const shellFacts = deckFacts.on(shell.bus);
    shellFacts.set({ ...shellFacts.getSnapshot(), theme: "sloop" });
    await bus.flush();

    expect(body.parses - before).toBe(1);
    expect(heard).toEqual(["a sloop", "b sloop", "c sloop"]);
  });

  test("a key no route names is logged once and dropped", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const body = bus.body("c1");
    await bus.flush();

    shell.bus.post({ to: { card: "c1" }, kind: "action", key: "t.unknown", payload: 1 });
    shell.bus.post({ to: { card: "c1" }, kind: "action", key: "t.unknown", payload: 2 });
    await bus.flush();

    expect(body.log.filter((l) => l.message.includes("action:t.unknown"))).toHaveLength(1);
    expect(body.bus.census().unknownKeys).toEqual(["action:t.unknown"]);
  });
});

describe("undeliverable", () => {
  test("bus_undeliverable is logged against the target, with whether the bus believed it attached", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    await bus.flush();
    bus.body("c1");
    await bus.flush();

    shell.bus.post({ to: { page: "nobody" }, kind: "action", key: "t.unknown", payload: 1 });
    await bus.flush();

    expect(bus.undeliverable(shell)).toEqual(["body", { page: "nobody" }]);
    const line = shell.log.find((l) => l.message === "bus_undeliverable to page:nobody");
    expect(line?.data).toEqual({ to: { page: "nobody" }, believedAttached: false });
    expect(shell.bus.census().undeliverable).toEqual({ body: 1, "page:nobody": 1 });
  });
});

describe("census", () => {
  test("counts frames and bytes by kind and key", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    bus.body("c1", "session");
    await bus.flush();

    shell.bus.post({ to: { card: "c1" }, kind: "action", key: "t.verb", payload: "x" });
    const census = shell.bus.census();

    expect(census.sent["action:t.verb"].frames).toBe(1);
    expect(census.sent["action:t.verb"].bytes).toBeGreaterThan(0);
    expect(census.sent.hello.frames).toBe(2);
    expect(census.attached).toEqual([{ cardId: "c1", componentId: "session", pageId: expect.any(String) }]);
  });
});

describe("a throwing handler fails alone", () => {
  test("a store subscriber that throws starves neither the next subscriber nor an action behind it, and is logged once against the store", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const body = bus.body("c1");
    await bus.flush();

    const ran: string[] = [];
    fencedTheme.on(body.bus).subscribe(() => {
      throw new Error("a subscriber's bug");
    });
    fencedTheme.on(body.bus).subscribe(() => ran.push(`theme ${fencedTheme.on(body.bus).getSnapshot()}`));
    fencedNudge.on(body.bus).handle((n) => ran.push(`nudge ${String(n)}`));

    fencedTheme.on(shell.bus).set("ironclad");
    fencedNudge.on(shell.bus).dispatch(3, { card: "c1" });
    await bus.flush();

    expect(ran).toEqual(["theme ironclad", "nudge 3"]);
    const warnings = body.log.filter((l) => l.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("test.fence.theme");
    expect(String((warnings[0].data as { error: string }).error)).toContain("a subscriber's bug");
  });

  test("a route that throws is logged against its kind and key, and the next frame is still delivered", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const body = bus.body("c1");
    await bus.flush();

    body.bus.route("action", "t.throws", () => {
      throw new Error("a handler's bug");
    });
    const got = receiveOn(body, "action", "t.after");
    shell.bus.post({ to: { card: "c1" }, kind: "action", key: "t.throws", payload: 1 });
    shell.bus.post({ to: { card: "c1" }, kind: "action", key: "t.after", payload: 2 });
    await bus.flush();

    expect(got).toEqual([2]);
    const line = body.log.find((l) => l.message.includes("action:t.throws"));
    if (line === undefined) throw new Error("no log line names action:t.throws");
    expect(line.level).toBe("warn");
    expect((line.data as { from: { pageId: string } }).from.pageId).toBe(shell.pageId);
  });

  test("a hello listener that throws does not keep what was held for the peer from draining", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    await bus.flush();
    shell.bus.onPeerHello(() => {
      throw new Error("a hello listener's bug");
    });
    shell.bus.post({ to: { card: "c1" }, kind: "action", key: "t.held", payload: "x" });
    const body = bus.body("c1");
    const got = receiveOn(body, "action", "t.held");
    await bus.flush();

    expect(got).toEqual(["x"]);
    expect(shell.log.some((l) => l.level === "warn" && l.message.includes("hello from card c1"))).toBe(true);
  });
});

describe("what a forgotten card had held", () => {
  test("a jots.newJot held for a card that is then forgotten is logged as dropped, naming the card and the verb", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    await bus.flush();
    jotsNewJot.on(shell.bus).dispatch({}, { card: "j1" });
    expect(shell.bus.census().queued["card:j1"]).toBe(1);

    shell.bus.forgetCard("j1");

    const line = shell.log.find((l) => l.message.includes("action:jots.newJot"));
    if (line === undefined) throw new Error("no log line names action:jots.newJot");
    expect(line.level).toBe("warn");
    expect(line.message).toContain("j1");
    expect(shell.bus.census().queued["card:j1"]).toBeUndefined();
  });
});

describe("bindEveryPageBus", () => {
  test("its unbind releases what it bound on every live bus, and binds no bus created after", () => {
    bus = createTestBus();
    const shell = bus.shell();
    const before = _pageBusBinderCountForTest();
    const bound: string[] = [];
    const released: string[] = [];
    const unbind = bindEveryPageBus((b) => {
      bound.push(b.pageId);
      return () => released.push(b.pageId);
    });
    const body = bus.body("c1");
    expect(bound).toEqual([shell.pageId, body.pageId]);

    unbind();
    expect(released).toEqual([shell.pageId, body.pageId]);
    expect(_pageBusBinderCountForTest()).toBe(before);
    bus.body("c2");
    expect(bound).toHaveLength(2);
  });
});
