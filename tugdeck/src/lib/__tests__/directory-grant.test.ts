/**
 * The bulletin a `/add-dir` grant earns is read off two stores: the grant's
 * answer on the Session card's snapshot, and the folder list on the metadata
 * snapshot. "Added" is said only once both agree; a refusal is said with
 * tugcode's reason; an answer for another folder is not this grant's.
 *
 * A removal is read the same way, backwards: "removed" only once tugcode's
 * answer is in and the folder has left the list. Where a listed folder comes
 * from is classified against the rules the settings scopes hold, which
 * decides whether it can be removed and whether its local rule goes too.
 */

import { describe, expect, test } from "bun:test";
import {
  awaitDirectoryGrant,
  awaitDirectoryRemoval,
  classifyDirectory,
  directoryRemover,
  foreignDirectoryNote,
  normalizeDirectory,
  registerDirectoryRemover,
  removalConsequence,
  removalQuestion,
  removalRefusal,
  removeDirectory,
  type DirectoryRemover,
} from "@/lib/directory-grant";
import { resolveDirectoryTarget } from "@/lib/directory-change";
import { matchLocalSlashCommand } from "@/lib/slash-commands";
import { openSessionSummary, registerSessionSummaryOpener } from "@/lib/session-summary-door";
import type { DirectoryResultSnapshot } from "@/lib/code-session-store/types";
import { emptyPermissionsSnapshot, type PermissionsSnapshot } from "@/lib/permission-rules";

/** A minimal external store over one snapshot. */
class Box<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): T => this.value;
  set(value: T): void {
    this.value = value;
    for (const listener of [...this.listeners]) listener();
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}

function stores(prior: DirectoryResultSnapshot | null = null, dirs: string[] = []) {
  return {
    grants: new Box<{ lastDirectoryResult: DirectoryResultSnapshot | null }>({ lastDirectoryResult: prior }),
    directories: new Box<{ additionalDirectories: readonly string[] }>({ additionalDirectories: dirs }),
  };
}

/** Whether `promise` has settled, after the microtask queue drains. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return done;
}

describe("awaitDirectoryGrant", () => {
  test("granted once the answer is in and the folder is in the list", async () => {
    const s = stores();
    const wait = awaitDirectoryGrant({ ...s, directory: "/u/shared/" });
    s.directories.set({ additionalDirectories: ["/u/shared"] });
    expect(await settled(wait)).toBe(false);
    s.grants.set({ lastDirectoryResult: { op: "add", directory: "/u/shared/", ok: true, reason: null } });
    expect(await wait).toEqual({ ok: true, directory: "/u/shared" });
    expect(s.grants.listenerCount + s.directories.listenerCount).toBe(0);
  });

  test("a granted answer waits for the folder to reach the list", async () => {
    const s = stores();
    const wait = awaitDirectoryGrant({ ...s, directory: "/u/shared" });
    s.grants.set({ lastDirectoryResult: { op: "add", directory: "/u/shared", ok: true, reason: null } });
    expect(await settled(wait)).toBe(false);
    s.directories.set({ additionalDirectories: ["/u/other", "/u/shared"] });
    expect((await wait).ok).toBe(true);
  });

  test("a refusal ends the wait with tugcode's reason", async () => {
    const s = stores();
    const wait = awaitDirectoryGrant({ ...s, directory: "/u/missing" });
    s.grants.set({
      lastDirectoryResult: { op: "add", directory: "/u/missing", ok: false, reason: "/u/missing does not exist" },
    });
    expect(await wait).toEqual({ ok: false, directory: "/u/missing", reason: "/u/missing does not exist" });
  });

  test("the answer already on the snapshot is the last grant's, not this one's", async () => {
    const prior: DirectoryResultSnapshot = { op: "add", directory: "/u/shared", ok: true, reason: null };
    const s = stores(prior, ["/u/shared"]);
    const wait = awaitDirectoryGrant({ ...s, directory: "/u/shared" });
    expect(await settled(wait)).toBe(false);
    s.grants.set({ lastDirectoryResult: { ...prior } });
    expect((await wait).ok).toBe(true);
  });

  test("an answer for another folder is not this grant's", async () => {
    const s = stores();
    const wait = awaitDirectoryGrant({ ...s, directory: "/u/a" });
    s.grants.set({ lastDirectoryResult: { op: "add", directory: "/u/b", ok: false, reason: "nope" } });
    expect(await settled(wait)).toBe(false);
    s.directories.set({ additionalDirectories: ["/u/a"] });
    s.grants.set({ lastDirectoryResult: { op: "add", directory: "/u/a", ok: true, reason: null } });
    expect((await wait).ok).toBe(true);
  });

  test("a removal's answer for the same folder is not this grant's", async () => {
    const s = stores();
    const wait = awaitDirectoryGrant({ ...s, directory: "/u/a" });
    s.grants.set({ lastDirectoryResult: { op: "remove", directory: "/u/a", ok: false, reason: "nope" } });
    expect(await settled(wait)).toBe(false);
    s.directories.set({ additionalDirectories: ["/u/a"] });
    s.grants.set({ lastDirectoryResult: { op: "add", directory: "/u/a", ok: true, reason: null } });
    expect((await wait).ok).toBe(true);
  });
});

describe("normalizeDirectory", () => {
  test("drops trailing slashes and keeps the root", () => {
    expect(normalizeDirectory("/u/a//")).toBe("/u/a");
    expect(normalizeDirectory("/")).toBe("/");
    expect(normalizeDirectory("//")).toBe("/");
  });
});

describe("awaitDirectoryRemoval", () => {
  test("removed only once the answer is in and the folder has left the list", async () => {
    const s = stores(null, ["/u/a", "/u/shared"]);
    const wait = awaitDirectoryRemoval({ results: s.grants, directories: s.directories, directory: "/u/shared/" });
    s.grants.set({ lastDirectoryResult: { op: "remove", directory: "/u/shared", ok: true, reason: null } });
    expect(await settled(wait)).toBe(false);
    s.directories.set({ additionalDirectories: ["/u/a"] });
    expect(await wait).toEqual({ ok: true, directory: "/u/shared" });
    expect(s.grants.listenerCount + s.directories.listenerCount).toBe(0);
  });

  test("a list without the folder is not removed until tugcode answers", async () => {
    const s = stores(null, ["/u/shared"]);
    const wait = awaitDirectoryRemoval({ results: s.grants, directories: s.directories, directory: "/u/shared" });
    s.directories.set({ additionalDirectories: [] });
    expect(await settled(wait)).toBe(false);
    s.grants.set({ lastDirectoryResult: { op: "remove", directory: "/u/shared", ok: true, reason: null } });
    expect((await wait).ok).toBe(true);
  });

  test("a refused removal is reported with tugcode's reason", async () => {
    const s = stores(null, ["/u/a"]);
    const wait = awaitDirectoryRemoval({ results: s.grants, directories: s.directories, directory: "/u/a" });
    s.grants.set({
      lastDirectoryResult: { op: "remove", directory: "/u/a", ok: false, reason: "/u/a can be removed only between turns" },
    });
    expect(await wait).toEqual({ ok: false, directory: "/u/a", reason: "/u/a can be removed only between turns" });
  });

  test("a grant's answer for the same folder is not this removal's", async () => {
    const s = stores(null, ["/u/a"]);
    const wait = awaitDirectoryRemoval({ results: s.grants, directories: s.directories, directory: "/u/a" });
    s.grants.set({ lastDirectoryResult: { op: "add", directory: "/u/a", ok: false, reason: "nope" } });
    expect(await settled(wait)).toBe(false);
  });
});

/** A rules snapshot with `additionalDirectories` set per scope. */
function rules(dirs: Partial<Record<"user" | "project" | "local", string[]>>): PermissionsSnapshot {
  const snap = emptyPermissionsSnapshot("/u/proj");
  for (const scope of ["user", "project", "local"] as const) {
    snap.scopes[scope] = { ...snap.scopes[scope], additionalDirectories: dirs[scope] ?? [] };
  }
  return snap;
}

describe("classifyDirectory", () => {
  const listed = ["/u/a", "/u/b"];

  test("a grant held nowhere else is the session's", () => {
    expect(
      classifyDirectory({ directory: "/u/a/", sessionDirectories: listed, rules: rules({}), home: "/Users/me" }),
    ).toEqual({ kind: "session" });
  });

  test("a grant the local settings also hold is remembered, with the rule as the file spells it", () => {
    expect(
      classifyDirectory({
        directory: "/Users/me/notes",
        sessionDirectories: ["/Users/me/notes"],
        rules: rules({ local: ["~/notes/"] }),
        home: "/Users/me",
      }),
    ).toEqual({ kind: "remembered", rule: "~/notes/" });
  });

  test("a folder user or shared project settings grant is foreign, whatever local holds", () => {
    expect(
      classifyDirectory({ directory: "/u/a", sessionDirectories: listed, rules: rules({ user: ["/u/a"], local: ["/u/a"] }), home: null }),
    ).toEqual({ kind: "foreign", scope: "user" });
    expect(
      classifyDirectory({ directory: "/u/b", sessionDirectories: listed, rules: rules({ project: ["/u/b"] }), home: null }),
    ).toEqual({ kind: "foreign", scope: "project" });
  });

  test("a folder the session's list does not hold is not held", () => {
    expect(
      classifyDirectory({ directory: "/u/c", sessionDirectories: listed, rules: rules({ local: ["/u/c"] }), home: null }),
    ).toEqual({ kind: "not-held" });
  });

  test("a relative settings entry matches no folder", () => {
    expect(
      classifyDirectory({ directory: "/u/a", sessionDirectories: listed, rules: rules({ user: ["a"] }), home: null }),
    ).toEqual({ kind: "session" });
  });
});

/** A code-session-store stand-in that answers each removal from `answer`. */
function removalStore(
  s: ReturnType<typeof stores>,
  answer: (directory: string) => DirectoryResultSnapshot,
  leave = true,
) {
  return {
    subscribe: s.grants.subscribe,
    getSnapshot: s.grants.getSnapshot,
    removeDirectory(directory: string) {
      const result = answer(directory);
      if (result.ok && leave) {
        s.directories.set({
          additionalDirectories: s.directories.getSnapshot().additionalDirectories.filter((d) => d !== directory),
        });
      }
      s.grants.set({ lastDirectoryResult: result });
    },
  };
}

describe("removeDirectory", () => {
  const done = (directory: string): DirectoryResultSnapshot => ({ op: "remove", directory, ok: true, reason: null });

  test("a session folder is removed through tugcode and touches no settings", async () => {
    const s = stores(null, ["/u/a"]);
    let forgot = null as string | null;
    const outcome = await removeDirectory({
      store: removalStore(s, done),
      directories: s.directories,
      cwd: "/u/proj",
      directory: "/u/a",
      origin: { kind: "session" },
      forget: async (_cwd, rule) => {
        forgot = rule;
        return true;
      },
    });
    expect(outcome).toEqual({ ok: true, directory: "/u/a" });
    expect(forgot).toBeNull();
  });

  test("a remembered folder's rule leaves local settings too, as the file spells it", async () => {
    const s = stores(null, ["/u/a"]);
    let forgot = null as string | null;
    const outcome = await removeDirectory({
      store: removalStore(s, done),
      directories: s.directories,
      cwd: "/u/proj",
      directory: "/u/a",
      origin: { kind: "remembered", rule: "/u/a/" },
      forget: async (_cwd, rule) => {
        forgot = rule;
        return true;
      },
    });
    expect(outcome.ok).toBe(true);
    expect(forgot).toBe("/u/a/");
  });

  test("a remembered folder whose rule cannot be removed is not said removed", async () => {
    const s = stores(null, ["/u/a"]);
    const outcome = await removeDirectory({
      store: removalStore(s, done),
      directories: s.directories,
      cwd: "/u/proj",
      directory: "/u/a",
      origin: { kind: "remembered", rule: "/u/a" },
      forget: async () => false,
    });
    expect(outcome).toEqual({ ok: false, directory: "/u/a", reason: "the project's local settings still include it" });
  });

  test("a refused removal leaves the settings alone", async () => {
    const s = stores(null, ["/u/a"]);
    let forgot = false;
    const outcome = await removeDirectory({
      store: removalStore(s, (directory) => ({ op: "remove", directory, ok: false, reason: "no" })),
      directories: s.directories,
      cwd: "/u/proj",
      directory: "/u/a",
      origin: { kind: "remembered", rule: "/u/a" },
      forget: async () => {
        forgot = true;
        return true;
      },
    });
    expect(outcome).toEqual({ ok: false, directory: "/u/a", reason: "no" });
    expect(forgot).toBe(false);
  });

  test("a foreign or unheld folder is refused without asking tugcode", async () => {
    const s = stores(null, ["/u/a"]);
    // Sending would throw, so a refusal that reached tugcode fails the test.
    const store = {
      ...removalStore(s, done),
      removeDirectory: (): void => {
        throw new Error("a refused folder was sent to tugcode");
      },
    };
    const foreign = await removeDirectory({
      store,
      directories: s.directories,
      cwd: "/u/proj",
      directory: "/u/a",
      origin: { kind: "foreign", scope: "user" },
    });
    const unheld = await removeDirectory({
      store,
      directories: s.directories,
      cwd: "/u/proj",
      directory: "/u/c",
      origin: { kind: "not-held" },
    });
    expect(foreign).toEqual({
      ok: false,
      directory: "/u/a",
      reason: "/u/a comes from the user settings; remove it in Permission Rules",
    });
    expect(unheld).toEqual({ ok: false, directory: "/u/c", reason: "this session doesn't hold /u/c" });
  });
});

describe("removalQuestion / foreignDirectoryNote", () => {
  test("a session folder's question says this session", () => {
    expect(removalQuestion({ shown: "~/shared", origin: { kind: "session" }, project: "~/proj" })).toBe(
      "Remove this directory?\n~/shared is no longer readable or writable by this session.",
    );
  });

  test("a remembered folder's question names the project's future sessions", () => {
    expect(
      removalQuestion({ shown: "~/shared", origin: { kind: "remembered", rule: "~/shared" }, project: "~/proj" }),
    ).toBe(
      "Remove this directory?\n~/shared is no longer readable or writable by this session or by future ~/proj sessions.",
    );
  });

  test("a foreign folder's note names its scope and points at Permission Rules", () => {
    expect(foreignDirectoryNote("user")).toBe("Granted by your user settings; remove it in Permission Rules");
    expect(foreignDirectoryNote("project")).toBe(
      "Granted by the project's shared settings; remove it in Permission Rules",
    );
  });
});

describe("registerDirectoryRemover", () => {
  const remover = (): DirectoryRemover => ({ ready: () => true, remove: async () => {} });

  test("a card's removal is found under its id until it withdraws it", () => {
    const lent = remover();
    const withdraw = registerDirectoryRemover("card-a", lent);
    expect(directoryRemover("card-a")).toBe(lent);
    expect(directoryRemover("card-b")).toBeUndefined();
    withdraw();
    expect(directoryRemover("card-a")).toBeUndefined();
  });

  test("a stale withdraw leaves a newer registration in place", () => {
    const first = remover();
    const second = remover();
    const withdrawFirst = registerDirectoryRemover("card-c", first);
    const withdrawSecond = registerDirectoryRemover("card-c", second);
    withdrawFirst();
    expect(directoryRemover("card-c")).toBe(second);
    withdrawSecond();
  });
});

describe("/remove-dir", () => {
  const home = "/Users/me";
  const target = (args: string): string | null =>
    resolveDirectoryTarget({ atomPath: null, argText: args, projectDir: "/u/proj", home });

  test("is a local command that takes its folder as an argument", () => {
    expect(matchLocalSlashCommand("/remove-dir ~/shared")).toEqual({ name: "remove-dir", args: "~/shared" });
    expect(matchLocalSlashCommand("/remove-dir")).toEqual({ name: "remove-dir", args: "" });
  });

  test("reads its folder the way /add-dir does, and bare names none", () => {
    expect(target("~/shared")).toBe("/Users/me/shared");
    expect(target("/u/shared/")).toBe("/u/shared");
    expect(target("../shared")).toBe("/u/shared");
    expect(target("")).toBeNull();
  });

  test("a folder the session doesn't hold is a caution", () => {
    expect(removalRefusal({ kind: "not-held" }, "~/shared")).toBe("This session doesn't hold ~/shared");
  });

  test("a folder another scope grants is a caution naming that scope", () => {
    expect(removalRefusal({ kind: "foreign", scope: "user" }, "~/shared")).toBe(
      "Can't remove ~/shared. Granted by your user settings; remove it in Permission Rules",
    );
    expect(removalRefusal({ kind: "foreign", scope: "project" }, "~/shared")).toBe(
      "Can't remove ~/shared. Granted by the project's shared settings; remove it in Permission Rules",
    );
  });

  test("a session or remembered folder is asked about, with the Summary's own words", () => {
    expect(removalRefusal({ kind: "session" }, "~/shared")).toBeNull();
    expect(removalRefusal({ kind: "remembered", rule: "~/shared" }, "~/shared")).toBeNull();
    expect(removalConsequence({ shown: "~/shared", origin: { kind: "session" }, project: "~/proj" })).toBe(
      "~/shared is no longer readable or writable by this session.",
    );
  });
});

describe("session summary door", () => {
  test("opens the Summary its card's masthead registered, and nothing for another card", () => {
    let opened = 0;
    const withdraw = registerSessionSummaryOpener("card-s", () => {
      opened += 1;
      return true;
    });
    expect(openSessionSummary("card-s")).toBe(true);
    expect(opened).toBe(1);
    expect(openSessionSummary("card-t")).toBe(false);
    withdraw();
    expect(openSessionSummary("card-s")).toBe(false);
  });
});
