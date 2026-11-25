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
});
