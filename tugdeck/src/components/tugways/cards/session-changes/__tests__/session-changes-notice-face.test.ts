/**
 * The Changes shade's notice band renders one notice ([P05]), and this is the
 * part of that rule which can be wrong: two live tenants racing for the seat.
 * The ranker is pure over the candidate list precisely so the order is provable
 * without a DOM — the band's rendering is an app-test's subject.
 */

import { describe, expect, test } from "bun:test";

import {
  SHADE_NOTICE_RANK,
  rankShadeNotices,
  shadeOriginReplay,
  type ShadeNoticeCandidate,
} from "../session-changes-notice-face";

/** A candidate with everything but the two fields a given case is about. */
function candidate(
  rank: number,
  key: string,
  extra: Partial<ShadeNoticeCandidate> = {},
): ShadeNoticeCandidate {
  return {
    rank,
    key,
    channel: "error",
    tone: "danger",
    title: key,
    description: null,
    detail: null,
    act: "none",
    ...extra,
  };
}

describe("rankShadeNotices", () => {
  test("a landing error outranks a landing refusal", () => {
    const face = rankShadeNotices([
      candidate(SHADE_NOTICE_RANK.landingRefusal, "refusal"),
      candidate(SHADE_NOTICE_RANK.landingError, "error"),
    ]);
    expect(face?.key).toBe("error");
  });

  test("a landing refusal outranks a verb refusal", () => {
    const face = rankShadeNotices([
      candidate(SHADE_NOTICE_RANK.verbError, "claim"),
      candidate(SHADE_NOTICE_RANK.landingRefusal, "refusal"),
    ]);
    expect(face?.key).toBe("refusal");
  });

  test("a verb refusal outranks a replay outcome", () => {
    const face = rankShadeNotices([
      candidate(SHADE_NOTICE_RANK.replayOutcome, "replayed"),
      candidate(SHADE_NOTICE_RANK.verbError, "discard"),
    ]);
    expect(face?.key).toBe("discard");
  });

  test("an empty candidate list yields nothing", () => {
    expect(rankShadeNotices([])).toBeNull();
  });

  test("two verb refusals rank most-recently-changed first", () => {
    const face = rankShadeNotices([
      candidate(SHADE_NOTICE_RANK.verbError, "claim", { seq: 3 }),
      candidate(SHADE_NOTICE_RANK.verbError, "discard", { seq: 7 }),
    ]);
    expect(face?.key).toBe("discard");
  });

  test("candidates carrying no recency keep the caller's order", () => {
    const face = rankShadeNotices([
      candidate(SHADE_NOTICE_RANK.verbError, "first"),
      candidate(SHADE_NOTICE_RANK.verbError, "second"),
    ]);
    expect(face?.key).toBe("first");
  });

  test("one candidate is its own winner, whatever its rank", () => {
    const face = rankShadeNotices([candidate(SHADE_NOTICE_RANK.replayOutcome, "alone")]);
    expect(face?.key).toBe("alone");
  });

  // The shade's four verbs all sit at `verbError`, which makes recency the only
  // thing separating them — and a landing still outranks every one of them,
  // because a landing is the gesture the shade exists for.
  test("a claim refusal and a discard refusal rank by recency", () => {
    const claimFirst = rankShadeNotices([
      candidate(SHADE_NOTICE_RANK.verbError, "Claim failed", { seq: 4 }),
      candidate(SHADE_NOTICE_RANK.verbError, "Discard failed", { seq: 2 }),
    ]);
    expect(claimFirst?.key).toBe("Claim failed");

    // The same pair with the presses the other way round, and nothing else
    // changed: the list order is not what decides.
    const discardFirst = rankShadeNotices([
      candidate(SHADE_NOTICE_RANK.verbError, "Claim failed", { seq: 2 }),
      candidate(SHADE_NOTICE_RANK.verbError, "Discard failed", { seq: 4 }),
    ]);
    expect(discardFirst?.key).toBe("Discard failed");
  });

  test("a landing error outranks the newest verb refusal", () => {
    const face = rankShadeNotices([
      candidate(SHADE_NOTICE_RANK.verbError, "Auto-Message failed", { seq: 99 }),
      candidate(SHADE_NOTICE_RANK.landingError, "commit-error"),
    ]);
    expect(face?.key).toBe("commit-error");
  });

  // A replay's answer is the one tenant that can be good news, and it still
  // yields to everything: a refusal is something the user is waiting on.
  test("a replay success ranks below every refusal", () => {
    const success = candidate(SHADE_NOTICE_RANK.replayOutcome, "replayed", {
      channel: "replay",
      tone: "success",
      seq: 50,
    });
    for (const rival of [
      candidate(SHADE_NOTICE_RANK.landingError, "commit-error"),
      candidate(SHADE_NOTICE_RANK.landingRefusal, "join-refusal"),
      candidate(SHADE_NOTICE_RANK.verbError, "Claim failed", { seq: 1 }),
    ]) {
      expect(rankShadeNotices([success, rival])?.key).toBe(rival.key);
    }
  });
});

describe("shadeOriginReplay", () => {
  test("an outcome stamped with this shade's entry is the shade's", () => {
    const outcome = { entryKey: "session:s1", arc: "lane" };
    expect(shadeOriginReplay(outcome, "session:s1")).toBe(outcome);
  });

  test("an Arcs-card press yields no candidate for the shade", () => {
    // The mistake this guards is not a typo: the Arcs card and the shade read
    // one slot, and the shade is very often presented when an Arcs-card press
    // answers. Presented state is a coincidence; the stamp is the origin.
    expect(shadeOriginReplay({ entryKey: "arcs-card" }, "session:s1")).toBeNull();
  });

  test("an empty slot yields nothing", () => {
    expect(shadeOriginReplay(null, "session:s1")).toBeNull();
  });
});
