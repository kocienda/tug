/**
 * A session's dark calls — the long Bash calls that ran with no report —
 * read from tugcast's gaps record for the Session card's JOBS placard, so
 * the adoption loop `tugtool report gaps` drives is visible to the user and
 * not only to a model that remembers to ask.
 *
 * The record is tugcast's (`GET /api/report-gaps?session=<id>`), and a read
 * is taken each time the placard opens: the list changes at the end of a
 * long call, never while one is being looked at. A failed read keeps what
 * was shown. Reads enter React through `useSyncExternalStore` [L02].
 */

import { useEffect } from "react";

import { useSyncExternalStore } from "@/lib/gesture-scope";

/** One dark call, as the record holds it. */
export interface SessionGap {
  head: string;
  wallMs: number;
  endedAtMs: number;
}

const EMPTY: readonly SessionGap[] = Object.freeze([]);
const gapsBySession = new Map<string, readonly SessionGap[]>();
const listeners = new Set<() => void>();

/** The record's answer, narrowed: a row with a field of the wrong type is dropped. */
export function narrowSessionGaps(body: unknown): SessionGap[] {
  if (typeof body !== "object" || body === null) return [];
  const raw = (body as { gaps?: unknown }).gaps;
  if (!Array.isArray(raw)) return [];
  const out: SessionGap[] = [];
  for (const r of raw) {
    if (typeof r !== "object" || r === null) continue;
    const row = r as Record<string, unknown>;
    if (
      typeof row.head === "string" &&
      row.head.length > 0 &&
      typeof row.wallMs === "number" &&
      typeof row.endedAtMs === "number"
    ) {
      out.push({ head: row.head, wallMs: row.wallMs, endedAtMs: row.endedAtMs });
    }
  }
  return out;
}

/** Read `tugSessionId`'s dark calls from the record and publish them. */
export async function refreshSessionGaps(tugSessionId: string): Promise<void> {
  if (tugSessionId.length === 0) return;
  try {
    const response = await fetch(
      `/api/report-gaps?session=${encodeURIComponent(tugSessionId)}`,
    );
    if (!response.ok) return;
    gapsBySession.set(tugSessionId, narrowSessionGaps(await response.json()));
  } catch {
    return;
  }
  for (const cb of [...listeners]) cb();
}

/**
 * `tugSessionId`'s dark calls, newest first, read afresh whenever `open`
 * turns true — the placard opening.
 */
export function useSessionGaps(
  tugSessionId: string,
  open: boolean,
): readonly SessionGap[] {
  useEffect(() => {
    if (open) void refreshSessionGaps(tugSessionId);
  }, [tugSessionId, open]);
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => gapsBySession.get(tugSessionId) ?? EMPTY,
    () => EMPTY,
  );
}
