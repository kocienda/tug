/**
 * model.test.ts — pure-logic coverage for the model persistence helpers.
 *
 * No store, no DOM — the chip rendering, per-card persistence, and the
 * `model_change` round-trip are covered by the real-app test; this pins the
 * selector validation, persisted-value parsing, and the seed resolution that
 * lets a fresh card adopt the deck-wide default while a used card keeps its own.
 *
 * Selector validation runs against the persisted live catalog
 * ([model-catalog.ts]) — there is NO hardcoded model list. These tests run
 * with no tugbank client, i.e. the no-catalog state: only the `default`
 * selector (which forces no particular model) is trustworthy there. The
 * catalog-backed acceptance path is proven in the real-app test, where a
 * session's capabilities persist a real catalog.
 */

import { describe, expect, test } from "bun:test";
import {
  isModelSelector,
  parsePersistedModel,
  resolveSeedModel,
} from "@/lib/model";

describe("isModelSelector (no catalog — fresh install / unit env)", () => {
  test("accepts only the default selector when nothing is known", () => {
    expect(isModelSelector("default")).toBe(true);
    expect(isModelSelector("sonnet")).toBe(false);
    expect(isModelSelector("haiku")).toBe(false);
  });

  test("rejects a resolved model id or an unknown string", () => {
    expect(isModelSelector("claude-opus-4-8[1m]")).toBe(false);
    expect(isModelSelector("gpt")).toBe(false);
    expect(isModelSelector("")).toBe(false);
  });
});

describe("parsePersistedModel (no catalog — fresh install / unit env)", () => {
  test("reads a string-kinded default; drops a concrete selector it cannot vouch for", () => {
    expect(parsePersistedModel({ kind: "string", value: "default" })).toBe(
      "default",
    );
    // With no catalog there is no basis to trust a concrete selector — it is
    // dropped rather than sent to claude, and the unavailable-model bulletin
    // (gated on a persisted catalog existing) is what surfaces a stale pick.
    expect(parsePersistedModel({ kind: "string", value: "sonnet" })).toBeNull();
  });

  test("returns null for undefined, non-string, or unknown-selector values", () => {
    expect(parsePersistedModel(undefined)).toBeNull();
    expect(parsePersistedModel({ kind: "number", value: 3 })).toBeNull();
    expect(parsePersistedModel({ kind: "string", value: "opus-99" })).toBeNull();
  });
});

describe("resolveSeedModel", () => {
  test("per-card persisted selector wins over the global default", () => {
    expect(resolveSeedModel("sonnet", "haiku")).toBe("sonnet");
  });

  test("falls back to the global default when nothing is persisted", () => {
    expect(resolveSeedModel(null, "haiku")).toBe("haiku");
  });

  test("is null when neither is set (leave the session untouched)", () => {
    expect(resolveSeedModel(null, null)).toBeNull();
  });
});
