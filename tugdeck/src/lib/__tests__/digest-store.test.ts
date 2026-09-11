/**
 * Pin the `DigestStore` external-store contract:
 *
 *   - First `getSnapshot` kicks the one-shot `list_digest_lines` tail
 *     request and returns pending.
 *   - `list_digest_lines_ok` settles to ready with decoded lines.
 *   - Live DIGEST frames fold (including while pending), dedupe against
 *     the tail by line identity, and the log caps at 20 oldest-out.
 *   - Snapshots are referentially stable between folds.
 */

import { afterEach, describe, expect, it } from "bun:test";

import {
  DIGEST_LINES_CAP,
  DigestStore,
  groupBeatHistory,
  latestAskForScope,
  latestLineForScope,
  publishListDigestLinesOk,
  turnInFlightForScope,
  type DigestLineEntry,
} from "@/lib/digest-store";
import type { TugConnection } from "@/connection";
import { FeedId, type FeedIdValue } from "@/protocol";

type FrameCallback = (payload: Uint8Array) => void;

class FakeConnection {
  readonly frames: Array<{ feedId: FeedIdValue; payload: Uint8Array }> = [];
  readonly frameSubscribers = new Map<number, FrameCallback[]>();
  send(feedId: FeedIdValue, payload: Uint8Array): void {
    this.frames.push({ feedId, payload });
  }
  onFrame(feedId: number, callback: FrameCallback): () => void {
    const list = this.frameSubscribers.get(feedId) ?? [];
    list.push(callback);
    this.frameSubscribers.set(feedId, list);
    return () => {
      const idx = list.indexOf(callback);
      if (idx >= 0) list.splice(idx, 1);
    };
  }
  pushDigestFrame(line: Record<string, unknown>): void {
    const payload = new TextEncoder().encode(JSON.stringify(line));
    for (const cb of this.frameSubscribers.get(FeedId.DIGEST) ?? []) {
      cb(payload);
    }
  }
}

function makeStore(): { store: DigestStore; conn: FakeConnection } {
  const conn = new FakeConnection();
  const store = new DigestStore(conn as unknown as TugConnection);
  return { store, conn };
}

function wireRow(
  beat: number,
  text: string,
  kind = "tool",
): Record<string, unknown> {
  return { id: beat, at_ms: 1_000 + beat, beat, text, kind, scopes: ["s1"] };
}

function liveLine(beat: number, text: string): Record<string, unknown> {
  return { type: "digest", text, scopes: ["s1"], beat, at: 1_000 + beat };
}

const stores: DigestStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

describe("DigestStore", () => {
  it("first snapshot kicks exactly one tail request and reads pending", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    const first = store.getSnapshot();
    expect(first.status).toBe("pending");
    expect(first.lines.length).toBe(0);
    store.getSnapshot();
    expect(conn.frames.length).toBe(1);
    expect(conn.frames[0].feedId).toBe(FeedId.CONTROL);
    const decoded = JSON.parse(new TextDecoder().decode(conn.frames[0].payload));
    expect(decoded.action).toBe("list_digest_lines");
  });

  it("the tail response settles to ready, oldest-first, latest set", () => {
    const { store } = makeStore();
    stores.push(store);
    store.getSnapshot();
    publishListDigestLinesOk({
      lines: [wireRow(1, "first"), wireRow(2, "second")] as never,
    });
    const snap = store.getSnapshot();
    expect(snap.status).toBe("ready");
    expect(snap.lines.map((l) => l.text)).toEqual(["first", "second"]);
    expect(snap.latest?.text).toBe("second");
    expect(snap.latest?.key).toBe("1002:2");
  });

  it("live frames fold, dedupe against the tail, and survive pending", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    // A live line lands while the tail load is still pending…
    conn.pushDigestFrame(liveLine(2, "second"));
    expect(store.getSnapshot().lines.map((l) => l.text)).toEqual(["second"]);
    // …then the tail arrives carrying the SAME line plus history.
    publishListDigestLinesOk({
      lines: [wireRow(1, "first"), wireRow(2, "second")] as never,
    });
    expect(store.getSnapshot().lines.map((l) => l.text)).toEqual([
      "first",
      "second",
    ]);
    // A fresh live line appends; a duplicate re-delivery does not.
    conn.pushDigestFrame(liveLine(3, "third"));
    conn.pushDigestFrame(liveLine(3, "third"));
    expect(store.getSnapshot().lines.map((l) => l.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(store.getSnapshot().latest?.text).toBe("third");
  });

  it("kind rides both doors — the live fold and the tail hydrate", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    // Both doors carry it, and the tail matters most: a card mounting
    // mid-turn has only the tail, and a restored line with no kind reads as a
    // turn still running ([D187]).
    conn.pushDigestFrame({
      ...liveLine(2, "Writing chain.ts — 9 lines"),
      kind: "tool",
    });
    conn.pushDigestFrame(liveLine(3, "Done"));
    let snap = store.getSnapshot();
    expect(snap.lines[0].kind).toBe("tool");
    // A live frame that carried none still folds — the wire's own field is
    // optional and the store never invents one.
    expect(snap.lines[1].kind).toBeUndefined();
    publishListDigestLinesOk({
      lines: [wireRow(1, "Explore · Reading foo.ts", "tool")] as never,
    });
    snap = store.getSnapshot();
    expect(snap.lines[0].kind).toBe("tool");
  });

  it("the rolling log caps oldest-out", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    for (let beat = 1; beat <= DIGEST_LINES_CAP + 5; beat++) {
      conn.pushDigestFrame(liveLine(beat, `line ${beat}`));
    }
    const snap = store.getSnapshot();
    expect(snap.lines.length).toBe(DIGEST_LINES_CAP);
    expect(snap.lines[0].text).toBe("line 6");
    expect(snap.latest?.text).toBe(`line ${DIGEST_LINES_CAP + 5}`);
  });

  it("the cap is per scope — a chatty session cannot evict a quiet one", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    // One quiet session speaks once, then a chatty one floods past the cap.
    conn.pushDigestFrame({
      type: "digest",
      text: "quiet beat",
      scopes: ["s2"],
      beat: 0,
      at: 1_000,
    });
    for (let beat = 1; beat <= DIGEST_LINES_CAP + 5; beat++) {
      conn.pushDigestFrame(liveLine(beat, `line ${beat}`));
    }
    const snap = store.getSnapshot();
    expect(latestLineForScope(snap.lines, "s2")?.text).toBe("quiet beat");
    // …and the chatty session is still capped at its own window.
    expect(snap.lines.filter((l) => l.scopes.includes("s1")).length).toBe(
      DIGEST_LINES_CAP,
    );
  });

  it("latestLineForScope shows own-session, app-wide, and woven lines only", () => {
    const entry = (
      key: string,
      text: string,
      scopes: string[],
    ): DigestLineEntry => ({ key, text, scopes, beat: 0, atMs: 0 });
    const lines = [
      entry("1", "about session A", ["sess-a"]),
      entry("2", "ambience for everyone", ["app"]),
      entry("3", "A and B weave", ["sess-a", "sess-b"]),
      entry("4", "about session B", ["sess-b"]),
    ];
    // Card B sees its own newest line — never A's.
    expect(latestLineForScope(lines, "sess-b")?.text).toBe("about session B");
    // Card A's newest match is the woven line (it covers A).
    expect(latestLineForScope(lines, "sess-a")?.text).toBe("A and B weave");
    // A brand-new session never wears another session's line; its
    // newest match is the app-wide ambience (tugcode never emits
    // "app"-scoped lines, so in practice a fresh session reads None).
    expect(latestLineForScope(lines, "sess-new")?.text).toBe(
      "ambience for everyone",
    );
    expect(latestLineForScope([lines[0], lines[3]], "sess-new")).toBeNull();
    // No bound session → nothing.
    expect(latestLineForScope(lines, "")).toBeNull();
    // Scope-less lines are ambience.
    expect(latestLineForScope([entry("5", "bare", [])], "sess-x")?.text).toBe("bare");
  });

  it("snapshots are referentially stable between folds", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    const a = store.getSnapshot();
    const b = store.getSnapshot();
    expect(a).toBe(b);
    conn.pushDigestFrame(liveLine(1, "one"));
    const c = store.getSnapshot();
    expect(c).not.toBe(b);
    expect(store.getSnapshot()).toBe(c);
    // Malformed / foreign frames change nothing.
    conn.pushDigestFrame({ type: "not_digest" });
    expect(store.getSnapshot()).toBe(c);
  });
});

describe("groupBeatHistory", () => {
  const beat = (key: string, text: string, atMs = 0): DigestLineEntry => ({
    key,
    text,
    scopes: ["s1"],
    beat: 0,
    atMs,
  });
  const post = (atMs: number, text: string) => ({ atMs, text });

  it("collapses the run of beats under one post into a single group", () => {
    const groups = groupBeatHistory(
      [
        beat("1", "Explore · Reading a.ts", 300),
        beat("2", "Explore · Reading b.ts", 200),
        beat("3", "Explore · Running grep", 100),
      ],
      [post(50, "Mapping the reducer seam.")],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].heading).toBe("Mapping the reducer seam.");
    expect(groups[0].beats.map((b) => b.text)).toEqual([
      "Explore · Reading a.ts",
      "Explore · Reading b.ts",
      "Explore · Running grep",
    ]);
  });

  it("starts a new group at each post the beats crossed", () => {
    const groups = groupBeatHistory(
      [
        beat("1", "Reading c.ts", 300),
        beat("2", "Reading b.ts", 200),
        beat("3", "Reading a.ts", 160),
      ],
      [post(250, "Second post."), post(150, "First post.")],
    );
    expect(groups.map((g) => g.heading)).toEqual([
      "Second post.",
      "First post.",
    ]);
    expect(groups[0].beats.map((b) => b.key)).toEqual(["1"]);
    expect(groups[1].beats.map((b) => b.key)).toEqual(["2", "3"]);
  });

  it("heads nothing over the beats that ran before the first post", () => {
    // The ordinary opening of a turn: work is happening and nothing has been
    // written about it yet.
    const groups = groupBeatHistory(
      [
        beat("1", "Reading b.ts", 300),
        beat("2", "Reading a.ts", 200),
        beat("3", "asked: Rewire the chain", 100),
      ],
      [post(250, "Rewiring the responder chain.")],
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].heading).toBe("Rewiring the responder chain.");
    expect(groups[1].heading).toBeUndefined();
    expect(groups[1].beats.map((b) => b.key)).toEqual(["2", "3"]);
  });

  it("heads nothing at all when no post has been written", () => {
    const groups = groupBeatHistory([beat("1", "Reading a.ts", 100)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].heading).toBeUndefined();
  });

  it("returns no groups for an empty list", () => {
    expect(groupBeatHistory([])).toEqual([]);
  });
});

describe("latestAskForScope", () => {
  const line = (
    key: string,
    text: string,
    kind: string,
    scope: string,
  ): DigestLineEntry => ({
    key,
    text,
    kind,
    scopes: [scope],
    beat: Number(key),
    atMs: Number(key),
  });

  it("answers with the newest ask, over a newer beat of any other kind", () => {
    const lines = [
      line("1", "asked: The first question", "ask", "s1"),
      line("2", "asked: The second question", "ask", "s1"),
      line("3", "Reading a.ts", "tool", "s1"),
      line("4", "Done", "turn", "s1"),
    ];
    expect(latestAskForScope(lines, "s1")?.text).toBe(
      "asked: The second question",
    );
  });

  it("never answers with another session's ask", () => {
    const lines = [
      line("1", "asked: Mine", "ask", "s1"),
      line("2", "asked: Theirs", "ask", "s2"),
    ];
    expect(latestAskForScope(lines, "s1")?.text).toBe("asked: Mine");
    expect(latestAskForScope(lines, "s3")).toBeNull();
  });

  it("answers null for a scope that has never been asked anything", () => {
    expect(latestAskForScope([], "s1")).toBeNull();
    expect(
      latestAskForScope([line("1", "Reading a.ts", "tool", "s1")], "s1"),
    ).toBeNull();
  });

  it("skips an ask the scope's clear watermark covers", () => {
    const lines = [line("1", "asked: Before the clear", "ask", "s1")];
    expect(latestAskForScope(lines, "s1", new Set(["1"]))).toBeNull();
  });
});

describe("turnInFlightForScope", () => {
  const line = (
    key: string,
    text: string,
    kind: string | undefined,
    scope: string,
  ): DigestLineEntry => ({
    key,
    text,
    ...(kind !== undefined ? { kind } : {}),
    scopes: [scope],
    beat: Number(key),
    atMs: Number(key),
  });

  it("reads a turn marker as the turn having ended", () => {
    const lines = [
      line("1", "asked: Something", "ask", "s1"),
      line("2", "Reading a.ts", "tool", "s1"),
      line("3", "Done", "turn", "s1"),
    ];
    expect(turnInFlightForScope(lines, "s1")).toBe(false);
  });

  it("reads any other in-turn line as a turn running", () => {
    const lines = [
      line("1", "Done", "turn", "s1"),
      line("2", "asked: Something else", "ask", "s1"),
    ];
    expect(turnInFlightForScope(lines, "s1")).toBe(true);
  });

  it("walks past a shell command run beside an idle transcript", () => {
    // The defect this function exists for: one `$ ls` after a turn ended left
    // the masthead's ladder pinned to a stale Observer post indefinitely.
    const lines = [
      line("1", "asked: Something", "ask", "s1"),
      line("2", "Done", "turn", "s1"),
      line("3", "$ ls", "shell", "s1"),
    ];
    expect(turnInFlightForScope(lines, "s1")).toBe(false);
  });

  it("walks past a background job's notice landing after the turn", () => {
    const lines = [
      line("1", "Done", "turn", "s1"),
      line("2", "Background job finished", "notice", "s1"),
    ];
    expect(turnInFlightForScope(lines, "s1")).toBe(false);
  });

  it("still reads a turn as running when only out-of-turn lines follow an in-turn one", () => {
    const lines = [
      line("1", "Reading a.ts", "tool", "s1"),
      line("2", "$ ls", "shell", "s1"),
    ];
    expect(turnInFlightForScope(lines, "s1")).toBe(true);
  });

  it("answers false for a scope the digest has never spoken about", () => {
    expect(turnInFlightForScope([], "s1")).toBe(false);
    expect(
      turnInFlightForScope([line("1", "Reading a.ts", "tool", "s2")], "s1"),
    ).toBe(false);
  });

  it("answers false for an empty scope and for a line carrying no kind", () => {
    expect(turnInFlightForScope([line("1", "x", "tool", "s1")], "")).toBe(
      false,
    );
    expect(
      turnInFlightForScope([line("1", "Reading a.ts", undefined, "s1")], "s1"),
    ).toBe(false);
  });

  it("ignores lines the scope's clear watermark covers", () => {
    const lines = [
      line("1", "Done", "turn", "s1"),
      line("2", "Reading a.ts", "tool", "s1"),
    ];
    expect(turnInFlightForScope(lines, "s1")).toBe(true);
    expect(turnInFlightForScope(lines, "s1", new Set(["2"]))).toBe(false);
  });
});

describe("clearScope", () => {
  it("hides existing lines for the scope until a new one arrives", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    conn.pushDigestFrame(liveLine(1, "before submit"));
    let snap = store.getSnapshot();
    expect(
      latestLineForScope(snap.lines, "s1", snap.cleared.get("s1"))?.text,
    ).toBe("before submit");

    store.clearScope("s1");
    snap = store.getSnapshot();
    expect(
      latestLineForScope(snap.lines, "s1", snap.cleared.get("s1")),
    ).toBeNull();

    conn.pushDigestFrame(liveLine(2, "fresh commentary"));
    snap = store.getSnapshot();
    expect(
      latestLineForScope(snap.lines, "s1", snap.cleared.get("s1"))?.text,
    ).toBe("fresh commentary");
  });

  it("clearing one scope leaves another scope's view intact", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    conn.pushDigestFrame({ type: "digest", text: "s2 line", scopes: ["s2"], beat: 1, at: 1_001 });
    store.clearScope("s1");
    const snap = store.getSnapshot();
    expect(
      latestLineForScope(snap.lines, "s2", snap.cleared.get("s2"))?.text,
    ).toBe("s2 line");
  });
});
