/**
 * Pin the `PulseStore` external-store contract:
 *
 *   - First `getSnapshot` kicks the one-shot `list_pulse_lines` tail
 *     request and returns pending.
 *   - `list_pulse_lines_ok` settles to ready with decoded lines.
 *   - Live PULSE frames fold (including while pending), dedupe against
 *     the tail by line identity, and the log caps at 20 oldest-out.
 *   - Snapshots are referentially stable between folds.
 */

import { afterEach, describe, expect, it } from "bun:test";

import {
  PULSE_LINES_CAP,
  PulseStore,
  groupPulseHistory,
  latestLineForScope,
  latestPulseOverviewForScope,
  publishListPulseLinesOk,
  type PulseLineEntry,
} from "@/lib/pulse-store";
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
  pushPulseFrame(line: Record<string, unknown>): void {
    const payload = new TextEncoder().encode(JSON.stringify(line));
    for (const cb of this.frameSubscribers.get(FeedId.PULSE) ?? []) {
      cb(payload);
    }
  }
}

function makeStore(): { store: PulseStore; conn: FakeConnection } {
  const conn = new FakeConnection();
  const store = new PulseStore(conn as unknown as TugConnection);
  return { store, conn };
}

function wireRow(beat: number, text: string): Record<string, unknown> {
  return { id: beat, at_ms: 1_000 + beat, beat, text, scopes: ["s1"] };
}

function liveLine(beat: number, text: string): Record<string, unknown> {
  return { type: "pulse", text, scopes: ["s1"], beat, at: 1_000 + beat };
}

const stores: PulseStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

describe("PulseStore", () => {
  it("first snapshot kicks exactly one tail request and reads pending", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    const first = store.getSnapshot();
    expect(first.status).toBe("pending");
    expect(first.lines.length).toBe(0);
    expect(first.enabled).toBe(true); // no tugbank client → default on
    store.getSnapshot();
    expect(conn.frames.length).toBe(1);
    expect(conn.frames[0].feedId).toBe(FeedId.CONTROL);
    const decoded = JSON.parse(new TextDecoder().decode(conn.frames[0].payload));
    expect(decoded.action).toBe("list_pulse_lines");
  });

  it("the tail response settles to ready, oldest-first, latest set", () => {
    const { store } = makeStore();
    stores.push(store);
    store.getSnapshot();
    publishListPulseLinesOk({
      lines: [wireRow(1, "first"), wireRow(2, "second")] as never,
      overviews: [],
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
    conn.pushPulseFrame(liveLine(2, "second"));
    expect(store.getSnapshot().lines.map((l) => l.text)).toEqual(["second"]);
    // …then the tail arrives carrying the SAME line plus history.
    publishListPulseLinesOk({
      lines: [wireRow(1, "first"), wireRow(2, "second")] as never,
      overviews: [],
    });
    expect(store.getSnapshot().lines.map((l) => l.text)).toEqual([
      "first",
      "second",
    ]);
    // A fresh live line appends; a duplicate re-delivery does not.
    conn.pushPulseFrame(liveLine(3, "third"));
    conn.pushPulseFrame(liveLine(3, "third"));
    expect(store.getSnapshot().lines.map((l) => l.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(store.getSnapshot().latest?.text).toBe("third");
  });

  it("intent rides both the live fold and the tail hydrate", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    // Live frame with an intent; a second without.
    conn.pushPulseFrame({
      ...liveLine(2, "Writing chain.ts — 9 lines"),
      intent: "I'll rewire the responder chain.",
    });
    conn.pushPulseFrame(liveLine(3, "Done"));
    let snap = store.getSnapshot();
    expect(snap.lines[0].intent).toBe("I'll rewire the responder chain.");
    expect(snap.lines[1].intent).toBeUndefined();
    // The tail carries a persisted intent for older rows.
    publishListPulseLinesOk({
      lines: [
        { ...wireRow(1, "Explore · Reading foo.ts"), intent: "Mapping the reducer seam first." },
      ] as never,
      overviews: [],
    });
    snap = store.getSnapshot();
    expect(snap.lines[0].intent).toBe("Mapping the reducer seam first.");
  });

  it("the rolling log caps oldest-out", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    for (let beat = 1; beat <= PULSE_LINES_CAP + 5; beat++) {
      conn.pushPulseFrame(liveLine(beat, `line ${beat}`));
    }
    const snap = store.getSnapshot();
    expect(snap.lines.length).toBe(PULSE_LINES_CAP);
    expect(snap.lines[0].text).toBe("line 6");
    expect(snap.latest?.text).toBe(`line ${PULSE_LINES_CAP + 5}`);
  });

  it("the cap is per scope — a chatty session cannot evict a quiet one", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    // One quiet session speaks once, then a chatty one floods past the cap.
    conn.pushPulseFrame({
      type: "pulse",
      text: "quiet beat",
      scopes: ["s2"],
      beat: 0,
      at: 1_000,
    });
    for (let beat = 1; beat <= PULSE_LINES_CAP + 5; beat++) {
      conn.pushPulseFrame(liveLine(beat, `line ${beat}`));
    }
    const snap = store.getSnapshot();
    expect(latestLineForScope(snap.lines, "s2")?.text).toBe("quiet beat");
    // …and the chatty session is still capped at its own window.
    expect(snap.lines.filter((l) => l.scopes.includes("s1")).length).toBe(
      PULSE_LINES_CAP,
    );
  });

  it("the tail restores standing overviews; a live one already held wins", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    // s1 already spoke live while the tail was in flight.
    conn.pushPulseFrame({
      type: "pulse",
      kind: "overview",
      text: "live: rewiring the responder chain",
      scopes: ["s1"],
      beat: 4,
      at: 9_000,
    });
    publishListPulseLinesOk({
      lines: [],
      overviews: [
        { scope: "s1", at_ms: 1_000, beat: 1, text: "stale: earlier stretch" },
        { scope: "s2", at_ms: 2_000, beat: 2, text: "restored: pulse ledger" },
      ],
    });
    const { pulseOverviews } = store.getSnapshot();
    expect(latestPulseOverviewForScope(pulseOverviews, "s1")?.text).toBe(
      "live: rewiring the responder chain",
    );
    expect(latestPulseOverviewForScope(pulseOverviews, "s2")?.text).toBe(
      "restored: pulse ledger",
    );
    // A card with no overview of its own and no app-wide one stays bare.
    expect(latestPulseOverviewForScope(pulseOverviews, "s3")).toBeNull();
  });

  it("latestLineForScope shows own-session, app-wide, and woven lines only", () => {
    const entry = (
      key: string,
      text: string,
      scopes: string[],
    ): PulseLineEntry => ({ key, text, scopes, beat: 0, atMs: 0 });
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
    conn.pushPulseFrame(liveLine(1, "one"));
    const c = store.getSnapshot();
    expect(c).not.toBe(b);
    expect(store.getSnapshot()).toBe(c);
    // Malformed / foreign frames change nothing.
    conn.pushPulseFrame({ type: "not_pulse" });
    expect(store.getSnapshot()).toBe(c);
  });
});

describe("groupPulseHistory", () => {
  const beat = (key: string, text: string, intent?: string): PulseLineEntry => ({
    key,
    text,
    ...(intent !== undefined ? { intent } : {}),
    scopes: ["s1"],
    beat: 0,
    atMs: 0,
  });

  it("collapses a run of one intent into a single group", () => {
    const groups = groupPulseHistory([
      beat("1", "Explore · Reading a.ts", "Map the reducer seam."),
      beat("2", "Explore · Reading b.ts", "Map the reducer seam."),
      beat("3", "Explore · Running grep", "Map the reducer seam."),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].intent).toBe("Map the reducer seam.");
    expect(groups[0].beats.map((b) => b.text)).toEqual([
      "Explore · Reading a.ts",
      "Explore · Reading b.ts",
      "Explore · Running grep",
    ]);
  });

  it("starts a new group when the intent changes, and again if it returns", () => {
    const groups = groupPulseHistory([
      beat("1", "Reading a.ts", "Goal one."),
      beat("2", "Reading b.ts", "Goal two."),
      beat("3", "Reading c.ts", "Goal one."),
    ]);
    // A returning intent is a fresh group (grouping is by CONSECUTIVE run,
    // matching the timeline — not a global bucket by intent value).
    expect(groups.map((g) => g.intent)).toEqual([
      "Goal one.",
      "Goal two.",
      "Goal one.",
    ]);
    expect(groups.every((g) => g.beats.length === 1)).toBe(true);
  });

  it("groups intent-less lines together and apart from goal runs", () => {
    const groups = groupPulseHistory([
      beat("1", "First thought, standalone"),
      beat("2", "Second thought, standalone"),
      beat("3", "Reading a.ts", "A goal."),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].intent).toBeUndefined();
    expect(groups[0].beats).toHaveLength(2);
    expect(groups[1].intent).toBe("A goal.");
  });

  it("returns no groups for an empty list", () => {
    expect(groupPulseHistory([])).toEqual([]);
  });
});

describe("clearScope", () => {
  it("hides existing lines for the scope until a new one arrives", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    conn.pushPulseFrame(liveLine(1, "before submit"));
    let snap = store.getSnapshot();
    expect(
      latestLineForScope(snap.lines, "s1", snap.cleared.get("s1"))?.text,
    ).toBe("before submit");

    store.clearScope("s1");
    snap = store.getSnapshot();
    expect(
      latestLineForScope(snap.lines, "s1", snap.cleared.get("s1")),
    ).toBeNull();

    conn.pushPulseFrame(liveLine(2, "fresh commentary"));
    snap = store.getSnapshot();
    expect(
      latestLineForScope(snap.lines, "s1", snap.cleared.get("s1"))?.text,
    ).toBe("fresh commentary");
  });

  it("clearing one scope leaves another scope's view intact", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    conn.pushPulseFrame({ type: "pulse", text: "s2 line", scopes: ["s2"], beat: 1, at: 1_001 });
    store.clearScope("s1");
    const snap = store.getSnapshot();
    expect(
      latestLineForScope(snap.lines, "s2", snap.cleared.get("s2"))?.text,
    ).toBe("s2 line");
  });
});

describe("PulseStore — overviews", () => {
  function overviewFrame(
    text: string,
    scopes: string[] = ["s1"],
    beat = 1,
  ): Record<string, unknown> {
    return { type: "pulse", kind: "overview", text, scopes, beat, at: 2_000 + beat };
  }

  it("an overview never enters the beat log", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    conn.pushPulseFrame(liveLine(1, "a beat"));
    conn.pushPulseFrame(overviewFrame("Hardening the watch loop."));
    const snap = store.getSnapshot();
    expect(snap.lines.length).toBe(1);
    expect(snap.lines[0].text).toBe("a beat");
    expect(snap.latest?.text).toBe("a beat");
    expect(latestPulseOverviewForScope(snap.pulseOverviews, "s1")?.text).toBe(
      "Hardening the watch loop.",
    );
  });

  it("a newer overview replaces the older one outright", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    conn.pushPulseFrame(overviewFrame("First goal.", ["s1"], 1));
    conn.pushPulseFrame(overviewFrame("Second goal.", ["s1"], 2));
    const snap = store.getSnapshot();
    expect(snap.pulseOverviews.size).toBe(1);
    expect(latestPulseOverviewForScope(snap.pulseOverviews, "s1")?.text).toBe("Second goal.");
  });

  it("a card only sees its own session's overview", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    conn.pushPulseFrame(overviewFrame("s1 goal.", ["s1"]));
    const snap = store.getSnapshot();
    expect(latestPulseOverviewForScope(snap.pulseOverviews, "s1")?.text).toBe("s1 goal.");
    expect(latestPulseOverviewForScope(snap.pulseOverviews, "s2")).toBeNull();
  });

  it("an app-wide overview shows everywhere the session has none", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    conn.pushPulseFrame(overviewFrame("app-wide.", ["app"]));
    let snap = store.getSnapshot();
    expect(latestPulseOverviewForScope(snap.pulseOverviews, "s2")?.text).toBe("app-wide.");
    // The session's own always wins over the app-wide fallback.
    conn.pushPulseFrame(overviewFrame("s2 goal.", ["s2"]));
    snap = store.getSnapshot();
    expect(latestPulseOverviewForScope(snap.pulseOverviews, "s2")?.text).toBe("s2 goal.");
  });

  it("an unscoped overview files as app-wide", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    conn.pushPulseFrame(overviewFrame("unscoped.", []));
    const snap = store.getSnapshot();
    expect(latestPulseOverviewForScope(snap.pulseOverviews, "anything")?.text).toBe("unscoped.");
  });

  it("clearing a scope does not clear its overview — it is not news", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    conn.pushPulseFrame(overviewFrame("Standing goal."));
    store.clearScope("s1");
    const snap = store.getSnapshot();
    expect(latestPulseOverviewForScope(snap.pulseOverviews, "s1")?.text).toBe("Standing goal.");
  });

  it("an empty scope has no overview", () => {
    const { store } = makeStore();
    stores.push(store);
    const snap = store.getSnapshot();
    expect(latestPulseOverviewForScope(snap.pulseOverviews, "")).toBeNull();
    expect(snap.pulseOverviews.size).toBe(0);
  });
});
