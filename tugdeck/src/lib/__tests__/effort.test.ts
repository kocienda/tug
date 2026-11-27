/**
 * effort.test.ts — pure-logic coverage for the reasoning-effort helpers
 * ([#step-4]).
 *
 * No store, no DOM — the chip rendering, persistence, and the
 * respawn-with-resume round-trip are covered by the real-app test; this pins
 * the level ordering, label formatting, persisted-value parsing, and the
 * per-model support resolution (which gates the chip and bounds the picker).
 *
 * The fixtures mirror the real claude 2.1.158 `initialize` `models[]`: opus
 * (default) supports all five levels, sonnet four (no `xhigh`), haiku none
 * (the `supportsEffort` flag is absent).
 */

import { describe, expect, test } from "bun:test";
import type { CapabilityModel } from "@/lib/session-metadata-store";
import {
  DEFAULT_EFFORT_LEVEL,
  EFFORT_LEVELS,
  formatEffortLabel,
  orderEffortLevels,
  parsePersistedEffort,
  resolveEffortDisplay,
  resolveEffortRestoreAction,
  resolveEffortSupport,
  resolveSeedEffort,
} from "@/lib/effort";

const CAPABILITY_MODELS: CapabilityModel[] = [
  {
    value: "default",
    displayName: "Default (recommended)",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "sonnet",
    displayName: "Sonnet",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
  },
  { value: "haiku", displayName: "Haiku" }, // no effort support
];

describe("formatEffortLabel", () => {
  test("title-cases the known levels, with claude's wording for xhigh", () => {
    expect(formatEffortLabel("low")).toBe("Low");
    expect(formatEffortLabel("medium")).toBe("Medium");
    expect(formatEffortLabel("high")).toBe("High");
    expect(formatEffortLabel("xhigh")).toBe("Extra-High");
    expect(formatEffortLabel("max")).toBe("Max");
  });

  test("null (no value) reads as the `-` placeholder", () => {
    expect(formatEffortLabel(null)).toBe("-");
  });

  test("an unknown level falls back to its raw value", () => {
    expect(formatEffortLabel("ludicrous")).toBe("ludicrous");
  });
});

describe("orderEffortLevels", () => {
  test("filters + orders into canonical order, dropping unknowns", () => {
    expect(orderEffortLevels(["max", "low", "bogus", "high"])).toEqual([
      "low",
      "high",
      "max",
    ]);
  });

  test("empty in, empty out", () => {
    expect(orderEffortLevels([])).toEqual([]);
  });

  test("canonical order matches the wire enum", () => {
    expect([...EFFORT_LEVELS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("parsePersistedEffort", () => {
  test("returns the stored string for a string-kinded value", () => {
    expect(parsePersistedEffort({ kind: "string", value: "high" })).toBe("high");
  });

  test("returns null for missing / non-string entries", () => {
    expect(parsePersistedEffort(undefined)).toBeNull();
    expect(parsePersistedEffort({ kind: "number", value: 3 })).toBeNull();
  });
});

describe("resolveEffortSupport", () => {
  test("opus (default) supports all five levels in canonical order", () => {
    const support = resolveEffortSupport(
      CAPABILITY_MODELS,
      "claude-opus-4-8[1m]",
      null,
    );
    expect(support.supported).toBe(true);
    expect(support.levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("sonnet supports four levels (no xhigh)", () => {
    const support = resolveEffortSupport(
      CAPABILITY_MODELS,
      "claude-sonnet-4-6",
      null,
    );
    expect(support.supported).toBe(true);
    expect(support.levels).toEqual(["low", "medium", "high", "max"]);
  });

  test("haiku does not support effort — gated", () => {
    const support = resolveEffortSupport(
      CAPABILITY_MODELS,
      "claude-haiku-4-5",
      null,
    );
    expect(support.supported).toBe(false);
    expect(support.levels).toEqual([]);
  });

  test("no model id resolves to the default (account-default) row's support", () => {
    const support = resolveEffortSupport(CAPABILITY_MODELS, null, null);
    expect(support.supported).toBe(true);
    expect(support.levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("resumed session (no caps) resolves support from the persisted catalog", () => {
    // Empty capabilities but a known model → the persisted-catalog fallback.
    const opus = resolveEffortSupport([], "claude-opus-4-8[1m]", CAPABILITY_MODELS);
    expect(opus.supported).toBe(true);
    expect(opus.levels).toEqual(["low", "medium", "high", "xhigh", "max"]);

    const sonnet = resolveEffortSupport([], "claude-sonnet-4-6", CAPABILITY_MODELS);
    expect(sonnet.supported).toBe(true);
    expect(sonnet.levels).toEqual(["low", "medium", "high", "max"]);

    const haiku = resolveEffortSupport([], "claude-haiku-4-5", CAPABILITY_MODELS);
    expect(haiku.supported).toBe(false);
    expect(haiku.levels).toEqual([]);
  });

  test("known model but no catalog at all — unknowable, honestly unsupported", () => {
    const support = resolveEffortSupport([], "claude-opus-4-8[1m]", null);
    expect(support.supported).toBe(false);
    expect(support.levels).toEqual([]);
  });

  test("nothing known (no caps, no model) is gated — unknowable support", () => {
    const support = resolveEffortSupport([], null, null);
    expect(support.supported).toBe(false);
    expect(support.levels).toEqual([]);
  });
});

describe("resolveEffortDisplay", () => {
  test("an explicit override shows that level (live handshake present)", () => {
    const d = resolveEffortDisplay(
      CAPABILITY_MODELS,
      "claude-opus-4-8",
      "low",
      null,
    );
    expect(d.supported).toBe(true);
    expect(d.level).toBe("low");
  });

  test("no override on a supported model shows its built-in default", () => {
    const d = resolveEffortDisplay(
      CAPABILITY_MODELS,
      "claude-opus-4-8",
      null,
      null,
    );
    expect(d.supported).toBe(true);
    expect(d.level).toBe(DEFAULT_EFFORT_LEVEL);
  });

  test("a supported model shows its default even before the live handshake", () => {
    // `models` empty ⇒ the capabilities handshake hasn't landed (claude is
    // silent until the first input on a resume). The model id still resolves
    // support via the persisted catalog, so the chip shows the model's DEFAULT
    // effort — the honest effective value — not a `-` blank. A live override
    // sharpens it on the first turn.
    const d = resolveEffortDisplay([], "claude-opus-4-8", null, CAPABILITY_MODELS);
    expect(d.supported).toBe(true);
    expect(d.level).toBe(DEFAULT_EFFORT_LEVEL);
    expect(d.levels.length).toBeGreaterThan(0); // support resolved for the picker
  });

  test("a restored per-card effort overrides the default", () => {
    const d = resolveEffortDisplay([], "claude-opus-4-8", "max", CAPABILITY_MODELS);
    expect(d.level).toBe("max");
  });

  test("an unsupported model has no level regardless of source", () => {
    const d = resolveEffortDisplay(
      CAPABILITY_MODELS,
      "claude-haiku-4-5",
      null,
      null,
    );
    expect(d.supported).toBe(false);
    expect(d.level).toBeNull();
  });
});

describe("resolveSeedEffort", () => {
  test("per-card persisted level wins over the global default", () => {
    expect(resolveSeedEffort("max", "high")).toBe("max");
  });

  test("falls back to the global default when nothing is persisted", () => {
    expect(resolveSeedEffort(null, "high")).toBe("high");
  });

  test("is null when neither is set (leave the session untouched)", () => {
    expect(resolveSeedEffort(null, null)).toBeNull();
  });
});

describe("resolveEffortRestoreAction", () => {
  const ready = {
    seedEffort: "medium",
    models: CAPABILITY_MODELS,
    model: "default",
    liveEffort: null,
    canSubmit: true,
    catalogFallback: null,
  };

  test("sends a seed that differs from the effective live level", () => {
    expect(resolveEffortRestoreAction(ready)).toEqual({ kind: "send", effort: "medium" });
  });

  test("waits while a turn is running, because applying it respawns claude", () => {
    // The Protocol error Tito reported: a card mounted over a running turn
    // sent its seed, and the respawn ended the turn.
    expect(resolveEffortRestoreAction({ ...ready, canSubmit: false })).toEqual({
      kind: "wait",
    });
  });

  test("the wait is not a latch: the same seed sends once the turn is over", () => {
    const during = resolveEffortRestoreAction({ ...ready, canSubmit: false });
    const after = resolveEffortRestoreAction({ ...ready, canSubmit: true });
    expect(during.kind).toBe("wait");
    expect(after).toEqual({ kind: "send", effort: "medium" });
  });

  test("a seed already in force settles without a send, mid-turn or not", () => {
    expect(
      resolveEffortRestoreAction({ ...ready, liveEffort: "medium", canSubmit: false }),
    ).toEqual({ kind: "settled" });
    // No override in force means the default level is.
    expect(
      resolveEffortRestoreAction({ ...ready, seedEffort: DEFAULT_EFFORT_LEVEL }),
    ).toEqual({ kind: "settled" });
  });

  test("a level the active model does not take settles without a send", () => {
    expect(
      resolveEffortRestoreAction({ ...ready, seedEffort: "xhigh", model: "sonnet" }),
    ).toEqual({ kind: "settled" });
    expect(resolveEffortRestoreAction({ ...ready, model: "haiku" })).toEqual({
      kind: "settled",
    });
  });

  test("waits until a seed and the model's support are both known", () => {
    expect(resolveEffortRestoreAction({ ...ready, seedEffort: null })).toEqual({
      kind: "wait",
    });
    expect(resolveEffortRestoreAction({ ...ready, models: [], model: null })).toEqual({
      kind: "wait",
    });
  });
});
