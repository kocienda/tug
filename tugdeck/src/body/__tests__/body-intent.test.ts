/**
 * What a body reads from the intent the host hands it at bind: every kind
 * the shell sends, and nothing else. A kind with no session is bound with
 * `mount`, which carries the card's state as the shell held it, when it held
 * any, and replays nothing.
 *
 * @covers tugdeck/src/body/body-intent.ts
 */
import { describe, expect, test } from "bun:test";
import type { TugConnection } from "../../connection";
import { parseBodyIntent, replayBodyIntent } from "../body-intent";

describe("parseBodyIntent", () => {
  test("a mount intent is itself", () => {
    expect(parseBodyIntent({ kind: "mount" })).toEqual({ kind: "mount" });
  });

  test("a mount intent keeps the bag the shell handed over, and drops one that is not an object", () => {
    const bag = { content: { path: "/p/notes.md" } };
    expect(parseBodyIntent({ kind: "mount", bag })).toEqual({ kind: "mount", bag });
    expect(parseBodyIntent({ kind: "mount", bag: "nope" })).toEqual({ kind: "mount" });
  });

  test("a restore intent is itself", () => {
    expect(parseBodyIntent({ kind: "restore" })).toEqual({ kind: "restore" });
  });

  test("an unknown kind, or no object at all, is not an intent", () => {
    expect(parseBodyIntent({ kind: "teleport" })).toBeNull();
    expect(parseBodyIntent(null)).toBeNull();
    expect(parseBodyIntent("mount")).toBeNull();
  });

  test("a resume without its session is not an intent", () => {
    expect(parseBodyIntent({ kind: "resume", projectDir: "/p" })).toBeNull();
  });
});

describe("replayBodyIntent", () => {
  test("a mount intent touches neither the connection nor the deck", () => {
    // Every member throws: a replay that reached for any of them fails here.
    const connection = new Proxy({}, {
      get: () => {
        throw new Error("a mount intent used the connection");
      },
    }) as unknown as TugConnection;
    const deck = {
      getSnapshot: () => {
        throw new Error("a mount intent read the deck");
      },
    };
    expect(() => replayBodyIntent({ kind: "mount" }, "c1", connection, deck)).not.toThrow();
  });
});
