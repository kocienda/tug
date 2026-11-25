/**
 * The Docket card's authoring gestures, pure: which a thread offers, the
 * first turn each one opens with, the slug an arc is opened under, and the
 * inbox's order.
 */
import { describe, expect, test } from "bun:test";

import {
  briefSlug,
  gesturesFor,
  isInboxThread,
  keptVersionRef,
  needsStaleConfirm,
  openingFor,
  parseKeptVersionRef,
  partitionInbox,
  staleConfirmMessage,
} from "../docket-authoring";
import type { DocketArcFate, DocketThread } from "../docket-types";

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
