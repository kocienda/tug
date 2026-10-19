/**
 * Routed actions between pages: one runs where it is owned, crosses to its
 * owner otherwise, is held for a handler not yet registered, refuses a
 * malformed payload, and never travels body to body.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { obj, str } from "../codec";
import { defineAction } from "../routed-action";
import { createTestBus, type TestBus } from "../test-bus";

let bus: TestBus;
afterEach(() => bus?.dispose());

const toShell = defineAction({ id: "test.action.toShell", owner: "shell", codec: obj({ text: str }) });
const toCard = defineAction({ id: "test.action.toCard", owner: "card", codec: obj({ text: str }) });

describe("routed actions", () => {
  test("a body's dispatch of a shell action runs in the shell, with the sender stamped", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const b1 = bus.body("c1");
    await bus.flush();
    const got: Array<{ text: string; card: string | null }> = [];
    toShell.on(shell.bus).handle((p, from) => got.push({ text: p.text, card: from.cardId }));

    toShell.on(b1.bus).dispatch({ text: "hi" });
    toShell.on(shell.bus).dispatch({ text: "local" });
    await bus.flush();

    expect(got).toEqual([
      { text: "local", card: null },
      { text: "hi", card: "c1" },
    ]);
  });

  test("the shell's dispatch of a card action reaches that card's body, and a body runs its own at once", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const b1 = bus.body("c1");
    const b2 = bus.body("c2");
    await bus.flush();
    const one: string[] = [];
    const two: string[] = [];
    toCard.on(b1.bus).handle((p) => one.push(p.text));
    toCard.on(b2.bus).handle((p) => two.push(p.text));

    toCard.on(shell.bus).dispatch({ text: "for c2" }, { card: "c2" });
    toCard.on(b1.bus).dispatch({ text: "mine" }, { card: "c1" });
    await bus.flush();

    expect(one).toEqual(["mine"]);
    expect(two).toEqual(["for c2"]);
  });

  test("an action that arrives before its handler is handed to the first handler", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const b1 = bus.body("c1");
    await bus.flush();
    toCard.on(shell.bus).dispatch({ text: "early" }, { card: "c1" });
    await bus.flush();

    const got: string[] = [];
    toCard.on(b1.bus).handle((p) => got.push(p.text));

    expect(got).toEqual(["early"]);
  });

  test("the declaration rules: a card action names its card, a body reaches only its own, and only the owner handles", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const b1 = bus.body("c1");
    expect(() => toCard.on(shell.bus).dispatch({ text: "x" })).toThrow();
    expect(() => toCard.on(b1.bus).dispatch({ text: "x" }, { card: "c2" })).toThrow();
    expect(() => toCard.on(shell.bus).handle(() => {})).toThrow();
    expect(() => toShell.on(b1.bus).handle(() => {})).toThrow();
  });

  test("a malformed payload is dropped and logged at the owner", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const b1 = bus.body("c1");
    await bus.flush();
    const got: unknown[] = [];
    toShell.on(shell.bus).handle((p) => got.push(p));

    b1.bus.post({ to: "shell", kind: "action", key: "test.action.toShell", payload: { text: 5 } });
    await bus.flush();

    expect(got).toEqual([]);
    expect(shell.log.some((l) => l.message.includes("test.action.toShell"))).toBe(true);
  });

  test("a card action another body sends is dropped: the shell is the hub", async () => {
    bus = createTestBus();
    bus.shell();
    const b1 = bus.body("c1");
    const b2 = bus.body("c2");
    await bus.flush();
    const got: unknown[] = [];
    toCard.on(b2.bus).handle((p) => got.push(p));

    b1.bus.post({ to: { card: "c2" }, kind: "action", key: "test.action.toCard", payload: { text: "sneak" } });
    await bus.flush();

    expect(got).toEqual([]);
  });
});
