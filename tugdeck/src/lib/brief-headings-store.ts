/**
 * brief-headings-store.ts — the tagged headings of briefs on disk, read once
 * per ask and kept by path.
 *
 * The arc shade's Brief card lists a brief's findings and decisions when it
 * is open. The text comes through the deck's file reader (`file-io`), the
 * headings through `brief-headings`. A reading is asked for when a card opens
 * and is never re-asked on a timer; a card that opens again asks again, and
 * shows what it last had until the new reading lands.
 *
 * Laws: [L02] readings enter React through `useSyncExternalStore`.
 *
 * @module lib/brief-headings-store
 */

import { useEffect } from "react";

import { extractBriefHeadings, type BriefHeading } from "@/lib/brief-headings";
import { readFileFromDisk } from "@/lib/file-io";
import { useSyncExternalStore } from "@/lib/gesture-scope";

/** What is known of one brief's headings. */
export type BriefHeadingsReading =
  | { status: "loading" }
  | { status: "ready"; headings: readonly BriefHeading[] }
  | { status: "unreadable" };

const LOADING: BriefHeadingsReading = { status: "loading" };

const readings = new Map<string, BriefHeadingsReading>();
const listeners = new Set<() => void>();
/** The newest ask per path, so a slow earlier read cannot overwrite a later one. */
const asks = new Map<string, number>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** What is known of a brief's headings right now. */
export function briefHeadingsSnapshot(path: string): BriefHeadingsReading {
  return readings.get(path) ?? LOADING;
}

/** Read a brief from disk and keep its headings. */
export async function loadBriefHeadings(
  path: string,
  read: typeof readFileFromDisk = readFileFromDisk,
): Promise<void> {
  const ask = (asks.get(path) ?? 0) + 1;
  asks.set(path, ask);
  const outcome = await read(path);
  if (asks.get(path) !== ask) return;
  readings.set(
    path,
    outcome.ok
      ? { status: "ready", headings: extractBriefHeadings(outcome.file.content) }
      : { status: "unreadable" },
  );
  for (const listener of listeners) listener();
}

/** Forget every reading. For tests. */
export function resetBriefHeadingsForTest(): void {
  readings.clear();
  asks.clear();
}

/** A brief's headings, asked for when the caller mounts or its path changes. */
export function useBriefHeadings(path: string): BriefHeadingsReading {
  const reading = useSyncExternalStore(subscribe, () => briefHeadingsSnapshot(path));
  useEffect(() => {
    void loadBriefHeadings(path);
  }, [path]);
  return reading;
}
