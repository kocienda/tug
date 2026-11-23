/**
 * The docket lookups over a DOCKETS snapshot: an arc's docket is found by
 * its live generation in its own project, and nowhere else.
 */
import { describe, expect, test } from "bun:test";

import { docketById, docketForArc } from "../docket-store";
import type { DocketArcFate, DocketsSnapshot, DocketThread } from "../docket-types";

function arcThread(name: string, fate: DocketArcFate, created: string): DocketThread {
  return {
    key: `arc:${name}@${created}`,
    start: created,
    arc: { name, created, fate, filed: true },
    sessions: [],
    commits: [],
    filed_keys: [`arc:${name}@${created}`],
  };
}

const SNAPSHOT: DocketsSnapshot = {
  projects: [
    {
      project_dir: "/u/src/tug",
      workspace_key: "/u/src/tug",
      dockets: [
        {
          id: "aaaa0001",
          name: "Old rail",
          created: "2026-11-01T00:00:00Z",
          retired: false,
          threads: [arcThread("rail", "joined", "2026-11-01T00:00:00Z")],
        },
        {
          id: "aaaa0002",
          name: "Rail work",
          created: "2026-11-20T00:00:00Z",
          retired: false,
          threads: [arcThread("rail", "live", "2026-11-20T00:00:00Z")],
        },
      ],
    },
    {
      project_dir: "/u/src/other",
      workspace_key: "/u/src/other",
      dockets: [
        {
          id: "bbbb0001",
          name: "Elsewhere",
          created: "2026-11-21T00:00:00Z",
          retired: false,
          threads: [arcThread("parser", "live", "2026-11-21T00:00:00Z")],
        },
      ],
    },
  ],
};

describe("docketForArc", () => {
  test("finds the docket holding the live generation, with its thread", () => {
    const hit = docketForArc(SNAPSHOT, "/u/src/tug", "rail");
    expect(hit?.docket.id).toBe("aaaa0002");
    expect(hit?.threadKey).toBe("arc:rail@2026-11-20T00:00:00Z");
  });

  test("ignores a joined arc of the same name", () => {
    const joinedOnly: DocketsSnapshot = {
      projects: [{ ...SNAPSHOT.projects[0], dockets: [SNAPSHOT.projects[0].dockets[0]] }],
    };
    expect(docketForArc(joinedOnly, "/u/src/tug", "rail")).toBeNull();
  });

  test("ignores a live arc of the same name in another project", () => {
    expect(docketForArc(SNAPSHOT, "/u/src/tug", "parser")).toBeNull();
    expect(docketForArc(SNAPSHOT, "/u/src/other", "rail")).toBeNull();
    expect(docketForArc(SNAPSHOT, null, "rail")).toBeNull();
  });
});

describe("docketById", () => {
  test("finds a docket in any open project", () => {
    expect(docketById(SNAPSHOT, "bbbb0001")?.project.workspace_key).toBe("/u/src/other");
    expect(docketById(SNAPSHOT, "ffff0000")).toBeNull();
  });
});
