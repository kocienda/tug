/**
 * atom-identity-attrs.test.ts — the one contract every chip renderer spreads.
 *
 * The module is pure by design, precisely so it can be read as data here:
 * two of its four renderers cannot be rendered without a `document` at all,
 * and the attribute spellings are what one serializer reads back off every
 * surface. A drift in either direction — an attribute written that is not
 * read, or read that is not written — is a chip that pastes as prose.
 */

import { describe, expect, test } from "bun:test";

import { atomIdentityAttrs } from "@/lib/atom-identity-attrs";

const ID = "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const DIR = "/Users/k/src/tugtool";

const base = { type: "session", label: "tugtool/syrupy-beam", value: "tugtool/syrupy-beam" };

describe("atomIdentityAttrs", () => {
  test("the three always-present attributes are the atom's own fields", () => {
    expect(atomIdentityAttrs(base)).toEqual({
      "data-atom-type": "session",
      "data-atom-label": "tugtool/syrupy-beam",
      "data-atom-value": "tugtool/syrupy-beam",
    });
  });

  test("a session pair is emitted as two attributes", () => {
    const attrs = atomIdentityAttrs({ ...base, session: { id: ID, projectDir: DIR } });
    expect(attrs["data-atom-session-id"]).toBe(ID);
    expect(attrs["data-atom-session-project-dir"]).toBe(DIR);
  });

  test("an atom with no session emits neither attribute — absent, not empty", () => {
    const attrs = atomIdentityAttrs({ ...base, type: "file", value: "/tmp/a.ts" });
    // `in`, not a truthiness check: a key present with an empty value is what
    // `setAttribute` would turn into a real attribute reading "".
    expect("data-atom-session-id" in attrs).toBe(false);
    expect("data-atom-session-project-dir" in attrs).toBe(false);
  });

  test("half a pair emits neither — a reference is both halves or none", () => {
    // Neither half alone finds a session: a uuid with no dir cannot be looked
    // for in the projects tree, and a dir with no uuid names no session. A
    // reader recovering one attribute would have to invent the other.
    const noDir = atomIdentityAttrs({ ...base, session: { id: ID, projectDir: "" } });
    expect("data-atom-session-id" in noDir).toBe(false);
    expect("data-atom-session-project-dir" in noDir).toBe(false);
    const noId = atomIdentityAttrs({ ...base, session: { id: "", projectDir: DIR } });
    expect("data-atom-session-id" in noId).toBe(false);
    expect("data-atom-session-project-dir" in noId).toBe(false);
  });

  test("the id and the session pair are independent", () => {
    const attrs = atomIdentityAttrs({
      ...base,
      id: "atom-uuid",
      session: { id: ID, projectDir: DIR },
    });
    expect(attrs["data-atom-id"]).toBe("atom-uuid");
    expect(attrs["data-atom-session-id"]).toBe(ID);
  });
});
