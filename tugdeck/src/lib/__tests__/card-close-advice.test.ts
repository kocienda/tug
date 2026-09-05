/**
 * card-close-advice.test.ts — the per-card close-advice registry: register,
 * read live, and release ([L27]).
 */

import { describe, test, expect } from "bun:test";
import {
  registerCardCloseAdvice,
  readCardCloseAdvice,
  cardWaivesCloseConfirm,
} from "@/lib/card-close-advice";

describe("card close advice registry", () => {
  test("an unregistered card advises nothing and waives nothing", () => {
    expect(readCardCloseAdvice("w0")).toBeNull();
    expect(cardWaivesCloseConfirm("w0")).toBe(false);
  });

  test("resolves the registered advisor and releases it", () => {
    const release = registerCardCloseAdvice("w1", () => ({ waive: true }));
    expect(cardWaivesCloseConfirm("w1")).toBe(true);

    release();
    expect(readCardCloseAdvice("w1")).toBeNull();
    expect(cardWaivesCloseConfirm("w1")).toBe(false);
  });

  test("carries the card's own popover copy when the confirm stands", () => {
    const release = registerCardCloseAdvice("w2", () => ({
      waive: false,
      message: "Close Card? A thing goes with it.",
    }));
    expect(readCardCloseAdvice("w2")).toEqual({
      waive: false,
      message: "Close Card? A thing goes with it.",
    });
    expect(cardWaivesCloseConfirm("w2")).toBe(false);
    release();
  });

  test("the advisor is asked live, not latched at registration", () => {
    let empty = true;
    const release = registerCardCloseAdvice("w3", () => ({ waive: empty }));
    expect(cardWaivesCloseConfirm("w3")).toBe(true);

    // The card takes on content — the same registration now confirms.
    empty = false;
    expect(cardWaivesCloseConfirm("w3")).toBe(false);

    release();
  });

  test("a re-registration replaces the prior advisor and owns the slot", () => {
    const first = () => ({ waive: true });
    const second = () => ({ waive: false });
    const releaseFirst = registerCardCloseAdvice("w4", first);
    const releaseSecond = registerCardCloseAdvice("w4", second);
    expect(cardWaivesCloseConfirm("w4")).toBe(false);

    // The stale first release must NOT evict the second advisor.
    releaseFirst();
    expect(cardWaivesCloseConfirm("w4")).toBe(false);
    expect(readCardCloseAdvice("w4")).not.toBeNull();

    releaseSecond();
    expect(readCardCloseAdvice("w4")).toBeNull();
  });

  test("advisors for distinct cards are independent", () => {
    const releaseA = registerCardCloseAdvice("wA", () => ({ waive: true }));
    const releaseB = registerCardCloseAdvice("wB", () => ({ waive: false }));
    expect(cardWaivesCloseConfirm("wA")).toBe(true);
    expect(cardWaivesCloseConfirm("wB")).toBe(false);
    releaseA();
    releaseB();
  });
});
