/**
 * The description ladder is pure and total, so it is a table: what the stores
 * know in, the line the row shows out.
 *
 * The property the whole file exists for is the last test: no combination of
 * inputs produces an empty line. The ladder reached the empty string twice —
 * once for a wheel-seated stage session, whose only submission is a
 * `/tugplug:arc-…` command neither of the top two rungs reads, and once for
 * any session between its spawn and its first ledger push — and a blank line
 * holds its place in the row, so both read as a component that failed to draw.
 */

import { describe, expect, test } from "bun:test";

import {
  UNDESCRIBED,
  sessionDescription,
} from "@/components/tugways/session-identity-row";
import {
  arcTrackModel,
  type ArcTrackModel,
} from "@/components/tugways/tug-arc-track";

/** Nothing known: the input that used to yield the empty string. */
const NOTHING = {
  synopsis: null,
  prompt: "",
  arc: null,
  createdAtMs: null,
} as const;

const devising: ArcTrackModel = arcTrackModel({
  documents: { brief: "/b" },
  arc: { stage: "devise" },
  arcKind: "planned",
  stage: "working",
});

describe("the description ladder", () => {
  test("a written synopsis wins outright", () => {
    expect(
      sessionDescription({
        ...NOTHING,
        synopsis: "Tracing the masthead's blank line",
        prompt: "why is it blank",
        arc: devising,
        createdAtMs: 1_700_000_000_000,
      }),
    ).toBe("Tracing the masthead's blank line");
  });

  test("the session's own ask stands in for a synopsis nobody wrote", () => {
    expect(
      sessionDescription({
        ...NOTHING,
        prompt: "why is it blank",
        arc: devising,
        createdAtMs: 1_700_000_000_000,
      }),
    ).toBe("why is it blank");
  });

  // The rung that closes the wheel's hole, and the reason it sits third: a
  // person who bound a session to an arc by hand has an ask of their own, and
  // what they said outranks what the stage is named for.
  test("the arc's purpose stands in when the session was never asked anything", () => {
    expect(
      sessionDescription({ ...NOTHING, arc: devising, createdAtMs: 1_700_000_000_000 }),
    ).toBe("Devising a plan");
  });

  test("the creation date is the last fact before the floor", () => {
    const line = sessionDescription({ ...NOTHING, createdAtMs: 1_700_000_000_000 });
    expect(line.startsWith("Created ")).toBe(true);
  });

  test("nothing known reads as nothing known, not as nothing", () => {
    expect(sessionDescription(NOTHING)).toBe(UNDESCRIBED);
    expect(UNDESCRIBED.length).toBeGreaterThan(0);
  });

  // The property, over every shape of the four inputs. A rung added above the
  // floor cannot break it; a rung that returns "" for some input will.
  test("no input yields an empty line", () => {
    const synopses = [null, "a synopsis"];
    const prompts = ["", "an ask"];
    const arcs = [null, devising];
    const dates = [null, 1_700_000_000_000];
    for (const synopsis of synopses) {
      for (const prompt of prompts) {
        for (const arc of arcs) {
          for (const createdAtMs of dates) {
            const line = sessionDescription({ synopsis, prompt, arc, createdAtMs });
            expect(line.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});
