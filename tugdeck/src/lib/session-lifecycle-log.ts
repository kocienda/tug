/**
 * session-lifecycle-log — single greppable trace stream for the Dev
 * session-id chain.
 *
 * Every handoff in the spawn / resume / history flow emits one line
 * tagged `[dev::session-lifecycle]` with `key=value` fields. Grepping
 * a single run's output (browser console + tugcast log) for that tag
 * answers "which id won, and where?" for any session.
 *
 * Format mirrors the Rust side, which uses
 * `tracing::info!(target: "dev::session-lifecycle", ...)` so the same
 * grep surfaces both. Tugcode emits the same shape via its own copy of
 * this helper; tugcast forwards tugcode's stderr lines into its log,
 * so the three sources land in one stream.
 *
 * The browser's console is a live-only surface: a line written during
 * a cold restore is gone by the time anyone attaches an inspector, and
 * the release host forwards no console output to `tugcast.log`. Every
 * line is therefore also mirrored into the deck-trace ring, whose
 * `session-lifecycle` kind always records, so `__deckTrace.dump()`
 * answers for a running instance what the log answers for the other two
 * legs.
 *
 * No behavior change — pure observability.
 */

import { deckTrace } from "../deck-trace";

export function logSessionLifecycle(
  event: string,
  fields: Record<string, unknown>,
): void {
  const parts: string[] = [`event=${event}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${formatValue(v)}`);
  }
  console.log(`[dev::session-lifecycle] ${parts.join(" ")}`);
  // Shallow copy: the ring outlives the call, and the trace's contract
  // is that a record never retains something the caller can still move.
  deckTrace.record({ kind: "session-lifecycle", event, fields: { ...fields } });
}

function formatValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") {
    // Quote empty strings or anything containing whitespace/quotes so
    // a downstream key=value parser can recover the boundaries.
    if (v.length === 0 || /[\s"']/.test(v)) return JSON.stringify(v);
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}
