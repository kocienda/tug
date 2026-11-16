/**
 * `chart-refs` — a chart ref read apart and resolved through a hand-built
 * context. The DOM half (`annotateChartRefs` stamping hosts) needs a real
 * DOM and is proven in the app (project policy: no jsdom / happy-dom); what
 * this pins is the decision each verdict state leads to.
 */

import { describe, expect, test } from "bun:test";

import type { ArcVerdict } from "../arc-resolution";
import { parseRef, payloadForRef } from "../chart-refs";
import type { CommitVerdict } from "../commit-resolution";
import type { PathReference } from "../detect-path-reference";
import type { PathVerdict } from "../path-resolution";
import type { SessionVerdict } from "../session-resolution";
import type { AnnotationContext } from "../types";

const UUID = "048e4155-f644-46f7-a839-d22ac02a564f";

describe("parseRef", () => {
  test("accepts every prefix's values", () => {
    for (const ref of [
      "commit:63de",
      "commit:63de5762a9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5",
      "file:src/app.ts",
      "file:/abs/path with space.ts",
      "dir:src/lib",
      "session:048e4155",
      `session:${UUID}`,
      "session:tug/mighty-cabin",
      "arc:chart-cross-references",
      "arc:0day",
      "url:https://example.com/x",
      "url:http://localhost:5173",
      "command:just ci",
      "command:/commit",
    ]) {
      expect(parseRef(ref)).not.toBeNull();
    }
  });

  test("rejects malformed values and unknown prefixes", () => {
    for (const ref of [
      "commit:63d",
      "commit:zzzz",
      "commit:" + "a".repeat(41),
      "file:",
      "file:a\nb",
      "dir:" + "x".repeat(513),
      "session:048e415",
      "session:tug/",
      "session:/cabin",
      "session:a/b/c",
      "session:tug/mighty cabin",
      "arc:Upper",
      "arc:-lead",
      "arc:" + "a".repeat(121),
      "url:ftp://example.com",
      "url:https://",
      "url:https://a b",
      "command:",
      "command:a\nb",
      "thing:x",
      "no-prefix",
    ]) {
      expect(parseRef(ref)).toBeNull();
    }
  });

  test("splits prefix and value at the first colon", () => {
    expect(parseRef("url:https://example.com:8080/x")).toEqual({ kind: "url", value: "https://example.com:8080/x" });
  });
});

interface Answers {
  path?: PathVerdict;
  commit?: CommitVerdict;
  session?: SessionVerdict;
  arc?: ArcVerdict;
}

function context(answers: Answers, extra: Partial<AnnotationContext> = {}): AnnotationContext {
  return {
    isKnownSlashCommand: (name) => name === "commit",
    resolvePath: (_reference: PathReference) => answers.path ?? { state: "unknown" },
    resolveCommit: () => answers.commit ?? { state: "unknown" },
    commitRoot: "/repo",
    resolveSession: () => answers.session ?? { state: "pending" },
    resolveArc: () => answers.arc ?? { state: "pending" },
    ...extra,
  };
}

const FACTS = { subject: "s", author: "a", date: "2026-11-16", files: [] };

describe("payloadForRef", () => {
  test("commit: confirmed, pending, missing, and no repository", () => {
    expect(payloadForRef("commit:63de5762", context({ commit: { state: "confirmed", paths: ["a.ts"], facts: FACTS } }))).toEqual({
      kind: "commit-sha",
      sha: "63de5762",
      root: "/repo",
      paths: ["a.ts"],
    });
    expect(payloadForRef("commit:63de5762", context({ commit: { state: "pending" } }))).toBe("pending");
    expect(payloadForRef("commit:63de5762", context({ commit: { state: "unknown" } }))).toBe("pending");
    expect(payloadForRef("commit:63de5762", context({ commit: { state: "missing" } }))).toBeNull();
    const unbound = context({ commit: { state: "confirmed", paths: [], facts: FACTS } }, { commitRoot: null });
    expect(payloadForRef("commit:63de5762", unbound)).toBeNull();
  });

  test("file and dir: the filesystem decides the kind", () => {
    const asFile = context({ path: { state: "confirmed", canonical: "/repo/src/app.ts", isDir: false } });
    expect(payloadForRef("file:src/app.ts", asFile)).toEqual({ kind: "file-path", path: "/repo/src/app.ts" });
    // A `file:` the filesystem says is a folder earns the folder's gesture.
    const asDir = context({ path: { state: "confirmed", canonical: "/repo/src", isDir: true } });
    expect(payloadForRef("file:src/app.ts", asDir)).toEqual({ kind: "directory", path: "/repo/src" });
    expect(payloadForRef("dir:src", asDir)).toEqual({ kind: "directory", path: "/repo/src" });
    expect(payloadForRef("file:src/app.ts", context({ path: { state: "pending" } }))).toBe("pending");
    expect(payloadForRef("file:src/app.ts", context({ path: { state: "missing" } }))).toBeNull();
  });

  test("file: a value with a space in it is refuted", () => {
    const yes = context({ path: { state: "confirmed", canonical: "/x", isDir: false } });
    expect(payloadForRef("file:two words.ts here", yes)).toBeNull();
  });

  test("dir: a bare word is still a path, because the prefix says so", () => {
    const asked: PathReference[] = [];
    const watching = context({}, {
      resolvePath: (reference) => {
        asked.push(reference);
        return { state: "confirmed", canonical: "/repo/tugrust", isDir: true };
      },
    });
    expect(payloadForRef("dir:tugrust", watching)).toEqual({ kind: "directory", path: "/repo/tugrust" });
    expect(asked).toEqual([{ path: "tugrust", shape: "path" }]);
  });

  test("file: a line citation rides the payload", () => {
    const yes = context({ path: { state: "confirmed", canonical: "/repo/app.ts", isDir: false } });
    expect(payloadForRef("file:src/app.ts:12", yes)).toEqual({ kind: "file-path", path: "/repo/app.ts", line: 12 });
  });

  test("session: the payload carries the full id the ledger answered with", () => {
    const found = context({ session: { state: "confirmed", sessionId: UUID, provenance: "here" } });
    expect(payloadForRef("session:048e4155", found)).toEqual({ kind: "session", target: UUID });
    expect(payloadForRef("session:048e4155", context({ session: { state: "pending" } }))).toBe("pending");
    expect(payloadForRef("session:048e4155", context({ session: { state: "refuted" } }))).toBeNull();
    expect(payloadForRef("session:048e4155", context({}, { resolveSession: undefined }))).toBeNull();
  });

  test("arc: joined carries its join commit; live does not; discarded is refuted", () => {
    const joined = context({ arc: { state: "confirmed", fate: "joined", joinSha: "302d43b5d1" } });
    expect(payloadForRef("arc:chart-cross-references", joined)).toEqual({
      kind: "arc",
      name: "chart-cross-references",
      root: "/repo",
      joinSha: "302d43b5d1",
    });
    const live = context({ arc: { state: "confirmed", fate: "live" } });
    expect(payloadForRef("arc:x", live)).toEqual({ kind: "arc", name: "x", root: "/repo" });
    expect(payloadForRef("arc:x", context({ arc: { state: "pending" } }))).toBe("pending");
    expect(payloadForRef("arc:x", context({ arc: { state: "refuted" } }))).toBeNull();
    expect(payloadForRef("arc:x", context({ arc: { state: "confirmed", fate: "live" } }, { commitRoot: null }))).toBeNull();
  });

  test("url needs no resolver", () => {
    expect(payloadForRef("url:https://example.com/x", context({}))).toEqual({ kind: "url", url: "https://example.com/x" });
  });

  test("command: a known slash command or a shell command, nothing else", () => {
    expect(payloadForRef("command:/commit now", context({}))).toEqual({ kind: "slash-command", name: "commit", args: "now" });
    expect(payloadForRef("command:/nosuch", context({}))).toBeNull();
    const shell = payloadForRef("command:just ci", context({}));
    expect(shell === null || shell === "pending" ? null : shell.kind).toBe("shell-command");
  });

  test("an unanswerable context resolves nothing, so every ref is shown as written", () => {
    const share = context(
      {
        commit: { state: "confirmed", paths: [], facts: FACTS },
        path: { state: "confirmed", canonical: "/x", isDir: false },
      },
      { unanswerable: true },
    );
    expect(payloadForRef("commit:63de5762", share)).toBeNull();
    expect(payloadForRef("file:/x", share)).toBeNull();
    expect(payloadForRef("url:https://example.com", share)).toBeNull();
  });

  test("a malformed ref never reaches a resolver", () => {
    let asked = false;
    const watching = context({}, {
      resolveCommit: () => {
        asked = true;
        return { state: "unknown" };
      },
    });
    expect(payloadForRef("commit:xyz", watching)).toBeNull();
    expect(asked).toBe(false);
  });
});
