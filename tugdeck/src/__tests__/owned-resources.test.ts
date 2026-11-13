/**
 * owned-resources — a resource lives exactly as long as its owner.
 */

import { describe, expect, it } from "bun:test";

import { createOwnedResources } from "../lib/owned-resources";

function counter() {
  const counts = { made: 0, released: 0 };
  const make = () => {
    counts.made += 1;
    const n = counts.made;
    return { value: { n }, release: () => (counts.released += 1) };
  };
  return { counts, make };
}

describe("createOwnedResources", () => {
  it("makes a resource once per owner and key, and releases it with the owner", () => {
    const resources = createOwnedResources<object>();
    const owner = {};
    const { counts, make } = counter();
    const key = Symbol("a");

    const first = resources.get(owner, key, make);
    expect(resources.get(owner, key, make)).toBe(first);
    expect(counts).toEqual({ made: 1, released: 0 });

    // Another owner, or another key, is its own resource.
    resources.get({}, key, make);
    resources.get(owner, Symbol("b"), make);
    expect(counts.made).toBe(3);

    resources.release(owner);
    expect(counts.released).toBe(2);
  });

  it("releases at once what is asked of an owner already released", () => {
    const resources = createOwnedResources<object>();
    const owner = {};
    const { counts, make } = counter();
    resources.release(owner);

    resources.get(owner, Symbol("late"), make);
    expect(counts).toEqual({ made: 1, released: 1 });
    // And holds nothing: a second ask makes and releases again.
    resources.get(owner, Symbol("late"), make);
    expect(counts).toEqual({ made: 2, released: 2 });
  });
});
