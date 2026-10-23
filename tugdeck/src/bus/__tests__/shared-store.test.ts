/**
 * Shared stores as exchanges between pages on the test bus: a deck store
 * reaching bodies (and a late body's snapshot preceding what was held for
 * it), a card store read in the shell, versions and epochs, the equals gate,
 * write-back with acknowledgement, and a malformed snapshot.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { INVALID, arr, num, obj, opaque, str } from "../codec";
import { defineAction } from "../routed-action";
import { defineSharedStore } from "../shared-store";
import { createTestBus, type TestBus } from "../test-bus";

let bus: TestBus;
afterEach(() => bus?.dispose());

const theme = defineSharedStore({ key: "test.store.theme", owner: "shell", scope: { deck: true }, codec: str, initial: "none" });
const title = defineSharedStore({ key: "test.store.title", owner: "card", scope: { card: true }, codec: str, initial: "" });
const surface = defineSharedStore({
  key: "test.store.surface",
  owner: "card",
  scope: { card: true },
  codec: str,
  initial: "",
  clearOnDetach: true,
});
const gauges = defineSharedStore({
  key: "test.store.gauges",
  owner: "shell",
  scope: { kinds: (component) => component === "cards" },
  codec: arr(num),
  initial: [] as number[],
});
type Selection = { ids: string[] };
const selection = defineSharedStore<Selection, Selection>({
  key: "test.store.selection",
  owner: "shell",
  scope: { card: true },
  codec: obj({ ids: arr(str) }),
  initial: { ids: [] },
  proposals: obj({ ids: arr(str) }),
});
const nudge = defineAction({ id: "test.store.nudge", owner: "card", codec: num });
// Declared in the reverse of the order a peer must hear them, as a reordered import would bind them.
const shownLate = defineSharedStore({
  key: "test.store.shownLate",
  owner: "card",
  scope: { card: true },
  codec: num,
  initial: 0,
  after: [{ kind: "store", key: "test.store.factsFirst" }],
});
const factsFirst = defineSharedStore({ key: "test.store.factsFirst", owner: "card", scope: { card: true }, codec: str, initial: "" });

describe("deck scope", () => {
  test("a shell-owned deck store reaches two bodies; a late body gets the snapshot before anything held for it", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const b1 = bus.body("c1");
    const b2 = bus.body("c2");
    await bus.flush();

    theme.on(shell.bus).set("ironclad");
    await bus.flush();
    expect(theme.on(b1.bus).getSnapshot()).toBe("ironclad");
    expect(theme.on(b2.bus).getSnapshot()).toBe("ironclad");

    const order: string[] = [];
    nudge.on(shell.bus).dispatch(7, { card: "c3" });
    const b3 = bus.body("c3");
    theme.on(b3.bus).subscribe(() => order.push(`theme ${theme.on(b3.bus).getSnapshot()}`));
    nudge.on(b3.bus).handle((n) => order.push(`nudge ${String(n)}`));
    await bus.flush();

    expect(order).toEqual(["theme ironclad", "nudge 7"]);
    expect(theme.on(b3.bus).arrived()).toBe(true);
  });

  test("set with an equal value sends nothing and keeps the version", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    bus.body("c1");
    await bus.flush();
    theme.on(shell.bus).set("sloop");
    await bus.flush();
    const sent = bus.frames().filter((f) => f.envelope.kind === "state").length;

    theme.on(shell.bus).set("sloop");
    await bus.flush();

    expect(bus.frames().filter((f) => f.envelope.kind === "state").length).toBe(sent);
  });

  test("a kinds store goes only to the cards its predicate admits", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const cards = bus.body("c1", "cards");
    const text = bus.body("c2", "text");
    await bus.flush();

    gauges.on(shell.bus).set([1, 2]);
    await bus.flush();

    expect(gauges.on(cards.bus).getSnapshot()).toEqual([1, 2]);
    expect(gauges.on(text.bus).arrived()).toBe(false);
  });
});

describe("card scope", () => {
  test("a body-owned card store is read in the shell by card", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const b1 = bus.body("c1");
    const b2 = bus.body("c2");
    await bus.flush();

    title.on(b1.bus).set("One");
    title.on(b2.bus).set("Two");
    await bus.flush();

    expect(title.on(shell.bus).getFor("c1")).toBe("One");
    expect(title.on(shell.bus).getFor("c2")).toBe("Two");
    expect(title.on(b1.bus).getSnapshot()).toBe("One");
  });

  test("a body's value set before the shell answered reaches the shell on attach", async () => {
    bus = createTestBus();
    const b1 = bus.body("c1");
    title.on(b1.bus).set("Early");
    await bus.flush();
    const shell = bus.shell();
    await bus.flush();
    expect(title.on(shell.bus).getFor("c1")).toBe("Early");
  });

  test("a replica ignores an older version, and takes a lower one from a new epoch", async () => {
    bus = createTestBus();
    const first = bus.shell();
    const b1 = bus.body("c1");
    await bus.flush();
    for (const t of ["a", "b", "c"]) theme.on(first.bus).set(t);
    await bus.flush();
    expect(theme.on(b1.bus).getSnapshot()).toBe("c");

    first.bus.post({ to: "body", kind: "state", key: "test.store.theme", version: 1, payload: "stale" });
    await bus.flush();
    expect(theme.on(b1.bus).getSnapshot()).toBe("c");

    bus.leave(first);
    const reloaded = bus.shell();
    await bus.flush();
    theme.on(reloaded.bus).set("fresh"); // version 1, from a new page
    await bus.flush();
    expect(theme.on(b1.bus).getSnapshot()).toBe("fresh");
  });

  test("a replica does not re-notify on a repeated snapshot", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const b1 = bus.body("c1");
    await bus.flush();
    title.on(b1.bus).set("Same");
    await bus.flush();
    let notified = 0;
    title.on(shell.bus).subscribe(() => notified++);

    bus.reconnect(b1); // the reconnect's hello re-sends every snapshot
    await bus.flush();

    expect(notified).toBe(0);
  });

  test("clearOnDetach drops the replica's value when the shell detaches the card; others keep", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const b1 = bus.body("c1");
    await bus.flush();
    title.on(b1.bus).set("Kept");
    surface.on(b1.bus).set("Dropped");
    await bus.flush();

    bus.detach("c1");

    expect(title.on(shell.bus).getFor("c1")).toBe("Kept");
    expect(surface.on(shell.bus).arrived("c1")).toBe(false);
    shell.bus.forgetCard("c1");
    expect(title.on(shell.bus).arrived("c1")).toBe(false);
  });

  test("forgetting a card's page keeps what the shell owns for it, sent to its next page at hello; forgetting the card drops it", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    bus.body("c1", "cards");
    await bus.flush();
    selection.on(shell.bus).setFor("c1", { ids: ["kept"] });
    await bus.flush();

    bus.detach("c1");
    shell.bus.forgetPage("c1");

    expect(selection.on(shell.bus).getFor("c1")).toEqual({ ids: ["kept"] });
    const next = bus.body("c1", "cards");
    await bus.flush();
    expect(selection.on(next.bus).getSnapshot()).toEqual({ ids: ["kept"] });

    shell.bus.forgetCard("c1");
    expect(selection.on(shell.bus).arrived("c1")).toBe(false);
  });

  test("set on the wrong page throws", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const b1 = bus.body("c1");
    expect(() => theme.on(b1.bus).set("x")).toThrow();
    expect(() => title.on(shell.bus).set("x")).toThrow();
    expect(() => selection.on(shell.bus).set({ ids: [] })).toThrow(); // the shell uses setFor
  });
});

describe("propose", () => {
  async function setUp() {
    bus = createTestBus();
    const shell = bus.shell();
    const body = bus.body("c1", "cards");
    await bus.flush();
    selection.on(shell.bus).setFor("c1", { ids: ["a"] });
    await bus.flush();
    return { shell, body };
  }

  test("applies locally at once, and settles on the owner's value once acknowledged", async () => {
    const { shell, body } = await setUp();
    selection.on(shell.bus).onProposal((patch) => selection.on(shell.bus).setFor("c1", { ids: [...patch.ids, "owner"] }));

    selection.on(body.bus).propose({ ids: ["b"] });
    expect(selection.on(body.bus).getSnapshot()).toEqual({ ids: ["b"] });
    await bus.flush();

    expect(selection.on(body.bus).getSnapshot()).toEqual({ ids: ["b", "owner"] });
  });

  test("a second proposal before the first ack keeps the optimistic view", async () => {
    const { shell, body } = await setUp();
    selection.on(shell.bus).onProposal((patch) => selection.on(shell.bus).setFor("c1", patch));
    const view = selection.on(body.bus);
    const seen: string[][] = [];
    view.subscribe(() => seen.push(view.getSnapshot().ids));

    view.propose({ ids: ["b"] });
    view.propose({ ids: ["c"] });
    await bus.flush();

    // The owner's answer to the first proposal never shows over the second.
    expect(seen).toEqual([["b"], ["c"]]);
    expect(view.getSnapshot()).toEqual({ ids: ["c"] });
  });

  test("a refused proposal is still acknowledged, and the replica reverts", async () => {
    const { shell, body } = await setUp();
    selection.on(shell.bus).onProposal(() => {});

    selection.on(body.bus).propose({ ids: ["refused"] });
    await bus.flush();

    expect(selection.on(body.bus).getSnapshot()).toEqual({ ids: ["a"] });
  });

  test("a proposal made before the shell answered holds through the snapshot the hello sends", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    await bus.flush();
    selection.on(shell.bus).setFor("c1", { ids: ["a"] });
    selection.on(shell.bus).onProposal((patch) => selection.on(shell.bus).setFor("c1", patch));
    const body = bus.body("c1", "cards");
    const view = selection.on(body.bus);
    const seen: string[][] = [];
    view.subscribe(() => seen.push(view.getSnapshot().ids));

    // Proposed in the window before the shell's answer: the snapshot the
    // hello sends is the owner's value from before it, and never shows over it.
    view.propose({ ids: ["b"] });
    await bus.flush();

    expect(seen.filter((ids) => ids[0] === "a")).toEqual([]);
    expect(view.getSnapshot()).toEqual({ ids: ["b"] });
  });

  test("an owner reload with a proposal pending leaves the replica on the new owner's value", async () => {
    const { shell, body } = await setUp();
    // The old shell never answers: it leaves with the proposal in flight.
    selection.on(body.bus).propose({ ids: ["lost"] });
    bus.leave(shell);
    await bus.flush();
    expect(selection.on(body.bus).getSnapshot()).toEqual({ ids: ["lost"] });

    const fresh = bus.shell();
    await bus.flush(); // the body answers the new shell's hello
    selection.on(fresh.bus).setFor("c1", { ids: ["new owner"] });
    await bus.flush();

    expect(selection.on(body.bus).getSnapshot()).toEqual({ ids: ["new owner"] });
  });
});

describe("codecs at the receiver", () => {
  test("a malformed snapshot is dropped and logged, and the store does not change", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const b1 = bus.body("c1");
    await bus.flush();
    theme.on(shell.bus).set("good");
    await bus.flush();

    shell.bus.post({ to: "body", kind: "state", key: "test.store.theme", version: 99, payload: 42 });
    await bus.flush();

    expect(theme.on(b1.bus).getSnapshot()).toBe("good");
    expect(b1.log.some((l) => l.message.includes("test.store.theme") && l.message.includes("refuses"))).toBe(true);
  });

  test("an opaque codec admits what its guard admits", () => {
    const c = opaque((v): v is { x: 1 } => typeof v === "object" && v !== null && (v as { x?: unknown }).x === 1, { x: 1 });
    expect(c.decode({ x: 1 })).toEqual({ x: 1 });
    expect(c.decode({ x: 2 })).toBe(INVALID);
  });
});

describe("only the owner speaks for the value", () => {
  test("a body cannot move a sibling's replica of a shell-owned store, and the refusal is logged", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const b1 = bus.body("c1");
    const b2 = bus.body("c2");
    await bus.flush();
    theme.on(shell.bus).set("ironclad");
    await bus.flush();

    b1.bus.post({ to: { page: b2.pageId }, kind: "state", key: "test.store.theme", version: 99, payload: "forged" });
    await bus.flush();

    expect(theme.on(b2.bus).getSnapshot()).toBe("ironclad");
    expect(b2.log.some((l) => l.level === "warn" && l.message.includes("test.store.theme") && l.message.includes("refused"))).toBe(true);
  });

  test("a body cannot write another card's value in the shell, and the refusal is logged", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const b1 = bus.body("c1");
    const b2 = bus.body("c2");
    await bus.flush();
    title.on(b2.bus).set("Two");
    await bus.flush();

    b1.bus.post({ to: "shell", kind: "state", key: "test.store.title", card: "c2", version: 99, payload: "forged" });
    await bus.flush();

    expect(title.on(shell.bus).getFor("c2")).toBe("Two");
    expect(shell.log.some((l) => l.level === "warn" && l.message.includes("test.store.title") && l.message.includes("refused"))).toBe(true);
  });
});

describe("attach order is declared", () => {
  test("a store bound before another it names in `after` is still snapshotted after it on attach", async () => {
    bus = createTestBus();
    const body = bus.body("c1");
    shownLate.on(body.bus).set(1);
    factsFirst.on(body.bus).set("facts");
    await bus.flush();
    bus.shell();
    await bus.flush();

    const keys = bus
      .frames()
      .filter((f) => f.envelope.kind === "state" && f.from === body.pageId)
      .map((f) => f.envelope.key);
    expect(keys.indexOf("test.store.factsFirst")).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf("test.store.factsFirst")).toBeLessThan(keys.indexOf("test.store.shownLate"));
  });
});

describe("the ack record is exact", () => {
  test("a proposal whose handler publishes only a different card's entry is still acknowledged, and the proposer settles", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const b1 = bus.body("c1", "cards");
    bus.body("c2", "cards");
    await bus.flush();
    selection.on(shell.bus).setFor("c1", { ids: ["a"] });
    await bus.flush();
    // The handler refuses c1's patch, and moves c2 instead.
    selection.on(shell.bus).onProposal(() => selection.on(shell.bus).setFor("c2", { ids: ["other"] }));

    selection.on(b1.bus).propose({ ids: ["x"] });
    expect(selection.on(b1.bus).getSnapshot()).toEqual({ ids: ["x"] });
    await bus.flush();

    expect(selection.on(b1.bus).getSnapshot()).toEqual({ ids: ["a"] });
    expect(selection.on(shell.bus).getFor("c2")).toEqual({ ids: ["other"] });
  });

  test("a replica page that detaches leaves the owner's ack record", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const first = bus.body("c1", "cards");
    await bus.flush();
    selection.on(shell.bus).setFor("c1", { ids: ["a"] });
    selection.on(shell.bus).onProposal((patch) => selection.on(shell.bus).setFor("c1", patch));
    selection.on(first.bus).propose({ ids: ["b"] });
    await bus.flush();

    bus.detach("c1");
    bus.body("c1", "cards");
    await bus.flush();

    const acks = bus
      .frames()
      .filter((f) => f.envelope.kind === "state" && f.envelope.key === "test.store.selection")
      .map((f) => f.envelope.ack ?? {});
    const last = acks[acks.length - 1];
    expect(Object.keys(acks[acks.length - 2] ?? {})).toContain(first.pageId);
    expect(Object.keys(last)).not.toContain(first.pageId);
  });
});
