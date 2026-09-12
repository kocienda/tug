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
 *
 * The lede is here too, and for the same reason: it is the one pure function
 * behind the ladder's live rung, so what a two-sentence post shows on the line
 * is a table rather than a row that has to be mounted to be read.
 */

import { describe, expect, test } from "bun:test";

import {
  UNDESCRIBED,
  postLede,
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

/**
 * The post rung's cut: a post is two sentences at the Observer's own budget,
 * and the line shows the first one.
 */
describe("the post's lede", () => {
  test("a two-sentence post shows its first sentence, full stop and all", () => {
    expect(
      postLede(
        "Landed the leading floor and re-pinned the three fold tests. Next is the mention rule for a sha in the description line.",
      ),
    ).toBe("Landed the leading floor and re-pinned the three fold tests.");
  });

  test("a one-sentence post is its own lede", () => {
    const post = "Reading the imposition allocator's ceiling ladder.";
    expect(postLede(post)).toBe(post);
  });

  test("a post with no sentence end at all stands as it is", () => {
    const post = "Reading the imposition allocator and its ceiling ladder";
    expect(postLede(post)).toBe(post);
  });

  // Past the box's own room the cut buys nothing: the line elides either way,
  // so the post stands rather than being shortened to a sentence nobody sees
  // the end of.
  test("a first sentence past the budget leaves the post alone", () => {
    const long = `${"word ".repeat(40)}ends here. And a second sentence.`;
    expect(postLede(long)).toBe(long);
  });

  // The digester's own enumerator rule, which is why the cut is a port rather
  // than a `split(".")`.
  test("an enumerator's dot is not a full stop", () => {
    expect(
      postLede("Walking 1. the ledger and 2. the log. Then the binding."),
    ).toBe("Walking 1. the ledger and 2. the log.");
  });

  // The case that motivated porting the rule at all: a post names files, and
  // an extension's dot has a letter after it rather than a space.
  test("a path's extension is not a sentence end", () => {
    expect(
      postLede(
        "Rewrote docs/narration-target.md and re-ran the column tests. Then the wall.",
      ),
    ).toBe("Rewrote docs/narration-target.md and re-ran the column tests.");
  });

  // A bold span that closes after the terminator belongs to the sentence, and
  // the post rubric puts shas and emphasis in prose freely.
  test("emphasis closing after the terminator belongs to the sentence", () => {
    expect(postLede("It is **done.** Now the audit.")).toBe(
      "It is **done.**",
    );
  });

  test("an empty post is left as it is", () => {
    expect(postLede("")).toBe("");
  });
});
