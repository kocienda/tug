/**
 * resting-line — unit tests for the two readings a quiet session gets.
 *
 * The stamp's exact string is locale- and timezone-dependent, so what is
 * pinned here is the SHAPE: which reading each input produces, that a real
 * beat is never rewritten, that the day is always in the stamp, and that the
 * sentence around it says `at` exactly once.
 */

import { describe, expect, test } from "bun:test";

import {
  completedRestingLine,
  completedWithIntentRestingLine,
  createdRestingLine,
  formatRestingStamp,
  restingActivityText,
  TURN_DONE_MARKER,
} from "../resting-line";

const TODAY = new Date(2026, 6, 30, 19, 15).getTime();
const EARLIER_TODAY = new Date(2026, 6, 30, 9, 3).getTime();
const LAST_MONTH = new Date(2026, 5, 17, 6, 11).getTime();

describe("formatRestingStamp", () => {
  test("carries the day AND the clock", () => {
    const stamp = formatRestingStamp(LAST_MONTH);
    expect(stamp).toContain(
      new Date(LAST_MONTH).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
    );
    expect(stamp).toContain(
      new Date(LAST_MONTH).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  });

  test("a timestamp from today keeps its day like any other", () => {
    // No same-day shortening: a rail of resting rows is read by comparing the
    // rows to each other, and one row that dropped its day is the one whose
    // day the reader has to infer.
    expect(formatRestingStamp(EARLIER_TODAY)).toContain(
      new Date(EARLIER_TODAY).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
    );
  });

  test("two different days never read the same", () => {
    expect(formatRestingStamp(LAST_MONTH)).not.toBe(
      formatRestingStamp(new Date(2026, 6, 30, 6, 11).getTime()),
    );
  });

  test("joins the day and the clock itself, so the sentence says `at` once", () => {
    // One `toLocaleString` for both writes its own connective (`Jun 17 at
    // 6:11 AM`), which lands inside this sentence as `Created at … at …`.
    expect(createdRestingLine(LAST_MONTH).match(/\bat\b/g)?.length).toBe(1);
    expect(completedRestingLine(TODAY).match(/\bat\b/g)?.length).toBe(1);
  });
});

describe("the two resting readings", () => {
  test("a finished turn is stamped and closes on Ready", () => {
    const line = completedRestingLine(EARLIER_TODAY);
    expect(line.startsWith("Completed at ")).toBe(true);
    expect(line.endsWith(". Ready.")).toBe(true);
    expect(line).toContain(formatRestingStamp(EARLIER_TODAY));
  });

  test("a session that never spoke is stamped from its creation", () => {
    const line = createdRestingLine(LAST_MONTH);
    expect(line.startsWith("Created at ")).toBe(true);
    expect(line.endsWith(". Ready.")).toBe(true);
    expect(line).toContain(formatRestingStamp(LAST_MONTH));
  });

  test("an unknown creation time still says what the state is", () => {
    // The window before the ledger answers: the row is ready, and honest
    // about not being able to stamp it.
    expect(createdRestingLine(null)).toBe("Ready.");
  });
});

describe("restingActivityText — which lines get rewritten", () => {
  test("no beat at all reads as the created line", () => {
    expect(restingActivityText(null, LAST_MONTH)).toBe(
      createdRestingLine(LAST_MONTH),
    );
  });

  test("the turn-end marker reads as the completed line, stamped by the beat", () => {
    expect(
      restingActivityText(
        { text: TURN_DONE_MARKER, atMs: EARLIER_TODAY },
        LAST_MONTH,
      ),
    ).toBe(completedRestingLine(EARLIER_TODAY));
  });

  test("the completion is stamped by the BEAT, never by the session", () => {
    expect(
      restingActivityText(
        { text: TURN_DONE_MARKER, atMs: EARLIER_TODAY },
        LAST_MONTH,
      ),
    ).not.toContain(formatRestingStamp(LAST_MONTH));
  });

  test("anything the voice actually said passes through untouched", () => {
    for (const text of [
      "Reading src/main.tsx",
      "Stopped",
      "Compacted context (was 142k)",
      "Done deal",
    ]) {
      expect(restingActivityText({ text, atMs: EARLIER_TODAY }, LAST_MONTH)).toBe(
        text,
      );
    }
  });
});

describe("completedWithIntentRestingLine — what the wall says at rest", () => {
  const INTENT = "Folding the transcript and the composer on one clock";

  test("names what was finished, then when, then the state", () => {
    const line = completedWithIntentRestingLine(INTENT, EARLIER_TODAY);
    expect(line).toBe(`Finished: ${INTENT}. ${completedRestingLine(EARLIER_TODAY)}`);
    expect(line.startsWith("Finished: ")).toBe(true);
    expect(line.endsWith(". Ready.")).toBe(true);
    expect(line).toContain(formatRestingStamp(EARLIER_TODAY));
  });

  test("still says `at` exactly once", () => {
    // The intent is prose the assistant wrote and could say anything; the
    // sentence AROUND it is what this pins. A fixture with no `at` in it
    // keeps the count a fact about the frame rather than about the text.
    expect(
      completedWithIntentRestingLine("Rewiring the reducer", TODAY).match(/\bat\b/g)
        ?.length,
    ).toBe(1);
  });

  test("the marker with an intent reads as the finished line", () => {
    expect(
      restingActivityText(
        { text: TURN_DONE_MARKER, atMs: EARLIER_TODAY, intent: INTENT },
        LAST_MONTH,
      ),
    ).toBe(completedWithIntentRestingLine(INTENT, EARLIER_TODAY));
  });

  test("the marker WITHOUT one keeps the plain completed line", () => {
    // The one-line register's reading, and the reading every session that
    // never narrated a substantive thought gets. An empty intent is the same
    // absence spelled differently and must not produce `Finished: . `.
    expect(
      restingActivityText({ text: TURN_DONE_MARKER, atMs: EARLIER_TODAY }, LAST_MONTH),
    ).toBe(completedRestingLine(EARLIER_TODAY));
    expect(
      restingActivityText(
        { text: TURN_DONE_MARKER, atMs: EARLIER_TODAY, intent: "" },
        LAST_MONTH,
      ),
    ).toBe(completedRestingLine(EARLIER_TODAY));
  });

  test("an intent on a line that is NOT the marker changes nothing", () => {
    // `Stopped` carries the intent too — the voice puts it on both markers
    // and the deck decides which one rests. A cancelled turn keeps its
    // marker on the line, so nothing here rewrites it.
    expect(
      restingActivityText(
        { text: "Stopped", atMs: EARLIER_TODAY, intent: INTENT },
        LAST_MONTH,
      ),
    ).toBe("Stopped");
  });
});
