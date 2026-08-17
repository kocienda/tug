/**
 * Unit tests for `resolveOverviewRef` — the pure decision from a ref, a
 * root, and the resolver verdicts to what the card should render. The
 * resolver seams are injected; nothing here touches a network or a store.
 */

import { describe, expect, test } from "bun:test";

import {
  resolveOverviewRef,
  type OverviewRefResolvers,
  type OverviewRefRoot,
} from "@/lib/overview-ref-resolve";
import type { PathVerdict } from "@/lib/annotator/path-resolution";
import type { CommitVerdict } from "@/lib/annotator/commit-resolution";
import type { OverviewRef } from "@/protocol";

const ROOT: OverviewRefRoot = {
  projectDir: "/repo",
  workspaceKey: "ws1",
};

const file = (target: string): OverviewRef => ({ kind: "file", target });
const commit = (target: string): OverviewRef => ({ kind: "commit", target });

function resolvers(overrides: Partial<OverviewRefResolvers>): OverviewRefResolvers {
  return {
    lookupPath: () => ({ state: "unknown" }),
    lookupName: () => null,
    lookupCommit: () => null,
    ...overrides,
  };
}

describe("resolveOverviewRef", () => {
  test("a confirmed relative path is actionable at its canonical path", () => {
    const seen: Array<[string, string | null]> = [];
    const r = resolveOverviewRef(
      file("src/x.ts"),
      ROOT,
      resolvers({
        lookupPath: (raw, cwd): PathVerdict => {
          seen.push([raw, cwd]);
          return { state: "confirmed", canonical: "/repo/src/x.ts", isDir: false };
        },
      }),
    );
    expect(seen).toEqual([["src/x.ts", "/repo"]]);
    expect(r).toEqual({
      state: "actionable",
      payload: { kind: "file-path", path: "/repo/src/x.ts" },
    });
  });

  test("a confirmed directory earns the directory gesture", () => {
    const r = resolveOverviewRef(
      file("tugdeck/styles"),
      ROOT,
      resolvers({
        lookupPath: (): PathVerdict => ({
          state: "confirmed",
          canonical: "/repo/tugdeck/styles",
          isDir: true,
        }),
      }),
    );
    expect(r).toEqual({
      state: "actionable",
      payload: { kind: "directory", path: "/repo/tugdeck/styles" },
    });
  });

  test("an absolute path resolves with no root at all", () => {
    const r = resolveOverviewRef(
      file("/etc/hosts"),
      null,
      resolvers({
        lookupPath: (raw, cwd): PathVerdict => {
          expect(raw).toBe("/etc/hosts");
          expect(cwd).toBeNull();
          return { state: "confirmed", canonical: "/etc/hosts", isDir: false };
        },
      }),
    );
    expect(r.state).toBe("actionable");
  });

  test("a bare name asks the file index, not the stat endpoint", () => {
    const r = resolveOverviewRef(
      file("justfile"),
      ROOT,
      resolvers({
        lookupName: (root, name): PathVerdict => {
          expect(root).toEqual(ROOT);
          expect(name).toBe("justfile");
          return { state: "confirmed", canonical: "/repo/Justfile", isDir: false };
        },
      }),
    );
    // The canonical spelling wins — the case the disk actually holds.
    expect(r).toEqual({
      state: "actionable",
      payload: { kind: "file-path", path: "/repo/Justfile" },
    });
  });

  test("missing and pending and unknown each render honestly", () => {
    const missing = resolveOverviewRef(
      file("gone.ts"),
      ROOT,
      resolvers({ lookupName: (): PathVerdict => ({ state: "missing" }) }),
    );
    expect(missing.state).toBe("inert");
    const pending = resolveOverviewRef(
      file("src/x.ts"),
      ROOT,
      resolvers({ lookupPath: (): PathVerdict => ({ state: "pending" }) }),
    );
    expect(pending.state).toBe("pending");
    const unknown = resolveOverviewRef(
      file("src/x.ts"),
      ROOT,
      resolvers({ lookupPath: (): PathVerdict => ({ state: "unknown" }) }),
    );
    expect(unknown.state).toBe("inert");
  });

  test("a relative ref with no root is inert, never guessed", () => {
    const r = resolveOverviewRef(file("src/x.ts"), null, resolvers({}));
    expect(r.state).toBe("inert");
  });

  test("a confirmed commit carries the diff descriptor's root and paths", () => {
    const r = resolveOverviewRef(
      commit("957d2350b422"),
      ROOT,
      resolvers({
        lookupCommit: (root, sha): CommitVerdict => {
          expect(root).toEqual(ROOT);
          expect(sha).toBe("957d2350b422");
          return {
            state: "confirmed",
            paths: ["a.ts", "b.css"],
            facts: {
              subject: "fix the thing",
              author: "Ken Kocienda",
              date: "2026-08-12",
              files: [
                { path: "a.ts", status: "modified", added: 4, removed: 1 },
                { path: "b.css", status: "created", added: 9, removed: 0 },
              ],
            },
          };
        },
      }),
    );
    expect(r.state).toBe("actionable");
    if (r.state !== "actionable") return;
    expect(r.payload).toEqual({
      kind: "commit-sha",
      sha: "957d2350b422",
      root: "/repo",
      paths: ["a.ts", "b.css"],
    });
    // The chip stands with no sentence around it, so its hover has to say
    // which change this is. The resolution carries the facts; the card builds
    // the tip from them.
    expect(r.facts?.subject).toBe("fix the thing");
    expect(r.facts?.files).toHaveLength(2);
  });

  test("a sha git cannot show is inert with the repo named", () => {
    const r = resolveOverviewRef(
      commit("deadbeef1"),
      ROOT,
      resolvers({ lookupCommit: (): CommitVerdict => ({ state: "missing" }) }),
    );
    expect(r.state).toBe("inert");
    if (r.state === "inert") expect(r.reason).toContain("/repo");
  });
});
