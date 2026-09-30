/**
 * directory-change.test.ts — the pure halves of `/cd`: which moves are
 * refused, where a `/cd` points, and how a spawn ack or error settles a
 * pending move.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { TugConnection } from "../../connection";
import type { CardSessionBinding } from "../card-session-binding-store";
import {
  _resetDirectoryChangeForTests,
  beginDirectoryChange,
  directoryChangeRefusal,
  firstPathAtomValue,
  resolveDirectoryTarget,
  settleDirectoryChangeAck,
  settleDirectoryChangeError,
} from "../directory-change";
import type { DraftAtom } from "../slash-commands";

afterEach(() => _resetDirectoryChangeForTests());

describe("directoryChangeRefusal", () => {
  test("an arc-bound card is refused, naming the arc", () => {
    expect(
      directoryChangeRefusal({ arcName: "lens", currentDir: "/a", targetDir: "/b" }),
    ).toBe("Can't change the directory of a card bound to arc lens");
  });

  test("the directory the card is already in is refused, trailing slash or not", () => {
    expect(
      directoryChangeRefusal({ arcName: null, currentDir: "/work/a", targetDir: "/work/a" }),
    ).toBe("Already in /work/a");
    expect(
      directoryChangeRefusal({ arcName: null, currentDir: "/work/a/", targetDir: "/work/a" }),
    ).toBe("Already in /work/a");
    expect(
      directoryChangeRefusal({ arcName: null, currentDir: "/work/a", targetDir: "/work/a//" }),
    ).toBe("Already in /work/a");
  });

  test("another directory on an unbound card is not refused", () => {
    expect(
      directoryChangeRefusal({ arcName: null, currentDir: "/work/a", targetDir: "/work/b" }),
    ).toBeNull();
  });

  test("with no target yet, only the arc binding refuses", () => {
    expect(
      directoryChangeRefusal({ arcName: "lens", currentDir: "/work/a", targetDir: null }),
    ).toBe("Can't change the directory of a card bound to arc lens");
    expect(
      directoryChangeRefusal({ arcName: null, currentDir: "/work/a", targetDir: null }),
    ).toBeNull();
  });
});

describe("resolveDirectoryTarget", () => {
  const base = { projectDir: "/work/a", home: "/Users/me" };

  test("the atom wins over the text", () => {
    expect(
      resolveDirectoryTarget({ ...base, atomPath: "/elsewhere", argText: "/ignored" }),
    ).toBe("/elsewhere");
  });

  test("a relative atom resolves against the project directory", () => {
    expect(resolveDirectoryTarget({ ...base, atomPath: "sub/dir", argText: "" })).toBe(
      "/work/a/sub/dir",
    );
  });

  test("a relative argument resolves against the project directory", () => {
    expect(resolveDirectoryTarget({ ...base, atomPath: null, argText: "  ../b  " })).toBe(
      "/work/b",
    );
  });

  test("an absolute argument is normalized", () => {
    expect(resolveDirectoryTarget({ ...base, atomPath: null, argText: "/x/./y/" })).toBe(
      "/x/y",
    );
  });

  test("a leading ~ expands to home", () => {
    expect(resolveDirectoryTarget({ ...base, atomPath: null, argText: "~/x" })).toBe(
      "/Users/me/x",
    );
    expect(resolveDirectoryTarget({ ...base, atomPath: null, argText: "~" })).toBe(
      "/Users/me",
    );
  });

  test("an empty argument with no atom yields null", () => {
    expect(resolveDirectoryTarget({ ...base, atomPath: null, argText: "   " })).toBeNull();
  });
});

describe("firstPathAtomValue", () => {
  const atom = (type: string, value: string, position: number): DraftAtom => ({
    position,
    segment: { kind: "atom", type, label: value, value },
  });

  test("answers the first file or directory atom, skipping others", () => {
    expect(
      firstPathAtomValue([
        atom("command", "cd", 0),
        atom("directory", "/work/b", 4),
        atom("file", "/work/c", 6),
      ]),
    ).toBe("/work/b");
  });

  test("answers null with no path atom", () => {
    expect(firstPathAtomValue([atom("command", "cd", 0)])).toBeNull();
  });
});

describe("settling a pending move", () => {
  const sent: Array<Record<string, unknown>> = [];
  const connection = {
    send: (_feed: number, payload: Uint8Array) => {
      sent.push(JSON.parse(new TextDecoder().decode(payload)));
    },
  } as unknown as TugConnection;
  const binding: CardSessionBinding = {
    tugSessionId: "old-session",
    lineId: "line-1",
    workspaceKey: "/work/a",
    projectDir: "/work/a",
    sessionMode: "new",
  };

  function begin(): string {
    sent.length = 0;
    beginDirectoryChange({ cardId: "card-1", binding, targetDir: "/work/b", connection });
    expect(sent).toHaveLength(1);
    return sent[0]!.tug_session_id as string;
  }

  test("the move spawns in the target, names the old session, and closes nothing", () => {
    const newId = begin();
    expect(sent[0]).toMatchObject({
      action: "spawn_session",
      card_id: "card-1",
      project_dir: "/work/b",
      session_mode: "new",
      relocate_from: "old-session",
    });
    expect(newId).not.toBe("old-session");
  });

  test("an ack for another session is a no-op; the move's own ack answers the target once", () => {
    const newId = begin();
    expect(settleDirectoryChangeAck("card-1", "someone-else")).toBeNull();
    expect(settleDirectoryChangeAck("card-2", newId)).toBeNull();
    expect(settleDirectoryChangeAck("card-1", newId)).toBe("/work/b");
    expect(settleDirectoryChangeAck("card-1", newId)).toBeNull();
  });

  test("an error clears the move and answers the detail", () => {
    const newId = begin();
    expect(settleDirectoryChangeError("card-1", "no such directory")).toBe(
      "no such directory",
    );
    expect(settleDirectoryChangeAck("card-1", newId)).toBeNull();
    expect(settleDirectoryChangeError("card-1", "again")).toBeNull();
  });
});
