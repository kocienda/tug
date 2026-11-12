/**
 * The bulletin a `/add-dir` grant earns is read off two stores: the grant's
 * answer on the Session card's snapshot, and the folder list on the metadata
 * snapshot. "Added" is said only once both agree; a refusal is said with
 * tugcode's reason; an answer for another folder is not this grant's.
 */

import { describe, expect, test } from "bun:test";
import { awaitDirectoryGrant, normalizeDirectory } from "@/lib/directory-grant";
import type { DirectoryGrantSnapshot } from "@/lib/code-session-store/types";

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

function stores(prior: DirectoryGrantSnapshot | null = null, dirs: string[] = []) {
  return {
    grants: new Box<{ lastDirectoryGrant: DirectoryGrantSnapshot | null }>({ lastDirectoryGrant: prior }),
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
    s.grants.set({ lastDirectoryGrant: { directory: "/u/shared/", ok: true, reason: null } });
    expect(await wait).toEqual({ ok: true, directory: "/u/shared" });
    expect(s.grants.listenerCount + s.directories.listenerCount).toBe(0);
  });

  test("a granted answer waits for the folder to reach the list", async () => {
    const s = stores();
    const wait = awaitDirectoryGrant({ ...s, directory: "/u/shared" });
    s.grants.set({ lastDirectoryGrant: { directory: "/u/shared", ok: true, reason: null } });
    expect(await settled(wait)).toBe(false);
    s.directories.set({ additionalDirectories: ["/u/other", "/u/shared"] });
    expect((await wait).ok).toBe(true);
  });

  test("a refusal ends the wait with tugcode's reason", async () => {
    const s = stores();
    const wait = awaitDirectoryGrant({ ...s, directory: "/u/missing" });
    s.grants.set({
      lastDirectoryGrant: { directory: "/u/missing", ok: false, reason: "/u/missing does not exist" },
    });
    expect(await wait).toEqual({ ok: false, directory: "/u/missing", reason: "/u/missing does not exist" });
  });

  test("the answer already on the snapshot is the last grant's, not this one's", async () => {
    const prior: DirectoryGrantSnapshot = { directory: "/u/shared", ok: true, reason: null };
    const s = stores(prior, ["/u/shared"]);
    const wait = awaitDirectoryGrant({ ...s, directory: "/u/shared" });
    expect(await settled(wait)).toBe(false);
    s.grants.set({ lastDirectoryGrant: { ...prior } });
    expect((await wait).ok).toBe(true);
  });

  test("an answer for another folder is not this grant's", async () => {
    const s = stores();
    const wait = awaitDirectoryGrant({ ...s, directory: "/u/a" });
    s.grants.set({ lastDirectoryGrant: { directory: "/u/b", ok: false, reason: "nope" } });
    expect(await settled(wait)).toBe(false);
    s.directories.set({ additionalDirectories: ["/u/a"] });
    s.grants.set({ lastDirectoryGrant: { directory: "/u/a", ok: true, reason: null } });
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
