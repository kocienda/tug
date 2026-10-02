/**
 * opening-command-runner — the payload a new card's first turn carries, and
 * the moment it goes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  CATALOG_WAIT_MS,
  openingCommandPayload,
  runOpeningCommand,
} from "@/lib/opening-command-runner";
import { TUG_ATOM_CHAR } from "@/lib/tug-atom-img";
import type { CodeSessionStore } from "@/lib/code-session-store";
import type { SessionMetadataStore } from "@/lib/session-metadata-store";

describe("openingCommandPayload", () => {
  test("qualifies the name and turns an @path into a file atom", () => {
    const payload = openingCommandPayload(
      { name: "arc", args: "a-thing @briefs/a-thing-brief.md" },
      ["tugplug:arc", "context"],
    );
    expect(payload.text).toBe(`${TUG_ATOM_CHAR} a-thing ${TUG_ATOM_CHAR}`);
    expect(payload.atoms).toEqual([
      { kind: "atom", type: "command", label: "tugplug:arc", value: "tugplug:arc" },
      {
        kind: "atom",
        type: "file",
        label: "briefs/a-thing-brief.md",
        value: "briefs/a-thing-brief.md",
      },
    ]);
  });

  test("keeps the name as written when the catalog does not know it", () => {
    const payload = openingCommandPayload({ name: "arc", args: "" }, []);
    expect(payload.text).toBe(TUG_ATOM_CHAR);
    expect(payload.atoms.map((a) => a.value)).toEqual(["arc"]);
  });
});

/** A store with just the surface the runner reads. */
function fakeStore<S>(initial: S): {
  store: { subscribe: (l: () => void) => () => void; getSnapshot: () => S };
  set: (next: Partial<S>) => void;
  listeners: () => number;
} {
  let snap = initial;
  const ls = new Set<() => void>();
  return {
    store: {
      subscribe: (l) => {
        ls.add(l);
        return () => ls.delete(l);
      },
      getSnapshot: () => snap,
    },
    set: (next) => {
      snap = { ...snap, ...next };
      for (const l of [...ls]) l();
    },
    listeners: () => ls.size,
  };
}

describe("runOpeningCommand", () => {
  let sent: Array<{ text: string; values: string[] }>;
  let session: ReturnType<typeof fakeStore<{ replayEverCompleted: boolean; canSubmit: boolean }>>;
  let meta: ReturnType<typeof fakeStore<{ slashCommands: Array<{ name: string }> }>>;
  let code: CodeSessionStore;

  beforeEach(() => {
    sent = [];
    session = fakeStore<{ replayEverCompleted: boolean; canSubmit: boolean }>({
      replayEverCompleted: false,
      canSubmit: false,
    });
    meta = fakeStore({ slashCommands: [] as Array<{ name: string }> });
    code = {
      ...session.store,
      send: (text: string, atoms: Array<{ value: string }>) =>
        sent.push({ text, values: atoms.map((a) => a.value) }),
    } as unknown as CodeSessionStore;
  });
  afterEach(() => {
    sent = [];
  });

  test("waits for the replay, the submit gate and the catalog, then sends once", () => {
    const dispose = runOpeningCommand(
      "c1",
      { name: "arc", args: "x @b.md" },
      code,
      meta.store as unknown as SessionMetadataStore,
    );
    expect(sent).toEqual([]);
    session.set({ replayEverCompleted: true, canSubmit: true });
    expect(sent).toEqual([]);
    meta.set({ slashCommands: [{ name: "tugplug:arc" }] });
    expect(sent.map((s) => s.values)).toEqual([["tugplug:arc", "b.md"]]);
    // Once only, and it lets go of both stores.
    session.set({ canSubmit: true });
    meta.set({ slashCommands: [{ name: "tugplug:arc" }] });
    expect(sent.length).toBe(1);
    expect(session.listeners()).toBe(0);
    expect(meta.listeners()).toBe(0);
    dispose();
  });

  test("sends at once when the card is already ready", () => {
    session.set({ replayEverCompleted: true, canSubmit: true });
    meta.set({ slashCommands: [{ name: "tugplug:arc" }] });
    runOpeningCommand("c1", { name: "arc", args: "" }, code, meta.store as unknown as SessionMetadataStore);
    expect(sent.length).toBe(1);
  });

  test("a disposed run never sends", () => {
    const dispose = runOpeningCommand(
      "c1",
      { name: "arc", args: "" },
      code,
      meta.store as unknown as SessionMetadataStore,
    );
    dispose();
    session.set({ replayEverCompleted: true, canSubmit: true });
    meta.set({ slashCommands: [{ name: "tugplug:arc" }] });
    expect(sent).toEqual([]);
  });

  test("with no catalog, the deadline sends under the written name", async () => {
    const dispose = runOpeningCommand(
      "c1",
      { name: "arc", args: "" },
      code,
      meta.store as unknown as SessionMetadataStore,
    );
    session.set({ replayEverCompleted: true, canSubmit: true });
    expect(sent).toEqual([]);
    await new Promise((r) => setTimeout(r, CATALOG_WAIT_MS + 50));
    expect(sent.map((s) => s.values)).toEqual([["arc"]]);
    dispose();
  }, CATALOG_WAIT_MS + 2000);
});
