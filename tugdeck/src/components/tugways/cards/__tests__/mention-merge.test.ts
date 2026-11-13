/**
 * The `@` merge: files first and untouched, then sessions and commits as
 * short groups, with `session:` and `commit:` narrowing to one kind.
 */

import { describe, expect, test } from "bun:test";

import type { CompletionItem, CompletionProvider } from "@/lib/tug-text-types";
import { MENTION_GROUP_CAP, mergeMentionProviders } from "../completion-providers/mention-merge";

const item = (label: string, type: string): CompletionItem => ({
  label,
  atom: { kind: "atom", type, label, value: label },
});

/**
 * A source that offers `count` rows of one kind for any query, records the
 * queries it was put, and can be told to notify its listeners.
 */
function source(type: string, count: number) {
  const queries: string[] = [];
  const listeners = new Set<() => void>();
  const provider = ((query: string) => {
    queries.push(query);
    return Array.from({ length: count }, (_, i) => item(`${type}-${i}${query}`, type));
  }) as CompletionProvider;
  provider.subscribe = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return {
    provider,
    queries,
    listenerCount: () => listeners.size,
    notify: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

function merged(counts = { files: 4, sessions: 5, commits: 5 }) {
  const files = source("file", counts.files);
  const sessions = source("session", counts.sessions);
  const commits = source("commit", counts.commits);
  const provider = mergeMentionProviders({
    files: files.provider,
    sessions: sessions.provider,
    commits: commits.provider,
  });
  return { provider, files, sessions, commits };
}

const types = (items: CompletionItem[]) => items.map((i) => i.atom.type);

describe("the groups", () => {
  test("files come first and whole, then capped sessions, then capped commits", () => {
    const { provider, files } = merged();
    const items = provider("par");
    expect(types(items)).toEqual([
      "file",
      "file",
      "file",
      "file",
      "session",
      "session",
      "session",
      "commit",
      "commit",
      "commit",
    ]);
    // The file rows are the file provider's own, in its own order.
    expect(items.slice(0, 4)).toEqual(files.provider("par"));
    expect(MENTION_GROUP_CAP).toBe(3);
  });

  test("a bare @ offers the recents of both kinds beneath the files", () => {
    const { provider, sessions, commits } = merged({ files: 2, sessions: 5, commits: 1 });
    expect(types(provider(""))).toEqual(["file", "file", "session", "session", "session", "commit"]);
    expect(sessions.queries).toEqual([""]);
    expect(commits.queries).toEqual([""]);
  });

  test("a kind with nothing to offer leaves no gap", () => {
    const { provider } = merged({ files: 0, sessions: 0, commits: 2 });
    expect(types(provider("x"))).toEqual(["commit", "commit"]);
  });
});

describe("the prefixes", () => {
  test("session: narrows to sessions, uncapped, on the fragment after the colon", () => {
    const { provider, files, sessions, commits } = merged();
    const items = provider("session:fa");
    expect(types(items)).toEqual(["session", "session", "session", "session", "session"]);
    expect(sessions.queries).toEqual(["fa"]);
    // The other two kinds are not asked at all: a narrowed query is not theirs.
    expect(files.queries).toEqual([]);
    expect(commits.queries).toEqual([]);
  });

  test("commit: narrows to commits, uncapped", () => {
    const { provider, files, sessions, commits } = merged();
    expect(types(provider("commit:b0ab"))).toEqual(Array(5).fill("commit"));
    expect(commits.queries).toEqual(["b0ab"]);
    expect(files.queries).toEqual([]);
    expect(sessions.queries).toEqual([]);
  });

  test("a prefix with nothing after it browses that kind", () => {
    const { provider, sessions, commits } = merged();
    expect(provider("session:")).toHaveLength(5);
    expect(provider("commit:")).toHaveLength(5);
    expect(sessions.queries).toEqual([""]);
    expect(commits.queries).toEqual([""]);
  });

  test("a word that only begins like a prefix is an ordinary query", () => {
    const { provider, files } = merged();
    expect(types(provider("session")).slice(0, 4)).toEqual(Array(4).fill("file"));
    expect(types(provider("sessions:x")).slice(0, 4)).toEqual(Array(4).fill("file"));
    expect(files.queries).toEqual(["session", "sessions:x"]);
  });
});

describe("subscribe", () => {
  test("an answer from any source reaches the listener, and release lets go of all three", () => {
    const { provider, files, sessions, commits } = merged();
    let heard = 0;
    const release = provider.subscribe?.(() => {
      heard += 1;
    });
    files.notify();
    sessions.notify();
    commits.notify();
    expect(heard).toBe(3);

    release?.();
    expect([files, sessions, commits].map((s) => s.listenerCount())).toEqual([0, 0, 0]);
    sessions.notify();
    expect(heard).toBe(3);
  });

  test("a source with no subscribe is merged all the same", () => {
    const sessions = source("session", 1);
    const commits = source("commit", 1);
    const provider = mergeMentionProviders({
      files: () => [item("a.ts", "file")],
      sessions: sessions.provider,
      commits: commits.provider,
    });
    let heard = 0;
    provider.subscribe?.(() => {
      heard += 1;
    });
    commits.notify();
    expect(heard).toBe(1);
    expect(types(provider(""))).toEqual(["file", "session", "commit"]);
  });
});
