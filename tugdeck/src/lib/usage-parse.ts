/**
 * usage-parse.ts — parse the text `claude -p "/usage"` prints into the shape
 * the `/usage` sheet renders.
 *
 * `claude -p "/usage"` emits the whole panel as plain text: a plan line, the
 * limit windows (each `Label: N% used · resets …`), then a "What's contributing
 * to your usage?" section with one or more time periods (`Last 24h`,
 * `Last 7d`), each carrying request/session counts, percent-led
 * characteristics, and top skills / subagents / plugins tables. This
 * module turns that text into {@link UsageData} with pure, unit-testable
 * functions — no store, DOM, or React.
 *
 * Tolerant by construction: unknown lines are ignored, a missing section yields
 * an empty array / null rather than throwing, so a CLI format drift degrades to
 * a thinner panel instead of a blank one.
 *
 * @module lib/usage-parse
 */

/** One subscription limit window (session / weekly / Fable / …). */
export interface UsageWindow {
  /** e.g. "Current session", "Current week (all models)", "Current week (Fable)". */
  label: string;
  /** Used percentage, 0–100. */
  percent: number;
  /** Reset caption verbatim, e.g. "resets Jul 13 at 11:20am (America/Los_Angeles)". */
  resetText: string;
}

/**
 * One percent-led line under a period. Claude Code ≤ 2.1.2xx printed usage
 * characteristics (`91% of your usage was at >150k context`); 2.1.3xx prints
 * tips (`79%  Start fresh when you switch tasks · run /clear`). Both parse here.
 */
export interface UsageCharacteristic {
  percent: number;
  /** The clause after the percent, e.g. "Start fresh when you switch tasks · run /clear". */
  text: string;
}

/** One `name N%` entry in a top-skills / subagents / plugins table. */
export interface UsageTableEntry {
  name: string;
  percent: number;
}

/** A "Last 24h" / "Last 7d" contribution period. */
export interface UsagePeriod {
  /** e.g. "Last 24h", "Last 7d". */
  label: string;
  requests: number | null;
  sessions: number | null;
  characteristics: UsageCharacteristic[];
  skills: UsageTableEntry[];
  subagents: UsageTableEntry[];
  plugins: UsageTableEntry[];
}

/** The full parsed `/usage` panel. */
export interface UsageData {
  /** The lead plan line, e.g. "You are currently using your subscription…". */
  planLine: string | null;
  windows: UsageWindow[];
  /**
   * The "Approximate…" caveat, if present — "Approximate, based on local
   * sessions…" before 2.1.3xx, "Approximate · sessions on this machine only ·
   * shares overlap" since.
   */
  contributingCaveat: string | null;
  periods: UsagePeriod[];
}

const WINDOW_RE = /^(.+?):\s+(\d+)%\s+used\s+·\s+(.+)$/;
const PERIOD_RE = /^Last\s+(\S+)\s+·\s+([\d,]+)\s+requests?\s+·\s+([\d,]+)\s+sessions?/i;
const CHARACTERISTIC_RE = /^(\d+)%\s+(.+)$/;
const TOP_RE = /^Top\s+(skills|subagents|plugins):\s+(.+)$/i;

/** Parse `"12,345"` / `"77"` → number, or null. */
function parseCount(raw: string): number | null {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a comma-separated `name N%` list (`"/tugplug:implement 41%, Explore
 * 2%"`) into entries. Names never contain a space in claude's output (slash
 * commands, agent ids, plugin names), so the trailing `N%` splits each segment
 * cleanly.
 */
export function parseTopEntries(list: string): UsageTableEntry[] {
  const entries: UsageTableEntry[] = [];
  for (const segment of list.split(",")) {
    const m = segment.trim().match(/^(.+?)\s+(\d+)%$/);
    if (m === null) continue;
    entries.push({ name: m[1].trim(), percent: Number(m[2]) });
  }
  return entries;
}

/** Parse the full `claude -p "/usage"` text into {@link UsageData}. */
export function parseUsageText(text: string): UsageData {
  const lines = text.split("\n");
  const data: UsageData = {
    planLine: null,
    windows: [],
    contributingCaveat: null,
    periods: [],
  };
  let period: UsagePeriod | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    if (data.planLine === null && /^You are currently using/i.test(line)) {
      data.planLine = line;
      continue;
    }

    const win = line.match(WINDOW_RE);
    if (win !== null) {
      data.windows.push({
        label: win[1].trim(),
        percent: Number(win[2]),
        resetText: win[3].trim(),
      });
      continue;
    }

    if (period === null && /^Approximate\b/i.test(line)) {
      data.contributingCaveat = line;
      continue;
    }

    const per = line.match(PERIOD_RE);
    if (per !== null) {
      period = {
        label: `Last ${per[1]}`,
        requests: parseCount(per[2]),
        sessions: parseCount(per[3]),
        characteristics: [],
        skills: [],
        subagents: [],
        plugins: [],
      };
      data.periods.push(period);
      continue;
    }

    if (period !== null) {
      const ch = line.match(CHARACTERISTIC_RE);
      if (ch !== null) {
        period.characteristics.push({ percent: Number(ch[1]), text: ch[2].trim() });
        continue;
      }
      const top = line.match(TOP_RE);
      if (top !== null) {
        const entries = parseTopEntries(top[2]);
        const kind = top[1].toLowerCase();
        if (kind === "skills") period.skills = entries;
        else if (kind === "subagents") period.subagents = entries;
        else if (kind === "plugins") period.plugins = entries;
      }
    }
  }

  return data;
}
