/**
 * A pass that finds what the last one found re-renders nothing.
 *
 * The commit, file and session portals publish their mount list only when it
 * changed, by one equality: the same hosts, in the same order, carrying the
 * same facts. A false "changed" re-renders every tip on every annotator pass;
 * a false "same" leaves a tip drawing a stale fact. This pins both edges.
 */

import { describe, test, expect } from "bun:test";

import { sameMounts } from "@/components/tugways/use-span-portals";

const hostA = {} as HTMLElement;
const hostB = {} as HTMLElement;

describe("sameMounts", () => {
  test("the same hosts with the same facts are the same", () => {
    expect(
      sameMounts(
        [{ host: hostA, sha: "abc", worded: false }],
        [{ host: hostA, sha: "abc", worded: false }],
      ),
    ).toBe(true);
  });

  test("two empty passes are the same", () => {
    expect(sameMounts([], [])).toBe(true);
  });

  test("a different count is a change", () => {
    expect(
      sameMounts([{ host: hostA, path: "/a" }], []),
    ).toBe(false);
  });

  test("another host is a change", () => {
    expect(
      sameMounts([{ host: hostA, path: "/a" }], [{ host: hostB, path: "/a" }]),
    ).toBe(false);
  });

  test("the same hosts in another order are a change", () => {
    expect(
      sameMounts(
        [{ host: hostA, path: "/a" }, { host: hostB, path: "/b" }],
        [{ host: hostB, path: "/b" }, { host: hostA, path: "/a" }],
      ),
    ).toBe(false);
  });

  test("a changed fact on the same host is a change", () => {
    expect(
      sameMounts(
        [{ host: hostA, sha: "abc", worded: false }],
        [{ host: hostA, sha: "abc", worded: true }],
      ),
    ).toBe(false);
  });
});
