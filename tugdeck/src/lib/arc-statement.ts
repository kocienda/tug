/**
 * arc-statement — what a `tugarcs` fence declares, and what each of its rows
 * reads against the cycle.
 *
 * A session that lays out a run of arcs states it in one `tugarcs` fence, and
 * tugcast queues the arcs when the answer ends. The card draws the same fence
 * as the run it declares, so it parses the spec by the same rules the core
 * does: this is the TypeScript twin of `tugarc-core`'s `statement::parse_fence`,
 * and the two are held equal by one shared fixture
 * (`src/lib/__tests__/fixtures/arc-statements.json`), whose cases both suites
 * read. The warnings are worded for a reader of this side and only their count
 * is compared.
 *
 * {@link arcRowReading} is what a row says: the arc's entry on its project's
 * cycles when one names it, else what the arc log says became of it, else that
 * it is not queued. It is pure over the values it is handed, so the hook that
 * makes the frames live reads the stores and this decides.
 *
 * @module lib/arc-statement
 */

import type { CitedArcAnswer } from "@/lib/arc-citation-store";
import type { CycleEntryWire, CycleWire } from "@/lib/changeset-types";

/** One arc a statement names. */
export interface StatedArc {
  name: string;
  /** The brief's path, relative to the project root. */
  brief: string;
  label?: string;
  /** Absent: waits on the arc before it. Empty: waits on nothing. */
  after?: string[];
}

/** What a fence's text parses to. */
export type ArcStatementParse =
  | { arcs: StatedArc[]; warnings: string[] }
  /** `<path>: <reason>`, the path naming the field at fault. */
  | { error: string };

/** The most arcs a statement is read for. */
export const MAX_STATED_ARCS = 40;

/** The longest a label may be, in characters, before it is warned of. */
export const MAX_ARC_LABEL = 60;

const ARC_KEYS = new Set(["name", "brief", "label", "after"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a `tugarcs` fence's body. Everything the spec can be repaired from is
 * repaired, each repair one warning; what cannot be drawn is an error.
 */
export function parseArcStatement(text: string): ArcStatementParse {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (e) {
    return { error: `$: not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isObject(root)) return { error: "$: not an object" };
  if (!("tugarcs" in root)) return { error: "tugarcs: missing" };
  if (root.tugarcs !== 1) return { error: "tugarcs: must be 1" };
  if (!("arcs" in root)) return { error: "arcs: missing" };
  const arcs = root.arcs;
  if (!Array.isArray(arcs)) return { error: "arcs: not an array" };
  if (arcs.length === 0) return { error: "arcs: empty" };

  const warnings: string[] = [];
  for (const key of Object.keys(root)) {
    if (key !== "tugarcs" && key !== "arcs") warnings.push(`${key}: unknown key, ignored`);
  }

  // Every arc is checked for drawability before any is repaired, so a spec
  // with an undrawable arc past the fortieth is still refused.
  for (let i = 0; i < arcs.length; i++) {
    const arc: unknown = arcs[i];
    if (!isObject(arc)) return { error: `arcs[${i}]: not an object` };
    for (const field of ["name", "brief"]) {
      if (!(field in arc)) return { error: `arcs[${i}].${field}: missing` };
      if (typeof arc[field] !== "string") return { error: `arcs[${i}].${field}: not a string` };
    }
  }
  if (arcs.length > MAX_STATED_ARCS) {
    warnings.push(`arcs: ${arcs.length} arcs, only the first ${MAX_STATED_ARCS} are read`);
  }

  const out: StatedArc[] = [];
  const seen = new Set<string>();
  arcs.slice(0, MAX_STATED_ARCS).forEach((value: unknown, i) => {
    const obj = value as Record<string, unknown>;
    const name = obj.name as string;
    const brief = obj.brief as string;
    for (const key of Object.keys(obj)) {
      if (!ARC_KEYS.has(key)) warnings.push(`arcs[${i}].${key}: unknown key, ignored`);
    }
    if (seen.has(name)) {
      warnings.push(`arcs[${i}].name: ${name} is given twice, left out`);
      return;
    }
    seen.add(name);
    const arc: StatedArc = { name, brief };

    const label = obj.label;
    if (typeof label === "string") {
      if ([...label].length > MAX_ARC_LABEL) {
        warnings.push(`arcs[${i}].label: longer than ${MAX_ARC_LABEL} characters`);
      }
      arc.label = label;
    } else if (label !== undefined && label !== null) {
      warnings.push(`arcs[${i}].label: not a string, left out`);
    }

    const after = obj.after;
    if (Array.isArray(after)) {
      const names: string[] = [];
      after.forEach((item: unknown, j) => {
        if (typeof item !== "string") {
          warnings.push(`arcs[${i}].after[${j}]: not a string, left out`);
        } else if (item === name) {
          warnings.push(`arcs[${i}].after[${j}]: ${name} waits on itself, left out`);
        } else if (names.includes(item)) {
          warnings.push(`arcs[${i}].after[${j}]: ${item} is given twice, left out`);
        } else {
          names.push(item);
        }
      });
      arc.after = names;
    } else if (after !== undefined && after !== null) {
      warnings.push(`arcs[${i}].after: not an array, left out`);
    }
    out.push(arc);
  });

  // An `after` naming no arc of the statement may name one already on the
  // cycle, which only the apply can say; it is kept and warned of.
  const names = new Set(out.map((a) => a.name));
  out.forEach((arc, i) => {
    for (const n of arc.after ?? []) {
      if (!names.has(n)) {
        warnings.push(`arcs[${i}].after: ${n} is not in this statement, so it must already be on the cycle`);
      }
    }
  });

  return { arcs: out, warnings };
}

/** The command that opens a stated arc, as the brief skill writes it. */
export function arcCommandText(arc: Pick<StatedArc, "name" | "brief">): string {
  return `/arc ${arc.name} @${arc.brief}`;
}

/** Where a stated arc stands. */
export type ArcRowState = "ready" | "waiting" | "running" | "joined" | "dropped" | "none";

/** What one row of a drawn statement reads. */
export interface ArcRowReading {
  state: ArcRowState;
  /** The word the row shows. */
  word: string;
  /** Whether the row offers the command that opens the arc. */
  command: boolean;
}

const ENTRY_READINGS: Readonly<Record<CycleEntryWire["state"], ArcRowReading>> = {
  ready: { state: "ready", word: "Ready", command: true },
  waiting: { state: "waiting", word: "Waiting", command: true },
  running: { state: "running", word: "Running", command: false },
  joined: { state: "joined", word: "Landed", command: false },
  dropped: { state: "dropped", word: "Dropped", command: false },
};

const NOT_QUEUED: ArcRowReading = { state: "none", word: "Not queued", command: true };

function settled(entry: CycleEntryWire): boolean {
  return entry.state === "joined" || entry.state === "dropped";
}

/**
 * The entry on `cycles` named for `name`: an unsettled one when there is one,
 * else the one with the highest number.
 */
export function entryForArc(name: string, cycles: readonly CycleWire[]): CycleEntryWire | null {
  let best: CycleEntryWire | null = null;
  for (const cycle of cycles) {
    for (const entry of cycle.entries) {
      if (entry.name !== name) continue;
      if (best === null) {
        best = entry;
        continue;
      }
      const open = !settled(entry);
      const bestOpen = !settled(best);
      if (open !== bestOpen ? open : entry.n > best.n) best = entry;
    }
  }
  return best;
}

/**
 * What a stated arc's row reads. `cycles` are the cycles of the session's
 * project; `fate` is the arc log's answer for the name, consulted only when no
 * entry names the arc.
 */
export function arcRowReading(
  arc: Pick<StatedArc, "name">,
  cycles: readonly CycleWire[],
  fate: CitedArcAnswer,
): ArcRowReading {
  const entry = entryForArc(arc.name, cycles);
  if (entry !== null) return ENTRY_READINGS[entry.state];
  if (fate.status === "found") {
    if (fate.fate === "joined") return ENTRY_READINGS.joined;
    if (fate.fate === "live") return ENTRY_READINGS.running;
    return { state: "dropped", word: "Discarded", command: false };
  }
  return NOT_QUEUED;
}
