/**
 * The session-reference grammar, and what it deliberately refuses.
 *
 * Two spellings are scanned — a full uuid and a `project/callsign` pair — and
 * the refusals are the load-bearing half: a bare callsign is shaped like every
 * hyphenated compound in English, and a pair is shaped exactly like a relative
 * path. What keeps the second from painting chips over directory names is the
 * callsign half's own shape here, and the project-half check in the resolver.
 */

import { describe, expect, test } from "bun:test";

import { isSessionRef, scanSessionRefs } from "@/lib/annotator/detect-session-ref";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("what is a session reference", () => {
  test("a full lowercase uuid is", () => {
    expect(isSessionRef(UUID)).toBe(true);
  });

  test("a uuid that is short, uppercase, or malformed is not", () => {
    expect(isSessionRef(UUID.slice(0, 8))).toBe(false);
    expect(isSessionRef(UUID.toUpperCase())).toBe(false);
    expect(isSessionRef(UUID.replace("-", ""))).toBe(false);
  });

  test("a project/callsign pair is", () => {
    expect(isSessionRef("tugtool/kind-floor")).toBe(true);
    expect(isSessionRef("tugtool/quirky-hull")).toBe(true);
  });

  test("a forked session's composed callsign is too", () => {
    // `sessions.tag` holds the COMPOSED callsign for a fork lineage —
    // `<root>-<Letter><Number>`, extending for a fork of a fork. Without
    // these segments a forked session would be undetectable by construction.
    expect(isSessionRef("tugtool/stocky-pixie-A1")).toBe(true);
    expect(isSessionRef("tugtool/stocky-pixie-A1-B2")).toBe(true);
  });

  test("a bare callsign is NOT — it is every hyphenated word in English", () => {
    expect(isSessionRef("kind-floor")).toBe(false);
    expect(isSessionRef("stocky-pixie")).toBe(false);
  });

  test("a relative path is not, because its leaf is not a callsign", () => {
    // One word, so no pair.
    expect(isSessionRef("tugdeck/src")).toBe(false);
    // An extension is not a lineage segment.
    expect(isSessionRef("arc/overview-errata.md")).toBe(false);
    // Two slashes is a path, whatever the last segment looks like.
    expect(isSessionRef("tugdeck/src/kind-floor")).toBe(false);
    // The lineage suffix is capital-then-digits; a third word is not one.
    expect(isSessionRef("tugtool/kind-floor-thing")).toBe(false);
  });

  test("digits in the word halves are not callsign shape", () => {
    expect(isSessionRef("tugtool/kind2-floor")).toBe(false);
    expect(isSessionRef("tugtool/kind-floor2")).toBe(false);
  });
});

describe("scanning prose", () => {
  test("finds a pair mid-sentence at its exact offsets", () => {
    const text = "The session tugtool/kind-floor finished its turn.";
    const [match] = scanSessionRefs(text);
    expect(match).toBeDefined();
    expect(match!.target).toBe("tugtool/kind-floor");
    expect(text.slice(match!.start, match!.end)).toBe("tugtool/kind-floor");
  });

  test("peels wrapping punctuation out of the run", () => {
    const text = `Landed in (tugtool/kind-floor), and in "${UUID}".`;
    const found = scanSessionRefs(text);
    expect(found.map((m) => m.target)).toEqual(["tugtool/kind-floor", UUID]);
    for (const match of found) {
      expect(text.slice(match.start, match.end)).toBe(match.target);
    }
  });

  test("a sentence-ending period is not part of the reference", () => {
    const text = "Forked from tugtool/stocky-pixie-A1.";
    const [match] = scanSessionRefs(text);
    expect(match!.target).toBe("tugtool/stocky-pixie-A1");
  });

  test("prose with nothing session-shaped yields nothing", () => {
    expect(
      scanSessionRefs("Reworked the imposer and left kind-floor alone."),
    ).toEqual([]);
  });
});
