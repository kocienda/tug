import { describe, expect, test } from "bun:test";
import { RoutedFrameStore } from "../ingest/routed-frame-store";

import {
  SkillsInventoryStore,
  formatSkillTokens,
  parseSkillsInventoryPayload,
  skillLockLabel,
  skillSourceLabel,
  skillsSummaryLine,
  type SkillInventoryEntry,
} from "../skills-inventory-store";

const PLUGIN_SKILL: SkillInventoryEntry = {
  name: "tugplug:audit",
  description: "Audit the implementation work",
  source: "tugplug",
  locked: true,
  tokens: 90,
};

const USER_SKILL: SkillInventoryEntry = {
  name: "mine",
  description: "",
  source: "user",
  locked: false,
  tokens: 12,
};

describe("presentation helpers", () => {
  test("skillSourceLabel reads plugin vs user", () => {
    expect(skillSourceLabel(PLUGIN_SKILL)).toBe("Plugin tugplug");
    expect(skillSourceLabel(USER_SKILL)).toBe("User");
  });

  test("formatSkillTokens matches the ~N tok shape", () => {
    expect(formatSkillTokens(90)).toBe("~90 tok");
    expect(formatSkillTokens(0)).toBe("~0 tok");
  });

  test("skillLockLabel is set only for locked (plugin) skills", () => {
    expect(skillLockLabel(PLUGIN_SKILL)).toBe("locked by author");
    expect(skillLockLabel(USER_SKILL)).toBeNull();
  });

  test("skillsSummaryLine pluralizes", () => {
    expect(skillsSummaryLine(0)).toBe("0 skills");
    expect(skillsSummaryLine(1)).toBe("1 skill");
    expect(skillsSummaryLine(6)).toBe("6 skills");
  });
});

describe("parseSkillsInventoryPayload", () => {
  test("parses a well-formed payload, defaulting absent fields", () => {
    const parsed = parseSkillsInventoryPayload({
      type: "skills_inventory",
      request_id: "si-1",
      skills: [
        { name: "tugplug:audit", description: "x", source: "tugplug", locked: true, tokens: 90 },
        { name: "bare" }, // missing fields → defaults
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.request_id).toBe("si-1");
    expect(parsed!.skills).toHaveLength(2);
    expect(parsed!.skills[1]).toEqual({
      name: "bare",
      description: "",
      source: "user",
      locked: false,
      tokens: 0,
    });
  });

  test("rejects a non-skills_inventory or malformed payload", () => {
    expect(parseSkillsInventoryPayload(null)).toBeNull();
    expect(parseSkillsInventoryPayload({ type: "cost_update" })).toBeNull();
    expect(
      parseSkillsInventoryPayload({ type: "skills_inventory", skills: [] }),
    ).toBeNull(); // no request_id
    expect(
      parseSkillsInventoryPayload({ type: "skills_inventory", request_id: "x" }),
    ).toBeNull(); // no skills array
  });

  test("skips malformed skill entries (no name)", () => {
    const parsed = parseSkillsInventoryPayload({
      type: "skills_inventory",
      request_id: "si-2",
      skills: [{ description: "no name" }, { name: "ok" }],
    });
    expect(parsed!.skills.map((s) => s.name)).toEqual(["ok"]);
  });
});

describe("SkillsInventoryStore._ingestForTest", () => {
  test("resolves to ready with the ingested payload", () => {
    // The mirror's routed store, as the services bag passes it; the test seam bypasses it.
    const store = new SkillsInventoryStore(new RoutedFrameStore("skills_inventory"), 0x10, "sess");
    store._ingestForTest({
      type: "skills_inventory",
      request_id: "si-9",
      skills: [PLUGIN_SKILL],
    });
    const snap = store.getSnapshot();
    expect(snap.phase).toBe("ready");
    expect(snap.payload!.skills).toEqual([PLUGIN_SKILL]);
    store.dispose();
  });

  test("throws on a malformed ingest payload", () => {
    const store = new SkillsInventoryStore(new RoutedFrameStore("skills_inventory"), 0x10, "sess");
    expect(() => store._ingestForTest({ type: "nope" })).toThrow();
    store.dispose();
  });
});
