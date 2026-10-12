import { describe, expect, test } from "bun:test";
import { RoutedFrameStore } from "../ingest/routed-frame-store";

import {
  HOOK_EVENT_CATALOG,
  HooksInventoryStore,
  countHooks,
  hooksSummaryLine,
  parseHooksInventoryPayload,
  selectHookEventRows,
  type HookMatcherGroup,
} from "../hooks-inventory-store";

const EVENTS: Record<string, HookMatcherGroup[]> = {
  PreToolUse: [
    { matcher: "Bash", hooks: [{ type: "command", command: "echo a" }] },
    { matcher: "Edit", hooks: [{ type: "command", command: "echo b", timeout: 30 }] },
  ],
  // An event not in the catalog — should still surface, appended.
  CustomEvent: [{ hooks: [{ type: "command", command: "echo c" }] }],
};

describe("selectHookEventRows", () => {
  test("lists every catalog event (in order), with counts + groups", () => {
    const rows = selectHookEventRows(EVENTS);
    // Catalog events come first, in catalog order.
    expect(rows.slice(0, HOOK_EVENT_CATALOG.length).map((r) => r.name)).toEqual(
      HOOK_EVENT_CATALOG.map((e) => e.name),
    );
    const pre = rows.find((r) => r.name === "PreToolUse")!;
    expect(pre.count).toBe(2); // two commands across two matcher groups
    expect(pre.description).toBe("Before tool execution");
    const post = rows.find((r) => r.name === "PostToolUse")!;
    expect(post.count).toBe(0); // catalog event with no configured hooks
    expect(post.groups).toEqual([]);
  });

  test("appends configured-but-uncatalogued events after the catalog", () => {
    const rows = selectHookEventRows(EVENTS);
    const last = rows[rows.length - 1];
    expect(last.name).toBe("CustomEvent");
    expect(last.count).toBe(1);
    expect(last.description).toBe("");
  });
});

describe("countHooks + hooksSummaryLine", () => {
  test("counts total commands across events", () => {
    expect(countHooks(EVENTS)).toBe(3);
    expect(countHooks({})).toBe(0);
  });

  test("pluralizes the summary", () => {
    expect(hooksSummaryLine(0)).toBe("0 hooks configured");
    expect(hooksSummaryLine(1)).toBe("1 hook configured");
    expect(hooksSummaryLine(3)).toBe("3 hooks configured");
  });
});

describe("parseHooksInventoryPayload", () => {
  test("parses a well-formed payload", () => {
    const parsed = parseHooksInventoryPayload({
      type: "hooks_inventory",
      request_id: "hk-1",
      events: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "x", timeout: 5 }] },
        ],
      },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.request_id).toBe("hk-1");
    expect(parsed!.events.PreToolUse[0]).toEqual({
      matcher: "Bash",
      hooks: [{ type: "command", command: "x", timeout: 5 }],
    });
  });

  test("rejects a non-hooks_inventory or malformed payload", () => {
    expect(parseHooksInventoryPayload(null)).toBeNull();
    expect(parseHooksInventoryPayload({ type: "skills_inventory" })).toBeNull();
    expect(parseHooksInventoryPayload({ type: "hooks_inventory" })).toBeNull(); // no request_id
  });

  test("drops malformed groups / commands defensively", () => {
    const parsed = parseHooksInventoryPayload({
      type: "hooks_inventory",
      request_id: "hk-2",
      events: {
        PreToolUse: [
          { hooks: [{ type: "command", command: "ok" }, { command: "no-type" }] },
          { matcher: "Edit" }, // no hooks array → dropped
        ],
      },
    });
    expect(parsed!.events.PreToolUse).toHaveLength(1);
    expect(parsed!.events.PreToolUse[0].hooks).toEqual([
      { type: "command", command: "ok" },
    ]);
  });
});

describe("HooksInventoryStore._ingestForTest", () => {
  const fakeFeed = () => new RoutedFrameStore("hooks_inventory");

  test("resolves to ready with the ingested payload", () => {
    const store = new HooksInventoryStore(fakeFeed(), 0x10, "sess");
    store._ingestForTest({
      type: "hooks_inventory",
      request_id: "hk-9",
      events: { PreToolUse: [{ hooks: [{ type: "command", command: "x" }] }] },
    });
    const snap = store.getSnapshot();
    expect(snap.phase).toBe("ready");
    expect(countHooks(snap.payload!.events)).toBe(1);
    store.dispose();
  });

  test("throws on a malformed ingest payload", () => {
    const store = new HooksInventoryStore(fakeFeed(), 0x10, "sess");
    expect(() => store._ingestForTest({ type: "nope" })).toThrow();
    store.dispose();
  });
});
