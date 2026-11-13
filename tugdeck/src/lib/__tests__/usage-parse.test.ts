/**
 * usage-parse.test.ts — the `claude -p "/usage"` text parser.
 *
 * Drives {@link parseUsageText} on a verbatim sample of real `/usage` output
 * and asserts the graphical shape the sheet renders: windows, contribution
 * periods, characteristics, and the top skills/subagents/plugins tables.
 */

import { describe, expect, test } from "bun:test";
import { parseUsageText, parseTopEntries } from "../usage-parse";

const SAMPLE = [
  "You are currently using your subscription to power your Claude Code usage",
  "",
  "Current session: 69% used · resets Jul 13 at 11:20am (America/Los_Angeles)",
  "Current week (all models): 8% used · resets Jul 20 at 3am (America/Los_Angeles)",
  "Current week (Fable): 9% used · resets Jul 20 at 3am (America/Los_Angeles)",
  "",
  "What's contributing to your limits usage?",
  "Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.",
  "",
  "Last 24h · 1,922 requests · 23 sessions",
  "  91% of your usage was at >150k context",
  "  27% of your usage came from subagent-heavy sessions",
  "  Top skills: /tugplug:implement 41%, /tugplug:devise 2%, /tugplug:commit 1%",
  "  Top subagents: Explore 2%, general-purpose 1%",
  "  Top plugins: tugplug 45%",
  "",
  "Last 7d · 14,784 requests · 211 sessions",
  "  86% of your usage was at >150k context",
  "  Top skills: /tugplug:implement 27%",
].join("\n");

describe("parseUsageText", () => {
  const data = parseUsageText(SAMPLE);

  test("captures the plan line and the contributing caveat", () => {
    expect(data.planLine).toContain("using your subscription");
    expect(data.contributingCaveat).toContain("based on local sessions");
  });

  test("parses all three limit windows with percent + reset", () => {
    expect(data.windows).toHaveLength(3);
    expect(data.windows[0]).toEqual({
      label: "Current session",
      percent: 69,
      resetText: "resets Jul 13 at 11:20am (America/Los_Angeles)",
    });
    expect(data.windows[1].label).toBe("Current week (all models)");
    expect(data.windows[2].label).toBe("Current week (Fable)");
    expect(data.windows[2].percent).toBe(9);
  });

  test("parses both periods with request/session counts", () => {
    expect(data.periods.map((p) => p.label)).toEqual(["Last 24h", "Last 7d"]);
    expect(data.periods[0].requests).toBe(1922);
    expect(data.periods[0].sessions).toBe(23);
    expect(data.periods[1].requests).toBe(14784);
  });

  test("parses characteristics and the top tables per period", () => {
    const p = data.periods[0];
    expect(p.characteristics).toEqual([
      { percent: 91, text: "of your usage was at >150k context" },
      { percent: 27, text: "of your usage came from subagent-heavy sessions" },
    ]);
    expect(p.skills).toEqual([
      { name: "/tugplug:implement", percent: 41 },
      { name: "/tugplug:devise", percent: 2 },
      { name: "/tugplug:commit", percent: 1 },
    ]);
    expect(p.subagents).toEqual([
      { name: "Explore", percent: 2 },
      { name: "general-purpose", percent: 1 },
    ]);
    expect(p.plugins).toEqual([{ name: "tugplug", percent: 45 }]);
  });

  test("a thinner period (no subagents/plugins) yields empty tables, not a throw", () => {
    const p = data.periods[1];
    expect(p.skills).toEqual([{ name: "/tugplug:implement", percent: 27 }]);
    expect(p.subagents).toEqual([]);
    expect(p.plugins).toEqual([]);
  });

  test("empty / garbage input degrades to an empty panel", () => {
    const empty = parseUsageText("");
    expect(empty.windows).toEqual([]);
    expect(empty.periods).toEqual([]);
    expect(empty.planLine).toBeNull();
  });
});

/**
 * Verbatim Claude Code 2.1.322 output. The windows are unchanged in form; the
 * session window is absent because the CLI prints a window only while the API
 * reports it. The contributing section now carries percent-led tips and a
 * shorter caveat.
 */
const SAMPLE_2_1_322 = [
  "You are currently using your subscription to power your Claude Code usage",
  "",
  "Current week (all models): 2% used · resets Nov 16 at 1:59am (America/Los_Angeles)",
  "Current week (Fable): 2% used · resets Nov 16 at 1:59am (America/Los_Angeles)",
  "",
  "What's contributing to your usage?",
  "Approximate · sessions on this machine only · shares overlap",
  "",
  "Last 24h · 8048 requests · 217 sessions",
  "  79%  Start fresh when you switch tasks · run /clear",
  "  19%  Trim ~/Mounts/u/src/tug/CLAUDE.md · 7k tokens per request",
  "  Top skills: /tugplug:arc-implement 52%, /tugplug:arc-audit 8%",
  "  Top subagents: general-purpose 1%",
  "  Top plugins: tugplug 66%",
].join("\n");

describe("parseUsageText on 2.1.322 output", () => {
  const data = parseUsageText(SAMPLE_2_1_322);

  test("parses the windows the CLI printed, with no session window", () => {
    expect(data.windows.map((w) => w.label)).toEqual([
      "Current week (all models)",
      "Current week (Fable)",
    ]);
  });

  test("captures the shorter caveat", () => {
    expect(data.contributingCaveat).toBe(
      "Approximate · sessions on this machine only · shares overlap",
    );
  });

  test("parses tips as characteristics and keeps the tables", () => {
    const p = data.periods[0];
    expect(p.requests).toBe(8048);
    expect(p.characteristics).toEqual([
      { percent: 79, text: "Start fresh when you switch tasks · run /clear" },
      { percent: 19, text: "Trim ~/Mounts/u/src/tug/CLAUDE.md · 7k tokens per request" },
    ]);
    expect(p.skills).toHaveLength(2);
    expect(p.plugins).toEqual([{ name: "tugplug", percent: 66 }]);
  });
});

describe("parseTopEntries", () => {
  test("splits `name N%` segments, keeping hyphenated names intact", () => {
    expect(parseTopEntries("Explore 2%, general-purpose 1%")).toEqual([
      { name: "Explore", percent: 2 },
      { name: "general-purpose", percent: 1 },
    ]);
  });

  test("ignores malformed segments", () => {
    expect(parseTopEntries("nonsense, tugplug 45%")).toEqual([
      { name: "tugplug", percent: 45 },
    ]);
  });
});
