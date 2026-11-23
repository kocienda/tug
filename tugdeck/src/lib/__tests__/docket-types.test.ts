/**
 * The DOCKETS frame guard: Spec S05's example is a snapshot, and a thread
 * without its key is not.
 */
import { describe, expect, test } from "bun:test";

import { isDocketsSnapshot } from "../docket-types";

type Frame = {
  projects: Array<
    Record<string, unknown> & {
      dockets: Array<Record<string, unknown> & { threads: Array<Record<string, unknown>> }>;
    }
  >;
};

/** Spec S05's example frame, with its elisions filled in. */
function specFrame(): Frame {
  return {
    projects: [
      {
        project_dir: "/u/src/tug",
        workspace_key: "/u/src/tug",
        dockets: [
          {
            id: "3f9a1c2e",
            name: "Rail work",
            created: "2026-11-22T18:00:00.000Z",
            retired: false,
            threads: [
              {
                key: "arc:rail-panel@2026-11-20T10:00:00.000Z",
                start: "2026-11-20T10:00:00.000Z",
                sketch: { id: "0a1b2c3d", versions: 3, want: "A rail panel", filed: false },
                brief: { title: "The rail brief", source: "arc", filed: false },
                arc: {
                  name: "rail-panel",
                  created: "2026-11-20T10:00:00.000Z",
                  fate: "joined",
                  join_sha: "63de5762a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5",
                  filed: true,
                },
                sessions: [
                  {
                    uuid: "048e4155-f644-46f7-a839-d22ac02a564f",
                    callsign: "mighty-cabin",
                    stage: "implement",
                    filed: false,
                  },
                ],
                commits: [
                  {
                    sha: "63de5762a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5",
                    subject: "Step 1: The store",
                    role: "round",
                    filed: false,
                  },
                ],
                filed_keys: ["arc:rail-panel@2026-11-20T10:00:00.000Z"],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("isDocketsSnapshot", () => {
  test("accepts Spec S05's example", () => {
    expect(isDocketsSnapshot(specFrame())).toBe(true);
  });

  test("accepts an empty frame, and cells the server left out", () => {
    expect(isDocketsSnapshot({ projects: [] })).toBe(true);
    const frame = specFrame();
    const thread = frame.projects[0].dockets[0].threads[0];
    delete thread.sketch;
    thread.brief = null;
    expect(isDocketsSnapshot(frame)).toBe(true);
  });

  test("rejects a thread missing its key", () => {
    const frame = specFrame();
    delete frame.projects[0].dockets[0].threads[0].key;
    expect(isDocketsSnapshot(frame)).toBe(false);
  });

  test("rejects a thread missing its filed keys", () => {
    const frame = specFrame();
    delete frame.projects[0].dockets[0].threads[0].filed_keys;
    expect(isDocketsSnapshot(frame)).toBe(false);
  });

  test("rejects a project with no workspace key", () => {
    const frame = specFrame();
    delete frame.projects[0].workspace_key;
    expect(isDocketsSnapshot(frame)).toBe(false);
  });

  test("an idea thread and the lineage fields decode, and each may be absent", () => {
    const frame = specFrame();
    frame.projects[0].dockets[0].threads.push({
      key: "idea:1a2b3c4d",
      start: "2026-11-21T10:00:00.000Z",
      idea: { id: "1a2b3c4d", text: "An inbox for ideas", filed: true },
      sketch: { id: "0a1b2c3e", versions: 3, author: "user", filed: false },
      brief: {
        title: "The inbox brief",
        source: "sketch",
        source_path: "briefs/inbox-brief.md",
        filed: false,
        version: 2,
        versions: 2,
        sketch_version: 2,
        stale: true,
      },
      arc: {
        name: "inbox",
        created: "2026-11-21T11:00:00.000Z",
        fate: "live",
        filed: false,
        brief_version: 1,
        stale: true,
        runs: 2,
      },
      sessions: [{ uuid: "u-1", stage: "sketch", filed: false }],
      commits: [],
      filed_keys: ["idea:1a2b3c4d"],
    });
    expect(isDocketsSnapshot(frame)).toBe(true);
    // Spec S05's own thread carries none of them, and still decodes.
    expect(isDocketsSnapshot(specFrame())).toBe(true);
  });

  test("a lineage field of the wrong type is not a snapshot", () => {
    const bad = (patch: (t: Record<string, unknown>) => void) => {
      const frame = specFrame();
      patch(frame.projects[0].dockets[0].threads[0]);
      return isDocketsSnapshot(frame);
    };
    expect(bad((t) => { t.idea = { id: "1a2b3c4d", filed: true }; })).toBe(false);
    expect(bad((t) => { (t.sketch as Record<string, unknown>).author = "robot"; })).toBe(false);
    expect(bad((t) => { (t.brief as Record<string, unknown>).stale = "yes"; })).toBe(false);
    expect(bad((t) => { (t.arc as Record<string, unknown>).runs = "2"; })).toBe(false);
  });

  test("a stale live arc's revision, park and succession decode", () => {
    const frame = specFrame();
    const arc = frame.projects[0].dockets[0].threads[0].arc as Record<string, unknown>;
    arc.fate = "live";
    arc.revision = {
      from_version: 1,
      to_version: 2,
      added: [{ label: "B03", title: "A third" }],
      changed: [{ label: "B02", title: "The second" }],
      removed: [],
      affected_steps: [2],
      uncited_steps: [],
      done_steps: [1, 2],
      offer: { kind: "successor_step", after: 1 },
      kept_through: 1,
      parked: true,
    };
    arc.parked = true;
    arc.successor = "rail-panel-v2";
    arc.park_boundary = "step:1";
    arc.succeeds = "rail";
    arc.proposals = [{ k: 1, text: "Name the rails" }];
    arc.joined_at = "2026-11-02T00:00:00Z";
    arc.reverted = "fedcba98";
    expect(isDocketsSnapshot(frame)).toBe(true);

    // Each offer the server names decodes; an unknown one does not.
    for (const offer of [
      { kind: "keep_going" },
      { kind: "successor_tip" },
      { kind: "successor_fork" },
      { kind: "pick" },
    ]) {
      (arc.revision as Record<string, unknown>).offer = offer;
      expect(isDocketsSnapshot(frame)).toBe(true);
    }
    (arc.revision as Record<string, unknown>).offer = { kind: "successor_step" };
    expect(isDocketsSnapshot(frame)).toBe(false);
    (arc.revision as Record<string, unknown>).offer = { kind: "rewind" };
    expect(isDocketsSnapshot(frame)).toBe(false);
  });

  test("a revision or park field of the wrong type is not a snapshot", () => {
    const bad = (patch: (a: Record<string, unknown>) => void) => {
      const frame = specFrame();
      patch(frame.projects[0].dockets[0].threads[0].arc as Record<string, unknown>);
      return isDocketsSnapshot(frame);
    };
    expect(bad((a) => { a.parked = "yes"; })).toBe(false);
    expect(bad((a) => { a.successor = 2; })).toBe(false);
    expect(bad((a) => { a.park_boundary = 1; })).toBe(false);
    expect(bad((a) => { a.proposals = [{ k: "1", text: "x" }]; })).toBe(false);
    expect(bad((a) => { a.proposals = "none"; })).toBe(false);
    expect(bad((a) => { a.joined_at = 1; })).toBe(false);
    expect(bad((a) => { a.reverted = true; })).toBe(false);
    expect(bad((a) => { a.revision = { from_version: 1, to_version: 2 }; })).toBe(false);
  });
});
