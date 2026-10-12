/**
 * The field-level diff a structure patch carries ([P05]): the engine names
 * exactly the state fields whose identity moved and describes the transcript
 * as identity splices, and the mirror, applying them, keeps its own object
 * for every field and every turn the patch does not name. That kept identity
 * is what every selector downstream of the snapshot depends on.
 */

import { describe, expect, test } from "bun:test";
import {
  applySessionBatch,
  applyTranscriptSplices,
  diffStateFields,
  diffTranscript,
  type PatchTarget,
  type SessionPatch,
  type SessionPatchTarget,
} from "../session-patch";
import { installDevLogSink } from "@/lib/dev-log-port";

interface Turn {
  turnKey: string;
  text: string;
}

const turn = (key: string, text = key): Turn => ({ turnKey: key, text });

/** The mirror's side: clone what crossed, then apply it to its own copy. */
function applyCloned<E>(mirror: ReadonlyArray<E>, prev: ReadonlyArray<E>, next: ReadonlyArray<E>): ReadonlyArray<E> {
  const splices = diffTranscript(prev, next);
  return applyTranscriptSplices(mirror, splices === null ? undefined : structuredClone(splices));
}

describe("diffStateFields", () => {
  test("names exactly the fields whose identity changed", () => {
    const shared = { a: 1 };
    const prev = { phase: "idle", jobs: [] as number[], shared, count: 1 };
    const next = { ...prev, phase: "streaming", jobs: [1] };
    expect(diffStateFields(prev, next)).toEqual({ phase: "streaming", jobs: [1] });
  });

  test("is null for the same object and for a copy with every field kept", () => {
    const prev = { phase: "idle", jobs: [] as number[] };
    expect(diffStateFields(prev, prev)).toBeNull();
    expect(diffStateFields(prev, { ...prev })).toBeNull();
  });

  test("names a field that went missing as undefined", () => {
    const prev: { a: number; b?: number } = { a: 1, b: 2 };
    const next: { a: number; b?: number } = { a: 1 };
    const diff = diffStateFields(prev, next);
    expect(diff).not.toBeNull();
    expect(Object.keys(diff!)).toEqual(["b"]);
    expect(diff!.b).toBeUndefined();
  });

  test("a merged mirror keeps its own object for every field the patch did not name", () => {
    const mirror = { phase: "idle", jobs: [] as number[], goal: { text: "g" } };
    const engineBefore = { phase: "idle", jobs: [] as number[], goal: { text: "g" } };
    const engineAfter = { ...engineBefore, phase: "streaming" };
    const merged = { ...mirror, ...structuredClone(diffStateFields(engineBefore, engineAfter)!) };
    expect(merged.phase).toBe("streaming");
    expect(merged.jobs).toBe(mirror.jobs);
    expect(merged.goal).toBe(mirror.goal);
  });
});

describe("diffTranscript", () => {
  const a = turn("a");
  const b = turn("b");
  const c = turn("c");
  const d = turn("d");

  test("an append is one splice at the end", () => {
    expect(diffTranscript([a, b], [a, b, c])).toEqual([{ start: 2, deleteCount: 0, entries: [c] }]);
  });

  test("a front-prepend is one splice at the start", () => {
    expect(diffTranscript([c, d], [a, b, c, d])).toEqual([{ start: 0, deleteCount: 0, entries: [a, b] }]);
  });

  test("a mid-replace is one splice over the replaced turn", () => {
    const b2 = turn("b", "b, with a divider");
    expect(diffTranscript([a, b, c], [a, b2, c])).toEqual([{ start: 1, deleteCount: 1, entries: [b2] }]);
  });

  test("a truncation is one splice that deletes the tail", () => {
    expect(diffTranscript([a, b, c, d], [a, b])).toEqual([{ start: 2, deleteCount: 2, entries: [] }]);
  });

  test("an eviction is one splice that deletes the head", () => {
    expect(diffTranscript([a, b, c, d], [c, d])).toEqual([{ start: 0, deleteCount: 2, entries: [] }]);
  });

  test("the cap's steady state — one evicted, one appended — leaves the turns between alone", () => {
    expect(diffTranscript([a, b, c], [b, c, d])).toEqual([
      { start: 0, deleteCount: 1, entries: [] },
      { start: 2, deleteCount: 0, entries: [d] },
    ]);
  });

  test("is null for the same array and for a copy of it", () => {
    const t = [a, b];
    expect(diffTranscript(t, t)).toBeNull();
    expect(diffTranscript(t, [...t])).toBeNull();
  });
});

describe("applyTranscriptSplices", () => {
  test("every turn the splices do not name keeps the mirror's own object", () => {
    const engine = [turn("a"), turn("b"), turn("c")];
    const mirror = structuredClone(engine);

    const appended = applyCloned(mirror, engine, [...engine, turn("d")]);
    expect(appended.map((t) => t.turnKey)).toEqual(["a", "b", "c", "d"]);
    for (let i = 0; i < 3; i++) expect(appended[i]).toBe(mirror[i]);

    const replaced = [engine[0]!, turn("b", "b2"), engine[2]!];
    const afterReplace = applyCloned(mirror, engine, replaced);
    expect(afterReplace[0]).toBe(mirror[0]);
    expect(afterReplace[1]).not.toBe(mirror[1]);
    expect(afterReplace[1]!.text).toBe("b2");
    expect(afterReplace[2]).toBe(mirror[2]);

    const evicted = applyCloned(mirror, engine, engine.slice(1));
    expect(evicted).toHaveLength(2);
    expect(evicted[0]).toBe(mirror[1]);
    expect(evicted[1]).toBe(mirror[2]);

    const slid = applyCloned(mirror, engine, [...engine.slice(1), turn("d")]);
    expect(slid.map((t) => t.turnKey)).toEqual(["b", "c", "d"]);
    expect(slid[0]).toBe(mirror[1]);
    expect(slid[1]).toBe(mirror[2]);
  });

  test("with no splices the array itself comes back", () => {
    const mirror = [turn("a")];
    expect(applyTranscriptSplices(mirror, undefined)).toBe(mirror);
    expect(applyTranscriptSplices(mirror, [])).toBe(mirror);
  });

  test("splices apply in order, so merged folds land where the engine put them", () => {
    const engine0 = [turn("a")];
    const engine1 = [...engine0, turn("b")];
    const engine2 = [...engine1, turn("c")];
    const splices = [...diffTranscript(engine0, engine1)!, ...diffTranscript(engine1, engine2)!];
    expect(applyTranscriptSplices(engine0, splices).map((t) => t.turnKey)).toEqual(["a", "b", "c"]);
  });
});

describe("applySessionBatch", () => {
  test("a mirror whose applier throws still gets its acknowledgment, and the rest of the batch applies", () => {
    // What each mirror and the page end up holding.
    const acked = new Map<string, number>();
    const frames: number[] = [];
    const ended: string[] = [];
    const mirror = (handle: string, throwsOnStructure: boolean): SessionPatchTarget => ({
      stream: () => {},
      structure: () => {
        if (throwsOnStructure) throw new Error("a broken applier");
      },
      progress: () => {},
      effect: () => {},
      ack: (patch) => acked.set(handle, patch.payload.seq),
      routedFrame: () => {},
      rendered: () => {},
      findResult: () => {},
      endOfBatch: () => ended.push(handle),
    });
    const mirrors = new Map([
      ["a", mirror("a", true)],
      ["b", mirror("b", false)],
    ]);
    const target: PatchTarget = {
      page: {
        frame: (patch) => frames.push(patch.payload.feedId),
        wireState: () => {},
        disconnectState: () => {},
        log: () => {},
      },
      session: (handle) => mirrors.get(handle) ?? null,
    };
    const entries: SessionPatch[] = [
      { kind: "structure", session: "a", payload: {} },
      { kind: "ack", session: "a", payload: { seq: 7 } },
      { kind: "frame", session: null, payload: { feedId: 0x50, bytes: new ArrayBuffer(0) } },
      { kind: "ack", session: "b", payload: { seq: 3 } },
    ];
    const reported: string[] = [];
    const restore = installDevLogSink({ log: (_level, _source, message) => reported.push(message) });
    try {
      applySessionBatch(entries, target);
    } finally {
      restore();
    }

    expect(acked).toEqual(new Map([["a", 7], ["b", 3]]));
    expect(frames).toEqual([0x50]);
    expect(ended).toEqual(["a", "b"]);
    expect(reported).toEqual(["a structure patch threw as it applied; the rest of the batch still applies"]);
  });
});
