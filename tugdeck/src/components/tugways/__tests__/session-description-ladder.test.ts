/**
 * The row's two ladders are pure, so each is a table: what the stores know
 * in, the line the row shows out.
 *
 * The property the description ladder's block exists for is its last test:
 * no combination of inputs produces an empty line. The ladder reached the
 * empty string twice — once for a wheel-seated stage session, whose only
 * submission is a `/tugplug:arc-…` command neither of the top two rungs
 * reads, and once for any session between its spawn and its first ledger
 * push — and a blank line holds its place in the row, so both read as a
 * component that failed to draw.
 *
 * The activity ladder's block pins the ORDER, and one absence. During a turn
 * the account run is the Observer's post, whole, else the turn's ask, and
 * neither outranks a caller's override or the compaction pin; at rest it is
 * the rest sentence, and a post that is still in the store is not shown. The
 * beat has no rung — the digest's newest line is a reader's fact on the
 * history popover and the copy menu, not on the masthead.
 *
 * The description ladder's own live-turn rung is the current line, and it is
 * a written sentence rather than [D187]'s retired post lede: the standing
 * sentence below it still holds through a turn, which is what makes it the
 * line a wall of sessions is scanned by, and the rung on top of it says what
 * the turn in front of the reader is on ([B03]).
 */

import { describe, expect, test } from "bun:test";

import {
  UNDESCRIBED,
  sessionActivity,
  sessionDescription,
} from "@/components/tugways/session-identity-row";
import {
  arcTrackModel,
  type ArcTrackModel,
} from "@/components/tugways/tug-arc-track";

/** Nothing known: the input that used to yield the empty string. */
const NOTHING = {
  current: null,
  ask: null,
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
  // The currency rung ([B03]). It is the top of the ladder while a turn is in
  // flight, and the surface decides whether to take it at all — the caller
  // passes null where it wants identity, which is the picker's whole story.
  test("the current line wins while a turn is in flight", () => {
    expect(
      sessionDescription({
        ...NOTHING,
        current: "Chase the wedge in the download resume path",
        synopsis: "Rework how a session names itself",
        prompt: "why is it blank",
        arc: devising,
        createdAtMs: 1_700_000_000_000,
      }),
    ).toBe("Chase the wedge in the download resume path");
  });

  // The two sentences want opposite cadences and this is where that shows:
  // with no current line the synopsis answers unchanged, which is the picker
  // at any time and every surface at rest.
  test("with no current line the standing sentence answers", () => {
    expect(
      sessionDescription({
        ...NOTHING,
        synopsis: "Rework how a session names itself",
        prompt: "why is it blank",
      }),
    ).toBe("Rework how a session names itself");
  });

  // The floor ([B08]). In the seconds before the Observer's first line — and
  // whenever it declines, or is switched off — the turn's own ask stands in,
  // so the line under a working session's name is never about the last turn.
  test("the turn's ask stands in until a current line lands", () => {
    expect(
      sessionDescription({
        ...NOTHING,
        ask: "why does the resume path wedge",
        synopsis: "Rework how a session names itself",
        prompt: "an older ask",
        arc: devising,
        createdAtMs: 1_700_000_000_000,
      }),
    ).toBe("why does the resume path wedge");
  });

  // And it IS a floor: a written line outranks it the instant one exists.
  test("a current line outranks the ask", () => {
    expect(
      sessionDescription({
        ...NOTHING,
        current: "Chase the wedge in the download resume path",
        ask: "why does the resume path wedge",
      }),
    ).toBe("Chase the wedge in the download resume path");
  });

  // At turn end both live rungs are null and the through-line answers — the
  // identity line a wall of sessions is scanned by, unchanged by any of this.
  test("at turn end the standing sentence answers again", () => {
    expect(
      sessionDescription({
        ...NOTHING,
        synopsis: "Rework how a session names itself",
        prompt: "why does the resume path wedge",
      }),
    ).toBe("Rework how a session names itself");
  });

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
    const currents = [null, "a current line"];
    const asks = [null, "an ask in flight"];
    const synopses = [null, "a synopsis"];
    const prompts = ["", "an ask"];
    const arcs = [null, devising];
    const dates = [null, 1_700_000_000_000];
    for (const current of currents) {
      for (const ask of asks) {
        for (const synopsis of synopses) {
          for (const prompt of prompts) {
            for (const arc of arcs) {
              for (const createdAtMs of dates) {
                const line = sessionDescription({
                  current,
                  ask,
                  synopsis,
                  prompt,
                  arc,
                  createdAtMs,
                });
                expect(line.length).toBeGreaterThan(0);
              }
            }
          }
        }
      }
    }
  });
});

/**
 * The activity ladder's table. `AT_REST` is the session with nothing going
 * on; each test moves one or two inputs and reads which rung answers.
 */
const AT_REST = {
  override: null,
  compacting: false,
  turnInFlight: false,
  post: null,
  ask: null,
  joinReadyLine: null,
  restLine: "1 turn, 1.1 MB. Last updated: Sep 12, 11:42 PM. Ready.",
} as const;

const POST =
  "Landed the leading floor and re-pinned the three fold tests. Next is the mention rule for a sha in the description line.";

describe("the activity ladder", () => {
  test("at rest the line is the rest sentence", () => {
    expect(sessionActivity(AT_REST)).toEqual({
      rung: "rest",
      text: AT_REST.restLine,
    });
  });

  // The post is shown WHOLE: the masthead's two lines and the Overview's post
  // are the same text whenever the post fits, and the lede rule that cut a
  // two-sentence post to its first is retired.
  test("during a turn the newest post is the line, entire", () => {
    expect(
      sessionActivity({ ...AT_REST, turnInFlight: true, post: POST, ask: "fix the fold" }),
    ).toEqual({ rung: "post", body: POST });
  });

  // With a 60 s sitrep the first post of a turn lands no sooner than a minute
  // in, and for that minute the ask is the one line that cannot be wrong.
  test("the ask stands in until the first post lands", () => {
    expect(
      sessionActivity({ ...AT_REST, turnInFlight: true, ask: "fix the fold" }),
    ).toEqual({ rung: "ask", text: "fix the fold" });
  });

  test("a turn with neither post nor ask yet reads the rest sentence", () => {
    expect(sessionActivity({ ...AT_REST, turnInFlight: true })).toEqual({
      rung: "rest",
      text: AT_REST.restLine,
    });
  });

  // The Overview holds the last post; the masthead at rest says the session
  // is idle and since when. A post left in the store is not a turn.
  test("at rest a post in the store is not shown", () => {
    expect(
      sessionActivity({ ...AT_REST, post: POST, ask: "fix the fold" }),
    ).toEqual({ rung: "rest", text: AT_REST.restLine });
  });

  test("the compaction pin outranks the post", () => {
    expect(
      sessionActivity({ ...AT_REST, turnInFlight: true, post: POST, compacting: true }),
    ).toEqual({ rung: "compacting" });
  });

  test("a caller's override outranks everything", () => {
    expect(
      sessionActivity({
        ...AT_REST,
        turnInFlight: true,
        post: POST,
        compacting: true,
        override: "Held by a terminal",
      }),
    ).toEqual({ rung: "override", text: "Held by a terminal" });
  });

  test("an empty override is no override", () => {
    expect(sessionActivity({ ...AT_REST, override: "" })).toEqual({
      rung: "rest",
      text: AT_REST.restLine,
    });
  });

  // A rest-form rung: an arc finished with an offer standing is at rest for
  // one reason, and that reason is the reader.
  test("the join-ready sentence outranks the rest sentence at rest", () => {
    expect(
      sessionActivity({ ...AT_REST, joinReadyLine: "Ready to join." }),
    ).toEqual({ rung: "join-ready", text: "Ready to join." });
  });
});
