/**
 * Pins the union `App.dumpReach()` folds a test file's dumps with.
 *
 * @covers tests/app-test/_harness/reach-map.ts
 */
import { test, expect } from "bun:test";

import { unionReachMaps, type ReachMap } from "./reach-map";

const A: ReachMap = {
  "tugdeck/src/a.ts": { n: 3, hit: ["beta", "alpha"] },
  "tugdeck/src/only-a.ts": { n: 2, hit: ["gamma"] },
};
const B: ReachMap = {
  "tugdeck/src/a.ts": { n: 4, hit: ["alpha", "delta"] },
  "tugdeck/src/only-b.ts": { n: 1, hit: [] },
};

test("n is the larger and hit the union, per module", () => {
  expect(unionReachMaps(A, B)["tugdeck/src/a.ts"]).toEqual({ n: 4, hit: ["alpha", "beta", "delta"] });
});

test("a module present on one side only is carried through", () => {
  const u = unionReachMaps(A, B);
  expect(u["tugdeck/src/only-a.ts"]).toEqual({ n: 2, hit: ["gamma"] });
  expect(u["tugdeck/src/only-b.ts"]).toEqual({ n: 1, hit: [] });
});

test("the union of a map with itself is itself", () => {
  const sorted = unionReachMaps(A, {});
  expect(unionReachMaps(sorted, sorted)).toEqual(sorted);
  expect(Object.keys(unionReachMaps(A, A)).sort()).toEqual(Object.keys(A).sort());
});
