/**
 * Coverage for `entityKey` — what makes two annotations one thing.
 *
 * The light that reads it is DOM and is proven in the real app (project
 * policy: no jsdom / happy-dom). Pinned here is the spelling: a short and a
 * long spelling of one sha key alike inside one root and apart across roots,
 * a path keys on its canonical path whether a prose run or a chart ref
 * carried it, and the kinds a chart can never name key to nothing.
 */

import { describe, expect, test } from "bun:test";

import { entityKey } from "../entity-key";

describe("entityKey", () => {
  test("a 7-char and a 10-char spelling of one sha in one root are one entity", () => {
    const short = entityKey({ kind: "commit-sha", sha: "ABC1234", root: "/repo", paths: [] });
    const long = entityKey({ kind: "commit-sha", sha: "abc1234def", root: "/repo", paths: ["a.rs"] });
    expect(short).toBe("commit:/repo:abc1234");
    expect(long).toBe(short);
  });

  test("the same sha in another root is another entity", () => {
    expect(entityKey({ kind: "commit-sha", sha: "abc1234", root: "/other", paths: [] })).not.toBe(
      entityKey({ kind: "commit-sha", sha: "abc1234", root: "/repo", paths: [] }),
    );
  });

  test("a file keys on its path, from prose or from a ref alike", () => {
    const prose = entityKey({ kind: "file-path", path: "/tmp/at/kookaburra.rs", line: 12 });
    const ref = entityKey({ kind: "file-path", path: "/tmp/at/kookaburra.rs" });
    expect(prose).toBe("path:/tmp/at/kookaburra.rs");
    expect(ref).toBe(prose);
    expect(entityKey({ kind: "directory", path: "/tmp/at" })).toBe("path:/tmp/at");
  });

  test("sessions, arcs, urls and commands key on what they carry", () => {
    expect(entityKey({ kind: "session", target: "0f3c1e5a-9b27-4c1d-8e36-5a7f2d4b6c90" })).toBe(
      "session:0f3c1e5a-9b27-4c1d-8e36-5a7f2d4b6c90",
    );
    expect(entityKey({ kind: "arc", name: "chart-refs", root: "/repo" })).toBe("arc:/repo:chart-refs");
    expect(entityKey({ kind: "arc", name: "chart-refs", root: "/repo", joinSha: "abc1234" })).toBe("arc:/repo:chart-refs");
    expect(entityKey({ kind: "url", url: "https://example.com/a" })).toBe("url:https://example.com/a");
    expect(entityKey({ kind: "slash-command", name: "arc", args: "x" })).toBe("slash:arc x");
    expect(entityKey({ kind: "shell-command", command: "just ci" })).toBe("shell:just ci");
  });

  test("email, image and help name no entity", () => {
    expect(entityKey({ kind: "email", address: "a@b.c" })).toBeNull();
    expect(entityKey({ kind: "image", path: "/tmp/a.png" } as never)).toBeNull();
    expect(entityKey({ kind: "help" } as never)).toBeNull();
  });
});
