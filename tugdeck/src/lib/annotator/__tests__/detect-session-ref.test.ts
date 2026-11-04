/**
 * The session-reference grammar, and what it deliberately refuses.
 *
 * Three spellings are scanned — a full uuid, its eight-character short id, and
 * a `project/callsign` pair — and
 * the refusals are the load-bearing half: a bare callsign is shaped like every
 * hyphenated compound in English, and a pair is shaped exactly like a relative
 * path. What keeps the second from painting chips over directory names is the
 * callsign half's own shape here, and the project-half check in the resolver.
 */

import { describe, expect, test } from "bun:test";

import {
  isSessionRef,
  isSessionShortId,
  scanSessionRefs,
} from "@/lib/annotator/detect-session-ref";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("what is a session reference", () => {
  test("a full lowercase uuid is", () => {
    expect(isSessionRef(UUID)).toBe(true);
  });

  test("a uuid's eight-character short id is", () => {
    // The spelling `tugtool session find` takes and a model writes when it
    // names a session in passing. It was refused here once; an Operator
    // reply that ended "that is the cf3328c3 session" left a real session
    // as plain ink, which is why it is a reference now.
    expect(isSessionRef(UUID.slice(0, 8))).toBe(true);
    expect(isSessionShortId(UUID.slice(0, 8))).toBe(true);
  });

  test("a short id is exactly eight lowercase hex with a digit", () => {
    expect(isSessionShortId("cf3328c")).toBe(false);
    expect(isSessionShortId("cf3328c3a")).toBe(false);
    expect(isSessionShortId("CF3328C3")).toBe(false);
    // All-letter hex is an English word as often as an id.
    expect(isSessionShortId("effacebd")).toBe(false);
    // The other spellings are references, but not short ids.
    expect(isSessionShortId(UUID)).toBe(false);
    expect(isSessionShortId("tugtool/kind-floor")).toBe(false);
  });

  test("a uuid that is truncated elsewhere, uppercase, or malformed is not", () => {
    expect(isSessionRef(UUID.slice(0, 13))).toBe(false);
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

  test("finds a short id named in passing", () => {
    const text = "If you mean the drawings, that is the cf3328c3 session instead.";
    const [match] = scanSessionRefs(text);
    expect(match!.target).toBe("cf3328c3");
    expect(text.slice(match!.start, match!.end)).toBe("cf3328c3");
  });

  test("prose with nothing session-shaped yields nothing", () => {
    expect(
      scanSessionRefs("Reworked the imposer and left kind-floor alone."),
    ).toEqual([]);
  });
});
