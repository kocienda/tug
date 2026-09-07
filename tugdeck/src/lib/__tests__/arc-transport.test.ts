/**
 * `arc-transport` — the two questions a transport control asks, as tables.
 *
 * The face and the actor are pure functions precisely so their whole truth
 * tables can be written down here rather than driven through a rendered row.
 * Every case below is a row of Table T01 or Table T02.
 */

import { describe, expect, it } from "bun:test";

import {
  hasAnyDocument,
  isLiveRun,
  resolveTransportActor,
  transportFace,
  type FollowedCardFacts,
} from "@/lib/arc-transport";
import type { ArcRunState } from "@/lib/changeset-types";

const RUNNING: ArcRunState = { stage: "implement" };
const STOPPED: ArcRunState = { stage: "implement", stopped: "stopped by user" };
const DONE: ArcRunState = { stage: "audit", done: true };

describe("transportFace (Table T01)", () => {
  it("offers Start for an arc with documents and no run", () => {
    for (const boundSession of [null, "sess-1"]) {
      expect(
        transportFace({ arc: null, boundSession, hasDocument: true }),
      ).toBe("start");
    }
  });

  it("offers nothing for an arc with neither a run nor a document", () => {
    // There is no gesture: a row with no documents has nothing to open on.
    for (const boundSession of [null, "sess-1"]) {
      expect(
        transportFace({ arc: null, boundSession, hasDocument: false }),
      ).toBe("none");
    }
  });

  it("offers nothing on a finished arc, whatever else is true", () => {
    // Done outranks every other fact — including a stop, which a terminal
    // record can still be carrying.
    for (const arc of [DONE, { ...DONE, stopped: "stopped by user" }]) {
      for (const boundSession of [null, "sess-1"]) {
        for (const hasDocument of [true, false]) {
          expect(transportFace({ arc, boundSession, hasDocument })).toBe("none");
        }
      }
    }
  });

  it("offers Resume on a stopped arc, held or not", () => {
    // A stop keeps the binding, so the held case is the ordinary one — but an
    // arc whose card closed is still resumable, from another card.
    for (const boundSession of [null, "sess-1"]) {
      for (const hasDocument of [true, false]) {
        expect(
          transportFace({ arc: STOPPED, boundSession, hasDocument }),
        ).toBe("resume");
      }
    }
  });

  it("offers Stop on a live arc", () => {
    expect(
      transportFace({
        arc: RUNNING,
        boundSession: "sess-1",
        hasDocument: true,
      }),
    ).toBe("stop");
  });

  it("still offers Stop on a live arc nobody holds", () => {
    // A state the server should not produce. The honest face is the verb that
    // would end it, refused with the reason on the hover — never a blank cell
    // that reads as "the arc is fine".
    expect(
      transportFace({ arc: RUNNING, boundSession: null, hasDocument: true }),
    ).toBe("stop");
  });
});

const FOLLOWED: FollowedCardFacts = {
  cardId: "card-1",
  tugSessionId: "sess-followed",
  projectDir: "/proj",
  cardName: "cherry-rider",
  runningArc: null,
};

describe("resolveTransportActor (Table T02)", () => {
  it("stops as the card that is running it", () => {
    for (const surface of ["arcs", "popover"] as const) {
      expect(
        resolveTransportActor({
          face: "stop",
          boundSession: "sess-holder",
          surface,
          followed: FOLLOWED,
          projectDir: "/proj",
          arc: "alpha",
        }),
      ).toEqual({
        tugSessionId: "sess-holder",
        projectDir: "/proj",
        reason: null,
      });
    }
  });

  it("refuses a Stop nobody is running", () => {
    expect(
      resolveTransportActor({
        face: "stop",
        boundSession: null,
        surface: "arcs",
        followed: FOLLOWED,
        projectDir: "/proj",
        arc: "alpha",
      }).reason,
    ).toBe("no card is running it");
  });

  it("resumes as the holder when the stop kept a binding", () => {
    expect(
      resolveTransportActor({
        face: "resume",
        boundSession: "sess-holder",
        surface: "arcs",
        followed: FOLLOWED,
        projectDir: "/proj",
        arc: "alpha",
      }).tugSessionId,
    ).toBe("sess-holder");
  });

  it("resumes as the followed card when nothing holds the arc", () => {
    expect(
      resolveTransportActor({
        face: "resume",
        boundSession: null,
        surface: "arcs",
        followed: FOLLOWED,
        projectDir: "/proj",
        arc: "alpha",
      }).tugSessionId,
    ).toBe("sess-followed");
  });

  it("starts as the followed card", () => {
    expect(
      resolveTransportActor({
        face: "start",
        boundSession: null,
        surface: "arcs",
        followed: FOLLOWED,
        projectDir: "/proj",
        arc: "alpha",
      }),
    ).toEqual({
      tugSessionId: "sess-followed",
      projectDir: "/proj",
      reason: null,
    });
  });

  it("refuses a Start with no card to run it on", () => {
    for (const face of ["start", "resume"] as const) {
      expect(
        resolveTransportActor({
          face,
          boundSession: null,
          surface: "arcs",
          followed: null,
          projectDir: "/proj",
          arc: "alpha",
        }).reason,
      ).toBe("no Session card to run it on");
    }
  });

  it("refuses a Start onto a card already running another arc", () => {
    expect(
      resolveTransportActor({
        face: "start",
        boundSession: null,
        surface: "arcs",
        followed: { ...FOLLOWED, runningArc: "beta" },
        projectDir: "/proj",
        arc: "alpha",
      }).reason,
    ).toBe("cherry-rider is running beta");
  });

  it("does not refuse a Start onto a card running this same arc", () => {
    // The re-bind path: naming the arc already seated is a no-op on the
    // server, not a clash.
    expect(
      resolveTransportActor({
        face: "start",
        boundSession: null,
        surface: "arcs",
        followed: { ...FOLLOWED, runningArc: "alpha" },
        projectDir: "/proj",
        arc: "alpha",
      }).reason,
    ).toBeNull();
  });

  it("does not refuse a Start onto a card whose own arc is stopped", () => {
    // `runningArc` is a *live* reading — `isLiveRun` is what builds it — so a
    // card holding a stopped arc reads as free, which is what the server
    // already does when it binds over one.
    const followed: FollowedCardFacts = {
      ...FOLLOWED,
      runningArc: isLiveRun(STOPPED) ? "beta" : null,
    };
    expect(
      resolveTransportActor({
        face: "start",
        boundSession: null,
        surface: "arcs",
        followed,
        projectDir: "/proj",
        arc: "alpha",
      }).reason,
    ).toBeNull();
  });

  it("refuses a Start onto a card in another project", () => {
    expect(
      resolveTransportActor({
        face: "start",
        boundSession: null,
        surface: "arcs",
        followed: { ...FOLLOWED, projectDir: "/elsewhere" },
        projectDir: "/proj",
        arc: "alpha",
      }).reason,
    ).toBe("cherry-rider works another project");
  });

  it("names the clash before the project, when both are true", () => {
    // A card running another arc in another project is refused for the arc:
    // stopping that arc is what the reader has to do first either way, and
    // naming the project would send them at the wrong repair.
    expect(
      resolveTransportActor({
        face: "start",
        boundSession: null,
        surface: "arcs",
        followed: {
          ...FOLLOWED,
          runningArc: "beta",
          projectDir: "/elsewhere",
        },
        projectDir: "/proj",
        arc: "alpha",
      }).reason,
    ).toBe("cherry-rider is running beta");
  });
});

describe("hasAnyDocument", () => {
  it("is true for any one of the three, false for none", () => {
    expect(hasAnyDocument({ brief: "/a/brief.md" })).toBe(true);
    expect(hasAnyDocument({ plan: "/a/plan.md" })).toBe(true);
    expect(hasAnyDocument({ tasks: "/a/tasks.md" })).toBe(true);
    expect(hasAnyDocument({})).toBe(false);
    expect(hasAnyDocument(undefined)).toBe(false);
    // A title with no path is not a document: the path is what exists.
    expect(hasAnyDocument({ brief_title: "A brief" })).toBe(false);
  });
});

describe("isLiveRun", () => {
  it("counts only a run that is neither stopped nor done", () => {
    expect(isLiveRun(RUNNING)).toBe(true);
    expect(isLiveRun(STOPPED)).toBe(false);
    expect(isLiveRun(DONE)).toBe(false);
    expect(isLiveRun(null)).toBe(false);
  });
});
