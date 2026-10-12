/**
 * `session-patch` — the deck's narrowing of the ingest patch protocol.
 *
 * `@tugproto/ingest` declares the protocol with the deck's own types as
 * parameters, because tugproto cannot import the deck. This module fills
 * them in once: a session's structure patch carries `CodeSessionState`
 * fields and `TurnEntry` splices, its meta carries the store's perf records,
 * and a local action carries a `CodeSessionEvent`. Everything on either side
 * of the channel speaks these names.
 *
 * {@link PATCH_APPLIERS} is the page's table of what each patch kind does,
 * keyed by every kind the protocol declares, so a kind added to the protocol
 * without an applier here fails to type-check. An applier routes its patch to
 * a {@link PatchTarget}: a page-wide patch to the page, a session patch to the
 * mirror its handle names — or nowhere, when that handle has no live mirror,
 * which is how a patch an engine posted before its session closed is dropped
 * rather than applied to the mirror rebuilt for the same session ([P06]).
 * {@link applySessionBatch} applies a whole batch that way and then tells each
 * mirror it touched that the batch is over, once, which is where a mirror
 * publishes: one notify per batch, however many patches it carried.
 *
 * It also holds the field-level diff both sides of a structure patch agree on
 * ([P05]): {@link diffStateFields} and {@link diffTranscript} on the engine's
 * side, {@link applyTranscriptSplices} on the mirror's.
 *
 * Types, the table and pure helpers only: this module is imported by the
 * Worker, so it must stay free of main-only singletons.
 */

import type {
  IngestBatch,
  IngestControl,
  IngestPatch,
  IngestPatchKind,
  IngestSessionMeta,
  IngestStructurePatch,
  TranscriptSplice,
} from "@tugproto/ingest";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import type { CodeSessionState } from "@/lib/code-session-store/reducer";
import type { TurnEntry } from "@/lib/code-session-store/types";
import type { LiveTurnPerf, ReplayIngestPerf } from "@/lib/code-session-store/session-engine";

/** The engine's perf records, as they cross the boundary. */
export type SessionPerfRecord = ReplayIngestPerf | LiveTurnPerf;

export type SessionPatch = IngestPatch<CodeSessionState, TurnEntry, SessionPerfRecord>;
export type SessionBatch = IngestBatch<CodeSessionState, TurnEntry, SessionPerfRecord>;
export type SessionControl = IngestControl<CodeSessionEvent>;
export type SessionStructurePatch = IngestStructurePatch<CodeSessionState, TurnEntry, SessionPerfRecord>;
export type SessionMeta = IngestSessionMeta<SessionPerfRecord>;
export type SessionTranscriptSplice = TranscriptSplice<TurnEntry>;

/** The patch of one kind. */
export type SessionPatchOf<K extends IngestPatchKind> = Extract<SessionPatch, { kind: K }>;

/** What the page does with its page-wide patches. */
export interface PagePatchTarget {
  frame(patch: SessionPatchOf<"frame">): void;
  wireState(patch: SessionPatchOf<"wire-state">): void;
  disconnectState(patch: SessionPatchOf<"disconnect-state">): void;
  log(patch: SessionPatchOf<"log">): void;
}

/** What a session's mirror does with the patches addressed to it. */
export interface SessionPatchTarget {
  stream(patch: SessionPatchOf<"stream">): void;
  structure(patch: SessionPatchOf<"structure">): void;
  progress(patch: SessionPatchOf<"progress">): void;
  effect(patch: SessionPatchOf<"effect">): void;
  ack(patch: SessionPatchOf<"ack">): void;
  /** A CODE_OUTPUT frame of a type a narrow per-session store folds ([P14]). */
  routedFrame(patch: SessionPatchOf<"routed-frame">): void;
  /** tugcast's renders, as the engine's states for each Message's `.rendered` path. */
  rendered(patch: SessionPatchOf<"rendered-blocks">): void;
  /** tugcast's answer to a find query this mirror sent. */
  findResult(patch: SessionPatchOf<"find-result">): void;
  /** The batch that carried this mirror's patches has been applied whole. */
  endOfBatch(): void;
}

/** Where a batch's patches go: the page, and the live mirror for a handle. */
export interface PatchTarget {
  readonly page: PagePatchTarget | null;
  session(handle: string): SessionPatchTarget | null;
}

/** What the page does with one patch of kind `K`. */
export type PatchApplier<K extends IngestPatchKind> = (patch: SessionPatchOf<K>, target: PatchTarget) => void;

/** Every patch kind's applier; exhaustive by construction. */
export type PatchApplierTable = { readonly [K in IngestPatchKind]: PatchApplier<K> };

export const PATCH_APPLIERS: PatchApplierTable = {
  frame: (patch, target) => target.page?.frame(patch),
  "wire-state": (patch, target) => target.page?.wireState(patch),
  "disconnect-state": (patch, target) => target.page?.disconnectState(patch),
  log: (patch, target) => target.page?.log(patch),
  stream: (patch, target) => target.session(patch.session)?.stream(patch),
  structure: (patch, target) => target.session(patch.session)?.structure(patch),
  progress: (patch, target) => target.session(patch.session)?.progress(patch),
  effect: (patch, target) => target.session(patch.session)?.effect(patch),
  "routed-frame": (patch, target) => target.session(patch.session)?.routedFrame(patch),
  ack: (patch, target) => target.session(patch.session)?.ack(patch),
  "rendered-blocks": (patch, target) => target.session(patch.session)?.rendered(patch),
  "find-result": (patch, target) => target.session(patch.session)?.findResult(patch),
};

/** Apply one patch through the table. */
export function applyPatch(patch: SessionPatch, target: PatchTarget): void {
  (PATCH_APPLIERS[patch.kind] as PatchApplier<IngestPatchKind>)(patch as never, target);
}

/**
 * Apply a batch's patches in order, then end the batch on every live mirror
 * a patch reached, each once, in the order they were first touched.
 */
export function applySessionBatch(entries: ReadonlyArray<SessionPatch>, target: PatchTarget): void {
  const touched = new Set<SessionPatchTarget>();
  try {
    for (const patch of entries) {
      applyPatch(patch, target);
      if (patch.session !== null) {
        const mirror = target.session(patch.session);
        if (mirror !== null) touched.add(mirror);
      }
    }
  } finally {
    for (const mirror of touched) mirror.endOfBatch();
  }
}

// ---------------------------------------------------------------------------
// Field-level diff ([P05])
// ---------------------------------------------------------------------------

/**
 * The top-level fields of `next` whose identity differs from `prev`'s, or
 * `null` when none did. A field present in `prev` and absent from `next` is
 * named with `undefined`, so the mirror's merge drops it too.
 */
export function diffStateFields<T extends object>(prev: T, next: T): Partial<T> | null {
  if (prev === next) return null;
  let diff: Partial<T> | null = null;
  const a = prev as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!Object.is(a[key], b[key])) (diff ??= {} as Partial<T>)[key as keyof T] = b[key] as T[keyof T];
  }
  for (const key of Object.keys(a)) {
    if (!(key in b) && a[key] !== undefined) (diff ??= {} as Partial<T>)[key as keyof T] = undefined;
  }
  return diff;
}

/**
 * The splices that turn `prev` into `next`, by identity: the common prefix
 * and suffix stay where they are and one splice replaces what lies between.
 * An append, a front-prepend, a mid-replace, a truncation and an eviction are
 * each one splice. An eviction is found first — `next` beginning partway
 * into `prev` — so the cap's steady state, one turn evicted as one is
 * appended, is two splices that leave every turn between untouched rather
 * than one that replaces the window. `null` when the two hold the same
 * entries.
 */
export function diffTranscript<E>(prev: ReadonlyArray<E>, next: ReadonlyArray<E>): TranscriptSplice<E>[] | null {
  if (prev === next) return null;
  const splices: TranscriptSplice<E>[] = [];
  let from = 0;
  if (prev.length > 0 && next.length > 0 && prev[0] !== next[0]) {
    const at = prev.indexOf(next[0]!);
    if (at > 0) {
      splices.push({ start: 0, deleteCount: at, entries: [] });
      from = at;
    }
  }
  const rest = prev.length - from;
  let head = 0;
  const shorter = Math.min(rest, next.length);
  while (head < shorter && prev[from + head] === next[head]) head += 1;
  let tail = 0;
  while (
    tail < shorter - head &&
    prev[prev.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail += 1;
  }
  const deleteCount = rest - head - tail;
  const entries = next.slice(head, next.length - tail);
  if (deleteCount > 0 || entries.length > 0) splices.push({ start: head, deleteCount, entries });
  return splices.length > 0 ? splices : null;
}

/**
 * Apply splices to the mirror's own transcript, copy-on-write. Every entry the
 * splices do not name keeps its identity; with no splices the array itself is
 * returned.
 */
export function applyTranscriptSplices<E>(
  transcript: ReadonlyArray<E>,
  splices: ReadonlyArray<TranscriptSplice<E>> | undefined,
): ReadonlyArray<E> {
  if (splices === undefined || splices.length === 0) return transcript;
  const next = [...transcript];
  for (const s of splices) next.splice(s.start, s.deleteCount, ...s.entries);
  return next;
}
