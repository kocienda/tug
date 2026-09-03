/**
 * ai-config.test.ts — pure-logic coverage for the composite AI-configuration
 * helpers.
 *
 * No store, no DOM. The chip, the mixer sheet, and the menu title are covered
 * by the real-app test; this pins the three things the transaction depends on
 * being exactly right: the summary's omission rules, the commit diff's
 * minimality AND ordering, and the effort clamp that fires when a model
 * selection strands the pending effort.
 *
 * The model fixtures mirror the real claude `initialize` `models[]`: a default
 * row supporting all five levels, sonnet four (no `xhigh`), haiku none.
 */

import { describe, expect, test } from "bun:test";
import type {
  CapabilityModel,
  SessionMetadataSnapshot,
} from "@/lib/session-metadata-store";
import { modelIdToSelector } from "@/lib/model-picker-data";
import { DEFAULT_EFFORT_LEVEL } from "@/lib/effort";
import {
  AI_CONFIG_DOMAIN,
  AI_CONFIG_LAST_ROW_KEY,
  clampEffortToSupport,
  computeAiConfigCommit,
  formatAiConfigSummary,
  parseAiConfigRow,
  resolveAiConfigSources,
  type AiConfigBaseline,
} from "@/lib/ai-config";

const BASELINE: AiConfigBaseline = {
  modelSelector: "default",
  effortLevel: "high",
  mode: "default",
};

describe("formatAiConfigSummary", () => {
  test("joins the full triple with the chip separator", () => {
    expect(
      formatAiConfigSummary({
        modelLabel: "Fable 5",
        effortLabel: "High",
        modeLabel: "Auto",
      }),
    ).toBe("Fable 5 · High · Auto");
  });

  test("omits the effort token entirely when the model supports none", () => {
    expect(
      formatAiConfigSummary({
        modelLabel: "Haiku 4.5",
        effortLabel: null,
        modeLabel: "Auto",
      }),
    ).toBe("Haiku 4.5 · Auto");
  });

  test("an unknown model reads as ? rather than dropping the token", () => {
    expect(
      formatAiConfigSummary({
        modelLabel: null,
        effortLabel: null,
        modeLabel: "Default",
      }),
    ).toBe("? · Default");
  });
});

describe("computeAiConfigCommit", () => {
  test("no change commits nothing", () => {
    expect(computeAiConfigCommit(BASELINE, { ...BASELINE })).toEqual([]);
  });

  test("a mode-only change commits one mode action", () => {
    expect(computeAiConfigCommit(BASELINE, { ...BASELINE, mode: "auto" })).toEqual([
      { kind: "mode", value: "auto" },
    ]);
  });

  test("a model-only change commits one model action", () => {
    expect(
      computeAiConfigCommit(BASELINE, { ...BASELINE, modelSelector: "sonnet" }),
    ).toEqual([{ kind: "model", value: "sonnet" }]);
  });

  test("an effort-only change commits one effort action", () => {
    expect(computeAiConfigCommit(BASELINE, { ...BASELINE, effortLevel: "max" })).toEqual([
      { kind: "effort", value: "max" },
    ]);
  });

  test("model + effort commit two actions with the model first", () => {
    const actions = computeAiConfigCommit(BASELINE, {
      ...BASELINE,
      modelSelector: "sonnet",
      effortLevel: "low",
    });
    expect(actions.map((a) => a.kind)).toEqual(["model", "effort"]);
  });

  test("all three commit in mode → model → effort order", () => {
    const actions = computeAiConfigCommit(BASELINE, {
      modelSelector: "sonnet",
      effortLevel: "low",
      mode: "plan",
    });
    expect(actions.map((a) => a.kind)).toEqual(["mode", "model", "effort"]);
  });

  test("a null pending effort (unsupported model) commits no effort action", () => {
    const actions = computeAiConfigCommit(BASELINE, {
      ...BASELINE,
      modelSelector: "haiku",
      effortLevel: null,
    });
    expect(actions.map((a) => a.kind)).toEqual(["model"]);
  });

  test("a null pending model selector commits no model action", () => {
    expect(
      computeAiConfigCommit(
        { ...BASELINE, modelSelector: "sonnet" },
        { ...BASELINE, modelSelector: null },
      ),
    ).toEqual([]);
  });
});

describe("clampEffortToSupport", () => {
  const SONNET_LEVELS = ["low", "medium", "high", "max"];

  test("a supported level passes through untouched", () => {
    expect(clampEffortToSupport("high", SONNET_LEVELS)).toBe("high");
  });

  test("xhigh drops to the nearest supported level below it", () => {
    expect(clampEffortToSupport("xhigh", SONNET_LEVELS)).toBe("high");
  });

  test("a model supporting nothing clamps to no level at all", () => {
    expect(clampEffortToSupport("high", [])).toBeNull();
  });

  test("a level below everything supported takes the lowest supported", () => {
    expect(clampEffortToSupport("low", ["high", "max"])).toBe("high");
  });

  test("an unrecognized level takes the lowest supported rather than sticking", () => {
    expect(clampEffortToSupport("colossal", SONNET_LEVELS)).toBe("low");
  });

  test("no pending level stays none", () => {
    expect(clampEffortToSupport(null, SONNET_LEVELS)).toBeNull();
  });

  test("unrecognized supported levels are ignored, not offered", () => {
    expect(clampEffortToSupport("max", ["medium", "colossal"])).toBe("medium");
  });
});

describe("selector collapse against the default row", () => {
  /**
   * The catalog can carry BOTH a `default` row and an explicit row resolving
   * to the same model, in which case `modelIdToSelector` maps the explicit row
   * back to `default` — mirroring the terminal, which checkmarks "Default" for
   * a session on the account default. Picking that explicit row therefore
   * commits nothing, which is correct (same model) but surprising enough to
   * pin here rather than discover as a bug report.
   */
  const CATALOG: CapabilityModel[] = [
    {
      value: "default",
      displayName: "Default (recommended)",
      description: "Opus 5 · Best for everyday, complex tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      value: "opus",
      displayName: "Opus",
      description: "Opus 5 · Best for everyday, complex tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      value: "sonnet",
      displayName: "Sonnet",
      description: "Sonnet 5 · Fast for most tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "max"],
    },
  ];

  test("the explicit twin of the default row normalizes to the default selector", () => {
    expect(modelIdToSelector("opus", CATALOG)).toBe("default");
  });

  test("re-picking the default row's twin commits nothing", () => {
    const baseline: AiConfigBaseline = {
      modelSelector: modelIdToSelector("claude-opus-5", CATALOG),
      effortLevel: "high",
      mode: "default",
    };
    const pending = { ...baseline, modelSelector: modelIdToSelector("opus", CATALOG) };
    expect(computeAiConfigCommit(baseline, pending)).toEqual([]);
  });

  test("a genuinely different row still commits", () => {
    const baseline: AiConfigBaseline = {
      modelSelector: modelIdToSelector("claude-opus-5", CATALOG),
      effortLevel: "high",
      mode: "default",
    };
    const pending = { ...baseline, modelSelector: modelIdToSelector("sonnet", CATALOG) };
    expect(computeAiConfigCommit(baseline, pending)).toEqual([
      { kind: "model", value: "sonnet" },
    ]);
  });
});

/**
 * The one resolution both editing surfaces read through — the mixer sheet's
 * open-time baseline and the Settings card's AI Model box. What is pinned here
 * is what stops those two from resolving "current" differently.
 */
describe("resolveAiConfigSources", () => {
  const CATALOG: CapabilityModel[] = [
    {
      value: "default",
      displayName: "Default (recommended)",
      description: "Opus 5 · Best for everyday, complex tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      value: "haiku",
      displayName: "Haiku",
      description: "Haiku 4.5 · Fastest for quick answers",
    },
  ];

  function snapshot(
    over: Partial<SessionMetadataSnapshot> = {},
  ): SessionMetadataSnapshot {
    return {
      sessionId: null,
      model: "default",
      permissionMode: "default",
      cwd: null,
      version: null,
      slashCommands: [],
      models: CATALOG,
      effort: null,
      ...over,
    };
  }

  test("an unset effort resolves to the EFFECTIVE level, not to null", () => {
    const sources = resolveAiConfigSources(snapshot(), CATALOG, null);
    expect(sources.value.modelSelector).toBe("default");
    expect(sources.value.effortLevel).toBe(DEFAULT_EFFORT_LEVEL);
    expect(sources.options).toBe(CATALOG);
  });

  test("a model offering no effort resolves the level to null", () => {
    const sources = resolveAiConfigSources(
      snapshot({ model: "haiku", effort: "high" }),
      CATALOG,
      null,
    );
    expect(sources.value.effortLevel).toBeNull();
  });

  test("the persisted per-card mode is the fallback, and null means none", () => {
    expect(
      resolveAiConfigSources(snapshot({ permissionMode: null }), CATALOG, "plan")
        .value.mode,
    ).toBe("plan");
    expect(
      resolveAiConfigSources(snapshot({ permissionMode: "auto" }), CATALOG, "plan")
        .value.mode,
    ).toBe("auto");
  });
});

describe("parseAiConfigRow", () => {
  test("the three row names round-trip", () => {
    expect(parseAiConfigRow({ kind: "string", value: "model" })).toBe("model");
    expect(parseAiConfigRow({ kind: "string", value: "effort" })).toBe("effort");
    expect(parseAiConfigRow({ kind: "string", value: "mode" })).toBe("mode");
  });

  test("junk, wrong kinds, and absence all narrow to null", () => {
    expect(parseAiConfigRow({ kind: "string", value: "sparkle" })).toBeNull();
    expect(parseAiConfigRow({ kind: "number", value: 3 })).toBeNull();
    expect(parseAiConfigRow(undefined)).toBeNull();
  });

  test("the persistence coordinates are the deck-level ai-config record", () => {
    expect(AI_CONFIG_DOMAIN).toBe("dev.tugapp.ai-config");
    expect(AI_CONFIG_LAST_ROW_KEY).toBe("lastRow");
  });
});
