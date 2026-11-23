/**
 * The Docket card's authoring gestures, pure: which a thread offers, the
 * first turn each one opens with, the slug an arc is opened under, and the
 * inbox's order.
 */
import { describe, expect, test } from "bun:test";

import {
  boundaryChoices,
  briefSlug,
  docketProposals,
  gesturesFor,
  isInboxThread,
  isParkedThread,
  isLandedThread,
  landedOrder,
  revertConfirmMessage,
  revisionPending,
  revisionSummary,
  successorName,
  successorFor,
  successorOpening,
  keptVersionRef,
  needsStaleConfirm,
  openingFor,
  parseKeptVersionRef,
  partitionInbox,
  proposalKey,
  staleConfirmMessage,
} from "../docket-authoring";
import type {
  DocketArcFate,
  DocketRevisionCell,
  DocketRevisionOffer,
  DocketThread,
} from "../docket-types";

function thread(over: Partial<DocketThread> & { key?: string }): DocketThread {
  return {
    key: over.key ?? "idea:1a2b3c4d",
    start: over.start ?? "2026-11-20T10:00:00Z",
    sessions: [],
    commits: [],
    filed_keys: [],
    ...over,
  };
}

const IDEA = { id: "1a2b3c4d", text: "An inbox for ideas", filed: true };
const SKETCH = { id: "3f9a1c2e", versions: 2, filed: false };
const SESSION = { uuid: "u-1", filed: false };
const BRIEF = {
  title: "One door",
  source: "sketch" as const,
  source_path: "briefs/one-door-brief.md",
  filed: false,
  version: 1,
  versions: 1,
  sketch_version: 2,
};

function arc(fate: DocketArcFate) {
  return { name: "one-door", created: "2026-11-21T00:00:00Z", fate, filed: false };
}

describe("gesturesFor", () => {
  test("an inbox idea can only be sketched", () => {
    expect(gesturesFor(thread({ idea: IDEA }))).toEqual(["sketch-it"]);
  });

  test("an idea with a session can be kept", () => {
    expect(gesturesFor(thread({ idea: IDEA, sessions: [SESSION] }))).toEqual([
      "sketch-it",
      "keep-sketch",
    ]);
  });

  test("a session the idea was sketched in arrives staged sketch, and counts", () => {
    expect(
      gesturesFor(thread({ idea: IDEA, sessions: [{ ...SESSION, stage: "sketch" }] })),
    ).toEqual(["sketch-it", "keep-sketch"]);
  });

  test("an arc's stage session is not a sketching session", () => {
    expect(
      gesturesFor(thread({ idea: IDEA, sessions: [{ ...SESSION, stage: "implement" }] })),
    ).toEqual(["sketch-it"]);
  });

  test("a thread with a sketch and no brief can have one written", () => {
    expect(gesturesFor(thread({ idea: IDEA, sketch: SKETCH, sessions: [SESSION] }))).toEqual([
      "sketch-it",
      "keep-sketch",
      "edit-sketch",
      "write-brief",
    ]);
  });

  test("a thread with a brief version can be revised and opened as an arc", () => {
    expect(gesturesFor(thread({ idea: IDEA, sketch: SKETCH, brief: BRIEF }))).toEqual([
      "sketch-it",
      "edit-sketch",
      "revise-brief",
      "open-arc",
    ]);
  });

  test("a live arc takes Sketch it and Open arc away", () => {
    expect(
      gesturesFor(thread({ idea: IDEA, sketch: SKETCH, brief: BRIEF, arc: arc("live") })),
    ).toEqual(["edit-sketch", "revise-brief"]);
  });

  test("an ended arc can be reopened on the latest brief", () => {
    for (const fate of ["joined", "discarded"] as const) {
      expect(
        gesturesFor(thread({ idea: IDEA, sketch: SKETCH, brief: BRIEF, arc: arc(fate) })),
      ).toEqual(["sketch-it", "edit-sketch", "revise-brief", "reopen-arc"]);
    }
  });

  test("an arc's own brief, with no brief version, opens nothing", () => {
    const own = { title: "Rail", source: "arc" as const, filed: false };
    expect(gesturesFor(thread({ sketch: SKETCH, brief: own }))).toEqual([
      "edit-sketch",
      "revise-brief",
    ]);
  });
});

describe("openingFor", () => {
  const full = thread({ idea: IDEA, sketch: SKETCH, brief: BRIEF });

  test("Sketch it opens with the idea's line, and its body when given", () => {
    expect(openingFor("sketch-it", full)).toEqual({ kind: "prompt", text: IDEA.text });
    expect(openingFor("sketch-it", full, "More words.")).toEqual({
      kind: "prompt",
      text: `${IDEA.text}\n\nMore words.`,
    });
  });

  test("the command gestures carry the exact arguments", () => {
    expect(openingFor("keep-sketch", full)).toEqual({
      kind: "command",
      name: "tugplug:keep-sketch",
      args: "1a2b3c4d",
    });
    expect(openingFor("write-brief", full)).toEqual({
      kind: "command",
      name: "tugplug:brief",
      args: "--sketch 3f9a1c2e",
    });
    expect(openingFor("revise-brief", full)).toEqual({
      kind: "command",
      name: "tugplug:brief",
      args: "--sketch 3f9a1c2e --revise",
    });
    expect(openingFor("open-arc", full)).toEqual({
      kind: "command",
      name: "tugplug:arc",
      args: "one-door briefs/one-door-brief.md",
    });
  });

  test("Edit Sketch opens no session", () => {
    expect(openingFor("edit-sketch", full)).toBeNull();
  });

  test("Reopen arc opens the same command on the latest brief version", () => {
    const ended = thread({ idea: IDEA, sketch: SKETCH, brief: BRIEF, arc: arc("joined") });
    expect(openingFor("reopen-arc", ended)).toEqual({
      kind: "command",
      name: "tugplug:arc",
      args: "one-door briefs/one-door-brief.md",
    });
  });
});

describe("the stale confirm", () => {
  const stale = thread({
    idea: IDEA,
    sketch: { ...SKETCH, versions: 3 },
    brief: { ...BRIEF, sketch_version: 1, stale: true },
  });
  const fresh = thread({ idea: IDEA, sketch: SKETCH, brief: BRIEF });

  test("only an arc gesture on a stale brief asks", () => {
    expect(needsStaleConfirm("open-arc", stale)).toBe(true);
    expect(needsStaleConfirm("reopen-arc", stale)).toBe(true);
    expect(needsStaleConfirm("revise-brief", stale)).toBe(false);
    expect(needsStaleConfirm("open-arc", fresh)).toBe(false);
  });

  test("the question names the sketch versions", () => {
    expect(staleConfirmMessage(stale)).toBe(
      "This brief was written from sketch v1; the sketch is now v3. Open the arc on it anyway?",
    );
  });
});

describe("kept version references", () => {
  test("round-trip, and refuse what is not one", () => {
    expect(parseKeptVersionRef(keptVersionRef("3f9a1c2e", 2))).toEqual({ id: "3f9a1c2e", n: 2 });
    expect(parseKeptVersionRef("3f9a1c2e")).toBeNull();
    expect(parseKeptVersionRef("@2")).toBeNull();
    expect(parseKeptVersionRef("3f9a1c2e@0")).toBeNull();
    expect(parseKeptVersionRef(7)).toBeNull();
  });
});

describe("briefSlug", () => {
  test("the stem with its -brief taken off", () => {
    expect(briefSlug("briefs/one-door-brief.md")).toBe("one-door");
    expect(briefSlug("notes/plain.md")).toBe("plain");
    expect(briefSlug("brief.md")).toBe("brief");
  });
});

describe("partitionInbox", () => {
  test("untouched ideas come first, newest first; the rest keep their order", () => {
    const older = thread({ key: "idea:a", start: "2026-11-01T00:00:00Z", idea: IDEA });
    const newer = thread({ key: "idea:b", start: "2026-11-05T00:00:00Z", idea: IDEA });
    const sketched = thread({ key: "idea:c", start: "2026-11-03T00:00:00Z", idea: IDEA, sketch: SKETCH });
    const arcThread = thread({ key: "arc:x@1", start: "2026-10-01T00:00:00Z", arc: arc("live") });
    const lone = thread({ key: "commit:abc", start: "2026-11-09T00:00:00Z" });
    expect(isInboxThread(older)).toBe(true);
    expect(isInboxThread(sketched)).toBe(false);
    const { inbox, rest } = partitionInbox([arcThread, older, sketched, newer, lone]);
    expect(inbox.map((t) => t.key)).toEqual(["idea:b", "idea:a"]);
    expect(rest.map((t) => t.key)).toEqual(["arc:x@1", "idea:c", "commit:abc"]);
  });
});

function revision(offer: DocketRevisionOffer, over: Partial<DocketRevisionCell> = {}): DocketRevisionCell {
  return {
    from_version: 1,
    to_version: 2,
    added: [],
    changed: [{ label: "B02", title: "The second" }],
    removed: [],
    affected_steps: [2],
    uncited_steps: [],
    done_steps: [1, 2],
    offer,
    ...over,
  };
}

/** A stale live arc on brief v1 of 2, carrying `rev`. */
function staleThread(rev: DocketRevisionCell, name = "foo"): DocketThread {
  return thread({
    key: `arc:${name}@1`,
    brief: { ...BRIEF, source_path: "briefs/foo-brief.md", version: 2, versions: 2 },
    arc: { ...arc("live"), name, brief_version: 1, stale: true, revision: rev },
  });
}

describe("the Landed group", () => {
  test("joined arcs are landed, in the order they joined", () => {
    const at = (name: string, joined_at: string): DocketThread =>
      thread({ key: `arc:${name}@x`, arc: { ...arc("joined"), name, joined_at } });
    const later = at("later", "2026-11-03T00:00:00Z");
    const first = at("first", "2026-11-01T00:00:00Z");
    const live = thread({ key: "arc:live@x", arc: arc("live") });
    expect(isLandedThread(later)).toBe(true);
    expect(isLandedThread(live)).toBe(false);
    expect(landedOrder([later, live, first]).map((t) => t.arc?.name)).toEqual(["first", "later"]);
  });

  test("the confirm names the file count and each later commit by its arc", () => {
    expect(revertConfirmMessage("rail", { paths: 1, later: [] })).toBe(
      "Revert rail? Its join touched 1 file; a revert commit undoes them on the base.",
    );
    expect(
      revertConfirmMessage("rail", {
        paths: 3,
        later: [
          { sha: "a1", subject: "Oil the rail", arc: "oil" },
          { sha: "a2", subject: "Hand edit", arc: null },
        ],
      }),
    ).toBe(
      "Revert rail? Its join touched 3 files; a revert commit undoes them on the base.\n" +
        "Later work on the same files: oil\n" +
        "Later work on the same files: Hand edit",
    );
  });
});

describe("Inbox proposals", () => {
  test("each arc's follow-ups are proposed by k, keyed by the generation", () => {
    const joined = {
      ...arc("joined"),
      proposals: [
        { k: 2, text: "Paint the rails" },
        { k: 1, text: "Name the rails" },
      ],
    };
    const threads = [
      thread({ key: "idea:1a2b3c4d", idea: IDEA }),
      thread({ key: "arc:one-door@2026-11-21T00:00:00Z", arc: joined }),
      thread({ key: "arc:quiet@x", arc: { ...arc("live"), name: "quiet" } }),
    ];
    expect(docketProposals(threads)).toEqual([
      {
        key: proposalKey("one-door", "2026-11-21T00:00:00Z", 1),
        threadKey: "arc:one-door@2026-11-21T00:00:00Z",
        arc: "one-door",
        created: "2026-11-21T00:00:00Z",
        k: 1,
        text: "Name the rails",
      },
      {
        key: "proposal:one-door@2026-11-21T00:00:00Z#2",
        threadKey: "arc:one-door@2026-11-21T00:00:00Z",
        arc: "one-door",
        created: "2026-11-21T00:00:00Z",
        k: 2,
        text: "Paint the rails",
      },
    ]);
  });
});

describe("the revision notice", () => {
  test("a successor is the stem with the new version", () => {
    expect(successorName("foo", 3)).toBe("foo-v3");
    expect(successorName("foo-v2", 3)).toBe("foo-v3");
    expect(successorName("v2-rail", 4)).toBe("v2-rail-v4");
  });

  test("the suggested boundary comes first for each successor offer", () => {
    const first = (offer: DocketRevisionOffer) => boundaryChoices(revision(offer))[0];
    expect(first({ kind: "successor_step", after: 1 })).toEqual({
      boundary: "step:1",
      label: "After step 1",
      suggested: true,
    });
    expect(first({ kind: "successor_tip" })).toMatchObject({ boundary: "tip", suggested: true });
    expect(first({ kind: "successor_fork" })).toMatchObject({
      boundary: "fork",
      label: "From the start",
      suggested: true,
    });
    // Each finished step and the fork point follow, the suggestion not repeated.
    expect(boundaryChoices(revision({ kind: "successor_step", after: 1 })).map((c) => c.boundary)).toEqual([
      "step:1",
      "step:2",
      "fork",
    ]);
  });

  test("Pick and Keep going suggest no boundary", () => {
    for (const offer of [{ kind: "pick" }, { kind: "keep_going" }] as DocketRevisionOffer[]) {
      const choices = boundaryChoices(revision(offer));
      expect(choices.some((c) => c.suggested)).toBe(false);
      expect(choices.map((c) => c.boundary)).toEqual(["step:1", "step:2", "fork"]);
    }
  });

  test("the summary says what moved and which steps it reaches", () => {
    expect(
      revisionSummary(
        revision({ kind: "successor_step", after: 2 }, {
          changed: [
            { label: "B02", title: "a" },
            { label: "B04", title: "b" },
          ],
          added: [{ label: "B05", title: "c" }],
          affected_steps: [3],
        }),
      ),
    ).toBe("Brief moved v1 → v2: 2 changed, 1 added; touches step 3");
    expect(
      revisionSummary(revision({ kind: "pick" }, { affected_steps: [], uncited_steps: [1, 2] })),
    ).toBe("Brief moved v1 → v2: 1 changed; steps 1, 2 name no decisions");
    expect(
      revisionSummary(revision({ kind: "keep_going" }, { changed: [], added: [{ label: "B03", title: "x" }], affected_steps: [] })),
    ).toBe("Brief moved v1 → v2: 1 added");
  });

  test("a revision is pending until the user keeps going past its newest version", () => {
    expect(revisionPending(staleThread(revision({ kind: "keep_going" })))).toBe(true);
    expect(revisionPending(staleThread(revision({ kind: "keep_going" }, { kept_through: 2 })))).toBe(false);
    expect(revisionPending(thread({ arc: arc("live") }))).toBe(false);
  });

  test("the successor opens through the arc door from the chosen commit", () => {
    const t = staleThread(revision({ kind: "successor_step", after: 1 }));
    expect(successorOpening(t, "abc1234")).toEqual({
      kind: "command",
      name: "tugplug:arc",
      args: "foo-v2 briefs/foo-brief.md --successor-of foo --from abc1234",
    });
    expect(successorOpening(thread({ arc: arc("live") }), "abc1234")).toBeNull();
  });

  test("a standing park request's successor is the one the door opens", () => {
    const t = staleThread(revision({ kind: "successor_tip" }, { to_version: 3 }));
    expect(successorFor(t)).toBe("foo-v3");
    const asked = { ...t, arc: { ...t.arc!, successor: "foo-v2" } };
    expect(successorFor(asked)).toBe("foo-v2");
    expect(successorOpening(asked, "abc1234")).toEqual({
      kind: "command",
      name: "tugplug:arc",
      args: "foo-v2 briefs/foo-brief.md --successor-of foo --from abc1234",
    });
  });

  test("only a live parked arc is parked", () => {
    const parked = staleThread(revision({ kind: "successor_tip" }));
    expect(isParkedThread(parked)).toBe(false);
    parked.arc = { ...parked.arc!, parked: true, successor: "foo-v2" };
    expect(isParkedThread(parked)).toBe(true);
    parked.arc = { ...parked.arc!, fate: "discarded" };
    expect(isParkedThread(parked)).toBe(false);
  });
});
