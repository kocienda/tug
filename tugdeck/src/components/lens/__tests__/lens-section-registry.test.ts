/**
 * Pure-logic tests for the Lens section registry + render-order
 * resolution. Covers register/get, default (registration) order,
 * persisted-order precedence, hidden filtering, and tolerance of
 * unknown/removed persisted kinds.
 */

import { describe, it, expect, beforeEach } from "bun:test";

import {
  registerLensSection,
  getRegisteredLensSections,
  resolveSectionRenderOrder,
  mergeHiddenIntoOrder,
  moveInArray,
  sectionFocusGroup,
  _clearLensSectionsForTest,
  type LensSectionDefinition,
} from "@/components/lens/lens-section-registry";
import {
  sectionIsPresent,
  setSectionPresent,
  _clearSectionPresenceForTest,
} from "@/components/lens/lens-section-presence";

function stub(kind: string): LensSectionDefinition {
  return {
    kind,
    title: kind,
    glyph: null,
    collapsedSummary: () => null,
    body: () => null,
  };
}

beforeEach(() => {
  _clearLensSectionsForTest();
  _clearSectionPresenceForTest();
});

describe("lens-section-registry — register/get", () => {
  it("registers and retrieves by kind, preserving registration order", () => {
    registerLensSection(stub("log"));
    registerLensSection(stub("telemetry"));
    const map = getRegisteredLensSections();
    expect([...map.keys()]).toEqual(["log", "telemetry"]);
    expect(map.get("telemetry")?.title).toBe("telemetry");
  });

  it("a duplicate kind overwrites", () => {
    registerLensSection(stub("log"));
    const replacement = { ...stub("log"), title: "Log v2" };
    registerLensSection(replacement);
    expect(getRegisteredLensSections().get("log")?.title).toBe("Log v2");
  });
});

describe("lens-section-registry — resolveSectionRenderOrder", () => {
  const registered = ["log", "telemetry", "changeset"];

  it("defaults to registration order when nothing is persisted", () => {
    expect(resolveSectionRenderOrder(registered, [])).toEqual([
      "log",
      "telemetry",
      "changeset",
    ]);
  });

  it("honors persisted order, then appends unordered kinds", () => {
    expect(
      resolveSectionRenderOrder(registered, ["telemetry", "log"]),
    ).toEqual(["telemetry", "log", "changeset"]);
  });

  it("ignores unknown/removed persisted kinds", () => {
    expect(
      resolveSectionRenderOrder(registered, ["ghost", "telemetry"]),
    ).toEqual(["telemetry", "log", "changeset"]);
  });

  it("de-dupes a persisted kind listed twice", () => {
    expect(
      resolveSectionRenderOrder(registered, ["log", "log", "telemetry"]),
    ).toEqual(["log", "telemetry", "changeset"]);
  });
});

describe("lens-section-registry — mergeHiddenIntoOrder", () => {
  const full = ["log", "telemetry", "changeset", "dashes"];

  it("is the identity when nothing is hidden", () => {
    expect(mergeHiddenIntoOrder(full, full)).toEqual(full);
  });

  it("returns a hidden head to index 0", () => {
    expect(
      mergeHiddenIntoOrder(full, ["telemetry", "changeset", "dashes"]),
    ).toEqual(full);
  });

  it("returns a hidden middle to its own index", () => {
    expect(mergeHiddenIntoOrder(full, ["log", "telemetry", "dashes"])).toEqual(
      full,
    );
  });

  it("returns a hidden tail to the end", () => {
    expect(
      mergeHiddenIntoOrder(full, ["log", "telemetry", "changeset"]),
    ).toEqual(full);
  });

  // The case the whole function exists for: the visible sections were dragged
  // while one was absent, and the absent one must not be dropped from the
  // persisted order.
  it("keeps a hidden kind's place across a reorder of the visible ones", () => {
    expect(
      mergeHiddenIntoOrder(full, ["changeset", "telemetry", "dashes"]),
    ).toEqual(["log", "changeset", "telemetry", "dashes"]);
  });

  it("preserves the relative order of two hidden kinds", () => {
    expect(mergeHiddenIntoOrder(full, ["telemetry", "dashes"])).toEqual([
      "log",
      "telemetry",
      "changeset",
      "dashes",
    ]);
  });

  it("clamps a hidden index past the merged length to the end", () => {
    expect(mergeHiddenIntoOrder(["a", "b", "c", "d"], ["a"])).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("does not mutate its inputs", () => {
    const visible = ["telemetry", "changeset", "dashes"];
    mergeHiddenIntoOrder(full, visible);
    expect(visible).toEqual(["telemetry", "changeset", "dashes"]);
    expect(full).toEqual(["log", "telemetry", "changeset", "dashes"]);
  });
});

describe("lens-section-presence", () => {
  // The default has to be "present": a section is never hidden because nothing
  // has published about it yet, only because something said so.
  it("reads a kind nothing has published as present", () => {
    expect(sectionIsPresent("never-heard-of-it")).toBe(true);
  });

  it("reads a definition with no presence hook as present", () => {
    registerLensSection(stub("log"));
    expect(getRegisteredLensSections().get("log")?.presence).toBeUndefined();
    expect(sectionIsPresent("log")).toBe(true);
  });

  it("takes an explicit absence, and gives it back", () => {
    setSectionPresent("dashes", false);
    expect(sectionIsPresent("dashes")).toBe(false);
    setSectionPresent("dashes", true);
    expect(sectionIsPresent("dashes")).toBe(true);
  });
});

describe("lens-section-registry — moveInArray", () => {
  it("moves an item down", () => {
    expect(moveInArray(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });
  it("moves an item up", () => {
    expect(moveInArray(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });
  it("clamps an out-of-range target", () => {
    expect(moveInArray(["a", "b", "c"], 0, 99)).toEqual(["b", "c", "a"]);
  });
  it("does not mutate the input", () => {
    const input = ["a", "b", "c"];
    moveInArray(input, 0, 2);
    expect(input).toEqual(["a", "b", "c"]);
  });
});

describe("lens-section-registry — sectionFocusGroup", () => {
  it("namespaces the group by kind", () => {
    expect(sectionFocusGroup("log")).toBe("lens-section-log");
  });
});
