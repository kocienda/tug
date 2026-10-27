/**
 * Golden-fixture loader for `CodeSessionStore` tests.
 *
 * Reads `.jsonl` probes from the Rust-owned stream-json catalog at
 * `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/<version>/`
 * directly via an `import.meta.dir`-relative path (no copy, no symlink,
 * no build step). The Rust-side `stream_json_catalog_drift.rs`
 * regression test already guards the catalog against divergence — this
 * loader reuses the same bytes so the reducer sees exactly what live
 * Claude produced on capture.
 *
 * [D07] golden fixtures read in-place
 * (#s06-golden-loader)
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Relative prefix from this file's directory to the catalog root.
 *
 * The file lives at:
 *   `tugdeck/src/lib/code-session-store/testing/golden-catalog.ts`
 *
 * The catalog lives at:
 *   `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/`
 *
 * Five `..` segments walk us from `testing/` up through
 * `code-session-store/ → lib/ → src/ → tugdeck/` to the repo root, then
 * we descend into `tugrust/`. A future repo reshuffle that breaks this
 * path fails loudly with the resolved absolute path included in the
 * thrown error (see `loadGoldenProbe` below).
 */
const FIXTURE_ROOT_RELATIVE =
  "../../../../../tugrust/crates/tugcast/tests/fixtures/stream-json-catalog";

/**
 * Canonical pinned values for identity classes. Used directly when the
 * fixture has exactly one occurrence of a given ID field, and as the base
 * for occurrence-indexed helpers when the fixture has multiple distinct
 * occurrences (see `loadGoldenProbe` substitution rules).
 */
export const FIXTURE_IDS = {
  TUG_SESSION_ID: "tug00000-0000-4000-8000-000000000001",
  CLAUDE_SESSION_ID: "cla00000-0000-4000-8000-000000000001",
  MSG_ID: "msg00000-0000-4000-8000-000000000001",
  TOOL_USE_ID: "tool0000-0000-4000-8000-000000000001",
  REQUEST_ID: "req00000-0000-4000-8000-000000000001",
  TASK_ID: "task0000-0000-4000-8000-000000000001",
  CWD: "/tmp/fixture-cwd",
  MSG_ID_N: (n: number): string =>
    `msg00000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  TOOL_USE_ID_N: (n: number): string =>
    `tool0000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  REQUEST_ID_N: (n: number): string =>
    `req00000-0000-4000-8000-${String(n).padStart(12, "0")}`,
} as const;

/** A parsed event record. Step 2 uses a permissive shape. */
export type GoldenEvent = Record<string, unknown> & { type: string };

/** Per-probe id grouping exposed to tests for assertion without re-derivation. */
export interface GoldenProbeIdMap {
  msgIds: ReadonlyArray<string>;
  toolUseIds: ReadonlyArray<string>;
  requestIds: ReadonlyArray<string>;
}

export interface GoldenProbe {
  version: string;
  probeName: string;
  events: ReadonlyArray<GoldenEvent>;
  idMap: GoldenProbeIdMap;
}

// ---------------------------------------------------------------------------
// Text-level placeholder preprocessing
// ---------------------------------------------------------------------------

/**
 * Substitute the non-uuid tokens at the raw-string level, before JSON parse.
 *
 * - `"{{f64}}"` → `0` (strips quotes; serializer captured as a JSON string
 *   but the real wire shape is a number).
 * - `"{{i64}}"` → `0` (same).
 * - `{{text:len=N}}` → N repeated `"x"` characters (stays inside the
 *   enclosing JSON string).
 * - `{{cwd}}` → `FIXTURE_IDS.CWD` (stays inside the enclosing JSON string;
 *   suffix paths like `{{cwd}}/Mounts/u/src/tugtool` are preserved).
 *
 * `{{uuid}}` is NOT substituted here — it needs occurrence-aware handling
 * and runs in a second pass after JSON parse.
 */
function preprocessRawJsonl(raw: string): string {
  return raw
    .replace(/"\{\{f64\}\}"/g, "0")
    .replace(/"\{\{i64\}\}"/g, "0")
    .replace(/\{\{text:len=(\d+)\}\}/g, (_, n) =>
      "x".repeat(parseInt(n, 10)),
    )
    .replace(/\{\{cwd\}\}/g, FIXTURE_IDS.CWD);
}

/**
 * Throw if any non-uuid placeholder tokens remain after preprocessing.
 * Anything other than `{{uuid}}` signals an unknown token class the
 * loader has not been taught to handle.
 */
function assertNoUnknownTokens(processed: string, absPath: string): void {
  const matches = processed.match(/\{\{[^}]*\}\}/g);
  if (!matches) return;
  const unknown = matches.filter((m) => m !== "{{uuid}}");
  if (unknown.length > 0) {
    const unique = Array.from(new Set(unknown));
    throw new Error(
      `golden-catalog: unknown placeholder token(s) in fixture ${absPath}: ${unique.join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Occurrence-aware uuid substitution
// ---------------------------------------------------------------------------

/**
 * Fields where `{{uuid}}` is a known id and may appear multiple times
 * across an event stream. Any other field that carries `{{uuid}}` is a
 * forward-compat surprise and trips the falsification guard.
 *
 * The camelCase ids arrived with later captures — the prompt anchor's
 * `promptUuid`, the rewind and fork lineage's `forkPoint` /
 * `newSessionId` / `parentSessionId`, the in-place rewind's `session_rewound`
 * `sessionId`, and a bare `uuid` — and keep their
 * placeholder as-is.
 */
const KNOWN_UUID_FIELDS: ReadonlySet<string> = new Set([
  "session_id",
  "tug_session_id",
  "msg_id",
  "tool_use_id",
  "request_id",
  "task_id",
  "claude_session_id",
  "promptUuid",
  "forkPoint",
  "newSessionId",
  "parentSessionId",
  "sessionId",
  "uuid",
]);

interface PendingToolCall {
  idIdx: number;
  toolName: string;
}

/**
 * Walk the parsed events once to compute field-and-occurrence-aware
 * overrides for every top-level `{{uuid}}` field. The returned
 * `eventOverrides[i]` holds the resolved id for each id-field on event
 * `events[i]`; the caller applies them in a second pass.
 */
function computeIdOverrides(events: ReadonlyArray<Record<string, unknown>>): {
  eventOverrides: Array<Record<string, string>>;
  logicalTurnCount: number;
  turnIdxPerEvent: Array<number | null>;
  logicalToolCallCount: number;
  toolIdxPerEvent: Array<number | null>;
} {
  const eventOverrides: Array<Record<string, string>> = events.map(() => ({}));
  const turnIdxPerEvent: Array<number | null> = events.map(() => null);
  const toolIdxPerEvent: Array<number | null> = events.map(() => null);

  let logicalTurnCount = 0;
  let logicalToolCallCount = 0;
  let currentTurnIdx: number | null = null;

  const pendingInput: PendingToolCall[] = [];
  const completeInput: PendingToolCall[] = [];
  let lastResolvedToolIdx: number | null = null;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const type = ev.type as string;

    // --- session-wide ids ---
    if (ev.session_id === "{{uuid}}") {
      eventOverrides[i].session_id = "__SESSION_ID__";
    }
    if (ev.tug_session_id === "{{uuid}}") {
      eventOverrides[i].tug_session_id = "__TUG_SESSION_ID__";
    }

    // --- turn tracking (msg_id) ---
    const needsMsgIdResolution = ev.msg_id === "{{uuid}}";

    if (type === "assistant_text" || type === "thinking_text") {
      if (
        ev.is_partial === true &&
        ev.rev === 0 &&
        ev.seq === 0 &&
        currentTurnIdx === null
      ) {
        currentTurnIdx = logicalTurnCount;
        logicalTurnCount += 1;
      }
      if (needsMsgIdResolution) {
        if (currentTurnIdx === null) {
          // Non-opening partial with no open turn — treat it as an
          // implicit open so the id resolves deterministically.
          currentTurnIdx = logicalTurnCount;
          logicalTurnCount += 1;
        }
        eventOverrides[i].msg_id = `__TURN_${currentTurnIdx}__`;
        turnIdxPerEvent[i] = currentTurnIdx;
      }
    } else if (type === "tool_use") {
      // tool_use events also carry msg_id for the current open turn.
      // Some probes emit tool_use BEFORE the first assistant_text (e.g.
      // test-05, test-07); treat that as an implicit turn open.
      if (needsMsgIdResolution) {
        if (currentTurnIdx === null) {
          currentTurnIdx = logicalTurnCount;
          logicalTurnCount += 1;
        }
        eventOverrides[i].msg_id = `__TURN_${currentTurnIdx}__`;
        turnIdxPerEvent[i] = currentTurnIdx;
      }
    } else if (type === "turn_complete") {
      if (needsMsgIdResolution) {
        if (currentTurnIdx === null) {
          currentTurnIdx = logicalTurnCount;
          logicalTurnCount += 1;
        }
        eventOverrides[i].msg_id = `__TURN_${currentTurnIdx}__`;
        turnIdxPerEvent[i] = currentTurnIdx;
      }
      currentTurnIdx = null;
    }

    // --- tool_use_id tracking ---
    if (type === "tool_use" && ev.tool_use_id === "{{uuid}}") {
      const input = ev.input as Record<string, unknown> | undefined;
      const hasEmptyInput =
        input !== undefined && Object.keys(input).length === 0;
      const toolName = (ev.tool_name as string) ?? "";

      if (hasEmptyInput) {
        // New logical call opens at this event.
        const idIdx = logicalToolCallCount;
        logicalToolCallCount += 1;
        pendingInput.push({ idIdx, toolName });
        eventOverrides[i].tool_use_id = `__TOOL_${idIdx}__`;
        toolIdxPerEvent[i] = idIdx;
      } else {
        // Non-empty input — continuation of the most recent pending
        // call with the same tool_name (LIFO within tool_name).
        let popIdx = -1;
        for (let k = pendingInput.length - 1; k >= 0; k--) {
          if (pendingInput[k].toolName === toolName) {
            popIdx = k;
            break;
          }
        }
        if (popIdx >= 0) {
          const entry = pendingInput.splice(popIdx, 1)[0];
          completeInput.push(entry);
          eventOverrides[i].tool_use_id = `__TOOL_${entry.idIdx}__`;
          toolIdxPerEvent[i] = entry.idIdx;
        } else {
          // No matching pending entry — fall back to a new logical id.
          // Should not happen for v2.1.105 probes; emit a warning.
          console.warn(
            `golden-catalog: tool_use continuation without pending entry at event ${i} (tool_name=${toolName})`,
          );
          const idIdx = logicalToolCallCount;
          logicalToolCallCount += 1;
          eventOverrides[i].tool_use_id = `__TOOL_${idIdx}__`;
          toolIdxPerEvent[i] = idIdx;
        }
      }
    } else if (type === "tool_result" && ev.tool_use_id === "{{uuid}}") {
      const entry = completeInput.shift();
      if (entry) {
        eventOverrides[i].tool_use_id = `__TOOL_${entry.idIdx}__`;
        toolIdxPerEvent[i] = entry.idIdx;
        lastResolvedToolIdx = entry.idIdx;
      }
    } else if (
      type === "tool_use_structured" &&
      ev.tool_use_id === "{{uuid}}" &&
      lastResolvedToolIdx !== null
    ) {
      eventOverrides[i].tool_use_id = `__TOOL_${lastResolvedToolIdx}__`;
      toolIdxPerEvent[i] = lastResolvedToolIdx;
    }
  }

  return {
    eventOverrides,
    logicalTurnCount,
    turnIdxPerEvent,
    logicalToolCallCount,
    toolIdxPerEvent,
  };
}

/**
 * Resolve the symbolic override tokens produced by `computeIdOverrides`
 * into concrete `FIXTURE_IDS` values. Single-occurrence probes get the
 * canonical constant; multi-occurrence probes get the `_N`-indexed
 * helper (1-based).
 */
function resolveOverrides(
  eventOverrides: Array<Record<string, string>>,
  logicalTurnCount: number,
  logicalToolCallCount: number,
): {
  resolvedOverrides: Array<Record<string, string>>;
  msgIds: ReadonlyArray<string>;
  toolUseIds: ReadonlyArray<string>;
} {
  const msgIds: string[] = [];
  for (let n = 0; n < logicalTurnCount; n++) {
    msgIds.push(
      logicalTurnCount === 1
        ? FIXTURE_IDS.MSG_ID
        : FIXTURE_IDS.MSG_ID_N(n + 1),
    );
  }

  const toolUseIds: string[] = [];
  for (let n = 0; n < logicalToolCallCount; n++) {
    toolUseIds.push(
      logicalToolCallCount === 1
        ? FIXTURE_IDS.TOOL_USE_ID
        : FIXTURE_IDS.TOOL_USE_ID_N(n + 1),
    );
  }

  const resolved: Array<Record<string, string>> = eventOverrides.map(
    (over) => {
      const out: Record<string, string> = {};
      for (const [field, token] of Object.entries(over)) {
        if (token === "__TUG_SESSION_ID__") {
          out[field] = FIXTURE_IDS.TUG_SESSION_ID;
        } else if (token === "__SESSION_ID__") {
          out[field] = FIXTURE_IDS.CLAUDE_SESSION_ID;
        } else if (token.startsWith("__TURN_")) {
          const n = parseInt(token.slice("__TURN_".length, -2), 10);
          out[field] = msgIds[n];
        } else if (token.startsWith("__TOOL_")) {
          const n = parseInt(token.slice("__TOOL_".length, -2), 10);
          out[field] = toolUseIds[n];
        } else {
          out[field] = token;
        }
      }
      return out;
    },
  );

  return { resolvedOverrides: resolved, msgIds, toolUseIds };
}

/**
 * Recursively walk an event, substituting any `{{uuid}}` leaf with the
 * matching override. Top-level id fields use the precomputed override;
 * nested `{{uuid}}` leaves (not expected in v2.1.105) trip the
 * falsification guard unless they land on a `KNOWN_UUID_FIELDS` key.
 */
function applyEventOverrides(
  ev: Record<string, unknown>,
  overrides: Record<string, string>,
  probePath: string,
  eventIdx: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ev)) {
    if (value === "{{uuid}}") {
      if (overrides[key] !== undefined) {
        out[key] = overrides[key];
      } else if (KNOWN_UUID_FIELDS.has(key)) {
        // Known field but no computed override — session-wide sole
        // occurrences (handled above) cover the common cases; fall back
        // to the canonical constant for anything else so the fixture
        // parses rather than failing.
        if (key === "task_id") {
          out[key] = FIXTURE_IDS.TASK_ID;
        } else if (key === "request_id") {
          out[key] = FIXTURE_IDS.REQUEST_ID;
        } else {
          out[key] = "{{uuid}}";
        }
      } else {
        throw new Error(
          `golden-catalog: {{uuid}} found in unknown field "${key}" at event ${eventIdx} of ${probePath}`,
        );
      }
    } else if (typeof value === "string" && value.includes("{{uuid}}")) {
      throw new Error(
        `golden-catalog: embedded {{uuid}} in string value at event ${eventIdx}, field "${key}" of ${probePath}`,
      );
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        typeof item === "object" && item !== null
          ? applyEventOverrides(
              item as Record<string, unknown>,
              {},
              probePath,
              eventIdx,
            )
          : assertLeafHasNoUuid(item, probePath, eventIdx, key),
      );
    } else if (typeof value === "object" && value !== null) {
      out[key] = applyEventOverrides(
        value as Record<string, unknown>,
        {},
        probePath,
        eventIdx,
      );
    } else {
      out[key] = assertLeafHasNoUuid(value, probePath, eventIdx, key);
    }
  }
  return out;
}

function assertLeafHasNoUuid(
  value: unknown,
  probePath: string,
  eventIdx: number,
  key: string,
): unknown {
  if (typeof value === "string" && value === "{{uuid}}") {
    throw new Error(
      `golden-catalog: nested {{uuid}} leaf at event ${eventIdx}, field "${key}" of ${probePath}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * List every catalog version (`v2.1.104`, `v2.1.105`, …), sorted: the
 * version directories that carry a `manifest.json`. The `-spike` directories
 * beside them have none — they hold raw `claude -p` captures, not the
 * post-tugcode frames this loader serves (see their `README.md`). A test that
 * must hold across the whole catalog walks this rather than naming versions,
 * so a newly captured version is covered the moment its directory lands.
 */
export function listGoldenVersions(): string[] {
  const root = path.resolve(import.meta.dir, FIXTURE_ROOT_RELATIVE);
  return readdirSync(root)
    .filter((entry) => existsSync(path.join(root, entry, "manifest.json")))
    .sort();
}

/**
 * List the *loadable* probe names for a catalog version — every
 * `.jsonl` file in the version directory with non-zero size, sorted.
 *
 * Empty fixtures (skipped manifest entries — e.g. probes blocked on an
 * upstream bug, or first-run flakes) are excluded: `loadGoldenProbe`
 * throws on a 0-byte file, so a caller iterating this list can load
 * every name it returns without a guard. Keeps the catalog-root path
 * resolution in one place ({@link FIXTURE_ROOT_RELATIVE}) so callers
 * never recompute the fragile `..`-relative walk.
 *
 * Throws a readable `Error` (including the resolved absolute path) if
 * the version directory is missing.
 */
export function listGoldenProbes(version: string): string[] {
  const dir = path.resolve(import.meta.dir, FIXTURE_ROOT_RELATIVE, version);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    throw new Error(
      `golden-catalog: failed to list catalog version directory at ${dir} — ${(err as Error).message}`,
    );
  }
  return entries
    .filter((f) => f.endsWith(".jsonl"))
    .filter((f) => statSync(path.join(dir, f)).size > 0)
    .map((f) => f.slice(0, -".jsonl".length))
    .sort();
}

/**
 * Load a golden probe from the v2.1.105 catalog, apply placeholder
 * substitutions, and return the parsed events + id map.
 *
 * Throws a readable `Error` (including the resolved absolute path) on
 * missing files, empty files, unknown token classes, or `{{uuid}}` in
 * unknown fields.
 */
export function loadGoldenProbe(
  version: string,
  probeName: string,
): GoldenProbe {
  const absPath = path.resolve(
    import.meta.dir,
    FIXTURE_ROOT_RELATIVE,
    version,
    `${probeName}.jsonl`,
  );

  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch (err) {
    throw new Error(
      `golden-catalog: failed to read fixture at ${absPath} — ${(err as Error).message}`,
    );
  }

  if (raw.length === 0) {
    throw new Error(
      `golden-catalog: empty fixture at ${absPath} (the probe exists but captured 0 events — likely a skipped entry in the manifest)`,
    );
  }

  const processed = preprocessRawJsonl(raw);
  assertNoUnknownTokens(processed, absPath);

  const lines = processed.split("\n").filter((line) => line.length > 0);
  const parsed: Array<Record<string, unknown>> = lines.map((line, i) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `golden-catalog: JSON parse error on line ${i + 1} of ${absPath}: ${(err as Error).message}`,
      );
    }
  });

  const {
    eventOverrides,
    logicalTurnCount,
    logicalToolCallCount,
  } = computeIdOverrides(parsed);

  const { resolvedOverrides, msgIds, toolUseIds } = resolveOverrides(
    eventOverrides,
    logicalTurnCount,
    logicalToolCallCount,
  );

  const events: GoldenEvent[] = parsed.map((ev, i) => {
    const withOverrides = applyEventOverrides(
      ev,
      resolvedOverrides[i],
      absPath,
      i,
    );
    return withOverrides as GoldenEvent;
  });

  return {
    version,
    probeName,
    events,
    idMap: {
      msgIds,
      toolUseIds,
      requestIds: [],
    },
  };
}
