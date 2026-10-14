/**
 * The one function every `BodyApp` request passes through: it names the
 * card and changes nothing else, and it refuses a request that already
 * names another card rather than choosing between them.
 *
 * @covers tests/app-test/_harness/scope-to-card.ts
 */
import { test, expect } from "bun:test";

import { scopeToCard } from "./scope-to-card";

test("adds the card and keeps every other field", () => {
  const params = { script: "1 + 1", timeoutMs: 400, viewportPoint: { x: 3, y: 4 } };
  expect(scopeToCard(params, "c1")).toEqual({
    script: "1 + 1",
    timeoutMs: 400,
    viewportPoint: { x: 3, y: 4 },
    card: "c1",
  });
});

test("leaves the caller's params object as it was", () => {
  const params: Record<string, unknown> = { selector: "#x" };
  scopeToCard(params, "c1");
  expect(params).toEqual({ selector: "#x" });
});

test("a params object already naming the same card is accepted", () => {
  expect(scopeToCard({ card: "c1", text: "hi" }, "c1")).toEqual({ card: "c1", text: "hi" });
});

test("a params object naming a different card is refused", () => {
  expect(() => scopeToCard({ card: "c2" }, "c1")).toThrow(/already name card "c2"/);
});
