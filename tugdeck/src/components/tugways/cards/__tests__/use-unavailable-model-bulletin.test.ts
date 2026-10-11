/**
 * use-unavailable-model-bulletin.test.ts — pure-logic coverage for
 * `resolveSeedSelector`, which decides whether a card's seed selector is
 * offered as saved, has merely been respelled by claude (migrate, silently),
 * or is gone (reset + bulletin). The write-back, alert, and open-Settings
 * behavior is proven through the real-app test, not here.
 */

import { describe, expect, test } from "bun:test";
import type { CapabilityModel } from "@/lib/session-metadata-store";
import { resolveSeedSelector } from "../use-unavailable-model-bulletin";

const CATALOG: CapabilityModel[] = [
  { value: "default", displayName: "Default (recommended)" },
  { value: "sonnet", displayName: "Sonnet" },
  { value: "haiku", displayName: "Haiku" },
];

/** The shape that broke: the same model, respelled with a context variant. */
const RESPELLED_CATALOG: CapabilityModel[] = [
  { value: "default", displayName: "Default (recommended)" },
  { value: "opus[1m]", displayName: "Opus (1M context)" },
  { value: "claude-fable-5[1m]", displayName: "Fable" },
  { value: "sonnet", displayName: "Sonnet" },
];

describe("resolveSeedSelector", () => {
  test("keeps a seed the catalog still offers verbatim", () => {
    expect(resolveSeedSelector("sonnet", CATALOG)).toEqual({ kind: "keep" });
    expect(resolveSeedSelector("haiku", CATALOG)).toEqual({ kind: "keep" });
  });

  test("resets a seed no catalog row could be", () => {
    expect(resolveSeedSelector("fable", CATALOG)).toEqual({ kind: "reset" });
    expect(resolveSeedSelector("fable-9", CATALOG)).toEqual({ kind: "reset" });
  });

  test("migrates a respelled seed instead of resetting it", () => {
    // The reported break: saved before the `[1m]` variant became the offered
    // spelling of Fable.
    expect(resolveSeedSelector("claude-fable-5", RESPELLED_CATALOG)).toEqual({
      kind: "migrate",
      selector: "claude-fable-5[1m]",
    });
    // And the same in the other direction — a short family selector saved
    // against a catalog that now offers the fully-qualified id.
    expect(resolveSeedSelector("fable", RESPELLED_CATALOG)).toEqual({
      kind: "migrate",
      selector: "claude-fable-5[1m]",
    });
    expect(resolveSeedSelector("opus", RESPELLED_CATALOG)).toEqual({
      kind: "migrate",
      selector: "opus[1m]",
    });
  });

  test("keeps the default zero-state and no seed at all", () => {
    expect(resolveSeedSelector("default", CATALOG)).toEqual({ kind: "keep" });
    expect(resolveSeedSelector(null, CATALOG)).toEqual({ kind: "keep" });
  });

  test("keeps everything when no live catalog was ever persisted", () => {
    expect(resolveSeedSelector("fable", null)).toEqual({ kind: "keep" });
    expect(resolveSeedSelector(null, null)).toEqual({ kind: "keep" });
  });

  test("a default-less catalog still clears its own members only", () => {
    const catalog: CapabilityModel[] = [{ value: "sonnet", displayName: "Sonnet" }];
    expect(resolveSeedSelector("sonnet", catalog)).toEqual({ kind: "keep" });
    expect(resolveSeedSelector("haiku", catalog)).toEqual({ kind: "reset" });
  });
});
